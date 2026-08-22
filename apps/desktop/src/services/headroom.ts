// "How close is this account to its limit, and is there a better one to move to?"
//
// PURE decision logic for the proactive switch banner. Everything here is a function of data the
// rest of the system already produces — no IO — so the policy is unit-testable and the UI stays a
// thin renderer over it.
//
// The hard part is that Anthropic's real caps aren't readable, so "80% of the limit" has no
// absolute meaning. We compare instead against a ceiling LEARNED from each account's own history
// (Rust `accounts_ceilings`: the median 5h consumption observed at that account's past rate-limit
// episodes). That makes the estimate self-calibrating per subscription tier, and it degrades
// honestly: with too few episodes the ceiling is null and we simply don't claim to know.
//
// Why the estimate is trustworthy enough to act on: measured across 11 real limit episodes, 5h
// consumption at the moment of a limit had a coefficient of variation of 0.24 once cache reads were
// excluded from the unit. That's tight enough to warn on, and much too loose to promise precision —
// hence a threshold well below 1.0 and a banner that RECOMMENDS rather than acts unilaterally.

import type { Account, Usage, Identity, AccountDisplay, LiveUsage } from "./accountStore";
import {
  accountSentenceName,
  signedInAccountIds,
  duplicateAccountGroups,
  loginSiblingIds,
  loginLiveWorstPercent,
  LIVE_AVOID_PERCENT,
} from "./accountStore";

/** Fraction of the learned ceiling at which we start recommending a switch. Chosen against the
 *  observed spread (CoV 0.24): at 0.8 a typical account still has real runway left, so the switch
 *  can wait for a natural boundary instead of interrupting work. */
export const WARN_FRACTION = 0.8;

/** Shared empty set for the optional `deadLoginIds` argument, so the default never allocates and the
 *  "no signal / before the first probe" case is a single canonical value. See
 *  {@link switchRecommendation}'s third trigger arm. */
const NO_DEAD_LOGINS: ReadonlySet<string> = new Set<string>();

/** A learned ceiling from Rust (`accounts_ceilings`). `ceiling` is null until enough limit
 *  episodes have been observed — treat that as "unknown", never as zero. */
export interface Ceiling {
  id: string;
  samples: number[];
  ceiling: number | null;

  // Mirrors of the §4b wire fields (PRD/sparkle/claude-account-identity-truth.md). OPTIONAL for the
  // same reason the Identity additions are: this file can land before the Rust does. Neither drives
  // any copy, and deliberately so — a ceiling that survived an identity change is BY CONSTRUCTION
  // one whose remaining samples all belong to the current login, because `ceiling_for_account` cuts
  // the others before returning a number. There is nothing left to caveat (knightwatch probe 4).
  /** The `accountUuid` the samples were measured against; null when the account has no resolvable
   *  identity, in which case `ceiling` is null too. */
  accountUuid?: string | null;
  /** True when samples were discarded because the identity behind the config dir changed inside the
   *  learn window. `ceiling` may be null purely for this reason. */
  resetByIdentityChange?: boolean;
}

/** Where one account stands relative to its learned ceiling. */
export interface Headroom {
  accountId: string;
  /** Current trailing-5h consumption (cache reads already excluded upstream). */
  used: number;
  /** Learned ceiling, or null when not enough evidence. */
  ceiling: number | null;
  /** `used / ceiling`, or null when the ceiling is unknown. Can exceed 1. */
  fraction: number | null;
  state: "ok" | "warn" | "exhausted" | "unknown";
}

/** Classify every account's headroom.
 *
 *  `exhausted` is authoritative and comes from an observed rate-limit event, so it outranks any
 *  estimate — an account that HAS hit its limit is exhausted regardless of what the ceiling says.
 *  `unknown` means we have no learned ceiling yet; it is deliberately distinct from `ok` so callers
 *  never present a guess as a measurement. */
