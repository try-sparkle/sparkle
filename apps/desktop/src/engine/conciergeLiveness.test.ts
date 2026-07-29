// The liveness state machine. Every case is a claim about when the column may say something about
// the brain — so the boundary cases matter more than the happy path, and the ones that must NOT
// fire matter most of all.
import { describe, expect, it } from "vitest";

import {
  FAILURE_RUN_MAX_GAP_MS,
  IDLE_LIVENESS,
  OFFLINE_AFTER_MS,
  UNAVAILABLE_AFTER_MS,
  UNAVAILABLE_FAILURE_RUN,
  UNAVAILABLE_SILENT_RUN,
  elapsedLabel,
  livenessAt,
  livenessReason,
  reduceFailed,
  reduceProgress,
  reduceSent,
  reduceSettled,
  reduceTick,
  showsElapsed,
  type ConciergeLivenessState,
} from "./conciergeLiveness";

const T0 = 1_700_000_000_000;

/** Advance the clock by running the ticker, the way the store's interval does. Without this a
 *  time-based escalation would only ever be observed through `livenessAt`, and the LATCH — the
 *  thing that makes UNAVAILABLE sticky — would never be exercised. */
function tickTo(s: ConciergeLivenessState, now: number): ConciergeLivenessState {
  return reduceTick(s, now);
}

describe("livenessAt — the boundaries", () => {
  it("says idle when nothing is being awaited", () => {
    expect(livenessAt(IDLE_LIVENESS, T0)).toBe("idle");
  });

  it("says waiting right up to the offline threshold, and offline exactly on it", () => {
    const sent = reduceSent(IDLE_LIVENESS, T0);
    expect(livenessAt(sent, T0)).toBe("waiting");
    expect(livenessAt(sent, T0 + OFFLINE_AFTER_MS - 1)).toBe("waiting");
    expect(livenessAt(sent, T0 + OFFLINE_AFTER_MS)).toBe("offline");
  });

  // THE PROPERTY THAT MAKES 20s SAFE AGAINST A ~54s MEDIAN TURN. The clock measures SILENCE, not
  // elapsed time, so a turn that is streaming resets it continuously and never trips. Without this
  // the threshold would have to sit above the p90 turn duration (~120s) to avoid false alarms, by
  // which point the human has long since given up.
  it("a delta resets the clock, so a long STREAMING turn never reads offline", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = reduceProgress(s, T0 + 19_000, "text");
    expect(livenessAt(s, T0 + 25_000)).toBe("waiting");
    expect(livenessAt(s, T0 + 19_000 + OFFLINE_AFTER_MS)).toBe("offline");
  });

  it("escalates to unavailable on continuous silence", () => {
    const sent = reduceSent(IDLE_LIVENESS, T0);
    expect(livenessAt(sent, T0 + UNAVAILABLE_AFTER_MS - 1)).toBe("offline");
    expect(livenessAt(sent, T0 + UNAVAILABLE_AFTER_MS)).toBe("unavailable");
  });
});

describe("unavailable is STICKY", () => {
  // The user asked for a "stronger, stickier" state. Without the latch, the next send resets the
  // silence clock and the column would drop straight back to "waiting" — quietly downgrading a
  // brain nothing has proved is back, which is the silence this whole feature exists to end.
  it("a fresh send does not downgrade a latched unavailable", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = tickTo(s, T0 + UNAVAILABLE_AFTER_MS);
    expect(livenessAt(s, T0 + UNAVAILABLE_AFTER_MS)).toBe("unavailable");

    const resent = reduceSent(s, T0 + 100_000);
    expect(livenessAt(resent, T0 + 100_000)).toBe("unavailable");
  });

  it("only observed output clears it", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = tickTo(s, T0 + UNAVAILABLE_AFTER_MS);
    const recovered = reduceProgress(s, T0 + 100_000, "text");
    expect(livenessAt(recovered, T0 + 100_000)).toBe("waiting");
  });

  it("a completed turn clears it too", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = tickTo(s, T0 + UNAVAILABLE_AFTER_MS);
    expect(livenessAt(reduceSettled(s), T0 + 100_000)).toBe("idle");
  });

  it("the ticker returns the SAME object when nothing changed, so it can run every 500ms", () => {
    const s = reduceSent(IDLE_LIVENESS, T0);
    expect(reduceTick(s, T0 + 1_000)).toBe(s);
  });
});

