// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { C } from "@sparkle/ui";
import { HelperIsland } from "./HelperIsland";
import { HelperTab } from "./HelperTab";

afterEach(cleanup);

const noop = () => {};
const base = {
  vitals: { needsYou: 3, running: 7 },
  captureBusy: false,
  captureError: null,
  onCapture: noop,
  onCollapse: noop,
  onChiclet: noop,
  onDragStart: noop,
};

const captureBtn = () => screen.getByRole("button", { name: /capture/i }) as HTMLButtonElement;
const minimizeBtn = () => screen.getByRole("button", { name: /minimi[sz]e/i }) as HTMLButtonElement;

/** jsdom re-serializes colors (hex in, `rgb(...)` out), so compare tokens through the same pipe. */
const cssColor = (value: string) => {
  const probe = document.createElement("div");
  probe.style.background = value;
  return probe.style.background;
};

describe("HelperIsland chiclets — dot + number, meaning kept in the accessible name", () => {
  it("shows ONLY the count, with no prose beside the dot", () => {
    render(<HelperIsland {...base} />);
    // The dot is aria-hidden and contributes no text, so this is the whole visible label.
    expect(screen.getByTestId("helper-needs-you").textContent).toBe("3");
    expect(screen.getByTestId("helper-running").textContent).toBe("7");
    expect(screen.getByTestId("helper-needs-you").textContent).not.toMatch(/need/i);
    expect(screen.getByTestId("helper-running").textContent).not.toMatch(/running/i);
  });

  it("still announces what the number MEANS — a bare '3' would be meaningless", () => {
    render(<HelperIsland {...base} />);
    expect(screen.getByRole("button", { name: /3 Need you/i })).toBe(
      screen.getByTestId("helper-needs-you"),
    );
    expect(screen.getByRole("button", { name: /7 Running/i })).toBe(
      screen.getByTestId("helper-running"),
    );
  });

  it("hover-explains the naked dot for sighted users, via title", () => {
    render(<HelperIsland {...base} />);
    expect(screen.getByTestId("helper-needs-you").getAttribute("title")).toMatch(/3 Need you/i);
    expect(screen.getByTestId("helper-running").getAttribute("title")).toMatch(/7 Running/i);
  });

  it("keeps singular agreement in the accessible name — '1 Needs you', not '1 Need you'", () => {
    // bandCountLabel is reused rather than re-worded here, so this boundary cannot drift from
    // the sidebar's copy of it.
    render(<HelperIsland {...base} vitals={{ needsYou: 1, running: 1 }} />);
    const label = screen.getByTestId("helper-needs-you").getAttribute("aria-label") ?? "";
    expect(label).toMatch(/1 Needs you/);
    expect(label).not.toMatch(/1 Need you\b/);
  });

  it("renders zeros rather than blanks or an 'all calm' state when nothing is happening", () => {
    render(<HelperIsland {...base} vitals={{ needsYou: 0, running: 0 }} />);
    expect(screen.getByTestId("helper-needs-you").textContent).toBe("0");
    expect(screen.getByTestId("helper-running").textContent).toBe("0");
  });

  it("paints the dots from the shared band palette, not a local hex copy", () => {
    const { container } = render(<HelperIsland {...base} />);
    const dot = (testId: string) =>
      (container.querySelector(`[data-testid="${testId}"] span`) as HTMLElement).style.background;
    expect(dot("helper-needs-you")).toBe(cssColor(C.sienna)); // AGENT_STATUS.waiting — red
    expect(dot("helper-running")).toBe(cssColor(C.success)); // AGENT_STATUS.working — green
  });
});

