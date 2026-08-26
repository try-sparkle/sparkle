import { describe, it, expect } from "vitest";
import {
  shouldPromptOnClose,
  closeDecision,
  selectionAfterClose,
  worktreeRiskOf,
  type CloseSelectionAgent,
} from "./closeAgent";
import type { BranchStatus } from "../services/branchStatus";
import type { AgentKind } from "../types";

const bs = (ahead: number, dirty = false): BranchStatus => ({
  ahead,
  behind: 0,
  dirty,
  filesChanged: dirty ? 1 : 0,
  insertions: 0,
  deletions: 0,
  // A CONFIRMED provenance: these numbers were measured on a real branch. `closeDecision` only
  // trusts a zero-ahead/clean reading enough to tear down silently when it knows which branch the
  // reading counted against (sparkle-cn9z9l) — so the default helper carries one, and the tests
  // that exercise the MISSING-provenance case drop it explicitly below.
  branch: "sparkle/agent-fixture",
});

describe("shouldPromptOnClose", () => {
  it("prompts for a build agent with committed-but-unmerged work", () => {
    expect(shouldPromptOnClose("build", "building_saved", bs(2))).toBe(true);
  });
  it("prompts for a build agent with only uncommitted (dirty) changes", () => {
    expect(shouldPromptOnClose("build", "building_unsaved", bs(0, true))).toBe(true);
  });
  it("does NOT raise the WORK-AT-RISK choice once the work has merged", () => {
    // Still false, and the reason is unchanged: landed work cannot be lost by closing the row, so
    // there is no Ship/Save/Discard decision to make. What changed is what `false` MEANS. It used
    // to be the whole close policy — the sidebar read it as "tear down silently" — and a merged
    // agent therefore vanished with no prompt at all. Now it is one projection of `closeDecision`,
    // which returns `retirement-confirm` for exactly these rows. See the describe block below;
    // reading a `false` here as permission to tear down is the bug this bead fixed.
    expect(shouldPromptOnClose("build", "merged", bs(2))).toBe(false);
    expect(shouldPromptOnClose("build", "shipped", bs(2))).toBe(false);
  });
  it("does NOT prompt for a build agent with a KNOWN-clean tree (polled, no work)", () => {
    expect(shouldPromptOnClose("build", "building_unsaved", bs(0, false))).toBe(false);
  });
  it("prompts when the worktree is PARKED off its branch — the files are still there (sparkle-xk3x)", () => {
    // Parking (the old land.sh checking `main` into an agent worktree) CARRIES uncommitted files
    // along. They are still on disk and still the user's, so deleting the worktree destroys them.
    // This is the same fail-safe posture as the unpolled case below: a tree we cannot attribute is
    // work we cannot rule out. The sibling gate in runtimeStore goes the OTHER way on purpose —
    // it must not credit this dirt as the agent's work — and conflating the two loses data here.
    expect(
      shouldPromptOnClose("build", "building_unsaved", { ...bs(0, true), worktreeOnBranch: false }),
    ).toBe(true);
    // Even with a clean-looking tree: false means "not this branch's tree", never "no work".
    expect(
      shouldPromptOnClose("build", "building_unsaved", { ...bs(0, false), worktreeOnBranch: false }),
    ).toBe(true);
    // On its own branch, a known-clean tree still closes silently — the gate must not over-prompt.
    expect(
      shouldPromptOnClose("build", "building_unsaved", { ...bs(0, false), worktreeOnBranch: true }),
    ).toBe(false);
  });
  it("prompts when branch status is unknown (unpolled) — err toward the choice, never silent loss", () => {
    expect(shouldPromptOnClose("build", "building_unsaved", undefined)).toBe(true);
    // …but a merged build agent with unknown status raises no WORK-AT-RISK choice: nothing it holds
    // can be lost. It is not closed silently either — `closeDecision` sends it to the retirement
    // confirm. This projection just isn't the thing that says so.
    expect(shouldPromptOnClose("build", "merged", undefined)).toBe(false);
    // …and a non-build agent never prompts regardless.
    expect(shouldPromptOnClose("worker", "building_unsaved", undefined)).toBe(false);
  });
  it("does NOT prompt for workers (own merged nudge) or think/shell (no worktree)", () => {
    expect(shouldPromptOnClose("worker", "building_saved", bs(2))).toBe(false);
    expect(shouldPromptOnClose("shell", "building_saved", bs(2))).toBe(false);
  });
});

