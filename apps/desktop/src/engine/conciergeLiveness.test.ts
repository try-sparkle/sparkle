// The liveness state machine. Every case is a claim about when the column may CHANGE COLOUR — so the
// boundary cases matter more than the happy path, and the ones that must NOT fire matter most of all.
//
// The single most important case in this file is the first one in "gray is the normal state": the
// founder's complaint was that the row got loud on ordinary slowness, so a test that only proved the
// escalations fire would be guarding half the requirement.
import { describe, expect, it } from "vitest";

import {
  FAILURE_OUTAGE_RUN,
  FAILURE_RUN_MAX_GAP_MS,
  IDLE_LIVENESS,
  SLOW_AFTER_MS,
  STALLED_AFTER_MS,
  STALLED_SILENT_RUN,
  failureOutage,
  livenessAt,
  reduceFailed,
  reduceProgress,
  reduceSent,
  reduceSettled,
  reduceTick,
  ticks,
  type ConciergeLivenessState,
} from "./conciergeLiveness";

const T0 = 1_700_000_000_000;

/** Advance the clock by running the ticker, the way the store's interval does. Without this a
 *  time-based escalation would only ever be observed through `livenessAt`, and the LATCH — the
 *  thing that makes RED sticky — would never be exercised. */
function tickTo(s: ConciergeLivenessState, now: number): ConciergeLivenessState {
  return reduceTick(s, now);
}

describe("livenessAt — the boundaries", () => {
  it("says idle when nothing is being awaited", () => {
    expect(livenessAt(IDLE_LIVENESS, T0)).toBe("idle");
  });

  it("says waiting right up to the slow threshold, and slow exactly on it", () => {
    const sent = reduceSent(IDLE_LIVENESS, T0);
    expect(livenessAt(sent, T0)).toBe("waiting");
    expect(livenessAt(sent, T0 + SLOW_AFTER_MS - 1)).toBe("waiting");
    expect(livenessAt(sent, T0 + SLOW_AFTER_MS)).toBe("slow");
  });

  it("escalates to stalled on continuous silence", () => {
    const sent = reduceSent(IDLE_LIVENESS, T0);
    expect(livenessAt(sent, T0 + STALLED_AFTER_MS - 1)).toBe("slow");
    expect(livenessAt(sent, T0 + STALLED_AFTER_MS)).toBe("stalled");
  });

  // THE PROPERTY THAT MAKES 30s SAFE AGAINST A ~54s MEDIAN TURN. The clock measures SILENCE, not
  // elapsed time, so a turn that is streaming resets it continuously and never trips. Without this
  // the threshold would have to sit above the p90 turn duration (~120s) to avoid false alarms, by
  // which point the human has long since given up.
  it("a delta resets the clock, so a long STREAMING turn never leaves gray", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = reduceProgress(s, T0 + 29_000, "text");
    expect(livenessAt(s, T0 + 45_000)).toBe("waiting");
    expect(livenessAt(s, T0 + 29_000 + SLOW_AFTER_MS)).toBe("slow");
  });
});

// ── GRAY IS THE NORMAL STATE, AND THAT IS THE REQUIREMENT ───────────────────────────────────────
//
// *"A concierge taking a few seconds is normal and should look normal."* The previous version put a
// counter on screen at 5s and the word "No answer yet" at 20s; the retune's whole point is that
// nothing happens at all for half a minute. These are the cases that would go red again if someone
// tuned the constants back down, so they assert against the SECONDS, not against the constants.
describe("gray is the normal state", () => {
  const sent = reduceSent(IDLE_LIVENESS, T0);

  it("says nothing for the first thirty seconds", () => {
    for (const at of [0, 1_000, 5_000, 12_000, 20_000, 29_999]) {
      expect(livenessAt(sent, T0 + at)).toBe("waiting");
    }
  });

  // The founder's reasoning, kept as an executable claim: *going red at 30 seconds is too
  // distracting for something that is usually just a slow turn. Red should mean something is
  // actually wrong, not that a reply is taking a moment.*
  it("is not RED at thirty seconds — that was the complaint", () => {
    expect(livenessAt(sent, T0 + 30_000)).not.toBe("stalled");
    expect(livenessAt(sent, T0 + 59_999)).not.toBe("stalled");
  });

  // 30s clears the slowest observed hard failure (16.67s) by ~2x, so a turn that is going to report
  // a real error always wins the race and states its own reason before any colour moves.
  it("stays gray past the slowest hard failure ever observed", () => {
    expect(livenessAt(sent, T0 + 16_670)).toBe("waiting");
  });
});

