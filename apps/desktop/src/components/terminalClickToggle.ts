// Click-in-the-terminal → toggle the composer minimize state (a third trigger alongside ⌘J and
// the drag handle). The terminal floats the composer over its bottom edge, so a plain click that
// minimizes the composer uncovers the lines it was hiding (e.g. Claude's "Do you want to proceed?
// / 1. Yes" menu); a plain click while minimized restores it. This module owns the pure question
// "was that pointer gesture a plain click, or something else?" — the caller (Terminal.tsx) supplies
// the down/up points and whether xterm ended up with a selection, and acts on the answer.

// Max pointer travel between mousedown and mouseup for the gesture to still count as a click rather
// than a drag. A little slop absorbs the few pixels a normal click jitters; anything past this is a
// deliberate drag (text selection, or a drag that selected nothing) and must NOT toggle.
export const CLICK_MOVE_TOLERANCE_PX = 4;

export interface ClickPoint {
  x: number;
  y: number;
}

/**
 * True when a pointer gesture in the terminal body should toggle the composer.
 *
 * A gesture toggles only when it is a genuine stationary left-click:
 *  - it was the primary (left) button,
 *  - the pointer did not travel more than CLICK_MOVE_TOLERANCE_PX between down and up (not a drag),
 *  - it did not produce a text selection (a drag-select copies instead; toggling on top of that
 *    would fight normal select-to-copy),
 *  - and the child program is NOT tracking the mouse. A full-screen TUI that enabled xterm mouse
 *    reporting (SM/DECSET) owns its clicks — they're delivered to the PTY as interactions — so
 *    stealing that click to flip the composer would fight the app. (Claude's plain number/arrow
 *    menus don't enable mouse tracking, so the feature's target case is unaffected.)
 *
 * @param button       the mouseup event's `button` (0 = left/primary)
 * @param down         the mousedown point (client coords)
 * @param up           the mouseup point (client coords)
 * @param hasSelection whether xterm has a non-empty selection at mouseup
 * @param mouseTracking whether the child program has mouse reporting enabled (xterm
 *                      `modes.mouseTrackingMode !== "none"`)
 */
export function shouldToggleComposerOnClick(
  button: number,
  down: ClickPoint,
  up: ClickPoint,
  hasSelection: boolean,
  mouseTracking: boolean,
): boolean {
  if (button !== 0) return false;
  if (hasSelection) return false;
  if (mouseTracking) return false;
  const moved =
    Math.abs(up.x - down.x) > CLICK_MOVE_TOLERANCE_PX ||
    Math.abs(up.y - down.y) > CLICK_MOVE_TOLERANCE_PX;
  return !moved;
}
