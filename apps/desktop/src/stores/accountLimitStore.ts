// accountLimitStore — "an account just hit its limit and the user needs to know NOW".
//
// Distinct from every neighbouring signal, and the distinction is the whole point:
//   * `aiProviderStore` answers "can SPARKLE'S OWN AI features run" — the composer, auto-rename.
//     It is a passive banner because nothing the user is watching stopped.
//   * `useAccountSwitch` raises a RECOMMENDATION, and only when a healthier account already exists
//     to switch to (services/headroom.ts). With one account registered — or five sharing a config
//     dir, which is what the founder actually had — there is no candidate, so it stays silent.
//   * This store is the case neither covers: a BUILD AGENT is blocked, no retry can clear it, and
//     there may be nowhere to switch TO because the other accounts were never registered.
//
// The founder's own words: "The first one to hit a session limit pops up a modal front and center
// because when that happens I'm dead in the water." That is a deliberate interruption, so the bar
// for raising one is a REAL limit — a structured `error: "rate_limit"` record found in that
// account's own transcripts (services/limitSync.ts), never scraped screen text.
//
// Scope of the interruption, per the founder: it interrupts HIM, not the fleet. Agents on other
// accounts keep running; the exhausted account's own agents are benched by `markExhausted` so
// `pickAccount` routes around them. Nothing is killed mid-turn.
import { create } from "zustand";

/** The limit currently being reported. `until` is the REAL reset instant (epoch ms) resolved from
 *  the limit event's timezone-correct reset text, not a fixed backoff — see rateLimitWatch.ts. */
export interface AccountLimit {
  accountId: string;
  until: number;
}

/** Identity of a limit for dismissal purposes: the account AND the instant it resets.
 *
 *  Keying on the account alone would be wrong in the direction that costs the user the feature: a
 *  later limit on the same account (a fresh window, or an extended bench after partial recovery) is
 *  a genuinely new event and must be able to re-raise. Keying on both means "I dismissed THIS
 *  limit", which is what a dismissal actually means. */
export function limitKey(limit: AccountLimit): string {
  return `${limit.accountId}:${limit.until}`;
}

interface AccountLimitState {
  /** The limit to show, or null when there is nothing to report. */
  current: AccountLimit | null;
  /** Limits the user has already dismissed, by {@link limitKey}. Session-lifetime: a limit resets
   *  within hours, so there is nothing worth persisting across a restart. */
  dismissed: Set<string>;
  /** Report a limit. Ignored when the user already dismissed this exact limit, and — deliberately —
   *  when one is already on screen: the founder asked for the FIRST agent to hit a limit to raise
   *  the modal, not for a queue of them. The others are benched either way. */
  raise: (limit: AccountLimit) => void;
  /** Dismiss the current limit so it cannot re-raise. */
  dismiss: () => void;
  /** Auto-switch has started migrating this account's agents onto a healthy one, so the manual
   *  interruption is now moot — clear it (and record it dismissed so it cannot re-raise for this same
   *  episode). Distinct from {@link dismiss} in INTENT — the machine resolved it, not the user — but
   *  it shares the effect. Only a modal that is actually ABOUT `accountId` is cleared; a limit on a
   *  different account is a different problem auto-switch did not touch, so it stands. */
  resolveByAutoSwitch: (accountId: string) => void;
}

export const useAccountLimitStore = create<AccountLimitState>((set, get) => ({
  current: null,
  dismissed: new Set(),
  raise: (limit) => {
    const { current, dismissed } = get();
    if (current != null || dismissed.has(limitKey(limit))) return;
    set({ current: limit });
  },
  dismiss: () => {
    const { current, dismissed } = get();
    if (current == null) return;
    const next = new Set(dismissed);
    next.add(limitKey(current));
    set({ current: null, dismissed: next });
  },
  resolveByAutoSwitch: (accountId) => {
    const { current, dismissed } = get();
    if (current == null || current.accountId !== accountId) return;
    const next = new Set(dismissed);
    next.add(limitKey(current));
    set({ current: null, dismissed: next });
  },
}));

/** Raise the modal for a fresh batch of exhaustions ONLY when auto-switch cannot rescue the fleet.
 *
 *  The manual modal and `useAccountSwitch` are two answers to ONE event, and this store's own header
 *  says the modal is the FALLBACK — "the case neither covers … there may be nowhere to switch TO".
 *  Nothing enforced that: `useLimitSync` raised it unconditionally the instant `syncLimitsOnce`
 *  benched an account, so with auto-switch ON and a healthy target available, the founder still got
 *  the "log in to another account" interruption while the automation was already migrating the fleet
 *  onto that target — the exact complaint this addresses.
 *
 *  `autoSwitchWillHandle` is the caller's answer to "does a healthy, signed-in, different-identity
 *  account exist to move to" (in `useLimitSync`, `switchRecommendation(...) != null` — the SAME
 *  oracle auto-switch acts on). When true, surfacing the modal asks the founder to do by hand what
 *  the automation is doing for him, so stay silent. When false — genuinely nowhere to go — the modal
 *  is the only signal left and must show, so this falls through to {@link raiseFirstLimit}. */
export function raiseFirstLimitUnlessAutoSwitchHandles(
  applied: readonly AccountLimit[],
  autoSwitchWillHandle: boolean,
): void {
  if (autoSwitchWillHandle) return;
  raiseFirstLimit(applied);
}

/** Raise the FIRST of a batch of freshly-applied exhaustions.
 *
 *  `syncLimitsOnce` fans one limit across every registration of the same login (they share a quota),
 *  so a batch is usually several rows describing ONE event. Taking the earliest-resetting one names
 *  the account whose bench the user will feel first. Exported for the caller in useLimitSync and to
 *  keep the choice testable without a React tree. */
export function raiseFirstLimit(applied: readonly AccountLimit[]): void {
  if (applied.length === 0) return;
  const first = applied.reduce((a, b) => (b.until < a.until ? b : a));
  useAccountLimitStore.getState().raise(first);
}
