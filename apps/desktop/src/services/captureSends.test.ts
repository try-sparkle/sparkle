// @vitest-environment jsdom
//
// Ownership routing for capture://send. The event is broadcast to every window; exactly ONE
// window may act on a payload. Source of truth is the window registry (windowRegistry.ts):
// the window whose label === findWindowForProject(projectId) owns it; an orphan project (no
// registered window) falls to main. These tests drive routeCaptureSend with a fake registry.
// (jsdom env so the dispatchBuild tests below can drive the real zustand stores.)
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  routeCaptureSend,
  shouldHandleCaptureSend,
  dispatchBuild,
  type CaptureRouteDeps,
} from "./captureSends";
import type { CaptureSendPayload } from "../capture/types";
import type { Project } from "../types";
import { useProjectStore } from "../stores/projectStore";

const payload = (projectId: string): CaptureSendPayload => ({
  mode: "build",
  projectId,
  text: "narration",
  attachments: [{ path: "/tmp/shot.png", dataUrl: "data:image/png;base64,AA" }],
});

const fakeRegistry =
  (map: Record<string, string>) =>
  (projectId: string): string | null => {
    for (const [label, pid] of Object.entries(map)) if (pid === projectId) return label;
    return null;
  };

const deps = (
  myLabel: string,
  isMain: boolean,
  registry: Record<string, string>,
): CaptureRouteDeps => ({ myLabel, isMain, findWindowForProject: fakeRegistry(registry) });

describe("routeCaptureSend", () => {
  it("the owning window handles its project's payload", () => {
    expect(routeCaptureSend(payload("p1"), deps("win-a", false, { "win-a": "p1" }))).toBe(true);
  });

  it("a non-owning window ignores it", () => {
    expect(
      routeCaptureSend(payload("p1"), deps("win-b", false, { "win-a": "p1", "win-b": "p2" })),
    ).toBe(false);
  });

  it("a project window exists but the payload is evaluated in main → main ignores", () => {
    expect(
      routeCaptureSend(payload("p1"), deps("main", true, { "win-a": "p1", main: "p2" })),
    ).toBe(false);
  });

  it("orphan project (no registered window) → main handles", () => {
    expect(routeCaptureSend(payload("p3"), deps("main", true, { "win-a": "p1" }))).toBe(true);
  });

  it("orphan project → a non-main window ignores", () => {
    expect(routeCaptureSend(payload("p3"), deps("win-a", false, { "win-a": "p1" }))).toBe(false);
  });

  it("main handles its own project like any owner", () => {
    expect(routeCaptureSend(payload("p2"), deps("main", true, { main: "p2" }))).toBe(true);
  });

  it("two labels registered for one project: the first registered label wins", () => {
    // A crash + "Replace" can leave two labels mapped to one project; pin the resolution so an
    // iteration-order change in findWindowForProject can't silently reroute payloads.
    const registry = { "win-old": "p1", "win-new": "p1" };
    expect(routeCaptureSend(payload("p1"), deps("win-old", false, registry))).toBe(true);
    expect(routeCaptureSend(payload("p1"), deps("win-new", false, registry))).toBe(false);
  });
});

