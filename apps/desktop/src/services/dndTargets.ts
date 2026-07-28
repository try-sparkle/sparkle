// Hit-testing for Tauri's webview-level drag-and-drop against specific DOM drop targets.
//
// Tauri's onDragDropEvent is window-global — the payload carries a cursor position but no
// notion of which ELEMENT the cursor is over (and with dragDropEnabled on, HTML5 drop events
// never fire, so there are no per-element handlers to lean on). Components that want to be a
// drop target mark their root with `data-dnd-target="<name>"`; drag handlers hit-test the
// event position against the DOM with elementFromPoint, which wants CSS pixels.
//
// GETTING TO CSS PIXELS IS PLATFORM-DEPENDENT, and assuming otherwise is what broke every drop
// target in the app (PRD/feat/drag-drop-image-attach.md). See dragPositionScale below.

/** The "+ New Build Agent" button (both the sidebar row and the Workspace empty-state copy). */
export const NEW_BUILD_AGENT_DND_TARGET = "new-build-agent";

/** The concierge column — the whole left column, not just the box at the bottom of it. A file
 *  dropped ANYWHERE over the concierge attaches to the next prompt, because "somewhere on the
 *  panel I'm talking to" is the target a user actually aims at; the compose box alone is a ~90px
 *  strip and missing it silently did nothing. Still SCOPED to the column rather than the whole
 *  window because two other window-global drop listeners are live at the same time
 *  (useNewBuildAgentDrop and the Sparkle pane's Composer); an unscoped listener would
 *  double-attach. The box the files land in paints the affordance (Concierge/ComposeBox). */
export const CONCIERGE_COLUMN_DND_TARGET = "concierge-column";

/** The terminal stage — the box in Workspace that every agent pane is stacked inside. Dropping
 *  files here attaches them to the VISIBLE agent's next message (hooks/useTerminalDrop).
 *
 *  DELIBERATELY NOT in FILE_DROP_TARGETS below, even though it does own its drops. That list is
 *  "surfaces the two window-global listeners must stand DOWN over", and the Sparkle pane's
 *  Composer renders INSIDE this stage — listing it here would make that composer refuse drops on
 *  its own box. The stage doesn't need the carve-out anyway: useTerminalDrop only listens while an
 *  agent pane is visible, and no agent pane is visible while the Sparkle pane is. */
export const TERMINAL_STAGE_DND_TARGET = "terminal-stage";

/**
 * How much to divide a Tauri drag position by to land in the CSS pixels elementFromPoint wants.
 *
 * THIS IS THE BUG THAT KILLED EVERY DROP TARGET. Tauri types the drag position as a
 * `PhysicalPosition` on all three platforms, but only Windows actually fills one:
 *
 *   - Windows (wry `webview2/drag_drop.rs`): the screen point goes through `ScreenToClient`,
 *     which yields PHYSICAL device pixels. Divide by devicePixelRatio.
 *   - macOS (wry `wkwebview/drag_drop.rs`): the point is built from
 *     `NSDraggingInfo.draggingLocation()` and the WKWebView's `NSView` frame — both AppKit
 *     POINTS — and `tauri-runtime-wry` wraps that tuple straight into `PhysicalPosition::new()`
 *     without ever multiplying by the backing scale factor. It is already CSS pixels.
 *   - Linux (wry `webkitgtk/drag_drop.rs`): raw GTK widget coordinates, also logical.
 *
 * So dividing unconditionally halved every coordinate on a Retina Mac (devicePixelRatio 2): the
 * hit test ran at a point in the upper-left quadrant of the window, which is neither the
 * concierge column nor, usually, the terminal stage. Nothing threw and nothing logged — the drop
 * was simply attributed to empty space. It was invisible to the suite because jsdom reports
 * devicePixelRatio 1, where the wrong formula and the right one agree.
 */
export function dragPositionScale(): number {
  // The webview's own UA is the platform signal here: @tauri-apps/plugin-os is not a dependency,
  // and this has to be answerable synchronously inside a drag handler.
  const windows = /Windows/i.test(navigator.userAgent || "");
  return windows ? window.devicePixelRatio || 1 : 1;
}

/** True when the drag position (as Tauri reports it) is over an element inside the named target. */
export function isOverDndTarget(position: { x: number; y: number }, target: string): boolean {
  const scale = dragPositionScale();
  // Optional call: jsdom lacks elementFromPoint — tests stub it; real webviews always have it.
  const el = document.elementFromPoint?.(position.x / scale, position.y / scale);
  return !!el?.closest(`[data-dnd-target="${target}"]`);
}

/** Surfaces a window-global listener must stand DOWN over, because something else owns the drop.
 *  One shared list rather than a private copy per listener (roborev 46911/49294): Composer.tsx
 *  reads it so a file can't double-attach, and a target added here reaches every consumer at once
 *  instead of silently regressing whichever copy was forgotten.
 *
 *  NOT every drop target belongs here — TERMINAL_STAGE_DND_TARGET owns its drops and is
 *  deliberately absent; see its comment above for why adding it would break the Sparkle pane's
 *  composer. */
export const FILE_DROP_TARGETS = [NEW_BUILD_AGENT_DND_TARGET, CONCIERGE_COLUMN_DND_TARGET] as const;

/** True when the drag position is over ANY surface that accepts the file itself. */
export function isOverFileDropTarget(position: { x: number; y: number } | undefined): boolean {
  if (!position) return false;
  return FILE_DROP_TARGETS.some((t) => isOverDndTarget(position, t));
}