export function assessHeadroom(
  usage: Usage[],
  ceilings: Ceiling[],
  now: number = Date.now(),
): Headroom[] {
  const ceilingById = new Map(ceilings.map((c) => [c.id, c.ceiling]));
  return usage.map((u) => {
    const ceiling = ceilingById.get(u.id) ?? null;
    const isExhausted = u.exhaustedUntil != null && u.exhaustedUntil > now;
    const fraction = ceiling != null && ceiling > 0 ? u.tokens5h / ceiling : null;
    let state: Headroom["state"];
    if (isExhausted) state = "exhausted";
    else if (fraction == null) state = "unknown";
    else if (fraction >= WARN_FRACTION) state = "warn";
    else state = "ok";
    return { accountId: u.id, used: u.tokens5h, ceiling, fraction, state };
  });
}

/** A proposed move off an account that's running out, onto one with room. */
export interface SwitchRecommendation {
  from: Account;
  to: Account;
  /** `from`'s position against its learned ceiling (null when it's already exhausted with no
   *  ceiling learned — the recommendation still stands, we just can't quantify it). */
  fraction: number | null;
  /** Why we're recommending. ONLY `"exhausted"` — read as "out of room by an AUTHORITATIVE signal",
   *  which is now either the observed rate-limit wall OR real Anthropic utilization (weekly/session)
   *  at/above {@link LIVE_AVOID_PERCENT}; see the trigger in {@link switchRecommendation}. What stays
   *  excluded is the learned-ceiling `"approaching"` ESTIMATE, retired as a driver (founder's call) —
   *  narrowing the union to this single reachable value makes the compiler flag any stale
   *  `"approaching"` branch rather than letting a producer emit a reason the formatter would silently
   *  mislabel as "has hit its limit". Both authoritative signals mean the fleet cannot keep working on
   *  `from`, which is exactly what "has hit its limit. Switch to X to keep working." states. */
  reason: "exhausted";
  /** True when the ONLY reason `from` is spent is a DEFINITELY-expired login (no usage wall, no live
   *  over-utilization). Kept SEPARATE from `reason` on purpose: the auto-migration, helper-rescue and
   *  dismissal gates all key on `reason === "exhausted"` and must fire for an expired login exactly as
   *  for a wall, so `reason` stays `"exhausted"`; this only redirects the human-facing SENTENCE
   *  ({@link describeRecommendation}) away from "has hit its limit" — which, for an expired session,
   *  would tell the user to wait out a usage limit that never resets instead of re-authenticating. */
  expired?: boolean;
}

/** Rank candidate targets: least-loaded first, in three tiers so a near-ceiling target is a LAST
 *  resort rather than a preferred one. `exhausted` and live-spent targets are excluded before this
 *  runs, so `state` here is only `ok` / `unknown` / `warn`:
 *
 *   - `[0, 1)`  OK, quantified-healthy — sort by its own fraction (< {@link WARN_FRACTION}).
 *   - `[1, 2)`  UNKNOWN ceiling — behind every quantified-healthy account, ordered by raw usage so
 *               the least-used unknown still wins over a busier one. A freshly-added account with no
 *               learned ceiling lands here.
 *   - `[2, 3)`  WARN (near its learned ceiling) — behind BOTH of the above. Admitted as a target
 *               only because the estimate may no longer VETO one (a real wall must not strand the
 *               fleet), but it is the least preferred: an unknown-ceiling zero-usage account is a
 *               better bet than one the estimate says is at 99% of its ceiling.
 *
 *  The old single-line rank (`fraction`, else `1 + used/(used+1)`) mis-ordered exactly this: a `warn`
 *  target scored 0.8–1.0 and an unknown-ceiling account scored ≥ 1.0, so the near-ceiling account
 *  sorted AHEAD of the unknown one. That never mattered while `warn` was filtered out; admitting it
 *  as a target exposed it. */
function headroomRank(h: Headroom): number {
  if (h.state === "warn") return 2 + (h.fraction ?? 1);
  if (h.fraction != null) return h.fraction; // ok / quantified-healthy
  return 1 + h.used / (h.used + 1); // unknown ceiling
}

