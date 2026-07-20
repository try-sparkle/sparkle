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
export function deriveMicPresentation(i: MicPresentationInput): MicPresentation {
  if (i.outOfCreditsNotice) return "outOfCredits";
  if (i.hasError) return "error";
  if (!i.enabled) return "off";
  if (i.modelProgress !== null) return "preparing";
  if (i.status !== "listening") return "focusPaused";
  return i.phase === "active" ? "activeListening" : "passiveWaiting";
}
