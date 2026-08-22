// @vitest-environment jsdom
//
// THE WIRING half of the EXPIRED-LOGIN auto-switch fix (the P0). `headroom.test.ts` proves the pure
// decision: a `deadLoginIds` set makes `switchRecommendation` move the fleet off a dead account. This
// proves phase 1 of `useAccountSwitch` actually READS the shared dead-login source and hands it in —
// the seam that, left unwired, would ship the decision inert.
//
// The scenario is the founder's exact one: the fleet runs on `acct-a` whose OAuth session has EXPIRED
// (agents get 401), while a healthy `acct-b` sits signed in but INACTIVE. An expired login records no
// rate-limit event and returns no utilization — so before the fix it scored as the HEALTHIEST account
// and the fleet stranded on it with nothing moving. Here headroom + accountStore + accountSwitch are
// REAL (only the shared `deadLoginIds()` cache is mocked, exactly as `liveUsageRows()` is), so the
// whole real decision runs against a dead-login set we control.

import { renderHook, act } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Identity, Usage } from "../services/accountStore";
import type { AgentTabStatus } from "../types";

const h = vi.hoisted(() => ({
  paneAccounts: {} as Record<string, string | undefined>,
  statuses: {} as Record<string, AgentTabStatus | undefined>,
  failed: false,
  // The shared dead-login set the hook reads via `accountSelection.deadLoginIds()`.
  deadIds: new Set<string>(),
  // Per-account usage; overridable so a test can land a real WALL (a future `exhaustedUntil`).
  usage: null as null | { id: string; tokens5h: number; tokens7d: number; exhaustedUntil: number | null }[],
  restart: vi.fn((_id: string) => true),
  setPref: vi.fn((_id: string) => {}),
  setPin: vi.fn((_agentId: string, _id: string) => {}),
}));

const acct = (id: string): Account => ({
  id,
  nickname: id,
  configDir: `/cfg/${id}`,
  isDefault: false,
  createdAt: 0,
});
// Signed-in identities with DISTINCT uuids — real headroom keys signed-in on email and same-login on
// uuid, so these read as two independent logins (never deduped into one).
const ident = (id: string): Identity => ({
  id,
  email: `${id}@example.com`,
  organization: null,
  accountUuid: `uuid-${id}`,
});
const usage = (id: string, tokens5h: number): Usage => ({
  id,
  tokens5h,
  tokens7d: tokens5h,
  exhaustedUntil: null,
});

vi.mock("../services/paneControl", () => ({
  restartPane: (id: string) => h.restart(id),
  paneAccountMap: () => h.paneAccounts,
  busiestPaneAccount: () => "acct-a",
}));

// REAL accountStore, except the two durable writes we capture instead of touching localStorage.
vi.mock("../services/accountStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountStore")>()),
  setPreferredAccountId: (id: string) => h.setPref(id),
  setPinFromSwitch: (agentId: string, id: string) => h.setPin(agentId, id),
  listCeilings: async () => [],
}));

vi.mock("../services/accountSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountSelection")>()),
  loadAccountState: async () => ({
    accounts: [acct("acct-a"), acct("acct-b")],
    usage: h.usage ?? [usage("acct-a", 10), usage("acct-b", 10)],
    identities: [ident("acct-a"), ident("acct-b")],
    failed: h.failed,
  }),
  invalidateAccountState: () => {},
  liveUsageRows: () => [],
  deadLoginIds: () => h.deadIds,
}));

vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ status: h.statuses }) },
}));

const { useAccountSwitch } = await import("./useAccountSwitch");

const POLL_MS = 1_000;