/** Recommend a switch, or null if none is warranted.
 *
 *  Only accounts that are SIGNED IN and not currently exhausted are eligible targets — moving to an
 *  account with no login just relocates the problem to a login prompt, and moving to an exhausted
 *  one relocates it to the same wall.
 *
 *  A registration resolving to the SAME Anthropic login as `from` is excluded for exactly that
 *  reason, and it is not hypothetical: `duplicateAccountGroups` exists because two config dirs
 *  nicknamed "DROdio Storytell" and "DROdio Gmail" both held one `accountUuid` on a real machine.
 *  Two folders, one quota — so "switch" moves every agent sideways into the identical limit and
 *  re-hits it immediately, under a banner naming both sides with the same email. The dedup already
 *  existed for the DISPLAY (`duplicateAccountGroups`) and for BENCHING (`siblingMap`); it was never
 *  applied to this DECISION.
 *
 *  Sameness is whatever {@link duplicateAccountGroups} says it is — ONE rule, shared with the
 *  display and with benching, rather than a second policy spelled out here. That matters because
 *  this file DID spell out a second one, and the two disagreed in precisely the case the canonical
 *  rule is careful about (knightwatch probe 2 on PR #1261): an email-only `from` was judged the
 *  same login as EVERY uuid-bearing candidate sharing its email, even when that email maps to more
 *  than one account. `duplicateAccountGroups` refuses that inference outright — an ambiguous
 *  email-only row is grouped with nothing — but the local rule excluded all of them, so an
 *  exhausted account with two perfectly good alternatives got NO recommendation at all. That is the
 *  outcome the same-login guard exists to prevent, reintroduced one level over.
 *
 *  The canonical rule keeps the property the local one was reaching for: it pairs only on POSITIVE
 *  evidence (a shared uuid, or an email that identifies exactly one uuid group), so an undecidable
 *  pair stays a candidate instead of silently emptying the list. Deriving from it rather than
 *  re-deriving beside it is what makes that guarantee hold in both places at once.
 *
 *  `currentAccountId` is the account agents are actually running under; a recommendation is only
 *  made about that account, since switching an account nobody is using accomplishes nothing. */
export function switchRecommendation(
  currentAccountId: string | null,
  accounts: Account[],
  usage: Usage[],
  ceilings: Ceiling[],
  identities: Identity[],
  now: number = Date.now(),
  live: readonly LiveUsage[] = [],
  deadLoginIds: ReadonlySet<string> = NO_DEAD_LOGINS,
): SwitchRecommendation | null {
  if (!currentAccountId) return null;
  const from = accounts.find((a) => a.id === currentAccountId);
  if (!from) return null;

  const liveById = new Map(live.map((l) => [l.id, l]));
  const byId = new Map(assessHeadroom(usage, ceilings, now).map((h) => [h.accountId, h]));
  const current = byId.get(currentAccountId);
  if (!current) return null;

  // ONE login grouping, shared by the current-account spend test below and — via
  // {@link bestHealthyTarget} — the same-login exclusion and the per-login live check on candidates.
  const siblingIds = loginSiblingIds(accounts, identities);

  // TRIGGER on EITHER authoritative signal auto-pick already acts on for the CURRENT account — never
  // the learned-ceiling ESTIMATE:
  //
  //   * the OBSERVED WALL — a REAL rate-limit event, `exhaustedUntil` in the future (`state ===
  //     "exhausted"`); OR
  //   * real Anthropic utilization at/above LIVE_AVOID_PERCENT — its OWN number, WEEKLY or session,
  //     judged per login ({@link loginLiveWorstPercent}), the SAME test used to EXCLUDE a target just
  //     below and the SAME one `partitionAccounts`/`exhaustionOutlook` gate spawns on; OR
  //   * a DEFINITELY-EXPIRED login — Claude Code's own live `claude auth status` says the OAuth
  //     session on this account is dead ({@link authIsDefinitelyExpired}, folded per-account into
  //     `deadLoginIds` by the caller). An expired login is out of room in the way that matters MOST:
  //     it cannot authenticate at all, so every agent on it 401s. The two signals above only catch an
  //     account that hit a USAGE wall — an expired token records neither a rate-limit event
  //     (`exhaustedUntil` stays null → never "exhausted") nor a utilization figure (the usage probe
  //     401s too → `loginLiveWorstPercent` is null → scored 0% via the `?? 0`, i.e. the HEALTHIEST
  //     possible), so before this arm a dead account stranded the fleet on it silently, scored as the
  //     emptiest account on the machine. `deadLoginIds` carries ONLY a live CLI "no" (source "cli");
  //     an errored/pending/offline/never-probed account is absent from it, so a flaky probe can never
  //     manufacture a false trigger — the same "defers to signed-in" rule `deriveRowLogin` applies to
  //     the EXPIRED badge.
  //
  // The WEEKLY cap is the case the second arm closes (bead sparkle-hbyae): an account at 100% of its
  // 7-day limit with its 5-HOUR SESSION at 0% never records a session rate-limit event, so its
  // `exhaustedUntil` stays null and `state` never becomes "exhausted" — yet the fleet running on it is
  // just as walled, refused by Anthropic until the weekly window resets (up to a day). Before this,
  // the live weekly signal excluded that account as a spawn TARGET but never moved the fleet OFF it,
  // so the migration the founder had auto-switch ON for silently did not fire and he activated a
  // healthy account by hand. Reading Anthropic's own number here is consistent with the design's
  // treatment of it as authoritative (`exhaustionOutlook`: "all at their limit" already counts a
  // live-spent account); the retired driver was the learned-ceiling GUESS (`warn`), which still never
  // triggers — it only ranks a target last.
  const currentLiveWorst = loginLiveWorstPercent(currentAccountId, liveById, siblingIds) ?? 0;
  const currentIsSpent =
    current.state === "exhausted" ||
    currentLiveWorst >= LIVE_AVOID_PERCENT ||
    deadLoginIds.has(currentAccountId);
  if (!currentIsSpent) return null;

  // The FROM account is spent — pick the healthiest signed-in account to move to, excluding the
  // vacated login and its same-login siblings (a sibling shares one quota and hits the wall together)
  // and any account whose OWN login is definitely dead (it can't receive agents either).
  const best = bestHealthyTarget(
    accounts,
    usage,
    ceilings,
    identities,
    now,
    live,
    [currentAccountId],
    deadLoginIds,
  );
  if (!best) return null;

  // Was the ONLY thing making `from` spent a dead login? (No usage wall, no live over-utilization.)
  // Redirects only the SENTENCE — `reason` stays "exhausted" so every gate still fires.
  const expiredOnly =
    deadLoginIds.has(currentAccountId) &&
    current.state !== "exhausted" &&
    currentLiveWorst < LIVE_AVOID_PERCENT;

  return {
    from,
    to: best,
    fraction: current.fraction,
    reason: "exhausted",
    expired: expiredOnly,
  };
}

