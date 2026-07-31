import { describe, it, expect } from "vitest";
import {
  initialState,
  setArmed,
  noteTranscript,
  noteSpeechEnd,
  noteSpeechResumed,
  noteManualSend,
  elapsedMs,
  remainingMs,
  remainingFraction,
  evaluate,
  autoSendAnnouncement,
  THRESHOLD_DROP_GRACE_MS,
  AUTO_SEND_STALE_MS,
  type AutoSendState,
} from "./autoSendTimer";
import { thresholdMs } from "./confidence";
import { SWEEP_FLOOR_MS, sweepThresholdMs } from "./sendMode";

// Derived from the ladder, never re-spelled as literals. The founder retuned the pace (x1.2), and
// every absolute ms here would have had to be rewritten by hand — churn that catches no regression
// while quietly inviting a typo. What these rows actually assert is the ACCUMULATION RULE: the
// clock survives re-evaluation and the deadline is measured from speech end. That rule is
// independent of the tuning, so it is expressed that way.
const HIGH = thresholdMs("high");
const NORMAL = thresholdMs("normal");
const VERYLOW = thresholdMs("verylow");

/** An armed rail holding `text`, with silence started at `t`. The common setup, spelled once. */
function counting(text: string, t: number): AutoSendState {
  let s = setArmed(initialState(), true);
  s = noteTranscript(s, text, t);
  return noteSpeechEnd(s, t);
}

describe("the clock ACCUMULATES — re-evaluation moves the threshold, never the clock", () => {
  it("a transcript chunk mid-countdown does not reset elapsed silence", () => {
    // This is THE regression. The obvious implementation clears its timeout and re-arms on every
    // chunk; chunks arrive several times a second, so the deadline is pushed past the horizon
    // forever and the send NEVER fires. Elapsed must survive re-evaluation untouched.
    const t0 = 1_000;
    let s = counting("fix the header", t0); // normal tier
    expect(elapsedMs(s, t0 + 2_000)).toBe(2_000);

    // A late committed segment lands 2s in. Same tier, so the deadline must not move at all.
    s = noteTranscript(s, "fix the header bar", t0 + 2_000);
    expect(elapsedMs(s, t0 + 2_000)).toBe(2_000);
    expect(remainingMs(s, t0 + 2_000)).toBe(NORMAL - 2_000);

    // …and it still fires on the ORIGINAL schedule.
    expect(evaluate(s, t0 + NORMAL - 1).action).toBe("wait");
    expect(evaluate(s, t0 + NORMAL).action).toBe("fire");
  });

  it("fires exactly at the threshold measured from speech end, not from the last chunk", () => {
    const t0 = 0;
    let s = counting("ship it", t0); // normal tier
    // Ten chunks, one every 200ms. A clock-resetting implementation would be at 3000ms remaining
    // after the last of them; the correct one is (NORMAL - 2000)ms from firing.
    for (let i = 1; i <= 10; i += 1) s = noteTranscript(s, "ship it", t0 + i * 200);
    expect(elapsedMs(s, t0 + 2_000)).toBe(2_000);
    expect(evaluate(s, t0 + NORMAL).action).toBe("fire");
  });

  it("a RISING threshold pushes the deadline out and does not fire early", () => {
    const t0 = 0;
    // Starts clean: "ship it." is the high tier.
    let s = counting("ship it.", t0);
    expect(remainingMs(s, t0)).toBe(HIGH);

    // At 900ms a chunk lands revealing a dangling conjunction -> verylow. The clock is still at
    // 900; the target just moved out to the verylow threshold.
    s = noteTranscript(s, "ship it. and", t0 + 900);
    expect(s.tier).toBe("verylow");
    expect(elapsedMs(s, t0 + 900)).toBe(900);
    expect(remainingMs(s, t0 + 900)).toBe(VERYLOW - 900);

    // The moment the OLD threshold would have fired: nothing happens.
    expect(evaluate(s, t0 + HIGH).action).toBe("wait");
    expect(evaluate(s, t0 + 5_000).action).toBe("wait");
    expect(evaluate(s, t0 + VERYLOW).action).toBe("fire");
  });
});

