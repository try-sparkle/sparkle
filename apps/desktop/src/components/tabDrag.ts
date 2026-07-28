// Pure decision for dragging a project tab: is this a reorder inside the strip, or has the tab been
// pulled out far enough to become its own satellite window? Extracted from <ProjectTabs> for the
// same reason composerDrag.ts was extracted from <Composer> — the geometry is the part that breaks,
// and this repo has no E2E harness (no Playwright, no tauri-driver), so a real cursor drag across a
// monitor boundary cannot be automated. Everything decidable without a webview lives here.
//
// COORDINATE SPACE: every input is in Tauri's global LOGICAL screen space — the same space
// helper/helperGeometry.ts works in, and the space `PointerEvent.screenX/screenY` reports. A
// secondary display has a non-zero (often negative) origin, so nothing here may assume a screen
// starts at (0,0). Callers converting from Tauri's monitor API must divide by `scaleFactor` first
// (HelperApp.tsx's `toRect` is the one converter — reuse it rather than reimplementing).
//
// THE SLOP GATE LATCHES — see `TabDragInput.dragging`. The resolver is pure, so it cannot remember
// that a drag already started; the caller carries that one bit. Without it the gate is re-evaluated
// against the press origin every frame, and a drag that wanders back over its own press point falls
// out of `reorder`/`tearoff` into `idle` — the drag ghost vanishes and the release reads as a plain
// click. This is the same frame-to-frame instability `outside`'s inclusive boundary exists to
// prevent, one gate over. `HelperApp.tsx:384` is the repo idiom: set the flag once, never clear it.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rendered tab's horizontal extent. Vertical extent is the strip's, so it isn't repeated. */
export interface TabRect {
  id: string;
  x: number;
  width: number;
}

export interface TabDragInput {
  /** Where the pointer is now. */
  pointer: { x: number; y: number };
  /** Where the press began — the slop is measured from here, not from the tab's own position. */
  origin: { x: number; y: number };
  /** The tab strip's rect. */
  strip: Rect;
  /** Every rendered tab, in render order (which IS projectStore order — see engine/openProjects). */
  tabs: readonly TabRect[];
  /** The tab under the press. */
  draggedId: string;
  /** Has this gesture already cleared the slop and become a drag? Required, not optional, because
   *  a caller that forgets it inherits the flicker described in the module header — and there is no
   *  safe default to fall back on. Latch it to true on the first non-idle result and leave it set
   *  for the rest of the gesture; reset only on pointer-up/cancel. */
  dragging: boolean;
}

export interface TabDragOpts {
  /** Movement below this on both axes is not yet a drag, so a sloppy click still selects a tab. */
  slop: number;
  /** How far outside the strip the pointer may stray before the drag becomes a tear-off. */
  tearMargin: number;
}

export type TabDragResult =
  /** The press hasn't travelled far enough to mean anything yet. */
  | { kind: "idle" }
  /** Still in the strip. `beforeId` is the tab to insert before; null means append at the end. */
  | { kind: "reorder"; beforeId: string | null }
  /** Left the strip — release here spawns a satellite window. */
  | { kind: "tearoff" };

/**
 * Which tab the pointer would drop before, by midpoint — the standard Chrome rule: you displace a
 * tab once you pass its centre, not its edge, so the strip doesn't shuffle under tiny movements.
 *
 * The dragged tab is deliberately NOT excluded. Holding a tab over its own slot yields
 * `beforeId === draggedId`, and treating that as the no-op is the store's job (`reorderProject`),
 * mirroring how AgentSidebar's drop handler guards `dragId !== targetId` before calling
 * `reorderAgent`. Filtering it out here would instead report the NEIGHBOUR's slot, i.e. a real
 * move, for a drag that went nowhere.
 */
function insertionBefore(pointerX: number, tabs: readonly TabRect[]): string | null {
  for (const t of tabs) {
    if (pointerX < t.x + t.width / 2) return t.id;
  }
  return null;
}

/** Is the point outside `rect` grown by `margin` on every side? Inclusive at the boundary, so a
 *  pointer held exactly on the threshold resolves the same way every frame rather than flickering
 *  between spawning and not spawning a window. */
function outside(p: { x: number; y: number }, rect: Rect, margin: number): boolean {
  return (
    p.x < rect.x - margin ||
    p.x > rect.x + rect.width + margin ||
    p.y < rect.y - margin ||
    p.y > rect.y + rect.height + margin
  );
}

export function resolveTabDrag(input: TabDragInput, o: TabDragOpts): TabDragResult {
  const dx = Math.abs(input.pointer.x - input.origin.x);
  const dy = Math.abs(input.pointer.y - input.origin.y);
  // Either axis alone is enough: a tab pulled straight DOWN must tear out without first being
  // nudged sideways. Once `dragging` latches, the gate is spent for the rest of the gesture — a
  // pointer that returns to the press point is still a drag, not a fresh click.
  if (!input.dragging && dx <= o.slop && dy <= o.slop) return { kind: "idle" };

  if (outside(input.pointer, input.strip, o.tearMargin)) return { kind: "tearoff" };

  return { kind: "reorder", beforeId: insertionBefore(input.pointer.x, input.tabs) };
}

/**
 * Top-left for a satellite window torn out under the cursor, centring the window on the pointer so
 * it appears where the user let go rather than jumping a half-window away.
 *
 * The result is a PROPOSAL, not a placement: it can straddle two displays or fall off the edge, so
 * the caller must still run it through `screenFor` (with `hitTestPoint(..., fresh: true, ...)`,
 * because a fresh position carries none of the on-screen guarantees a persisted one does) and then
 * `clampToScreen`. All three live in helper/helperGeometry.ts.
 */
export function tearOffTopLeft(
  pointer: { x: number; y: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  return { x: pointer.x - size.width / 2, y: pointer.y - size.height / 2 };
}