/** The healthiest signed-in account to move agents TO, or null when none qualifies.
 *
 *  "Healthy" is the candidate-eligibility test {@link switchRecommendation} has always applied, lifted
 *  out so a MID-MIGRATION re-target can reuse the exact same oracle rather than re-deriving a second
 *  rule (`accountSwitch.revalidateSwitchTarget`). An account qualifies when it is:
 *   - signed in;
 *   - not on the OBSERVED wall (`state !== "exhausted"`); and
 *   - below {@link LIVE_AVOID_PERCENT} of its real Anthropic quota, judged PER LOGIN
 *     ({@link loginLiveWorstPercent}) — the SAME exclusion the spawn gate (`partitionAccounts`) and
 *     AC8 (`exhaustionOutlook`) apply, so every consumer of the live signal stays consistent.
 *
 *  Every account whose login group intersects `excludeLoginsOf` is dropped BEFORE ranking: pass the
 *  account being vacated (agents are leaving it) and, for a re-target, the dead target — switching to a
 *  sibling of a walled login gains nothing, it shares that login's one quota and one wall. The
 *  learned-ceiling estimate (`warn`) is deliberately NOT an exclusion — it must not veto a real
 *  escape; it only RANKS a target last. Ties and ranking use {@link headroomRank}: most runway first. */
