// ONE FIXTURE CORPUS, BOTH RECOGNIZERS — bead sparkle-phb1h (c).
//
// ══ WHY THIS FILE EXISTS ═══════════════════════════════════════════════════════════════════════
// Two predicates independently answer "is this Claude Code?", against different bars and for
// different callers:
//
//   • `isClaudeCodeScreen`  (claudeCodeScreen.ts)      — may I TYPE here? Composer box mandatory
//                                                        plus a corroborating family, because a
//                                                        false positive pastes AND SUBMITS a line
//                                                        into a pager.
//   • `claudeCodeDialogOnScreen` (claudeCodeDialogScreen.ts) — is a LIVE DIALOG holding the screen?
//                                                        A viewport menu plus one marker family.
//
// They were reconciled only by prose, and they drifted: the auto-resume ladder read the FIRST one's
// `false` as "a pager or an editor owns this terminal", escalated a human, and latched the goal.
// Measured three times on 2026-08-20 against ordinary Claude Code panes (bead sparkle-phb1h).
// `altScreenRefusalVerdict` is the third reader, and the one that has to agree with both.
//
// ══ WHAT IS PINNED ═════════════════════════════════════════════════════════════════════════════
// The invariants are stated over the corpus rather than per fixture, so a fixture added to
// `capturedScreens.fixture.ts` is covered the day it lands instead of the day someone remembers to
// write a row for it. Each `expect` names the rule, because a bare `expected false to be true` on a
// generated row is unreadable at the moment it fires.
import { describe, expect, it } from "vitest";

import {
  APPROVAL_2_1_220,
  APPROVAL_OPTION_2_2_1_220,
  ASK_USER_QUESTION_2_1_220,
  BYPASS_COMPOSER_2_1_237,
  CLAUDE_COMPOSER_PADDED_TEXT_2_1_231,
  CLAUDE_COMPOSER_PASTED_TEXT_2_1_231,
  CLAUDE_COMPOSER_WRAPPED_TEXT_2_1_231,
  IDLE_AFTER_TURN_2_1_220,
  LESS_ON_A_MARKDOWN_FILE,
  MODEL_PICKER_2_1_220,
  PLAN_MODE_COMPOSER_2_1_237,
  SESSION_LIMIT_PICKER,
  VIM_ON_A_MARKDOWN_FILE,
} from "./capturedScreens.fixture";
import { claudeCodeMarkerFamilies, isClaudeCodeScreen } from "./claudeCodeScreen";
import { claudeCodeDialogOnScreen } from "./claudeCodeDialogScreen";
import { altScreenRefusalVerdict } from "./screenReadability";

/** Screens that ARE the agent's own interface. Whatever any single predicate says about typing into
 *  one of these, no reader may report it as an unrecognised full-screen app. */
const CLAUDE_SCREENS: ReadonlyArray<readonly [string, string]> = [
  ["APPROVAL_2_1_220", APPROVAL_2_1_220],
  ["APPROVAL_OPTION_2_2_1_220", APPROVAL_OPTION_2_2_1_220],
  ["ASK_USER_QUESTION_2_1_220", ASK_USER_QUESTION_2_1_220],
  ["MODEL_PICKER_2_1_220", MODEL_PICKER_2_1_220],
  ["SESSION_LIMIT_PICKER", SESSION_LIMIT_PICKER],
  ["IDLE_AFTER_TURN_2_1_220", IDLE_AFTER_TURN_2_1_220],
  ["CLAUDE_COMPOSER_WRAPPED_TEXT_2_1_231", CLAUDE_COMPOSER_WRAPPED_TEXT_2_1_231],
  ["CLAUDE_COMPOSER_PADDED_TEXT_2_1_231", CLAUDE_COMPOSER_PADDED_TEXT_2_1_231],
  ["CLAUDE_COMPOSER_PASTED_TEXT_2_1_231", CLAUDE_COMPOSER_PASTED_TEXT_2_1_231],
  ["PLAN_MODE_COMPOSER_2_1_237", PLAN_MODE_COMPOSER_2_1_237],
  ["BYPASS_COMPOSER_2_1_237", BYPASS_COMPOSER_2_1_237],
];

/** Real captures of a pager and an editor, both showing AGENTS.md — a document that QUOTES Claude
 *  Code's own chrome, which is the adversarial case a lexical heuristic would fail. */
const FOREIGN_SCREENS: ReadonlyArray<readonly [string, string]> = [
  ["VIM_ON_A_MARKDOWN_FILE", VIM_ON_A_MARKDOWN_FILE],
  ["LESS_ON_A_MARKDOWN_FILE", LESS_ON_A_MARKDOWN_FILE],
];

