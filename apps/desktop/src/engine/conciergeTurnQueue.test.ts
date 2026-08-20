// The turn queue's policy. Every case here is about the ONE property the feature exists for:
// a second send must not destroy the answer to the first.
import { describe, expect, it } from "vitest";

import {
  clearQueue,
  EMPTY_TURN_QUEUE,
  enqueue,
  isIdle,
  MAX_QUEUED_TURNS,
  mergeIntoRunning,
  statusOf,
  turnFinished,
  waitingCount,
} from "./conciergeTurnQueue";
import { MAX_ABSORBED_RUN, MAX_RUN_CHARS } from "./conciergeRelatedness";

/**
 * `enqueuedAt` RISES WITH `n`, so send order and clock order agree. Several assertions here turn on
 * which entry is the OLDEST — the cap evicts from the front, `turnFinished` shifts from the front,
 * and `queueDepthOf` reads `waiting[0].enqueuedAt` as the queue's age — and a constant timestamp
 * would make all of those pass whatever order the array was actually in.
 */
const msg = (n: number) => ({
  bubbleId: `u${n}`,
  text: `question ${n}`,
  enqueuedAt: 1_700_000_000_000 + n * 1_000,
});

describe("enqueue", () => {
  it("dispatches immediately when nothing is running", () => {
    const r = enqueue(EMPTY_TURN_QUEUE, msg(1));
    // A run of ONE — the ordinary send. `entries` rather than a bare entry since a turn can now
    // answer several messages; see RunningRun.
    expect(r.dispatch?.entries).toEqual([msg(1)]);
    expect(r.next.running?.entries).toEqual([msg(1)]);
    expect(r.next.waiting).toEqual([]);
  });

  /**
   * THE DEFECT, INVERTED. This is the assertion the whole module exists for: a send arriving while
   * a turn is in flight must NOT be dispatched — dispatching is what kills the running child in
   * `concierge.rs` and destroys the answer the user is waiting on (149 of 378 turns on 2026-07-29).
   *
   * Asserted on `dispatch` being null, which is the thing the host acts on. A test that only
   * checked `waiting.length` would pass against an implementation that queued AND dispatched.
   */
  it("does NOT dispatch a send that arrives while a turn is running", () => {
    const first = enqueue(EMPTY_TURN_QUEUE, msg(1));
    const second = enqueue(first.next, msg(2));
    expect(second.dispatch).toBeNull();
    // …and the running turn is untouched — it is still the one being answered.
    expect(second.next.running?.entries).toEqual([msg(1)]);
    expect(second.next.waiting).toEqual([msg(2)]);
  });

  it("keeps several waiters in the order they were sent", () => {
    let s = enqueue(EMPTY_TURN_QUEUE, msg(1)).next;
    for (const n of [2, 3, 4]) s = enqueue(s, msg(n)).next;
    expect(s.waiting.map((q) => q.bubbleId)).toEqual(["u2", "u3", "u4"]);
    expect(waitingCount(s)).toBe(3);
  });

  // The founder's own number — "maybe 20 messages" — must not be near the cap.
  it("holds twenty queued messages without dropping any", () => {
    let s = enqueue(EMPTY_TURN_QUEUE, msg(0)).next;
    for (let n = 1; n <= 20; n += 1) {
      const r = enqueue(s, msg(n));
      expect(r.dropped).toBeNull();
      s = r.next;
    }
    expect(waitingCount(s)).toBe(20);
  });

  /**
   * At the cap the OLDEST waiter goes, never the newest. Dropping the newest would discard the
   * message the user is still looking at in order to keep one they have moved on from.
   */
  it("drops the OLDEST waiter at the cap, and never the message just typed", () => {
    let s = enqueue(EMPTY_TURN_QUEUE, msg(0)).next;
    for (let n = 1; n <= MAX_QUEUED_TURNS; n += 1) s = enqueue(s, msg(n)).next;
    expect(waitingCount(s)).toBe(MAX_QUEUED_TURNS);

    const over = enqueue(s, msg(999));
    expect(over.dropped).toEqual(msg(1)); // the oldest waiter
    expect(over.next.waiting.at(-1)).toEqual(msg(999)); // the newest survives
    expect(waitingCount(over.next)).toBe(MAX_QUEUED_TURNS);
  });
});

