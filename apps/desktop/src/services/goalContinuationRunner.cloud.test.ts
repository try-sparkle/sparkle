// @vitest-environment jsdom
//
// GOAL AUTO-CONTINUATION FOR CLOUD AGENTS — the sweep that used to refuse every one of them.
//
// ══ WHY THIS IS A SEPARATE FILE FROM goalContinuationRunner.test.ts ══════════════════════════════
// That suite stubs `./conciergeDispatch`, which is the right seam for the questions it asks (did the
// runner decide to send, with what authority, exactly once). It is the WRONG seam for this one. The
// change being pinned is that the continuation prompt now REACHES A SANDBOX, and a stubbed
// dispatcher would report that for a build in which the delivery path did not exist — the vacuous
// shape AGENTS.md names. So here `conciergeDispatch` and `agentTransport` are both REAL, and the
// only double under them is the relay socket: every hop the fix depends on — the runner's gate,
// `dispatchConciergeAnswer`, `deliverCloudPrompt`, `getTransport`, `CloudTransport.write` — actually
// executes, and the assertion is the `agent_input` frame that came out the far end.
//
// ══ THIS FILE FAILS ON THE PRE-FIX BUILD ═════════════════════════════════════════════════════════
// The sweep fed `decideContinuation` the answer to `agentCanAcceptInput`, which is deliberately the
// LOCAL-PTY question and false for every cloud agent, so the decision was `cannot-accept-input` and
// nothing was ever emitted. The happy-path test below is red against that build; so is the
// escalation one, because the bounds sit AFTER the gates — a cloud agent was never nudged and never
// escalated either.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The LOCAL primitives. Nothing here may touch a PTY — but the paste framing is what travels on the
// wire, so those three stay REAL: a stubbed `stripPasteMarkers` would let the escape assertion pass
// against a payload that stripped nothing.
vi.mock("../pty", async () => {
  const actual = await vi.importActual<typeof import("../pty")>("../pty");
  return {
    PASTE_START: actual.PASTE_START,
    PASTE_END: actual.PASTE_END,
    stripPasteMarkers: actual.stripPasteMarkers,
    writePtyChainedStrict: vi.fn(async () => {}),
    submitPrompt: vi.fn(async () => {}),
    PtyGoneError: class extends Error {},
  };
});

const scrollback = vi.fn(() => "");
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: () => scrollback() }));

const detectTerminalPrompts = vi.fn(() => [] as SuggestionButton[]);
vi.mock("./suggestions/heuristics", () => ({
  detectTerminalPrompts: () => detectTerminalPrompts(),
}));

const trialSendAllowed = vi.fn(() => true);
vi.mock("./trialMeter", () => ({
  trialSendAllowed: () => trialSendAllowed(),
  recordTrialSend: vi.fn(async () => {}),
}));

vi.mock("./agentNaming", () => ({ maybeAutoName: vi.fn() }));
vi.mock("./aiGate", () => ({ aiFeatureNow: () => false }));

// THE ONLY DOUBLE UNDER THE TRANSPORT. `CloudTransport` reads this on every op, so faking it here
// exercises the real transport end to end.
let socket: FakeSocket | null = null;
vi.mock("./relayClient", () => ({ getRelaySocket: () => socket }));

// The "this agent needs you" path invokes Tauri; kept as a spy because "the human found out" is one
// of the side effects under test.
vi.mock("./attention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attention")>();
  return { ...actual, notifyAttention: vi.fn() };
});