describe("HelperIsland affordances — clicks say pointer, the drag surface says grab", () => {
  it("gives every CLICK target a pointer cursor", () => {
    render(<HelperIsland {...base} />);
    expect(screen.getByTestId("helper-needs-you").style.cursor).toBe("pointer");
    expect(screen.getByTestId("helper-running").style.cursor).toBe("pointer");
    expect(captureBtn().style.cursor).toBe("pointer");
    expect(minimizeBtn().style.cursor).toBe("pointer");
  });

  it("keeps grab on the island BODY — it is the drag handle, not a click target", () => {
    const { container } = render(<HelperIsland {...base} />);
    expect((container.firstChild as HTMLElement).style.cursor).toBe("grab");
  });

  it("drops Capture to `default` while busy, because clicking it then does nothing", () => {
    render(<HelperIsland {...base} captureBusy />);
    expect(captureBtn().style.cursor).toBe("default");
  });
});

describe("HelperIsland collapse handle — discoverable without a text label", () => {
  it("rests at full contrast, not the muted tone used for non-actionable metadata", () => {
    render(<HelperIsland {...base} />);
    expect(minimizeBtn().style.color).toBe(cssColor(C.cream));
    expect(minimizeBtn().style.color).not.toBe(cssColor(C.muted));
  });

  it("confirms it is interactive on hover, and lets go again", () => {
    render(<HelperIsland {...base} />);
    const btn = minimizeBtn();
    expect(btn.style.background).toBe("transparent");
    fireEvent.mouseEnter(btn);
    expect(btn.style.background).toBe(cssColor(C.forest));
    fireEvent.mouseLeave(btn);
    expect(btn.style.background).toBe("transparent");
  });

  it("points its chevrons at the edge the island actually collapses toward", () => {
    // Each polyline is "x1 y1 x2 y2 x3 y3"; the apex (x2) sits past the ends in the direction
    // the chevron points. A handle that docks LEFT but points right is a lie about where it goes.
    const apexPointsRight = () =>
      Array.from(
        screen.getByTestId("helper-collapse-chevrons").querySelectorAll("polyline"),
      ).map((p) => {
        const n = (p.getAttribute("points") ?? "").trim().split(/\s+/).map(Number);
        return n[2]! > n[0]!;
      });

    const { rerender } = render(<HelperIsland {...base} edge="right" />);
    expect(apexPointsRight()).toEqual([true, true]);

    rerender(<HelperIsland {...base} edge="left" />);
    expect(apexPointsRight()).toEqual([false, false]);
  });

  it("is reachable by its accessible name and collapses the island", () => {
    const onCollapse = vi.fn();
    render(<HelperIsland {...base} onCollapse={onCollapse} />);
    fireEvent.click(minimizeBtn());
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});

describe("HelperIsland branding — square mark, not the wordmark", () => {
  it("renders the square mark and keeps the accessible name", () => {
    render(<HelperIsland {...base} />);
    const mark = screen.getByAltText("Sparkle");
    expect(mark.getAttribute("src")).toBe("/sparkle-mark.svg");
  });

  it("no longer spends a quarter of the island on the full wordmark", () => {
    const { container } = render(<HelperIsland {...base} />);
    expect(container.querySelector('img[src="/sparkle-logo.svg"]')).toBeNull();
  });

  it("reserves a SQUARE footprint, so the island cannot regrow horizontally", () => {
    render(<HelperIsland {...base} />);
    const mark = screen.getByAltText("Sparkle") as HTMLImageElement;
    expect(mark.style.width).toBe(mark.style.height);
  });
});

describe("HelperIsland", () => {

  it("offers no `done` chiclet — it would sit at a large constant and drown the other two", () => {
    render(<HelperIsland {...base} />);
    expect(screen.queryByTestId("helper-done")).toBeNull();
  });

  it("calls onChiclet with the band that was clicked", () => {
    const onChiclet = vi.fn();
    render(<HelperIsland {...base} onChiclet={onChiclet} />);
    fireEvent.click(screen.getByTestId("helper-needs-you"));
    expect(onChiclet).toHaveBeenCalledWith("needs_you");
    fireEvent.click(screen.getByTestId("helper-running"));
    expect(onChiclet).toHaveBeenCalledWith("running");
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
    fireEvent.pointerDown(screen.getByTestId("helper-needs-you"));
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
