// Continuous wake-word detection — the public surface (bead `sparkle-uz87.3`).
//
// THE CONSUMER IS `sparkle-uz87.7`, "wire the detector into the Living Sparkle Overlay". Nothing
// imports this yet, and that is expected rather than a loose end: this module is delivered with its
// tests as a self-contained unit so the overlay wiring is a small, reviewable change against a
// surface that is already proven.
//
// HOW IT IS MEANT TO BE USED, in the three lines the consumer will write:
//
//   const detector = createWakeWordDetector({ onDetect: (e) => wake(e.residual) });
//   //  … on every transcript chunk the dictation path already emits:
//   detector.feed(chunk);
//
// `e.residual` is what the user said after the phrase in the same breath ("hey sparkle what's on my
// calendar" → "what's on my calendar"), so the overlay can open AND dispatch in one turn.
//
// THE PRIVACY CONTROL is `detector.setEnabled(false)`: while disabled the detector accepts nothing,
// retains nothing and fires nothing, and the switch-off discards whatever was in its window. It is
// the only user-facing state this module has.
//
// WHAT IT WILL NEVER DO. It performs no I/O of any kind — no audio, no network, no model call, no
// timers. It reads text the existing on-device/streaming transcript path already produced. It also
// never writes `voice/dictationPhase`: waking the overlay is not changing the microphone's mode, and
// commit aed3f7d2f deliberately left the send tray as the mic's only writer. Emitting an event and
// letting the overlay decide is what keeps both of those true.
//
// Anything not re-exported here is an implementation detail — the tokenizer, the edit-distance
// function and the window bookkeeping are all free to change without a caller noticing.

export { type WakeWordEvent } from "./events";

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
