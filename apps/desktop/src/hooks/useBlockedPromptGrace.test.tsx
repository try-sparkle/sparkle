// @vitest-environment jsdom
//
// The wake-up for the 30s ceiling — the thing that makes it a ceiling rather than a promise.
//
// WHAT MUST GO RED HERE. The failure this hook exists to prevent leaves NO test red anywhere else:
// the overlay is correct, the feed is correct, every pure unit passes, and the founder still never
// sees the prompt — because with the answerer wedged nothing ever re-renders the memo, so
// `withBlockedPromptGrace` is never asked again and the row bands calm forever. So the assertions
// below are all about the TIMER and the counter it drives: that one is armed when something is held,
// that it fires at the deadline and not before, that it RE-ARMS for a second prompt still inside its
// own window, and — the other direction — that an idle fleet arms nothing at all.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePromptGraceTick } from "./useBlockedPromptGrace";
import {
  BLOCKED_PROMPT_GRACE_MS,
  emptyPromptGraceLedger,
  notePromptAnswerOutcome,
  notePromptEpisodes,
  resetPromptGraceLedgerForTests,
  windowPromptGraceLedger,
  type PromptGraceLedger,
} from "../engine/blockedPromptGrace";
import type { AgentTabStatus } from "../types";

const T0 = 1_700_000_000_000;

const ASK_A = "Allow `git status`?";
const ASK_B = "Allow `cargo check`?";

/** Stable empty capture maps. Most cases here seed the ledger BEFORE mounting, so the capture maps
 *  never need to move; the two cases that exercise a hold beginning AFTER mount pass their own. */
const NO_SCREENS: Record<string, string> = {};
const NO_SCREENS_AT: Record<string, number> = {};

/** Open episodes for the given asks at the given capture times, exactly as `buildConciergeFeed`
 *  does on each rebuild. The hook itself never mutates — it only reads. */
