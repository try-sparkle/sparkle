// Telling a BUSY CLAUDE CODE apart from an actual full-screen app (bead sparkle-v7k3y).
//
// The pair that matters is the whole test: Claude Code busy must be recognised, and `vim`/`less`/
// `htop`/`lazygit` must NOT be — including a pager displaying a file that talks ABOUT Claude Code,
// which is the content-heuristic fool `dictationTerminalRoute`'s header was right to worry about.
import { describe, expect, it } from "vitest";
import { claudeCodeMarkerFamilies, isClaudeCodeScreen } from "./claudeCodeScreen";
import { screenBlocksWrite } from "../voice/dictationTerminalRoute";
import { APPROVAL_2_1_220, IDLE_AFTER_TURN_2_1_220 } from "./capturedScreens.fixture";

// ══ THE FOUNDER'S SECOND SCREEN (bead sparkle-tbsvf) ═══════════════════════════════════════════
// RECONSTRUCTED from the concierge's own read of the Improve Sparkle pane, not a captured viewport
// — same provenance rule BUSY_RUNNING_COMMAND above follows and the same reason it lives here
// rather than in capturedScreens.fixture.ts. Claude Code's live roster of its own background
// subagents, drawn in place of the ordinary composer the same way a permission dialog is.
const BACKGROUND_TASK_LIST = [
  "⏺ main",
  "◯ general-purpose  Concierge agents as clickable rows  21m 55s",
  "◯ general-purpose  Trustworthy status dot: bg-task si… 10m 29s",
].join("\n");

// ══ THE FOUNDER'S SCREEN ════════════════════════════════════════════════════════════════════════
// RECONSTRUCTED from the screenshot in sparkle-v7k3y — NOT a captured viewport, which is why it
// lives here and not in `capturedScreens.fixture.ts` (that file's provenance note is a promise that
// every fixture in it came out of a real PTY capture, and quietly adding a hand-written screen would
// break it). The lines are transcribed from the screenshot; the surrounding chrome is taken from the
// captured IDLE_AFTER_TURN_2_1_220, which is a real capture of the same TUI.
const BUSY_RUNNING_COMMAND = [
  "⏺ I'll run the test suite and commit.",
  "",
  "  Running 1 shell command · 1m 24s",
  '  ⎿  $ cd ".../worktrees/.../pr1104" && bash scripts/tests/run.sh 2>&1 | tail -2 && git add … (1m 23s)',
  "     (ctrl+b to run in background)",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ manual mode on · ? for shortcuts",
].join("\n");

