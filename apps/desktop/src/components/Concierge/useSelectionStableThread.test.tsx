// @vitest-environment jsdom
//
// GUARD 4 — the transcript's STRUCTURE holds still while a selection is being dragged out.
//
// WHAT THIS IS DEFENDING, and why it needed a fourth guard. The founder reported that the start of a
// drag "often gets reset" when copying his own messages. Two guards already existed and neither
// covers it: `useCopyOnSelection` stops a mid-gesture clipboard write tearing the selection down, and
// `useAutoFollow` guard 3 stops the follow scrolling the container out from under the pointer. Both
// protect the viewport and the Selection object; neither stops the DOCUMENT reflowing.
//
// It reflows constantly. `ConciergeHost.agentToNudge` builds a fresh nudge object per feed tick and
// `engine/conciergeStreamOrder` interleaves alerts by ARRIVAL, so cards live in the middle of the
// conversation and come and go as agents enter and leave `needs_you`. A card removed between the
// reader's endpoints shifts everything below it up by a card's height while the mouse is held at a
// fixed screen position.
//
// Nearly every case below pairs "the held view still shows X" with "after release it no longer does",
// and it is that pairing that makes them non-vacuous: the first half alone would pass against a hook
// that froze the thread and never recovered — which would be a worse bug than the one being fixed.
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useSelectionStableThread } from "./useSelectionStableThread";
import type { ConciergeMessage } from "./types";

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

const you = (id: string, text: string): ConciergeMessage => ({ id, kind: "you", text });
const sparkle = (id: string, text: string): ConciergeMessage => ({ id, kind: "sparkle", text });
const nudge = (id: string, text = "A build warning needs your call."): ConciergeMessage => ({
  id,
  kind: "nudge",
  band: "needs_you",
  projectName: "sparkle-desktop",
  agentName: "OG Image Pipeline",
  text,
  actions: [],
});

/** Renders the hook's output as `id:text` lines inside the container the hook watches. The sibling
 *  OUTSIDE it exists for the "selection elsewhere in the app" case. */
