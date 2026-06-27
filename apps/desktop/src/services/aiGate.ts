// One place that answers "are paid AI enhancements live?" — true ⇔ the user is entitled
// (signed in + $99). In the anonymous trial they are off, so every AI-extra read site ANDs
// its settings flag with this. Keeps the trial's "no AI enhancement features" rule DRY.
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore, AI_FEATURE_FIELD, type AiFeatureKey } from "../stores/settingsStore";
import type { Me } from "./entitlement";

export function aiEnhancementsEnabled(me: Me | null): boolean {
  return me?.entitled === true;
}

export function useAiEnhancementsEnabled(): boolean {
  return useAuthStore((s) => aiEnhancementsEnabled(s.me));
}

/** A feature is effectively on only when its setting is on AND enhancements are unlocked. */
export function useAiFeature(key: AiFeatureKey): boolean {
  const flag = useSettingsStore((s) => s[AI_FEATURE_FIELD[key]]);
  const enabled = useAiEnhancementsEnabled();
  return flag && enabled;
}

/** Imperative read for non-React call sites (effects, event handlers). */
export function aiFeatureNow(key: AiFeatureKey): boolean {
  return (
    useSettingsStore.getState()[AI_FEATURE_FIELD[key]] &&
    aiEnhancementsEnabled(useAuthStore.getState().me)
  );
}
