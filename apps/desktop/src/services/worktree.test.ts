import { describe, it, expect, vi, beforeEach } from "vitest";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
import {
  createAgentWorktree,
  assertWorkspaceIntegrity,
  prepareAgentWorkspace,
  prepareWorkerWorkspace,
  removeAgentWorkspace,
  prewarmProjectCaches,
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

  it("prewarmProjectCaches git-inits the folder (ensure_project_repo) so in-place work is versioned", async () => {
    // The hazel-eco fix: opening a project must make its folder a git repo even before any BUILD
    // agent spawns, so Think/Chief/Shell work that runs in-place lands in a version-controlled tree.
    invoke.mockResolvedValue(undefined);
    const root = "/root-prewarm-ensure"; // unique root — the module's `prewarmed` guard is per-session
    prewarmProjectCaches(root);
    await new Promise((r) => setTimeout(r, 0)); // let the repo-lock microtask chain flush
    expect(invoke).toHaveBeenCalledWith("ensure_project_repo", { path: root });
    expect(invoke).toHaveBeenCalledWith("prewarm_spawn", { root });
  });

  it("prewarmProjectCaches only ensures the repo once per root (idempotent, no index.lock storm)", async () => {
    invoke.mockResolvedValue(undefined);
    const root = "/root-prewarm-once";
    prewarmProjectCaches(root);
    await new Promise((r) => setTimeout(r, 0));
    const firstEnsures = invoke.mock.calls.filter((c) => c[0] === "ensure_project_repo").length;
    expect(firstEnsures).toBe(1);
    invoke.mockClear();
    prewarmProjectCaches(root); // second touch of the same root
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).not.toHaveBeenCalledWith("ensure_project_repo", { path: root });
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

  it("serializes concurrent worker worktree cuts on the same root (no index.lock race)", async () => {
    // Regression for the concurrent spawn_worker corruption: two worker cuts on the same repo must
    // NOT run `git worktree add` in parallel (they'd collide on .git/index.lock). Gate the first cut
    // and assert the second doesn't start until the first resolves.
    let releaseFirst!: (v: { path: string; branch: string }) => void;
    const firstGate = new Promise<{ path: string; branch: string }>((r) => { releaseFirst = r; });
    let cuts = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree") {
        cuts += 1;
        return cuts === 1 ? firstGate : Promise.resolve({ path: "/wt2", branch: "b2" });
      }
      return Promise.resolve(undefined);
    });

    const root = "/root-worker-serialize";
    const a = prepareWorkerWorkspace({ root, projectId: "p", workerId: "w1", parentBranch: "main" });
    const b = prepareWorkerWorkspace({ root, projectId: "p", workerId: "w2", parentBranch: "main" });

    // First cut is gated in flight; the second must wait on the shared per-root lock.
    await Promise.resolve();
    await Promise.resolve();
    expect(cuts).toBe(1);

    releaseFirst({ path: "/wt1", branch: "b1" });
    await a;
    await b;
    expect(cuts).toBe(2);
  });
});
