// WHICH TRANSCRIPTION ENGINE IS ACTUALLY PRODUCING THE USER'S WORDS — and, the part the user cares
// about, what falling back COSTS them.
//
// Dictation has two engines (see `dictation.rs`): the on-device Parakeet/Silero pair, and the
// Deepgram relay opened on demand while the user is actively dictating. When the relay refuses or
// dies, capture keeps working — the words still land — so nothing looks broken. But the on-device
// path is an OFFLINE transducer: it decodes a closed VAD segment and has no interim results at all
// (`dictationStore.interim` is documented as `""` there). So the live, word-by-word italic preview
// STRUCTURALLY CANNOT EXIST on the fallback path.
//
// WHY THAT NEEDS TO BE SAID OUT LOUD RATHER THAN LEFT TO INFERENCE. The founder chased this twice as
// a bug — once as "the Deepgram text is still showing above the actual text", once hunting missing
// italics — because a silent engine swap is indistinguishable from a broken feature. Losing a
// feature quietly is a TRUST failure, not an accuracy one: the transcript is fine, and the user is
// left believing the app is broken when it has merely changed engines. Naming it costs one banner.
//
// WHY A SEPARATE STORE FROM `aiServiceHealthStore`. That store's detector counts a SUSTAINED run of
// failures from the user's own `claude` CLI, and its copy rules say in as many words to attribute
// the fault to Claude Code on the user's machine rather than to a Sparkle service. Neither fits: the
// relay IS a Sparkle-hosted service, and a single refusal is already definitive here (there is
// nothing to de-flap — `start_cloud_stream` returning `false` is the relay's own answer, not a
// transport blip to be corroborated). Folding this into that reason union would import a threshold
// this signal does not want and an attribution that would be false.
//
// THE SIGNAL IS DEFINITIVE, SO THERE IS NO THRESHOLD AND NO EXPIRY. `start_cloud_stream` returns a
// boolean the relay itself decided; `dictation://cloud-ended` reports the stream going away. Both
// are answers, not symptoms, so this store only ever mirrors the last one it was told.
import { create } from "zustand";

/** Why the cloud engine is not available. Coarse by construction — no raw error, no PII — matching
 *  the copy rules the sibling banners settled on. */
export type DictationFallbackReason =
  /** The relay declined to open, or the stream died mid-utterance (network, upstream, refusal). */
  | "unavailable"
  /** The relay signalled out-of-credits — the one reason the user can actually act on. */
  | "exhausted";

export interface DictationEngineState {
  /** Set once a cloud attempt has been REFUSED or a live stream has ended, meaning dictation is now
   *  running on-device. `null` means "no problem known" — the resting state, and deliberately NOT
   *  "cloud is live": at rest no stream is open at all, and a banner that fired on that would be lit
   *  permanently while nothing was wrong. */
  fallbackReason: DictationFallbackReason | null;
  /** Hidden for THIS episode. Cleared by a cloud stream coming back, so a later, distinct outage
   *  re-arms the banner rather than being permanently silenced by one dismissal. */
  dismissed: boolean;
  /** A cloud stream opened — the engine is back, so retire the banner and re-arm it for next time. */
  noteCloudLive: () => void;
  /** A cloud stream was refused or ended; dictation continues on-device without interim results. */
  noteCloudUnavailable: (reason: DictationFallbackReason) => void;
  dismiss: () => void;
}

export const useDictationEngineStore = create<DictationEngineState>()((set) => ({
  fallbackReason: null,
  dismissed: false,
  noteCloudLive: () => set({ fallbackReason: null, dismissed: false }),
  // A NEW reason re-arms a dismissal, the SAME one does not. Going from a plain outage to
  // out-of-credits is a different thing to tell the user (the second is actionable), so it must be
  // able to speak even if they waved the first one away; re-reporting the same reason on every
  // subsequent refusal must not.
  noteCloudUnavailable: (reason) =>
    set((s) => ({
      fallbackReason: reason,
      dismissed: s.fallbackReason === reason ? s.dismissed : false,
    })),
  dismiss: () => set({ dismissed: true }),
}));

/** Should the banner be showing? Split out from the component so the rule is testable without a
 *  DOM — and so there is exactly ONE place that decides it. */
export function shouldWarnLocalEngine(state: DictationEngineState): boolean {
  return state.fallbackReason !== null && !state.dismissed;
}
