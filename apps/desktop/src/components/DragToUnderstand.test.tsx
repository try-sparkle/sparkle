// @vitest-environment jsdom
//
// RUNG ONE OF DRAG-TO-UNDERSTAND (epic sparkle-0kbf4s): "I click and drag some text and it gives me
// a little copy icon."
//
// WHAT THIS PINS IS THE SIDE EFFECT — that the affordance APPEARS, and that pressing it copies the
// words that were swept. Not that a selection exists (the precondition), which is true before this
// feature and would prove nothing (AGENTS.md, "Tests must assert the SIDE EFFECT").
//
// ── THE jsdom TRAP THIS TEST IS BUILT AROUND ──────────────────────────────────────────────────────
// jsdom never LAYS OUT, so every box is zero-sized and `getBoundingClientRect` reads all zeros — the
// chip's position therefore cannot be asserted here and is not. What CAN be asserted is presence and
// behaviour, which is what the founder's sentence is about.
//
// jsdom also never ORIGINATES `selectionchange` (docs/jsdom-test-caveats.md). This component
// deliberately does not listen to it — it keys on `mouseup` — so the drag is expressed as a real
// press/release pair around a hand-built Range, which is the actual production path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import {
  DragToUnderstand,
  DRAG_TO_UNDERSTAND_TESTID,
  DRAG_TO_UNDERSTAND_COPIED_LABEL,
} from "./DragToUnderstand";
import { CONTROL_GESTURE_ATTR } from "./Concierge/controlGesture";
import { SELECTION_AFFORDANCE_ATTR } from "./understandGesture";

const copyToClipboard = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("../clipboard", () => ({ copyToClipboard }));

const TEXT = "the agent is waiting on a review";

/**
 * Perform a real drag-selection over `node`'s text and release.
 *
 * The press lands ON the text (that is what production sees, and what the control-gesture and
 * own-affordance rules are asked about); the Range is built by hand because jsdom has no pointer
 * that could sweep one out.
 */
function dragSelect(node: HTMLElement, { collapsed = false } = {}) {
  fireEvent.mouseDown(node, { button: 0 });
  const range = document.createRange();
  const text = node.firstChild!;
  range.setStart(text, 0);
  range.setEnd(text, collapsed ? 0 : (text.textContent ?? "").length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  // THE REAL ORDER, AND IT IS THE WHOLE POINT OF THIS HELPER. UI Events specifies the
  // compatibility sequence as pointerdown -> mousedown -> pointerup -> mouseup -> click, so
  // `pointerup` lands BEFORE `mouseup` and anything reading the control-gesture latch at mouseup
  // reads it already released. jsdom fires no compatibility pointer events of its own, so a test
  // that omits this dispatches a sequence the browser never produces and silently pins the
  // opposite interleaving (AGENTS.md, bead sparkle-40va0).
  node.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
  fireEvent.mouseUp(node, { button: 0 });
}

/** Every content host this file mounted, so teardown can remove exactly those.
 *
 *  NOT `document.body.innerHTML = ""`: the chip is PORTALLED into the body, so blanking it that way
 *  tears the portal's container out from under React and the unmount then throws NotFoundError —
 *  which surfaces as a failure in the very tests where the affordance actually appeared. */
const hosts: HTMLElement[] = [];

/** Mount the affordance over some content, optionally wrapped in an opting-out surface. */
function mountContent(wrapperAttrs = ""): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = wrapperAttrs
    ? `<div ${wrapperAttrs}><p data-content>${TEXT}</p></div>`
    : `<p data-content>${TEXT}</p>`;
  document.body.appendChild(host);
  hosts.push(host);
  return host.querySelector("[data-content]") as HTMLElement;
}

beforeEach(() => {
  copyToClipboard.mockClear();
  copyToClipboard.mockResolvedValue(true);
});

afterEach(() => {
  // React first, so the portal comes down through React rather than being ripped out beneath it.
  cleanup();
  window.getSelection()?.removeAllRanges();
  while (hosts.length) hosts.pop()!.remove();
});

