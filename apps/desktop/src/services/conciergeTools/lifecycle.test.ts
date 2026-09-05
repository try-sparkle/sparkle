// The concierge's AGENT LIFECYCLE domain. These tests are the safety contract: the destructive
// operation (discard) must be unreachable without an explicit intent, every operation must be
// classified, and a spawn must refuse rather than overrun the machine's RAM budget or quietly bill
// the user for a cloud sandbox.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// The PTY kill is the stop primitive; mocked so a stop asserts what the domain ASKS for without
// touching a real terminal. `paneControl` and the pass latch are used REAL — the pane registry is an
// in-memory map and `improvementPassLatch` exports claim/release, so mocking either would mean
// testing a stand-in for the rule under test.
vi.mock("../../pty", () => ({ killPty: vi.fn(async () => {}) }));

// bd is not available in a unit test; the spawn path fires a best-effort `bd create`.
vi.mock("../tasks", () => ({ createBeadFull: vi.fn(async () => "bd-new") }));

// The git/bead side-effects of ship / save / discard / spin-down. Mocked so the tests assert WHAT
// the domain asks for (and, for discard, that it is never asked for by accident) without touching
// a repo.
const PR_OPENED: ShipOutcome = {
  kind: "pr-opened",
  pushed: true,
  prOpened: true,
  landed: false,
  prUrl: "https://pr/1",
};
const shipWorkMock = vi.fn(async (): Promise<ShipOutcome> => PR_OPENED);
const SAVE_PUSHED: SaveOutcome = { kind: "pushed", pushed: true };
const saveWorkMock = vi.fn(async (): Promise<SaveOutcome> => SAVE_PUSHED);
const discardGitMock = vi.fn(async () => {});
const spinDownGitMock = vi.fn(async () => {});
vi.mock("../closeAgentActions", () => ({
  shipAgent: (...a: unknown[]) => shipWorkMock(...(a as [])),
  saveAgent: (...a: unknown[]) => saveWorkMock(...(a as [])),
  discardAgentGit: (...a: unknown[]) => discardGitMock(...(a as [])),
  spinDownAgentGit: (...a: unknown[]) => spinDownGitMock(...(a as [])),
}));
const terminateIfCloudMock = vi.fn(async () => {});
vi.mock("../cloudAgents/terminate", () => ({
  terminateIfCloud: (...a: unknown[]) => terminateIfCloudMock(...(a as [])),
}));
// A cloud SPAWN is a real, billing start now (see lifecycle.cloudSpawn.test.ts, which owns that
// path end to end). Here it is only ever exercised in its REFUSED form, so the API is stubbed to
// fail loudly: if a change ever let one of these tests reach the network, the stub says so rather
// than the suite quietly opening a sandbox.
const startSessionMock = vi.fn(async () => {
  throw new Error("no cloud session may be started from this suite");
});
vi.mock("../cloudAgents/api", () => ({
  cloudApi: {
    startSession: () => startSessionMock(),
    listProjects: async () => [],
    createProject: async (name: string) => ({ id: "cloud-p", name }),
    getClaudeAuth: async () => null,
  },
}));
const spinDownWorkerMock = vi.fn(async () => {});
vi.mock("../workerSpawn", async (orig) => ({
  ...(await orig<typeof import("../workerSpawn")>()),
  spinDownWorker: (...a: unknown[]) => spinDownWorkerMock(...(a as [])),
}));
// THE LIVE GIT READ the spin-down guard now takes at the moment of the decision (bead
// sparkle-plxhx). Mocked at the Tauri boundary rather than stubbing the guard itself, so these
// tests drive the real `readRetirementFacts` — including its gone-worktree and cache-fallback
// arms. `undefined` (the default) means "no live read was configured": the mock rejects, which is
// the shape a git failure takes, so a test that forgets to set it lands on the honest unknown path
// instead of silently getting a clean reading.
let liveBranchStatus: (() => Promise<BranchStatus>) | null = null;
const agentBranchStatusMock = vi.fn(async () => {
  if (!liveBranchStatus) throw new Error("no live reading configured for this test");
  return liveBranchStatus();
});
// THE SECOND LIVE READ — the branch rung the spin-down guard grew for bead sparkle-3duunc. Mocked
// at the same Tauri boundary and for the same reason: these tests drive the real
// `readRetirementFacts` and the real `commitsHeldElsewhere`, not a stand-in for them. `null` means
// "no reading configured", and the mock then REJECTS — the shape a git failure takes — so a test
// that forgets to set one lands on the honest unknown path.
let liveWorkflowState: (() => Promise<WorkflowState>) | null = null;
const agentWorkflowStateMock = vi.fn(async () => {
  if (!liveWorkflowState) throw new Error("no live workflow state configured for this test");
  return liveWorkflowState();
});
/** Every `parentBranch` the spin-down path actually handed the workflow read. It is what makes
 *  `inParent` answerable at all, so a call site that dropped it would leave that whole clearance
 *  dead while every test here stayed green. */
const workflowStateParentBranches: unknown[] = [];
vi.mock("../branchStatus", async (orig) => ({
  ...(await orig<typeof import("../branchStatus")>()),
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  agentBranchStatus: (...a: unknown[]) => agentBranchStatusMock(...(a as [])),
  agentWorkflowState: (...a: unknown[]) => {
    workflowStateParentBranches.push(a[2]);
    return agentWorkflowStateMock(...(a as []));
  },
}));
// The real spawn body runs by default (these tests assert the human path's exact sequence); a test
// that needs the "project vanished mid-spawn" branch sets `spawnOverride`.
let spawnOverride: (() => string | null) | null = null;
/** Every `opts` this tool actually handed the spawn. The wrapper USED TO DROP THE SECOND ARGUMENT
 *  entirely, which made the tool's whole opts payload — the brief, the name, the model, the mode,
 *  and now `attention` — untestable BY CONSTRUCTION: any of them could be deleted from the call
 *  site and every test here would stay green while the feature went dead in the app. */
const spawnOpts: Array<Record<string, unknown> | undefined> = [];
vi.mock("../buildAgentSpawn", async (orig) => {
  const real = await orig<typeof import("../buildAgentSpawn")>();
  return {
    ...real,
    spawnBuildAgentInProject: (
      project: Parameters<typeof real.spawnBuildAgentInProject>[0],
      opts?: Parameters<typeof real.spawnBuildAgentInProject>[1],
    ) => {
      spawnOpts.push(opts as Record<string, unknown> | undefined);
      return spawnOverride ? spawnOverride() : real.spawnBuildAgentInProject(project, opts);
    },
  };
});

import { useAuthStore } from "../../stores/authStore";
import { useCloudAuthStore } from "../../stores/cloudAuthStore";
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { shouldPromptOnClose } from "../../engine/closeAgent";
import type { BranchStatus, WorkflowState } from "../branchStatus";
import type { SaveOutcome, ShipOutcome } from "../closeAgentActions";
import { markProjectVisited, resetVisitedProjects } from "../sessionProjects";
import type { WorkflowStageId } from "../../engine/workflowStage";
import {
  LIFECYCLE_OPS,
  LIFECYCLE_RISK,
  LIFECYCLE_RISK_NOTE,
  DISCARD_CONFIRM_TOKEN,
  isDiscardIntent,
  localAgentCapacity,
  spawnBuildAgent,
  previewClose,
  previewDiscard,
  closeAgent,
  shipAgent,
  saveAgent,
  discardAgent,
  spinDownWorkerAgent,
  restartAgent,
  resumeWorker,
  stopAgent,
  type LifecycleOp,
  type LifecycleRisk,
} from "./lifecycle";
import { registerPaneRestart, clearPaneRestarts } from "../paneControl";
import {
  setPaneReady,
  setPaneFailed,
  resetPaneReadiness,
  notePaneRelaunch,
} from "../paneReadiness";
// THE REAL LATCH, not a mock of it: `improvementPassLatch` is a leaf with `claimPass`/`releasePass`,
// so the restart/stop guard is driven through services/sparkleBusy end to end.
import { claimPass, releasePass } from "../improvementPassLatch";
import { SPARKLE_AGENT_ID } from "../sparkleAgent";
import { killPty } from "../../pty";
import { openTraceKinds } from "../../perfTrace";

const CLEAN: BranchStatus = {
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  worktreeOnBranch: true,
  // `branch` IS LOAD-BEARING, not decoration (bead `sparkle-cn9z9l`). closeDecision's silent arm
  // rests on a CONFIDENT ZERO: `ahead: 0` means nothing until the reading says WHICH branch it
  // counted against, so an unbranched BranchStatus is refused and the close prompts instead.
  branch: "sparkle/agent-a1",
};
const AHEAD: BranchStatus = { ...CLEAN, ahead: 3 };
const DIRTY: BranchStatus = { ...CLEAN, dirty: true, filesChanged: 2 };

/** The base workflow reading: nothing committed, nothing anywhere. Every case below names the ONE
 *  field it is about, so a clearance can never be bought by a field the test never mentioned. */
const WS_NOTHING: WorkflowState = {
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 0,
  landed: false,
  landedOnOrigin: false,
  pushed: false,
  shipped: false,
  hasRemote: true,
  prState: null,
  prNumber: null,
  prUrl: null,
};
/** THE DEFAULT for every pre-existing test in this file: a worker whose work is already on origin
 *  main and on a remote ref. Those tests are about the TREE, and this keeps the branch rung silent
 *  for them — the branch cases below each configure their own reading. */
const WS_LANDED: WorkflowState = {
  ...WS_NOTHING,
  inLocalMain: true,
  inOriginMain: true,
  landed: true,
  landedOnOrigin: true,
  pushed: true,
};
/** THE BEAD (sparkle-3duunc): commits on neither origin/main nor any remote ref, no PR, and not
 *  merged into the orchestrator either — held by this worker's own branch and nothing else. */
const WS_STRANDED: WorkflowState = { ...WS_NOTHING, aheadOfBase: 8 };

function seedProject(): string {
  return useProjectStore.getState().addProject("Demo", "/tmp/demo");
}

/** A build agent with a worktree + branch, plus its live git reading and stage. */
function seedBuild(
  projectId: string,
  opts: { bs?: BranchStatus; stage?: WorkflowStageId; beadId?: string } = {},
): string {
  const store = useProjectStore.getState();
  const id = store.addAgent(projectId, { kind: "build" })!;
  store.setAgentWorktree(projectId, id, `/wt/${id}`, `sparkle/agent-${id}`);
  if (opts.beadId) store.setAgentBeadId(projectId, id, opts.beadId);
  useRuntimeStore.setState((s) => ({
    branchStatus: opts.bs ? { ...s.branchStatus, [id]: opts.bs } : s.branchStatus,
    workflowStage: opts.stage ? { ...s.workflowStage, [id]: opts.stage } : s.workflowStage,
  }));
  return id;
}

function seedWorker(
  projectId: string,
  parentId: string,
  beadId?: string,
  bs?: BranchStatus,
): string {
  const store = useProjectStore.getState();
  const id = store.addAgent(projectId, {
    kind: "worker",
    parentId,
    task: "do a thing",
    parentBranch: `sparkle/agent-${parentId}`,
    beadId,
    select: false,
  })!;
  store.setAgentWorktree(projectId, id, `/wt/${id}`, `sparkle/agent-${id}`);
  if (bs) useRuntimeStore.setState((s) => ({ branchStatus: { ...s.branchStatus, [id]: bs } }));
  return id;
}

function seedShell(projectId: string): string {
  return useProjectStore.getState().addAgent(projectId, { kind: "shell" })!;
}

beforeEach(() => {
  liveBranchStatus = null;
  liveWorkflowState = () => Promise.resolve(WS_LANDED);
  workflowStateParentBranches.length = 0;
  agentBranchStatusMock.mockClear();
  agentWorkflowStateMock.mockClear();
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
  useSettingsStore.setState({
    maxConcurrentWorkers: 8,
    effectiveMaxConcurrentWorkers: 8,
    // The ceiling's provenance is store state and outlives a test; a leaked basis string would let
    // one test's copy assertion pass on another test's setup.
    concurrencyBound: "unknown",
    concurrencyBasis: "",
    deleteMergedBranch: false,
  });
  // The visited set is MODULE state (services/sessionProjects) and outlives a test, so `live` would
  // otherwise inherit whatever a previous test marked.
  resetVisitedProjects();
  spawnOverride = null;
  spawnOpts.length = 0;
  shipWorkMock.mockReset();
  shipWorkMock.mockResolvedValue(PR_OPENED);
  saveWorkMock.mockReset();
  saveWorkMock.mockResolvedValue(SAVE_PUSHED);
  discardGitMock.mockClear();
  spinDownGitMock.mockClear();
  terminateIfCloudMock.mockClear();
  spinDownWorkerMock.mockClear();
});

