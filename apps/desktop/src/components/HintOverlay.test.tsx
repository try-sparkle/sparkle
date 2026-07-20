// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HintOverlay } from "./HintOverlay";

// jsdom gives every element a 0×0 rect and a null offsetParent, which our visibility filter would
// reject. Stub both so tagged controls count as on-screen during the test.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10, y: 10, top: 10, left: 10, right: 50, bottom: 30, width: 40, height: 20,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return document.body;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // restoreAllMocks doesn't undo defineProperty; delete the stubbed accessor.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetParent;
});

// A clean Control tap = Control keydown then keyup with nothing in between (the default trigger).
function controlTap() {
  fireEvent.keyDown(window, { key: "Control" });
  fireEvent.keyUp(window, { key: "Control" });
}

describe("HintOverlay", () => {
  it("shows no chiclets until a clean Control tap", () => {
    render(
      <>
        <button data-hint="think" onClick={() => {}}>Think</button>
        <HintOverlay />
      </>,
    );
    expect(screen.queryByText("t")).toBeNull();
    controlTap();
    expect(screen.getByText("t")).toBeTruthy();
  });

  it("numbers agent rows by order and fires the target's click on its label key", async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(
      <>
        <div data-hint="agent" onClick={onFirst}>Agent one</div>
        <div data-hint="agent" onClick={onSecond}>Agent two</div>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();

    fireEvent.keyDown(window, { key: "2" });
    await waitFor(() => expect(onSecond).toHaveBeenCalledTimes(1));
    expect(onFirst).not.toHaveBeenCalled();
    // Overlay dismisses after activation.
    await waitFor(() => expect(screen.queryByText("2")).toBeNull());
  });

  it("a second Control tap dismisses without activating anything", () => {
    const onClick = vi.fn();
    render(
      <>
        <button data-hint="build" onClick={onClick}>Build</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("b")).toBeTruthy();
    controlTap();
    expect(screen.queryByText("b")).toBeNull();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("badges only the Recent-dropdown rows (a,b,c) and suppresses chrome while it's open", async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(
      <>
        <button data-hint="recent" onClick={() => {}}>Recent</button>
        <div data-hint="recent-item" onClick={onFirst}>amforge</div>
        <div data-hint="recent-item" onClick={onSecond}>sparkle-desktop</div>
        <HintOverlay />
      </>,
    );
    controlTap();
    // The chrome "r" mnemonic is suppressed while the dropdown rows are present.
    expect(screen.queryByText("r")).toBeNull();
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();

    fireEvent.keyDown(window, { key: "b" });
    await waitFor(() => expect(onSecond).toHaveBeenCalledTimes(1));
    expect(onFirst).not.toHaveBeenCalled();
  });

  it("skips rows scrolled out of a clipping ancestor instead of badging them off-popover", () => {
    // The Recent dropdown is maxHeight + overflowY:auto. getBoundingClientRect reports UNCLIPPED
    // layout, so an overflowing row still claims a plausible rect — the bug that drew badges below
    // the popover over unrelated page content.
    const rects: Record<string, Partial<DOMRect>> = {
      list: { top: 100, bottom: 200, left: 0, right: 300, width: 300, height: 100 },
      visible: { top: 110, bottom: 140, left: 10, right: 290, width: 280, height: 30 },
      clipped: { top: 260, bottom: 290, left: 10, right: 290, width: 280, height: 30 },
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const r = rects[this.dataset.testrect ?? ""] ?? { top: 10, bottom: 30, left: 10, right: 50, width: 40, height: 20 };
      return { ...r, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect;
    });

    render(
      <>
        <div data-testrect="list" style={{ overflowY: "auto" }}>
          <div data-testrect="visible" data-hint="recent-item" onClick={() => {}}>in view</div>
          <div data-testrect="clipped" data-hint="recent-item" onClick={() => {}}>scrolled out</div>
        </div>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("a")).toBeTruthy(); // the row actually on screen
    expect(screen.queryByText("b")).toBeNull(); // the clipped row gets no badge
  });

  it("still clips against a container that is BOTH position:fixed and a scroller", () => {
    // A fixed element escapes its ANCESTORS' clipping, but it still clips its own overflowing
    // children. Checking position:fixed before the clip box would wrongly badge the scrolled-out row.
    const rects: Record<string, Partial<DOMRect>> = {
      list: { top: 100, bottom: 200, left: 0, right: 300, width: 300, height: 100 },
      visible: { top: 110, bottom: 140, left: 10, right: 290, width: 280, height: 30 },
      clipped: { top: 260, bottom: 290, left: 10, right: 290, width: 280, height: 30 },
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const r = rects[this.dataset.testrect ?? ""] ?? { top: 10, bottom: 30, left: 10, right: 50, width: 40, height: 20 };
      return { ...r, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect;
    });

    render(
      <>
        <div data-testrect="list" style={{ position: "fixed", overflowY: "scroll" }}>
          <div data-testrect="visible" data-hint="recent-item" onClick={() => {}}>in view</div>
          <div data-testrect="clipped" data-hint="recent-item" onClick={() => {}}>scrolled out</div>
        </div>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.queryByText("b")).toBeNull();
  });

  it("badges Switch buttons after the rows and raises that window without opening here", async () => {
    const onOpenHere = vi.fn();
    const onSwitch = vi.fn();
    render(
      <>
        <div data-hint="recent-item" onClick={onOpenHere}>
          amforge
          <button
            data-hint="recent-switch"
            onClick={(e) => {
              e.stopPropagation();
              onSwitch();
            }}
          >
            Switch
          </button>
        </div>
        <div data-hint="recent-item" onClick={() => {}}>sparkle-desktop</div>
        <HintOverlay />
      </>,
    );
    controlTap();
    // Two rows take a and b; the switch continues the same stream at c.
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
    expect(screen.getByText("c")).toBeTruthy();

    fireEvent.keyDown(window, { key: "c" });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(1));
    // stopPropagation keeps the row's open-here handler from firing too.
    expect(onOpenHere).not.toHaveBeenCalled();
  });

  it("Escape dismisses the overlay", () => {
    render(
      <>
        <button data-hint="changelog" onClick={() => {}}>Changelog</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("c")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("c")).toBeNull();
  });

  it("does not spuriously open when focus is lost mid-tap (Ctrl held, then app switch)", () => {
    render(
      <>
        <button data-hint="think" onClick={() => {}}>Think</button>
        <HintOverlay />
      </>,
    );
    // Control pressed, then the app loses focus before we ever see a chord (the OS swallows the
    // switch key), then focus returns and Control is released. The blur must have cleared the
    // latent tap candidate so the release doesn't fire a spurious tap.
    fireEvent.keyDown(window, { key: "Control" });
    fireEvent.blur(window);
    fireEvent.keyUp(window, { key: "Control" });
    expect(screen.queryByText("t")).toBeNull();
  });

  it("an unassigned key is a no-op and keeps the overlay open", () => {
    render(
      <>
        <button data-hint="think" onClick={() => {}}>Think</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    fireEvent.keyDown(window, { key: "z" }); // no chiclet uses "z"
    expect(screen.getByText("t")).toBeTruthy(); // still open
  });
});
