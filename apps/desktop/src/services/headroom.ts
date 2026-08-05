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
import { accountSentenceName, signedInAccountIds, identitiesDiffer } from "./accountStore";

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
 *  Sameness is the negation of {@link identitiesDiffer} — the uuid when both sides have one, else
 *  the email — so it matches `identityKey`, the display, and the Rust ledger rather than inventing
 *  a fourth rule. Note `identitiesDiffer` returns false when it CANNOT tell, so "not different" is
 *  not "same": a candidate is only excluded when the two identities are **decidably** the same —
 *  both carrying a uuid, or both carrying an email. Individually non-empty is NOT enough, since
 *  `identitiesDiffer` compares like with like and a uuid-only identity against an email-only one
 *  falls through both of its branches. That keeps an undecidable pair eligible instead of silently
 *  emptying the candidate list.
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
  // Same-login exclusion — see the docblock. `identitiesDiffer` answers false when it cannot tell,
  // so this asks the question in the direction that only excludes on POSITIVE evidence of sameness:
  // the two identities must be COMPARABLE (both uuids, or both emails) and then agree. An
  // undecidable pair stays a candidate.
  const identityById = new Map(identities.map((i) => [i.id, i]));
  const fromId = identityById.get(currentAccountId);
  const isSameLoginAsFrom = (id: string): boolean => {
    const cand = identityById.get(id);
    if (!fromId || !cand) return false;
    // COMPARABLE, not merely resolvable. `identitiesDiffer` only decides when both sides carry the
    // SAME field — uuids first, else emails — so two identities can each be individually non-empty
    // and still be mutually undecidable: `from` with a uuid but no email, against a candidate with
    // an email but no uuid (a login predating the field). A per-side "is this non-empty" check
    // passes both, `identitiesDiffer` then takes neither branch and returns false, and `!false`
    // excludes the candidate on ZERO evidence. If every candidate predates the uuid field the
    // switcher goes silent for an exhausted account — precisely the outcome the guard exists to
    // prevent, reintroduced one level in.
    const comparable =
      (fromId.accountUuid != null && cand.accountUuid != null) ||
      (fromId.email != null && cand.email != null);
    if (!comparable) return false;
    return !identitiesDiffer(
      { accountUuid: fromId.accountUuid, email: fromId.email },
      { accountUuid: cand.accountUuid, email: cand.email },
    );
  };
  const candidates = accounts
    .filter(
      (a) => a.id !== currentAccountId && signedIn.has(a.id) && !isSameLoginAsFrom(a.id),
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
