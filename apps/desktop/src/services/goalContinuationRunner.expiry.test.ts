// @vitest-environment jsdom
//
// The EXPIRY arm of the sweep — the half that writes latches rather than sending text.
//
// Every test asserts the STORE's goal record after a sweep, never a decision object: the decider is
// already tested as arithmetic in engine/goalExpiry.test.ts, and what is untested until here is
// whether the mount gathers real evidence and acts on it.
//
// ⚠️ EVERY REFUSAL IS PAIRED WITH THE POSITIVE IT DIFFERS FROM BY ONE FIELD, and the first version of
// this file is why. It seeded its agent with `addAgent` alone, which writes `worktreePath: null`, so
// `decideExpiry` answered `no-worktree` TWO ARMS before the evidence rules — and every case asserted
// an ABSENCE, so all three passed against a mechanism they never reached and would have passed with
// the arm deleted outright. That is `sparkle-rvf6n`'s guard-short-circuit shape, and an absence
// assertion cannot tell "the rule refused" from "the code is not there". So: a positive case for each
// latch the mount can actually reach, and each negative one field away from it.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./conciergeDispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./conciergeDispatch")>();
  return { ...actual, dispatchConciergeAnswer: vi.fn(async () => ({ ok: true, path: "free-text" })) };
});
vi.mock("../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger")>();
  return { ...actual, log: { ...actual.log, warn: vi.fn() } };
});
vi.mock("./attention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attention")>();
  return { ...actual, notifyAttention: vi.fn() };
});

import { goalDeadline, goalStateOf } from "../engine/agentGoal";
import { MAX_TTL_REARMS, REARM_TTL_MS } from "../engine/goalExpiry";
import { noteHooksLive, resetTurnEndAuthority, trackAgent } from "../engine/turnEndAuthority";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { log } from "../logger";
import { notifyAttention } from "./attention";
import type { BranchStatus, WorkflowState } from "./branchStatus";
import { dispatchConciergeAnswer } from "./conciergeDispatch";
import {
  _resetGoalContinuationRunnerForTests,
  sweepGoalContinuations,
} from "./goalContinuationRunner";

const ownsEverything = () => true;

/** One ms past THIS goal's own deadline.
 *
 *  Derived from the record rather than from a module-level `Date.now() + TTL`, which is the version
 *  that failed: the goal is created with the real clock LATER than module load, so a constant
 *  computed up there can sit before the deadline of the very goal it is meant to have outlived. The
 *  deadline is also not `setAt + ttlMs` by hand — `goalDeadline` owns that arithmetic now that a
 *  re-arm can move the origin, and a second copy here would drift the day that changes. */
const lapsedFor = (projectId: string, agentId: string) =>
  goalDeadline(goalOf(projectId, agentId)!) + 1;

/** The last instant this goal is still LIVE. Same derivation, same reason. */
const liveFor = (projectId: string, agentId: string) =>
  goalDeadline(goalOf(projectId, agentId)!) - 1;

/** A clean tree sitting on its own branch, nothing outstanding. Mirrors `agentGoalReading.test.ts`. */
const CLEAN_BS: BranchStatus = {
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  worktreeOnBranch: true,
};

/** The same tree holding three commits nobody has landed — what an abandoned agent looks like. */
const UNLANDED_BS: BranchStatus = { ...CLEAN_BS, ahead: 3 };

/** A workflow reading with a DEFINITE "no open PR". `prState: null` would be the AMBIGUOUS one —
 *  see the `pr-state-unknown` cases below, which turn on exactly that difference. */
const CLOSED_PR_WS: WorkflowState = {
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 3,
  prState: "closed",
  prNumber: null,
  prUrl: null,
};

/** An agent with an EXPIRABLE shape: a goal, and a worktree.
 *
 *  `setAgentWorktree` is the store's own action rather than a hand-patched record, so the field the
 *  capability gate reads is written by the same code production writes it with. Without it
 *  `hasWorktree` is false and NOTHING below reaches an evidence rule. */
function seedAgent(opts: { worktree?: boolean } = {}): { projectId: string; agentId: string } {
  const store = useProjectStore.getState();
  const projectId = store.addProject("Demo", "/tmp/demo");
  const agentId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
  if (opts.worktree !== false) {
    useProjectStore
      .getState()
      .setAgentWorktree(projectId, agentId, "/tmp/demo/wt", `sparkle/agent-${agentId}`);
  }
  useProjectStore.getState().setAgentGoal(projectId, agentId, "Land the retry PR");
  useRuntimeStore.setState({ status: { [agentId]: "idle" }, openAgentIds: [agentId] } as never);
  trackAgent(agentId, "test-engine");
  noteHooksLive(agentId);
  return { projectId, agentId };
}

