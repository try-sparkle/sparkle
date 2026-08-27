// @vitest-environment jsdom
//
// The runner that SPENDS MONEY on engine/goalContinuation's decision.
//
// Every test here asserts a SIDE EFFECT — text that reached the terminal, a counter the store
// advanced, a banner the human got — never that a decision object was produced. The engine is
// already tested as arithmetic; what is untested until here is whether the mount gathers real
// evidence and acts on it exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { burstsOf, progressMark } from "../engine/goalContinuation";
import { MAX_CONCIERGE_REARMS } from "../engine/agentGoal";
import {
  noteHooksLive,
  resetTurnEndAuthority,
  trackAgent,
} from "../engine/turnEndAuthority";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { AgentTabStatus } from "../types";

// The write path, stubbed at the ONE seam the runner uses. `importOriginal` keeps
// `agentCanAcceptInput` real, because that gate is part of what is under test — a stub would let a
// send through for an agent the app would have refused.
vi.mock("./conciergeDispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./conciergeDispatch")>();
  return {
    ...actual,
    // THE STUB HONOURS THE `userPrompt` CONTRACT, and that is what makes the escalation test below
    // mean anything. The real `dispatchConciergeAnswer` calls `recordPromptSideEffects` — and so
    // `appendPrompt` — only when `userPrompt` is true; `promptHistory.length` is one third of the
    // progress mark. A stub that ignored the flag (the previous one did) left every assertion about
    // the mark testing the stub's silence rather than the runner's behaviour: flipping the runner to
    // `userPrompt: true` could not fail any of them.
    dispatchConciergeAnswer: vi.fn(
      async (
        agentId: string,
        text: string,
        opts?: { userPrompt?: boolean; authority?: { kind: string } },
      ) => {
        if (opts?.userPrompt) {
          const store = useProjectStore.getState();
          const project = store.projects.find((p) => p.agents.some((a) => a.id === agentId));
          if (project) store.appendPrompt(project.id, agentId, text);
        }
        return {
          ok: true,
          path: "free-text" as const,
          agentId,
          sent: text,
          display: text,
        };
      },
    ),
  };
});

// The "this agent needs you" path. Stubbed because it invokes Tauri; kept as a spy because
// "the human found out" is one of the side effects under test.
vi.mock("./attention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attention")>();
  return { ...actual, notifyAttention: vi.fn() };
});

import { notifyAttention } from "./attention";
import { resetWindowRegistry, setWindowProject } from "./windowRegistry";
import { dispatchConciergeAnswer } from "./conciergeDispatch";
import { EXTERNAL_WAIT_GRACE_MS } from "../engine/goalContinuation";
import {
  _resetGoalContinuationRunnerForTests,
  idleSinceFor,
  MAX_UNDELIVERED_CONTINUES,
  ownsProjectInThisWindow,
  processAliveFor,
  sweepGoalContinuations,
  trackIdleSince,
  undeliveredStreakFor,
  continuationEvidenceFor,
  externalWaitOf,
  externalWaitSinceFor,
  noteExternalWait,
  noteToolActivity,
  prMarkOf,
} from "./goalContinuationRunner";

const sendMock = vi.mocked(dispatchConciergeAnswer);
const notifyMock = vi.mocked(notifyAttention);

/** Every project belongs to this window in these tests; the ownership election has its own. */
const ownsEverything = () => true;

const T0 = 1_000_000;
/** Comfortably past IDLE_SETTLE_MS (45s). */
const SETTLED = T0 + 46_000;

function seed(opts: {
  status?: AgentTabStatus;
  /** Set to put the agent in the `unmerged` band (committed, unlanded work). */
  stage?: "building_saved";
  goal?: string;
  /** Grant turn-end authority (a live hook stream). Default true. */
  authority?: boolean;
  /** Which runtime the agent tab claims. Default local. */
  runtime?: "local" | "cloud";
  /** Put the agent in `openAgentIds`. Default true. */
  open?: boolean;
}): { projectId: string; agentId: string; agentName: string } {
  const store = useProjectStore.getState();
  const projectId = store.addProject("Demo", "/tmp/demo");
  const agentId = useProjectStore
    .getState()
    .addAgent(projectId, { kind: "build", ...(opts.runtime ? { runtime: opts.runtime } : {}) })!;
  if (opts.goal !== undefined) {
    useProjectStore.getState().setAgentGoal(projectId, agentId, opts.goal);
  }
  const status = opts.status ?? "idle";
  useRuntimeStore.setState({
    status: { [agentId]: status },
    openAgentIds: opts.open === false ? [] : [agentId],
    ...(opts.stage ? { workflowStage: { [agentId]: opts.stage } } : {}),
  } as never);
  if (opts.authority !== false) {
    trackAgent(agentId, "test-engine");
    noteHooksLive(agentId);
  }
  const agentName = useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)!
    .agents.find((a) => a.id === agentId)!.name;
  return { projectId, agentId, agentName };
}

function goalOf(projectId: string, agentId: string) {
  return useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)!
    .agents.find((a) => a.id === agentId)!.goal;
}

/** The mark the runner will compute for a freshly seeded agent (no prompts, no activity, no title). */
const FRESH_MARK = progressMark({ promptHistoryLength: 0 });

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    branchStatus: {},
    workflowStage: {},
    // Both are read by the progress mark and the external-gate evidence. Leaving them out of the
    // reset would let one test's PR or tool count decide another's escalation.
    workflowState: {},
    agentMovement: {},
  } as never);
  resetTurnEndAuthority();
  _resetGoalContinuationRunnerForTests();
  sendMock.mockClear();
  notifyMock.mockClear();
});

describe("trackIdleSince", () => {
  it("keeps the ORIGINAL stamp while a row stays resting", () => {
    const first = trackIdleSince(new Map(), new Map([["a", "idle" as AgentTabStatus]]), 100);
    const second = trackIdleSince(first, new Map([["a", "idle" as AgentTabStatus]]), 900);
    expect(second.get("a")).toBe(100);
  });

  it("drops the stamp when the row leaves the resting band, so the next rest starts fresh", () => {
    const first = trackIdleSince(new Map(), new Map([["a", "idle" as AgentTabStatus]]), 100);
    const working = trackIdleSince(first, new Map([["a", "working" as AgentTabStatus]]), 500);
    expect(working.has("a")).toBe(false);
    const again = trackIdleSince(working, new Map([["a", "idle" as AgentTabStatus]]), 900);
    expect(again.get("a")).toBe(900);
  });

  it("clocks the `unmerged` band — the motivating case", () => {
    const m = trackIdleSince(new Map(), new Map([["a", "unmerged" as AgentTabStatus]]), 100);
    expect(m.get("a")).toBe(100);
  });
});

describe("processAliveFor", () => {
  it("is UNDEFINED for an agent this window never observed — absence is not evidence", () => {
    // Not `false`. Both refuse the continue identically, but they produce different SENTENCES:
    // `decideContinuation` reports `process-gone` only for an observed death and `liveness-unknown`
    // for absent evidence, and that reason is what the concierge reads out to a human. "Its process
    // is gone" about an agent nobody looked at would send them to close a tab whose agent is running
    // (roborev 55298).
    expect(processAliveFor("a", {}, new Set(["a"]))).toBeUndefined();
  });

  it("is false for an observed but EXITED process", () => {
    expect(processAliveFor("a", { a: "done" }, new Set(["a"]))).toBe(false);
    expect(processAliveFor("a", { a: "stopped" }, new Set(["a"]))).toBe(false);
    expect(processAliveFor("a", { a: "errored" }, new Set(["a"]))).toBe(false);
  });

  it("is true for an observed, still-running process", () => {
    expect(processAliveFor("a", { a: "idle" }, new Set(["a"]))).toBe(true);
  });
});

