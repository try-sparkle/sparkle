/**
 * The bytes a vertical arrow sends to the PTY, honoring DECCKM (application cursor keys). When an
 * app puts the terminal in application-cursor-keys mode it expects the SS3 introducer (`ESC O`)
 * instead of CSI (`ESC [`); sending the wrong one means full-screen TUIs that request DECCKM
 * wouldn't see the arrow. This mirrors exactly what xterm itself emits for a real keypress.
 */
export function arrowKeySequence(dir: "up" | "down", applicationCursorKeys: boolean): string {
  if (dir === "up") return applicationCursorKeys ? "\x1bOA" : "\x1b[A";
  return applicationCursorKeys ? "\x1bOB" : "\x1b[B";
}