describe("the drop guard — a threshold that falls behind the elapsed clock waits ~600ms", () => {
  it("does not fire on the instant of the drop", () => {
    const t0 = 0;
    // verylow while the sentence dangles; 4s of silence accumulate.
    let s = counting("hold the deploy because", t0);
    expect(s.tier).toBe("verylow");
    expect(evaluate(s, t0 + 4_000).action).toBe("wait");

    // A late chunk completes the sentence -> high, which 4s of silence has already blown past.
    // Firing here would jump the rail from a third-full to gone between two frames.
    s = noteTranscript(s, "hold the deploy because the notarization is flaky.", t0 + 4_000);
    expect(s.tier).toBe("high");
    expect(s.fireNoEarlierThan).toBe(t0 + 4_000 + THRESHOLD_DROP_GRACE_MS);

    expect(evaluate(s, t0 + 4_000).action).toBe("wait");
    expect(evaluate(s, t0 + 4_000 + THRESHOLD_DROP_GRACE_MS - 1).action).toBe("wait");
    expect(evaluate(s, t0 + 4_000 + THRESHOLD_DROP_GRACE_MS).action).toBe("fire");
  });

  it("grants ONE window, not one per late chunk", () => {
    // Otherwise a stream of chunks each re-granting 600ms is an unbounded stall dressed up as a
    // guard. The user is owed one visible moment, not one per frame.
    const t0 = 0;
    let s = counting("hold the deploy because", t0);
    s = noteTranscript(s, "hold the deploy because it is flaky.", t0 + 4_000);
    const deadline = s.fireNoEarlierThan;
    s = noteTranscript(s, "hold the deploy because it is flaky!", t0 + 4_300);
    expect(s.fireNoEarlierThan).toBe(deadline);
    expect(evaluate(s, t0 + 4_000 + THRESHOLD_DROP_GRACE_MS).action).toBe("fire");
  });

  it("is released when a later chunk raises the threshold back above elapsed", () => {
    const t0 = 0;
    let s = counting("hold the deploy because", t0);
    s = noteTranscript(s, "hold the deploy because it is flaky.", t0 + 4_000);
    expect(s.fireNoEarlierThan).not.toBeNull();
    // The user keeps going — back to verylow, whose 10s is comfortably ahead of the 4.3s clock.
    // The grace window was protecting a deadline that no longer exists.
    s = noteTranscript(s, "hold the deploy because it is flaky and", t0 + 4_300);
    expect(s.fireNoEarlierThan).toBeNull();
    expect(evaluate(s, t0 + 5_000).action).toBe("wait");
  });

  it("only DELAYS — an expired grace never pulls the deadline in ahead of the threshold", () => {
    const t0 = 0;
    let s = counting("open the", t0); // verylow tier
    // A chunk at 100ms leaves us far short of any threshold, so no grace is granted…
    s = noteTranscript(s, "open the settings panel.", t0 + 100); // high tier
    expect(s.fireNoEarlierThan).toBeNull();
    // …and the ordinary threshold still governs.
    expect(evaluate(s, t0 + HIGH - 1).action).toBe("wait");
    expect(evaluate(s, t0 + HIGH).action).toBe("fire");
  });
});