// ── The risk map ────────────────────────────────────────────────────────────────────────────────
describe("LIFECYCLE_RISK", () => {
  it("classifies EVERY operation (an unclassified op is a typecheck failure, and this pins it at runtime)", () => {
    expect(Object.keys(LIFECYCLE_RISK).sort()).toEqual([...LIFECYCLE_OPS].sort());
    const classes: LifecycleRisk[] = ["irreversible", "outward-facing", "costs-money", "routine"];
    for (const op of LIFECYCLE_OPS) expect(classes).toContain(LIFECYCLE_RISK[op]);
  });

  it("classes discard as IRREVERSIBLE and a cloud spawn as COSTS-MONEY", () => {
    expect(LIFECYCLE_RISK.discard_agent).toBe("irreversible");
    expect(LIFECYCLE_RISK.spawn_cloud_build_agent).toBe("costs-money");
  });

  it("classes the two operations that reach the network/remote as outward-facing", () => {
    expect(LIFECYCLE_RISK.ship_agent).toBe("outward-facing");
    expect(LIFECYCLE_RISK.save_agent).toBe("outward-facing");
  });

  it("marks every read-only preview routine", () => {
    expect(LIFECYCLE_RISK.preview_close).toBe("routine");
    expect(LIFECYCLE_RISK.preview_discard).toBe("routine");
  });

  // The notes are what the concierge SAYS about a risk class, so an op whose class has no sentence
  // would be explained with `undefined`.
  it("gives every risk class a sentence, and every op therefore a note it can say", () => {
    for (const op of LIFECYCLE_OPS) {
      const note = LIFECYCLE_RISK_NOTE[LIFECYCLE_RISK[op]];
      expect(typeof note).toBe("string");
      expect(note.length).toBeGreaterThan(0);
    }
    expect(LIFECYCLE_RISK_NOTE.irreversible).toMatch(/cannot be recovered/i);
    expect(LIFECYCLE_RISK_NOTE["outward-facing"]).toMatch(/outside world/i);
    expect(LIFECYCLE_RISK_NOTE["costs-money"]).toMatch(/bills/i);
    expect(LIFECYCLE_RISK_NOTE.routine).toMatch(/reversible/i);
  });
});

// ── Spawn ───────────────────────────────────────────────────────────────────────────────────────
describe("spawnBuildAgent", () => {
  // ══ THE TOOL OPTS INTO BEING DECLINED ═════════════════════════════════════════════════════════
  // This is the ONE spawn call site that may be refused the view, and asserting it HERE is the
  // point: `SpawnBuildAgentOpts.attention` defaults to `"user"`, so dropping this one word from the
  // call site turns the whole focus guard off for the only path that can trigger it — silently, with
  // the guard's own unit tests still green, because they pass the flag themselves.
  it('passes attention: "auto" — a concierge spawn must not take a terminal the founder is typing in', async () => {
    // NO `prompt`: a briefed spawn makes this tool await brief delivery, which is a 45s wait with no
    // pane mounted to confirm it. `name` rides the same opts argument and proves the forwarding just
    // as well.
    const pid = seedProject();
    await spawnBuildAgent({ projectId: pid, name: "Fixer" });

    expect(spawnOpts).toHaveLength(1);
    expect(spawnOpts[0]).toMatchObject({ attention: "auto" });
    // The rest of the payload rides the same argument, and it was invisible to this suite until the
    // wrapper started forwarding it. Pinned together so the forwarding cannot quietly regress.
    expect(spawnOpts[0]).toMatchObject({ name: "Fixer" });
  });

  it("creates the agent and returns its id", async () => {
    const pid = seedProject();
    const r = await spawnBuildAgent({ projectId: pid });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.op).toBe("spawn_build_agent");
    const project = useProjectStore.getState().projects.find((p) => p.id === pid)!;
    expect(project.agents.map((a) => a.id)).toContain(r.data.agentId);
    expect(project.agents.find((a) => a.id === r.data.agentId)!.kind).toBe("build");
    // …and it is OPEN, i.e. its pane will mount and launch the PTY — the human path's behavior.
    expect(useRuntimeStore.getState().openAgentIds).toContain(r.data.agentId);
  });

  // ══ A PRESENT-BUT-BLANK BRIEF IS REFUSED, NOTHING IS CREATED (sparkle-esrsnv) ══════════════════
  // The incident: an agent spawned "with a brief" that arrived empty and answered the nudge ladder
  // `no-task-assigned`, so a human had to paste the brief in by hand. A whitespace-only `prompt`
  // clears the route schema's `.min(1)` (whitespace counts toward length) and would be delivered
  // verbatim as the agent's opening message. This asserts the SIDE EFFECT, not the input: the spawn
  // primitive is never reached, so no agent, no slot, no taskless row.
  it("refuses a present-but-blank brief and creates NOTHING", async () => {
    const pid = seedProject();
    const r = await spawnBuildAgent({ projectId: pid, prompt: "   \n\t  " });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("empty-brief");
    // THE SIDE EFFECT. `spawnBuildAgentInProject` is the only thing that mints an agent + slot, and
    // it was never called — so the blank brief cost the store nothing. Asserting the refusal reason
    // alone would pass even if a taskless agent had been created and then the reply relabelled.
    expect(spawnOpts).toHaveLength(0);
    expect(useProjectStore.getState().projects.find((p) => p.id === pid)!.agents).toHaveLength(0);
  });

  // THE PAIRED CASE: the same setup DOES reach the spawn when the brief is real, so the guard is
  // keyed on blankness and not on merely having a `prompt`. `spawnOverride` returns null to stop the
  // path before its ~45s brief-delivery await — we only need to see the brief forwarded, verbatim,
  // into the spawn primitive (which the empty-brief guard would have prevented for a blank one).
  it("forwards a real brief into the spawn — the empty-brief guard fires only on a blank one", async () => {
    const pid = seedProject();
    spawnOverride = () => null;
    const r = await spawnBuildAgent({ projectId: pid, prompt: "Fix the login redirect loop" });
    expect(spawnOpts).toHaveLength(1);
    expect(spawnOpts[0]).toMatchObject({ prompt: "Fix the login redirect loop" });
    // Whatever this spawn's outcome is, it is NOT the blank-brief refusal — the guard let it through.
    expect(r.ok).toBe(false); // spawnOverride returned null → action-failed, not empty-brief
    if (r.ok) return;
    expect(r.reason).not.toBe("empty-brief");
  });

  // ══ THE NAME IS PROVISIONAL, AND THE PAYLOAD SAYS SO ══════════════════════════════════════════
  // This reply used to carry a plain `name`, and that one word produced a real failure: the
  // concierge read it and told the founder "Build 17" — a spawn-time placeholder the agent had
  // already replaced by the time they read it, so the name pointed at nothing on their screen.
  // *"Build 17 is not the name of the agent right now … that doesn't mean anything to me because I
  // can't see it."* The value is still useful to the model; what changed is that nothing downstream
  // can now mistake it for identity.
  it("returns the placeholder name as PROVISIONAL, never as the agent's identity", async () => {
    const pid = seedProject();
    const r = await spawnBuildAgent({ projectId: pid });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const live = useProjectStore
      .getState()
      .projects.find((p) => p.id === pid)!
      .agents.find((a) => a.id === r.data.agentId)!;
    expect(r.data.provisionalName).toBe(live.name);
    // Spelled out in the payload, not merely implied by the field name: the reply is read by a
    // language model, and a flag it can see beats a convention it has to infer.
    expect(r.data.nameIsProvisional).toBe(true);
    // The field a caller would quote as identity is GONE, which is the half that actually prevents
    // the failure — a rename that left `name` in place would have changed nothing.
    expect("name" in r.data).toBe(false);
    // The durable handle is still there, and it is what a reference must be built from.
    expect(typeof r.data.agentId).toBe("string");
  });

  it("refuses (typed) with no project open — nothing is created", async () => {
    const r = await spawnBuildAgent();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-project");
    expect(useProjectStore.getState().projects).toHaveLength(0);
  });

  it("refuses a spawn past the machine's worker-capacity cap instead of queueing or crashing", async () => {
    const pid = seedProject();
    useSettingsStore.setState({ maxConcurrentWorkers: 1, effectiveMaxConcurrentWorkers: 1 });
    const first = await spawnBuildAgent({ projectId: pid });
    expect(first.ok).toBe(true);
    const before = useProjectStore.getState().projects[0]!.agents.length;
    const second = await spawnBuildAgent({ projectId: pid });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("at-capacity");
    expect(second.message).toMatch(/1/); // reports the limit it hit
    // NOT queued, NOT created.
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(before);
  });

  it("counts workers under other build agents toward the machine-wide cap", async () => {
    const pid = seedProject();
    const build = seedBuild(pid);
    seedWorker(pid, build);
    useSettingsStore.setState({ maxConcurrentWorkers: 2, effectiveMaxConcurrentWorkers: 2 });
    expect(localAgentCapacity()).toMatchObject({ used: 2, limit: 2, atCapacity: true });
    const r = await spawnBuildAgent({ projectId: pid });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("at-capacity");
  });

  // roborev 54175-3: the budget counts ROWS (a dormant row starts a process the moment its project
  // tab is opened, which is why it is counted), but only rows in `openAgentIds` have a process NOW.
  // The reading reports both, and the refusal must not claim the dormant ones are running.
  it("separates rows-that-count (used) from rows-with-a-live-process (live)", async () => {
    const pid = seedProject();
    const a = seedBuild(pid);
    seedBuild(pid);
    useRuntimeStore.setState({ openAgentIds: [a] });
    expect(localAgentCapacity()).toMatchObject({ used: 2, live: 1 });
  });

  // roborev 54225-3. `live` claims "has a mounted pane right now", and Workspace mounts a pane for
  // an agent in `openAgentIds` AND in a project whose tab has been VISITED (or is the current one).
  // openAgentIds is PERSISTED, so on the first render after a restart every previously-open row is
  // in it while no pane exists — the half of the condition the old test never exercised, which is
  // exactly how `live === used` could assert N running processes that weren't there.
  it("does not count an open row in a project tab the user has never visited as live", async () => {
    const dormantPid = seedProject();
    const dormant = seedBuild(dormantPid);
    const currentPid = useProjectStore.getState().addProject("Current", "/tmp/current");
    const here = seedBuild(currentPid); // addProject SELECTS it → Workspace mounts its panes
    // Exactly the post-restart state: both rows restored into openAgentIds, neither tab opened yet.
    useRuntimeStore.setState({ openAgentIds: [dormant, here] });
    expect(localAgentCapacity()).toMatchObject({ used: 2, live: 1 });
    // …and the moment that tab IS opened, its row starts and counts as live.
    markProjectVisited(dormantPid);
    expect(localAgentCapacity()).toMatchObject({ used: 2, live: 2 });
  });

  it("still says WHY the dormant rows count when they are open-but-unvisited, not merely unopened", async () => {
    const dormantPid = seedProject();
    const dormant = seedBuild(dormantPid);
    const currentPid = useProjectStore.getState().addProject("Current", "/tmp/current");
    const here = seedBuild(currentPid);
    useRuntimeStore.setState({ openAgentIds: [dormant, here] });
    useSettingsStore.setState({ maxConcurrentWorkers: 2, effectiveMaxConcurrentWorkers: 2 });
    const r = await spawnBuildAgent({ projectId: currentPid });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("at-capacity");
    // The dormant clause must survive a persisted openAgentIds — it is the honest half. It reports
    // what `live` MEASURES (rows showing in this window), which is not the same claim as "running".
    expect(r.message).toMatch(/1 of them showing in this window/i);
    expect(r.message).toMatch(/aren't open here/i);
  });

  // BUG 1 of the ceiling audit. The old clause told the human the over-cap agents were ones "you
  // haven't opened yet, and each one starts as soon as you do". Closed-tab projects were observed
  // with a running-agent count equal to their full roster, so the sentence sent a human hunting for
  // processes that were already up. `live` measures "has a mounted pane in THIS window", and the
  // copy may not claim more.
  //
  // ── AND THE CORRECTION OVERSHOT, so this test now pins BOTH directions (bead `sparkle-ftapmp`) ──
  // The fix for BUG 1 became "most are already running, they're just not on screen", and that was
  // measured FALSE on 2026-09-04: 60 rows on this machine against TWENTY real `claude` processes.
  // Both claims are true of different rows and `live` can separate neither, so the copy must assert
  // NOTHING about process state in either direction — which is what these assertions now say. A test
  // that demanded one of the two claims is a test that pins whichever mistake was made last.
  it("does not tell the human that off-screen agents have not started yet", async () => {
    const pid = seedProject();
    seedBuild(pid);
    seedBuild(pid); // neither has a mounted pane in this window
    useSettingsStore.setState({ maxConcurrentWorkers: 2, effectiveMaxConcurrentWorkers: 2 });
    const r = await spawnBuildAgent({ projectId: pid });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("at-capacity");
    expect(r.message).not.toMatch(/already running 2/i);
    expect(r.message).toMatch(/2 of its 2/); // the numbers it actually hit
    // THE RETRACTED CLAIMS, ALL THREE. Neither "they have not started" (BUG 1) nor "they are
    // already running" (`sparkle-ftapmp`) is something this window can know, and opening a tab is
    // not what starts them.
    expect(r.message).not.toMatch(/haven't opened yet/i);
    expect(r.message).not.toMatch(/starts as soon as you do/i);
    expect(r.message).not.toMatch(/already running/i);
    // THE POSITIVE, so the pair above cannot be satisfied by copy that simply says nothing —
    // deleting a claim is not the same fact as stating what IS known. It reports what `live`
    // measures and says the count is of slots.
    expect(r.message).toMatch(/showing in this window/i);
    expect(r.message).toMatch(/slots, not of processes/i);
  });

  // BUG 2. Rust's `Bound` exists precisely to stop the app mis-attributing the ceiling — its own
  // comment says routing a tie to the RAM branch gives "advice that cannot work". That attribution
  // never reached the human: the refusal asserted "derived from installed RAM" unconditionally.
  it("names the CPU bound rather than blaming RAM on a core-bound machine", async () => {
    const pid = seedProject();
    seedBuild(pid);
    // An 18-core / 128 GiB machine: RAM holds 81, cores drive 36. CPU binds — see config.rs
    // `the_basis_sentence_names_the_cpu_bound_on_a_core_bound_machine`, which produces this string.
    useSettingsStore.setState({
      maxConcurrentWorkers: 1,
      effectiveMaxConcurrentWorkers: 1,
      concurrencyBound: "cpu",
      concurrencyBasis: "CPU-bound: 18 cores × 2 agents per core",
    });
    const r = await spawnBuildAgent({ projectId: pid });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("at-capacity");
    expect(r.message).toMatch(/CPU-bound: 18 cores × 2 agents per core/);
    expect(r.message).not.toMatch(/derived from installed RAM/i);
  });

  it("names the pin, not the hardware, when a config.toml ceiling is what binds", async () => {
    const pid = seedProject();
    seedBuild(pid);
    useSettingsStore.setState({
      maxConcurrentWorkers: 1,
      effectiveMaxConcurrentWorkers: 1,
      concurrencyBound: "pinned",
      concurrencyBasis: "pinned to 32 in config.toml ([workers].max_concurrent)",
    });
    const r = await spawnBuildAgent({ projectId: pid });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/pinned to 32 in config\.toml/);
    expect(r.message).not.toMatch(/installed RAM/i);
  });

  // BUG 3: "at-capacity: 46 of 32 slots" while the derivation said 36. A cap that lies about itself
  // is worse than a wrong cap — the number in the message must BE the number the gate compared
  // against, for every combination of the two store fields.
  it("reports exactly the cap it enforces", async () => {
    const pid = seedProject();
    for (const [request, machine] of [
      [32, 36], // a pin below what the machine derives — the reported situation
      [36, 32], // the inverse: the machine is the tighter of the two
      [8, 8],
    ] as const) {
      useProjectStore.setState({ projects: [], selectedProjectId: null });
      const p = useProjectStore.getState().addProject("Demo", `/tmp/demo-${request}-${machine}`);
      useSettingsStore.setState({
        maxConcurrentWorkers: request,
        effectiveMaxConcurrentWorkers: machine,
        concurrencyBasis: "",
      });
      // min(pin, machine) — the number the gate actually enforces.
      //
      // Note the `[32, 36]` row is a MID-DRAG TRANSIENT, not a steady state (roborev 55068): it
      // violates `effective <= maxConcurrentWorkers`, which `hydrateFromConfig` enforces, and is
      // reachable only between `setMaxConcurrentWorkers` (which writes `maxConcurrentWorkers`
      // alone) and the `config-changed` re-hydrate. It is kept because it is the only row where
      // `enforcedWorkerCap` and `effectiveMaxConcurrentWorkers` differ, so it is the only row with
      // mutation sensitivity — but it must not be read as "the reported situation", where a
      // hydrated store holds `{32, 32}`. Whether a pin SHOULD throttle the whole machine is an open
      // semantic question tracked as a bead; this asserts the behaviour the code has today.
      const enforced = Math.min(request, machine);
      // Fill to exactly the enforced cap through the SHARED path, then confirm one more is refused —
      // i.e. the gate really binds at the number it prints, not one either side of it.
      for (let i = 0; i < enforced; i++) expect((await spawnBuildAgent({ projectId: p })).ok).toBe(true);
      const r = await spawnBuildAgent({ projectId: p });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(localAgentCapacity().limit).toBe(enforced);
      expect(r.message).toContain(`${enforced} of its ${enforced} agent slots`);
      // …and never the OTHER of the two numbers. Skipped when they agree: there is no wrong number
      // to report, and asserting its absence would contradict the line above.
      const looser = Math.max(request, machine);
      if (looser !== enforced) {
        expect(r.message).not.toContain(`of its ${looser} agent slots`);
      }
    }
    expect(pid).toBeTruthy();
  });

  it("refuses (typed) when the project vanishes mid-spawn — and SAYS the project closed", async () => {
    const pid = seedProject();
    // The actual race: the lookup above succeeds, and the project is removed by another window
    // WHILE the spawn runs — so it has to vanish inside the override, not before the call.
    spawnOverride = () => {
      useProjectStore.setState({ projects: [] });
      return null;
    };
    const r = await spawnBuildAgent({ projectId: pid });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.op).toBe("spawn_build_agent");
    expect(r.reason).toBe("action-failed");
    expect(r.message).toMatch(/project closed/i);
  });

  it("a null from an INTERNAL failure does not blame the project for closing", async () => {
    // `spawnBuildAgentInProject` returns null for two different reasons now: the project-removal race
    // above, and a step between `addAgent` and the brief throwing, after which it tears the row back
    // down. Both guarantee "nothing was created", but only one is a closed project — and telling a
    // human their project closed sends them looking for a tab nobody closed.
    const pid = seedProject();
    spawnOverride = () => null; // project deliberately left OPEN
    const r = await spawnBuildAgent({ projectId: pid });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("action-failed");
    expect(r.message).not.toMatch(/project closed/i);
    expect(r.message).toMatch(/went wrong/i);
    // The guarantee both causes share still holds.
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
  });

  // The blanket "cloud-spawn-unsupported" refusal is gone — a cloud spawn now runs the dialog's own
  // sequence (design 2026-08-01 §Decision 7). What survives from that test is the property it was
  // really protecting: this op must never spend the user's money by accident. With no `prompt` there
  // is no goal, and a cloud agent's goal cannot be sent after the start, so it refuses — and, more
  // to the point, starts nothing. The full matrix lives in lifecycle.cloudSpawn.test.ts.
  it("refuses a CLOUD spawn with no goal rather than spending the user's money", async () => {
    const pid = seedProject();
    // Let the gate through, so the refusal under test is the GOAL one and not the account one —
    // the gate runs first by design (its refusal is the one with a self-serve fix attached).
    useAuthStore.setState({
      tokenPresent: true,
      me: { cloudAgentsEnabled: true, entitled: true, balanceCents: 5_000 },
      // The gate re-reads /me before deciding. The REAL `refresh` reaches the keychain through
      // `hasToken()`, which outside a Tauri webview finds no token and clears BOTH `me` and
      // `tokenPresent` — so the seeded account above would evaporate and the gate would answer
      // `signed_out`, masking the goal refusal this test is about. Same stub shape as the four
      // suites that assert the gate itself.
      refresh: vi.fn(async () => {}),
    } as never);
    useCloudAuthStore.setState({ method: "byok", loaded: true } as never);
    const r = await spawnBuildAgent({ projectId: pid, runtime: "cloud" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.op).toBe("spawn_cloud_build_agent");
    expect(r.reason).toBe("cloud-goal-required");
    expect(r.risk).toBe("costs-money");
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
  });
});

