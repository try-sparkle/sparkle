// `retire_agent` — the concierge's unattended close. This file is its safety contract.
//
// The point of every test here is that the verb is NARROWER than `close_agent`, not wider, and that
// the two facts it acts on — the worktree and the landed state — are read LIVE rather than from the
// caches that were stale when the founder got burned on 2026-08-12.
//
// NOTHING IS INJECTED. `retireAgent` takes a `RetireDeps` with production defaults, and these tests
// deliberately never pass it: they mock at the MODULE boundary instead, so the default wiring — the
// one line that supplies the real recorder — is exercised by the suite. A seam every test overrides
// is a seam whose production call site is covered by nothing, and deleting it would leave the suite
// green while the bug came back (bead sparkle-lgbwf, seen 4×).
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../pty", () => ({ killPty: vi.fn(async () => {}) }));
vi.mock("../tasks", () => ({ createBeadFull: vi.fn(async () => "bd-new") }));

const spinDownGitMock = vi.fn(async () => {});
vi.mock("../closeAgentActions", async (orig) => ({
  ...(await orig<typeof import("../closeAgentActions")>()),
  spinDownAgentGit: (...a: unknown[]) => spinDownGitMock(...(a as [])),
}));
vi.mock("../cloudAgents/terminate", () => ({ terminateIfCloud: vi.fn(async () => {}) }));
const spinDownWorkerMock = vi.fn(async () => {});
vi.mock("../workerSpawn", async (orig) => ({
  ...(await orig<typeof import("../workerSpawn")>()),
  spinDownWorker: (...a: unknown[]) => spinDownWorkerMock(...(a as [])),
}));

// ── THE TWO LIVE READS, mocked at the Tauri boundary ────────────────────────────────────────────
// At the boundary, NOT by stubbing the reader, so these tests drive the real `readRetirementFacts` —
// including its gone-worktree arm and its fall back to the cache. `null` (the default) means "no
// live reading configured", and the mock then REJECTS, which is the shape a git failure takes. So a
// test that forgets to configure one lands on the honest `unknown` path rather than silently
// receiving a clean reading it never asked for.
let liveBranchStatus: (() => Promise<BranchStatus>) | null = null;
const agentBranchStatusMock = vi.fn(async () => {
  if (!liveBranchStatus) throw new Error("no live reading configured for this test");
  return liveBranchStatus();
});
let liveWorkflowState: (() => Promise<WorkflowState>) | null = null;
const agentWorkflowStateMock = vi.fn(async () => {
  if (!liveWorkflowState) throw new Error("no live workflow state configured for this test");
  return liveWorkflowState();
});
vi.mock("../branchStatus", async (orig) => ({
  ...(await orig<typeof import("../branchStatus")>()),
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  agentBranchStatus: (...a: unknown[]) => agentBranchStatusMock(...(a as [])),
  agentWorkflowState: (...a: unknown[]) => agentWorkflowStateMock(...(a as [])),
}));

// The durable audit write. Its RETURN VALUE is load-bearing: `false` must abort the retirement.
const recordRetirementMock = vi.fn(async () => true);
vi.mock("../deathRecordWriter", async (orig) => ({
  ...(await orig<typeof import("../deathRecordWriter")>()),
  recordAgentRetirement: (...a: unknown[]) => recordRetirementMock(...(a as [])),
}));

const recordGapMock = vi.fn(async () => true);
vi.mock("../retroReceipts", async (orig) => ({
  ...(await orig<typeof import("../retroReceipts")>()),
  recordRetroConciergeOverride: (...a: unknown[]) => recordGapMock(...(a as [])),
}));

// The retro standing source. Mocked because it reads the beads snapshot; the four arms it can
// produce are what drive the gap-receipt rule under test.
let evidence: FeedbackEvidence = { kind: "none" };
vi.mock("../feedbackEvidenceRead", () => ({
  feedbackEvidenceFor: () => evidence,
}));