describe("speech end is the only thing that starts the clock", () => {
  it("an armed rail with text but no speech-end is listening, not counting", () => {
    let s = setArmed(initialState(), true);
    s = noteTranscript(s, "ship it", 0);
    expect(s.phase).toBe("listening");
    expect(remainingMs(s, 10_000)).toBe(Infinity);
    expect(evaluate(s, 10_000).action).toBe("wait");
  });

  it("is idempotent within one silence — speech_final and UtteranceEnd describe the same stop", () => {
    // cloud.rs can emit both for one utterance (the flag on the final Results frame, then the
    // standalone frame ~1s later). The second must not push the deadline out by a second.
    const t0 = 0;
    let s = counting("ship it", t0);
    s = noteSpeechEnd(s, t0 + 1_000);
    expect(s.silenceStartedAt).toBe(t0);
    expect(evaluate(s, t0 + NORMAL).action).toBe("fire");
  });

  it("does nothing with an empty transcript — there is no message to send", () => {
    let s = setArmed(initialState(), true);
    s = noteTranscript(s, "   ", 0);
    s = noteSpeechEnd(s, 0);
    expect(s.phase).toBe("listening");
    expect(s.silenceStartedAt).toBeNull();
  });

  it("re-anchors after speech resumes, so a second utterance gets its own full window", () => {
    const t0 = 0;
    let s = counting("fix the header", t0);
    // The live preview says words are arriving RIGHT NOW → the countdown stops without sending.
    s = noteSpeechResumed(s);
    expect(s.phase).toBe("listening");
    expect(s.silenceStartedAt).toBeNull();
    // 8 seconds of talking later, the new utterance ends. Its clock starts THEN — measured against
    // the first utterance's start it would already be long overdue and would fire instantly.
    s = noteTranscript(s, "fix the header and the footer", t0 + 8_000);
    s = noteSpeechEnd(s, t0 + 8_000);
    expect(s.silenceStartedAt).toBe(t0 + 8_000);
    expect(evaluate(s, t0 + 8_000).action).toBe("wait");
  });

  it("noteSpeechResumed is a no-op when nothing is counting", () => {
    const s = setArmed(initialState(), true);
    expect(noteSpeechResumed(s)).toBe(s);
  });
});

describe("manual Send always overrides, at any confidence", () => {
  it("cancels an in-flight countdown without a second send", () => {
    const t0 = 0;
    let s = counting("fix the header", t0);
    s = noteManualSend(s);
    expect(s.phase).toBe("listening");
    expect(s.transcript).toBe("");
    // Long past when the countdown would have fired: nothing left to fire.
    expect(evaluate(s, t0 + 60_000).action).toBe("wait");
  });

  it("works from verylow, where the countdown had most of its window left to run", () => {
    const t0 = 0;
    let s = counting("send the diff to", t0);
    expect(s.tier).toBe("verylow");
    expect(remainingMs(s, t0 + 1_000)).toBe(VERYLOW - 1_000);
    s = noteManualSend(s);
    expect(s.silenceStartedAt).toBeNull();
    expect(evaluate(s, t0 + VERYLOW).action).toBe("wait");
  });

  it("leaves a DISARMED rail alone", () => {
    const s = initialState();
    expect(noteManualSend(s)).toBe(s);
  });
});

describe("arming", () => {
  it("disarming clears every clock, so re-arming starts fresh", () => {
    const t0 = 0;
    let s = counting("fix the header", t0);
    s = setArmed(s, false);
    expect(s.phase).toBe("disarmed");
    expect(s.silenceStartedAt).toBeNull();
    s = setArmed(s, true);
    expect(s.phase).toBe("listening");
    expect(evaluate(s, t0 + 60_000).action).toBe("wait");
  });

  it("a disarmed rail never counts, however much is said", () => {
    let s = initialState();
    s = noteTranscript(s, "ship it.", 0);
    s = noteSpeechEnd(s, 0);
    expect(s.phase).toBe("disarmed");
    expect(evaluate(s, 60_000).action).toBe("wait");
  });

  it("re-arming an already-armed rail is a no-op (it must not restart a live countdown)", () => {
    const t0 = 0;
    const s = counting("fix the header", t0);
    expect(setArmed(s, true)).toBe(s);
  });
});