/** Write the git reading this window has for an agent. Omitting `bs` is the post-relaunch state:
 *  `branchStatus` boots clean while the workflow watermarks persist. */
function seedReading(
  agentId: string,
  over: { bs?: BranchStatus; ws?: WorkflowState; shipped?: boolean } = {},
): void {
  const rt = useRuntimeStore.getState();
  useRuntimeStore.setState({
    branchStatus: { ...rt.branchStatus, ...(over.bs ? { [agentId]: over.bs } : {}) },
    workflowState: { ...rt.workflowState, ...(over.ws ? { [agentId]: over.ws } : {}) },
    workflowShipped: { ...rt.workflowShipped, ...(over.shipped ? { [agentId]: true } : {}) },
  } as never);
}

/** Spend the re-arm budget through the REAL transition, not by patching `ttlRearms` — `rearmGoal`
 *  also moves the deadline origin, and a hand-written record would leave the two inconsistent.
 *
 *  Each extension is stamped at the instant the PREVIOUS clock lapsed, which is both what the sweep
 *  does and what keeps this deterministic: the store action takes the deciding instant, so no part of
 *  this file depends on the wall clock. */
function spendRearmBudget(projectId: string, agentId: string): void {
  for (let i = 0; i < MAX_TTL_REARMS; i++) {
    const lapsedAt = lapsedFor(projectId, agentId);
    useProjectStore.getState().rearmAgentGoal(projectId, agentId, REARM_TTL_MS, lapsedAt);
  }
}

const goalOf = (projectId: string, agentId: string) =>
  useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)!
    .agents.find((a) => a.id === agentId)!.goal;

/** Sweep at `now`. ONE clock governs every instant in this file, and that is the fix rather than the
 *  convenience: the sweep judges on `now` AND stamps its latches with it (`applyExpiry` threads it
 *  into the store actions), because `rearmedAt` is the new deadline origin. When the write took
 *  `Date.now()` instead, a test driving the sweep at a synthetic instant re-armed to a deadline
 *  computed from real time — so it passed under either behaviour, which is AGENTS.md's "control only
 *  one of two coupled clocks" shape. Nothing here fakes the wall clock; it simply is not consulted. */
const sweepAt = (now: number) => sweepGoalContinuations({ now, ownsProject: ownsEverything });

/** The `detail` the sweep reported for this agent, if any. The refusal REASON travels here, which is
 *  the only way a stuck agent is countable: `applyExpiry` is skipped for a `none`, so without this
 *  the arm's careful distinctions were computed and dropped on the floor. */
const detailFor = (outcomes: Awaited<ReturnType<typeof sweepAt>>, agentId: string) =>
  outcomes.find((o) => o.agentId === agentId && o.detail?.startsWith("expiry:"))?.detail;

/** No latch, no re-arm, and — the two loudest side effects the arm can produce — no page and no
 *  send. Asserted on every refusal, because "it did not act" has to mean all four. */
function expectUntouched(projectId: string, agentId: string): void {
  const after = goalOf(projectId, agentId)!;
  expect(after.dischargedAt).toBeUndefined();
  expect(after.abandonedAt).toBeUndefined();
  expect(after.ttlRearms ?? 0).toBe(0);
  expect(notifyAttention).not.toHaveBeenCalled();
  expect(dispatchConciergeAnswer).not.toHaveBeenCalled();
}

beforeEach(() => {
  _resetGoalContinuationRunnerForTests();
  resetTurnEndAuthority();
  vi.clearAllMocks();
  useProjectStore.setState({ projects: [] } as never);
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    branchStatus: {},
    workflowState: {},
    workflowStage: {},
    workflowShipped: {},
  } as never);
});

