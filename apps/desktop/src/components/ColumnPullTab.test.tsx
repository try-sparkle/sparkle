// @vitest-environment jsdom
//
// The unified pull tab: ONE tab per boundary carrying both gestures, revealed on hover. jsdom
// paints nothing, so what is pinned here is the contract that regresses silently — the hover
// gating the founder specifically asked for, the two zones being distinct controls, the drag being
// a delta, and the overlaid round trip where the DOTS mean "dock me" rather than "resize me".
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColumnPullTab } from "./ColumnPullTab";

afterEach(() => cleanup());

const tab = () => screen.getByTestId("column-pull-tab");
const dots = () => screen.getByTestId("column-pull-tab-dots");
const chevron = () => screen.getByTestId("column-pull-tab-chevron");

function setup(props: Partial<Parameters<typeof ColumnPullTab>[0]> = {}) {
  const onWidth = vi.fn();
  const onOverlayToggle = vi.fn();
  render(
    <ColumnPullTab
      width={360}
      onWidth={onWidth}
      min={280}
      max={560}
      label="Sparkle column"
      onOverlayToggle={onOverlayToggle}
      {...props}
    />,
  );
  return { onWidth, onOverlayToggle };
}

describe("ColumnPullTab — one tab, two zones", () => {
  it("is hidden at rest and revealed on hover", () => {
    // The founder's note verbatim: "It should also only show on hover. It's showing all the time
    // now." The control it replaces painted two grey marks on the seam permanently.
    setup();
    expect(tab().style.opacity).toBe("0");
    fireEvent.mouseEnter(tab());
    expect(tab().style.opacity).toBe("1");
    fireEvent.mouseLeave(tab());
    expect(tab().style.opacity).toBe("0");
  });

  it("stays visible THROUGH a drag, when the pointer has left the tab", () => {
    setup();
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500 });
    fireEvent.mouseLeave(tab());
    expect(tab().style.opacity).toBe("1");
  });

  it("carries BOTH gestures in one tab — a chevron zone and a six-dot zone", () => {
    setup();
    expect(tab().contains(chevron())).toBe(true);
    expect(tab().contains(dots())).toBe(true);
    // Six dots, two across.
    const field = dots().querySelector("span[aria-hidden]")!;
    expect(field.childElementCount).toBe(6);
    expect((field as HTMLElement).style.gridTemplateColumns).toContain("repeat(2");
  });

  it("does NOT advertise an overlay when the column has none", () => {
    // An affordance that does nothing is worse than an absent one, so the zone is not rendered
    // rather than rendered-and-disabled.
    setup({ onOverlayToggle: undefined });
    expect(screen.queryByTestId("column-pull-tab-chevron")).toBeNull();
    expect(screen.getByTestId("column-pull-tab-dots")).toBeTruthy();
  });
});

describe("ColumnPullTab — the dots resize", () => {
  it("drags as a DELTA from the mousedown point, not a jump to the cursor", () => {
    const { onWidth } = setup();
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 540 });
    expect(onWidth).toHaveBeenLastCalledWith(400);
    fireEvent.mouseUp(window);
  });

  it("clamps at both ends", () => {
    const { onWidth } = setup();
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 9000 });
    expect(onWidth).toHaveBeenLastCalledWith(560);
    fireEvent.mouseMove(window, { clientX: -9000 });
    expect(onWidth).toHaveBeenLastCalledWith(280);
    fireEvent.mouseUp(window);
  });

  it("nudges with the arrows, larger with Shift, and is a real separator", () => {
    const { onWidth } = setup();
    expect(dots().getAttribute("role")).toBe("separator");
    expect(dots().getAttribute("aria-valuenow")).toBe("360");
    fireEvent.keyDown(dots(), { key: "ArrowRight" });
    expect(onWidth).toHaveBeenLastCalledWith(368);
    fireEvent.keyDown(dots(), { key: "ArrowRight", shiftKey: true });
    expect(onWidth).toHaveBeenLastCalledWith(392);
  });

  it("ignores a non-primary button", () => {
    const { onWidth } = setup();
    fireEvent.mouseDown(dots(), { button: 2, clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 600 });
    expect(onWidth).not.toHaveBeenCalled();
  });
});

describe("ColumnPullTab — the chevron overlays, and the dots snap back", () => {
  it("the chevron toggles the overlay and reports its state", () => {
    const { onOverlayToggle } = setup();
    expect(chevron().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chevron());
    expect(onOverlayToggle).toHaveBeenCalledTimes(1);
  });

  it("WHILE OVERLAID the dots dock instead of resizing — the founder's round trip", () => {
    // "once it's overlaid, if I were to click on the six dots, then it would snap back to not be
    // an overlay anymore. And then I could modify the column width."
    const { onWidth, onOverlayToggle } = setup({ overlaid: true });
    fireEvent.click(dots());
    expect(onOverlayToggle).toHaveBeenCalledTimes(1);
    // …and it must not try to move a boundary that is not on screen.
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 600 });
    expect(onWidth).not.toHaveBeenCalled();
    fireEvent.keyDown(dots(), { key: "ArrowRight" });
    expect(onWidth).not.toHaveBeenCalled();
  });

  it("re-labels both zones for the overlaid state", () => {
    setup({ overlaid: true });
    expect(chevron().getAttribute("aria-pressed")).toBe("true");
    expect(chevron().getAttribute("aria-label")).toMatch(/dock/i);
    expect(dots().getAttribute("aria-label")).toMatch(/dock/i);
    // No longer a separator: there is no boundary to represent while floating.
    expect(dots().getAttribute("role")).toBe("button");
    expect(dots().getAttribute("aria-valuenow")).toBeNull();
  });
});