function Harness({ messages }: { messages: ConciergeMessage[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const out = useSelectionStableThread(messages, ref);
  return (
    <div>
      <div data-testid="thread" ref={ref}>
        {out.map((m) => (
          <p key={m.id}>{`${m.id}:${"text" in m ? m.text : ""}`}</p>
        ))}
      </div>
      <div data-testid="elsewhere">a terminal, or another column</div>
    </div>
  );
}

const threadEl = () => screen.getByTestId("thread");
const shown = () =>
  Array.from(threadEl().querySelectorAll("p"))
    .map((p) => p.textContent)
    .join("|");

/** Highlight everything inside `el`, the way a drag across it leaves the selection.
 *
 *  It dispatches `selectionchange` by hand because jsdom does not: a real browser fires it whenever
 *  the selection moves, and the hook uses that event to tell a selection THIS gesture is making from
 *  one left lying in the transcript by an earlier copy. Without the dispatch the tests would be
 *  exercising a state the app never reaches. */
function selectContentsOf(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  if (!sel) throw new Error("jsdom has no Selection");
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

/** Collapse the selection, as dragging back through the anchor does. */
function collapseSelection(): void {
  window.getSelection()?.removeAllRanges();
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

/** Press somewhere. `target` matters: a press INSIDE the thread arms the hold on its own. */
function pressOn(target: HTMLElement | Document = document, button = 0): void {
  act(() => {
    const e = new MouseEvent("mousedown", { button, bubbles: true });
    (target as EventTarget).dispatchEvent(e);
  });
}

/** A real gesture: press inside the thread, then drag out a selection across it. */
function beginDrag(): void {
  pressOn(threadEl());
  selectContentsOf(threadEl());
}

function releaseMouse(): void {
  act(() => {
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
  });
}

describe("useSelectionStableThread", () => {
  it("hands back the SAME array at rest — it is not a throttle", () => {
    // The hook must be invisible when no gesture is in flight. Asserted by identity rather than by
    // content: returning an equal-but-fresh array every tick would be a silent regression for the
    // memoised rows downstream.
    let seen: ConciergeMessage[] | null = null;
    const messages = [you("u1", "mine"), sparkle("s1", "reply")];
    function Probe() {
      const ref = useRef<HTMLDivElement | null>(null);
      seen = useSelectionStableThread(messages, ref);
      return null;
    }
    render(<Probe />);
    expect(seen).toBe(messages);
  });

  it("keeps a card that vanishes mid-drag, and drops it on release", () => {
    // THE CASE THE FOUNDER HIT. An agent leaves `needs_you` while he is dragging across the two
    // messages either side of its card.
    const { rerender } = render(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    beginDrag();

    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toBe("u1:mine|n1:A build warning needs your call.|s1:reply");

    releaseMouse();
    // CAUGHT UP. Without this half, a hook that simply froze forever would pass the line above.
    expect(shown()).toBe("u1:mine|s1:reply");
  });

  it("withholds a card that ARRIVES mid-drag, and shows it on release", () => {
    const { rerender } = render(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    beginDrag();

    rerender(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    expect(shown()).toBe("u1:mine|s1:reply");

    releaseMouse();
    expect(shown()).toBe("u1:mine|n1:A build warning needs your call.|s1:reply");
  });

  it("holds the ORDER, not just the membership", () => {
    // `orderByArrival` re-slots an id absent for longer than its window, which MOVES the DOM node — a
    // move reflows exactly like an insertion, so a membership-only hold would be half a fix.
    const { rerender } = render(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    beginDrag();

    rerender(<Harness messages={[nudge("n1"), you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toBe("u1:mine|n1:A build warning needs your call.|s1:reply");

    releaseMouse();
    expect(shown()).toBe("n1:A build warning needs your call.|u1:mine|s1:reply");
  });

  // ── REFRESHING: `sparkle` only (roborev 57320-M2) ────────────────────────────────────────────────
  it("still lets a streaming reply grow while the structure is held", () => {
    // The freeze is STRUCTURAL. Freezing the words too would make the column look dead for the length
    // of every gesture, and the streaming bubble is the one entry that legitimately changes.
    const { rerender } = render(<Harness messages={[you("u1", "mine"), sparkle("s1", "a")]} />);
    beginDrag();

    rerender(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "abcd")]} />);
    // The withheld card is absent (structure held) but the reply's new text is through (content live).
    expect(shown()).toBe("u1:mine|s1:abcd");
  });

  it("HOLDS a nudge whose status changes IN PLACE — it can change height", () => {
    // The first version refreshed every still-present id, justified as "text inside a node moves
    // nothing above it". That is wrong in the direction that matters: the pointer sits at the FOCUS
    // end, usually BELOW the anchor, so an entry earlier in the thread that changes height pushes the
    // text under the pointer. `agentToNudge` rebuilds `text` from `a.statusLabel` every tick and
    // `actionsFor` can add a whole "Approve" row, so this is the ordinary case, not a corner one.
    const { rerender } = render(<Harness messages={[nudge("n1", "Working"), you("u1", "mine")]} />);
    beginDrag();

    rerender(<Harness messages={[nudge("n1", "Needs you — approval required"), you("u1", "mine")]} />);
    expect(shown()).toBe("n1:Working|u1:mine");

    releaseMouse();
    expect(shown()).toBe("n1:Needs you — approval required|u1:mine");
  });

  // ── WHAT ARMS THE HOLD (roborev 57320-M2, 57339-M2/M3) ───────────────────────────────────────────
  it("holds from the PRESS, before any selection has formed", () => {
    // THE WINDOW THE FOUNDER'S SYMPTOM LIVES IN (roborev 57339-M3). Arming only once a non-collapsed
    // selection exists leaves the gap between the press and the first extension unguarded — a tick
    // there moves the card above the press point, and the drag that follows extends from an anchor
    // no longer where he pressed. A press inside the thread is enough on its own.
    const { rerender } = render(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    pressOn(threadEl()); // no selection yet — the drag has not moved

    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toBe("u1:mine|n1:A build warning needs your call.|s1:reply");

    releaseMouse();
    expect(shown()).toBe("u1:mine|s1:reply");
  });

  it("does NOT hold for a press-and-hold outside the thread that makes no selection", () => {
    // A `ColumnPullTab` resize, a scrollbar drag: the button is down for as long as the user drags,
    // and none of it is a transcript selection. Holding through those would delay the app's ALERTING
    // surface for a gesture that could never have been this column's.
    const { rerender } = render(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    pressOn(screen.getByTestId("elsewhere"));

    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toBe("u1:mine|s1:reply");
  });

  it("does NOT hold for a selection made somewhere else in the app", () => {
    // A terminal drag in column two is a real selection under a held button — just not one in here.
    const { rerender } = render(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    pressOn(screen.getByTestId("elsewhere"));
    selectContentsOf(screen.getByTestId("elsewhere"));

    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toBe("u1:mine|s1:reply");
  });

  it("does NOT hold for a press elsewhere while a STALE highlight sits in the thread", () => {
    // roborev 57339-M2. A highlight left in the transcript is the RESTING STATE of this column —
    // copy-on-selection is built around leaving one there — and a handler that calls
    // `preventDefault()` on mousedown (ColumnPullTab does) never collapses it. Asking only "is there
    // a selection in the thread right now" therefore re-armed the hold for the whole of that
    // unrelated gesture, which is the very failure the selection-arming was meant to close.
    const { rerender } = render(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    beginDrag();
    releaseMouse();
    // The highlight is still standing, exactly as a real copy leaves it.
    expect(window.getSelection()?.isCollapsed).toBe(false);

    // Now an unrelated press-and-hold elsewhere, which does not disturb that selection.
    pressOn(screen.getByTestId("elsewhere"));
    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);

    expect(shown()).toBe("u1:mine|s1:reply");
  });

  it("DOES hold a drag that starts outside and reaches in — the compose-box case", () => {
    // The mirror of the case above, and why the rule is not simply "the press was inside". Selecting
    // up from the compose box into the transcript is a gesture `useCopyOnSelection` documents; it
    // arms here because THIS gesture moved the selection and it reaches the thread.
    const { rerender } = render(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    pressOn(screen.getByTestId("elsewhere"));
    selectContentsOf(threadEl());

    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toBe("u1:mine|n1:A build warning needs your call.|s1:reply");

    releaseMouse();
    expect(shown()).toBe("u1:mine|s1:reply");
  });

  it("does not JUMP BACK when a selection collapses and re-expands mid-gesture", () => {
    // roborev 57339-M1. Dragging back through the anchor collapses the selection for a moment. The
    // snapshot used to survive that, so re-expanding restored the OLD structure — re-inserting cards
    // that had just gone and dropping ones that had just arrived, under a held pointer. Exercised on
    // the press-outside path, which is the one that can un-hold mid-gesture.
    const { rerender } = render(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    pressOn(screen.getByTestId("elsewhere"));
    selectContentsOf(threadEl());
    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toContain("n1");

    // The drag passes back through its own anchor: no selection, so nothing is held and the live
    // list renders.
    collapseSelection();
    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toBe("u1:mine|s1:reply");

    // ...and it re-expands. The new snapshot must be taken from what is on screen NOW, not from the
    // structure two ticks ago.
    selectContentsOf(threadEl());
    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toBe("u1:mine|s1:reply");
  });

  it("does NOT hold for a right-click", () => {
    const { rerender } = render(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    pressOn(threadEl(), 2);
    selectContentsOf(threadEl());

    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toBe("u1:mine|s1:reply");
  });

  // ── RELEASING: the ways a `mouseup` never arrives (roborev 57320-H1) ─────────────────────────────
  it("releases on dragstart — a native HTML5 drag never sends mouseup", () => {
    // AgentSidebar marks its agent cards `draggable`. That gesture opens with a primary mousedown,
    // and once the browser enters a drag it stops dispatching mousemove/mouseup entirely, ending in
    // dragend. Without this the transcript freezes for the rest of the session.
    const { rerender } = render(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    beginDrag();
    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toContain("n1");

    act(() => {
      document.dispatchEvent(new Event("dragstart", { bubbles: true }));
    });
    expect(shown()).toBe("u1:mine|s1:reply");
  });

  it("releases on a move with no button held — the catch-all for a swallowed release", () => {
    const { rerender } = render(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    beginDrag();
    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toContain("n1");

    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { buttons: 0, bubbles: true }));
    });
    expect(shown()).toBe("u1:mine|s1:reply");
  });

  it("releases when the window loses focus", () => {
    const { rerender } = render(<Harness messages={[you("u1", "mine"), nudge("n1"), sparkle("s1", "reply")]} />);
    beginDrag();
    rerender(<Harness messages={[you("u1", "mine"), sparkle("s1", "reply")]} />);
    expect(shown()).toContain("n1");

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(shown()).toBe("u1:mine|s1:reply");
  });

  it("survives a gesture in which nothing changed, and still holds the NEXT one", () => {
    // Press and release with no feed tick in between — the ordinary click. Nothing may be held, and
    // the flags must be left reset rather than latched.
    const messages = [you("u1", "mine"), sparkle("s1", "reply")];
    const { rerender } = render(<Harness messages={messages} />);
    beginDrag();
    rerender(<Harness messages={messages} />);
    expect(shown()).toBe("u1:mine|s1:reply");
    releaseMouse();
    expect(shown()).toBe("u1:mine|s1:reply");

    beginDrag();
    rerender(<Harness messages={[you("u1", "mine")]} />);
    expect(shown()).toBe("u1:mine|s1:reply");
    releaseMouse();
    expect(shown()).toBe("u1:mine");
  });
});
