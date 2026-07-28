/**
 * Is the CONCIERGE's AI enhancement live, and if not, WHICH of the three fixes does this user need?
 *
 * The settings pane that lists the concierge's ~50 per-tool rules needs one fact and one remedy: the
 * concierge cannot act at all without AI enhancements, so the pane renders read-only under a single
 * banner rather than stamping fifty identical errors across fifty rows. This module is that one
 * fact, kept out of the component so the RULE can be tested without a DOM.
 *
 * THREE REASONS, THREE REMEDIES, and conflating them is the failure mode worth naming:
 *
 *   • `enable-setting` — the concierge's own AI-features switch is off. Free, instant, theirs.
 *   • `buy-app`        — the one-time $99 has not been bought. The existing AiLockedNotice paywall.
 *   • `top-up`         — bought, but the credit balance is spent. The existing Credits/refill flow.
 *
 * The last two are the ones that must never be swapped. `services/aiGate`'s locked read is
 * ENTITLEMENT-based for exactly this reason: an entitled user at $0 is handled by the credit flow,
 * and showing them "Unlock Sparkle — $99" tells somebody who already paid that they have not.
 *
 * PRECEDENCE is flag → entitlement → credits, i.e. the free fix first. A user who deliberately
 * switched the concierge off is told to switch it back on even if they are also un-entitled; the
 * AI-features pane they land on re-states the purchase state, so nothing is hidden, and we never
 * open a checkout for somebody whose actual problem was their own toggle.
 *
 * THE FEATURE KEY SEAM. The concierge's AI-features key (`concierge` → the `aiConcierge` settings
 * field) is owned by `stores/settingsStore`. This module reads it by NAME rather than through the
 * `AiFeatureKey` union so it works either side of that key landing, and it defaults an ABSENT field
 * to on — a build that has no concierge flag has nothing to gate, and locking the pane on a missing
 * field would be a gate the user cannot open. A field that is present but not a boolean reads as
 * OFF: an unreadable flag is not consent to spend somebody's credits.
 */

import { useAuthStore } from "../stores/authStore";
import { AI_FEATURE_FIELD, useSettingsStore, type AiFeatureKey } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { aiEnhancementsEnabled, hasAiCredits } from "./aiGate";
import { setAiFeature } from "./configActions";

/** The AI-features key for the concierge, as `stores/settingsStore` names it. */
export const CONCIERGE_AI_FEATURE_KEY = "concierge";

/** The settings-store field that key maps to. */
export const CONCIERGE_AI_SETTINGS_FIELD = "aiConcierge";

/** What the human has to do to get the concierge acting again. Null while it already is. */
export type ConciergeAiRemedy = "enable-setting" | "buy-app" | "top-up" | null;

export interface ConciergeAiAccess {
  /** True ⇔ the concierge's AI enhancement is live (flag on AND credits — aiGate's usable rule). */
  enabled: boolean;
  remedy: ConciergeAiRemedy;
}

/** The rule, as a pure function of the three facts. See the header for why the order is this order. */
export function conciergeAiAccessOf(input: {
  featureOn: boolean;
  entitled: boolean;
  hasCredits: boolean;
}): ConciergeAiAccess {
  if (input.featureOn && input.hasCredits) return { enabled: true, remedy: null };
  if (!input.featureOn) return { enabled: false, remedy: "enable-setting" };
  // Flag on, no credits. Entitlement — NOT the balance — decides which money flow to offer.
  return { enabled: false, remedy: input.entitled ? "top-up" : "buy-app" };
}

/** Read the concierge AI flag off a settings snapshot. Absent ⇒ on; non-boolean ⇒ off (header). */
export function conciergeAiFlagOf(state: unknown): boolean {
  if (!state || typeof state !== "object") return true;
  const raw = (state as Record<string, unknown>)[CONCIERGE_AI_SETTINGS_FIELD];
  return raw === undefined ? true : raw === true;
}

/** The live gate, for the settings pane. Subscribes to the flag, the balance, and the credit floor,
 *  so the pane un-greys the moment a top-up lands rather than on the next unrelated re-render. */
export function useConciergeAiAccess(): ConciergeAiAccess {
  const featureOn = useSettingsStore(conciergeAiFlagOf);
  const entitled = useAuthStore((s) => aiEnhancementsEnabled(s.me));
  const hasCredits = useAuthStore((s) => hasAiCredits(s.me, s.creditFloorCents));
  return conciergeAiAccessOf({ featureOn, entitled, hasCredits });
}

/** Is the concierge key registered in the settings store's AI-features map yet? */
function conciergeKeyRegistered(): boolean {
  return Object.prototype.hasOwnProperty.call(AI_FEATURE_FIELD, CONCIERGE_AI_FEATURE_KEY);
}

/**
 * The `enable-setting` remedy: turn the concierge's AI-features switch on.
 *
 * Writes through `configActions` (config.toml is the source of truth) when the key is registered.
 * When it is not, `setAiFeature` would resolve no config path at all, so we deep-open the
 * AI-features pane instead — the human still reaches the switch, in one click, and nothing pretends
 * to have written a setting it could not write.
 */
export function turnOnConciergeAi(): void {
  if (conciergeKeyRegistered()) {
    void setAiFeature(CONCIERGE_AI_FEATURE_KEY as AiFeatureKey, true);
    return;
  }
  useUiStore.getState().openSettings("ai");
}