describe("repeated pings with no response", () => {
  // THE 20:18-20:31 BURST, 2026-07-29: 12 of 14 turns died unanswered because each new send killed
  // the last. Every send restarts the silence clock, so continuous silence NEVER reaches 90s — the
  // time bound alone would have stayed silent through the exact incident this was built for.
  it("escalates on consecutive unanswered sends even though silence never reaches the time bound", () => {
    let s = IDLE_LIVENESS;
    let now = T0;
    for (let i = 0; i < UNAVAILABLE_SILENT_RUN; i += 1) {
      s = reduceSent(s, now);
      now += OFFLINE_AFTER_MS + 1_000; // re-sent at ~21s, the measured median
      expect(livenessAt(s, now)).not.toBe("unavailable");
    }
    s = reduceSent(s, now);
    expect(livenessAt(s, now)).toBe("unavailable");
  });

  it("a send that DID stream something is not an unanswered ping", () => {
    let s = IDLE_LIVENESS;
    let now = T0;
    for (let i = 0; i < UNAVAILABLE_SILENT_RUN + 2; i += 1) {
      s = reduceSent(s, now);
      s = reduceProgress(s, now + 1_000, "text"); // the turn answered, then the user sent again anyway
      now += OFFLINE_AFTER_MS + 1_000;
    }
    s = reduceSent(s, now);
    expect(livenessAt(s, now)).toBe("waiting");
  });

  it("a send answered INSIDE the offline window is not an unanswered ping either", () => {
    let s = IDLE_LIVENESS;
    let now = T0;
    for (let i = 0; i < UNAVAILABLE_SILENT_RUN + 2; i += 1) {
      s = reduceSent(s, now);
      now += OFFLINE_AFTER_MS - 1_000; // impatient re-send, but inside the window
    }
    expect(livenessAt(reduceSent(s, now), now)).toBe("waiting");
  });
});

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
  it("does not escalate on a single failure", () => {
    expect(livenessAt(reduceFailed(IDLE_LIVENESS, QUOTA, T0), T0)).toBe("idle");
  });

  // Every failure actually observed in a day of logs was a fast, LOUD error (3-17s), which ends the
  // wait and so accumulates no silence at all. Without this route UNAVAILABLE could essentially
  // never fire in the real world — and six consecutive spend-limit rejections is the textbook case.
  it("escalates on consecutive failures, which produce no silence whatsoever", () => {
    let s = IDLE_LIVENESS;
    for (let i = 0; i < UNAVAILABLE_FAILURE_RUN - 1; i += 1) s = reduceFailed(s, QUOTA, T0);
    expect(livenessAt(s, T0)).not.toBe("unavailable");
    s = reduceFailed(s, QUOTA, T0);
    expect(livenessAt(s, T0)).toBe("unavailable");
    // The reason survives into the sticky state — the strip states WHY, not just that.
    expect(s.failure?.evidence).toContain("resets 8:40am");
  });

  it("a success between failures breaks the run", () => {
    let s = IDLE_LIVENESS;
    s = reduceFailed(s, QUOTA, T0);
    s = reduceFailed(s, QUOTA, T0);
    s = reduceSettled(s);
    s = reduceFailed(s, QUOTA, T0);
    expect(livenessAt(s, T0)).toBe("idle");
    expect(s.failureRun).toBe(1);
  });

  // A loud failure and a silent one are different facts. Letting them add up would produce a state
  // that describes neither.
  it("an error resets the SILENT run — it is a response, just not an answer", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = reduceSent(s, T0 + OFFLINE_AFTER_MS + 1); // one unanswered ping banked
    expect(s.silentRun).toBe(1);
    expect(reduceFailed(s, QUOTA, T0).silentRun).toBe(0);
  });
});