describe("the arm RE-ARMS an expired agent that is still holding work", () => {
  it("extends the clock and counts the extension", async () => {
    // THE POSITIVE the refusals below are measured against. Note what is NOT seeded: no
    // `workflowState`, so the PR reading is absent — which is the ORDINARY case, and which used to
    // make `expiryProofFor` withhold the entire proof and this re-arm never happen.
    const { projectId, agentId } = seedAgent();
    seedReading(agentId, { bs: UNLANDED_BS });
    const LAPSED = lapsedFor(projectId, agentId);
    expect(goalStateOf(goalOf(projectId, agentId)!, LAPSED)).toBe("expired");

    await sweepAt(LAPSED);

    const after = goalOf(projectId, agentId)!;
    expect(after.ttlRearms).toBe(1);
    expect(after.ttlMs).toBe(REARM_TTL_MS);
    // The clock's ORIGIN moved to the decision instant, so the new deadline is one re-arm TTL past
    // it — asserted on the deadline itself rather than on `rearmedAt`, since `goalDeadline` is what
    // every reader actually consumes.
    expect(goalDeadline(after)).toBe(LAPSED + REARM_TTL_MS);
    // The goal is LIVE again — which is the whole point, since the ordinary continue path is what
    // resumes it on the next sweep. The arm itself never sends.
    expect(goalStateOf(after, LAPSED)).toBe("unmet");
    expect(dispatchConciergeAnswer).not.toHaveBeenCalled();
    // A re-arm is Sparkle quietly doing its job; it must never page anyone.
    expect(notifyAttention).not.toHaveBeenCalled();
  });

  it("but NOT when this window has no branch reading — the fail-closed case", async () => {
    // One field away from the case above: no `branchStatus`. This is the state a woken app is in —
    // `branchStatus` deliberately boots clean while the workflow watermarks persist — and nothing
    // may be concluded from it. Not a discharge, not an abandonment, and NOT a re-arm either:
    // re-arming on absent evidence reads as harmless while resuming an agent that may well have
    // finished, which is how a slot gets held all night being restarted to do nothing.
    const { projectId, agentId } = seedAgent();
    const LAPSED = lapsedFor(projectId, agentId);

    await sweepAt(LAPSED);

    expectUntouched(projectId, agentId);
    expect(goalStateOf(goalOf(projectId, agentId)!, LAPSED)).toBe("expired");
  });

  it("but NOT when the worktree is parked on another branch", async () => {
    // Also one field away. A parked tree's reading describes SOME OTHER branch, so attribution is
    // unknown and nothing may be concluded in either direction — measured at 21 of ~48 worktrees on
    // the founder's machine, so this is the highest-volume way a wrong latch could be written.
    const { projectId, agentId } = seedAgent();
    seedReading(agentId, { bs: { ...UNLANDED_BS, worktreeOnBranch: false } });

    await sweepAt(lapsedFor(projectId, agentId));

    expectUntouched(projectId, agentId);
  });

  it("but NOT for an agent with no worktree at all, however good the reading", async () => {
    // The capability gate, with the evidence deliberately present and adjudicable — so this proves
    // the gate refuses, rather than proving the fixture was unreachable. This is the exact state the
    // first version of this file seeded for EVERY case.
    const { projectId, agentId } = seedAgent({ worktree: false });
    seedReading(agentId, { bs: UNLANDED_BS });

    await sweepAt(lapsedFor(projectId, agentId));

    expectUntouched(projectId, agentId);
  });

  it("but NOT while the goal is still live — the arm only ever acts on `expired`", async () => {
    // Rule 1, proven through the mount. The instant is derived from the record, like every other one
    // here; a module-level constant is the defect this file already fixed once.
    const { projectId, agentId } = seedAgent();
    seedReading(agentId, { bs: UNLANDED_BS });

    await sweepAt(liveFor(projectId, agentId));

    expectUntouched(projectId, agentId);
  });
});

