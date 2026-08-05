// @vitest-environment jsdom
//
// THE INK IS READ HERE, IN THE LEAF — and that is a claim about where a 1 Hz re-render is allowed to
// land, not about a colour (roborev 57889-M2).
//
// The tone used to ride down from the producer, which `ConciergeHost` calls. `useConciergeLiveness`
// keeps `now` in state and re-renders its caller once a second for the whole of every turn, and it
// subscribes to the liveness store with NO selector, so it also re-renders on every
// `noteConciergeProgress` — one per token chunk. Neither `ConciergeColumn` nor `ConciergeThread` is
// memoised, so from the host either path reconciles the entire transcript; `LivenessAnnouncer` was
// extracted for exactly this reason. So the clock is read in the smallest thing that can hold it.
//
// The two assertions that matter are therefore: the tone DOES come from the clock (or the move
// achieved nothing), and NOTHING mounts — no component, no ticker — for a bubble with no status,
// which is what almost every bubble in a thread is.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MESSAGE_STATUS_TESTID, MessageStatusLive } from "./MessageStatus";
import {
  clearConciergeLiveness,
  noteConciergeSent,
  noteConciergeSettled,
} from "../../services/conciergeLiveness";

beforeEach(() => clearConciergeLiveness());
afterEach(() => cleanup());

function node(): HTMLElement | null {
  return screen.queryByTestId(MESSAGE_STATUS_TESTID);
}

describe("MessageStatusLive — the tone comes from the clock, not from the producer", () => {
  it("renders the producer's phrase with the ink the liveness ladder is currently on", () => {
    // A send 45s ago is past SLOW_AFTER_MS and short of STALLED_AFTER_MS — the amber rung, and a
    // rung nothing in the props could have supplied, since the props carry only the phrase.
    act(() => noteConciergeSent(Date.now() - 45_000));
    render(<MessageStatusLive status={{ text: "Checking git", live: true }} />);
    expect(node()?.textContent).toBe("Checking git");
    expect(node()?.getAttribute("data-tone")).toBe("slow");
  });

  it("moves to a DIFFERENT rung for the same phrase — the ink is never derived from the words", () => {
    // The mirror of the case above, and the reason it exists: a component that hard-coded a tone
    // (or derived one from the text) would satisfy whichever single case happened to match.
    act(() => noteConciergeSent(Date.now() - 90_000));
    render(<MessageStatusLive status={{ text: "Checking git", live: true }} />);
    expect(node()?.getAttribute("data-tone")).toBe("stalled");
  });

  it("re-inks IN PLACE when the store moves under it, without a new phrase", () => {
    act(() => noteConciergeSent(Date.now() - 45_000));
    render(<MessageStatusLive status={{ text: "Checking git", live: true }} />);
    expect(node()?.getAttribute("data-tone")).toBe("slow");
    // The turn lands: `reduceSettled` clears `silentSince`, so the clock reads `idle` — which this
    // ladder has no rung for and maps to the quiet one rather than throwing in a render path. The
    // props did NOT change, only the store did, so a component taking its tone from the props alone
    // would still be sitting on amber. That is the whole subscription, asserted through the DOM.
    act(() => noteConciergeSettled());
    expect(node()?.getAttribute("data-tone")).toBe("waiting");
    expect(node()?.textContent).toBe("Checking git");
  });
});

describe("MessageStatusLive — nothing at all without a status", () => {
  it("renders NO node, so the clock reader never mounts for a bubble that has no status", () => {
    // Both spellings of absent. The DOM assertion is the observable half; the load-bearing half is
    // that `useConciergeLiveness` is never called on this path — a hook cannot be conditional, so
    // the null check has to sit ABOVE the component that holds it, which is what this pins.
    for (const absent of [undefined, null] as const) {
      const { container, unmount } = render(<MessageStatusLive status={absent} />);
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });
});

/**
 * A STATIC LINE NEVER MOUNTS THE TICKER — the queue-depth half of the same claim.
 *
 * `MessageStatusLive`'s placement was justified on "exactly one of these exists", which was true
 * while only one bubble could ever carry a status. The turn queue broke that arithmetic: every
 * WAITING message carries one too, up to MAX_QUEUED_TURNS = 50, and routing those through the live
 * path would mount 50 tickers — each re-rendering at 1 Hz for the whole of every turn and each
 * subscribed to the liveness store with no selector, so each also waking per token chunk.
 *
 * Asserted on the INK rather than by counting renders, because the ink is the observable that a
 * mounted ticker produces: a static line must stay quiet no matter how old the running turn is,
 * while a live one moves. Driven by pushing the clock past both rungs, so a status that had wrongly
 * subscribed could not stay gray by accident.
 */
describe("MessageStatusLive — a static line is drawn once and does not age", () => {
  it("keeps a waiting line quiet while the running turn is deep into the alarm rungs", () => {
    // 90s past the send: STALLED_AFTER_MS has passed, so anything reading the clock is on sienna.
    noteConciergeSent();
    act(() => {
      clearConciergeLiveness();
      noteConciergeSent();
    });
    const stalled = Date.now() + 90_000;
    const realNow = Date.now;
    Date.now = () => stalled;
    try {
      render(<MessageStatusLive status={{ text: "3rd in line" }} />);
      // Quiet, not sienna: this message has no turn, so the running turn's age says nothing about it.
      expect(node()?.getAttribute("data-tone")).toBe("waiting");
      expect(node()?.textContent).toBe("3rd in line");
    } finally {
      Date.now = realNow;
    }
  });

  it("still lets the RUNNING line age, so the discriminator is not just switching everything off", () => {
    // The positive control for the case above — same clock, same component, `live` the only change.
    act(() => {
      clearConciergeLiveness();
      noteConciergeSent();
    });
    const stalled = Date.now() + 90_000;
    const realNow = Date.now;
    Date.now = () => stalled;
    try {
      render(<MessageStatusLive status={{ text: "Checking git", live: true }} />);
      expect(node()?.getAttribute("data-tone")).toBe("stalled");
    } finally {
      Date.now = realNow;
    }
  });
});
