// aiProviderStore — "is SPARKLE'S OWN AI provider account usable right now?"
//
// Deliberately NOT the same question as `hasAiCredits` (does the USER have Sparkle credits) or
// `isOnline` (can this machine reach anything). This is the third failure mode, and until now it was
// the invisible one: the provider account behind the server-side proxy can be out of credit or have
// its key rejected, which takes every AI Enhanced feature down for everyone at once while the user's
// own balance and network are perfectly fine.
//
// What that looked like when it happened (2026-07-28 16:48 UTC onward): the provider balance hit
// zero, the proxy answered every call with a generic gateway error, and each settled agent state
// spent its full retry budget on calls that could not succeed — 7,164 failures in ~12 hours, 99.3%
// of all proxy traffic. Suggestions were dead the entire time. Nothing on any surface said so; the
// cause was found by reading server logs by hand. That is the specific silence this store exists to
// end — it holds the observation so ProviderUnavailableBanner can NAME the cause.
//
// Written from the ONE place every proxied AI call already funnels through (services/anthropic.ts),
// mirroring how `authStore.noteCreditsRefused` records the server's credit refusal at that same
// chokepoint. Recording it at the chokepoint rather than per-feature is what makes the banner
// truthful for whichever feature happens to call first.
import { create } from "zustand";

/** Why Sparkle's provider account is unusable. Mirrors the proxy's `ai_unconfigured` reasons; any
 *  value the desktop doesn't recognise is dropped upstream (see src-tauri/src/ai.rs), so this union
 *  is closed on purpose — an unknown reason degrades to "no outage recorded" rather than rendering a
 *  banner we can't write honest copy for. */
export type AiProviderOutageReason = "provider_unfunded" | "provider_key_rejected";

/** A recorded outage: why, and when we last saw it. `at` is epoch ms, injected by the caller (never
 *  read from the clock here) so the store stays pure and testable. */
export interface AiProviderOutage {
  reason: AiProviderOutageReason;
  at: number;
}

/**
 * How long a recorded outage is trusted without fresh evidence.
 *
 * A SECOND line of defence, not the primary one: the primary guarantee is that every proxied AI
 * wrapper calls `noteAiProviderHealthy()` on success, so recovery clears the banner immediately.
 * But that correctness is spread across call sites, and a future command that forgets would strand a
 * banner the user cannot dismiss, asserting the provider is broken when it is fine (roborev 54761).
 * Expiring the observation bounds that failure to one window instead of the whole session.
 *
 * Ten minutes: long enough that a genuine outage stays on screen across the quiet stretches between
 * AI calls (the retry budget is spent in seconds, then nothing calls for a while), short enough that
 * a stale claim doesn't outlive its usefulness. On a real outage the next failing call re-stamps it.
 */
export const OUTAGE_MAX_AGE_MS = 10 * 60 * 1000;

/** Is this outage still recent enough to assert? Pure — `now` is injected — so the expiry rule is
 *  testable without faking timers, and so the banner and any other reader can't drift apart.
 *  A type predicate, so a caller that guards on it also gets the non-null narrowing for free. */
export function isOutageActive(
  outage: AiProviderOutage | null,
  now: number,
): outage is AiProviderOutage {
  return outage !== null && now - outage.at < OUTAGE_MAX_AGE_MS;
}

interface AiProviderState {
  /** The current outage, or null when the provider is believed healthy. */
  outage: AiProviderOutage | null;
  /** Record a proxy `ai_unconfigured:<reason>` answer. Idempotent for the same reason apart from
   *  refreshing `at`, so a retry storm can't churn subscribers into a re-render loop. */
  noteOutage: (reason: AiProviderOutageReason, at: number) => void;
  /** Any successful proxied AI call proves the provider is usable again — clear the outage so the
   *  banner disappears on its own without needing a restart or a manual dismissal. */
  noteHealthy: () => void;
}

export const useAiProviderStore = create<AiProviderState>()((set) => ({
  // Optimistic until something actually fails, so a healthy launch never flashes the banner.
  outage: null,

  noteOutage: (reason, at) =>
    set((s) => {
      // Same reason already recorded → usually keep the existing object identity. zustand notifies
      // on every set() regardless of shallow equality, and this is written from a path that can fire
      // once per failed call; returning the same reference keeps selector subscribers from
      // re-rendering on a loop.
      //
      // But the record now EXPIRES (see isOutageActive), so a still-live outage has to be re-stamped
      // or it would silently age out mid-outage and drop the banner while AI is still dead. Refresh
      // at half the max age: often enough that a continuing outage never expires, rare enough that
      // the churn this branch exists to prevent stays capped at one write per refresh window.
      if (s.outage?.reason === reason && at - s.outage.at < OUTAGE_MAX_AGE_MS / 2) return s;
      return { outage: { reason, at } };
    }),

  noteHealthy: () => set((s) => (s.outage === null ? s : { outage: null })),
}));
