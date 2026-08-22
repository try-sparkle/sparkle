// @vitest-environment jsdom
//
// A CONTROL GESTURE MUST NOT RAISE THE QUOTE CHICLET (DEFECT 4 of sparkle-bjbhw6).
//
// THE FOUNDER'S WORDS: "if I'm dragging and scrolling the scroll bar, I don't want it to be
// implementing drag to understand. So anything where there is an action that is click drag should
// not trigger drag to understand."
//
// `pending` IS the chiclet: `ConciergeThread` and `MountedAgentThread` render `QuoteChiclet` if and
// only if this hook hands one back, so `pending === null` is "no chiclet appeared" and a non-null
// one is "it did". Asserting it directly keeps this a test of the hook rather than of the portal.
//
// jsdom NEVER originates `selectionchange` (docs/jsdom-test-caveats.md), so every one below is
// dispatched by hand — and a `PointerEvent` constructor is not something to lean on either, so the
// presses are `new MouseEvent("pointerdown", …)`, the idiom `ColumnPullTab.test.tsx` already uses.
// The listener reads `type` and `target` and does not care which constructor made the event.
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUOTE_SELECTION_DEBOUNCE_MS, useQuoteOnSelection } from "./useQuoteOnSelection";

const MARKUP = `
  <div data-concierge-root>
    <div id="box">
      <div data-message-id="sparkle-1" data-quote-source="sparkle">
        <p id="inside">Sparkle said this bit.</p>
      </div>
    </div>
    <!-- A CONTROL that opted out (the scrubber rail's shape) and its twin that did not. Identical
         in every other respect, which is what makes the pairs below pin the ATTRIBUTE as the
         cause rather than merely the position. -->
    <span id="rail" data-control-gesture="yes"><span id="knob"></span></span>
    <span id="plain"></span>
  </div>`;

let ref: { current: HTMLElement | null };

beforeEach(() => {
  document.body.innerHTML = MARKUP;
  ref = { current: document.getElementById("box") };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

function mount() {
  return renderHook(() => useQuoteOnSelection(ref));
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id} in the harness`);
  return found;
}

/** Select a node's contents the way a drag does — a real Range in the real Selection. */
function selectInside(): void {
  const range = document.createRange();
  range.selectNodeContents(el("inside"));
  const sel = window.getSelection();
  if (!sel) throw new Error("jsdom has no Selection");
  sel.removeAllRanges();
  sel.addRange(range);
}

/** A real press: `pointerdown` first, then `mousedown`. */
function pressOn(target: HTMLElement): void {
  target.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
  );
  fireEvent.mouseDown(target);
}

/** The matching release. `pointerup` fires BEFORE `mouseup` — which is exactly why the hook keeps a
 *  press-time flag beside the latch: by the release, the latch has already cleared. */
function releaseOn(target: HTMLElement): void {
  target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
  fireEvent.mouseUp(target, { clientX: 10, clientY: 20 });
}

/** A keyboard-shaped settle: one `selectionchange`, then past the quiet period. */
function settleSelection(): void {
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
    vi.advanceTimersByTime(QUOTE_SELECTION_DEBOUNCE_MS * 3);
  });
}

describe("useQuoteOnSelection — a press on a control that opted out", () => {
  it("does NOT offer a quote for the selection the drag left behind", () => {
    const { result } = mount();

    // The scrubber drag: press the handle, the browser highlights transcript text as the pointer
    // sweeps across it, release over the thread.
    pressOn(el("knob"));
    selectInside();
    releaseOn(el("box"));

    expect(result.current.pending).toBeNull();
  });

  it("DOES offer one for the identical gesture on an element that did not opt out", () => {
    // THE PAIR. Same press-drag-release, same selection, same release point — the only difference is
    // `data-control-gesture`. Without this, the test above passes for a hook that offers nothing at
    // all.
    const { result } = mount();

    pressOn(el("plain"));
    selectInside();
    releaseOn(el("box"));

    expect(result.current.pending).not.toBeNull();
    expect(result.current.pending?.text).toBe("Sparkle said this bit.");
    expect(result.current.pending?.sourceId).toBe("sparkle-1");
  });

  it("offers again on the NEXT gesture — one control drag must not deafen the session", () => {
    const { result } = mount();

    pressOn(el("knob"));
    selectInside();
    releaseOn(el("box"));
    expect(result.current.pending).toBeNull();

    // A perfectly ordinary content selection, immediately afterwards.
    window.getSelection()?.removeAllRanges();
    pressOn(el("inside"));
    selectInside();
    releaseOn(el("box"));

    expect(result.current.pending).not.toBeNull();
  });

  it("suppresses the debounced offer for the whole drag — the latch, which is the only thing that can", () => {
    // `selectionchange` carries NO target, so nothing on this path can ask what was pressed. No
    // `mousedown` is dispatched here at all, so the hook's own press-time flag is false and the
    // pointerdown latch is the sole guard under test.
    vi.useFakeTimers();
    const { result } = mount();

    el("knob").dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
    );
    selectInside();
    // The reader holds the handle still for longer than the quiet period.
    settleSelection();
    expect(result.current.pending).toBeNull();

    // PAIRED with the release: once the handle is let go, the same quiet period offers.
    el("knob").dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }),
    );
    settleSelection();

    expect(result.current.pending).not.toBeNull();
  });

  it("recovers on window blur when the release never arrives", () => {
    // THE BACKSTOP `ThreadScrubber` already relies on. A latch with no release is silent and
    // permanent: the quote affordance would be dead for the rest of the session.
    vi.useFakeTimers();
    const { result } = mount();

    el("knob").dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
    );
    selectInside();
    settleSelection();
    expect(result.current.pending).toBeNull();

    // The window goes away mid-drag and no pointerup is ever dispatched.
    act(() => void window.dispatchEvent(new Event("blur")));
    settleSelection();

    expect(result.current.pending).not.toBeNull();
  });
});
