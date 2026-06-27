// Mic-hot ("audio is active") copy, kept in ONE place so every composer that surfaces the voice
// affordance reads identically. The global dictation pipeline is shared across the build Composer
// and the Think composer, so the placeholder wording must not drift between them.
//
// STOP_PHRASE is the spoken command that ends active dictation (the wake matcher in
// voice/wakeWords.ts recognizes it). The build Composer paints it as a teal→cyan gradient in its
// styled overlay; the native-textarea fallback and the Think composer use the assembled
// MIC_HOT_PLACEHOLDER string verbatim.
export const STOP_PHRASE = "Sparkle, stop";
export const MIC_HOT_PREFIX = "I'm listening, so just start talking. Say ";
export const MIC_HOT_SUFFIX =
  " to finish. (or if you want to be a slowpoke, start typing here instead.)";
export const MIC_HOT_PLACEHOLDER = `${MIC_HOT_PREFIX}${STOP_PHRASE}${MIC_HOT_SUFFIX}`;
