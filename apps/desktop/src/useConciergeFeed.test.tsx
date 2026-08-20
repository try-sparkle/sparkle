// @vitest-environment jsdom
// The hook is a thin subscription shell over buildConciergeFeed (exhaustively tested in
// services/conciergeFeed.test.ts) — these tests cover only the wiring: store subscriptions
// produce a live feed, mute-rule changes re-render it, and the pin opt scopes it. Outside Tauri
// the tray fetch/subscription are no-ops (services/attention), so no mocking is needed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useConciergeFeed, selectAndOpen } from "./useConciergeFeed";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSparklePrefsStore } from "./stores/sparklePrefsStore";
import { resetRetractionLedgerForTests } from "./engine/movementRetraction";
import { __setAuthRecoveryDeps, pollNudgeFlags } from "./services/authRecovery";
import { noteThrashEvent, resetThrashTracking, NUDGE_LOOP_LIMIT } from "./engine/agentThrash";
import type { AgentTab, Project } from "./types";

function agent(id: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, promptHistory: [],
    runtime: "local", worktreePath: null, ...over,
  } as AgentTab;
}

function project(id: string, agents: AgentTab[]): Project {
  return {
    id, name: `Proj ${id}`, rootPath: `/${id}`, defaultBranch: "main",
    createdAt: "", agents, selectedAgentId: null,
  } as Project;
}

beforeEach(() => {
  useProjectStore.setState({
    projects: [project("pA", [agent("a1")]), project("pB", [agent("b1")])],
  });
  useRuntimeStore.setState({ status: { a1: "waiting", b1: "working" }, agentMovement: {} });
  useSparklePrefsStore.setState({ rules: {} });
  // The red-epoch ledger is window-scoped module state (see engine/movementRetraction) — a red left
  // stamped by one case would silently decide the next one's retraction.
  resetRetractionLedgerForTests();
});

describe("useConciergeFeed", () => {
  it("returns the live feed and re-renders when a status changes", () => {
    const { result } = renderHook(() => useConciergeFeed());
    // a1 waiting → needs_you; b1 working → running.
    expect(result.current.scopedCounts).toEqual({ needs_you: 1, questions: 0, running: 1, done: 0 });

    act(() => {
      useRuntimeStore.setState({ status: { a1: "waiting", b1: "blocked" } });
    });
    // b1 moved out of Running and joined a1 in Needs-you — `blocked` is no longer its own tier.
    expect(result.current.scopedCounts).toEqual({ needs_you: 2, questions: 0, running: 0, done: 0 });
  });

  it("re-renders when a mute rule lands, dimming the item out of the scoped counts", () => {
    const { result } = renderHook(() => useConciergeFeed());
    expect(result.current.scopedCounts.needs_you).toBe(1);

    act(() => {
      useSparklePrefsStore.getState().setInterruptPreference("a1", "mute");
    });
    expect(result.current.scopedCounts.needs_you).toBe(0);
    const a1 = result.current.projects[0]!.agents.find((a) => a.id === "a1")!;
    expect(a1.muted).toBe(true); // still listed — the UI dims it, the concierge stays quiet
  });

  it("scopes to the pinned project while still listing everything", () => {
    const { result } = renderHook(() => useConciergeFeed({ pinnedProjectId: "pB" }));
    expect(result.current.scopedCounts).toEqual({ needs_you: 0, questions: 0, running: 1, done: 0 }); // pA is out of scope
    expect(result.current.counts).toEqual({ needs_you: 1, questions: 0, running: 1, done: 0 }); // full truth unchanged
    expect(result.current.projects).toHaveLength(2);
  });

  it("re-exports selectAndOpen as the jump action", () => {
    expect(typeof selectAndOpen).toBe("function");
  });
});

