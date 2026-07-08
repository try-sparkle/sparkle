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
import {
  DEFAULT_WAKE_WORD,
  DEFAULT_STOP_WORD,
  DEFAULT_PAUSE_ON_SUBMIT,
} from "../voice/voiceDefaults";

/** Menu feature key → its dotted config path under [ai]. */
const AI_CONFIG_PATH: Record<AiFeatureKey, string> = {
  autoRename: "ai.auto_rename",
  voiceDictation: "ai.voice_dictation",
  brainstorm: "ai.brainstorm",
  composer: "ai.composer",
  suggestedActions: "ai.suggested_actions",
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

/** Toggle "delete merged branch on close": optimistic store update, then persist to config.toml. */
export async function setDeleteMergedBranch(on: boolean): Promise<void> {
  useSettingsStore.getState().setDeleteMergedBranch(on);
  try {
    await setConfigValue("workflow.delete_merged_branch", on);
  } catch (e) {
    console.warn("config write failed (delete merged branch)", e);
  }
}

/** Set the custom wake word: optimistic store update, then persist to config.toml. A blank/
 *  whitespace word falls back to the default (an empty custom phrase would never wake). */
export async function setWakeWord(word: string): Promise<void> {
  const w = word.trim() || DEFAULT_WAKE_WORD;
  useSettingsStore.getState().setWakeWord(w);
  try {
    await setConfigValue("voice.wake_word", w);
  } catch (e) {
    console.warn("config write failed (wake word)", e);
  }
}

/** Set the custom stop word: optimistic store update, then persist to config.toml. A blank/
 *  whitespace word falls back to the default. */
export async function setStopWord(word: string): Promise<void> {
  const w = word.trim() || DEFAULT_STOP_WORD;
  useSettingsStore.getState().setStopWord(w);
  try {
    await setConfigValue("voice.stop_word", w);
  } catch (e) {
    console.warn("config write failed (stop word)", e);
  }
}

/** Toggle "pause listening on submit": optimistic store update, then persist to config.toml. */
export async function setPauseOnSubmit(on: boolean): Promise<void> {
  useSettingsStore.getState().setPauseOnSubmit(on);
  try {
    await setConfigValue("voice.pause_on_submit", on);
  } catch (e) {
    console.warn("config write failed (pause on submit)", e);
  }
}

/** Reset the three voice settings to their built-in defaults in ONE atomic write. */
export async function resetVoiceSettings(): Promise<void> {
  const s = useSettingsStore.getState();
  s.setWakeWord(DEFAULT_WAKE_WORD);
  s.setStopWord(DEFAULT_STOP_WORD);
  s.setPauseOnSubmit(DEFAULT_PAUSE_ON_SUBMIT);
  try {
    await setConfigValues({
      "voice.wake_word": DEFAULT_WAKE_WORD,
      "voice.stop_word": DEFAULT_STOP_WORD,
      "voice.pause_on_submit": DEFAULT_PAUSE_ON_SUBMIT,
    });
  } catch (e) {
    console.warn("config write failed (voice reset)", e);
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
