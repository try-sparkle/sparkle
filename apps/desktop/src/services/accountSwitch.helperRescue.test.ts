// @vitest-environment jsdom
//
// THE FOUNDER'S BUG, pinned end to end against the REAL selection path.
//
// He was set to Automatic, his Improve Sparkle helper (a sticky consumer) was pinned to its own
// account, that account hit 99%, and NOTHING auto-switched it — he re-logged in by hand. The cause
// was scope: the exhaustion auto-switch only ever evaluated `busiestPaneAccount()`, so a helper on
// its OWN dedicated account — the entire point of `isStickyAccountKey` — was invisible whenever the
// build fleet ran under a DIFFERENT account.
//
// These tests drive the real `switchRecommendation` (no mock of the oracle), so a green here means
// the actual production decision moves the helper. Each asserts the SIDE EFFECT — the plan that
// results, the pin that is cleared — never merely that a function exists.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Usage, Identity, LiveUsage } from "./accountStore";
import {
  setPin,
  getPin,
  clearAllPins,
  hasHumanPin,
} from "./accountStore";
import { SPARKLE_SELF_ACCOUNT_PREFIX } from "./accountSelection";
import {
  planStrandedHelperRescue,
  planHelperRescue,
  stickyHelperAccounts,
  moveAgent,
} from "./accountSwitch";

const HELPER = SPARKLE_SELF_ACCOUNT_PREFIX; // "__sparkle_self__" — the sticky key both helper halves share
const NOW = 1_000_000_000_000;
const FIVE_H = 5 * 60 * 60 * 1_000;

/** The helper's own dedicated account (drodio@gmail.com in the report), and a healthy escape. */
const helperAcct = (): Account => ({
  id: "acct-helper",
  nickname: "DROdio Gmail",
  configDir: "/cfg/helper",
  isDefault: false,
  createdAt: 0,
});
const healthyAcct = (): Account => ({
  id: "acct-healthy",
  nickname: "DROdio Personal",
  configDir: "/cfg/healthy",
  isDefault: true,
  createdAt: 0,
});

/** Both signed in, DISTINCT logins (distinct uuid + email) so they are not benching siblings and the
 *  healthy one is a legal target. */
const identities = (): Identity[] => [
  { id: "acct-helper", email: "helper@example.com", organization: null, accountUuid: "uuid-helper" },
  { id: "acct-healthy", email: "healthy@example.com", organization: null, accountUuid: "uuid-healthy" },
];

const usageOk = (id: string): Usage => ({ id, tokens5h: 0, tokens7d: 0, exhaustedUntil: null });
const usageWalled = (id: string): Usage => ({
  id,
  tokens5h: 0,
  tokens7d: 0,
  exhaustedUntil: NOW + FIVE_H,
});

const noCeilings: never[] = [];
const noLive: readonly LiveUsage[] = [];

beforeEach(() => {
  clearAllPins();
});

