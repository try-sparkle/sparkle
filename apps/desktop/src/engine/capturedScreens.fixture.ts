// Captured Claude Code TUI screens — TEST-ONLY fixtures, imported by the consumers of
// PICKER_FOOTER (engine/screenClassifier, services/suggestions/heuristics,
// services/suggestions/approvalClassifier) so all of them are pinned against the SAME real
// screens and cannot drift apart on what a picker looks like.
//
// PROVENANCE — these are not hand-written. Each is the rendered xterm viewport of a real
// `claude` session, captured 2026-07-28 by:
//   1. driving Claude Code **2.1.220** (~/.local/share/claude/versions/2.1.220) in a PTY via
//      `expect`, 120x40, TERM=xterm-256color, `--permission-mode manual`;
//   2. logging every byte it rendered;
//   3. replaying that byte log through a headless xterm and dumping the visible grid with
//      `line.translateToString(true)` — byte-for-byte the surface `snapshotScreen()`
//      (engine/screenSnapshot.ts) hands the classifier in production, trailing spaces trimmed.
// Each fixture is a verbatim, unedited slice of one such viewport. The only thing dropped is
// what sat ABOVE the slice: the welcome banner (it carries the account name) and, on the
// transcript screens, the echoed prompt line. No line inside a slice is edited or reflowed.
//
// WHY THIS EXISTS: `PICKER_FOOTER`'s approval arm anchored on the literal pair "esc to cancel"
// … "ctrl+e to explain". `strings` on the 2.1.220 binary reports **zero** occurrences of
// "ctrl+e to explain" (and zero of "Tab to amend"), which reads as proof the footer had
// drifted — it has not. The binary is a Bun bundle that assembles that line from fragments at
// render time, and 2.1.220 draws it verbatim (APPROVAL_2_1_220 below). Absence in `strings` is
// not evidence about the UI; only a captured screen is. Re-capture with the recipe above when
// Claude Code's TUI moves.

