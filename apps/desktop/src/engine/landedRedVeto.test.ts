// The landed-work red veto, driven BOTH DIRECTIONS on every status the token table paints red.
//
// The half that has been missed before in this repo is the GATE, not the demotion. A suite that
// only proves "landed evidence turns red into done" proves nothing about whether the veto can also
// fire on a row that has NOT landed — and a veto that fires on ignorance hides rows that really do
// need the founder, which is strictly worse than the false red it was written to remove. So every
// headline case below has an absent-evidence twin and a positively-not-landed twin, asserted on the
// same row, and both of those must return `undefined`.
//
// NOTHING HERE HAND-LISTS THE RED STATUSES. The set is derived from `AGENT_STATUS`'s red hex — the
// same definition `services/windowStatus.isRedStatus` uses — so a red status added to tokens.ts
// later is covered by these loops automatically. A hand-written membership list is the exact shape
// that has already bitten this repo: a roborev round found a fixture whose comment promised
// "closing the gap OR widening it reds the suite" while the widening direction reded nothing.
//
// ⚠️ A DERIVED SET CAN BE DERIVED EMPTY, and an empty set makes every `for` loop below pass
// VACUOUSLY. The first test therefore asserts the derivation actually produced the four statuses
// that are red today, before anything iterates it.
import { describe, expect, it } from "vitest";
import { AGENT_STATUS, type AgentTabStatus } from "@sparkle/ui";
import { isDemonstratedAsk } from "./newAgentAttention";

import {
  LANDED_PAINT,
  boundRepoLanding,
  crossRepoLanding,
  landedRedVetoFor,
  landingProven,
  landedEvidenceFor,
  stageLanding,
  withLandedRedVeto,
  type LandedEvidence,
} from "./landedRedVeto";
import type { LandedElsewhere } from "./crossRepo";
import type { WorkflowState } from "../services/branchStatus";

/** THE DEFINITION OF RED, read off the token table exactly as `isRedStatus` reads it — deliberately
 *  derived here rather than imported from the module under test, so this suite is not checking the
 *  implementation against itself. */
const RED_HEX = AGENT_STATUS.errored.color;
const ALL_STATUSES = Object.keys(AGENT_STATUS) as AgentTabStatus[];
const RED_STATUSES = ALL_STATUSES.filter((s) => AGENT_STATUS[s].color === RED_HEX);
/**
 * THE RED STATUSES THIS VETO MAY ACTUALLY DEMOTE — the red set MINUS the demonstrated asks.
 *
 * Derived by asking the same predicate the module asks, never hand-listed, so the two cannot drift:
 * a status moving into or out of `DEMONSTRATED_ASK` re-partitions this file automatically. See
 * `VETOABLE_RED` / `DEMONSTRATED_RED` non-emptiness below, which is what stops a broken derivation
 * from turning every `it.each` here into a silent zero-case pass.
 */
const VETOABLE_RED = RED_STATUSES.filter((s) => !isDemonstratedAsk(s));
/** The other half: a prompt is on screen, and no landing discharges it. */
const DEMONSTRATED_RED = RED_STATUSES.filter((s) => isDemonstratedAsk(s));
const NON_RED_STATUSES = ALL_STATUSES.filter((s) => AGENT_STATUS[s].color !== RED_HEX);

/** Landing proven by the bound repo alone. */
const BOUND_LANDED: LandedEvidence = { boundRepo: "landed" };
/** Landing proven by the cross-repo stamp alone, with the bound-repo probe NOT OBSERVED — the shape
 *  `set_agent_landed` exists for, since no bound-repo probe can see a PR in another repository. */
const CROSS_LANDED: LandedEvidence = { crossRepo: "landed" };
/** Both signals positively read, and both say NO. Not the same fact as absent evidence, and this
 *  suite asserts them separately for exactly that reason. */
const POSITIVELY_NOT_LANDED: LandedEvidence = { boundRepo: "not-landed", crossRepo: "not-landed" };
/** Both signals present but NOT OBSERVED — "we looked and could not tell", spelled out. */
const NOT_OBSERVED: LandedEvidence = { boundRepo: "unknown", crossRepo: "unknown" };

function workflowState(over: Partial<WorkflowState> = {}): WorkflowState {
  return {
    inLocalMain: false,
    inOriginMain: false,
    inParent: false,
    aheadOfBase: 3,
    prState: null,
    prNumber: null,
    prUrl: null,
    ...over,
  };
}