describe("isClaudeCodeScreen — the founder's busy agent is not an editor", () => {
  // THE HEADLINE ROW. This exact screen produced "Babysit PR 1104 has a full-screen app open, so
  // the keys would have run as commands" and bounced his message.
  it("recognises Claude Code running a shell command", () => {
    expect(isClaudeCodeScreen(BUSY_RUNNING_COMMAND)).toBe(true);
  });

  // Not on one lucky marker. Four families are present here; asserting the COUNT is what stops a
  // later edit from collapsing them into a single over-broad pattern that still returns true.
  it("recognises it on several independent families, not one", () => {
    expect(claudeCodeMarkerFamilies(BUSY_RUNNING_COMMAND)).toBeGreaterThanOrEqual(3);
  });

  it("recognises a real captured idle Claude Code screen", () => {
    expect(isClaudeCodeScreen(IDLE_AFTER_TURN_2_1_220)).toBe(true);
  });

  // ══ A PERMISSION DIALOG *IS* RECOGNISED NOW — AND THE WRITE IS STILL REFUSED ══════════════════
  //
  // THE DELIBERATE CHANGE THIS ROW ASKED FOR (bead sparkle-v7k3y, second occurrence). The previous
  // version asserted `families === 1` and `false`, reasoning that both roads lead to a refusal so
  // the wrong road costs nothing. It cost a great deal: the two roads produce DIFFERENT REFUSAL
  // CODES, and the code is what the human is shown. `alternate-screen` renders as "has a full-screen
  // app open — quit it", which on a permission dialog is both false and unfollowable. One afternoon
  // of it: nine consecutive refusals to one agent, four other agents blocked, and a fleet-wide
  // escalation storm telling the founder to quit editors that were never running.
  //
  // The old comment named the exact condition for making this deliberate — "relying entirely on
  // `screenBlocksWrite` to catch it, one guard deep instead of two" — so here is that check, made
  // explicit rather than assumed: `terminalWriteRefusal` runs `screenBlocksWrite` on the same text
  // immediately after this predicate, and it returns `awaiting-input` for this screen. Free text is
  // therefore STILL refused. What changes is only which refusal fires, and so what the human is
  // told: "answer the prompt on screen", which is true and actionable, instead of "quit vim", which
  // is neither.
  it("recognises a permission dialog as Claude Code", () => {
    expect(claudeCodeMarkerFamilies(APPROVAL_2_1_220)).toBeGreaterThanOrEqual(2);
    expect(isClaudeCodeScreen(APPROVAL_2_1_220)).toBe(true);
  });

  // THE GUARD THAT NOW CARRIES THE REFUSAL. If this ever goes false, the change above becomes a
  // hole rather than a correction — a submitted message would press the highlighted button.
  it("...and the write is still refused, by the guard that names the real obstacle", () => {
    expect(screenBlocksWrite(APPROVAL_2_1_220)).toBe(true);
  });

  // ══ THE BACKGROUND-TASK LIST IS ALSO NOT AN EDITOR (bead sparkle-tbsvf) ═════════════════════════
  // THE HEADLINE ROW. This exact screen produced four consecutive "has a full-screen app open"
  // refusals against `__sparkle_self__` while the pane was doing nothing but listing its own
  // background subagents — no editor, no pager, ordinary busy Claude Code.
  it("recognises Claude Code showing its own background-task list", () => {
    expect(isClaudeCodeScreen(BACKGROUND_TASK_LIST)).toBe(true);
  });

  // The list replaces the composer box (family D) the same way a permission dialog does, so it must
  // stand on its own rather than needing a corroborating family — pinning the count keeps a later
  // edit from silently making this depend on the composer box being present too.
  it("recognises it from the task-list family alone, with no composer box on screen", () => {
    expect(claudeCodeMarkerFamilies(BACKGROUND_TASK_LIST)).toBeGreaterThanOrEqual(1);
    expect(isClaudeCodeScreen(BACKGROUND_TASK_LIST)).toBe(true);
  });
});

