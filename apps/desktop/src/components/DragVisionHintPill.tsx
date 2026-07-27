// The drag-vision hint pill (spec: 2026-07-02-terminal-drag-hint, Unit A). Shown when the user
// drags an image onto the terminal — which is NOT where images go since CM-U7 removed the pane
// composer.
//
// WHAT THIS PILL MAY PROMISE: only what exists. The terminal drop target is gone, but the concierge
// compose box now takes files — its Screenshot/Image/Files pickers are real and it is itself a drop
// target (parity row #21, useConciergeAttachments). So the pill is a POINTER to them: drop it on the
// Sparkle box, or use the buttons there. It still must not claim the image reaches "this agent" —
// the box aims at Sparkle unless the user pins an agent with the send-target toggle — so the copy
// names the box, never the agent whose terminal was dragged over.
//
// NOT AN UPSELL (roborev 46925). It used to carry "(Vision also needs AI Features enabled.)" and an
// "Enable AI Features" CTA, from when the terminal drop fed a paid vision path. The flow this pill
// now recommends checks no entitlement anywhere — conciergeAttach, useConciergeAttachments and the
// dispatch/brain paths never consult aiFeatureNow — so the parenthetical was simply false and the
// CTA sold a feature the recommended flow does not need. Both are gone, and with them the
// `entitled` prop: there is no longer anything for it to gate.
//
// Rendered through a portal (like SelectionPopup.tsx) so the terminal's overflow:hidden can't clip
// it, and positioned with viewport-clamped fixed coords just ABOVE the terminal pane. Styling
// mirrors the app's dark popovers / ModelPill. No emoji — icons come from react-icons/fi (Feather).
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FiEye, FiExternalLink, FiX } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { useUiStore } from "../stores/uiStore";
import { launch } from "../services/sparkleApi";

/** "Learn more" deep link into the docs. Points at the vision page itself, NOT the old
 *  `#dragging-images-into-the-terminal` anchor — that section describes a behavior this pill
 *  exists to say no longer happens (roborev 46485-L). */
export const VISION_LEARN_MORE_URL = "https://sparkle.ai/docs/vision";
/** Auto-dismiss the pill after this long if the user doesn't act. */
const AUTO_DISMISS_MS = 8000;
const WIDTH = 340;

export function DragVisionHintPill({
  anchorRef,
  onDismiss,
}: {
  /** The terminal pane the pill floats above. Falls back to the top-center of the window. */
  anchorRef?: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 16, top: 16 });

  // Stable ref to onDismiss so the once-only effects (timeout/Escape) don't churn on re-renders.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  // Auto-dismiss after ~8s, and dismiss on Escape (mirrors the app's other popovers).
  useEffect(() => {
    const timer = window.setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismissRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Center the pill horizontally over the terminal pane and float it just above the pane's top
  // edge, clamped into the viewport so it never renders off-screen.
  useLayoutEffect(() => {
    const w = cardRef.current?.offsetWidth ?? WIDTH;
    const h = cardRef.current?.offsetHeight ?? 64;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const a = anchorRef?.current?.getBoundingClientRect();
    const centerX = a ? a.left + a.width / 2 : vw / 2;
    const desiredTop = a ? a.top + 12 : 16;
    const left = Math.max(8, Math.min(centerX - w / 2, vw - w - 8));
    const top = Math.max(8, Math.min(desiredTop, vh - h - 8));
    setPos({ left, top });
  }, [anchorRef]);

  // Primary action: put the caret in the one surface that takes BOTH text and files, which is where
  // the user should have dropped the image.
  const onGoToCompose = () => {
    useUiStore.getState().requestComposeFocus();
    onDismissRef.current();
  };

  const onLearnMore = () => {
    void launch(VISION_LEARN_MORE_URL);
    onDismissRef.current();
  };

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label="Images go in the Sparkle box, not the terminal"
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        zIndex: 9999,
        width: WIDTH,
        boxSizing: "border-box",
        background: C.deepForest,
        border: `1px solid ${C.forest}`,
        borderRadius: 10,
        boxShadow: "0 12px 34px rgba(0,0,0,0.5)",
        fontFamily: '"IBM Plex Sans", sans-serif',
        color: C.cream,
        padding: "12px 12px 10px",
        animation: "sparkle-tooltip-in 90ms ease-out",
      }}
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismissRef.current()}
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          border: "none",
          borderRadius: 6,
          background: "transparent",
          color: C.muted,
          cursor: "pointer",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = C.forest)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <FiX size={14} />
      </button>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", paddingRight: 18 }}>
        <FiEye size={16} style={{ flex: "none", color: C.teal, marginTop: 1 }} aria-hidden />
        <div style={{ fontSize: 12.5, lineHeight: 1.4 }}>
          Dropping an image here doesn&apos;t send it — the terminal takes typed input only. Drop
          it on the Sparkle box instead, or use the Image / Files buttons there, and it rides along
          with your next message.
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
        <button
          type="button"
          onClick={onGoToCompose}
          style={{
            background: C.teal,
            color: ON_BRAND_FILL,
            border: "none",
            borderRadius: 5,
            padding: "5px 12px",
            fontSize: 12,
            fontWeight: FONT_WEIGHT.semibold,
            cursor: "pointer",
            fontFamily: "inherit",
            whiteSpace: "nowrap",
          }}
        >
          Go to the Sparkle box
        </button>
        <button
          type="button"
          onClick={onLearnMore}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            background: "transparent",
            border: "none",
            color: C.teal,
            fontSize: 12,
            cursor: "pointer",
            fontFamily: "inherit",
            padding: "5px 2px",
          }}
        >
          Learn more
          <FiExternalLink size={12} aria-hidden />
        </button>
      </div>
    </div>,
    document.body,
  );
}