function stamp(over: Partial<LandedElsewhere> = {}): LandedElsewhere {
  return { repo: "drodio/drodio-website", stampedAt: 1_700_000_000_000, ...over };
}

describe("the red set this veto covers", () => {
  it("derives from the token table's red hex and is not empty", () => {
    // ANTI-VACUITY. Every loop in this file iterates RED_STATUSES; if the derivation were broken and
    // produced `[]`, all of them would pass having asserted nothing at all.
    expect(RED_STATUSES.length).toBeGreaterThanOrEqual(4);
    // The four that are red TODAY. Asserted by containment rather than equality on purpose: a red
    // status added to tokens.ts later must be picked up by these loops automatically, which is the
    // whole point of deriving the set — an equality assertion would turn that into a test failure
    // and invite someone to hand-list the four again.
    for (const s of ["waiting", "approval", "blocked", "errored"] as const) {
      expect(RED_STATUSES).toContain(s);
    }
  });

  it("paints with a status that is NOT itself red", () => {
    // Otherwise the whole veto is a no-op that swaps one alarm for another. `done` is gray, and its
    // token says the exact claim proven landing licenses: "finished cleanly AND landed".
    expect(AGENT_STATUS[LANDED_PAINT].color).not.toBe(RED_HEX);
    expect(LANDED_PAINT).toBe("done");
  });
});

describe("landedRedVetoFor — the headline, on every red status a landing CAN discharge", () => {
  it.each(VETOABLE_RED)("%s + bound-repo landing proven → done", (status) => {
    expect(landedRedVetoFor(status, BOUND_LANDED)).toBe("done");
  });

  it.each(VETOABLE_RED)("%s + a cross-repo stamp ALONE → done", (status) => {
    // `set_agent_landed` is sufficient on its own. That op exists precisely because the bound-repo
    // probe is structurally blind to a PR in another repository, so requiring corroboration from it
    // would make the stamp useless for every row it was written for.
    expect(landedRedVetoFor(status, CROSS_LANDED)).toBe("done");
  });
});

describe("landedRedVetoFor — the GATE, which is the half that matters", () => {
  it.each(RED_STATUSES)("%s + NO evidence at all → undefined (stays red)", (status) => {
    expect(landedRedVetoFor(status, undefined)).toBeUndefined();
  });

  it.each(RED_STATUSES)("%s + an EMPTY evidence object → undefined (stays red)", (status) => {
    // An object with no fields set is the shape a caller produces when every probe came back
    // unobserved. It must read identically to no evidence at all.
    expect(landedRedVetoFor(status, {})).toBeUndefined();
  });

  it.each(RED_STATUSES)("%s + evidence positively saying NOT landed → undefined (stays red)", (status) => {
    expect(landedRedVetoFor(status, POSITIVELY_NOT_LANDED)).toBeUndefined();
  });

  it.each(RED_STATUSES)("%s + evidence explicitly NOT OBSERVED → undefined (stays red)", (status) => {
    expect(landedRedVetoFor(status, NOT_OBSERVED)).toBeUndefined();
  });

  it.each(VETOABLE_RED)("%s + one signal landed, the other saying not-landed → done", (status) => {
    // ANY, not ALL. The two signals answer the same question about DIFFERENT PLACES, so a foreign
    // repo that merged is not contradicted by a bound branch that did not.
    expect(landedRedVetoFor(status, { boundRepo: "not-landed", crossRepo: "landed" })).toBe("done");
    expect(landedRedVetoFor(status, { boundRepo: "landed", crossRepo: "not-landed" })).toBe("done");
  });
});

describe("landedRedVetoFor — rows that are none of this module's business", () => {
  it.each(NON_RED_STATUSES)("%s is never repainted, even with landing proven", (status) => {
    expect(landedRedVetoFor(status, BOUND_LANDED)).toBeUndefined();
    expect(landedRedVetoFor(status, CROSS_LANDED)).toBeUndefined();
  });

  it("leaves an already-calm landed row exactly as it is", () => {
    // Named explicitly as well as covered by the loop above, because `done` and `idle` are the two a
    // reader will actually wonder about: repainting a calm row is a different decision made by a
    // different surface, and this module must not make it.
    expect(landedRedVetoFor("done", BOUND_LANDED)).toBeUndefined();
    expect(landedRedVetoFor("idle", BOUND_LANDED)).toBeUndefined();
    expect(landedRedVetoFor("unmerged", BOUND_LANDED)).toBeUndefined();
    expect(landedRedVetoFor("lapsed", BOUND_LANDED)).toBeUndefined();
  });

  it("leaves an unknown status alone", () => {
    expect(landedRedVetoFor(undefined, BOUND_LANDED)).toBeUndefined();
    expect(landedRedVetoFor(undefined, undefined)).toBeUndefined();
  });
});