// ── previewClose ────────────────────────────────────────────────────────────────────────────────
describe("previewClose", () => {
  it("reports a RETIREMENT CONFIRM — not a silent close — for a build agent whose work is merged", () => {
    // This test asserted `silentClose: true` and that assertion became the defect (roborev 59153).
    // `wouldPrompt` answers the work-at-risk question ALONE, which is `false` for a landed agent —
    // so the preview announced "safe and silent" for exactly the population `closeAgent` refuses
    // with `needs-human-confirm`. The preview must describe the close that will actually happen.
    const pid = seedProject();
    const id = seedBuild(pid, { bs: CLEAN, stage: "merged" });
    const r = previewClose(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A THIRD state, not a flavour of wouldPrompt: nothing is at risk and there is no
    // ship/save/discard choice — what is owed is the founder's confirm.
    expect(r.data.wouldPrompt).toBe(false);
    expect(r.data.retirementConfirm).toBe(true);
    expect(r.data.silentClose).toBe(false);
    expect(r.data.recommended).toBe("keep-open");
    // The sentence matters as much as the flag: it is what the concierge says out loud, and the old
    // one told the founder the row was free to remove.
    expect(r.data.reason).not.toMatch(/safe and silent/);
    expect(r.data.reason).toMatch(/yours to confirm/);
  });

  it("still reports a genuinely SILENT close for a build agent that made no work at all", () => {
    // The other side of the same branch — this must not have been swept up by the change above, or
    // every ordinary teardown in the app now tells the founder to go and confirm something.
    const pid = seedProject();
    const id = seedBuild(pid, { bs: CLEAN, stage: "building_unsaved" });
    const r = previewClose(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.retirementConfirm).toBe(false);
    expect(r.data.silentClose).toBe(true);
    expect(r.data.recommended).toBe("close");
  });

  it("reports a PROMPT (→ ship) for a build agent with unmerged commits", () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD, stage: "building_saved" });
    const r = previewClose(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.wouldPrompt).toBe(true);
    expect(r.data.commitsAhead).toBe(3);
    expect(r.data.unmergedCommittedWork).toBe(true);
    expect(r.data.recommended).toBe("ship");
  });

  // roborev 54175-4: "save" used to be an advertised recommendation the ladder could never produce.
  // A branch that ALREADY has a PR open is exactly the case it fits: shipping again would ask `gh`
  // for a second PR on the same branch (which errors), so the honest move is to back it up and keep it.
  it("recommends SAVE when a pull request is already open for the branch", () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD, stage: "pull_request" });
    const r = previewClose(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.wouldPrompt).toBe(true);
    expect(r.data.recommended).toBe("save");
    expect(r.data.reason).toMatch(/pull request/i);
    // roborev 54225-2: the reason used to assert "there's nothing left to ship" — untrue whenever
    // `commitsAhead` includes commits that were never pushed to the open PR, which is precisely the
    // state a save is being recommended for.
    expect(r.data.reason).not.toMatch(/nothing left to ship/i);
    expect(r.data.reason).toMatch(/3 commits/); // AHEAD.ahead — named, not waved away
  });

  it("still recommends SHIP for committed work with no pull request yet", () => {
    const pid = seedProject();
    for (const stage of ["building_saved", "pushed", "merged_local"] as const) {
      const id = seedBuild(pid, { bs: AHEAD, stage });
      const r = previewClose(id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect({ stage, rec: r.data.recommended }).toEqual({ stage, rec: "ship" });
    }
  });

  it("flags a LOCALLY-LANDED row as needing the confirm, while still recommending the push", () => {
    // knightwatch 5204094441#3. `merged_local` is a no-remote "Ship it": the branch is merged into
    // LOCAL main and stops there. It used to sit BELOW the retirement boundary, so a close resolved
    // to `silent` (clean tree) or Ship/Save (commits ahead) and the row could be removed with no
    // confirm at all — the hole the gate exists to close, reached through the gate rather than
    // around it. Both halves are asserted because widening the boundary must not cost the
    // recommendation: the row has landed AND still has somewhere to go.
    const pid = seedProject();
    const landed = previewClose(seedBuild(pid, { bs: AHEAD, stage: "merged_local" }));
    expect(landed.ok).toBe(true);
    if (!landed.ok) return;
    expect(landed.data.retirementConfirm).toBe(true);
    expect(landed.data.silentClose).toBe(false);
    expect(landed.data.recommended).toBe("ship");
    // The reason says BOTH facts — it is the only place the concierge learns why closing is gated.
    expect(landed.data.reason).toMatch(/landed locally/i);
    expect(landed.data.reason).toMatch(/yours to confirm/i);
    // A ROW ON ORIGIN IS NOT "LANDED LOCALLY", however many commits it is ahead (roborev 59899).
    // `ahead` is `rev-list --left-right --count`, so it only reaches 0 once the branch TIP is an
    // ancestor of the base — a squash or rebase merge defeats that permanently and it stays N
    // forever. Gating the split on the count alone therefore caught `merged` and `shipped` too, and
    // told the founder their landed work "has not reached the remote yet" while recommending a
    // `ship` that would ask `gh` for a second PR on an already-merged branch. FAILS against the
    // count-only gate.
    for (const stage of ["merged", "shipped"] as const) {
      const r = previewClose(seedBuild(pid, { bs: AHEAD, stage }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect({ stage, rec: r.data.recommended }).toEqual({ stage, rec: "keep-open" });
      expect(r.data.reason).not.toMatch(/landed locally/i);
      expect(r.data.reason).not.toMatch(/reached the remote/i);
      // Still gated, though — the confirm is what this bead is about.
      expect(r.data.retirementConfirm).toBe(true);
    }
    // …and with nothing left to push, the recommendation is to leave the row alone, not to close it.
    const done = previewClose(seedBuild(pid, { bs: CLEAN, stage: "merged_local" }));
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.data.retirementConfirm).toBe(true);
    expect(done.data.recommended).toBe("keep-open");
    // The sentence roborev 59153 removed from landed rows must not come back through this door.
    expect(done.data.reason).not.toMatch(/safe and silent/i);
  });

  it("recommends KEEPING an agent with uncommitted changes open — every close outcome drops the worktree", () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: DIRTY });
    const r = previewClose(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.wouldPrompt).toBe(true);
    expect(r.data.uncommittedChanges).toBe(true);
    expect(r.data.recommended).toBe("keep-open");
    expect(r.data.reason).toMatch(/uncommitted/i);
  });

  // THE FALSE REPORT (bead sparkle-plxhx). `preview_close` returned `uncommittedChanges: true`
  // AND `statusUnknown: true` together for every deadlocked worker — and the first of those was
  // simply untrue: the trees were `git status --porcelain` empty. Parking is an ATTRIBUTION fact
  // ("whose dirt is this?"), and attribution is only ever a question about dirt that exists.
  //
  // `statusUnknown` deliberately STAYS true here: for a preview, "this tree is off its minted
  // branch" is a real caveat worth showing. What it may not do is masquerade as uncommitted work.
  it("does not report uncommitted changes for a parked worktree that is provably clean", () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: { ...CLEAN, worktreeOnBranch: false } });
    const r = previewClose(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.uncommittedChanges).toBe(false);
    expect(r.data.statusUnknown).toBe(true);
    expect(r.data.reason).not.toMatch(/uncommitted/i);
  });

  // The safety half, unchanged: a DIRTY parked tree still reports uncommitted work, because parking
  // carries those files along and the teardown destroys them.
  it("still reports uncommitted changes for a parked worktree that is dirty", () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: { ...DIRTY, worktreeOnBranch: false } });
    const r = previewClose(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.uncommittedChanges).toBe(true);
    expect(r.data.recommended).toBe("keep-open");
  });

  it("never recommends DISCARD — that is only ever the human's explicit choice", () => {
    const pid = seedProject();
    const cases: Array<BranchStatus | undefined> = [undefined, CLEAN, AHEAD, DIRTY];
    for (const bs of cases) {
      const id = seedBuild(pid, bs ? { bs } : {});
      const r = previewClose(id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.recommended).not.toBe("discard");
    }
  });

  it("closes a WORKER silently (workers are the orchestrator's business, not the human's)", () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN, stage: "merged" });
    const worker = seedWorker(pid, build);
    const r = previewClose(worker);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.wouldPrompt).toBe(false);
    expect(r.data.kind).toBe("worker");
  });

  // The whole point of reusing engine/closeAgent: ONE policy. If shouldPromptOnClose changes, this
  // moves with it rather than the concierge drifting into a second, quieter rule.
  it("matches shouldPromptOnClose exactly across the status matrix", () => {
    const pid = seedProject();
    const table: Array<{ bs: BranchStatus | undefined; stage: WorkflowStageId }> = [
      { bs: undefined, stage: "building_unsaved" }, // not polled yet → prompt
      { bs: CLEAN, stage: "building_unsaved" }, // nothing at risk → silent
      { bs: AHEAD, stage: "building_saved" }, // commits at risk → prompt
      { bs: DIRTY, stage: "building_unsaved" }, // dirty tree → prompt
      { bs: { ...CLEAN, worktreeOnBranch: false }, stage: "building_unsaved" }, // parked → prompt
      { bs: AHEAD, stage: "merged" }, // landed on origin → silent
      { bs: AHEAD, stage: "merged_local" }, // local only → still prompt
    ];
    for (const row of table) {
      const id = seedBuild(pid, row.bs ? { bs: row.bs, stage: row.stage } : { stage: row.stage });
      const r = previewClose(id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect({ ...row, prompt: r.data.wouldPrompt }).toEqual({
        ...row,
        prompt: shouldPromptOnClose("build", r.data.stage, row.bs),
      });
    }
  });

  it("refuses (typed) for an id that isn't an agent", () => {
    const r = previewClose("nope");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown-agent");
  });

  it("carries the full discard preview so the consequence can be explained BEFORE acting", () => {
    const pid = seedProject();
    const parent = seedBuild(pid, { bs: AHEAD, beadId: "bd-1" });
    const child = seedWorker(pid, parent, "bd-2");
    const r = previewClose(parent);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.discardPreview.childAgentIds).toEqual([child]);
    expect(r.data.discardPreview.anyUnmerged).toBe(true);
  });
});

