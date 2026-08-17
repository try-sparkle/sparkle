// The modal-vs-auto-switch coordination, driven through the REAL target-selection oracle.
//
// The founder's complaint: auto-switch ON, an account ("Storytell II") hit its Claude limit, and
// instead of the fleet being moved for him he got the manual "log in to another account" modal. The
// fix routes the modal raise through the SAME question auto-switch asks — `switchRecommendation` —
// so the interruption fires only when there is genuinely nowhere to go.
//
// This suite does NOT mock `switchRecommendation`: it hands real account state to the real oracle and
// then to the real `raiseFirstLimitUnlessAutoSwitchHandles`, and asserts the store side effect (is
// the modal on screen). Mocking the oracle would prove only that `null`/non-null flows through — this
// proves the two facts the founder's report turns on:
//   * a healthy, signed-in, DIFFERENT-identity account IS selected as a target, so the modal stays
//     down (case b — a target existed and auto-switch should have moved the fleet); and
//   * when the only alternative is itself exhausted OR a same-identity sibling (one quota), NO target
//     is found and the modal correctly shows (case a — genuinely nowhere to go).
//
// The negatives are load-bearing per AGENTS.md: a suppression test alone would also pass against a
// `switchRecommendation` that returned a target for everything, which is the opposite of the design.

import { beforeEach, describe, expect, it } from "vitest";
import { switchRecommendation } from "../services/headroom";
import type { Account, Identity, Usage, LiveUsage } from "../services/accountStore";
import {
  raiseFirstLimitUnlessAutoSwitchHandles,
  useAccountLimitStore,
} from "./accountLimitStore";

const NOW = 1_000_000_000_000;
const FIVE_H = 5 * 60 * 60 * 1_000;

const reset = () => useAccountLimitStore.setState({ current: null, dismissed: new Set() });
const state = () => useAccountLimitStore.getState();

const acct = (id: string): Account => ({
  id,
  nickname: id,
  configDir: `/cfg/${id}`,
  isDefault: false,
  createdAt: 0,
});

/** A signed-in identity (email present ⇒ `signedInAccountIds` keeps it) with an explicit login uuid.
 *  A distinct uuid makes two accounts DIFFERENT logins; a shared one makes them siblings. */
const identity = (id: string, uuid: string): Identity => ({
  id,
  email: `${id}@example.test`,
  organization: null,
  accountUuid: uuid,
});

const usage = (id: string, exhaustedUntil: number | null): Usage => ({
  id,
  tokens5h: 0,
  tokens7d: 0,
  exhaustedUntil,
});

/** The whole production step, exactly as `useLimitSync` runs it: ask the oracle, then decide the
 *  raise on whether it found a target. Returns nothing — the assertion is on the store. */
function coordinate(args: {
  accounts: Account[];
  identities: Identity[];
  usage: Usage[];
  live?: LiveUsage[];
}) {
  const rec = switchRecommendation(
    "walled",
    args.accounts,
    args.usage,
    [], // ceilings: none learned — the observed-wall recommendation does not need them
    args.identities,
    NOW,
    args.live ?? [],
  );
  raiseFirstLimitUnlessAutoSwitchHandles([{ accountId: "walled", until: NOW + FIVE_H }], rec !== null);
}

describe("limit modal defers to auto-switch through the real oracle", () => {
  beforeEach(reset);

  it("SUPPRESSES the modal when a healthy, signed-in, different-identity account can receive the fleet", () => {
    // Case b: a genuine escape exists. The oracle selects it, so auto-switch will migrate the fleet
    // and the manual modal must not steal focus.
    coordinate({
      accounts: [acct("walled"), acct("healthy")],
      identities: [identity("walled", "uuid-walled"), identity("healthy", "uuid-healthy")],
      usage: [usage("walled", NOW + FIVE_H), usage("healthy", null)],
    });
    expect(state().current).toBeNull();
  });

  it("SHOWS the modal when every other signed-in account is ALSO exhausted", () => {
    // Case a: the whole pool is at the wall in a cascade. No healthy target exists, so the modal is
    // the last signal left and correctly interrupts.
    coordinate({
      accounts: [acct("walled"), acct("other")],
      identities: [identity("walled", "uuid-walled"), identity("other", "uuid-other")],
      usage: [usage("walled", NOW + FIVE_H), usage("other", NOW + FIVE_H)],
    });
    expect(state().current).toEqual({ accountId: "walled", until: NOW + FIVE_H });
  });

  it("SHOWS the modal when the only alternative is a SAME-identity sibling (one shared quota)", () => {
    // The subtle no-target case: a second config dir logged into the SAME Anthropic account. It looks
    // healthy but shares the walled quota, so "switching" to it re-hits the identical limit. The
    // oracle excludes it, so there is no target and the modal must show.
    coordinate({
      accounts: [acct("walled"), acct("sibling")],
      identities: [identity("walled", "uuid-shared"), identity("sibling", "uuid-shared")],
      usage: [usage("walled", NOW + FIVE_H), usage("sibling", null)],
    });
    expect(state().current).toEqual({ accountId: "walled", until: NOW + FIVE_H });
  });

  it("SHOWS the modal when the only healthy-looking account is live-spent on Anthropic's own number", () => {
    // A target that has not hit a rate-limit EVENT yet but reads at/over LIVE_AVOID_PERCENT on
    // Anthropic's own usage endpoint is no escape — auto-switch would migrate onto an account about to
    // wall. The oracle drops it, so the modal (correctly) remains.
    coordinate({
      accounts: [acct("walled"), acct("spent")],
      identities: [identity("walled", "uuid-walled"), identity("spent", "uuid-spent")],
      usage: [usage("walled", NOW + FIVE_H), usage("spent", null)],
      live: [{ id: "spent", fiveHourPercent: 99, sevenDayPercent: 10 }],
    });
    expect(state().current).toEqual({ accountId: "walled", until: NOW + FIVE_H });
  });
});
