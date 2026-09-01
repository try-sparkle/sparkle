import { describe, it, expect } from "vitest";

import { mayRetire, EVIDENCE_FRESHNESS_MS, type RetirementInputs } from "./retirementPredicate";
import { unlandedWorkEvidence } from "./workflowStage";
import type { BranchStatus, WorkflowState } from "../services/branchStatus";

const NOW = 1_700_000_000_000;

/**
 * A retirable agent: clean tree, nothing unlanded, quiet, reasoned.
 *
 * EVERY REFUSAL TEST BELOW STARTS FROM THIS AND BREAKS EXACTLY ONE THING, and is PAIRED with a case
 * proving this same setup does retire. That pairing is the point (bead sparkle-rvf6n, seen 6×): a
 * lone "it refused" assertion is satisfied just as well by an unrelated guard short-circuiting ahead
 * of the rung under test, and the mutation passes too, because mutating that rung cannot change an
 * outcome decided upstream of it.
 */
function retirable(over: Partial<RetirementInputs> = {}): RetirementInputs {
  return {
    kind: "build",
    worktreeRisk: "clean",
    unlanded: false,
    liveActivity: "quiet",
    reason: "Landed its work and has been idle with a met goal for an hour.",
    now: NOW,
    ...over,
  };
}

describe("mayRetire — the baseline is genuinely retirable", () => {
  it("allows a clean, landed, quiet build agent", () => {
    expect(mayRetire(retirable())).toEqual({ ok: true });
  });

  it("allows a worker on the same terms", () => {
    expect(mayRetire(retirable({ kind: "worker" }))).toEqual({ ok: true });
  });
});

