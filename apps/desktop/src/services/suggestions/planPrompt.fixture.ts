// Captured shapes of Claude Code's PLAN-EXIT prompt (v2.1.237), plus the near-misses a detector for
// it must refuse. Kept beside the tests rather than in `engine/capturedScreens.fixture.ts` because
// these are SUGGESTION-layer inputs (scrollback text handed to the picker parser), not whole-screen
// captures used to decide whether Claude Code owns the terminal.
//
// The option labels and both question texts are verbatim strings from the shipping 2.1.237 binary,
// so a build that renames them fails these tests rather than silently ceasing to auto-answer.

const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";

/** The prompt as it renders on an ordinary-width pane. */
export const PLAN_EXIT_PROMPT = [
  "⏺ I've written up the plan above.",
  "",
  "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "❯ 1. Yes, and use auto mode",
  "  2. Yes, manually approve edits",
  "  3. Tell Claude what to change",
  "",
  FOOTER,
].join("\n");

/** The same prompt with the question HARD-WRAPPED inside Ink's box borders — the shape a narrow
 *  side-by-side pane produces. A word-boundary regex run over the raw lines cannot match this, which
 *  is why the detector normalizes borders + whitespace before testing the question. */
export const PLAN_EXIT_PROMPT_WRAPPED = [
  "│ Claude has written up a plan and is ready to │",
  "│ execute. Would you like to proceed?          │",
  "│                                              │",
  "│ ❯ 1. Yes, and use auto mode                  │",
  "│   2. Yes, manually approve edits             │",
  "│   3. Tell Claude what to change              │",
  "│                                              │",
  `│ ${FOOTER} │`,
].join("\n");

/** Claude Code's OTHER plan question. A different decision — where to PUT the plan, not whether to
 *  run it — so the plan-exit rule must never answer it. */
export const PLAN_ARTIFACT_PROMPT = [
  "Claude has written up a plan. Would you like to review it as an artifact first?",
  "❯ 1. Yes, open it as an artifact",
  "  2. No, keep planning",
  "",
  FOOTER,
].join("\n");

/** The plan-exit question with the STICKY option present. Pressing it rewrites the session's
 *  default permission mode, which is a bigger decision than this one prompt, so it is never the
 *  option an auto-answer presses. */
export const PLAN_EXIT_PROMPT_STICKY = [
  "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "❯ 1. Yes, set auto mode as my default permission mode",
  "  2. Yes, manually approve edits",
  "  3. Tell Claude what to change",
  "",
  FOOTER,
].join("\n");

/** An ordinary permission prompt — the shape `classifyApproval` owns. Not a plan prompt. */
export const BASH_PERMISSION_PROMPT = [
  "Bash command",
  "  rm -rf build/",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for rm commands",
  "  3. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");

/** The plan-exit prompt with its affirmatives RENAMED — the shape Claude Code is most likely to ship
 *  next, since it has already renamed this option three times. `detectPlanPrompt` cannot answer it
 *  (no label matches), but it is unmistakably a plan, and every rule that keys on "is this a plan"
 *  rather than "can I answer it" must still hold. */
export const PLAN_EXIT_PROMPT_RENAMED = [
  "⏺ Step 1: delete the dead helper and its test.",
  "",
  "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "❯ 1. Yes, proceed automatically",
  "  2. Yes, review each edit",
  "  3. Tell Claude what to change",
  "",
  FOOTER,
].join("\n");

/** An UNRELATED picker drawn while the plan question is still within the ten-line window
 *  `pickerQuestionBlock` falls back to on a borderless dialog. Its own options are the roborev-63621
 *  shape: a neutral header over an irreversible act. Nothing here may be classified as a plan — the
 *  plan arm does not escalate `destructive`, so doing so would hand a force-push to the concierge. */
export const STALE_PLAN_QUESTION_OVER_ANOTHER_PICKER = [
  "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "⏺ Running the release step now.",
  "",
  "How should I proceed?",
  "❯ 1. Force push over origin/main",
  "  2. Open a PR instead",
  "",
  FOOTER,
].join("\n");

/** THE COMMON STALE CASE, and the one a shape-only corroboration could not see: the agent's very
 *  next act after a plan is answered is to run a command, so the ordinary bash permission prompt is
 *  drawn while the plan question is still inside `pickerQuestionBlock`'s ten-line fallback window.
 *  Its options are `Yes` / `Yes, and don't ask again…` / `No, and tell Claude…` — which satisfies
 *  "≥1 yes, ≥1 not-yes" exactly. Nothing here may be classified as a plan: doing so both takes the
 *  prompt away from `maybeAutoApprove` (so `bash = "always"` silently stops working) and swaps the
 *  five-class sweep for the plan arm, which does not escalate `rm -rf`. */
export const STALE_PLAN_QUESTION_OVER_BASH_PROMPT = [
  "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "⏺ Starting step 1.",
  "",
  "Bash command",
  "  rm -rf build/",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for rm commands",
  "  3. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");

/** The barest version of the same hazard: a plain Yes/No confirm under a stale plan question. */
export const STALE_PLAN_QUESTION_OVER_YES_NO = [
  "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "⏺ Starting step 1.",
  "",
  "Force push over origin/main?",
  "❯ 1. Yes",
  "  2. No",
  "",
  FOOTER,
].join("\n");

/** The stale case that ONLY the last-question rule can exclude: the picker below has an affirmative
 *  and no plain refusal — a plan-shaped option set — but its own ask is a different question. Being
 *  present in the fallback window is cheap; being the dialog's LAST question is not. */
export const STALE_PLAN_QUESTION_OVER_PLAN_SHAPED_PICKER = [
  "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "⏺ Starting step 1.",
  "",
  "Should I use the cached build?",
  "❯ 1. Yes, use the cache",
  "  2. Tell Claude what to change",
  "",
  FOOTER,
].join("\n");

/** Claude Code's OLDER plan shape, whose way out is a plain "No, keep planning". Deliberately NOT
 *  matched here — `conciergeEscalation.isPlanModeDialog` is the predicate written for that option
 *  triple, and it still recognises it in the router. Pinning the exclusion keeps the plain-refusal
 *  rule honest: it is what stops an ordinary permission prompt being read as a plan. */
export const PLAN_EXIT_PROMPT_OLD_SHAPE = [
  "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "❯ 1. Yes, and auto-accept edits",
  "  2. Yes, and manually approve edits",
  "  3. No, keep planning",
  "",
  FOOTER,
].join("\n");
