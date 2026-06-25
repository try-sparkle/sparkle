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
