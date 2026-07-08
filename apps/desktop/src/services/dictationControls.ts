// Dictation phase controls that need the Tauri runtime (invoke), kept OUT of the stores so those
// stay jsdom-testable. Used by the composer's submit path to implement "Pause listening on submit".
import { invoke } from "@tauri-apps/api/core";
import { useDictationStore } from "../stores/dictationStore";
import { useSettingsStore } from "../stores/settingsStore";

/** Drop ACTIVE dictation back to passive wake-word listening, mirroring the stop-word cleanup in
 *  useDictation: flip the phase, clear the live interim ghost, and close the cloud (Deepgram)
 *  relay so server-side metering stops. No-op unless we're actively dictating. The mic stays armed
 *  (enabled untouched), so the on-device wake-word loop keeps running. */
export function pauseActiveDictation(): void {
  const store = useDictationStore.getState();
  if (store.phase !== "active") return;
  store.setPhase("passive");
  store.setInterim("");
  // Closing the relay socket stops billing; a trailing final may still commit, which is fine.
  void invoke("stop_cloud_stream").catch(() => {});
}

/** Called after a prompt is delivered: if the user chose "Pause listening" (default), pause active
 *  dictation. A no-op when "Keep listening" is selected or dictation isn't active. */
export function maybePauseOnSubmit(): void {
  if (!useSettingsStore.getState().pauseOnSubmit) return;
  pauseActiveDictation();
}
