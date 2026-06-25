import { describe, it, expect, vi, beforeEach } from "vitest";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
import {
  createAgentWorktree,
  assertWorkspaceIntegrity,
  prepareAgentWorkspace,
  removeAgentWorkspace,
} from "./worktree";

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

  it("removeAgentWorkspace bridges remove_agent_worktree", async () => {
    invoke.mockResolvedValue(undefined);
    await removeAgentWorkspace("/root-rm", "p", "a");
    expect(invoke).toHaveBeenCalledWith("remove_agent_worktree", {
      root: "/root-rm", projectId: "p", agentId: "a",
    });
  });

  it("serializes worktree removal behind an in-flight prepare on the same root (no index.lock race)", async () => {
    // Gate ensure_project_repo so the prepare op stays in flight while we fire a removal.
    let releaseEnsure!: () => void;
    const ensureGate = new Promise<void>((r) => { releaseEnsure = r; });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "ensure_project_repo") return ensureGate;
      if (cmd === "create_agent_worktree") return Promise.resolve({ path: "/wt", branch: "b" });
      return Promise.resolve(undefined); // remove_agent_worktree
    });

    // Unique root so the module-level repo-lock chain isn't shared with other tests.
    const root = "/root-serialize";
    const prep = prepareAgentWorkspace(root, "p", "a", "main");
    const rem = removeAgentWorkspace(root, "p", "b");

    // Prepare is blocked on ensure_project_repo, so removal must wait on the same lock.
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalledWith("remove_agent_worktree", expect.anything());

    releaseEnsure();
    await prep;
    await rem;
    expect(invoke).toHaveBeenCalledWith("remove_agent_worktree", {
      root, projectId: "p", agentId: "b",
    });
  });
});
