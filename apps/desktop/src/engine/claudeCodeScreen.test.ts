// Telling a BUSY CLAUDE CODE apart from an actual full-screen app (bead sparkle-v7k3y).
//
// The pair that matters is the whole test: Claude Code busy must be recognised, and `vim`/`less`/
// `htop`/`lazygit` must NOT be — including a pager displaying a file that talks ABOUT Claude Code,
// which is the content-heuristic fool `dictationTerminalRoute`'s header was right to worry about.
import { describe, expect, it } from "vitest";
import { claudeCodeMarkerFamilies, isClaudeCodeScreen } from "./claudeCodeScreen";
import { APPROVAL_2_1_220, IDLE_AFTER_TURN_2_1_220 } from "./capturedScreens.fixture";

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

  // ══ A PERMISSION DIALOG IS *NOT* RECOGNISED, AND THAT IS THE SAFE ANSWER ══════════════════════
  // Recorded rather than asserted the other way, because the honest reading of the captured screen
  // is what it is: APPROVAL_2_1_220 carries only the tool-call glyphs. The dialog REPLACES the
  // composer box and the chrome bars, and it prints no busy status — so exactly one family is
  // present and this returns false.
  //
  // That is the direction we want. `false` means "treat it as a full-screen app", so a write is
  // refused; and the picker guard would have refused it too. Both roads lead to a refusal, which is
  // correct for a screen whose highlighted button a submitted message would press. A future edit
  // that made this return `true` would be relying entirely on `screenBlocksWrite` to catch it —
  // safe today, but one guard deep instead of two. This row is here so that change has to be
  // deliberate.
  it("does not confidently recognise a permission dialog, so it stays refused", () => {
    expect(claudeCodeMarkerFamilies(APPROVAL_2_1_220)).toBe(1);
    expect(isClaudeCodeScreen(APPROVAL_2_1_220)).toBe(false);
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

  // The other half of the same rule: an underscore separator and a markdown blockquote must not be
  // able to FORM the box. Both were accepted by the first cut of RULE_LINE/PROMPT_LINE.
  it("rejects a document whose underscores and blockquote imitate the composer box", () => {
    const doc = [
      "Running things with ctrl+b to run in background is covered below.",
      "________________________________________",
      "> quoted advice from the manual",
      "________________________________________",
      ":",
    ].join("\n");
    expect(isClaudeCodeScreen(doc)).toBe(false);
  });

  it("rejects an empty screen", () => {
    expect(isClaudeCodeScreen("")).toBe(false);
  });
});
