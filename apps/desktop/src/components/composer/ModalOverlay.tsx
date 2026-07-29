import { useEffect, type ReactNode } from "react";
import { C, MODAL_SHADOW, SCRIM } from "../../theme/colors";
import { RADIUS } from "../../theme/scale";
import { ModalLayer } from "../ModalLayer";

/** Full-window dimmed backdrop hosting a centered panel. Click the backdrop or press
 *  Escape to dismiss; clicks inside the panel don't bubble out to close it.
 *
 *  PORTALED TO `document.body` via `ModalLayer`, and that is load-bearing, not tidiness.
 *  `zIndex: 1000` only means "above everything" if this element competes in the ROOT stacking
 *  context — and it did not. It renders inside Composer → AgentPane, and `paneVisibilityStyle`
 *  gives every pane root `zIndex: 1` (to keep the active pane above the inert hidden ones), which
 *  makes that root a stacking context and squashes this whole backdrop to layer 1. Any shell
 *  element with a bigger number then punched straight through a supposedly app-modal dim: the Build
 *  column's right-edge pull tabs did, and so did the column itself once the overlay tab floated it
 *  out (components/layers.ts).
 *
 *  This component worked that out first and carried its own copy of the portal — including the
 *  host-visibility guard the portal makes necessary. Both now live in `ModalLayer`, because the
 *  copy is precisely what did NOT propagate: six other dialogs stayed nested, and the same pull tab
 *  went on to punch through the settings modal from inside the lifted concierge column. Read
 *  `../ModalLayer` for the full reasoning; nothing about this overlay's behavior changed. */
export function ModalOverlay({
  onClose,
  children,
  maxWidth = 720,
}: {
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <ModalLayer>
      <div
        data-testid="modal-overlay"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1000,
          background: SCRIM,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            maxWidth,
            width: "100%",
            maxHeight: "100%",
            display: "flex",
            flexDirection: "column",
            background: C.dialogSurface,
            border: `1px solid ${C.dialogEdge}`,
            borderRadius: RADIUS.modal,
            boxShadow: MODAL_SHADOW,
            overflow: "hidden",
          }}
        >
          {children}
        </div>
      </div>
    </ModalLayer>
  );
}
