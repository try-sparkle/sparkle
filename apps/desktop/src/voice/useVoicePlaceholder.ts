// The ONE store-reading step behind a composer's voice placeholder.
//
// Why a hook rather than props: deriveMicPresentation exists so that all mic surfaces render the
// SAME state for one store snapshot (see voice/micPresentation.ts). Threading the derived state
// down through a component's own prop contract would create a second path to it — and a second
// path is exactly how the "sidebar says Actively listening, composer says Mic paused" desync comes
// back. Every surface reads it here, from the store, or not at all.
//
// It reads only; it decides nothing. The precedence lives in deriveMicPresentation and the words
// live in dictationCopy, so this hook is purely "gather the inputs".
import { useMemo } from "react";
import { useDictationStore } from "../stores/dictationStore";
import { useSettingsStore } from "../stores/settingsStore";
import { voiceErrorNotice, type VoiceErrorNotice } from "./dictationCopy";
import { deriveMicPresentation, type MicPresentation } from "./micPresentation";

export interface VoicePlaceholderState {
  /** THE voice state, shared with the sidebar caption. Surfaces switch on this and supply only
   *  their own words. */
  micPresentation: MicPresentation;
  /** The CONFIGURED wake/stop phrases, so a user's remap shows up in every hint. */
  wakeWord: string;
  stopWord: string;
  /** Non-null only while the one-time voice-model download is in flight. */
  modelProgress: { done: number; total: number | null } | null;
  /** The mapped dictation failure (headline + remedy), or null when voice is healthy. Surfaced by
   *  composers that own an announceable slot for it; `micPresentation === "error"` is the gate. */
  errorNotice: VoiceErrorNotice | null;
  /** An arm attempt was refused for lack of credits (transient, auto-clears). */
  outOfCreditsNotice: boolean;
}

export function useVoicePlaceholder(): VoicePlaceholderState {
  // Gate on the ACTUAL capture state, never the armed intent: `enabled` stays true while capture is
  // focus-paused, so keying off it would falsely claim "I'm listening" with nothing being captured.
  const audioActive = useDictationStore((s) => s.status === "listening");
  const micEnabled = useDictationStore((s) => s.enabled);
  const phase = useDictationStore((s) => s.phase);
  const modelProgress = useDictationStore((s) => s.modelProgress);
  const voiceError = useDictationStore((s) => s.error);
  const outOfCreditsNotice = useDictationStore((s) => s.outOfCreditsNotice);
  const wakeWord = useSettingsStore((s) => s.wakeWord);
  const stopWord = useSettingsStore((s) => s.stopWord);
  const errorNotice = useMemo(() => voiceErrorNotice(voiceError), [voiceError]);
  // `errorNotice != null` is this layer's `hasError`; the (idle vs error) distinction in the raw
  // status is irrelevant once a real error is handled by hasError, so `audioActive` suffices.
  const micPresentation = deriveMicPresentation({
    enabled: micEnabled,
    status: audioActive ? "listening" : "idle",
    phase,
    modelProgress,
    hasError: errorNotice !== null,
    outOfCreditsNotice,
  });
  return {
    micPresentation,
    wakeWord,
    stopWord,
    modelProgress,
    errorNotice,
    outOfCreditsNotice,
  };
}