describe("the happy continue", () => {
  it("types the goal into the terminal and records the retry against the SAME mark", async () => {
    const { projectId, agentId } = seed({ goal: "land the PR" });

    // Sweep 1 starts the idle clock; nothing is eligible yet.
    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    expect(sendMock).not.toHaveBeenCalled();

    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    // THE SEND HAPPENED, with text that carries the goal and can stand alone.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [sentAgentId, sentText, sentOpts] = sendMock.mock.calls[0]!;
    expect(sentAgentId).toBe(agentId);
    expect(sentText).toContain("land the PR");
    expect(sentText).toContain("your goal is not met");
    // NOT a user prompt: it must not be metered, must not enter promptHistory (which is one third
    // of the progress mark), and must not feed auto-naming.
    expect(sentOpts.userPrompt).toBe(false);
    expect(sentOpts.authority).toEqual({ kind: "goal-continue", agentId });

    // THE RETRY WAS RECORDED, against the mark the decision was made on.
    const goal = goalOf(projectId, agentId)!;
    expect(goal.continues).toBe(1);
    expect(goal.totalContinues).toBe(1);
    expect(goal.mark).toBe(FRESH_MARK);
    expect(goal.escalatedAt).toBeUndefined();
  });

  it("continues an `unmerged` agent whose process is alive", async () => {
    // Committed-but-unlanded work overlays `unmerged` onto the resting `idle` row.
    const { projectId, agentId } = seed({ goal: "merge it", stage: "building_saved" });

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(1);
  });
});

describe("the gates the runner must never send through", () => {
  it("does NOT send to a dead agent wearing the `unmerged` overlay", async () => {
    // `done` is a RESTING status, so withUnmergedWork relabels it `unmerged` exactly as it does a
    // live idle row — and `canAcceptInput` (a local agent) and turn-end authority both pass. Only
    // `processAlive` separates the two, which is why this is the case that matters.
    seed({ goal: "merge it", stage: "building_saved", status: "done" });

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    const outcomes = await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    expect(sendMock).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ action: "none", detail: "process-gone" });
  });

  it("does NOT send when nothing witnessed the turn ending", async () => {
    // No hook stream, no spinner: `idle` here means "quiet", which is equally consistent with a
    // six-minute test run. Typing now would land mid-tool-call.
    const { projectId, agentId } = seed({ goal: "keep building", authority: false });

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    expect(sendMock).not.toHaveBeenCalled();
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(0);
  });

  it("does NOT send before the idle has settled", async () => {
    seed({ goal: "keep building" });
    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    // 44s — one second short of the settle window.
    await sweepGoalContinuations({ now: T0 + 44_000, ownsProject: ownsEverything });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does NOT send to a project another window owns", async () => {
    seed({ goal: "land the PR" });
    await sweepGoalContinuations({ now: T0, ownsProject: () => false });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: () => false });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("one send per turn", () => {
  it("does not send twice for the same turn across consecutive sweeps", async () => {
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });
    expect(sendMock).toHaveBeenCalledTimes(1);

    // The agent has not gone `working` yet — the spinner takes a moment — so the row is STILL idle
    // and STILL past the original 45s threshold. Nothing but the re-armed clock stops a second send.
    await sweepGoalContinuations({ now: SETTLED + 15_000, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED + 30_000, ownsProject: ownsEverything });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(1);
    // The clock was re-armed to the moment of the send, not left at the original rest.
    expect(idleSinceFor(agentId)).toBe(SETTLED);
  });

  it("sends again only once the NEW turn has itself gone quiet for a full settle window", async () => {
    seed({ goal: "land the PR" });
    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED + 46_000, ownsProject: ownsEverything });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("does not record a retry when the send never reached the terminal", async () => {
    sendMock.mockImplementationOnce(async (agentId: string) => ({
      ok: false as const,
      path: "pty-gone" as const,
      agentId,
    }));
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    expect(sendMock).toHaveBeenCalledTimes(1);
    // A retry the agent never received must not count toward the escalation bound — otherwise the
    // human is eventually told "restarting cannot fix this" about an agent nobody restarted.
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(0);
    // ...but the failure still backs off, rather than re-firing on every 15s sweep.
    expect(idleSinceFor(agentId)).toBe(SETTLED);
  });
});

describe("escalation", () => {
  /** Spend the consecutive-retry budget without moving the mark. */
  function burnRetries(projectId: string, agentId: string, times: number): void {
    for (let i = 0; i < times; i++) {
      useProjectStore.getState().noteAgentGoalContinue(projectId, agentId, FRESH_MARK);
    }
  }

  it("escalates after REAL sends — the resume must not count as its own progress", async () => {
    // THE SIDE EFFECT, not the precondition. `burnRetries` hand-writes FRESH_MARK, so every other
    // test in this block ASSUMES the thing that actually matters: that a real auto-continue leaves
    // the progress mark where it was. Nothing proved it. If the resume were dispatched as a user
    // prompt it would enter `promptHistory`, `promptHistoryLength` would tick on every attempt, the
    // mark would move, `consecutive` would reset forever and this escalation could NEVER fire —
    // the bound would be vacuous and a permanently-stuck agent would be restarted without limit.
    //
    // This is the stall-side half of engine/agentOriginated's rule: Sparkle's own resume is not
    // evidence the agent is progressing, exactly as (on the thrash side) it is not evidence the
    // agent is looping. One definition, both directions.
    const { projectId, agentId } = seed({ goal: "land the PR" });

    // Drive real sweeps: each settled sweep sends, and re-arms the idle clock behind it.
    let now = T0;
    for (let i = 0; i < 3; i++) {
      await sweepGoalContinuations({ now, ownsProject: ownsEverything });
      now += 46_000;
      await sweepGoalContinuations({ now, ownsProject: ownsEverything });
      now += 46_000;
    }
    expect(sendMock).toHaveBeenCalledTimes(3);

    // The mark never moved across three genuine sends — which is the whole claim.
    expect(goalOf(projectId, agentId)!.mark).toBe(FRESH_MARK);
    expect(goalOf(projectId, agentId)!.continues).toBe(3);

    // So the bound is reachable, and the human is told.
    await sweepGoalContinuations({ now, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: now + 46_000, ownsProject: ownsEverything });
    expect(sendMock).toHaveBeenCalledTimes(3); // no fourth restart
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeDefined();
  });

  it("hands the agent to the human — latched on the goal AND announced", async () => {
    const { projectId, agentId, agentName } = seed({ goal: "land the PR" });
    burnRetries(projectId, agentId, 3);

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    // NOT sent to — escalation replaces the restart, it does not accompany it.
    expect(sendMock).not.toHaveBeenCalled();

    // The human actually finds out, through the app's own attention path.
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const notice = notifyMock.mock.calls[0]![0];
    expect(notice).toMatchObject({ projectId, agentId });
    expect(notice.title).toContain(agentName);
    expect(notice.body).toContain("land the PR");
    // WHICH WORDING, AND WHY IT IS THE BLIND ONE (bead `sparkle-gazo4a`). This seed supplies no
    // fleet digest, no branch status and no PR reading, so the mark's three WORK-EVIDENCE columns
    // are all empty and `goalContinuation.workEvidenceReadable` reports the streak as unobserved.
    // The escalation still FIRES — which is this test's actual claim, asserted on either side of
    // this line — but it may not say "no sign of progress", because that is a finding about the
    // agent and nothing was read. A seed that supplied any one reading gets the ordinary sentence;
    // `engine/goalContinuation.falseAbsence.test.ts` pins both directions.
    expect(notice.body).toContain("whether it advanced is unknown, not settled");

    // And it is recorded on the goal, which is what stops the retrying.
    const goal = goalOf(projectId, agentId)!;
    expect(goal.escalatedAt).toBeDefined();
    expect(goal.escalationReason).toContain("land the PR");

    // ⚠️ AND IT IS NOT AN ABANDONMENT. `escalateToHuman` takes a `via` variant defaulting to
    // "escalate", and `abandonGoal` writes THROUGH `escalateGoal` — so both variants set
    // `escalatedAt`/`escalationReason` identically and the ONLY observable difference is this field,
    // which `engine/agentStall` turns into the RED `abandoned-goal` cause. Until this assertion
    // existed, flipping that default (or a future caller passing the wrong variant) left the whole
    // suite green while every ordinary give-up painted its row red as work nobody landed — the exact
    // inverse of the bug the variant was added to fix, and the "defaulted seam every test injects"
    // shape from AGENTS.md. An ordinary give-up says auto-continue stopped; it asserts NOTHING about
    // where the branch's work ended up.
    expect(goal.abandonedAt).toBeUndefined();
    expect(goal.abandonedEvidence).toBeUndefined();

    // ⚠️ THE VALUE, NOT THE PRESENCE. Every other assertion on `escalatedAt` in this file is
    // `toBeDefined()`, which cannot fail when the instant is dropped — and it WAS dropped, all the
    // way to `escalateAgentGoal`, while comments upstream claimed the clock was threaded. The sweep
    // judged at SETTLED, so that is what the latch must carry.
    expect(goal.escalatedAt).toBe(SETTLED);
  });

  it("fires ONCE — a later sweep neither re-announces nor restarts", async () => {
    const { projectId, agentId } = seed({ goal: "land the PR" });
    burnRetries(projectId, agentId, 3);

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });
    const firstReason = goalOf(projectId, agentId)!.escalationReason;

    await sweepGoalContinuations({ now: SETTLED + 60_000, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED + 120_000, ownsProject: ownsEverything });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
    // The FIRST reason survives — the human reads why it originally gave up.
    expect(goalOf(projectId, agentId)!.escalationReason).toBe(firstReason);
  });

  it("does not escalate an agent the gates would have refused anyway", async () => {
    // Same spent budget, but nothing witnessed the turn ending. Escalation is a real human cost and
    // must only fire on an agent we would genuinely otherwise have restarted.
    const { projectId, agentId } = seed({ goal: "land the PR", authority: false });
    burnRetries(projectId, agentId, 3);

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    expect(notifyMock).not.toHaveBeenCalled();
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeUndefined();
  });
});

