// @vitest-environment jsdom
//
// GUARD 4, END TO END THROUGH THE REAL THREAD — the founder's "the starting point where I start my
// mouse to drag often gets reset".
//
// WHAT IS BEING PROVED, and why it is stated as a SELECTION assertion rather than a render count.
// The hook's own unit tests (./useSelectionStableThread.test.tsx) cover the holding logic. What they
// cannot show is that the thread actually routes its rendering through it — a component that called
// the hook and then went on mapping the raw prop would pass every one of them. So these cases drive
// the real `ConciergeThread`, put a real `Range` across two messages, and assert on what the
// selection still contains afterwards.
//
// The mechanism, measured before the fix: with a nudge card between the two endpoints, a feed tick
// that removed the card changed the selected text from
//   "FIRST answer textBLOCKED:@OG Image Pipelinein sparkle-desktopSECOND"
// to
//   "FIRST answer textSECOND"
// while the reader was still holding the button. Nothing moved the anchor node — the content under
// the pointer moved instead, everything below shifting up by a card's height, which is what the
// founder is describing.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConciergeThread } from "./ConciergeThread";
import { ANSWERED_MARKER_TESTID } from "./ReplyAnchorViews";
import type { ConciergeMessage } from "./types";

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

const noop = () => {};

const first: ConciergeMessage = { id: "a", kind: "sparkle", text: "FIRST answer text" };
const second: ConciergeMessage = { id: "b", kind: "sparkle", text: "SECOND answer text" };
const card: ConciergeMessage = {
  id: "n1",
  kind: "nudge",
  band: "needs_you",
  projectName: "sparkle-desktop",
  agentName: "OG Image Pipeline",
  text: "A build warning needs your call.",
  actions: [],
};

function thread(messages: ConciergeMessage[]) {
  return <ConciergeThread messages={[...messages]} onNudgeClick={noop} onNudgeAction={noop} />;
}

/** The deepest text node containing `needle` — where a real drag anchors. */
function textNodeWith(root: HTMLElement, needle: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) if (n.textContent?.includes(needle)) return n as Text;
  throw new Error(`no text node containing ${needle}`);
}

/** The thread's scroll container — the node the guards are handed. */
function scrollerEl(): HTMLElement {
  const el = document.querySelector('[data-testid="concierge-thread"]');
  if (!el) throw new Error("thread scroller not rendered");
  return el as HTMLElement;
}

/**
 * Drag from FIRST to SECOND and hold the button down. Returns the live Selection.
 *
 * The press lands INSIDE the scroller because that is what arms the hold — the guard asks whether
 * this gesture is plausibly a thread selection, not merely whether a button is down. And
 * `selectionchange` is dispatched by hand because jsdom does not fire it; a real browser does, and
 * the guard uses it to tell a selection this gesture is making from one left over from an earlier
 * copy.
 */
function dragAcross(root: HTMLElement): Selection {
  fireEvent.mouseDown(scrollerEl(), { button: 0 });
  const range = document.createRange();
  range.setStart(textNodeWith(root, "FIRST"), 0);
  range.setEnd(textNodeWith(root, "SECOND"), 6);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  return sel;
}

