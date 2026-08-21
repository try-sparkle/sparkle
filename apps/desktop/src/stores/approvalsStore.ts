// Per-project EFFECTIVE auto-approve rules, keyed by project root path. `get_config(root)` already
// merges global + that project's `.sparkle/config.toml` + `.sparkle/local.toml` `[approvals]`
// (project wins per category, local wins over both), so
// each entry here is the fully-resolved effective map for one project. Populated + kept fresh by
// `useSyncProjectApprovals` (services/suggestions/approvalsRuntime). NOT persisted — config.toml is
// the source of truth; this is a live cache. See the design spec.
import { create } from "zustand";
import {
  asResumeRule,
  asPlanRule,
  DEFAULT_RESUME_RULE,
  DEFAULT_PLAN_RULE,
  type ApprovalCategory,
  type ApprovalMap,
  type ApprovalRule,
  type ResumeRule,
  type PlanRule,
} from "../services/suggestions/approvalCategories";

interface ApprovalsState {
  /** projectRoot → effective (project-over-global) approval rules. */
  byRoot: Record<string, ApprovalMap>;
  /** projectRoot → effective (project-over-global) session-resume rule. Sibling of `byRoot` with
   *  its own value domain ("ask"/"summary"/"full"). Absent root = fall back to the global mirror. */
  resumeByRoot: Record<string, ResumeRule>;
  /** projectRoot → effective (project-over-global) plan-exit rule. The second sibling of `byRoot`
   *  with its own value domain ("ask"/"auto"/"manual"). Absent root = fall back to the global. */
  planByRoot: Record<string, PlanRule>;
  /** Replace one project's effective map (from a fresh `get_config(root)` read). */
  setForRoot: (root: string, map: ApprovalMap) => void;
  /** Replace one project's effective resume rule (from a fresh `get_config(root)` read). */
  setResumeForRoot: (root: string, rule: ResumeRule) => void;
  /** Replace one project's effective plan-exit rule (from a fresh `get_config(root)` read). */
  setPlanForRoot: (root: string, rule: PlanRule) => void;
  /** Optimistically set/clear one category for a project (before the config round-trip lands). */
  setProjectApproval: (root: string, category: ApprovalCategory, rule: ApprovalRule | null) => void;
  /** Optimistically set a project's resume rule (before the config round-trip lands). */
  setProjectResume: (root: string, rule: ResumeRule) => void;
  /** Optimistically set a project's plan-exit rule (before the config round-trip lands). */
  setProjectPlan: (root: string, rule: PlanRule) => void;
}

export const useApprovalsStore = create<ApprovalsState>((set) => ({
  byRoot: {},
  resumeByRoot: {},
  planByRoot: {},
  setForRoot: (root, map) => set((s) => ({ byRoot: { ...s.byRoot, [root]: map } })),
  setResumeForRoot: (root, rule) =>
    set((s) => ({ resumeByRoot: { ...s.resumeByRoot, [root]: asResumeRule(rule) } })),
  setPlanForRoot: (root, rule) =>
    set((s) => ({ planByRoot: { ...s.planByRoot, [root]: asPlanRule(rule) } })),
  setProjectApproval: (root, category, rule) =>
    set((s) => {
      const next = { ...(s.byRoot[root] ?? {}) };
      if (rule) next[category] = rule;
      else delete next[category];
      return { byRoot: { ...s.byRoot, [root]: next } };
    }),
  setProjectResume: (root, rule) =>
    set((s) => ({ resumeByRoot: { ...s.resumeByRoot, [root]: asResumeRule(rule) } })),
  setProjectPlan: (root, rule) =>
    set((s) => ({ planByRoot: { ...s.planByRoot, [root]: asPlanRule(rule) } })),
}));

// Re-export so consumers of the store can grab the default without a second import path.
export { DEFAULT_RESUME_RULE, DEFAULT_PLAN_RULE };
