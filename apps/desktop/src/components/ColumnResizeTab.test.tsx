// @vitest-environment jsdom
//
// The shared column boundary. jsdom paints nothing, so "the drag feels right" is not testable here
// — what IS testable is the contract that regresses silently: the clamp, the keyboard path, the
// drag being a DELTA rather than a jump-to-cursor, and the grip staying inert.
//
// That last one is not hypothetical. The agent column's own tests record it: the grip sits inside
// the 6px strip and is wider than it, so while it accepted pointer events it ate every mousedown
// over the one part of the control a user can actually see. This file inherits that lesson rather
// than rediscovering it.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColumnResizeTab } from "./ColumnResizeTab";

afterEach(() => cleanup());

const tab = () => screen.getByTestId("column-resize-tab");
const grip = () => screen.getByTestId("column-resize-tab-grip");

function setup(width = 360, props: Partial<Parameters<typeof ColumnResizeTab>[0]> = {}) {
  const onWidth = vi.fn();
  render(<ColumnResizeTab width={width} onWidth={onWidth} min={280} max={560} label="Sparkle column" {...props} />);
  return { onWidth };
}

describe("ColumnResizeTab — the control contract", () => {
  it("is a real separator with a value range, not a bare div", () => {
    setup();
    const t = tab();
    expect(t.getAttribute("role")).toBe("separator");
    expect(t.getAttribute("aria-orientation")).toBe("vertical");
    expect(t.getAttribute("aria-valuenow")).toBe("360");
    expect(t.getAttribute("aria-valuemin")).toBe("280");
    expect(t.getAttribute("aria-valuemax")).toBe("560");
    // Focusable, or the keyboard path below is unreachable.
    expect(t.getAttribute("tabindex")).toBe("0");
    expect(t.getAttribute("aria-label")).toMatch(/resize/i);
    expect(t.getAttribute("title")).toMatch(/resize/i);
  });

  it("keeps the grip inert so it cannot swallow the drag it advertises", () => {
    setup();
    expect(grip().style.pointerEvents).toBe("none");
    expect(grip().getAttribute("aria-hidden")).toBe("true");
  });

  it("renders SIX dots — 2 across, 3 down", () => {
    setup();
    expect(grip().childElementCount).toBe(6);
    expect(grip().style.gridTemplateColumns).toContain("repeat(2");
  });

  it("hides the grip at rest and reveals it on hover", () => {
    setup();
    expect(grip().style.opacity).toBe("0");
    fireEvent.mouseEnter(tab());
    expect(grip().style.opacity).toBe("1");
    fireEvent.mouseLeave(tab());
    expect(grip().style.opacity).toBe("0");
  });

  it("keeps the grip visible THROUGH a drag, when the pointer has left the strip", () => {
    // A hover-only rule makes the grip vanish exactly when it is being used: the pointer leaves the
    // 6px strip on the first pixel of movement.
    setup();
    fireEvent.mouseDown(tab(), { clientX: 500 });
    fireEvent.mouseLeave(tab());
    expect(grip().style.opacity).toBe("1");
  });
});

describe("ColumnResizeTab — resizing", () => {
  it("drags as a DELTA from the mousedown point, not a jump to the cursor", () => {
    const { onWidth } = setup(360);
    fireEvent.mouseDown(tab(), { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 540 }); // +40
    expect(onWidth).toHaveBeenLastCalledWith(400);
    fireEvent.mouseMove(window, { clientX: 480 }); // -20 from origin
    expect(onWidth).toHaveBeenLastCalledWith(340);
    fireEvent.mouseUp(window);
  });

  it("stops tracking after mouseup", () => {
    const { onWidth } = setup(360);
    fireEvent.mouseDown(tab(), { clientX: 500 });
    fireEvent.mouseUp(window);
    onWidth.mockClear();
    fireEvent.mouseMove(window, { clientX: 900 });
    expect(onWidth).not.toHaveBeenCalled();
  });

  it("clamps a drag to the range at both ends", () => {
    const { onWidth } = setup(360);
    fireEvent.mouseDown(tab(), { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 5000 });
    expect(onWidth).toHaveBeenLastCalledWith(560);
    fireEvent.mouseMove(window, { clientX: -5000 });
    expect(onWidth).toHaveBeenLastCalledWith(280);
    fireEvent.mouseUp(window);
  });

  it("nudges with the arrow keys, and takes a larger step with Shift", () => {
    const { onWidth } = setup(360);
    fireEvent.keyDown(tab(), { key: "ArrowRight" });
    expect(onWidth).toHaveBeenLastCalledWith(368);
    fireEvent.keyDown(tab(), { key: "ArrowLeft" });
    expect(onWidth).toHaveBeenLastCalledWith(352);
    fireEvent.keyDown(tab(), { key: "ArrowRight", shiftKey: true });
    expect(onWidth).toHaveBeenLastCalledWith(392);
  });

  it("clamps the keyboard path too", () => {
    const { onWidth } = setup(560);
    fireEvent.keyDown(tab(), { key: "ArrowRight" });
    expect(onWidth).toHaveBeenLastCalledWith(560);
  });

  // `grows` decides which way a drag runs. Getting it backwards inverts the gesture, which feels
  // broken and reads as correct in a diff — so it is pinned rather than assumed.
  it("inverts the drag for a column that sits on the RIGHT of its boundary", () => {
    const { onWidth } = setup(360, { grows: "right" });
    fireEvent.mouseDown(tab(), { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 540 }); // dragging right SHRINKS it
    expect(onWidth).toHaveBeenLastCalledWith(320);
    fireEvent.mouseUp(window);
  });

  it("keeps ← and → meaning narrower/wider regardless of which side it owns", () => {
    const { onWidth } = setup(360, { grows: "right" });
    fireEvent.keyDown(tab(), { key: "ArrowRight" });
    expect(onWidth).toHaveBeenLastCalledWith(352);
  });
});
