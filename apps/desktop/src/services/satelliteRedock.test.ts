// @vitest-environment jsdom
//
// `reclaimProject` — main bringing a torn-out project home.
//
// The naive implementation (destroy the window, then release) is what shipped first and it ORPHANS A
// PROCESS: `close_project_window` calls `Window::destroy`, a destroyed webview runs no React
// cleanup, so the satellite's Terminal never unmounts, never calls `transport.detach()` (which for a
// local agent IS `kill()`), and main then respawns the same agent ids over children nobody holds a
// handle to. So main ASKS first and only forces the window closed when nothing answers.
//
// These tests are about which of those two paths runs, and in what order.
import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeSpy = vi.hoisted(() => vi.fn(() => Promise.resolve(null as unknown)));
const emitSpy = vi.hoisted(() => vi.fn((_name: string, _payload?: unknown) => Promise.resolve()));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeSpy }));
// reclaimProject now asks whether the label is even live before spending the timeout on it.
const liveWindows = vi.hoisted(() => ({ current: [] as Array<{ label: string }> }));
vi.mock("@tauri-apps/api/window", () => ({
  getAllWindows: vi.fn(() => Promise.resolve(liveWindows.current)),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: emitSpy,
  listen: () => Promise.resolve(() => {}),
}));

import {
  REDOCK_RETRY_MS,
  REDOCK_TIMEOUT_MS,
  SATELLITE_REDOCK_EVENT,
  isTornOut,
  reclaimProject,
  releaseSatellite,
  settleSatellite,
} from "./satelliteWindows";

beforeEach(() => {
  localStorage.clear();
  invokeSpy.mockClear();
  emitSpy.mockClear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  // Default: the satellite this project points at is on screen.
  liveWindows.current = [{ label: "main" }, { label: "project-1" }, { label: "project-2" }, { label: "project-3" }];
});

