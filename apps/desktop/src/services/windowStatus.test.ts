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
  type WindowStatusMap,
} from "./windowStatus";
import { setWindowProject } from "./windowRegistry";
import type { AgentTabStatus } from "../types";

function readMap(): WindowStatusMap {
  const raw = localStorage.getItem(WINDOW_STATUS_KEY);
  return raw ? (JSON.parse(raw) as WindowStatusMap) : {};
}

beforeEach(() => {
  localStorage.clear();
  emit.mockClear();
  captured.clear();
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
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
    });
  });
});