describe("mayRetire — kind", () => {
  it("refuses a shell agent, which owns no worktree", () => {
    const v = mayRetire(retirable({ kind: "shell" }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("not-retirable-kind");
  });
});

describe("mayRetire — the tree", () => {
  it("refuses a dirty worktree", () => {
    const v = mayRetire(retirable({ worktreeRisk: "dirty" }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("uncommitted-work");
  });

  it("refuses an unreadable worktree WITHOUT claiming it holds changes", () => {
    const v = mayRetire(retirable({ worktreeRisk: "unknown" }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("status-unknown");
    // The false sentence bead sparkle-plxhx was filed over. An unreadable tree must never be
    // reported as a dirty one — the operator was looking at a clean checkout while the app insisted
    // changes existed, which is what made that deadlock undebuggable.
    expect(v.ok === false && v.message).toContain("NOT a report that it does");
  });

  it("PAIRED: the same agent retires once the tree reads clean", () => {
    expect(mayRetire(retirable({ worktreeRisk: "clean" }))).toEqual({ ok: true });
  });
});

describe("mayRetire — the branch", () => {
  it("refuses committed work that never reached main", () => {
    const v = mayRetire(retirable({ unlanded: true }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("unlanded-work");
  });

  it("refuses when nothing was read, rather than assuming nothing is unlanded", () => {
    const v = mayRetire(retirable({ unlanded: undefined }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("unlanded-unknown");
  });

  it("PAIRED: the same agent retires once the work is known landed", () => {
    expect(mayRetire(retirable({ unlanded: false }))).toEqual({ ok: true });
  });

  // ── THE REFUSAL MUST BE CHECKABLE (bead `sparkle-c68xl5`) ──────────────────────────────────────
  // Measured 2026-08-31: `retire_agent` refused with `unlanded-work` while the operator, standing in
  // the agent's worktree, read `git merge-base --is-ancestor <tip> origin/main` → YES and
  // `git log origin/main..<tip>` → EMPTY, and reported the refusal as a false positive. It was not
  // false. The worktree HEAD was a no-op branch parked on main; the reading had been taken on the
  // agent's OWN resolved branch, which held two unlanded commits — and still does. Both readings
  // were right about different branches, and the sentence named neither, so the disagreement was
  // unfalsifiable and cost the agent's slot until a human retired it by hand.
  //
  // So the refusal names the branch it counted. That is the same remedy `BranchStatus.branch`
  // exists for (sparkle-pgkbn4: "the row had no way to say what it counted"), applied to the one
  // surface that asks a human to go and check.
  it("NAMES the branch and the outstanding count it measured", () => {
    const v = mayRetire(
      retirable({ unlanded: true, measuredOn: { branch: "sparkle/agent-14ed66c0", ahead: 2 } }),
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("unlanded-work");
    const m = v.ok === false ? v.message : "";
    expect(m, "the refusal must name the branch it counted").toContain("sparkle/agent-14ed66c0");
    expect(m, "the refusal must say how many commits are outstanding").toContain("2 commit");
    // The whole point of naming it: a human re-running the check must be told the branch measured
    // is not necessarily the one checked out in the worktree, or they check HEAD and disagree.
    expect(m, "the refusal must warn the measured branch may not be the checked-out one").toContain(
      "worktree",
    );
  });

  it("names the branch WITHOUT a count when the count is not a positive reading", () => {
    const v = mayRetire(retirable({ unlanded: true, measuredOn: { branch: "feat/x", ahead: 0 } }));
    const m = v.ok === false ? v.message : "";
    expect(m).toContain("feat/x");
    // Never "0 commits": the branch is outstanding by reachability (a squash land leaves `ahead` at
    // a number that means nothing here), so a count that did not positively read must not be shown.
    expect(m).not.toContain("0 commit");
  });

  it("prints the CHECKABLE command when it knows the base it counted against", () => {
    const v = mayRetire(
      retirable({ unlanded: true, measuredOn: { branch: "sparkle/agent-x", ahead: 2, base: "main" } }),
    );
    const m = v.ok === false ? v.message : "";
    // A count is an assertion; a command is checkable. `git log main..sparkle/agent-x` must
    // reproduce the number the sentence quotes.
    expect(m, "the refusal must print the range it counted").toContain("main..sparkle/agent-x");
    expect(m).toContain("2 commits");
  });

  // ── ONE READING, ONE BRANCH (roborev 73884) ───────────────────────────────────────────────────
  // `WorkflowState.aheadOfBase` is folded across nested adopted worktrees (Rust takes the subtree
  // MAX), and that same fold is what clears `inOriginMain` and makes `unlanded` fire. Pairing it
  // with the agent's OWN branch name prints "1 commit on <branch>" for a branch that is 0 ahead —
  // the operator re-runs the check, gets an empty list, and concludes false positive again, now
  // with a named branch backing the wrong conclusion. The pin is at the call site
  // (`lifecycle.retire.test.ts`); this one pins the arm it depends on.
  it("never quotes a count that did not come with the branch it names", () => {
    const v = mayRetire(
      retirable({ unlanded: true, measuredOn: { branch: "sparkle/agent-x", ahead: 0, base: "main" } }),
    );
    const m = v.ok === false ? v.message : "";
    expect(m).toContain("sparkle/agent-x");
    expect(m, "a branch that read 0 ahead must not carry a commit count").not.toMatch(/\d+ commit/);
  });

  it("says NOTHING about a branch when the reading carries no name", () => {
    // `BranchStatus.branch` is optional so a Rust build predating it deserializes to `undefined`,
    // and that field's own doc requires rendering it as NOTHING — never a blank or guessed name.
    const bare = mayRetire(retirable({ unlanded: true }));
    const named = mayRetire(retirable({ unlanded: true, measuredOn: { branch: "", ahead: 3 } }));
    const bareMsg = bare.ok === false ? bare.message : "";
    const namedMsg = named.ok === false ? named.message : "";
    expect(namedMsg, "an empty branch name must not produce a clause").toBe(bareMsg);
    expect(bareMsg).not.toContain("“”");
  });
});

describe("mayRetire — the process", () => {
  it("refuses an agent that is producing output right now", () => {
    const v = mayRetire(retirable({ liveActivity: "working" }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("agent-busy");
  });

  it("refuses an unreadable live status, and NAMES THE REMEDY", () => {
    const v = mayRetire(retirable({ liveActivity: "unknown" }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("activity-unknown");
    // A refusal with no remedy is the permanent-deadlock shape of sparkle-plxhx. This arm is common
    // (a whole project reads `undefined` after a restart), so it has to be clearable by looking.
    expect(v.ok === false && v.message).toMatch(/read its terminal/i);
  });

  it("PAIRED: the same agent retires once it reads quiet", () => {
    expect(mayRetire(retirable({ liveActivity: "quiet" }))).toEqual({ ok: true });
  });
});

describe("mayRetire — the reason", () => {
  it("refuses a blank reason", () => {
    const v = mayRetire(retirable({ reason: "   " }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("reason-required");
  });

  it("is checked BEFORE any safety reading, so a blank reason cannot learn what it would have been allowed", () => {
    // Dirty AND blank: the reason refusal must win, or a caller with no justification gets a free
    // probe of the fleet's worktree state.
    const v = mayRetire(retirable({ reason: "", worktreeRisk: "dirty" }));
    expect(v.ok === false && v.refusal).toBe("reason-required");
  });
});

describe("mayRetire — a claim that the agent is dead", () => {
  const fresh = { evidence: "Claude usage limit reached.", observedAt: NOW - 1_000, source: "scrollback" };

  it("accepts a fresh live-scrollback excerpt", () => {
    expect(mayRetire(retirable({ deadClaim: fresh }))).toEqual({ ok: true });
  });

  it("refuses a snapshot tier, however fresh — it describes a moment that has passed", () => {
    const v = mayRetire(retirable({ deadClaim: { ...fresh, source: "attentionScreen" } }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("stale-evidence");
  });

  it("refuses an excerpt read outside the freshness window", () => {
    const v = mayRetire(
      retirable({ deadClaim: { ...fresh, observedAt: NOW - EVIDENCE_FRESHNESS_MS - 1 } }),
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("stale-evidence");
  });

  it("refuses a FUTURE-dated excerpt rather than reading it as very fresh", () => {
    const v = mayRetire(retirable({ deadClaim: { ...fresh, observedAt: NOW + 60_000 } }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("stale-evidence");
  });

  it("refuses a claim carrying no excerpt at all", () => {
    const v = mayRetire(retirable({ deadClaim: { ...fresh, evidence: "  " } }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("stale-evidence");
  });

  it("a claim of death UNLOCKS NOTHING — a dead agent with a dirty tree still refuses", () => {
    // The founder's rule: a quota reading never authorizes a close. Asserting an agent is dead must
    // not become a way past the rung that protects real files.
    const v = mayRetire(retirable({ deadClaim: fresh, worktreeRisk: "dirty" }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("uncommitted-work");
  });

  it("PAIRED: no claim at all is fine — evidence is owed only by the claim", () => {
    expect(mayRetire(retirable({ deadClaim: null }))).toEqual({ ok: true });
  });
});

// ── THE SQUASH-MERGE TRAP ─────────────────────────────────────────────────────────────────────────
// Composed against the REAL `unlandedWorkEvidence` rather than a hand-set boolean, because the defect
// this guards is precisely a caller deciding "unlanded" for itself from the ahead count. `ahead` is
// `rev-list --left-right --count`, so it only reaches 0 once the branch TIP is an ancestor of the
// base — a squash or rebase merge defeats that PERMANENTLY and the count stays N forever. A predicate
// keyed on the count would refuse to retire exactly the landed population this verb exists for.
describe("mayRetire — composed with the real unlanded evidence", () => {
  const bs = (over: Partial<BranchStatus> = {}): BranchStatus => ({
    ahead: 7,
    behind: 0,
    dirty: false,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    ...over,
  });

  it("retires a SQUASH-LANDED branch that still reads 7 ahead", () => {
    // ⚠️ `landedOnOrigin` IS EXPLICIT NOW, and that is a correction rather than a weakening. The case
    // this pins is a branch whose work reached ORIGIN main by squash. `landed: true` alone did not
    // say that: `branch_landed_scope`'s first arms answer `Local` too, so the fixture also described
    // a local-only landing — which is `merged_local`, a rung `hasUnmergedCommittedWork` calls
    // outstanding ON PURPOSE. The local-only direction has its own tests in `workflowStage.test.ts`.
    const ws = { landed: true, landedOnOrigin: true } as WorkflowState;
    const unlanded = unlandedWorkEvidence({ bs: bs(), ws, stageOverride: "merged" });
    expect(unlanded).toBe(false);
    expect(mayRetire(retirable({ unlanded }))).toEqual({ ok: true });
  });

  it("refuses an UNLANDED branch with the identical 7-ahead count", () => {
    const ws = { landed: false, inOriginMain: false, inLocalMain: false } as WorkflowState;
    const unlanded = unlandedWorkEvidence({ bs: bs(), ws, stageOverride: "building_saved" });
    expect(unlanded).toBe(true);
    const v = mayRetire(retirable({ unlanded }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal).toBe("unlanded-work");
  });
});
