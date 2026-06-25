import { useEffect, type ReactNode } from "react";
import { C } from "../../theme/colors";

/** Full-window dimmed backdrop hosting a centered panel. Click the backdrop or press
 *  Escape to dismiss; clicks inside the panel don't bubble out to close it. Sits above
 *  the composer overlay (zIndex 5) and everything else. */
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
    <div
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
          border: `1px solid ${C.deepForest}`,
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}
