import { describe, it, expect, vi, beforeEach } from "vitest";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

// `services/preview` is imported for real here — the preview-interlock tests below assert on the
// COMMAND NAME that crosses the bridge (`preview_stop_for_agent`), which a mocked module would hide.
// Only its event subscription is stubbed: preview.ts imports `listen` at module scope, and nothing
// in these tests arms the listener.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

// The env seeder shells out to the 1Password `op` CLI over IPC. Mocked here so the wiring — which
// call sites seed, with what, and that none of them WAIT on it — is testable without a vault.
vi.mock("./envSeed", () => ({
  seedWorktreeEnv: vi.fn(),
  abandonWorktreeSeed: vi.fn(() => Promise.resolve()),
}));

// The dependency bootstrap shells out to a package manager for ~27 seconds. Mocked for the same
// reason as the seeder: what is under test here is the WIRING — which seams bootstrap, and that
// none of them wait on it.
vi.mock("./depsBootstrap", () => ({
  bootstrapWorktreeDeps: vi.fn(),
  abandonWorktreeBootstrap: vi.fn(() => Promise.resolve()),
}));

// Seeding needs the project's NAME (the vault item titles are keyed on it), which worktree.ts
// reads from the store by id.
vi.mock("../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({ projects: [{ id: "p", name: "Sparkle", rootPath: "/root" }] }),
  },
}));

import { seedWorktreeEnv, abandonWorktreeSeed } from "./envSeed";
import { bootstrapWorktreeDeps, abandonWorktreeBootstrap } from "./depsBootstrap";
import {
  createAgentWorktree,
  assertWorkspaceIntegrity,
  ensureDefaultPluginsInstalled,
  installAgentHooks,
  prepareAgentWorkspace,
  prepareWorkerWorkspace,
  removeAgentWorkspace,
  prewarmProjectCaches,
} from "./worktree";

