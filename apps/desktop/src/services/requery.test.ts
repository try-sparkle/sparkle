import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentKind, AgentTab, Project } from "../types";
import type { AgentTabStatus } from "@sparkle/ui";

// Re-query talks to PTY agents via submitPrompt. Mock it so the dispatcher's
// routing/filtering is what's under test.
const submitPrompt = vi.fn();
vi.mock("../pty", () => ({
  submitPrompt: (...a: unknown[]) => submitPrompt(...a),
  // A stand-in for the real PtyGoneError: requery.ts does `e instanceof PtyGoneError`, and the
  // tests below construct one to reject with, so both sides must share THIS class (the mocked one).
  PtyGoneError: class PtyGoneError extends Error {
    constructor(readonly id: string) {
      super(`no such pty: ${id}`);
      this.name = "PtyGoneError";
    }
  },
}));
// Silence the failure log so a deliberately-rejecting agent doesn't print to the test output.
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  requeryOpenAgents,
  shouldRequery,
  claimReconnectRequery,
  requeryOnReconnect,
  REQUERY_PROMPT,
  REQUERY_CLAIM_KEY,
  REQUERY_CLAIM_WINDOW_MS,
} from "./requery";
import type { KV } from "./windowRegistry";
import { PtyGoneError } from "../pty";
import { log } from "../logger";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";

function agent(id: string, kind: AgentKind): AgentTab {
  return {
    id,
    name: id,
    kind,
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  };
}

function seed(agents: AgentTab[], open: string[], status: Record<string, AgentTabStatus>) {
  const project: Project = {
    id: "p1",
    name: "P1",
    rootPath: "/p1",
    defaultBranch: "main",
    createdAt: "",
    agents,
    selectedAgentId: null,
  };
  useProjectStore.setState({ projects: [project], selectedProjectId: "p1" });
  useRuntimeStore.setState({ openAgentIds: open, status });
}

beforeEach(() => {
  submitPrompt.mockReset();
  vi.mocked(log.error).mockClear();
  vi.mocked(log.debug).mockClear();
});

describe("requeryOpenAgents — PTY (build/worker) agents", () => {
  it("sends the status prompt to an idle build agent", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "idle" });
    await requeryOpenAgents();
    expect(submitPrompt).toHaveBeenCalledWith("b1", REQUERY_PROMPT, { machine: true });
  });

  it("skips a build agent that is actively working (don't interrupt mid-task)", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "working" });
    await requeryOpenAgents();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("skips a 'waiting' agent so we don't answer its on-screen prompt with status text", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "waiting" });
    await requeryOpenAgents();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("skips an 'approval' agent — never auto-confirm a pending dangerous action", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "approval" });
    await requeryOpenAgents();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("skips agents that are not open", async () => {
    seed([agent("b1", "build")], [], { b1: "idle" });
    await requeryOpenAgents();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("re-queries worker agents too, not just build agents", async () => {
    seed([agent("w1", "worker")], ["w1"], { w1: "idle" });
    await requeryOpenAgents();
    expect(submitPrompt).toHaveBeenCalledWith("w1", REQUERY_PROMPT, { machine: true });
  });

  it("keeps re-querying the rest when one agent's PTY write fails", async () => {
    seed(
      [agent("b1", "build"), agent("b2", "build")],
      ["b1", "b2"],
      { b1: "idle", b2: "idle" },
    );
    // b1's PTY is gone (e.g. exited) and rejects; b2 must still be re-queried.
    submitPrompt.mockRejectedValueOnce(new Error("pty dead"));
    await expect(requeryOpenAgents()).resolves.toBeUndefined();
    expect(submitPrompt).toHaveBeenCalledWith("b2", REQUERY_PROMPT, { machine: true });
  });
});