describe("selectionAfterClose", () => {
  const ag = (
    id: string,
    kind: AgentKind,
    parentId: string | null = null,
  ): CloseSelectionAgent => ({ id, kind, parentId });
  const before = [ag("b1", "build"), ag("b2", "build")];

  it("closing the OPEN build agent re-selects the first visible row", () => {
    const after = [ag("b2", "build")]; // b1 removed
    const d = selectionAfterClose("b1", "b1", before, after, "build");
    expect(d).toEqual({ reselect: true, next: "b2" });
  });

  it("closing the LAST build agent clears selection → blank first-load state", () => {
    const d = selectionAfterClose("b1", "b1", [ag("b1", "build")], [], "build");
    expect(d).toEqual({ reselect: true, next: null });
  });

  it("closing a NON-open row leaves selection put", () => {
    const after = [ag("b1", "build")]; // closed b2, but b1 is open
    const d = selectionAfterClose("b2", "b1", before, after, "build");
    expect(d).toEqual({ reselect: false, next: "b1" });
  });

  it("treats closing the open agent's WORKER-parent as closing the open agent", () => {
    // The open selection is a worker whose parent build agent is being torn down (workers go with
    // it), so selection is invalidated and must move to the first visible row.
    const withWorker = [ag("b1", "build"), ag("w1", "worker", "b1"), ag("b2", "build")];
    const after = [ag("b2", "build")]; // b1 + its worker w1 removed
    const d = selectionAfterClose("b1", "w1", withWorker, after, "build");
    expect(d).toEqual({ reselect: true, next: "b2" });
  });

  it("does nothing when nothing is selected", () => {
    const after = [ag("b2", "build")];
    const d = selectionAfterClose("b1", null, before, after, "build");
    expect(d).toEqual({ reselect: false, next: null });
  });
});

describe("selectionAfterClose — the caller's preferred next row", () => {
  const ag = (id: string, kind: AgentKind, parentId: string | null = null): CloseSelectionAgent => ({
    id,
    kind,
    parentId,
  });

  it("honors a preferred row supplied by the sidebar over plain array order", () => {
    // The sidebar knows the rendered ladder AND the active status filter; array order does not.
    // Selecting the array-first agent when the user has filtered it out of sight would leave the
    // main pane showing an agent with no row in the column.
    const before = [ag("hidden", "build"), ag("visible", "build")];
    const after = [ag("hidden", "build"), ag("visible", "build")];
    const d = selectionAfterClose("gone", "gone", [...before, ag("gone", "build")], after, "build", "visible");
    expect(d).toEqual({ reselect: true, next: "visible" });
  });

  it("falls back to array order when the preferred row did NOT survive the close", () => {
    // A stale preference must never select a torn-down agent.
    const after = [ag("b2", "build")];
    const d = selectionAfterClose("b1", "b1", [ag("b1", "build"), ag("b2", "build")], after, "build", "b1");
    expect(d).toEqual({ reselect: true, next: "b2" });
  });

  it("falls back to array order when no preference is given", () => {
    const after = [ag("b2", "build")];
    const d = selectionAfterClose("b1", "b1", [ag("b1", "build"), ag("b2", "build")], after, "build");
    expect(d).toEqual({ reselect: true, next: "b2" });
  });

  it("clears selection when the ladder is empty even though a preference was passed", () => {
    const d = selectionAfterClose("b1", "b1", [ag("b1", "build")], [], "build", null);
    expect(d).toEqual({ reselect: true, next: null });
  });
});

