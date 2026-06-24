import { describe, it, expect, vi, beforeEach } from "vitest";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
import { createAgentWorktree, assertWorkspaceIntegrity } from "./worktree";

describe("worktree service", () => {
  beforeEach(() => invoke.mockReset());
  it("passes projectId + baseBranch into create_agent_worktree", async () => {
    invoke.mockResolvedValue({ path: "/wt/p/a", branch: "sparkle/agent-a" });
    await createAgentWorktree("/root", "p", "a", "main");
    expect(invoke).toHaveBeenCalledWith("create_agent_worktree", {
      root: "/root", projectId: "p", agentId: "a", baseBranch: "main",
    });
  });
  it("bridges assert_workspace_integrity", async () => {
    invoke.mockResolvedValue(undefined);
    await assertWorkspaceIntegrity("/wt/p/a");
    expect(invoke).toHaveBeenCalledWith("assert_workspace_integrity", { worktree: "/wt/p/a" });
  });
});
