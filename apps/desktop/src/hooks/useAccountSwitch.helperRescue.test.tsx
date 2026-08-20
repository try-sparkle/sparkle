// @vitest-environment jsdom
//
// THE WIRING half of the helper-rescue fix. `accountSwitch.helperRescue.test.ts` proves the pure
// decision against the real oracle; this proves phase 1 of `useAccountSwitch` actually CALLS it and
// starts a plan — the seam that, left unwired, would ship the fix inert.
//
// The scenario is the founder's exact one: the build fleet runs on a healthy account (so it is
// `busiestPaneAccount()`), and the Improve Sparkle helper runs alone on a DIFFERENT account that has
// walled. `switchRecommendation` is mocked to answer per-account — null for the busy healthy account,
// "exhausted" for the helper's — which is precisely the case the old busiest-only scan was blind to.

import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../services/accountStore";
import type { AgentTabStatus } from "../types";

const HELPER = "__sparkle_self__";

const h = vi.hoisted(() => ({
  // Which account is walled. `switchRecommendation` returns "exhausted" only when asked about THIS
  // one, and null for anything else — so the busiest (healthy) account produces no fleet plan and the
  // ONLY thing that can raise a plan is the helper sweep.
  walledAccount: "acct-helper" as string | null,
  paneAccounts: {} as Record<string, string | undefined>,
  statuses: {} as Record<string, AgentTabStatus | undefined>,
  failed: false,
  restart: vi.fn((_id: string) => true),
  setPref: vi.fn((_id: string) => {}),
}));

const acct = (id: string): Account => ({
  id,
  nickname: id,
  configDir: `/cfg/${id}`,
  isDefault: false,
  createdAt: 0,
});

vi.mock("../services/paneControl", () => ({
  restartPane: (id: string) => h.restart(id),
  paneAccountMap: () => h.paneAccounts,
  // The build fleet's account — deliberately NOT the helper's, so the fleet path finds nothing.
  busiestPaneAccount: () => "acct-healthy",
}));

vi.mock("../services/accountStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountStore")>()),
  setPreferredAccountId: (id: string) => h.setPref(id),
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

// Per-account oracle: only the walled account yields a recommendation. `planStrandedHelperRescue`
// imports this same mocked function, so the sweep sees exactly this answer.
vi.mock("../services/headroom", () => ({
  switchRecommendation: (currentAccountId: string | null) =>
    currentAccountId != null && currentAccountId === h.walledAccount
      ? { from: acct(currentAccountId), to: acct("acct-healthy"), fraction: 0.99, reason: "exhausted" }
      : null,
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

beforeEach(() => {
  vi.useFakeTimers();
  h.restart.mockClear();
  h.setPref.mockClear();
  h.walledAccount = "acct-helper";
  // Build fleet on the healthy account (busiest); the helper alone on the walled one.
  h.paneAccounts = { build1: "acct-healthy", build2: "acct-healthy", [HELPER]: "acct-helper" };
  h.statuses = { build1: "idle", build2: "idle", [HELPER]: "idle" };
  h.failed = false;
});

describe("a sticky helper stranded on a non-busiest exhausted account is auto-switched", () => {
  it("starts a plan that moves the HELPER, without anyone accepting a banner", async () => {
    const view = await mounted();

    // THE SIDE EFFECT: a plan exists (nobody called accept), and it moves the helper — the account
    // the busiest-only scan never looked at.
    expect(view.result.current.plan).not.toBeNull();
    expect(view.result.current.plan?.fromAccountId).toBe("acct-helper");
    expect(view.result.current.plan?.pending).toEqual([HELPER]);
    // The helper is sticky and re-resolves on its own; the fleet-wide preference is NOT rewritten.
    expect(h.setPref).not.toHaveBeenCalled();
    // No banner left asking a question already answered by acting.
    expect(view.result.current.recommendation).toBeNull();
  });

  it("does NOT switch when the helper's account is HEALTHY (paired negative)", async () => {
    // Same fleet, one fact flipped: nothing is walled. `switchRecommendation` answers null for every
    // account, so neither the fleet path nor the helper sweep has anything to do.
    h.walledAccount = null;

    const view = await mounted();

    expect(view.result.current.plan).toBeNull();
    expect(view.result.current.recommendation).toBeNull();
    expect(h.restart).not.toHaveBeenCalled();
  });

  it("does NOT sweep on a tick whose account load FAILED — we could not look is not a wall", async () => {
    // `state.failed` makes every account look absent; treating that as exhaustion would switch the
    // helper on a transient IPC hiccup. The sweep is skipped, so no plan.
    h.failed = true;

    const view = await mounted();

    expect(view.result.current.plan).toBeNull();
  });
});
