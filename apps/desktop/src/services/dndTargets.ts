// Hit-testing for Tauri's webview-level drag-and-drop against specific DOM drop targets.
//
// Tauri's onDragDropEvent is window-global — the payload carries a cursor position but no
// notion of which ELEMENT the cursor is over (and with dragDropEnabled on, HTML5 drop events
// never fire, so there are no per-element handlers to lean on). Components that want to be a
// drop target mark their root with `data-dnd-target="<name>"`; drag handlers hit-test the
// event position against the DOM with elementFromPoint. Positions arrive as PhysicalPosition
// (physical pixels) — divide by devicePixelRatio to get the CSS/logical coordinates
// elementFromPoint expects.

/** The "+ New Build Agent" button (both the sidebar row and the Workspace empty-state copy). */
export const NEW_BUILD_AGENT_DND_TARGET = "new-build-agent";

/** The concierge compose box — the app's ONE compose surface (CM-U7) and the only place a file
 *  drop becomes an attachment on the next prompt. Scoped to the box rather than the window
 *  because two other window-global drop listeners are live at the same time (useNewBuildAgentDrop
 *  and the Sparkle pane's Composer); an unscoped concierge listener would double-attach. */
export const CONCIERGE_COMPOSE_DND_TARGET = "concierge-compose";

/** The terminal stage — the box in Workspace that every agent pane is stacked inside. Dropping
 *  files here attaches them to the VISIBLE agent's next message (hooks/useTerminalDrop).
 *
 *  DELIBERATELY NOT in FILE_DROP_TARGETS below, even though it does own its drops. That list is
 *  "surfaces the two window-global listeners must stand DOWN over", and the Sparkle pane's
 *  Composer renders INSIDE this stage — listing it here would make that composer refuse drops on
 *  its own box. The stage doesn't need the carve-out anyway: useTerminalDrop only listens while an
 *  agent pane is visible, and no agent pane is visible while the Sparkle pane is. */
export const TERMINAL_STAGE_DND_TARGET = "terminal-stage";

/** True when the drag position (physical pixels) is over an element inside the named target. */
export function isOverDndTarget(position: { x: number; y: number }, target: string): boolean {
  const scale = window.devicePixelRatio || 1;
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
export const FILE_DROP_TARGETS = [NEW_BUILD_AGENT_DND_TARGET, CONCIERGE_COMPOSE_DND_TARGET] as const;

/** True when the drag position is over ANY surface that accepts the file itself. */
export function isOverFileDropTarget(position: { x: number; y: number } | undefined): boolean {
  if (!position) return false;
  return FILE_DROP_TARGETS.some((t) => isOverDndTarget(position, t));
}
