/**
 * windowStatus tests — node env (mirrors crossWindowSync.test.ts). We mock
 * @tauri-apps/api/event (capture listeners + spy emit) and shim a minimal `window`
 * with __TAURI_INTERNALS__ so the in-Tauri emit path is exercised without a webview.
 *
 * The cross-window OPEN-window check reads the windowRegistry (same localStorage), so
 * tests register windows with setWindowProject to mark them "open".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const emit = vi.fn();
const captured = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...a: unknown[]) => emit(...a),
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    captured.set(name, cb);
    return Promise.resolve(() => {});
  },
}));

import {
  WINDOW_STATUS_KEY,
  STATUS_CHANGED_EVENT,
  isRedStatus,
  publishWindowRedAgents,
  clearWindowStatus,
  resetWindowStatus,
  readOtherWindowsRedAgents,
  readOtherWindowsRedGroups,
  type WindowStatusMap,
} from "./windowStatus";
import { setWindowProject } from "./windowRegistry";
import type { AgentTabStatus } from "../types";

// Each window now owns its own `sparkle-window-status:<label>` key (sparkle-csq2) instead of every
// window read-modify-writing one shared blob. Reassemble the map from the per-window keys so these
// tests keep asserting the same observable behavior.
function readMap(): WindowStatusMap {
  const out: WindowStatusMap = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(`${WINDOW_STATUS_KEY}:`)) continue;
    const raw = localStorage.getItem(k);
    if (raw) out[k.slice(WINDOW_STATUS_KEY.length + 1)] = JSON.parse(raw);
  }
  return out;
}

beforeEach(() => {
  localStorage.clear();
  emit.mockClear();
  captured.clear();
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false, // windowRegistry.write broadcasts a local change event on write
    __TAURI_INTERNALS__: {},
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("isRedStatus", () => {
  it("includes the red-color statuses and excludes the rest", () => {
    const red: AgentTabStatus[] = ["waiting", "approval", "errored"];
    const notRed: AgentTabStatus[] = ["working", "idle", "done", "blocked", "stopped"];
    for (const s of red) expect(isRedStatus(s)).toBe(true);
    for (const s of notRed) expect(isRedStatus(s)).toBe(false);
  });
});

describe("publishWindowRedAgents", () => {
  it("writes ONLY this window's entry (containing its red agents)", () => {
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "a1", name: "Agent One", status: "waiting" },
    ]);
    const map = readMap();
    expect(Object.keys(map)).toEqual(["win-B"]);
    expect(map["win-B"]).toEqual({
      projectId: "projB",
      projectName: "Proj B",
      agents: [{ id: "a1", name: "Agent One", status: "waiting" }],
    });
  });

  it("does not disturb other windows' entries", () => {
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "a1", name: "One", status: "waiting" },
    ]);
    publishWindowRedAgents("win-C", "projC", "Proj C", [
      { id: "a2", name: "Two", status: "errored" },
    ]);
    expect(Object.keys(readMap()).sort()).toEqual(["win-B", "win-C"]);
  });

  it("deletes this window's entry when the red set is empty", () => {
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "a1", name: "One", status: "waiting" },
    ]);
    expect(readMap()["win-B"]).toBeDefined();
    publishWindowRedAgents("win-B", "projB", "Proj B", []);
    expect(readMap()["win-B"]).toBeUndefined();
    expect(readMap()).toEqual({});
  });

  it("emits the status-changed event (debounced) in Tauri", async () => {
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "a1", name: "One", status: "waiting" },
    ]);
    // Debounced ~250ms; let it fire.
    await new Promise((r) => setTimeout(r, 300));
    expect(emit).toHaveBeenCalledWith(STATUS_CHANGED_EVENT);
  });
});

describe("clearWindowStatus", () => {
  it("removes this window's entry and emits", () => {
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "a1", name: "One", status: "waiting" },
    ]);
    emit.mockClear();
    clearWindowStatus("win-B");
    expect(readMap()["win-B"]).toBeUndefined();
    expect(emit).toHaveBeenCalledWith(STATUS_CHANGED_EVENT);
  });
});

describe("resetWindowStatus", () => {
  it("wipes the whole map (main cold-start stale wipe)", () => {
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "a1", name: "One", status: "waiting" },
    ]);
    publishWindowRedAgents("win-C", "projC", "Proj C", [
      { id: "a2", name: "Two", status: "errored" },
    ]);
    resetWindowStatus();
    expect(readMap()).toEqual({});
  });
});

describe("readOtherWindowsRedAgents", () => {
  it("returns [] when there are no entries", () => {
    expect(readOtherWindowsRedAgents("main")).toEqual([]);
  });

  it("excludes the caller's own label", () => {
    setWindowProject("main", "projA");
    publishWindowRedAgents("main", "projA", "Proj A", [
      { id: "a0", name: "Mine", status: "waiting" },
    ]);
    expect(readOtherWindowsRedAgents("main")).toEqual([]);
  });

  it("excludes entries whose window is no longer open (not in registry)", () => {
    // win-B published but its window is NOT registered -> treated as closed/stale.
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "a1", name: "One", status: "waiting" },
    ]);
    expect(readOtherWindowsRedAgents("main")).toEqual([]);
  });

  it("excludes a stale entry when a DIFFERENT live window now shows its project (crash + Replace)", () => {
    // win-B published red agents for projB, then crashed (its registry row never cleared from THIS
    // test's POV we just never register it). Meanwhile main was "Replaced" onto projB. A project-
    // keyed liveness check would wrongly keep win-B; the label-keyed check drops it.
    setWindowProject("main", "projB");
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "b1", name: "Ghost", status: "waiting" },
    ]);
    expect(readOtherWindowsRedAgents("main")).toEqual([]);
  });

  it("flattens open other-window entries and sorts by attention rank, project, name", () => {
    setWindowProject("win-B", "projB");
    setWindowProject("win-C", "projC");
    // win-B: an errored (lower rank) agent; win-C: two attention-rank agents.
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "b1", name: "Berr", status: "errored" },
    ]);
    publishWindowRedAgents("win-C", "projC", "Proj C", [
      { id: "c2", name: "Zeta", status: "approval" },
      { id: "c1", name: "Alpha", status: "waiting" },
    ]);
    const got = readOtherWindowsRedAgents("main");
    // waiting/approval (rank 0) come before errored (rank 1); within rank, by project then name.
    expect(got.map((x) => x.agentId)).toEqual(["c1", "c2", "b1"]);
    expect(got[0]).toEqual({
      windowLabel: "win-C",
      projectId: "projC",
      projectName: "Proj C",
      agentId: "c1",
      agentName: "Alpha",
      status: "waiting",
      since: 0, // publishWindowRedAgents above didn't stamp a `since` → coerced to 0
    });
  });

  it("carries the published `since` through and coerces a missing/invalid one to 0", () => {
    setWindowProject("win-B", "projB");
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "s1", name: "Stamped", status: "waiting", since: 1234 },
      // Simulate an old-build blob item with no `since`.
      { id: "s2", name: "Legacy", status: "waiting" } as never,
    ]);
    const got = readOtherWindowsRedAgents("main");
    const s1 = got.find((x) => x.agentId === "s1");
    const s2 = got.find((x) => x.agentId === "s2");
    expect(s1?.since).toBe(1234);
    expect(s2?.since).toBe(0);
  });
});

describe("readOtherWindowsRedGroups", () => {
  it("collapses a window with N>1 red agents to ONE group with count=N and the most-recent representative", () => {
    setWindowProject("win-B", "projB");
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "b1", name: "Older", status: "waiting", since: 100 },
      { id: "b2", name: "Newest", status: "waiting", since: 300 },
      { id: "b3", name: "Middle", status: "waiting", since: 200 },
    ]);
    const groups = readOtherWindowsRedGroups("main");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(3);
    // Representative = the largest `since`.
    expect(groups[0]?.agent.agentId).toBe("b2");
    expect(groups[0]?.windowLabel).toBe("win-B");
    expect(groups[0]?.projectName).toBe("Proj B");
  });

  it("gives a single-red-agent window count=1 (badge would be 0)", () => {
    setWindowProject("win-B", "projB");
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "b1", name: "Solo", status: "waiting", since: 100 },
    ]);
    const groups = readOtherWindowsRedGroups("main");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(1);
    expect(groups[0]?.agent.agentId).toBe("b1");
  });

  it("sorts groups by attentionRank, then representative `since` desc, then projectName", () => {
    setWindowProject("win-B", "projB");
    setWindowProject("win-C", "projC");
    setWindowProject("win-D", "projD");
    // win-B: errored (rank 1) — should sort LAST despite a very recent timestamp.
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      { id: "b1", name: "Berr", status: "errored", since: 999 },
    ]);
    // win-C: waiting (rank 0), representative since=200.
    publishWindowRedAgents("win-C", "projC", "Proj C", [
      { id: "c1", name: "Cwait", status: "waiting", since: 200 },
    ]);
    // win-D: approval (rank 0), representative since=500 → most recent rank-0 → first.
    publishWindowRedAgents("win-D", "projD", "Proj D", [
      { id: "d1", name: "Dappr", status: "approval", since: 500 },
    ]);
    const groups = readOtherWindowsRedGroups("main");
    expect(groups.map((g) => g.windowLabel)).toEqual(["win-D", "win-C", "win-B"]);
  });

  it("tolerates items missing `since` (treated as 0) when picking the representative", () => {
    setWindowProject("win-B", "projB");
    publishWindowRedAgents("win-B", "projB", "Proj B", [
      // Both effectively since=0; tie breaks by attentionRank then agentName. "Aaa" wins on name.
      { id: "b1", name: "Zzz", status: "waiting" } as never,
      { id: "b2", name: "Aaa", status: "waiting" } as never,
    ]);
    const groups = readOtherWindowsRedGroups("main");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.agent.since).toBe(0);
    expect(groups[0]?.agent.agentId).toBe("b2"); // "Aaa" < "Zzz"
  });
});