describe("landingProven", () => {
  it("is false for absent, empty, unobserved and negative evidence", () => {
    expect(landingProven(undefined)).toBe(false);
    expect(landingProven({})).toBe(false);
    expect(landingProven(NOT_OBSERVED)).toBe(false);
    expect(landingProven(POSITIVELY_NOT_LANDED)).toBe(false);
  });

  it("is true when any single field proves landing", () => {
    expect(landingProven(BOUND_LANDED)).toBe(true);
    expect(landingProven(CROSS_LANDED)).toBe(true);
  });
});

describe("boundRepoLanding", () => {
  it("is unknown when nothing was polled — never a positive 'not landed'", () => {
    // The `resolveStage` trap, stated on the function: a floored stage would manufacture a positive
    // negative for a row nobody looked at.
    expect(boundRepoLanding(undefined)).toBe("unknown");
  });

  it("reads a merged PR as landed", () => {
    expect(boundRepoLanding(workflowState({ prState: "merged" }))).toBe("landed");
  });

  it("reads plain ancestry in origin main as landed", () => {
    expect(boundRepoLanding(workflowState({ inOriginMain: true }))).toBe("landed");
  });

  it("reads a squash/rebase landing (landedOnOrigin, tip an ancestor of nothing) as landed", () => {
    expect(boundRepoLanding(workflowState({ landedOnOrigin: true }))).toBe("landed");
  });

  it("reads shipped as landed", () => {
    expect(boundRepoLanding(workflowState({ shipped: true }))).toBe("landed");
  });

  it("reads a polled branch that is on LOCAL main only as NOT landed", () => {
    // `hasUnmergedCommittedWork`'s rule: "main" is ORIGIN main, and local-only work still needs the
    // founder to get it the rest of the way — so this row must stay red.
    expect(boundRepoLanding(workflowState({ inLocalMain: true }))).toBe("not-landed");
  });

  it("reads an open PR on a polled branch as NOT landed", () => {
    expect(boundRepoLanding(workflowState({ prState: "open" }))).toBe("not-landed");
    expect(boundRepoLanding(workflowState({ prState: "closed" }))).toBe("not-landed");
  });

  it("reads an ordinary polled branch with no landing signal as NOT landed", () => {
    expect(boundRepoLanding(workflowState())).toBe("not-landed");
  });
});

describe("crossRepoLanding", () => {
  it("is unknown when the agent stamped nothing", () => {
    expect(crossRepoLanding(undefined)).toBe("unknown");
  });

  it("reads a merged stamp as landed", () => {
    expect(crossRepoLanding(stamp({ state: "merged", prNumber: 253 }))).toBe("landed");
  });

  it("reads a shipped stamp as landed", () => {
    expect(crossRepoLanding(stamp({ state: "merged", shipped: true }))).toBe("landed");
  });

  it("reads a STATELESS stamp as unknown, not as a denial", () => {
    // `stageFromLandedStamp` floors a bare `{ repo }` stamp at `pushed`: it establishes that the
    // work reached a remote repository and NOTHING MORE. Reading that silence as "not landed" would
    // be inventing a status just as much as reading it as "merged" would.
    expect(crossRepoLanding(stamp())).toBe("unknown");
    expect(crossRepoLanding(stamp({ url: "https://github.com/drodio/drodio-website/pull/253" }))).toBe("unknown");
  });

  it("reads a stated open or closed PR as NOT landed", () => {
    expect(crossRepoLanding(stamp({ state: "open" }))).toBe("not-landed");
    expect(crossRepoLanding(stamp({ state: "closed" }))).toBe("not-landed");
  });
});

