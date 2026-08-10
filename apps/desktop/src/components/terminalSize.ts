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

// …but an ABSOLUTE floor cannot catch a fit that is merely WRONG. Measured case (bead
// sparkle-l2xgf): a pane mounting during the boot-restore storm fitted to cols=23 in a box that
// held ~43, and 23 clears the floor of 20 — so it was spawned to the child as if it were real and
// the CLI hard-wrapped every line mid-phrase for the rest of the session. Worse, it LATCHES: once
// `term.cols` is 23, every later fit() recomputes 23, `syncPtySize`'s memo sees no change, and the
// ResizeObserver / become-active / zoom paths that exist to heal this all no-op forever.
//
// The relative test that catches it: A MONOSPACE CELL IS NEVER AS WIDE AS ITS OWN FONT-SIZE. Every
// monospace face in the stack ships an advance of ~0.5–0.6em (Source Code Pro and Menlo are both
// 0.6em); none approaches 1.0em. So `containerWidth / cols > fontSize` is not a narrow pane — it is
// arithmetic that cannot describe a real monospace grid, and the fit that produced it was measured
// against stale or pre-layout metrics. Zoom-proof and font-agnostic, because both sides scale
// together: the founder's bad frame implies 304/23 ≈ 13.2px cells at an ~11px font (1.15em,
// impossible); the healthy one implies ~7px at the same font (0.6em).
export const MAX_CELL_EM = 1.0;

export interface TermSize {
  cols: number;
  rows: number;
}

/**
 * The container the fit was measured against. Optional everywhere it is accepted: when it is
 * absent (or unmeasurable) the relative check FAILS OPEN and the absolute floors above remain the
 * only gate — losing the new guard must never cost the old one.
 */
export interface FitContext {
  containerWidth: number;
  fontSize: number;
}

/** Width one cell would have to be for `cols` to fit `containerWidth`. Null when unknowable. */
export function impliedCellWidth(containerWidth: number, cols: number): number | null {
  if (!(containerWidth > 0) || !(cols > 0)) return null;
  return containerWidth / cols;
}

/**
 * Whether a fitted size is CONSISTENT WITH THE BOX IT WAS MEASURED FROM — the relative half of the
 * guard. Fails open (returns true) when the context can't answer, so this can only ever reject
 * sizes the absolute floors would have let through, never accept ones they reject.
 */
export function isPlausibleFit(size: TermSize, ctx?: FitContext): boolean {
  if (!ctx || !(ctx.fontSize > 0)) return true;
  const cell = impliedCellWidth(ctx.containerWidth, size.cols);
  if (cell === null) return true;
  return cell <= ctx.fontSize * MAX_CELL_EM;
}

/**
 * The loud half of the guard the founder asked for: a one-line diagnosis with the numbers that
 * produced it, or null when the fit is fine. Returned rather than logged so it is testable and so
 * the caller decides the channel — a silent regression here is what cost a whole session.
 */
export function implausibleFitWarning(size: TermSize, ctx?: FitContext): string | null {
  if (isPlausibleFit(size, ctx) || !ctx) return null;
  const cell = impliedCellWidth(ctx.containerWidth, size.cols);
  const fits = cell === null ? "?" : String(Math.floor(ctx.containerWidth / (ctx.fontSize * 0.6)));
  return (
    `terminal fit is implausible: cols=${size.cols} implies a ${cell?.toFixed(1)}px cell ` +
    `at fontSize=${ctx.fontSize}px (>${MAX_CELL_EM}em — no monospace is that wide). ` +
    `Container is ${ctx.containerWidth}px, which should fit ~${fits} cols. ` +
    `Measured against stale/pre-layout metrics — refusing it so the CLI can't hard-wrap.`
  );
}

/**
 * Whether a fitted size came from a real, laid-out container (so it's safe to hand to the PTY),
 * rather than a display:none / pre-layout pane that fit() collapsed to a tiny box.
 */
export function isMeasuredSize(laidOut: boolean, size: TermSize, ctx?: FitContext): boolean {
  return (
    laidOut &&
    size.cols >= MIN_PLAUSIBLE_COLS &&
    size.rows >= MIN_PLAUSIBLE_ROWS &&
    // The relative half. Both are required: the floor catches a COLLAPSED box (cols≈12), this
    // catches a MISMEASURED one (cols=23 in a box that holds 43), and neither sees the other's case.
    isPlausibleFit(size, ctx)
  );
}

/**
 * The size to SPAWN a PTY with: the measured fit when it's trustworthy, else safe defaults so a
 * CLI never starts life wrapping into a thin column. The real size is synced once the container
 * is laid out (post-spawn re-sync, ResizeObserver, and the become-active effect).
 */
export function spawnSize(laidOut: boolean, size: TermSize, ctx?: FitContext): TermSize {
  return isMeasuredSize(laidOut, size, ctx)
    ? { cols: size.cols, rows: size.rows }
    : { cols: SPAWN_FALLBACK_COLS, rows: SPAWN_FALLBACK_ROWS };
}
