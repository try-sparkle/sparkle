// Captured shapes of Claude Code's FOLDER-TRUST dialog, plus the near-misses a detector for it must
// refuse. Beside the tests rather than in `engine/capturedScreens.fixture.ts` for the same reason
// `planPrompt.fixture` is: these are SUGGESTION-layer inputs (scrollback text handed to the picker
// parser), not whole-screen captures used to decide who owns the terminal.
//
// The question and both option labels are verbatim from the shipping binary, so a build that renames
// them fails these tests rather than silently ceasing to auto-answer.

const FOOTER = "Enter to confirm · Esc to exit";

/** THE REAL DIALOG, exactly as an agent spawning into a fresh Sparkle worktree meets it. */
export const FOLDER_TRUST_PROMPT = [
  "Quick safety check: Is this a project you created or one you trust? (Like your own code,",
  "a well-known open source project, or work from your team). If not, take a moment to review",
  "what's in this folder first.",
  "Claude Code'll be able to read, edit, and execute files here.",
  "❯ 1. Yes, I trust this folder",
  "  2. No, exit",
  "",
  FOOTER,
].join("\n");

/** The same dialog with the workspace path printed under the question — the shape that lets the
 *  path be reconciled against the agent's recorded worktree rather than merely assumed. */
export function folderTrustPromptFor(path: string): string {
  return [
    "Quick safety check: Is this a project you created or one you trust? (Like your own code,",
    "a well-known open source project, or work from your team). If not, take a moment to review",
    "what's in this folder first.",
    path,
    "Claude Code'll be able to read, edit, and execute files here.",
    "❯ 1. Yes, I trust this folder",
    "  2. No, exit",
    "",
    FOOTER,
  ].join("\n");
}

/** The dialog HARD-WRAPPED inside Ink's box borders — the shape a narrow side-by-side pane draws.
 *  A word-boundary regex run over the raw lines cannot match this, which is why the detector
 *  normalizes borders + whitespace before testing the question. */
export const FOLDER_TRUST_PROMPT_WRAPPED = [
  "│ Quick safety check: Is this a project you │",
  "│ created or one you trust? (Like your own  │",
  "│ code, a well-known open source project.)  │",
  "│                                           │",
  "│ ❯ 1. Yes, I trust this folder             │",
  "│   2. No, exit                             │",
  "│                                           │",
  `│ ${FOOTER} │`,
].join("\n");

/** The rows REORDERED. Matching by ordinal would press "No, exit" here; matching by LABEL answers
 *  correctly. This is the fixture that makes "never by option number" a tested property rather than
 *  a comment. */
export const FOLDER_TRUST_PROMPT_REORDERED = [
  "Quick safety check: Is this a project you created or one you trust?",
  "Claude Code'll be able to read, edit, and execute files here.",
  "❯ 1. No, exit",
  "  2. Yes, I trust this folder",
  "",
  FOOTER,
].join("\n");

/** A trust dialog whose only affirmative widens PAST this one folder. Pressing it hands Claude Code
 *  a standing allowlist that outlives the worktree, which is a bigger decision than the one being
 *  asked — so nothing may press it and the prompt is surfaced instead. */
export const FOLDER_TRUST_PROMPT_STICKY = [
  "Quick safety check: Is this a project you created or one you trust?",
  "Claude Code'll be able to read, edit, and execute files here.",
  "❯ 1. Yes, and trust every folder in this directory",
  "  2. No, exit",
  "",
  FOOTER,
].join("\n");

/** An ordinary bash permission prompt. Not a trust dialog — and it must keep reaching
 *  `maybeAutoApprove`, or wiring this backstop in would silently break `bash = "always"`. */
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

/** THE STALE CASE: the agent's very next act after trusting a folder is to run a command, so the
 *  ordinary permission prompt is drawn while the trust question is still inside
 *  `pickerQuestionBlock`'s ten-line borderless fallback window. Nothing here may read as a trust
 *  dialog — doing so would take the prompt away from `maybeAutoApprove` AND press a keystroke
 *  chosen for a different question. */
export const STALE_TRUST_QUESTION_OVER_BASH_PROMPT = [
  "Quick safety check: Is this a project you created or one you trust?",
  "⏺ Right, starting work.",
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

/** The dialog with NO FOOTER ROW. Claude Code does not always draw one, and without it
 *  `pickerQuestionBlock` falls back to a fixed ten-line window and the option parser falls back to
 *  the cursor-anchored run. Both fallbacks have to carry this dialog or the backstop is inert on
 *  whichever builds omit the footer — a difference nothing in the question text would reveal. */
export const FOLDER_TRUST_PROMPT_NO_FOOTER = [
  "Quick safety check: Is this a project you created or one you trust? (Like your own code,",
  "a well-known open source project, or work from your team). If not, take a moment to review",
  "what's in this folder first.",
  "Claude Code'll be able to read, edit, and execute files here.",
  "❯ 1. Yes, I trust this folder",
  "  2. No, exit",
].join("\n");

/** THE FULLY-BOXED SHAPE, with the workspace path on its own bordered row — the hardest input the
 *  path reader has to survive, and the one that carries Sparkle's real app-data dir with the SPACE
 *  in "Application Support". A reader that scans tokens instead of whole lines returns
 *  ".../Library/Application" here, which then fails the containment test and silently declines. */
export function boxedFolderTrustPromptFor(path: string): string {
  return [
    "╭──────────────────────────────────────────────────────────╮",
    "│ Quick safety check: Is this a project you created or one │",
    "│ you trust?                                               │",
    "│                                                          │",
    `│ ${path} │`,
    "│                                                          │",
    "│ Claude Code'll be able to read, edit, and execute files. │",
    "│                                                          │",
    "│ ❯ 1. Yes, I trust this folder                            │",
    "│   2. No, exit                                            │",
    "╰──────────────────────────────────────────────────────────╯",
  ].join("\n");
}
