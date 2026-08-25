// @vitest-environment jsdom
//
// THE ORPHANED-MODAL case — the gap the two existing `resolveByAutoSwitch` calls in phase 1 miss.
//
// `useAccountSwitch.helperRescue.test.tsx` proves phase 1 STARTS A PLAN (and resolves the modal in
// the same breath) when a sticky helper is still stranded ON its exhausted account. This suite proves
// the OTHER half the founder actually hit: the sticky helper has ALREADY re-resolved onto a healthy
// account via its own auto-pick, so nothing is left on the walled account for `planStrandedHelperRescue`
// or `planSwitch` to migrate — no plan is started, so neither in-plan resolve fires — and yet a modal
// raised earlier for that walled account is still on screen. Before the fix it stood there forever
// (agents on other accounts running, the modal saying so, nothing clearing it). The fix clears it the
// moment the SAME oracle, keyed on the MODAL's account, confirms a healthy alternative exists.
//
// The scenario is the founder's exact one: the "DROdio Storytell II" helper walled, its work silently
// moved to a healthy account, and the manual "log in to another account" modal was left orphaned.

import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../services/accountStore";
import type { AgentTabStatus } from "../types";
import { useAccountLimitStore } from "../stores/accountLimitStore";

const HELPER = "__sparkle_self__";
const UNTIL = 2_000_000_000_000;

const h = vi.hoisted(() => ({
  // Which account `switchRecommendation` reports a recommendation-with-a-target for. null ⇒ nothing.
  walledAccount: "acct-helper" as string | null,
  // The recommendation's reason. Only an OBSERVED WALL ("exhausted") clears a modal; an ESTIMATE
  // ("approaching") only asks and must leave a real limit modal alone.
  reason: "exhausted" as "exhausted" | "approaching",
  paneAccounts: {} as Record<string, string | undefined>,
  statuses: {} as Record<string, AgentTabStatus | undefined>,
  failed: false,
}));

const acct = (id: string): Account => ({
  id,
  nickname: id,
  configDir: `/cfg/${id}`,
  isDefault: false,
  createdAt: 0,
});

vi.mock("../services/paneControl", () => ({
  restartPane: () => true,
  paneAccountMap: () => h.paneAccounts,
  // The build fleet's account — healthy, so the busiest (fleet) path never produces a plan.
  busiestPaneAccount: () => "acct-healthy",
}));

vi.mock("../services/accountStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountStore")>()),
  setPreferredAccountId: () => {},
  listCeilings: async () => [],
}));

vi.mock("../services/accountSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountSelection")>()),
  loadAccountState: async () => ({
    accounts: [acct("acct-helper"), acct("acct-healthy")],
    usage: [],
    identities: [],
    failed: h.failed,
  }),
  invalidateAccountState: () => {},
  liveUsageRows: () => [],
}));

// Per-account oracle: only `walledAccount` yields an "exhausted" recommendation (a healthy target
// exists), every other account is null. `planStrandedHelperRescue` imports THIS same mock, so a sticky
// pane sitting on a healthy account yields no rescue — the whole point of the orphaned case.
vi.mock("../services/headroom", () => ({
  switchRecommendation: (currentAccountId: string | null) =>
    currentAccountId != null && currentAccountId === h.walledAccount
      ? { from: acct(currentAccountId), to: acct("acct-healthy"), fraction: 0.99, reason: h.reason }
      : null,
  isHealthyTarget: () => true,
  bestHealthyTarget: () => null,
}));

vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ status: h.statuses }) },
}));

const { useAccountSwitch } = await import("./useAccountSwitch");

const POLL_MS = 1_000;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mounted() {
  const view = renderHook(() => useAccountSwitch(POLL_MS));
  await settle();
  return view;
}

const limitState = () => useAccountLimitStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  useAccountLimitStore.setState({ current: null, dismissed: new Set() });
  h.walledAccount = "acct-helper";
  h.reason = "exhausted";
  // THE HELPER HAS ALREADY RE-RESOLVED: its sticky pane is now on the healthy account, NOT on the
  // walled one. So `stickyHelperAccounts` yields only "acct-healthy" and the rescue sweep finds
  // nothing on "acct-helper" to move — no plan, so neither in-plan resolve can fire.
  h.paneAccounts = { build1: "acct-healthy", build2: "acct-healthy", [HELPER]: "acct-healthy" };
  h.statuses = { build1: "idle", build2: "idle", [HELPER]: "idle" };
  h.failed = false;
});

