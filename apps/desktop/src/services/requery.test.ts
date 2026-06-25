import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentKind, AgentTab, Project } from "../types";
import type { AgentTabStatus } from "@sparkle/ui";

// Re-query talks to agents two ways: PTY agents via submitPrompt, Brainstorm agents via
// the bridge. Mock both so the dispatcher's routing/filtering is what's under test.
const submitPrompt = vi.fn();
vi.mock("../pty", () => ({ submitPrompt: (...a: unknown[]) => submitPrompt(...a) }));
const sendToBrainstorm = vi.fn();
vi.mock("./brainstormBridge", () => ({
  sendToBrainstorm: (...a: unknown[]) => sendToBrainstorm(...a),
}));
// Silence the failure log so a deliberately-rejecting agent doesn't print to the test output.
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { requeryOpenAgents, shouldRequery, REQUERY_PROMPT } from "./requery";
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
  sendToBrainstorm.mockReset();
});

describe("requeryOpenAgents — PTY (build/worker) agents", () => {
  it("sends the status prompt to an idle build agent", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "idle" });
    await requeryOpenAgents();
    expect(submitPrompt).toHaveBeenCalledWith("b1", REQUERY_PROMPT);
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
    expect(submitPrompt).toHaveBeenCalledWith("w1", REQUERY_PROMPT);
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
    expect(submitPrompt).toHaveBeenCalledWith("b2", REQUERY_PROMPT);
  });
});

describe("requeryOpenAgents — Brainstorm agents", () => {
  it("routes to the brainstorm bridge regardless of PTY status", async () => {
    seed([agent("c1", "brainstorm")], ["c1"], {});
    await requeryOpenAgents();
    expect(sendToBrainstorm).toHaveBeenCalledWith("c1", REQUERY_PROMPT);
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
