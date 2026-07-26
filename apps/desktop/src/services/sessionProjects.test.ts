// The visited-projects set (CM-U7 hardening): the single source of truth both the Workspace's
// lazy pane mounting and the roster publisher read (roborev 46351 — a mirrored copy diverged
// after a Workspace remount). Pure module-state tests: idempotence, notify-on-real-change only,
// a throwing listener never breaking the caller, unsubscribe.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  markProjectVisited,
  onVisitedProjectsChange,
  resetVisitedProjects,
  visitedProjectsVersion,
  wasProjectVisited,
} from "./sessionProjects";

beforeEach(() => resetVisitedProjects());

describe("sessionProjects", () => {
  it("records a visit exactly once (idempotent), bumping the version only on real change", () => {
    const v0 = visitedProjectsVersion();
    markProjectVisited("p1");
    expect(wasProjectVisited("p1")).toBe(true);
    const v1 = visitedProjectsVersion();
    expect(v1).toBe(v0 + 1);
    markProjectVisited("p1"); // repeat visit: no growth, no version bump, no notify
    expect(visitedProjectsVersion()).toBe(v1);
  });

  it("ignores null/undefined ids", () => {
    const v0 = visitedProjectsVersion();
    markProjectVisited(null);
    markProjectVisited(undefined);
    expect(visitedProjectsVersion()).toBe(v0);
  });

  it("notifies subscribers on growth; a repeat visit does not re-notify", () => {
    const cb = vi.fn();
    const off = onVisitedProjectsChange(cb);
    markProjectVisited("p1");
    markProjectVisited("p1");
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    markProjectVisited("p2");
    expect(cb).toHaveBeenCalledTimes(1); // unsubscribed
  });

  it("a throwing listener never breaks the caller or starves other listeners", () => {
    const bad = vi.fn(() => {
      throw new Error("listener boom");
    });
    const good = vi.fn();
    onVisitedProjectsChange(bad);
    onVisitedProjectsChange(good);
    expect(() => markProjectVisited("p1")).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("reset NOTIFIES too, so a mounted subscriber can't hold a stale snapshot (46485-L)", () => {
    markProjectVisited("p1");
    const cb = vi.fn();
    onVisitedProjectsChange(cb);
    resetVisitedProjects();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(wasProjectVisited("p1")).toBe(false);
  });
});