/** Flush the phase-1 tick's awaits (loadAccountState, listCeilings) so its result is committed. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function mounted() {
  const view = renderHook(() => useAccountSwitch(POLL_MS));
  await settle();
  return view;
}

/** Drive one further phase-1 evaluation — the interval fire, then its awaits. */
async function repoll() {
  await act(async () => {
    vi.advanceTimersByTime(POLL_MS);
  });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  h.restart.mockClear();
  h.setPref.mockClear();
  h.setPin.mockClear();
  h.paneAccounts = { a1: "acct-a" };
  h.statuses = { a1: "idle" };
  h.failed = false;
  h.deadIds = new Set<string>();
  h.usage = null;
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("auto-switch fires when the current account's login has EXPIRED", () => {
  it("migrates the fleet off the dead account onto the healthy one", async () => {
    // `acct-a` (the busiest/current account) is DEFINITELY expired; `acct-b` is healthy and inactive.
    // Neither is walled and neither has a live-usage row, so the dead-login signal is the ONLY thing
    // that can move the fleet.
    h.deadIds = new Set(["acct-a"]);

    const view = await mounted();

    // THE SIDE EFFECT: a plan exists (nobody called accept()), the running agent is enrolled to move,
    // and the healthy target is ACTIVATED as the preferred account — the founder's manual step, now
    // automatic.
    expect(view.result.current.plan?.pending).toContain("a1");
    expect(h.setPref).toHaveBeenCalledWith("acct-b");
    expect(view.result.current.recommendation).toBeNull();
  });

  it("does NOT migrate when no login is dead (paired negative)", async () => {
    // Identical fixture, empty dead-login set — the errored/pending/offline/before-first-poll shape,
    // where `deadLoginIds()` returns nothing. With no wall and no live usage, nothing is spent, so the
    // fleet must stay put. This is what makes the test above non-vacuous.
    h.deadIds = new Set<string>();

    const view = await mounted();

    expect(view.result.current.plan).toBeNull();
    expect(h.setPref).not.toHaveBeenCalled();
  });

  it("does NOT migrate when the current login is dead but NO healthy target exists", async () => {
    // The founder's genuine stranded case: every account is dead. `acct-b` is ALSO expired, so it is
    // excluded as a target (an expired login keeps its recorded email and would otherwise read
    // "signed in"). No candidate → no plan → the caller falls through to the manual modal.
    h.deadIds = new Set(["acct-a", "acct-b"]);

    const view = await mounted();

    expect(view.result.current.plan).toBeNull();
    expect(h.setPref).not.toHaveBeenCalled();
  });

  it("a dismissed EXPIRED banner stays dismissed — 'Not now' is not defeated by episode retirement", async () => {
    // The fall-through case: the current account's login is dead but nothing can be migrated (no
    // panes), so phase 1 raises the banner instead of a plan. An expired login has no `exhaustedUntil`,
    // so the wall-episode retirement would delete the wave-off on the next tick and re-raise the
    // banner forever — the "Not now does nothing" defect. The banner must stay down until the login is
    // actually renewed.
    h.deadIds = new Set(["acct-a"]);
    h.paneAccounts = {}; // nothing to migrate → fall-through to the banner

    const view = await mounted();
    expect(view.result.current.recommendation?.expired).toBe(true);

    act(() => view.result.current.dismiss());
    expect(view.result.current.recommendation).toBeNull();

    // The login is still dead on the next poll — but the user already declined, so it stays down.
    await repoll();
    expect(view.result.current.recommendation).toBeNull();
  });

  it("an expired dismissal clears on RENEWAL, so a later re-expiry asks again", async () => {
    // The expired wave-off is standing WHILE the login is dead, but must clear when the login is
    // renewed (leaves deadLoginIds) — otherwise a second expiry episode on the same account is
    // silenced forever ("declined the 09:00 wall, nobody asked about 19:00"). roborev 67719.
    h.deadIds = new Set(["acct-a"]);
    h.paneAccounts = {};
    const view = await mounted();
    act(() => view.result.current.dismiss());
    expect(view.result.current.recommendation).toBeNull();

    // The user signs back in: acct-a leaves the dead set. The stale wave-off must be retired.
    h.deadIds = new Set();
    await repoll();
    expect(view.result.current.recommendation).toBeNull(); // not dead now → nothing to raise

    // Hours later the SAME account expires again — a fresh claim nobody declined.
    h.deadIds = new Set(["acct-a"]);
    await repoll();
    expect(view.result.current.recommendation?.expired).toBe(true);
  });

  it("dismissing the EXPIRED banner does not silence a later real WALL on the same account", async () => {
    // The `:expired` key suffix in dismissKey: an unretirable expired claim must not be filed under
    // the same key as a retirable wall, or renewing the login would leave every real wall on that
    // account silenced for the session. roborev 67719.
    h.deadIds = new Set(["acct-a"]);
    h.paneAccounts = {};
    const view = await mounted();
    expect(view.result.current.recommendation?.expired).toBe(true);
    act(() => view.result.current.dismiss()); // records acct-a:exhausted:expired
    expect(view.result.current.recommendation).toBeNull();

    // Now acct-a hits a REAL rate-limit wall (still dead too, but the wall message stands). Distinct
    // key (acct-a:exhausted) → not silenced by the expired wave-off.
    h.usage = [
      { id: "acct-a", tokens5h: 10, tokens7d: 10, exhaustedUntil: Date.now() + 5 * 60 * 60 * 1000 },
      { id: "acct-b", tokens5h: 10, tokens7d: 10, exhaustedUntil: null },
    ];
    await repoll();

    expect(view.result.current.recommendation).not.toBeNull();
    expect(view.result.current.recommendation?.expired).toBe(false); // the wall message, not expired
  });
});
