import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

// Preserve real ../pty exports (spawnWorker tests rely on real createWorkerWorktree which
// calls the already-mocked invoke above) — only override killPty.
// vi.fn() with no impl → typed as Mock<any[], any>, so spreading unknown[] into it is allowed.
// (vi.fn(() => impl) would infer [] for Args and break the spread.)
const killPtyMock = vi.fn();
vi.mock("../pty", async (orig) => ({
  ...(await orig<typeof import("../pty")>()),
  killPty: (...a: unknown[]) => killPtyMock(...a),
}));
const removeWsMock = vi.fn();
vi.mock("./worktree", async (orig) => ({
  ...(await orig<typeof import("./worktree")>()),
  removeAgentWorkspace: (...a: unknown[]) => removeWsMock(...a),
}));

import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useStaleBuildStore } from "./staleBuildService";
import { spawnWorker, spinDownWorker } from "./workerSpawn";
import { __resetTracesForTest, openTraceKinds } from "../perfTrace";

describe("spawnWorker", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    invokeMock.mockReset();
    // rollback() awaits removeAgentWorkspace(...).catch(...), so the mock must return a thenable;
    // reset per-test so the "not called" assertion isn't polluted by a prior rollback test.
    removeWsMock.mockReset();
    removeWsMock.mockResolvedValue(undefined);
    // Default: AI enhancements locked (anonymous) so the auto-name path stays dormant and these
    // tests assert spawn mechanics without a second (generate_agent_name) invoke.
    useAuthStore.setState({ me: null });
    // perfTrace's keyed traces are module-scoped and are only emptied by a mounted pane settling its
    // own waterfall, which never happens here — so without this, one case's `close:`/`switch:` trace
    // leaks into the next one's openTraceKinds().
    __resetTracesForTest();
    // The stale-build store is module-scoped too: default not-stale, and clear() after any test that
    // sets it so the stale-build guard doesn't reject an unrelated spawn in a later case.
    useStaleBuildStore.getState().clear();
  });

  it("creates a worker tab under the parent, cuts a worktree from the parent branch, and persists it", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    // Give the parent a known branch (as the worktree step would have).
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree")
        return Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" });
      return Promise.resolve(undefined); // write_worker_manifest, etc.
    });

    const spawned = await spawnWorker({ projectId, parentAgentId: buildId, task: "Build login" });
    const workerId = spawned.workerId;

    // The return carries the AUTHORITATIVE identity captured from the worktree cut (not re-read from
    // the store), so the orchestration reply can never degrade to empty branch/worktree (sparkle-yk3x).
    expect(spawned.branch).toBe("sparkle/agent-w");
    expect(spawned.worktree).toBe("/wt/worker");

    // Tauri call used the parent's branch as the base.
    expect(invokeMock).toHaveBeenCalledWith("create_worker_worktree", expect.objectContaining({
      root: "/tmp/demo", projectId, workerId, parentBranch: "sparkle/agent-build1",
    }));

    // sparkle-hwfv: a durable manifest was written INTO the worktree before returning, carrying the
    // worker's disk-authoritative identity (task-on-disk kills the taskless-stall on eviction).
    expect(invokeMock).toHaveBeenCalledWith("write_worker_manifest", {
      worktree: "/wt/worker",
      manifest: expect.objectContaining({
        workerId,
        buildAgentId: buildId,
        projectId,
        branch: "sparkle/agent-w",
        worktree: "/wt/worker",
        task: "Build login",
      }),
    });

    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    const worker = proj.agents.find((a) => a.id === workerId)!;
    expect(worker.kind).toBe("worker");
    expect(worker.parentId).toBe(buildId);
    expect(worker.task).toBe("Build login");
    expect(worker.worktreePath).toBe("/wt/worker");
    expect(worker.branch).toBe("sparkle/agent-w");
    // A spawn NEVER MOVES THE TAB. addAgent selects whatever it creates by default, but a spawn is
    // MCP-driven — the user never asked to be moved — so it passes `select: false`. The worker still
    // launches: runSpawn open()s it, and Workspace mounts a pane per OPEN id (only one is `visible`),
    // so nothing about the PTY depends on selection. Leaving it selected would also force its
    // orchestrator's subtree open (the sidebar reveals a selected worker), reproducing
    // expand-on-spawn — see engine/workerExpansion.
    expect(proj.selectedAgentId).toBe(buildId);
    expect(proj.selectedAgentId).not.toBe(workerId);
  });

  // A selection that never happens can't open a `switch:<id>` waterfall. Selecting the worker and
  // restoring afterwards DID open one: the restored pane's `visible` never flips (both writes land
  // in one render), so AgentPane's settleSwitchTrace never runs and the trace dangles — reported by
  // openTraceKinds() as an in-flight interaction on every later jank warning, several times a minute
  // during a fan-out. Suppressing the selection in the store leaves no trace to settle.
  // ── THE GOAL REACHES THE PERSISTED TAB ────────────────────────────────────────────────────────
  // The ONE property: a goal stated at dispatch is recorded on the worker record, so something other
  // than the worker can later decide whether it finished. Asserts the persisted SIDE EFFECT (the tab's
  // `goal`), not that spawnWorker accepted the argument — passing an arg it ignores would still pass a
  // "called with" assertion. Fails against the previous implementation, which had no `goal` at all.
  it("persists a stated goal on the worker record at creation", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "create_worker_worktree"
        ? Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" })
        : Promise.resolve(undefined),
    );

    const goal = "nested groups parse and parser.test.ts passes";
    const { workerId } = await spawnWorker({
      projectId,
      parentAgentId: buildId,
      task: "refactor the parser",
      goal,
    });

    const worker = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === workerId)!;
    expect(worker.goal?.text).toBe(goal);
    // Born unmet and un-escalated: a fresh goal is what LICENSES auto-continue, so a goal that
    // arrived already "met" would make the worker look finished the moment it was created.
    expect(worker.goal?.metAt).toBeUndefined();
    expect(worker.goal?.escalatedAt).toBeUndefined();
  });

  it("leaves the worker goalless when none was stated, rather than inventing one", async () => {
    // The override path (work with no verifiable criterion) must NOT synthesize a goal: a goalless
    // worker is a fact downstream needs to see, and a placeholder would make an unverifiable worker
    // look verifiable. A blank goal must also read as absent — setAgentGoal treats "" as CLEAR and
    // agentGoal.newGoal throws on it, so a blank reaching the store would be a crash, not a no-op.
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "create_worker_worktree"
        ? Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" })
        : Promise.resolve(undefined),
    );

    const bare = await spawnWorker({ projectId, parentAgentId: buildId, task: "spike the crash" });
    const blank = await spawnWorker({
      projectId,
      parentAgentId: buildId,
      task: "spike again",
      goal: "   ",
    });

    const agents = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agents.find((a) => a.id === bare.workerId)!.goal).toBeUndefined();
    expect(agents.find((a) => a.id === blank.workerId)!.goal).toBeUndefined();
  });

  it("opens no dangling switch trace (the selection never moves)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree")
        return Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" });
      return Promise.resolve(undefined);
    });

    await spawnWorker({ projectId, parentAgentId: buildId, task: "Build login" });

    // Narrowed to the kind under test: openTraceKinds() is global, and other spawn machinery may
    // legitimately open traces of other kinds.
    expect(openTraceKinds() ?? "").not.toContain("switch");
  });

  it("leaves the user on the tab they were reading, even when it isn't the orchestrator", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    // The user is reading a DIFFERENT agent while the orchestrator fans out.
    const otherId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree")
        return Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" });
      return Promise.resolve(undefined);
    });

    await spawnWorker({ projectId, parentAgentId: buildId, task: "Build login" });

    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    expect(proj.selectedAgentId).toBe(otherId);
  });

  // A null selection is NOT a hole for the spawn to fill. It is produced deliberately — Workspace's
  // ladder pick and closeAgent's selectionAfterClose both yield it (e.g. every row hidden by the
  // status filter), and mergePreservingLiveWorkers treats a live null as authoritative. `select:
  // false` briefly self-cancelled here, which handed the user's terminal to a machine-created worker
  // in exactly that state — and because the sidebar's selection-reveal effect expands the parent of
  // a SELECTED worker, it also forced the orchestrator's subtree open, reproducing expand-on-spawn
  // through the back door (§14). The worker must stay unselected, so the reveal effect never fires.
  it("does not steal the tab (or open the subtree) when nothing is selected", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    useProjectStore.getState().selectAgent(projectId, null);

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree")
        return Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" });
      return Promise.resolve(undefined);
    });

    const { workerId } = await spawnWorker({ projectId, parentAgentId: buildId, task: "x" });

    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    expect(proj.agents.some((a) => a.id === workerId)).toBe(true); // the worker IS created…
    expect(proj.selectedAgentId).toBeNull(); // …it just isn't selected
    expect(proj.selectedAgentId).not.toBe(workerId);
  });

  // Same rule for an ABSENT key, not just an explicit null — a persisted/merged project record can
  // arrive with no `selectedAgentId` at all, and the old guard's strict `!== null` let that case
  // through to "select it".
  it("does not steal the tab when the selection key is absent (undefined)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    useProjectStore.setState({
      projects: useProjectStore.getState().projects.map((p) => {
        if (p.id !== projectId) return p;
        const { selectedAgentId: _drop, ...rest } = p;
        return rest as typeof p;
      }),
    });

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree")
        return Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" });
      return Promise.resolve(undefined);
    });

    const { workerId } = await spawnWorker({ projectId, parentAgentId: buildId, task: "x" });

    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    expect(proj.agents.some((a) => a.id === workerId)).toBe(true);
    expect(proj.selectedAgentId).toBeUndefined();
    expect(proj.selectedAgentId).not.toBe(workerId);
  });

  it("auto-names the worker from its task when the autoRename feature is unlocked", async () => {
    // Has credits + setting on → the same auto-name path that names build agents from their first
    // typed prompt now names a worker from its injected task (it never flows through the Composer).
    useAuthStore.setState({ me: { clerkUserId: "u", entitled: true, balanceCents: 20000, tokenVersion: 0 } });
    useSettingsStore.setState({ aiAutoRename: true });

    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");

    // Key the mock on the command name (not call order): maybeAutoName fires unawaited (void), so
    // a queued mockResolvedValueOnce would be brittle to any incidental invoke landing between the
    // worktree cut and the naming call.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree") return Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" });
      if (cmd === "generate_agent_name") return Promise.resolve({ title: "Login flow", description: "Build the login flow" });
      return Promise.resolve(undefined);
    });

    const { workerId } = await spawnWorker({ projectId, parentAgentId: buildId, task: "Build the login flow" });

    // The naming backend was called with the worker's task as the basis.
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("generate_agent_name", {
        prompt: "Build the login flow",
        project: "Demo", // metering-only attribution for the Credits history
      }),
    );
    await vi.waitFor(() => {
      const worker = useProjectStore.getState().projects.find((p) => p.id === projectId)!
        .agents.find((a) => a.id === workerId)!;
      expect(worker.name).toBe("Login flow");
      expect(worker.autoNameVariants?.title).toBe("Login flow");
    });
  });

  it("does NOT auto-name the worker when AI enhancements are locked (anonymous trial)", async () => {
    useAuthStore.setState({ me: null }); // not entitled
    useSettingsStore.setState({ aiAutoRename: true });

    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree")
        return Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" });
      return Promise.resolve(undefined);
    });

    await spawnWorker({ projectId, parentAgentId: buildId, task: "Build the login flow" });

    // The worktree cut + the durable manifest write — but NO billed naming call when gated off.
    expect(invokeMock).toHaveBeenCalledWith("create_worker_worktree", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("write_worker_manifest", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("generate_agent_name", expect.anything());
  });

  it("throws if the parent has no branch yet", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    await expect(spawnWorker({ projectId, parentAgentId: buildId, task: "x" }))
      .rejects.toThrow(/branch/);
  });

  // sparkle-cmtg — a STALE running build serving old orchestration code repeatedly mis-derived a
  // live parent's branch as empty and then threw the "no branch yet" error, sending the operator
  // hunting for a branch problem that did not exist. The stale-build guard must fire FIRST and say
  // so accurately. THE SIDE EFFECT: the SAME no-branch input that throws /branch/ above now throws a
  // stale/restart error and NOT the branch error — so reverting the guard (falling through to the
  // branch throw) flips this from stale→branch and fails the assertion (non-vacuous).
  it("reports a stale build instead of the misleading 'no branch' error", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    // Parent has NO branch — the exact input that yields "no branch yet" on a current build.
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    // The running build is older than the one installed on disk (staleBuildService).
    useStaleBuildStore.getState().setStale("0.99.0");

    const err = await spawnWorker({ projectId, parentAgentId: buildId, task: "x" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/stale|restart/i);
    expect(err!.message).toContain("0.99.0"); // the installed version the operator must restart into
    // The accurate failure REPLACES the branch red herring — the operator is not sent hunting.
    expect(err!.message).not.toMatch(/no branch yet — open it first/);
  });

  // The guard gates the spawn on staleness itself, not merely the no-branch path: a stale build must
  // not spawn workers from orchestration code that no longer matches what shipped, branch or not.
  it("refuses to spawn on a stale build even when the parent HAS a branch", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    useStaleBuildStore.getState().setStale("0.99.0");

    // A valid-branch spawn would normally cut a worktree; on a stale build it must be refused up
    // front, so create_worker_worktree is never even invoked.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "create_worker_worktree"
        ? Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" })
        : Promise.resolve(undefined),
    );

    await expect(spawnWorker({ projectId, parentAgentId: buildId, task: "x" }))
      .rejects.toThrow(/stale|restart/i);
    expect(invokeMock).not.toHaveBeenCalledWith("create_worker_worktree", expect.anything());
  });

  it("rolls back the worker tab if worktree creation fails (no orphan)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const before = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents.length;

    // Keyed on the command name, not on call ORDER: a queued `...Once` is brittle to any incidental
    // invoke landing first (anything that logs goes through invoke) and fails as a confusing
    // "cannot read properties of undefined" from create_worker_worktree rather than as itself. Same
    // reasoning as the auto-name test above.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "create_worker_worktree"
        ? Promise.reject(new Error("git failed"))
        : Promise.resolve(undefined),
    );
    await expect(spawnWorker({ projectId, parentAgentId: buildId, task: "x" }))
      .rejects.toThrow(/git failed/);

    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    expect(proj.agents.length).toBe(before); // orphan worker tab was removed
    expect(proj.agents.some((a) => a.kind === "worker")).toBe(false);
    // The user was never moved off the build agent in the first place.
    expect(proj.selectedAgentId).toBe(buildId);
  });

  // The rollback must not re-assert a selection either. It used to restore the tab captured before
  // addAgent, which — now that the spawn never moves the user — can only fire when the user
  // navigated somewhere else DURING the awaits, yanking them back to a tab they deliberately left.
  it("leaves a tab the user switched to mid-spawn alone when the spawn fails", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const otherId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
    useProjectStore.getState().selectAgent(projectId, buildId);

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== "create_worker_worktree") return Promise.resolve(undefined);
      // The user wanders off while the worktree cut is in flight, then it fails.
      useProjectStore.getState().selectAgent(projectId, otherId);
      return Promise.reject(new Error("git failed"));
    });

    await expect(spawnWorker({ projectId, parentAgentId: buildId, task: "x" }))
      .rejects.toThrow(/git failed/);

    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    expect(proj.selectedAgentId).toBe(otherId);
  });

  // The other side of that guard. The worker's ROW exists from addAgent onward, so with the
  // orchestrator's subtree open the user can click it during the (seconds-long) worktree cut. When
  // the spawn then fails, the selected agent disappears and removeAgent's own fallback is
  // `agents[0]` — the first tab in insertion order, somewhere the user has never been. Hand them the
  // orchestrator that owns the failed spawn instead.
  it("hands the user the orchestrator if they were ON the worker when the spawn failed", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    // agents[0] must be a DIFFERENT agent, or "fell back to agents[0]" masquerades as a pass. The
    // DECOY IS CREATED SECOND, and that ordering is the assertion's whole discriminator: `addAgent`
    // INSERTS at the front, so the last row created is the one at index 0. It used to be created
    // first, back when `addAgent` appended — and when the insertion side flipped, this test went
    // silently vacuous with its own comment still claiming the guard (roborev 56125).
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    const firstId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
    useProjectStore.getState().setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-b");

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== "create_worker_worktree") return Promise.resolve(undefined);
      // The user clicks the freshly-appeared worker row while the cut is in flight.
      const p = useProjectStore.getState().projects.find((x) => x.id === projectId)!;
      const worker = p.agents.find((a) => a.kind === "worker")!;
      useProjectStore.getState().selectAgent(projectId, worker.id);
      return Promise.reject(new Error("git failed"));
    });

    await expect(spawnWorker({ projectId, parentAgentId: buildId, task: "x" }))
      .rejects.toThrow(/git failed/);

    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    expect(proj.selectedAgentId).toBe(buildId);
    expect(proj.selectedAgentId).not.toBe(firstId);
  });

  it("rolls back the just-cut worktree AND the tab if the manifest write fails (fail-closed, a670)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const before = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents.length;

    // Worktree cut succeeds, but persisting the durable manifest fails → the whole spawn must roll
    // back so we NEVER return a worktree for a worker that isn't fully registered.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree")
        return Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" });
      if (cmd === "write_worker_manifest") return Promise.reject(new Error("disk full"));
      return Promise.resolve(undefined);
    });

    await expect(spawnWorker({ projectId, parentAgentId: buildId, task: "x" })).rejects.toThrow(
      /disk full/,
    );

    // The just-cut worktree was removed from disk (rollback), and the orphan tab is gone.
    expect(removeWsMock).toHaveBeenCalledWith("/tmp/demo", projectId, expect.any(String));
    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    expect(proj.agents.length).toBe(before);
    expect(proj.agents.some((a) => a.kind === "worker")).toBe(false);
    expect(proj.selectedAgentId).toBe(buildId);
  });

  // A ROLLED-BACK WORKER MUST NOT LEAVE A PHANTOM `close:` TRACE (roborev 60088).
  //
  // `removeAgent` opens `close:<id>` unconditionally, and its only remover is `perfEnd` in
  // AgentPane's unmount cleanup. On this path the worker's pane NEVER mounted — the row is added
  // with `select: false` and `runtime.open(workerId)` does not run until `runSpawn`, which is
  // exactly what this rollback is the failure to reach. Left behind, the entry is reported by
  // `openTraceKinds()` as an in-flight interaction on every later jank warning, growing by one per
  // failed spawn — and fan-out reaches this path (worktree cut failures) far more often than the
  // build-agent teardown where the same leak was first found.
  it("leaves no dangling close trace when the spawn rolls back", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");

    invokeMock.mockImplementation((cmd: string) =>
      cmd === "create_worker_worktree"
        ? Promise.reject(new Error("git failed"))
        : Promise.resolve(undefined),
    );

    await expect(spawnWorker({ projectId, parentAgentId: buildId, task: "x" })).rejects.toThrow(
      /git failed/,
    );

    // The row really is gone — so any `close` entry still open is a leak, not a live interaction.
    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    expect(proj.agents.some((a) => a.kind === "worker")).toBe(false);
    expect(openTraceKinds() ?? "").not.toContain("close");
  });

  it("does NOT try to remove a worktree when the cut itself failed (nothing to roll back)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree") return Promise.reject(new Error("git failed"));
      return Promise.resolve(undefined);
    });

    await expect(spawnWorker({ projectId, parentAgentId: buildId, task: "x" })).rejects.toThrow(
      /git failed/,
    );
    // No worktree exists yet, so removeAgentWorkspace must NOT be called on this path.
    expect(removeWsMock).not.toHaveBeenCalled();
  });
});

