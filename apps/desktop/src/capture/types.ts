// Cross-worker contract types for the menu-bar capture flow — the single source of truth
// (docs/superpowers/plans/2026-07-01-menubar-capture.md "Cross-worker contracts"). Tasks 4-6
// import these; do not rename fields.

export interface CaptureAttachment { path: string; dataUrl: string }
/** Wire shape of the `capture://shot` event (Rust `CaptureShot` in capture_window.rs,
 *  serde camelCase). Same fields as CaptureAttachment, kept as a distinct name so the
 *  Rust↔frontend contract is greppable. */
export interface CaptureShot { path: string; dataUrl: string }
export type CaptureSendMode = "think" | "plan" | "build";
export interface CaptureSendPayload {
  mode: CaptureSendMode;
  projectId: string;
  text: string;                       // narration transcript / typed text
  attachments: CaptureAttachment[];   // length 1 in v1
  // Build-only routing (mode === "build"), set by the Build options menu in CaptureApp. Ignored
  // for think/plan. `forceNewAgent` wins over `targetAgentId`: it makes dispatchBuild ALWAYS spawn
  // a fresh build agent instead of reusing an existing one ("New build agent"). `targetAgentId`
  // routes the capture into that EXACT existing build agent (an entry the user picked from the
  // menu) rather than dispatchBuild's default first-build-agent auto-reuse. Neither set → the
  // legacy reuse-or-create fallback.
  forceNewAgent?: boolean;
  targetAgentId?: string;
}
