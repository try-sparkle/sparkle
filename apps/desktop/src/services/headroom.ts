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

import type { Account, Usage, Identity } from "./accountStore";
import { signedInAccountIds } from "./accountStore";

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
  const candidates = accounts
    .filter((a) => a.id !== currentAccountId && signedIn.has(a.id))
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

/** Human phrasing for the banner. Kept next to the policy so wording and thresholds can't drift. */
export function describeRecommendation(
  rec: SwitchRecommendation,
  label: (a: Account) => string,
): string {
  const pct = rec.fraction != null ? `${Math.round(rec.fraction * 100)}% of` : "at";
  return rec.reason === "exhausted"
    ? `${label(rec.from)} has hit its limit. Switch to ${label(rec.to)} to keep working.`
    : `${label(rec.from)} is ${pct} its usual limit. Switch to ${label(rec.to)} before it runs out.`;
}
