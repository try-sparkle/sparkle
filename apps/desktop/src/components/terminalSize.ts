// PTY sizing guard. A Terminal can mount while its pane is display:none (a backgrounded agent
// at app launch, or a non-active tab) — xterm's FitAddon then measures a collapsed 0×0 container
// and proposes a tiny size (cols≈12 has been seen in the logs). If the PTY is spawned (or
// resized) to that size, the agent CLI HARD-WRAPS its output into a thin column; because the
// wraps are baked into the emitted bytes, a later resize can't un-wrap them — only a full CLI
// redraw (e.g. the next submitted prompt) recovers. So we refuse any size from an unmeasured
// container: spawn at safe defaults and only push a fit to the PTY once it's genuinely laid out.

// Matches the backend spawn defaults in pty.ts (and src-tauri/src/pty.rs).
export const SPAWN_FALLBACK_COLS = 120;
export const SPAWN_FALLBACK_ROWS = 30;

// A fit below this is an unmeasured/collapsed container, not a genuinely tiny pane.
export const MIN_PLAUSIBLE_COLS = 20;
export const MIN_PLAUSIBLE_ROWS = 5;

export interface TermSize {
  cols: number;
  rows: number;
}

/**
 * Whether a fitted size came from a real, laid-out container (so it's safe to hand to the PTY),
 * rather than a display:none / pre-layout pane that fit() collapsed to a tiny box.
 */
export function isMeasuredSize(laidOut: boolean, size: TermSize): boolean {
  return laidOut && size.cols >= MIN_PLAUSIBLE_COLS && size.rows >= MIN_PLAUSIBLE_ROWS;
}

/**
 * The size to SPAWN a PTY with: the measured fit when it's trustworthy, else safe defaults so a
 * CLI never starts life wrapping into a thin column. The real size is synced once the container
 * is laid out (post-spawn re-sync, ResizeObserver, and the become-active effect).
 */
export function spawnSize(laidOut: boolean, size: TermSize): TermSize {
  return isMeasuredSize(laidOut, size)
    ? { cols: size.cols, rows: size.rows }
    : { cols: SPAWN_FALLBACK_COLS, rows: SPAWN_FALLBACK_ROWS };
}
