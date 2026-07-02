// One place that answers "are AI enhancement features live?" — true ⇔ the signed-in user has
// CREDITS (balanceCents > 0). Every per-feature read ANDs its settings flag with this, so an AI
// feature is on only when its toggle is on AND the user has credits, and it turns off ONLY when the
// user runs out of credits or turns that feature off in preferences — nothing else gates it.
//
// `entitled` (the one-time $99) still governs two OTHER things and is deliberately NOT part of the
// per-feature gate: the app paywall (deriveAuthView) and the anonymous-trial worker-send cap
// (trialMeter, via aiEnhancementsEnabled). Once a user is past the paywall, credits — not a
// one-time entitlement — decide whether the AI extras run. The anonymous trial has no `me`, so it
// has no credits either, which keeps the "trial = no AI enhancements" rule intact.
//
// VISIBLE vs USABLE vs LOCKED (the trial "see it but buy the app to use it" split):
//   - visible (useAiFeatureVisible / aiFeatureVisibleNow) = the settings flag ONLY. Decides whether
//     a user-initiated AI SURFACE renders (the Think chevron, the composer overlay, the mic button),
//     so a trial user can SEE the AI features exist.
//   - usable (useAiFeature / aiFeatureNow) = flag && credits. The real gate that decides whether an
//     AI extra actually runs (spends credits). Unchanged — the credit machinery + OutOfCreditsError
//     still govern a signed-in, entitled user who has run their balance to zero.
//   - locked (useAiFeatureLocked / aiFeatureLockedNow) = flag && NOT entitled (the $99 not yet
//     bought). True exactly when the surface is visible but the action must be blocked with a
//     buy-the-app upsell (AiLockedNotice → openPaywall, the $99 checkout). This is ENTITLEMENT-based,
//     NOT credit-based, on purpose: the notice sells the $99 app, so it must never fire for a user
//     who already bought it — an entitled user with a zero credit balance is handled by the existing
//     credit flow (top-up / OutOfCreditsError), never by this "buy the app" gate. For the anonymous
//     trial (me == null) entitlement and credits both read false, so the two are equivalent there —
//     the split only matters for the entitled-but-out-of-credits case, which locked must NOT catch.
// Currently only the Think (brainstorm) surface uses the visible/locked split — it is a
// purchase-only AI backend with no free fallback. The composer and voice dictation deliberately
// stay on their existing gates: the composer is the metered free-trial send path (locking it would
// break the 100 free prompts), and dictation has a free on-device path, so neither is a clean
// "buy the app to use it" surface. Background features (autoRename, suggestedActions) keep the
// usable gate too, since they have no "user tried to use it" moment.
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore, AI_FEATURE_FIELD, type AiFeatureKey } from "../stores/settingsStore";
import type { Me } from "./entitlement";

/** Paid-entitlement check (the one-time $99). Still used by the paywall (deriveAuthView) and the
 *  anonymous-trial send meter (trialMeter). NOT the per-feature AI gate — that is credit-based
 *  (see hasAiCredits), so AI features track the user's live credit balance, not a one-time unlock. */
export function aiEnhancementsEnabled(me: Me | null): boolean {
  return me?.entitled === true;
}

/** Are AI enhancement features unlocked? True ⇔ the user is signed in and has a positive credit
 *  balance. This — not entitlement — is what gates every AI extra, so features go dark exactly when
 *  the user runs out of credits (and are off during the anonymous trial, where there is no `me`). */
export function hasAiCredits(me: Me | null): boolean {
  return me != null && me.balanceCents > 0;
}

export function useHasAiCredits(): boolean {
  return useAuthStore((s) => hasAiCredits(s.me));
}

/** A feature is effectively on only when its setting is on AND the user has credits. */
export function useAiFeature(key: AiFeatureKey): boolean {
  const flag = useSettingsStore((s) => s[AI_FEATURE_FIELD[key]]);
  const credits = useHasAiCredits();
  return flag && credits;
}

/** Imperative read for non-React call sites (effects, event handlers). */
export function aiFeatureNow(key: AiFeatureKey): boolean {
  return (
    useSettingsStore.getState()[AI_FEATURE_FIELD[key]] &&
    hasAiCredits(useAuthStore.getState().me)
  );
}

/** VISIBLE: the settings flag ONLY (ignores credits). Decides whether a user-initiated AI surface
 *  renders — so a trial/no-credits user can SEE the AI feature. Use this for UI presence; pair it
 *  with the usable gate / `useAiFeatureLocked` at the action site. */
export function useAiFeatureVisible(key: AiFeatureKey): boolean {
  return useSettingsStore((s) => s[AI_FEATURE_FIELD[key]]);
}

/** Imperative VISIBLE read for non-React call sites. */
export function aiFeatureVisibleNow(key: AiFeatureKey): boolean {
  return useSettingsStore.getState()[AI_FEATURE_FIELD[key]];
}

/** LOCKED: the feature's flag is on but the app is NOT yet bought (not entitled) — the surface is
 *  visible but a user-initiated action must be blocked with the buy-the-app ($99) upsell. Deliberately
 *  entitlement-based, not credit-based (see the header): an entitled user who is out of credits is
 *  NOT locked — their zero balance is handled by the existing credit flow, not this paywall upsell. */
export function useAiFeatureLocked(key: AiFeatureKey): boolean {
  const flag = useSettingsStore((s) => s[AI_FEATURE_FIELD[key]]);
  const entitled = useAuthStore((s) => aiEnhancementsEnabled(s.me));
  return flag && !entitled;
}

/** Imperative LOCKED read for non-React call sites (submit handlers, dictation activation). */
export function aiFeatureLockedNow(key: AiFeatureKey): boolean {
  return (
    useSettingsStore.getState()[AI_FEATURE_FIELD[key]] &&
    !aiEnhancementsEnabled(useAuthStore.getState().me)
  );
}
