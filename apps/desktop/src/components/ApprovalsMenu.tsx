import { type CSSProperties } from "react";
import { FiAlertTriangle } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../theme/colors";
import { useSettingsStore } from "../stores/settingsStore";
import { useApprovalsStore } from "../stores/approvalsStore";
import { useProjectStore } from "../stores/projectStore";
import { useCurrentProjectId } from "../windowContext";
import { useAiFeatureVisible } from "../services/aiGate";
import {
  useSyncProjectApprovals,
} from "../services/suggestions/approvalsRuntime";
import {
  setApprovalRule,
  removeApprovalRuleEverywhere,
  setResumeRule,
} from "../services/configActions";
import {
  APPROVAL_CATEGORIES,
  approvalCategoryLabel,
  DEFAULT_RESUME_RULE,
  RESUME_RULE_LABEL,
  type ApprovalCategory,
  type ApprovalRule,
  type ResumeRule,
} from "../services/suggestions/approvalCategories";

// The ⋯ Settings → "Auto-approve" pane. Lists every category with its current effective rule + the
// scope it came from, and lets the user set it at all-projects (global) or this-project scope, or
// remove it. The `bash` row carries a destructive-command warning. All writes go through
// configActions (the TOML file is the source of truth); reads come from the settings mirror (global)
// + the per-project effective cache (approvalsStore, kept fresh by useSyncProjectApprovals).

type Scope = "global" | "project" | null;

interface RowState {
  effective: ApprovalRule | undefined;
  scope: Scope;
}

/** Resolve a category's effective rule + which scope set it. The scope is a best-effort read: when a
 *  project value equals the global value we attribute it to the global layer (they're indistinguishable
 *  without the raw project layer). Cosmetic only — the write buttons are always explicit. */
function rowState(
  cat: ApprovalCategory,
  global: Partial<Record<ApprovalCategory, ApprovalRule>>,
  proj: Partial<Record<ApprovalCategory, ApprovalRule>> | undefined,
): RowState {
  const g = global[cat];
  // A loaded project map is the merged effective view; without it, the global mirror is effective.
  const effective = proj ? proj[cat] : g;
  if (effective === undefined) return { effective: undefined, scope: null };
  if (proj && proj[cat] !== undefined && proj[cat] !== g) return { effective, scope: "project" };
  if (g !== undefined) return { effective, scope: "global" };
  return { effective, scope: "project" };
}

function statusText(state: RowState): string {
  if (state.effective === "never") return "Muted — Sparkle won't ask again";
  if (state.effective === "always") {
    return state.scope === "project"
      ? "Auto-approving in this project"
      : "Auto-approving in all projects";
  }
  return "Asks each time (and offers to remember)";
}

/** The three session-resume choices, in the order the row lists them. */
const RESUME_CHOICES: readonly ResumeRule[] = ["ask", "summary", "full"] as const;

/** Human-readable status for the resume row given the effective rule + the scope it came from. */
function resumeStatusText(effective: ResumeRule, scope: Scope): string {
  if (effective === "ask") return "Asks you each time you resume a large session";
  const where = scope === "project" ? "in this project" : "in all projects";
  return effective === "summary"
    ? `Auto-resuming from summary ${where}`
    : `Auto-resuming the full session ${where}`;
}

