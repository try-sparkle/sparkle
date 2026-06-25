import { useEffect, type ReactNode } from "react";
import { C } from "../theme/colors";

/** Shared dialog chrome: dimmed backdrop (click = cancel) + Escape-to-cancel + centered card.
 *  Used by the small app dialogs (OpenTargetDialog, ClosePrompt) so overlay/card styling and
 *  dismissal behavior live in one place. */
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
        background: "rgba(0,0,0,0.5)",
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
          background: C.deepForest,
          border: `1px solid ${C.forest}`,
          borderRadius: 12,
          padding: 22,
          color: C.cream,
          fontFamily: '"IBM Plex Sans", sans-serif',
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