describe("closeDecision — the retirement arm (bead sparkle-0l9xk)", () => {
  const SETTLED = { settled: true } as const;
  const UNSETTLED = { settled: false } as const;

  it("asks for a HUMAN CONFIRM on a landed build agent instead of tearing it down", () => {
    // THE REGRESSION PROOF. Against the pre-change code this whole block was `false`/silent, and
    // the founder's merged-and-shipped rows disappeared on a single click with no prompt, no retro
    // check, and no way to get the row back. His instruction was explicit: "the build agent
    // shouldn't be removed from the build list until I, as the human, confirm that."
    expect(closeDecision("build", "merged", bs(0), UNSETTLED)).toBe("retirement-confirm");
    expect(closeDecision("build", "shipped", bs(0), UNSETTLED)).toBe("retirement-confirm");
    // THE BOUNDARY IS `merged_local`, NOT `merged` (knightwatch 5204094441#3). It used to be
    // `merged`, and the second line below used to assert `silent` — which is precisely the hole:
    // a no-remote "Ship it" merges into LOCAL main and stops, so the landed row reads as a clean
    // tree 0 ahead. The ship handler opened the dialog once from its own fresher `outcome.landed`;
    // dismiss it, click × again, and this function answered `silent` and removed the row with no
    // confirm at all. Both lines FAIL against the pre-change code.
    expect(closeDecision("build", "merged_local", bs(0), UNSETTLED)).toBe("retirement-confirm");
    expect(closeDecision("build", "merged_local", bs(2), UNSETTLED)).toBe("retirement-confirm");
    // …and the stage BELOW it is untouched: nothing has landed there, so the old rules stand.
    expect(closeDecision("build", "pull_request", bs(2), UNSETTLED)).toBe("work-at-risk-prompt");
    expect(closeDecision("build", "pull_request", bs(0), UNSETTLED)).toBe("silent");
  });

  it("still asks even when the retro IS settled — the confirm is his, not the receipt's", () => {
    // The receipt decides what the dialog SAYS (a recommendation rather than a request), never
    // whether to ask. Letting a settled retro close silently would satisfy the retro half of the
    // ask and quietly drop the half he stated in his own words.
    expect(closeDecision("build", "merged", bs(0), SETTLED)).toBe("retirement-confirm");
    expect(closeDecision("build", "shipped", bs(0), SETTLED)).toBe("retirement-confirm");
  });

  it("lets WORK AT RISK win over the retirement confirm — BELOW merged", () => {
    // Below `merged` with a dirty tree, losing uncommitted changes is unrecoverable and an
    // unconfirmed removal is not — so the Ship/Save/Discard choice is the more urgent thing to say.
    expect(closeDecision("build", "building_unsaved", bs(0, true), SETTLED)).toBe("work-at-risk-prompt");
    expect(closeDecision("build", "building_saved", bs(3), SETTLED)).toBe("work-at-risk-prompt");
  });

  it("does NOT let work at risk win once the work has LANDED — pinned, and it has a cost", () => {
    // roborev 58742 read the doc block's old "work-at-risk is checked FIRST" and found the code
    // does the opposite above `merged`. The ordering is deliberate — the founder's confirm is
    // unconditional, and Ship/Save/Discard would tear the row down with no retro confirm at all —
    // but it was UNTESTED IN EITHER DIRECTION, so nothing pinned which way it actually went.
    //
    // These are the real states: a merged row with uncommitted files, one with unpushed follow-up
    // commits, one on a parked worktree, and one whose branch status has not polled yet.
    expect(closeDecision("build", "merged", bs(0, true), UNSETTLED)).toBe("retirement-confirm");
    expect(closeDecision("build", "merged", bs(3), SETTLED)).toBe("retirement-confirm");
    expect(closeDecision("build", "shipped", bs(3, true), SETTLED)).toBe("retirement-confirm");
    expect(
      closeDecision("build", "merged", { ...bs(0, true), worktreeOnBranch: false }, UNSETTLED),
    ).toBe("retirement-confirm");
    expect(closeDecision("build", "merged", undefined, UNSETTLED)).toBe("retirement-confirm");
    // The cost, stated so it cannot be mistaken for a solved problem: none of the above reaches a
    // dialog that mentions the uncommitted files, and confirming removal destroys them. The remedy
    // is in `RetireAgentConfirm`, not in this ordering — bead sparkle-jcux2.
  });

  it("leaves every non-build kind exactly as it was — silent", () => {
    // Workers report to an orchestrator and shells have no branch; neither occupies a row he
    // retires. Regressing these into a confirm would put a dialog in front of every worker teardown
    // and the 60s orphan reaper.
    for (const kind of ["worker", "shell", "think"]) {
      expect(closeDecision(kind, "shipped", bs(3, true), UNSETTLED)).toBe("silent");
      expect(closeDecision(kind, "building_unsaved", bs(3, true), UNSETTLED)).toBe("silent");
    }
  });

  it("tears down silently only when nothing is at risk AND nothing has landed", () => {
    expect(closeDecision("build", "building_unsaved", bs(0, false), UNSETTLED)).toBe("silent");
    expect(closeDecision("build", "planned", bs(0, false), UNSETTLED)).toBe("silent");
  });

  it("keeps the unpolled and parked-worktree cases on the work-at-risk side", () => {
    expect(closeDecision("build", "building_unsaved", undefined, SETTLED)).toBe("work-at-risk-prompt");
    expect(
      closeDecision("build", "building_unsaved", { ...bs(0, false), worktreeOnBranch: false }, SETTLED),
    ).toBe("work-at-risk-prompt");
  });

  // ── sparkle-cn9z9l: a zero-ahead reading with NO branch provenance is not a safe teardown ────────
  // THE REGRESSION PROOF. The would-be-silent path is `ahead === 0`, clean tree, on-branch — but
  // `ahead` is only trustworthy if we know which branch it counted against. The roster used to report
  // the branch minted at SPAWN, so a worker a commit ahead on its real branch read `ahead: 0` and was
  // torn down over the commit. `bs.branch` now records the measured branch; when it is MISSING the
  // zero is unconfirmed and must refuse. Against the pre-change code every assertion here read
  // "silent" (the old final line trusted `ahead === 0` unconditionally); the paired confirmed-branch
  // cases stay "silent" to prove the refusal is caused by the missing provenance and nothing else.
  it("refuses a silent teardown when the reading cannot say which branch it measured", () => {
    const clean = bs(0, false); // ahead 0, not dirty, worktreeOnBranch not set (i.e. not false)
    // Branch provenance ABSENT → cannot confirm the zero → refuse.
    expect(
      closeDecision("build", "building_unsaved", { ...clean, branch: undefined }, UNSETTLED),
    ).toBe("work-at-risk-prompt");
    // Branch provenance BLANK (whitespace/empty from an odd resolve) → still unconfirmed → refuse.
    expect(
      closeDecision("build", "building_unsaved", { ...clean, branch: "" }, UNSETTLED),
    ).toBe("work-at-risk-prompt");
    expect(
      closeDecision("build", "planned", { ...clean, branch: "   " }, UNSETTLED),
    ).toBe("work-at-risk-prompt");
    // PAIRED positive control: the identical reading WITH a confirmed branch still closes silently,
    // so the refusal above is attributable to the missing provenance and not to some other gate.
    expect(
      closeDecision("build", "building_unsaved", { ...clean, branch: "sparkle/agent-real" }, UNSETTLED),
    ).toBe("silent");
    expect(
      closeDecision("build", "planned", { ...clean, branch: "pr1380" }, UNSETTLED),
    ).toBe("silent");
  });
});

