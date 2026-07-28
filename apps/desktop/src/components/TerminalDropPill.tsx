// Confirmation pill for files dropped on an agent's terminal (hooks/useTerminalDrop). The paths are
// pasted into that terminal's input line; this says so, and says what did NOT happen.
//
// WHAT THIS PILL MAY PROMISE: only what happened. The paths are PASTED, not sent — they sit at the
// CLI's prompt until the user presses Enter, and the pill has to make that unmistakable, because a
// user who assumes it was sent will sit waiting for an answer that is not coming. It used to say
// the files were "attached" and point at the Sparkle box, which is what this change removed: the
// drop now lands in the terminal the user dropped on.
//
// It also reports FAILURE. `delivered: false` means the agent's PTY was gone and nothing was
// pasted — the one case where a confirmation would otherwise be a straight lie about a file the
// user can no longer see anywhere.
//
// Rendered through a portal (like SelectionPopup.tsx) so the terminal's overflow:hidden can't clip
// it, and positioned with viewport-clamped fixed coords just inside the terminal pane's top edge.
// Styling mirrors the app's dark popovers / ModelPill. No emoji — icons come from react-icons/fi.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FiAlertTriangle, FiPaperclip, FiX } from "react-icons/fi";
import { C } from "../theme/colors";

/** Auto-dismiss the pill after this long if the user doesn't act. */
const AUTO_DISMISS_MS = 8000;
const WIDTH = 340;

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "2 images", "1 file", "3 files (2 of them images)" — names what landed without ever calling a
 *  non-image an image. Pure, so the copy is testable without a DOM. */
export function describeDrop(count: number, images: number): string {
  if (images === 0) return plural(count, "file");
  if (images === count) return plural(count, "image");
  return `${plural(count, "file")} (${images} of them images)`;
}

export function TerminalDropPill({
  count,
  images,
  delivered = true,
  agentName,
  anchorRef,
  onDismiss,
}: {
  count: number;
  /** How many of `count` are images — wording only; every dropped file is pasted the same way. */
  images: number;
  /** False when the agent's PTY was gone, so nothing was pasted. Defaults to the success wording
   *  so a caller that never fails doesn't have to say so. */
  delivered?: boolean;
  /** The agent whose terminal was dropped on. */
  agentName: string;
  /** The terminal pane the pill floats over. Falls back to the top-center of the window. */
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

  // Center the pill horizontally over the terminal pane and float it just inside the pane's top
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

  return createPortal(
    <div
      ref={cardRef}
      data-testid="terminal-drop-pill"
      role="dialog"
      aria-label={
        delivered
          ? `Pasted into ${agentName}'s terminal`
          : `Nothing pasted — ${agentName}'s terminal isn't running`
      }
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        zIndex: 9999,
        width: WIDTH,
        boxSizing: "border-box",
        background: C.deepForest,
        border: `1px solid ${C.hairline}`,
        borderRadius: 6,
        boxShadow: "0 12px 34px rgba(0,0,0,0.5)",
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
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
        // The glyph moves with the fill. At rest it is `muted` on the card's `deepForest` plane,
        // which is what `muted` is for; on hover the backdrop becomes a chrome fill, where `muted`
        // cannot clear its floor in either theme (see THE NEUTRAL LADDER in theme/colors). Set
        // together so the pair can never drift apart.
        onMouseEnter={(e) => {
          e.currentTarget.style.background = C.pillFill;
          e.currentTarget.style.color = C.cream;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = C.muted;
        }}
      >
        <FiX size={14} />
      </button>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", paddingRight: 18 }}>
        {delivered ? (
          <FiPaperclip
            size={16}
            style={{ flex: "none", color: C.tealInk, marginTop: 1 }}
            aria-hidden
          />
        ) : (
          <FiAlertTriangle
            size={16}
            style={{ flex: "none", color: C.amberInk, marginTop: 1 }}
            aria-hidden
          />
        )}
        <div style={{ fontSize: 12, lineHeight: 1.4 }}>
          {delivered ? (
            <>
              Pasted {describeDrop(count, images)} into <strong>{agentName}</strong>&rsquo;s
              terminal. Nothing has been sent — type what you want done with it and press Enter.
            </>
          ) : (
            <>
              <strong>{agentName}</strong>&rsquo;s terminal isn&rsquo;t running, so{" "}
              {describeDrop(count, images)} went nowhere. Restart the agent and drop again.
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