// ── previewDiscard ──────────────────────────────────────────────────────────────────────────────
describe("previewDiscard", () => {
  it("enumerates the agent AND every child: branches, beads, worktrees, and what is unmerged", () => {
    const pid = seedProject();
    const parent = seedBuild(pid, { bs: AHEAD, stage: "building_saved", beadId: "bd-parent" });
    const w1 = seedWorker(pid, parent, "bd-w1");
    const w2 = seedWorker(pid, parent);
    const other = seedBuild(pid, { bs: CLEAN, beadId: "bd-other" }); // untouched by this discard

    const r = previewDiscard(parent);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Parent first, then its children in the order the COLUMN shows them — `project.agents` order,
    // which `addAgent` builds newest-first (it inserts at the front). So `w2`, seeded after `w1`,
    // is listed above it: the preview enumerates what the user is looking at, not seed order.
    expect(r.data.targets.map((t) => t.agentId)).toEqual([parent, w2, w1]);
    expect(r.data.childAgentIds).toEqual([w2, w1]);
    expect(r.data.branches).toEqual([
      `sparkle/agent-${parent}`,
      `sparkle/agent-${w2}`,
      `sparkle/agent-${w1}`,
    ]);
    expect(r.data.beadIds).toEqual(["bd-parent", "bd-w1"]); // w2 has none
    expect(r.data.anyUnmerged).toBe(true);
    expect(r.data.irreversible).toBe(true);
    expect(r.data.requiredConfirm).toBe(DISCARD_CONFIRM_TOKEN);
    // The other agent's branch/bead is nowhere near this preview.
    expect(r.data.branches).not.toContain(`sparkle/agent-${other}`);
    expect(r.data.beadIds).not.toContain("bd-other");
  });

  it("reports anyUnmerged=false once the work has landed on origin main", () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: CLEAN, stage: "merged" });
    const r = previewDiscard(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.anyUnmerged).toBe(false);
    expect(r.data.targets[0]!.unmerged).toBe(false);
  });

  it("is read-only — nothing is destroyed by looking", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD });
    previewDiscard(id);
    await Promise.resolve();
    expect(discardGitMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toContain(id);
  });
});

// ── Discard: the irreversible one ───────────────────────────────────────────────────────────────
describe("discardAgent", () => {
  it("cannot be invoked without the explicit intent (the type forbids it; the runtime refuses it)", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD });
    // @ts-expect-error — intent is REQUIRED and non-defaulted: omitting it must not compile.
    const missing = await discardAgent(id);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe("intent-required");
    expect(discardGitMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toContain(id);
  });

  it("refuses a malformed / wrong-token intent", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD });
    for (const bogus of [
      {},
      { confirm: "yes", agentId: id },
      { confirm: DISCARD_CONFIRM_TOKEN },
      null,
      true,
      DISCARD_CONFIRM_TOKEN,
    ]) {
      const r = await discardAgent(id, bogus as never);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("intent-required");
    }
    expect(discardGitMock).not.toHaveBeenCalled();
  });

  it("refuses an intent that names a DIFFERENT agent (no discarding by stale confirmation)", async () => {
    const pid = seedProject();
    const a = seedBuild(pid, { bs: AHEAD });
    const b = seedBuild(pid, { bs: AHEAD });
    const r = await discardAgent(a, { confirm: DISCARD_CONFIRM_TOKEN, agentId: b });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("intent-mismatch");
    expect(discardGitMock).not.toHaveBeenCalled();
  });

  it("destroys exactly what the preview promised — the agent, its children, their branches and beads", async () => {
    const pid = seedProject();
    const parent = seedBuild(pid, { bs: AHEAD, beadId: "bd-parent" });
    const child = seedWorker(pid, parent, "bd-child");
    const keep = seedBuild(pid, { bs: CLEAN, beadId: "bd-keep" });

    const r = await discardAgent(parent, { confirm: DISCARD_CONFIRM_TOKEN, agentId: parent });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.risk).toBe("irreversible");
    expect(discardGitMock).toHaveBeenCalledTimes(1);
    expect(discardGitMock).toHaveBeenCalledWith({
      root: "/tmp/demo",
      projectId: pid,
      ids: [parent, child],
      beadIds: ["bd-parent", "bd-child"],
    });
    // Cloud sandboxes under a discarded subtree are terminated too (parent + child).
    expect(terminateIfCloudMock).toHaveBeenCalledTimes(2);
    const left = useProjectStore.getState().projects[0]!.agents.map((a) => a.id);
    expect(left).toEqual([keep]);
    expect(r.data.destroyed.targets.map((t) => t.agentId)).toEqual([parent, child]);
  });

  // PER-SITE LEAK COVERAGE — `discardAgent` (bead sparkle-bxidpw).
  //
  // `removeAgent` opens a `close:<id>` perf trace that only a mounted `AgentPane`'s unmount can end,
  // so a row removed with no pane used to leak it permanently — and `openTraceKinds()` then named
  // the ghost as an in-flight interaction on every later jank stall line. Each `removeAgent` call
  // site is covered separately because the fix is ONE shared gate in the store: per AGENTS.md
  // (`sparkle-50m03`) a shared fix reads as verified the moment any single site is covered, while a
  // site that later grows its own `perfStart` regresses in silence.
  //
  // This site leaks unconditionally rather than occasionally: it `await`s `discardAgentGit` BEFORE
  // `removeAgent`, so by then React has long since committed the unmount of any pane that did exist.
  // That is also why nothing is lost by gating — this path emitted no waterfall even when a pane had
  // been open, because the pane's `perfEnd` ran against a trace that had not been started yet.
  //
  // NO `__resetTracesForTest()` ANYWHERE IN THIS FILE, deliberately. The assertion is that the whole
  // suite ahead of it leaves no `close` ghost, which a reset would quietly manufacture.
  it("leaves NO dangling close trace — the discarded agent's pane was never mounted", async () => {
    const pid = seedProject();
    const parent = seedBuild(pid, { bs: AHEAD, beadId: "bd-parent" });
    seedWorker(pid, parent, "bd-child");

    const r = await discardAgent(parent, { confirm: DISCARD_CONFIRM_TOKEN, agentId: parent });
    expect(r.ok).toBe(true);

    // The rows are gone, so a `close` still in flight is a ghost by definition.
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
    // THE SIDE EFFECT — what the jank monitor would actually print in its `during` field.
    //
    // NARROWED TO `close`, AND HERE IS THE ACTUAL REASON — which is NOT the one this comment used
    // to give ("selection fallbacks on these paths open `switch:` traces"). `discardAgent` never
    // calls `selectAgent`, so that mechanism does not exist on this path (roborev 67348, 67368).
    // The narrowing is required by THIS FILE instead: it deliberately never calls
    // `__resetTracesForTest()` (see the note above), and it drives the real
    // `spawnBuildAgentInProject`, which `perfStart`s a `spawn:` trace and lands via
    // `agentReveal` → `selectAgent`. So earlier tests leave `spawn:`/`switch:` residue in the
    // module-scoped map and a whole-map `toBeUndefined()` would fail on THEIR traces, not this
    // path's. The cost is stated plainly: this form cannot see a non-`close` leak that this path
    // grows later. `services/workerSpawn.test.ts` asserts the whole map for the site that can.
    expect(openTraceKinds() ?? "").not.toContain("close");
  });

  it("is never the fallback of a conditional: an unknown agent refuses, it does not destroy", async () => {
    const r = await discardAgent("ghost", { confirm: DISCARD_CONFIRM_TOKEN, agentId: "ghost" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown-agent");
    expect(discardGitMock).not.toHaveBeenCalled();
  });

  // A worker discarded directly would delete the branch, worktree and bead out from under a live
  // orchestrator blocked in wait_for_workers — with no way for it to learn why. Discarding the
  // PARENT still cascades to its workers (see the test above); only naming a worker is refused.
  it("refuses a WORKER even with a well-formed intent (its orchestrator is waiting on it)", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: AHEAD });
    const worker = seedWorker(pid, build, "bd-w");
    const r = await discardAgent(worker, { confirm: DISCARD_CONFIRM_TOKEN, agentId: worker });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-a-build-agent");
    expect(discardGitMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toContain(worker);
  });

  it("isDiscardIntent fails closed on anything that isn't the exact shape", () => {
    expect(isDiscardIntent({ confirm: DISCARD_CONFIRM_TOKEN, agentId: "a" })).toBe(true);
    expect(isDiscardIntent({ confirm: DISCARD_CONFIRM_TOKEN, agentId: "" })).toBe(false);
    expect(isDiscardIntent({ confirm: "discard", agentId: "a" })).toBe(false);
    expect(isDiscardIntent(undefined)).toBe(false);
  });
});