describe("shouldHandleCaptureSend (stale-owner self-heal)", () => {
  const dispatchDeps = (
    myLabel: string,
    isMain: boolean,
    registry: Record<string, string>,
    aliveLabels: string[],
  ) => {
    const evictWindow = vi.fn((label: string) => {
      delete registry[label];
    });
    return {
      ...deps(myLabel, isMain, registry),
      isWindowAlive: (label: string) => Promise.resolve(aliveLabels.includes(label)),
      evictWindow,
    };
  };

  it("routing says handle → handles without any liveness probe", async () => {
    const d = dispatchDeps("win-a", false, { "win-a": "p1" }, ["win-a"]);
    await expect(shouldHandleCaptureSend(payload("p1"), d)).resolves.toBe(true);
    expect(d.evictWindow).not.toHaveBeenCalled();
  });

  it("owner registered but dead → main evicts the stale label and adopts", async () => {
    const registry = { "win-dead": "p1" };
    const d = dispatchDeps("main", true, registry, []);
    await expect(shouldHandleCaptureSend(payload("p1"), d)).resolves.toBe(true);
    expect(d.evictWindow).toHaveBeenCalledWith("win-dead");
    expect(registry["win-dead"]).toBeUndefined();
  });

  it("owner registered and alive → main stays out", async () => {
    const d = dispatchDeps("main", true, { "win-a": "p1" }, ["win-a"]);
    await expect(shouldHandleCaptureSend(payload("p1"), d)).resolves.toBe(false);
    expect(d.evictWindow).not.toHaveBeenCalled();
  });

  it("owner dead but this window isn't main → still ignores (at-most-one handler)", async () => {
    const d = dispatchDeps("win-b", false, { "win-dead": "p1", "win-b": "p2" }, ["win-b"]);
    await expect(shouldHandleCaptureSend(payload("p1"), d)).resolves.toBe(false);
    expect(d.evictWindow).not.toHaveBeenCalled();
  });

  it("dead label resolves first but a LIVE replacement owns the project → main defers, not adopts", async () => {
    // The composite of the duplicate-label routing case + self-heal (roborev 25170/25171): main
    // must evict the dead label and see the live owner, NOT adopt into itself.
    const registry = { "win-dead": "p1", "win-new": "p1" };
    const d = dispatchDeps("main", true, registry, ["win-new"]);
    await expect(shouldHandleCaptureSend(payload("p1"), d)).resolves.toBe(false);
    expect(d.evictWindow).toHaveBeenCalledWith("win-dead");
    expect(registry["win-dead"]).toBeUndefined();
    expect(registry["win-new"]).toBe("p1"); // the live owner is left registered
  });

  it("evicts multiple stacked dead labels before adopting the orphan", async () => {
    const registry = { "win-dead1": "p1", "win-dead2": "p1" };
    const d = dispatchDeps("main", true, registry, []);
    await expect(shouldHandleCaptureSend(payload("p1"), d)).resolves.toBe(true);
    expect(d.evictWindow).toHaveBeenCalledTimes(2);
    expect(registry["win-dead1"]).toBeUndefined();
    expect(registry["win-dead2"]).toBeUndefined();
  });

  it("a rejecting liveness probe is treated as alive → main stays out (no double dispatch)", async () => {
    const registry: Record<string, string> = { "win-a": "p1" };
    const d = {
      ...deps("main", true, registry),
      isWindowAlive: () => Promise.reject(new Error("IPC hiccup")),
      evictWindow: vi.fn((label: string) => {
        delete registry[label];
      }),
    };
    await expect(shouldHandleCaptureSend(payload("p1"), d)).resolves.toBe(false);
    expect(d.evictWindow).not.toHaveBeenCalled();
  });
});

// Build-agent selection: the Build options menu (CaptureApp) drives WHICH build agent a capture
// lands in via the payload's forceNewAgent / targetAgentId fields — the fix for "Build did not
// create a new build agent" (the old code always reused the first existing build agent).
describe("dispatchBuild agent selection", () => {
  const buildPayload = (over: Partial<CaptureSendPayload> = {}): CaptureSendPayload => ({
    mode: "build",
    projectId: "proj-1",
    text: "narration",
    attachments: [{ path: "/tmp/shot.png", dataUrl: "data:image/png;base64,AA" }],
    ...over,
  });

  const projectWithBuilds = (): Project[] =>
    [
      {
        id: "proj-1",
        name: "Alpha",
        rootPath: "/tmp/alpha",
        defaultBranch: "main",
        createdAt: "2026-01-01",
        selectedAgentId: null,
        agents: [
          { id: "b1", name: "Build 1", kind: "build", agents: undefined },
          { id: "b2", name: "Build 2", kind: "build" },
          { id: "t1", name: "Think", kind: "think" },
        ],
      },
    ] as unknown as Project[];

  const selectedId = () =>
    useProjectStore.getState().projects.find((p) => p.id === "proj-1")?.selectedAgentId;
  const buildCount = () =>
    useProjectStore
      .getState()
      .projects.find((p) => p.id === "proj-1")!
      .agents.filter((a) => a.kind === "build").length;

  beforeEach(() => {
    useProjectStore.setState({ projects: projectWithBuilds() });
  });

  it("forceNewAgent → ALWAYS spawns a fresh build agent (never reuses an existing one)", () => {
    dispatchBuild(buildPayload({ forceNewAgent: true }));
    expect(buildCount()).toBe(3); // b1 + b2 + the new one
    const sel = selectedId();
    expect(sel).not.toBe("b1");
    expect(sel).not.toBe("b2");
  });

  it("targetAgentId → routes into that EXACT existing build agent (no new agent)", () => {
    dispatchBuild(buildPayload({ targetAgentId: "b2" }));
    expect(buildCount()).toBe(2);
    expect(selectedId()).toBe("b2");
  });

  it("no routing fields → legacy reuse of the FIRST existing build agent", () => {
    dispatchBuild(buildPayload());
    expect(buildCount()).toBe(2);
    expect(selectedId()).toBe("b1");
  });

  it("targetAgentId that no longer exists → falls back to the first build agent (no crash)", () => {
    dispatchBuild(buildPayload({ targetAgentId: "gone" }));
    expect(buildCount()).toBe(2);
    expect(selectedId()).toBe("b1");
  });

  it("forceNewAgent wins even if a targetAgentId is also present", () => {
    dispatchBuild(buildPayload({ forceNewAgent: true, targetAgentId: "b2" }));
    expect(buildCount()).toBe(3);
    expect(selectedId()).not.toBe("b2");
  });
});
