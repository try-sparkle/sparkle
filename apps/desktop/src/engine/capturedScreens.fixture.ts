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

/** The five rows Claude Code's live grid ENDS in, lifted verbatim from the tail of
 *  {@link IDLE_AFTER_TURN_2_1_220}: a rule, the empty composer caret, a rule, and TWO status bars.
 *
 *  Exported because they render below ANY live dialog, which makes them the below-footer input that
 *  matters — and no captured picker carries them (every one terminates at its own footer), so the
 *  "live dialog with real chrome under it" case was untestable without composing the two. That gap
 *  is why the below-footer vocabulary could be narrowed twice, each time rejecting a live pressable
 *  picker, with the whole suite green both times (roborev 59946). */
export const PERSISTENT_CHROME_TAIL_2_1_220 = [
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PERS…",
  "  ⏸ manual mode on · ? for shortcuts",
].join("\n");

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
