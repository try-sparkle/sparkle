// @vitest-environment jsdom
//
// useRowClock drives the sidebar row's elapsed-time counter on a 1s/5s interval. Backgrounded
// windows have no one watching it, so the interval is gated on document visibility: it pauses when
// the document is hidden and resumes (catching the clock up immediately) on the visibilitychange
// back to visible. This guards that gating so a refactor can't quietly reinstate the always-on
// per-second re-render in a hidden window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

import { useRowClock } from "./AgentSidebar";

let visibility: "visible" | "hidden" = "visible";
const setVisibility = (v: "visible" | "hidden") => {
  visibility = v;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

const T0 = 1_700_000_000_000;

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useRowClock visibility gating", () => {
  it("ticks while visible", () => {
    const since = T0 - 10_000; // <100s → fast 1s cadence
    const { result } = renderHook(() => useRowClock(since));
    expect(result.current).toBe(T0);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(T0 + 1000);
  });

  it("pauses the interval while the document is hidden, then catches up and resumes when shown", () => {
    const since = T0 - 10_000;
    const { result } = renderHook(() => useRowClock(since));

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(T0 + 1000);

    // Hide: the interval must stop — no timers left running, and the clock freezes.
    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(T0 + 1000); // frozen while hidden

    // Show again: the clock catches up to real elapsed time immediately, and ticking resumes.
    setVisibility("visible");
    expect(result.current).toBe(T0 + 11_000); // 1000 + 10_000 advanced while hidden
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(T0 + 12_000);
  });

  it("runs no interval when there is no `since` (no timer to gate)", () => {
    renderHook(() => useRowClock(undefined));
    expect(vi.getTimerCount()).toBe(0);
  });
});
