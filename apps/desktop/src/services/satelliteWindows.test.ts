// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Controllable Tauri event module: `satListen` is what onSatellitesChange's `listen(...)` resolves
// from, so a test can make the returned unlisten fn reject with the teardown race (sparkle-6csa).
const { satListen, satUnlisten } = vi.hoisted(() => {
  const satUnlisten = vi.fn();
  return { satUnlisten, satListen: vi.fn(() => Promise.resolve(satUnlisten)) };
});
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: satListen,
}));

import {
  SATELLITE_REGISTRY_KEY,
  claimSatellite,
  isTornOutIn,
  onSatellitesChange,
  pruneSatellites,
  readSatellites,
  releaseSatellite,
  resetSatellites,
  satelliteLabelIn,
  settleSatellite,
  type SatelliteMap,
} from "./satelliteWindows";

function fakeStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    raw: m,
  };
}

describe("satelliteWindows ownership map", () => {
  it("a claim takes the project away from main BEFORE the window exists", () => {
    // The ordering the whole feature rests on: main must stop rendering the panes (and let its
    // PTYs die) before the satellite mounts, so the claim is written with no label yet.
    const s = fakeStore();
    claimSatellite("p1", s);
    expect(isTornOutIn(readSatellites(s), "p1")).toBe(true);
    expect(satelliteLabelIn(readSatellites(s), "p1")).toBeNull();
  });

  it("settling records the label the claim won", () => {
    const s = fakeStore();
    claimSatellite("p1", s);
    settleSatellite("p1", "project-2", s);
    expect(satelliteLabelIn(readSatellites(s), "p1")).toBe("project-2");
  });

  it("a second claim does not downgrade a settled label back to pending", () => {
    // Losing the label would strand the window: re-dock has nothing to call close_project_window
    // with, so the satellite lives on while main has already taken the project back.
    const s = fakeStore();
    claimSatellite("p1", s);
    settleSatellite("p1", "project-1", s);
    claimSatellite("p1", s);
    expect(satelliteLabelIn(readSatellites(s), "p1")).toBe("project-1");
  });

  it("releasing hands the project back; releasing twice is a no-op", () => {
    const s = fakeStore();
    claimSatellite("p1", s);
    settleSatellite("p1", "project-1", s);
    releaseSatellite("p1", s);
    releaseSatellite("p1", s);
    expect(isTornOutIn(readSatellites(s), "p1")).toBe(false);
  });

  it("reset wipes every entry (main's cold-start hygiene)", () => {
    const s = fakeStore();
    settleSatellite("p1", "project-1", s);
    settleSatellite("p2", "project-2", s);
    resetSatellites(s);
    expect(readSatellites(s)).toEqual({});
  });

  it("survives a corrupt or hand-edited blob rather than throwing", () => {
    const s = fakeStore();
    s.raw.set(SATELLITE_REGISTRY_KEY, "{not json");
    expect(readSatellites(s)).toEqual({});
    s.raw.set(SATELLITE_REGISTRY_KEY, "[1,2,3]");
    expect(readSatellites(s)).toEqual({});
  });

  it("drops non-string labels — the blob is durable and shared", () => {
    // A `{p: 3}` reaching close_project_window would be a label of the wrong type; refuse at the
    // read boundary rather than downstream.
    const s = fakeStore();
    s.raw.set(SATELLITE_REGISTRY_KEY, JSON.stringify({ ok: "project-1", bad: 3, pending: null }));
    expect(readSatellites(s)).toEqual({ ok: "project-1", pending: null });
  });
});

describe("pruneSatellites", () => {
  it("drops rows whose window is gone and reports the change", () => {
    const map: SatelliteMap = { p1: "project-1", p2: "project-2" };
    expect(pruneSatellites(map, ["main", "project-1"])).toEqual({ p1: "project-1" });
  });

  it("returns null when nothing changed, so callers can skip the write", () => {
    const map: SatelliteMap = { p1: "project-1" };
    expect(pruneSatellites(map, ["main", "project-1"])).toBeNull();
    expect(pruneSatellites({}, [])).toBeNull();
  });

  it("NEVER prunes a pending claim", () => {
    // A pending claim names a window that does not exist YET, so "not live" is its normal state.
    // Pruning it would hand the project back to main mid-tear-off: main remounts and spawns a PTY,
    // then the satellite lands and spawns a second one for the same agent id.
    const map: SatelliteMap = { p1: null, p2: "project-9" };
    expect(pruneSatellites(map, ["main"])).toEqual({ p1: null });
  });
});

describe("onSatellitesChange", () => {
  it("fires for a write made in THIS window (storage events only reach other windows)", () => {
    const cb = vi.fn();
    const off = onSatellitesChange(cb);
    claimSatellite("p1", fakeStore());
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    claimSatellite("p2", fakeStore());
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires for another window's write, via the storage event on OUR key only", () => {
    const cb = vi.fn();
    const off = onSatellitesChange(cb);
    window.dispatchEvent(new StorageEvent("storage", { key: "sparkle-ui" }));
    expect(cb).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: SATELLITE_REGISTRY_KEY }));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });
});

