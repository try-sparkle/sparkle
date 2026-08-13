// @vitest-environment jsdom
//
// The runner that SPENDS MONEY on engine/goalContinuation's decision.
//
// Every test here asserts a SIDE EFFECT — text that reached the terminal, a counter the store
// advanced, a banner the human got — never that a decision object was produced. The engine is
// already tested as arithmetic; what is untested until here is whether the mount gathers real
// evidence and acts on it exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { progressMark } from "../engine/goalContinuation";
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
import {
  _resetGoalContinuationRunnerForTests,
  idleSinceFor,
  MAX_UNDELIVERED_CONTINUES,
  ownsProjectInThisWindow,
  processAliveFor,
  sweepGoalContinuations,
  trackIdleSince,
  undeliveredStreakFor,
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
    expect(notice.body).toContain("no sign of progress");

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

  it("names the OBSTACLE, and never the restart copy that would send the human hunting", async () => {
    alwaysRefuse("alternate-screen");
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    const reason = goalOf(projectId, agentId)!.escalationReason!;
    expect(reason).toContain("full-screen mode");
    expect(reason).toContain("land the PR");
    // ── AND IT MUST NOT NAME AN APP IT HAS NO EVIDENCE OF (bead sparkle-saoe3) ────────────────
    // This path fires on `alternateBuffer && !isClaudeCodeScreen`, and Claude Code's own permission
    // dialog satisfies both — so the overwhelmingly common cause is an approval prompt, not an
    // editor. Naming vim/less/htop as fact sent the founder hunting for an app to quit on five
    // separate agents in one afternoon, every one of them a normal pane stopped at "Do you want to
    // proceed?". The remedy has to be one the human can actually carry out.
    expect(reason).not.toContain("vim");
    expect(reason).not.toContain("htop");
    expect(reason).toMatch(/answer what is on screen/i);
    // The diagnosis the progress bound gives is WRONG here — nothing was ever typed, so there is no
    // "restarting" that failed. This is the assertion the whole change exists for.
    expect(reason).not.toContain("restarting cannot fix");
    expect(reason).toContain("Nothing was typed into the terminal");
    // The banner the human actually reads carries the same sentence, not a second one that drifts.
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
