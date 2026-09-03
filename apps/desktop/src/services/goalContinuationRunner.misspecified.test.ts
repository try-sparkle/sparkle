// @vitest-environment jsdom
//
// THE RUNNER THAT SPENDS MONEY, on a goal no agent can satisfy (bead sparkle-hrzitj, failure 4).
//
// The engine's arithmetic is tested next door in engine/goalContinuation.misspecified.test.ts. What
// is untested until here is whether the SWEEP gathers the merge-authority reading at all — the
// `goal-misspecified` gate is dead code that still typechecks if this file's evidence never reaches
// `decideContinuation`, which is exactly the failure `ContinuationInput.quotaBlock` warns about.
//
// Every assertion is on a SIDE EFFECT: text that reached the terminal, a counter the store advanced,
// a banner the human got. And every one is PAIRED with the identical fleet under a repo Sparkle IS
// allowed to merge in, so a gate that simply refused everything would fail these.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { progressMark } from "../engine/goalContinuation";
import { noteHooksLive, resetTurnEndAuthority, trackAgent } from "../engine/turnEndAuthority";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";

vi.mock("./conciergeDispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./conciergeDispatch")>();
  return {
    ...actual,
    dispatchConciergeAnswer: vi.fn(async (agentId: string, text: string) => ({
      ok: true,
      path: "free-text" as const,
      agentId,
      sent: text,
      display: text,
    })),
  };
});

vi.mock("./attention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attention")>();
  return { ...actual, notifyAttention: vi.fn() };
});

import { notifyAttention } from "./attention";
import { dispatchConciergeAnswer } from "./conciergeDispatch";
import { log } from "../logger";
import { __clearRepoSlugCache, __setRepoSlugForTest } from "./conciergeTools/repoSlug";
import {
  _resetGoalContinuationRunnerForTests,
  continuationEvidenceFor,
  sweepGoalContinuations,
} from "./goalContinuationRunner";

const sendMock = vi.mocked(dispatchConciergeAnswer);
const notifyMock = vi.mocked(notifyAttention);
const ownsEverything = () => true;

const T0 = 1_000_000;
/** Comfortably past IDLE_SETTLE_MS (45s). */
const SETTLED = T0 + 46_000;
const ROOT = "/tmp/demo";

/** The goal text observed on the stranded row, verbatim from the bead. */
const OBSERVED_GOAL = "Land PR #91 on main";
/** A repo on the shipped merge-protected list — only a person may ever merge there. */
const PROTECTED_SLUG = "plow-pbc/tkmx-client";
/** The paired control: our own repo, where the identical goal is perfectly achievable. */
const OUR_SLUG = "drodio/sparkle";

const FRESH_MARK = progressMark({ promptHistoryLength: 0 });

function seed(goal: string): { projectId: string; agentId: string } {
  const store = useProjectStore.getState();
  const projectId = store.addProject("Demo", ROOT);
  const agentId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
  useProjectStore.getState().setAgentGoal(projectId, agentId, goal);
  useRuntimeStore.setState({ status: { [agentId]: "idle" }, openAgentIds: [agentId] } as never);
  trackAgent(agentId, "test-engine");
  noteHooksLive(agentId);
  return { projectId, agentId };
}

function goalOf(projectId: string, agentId: string) {
  return useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)!
    .agents.find((a) => a.id === agentId)!.goal;
}

/** Spend the consecutive-retry budget without moving the mark, exactly as the sibling suite does. */
function burnRetries(projectId: string, agentId: string, times: number): void {
  for (let i = 0; i < times; i++) {
    useProjectStore.getState().noteAgentGoalContinue(projectId, agentId, FRESH_MARK);
  }
}

/** Two sweeps: the first starts the idle clock, the second is the eligible one. */
async function twoSweeps(): Promise<void> {
  await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
  await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    branchStatus: {},
    workflowStage: {},
    workflowState: {},
    agentMovement: {},
  } as never);
  resetTurnEndAuthority();
  _resetGoalContinuationRunnerForTests();
  __clearRepoSlugCache();
  sendMock.mockClear();
  notifyMock.mockClear();
});

