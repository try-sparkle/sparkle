import { C, FONT_WEIGHT } from "../theme/colors";
import { ModalShell } from "./ModalShell";

/**
 * Auto-shown the moment a worker's branch reaches "merged". Gently recommends closing the
 * now-redundant worker, while leaving "keep it open" one click away. We deliberately do NOT
 * hide the card's "behind main" counter: a user who keeps the worker open to keep coding must
 * understand that main has advanced past it. Escape / backdrop click = keep it open (the
 * non-destructive default).
 */
export function CloseWorkerPrompt({
  onClose,
  onKeep,
}: {
  onClose: () => void;
  onKeep: () => void;
}) {
  return (
    <ModalShell width={420} zIndex={200} onCancel={onKeep}>
      <div style={{ fontSize: 17, fontWeight: FONT_WEIGHT.bold, marginBottom: 8 }}>
        Close this worker?
      </div>
      <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.5, marginBottom: 20 }}>
        Your code has been pushed to main. We recommend you close this worker, but you can keep it
        open if you prefer.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {/* Green-stroke button: the recommended (and safe) action. */}
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            color: C.success,
            border: `1px solid ${C.success}`,
            borderRadius: 8,
            padding: "9px 18px",
            cursor: "pointer",
            fontSize: 14,
            fontWeight: FONT_WEIGHT.semibold,
            fontFamily: '"IBM Plex Sans", sans-serif',
          }}
        >
          Close worker
        </button>
        {/* Plain text link: the quieter "keep it open" escape hatch. */}
        <button
          onClick={onKeep}
          style={{
            background: "transparent",
            color: C.muted,
            border: "none",
            cursor: "pointer",
            fontSize: 13,
            textDecoration: "underline",
            padding: 0,
            fontFamily: '"IBM Plex Sans", sans-serif',
          }}
        >
          keep it open
        </button>
      </div>
    </ModalShell>
  );
}
