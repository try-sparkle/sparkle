// SHOULD THE RELAY SOCKET BE OPEN *BEFORE* THE KEY GOES DOWN?
//
// ── THE DEFECT (sparkle-v3990, the latency half) ────────────────────────────────────────────────
// `cloudStreamCommandFor` opens the relay on the passive→active PHASE EDGE — i.e. on the keydown.
// Push to talk sits `passive` at rest and goes `active` only for the duration of a hold, so the full
// TLS+WS handshake (~490 ms) begins at the instant the key goes down. The founder's measured holds
// on 2026-08-09 were **76-567 ms**, so the socket lands after the key comes up: the command answers
// `raced`, the socket is parked or discarded, and the utterance falls back to the on-device engine.
// That engine decodes only CLOSED VAD segments and has NO interim results at all, which is the
// structural reason a short press never gets the live word-by-word preview. Measured 2026-08-06:
// 171 sockets opened, 136 discarded for landing after the utterance had already ended.
//
// Warm standby (`WARM_STANDBY`, 55 s) already fixes the SECOND hold and every one after it. What it
// cannot fix is the FIRST hold in a cold window — and with an intermittent speaker that is the hold
// the user keeps hitting, over and over.
//
// ── WHY THE DECISION IS HERE AND NOT IN THE HOOK ────────────────────────────────────────────────
// Same reason `cloudStreamCommandFor` is a free function and the Rust side factors `cloud_reuse` /
// `capture_should_be_live` out of their commands: a decision written inline in a React effect needs
// a renderer, a store and a Tauri bridge to observe, so in practice it is a decision no test drives.
// Pure and total, it is one table.

import type { Phase } from "./dictationPhase";
import type { SendMode } from "./sendMode";

/** Everything the pre-arm verdict depends on. Named fields rather than positional booleans: five
 *  `boolean`s in a row is the shape where swapping two compiles and silently inverts a gate. */
export interface PreconnectInputs {
  /** Where the send tray is parked (`voice/sendMode`). */
  mode: SendMode;
  /** The mic phase. Push to talk rests `passive` and is `active` only during a hold. */
  phase: Phase;
  /** Does THIS window hold OS focus? The outer term — see below. */
  windowFocused: boolean;
  /** `aiFeatureNow("composer")` — the live pref, exactly as `openCloud` reads it. */
  aiComposer: boolean;
  /** `aiFeatureNow("voiceDictation")` — ditto. */
  voiceDictation: boolean;
}

/**
 * Should the relay socket be pre-connected right now?
 *
 * Every term is required, and each is here for its own reason:
 *
 * - **`mode === "ptt"`** — this is a push-to-talk fix and only push to talk has the problem. Speak
 *   holds the phase `active` for as long as the tray sits there, so its socket is opened once and
 *   stays; Send releases the mic entirely. Pre-connecting for either would open a billable socket
 *   for a gesture that is not coming.
 *
 * - **`phase === "passive"`** — pre-connect happens AT REST, between holds. During a hold
 *   `start_cloud_stream` owns the socket, and a second opener racing it is precisely the shape the
 *   epoch/`ptr_eq` guards exist to clean up after. Nothing to gain and a race to lose.
 *
 * - **`windowFocused`** — THE OUTER TERM, deliberately, mirroring what `capture_should_be_live`
 *   states for the microphone: `focused && (armed || hold_recent)`. Tab away and the OS mic is
 *   released whatever else is true. A socket held open to Sparkle's relay while the user is in
 *   another app is the same class of promise, so it gets the same answer — and because this verdict
 *   is re-sent on every change, a blur does not merely stop pre-connecting, it RELEASES what was
 *   pre-connected (`preconnect_plan`'s `Release` arm).
 *
 * - **`aiComposer && voiceDictation`** — the two live prefs `openCloud` itself gates on, so a
 *   pre-connect can never reach the relay on a path the real open would have refused. The remaining
 *   gate `openCloud` relies on — a present Sparkle bearer — stays where it already is, in the
 *   command's own `choose_engine` call, which answers `signed_out` without contacting the relay.
 *
 * DELIBERATELY NOT gated on `dictationStore.enabled`. That would be the natural-looking guard and it
 * would make this function dead code: push to talk RESTS at `setEnabled(false)` (`useMicActions`'s
 * `setOff` — the hold's resting state is a released mic), so `enabled` is FALSE at exactly the
 * moment a pre-connect must fire. This is the socket half of the fix and the microphone is not its
 * business; the two are independent, which is why the backend parks a pre-connected socket without
 * caring that `sess.armed` is false.
 */
export function shouldPreconnectCloud(inputs: PreconnectInputs): boolean {
  const { mode, phase, windowFocused, aiComposer, voiceDictation } = inputs;
  if (!windowFocused) return false;
  if (!(aiComposer && voiceDictation)) return false;
  return mode === "ptt" && phase === "passive";
}
