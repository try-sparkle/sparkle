// The SINGLE decision for "which voice state is the mic in right now", shared by BOTH mic surfaces:
// the sidebar caption (LogoWaveform) and the composer placeholder (Composer). Each surface renders
// by switching on the MicPresentation this returns and only supplies its own surface-appropriate
// WORDS — it never re-decides the state. That is what makes the two provably consistent: for one
// store snapshot they compute the same presentation, so they can never show contradictory things
// (the "top-left says Actively listening, composer says Mic paused" desync this module exists to
// kill). It is the caption-level sibling of deriveMicState (MicButton.tsx), which already guarantees
// the same for the mic GLYPH; keeping them as two small pure functions (glyph vs words) mirrors the
// existing split rather than fusing two concerns.
//
// Pure + exported so the precedence is unit-tested directly (this codebase's convention — cf.
// deriveMicState, classifyVoiceError), and the two components import the RESULT rather than each
// re-deriving it.
import type { Phase } from "./dictationPhase";
import type { PauseReason } from "./dictationFocus";
import { micIntentForMode, type SendMode } from "./sendMode";
import { deriveMicState, type MicState } from "../components/MicButton";
import type { FocusOwner } from "./dictationFocus";

/** The mutually-exclusive voice states a mic surface can be in. Ordered by the precedence
 *  deriveMicPresentation applies (see below). */
export type MicPresentation =
  | "off" // mic disarmed — the surface makes no voice promise at all
  | "outOfCredits" // an arm attempt was refused for lack of credits — show the shared notice
  | "error" // dictation failed — show the error notice (real cause + remedy)
  | "preparing" // the one-time voice-model download is in flight — armed but not usable yet
  | "focusPaused" // armed, but capture is NOT live (window unfocused, muted, or not yet started)
  | "activeListening" // armed, capturing, and routing speech — actively dictating
  | "passiveWaiting"; // armed, capturing, routing nothing (Push to talk between holds)

export interface MicPresentationInput {
  /** The mic is armed (user intent). False = master-muted/off. */
  enabled: boolean;
  /** Whether the backend is ACTUALLY capturing. "listening" = live; "idle"/"error" = not capturing.
   *  Set optimistically/asynchronously relative to `enabled`, and per-window — which is exactly why
   *  each surface must read it through THIS one function rather than gating on it independently. */
  status: "idle" | "listening" | "error";
  /** "active" = routing speech; "passive" = armed but routing nothing. See ./dictationPhase. */
  phase: Phase;
  /** Non-null ONLY while the one-time voice-model download is running (a warm install never emits
   *  it). Its presence is what distinguishes "armed but the model is still coming down" from a ready
   *  mic — the optimistic `status === "listening"` alone can't. */
  modelProgress: { done: number; total: number | null } | null;
  /** Whether there is a voice error to surface — i.e. voiceErrorNotice(error) is non-null. Passed as
   *  a boolean so this module stays free of the error-copy machinery (dictationCopy). */
  hasError: boolean;
  /** The shared transient "you're out of credits" notice (set when an arm is refused). Outranks
   *  everything because it is set with the mic still disarmed, so it must beat `off`. */
  outOfCreditsNotice: boolean;
  /**
   * WHY dictation is paused for this window, or null when it is free to route
   * (voice/dictationFocus `dictationPauseReason`, read reactively via `useDictationPauseReason`).
   *
   * ── WHY THIS BELONGS HERE AND NOT AT A CALL SITE (roborev 57117) ────────────────────────────────
   * This module's entire purpose is that ONE store snapshot yields ONE answer for EVERY mic surface.
   * `status` alone cannot carry the pause, because the per-window blur path deliberately leaves it at
   * "listening" (`tearDownOwnedStream` touches interim/level/speaking and not status, and the
   * app-level `dictation://focus(false)` never fires while another Sparkle window is active).
   *
   * The demotion was first applied at ONE caller, which broke the very invariant this function
   * exists for: the sidebar caption went honest while the ring beside it, the bound-device caption
   * two lines below it, and the composer placeholder all still read raw `status` and went on
   * claiming live capture. Patching per-surface is precisely how that contradiction kept relocating
   * — three commits, three axes. Taking the term as an INPUT means a caller cannot opt out of it.
   *
   * Optional, defaulting to null, so a caller that genuinely has no pause fact keeps the original
   * meaning — and the default can only ever UNDER-claim a pause, never invent one.
   */
  pauseReason?: PauseReason | null;
}