describe("agents with no goal", () => {
  it("are never touched", async () => {
    seed({});
    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    const outcomes = await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });
    expect(sendMock).not.toHaveBeenCalled();
    // Not even reported on — a goalless agent is not this sweep's business.
    expect(outcomes).toHaveLength(0);
  });
});

// ── THE SINGLE-OWNER ELECTION ITSELF ────────────────────────────────────────────────────────────
//
// Every test above injects `ownsProject`, so the real predicate — including `currentWindowLabel()`'s
// `__TAURI_INTERNALS__` walk and the `isMain` derivation — had NO coverage, while <GoalContinuation/>
// is mounted app-wide in EVERY window. A wrong label (a metadata shape change, a satellite label
// mismatch) makes both windows answer true and double-sends an irreversible PTY write to the same
// agent, and nothing would have noticed (roborev 55423/55434).
describe("ownsProjectInThisWindow — the thing standing between this and a double send", () => {
  const asWindow = (label: string | undefined) => {
    const w = globalThis as unknown as Record<string, unknown>;
    if (label === undefined) delete w.__TAURI_INTERNALS__;
    else w.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label } } };
  };

  beforeEach(() => {
    resetWindowRegistry();
    asWindow(undefined);
  });
  afterEach(() => {
    resetWindowRegistry();
    asWindow(undefined);
  });

  it("MAIN adopts a project no window has claimed", () => {
    asWindow("main");
    expect(ownsProjectInThisWindow("p1")).toBe(true);
  });

  it("a SATELLITE does not adopt an unclaimed project — only main does", () => {
    // Otherwise every torn-off window would answer true for anything unowned, which is precisely the
    // both-windows-send case.
    asWindow("satellite-7");
    expect(ownsProjectInThisWindow("p1")).toBe(false);
  });

  it("EXACTLY ONE window owns a claimed project", () => {
    setWindowProject("satellite-7", "p1");
    asWindow("satellite-7");
    expect(ownsProjectInThisWindow("p1")).toBe(true);
    asWindow("main");
    expect(ownsProjectInThisWindow("p1")).toBe(false);
  });

  it("falls back to MAIN when the Tauri metadata is absent or the wrong shape", () => {
    // A metadata shape change must not make a satellite believe it is main — but with no Tauri at all
    // (tests, a plain browser) the label has to resolve to something, and `main` is the only label
    // that can legitimately adopt an unowned project.
    asWindow(undefined);
    expect(ownsProjectInThisWindow("p1")).toBe(true);
    (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { metadata: {} };
    expect(ownsProjectInThisWindow("p1")).toBe(true);
  });

  it("a claimed project is owned by NEITHER window when the owner is a third label", () => {
    // The case that actually stops a double send: two live windows, neither of them the registry's
    // owner, both must decline.
    setWindowProject("satellite-9", "p1");
    asWindow("main");
    expect(ownsProjectInThisWindow("p1")).toBe(false);
    asWindow("satellite-7");
    expect(ownsProjectInThisWindow("p1")).toBe(false);
  });
});