import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { BranchStatus, WorkflowState } from "../branchStatus";
import type { FeedbackEvidence } from "../../engine/retroEvidence";
import type { AgentTabStatus } from "../../types";
import { useBeadsStore } from "../../stores/beadsStore";
// EPIC-COMPLETE IS THE UNIT FOR STAFFING (bead sparkle-hrzitj, failure 5) — the ledger the retire
// seam writes to, read back below as the SIDE EFFECT of retiring an epic's bound orchestrator.
import {
  epicStaffingRecords,
  resetEpicStaffingLedger,
  unstaffedEpicsFromReleases,
} from "../epicStaffing";
import { closeAgent, retireAgent } from "./lifecycle";
import { evaluateToolPolicy, NO_TOOL_POLICY_OVERRIDES } from "./policy";
import {
  onConciergeActionReceipt,
  _resetConciergeReceiptsForTests,
  type ConciergeActionReceipt,
} from "../conciergeReceipts";

const CLEAN: BranchStatus = {
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  worktreeOnBranch: true,
};
const DIRTY: BranchStatus = { ...CLEAN, dirty: true, filesChanged: 2 };
/** A SQUASH-LANDED branch: the work is in main, the tip is not an ancestor, so `ahead` stays 7. */
const LANDED_AHEAD: BranchStatus = { ...CLEAN, ahead: 7 };

const WS_LANDED = { landed: true, inOriginMain: true, inLocalMain: true } as WorkflowState;
const WS_UNLANDED = { landed: false, inOriginMain: false, inLocalMain: false } as WorkflowState;

const REASON = "Landed its work and has been idle with a met goal for an hour.";

function seedProject(): string {
  return useProjectStore.getState().addProject("Demo", "/tmp/demo");
}

/** A build agent whose CACHED reading and stage say it landed and is clean, and which reads quiet. */
function seedBuild(
  projectId: string,
  opts: { cached?: BranchStatus; status?: AgentTabStatus } = {},
): string {
  const store = useProjectStore.getState();
  const id = store.addAgent(projectId, { kind: "build" })!;
  store.setAgentWorktree(projectId, id, `/wt/${id}`, `sparkle/agent-${id}`);
  useRuntimeStore.setState((s) => ({
    branchStatus: { ...s.branchStatus, [id]: opts.cached ?? CLEAN },
    workflowStage: { ...s.workflowStage, [id]: "merged" },
    status: { ...s.status, [id]: opts.status ?? ("idle" as AgentTabStatus) },
  }));
  return id;
}

function rowExists(projectId: string, agentId: string): boolean {
  const p = useProjectStore.getState().projects.find((x) => x.id === projectId);
  return !!p?.agents.some((a) => a.id === agentId);
}

beforeEach(() => {
  // `onConciergeActionReceipt` REPLAYS retained receipts to each new subscriber (deliberately — a
  // receipt recorded while nothing was listening must not be lost). Without this reset, one test's
  // receipt is redelivered to the next test's listener and the counts below all read one too high.
  _resetConciergeReceiptsForTests();
  liveBranchStatus = () => Promise.resolve(CLEAN);
  liveWorkflowState = () => Promise.resolve(WS_LANDED);
  evidence = { kind: "reported", count: 3 };
  agentBranchStatusMock.mockClear();
  agentWorkflowStateMock.mockClear();
  recordRetirementMock.mockClear();
  recordRetirementMock.mockImplementation(async () => true);
  recordGapMock.mockClear();
  recordGapMock.mockImplementation(async () => true);
  spinDownGitMock.mockClear();
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, status: {}, openAgentIds: [] });
  useSettingsStore.setState({ maxConcurrentWorkers: 8, effectiveMaxConcurrentWorkers: 8 });
});

// ── THE HEADLINE: retire succeeds on exactly the population close_agent refuses ──────────────────
describe("retire_agent vs close_agent on a LANDED agent", () => {
  it("close_agent still refuses it — the founder's gate is untouched", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    const r = await closeAgent(id);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("needs-human-confirm");
    expect(rowExists(p, id)).toBe(true);
  });

  it("PAIRED: retire_agent retires the identical agent, and the row is gone", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(true);
    // THE SIDE EFFECT, not the verdict: the row actually left the store. Asserting only `ok: true`
    // would pass against a handler that returned success and tore nothing down.
    expect(rowExists(p, id)).toBe(false);
  });
});