describe("worktree service", () => {
  beforeEach(() => invoke.mockReset());

  it("installAgentHooks passes the worktree AND the project root", async () => {
    // Tauri maps camelCase JS keys → snake_case Rust params, so `projectRoot` must be spelled
    // exactly that: a mismatched key silently arrives as None on the Rust side, which reads as
    // "no project" and quietly resolves the GLOBAL [plugins] layer instead of the repo's own —
    // an agent that gets the wrong plugins with nothing anywhere reporting a problem.
    invoke.mockResolvedValue("/logs/a.jsonl");
    await installAgentHooks("/wt/p/a", "/repos/acme");
    expect(invoke).toHaveBeenCalledWith("install_agent_hooks", {
      worktree: "/wt/p/a",
      projectRoot: "/repos/acme",
    });

    // Omitted is a valid call: the global layer. Asserted on the recorded argument directly —
    // toHaveBeenCalledWith's recursive equality treats `{worktree}` and `{worktree, projectRoot:
    // undefined}` as the same object, so it can't tell us which key set actually crossed the bridge.
    invoke.mockClear();
    await installAgentHooks("/wt/p/b");
    const [command, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("install_agent_hooks");
    expect(Object.keys(args)).toEqual(["worktree", "projectRoot"]);
    expect(args.projectRoot).toBeUndefined();
  });

  it("ensureDefaultPluginsInstalled bridges the install command and its force flag", async () => {
    const outcome = {
      key: "superpowers",
      id: "superpowers@claude-plugins-official",
      status: "installed" as const,
      message: null,
      detail: null,
    };
    invoke.mockResolvedValue([outcome]);
    // Default is NOT forced: the background callers (startup, every agent prepare) must keep the
    // per-process retry suppression, or an un-installable machine burns 90s network calls per agent.
    await expect(ensureDefaultPluginsInstalled()).resolves.toEqual([outcome]);
    expect(invoke).toHaveBeenCalledWith("ensure_default_plugins_installed", {
      forceKey: undefined,
    });

    // The user-initiated toggle opts in for ONE plugin, so "turn it off and on again" is a real
    // retry for the row clicked — without re-running every other row's 90s install.
    invoke.mockClear();
    await ensureDefaultPluginsInstalled("superpowers");
    expect(invoke).toHaveBeenCalledWith("ensure_default_plugins_installed", {
      forceKey: "superpowers",
    });
  });
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

  it("seeds an agent worktree with the project's ROOT PATH and the path that was just cut", async () => {
    // The project's own checkout is the SOURCE the env files are copied from (bead sparkle-y5xc9).
    // Passing the project NAME here — what this used to do, when seeding downloaded from the vault
    // by title — would hand the backend a name where it expects a directory, and every new
    // worktree would come up empty.
    invoke.mockResolvedValue({ path: "/wt/p/a", branch: "sparkle/agent-a" });
    await prepareAgentWorkspace("/root-seed-agent", "p", "a", "main");
    expect(seedMock).toHaveBeenCalledWith("/root", "/wt/p/a");
  });

  it("seeds a worker worktree too — a fan-out is where empty worktrees hurt most", async () => {
    invoke.mockResolvedValue({ path: "/wt/p/w1", branch: "sparkle/agent-w1" });
    await prepareWorkerWorkspace({
      root: "/root-seed-worker", projectId: "p", workerId: "w1", parentBranch: "main",
    });
    expect(seedMock).toHaveBeenCalledWith("/root", "/wt/p/w1");
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

// A git worktree carries only TRACKED files, so `node_modules` is never in a fresh one and the
// agent inside it cannot run the repo's tests (`vitest: command not found`). Measured: 44 of 84
// live agent worktrees on this machine had none. Same wiring properties as the seeder above —
// never wait, never fail, settle before teardown deletes the directory.
describe("worktree service — dependency bootstrap", () => {
  const bootstrapMock = vi.mocked(bootstrapWorktreeDeps);
  const abandonBootstrapMock = vi.mocked(abandonWorktreeBootstrap);

  beforeEach(() => {
    invoke.mockReset();
    bootstrapMock.mockReset();
    abandonBootstrapMock.mockReset();
    abandonBootstrapMock.mockResolvedValue(undefined);
  });

  it("bootstraps an agent worktree at the path that was just cut", async () => {
    invoke.mockResolvedValue({ path: "/wt/p/a", branch: "sparkle/agent-a" });
    await prepareAgentWorkspace("/root-deps-agent", "p", "a", "main");
    expect(bootstrapMock).toHaveBeenCalledWith("/wt/p/a");
  });

  it("bootstraps a worker worktree too — a fan-out is where this hurts most", async () => {
    // A fan-out cuts many worktrees at once and every one of them is expected to run tests before
    // reporting back. Missing this seam is how workers end up committing unverified work.
    invoke.mockResolvedValue({ path: "/wt/p/w1", branch: "sparkle/agent-w1" });
    await prepareWorkerWorkspace({
      root: "/root-deps-worker", projectId: "p", workerId: "w1", parentBranch: "main",
    });
    expect(bootstrapMock).toHaveBeenCalledWith("/wt/p/w1");
  });

  it("does NOT wait on the install — a spawn resolves while it is still running", async () => {
    // 27 seconds, measured. The same never-settling-thenable trick the seeder test uses: awaiting a
    // void would pass regardless, but the refactor that would actually break this — making the seam
    // await the bootstrap — hangs here instead of passing.
    const neverSettles = { then: () => {} } as unknown as void;
    bootstrapMock.mockReturnValue(neverSettles);
    invoke.mockResolvedValue({ path: "/wt/p/a", branch: "b" });
    const info = await prepareAgentWorkspace("/root-deps-nonblocking", "p", "a", "main");
    expect(info.path).toBe("/wt/p/a");
    expect(bootstrapMock).toHaveBeenCalled();
  });

  it("does not fail the spawn when the bootstrap throws outright", async () => {
    // A machine with no pnpm on its PATH must still be able to open agents.
    bootstrapMock.mockImplementation(() => {
      throw new Error("no pnpm");
    });
    invoke.mockResolvedValue({ path: "/wt/p/a", branch: "b" });
    await expect(
      prepareAgentWorkspace("/root-deps-throws", "p", "a", "main"),
    ).resolves.toMatchObject({ path: "/wt/p/a" });
  });

  it("settles the in-flight install BEFORE removing the worktree it writes into", async () => {
    // The bootstrap escapes the per-root git lock by design, so without this a `git worktree
    // remove` can run while a package manager is mid-write — which re-creates the tree git just
    // deleted and leaves a stray directory at a slot path a later `worktree add` then fails on.
    invoke.mockResolvedValue({ path: "/wt/p/a", branch: "b" });
    const root = "/root-deps-teardown";
    await prepareAgentWorkspace(root, "p", "a", "main");

    const order: string[] = [];
    abandonBootstrapMock.mockImplementation(() => {
      order.push("abandon-deps");
      return Promise.resolve();
    });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "remove_agent_worktree") order.push("remove");
      return Promise.resolve(undefined);
    });

    await removeAgentWorkspace(root, "p", "a");
    expect(abandonBootstrapMock).toHaveBeenCalledWith("/wt/p/a");
    expect(order).toEqual(["abandon-deps", "remove"]);
  });

  it("still settles the install when the project record is missing", async () => {
    // The bootstrap runs unconditionally, but the teardown handshake used to hang off the path map
    // the ENV SEED writes — and the seeder returns early, before writing it, when the project isn't
    // in the store. That early return is a documented real case (an evicted record, a worker
    // re-derived from its on-disk manifest, a store still rehydrating). In it, an install was
    // queued for a worktree that teardown then deleted without waiting, which is exactly the
    // stray-non-empty-slot hazard the handshake exists to prevent.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockResolvedValue({ path: "/wt/ghost/a", branch: "b" });
    const root = "/root-deps-ghost";
    await prepareAgentWorkspace(root, "ghost", "a", "main");
    expect(bootstrapMock).toHaveBeenCalledWith("/wt/ghost/a");

    invoke.mockResolvedValue(undefined);
    await removeAgentWorkspace(root, "ghost", "a");
    expect(abandonBootstrapMock).toHaveBeenCalledWith("/wt/ghost/a");
    warn.mockRestore();
  });

  it("waits out the two teardown settles concurrently, not one after the other", async () => {
    // Both waits are bounded at 5s and run INSIDE the per-root git lock, which every other
    // prepare/remove on that project queues behind. Awaited serially the worst case is 10s, and
    // because an install measures ~27s, hitting the cap is the common case when an agent is closed
    // shortly after opening — multiplied by N when a project's agents are closed one at a time.
    invoke.mockResolvedValue({ path: "/wt/p/a", branch: "b" });
    const root = "/root-deps-concurrent";
    await prepareAgentWorkspace(root, "p", "a", "main");

    // The distinguishing observation is whether the bootstrap wait STARTS while the seed wait is
    // still pending. Merely checking that the seed was *called* first would pass under either
    // arrangement, since a serial `await` also calls the seed first — it just then blocks on it.
    let seedResolved = false;
    let startedWhileSeedPending = false;
    vi.mocked(abandonWorktreeSeed).mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => {
            seedResolved = true;
            r();
          }, 20),
        ),
    );
    abandonBootstrapMock.mockImplementation(() => {
      if (!seedResolved) startedWhileSeedPending = true;
      return new Promise((r) => setTimeout(r, 20));
    });
    invoke.mockResolvedValue(undefined);

    await removeAgentWorkspace(root, "p", "a");
    expect(startedWhileSeedPending).toBe(true);
  });
});

