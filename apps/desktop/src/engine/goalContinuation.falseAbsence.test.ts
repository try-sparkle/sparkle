// FALSE-ABSENCE CASE: corpus instance `resume-ticker-no-progress` (bead sparkle-gazo4a).
//
// MEASURED: "The resume ticker counts a long verify or a queued CI run as 'no progress' and re-arms
// agents that are working fine." The sentence it sent them was "Nothing Sparkle can observe has
// changed since resume N" — a statement about SPARKLE'S OWN BLINDNESS, delivered as a finding about
// the agent, and followed by an instruction to take a concrete step. An agent twenty minutes into a
// verification run reads that as an accusation and interrupts real work to answer it.
//
// The contract is `apps/desktop/shared/false-absence-corpus.json`; the lexicon that decides what
// counts as an absence claim lives in `engine/probeOutcome.ts` and is pinned to that file by
// `probeOutcome.falseAbsence.test.ts`.
//
// EVERY ASSERTION HERE DRIVES THE REAL `decideContinuation`, never a copy of its rule — the vacuity
// shape AGENTS.md names. And each is PAIRED: the blind reading must be honest AND the ordinary
// reading must still say the ordinary thing, because a test that only proves silence passes just as
// well against a function that has been emptied out.
import { describe, expect, it } from "vitest";

import { newGoal } from "./agentGoal";
import {
  IDLE_SETTLE_MS,
  MAX_CONTINUES_WITHOUT_PROGRESS,
  type ContinuationInput,
  decideContinuation,
  progressMark,
  workEvidenceReadable,
} from "./goalContinuation";
import { absenceClaimIn } from "./probeOutcome";

const T0 = 1_700_000_000_000;

/** A mark whose WORK-EVIDENCE columns were all UNREADABLE — the shape a sweep produces when the
 *  fleet digest, the branch status and the PR state all came back with no reading. This is what a
 *  long local verify looks like from outside: the agent is busy, and every column that would show it
 *  is empty. */
const BLIND_MARK = progressMark({
  promptHistoryLength: 3,
  activity: "Wiring the retry ladder",
  aiTitle: "retry ladder",
  toolBursts: null,
  commitsAhead: null,
  prMark: null,
});

/** The same agent, SEEN: the digest was read, the branch was read. Identical across two sweeps means
 *  the agent genuinely did nothing, and the ordinary wording is then correct. */
const SEEN_MARK = progressMark({
  promptHistoryLength: 3,
  activity: "Wiring the retry ladder",
  aiTitle: "retry ladder",
  toolBursts: 4,
  commitsAhead: 2,
  prMark: "open#2718",
});

function ready(over: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    goal: newGoal("Ship the auto-continue PR", T0),
    status: "idle",
    now: T0 + IDLE_SETTLE_MS + 1_000,
    idleSince: T0,
    hasTurnEndAuthority: true,
    canAcceptInput: true,
    mark: SEEN_MARK,
    processAlive: undefined,
    runtime: "local",
    cloud: undefined,
    ...over,
  };
}

/** Put the goal into a repeat-resume streak: the recorded mark equals the live one, and `continues`
 *  is already `n`, so the next decision is attempt `n + 1` and the banner is reached. */
function inStreak(mark: string, continues: number, over: Partial<ContinuationInput> = {}) {
  const goal = newGoal("Ship the auto-continue PR", T0);
  return ready({ goal: { ...goal, mark, continues }, mark, ...over });
}

describe("workEvidenceReadable separates a blind sweep from an idle agent", () => {
  it("is false when every work column is empty, true when any was read", () => {
    expect(workEvidenceReadable(BLIND_MARK)).toBe(false);
    expect(workEvidenceReadable(SEEN_MARK)).toBe(true);
  });

  it("judges ONLY a well-formed mark — a legacy or synthetic string reads as observed", () => {
    // A failed reading always produces a WELL-FORMED mark with empty work columns, because
    // `progressMark` renders every missing input as an empty token. An unparseable string is an
    // older build or a hand-built fixture, and softening the wording for those would be muting on a
    // guess — the same error this bead is about, pointed the other way.
    expect(workEvidenceReadable(undefined)).toBe(true);
    expect(workEvidenceReadable("stuck")).toBe(true);
    // …and the well-formed all-empty mark, which IS a failed reading, is still blind.
    expect(workEvidenceReadable(BLIND_MARK)).toBe(false);
  });

  it("is true when only ONE column was readable", () => {
    // The columns are independent readings; one surviving is still an observation, and treating it
    // as blind would mute a genuine stall on a partially-degraded window.
    expect(workEvidenceReadable(progressMark({ promptHistoryLength: 1, commitsAhead: 0 }))).toBe(true);
  });
});

describe("instance resume-ticker-no-progress: a blind streak never asserts nothing changed", () => {
  it("THE CASE — the resume banner carries no absence claim when the signals were unreadable", () => {
    const d = decideContinuation(inStreak(BLIND_MARK, 1));
    expect(d.action).toBe("continue");
    if (d.action !== "continue") return;
    const claim = absenceClaimIn(d.prompt);
    expect(claim, `the blind resume banner asserts absence via pattern "${claim}"`).toBeNull();
    // …and it says the true thing rather than merely omitting the false one. A banner that had been
    // stripped to "THIS IS AUTO-RESUME 2" would satisfy the line above and tell the agent nothing.
    expect(d.prompt).toContain("could not read its own progress signals");
    expect(d.prompt).toContain("NOT a judgement that you have stalled");
  });

  it("PAIRED — the same streak WITH readings still says the ordinary thing", () => {
    // Without this the test above passes against a `repeatedResumeLine` that always returns the
    // blind arm, which would mute every genuine stall in the fleet.
    const d = decideContinuation(inStreak(SEEN_MARK, 1));
    expect(d.action).toBe("continue");
    if (d.action !== "continue") return;
    expect(d.prompt).toContain("Nothing Sparkle can observe has changed since resume 1");
    // And that ordinary sentence IS an absence claim — which is legitimate here, because the
    // reading behind it was taken. This assertion is what proves the lexicon would have caught the
    // blind case above rather than being blind to the sentence altogether.
    expect(absenceClaimIn(d.prompt)).toBe("nothing-changed");
  });

  it("the ESCALATION at the bound is honest about which situation a human is looking at", () => {
    const blind = decideContinuation(inStreak(BLIND_MARK, MAX_CONTINUES_WITHOUT_PROGRESS));
    expect(blind.action).toBe("escalate");
    if (blind.action !== "escalate") return;
    expect(absenceClaimIn(blind.reason)).toBeNull();
    expect(blind.reason).toContain("whether it advanced is unknown, not settled");

    const seen = decideContinuation(inStreak(SEEN_MARK, MAX_CONTINUES_WITHOUT_PROGRESS));
    expect(seen.action).toBe("escalate");
    if (seen.action !== "escalate") return;
    expect(seen.reason).toContain("with no sign of progress");
  });

  it("a streak with ONE readable end is a real comparison, not a blind one", () => {
    // The blindness test requires BOTH marks to be unreadable. A sweep that read the agent once and
    // then lost the digest has still observed it, and muting that would be its own false negative —
    // the opposite error to the one this bead is about, and just as expensive.
    const goal = newGoal("Ship the auto-continue PR", T0);
    const d = decideContinuation(
      ready({ goal: { ...goal, mark: SEEN_MARK, continues: 1 }, mark: SEEN_MARK }),
    );
    expect(d.action).toBe("continue");
    if (d.action !== "continue") return;
    expect(d.prompt).toContain("Nothing Sparkle can observe has changed");
  });
});
