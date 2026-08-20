// A BLOCKED CLAUDE CODE IS STILL CLAUDE CODE (bead sparkle-v7k3y, second occurrence).
//
// THE FIELD SYMPTOM. One agent was refused `alternate-screen` NINE TIMES across several hours; the
// same refusal blocked four other agents and the concierge itself, twice. None was in vim, less or
// htop on any attempt — each was plainly Claude Code, sometimes idle, sometimes mid-command, once
// on an ordinary permission dialog. The founder hit it from the other side and reported it as
// "Improve Sparkle has a full-screen app open", resolved by moving his cursor out of that row.
//
// WHY IT WAS THE RECOGNISER AND NOT THE VIEWPORT. `terminalWriteRefusal` returns `no-viewport` on
// its FIRST line when the pane is unmounted, and `alternate-screen` only on the second — so a
// refusal carrying that code proves a viewport WAS read. The screen was there; the predicate said
// it was not Claude Code.
//
// THE CAUSE, already written down in `services/conciergeDispatch`'s own comments before anyone
// connected it to this refusal: `isClaudeCodeScreen` REQUIRED the composer box, and Claude Code's
// permission dialog REPLACES the composer box. The one marker held to be proof of a live TUI is the
// one the TUI removes while it has a question up, so the guard was hardest exactly when the agent
// was blocked and a human most needed to reach it.
//
// These tests pin the recogniser against the captured 2.1.220 screens — the dialogs it must now
// accept, and the impostors it must still refuse.

import { describe, it, expect } from "vitest";
import { isClaudeCodeScreen, claudeCodeMarkerFamilies } from "./claudeCodeScreen";
import { AMBIENT_CHROME_LINE } from "../services/sessionLimitScreen";
import {
  APPROVAL_2_1_220,
  APPROVAL_OPTION_2_2_1_220,
  ASK_USER_QUESTION_2_1_220,
  MODEL_PICKER_2_1_220,
  SESSION_LIMIT_PICKER,
  IDLE_AFTER_TURN_2_1_220,
  PERSISTENT_CHROME_TAIL_2_1_220,
} from "./capturedScreens.fixture";

/** The composition the real grid produces: a dialog, with Claude's persistent chrome beneath it. */
const withChrome = (dialog: string) => `${dialog}\n${PERSISTENT_CHROME_TAIL_2_1_220}`;

describe("a live dialog is evidence of Claude Code, not of a full-screen app", () => {
  // THE EXACT SCREEN FROM THE FIELD REPORT — "once sitting on an ordinary permission dialog".
  // Against the pre-fix recogniser every one of these returned false and the write was refused.
  it.each([
    ["the Bash approval dialog", APPROVAL_2_1_220],
    ["the same dialog with 'No' highlighted", APPROVAL_OPTION_2_2_1_220],
    ["an AskUserQuestion picker", ASK_USER_QUESTION_2_1_220],
    ["the /model picker", MODEL_PICKER_2_1_220],
    ["the session-limit picker", SESSION_LIMIT_PICKER],
  ])("recognises %s", (_label, dialog) => {
    expect(isClaudeCodeScreen(dialog)).toBe(true);
    expect(isClaudeCodeScreen(withChrome(dialog))).toBe(true);
  });

  // The state the module was originally written for must not regress.
  it("still recognises the idle composer box", () => {
    expect(isClaudeCodeScreen(IDLE_AFTER_TURN_2_1_220)).toBe(true);
  });

  // ══ THE 2.1.231 BAR IS AMBIENT CHROME (roborev 64564, Medium — but see the correction) ════════
  // `AMBIENT_CHROME_LINE`'s glyph class carried 2.1.220's ▶ and not the ⏵ that 2.1.231
  // draws (`capturedScreens.fixture.ts:271`, `:314`), and this is the walk families E and F depend
  // on — so the gap is real and is fixed alongside the narrow arm's own class, in the same change
  // as its `nudge_gate.rs` port.
  //
  // THE REVIEW'S ASSERTED CONSEQUENCE DID NOT REPRODUCE, and that is recorded here rather than
  // quietly dropped. The finding predicted that an approval dialog or /model picker under this bar
  // would be REFUSED at 120 columns. Measured against the shipped code with the glyph removed:
  // `AMBIENT_CHROME_LINE.test(bar)` flips to false, but `nothingUnrecognizedBelowFooter` still
  // returns true for both fixtures and `isClaudeCodeScreen` stays true — the appended bar is not
  // the row the walk stops on. So a dialog-level assertion here CANNOT fail on this defect: it
  // would be exactly the vacuous test AGENTS.md calls the #1 fleet-wide finding. The fix is pinned
  // where it can actually go red — on the predicate itself, below, and on the Rust port's own
  // `the_2_1_231_ambient_bar_is_chrome_in_both_spellings`, both mutation-verified.
  const CHROME_TAIL_2_1_231 = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";
  it.each([
    ["the 2.1.231 spelling", CHROME_TAIL_2_1_231],
    ["the 2.1.220 spelling", "  ▶▶ bypass permissions on (shift+tab to cycle)"],
  ])("reads %s of the persistent bar as ambient chrome", (_label, bar) => {
    expect(AMBIENT_CHROME_LINE.test(bar)).toBe(true);
  });

  // ══ THE IMPOSTORS ═════════════════════════════════════════════════════════════════════════════
  //
  // A false positive here is a line PASTED AND SUBMITTED into whatever owns the screen, so the
  // widening above has to keep every one of these out. The discriminator is POSITION: a live dialog
  // TERMINATES the grid, while a document quoting one has more document below it.

  it("refuses a pager showing a transcript of a dialog", () => {
    // Every lexical marker Claude draws — the glyphs, the option rows, the footer — inside a file
    // someone is paging through. `less` draws its own status row at the bottom, which is not
    // Claude's ambient chrome, so the footer does not terminate the grid.
    const paged = [APPROVAL_2_1_220, "", "(END)", ":"].join("\n");
    expect(isClaudeCodeScreen(paged)).toBe(false);
  });

  it("refuses a transcript that continues below the footer", () => {
    const quoted = [
      APPROVAL_2_1_220,
      "",
      "…and that is how the approval dialog looks. The next section covers permissions rules,",
      "which you can edit in settings.json.",
    ].join("\n");
    expect(isClaudeCodeScreen(quoted)).toBe(false);
  });

  it("refuses vim", () => {
    const vim = ["", "1 fn main() {", '2     println!("hello");', "3 }", "~", "~", '"src/main.rs" 3L, 42B'].join("\n");
    expect(isClaudeCodeScreen(vim)).toBe(false);
    expect(claudeCodeMarkerFamilies(vim)).toBe(0);
  });

  it("refuses htop, whose key bar carries no <key> to <verb> hints", () => {
    const htop = [
      "  1  [||||      12.5%]   Tasks: 213, 1041 thr; 1 running",
      "  Mem[||||||   4.20G/16.0G]   Load average: 2.31 1.98 1.77",
      "",
      "  PID USER      PRI  NI  VIRT   RES   CPU% MEM%   TIME+  Command",
      " 1234 drodio     20   0 4096M  512M    2.1  3.2  0:12.34 node",
      "F1Help  F2Setup  F3Search  F4Filter  F5Tree  F6SortBy  F9Kill  F10Quit",
    ].join("\n");
    expect(isClaudeCodeScreen(htop)).toBe(false);
  });

  it("refuses an empty screen", () => {
    expect(isClaudeCodeScreen("")).toBe(false);
    expect(isClaudeCodeScreen("\n\n   \n")).toBe(false);
  });
});
