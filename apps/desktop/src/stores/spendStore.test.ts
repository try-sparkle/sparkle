// @vitest-environment jsdom
// Tests for the concierge spend store/hook (CM-U8, sparkle-4562.1): the pure "$X.XX" formatter, the
// store's success/failure folding, and the shared polling hook (mount fetch, focus refetch, and
// teardown when the last pill unmounts). getSpend is mocked at the service boundary so no Tauri IPC
// is touched.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

vi.mock("../services/accountStore", () => ({
  getSpend: vi.fn(),
}));

import { getSpend, type Spend } from "../services/accountStore";
import {
  useSpendStore,
  useSpendPill,
  formatSpendText,
  SPEND_REFRESH_MS,
  REFRESH_COALESCE_MS,
} from "./spendStore";

const mockGetSpend = getSpend as unknown as ReturnType<typeof vi.fn>;

const sample = (usd: number): Spend => ({
  spendTodayUsd: usd,
  tokensToday: 0,
  spend7dUsd: usd,
  tokens7d: 0,
  fallbackModelRecords: 0,
});

/** Flush pending microtasks (the resolved getSpend → store set). */
const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  mockGetSpend.mockReset();
  useSpendStore.setState({ spendTodayUsd: null, loading: true, error: false });
});

// Unmount any hook the test mounted so the shared polling singleton's subscriber count returns to
// 0 between tests — otherwise a leaked subscriber suppresses the next test's mount-time fetch.
afterEach(() => {
  cleanup();
});

describe("formatSpendText", () => {
  it("renders the em-dash placeholder before a figure exists", () => {
    expect(formatSpendText(null)).toBe("$—");
    expect(formatSpendText(NaN)).toBe("$—");
    expect(formatSpendText(Infinity)).toBe("$—");
  });

  it("formats a known figure as $X.XX with two decimals", () => {
    expect(formatSpendText(0)).toBe("$0.00");
    expect(formatSpendText(4.2)).toBe("$4.20");
    expect(formatSpendText(12.5)).toBe("$12.50");
  });

  it("rounds to the cent and never shows a negative amount", () => {
    expect(formatSpendText(4.125)).toBe("$4.13"); // rounds half up
    expect(formatSpendText(4.124)).toBe("$4.12");
    expect(formatSpendText(-3)).toBe("$0.00"); // clamped, never a negative pill
  });
});

describe("useSpendStore.refresh", () => {
  it("folds the fetched figure into the store on success", async () => {
    mockGetSpend.mockResolvedValue(sample(4.2));
    await useSpendStore.getState().refresh();
    const s = useSpendStore.getState();
    expect(s.spendTodayUsd).toBe(4.2);
    expect(s.loading).toBe(false);
    expect(s.error).toBe(false);
  });

  it("flags error and keeps the placeholder when the read throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetSpend.mockRejectedValue(new Error("ipc down"));
    await useSpendStore.getState().refresh();
    const s = useSpendStore.getState();
    expect(s.spendTodayUsd).toBeNull(); // unchanged — never a garbage figure on failure
    expect(s.loading).toBe(false);
    expect(s.error).toBe(true);
    warn.mockRestore();
  });
});

describe("useSpendPill", () => {
  it("fetches on mount and returns the formatted figure once it lands", async () => {
    mockGetSpend.mockResolvedValue(sample(12.5));
    const { result } = renderHook(() => useSpendPill());
    expect(result.current).toBe("$—"); // placeholder until the first read resolves
    await flush();
    expect(mockGetSpend).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("$12.50");
  });

  it("refetches on window focus, coalescing rapid refocus (roborev 46151)", async () => {
    vi.useFakeTimers();
    mockGetSpend.mockResolvedValue(sample(1));
    renderHook(() => useSpendPill());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // settle the mount fetch
    });
    expect(mockGetSpend).toHaveBeenCalledTimes(1);
    // A focus inside the coalesce window is skipped — each refresh is a full transcript rescan.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockGetSpend).toHaveBeenCalledTimes(1);
    // Past the window, focus refetches as designed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_COALESCE_MS + 1);
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockGetSpend).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("stops the shared poll when the last pill unmounts", async () => {
    vi.useFakeTimers();
    mockGetSpend.mockResolvedValue(sample(1));
    const { unmount } = renderHook(() => useSpendPill());
    expect(mockGetSpend).toHaveBeenCalledTimes(1); // immediate fetch on first mount
    unmount();
    vi.advanceTimersByTime(SPEND_REFRESH_MS * 2);
    expect(mockGetSpend).toHaveBeenCalledTimes(1); // interval cleared — no further fetches
    vi.useRealTimers();
  });
});