import { PASTE_END, PASTE_START, submitPrompt, writePtyChainedStrict } from "../pty";
import { progressMark } from "../engine/goalContinuation";
import {
  noteSpinnerSeen,
  resetTurnEndAuthority,
  trackAgent,
} from "../engine/turnEndAuthority";
import { useAuthStore } from "../stores/authStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { AgentTabStatus } from "../types";
import type { SuggestionButton } from "./suggestions/types";
import { notifyAttention } from "./attention";
import { MAX_UNDELIVERED_CONTINUES } from "./goalContinuationRunner";
import { registerViewport, resetViewportRegistry } from "./terminalViewport";
import {
  noteCloudSessionStatus,
  resetCloudSessionStatusesForTests,
} from "./cloudAgents/sessionStatus";
import {
  _resetGoalContinuationRunnerForTests,
  canAcceptContinuation,
  sweepGoalContinuations,
} from "./goalContinuationRunner";
import { agentCanAcceptInput } from "./conciergeDispatch";

interface FakeSocket {
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
}
function fakeSocket(): FakeSocket {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
}

const notifyMock = vi.mocked(notifyAttention);
const ownsEverything = () => true;
/** No project in these tests carries a cloud binding, so the real refresher is never reachable —
 *  this is belt-and-braces so a suite can never make a request. */
const noRefresh = vi.fn(() => 0);

const T0 = 1_000_000;
/** Comfortably past IDLE_SETTLE_MS (45s). */
const SETTLED = T0 + 46_000;

/** Every `agent_input` payload the transport emitted, in order. */
function inputs(): Array<{ agent_id: string; text: string }> {
  return (socket?.emit.mock.calls ?? [])
    .filter(([event]) => event === "agent_input")
    .map(([, payload]) => payload as { agent_id: string; text: string });
}

