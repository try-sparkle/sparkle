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
// drives one app-shell banner (AiServiceBanner).
//
// HOW IT IS FED. There is NO single JS chokepoint for proxied AI calls (roborev 54761): chatOnce,
// generate_agent_name, route_classify and judge_turn_followup are four separate Tauri commands with
// four separate JS wrappers. So — exactly like the sibling `noteAiProviderHealthy/Failure` pair —
// EVERY wrapper calls `noteAiServiceHealthy()` on success and `noteAiServiceFailure(err)` on failure
// (see services/anthropic.ts and the three other wrappers). Recording at each wrapper is what makes
// the banner truthful for whichever feature happens to fail (or recover) first.
//
// WHAT IT DELIBERATELY DOES NOT COUNT, so a user is never double-warned or mislabelled:
//   • `insufficient_credits*` (the USER's $0 balance → ZeroCreditBanner) and `ai_unconfigured*` (the
//     provider-account sentinel → ProviderUnavailableBanner) YIELD: a more specific banner owns the
//     condition, so this one steps aside (clears) rather than stacking a vaguer message on top.
//   • `ai_unreachable` is the LOCAL transport sentinel (no network path); OfflineBanner owns it, and
//     chatOnce flips the connection store offline on it. Counting it would blame Sparkle's service
//     for the user's dead link, so it is IGNORED (never advances toward degraded).
import { create } from "zustand";

/** The coarse, PII-free cause we can infer from the proxy's typed error string. Intentionally small:
 *  a banner only needs to say roughly why, never the raw status body (which can carry request
 *  fragments). `unreachable` = the service/gateway is erroring (5xx); `rate_limited` = 429. */
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
  /** True once `consecutiveFailures` reached the threshold; cleared only by a success/yield. */
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
 * What a proxy rejection means for THIS detector. Three-way on purpose:
 *   • `degrade` — a genuine service failure (5xx / 429); count it toward the threshold.
 *   • `yield`   — a class a MORE SPECIFIC banner owns (insufficient_credits, ai_unconfigured). Our
 *                 banner steps aside so the two never stack.
 *   • `ignore`  — not a service signal (a per-request 4xx, or the local-offline transport sentinel).
 *                 Reset the run so it can't accumulate toward degraded, but leave an open banner be.
 */
export type ServiceFailureOutcome =
  | { kind: "degrade"; reason: AiServiceReason }
  | { kind: "yield" }
  | { kind: "ignore" };

/**
 * Classify a proxy error STRING (the typed sentinels src-tauri/src/ai.rs returns) into an outcome.
 * Pure and total, so it is safe against any string and independently testable.
 */
export function classifyServiceFailure(err: string): ServiceFailureOutcome {
  // Owned by a more specific AI banner → step aside (clear ours), never stack a vaguer message on top.
  if (err.startsWith("insufficient_credits")) return { kind: "yield" };
  if (err === "ai_unconfigured" || err.startsWith("ai_unconfigured:")) return { kind: "yield" };

  // The LOCAL transport-failure sentinel: no HTTP status came back (DNS/connect/socket). OfflineBanner
  // owns this; counting it would blame Sparkle's service for the user's dead network. Never advances.
  if (err === "ai_unreachable") return { kind: "ignore" };

  // The proxy encodes an upstream/vendor status as "... (HTTP nnn)".
  const m = /\(HTTP (\d{3})\)/.exec(err);
  if (m) {
    const code = Number(m[1]);
    if (code === 429) return { kind: "degrade", reason: "rate_limited" };
    if (code >= 500 && code < 600) return { kind: "degrade", reason: "unreachable" };
  }
  // Any other 4xx is per-request and terminal (bad model, over context window): the service is up,
  // this one call is wrong. Reset the run, don't degrade.
  return { kind: "ignore" };
}

/**
 * Fold one classified proxy REJECTION into the detector and return the next state.
 *
 * Returns the SAME reference when nothing changed, so a retry storm of identical outcomes can't churn
 * selector subscribers into a re-render loop. Pure, for testing.
 */
export function reduceFailure(
  state: AiServiceHealth,
  outcome: ServiceFailureOutcome,
): AiServiceHealth {
  switch (outcome.kind) {
    case "yield":
      // A more specific banner is taking over — clearing ours is, from our POV, a recovery.
      return reduceSuccess(state);
    case "ignore":
      // Not a service signal. Reset the run without disturbing an open banner (only a success/yield
      // clears that). No-op when the run is already zero.
      return state.consecutiveFailures === 0 ? state : { ...state, consecutiveFailures: 0 };
    case "degrade": {
      const consecutiveFailures = state.consecutiveFailures + 1;
      const degraded = state.degraded || consecutiveFailures >= AI_SERVICE_DEGRADED_THRESHOLD;
      return { ...state, consecutiveFailures, degraded, reason: outcome.reason };
    }
  }
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