export function bestHealthyTarget(
  accounts: Account[],
  usage: Usage[],
  ceilings: Ceiling[],
  identities: Identity[],
  now: number,
  live: readonly LiveUsage[],
  excludeLoginsOf: Iterable<string>,
  deadLoginIds: ReadonlySet<string> = NO_DEAD_LOGINS,
): Account | null {
  const liveById = new Map(live.map((l) => [l.id, l]));
  const byId = new Map(assessHeadroom(usage, ceilings, now).map((h) => [h.accountId, h]));
  const signedIn = new Set(signedInAccountIds(identities));
  const siblingIds = loginSiblingIds(accounts, identities);

  // Expand each excluded id to its whole login group, so excluding one registration excludes the
  // quota it shares. An id not in a duplicate group falls back to just itself.
  const excluded = new Set<string>();
  for (const id of excludeLoginsOf) {
    for (const sib of siblingIds.get(id) ?? [id]) excluded.add(sib);
  }

  // THE ROTATION OPT-OUT IS DELIBERATELY *NOT* CONSULTED HERE, and that is a correction of an earlier
  // cut of this branch which excluded opted-out accounts from this oracle.
  //
  // Excluding here BLOCKS, and every other consumer of `outOfRotationIds` DEMOTES — the invariant the
  // routing suite calls the single most important property of the feature: an opt-out must never be
  // able to stop the app spawning. This function has no least-bad fallback, it returns null, and it
  // feeds four consumers including the advisory banner a human accepts by hand and the stranded-helper
  // rescue (neither of which writes the fleet preference at all). So with the fleet walled on A and B
  // the only healthy account but opted out, excluding it produced: no banner, no rescue, the in-flight
  // plan retired — a fleet stranded on a dead account with nothing on screen offering the escape it
  // used to offer. That is a worse failure than the one the exclusion was reaching for.
  //
  // The failure it WAS reaching for — an automatic switch naming an opted-out account, whose
  // preference is then inert while running panes migrate anyway — is closed at the write instead:
  // every write of the fleet preference now routes through `recordActivation`, which puts the target
  // back in rotation. See `useAccountSwitch.recordActivation`. One rule, no inert preferences, and
  // this oracle stays a pure function of its arguments rather than mixing a snapshot up to
  // HEADROOM_POLL_MS old with a live localStorage read.
  // `signedIn` keys on EMAIL (`signedInAccountIds`), and an EXPIRED login still has its email recorded
  // in `.claude.json` — so a dead-login account reads "signed in" here and would be a valid target
  // unless dropped. Moving the fleet onto an account that cannot authenticate just relocates the 401,
  // exactly as moving onto an exhausted account relocates the wall. `deadLoginIds` carries only a
  // live CLI "no", so nothing merely flaky is dropped.
  const candidates = accounts
    .filter((a) => signedIn.has(a.id) && !excluded.has(a.id) && !deadLoginIds.has(a.id))
    .map((a) => ({
      account: a,
      h: byId.get(a.id) ?? {
        accountId: a.id,
        used: 0,
        ceiling: null,
        fraction: null,
        state: "unknown" as const,
      },
    }))
    .filter(
      (c) =>
        c.h.state !== "exhausted" &&
        !((loginLiveWorstPercent(c.account.id, liveById, siblingIds) ?? 0) >= LIVE_AVOID_PERCENT),
    );
  if (candidates.length === 0) return null;
  candidates.sort((x, y) => headroomRank(x.h) - headroomRank(y.h));
  return candidates[0]!.account;
}

/** Whether `accountId` is STILL a valid place to move agents to — the single-account form of the
 *  {@link bestHealthyTarget} eligibility test. It must still exist, be signed in, not be on the
 *  observed wall, and be below {@link LIVE_AVOID_PERCENT} of its real quota (judged per login).
 *
 *  Used to decide whether a running switch's chosen target has gone invalid mid-migration (hit its own
 *  wall, had its login expire, or been removed) and needs re-targeting — separate from "pick the best"
 *  so a still-valid target is NEVER abandoned merely because another account happens to have more
 *  runway, which would churn agents already on their way to a perfectly good account. */