// ── Close / ship / save / spin-down ─────────────────────────────────────────────────────────────
describe("closeAgent", () => {
  it("closes silently when nothing is at risk (worktree removed, BRANCH kept by default)", async () => {
    const pid = seedProject();
    // NOT `merged` — see the retirement-gate test below. A landed agent is now refused, so using a
    // landed stage here would test the gate instead of the teardown this case is about.
    const id = seedBuild(pid, { bs: CLEAN, stage: "building_saved" });
    const r = await closeAgent(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(spinDownGitMock).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [id], deleteBranch: false }),
    );
    expect(discardGitMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
  });

  it("REFUSES to close a LANDED agent — only the founder takes a row off the build list", async () => {
    // THE BEAD, IN ONE TEST (sparkle-0l9xk). This case used to assert the opposite — a merged agent
    // closed silently, worktree gone, row gone — and that assertion is the bug: the concierge is
    // what closed three landed agents on its own judgement, each one leaving with its retro unread.
    // The work is safe either way (it landed), so what is at stake is the feedback record and the
    // founder's standing instruction that he confirms removals himself.
    const pid = seedProject();
    const id = seedBuild(pid, { bs: CLEAN, stage: "merged" });
    const r = await closeAgent(id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("needs-human-confirm");
    // Distinct from `needs-decision`: nothing is at risk and there is no ship/save/discard choice.
    expect(r.reason).not.toBe("needs-decision");
    // Nothing was torn down, and the row is still there for him to act on.
    expect(spinDownGitMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toContain(id);
  });

  it("refuses a stated no-retro reason that fails muster, and closes NOTHING", async () => {
    // The live path into recordRetroExcused (bead sparkle-0l9xk). `excused` is the one receipt state
    // the agent being judged writes about itself, so the wording rules are enforced before anything
    // is recorded — and the refusal carries muster's OWN phrase, because an agent told only "that
    // failed" retries the exact text that was just refused.
    const pid = seedProject();
    const id = seedBuild(pid, { bs: CLEAN, stage: "building_saved" });
    const r = await closeAgent(id, { reasonCode: "other", reasonText: "n/a" });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/too brief/);
    expect(spinDownGitMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toContain(id);
  });

  it("a well-formed excuse does NOT buy a close for a landed agent", async () => {
    // The receipt decides what the confirm dialog SAYS, never whether to ask. An excuse that could
    // talk the gate open would be the silent skip wearing better manners.
    const pid = seedProject();
    const id = seedBuild(pid, { bs: CLEAN, stage: "merged" });
    const r = await closeAgent(id, {
      reasonCode: "absorbed",
      reasonText: "Absorbed into the parent branch before this agent committed anything of its own.",
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("needs-human-confirm");
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toContain(id);
  });

  it("REFUSES to close an agent with work at risk — the human must choose ship/save/discard", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD });
    const r = await closeAgent(id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("needs-decision");
    expect(r.preview?.recommended).toBe("ship");
    expect(spinDownGitMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toContain(id);
  });

  it("routes a WORKER to spinDownWorker (its own teardown, branch kept)", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, build, undefined, CLEAN);
    const r = await closeAgent(worker);
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
    expect(spinDownGitMock).not.toHaveBeenCalled();
  });

  // close_agent has no confirmation argument at all, so the worker guard is absolute on this path:
  // it can only ever destroy uncommitted work by being routed somewhere that can confirm.
  it("refuses to close a WORKER whose worktree is dirty, and tears nothing down", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, build, undefined, DIRTY);
    const r = await closeAgent(worker);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("uncommitted-work");
    expect(spinDownWorkerMock).not.toHaveBeenCalled();
    expect(spinDownGitMock).not.toHaveBeenCalled();
  });
});

describe("shipAgent", () => {
  it("pushes + opens a PR against the project's default branch, then tears the agent down", async () => {
    const pid = seedProject();
    useProjectStore.setState((s) => ({
      projects: s.projects.map((p) => (p.id === pid ? { ...p, defaultBranch: "trunk" } : p)),
    }));
    const id = seedBuild(pid, { bs: AHEAD, beadId: "bd-ship" });
    const r = await shipAgent(id);
    expect(r.ok).toBe(true);
    expect(shipWorkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/demo",
        agentId: id,
        targetBranch: "trunk",
        beadId: "bd-ship",
      }),
    );
    expect(discardGitMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
  });

  // roborev 54175-1: the wrapper used to infer "shipped, PR opened" from the mere absence of a
  // throw. Everything below pins what it now REPORTS, per outcome.
  it("reports the pull request it actually opened", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD });
    const r = await shipAgent(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ship).toMatchObject({ kind: "pr-opened", prOpened: true, prUrl: "https://pr/1" });
  });

  it("reports a local LAND (no remote) as landed — never as a pull request", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD });
    shipWorkMock.mockResolvedValue({
      kind: "landed",
      pushed: false,
      prOpened: false,
      landed: true,
      mergeSha: "abc123",
    });
    const r = await shipAgent(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ship).toMatchObject({ landed: true, prOpened: false, mergeSha: "abc123" });
    // THE ROW SURVIVES, and this assertion is the one that changed (knightwatch probe 2). It used
    // to assert `toHaveLength(0)` — the row gone — which is the defect: a local land MERGES the
    // branch, and merged work is precisely what the founder confirms before its row leaves the
    // list. `closeBuildAgent`'s own gate could not catch this one because it reads the stage from
    // branchStatus, polled BEFORE the ship and therefore still saying pre-merge.
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toContain(id);
    expect(r.data.retirementPending).toBe(true);
    expect(r.data.agentIds).toEqual([]);
  });

  it("does NOT claim a PR when the push landed but `gh` failed — the branch is safe, so it still closes", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD });
    shipWorkMock.mockResolvedValue({
      kind: "pushed-no-pr",
      pushed: true,
      prOpened: false,
      landed: false,
      reason: "gh: not found",
    });
    const r = await shipAgent(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ship).toMatchObject({ pushed: true, prOpened: false, reason: "gh: not found" });
    // The branch IS on the remote, so tearing down loses nothing — same call the human path makes.
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
  });

  it("REFUSES when there's no remote and the local land failed — nothing landed, so the agent is KEPT", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD });
    shipWorkMock.mockResolvedValue({
      kind: "land-failed",
      pushed: false,
      prOpened: false,
      landed: false,
      reason: "conflict",
    });
    const r = await shipAgent(id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("action-failed");
    expect(r.message).toMatch(/conflict/);
    // NOT torn down: the row survives and the git teardown was never reached.
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toContain(id);
    expect(spinDownGitMock).not.toHaveBeenCalled();
  });

  it("keeps the agent when the ship path THROWS (the teardown is never reached)", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD });
    shipWorkMock.mockRejectedValue(new Error("push rejected"));
    const r = await shipAgent(id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("action-failed");
    expect(r.message).toMatch(/push rejected/);
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toContain(id);
    expect(spinDownGitMock).not.toHaveBeenCalled();
    expect(terminateIfCloudMock).not.toHaveBeenCalled();
    expect(discardGitMock).not.toHaveBeenCalled();
  });

  // roborev 54175-2: ship/save/discard used to accept ANY kind.
  it("refuses to ship a WORKER — a worker's branch is the orchestrator's business, not a PR", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, build);
    const r = await shipAgent(worker);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-a-build-agent");
    expect(shipWorkMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toContain(worker);
  });

  it("refuses to ship a SHELL agent — it has no branch or worktree at all", async () => {
    const pid = seedProject();
    const shell = seedShell(pid);
    const r = await shipAgent(shell);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-a-build-agent");
    expect(shipWorkMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toContain(shell);
  });
});

describe("saveAgent", () => {
  it("refuses a WORKER and a SHELL — neither is a build agent's save", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    for (const id of [seedWorker(pid, build), seedShell(pid)]) {
      const r = await saveAgent(id);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("not-a-build-agent");
    }
    expect(saveWorkMock).not.toHaveBeenCalled();
    expect(spinDownGitMock).not.toHaveBeenCalled();
  });

  it("backs the branch up and removes the worktree, KEEPING the branch and the bead", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD, beadId: "bd-save" });
    // Even with the merged-branch cleanup ON, saving must never delete the branch.
    useSettingsStore.setState({ deleteMergedBranch: true });
    const r = await saveAgent(id);
    expect(r.ok).toBe(true);
    expect(saveWorkMock).toHaveBeenCalledWith("/tmp/demo", id);
    expect(spinDownGitMock).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [id], deleteBranch: false }),
    );
    expect(discardGitMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
  });

  // PER-SITE LEAK COVERAGE — `saveAgent` → `tearDownKeepingBranches` (bead sparkle-bxidpw). See the
  // equivalent test in the `discardAgent` describe for why every `removeAgent` call site gets its
  // own case rather than trusting the one shared gate in the store.
  //
  // Same shape as discard and leaking for the same reason: `spinDownAgentGit` is awaited BEFORE
  // `removeAgent`, so any pane has already unmounted and its `perfEnd` found no trace to end.
  it("leaves NO dangling close trace — the saved agent's pane was never mounted", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD, beadId: "bd-save" });

    const r = await saveAgent(id);
    expect(r.ok).toBe(true);

    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
    // Narrowed for the same file-level reason as the discard case above — cross-test `spawn:` /
    // `switch:` residue in a suite that never resets the trace map — and NOT because this path
    // opens a `switch:` trace of its own; `saveAgent` never calls `selectAgent` either.
    expect(openTraceKinds() ?? "").not.toContain("close");
  });

  // roborev 54225-2: the SAME principle ship got. A save's own sentence is "backed the branch up to
  // the remote and kept it" — which is a claim about the network, made after the worktree is already
  // gone. It has to be read from the SaveOutcome, never from "saveAgentWork didn't throw".
  it("reports the backup push it actually did, not merely that nothing threw", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD, beadId: "bd-save" });
    const r = await saveAgent(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.save).toEqual({ kind: "pushed", pushed: true });
  });

  it("says the backup did NOT happen when the push failed — and still keeps the branch + bead", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD, beadId: "bd-save" });
    saveWorkMock.mockResolvedValue({ kind: "push-failed", pushed: false, reason: "offline" });
    const r = await saveAgent(id);
    // Still a success: the branch and the bead survive on this machine, which is what save promises.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.save).toMatchObject({ pushed: false, kind: "push-failed", reason: "offline" });
    // The teardown still ran, and it still refused to delete the branch.
    expect(spinDownGitMock).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [id], deleteBranch: false }),
    );
  });

  it("distinguishes a repo with NO remote from a push that failed", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD });
    saveWorkMock.mockResolvedValue({ kind: "no-remote", pushed: false });
    const r = await saveAgent(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.save).toEqual({ kind: "no-remote", pushed: false });
  });
});