describe("the arm ABANDONS an agent that lapsed its whole budget still holding work", () => {
  it("latches abandonedAt and pages the human exactly once", async () => {
    // THE RED OUTCOME, end to end. `abandonedAt` is the field `engine/agentStall` keys the red
    // `abandoned-goal` cause on — and the first version of this arm called `escalateToHuman` without
    // the abandon variant, so it wrote an ordinary escalation, never set this field, and left the red
    // cause unreachable in production with `abandonAgentGoal` holding zero callers.
    const { projectId, agentId } = seedAgent();
    seedReading(agentId, { bs: UNLANDED_BS, ws: CLOSED_PR_WS });
    spendRearmBudget(projectId, agentId);
    const LAPSED = lapsedFor(projectId, agentId);

    await sweepAt(LAPSED);

    const after = goalOf(projectId, agentId)!;
    // THE VALUE, NOT THE PRESENCE. `toBeDefined()` cannot fail if `now` is dropped from the call
    // site: `?? Date.now()` supplies a plausible instant, and nothing here fakes the clock, so the
    // two differ by hours with no assertion noticing. The stamped instant must BE the deciding one.
    expect(after.abandonedAt).toBe(LAPSED);
    expect(after.abandonedEvidence).toContain("Nothing is coming to land it");
    // THE COPY IS PART OF THE OUTCOME. This evidence is the notification body a human reads, and the
    // shas it wants to cite are absent for every abandonment the mount can currently reach — so the
    // unguarded sentence rendered "committed work that undefined does not contain (branch tip
    // undefined)" to the founder.
    expect(after.abandonedEvidence).not.toContain("undefined");
    expect(vi.mocked(notifyAttention).mock.calls[0]?.[0].body).not.toContain("undefined");
    // It rides on the ESCALATION rather than being a fourth terminal state, which is what gives it
    // retry suppression and the amber floor for free.
    expect(goalStateOf(after, LAPSED)).toBe("escalated");
    expect(notifyAttention).toHaveBeenCalledTimes(1);
    // And it never re-arms past the budget — a fourth extension would be the slot held all night.
    expect(after.ttlRearms).toBe(MAX_TTL_REARMS);
  });

  it("but stays QUIET rather than abandoning when the PR state was never read", async () => {
    // One field away from the case above: no `workflowState`, so `hasOpenPr` is absent rather than
    // `false`. Abandoning there would be the did-not-look→nothing-there slide, on the one arm that
    // paints a row red.
    //
    // ⚠️ AND IT STAYS SILENT DELIBERATELY, after a louder version was written and reverted. Escalating
    // here reaches every CLOSED-PANE agent — the PR probe is gated on a mounted pane, so `hasOpenPr`
    // is absent for them whatever their real PR state — and it cannot be undone, because
    // `goalStateOf` short-circuits on `escalatedAt` before `expired`. That is the wall of amber the
    // module header forbids. The silence is a real gap, tracked as `sparkle-nmqcb`; it needs a PR
    // reading that works for an unmounted pane, not a louder refusal.
    const { projectId, agentId } = seedAgent();
    seedReading(agentId, { bs: UNLANDED_BS });
    spendRearmBudget(projectId, agentId);

    await sweepAt(lapsedFor(projectId, agentId));

    const after = goalOf(projectId, agentId)!;
    expect(after.abandonedAt).toBeUndefined();
    expect(after.escalatedAt).toBeUndefined();
    expect(notifyAttention).not.toHaveBeenCalled();
    // ⚠️ AND THE BUDGET IS STILL SPENT, which is what proves the sweep reached the arm this test
    // NAMES. Without it, a RE-ARM outcome satisfies all three absences verbatim — so a regression in
    // `spendRearmBudget`, or a change to `MAX_TTL_REARMS`, would leave this green while it silently
    // exercised a completely different arm. The abandon case beside it guards the same way.
    expect(after.ttlRearms).toBe(MAX_TTL_REARMS);
  });

  it("…and the refusal REASON is reported, so a silent agent is at least countable", async () => {
    // The quiet arm above is a real gap (`sparkle-nmqcb`), and a gap nobody can COUNT cannot be
    // sized or fixed. `applyExpiry` is skipped for a `none`, so the reason `decideExpiry` took such
    // care to name was computed and dropped: the sweep reported only `goal-expired`, identically for
    // an unreadable PR state, an unreadable proof and a parked worktree. It now travels in the
    // outcome — and only for refusals that describe a STUCK agent, so a healthy fleet stays silent.
    const { projectId, agentId } = seedAgent();
    seedReading(agentId, { bs: UNLANDED_BS });
    spendRearmBudget(projectId, agentId);

    const outcomes = await sweepAt(lapsedFor(projectId, agentId));

    expect(detailFor(outcomes, agentId)).toBe("expiry:none:pr-state-unknown");
  });

  it("but says NOTHING about a healthy agent whose goal has not lapsed", async () => {
    // The pair. `not-expired` is every healthy goal on every 15-second sweep, so reporting it would
    // bury the one line that matters — which is how a band of signal trains its reader to skip it.
    const { projectId, agentId } = seedAgent();
    seedReading(agentId, { bs: UNLANDED_BS });

    const outcomes = await sweepAt(liveFor(projectId, agentId));

    expect(detailFor(outcomes, agentId)).toBeUndefined();
  });

  it("logs a CHANGED reason, and does not repeat one it already reported", async () => {
    // THE POINT OF THE WIDENED KEY, and it had no coverage: keyed on the agent id alone, only the
    // FIRST reason was ever logged — and that one is systematically the least informative, because
    // `expiryProofFor` answers `undefined` while `branchStatus` is absent, which is exactly a
    // freshly-launched window. So the transient reading permanently suppressed the steady-state one.
    // This drives that exact transition: a sweep with no reading, then the reading arriving.
    const warn = vi.mocked(log.warn);
    const { projectId, agentId } = seedAgent();
    spendRearmBudget(projectId, agentId);
    const LAPSED = lapsedFor(projectId, agentId);

    await sweepAt(LAPSED);
    await sweepAt(LAPSED + 15_000);
    const first = warn.mock.calls.filter((c) => c[1] === "expiry could not decide");
    expect(first).toHaveLength(1);
    expect(first[0]![2]).toMatchObject({ reason: "evidence-unreadable" });

    // The branch probe lands, and the reason it yields is the actionable one.
    seedReading(agentId, { bs: UNLANDED_BS });
    await sweepAt(LAPSED + 30_000);

    const all = warn.mock.calls.filter((c) => c[1] === "expiry could not decide");
    expect(all).toHaveLength(2);
    expect(all[1]![2]).toMatchObject({ reason: "pr-state-unknown" });
  });

  it("forgets an agent that left the roster, so a row recreated under its id is heard again", async () => {
    // THE GARBAGE COLLECTION, and it is not housekeeping. Unpruned, the refusal set grows with every
    // agent id seen since app start rather than with the live roster — and, worse than the leak, a
    // row torn down and recreated under the same id stays permanently SILENT for any reason it had
    // already emitted, which is the exact suppression the widened key exists to remove.
    const warn = vi.mocked(log.warn);
    const { projectId, agentId } = seedAgent();
    spendRearmBudget(projectId, agentId);
    const LAPSED = lapsedFor(projectId, agentId);

    await sweepAt(LAPSED);
    const snapshot = useProjectStore.getState().projects;
    expect(warn.mock.calls.filter((c) => c[1] === "expiry could not decide")).toHaveLength(1);

    // The agent leaves the roster — a closed tab. This sweep is what prunes its key.
    useProjectStore.setState({ projects: [] } as never);
    useRuntimeStore.setState({ status: {}, openAgentIds: [] } as never);
    await sweepAt(LAPSED + 15_000);

    // …and comes back under the SAME id, which is what makes this more than a leak test.
    useProjectStore.setState({ projects: snapshot } as never);
    useRuntimeStore.setState({ status: { [agentId]: "idle" }, openAgentIds: [agentId] } as never);
    await sweepAt(LAPSED + 30_000);

    expect(warn.mock.calls.filter((c) => c[1] === "expiry could not decide")).toHaveLength(2);
  });

  it("but NOT while a PR is open — that work is with CI, not with the founder", async () => {
    const { projectId, agentId } = seedAgent();
    seedReading(agentId, { bs: UNLANDED_BS, ws: { ...CLOSED_PR_WS, prState: "open" } });
    spendRearmBudget(projectId, agentId);

    await sweepAt(lapsedFor(projectId, agentId));

    expect(goalOf(projectId, agentId)!.abandonedAt).toBeUndefined();
    expect(notifyAttention).not.toHaveBeenCalled();
  });
});