// ── THE LIVE READ ────────────────────────────────────────────────────────────────────────────────
// The load-bearing pair. A test that asserted against the CACHE would pass before this change and
// prove nothing, because `previewClose` reads exactly that cache and would have agreed.
describe("retire_agent reads git LIVE, not the 30-second cache", () => {
  it("refuses when the cache says clean but the live read says dirty", async () => {
    const p = seedProject();
    const id = seedBuild(p, { cached: CLEAN });
    liveBranchStatus = () => Promise.resolve(DIRTY);
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("uncommitted-work");
    expect(rowExists(p, id)).toBe(true);
    expect(agentBranchStatusMock).toHaveBeenCalled();
  });

  it("MIRROR: retires when the cache says dirty but the live read says clean", async () => {
    const p = seedProject();
    const id = seedBuild(p, { cached: DIRTY });
    liveBranchStatus = () => Promise.resolve(CLEAN);
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(true);
    expect(rowExists(p, id)).toBe(false);
  });

  it("refuses honestly when the live read fails and no cached reading exists", async () => {
    const p = seedProject();
    const store = useProjectStore.getState();
    const id = store.addAgent(p, { kind: "build" })!;
    store.setAgentWorktree(p, id, `/wt/${id}`, `sparkle/agent-${id}`);
    useRuntimeStore.setState((s) => ({ status: { ...s.status, [id]: "idle" as AgentTabStatus } }));
    liveBranchStatus = null; // the mock rejects — a git failure
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("status-unknown");
    expect(rowExists(p, id)).toBe(true);
  });
});

// ── THE SQUASH-MERGE TRAP ────────────────────────────────────────────────────────────────────────
describe("retire_agent judges landing by reachability, never by the ahead count", () => {
  it("retires a squash-landed branch that still reads 7 ahead", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    liveBranchStatus = () => Promise.resolve(LANDED_AHEAD);
    liveWorkflowState = () => Promise.resolve(WS_LANDED);
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(true);
    expect(rowExists(p, id)).toBe(false);
  });

  it("PAIRED: refuses an unlanded branch with the IDENTICAL 7-ahead count", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    useRuntimeStore.setState((s) => ({
      workflowStage: { ...s.workflowStage, [id]: "building_saved" },
    }));
    liveBranchStatus = () => Promise.resolve(LANDED_AHEAD);
    liveWorkflowState = () => Promise.resolve(WS_UNLANDED);
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("unlanded-work");
    expect(rowExists(p, id)).toBe(true);
  });
});

// ── THE REFUSAL MUST BE RE-RUNNABLE (bead `sparkle-c68xl5`, roborev 73884) ───────────────────────
// The refusal is a sentence that asks a human to go and check with git, so it has to say WHICH ref
// it counted. Measured 2026-08-31: it named nothing, the operator checked the branch their worktree
// happened to have checked out — a no-op branch parked on main — got the opposite answer, and
// reported a correct refusal as a false positive. The row then cost a fleet slot until a human
// retired it by hand.
describe("retire_agent's unlanded-work refusal says what it measured", () => {
  it("names the resolved branch and the range it counted", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    useRuntimeStore.setState((s) => ({
      workflowStage: { ...s.workflowStage, [id]: "building_saved" },
    }));
    liveBranchStatus = () =>
      Promise.resolve({ ...CLEAN, ahead: 2, branch: "feat/renamed-away" } as BranchStatus);
    liveWorkflowState = () => Promise.resolve(WS_UNLANDED);
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok === false && r.reason).toBe("unlanded-work");
    const msg = r.ok === false ? r.message : "";
    // The resolved branch, NOT the minted `sparkle/agent-<id>` name the worktree was created with.
    expect(msg, "the refusal must name the branch it counted").toContain("feat/renamed-away");
    expect(msg).toContain("2 commits");
    // NO RANGE: the only base this layer can name is the one it HANDED Rust, not the one
    // `effective_base` counted against. See `unlandedEvidenceClause` (roborev 73959 / 73962).
    expect(msg, "a range whose base was never counted against is worse than none").not.toContain(
      "..feat/renamed-away",
    );
  });

  // ONE READING, ONE BRANCH. `WorkflowState.aheadOfBase` is folded across nested adopted worktrees
  // (Rust takes the subtree MAX) and that fold is also what clears `inOriginMain` and fires the
  // refusal — so quoting it beside the agent's OWN branch name prints a count measured somewhere
  // else, and a human re-running the range gets an empty list. That is the original false-positive
  // report, re-created with a named branch to back it, which is worse than naming nothing.
  it("does NOT quote a subtree-folded count beside this branch's name", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    useRuntimeStore.setState((s) => ({
      workflowStage: { ...s.workflowStage, [id]: "building_saved" },
    }));
    // The agent's OWN branch is 0 ahead and an ancestor of origin/main. The subtree is not: an
    // adopted nested worktree carries the one outstanding commit, which is what `unlanded` fires on.
    liveBranchStatus = () =>
      Promise.resolve({ ...CLEAN, ahead: 0, branch: "sparkle/agent-own" } as BranchStatus);
    liveWorkflowState = () =>
      Promise.resolve({ ...WS_UNLANDED, aheadOfBase: 1 } as WorkflowState);
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok === false && r.reason).toBe("unlanded-work");
    const msg = r.ok === false ? r.message : "";
    expect(msg).toContain("sparkle/agent-own");
    expect(msg, "a count from another branch must never be attributed to this one").not.toMatch(
      /\d+ commit/,
    );
  });
});

