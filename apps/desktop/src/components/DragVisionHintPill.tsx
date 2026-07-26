// The drag-vision hint pill (spec: 2026-07-02-terminal-drag-hint, Unit A). Shown when the user
// drags an image onto the terminal — which is NOT where images go since CM-U7 removed the pane
// composer.
//
// WHAT THIS PILL MAY PROMISE (roborev 46485-H): only what exists. The terminal drop target is gone
// and the concierge box's Image/Files pickers are still stubs (ConciergeHost.onAttach is a no-op,
// PRD §7 "Concierge attach pickers" ⬜), so there is currently NOWHERE to hand an image to an agent.
// The pill therefore says exactly that. Its one action still earns its place — it puts the caret
// in the one surface that DOES take input, so the user can type what they wanted to show — but it
// must not claim the image goes anywhere, and it must not claim it reaches "this agent" (the box
// aims at Sparkle unless the user pins an agent with the send-target toggle).
//
// The paid "Enable AI Features" CTA is gone for the same reason (roborev 46485-M): with no picker
// anywhere, buying the entitlement still leaves nowhere to hand an agent an image — an upsell into
// a dead end is worse than the informational pill, because it costs money. When the pickers land,
// the copy and the CTA come back together.
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

  // Primary action: put the caret in the one surface that takes input, so the user can SAY what
  // they were trying to show. Deliberately not sold as "your image goes here" — see the header.
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
      aria-label="Images can't be dropped on the terminal"
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
          Dropping an image here doesn&apos;t send it — the terminal takes typed input only, and
          image attachments aren&apos;t wired up anywhere yet. The Sparkle box on the left is where you
          type; describe what you wanted to show.
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
