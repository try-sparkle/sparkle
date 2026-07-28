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
  dispatchChat,
  type CaptureRouteDeps,
} from "./captureSends";
import { normalizeCaptureMode, type CaptureSendPayload } from "../capture/types";
import type { Project } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useComposeHandoffStore } from "../stores/composeHandoffStore";
import { log } from "../logger";

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
    useComposeHandoffStore.setState({ handoff: null });
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

  // ── THE WRONG-AGENT RACE ──────────────────────────────────────────────────────────────────────
  // The predecessor's guard lived in the deleted Composer and matched on PROJECT + KIND, never on
  // agentId. With two build agents in one project that is not a near-miss, it is a coin flip:
  // whichever build agent's composer activated first consumed a draft meant for the other. These
  // rows pin that the handoff now names ONE agent and that it is the one the capture asked for.

  it("a draft for agent B is not handed to agent A — the handoff names the picked agent", () => {
    // b1 is FIRST in the project, so the old project+kind guard would have matched it.
    dispatchBuild(buildPayload({ targetAgentId: "b2" }));
    const h = useComposeHandoffStore.getState().take();
    expect(h?.agentId).toBe("b2");
    expect(h?.agentId).not.toBe("b1");
    expect(selectedId()).toBe("b2");
  });

  it("a draft for a NEWLY CREATED agent is not eaten by the pre-existing build agents", () => {
    dispatchBuild(buildPayload({ forceNewAgent: true }));
    const created = selectedId();
    const h = useComposeHandoffStore.getState().take();
    // The agent is created in the same tick as the handoff, which is the whole reason the old code
    // keyed by project instead of by id. It still must name the id `addAgent` just returned.
    expect(h?.agentId).toBe(created);
    expect(h?.agentId).not.toBe("b1");
    expect(h?.agentId).not.toBe("b2");
  });

  it("a second capture REPLACES an unconsumed first — the newer one is what the user is looking at", () => {
    dispatchBuild(buildPayload({ targetAgentId: "b1", text: "older" }));
    dispatchBuild(buildPayload({ targetAgentId: "b2", text: "newer" }));
    const h = useComposeHandoffStore.getState().take();
    expect(h?.text).toBe("newer");
    expect(h?.agentId).toBe("b2");
    // Exactly one handoff survives, so the stale draft can never surface a send later.
    expect(useComposeHandoffStore.getState().take()).toBeNull();
  });

  // ── THE SILENT DROPS, NOW AUDIBLE ─────────────────────────────────────────────────────────────
  // Both of these discard the user's narration AND screenshot. They were bare `return`s — the same
  // silence that let the orphaned-store bug live for days. A drop that logs nothing is a drop
  // nobody can diagnose, so the log line is part of the fix rather than decoration.

  // Spied on the LOGGER, not on `console`: logger.ts binds its `realConsole` at module load, so a
  // `vi.spyOn(console, "error")` installed afterwards never sees these lines and the row passes
  // vacuously against silent code — the precise failure mode being tested for.
  it("logs an ERROR when the project is gone, instead of dropping the capture silently", () => {
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});
    useProjectStore.setState({ projects: [] });
    dispatchBuild(buildPayload({ targetAgentId: "b2" }));
    expect(useComposeHandoffStore.getState().take()).toBeNull();
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(" ")).toMatch(/no such project/i);
    spy.mockRestore();
  });

  it("logs an ERROR when the build agent could not be created", () => {
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});
    // The project is found, then vanishes before the create — addAgent returns null.
    const addAgent = vi.spyOn(useProjectStore.getState(), "addAgent").mockReturnValue(null);
    dispatchBuild(buildPayload({ forceNewAgent: true }));
    expect(useComposeHandoffStore.getState().take()).toBeNull();
    expect(spy.mock.calls.flat().join(" ")).toMatch(/could not create a build agent/i);
    addAgent.mockRestore();
    spy.mockRestore();
  });

  it("logs a WARNING when the picked agent vanished and the capture is re-aimed", () => {
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    dispatchBuild(buildPayload({ targetAgentId: "gone" }));
    // It still lands — the fallback is a build agent in the right project, and it is still a draft.
    expect(useComposeHandoffStore.getState().take()?.agentId).toBe("b1");
    // But a silent re-aim is how the wrong-agent class of bug hides, so it is on the record.
    expect(spy.mock.calls.flat().join(" ")).toMatch(/picked build agent is gone/i);
    spy.mockRestore();
  });

  it("does NOT warn when the capture landed exactly where it was aimed", () => {
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    dispatchBuild(buildPayload({ targetAgentId: "b2" }));
    expect(spy.mock.calls.flat().join(" ")).not.toMatch(/picked build agent is gone/i);
    spy.mockRestore();
  });

  it("forceNewAgent wins even if a targetAgentId is also present", () => {
    dispatchBuild(buildPayload({ forceNewAgent: true, targetAgentId: "b2" }));
    expect(buildCount()).toBe(3);
    expect(selectedId()).not.toBe("b2");
  });

  // ── THE HANDOFF ITSELF ────────────────────────────────────────────────────────────────────────
  // The regression these rows exist for: dispatchBuild used to write the draft to
  // `handoffStore.buildDraft`, whose only reader (the per-agent terminal Composer) was deleted in
  // db29f0a48. From then until this branch, a capture sent from the helper island CREATED the agent
  // and then dropped the user's narration and screenshot with no error and no log line. Nothing
  // here would have passed against that code: the store these read did not exist.

  it("hands the capture text AND the screenshot to the concierge compose box", () => {
    dispatchBuild(buildPayload({ targetAgentId: "b2" }));
    const h = useComposeHandoffStore.getState().take();
    expect(h).toMatchObject({
      origin: "capture-build",
      projectId: "proj-1",
      agentId: "b2",
      text: "narration",
    });
    expect(h?.attachments).toEqual([
      { path: "/tmp/shot.png", dataUrl: "data:image/png;base64,AA" },
    ]);
  });

  it("hands off for a NEWLY CREATED agent too, naming the agent it just spawned", () => {
    dispatchBuild(buildPayload({ forceNewAgent: true }));
    const h = useComposeHandoffStore.getState().take();
    // The whole point of the race handling: the agent is created in this same tick, so the handoff
    // has to name the id that create returned rather than wait for anything to mount.
    expect(h?.agentId).toBe(selectedId());
    expect(h?.agentId).toBeTruthy();
    expect(h?.text).toBe("narration");
    expect(h?.attachments).toHaveLength(1);
  });

  it("selects the target agent BEFORE queueing the draft, so the box's aim is already right", () => {
    // Order matters and is invisible in the end state, so observe it: by the time the handoff is
    // readable, the selection the concierge's router reads must already have moved.
    let selectedWhenQueued: string | null | undefined;
    const unsub = useComposeHandoffStore.subscribe((s) => {
      if (s.handoff) selectedWhenQueued = selectedId();
    });
    try {
      dispatchBuild(buildPayload({ targetAgentId: "b2" }));
    } finally {
      unsub();
    }
    expect(selectedWhenQueued).toBe("b2");
  });

  it("an empty narration still hands off — a screenshot alone is a message", () => {
    dispatchBuild(buildPayload({ text: "", targetAgentId: "b2" }));
    const h = useComposeHandoffStore.getState().take();
    expect(h?.text).toBe("");
    expect(h?.attachments).toHaveLength(1);
  });

  it("a project that vanished drops the send without queueing a draft for nobody", () => {
    useProjectStore.setState({ projects: [] });
    dispatchBuild(buildPayload({ targetAgentId: "b2" }));
    expect(useComposeHandoffStore.getState().take()).toBeNull();
  });
});