// ══ THE REFUSAL THE BEAD REQUIRES US TO KEEP ════════════════════════════════════════════════════
// "KEEP the refusal for genuine full-screen programs (vim, less, htop, lazygit). That guard is
// correct and must not be weakened to fix this."
describe("isClaudeCodeScreen — genuine full-screen apps are not Claude Code", () => {
  it("rejects a vim session", () => {
    const vim = ["~", "~", "~", '"notes.md" 12L, 340B', ":"].join("\n");
    expect(isClaudeCodeScreen(vim)).toBe(false);
  });

  it("rejects a less pager", () => {
    const less = ["some file contents", "more contents", ":"].join("\n");
    expect(isClaudeCodeScreen(less)).toBe(false);
  });

  it("rejects htop", () => {
    const htop = [
      "  1  [||||||     30.0%]   Tasks: 210, 900 thr; 2 running",
      "  Mem[|||||||    5.2G/16G]  Load average: 1.20 0.98 0.84",
      "  PID USER      PRI  NI  VIRT   RES   CPU% MEM%   TIME+  Command",
      " F1Help  F2Setup  F3Search  F9Kill  F10Quit",
    ].join("\n");
    expect(isClaudeCodeScreen(htop)).toBe(false);
  });

  it("rejects lazygit", () => {
    const lazygit = [
      "┌─Status──────────┐┌─Files───────────────────────────┐",
      "│ repo → main     ││ M apps/desktop/src/App.tsx      │",
      "└─────────────────┘└─────────────────────────────────┘",
    ].join("\n");
    expect(isClaudeCodeScreen(lazygit)).toBe(false);
  });

  // ══ THE CONTENT-HEURISTIC FOOL, STATED AS A TEST ══════════════════════════════════════════════
  // A pager showing THIS VERY BEAD, or any doc quoting Claude's status bar, trips exactly one family
  // and must not be enough. This is the case the two-family rule exists for — a single-marker
  // implementation passes every other test in this file and fails here.
  it("rejects a pager displaying a document that quotes Claude Code's status bar", () => {
    const paging = [
      "The guard sees the alternate screen and refuses. Claude Code draws",
      '"esc to interrupt" while it works, and offers ctrl+b to run in background.',
      "That is why the refusal fires on the most common state in the app.",
      ":",
    ].join("\n");
    expect(claudeCodeMarkerFamilies(paging)).toBeLessThan(2);
    expect(isClaudeCodeScreen(paging)).toBe(false);
  });

  // The mirror of the row above: prose bullets must not be read as Claude's gutter glyphs.
  it("rejects a document containing a mid-line tool glyph", () => {
    const doc = ["We saw ⏺ in the output and then ⎿ appeared.", "Nothing else happened.", ":"].join(
      "\n",
    );
    expect(isClaudeCodeScreen(doc)).toBe(false);
  });

  // ══ THE BACKGROUND-TASK LIST HAS THE SAME QUOTING HAZARD FAMILY D/E ALREADY GUARD AGAINST ══════
  // (bead sparkle-tbsvf). A pager showing a document that quotes the founder's screenshot — this
  // bead itself is exactly such a document — must not be read as a LIVE task list. Position is the
  // discriminator: the pager keeps its own trailing prompt below the quoted rows, which is neither
  // blank nor Claude's ambient chrome, so `hasBackgroundTaskList`'s below-footer walk rejects it.
  it("rejects a pager showing a document that quotes the background-task list", () => {
    const paging = [
      "⏺ main",
      "◯ general-purpose  Concierge agents as clickable rows  21m 55s",
      "That screen produced four consecutive refusals.",
      ":",
    ].join("\n");
    // Family B still fires on the line-start `⏺` — one family, same as the status-bar fool above —
    // proving family F's rejection is doing real positional work rather than the glyph simply
    // failing to match at all.
    expect(claudeCodeMarkerFamilies(paging)).toBe(1);
    expect(isClaudeCodeScreen(paging)).toBe(false);
  });

  // ══ THE TWO-FAMILY DOCUMENT FOOL (roborev 57704) ═════════════════════════════════════════════
  // The rows above each trip ONE family, which a flat "any two of four" rule would also have caught.
  // THIS one trips TWO — line-start ⏺/⎿ glyphs AND a quoted status bar — and it is a pager showing a
  // pasted Claude Code transcript, not Claude Code. It is why the composer box is mandatory rather
  // than merely one vote: a document reproduces Claude's output easily and its live input box not at
  // all. A build that dropped the box requirement passes every other test here and fails this one.
  it("rejects a pager showing a pasted Claude Code transcript", () => {
    const transcript = [
      "⏺ I'll run the test suite.",
      "  ⎿  $ bash scripts/tests/run.sh",
      "     … esc to interrupt",
      "notes.md (END)",
      ":",
    ].join("\n");
    expect(claudeCodeMarkerFamilies(transcript)).toBeGreaterThanOrEqual(2);
    expect(isClaudeCodeScreen(transcript)).toBe(false);
  });

  // ══ ONE NARROWING PER TEST (roborev 57718) ═══════════════════════════════════════════════════
  // These were ONE test, and it was vacuous in the exact way this repo keeps finding: it combined
  // underscore rules with a `> quoted` middle line, so reverting EITHER pattern alone still left no
  // box and the test stayed green. It only failed if both were reverted at once — an assertion that
  // passes against the code as it was before the change. Split so each narrowing is ratcheted by a
  // fixture that isolates it.

  // (a) Underscore rules around a LONE `>` — the middle line matches PROMPT_LINE's bare arm, so the
  // only thing standing between this and a false positive is `_` being absent from RULE_LINE.
  it("rejects a document whose underscore separators imitate the composer rules", () => {
    const doc = [
      "⏺ quoted from a transcript",
      "________________________________________",
      ">",
      "________________________________________",
      ":",
    ].join("\n");
    expect(isClaudeCodeScreen(doc)).toBe(false);
  });

  // (b) REAL box-drawing rules around a markdown blockquote — the rules are genuine, so the only
  // thing standing between this and a false positive is bare `>` being absent from PROMPT_LINE's
  // with-text arm.
  it("rejects a document whose blockquote sits between real box rules", () => {
    const doc = [
      "⏺ quoted from a transcript",
      "────────────────────────────────────────",
      "> quoted advice from the manual",
      "────────────────────────────────────────",
      ":",
    ].join("\n");
    expect(isClaudeCodeScreen(doc)).toBe(false);
  });

  it("rejects an empty screen", () => {
    expect(isClaudeCodeScreen("")).toBe(false);
  });
});
