// @vitest-environment jsdom
//
// The Appearance → Window group. The rectangle math itself is Rust-side and tested there
// (src-tauri/src/display_span.rs); what matters here is that the pane never offers an action that
// cannot work, and never reports geometry it didn't get.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { WindowSpanControls } from "./WindowSpanControls";
import { useSettingsStore } from "../stores/settingsStore";
import type { DisplayLayout } from "../services/displaySpan";

// The arrangement this feature was built for: a 2× Retina built-in flanked by two 1× 1080p
// externals, so the work areas do NOT union into a rectangle and the two modes differ.
//
// EVERY NUMBER HERE IS IN LOGICAL POINTS, because that is what the backend emits — `describe()`
// divides each monitor by its own scale factor. A 2× panel of 3024×1964 pixels reports 1512×982,
// and the externals sit at x 0 and 3432, not 0 and 4944. Writing the fixture in pixels would make
// the suite unit-blind: it would look identically green whether the backend returned points or
// pixels, which is the exact confusion this module exists to prevent.
const BUILT_IN = {
  name: "Color LCD",
  bounds: { x: 1920, y: 0, width: 1512, height: 982 },
  // 25pt of menu bar off the top — the reason the safe rect gives up a band.
  work_area: { x: 1920, y: 25, width: 1512, height: 957 },
  scale_factor: 2,
};

const RAGGED: DisplayLayout = {
  displays: [
    {
      name: "PM161Q J",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      work_area: { x: 0, y: 0, width: 1920, height: 1080 },
      scale_factor: 1,
    },
    BUILT_IN,
    {
      name: "PM161Q J",
      bounds: { x: 3432, y: 0, width: 1920, height: 1080 },
      work_area: { x: 3432, y: 0, width: 1920, height: 1080 },
      scale_factor: 1,
    },
  ],
  // Full width, but only the band all three cover (y 25..982).
  safe: { x: 0, y: 25, width: 5352, height: 957 },
  full: { x: 0, y: 0, width: 5352, height: 1080 },
  spanning_enabled: true,
};

// `span_window`'s reply is deliberately DIFFERENT from the target rect, and that divergence is a
// regression guard, not incidental. Twice this component tried to decide "did it land" by comparing
// the reply against the target, and twice that made every span read as clamped and silently killed
// auto-respan. A mock that echoes the target back would let that comparison reappear and still pass.
// The flag must follow the ACTION that ran, so these tests assert it is set even though the reply
// does not match.
const REPLY_SKEW = 28;

function withLayout(layout: DisplayLayout) {
  invoke.mockImplementation((cmd: string, args?: { mode?: "safe" | "full" }) => {
    if (cmd === "display_layout") return Promise.resolve(layout);
    if (cmd === "span_window") {
      const target = args?.mode === "full" ? layout.full : layout.safe;
      return Promise.resolve(target ? { ...target, height: target.height + REPLY_SKEW } : null);
    }
    return Promise.resolve({ x: 0, y: 0, width: 1200, height: 800 });
  });
}

beforeEach(() => {
  invoke.mockReset();
  useSettingsStore.setState({
    windowSpanMode: "safe",
    windowAutoRespan: true,
    windowIsSpanned: false,
  });
});

afterEach(cleanup);