// ── THE GAP MARK ─────────────────────────────────────────────────────────────────────────────────
// A receipt has no delete path anywhere in this app, so the permanent "no retro on file" mark may be
// written from evidence of absence and NEVER from absence of evidence.
describe("retire_agent writes the retro gap mark on `absent` and on nothing else", () => {
  it("writes it when a trustworthy read of the backlog found nothing", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    evidence = { kind: "none" }; // → standing `absent`
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(true);
    expect(recordGapMock).toHaveBeenCalledTimes(1);
    const [, , fields] = recordGapMock.mock.calls[0] as unknown as [
      string,
      string,
      { reasonText: string },
    ];
    // It must name ITSELF as the author. The founder's own gap note says "Retired by the founder",
    // and a machine-written mark borrowing that sentence puts words in his mouth, permanently.
    expect(fields.reasonText).toContain("Retired by the concierge");
    expect(r.ok === true && r.data.gapReceiptWritten).toBe(true);
  });

  it("does NOT write it when the backlog was unreadable — retires without accusing", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    evidence = { kind: "unknown" };
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(true);
    expect(rowExists(p, id)).toBe(false); // it still retires
    expect(recordGapMock).not.toHaveBeenCalled(); // it just does not accuse
    expect(r.ok === true && r.data.retroStanding).toBe("unknown");
  });

  it("does NOT write it when the agent demonstrably filed feedback", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    evidence = { kind: "reported", count: 4 };
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(true);
    expect(recordGapMock).not.toHaveBeenCalled();
  });

  it("a failed gap write is NOT fatal, and the audit record says it was not written", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    evidence = { kind: "none" };
    recordGapMock.mockImplementation(async () => false);
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.data.gapReceiptWritten).toBe(false);
    const [args] = recordRetirementMock.mock.calls[0] as unknown as [
      { evidence: { gapReceiptWritten: boolean } },
    ];
    expect(args.evidence.gapReceiptWritten).toBe(false);
  });
});

// ── THE DURABLE RECORD GATES THE TEARDOWN ────────────────────────────────────────────────────────
describe("retire_agent will not destroy a row it could not record", () => {
  it("keeps the agent when the durable write fails", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    recordRetirementMock.mockImplementation(async () => false);
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(false);
    // THE SIDE EFFECT: the row survives. This runs while nobody is watching, so a teardown whose
    // record failed would remove the agent and the only explanation of why, together.
    expect(rowExists(p, id)).toBe(true);
    expect(spinDownGitMock).not.toHaveBeenCalled();
  });

  it("records BEFORE it tears down, with the reason verbatim and the live reading it acted on", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    liveBranchStatus = () => Promise.resolve(LANDED_AHEAD);
    await retireAgent(id, { reason: REASON });
    const [args] = recordRetirementMock.mock.calls[0] as unknown as [
      {
        reason: string;
        retiredBy: string;
        evidence: { worktreeRisk: string; landed: boolean | null; ahead: number | null };
      },
    ];
    expect(args.reason).toBe(REASON);
    expect(args.retiredBy).toBe("concierge");
    expect(args.evidence.worktreeRisk).toBe("clean");
    expect(args.evidence.landed).toBe(true);
    expect(args.evidence.ahead).toBe(7);
  });
});

