// @vitest-environment jsdom
//
// WHICH MESSAGE THE STATUS IS ATTACHED TO. The interesting cases are all about NOT saying something
// — the turn floor, the absent activity, the older message — because the failure mode this surface
// invites is a confident line under the wrong question.
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useConciergeMessageStatuses } from "./conciergeMessageStatuses";
import {
  _resetConciergeActivityForTests,
  noteConciergeNativeToolCall,
  noteConciergePhase,
  useConciergeActivityStore,
} from "./conciergeActivity";
import {
  clearConciergeLiveness,
  noteConciergeProgress,
  noteConciergeSent,
} from "./conciergeLiveness";
import { useProjectStore } from "../stores/projectStore";

/** The counter as it stands now — what the host snapshots as the turn floor. */
const seqNow = () => useConciergeActivityStore.getState().latest?.seq ?? -1;

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  _resetConciergeActivityForTests();
  clearConciergeLiveness();
});

describe("useConciergeMessageStatuses", () => {
  it("attaches the live status to the message whose turn is in flight", () => {
    const floor = seqNow();
    noteConciergeSent();
    noteConciergeNativeToolCall("Grep", '{"pattern":"x"}');
    const { result } = renderHook(() => useConciergeMessageStatuses("msg-1", true, floor));
    expect(Object.keys(result.current)).toEqual(["msg-1"]);
    expect(result.current["msg-1"]!.text.length).toBeGreaterThan(0);
  });

  it("attaches nothing when no turn is being awaited", () => {
    const floor = seqNow();
    noteConciergeNativeToolCall("Grep", '{"pattern":"x"}');
    const { result } = renderHook(() => useConciergeMessageStatuses(null, true, floor));
    expect(result.current).toEqual({});
  });

  it("attaches nothing once the turn has finished", () => {
    const floor = seqNow();
    noteConciergeNativeToolCall("Grep", '{"pattern":"x"}');
    const { result } = renderHook(() => useConciergeMessageStatuses("msg-1", false, floor));
    expect(result.current).toEqual({});
  });

  /**
   * THE TURN FLOOR, and this is the case worth having. An entry recorded during the PREVIOUS turn
   * must never be rendered under a NEW question — that is not a stale pixel, it is a false
   * statement about what the concierge is doing with the message the user just sent.
   *
   * Driven by recording activity and THEN taking the floor above it, which is the real sequence:
   * the host snapshots the counter when the turn starts, so everything already recorded is below.
   */
  it("ignores activity left over from an earlier turn", () => {
    noteConciergeNativeToolCall("Read", '{"file_path":"/old"}');
    const floorForNewTurn = seqNow(); // everything so far belongs to the turn that just ended
    const { result } = renderHook(() =>
      useConciergeMessageStatuses("msg-2", true, floorForNewTurn),
    );
    expect(result.current).toEqual({});
  });

  it("shows an entry recorded AFTER the floor", () => {
    noteConciergeNativeToolCall("Read", '{"file_path":"/old"}');
    const floor = seqNow();
    noteConciergePhase("composing");
    const { result } = renderHook(() => useConciergeMessageStatuses("msg-2", true, floor));
    expect(result.current["msg-2"]?.text).toBe("Composing");
  });

  // NO ACTIVITY, NO CLAIM — the same rule the column-level indicator degrades by. A turn that is
  // thinking and has called nothing yet must not be given a manufactured status.
  it("attaches nothing when the turn has produced no activity at all", () => {
    const floor = seqNow();
    noteConciergeSent();
    const { result } = renderHook(() => useConciergeMessageStatuses("msg-1", true, floor));
    expect(result.current).toEqual({});
  });

  /**
   * A stable empty map. The map is a prop on a memoised subtree, so a fresh `{}` per render would
   * change identity every tick and defeat the row memo for every message in the thread — the
   * drag-selection stutter ConciergeMessageRow's header exists to prevent.
   */
  it("returns a stable empty map across renders, so the thread's row memo holds", () => {
    const { result, rerender } = renderHook(() => useConciergeMessageStatuses(null, true, -1));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  /**
   * IT DOES NOT SUBSCRIBE TO THE LIVENESS CLOCK (roborev 57889-M2), and that is a fact about the
   * HOST, which is what calls this hook. `useConciergeLiveness` re-renders its caller once a second
   * for the whole of every turn and reads the liveness store with no selector, so it also re-renders
   * on every `noteConciergeProgress` — one per token chunk. Neither `ConciergeColumn` nor
   * `ConciergeThread` is memoised, so either path reconciles the entire transcript from the host.
   * The ink is read in a leaf instead (`MessageStatusLive`).
   *
   * Asserted on the CALLER RE-RENDERING, which is the mechanism, and driven by a real liveness write
   * rather than by a clock: `reduceProgress` returns a fresh state object every call, so an
   * unselectored subscription re-renders on it. Checking the returned map's identity alone would be
   * weaker — `useMemo` would hold it stable across a re-render this test is trying to detect.
   */
  it("does NOT re-render its caller when only the liveness store moves", () => {
    const floor = seqNow();
    noteConciergeSent();
    noteConciergePhase("composing");
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useConciergeMessageStatuses("msg-1", true, floor);
    });
    expect(result.current["msg-1"]?.text).toBe("Composing");
    const before = renders;
    // A sign of life — in a real turn this arrives per token chunk and per tool call.
    act(() => noteConciergeProgress("tool"));
    expect(renders).toBe(before);
  });

  // The phrase, and NOTHING else. The tone used to ride along here; it is the leaf's now, and a
  // producer that grew one back would put the 1 Hz ticker in the host again.
  it("hands down the phrase alone — no tone, no clock reading", () => {
    const floor = seqNow();
    noteConciergeSent();
    noteConciergePhase("composing");
    const { result } = renderHook(() => useConciergeMessageStatuses("msg-1", true, floor));
    expect(Object.keys(result.current["msg-1"]!)).toEqual(["text"]);
  });
});
