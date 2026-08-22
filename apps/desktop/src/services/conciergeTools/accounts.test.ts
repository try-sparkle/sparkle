// The accounts domain: what the concierge reports about account headroom, and what it refuses to do
// with it.
//
// WHAT THESE TESTS ARE CAREFUL ABOUT. The cheap version of this suite asserts that `read_usage`
// returns rows — which is true before and after every mechanism in the module, so it proves nothing.
// Each test below names the SIDE EFFECT of one decision instead:
//
//   * that a live number is preferred over the estimate AND labelled `live`;
//   * that a missing ceiling renders `null` rather than `0` (the one wrong answer that reads as
//     "plenty of room");
//   * that one account's failed fetch does not degrade its neighbours;
//   * and, for every `switch_all` refusal, a PAIRED test showing the same setup DOES switch once the
//     refused condition is removed. A refusal test alone is ambiguous — it passes just as well
//     against a function that never switches at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNTS_DEPS,
  ACCOUNTS_RISK,
  readUsage,
  switchAll,
  type AccountsDeps,
} from "./accounts";
import { listAccounts, getIdentities, getUsage, listCeilings } from "../accountStore";
import type { Account, Identity, Usage } from "../accountStore";
import type { Ceiling } from "../headroom";
import type { AccountUsageLive } from "../accountUsage";
import { getAccountUsageLive } from "../accountUsage";
import { activateAccount } from "../../hooks/useAccountSwitch";
import { setPreferredAccountId, clearPreferredAccount } from "../accountStore";
import {
  setAccountInRotation,
  pauseRotation,
  ROTATION_OUT_STORAGE_KEY,
  ROTATION_PAUSED_STORAGE_KEY,
} from "../rotationState";

// Both persist in localStorage by design (the spawn path reads them and is not React), so a test
// that sets one would otherwise leak into its neighbours.
afterEach(() => {
  localStorage.removeItem(ROTATION_OUT_STORAGE_KEY);
  localStorage.removeItem(ROTATION_PAUSED_STORAGE_KEY);
  clearPreferredAccount();
});
import { busiestPaneAccount } from "../paneControl";

const NOW = 1_700_000_000_000;

function acct(id: string, over: Partial<Account> = {}): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0, ...over };
}

/** A signed-in identity. Neutral placeholders only — never a real login. */
function signedIn(id: string, over: Partial<Identity> = {}): Identity {
  return {
    id,
    email: `${id}@example.test`,
    organization: null,
    accountUuid: `uuid-${id}`,
    ...over,
  };
}

function live(over: Partial<AccountUsageLive> = {}): AccountUsageLive {
  return {
    fiveHourPercent: null,
    fiveHourResetsAt: null,
    sevenDayPercent: null,
    sevenDayResetsAt: null,
    limits: [],
    ...over,
  };
}

function deps(over: Partial<AccountsDeps> = {}): AccountsDeps {
  return {
    listAccounts: async () => [],
    getIdentities: async () => [],
    getUsage: async () => [],
    listCeilings: async () => [],
    getUsageLive: async () => {
      throw new Error("no live usage in this test");
    },
    activateAccount: vi.fn(() => true),
    currentAccountId: () => null,
    now: () => NOW,
    ...over,
  };
}