describe("spinDownWorker", () => {
  beforeEach(() => {
    vi.restoreAllMocks(); // restore any vi.spyOn (e.g. runtime-store close) so it can't leak between tests
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    useRuntimeStore.setState({ status: {}, openAgentIds: [], branchStatus: {} });
    // The "a pane could end it" case below deliberately LEAVES `close:<id>` open, so without this
    // it persists in the module-level map and poisons any later openTraceKinds() assertion — and
    // the file's current order is the only reason it doesn't already (roborev 60107).
    __resetTracesForTest();
    killPtyMock.mockReset();
    killPtyMock.mockResolvedValue(undefined);
    removeWsMock.mockReset();
    removeWsMock.mockResolvedValue(undefined);
  });

  it("kills pty, removes worktree, closes runtime entry, removes tab, keeps branch", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId })!;
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");

    // Spy on the runtime store's close to assert the 4th teardown step fires.
    const runtimeCloseMock = vi.spyOn(useRuntimeStore.getState(), "close");
    await spinDownWorker({ projectId, workerId });

    // Named, so the ledger records automation rather than reporting a human stop.
    expect(killPtyMock).toHaveBeenCalledWith(workerId, "worker-spin-down");
    expect(removeWsMock).toHaveBeenCalledWith("/tmp/demo", projectId, workerId, {
      snapshotWip: true,
    });
    expect(runtimeCloseMock).toHaveBeenCalledWith(workerId); // runtime entry closed
    const agents = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agents.some((a) => a.id === workerId)).toBe(false); // tab gone
  });

  // A × ON A WORKER ROW IS A HUMAN, NOT A REAP. This path is the sidebar's early return, and it had
  // both defects the build-agent path was fixed for: the kill landed after the row dropped (so the
  // pane unmount's `pane-unmount` won the first-writer race), and even winning it would have said
  // `worker-spin-down` — indistinguishable from `reapOrphanedWorkers` (roborev 64259).
  it("records the CALLER's reason when one is given, rather than always saying automation", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId })!;
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");

    await spinDownWorker({ projectId, workerId, stoppedBy: "sidebar-close-agent" });

    expect(killPtyMock).toHaveBeenCalledWith(workerId, "sidebar-close-agent");
  });

  it("dispatches the kill BEFORE the row is dropped, so the pane unmount cannot win the race", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId })!;
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");

    // The row is gone the moment `removeAgent` runs; record whether the kill had already been
    // dispatched by then. `mark_stopped_at` is first-writer-wins, so "before" is the whole property.
    let killedBeforeRowDropped = false;
    const removeSpy = vi
      .spyOn(useProjectStore.getState(), "removeAgent")
      .mockImplementation((...a: Parameters<typeof store.removeAgent>) => {
        killedBeforeRowDropped = killPtyMock.mock.calls.length > 0;
        return useProjectStore.getInitialState().removeAgent(...a);
      });
    try {
      await spinDownWorker({ projectId, workerId, stoppedBy: "sidebar-close-agent" });
    } finally {
      removeSpy.mockRestore();
    }

    expect(killedBeforeRowDropped).toBe(true);
  });

  // THE WORKTREE IS DELETED HERE AND THE BRANCH IS NOT, so anything uncommitted dies with the
  // directory. An app restart killed two workers holding ~870 lines that existed nowhere else, and a
  // routine spin-down at that moment would have destroyed both halves silently (bead sparkle-ovzoj).
  //
  // The snapshot itself lives INSIDE removeAgentWorkspace (it has to run after that function settles
  // the env seed and the dependency bootstrap, which are still writing into the worktree). What this
  // path owns is ASKING for it — so that is what is asserted here, and worktree.test.ts owns the
  // ordering against the removal.
  it("asks for a WIP snapshot when it tears the worktree down", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId })!;
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");

    await spinDownWorker({ projectId, workerId });

    expect(removeWsMock).toHaveBeenCalledWith("/tmp/demo", projectId, workerId, {
      snapshotWip: true,
    });
    // And the request is made only after the pty is killed: a live worker is still writing, so a
    // snapshot taken mid-keystroke captures a torn file and is superseded anyway.
    expect(killPtyMock).toHaveBeenCalled();
  });

  it("is a no-op for an unknown project or worker id (idempotent)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");

    await expect(spinDownWorker({ projectId, workerId: "ghost" })).resolves.toBeUndefined();
    await expect(spinDownWorker({ projectId: "ghost", workerId: "ghost" })).resolves.toBeUndefined();

    expect(killPtyMock).not.toHaveBeenCalled();
    expect(removeWsMock).not.toHaveBeenCalled();
  });

  it("is a no-op when passed a build agent id (worker-only contract)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId })!;

    // Passing the build id must NOT tear anything down: removeAgent cascades to the build's
    // workers, which would orphan their PTYs/worktrees (this fn only tears down the passed id).
    await spinDownWorker({ projectId, workerId: buildId });

    expect(killPtyMock).not.toHaveBeenCalled();
    expect(removeWsMock).not.toHaveBeenCalled();
    const agents = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agents.some((a) => a.id === buildId)).toBe(true); // build still present
    expect(agents.some((a) => a.id === workerId)).toBe(true); // its worker not cascade-removed
  });

  it("drops the row BEFORE the slow worktree removal resolves (optimistic teardown)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId })!;
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");

    // Hold the worktree removal open — this is the slow git op the row must NOT wait on.
    let resolveRemove!: () => void;
    removeWsMock.mockReturnValue(
      new Promise<void>((r) => {
        resolveRemove = () => r();
      }),
    );

    const rows = () =>
      useProjectStore.getState().projects.find((x) => x.id === projectId)!.agents;
    const p = spinDownWorker({ projectId, workerId });
    // The contract is that the row drops SYNCHRONOUSLY — before spinDownWorker's first `await`.
    // Assert with NO interposed awaits, so a regression that moved removeAgent back behind an await
    // (waiting on the slow worktree removal) fails here even though removeWs is still pending.
    expect(rows().some((a) => a.id === workerId)).toBe(false);

    resolveRemove();
    await p;
    // The slow disk cleanup still ran — just off the interaction path.
    expect(removeWsMock).toHaveBeenCalledWith("/tmp/demo", projectId, workerId, {
      snapshotWip: true,
    });
    // Named, so the ledger records automation rather than reporting a human stop.
    expect(killPtyMock).toHaveBeenCalledWith(workerId, "worker-spin-down");
  });

  it("still removes the tab when killPty / removeAgentWorkspace reject", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId })!;
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");

    killPtyMock.mockRejectedValue(new Error("pty gone"));
    removeWsMock.mockRejectedValue(new Error("git failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(spinDownWorker({ projectId, workerId })).resolves.toBeUndefined();

    const agents = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agents.some((a) => a.id === workerId)).toBe(false); // tab removed despite failures
    warnSpy.mockRestore();
  });
});