/** Reduce a dictation-store snapshot to the one voice state both mic surfaces render from.
 *
 *  Precedence (highest first) — the union of the two components' historical render ladders, so
 *  neither surface changes for any state where they already agreed:
 *    1. outOfCredits — set with the mic still off, so it must win over `off`.
 *    2. error        — a failed mic reports the failure, never a stale download/live state.
 *    3. off          — disarmed: no download is "preparing", nothing is "listening".
 *    4. preparing    — armed, but the model is still downloading (can't dictate yet).
 *    5. focusPaused  — armed, not capturing: honest "paused", never an invitation to speak.
 *    6. active/passive — armed AND actually capturing, split by phase. */
/** Is the mic, as the SURFACES present it, actually hearing the user right now?
 *
 *  The device caption's verb hangs off this — "Listening: Yeti" vs "Mic: Yeti". It must not be
 *  `status === "listening"` read raw, for the reason this module's header already gives: `status`
 *  is optimistic and per-window, and several presentations leave it at `"listening"` while the
 *  surface directly above says capture is broken or not yet usable. A mid-session backend failure
 *  does exactly that (`dictation://error` sets the error and never touches `status`), so the
 *  waveform rendered its "voice failed, here's the remedy" notice with **"Listening: Yeti Stereo
 *  Microphone"** asserting a live capture on the very next line — the same contradiction this whole
 *  branch exists to eliminate, one state over (roborev 55289). `preparing` is the same shape: armed
 *  and optimistic, model still downloading, nothing being heard.
 *
 *  Deriving it from the presentation rather than re-deciding it is the point: one snapshot, one
 *  answer, for every surface. */
export function micIsHearing(p: MicPresentation): boolean {
  return p === "activeListening" || p === "passiveWaiting";
}

export function deriveMicPresentation(i: MicPresentationInput): MicPresentation {
  if (i.outOfCreditsNotice) return "outOfCredits";
  if (i.hasError) return "error";
  if (!i.enabled) return "off";
  if (i.modelProgress !== null) return "preparing";
  // Ranked WITH the status check, not before `preparing`: an in-flight model download is a truer
  // thing to say about the microphone than where the caret or the window is.
  if (i.pauseReason !== null && i.pauseReason !== undefined) return "focusPaused";
  if (i.status !== "listening") return "focusPaused";
  return i.phase === "active" ? "activeListening" : "passiveWaiting";
}

// ---------------------------------------------------------------------------
// THE MIC INDICATOR — one state, read two ways
// ---------------------------------------------------------------------------
//
// The three-position send tray (./sendMode `SendMode`) is the ONLY mic control in the concierge
// column. The sidebar mic is an INDICATOR of it, not a second control, and everything below derives
// from that one position so the two cannot contradict each other.
//
// WHY DERIVE RATHER THAN SYNC. The indicator used to read the dictation STORE (`enabled` × `status`
// × `phase`) while the tray read `uiStore.conciergeSendMode`, with the tray's setter pushing the
// mic through `micIntentForMode`. That is two states kept in step by a write, and a write can be
// missed: the WAKE MATCHER moved `phase` on its own, so saying "Hey Sparkle" in Push to talk
// flipped the mic glyph GREEN while the tray still read "Push to talk" — the same shape as the
// desync useVoicePlaceholder's header describes ("the sidebar says Actively listening, composer
// says Mic paused"). Reading the position directly removes the second state instead of adding a
// third reconciler. The matcher has since been deleted outright (./dictationPhase), so the tray is
// now the ONLY writer of `phase` — this derivation and that one agree by construction rather than
// by this function defending against the other.
//
// `micIntentForMode` is REUSED, not re-implemented, and that is the whole point: it is the very
// function the tray's setter drives the microphone with, so "what the tray did to the mic" and
// "what the indicator draws" are one expression evaluated twice, not two tables to keep aligned.
// It also inherits that function's fail-closed default — an unrecognised persisted mode draws OFF.
//
// ── BUT THE POSITION IS NOT ALWAYS A TRUE STATEMENT ABOUT THE MICROPHONE ────────────────────────
//
// A first cut derived the indicator from the position and NOTHING else, and that was wrong in three
// states — each one the indicator affirmatively contradicting the hardware, which is worse than the
// desync it replaced:
//
//  1. ARMED ELSEWHERE. `useSendMode`'s reconcile deliberately stands down when the tray says Send
//     and the mic is already on ("an unconditional reconcile would have the concierge mounting
//     quietly switch off a microphone the user had just turned on somewhere else"). That divergence
//     is guaranteed by design, and it survives a relaunch: `dictationStore` persists
//     `{enabled, phase}` while `conciergeSendMode` defaults to `send`. The ring drew a slashed grey
//     mic labelled "Microphone: off" beside a waveform strip sweeping with live audio.
//  2. PREPARING. During the one-time model download the tray can sit on Speak while nothing can be
//     heard yet. The ring drew the green live mic under a caption reading "Setting up voice (42%)"
//     — and lost the download glyph, which MicButton documents as deliberately not a mic shape "so
//     it cannot be mistaken for a ready mic at a glance".
//  3. NOT CAPTURING. Focus-paused, or a backend error: same green mic, under "Listening paused…".
//
// So the position governs the INTENT and the hardware governs "can it actually hear you". The two
// are composed in ONE ordered function ({@link micIndicatorFor}) rather than reconciled by the
// component, and the composition is directional — every hardware input can only DEMOTE the claim,
// never promote it. That is what preserves the original fix: nothing but the tray reaching `speak`
// can put the ring on the live green mic.