const onAltBuffer = (text: string) => ({ text, alternateBuffer: true });

describe("the two Claude Code recognizers, over one corpus", () => {
  it("never lets a screen either predicate recognises be reported as unreadable", () => {
    for (const [name, text] of CLAUDE_SCREENS) {
      expect(
        altScreenRefusalVerdict(onAltBuffer(text)),
        `${name}: the agent's own screen must never be classified 'unreadable' — that verdict is ` +
          `what let auto-resume tell a human a pager or an editor owned the pane (sparkle-phb1h)`,
      ).not.toBe("unreadable");
    }
  });

  it("agrees with `isClaudeCodeScreen` wherever that one says yes", () => {
    // THE IMPLICATION, not an equality. The verdict's bar is deliberately LOWER — see its own
    // header: it decides what may be CLAIMED about a screen, not whether a write is safe. What must
    // never happen is the strict predicate saying "this is Claude Code" while the lenient one says
    // "nothing recognisable here", because that is two readers disagreeing about the same screen.
    for (const [name, text] of [...CLAUDE_SCREENS, ...FOREIGN_SCREENS]) {
      if (!isClaudeCodeScreen(text)) continue;
      expect(
        altScreenRefusalVerdict(onAltBuffer(text)),
        `${name}: isClaudeCodeScreen said yes, so no reader may call this screen unreadable`,
      ).not.toBe("unreadable");
    }
  });

  it("agrees with `claudeCodeDialogOnScreen` wherever THAT one says yes", () => {
    let dialogs = 0;
    for (const [name, text] of [...CLAUDE_SCREENS, ...FOREIGN_SCREENS]) {
      if (!claudeCodeDialogOnScreen(text)) continue;
      dialogs += 1;
      expect(
        altScreenRefusalVerdict(onAltBuffer(text)),
        `${name}: a live dialog is the one alternate-screen shape that still reaches a human, so ` +
          `the verdict must be 'claude-dialog' and route to the blocked-prompt copy`,
      ).toBe("claude-dialog");
    }
    // NOT A VACUOUS PASS. Without this the loop above is satisfied by a corpus in which no fixture
    // is a dialog at all — the shape AGENTS.md calls a test asserting its own precondition.
    expect(dialogs, "the corpus must contain at least one live dialog").toBeGreaterThan(0);
  });

  it("still calls a real pager or editor unreadable — the claim that IS warranted", () => {
    for (const [name, text] of FOREIGN_SCREENS) {
      expect(isClaudeCodeScreen(text), `${name}: must not be typed into`).toBe(false);
      expect(claudeCodeDialogOnScreen(text), `${name}: holds no Claude dialog`).toBe(false);
      expect(claudeCodeMarkerFamilies(text), `${name}: carries no Claude marker family`).toBe(0);
      expect(
        altScreenRefusalVerdict(onAltBuffer(text)),
        `${name}: zero evidence in either direction is exactly 'unreadable'`,
      ).toBe("unreadable");
    }
  });

  it("reads a Claude transcript that has lost its composer box as the agent's interface", () => {
    // THE MEASURED FALSE POSITIVE, as a unit. `isClaudeCodeScreen` requires the composer box, so it
    // answers false here and the dispatcher refuses `alternate-screen` — correctly, since it cannot
    // prove where a keystroke would land. What was WRONG was reporting that refusal as "a pager or
    // an editor is holding the screen": family B is right there on the screen.
    const tail = ["⏺ Bash(git status)", "  ⎿  On branch main", "     clean", ""].join("\n");
    expect(isClaudeCodeScreen(tail)).toBe(false);
    expect(claudeCodeMarkerFamilies(tail)).toBeGreaterThanOrEqual(1);
    expect(altScreenRefusalVerdict(onAltBuffer(tail))).toBe("agent-interface");
  });

  it("takes the refusing path's OWN live menu as decisive, over anything read a moment later", () => {
    // The dispatcher's `liveMenuLabels` were read AT the instant of the refusal; this module reads
    // the viewport a moment after. When they disagree the earlier read wins — a menu that has since
    // been redrawn away was still a real question when the send was refused.
    expect(altScreenRefusalVerdict(onAltBuffer(VIM_ON_A_MARKDOWN_FILE), ["Yes", "No"])).toBe(
      "claude-dialog",
    );
    // ...and an EMPTY list is not a menu. `blind:'no-menu'` arrives as `[]` or undefined, and
    // treating either as evidence of a question is the original defect wearing a different hat.
    expect(altScreenRefusalVerdict(onAltBuffer(VIM_ON_A_MARKDOWN_FILE), [])).toBe("unreadable");
  });
});