export function isHealthyTarget(
  accountId: string,
  accounts: Account[],
  usage: Usage[],
  ceilings: Ceiling[],
  identities: Identity[],
  now: number,
  live: readonly LiveUsage[],
  deadLoginIds: ReadonlySet<string> = NO_DEAD_LOGINS,
): boolean {
  if (!accounts.some((a) => a.id === accountId)) return false; // removed mid-migration
  // A DEFINITELY-EXPIRED login (live `claude auth status` "no") — the "had its login expire"
  // mid-migration case this docblock names. `signedInAccountIds` keys on the RECORDED email, which an
  // expired session still carries, so without this an account whose OAuth died mid-migration reads
  // healthy and the fleet keeps landing on it. Only a live CLI "no" is in the set, never a flake.
  if (deadLoginIds.has(accountId)) return false;
  if (!new Set(signedInAccountIds(identities)).has(accountId)) return false; // login expired / never
  const h = new Map(assessHeadroom(usage, ceilings, now).map((x) => [x.accountId, x])).get(accountId);
  if (h && h.state === "exhausted") return false; // observed wall
  const liveById = new Map(live.map((l) => [l.id, l]));
  const siblingIds = loginSiblingIds(accounts, identities);
  if ((loginLiveWorstPercent(accountId, liveById, siblingIds) ?? 0) >= LIVE_AVOID_PERCENT) return false;
  return true;
}


/** How to name an account at the START of a sentence. Only the not-signed-in case is capitalized:
 *  the signed-in name is an EMAIL, and "Drodio@storytell.ai" would be a different address.
 *
 *  Exported so the runway no-target fallback (`AccountsScreen`) names its subject by the SAME rule
 *  the recommendation sentence does — a uuid-only login (no readable email) must read "The account
 *  Sparkle is signed into", never the false "Not signed in" that `AccountDisplay.primary` falls to. */
export function leadName(display: AccountDisplay): string {
  if (display.signedIn) return display.primary;
  // `hasLogin`, not `signedIn`. `signedIn` is EMAIL-only, so a login carrying a uuid but no readable
  // email — which is a real sign-in — was announced as "An account that isn't signed in has hit its
  // limit", a false statement about the account the user is actively working on. Same distinction
  // `accountSentenceName` already draws for the object half of the sentence.
  if (display.hasLogin) return "The account Sparkle is signed into";
  return "An account that isn't signed in";
}

/** Human phrasing for the banner. Kept next to the policy so wording and thresholds can't drift.
 *
 *  Takes an {@link AccountDisplay} producer rather than a `(a) => string` labeller ON PURPOSE: this
 *  banner asks the user to move their work between real Anthropic logins, and the old signature let
 *  any caller hand it `a => a.nickname` — a user-typed string with no bearing on which login a
 *  config dir holds. Taking the display makes naming an unverified account by its nickname
 *  unrepresentable rather than merely discouraged. */
export function describeRecommendation(
  rec: SwitchRecommendation,
  display: (a: Account) => AccountDisplay,
): string {
  const from = leadName(display(rec.from));
  const to = accountSentenceName(display(rec.to));
  // A DEFINITELY-EXPIRED login gets its OWN sentence: "has hit its limit" would tell the user to wait
  // out a usage limit that never resets, when the real remedy is to re-authenticate. The switch to a
  // healthy account still keeps the fleet working now, and the renew hint points at the actual fix.
  // (`reason` stays "exhausted", so this is the only place the expired case diverges — see the
  // `expired` field on {@link SwitchRecommendation}.)
  if (rec.expired) {
    return `${from}'s login has expired. Switch to ${to} to keep working, then sign back in.`;
  }
  // Otherwise the observed out-of-room message. The "approaching … is N% of its usual limit …"
  // wording is gone with the estimate-driven `"approaching"` recommendation — a recommendation exists
  // only for an account out of room by an AUTHORITATIVE signal (a wall or live over-utilization).
  // Naming a percentage "of its usual limit" was the exact estimate the founder retired; there is no
  // learned-ceiling figure to quote here any more.
  return `${from} has hit its limit. Switch to ${to} to keep working.`;
}

// ── Rotation readiness ────────────────────────────────────────────────────────────────────────
//
// "How many accounts can actually receive a spawn?" — the question the Accounts screen never
// answered, and the whole of the founder's blocker.
//
// MEASURED on the real machine: `accounts.json` holds two accounts, of which ONE has ever been
// `claude login`ed. The other's `.claude.json` carries no `oauthAccount` at all — registered, never
// signed in, and rendered by the list as though it were a peer. `signedInAccountIds` keeps only
// identities with a non-null email and `pickAccount` narrows auto-pick to those, so the candidate
// pool had exactly ONE member and `pickAccount` returned the same account every single time.
// Rotation was not broken; it was arithmetically impossible. Nothing in the UI said so, so the
// visible evidence ("2 accounts") supported the opposite conclusion.
//
// This computes the count the UI has to state out loud, and it counts LOGINS rather than ROWS.

