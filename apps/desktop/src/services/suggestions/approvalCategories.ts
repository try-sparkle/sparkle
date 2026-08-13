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

// --- Session resume (a SIBLING of the six categories, with its own value domain) --------------
// `[approvals].resume` lives in the same TOML section and rides the same per-project override
// machinery, but it is NOT an ApprovalCategory: its values are "ask" | "summary" | "full", not
// "always"/"never". Keeping it a separate type is deliberate so it never leaks into the category
// list, the classifier, or toApprovalMap.

/** How to answer the Claude Code session-resume prompt. "ask" = surface it (default);
 *  "summary" = auto-pick "Resume from summary"; "full" = auto-pick "Resume full session". */
export type ResumeRule = "ask" | "summary" | "full";

/** The default when the key is absent or unrecognized: stay hands-off. */
export const DEFAULT_RESUME_RULE: ResumeRule = "ask";

/** Narrow an arbitrary value (config / older backend) to a valid {@link ResumeRule}, else "ask". */
export function asResumeRule(v: unknown): ResumeRule {
  return v === "summary" || v === "full" || v === "ask" ? v : DEFAULT_RESUME_RULE;
}

/**
 * The complaint to surface when `[approvals].resume` holds a value this key does not accept, or null
 * when there is nothing to say.
 *
 * WHY THIS EXISTS. `resume` is a SIBLING of the approval categories with a DIFFERENT value domain:
 * the categories take "always"/"never", this one takes ask|summary|full. `asResumeRule` narrows
 * anything else to "ask" — the hands-off default — so writing the value that works for every
 * neighbouring key produces the exact OPPOSITE of the intent (the prompt is surfaced every restart)
 * with nothing anywhere saying so. The Rust side stores it as a bare `Option<String>` and validates
 * nothing, and the only warning is a comment in the config template you would have to already know
 * to look for. The founder hit precisely this with `resume = "always"`.
 *
 * Absent/empty is NOT a complaint — that is the documented default, not a mistake. This reports only
 * a value the user actually chose and that will silently not apply.
 */
export function resumeRuleComplaint(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (v === "summary" || v === "full" || v === "ask") return null;
  return (
    `[approvals].resume = ${JSON.stringify(v)} is not a valid value and was ignored ` +
    `(falling back to "${DEFAULT_RESUME_RULE}", which surfaces the prompt every time). ` +
    `Unlike the permission categories, resume does not take "always"/"never" — ` +
    `use "summary", "full", or "ask".`
  );
}

// --- Concierge routing (a SECOND sibling of the six categories, with its own value domain) ------
// `[approvals].concierge_answers` also lives in the same TOML section and rides the same
// per-project override machinery, but like `resume` it is NOT an ApprovalCategory: its domain is a
// plain boolean, not "always"/"never". Kept separate for the same reason — so it can never leak
// into the category list, the classifier, or toApprovalMap.
//
// WHY IT IS NOT `[ai].auto_approve`. That switch means "let a purely local REGEX press buttons
// without anyone reading them". Routing to the concierge is a DIFFERENT act: a reasoning agent
// reads the question first, then answers. One switch for both would mean that turning off the
// blind presser also silences the thing that reads — so they get two switches with two honest
// meanings. true (the default) hands the concierge the prompts the local classifier will not
// answer; false sends every one of them to the human, as they go today.

/** The default when the key is absent or holds a non-boolean: the concierge IS asked. On, because
 *  the problem this key addresses is prompts landing on the human that something else should have
 *  answered — so being asked is the safe state, not the adventurous one. */
export const DEFAULT_CONCIERGE_ANSWERS = true;

/** Narrow an arbitrary value (config / an older backend) to the concierge-routing flag.
 *
 *  Anything that is not a real boolean — `undefined` (an older Rust backend predating the key),
 *  `null` (serde's wire form for an absent optional), or a value the user typo'd — degrades to
 *  {@link DEFAULT_CONCIERGE_ANSWERS} rather than to `false`. Coercing junk to "off" would silently
 *  disable a feature nobody asked to disable; coercing it to the documented default is the same
 *  contract `asResumeRule` above keeps. */
export function asConciergeAnswers(v: unknown): boolean {
  return typeof v === "boolean" ? v : DEFAULT_CONCIERGE_ANSWERS;
}

/** The one friendly label per resume choice, as it reads in the approvals pane. */
export const RESUME_RULE_LABEL: Record<ResumeRule, string> = {
  ask: "Ask me each time",
  summary: "Resume from summary",
  full: "Resume full session",
};
