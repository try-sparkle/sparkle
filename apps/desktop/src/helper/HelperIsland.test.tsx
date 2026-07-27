// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { HelperIsland } from "./HelperIsland";
import { HelperTab } from "./HelperTab";

afterEach(cleanup);

const noop = () => {};
const base = {
  vitals: { p0: 3, p1: 7 },
  captureBusy: false,
  captureError: null,
  onCapture: noop,
  onCollapse: noop,
  onChiclet: noop,
  onDragStart: noop,
};

const captureBtn = () => screen.getByRole("button", { name: /capture/i }) as HTMLButtonElement;

describe("HelperIsland", () => {
  it("renders the published P0 and P1 counts", () => {
    render(<HelperIsland {...base} />);
    expect(screen.getByTestId("helper-p0").textContent).toContain("3");
    expect(screen.getByTestId("helper-p1").textContent).toContain("7");
  });

  it("renders zeros rather than blanks when no vitals have arrived", () => {
    render(<HelperIsland {...base} vitals={{ p0: 0, p1: 0 }} />);
    expect(screen.getByTestId("helper-p0").textContent).toContain("0");
    expect(screen.getByTestId("helper-p1").textContent).toContain("0");
  });

  it("calls onChiclet with the tier that was clicked", () => {
    const onChiclet = vi.fn();
    render(<HelperIsland {...base} onChiclet={onChiclet} />);
    fireEvent.click(screen.getByTestId("helper-p0"));
    expect(onChiclet).toHaveBeenCalledWith("p0");
    fireEvent.click(screen.getByTestId("helper-p1"));
    expect(onChiclet).toHaveBeenCalledWith("p1");
  });

  it("calls onCapture when Capture is clicked", () => {
    const onCapture = vi.fn();
    render(<HelperIsland {...base} onCapture={onCapture} />);
    fireEvent.click(captureBtn());
    expect(onCapture).toHaveBeenCalledTimes(1);
  });

  it("disables Capture while a capture is in flight", () => {
    const onCapture = vi.fn();
    render(<HelperIsland {...base} captureBusy onCapture={onCapture} />);
    expect(captureBtn().disabled).toBe(true);
    fireEvent.click(captureBtn());
    expect(onCapture).not.toHaveBeenCalled();
  });

  it("calls onCollapse from the collapse handle, and NOT onCapture", () => {
    const onCollapse = vi.fn();
    const onCapture = vi.fn();
    render(<HelperIsland {...base} onCollapse={onCollapse} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: /minimi[sz]e/i }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onCapture).not.toHaveBeenCalled();
  });

  it("does not start a drag when a control is pressed", () => {
    // Reaching for Capture must never drag the island out from under the cursor.
    const onDragStart = vi.fn();
    render(<HelperIsland {...base} onDragStart={onDragStart} />);
    fireEvent.pointerDown(captureBtn());
    fireEvent.pointerDown(screen.getByTestId("helper-p0"));
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it("starts a drag from the island body", () => {
    const onDragStart = vi.fn();
    const { container } = render(<HelperIsland {...base} onDragStart={onDragStart} />);
    fireEvent.pointerDown(container.firstChild as Element);
    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  it("surfaces a capture error as an alert", () => {
    render(<HelperIsland {...base} captureError="Capture failed — check Screen Recording." />);
    expect(screen.getByRole("alert").textContent).toContain("Screen Recording");
  });

  it("shows no alert when there is no capture error", () => {
    render(<HelperIsland {...base} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("HelperTab", () => {
  it("calls onExpand when clicked", () => {
    const onExpand = vi.fn();
    render(<HelperTab edge="right" onExpand={onExpand} onDragStart={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /show sparkle helper/i }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("rounds the corners facing into the screen for each edge", () => {
    // A left-docked tab must round its RIGHT corners, and vice versa — otherwise it reads as
    // floating just short of the edge rather than attached to it.
    const { container, rerender } = render(
      <HelperTab edge="left" onExpand={noop} onDragStart={noop} />,
    );
    const btn = () => container.firstChild as HTMLElement;
    expect(btn().style.borderRadius).toBe("0 8px 8px 0");
    rerender(<HelperTab edge="right" onExpand={noop} onDragStart={noop} />);
    expect(btn().style.borderRadius).toBe("8px 0 0 8px");
  });
});