describe("turnFinished", () => {
  it("dispatches the next waiter, in order", () => {
    let s = enqueue(EMPTY_TURN_QUEUE, msg(1)).next;
    s = enqueue(s, msg(2)).next;
    s = enqueue(s, msg(3)).next;

    const a = turnFinished(s);
    expect(a.dispatch?.entries).toEqual([msg(2)]);
    expect(a.next.running?.entries).toEqual([msg(2)]);

    const b = turnFinished(a.next);
    expect(b.dispatch?.entries).toEqual([msg(3)]);
  });

  it("goes idle when the last turn finishes with nothing waiting", () => {
    const s = enqueue(EMPTY_TURN_QUEUE, msg(1)).next;
    const done = turnFinished(s);
    expect(done.dispatch).toBeNull();
    expect(isIdle(done.next)).toBe(true);
  });

  /**
   * A FAILED turn must drain exactly like a successful one. The reducer is not told which happened,
   * and that is the point: if failure did not drain, a single quota rejection would strand every
   * question behind it — turning the 2026-07-29 burst (failures, each followed by a re-send) into a
   * permanent stall instead of a recoverable one.
   */
  it("drains the queue whatever ended the turn — this reducer is not told success from failure", () => {
    let s = enqueue(EMPTY_TURN_QUEUE, msg(1)).next;
    s = enqueue(s, msg(2)).next;
    // There is only one way to report an ending, so a failing turn cannot take a different path.
    expect(turnFinished(s).dispatch?.entries).toEqual([msg(2)]);
  });

  it("is safe to call when nothing is running", () => {
    const r = turnFinished(EMPTY_TURN_QUEUE);
    expect(r.dispatch).toBeNull();
    expect(isIdle(r.next)).toBe(true);
  });
});

describe("statusOf", () => {
  it("names the message being worked on, and the ones waiting", () => {
    let s = enqueue(EMPTY_TURN_QUEUE, msg(1)).next;
    s = enqueue(s, msg(2)).next;
    s = enqueue(s, msg(3)).next;
    expect(statusOf(s, "u1")).toBe("working");
    expect(statusOf(s, "u2")).toBe("waiting");
    expect(statusOf(s, "u3")).toBe("waiting");
  });

  // NO CLAIM about a message this queue is not tracking — it renders as nothing, which is the true
  // statement. Every older message in a long thread is in exactly this state.
  it("says nothing about a message it is not tracking", () => {
    const s = enqueue(EMPTY_TURN_QUEUE, msg(1)).next;
    expect(statusOf(s, "some-older-message")).toBeNull();
    expect(statusOf(EMPTY_TURN_QUEUE, "u1")).toBeNull();
  });

  it("moves the working marker to the next message when a turn finishes", () => {
    let s = enqueue(EMPTY_TURN_QUEUE, msg(1)).next;
    s = enqueue(s, msg(2)).next;
    s = turnFinished(s).next;
    expect(statusOf(s, "u1")).toBeNull(); // answered — no longer this queue's business
    expect(statusOf(s, "u2")).toBe("working");
  });
});

describe("clearQueue", () => {
  /**
   * A reset must NOT dispatch. Draining into a fresh turn after the conversation was discarded
   * would resurrect a question the user just threw away — which is why this is a separate entry
   * point from `turnFinished` rather than a flag on it.
   */
  it("discards everything and starts nothing", () => {
    let s = enqueue(EMPTY_TURN_QUEUE, msg(1)).next;
    s = enqueue(s, msg(2)).next;
    // The PRECONDITION, asserted — without it this case proves nothing, since `clearQueue()` takes
    // no argument and would return an empty queue however full the real one was.
    expect(isIdle(s)).toBe(false);
    expect(waitingCount(s)).toBe(1);

    const cleared = clearQueue();
    expect(isIdle(cleared)).toBe(true);
    expect(waitingCount(cleared)).toBe(0);
    // And it does NOT dispatch — that is the whole reason it is separate from `turnFinished`.
    expect(statusOf(cleared, "u1")).toBeNull();
    expect(statusOf(cleared, "u2")).toBeNull();
  });
});

