// The turn queue's policy. Every case here is about the ONE property the feature exists for:
// a second send must not destroy the answer to the first.
import { describe, expect, it } from "vitest";

import {
  clearQueue,
  EMPTY_TURN_QUEUE,
  enqueue,
  isIdle,
  MAX_QUEUED_TURNS,
  statusOf,
  turnFinished,
  waitingCount,
} from "./conciergeTurnQueue";

const msg = (n: number) => ({ bubbleId: `u${n}`, text: `question ${n}` });

describe("enqueue", () => {
  it("dispatches immediately when nothing is running", () => {
    const r = enqueue(EMPTY_TURN_QUEUE, msg(1));
    expect(r.dispatch).toEqual(msg(1));
    expect(r.next.running).toEqual(msg(1));
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
    expect(second.next.running).toEqual(msg(1));
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
    expect(a.dispatch).toEqual(msg(2));
    expect(a.next.running).toEqual(msg(2));

    const b = turnFinished(a.next);
    expect(b.dispatch).toEqual(msg(3));
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
    expect(turnFinished(s).dispatch).toEqual(msg(2));
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
