// The origin-gated wake-word detector — the bead's "without sending audio to the cloud" as an
// ENFORCED gate rather than an argued property (bead `sparkle-uz87.3`).
//
// ══ WHY THIS EXISTS ALONGSIDE `createWakeWordDetector` RATHER THAN REPLACING IT ═════════════════
// `createWakeWordDetector` is correct and in use (`services/sparkleSession/session.ts` constructs
// one), and its matching logic — the rolling window, the sighting-anchored cooldown, the residual —
// is exactly right. Nothing here reimplements any of it; this is a gate in front of the same engine.
// Keeping both is deliberate rather than transitional: the ungated factory is the honest surface for
// a caller whose transcript really is of mixed or unestablished provenance, and forcing that caller
// to launder its text through an origin argument it cannot answer would produce a call site typing
// `"on-device"` to make the compiler stop complaining. That is worse than no gate, because it looks
// like one. So: if you can name the origin, use this one; if you genuinely cannot, you do not have
// the guarantee and should not be able to claim it.
//
// ══ THE ONE RULE ════════════════════════════════════════════════════════════════════════════════
// Only `"on-device"` text can ever produce a wake event. `"cloud"`, `"unknown"`, an absent argument
// and anything malformed are all REFUSED — see `./origin` on why the check is an allowlist of one
// and why absence is not permission.
//
// ══ REFUSAL IS A DROP, NOT A MUTE ═══════════════════════════════════════════════════════════════
// A refused chunk never reaches the inner detector at all, which is a stronger property than "it
// does not fire" and the one worth having. Consider the shape a mute would leave open: the phrase
// arrives split across two chunks — "hey" over the cloud path, "sparkle" on-device — and a detector
// that merely declined to FIRE on the cloud chunk would still have STORED it, so the on-device
// chunk completes a phrase that was half-heard by Deepgram and the gate has been walked straight
// through. Dropping means cloud text cannot contribute to a match, cannot sit in the window, and
// cannot influence a later on-device match. The suite pins this case specifically.
//
// It also means refusal does not touch the cooldown. A stream of cloud interims cannot suppress a
// genuine on-device wake, which is the failure a mute would also have produced.
//
// ══ REFUSAL IS SILENT, AND THAT IS A DESIGN DECISION ════════════════════════════════════════════
// No throw, no log, no callback, no counter. Mixed-origin feeding is a NORMAL operating state, not
// an error: this app switches ASR engines at runtime, so a session that begins on-device and moves
// to Deepgram will feed cloud text for as long as that engine is selected. Treating each of those
// chunks as an incident would emit a fault per interim — several a second, for the entire duration
// of ordinary, correct use. The detector simply does not wake. A caller that wants to explain the
// silence to a user should ask which ENGINE is selected, which is a question the engine store can
// answer directly; it should not be inferred from the wake path's refusals.
//
// ══ HOW THE CONSUMER WILL CALL IT ═══════════════════════════════════════════════════════════════
// The join into `services/sparkleSession/session.ts` is deliberately NOT made here — it belongs to
// whoever owns that file. The intended shape is two lines:
//
//   const detector = createOnDeviceWakeWordDetector({ onDetect: (e) => wake(e.residual) });
//   //  … on every transcript chunk, tagged with the engine that produced it:
//   detector.feed(chunk, engineIsLocal ? ON_DEVICE_ORIGIN : "cloud");
//
// Note what the second line does NOT permit: there is no way to write it without having decided
// which engine produced the text. That is the entire point of the argument being mandatory — the
// gate's real work happens at the call site, where the answer is actually known.

import {
  createWakeWordDetector,
  type WakeWordDetectorOptions,
} from "./detector";
import { type WakeWordEvent } from "./events";
import { isOnDeviceOrigin, type TranscriptOrigin } from "./origin";

/**
 * Options for {@link createOnDeviceWakeWordDetector}.
 *
 * Identical to {@link WakeWordDetectorOptions} — phrase, cooldown, window, confidence, enabled,
 * clock and `onDetect` all behave exactly as they do on the ungated detector, because they are
 * handed to it unchanged. The origin gate adds no knobs, and specifically no knob that turns it off:
 * a configurable privacy gate is one that will eventually be found configured off.
 */
export type OnDeviceWakeWordDetectorOptions = WakeWordDetectorOptions;

export interface OnDeviceWakeWordDetector {
  /**
   * Offer one transcript chunk together with the origin of the machine that produced it.
   *
   * Fires `onDetect` synchronously if — and only if — `origin` is exactly `"on-device"` and the
   * chunk completes the phrase with no cooldown in force. Any other origin is dropped silently: no
   * throw, no event, and nothing retained (see the header — the drop is what stops cloud text from
   * forming half of a later match).
   *
   * @param origin required, and required at runtime as well as in the types. A caller that omits it
   * is refused rather than defaulted, because a call site that never considered where its audio went
   * is the one most likely to be handing over cloud text.
   */
  feed(partialTranscript: string, origin: TranscriptOrigin): void;
  /**
   * The privacy control, delegated verbatim to the underlying detector: while disabled the detector
   * accepts nothing, retains nothing and fires nothing, and switching off discards the window.
   *
   * This is a SECOND, independent switch — the origin gate is not a substitute for it. Disabled
   * refuses on-device text too; the gate refuses cloud text even when enabled. Neither can be
   * satisfied by the other.
   */
  setEnabled(enabled: boolean): void;
  /** Whether {@link OnDeviceWakeWordDetector.feed} is currently doing anything at all. */
  isEnabled(): boolean;
  /** Forget everything — the window AND the cooldown. See the ungated detector's `reset`. */
  reset(): void;
}

/**
 * Build a wake-word detector that can only ever be woken by text a local ASR produced.
 *
 * Purely additive: {@link createWakeWordDetector} keeps its signature and its behaviour, and this
 * wraps one rather than forking its matching logic, so the window/cooldown/residual rules are the
 * same code and cannot drift apart.
 *
 * @throws if `phrase` contains no words after normalization — the underlying detector's validation,
 * unchanged, and still raised at construction where it can be noticed.
 */
export function createOnDeviceWakeWordDetector(
  options: OnDeviceWakeWordDetectorOptions,
): OnDeviceWakeWordDetector {
  const inner = createWakeWordDetector(options);

  function feed(partialTranscript: string, origin: TranscriptOrigin): void {
    // FAIL CLOSED. Everything that is not exactly "on-device" returns here, having touched no
    // state — including the values TypeScript says cannot reach this line.
    if (!isOnDeviceOrigin(origin)) return;
    inner.feed(partialTranscript);
  }

  return {
    feed,
    setEnabled: (enabled: boolean) => inner.setEnabled(enabled),
    isEnabled: () => inner.isEnabled(),
    reset: () => inner.reset(),
  };
}

export type { WakeWordEvent };
