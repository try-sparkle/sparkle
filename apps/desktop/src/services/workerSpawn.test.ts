import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GOAL_MAX_LEN } from "@sparkle/core";
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
import { useBeadsStore } from "../stores/beadsStore";
import { spawnWorker, spinDownWorker, ladderGoalFor } from "./workerSpawn";
import { __resetTracesForTest, openTraceKinds, perfEnd } from "../perfTrace";
import { registerMountedPane, unregisterMountedPane } from "./agentPaneRegistry";

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
  // TWO THINGS KEEP THIS PATH CLEAN, and this test asserts the OUTCOME rather than either one, so
  // it holds whichever is doing the work. `removeAgent` opens `close:<id>` only while a pane is
  // mounted to end it (`services/agentPaneRegistry`), and on this path the worker's pane never
  // mounted — the row is added with `select: false` and `runtime.open(workerId)` does not run until
  // `runSpawn`, which is exactly what this rollback is the failure to reach. On top of that the
  // rollback calls `removeAgentWithoutPane`, whose `perfCancel` suppresses a waterfall for a spawn
  // that failed even if a pane HAD mounted during the awaits. Left open, such an entry is reported
  // by `openTraceKinds()` as an in-flight interaction on every later jank warning, growing by one
  // per failed spawn — and fan-out reaches this path (worktree cut failures) far more often than the
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
    // LOAD-BEARING, and this comment used to claim the opposite ("hygiene only … a reset cannot
    // manufacture its result", roborev 60107). That was true while the leak case asserted on
    // `close` specifically; it stopped being true when the assertions were tightened to the WHOLE
    // map, and both of this describe's trace assertions are now whole-map — the no-pane leak case's
    // `expect(openTraceKinds()).toBeUndefined()` (`:782`) and the mounted-pane positive case's
    // `expect(openTraceKinds()).toBe("close")` (`:817`); grep the assertions, not the line numbers,
    // which rot every time this comment is edited (roborev 67483). `traces` is module-scoped
    // (`perfTrace.ts:29`), so the `spawn:`/`switch:` residue the earlier `spawnWorker` describes
    // leave behind would fail both. Remove this line
    // and two tests go red — it is not decorative, and it must not be relocated or loosened away.
    //
    // WHAT IT COSTS, stated so the next reader can price it: a reset cannot mask a leak opened
    // WITHIN one of these tests, which is the only window they claim about, but it does hide
    // cross-test leakage from earlier describes. `conciergeTools/lifecycle.test.ts:944` answers the
    // same question the OPPOSITE way on purpose — it never resets, and narrows its assertion
    // instead, because there the whole-map emptiness across the file is the thing worth asserting.
    // The two files are deliberately different; change one and read the other first.
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

  // PER-SITE LEAK COVERAGE — `spinDownWorker` (bead sparkle-bxidpw).
  //
  // One of four+ teardown sites that call `removeAgent`, each covered separately on purpose. The fix
  // is a single gate in the store, so it would be easy to believe one test covers them all — but
  // AGENTS.md's `sparkle-50m03` is exactly this trap: a shared fix goes vacuously green the moment
  // ANY ONE site is covered, while a site that later grows its own `perfStart`, or stops routing
  // through the store, silently regresses. Each site therefore states its own contract.
  //
  // This site is the one the ORCHESTRATOR drives on fan-out, so it is the highest-volume leaker in a
  // real session: a build agent spinning down N workers removes N rows, and a worker's pane is very
  // often never mounted (the project was never visited, or the row was closed from another window).
  //
  // Proving the waterfall SETTLES on a real React unmount needs a real pane and stays in
  // `components/AgentPane.closeTrace.test.tsx`. What that file CANNOT cover is this site's ordering
  // — it calls `removeAgent` directly and never drives `spinDownWorker` — so the positive half for
  // THIS call site is the test below.
  it("leaves NO dangling close trace when the worker's pane was never mounted", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId })!;
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");
    // No pane is registered for this worker — the normal case for a spun-down worker, and the exact
    // condition under which this site used to leak.

    await spinDownWorker({ projectId, workerId });

    // The row really is gone, so any `close` entry still open is a ghost, not a live interaction.
    const agents = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agents.some((a) => a.id === workerId)).toBe(false);
    // THE SIDE EFFECT: the exact string the jank monitor would print in its `during` field.
    //
    // `toBeUndefined()`, NOT a narrowed `.not.toContain("close")`. This assertion used to be the
    // weaker form on the stated grounds that "this path also opens a `switch:` trace via the
    // selection fallback" — which is false here, and reasoning from a mechanism that does not exist
    // is how the next reader loosens the right assertion (roborev 67348, 67368). `spinDownWorker`
    // never calls `selectAgent`: `reselectAfterClose` is a local of `AgentSidebar`, and
    // `removeAgent` recomputes `selectedAgentId` inside its own `set` without touching `perfStart`.
    // The only `selectAgent` in this FILE is the spawn rollback at `workerSpawn.ts:185`, in a
    // different describe — and this describe's own `beforeEach` calls `__resetTracesForTest()`, so
    // nothing carries in either way.
    //
    // The exact shape matters as much as the emptiness: the stall line embeds this value verbatim,
    // so `undefined` is the pass and `""` would read as a real in-flight interaction with no name.
    // Asserting it whole also catches a leak of ANY kind this path grows later — including a
    // `switch:` one, which is precisely what the narrowed form could not have seen.
    expect(openTraceKinds()).toBeUndefined();
  });

  // THE POSITIVE HALF OF THE PAIR, AT THIS CALL SITE (roborev 67368).
  //
  // The test above proves no trace is LEFT when no pane exists. On its own that is ambiguous: it
  // passes just as well against a change that killed the waterfall everywhere, which is the worse
  // failure — the instrument goes SILENT instead of noisy, and nothing else in the suite notices.
  // `workerSpawn.ts` states the claim this pins in its own comment: this site keeps its waterfall
  // because `close()` and `removeAgent()` run in the same tick, BEFORE the function's first
  // `await`, so a mounted pane is still mounted when the store asks.
  //
  // SO THE PROMISE IS DELIBERATELY NOT AWAITED BEFORE THE ASSERTION. That is the whole test. Move
  // `removeAgent` behind any await — `await kill`, `await removeAgentWorkspace`, the
  // `terminateIfCloud` this family previously awaited — and the synchronous prefix no longer opens
  // the trace, so this goes red while every leak assertion in the file stays green.
  //
  // `registerMountedPane` rather than a real `AgentPane`: this is a service suite with no React
  // tree, and the fact under test is what the store's gate READS at this site. Settled by hand
  // afterwards in the pane's own order (`perfEnd`, then deregister), so nothing is left behind.
  it("keeps the close waterfall when the worker's pane IS mounted — opened before the first await", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId })!;
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");
    // THE ONLY DIFFERENCE FROM THE TEST ABOVE — the world, not the call.
    registerMountedPane(workerId);

    const pending = spinDownWorker({ projectId, workerId });
    try {
      // BEFORE the await resolves: the synchronous prefix must already have dropped the row AND
      // opened the trace. `toBe`, not `toContain` — this describe resets the trace map, so the
      // whole `during` string is knowable and an extra kind appearing here is itself a finding.
      expect(openTraceKinds()).toBe("close");
      expect(
        useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents.some((a) => a.id === workerId),
      ).toBe(false);
    } finally {
      await pending;
      perfEnd(`close:${workerId}`, "unmounted");
      unregisterMountedPane(workerId);
    }
    // Settled, not merely opened — so this test cannot become the residue the one above forbids.
    expect(openTraceKinds()).toBeUndefined();
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