// ── THE READABLE RECEIPT ─────────────────────────────────────────────────────────────────────────
describe("retire_agent's audit-pane receipt", () => {
  it("records a `retired` receipt carrying the reason verbatim", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    const seen: ConciergeActionReceipt[] = [];
    const off = onConciergeActionReceipt((r) => seen.push(r));
    await retireAgent(id, { reason: REASON });
    off();
    const mine = seen.filter((r) => r.op === "retire_agent");
    expect(mine).toHaveLength(1);
    const only = mine[0];
    if (!only) throw new Error("expected exactly one retirement receipt");
    // `retired`, NOT `closed` — the founder must be able to tell "I asked for this" from "the app
    // did it while I slept", which is the whole reason the kind exists.
    expect(only.kind).toBe("retired");
    expect(only.reason).toBe(REASON);
  });

  it("records NOTHING when the retirement was refused", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    liveBranchStatus = () => Promise.resolve(DIRTY);
    const seen: ConciergeActionReceipt[] = [];
    const off = onConciergeActionReceipt((r) => seen.push(r));
    await retireAgent(id, { reason: REASON });
    off();
    expect(seen.filter((r) => r.op === "retire_agent")).toHaveLength(0);
  });

  it("records NOTHING when the durable write failed — no cheerful ok:true over a surviving row", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    recordRetirementMock.mockImplementation(async () => false);
    const seen: ConciergeActionReceipt[] = [];
    const off = onConciergeActionReceipt((r) => seen.push(r));
    await retireAgent(id, { reason: REASON });
    off();
    expect(seen.filter((r) => r.op === "retire_agent")).toHaveLength(0);
    expect(rowExists(p, id)).toBe(true);
  });
});

// ── THE STALENESS RULE THE FOUNDER WAS BURNED BY ─────────────────────────────────────────────────
describe("retire_agent and a live status that cannot be read", () => {
  it("refuses when the status map has no entry — the post-restart state of a whole project", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    useRuntimeStore.setState({ status: {} });
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("activity-unknown");
    expect(rowExists(p, id)).toBe(true);
  });

  it("refuses an agent that is still working", async () => {
    const p = seedProject();
    const id = seedBuild(p, { status: "working" as AgentTabStatus });
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("agent-busy");
  });

  it("refuses an agent holding a question open", async () => {
    const p = seedProject();
    const id = seedBuild(p, { status: "waiting" as AgentTabStatus });
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok === false && r.reason).toBe("agent-busy");
  });

  it("a deadClaim backed only by a stale tier is refused, and nothing is torn down", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    const r = await retireAgent(id, {
      reason: "Quota-walled and not coming back.",
      deadClaim: {
        evidence: "Claude usage limit reached.",
        observedAt: Date.now(),
        source: "attentionScreen",
      },
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("stale-evidence");
    expect(rowExists(p, id)).toBe(true);
  });

  it("PAIRED: the same claim on a fresh live scrollback read retires", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    const r = await retireAgent(id, {
      reason: "Quota-walled and not coming back.",
      deadClaim: {
        evidence: "Claude usage limit reached.",
        observedAt: Date.now(),
        source: "scrollback",
      },
    });
    expect(r.ok).toBe(true);
    const [args] = recordRetirementMock.mock.calls[0] as unknown as [
      { evidence: { terminalEvidence: string | null } },
    ];
    // The excerpt is kept VERBATIM, because the founder checks the claim against what was on screen.
    expect(args.evidence.terminalEvidence).toBe("Claude usage limit reached.");
  });
});

describe("retire_agent — kinds", () => {
  it("refuses a shell agent", async () => {
    const p = seedProject();
    const id = useProjectStore.getState().addAgent(p, { kind: "shell" })!;
    const r = await retireAgent(id, { reason: REASON });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("not-retirable-kind");
  });

  it("refuses a blank reason before it reads anything", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    const r = await retireAgent(id, { reason: "  " });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("reason-required");
    expect(recordRetirementMock).not.toHaveBeenCalled();
  });
});

