import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { C } from "../../theme/colors";

/** Full-window dimmed backdrop hosting a centered panel. Click the backdrop or press
 *  Escape to dismiss; clicks inside the panel don't bubble out to close it.
 *
 *  PORTALED TO `document.body`, and that is load-bearing, not tidiness. `zIndex: 1000` only means
 *  "above everything" if this element competes in the ROOT stacking context — and it did not. It
 *  renders inside Composer → AgentPane, and `paneVisibilityStyle` gives every pane root
 *  `zIndex: 1` (to keep the active pane above the inert hidden ones), which makes that root a
 *  stacking context and squashes this whole backdrop to layer 1. Any shell element with a bigger
 *  number then punched straight through a supposedly app-modal dim: the Build column's right-edge
 *  pull tabs did, and so did the column itself once the overlay tab floated it out
 *  (components/layers.ts). A portal takes this out of the pane's context entirely, so the
 *  z-index means what it says regardless of who renders it. React context still flows — a portal
 *  moves the DOM node, not the React tree.
 *
 *  The portal has a second edge, paid for by `hostVisible` below: escaping the pane's stacking
 *  context also escapes its `visibility: hidden`. See the note there. */
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

  // Backgrounded agent panes are NOT unmounted — `paneVisibilityStyle` hides them with
  // `visibility: hidden` + `pointerEvents: none`, and both INHERIT. A lightbox left open in a pane
  // therefore used to go hidden and inert along with its pane, for free. Portaled to
  // `document.body` it escapes that inheritance, so without this it would keep painting a
  // full-window dim over whatever pane is now active — and reaching that state needs no user
  // click, because `selectAgent` is called from background events (controlListener, captureSends,
  // agentReveal, workerSpawn, cloud create, useSpawnBuildAgent).
  //
  // The anchor stays in the ORIGINAL tree and inherits normally, so its computed `visibility` IS
  // the host pane's. `display: none` keeps it out of layout entirely; computed style still resolves
  // inherited values on it. No dep array on purpose: the pane root's style flips during a render of
  // this subtree, so re-reading it every render is exactly what tracks it.
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [hostVisible, setHostVisible] = useState(true);
  // The missing dep array is the MECHANISM, not an oversight (see the paragraph above): the pane
  // root's style flips during a render of this subtree, so the value can only be tracked by
  // re-reading it every render. The rule's stated hazard — a setState in a dep-less layout effect
  // looping forever — does not apply here, because setting identical state is a React bail-out and
  // this writes the same boolean on every render where nothing changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    setHostVisible(getComputedStyle(el).visibility !== "hidden");
  });

  const overlay = createPortal(
    <div
      data-testid="modal-overlay"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.55)",
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
          background: C.forest,
          border: `1px solid ${C.hairline}`,
          borderRadius: 6,
          boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );

  return (
    <>
      <span ref={anchorRef} aria-hidden style={{ display: "none" }} />
      {hostVisible && overlay}
    </>
  );
}
