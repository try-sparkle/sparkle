import { C, FONT_WEIGHT } from "../theme/colors";
import { ModalShell } from "./ModalShell";

/** Shown when the window's close (red traffic light) is requested. Lets the user keep this
 *  project's agents running in the background or kill them and close. */
export function ClosePrompt({
  projectName,
  onKeep,
  onKill,
  onCancel,
}: {
  projectName: string;
  onKeep: () => void;
  onKill: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalShell width={440} zIndex={200} onCancel={onCancel}>
      <div style={{ fontSize: 16, fontWeight: FONT_WEIGHT.semibold, marginBottom: 6 }}>
        Close “{projectName}”?
      </div>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 18 }}>
        Keep this project's agents running in the background, or stop them and close?
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button
          onClick={onKeep}
          style={{
            background: C.teal,
            color: C.cream,
            border: "none",
            borderRadius: 8,
            padding: "11px 14px",
            cursor: "pointer",
            fontSize: 14,
            fontWeight: FONT_WEIGHT.semibold,
            textAlign: "left",
          }}
        >
          Keep agents running
        </button>
        <button
          onClick={onKill}
          style={{
            background: C.forest,
            color: C.cream,
            border: `1px solid ${C.sienna}`,
            borderRadius: 8,
            padding: "11px 14px",
            cursor: "pointer",
            fontSize: 14,
            textAlign: "left",
          }}
        >
          Kill agents &amp; close project
        </button>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button
          onClick={onCancel}
          style={{
            background: "transparent",
            color: C.muted,
            border: `1px solid ${C.muted}`,
            borderRadius: 8,
            padding: "8px 16px",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </ModalShell>
  );
}