describe("an auto-continue that never REACHES the terminal", () => {
  // `mockImplementation` outlives a `mockClear`, and the shared `beforeEach` only clears. Without
  // this, a refusing stub would leak into whatever describe is appended after this one — the kind of
  // cross-test coupling that shows up as an unrelated failure days later. Vitest 2's `mockReset`
  // restores the implementation `vi.fn(impl)` was constructed with, which is the module stub.
  afterEach(() => {
    sendMock.mockReset();
  });

  /** Always refuse, on `path`. The whole point is a condition that does not clear by itself. */
  function alwaysRefuse(path: string): void {
    sendMock.mockImplementation(async (agentId: string) => ({
      ok: false as const,
      path: path as never,
      agentId,
    }));
  }

  /**
   * Drive `n` eligible sweeps. Each send re-arms the idle clock, so the next one has to be a full
   * settle window later — sweeping at a fixed `now` would produce exactly one send however many
   * times it was called, and every count below would be testing the harness.
   */
  async function sweepUntilEligible(n: number): Promise<void> {
    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    for (let i = 0; i < n; i++) {
      await sweepGoalContinuations({ now: SETTLED + i * 46_000, ownsProject: ownsEverything });
    }
  }

  it("stops retrying and tells the human after three refusals in a row", async () => {
    alwaysRefuse("alternate-screen");
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    expect(sendMock).toHaveBeenCalledTimes(MAX_UNDELIVERED_CONTINUES);
    // The latch is what actually stops the loop: without it the refusal repeats every settle window
    // for as long as the pane stays in the full-screen app — observed in the field as hours of it.
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeDefined();
    expect(notifyMock).toHaveBeenCalledTimes(1);

    // ...and a fourth eligible window sends nothing, because the goal is now escalated.
    await sweepGoalContinuations({
      now: SETTLED + MAX_UNDELIVERED_CONTINUES * 46_000,
      ownsProject: ownsEverything,
    });
    expect(sendMock).toHaveBeenCalledTimes(MAX_UNDELIVERED_CONTINUES);
  });

  it("NO-MENU alternate screen: says a pager/editor is holding it and quitting is safe, never that a dialog is waiting", async () => {
    // `alwaysRefuse` sets no `liveMenuLabels`, which is the `blind:'no-menu'` case — a pager or
    // editor holds the alternate buffer and there is NO question on the screen. Measured: four agents
    // in one morning, every one a no-menu pager, all told "usually a permission dialog or menu
    // waiting on an answer" — sending the founder to open a pane and hunt for a menu that was not
    // there (bead sparkle-j2gase).
    alwaysRefuse("alternate-screen");
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    const reason = goalOf(projectId, agentId)!.escalationReason!;
    expect(reason).toContain("full-screen mode");
    expect(reason).toContain("land the PR");
    // ── AND IT MUST NOT NAME AN APP IT HAS NO EVIDENCE OF (bead sparkle-saoe3) ────────────────
    // "a pager or editor" is a category, not a claim about WHICH one — naming vim/less/htop as fact
    // is still unwarranted and sent the founder hunting for an app to quit.
    expect(reason).not.toContain("vim");
    expect(reason).not.toContain("htop");
    // THE OLD, WRONG DIAGNOSIS for this state. There is no menu and no question, so "a permission
    // dialog or menu waiting on an answer" is exactly the sentence that cost the four trips, and
    // "answer what is on screen" is a dead instruction when nothing is on screen to answer.
    expect(reason).not.toMatch(/permission dialog or menu/i);
    expect(reason).not.toMatch(/answer what is on screen/i);
    // THE TRUE REMEDY: quitting the pager/editor is safe and loses nothing. This is the assertion the
    // change exists for.
    expect(reason).toMatch(/pager or editor is holding the screen/i);
    expect(reason).toMatch(/quitting it is safe/i);
    expect(reason).toMatch(/will not lose the turn/i);
    // The diagnosis the progress bound gives is WRONG here — nothing was ever typed, so there is no
    // "restarting" that failed.
    expect(reason).not.toContain("restarting cannot fix");
    expect(reason).toContain("Nothing was typed into the terminal");
    // The banner the human actually reads carries the same sentence, not a second one that drifts.
    expect(notifyMock.mock.calls[0]![0].body).toBe(reason);
  });

  it("MENU-present alternate screen: names the waiting dialog and its options, never the pager remedy", async () => {
    // The OTHER state on the SAME path: an unrecognised alternate-screen app that IS showing
    // something menu-shaped — a pager displaying a transcript, most often. Here there IS something
    // on screen to name, so telling the human to "quit the pager" would be the wrong remedy and the
    // no-menu copy's "quitting is safe" would be advice against a decision that may be live.
    //
    // (This used to read "a Claude Code permission dialog reached by a free-text send", which was
    // true when it was written. That screen is now classified as `blocked-prompt` — bead
    // sparkle-d6a5r — and its own menu-present row is below. Keeping the stale premise here would
    // leave the file claiming the dialog case is covered by a row that can no longer see it.)
    sendMock.mockImplementation(async (agentId: string) => ({
      ok: false as const,
      path: "alternate-screen" as const,
      agentId,
      liveMenuLabels: ["Yes", "No, and tell Claude what to do differently"],
    }));
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    const reason = goalOf(projectId, agentId)!.escalationReason!;
    // Names the dialog AND the specific options, so the human knows what is being asked without
    // opening the pane to find out.
    expect(reason).toMatch(/dialog waiting for your answer/i);
    expect(reason).toContain('"Yes"');
    expect(reason).toContain('"No, and tell Claude what to do differently"');
    // MUST NOT give the no-menu remedy here — quitting a live permission dialog is the unsafe thing.
    expect(reason).not.toMatch(/quitting it is safe/i);
    expect(reason).not.toMatch(/pager or editor/i);
    expect(reason).toContain("Nothing was typed into the terminal");
    expect(notifyMock.mock.calls[0]![0].body).toBe(reason);
  });

  it("keys the remedy off the path — a dead PTY does not get the full-screen advice", async () => {
    alwaysRefuse("pty-gone");
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    const reason = goalOf(projectId, agentId)!.escalationReason!;
    expect(reason).toContain("its process is gone");
    expect(reason).not.toContain("full-screen");
  });

  it("does not send the RESTART remedy for an agent that never started", async () => {
    // `agent-failed` and `pty-gone` shared an arm, so this said "its process is gone. Restart the
    // agent" about an agent whose process never ran. ConciergeHost's refusal copy for the same
    // path already says the true remedy — open the pane and hit Retry — so the two surfaces
    // contradicted each other on the one sentence a stuck user acts on.
    alwaysRefuse("agent-failed");
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    const reason = goalOf(projectId, agentId)!.escalationReason!;
    expect(reason).toContain("Retry");
    expect(reason).toContain("never started");
    // The wrong diagnosis, and the one this arm used to give.
    expect(reason).not.toContain("its process is gone");
    expect(reason).not.toContain("Restart the agent");
  });

  // ══ THE DIALOG CASE ESCALATES FROM HERE NOW (bead sparkle-d6a5r) ═════════════════════════════
  // `sparkle-1cu3j` stopped calling a Claude Code permission dialog a full-screen app, which routed
  // it off `alternate-screen` and onto this path — and the labels did not travel with it. So the
  // single most common screen to reach a refusal went from naming its own question to being handed
  // to the human as "a permission dialog, a password, a host-key confirmation, a yes/no": four
  // candidates, one of them true, at 3am. RED before the labels were carried on the blocked-prompt
  // arm, because `liveMenuLabels` was undefined on every result reaching this branch.
  it("MENU-present blocked prompt: names the permission dialog and its options", async () => {
    sendMock.mockImplementation(async (agentId: string) => ({
      ok: false as const,
      path: "blocked-prompt" as const,
      agentId,
      liveMenuLabels: ["Yes", "No, and tell Claude what to do differently"],
    }));
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    const reason = goalOf(projectId, agentId)!.escalationReason!;
    // Names the dialog AND the specific options, so the human knows what is being asked without
    // opening the pane to find out.
    expect(reason).toMatch(/permission dialog waiting for your answer/i);
    expect(reason).toContain('"Yes"');
    expect(reason).toContain('"No, and tell Claude what to do differently"');
    // ── AND IT MUST NOT OFFER A REMEDY THAT IS UNSAFE IN THIS STATE (the `sparkle-8bvh` rule) ───
    // "Quitting it is safe" belongs to the no-menu pager arm and is FALSE against a live decision;
    // and this bead exists because `restart_agent` — which destroys in-flight context to deliver
    // one message — was left as the only route to the pane, so the escalation may never send the
    // human there either.
    expect(reason).not.toMatch(/quitting it is safe/i);
    expect(reason).not.toMatch(/pager or editor/i);
    expect(reason).not.toMatch(/restart/i);
    // The banner the human actually reads carries the same sentence, not a second one that drifts.
    expect(notifyMock.mock.calls[0]![0].body).toBe(reason);
  });

  it("NO-MENU blocked prompt: keeps the honest enumeration and claims no dialog it cannot see", async () => {
    // A credential field reaches this path with NO labels, by construction — the credential arm
    // returns above the arm that sets them. The copy must not invent a menu here: "choose what is
    // on screen" at a concealed password field is a dead instruction.
    alwaysRefuse("blocked-prompt");
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    const reason = goalOf(projectId, agentId)!.escalationReason!;
    expect(reason).toMatch(/must not receive free text/i);
    expect(reason).toMatch(/host-key/i);
    expect(reason).not.toMatch(/waiting for your answer/i);
    expect(reason).not.toMatch(/choose what is on screen/i);
    expect(reason).not.toMatch(/quitting it is safe/i);
    expect(reason).not.toMatch(/restart/i);
  });

  it("still gives a LOCAL agent the terminal wording on the same path", async () => {
    // The other half: the fix must not blanket-replace the local copy, which is correct and is what
    // the vast majority of agents get.
    alwaysRefuse("blocked-prompt");
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    const reason = goalOf(projectId, agentId)!.escalationReason!;
    expect(reason).toContain("Nothing was typed into the terminal");
    expect(reason).not.toContain("sandbox");
  });

  it("does not credit a QUEUED send as delivered — held is not typed", async () => {
    // The gap that made the whole bound inapplicable to a pane that never finishes starting.
    // `dispatchConciergeAnswer` returns ok:true/path:"queued" when the PTY is not up: the message
    // sits in the hold queue. Reading `ok` alone cleared the streak and recorded a goal-continue on
    // every sweep, so the counter could never reach the bound and nobody was ever told — while the
    // agent saw nothing.
    sendMock.mockImplementation(async (agentId: string) => ({
      ok: true as const,
      path: "queued" as const,
      agentId,
      sent: "x",
      display: "x",
    }));
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    // It escalates, which is the whole point: the streak has to be able to climb.
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeDefined();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    // ...and it is NOT charged to the progress budget, which counts delivered resumes only.
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(0);

    const reason = goalOf(projectId, agentId)!.escalationReason!;
    expect(reason).toContain("never finished starting");
    expect(reason).toContain("only ever held");
    // The default arm would have quoted the raw path instead of naming a remedy.
    expect(reason).not.toContain('kept coming back "queued"');

    // ...and it must NOT make the claim every other arm makes. A held send has a 2-minute TTL and
    // the bound trips at ~92s, so all three holds are still live when the human is notified and
    // will be typed if the pane comes up. "Nothing was typed, so the agent has not seen any of it"
    // is a sentence that can become false minutes after it is read.
    expect(reason).not.toContain("has not seen any of it");
    expect(reason).toContain("Nothing has been typed into the terminal yet");
    expect(reason).toContain("may still go through");
  });

  it("keeps the absolute claim on paths where it IS true", async () => {
    // The control for the sentence above: a refused send wrote nothing and left nothing pending,
    // so weakening the copy everywhere would lose a guarantee that genuinely holds.
    alwaysRefuse("alternate-screen");
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    const reason = goalOf(projectId, agentId)!.escalationReason!;
    expect(reason).toContain("Nothing was typed into the terminal, so the agent has not seen any of it");
    expect(reason).not.toContain("may still go through");
  });

  it("still clears the streak on a REAL delivery, so queued is the only demoted path", async () => {
    // The control. Without it, "treat ok:true as undelivered" would look identical to the fix, and
    // every genuine delivery would be silently counted against the bound too.
    sendMock.mockImplementation(async (agentId: string) => ({
      ok: true as const,
      path: "free-text" as const,
      agentId,
      sent: "x",
      display: "x",
    }));
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    expect(undeliveredStreakFor(agentId)).toBe(0);
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeUndefined();
    expect(goalOf(projectId, agentId)!.totalContinues).toBeGreaterThan(0);
  });

  it("counts a STREAK — one delivery in between clears it", async () => {
    const { projectId, agentId } = seed({ goal: "land the PR" });
    alwaysRefuse("alternate-screen");

    await sweepUntilEligible(2);
    expect(undeliveredStreakFor(agentId)).toBe(2);

    // The pane becomes reachable for exactly one window...
    sendMock.mockImplementationOnce(async (id: string) => ({
      ok: true as const,
      path: "free-text" as const,
      agentId: id,
      sent: "x",
      display: "x",
    }));
    await sweepGoalContinuations({ now: SETTLED + 2 * 46_000, ownsProject: ownsEverything });
    expect(undeliveredStreakFor(agentId)).toBe(0);

    // ...so the two refusals that follow are a streak of two, not five, and nothing escalates.
    await sweepGoalContinuations({ now: SETTLED + 3 * 46_000, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED + 4 * 46_000, ownsProject: ownsEverything });
    expect(undeliveredStreakFor(agentId)).toBe(2);
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeUndefined();
  });

  it("does not spend the PROGRESS budget — the two bounds stay separate", async () => {
    alwaysRefuse("alternate-screen");
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    // `totalContinues` counts DELIVERED resumes. An undelivered one crediting it would make
    // `MAX_CONTINUES_WITHOUT_PROGRESS` fire on sends the agent never saw.
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(0);
  });
});

