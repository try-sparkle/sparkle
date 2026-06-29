// Pure decision: is this keystroke the "copy the terminal selection" chord (⌘C)? xterm paints its
// selection on a canvas/WebGL layer, not as a native DOM selection, so the OS's own Cmd+C finds
// nothing and just beeps — the terminal has to copy the selection itself on this chord. Ctrl is
// excluded on purpose: Ctrl+C must keep reaching the PTY as SIGINT, never get swallowed as a copy.
// Alt is excluded too so app/terminal combos stay free. Only the keydown counts (the keyup repeat
// of the chord shouldn't re-copy).
export interface CopyKeyEvent {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  // True on the synthetic keydowns OS key-repeat fires while ⌘C is held. We ignore those so a
  // held chord doesn't re-issue the same clipboard write over and over (roborev 15546).
  repeat: boolean;
}

export function isCopySelectionKey(e: CopyKeyEvent): boolean {
  if (e.type !== "keydown" || e.repeat) return false;
  if (!e.metaKey || e.ctrlKey || e.altKey) return false;
  return e.key.toLowerCase() === "c";
}
