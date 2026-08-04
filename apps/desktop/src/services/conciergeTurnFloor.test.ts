// @vitest-environment jsdom
//
// THE BOUNDARY MUST MOVE ON THE SEND, NOT ON THE TYPING FLAG (roborev 57889-M1).
//
// This is the case the per-message status suite structurally cannot see: it takes `floor` as a
// parameter, so a floor that failed to move is invisible to every assertion it makes. The defect
// lived entirely in the host's wiring, and the wiring is what this file drives.
//
// The shape that produces it is the founder's ordinary habit, not a corner case: *"I usually send
// multiple messages to the Concierge"*. A send SUPERSEDES the turn in flight — `concierge.rs` kills
// the running process group — and `askSparkle` sets `typing` to `true` when it is already `true`, so
// React bails out and nothing keyed on `typing` alone re-runs. The bubble being worked on has moved;
// the boundary has not. What renders under the brand-new question is the DEAD turn's last line.
import { beforeEach, describe, expect, it } from "vitest";
import { useEffect } from "react";
import { renderHook } from "@testing-library/react";

import { useConciergeTurnFloor } from "./conciergeTurnFloor";
import {
  _resetConciergeActivityForTests,
  noteConciergeNativeToolCall,
  useConciergeActivityStore,
} from "./conciergeActivity";

const seqNow = () => useConciergeActivityStore.getState().latest?.seq ?? -1;

/** The host's two inputs, named so `rerender` is typed for a turn that ENDS (`sendSeq: 0`) as
 *  well as for one that supersedes — inferring them from `initialProps` narrows the id to a literal
 *  and makes the end-of-turn case unrepresentable. */
interface Props {
  typing: boolean;
  sendSeq: number;
}

const drive = (initialProps: Props) =>
  renderHook(({ typing, sendSeq }: Props) => useConciergeTurnFloor(typing, sendSeq), {
    initialProps,
  });

beforeEach(() => _resetConciergeActivityForTests());

describe("useConciergeTurnFloor", () => {
  // NOTE (roborev 57933-M2): there is deliberately NO "bubble-less send" case here. The hook takes
  // only a counter now, so this file cannot express the difference between a send with a bubble and
  // one without — a case claiming to would be a duplicate of the supersede case below wearing a
  // name it cannot honour, which is what was removed. What actually protects that path is the bump
  // being unconditional at the send site, and the assertion for it belongs in the host suite.
  /**
   * NO INTERMEDIATE COMMIT SHOWS THE OLD FLOOR (roborev 57914-M2).
   *
   * The floor used to be set in a passive effect while the awaited bubble moved during render, so
   * there was at least one COMMITTED render carrying the new turn's identity against the previous
   * turn's floor — the superseded turn's line attached to the message just sent. It resolved on the
   * next render, which is exactly why reading state after effects flush could not catch it.
   *
   * Asserted from an EFFECT, not from the render body. Setting state during render makes React
   * re-run the component and DISCARD the first pass, so a render-body probe sees a frame that was
   * never committed and never painted — it would fail against the correct implementation. An effect
   * runs only for renders that actually committed, which is exactly the population the finding is
   * about.
   */
  it("never renders a frame carrying the previous turn's floor", () => {
    const seen: number[] = [];
    const { rerender } = renderHook(
      ({ typing, sendSeq }: Props) => {
        const f = useConciergeTurnFloor(typing, sendSeq);
        useEffect(() => {
          seen.push(f);
        });
        return f;
      },
      { initialProps: { typing: true, sendSeq: 1 } },
    );
    noteConciergeNativeToolCall("Read", '{"file_path":"/one"}');
    const turn1Last = seqNow();
    seen.length = 0;
    rerender({ typing: true, sendSeq: 2 });
    // Every committed frame of the new turn already carries the new floor.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((f) => f >= turn1Last)).toBe(true);
  });

  /**
   * THE REGRESSION CASE. Asserted on the floor RISING ABOVE the superseded turn's last entry, which
   * is the comparison the status producer actually makes (`entry.seq > floor`) — not on the hook
   * having re-run, which a spy would report even if the returned floor never changed.
   */
  it("moves the floor when a send supersedes a turn already in flight", () => {
    const { result, rerender } = drive({ typing: true, sendSeq: 1 });
    // Turn 1 does some work. Its last entry is what must NOT be shown under the next question.
    noteConciergeNativeToolCall("Read", '{"file_path":"/one"}');
    const turn1Last = seqNow();
    expect(result.current).toBeLessThan(turn1Last);

    // The user sends again before turn 1 finished: `typing` is ALREADY true and does not change.
    rerender({ typing: true, sendSeq: 2 });
    expect(result.current).toBeGreaterThanOrEqual(turn1Last);
  });

  /**
   * ...and the new turn is not left mute. Clearing the floor is only half the job: the status
   * degrades to nothing when there is no entry above the boundary, so the boundary itself has to be
   * recorded or the bubble the user just sent shows the bare pulse until the first tool call.
   *
   * This is the half that depends on `noteConciergePhase` exempting `reading_message` from its
   * idempotence guard (roborev 57870) — `reading_message` is still `latest` here when the second
   * send arrives, so an unconditional guard would drop it and the seq would not clear the floor.
   */
  it("records the new turn's boundary ABOVE the floor it just took", () => {
    const { result, rerender } = drive({ typing: true, sendSeq: 1 });
    // Turn 1 reached NO tool and no text before the user sent again — the shape rapid re-sending
    // actually produces, and the one where `reading_message` is still the newest entry.
    const firstBoundary = seqNow();
    expect(useConciergeActivityStore.getState().latest?.op).toBe("reading_message");

    rerender({ typing: true, sendSeq: 2 });

    // A SECOND, DISTINCT boundary. Asserted on the counter advancing rather than on the op, because
    // the op is `reading_message` either way — a text assertion would pass against both the effect
    // that never re-ran and the guard that swallowed the repeat.
    expect(seqNow()).toBeGreaterThan(firstBoundary);
    expect(seqNow()).toBeGreaterThan(result.current);
  });

  // The ORDINARY turn, so the fix above cannot be a change of behaviour for the common path: both
  // inputs move together on the first send of a thread, and that is one boundary, not two.
  it("takes the boundary on an ordinary send, when both inputs change together", () => {
    noteConciergeNativeToolCall("Read", '{"file_path":"/previous-turn"}');
    const previous = seqNow();
    const { result } = drive({ typing: true, sendSeq: 1 });
    // The previous turn's last entry is AT the floor, so the producer's strict `>` filters it out.
    expect(result.current).toBe(previous);
  });

  // A commit that ends a turn changes both inputs too (`setTyping(false)` and `setAwaitingId(null)`
  // happen together), and must not open a boundary — which is why `typing` is GATED on rather than
  // merely keyed on.
  it("opens no boundary while no turn is running", () => {
    drive({ typing: false, sendSeq: 0 });
    expect(useConciergeActivityStore.getState().latest).toBeNull();
  });

  it("records nothing more when the turn ends", () => {
    const { rerender } = drive({ typing: true, sendSeq: 1 });
    const afterStart = seqNow();
    rerender({ typing: false, sendSeq: 0 });
    expect(seqNow()).toBe(afterStart);
  });
});
