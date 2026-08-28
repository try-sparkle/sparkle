// ── TRANSCRIPT DELIVERY LIVENESS ──────────────────────────────────────────────────────────────
//
// WHAT THIS WATCHES THAT NOTHING ELSE DOES. The backend has a well-tested AUDIO-liveness watchdog
// (`dictation/watchdog.rs`) whose ladder terminates the moment voiced frames arrive:
// `AudioHealth::Live => FaultAction::Idle`. From that instant nothing in the app — Rust or
// TypeScript — asks whether a single word ever reached the user. Audio flowing was treated as the
// end of the question; it is only the start of it.
//
// THE INCIDENT THIS WAS WRITTEN FOR (bead sparkle-klkcwu). Measured from the founder's own log:
// one relay refusal at 03:31:49Z (`refusal="unreachable"`), a correct fallback to the on-device
// engine, and then TWELVE committed segments — `emit partial seq=0..11`, `source="accept"` —
// between 03:32:33Z and 03:36:04Z. The words were recognised. Every one of them was then dropped
// in the frontend with no log, no event and no pixel: `dictationStore.insert()` was
// `if (fn) fn(text)` with no else, so a null insert target discarded the segment in silence. The
// founder sat talking to a live level meter for three and a half minutes with an empty compose box.
//
// WHY THE MIC INDICATOR ACTIVELY LIED, rather than merely failing to help. `micIsHearing()` in
// `micPresentation.ts` answers TRUE for both `activeListening` and `passiveWaiting` — and
// `passiveWaiting` is precisely the state in which `onSegment` drops the words on the floor. One
// predicate derived from `phase` says "I am hearing you" while another derived from the SAME field
// says "throw this away". A user cannot be expected to tell those apart; they render identically.
//
// ── TWO SHAPES, ONE TAXONOMY ──────────────────────────────────────────────────────────────────
// A dropped transcript and an absent transcript are the same defect to the user — they spoke and
// nothing appeared — so they share one reason type and one surface. They are detected differently:
//
//   • A DROP is known INSTANTLY. The segment arrived and we chose not to deliver it, so there is
//     nothing to wait for: report at the drop site, naming which gate refused it.
//   • AN ABSENCE can only be observed by WAITING, because "no words yet" is indistinguishable from
//     "the user has not spoken yet" until a deadline passes.
//
// ── WHY THE CLOCK STARTS AT SPEECH, NOT AT ARM ────────────────────────────────────────────────
// A deadline measured from the moment the mic arms fires at every user who arms the mic and then
// thinks for six seconds before speaking — an accusation of failure aimed at somebody who has done
// nothing yet, which is worse than the silence it replaces. `events.rs:183-185` already rejected a
// transcript-idle clock for the auto-send rail on exactly this ground.
//
// The discriminator is the VAD. `dictation://speaking` is emitted on BOTH engine paths from Silero
// running over the raw frames, so it is available whether or not the relay is alive, and it means
// "a human is talking into this microphone right now". Once that has been true, "and still no words
// have appeared" is a statement about the PIPELINE and no longer about the user. That is the only
// window in which this may accuse anything.
export type DeliveryDropReason =
  /** A committed segment arrived and no composer owned the app-wide insert target, so
   *  `dictationStore.insert()` had nowhere to put it. THE cause of sparkle-klkcwu. */
  | "no-target"
  /** The mic is armed but `phase !== "active"` — push-to-talk between holds. `onSegment` drops the
   *  words deliberately; the defect is that it did so without telling anyone. */
  | "mic-paused"
  /** The window is unfocused, or the caret is somewhere that refuses dictated text. */
  | "not-routable"
  /** Nothing was produced at all: the user demonstrably spoke and no segment ever arrived. This is
   *  the transcription leg being down (relay unreachable AND the on-device engine silent). */
  | "no-transcript";

/** How long after the user is first heard speaking we wait before saying nothing is arriving.
 *
 *  FOUR seconds, against a five-second requirement, and the gap is the point: the notice has to be
 *  ON SCREEN by five, so the deadline that starts the render must land before it. The remaining
 *  second is budget for the store write and a React paint.
 *
 *  It is a floor on honesty, not a tuning knob — every value here trades a false accusation against
 *  a user left talking to nothing, and four seconds of a live meter producing no text is already
 *  long enough that the founder went looking for a bug. */
export const DELIVERY_DEADLINE_MS = 4_000;

export interface DeliveryWatchInput {
  /** Milliseconds since the FIRST `dictation://speaking(true)` of this listening episode, or null
   *  if the user has not been heard speaking yet. Null is the "say nothing" case, always. */
  msSinceFirstSpeech: number | null;
  /** True once any committed segment of this episode reached a real destination. */
  delivered: boolean;
  /** The mic is armed and presenting itself to the user as hearing them. When this is false the
   *  user is not being told anything, so there is no lie to correct. */
  hearing: boolean;
}

/**
 * Should we tell the user that nothing is coming back?
 *
 * Total and pure so the ordering can be tested without a clock. Every false branch is a REASON not
 * to speak, and they are not interchangeable:
 *   - `!hearing`      — the UI is not claiming anything, so there is nothing to contradict.
 *   - `delivered`     — words have landed this episode; the pipeline demonstrably works.
 *   - `null` speech   — the user has not spoken. Never accuse on this branch (see the header).
 */
export function shouldReportNoTranscript(i: DeliveryWatchInput): boolean {
  if (!i.hearing) return false;
  if (i.delivered) return false;
  if (i.msSinceFirstSpeech === null) return false;
  return i.msSinceFirstSpeech >= DELIVERY_DEADLINE_MS;
}

/** The prefix that marks a `dictationStore.error` as one of ours.
 *
 *  WHY A SENTINEL RATHER THAN A NEW STORE FIELD. The composer's error slot, the sidebar caption,
 *  the `aria-live` announcement and the dismiss affordance are all already wired to
 *  `dictationStore.error` through `voiceErrorNotice`. Routing through that seam inherits four
 *  audited surfaces and their copy rules; a parallel field would have to re-earn each of them, and
 *  the copy tests sweep `voiceErrorNotice` rather than any one component.
 *
 *  It never reaches a human: `voiceErrorNotice` maps this kind to written copy, so unlike the
 *  `unknown` bucket it never falls through to rendering the raw string. */
export const DELIVERY_ERROR_PREFIX = "voice-delivery:";

/** Encode a drop reason as the sentinel `dictationStore.error` string. */
export function deliveryErrorFor(reason: DeliveryDropReason): string {
  return `${DELIVERY_ERROR_PREFIX}${reason}`;
}

/** Recover the reason from a sentinel error string; null when it is not one of ours.
 *  Unknown reasons past the prefix read as `no-transcript` — the copy that assumes least. */
export function deliveryReasonOf(raw: string | null | undefined): DeliveryDropReason | null {
  const text = (raw ?? "").trim();
  if (!text.toLowerCase().startsWith(DELIVERY_ERROR_PREFIX)) return null;
  const tail = text.slice(DELIVERY_ERROR_PREFIX.length).trim() as DeliveryDropReason;
  return tail === "no-target" ||
    tail === "mic-paused" ||
    tail === "not-routable" ||
    tail === "no-transcript"
    ? tail
    : "no-transcript";
}