describe("WindowSpanControls", () => {
  it("reports the live span target for the selected mode", async () => {
    withLayout(RAGGED);
    render(<WindowSpanControls />);
    expect(await screen.findByText("3 displays · 5352 × 957")).toBeTruthy();
  });

  it("spans with the chosen mode and records that the window is now spanned", async () => {
    withLayout(RAGGED);
    render(<WindowSpanControls />);
    await screen.findByText("3 displays · 5352 × 957");

    await userEvent.click(screen.getByRole("button", { name: /Span the Sparkle window/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("span_window", { mode: "safe" });
    });
    // Auto-respan must only fire for a window the user actually spanned. Note this passes even
    // though the mocked reply is REPLY_SKEW taller than the target — the flag follows the action,
    // and re-introducing a reply-vs-target comparison here would break it.
    expect(useSettingsStore.getState().windowIsSpanned).toBe(true);
  });

  it("switching span area changes the reported target", async () => {
    withLayout(RAGGED);
    render(<WindowSpanControls />);
    await screen.findByText("3 displays · 5352 × 957");

    await userEvent.click(screen.getByRole("button", { name: /^Full bounds/i }));

    expect(await screen.findByText("3 displays · 5352 × 1080")).toBeTruthy();
    expect(useSettingsStore.getState().windowSpanMode).toBe("full");
  });

  it("clears the spanned flag when fitting to a single display", async () => {
    withLayout(RAGGED);
    useSettingsStore.setState({ windowIsSpanned: true });
    render(<WindowSpanControls />);
    await screen.findByText("3 displays · 5352 × 957");

    await userEvent.click(screen.getByRole("button", { name: /Fit the window to the display/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("fit_window_to_current_display");
    });
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });

  it("disables spanning and explains the fix when macOS keeps displays in separate Spaces", async () => {
    withLayout({ ...RAGGED, spanning_enabled: false });
    render(<WindowSpanControls />);

    // AWAIT THE ALERT, NOT THE BUTTON. The button is `disabled={blockedBySpaces || noLayout}` and
    // exists from the FIRST render, so `findByRole("button")` matches it immediately and does not
    // wait for the async layout at all — which made `hasAttribute("disabled")` pass for the wrong
    // reason (noLayout, not blocked) and left the synchronous `getByRole("alert")` racing a promise
    // it never waited on. Under full-suite load that race loses. The alert renders only once layout
    // has ARRIVED and says spanning is blocked, so awaiting it is what actually pins the state.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Displays have separate Spaces");
    // The action genuinely cannot work in this state; offering it would just look broken.
    const span = screen.getByRole("button", { name: /Span the Sparkle window/i });
    expect(span.hasAttribute("disabled")).toBe(true);
  });

  it("does not warn about separate Spaces on a single display, where spanning is just maximizing", async () => {
    withLayout({
      displays: [BUILT_IN],
      safe: { x: 1920, y: 25, width: 1512, height: 957 },
      full: { x: 1920, y: 25, width: 1512, height: 957 },
      spanning_enabled: false,
    });
    render(<WindowSpanControls />);

    // The MIRROR IMAGE of the race above, and it would have failed the other way: the button starts
    // disabled (noLayout) and only becomes enabled once layout lands, so asserting `false` against
    // the first-render element is a bet on timing. Wait for the state instead of sampling it.
    await waitFor(() => {
      const span = screen.getByRole("button", { name: /Span the Sparkle window/i });
      expect(span.hasAttribute("disabled")).toBe(false);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when both modes would produce the same window", async () => {
    withLayout({
      ...RAGGED,
      safe: { x: 0, y: 0, width: 5760, height: 1080 },
      full: { x: 0, y: 0, width: 5760, height: 1080 },
    });
    render(<WindowSpanControls />);
    expect(await screen.findByText(/both modes give the same window/i)).toBeTruthy();
  });

  it("leaves the window un-spanned when the span call fails", async () => {
    // A span that errored must not arm auto-respan — that would re-stretch a window on every
    // display change despite the span never having happened.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "display_layout") return Promise.resolve(RAGGED);
      return Promise.reject(new Error("window server said no"));
    });
    render(<WindowSpanControls />);
    await screen.findByText("3 displays · 5352 × 957");

    await userEvent.click(screen.getByRole("button", { name: /Span the Sparkle window/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("span_window", { mode: "safe" }));
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });

  it("surfaces a read failure and disables every action rather than offering broken buttons", async () => {
    invoke.mockRejectedValue(new Error("read monitors: backend gone"));
    render(<WindowSpanControls />);

    expect(await screen.findByText(/Couldn't read your displays: .*backend gone/)).toBeTruthy();
    // Acting with no layout just produces a second error beside the first.
    for (const name of [
      /Span the Sparkle window/i,
      /Fit the window to the display/i,
      /Reset the window to its default size/i,
    ]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
  });

  it("distinguishes an action failure from a read failure", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "display_layout") return Promise.resolve(RAGGED);
      return Promise.reject(new Error("window server said no"));
    });
    render(<WindowSpanControls />);
    await screen.findByText("3 displays · 5352 × 957");

    await userEvent.click(screen.getByRole("button", { name: /Span the Sparkle window/i }));

    expect(await screen.findByText(/Couldn't apply that: .*window server said no/)).toBeTruthy();
    expect(screen.queryByText(/Couldn't read your displays/)).toBeNull();
  });
});
