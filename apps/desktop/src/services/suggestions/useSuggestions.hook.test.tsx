// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

// Mock every dependency the hook reaches so we can drive compute timing deterministically.
const computeSuggestions = vi.fn();
// A stand-in for the real SuggestionOfflineError — the hook's `instanceof` check keys off the class
// it imports from "./engine", so the mock must hand back the SAME class we reject with in tests.
// vi.hoisted so the class exists when the (hoisted) vi.mock factory runs.
const { SuggestionOfflineError } = vi.hoisted(() => {
  class SuggestionOfflineError extends Error {
    constructor() {
      super("offline");
      this.name = "SuggestionOfflineError";
    }
  }
  return { SuggestionOfflineError };
});
vi.mock("./engine", () => ({
  computeSuggestions: (...a: unknown[]) => computeSuggestions(...a),
  SuggestionOfflineError,
}));
// Same stand-in trick for AiUnavailableError / AiUnreachableError: the hook's `instanceof` checks key
// off the classes it imports from "../anthropic", so tests must reject with the very same classes.
// Mocking the module also keeps the real one's @tauri-apps/api/core import out of this suite.
const { AiUnavailableError, AiUnreachableError } = vi.hoisted(() => {
  class AiUnavailableError extends Error {
    constructor() {
      super("AI backend is unavailable");
      this.name = "AiUnavailableError";
    }
  }
  class AiUnreachableError extends Error {
    constructor() {
      super("Claude request failed: the network is unreachable");
      this.name = "AiUnreachableError";
    }
  }
  return { AiUnavailableError, AiUnreachableError };
});
vi.mock("../anthropic", () => ({ AiUnavailableError, AiUnreachableError }));
vi.mock("../terminalScrollback", () => ({ getAgentScrollback: () => "Done. Committed abc. Nothing further." }));
// Credit-gated, and drivable: `useAiFeature` ANDs the feature flag with the live credit balance, so
// flipping this false→true is what a top-up looks like to the hook. Reset in beforeEach.
let aiFeatureOn = true;
vi.mock("../aiGate", () => ({ useAiFeature: () => aiFeatureOn }));
vi.mock("../relayClient", () => ({ pushSuggestions: vi.fn() }));
vi.mock("../../stores/runtimeStore", () => {
  const runtimeState = () => ({
    status: { a1: "idle" },
    workflowShipped: {},
    workflowStage: {},
    workflowState: {},
    branchStatus: {},
  });
  return {
  // status[agentId] === "idle" → a your-turn state, so the hook computes. No workflowStage entry AND
  // no branchStatus for a1 → the resolved stage is building_unsaved, for which deriveCta returns
  // null, so these concurrency tests see the raw computed set with no CTA merged over it. The CTA's
  // own wiring is covered by useSuggestions.cta.test.tsx.
  useRuntimeStore: Object.assign(
    (sel: (s: {
      status: Record<string, string>;
      workflowShipped: Record<string, boolean>;
      workflowStage: Record<string, string>;
      workflowState: Record<string, unknown>;
      branchStatus: Record<string, unknown>;
    }) => unknown,
  ) => sel(runtimeState()),
    // getState is REQUIRED, not decoration: useSuggestions re-checks the LIVE status before typing
    // a picker answer, so a mock without it makes that guard read undefined and bail — which looks
    // like the hook computing nothing at all. A mock that models less than the real store fails
    // open, and this one did (roborev 53203).
    { getState: runtimeState },
  ),
  };
});

import {
  useSuggestions,
  resetSuggestionMemory,
  SETTLE_TICK_MS,
  RETRY_BACKOFF_MS,
} from "./useSuggestions";
import { useConnectionStore } from "../../stores/connectionStore";
// NOT mocked: credits.ts pulls in nothing but a type, so the hook and this suite share the real
// class and `instanceof` lines up without a stand-in.
import { OutOfCreditsError } from "../credits";

beforeEach(() => {
  // handledSigs/memo are per-AGENT module state now (they must survive a remount to stop
  // auto-approve re-firing), so each case has to start from a clean slate.
  resetSuggestionMemory();
  computeSuggestions.mockReset();
  // Reset to the store's optimistic default so each test starts online.
  useConnectionStore.setState({ browserOnline: true, probeOk: true, isOnline: true });
  aiFeatureOn = true; // and funded — the out-of-credits case opts out explicitly
});

