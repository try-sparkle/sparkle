// Recovery for a lost xterm WebGL renderer context.
//
// The WebGL renderer's GPU context can be dropped by the OS/driver (app backgrounded,
// GPU memory pressure, a display change). xterm's WebGL addon fires onContextLoss when it
// can't get the context back. We then dispose the addon so the default DOM renderer takes
// over, clear the caller's ref (so a later re-theme doesn't call clearTextureAtlas on a
// disposed addon), and force a full repaint.
//
// The repaint is the important part: disposing swaps the active renderer but doesn't paint
// a frame, so without it the screen stays blank or stale until the next PTY write. Session
// logs showed this firing several times per day, so a dropped context shouldn't leave the
// user staring at a blank terminal.

// Structural subsets of the xterm types so this stays trivially unit-testable.
type DisposableAddon = { dispose: () => void };
type RefreshableTerm = { refresh: (start: number, end: number) => void; rows: number };
type AtlasClearableAddon = { clearTextureAtlas: () => void };

// Force a FULL, unconditional repaint of the terminal viewport.
//
// THIS IS THE FIX FOR THE RECURRING "top half of the terminal is blank until I scroll" bug.
// `term.refresh(start, end)` only marks rows dirty and schedules a render; the WebGL renderer
// then SKIPS any cell whose code/fg/bg/ext equals its per-cell model cache
// (WebglRenderer._updateModel — `if (cells match) continue`). Cells written while the canvas
// was display:none / 0-sized (a backgrounded pane) get stamped into that cache as "drawn" even
// though nothing reached the GPU, so every later `refresh()` is a no-op for them — they stay
// blank until a SCROLL changes their content and it finally differs from the cache. That is why
// three prior fixes that all called `term.refresh()` never stuck: refresh() is structurally
// incapable of repainting cache-poisoned cells.
//
// `clearTextureAtlas()` wipes the renderer's model + glyph atlas, so every non-empty cell then
// differs from the (now-empty) cache and is genuinely redrawn — the ONLY reliable way to defeat
// the cache. We follow with refresh() (mirrors the theme-toggle path that already works). When
// there is no WebGL renderer (DOM-renderer fallback, which has no such cache) a bare refresh()
// is sufficient.
export function forceFullRepaint(
  webgl: AtlasClearableAddon | null,
  term: RefreshableTerm | null,
): void {
  if (!term) return;
  try {
    // Order matters: clear the model FIRST so the following refresh isn't skipped by the cache.
    webgl?.clearTextureAtlas();
    term.refresh(0, term.rows - 1);
  } catch {
    /* terminal/addon torn down — nothing to repaint */
  }
}

// Decide how the debounced output-settle (and the ResizeObserver) should repaint, given whether
// output is cache-poisoned (written while the pane couldn't paint — see Terminal's poisonedRef)
// and whether the pane can paint right now. The expensive full repaint (forceFullRepaint, which
// clears the WebGL model so poisoned cells redraw) runs ONCE per poisoning episode: only when
// poisoned AND paintable, and it clears the flag. Otherwise the cheap refresh() runs and the flag
// is preserved (so a later paintable settle/resize still drains it). Pure + tested so the
// "repaint once per episode" guarantee can't be silently refactored away.
export function settleRepaintPlan(
  poisoned: boolean,
  paintable: boolean,
): { action: "full" | "refresh"; poisoned: boolean } {
  if (poisoned && paintable) return { action: "full", poisoned: false };
  return { action: "refresh", poisoned };
}

export function recoverFromWebglContextLoss(
  webgl: DisposableAddon,
  term: RefreshableTerm | null,
  onDisposed: () => void,
): void {
  webgl.dispose();
  onDisposed();
  try {
    term?.refresh(0, term.rows - 1);
  } catch {
    /* terminal already torn down — nothing to repaint */
  }
}
