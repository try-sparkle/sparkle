// THE TERMINAL-DELIVERY LAYER'S OWN QUESTION ABOUT A SCREEN (bead sparkle-d6a5r).
//
// These cases run the REAL detector and the REAL marker-family counter — nothing here is mocked —
// because the whole claim being tested is about what actual Claude Code screens and actual
// full-screen programs produce. A mocked `detectTerminalPrompts` would make every case below assert
// its own fixture.
//
// WHAT THIS PREDICATE IS FOR, and the boundary it must not cross: it is NOT a permission. Its two
// call sites (`conciergeDispatch` and `terminalWriteRefusal`) each pair it with `screenBlocksWrite`,
// which is what makes the reclassification incapable of delivering a write that was previously
// refused. The dispatcher-level pair in `conciergeDispatch.altScreen.test.ts` pins that interlock;
// this file pins the predicate itself.
import { describe, expect, it } from "vitest";
import { altScreenEvidence, claudeCodeDialogOnScreen } from "./claudeCodeDialogScreen";
import { isClaudeCodeScreen } from "./claudeCodeScreen";
import {
  APPROVAL_2_1_220,
  IDLE_AFTER_TURN_2_1_220,
  LESS_ON_A_MARKDOWN_FILE,
  MODEL_PICKER_2_1_220,
  VIM_ON_A_MARKDOWN_FILE,
} from "./capturedScreens.fixture";

/** The reported shape, reconstructed: a Bash-permission dialog whose `↑↓ to select · Enter to
 *  confirm` footer is NOT drawn — a column too short for the whole box. Family E recognises a dialog
 *  by POSITION (its footer must terminate the grid), so this one falls through it, scores 1 on the
 *  tool-call glyph alone, fails `isClaudeCodeScreen`'s `>= 2`, and used to be reported as `vim`.
 *  Every captured approval fixture in this repo DOES draw its footer, which is why the suite has
 *  never had a case for the screen the bead was filed about. */
const PERMISSION_DIALOG_NO_FOOTER = [
  "⏺ Bash(git status --short)",
  "  ⎿  M apps/desktop/src/services/conciergeDispatch.ts",
  "",
  "╭───────────────────────────────────────────────╮",
  "│ Bash command                                  │",
  "│                                               │",
  "│   git push origin HEAD                        │",
  "│   Push the branch                             │",
  "│                                               │",
  "│ Do you want to proceed?                       │",
  "│ ❯ 1. Yes                                      │",
  "│   2. Yes, and don't ask again                 │",
  "│   3. No, and tell Claude what to do differently│",
  "╰───────────────────────────────────────────────╯",
].join("\n");

describe("claudeCodeDialogOnScreen", () => {
  // THE CASE THE BEAD IS ABOUT, stated as the pair that makes it a bug rather than a preference:
  // the shared predicate says "not Claude Code" and this one says "a live dialog". Asserting the
  // second alone would pass just as well on a screen the shared predicate already handles, which
  // would make it a test of nothing.
  it("recognises a permission dialog the shared predicate misses", () => {
    expect(isClaudeCodeScreen(PERMISSION_DIALOG_NO_FOOTER)).toBe(false);
    expect(claudeCodeDialogOnScreen(PERMISSION_DIALOG_NO_FOOTER)).toBe(true);
  });

  // ── THE IMPOSTORS, which are the reason the predicate needs two signals and not one ───────────
  // `vim` fills the grid with `~` and `less` draws its own status row: neither produces a menu for
  // the detector, and neither carries a single Claude Code marker family. If either of these ever
  // goes green, the reclassification has become a way into an editor.
  it("rejects a real editor", () => {
    expect(claudeCodeDialogOnScreen(VIM_ON_A_MARKDOWN_FILE)).toBe(false);
  });
  it("rejects a real pager", () => {
    expect(claudeCodeDialogOnScreen(LESS_ON_A_MARKDOWN_FILE)).toBe(false);
  });

  // An idle Claude Code prompt is not a DIALOG — there is no question on it. It is already
  // recognised by the shared predicate, so this arm must not fire for it; a version of this
  // predicate that returned true whenever a Claude marker was present would pass every case above
  // and fail this one.
  it("does not call an idle Claude Code prompt a dialog — there is no menu on it", () => {
    expect(isClaudeCodeScreen(IDLE_AFTER_TURN_2_1_220)).toBe(true);
    expect(claudeCodeDialogOnScreen(IDLE_AFTER_TURN_2_1_220)).toBe(false);
  });

  // The captured dialogs the shared predicate ALREADY handles agree with this one. They are not
  // what the fix is for, but a disagreement between the two on a screen both can see would be the
  // "two detectors disagreeing about one terminal" failure this file's neighbours keep hitting.
  it("agrees with the shared predicate on the dialogs it already recognises", () => {
    for (const screen of [APPROVAL_2_1_220, MODEL_PICKER_2_1_220]) {
      expect(isClaudeCodeScreen(screen)).toBe(true);
      expect(claudeCodeDialogOnScreen(screen)).toBe(true);
    }
  });
});

describe("altScreenEvidence", () => {
  // THE DIAGNOSABLE RECORD. Six occurrences of this bead were unreproducible because the refusal
  // logged nothing but an agent id, so the shape of this object IS the deliverable.
  it("reports the structural facts a refusal was decided on", () => {
    const e = altScreenEvidence(PERMISSION_DIALOG_NO_FOOTER, true, 2);
    expect(e).toMatchObject({
      alternateBuffer: true,
      markerFamilies: 1,
      composerBox: false,
      recognisedAsClaudeCode: false,
      scrollbackOptions: 2,
      dialogOnScreen: true,
    });
    expect(e.viewportOptions).toBeGreaterThan(0);
    expect(e.rows).toBeGreaterThan(0);
  });

  // NEVER THE SCREEN TEXT. A refused screen is by construction one sitting at a prompt, and some of
  // those prompts are credential fields that echo nothing — so an evidence record carrying the
  // viewport would write a password into the app log. Asserted over the SERIALISED object rather
  // than field by field, so a field added later is covered without anyone remembering to add it.
  it("carries no screen text, so a credential field cannot reach the log", () => {
    const secret = "hunter2-do-not-log-me";
    const e = altScreenEvidence(`$ sudo -v\n[sudo] password for x: ${secret}`, false, 0);
    expect(JSON.stringify(e)).not.toContain(secret);
    expect(JSON.stringify(e)).not.toContain("sudo");
  });
});