/** What the sidebar mic indicator shows. */
export interface MicIndicator {
  /** The mic state to draw. Feed to `micVisual` (components/MicButton) for colour + glyph — the
   *  same table the tray paints its own pills from, which is what makes the two the same colour. */
  state: MicState;
  /** The indicator's accessible name. It is NOT a control, so this names a STATE ("Microphone:
   *  actively listening") rather than an action ("Pause listening") — a name that promises an
   *  action on something that does not respond to one is worse than no name at all. */
  label: string;
}

/** Keyed by the derived STATE, never by the mode. Both halves of {@link MicIndicator} therefore
 *  come from the same value, so the words and the glyph cannot describe different things — the
 *  failure this module exists to prevent, one layer down.
 *
 *  `paused` is worded for the STATE and not for Push to talk, even though that is its commonest
 *  cause: focus-paused Speak and an armed-elsewhere mic reach it too, and "push to talk" would be
 *  false in both. The position's own name is on the tray, and the caption says it in words. */
export const MIC_INDICATOR_LABEL: Record<MicState, string> = {
  active: "Microphone: actively listening",
  paused: "Microphone: on, not listening",
  preparing: "Microphone: setting up voice",
  off: "Microphone: off",
};

/** The hardware facts the tray position cannot know. Field names mirror {@link MicPresentationInput}
 *  deliberately — they are the same store fields, read for a different question. */
