// The concierge's AGENT LIFECYCLE domain. These tests are the safety contract: the destructive
// operation (discard) must be unreachable without an explicit intent, every operation must be
// classified, and a spawn must refuse rather than overrun the machine's RAM budget or quietly bill
// the user for a cloud sandbox.
import { describe, it, expect, beforeEach, vi } from "vitest";

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
// The real spawn body runs by default (these tests assert the human path's exact sequence); a test
// that needs the "project vanished mid-spawn" branch sets `spawnOverride`.
let spawnOverride: (() => string | null) | null = null;
vi.mock("../buildAgentSpawn", async (orig) => {
  const real = await orig<typeof import("../buildAgentSpawn")>();
  return {
    ...real,
    spawnBuildAgentInProject: (project: Parameters<typeof real.spawnBuildAgentInProject>[0]) =>
      spawnOverride ? spawnOverride() : real.spawnBuildAgentInProject(project),
  };
});

import { useAuthStore } from "../../stores/authStore";
import { useCloudAuthStore } from "../../stores/cloudAuthStore";
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { shouldPromptOnClose } from "../../engine/closeAgent";
import type { BranchStatus } from "../branchStatus";
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
  type LifecycleOp,
  type LifecycleRisk,
} from "./lifecycle";

const CLEAN: BranchStatus = {
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  worktreeOnBranch: true,
};
const AHEAD: BranchStatus = { ...CLEAN, ahead: 3 };
const DIRTY: BranchStatus = { ...CLEAN, dirty: true, filesChanged: 2 };

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

function seedWorker(projectId: string, parentId: string, beadId?: string): string {
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
  return id;
}

function seedShell(projectId: string): string {
  return useProjectStore.getState().addAgent(projectId, { kind: "shell" })!;
}

beforeEach(() => {
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
  // haven't opened yet, and each one starts as soon as you do". They are ALREADY RUNNING —
  // closed-tab projects were observed with a running-agent count equal to their full roster — so
  // the sentence sent a human hunting for processes that would start later when they were already
  // up. `live` measures "has a mounted pane in THIS window", and the copy may not claim more.
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
    // The retracted claims, both directions: they have not "not started", and opening a tab is not
    // what starts them.
    expect(r.message).not.toMatch(/haven't opened yet/i);
    expect(r.message).not.toMatch(/starts as soon as you do/i);
    expect(r.message).toMatch(/already running/i);
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

  it("refuses (typed) when the project vanishes mid-spawn — nothing was created", async () => {
    const pid = seedProject();
    spawnOverride = () => null; // spawnBuildAgentInProject's "project closed in another window" branch
    const r = await spawnBuildAgent({ projectId: pid });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.op).toBe("spawn_build_agent");
    expect(r.reason).toBe("action-failed");
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
  it("reports a SILENT close for a build agent whose work is merged", () => {
    const pid = seedProject();
    const id = seedBuild(pid, { bs: CLEAN, stage: "merged" });
    const r = previewClose(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.wouldPrompt).toBe(false);
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
    const id = seedBuild(pid, { bs: CLEAN, stage: "merged" });
    const r = await closeAgent(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(spinDownGitMock).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [id], deleteBranch: false }),
    );
    expect(discardGitMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
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
    const worker = seedWorker(pid, build);
    const r = await closeAgent(worker);
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
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
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
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
    const worker = seedWorker(pid, build);
    const r = await spinDownWorkerAgent(worker);
    expect(r.ok).toBe(true);
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId: pid, workerId: worker });
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