describe("the concierge's re-arm actually puts the agent back to work", () => {
  /** Spend the consecutive-retry budget without moving the mark. */
  function burnRetries(projectId: string, agentId: string, times: number): void {
    for (let i = 0; i < times; i++) {
      useProjectStore.getState().noteAgentGoalContinue(projectId, agentId, FRESH_MARK);
    }
  }

  /** Drive the sweep to a REAL escalation, the way the runner reaches one in the field. */
  async function escalateForReal(projectId: string, agentId: string): Promise<void> {
    burnRetries(projectId, agentId, 3);
    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeDefined();
    expect(sendMock).not.toHaveBeenCalled();
  }

  it("RESUMES the agent after a non-human clear — the whole point of the feature", async () => {
    // THE CLAIM THE FOUNDER ACTUALLY MADE, and the one his concierge got wrong: it reported
    // "re-armed" while auto-resume stayed dead, because rewriting the goal TEXT leaves the latch
    // alone. So this asserts the SIDE EFFECT — text that reached the terminal — and not
    // `goalStateOf === "unmet"`, which is merely the precondition and was already true of every
    // cosmetic re-arm that shipped nothing.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    await escalateForReal(projectId, agentId);

    // The concierge clears it. No human typed anything.
    expect(useProjectStore.getState().conciergeRearmAgentGoal(projectId, agentId, "cleared the dialog", Date.now())).toBe(
      true,
    );

    // ONE sweep is enough: the idle clock has been armed since before the escalation, so the very
    // next eligible window sends. (Two sweeps here would send twice, which is correct behaviour and
    // a misleading assertion.)
    await sweepGoalContinuations({ now: SETTLED + 46_000, ownsProject: ownsEverything });

    // THE SEND HAPPENED, carrying the goal.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [sentAgentId, sentText] = sendMock.mock.calls[0]!;
    expect(sentAgentId).toBe(agentId);
    expect(sentText).toContain("land the PR");

    // And the retry was recorded against the re-armed budget, not a fresh one.
    expect(goalOf(projectId, agentId)!.conciergeRearms).toBe(1);
  });

  it("stops resuming again once the allowance is spent — the bound is real, not advisory", async () => {
    const { projectId, agentId } = seed({ goal: "land the PR" });

    for (let i = 0; i < MAX_CONCIERGE_REARMS; i++) {
      useProjectStore.getState().escalateAgentGoal(projectId, agentId, "gave up", Date.now());
      expect(useProjectStore.getState().conciergeRearmAgentGoal(projectId, agentId, `try ${i}`, Date.now())).toBe(true);
    }
    useProjectStore.getState().escalateAgentGoal(projectId, agentId, "gave up again", Date.now());

    // The allowance is gone, so the concierge cannot clear it...
    expect(useProjectStore.getState().conciergeRearmAgentGoal(projectId, agentId, "once more", Date.now())).toBe(false);

    // ...and the agent stays stopped, which is the side effect that matters.
    sendMock.mockClear();
    let now = T0;
    for (let i = 0; i < 3; i++) {
      await sweepGoalContinuations({ now, ownsProject: ownsEverything });
      now += 46_000;
    }
    expect(sendMock).not.toHaveBeenCalled();
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeDefined();
  });

  it("a concierge RAISE stops a healthy agent being resumed", async () => {
    // The other direction. An agent with a live goal is eligible; raising must take it out of the
    // pool exactly the way a machine give-up does.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    useProjectStore.getState().conciergeEscalateAgentGoal(projectId, agentId, "a person is needed", Date.now());

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    expect(sendMock).not.toHaveBeenCalled();
    expect(goalOf(projectId, agentId)!.escalatedBy).toBe("concierge");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE FALSE-POSITIVE FLOOD (founder report, 2026-08-18)
//
// Six agents were paged "Auto-continued 3 times with no sign of progress" in one hour while holding
// OPEN pull requests against a saturated CI queue. These are the SIDE-EFFECT tests for that: what
// reached the terminal and whether the human's "needs you" list got a line, not what the decision
// object said. Each suppression is paired with the case that must still page somebody.
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("evidence the sweep must actually gather", () => {
  /**
   * Spend the consecutive-retry budget without moving the mark.
   *
   * ⚠️ `at` MUST BE THE MARK THE RUNNER WILL COMPUTE ON THE NEXT SWEEP, not `FRESH_MARK`. Burning
   * against a stale mark makes the sweep read "the mark moved" and reset the streak, so the test
   * would pass without the gate ever being consulted — the state under test is specifically
   * "nothing observable moved AND the streak is spent", which is the shape that pages the human.
   */
  function burn(projectId: string, agentId: string, times: number, at = FRESH_MARK): void {
    for (let i = 0; i < times; i++) {
      useProjectStore.getState().noteAgentGoalContinue(projectId, agentId, at);
    }
  }

  /** Merge extra runtime evidence in WITHOUT clobbering what `seed` wrote. */
  function evidence(patch: Record<string, unknown>): void {
    useRuntimeStore.setState(patch as never);
  }

  async function settleThenSweep(): Promise<void> {
    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });
  }

  // ⚠️ RESTORE THE DISPATCH STUB, DO NOT INHERIT IT. The `never REACHES the terminal` describe above
  // calls `sendMock.mockReset()` in its own `afterEach`, and in vitest 2 that leaves the mock with
  // NO implementation for whatever runs next — so `dispatchConciergeAnswer` resolves `undefined`,
  // the runner records the send as `threw`, and nothing is written to the goal. That failure is
  // silent in exactly the wrong way: `toHaveBeenCalledTimes(1)` still passes (the call happened) and
  // `notifyMock` still passes (no escalation), so a delivery assertion looks green while the sweep's
  // whole side effect was thrown away. Restoring here rather than reaching into the describe above
  // keeps this block independent of file order.
  beforeEach(() => {
    sendMock.mockImplementation(
      async (agentId: string, text: string, opts?: { userPrompt?: boolean }) => {
        // The `userPrompt` contract is honoured for the same reason the module factory honours it:
        // `promptHistory.length` is part of the progress mark, so a stub that appended
        // unconditionally would make every mark assertion here test the stub.
        if (opts?.userPrompt) {
          const store = useProjectStore.getState();
          const project = store.projects.find((p) => p.agents.some((a) => a.id === agentId));
          if (project) store.appendPrompt(project.id, agentId, text);
        }
        return { ok: true, path: "free-text" as const, agentId, sent: text, display: text };
      },
    );
  });
  afterEach(() => {
    sendMock.mockReset();
  });

  it("PAIR — with no PR reading, the streak still pages the human", async () => {
    // THE TRUE POSITIVE, restated here rather than borrowed from the `escalation` block above, so
    // the suppression test below cannot be satisfied by a predicate that stopped firing entirely.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    burn(projectId, agentId, 3);

    await settleThenSweep();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    // WHICH WORDING, AND WHY IT IS THE BLIND ONE (bead `sparkle-gazo4a`). This seed supplies no
    // fleet digest, no branch status and no PR reading, so the mark's three WORK-EVIDENCE columns
    // are all empty and `goalContinuation.workEvidenceReadable` reports the streak as unobserved.
    // The escalation still FIRES — which is this test's actual claim, asserted on either side of
    // this line — but it may not say "no sign of progress", because that is a finding about the
    // agent and nothing was read. A seed that supplied any one reading gets the ordinary sentence;
    // `engine/goalContinuation.falseAbsence.test.ts` pins both directions.
    expect(notifyMock.mock.calls[0]![0].body).toContain("whether it advanced is unknown, not settled");
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeDefined();
  });

  it("an agent with an OPEN PR is PARKED — nothing reaches the 'needs you' list, and no context is re-billed", async () => {
    // THE FOUNDER'S VERIFIABLE GOAL, end to end. Identical to the pair above except that the store
    // holds the one fact the predicate never consulted.
    //
    // ⚠️ REVISED 2026-08-24 (sparkle-yxl05z). This asserted a RESTART, on the rule that "never
    // continued AND never escalated" is the silent-forever state this module exists to abolish.
    // That rule is right and this is not an exception to it — but the restart it prescribes is
    // itself the second half of the founder's report: blocked on CI wall-clock for ~2 hours, he was
    // woken again and again by "your goal is not met yet, so you are being resumed automatically",
    // each wake re-billing an entire session context to produce the sentence "still waiting on CI".
    //
    // So the agent is parked, and parking is NOT silence in the sense that rule forbids: it is
    // named in the sweep's outcomes, it ends by itself when the gate moves (the PR reading is part
    // of the progress mark), and it is bounded by EXTERNAL_WAIT_GRACE_MS — which the next test
    // proves end to end rather than leaving as a claim in a comment.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    evidence({
      workflowState: { [agentId]: { prState: "open", prNumber: 2117 } },
    });
    burn(projectId, agentId, 3, progressMark({ promptHistoryLength: 0, prMark: "open#2117" }));

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    const outcomes = await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    expect(notifyMock).not.toHaveBeenCalled();
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeUndefined();
    // NOT restarted: the whole cost of the old behaviour was one full context per wake.
    expect(sendMock).not.toHaveBeenCalled();
    // …and not silent either — the state is reported, so a human or the concierge can ask.
    expect(outcomes.find((o) => o.agentId === agentId)).toEqual({
      agentId,
      action: "none",
      detail: "external-wait",
    });
  });

  it("PAIR — the park is BOUNDED: a gate that never moves reaches the human after the grace", async () => {
    // The hole this change could have been. Same setup as the park above, run forward past
    // EXTERNAL_WAIT_GRACE_MS with the gate unchanged, through the REAL ledger — so this fails if
    // the sweep stops folding the age, or if the age is re-stamped on every sweep (verified: both
    // mutations turn this red).
    //
    // ⚠️ IT CANNOT SEE THE GRACE-VS-TTL INTERACTION, and saying so is the point. `seed` sets the
    // goal through the store, which stamps `setAt` from the REAL clock, while these sweeps use a
    // tiny synthetic `now` — so the goal's 4h TTL never elapses here however far the sweep clock is
    // advanced. A grace raised past DEFAULT_GOAL_TTL_MS is unreachable in production
    // (`goal-expired` is answered before any bound) and this test stays green through it; the
    // engine's "gate DEFERS the ceiling" loop, which advances one clock in real steps, is what
    // catches that. Verified by mutation: a 5h grace reds that test and not this one.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    evidence({ workflowState: { [agentId]: { prState: "open", prNumber: 2117 } } });
    burn(projectId, agentId, 3, progressMark({ promptHistoryLength: 0, prMark: "open#2117" }));

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });
    expect(notifyMock).not.toHaveBeenCalled();

    await sweepGoalContinuations({
      now: T0 + EXTERNAL_WAIT_GRACE_MS + 60_000,
      ownsProject: ownsEverything,
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const body = notifyMock.mock.calls[0]![0].body;
    expect(body).toContain("PR #2117");
    expect(body).not.toContain("no sign of progress");
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeDefined();
  });

  it("a MERGED PR is not a gate — the agent escalates normally", async () => {
    // The gate is "the work is waiting on an answer", not "this branch has ever had a PR". Once the
    // PR is answered there is nothing to wait for, and `prState` never returns to null — so a gate
    // keyed on presence rather than on `open` would be a permanent hole.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    evidence({ workflowState: { [agentId]: { prState: "merged", prNumber: 2117 } } });
    burn(projectId, agentId, 3, progressMark({ promptHistoryLength: 0, prMark: "merged#2117" }));

    await settleThenSweep();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeDefined();
  });

  /** Publish one digest reading of the windowed tool count for `agentId`. */
  function tools(agentId: string, toolsRecent: number | null): void {
    evidence({
      agentMovement: {
        [agentId]: { lastEvent: "Stop", lastEventMs: T0, sessionId: "s1", toolsRecent },
      },
    });
  }

  it("TOOL activity read off the fleet digest resets the streak", async () => {
    // The signal the six false pages could not see. `promptHistory` grows only when a HUMAN types
    // and `activity` only when the agent narrates — which the orchestrator prompt tells it to skip —
    // so an agent that spent the hour running tools moved nothing the old mark could read.
    //
    // Two sweeps, because the ledger's FIRST sighting is a baseline: one reading is a level, and it
    // takes two to see a RISE. Burned at burst 0, which is what the first sweep records.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    burn(projectId, agentId, 3, progressMark({ promptHistoryLength: 0, toolBursts: 0 }));
    tools(agentId, 5);
    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    tools(agentId, 41); // the agent ran tools
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    expect(notifyMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    // The mark the runner RECORDED carries the evidence, so the next sweep compares against a live
    // reading rather than the stale one the streak was burned at.
    expect(goalOf(projectId, agentId)!.mark).not.toBe(FRESH_MARK);
    expect(goalOf(projectId, agentId)!.continues).toBe(1);
  });

  it("WINDOW DECAY is not progress — a falling tool count escalates (roborev 65440)", async () => {
    // THE PAIR, and the defect it pins. `HookFacts.toolsRecent` counts over a SLIDING 15-minute
    // window, so an agent that genuinely STOPPED still produces a changing number: 41 → 30 → … → 0
    // as its old events age out. Fed in raw, every one of those decrements moved the mark, reset the
    // consecutive streak and pushed the escalation further away — silence reading as work, which is
    // the exact inverse of what this measures and would have made the 3-strike bound unreachable for
    // any agent that had ever been busy.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    burn(projectId, agentId, 3, progressMark({ promptHistoryLength: 0, toolBursts: 0 }));
    tools(agentId, 41);
    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    tools(agentId, 30); // nothing happened; the window simply moved
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    expect(sendMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0].body).toContain("no sign of progress");
  });

  it("a POLL GAP is silence, not movement", async () => {
    // `fleetWatch` republishes `{}` after a failed digest, so a reading can vanish and come back.
    // Treating the disappearance as a value would make our own blind spot look like work — and then
    // the return look like more of it. `noteToolActivity` holds the ledger still across a null.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    burn(projectId, agentId, 3, progressMark({ promptHistoryLength: 0, toolBursts: 0 }));
    tools(agentId, 41);
    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    evidence({ agentMovement: {} }); // the poll failed
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    expect(sendMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("a RECREATED agent id starts from a baseline, not its predecessor's count", async () => {
    // The ledger is pruned against the live roster in the same loop as `undelivered` and
    // `loggedExpiryRefusal`, for the reasons those two document — plus it grows with every agent id
    // ever swept since app start rather than with the roster.
    //
    // ⚠️ THE FIRST VERSION OF THIS TEST DID NOT DISCRIMINATE, and its mutant survived: the
    // predecessor's LEVEL is overwritten by the very next reading (`lastSeen` is assigned
    // unconditionally), so a lost level costs at most one observation and no assertion could see it.
    // What actually survives a teardown is the COUNT, so the fixture drives a real RISE first —
    // without the prune the recreated id resumes at 1 instead of starting at 0.
    const busy = seed({ goal: "first tenant" });
    tools(busy.agentId, 5);
    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    tools(busy.agentId, 41); // a genuine rise: bursts -> 1
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });
    expect(noteToolActivity(busy.agentId, 41)).toBe(1);

    // The row goes away — the sweep's composite no longer carries it, which is the prune's trigger.
    useProjectStore.setState({ projects: [] } as never);
    useRuntimeStore.setState({ status: {}, openAgentIds: [], agentMovement: {} } as never);
    await sweepGoalContinuations({ now: SETTLED + 46_000, ownsProject: ownsEverything });

    // A fresh agent under the SAME id inherits nothing.
    expect(noteToolActivity(busy.agentId, 5)).toBe(0);
    expect(noteToolActivity(busy.agentId, 9)).toBe(1);
  });

  it("a COLD ledger reproduces the burst count the persisted mark already carries", async () => {
    // ⚠️ THE LEDGER IS WEBVIEW-LOCAL; THE MARK IS PERSISTED ON THE GOAL (roborev 65483). After a
    // reload the ledger is empty, so an unseeded baseline of 0 is compared against a stored `…␀4␀…`
    // — the two differ, that reads as progress, and `continues` is rewritten to 1. Every app restart
    // would silently clear the no-progress streak, and a machine that restarts more often than an
    // agent accumulates three settled strikes could never reach the 3-strike escalation at all.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    const persisted = progressMark({ promptHistoryLength: 0, toolBursts: 4 });
    burn(projectId, agentId, 3, persisted);
    tools(agentId, 7); // a fresh reading, from a ledger that knows nothing about this agent

    await settleThenSweep();

    // The streak survived the cold start: no free "progressed", so the bound still fires.
    expect(sendMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0].body).toContain("no sign of progress");
  });

  it("continuationEvidenceFor reproduces the persisted count with a COLD ledger", async () => {
    // ⚠️ THE READER'S FALLBACK NEEDS ITS OWN TEST, and its mutant survived without one: inside a
    // SWEEP the fold has already seeded the ledger by the time the reader runs, so removing the
    // reader's `?? burstsOf(...)` changes nothing there. The path it actually guards is a read
    // taken with no fold ahead of it — `controlListener.resumeReading` in a window that has never
    // swept this agent, which is exactly the cross-window drift this whole commit is about.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    useProjectStore.getState().noteAgentGoalContinue(
      projectId,
      agentId,
      progressMark({ promptHistoryLength: 0, toolBursts: 4 }),
    );
    const agent = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === agentId)!;

    // No sweep has run, so nothing has folded anything for this agent.
    expect(continuationEvidenceFor(agent).mark).toBe(
      progressMark({ promptHistoryLength: 0, toolBursts: 4 }),
    );
  });

  it("burstsOf reads the count back out of a mark, and fails closed", () => {
    expect(burstsOf(progressMark({ promptHistoryLength: 0, toolBursts: 4 }))).toBe(4);
    expect(burstsOf(progressMark({ promptHistoryLength: 0, toolBursts: 0 }))).toBe(0);
    // "we did not look" must not come back as a real 0 — that is a different, meaningful value.
    expect(burstsOf(progressMark({ promptHistoryLength: 0 }))).toBeNull();
    expect(burstsOf(undefined)).toBeNull();
    // An older build's shorter mark, or a non-numeric token, is also "cannot tell".
    expect(burstsOf("0\u0000\u0000")).toBeNull();
    expect(burstsOf("0\u0000\u0000\u0000x\u0000\u0000")).toBeNull();
  });

  it("noteToolActivity: only a RISE advances the counter", async () => {
    // The rule as arithmetic, so the three end-to-end tests above cannot all pass on a fold that is
    // merely different rather than monotone.
    expect(noteToolActivity("x", 5)).toBe(0); // first sighting is a baseline, never a burst
    expect(noteToolActivity("x", 5)).toBe(0); // flat
    expect(noteToolActivity("x", 3)).toBe(0); // decay
    expect(noteToolActivity("x", 9)).toBe(1); // a rise
    expect(noteToolActivity("x", null)).toBe(1); // a gap holds, it does not move
    expect(noteToolActivity("x", 2)).toBe(1); // …and the held level is still 9, so this is decay
    expect(noteToolActivity("x", 10)).toBe(2);
  });

  it("`lastEvent` alone would have been useless — the digest reads Stop when a turn has ended", () => {
    // Why the mark keys on a COUNT and not the event NAME. `fleet.rs` assigns `last_event`
    // last-wins, and a continuation is only ever decided on an agent whose turn has ENDED, so the
    // name at that instant is `Stop` essentially every time. Both fixtures below carry the same
    // useless name and are still told apart, which is the property under test.
    const quiet = progressMark({ promptHistoryLength: 0, toolBursts: 0 });
    const busy = progressMark({ promptHistoryLength: 0, toolBursts: 1 });
    expect(busy).not.toBe(quiet);
  });

  it("COMMITS on the agent's branch reset the streak", async () => {
    const { projectId, agentId } = seed({ goal: "land the PR" });
    // Burned at the OLD commit count, then a commit lands — which is the movement under test.
    burn(projectId, agentId, 3, progressMark({ promptHistoryLength: 0, commitsAhead: 3 }));
    evidence({ branchStatus: { [agentId]: { ahead: 4, behind: 0, dirty: false } } });

    await settleThenSweep();

    expect(notifyMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("an agent this window has never polled reads as NO evidence, and still escalates", async () => {
    // The fail-safe direction. Every new input is `?? null`, so a window with no digest and no pane
    // poll must behave exactly as it did before this change — a manufactured zero would read as a
    // real, unchanging observation of "no work" built out of our own silence, and a manufactured
    // gate would silence the fleet.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    burn(projectId, agentId, 3);
    evidence({ workflowState: {}, agentMovement: {}, branchStatus: {} });

    await settleThenSweep();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeDefined();
  });
});

describe("the unreachable-terminal escalation is untouched", () => {
  // THE ONE THE FOUNDER WANTS LOUDER, NOT QUIETER: "Auto-resume could not reach this agent" is the
  // case where a human genuinely must open a pane. It is raised by `noteUndelivered`, an entirely
  // separate path from the streak bound — but "separate by construction" is what every silently
  // broken guard was too, so it is pinned against the exact state that now suppresses the other one.
  afterEach(() => {
    sendMock.mockReset();
  });

  it("still fires for an agent that ALSO has an open PR", async () => {
    sendMock.mockImplementation(async (agentId: string) => ({
      ok: false as const,
      path: "alternate-screen" as never,
      agentId,
    }));
    const { projectId, agentId } = seed({ goal: "land the PR" });
    useRuntimeStore.setState({
      workflowState: { [agentId]: { prState: "open", prNumber: 2117 } },
    } as never);

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    for (let i = 0; i < MAX_UNDELIVERED_CONTINUES; i++) {
      await sweepGoalContinuations({ now: SETTLED + i * 46_000, ownsProject: ownsEverything });
    }

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const reason = goalOf(projectId, agentId)!.escalationReason!;
    expect(reason).toContain("full-screen mode");
    // And it is NOT the diagnosis the gate suppresses — the two must stay distinguishable.
    expect(reason).not.toContain("no sign of progress");
  });
});

describe("reading the store's PR state honestly", () => {
  it("only `open` is a gate", () => {
    expect(externalWaitOf({ prState: "open", prNumber: 7 } as never, "a1")).toEqual({
      kind: "open-pr",
      prNumber: 7,
      since: null,
    });
    expect(externalWaitOf({ prState: "merged", prNumber: 7 } as never, "a1")).toBeUndefined();
    expect(externalWaitOf({ prState: "closed", prNumber: 7 } as never, "a1")).toBeUndefined();
  });

  it("`prState: null` yields NO gate and NO mark — it is ambiguous, not a negative finding", () => {
    // Rust sends null both for "probed, found nothing" and for a poll that never probed
    // (`probePrState` is gated), and those are indistinguishable here. Turning it into either a gate
    // or a stable "there is no PR" token would be inventing an answer.
    expect(externalWaitOf({ prState: null, prNumber: null } as never, "a1")).toBeUndefined();
    expect(prMarkOf({ prState: null, prNumber: null } as never)).toBeNull();
    expect(externalWaitOf(undefined, "a1")).toBeUndefined();
    expect(prMarkOf(undefined)).toBeNull();
  });

  it("the mark token moves when the PR appears and when its state changes", () => {
    const opened = prMarkOf({ prState: "open", prNumber: 2117 } as never);
    const merged = prMarkOf({ prState: "merged", prNumber: 2117 } as never);
    expect(opened).not.toBeNull();
    expect(merged).not.toBe(opened);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// HOW LONG HAS THE GATE BEEN THERE — sparkle-yxl05z.
//
// The pure ladder decides whether a CI wait excuses an agent's quiet, and it decides it from an
// AGE. This file is where that age is actually measured, so these tests exist because the ladder's
// own tests cannot see them: every one of those passes its own `since`, which means the line that
// supplies the REAL one would be covered by nothing (bead sparkle-lgbwf, seen 4x here — delete the
// producer and the engine suite stays green while the fix is inert).
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("the external-gate ledger", () => {
  const OPEN_7 = { prState: "open", prNumber: 7 } as never;

  it("stamps first sighting and does NOT re-stamp an unchanged gate", () => {
    // The re-stamp is the failure that would make the grace unreachable: at a 15s sweep the age
    // would reset to zero fifteen seconds at a time and never reach three hours.
    noteExternalWait("a1", OPEN_7, T0);
    expect(externalWaitSinceFor("a1")).toBe(T0);
    noteExternalWait("a1", OPEN_7, T0 + 60_000);
    noteExternalWait("a1", OPEN_7, T0 + 120_000);
    expect(externalWaitSinceFor("a1")).toBe(T0);
    expect(externalWaitOf(OPEN_7, "a1")).toEqual({ kind: "open-pr", prNumber: 7, since: T0 });
  });

  it("a DIFFERENT PR restarts the clock, and a closed gate clears it", () => {
    // Otherwise an agent that landed #7 and opened #8 inherits #7's age and can be handed to a
    // human for a gate that is minutes old.
    noteExternalWait("a1", OPEN_7, T0);
    noteExternalWait("a1", { prState: "open", prNumber: 8 } as never, T0 + 90_000);
    expect(externalWaitSinceFor("a1")).toBe(T0 + 90_000);
    noteExternalWait("a1", { prState: "merged", prNumber: 8 } as never, T0 + 120_000);
    expect(externalWaitSinceFor("a1")).toBeUndefined();
  });

  it("a gate the ledger has not seen reads `since: null`, never a fresh stamp", () => {
    // A window that has just booted must say "I cannot tell you how long", because claiming the
    // gate appeared just now would restart the grace on every relaunch — an agent in a crash loop
    // would then be parked forever. `null` keeps the pre-fix behaviour instead.
    expect(externalWaitOf(OPEN_7, "never-swept")).toEqual({
      kind: "open-pr",
      prNumber: 7,
      since: null,
    });
    // …and a STALE entry for another gate is not borrowed either.
    noteExternalWait("a1", OPEN_7, T0);
    expect(externalWaitOf({ prState: "open", prNumber: 9 } as never, "a1")).toEqual({
      kind: "open-pr",
      prNumber: 9,
      since: null,
    });
  });

  it("the SWEEP folds it — an agent holding an open PR accrues a real age", async () => {
    // THE PRODUCTION LINE. `continuationEvidenceFor` is read-only, so if the sweep ever stops
    // calling `noteExternalWait` every gate reports `since: null` and the whole park is dead code
    // that still typechecks. This is the assertion that would go red.
    const { projectId, agentId } = seed({ goal: "land the PR" });
    useRuntimeStore.setState({
      workflowState: { [agentId]: { prState: "open", prNumber: 2117 } },
    } as never);

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    expect(externalWaitSinceFor(agentId)).toBe(T0);

    await sweepGoalContinuations({ now: T0 + 30_000, ownsProject: ownsEverything });
    // Still T0: an unchanged gate is thirty seconds older, not newly born.
    expect(externalWaitSinceFor(agentId)).toBe(T0);

    const agent = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === agentId)!;
    expect(continuationEvidenceFor(agent).externalWait).toEqual({
      kind: "open-pr",
      prNumber: 2117,
      since: T0,
    });
  });
});