function seed(
  ledger: PromptGraceLedger,
  status: Record<string, AgentTabStatus>,
  asks: Record<string, { text: string; at: number }>,
  now: number,
): void {
  notePromptEpisodes(ledger, status, (id) => asks[id], now, Object.keys(status));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  // The outcome test writes to the WINDOW ledger (that is the only one the change channel fires
  // for), so it has to start clean — module state that survives a case is how one test's recorded
  // outcome silently decides the next one's hold.
  resetPromptGraceLedgerForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("usePromptGraceTick", () => {
  it("arms NO timer when nothing is held", () => {
    const ledger = emptyPromptGraceLedger();
    const agents = [{ id: "a" }];
    const status: Record<string, AgentTabStatus> = { a: "working" };
    seed(ledger, status, {}, T0);

    const { result } = renderHook(() => usePromptGraceTick(agents, ledger, NO_SCREENS, NO_SCREENS_AT, status));
    expect(result.current).toBe(0);
    // An idle fleet costs nothing — the point of a per-deadline timer over a poll.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes the caller when the ceiling lapses, and NOT before", () => {
    const ledger = emptyPromptGraceLedger();
    const agents = [{ id: "a" }];
    const status: Record<string, AgentTabStatus> = { a: "waiting" };
    seed(ledger, status, { a: { text: ASK_A, at: T0 } }, T0);

    const { result } = renderHook(() => usePromptGraceTick(agents, ledger, NO_SCREENS, NO_SCREENS_AT, status));
    expect(result.current).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    // One millisecond short of the deadline: still 0. This half is what stops the test passing
    // against a hook that simply ticked on an interval.
    act(() => {
      vi.advanceTimersByTime(BLOCKED_PROMPT_GRACE_MS - 1);
    });
    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(1);
  });

  it("RE-ARMS for a second prompt that is still inside its own window", () => {
    // The staggered case, and the reason `tick` is in the effect's dependency list: when the first
    // deadline lapses nothing else about the inputs changes, so without a re-arm the second prompt
    // would sit held forever behind the first one's expiry.
    const ledger = emptyPromptGraceLedger();
    const agents = [{ id: "a" }, { id: "b" }];
    const status: Record<string, AgentTabStatus> = { a: "waiting", b: "approval" };
    seed(
      ledger,
      status,
      { a: { text: ASK_A, at: T0 }, b: { text: ASK_B, at: T0 + 5_000 } },
      T0,
    );

    const { result } = renderHook(() => usePromptGraceTick(agents, ledger, NO_SCREENS, NO_SCREENS_AT, status));
    act(() => {
      vi.advanceTimersByTime(BLOCKED_PROMPT_GRACE_MS);
    });
    expect(result.current).toBe(1);
    // `b` is still held, so a NEW timer must exist aimed at its later deadline.
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(2);
    // …and now nothing is held, so the hook stops arming anything.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not spin on a deadline that has ALREADY passed", () => {
    // A prompt captured before this window ever looked at it is not held at all
    // (`nextPromptGraceExpiry` returns null for it), so there is nothing to arm. The MIN_WAKE_MS
    // floor is the belt to this braces — assert the visible half: no timer, no tick, no loop.
    const ledger = emptyPromptGraceLedger();
    const agents = [{ id: "a" }];
    const status: Record<string, AgentTabStatus> = { a: "waiting" };
    seed(ledger, status, { a: { text: ASK_A, at: T0 - BLOCKED_PROMPT_GRACE_MS * 2 } }, T0);

    const { result } = renderHook(() => usePromptGraceTick(agents, ledger, NO_SCREENS, NO_SCREENS_AT, status));
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(0);
  });

  it("clears its timer on unmount", () => {
    const ledger = emptyPromptGraceLedger();
    const agents = [{ id: "a" }];
    const status: Record<string, AgentTabStatus> = { a: "waiting" };
    seed(ledger, status, { a: { text: ASK_A, at: T0 } }, T0);

    const { unmount } = renderHook(() => usePromptGraceTick(agents, ledger, NO_SCREENS, NO_SCREENS_AT, status));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  // ── THE TWO WAYS A HOLD USED TO BEGIN WITH NO CEILING ARMED (roborev 62851) ───────────────────
  // Both are the same end state and it is the worst one this feature has: the prompt is hidden and
  // NOTHING will ever surface it. Every case above seeds before mount, so the mount effect always
  // armed the timer and the suite was structurally blind to them.

  it("arms a timer for a hold that begins AFTER mount, with the status map unchanged", () => {
    const ledger = emptyPromptGraceLedger();
    const agents = [{ id: "a" }];
    const status: Record<string, AgentTabStatus> = { a: "waiting" };
    // Mounted while the capture has NOT landed yet — Terminal.tsx documents this ordering as common,
    // since the statusRouter often suppresses the scraper's emit.
    let screens: Record<string, string> = {};
    let screensAt: Record<string, number> = {};
    const { result, rerender } = renderHook(() => usePromptGraceTick(agents, ledger, screens, screensAt, status));
    expect(vi.getTimerCount()).toBe(0);

    // The capture lands. `setAttentionScreen` always writes FRESH maps, which is the identity change
    // the effect tracks; `agents` and the status map are deliberately the SAME references, because
    // `setStatus` no-ops on an unchanged value and that is exactly what made this reachable.
    seed(ledger, status, { a: { text: ASK_A, at: T0 } }, T0);
    screens = { a: ASK_A };
    screensAt = { a: T0 };
    rerender();

    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(BLOCKED_PROMPT_GRACE_MS);
    });
    expect(result.current).toBe(1);
  });

  it("arms a timer when only the STATUS MAP moved — the capture is deliberately kept across it", () => {
    // The third route into "held with no ceiling armed" (roborev 62861). `setStatus` PRESERVES the
    // ask snapshot through a waiting → blocked/errored → waiting slide, and Terminal only recaptures
    // when the scraper emits — which the statusRouter suppresses once hook events own the status. So
    // the episode closes and re-opens with BOTH capture maps identity-unchanged. If the status map
    // is not a dependency, nothing re-runs the effect and the prompt is hidden for good.
    const ledger = emptyPromptGraceLedger();
    const agents = [{ id: "a" }];
    const screens = { a: ASK_A };
    const screensAt = { a: T0 };
    // Mount mid-slide: the agent is `blocked`, so no episode is open and nothing is held.
    let status: Record<string, AgentTabStatus> = { a: "blocked" };
    seed(ledger, status, { a: { text: ASK_A, at: T0 } }, T0);
    const { result, rerender } = renderHook(() =>
      usePromptGraceTick(agents, ledger, screens, screensAt, status),
    );
    expect(vi.getTimerCount()).toBe(0);

    // Back to `waiting`. A NEW status map object, but the SAME capture maps by identity.
    status = { a: "waiting" };
    seed(ledger, status, { a: { text: ASK_A, at: T0 } }, T0);
    rerender();

    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(BLOCKED_PROMPT_GRACE_MS);
    });
    expect(result.current).toBe(1);
  });

  it("wakes on an ANSWER OUTCOME, which no React input reports", () => {
    const ledger = emptyPromptGraceLedger();
    const agents = [{ id: "a" }];
    const status: Record<string, AgentTabStatus> = { a: "waiting" };
    seed(ledger, status, { a: { text: ASK_A, at: T0 } }, T0);
    const { result } = renderHook(() => usePromptGraceTick(agents, ledger, NO_SCREENS, NO_SCREENS_AT, status));
    expect(result.current).toBe(0);

    // `declined` / `unreachable` are documented as surfacing IMMEDIATELY. They are written by a
    // service into a plain Map, so without the subscription the caller would not recompute until
    // something unrelated churned — or until the ceiling these two exist to pre-empt.
    act(() => {
      notePromptAnswerOutcome("a", "unreachable", T0 + 1_000, windowPromptGraceLedger());
    });
    expect(result.current).toBe(1);
  });
});
