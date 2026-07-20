import { useEffect, useState, type CSSProperties } from "react";
import { FiCheck } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import { setApprovalRule } from "../../services/configActions";
import { approvalCategoryLabel, type ApprovalCategory } from "../../services/suggestions/approvalCategories";

// The inline offer shown after the user clicks an "approve" answer on a classifiable Claude Code
// permission prompt (composer, spec §4). Two states:
//   nudge:   "Auto-approve all {label} next time?  [Yes] [No] [Never]"
//   confirm: "✓ I'll auto-answer for you on {label} prompts in this project.  [Options]"
// Yes writes approvals.<cat>="always" to the PROJECT config and switches to the confirm toast (which
// auto-dismisses); No just dismisses; Never writes approvals.<cat>="never" (project) and dismisses.
// The write actions are injectable so the component is testable without the Tauri config runtime.

export interface ApprovalNudgeProps {
  category: ApprovalCategory;
  /** The project the rule is written to ("this project" scope). May be null (falls back to global). */
  projectRoot: string | null;
  /** Remove the nudge from the composer (No, Never, or the confirm toast timing out / being clicked). */
  onDismiss: () => void;
  /** Deep-open ⋯ Settings → Auto-approve (the confirm toast's [Options]). */
  onOpenOptions: () => void;
  /** Injectable writers (default → configActions). Tests pass spies to assert the config effects. */
  setAlways?: (category: ApprovalCategory, projectRoot: string | null) => void | Promise<void>;
  setNever?: (category: ApprovalCategory, projectRoot: string | null) => void | Promise<void>;
  /** How long the confirmation toast stays before auto-dismissing (ms). */
  autoDismissMs?: number;
}

const defaultSetAlways = (category: ApprovalCategory, projectRoot: string | null) =>
  setApprovalRule(category, "always", "project", projectRoot);
const defaultSetNever = (category: ApprovalCategory, projectRoot: string | null) =>
  setApprovalRule(category, "never", "project", projectRoot);

export function ApprovalNudge({
  category,
  projectRoot,
  onDismiss,
  onOpenOptions,
  setAlways = defaultSetAlways,
  setNever = defaultSetNever,
  autoDismissMs = 4000,
}: ApprovalNudgeProps) {
  const [phase, setPhase] = useState<"nudge" | "confirm">("nudge");
  const label = approvalCategoryLabel(category);

  // Confirm toast: auto-dismiss after a few seconds (non-blocking). Cleared on unmount so a fast
  // re-click can't leave a stale timer running.
  useEffect(() => {
    if (phase !== "confirm") return;
    const id = window.setTimeout(onDismiss, autoDismissMs);
    return () => window.clearTimeout(id);
  }, [phase, autoDismissMs, onDismiss]);

  if (phase === "confirm") {
    return (
      // Clicking the toast body (anywhere but [Options]) dismisses it immediately.
      <div role="status" style={toast} onClick={onDismiss} data-testid="approval-confirm">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <FiCheck size={14} />
          {/* Tell the truth about scope: setApprovalRule falls back to global when there's no project
              root, so a null root means the rule applies everywhere, not just "this project". */}
          I&apos;ll auto-answer for you on {label} prompts{" "}
          {projectRoot ? "in this project" : "in all projects"}.
        </span>
        <button
          type="button"
          style={linkBtn}
          onClick={(e) => {
            e.stopPropagation();
            onOpenOptions();
          }}
        >
          Options
        </button>
      </div>
    );
  }

  return (
    <div role="group" aria-label={`Auto-approve ${label}`} style={bar} data-testid="approval-nudge">
      <span style={{ color: C.cream, fontSize: 13 }}>Auto-approve all {label} next time?</span>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          style={primaryBtn}
          onClick={() => {
            void setAlways(category, projectRoot);
            setPhase("confirm");
          }}
        >
          Yes
        </button>
        <button type="button" style={ghostBtn} onClick={onDismiss}>
          No
        </button>
        <button
          type="button"
          style={ghostBtn}
          onClick={() => {
            void setNever(category, projectRoot);
            onDismiss();
          }}
        >
          Never
        </button>
      </div>
    </div>
  );
}

const bar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "6px 10px",
  background: C.barSurface,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const toast: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "6px 10px",
  background: C.barSurface,
  border: `1px solid ${C.teal}`,
  borderRadius: 8,
  color: C.cream,
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  cursor: "pointer",
};

const primaryBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 6,
  padding: "4px 12px",
  fontSize: 12,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: '"IBM Plex Sans", sans-serif',
  cursor: "pointer",
};

const ghostBtn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 12,
  fontFamily: '"IBM Plex Sans", sans-serif',
  cursor: "pointer",
};

const linkBtn: CSSProperties = {
  background: "transparent",
  color: C.accentInk,
  border: "none",
  padding: "2px 4px",
  fontSize: 12,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: '"IBM Plex Sans", sans-serif',
  cursor: "pointer",
  textDecoration: "underline",
};
