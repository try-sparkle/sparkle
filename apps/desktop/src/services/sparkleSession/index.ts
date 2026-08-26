// Public surface of the Living Sparkle Overlay session (bead sparkle-uz87.7).
//
// THE CONSUMER IS sparkle-uz87.9 — "Package, auto-launch, and system tray integration". The tray
// needs to paint overlay status (active / muted / error), and `getState()` plus the muted flag on
// the snapshot are what it should read; it must not reach past this into the machine or the
// controller.
//
// What a caller can rely on:
//   • `feed(chunk)` is safe to call on every transcript chunk forever — while asleep it only
//     drives wake-word detection, and while muted it does nothing at all.
//   • The overlay is never left mid-cycle: an error or a dismiss always lands it back at the
//     perch, motionless.
//   • Nothing here speaks. Text-to-speech was removed from this product (commit f24324e6b); the
//     overlay's `speaking` mode is a VISUAL state.
export {
  createSparkleSession,
  defaultSessionDeps,
  type SparkleSession,
  type SparkleSessionDeps,
} from "./session";
export {
  transition,
  INITIAL_SNAPSHOT,
  type ControllerIntent,
  type SessionEvent,
  type SessionSnapshot,
  type SessionState,
  type TransitionResult,
} from "./machine";