describe("drag-to-understand, rung one", () => {
  it("THE AFFORDANCE APPEARS: dragging over ordinary text offers a copy icon", () => {
    const content = mountContent();
    render(<DragToUnderstand />);

    // Before the gesture there is nothing on screen — so the assertion below cannot be satisfied by
    // a chip that was always there.
    expect(screen.queryByTestId(DRAG_TO_UNDERSTAND_TESTID)).toBeNull();

    dragSelect(content);

    expect(screen.getByTestId(DRAG_TO_UNDERSTAND_TESTID)).toBeTruthy();
  });

  it("OFFERS, never assumes: the drag alone writes nothing to the clipboard", () => {
    const content = mountContent();
    render(<DragToUnderstand />);
    dragSelect(content);
    // The epic's rule: "when confidence is low, offer rather than assume." The chip is up; the
    // clipboard is untouched until the user says so.
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("pressing the affordance copies the words that were swept", async () => {
    const content = mountContent();
    render(<DragToUnderstand />);
    dragSelect(content);

    await act(async () => {
      fireEvent.click(screen.getByTestId(DRAG_TO_UNDERSTAND_TESTID));
    });

    expect(copyToClipboard).toHaveBeenCalledWith(TEXT);
    // And it says so, rather than leaving the user guessing whether the press registered.
    expect(screen.getByTestId(DRAG_TO_UNDERSTAND_TESTID).textContent).toContain(
      DRAG_TO_UNDERSTAND_COPIED_LABEL,
    );
  });

  it("a plain click offers nothing", () => {
    const content = mountContent();
    render(<DragToUnderstand />);
    dragSelect(content, { collapsed: true });
    expect(screen.queryByTestId(DRAG_TO_UNDERSTAND_TESTID)).toBeNull();
  });

  // ── THE FOUNDER'S CONTROL-DRAG RULE (bead sparkle-bjbhw6, DEFECT 4) ────────────────────────────
  // "if I'm dragging and scrolling the scroll bar, I don't want it to be implementing drag to
  // understand." Paired with the positive above: the SAME gesture over the SAME text differs only by
  // the wrapper, so a chip that failed to appear for some unrelated reason would fail that one too.
  it("a drag that begins on a control offers nothing", () => {
    const content = mountContent(`${CONTROL_GESTURE_ATTR}="yes"`);
    render(<DragToUnderstand />);
    dragSelect(content);
    expect(screen.queryByTestId(DRAG_TO_UNDERSTAND_TESTID)).toBeNull();
  });

  // THE OTHER HALF OF THE FOUNDER'S RULE — the LATCH, not the press target.
  //
  // Dragging a scrubber handle sweeps a text selection across the content underneath it as a pure
  // side effect. The press that began that gesture landed on the CONTROL, but the release this
  // component hears can land anywhere, so a press-target test alone cannot see it: the two guards
  // answer at different moments and `controlGesture.ts` exists precisely because `selectionchange`
  // and a stray `mouseup` carry no reference to what the user actually grabbed.
  //
  // Expressed as production does it: `pointerdown` on the control arms the latch (capture phase),
  // and no `pointerup` has released it by the time the selection resolves.
  it("a control drag already in flight offers nothing, even when the release lands on text", () => {
    const control = document.createElement("div");
    control.setAttribute(CONTROL_GESTURE_ATTR, "yes");
    document.body.appendChild(control);
    hosts.push(control);
    const content = mountContent();
    render(<DragToUnderstand />);

    control.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    dragSelect(content);

    expect(screen.queryByTestId(DRAG_TO_UNDERSTAND_TESTID)).toBeNull();
  });

  // Whitespace is an accident of dragging, never an intent — the same rule useCopyOnSelection
  // learned. A chip offering to copy "   " is a wrong guess, and the epic is explicit that a wrong
  // guess is worse than no guess.
  it("a whitespace-only sweep offers nothing", () => {
    const host = document.createElement("div");
    host.innerHTML = `<p data-content>${"   "}</p>`;
    document.body.appendChild(host);
    hosts.push(host);
    const content = host.querySelector("[data-content]") as HTMLElement;
    render(<DragToUnderstand />);

    dragSelect(content);

    expect(screen.queryByTestId(DRAG_TO_UNDERSTAND_TESTID)).toBeNull();
  });

  it("a surface that owns its own selection affordance is left alone", () => {
    const content = mountContent(`${SELECTION_AFFORDANCE_ATTR}="own"`);
    render(<DragToUnderstand />);
    dragSelect(content);
    expect(screen.queryByTestId(DRAG_TO_UNDERSTAND_TESTID)).toBeNull();
  });

  it("a new press retires a standing offer", () => {
    const content = mountContent();
    render(<DragToUnderstand />);
    dragSelect(content);
    expect(screen.getByTestId(DRAG_TO_UNDERSTAND_TESTID)).toBeTruthy();

    fireEvent.mouseDown(content, { button: 0 });
    expect(screen.queryByTestId(DRAG_TO_UNDERSTAND_TESTID)).toBeNull();
  });
});
