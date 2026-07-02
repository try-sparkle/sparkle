import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  defaultDeps,
  openProjectInWindow,
  WINDOW_LABEL_PREFIX,
  type ProjectWindowDeps,
} from "./projectWindows";
import { resetWindowRegistry } from "./windowRegistry";
import { useProjectStore } from "../stores/projectStore";
import type { Project } from "../types";

// Capture WebviewWindow constructions so defaultDeps.createWindow is assertable without a webview.
const createdWindows = vi.hoisted(
  () => [] as Array<{ label: string; options: { title?: string } }>,
);
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    // Match the surface defaultDeps consumes (getByLabel backs deps.getByLabel).
    static getByLabel = vi.fn(async () => null);
    constructor(label: string, options: { title?: string }) {
      createdWindows.push({ label, options });
    }
    once() {
      return Promise.resolve(() => {});
    }
  },
}));

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

describe("defaultDeps.createWindow", () => {
  // These tests mutate shared module state (project store, window registry, the capture array);
  // reset it so later tests in this file can't inherit leaked state.
  afterEach(() => {
    useProjectStore.setState({ projects: [] });
    resetWindowRegistry();
    createdWindows.length = 0;
  });

  it("titles a new window with the project's name, falling back to 'Sparkle' when unknown", () => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "sparkle-desktop" } as Project],
    });
    const deps = defaultDeps(vi.fn(), vi.fn(), "main");

    deps.createWindow("p1");
    expect(createdWindows).toHaveLength(1);
    expect(createdWindows[0]?.options.title).toBe("sparkle-desktop");
    expect(createdWindows[0]?.label.startsWith(WINDOW_LABEL_PREFIX)).toBe(true);

    // A project id the store doesn't know keeps the pre-hydration default.
    deps.createWindow("no-such-project");
    expect(createdWindows[1]?.options.title).toBe("Sparkle");
  });

  it("falls back to 'Sparkle' for a blank project name instead of titling blank", () => {
    useProjectStore.setState({
      projects: [{ id: "p-blank", name: "   " } as Project],
    });
    const deps = defaultDeps(vi.fn(), vi.fn(), "main");
    deps.createWindow("p-blank");
    expect(createdWindows[0]?.options.title).toBe("Sparkle");
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