describe("reclaimProject", () => {
  it("asks the satellite to re-dock itself and does NOT destroy the window when it complies", async () => {
    settleSatellite("p1", "project-1");
    // Stand in for the satellite: it answers the broadcast by running its own ordered teardown,
    // whose last act before `destroy` is releasing the project.
    emitSpy.mockImplementationOnce(async (name: string) => {
      expect(name).toBe(SATELLITE_REDOCK_EVENT);
      releaseSatellite("p1");
    });

    await reclaimProject("p1");

    expect(isTornOut("p1")).toBe(false);
    // The whole point: no forced destroy, so the satellite got to kill its own PTYs first.
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("forces the window closed when the satellite never answers", async () => {
    vi.useFakeTimers();
    settleSatellite("p1", "project-3");
    const done = reclaimProject("p1");
    await vi.advanceTimersByTimeAsync(REDOCK_TIMEOUT_MS + 10);
    await done;
    vi.useRealTimers();

    // A wedged webview has probably already lost its React tree, so its PTYs may leak — but leaving
    // the project owned by a window that cannot render it means NO window renders it, which is worse.
    expect(invokeSpy).toHaveBeenCalledWith("close_project_window", { label: "project-3" });
    expect(isTornOut("p1")).toBe(false);
  });

  it("releases anyway when the forced close itself fails", async () => {
    vi.useFakeTimers();
    settleSatellite("p1", "project-2");
    invokeSpy.mockRejectedValueOnce(new Error("window is gone"));
    const done = reclaimProject("p1");
    await vi.advanceTimersByTimeAsync(REDOCK_TIMEOUT_MS + 10);
    await done;
    vi.useRealTimers();
    expect(isTornOut("p1")).toBe(false);
  });

  it("releases a PENDING claim with no event and no close — there is no window yet", async () => {
    // This is the rolled-back tear-off: the claim landed, the window failed to build.
    const { claimSatellite } = await import("./satelliteWindows");
    claimSatellite("p1");
    // Every ownership WRITE emits the changed-event, so clear first — otherwise this asserts against
    // the claim's own broadcast rather than against a re-dock request.
    emitSpy.mockClear();
    await reclaimProject("p1");
    expect(isTornOut("p1")).toBe(false);
    // The release itself broadcasts a changed-event, which is correct — what must NOT happen is a
    // re-dock request or a window close, since there is no window to address.
    expect(emitSpy).not.toHaveBeenCalledWith(SATELLITE_REDOCK_EVENT, expect.anything());
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("is a no-op for a project main already owns", async () => {
    await reclaimProject("p1");
    expect(emitSpy).not.toHaveBeenCalled();
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});

describe("reclaimProject — the races the handshake introduced", () => {
  it("skips the wait entirely when the row points at a window that is already gone", async () => {
    // Force-quit / crashed satellite. This is the COMMON stale case, and it used to pay the full
    // 2.5s timeout — a button that looks broken for two and a half seconds.
    settleSatellite("p1", "project-4");
    liveWindows.current = [{ label: "main" }];
    const started = Date.now();
    await reclaimProject("p1");
    expect(isTornOut("p1")).toBe(false);
    expect(invokeSpy).not.toHaveBeenCalled(); // nothing to close
    expect(Date.now() - started).toBeLessThan(REDOCK_TIMEOUT_MS);
  });

  it("repeats the request, so a satellite that mounts late still hears it", async () => {
    vi.useFakeTimers();
    settleSatellite("p1", "project-1");
    const done = reclaimProject("p1");
    // Tauri does not buffer events for a webview that has not called `listen` yet, and main puts
    // "Bring it back here" in front of the user before the satellite's tree has mounted. A single
    // emit into that gap is lost and the timeout then force-destroys a fully-mounted satellite.
    await vi.advanceTimersByTimeAsync(REDOCK_RETRY_MS * 3);
    expect(emitSpy.mock.calls.filter((c) => c[0] === SATELLITE_REDOCK_EVENT).length).toBeGreaterThan(1);
    // The late listener finally answers.
    releaseSatellite("p1");
    await vi.advanceTimersByTimeAsync(10);
    await done;
    vi.useRealTimers();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("does not close a STALE label whose pool slot another project has since taken", async () => {
    // The 2.5s wait is long enough for the satellite to die just after the timeout fires, freeing
    // project-1 for a different project's tear-off. Closing the label captured before the wait
    // would Window::destroy someone else's satellite with live Terminals in it — the orphaned-PTY
    // case, caused by the code that exists to prevent it.
    vi.useFakeTimers();
    settleSatellite("p1", "project-1");
    const done = reclaimProject("p1");
    // Mid-wait the world moves: p1 comes home by itself and p2 grabs the freed slot.
    releaseSatellite("p1");
    settleSatellite("p2", "project-1");
    await vi.advanceTimersByTimeAsync(REDOCK_TIMEOUT_MS + 10);
    await done;
    vi.useRealTimers();
    expect(invokeSpy).not.toHaveBeenCalled();
    // p2's brand-new satellite is untouched.
    expect(isTornOut("p2")).toBe(true);
  });

  it("forces the CURRENT label, not the one captured before the wait", async () => {
    vi.useFakeTimers();
    settleSatellite("p1", "project-1");
    const done = reclaimProject("p1");
    // The satellite moved slots (a crash-and-respawn); the row is authoritative, our local is not.
    settleSatellite("p1", "project-3");
    await vi.advanceTimersByTimeAsync(REDOCK_TIMEOUT_MS + 10);
    await done;
    vi.useRealTimers();
    expect(invokeSpy).toHaveBeenCalledWith("close_project_window", { label: "project-3" });
  });
});

describe("reclaimProject — the fast path has the same stale-label exposure", () => {
  it("does not release when the row moved while the liveness query was in flight", async () => {
    // `windowExists` awaits a dynamic import plus an IPC round trip. Shorter window than the 2.5s
    // wait, identical failure: releasing a row that moved hands back a project a LIVE satellite is
    // rendering (or drops a pending row mid-tear-off, which double-spawns its PTYs).
    settleSatellite("p1", "project-4");
    liveWindows.current = [{ label: "main" }];
    // The row moves as soon as anyone asks for the window list — i.e. during the await.
    const original = liveWindows.current;
    // Cast through unknown: only `.label` is read, and a real Tauri `Window` has ~80 other members
    // there is no value in constructing here.
    const mod = (await import("@tauri-apps/api/window")) as unknown as {
      getAllWindows: { mockImplementationOnce: (f: () => Promise<Array<{ label: string }>>) => void };
    };
    mod.getAllWindows.mockImplementationOnce(async () => {
      settleSatellite("p1", "project-2");
      return original;
    });

    await reclaimProject("p1");

    // Still torn out: the stale answer said nothing about the window that owns it NOW.
    expect(isTornOut("p1")).toBe(true);
  });
});
