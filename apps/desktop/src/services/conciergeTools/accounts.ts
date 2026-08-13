// The ACCOUNTS domain — "where do I stand on my Claude accounts, and move everything to a better
// one".
//
// THE PROBLEM THIS SOLVES. The founder loses hours to account limits, and the two facts that would
// end that were both unreachable from the concierge: which account has room, and a way to move the
// fleet onto it. Both already EXIST in the app — the Accounts screen shows live usage and carries a
// "Switch all agents here" button — but only inside a transient modal the human has to go find. This
// domain puts the same two answers where they are already typing.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// NOTHING HERE COMPUTES USAGE. Every number is borrowed.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `read_usage` is a PROJECTION over sources that already exist, and deliberately re-derives none of
// them:
//
//   * REAL server-side utilization from `getAccountUsageLive` (Rust `account_usage_live` →
//     Anthropic's OAuth usage endpoint). This is ground truth, and it is per-account.
//   * The LEARNED-ceiling estimate from `assessHeadroom` (services/headroom), used only where live
//     numbers could not be fetched.
//   * The MEASURED exhaustion flag from `limitSync`'s rate-limit episodes, which outranks both —
//     an account that HAS hit its wall is exhausted whatever any percentage says.
//
// EVERY ROW STATES WHICH OF THOSE IT IS (`usageSource`). That is the whole point of the field: the
// difference between "Anthropic says 82%" and "we guessed 82% from your own past limits" is exactly
// the difference the human needs to decide whether to trust it, and a report that flattens them is
// worse than one that admits it does not know. `"unknown"` is a first-class answer here and renders
// as "not enough evidence" — never as 0%, which reads as "plenty of room" and is the one wrong
// answer that actively costs the human a working account.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `switch_all` REUSES THE EXISTING SWITCH ENGINE. It does not implement one.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// It calls `activateAccount` (hooks/useAccountSwitch) — the ONE entry point the Accounts screen's
// "Activate this account" uses, driven by the app-wide `useAccountSwitch` host, which migrates each
// agent at its own SAFE TURN BOUNDARY. A fleet-wide switch takes minutes and must outlive whatever
// raised it, so this domain hands off the request and returns; it never drives the migration itself.
//
// ACTIVATION HAS TWO HALVES AND ONLY ONE IS GUARANTEED, so the reply reports which happened.
// `activateAccount` returns whether any already-running agent was ENROLLED IN A MIGRATION; the
// durable half — recording the preference and sweeping the previous activation's pins — happens
// either way. When nothing is enrolled, each agent lands on the account at its next spawn instead.
// That is a slower path to the same place, not a failure, but it is a different sentence to say to
// a human waiting for a limit to clear: "they are moving" and "they will move as they restart" are
// answers to different questions, and reporting the second as the first is the copy bug this field
// exists to prevent.
//
// AN EMPTY PLAN IS THE COMMON CASE, NOT THE EXOTIC ONE — which is why the signal cannot be "did a
// host answer". `AccountSwitchHost` is mounted unconditionally inside `AuthGate`, so a host is
// essentially always there; what varies is whether the plan enrolled anyone, and it enrolls nobody
// when every pane already sits on the target or the rest are pinned. Reading a mounted host as a
// migration is exactly the false reassurance this field was added to stop (roborev job 63349).
//
// It is classified `disruptive`, which under `DEFAULT_DECISION_BY_RISK` derives to `ask` — so the
// human is asked before the fleet moves, through the ordinary approval path. There is deliberately
// no second, bespoke confirm token here: the Accounts screen's two-click confirm is a UI affordance
// for a button, and re-inventing it as an argument would put a gate in front of the gate while
// letting a model satisfy it by simply setting a flag.
//
// THE SAME-QUOTA REFUSAL IS THE LOAD-BEARING GUARD. Two config dirs can hold ONE Anthropic login —
// this is not hypothetical, it happened on the founder's own machine with two rows nicknamed
// "DROdio Storytell" and "DROdio Gmail". Switching between them moves every agent sideways into the
// identical quota and re-hits the identical wall seconds later, having interrupted the whole fleet
// to do it. Sameness is decided by `duplicateAccountGroups` and NOT re-derived here: `headroom.ts`
// documents a shipped bug caused by a second, subtly-different sameness rule, so this asks the
// canonical one.
import {
  duplicateAccountGroups,
  accountDisplay,
  accountSentenceName,
  signedInAccountIds,
  listAccounts,
  getIdentities,
  getUsage,
  listCeilings,
  type Account,
  type Identity,
  type Usage,
} from "../accountStore";
import { assessHeadroom, rotationReadiness, type Ceiling, type Headroom } from "../headroom";
import { getAccountUsageLive, type AccountUsageLive } from "../accountUsage";
import { activateAccount } from "../../hooks/useAccountSwitch";
import { busiestPaneAccount } from "../paneControl";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

