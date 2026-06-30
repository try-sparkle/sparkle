// Write-back actions for the config-mirrored settings (concurrency + AI flags). The TOML file is
// the source of truth, so a UI change persists to the file via set_config_value; the resulting
// config-changed event re-hydrates the store (App.tsx). We ALSO update the store optimistically so
// the control responds instantly without waiting for the file round-trip.
//
// These live outside settingsStore so the store stays free of the Tauri runtime (it must stay
// testable under jsdom). Failures are non-fatal: the optimistic update already happened and the
// next hydrate reconciles with the file.
import { setConfigValue, setConfigValues } from "./config";
import { useSettingsStore, type AiFeatureKey } from "../stores/settingsStore";

/** Menu feature key → its dotted config path under [ai]. */
const AI_CONFIG_PATH: Record<AiFeatureKey, string> = {
  autoRename: "ai.auto_rename",
  voiceDictation: "ai.voice_dictation",
  brainstorm: "ai.brainstorm",
  composer: "ai.composer",
};

/** Toggle one AI feature: optimistic store update, then persist to config.toml. */
export async function setAiFeature(key: AiFeatureKey, on: boolean): Promise<void> {
  useSettingsStore.getState().setAiFeature(key, on);
  try {
    await setConfigValue(AI_CONFIG_PATH[key], on);
  } catch (e) {
    console.warn("config write failed (ai feature)", e);
  }
}

/** Bulk-set every AI feature in ONE atomic write. A single set_config_values call fires one
 *  config-changed at a consistent end state — separate per-key writes would each re-hydrate the
 *  store from a partially-written file and briefly revert the not-yet-written features. */
export async function setAllAiFeatures(on: boolean): Promise<void> {
  useSettingsStore.getState().setAllAiFeatures(on);
  try {
    // Derive the {dotted path: value} map from AI_CONFIG_PATH so the keys can't drift from the
    // single source of the menu-key → config-path mapping.
    const values = Object.fromEntries(Object.values(AI_CONFIG_PATH).map((path) => [path, on]));
    await setConfigValues(values);
  } catch (e) {
    console.warn("config write failed (ai bulk)", e);
  }
}

/** Set the worker concurrency cap: optimistic store update, then persist to config.toml. */
export async function setMaxConcurrentWorkers(n: number): Promise<void> {
  const v = Math.max(1, Math.floor(n));
  useSettingsStore.getState().setMaxConcurrentWorkers(v);
  try {
    await setConfigValue("workers.max_concurrent", v);
  } catch (e) {
    console.warn("config write failed (max workers)", e);
  }
}
