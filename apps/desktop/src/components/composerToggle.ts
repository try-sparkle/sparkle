// Composer⇄terminal focus toggle: a thin semantic wrapper over the configurable shortcut matcher.
// The binding (default ⌘J) is supplied by the caller from the keybindings store, so both the
// composer textarea and the terminal recognize the SAME, user-rebindable shortcut. ⌘J in the
// composer minimizes it and drops focus to the terminal (to answer a Claude menu); ⌘J in the
// terminal restores the composer and focuses it. (Terminals send Ctrl+J as LF — the default
// Cmd+J is never forwarded to the PTY.)
import { matchesChord, type KeyBinding, type KeyEventLike } from "../keyboardHints/keybindings";

export type ToggleKeyEvent = KeyEventLike;

/** True when this keystroke is the configured composer⇄terminal toggle (a chord binding). */
export function isComposerToggleKey(e: ToggleKeyEvent, binding: KeyBinding): boolean {
  return matchesChord(e, binding);
}