/** Bash-command permission dialog, highlighted option = 1 ("Yes"). */
export const APPROVAL_2_1_220 = [
  "⏺ I'll run that command.",
  "",
  "  Running 1 shell command…",
  "  ⎿  $ touch probe_ok.txt",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   touch probe_ok.txt",
  "   Create empty probe_ok.txt file",
  "",
  " Permission rule Bash requires confirmation for this command.",
  " /permissions to update rules",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

/** The same dialog after ↓ — the highlighted option is "No", NOT the amendable "Yes".
 *  2.1.220 KEEPS "Tab to amend" here; older builds dropped it. Anchoring the marker on that
 *  segment is exactly the mistake this fixture pair exists to prevent. */
export const APPROVAL_OPTION_2_2_1_220 = [
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   touch probe_three.txt",
  "   Create empty probe_three.txt file",
  "",
  " Permission rule Bash requires confirmation for this command.",
  " /permissions to update rules",
  "",
  " Do you want to proceed?",
  "   1. Yes",
  " ❯ 2. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
  "",
].join("\n");

/** AskUserQuestion picker — the "standard selection menu" footer shape. */
export const ASK_USER_QUESTION_2_1_220 = [
  "⏺ I'll ask you now.",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Color ",
  "",
  "Which color do you prefer?",
  "",
  "❯ 1. Red",
  "     You prefer red.",
  "  2. Blue",
  "     You prefer blue.",
  "  3. Type something.",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

/** The `/model` picker. Its footer is a THIRD wording — no "Enter to select", no "ctrl+e to
 *  explain" — which is why the footer marker has to be matched by SHAPE and not by literals. */
export const MODEL_PICKER_2_1_220 = [
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Select model",
  "   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, ",
  "   specify with --model.",
  "",
  "   ❯ 1. Default (recommended) ✔  Opus 5 with 1M context · Best for everyday, complex tasks",
  "     2. Opus (1M context)        Opus 5 with 1M context · Best for everyday, complex tasks",
  "     3. Fable                    Fable 5 · Most capable for your hardest and longest-running tasks",
  "     4. Sonnet                   Sonnet 5 · Efficient for routine tasks",
  "     5. Haiku                    Haiku 4.5 · Fastest for quick answers",
  "",
  "   ● High effort (default) ←/→ to adjust",
  "",
  "   Use /fast to turn on Fast mode (Opus 5).",
  "",
  "   Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

/** A FINISHED turn sitting at the idle input box. Must stay gray. Note the two persistent
 *  chrome lines at the bottom: both carry a "·" separator, and neither is a picker footer. */
export const IDLE_AFTER_TURN_2_1_220 = [
  " ⚠ 1 MCP server needs authentication · run /mcp",
  "",
  "❯ Reply with exactly: hello. Nothing else.                                                                              ",
  "",
  "⏺ hello",
  "",
  "✻ Churned for 3s",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PERS…",
  "  ⏸ manual mode on · ? for shortcuts",
].join("\n");

/** The five rows Claude Code's live grid ENDS in: a rule, the empty composer caret, a rule, and TWO
 *  status bars.
 *
 *  DERIVED from {@link IDLE_AFTER_TURN_2_1_220}, never hand-copied. A copy would claim to be
 *  "verbatim" while nothing kept it so: this file's stated procedure is to RE-CAPTURE these screens
 *  when Claude Code's TUI moves, and a re-capture that changed a status bar or a rule width would
 *  leave the copy behind as SYNTHETIC rows corresponding to no real screen — with the tests that
 *  depend on it still green against them. That is the same partial-copy-drift failure recorded for
 *  the below-footer walk itself (roborev 59690), and it would re-create the exact condition that let
 *  two below-footer narrowings ship green: a guard running on invented chrome.
 *
 *  Exported because these rows render below ANY live dialog, while every captured picker terminates
 *  AT its own footer — so composing the two is the only way to exercise the below-footer walk. */
export const PERSISTENT_CHROME_TAIL_2_1_220 = IDLE_AFTER_TURN_2_1_220.split("\n")
  .slice(-5)
  .join("\n");

/**
 * Claude Code's SESSION-LIMIT picker — the screen the founder's whole fleet was parked on while
 * every row still read green (PRD/sparkle/claude-account-identity-truth.md §6).
 *
 * PROVENANCE DIFFERS from the four screens above, and the difference matters. Those are xterm
 * replays of sessions driven on demand; this one cannot be produced on demand, because producing it
 * means exhausting a real account's session window. It is transcribed from the founder's 2026-08-04
 * screenshot as recorded in §6 of that PRD — with the de-fanging that document applies REVERSED, so
 * the glyphs and footer here are the ones the real TUI draws (`U+276F`, "Enter to confirm · Esc to
 * cancel") rather than the doc's neutered stand-ins. Re-capture it properly with the recipe at the
 * top of this file the next time a session limit is hit under a PTY log.
 *
 * ON THE LIVE TRIGGER IN THIS FILE: yes, this fixture classifies TRUE, and so does APPROVAL_2_1_220
 * under `screenAwaitsInput` — that exposure is not new. It is also bounded for THIS screen in a way
 * it is not for the others: `isSessionLimitPicker` is bottom-anchored and is only ever run against
 * the settle-time viewport, so reading, diffing or `cat`ing this file cannot trip it (the content
 * below the block keeps printing, so the footer is never the last line on the grid).
 */
export const SESSION_LIMIT_PICKER = [
  "⏺ Let me check the test suite.",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " Session limit reached",
  "",
  " What do you want to do?",
  " ❯ 1. Stop and wait for limit to reset",
  "   2. Switch to usage credits",
  "   3. Switch to Team plan",
  "",
  " Enter to confirm · Esc to cancel",
].join("\n");

/** More picker footers Claude Code 2.1.220 can draw. PROVENANCE DIFFERS from the screens above:
 *  these are string literals read out of the 2.1.220 bundle, not captured viewports, so they are
 *  evidence of what the TUI *can* render rather than of one session. The first is the diff/review
 *  approval bar — a blocking approval whose footer the old literal-anchored marker did not match
 *  either, i.e. a second false-calm case this change closes. */
export const OTHER_PICKER_FOOTERS_2_1_220 = [
  "Enter to approve · r to retry · ↑/↓ to navigate · Esc to cancel",
  "↑/↓ to navigate · Enter to select · ←/→ to switch · Esc to cancel",
  "←/→ to switch · ↑/↓ to navigate · Enter to select · Esc to close",
  "←/→ to switch · ↓ to select · Esc to cancel",
  "↑/↓ to navigate · enter to resume as a background session · esc to close",
  "← or → to adjust · Del to remove limit",
];

/** Ambient chrome and prose that carry "·"-separated hints but are NOT a blocking picker. The
 *  first entry is the persistent permission-mode bar recorded in
 *  PRD/sparkle/agent-status-truthfulness.md; the rest are literals lifted from the 2.1.220
 *  bundle. A footer marker that matches ANY of these pins every agent red forever. */
export const NON_PICKER_HINT_LINES_2_1_220 = [
  "▶▶ bypass permissions on (shift+tab to cycle) · PR #730 · esc to interrupt",
  "  ⏸ manual mode on · ? for shortcuts",
  "Claude is using your computer · press Esc to stop",
  "Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c twice quits",
  "Update installed · Restart to apply",
  "Usage credits are off · /usage-credits to turn them on",
  "Your org is out of usage · add funds to continue",
  "Fast mode is now available · /fast to turn on",
  "Connect Claude to your IDE · /ide",
  " ⚠ 1 MCP server needs authentication · run /mcp",
];

// ══ CAPTURED FROM CLAUDE CODE 2.1.231 ═══════════════════════════════════════════════════════════
// Everything above was captured at 2.1.220/2.2.1, where the composer is only ever EMPTY. These four
// were captured the same way (a real pty stream replayed through `@xterm/headless` and this repo's
// own `snapshotScreen`) to cover the composer WITH CONTENT, plus the two full-screen apps the guard
// exists to refuse. See `claudeCodeScreen.composerBody.test.ts`.
/** A LIVE Claude Code 2.1.231 whose composer HOLDS AN UNSUBMITTED MESSAGE that wrapped onto a
 *  second row — the exact production shape behind bead sparkle-v7k3y's third occurrence.
 *
 *  Captured by replaying a real `claude` pty stream through `@xterm/headless` and this repo's own
 *  `snapshotScreen`, not hand-written. THE POINT: the composer box here is FOUR rows —
 *
 *      ──────────…──────────      the opening rule
 *      ❯ Please give me an update on where you are with the alternate screen investigation, …
 *        open yet and what is still outstanding before it can land on main.
 *      ──────────…──────────      the closing rule
 *
 *  — because Claude Code soft-wraps the composer's own contents. Every screen captured at 2.1.220
 *  has an EMPTY composer, so it is always the tight rule/❯/rule sandwich, and `hasComposerBox` was
 *  written to that. This is the same affordance with a message in it. */
export const CLAUDE_COMPOSER_WRAPPED_TEXT_2_1_231 = [
  "",
  " ▐▛███▜▌   Claude Code v2.1.231",
  "▝▜█████▛▘  Opus 5 (1M context) · Claude Max",
  "  ▘▘ ▝▝    ~/…/worktrees/ed5d0ece-8a38-4649-9f7c-0ab6203a7467/fbe6b1ec-0d5c-48a6-848d-8a80be3d8765",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "                                                                                                       ● high · /effort",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ Please give me an update on where you are with the alternate screen investigation, and let me know whether the PR is",
  "  open yet and what is still outstanding before it can land on main.",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

/** The same 2.1.231 composer holding a SHORT unsubmitted message — one that fits on one row.
 *  Claude Code still reserves a blank row beneath it, so the box is four rows rather than three:
 *
 *      ──────────…──────────
 *      ❯ Think carefully then explain backpropagation in exactly 3 sentences.
 *                                  ← reserved, blank
 *      ──────────…──────────
 *
 *  Kept ALONGSIDE the wrapped case because the two interior shapes differ — a blank row and a
 *  continuation row — and a fix that handled only one of them would leave the other refused. */
export const CLAUDE_COMPOSER_PADDED_TEXT_2_1_231 = [
  "",
  " ▐▛███▜▌   Claude Code v2.1.231",
  "▝▜█████▛▘  Opus 5 (1M context) · Claude Max",
  "  ▘▘ ▝▝    ~/…/worktrees/ed5d0ece-8a38-4649-9f7c-0ab6203a7467/fbe6b1ec-0d5c-48a6-848d-8a80be3d8765",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ Think carefully then explain backpropagation in exactly 3 sentences.",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

/** A REAL `vim` session, captured from a pty exactly like the Claude Code screens above.
 *  This is the screen the alternate-screen guard EXISTS to refuse: typed text here runs as
 *  normal-mode commands. It must never satisfy `isClaudeCodeScreen`. */
export const VIM_ON_A_MARKDOWN_FILE = [
  "<!-- BEGIN:nextjs-agent-rules -->",
  "# This is NOT the Next.js you know",
  "",
  "This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.",
  "<!-- END:nextjs-agent-rules -->",
  "",
  "# Parallelize aggressively — time is the only scarce resource",
  "",
  "**Optimize for wall-clock time, not token or compute spend.** Burning 10× the tokens to finish in a",
  "fifth of the time is a win, every time — treat compute as free and time as the only thing you can't",
  "get back. This is the founder's explicit priority.",
  "",
  "**Fan out by default; serial is the exception you must justify.** The moment work splits into",
  "independent units, spawn a concurrent agent for each — one per unit, immediately. Do not do N",
  "independent things yourself in sequence when N agents could do them at once. Do not \"spin up a few",
  "and wait to see how it goes\" — **saturate the whole independent backlog in one move.** When you are",
  "unsure whether to spawn, spawn. There is no such thing as too many agents while they are on",
  "independent work.",
  "",
  "The **only two** reasons to hold back — both real, neither about cost:",
  "",
  "- **File collision.** Two units editing the same file(s) produce conflicts and duplicated work — the",
  "  most expensive recurring failure in this repo. Scope each agent to a **disjoint** set of files, or",
  "  sequence only the overlapping pair. Never idle the rest of the fleet for a clash that involves just",
  "  two of them.",
  "- **Shared-resource contention.** Parallel agents collide on shared state; two rules make it vanish.",
  "  **(1)** Give each agent its **own** fresh worktree — `git worktree add -b <name> <path> origin/main`",
  "  — **on a named branch, never `--detach`.** A detached HEAD is a ref-less checkout, so its commits",
  "\"AGENTS.md\" 1061L, 78092B",
].join("\n");

/** A REAL `less` session on the same file. The adversarial case this module's header names: the
 *  document being paged is AGENTS.md, which QUOTES Claude Code's own chrome — so a content
 *  heuristic that keyed on wording alone could be fooled by it. It must stay refused. */
export const LESS_ON_A_MARKDOWN_FILE = [
  "<!-- BEGIN:nextjs-agent-rules -->",
  "# This is NOT the Next.js you know",
  "",
  "This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.",
  "<!-- END:nextjs-agent-rules -->",
  "",
  "# Parallelize aggressively — time is the only scarce resource",
  "",
  "**Optimize for wall-clock time, not token or compute spend.** Burning 10× the tokens to finish in a",
  "fifth of the time is a win, every time — treat compute as free and time as the only thing you can't",
  "get back. This is the founder's explicit priority.",
  "",
  "**Fan out by default; serial is the exception you must justify.** The moment work splits into",
  "independent units, spawn a concurrent agent for each — one per unit, immediately. Do not do N",
  "independent things yourself in sequence when N agents could do them at once. Do not \"spin up a few",
  "and wait to see how it goes\" — **saturate the whole independent backlog in one move.** When you are",
  "unsure whether to spawn, spawn. There is no such thing as too many agents while they are on",
  "independent work.",
  "",
  "The **only two** reasons to hold back — both real, neither about cost:",
  "",
  "- **File collision.** Two units editing the same file(s) produce conflicts and duplicated work — the",
  "  most expensive recurring failure in this repo. Scope each agent to a **disjoint** set of files, or",
  "  sequence only the overlapping pair. Never idle the rest of the fleet for a clash that involves just",
  "  two of them.",
  "- **Shared-resource contention.** Parallel agents collide on shared state; two rules make it vanish.",
  "  **(1)** Give each agent its **own** fresh worktree — `git worktree add -b <name> <path> origin/main`",
  "  — **on a named branch, never `--detach`.** A detached HEAD is a ref-less checkout, so its commits",
  "AGENTS.md",
].join("\n");


/** A LIVE Claude Code 2.1.231 holding a PASTED message that has not been submitted — the state
 *  `services/conciergeDispatch` itself creates when a paste lands and the submit does not.
 *
 *  TWO THINGS MAKE THIS ITS OWN FIXTURE. The composer body is four rows (so it needs the bounded
 *  body `hasComposerBox` grew), AND the persistent chrome bar is GONE: Claude Code replaces it with
 *  the transient `paste again to expand` hint. That left the composer box as the ONLY family on a
 *  screen that is unmistakably Claude Code, so the mandatory-box-plus-one-corroborator rule failed
 *  at `>= 2` and the screen was refused `alternate-screen` anyway — the original defect surviving
 *  its own fix, one condition further down. */
export const CLAUDE_COMPOSER_PASTED_TEXT_2_1_231 = [
  "",
  " ▐▛███▜▌   Claude Code v2.1.231",
  "▝▜█████▛▘  Opus 5 (1M context) · Claude Max",
  "  ▘▘ ▝▝    ~/…/worktrees/ed5d0ece-8a38-4649-9f7c-0ab6203a7467/fbe6b1ec-0d5c-48a6-848d-8a80be3d8765",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "                                                                                                       ● high · /effort",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ [Pasted text #1]found, what you changed, which tests you added, whether the PR is open, what CI says, and what",
  "  remains outstanding before it can land on main. Please give me a detailed update on the alternate screen",
  "  investigation including what you found, what you changed, which tests you added, whether the PR is open, what CI",
  "  says, and what remains outstanding before it can land on main.",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  paste again to expand",
].join("\n");

// ══ CAPTURED FROM CLAUDE CODE 2.1.237 — THE FIVE PERMISSION-MODE CHROME BARS ════════════════════
// Captured 2026-08-20 by the recipe at the top of this file: a real `claude` pty stream at 120x40,
// TERM=xterm-256color, one session per `--permission-mode`, replayed through `@xterm/headless` and
// dumped with `line.translateToString(true)` — the exact surface `snapshotScreen()` hands the
// classifier. Each slice starts at the first row below the welcome box and is otherwise unedited;
// the `❯` line's trailing character is a NON-BREAKING SPACE, verbatim, because that is what Ink
// draws.
//
// ══ WHY THESE FIVE, AND WHY THEY ARE THE REGRESSION ═════════════════════════════════════════════
// `claudeCodeScreen`'s family C matched two mode literals — `bypass permissions on` and `manual mode
// on`. Both are ALIVE at 2.1.237 (see the two constants below that carry them), which is why this
// rotted silently: the versions an agent was most likely to be checked against still passed. The
// three modes Claude Code has ADDED since — plan, accept edits, auto — match nothing, and plan's bar
// drops `? for shortcuts` as well, so family C scores ZERO on them. A composer box alone is 1, the
// threshold is 2, and every agent in those modes is refused as an unrecognised full-screen program:
// `terminalWriteRefusal` answers `alternate-screen`, `read_picker_options` goes blind, and the row
// renders "Needs you" over a pane with nothing in it.
//
// SO THE LESSON IS THE ONE THIS FILE'S HEADER ALREADY STATES, ONE LEVEL UP: a `strings` sweep of the
// 2.1.237 binary reports ZERO occurrences of `bypass permissions on` and `manual mode on` — both of
// which this capture proves it draws. The bundle composes those bars from fragments at render time.
// Only a captured screen is evidence. Re-capture all five when Claude Code's TUI moves.
export const PLAN_MODE_COMPOSER_2_1_237 = [
  "                                                                                                      ● high · /effort",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ plan mode on (shift+tab to cycle) · ← for agents",
].join("\n");

export const PLAN_MODE_SETTLED_2_1_237 = [
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ plan mode on (shift+tab to cycle) · ← for agents",
].join("\n");

export const ACCEPT_EDITS_COMPOSER_2_1_237 = [
  "                                                                                                      ● high · /effort",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
].join("\n");

export const BYPASS_COMPOSER_2_1_237 = [
  "                                                                                                      ● high · /effort",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ Try \"edit <filepath> to...\"",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");

export const MANUAL_MODE_COMPOSER_2_1_237 = [
  "                                                                                                      ● high · /effort",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ manual mode on · ? for shortcuts · ← for agents",
].join("\n");

