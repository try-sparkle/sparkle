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