describe("planStrandedHelperRescue — a helper stranded on an exhausted account is moved", () => {
  it("moves the helper off its walled account onto the healthy one, even though it is NOT the busiest", () => {
    // The build fleet runs on the healthy account (so it is the busiest); the helper runs alone on
    // the walled one. `busiestPaneAccount()` names the healthy account, which is why the fleet path
    // never looks at the helper's — the exact blind spot this closes.
    const agentAccounts: Record<string, string> = {
      build1: "acct-healthy",
      build2: "acct-healthy",
      [HELPER]: "acct-helper",
    };

    const plan = planStrandedHelperRescue(
      [helperAcct(), healthyAcct()],
      [usageWalled("acct-helper"), usageOk("acct-healthy")],
      noCeilings,
      identities(),
      NOW,
      noLive,
      agentAccounts,
    );

    // THE SIDE EFFECT: a real plan that relocates the helper to the healthy account.
    expect(plan).not.toBeNull();
    expect(plan!.fromAccountId).toBe("acct-helper");
    expect(plan!.toAccountId).toBe("acct-healthy");
    expect(plan!.pending).toEqual([HELPER]);
  });

  it("does NOT switch a helper whose account is HEALTHY (the paired negative)", () => {
    // Identical shape, one fact changed: the helper's account is not walled. A switch here would
    // re-spawn the helper — losing its conversation — for no reason, so the answer must be null.
    const plan = planStrandedHelperRescue(
      [helperAcct(), healthyAcct()],
      [usageOk("acct-helper"), usageOk("acct-healthy")],
      noCeilings,
      identities(),
      NOW,
      noLive,
      { [HELPER]: "acct-helper", build1: "acct-healthy" },
    );
    expect(plan).toBeNull();
  });

  it("treats an UNREADABLE meter as neither exhausted nor a switch trigger", () => {
    // The screenshots' "an account's usage could not be read, and an unreadable meter is not
    // permission." The helper's account has NO usage row and NO live row, so it reads state
    // "unknown" — which must not be mistaken for a wall. No false switch.
    const plan = planStrandedHelperRescue(
      [helperAcct(), healthyAcct()],
      [usageOk("acct-healthy")], // no row at all for acct-helper
      noCeilings,
      identities(),
      NOW,
      noLive,
      { [HELPER]: "acct-helper" },
    );
    expect(plan).toBeNull();
  });

  it("does NOT strand the helper behind an unreadable meter on ANOTHER account", () => {
    // A third account whose meter cannot be read must not block the rescue: the helper is genuinely
    // walled and a healthy target exists, so it still moves. The unreadable account is simply not
    // chosen as the target.
    const unknownAcct: Account = {
      id: "acct-unknown",
      nickname: "AmForge",
      configDir: "/cfg/unknown",
      isDefault: false,
      createdAt: 0,
    };
    const plan = planStrandedHelperRescue(
      [helperAcct(), healthyAcct(), unknownAcct],
      [usageWalled("acct-helper"), usageOk("acct-healthy")], // no row for acct-unknown
      noCeilings,
      [
        ...identities(),
        { id: "acct-unknown", email: "amforge@example.com", organization: null, accountUuid: "uuid-amforge" },
      ],
      NOW,
      noLive,
      { [HELPER]: "acct-helper" },
    );
    expect(plan).not.toBeNull();
    expect(plan!.toAccountId).toBe("acct-healthy");
    expect(plan!.pending).toEqual([HELPER]);
  });

  it("rescues the helper even when a HUMAN parked it on the walled account with a pin", () => {
    // The founder's modal control writes a human pin ("these two stay on one account"). A pin
    // promises "run here" — but "here" is a wall, so the pin cannot be honoured without leaving him
    // stranded. The rescue overrides it for the sticky helper specifically.
    setPin(HELPER, "acct-helper"); // a human pin, exactly what the modal control writes
    expect(hasHumanPin(HELPER)).toBe(true);

    const plan = planStrandedHelperRescue(
      [helperAcct(), healthyAcct()],
      [usageWalled("acct-helper"), usageOk("acct-healthy")],
      noCeilings,
      identities(),
      NOW,
      noLive,
      { [HELPER]: "acct-helper" },
    );
    expect(plan).not.toBeNull();
    expect(plan!.pending).toEqual([HELPER]);
  });
});

describe("planHelperRescue — pin protection is preserved for BUILD agents", () => {
  it("moves the sticky helper but LEAVES a hand-pinned build agent on the same walled account", () => {
    // The override is narrow: only the sticky helper is moved past its pin. A build agent's human
    // pin is a different promise — the user chose that account for that agent — and this rescue must
    // not overwrite it. Mounting BOTH on the walled account is what proves the rule discriminates.
    setPin("build-pinned", "acct-helper"); // a human's explicit choice for a build agent
    const agentAccounts: Record<string, string> = {
      [HELPER]: "acct-helper",
      "build-pinned": "acct-helper",
      "build-free": "acct-helper",
    };

    const plan = planHelperRescue("acct-helper", "acct-healthy", agentAccounts);

    // The helper AND the unpinned build agent move; the hand-pinned build agent stays.
    expect(plan.pending).toContain(HELPER);
    expect(plan.pending).toContain("build-free");
    expect(plan.pending).not.toContain("build-pinned");
  });
});

describe("moveAgent — rescuing a pinned helper CLEARS its pin so it re-resolves onto the healthy account", () => {
  it("clears the human pin and re-spawns, so the next resolution does not bounce back to the wall", () => {
    // Without the clear, the re-spawn re-reads the pin (`chooseAccountForAgent` → `stickyPin`) and
    // lands right back on the walled account — the switch would be a no-op. The cleared pin is the
    // side effect that makes the relocation stick.
    setPin(HELPER, "acct-helper");
    expect(getPin(HELPER)).toBe("acct-helper");

    const restart = vi.fn((_id: string) => true);
    const respawned = moveAgent(HELPER, "acct-healthy", restart);

    expect(respawned).toBe(true);
    expect(restart).toHaveBeenCalledWith(HELPER);
    // THE SIDE EFFECT: the pin is gone, so the re-spawn auto-picks a healthy account.
    expect(getPin(HELPER)).toBeUndefined();
  });
});

describe("stickyHelperAccounts — reports only the accounts a sticky helper runs on", () => {
  it("picks the helper's account out of a fleet of build agents", () => {
    expect(
      stickyHelperAccounts({
        build1: "acct-healthy",
        build2: "acct-healthy",
        [HELPER]: "acct-helper",
      }),
    ).toEqual(["acct-helper"]);
  });

  it("ignores a build agent that merely happens to share the helper's account name pattern", () => {
    // A non-sticky id is never counted, so an ordinary build agent cannot masquerade as a helper.
    expect(stickyHelperAccounts({ "agent-123": "acct-healthy" })).toEqual([]);
  });
});
