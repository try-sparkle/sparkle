// Per-project EFFECTIVE auto-approve rules, keyed by project root path. `get_config(root)` already
// merges global + that project's `.sparkle/config.toml [approvals]` (project wins per category), so
// each entry here is the fully-resolved effective map for one project. Populated + kept fresh by
// `useSyncProjectApprovals` (services/suggestions/approvalsRuntime). NOT persisted — config.toml is
// the source of truth; this is a live cache. See the design spec.
import { create } from "zustand";
import type { ApprovalCategory, ApprovalMap, ApprovalRule } from "../services/suggestions/approvalCategories";

interface ApprovalsState {
  /** projectRoot → effective (project-over-global) approval rules. */
  byRoot: Record<string, ApprovalMap>;
  /** Replace one project's effective map (from a fresh `get_config(root)` read). */
  setForRoot: (root: string, map: ApprovalMap) => void;
  /** Optimistically set/clear one category for a project (before the config round-trip lands). */
  setProjectApproval: (root: string, category: ApprovalCategory, rule: ApprovalRule | null) => void;
}

export const useApprovalsStore = create<ApprovalsState>((set) => ({
  byRoot: {},
  setForRoot: (root, map) => set((s) => ({ byRoot: { ...s.byRoot, [root]: map } })),
  setProjectApproval: (root, category, rule) =>
    set((s) => {
      const next = { ...(s.byRoot[root] ?? {}) };
      if (rule) next[category] = rule;
      else delete next[category];
      return { byRoot: { ...s.byRoot, [root]: next } };
    }),
}));
