// Captured Claude Code ONBOARDING screens — TEST-ONLY fixtures.
//
// The sibling of `capturedScreens.fixture.ts`, and it carries the SAME provenance promise: every
// screen here is a verbatim, unedited slice of a real rendered xterm viewport, not a hand-written
// approximation. (Reconstructions live in `incidentScreens.fixture.ts` instead — read that file's
// header for why the three are kept apart.)
//
// PROVENANCE — captured 2026-08-12 against Claude Code **2.1.229** (`~/.local/bin/claude`), by the
// recipe `capturedScreens.fixture.ts` documents, with the scripts that automate it:
//   1. `scripts/capture-claude-onboarding.py` / `scripts/capture-claude-passive.py` drive `claude`
//      in a PTY at 120x40, TERM=xterm-256color, and log every byte it renders;
//   2. `scripts/replay-screen-log.mjs` replays that byte log through a HEADLESS xterm and dumps the
//      visible grid with `line.translateToString(true)`, trailing spaces trimmed — byte-for-byte the
//      surface `snapshotScreen()` (engine/screenSnapshot.ts) hands the classifier in production;
//   3. `scripts/scan-screen-log.mjs` finds the byte offset at which a given screen was on the grid,
//      which is what makes a screen recoverable AFTER the TUI has overwritten it.
//
// That third step is the one worth knowing about. Onboarding screens are transient — each is erased
// by the next — but a byte log holds every frame the TUI ever drew, so replaying a PREFIX of the log
// reconstructs a screen exactly as it stood. SECURITY_NOTES_2_1_229 below was on screen for a few
// hundred bytes before being erased; it is recovered by cutting the replay at that frame.
//
// Onboarding only runs against a config directory that has not completed it, so these were captured
// against a THROWAWAY copy of a config dir with `hasCompletedOnboarding` cleared. The real config was
// never modified. Each slice drops what sat ABOVE it — the ASCII-art welcome banner, and on the
// security screen the preceding "Logged in as <email>" line, which carries an account name.
//
// WHY THIS EXISTS: the picker detector was wrong in BOTH directions on these screens, and neither
// defect is visible without them.
//   • `read_picker_options` answered `present: false, blind: "no-menu"` on THEME and LOGIN_METHOD —
//     real, live menus. The option parser is anchored on a picker FOOTER, and neither screen draws
//     one: the menu's only live marker is the `❯` selection cursor.
//   • The reverse on SECURITY_NOTES: its two NUMBERED PROSE BULLETS parse as a 1,2 option run, and
//     its closing "Press Enter to continue…" satisfied `asksChoice` (whose keyword list holds both
//     "press" and "enter"), so a prose screen read as a two-option menu and `send_control_key`
//     refused `enter` as `ambiguous-picker` — the exact keystroke the screen is asking for.
// Re-capture with the scripts above when Claude Code's onboarding moves.

/** The FIRST onboarding screen: the theme picker. Seven numbered options and a `❯` selection
 *  cursor, and NO picker footer anywhere — the diff preview below the options is a live sample of
 *  the theme, not a hint bar. This is the screen `read_picker_options` called `no-menu`. */
export const ONBOARDING_THEME_PICKER_2_1_229 = [
  " Let's get started.",
  "",
  " Choose the text style that looks best with your terminal",
  " To change this later, run /theme",
  "",
  "   1. Auto (match terminal)",
  " ❯ 2. Dark mode ✔",
  "   3. Light mode",
  "   4. Dark mode (colorblind-friendly)",
  "   5. Light mode (colorblind-friendly)",
  "   6. Dark mode (ANSI colors only)",
  "   7. Light mode (ANSI colors only)",
  "",
  " ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  "  1  function greet() {",
  '  2 -  console.log("Hello, World!");',
  '  2 +  console.log("Hello, Claude!");',
  "  3  }",
  " ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
].join("\n");

/** The SECOND onboarding screen: "Select login method". Three numbered options, a `❯` cursor, and
 *  again no footer — the screen simply ends at its last option. The founder's report of an agent
 *  "visibly showing Claude Code's onboarding menus" with no attention dot is this screen. */
export const ONBOARDING_LOGIN_METHOD_2_1_229 = [
  " Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.",
  "",
  " Select login method:",
  "",
  " ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise",
  "   2. Anthropic Console account · API usage billing",
  "   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI",
].join("\n");

/**
 * The security screen shown once onboarding completes — PROSE, not a menu, and the one that locked
 * an agent behind the single key that frees it.
 *
 * Everything the false positive needs is here and all of it is ordinary text: two bullets numbered
 * "1." and "2." (which `MENU_LINE` cannot tell from option rows), and a closing line carrying BOTH
 * of `asksChoice`'s keywords, "press" and "enter". There is no `❯` cursor and no footer — nothing
 * that marks a real selection — yet the generic menu path read a two-option menu and
 * `send_control_key` then refused `enter` as `ambiguous-picker`.
 *
 * Note the bullets are NOT adjacent to the prompt: prose continuation lines sit between them, which
 * a real option block never has.
 */
export const SECURITY_NOTES_2_1_229 = [
  " Security notes:",
  "",
  " 1. Claude can make mistakes.",
  "    You're responsible for Claude's actions and should always",
  "    review them, especially when running code.",
  "",
  " 2. Due to prompt injection risks, only use it with code you trust",
  "    Learn more: https://code.claude.com/docs/en/security",
  "",
  " Press Enter to continue…",
].join("\n");

/** The login-SUCCESS screen that immediately precedes {@link SECURITY_NOTES_2_1_229}. Kept because
 *  it is a second, independent instance of the same "Press Enter to continue…" prompt — this one
 *  with no numbered lines above it at all — so a test can show the guard turns on the PROMPT rather
 *  than on anything particular to the security screen. The "Logged in as <email>" line above it is
 *  dropped: it carries an account name. */
export const LOGIN_SUCCESS_CONTINUE_2_1_229 = [" Login successful. Press Enter to continue…"].join(
  "\n",
);
