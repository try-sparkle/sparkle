import { describe, it, expect } from "vitest";
import {
  initialState,
  setArmed,
  noteTranscript,
  noteSpeechEnd,
  noteSpeechResumed,
  noteCountdownHeld,
  noteManualSend,
  pauseCountdown,
  restartCountdown,
  resumeCountdown,
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

// ══════════════════════════════════════════════════════════════════════════════════════════════
// AUTO-SEND OFF: THE COUNTDOWN STILL ENDS, THE MESSAGE STAYS (sparkle-aew8t)
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("noteCountdownHeld — the deadline passed with auto-send off", () => {
  it("stops the countdown but KEEPS the transcript, unlike the fire branch", () => {
    // THE DIFFERENCE FROM `evaluate`'s fire, and the reason this is its own reducer: a fire clears
    // the transcript because the box is empty behind the message. Here nothing left the box, so a
    // cleared transcript would make the reducer disagree with the textarea the user is looking at —
    // and `noteTranscript` only re-syncs when composedText CHANGES, so it would stay wrong until
    // they typed something.
    let s = setArmed(initialState(), true);
    s = noteTranscript(s, "ship the release", 0);
    s = noteSpeechEnd(s, 0);
    expect(s.phase).toBe("counting");

    const held = noteCountdownHeld(s);
    expect(held.phase).toBe("listening");
    expect(held.silenceStartedAt).toBeNull();
    expect(held.fireNoEarlierThan).toBeNull();
    // The words survive.
    expect(held.transcript).toBe("ship the release");
  });

  it("is NOT a disarm — the rail stays armed and counts again on the next utterance", () => {
    // `setArmed(s, false)` also stops a clock, and reaching for it here would be the obvious wrong
    // implementation: DISARMED means nothing is watching, which is what a tray parked on Send is.
    // Speak with auto-send off is still watching.
    let s = setArmed(initialState(), true);
    s = noteTranscript(s, "ship the release", 0);
    s = noteSpeechEnd(s, 0);
    s = noteCountdownHeld(s);
    expect(s.phase).not.toBe("disarmed");

    // A second utterance still starts a clock.
    s = noteTranscript(s, "and deploy it", 100);
    s = noteSpeechEnd(s, 100);
    expect(s.phase).toBe("counting");
  });

  it("is inert when nothing is counting", () => {
    const idle = setArmed(initialState(), true);
    expect(noteCountdownHeld(idle)).toBe(idle);
  });
});

describe("announcements never claim a send that auto-send withheld", () => {
  it("says nothing containing 'Sent' when willSend is false", () => {
    // The rail announcing "Sent to …" when nothing was sent is the defect both source headers warn
    // about, and an auto-send toggle is the most direct way back to it: the countdown still runs to
    // completion, so every countdown announcement still fires and only the send is gone.
    for (const event of ["armed", "counting", "fired", "held", "disarmed"] as const) {
      const line = autoSendAnnouncement(event, "Build 4", false);
      expect(line, `${event} must not claim a send`).not.toMatch(/\bSent\b/);
    }
  });

  it("still names the target, so a misroute is still catchable", () => {
    // The target name is the documented mis-route safety net. Withholding the SEND must not
    // withhold the WHERE — a screen-reader user has only this line.
    expect(autoSendAnnouncement("counting", "Build 4", false)).toContain("Build 4");
    expect(autoSendAnnouncement("held", "Build 4", false)).toContain("Build 4");
  });

  it("defaults to the sending copy, so existing callers are unchanged", () => {
    expect(autoSendAnnouncement("fired", "Concierge")).toBe(
      autoSendAnnouncement("fired", "Concierge", true),
    );
    expect(autoSendAnnouncement("fired", "Concierge")).toMatch(/\bSent\b/);
  });

  it("carries no digits, exactly like every other line", () => {
    for (const event of ["armed", "counting", "fired", "held", "disarmed"] as const) {
      const line = autoSendAnnouncement(event, "Build 4", false);
      expect(line.replace(/Build 4/g, "")).not.toMatch(/\d/);
    }
  });
});

describe("PAUSED while an @-address is being typed (sparkle-14dtu)", () => {
  // The founder: "when I start to type the name of an agent with the at sign, I want the countdown
  // timer to pause as I'm typing the name of the agent… it often sends before I'm done." These rows
  // are the reducer half — that a frozen clock cannot fire, cannot drain, and cannot go stale — and
  // that there is always a way back out of it.

  it("does not fire while paused, however long the deadline has been past", () => {
    // THE ROW THIS EXISTS FOR. Without the pause this fires at HIGH and the half-typed name goes out.
    const s = pauseCountdown(counting("Deploy the staging branch.", 0), 10);
    expect(evaluate(s, 10 + HIGH * 5).action).toBe("wait");
  });

  it("freezes the accumulated silence rather than merely withholding the send", () => {
    // The distinction is the whole design: withhold only the fire and the deadline slides past
    // underneath, so the send lands the instant the pause lifts — the same surprise, one moment on.
    const s = pauseCountdown(counting("ship it now", 0), 500);
    expect(elapsedMs(s, 500)).toBe(500);
    expect(elapsedMs(s, 500 + NORMAL * 3)).toBe(500);
    expect(remainingMs(s, 500 + NORMAL * 3)).toBe(NORMAL - 500);
  });

  it("stops the fill draining, so the picture and the deadline stay one fact", () => {
    const s = pauseCountdown(counting("ship it now", 0), NORMAL / 2);
    const frozen = remainingFraction(s, NORMAL / 2);
    expect(remainingFraction(s, NORMAL / 2 + 5_000)).toBe(frozen);
    expect(frozen).toBeGreaterThan(0);
  });

  it("cannot go STALE while paused — composing an address is not an absent user", () => {
    // `AUTO_SEND_STALE_MS` abandons a countdown nobody was present for. Someone typing a name is
    // present; a creeping staleness bound would throw their countdown away mid-word.
    const s = pauseCountdown(counting("ship it now", 0), 100);
    expect(evaluate(s, 100 + AUTO_SEND_STALE_MS * 2).action).toBe("wait");
  });

  it("is IDEMPOTENT — a second pause does not hand back the silence in between", () => {
    const once = pauseCountdown(counting("ship it now", 0), 500);
    const twice = pauseCountdown(once, 2_000);
    expect(twice.pausedAt).toBe(500);
    expect(elapsedMs(twice, 9_999)).toBe(500);
  });

  it("RESUMES with a full fresh threshold, not with the sliver that was left", () => {
    // He types `@` with 200ms on the clock and finishes the name: resuming where it stopped would
    // send the moment his finger left the spacebar, which is indistinguishable from the bug.
    const paused = pauseCountdown(counting("ship it now", 0), NORMAL - 200);
    const resumed = resumeCountdown(paused, 60_000);
    expect(resumed.pausedAt).toBeNull();
    expect(elapsedMs(resumed, 60_000)).toBe(0);
    expect(evaluate(resumed, 60_000 + NORMAL - 1).action).toBe("wait");
    expect(evaluate(resumed, 60_000 + NORMAL).action).toBe("fire");
  });

  it("resuming clears a drop-grace granted against an elapsed that no longer exists", () => {
    let s = counting("Deploy the staging branch and", 0); // verylow → 12s
    s = pauseCountdown(s, VERYLOW - 100);
    // A late chunk cleans the sentence up: the threshold drops below the elapsed, so a grace opens.
    s = noteTranscript(s, "Deploy the staging branch.", VERYLOW - 100);
    expect(s.fireNoEarlierThan).not.toBeNull();
    expect(resumeCountdown(s, 50_000).fireNoEarlierThan).toBeNull();
  });

  it("resuming a rail that was never counting just un-freezes it — no clock is invented", () => {
    const s = resumeCountdown(pauseCountdown(setArmed(initialState(), true), 0), 1_000);
    expect(s.pausedAt).toBeNull();
    expect(s.phase).toBe("listening");
    expect(s.silenceStartedAt).toBeNull();
  });

  it("resuming when nothing was paused is a no-op — it cannot restart a live countdown", () => {
    // The hook calls resume on every render where no mention is in progress, so this runs constantly
    // against a normally-counting rail. Re-anchoring there would make the countdown unable to end.
    const live = counting("ship it now", 0);
    expect(resumeCountdown(live, 5_000)).toBe(live);
  });

  it("a pause started while merely LISTENING still freezes the clock a speech-end then starts", () => {
    // He types `@` first and speaks afterwards. The clock must not run away while the name is open —
    // and the boundary must not be refused either, or nothing would ever count for that utterance.
    let s = pauseCountdown(setArmed(initialState(), true), 0);
    s = noteTranscript(s, "ship it now", 10);
    s = noteSpeechEnd(s, 20);
    expect(s.phase).toBe("counting");
    expect(evaluate(s, 20 + NORMAL * 3).action).toBe("wait");
    const resumed = resumeCountdown(s, 100_000);
    expect(evaluate(resumed, 100_000 + NORMAL).action).toBe("fire");
  });

  it("DISARMING clears the pause — an armed-later rail is never born frozen", () => {
    const s = setArmed(pauseCountdown(counting("ship it now", 0), 100), false);
    expect(s.pausedAt).toBeNull();
  });
});

describe("RESTARTED when something is put in the box — paste / drop / upload (sparkle-3kqg2v)", () => {
  // THE FOUNDER'S REPORT: *"reset the countdown if I paste something in or if I drop in an image or
  // upload a file. Just reset the countdown back and then start the countdown again."* The `@`-pause
  // above is the half he confirmed already works; this is the half that was missing.
  //
  // Every row asserts the SIDE EFFECT — what `evaluate` decides, or what the deadline becomes —
  // rather than that `silenceStartedAt` holds some number. The field is the mechanism; the send
  // going out early is the bug.

  it("THE WHOLE REPORT IN ONE ROW: a send that was about to fire is pushed a FULL threshold out", () => {
    // 100ms left on the clock — the exact moment he reaches for ⌘V. Before the fix this fired.
    const about = counting("ship it now", 0);
    expect(evaluate(about, NORMAL).action).toBe("fire");
    const reset = restartCountdown(about, NORMAL - 100);
    // Still nothing at the old deadline…
    expect(evaluate(reset, NORMAL).action).toBe("wait");
    // …and not until a whole fresh threshold has passed since the paste.
    expect(evaluate(reset, NORMAL - 100 + NORMAL - 1).action).toBe("wait");
    expect(evaluate(reset, NORMAL - 100 + NORMAL).action).toBe("fire");
  });

  it("resets to FULL, not to what was left — the elapsed clock goes back to zero", () => {
    const reset = restartCountdown(counting("ship it now", 0), 900);
    expect(elapsedMs(reset, 900)).toBe(0);
    expect(remainingMs(reset, 900)).toBe(NORMAL);
    expect(remainingFraction(reset, 900)).toBe(1);
  });

  it("KEEPS COUNTING — it is not a pause and not a cancel", () => {
    // The two neighbouring reducers both stop the clock, and either would be a plausible-looking
    // implementation. `pauseCountdown` would leave the rail frozen with no gesture left to un-freeze
    // it (a paste has no end); `noteSpeechResumed` would drop back to `listening`, so only a fresh
    // speech-end could ever count again and his finished sentence would sit there forever.
    const reset = restartCountdown(counting("ship it now", 0), 500);
    expect(reset.phase).toBe("counting");
    expect(reset.pausedAt).toBeNull();
    expect(reset.silenceStartedAt).not.toBeNull();
    expect(evaluate(reset, 500 + NORMAL).action).toBe("fire"); // it still fires, just later
  });

  it("EACH gesture is owed its own threshold — two pastes are not one", () => {
    // Deliberately NOT idempotent, the opposite of `pauseCountdown`'s rule. A boolean-edge signal
    // would collapse these two, which is the same complaint arriving one paste later.
    let s = restartCountdown(counting("ship it now", 0), 500);
    s = restartCountdown(s, 1_000);
    expect(evaluate(s, 1_000 + NORMAL - 1).action).toBe("wait");
    expect(evaluate(s, 1_000 + NORMAL).action).toBe("fire");
  });

  it("CANNOT START a countdown — pasting into an idle box arms nothing", () => {
    // The whole safety argument for wiring this to a paste: it can only ever DELAY a send. An
    // armed-but-listening rail has no clock, and a paste must not give it one before speech ends.
    const listening = setArmed(initialState(), true);
    expect(restartCountdown(listening, 5_000)).toBe(listening);
    const disarmed = initialState();
    expect(restartCountdown(disarmed, 5_000)).toBe(disarmed);
  });

  it("clears a drop-grace window granted against an elapsed time that no longer exists", () => {
    // Same reasoning `resumeCountdown` states. Without this the grace deadline outlives the reset
    // and can only push the send out further — harmless here, but it means the rail is drawing one
    // deadline and honouring another.
    let s = counting("hold the deploy because", 0); // verylow — a long threshold to accumulate under
    expect(s.tier).toBe("verylow");
    s = noteTranscript(s, "hold the deploy because it is flaky.", 4_000); // -> high, already blown past
    expect(s.fireNoEarlierThan).not.toBeNull();
    expect(restartCountdown(s, 4_000).fireNoEarlierThan).toBeNull();
  });

  it("a reset DURING an @-pause anchors at the frozen instant, not at wall-clock time", () => {
    // He pastes a URL half-way through typing `@Kraken`. The clock is frozen, so the seconds spent
    // inside the pause are not his — handing them back would shorten the countdown the pause exists
    // to protect. Composes with `resumeCountdown`, which re-anchors again on the way out.
    const paused = pauseCountdown(counting("ship it now", 0), 500);
    const reset = restartCountdown(paused, 90_000); // long pause, wall clock miles ahead
    expect(reset.pausedAt).toBe(500); // still frozen — a paste does not finish the address
    expect(elapsedMs(reset, 90_000)).toBe(0);
    expect(evaluate(reset, 90_000).action).toBe("wait");
    const resumed = resumeCountdown(reset, 90_000);
    expect(evaluate(resumed, 90_000 + NORMAL - 1).action).toBe("wait");
    expect(evaluate(resumed, 90_000 + NORMAL).action).toBe("fire");
  });
});
