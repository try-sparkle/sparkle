// A GOAL NO AGENT CAN SATISFY IS A DEFECT, NOT A STALL (bead sparkle-hrzitj, failure 4).
//
// MEASURED HARM, verbatim from the bead: "Babysit #69 burned 14 auto-continues against 'Land PR #91
// on main' - structurally impossible, because that repo is merge-protected and only the founder may
// merge. An unreachable goal is not a stall; it is a mis-specified goal."
//
// So the ladder must do NEITHER of the two things it did: not spend a continue (no restart can make
// a forbidden action happen), and not escalate (the streak's sentence — "something is blocking it
// that restarting cannot fix" — is a claim about the AGENT, and it is false; the agent is fine).
//
// EVERY ASSERTION IS ON THE SIDE EFFECT — what the ladder DID — and every one is PAIRED with the
// same input under a repo Sparkle may merge in, so the setup provably still reaches `continue` /
// `escalate` when the rule does not apply. A test asserting only the refusal would pass against a
// gate that refuses everything.
import { describe, expect, it } from "vitest";

import { type MergeAuthorityEvidence, newGoal } from "./agentGoal";
import {
  IDLE_SETTLE_MS,
  MAX_CONTINUES_TOTAL,
  MAX_CONTINUES_WITHOUT_PROGRESS,
  type ContinuationInput,
  decideContinuation,
  progressMark,
} from "./goalContinuation";

const T0 = 1_700_000_000_000;
const NOW = T0 + IDLE_SETTLE_MS + 1_000;

const MARK = progressMark({
  promptHistoryLength: 3,
  activity: "verifying",
  toolBursts: 4,
  commitsAhead: 2,
});

/** The goal text observed on the stranded row, verbatim from the bead. */
const OBSERVED_GOAL = "Land PR #91 on main";

/** A repo on the shipped merge-protected list: only a person may merge there, ever. */
const PROTECTED: MergeAuthorityEvidence = {
  mergeProtectedRepo: true,
  repo: "plow-pbc/tkmx-client",
};
/** The paired control — the identical goal in a repo Sparkle IS allowed to merge in. */
const OURS: MergeAuthorityEvidence = { mergeProtectedRepo: false, repo: "drodio/sparkle" };
/** Nobody could tell: a cold slug cache, an unknown root, a remote we do not recognise. */
const UNKNOWN: MergeAuthorityEvidence = { mergeProtectedRepo: undefined, repo: null };

/** Every gate open, so the ONLY thing that can change the answer is the merge-authority reading. */
function ready(goalText: string, over: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    goal: newGoal(goalText, T0),
    status: "idle",
    now: NOW,
    idleSince: T0,
    hasTurnEndAuthority: true,
    canAcceptInput: true,
    mark: MARK,
    processAlive: undefined,
    runtime: "local",
    cloud: undefined,
    ...over,
  };
}

/** A NO-progress streak at the given counters, so the next decision reaches the chosen bound. */
function streak(
  goalText: string,
  continues: number,
  totalContinues: number,
  over: Partial<ContinuationInput> = {},
): ContinuationInput {
  const goal = newGoal(goalText, T0);
  return ready(goalText, {
    goal: { ...goal, mark: MARK, continues, totalContinues },
    mark: MARK,
    ...over,
  });
}

