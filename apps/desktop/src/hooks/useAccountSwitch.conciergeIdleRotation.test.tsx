// @vitest-environment jsdom
//
// THE WIRING half of the "idle concierge rotates off an ineligible account" fix. The pure decision
// — given a spent/expired sticky account and a healthy alternative, MOVE the sticky pointer — is
// proven end-to-end against the real backend in `accountSelection.test.ts`
// ("proactive rotation off a spent/expired concierge account"). This proves the seam that would ship
// that fix INERT while the concierge is idle: that `useAccountSwitch`'s 120s headroom sweep actually
// CALLS the proactive primitive on every believable tick, so the pointer moves without waiting for
// the concierge's next turn (the reactive path) — and that it does NOT move a still-eligible account,
// nor act on a tick whose account load failed.
//
// The primitive is modelled by a faithful stub that mutates a shared sticky-pointer ONLY when the
// account is ineligible with a healthy alternative — exactly its real contract — so the assertions
// read the OBSERVABLE side effect (which account the concierge is now on), not merely "a function was
// called". Break the sweep's call and the ineligible case leaves the pointer on the spent account:
// the test reddens.

import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../services/accountStore";
import type { AgentTabStatus } from "../types";

const SPENT = "acct-spent";
const HEALTHY = "acct-healthy";

const h = vi.hoisted(() => ({
  // The concierge's sticky pointer — the state the sweep must move. Starts on the spent account.
  stickyAccount: "acct-spent" as string,
  // Is the concierge's current account ineligible (spent/expired) right now? Drives the modelled
  // primitive: it rotates only when this holds, mirroring the real `switchRecommendation` gate.
  conciergeIneligible: true,
  // Keys the sweep asked the proactive primitive to rotate, in order — so we can assert the sweep
  // fired it (and, in the failed-load case, that it did NOT).
  rotateCalls: [] as string[],
  // A believable account load vs. a failed one ("we could not look").
  failed: false,
  statuses: {} as Record<string, AgentTabStatus | undefined>,
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
  paneAccountMap: () => ({}),
  // No build fleet is the point: the concierge sits idle, and the ONLY thing that can move it is the
  // proactive sticky rotation this fix wires in.
  busiestPaneAccount: () => null,
}));

vi.mock("../services/accountStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountStore")>()),
  setPreferredAccountId: () => {},
  listCeilings: async () => [],
}));

vi.mock("../services/accountSelection", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/accountSelection")>();
  return {
    ...orig,
    loadAccountState: async () => ({
      accounts: [acct(SPENT), acct(HEALTHY)],
      usage: [],
      identities: [],
      failed: h.failed,
    }),
    invalidateAccountState: () => {},
    liveUsageRows: () => [],
    deadLoginIds: () => new Set<string>(),
    // Faithful model of the real primitive's CONTRACT: rotate the concierge's sticky pointer off the
    // spent account to the healthy one ONLY when the account is ineligible with a healthy alternative;
    // otherwise a no-op (`rotated: false`). The real function proves this against the backend in
    // accountSelection.test.ts; here we only need it to move the observable pointer so the sweep's
    // effect is testable.
    rotateStickyConsumerOffSpentAccount: async (key: string) => {
      h.rotateCalls.push(key);
      if (key === orig.CONCIERGE_ACCOUNT_KEY && h.conciergeIneligible && h.stickyAccount === SPENT) {
        h.stickyAccount = HEALTHY;
        return { rotated: true, from: SPENT, to: HEALTHY };
      }
      return { rotated: false, from: h.stickyAccount };
    },
  };
});

// No fleet recommendation ever — so nothing but the concierge rotation can change state, and phase 1
// never starts a switch plan that could confound the reading.
vi.mock("../services/headroom", () => ({
  switchRecommendation: () => null,
  isHealthyTarget: () => true,
  bestHealthyTarget: () => null,
}));

vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ status: h.statuses }) },
}));

const { useAccountSwitch } = await import("./useAccountSwitch");
const { CONCIERGE_ACCOUNT_KEY } = await import("../services/accountSelection");

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
  h.stickyAccount = SPENT;
  h.conciergeIneligible = true;
  h.rotateCalls = [];
  h.failed = false;
  h.statuses = {};
});

describe("the idle concierge is proactively rotated off an ineligible account by the headroom sweep", () => {
  it("MOVES the concierge's sticky pointer to the healthy account on a believable tick", async () => {
    await mounted();

    // The sweep fired the proactive primitive for the concierge...
    expect(h.rotateCalls).toContain(CONCIERGE_ACCOUNT_KEY);
    // ...and THE SIDE EFFECT: the sticky pointer moved off the spent account to the healthy one,
    // with no turn and no reactive failure — the whole point of the fix.
    expect(h.stickyAccount).toBe(HEALTHY);
  });

  it("does NOT move the pointer when the concierge's account is still ELIGIBLE (paired negative)", async () => {
    // Same idle sweep, one fact flipped: the account is healthy. The sweep still asks the primitive,
    // but the primitive is a no-op, so the pointer stays put. A rotation that always fired would
    // wrongly move a healthy concierge and redden here.
    h.conciergeIneligible = false;

    await mounted();

    expect(h.rotateCalls).toContain(CONCIERGE_ACCOUNT_KEY);
    expect(h.stickyAccount).toBe(SPENT);
  });

  it("does NOT rotate on a tick whose account load FAILED — 'we could not look' is not a wall", async () => {
    // A failed load resolves to an empty, untrustworthy snapshot; treating it as evidence would let a
    // transient IPC hiccup rotate the concierge. The sweep's believable-state guard skips the call
    // entirely, so the primitive is never asked and the pointer is untouched.
    h.failed = true;

    await mounted();

    expect(h.rotateCalls).not.toContain(CONCIERGE_ACCOUNT_KEY);
    expect(h.stickyAccount).toBe(SPENT);
  });
});
