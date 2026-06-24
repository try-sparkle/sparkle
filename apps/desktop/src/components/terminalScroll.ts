// Pure conversion of a wheel event into whole scrollback lines. Extracted from
// <Terminal> so it can be unit-tested without xterm/DOM.
//
// Why we need this: the PTY runs with TERM=xterm-256color, so agent CLIs enable
// mouse tracking. xterm.js then hands the wheel to the app instead of scrolling
// its own scrollback — which broke "scroll up through terminal output". On the
// NORMAL buffer (where scrollback lives) we take the wheel back and scroll xterm
// ourselves; this mirrors xterm's native pixel→line math so trackpad scrolling
// feels the same. The sub-line `carry` is threaded across events so small
// pixel-deltas accumulate instead of being rounded away to zero.
export interface WheelLike {
  deltaY: number;
  // DOM_DELTA_PIXEL = 0, DOM_DELTA_LINE = 1, DOM_DELTA_PAGE = 2
  deltaMode: number;
}

export function wheelToScrollLines(
  e: WheelLike,
  cellHeight: number,
  rows: number,
  carry: number,
): { lines: number; carry: number } {
  // Guard against a not-yet-measured cell height; ~17px is a sane default at 13px.
  const cell = cellHeight > 0 ? cellHeight : 17;
  const pixels =
    e.deltaMode === 1
      ? e.deltaY * cell // delta given in lines
      : e.deltaMode === 2
        ? e.deltaY * cell * rows // delta given in pages
        : e.deltaY; // delta already in pixels
  const total = carry + pixels;
  const lines = Math.trunc(total / cell);
  return { lines, carry: total - lines * cell };
}
