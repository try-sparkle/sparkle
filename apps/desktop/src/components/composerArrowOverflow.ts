// The slice of a keydown the overflow decision needs — kept to plain fields (not a DOM event)
// so it's trivially testable and free of React/jsdom coupling.
export interface ArrowOverflowInput {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  // True mid-IME composition (e.target's value isn't committed yet) — never hand off then.
  isComposing: boolean;
  // True while a ghost autocomplete suffix is showing. The user is actively composing against a
  // suggestion, so keep focus in the box — don't yank a vertical arrow off to the terminal. (The
  // primary "answer a menu" case is an empty composer, which never has a ghost, so this costs it
  // nothing.) The ghost itself only binds →/Tab/Esc, never the vertical arrows.
  ghostActive: boolean;
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Decide whether a vertical-arrow press in the composer runs off the edge of the text and should
 * cross into the terminal. Returns the handoff direction, or null to leave the key to the
 * textarea (move the caret a line within the text).
 *
 * Down overflows off the last logical line; Up off the first — so a one-line (or empty) composer
 * hands off in either direction immediately, while multi-line editing in the middle stays native.
 * Only a plain arrow with a collapsed caret qualifies: Shift extends a selection, ⌘/Ctrl/Alt are
 * different gestures, and an active selection or in-flight IME composition each give the arrow its
 * own native meaning.
 *
 * Edges are measured on logical lines (newlines in the value), not wrapped visual rows. The
 * composer is short and rarely soft-wraps, so logical lines track what's on screen; the tradeoff
 * is that a long, wrapped single line would hand off from any caret position rather than walking
 * the visual rows first — an acceptable edge for this box.
 */
export function arrowOverflowDirection(e: ArrowOverflowInput): "up" | "down" | null {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return null;
  if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.ghostActive)
    return null;
  if (e.selectionStart !== e.selectionEnd) return null;
  const caret = e.selectionStart;
  if (e.key === "ArrowDown" && !e.value.slice(caret).includes("\n")) return "down";
  if (e.key === "ArrowUp" && !e.value.slice(0, caret).includes("\n")) return "up";
  return null;
}

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
