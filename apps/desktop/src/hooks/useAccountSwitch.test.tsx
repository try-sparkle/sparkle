// @vitest-environment jsdom
//
// Regression cover for bead sparkle-0t2o: the phase-2 advance used to run inside a `setPlan`
// updater, and that updater re-pins each agent (a persisted write) and re-spawns its PTY.
//
// React guarantees an updater sees the LATEST state. It does NOT guarantee it runs exactly once —
// a render that gets thrown away (concurrent rendering, Suspense; this app lazily loads AgentPane /
// BoardView / SparkleAgentPane) replays the updater against the same prior state. So the tests
// below do exactly that, deterministically, and assert each agent is restarted ONCE.
//
// WHY THE COUNTS MATTER: an assertion of `toHaveBeenCalled()` — or of the resulting plan shape —
// passes with the bug fully present, because the double advance is idempotent in the STATE it
// produces and only differs in the SIDE EFFECTS it fires. The whole bug is that the user's terminal
// gets killed and re-spawned twice. Only `toHaveBeenCalledTimes` / the call list can see it. Do not
// weaken these to "was called".

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../services/accountStore";
import type { AgentTabStatus } from "../types";

const h = vi.hoisted(() => ({
  /** Turn the updater replay on/off per test. */
  replayUpdaters: false,
  restart: vi.fn((_agentId: string) => true),
  /** Stands in for `setPinFromSwitch` — the pin a MIGRATION writes. */
  setPin: vi.fn((_agentId: string, _accountId: string) => {}),
  /** Stands in for `setPreferredAccountId` — the durable fleet preference a (re)target writes. */
  setPreferred: vi.fn((_accountId: string) => {}),
  invalidate: vi.fn(),
  statuses: {} as Record<string, AgentTabStatus | undefined>,
  paneAccounts: {} as Record<string, string | undefined>,
  // Phase 2's mid-migration re-validation, driven per test. Default: the target stays healthy, so
  // re-validation is a no-op and the advance behaves exactly as before.
  targetHealthy: true,
  retarget: null as Account | null,
}));

// Makes React's *permitted* behavior deterministic: when `replayUpdaters` is on, every
// function-form update invokes its updater TWICE against the same prior state and commits the
// second result — indistinguishable, from the component's side, from a discarded render.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = (init: unknown) => {
    const [value, set] = actual.useState(init as never);
    const wrapped = (next: unknown) => {
      if (h.replayUpdaters && typeof next === "function") {
        const updater = next as (cur: unknown) => unknown;
        set(((cur: unknown) => {
          updater(cur); // the render that gets discarded
          return updater(cur); // the render that commits
        }) as never);
        return;
      }
      set(next as never);
    };
    return [value, wrapped];
  };
  return { ...actual, useState };
});

vi.mock("../services/paneControl", () => ({
  restartPane: (id: string) => h.restart(id),
  paneAccountMap: () => h.paneAccounts,
  busiestPaneAccount: () => "acct-a",
}));

// `setPinFromSwitch` is what a migration writes — NOT `setPin`. The distinction is the whole point
// of the provenance mark: a later activation clears the pins the machinery wrote and must leave a
// human's `AgentPane` override alone. Spying on `setPin` here would keep passing if `moveAgent`
// silently went back to writing unmarked pins, which is the regression this suite should catch.
vi.mock("../services/accountStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountStore")>()),
  setPinFromSwitch: (agentId: string, accountId: string) => h.setPin(agentId, accountId),
  setPreferredAccountId: (accountId: string) => h.setPreferred(accountId),
  listCeilings: async () => [],
}));

// The two functions this suite drives are stubbed; everything else is the REAL module. In
// particular `isStickyAccountKey` — the plan builders exclude the sticky consumers through it, and
// a hand-written stub here would let this suite disagree with the one definition of "sticky" and
// keep passing while an activation swept the concierge.
vi.mock("../services/accountSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountSelection")>()),
  loadAccountState: async () => ({ accounts: [], usage: [], identities: [] }),
  invalidateAccountState: () => h.invalidate(),
}));

const acct = (id: string): Account => ({
  id,
  nickname: id,
  configDir: `/cfg/${id}`,
  isDefault: false,
  createdAt: 0,
});

vi.mock("../services/headroom", () => ({
  switchRecommendation: () => ({
    from: acct("acct-a"),
    to: acct("acct-b"),
    fraction: 0.9,
    reason: "approaching" as const,
  }),
  // Phase 2's mid-migration re-validation, driven per test via the harness (default: healthy → no-op).
  isHealthyTarget: () => h.targetHealthy,
  bestHealthyTarget: () => h.retarget,
}));

// Imported AFTER the mocks so the hook picks them up.
const { useAccountSwitch, SWITCH_ADVANCE_MS } = await import("./useAccountSwitch");

/** Mount the hook and drive it to an accepted, in-flight plan. */
async function acceptedSwitch() {
  const view = renderHook(() => useAccountSwitch(60 * 60 * 1000));
  // Flush the phase-1 tick's awaits (loadAccountState, listCeilings) so a recommendation lands.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(view.result.current.recommendation).not.toBeNull();
  act(() => view.result.current.accept());
  expect(view.result.current.plan?.pending.length).toBeGreaterThan(0);
  return view;
}

/** One phase-2 interval tick. */
function tick() {
  act(() => {
    vi.advanceTimersByTime(SWITCH_ADVANCE_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.replayUpdaters = false;
  h.restart.mockClear();
  h.setPin.mockClear();
  h.setPreferred.mockClear();
  h.invalidate.mockClear();
  h.paneAccounts = { a1: "acct-a", a2: "acct-a" };
  h.statuses = { a1: "idle", a2: "idle" };
  h.targetHealthy = true;
  h.retarget = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ status: h.statuses }) },
}));