describe("a goal requiring a forbidden merge never advances the ladder", () => {
  it("SPENDS NO CONTINUE — an otherwise-resumable agent is not restarted", () => {
    const d = decideContinuation(ready(OBSERVED_GOAL, { mergeAuthority: PROTECTED }));
    expect(d.action, "a restart cannot make a forbidden merge happen").toBe("none");
    if (d.action !== "none") return;
    expect(d.reason).toBe("goal-misspecified");
  });

  it("PAIRED — the identical input in a repo Sparkle may merge in IS resumed", () => {
    // Without this, the assertion above passes for a gate that refuses every agent.
    const d = decideContinuation(ready(OBSERVED_GOAL, { mergeAuthority: OURS }));
    expect(d.action).toBe("continue");
  });

  it("NEVER ESCALATES AT THE STREAK BOUND — the diagnosis would be false", () => {
    const d = decideContinuation(
      streak(OBSERVED_GOAL, MAX_CONTINUES_WITHOUT_PROGRESS, MAX_CONTINUES_WITHOUT_PROGRESS, {
        mergeAuthority: PROTECTED,
      }),
    );
    expect(d.action, '"something is blocking it that restarting cannot fix" is about the AGENT').toBe(
      "none",
    );
    if (d.action !== "none") return;
    expect(d.reason).toBe("goal-misspecified");
  });

  it("PAIRED — the identical streak in a mergeable repo DOES escalate", () => {
    const d = decideContinuation(
      streak(OBSERVED_GOAL, MAX_CONTINUES_WITHOUT_PROGRESS, MAX_CONTINUES_WITHOUT_PROGRESS, {
        mergeAuthority: OURS,
      }),
    );
    expect(d.action).toBe("escalate");
  });

  it("NEVER ESCALATES AT THE PER-GOAL CEILING EITHER", () => {
    const d = decideContinuation(
      streak(OBSERVED_GOAL, 0, MAX_CONTINUES_TOTAL, { mergeAuthority: PROTECTED }),
    );
    expect(d.action).toBe("none");
    if (d.action !== "none") return;
    expect(d.reason).toBe("goal-misspecified");
  });

  it("PAIRED — the identical ceiling in a mergeable repo DOES escalate", () => {
    const d = decideContinuation(
      streak(OBSERVED_GOAL, 0, MAX_CONTINUES_TOTAL, { mergeAuthority: OURS }),
    );
    expect(d.action).toBe("escalate");
  });

  it("carries a remedy that tells the reader to REWRITE THE GOAL", () => {
    const d = decideContinuation(ready(OBSERVED_GOAL, { mergeAuthority: PROTECTED }));
    expect(d.action).toBe("none");
    if (d.action !== "none") return;
    expect(d.remedy, "a reason token alone reproduces the silence this gate exists to end").toMatch(
      /REWRITE THE GOAL/,
    );
  });

  it("no other refusal arm carries a remedy", () => {
    // Pins the field as narrow rather than as a general note channel — a remedy on `not-idle` would
    // be a sentence about a row that is simply busy.
    const d = decideContinuation(ready("Ship the fix", { status: "working" }));
    expect(d.action).toBe("none");
    if (d.action !== "none") return;
    expect(d.reason).toBe("not-idle");
    expect(d.remedy).toBeUndefined();
  });
});

// ── FAIL CLOSED THE SAFE WAY. A false "unsatisfiable" silences a real stall, so ONLY a positive
// reading classifies. Each of these must behave exactly as it did before this gate existed.
describe("an unproven repo leaves the ladder exactly as it was", () => {
  it("resumes when nobody could tell whether the repo is merge-protected", () => {
    const d = decideContinuation(ready(OBSERVED_GOAL, { mergeAuthority: UNKNOWN }));
    expect(d.action, "could-not-tell must never buy silence").toBe("continue");
  });

  it("escalates at the streak bound when nobody could tell", () => {
    const d = decideContinuation(
      streak(OBSERVED_GOAL, MAX_CONTINUES_WITHOUT_PROGRESS, MAX_CONTINUES_WITHOUT_PROGRESS, {
        mergeAuthority: UNKNOWN,
      }),
    );
    expect(d.action).toBe("escalate");
  });

  it("resumes when the caller wired no merge evidence at all", () => {
    const d = decideContinuation(ready(OBSERVED_GOAL));
    expect(d.action).toBe("continue");
  });

  it("resumes an ordinary goal in a merge-protected repo", () => {
    const d = decideContinuation(
      ready("PR #91 is open, green and ready for a human to merge", {
        mergeAuthority: PROTECTED,
      }),
    );
    expect(d.action, "the repo pin is not a reason to stop working there").toBe("continue");
  });
});

// ── THE GATE MUST NOT SWALLOW A FINISHED OR ALREADY-OWNED GOAL. Each of these states says something
// the mis-specified reason would destroy.
describe("states that already have an answer keep it", () => {
  it("a MET goal still reports goal-met", () => {
    const g = newGoal(OBSERVED_GOAL, T0);
    const d = decideContinuation(
      ready(OBSERVED_GOAL, { goal: { ...g, metAt: T0 + 1 }, mergeAuthority: PROTECTED }),
    );
    expect(d.action).toBe("none");
    if (d.action !== "none") return;
    expect(d.reason).toBe("goal-met");
  });

  it("an ALREADY-ESCALATED goal keeps its escalation on the record", () => {
    const g = newGoal(OBSERVED_GOAL, T0);
    const d = decideContinuation(
      ready(OBSERVED_GOAL, { goal: { ...g, escalatedAt: T0 + 1 }, mergeAuthority: PROTECTED }),
    );
    expect(d.action).toBe("none");
    if (d.action !== "none") return;
    expect(d.reason, "re-labelling destroys the record of what the fleet did").toBe(
      "already-escalated",
    );
  });
});
