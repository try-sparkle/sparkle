// The drag-vision hint pill (spec: 2026-07-02-terminal-drag-hint, Unit A). Shown when the user
// drags an image onto the terminal while the AI composer is OFF (see useDragVisionHint) — nudging
// them to enable AI Features so Claude Code can "see" dropped images.
//
// Rendered through a portal (like SelectionPopup.tsx) so the terminal's overflow:hidden can't clip
// it, and positioned with viewport-clamped fixed coords just ABOVE the terminal pane. Styling
// mirrors the app's dark popovers / ModelPill. No emoji — icons come from react-icons/fi (Feather).
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FiEye, FiExternalLink, FiX } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { launch } from "../services/sparkleApi";
import { aiEnhancementsEnabled } from "../services/aiGate";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";

/** "Learn more" deep link into the docs (frozen in the shared design contract). */
export const VISION_LEARN_MORE_URL =
  "https://sparkle.ai/docs/vision#dragging-images-into-the-terminal";
/** Pricing page with the vision feature pre-highlighted — the not-entitled upgrade target. */
export const VISION_PRICING_URL = "https://sparkle.ai/pricing?highlight=composer-vision";
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
  // Entitlement fork signal: the paid $99 unlock (aiGate's `aiEnhancementsEnabled` / the same
  // entitlement `useAiFeatureLocked` reads). We can't use useAiFeatureLocked("composer") here — it
  // requires the flag ON, and here the composer flag is OFF — so read the underlying entitlement.
  const entitled = useAuthStore((s) => aiEnhancementsEnabled(s.me));
  const setAiFeature = useSettingsStore((s) => s.setAiFeature);
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

  // Entitlement fork for the "Enable AI Features" button:
  //  - entitled (paid $99, composer just disabled) → flip the composer flag on and dismiss; the
  //    Composer mounts and image drops start working immediately.
  //  - not entitled → hand the pricing page (feature pre-highlighted) to the system browser.
  // Both paths dismiss the pill (clicking an action closes it, per spec).
  const onEnable = () => {
    if (entitled) {
      setAiFeature("composer", true);
    } else {
      void launch(VISION_PRICING_URL);
    }
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
      aria-label="Enable AI Features for terminal image drag-and-drop"
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
          Enable AI Features to give Claude Code vision by dragging images into the Terminal window.
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
        <button
          type="button"
          onClick={onEnable}
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
          Enable AI Features
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
