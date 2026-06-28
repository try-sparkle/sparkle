import { type CSSProperties, type ReactNode } from "react";
import { C, ON_BRAND_FILL } from "../theme/colors";

// Shared checkbox row for the ⋯ settings menu (AI features, Notifications, …). Rendered as a
// semantic <button role="checkbox"> rather than a native input so the box + label can be themed,
// and the label dims when unchecked. One source so the two settings sections never drift.

const checkboxRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  width: "100%",
  background: "transparent",
  border: "none",
  padding: "6px 4px",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  color: C.cream,
};

export function SettingCheckbox({
  label,
  checked,
  onToggle,
  /** Optional swatch (e.g. a status color dot) shown before the label. */
  accessory,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  accessory?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      style={checkboxRow}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 auto",
          width: 16,
          height: 16,
          marginTop: 1,
          borderRadius: 4,
          border: `1px solid ${checked ? C.teal : C.muted}`,
          background: checked ? C.teal : "transparent",
          color: ON_BRAND_FILL,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          lineHeight: 1,
        }}
      >
        {checked ? "✓" : ""}
      </span>
      {accessory}
      <span style={{ color: checked ? C.cream : C.muted, lineHeight: 1.35 }}>{label}</span>
    </button>
  );
}