// ── THE POLICY TIER ──────────────────────────────────────────────────────────────────────────────
describe("policy", () => {
  it("auto-allows retire_agent", () => {
    const d = evaluateToolPolicy("retire_agent", { overrides: NO_TOOL_POLICY_OVERRIDES });
    expect(d.decision).toBe("allow");
  });

  it("REGRESSION GUARD: close_agent still asks", () => {
    // The whole design rests on the narrow verb being the only thing that got looser. If this ever
    // flips to `allow`, the concierge has regained the unattended power to stop work in flight.
    const d = evaluateToolPolicy("close_agent", { overrides: NO_TOOL_POLICY_OVERRIDES });
    expect(d.decision).toBe("ask");
  });
});

// ── EPIC-COMPLETE IS THE UNIT FOR STAFFING (bead `sparkle-hrzitj`, failure 5) ────────────────────
// "Retiring an agent whose single goal was met silently unstaffed epics with 57, 39 and 3 open
// children. Nothing noticed until the pusher escalated them to the founder as 'Blocked'."
//
// Every case asserts the RECORD — the thing whose absence was the bug — and never that the
// retirement was refused, which it must not be. Note what the first case also pins for free: the
// row is GONE by the time it reads the ledger, so a reading taken after the teardown could only
// have answered `not-bound`. The ordering of the call is therefore load-bearing and asserted.
describe("retire_agent records the epic it leaves unstaffed", () => {
  /** This project's board: one epic, two open children and one closed. */
  const seedEpicBoard = (projectId: string): void => {
    useBeadsStore.setState({
      byProject: {
        [projectId]: {
          beads: [
            { id: "e1", title: "Ship it", description: "", status: "open", type: "epic", labels: [], parent: null, commentCount: 0 },
            { id: "e1.1", title: "one", description: "", status: "open", labels: [], parent: "e1", commentCount: 0 },
            { id: "e1.2", title: "two", description: "", status: "in_progress", labels: [], parent: "e1", commentCount: 0 },
            { id: "e1.3", title: "three", description: "", status: "closed", labels: [], parent: "e1", commentCount: 0 },
          ],
          board: { columns: [] },
        },
      },
    } as never);
  };

  beforeEach(() => {
    resetEpicStaffingLedger();
    useBeadsStore.setState({ byProject: {} } as never);
  });

  it("THE MEASURED FAILURE: the epic is recorded UNSTAFFED, with its open-child count", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    useProjectStore.getState().setAgentEpicId(p, id, "e1");
    seedEpicBoard(p);

    const r = await retireAgent(id, { reason: REASON });

    // The retirement still happens — the agent did finish its goal.
    expect(r.ok).toBe(true);
    expect(rowExists(p, id)).toBe(false);
    // …and the epic no longer goes quiet with it. TWO open children, not three.
    expect(unstaffedEpicsFromReleases()).toEqual({
      epicIds: ["e1"],
      couldNotTellEpicIds: [],
      count: 1,
    });
    expect(epicStaffingRecords()[0]?.openChildren).toBe(2);
    expect(epicStaffingRecords()[0]?.cause).toBe("retired");
  });

  it("FAILS CLOSED: an unread board records COULD-NOT-TELL rather than nothing", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    useProjectStore.getState().setAgentEpicId(p, id, "e1");
    // No board seeded — an absent snapshot is not an empty epic.

    const r = await retireAgent(id, { reason: REASON });

    expect(r.ok).toBe(true);
    expect(unstaffedEpicsFromReleases()).toEqual({
      epicIds: [],
      couldNotTellEpicIds: ["e1"],
      count: 1,
    });
  });

  it("A REFUSED retirement records nothing — the agent is still on its epic", async () => {
    const p = seedProject();
    const id = seedBuild(p, { cached: CLEAN });
    useProjectStore.getState().setAgentEpicId(p, id, "e1");
    seedEpicBoard(p);
    liveBranchStatus = () => Promise.resolve(DIRTY);

    const r = await retireAgent(id, { reason: REASON });

    expect(r.ok).toBe(false);
    expect(rowExists(p, id)).toBe(true);
    expect(unstaffedEpicsFromReleases().count).toBe(0);
  });

  it("an agent bound to NO epic records nothing", async () => {
    const p = seedProject();
    const id = seedBuild(p);
    seedEpicBoard(p);

    expect((await retireAgent(id, { reason: REASON })).ok).toBe(true);
    expect(unstaffedEpicsFromReleases().count).toBe(0);
  });
});