function seed(opts: {
  runtime?: "local" | "cloud";
  goal?: string;
  status?: AgentTabStatus;
  /** The lifecycle reading this window holds for the sandbox. `null` = none (never listed). */
  sessionStatus?: string | null;
  /** Grant a turn-end witness. Default true. */
  authority?: boolean;
}): { projectId: string; agentId: string; agentName: string } {
  const store = useProjectStore.getState();
  const projectId = store.addProject("Demo", "/tmp/demo");
  const runtime = opts.runtime ?? "cloud";
  const agentId = useProjectStore.getState().addAgent(projectId, { kind: "build", runtime })!;
  if (opts.goal !== undefined) {
    useProjectStore.getState().setAgentGoal(projectId, agentId, opts.goal);
  }
  useRuntimeStore.setState({
    status: { [agentId]: opts.status ?? "idle" },
    openAgentIds: [agentId],
  } as never);
  if (opts.authority !== false) {
    // THE SPINNER, not the hook stream, and the distinction is the honest one for cloud: Claude
    // Code's hooks run inside the sandbox and never reach this Mac. What does reach it is the
    // sandbox's OUTPUT, relayed as `agent_output` frames into the same StatusEngine a local pane
    // uses (Terminal.tsx is transport-agnostic) — so the spinner latch is the witness a streaming
    // cloud pane genuinely has.
    trackAgent(agentId, "test-engine");
    noteSpinnerSeen(agentId, "test-engine");
  }
  if (runtime === "cloud" && opts.sessionStatus !== null) {
    noteCloudSessionStatus(agentId, opts.sessionStatus ?? "active", T0);
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

/** Two sweeps: the first starts the idle clock, the second is past the settle window. */
async function sweepTwice() {
  await sweepGoalContinuations({
    now: T0,
    ownsProject: ownsEverything,
    refreshCloudStatuses: noRefresh,
  });
  return sweepGoalContinuations({
    now: SETTLED,
    ownsProject: ownsEverything,
    refreshCloudStatuses: noRefresh,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  scrollback.mockReturnValue("");
  detectTerminalPrompts.mockReturnValue([]);
  trialSendAllowed.mockReturnValue(true);
  socket = fakeSocket();
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    branchStatus: {},
    workflowStage: {},
  } as never);
  // A funded account. The credit gate has its own test; everywhere else this keeps it out of the way.
  useAuthStore.setState({ me: { balanceCents: 5_000 } } as never);
  resetTurnEndAuthority();
  resetCloudSessionStatusesForTests();
  resetViewportRegistry();
  _resetGoalContinuationRunnerForTests();
});

afterEach(() => {
  useAuthStore.setState({ me: null } as never);
});

describe("a stalled CLOUD agent is actually resumed", () => {
  it("puts the continuation prompt on the relay as an agent_input frame", async () => {
    const { projectId, agentId } = seed({ goal: "land the cloud PR" });

    const outcomes = await sweepTwice();

    // THE SIDE EFFECT. One emit, addressed to this agent, carrying the goal — the write
    // `CloudTransport` actually performs. Nothing about the decision object is asserted here: a
    // dispatcher that returned success and wrote nothing would fail this line.
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]!.agent_id).toBe(agentId);
    expect(inputs()[0]!.text).toContain("land the cloud PR");
    // Framed as ONE bracketed paste plus its carriage return — a cloud submit cannot be two emits.
    expect(inputs()[0]!.text.startsWith(PASTE_START)).toBe(true);
    expect(inputs()[0]!.text.endsWith(`${PASTE_END}\r`)).toBe(true);
    // …and NOT down any local-PTY primitive. A cloud agent has no PTY on this machine.
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(writePtyChainedStrict).not.toHaveBeenCalled();

    expect(outcomes[0]).toMatchObject({ agentId, action: "continue", sent: true });

    // The retry is recorded, so the bounds can eventually bite for cloud too.
    const goal = goalOf(projectId, agentId)!;
    expect(goal.continues).toBe(1);
    expect(goal.totalContinues).toBe(1);
  });

  it("does not enter promptHistory — the resume is not the agent's own progress", async () => {
    // `userPrompt: false` all the way through the real cloud delivery path. If a resume grew
    // `promptHistory` the progress mark would move on every attempt, the consecutive streak would
    // reset forever and MAX_CONTINUES_WITHOUT_PROGRESS could never fire — for cloud specifically,
    // because this is the branch of the dispatcher a cloud send takes.
    const { projectId, agentId } = seed({ goal: "land the cloud PR" });
    await sweepTwice();
    const agent = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === agentId)!;
    expect(agent.promptHistory).toHaveLength(0);
  });

  it("re-arms the clock — one send per turn, exactly as for a local agent", async () => {
    seed({ goal: "land the cloud PR" });
    await sweepTwice();
    expect(inputs()).toHaveLength(1);
    // Still idle, still past the original threshold. Only the re-armed clock stops a second send.
    await sweepGoalContinuations({
      now: SETTLED + 15_000,
      ownsProject: ownsEverything,
      refreshCloudStatuses: noRefresh,
    });
    expect(inputs()).toHaveLength(1);
  });
});