// ══ ABSORBING A RUN (bead sparkle-agx4d8) ═══════════════════════════════════════════════════════
//
// THE DEFECT, in the founder's words: *"I often will send a message right after the one that I just
// sent that has more context… so you basically keep reading the following messages until you get to
// one that you determine is substantially different. And then and only then you respond."*
//
// The three properties below are the ones he named as the acceptance criteria for this work: the
// walk TERMINATES, it RESPECTS ITS BOUND, and when the judge FAILS it ABSORBS rather than splits —
// because splitting is the behaviour being complained about, so it must not also be the failure
// mode. Each is asserted on the SIDE EFFECT (what the reducer dispatched and what it left queued),
// never on a precondition.
describe("turnFinished — absorbing the related run", () => {
  const allRelated = () => true;
  const allDifferent = () => false;

  /** A state with `head` running and `n` messages queued behind it. */
  const queued = (n: number) => {
    let s = enqueue(EMPTY_TURN_QUEUE, msg(0)).next;
    for (let i = 1; i <= n; i++) s = enqueue(s, msg(i)).next;
    return s;
  };

  it("defaults to today's behaviour — one message per turn — when no judge is given", () => {
    // The default matters: every existing caller and test passes no judge, and they must keep
    // meaning what they meant. A default of "absorb" would silently rewrite them all.
    const r = turnFinished(queued(3));
    expect(r.dispatch?.entries.map((q) => q.bubbleId)).toEqual(["u1"]);
    expect(r.next.waiting.map((q) => q.bubbleId)).toEqual(["u2", "u3"]);
  });

  it("absorbs the whole related run into ONE turn, and answers them together", () => {
    const r = turnFinished(queued(3), allRelated);
    // The point of the feature: one dispatch carrying every message, not three dispatches.
    expect(r.dispatch?.entries.map((q) => q.text)).toEqual([
      "question 1",
      "question 2",
      "question 3",
    ]);
    expect(r.next.waiting).toEqual([]);
  });

  it("stops at the first substantially-different message and LEAVES IT QUEUED", () => {
    // "until you get to one that you determine is substantially different" — and nothing is lost:
    // the refused message heads the next turn rather than being dropped.
    const stopAtThird = (_run: readonly string[], next: string) => next !== "question 3";
    const r = turnFinished(queued(4), stopAtThird);
    expect(r.dispatch?.entries.map((q) => q.bubbleId)).toEqual(["u1", "u2"]);
    expect(r.next.waiting.map((q) => q.bubbleId)).toEqual(["u3", "u4"]);
  });

  it("TERMINATES even when the judge calls everything related", () => {
    // The termination guarantee is the BOUNDS', not the judge's. 200 waiters and a judge that never
    // says stop: this must still return, and must still leave the queue strictly smaller.
    const s = queued(200);
    const before = s.waiting.length;
    const r = turnFinished(s, allRelated);
    expect(r.dispatch?.entries.length).toBe(MAX_ABSORBED_RUN);
    expect(r.next.waiting.length).toBe(before - MAX_ABSORBED_RUN);
    expect(r.next.waiting.length).toBeLessThan(before);
  });

  it("RESPECTS ITS BOUND — 20 waiting messages become one run of 8, and 12 stay queued", () => {
    // `queued(20)`'s FIRST message is the turn that just finished, so the 20 candidates are the
    // waiters behind it.
    const r = turnFinished(queued(20), allRelated);
    expect(r.dispatch?.entries.length).toBe(MAX_ABSORBED_RUN);
    expect(r.next.waiting.length).toBe(20 - MAX_ABSORBED_RUN);
    // NOTHING IS LOST is the module's standing promise: every one of the 20 is still accounted for,
    // either answered by this turn or waiting for the next.
    expect(r.dispatch!.entries.length + r.next.waiting.length).toBe(20);
  });

  it("stops on MAX_RUN_CHARS before it stops on the message count", () => {
    const fat = (n: number) => ({
      bubbleId: `f${n}`,
      text: "x".repeat(MAX_RUN_CHARS / 3),
      enqueuedAt: 1_700_000_000_000 + n * 1_000,
    });
    let s = enqueue(EMPTY_TURN_QUEUE, fat(0)).next;
    for (let i = 1; i <= 6; i++) s = enqueue(s, fat(i)).next;
    const r = turnFinished(s, allRelated);
    // Three of these exceed the budget, so the run holds fewer than the message cap would allow.
    expect(r.dispatch!.entries.length).toBeLessThan(MAX_ABSORBED_RUN);
    const chars = r.dispatch!.entries.reduce((n, q) => n + q.text.length, 0);
    expect(chars).toBeLessThanOrEqual(MAX_RUN_CHARS);
    expect(r.next.waiting.length).toBeGreaterThan(0);
  });

  it("ABSORBS, NEVER SPLITS, WHEN THE JUDGE THROWS", () => {
    // The founder's explicit requirement. A throwing judge must not (a) take the send down, or
    // (b) fall back to one-message-per-turn — (b) IS the defect. This assertion fails if the catch
    // returns false, which is the whole point of writing it against the dispatched run rather than
    // against "the catch ran".
    const boom = () => {
      throw new Error("judge exploded");
    };
    const r = turnFinished(queued(3), boom);
    expect(r.dispatch?.entries.map((q) => q.bubbleId)).toEqual(["u1", "u2", "u3"]);
    expect(r.next.waiting).toEqual([]);
  });

  it("reports EVERY message in the run as working, not just its head", () => {
    // Otherwise the founder's follow-up renders "2nd in line" while the turn he is watching is
    // already answering it.
    const r = turnFinished(queued(3), allRelated);
    expect(statusOf(r.next, "u1")).toBe("working");
    expect(statusOf(r.next, "u2")).toBe("working");
    expect(statusOf(r.next, "u3")).toBe("working");
    expect(statusOf(r.next, "nope")).toBeNull();
  });

  it("a run of one behaves exactly as a single send always has", () => {
    const r = turnFinished(queued(1), allDifferent);
    expect(r.dispatch?.entries.length).toBe(1);
    expect(statusOf(r.next, "u1")).toBe("working");
  });
});

