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
  ownsProjectInThisWindow,
  processAliveFor,
  sweepGoalContinuations,
  trackIdleSince,
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
  /** Put the agent in `openAgentIds`. Default true. */
  open?: boolean;
}): { projectId: string; agentId: string; agentName: string } {
  const store = useProjectStore.getState();
  const projectId = store.addProject("Demo", "/tmp/demo");
  const agentId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
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
