// @vitest-environment jsdom
//
// AN OBSERVED WALL MOVES THE FLEET BY ITSELF; AN ESTIMATE STILL ASKS.
//
// `switchRecommendation` carries a `reason`, and the two values are different KINDS of claim:
//
//   "exhausted"   — an observed rate-limit event. `headroom.ts`: "authoritative … outranks any
//                   estimate". The account HAS hit its limit.
//   "approaching" — the LEARNED ceiling, an estimate with a measured CoV of 0.24. That imprecision
//                   is exactly why `headroom.ts` declined to re-spawn a running fleet unasked.
//
// So they get different answers, and this suite pins the split. Acting on the observed one is safe
// for the same reason the manual path is: `advanceSwitch` moves an agent only at a boundary where
// `isSafeToSwitch` holds, so nothing is re-spawned mid-turn. It is worth doing because the
// alternative is not a short wait — an agent behind a session wall is refused by
// `decideContinuation` until that account's window resets, up to five hours.
//
// WHY THE PAIRED NEGATIVE IS LOAD-BEARING (AGENTS.md, "assert the SIDE EFFECT"): asserting only
// that an exhausted account produces a plan would also pass if the hook auto-accepted EVERY
// recommendation — which would re-spawn the fleet on a 0.24-CoV guess, the precise thing the design
// refuses. Only the "approaching" case going the other way proves the reason is what drives it.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../services/accountStore";
import type { AgentTabStatus } from "../types";

const h = vi.hoisted(() => ({
  reason: "approaching" as "exhausted" | "approaching",
  restart: vi.fn((_agentId: string) => true),
  setPin: vi.fn((_agentId: string, _accountId: string) => {}),
  statuses: {} as Record<string, AgentTabStatus | undefined>,
  paneAccounts: {} as Record<string, string | undefined>,
}));

vi.mock("../services/paneControl", () => ({
  restartPane: (id: string) => h.restart(id),
  paneAccountMap: () => h.paneAccounts,
  busiestPaneAccount: () => "acct-a",
}));

vi.mock("../services/accountStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountStore")>()),
  setPinFromSwitch: (agentId: string, accountId: string) => h.setPin(agentId, accountId),
  listCeilings: async () => [],
}));

vi.mock("../services/accountSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountSelection")>()),
  loadAccountState: async () => ({ accounts: [], usage: [], identities: [] }),
  invalidateAccountState: () => {},
}));

const acct = (id: string): Account => ({
  id,
  nickname: id,
  configDir: `/cfg/${id}`,
  isDefault: false,
  createdAt: 0,
});

// The ONE thing this suite varies. Everything else is held constant so the reason is the only
// possible cause of a difference between the two tests.
vi.mock("../services/headroom", () => ({
  switchRecommendation: () => ({
    from: acct("acct-a"),
    to: acct("acct-b"),
    fraction: 0.95,
    reason: h.reason,
  }),
}));

vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ status: h.statuses }) },
}));

const { useAccountSwitch } = await import("./useAccountSwitch");

/** How often phase 1 re-evaluates in this suite. Short so a test can drive a SECOND evaluation. */
const POLL_MS = 1_000;

/** Flush the phase-1 tick's awaits (loadAccountState, listCeilings) so its result is committed. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Mount and let the first phase-1 evaluation land. */
async function mounted() {
  const view = renderHook(() => useAccountSwitch(POLL_MS));
  await settle();
  return view;
}

/** Drive one FURTHER phase-1 evaluation — the interval fire, then its awaits. */
async function repoll() {
  await act(async () => {
    vi.advanceTimersByTime(POLL_MS);
  });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  h.restart.mockClear();
  h.setPin.mockClear();
  h.paneAccounts = { a1: "acct-a", a2: "acct-a" };
  h.statuses = { a1: "idle", a2: "idle" };
  h.reason = "approaching";
});

describe("an OBSERVED wall migrates running agents without being asked", () => {
  it("auto-starts the switch when the account has actually hit its limit", async () => {
    h.reason = "exhausted";

    const view = await mounted();

    // THE SIDE EFFECT: a plan exists, and nobody called `accept()`. The agents already running on
    // the dead account are enrolled to move at their next safe boundary.
    expect(view.result.current.plan).not.toBeNull();
    expect(view.result.current.plan?.pending.length).toBe(2);
    // And the banner is NOT left asking a question that has already been answered by acting.
    expect(view.result.current.recommendation).toBeNull();
  });

  it("still ASKS when the account is only approaching its learned ceiling", async () => {
    h.reason = "approaching";

    const view = await mounted();

    // The paired negative. Identical fixture, one field different — so this failing while the test
    // above passes is the only outcome consistent with "the reason drives it".
    expect(view.result.current.plan).toBeNull();
    expect(view.result.current.recommendation).not.toBeNull();
    // Nothing was re-spawned on the strength of an estimate.
    expect(h.restart).not.toHaveBeenCalled();
  });

  it("a dismissed warning does not keep agents parked on an account that later hits the wall", async () => {
    // `dismissed` records "stop nagging me that this is getting close" — a wave-off of the
    // PREDICTION. Reading it as a standing refusal to leave an account that has since actually hit
    // its limit would turn one impatient click into hours of idle fleet.
    h.reason = "approaching";
    const view = await mounted();
    expect(view.result.current.recommendation).not.toBeNull();
    act(() => view.result.current.dismiss());
    expect(view.result.current.recommendation).toBeNull();

    // Now the estimate becomes an observed fact, and phase 1 re-evaluates.
    h.reason = "exhausted";
    await repoll();

    expect(view.result.current.plan?.pending.length).toBe(2);
  });

  it("enrolls agents but does NOT re-spawn one that is mid-turn", async () => {
    // The safety property the whole design rests on: enrolment is immediate, movement waits for a
    // boundary. `isSafeToSwitch` excludes `working`, so a busy agent keeps its in-flight turn.
    h.reason = "exhausted";
    h.statuses = { a1: "working", a2: "working" };

    const view = await mounted();

    expect(view.result.current.plan?.pending.length).toBe(2);
    expect(h.restart).not.toHaveBeenCalled();
  });
});
