// @vitest-environment jsdom
//
// The capture half of window-session restore (): each project window writes its geometry
// + focus watermark to the durable snapshot; an in-window Replace drops the old project's entry so
// restore doesn't resurrect a separate window for it. The Tauri window is mocked so geometry capture
// runs under jsdom (the real geometry path is exercised in the app itself).
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowSessionCapture } from "./WindowSessionCapture";
import { readWindowSessions, saveWindowSession, removeWindowSession } from "./services/windowSession";

// A bit longer than the component's 400ms capture debounce, so a scheduled capture has fired.
const CAPTURE_DEBOUNCE_WAIT_MS = 550;

// A PhysicalPosition/PhysicalSize stand-in whose toLogical(scale) divides by the scale factor.
function physical<A extends string, B extends string>(a: number, b: number, ka: A, kb: B) {
  return { [ka]: a, [kb]: b, toLogical: (s: number) => ({ [ka]: a / s, [kb]: b / s }) };
}

// Captured move/resize handlers + a mutable position so a test can simulate the window moving and
// assert the debounced re-capture picks up the new geometry.
const moveHandlers = vi.hoisted(() => [] as Array<() => void>);
const pos = vi.hoisted(() => ({ x: 200, y: 120 }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    scaleFactor: async () => 2,
    outerPosition: async () => physical(pos.x, pos.y, "x", "y"), // → logical /2
    innerSize: async () => physical(2400, 1600, "width", "height"), // → logical 1200,800
    onMoved: async (cb: () => void) => {
      moveHandlers.push(cb);
      return () => {};
    },
    onResized: async () => () => {},
  }),
}));

beforeEach(() => {
  localStorage.clear();
  moveHandlers.length = 0;
  pos.x = 200;
  pos.y = 120;
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("useWindowSessionCapture", () => {
  it("writes this window's logical geometry to the snapshot on mount", async () => {
    renderHook(({ projectId }) => useWindowSessionCapture(projectId, true), {
      initialProps: { projectId: "p1" },
    });
    await waitFor(() => expect(readWindowSessions().p1).toBeTruthy());
    const e = readWindowSessions().p1;
    expect(e).toMatchObject({ projectId: "p1", isMain: true, x: 100, y: 60, width: 1200, height: 800 });
  });

  it("stamps focusedAt when the window is focused on mount", async () => {
    renderHook(() => useWindowSessionCapture("p1", false));
    await waitFor(() => expect(readWindowSessions().p1?.focusedAt).toBeGreaterThan(0));
  });

  it("bumps focusedAt on a later window focus event", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    renderHook(() => useWindowSessionCapture("p1", false));
    await waitFor(() => expect(readWindowSessions().p1).toBeTruthy());
    expect(readWindowSessions().p1?.focusedAt).toBe(0);
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(readWindowSessions().p1?.focusedAt).toBeGreaterThan(0));
  });

  it("drops the old entry when the window replaces its project (in-window Replace)", async () => {
    const { rerender } = renderHook(({ projectId }) => useWindowSessionCapture(projectId, true), {
      initialProps: { projectId: "p1" },
    });
    await waitFor(() => expect(readWindowSessions().p1).toBeTruthy());
    // A sibling window's unrelated entry must survive the Replace cleanup.
    saveWindowSession({ projectId: "other", isMain: false, x: 0, y: 0, width: 900, height: 600, focusedAt: 5 });

    rerender({ projectId: "p2" });
    await waitFor(() => expect(readWindowSessions().p2).toBeTruthy());
    const all = readWindowSessions();
    expect(all.p1).toBeUndefined(); // replaced-away project dropped
    expect(all.other).toBeTruthy(); // sibling untouched
  });

  it("no-ops without a project (nothing to restore)", async () => {
    renderHook(() => useWindowSessionCapture(null, true));
    await new Promise((r) => setTimeout(r, 10));
    expect(readWindowSessions()).toEqual({});
  });

  it("drops the entry when the window loses its project entirely (project → null)", async () => {
    const { rerender } = renderHook(({ projectId }) => useWindowSessionCapture(projectId, true), {
      initialProps: { projectId: "p1" as string | null },
    });
    await waitFor(() => expect(readWindowSessions().p1).toBeTruthy());
    rerender({ projectId: null });
    await waitFor(() => expect(readWindowSessions().p1).toBeUndefined());
  });

  it("re-captures geometry after a debounced move", async () => {
    renderHook(() => useWindowSessionCapture("p1", true));
    await waitFor(() => expect(readWindowSessions().p1?.x).toBe(100));
    // The window moved; fire the captured onMoved handler and let the debounce settle.
    pos.x = 900; // → logical 450
    act(() => moveHandlers.forEach((h) => h()));
    await waitFor(() => expect(readWindowSessions().p1?.x).toBe(450), { timeout: 1500 });
  });

  it("a stray debounced capture does NOT resurrect an entry removed by an explicit close (roborev 36136)", async () => {
    renderHook(() => useWindowSessionCapture("p1", true));
    await waitFor(() => expect(readWindowSessions().p1).toBeTruthy());
    // Simulate Workspace.finishClose removing the entry, then a move whose debounced capture fires
    // during the window's destroy() teardown — it must not re-create the entry the user just closed.
    removeWindowSession("p1");
    act(() => moveHandlers.forEach((h) => h()));
    await new Promise((r) => setTimeout(r, CAPTURE_DEBOUNCE_WAIT_MS));
    expect(readWindowSessions().p1).toBeUndefined();
  });
});
