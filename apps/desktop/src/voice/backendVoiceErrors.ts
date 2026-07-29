// The microphone-permission error strings the Rust backend actually emits, in ONE place.
//
// These are copies of `src-tauri/src/mic_permission.rs`'s DENIED_ERROR / RESTRICTED_ERROR /
// NOT_ANSWERED_ERROR, and they are a genuine cross-language contract rather than sample data:
// nothing in the type system connects a Rust `String` sent over `dictation://error` to the regexes
// in dictationCopy.ts that decide what the user is told to DO about it. Reword one side and the
// other silently stops matching — the error quietly falls through to the `unknown` bucket and the
// user loses the System Settings remedy, with no compile error in either language.
//
// So the contract is pinned from both ends, and this file is the pin:
//   - mic_permission.rs's `the_frontend_test_pins_these_exact_strings` READS this file and fails if
//     a constant here no longer matches the Rust one. That is what makes a backend reword loud.
//   - The frontend tests import these instead of holding their own copies, so there is exactly one
//     string per error to keep in sync, not one per test file.
//
// Test-only by intent (no production module imports it) but it lives in src/ rather than a
// fixtures directory because it IS the contract, and because the Rust test needs a stable path to
// read. If you reword a string here, reword it in mic_permission.rs in the same commit — and
// re-check the routing, since `permission` needs a mic context AND a denial, and the no-device /
// unsupported-format / disk-space / download buckets are all matched FIRST.

/** The user denied the prompt (or had already). macOS will never ask again. → `permission` */
export const BACKEND_MIC_DENIED =
  "Microphone access denied: macOS privacy settings are blocking Sparkle's microphone (TCC).";

/** Screen Time / MDM policy forbids capture. Says "not authorized" because the classifier's DENIAL
 *  set has no word for "restricted". → `permission` */
export const BACKEND_MIC_RESTRICTED =
  "Microphone access restricted: Sparkle is not authorized to use the microphone — a device policy (Screen Time or MDM) blocks it.";

/** The frame-liveness watchdog's dead-mic report (capture live, ZERO frames arriving) — the DURABLE
 *  PREFIX only, because the rest of the sentence interpolates an OS-supplied device name and so can
 *  never be a verbatim constant. Two things in dictationCopy.ts depend on this exact shape: the
 *  `no-audio` pattern matches the noun phrase, and the notice PARSES THE QUOTED DEVICE NAME back out
 *  of it to build the remedy. A reword breaks both silently — the notice degrades to `unknown` and
 *  `dictation://audio-recovered` stops recognizing what it is supposed to retract.
 *
 *  HALF A PIN, deliberately noted as such: the frontend tests build their fixtures from this
 *  constant, so there is one string to keep in sync here, but no Rust test reads it yet — the
 *  watchdog module was being written in parallel with this. When it lands it should assert its
 *  emitted message starts with this prefix, exactly as mic_permission.rs's
 *  `the_frontend_test_pins_these_exact_strings` does for the constants above. Until then a backend
 *  reword fails SOFT (the user still sees the raw string) but loses the tailored remedy. → `no-audio` */
export const BACKEND_NO_AUDIO_PREFIX = 'No audio from "';

/** We prompted and timed out waiting. Deliberately carries NO denial word, so it lands in `unknown`
 *  (which renders it verbatim) rather than `permission`: the status is still NotDetermined, so the
 *  Privacy pane has no Sparkle entry yet and sending the user there would be a dead end. → `unknown` */
export const BACKEND_MIC_NOT_ANSWERED =
  "The microphone prompt went unanswered. Click the mic to try again.";