describe("red is STICKY", () => {
  // Without the latch, the next send resets the silence clock and the column would drop straight
  // back to gray — quietly downgrading a brain nothing has proved is back, which is the silence this
  // whole feature exists to end.
  it("a fresh send does not downgrade a latched red", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = tickTo(s, T0 + STALLED_AFTER_MS);
    expect(livenessAt(s, T0 + STALLED_AFTER_MS)).toBe("stalled");

    const resent = reduceSent(s, T0 + 100_000);
    expect(livenessAt(resent, T0 + 100_000)).toBe("stalled");
  });

  it("only observed output clears it", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = tickTo(s, T0 + STALLED_AFTER_MS);
    const recovered = reduceProgress(s, T0 + 100_000, "text");
    expect(livenessAt(recovered, T0 + 100_000)).toBe("waiting");
  });

  it("a completed turn clears it too", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = tickTo(s, T0 + STALLED_AFTER_MS);
    expect(livenessAt(reduceSettled(s), T0 + 100_000)).toBe("idle");
  });

  it("the ticker returns the SAME object when nothing changed, so it can run every second", () => {
    const s = reduceSent(IDLE_LIVENESS, T0);
    expect(reduceTick(s, T0 + 1_000)).toBe(s);
  });
});

describe("repeated pings with no response", () => {
  // THE 20:18-20:31 BURST, 2026-07-29: 12 of 14 turns died unanswered because each new send killed
  // the last. Every send restarts the silence clock, so continuous silence NEVER reaches 60s — the
  // time bound alone would have stayed gray through the exact incident this was built for.
  it("goes red on consecutive unanswered sends even though silence never reaches the time bound", () => {
    let s = IDLE_LIVENESS;
    let now = T0;
    for (let i = 0; i < STALLED_SILENT_RUN; i += 1) {
      s = reduceSent(s, now);
      now += SLOW_AFTER_MS + 1_000; // re-sent at ~31s, just past the measured median
      expect(livenessAt(s, now)).not.toBe("stalled");
    }
    s = reduceSent(s, now);
    expect(livenessAt(s, now)).toBe("stalled");
  });

  it("a send that DID stream something is not an unanswered ping", () => {
    let s = IDLE_LIVENESS;
    let now = T0;
    for (let i = 0; i < STALLED_SILENT_RUN + 2; i += 1) {
      s = reduceSent(s, now);
      s = reduceProgress(s, now + 1_000, "text"); // the turn answered, then the user sent again anyway
      now += SLOW_AFTER_MS + 1_000;
    }
    s = reduceSent(s, now);
    expect(livenessAt(s, now)).toBe("waiting");
  });

  it("a send answered INSIDE the gray window is not an unanswered ping either", () => {
    let s = IDLE_LIVENESS;
    let now = T0;
    for (let i = 0; i < STALLED_SILENT_RUN + 2; i += 1) {
      s = reduceSent(s, now);
      now += SLOW_AFTER_MS - 1_000; // impatient re-send, but inside the window
    }
    expect(livenessAt(reduceSent(s, now), now)).toBe("waiting");
  });
});