afterEach(() => {
  __clearRepoSlugCache();
});

describe("the sweep gathers the merge-authority reading", () => {
  it("reports a merge-protected repo as such", () => {
    __setRepoSlugForTest(ROOT, PROTECTED_SLUG);
    const { projectId, agentId } = seed(OBSERVED_GOAL);
    const agent = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === agentId)!;
    expect(continuationEvidenceFor(agent).mergeAuthority).toEqual({
      mergeProtectedRepo: true,
      repo: PROTECTED_SLUG,
    });
  });

  it("reports our own repo as mergeable", () => {
    __setRepoSlugForTest(ROOT, OUR_SLUG);
    const { projectId, agentId } = seed(OBSERVED_GOAL);
    const agent = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === agentId)!;
    expect(continuationEvidenceFor(agent).mergeAuthority).toEqual({
      mergeProtectedRepo: false,
      repo: OUR_SLUG,
    });
  });

  it("reports COULD-NOT-TELL for a root whose slug has not resolved", () => {
    // The cache is cold. Not `false` — see mergeAuthorityFor: a cache miss and "no GitHub slug we
    // recognise" are the same value at that seam, and both must leave the goal ORDINARY.
    const { projectId, agentId } = seed(OBSERVED_GOAL);
    const agent = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === agentId)!;
    expect(continuationEvidenceFor(agent).mergeAuthority).toBeUndefined();
  });
});

