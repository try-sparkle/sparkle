// The founder was being cut off mid-sentence, repeatedly (bead `sparkle-r3wl6f`).
//
// ══ WHAT THIS FILE PINS, AND WHY IT IS A REPLAY RATHER THAN A UNIT TEST ════════════════════════
// `autoSendTimer.test.ts` beside it pins the RULES — the clock accumulates, a pause freezes it, a
// grace window can only delay. Every one of those rules was already correct on the evening this
// bug was measured, and the founder was still cut off eight times in a row. What was wrong was a
// NUMBER, and no rule-level test can see a number that is merely too small.
//
// So this file asserts the thing he actually asked for, in his words: *"a dictated utterance
// containing natural mid-sentence pauses arrives as ONE complete message, proven by a test over
// realistic pause timings."* It replays a whole utterance through the real reducers at millisecond
// granularity — speak, stop, stare at the screen, resume, stop, resume, finish — and counts the
// messages that come out. One utterance, one message, or the bug is back.
//
// ══ THE TRAP THIS FILE IS WRITTEN AGAINST ══════════════════════════════════════════════════════
// "It did not send" is a VACUOUS assertion on its own — it passes just as well for a rail that is
// switched off, disarmed, permanently stale, or broken in any way that makes it never fire at all.
// A test proving the founder is no longer interrupted must also prove he is still SERVED. So every
// case here is a PAIR: the same script, differing only in whether he keeps talking, asserting that
// silence-then-more-speech sends nothing AND that silence-then-stopping sends the whole thing.
//
// Timings are the real ones. `PAUSE_READING_UI` is 4s because that is the length of the pause the
// bug lives in — he dictates while reading the screen, so a glance mid-sentence is the normal case
// here, not the exception. Nothing in this file spells a threshold as a literal; they come from the
// ladder, so a retune moves the expectations with it and cannot silently un-cover the case.
import { describe, it, expect } from "vitest";

import {
  initialState,
  setArmed,
  noteTranscript,
  noteSpeechEnd,
  noteSpeechResumed,
  evaluate,
  THRESHOLD_DROP_GRACE_MS,
  AUTO_SEND_STALE_MS,
  STALE_DEADLINE_GRACE_MS,
  staleBoundMs,
  type AutoSendState,
} from "./autoSendTimer";
import { AUTO_SEND_TICK_MS } from "./useAutoSend";
import { thresholdMs } from "./confidence";

/**
 * How long the founder looks at the screen mid-sentence before carrying on.
 *
 * FOUR SECONDS, and the value is the entire point of the file. It is longer than the old `high`
 * rung (1.2s) and the old `normal` rung (3.6s), which is why his punctuated-but-unfinished
 * fragments went out; it is shorter than every rung of the retuned ladder, which is why they no
 * longer do. A pause this long is not an edge case in his usage — it is the usage.
 */
const PAUSE_READING_UI = 4_000;

/** A pause long enough to have blown the OLD `verylow` rung (12s) but not the new one (30s). */
const PAUSE_LONG_STARE = 15_000;

/**
 * Drive the rail exactly as the host does: tick `evaluate` every AUTO_SEND_TICK_MS across a span of
 * silence, collecting anything it fires.
 *
 * Ticking rather than jumping to the deadline is deliberate. A single `evaluate` at `t + span`
 * would miss a rail that fires EARLY and then re-arms, and firing early is the bug — so the test
 * has to look at every instant the app looks at, not just the one where the answer is expected.
 */
function tickThrough(
  state: AutoSendState,
  from: number,
  span: number,
): { state: AutoSendState; sent: string[] } {
  let s = state;
  const sent: string[] = [];
  for (let t = from; t <= from + span; t += AUTO_SEND_TICK_MS) {
    const d = evaluate(s, t);
    s = d.state;
    if (d.action === "fire") sent.push(d.text);
  }
  return { state: s, sent };
}

/** The user is speaking: an interim landed, so the clock stops without sending (`noteSpeechResumed`). */
function speaks(state: AutoSendState, text: string, at: number): AutoSendState {
  return noteTranscript(noteSpeechResumed(state), text, at);
}

/** The engine reported speech-end: the clock starts. */
function stops(state: AutoSendState, at: number): AutoSendState {
  return noteSpeechEnd(state, at);
}

