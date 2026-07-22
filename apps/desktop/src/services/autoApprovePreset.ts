// The two "quick preset" scopes offered under the ⋯-menu "Auto-answer permission prompts" toggle.
// A preset is nothing more than a batch of `[approvals]` "always" rules, so the EXISTING auto-answer
// runtime (approvalsRuntime.maybeAutoApprove) enacts it — there is deliberately NO separate launch
// flag / --permission-mode path. That is what lets "everything except commands" exist at all: the
// launch-flag route (--dangerously-skip-permissions) is all-or-nothing, whereas the per-category
// engine can auto-approve five classes of prompt and still let bash (commands) ask.
//
// Pure module (no Tauri / store imports) so the taxonomy + derivation stay unit-testable and can't
// drift from APPROVAL_CATEGORIES. The write action lives in configActions.ts; the UI in AiFeaturesMenu.
import {
  APPROVAL_CATEGORIES,
  type ApprovalCategory,
  type ApprovalMap,
} from "./suggestions/approvalCategories";

/** "except-bash" auto-approves every category BUT commands (bash), which keep prompting; "full"
 *  auto-approves everything including commands. */
export type AutoApprovePreset = "except-bash" | "full";

/** Every category except bash (commands) — the set "except-bash" turns on. Derived from the single
 *  APPROVAL_CATEGORIES source so it can never drift if a category is added/removed. */
export const NON_BASH_CATEGORIES: readonly ApprovalCategory[] = APPROVAL_CATEGORIES.filter(
  (c) => c !== "bash",
);

/** The exact set of categories a preset sets to "always" (full = all; except-bash = all but bash). */
export function categoriesForPreset(preset: AutoApprovePreset): readonly ApprovalCategory[] {
  return preset === "full" ? APPROVAL_CATEGORIES : NON_BASH_CATEGORIES;
}

/** Which preset (if any) a global approval map currently matches, for highlighting the active choice:
 *   - "full"        ⇔ every category is "always".
 *   - "except-bash" ⇔ every non-bash category is "always" AND bash is UNSET (so commands still ask).
 *     A bash rule of "never" (muted) is intentionally NOT a match — that is a hand-tuned state, not
 *     this preset, so it reads as custom.
 *   - null          ⇔ anything else: a partial or per-category set from the granular Auto-approve
 *     pane. Neither preset highlighted ("custom").
 */
export function autoApprovePresetOf(map: ApprovalMap): AutoApprovePreset | null {
  const allAlways = (cats: readonly ApprovalCategory[]) => cats.every((c) => map[c] === "always");
  if (allAlways(APPROVAL_CATEGORIES)) return "full";
  if (allAlways(NON_BASH_CATEGORIES) && map.bash === undefined) return "except-bash";
  return null;
}
