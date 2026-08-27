// @vitest-environment jsdom
//
// HOW MANY 1 Hz TICKERS A THREAD MOUNTS — the number, asserted, rather than a sentence in a header.
//
// `MessageStatus`'s header justifies reading the clock in a leaf with a COUNT INVARIANT: only a
// `live` status mounts `LiveMessageStatus`, and `useConciergeLiveness` re-renders its caller once a
// second for the whole of every turn AND on every `noteConciergeProgress` — one per token chunk,
// with no selector. So each extra `live: true` is a whole extra ticker, for the duration of the
// turn.
//
// THAT INVARIANT HAS ALREADY BEEN MULTIPLIED ONCE, SILENTLY (bead sparkle-vfqhm). The placement was
// argued when exactly one bubble could ever carry a status; the turn queue then gave every WAITING
// message a status too, up to MAX_QUEUED_TURNS = 50 of them. The `live` discriminator is what keeps
// those 50 static — but nothing asserted it, and a later feature that changes the count does not
// think to re-read a justification written in a docstring. A comment cannot fail.
//
// So this file counts. It is deliberately about ARITHMETIC, not about wording or ink: those are
// covered by conciergeMessageStatuses.test.ts and MessageStatusLive.test.tsx. If someone routes
// waiters through the live path, or attaches the live line to a message outside the running run,
// the numbers here move and this goes red.
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import { useConciergeMessageStatuses } from "./conciergeMessageStatuses";
import {
  _resetConciergeActivityForTests,
  noteConciergeNativeToolCall,
  useConciergeActivityStore,
} from "./conciergeActivity";
import { clearConciergeLiveness, noteConciergeSent } from "./conciergeLiveness";
import { useProjectStore } from "../stores/projectStore";
import {
  enqueue,
  EMPTY_TURN_QUEUE,
  MAX_QUEUED_TURNS,
  turnFinished,
  type TurnQueueState,
} from "../engine/conciergeTurnQueue";

const TURN_T0 = 1_700_000_000_000;
const seqNow = () => useConciergeActivityStore.getState().latest?.seq ?? -1;

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  _resetConciergeActivityForTests();
  clearConciergeLiveness();
});

/** How many of these statuses would mount a clock reader, and how many are drawn once and left. */
function tickers(map: Record<string, { live?: boolean }>): { live: number; static_: number } {
  const values = Object.values(map);
  const live = values.filter((s) => s.live === true).length;
  return { live, static_: values.length - live };
}

/** `n` messages queued behind the one already running, oldest first. */
function withWaiters(n: number): TurnQueueState {
  let q = enqueue(EMPTY_TURN_QUEUE, { bubbleId: "run", text: "running", enqueuedAt: TURN_T0 }).next;
  for (let i = 0; i < n; i++) {
    q = enqueue(q, { bubbleId: `w${i}`, text: `msg ${i}`, enqueuedAt: TURN_T0 }).next;
  }
  return q;
}

describe("the number of 1 Hz tickers a thread mounts", () => {
  it("stays at ONE with the queue full to MAX_QUEUED_TURNS — the waiters are static", () => {
    // The worst case the queue can reach. Every one of these messages carries a status, so a
    // producer that marked them `live` would mount MAX_QUEUED_TURNS + 1 tickers — the exact cost
    // the leaf placement was chosen to avoid, and the regression this file exists to catch.
    const floor = seqNow();
    noteConciergeSent();
    noteConciergeNativeToolCall("Grep", '{"pattern":"x"}');
    const q = withWaiters(MAX_QUEUED_TURNS);

    const { result } = renderHook(() => useConciergeMessageStatuses("run", true, floor, q));
    const { live, static_ } = tickers(result.current);

    // Every waiter got a line — otherwise "they are all static" would be satisfied by a producer
    // that simply said nothing about them, which is a different (and also wrong) implementation.
    expect(static_).toBe(MAX_QUEUED_TURNS);
    expect(live).toBe(1);
  });

  it("mounts one per message of an ABSORBED RUN, and that is the whole live set", () => {
    // The bound is NOT "one", and the header used to say it was. A turn can answer a run of several
    // messages and every one of them carries the same live line, so the true cost is the run's
    // length. Pinned as an equality against the run the reducer actually produced, so a feature
    // that widens what a run absorbs shows up here as a number instead of as a silent 1 Hz cost.
    const floor = seqNow();
    noteConciergeSent();
    noteConciergeNativeToolCall("Grep", '{"pattern":"x"}');
    let q = enqueue(EMPTY_TURN_QUEUE, { bubbleId: "run", text: "running", enqueuedAt: TURN_T0 }).next;
    for (const id of ["a", "b", "c", "d"]) {
      q = enqueue(q, { bubbleId: id, text: `msg ${id}`, enqueuedAt: TURN_T0 }).next;
    }
    // The judge declines `msg d`, so it stays in `waiting` and is NOT part of the run — the control
    // that separates "live on the run" from "live on everything".
    const drained = turnFinished(q, (_run, next) => next !== "msg d").next;
    const runLength = drained.running?.entries.length ?? 0;
    expect(runLength).toBe(3);

    const { result } = renderHook(() => useConciergeMessageStatuses("a", true, floor, drained));
    const { live, static_ } = tickers(result.current);

    expect(live).toBe(runLength);
    expect(static_).toBe(1); // `d`, still in line
  });

  it("mounts NONE when no turn is being awaited, however deep the queue is", () => {
    // A queue with nothing running is the cheap state and must stay cheap: no clock is moving, so
    // no bubble may hold a clock reader.
    const floor = seqNow();
    noteConciergeNativeToolCall("Grep", '{"pattern":"x"}');
    const q = withWaiters(MAX_QUEUED_TURNS);

    const { result } = renderHook(() => useConciergeMessageStatuses(null, true, floor, q));
    const { live, static_ } = tickers(result.current);

    expect(live).toBe(0);
    expect(static_).toBe(MAX_QUEUED_TURNS);
  });
});