// Unconditional teardown. This suite has no automatic RTL cleanup (vite.config.ts sets no
// `globals: true` and test-setup.ts registers no afterEach(cleanup)), which is why every case
// unmounts by hand — but a hand-rolled unmount only runs on the HAPPY path. The positive control
// below mounts a hook that is unbounded BY DESIGN (the credits deferral commits no lastHash and
// spends no budget, so the settle watcher bumps retryTick every SETTLE_TICK_MS while mounted), so a
// timed-out assertion there would leak it into the rest of the file: it keeps calling the shared
// computeSuggestions spy every ~1.2s, and the next cases — which sleep and assert exact counts —
// fail too, turning one defect into three red tests with an ambiguous source.
afterEach(cleanup);

describe("useSuggestions concurrency guard", () => {
  it("does not start a second compute while one is in flight (same state)", async () => {
    let resolve1: (v: unknown) => void = () => {};
    computeSuggestions
      .mockReturnValueOnce(new Promise((r) => (resolve1 = r)))
      .mockResolvedValueOnce({ agentId: "a1", buttons: [] });

    const { rerender } = renderHook(({ empty }) => useSuggestions("a1", empty), {
      initialProps: { empty: true },
    });
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);

    // Toggle composer non-empty then empty again while the first compute is still pending: the
    // in-flight guard must prevent a duplicate concurrent compute.
    rerender({ empty: false });
    rerender({ empty: true });
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);

    // The first compute was superseded (composer toggled mid-flight), so once it resolves its
    // result is discarded and the state we're back in recomputes — exactly one follow-up.
    await act(async () => {
      resolve1({ agentId: "a1", buttons: [] });
    });
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(2);
  });

  it("does not lock up permanently if a compute rejects (retries)", async () => {
    computeSuggestions
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ agentId: "a1", buttons: [] });

    renderHook(() => useSuggestions("a1", true));

    // First compute rejects → catch bumps retryTick after a backoff (retryBackoffMs), finally
    // clears the guard → effect re-runs and a SECOND compute fires. If the guard weren't reset,
    // this would stay at 1 forever. The timeout comfortably exceeds the first-retry backoff (700ms).
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(2), { timeout: 3000 });
  });

  it("defers (no retry storm) while offline, then computes once on reconnect", async () => {
    useConnectionStore.setState({ browserOnline: false, isOnline: false });
    computeSuggestions.mockRejectedValue(new SuggestionOfflineError());

    renderHook(() => useSuggestions("a1", true));

    // Offline: exactly one compute, which throws SuggestionOfflineError. Crucially it must NOT keep
    // re-firing — the offline branch skips the retry budget AND the retryTick bump that would spin.
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);

    // Reconnect: isOnline is an effect dep, so the deferred compute for the still-blocked state
    // re-runs — and now succeeds. lastHash was never committed while offline, so it recomputes.
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [] });
    await act(async () => {
      useConnectionStore.setState({ browserOnline: true, isOnline: true });
    });
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(2));
  });

  it("spends no retries when the AI backend reports itself unavailable", async () => {
    // A generic rejection is worth retrying (see the "retries" test above, which reaches 2 calls).
    // An unavailable backend is not: the retries would hit the same wall, so the first failure must
    // exhaust the budget outright — exactly ONE compute for this state, where a generic error buys 3.
    computeSuggestions.mockRejectedValue(new AiUnavailableError());

    const { unmount } = renderHook(() => useSuggestions("a1", true));

    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(1));
    // Wait out the window in which a retry would have fired (first-retry backoff is 700ms), and
    // confirm nothing further was attempted.
    await new Promise((r) => setTimeout(r, 1200));
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
    // Budget-exhausted, so nothing re-fires — but unmount anyway so this primed hook can't leak
    // a late compute into the NEXT test's spy.
    unmount();
  });

  it("an out-of-credits episode defers, then converges — no retry storm, no watcher spin", async () => {
    // The balance ran out between this render and the call — the refusal arrives mid-flight, the
    // way it does when several agents settle at once and the first 402 closes the gate under the
    // rest. No amount of backoff clears a zero balance, so charging the retry budget bought three
    // guaranteed rejections and three WARN lines for EVERY settled state, on every agent, for as
    // long as the balance stayed empty.
    //
    // SCOPE: this pins the retry storm ONLY. It deliberately does not assert "recomputes on top-up"
    // — that claim is false against the real engine, and a version of this test that made it passed
    // for the wrong reason. The refusal closes the credit gate, so the effect re-runs immediately
    // with the learned tier off; engine.ts's fail-closed branch RESOLVES empty rather than
    // rejecting, and that success path commits lastHash, so the later top-up finds nothing to
    // recompute. See the RECOVERY CAVEAT on computeDeferralReason. Asserting a top-up here would
    // need the gate-closed commit fixed first, which cannot simply be dropped: the settle watcher
    // bails on `h === lastHash.current` and would otherwise spin every ~1.2s.
    // The mock MIRRORS the real engine: it rejects while the credit gate is open, and RESOLVES
    // EMPTY once shut (engine.ts's fail-closed branch). That second shape is not decoration — it is
    // the link that bounds this whole branch, so a mock that rejected unconditionally would leave
    // the only safety property uncovered.
    computeSuggestions.mockImplementation(({ aiEnabled }: { aiEnabled: boolean }) =>
      aiEnabled
        ? Promise.reject(new OutOfCreditsError(0))
        : Promise.resolve({ agentId: "a1", buttons: [] }),
    );

    const { rerender, unmount } = renderHook(() => useSuggestions("a1", true));

    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(1));
    // The usable read window is (RETRY_BACKOFF_MS, SETTLE_TICK_MS * 2) from mount. Below the lower
    // bound a REGRESSED deferral's retry (scheduled at 700ms) hasn't fired yet and the test passes
    // while the storm is back — a silent false pass. Above the upper bound the watcher's tick 2
    // fires a legitimate bump (with the gate open the deferral commits no hash and spends no budget,
    // so that tick is correct, not a bug) and the test flakes. Read at the MIDPOINT of that window,
    // derived from the constants so the point moves with them.
    //
    // The upper bound is NOT tick 2 itself: the gate-close below (rerender → gate-closed empty
    // resolve → lastHash commit) must also finish before tick 2, and it only starts once this sleep
    // returns. If it overran, tick 2 would fire with the gate still open and bump retryTick — phase
    // 2's waitFor would then resolve for the WRONG reason and the convergence assertion would see 3.
    // So the read's real ceiling is tick 2 minus a gate-close allowance, and both allowances are
    // stated here rather than one of them silently financing the other.
    //
    // Net: the window is (700, 1900), the read lands at 1300ms, and each bound gets ~600ms. That is
    // the tightest the lower bound has been on this branch, and tighter still in practice since the
    // sleep starts after the waitFor above resolves while the window is measured from mount — so if
    // this flakes, the fix is fake timers, not a smaller allowance.
    //
    // The 500 is deliberately NOT derived: unlike the two constants it sits beside, it is a
    // wall-clock allowance for a rerender plus a microtask-resolved compute plus a state commit on a
    // loaded runner. There is no constant in the hook that expresses that, so a literal with a
    // stated basis is more honest than a formula that implies a precision it doesn't have.
    const GATE_CLOSE_ALLOWANCE_MS = 500;
    const PHASE1_READ_MS =
      RETRY_BACKOFF_MS +
      (SETTLE_TICK_MS * 2 - GATE_CLOSE_ALLOWANCE_MS - RETRY_BACKOFF_MS) / 2;
    await new Promise((r) => setTimeout(r, PHASE1_READ_MS));
    expect(computeSuggestions).toHaveBeenCalledTimes(1);

    // The 402 ratchets the credit floor, so useAiFeature goes false. Drive that here: the
    // gate-closed pass resolves empty and COMMITS lastHash, which is precisely what makes the settle
    // watcher bail (`h === lastHash.current`). Without this chain the deferral — which spends no
    // budget and commits no hash — would leave the watcher bumping retryTick every ~1.2s forever.
    aiFeatureOn = false;
    await act(async () => {
      rerender();
    });
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(2));

    // THE CONVERGENCE ASSERTION. Hold across three settle ticks: the count must stop growing.
    //
    // SCOPE, precisely: this pins "GIVEN the gate closes, the gate-closed empty resolve commits
    // lastHash and the watcher bails". It does NOT cover the 402 → noteCreditsRefused → credit-floor
    // ratchet → useAiFeature half of the chain — `useAiFeature` is mocked to a bare module variable
    // and the gate is closed by hand here, so that half is executed nowhere in this file. If the
    // ratchet regresses, production spins and this test stays green; that link belongs to an
    // authStore/credits test. The window derives from SETTLE_TICK_MS so raising the constant widens
    // the hold instead of silently shrinking it to zero ticks.
    await new Promise((r) => setTimeout(r, SETTLE_TICK_MS * 3 + 200));
    expect(computeSuggestions).toHaveBeenCalledTimes(2);
    unmount();
  }, 15000);

  it("positive control: the settle watcher IS live under this mock setup", async () => {
    // The convergence assertion above is a pure ABSENCE assertion, so it would also pass if the
    // watcher never ran at all — and its liveness depends on ambient mock state (idle status landing
    // in YOUR_TURN, an empty composer, a non-empty constant scrollback). This is its known-failing
    // counterpart: hold the gate OPEN, which is exactly the unbounded state (the credits deferral
    // returns before committing lastHash and before touching the retry budget), and assert the count
    // DOES grow. If a status-vocabulary change or a new watcher bail kills the tick, this fails and
    // the absence assertion above is exposed as vacuous. NOT in that list: a raised SETTLE_TICK_MS —
    // the deadline below is derived from the same constant, so it scales and the change is a
    // non-event here by construction.
    computeSuggestions.mockRejectedValue(new OutOfCreditsError(0));

    const { unmount } = renderHook(() => useSuggestions("a1", true));
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(1));

    // Tick 1 is inert (prevTickHash null); tick 2 is the first that can bump retryTick. The deadline
    // is generous on purpose: waitFor returns the instant the condition holds, so extra headroom
    // costs nothing on the passing path (~2.4s), while a tight bound buys only a faster failure —
    // worthless for a control whose entire job is to not flake. It is also measured from when THIS
    // waitFor starts, not from mount, so the two aren't on the same clock.
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(2), {
      timeout: SETTLE_TICK_MS * 6,
    });
    unmount();
  }, 15000);

  it("defers a mid-flight transport failure instead of retrying it", async () => {
    // The store still reads online (the reachability heartbeat is up to 30s stale), so the
    // pre-compute gate lets this through — and the request then dies at the transport layer.
    computeSuggestions.mockRejectedValue(new AiUnreachableError());

    const { unmount } = renderHook(() => useSuggestions("a1", true));

    // Exactly one compute. Before this branch existed the failure looked like a generic rejection
    // and bought the full retry budget — three paid calls, none of which could reach the host.
    // Wait past the first-retry backoff (700ms): a scheduled retry would have pushed this to 2.
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 1200));
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
    // Deferring deliberately leaves lastHash uncommitted so the state recomputes on reconnect —
    // which means this hook stays primed. Unmount it so it can't fire into the NEXT test's spy.
    unmount();
  });

  it("does not retry a permanent (4xx) rejection — it can only fail the same way", async () => {
    computeSuggestions.mockRejectedValue(
      new Error("Claude request failed: ai request failed (HTTP 404)"),
    );

    renderHook(() => useSuggestions("a1", true));

    // Exactly one compute: the terminal branch burns the whole budget up front, so no retry is
    // scheduled. Wait past the first-retry backoff (700ms) — a retry, if one were scheduled, would
    // have fired by now and pushed this to 2.
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 1200));
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
  });

  // NOTE: the *bound* on retryABLE persistent rejections is verified by the pure `withinRetryBudget`
  // unit test in useSuggestions.test.ts. A full hook-level simulation of that path was intentionally
  // omitted — driving repeated promise rejections through act() deadlocks this runner. The terminal
  // (non-retryable) path above needs no such driving, so it IS covered end-to-end here.
});
