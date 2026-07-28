// @vitest-environment jsdom
//
// The compose box grows with what you type and can be dragged past that.
//
// The bug: the box was a hard-coded 42px with `resize: none`, so a paragraph scrolled invisibly
// above the caret — you could not see the message you were writing, and there was no handle and no
// scrollbar to tell you why.
//
// jsdom has no layout, so `scrollHeight` is always 0. Every test here therefore STUBS it to stand
// in for real content, which is the only honest way to drive the measurement path in this
// environment; the arithmetic itself is covered DOM-free in engine/composeBoxHeight.test.ts.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import { useUiStore } from "../../stores/uiStore";
import { COMPOSE_CAP_H, COMPOSE_MIN_H } from "../../engine/composeBoxHeight";

afterEach(() => cleanup());
beforeEach(() => useUiStore.getState().setConciergeComposeH(null));

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const handle = () => screen.getByTestId("concierge-compose-handle");
const px = (v: string) => parseFloat(v);

/** Stand in for laid-out content: jsdom always reports scrollHeight 0. */
function stubContentHeight(h: number) {
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => h,
  });
}

function setup() {
  return render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} />);
}

describe("ComposeBox — auto-grow", () => {
  it("rests at the one-line height with nothing typed", () => {
    stubContentHeight(0);
    setup();
    expect(px(box().style.height)).toBe(COMPOSE_MIN_H);
  });

  it("grows as content grows", () => {
    stubContentHeight(0);
    setup();
    const resting = px(box().style.height);
    stubContentHeight(120);
    fireEvent.change(box(), { target: { value: "line\nline\nline\nline" } });
    expect(px(box().style.height)).toBeGreaterThan(resting);
  });

  it("stops at the ten-line cap and scrolls its own overflow instead", () => {
    stubContentHeight(5000);
    setup();
    fireEvent.change(box(), { target: { value: "x".repeat(5000) } });
    expect(px(box().style.height)).toBe(COMPOSE_CAP_H);
    // Past the cap the text has to go somewhere — the box scrolls rather than growing forever.
    expect(box().style.overflowY).toBe("auto");
  });

  it("shrinks back when content is deleted", () => {
    // Requires collapsing to `auto` before measuring; without that the box can only ever grow.
    stubContentHeight(200);
    setup();
    fireEvent.change(box(), { target: { value: "a\nb\nc\nd\ne\nf" } });
    const tall = px(box().style.height);
    stubContentHeight(30);
    fireEvent.change(box(), { target: { value: "a" } });
    expect(px(box().style.height)).toBeLessThan(tall);
  });
});

describe("ComposeBox — drag to resize", () => {
  it("offers a labelled handle", () => {
    stubContentHeight(0);
    setup();
    expect(handle().getAttribute("aria-label")).toBe("Resize the message box");
    expect(handle().style.cursor).toBe("ns-resize");
  });

  it("dragging UP makes the box taller and persists the height", () => {
    stubContentHeight(0);
    setup();
    const start = px(box().style.height);
    fireEvent.pointerDown(handle(), { clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: 400, pointerId: 1 }); // 100px up
    fireEvent.pointerUp(handle(), { clientY: 400, pointerId: 1 });
    expect(px(box().style.height)).toBe(start + 100);
    // Persisted, so the size survives a relaunch (the user asked for it to stick).
    expect(useUiStore.getState().conciergeComposeH).toBe(start + 100);
  });

  it("can be dragged PAST the auto cap — the whole point of the handle", () => {
    stubContentHeight(0);
    setup();
    fireEvent.pointerDown(handle(), { clientY: 900, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: 200, pointerId: 1 }); // 700px up
    expect(px(box().style.height)).toBeGreaterThan(COMPOSE_CAP_H);
  });

  it("a dragged height OVERRIDES auto-grow and does not collapse as text is deleted", () => {
    stubContentHeight(0);
    setup();
    fireEvent.pointerDown(handle(), { clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientY: 380, pointerId: 1 });
    const dragged = px(box().style.height);
    stubContentHeight(20);
    fireEvent.change(box(), { target: { value: "" } });
    expect(px(box().style.height)).toBe(dragged);
  });

  it("dragging back down to resting releases it to auto-grow again", () => {
    // Otherwise one stray drag freezes the box for the whole session with no obvious undo.
    stubContentHeight(0);
    setup();
    fireEvent.pointerDown(handle(), { clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: 300, pointerId: 1 });
    expect(useUiStore.getState().conciergeComposeH).not.toBeNull();
    fireEvent.pointerMove(handle(), { clientY: 900, pointerId: 1 }); // well below the start
    fireEvent.pointerUp(handle(), { clientY: 900, pointerId: 1 });
    expect(useUiStore.getState().conciergeComposeH).toBeNull();
    expect(px(box().style.height)).toBe(COMPOSE_MIN_H);
  });

  it("restores a persisted height on mount", () => {
    useUiStore.getState().setConciergeComposeH(260);
    stubContentHeight(0);
    setup();
    expect(px(box().style.height)).toBe(260);
  });
});
