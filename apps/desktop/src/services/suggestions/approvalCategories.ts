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

// --- Plan exit (a THIRD sibling of the six categories, with its own value domain) --------------
// `[approvals].plan` lives in the same TOML table and rides the same per-project override
// machinery, but — like `resume` — it is NOT an ApprovalCategory: its values are
// "ask" | "auto" | "manual", not "always"/"never".
//
// THE PROMPT IT ANSWERS. When a Claude Code agent finishes writing a plan it stops on:
//
//     Claude has written up a plan and is ready to execute. Would you like to proceed?
//       1. Yes, and use auto mode
//       2. Yes, manually approve edits
//       3. Tell Claude what to change
//
// and waits. `classifyApproval` refuses it BY CONSTRUCTION — `looksLikePermission` demands a plain
// "Yes" AND a "No", and this dialog has neither (every affirmative is a "Yes, and …" continuation).
// That refusal is correct and stays: a blind Approve press on a continuation option is exactly the
// hazard `optionText`'s comment records. So the answer is not to loosen the classifier but to give
// this ONE question its own detector and its own rule — matched by its QUESTION TEXT, never by
// option number, since "1." labels identical menus across completely different questions.
//
// WHY IT DEFAULTS ON, unlike `resume`. An unanswered plan prompt is not a neutral pause: the agent
// has already done the thinking and simply sits, indefinitely, until a human presses a key. That
// blocked a real PR for hours with a complete and correct diagnosis already on screen. The cost of
// the default being wrong is small and self-correcting (the agent executes a plan it just wrote,
// under the same approval rules everything else runs under); the cost of no default is a stalled
// fleet. Opting out is one key — `plan = "ask"` — or the [ai].auto_approve master switch.

/** How to answer Claude Code's plan-exit prompt. "auto" = pick "Yes, and use auto mode" (default);
 *  "manual" = pick "Yes, manually approve edits"; "ask" = surface it and let the human decide. */
export type PlanRule = "ask" | "auto" | "manual";

/** The default when the key is absent or unrecognized: proceed into auto mode. See the note above
 *  for why this sibling defaults ON where `resume` defaults to "ask".
 *
 *  ONE INTERACTION WORTH KNOWING, because "auto mode" is not scoped to this one prompt: Claude Code
 *  keeps it for the rest of the session, so it stops emitting edit prompts entirely. Under Sparkle's
 *  own shipped config that changes nothing — every `[approvals]` category already ships `"always"`,
 *  so those prompts were being auto-answered anyway. It DOES matter if you have set a category to
 *  `"never"` to get its prompts back: auto mode would remove them again. `plan = "manual"` is the
 *  setting for that — it ends the stall just as well and leaves your per-category rules in force. */
export const DEFAULT_PLAN_RULE: PlanRule = "auto";

/** Narrow an arbitrary value (config / older backend) to a valid {@link PlanRule}, else the
 *  default. Junk degrades to the DOCUMENTED default rather than to the strictest value, the same
 *  contract `asResumeRule` and `asConciergeAnswers` keep. */
export function asPlanRule(v: unknown): PlanRule {
  return v === "ask" || v === "auto" || v === "manual" ? v : DEFAULT_PLAN_RULE;
}

/**
 * The complaint to surface when `[approvals].plan` holds a value this key does not accept, or null
 * when there is nothing to say.
 *
 * Same reasoning as {@link resumeRuleComplaint}: `plan` is a SIBLING of the categories with a
 * DIFFERENT value domain, so writing the value that works for every neighbouring key
 * (`plan = "always"`) silently narrows to the default with nothing anywhere saying so. Absent/empty
 * is not a complaint — that is the documented default, not a mistake.
 */
export function planRuleComplaint(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (v === "ask" || v === "auto" || v === "manual") return null;
  return (
    `[approvals].plan = ${JSON.stringify(v)} is not a valid value and was ignored ` +
    `(falling back to "${DEFAULT_PLAN_RULE}"). Unlike the permission categories, plan does not ` +
    `take "always"/"never" — use "auto", "manual", or "ask".`
  );
}

/** The one friendly label per plan choice, as it reads in the approvals pane. */
export const PLAN_RULE_LABEL: Record<PlanRule, string> = {
  ask: "Ask me each time",
  auto: "Proceed in auto mode",
  manual: "Proceed, approve edits",
};
