import { type CSSProperties } from "react";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { useSettingsStore } from "../stores/settingsStore";
import { setDeleteMergedBranch } from "../services/configActions";

// Two-option control for the TopBar ⋯ menu: what happens to a build agent's branch when you close
// it after its work has merged to main. "delete" = a SAFE delete (refuses if not actually merged);
// "keep" leaves the merged branch around. Mirrors `workflow.delete_merged_branch` in config.toml
// (read by both the Close Build Agent button and the orchestrator's post-merge cleanup).
const OPTIONS: Array<{ value: boolean; label: string; aria: string }> = [
  {
    value: true,
    label: "Delete merged branch (recommended)",
    aria: "On close, safely delete a build agent's branch once it has merged to main",
  },
  {
    value: false,
    label: "Keep merged branch",
    aria: "On close, keep a build agent's branch even after it has merged to main",
  },
];

const opt: CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "7px 10px",
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
  fontFamily: '"IBM Plex Sans", sans-serif',
};

export function BranchCleanupToggle() {
  const deleteMergedBranch = useSettingsStore((s) => s.deleteMergedBranch);
  return (
    <div
      role="group"
      aria-label="After merge to main"
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      {OPTIONS.map(({ value, label, aria }) => {
        const selected = deleteMergedBranch === value;
        return (
          <button
            key={String(value)}
            type="button"
            aria-label={aria}
            aria-pressed={selected}
            onClick={() => void setDeleteMergedBranch(value)}
            style={{
              ...opt,
              background: selected ? C.teal : "transparent",
              color: selected ? ON_BRAND_FILL : C.muted,
              borderColor: selected ? C.teal : C.muted,
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