describe("end to end, through the derivation helpers", () => {
  // The founder's actual complaint: a row wearing the loudest signal the app has whose PR already
  // read MERGED. Driven from the real poll/stamp shapes rather than from a hand-written reading, so
  // the helpers and the veto are proven to fit together.
  it.each(VETOABLE_RED)("%s whose bound-repo PR merged paints done", (status) => {
    const evidence: LandedEvidence = { boundRepo: boundRepoLanding(workflowState({ prState: "merged" })) };
    expect(landedRedVetoFor(status, evidence)).toBe("done");
  });

  it.each(VETOABLE_RED)("%s whose work merged in ANOTHER repo paints done", (status) => {
    // The bound-repo probe honestly reports "not landed" here — the branch really is empty — and the
    // stamp is the only thing that knows better. This is the row `crossRepo` was written for.
    const evidence: LandedEvidence = {
      boundRepo: boundRepoLanding(workflowState({ aheadOfBase: 0 })),
      crossRepo: crossRepoLanding(stamp({ state: "merged", prNumber: 253, sha: "79b157a" })),
    };
    expect(landedRedVetoFor(status, evidence)).toBe("done");
  });

  it.each(DEMONSTRATED_RED)(
    "%s stays red through the REAL merged-PR shape — the narrowing holds end to end, not just against a hand-written reading",
    (status) => {
      const evidence: LandedEvidence = {
        boundRepo: boundRepoLanding(workflowState({ prState: "merged" })),
        crossRepo: crossRepoLanding(stamp({ state: "merged", prNumber: 253, sha: "79b157a" })),
      };
      expect(landedRedVetoFor(status, evidence)).toBeUndefined();
    },
  );

  it.each(RED_STATUSES)("%s with an unpolled bound repo and no stamp stays red", (status) => {
    const evidence: LandedEvidence = {
      boundRepo: boundRepoLanding(undefined),
      crossRepo: crossRepoLanding(undefined),
    };
    expect(landedRedVetoFor(status, evidence)).toBeUndefined();
  });

  it.each(RED_STATUSES)("%s with a polled branch that has genuinely not landed stays red", (status) => {
    const evidence: LandedEvidence = {
      boundRepo: boundRepoLanding(workflowState({ prState: "open", pushed: true })),
      crossRepo: crossRepoLanding(stamp({ state: "open" })),
    };
    expect(landedRedVetoFor(status, evidence)).toBeUndefined();
  });
});

// ── THE NARROWING, AND IT IS A CORRECTNESS RULE RATHER THAN A REFINEMENT ────────────────────────
//
// The first cut of this module applied the veto to the WHOLE red set. That is wrong for the two
// statuses that mean a prompt is DRAWN ON SCREEN: an agent whose PR merged and which is now sitting
// at a fresh permission prompt still cannot proceed without a person. The landing discharged the
// WORK; the prompt is a fact about the AGENT, and only the first of those is a thing a merge can
// settle. Demoting there would hide a live ask behind an unrelated landing — the exact inversion of
// the rule this module serves.
describe("a demonstrated ask is never discharged by a landing", () => {
  it("has a non-empty set on BOTH sides of the split — or every case below is vacuous", () => {
    // The anti-vacuity guard that matters most in this file. If `isDemonstratedAsk` ever returned
    // true for everything (or nothing), one of these `it.each` blocks would silently iterate an
    // empty array and report green while asserting nothing at all.
    expect(DEMONSTRATED_RED.length).toBeGreaterThan(0);
    expect(VETOABLE_RED.length).toBeGreaterThan(0);
    expect([...DEMONSTRATED_RED, ...VETOABLE_RED].sort()).toEqual([...RED_STATUSES].sort());
  });

  it.each(DEMONSTRATED_RED)(
    "%s stays RED even with landing PROVEN — the prompt outranks the merge",
    (status) => {
      expect(landedRedVetoFor(status, { boundRepo: "landed" })).toBeUndefined();
      expect(landedRedVetoFor(status, { crossRepo: "landed" })).toBeUndefined();
      expect(landedRedVetoFor(status, { boundRepo: "landed", crossRepo: "landed" })).toBeUndefined();
    },
  );

  it.each(VETOABLE_RED)(
    "%s with the SAME proven landing DOES demote — the paired positive, so the case above is not a constant",
    (status) => {
      expect(landedRedVetoFor(status, { boundRepo: "landed" })).toBe(LANDED_PAINT);
    },
  );
});