export interface MicIndicatorInput {
  /**
   * WHO HOLDS THE CARET. A terminal is not "quieter capture" — it is NO capture for this box, so the
   * ring must read exactly as it does in Send.
   *
   * The founder's rule, verbatim: "when listening is paused because my caret is in a terminal, the
   * mic must show the gray off icon — the microphone with a line struck through it — EXACTLY as it
   * does in Send mode. Same icon, same gray, no separate treatment." His reasoning is that what he
   * needs from this glyph is BINARY — is the mic taking my voice or not — and a distinct "paused"
   * treatment invents a third state he has to learn in order to reach the same conclusion.
   *
   * This is deliberately NOT folded into the `status`-based demotion below, which lands on "paused"
   * (amber). Amber is the right answer for a mic that is armed and merely between utterances; it is
   * the wrong answer for one whose words are going nowhere. The REASON still gets said in the
   * caption underneath, which is where an explanation belongs.
   *
   * Optional, defaulting to "other", so every existing call site keeps its meaning and the default
   * can only ever UNDER-claim a pause, never invent one.
   */
  focusOwner?: FocusOwner;
  /**
   * Can a committed phrase actually be TYPED into that focused terminal right now?
   *
   * THIS IS WHAT TURNS A TERMINAL FROM A PAUSE INTO A DESTINATION, and without it the rule above
   * over-applies (roborev 56699). `useDictation` routes committed phrases into the focused terminal
   * whenever `terminalRoutingArmed()` holds, and every other surface already carries the term so
   * they cannot disagree: `armedStatus` keeps `status: "listening"`, `dictationPauseReason` returns
   * null, and `deriveMicPresentation` yields `activeListening`. Demoting unconditionally therefore
   * painted a grey struck-through ring named "Microphone: off" directly beneath the live caption
   * "Actively listening", over a waveform sweeping with real audio —
   * the mic denying hardware that was at that moment transcribing the user's speech.
   *
   * The founder's rule is scoped to "when listening is PAUSED because my caret is in a terminal".
   * A routing terminal is not paused, and there the binary question the glyph answers — is the mic
   * taking my voice — answers YES.
   *
   * Defaults false so every existing caller keeps the original meaning; the caller that flips it is
   * the one that also owns the delivery (dictationFocus `terminalRoutingArmed`).
   */
  terminalRoutes?: boolean;
  /** The mic is genuinely armed. Diverges from the position ONLY in the stand-down case above. */
  enabled: boolean;
  /** Whether the backend is ACTUALLY capturing. */
  status: "idle" | "listening" | "error";
  /** Whether the mic is routing (./dictationPhase). Read ONLY to describe a mic the tray does not
   *  govern — the stand-down case below. */
  phase: Phase;
  /** Non-null only while the one-time voice-model download is running. */
  modelProgress: { done: number; total: number | null } | null;
}

/**
 * THE indicator's whole presentation: the tray position, demoted by what the hardware is doing.
 *
 * Precedence, highest first:
 *   1. preparing — a model still coming down cannot hear you, whatever the tray says. Draws the
 *      download glyph, which is deliberately not a mic shape.
 *   2. the tray released the mic but it is ON anyway — the stand-down case. The tray is not
 *      governing this microphone, so the ring reports the MIC (via the shipped `deriveMicState`)
 *      rather than a position that is not describing it. This is the one path that can reach a
 *      green mic without the tray saying Speak, and only when capture is genuinely live and the
 *      mic is genuinely routing (phase active) — i.e. only when it is simply true.
 *   3. the tray is armed (ptt/speak) but capture is NOT live — focus-paused, or an error. Amber,
 *      never green: green claims we are hearing you and nothing is being heard.
 *   4. otherwise the position, unmodified.
 */
export function micIndicatorFor(mode: SendMode, i: MicIndicatorInput): MicIndicator {
  const state = indicatorState(mode, i);
  return { state, label: MIC_INDICATOR_LABEL[state] };
}

function indicatorState(mode: SendMode, i: MicIndicatorInput): MicState {
  if (i.modelProgress !== null && i.enabled) return "preparing";
  // A terminal that CANNOT take the phrase outranks every position: nothing is reaching any box, so
  // the ring says "off" — the same grey struck-through glyph Send draws. Placed AFTER `preparing` on
  // purpose: an in-flight model download is a truer thing to say about the mic than where the caret
  // happens to be.
  //
  // `!i.terminalRoutes` is load-bearing, not defensive. dictationFocus states the contract outright:
  // anything deciding whether a terminal is a destination calls `terminalRoutingArmed`. This is the
  // fourth consumer of that fact, and the three that already carry it are why the surfaces agree.
  if (i.focusOwner === "terminal" && !i.terminalRoutes) return "off";
  // ── PUSH TO TALK READS THE MIC, NOT THE POSITION (sparkle-u81cz) ──────────────────────────────
  //
  // This position is the one whose resting state and held state are DIFFERENT MICROPHONES, so it is
  // the one place the position alone cannot answer the question. Since `micIntentForMode("ptt")`
  // became "off", the shared expression below would have drawn Push to talk exactly like Send in
  // BOTH states — correct at rest, and wrong the moment the key goes down.
  //
  // `enabled` is what separates them, and it is authoritative rather than a guess: the hold is the
  // only thing that arms this mic (`pttHeldIntent` → `setActive`), and every path that ends a hold
  // drops it back through `micIntentForMode` → `setOff`.
  //
  //   at rest  (released) → "off"    the grey slashed glyph, identical to Send. THE FIX: the
  //                                  founder asked for "the microphone in the OFF position, as if I
  //                                  had it in Send mode — that same gray microphone".
  //   held     (armed)    → "paused" amber, BYTE-IDENTICAL to what this returned for `ptt` before
  //                                  the change, in every combination of status and phase. He was
  //                                  explicit that the held state is already right: "when I push
  //                                  the button is when it becomes active, like it is now. Nothing
  //                                  changes to the active state. It's perfect."
  //
  // Deliberately NOT `deriveMicState`, which is what the generic "off" branch below would have
  // reached and which promotes a live routing mic to GREEN. Green is Speak's, and letting a hold
  // reach it is the exact defect the "stays AMBER when the phase is active" test guards.
  if (mode === "ptt") return i.enabled ? "paused" : "off";
  const intent = micIntentForMode(mode);
  // `modelProgress` is passed as null: case 1 above already claimed that state, so this call is
  // only ever asked the paused-vs-active question.
  if (intent === "off") return i.enabled ? deriveMicState(true, i.status, i.phase, null) : "off";
  return i.status === "listening" ? intent : "paused";
}