describe("shouldPromptOnClose stays a faithful projection of closeDecision", () => {
  it("is true exactly when closeDecision says work-at-risk-prompt", () => {
    // Pins the two together so a future edit to one cannot silently diverge from the other — the
    // exact drift that let the sidebar and the concierge disagree about closing in the first place.
    const kinds = ["build", "worker", "shell"];
    const stages = ["planned", "building_unsaved", "building_saved", "merged_local", "merged", "shipped"] as const;
    const statuses = [undefined, bs(0), bs(0, true), bs(3), { ...bs(0), worktreeOnBranch: false }];
    for (const k of kinds) {
      for (const st of stages) {
        for (const b of statuses) {
          expect(shouldPromptOnClose(k, st, b)).toBe(
            closeDecision(k, st, b, { settled: false }) === "work-at-risk-prompt",
          );
        }
      }
    }
  });
});

// ══ THE RETIREMENT DEADLOCK RULE (bead sparkle-plxhx) ═════════════════════════════════════════════
// `worktreeRiskOf` is the shared answer to "what would tearing this checkout down destroy?", split
// three ways so that "we could not tell" stops being reported as "there is uncommitted work".
//
// NOTE the deliberate asymmetry with `closeDecision` above, which still PROMPTS on a parked tree.
// They ask different questions: the prompt asks "should a human look at this row?", where a parked
// tree is a legitimate caveat; this asks "are there files here that deletion would destroy?", which
// an empty directory answers on its own regardless of which branch is checked out into it.
describe("worktreeRiskOf", () => {
  it("reports a positively dirty tree as dirty — the guard that must survive", () => {
    expect(worktreeRiskOf(bs(0, true))).toBe("dirty");
  });

  // The case the parked gate was written for, and it is unchanged: parking CARRIES uncommitted
  // files along, so they are real and the teardown destroys them.
  it("reports a dirty PARKED tree as dirty", () => {
    expect(worktreeRiskOf({ ...bs(0, true), worktreeOnBranch: false })).toBe("dirty");
  });

  // ── The bug. Six of the seven deadlocked workers were exactly this shape.
  it("reports a clean PARKED tree as clean, not as dirt", () => {
    expect(worktreeRiskOf({ ...bs(0), worktreeOnBranch: false })).toBe("clean");
  });

  it("reports a clean tree on its own branch as clean", () => {
    expect(worktreeRiskOf(bs(0))).toBe("clean");
  });

  // Committed work survives on the branch a teardown keeps, so `ahead` says nothing about risk here.
  it("ignores commits ahead — those survive on the branch", () => {
    expect(worktreeRiskOf(bs(5))).toBe("clean");
    expect(worktreeRiskOf({ ...bs(5), worktreeOnBranch: false })).toBe("clean");
  });

  // ── The honesty requirement. No reading is its own answer, never dirt.
  it("reports an absent reading as unknown rather than as uncommitted work", () => {
    expect(worktreeRiskOf(undefined)).toBe("unknown");
  });

  // `worktreeOnBranch` is optional (a Rust build predating the field deserializes it undefined) and
  // must not tip a clean tree into either non-clean answer.
  it("treats an undefined worktreeOnBranch as the ordinary case", () => {
    expect(worktreeRiskOf({ ...bs(0), worktreeOnBranch: undefined })).toBe("clean");
    expect(worktreeRiskOf({ ...bs(0, true), worktreeOnBranch: undefined })).toBe("dirty");
  });
});
