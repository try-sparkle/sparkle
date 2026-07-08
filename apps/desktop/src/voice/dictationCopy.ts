// Mic-hot ("audio is active") copy, kept in ONE place so every composer that surfaces the voice
// affordance reads identically. The global dictation pipeline is shared across the build Composer
// and the Think composer, so the placeholder wording must not drift between them.
//
// STOP_PHRASE is the spoken command that ends active dictation (the wake matcher in
// voice/wakeWords.ts recognizes it). The build Composer paints it as a teal→cyan gradient in its
// styled overlay; the native-textarea fallback and the Think composer use the assembled
// MIC_HOT_PLACEHOLDER string verbatim.
//
// The default phrases are re-exported from voiceDefaults.ts — the SINGLE source of the built-in
// words shared with the matcher, store, and configActions — so the on-screen copy defaults can
// never drift from the actually-recognized words.
import { DEFAULT_WAKE_WORD, DEFAULT_STOP_WORD } from "./voiceDefaults";
export const STOP_PHRASE = DEFAULT_STOP_WORD;
// ACTIVE phase (the wake word was heard; dictation is live). Only show this when the backend is
// BOTH capturing (status "listening") AND in the active phase — never while merely waiting for
// the wake word, or the composer lies about being in dictation mode (sparkle voice-status bug).
export const MIC_HOT_PREFIX = "I'm listening, so just start talking. Say ";
export const MIC_HOT_SUFFIX = " to finish.";
/** Assemble the mic-hot placeholder around the CONFIGURED stop phrase. Defaults to STOP_PHRASE so
 *  `micHotPlaceholder()` === the old MIC_HOT_PLACEHOLDER constant (back-compat). */
export function micHotPlaceholder(stopPhrase: string = STOP_PHRASE): string {
  return `${MIC_HOT_PREFIX}${stopPhrase}${MIC_HOT_SUFFIX}`;
}
export const MIC_HOT_PLACEHOLDER = micHotPlaceholder();

// PASSIVE phase (capturing, but listening for the wake word — NOT yet dictating). Mirrors the
// sidebar caption so the composer's status is honest: it is not in active dictation, it is
// waiting for "Hey Sparkle". The "(or you can type here instead)" tail subsumes the typing hint,
// like the mic-hot copy does, so it stays put on focus.
export const WAKE_PHRASE = DEFAULT_WAKE_WORD;
export const WAKE_PREFIX = "Listening for the wake word. Just say ";
export const WAKE_SUFFIX = " to talk to me (or you can type here instead).";
/** Assemble the passive placeholder around the CONFIGURED wake word. Defaults to WAKE_PHRASE so
 *  `wakePlaceholder()` === the old WAKE_PLACEHOLDER constant (back-compat). */
export function wakePlaceholder(wakeWord: string = WAKE_PHRASE): string {
  return `${WAKE_PREFIX}${wakeWord}${WAKE_SUFFIX}`;
}
export const WAKE_PLACEHOLDER = wakePlaceholder();