describe("a finished agent is neither re-armed nor closed on an unauditable proof", () => {
  it("refuses to discharge without the proving shas — and does not fall through to a re-arm", async () => {
    // ⚠️ KNOWN GAP, STATED RATHER THAN HIDDEN: there is no positive discharge case here because the
    // mount CANNOT reach one today. `BranchStatus` carries no commit shas, so `expiryProofFor` never
    // supplies `tipSha`/`baseSha` and `decideExpiry` always answers `proof-unauditable` for a landed,
    // clean agent. Closing that needs the shas plumbed through the Rust reading; until then this
    // asserts the refusal is TERMINAL, which is the part with a cost when wrong — falling through to
    // re-arm would resume an agent that already finished.
    //
    // It is also the pair for the re-arm positive: same agent, same sweep, and the only differences
    // are a landed reading and a clean tree.
    const { projectId, agentId } = seedAgent();
    seedReading(agentId, {
      bs: CLEAN_BS,
      ws: { ...CLOSED_PR_WS, inOriginMain: true, aheadOfBase: 0 },
      shipped: true,
    });

    await sweepAt(lapsedFor(projectId, agentId));

    expectUntouched(projectId, agentId);
  });
});

describe("the arm is not a bypass of the continuation budget", () => {
  it("does not auto-continue an expired agent it declined to act on", async () => {
    // The arm returns `none` and falls through to `decideContinuation`, which must still refuse on
    // `goal-expired`. If this ever sends, the expiry work has quietly re-opened the token burn the
    // TTL exists to bound.
    const { projectId, agentId } = seedAgent();
    const LAPSED = lapsedFor(projectId, agentId);

    await sweepAt(LAPSED);

    expect(goalOf(projectId, agentId)!.totalContinues).toBe(0);
    expect(dispatchConciergeAnswer).not.toHaveBeenCalled();
  });
});
