// displaySpan — drive the window's geometry across multiple displays.
//
// Thin bindings over src-tauri/src/display_span.rs plus the pure formatting helpers the Appearance
// pane needs. The interesting logic (which rectangle to span to) is deliberately in Rust, where it
// is unit-tested against real arrangements; this layer only carries values.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Which rectangle "span all displays" targets. Wire values match Rust's `SpanMode`. */
export type SpanMode = "safe" | "full";

/**
 * Rectangle in LOGICAL POINTS, mirroring Rust's `Rect` — not physical pixels.
 *
 * On a mixed-DPI Mac "physical pixels" are per-monitor and cannot be compared across displays, so
 * everything here (monitor bounds, work areas, span targets) is in the single global point space.
 * The header of src-tauri/src/display_span.rs has the full reasoning.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One attached display. Field names are snake_case to match the Rust serialization verbatim. */
export interface DisplayInfo {
  name: string | null;
  bounds: Rect;
  work_area: Rect;
  scale_factor: number;
}

export interface DisplayLayout {
  displays: DisplayInfo[];
  /** Union bounding box of the work areas — the `full` target. */
  full: Rect | null;
  /** Largest fully-covered rectangle — the `safe` target. */
  safe: Rect | null;
  /** False when macOS "Displays have separate Spaces" is ON, which makes spanning impossible. */
  spanning_enabled: boolean;
}

/** Event name emitted by the Rust display watcher. */
export const DISPLAYS_CHANGED = "displays-changed";

export function getDisplayLayout(): Promise<DisplayLayout> {
  return invoke<DisplayLayout>("display_layout");
}

/**
 * Span the window; resolves with the rect that was REQUESTED.
 *
 * It is deliberately not a report of what the window actually got. macOS applies window geometry
 * on the main dispatch queue, so nothing can read the settled frame back synchronously — two
 * attempts to do so both ended up reporting the pre-span geometry, which made every span look
 * clamped and silently disabled auto-respan. See the header of src-tauri/src/display_span.rs.
 */
export function spanWindow(mode: SpanMode): Promise<Rect> {
  return invoke<Rect>("span_window", { mode });
}

export function fitWindowToCurrentDisplay(): Promise<Rect> {
  return invoke<Rect>("fit_window_to_current_display");
}

export function resetWindowSize(): Promise<Rect> {
  return invoke<Rect>("reset_window_size");
}

/** Subscribe to display connect/disconnect. */
export function onDisplaysChanged(handler: () => void): Promise<UnlistenFn> {
  return listen(DISPLAYS_CHANGED, () => handler());
}

/** The rect a given mode would target, or null when no displays were reported. */
export function targetRect(layout: DisplayLayout, mode: SpanMode): Rect | null {
  return mode === "safe" ? layout.safe : layout.full;
}

/** Exact geometry equality. */
export function rectsEqual(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * The one-line summary under the Span button, e.g. `3 displays · 5352 × 1080`.
 *
 * Pure so the pane's copy is testable without a windowing backend — and because getting the
 * singular/plural or a null rect wrong is exactly the kind of thing that ships unnoticed.
 */
export function describeSpanTarget(layout: DisplayLayout, mode: SpanMode): string {
  const count = layout.displays.length;
  const noun = count === 1 ? "display" : "displays";
  const rect = targetRect(layout, mode);
  if (!rect) return `${count} ${noun}`;
  return `${count} ${noun} · ${rect.width} × ${rect.height}`;
}

/**
 * Does picking a span mode change anything on THIS arrangement?
 *
 * On displays that tile into a clean rectangle both modes give the identical rect, and offering a
 * choice that does nothing is worse than not offering it — the user reasonably concludes the
 * control is broken. The pane uses this to explain that they currently agree.
 */
export function modesAgree(layout: DisplayLayout): boolean {
  const { safe, full } = layout;
  if (!safe || !full) return true;
  return rectsEqual(safe, full);
}
