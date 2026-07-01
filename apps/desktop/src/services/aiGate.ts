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
