import { useEffect, type ReactNode } from "react";
import { C, MODAL_SHADOW, SCRIM } from "../theme/colors";
import { FONT_UI, RADIUS } from "../theme/scale";
import { ModalLayer } from "./ModalLayer";

/** Shared dialog chrome: dimmed backdrop (click = cancel) + Escape-to-cancel + centered card.
 *  Used by the small app dialogs (OpenTargetDialog, ClosePrompt) so overlay/card styling and
 *  dismissal behavior live in one place.
 *
 *  ── AND THE ROOT MODAL LAYER, WHICH IS THE OTHER THING "IN ONE PLACE" HAS TO MEAN ────────────
 *  The `zIndex` prop below defaults to 100 and is raised to 200/300 by the callers that stack on
 *  each other. Not one of those numbers meant anything until this went through `ModalLayer`: every
 *  consumer renders from somewhere inside the shell, and any `position: relative; z-index: <n>`
 *  ancestor — the concierge column's lift, an agent pane's visibility z-index — is a stacking
 *  context that flattens this whole overlay, 300 and all, to the ancestor's single layer. The
 *  concierge column's pull-tab rail then painted over an app-modal dialog at a z-index of FOUR.
 *  Portaling is what makes the prop a real number; see `ModalLayer` for the full argument. Nine
 *  dialogs inherit that from this one file, which is the point of the file.
 *
 *  ── THIS IS THE MODAL PLANE, AND IT IS NOT THE BUILDER COLUMN ────────────────────────────────
 *  The card used to paint `deepForest` with a `hairline` border and two hand-typed constants — a
 *  flat black scrim and a flat black shadow, neither of them themed. All four are spec tokens now.
 *
 *  The surface change is the load-bearing one: `deepForest` is the BUILDER COLUMN's plane, and a
 *  dialog is not a panel inside the shell. The direction gives it `--k-dialog`, which in both themes
 *  is the GROUND — a modal floats above everything and takes the paper the shell is drawn on, then
 *  separates itself with a rule and a shadow. In light that is #ffffff against the #f2f6fd every
 *  dialog had been painted, i.e. every one of them was a plane too dark.
 *
 *  The two constants mattered more than they look. `rgba(0,0,0,0.5)` is dark mode's scrim applied to
 *  light mode as well, so a near-white shell got a half-black wash over it; the spec's light scrim is
 *  a 28% navy. Same for the shadow. Nine other dialogs carried their own copies of both.
 *
 *  ── THE CARD IS BOUNDED TO THE VIEWPORT, AND THAT IS NOT A DETAIL ────────────────────────────
 *  The card used to take whatever height its children wanted. That is fine for a confirm prompt and
 *  catastrophic for a dialog with a list in it: the accounts screen grew past the bottom of the
 *  window, and because the card is CENTRED in the scrim it grew past the top as well — so there was
 *  no scroll position from which the overflowing controls could be reached, in either direction. The
 *  founder could not sign in a second Claude account because the "+ Add account" button had been
 *  carried off the screen by the spawn ledger underneath it.
 *
 *  `maxHeight` alone would only trade hiding for CLIPPING, so the body is the scrollport: the card
 *  is a flex column that clips to its own rounded corners, and the padding moved off the card onto
 *  the body so that a consumer's sticky header can pin flush against the card's top edge rather
 *  than leaving a 22px strip of content sliding past above it. `MODAL_PADDING` is exported for
 *  exactly that: a full-bleed sticky header has to know the inset it is cancelling, and hand-typing
 *  22 in the consumer is how the two drift apart. */

/** The body's inset. Exported so a consumer pinning a full-bleed sticky header can cancel it with
 *  negative margins instead of guessing the number. */
export const MODAL_PADDING = 22;

/** Ceiling on a dialog card's height, as a share of the viewport. Leaves the scrim visible on both
 *  edges so the dialog still reads as floating rather than as a page.
 *
 *  Exported because the dialogs that paint their OWN card (the cloud pair, the project modal) need
 *  the same ceiling, and three hand-typed copies had already drifted 2vh apart before anyone looked. */
export const MODAL_MAX_HEIGHT = "88vh";

export function ModalShell({
  width = 420,
  zIndex = 100,
  onCancel,
  children,
}: {
  width?: number;
  zIndex?: number;
  onCancel: () => void;
  children: ReactNode;
}) {
  // Escape cancels — a safety affordance, especially for the destructive close prompt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <ModalLayer>
      <div
        data-testid="modal-shell-backdrop"
        onClick={onCancel}
        style={{
          position: "fixed",
          inset: 0,
          background: SCRIM,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex,
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width,
            maxWidth: "90vw",
            maxHeight: MODAL_MAX_HEIGHT,
            display: "flex",
            flexDirection: "column",
            // Clip the scrolling body to the card's radius; without it a long list paints square
            // corners over the rounded ones.
            overflow: "hidden",
            background: C.dialogSurface,
            border: `1px solid ${C.dialogEdge}`,
            borderRadius: RADIUS.modal,
            color: C.cream,
            fontFamily: FONT_UI,
            boxShadow: MODAL_SHADOW,
          }}
        >
          <div
            data-testid="modal-shell-body"
            style={{
              padding: MODAL_PADDING,
              overflowY: "auto",
              // A flex child's default `min-height: auto` refuses to shrink below its content, which
              // would let the body push the card straight back past `maxHeight` and restore the bug
              // this file exists to fix. It has to be allowed to shrink for the bound to bind.
              minHeight: 0,
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </ModalLayer>
  );
}
