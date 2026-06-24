import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { C, FONT, FONT_WEIGHT } from "../theme/colors";

/**
 * A small styled hover tooltip — replaces the native `title=` pop-up so paths and
 * other metadata get the brand card treatment instead of the OS default.
 *
 * Rendered through a portal to <body> and positioned with `fixed` coordinates taken
 * from the trigger's bounding rect, so it can't be clipped by an ancestor's
 * `overflow: hidden/auto` (e.g. the scrolling agent sidebar).
 */
// Card max width — also used to clamp the anchor so it can't run off-screen.
const MAX_WIDTH = 420;

export function Tooltip({
  label,
  value,
  children,
}: {
  /** Small muted caption above the value, e.g. "Working in:". */
  label?: string;
  /** The emphasized line — a path, name, etc. Rendered in mono for paths. */
  value: ReactNode;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const show = () => {
    // Measure the actual child, not the wrapper: the wrapper is `display: contents`
    // and so generates no box — getBoundingClientRect() on it returns a zero rect in
    // the Tauri/Chromium webview, which would anchor the tooltip to (0,0).
    const el = triggerRef.current?.firstElementChild ?? triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Anchor just below the trigger, left-aligned to it — but clamp so a long path
    // can't push the card off the right (or left) edge of the window.
    const left = Math.max(8, Math.min(r.left, window.innerWidth - MAX_WIDTH - 8));
    setPos({ left, top: r.bottom + 6 });
  };
  const hide = () => setPos(null);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        // Keep the trigger transparent to layout — it just wraps the child.
        style={{ display: "contents" }}
      >
        {children}
      </span>
      {pos &&
        createPortal(
          <div
            // Don't let the tooltip eat pointer events or flicker the trigger.
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              zIndex: 9999,
              pointerEvents: "none",
              maxWidth: MAX_WIDTH,
              padding: "8px 10px",
              background: C.deepForest,
              border: `1px solid ${C.forest}`,
              borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              display: "flex",
              flexDirection: "column",
              gap: 3,
              animation: "sparkle-tooltip-in 90ms ease-out",
            }}
          >
            {label && (
              <span
                style={{
                  color: C.muted,
                  fontFamily: FONT.ui,
                  fontSize: 10,
                  fontWeight: FONT_WEIGHT.semibold,
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                }}
              >
                {label}
              </span>
            )}
            <span
              style={{
                color: C.cream,
                fontFamily: FONT.mono,
                fontSize: 12,
                lineHeight: 1.4,
                wordBreak: "break-all",
              }}
            >
              {value}
            </span>
          </div>,
          document.body,
        )}
    </>
  );
}
