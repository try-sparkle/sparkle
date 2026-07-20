// Single source of truth for the Sparkle Auto-Approve category taxonomy and its friendly labels.
// EVERY consumer (classifier, nudge, confirmation toast, approvals pane, config mirror) imports the
// type + label map from here so the six categories and their user-facing words can never drift.
// See the design spec: docs/superpowers/specs/2026-07-10-sparkle-auto-approve-design.md

/** The class of Claude Code permission prompt a remembered answer covers. A rule is by-category
 *  (a whole class of prompt), never one exact target — see the spec's "Decisions (locked)". */
export type ApprovalCategory = "skill" | "bash" | "edit" | "mcp" | "fetch" | "other";

/** Every category, in the order the approvals pane lists them. */
export const APPROVAL_CATEGORIES: readonly ApprovalCategory[] = [
  "skill",
  "bash",
  "edit",
  "mcp",
  "fetch",
  "other",
] as const;

/** The one friendly label per category, plural, as it reads in a sentence ("Auto-approve all
 *  {label} next time?"). Defined ONCE here; imported everywhere so wording stays consistent. */
export const APPROVAL_CATEGORY_LABEL: Record<ApprovalCategory, string> = {
  skill: "skills",
  bash: "commands",
  edit: "file edits",
  mcp: "tool calls",
  fetch: "web requests",
  other: "other prompts",
};

/** Convenience accessor with a stable fallback (an unknown/future id degrades to its raw value
 *  rather than rendering "undefined"). */
export function approvalCategoryLabel(cat: ApprovalCategory): string {
  return APPROVAL_CATEGORY_LABEL[cat] ?? cat;
}

/** A remembered per-category rule. `"always"` = auto-approve; `"never"` = ask but stop nudging.
 *  Absent (undefined) = ask + nudge (the default). */
export type ApprovalRule = "always" | "never";

/** The effective per-category rule map (project overrides global; absent key = ask + nudge). */
export type ApprovalMap = Partial<Record<ApprovalCategory, ApprovalRule>>;

/** Narrow an arbitrary string (from config / an older backend) to a valid rule, or undefined. */
export function asApprovalRule(v: unknown): ApprovalRule | undefined {
  return v === "always" || v === "never" ? v : undefined;
}

/** Build a clean {@link ApprovalMap} from a raw config `[approvals]` object (whose values may be
 *  null / unknown strings / absent). Only valid "always"/"never" entries survive. */
export function toApprovalMap(
  raw: Partial<Record<ApprovalCategory, string | null>> | undefined,
): ApprovalMap {
  const map: ApprovalMap = {};
  if (!raw) return map;
  for (const cat of APPROVAL_CATEGORIES) {
    const rule = asApprovalRule(raw[cat]);
    if (rule) map[cat] = rule;
  }
  return map;
}