describe("staleness — a countdown nobody was present for does not fire on its own", () => {
  it("goes stale rather than firing after a suspend", () => {
    // The app was backgrounded / the machine slept. The elapsed time is real but the user was not
    // watching a fill drain, and this rail's whole bargain is that they were.
    const t0 = 0;
    const s = counting("fix the header", t0);
    const d = evaluate(s, t0 + AUTO_SEND_STALE_MS);
    expect(d.action).toBe("stale");
    expect(d.state.phase).toBe("listening");
    expect(d.state.silenceStartedAt).toBeNull();
  });

  it("still fires normally just under the staleness bound", () => {
    // verylow's window is nowhere near the staleness bound, so ordinary operation is untouched.
    const t0 = 0;
    const s = counting("send the diff to", t0);
    expect(evaluate(s, t0 + VERYLOW).action).toBe("fire");
  });
});

describe("the fill fraction the rail draws", () => {
  it("drains from 1 to 0 across the current threshold", () => {
    const t0 = 0;
    const s = counting("fix the header", t0); // normal tier
    expect(remainingFraction(s, t0)).toBe(1);
    expect(remainingFraction(s, t0 + NORMAL / 2)).toBeCloseTo(0.5, 5);
    expect(remainingFraction(s, t0 + NORMAL)).toBe(0);
  });

  it("JUMPS UP when the threshold rises — that is the 'that just got longer' signal", () => {
    const t0 = 0;
    let s = counting("ship it.", t0); // high tier
    // Half-way through the HIGH window, whatever that window is tuned to.
    expect(remainingFraction(s, t0 + HIGH / 2)).toBeCloseTo(0.5, 5);
    s = noteTranscript(s, "ship it. and", t0 + HIGH / 2); // verylow tier
    // Same instant, same elapsed — but measured against the much longer verylow window, so the fill
    // JUMPS UP. The rail eases to this over ~250ms rather than teleporting (see SendRail); the MODEL
    // just reports the new truth.
    expect(remainingFraction(s, t0 + HIGH / 2)).toBeCloseTo(
      (VERYLOW - HIGH / 2) / VERYLOW,
      5,
    );
  });

  it("clamps to [0,1] when the threshold has already fallen behind the clock", () => {
    const t0 = 0;
    let s = counting("hold the deploy because", t0);
    s = noteTranscript(s, "hold the deploy because it is flaky.", t0 + 4_000);
    // Elapsed 4000 against a 1000ms threshold — the raw arithmetic is negative. An unclamped value
    // draws an inverted bar for the grace window's whole 600ms.
    expect(remainingFraction(s, t0 + 4_000)).toBe(0);
    expect(remainingFraction(s, t0 + 4_300)).toBe(0);
  });

  it("is a full bar whenever nothing is counting", () => {
    expect(remainingFraction(initialState(), 0)).toBe(1);
    expect(remainingFraction(setArmed(initialState(), true), 0)).toBe(1);
  });
});

describe("firing", () => {
  it("hands back the trimmed text and clears the rail", () => {
    const t0 = 0;
    const s = counting("  fix the header.  ", t0); // high tier
    const d = evaluate(s, t0 + HIGH);
    expect(d.action).toBe("fire");
    if (d.action !== "fire") throw new Error("unreachable");
    expect(d.text).toBe("fix the header.");
    expect(d.state.phase).toBe("listening");
    expect(d.state.transcript).toBe("");
    expect(d.state.silenceStartedAt).toBeNull();
  });

  it("each tier fires at its own threshold and no earlier", () => {
    const rows: Array<[string, number]> = [
      ["ship it.", thresholdMs("high")],
      ["ship it", thresholdMs("normal")],
      ["add a login button, um", thresholdMs("low")],
      ["fix the header and", thresholdMs("verylow")],
    ];
    for (const [text, threshold] of rows) {
      const s = counting(text, 0);
      expect(evaluate(s, threshold - 1).action, `${text} @ ${threshold - 1}`).toBe("wait");
      expect(evaluate(s, threshold).action, `${text} @ ${threshold}`).toBe("fire");
    }
  });
});