// A preview is a LIVE dev server whose cwd is inside the agent's checkout — the one writer that
// outlives the agent's own processes. `remove_agent_worktree` renames that checkout into
// worktree-trash and then deletes it on a background thread, so a preview left running is writing
// into a directory that is being moved out from under it (docs/live-browser-preview.md §5,
// "Interlock with worktree teardown"; bead sparkle-3475b.6).
describe("worktree service — preview teardown interlock", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.mocked(abandonWorktreeSeed).mockReset().mockResolvedValue(undefined);
    vi.mocked(abandonWorktreeBootstrap).mockReset().mockResolvedValue(undefined);
  });

  it("stops the preview BEFORE the checkout is evacuated", async () => {
    // ORDER, not presence. A presence-only assertion stays green when the stop is issued AFTER the
    // rename has started — which is the exact race this interlock exists to close, so it would prove
    // nothing. Both commands push into one array and the array is compared as a sequence.
    const order: string[] = [];
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "preview_stop_for_agent") {
        order.push("preview-stop");
        return Promise.resolve({ outcome: "stopped" });
      }
      if (cmd === "remove_agent_worktree") order.push("remove");
      return Promise.resolve(undefined);
    });

    await removeAgentWorkspace("/root-preview-order", "p", "a");

    expect(invoke).toHaveBeenCalledWith("preview_stop_for_agent", { agentId: "a" });
    expect(order).toEqual(["preview-stop", "remove"]);
  });

  it("still stops the preview first on a worktree that WAS prepared (the real close path)", async () => {
    // The prepared path also settles the env seed and the dependency bootstrap. Whatever those two
    // do, the preview stop must still land ahead of the removal — this is the ordering that holds
    // in production, where every closed agent went through prepareAgentWorkspace first.
    invoke.mockResolvedValue({ path: "/wt/p/a", branch: "b" });
    const root = "/root-preview-prepared";
    await prepareAgentWorkspace(root, "p", "a", "main");

    const order: string[] = [];
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "preview_stop_for_agent") {
        order.push("preview-stop");
        return Promise.resolve({ outcome: "not-found" });
      }
      if (cmd === "remove_agent_worktree") order.push("remove");
      return Promise.resolve(undefined);
    });

    await removeAgentWorkspace(root, "p", "a");

    expect(order).toEqual(["preview-stop", "remove"]);
    expect(abandonWorktreeSeed).toHaveBeenCalledWith("/wt/p/a");
    expect(abandonWorktreeBootstrap).toHaveBeenCalledWith("/wt/p/a");
  });

  it("removes the worktree anyway when the preview stop rejects", async () => {
    // A stray preview must never be able to WEDGE cleanup: an un-removed worktree is a permanent
    // problem (its slot path fails a later `worktree add`), while a preview that outlived its stop
    // is a leaked process the supervisor's own reaping still covers.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockImplementation((cmd: string) =>
      cmd === "preview_stop_for_agent"
        ? Promise.reject(new Error("preview supervisor is wedged"))
        : Promise.resolve(undefined),
    );

    await expect(
      removeAgentWorkspace("/root-preview-throws", "p", "a"),
    ).resolves.toBeUndefined();

    expect(invoke).toHaveBeenCalledWith("remove_agent_worktree", {
      root: "/root-preview-throws", projectId: "p", agentId: "a",
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("asks unconditionally — no local 'did this agent have a preview' guard", async () => {
    // The Rust command is a map lookup that answers "not-found" when the agent has none
    // (preview.rs::preview_stop_for_agent), so the common case is already a cheap no-op. A guard
    // here would have to read state this module does not own, and would fail exactly where it
    // matters: after a window reload, the frontend store is empty while the server is still up.
    invoke.mockResolvedValue(undefined);
    await removeAgentWorkspace("/root-preview-never", "p", "never-previewed");
    expect(invoke).toHaveBeenCalledWith("preview_stop_for_agent", { agentId: "never-previewed" });
  });
});