// ── THE RETRACTION WIRING (bead sparkle-7ba9e) ────────────────────────────────────────────────
//
// buildConciergeFeed retracts on evidence, and engine/movementRetraction.test.ts proves the rule —
// but BOTH are fed their inputs explicitly. Nothing else asserts that this hook actually hands the
// builder `agentMovement` and a red-epoch ledger, so deleting either argument here would restore
// the latched-pill bug with every one of those tests still green.
describe("movement retraction is wired through the hook", () => {
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    resetRetractionLedgerForTests();
    // THE CLOCK IS CONTROLLED, and that is what makes the scope cases below able to FAIL. They used
    // to inject movement at `Date.now() + 60_000` — a FUTURE instant, which beats any epoch the code
    // could stamp, including a freshly-created per-instance one. Both passed against the very
    // `useRef` behaviour they were named after: the canonical vacuous shape, where the assertion was
    // already true before the change. Driving real time instead means a re-stamped epoch genuinely
    // out-runs the recorded movement, so a regression shows up as a failure.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  /** A frozen red: `a1` is `blocked` and never leaves it, exactly as an agent whose project has no
   *  mounted pane behaves — AgentPane is the only writer of `status`. */
  const frozenBlocked = () => useRuntimeStore.setState({ status: { a1: "blocked", b1: "working" } });

  const moved = (atMs: number) =>
    act(() => {
      useRuntimeStore.getState().setAgentMovement({
        a1: { lastEvent: "PostToolUse", lastEventMs: atMs, sessionId: null, toolsRecent: null },
      });
    });

  it("de-escalates a frozen red once the digest shows the agent acted after it", () => {
    frozenBlocked();
    const { result } = renderHook(() => useConciergeFeed());
    expect(result.current.counts.needs_you).toBe(1);

    vi.setSystemTime(T0 + 30_000);
    moved(T0 + 20_000);

    // The status is STILL `blocked` — nothing retracted it but the artifact evidence.
    expect(useRuntimeStore.getState().status.a1).toBe("blocked");
    expect(result.current.counts.needs_you).toBe(0);
  });

  it("keeps the red when the agent's only act came BEFORE it", () => {
    frozenBlocked();
    const { result } = renderHook(() => useConciergeFeed());
    vi.setSystemTime(T0 + 30_000);
    moved(T0 - 60_000);
    expect(result.current.counts.needs_you).toBe(1);
  });

  // THE ONE A PER-INSTANCE `useRef` FAILED. Workspace unmounts on an auth lapse, a readiness overlay
  // or a Suspense re-suspend; with the ledger inside the component, remounting re-stamped this
  // still-frozen red with a NEW epoch that the earlier movement could no longer beat, and the
  // retracted pill came back — permanently, since a quiet agent produces no newer evidence.
  //
  // The clock makes that concrete: the red is stamped at T0, movement lands at T0+20s, and the
  // remount happens at T0+60s. A per-instance ledger would stamp T0+60s > T0+20s and re-raise; the
  // window ledger keeps T0 and stays retracted.
  it("does not resurrect a retracted pill when the consumer unmounts and remounts", () => {
    frozenBlocked();
    const first = renderHook(() => useConciergeFeed());
    vi.setSystemTime(T0 + 30_000);
    moved(T0 + 20_000);
    expect(first.result.current.counts.needs_you).toBe(0);

    first.unmount();
    vi.setSystemTime(T0 + 60_000);
    const second = renderHook(() => useConciergeFeed());
    expect(second.result.current.counts.needs_you).toBe(0);
  });

  // The island (App.tsx, never unmounts) and the column (inside Workspace) must not disagree about
  // the same agent. The second consumer mounts LATE — after the movement — so a per-instance ledger
  // would stamp an epoch the movement cannot beat and show a pill the island does not.
  it("gives two concurrent consumers the same answer", () => {
    frozenBlocked();
    const island = renderHook(() => useConciergeFeed());
    vi.setSystemTime(T0 + 30_000);
    moved(T0 + 20_000);
    expect(island.result.current.counts.needs_you).toBe(0);

    vi.setSystemTime(T0 + 60_000);
    const column = renderHook(() => useConciergeFeed());
    expect(column.result.current.counts.needs_you).toBe(0);
    expect(island.result.current.counts.needs_you).toBe(0);
  });

  // A consumer that mounts before its cross-window roster arrives sees a PARTIAL status map. The
  // ledger is shared, so pruning on "absent from the status map" would let that mount wipe the
  // episodes of exactly the unhosted reds only the roster knows about — for every consumer at once.
  it("survives a consumer whose status view does not yet include the agent", () => {
    frozenBlocked();
    const island = renderHook(() => useConciergeFeed());
    vi.setSystemTime(T0 + 30_000);
    moved(T0 + 20_000);
    expect(island.result.current.counts.needs_you).toBe(0);

    // A render where this window hosts nothing at all — the agent is still in the fleet.
    act(() => useRuntimeStore.setState({ status: {} }));
    vi.setSystemTime(T0 + 60_000);
    act(() => useRuntimeStore.setState({ status: { a1: "blocked", b1: "working" } }));
    expect(island.result.current.counts.needs_you).toBe(0);
  });
});

// ── THE SUBSCRIPTION TO THE NUDGER FLAG TABLE (roborev 65448) ──────────────────────────────────────
//
// The feed reads the flag table through `publishedStatusFor`, and that table lives outside React. A
// dep merely LISTED in this hook's memo is held in place by nothing — the memo carries an
// `eslint-disable`, so the rule neither demands it nor reports it — which is why the snapshot is now
// READ in the body and passed as `humanBlockedOf`. This is the test that fails if that read is
// removed or the subscription is swapped for a plain call.
//
// It is also the founder's own case: a silent agent already on screen when the nudger flips its
// reply to `blocked-on-human`. Nothing else about that row changes, so the subscription is the only
// way the digest can ever learn.
describe("a nudger flag arriving after mount reaches the feed", () => {
  const founderFlag = (agentId: string, reply: string) => ({
    agentId,
    target: "founder",
    raisedAtMs: 1,
    nudges: 3,
    delivered: 3,
    blockedBy: null,
    silentSecs: 300,
    reply,
  });

  afterEach(async () => {
    __setAuthRecoveryDeps(null);
    resetThrashTracking();
  });

  it("flips the agent back into needs-you on the SAME mount", async () => {
    // a1 is pinged into silence and `blocked`, so the nudge-loop rule demotes it to amber and it
    // leaves the needs-you band — the correct behaviour when nobody has said a person is blocking.
    useProjectStore.setState({ projects: [project("pA", [agent("a1")])] });
    useRuntimeStore.setState({ status: { a1: "blocked" }, agentMovement: {} });
    __setAuthRecoveryDeps({ readNudgeFlags: async () => [] } as never);
    await pollNudgeFlags();
    for (let n = 1; n <= NUDGE_LOOP_LIMIT; n++) {
      noteThrashEvent("a1", {
        event: "UserPromptSubmit",
        prompt: `[sparkle-nudge #${n} · no output for ${n * 5}m] Automated ping, not a new task.`,
        ts: n * 1000,
      });
      noteThrashEvent("a1", { event: "Stop", ts: n * 1000 });
    }

    const { result } = renderHook(() => useConciergeFeed());
    expect(result.current.scopedCounts.needs_you).toBe(0);

    // …then the agent answers the ladder. No store write, no re-render forced by the test.
    await act(async () => {
      __setAuthRecoveryDeps({
        readNudgeFlags: async () => [founderFlag("a1", "blocked-on-human")],
      } as never);
      await pollNudgeFlags();
    });

    expect(result.current.scopedCounts.needs_you).toBe(1);
  });
});