export const ACCOUNTS_OPS = ["read_usage", "switch_all"] as const;

export type AccountsOp = (typeof ACCOUNTS_OPS)[number];

/** `read_usage` observes only. `switch_all` re-points every agent, so it is `disruptive` — which is
 *  what makes it `ask` by default (see `DEFAULT_DECISION_BY_RISK`). */
export type AccountsRisk = "read-only" | "disruptive";

export const ACCOUNTS_RISK: Record<AccountsOp, AccountsRisk> = {
  read_usage: "read-only",
  switch_all: "disruptive",
};

/** Prose for the settings pane and the approval card. Spread into `SUMMARY_BY_TOOL`. */
export const ACCOUNTS_TOOL_SUMMARY: Record<AccountsOp, string> = {
  read_usage:
    "Reads how much of each Claude account's limit is used — real server-side numbers where they " +
    "can be fetched, and says so when they can't.",
  switch_all:
    "Moves every agent, and the concierge, onto a different Claude account as each reaches a safe " +
    "stopping point.",
};

// ---------------------------------------------------------------------------------------------
// Results — the board/lifecycle convention
// ---------------------------------------------------------------------------------------------

export interface AccountsOk<T> {
  ok: true;
  op: AccountsOp;
  risk: AccountsRisk;
  data: T;
}

export interface AccountsRefusal {
  ok: false;
  op: AccountsOp;
  risk: AccountsRisk;
  reason: string;
  message: string;
}

export type AccountsResult<T> = AccountsOk<T> | AccountsRefusal;

function ok<T>(op: AccountsOp, data: T): AccountsOk<T> {
  return { ok: true, op, risk: ACCOUNTS_RISK[op], data };
}

