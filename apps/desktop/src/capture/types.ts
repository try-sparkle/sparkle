// Cross-worker contract types for the menu-bar capture flow — the single source of truth
// (docs/superpowers/plans/2026-07-01-menubar-capture.md "Cross-worker contracts"). Tasks 4-6
// import these; do not rename fields.

export interface CaptureAttachment { path: string; dataUrl: string }
/** Wire shape of the `capture://shot` event (Rust `CaptureShot` in capture_window.rs,
 *  serde camelCase). Same fields as CaptureAttachment, kept as a distinct name so the
 *  Rust↔frontend contract is greppable. */
export interface CaptureShot { path: string; dataUrl: string }
/** The capture takeover's two destinations.
 *
 *  "chat" REPLACED "plan". Plan ran a whole pipeline off a screenshot — copy the asset, synthesize
 *  a PRD through Chief, decompose it into beads — which meant the capture window's second button
 *  could only work for a project with Chief configured, and silently threw for everyone else. Chat
 *  does what the button was actually being used for: it puts the shot and the narration in the
 *  Sparkle concierge's compose box as a draft. See `normalizeCaptureMode` for the migration. */
export type CaptureSendMode = "chat" | "build";

/** Read a mode off the wire, tolerating the RETIRED "plan" value.
 *
 *  Nothing persists a capture mode, so this is not a settings migration — it is an IN-FLIGHT one.
 *  `capture://send` is a broadcast between webviews that are updated together on a relaunch but NOT
 *  necessarily mid-session (the capture window is long-lived and holds its own React root), so a
 *  payload emitted by a pre-upgrade capture window can reach a post-upgrade project window. Without
 *  this the switch in handleCaptureSend would match nothing and the send would vanish exactly the
 *  way the bug this branch fixes did. "plan" → "chat" is the honest mapping: it is the button in
 *  the same slot, and it is the reversible direction — nothing is dispatched, the user still has to
 *  press Enter. Anything unrecognized also lands on "chat" for that reason. */
export function normalizeCaptureMode(mode: string): CaptureSendMode {
  return mode === "build" ? "build" : "chat";
}

export interface CaptureSendPayload {
  mode: CaptureSendMode;
  projectId: string;
  text: string;                       // narration transcript / typed text
  attachments: CaptureAttachment[];   // length 1 in v1
  // Build-only routing (mode === "build"), set by the Build options menu in CaptureApp. Ignored
  // for chat. `forceNewAgent` wins over `targetAgentId`: it makes dispatchBuild ALWAYS spawn
  // a fresh build agent instead of reusing an existing one ("New build agent"). `targetAgentId`
  // routes the capture into that EXACT existing build agent (an entry the user picked from the
  // menu) rather than dispatchBuild's default first-build-agent auto-reuse. Neither set → the
  // legacy reuse-or-create fallback.
  forceNewAgent?: boolean;
  targetAgentId?: string;
}
