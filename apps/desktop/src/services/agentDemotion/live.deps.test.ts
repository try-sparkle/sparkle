// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// `makeDemoteDeps` is where the state machine meets the real transport, the real store and the real
// commands, and three of its lines are load-bearing SAFETY decisions nothing else guards: the
// kill's hardcoded `runtime: "local"`, the briefing's two-write submit, and the flip's direction.
// All three would pass every other test in this directory if they were wrong.

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../relayClient", () => ({ getRelaySocket: () => ({ emit() {}, on() {}, off() {} }) }));

const transports: Array<{ id: string; runtime: string; writes: string[]; killed: boolean }> = [];
const deletedSessions: string[] = [];
vi.mock("../agentTransport", () => ({
  deleteCloudSession: (id: string) => {
    deletedSessions.push(id);
    return Promise.resolve();
  },
  getTransport: (a: { id: string; runtime: string }) => {
    const rec = { ...a, writes: [] as string[], killed: false };
    transports.push(rec);
    return {
      spawn: async () => {},
      write: (d: string) => rec.writes.push(d),
      resize: () => {},
      kill: async () => {
        rec.killed = true;
      },
      detach: async () => {},
      onOutput: () => () => {},
      onExit: () => () => {},
    };
  },
}));

import { makeDemoteDeps, LOCAL_SPAWN_UNSUPPORTED } from "./live";
import { useProjectStore } from "../../stores/projectStore";
import { registerPaneRestart, clearPaneRestarts } from "../paneControl";

beforeEach(() => {
  transports.length = 0;
  deletedSessions.length = 0;
  clearPaneRestarts();
  invoke.mockReset().mockResolvedValue("tok");
});

describe("makeDemoteDeps — killLocalAgent", () => {
  it("stands down the LOCAL transport, explicitly, never the tab's own runtime", () => {
    // At every point this is called the tab still reads `runtime: "cloud"`. If it derived the
    // transport from the tab, `kill()` would DELETE the cloud session — destroying the sandbox on a
    // failure path whose whole promise is that the cloud agent survives.
    void makeDemoteDeps().killLocalAgent("agent-1");
    expect(transports).toHaveLength(1);
    expect(transports[0]).toMatchObject({ id: "agent-1", runtime: "local" });
    expect(transports[0]!.killed).toBe(true);
  });
});

describe("makeDemoteDeps — sendBriefing", () => {
  it("writes to the LOCAL transport, text and carriage return as SEPARATE frames, CR last", () => {
    makeDemoteDeps().sendBriefing({ agentId: "agent-1", text: "re-orient from git" });
    expect(transports).toHaveLength(1);
    expect(transports[0]).toMatchObject({ id: "agent-1", runtime: "local" });
    expect(transports[0]!.writes).toEqual(["re-orient from git", "\r"]);
  });
});

describe("makeDemoteDeps — setRuntimeLocal", () => {
  it("flips the real store's tab back to local", () => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const id = useProjectStore.getState().addAgent(pid, { kind: "build", runtime: "cloud" })!;
    expect(
      useProjectStore.getState().projects.find((p) => p.id === pid)!.agents.find((a) => a.id === id)!
        .runtime,
    ).toBe("cloud");

    makeDemoteDeps().setRuntimeLocal({ projectId: pid, agentId: id });

    expect(
      useProjectStore.getState().projects.find((p) => p.id === pid)!.agents.find((a) => a.id === id)!
        .runtime,
    ).toBe("local");
  });
});

describe("makeDemoteDeps — deleteSession", () => {
  it("is the orchestration DELETE, by session id", async () => {
    await makeDemoteDeps().deleteSession("sess-9");
    expect(deletedSessions).toEqual(["sess-9"]);
  });
});

describe("makeDemoteDeps — spawnLocalAgent", () => {
  it("refuses POSITIVELY even when the pane's re-spawn lever IS registered", async () => {
    // The case that actually occurs, and the one a refusal keyed on the lever's ABSENCE would miss:
    // AgentPane registers the lever in an effect keyed on `[agent.id]` with NO runtime condition, so
    // a mounted CLOUD pane has one. Calling it would return true, spawn nothing (prepare() early
    // returns for runtime === "cloud"), re-run the cloud attach path as a side effect, and leave the
    // machine waiting out a 60-second deadline before blaming the deadline for it.
    const restarted: string[] = [];
    registerPaneRestart("agent-1", () => restarted.push("agent-1"));
    await expect(
      makeDemoteDeps().spawnLocalAgent({
        agentId: "agent-1",
        worktree: "/wt",
        branch: "sparkle/x",
      }),
    ).rejects.toThrow(LOCAL_SPAWN_UNSUPPORTED);
    // …and it must not have TOUCHED the pane: driving the lever re-runs prepare() on a live cloud
    // pane, which resets its spawn state and phase for no reason.
    expect(restarted).toEqual([]);
  });

  it("refuses when no pane is mounted at all, with the same message", async () => {
    await expect(
      makeDemoteDeps().spawnLocalAgent({ agentId: "nobody", worktree: "/wt", branch: "b" }),
    ).rejects.toThrow(LOCAL_SPAWN_UNSUPPORTED);
  });

  it("refuses in words a user can act on, and says the cloud agent is untouched", async () => {
    // The message reaches the dialog verbatim at the `spawn` step, so it has to be copy, not a
    // developer note about an unimplemented seam.
    expect(LOCAL_SPAWN_UNSUPPORTED).toMatch(/desktop update/i);
    expect(LOCAL_SPAWN_UNSUPPORTED).toMatch(/cloud agent is untouched/i);
  });
});

describe("makeDemoteDeps — the API seam", () => {
  it("routes the handoff and the cut guard at the two new endpoints", async () => {
    const calls: string[] = [];
    const api = {
      sessionHandoff: async (id: string) => {
        calls.push(`handoff:${id}`);
        return { branch: "b", pushedSha: "s", transcript: null, transcriptError: null };
      },
      sessionHead: async (id: string) => {
        calls.push(`head:${id}`);
        return "s";
      },
    };
    const deps = makeDemoteDeps({}, api);
    await deps.sessionHandoff("sess-1");
    await deps.sandboxHead("sess-1");
    expect(calls).toEqual(["handoff:sess-1", "head:sess-1"]);
  });

  it("lets an override replace any dep", async () => {
    const deps = makeDemoteDeps({ killLocalAgent: async () => {} });
    await deps.killLocalAgent("x");
    // The override ran instead of the real one, so no transport was ever built.
    expect(transports).toHaveLength(0);
  });
});