/** Which registered accounts can actually receive a spawn, and which cannot — every account lands
 *  in exactly one bucket, so a caller can name the excluded ones instead of silently dropping them.
 *
 *  See {@link rotationReadiness} for how each bucket is decided. */
export interface RotationReadiness {
  /** How many DISTINCT Anthropic logins can receive a spawn. This — not `accounts.length` — is the
   *  number that decides whether rotation is possible at all: below 2 there is nowhere to rotate. */
  usableLogins: number;
  /** One representative account per distinct usable login, in input order. */
  usable: Account[];
  /** Signed in, but resolves to the SAME login as an earlier entry in `usable`. Two config dirs
   *  holding one Anthropic account share one quota, so they are one usable account, not two. */
  redundant: Account[];
  /** No Claude login in the config dir at all (never `claude login`ed). The founder's second
   *  account. It cannot receive agents, and the list used to present it as though it could. */
  notSignedIn: Account[];
  /** Has a login (an `accountUuid`) but no readable email. Real, but auto-pick keys on email
   *  (`signedInAccountIds`), so it is not in the rotation pool either — stated rather than folded
   *  into `notSignedIn`, which would be a different and false claim about it. */
  noEmail: Account[];
}

/** Partition registered accounts into "can receive a spawn" and the reasons the rest cannot.
 *
 *  ELIGIBILITY IS DERIVED, NOT RE-DECIDED. Two rules are borrowed wholesale rather than restated:
 *
 *   * {@link signedInAccountIds} decides signed-in-ness (email != null). That is the exact predicate
 *     `pickAccount` filters its candidate pool with, so the count shown to the user cannot describe
 *     a different pool than the one selection actually uses.
 *   * {@link duplicateAccountGroups} decides sameness. The repo has already shipped a bug from a
 *     second, subtly-different sameness rule (see the docblock on {@link switchRecommendation}), so
 *     this one asks the canonical grouping instead of comparing uuids or emails itself. Its
 *     ambiguity guard carries over for free: an email-only row that cannot be paired on positive
 *     evidence stays its own login rather than being silently merged away.
 *
 *  Deduping matters because a group of N registrations shares ONE quota: counting them separately
 *  would report rotation as available when every "target" hits the same wall at the same moment. */
export function rotationReadiness(
  accounts: Account[],
  identities: Identity[],
): RotationReadiness {
  const signedIn = new Set(signedInAccountIds(identities));
  const identityById = new Map(identities.map((i) => [i.id, i]));
  // Canonical sameness — one rule, shared with the duplicate banner and with benching.
  const groupKeyById = new Map<string, string>();
  for (const g of duplicateAccountGroups(accounts, identities)) {
    for (const a of g.accounts) groupKeyById.set(a.id, g.key);
  }

  const usable: Account[] = [];
  const redundant: Account[] = [];
  const notSignedIn: Account[] = [];
  const noEmail: Account[] = [];
  const claimedLogins = new Set<string>();

  for (const a of accounts) {
    if (!signedIn.has(a.id)) {
      // Not in the rotation pool. Which of the two reasons decides the copy, so keep them apart.
      if (identityById.get(a.id)?.accountUuid) noEmail.push(a);
      else notSignedIn.push(a);
      continue;
    }
    const key = groupKeyById.get(a.id);
    // An ungrouped account is its own login: `duplicateAccountGroups` only groups on positive
    // evidence, so "no group" means "nothing proved it shares a login", never "unknown → merge".
    if (key != null) {
      if (claimedLogins.has(key)) {
        redundant.push(a);
        continue;
      }
      claimedLogins.add(key);
    }
    usable.push(a);
  }

  return { usableLogins: usable.length, usable, redundant, notSignedIn, noEmail };
}

// ── AC8: all accounts at the wall ─────────────────────────────────────────────────────────────

