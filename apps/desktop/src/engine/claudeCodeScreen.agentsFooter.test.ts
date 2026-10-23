// THE AGENTS-INDICATOR FOOTER — bead sparkle-eou3y0.8.
//
// Modern Claude Code holds the alternate buffer for its whole life and, on an idle pane, can draw
// the agents indicator as its ONLY footer row (`← agents · ↓ to manage`, `← agents · 1 feedback
// draft`). That row was not in family C, so an idle pane whose `⏺` header had scrolled away scored
// the composer box alone — one family — and `send_to_agent_terminal` refused `alternate-screen`.
//
// The paired negatives keep the fix from being a relaxation: the indicator counts only as Claude's
// chrome (a ROW that opens with it), never as a phrase in prose, and it never stands in for the
// composer box — a document quoting it is still refused.
import { describe, expect, it } from "vitest";

import { LESS_ON_A_MARKDOWN_FILE, VIM_ON_A_MARKDOWN_FILE } from "./capturedScreens.fixture";
import { claudeCodeMarkerFamilies, isClaudeCodeScreen } from "./claudeCodeScreen";
import {
  IDLE_AGENTS_BARE_FOOTER_SCREEN,
  IDLE_AGENTS_COUNTED_BYPASS_FOOTER_SCREEN,
  IDLE_AGENTS_COUNTED_FOOTER_SCREEN,
  IDLE_AGENTS_FEEDBACK_DRAFT_FOOTER_SCREEN,
  IDLE_AGENTS_MANAGE_FOOTER_SCREEN,
} from "./incidentScreens.fixture";
import { altScreenRefusalVerdict } from "./screenReadability";
import { terminalWriteRefusal } from "../voice/dictationTerminalRoute";

const RULE = "─".repeat(120);

describe("the `← agents` footer is Claude Code's own chrome (sparkle-eou3y0.8)", () => {
  it.each([
    ["← agents · ↓ to manage", IDLE_AGENTS_MANAGE_FOOTER_SCREEN],
    ["← agents · 1 feedback draft", IDLE_AGENTS_FEEDBACK_DRAFT_FOOTER_SCREEN],
  ])("an idle pane footed by %s is recognised, so a message is not refused alternate-screen", (_name, screen) => {
    expect(
      claudeCodeMarkerFamilies(screen),
      "the composer box AND the agents footer are two independent families",
    ).toBe(2);
    expect(
      isClaudeCodeScreen(screen),
      "an idle Claude Code pane must not be refused as an unrecognised full-screen app",
    ).toBe(true);
    expect(altScreenRefusalVerdict({ text: screen, alternateBuffer: true })).not.toBe("unreadable");
  });

  it("recognises the bare `← for agents` row and a narrow-wrapped tail too", () => {
    const bare = [RULE, "❯ ", RULE, "  ← for agents"].join("\n");
    expect(isClaudeCodeScreen(bare)).toBe(true);
    // A 14-column pane: Ink wraps the footer, and the narrow arm proves the box by the REJOINED
    // tail opening with Claude's chrome — which it can only do if the indicator is in that list.
    const n = "─".repeat(14);
    const narrow = ["  Nothing else", "  is pending.", n, "❯ ", n, "  ← agents ·", "  ↓ to manage"].join("\n");
    expect(isClaudeCodeScreen(narrow), "a narrow idle pane footed by the indicator").toBe(true);
  });
});

describe("…and it does not weaken the refusal of a real full-screen app", () => {
  it("a pager quoting the footer, with no composer box, is still refused", () => {
    const pager = `${LESS_ON_A_MARKDOWN_FILE}\n  ← agents · ↓ to manage`;
    expect(isClaudeCodeScreen(pager), "the box is mandatory; chrome alone never authorises a write").toBe(
      false,
    );
    const vim = `${VIM_ON_A_MARKDOWN_FILE}\n  ← agents · 1 feedback draft`;
    expect(isClaudeCodeScreen(vim)).toBe(false);
  });

  it("the phrase inside PROSE is not chrome — a box plus prose mentioning it still scores one family", () => {
    const quoted = [
      RULE,
      "❯ ",
      RULE,
      "The footer shows ← agents · ↓ to manage when subagents run.",
    ].join("\n");
    expect(claudeCodeMarkerFamilies(quoted)).toBe(1);
    expect(isClaudeCodeScreen(quoted)).toBe(false);
  });

  it("an arrow to something other than agents is not the indicator", () => {
    const other = [RULE, "❯ ", RULE, "  ← back · ↓ to manage"].join("\n");
    expect(isClaudeCodeScreen(other)).toBe(false);
  });
});

// THE GATE ITSELF. Everything above asks the recogniser; this asks `terminalWriteRefusal`, the
// function whose `alternate-screen` answer is the refusal the concierge actually hit — with the
// alternate buffer ON, since current Claude Code holds it for its whole life.
describe("send_to_agent_terminal's gate on the current footer variants (sparkle-eou3y0.8)", () => {
  it.each([
    ["← agents", IDLE_AGENTS_BARE_FOOTER_SCREEN],
    ["← agents · ↓ to manage", IDLE_AGENTS_MANAGE_FOOTER_SCREEN],
    ["← agents · 1 feedback draft", IDLE_AGENTS_FEEDBACK_DRAFT_FOOTER_SCREEN],
    ["⏵⏵ bypass permissions on (shift+tab to cycle) · ← 4 agents", IDLE_AGENTS_COUNTED_BYPASS_FOOTER_SCREEN],
    ["← 4 agents · ↓ to manage", IDLE_AGENTS_COUNTED_FOOTER_SCREEN],
  ])("an idle alternate-buffer pane footed by %s is writable", (_name, text) => {
    expect(terminalWriteRefusal({ text, alternateBuffer: true }), "an idle Claude Code prompt").toBeNull();
  });

  it("the counted indicator is a family-C vote of its own, not only via the mode bar", () => {
    expect(claudeCodeMarkerFamilies(IDLE_AGENTS_COUNTED_FOOTER_SCREEN)).toBe(2);
  });

  it.each([
    ["less", LESS_ON_A_MARKDOWN_FILE],
    ["vim", VIM_ON_A_MARKDOWN_FILE],
    ["less quoting the counted footer", `${LESS_ON_A_MARKDOWN_FILE}\n  ← 4 agents · ↓ to manage`],
    ["vim quoting the bare footer", `${VIM_ON_A_MARKDOWN_FILE}\n  ← agents`],
  ])("a %s screen is still refused alternate-screen", (_name, text) => {
    expect(terminalWriteRefusal({ text, alternateBuffer: true })).toBe("alternate-screen");
  });

  it("a count that is not a small number is not the indicator", () => {
    const rule = "─".repeat(120);
    expect(isClaudeCodeScreen([rule, "❯ ", rule, "  ← 12345 agents"].join("\n"))).toBe(false);
  });
});