// Chat replaced Plan (see CaptureSendMode). Plan ran a Chief PRD-synthesis pipeline off the button
// and threw for any project without Chief configured; Chat puts the same capture in the concierge's
// compose box as a draft the user still has to send.
describe("dispatchChat", () => {
  const chatPayload = (over: Partial<CaptureSendPayload> = {}): CaptureSendPayload => ({
    mode: "chat",
    projectId: "proj-1",
    text: "what is this error?",
    attachments: [{ path: "/tmp/shot.png", dataUrl: "data:image/png;base64,AA" }],
    ...over,
  });

  beforeEach(() => {
    useProjectStore.setState({ projects: [] });
    useComposeHandoffStore.setState({ handoff: null });
  });

  it("hands the capture to the concierge box, marked for Sparkle", () => {
    dispatchChat(chatPayload());
    expect(useComposeHandoffStore.getState().take()).toEqual({
      origin: "capture-chat",
      projectId: "proj-1",
      text: "what is this error?",
      attachments: [{ path: "/tmp/shot.png", dataUrl: "data:image/png;base64,AA" }],
      // Without this the auto-router could aim the draft at whatever build agent is on screen —
      // the destination the user declined by not pressing Build.
      route: "sparkle",
    });
  });

  it("names NO agent and creates none — Chat is not a build gesture", () => {
    useProjectStore.setState({
      projects: [
        {
          id: "proj-1",
          name: "Alpha",
          rootPath: "/tmp/alpha",
          defaultBranch: "main",
          createdAt: "2026-01-01",
          selectedAgentId: null,
          agents: [],
        },
      ] as unknown as Project[],
    });
    dispatchChat(chatPayload());
    expect(useComposeHandoffStore.getState().take()?.agentId).toBeUndefined();
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
  });

  it("works for a project Chief was never configured for — the old Plan route threw here", () => {
    expect(() => dispatchChat(chatPayload({ projectId: "never-seen" }))).not.toThrow();
    expect(useComposeHandoffStore.getState().take()?.projectId).toBe("never-seen");
  });
});

// `capture://send` crosses webviews, and the capture window is long-lived: a pre-upgrade one can
// emit the retired "plan" into a post-upgrade project window. An unmatched switch arm there would
// be a silent drop — the exact failure mode this branch exists to remove.
describe("normalizeCaptureMode", () => {
  it("maps the retired 'plan' to 'chat' — same slot, reversible direction", () => {
    expect(normalizeCaptureMode("plan")).toBe("chat");
  });

  it("passes the two live modes through unchanged", () => {
    expect(normalizeCaptureMode("build")).toBe("build");
    expect(normalizeCaptureMode("chat")).toBe("chat");
  });

  it("resolves anything unrecognized to 'chat' rather than dropping the send", () => {
    expect(normalizeCaptureMode("")).toBe("chat");
    expect(normalizeCaptureMode("something-new")).toBe("chat");
  });
});