/** Unwrap a success, failing loudly with the refusal message when it isn't one. */
function dataOf<T>(r: { ok: true; data: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(`expected success, got refusal: ${r.message}`);
  return r.data;
}

// ---------------------------------------------------------------------------------------------
// The production wiring
// ---------------------------------------------------------------------------------------------

describe("ACCOUNTS_DEPS", () => {
  // Guards the seam AGENTS.md warns about: every test below injects its own deps, so without this
  // the lines that supply the REAL functions are covered by nothing and could be deleted while the
  // suite stayed green.
  it("wires each dependency to the real production function", () => {
    expect(ACCOUNTS_DEPS.listAccounts).toBe(listAccounts);
    expect(ACCOUNTS_DEPS.getIdentities).toBe(getIdentities);
    expect(ACCOUNTS_DEPS.getUsage).toBe(getUsage);
    expect(ACCOUNTS_DEPS.listCeilings).toBe(listCeilings);
    expect(ACCOUNTS_DEPS.getUsageLive).toBe(getAccountUsageLive);
    expect(ACCOUNTS_DEPS.activateAccount).toBe(activateAccount);
    expect(ACCOUNTS_DEPS.currentAccountId).toBe(busiestPaneAccount);
  });

  // The confirmation gate is DERIVED from this word (disruptive -> ask). If it ever reads
  // "routine" the concierge may move the whole fleet between logins with nobody asked.
  it("classifies switch_all as disruptive so it derives to ask", () => {
    expect(ACCOUNTS_RISK.switch_all).toBe("disruptive");
    expect(ACCOUNTS_RISK.read_usage).toBe("read-only");
  });
});

// ---------------------------------------------------------------------------------------------
// read_usage
// ---------------------------------------------------------------------------------------------

describe("read_usage — provenance", () => {
  it("prefers the LIVE number over the learned estimate and labels it live", async () => {
    const report = dataOf(
      await readUsage(
        deps({
          listAccounts: async () => [acct("a")],
          getIdentities: async () => [signedIn("a")],
          // A learned estimate that would say 50% — the live number must win.
          getUsage: async () => [{ id: "a", tokens5h: 500, exhaustedUntil: null } as Usage],
          listCeilings: async () => [{ id: "a", samples: [1, 2, 3], ceiling: 1000 } as Ceiling],
          getUsageLive: async () => live({ fiveHourPercent: 82, fiveHourResetsAt: "2026-08-11T18:00:00Z" }),
        }),
      ),
    );

    expect(report.rows[0]!.usageSource).toBe("live");
    expect(report.rows[0]!.fiveHourPercent).toBe(82);
    expect(report.rows[0]!.fiveHourResetsAt).toBe("2026-08-11T18:00:00Z");
    expect(report.liveUnavailable).toBe(false);
  });

  it("falls back to the learned estimate, labelled learned, when live is unavailable", async () => {
    const report = dataOf(
      await readUsage(
        deps({
          listAccounts: async () => [acct("a")],
          getIdentities: async () => [signedIn("a")],
          getUsage: async () => [{ id: "a", tokens5h: 500, exhaustedUntil: null } as Usage],
          listCeilings: async () => [{ id: "a", samples: [1, 2, 3], ceiling: 1000 } as Ceiling],
          getUsageLive: async () => {
            throw new Error("401");
          },
        }),
      ),
    );

    expect(report.rows[0]!.usageSource).toBe("learned");
    expect(report.rows[0]!.fiveHourPercent).toBe(50);
    // An estimate has NO reset instant. Inventing one would be the report's only fabricated field.
    expect(report.rows[0]!.fiveHourResetsAt).toBeNull();
    expect(report.liveUnavailable).toBe(true);
  });

  // THE ONE WRONG ANSWER. 0% reads as "plenty of room" and would route the fleet onto an account
  // nobody has ever measured.
  it("reports an unmeasurable account as null, NOT as 0%", async () => {
    const report = dataOf(
      await readUsage(
        deps({
          listAccounts: async () => [acct("a")],
          getIdentities: async () => [signedIn("a")],
          getUsage: async () => [{ id: "a", tokens5h: 500, exhaustedUntil: null } as Usage],
          // No ceiling learned yet -> no fraction -> nothing to report.
          listCeilings: async () => [{ id: "a", samples: [], ceiling: null } as Ceiling],
          getUsageLive: async () => {
            throw new Error("no token");
          },
        }),
      ),
    );

    expect(report.rows[0]!.usageSource).toBe("unknown");
    expect(report.rows[0]!.fiveHourPercent).toBeNull();
    expect(report.rows[0]!.fiveHourPercent).not.toBe(0);
  });

  it("lets ONE account's failed fetch degrade only that row", async () => {
    const report = dataOf(
      await readUsage(
        deps({
          listAccounts: async () => [acct("a"), acct("b")],
          getIdentities: async () => [signedIn("a"), signedIn("b")],
          getUsageLive: async (configDir) => {
            if (configDir === "/cfg/a") throw new Error("401");
            return live({ fiveHourPercent: 12 });
          },
        }),
      ),
    );

    expect(report.rows.find((r) => r.accountId === "a")!.usageSource).toBe("unknown");
    expect(report.rows.find((r) => r.accountId === "b")!.usageSource).toBe("live");
    expect(report.rows.find((r) => r.accountId === "b")!.fiveHourPercent).toBe(12);
    // One failure is not a total outage.
    expect(report.liveUnavailable).toBe(false);
  });

  it("reports a FUTURE measured exhaustion and drops an expired one", async () => {
    const report = dataOf(
      await readUsage(
        deps({
          listAccounts: async () => [acct("live-wall"), acct("past-wall")],
          getIdentities: async () => [signedIn("live-wall"), signedIn("past-wall")],
          getUsage: async () => [
            { id: "live-wall", tokens5h: 0, exhaustedUntil: NOW + 60_000 } as Usage,
            { id: "past-wall", tokens5h: 0, exhaustedUntil: NOW - 60_000 } as Usage,
          ],
        }),
      ),
    );

    expect(report.rows.find((r) => r.accountId === "live-wall")!.exhaustedUntil).toBe(NOW + 60_000);
    expect(report.rows.find((r) => r.accountId === "live-wall")!.state).toBe("exhausted");
    // An expired bench is not something the human is waiting on.
    expect(report.rows.find((r) => r.accountId === "past-wall")!.exhaustedUntil).toBeNull();
  });

  it("names the accounts that share one login, so a switch between them is visibly pointless", async () => {
    const report = dataOf(
      await readUsage(
        deps({
          listAccounts: async () => [acct("one"), acct("two")],
          // Same accountUuid -> one Anthropic login behind two config dirs.
          getIdentities: async () => [
            signedIn("one", { accountUuid: "shared" }),
            signedIn("two", { accountUuid: "shared" }),
          ],
        }),
      ),
    );

    expect(report.rows.find((r) => r.accountId === "one")!.sameQuotaAs).toEqual(["two"]);
    // Two rows, but only ONE place to run work.
    expect(report.usableLogins).toBe(1);
  });

  // ── THE COUNT THE CONCIERGE SAYS OUT LOUD ───────────────────────────────────────────────────
  // `usableLogins` promises "how many DISTINCT logins can actually receive a spawn". The accounts
  // screen lets a human take one out of the pool from its ⋮ menu, and the spawn path honours that —
  // so an unnetted figure is not a stale statistic, it is the concierge telling someone there are
  // two accounts to rotate between while agents can only reach one.
  it("does not count a login the user took OUT of rotation", async () => {
    const base = deps({
      listAccounts: async () => [acct("a"), acct("b")],
      getIdentities: async () => [signedIn("a"), signedIn("b")],
    });
    // The control: both count while both are in the pool.
    expect(dataOf(await readUsage(base)).usableLogins).toBe(2);

    setAccountInRotation("b", false);
    const report = dataOf(await readUsage(base));
    expect(report.usableLogins).toBe(1);
    // …and the ROW says WHY, which is what makes the count and the rows one partition rather than
    // two. A netted count beside rows the model cannot tell apart is the count-contradicts-the-rows
    // shape inside a single JSON object — and the model is what picks the switch target from it.
    expect(report.rows.find((r) => r.accountId === "b")!.outOfRotationReason).toBe("manual");
    expect(report.rows.find((r) => r.accountId === "a")!.outOfRotationReason).toBeNull();
  });

  it("reports whether rotation is PAUSED, so a switch is not recommended into a freeze", async () => {
    const base = deps({
      listAccounts: async () => [acct("a"), acct("b")],
      getIdentities: async () => [signedIn("a"), signedIn("b")],
    });
    expect(dataOf(await readUsage(base)).rotationPaused).toBe(false);

    pauseRotation("a", 1000);
    const report = dataOf(await readUsage(base));
    expect(report.rotationPaused).toBe(true);
    // WHERE the work is going, not just that it stopped moving. `rotationPaused` alone is fleet-level
    // and does not answer the question a caller asks next.
    expect(report.pausedOnAccountId).toBe("a");
    // The pool is UNCHANGED by a pause — pausing does not take accounts out, it stops re-ranking
    // them. Reporting a shrunken count here would send the concierge to the wrong remedy.
    expect(report.usableLogins).toBe(2);
  });

  it("keeps a login whose FIRST registration was taken out, because the sibling still works", async () => {
    // THE ORDER-DEPENDENCE. `rotationReadiness` elects each login's representative by input order,
    // before any of the user's choices are known, so netting the opt-out off that representative
    // gave two answers for one fleet: taking the first row out dropped a login agents could still
    // reach through its sibling, while taking the sibling out changed nothing. `partitionAccounts`
    // excludes duplicates from nothing, so only the second answer was ever right.
    const shared = { accountUuid: "one-login" };
    const base = deps({
      listAccounts: async () => [acct("a"), acct("aa"), acct("b")],
      getIdentities: async () => [
        signedIn("a", shared),
        signedIn("aa", shared),
        signedIn("b"),
      ],
    });
    expect(dataOf(await readUsage(base)).usableLogins).toBe(2);

    setAccountInRotation("a", false);
    const first = dataOf(await readUsage(base));
    expect(first.usableLogins).toBe(2); // the shared login is still reachable through `aa`
    // …and `aa` is now the one representing it, so it must not ALSO report itself a duplicate.
    expect(first.rows.find((r) => r.accountId === "aa")!.outOfRotationReason).toBeNull();
    expect(first.rows.find((r) => r.accountId === "a")!.outOfRotationReason).toBe("manual");

    // The paired case — one fleet, one answer, whichever registration was excluded.
    setAccountInRotation("a", true);
    setAccountInRotation("aa", false);
    expect(dataOf(await readUsage(base)).usableLogins).toBe(2);

    // …and the login leaves only when EVERY registration of it is out.
    setAccountInRotation("a", false);
    expect(dataOf(await readUsage(base)).usableLogins).toBe(1);
  });

  it("names only a fleet target the router would actually honour", async () => {
    // The raw stored id is not the answer, and reporting it as one contradicts the rest of this
    // payload: pause onto `a`, take `a` out, and the old field returned `pausedOnAccountId: "a"`
    // beside `rows[a].outOfRotationReason: "manual"` while every spawn had fallen through elsewhere.
    const base = deps({
      listAccounts: async () => [acct("a"), acct("b")],
      getIdentities: async () => [signedIn("a"), signedIn("b")],
    });
    pauseRotation("a", 1000);
    expect(dataOf(await readUsage(base)).pausedOnAccountId).toBe("a"); // the control

    setAccountInRotation("a", false);
    const report = dataOf(await readUsage(base));
    expect(report.rotationPaused).toBe(true); // still paused — the FREEZE is what stopped biting
    expect(report.pausedOnAccountId).toBeNull();
  });

  it("names the OVERRIDE rather than the freeze, because the router consults it first", async () => {
    // `chooseAccountForAgent` skips the pause whenever a preference exists. A caller handed only
    // `pausedOnAccountId` would be told about the weaker of the two — and told the wrong account.
    const base = deps({
      listAccounts: async () => [acct("a"), acct("b")],
      getIdentities: async () => [signedIn("a"), signedIn("b")],
    });
    pauseRotation("a", 1000);
    setPreferredAccountId("b");

    const report = dataOf(await readUsage(base));
    expect(report.overrideAccountId).toBe("b");
    expect(report.pausedOnAccountId).toBeNull();
    expect(report.rotationPaused).toBe(true);
  });

  it("falls back to naming the FREEZE when the override stops being honourable", async () => {
    // THE DISCRIMINATING CASE. Suppressing the pause on the RAW stored preference blanks both fields
    // in exactly the state where the freeze is deciding: `usablePreferredAccount` declines a
    // preference whose account was taken out (or walled, or signed out), `usablePausedAccount` then
    // returns the frozen id, and every spawn lands there — while the report said routing was
    // automatic. Setting a preference that IS honourable, as the test above does, cannot see this.
    const base = deps({
      listAccounts: async () => [acct("a"), acct("b")],
      getIdentities: async () => [signedIn("a"), signedIn("b")],
    });
    setPreferredAccountId("a");
    pauseRotation("b", 1000);
    // The control: while `a` is honourable, the override is what decides and the freeze is not named.
    const before = dataOf(await readUsage(base));
    expect(before.overrideAccountId).toBe("a");
    expect(before.pausedOnAccountId).toBeNull();

    setAccountInRotation("a", false);

    const after = dataOf(await readUsage(base));
    expect(after.overrideAccountId).toBeNull();
    expect(after.pausedOnAccountId).toBe("b");
  });

  it("reports an install where NO account reports an email CONSISTENTLY, not optimistically", async () => {
    // `accounts.rs` leaves `Identity.email` null for any config dir with no parseable `oauthAccount`,
    // and the ROUTER degrades open on that reading — it honours the preference rather than dropping
    // it, because an absent signal is not evidence. Mirroring that here was tried and made one
    // payload say two things: `overrideAccountId: "a"` beside `usableLogins: 0`, every row reading
    // `not-signed-in`, and `switch_all` refusing every account. A model reading that is told the
    // fleet is routed to `a` and that it cannot move the fleet anywhere.
    //
    // So this asserts the WHOLE payload agrees with itself, which is the property that makes it
    // reasonable to reason over. The divergence from the router is a stated overstatement in
    // `honouredTarget`, not a silent one.
    const base = deps({
      listAccounts: async () => [acct("a"), acct("b")],
      getIdentities: async () => [
        { id: "a", email: null, organization: null, accountUuid: null },
        { id: "b", email: null, organization: null, accountUuid: null },
      ],
    });
    setPreferredAccountId("a");

    const report = dataOf(await readUsage(base));
    expect(report.overrideAccountId).toBeNull();
    expect(report.usableLogins).toBe(0);
    expect(report.rows.every((r) => r.outOfRotationReason === "not-signed-in")).toBe(true);
    expect(report.rows.every((r) => !r.signedIn)).toBe(true);
  });

  it("marks the account the fleet is actually on", async () => {
    const report = dataOf(
      await readUsage(
        deps({
          listAccounts: async () => [acct("a"), acct("b")],
          getIdentities: async () => [signedIn("a"), signedIn("b")],
          currentAccountId: () => "b",
        }),
      ),
    );

    expect(report.currentAccountId).toBe("b");
    expect(report.rows.find((r) => r.accountId === "b")!.isCurrent).toBe(true);
    expect(report.rows.find((r) => r.accountId === "a")!.isCurrent).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// switch_all — every refusal PAIRED with the switch that proves the guard is the cause
// ---------------------------------------------------------------------------------------------

describe("switch_all", () => {
  it("hands the request to the switch engine with THAT account's id", async () => {
    const spy = vi.fn(() => true);
    const r = await switchAll(
      "target",
      deps({
        listAccounts: async () => [acct("current"), acct("target")],
        getIdentities: async () => [signedIn("current"), signedIn("target")],
        currentAccountId: () => "current",
        activateAccount: spy,
      }),
    );

    expect(r.ok).toBe(true);
    // THE side effect. Without this the tool could report success having done nothing.
    expect(spy).toHaveBeenCalledWith("target");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(dataOf(r).migratingNow).toBe(true);
  });

  // ACTIVATION'S TWO HALVES, and the pair that keeps them distinguishable. With no switch host
  // mounted the durable half still happens — the account becomes the one new agents start on — but
  // nothing already running moves. Both cases are `ok`, so a caller that reads only `ok` cannot
  // tell "they are moving" from "they will move as they restart", and would tell a human waiting on
  // a limit the wrong one. The note must differ too: it is what the concierge reads back aloud.
  it("says nothing is moving YET when no switch host is mounted", async () => {
    const r = await switchAll(
      "target",
      deps({
        listAccounts: async () => [acct("current"), acct("target")],
        getIdentities: async () => [signedIn("current"), signedIn("target")],
        currentAccountId: () => "current",
        // The durable half happened; no mounted hook took the migration half.
        activateAccount: vi.fn(() => false),
      }),
    );

    expect(r.ok).toBe(true);
    expect(dataOf(r).migratingNow).toBe(false);
    expect(dataOf(r).note).toMatch(/nothing already running is being moved/);
    expect(dataOf(r).note).not.toMatch(/safe stopping point/);
  });

  it("REFUSES an account sharing the current one's quota, and does not call the engine", async () => {
    const spy = vi.fn(() => true);
    const r = await switchAll(
      "twin",
      deps({
        listAccounts: async () => [acct("current"), acct("twin")],
        getIdentities: async () => [
          signedIn("current", { accountUuid: "shared" }),
          signedIn("twin", { accountUuid: "shared" }),
        ],
        currentAccountId: () => "current",
        activateAccount: spy,
      }),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("same-quota");
    expect(spy).not.toHaveBeenCalled();
  });

  // THE PAIR for the test above: identical setup, different login. Without this, the refusal test
  // would pass equally against a switchAll that refused everything.
  it("…but DOES switch when that same account is a different login", async () => {
    const spy = vi.fn(() => true);
    const r = await switchAll(
      "twin",
      deps({
        listAccounts: async () => [acct("current"), acct("twin")],
        getIdentities: async () => [
          signedIn("current", { accountUuid: "shared" }),
          // The ONLY difference from the previous test.
          signedIn("twin", { accountUuid: "its-own" }),
        ],
        currentAccountId: () => "current",
        activateAccount: spy,
      }),
    );

    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith("twin");
  });

  // THE THIRD-ACCOUNT CASE, and the reason it is not redundant with the pair above: there, the
  // current account's duplicate group is either the target or nothing at all, so a membership test
  // reading `some(a => a.id !== target)` refuses just as often as the correct one and nothing goes
  // red (mutation-check flagged exactly this line as uncaught). Here the group has a member that is
  // NOT the target — the founder's real shape, two registrations of one login plus a separate one —
  // so an inverted membership test refuses a switch that must be allowed.
  it("switches to a THIRD login even though the current account has a twin", async () => {
    const spy = vi.fn(() => true);
    const r = await switchAll(
      "other",
      deps({
        listAccounts: async () => [acct("current"), acct("twin"), acct("other")],
        getIdentities: async () => [
          signedIn("current", { accountUuid: "shared" }),
          // `twin` shares the current account's login; `other` does not, so it is a real target.
          signedIn("twin", { accountUuid: "shared" }),
          signedIn("other", { accountUuid: "its-own" }),
        ],
        currentAccountId: () => "current",
        activateAccount: spy,
      }),
    );

    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith("other");
  });

  it("refuses an account with no Claude login behind it", async () => {
    const spy = vi.fn(() => true);
    const r = await switchAll(
      "empty",
      deps({
        listAccounts: async () => [acct("current"), acct("empty")],
        // `empty` has no identity row at all — registered, never signed in.
        getIdentities: async () => [signedIn("current")],
        currentAccountId: () => "current",
        activateAccount: spy,
      }),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-signed-in");
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses the account the fleet is already on", async () => {
    const spy = vi.fn(() => true);
    const r = await switchAll(
      "current",
      deps({
        listAccounts: async () => [acct("current")],
        getIdentities: async () => [signedIn("current")],
        currentAccountId: () => "current",
        activateAccount: spy,
      }),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("already-current");
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses an id that names no registered account", async () => {
    const spy = vi.fn(() => true);
    const r = await switchAll(
      "ghost",
      deps({
        listAccounts: async () => [acct("current")],
        getIdentities: async () => [signedIn("current")],
        activateAccount: spy,
      }),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown-account");
    expect(spy).not.toHaveBeenCalled();
  });
});
