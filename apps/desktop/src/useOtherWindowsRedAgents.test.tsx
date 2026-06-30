// @vitest-environment jsdom
/**
 * useOtherWindowsRedAgents selector tests. jsdom + renderHook. We mock @tauri-apps/api/event
 * (capture the status-changed listener so we can fire it) and set __TAURI_INTERNALS__ so the
 * hook takes the in-Tauri subscribe path. The status channel writes localStorage synchronously,
 * so firing the captured listener drives the recompute.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const captured = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    captured.set(name, cb);
    return Promise.resolve(() => {});
  },
}));

import { useOtherWindowsRedAgentsFor } from "./useOtherWindowsRedAgents";
import {
  publishWindowRedAgents,
  STATUS_CHANGED_EVENT,
  WINDOW_STATUS_KEY,
} from "./services/windowStatus";
import {
  setWindowProject,
  clearWindowProject,
  WINDOW_REGISTRY_KEY,
} from "./services/windowRegistry";

beforeEach(() => {
  localStorage.clear();
  captured.clear();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

/** Simulate the cross-window broadcast arriving in this window. */
function fireStatusChanged(): void {
  captured.get(STATUS_CHANGED_EVENT)?.({ payload: undefined });
}

describe("useOtherWindowsRedAgents", () => {
  it("returns [] when there are no other red agents", () => {
    const { result } = renderHook(() => useOtherWindowsRedAgentsFor("main"));
    expect(result.current).toEqual([]);
  });

  it("updates when a status-changed event arrives", () => {
    setWindowProject("win-B", "projB");
    const { result } = renderHook(() => useOtherWindowsRedAgentsFor("main"));
    expect(result.current).toEqual([]);

    act(() => {
      publishWindowRedAgents("win-B", "projB", "Proj B", [
        { id: "a1", name: "One", status: "waiting" },
      ]);
      fireStatusChanged();
    });

    expect(result.current.map((x) => x.agentId)).toEqual(["a1"]);
    expect(result.current[0]?.projectName).toBe("Proj B");
  });

  it("auto-removes a row when the entry's agents go empty", () => {
    setWindowProject("win-B", "projB");
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "a1", name: "One", status: "waiting" },
    ]);
    const { result } = renderHook(() => useOtherWindowsRedAgentsFor("main"));
    expect(result.current).toHaveLength(1);

    act(() => {
      publishWindowRedAgents("win-B", "projB", "Proj B", []);
      fireStatusChanged();
    });

    expect(result.current).toEqual([]);
  });

  it("recomputes on a storage event (non-Tauri fan-out path)", () => {
    // No Tauri internals: the storage listener is the only update mechanism (dev/web harness).
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    setWindowProject("win-B", "projB");
    const { result } = renderHook(() => useOtherWindowsRedAgentsFor("main"));
    expect(result.current).toEqual([]);

    act(() => {
      publishWindowRedAgents("win-B", "projB", "Proj B", [
        { id: "a1", name: "One", status: "waiting" },
      ]);
      window.dispatchEvent(new StorageEvent("storage", { key: WINDOW_STATUS_KEY }));
    });
    expect(result.current.map((x) => x.agentId)).toEqual(["a1"]);

    // A registry-key change (a window opening/closing) also drives a recompute.
    act(() => {
      clearWindowProject("win-B");
      window.dispatchEvent(new StorageEvent("storage", { key: WINDOW_REGISTRY_KEY }));
    });
    expect(result.current).toEqual([]);
  });

  it("ignores a storage event for an unrelated key", () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    setWindowProject("win-B", "projB");
    const { result } = renderHook(() => useOtherWindowsRedAgentsFor("main"));

    act(() => {
      publishWindowRedAgents("win-B", "projB", "Proj B", [
        { id: "a1", name: "One", status: "waiting" },
      ]);
      // Unrelated key → no recompute; the hook keeps its (empty) snapshot.
      window.dispatchEvent(new StorageEvent("storage", { key: "some-other-key" }));
    });
    expect(result.current).toEqual([]);
  });

  it("drops rows when the owning window closes", () => {
    setWindowProject("win-B", "projB");
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "a1", name: "One", status: "errored" },
    ]);
    const { result } = renderHook(() => useOtherWindowsRedAgentsFor("main"));
    expect(result.current).toHaveLength(1);

    act(() => {
      // Window B closed: its registry entry is gone, so the still-present status entry is stale.
      clearWindowProject("win-B");
      fireStatusChanged();
    });

    expect(result.current).toEqual([]);
  });
});
