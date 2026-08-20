// @vitest-environment jsdom
//
// The PRODUCTION WIRING of the modal-vs-auto-switch coordination.
//
// `accountLimitCoordination.test.ts` proves the decision through the real oracle; this proves the
// hook actually ASKS it. Without a test here the call site is a defaulted seam (AGENTS.md,
// sparkle-lgbwf): drop the `switchRecommendation` gate and `useLimitSync` would raise the modal
// unconditionally again — the exact regression — while every pure test above stayed green.
//
// So this pins two facts the pure tests cannot see: that a landed exhaustion runs the oracle at all,
// and that its verdict drives whether the modal is raised. Paired positive/negative, the mocked
// oracle the only thing that differs — the store side effect (modal on screen) is the assertion.

import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  // What `switchRecommendation` returns this run: a target (auto-switch will handle it) or null
  // (nowhere to go). The ONE thing the two tests vary.
  rec: null as unknown,
  // The batch `syncLimitsOnce` reports as freshly benched — a real limit landing.
  applied: [{ accountId: "walled", until: 5_000 }] as { accountId: string; until: number }[],
  // Captured so the test can prove the oracle was handed the FRESH re-loaded state, not skipped.
  seenArgs: undefined as unknown[] | undefined,
  freshAccounts: [{ id: "walled" }] as unknown,
}));

vi.mock("../services/accountSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountSelection")>()),
  loadAccountState: async () => ({
    accounts: h.freshAccounts,
    usage: [{ id: "walled", tokens5h: 0, tokens7d: 0, exhaustedUntil: Date.now() + 1_000_000 }],
    identities: [],
    failed: false,
  }),
  invalidateAccountState: () => {},
  liveUsageRows: () => [],
}));

vi.mock("../services/limitSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/limitSync")>()),
  syncLimitsOnce: async () => h.applied,
}));

vi.mock("../services/accountStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountStore")>()),
  listCeilings: async () => [],
}));

vi.mock("../services/paneControl", () => ({
  busiestPaneAccount: () => "walled",
  // No sticky helper is mounted in this suite, so the helper-rescue sweep is a no-op and the
  // busiest-account `rec` is the only thing gating the modal — which is what these tests isolate.
  paneAccountMap: () => ({}),
}));

vi.mock("../services/headroom", () => ({
  switchRecommendation: (...args: unknown[]) => {
    h.seenArgs = args;
    return h.rec;
  },
}));

const { useLimitSync } = await import("./useLimitSync");
const { useAccountLimitStore } = await import("../stores/accountLimitStore");

const state = () => useAccountLimitStore.getState();
const POLL_MS = 1_000;

/** Flush the tick's chain of awaits (loadAccountState → syncLimitsOnce → loadAccountState →
 *  listCeilings) so its store write is committed. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useAccountLimitStore.setState({ current: null, dismissed: new Set() });
  h.rec = null;
  h.applied = [{ accountId: "walled", until: Date.now() + 5_000 }];
  h.seenArgs = undefined;
});

describe("useLimitSync gates the limit modal on auto-switch's own oracle", () => {
  it("SUPPRESSES the modal when switchRecommendation finds a target", async () => {
    h.rec = { from: { id: "walled" }, to: { id: "healthy" }, fraction: null, reason: "exhausted" };
    renderHook(() => useLimitSync(POLL_MS));
    await settle();

    // The oracle was actually consulted with the fresh re-loaded account list — not bypassed.
    expect(h.seenArgs?.[0]).toBe("walled");
    expect(h.seenArgs?.[1]).toBe(h.freshAccounts);
    // THE SIDE EFFECT: no modal, because auto-switch will migrate the fleet.
    expect(state().current).toBeNull();
  });

  it("RAISES the modal when switchRecommendation finds no target", async () => {
    // The paired negative: identical run, oracle returns null (nowhere to go), so the modal is the
    // last signal and shows — naming the earliest-resetting account from the fanned-out batch.
    h.rec = null;
    renderHook(() => useLimitSync(POLL_MS));
    await settle();

    expect(state().current).toEqual(h.applied[0]);
  });
});
