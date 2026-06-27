// Mic-hot ("audio is active") copy, kept in ONE place so every composer that surfaces the voice
// affordance reads identically. The global dictation pipeline is shared across the build Composer
// and the Think composer, so the placeholder wording must not drift between them.
//
// STOP_PHRASE is the spoken command that ends active dictation (the wake matcher in
// voice/wakeWords.ts recognizes it). The build Composer paints it as a teal→cyan gradient in its
// styled overlay; the native-textarea fallback and the Think composer use the assembled
// MIC_HOT_PLACEHOLDER string verbatim.
export const STOP_PHRASE = "Sparkle, stop";
// ACTIVE phase (the wake word was heard; dictation is live). Only show this when the backend is
// BOTH capturing (status "listening") AND in the active phase — never while merely waiting for
// the wake word, or the composer lies about being in dictation mode (sparkle voice-status bug).
export const MIC_HOT_PREFIX = "I'm listening, so just start talking. Say ";
export const MIC_HOT_SUFFIX =
  " to finish. (or if you want to be a slowpoke, start typing here instead.)";
export const MIC_HOT_PLACEHOLDER = `${MIC_HOT_PREFIX}${STOP_PHRASE}${MIC_HOT_SUFFIX}`;

// PASSIVE phase (capturing, but listening for the wake word — NOT yet dictating). Mirrors the
// sidebar caption so the composer's status is honest: it is not in active dictation, it is
// waiting for "Hey Sparkle". The "(or you can type here instead)" tail subsumes the typing hint,
// like the mic-hot copy does, so it stays put on focus.
export const WAKE_PHRASE = "Hey Sparkle";
export const WAKE_PREFIX = "Listening for the wake word. Just say ";
export const WAKE_SUFFIX = " to talk to me (or you can type here instead).";
export const WAKE_PLACEHOLDER = `${WAKE_PREFIX}${WAKE_PHRASE}${WAKE_SUFFIX}`;