describe("spinDownWorkerAgent", () => {
  it("refuses a non-worker id rather than tearing down a build agent's subtree", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: CLEAN });
    const r = await spinDownWorkerAgent(id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-a-worker");
    expect(spinDownWorkerMock).not.toHaveBeenCalled();
  });

  it("spins a worker down through the existing worker teardown", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, build, undefined, CLEAN);
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
  });

  // The teardown removes the checkout with --force, so "the branch is kept" does NOT cover
  // uncommitted files. Each case asserts the TEARDOWN DID NOT RUN — the refusal object alone would
  // pass even if the worktree had already been deleted underneath it.
  //
  // ONLY A POSITIVE DIRTY READING RAISES `uncommitted-work` (bead sparkle-plxhx). The parked-clean
  // and no-reading cases used to be listed here too, and that is precisely what deadlocked the
  // fleet — they are now `status-unknown` or a clean retire, covered below.
  it.each([
    ["a dirty worktree", DIRTY],
    // The case the parked gate was actually written for, and it is UNCHANGED: parking carries
    // uncommitted files along, so a dirty parked tree still holds real work the teardown destroys.
    ["a dirty worktree parked on another branch", { ...DIRTY, worktreeOnBranch: false }],
  ])("refuses to spin a worker down with %s", async (_label, bs) => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, build, undefined, CLEAN);
    liveBranchStatus = async () => bs;
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("uncommitted-work");
    expect(spinDownWorkerMock).not.toHaveBeenCalled();
  });

  it("spins a dirty worker down when the caller explicitly confirms the discard", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, build, undefined, DIRTY);
    liveBranchStatus = async () => DIRTY;
    const r = await spinDownWorkerAgent(worker, { discardUncommitted: true });
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
  });

  // ══ THE DEADLOCK REGRESSION (bead sparkle-plxhx) ═══════════════════════════════════════════════
  // On 2026-08-08 seven finished workers could not be retired on the founder's machine; capacity sat
  // at 85 against a ceiling of 80 and no new agent could start. Every one of them was refused with
  // "has uncommitted changes in its worktree" while `git status --porcelain` in that worktree
  // returned ZERO lines. Six were parked on descriptively-named branches (`pr1380`, `sparkle-k-esc`)
  // with the minted `sparkle/agent-<id>` ref still present, which is all `worktreeOnBranch: false`
  // means; the seventh's worktree directory was already gone.
  //
  // Each of these asserts the TEARDOWN RAN, not merely that the result was ok.
  it("retires a worker whose live tree is CLEAN but whose cached reading says parked", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    // The stale cache that produced the deadlock: parked, so the old guard called it dirty forever.
    const worker = seedWorker(pid, build, undefined, { ...CLEAN, worktreeOnBranch: false });
    // …and what git actually says right now: parked, and empty.
    liveBranchStatus = async () => ({ ...CLEAN, worktreeOnBranch: false });
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
  });

  // The seventh worker. `runtimeStore` LATCHES a removed worktree into `deadWorktrees` and never
  // polls it again, so its cached reading stays `undefined` for the app's lifetime — the refusal
  // could never clear. A checkout that does not exist cannot lose uncommitted work.
  it("retires a worker whose worktree is already gone", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, build, undefined, undefined);
    liveBranchStatus = async () => {
      throw new Error("fatal: cannot change to '/wt/gone': No such file or directory");
    };
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
  });

  // HONESTY. A tree we could not read is refused — but never with a sentence asserting that changes
  // exist. That false claim is what made the deadlock undebuggable: the founder was told to have the
  // workers commit, did so, and nothing changed, because there was nothing to commit.
  it("refuses an unreadable worktree as status-unknown, never as uncommitted work", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, build, undefined, undefined);
    liveBranchStatus = async () => {
      throw new Error("git index.lock exists");
    };
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("status-unknown");
    expect(r.message).not.toMatch(/has uncommitted changes/i);
    expect(r.message).toMatch(/couldn't read/i);
    expect(spinDownWorkerMock).not.toHaveBeenCalled();
  });

  // THE ESCAPE HATCH. An operator who can see the tree must be able to retire it without reaching
  // for `discard_agent`, which deletes branches and worktrees outright.
  it("retires an unreadable worktree when the operator passes allowUnknownStatus", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, build, undefined, undefined);
    liveBranchStatus = async () => {
      throw new Error("git index.lock exists");
    };
    const r = await spinDownWorkerAgent(worker, { allowUnknownStatus: true });
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
  });

  // …AND IT IS STRICTLY NARROWER THAN A DISCARD. `allowUnknownStatus` says "I checked, it's fine",
  // not "delete whatever is there" — so a POSITIVE dirty reading still wins. Without this, the
  // escape hatch would quietly become a second, unlabelled discard flag.
  it("allowUnknownStatus does not override a positively dirty tree", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, build, undefined, CLEAN);
    liveBranchStatus = async () => DIRTY;
    const r = await spinDownWorkerAgent(worker, { allowUnknownStatus: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("uncommitted-work");
    expect(spinDownWorkerMock).not.toHaveBeenCalled();
  });

  // THE READING IS LIVE, AND THAT IS THE POINT. A cache saying clean must not license a teardown of
  // a tree that has become dirty since the last 30s poll — the guard would otherwise be as stale as
  // the thing it replaced, just failing in the destructive direction instead of the blocking one.
  it("refuses when the live read finds dirt the cached reading missed", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, build, undefined, CLEAN);
    liveBranchStatus = async () => DIRTY;
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("uncommitted-work");
    expect(agentBranchStatusMock).toHaveBeenCalled();
    expect(spinDownWorkerMock).not.toHaveBeenCalled();
  });

  // `ahead` ITSELF must not gate the spin-down — it never returns to zero after a squash merge, so
  // an orchestrator that merged the branch would otherwise never reclaim the slot. What gates it is
  // the ancestry question (bead sparkle-3duunc, the describe below), and this worker's default
  // workflow reading answers it: on origin main, and pushed.
  it("spins down a worker with commits ahead but a clean tree", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, build, undefined, AHEAD);
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
  });
});

// ══ THE BRANCH RUNG (bead sparkle-3duunc) ═══════════════════════════════════════════════════════
// A finished worker's branch held EIGHT commits that were on neither origin/main nor any remote
// ref, with no PR — and the spin-down took its row anyway, because this path only ever asked about
// UNCOMMITTED FILES. "The branch is kept" is true and is not the same as "the work is safe": the
// row is what a human and an orchestrator navigate by, and a branch nobody points at is work nobody
// finishes. The roster reported only `status: done`.
//
// EVERY CASE HERE ASSERTS THE TEARDOWN, NOT THE VERDICT. The spin-down mock removes the agent row
// exactly as production's does, so "it refused" is checked as app STATE — a guard that refused
// AFTER destroying something would leave no row and fail these. The paired controls are what pin
// the refusal to its cause: three shapes that are unlanded-but-safe tear down untouched.
describe("spinDownWorkerAgent — commits held by this worker's branch and nothing else", () => {
  /** A worker whose teardown really removes its row, the way `spinDownWorker` does.
   *
   *  `bs: null` seeds NO cached reading — which is what makes the unreadable-repo cases below
   *  reachable at all. `readRetirementFacts` falls back to the cache when the live read throws (a
   *  stale-but-real observation beats none), so a worker carrying a cached `CLEAN` answers the
   *  branch question from that cache and never reaches the `unknown` arm. */
  function seedTearableWorker(pid: string, build: string, bs: BranchStatus | null = CLEAN): string {
    const worker = seedWorker(pid, build, undefined, bs ?? undefined);
    spinDownWorkerMock.mockImplementation(async () => {
      useProjectStore.getState().removeAgent(pid, worker);
    });
    return worker;
  }
  function rowExists(pid: string, id: string): boolean {
    const p = useProjectStore.getState().projects.find((x) => x.id === pid);
    return !!p?.agents.some((a) => a.id === id);
  }
  // The implementation is set per-test and `mockClear` does not remove it, so it would leak into
  // every later test in this file and start deleting rows they never asked to lose.
  afterEach(() => {
    spinDownWorkerMock.mockImplementation(async () => {});
  });

  // ── THE HEADLINE ──────────────────────────────────────────────────────────────────────────────
  it("refuses a clean worker whose commits are on no remote ref and on nobody else's branch", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedTearableWorker(pid, build);
    // A spotless tree — the two guards that already existed both wave this through.
    liveBranchStatus = async () => ({ ...CLEAN, ahead: 8 });
    liveWorkflowState = async () => WS_STRANDED;
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unlanded-work");
    // THE SIDE EFFECT: nothing was torn down.
    expect(spinDownWorkerMock).not.toHaveBeenCalled();
    expect(rowExists(pid, worker)).toBe(true);
  });

  // A REFUSAL IS AN INSTRUCTION THE USER WILL FOLLOW (the founder's sparkle-8bvh rule), so it has to
  // name the count and ways out that are safe under the very condition that triggered it.
  it("names the commit count, the branch, and only remedies that keep the commits", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedTearableWorker(pid, build);
    liveBranchStatus = async () => ({ ...CLEAN, ahead: 8 });
    liveWorkflowState = async () => WS_STRANDED;
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/8 commits/);
    expect(r.message).toContain(`sparkle/agent-${worker}`);
    // The three ways out, each of which either moves the commits somewhere else or is the caller
    // deliberately spending the override.
    expect(r.message).toContain(`sparkle/agent-${build}`);
    expect(r.message).toMatch(/git push -u origin/);
    expect(r.message).toMatch(/allowUnlandedWork/);
    // …and NOT the one that would destroy them. `discard_agent` deletes the branch outright, which
    // is strictly worse than the loss being guarded against.
    expect(r.message).not.toMatch(/discard/i);
  });

  // ── PAIRED CONTROL 1: it landed. The same clean tree, the same non-zero `ahead` (which a squash
  //    merge pins at N forever), and it tears down untouched. ────────────────────────────────────
  it("spins down a worker whose commits ARE on origin main", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedTearableWorker(pid, build);
    liveBranchStatus = async () => ({ ...CLEAN, ahead: 8 });
    liveWorkflowState = async () => WS_LANDED;
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
    expect(rowExists(pid, worker)).toBe(false);
  });

  // ── PAIRED CONTROL 2: unlanded, but PUSHED. This is the axis the bead names by hand — the loss
  //    needs BOTH halves, and a remote ref is what makes the commits recoverable. ────────────────
  it("spins down a worker whose unlanded commits are on a remote ref", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedTearableWorker(pid, build);
    liveBranchStatus = async () => ({ ...CLEAN, ahead: 8 });
    liveWorkflowState = async () => ({ ...WS_STRANDED, pushed: true });
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
    expect(rowExists(pid, worker)).toBe(false);
  });

  // ── PAIRED CONTROL 3: merged UP into the orchestrator. The ordinary shape of a finished worker,
  //    and the one that would have made this guard a fleet-wide deadlock (bead sparkle-plxhx) had
  //    it been written on the origin/main axis alone. ───────────────────────────────────────────
  it("spins down a worker whose commits are already in its orchestrator's branch", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedTearableWorker(pid, build);
    liveBranchStatus = async () => ({ ...CLEAN, ahead: 8 });
    liveWorkflowState = async () => ({ ...WS_STRANDED, inParent: true });
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
    expect(rowExists(pid, worker)).toBe(false);
  });

  // …AND THE WIRING THAT MAKES CONTROL 3 REACHABLE AT ALL. Rust computes `inParent` against the
  // branch name it is handed, so a call site passing "" (which every caller did before this bead)
  // pins that clearance at a permanent false and turns every normal teardown into a refusal.
  it("asks the workflow read about the ORCHESTRATOR's branch, not an empty one", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedTearableWorker(pid, build);
    liveBranchStatus = async () => CLEAN;
    liveWorkflowState = async () => WS_LANDED;
    await spinDownWorkerAgent(worker);
    expect(workflowStateParentBranches).toContain(`sparkle/agent-${build}`);
  });

  // …AND THE POPULATION THAT CARRIES NO `parentBranch` AT ALL. It is stamped at spawn time, and the
  // disk-reconcile self-heal that re-creates worker rows after a restart (`adoptWorker`) passes
  // none. Rust returns early on an empty branch name, so `inParent` would be a permanent false for
  // exactly those rows and the ordinary merged-up worker would refuse forever. The minted
  // `sparkle/agent-<parentId>` is the name this app guarantees, so it is a real answer.
  it("falls back to the MINTED orchestrator branch for a worker re-adopted without one", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    // A re-adopted row: same parentId, no `parentBranch`.
    const worker = useProjectStore.getState().addAgent(pid, {
      kind: "worker",
      parentId: build,
      task: "do a thing",
      select: false,
    })!;
    useProjectStore.getState().setAgentWorktree(pid, worker, `/wt/${worker}`, `sparkle/agent-${worker}`);
    spinDownWorkerMock.mockImplementation(async () => {
      useProjectStore.getState().removeAgent(pid, worker);
    });
    liveBranchStatus = async () => ({ ...CLEAN, ahead: 8 });
    liveWorkflowState = async () => ({ ...WS_STRANDED, inParent: true });
    const r = await spinDownWorkerAgent(worker);
    // The reading was asked about the minted name — without it Rust could not answer `inParent`…
    expect(workflowStateParentBranches).toContain(`sparkle/agent-${build}`);
    // …and the ordinary merged-up worker tears down.
    expect(r.ok).toBe(true);
    expect(rowExists(pid, worker)).toBe(false);
  });

  // …and the refusal SENTENCE uses the same fallback, so it can never read "Have it merged into ,".
  it("names the minted orchestrator branch in the refusal when the row carries none", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = useProjectStore.getState().addAgent(pid, {
      kind: "worker",
      parentId: build,
      task: "do a thing",
      select: false,
    })!;
    useProjectStore.getState().setAgentWorktree(pid, worker, `/wt/${worker}`, `sparkle/agent-${worker}`);
    liveBranchStatus = async () => ({ ...CLEAN, ahead: 8 });
    liveWorkflowState = async () => WS_STRANDED;
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain(`merged into sparkle/agent-${build}`);
    expect(r.message).not.toMatch(/merged into ,/);
  });

  // ── THE OVERRIDE. Deliberate, named, and the only thing that clears a POSITIVE reading. ───────
  it("spins the worker down when the caller passes allowUnlandedWork", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedTearableWorker(pid, build);
    liveBranchStatus = async () => ({ ...CLEAN, ahead: 8 });
    liveWorkflowState = async () => WS_STRANDED;
    const r = await spinDownWorkerAgent(worker, { allowUnlandedWork: true });
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
    expect(rowExists(pid, worker)).toBe(false);
  });

  // …AND THE TWO FLAGS THAT MUST NOT CLEAR IT. Each says something about a DIFFERENT axis, and
  // spending either one here would let a caller drop eight committed commits it never heard about.
  it.each([
    ["discardUncommitted", { discardUncommitted: true }],
    ["allowUnknownStatus", { allowUnknownStatus: true }],
  ])("%s does not override a positive unlanded reading", async (_label, opts) => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedTearableWorker(pid, build);
    liveBranchStatus = async () => ({ ...CLEAN, ahead: 8 });
    liveWorkflowState = async () => WS_STRANDED;
    const r = await spinDownWorkerAgent(worker, opts);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unlanded-work");
    expect(spinDownWorkerMock).not.toHaveBeenCalled();
    expect(rowExists(pid, worker)).toBe(true);
  });

  // ── FAIL CLOSED. An unreadable repo cannot authorize a deletion. Same honesty split the tree
  //    rung draws: the sentence must not assert that unlanded work exists. ──────────────────────
  it("refuses as unlanded-unknown when the repo cannot be read at all", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedTearableWorker(pid, build, null);
    // The worktree is GONE — which settles the FILE question ("clean": there is no checkout to
    // lose) and leaves no `BranchStatus` at all…
    liveBranchStatus = async () => {
      throw new Error("fatal: cannot change to '/wt/gone': No such file or directory");
    };
    // …and the branch reading fails too, so nothing is known about where the commits are.
    liveWorkflowState = async () => {
      throw new Error("git: could not read refs");
    };
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unlanded-unknown");
    expect(r.message).toMatch(/couldn't establish/i);
    expect(r.message).toMatch(/NOT a report/);
    expect(spinDownWorkerMock).not.toHaveBeenCalled();
    expect(rowExists(pid, worker)).toBe(true);
  });

  // …AND ITS ESCAPE HATCH, so "we could not tell" is a cautious gate rather than a locked door
  // (bead sparkle-plxhx). `allowUnknownStatus` already means "I went and looked myself".
  it("spins down an unreadable worker when the operator passes allowUnknownStatus", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedTearableWorker(pid, build, null);
    liveBranchStatus = async () => {
      throw new Error("fatal: cannot change to '/wt/gone': No such file or directory");
    };
    liveWorkflowState = async () => {
      throw new Error("git: could not read refs");
    };
    const r = await spinDownWorkerAgent(worker, { allowUnknownStatus: true });
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
    expect(rowExists(pid, worker)).toBe(false);
  });

  // ── AND THE VERB THAT ROUTES HERE. `close_agent` hands a worker straight to this path, so the
  //    guard would be bypassable by name if the refusal did not travel back out of it. ──────────
  it("close_agent relays the refusal rather than closing the worker itself", async () => {
    const pid = seedProject();
    const build = seedBuild(pid, { bs: CLEAN });
    const worker = seedTearableWorker(pid, build);
    liveBranchStatus = async () => ({ ...CLEAN, ahead: 8 });
    liveWorkflowState = async () => WS_STRANDED;
    const r = await closeAgent(worker);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unlanded-work");
    expect(spinDownWorkerMock).not.toHaveBeenCalled();
    expect(rowExists(pid, worker)).toBe(true);
  });
});