describe("a dictated utterance with natural mid-sentence pauses arrives as ONE message", () => {
  it("does not send while he pauses to read the screen mid-sentence, then sends the whole thing", () => {
    // ══ THE VERBATIM CASE FROM THE BEAD ══════════════════════════════════════════════════════
    // He dictated one thought. It reached the concierge as two fragments, one word apart:
    //   'we can see that there is'
    //   'we can see that there is the'
    // Both are mid-clause — `is`, then `the` — and both went out while he was still speaking.
    let s = setArmed(initialState(), true);
    let sent: string[] = [];

    // "we can see that there is" — then he looks at the screen for four seconds.
    s = speaks(s, "we can see that there is", 0);
    s = stops(s, 1_000);
    ({ state: s, sent } = tickThrough(s, 1_000, PAUSE_READING_UI));
    expect(sent, "the fragment 'we can see that there is' must NOT have been sent").toEqual([]);

    // …carries on, and pauses again after another dangling article.
    s = speaks(s, "we can see that there is the", 5_000);
    s = stops(s, 5_500);
    ({ state: s, sent } = tickThrough(s, 5_500, PAUSE_READING_UI));
    expect(sent, "'we can see that there is the' must NOT have been sent either").toEqual([]);

    // …and finishes the sentence.
    const whole = "we can see that there is the build column filter still applied.";
    s = speaks(s, whole, 9_500);
    s = stops(s, 11_000);

    // NOW it sends — and this half is what stops the test above from being vacuous. Without it,
    // every assertion here would pass against a rail that is simply broken and never fires.
    ({ state: s, sent } = tickThrough(s, 11_000, thresholdMs("high") + AUTO_SEND_TICK_MS));
    expect(sent, "the finished sentence must arrive, exactly once, and whole").toEqual([whole]);
  });

  it("holds a trailing COMMA through a pause — the signal that was unreachable before", () => {
    // 'there are the actual tasks here. Each one of these tasks,' went out 6s after he stopped,
    // because `bareWord` stripped the comma before anything could test it. The comma is the least
    // ambiguous "more is coming" in the language and it was the one signal nothing could see.
    const fragment = "there are the actual tasks here. Each one of these tasks,";
    let s = setArmed(initialState(), true);
    let sent: string[] = [];

    s = speaks(s, fragment, 0);
    s = stops(s, 500);
    // Well past the rung it used to earn (`low`), and past a long stare too.
    ({ state: s, sent } = tickThrough(s, 500, PAUSE_LONG_STARE));
    expect(sent, "a sentence that stops ON A COMMA must not be finalised").toEqual([]);

    // Paired direction: he finishes the clause and it goes.
    const whole = `${fragment} each one goes to a build agent.`;
    s = speaks(s, whole, 16_000);
    s = stops(s, 17_000);
    ({ state: s, sent } = tickThrough(s, 17_000, thresholdMs("high") + AUTO_SEND_TICK_MS));
    expect(sent).toEqual([whole]);
  });

  it("holds a punctuated-but-unfinished sentence past the old 1.2s rung", () => {
    // THE ROW THAT ACTUALLY CUT HIM OFF MOST, and the one his own report did not predict.
    // Deepgram's `smart_format` puts a full stop on an unfinished thought, so
    // 'So these are the sent out to the build agents.' scored `high` — a clean, closed sentence —
    // and went out 1.2 seconds after he paused. There is no tail here to detect; the only defence
    // is that the rung is longer than a glance at the screen.
    const punctuatedFragment = "So these are the sent out to the build agents.";
    let s = setArmed(initialState(), true);
    let sent: string[] = [];

    s = speaks(s, punctuatedFragment, 0);
    s = stops(s, 500);
    // 1.5s — a glance, and long enough to have sent it under the old ladder.
    ({ state: s, sent } = tickThrough(s, 500, 1_500));
    expect(sent, "a 1.5s glance must no longer finalise a sentence").toEqual([]);
    expect(thresholdMs("high")).toBeGreaterThan(1_500);
  });
});

describe("the retuned rungs are the fix — pinned at the values the founder chose", () => {
  it("a mid-clause utterance survives the OLD 12s rung and fires at the new one", () => {
    // Pins the retune in BOTH directions on one script. Asserting only "it does not fire at 12s"
    // would pass for a rail that never fires at all — which is precisely the option the founder
    // declined ("never auto-send, hold until you press send"). He chose 30s knowing it still cuts
    // him off eventually, so the test must prove it still DOES.
    const OLD_VERYLOW = 12_000;
    const s = stops(speaks(setArmed(initialState(), true), "Let's just take this one here. And so", 0), 0);

    const before = tickThrough(s, 0, OLD_VERYLOW + AUTO_SEND_TICK_MS);
    expect(before.sent, "must survive the rung that used to cut him off").toEqual([]);

    const after = tickThrough(s, 0, thresholdMs("verylow") + AUTO_SEND_TICK_MS);
    expect(after.sent, "…but must still fire at the rung he chose — 30s is not a hold").toEqual([
      "Let's just take this one here. And so",
    ]);
  });

  it("staleness no longer caps the ladder — verylow can reach its own deadline", () => {
    // ══ THE COLLISION, PINNED ═══════════════════════════════════════════════════════════════
    // `AUTO_SEND_STALE_MS` is also 30_000 and `evaluate` tests it BEFORE the fire branch, so an
    // ABSOLUTE staleness bound would abandon a 30s `verylow` countdown on the very tick it came
    // due — silently converting the founder's stated choice into the one he declined. This asserts
    // the margin is measured from the tier's own deadline, which is what keeps the two independent.
    expect(thresholdMs("verylow")).toBeGreaterThanOrEqual(AUTO_SEND_STALE_MS);

    const s = stops(speaks(setArmed(initialState(), true), "fix the header and", 0), 0);
    const { sent } = tickThrough(s, 0, thresholdMs("verylow") + AUTO_SEND_TICK_MS);
    expect(sent, "a tier at or beyond the staleness margin must still be able to fire").toEqual([
      "fix the header and",
    ]);
  });

  it("still abandons a countdown nobody was present for", () => {
    // Unchanged for every tier below the flat bound: a freeze of AUTO_SEND_STALE_MS is still a
    // message nobody watched, and is still refused.
    const s = stops(speaks(setArmed(initialState(), true), "ship it.", 0), 0);
    const d = evaluate(s, AUTO_SEND_STALE_MS);
    expect(d.action).toBe("stale");
  });
});

