// THE TWO PROPERTIES THIS STORE EXISTS FOR, AND NEITHER IS ABOUT ZUSTAND.
//
// It is a seam between a component that knows the queue depth and a background sweep that cannot
// reach a component. Everything worth testing is about what the sweep READS when the component is
// absent, remounting, or gone — because both failure directions are silent:
//
//   • `0` where `undefined` belongs. A sweep with no concierge mounted would read "the queue is
//     empty" and stay quiet forever about a queue it never looked at. That is the `quota-blocked`
//     defect verbatim (a per-window registry read as an app-wide fact), which is the one thing this
//     file was written not to repeat.
//   • A stale depth outliving its host. A torn-down host that does not clear leaves "6 queued" on
//     screen and in the Pusher's evidence forever, with nothing left alive to correct it.
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearConciergeQueue,
  publishConciergeQueue,
  queueDepthOf,
  useConciergeQueueStore,
} from "./conciergeQueueStore";
import { EMPTY_TURN_QUEUE, enqueue, turnFinished } from "../engine/conciergeTurnQueue";

const depth = () => useConciergeQueueStore.getState().depth;

beforeEach(() => {
  useConciergeQueueStore.getState()._resetForTests();
});

describe("`undefined` means WE DID NOT LOOK, and it is not an empty queue", () => {
  it("reads undefined before any host has published — never 0", () => {
    // The whole point. `{ waiting: 0 }` here would be a claim nobody measured, and it is the claim
    // the sweep would act on: "the concierge has nothing queued" is a reason to stay silent.
    expect(depth()).toBeUndefined();
  });

  it("reads an affirmative EMPTY once a mounted host says so", () => {
    const host = {};
    publishConciergeQueue(host, { waiting: 0, running: false, oldestAt: null });
    // Now it is a measurement: a host is mounted and the queue really is empty. Distinguishable
    // from the line above, which is the entire reason the field is three-valued.
    expect(depth()).toEqual({ waiting: 0, running: false, oldestAt: null });
  });

  it("goes BACK to undefined when the host that published it unmounts", () => {
    const host = {};
    publishConciergeQueue(host, { waiting: 6, running: true, oldestAt: null });
    clearConciergeQueue(host);
    // NOT `{ waiting: 0 }`. The host is gone, so nobody is measuring — and a sweep must be able to
    // tell that from a live host reporting an empty queue.
    expect(depth()).toBeUndefined();
  });
});

describe("the clear is identity-checked, so a remount cannot strand a false depth", () => {
  // React mounts the NEW instance before running the OLD one's cleanup — under strict mode's
  // double-invoke and on every ordinary remount. So the outgoing host's cleanup runs LAST, and an
  // unchecked clear would wipe the depth its replacement had already published.
  it("keeps the incoming host's depth when the outgoing host cleans up after it", () => {
    const outgoing = {};
    const incoming = {};
    publishConciergeQueue(outgoing, { waiting: 1, running: true, oldestAt: null });
    publishConciergeQueue(incoming, { waiting: 4, running: true, oldestAt: null });
    clearConciergeQueue(outgoing);
    expect(depth()).toEqual({ waiting: 4, running: true, oldestAt: null });
  });

  it("does NOT refuse the incoming host's publish while the outgoing one still holds the store", () => {
    // The other half of the same ordering, and the reason the WRITE is unguarded while the CLEAR is
    // checked. An ownership test on `publish` looks symmetrical and is the bug: the outgoing host
    // still owns the store when its replacement mounts, so the replacement could never publish and
    // the survivor of every remount would be the dead instance's reading.
    const outgoing = {};
    const incoming = {};
    publishConciergeQueue(outgoing, { waiting: 1, running: true, oldestAt: null });
    publishConciergeQueue(incoming, { waiting: 4, running: true, oldestAt: null });
    expect(depth()).toEqual({ waiting: 4, running: true, oldestAt: null });
  });

  it("lets the LAST host to publish clear it", () => {
    const outgoing = {};
    const incoming = {};
    publishConciergeQueue(outgoing, { waiting: 1, running: true, oldestAt: null });
    publishConciergeQueue(incoming, { waiting: 4, running: true, oldestAt: null });
    clearConciergeQueue(incoming);
    expect(depth()).toBeUndefined();
  });
});

describe("the depth is the REDUCER's answer, not a second count", () => {
  it("reports what the turn queue actually holds after a send behind a running turn", () => {
    const first = enqueue(EMPTY_TURN_QUEUE, { bubbleId: "b1", text: "one", enqueuedAt: 1_700_000_000_000 });
    const second = enqueue(first.next, { bubbleId: "b2", text: "two", enqueuedAt: 1_700_000_060_000 });
    // One running, one waiting — the state the founder is looking at when he says messages are
    // stacking up. `oldestAt` is the WAITER's stamp, not the running turn's: the running one is
    // being worked on, and its age is not what "nothing is taking my queue" is about.
    expect(queueDepthOf(second.next)).toEqual({
      waiting: 1,
      delegated: 0,
      running: true,
      oldestAt: 1_700_000_060_000,
    });
  });

  it("reports the slot as free once the running turn ends with nothing behind it", () => {
    const first = enqueue(EMPTY_TURN_QUEUE, { bubbleId: "b1", text: "one", enqueuedAt: 1_700_000_000_000 });
    expect(queueDepthOf(turnFinished(first.next).next)).toEqual({
      waiting: 0,
      delegated: 0,
      running: false,
      // NULL, NOT THE LAST STAMP WE SAW. Nothing is waiting, so there is no age to report — and a
      // stale timestamp here would age forever and make an empty queue look permanently abandoned.
      oldestAt: null,
    });
  });

  // THE AGE IS THE OLDEST WAITER'S, and this is the assertion that pins it. With a single waiter
  // every candidate derivation agrees; it takes three, added out of order relative to nothing, to
  // separate "the front of the array" from "the most recent" — and picking the wrong one makes the
  // queue look one minute old forever no matter how long the founder has actually been waiting.
  it("takes the age from the LONGEST-waiting message, not the newest", () => {
    let s = enqueue(EMPTY_TURN_QUEUE, {
      bubbleId: "running",
      text: "in flight",
      enqueuedAt: 1_700_000_000_000,
    }).next;
    for (const n of [1, 2, 3]) {
      s = enqueue(s, {
        bubbleId: `w${n}`,
        text: `waiting ${n}`,
        enqueuedAt: 1_700_000_000_000 + n * 60_000,
      }).next;
    }
    const d = queueDepthOf(s);
    expect(d.waiting).toBe(3);
    // w1's stamp — the first to start waiting, and the largest age.
    expect(d.oldestAt).toBe(1_700_000_060_000);
  });
});
