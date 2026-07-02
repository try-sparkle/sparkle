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

/** True when the drag position (physical pixels) is over an element inside the named target. */
export function isOverDndTarget(position: { x: number; y: number }, target: string): boolean {
  const scale = window.devicePixelRatio || 1;
  // Optional call: jsdom lacks elementFromPoint — tests stub it; real webviews always have it.
  const el = document.elementFromPoint?.(position.x / scale, position.y / scale);
  return !!el?.closest(`[data-dnd-target="${target}"]`);
}