describe("the sandboxes that must never be resumed", () => {
  it.each([
    ["paused", "cloud-session-paused"],
    ["waiting", "cloud-session-waiting"],
    ["pending", "cloud-session-starting"],
    ["complete", "cloud-session-ended"],
  ])("refuses a %s session as %s, and emits NOTHING", async (sessionStatus, reason) => {
    // A hibernated sandbox swallows input; a parked one is out of credits or asking its human.
    // Either way an auto-resume either vanishes or restarts billing nobody asked for.
    const { projectId, agentId } = seed({ goal: "land the cloud PR", sessionStatus });

    const outcomes = await sweepTwice();

    expect(inputs()).toEqual([]);
    expect(outcomes[0]).toMatchObject({ agentId, action: "none", detail: reason });
    // No retry spent either — a session the user paused must not burn its way to an escalation
    // that says "restarting cannot fix this" when restarting was never attempted.
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(0);
  });

  it("refuses an out-of-credits account by name, ahead of the lifecycle it caused", async () => {
    useAuthStore.setState({ me: { balanceCents: 0 } } as never);
    const { agentId } = seed({ goal: "land the cloud PR", sessionStatus: "waiting" });

    const outcomes = await sweepTwice();

    expect(inputs()).toEqual([]);
    expect(outcomes[0]).toMatchObject({ agentId, action: "none", detail: "cloud-out-of-credits" });
  });

  // THE FLOOR THIS ARM READS — pinned at the PRODUCER, because `cloudEvidenceFor` is where the wrong
  // number would be picked up and the pure decision function cannot tell which field fed it.
  it("refuses against the server's RESUME floor, which only the wiring can supply", async () => {
    // 4¢ clears the 1¢ fallback, so this refusal is reachable ONLY if `cloudEvidenceFor` actually
    // carried `minContinueCents` across. Delete that line and the sweep resumes instead.
    useAuthStore.setState({
      me: { balanceCents: 4, cloudAgentPricing: { centsPerMinute: 0.9, minContinueCents: 5 } },
    } as never);
    const { agentId } = seed({ goal: "land the cloud PR" });

    const outcomes = await sweepTwice();

    expect(inputs()).toEqual([]);
    expect(outcomes[0]).toMatchObject({ agentId, action: "none", detail: "cloud-out-of-credits" });
  });

  it("does NOT apply the server's START floor to a resume — that strands purchased runway", async () => {
    // THE MONEY BUG, guarded at its entry point. `/me` states the $1 spawn floor and NO resume floor
    // (an older orchestration build). 50¢ is far below the start bar and far above the ~5¢ this
    // resume actually costs — the server would allow it, and there is no round-trip afterwards to
    // correct a local refusal. So the agent must be RESUMED. Substituting `minStartCents` here (as an
    // earlier draft of this file did) reds this: the wallet is refused and the goal is abandoned by a
    // background timer with nothing on screen to explain it.
    useAuthStore.setState({
      me: { balanceCents: 50, cloudAgentPricing: { centsPerMinute: 0.9, minStartCents: 100 } },
    } as never);
    const { agentId } = seed({ goal: "land the cloud PR" });

    const outcomes = await sweepTwice();

    // The SIDE EFFECT, not merely the absence of a refusal: the resume really went out on the relay.
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]!.text).toContain("land the cloud PR");
    expect(outcomes[0]).toMatchObject({ agentId, action: "continue", sent: true });
  });

  it("refuses a session this window has no CURRENT reading of", async () => {
    // The fail-closed arm. A lifecycle reading is a snapshot of a remote machine and expires; with
    // none, the honest answer is "I do not know", never "active".
    const { agentId } = seed({ goal: "land the cloud PR", sessionStatus: null });

    const outcomes = await sweepTwice();

    expect(inputs()).toEqual([]);
    expect(outcomes[0]).toMatchObject({ agentId, action: "none", detail: "cloud-session-unknown" });
  });

  it("refuses when the relay is down — and says so, rather than reporting a phantom send", async () => {
    // `CloudTransport.write` no-ops on a null socket, so without this gate a dropped resume would be
    // recorded as delivered: a retry spent against a mark that cannot move.
    socket = null;
    const { projectId, agentId } = seed({ goal: "land the cloud PR" });

    const outcomes = await sweepTwice();

    expect(outcomes[0]).toMatchObject({ agentId, action: "none", detail: "cloud-offline" });
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(0);
  });

  it("refuses a cloud agent whose sandbox this window is not streaming", async () => {
    // No turn-end witness: `idle` here is "we have received nothing", which is equally consistent
    // with a sandbox running a six-minute test. Same rule as local, same refusal.
    const { agentId } = seed({ goal: "land the cloud PR", authority: false });
    const outcomes = await sweepTwice();
    expect(inputs()).toEqual([]);
    expect(outcomes[0]).toMatchObject({ agentId, action: "none", detail: "no-turn-end-authority" });
  });
});

