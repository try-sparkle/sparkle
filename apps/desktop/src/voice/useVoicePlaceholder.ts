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
import { voiceErrorNotice, type VoiceErrorNotice } from "./dictationCopy";
import { deriveMicPresentation, type MicPresentation } from "./micPresentation";
import { useDictationPauseReason } from "./useDictationPauseReason";
import type { PauseReason } from "./dictationFocus";

export interface VoicePlaceholderState {
  /** THE voice state, shared with the sidebar caption. Surfaces switch on this and supply only
   *  their own words. */
  micPresentation: MicPresentation;
  /** Non-null only while the one-time voice-model download is in flight. */
  modelProgress: { done: number; total: number | null } | null;
  /** The mapped dictation failure (headline + remedy), or null when voice is healthy. Surfaced by
   *  composers that own an announceable slot for it; `micPresentation === "error"` is the gate. */
  errorNotice: VoiceErrorNotice | null;
  /** An arm attempt was refused for lack of credits (transient, auto-clears). */
  outOfCreditsNotice: boolean;
  /**
   * WHY the mic is paused, when `micPresentation === "focusPaused"` — null otherwise.
   *
   * Carried ALONGSIDE the presentation rather than folded into it, deliberately. The single-state
   * property above is what stops the sidebar and the composer contradicting each other about WHICH
   * state the mic is in; splitting `focusPaused` into one member per cause would put that property
   * back at risk for nothing, since every surface renders the same state and only differs in words.
   * So: one state, one reason, and each surface picks its own sentence for the pair (see
   * dictationCopy.pausedCaption / pausedComposerPlaceholder).
   */
  pauseReason: PauseReason | null;
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
  const errorNotice = useMemo(() => voiceErrorNotice(voiceError), [voiceError]);
  // Read through the SAME hook the sidebar uses, off the SAME pure decision the routing gate makes
  // (voice/dictationFocus). That is what keeps "we stopped transcribing because you're in a
  // terminal" and "we say you're in a terminal" from ever being two different answers.
  const pauseReason = useDictationPauseReason();
  // `errorNotice != null` is this layer's `hasError`; the (idle vs error) distinction in the raw
  // status is irrelevant once a real error is handled by hasError, so `audioActive` suffices.
  const micPresentation = deriveMicPresentation({
    enabled: micEnabled,
    status: audioActive ? "listening" : "idle",
    phase,
    modelProgress,
    hasError: errorNotice !== null,
    outOfCreditsNotice,
    // Already computed just above for the COPY, and previously discarded for the STATE — which is
    // how the composer went on claiming live capture while the sidebar said paused (roborev 57117).
    pauseReason,
  });
  return {
    micPresentation,
    modelProgress,
    errorNotice,
    outOfCreditsNotice,
    pauseReason,
  };
}