describe("a goal requiring a forbidden merge costs nothing", () => {
  it("SPENDS NO CONTINUE — nothing is typed into the terminal", async () => {
    __setRepoSlugForTest(ROOT, PROTECTED_SLUG);
    const { projectId, agentId } = seed(OBSERVED_GOAL);

    await twoSweeps();

    expect(sendMock, "a restart cannot make a forbidden merge happen").not.toHaveBeenCalled();
    // …and the ALLOWANCE is untouched, which is the fourteen-auto-continue harm itself.
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(0);
    expect(goalOf(projectId, agentId)!.continues).toBe(0);
  });

  it("PAIRED — the identical fleet in our own repo IS restarted", async () => {
    // Without this the assertion above passes for a sweep that has simply stopped working.
    __setRepoSlugForTest(ROOT, OUR_SLUG);
    const { projectId, agentId } = seed(OBSERVED_GOAL);

    await twoSweeps();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(1);
  });

  it("NEVER PAGES A HUMAN at the streak bound — the diagnosis would be false", async () => {
    __setRepoSlugForTest(ROOT, PROTECTED_SLUG);
    const { projectId, agentId } = seed(OBSERVED_GOAL);
    burnRetries(projectId, agentId, 3);

    await twoSweeps();

    expect(notifyMock, "nothing is blocking the AGENT").not.toHaveBeenCalled();
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("PAIRED — the identical streak in our own repo DOES page a human", async () => {
    __setRepoSlugForTest(ROOT, OUR_SLUG);
    const { projectId, agentId } = seed(OBSERVED_GOAL);
    burnRetries(projectId, agentId, 3);

    await twoSweeps();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(goalOf(projectId, agentId)!.escalatedAt).toBeDefined();
  });

  it("says WHY, in a sentence naming the rewrite", async () => {
    __setRepoSlugForTest(ROOT, PROTECTED_SLUG);
    const { agentId } = seed(OBSERVED_GOAL);

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    const outcomes = await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    const mine = outcomes.find((o) => o.agentId === agentId)!;
    expect(mine.action).toBe("none");
    expect(mine.detail).toContain("goal-misspecified");
    expect(mine.detail, "a bare reason token reproduces the silence this ends").toContain(
      "REWRITE THE GOAL",
    );
    expect(mine.detail).toContain(PROTECTED_SLUG);
  });
});

describe("an unproven repo leaves the sweep exactly as it was", () => {
  it("restarts a merge goal when the slug has not resolved", async () => {
    // No __setRepoSlugForTest: could-not-tell must never buy silence.
    const { projectId, agentId } = seed(OBSERVED_GOAL);

    await twoSweeps();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(1);
  });

  // THE REMEDY IS LOGGED ONCE PER AGENT, NOT ONCE PER SWEEP (roborev 78977).
  //
  // `goal-misspecified` is a function of the goal text and the repo's merge protection, evaluated
  // ahead of every status gate, and NOTHING CLEARS IT — the goal stands until a human rewrites it.
  // So an ungated log re-emits the identical line every 15s sweep, ~5.7k lines/day/agent, which is
  // the wall of noise that trains a reader to skip the band — and the band is the surface the remedy
  // was routed to in the first place. Asserted on the SIDE EFFECT (how many times the sink was
  // called), across TWO eligible sweeps, because one sweep cannot tell a dedupe from a no-op.
  it("logs the remedy ONCE across repeated sweeps, not once per sweep", async () => {
    __setRepoSlugForTest(ROOT, PROTECTED_SLUG);
    seed(OBSERVED_GOAL);
    const infoSpy = vi.spyOn(log, "info");

    await twoSweeps();
    const remedyLines = () =>
      infoSpy.mock.calls.filter((c) => c[1] === "goal is mis-specified").length;
    expect(remedyLines(), "the first eligible sweep says it once").toBe(1);

    // A THIRD sweep, well past the second: the state is unchanged, so it must stay silent.
    await sweepGoalContinuations({ now: SETTLED + 60_000, ownsProject: ownsEverything });
    expect(remedyLines(), "a later sweep on unchanged state must not repeat it").toBe(1);
    // …and the remedy text really was carried, so this is not passing because nothing was logged.
    const call = infoSpy.mock.calls.find((c) => c[1] === "goal is mis-specified");
    expect(String((call?.[2] as { remedy?: string })?.remedy)).toMatch(/rewrite/i);
    infoSpy.mockRestore();
  });

  // A SECOND MIS-SPECIFIED GOAL ON THE SAME AGENT MUST STILL BE REPORTED (roborev 79562).
  //
  // The dedupe above must not become the silence it replaced. `decision.reason` is the constant
  // token `goal-misspecified`, so a key built from it alone muted every later goal on that agent —
  // and the expected follow-up to the line is a human doing what it says and REWRITING the goal. If
  // the rewrite still names a merge in a protected repo (the likeliest second draft) the gate fires
  // again, nothing pages, and the log was suppressed: the row goes quiet.
  it("reports a SECOND, different mis-specified goal on the same agent", async () => {
    __setRepoSlugForTest(ROOT, PROTECTED_SLUG);
    const { projectId, agentId } = seed(OBSERVED_GOAL);
    const infoSpy = vi.spyOn(log, "info");
    const remedyLines = () =>
      infoSpy.mock.calls.filter((c) => c[1] === "goal is mis-specified").length;

    await twoSweeps();
    expect(remedyLines()).toBe(1);

    // The human rewrites it — and the rewrite is STILL unsatisfiable.
    useProjectStore.getState().setAgentGoal(projectId, agentId, "get PR #91 merged into main");
    await sweepGoalContinuations({ now: SETTLED + 60_000, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED + 120_000, ownsProject: ownsEverything });

    expect(remedyLines(), "the new goal is a new fact and must be said").toBe(2);
    const second = infoSpy.mock.calls.filter((c) => c[1] === "goal is mis-specified")[1];
    expect(String((second?.[2] as { remedy?: string })?.remedy)).toContain("#91");
    infoSpy.mockRestore();
  });

  it("restarts an ordinary goal in a merge-protected repo", async () => {
    __setRepoSlugForTest(ROOT, PROTECTED_SLUG);
    const { projectId, agentId } = seed("PR #91 is open, green and handed to a human");

    await twoSweeps();

    expect(sendMock, "the repo pin is not a reason to stop working there").toHaveBeenCalledTimes(1);
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(1);
  });
});
