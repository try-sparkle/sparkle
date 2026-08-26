// Continuous wake-word detection — the public surface (bead `sparkle-uz87.3`).
//
// THE CONSUMER IS `sparkle-uz87.7`, "wire the detector into the Living Sparkle Overlay" —
// `services/sparkleSession/session.ts` constructs a detector today. The module is delivered with its
// tests as a self-contained unit so that wiring stays a small, reviewable change against a surface
// that is already proven.
//
// HOW IT IS MEANT TO BE USED, in the three lines the consumer will write:
//
//   const detector = createOnDeviceWakeWordDetector({ onDetect: (e) => wake(e.residual) });
//   //  … on every transcript chunk, tagged with the engine that produced it:
//   detector.feed(chunk, engineIsLocal ? ON_DEVICE_ORIGIN : "cloud");
//
// PREFER THE ORIGIN-GATED FACTORY. `createWakeWordDetector` remains exported, unchanged, and is the
// right choice ONLY for a caller whose transcript provenance genuinely cannot be established — see
// `./onDeviceDetector` on why forcing such a caller to invent an origin would be worse than no gate.
// Every caller that CAN name where its text came from should take the gated one, because that is the
// one whose "the cloud never heard this" is checked rather than asserted.
//
// `e.residual` is what the user said after the phrase in the same breath ("hey sparkle what's on my
// calendar" → "what's on my calendar"), so the overlay can open AND dispatch in one turn.
//
// THE PRIVACY CONTROL is `detector.setEnabled(false)`: while disabled the detector accepts nothing,
// retains nothing and fires nothing, and the switch-off discards whatever was in its window. It is
// the only user-facing state this module has.
//
// WHAT IT WILL NEVER DO. It performs no I/O of any kind — no audio, no network, no model call, no
// timers. It reads text the existing transcript path already produced.
//
// THAT IS NOT THE PRIVACY GUARANTEE, AND IT USED TO BE MISTAKEN FOR ONE. "This module sends no
// audio" is not "no audio was sent": the text it reads is produced upstream, and in this app it can
// come from a LOCAL engine (sherpa-onnx, in the Rust process) or from a CLOUD one (Deepgram, over a
// websocket) — and in the second case the raw audio has already left the machine before `feed` is
// ever called. A module that performs no I/O is structurally unable to observe that, which is
// exactly why the guarantee could not be made here. `./origin` and `./onDeviceDetector` close it by
// making the provenance travel WITH the text, so the question is answered at the call site that
// knows the answer and the detector refuses everything else. It also
// never writes `voice/dictationPhase`: waking the overlay is not changing the microphone's mode, and
// commit aed3f7d2f deliberately left the send tray as the mic's only writer. Emitting an event and
// letting the overlay decide is what keeps both of those true.
//
// Anything not re-exported here is an implementation detail — the tokenizer, the edit-distance
// function and the window bookkeeping are all free to change without a caller noticing.

export { type WakeWordEvent } from "./events";

export {
  createOnDeviceWakeWordDetector,
  type OnDeviceWakeWordDetector,
  type OnDeviceWakeWordDetectorOptions,
} from "./onDeviceDetector";

export {
  isOnDeviceOrigin,
  ON_DEVICE_ORIGIN,
  TRANSCRIPT_ORIGINS,
  type TranscriptOrigin,
} from "./origin";

export {
  createWakeWordDetector,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_WINDOW_MS,
  type WakeWordDetector,
  type WakeWordDetectorOptions,
} from "./detector";

export {
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_WAKE_PHRASE,
  matchWakePhrase,
  normalizeTranscript,
  type MatchOptions,
  type WakePhraseMatch,
} from "./wakePhrase";