/** Which caption the sidebar shows under the waveform, once the health ladder above has been
 *  cleared (no error, no download, capture live). ONE KIND PER ARMED POSITION — see below. */
export type MicCaptionKind =
  | "none" // the mic is released (tray on Send) — the sidebar promises nothing
  | "pushToTalk" // tray on Push to talk: "Hold ⌘ to talk"
  | "dictating"; // tray on Speak: "Actively listening. Just pause when you're done"

/**
 * The caption follows the tray, and ONLY the tray — the same one input the glyph takes.
 *
 * ── THE BUG THIS BRANCH TABLE EXISTED TO CAUSE, AND HOW IT WAS ACTUALLY FIXED ───────────────────
 * There used to be two kinds, `wakeInvite` and `dictating`, selected as
 * `mode === "speak" ? "dictating" : "wakeInvite"`. Speak got its own copy and EVERYTHING ELSE —
 * push-to-talk included — fell through to the wake-word invitation. PTT had no caption of its own,
 * so it borrowed Speak's opposite, and the founder was shown "Mic paused. Say Hey Sparkle to
 * activate" with the tray sitting on PUSH TO TALK, a mode that never had a wake word. He reported
 * it three times; the module's own docblock had parked the fix as "a COPY question, waiting until
 * that copy is agreed", and nobody ever put the question to him.
 *
 * It was NOT fixed by adding a third kind. The wake word itself was retired ("We're no longer
 * doing the wake word … SPEAK SHOULD BE ALWAYS ON"), which deletes `wakeInvite` outright — so the
 * table is still two armed positions wide, with each position now naming ITSELF instead of one of
 * them describing a feature that no longer exists.
 *
 * IT STILL DELIBERATELY DOES NOT TAKE "is dictation in flight right now". That was tried, on the
 * reasoning that a push-to-talk hold routes speech without moving the tray, so a caption pinned to
 * the position alone reads the same mid-sentence as at rest. The answer is the COPY, not a live
 * input: "Hold ⌘ to talk" is true whether or not the key is down, so there is nothing left for a
 * liveness term to correct — and a caption that took one could argue with the glyph beside it,
 * which is the precise failure this module exists to delete.
 */
export function micCaptionKind(mode: SendMode): MicCaptionKind {
  // KEYED ON THE POSITION ITSELF, not on `micIntentForMode` (sparkle-u81cz). It used to read
  // `if (micIntentForMode(mode) === "off") return "none"`, which was a faithful way to ask "does
  // this position promise anything about voice" only while `ptt` rested at "paused". Now that Push
  // to talk rests RELEASED, that spelling would return "none" for it and silently delete the
  // "Hold ⌘ to talk" caption — the one thing that tells the user how to open a mic this change
  // just closed. Deleting the instructions along with the capture is the opposite of the fix.
  //
  // The mapping below is unchanged for every position: send (and any unrecognised value) still
  // promises nothing, and the fail-closed default is preserved by naming the two armed positions
  // explicitly rather than by falling through to one of them.
  if (mode === "speak") return "dictating";
  if (mode === "ptt") return "pushToTalk";
  return "none";
}