describe("announcements", () => {
  it("name the target and contain NO digits — the rail shows no numerals in any state", () => {
    for (const event of ["armed", "counting", "fired", "disarmed"] as const) {
      const line = autoSendAnnouncement(event, "Build 4");
      // "Build 4" is the agent's own NAME, so strip it before checking: the ban is on a countdown
      // readout, not on an agent that happens to be numbered.
      expect(line.replace(/Build 4/g, "")).not.toMatch(/\d/);
    }
    expect(autoSendAnnouncement("armed", "Build 4")).toContain("Build 4");
    expect(autoSendAnnouncement("counting", "Concierge")).toContain("Concierge");
    expect(autoSendAnnouncement("fired", "Concierge")).toContain("Concierge");
  });

  it("returns plain strings — this module never touches a live region", () => {
    // The concierge column has exactly ONE role="status" node and the host feeds it via announce().
    // A second region double-announces (roborev 52648/53010/53088), so this module must produce
    // text and nothing else.
    expect(typeof autoSendAnnouncement("armed", "x")).toBe("string");
  });
});describe("an emptied composer cancels rather than sending nothing", () => {
  it("does NOT fire an empty message when the transcript is cleared mid-countdown", () => {
    // noteSpeechEnd refuses to START on an empty transcript, but the clock, once running, is
    // deliberately untouched by re-evaluation — so a composer cleared mid-countdown (a store reset,
    // a send from elsewhere, a chunk that trims to whitespace) used to reach the fire branch with
    // text "" and dispatch an EMPTY message to an agent.
    let s = setArmed(initialState(), true);
    s = noteTranscript(s, "ship the release", 0);
    s = noteSpeechEnd(s, 0);
    expect(s.phase).toBe("counting");

    s = noteTranscript(s, "   ", 100);
    const decision = evaluate(s, 60_000); // long past any threshold
    expect(decision.action).toBe("wait");
    expect(decision.state.phase).toBe("listening");
    expect(decision.state.silenceStartedAt).toBeNull();
  });
});




// ── THE SWEEP FLOOR IS ENFORCED HERE, not merely promised by the tray ───────────────────────────
//
// `sweepThresholdMs` (voice/sendMode) is the ladder's rung for a tier, never faster than
// SWEEP_FLOOR_MS. The floor was shipped as an exported constant with its own unit test while this
// module still called `thresholdMs` directly — so nothing in the running app enforced it. The two
// agree today, because the ladder's fastest rung IS 1s; a retune below a second is exactly the case
// the floor exists for, and is exactly the case a same-value assertion cannot see.
describe("the countdown never runs faster than the sweep floor", () => {
  it("computes its deadline from sweepThresholdMs, not the raw ladder", () => {
    // Asserted as a RELATIONSHIP rather than against the literal 1000: with `high` at 1s the two
    // functions return the same number, so a row comparing to a constant would pass against either
    // import and prove nothing about which one this module calls.
    const s = counting("Ship the release.", 0); // a finished sentence → `high`
    expect(s.tier).toBe("high");
    expect(remainingMs(s, 0)).toBe(sweepThresholdMs(s.tier));
    // …and the fraction the tray sweeps is measured against the same floored total.
    expect(remainingFraction(s, sweepThresholdMs(s.tier) / 2)).toBeCloseTo(0.5, 5);
  });

  it("fires no earlier than the floor for every tier the ladder can produce", () => {
    // The broad one. Whatever the ladder is retuned to, an armed countdown must still give the user
    // a full second of visible sweep — below that it is a flicker between two frames, not a
    // countdown, and the chance to stop it never really existed.
    for (const tier of ["high", "normal", "low", "verylow"] as const) {
      const s: AutoSendState = { ...counting("Ship it.", 0), tier };
      expect(evaluate(s, SWEEP_FLOOR_MS - 1).action).toBe("wait");
    }
  });
});
