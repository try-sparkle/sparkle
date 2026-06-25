import { C, FONT_WEIGHT } from "../theme/colors";
import { ModalShell } from "./ModalShell";

/** Asks where to open a project: swap this window's project, or spin up a new window.
 *  Shown by Open / Recent / New when a project is already open in the current window. */
export function OpenTargetDialog({
  onChoose,
  onCancel,
}: {
  onChoose: (mode: "replace" | "new") => void;
  onCancel: () => void;
}) {
  return (
    <ModalShell width={420} onCancel={onCancel}>
      <div style={{ fontSize: 16, fontWeight: FONT_WEIGHT.semibold, marginBottom: 6 }}>
        Open project
      </div>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 18 }}>
        Replace the project in this window, or open it in a new window?
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button
          onClick={() => onChoose("replace")}
          style={{
            background: C.forest,
            color: C.cream,
            border: `1px solid ${C.muted}`,
            borderRadius: 8,
            padding: "11px 14px",
            cursor: "pointer",
            fontSize: 14,
            textAlign: "left",
          }}
        >
          Replace current project
        </button>
        <button
          onClick={() => onChoose("new")}
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
          Open in new window
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
