// @vitest-environment jsdom
//
// The Tauri-side restore orchestration (): given the persisted snapshot it recreates the
// non-main project windows, focuses the last-active one, and is idempotent per process. Tauri +
// createProjectWindow are mocked so the branching/retry logic runs under jsdom.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Records createProjectWindow calls and registers each spawned window in the (real) registry under a
// deterministic label so focusTarget's findWindowForProject → getByLabel path resolves it.
const created = vi.hoisted(() => [] as Array<{ projectId: string; suppressFocus: boolean; label: string }>);
const knownLabels = vi.hoisted(() => new Set<string>());
const focused = vi.hoisted(() => ({ main: 0, labels: [] as string[] }));
// getByLabel returns null for this many calls before resolving, to exercise focusTarget's retry.
const getByLabelNullsFor = vi.hoisted(() => ({ n: 0 }));

vi.mock("./projectWindows", async () => {
  const actual = await vi.importActual<typeof import("./windowRegistry")>("./windowRegistry");
  return {
    createProjectWindow: (projectId: string, _agentId?: string, _geometry?: unknown, suppressFocus = false) => {
      const label = `win-${projectId}`;
      actual.setWindowProject(label, projectId);
      knownLabels.add(label);
      created.push({ projectId, suppressFocus, label });
    },
  };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setPosition: async () => {},
    setSize: async () => {},
    setFocus: async () => void focused.main++,
  }),
  availableMonitors: async () => [],
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: async (label: string) => {
      if (getByLabelNullsFor.n > 0) {
        getByLabelNullsFor.n--;
        return null;
      }
      return knownLabels.has(label)
        ? { show: async () => {}, setFocus: async () => void focused.labels.push(label) }
        : null;
    },
  },
}));

import { runWindowRestore, __resetWindowRestoreForTest } from "./windowRestoreRun";
import type { WindowSessionEntry } from "./windowSession";
import { useProjectStore } from "../stores/projectStore";
import type { Project } from "../types";

function entry(over: Partial<WindowSessionEntry> = {}): WindowSessionEntry {
  return { projectId: "p1", isMain: false, x: 0, y: 0, width: 1200, height: 800, focusedAt: 1, ...over };
}
const setLive = (...ids: string[]) =>
  useProjectStore.setState({ projects: ids.map((id) => ({ id, name: id, agents: [] })) as unknown as Project[] });

beforeEach(() => {
  localStorage.clear();
  created.length = 0;
  knownLabels.clear();
  focused.main = 0;
  focused.labels = [];
  getByLabelNullsFor.n = 0;
  __resetWindowRestoreForTest();
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  useProjectStore.setState({ projects: [] });
  vi.restoreAllMocks();
});

describe("runWindowRestore", () => {
  it("creates a child window for every non-main surviving project", async () => {
    setLive("p1", "p2", "p3");
    await runWindowRestore({
      p1: entry({ projectId: "p1", isMain: true, focusedAt: 9 }),
      p2: entry({ projectId: "p2", focusedAt: 5 }),
      p3: entry({ projectId: "p3", focusedAt: 3 }),
    });
    expect(created.map((c) => c.projectId).sort()).toEqual(["p2", "p3"]);
  });

  it("suppresses self-focus on every restored child except the focus target", async () => {
    setLive("p1", "p2", "p3");
    await runWindowRestore({
      p1: entry({ projectId: "p1", isMain: true, focusedAt: 2 }),
      p2: entry({ projectId: "p2", focusedAt: 99 }), // last-active → focus target
      p3: entry({ projectId: "p3", focusedAt: 1 }),
    });
    expect(created.find((c) => c.projectId === "p2")?.suppressFocus).toBe(false);
    expect(created.find((c) => c.projectId === "p3")?.suppressFocus).toBe(true);
  });

  it("focuses the main window when it is the last-active", async () => {
    setLive("p1", "p2");
    await runWindowRestore({
      p1: entry({ projectId: "p1", isMain: true, focusedAt: 100 }),
      p2: entry({ projectId: "p2", focusedAt: 1 }),
    });
    expect(focused.main).toBeGreaterThan(0);
    expect(focused.labels).toEqual([]);
  });

  it("focuses the child window when a child is the last-active", async () => {
    setLive("p1", "p2");
    await runWindowRestore({
      p1: entry({ projectId: "p1", isMain: true, focusedAt: 1 }),
      p2: entry({ projectId: "p2", focusedAt: 100 }),
    });
    expect(focused.labels).toContain("win-p2");
  });

  it("retries getByLabel until the child window exists, then focuses it", async () => {
    setLive("p1", "p2");
    getByLabelNullsFor.n = 3; // first 3 lookups return null, 4th resolves
    await runWindowRestore({
      p1: entry({ projectId: "p1", isMain: true, focusedAt: 1 }),
      p2: entry({ projectId: "p2", focusedAt: 100 }),
    });
    expect(focused.labels).toContain("win-p2");
  });

  it("is idempotent — a second call spawns no further windows", async () => {
    setLive("p1", "p2");
    const sessions = {
      p1: entry({ projectId: "p1", isMain: true, focusedAt: 9 }),
      p2: entry({ projectId: "p2", focusedAt: 5 }),
    };
    await runWindowRestore(sessions);
    await runWindowRestore(sessions);
    expect(created.map((c) => c.projectId)).toEqual(["p2"]); // only one child, not two
  });

  it("no-ops when there is nothing to restore", async () => {
    setLive("p1");
    await runWindowRestore({});
    expect(created).toEqual([]);
    expect(focused.main).toBe(0);
  });

  it("no-ops outside Tauri", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    setLive("p1", "p2");
    await runWindowRestore({
      p1: entry({ projectId: "p1", isMain: true }),
      p2: entry({ projectId: "p2" }),
    });
    expect(created).toEqual([]);
  });
});
