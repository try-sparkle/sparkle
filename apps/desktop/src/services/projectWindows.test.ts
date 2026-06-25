import { describe, it, expect, vi } from "vitest";
import { openProjectInWindow, type ProjectWindowDeps } from "./projectWindows";

function makeDeps(over: Partial<ProjectWindowDeps> = {}): ProjectWindowDeps {
  return {
    getByLabel: vi.fn(async () => ({
      show: vi.fn(async () => {}),
      setFocus: vi.fn(async () => {}),
      unminimize: vi.fn(async () => {}),
    })),
    createWindow: vi.fn(),
    currentLabel: () => "main",
    registry: { find: vi.fn(() => null), set: vi.fn(), clear: vi.fn() },
    replaceCurrent: vi.fn(),
    touchOpened: vi.fn(),
    ...over,
  };
}

describe("openProjectInWindow", () => {
  it("focuses an existing window when the project is already open", async () => {
    const focus = vi.fn(async () => {});
    const show = vi.fn(async () => {});
    const deps = makeDeps({
      registry: { find: () => "project-p1", set: vi.fn(), clear: vi.fn() },
      getByLabel: async () => ({ show, setFocus: focus, unminimize: vi.fn(async () => {}) }),
    });
    const r = await openProjectInWindow("p1", "new", deps);
    expect(r).toBe("focused");
    expect(show).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    // Focusing also bumps recency, matching the new/replace paths.
    expect(deps.touchOpened).toHaveBeenCalledWith("p1");
    expect(deps.createWindow).not.toHaveBeenCalled();
  });

  it("creates a new window in new mode when not already open", async () => {
    const deps = makeDeps();
    const r = await openProjectInWindow("p2", "new", deps);
    expect(r).toBe("created");
    // createWindow owns label generation + registry.set; it's invoked with just the project id.
    expect(deps.createWindow).toHaveBeenCalledWith("p2");
    // New-window open bumps recency like focus/replace.
    expect(deps.touchOpened).toHaveBeenCalledWith("p2");
  });

  it("replaces the current window in replace mode", async () => {
    const deps = makeDeps();
    const r = await openProjectInWindow("p3", "replace", deps);
    expect(r).toBe("replaced");
    expect(deps.replaceCurrent).toHaveBeenCalledWith("p3");
    expect(deps.registry.set).toHaveBeenCalledWith("main", "p3");
    expect(deps.touchOpened).toHaveBeenCalledWith("p3");
    expect(deps.createWindow).not.toHaveBeenCalled();
  });

  it("falls through to create when the registry points at a dead window, evicting the stale entry", async () => {
    const clear = vi.fn();
    const deps = makeDeps({
      registry: { find: () => "project-ghost", set: vi.fn(), clear },
      getByLabel: async () => null, // window no longer exists
    });
    const r = await openProjectInWindow("p4", "new", deps);
    expect(r).toBe("created");
    expect(clear).toHaveBeenCalledWith("project-ghost");
  });
});