// ══ THE LADDER FALLBACK (bead sparkle-wab4lm) ══════════════════════════════════════════════════
//
// A blank `goal` here means the orchestrator used `spawn_worker`'s recorded `goalOverride` escape
// hatch. That is the right answer for work with genuinely no criterion — but under an epic that HAS
// a stated goal it is a contradiction, and it leaves the worker in exactly the goalless population
// the dispatch gate exists to shrink. So the spawn writes a deterministic template naming the task
// and the objective it serves.
//
// EVERY EARLIER GATE IS SEEDED IN `ladderSetup` — a real project, a parent with a branch, a cleared
// stale-build store and a mocked worktree cut. A missing one of those throws BEFORE the goal block
// runs, so an absence assertion would pass for a reason that has nothing to do with the rule under
// test (AGENTS.md, "an earlier guard short-circuits the path"). Every absence case below is paired
// with a presence case on the SAME setup, which is what pins the cause rather than the outcome.
describe("spawnWorker — epic goal laddering", () => {
  const EPIC_GOAL = "Every agent dispatched under an epic carries a slice of that epic's goal";
  // `type: "epic"` is what `beads.isEpic` reads structurally, and `parent` is the membership edge
  // `parentEpicOf` resolves from the child side.
  const BEADS = [
    { id: "epic-1", title: "The epic", description: "", status: "open", type: "epic", labels: [] },
    { id: "task-1", title: "A task", description: "", status: "open", parent: "epic-1", labels: [] },
    { id: "loose-1", title: "Orphan", description: "", status: "open", labels: [] },
  ];

  function ladderSetup(withEpicGoal: boolean): { projectId: string; buildId: string } {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    useBeadsStore.setState({
      byProject: { [projectId]: { beads: BEADS as never, board: null as never, loadedAt: 1 } },
    });
    if (withEpicGoal) {
      useProjectStore.getState().setEpicGoal(projectId, "epic-1", EPIC_GOAL, "human");
    }
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "create_worker_worktree"
        ? Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" })
        : Promise.resolve(undefined),
    );
    return { projectId, buildId };
  }

  const goalOf = (projectId: string, workerId: string) =>
    useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === workerId)!.goal;

  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    useBeadsStore.setState({ byProject: {} });
    invokeMock.mockReset();
    removeWsMock.mockReset();
    removeWsMock.mockResolvedValue(undefined);
    useAuthStore.setState({ me: null });
    useStaleBuildStore.getState().clear();
  });

  afterEach(() => {
    // The beads store is MODULE-scoped, so a snapshot left here would be visible to every later
    // suite in this file and silently change what their spawns resolve.
    useBeadsStore.setState({ byProject: {} });
  });

  it("writes a laddering goal when the orchestrator supplied none and the epic HAS one", async () => {
    const { projectId, buildId } = ladderSetup(true);

    const { workerId } = await spawnWorker({
      projectId,
      parentAgentId: buildId,
      task: "wire the dispatch path",
      beadId: "task-1",
      // The override shape: no goal at all.
    });

    const goal = goalOf(projectId, workerId);
    // BOTH ENDS OF THE LADDER, asserted on the persisted string. The task half is what makes the
    // criterion checkable at all; the epic half is the whole point of the feature.
    expect(goal?.text).toContain("task-1");
    expect(goal?.text).toContain(EPIC_GOAL);
    expect(goal?.text.length).toBeLessThanOrEqual(GOAL_MAX_LEN);
  });

  it("does NOT overwrite a goal the orchestrator DID supply", async () => {
    // Same epic, same goal-bearing setup as above — the only difference is that a goal was stated.
    // Overwriting it would replace a criterion a model wrote with full context on this slice with a
    // template that has none, which is strictly worse than the thing it salvages.
    const { projectId, buildId } = ladderSetup(true);
    const stated = "the dispatch path passes sendToBuild.test.ts and typecheck is clean";

    const { workerId } = await spawnWorker({
      projectId,
      parentAgentId: buildId,
      task: "wire the dispatch path",
      beadId: "task-1",
      goal: stated,
    });

    expect(goalOf(projectId, workerId)?.text).toBe(stated);
    expect(goalOf(projectId, workerId)?.text).not.toContain(EPIC_GOAL);
  });

  it("leaves a worker under a GOAL-LESS epic exactly as it is today", async () => {
    // The paired absence. Identical bead graph and identical spawn — only the epic's goal is
    // missing — so a failure here can only mean the rule fired without a parent objective to
    // ladder to, not that some earlier gate swallowed the spawn.
    const { projectId, buildId } = ladderSetup(false);

    const { workerId } = await spawnWorker({
      projectId,
      parentAgentId: buildId,
      task: "wire the dispatch path",
      beadId: "task-1",
    });

    expect(goalOf(projectId, workerId)).toBeUndefined();
  });

  it("leaves a worker whose bead belongs to NO epic alone, even when other epics have goals", async () => {
    const { projectId, buildId } = ladderSetup(true);

    const { workerId } = await spawnWorker({
      projectId,
      parentAgentId: buildId,
      task: "spike the crash",
      beadId: "loose-1",
    });

    expect(goalOf(projectId, workerId)).toBeUndefined();
  });

  it("truncates the EPIC-GOAL half to fit GOAL_MAX_LEN and never the task half", async () => {
    // The cap is real — `validateWorkerGoal` refuses longer prose as a status update — so a template
    // that ignored it would mint goals the gate itself would reject. Which half gives is the part
    // that matters: losing the tail of an objective costs a reader context, losing the bead id costs
    // them the ability to tell which task the criterion is about.
    const long = "x".repeat(GOAL_MAX_LEN - 4) + " END";
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    useBeadsStore.setState({
      byProject: { [projectId]: { beads: BEADS as never, board: null as never, loadedAt: 1 } },
    });
    useProjectStore.getState().setEpicGoal(projectId, "epic-1", long, "human");
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "create_worker_worktree"
        ? Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" })
        : Promise.resolve(undefined),
    );

    const { workerId } = await spawnWorker({
      projectId,
      parentAgentId: buildId,
      task: "wire the dispatch path",
      beadId: "task-1",
    });

    const text = goalOf(projectId, workerId)!.text;
    expect(text.length).toBeLessThanOrEqual(GOAL_MAX_LEN);
    expect(text.startsWith("task-1")).toBe(true); // the task half survives WHOLE
    expect(text.endsWith("…")).toBe(true); // …and the epic half is what gave
    expect(text).not.toContain("END"); // the tail that was dropped
  });

  it("ladderGoalFor answers null for a worker with no bead at all", () => {
    // The `goalOverride` path outside an epic — the population this must NOT touch, since a
    // placeholder there would make an unverifiable worker look verifiable.
    const { projectId } = ladderSetup(true);
    expect(ladderGoalFor(projectId, undefined)).toBeNull();
    expect(ladderGoalFor(projectId, "task-1")).not.toBeNull();
  });
});