describe("a suspend must not fire a fragment on wake — AT EVERY TIER, not just the fast ones", () => {
  // ══ THE REGRESSION THE FIRST ATTEMPT AT THIS FIX INTRODUCED (roborev 66358, Medium) ══════════
  // Lifting the staleness ceiling by making the bound purely tier-relative
  // (`thresholdFor(state) + AUTO_SEND_STALE_MS`) scaled the unwatched window WITH the tier, so the
  // LEAST-confident tier got the WIDEST one — 60s for `verylow` against the flat bound's 30s. The
  // founder's laptop lid closing 1s into a countdown and opening 45s later would then dispatch
  // `we can see that there is` to an agent on wake: exactly the send the guard exists to refuse,
  // and one the code REFUSED before that change.
  //
  // Nothing caught it, because every staleness test in the repo ran at `high` or `normal` — the two
  // tiers where the flat bound dominates and the bug is invisible. These run at `verylow`.

  it("a 45s freeze during a verylow countdown does NOT fire on wake", () => {
    const fragment = "we can see that there is";
    const s = stops(speaks(setArmed(initialState(), true), fragment, 0), 0);
    expect(s.tier).toBe("verylow");

    // The deadline passed 15s ago in wall-clock terms, but no tick ran for 45s.
    const d = evaluate(s, 45_000);
    expect(d.action, "a fragment must never be dispatched by a wake-up").toBe("stale");
    expect(d.state.phase).toBe("listening");
  });

  it("…and the same countdown, TICKED normally, still fires at its own deadline", () => {
    // The paired direction. Without it, the assertion above passes for a `verylow` tier that can
    // never fire at all — which is the ceiling bug this whole change exists to remove, and the
    // option ("never auto-send") the founder explicitly declined.
    const fragment = "we can see that there is";
    const s = stops(speaks(setArmed(initialState(), true), fragment, 0), 0);
    const { sent } = tickThrough(s, 0, thresholdMs("verylow") + AUTO_SEND_TICK_MS);
    expect(sent).toEqual([fragment]);
  });

  it("gives verylow a ONE-SECOND window past its deadline, not another thirty", () => {
    // The bound is a `max`, so it must be the flat value wherever that is stricter and only lift
    // for a tier that could not otherwise reach its deadline. Asserted as a relation rather than a
    // literal, so a retune of either constant keeps the property.
    const verylow = stops(speaks(setArmed(initialState(), true), "fix the header and", 0), 0);
    expect(staleBoundMs(verylow)).toBe(thresholdMs("verylow") + STALE_DEADLINE_GRACE_MS);
    // …and every tier BELOW the flat bound keeps exactly the behaviour it had before this bead.
    for (const text of ["ship it.", "ship it", "add a login button, um"]) {
      const s = stops(speaks(setArmed(initialState(), true), text, 0), 0);
      expect(thresholdMs(s.tier)).toBeLessThan(AUTO_SEND_STALE_MS);
      expect(staleBoundMs(s)).toBe(AUTO_SEND_STALE_MS);
    }
  });

  it("does NOT call a legitimate threshold DROP stale — the flat floor is what covers it", () => {
    // Why the bound cannot just be `threshold + STALE_DEADLINE_GRACE_MS`. A late chunk that drops
    // the tier leaves elapsed far past the NEW threshold with the loop running the whole time;
    // a 1s bound would throw that countdown away instead of firing it after the visible 600ms the
    // drop-grace promises. 25s of accumulated verylow silence, then the sentence reads clean.
    let s = stops(speaks(setArmed(initialState(), true), "fix the header and", 0), 0);
    s = noteTranscript(s, "fix the header and ship it.", 25_000);
    expect(s.tier).toBe("high");

    const d = evaluate(s, 25_000);
    expect(d.action, "a countdown the user WAS watching must not be discarded").not.toBe("stale");
    const { sent } = tickThrough(s, 25_000, THRESHOLD_DROP_GRACE_MS + AUTO_SEND_TICK_MS);
    expect(sent).toEqual(["fix the header and ship it."]);
  });
});