function refuse(op: AccountsOp, reason: string, message: string): AccountsRefusal {
  return { ok: false, op, risk: ACCOUNTS_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

/**
 * Where a percentage came from. The field exists so a caller can never present a guess as a
 * measurement — see the header.
 *
 *  * `live`    — Anthropic's own number for this account. Ground truth.
 *  * `learned` — our estimate against a ceiling learned from this account's past limit episodes.
 *  * `unknown` — neither was available. `fiveHourPercent` is null and MUST render as "not enough
 *                evidence", never as 0%.
 */
export type UsageSource = "live" | "learned" | "unknown";

/** One account's standing. */
export interface AccountUsageRow {
  accountId: string;
  /** The VERIFIED identity (email/org), never the user-typed nickname — same rule the switch banner
   *  follows, because a nickname proves nothing about which login a config dir holds. */
  name: string;
  /** True for the account the fleet is running on right now. */
  isCurrent: boolean;
  signedIn: boolean;
  usageSource: UsageSource;
  /** Rolling 5-hour session window, 0–100. Null when `usageSource` is `unknown`. */
  fiveHourPercent: number | null;
  /** ISO-8601, live only — the learned estimate has no reset instant to quote. */
  fiveHourResetsAt: string | null;
  /** 7-day window, 0–100. Live only; the local estimate models no weekly window. */
  sevenDayPercent: number | null;
  sevenDayResetsAt: string | null;
  /**
   * MEASURED exhaustion — epoch ms until which this account is benched by a real observed
   * rate-limit event, or null. Authoritative and independent of the percentages: it outranks them,
   * because an account that has hit its wall is out of room whatever any estimate says.
   */
  exhaustedUntil: number | null;
  /** `ok` | `warn` | `exhausted` | `unknown`, straight from {@link assessHeadroom}. */
  state: Headroom["state"];
  /** Other registered accounts that resolve to the SAME Anthropic login, and therefore share this
   *  one's quota. Non-empty means switching between them buys nothing. */
  sameQuotaAs: string[];
}

export interface UsageReport {
  /** The account every new agent is running on, or null when nothing is running. */
  currentAccountId: string | null;
  rows: AccountUsageRow[];
  /** How many DISTINCT logins can actually receive a spawn — below 2 there is nowhere to switch. */
  usableLogins: number;
  /**
   * True when live numbers could not be fetched for ANY account, so the whole report is estimate-
   * only. Stated once here as well as per-row so a caller cannot miss it: this is the difference
   * between "your accounts are fine" and "we could not ask".
   */
  liveUnavailable: boolean;
}

// ---------------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------------

/**
 * Everything this domain reads or triggers, in one injectable object.
 *
 * ONE object with real defaults, rather than a per-parameter default at each call site: that is the
 * shape AGENTS.md prescribes, because a seam every test overrides leaves the production wiring
 * covered by nothing. `accounts.test.ts` asserts these defaults ARE the real functions, so deleting
 * a line here goes red instead of silently un-wiring the tool.
 */
export interface AccountsDeps {
  listAccounts: () => Promise<Account[]>;
  getIdentities: () => Promise<Identity[]>;
  getUsage: () => Promise<Usage[]>;
  listCeilings: () => Promise<Ceiling[]>;
  getUsageLive: (configDir: string) => Promise<AccountUsageLive>;
  /** Returns whether a mounted host took the migration half — see the header. */
  activateAccount: (accountId: string) => boolean;
  currentAccountId: () => string | null;
  now: () => number;
}

export const ACCOUNTS_DEPS: AccountsDeps = {
  listAccounts,
  getIdentities,
  getUsage,
  listCeilings,
  getUsageLive: getAccountUsageLive,
  activateAccount,
  currentAccountId: busiestPaneAccount,
  now: Date.now,
};

// ---------------------------------------------------------------------------------------------
// read_usage
// ---------------------------------------------------------------------------------------------

/**
 * Every account's standing, live where possible.
 *
 * The live fetches run CONCURRENTLY and each is allowed to fail on its own: one account with a
 * stale token must not blank the report for the four that are fine. A rejection degrades that row
 * to the learned estimate (or to `unknown`), which is why the fetch is wrapped rather than awaited
 * in a chain.
 */
export async function readUsage(
  deps: AccountsDeps = ACCOUNTS_DEPS,
): Promise<AccountsResult<UsageReport>> {
  const [accounts, identities, usage, ceilings] = await Promise.all([
    deps.listAccounts(),
    deps.getIdentities(),
    deps.getUsage(),
    deps.listCeilings(),
  ]);

  const now = deps.now();
  const identityById = new Map(identities.map((i) => [i.id, i]));
  const headroomById = new Map(assessHeadroom(usage, ceilings, now).map((h) => [h.accountId, h]));
  const usageById = new Map(usage.map((u) => [u.id, u]));
  const signedIn = new Set(signedInAccountIds(identities));
  const currentAccountId = deps.currentAccountId();

  // Same-login grouping, from the CANONICAL rule — see the header for why this is not re-derived.
  const sameQuota = new Map<string, string[]>();
  for (const group of duplicateAccountGroups(accounts, identities)) {
    for (const a of group.accounts) {
      sameQuota.set(
        a.id,
        group.accounts.filter((o) => o.id !== a.id).map((o) => o.id),
      );
    }
  }

  // One live fetch per account, concurrent, each failing independently.
  const live = await Promise.all(
    accounts.map((a) =>
      deps
        .getUsageLive(a.configDir)
        .then((v) => ({ id: a.id, value: v as AccountUsageLive | null }))
        .catch(() => ({ id: a.id, value: null })),
    ),
  );
  const liveById = new Map(live.map((l) => [l.id, l.value]));

  const rows: AccountUsageRow[] = accounts.map((a) => {
    const identity = identityById.get(a.id);
    const h = headroomById.get(a.id);
    const l = liveById.get(a.id) ?? null;
    const exhaustedUntilRaw = usageById.get(a.id)?.exhaustedUntil ?? null;

    // A live 5h number is ground truth. Fall back to the learned fraction, and only then to
    // nothing — never to 0, which would read as "plenty of room".
    const learnedPercent = h?.fraction != null ? Math.round(h.fraction * 100) : null;
    const usageSource: UsageSource =
      l?.fiveHourPercent != null ? "live" : learnedPercent != null ? "learned" : "unknown";

    return {
      accountId: a.id,
      name: accountSentenceName(accountDisplay(a, identity)),
      isCurrent: a.id === currentAccountId,
      signedIn: signedIn.has(a.id),
      usageSource,
      fiveHourPercent: usageSource === "live" ? l!.fiveHourPercent : learnedPercent,
      // A reset instant exists only for a live window — the learned estimate has none, and inventing
      // one would be the report's only fabricated field.
      fiveHourResetsAt: usageSource === "live" ? l!.fiveHourResetsAt : null,
      sevenDayPercent: l?.sevenDayPercent ?? null,
      sevenDayResetsAt: l?.sevenDayResetsAt ?? null,
      // Only a FUTURE bench is a live fact; an expired one is not something the human is waiting on.
      exhaustedUntil:
        exhaustedUntilRaw != null && exhaustedUntilRaw > now ? exhaustedUntilRaw : null,
      state: h?.state ?? "unknown",
      sameQuotaAs: sameQuota.get(a.id) ?? [],
    };
  });

  return ok("read_usage", {
    currentAccountId,
    rows,
    usableLogins: rotationReadiness(accounts, identities).usableLogins,
    // "No account returned a live number." Vacuously false with no accounts at all, which is the
    // honest reading: there is nothing we failed to fetch.
    liveUnavailable: rows.length > 0 && rows.every((r) => r.usageSource !== "live"),
  });
}

// ---------------------------------------------------------------------------------------------
// switch_all
// ---------------------------------------------------------------------------------------------

/** What the caller gets back once the request is handed to the switch host. */
export interface SwitchAllAccepted {
  accountId: string;
  name: string;
  /** Always true — the migration itself is asynchronous and driven by the app-wide host, so this
   *  reports that the request was ACCEPTED, never that every agent has already moved. */
  requested: true;
  /**
   * Whether anything ALREADY RUNNING was enrolled in a migration. False whenever the plan came back
   * empty — every agent already on this account, all remaining ones pinned or sticky, or nothing
   * mounted — in which case only the durable half happened and each agent lands here at its next
   * spawn. Never collapse this into `requested`, and never read it as "a switch host exists": that
   * host is mounted unconditionally, so it is a constant, not a signal. See the header.
   */
  migratingNow: boolean;
  /** How many agents are expected to migrate is deliberately NOT claimed here: each moves at its own
   *  safe turn boundary and the count can change while that happens. */
  note: string;
}

/**
 * Point every agent (and the concierge) at `accountId`.
 *
 * Four refusals, each its own code because they demand different responses from the caller:
 * an id that names nothing, an account with no Claude login behind it, the account the fleet is
 * ALREADY on, and — the important one — an account sharing the current one's quota.
 */
export async function switchAll(
  accountId: string,
  deps: AccountsDeps = ACCOUNTS_DEPS,
): Promise<AccountsResult<SwitchAllAccepted>> {
  const [accounts, identities] = await Promise.all([deps.listAccounts(), deps.getIdentities()]);

  const target = accounts.find((a) => a.id === accountId);
  if (!target) {
    return refuse(
      "switch_all",
      "unknown-account",
      `There is no registered account with id ${accountId}.`,
    );
  }

  const identityById = new Map(identities.map((i) => [i.id, i]));
  const name = accountSentenceName(accountDisplay(target, identityById.get(target.id)));

  if (!new Set(signedInAccountIds(identities)).has(target.id)) {
    return refuse(
      "switch_all",
      "not-signed-in",
      `${name} has no Claude login behind it, so moving the fleet there would just land every ` +
        `agent on a login prompt. Sign into it first.`,
    );
  }

  const currentAccountId = deps.currentAccountId();
  if (currentAccountId === target.id) {
    return refuse(
      "switch_all",
      "already-current",
      `Every agent is already running on ${name}.`,
    );
  }

  // THE SAME-QUOTA GUARD. Canonical grouping only — see the header.
  if (currentAccountId) {
    const group = duplicateAccountGroups(accounts, identities).find((g) =>
      g.accounts.some((a) => a.id === currentAccountId),
    );
    if (group?.accounts.some((a) => a.id === target.id)) {
      return refuse(
        "switch_all",
        "same-quota",
        `${name} is the same Anthropic login as the account the fleet is on now — two registrations ` +
          `of one account share a single quota, so switching would interrupt every agent and hit the ` +
          `identical limit straight away. Pick an account with a different login.`,
      );
    }
  }

  const migratingNow = deps.activateAccount(target.id);
  return ok("switch_all", {
    accountId: target.id,
    name,
    requested: true,
    migratingNow,
    note: migratingNow
      ? "Each agent moves when it reaches a safe stopping point, so the switch completes over the " +
        "next few minutes rather than instantly."
      : `${name} is now the account new agents start on, but nothing already running is being ` +
        `moved — the app's switch host isn't mounted, so each agent lands there when it next spawns.`,
  });
}