describe("mergeIntoRunning — folding a follow-on into a turn already in flight", () => {
  it("merges the follow-on into the running run and names the turn to supersede", () => {
    const s = enqueue(EMPTY_TURN_QUEUE, msg(1)).next;
    const before = s.running;
    const r = mergeIntoRunning(s, msg(2));
    expect(r.dispatch?.entries.map((q) => q.bubbleId)).toEqual(["u1", "u2"]);
    // The caller needs to know WHICH turn it is replacing, so it can reason about the kill.
    expect(r.superseded).toBe(before);
    expect(r.next.running?.entries.length).toBe(2);
    // The merged message is being answered now — it must never look queued.
    expect(statusOf(r.next, "u2")).toBe("working");
    expect(r.next.waiting).toEqual([]);
  });

  it("REFUSES rather than losing the send when the run is already at its bound", () => {
    let s = enqueue(EMPTY_TURN_QUEUE, msg(0)).next;
    for (let i = 1; i < MAX_ABSORBED_RUN; i++) s = mergeIntoRunning(s, msg(i)).next;
    expect(s.running?.entries.length).toBe(MAX_ABSORBED_RUN);
    const r = mergeIntoRunning(s, msg(99));
    // A null dispatch is the signal to fall back to the ordinary enqueue — the state is untouched,
    // so the caller can queue the message instead. A refusal that mutated state would strand it.
    expect(r.dispatch).toBeNull();
    expect(r.next).toBe(s);
  });

  it("REFUSES when the merged run would exceed MAX_RUN_CHARS", () => {
    const big = (n: number) => ({
      bubbleId: `b${n}`,
      text: "y".repeat(MAX_RUN_CHARS - 10),
      enqueuedAt: 1_700_000_000_000 + n * 1_000,
    });
    const s = enqueue(EMPTY_TURN_QUEUE, big(1)).next;
    const r = mergeIntoRunning(s, big(2));
    expect(r.dispatch).toBeNull();
    expect(r.next).toBe(s);
  });

  it("refuses when nothing is running — there is no turn to merge into", () => {
    const r = mergeIntoRunning(EMPTY_TURN_QUEUE, msg(1));
    expect(r.dispatch).toBeNull();
    expect(r.superseded).toBeNull();
  });
});
