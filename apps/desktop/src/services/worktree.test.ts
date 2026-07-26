import { describe, it, expect, vi, beforeEach } from "vitest";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

// The env seeder shells out to the 1Password `op` CLI over IPC. Mocked here so the wiring — which
// call sites seed, with what, and that none of them WAIT on it — is testable without a vault.
vi.mock("./envSeed", () => ({
  seedWorktreeEnv: vi.fn(),
  abandonWorktreeSeed: vi.fn(() => Promise.resolve()),
}));

// Seeding needs the project's NAME (the vault item titles are keyed on it), which worktree.ts
// reads from the store by id.
vi.mock("../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({ projects: [{ id: "p", name: "Sparkle", rootPath: "/root" }] }),
  },
}));

import { seedWorktreeEnv, abandonWorktreeSeed } from "./envSeed";
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

// The 1Password env seed is wired into both worktree-cutting seams. The properties worth pinning
// are the ones a refactor could quietly break: a spawn must never WAIT on the seed, never FAIL on
// it, and teardown must settle it before deleting the directory it writes into.
describe("worktree service — env seeding", () => {
  const seedMock = vi.mocked(seedWorktreeEnv);
  const abandonMock = vi.mocked(abandonWorktreeSeed);

  beforeEach(() => {
    invoke.mockReset();
    seedMock.mockReset();
    abandonMock.mockReset();
    abandonMock.mockResolvedValue(undefined);
  });

  it("seeds an agent worktree with the project's NAME and the path that was just cut", async () => {
    // The NAME, not the id: vault item titles are `<projectName>/<relPath>`, so an id here would
    // match nothing and silently seed an empty worktree.
    invoke.mockResolvedValue({ path: "/wt/p/a", branch: "sparkle/agent-a" });
    await prepareAgentWorkspace("/root-seed-agent", "p", "a", "main");
    expect(seedMock).toHaveBeenCalledWith("Sparkle", "/wt/p/a");
  });

  it("seeds a worker worktree too — a fan-out is where empty worktrees hurt most", async () => {
    invoke.mockResolvedValue({ path: "/wt/p/w1", branch: "sparkle/agent-w1" });
    await prepareWorkerWorkspace({
      root: "/root-seed-worker", projectId: "p", workerId: "w1", parentBranch: "main",
    });
    expect(seedMock).toHaveBeenCalledWith("Sparkle", "/wt/p/w1");
  });

  it("does NOT wait on the seed — a spawn resolves while the restore is still running", async () => {
    // The seeder returns void today, so returning a never-settling THENABLE is what makes this test
    // meaningful: `await`ing a void is a no-op and would pass regardless, but the refactor that
    // would actually break the property — making the seam async and awaiting the seeder — hangs on
    // a thenable that never calls back. So this fails (times out) exactly when it should.
    const neverSettles = { then: () => {} } as unknown as void;
    seedMock.mockReturnValue(neverSettles);
    invoke.mockResolvedValue({ path: "/wt/p/a", branch: "b" });
    const info = await prepareAgentWorkspace("/root-seed-nonblocking", "p", "a", "main");
    expect(info.path).toBe("/wt/p/a");
    expect(seedMock).toHaveBeenCalled();
  });

  it("does not fail the spawn when seeding throws outright", async () => {
    seedMock.mockImplementation(() => {
      throw new Error("store exploded");
    });
    invoke.mockResolvedValue({ path: "/wt/p/a", branch: "b" });
    await expect(
      prepareAgentWorkspace("/root-seed-throws", "p", "a", "main"),
    ).resolves.toMatchObject({ path: "/wt/p/a" });
  });

  it("skips seeding — and says so — when the project isn't in the store", async () => {
    // Silence here is indistinguishable from "the feature is off", and the vault titles cannot be
    // built without the name, so this branch has to be audible.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockResolvedValue({ path: "/wt/ghost/a", branch: "b" });
    await prepareAgentWorkspace("/root-seed-ghost", "ghost", "a", "main");
    expect(seedMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("settles the in-flight seed BEFORE removing the worktree it writes into", async () => {
    // Seeding escapes the per-root git lock by design; without this, `git worktree remove` can run
    // while `op` is mid-write and the backend re-creates the tree git just deleted.
    invoke.mockResolvedValue({ path: "/wt/p/a", branch: "b" });
    const root = "/root-seed-teardown";
    await prepareAgentWorkspace(root, "p", "a", "main");

    const order: string[] = [];
    abandonMock.mockImplementation(() => {
      order.push("abandon");
      return Promise.resolve();
    });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "remove_agent_worktree") order.push("remove");
      return Promise.resolve(undefined);
    });

    await removeAgentWorkspace(root, "p", "a");
    expect(abandonMock).toHaveBeenCalledWith("/wt/p/a");
    expect(order).toEqual(["abandon", "remove"]);
  });

  it("removes a worktree it never seeded without waiting on anything", async () => {
    invoke.mockResolvedValue(undefined);
    await removeAgentWorkspace("/root-seed-none", "p", "never-seeded");
    expect(abandonMock).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("remove_agent_worktree", {
      root: "/root-seed-none", projectId: "p", agentId: "never-seeded",
    });
  });
});