describe("ConciergeThread — a drag is not disturbed by the fleet moving underneath it", () => {
  it("keeps a card that vanishes mid-drag, so the selection does not change under the reader", () => {
    const { container, rerender } = render(thread([first, card, second]));
    const root = container.firstChild as HTMLElement;
    const sel = dragAcross(root);

    const selectedDuringDrag = sel.toString();
    // The card really is part of what was highlighted — asserted positively, so this case cannot
    // pass on a fixture where the endpoints happened to exclude it.
    expect(selectedDuringDrag).toContain("FIRST");
    expect(selectedDuringDrag).toContain("OG Image Pipeline");
    expect(selectedDuringDrag).toContain("SECOND");

    // THE FEED TICK: the agent left `needs_you` while the button is still down.
    rerender(thread([first, second]));

    // HELD — byte for byte what the reader had. Before guard 4 the card's words vanished from here.
    expect(sel.toString()).toBe(selectedDuringDrag);
    expect(root.textContent).toContain("OG Image Pipeline");
  });

  it("withholds a card that ARRIVES mid-drag", () => {
    // Arrival order can place a new alert BETWEEN two existing messages, so an insertion reflows the
    // column exactly like a removal — and inserts words into the middle of the highlight.
    const { container, rerender } = render(thread([first, second]));
    const root = container.firstChild as HTMLElement;
    const sel = dragAcross(root);
    const selectedDuringDrag = sel.toString();
    expect(selectedDuringDrag).not.toContain("OG Image Pipeline");

    rerender(thread([first, card, second]));

    expect(sel.toString()).toBe(selectedDuringDrag);
    expect(root.textContent).not.toContain("OG Image Pipeline");
  });

  it("catches up the moment the button is released", () => {
    // The hold is DEFERRAL, not suppression. Without this half, a hook that simply froze the thread
    // forever would satisfy both cases above — which would be a far worse bug than the one fixed.
    const { container, rerender } = render(thread([first, card, second]));
    const root = container.firstChild as HTMLElement;
    dragAcross(root);
    rerender(thread([first, second]));
    expect(root.textContent).toContain("OG Image Pipeline");

    fireEvent.mouseUp(document, { button: 0 });

    expect(root.textContent).not.toContain("OG Image Pipeline");
    expect(root.textContent).toContain("FIRST answer text");
    expect(root.textContent).toContain("SECOND answer text");
  });

  it("does not hold anything when no drag is in flight", () => {
    // Guard 4 must be invisible at rest. A thread that lagged a feed tick behind whenever nobody was
    // selecting would be a throttle, which this is explicitly not.
    const { container, rerender } = render(thread([first, card, second]));
    const root = container.firstChild as HTMLElement;
    expect(root.textContent).toContain("OG Image Pipeline");

    rerender(thread([first, second]));

    expect(root.textContent).not.toContain("OG Image Pipeline");
  });

  it("still lets a streaming reply grow while the structure is held", () => {
    // STRUCTURAL only. Text changing inside a node moves nothing above it, and freezing the words as
    // well would make the column look dead for the length of every gesture.
    const { container, rerender } = render(thread([first, card, second]));
    const root = container.firstChild as HTMLElement;
    dragAcross(root);

    rerender(thread([first, card, { ...second, text: "SECOND answer text, now much longer" }]));

    expect(root.textContent).toContain("now much longer");
    // ...and the card is still held, so the structure did not move to let the text through.
    expect(root.textContent).toContain("OG Image Pipeline");
  });
});