describe("the elapsed counter", () => {
  it("stays quiet for the first few seconds, then states the time", () => {
    const s = reduceSent(IDLE_LIVENESS, T0);
    expect(showsElapsed(s, T0 + 4_999)).toBe(false);
    expect(showsElapsed(s, T0 + 5_000)).toBe(true);
  });

  it("floors the seconds so it never claims time that has not passed", () => {
    expect(elapsedLabel(12_999)).toBe("12s");
    expect(elapsedLabel(0)).toBe("0s");
    expect(elapsedLabel(64_000)).toBe("1m 04s");
    expect(elapsedLabel(600_000)).toBe("10m 00s");
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
  // terminals without speaking would be reported offline while visibly working.
  it("a tool call still resets the silence clock", () => {
    let s = reduceSent(IDLE_LIVENESS, T0);
    s = reduceProgress(s, T0 + 19_000, "tool");
    expect(livenessAt(s, T0 + 25_000)).toBe("waiting");
  });

  it("both flags reset for each new turn", () => {
    let s = reduceProgress(reduceSent(IDLE_LIVENESS, T0), T0 + 1_000, "text");
    s = reduceSent(s, T0 + 5_000);
    expect(s.sawOutput).toBe(false);
    expect(s.sawText).toBe(false);
  });
});

// ── WHY IT IS UNAVAILABLE DECIDES WHETHER THERE IS A REASON TO SHOW ─────────────────────────────
//
// roborev 55442-M4. A recorded failure OUTLIVES the sends that follow it — deliberately, because
// clearing it on send would break the consecutive-failure run (every failure is followed by another
// send). So an outage reached through SILENCE can be carrying an unrelated failure from hours
// earlier, and presenting "resets 8:40am" at 2pm as the reason the concierge is quiet now is a
// causal claim from stale evidence.
describe("livenessReason", () => {
  const QUOTA = "You've hit your session limit · resets 8:40am (America/Bogota)";

  it("is null while the concierge is not unavailable", () => {
    expect(livenessReason(IDLE_LIVENESS, T0)).toBeNull();
    expect(livenessReason(reduceSent(IDLE_LIVENESS, T0), T0)).toBeNull();
  });

  it("names the failure route when a run of errors got us here", () => {
    let s = IDLE_LIVENESS;
    for (let i = 0; i < UNAVAILABLE_FAILURE_RUN; i += 1) s = reduceFailed(s, QUOTA, T0 + i * 1_000);
    expect(livenessReason(s, T0)).toBe("failures");
  });

  // THE ROW THAT MATTERS. One old failure, then three silent sends: the strip must say "nothing came
  // back", not re-blame this morning's quota.
  it("names SILENCE when silence got us here, even with an old failure on the books", () => {
    let s = reduceFailed(IDLE_LIVENESS, QUOTA, T0);
    let now = T0;
    for (let i = 0; i <= UNAVAILABLE_SILENT_RUN; i += 1) {
      s = reduceSent(s, now);
      now += OFFLINE_AFTER_MS + 1_000;
    }
    expect(livenessAt(s, now)).toBe("unavailable");
    expect(livenessReason(s, now)).toBe("silence");
    // The failure is still ON the state — it is the last thing we know — which is exactly why the
    // reason has to be derived rather than inferred from its presence.
    expect(s.failure).not.toBeNull();
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
    expect(livenessAt(s, T0 + FAILURE_RUN_MAX_GAP_MS + 2)).not.toBe("unavailable");
  });

  it("still counts a real burst, where the retries are seconds apart", () => {
    let s = IDLE_LIVENESS;
    for (let i = 0; i < UNAVAILABLE_FAILURE_RUN; i += 1) s = reduceFailed(s, QUOTA, T0 + i * 30_000);
    expect(livenessAt(s, T0)).toBe("unavailable");
  });

  it("the boundary itself starts a new run", () => {
    let s = reduceFailed(IDLE_LIVENESS, QUOTA, T0);
    s = reduceFailed(s, QUOTA, T0 + FAILURE_RUN_MAX_GAP_MS);
    expect(s.failureRun).toBe(1);
  });
});
