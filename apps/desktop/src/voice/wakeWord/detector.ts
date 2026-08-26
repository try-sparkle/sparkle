// Continuous wake-word detection over the transcript this app already produces (bead
// `sparkle-uz87.3`).
//
// ══ WHAT THIS DOES NOT DO, AND WHY THAT IS THE DESIGN ═══════════════════════════════════════════
// It does not open a microphone, does not touch audio, does not call a model, and does not make a
// network request. It is a pure state machine over `feed(text)` plus one injected clock. The
// "on-device" guarantee in the bead ("listens in the background without sending audio to the cloud")
// is therefore STRUCTURAL rather than a promise: there is no I/O in this file to audit. Audio is
// already being turned into text by the existing dictation path; this module reads that text.
//
// It also does not write `voice/dictationPhase`. Commit aed3f7d2f retired the wake word from the mic
// path on the founder's instruction, and the property that removal bought is stated in
// `dictationPhase.ts`: "Nothing moves the phase behind the user's back any more." A wake matcher that
// flipped the mic phase from a spoken phrase — with the send tray still reading "Push to talk" — is
// the exact family of defect that was deleted, and it must not come back through this door. So this
// module EMITS AN EVENT and nothing else. `sparkle-uz87.7` routes that event to the ambient overlay,
// which is a different surface with a different control: the overlay waking is not the microphone
// changing mode.
//
// ══ THE TWO RULES THAT MAKE ONE SPOKEN PHRASE PRODUCE ONE EVENT ═════════════════════════════════
// Both exist because of how this repo's ASR actually behaves, not out of caution.
//
//   1. THE ROLLING WINDOW. Words are fed as they arrive, so half a phrase can land in one chunk and
//      half in the next. The window stitches recent chunks together so "hey" + "sparkle" fires. But
//      a window that never forgot would eventually contain a "hey" from one sentence and a "sparkle"
//      from an unrelated one minutes later and fire on the pair — so anything older than `windowMs`
//      is dropped before every match.
//
//   2. THE COOLDOWN. Deepgram's interims are CUMULATIVE: the same utterance arrives five or ten
//      times, each rendering containing the full phrase again (see the "Deepgram partial IS the
//      final" behaviour — the transcript never announces which delivery is the last one). Matching
//      each of those would fire the overlay open five times for one "hey sparkle". The cooldown is
//      measured from the LAST TIME THE PHRASE WAS SEEN, not from the last time it FIRED, and that
//      distinction is load-bearing: a long sentence keeps re-delivering the phrase for as long as
//      the user keeps talking, so a fire-anchored cooldown would expire mid-utterance and fire a
//      second time. Anchored to the last sighting, the phrase must be ABSENT from the window for a
//      full `cooldownMs` before it can fire again.
//
// A third rule works with them: ONCE THE PHRASE HAS BEEN SEEN IT LEAVES THE WINDOW — the window is
// replaced by the residual alone, whether the sighting fired or was suppressed. Suppressing without
// consuming is the subtle version of the bug the cooldown exists to prevent: the phrase stays in the
// window, and the NEXT genuine "hey sparkle" a few seconds later matches the OLD one first, handing
// the genie a residual that begins with the previous request instead of the new one.

import { type WakeWordEvent } from "./events";
import {
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_WAKE_PHRASE,
  matchWakePhrase,
  normalizeTranscript,
} from "./wakePhrase";

/**
 * How long the phrase must be absent from the window before it can fire again.
 *
 * 2 seconds comfortably outlasts the interim storm of a single utterance (they arrive several times
 * a second while someone is speaking) while staying short enough that a user who says "hey sparkle",
 * gets no useful answer and says it again a beat later is heard the second time.
 */
export const DEFAULT_COOLDOWN_MS = 2_000;

/**
 * How long a fed chunk stays eligible to form part of a match.
 *
 * 4 seconds is generous for a two-word phrase split across chunks (that split happens within
 * hundreds of milliseconds) and short enough that two unrelated sentences never fuse. Longer
 * configured phrases are the reason this is a knob rather than a constant.
 */
export const DEFAULT_WINDOW_MS = 4_000;

export interface WakeWordDetectorOptions {
  /** What to listen for. Defaults to {@link DEFAULT_WAKE_PHRASE}. Must contain at least one word. */
  phrase?: string;
  /** See {@link DEFAULT_COOLDOWN_MS}. */
  cooldownMs?: number;
  /** See {@link DEFAULT_WINDOW_MS}. */
  windowMs?: number;
  /** Reject matches scoring below this. Defaults to {@link DEFAULT_MIN_CONFIDENCE}. */
  minConfidence?: number;
  /**
   * Whether the detector is listening from the moment it is created. Defaults to `true` —
   * constructing a detector IS the opt-in, and the surface that decides whether to construct one
   * (the overlay, behind `VITE_SPARKLE_OVERLAY`) is where the user-facing privacy switch lives.
   */
  enabled?: boolean;
  /**
   * The clock. Injected so every timing rule above is testable without a real timer; defaults to
   * `Date.now`. The detector never schedules anything — it only ever READS the clock inside
   * {@link WakeWordDetector.feed}, so there is nothing to fake-timer around.
   */
  now?: () => number;
  /**
   * Called once per heard phrase. Thrown errors propagate to the caller of `feed` — this module does
   * not swallow them, because a detector that silently ate its consumer's failures would present as
   * "the wake word doesn't work".
   */
  onDetect: (event: WakeWordEvent) => void;
}

