// aiServiceHealthStore — "is the AI proxy SERVICE sustaining failures right now?"
//
// The third-and-a-half failure mode, and the one that was live and invisible on 2026-07-28: the
// server-side proxy answered ~99% of calls with a gateway error (HTTP 502) for 12+ hours because
// Sparkle's own vendor account had a billing problem. Every AI Enhanced feature failed silently; a
// human only found it by reading server logs by hand.
//
// WHY THIS IS A SEPARATE STORE FROM THE TWO THAT ALREADY EXIST.
//   • `aiProviderStore` / `ProviderUnavailableBanner` fire on the DEFINITIVE `ai_unconfigured`
//     sentinel (a 503/404 where the server itself names `provider_unfunded` / `provider_key_rejected`).
//     That is a single authoritative signal, so it lights instantly. But during THIS incident the
//     proxy never emitted it — it returned bare 502s — so that banner stayed dark.
//   • `services/suggestions/vendorOutage.ts` is a circuit breaker that recognises the same 5xx class,
//     but it is SUGGESTIONS-scoped and its job is to THROTTLE doomed retries, not to tell the user
//     anything. Nothing surfaced it.
//
// So this store fills the gap: a lightweight, non-flappy detector for SUSTAINED service failure that
// drives one app-shell banner (AiServiceBanner). It deliberately does NOT count the failure classes
// that already have their own honest UI — a per-user $0 balance (`insufficient_credits` →
// ZeroCreditBanner) or the provider-account sentinel (`ai_unconfigured` → ProviderUnavailableBanner) —
// so a user is never shown a vague "AI unavailable" banner when a more precise one is already up (and
// never mis-told the service is down when in fact their own credits ran out).
//
// Fed from the ONE place every proxied AI call funnels through (services/anthropic.ts), the same
// chokepoint `noteAiProviderHealthy` / `noteCreditsRefused` are written from.
import { create } from "zustand";

/** The coarse, PII-free cause we can infer from the proxy's typed error string. Intentionally small:
 *  a banner only needs to say roughly why, never the raw status body (which can carry request
 *  fragments). `unreachable` = the service/gateway is erroring or the network path is dead (5xx or a
 *  transport failure); `rate_limited` = the vendor is throttling us (429). */
export type AiServiceReason = "unreachable" | "rate_limited";

/**
 * Consecutive SERVICE failures before we call the service degraded and light the banner.
 *
 * Four, not one, on purpose — this is the whole "non-flappy" requirement. A lone 502 is the transient
 * gateway blip the Rust/JS retry path is FOR; flashing a scary full-width banner on it would be worse
 * than the silence. Four rejections in a row, with no success in between, is no longer a blip — it is
 * the shape of the sustained outage this exists to surface. "Consecutive since the last success" is
 * the sustained-ness measure: any single success resets the run to zero, so a service that is mostly
 * working never trips it.
 */
export const AI_SERVICE_DEGRADED_THRESHOLD = 4;

/** The detector's whole state. One record so the run counter and the derived `degraded` flag cannot
 *  drift apart. `dismissed` is per-EPISODE: it hides the banner the user has acknowledged, and a
 *  recovery (any success) clears it so a fresh outage later still gets to speak. */
export interface AiServiceHealth {
  /** Service failures observed since the last success (or last non-service outcome). */
  consecutiveFailures: number;
  /** True once `consecutiveFailures` reached the threshold; cleared only by a success. */
  degraded: boolean;
  /** The coarse cause of the most recent counted failure, for the banner copy. */
  reason: AiServiceReason | null;
  /** The user dismissed the banner for the current degradation episode. */
  dismissed: boolean;
}

/** The healthy zero-state. Exported so tests and the store share one definition of "all clear". */
export const HEALTHY_SERVICE: AiServiceHealth = {
  consecutiveFailures: 0,
  degraded: false,
  reason: null,
  dismissed: false,
};

