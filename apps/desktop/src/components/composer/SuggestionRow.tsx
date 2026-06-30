import { FiX, FiCheck } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../../theme/colors";
import type { SuggestionButton } from "../../services/suggestions/types";

// Right-justified one-click action pills shown in the composer when an agent is waiting on the
// user and the box is empty. Most-likely first (leftmost). Each pill = [ label ×]: clicking the
// label sends the action; clicking × removes just that pill (frees composer room).
interface Props {
  buttons: SuggestionButton[];
  visible: boolean;
  onClick: (b: SuggestionButton) => void;
  onDismiss: (id: string) => void;
}

export function SuggestionRow({ buttons, visible, onClick, onDismiss }: Props) {
  if (!visible || buttons.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, alignSelf: "flex-end", alignItems: "center" }}>
      {buttons.map((b) => {
        // Control buttons (e.g. Close Build Agent) render as a filled green success pill with a
        // check; suggestion pills are neutral/translucent. White text reads on both green shades.
        const control = b.kind === "control";
        const fg = control ? "#ffffff" : C.cream;
        return (
        <div
          key={b.id}
          style={{
            display: "flex",
            alignItems: "center",
            height: 40,
            borderRadius: 8,
            background: control ? C.successInk : "rgba(255,255,255,0.06)",
            border: control ? "none" : `1px solid ${C.muted}`,
          }}
        >
          <button
            onClick={() => onClick(b)}
            title={control ? b.label : b.value}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              border: "none",
              color: fg,
              padding: "0 6px 0 12px",
              height: "100%",
              cursor: "pointer",
              maxWidth: 240,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontWeight: FONT_WEIGHT.semibold,
              fontFamily: '"IBM Plex Sans", sans-serif',
              fontSize: 13,
            }}
          >
            {control && <FiCheck size={14} />}
            {b.label}
          </button>
          <button
            aria-label={`Dismiss ${b.label}`}
            onClick={() => onDismiss(b.id)}
            style={{
              background: "transparent",
              border: "none",
              color: fg,
              paddingRight: 8,
              paddingLeft: 2,
              height: "100%",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              opacity: 0.6,
            }}
          >
            <FiX size={13} />
          </button>
        </div>
        );
      })}
    </div>
  );
}