// ── sparkle-6csa: the Tauri unlisten is routed through safeUnlisten ──────────────────────────────
// onSatellitesChange called Tauri's unlisten RAW in two spots — the "resolved after teardown"
// branch and the returned disposer. Tauri's unlisten is async, so once the listeners map is torn
// down it returns a REJECTED promise rather than throwing; a raw, un-awaited call leaks it as an
// app-level unhandled rejection. safeUnlisten awaits + swallows only that benign race.
//
// Non-vacuity: the unlisten fn is forced to reject with the real teardown-race message and the test
// asserts no such rejection escapes unhandled. Revert either call site to a raw `u()`/`unlisten?.()`
// and the un-awaited rejected promise surfaces on `process`'s unhandledRejection → test fails.
describe("onSatellitesChange teardown routes the Tauri unlisten through safeUnlisten (sparkle-6csa)", () => {
  // A REJECTING unlisten mimicking Tauri's async unlisten on a torn-down listeners map. PLAIN fn,
  // not a vi.fn: a vi.fn attaches its own handler to the promise it returns (for `mock.results`),
  // marking the rejection HANDLED — so a raw dropped call to one never reaches `unhandledRejection`
  // and the test would be vacuous. A plain fn's dropped rejection surfaces, which is the leak.
  // The `as unknown as typeof satUnlisten` cast is compile-time ONLY (the `listen` mock slot is
  // typed `Mock`); it must stay a plain arrow at runtime — do NOT replace it with a vi.fn.
  const rejectingUnlisten = (() =>
    Promise.reject(
      new Error("undefined is not an object (evaluating 'listeners[eventId].handlerId')"),
    )) as unknown as typeof satUnlisten;

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    satListen.mockImplementation(() => Promise.resolve(rejectingUnlisten));
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    satListen.mockImplementation(() => Promise.resolve(satUnlisten));
  });

  async function teardownRaceRejections(trigger: () => void): Promise<unknown[]> {
    const seen: unknown[] = [];
    const handler = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", handler);
    try {
      trigger();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", handler);
    }
    return seen.filter((r) => (r instanceof Error ? r.message : String(r)).includes("handlerId"));
  }

  it("disposer swallows an async teardown-race unlisten", async () => {
    const off = onSatellitesChange(() => {});
    await Promise.resolve(); // let the listen resolve so `unlisten` is stored
    expect(await teardownRaceRejections(() => off())).toHaveLength(0);
  });

  it("teardown-before-listen-resolves swallows an async teardown-race unlisten", async () => {
    // Tear down BEFORE listen's .then runs → the `if (torndown)` branch unlistens the late handle.
    expect(
      await teardownRaceRejections(() => {
        const off = onSatellitesChange(() => {});
        off();
      }),
    ).toHaveLength(0);
  });
});

// `AppBoot` used to call `resetSatellites()` here. That read as cold-start hygiene but ran on every
// mount of <App/> — the error card's "Reload UI" remounts the tree, and so does an HMR update — so
// it handed a LIVE satellite's project back to main while that window was still showing the panes.
// Both webviews then mounted the same agent and raced its PTY. Reconciling against the real window
// list cannot make that mistake, and these pin the difference.
describe("reconcileSatellites at boot", () => {
  const w = window as unknown as Record<string, unknown>;
  let windows: Array<{ label: string }> = [];
  beforeEach(() => {
    w.__TAURI_INTERNALS__ = {};
    localStorage.clear();
    windows = [];
    vi.doMock("@tauri-apps/api/window", () => ({ getAllWindows: () => Promise.resolve(windows) }));
  });
  afterEach(() => {
    delete w.__TAURI_INTERNALS__;
    vi.doUnmock("@tauri-apps/api/window");
    vi.resetModules();
  });

  async function fresh() {
    return await import("./satelliteWindows");
  }

  it("KEEPS a live satellite's row on a main-window reload", async () => {
    const m = await fresh();
    windows = [{ label: "main" }, { label: "project-1" }];
    m.settleSatellite("p1", "project-1");
    await m.reconcileSatellites({ boot: true });
    // The wipe this replaced would have cleared this, and main would have remounted p1's agents
    // while project-1 was still showing them.
    expect(m.isTornOut("p1")).toBe(true);
  });

  it("clears a stranded row when no satellite window exists at all", async () => {
    const m = await fresh();
    windows = [{ label: "main" }];
    m.settleSatellite("p1", "project-1");
    await m.reconcileSatellites({ boot: true });
    expect(m.isTornOut("p1")).toBe(false);
  });

  it("clears a stranded PENDING row at boot — normally protected, but nothing is in flight", async () => {
    // A process that died between the claim and the build leaves a pending row that ordinary
    // pruning refuses to touch (it looks like a tear-off still building), stranding the project.
    const m = await fresh();
    windows = [{ label: "main" }];
    m.claimSatellite("p1");
    await m.reconcileSatellites({ boot: true });
    expect(m.isTornOut("p1")).toBe(false);
  });

  it("still protects a PENDING row when some other satellite is live", async () => {
    // p2 is mid-tear-off while p1 already has a window. Dropping p2 here would hand it back to main,
    // which remounts and spawns PTYs the arriving satellite is about to spawn again.
    const m = await fresh();
    windows = [{ label: "main" }, { label: "project-1" }];
    m.settleSatellite("p1", "project-1");
    m.claimSatellite("p2");
    await m.reconcileSatellites({ boot: true });
    expect(m.isTornOut("p2")).toBe(true);
  });

  it("without boot, prunes dead rows but never pending ones", async () => {
    const m = await fresh();
    windows = [{ label: "main" }];
    m.settleSatellite("p1", "project-9");
    m.claimSatellite("p2");
    await m.reconcileSatellites();
    expect(m.isTornOut("p1")).toBe(false);
    expect(m.isTornOut("p2")).toBe(true);
  });
});
