// Pure decision for the composer's grab-handle drag: given how far the handle moved,
// what open height should the composer take, and should it collapse to the minimized
// (terminal-exposed) state? Extracted from <Composer> so the snap/minimize geometry can
// be unit-tested without standing up the DOM (same pattern the terminal used).
//
// Model: the composer is a bottom overlay that, at rest, COVERS Claude's terminal input
// line — that's how we steer typing into the box. Dragging the handle UP grows it for
// multi-line prompts; dragging it DOWN past the floor MINIMIZES it to a slim restore bar,
// exposing the terminal so the user can answer Claude's menus directly. A snap magnet
// around the cover height helps the user land back on the right size.

export interface ComposerDragInput {
  // The height on screen when the drag began — used as the live-tracking base so the handle
  // follows the cursor from the first pixel (may be auto-expanded above the persisted floor).
  startHeight: number;
  // Whether the composer was minimized when the drag began.
  startMinimized: boolean;
  // Pixels the handle has moved UP from its drag start (startY - currentY). Positive = up.
  dy: number;
  // The persisted open height to REMEMBER when minimizing — distinct from startHeight so a
  // transient auto-expanded draft height never leaks into the stored floor. Defaults to
  // startHeight when omitted.
  floor?: number;
}

export interface ComposerDragOpts {
  snap: number; // the "covers the terminal input" rest height
  min: number; // floor for the open height
  max: number; // ceiling (viewport-dependent)
  snapThreshold: number; // magnetic range around `snap`
  minimizeThreshold: number; // raw height at/below which a downward drag minimizes
  restoreThreshold: number; // upward drag distance needed to restore from minimized
}

export interface ComposerDragResult {
  minimized: boolean;
  // The open height to persist. When minimizing we keep the prior open height so a later
  // restore returns to the size the user last chose.
  height: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Snap to `snap` when the proposed height lands within the magnet range.
function withSnap(h: number, o: ComposerDragOpts): number {
  return Math.abs(h - o.snap) <= o.snapThreshold ? o.snap : h;
}

export function resolveComposerDrag(
  input: ComposerDragInput,
  o: ComposerDragOpts,
): ComposerDragResult {
  // The height to keep as the restore target when minimizing — the persisted floor, never the
  // transient tracking height, so an auto-expanded draft doesn't permanently grow the composer.
  const remembered = input.floor ?? input.startHeight;
  if (input.startMinimized) {
    // Collapsed bar sits at ~0 open height; the upward drag distance IS the proposed height.
    if (input.dy < o.restoreThreshold) {
      return { minimized: true, height: remembered };
    }
    return { minimized: false, height: withSnap(clamp(input.dy, o.min, o.max), o) };
  }

  const raw = input.startHeight + input.dy;
  // Dragged down far enough to tuck the composer away → minimize, remember the floor.
  if (raw <= o.minimizeThreshold) {
    return { minimized: true, height: remembered };
  }
  return { minimized: false, height: withSnap(clamp(raw, o.min, o.max), o) };
}

// Should releasing the handle bring the composer back from the minimized bar? Used by the
// pointer-UP handler so a click — or any upward tug the snap math intentionally left minimized
// (the sub-threshold dead-zone) — restores, while a downward tug (abort) does not. Restore
// returns to the REMEMBERED open height (already in the store), so this only flips the flag.
export function shouldRestoreFromBar(p: {
  startMinimized: boolean; // did the drag begin on the minimized bar?
  dy: number; // pixels moved up (startY - currentY); ≥ 0 = up or click
  stillMinimized: boolean; // is it still minimized after the drag's live updates?
}): boolean {
  return p.startMinimized && p.dy >= 0 && p.stillMinimized;
}