export function ApprovalsMenu() {
  const projectId = useCurrentProjectId();
  const projectRoot = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.rootPath ?? null,
  );
  useSyncProjectApprovals(projectRoot);

  const globalMap = useSettingsStore((s) => s.approvals);
  const projMap = useApprovalsStore((s) => (projectRoot ? s.byRoot[projectRoot] : undefined));
  // Session-resume sibling: its own global mirror + per-project effective value.
  const globalResume = useSettingsStore((s) => s.resumeRule);
  const projResume = useApprovalsStore((s) => (projectRoot ? s.resumeByRoot[projectRoot] : undefined));
  // VISIBLE gate (flag only): show the pane content regardless of credits, but tell the user when
  // the master toggle is off so a rule they set here won't fire.
  const featureOn = useAiFeatureVisible("autoApprove");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {!featureOn && (
        <div style={noticeBox}>
          Auto-approve is turned off. Rules below are saved but won't fire until you re-enable
          “Auto-approve prompts” under AI features.
        </div>
      )}
      {!projectRoot && (
        <div style={noticeBox}>
          No project is in focus, so “this project” rules aren't available — you can still set
          all-projects rules.
        </div>
      )}
      {APPROVAL_CATEGORIES.map((cat) => {
        const state = rowState(cat, globalMap, projMap);
        const isBash = cat === "bash";
        const muted = state.effective === "never";
        const alwaysGlobal = state.effective === "always" && state.scope === "global";
        const alwaysProject = state.effective === "always" && state.scope === "project";
        return (
          <div key={cat} style={row}>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: C.cream, fontWeight: FONT_WEIGHT.semibold, fontSize: 13 }}>
                  {capitalize(approvalCategoryLabel(cat))}
                </span>
                {isBash && (
                  <span style={warnPill} title="Auto-approving commands also approves destructive ones">
                    <FiAlertTriangle size={11} /> destructive
                  </span>
                )}
              </div>
              <span style={{ color: muted ? C.amber : C.muted, fontSize: 12 }}>
                {statusText(state)}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button
                type="button"
                style={btn(alwaysGlobal)}
                onClick={() => void setApprovalRule(cat, "always", "global", projectRoot)}
              >
                Yes: all projects
              </button>
              <button
                type="button"
                style={btn(alwaysProject)}
                disabled={!projectRoot}
                title={projectRoot ? undefined : "No project in focus"}
                onClick={() => void setApprovalRule(cat, "always", "project", projectRoot)}
              >
                Yes: this project
              </button>
              {state.effective !== undefined ? (
                <button
                  type="button"
                  style={btn(false)}
                  onClick={() => void removeApprovalRuleEverywhere(cat, projectRoot)}
                >
                  {muted ? "Un-mute" : "Remove"}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      {(() => {
        // Session-resume row. A SIBLING of the categories (its own value domain), so it renders as a
        // distinct block: two scope groups (all-projects / this-project), each a three-way mode
        // choice (Ask / Summary / Full). The effective value is the project override if one is set,
        // else the global. "This project" is disabled with no project in focus, mirroring the rows.
        const effProjResume: ResumeRule = projResume ?? globalResume;
        const overriding = projResume !== undefined && projResume !== globalResume;
        const effective = effProjResume;
        const scope: Scope = overriding ? "project" : effective !== "ask" ? "global" : null;
        return (
          <div key="__resume" style={{ ...row, borderBottom: "none", paddingBottom: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ color: C.cream, fontWeight: FONT_WEIGHT.semibold, fontSize: 13 }}>
                  Session resume
                </span>
                <span style={{ color: C.muted, fontSize: 12 }}>
                  {resumeStatusText(effective, scope)}
                </span>
              </div>
              <ResumeScopeGroup
                label="All projects"
                active={globalResume}
                onChoose={(rule) => void setResumeRule(rule, "global", projectRoot)}
              />
              <ResumeScopeGroup
                label="This project"
                active={effProjResume}
                disabled={!projectRoot}
                disabledTitle={projectRoot ? undefined : "No project in focus"}
                onChoose={(rule) => void setResumeRule(rule, "project", projectRoot)}
              />
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/** One scope's three-way resume choice (Ask / Summary / Full). `active` is the mode currently in
 *  effect for this scope; the matching button is highlighted. */
function ResumeScopeGroup({
  label,
  active,
  disabled,
  disabledTitle,
  onChoose,
}: {
  label: string;
  active: ResumeRule;
  disabled?: boolean;
  disabledTitle?: string;
  onChoose: (rule: ResumeRule) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ color: C.muted, fontSize: 11, minWidth: 78 }}>{label}</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {RESUME_CHOICES.map((rule) => (
          <button
            key={rule}
            type="button"
            style={btn(!disabled && active === rule)}
            disabled={disabled}
            title={disabled ? disabledTitle : undefined}
            onClick={() => onChoose(rule)}
          >
            {rule === DEFAULT_RESUME_RULE ? "Ask each time" : RESUME_RULE_LABEL[rule]}
          </button>
        ))}
      </div>
    </div>
  );
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  paddingBottom: 12,
  borderBottom: `1px solid ${C.forest}`,
};

const noticeBox: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  lineHeight: 1.5,
  background: C.forest,
  border: `1px solid ${C.barSurface}`,
  borderRadius: 8,
  padding: "8px 10px",
};

const warnPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  fontSize: 10,
  color: C.amber,
  border: `1px solid ${C.amber}`,
  borderRadius: 6,
  padding: "1px 5px",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

function btn(active: boolean): CSSProperties {
  return {
    background: active ? C.teal : "transparent",
    color: active ? "#ffffff" : C.cream,
    border: `1px solid ${active ? C.teal : C.muted}`,
    borderRadius: 7,
    padding: "5px 9px",
    fontSize: 12,
    fontFamily: '"IBM Plex Sans", sans-serif',
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}