describe("escalation reaches the human for cloud too", () => {
  it("gives up after the bound and says WHERE the agent is", async () => {
    const { projectId, agentId, agentName } = seed({ goal: "land the cloud PR" });
    // Spend the consecutive-retry budget WITHOUT moving the mark. It has to be the mark the sweep
    // will itself compute for this agent (no prompts, no activity, no ai title) — a different
    // string reads as progress, resets the streak, and the escalation never fires.
    for (let i = 0; i < 3; i++) {
      useProjectStore
        .getState()
        .noteAgentGoalContinue(projectId, agentId, progressMark({ promptHistoryLength: 0 }));
    }

    const outcomes = await sweepTwice();

    // Escalation REPLACES the restart — nothing went on the wire.
    expect(inputs()).toEqual([]);
    expect(outcomes[0]).toMatchObject({ agentId, action: "escalate" });

    // The human actually finds out, through the app's ordinary attention path.
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const notice = notifyMock.mock.calls[0]![0];
    expect(notice).toMatchObject({ projectId, agentId });
    expect(notice.title).toContain(agentName);
    expect(notice.body).toContain("land the cloud PR");
    // …and the body is TRUE for a cloud agent. The local wording sends someone hunting for a pane
    // on this Mac while the sandbox keeps billing.
    expect(notice.body).toContain("CLOUD sandbox");
    expect(notice.body).toContain("nothing on this Mac will restart it");

    expect(goalOf(projectId, agentId)!.escalatedAt).toBeDefined();
  });
});

describe("keeping the lifecycle readings fresh", () => {
  // The PRODUCER half. `cloudSessionStatusOf` expires its readings on purpose, so without a
  // refresher every cloud agent ages into `cloud-session-unknown` a few minutes after the project
  // opened and the feature quietly dies again — with a green suite, because every gate would still
  // be doing exactly what it says. Deleting the call has to fail something.
  it("re-lists a project that has a cloud agent chasing a goal", async () => {
    const { projectId } = seed({ goal: "land the cloud PR" });
    useProjectStore.getState().setCloudProjectId(projectId, "srv-1");

    await sweepGoalContinuations({
      now: T0,
      ownsProject: ownsEverything,
      refreshCloudStatuses: noRefresh,
    });

    // Keyed by the SERVER project id — the listing endpoint knows nothing about local ids.
    expect(noRefresh).toHaveBeenCalledWith("srv-1", T0);
  });

  it("issues no request for a project with no cloud binding, or no cloud agent with a goal", async () => {
    // A local-only user must never touch the network from this sweep.
    seed({ goal: "land the cloud PR" }); // cloud agent, but the project was never bound
    const { projectId: p2 } = seed({ runtime: "local", goal: "land the local PR" });
    useProjectStore.getState().setCloudProjectId(p2, "srv-2");

    await sweepGoalContinuations({
      now: T0,
      ownsProject: ownsEverything,
      refreshCloudStatuses: noRefresh,
    });

    expect(noRefresh).not.toHaveBeenCalled();
  });

  it("stops re-listing once the goal is MET — a finished goal is not 'chasing' one", async () => {
    // `AgentTab.goal` is never cleared: `goalStateOf` reads `met` off a record that stays defined.
    // A presence check therefore polled forever, once a minute per bound project, for readings the
    // decision can never act on — it answers `goal-met` before it ever looks at the cloud evidence
    // (roborev 58287). The guard is the same `hasUnmetGoal` the decision uses.
    const { projectId, agentId } = seed({ goal: "land the cloud PR" });
    useProjectStore.getState().setCloudProjectId(projectId, "srv-5");
    useProjectStore.getState().setAgentGoalMet(projectId, agentId, true);

    await sweepGoalContinuations({
      now: T0,
      ownsProject: ownsEverything,
      refreshCloudStatuses: noRefresh,
    });

    expect(noRefresh).not.toHaveBeenCalled();
  });

  it("does not re-list a project another window owns", async () => {
    // The ownership election stops two windows both acting on one agent; it should stop them both
    // polling for it too.
    const { projectId } = seed({ goal: "land the cloud PR" });
    useProjectStore.getState().setCloudProjectId(projectId, "srv-3");

    await sweepGoalContinuations({
      now: T0,
      ownsProject: () => false,
      refreshCloudStatuses: noRefresh,
    });

    expect(noRefresh).not.toHaveBeenCalled();
  });

  it("survives a refresher that throws — the sweep still decides every agent", async () => {
    const { projectId, agentId } = seed({ goal: "land the cloud PR" });
    useProjectStore.getState().setCloudProjectId(projectId, "srv-4");
    const boom = () => {
      throw new Error("refresh exploded");
    };

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything, refreshCloudStatuses: boom });
    const outcomes = await sweepGoalContinuations({
      now: SETTLED,
      ownsProject: ownsEverything,
      refreshCloudStatuses: boom,
    });

    expect(outcomes[0]).toMatchObject({ agentId, action: "continue", sent: true });
    expect(inputs()).toHaveLength(1);
  });
});

