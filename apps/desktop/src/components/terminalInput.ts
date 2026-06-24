// Pure decision for the terminal's key handling: should a keystroke be redirected to the
// composer instead of reaching the PTY? Extracted from <Terminal> so it can be unit-tested
// without standing up xterm/DOM.
//
// Rule: a bare printable character at a NORMAL shell prompt is prompt-typing → send it to
// the composer. In the ALTERNATE screen (full-screen TUIs — pagers, editors, and Claude's
// own menus) every keystroke must reach the program, so y/n, number picks, and incremental
// search keep working. Modifier combos (Cmd+C copy/paste, shortcuts) and non-printable keys
// (arrows, Enter, Tab, Esc, …) always stay in the terminal.
export interface TermKeyEvent {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export function shouldRouteToComposer(
  e: TermKeyEvent,
  bufferType: "normal" | "alternate",
): boolean {
  if (e.type !== "keydown") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return e.key.length === 1 && bufferType === "normal";
}
