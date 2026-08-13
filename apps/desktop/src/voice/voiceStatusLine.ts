// THE ONE STATUS LINE under the waveform — what it says, and whether it is resting or live.
//
// ══ THE ASK (founder, bead sparkle-bbfsx) ═══════════════════════════════════════════════════════
// Three rows of chrome became one. Push to talk showed a grey "Push to talk" headline, a blue
// "Hold ⌘ to talk" action, and a device caption; Speak showed a grey "Actively listening", a blue
// "Just pause when you're done", and the same device caption. His instruction, in two messages:
//
//   *"Let's just remove push to talk completely. So where it says hold command to talk, when I am
//   holding command, it should say release command to send. So that would basically be responsive.
//   It says hold command to talk, when I'm not talking. And it should be instead of in blue, it
//   should be in gray. So it should be the color of push to talk. And then when I am actually
//   holding it, that's when it should be blue."*
//
//   *"Let's make actively listening be the blue color when it's active. So it should just say
//   actively listening in blue. It does not have to say just pause when you're done."*
//
// ── THE COLOURS SWAP ROLES, WHICH IS THE PART A READER WILL ASSUME IS A BUG ────────────────────
// Today's blue line is blue in every state. After this, BLUE MEANS LIVE and grey means resting —
// so the same "Hold ⌘ to talk" that used to be blue is now grey, and that is the change, not a
// regression. Push to talk therefore has both states and Speak has only the live one.
//
// ── ONE COMPONENT WITH A STATE, NOT TWO BESPOKE LAYOUTS ────────────────────────────────────────
// The two modes reduce to the same shape — one centred line that is blue while the mic is live —
// so the rule lives here as data and `components/VoiceStatusLine` draws whatever it returns. A
// per-mode layout is how the two drift into different type, different spacing, and a caption that
// contradicts its own glyph, which is the family of defects `voice/micPresentation` exists to end.
//
// Pure: no React, no stores, no clock. Every rule below is testable as data.
import {
  PTT_CAPTION_ACTION,
  PTT_CAPTION_HELD,
  SPEAK_CAPTION_HEADLINE,
} from "./dictationCopy";
import type { MicCaptionKind } from "./micPresentation";

/** How the line is painted. `live` is the brand blue, `rest` the muted grey — see the header for
 *  why those two roles are the opposite way round from the copy this replaces. */
export type VoiceStatusTone = "rest" | "live";

export interface VoiceStatusLine {
  text: string;
  tone: VoiceStatusTone;
}

export interface VoiceStatusLineInput {
  /** Which armed position this surface is showing, from `micCaptionKind` — the same value the
   *  composer's placeholder reads, so the two cannot describe different modes. */
  captionKind: MicCaptionKind;
  /**
   * IS THE TALK KEY DOWN RIGHT NOW — the GESTURE, never the microphone.
   *
   * `useSendMode.held` is written by the keydown listener itself (voice/usePushToTalk), before the
   * mic is asked for anything and before any capture starts. Deriving this from mic liveness
   * instead would make the words lag his finger by the whole start-up, and sub-second lag in this
   * app is something he reports. It is also the ONLY honest source on the way back out: a release
   * with an outstanding transcript keeps the mic live for up to PARTIAL_SETTLE_CAP_MS, so a
   * mic-derived line would still read "Release ⌘ to send" seconds after he let go.
   */
  pttHeld: boolean;
}

/**
 * What the single line says right now, or null when this surface has nothing true to claim.
 *
 * NULL IS A REAL ANSWER AND MUST NOT BECOME AN EMPTY ROW. `captionKind === "none"` is the tray on
 * Send, or a mic some other surface owns — the founder asked for the space to be RECLAIMED, not
 * reserved, so the caller renders nothing at all rather than a blank line holding a gap open.
 *
 * The caller decides WHETHER to ask (its presentation ladder still owns error / preparing / paused);
 * this decides only what to say once asking is the right thing to do.
 */
export function voiceStatusLine(input: VoiceStatusLineInput): VoiceStatusLine | null {
  switch (input.captionKind) {
    case "pushToTalk":
      // The responsive half. Held → the thing he is about to do is LET GO, and that is what sends.
      return input.pttHeld
        ? { text: PTT_CAPTION_HELD, tone: "live" }
        : { text: PTT_CAPTION_ACTION, tone: "rest" };
    case "dictating":
      // Speak has ONE state here, and that is a property of the mode rather than a simplification:
      // `micIntentForMode("speak")` is `active` for as long as the tray sits there, so the phase is
      // never `passive` in this position (voice/dictationPhase spells out that Speak IS "always
      // on"). The mic not actually hearing anything is `focusPaused` / `error` / `preparing`, and
      // every one of those is claimed by an EARLIER arm of the caller's ladder with copy that names
      // its own cause. So there is no resting Speak state for this line to have a second string for.
      return { text: SPEAK_CAPTION_HEADLINE, tone: "live" };
    case "none":
      return null;
    default: {
      // Unreachable: every member of MicCaptionKind has an arm. This is the exhaustiveness guard —
      // adding a kind fails to compile here until someone decides what it should say.
      const unhandled: never = input.captionKind;
      void unhandled;
      return null;
    }
  }
}