describe("LOCAL behaviour is unchanged", () => {
  it("continues a local agent with no relay, no session reading and no balance", async () => {
    // The direction a careless fix breaks: applying the cloud gates to everything. A local agent
    // must be judged by the local rules only, and the three facts a cloud agent needs are all
    // absent in an ordinary local-only session.
    socket = null;
    useAuthStore.setState({ me: null } as never);
    const { agentId } = seed({ runtime: "local", goal: "land the local PR" });

    const outcomes = await sweepTwice();

    expect(outcomes[0]).toMatchObject({ agentId, action: "continue", sent: true });
    // It went down the LOCAL path — `submitPrompt`, not the relay.
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(inputs()).toEqual([]);
  });

  it("still refuses a local agent whose PTY has exited", async () => {
    // THE DEAD-PTY REFUSAL, restated here because this change is what widened the gate's remit.
    // `done` is a resting status, so the unmerged overlay relabels it exactly as it does a live idle
    // row, and both `canAcceptContinuation` (true for any local agent) and the turn-end witness (an
    // exited PTY is the STRONGEST one) wave it through. Only `processAlive` separates the two.
    const { projectId, agentId } = seed({ runtime: "local", goal: "merge it", status: "done" });
    useRuntimeStore.setState({ workflowStage: { [agentId]: "building_saved" } } as never);

    const outcomes = await sweepTwice();

    expect(outcomes[0]).toMatchObject({ agentId, action: "none", detail: "process-gone" });
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(inputs()).toEqual([]);
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(0);
  });

  it("asks each runtime ITS OWN reachability question", async () => {
    // The one-line bug this whole file exists for, pinned as arithmetic. `agentCanAcceptInput` is
    // the local-PTY question and is false for a cloud agent — feeding it to the sweep is what killed
    // the feature. A blanket swap to the prompt question would have fixed cloud by loosening local;
    // routing per runtime fixes cloud and leaves the local gate exactly where it was.
    const cloud = seed({ goal: "g" });
    const local = seed({ runtime: "local", goal: "g" });
    const cloudTab = { id: cloud.agentId, runtime: "cloud" as const };
    const localTab = { id: local.agentId, runtime: "local" as const };

    expect(agentCanAcceptInput(cloud.agentId)).toBe(false); // unchanged: no PTY to write bytes to
    expect(canAcceptContinuation(cloudTab)).toBe(true); //     but a PROMPT has a route

    // The local answer is still the local predicate's, not a looser one.
    expect(canAcceptContinuation(localTab)).toBe(agentCanAcceptInput(local.agentId));
    expect(canAcceptContinuation(localTab)).toBe(true);

    // …and both fail closed on an id the store never heard of.
    expect(canAcceptContinuation({ id: "ghost", runtime: "cloud" })).toBe(false);
    expect(canAcceptContinuation({ id: "ghost", runtime: "local" })).toBe(false);
  });
});

