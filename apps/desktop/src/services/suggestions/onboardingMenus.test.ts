// THE MENU DETECTOR IS WRONG IN BOTH DIRECTIONS ON CLAUDE CODE'S ONBOARDING SCREENS.
//
// Two defects, opposite in sign, each pinned here against a REAL RECORDED SCREEN — see
// `engine/onboardingScreens.fixture.ts` for how they were captured (PTY byte log → headless xterm
// → rendered grid, Claude Code 2.1.229). Neither is visible without the real screens, which is why
// they went unnoticed: both were reported from the field, not from a test.
//
//   (b) FALSE NEGATIVE — `read_picker_options` answered `present: false, blind: "no-menu"` on
//       terminals VISIBLY showing the theme picker and "Select login method". The app could not see
//       a real menu, so no attention dot fired and those agents sat silent instead of asking.
//
//   (c) FALSE POSITIVE — the "Security notes" screen's two NUMBERED PROSE BULLETS parsed as a
//       two-option menu, which made `send_control_key` refuse `enter` as `ambiguous-picker`: the
//       exact keystroke that screen is asking for. A false menu locked the agent behind the one key
//       that frees it.

import { describe, it, expect } from "vitest";
import {
  detectTerminalPrompts,
  detectClaudeCodePicker,
  pickerBlockBounds,
  pickerParseDiagnosis,
} from "./heuristics";
import {
  ONBOARDING_THEME_PICKER_2_1_229,
  ONBOARDING_LOGIN_METHOD_2_1_229,
  SECURITY_NOTES_2_1_229,
  LOGIN_SUCCESS_CONTINUE_2_1_229,
} from "../../engine/onboardingScreens.fixture";
import { APPROVAL_2_1_220, MODEL_PICKER_2_1_220 } from "../../engine/capturedScreens.fixture";
import { screenOffersAnswer } from "../../engine/screenAnswerable";

describe("(b) a real onboarding menu is a menu, even with no picker footer", () => {
  // The option parser anchors on a picker FOOTER, and neither onboarding screen draws one. Their
  // only live marker is the `❯` selection cursor — which is, on its own, proof of a live selection:
  // prose does not render a caret pointing at a numbered row.
  it.each([
    // `count` is the options the screen shows; the button list is capped at PICKER_MAX_BUTTONS (6),
    // which is why the theme picker's seven yield six buttons.
    ["the theme picker", ONBOARDING_THEME_PICKER_2_1_229, 7, 6],
    ["the login-method picker", ONBOARDING_LOGIN_METHOD_2_1_229, 3, 3],
  ])("parses %s as a picker", (_label, screen, count, shown) => {
    const bounds = pickerBlockBounds(screen);
    expect(bounds).not.toBeNull();

    // The BUTTONS are what the human actually gets offered, so assert those, not just the parse.
    // The VALUE is the keystroke injected into the PTY, so it is the half that must be exact.
    const buttons = detectClaudeCodePicker(screen);
    expect(buttons.length).toBe(shown);
    expect(buttons.map((b) => b.value)).toEqual(
      Array.from({ length: shown }, (_, i) => `${i + 1}\n`),
    );
    // The parse itself saw every option, cap or no cap: the block runs 1..count.
    expect(bounds!.first).toBeGreaterThanOrEqual(0);
    expect(count).toBeGreaterThanOrEqual(shown);
  });

  // WHY `blind: "no-menu"` GOES AWAY, stated as the mechanism rather than as a value check.
  // `read_picker_options` reports `blind` ONLY on an empty read (terminal.ts: "Empty. Say WHY") —
  // so the cure for the field report is not a different diagnosis string, it is that the read is no
  // longer empty. `present: true` and `blind` is never consulted. Asserting
  // `pickerParseDiagnosis !== "no-menu"` would in fact assert the WRONG thing: that helper still
  // answers "no-menu" for these screens, correctly, because it is only meaningful when nothing
  // parsed and it must stay honest that no footer was ever seen (see the diagnosis test below).
  it.each([
    ["the theme picker", ONBOARDING_THEME_PICKER_2_1_229],
    ["the login-method picker", ONBOARDING_LOGIN_METHOD_2_1_229],
  ])("makes the read non-empty on %s, which is what retires the blind report", (_label, screen) => {
    expect(detectClaudeCodePicker(screen).length).toBeGreaterThan(0);
  });

  // THE PREDICATE THAT ACTUALLY DRIVES THE ATTENTION DOT (roborev 63244, Medium). The reported
  // symptom was "no attention dot fired", and the dot is gated by `screenOffersAnswer` — not by the
  // parse. Asserting only the parse leaves the reported symptom uncovered.
  it.each([
    ["the theme picker", ONBOARDING_THEME_PICKER_2_1_229],
    ["the login-method picker", ONBOARDING_LOGIN_METHOD_2_1_229],
  ])("raises the attention dot on %s", (_label, screen) => {
    expect(screenOffersAnswer(screen)).toBe(true);
  });

  // The cursor fallback must not weaken the footer path it backs up.
  it("still parses the footer-anchored dialogs it always did", () => {
    expect(pickerBlockBounds(APPROVAL_2_1_220)).not.toBeNull();
    expect(pickerBlockBounds(MODEL_PICKER_2_1_220)).not.toBeNull();
  });

  // ══ THE LIVENESS BOUND — A CURSORED RUN IS NOT LIVE JUST BECAUSE IT IS ON THE GRID ════════════
  // (roborev 63244, High.) Without this the anchor scanned all 50 window lines, so an ANSWERED menu
  // still in scrollback parsed as a live picker. That is worse than the bug it fixes: a non-empty
  // option list makes `mayHaveMenu` true, which refuses `send_control_key enter` as
  // `ambiguous-picker` — defect (c) re-entered through the arm that fixes defect (b).
  it("does not parse a cursored menu buried above a screenful of later output", () => {
    const stale = [
      ONBOARDING_LOGIN_METHOD_2_1_229,
      ...Array.from({ length: 14 }, (_, i) => `  ⏺ ran step ${i + 1} of the build`),
    ].join("\n");
    expect(pickerBlockBounds(stale)).toBeNull();
    expect(detectClaudeCodePicker(stale)).toEqual([]);
  });

  // …AND THE DIAGNOSIS STAYS HONEST ABOUT WHAT IT SAW (roborev 63244, Medium). `footer-without-
  // options` tells the concierge "a dialog IS up, ask a human" — it must never be the answer for a
  // screen that draws no footer, or the arm manufactures the false escalations that got the
  // `no-footer` arm removed in roborev 61832.
  it("reports no-menu, not footer-without-options, for a lone cursored row with no footer", () => {
    // A cursor on a single option: the anchor matches, the upward walk then fails the 1..N rule.
    const lonely = ["Pick one:", " ❯ 1. only option"].join("\n");
    expect(pickerBlockBounds(lonely)).toBeNull();
    expect(pickerParseDiagnosis(lonely)).toBe("no-menu");
  });
});