// ── The overlay, which is what the two status chains actually call ──────────────────────────────
describe("withLandedRedVeto", () => {
  const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
  /** A stage at or past `merged` is the bound repo's proof. */
  const LANDED_STAGE = "merged" as const;
  const UNLANDED_STAGE = "pushed" as const;

  it("demotes only the rows the veto applies to, leaving the rest byte-identical", () => {
    const before: Record<string, AgentTabStatus> = {
      a: VETOABLE_RED[0]!,
      b: VETOABLE_RED[0]!,
      c: "working",
    };
    const after = withLandedRedVeto(agents, before, (id) =>
      id === "a" ? LANDED_STAGE : UNLANDED_STAGE,
    );
    expect(after.a).toBe(LANDED_PAINT);
    // `b` is the SAME red status with an unlanded stage — the paired negative that proves the
    // demotion is driven by the EVIDENCE and not by the status.
    expect(after.b).toBe(before.b);
    expect(after.c).toBe("working");
  });

  it("returns the SAME REFERENCE when nothing is demoted — the no-render-churn contract its siblings hold", () => {
    const before: Record<string, AgentTabStatus> = { a: "working", b: "idle", c: "questions" };
    expect(withLandedRedVeto(agents, before, () => LANDED_STAGE)).toBe(before);
  });

  it("never mutates the input map", () => {
    const before: Record<string, AgentTabStatus> = { a: VETOABLE_RED[0]!, b: "idle", c: "idle" };
    const snapshot = { ...before };
    withLandedRedVeto(agents, before, () => LANDED_STAGE);
    expect(before).toEqual(snapshot);
  });

  it("leaves a demonstrated ask alone even with landing proven — the narrowing survives the overlay", () => {
    // The overlay is the layer production actually calls, so the narrowing has to hold HERE, not
    // only in the predicate. A guard correct in a pure function and bypassed by its own caller is a
    // shape this repo keeps paying for.
    const before: Record<string, AgentTabStatus> = { a: DEMONSTRATED_RED[0]!, b: "idle", c: "idle" };
    expect(withLandedRedVeto(agents, before, () => LANDED_STAGE)).toBe(before);
  });

  it("takes the CROSS-REPO stamp off the agent record, with no bound-repo reading at all", () => {
    // The row `set_agent_landed` exists for: the bound-repo probe cannot see the other repository,
    // so an unpolled stage plus a merged stamp must still discharge the red.
    const withStamp = [
      { id: "a", landedElsewhere: stamp({ state: "merged", prNumber: 253, sha: "79b157a" }) },
      { id: "b" },
    ];
    const before: Record<string, AgentTabStatus> = { a: VETOABLE_RED[0]!, b: VETOABLE_RED[0]! };
    const after = withLandedRedVeto(withStamp, before, () => undefined);
    expect(after.a).toBe(LANDED_PAINT);
    expect(after.b).toBe(before.b);
  });

  it("ignores an agent with no entry in the status map rather than inventing one", () => {
    const before: Record<string, AgentTabStatus> = { b: "idle" };
    const after = withLandedRedVeto(agents, before, () => LANDED_STAGE);
    expect(after).toBe(before);
    expect("a" in after).toBe(false);
  });
});

describe("stageLanding — the bound-repo reading both chains can actually reach", () => {
  it("reads merged and everything above it as landed", () => {
    expect(stageLanding("merged")).toBe("landed");
    expect(stageLanding("shipped")).toBe("landed");
  });

  it("is UNKNOWN rather than not-landed below merged, because resolveStage floors an unpolled row", () => {
    // Calling a floored stage a positive 'not landed' would manufacture a reading out of ignorance.
    expect(stageLanding("pushed")).toBe("unknown");
    expect(stageLanding(undefined)).toBe("unknown");
  });

  it("does not prove landing from a local-only merge", () => {
    // `merged_local` is below `merged` deliberately: work on this laptop is not work on the remote.
    expect(stageLanding("merged_local")).toBe("unknown");
  });
});

describe("landedEvidenceFor — one constructor, so the two chains cannot gather it differently", () => {
  it("carries BOTH readings through from the shapes the chains hold", () => {
    const e = landedEvidenceFor("merged", stamp({ state: "merged", prNumber: 253, sha: "79b157a" }));
    expect(e.boundRepo).toBe("landed");
    expect(e.crossRepo).toBe("landed");
    expect(landingProven(e)).toBe(true);
  });

  it("is unknown/unknown when nothing was observed — and that proves nothing", () => {
    const e = landedEvidenceFor(undefined, undefined);
    expect(e.boundRepo).toBe("unknown");
    expect(e.crossRepo).toBe("unknown");
    expect(landingProven(e)).toBe(false);
  });

  it("lets either signal carry the landing alone", () => {
    expect(landingProven(landedEvidenceFor("merged", undefined))).toBe(true);
    expect(
      landingProven(landedEvidenceFor(undefined, stamp({ state: "merged", prNumber: 1, sha: "abc1234" }))),
    ).toBe(true);
  });
});
