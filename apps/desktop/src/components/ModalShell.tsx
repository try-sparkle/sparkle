import { useEffect, type ReactNode } from "react";
import { C, MODAL_SHADOW, SCRIM } from "../theme/colors";
import { FONT_UI, RADIUS } from "../theme/scale";

/** Shared dialog chrome: dimmed backdrop (click = cancel) + Escape-to-cancel + centered card.
 *  Used by the small app dialogs (OpenTargetDialog, ClosePrompt) so overlay/card styling and
 *  dismissal behavior live in one place.
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
 *  a 28% navy. Same for the shadow. Nine other dialogs carried their own copies of both. */
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
    <div
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
          background: C.dialogSurface,
          border: `1px solid ${C.dialogEdge}`,
          borderRadius: RADIUS.modal,
          padding: 22,
          color: C.cream,
          fontFamily: FONT_UI,
          boxShadow: MODAL_SHADOW,
        }}
      >
        {children}
      </div>
    </div>
  );
}
