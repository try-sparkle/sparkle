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
}