describe("an orphaned limit modal clears once a healthy alternative exists for its account", () => {
  it("CLEARS a standing modal for an account whose helper silently re-resolved — with NO switch plan", async () => {
    // The modal was raised earlier (nowhere to go then); the helper has since moved itself to a
    // healthy account. Nothing is left on "acct-helper" to rescue, so no plan is started…
    limitState().raise({ accountId: "acct-helper", until: UNTIL });
    expect(limitState().current).not.toBeNull();

    const view = await mounted();

    // THE SIDE EFFECT the fix adds: the modal is gone, cleared by the general oracle check — not by a
    // rescue plan, which would be the already-covered path.
    expect(limitState().current).toBeNull();
    // Proof it is the CLEAR path, not the rescue path: nothing is migrating.
    expect(view.result.current.plan).toBeNull();
  });

  it("LEAVES the modal up when there is genuinely no healthy account (paired negative)", async () => {
    // Same standing modal, one fact flipped: nothing is walled-with-a-target, so `switchRecommendation`
    // answers null for the modal's account too. "Log in to another account" is now the right ask, so
    // the modal must STAND. This is the assertion that fails if the clear ever fired unconditionally.
    h.walledAccount = null;
    limitState().raise({ accountId: "acct-helper", until: UNTIL });

    await mounted();

    expect(limitState().current).toEqual({ accountId: "acct-helper", until: UNTIL });
  });

  it("LEAVES the modal up on an APPROACHING estimate — an estimate asks, it does not clear a real limit", async () => {
    // The same walled account, but the oracle reports only an ESTIMATE ("approaching"), not an
    // observed wall. Nothing is actually migrating on an estimate, so a real limit modal must NOT be
    // dismissed by it — the same "an observed wall moves the fleet; an estimate still asks" split the
    // fleet path draws. If the clear keyed on `!= null` instead of `reason === "exhausted"` this reds.
    h.reason = "approaching";
    limitState().raise({ accountId: "acct-helper", until: UNTIL });

    await mounted();

    expect(limitState().current).toEqual({ accountId: "acct-helper", until: UNTIL });
  });

  it("LEAVES a modal about a DIFFERENT account alone — the oracle is keyed on the MODAL's account", async () => {
    // Only "acct-helper" has a healthy target; the modal is about "acct-other", for which no target
    // exists. Clearing keyed on `busiestPaneAccount()` (the old blind spot) or on anything but the
    // modal's own account would wrongly drop this. It must stand.
    limitState().raise({ accountId: "acct-other", until: UNTIL });

    await mounted();

    expect(limitState().current).toEqual({ accountId: "acct-other", until: UNTIL });
  });

  it("does NOT clear on a tick whose account load FAILED — we could not look is not an escape", async () => {
    // A failed load resolves to empty accounts; treating that as "an alternative exists" and clearing
    // the modal would drop the founder's last signal on a transient IPC hiccup. The clear is skipped.
    h.failed = true;
    limitState().raise({ accountId: "acct-helper", until: UNTIL });

    await mounted();

    expect(limitState().current).toEqual({ accountId: "acct-helper", until: UNTIL });
  });

  // THE ORDERING / RACE the AGENTS.md "two entry points race from one gesture" trap warns about:
  // the raise (in useLimitSync) and this clear (in useAccountSwitch) run on separate loops. Assert the
  // LOSING interleaving — a clear tick that runs BEFORE the modal is raised must be a harmless no-op,
  // and a LATER tick, after the modal appears, must still clear it. If the clear only ever looked at
  // mount time it would miss a modal raised one tick later and strand it forever.
  it("clears a modal raised AFTER the first tick already ran (the losing interleaving)", async () => {
    // No modal yet at mount: the first clear tick reads `current == null` and does nothing.
    const view = await mounted();
    expect(limitState().current).toBeNull();
    expect(view.result.current.plan).toBeNull();

    // Now the modal is raised (useLimitSync's tick landed after ours), and the helper has already
    // moved. The next poll must find it and clear it.
    act(() => {
      limitState().raise({ accountId: "acct-helper", until: UNTIL });
    });
    expect(limitState().current).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await settle();

    expect(limitState().current).toBeNull();
  });
});