describe("requeryOpenAgents — a PtyGoneError is TERMINAL, not a per-reconnect ERROR (sparkle-rsx4)", () => {
  it("marks the agent stopped and does NOT re-query it on a later reconnect pass", async () => {
    // A "done" pane whose underlying process has already exited: its PTY is gone, so the write
    // rejects with PtyGoneError.
    seed([agent("b1", "build")], ["b1"], { b1: "done" });
    submitPrompt.mockRejectedValueOnce(new PtyGoneError("b1"));

    await requeryOpenAgents(); // first reconnect: the PTY is discovered gone
    expect(submitPrompt).toHaveBeenCalledTimes(1);

    // SIDE EFFECT under test: the agent is now marked `stopped` (terminal, not a red error)...
    expect(useRuntimeStore.getState().status.b1).toBe("stopped");

    // ...so a SECOND reconnect must NOT fire another re-query into the dead PTY. Asserting the
    // absence of the second call is what proves the loop actually stops for this agent — the whole
    // point of treating PtyGoneError as terminal (mutation: drop the setStatus and this call fires).
    submitPrompt.mockClear();
    await requeryOpenAgents();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("logs a PtyGoneError at DEBUG, never ERROR (it is an expected lifecycle race)", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "done" });
    submitPrompt.mockRejectedValueOnce(new PtyGoneError("b1"));
    await requeryOpenAgents();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalled();
  });

  it("still logs a NON-PtyGone write failure at ERROR (a real failure is not silenced)", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "idle" });
    submitPrompt.mockRejectedValueOnce(new Error("something genuinely broke"));
    await requeryOpenAgents();
    expect(log.error).toHaveBeenCalled();
    // A generic failure is NOT terminal — the agent keeps its live status, not demoted to stopped.
    expect(useRuntimeStore.getState().status.b1).toBe("idle");
  });

  it("CANCELS a not-yet-sent re-query for an agent torn down mid-pass", async () => {
    // Two open, idle agents. While b1's re-query is in flight (submitPrompt awaits), b2's pane is
    // torn down — window close / worktree removal / spin-down all route through runtimeStore.close(),
    // which drops b2 from openAgentIds. b2's not-yet-sent re-query MUST be cancelled, not fired into
    // the torn-down PTY. Asserting b2 is never called is the side effect; it only holds because the
    // loop re-reads liveness per agent instead of trusting a top-of-pass snapshot (mutation: read the
    // snapshot and b2 gets a re-query).
    seed([agent("b1", "build"), agent("b2", "build")], ["b1", "b2"], { b1: "idle", b2: "idle" });
    submitPrompt.mockImplementationOnce(async () => {
      useRuntimeStore.getState().close("b2");
    });

    await requeryOpenAgents();

    expect(submitPrompt).toHaveBeenCalledWith("b1", REQUERY_PROMPT, { machine: true });
    expect(submitPrompt).not.toHaveBeenCalledWith("b2", REQUERY_PROMPT);
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });
});

/** Stands in for the localStorage every webview window shares. */
function sharedStore(): KV {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("claimReconnectRequery — one re-query per reconnect, machine-wide", () => {
  it("lets the first caller through", () => {
    expect(claimReconnectRequery(1_000, sharedStore())).toBe(true);
  });

  it("suppresses the other windows recovering from the same reconnect", () => {
    const shared = sharedStore(); // four windows, one machine, one link coming back
    const claims = [0, 60, 90, 800].map((offset) => claimReconnectRequery(1_000 + offset, shared));
    expect(claims).toEqual([true, false, false, false]);
  });

  it("suppresses a flapping link re-crossing the edge inside the window", () => {
    const shared = sharedStore();
    claimReconnectRequery(1_000, shared);
    expect(claimReconnectRequery(1_000 + REQUERY_CLAIM_WINDOW_MS - 1, shared)).toBe(false);
  });

  it("re-queries again once the window has elapsed (a genuinely separate outage)", () => {
    const shared = sharedStore();
    claimReconnectRequery(1_000, shared);
    expect(claimReconnectRequery(1_000 + REQUERY_CLAIM_WINDOW_MS, shared)).toBe(true);
  });

  it("reclaims a stamp from the future so a backwards clock can't wedge re-query off", () => {
    const shared = sharedStore();
    shared.setItem(REQUERY_CLAIM_KEY, String(1_000 + REQUERY_CLAIM_WINDOW_MS - 1));
    expect(claimReconnectRequery(1_000, shared)).toBe(false); // inside the window: still one event
    shared.setItem(REQUERY_CLAIM_KEY, String(5_000_000)); // way ahead — stale, not a live claim
    expect(claimReconnectRequery(1_000, shared)).toBe(true);
  });

  it("reclaims past a garbled value rather than treating it as a live claim", () => {
    const shared = sharedStore();
    shared.setItem(REQUERY_CLAIM_KEY, "not-a-timestamp");
    expect(claimReconnectRequery(1_000, shared)).toBe(true);
  });

  it("falls back to re-querying when the shared storage throws", () => {
    const broken: KV = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {},
    };
    expect(claimReconnectRequery(1_000, broken)).toBe(true);
  });
});

describe("requeryOnReconnect — the claim actually gates the prompting", () => {
  it("prompts the open agents when it wins the claim", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "idle" });
    await requeryOnReconnect(1_000, sharedStore());
    expect(submitPrompt).toHaveBeenCalledWith("b1", REQUERY_PROMPT, { machine: true });
  });

  it("sends nothing at all when another window already claimed the reconnect", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "idle" });
    const shared = sharedStore();
    await requeryOnReconnect(1_000, shared); // the window that won
    submitPrompt.mockClear();
    await requeryOnReconnect(1_060, shared); // a sibling window, same reconnect
    expect(submitPrompt).not.toHaveBeenCalled();
  });
});

describe("shouldRequery — only the offline→online edge fires", () => {
  it("fires when going from offline to online", () => {
    expect(shouldRequery(false, true)).toBe(true);
  });
  it("does not fire while staying online", () => {
    expect(shouldRequery(true, true)).toBe(false);
  });
  it("does not fire when going offline", () => {
    expect(shouldRequery(true, false)).toBe(false);
  });
  it("does not fire while staying offline", () => {
    expect(shouldRequery(false, false)).toBe(false);
  });
});
