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

import type { Account, Usage, Identity, AccountDisplay } from "./accountStore";
import {
  accountSentenceName,
  signedInAccountIds,
  duplicateAccountGroups,
  CEILING_AVOID_FRACTION,
} from "./accountStore";

/** Fraction of the learned ceiling at which we start recommending a switch. Chosen against the
 *  observed spread (CoV 0.24): at 0.8 a typical account still has real runway left, so the switch
 *  can wait for a natural boundary instead of interrupting work. */
export const WARN_FRACTION = 0.8;

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
  /** Why we're recommending: it hit a real limit, or it's approaching its learned ceiling. */
  reason: "exhausted" | "approaching";
  /** True when `from`'s config dir is known to have hosted a DIFFERENT Anthropic login inside the
   *  ceiling learn window — so the percentage above was partly measured against someone else and
   *  has to be presented with a caveat. Optional so a hand-built recommendation (tests, an older
   *  caller) simply carries no caveat rather than failing to typecheck. */
}

/** Rank candidate targets: least-loaded first. Accounts with a known fraction sort by it; those
 *  without a ceiling fall back to raw 5h tokens, which is still a valid relative comparison. */
function headroomRank(h: Headroom): number {
  if (h.fraction != null) return h.fraction;
  // Unknown ceiling — push behind any account we can actually quantify, but keep relative order by
  // raw usage so the least-used unknown still wins over a busier one.
  return 1 + h.used / (h.used + 1);
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
): SwitchRecommendation | null {
  if (!currentAccountId) return null;
  const from = accounts.find((a) => a.id === currentAccountId);
  if (!from) return null;

  const byId = new Map(assessHeadroom(usage, ceilings, now).map((h) => [h.accountId, h]));
  const current = byId.get(currentAccountId);
  if (!current || (current.state !== "warn" && current.state !== "exhausted")) return null;

  const signedIn = new Set(signedInAccountIds(identities));
  // Same-login exclusion, from the CANONICAL grouping — see the docblock for why this is derived
  // rather than re-decided here. A group only exists on positive evidence of a shared login, so an
  // account the grouping declines to pair stays a candidate.
  const sameLoginAsFrom = new Set(
    (
      duplicateAccountGroups(accounts, identities).find((g) =>
        g.accounts.some((a) => a.id === currentAccountId),
      )?.accounts ?? []
    )
      .map((a) => a.id)
      .filter((id) => id !== currentAccountId),
  );
  const candidates = accounts
    .filter(
      (a) => a.id !== currentAccountId && signedIn.has(a.id) && !sameLoginAsFrom.has(a.id),
    )
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
    .filter((c) => c.h.state !== "exhausted" && c.h.state !== "warn");

  if (candidates.length === 0) return null;
  candidates.sort((x, y) => headroomRank(x.h) - headroomRank(y.h));
  const best = candidates[0]!;

  return {
    from,
    to: best.account,
    fraction: current.fraction,
    reason: current.state === "exhausted" ? "exhausted" : "approaching",
  };
}


/** How to name an account at the START of a sentence. Only the not-signed-in case is capitalized:
 *  the signed-in name is an EMAIL, and "Drodio@storytell.ai" would be a different address. */
function leadName(display: AccountDisplay): string {
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
  const pct = rec.fraction != null ? `${Math.round(rec.fraction * 100)}% of` : "at";
  const base =
    rec.reason === "exhausted"
      ? `${from} has hit its limit. Switch to ${to} to keep working.`
      : `${from} is ${pct} its usual limit. Switch to ${to} before it runs out.`;
  // NO identity caveat here (knightwatch probe 4). It would only ever fire when `fraction != null`,
  // i.e. when a ceiling EXISTS — and `ceiling_for_account` cuts every pre-takeover and
  // boundary-crossing episode before it returns a non-null one. A surviving number therefore
  // contains only the current login's samples, so telling the user "part of the history behind it
  // isn't its own" was false exactly where it appeared. The reset already expresses the doubt, by
  // yielding `null` while the evidence is insufficient.
  return base;
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
  /** True when EVERY usable account is exhausted or at/above the ACT line
   *  ({@link CEILING_AVOID_FRACTION}) — i.e. auto-pick has no healthy candidate left and is down to
   *  its least-bad fallback.
   *
   *  False when there are no usable accounts at all: "all of nothing is at its limit" is a vacuous
   *  truth that would render a limit warning for a user whose actual problem is having no login. */
  allAtLimit: boolean;
  /** Earliest epoch-MS instant a usable account's rate limit resets, or null when none of them is
   *  actually rate-limited (they can all be over the ACT line on an ESTIMATE, with no observed
   *  reset time to quote). Never invented: a null here means "we don't know when", and the caller
   *  must not print a time. */
  earliestReset: number | null;
}

/** Judge the usable pool as a whole (PRD acceptance criterion 8).
 *
 *  The ACT line is {@link CEILING_AVOID_FRACTION} (0.9), NOT {@link WARN_FRACTION} (0.8). They are
 *  deliberately different numbers: 0.8 is where the human is told an account is getting close, 0.9
 *  is where Sparkle itself stops sending that account new work. This function answers "has auto-pick
 *  run out of healthy accounts", which is the 0.9 question, so it imports the constant rather than
 *  restating it.
 *
 *  An account with NO usage row is treated as having no usage (the most headroom) — matching
 *  `usageLookup` on the selection side — so it holds `allAtLimit` false rather than defaulting a
 *  silent account into the wall. An `unknown` account (no learned ceiling) is likewise NOT at the
 *  limit: an unmeasured account is not evidence of exhaustion, and treating it as such would print
 *  "all accounts are at their limit" about a pool we have never measured. */
export function exhaustionOutlook(
  usableAccountIds: readonly string[],
  usage: Usage[],
  ceilings: Ceiling[],
  now: number = Date.now(),
): ExhaustionOutlook {
  if (usableAccountIds.length === 0) return { allAtLimit: false, earliestReset: null };

  const headroomById = new Map(assessHeadroom(usage, ceilings, now).map((h) => [h.accountId, h]));
  const usageById = new Map(usage.map((u) => [u.id, u]));

  const allAtLimit = usableAccountIds.every((id) => {
    const h = headroomById.get(id);
    if (!h) return false; // no usage row at all → no evidence of a limit
    if (h.state === "exhausted") return true;
    return h.fraction != null && h.fraction >= CEILING_AVOID_FRACTION;
  });

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