// ── ERRORS THE APP ACTUALLY RECEIVED ARE NOT PART OF THE SILENCE SIGNAL ─────────────────────────
//
// The retune was explicitly scoped to silence: a real quota message, a billing error or a hard
// failure must still surface verbatim. `failureOutage` is the sticky version of that fact, and it is
// deliberately reachable ONLY through observed errors — never through a quiet clock.
describe("hard failures", () => {
  const QUOTA = "You've hit your session limit · resets 8:40am (America/Bogota)";

  it("records the verbatim reason and ends the wait", () => {
    const s = reduceFailed(reduceSent(IDLE_LIVENESS, T0), QUOTA, T0);
    expect(s.failure?.evidence).toBe(QUOTA);
    expect(livenessAt(s, T0 + 200_000)).toBe("idle");
  });

  // One failure is the blip the Rust retry path exists for, and its verbatim reason is already going
  // into the thread as its own bubble. A sticky banner on a single error is the flappiness
  // aiServiceHealthStore was built to avoid.
  it("does not raise the outage strip on a single failure", () => {
    expect(failureOutage(reduceFailed(IDLE_LIVENESS, QUOTA, T0))).toBeNull();
  });

  // Every failure actually observed in a day of logs was a fast, LOUD error (3-17s), which ends the
  // wait and so accumulates no silence at all. Six consecutive spend-limit rejections is the textbook
  // "your concierge is unavailable" condition, and the silence clock never moves for it.
  it("raises the outage strip on consecutive failures, which produce no silence whatsoever", () => {
    let s = IDLE_LIVENESS;
    for (let i = 0; i < FAILURE_OUTAGE_RUN - 1; i += 1) s = reduceFailed(s, QUOTA, T0);
    expect(failureOutage(s)).toBeNull();
    s = reduceFailed(s, QUOTA, T0);
    // The machine's own words survive into the sticky state — the strip states WHY, not just that.
    expect(failureOutage(s)?.evidence).toContain("resets 8:40am");
  });

  // THE SEPARATION THE RETUNE TURNS ON. Silence may never speak in words: an outage strip reached by
  // a quiet clock would be presenting a stale morning quota rejection as the account of an afternoon
  // lull — the exact lie roborev 55442-M4 named, now impossible by construction.
  it("silence alone NEVER raises the strip, even carrying an old failure and even at red", () => {
    let s = reduceFailed(IDLE_LIVENESS, QUOTA, T0);
    let now = T0;
    for (let i = 0; i <= STALLED_SILENT_RUN; i += 1) {
      s = reduceSent(s, now);
      now += SLOW_AFTER_MS + 1_000;
    }
    expect(livenessAt(s, now)).toBe("stalled");
    // The failure is still ON the state — it is the last thing we know — which is precisely why the
    // strip has to be gated on the RUN rather than on its presence.
    expect(s.failure).not.toBeNull();
    expect(failureOutage(s)).toBeNull();
  });

  it("a success between failures breaks the run", () => {
    let s = IDLE_LIVENESS;
    s = reduceFailed(s, QUOTA, T0);
    s = reduceFailed(s, QUOTA, T0);
    s = reduceSettled(s);
    s = reduceFailed(s, QUOTA, T0);
    expect(s.failureRun).toBe(1);
    expect(failureOutage(s)).toBeNull();
  });

  // A loud failure and a silent one are different facts. Letting them add up would produce a state
  // that describes neither.
  it("an error resets the SILENT run — it is a response, just not an answer", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = reduceSent(s, T0 + SLOW_AFTER_MS + 1); // one unanswered ping banked
    expect(s.silentRun).toBe(1);
    expect(reduceFailed(s, QUOTA, T0).silentRun).toBe(0);
  });
});

