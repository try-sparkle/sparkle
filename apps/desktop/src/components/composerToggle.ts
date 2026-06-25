// Pure decision: is this keystroke the composer⇄terminal focus toggle (⌘J)? Shared by the
// composer textarea and the terminal so both surfaces recognize the same shortcut. ⌘J in the
// composer minimizes it and drops focus to the terminal (to answer a Claude menu); ⌘J in the
// terminal restores the composer and focuses it. Ctrl/Alt are excluded so app/terminal combos
// stay free. (Terminals send Ctrl+J as LF — Cmd+J is never forwarded to the PTY.)
export interface ToggleKeyEvent {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export function isComposerToggleKey(e: ToggleKeyEvent): boolean {
  if (e.type !== "keydown") return false;
  if (!e.metaKey || e.ctrlKey || e.altKey) return false;
  return e.key.toLowerCase() === "j";
}