/** Whether every usable account is out of room, and when the first one frees up. */
export interface ExhaustionOutlook {
  /** True when EVERY usable account is out of room by a signal AUTO-PICK ACTS ON — either a REAL,
   *  OBSERVED rate limit (`exhaustedUntil` in the future) OR real Anthropic utilization at/above
   *  {@link LIVE_AVOID_PERCENT}. These are exactly the two exclusions `accountStore.partitionAccounts`
   *  applies, so the banner tracks the same fact the spawn gate does: when it says "all at their
   *  limit", auto-pick genuinely has no healthy candidate left.
   *
   *  The LEARNED-CEILING estimate does NOT count — the founder retired it as a driver (it read "90%
   *  of its usual limit" while the real Anthropic figures were clear). "All at their limit" now means
   *  every account either hit a real wall or reads spent on Anthropic's own number.
   *
   *  False when there are no usable accounts at all: "all of nothing is at its limit" is a vacuous
   *  truth that would render a limit warning for a user whose actual problem is having no login. */
  allAtLimit: boolean;
  /** Earliest epoch-MS instant a usable account's rate limit resets, or null when none of them is
   *  actually rate-limited. Never invented: a null here means "we don't know when", and the caller
   *  must not print a time. A pool that is `allAtLimit` purely on live-usage (no observed wall) has
   *  NO reset instant to quote, so this is null there — the caller says so rather than inventing one. */
  earliestReset: number | null;
}

/** Judge the usable pool as a whole (PRD acceptance criterion 8).
 *
 *  `allAtLimit` counts an account out of room on the SAME two signals auto-pick excludes on
 *  (`partitionAccounts`): the OBSERVED wall (`state === "exhausted"`) OR real Anthropic utilization
 *  ≥ {@link LIVE_AVOID_PERCENT}. The learned-ceiling estimate is not one of them. Feeding the same
 *  `live` rows the spawn path uses keeps the banner from disagreeing with the gate — the case where
 *  every account reads 99% real but has no rate-limit event yet, which the OBSERVED-only version
 *  silently missed while `pickAccount` dropped to its least-bad fallback.
 *
 *  An account with NO usage row and no live row is treated as having room (matching `usageLookup`),
 *  so it holds `allAtLimit` false rather than defaulting a silent account into the wall. `ceilings`
 *  is retained for signature stability and `assessHeadroom`'s other states; it does not gate this. */
export function exhaustionOutlook(
  usableAccountIds: readonly string[],
  usage: Usage[],
  ceilings: Ceiling[],
  now: number = Date.now(),
  live: readonly LiveUsage[] = [],
  siblingIds?: ReadonlyMap<string, readonly string[]>,
): ExhaustionOutlook {
  if (usableAccountIds.length === 0) return { allAtLimit: false, earliestReset: null };

  const headroomById = new Map(assessHeadroom(usage, ceilings, now).map((h) => [h.accountId, h]));
  const usageById = new Map(usage.map((u) => [u.id, u]));
  const liveById = new Map(live.map((l) => [l.id, l]));

  // Out of room on either signal auto-pick acts on: the observed wall, or Anthropic's own number at
  // or above LIVE_AVOID_PERCENT — judged PER LOGIN (`siblingIds`), the SAME way the spawn gate and
  // `switchRecommendation` judge it, so this deduped-set banner cannot disagree with them. A missing
  // row on BOTH is "no evidence of a limit", so `every` is false as before.
  const atLimit = (id: string): boolean => {
    if (headroomById.get(id)?.state === "exhausted") return true;
    const p = loginLiveWorstPercent(id, liveById, siblingIds);
    return p != null && p >= LIVE_AVOID_PERCENT;
  };
  const allAtLimit = usableAccountIds.every(atLimit);

  const earliestReset = earliestResetAcross(usableAccountIds, usageById, now);
  return { allAtLimit, earliestReset };
}

/** The soonest future `exhaustedUntil` among the named accounts, or null when none is exhausted.
 *  Past instants are ignored — an expired exhaustion is not a reset the user is waiting on. */
function earliestResetAcross(
  ids: readonly string[],
  usageById: Map<string, Usage>,
  now: number,
): number | null {
  let earliest: number | null = null;
  for (const id of ids) {
    const until = usageById.get(id)?.exhaustedUntil;
    if (until == null || until <= now) continue;
    if (earliest == null || until < earliest) earliest = until;
  }
  return earliest;
}
