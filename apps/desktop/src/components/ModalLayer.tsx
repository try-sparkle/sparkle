import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// ── THE ROOT MODAL LAYER, JOINED BY CONSTRUCTION RATHER THAN BY LUCK ───────────────────────────
//
// Every app-modal surface in this app declares a big `z-index` and a `position: fixed`, and every
// one of those numbers is a LIE unless the element competes in the ROOT stacking context. A
// z-index is only ever compared against siblings inside the nearest stacking-context ancestor;
// crossing that boundary, the whole subtree collapses to its ancestor's single number. So a modal's
// real layer is not the number it typed — it is the number of whichever ancestor happened to become
// a stacking context, and that ancestor is chosen by somebody else, for reasons that have nothing
// to do with modality.
//
// THE DEFECT THIS EXISTS TO KILL, stated concretely. `Concierge/ConciergeColumn` gives its root
// `<section>` `position: relative` + `zIndex: CONCIERGE_LIFT_Z` (3) so the column sits above the
// terminal but below the pull tab's rail — a perfectly reasonable local decision. That makes the
// section a stacking context. `Concierge/KebabMenu` renders `<SettingsDialog>` INSIDE it. The
// dialog's backdrop (40) and card (41) therefore never reached 40 and 41; they became layer 3 of
// the shell, and `ColumnPullTab`'s rail at `PULL_TAB_RAIL_Z` (4) — a SIBLING of the column, one
// number higher — painted straight over an app-modal dialog and its scrim.
//
// THE FIX IS NOT A BIGGER NUMBER. Raising the dialog to 400 changes nothing: 400 inside layer 3 is
// still layer 3. Raising the pull tab's own layer, or lowering the column's, "fixes" this one pair
// and re-breaks on the next lifted container anyone adds — and the bands at root are already
// correct and documented (`components/layers.ts`). The defect is structural: a modal rendered from
// inside a lifted container never reaches root at all. A portal is the only move that makes the
// declared z-index mean what it says REGARDLESS of who renders the modal, which is the property a
// modal needs and the one it cannot get from a number.
//
// `composer/ModalOverlay` worked this out first, for the agent-pane case (`paneVisibilityStyle`
// puts `zIndex: 1` on every pane root). This is that component's portal, lifted out so there is ONE
// primitive instead of a copy per modal — because the copy is exactly what did not happen for the
// six dialogs that were still nested when the pull tab punched through.
//
// React context still flows through a portal: it moves the DOM node, not the React tree. Synthetic
// events still bubble along the React tree too, so a modal's own handlers are unaffected. What does
// NOT survive is native DOM ancestry — a `document`-level outside-click check written as
// `ref.contains(e.target)` will no longer see clicks inside a portaled modal as "inside". Check that
// before routing a new surface through here.
/**
 * Portals `children` to `document.body`, so their `z-index` competes at the app's root layer no
 * matter which lifted column, pane or panel rendered them. Wrap a modal's OUTERMOST element
 * (backdrop and card together — a fragment is fine); do it INSIDE the modal component, never at the
 * call site, so the guarantee travels with the modal rather than with whoever remembered.
 */
export function ModalLayer({ children }: { children: ReactNode }) {
  // ── THE PORTAL'S OTHER EDGE, AND WHY THIS ANCHOR IS NOT OPTIONAL ─────────────────────────────
  // Escaping the host's stacking context also escapes its INHERITED properties, and the one that
  // matters is `visibility`. Backgrounded agent panes are not unmounted — `paneVisibilityStyle`
  // hides them with `visibility: hidden` + `pointerEvents: none`, both of which inherit — so a modal
  // left open in a pane used to go hidden and inert along with its pane, for free. Portaled, it does
  // not: it would keep painting a full-window scrim over whatever pane is now active. Reaching that
  // state needs no user click, because `selectAgent` fires from background events (controlListener,
  // captureSends, agentReveal, workerSpawn, cloud create, useSpawnBuildAgent).
  //
  // The anchor stays in the ORIGINAL tree and inherits normally, so its computed `visibility` IS the
  // host's. `display: none` keeps it out of layout entirely; computed style still resolves inherited
  // values on it.
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [hostVisible, setHostVisible] = useState(true);
  // The missing dep array is the MECHANISM, not an oversight: the host's style flips during a render
  // of this subtree, so the value can only be tracked by re-reading it every render. The rule's
  // stated hazard — a setState in a dep-less layout effect looping forever — does not apply, because
  // setting identical state is a React bail-out and this writes the same boolean on every render
  // where nothing changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    setHostVisible(getComputedStyle(el).visibility !== "hidden");
  });

  return (
    <>
      <span ref={anchorRef} aria-hidden style={{ display: "none" }} />
      {hostVisible && createPortal(children, document.body)}
    </>
  );
}
