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
import type { Phase } from "./wakeMachine";
import { micIntentForMode, type SendMode } from "./sendMode";
import type { FocusOwner } from "./dictationFocus";
import type { MicIntent } from "../components/MicButton";

/** The mutually-exclusive voice states a mic surface can be in. Ordered by the precedence
 *  deriveMicPresentation applies (see below). */
export type MicPresentation =
  | "off" // mic disarmed — the surface makes no voice promise at all
  | "outOfCredits" // an arm attempt was refused for lack of credits — show the shared notice
  | "error" // dictation failed — show the error notice (real cause + remedy)
  | "preparing" // the one-time voice-model download is in flight — armed but not usable yet
  | "focusPaused" // armed, but capture is NOT live (window unfocused, muted, or not yet started)
  | "activeListening" // armed, capturing, wake word heard — actively dictating
  | "passiveWaiting"; // armed, capturing, still listening for the wake word

export interface MicPresentationInput {
  /** The mic is armed (user intent). False = master-muted/off. */
  enabled: boolean;
  /** Whether the backend is ACTUALLY capturing. "listening" = live; "idle"/"error" = not capturing.
   *  Set optimistically/asynchronously relative to `enabled`, and per-window — which is exactly why
   *  each surface must read it through THIS one function rather than gating on it independently. */
  status: "idle" | "listening" | "error";
  /** "active" = dictating (wake word heard); "passive" = waiting for the wake word. */
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
}

/** Reduce a dictation-store snapshot to the one voice state both mic surfaces render from.
 *
 *  Precedence (highest first) — the union of the two components' historical render ladders, so
 *  neither surface changes for any state where they already agreed:
 *    1. outOfCredits — set with the mic still off, so it must win over `off`.
 *    2. error        — a failed mic reports the failure, never a stale download/live state.
 *    3. off          — disarmed: no download is "preparing", nothing is "listening".
 *    4. preparing    — armed, but the model is still downloading (can't dictate yet).
 *    5. focusPaused  — armed, not capturing: honest "paused", never a wake/active invitation.
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
// missed: the wake word moves `phase` on its own, so saying "Hey Sparkle" in Push to talk flipped
// the mic glyph GREEN while the tray still read "Push to talk" — the same shape as the desync
// useVoicePlaceholder's header describes ("the sidebar says Actively listening, composer says Mic
// paused"). Reading the position directly removes the second state instead of adding a third
// reconciler.
//
// `micIntentForMode` is REUSED, not re-implemented, and that is the whole point: it is the very
// function the tray's setter drives the microphone with, so "what the tray did to the mic" and
// "what the indicator draws" are one expression evaluated twice, not two tables to keep aligned.
// It also inherits that function's fail-closed default — an unrecognised persisted mode draws OFF.

/** What the sidebar mic indicator shows: the tray position, in the mic's own vocabulary. */
export interface MicIndicator {
  /** The mic state to draw. Feed to `micVisual` (components/MicButton) for colour + glyph — the
   *  same table the tray paints its own pills from, which is what makes the two the same colour. */
  state: MicIntent;
  /** The indicator's accessible name. It is NOT a control, so this names a STATE ("Microphone:
   *  actively listening") rather than an action ("Pause listening") — a name that promises an
   *  action on something that does not respond to one is worse than no name at all. */
  label: string;
}

/** Keyed by the derived STATE, never by the mode. Both halves of {@link MicIndicator} therefore
 *  come from the same value, so the words and the glyph cannot describe different things — the
 *  failure this module exists to prevent, one layer down. */
export const MIC_INDICATOR_LABEL: Record<MicIntent, string> = {
  active: "Microphone: actively listening",
  paused: "Microphone: push to talk",
  off: "Microphone: off",
};

/**
 * THE indicator's whole presentation: the tray position, GATED ON WHETHER AUDIO IS ACTUALLY BEING
 * CAPTURED.
 *
 * ── WHY THE FOCUS OWNER IS AN INPUT ─────────────────────────────────────────────────────────────
 * The founder's rule, stated directly: the mic glyph is a function of "is audio being captured right
 * now", NOT of which position the tray is parked at. Those coincide everywhere except one place —
 * the caret sitting in a terminal — and there they diverge hard: Speak keeps its `active` intent
 * while `voice/dictationFocus` has already stopped the composer route, so a position-only reading
 * paints a live green mic over a pipeline sending the user's voice somewhere else entirely.
 *
 * A terminal therefore draws the SAME grey struck-through glyph as Send. That is deliberate and it
 * is not a lost distinction: what the user needs from this glyph is binary — is the mic taking my
 * voice or not — and a third "paused" treatment invents a state they have to learn in order to
 * conclude the same thing. The REASON still gets said, in the caption underneath
 * (`dictationCopy.pausedCaption`), which is where an explanation belongs.
 *
 * `FocusOwner` rather than a boolean so this reads the shipped classifier's own vocabulary
 * (`classifyFocusOwner`), and so a future owner that is neither terminal nor composer has somewhere
 * to land without changing this signature.
 */
export function micIndicatorForMode(mode: SendMode, focusOwner: FocusOwner = "other"): MicIndicator {
  // Defaulted so every existing call site keeps its current meaning; the sidebar passes the live
  // value. A default of "other" is the safe direction — it can only ever OVERSTATE the position's
  // own intent, never invent capture that is not happening.
  const state: MicIntent = focusOwner === "terminal" ? "off" : micIntentForMode(mode);
  return { state, label: MIC_INDICATOR_LABEL[state] };
}

/** Which caption the sidebar shows under the waveform, once the health ladder above has been
 *  cleared (no error, no download, capture live). */
export type MicCaptionKind =
  | "none" // the mic is released — the sidebar promises nothing
  | "wakeInvite" // armed, not routing: "Mic paused. Say <wake> to activate"
  | "dictating"; // routing: "Actively listening. Just say <stop> to finish"

/**
 * The caption follows the tray, and ONLY the tray — the same one input the glyph takes.
 *
 * IT DELIBERATELY DOES NOT TAKE "is dictation in flight right now". That was tried, on the
 * reasoning that a push-to-talk hold routes speech without moving the tray, so a caption pinned to
 * the position alone reads "Mic paused" at someone mid-sentence. But the promotion fires for the
 * WAKE WORD too — the matcher moves `phase` with no gesture anywhere — and the result is the ring
 * sitting amber under a caption announcing "Actively listening": two adjacent elements
 * contradicting each other, which is the precise failure this module exists to delete. A caption
 * that is merely coarse is a smaller fault than one that argues with the glyph beside it.
 *
 * The push-to-talk wording is the right place to fix the coarseness, and it is a COPY question:
 * a sentence that is true whether or not the key is down ("Hold ⌘ to talk") needs no live input at
 * all. Until that copy is agreed, this stays a pure function of the position.
 */
export function micCaptionKind(mode: SendMode): MicCaptionKind {
  if (micIntentForMode(mode) === "off") return "none";
  return mode === "speak" ? "dictating" : "wakeInvite";
}
