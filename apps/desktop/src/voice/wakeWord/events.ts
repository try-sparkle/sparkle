// What the detector HANDS OVER when it hears the phrase — the whole surface between this module
// and the overlay (bead `sparkle-uz87.7`, the consumer).
//
// ── WHY `residual` IS ON THIS EVENT AND NOT LEFT FOR A SECOND TURN ──────────────────────────────
// People do not say "hey sparkle", wait to be acknowledged, and then say what they wanted. They say
// "hey sparkle what's on my calendar" in one breath. A detector that emitted only "the phrase was
// heard" would throw away the second half of that sentence, and the overlay would have to open,
// re-arm the mic and ask the user to repeat themselves — which is the interaction the ambient genie
// exists to replace. So the words AFTER the phrase, in the same utterance, travel with the event and
// the caller can route them straight to the genie without a second turn.
//
// `residual` is EMPTY when the user said only the wake phrase. That is a real and common case ("hey
// sparkle" … then a pause), and it is the caller's cue to open and listen rather than to dispatch
// nothing.

/**
 * One wake-phrase detection.
 *
 * Emitted at most once per spoken phrase — see `./detector` on the cooldown that makes that true
 * despite this repo's ASR re-delivering the same words in every interim.
 */
export interface WakeWordEvent {
  /**
   * When the detection happened, from the detector's injected clock — NOT `Date.now()` read at the
   * consumer. The consumer may be several async hops away (an event bus, a store write, a React
   * render), and an overlay animation that measures its age against its own later clock reading
   * would drift by exactly that lag.
   */
  at: number;

  /**
   * The configured wake phrase that matched, NORMALIZED (lowercase, punctuation-free) — "hey
   * sparkle" by default, whatever `phrase` the detector was created with otherwise.
   *
   * This is the phrase as CONFIGURED, deliberately, not the words as HEARD: a user who set their
   * phrase to "yo sparkle" should see their own phrase reflected back in a log line or a settings
   * surface, not the ASR's rendering of it ("yo sparkel"). The heard form is a transcription
   * artefact and the caller never has a use for it.
   */
  phrase: string;

  /**
   * Whatever the user said AFTER the phrase in the same utterance, in ORIGINAL casing and
   * punctuation — "what's on my calendar", apostrophe intact.
   *
   * Empty string when the phrase was the whole utterance. Never null: an empty string is the honest
   * "they said nothing else", and a caller writing `residual || fallback` gets the right answer,
   * whereas a null forces every caller to spell the same guard.
   */
  residual: string;

  /**
   * How closely the heard words matched the configured phrase, `0`–`1`, where `1` is character-exact
   * after normalization.
   *
   * A SCORE, not a probability. It is `1 - edits / phraseLength` over the tolerant match (see
   * `./wakePhrase`), so "hey sparkel" scores 0.9 against "hey sparkle". Callers may use it to log or
   * to raise their own bar; the detector has already applied `minConfidence` before emitting, so an
   * event that arrives at all has cleared the threshold.
   */
  confidence: number;
}