describe("the escalation copy never names a terminal a cloud agent does not have", () => {
  /** Drive `n` eligible sweeps; each send re-arms the idle clock, so each needs a fresh window. */
  async function sweepUntilEligible(n: number) {
    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything, refreshCloudStatuses: noRefresh });
    for (let i = 0; i < n; i++) {
      await sweepGoalContinuations({
        now: SETTLED + i * 46_000,
        ownsProject: ownsEverything,
        refreshCloudStatuses: noRefresh,
      });
    }
  }

  it("keys the closing on the RUNTIME, not the path — a cloud agent CAN refuse with blocked-prompt", async () => {
    // THE PROXY THAT LEAKED (roborev 58544). The cloud-named paths are not the only ones a cloud
    // agent produces: `dispatchConciergeAnswer` runs the screen guards BEFORE the cloud branch, and
    // both read the RELAYED viewport. This drives the REAL refusal — a credential prompt on the
    // sandbox's screen — rather than stubbing the path string, so what it pins is that a cloud
    // agent genuinely reaches `blocked-prompt`, and that the copy stays honest when it does.
    detectTerminalPrompts.mockReturnValue([]); // a real credential prompt is not a menu
    const { projectId, agentId } = seed({ goal: "land the PR" });
    // The REAL viewport registry, not a mock — this is what a streaming cloud pane populates, and
    // it is what the screen guards read. Registering it here is what makes the refusal genuine
    // rather than a stubbed path string.
    registerViewport(agentId, () => ({ text: "[sudo] password for user:", alternateBuffer: false }));

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    const reason = goalOf(projectId, agentId)!.escalationReason;
    expect(reason).toBeDefined();
    expect(reason).toContain("Nothing reached the sandbox");
    // MATCHES THE TITLE, not a narrower substring. The earlier assertion checked only "typed into
    // the terminal", which let the `why` clause keep saying "its terminal is waiting at a prompt"
    // one sentence earlier — the block claimed the copy never names a terminal while proving only
    // that one phrase was absent (roborev 58551).
    expect(reason).not.toMatch(/terminal/i);
    expect(reason).toContain("its sandbox screen");
  });

  it("a live picker on the sandbox screen sends the human to its PANE, not a path name", async () => {
    // Reaches `cloud-agent` the real way: `deliverCloudPrompt` refuses when the detector finds live
    // options in the RELAYED scrollback, because the agent is asking something only a human can
    // answer. Restored here after being deleted with the local-harness version, where a cloud agent
    // could not be dispatched at all.
    scrollback.mockReturnValue("1. Yes  2. No");
    detectTerminalPrompts.mockReturnValue([
      { id: "b1", label: "Yes", value: "1\n", kind: "terminal", source: "heuristic" },
      { id: "b2", label: "No", value: "2\n", kind: "terminal", source: "heuristic" },
    ] as SuggestionButton[]);
    const { projectId, agentId } = seed({ goal: "land the PR" });

    await sweepUntilEligible(MAX_UNDELIVERED_CONTINUES);

    const reason = goalOf(projectId, agentId)!.escalationReason!;
    expect(reason).toContain("Open its pane and answer it there");
    // The default arm quotes the path at a user who cannot act on it.
    expect(reason).not.toContain('kept coming back "cloud-agent"');
    expect(reason).not.toMatch(/terminal/i);
  });

  // NO SWEEP TEST FOR `cloud-offline`, and that is a statement about the code rather than a gap.
  // `cloudEvidenceFor` reads `relayConnected` and `decideContinuation` refuses a disconnected
  // session BEFORE dispatching, so the sweep cannot normally produce that path — the arm survives
  // as a backstop for the narrow race where the socket drops between the decision and the write.
  // A test that forced it would have to defeat the earlier gate, which would pin a shape the app
  // does not have. The arm's copy is exercised by the dispatcher's own suite.
});