export interface WakeWordDetector {
  /**
   * Offer one transcript chunk — an interim, a committed segment, either. Fires `onDetect`
   * synchronously if this chunk completes the phrase and no cooldown is in force.
   *
   * A chunk that EXTENDS the previous one (Deepgram's cumulative interims: "hey" → "hey spar" → "hey
   * sparkle") REPLACES it rather than being appended, so the window holds the sentence once instead
   * of a pile-up of its own prefixes.
   */
  feed(partialTranscript: string): void;
  /**
   * The privacy control. While disabled the detector accepts nothing, retains nothing and fires
   * nothing; disabling also DISCARDS the window, so text heard before the switch cannot contribute
   * to a match after it.
   */
  setEnabled(enabled: boolean): void;
  /** Whether {@link WakeWordDetector.feed} is currently doing anything at all. */
  isEnabled(): boolean;
  /**
   * Forget everything: the window AND the cooldown. The next occurrence of the phrase fires
   * immediately, however recently one fired. This is the "the conversation ended, start over" verb —
   * the overlay closing, the mic being released.
   */
  reset(): void;
}

/** One fed chunk, kept until it ages out of the window. */
interface Chunk {
  /** The text as fed, so the residual can be sliced out in the user's own casing. */
  text: string;
  /** Its normalized form, for the extends-the-previous-one test. */
  norm: string;
  /** When it was fed. */
  at: number;
}

/**
 * Build a wake-word detector.
 *
 * Nothing happens until {@link WakeWordDetector.feed} is called; there is no subscription, no timer
 * and no teardown. A detector that goes out of scope is garbage, not a leak.
 *
 * @throws if `phrase` contains no words after normalization — a detector listening for "" would
 * match constantly, and failing at construction is the only place that can be noticed.
 */
export function createWakeWordDetector(options: WakeWordDetectorOptions): WakeWordDetector {
  const {
    phrase = DEFAULT_WAKE_PHRASE,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    windowMs = DEFAULT_WINDOW_MS,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    now = Date.now,
    onDetect,
  } = options;

  const normalizedPhrase = normalizeTranscript(phrase);
  if (normalizedPhrase === "") {
    throw new Error("createWakeWordDetector: `phrase` must contain at least one word");
  }

  let enabled = options.enabled ?? true;
  let chunks: Chunk[] = [];
  /** When the phrase was last SEEN in the window — fired or suppressed. `null` = never. */
  let lastSeenAt: number | null = null;

  function feed(partialTranscript: string): void {
    if (!enabled) return;

    const at = now();

    // Age out first, so a chunk that expired while nothing was being fed cannot contribute.
    chunks = chunks.filter((c) => at - c.at <= windowMs);

    const norm = normalizeTranscript(partialTranscript);
    if (norm !== "") {
      const last = chunks[chunks.length - 1];
      const extendsLast = last !== undefined && (norm === last.norm || norm.startsWith(`${last.norm} `));
      const chunk: Chunk = { text: partialTranscript, norm, at };
      if (extendsLast) {
        chunks[chunks.length - 1] = chunk;
      } else {
        chunks.push(chunk);
      }
    }

    const windowText = chunks.map((c) => c.text).join(" ");
    const match = matchWakePhrase(windowText, normalizedPhrase, { minConfidence });
    if (match === null) return;

    // Seen — refresh the cooldown whether or not this sighting is allowed to fire. See the header:
    // anchoring to the last SIGHTING is what makes a long utterance produce exactly one event.
    const suppressed = lastSeenAt !== null && at - lastSeenAt < cooldownMs;
    lastSeenAt = at;

    // Consume: the phrase and everything before it leave the window, so these words can never form
    // part of a LATER match. This happens on a suppressed sighting too — see the header's third
    // rule. Mutating BEFORE the callback so a re-entrant `feed` from inside `onDetect` sees settled
    // state.
    chunks = match.residual === ""
      ? []
      : [{ text: match.residual, norm: normalizeTranscript(match.residual), at }];

    if (suppressed) return;

    onDetect({
      at,
      phrase: normalizedPhrase,
      residual: match.residual,
      confidence: match.confidence,
    });
  }

  function setEnabled(next: boolean): void {
    enabled = next;
    // Discard on the way DOWN only. Retaining heard text across a privacy switch-off is the thing
    // the switch is for; retaining nothing across a switch-on costs a few hundred milliseconds of
    // re-listening and is what a user expects "I just turned this on" to mean.
    if (!next) chunks = [];
  }

  function isEnabled(): boolean {
    return enabled;
  }

  function reset(): void {
    chunks = [];
    lastSeenAt = null;
  }

  return { feed, setEnabled, isEnabled, reset };
}