// A compile-time guard, asserted at runtime too: every exported entry point declares its op, and
// every op it declares is in the map.
describe("typed results", () => {
  it("every result carries its op and that op's risk class", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: CLEAN, stage: "merged" });
    const results = [
      previewClose(id),
      previewDiscard(id),
      await spawnBuildAgent({ projectId: pid, runtime: "cloud" }),
      await closeAgent(id),
    ];
    for (const r of results) {
      const op: LifecycleOp = r.op;
      expect(LIFECYCLE_OPS).toContain(op);
      expect(r.risk).toBe(LIFECYCLE_RISK[op]);
    }
  });
});

// ── Restart / Stop — the two ops that act on a PROCESS ─────────────────────────────────────────
//
// Bead sparkle-x0pvw. The founder asked for the concierge to be able to restart and stop the
// app-owned Improve Sparkle agent, the motivating case being a pane wedged on a Claude CLI login
// screen that ignores Escape — where a restart is the only real remedy.
//
// TWO PROPERTIES ARE UNDER TEST AND THEY PULL IN OPPOSITE DIRECTIONS. These two ops must REACH that
// agent (every other op in this file cannot, because `locate` scans `projects[].agents` and the
// app-owned agent is deliberately not in it); and the DESTRUCTIVE ops must go on being unable to,
// because `discard_agent` pointed at it would delete the app-owned clone the hourly scheduler works
// in. A change that widened resolution for the whole file would satisfy the first and silently break
// the second, so both are asserted here, together.
describe("restart_agent / stop_agent", () => {
  beforeEach(() => {
    clearPaneRestarts();
    resetPaneReadiness();
    releasePass();
    vi.mocked(killPty).mockClear();
    vi.mocked(killPty).mockResolvedValue(undefined);
  });
  afterEach(() => {
    clearPaneRestarts();
    resetPaneReadiness();
    releasePass();
  });

  /** Make `agentId` look like it has a mounted pane and a live status, which is what
   *  `findKnownAgent`'s Sparkle/observed arms resolve on. Returns the restart spy. */
  function mountPane(agentId: string) {
    // A HEALTHY pane: prepare reaches phase "ready" AND the PTY comes up. Both are required — the
    // success verdict is paneReadiness, not the phase (see the PTY-spawn-dies test below).
    const restart = vi.fn(() => {
      notePaneRelaunch(agentId);
      setPaneReady(agentId, true);
      return "ready";
    });
    registerPaneRestart(agentId, restart);
    useRuntimeStore.setState({ status: { [agentId]: "working" } } as never);
    return restart;
  }

  it("restarts the app-owned Improve Sparkle agent — the op that motivated this", async () => {
    const restart = mountPane(SPARKLE_AGENT_ID);
    const r = await restartAgent(SPARKLE_AGENT_ID);
    expect(r.ok).toBe(true);
    // THE SIDE EFFECT, not the reply: a result object saying "restart" proves nothing about whether
    // the pane was actually re-spawned.
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("stops it by killing the PTY and nothing else", async () => {
    mountPane(SPARKLE_AGENT_ID);
    const r = await stopAgent(SPARKLE_AGENT_ID);
    expect(r.ok).toBe(true);
    // A concierge stop is not a human stop; the ledger has to be able to tell them apart.
    expect(killPty).toHaveBeenCalledWith(SPARKLE_AGENT_ID, "concierge-stop-agent");
    // The narrow reading, asserted as the ABSENCE of the destructive calls: a stop must not reach
    // the teardown paths that remove worktrees or branches.
    expect(spinDownGitMock).not.toHaveBeenCalled();
    expect(discardGitMock).not.toHaveBeenCalled();
  });

  // THE OTHER HALF, and the one that must not regress. If a later change routes the whole file
  // through `findKnownAgent`, these flip to `ok` and the app-owned worktree becomes destroyable.
  it("leaves the DESTRUCTIVE ops still unable to resolve it", async () => {
    mountPane(SPARKLE_AGENT_ID);
    const closed = await closeAgent(SPARKLE_AGENT_ID);
    expect(closed.ok).toBe(false);
    expect(closed.ok === false && closed.reason).toBe("unknown-agent");
    const discarded = await discardAgent(SPARKLE_AGENT_ID, {
      agentId: SPARKLE_AGENT_ID,
      confirm: "discard",
    } as never);
    expect(discarded.ok).toBe(false);
    expect(discardGitMock).not.toHaveBeenCalled();
  });

  it("works on an ORDINARY build agent too — this is not a Sparkle-only lever", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const restart = mountPane(agentId);
    expect((await restartAgent(agentId)).ok).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  // ── `resume_worker` — THE ORCHESTRATOR'S NARROWED RESTART (bead `sparkle-abl8ug`) ─────────────
  //
  // Same act as `restart_agent`, with the populations that make a restart dangerous removed, which is
  // what lets an unattended orchestrator call it. Each gate is asserted on the SIDE EFFECT — whether
  // the pane lever was actually pulled — because a refusal object proves nothing about whether the
  // process was left alone, and "left alone" is the whole property.
  describe("resume_worker", () => {
    /** A pane mounted but QUIET: the worker's process is gone, which is the population this op is
     *  for. `mountPane` seeds `working`, so the status is overwritten after it. */
    function mountDeadPane(agentId: string) {
      const restart = mountPane(agentId);
      useRuntimeStore.setState({ status: { [agentId]: "idle" } } as never);
      return restart;
    }

    it("resumes a QUIET worker — the population it exists for", async () => {
      const projectId = seedProject();
      const parentId = seedBuild(projectId);
      const workerId = seedWorker(projectId, parentId);
      const restart = mountDeadPane(workerId);
      const r = await resumeWorker(workerId);
      expect(r.ok).toBe(true);
      // THE SIDE EFFECT: the pane really was re-spawned.
      expect(restart).toHaveBeenCalledTimes(1);
      // And the reply names the op the CALLER asked for, not the one it delegates to — a receipt
      // stamped `restart_agent` is a receipt for a call nobody made.
      expect(r.op).toBe("resume_worker");
      expect(r.ok === true && r.data).toMatchObject({ agentId: workerId, outcome: "restart" });
    });

    // ── GATE 1: WORKER ONLY ──────────────────────────────────────────────────────────────────────
    it.each([
      ["a build agent", "build"],
      ["a shell", "shell"],
    ])("REFUSES %s and never pulls the pane lever", async (_label, kind) => {
      const projectId = seedProject();
      const agentId = useProjectStore.getState().addAgent(projectId, { kind } as never)!;
      const restart = mountDeadPane(agentId);
      const r = await resumeWorker(agentId);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe("not-a-worker");
      expect(restart).not.toHaveBeenCalled();
    });

    it("REFUSES the app-owned Improve Sparkle agent, which has no roster row to be a worker", async () => {
      // `findKnownAgent` resolves it through its Sparkle arm, so it EXISTS — but it carries no `tab`,
      // and an agent with no row saying what it is cannot be established as anybody's worker. This
      // pins the `tab?.kind === undefined` branch: read `agent.kind` off the wrong object and this
      // would not even compile, but read it off a defaulted one and the app's own agent becomes
      // re-spawnable by any orchestrator.
      const restart = mountDeadPane(SPARKLE_AGENT_ID);
      const r = await resumeWorker(SPARKLE_AGENT_ID);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe("not-a-worker");
      expect(restart).not.toHaveBeenCalled();
    });

    // ── GATE 2: NOT PRODUCING OUTPUT ─────────────────────────────────────────────────────────────
    //
    // This is the gate that makes the `routine` risk classification TRUE rather than asserted: with
    // it, the op cannot stop work in flight, which is the exact property policy.ts's `disruptive`
    // tier gates on. The RED tier is included deliberately — an agent holding a question or an
    // approval open is mid-exchange with somebody, and re-spawning it discards that.
    it.each(["working", "questions", "waiting", "approval"])(
      "REFUSES a worker whose status is `%s`, leaving its turn alone",
      async (status) => {
        const projectId = seedProject();
        const parentId = seedBuild(projectId);
        const workerId = seedWorker(projectId, parentId);
        const restart = mountPane(workerId);
        useRuntimeStore.setState({ status: { [workerId]: status } } as never);
        const r = await resumeWorker(workerId);
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toBe("agent-busy");
        expect(restart).not.toHaveBeenCalled();
      },
    );

    // ── GATE 3: THE READING MUST EXIST ───────────────────────────────────────────────────────────
    it("REFUSES when the activity reading is ABSENT — an unread status is not evidence of quiet", async () => {
      // `runtimeStore.status` is written only by a mounted pane, so a whole project reads `undefined`
      // after a relaunch. Treating that as quiet would make the entire fleet resumable on the
      // strength of a map nobody had populated. The refusal names the remedy instead.
      const projectId = seedProject();
      const parentId = seedBuild(projectId);
      const workerId = seedWorker(projectId, parentId);
      const restart = mountPane(workerId);
      useRuntimeStore.setState({ status: {} } as never);
      const r = await resumeWorker(workerId);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe("activity-unknown");
      expect(r.ok === false && r.message).toMatch(/pane/i);
      expect(restart).not.toHaveBeenCalled();
    });

    it("REFUSES an id that names no agent at all", async () => {
      const r = await resumeWorker("no-such-worker");
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe("unknown-agent");
    });

    // THE FAILURE PATHS ARE THE DELEGATE'S, AND THEY MUST STILL SAY `resume_worker`. Sharing one
    // implementation is the point — these five refusals each exist because of a measured false
    // success — but a shared body that stamps the wrong op name reports a call the caller never made.
    it("carries a delegate refusal through under its OWN op name", async () => {
      const projectId = seedProject();
      const parentId = seedBuild(projectId);
      const workerId = seedWorker(projectId, parentId);
      registerPaneRestart(workerId, async () => "no-claude");
      useRuntimeStore.setState({ status: { [workerId]: "idle" } } as never);
      const r = await resumeWorker(workerId);
      expect(r.ok).toBe(false);
      expect(r.op).toBe("resume_worker");
      expect(r.ok === false && r.reason).toBe("action-failed");
    });

    it("refuses a worker with NO pane rather than claiming it came back", async () => {
      const projectId = seedProject();
      const parentId = seedBuild(projectId);
      const workerId = seedWorker(projectId, parentId);
      useRuntimeStore.setState({ status: { [workerId]: "idle" } } as never);
      const r = await resumeWorker(workerId);
      expect(r.ok).toBe(false);
      expect(r.op).toBe("resume_worker");
      expect(r.ok === false && r.reason).toBe("no-pane");
    });
  });

  // ── THE FALSE-SUCCESS ACK ────────────────────────────────────────────────────────────────────
  //
  // Measured on v0.107.0: three errored agents were restarted, all three returned
  // `{ok:true, outcome:"restart"}`, and an immediate get_agent_status on each still read `errored`
  // with needsYou true. The ack was written the instant the lever was CALLED — `restartPane` returns
  // at dispatch, and the pane's `prepare()` is async AND swallows its own failures. So "ok" meant
  // "I called a function", not "the agent restarted", which is exactly the class of bug that has the
  // concierge report agents as recovered while they are still down.
  //
  // These assert the SIDE EFFECT the reply is supposed to stand for, not the reply.

  it("refuses — readably — when the pane's prepare RESOLVES having failed", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    // prepare() catches its own error and resolves normally; only the phase reveals it.
    registerPaneRestart(agentId, async () => "error");
    useRuntimeStore.setState({ status: { [agentId]: "errored" } } as never);
    const r = await restartAgent(agentId);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("action-failed");
    // The status is left ALONE on a failure: nothing restarted, so nothing may look calmer.
    expect(useRuntimeStore.getState().status[agentId]).toBe("errored");
  });

  it("refuses when claude is missing, naming that cause rather than a generic failure", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    registerPaneRestart(agentId, async () => "no-claude");
    const r = await restartAgent(agentId);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("action-failed");
    expect(r.ok === false && r.message).toMatch(/claude/i);
  });

  it("refuses when the restart REJECTS asynchronously — the rejection restartPane discards", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    registerPaneRestart(agentId, () => Promise.reject(new Error("boom")));
    const r = await restartAgent(agentId);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("action-failed");
  });

  it("does not answer until the restart has actually finished", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    let finished = false;
    registerPaneRestart(agentId, async () => {
      notePaneRelaunch(agentId);
      await Promise.resolve();
      finished = true;
      setPaneReady(agentId, true);
      return "ready";
    });
    useRuntimeStore.setState({ status: { [agentId]: "working" } } as never);
    const r = await restartAgent(agentId);
    // Would be false if the ack were still written at dispatch.
    expect(finished).toBe(true);
    expect(r.ok).toBe(true);
  });

  // THE REGRESSION THE FIRST CUT OF THIS FIX INTRODUCED, kept as its own test. Reading the pane's
  // PHASE as the success verdict calls a launch that died at PTY spawn "restarted" — phase "ready"
  // only means the spawn command was assembled, and the Terminal's own spawn rejection publishes
  // paneReadiness `failed` without ever touching phase. An earlier version also cleared the red
  // status on that verdict, which turned a truthful `errored` into a calm `working` and made
  // get_agent_status report a down agent as needing nobody.
  it("refuses when the PTY spawn dies, even though prepare reported phase ready", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    registerPaneRestart(agentId, async () => {
      notePaneRelaunch(agentId);
      setPaneFailed(agentId);
      return "ready";
    });
    useRuntimeStore.setState({ status: { [agentId]: "errored" } } as never);
    const r = await restartAgent(agentId);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("action-failed");
    // The truthful red must survive: this agent is down and someone has to know.
    expect(useRuntimeStore.getState().status[agentId]).toBe("errored");
  });

  // THE nothing-to-restart BRANCH, tested on its own rather than only via the other cases. A shell
  // or cloud re-prepare returns early: Terminal is never remounted and the PTY is never replaced,
  // so no relaunch is announced and nothing was restarted. Saying "restarted" there reports an
  // action that did not happen.
  it("refuses when the re-prepare announced no relaunch — nothing was actually re-spawned", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    // Healthy and up throughout — it never stopped — but no notePaneRelaunch: nothing re-spawned.
    setPaneReady(agentId, true);
    registerPaneRestart(agentId, async () => "ready");
    useRuntimeStore.setState({ status: { [agentId]: "idle" } } as never);

    const r = await restartAgent(agentId);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("action-failed");
    // The copy must say nothing was replaced, and must not claim a process was kept or config
    // rebuilt — neither is knowable here and both are false for a cloud agent.
    expect(r.ok === false && r.message).toMatch(/not re-spawned|nothing was replaced/i);
    expect(r.ok === false && r.message).not.toMatch(/keeps the same process|rebuilds its config/i);
    // It must name a NEXT STEP. Asserted on the REMEDY PORTION — one of the three branches must be
    // present — rather than on the message length: the invariant prefix and suffix are ~130 chars
    // on their own, so a length check stays green with the remedy deleted entirely.
    expect(r.ok === false && r.message).toMatch(
      /clos(e|ing) and reopen|re-attach|could not be determined/i,
    );
    // This agent is LOCAL, so the local remedy is the correct one here.
    expect(r.ok === false && r.message).toMatch(/clos(e|ing) and reopen/i);
  });

  // THE THIRD BRANCH. `findKnownAgent`'s `observed` arm resolves an id this window has a live
  // status for but no roster row, and returns `runtime: "unknown"` BY DESIGN — a live status proves
  // the window is watching something, not what runtime it is. Guessing a remedy there is exactly
  // what the previous two rounds got wrong, so the copy says it could not be determined, and that
  // has to be pinned like the other two.
  it("says the remedy could not be determined when the runtime is unknown, rather than guessing", async () => {
    const agentId = "observed-only-agent";
    // No roster row — only a live status entry, which is the observed arm.
    useRuntimeStore.setState({ status: { [agentId]: "idle" } } as never);
    setPaneReady(agentId, true);
    registerPaneRestart(agentId, async () => "ready");

    const r = await restartAgent(agentId);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(/could not be determined/i);
    expect(r.ok === false && r.message).not.toMatch(/clos(e|ing) and reopen/i);
    expect(r.ok === false && r.message).not.toMatch(/re-attach/i);
  });

  // THE OTHER HALF OF THE POPULATION, and the reason the remedy is branched at all. Reopening a
  // cloud pane RE-ATTACHES to the same server-side session — AgentPane.prepare(): "the session
  // already exists there. The desktop's job is to ATTACH, not to spawn" — so telling a human to
  // close and reopen sends them back to the identical stuck screen.
  it("does NOT tell a CLOUD agent's owner to close and reopen — that re-attaches, it does not restart", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    // Flip it to the cloud runtime — `seedBuild` only makes local ones.
    useProjectStore.setState((st) => ({
      projects: st.projects.map((pr) =>
        pr.id === projectId
          ? {
              ...pr,
              agents: pr.agents.map((a) => (a.id === agentId ? { ...a, runtime: "cloud" } : a)),
            }
          : pr,
      ),
    }));
    setPaneReady(agentId, true);
    registerPaneRestart(agentId, async () => "ready");

    const r = await restartAgent(agentId);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).not.toMatch(/clos(e|ing) and reopen/i);
    expect(r.ok === false && r.message).toMatch(/re-attach|server-side/i);
  });

  it("never writes the status itself — statusEngine's real spawn transition owns that", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    registerPaneRestart(agentId, async () => {
      notePaneRelaunch(agentId);
      setPaneReady(agentId, true);
      return "ready";
    });
    useRuntimeStore.setState({ status: { [agentId]: "errored" } } as never);
    expect((await restartAgent(agentId)).ok).toBe(true);
    // Untouched on purpose. A restart that comes up and immediately re-errors must still read red,
    // and only the engine watching real output can know which it is.
    expect(useRuntimeStore.getState().status[agentId]).toBe("errored");
  });

  it("refuses an id nothing has ever seen, without acting", async () => {
    const r = await restartAgent("no-such-agent");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("unknown-agent");
  });

  it("reports no-pane — not a failure — when there is no terminal to restart", async () => {
    // Resolvable (a live status entry) but with no registered pane: nothing is wrong and nothing
    // happened, which is a different fact from an error.
    useRuntimeStore.setState({ status: { [SPARKLE_AGENT_ID]: "idle" } } as never);
    const r = await restartAgent(SPARKLE_AGENT_ID);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("no-pane");
  });

  // ── The scheduler guard — the founder's actual constraint ─────────────────────────────────────
  //
  // "I don't want you to break anything the agent is currently doing." A restart mid-pass is
  // strictly MORE disruptive than a send mid-pass: it kills the `claude` writing the shared
  // worktree. Each of these asserts the ABSENCE of the action, which is the whole point — a test
  // that only checked `reason` would pass against a guard that refused AFTER restarting.
  it("refuses to restart while the improvement pass is mid-work, and does not restart", async () => {
    const restart = mountPane(SPARKLE_AGENT_ID);
    claimPass();
    const r = await restartAgent(SPARKLE_AGENT_ID);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("agent-busy");
    expect(restart).not.toHaveBeenCalled();
  });

  it("refuses to stop while it is mid-work, and does not kill the PTY", async () => {
    mountPane(SPARKLE_AGENT_ID);
    claimPass();
    const r = await stopAgent(SPARKLE_AGENT_ID);
    expect(r.ok === false && r.reason).toBe("agent-busy");
    expect(killPty).not.toHaveBeenCalled();
  });

  it("does NOT hold an ordinary build agent while Sparkle is busy — the inverse guard", async () => {
    // The pass latch is global module state, so without the `isSparkleAgentId` scope a pass in
    // flight would freeze restart for every agent in the app.
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const restart = mountPane(agentId);
    claimPass();
    expect((await restartAgent(agentId)).ok).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

// ── THE NAME MUST LEAVE WITH THE AGENT (roborev 65334, Medium) ─────────────────────────────────────
//
// The founder's 2026-08-18 screenshot was about a receipt reading "Retired that agent." This family
// reaches the same empty sentence by a different route: `close_agent`, `discard_agent` and
// `spin_down_worker` are each argued by ID ALONE, and each REMOVES the roster row it is reporting
// on — so `conciergeReceiptClassifier`, which takes a receipt's subject from the call args, has no
// name to use, and the renderer's id→name lookup is guaranteed to miss because the agent is gone.
// The reply is the LAST place the name exists.
//
// ══ WHY THIS SUITE AND NOT THE CLASSIFIER'S ═════════════════════════════════════════════════════
// Because the classifier's cases hand-build `data: { …, agentName: "Kraken Auth" }`. That proves the
// CONSUMER reads a field its own fixture already contains, and is worth having — but it is blind to
// the producer: delete the three `agentName: found.agent.name` lines below and every one of those
// cases still passes while the founder's "Closed that agent." comes straight back. That is the
// two-halves-both-green seam AGENTS.md warns about, and the missing half is this one — a test that
// drives the REAL function and reads the name off what it actually returned.
//
// The name is captured from the store BEFORE the teardown, deliberately: reading it afterwards is
// impossible (that is the whole defect), and hard-coding a literal would stop testing the linkage
// between the row and the reply.
describe("the close family carries the torn-down agent's name in its reply", () => {
  /** The roster's own name for an agent, read while it still exists. */
  const nameOf = (id: string): string =>
    useProjectStore.getState().projects[0]!.agents.find((a) => a.id === id)!.name;

  it("closeAgent returns the name it just tore down", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: CLEAN, stage: "building_saved" });
    const expected = nameOf(id);
    const r = await closeAgent(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The row is gone, which is exactly why the reply has to carry this.
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
    expect(r.data.agentName).toBe(expected);
  });

  it("discardAgent returns the name it just destroyed", async () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: AHEAD, beadId: "bd-x" });
    const expected = nameOf(id);
    const r = await discardAgent(id, { confirm: DISCARD_CONFIRM_TOKEN, agentId: id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.agentName).toBe(expected);
  });

  it("spinDownWorkerAgent returns the name it just spun down", async () => {
    const pid = seedProject();
    const parent = seedBuild(pid, { bs: CLEAN });
    const worker = seedWorker(pid, parent, undefined, CLEAN);
    const expected = nameOf(worker);
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.agentName).toBe(expected);
  });

  // THE NAME IS THE SUBJECT'S, NOT JUST ANY NAME. With one agent on the roster a reply that returned
  // the wrong row's name — or a hard-coded constant — is indistinguishable from a correct one. Two
  // agents make the linkage assertable: closing the second must not report the first.
  it("names the agent that was torn down, not merely some agent on the roster", async () => {
    const pid = seedProject();
    const other = seedBuild(pid, { bs: CLEAN, stage: "building_saved" });
    const target = seedBuild(pid, { bs: CLEAN, stage: "building_saved" });
    const otherName = nameOf(other);
    const targetName = nameOf(target);
    expect(targetName).not.toBe(otherName);

    const r = await closeAgent(target);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.agentName).toBe(targetName);
    expect(r.data.agentName).not.toBe(otherName);
  });
});