/**
 * Classify a proxy error STRING (the typed sentinels src-tauri/src/ai.rs returns) into a coarse
 * service reason, or `null` when it is NOT a sustained-service signal we should act on. Pure and
 * total, so it is safe against any string and independently testable.
 *
 * Returns null — i.e. "this does not count toward service degradation" — for:
 *   • `insufficient_credits[:…]` — the USER's $0 balance. Its own precise UI (ZeroCreditBanner) owns
 *     it; counting it here would mislabel a personal billing state as a service outage.
 *   • `ai_unconfigured[:…]`      — the provider-account sentinel ProviderUnavailableBanner already
 *     surfaces instantly and more specifically. Don't double-warn.
 *   • any 4xx other than 429     — per-request and terminal (bad model, over context window); the
 *     service is up, this one call is wrong.
 */
export function classifyServiceFailure(err: string): AiServiceReason | null {
  // Owned by more specific UI — never counts as a service outage here.
  if (err.startsWith("insufficient_credits")) return null;
  if (err === "ai_unconfigured" || err.startsWith("ai_unconfigured:")) return null;

  // The transport-failure sentinel: no HTTP status came back at all (DNS/connect/socket).
  if (err === "ai_unreachable") return "unreachable";

  // The proxy encodes an upstream/vendor status as "... (HTTP nnn)".
  const m = /\(HTTP (\d{3})\)/.exec(err);
  if (m) {
    const code = Number(m[1]);
    if (code === 429) return "rate_limited";
    if (code >= 500 && code < 600) return "unreachable";
  }
  return null;
}

/**
 * Fold one proxy REJECTION into the detector and return the next state.
 *
 * `reason === null` means "not a service failure" (a 4xx, a local error, or a class another banner
 * owns). Like the vendorOutage breaker, that RESETS the consecutive run — a non-service rejection is
 * itself evidence the transport is working — but it does NOT clear an already-degraded banner: only a
 * SUCCESS proves recovery. Returns the SAME reference when nothing changed, so a retry storm of
 * identical outcomes can't churn selector subscribers into a re-render loop. Pure, for testing.
 */
export function reduceFailure(
  state: AiServiceHealth,
  reason: AiServiceReason | null,
): AiServiceHealth {
  if (reason === null) {
    // Reset the run without disturbing an open banner. No-op when already zero.
    return state.consecutiveFailures === 0 ? state : { ...state, consecutiveFailures: 0 };
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  const degraded = state.degraded || consecutiveFailures >= AI_SERVICE_DEGRADED_THRESHOLD;
  return { ...state, consecutiveFailures, degraded, reason };
}

/** A successful proxied call proves the service is usable — clear EVERYTHING, including a prior
 *  dismissal, so a later outage is a fresh episode that gets to speak again. Returns the same
 *  reference when already healthy, to avoid needless notifications. Pure, for testing. */
export function reduceSuccess(state: AiServiceHealth): AiServiceHealth {
  const alreadyHealthy =
    state.consecutiveFailures === 0 && !state.degraded && !state.dismissed && state.reason === null;
  return alreadyHealthy ? state : HEALTHY_SERVICE;
}

interface AiServiceHealthState extends AiServiceHealth {
  /** Record a proxy rejection (the raw typed sentinel string). Classifies + folds it. */
  noteFailure: (err: string) => void;
  /** Record a successful proxied call — clears any degradation and dismissal. */
  noteSuccess: () => void;
  /** The user dismissed the banner for the current episode. Idempotent. */
  dismiss: () => void;
}

export const useAiServiceHealthStore = create<AiServiceHealthState>()((set) => ({
  ...HEALTHY_SERVICE,
  noteFailure: (err) => set((s) => reduceFailure(s, classifyServiceFailure(err))),
  noteSuccess: () => set((s) => reduceSuccess(s)),
  dismiss: () => set((s) => (s.dismissed ? s : { ...s, dismissed: true })),
}));