// ── THE TIMER'S BOUND ───────────────────────────────────────────────────────────────────────────
//
// `ticks` is the gate on the feature's only interval. It is pure and exported precisely so the bound
// is asserted here, against the decision, rather than inferred from a timer count in a component.
describe("ticks — is there anything left for a clock to change", () => {
  it("does not run for a resting app", () => {
    expect(ticks(IDLE_LIVENESS, T0)).toBe(false);
  });

  it("runs while a colour can still move", () => {
    const s = reduceSent(IDLE_LIVENESS, T0);
    expect(ticks(s, T0)).toBe(true);
    expect(ticks(s, T0 + SLOW_AFTER_MS)).toBe(true);
  });

  // RED IS TERMINAL, so the interval stops there. This is what the removal of the seconds counter
  // bought: nothing on screen is derived from `now` any more, so a turn that dies and is never
  // retried schedules nothing for the rest of the session — no ceiling constant required.
  it("stops at red, because no later tick could change a pixel", () => {
    const s = reduceSent(IDLE_LIVENESS, T0);
    expect(ticks(s, T0 + STALLED_AFTER_MS - 1)).toBe(true);
    expect(ticks(s, T0 + STALLED_AFTER_MS)).toBe(false);
  });

  it("stops for a LATCHED red too, whatever the clock says", () => {
    const s = reduceTick(reduceSent(IDLE_LIVENESS, T0), T0 + STALLED_AFTER_MS);
    expect(s.stalledLatched).toBe(true);
    expect(ticks(s, T0 + STALLED_AFTER_MS + 1_000)).toBe(false);
  });

  // A send into a dead silence does NOT restart the timer while the latch stands — the row is
  // already red and staying red, so there is still nothing for a clock to do.
  it("starts again only once something actually clears the latch", () => {
    const dead = reduceTick(reduceSent(IDLE_LIVENESS, T0), T0 + STALLED_AFTER_MS);
    const at = T0 + STALLED_AFTER_MS + 10_000;
    expect(ticks(reduceSent(dead, at), at)).toBe(false);
    expect(ticks(reduceSent(reduceProgress(dead, at, "text"), at), at)).toBe(true);
  });
});

// ── A TOOL CALL IS A SIGN OF LIFE BUT NOT AN ANSWER ─────────────────────────────────────────────
//
// roborev 55442-M1. One flag was being asked two different questions. Liveness wants "is anything
// happening", for which a tool call counts; the unanswered-message receipt wants "did the user get
// an answer", for which it does not. Reading state or a terminal before replying is the concierge's
// normal FIRST move, so conflating them exempted the most common shape of a dropped question.
describe("sawOutput vs sawText", () => {
  it("a tool call keeps the turn alive without claiming it answered anyone", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = reduceProgress(s, T0 + 3_000, "tool");
    expect(s.sawOutput).toBe(true);
    expect(s.sawText).toBe(false);
  });

  it("assistant text sets both", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = reduceProgress(s, T0 + 3_000, "text");
    expect(s.sawOutput).toBe(true);
    expect(s.sawText).toBe(true);
  });

  // A tool call still has to reset the SILENCE clock, or a turn that spends a minute reading
  // terminals without speaking would go red while visibly working.
  it("a tool call still resets the silence clock", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = reduceProgress(s, T0 + 29_000, "tool");
    expect(livenessAt(s, T0 + 45_000)).toBe("waiting");
  });

  it("both flags reset for each new turn", () => {
    let s = reduceProgress(reduceSent(IDLE_LIVENESS, T0), T0 + 1_000, "text");
    s = reduceSent(s, T0 + 5_000);
    expect(s.sawOutput).toBe(false);
    expect(s.sawText).toBe(false);
  });
});

// ── A RUN IS CONSECUTIVE IN TIME, NOT MERELY IN COUNT ───────────────────────────────────────────
//
// roborev 55442-M4, second half. Without a gap bound, "3 consecutive failures" means "3 failures
// ever, with any amount of working concierge in between".
describe("the failure run is time-bounded", () => {
  const QUOTA = "You've hit your session limit · resets 8:40am (America/Bogota)";

  it("does not let failures hours apart add up to an outage", () => {
    let s = reduceFailed(IDLE_LIVENESS, QUOTA, T0);
    s = reduceFailed(s, QUOTA, T0 + FAILURE_RUN_MAX_GAP_MS + 1);
    s = reduceFailed(s, QUOTA, T0 + FAILURE_RUN_MAX_GAP_MS + 2);
    expect(s.failureRun).toBe(2);
    expect(failureOutage(s)).toBeNull();
  });

  it("still counts a real burst, where the retries are seconds apart", () => {
    let s = IDLE_LIVENESS;
    for (let i = 0; i < FAILURE_OUTAGE_RUN; i += 1) s = reduceFailed(s, QUOTA, T0 + i * 30_000);
    expect(failureOutage(s)).not.toBeNull();
  });

  it("the boundary itself starts a new run", () => {
    let s = reduceFailed(IDLE_LIVENESS, QUOTA, T0);
    s = reduceFailed(s, QUOTA, T0 + FAILURE_RUN_MAX_GAP_MS);
    expect(s.failureRun).toBe(1);
  });
});
