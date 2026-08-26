// What the system tray says about the overlay — bead sparkle-uz87.9.
//
// The tray icon is the ONLY part of this feature a user can see when the overlay itself is
// invisible, so it is the only honest answer to "is this thing listening to me right now". That
// makes it a privacy surface, not decoration, and it earns two rules:
//
//   1. IT MAY NEVER OVERSTATE. `listening` is the one status that claims a live microphone, and it
//      is reachable ONLY from a session that is actually awake and un-muted. Everything uncertain
//      resolves DOWNWARD. This repo has shipped the opposite — nine minutes of every mic surface
//      cheerfully rendering "listening" while zero audio was captured (`services/audioInputs.ts`) —
//      and the lesson written down from it is that an optimistic status is worse than none.
//   2. DISABLED AND MUTED ARE DIFFERENT FACTS. "The feature is off" and "you switched the mic off"
//      look identical in an icon that has only on/off, and collapsing them is how a user concludes
//      they muted something that was never running.
import type { SessionSnapshot } from "../sparkleSession";

/**
 * `disabled` — the overlay feature is not enabled in this build at all.
 * `muted`    — enabled, but the user turned the wake word off. Nothing is being heard.
 * `idle`     — armed and asleep: listening ONLY for the wake phrase.
 * `listening`— awake and capturing what you say.
 * `working`  — the utterance closed; thinking or answering. No live capture.
 * `error`    — the last exchange failed.
 */
export type TrayStatus =
  | "disabled"
  | "muted"
  | "idle"
  | "listening"
  | "working"
  | "error";

export interface TrayInputs {
  /** The build-level feature flag. False means the overlay cannot run at all. */
  enabled: boolean;
  /** Null when no session has been created yet — which is NOT the same as idle. */
  snapshot: SessionSnapshot | null;
  /** Set when the most recent exchange failed; cleared by the next successful wake. */
  lastErrored?: boolean;
}

/**
 * Derive the tray status. Ordered by AUTHORITY, not by likelihood: each early return is a fact
 * that outranks everything below it, so no later branch can talk a disabled or muted overlay back
 * into claiming it is listening.
 */
export function deriveTrayStatus(i: TrayInputs): TrayStatus {
  // The feature flag outranks everything: a disabled overlay has no session and no opinion.
  if (!i.enabled) return "disabled";
  // Mute outranks the session state, and deliberately outranks `error` too — a muted mic is the
  // more important thing to say, and an error the user can no longer trigger is stale news.
  if (i.snapshot?.muted) return "muted";
  if (i.lastErrored) return "error";
  // No session yet: armed in principle, hearing nothing in fact. Never "listening".
  if (!i.snapshot) return "idle";

  switch (i.snapshot.state) {
    case "idle":
      return "idle";
    case "listening":
      return "listening";
    case "processing":
    case "responding":
      // Both are post-utterance. The mic is not capturing, so neither may render as listening.
      return "working";
    default: {
      const _exhaustive: never = i.snapshot.state;
      return _exhaustive;
    }
  }
}

/** The tooltip. Says what is true in words, because an icon alone cannot carry the distinction. */
export function trayTooltip(status: TrayStatus): string {
  switch (status) {
    case "disabled":
      return "Sparkle overlay: off";
    case "muted":
      return "Sparkle overlay: muted — the wake word is off and nothing is being heard";
    case "idle":
      return "Sparkle overlay: waiting for the wake word";
    case "listening":
      return "Sparkle overlay: listening to you now";
    case "working":
      return "Sparkle overlay: thinking";
    case "error":
      return "Sparkle overlay: the last request failed";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Whether this status means a microphone is actively capturing the user's speech. */
export function isCapturing(status: TrayStatus): boolean {
  return status === "listening";
}