describe("useAccountSwitch phase 2", () => {
  it("restarts each agent exactly ONCE per tick even when the state update is replayed", async () => {
    h.replayUpdaters = true;
    const view = await acceptedSwitch();

    tick();

    // The bug produced 4 restarts (each of a1, a2 twice) and 4 pins. Anything above one call per
    // agent means a live terminal was torn down and re-spawned a second time.
    expect(h.restart.mock.calls.map((c) => c[0]).sort()).toEqual(["a1", "a2"]);
    expect(h.restart).toHaveBeenCalledTimes(2);
    expect(h.setPin).toHaveBeenCalledTimes(2);
    // The persisted-account cache is invalidated once for the batch, not once per replay.
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    // And the plan still retires, so recommendations re-arm.
    expect(view.result.current.plan).toBeNull();
  });

  it("moves only agents at a safe boundary, once each, under replay", async () => {
    h.replayUpdaters = true;
    h.statuses = { a1: "working", a2: "idle" };
    const view = await acceptedSwitch();

    tick();

    expect(h.restart.mock.calls.map((c) => c[0])).toEqual(["a2"]);
    expect(h.setPin).toHaveBeenCalledTimes(1);
    expect(view.result.current.plan?.pending).toEqual(["a1"]);
    expect(view.result.current.plan?.moved).toEqual(["a2"]);

    // a1 finishes its turn: it moves on the next tick, and a2 is NOT restarted a second time.
    h.statuses = { a1: "idle", a2: "idle" };
    tick();

    expect(h.restart.mock.calls.map((c) => c[0])).toEqual(["a2", "a1"]);
    expect(view.result.current.plan).toBeNull();
  });

  it("does nothing while every agent is busy, and fires no effects", async () => {
    h.replayUpdaters = true;
    h.statuses = { a1: "working", a2: "working" };
    const view = await acceptedSwitch();

    tick();

    expect(h.restart).not.toHaveBeenCalled();
    expect(h.setPin).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(view.result.current.plan?.pending.sort()).toEqual(["a1", "a2"]);
  });

  it("without any replay, still restarts each agent exactly once (baseline)", async () => {
    const view = await acceptedSwitch();

    tick();

    expect(h.restart).toHaveBeenCalledTimes(2);
    expect(view.result.current.plan).toBeNull();
  });
});

// ── phase 2 re-validates the target mid-migration (sparkle-m8f39q) ───────────────────────────────
describe("phase 2 re-validates a running plan's target before moving anyone onto it", () => {
  it("re-targets the pending agents to a healthy account when the target goes invalid mid-migration", async () => {
    const view = await acceptedSwitch(); // plan → acct-b, pending [a1, a2]
    expect(view.result.current.plan?.toAccountId).toBe("acct-b");

    // The chosen target dies mid-migration; acct-c is the healthy replacement the oracle picks.
    h.targetHealthy = false;
    h.retarget = acct("acct-c");
    tick();

    // Agents are re-spawned onto acct-c, NOT the dead acct-b, and the fleet preference follows.
    expect(h.setPin).toHaveBeenCalledWith("a1", "acct-c");
    expect(h.setPin).toHaveBeenCalledWith("a2", "acct-c");
    expect(h.setPin).not.toHaveBeenCalledWith("a1", "acct-b");
    expect(h.setPreferred).toHaveBeenCalledWith("acct-c");
  });

  it("RETIRES the plan — moving nobody — when the target is dead and no healthy account remains", async () => {
    const view = await acceptedSwitch();

    // Target invalid and nowhere healthy to go: move nobody, and RETIRE the plan rather than hold it.
    // A held plan keeps planRef set, which makes phase 1 short-circuit and silences its recommendation,
    // auto-switch, and helper-rescue sweeps for the session. Retiring re-arms them; the fleet never left
    // `from`, so it keeps working, and phase 1 re-plans once an account frees up.
    h.targetHealthy = false;
    h.retarget = null;
    tick();

    expect(h.restart).not.toHaveBeenCalled();
    expect(h.setPin).not.toHaveBeenCalled();
    expect(h.setPreferred).not.toHaveBeenCalled();
    expect(view.result.current.plan).toBeNull();
  });

  it("does NOT re-validate a MANUAL activation plan — the user's chosen target is honoured", async () => {
    // The HIGH regression: re-validation must apply only to plans THIS oracle chose. "Activate this
    // account" names a target explicitly; retargeting it would silently overrule the user — worse, off
    // a just-added account absent from the 120s snapshot, or a uuid-only login that reads as unsigned.
    const view = renderHook(() => useAccountSwitch(60 * 60 * 1000));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      view.result.current.switchTo("acct-c"); // planSwitchToAccount → revalidate:false
    });
    expect(view.result.current.plan?.toAccountId).toBe("acct-c");

    // Even with the oracle screaming that acct-c is dead and acct-d is the healthy pick, a manual plan
    // is left alone: agents go to acct-c, never acct-d.
    h.targetHealthy = false;
    h.retarget = acct("acct-d");
    tick();

    expect(h.setPin).toHaveBeenCalledWith("a1", "acct-c");
    expect(h.setPin).toHaveBeenCalledWith("a2", "acct-c");
    expect(h.setPin).not.toHaveBeenCalledWith("a1", "acct-d");
  });
});
