import { describe, it, expect } from "vitest";
import {
  hasSessionLimitOptions,
  sessionLimitOptionsPresent,
  MIN_OPTIONS_PRESENT,
  SESSION_LIMIT_REASON,
  SESSION_LIMIT_RESET_OPTION,
} from "./sessionLimitScreen";

// ── THE LIVE OPTION LABELS ARE ASSEMBLED AT RUNTIME, NEVER WRITTEN CONTIGUOUSLY ────────────────
// A test file is a file agents `cat`, diff and review. If the live labels sat in this source as
// whole strings, reading it would stream a genuine trigger through the classifier's `ingest()` and
// pin the READING agent at `waiting` — a banner and a dock badge for opening a test. The PRD solves
// the same hazard by de-fanging its reproduction; here the split does it, and it costs nothing
// because the matcher sees only the joined result.
const RESET_LABEL = ["Stop and wait for", "limit to", "reset"].join(" ");
const CREDITS_LABEL = ["Switch to", "usage", "credits"].join(" ");
const TEAM_LABEL = ["Switch to", "Team", "plan"].join(" ");

function pickerBody(cursorGlyph = "❯"): string {
  return [
    "What do you want to do?",
    `${cursorGlyph} 1. ${RESET_LABEL}`,
    `  2. ${CREDITS_LABEL}`,
    `  3. ${TEAM_LABEL}`,
  ].join("\n");
}

describe("session-limit option labels", () => {
  it("matches the real three-option picker body", () => {
    expect(sessionLimitOptionsPresent(pickerBody())).toBe(3);
    expect(hasSessionLimitOptions(pickerBody())).toBe(true);
  });

  it("still matches when Claude Code renders only the reset + credits options", () => {
    // A user already on Team does not get the Team option. Requiring three-of-three would make the
    // whole recovery path unable to fire for them, which is the same as not shipping it.
    const twoOptions = [
      "What do you want to do?",
      `❯ 1. ${RESET_LABEL}`,
      `  2. ${CREDITS_LABEL}`,
    ].join("\n");
    expect(sessionLimitOptionsPresent(twoOptions)).toBe(MIN_OPTIONS_PRESENT);
    expect(hasSessionLimitOptions(twoOptions)).toBe(true);
  });

  it("REFUSES the reset option alone — one label is not a picker", () => {
    // The failure this guards: some future unrelated dialog reusing the phrase would otherwise be
    // enough to have a machine press Esc into it.
    const alone = `❯ 1. ${RESET_LABEL}`;
    expect(sessionLimitOptionsPresent(alone)).toBe(1);
    expect(hasSessionLimitOptions(alone)).toBe(false);
  });

  it("REFUSES the two billing options without the reset option", () => {
    // Both "Switch to …" labels are generic enough to appear on another settings picker. The reset
    // option is the one that exists on no other Claude Code screen, so it is mandatory.
    const billingOnly = [`❯ 1. ${CREDITS_LABEL}`, `  2. ${TEAM_LABEL}`].join("\n");
    expect(sessionLimitOptionsPresent(billingOnly)).toBe(2);
    expect(hasSessionLimitOptions(billingOnly)).toBe(false);
  });

  it("does NOT match a markdown blockquote of the picker (a bare `>` is not a cursor)", () => {
    // This is rule (1) of the module header, and the property the PRD's de-fanged reproduction
    // leans on: prose quoting the picker renders its cursor as `>`.
    const quoted = pickerBody(">")
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    expect(SESSION_LIMIT_RESET_OPTION.test(quoted)).toBe(false);
    expect(hasSessionLimitOptions(quoted)).toBe(false);
  });

  it("does NOT match labels carrying the PRD's zero-width spaces", () => {
    // Rule (2): the PRD splits each keyword with U+200B precisely so a doc review cannot fire this.
    const defanged = [
      "What do you want to do?",
      "> 1. Stop and wait for limit to rese​t",
      "  2. Switch to usage credit​s",
      "  3. Switch to Team pla​n",
    ].join("\n");
    expect(sessionLimitOptionsPresent(defanged)).toBe(0);
    expect(hasSessionLimitOptions(defanged)).toBe(false);
  });

  it("does not match an ordinary numbered picker", () => {
    const approval = ["Do you want to proceed?", "❯ 1. Yes", "  2. No, and tell Claude what to do"].join("\n");
    expect(hasSessionLimitOptions(approval)).toBe(false);
  });

  it("pins the reason code — it is a cross-unit wire value, not a local string", () => {
    expect(SESSION_LIMIT_REASON).toBe("session-limit-picker");
  });

  it("matches the label through the box gutter Claude Code draws", () => {
    const boxed = ["│ What do you want to do?", `│ ❯ 1. ${RESET_LABEL}`, `│   2. ${CREDITS_LABEL}`].join("\n");
    expect(hasSessionLimitOptions(boxed)).toBe(true);
  });
});
