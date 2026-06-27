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

export interface ComposerHeightInput {
  // The persisted height the user last chose by dragging (or the default rest height).
  height: number;
  // The measured height that would show the whole draft without scrolling (chrome + content).
  desired: number;
  // Has the user taken manual control by dragging the handle to a real size? When true the
  // composer is pinned to `height` and the textarea scrolls if the draft overflows — this is
  // what lets the composer be dragged SHORTER than its content. When false the composer
  // auto-grows from the rest height to fit the draft (the out-of-the-box behavior for quick
  // messages that haven't been hand-sized).
  userSized: boolean;
  min: number; // open-height floor
  cap: number; // viewport-dependent ceiling (maxComposerHeight)
}

// Resolve the composer's actual rendered height. Two modes:
//  • userSized → honor the dragged height exactly, clamped to [min, cap]; the textarea scrolls
//    when the draft is taller. This is what makes the handle able to size the composer DOWN,
//    not just up: content no longer forces the box open.
//  • auto-grow → fit-to-content exactly, clamped to [min, cap]. The box hugs the draft: a short
//    draft sits tight (no empty space below — NOT floored at the rest height), a long draft pushes
//    taller up to the cap then scrolls, and after a send the now-empty draft collapses back to min.
// Kept pure (no DOM) so the height policy is unit-tested alongside the drag geometry.
export function resolveComposerRenderHeight(p: ComposerHeightInput): number {
  if (p.userSized) return clamp(p.height, p.min, p.cap);
  return clamp(Math.min(p.cap, p.desired), p.min, p.cap);
}

// Should the composer snap back to its rest height (and drop manual sizing)? Called at the
// two moments a fresh draft begins: right after a send, and when a brand-new thread's composer
// mounts. Returns the size state to apply, or null to leave the composer untouched.
//
// The ONE exception is a fully minimized composer: that's a deliberate "keep it tucked away"
// choice (the terminal is exposed to answer Claude's menus), so we never disturb it — the
// reset is skipped and the minimized bar stays put. For an open composer we return the rest
// height with userSized cleared, so the box returns to its compact default and auto-grows to
// fit the next message instead of staying stuck at a previously dragged (or auto-expanded) size.
export function resolveComposerReset(p: {
  minimized: boolean; // is the composer currently tucked into its slim bar?
  rest: number; // the rest/default open height to snap back to (COMPOSER_DEFAULT)
}): { height: number; userSized: boolean } | null {
  if (p.minimized) return null;
  return { height: p.rest, userSized: false };
}

// The composer's height floor. Normally the base open-height minimum, but attachment thumbnails
// (screenshot previews) sit in a fixed-height row ABOVE the textarea in the input column, eating
// vertical space. In user-sized mode the composer is pinned to the dragged height regardless of
// content, so without lifting the floor those thumbs squeeze the textarea to an unusable sliver
// (the reported bug). When attachments are present, raise the floor to the measured chrome
// (`overhead`, which already includes the thumb row) plus one usable line of textarea. Kept pure
// (no DOM) so it's unit-tested alongside the rest of the height policy.
export function resolveComposerFloor(p: {
  baseMin: number;
  overhead: number;
  minTextarea: number;
  hasAttachments: boolean;
}): number {
  if (!p.hasAttachments) return p.baseMin;
  return Math.max(p.baseMin, p.overhead + p.minTextarea);
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
