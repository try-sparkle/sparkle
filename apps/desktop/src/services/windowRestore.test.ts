import { describe, it, expect } from "vitest";
import { planWindowRestore, clampToMonitors, type MonitorRect } from "./windowRestore";
import type { WindowSessionEntry } from "./windowSession";

function entry(over: Partial<WindowSessionEntry> = {}): WindowSessionEntry {
  return { projectId: "p1", isMain: false, x: 100, y: 100, width: 1200, height: 800, focusedAt: 1, ...over };
}

const ONE_MONITOR: MonitorRect[] = [{ x: 0, y: 0, width: 3000, height: 2000 }];

describe("clampToMonitors", () => {
  it("leaves an on-screen window untouched", () => {
    const g = { x: 100, y: 100, width: 1200, height: 800 };
    expect(clampToMonitors(g, ONE_MONITOR)).toEqual(g);
  });

  it("re-homes a fully off-screen window onto a monitor", () => {
    // Saved on a now-unplugged external monitor to the right.
    const g = { x: 5000, y: 400, width: 1200, height: 800 };
    const out = clampToMonitors(g, ONE_MONITOR);
    // Fully inside the remaining monitor.
    expect(out.x).toBeGreaterThanOrEqual(0);
    expect(out.x + out.width).toBeLessThanOrEqual(3000);
    expect(out.y + out.height).toBeLessThanOrEqual(2000);
  });

  it("shrinks a window larger than the target monitor to fit", () => {
    const g = { x: -500, y: -500, width: 4000, height: 3000 };
    const out = clampToMonitors(g, [{ x: 0, y: 0, width: 1440, height: 900 }]);
    expect(out.width).toBe(1440);
    expect(out.height).toBe(900);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });

  it("keeps a window that is only partially — but sufficiently — on-screen", () => {
    // 300px of width and full height overlap the monitor: reachable, leave as-is.
    const g = { x: -900, y: 100, width: 1200, height: 800 };
    expect(clampToMonitors(g, ONE_MONITOR)).toEqual(g);
  });

  it("returns geometry unchanged when there are no monitors", () => {
    const g = { x: 9999, y: 9999, width: 1200, height: 800 };
    expect(clampToMonitors(g, [])).toEqual(g);
  });

  it("re-homes onto the best-overlap monitor in a multi-monitor layout", () => {
    const left: MonitorRect = { x: 0, y: 0, width: 1000, height: 1000 };
    const right: MonitorRect = { x: 1000, y: 0, width: 1000, height: 1000 };
    // Title bar above the screen top (y=-500) → not reachable; body sits over the RIGHT monitor.
    const g = { x: 1200, y: -500, width: 400, height: 800 };
    const out = clampToMonitors(g, [left, right]);
    // Re-homed onto the right monitor (x within its range), fully on-screen.
    expect(out.x).toBeGreaterThanOrEqual(1000);
    expect(out.x + out.width).toBeLessThanOrEqual(2000);
    expect(out.y).toBeGreaterThanOrEqual(0);
    expect(out.y + out.height).toBeLessThanOrEqual(1000);
  });
});

describe("planWindowRestore", () => {
  it("returns an empty plan when nothing survives (fresh install / all projects deleted)", () => {
    const plan = planWindowRestore({}, [], ONE_MONITOR);
    expect(plan).toEqual({ mainProjectId: null, mainGeometry: null, children: [], focusProjectId: null });
  });

  it("restores a single window as main with its geometry", () => {
    const sessions = { p1: entry({ projectId: "p1", isMain: true, x: 50, y: 60 }) };
    const plan = planWindowRestore(sessions, ["p1"], ONE_MONITOR);
    expect(plan.mainProjectId).toBe("p1");
    expect(plan.mainGeometry).toEqual({ x: 50, y: 60, width: 1200, height: 800 });
    expect(plan.children).toEqual([]);
    expect(plan.focusProjectId).toBe("p1");
  });

  it("picks the isMain entry as main and the rest as children", () => {
    const sessions = {
      p1: entry({ projectId: "p1", isMain: false, focusedAt: 5 }),
      p2: entry({ projectId: "p2", isMain: true, focusedAt: 3 }),
      p3: entry({ projectId: "p3", isMain: false, focusedAt: 1 }),
    };
    const plan = planWindowRestore(sessions, ["p1", "p2", "p3"], ONE_MONITOR);
    expect(plan.mainProjectId).toBe("p2");
    expect(plan.children.map((c) => c.projectId).sort()).toEqual(["p1", "p3"]);
  });

  it("when several entries are flagged isMain, the most-recently-focused one wins", () => {
    // sessions is untrusted persisted state — a force-quit race could leave two isMain flags.
    const sessions = {
      p1: entry({ projectId: "p1", isMain: true, focusedAt: 10 }),
      p2: entry({ projectId: "p2", isMain: true, focusedAt: 50 }),
    };
    const plan = planWindowRestore(sessions, ["p1", "p2"], ONE_MONITOR);
    expect(plan.mainProjectId).toBe("p2");
    expect(plan.children.map((c) => c.projectId)).toEqual(["p1"]);
  });

  it("focuses the most-recently-active window even when it is a child", () => {
    const sessions = {
      p1: entry({ projectId: "p1", isMain: true, focusedAt: 2 }),
      p2: entry({ projectId: "p2", isMain: false, focusedAt: 99 }),
    };
    const plan = planWindowRestore(sessions, ["p1", "p2"], ONE_MONITOR);
    expect(plan.mainProjectId).toBe("p1");
    expect(plan.focusProjectId).toBe("p2");
  });

  it("falls back to most-recently-focused as main when no entry is flagged isMain", () => {
    const sessions = {
      p1: entry({ projectId: "p1", isMain: false, focusedAt: 2 }),
      p2: entry({ projectId: "p2", isMain: false, focusedAt: 8 }),
    };
    const plan = planWindowRestore(sessions, ["p1", "p2"], ONE_MONITOR);
    expect(plan.mainProjectId).toBe("p2");
  });

  it("drops entries whose project no longer exists", () => {
    const sessions = {
      p1: entry({ projectId: "p1", isMain: true }),
      gone: entry({ projectId: "gone", isMain: false }),
    };
    const plan = planWindowRestore(sessions, ["p1"], ONE_MONITOR);
    expect(plan.mainProjectId).toBe("p1");
    expect(plan.children).toEqual([]);
  });

  it("drops a degenerate (zero-size) captured geometry", () => {
    const sessions = {
      p1: entry({ projectId: "p1", isMain: true }),
      bad: entry({ projectId: "bad", width: 0, height: 0 }),
    };
    const plan = planWindowRestore(sessions, ["p1", "bad"], ONE_MONITOR);
    expect(plan.children).toEqual([]);
  });

  it("clamps child geometry onto the monitor", () => {
    const sessions = {
      p1: entry({ projectId: "p1", isMain: true }),
      p2: entry({ projectId: "p2", isMain: false, x: 9000, y: 9000 }),
    };
    const plan = planWindowRestore(sessions, ["p1", "p2"], ONE_MONITOR);
    const child = plan.children.find((c) => c.projectId === "p2")!;
    expect(child.geometry.x + child.geometry.width).toBeLessThanOrEqual(3000);
    expect(child.geometry.y + child.geometry.height).toBeLessThanOrEqual(2000);
  });
});