// ── THE AUTO-FOLLOW KEYS ARE PART OF THE WIRING (roborev 57329-M2) ────────────────────────────────
//
// `ConciergeThread` feeds `visible` to the rows AND to `useAutoFollow`'s two keys. The rows are the
// obvious half; the keys are the half that regresses silently, and nothing above could catch it —
// every case there asserts on text, so reverting the keys to the raw `messages` prop left the whole
// file green. This repo's own history is the argument for covering it: a half-wired change that
// looks right is the recurring failure.
//
// WHY THE KEYS MATTER. Guard 3 suppresses the FOLLOW during a drag but the effect still runs. With
// the raw prop, `contentKey` advances DURING the hold, so by the time the catch-up render lands on
// release the key is unchanged — the follow effect never re-runs, and everything that arrived during
// the gesture stays below the fold. `useAutoFollow`'s own `up` handler cannot rescue it: it fires
// inside the mouseup, before React flushes, so it scrolls the HELD (shorter) DOM.
//
// That last point is why the scroller's height here GROWS with its child count instead of being a
// constant. With a fixed `scrollHeight` the `up` handler lands on the same number either way and the
// mutation survives — the stub would be hiding the very difference the case exists to detect.
describe("ConciergeThread — the auto-follow keys read the HELD list, not the raw prop", () => {
  /** A scroller whose height tracks what is actually rendered, so withholding a message really does
   *  make the content shorter. 200px per child, 200px viewport. */
  function growableScroller(el: HTMLElement): void {
    Object.defineProperty(el, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(el, "scrollHeight", {
      get: () => el.childElementCount * 200,
      configurable: true,
    });
  }

  const scroller = () => document.querySelector('[data-testid="concierge-thread"]') as HTMLElement;

  /** Scroll the way a READER does — the component tracks follow-state from the event, not by
   *  re-measuring, so assigning scrollTop alone describes something no user can do. */
  function readerScrollsTo(el: HTMLElement, top: number): void {
    el.scrollTop = top;
    fireEvent.scroll(el);
  }

  /** Press INSIDE the scroller and drag out a selection over the whole thread — see `dragAcross`
   *  for why the press target and the hand-dispatched `selectionchange` both matter. */
  function dragOverThread(el: HTMLElement): void {
    fireEvent.mouseDown(el, { button: 0 });
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent(document, new Event("selectionchange"));
  }

  const answers = (n: number): ConciergeMessage[] =>
    Array.from({ length: n }, (_, i) => ({ id: `m${i}`, kind: "sparkle" as const, text: `answer ${i}` }));

  it("re-runs the follow on release, for content that arrived during the gesture (contentKey)", () => {
    const { rerender } = render(thread(answers(3)));
    const el = scroller();
    growableScroller(el);
    readerScrollsTo(el, el.scrollHeight - el.clientHeight); // pinned to the bottom: follow armed

    dragOverThread(el);
    // A reply arrives mid-drag. It is a NEW id, so guard 4 withholds it and the scroller stays short.
    rerender(thread([...answers(3), { id: "new", kind: "sparkle", text: "the new reply" }]));
    expect(el.textContent).not.toContain("the new reply");

    fireEvent.mouseUp(document, { button: 0 });

    // The catch-up render adds the message, which CHANGES contentKey — so the follow re-runs and
    // lands on the taller content. With the keys read off the raw prop the key had already advanced
    // mid-hold, the effect would not re-run, and this would sit at the pre-flush height.
    expect(el.textContent).toContain("the new reply");
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  it("does not mark a bubble ANSWERED by a reply that is still withheld", () => {
    // THE MERGE SEAM. The answered-marker feature and guard 4 landed independently and meet in one
    // line: `answeredByIndex(visible)`. Indexed off the RAW prop instead, a reply arriving mid-drag
    // would give the `you` bubble above it an "answered" affordance while the reply itself is still
    // withheld — which changes that bubble's HEIGHT under the reader's pointer (the reflow guard 4
    // exists to prevent) and aims `onJump` at an id that is not rendered, so `jumpTo`'s scan finds
    // nothing and the click is dead. The marker and its target must appear together.
    const asked: ConciergeMessage = { id: "u1", kind: "you", text: "what needs me?" };
    const { rerender } = render(thread([asked]));
    const el = scrollerEl();
    expect(screen.queryByTestId(ANSWERED_MARKER_TESTID)).toBeNull();

    dragOverThread(el);
    // The reply lands mid-drag, carrying the anchor back to the bubble above it.
    //
    // `settled: true` is REQUIRED, not decoration: `answeredByIndex` only counts a reply that has
    // finished (see ./replyAnchors). A still-streaming fragment must never claim to have answered
    // anything — that is the "chain of killed turns" case ConciergeThread.anchors.test guards — so
    // without this flag no marker is derived and the case fails for the wrong reason.
    rerender(
      thread([
        asked,
        {
          id: "b1",
          kind: "sparkle",
          text: "Two agents.",
          settled: true,
          answers: [{ id: "u1", quote: "what needs me?" }],
        },
      ]),
    );

    // Withheld — and therefore NOT yet marked.
    expect(el.textContent).not.toContain("Two agents.");
    expect(screen.queryByTestId(ANSWERED_MARKER_TESTID)).toBeNull();

    fireEvent.mouseUp(document, { button: 0 });

    // They arrive together, which is the whole invariant.
    expect(el.textContent).toContain("Two agents.");
    expect(screen.getByTestId(ANSWERED_MARKER_TESTID)).toBeTruthy();
  });

  it("re-arms the follow on release for a message the user sent during the gesture (rearmKey)", () => {
    // The reader is scrolled UP, so the follow is disarmed and only their own submit can re-arm it.
    const { rerender } = render(thread(answers(3)));
    const el = scroller();
    growableScroller(el);
    readerScrollsTo(el, 400);
    readerScrollsTo(el, 0);

    dragOverThread(el);
    rerender(thread([...answers(3), { id: "u9", kind: "you", text: "my new question" }]));
    // Withheld, so `rearmKey` has NOT moved yet — which is the whole point.
    expect(el.textContent).not.toContain("my new question");

    fireEvent.mouseUp(document, { button: 0 });

    expect(el.textContent).toContain("my new question");
    expect(el.scrollTop).toBe(el.scrollHeight);
  });
});
