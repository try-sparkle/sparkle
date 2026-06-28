import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import {
  openProjectInWindow,
  WINDOW_LABEL_PREFIX,
  type ProjectWindowDeps,
} from "./projectWindows";

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
    // createWindow owns label generation + registry.set; it's invoked with the project id and
    // (here) no agent to deep-link.
    expect(deps.createWindow).toHaveBeenCalledWith("p2", undefined);
    // New-window open bumps recency like focus/replace.
    expect(deps.touchOpened).toHaveBeenCalledWith("p2");
  });

  it("threads the deep-link agent id into a freshly created window", async () => {
    const deps = makeDeps();
    const r = await openProjectInWindow("p2", "new", deps, "a7");
    expect(r).toBe("created");
    expect(deps.createWindow).toHaveBeenCalledWith("p2", "a7");
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

describe("Tauri capability coverage for runtime windows", () => {
  // Regression for the bug where secondary windows were created with `win-*` labels but the
  // capability `windows` glob only listed `["main", "project-*"]`. In Tauri v2 a window matching
  // no capability gets ZERO permissions, so invoke()/listen() silently failed → mic showed
  // "unavailable" and the agent hung on "Starting your agent...". This guards the glob↔prefix sync.
  const caps = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../src-tauri/capabilities/default.json", import.meta.url)),
      "utf8",
    ),
  ) as { windows: string[] };

  // Minimal glob → RegExp (labels have no slashes; `*` = any run of chars), mirroring how Tauri
  // matches a window label against a capability's `windows` patterns.
  const globToRe = (g: string) =>
    new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  const covered = (label: string) => caps.windows.some((g) => globToRe(g).test(label));

  it("covers the initial 'main' window", () => {
    expect(covered("main")).toBe(true);
  });

  it("covers runtime-created windows using the actual label prefix", () => {
    expect(covered(`${WINDOW_LABEL_PREFIX}123e4567-e89b-12d3-a456-426614174000`)).toBe(true);
  });
});