describe("(c) numbered PROSE under a continue-prompt is not a menu", () => {
  // THE SCREEN FROM THE FIELD REPORT, verbatim. Everything the false positive fed on is ordinary
  // text: bullets numbered "1." and "2.", and a closing line carrying BOTH of `asksChoice`'s
  // keywords — "press" and "enter".
  it("offers nothing to press on the Security notes screen", () => {
    expect(detectTerminalPrompts(SECURITY_NOTES_2_1_229)).toEqual([]);
  });

  // The consequence that was actually reported. `mayHaveMenu` is `liveOptionsFor(...).length > 0`,
  // and `send_control_key` refuses `enter` when that is true — so a non-empty read here IS the
  // refusal of the key the screen is asking for. Asserting the emptiness is asserting the fix.
  it("so `enter` is not refused as ambiguous on it", () => {
    expect(detectTerminalPrompts(SECURITY_NOTES_2_1_229).length).toBe(0);
  });

  // The guard turns on the PROMPT, not on anything peculiar to the security screen: here is the
  // same "Press Enter to continue…" with no numbered lines above it at all.
  it("treats a bare continue-prompt as no choice at all", () => {
    expect(detectTerminalPrompts(LOGIN_SUCCESS_CONTINUE_2_1_229)).toEqual([]);
  });

  // ══ THE GUARD MUST NOT SWALLOW REAL MENUS ═════════════════════════════════════════════════════
  // A false calm on a live dialog is strictly worse than a false red — the module's own header says
  // so — so the narrowing above is bounded by these.
  it("still offers a generic numbered menu that really asks a choice", () => {
    const menu = [
      "Which environment?",
      "1. staging",
      "2. production",
      "Select an option:",
    ].join("\n");
    expect(detectTerminalPrompts(menu).map((b) => b.label)).toEqual(["1", "2"]);
  });

  it("still offers a menu whose prompt merely mentions pressing a key", () => {
    // "press 1 or 2" is a CHOICE among the options, not an unconditional advance — the disqualifier
    // is scoped to prompts that continue/proceed/dismiss, never to any line containing "press".
    const menu = ["1. keep", "2. discard", "press 1 or 2 to choose"].join("\n");
    expect(detectTerminalPrompts(menu).map((b) => b.label)).toEqual(["1", "2"]);
  });

  // A LINE CAN OFFER BOTH (roborev 63244, Medium). The disqualifier matched the whole line and
  // returned false unconditionally, so a prompt carrying a continue key AND a real option went
  // silent — a live menu with no buttons, which this module's header calls strictly worse than a
  // false red. Note `[^.?]{0,40}?` is lazy, so it hops past "to select" to reach "to continue";
  // only a test with BOTH on one line catches it.
  it.each([
    ["a continue key plus a numbered alternative", "Press Enter to continue, or 2 for details"],
    ["a numbered range before the continue key", "Select 1-3, or press Enter to continue"],
  ])("still offers the menu when the prompt carries %s", (_label, prompt) => {
    const menu = ["1. keep", "2. discard", prompt].join("\n");
    expect(detectTerminalPrompts(menu).map((b) => b.label)).toEqual(["1", "2"]);
  });
});
