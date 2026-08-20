// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { detectPlanPrompt, isPlanExitDialog } from "./planPrompt";
import {
  PLAN_EXIT_PROMPT,
  PLAN_EXIT_PROMPT_RENAMED,
  STALE_PLAN_QUESTION_OVER_ANOTHER_PICKER,
  PLAN_EXIT_PROMPT_WRAPPED,
  PLAN_EXIT_PROMPT_STICKY,
  PLAN_ARTIFACT_PROMPT,
  BASH_PERMISSION_PROMPT,
} from "./planPrompt.fixture";

describe("detectPlanPrompt", () => {
  it("reads BOTH affirmatives off the plan-exit prompt", () => {
    expect(detectPlanPrompt(PLAN_EXIT_PROMPT)).toEqual({
      autoOption: "1\n",
      manualOption: "2\n",
    });
  });

  it("still recognises the question when it is hard-wrapped inside box borders", () => {
    expect(detectPlanPrompt(PLAN_EXIT_PROMPT_WRAPPED)).toEqual({
      autoOption: "1\n",
      manualOption: "2\n",
    });
  });

  it("reads the ORDINAL off the parsed picker rather than assuming 1/2", () => {
    // Same question, options reordered — a detector keyed on option NUMBER would press the wrong
    // one here, which is the whole reason this is matched by question text + label.
    const reordered = PLAN_EXIT_PROMPT.replace(
      "❯ 1. Yes, and use auto mode\n  2. Yes, manually approve edits",
      "❯ 1. Yes, manually approve edits\n  2. Yes, and use auto mode",
    );
    expect(detectPlanPrompt(reordered)).toEqual({ autoOption: "2\n", manualOption: "1\n" });
  });

  it("never offers the sticky 'set auto mode as my default permission mode' option as auto", () => {
    const d = detectPlanPrompt(PLAN_EXIT_PROMPT_STICKY);
    expect(d).not.toBeNull();
    expect(d?.autoOption).toBeNull(); // the only 'auto' label on screen is the sticky one
    expect(d?.manualOption).toBe("2\n");
  });

  it("refuses Claude Code's OTHER plan question (review as an artifact)", () => {
    expect(detectPlanPrompt(PLAN_ARTIFACT_PROMPT)).toBeNull();
  });

  it("refuses an ordinary permission prompt", () => {
    expect(detectPlanPrompt(BASH_PERMISSION_PROMPT)).toBeNull();
  });

  it("refuses a plan-exit QUESTION with no picker under it", () => {
    expect(
      detectPlanPrompt("Claude has written up a plan and is ready to execute. Would you like to proceed?"),
    ).toBeNull();
  });

  it("refuses a picker whose question is merely ABOUT a plan", () => {
    const impostor = [
      "Do you want to write the plan to PLAN.md?",
      "❯ 1. Yes, and use auto mode",
      "  2. Yes, manually approve edits",
      "  3. No",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    expect(detectPlanPrompt(impostor)).toBeNull();
  });
});

// ── The QUESTION-level predicate, which answers a different question from the detector ──────────
describe("isPlanExitDialog", () => {
  it("recognises a plan whose affirmatives were RENAMED, where the detector cannot", () => {
    // The split's whole purpose. `detectPlanPrompt` has no keystroke to offer here and says so; the
    // rules that ask "is this a plan" — the escalation arm and the `plan = "ask"` opt-out — must
    // still hold, or a rename silently reopens both holes.
    expect(detectPlanPrompt(PLAN_EXIT_PROMPT_RENAMED)).toBeNull();
    expect(isPlanExitDialog(PLAN_EXIT_PROMPT_RENAMED)).toBe(true);
  });

  it("refuses an unrelated picker that merely INHERITED the plan question from scrollback", () => {
    // The other direction, and the dangerous one. On a borderless dialog `pickerQuestionBlock` falls
    // back to the ten preceding lines, so a picker drawn just after a plan prompt was answered sees
    // that question above it. Classifying it as a plan swaps the five-class sweep for the plan arm,
    // which deliberately does not escalate `destructive` — so "Force push over origin/main" would go
    // to the concierge. The option SHAPE is what the stale question cannot fake.
    expect(isPlanExitDialog(STALE_PLAN_QUESTION_OVER_ANOTHER_PICKER)).toBe(false);
  });

  it("agrees with the detector on the ordinary dialog", () => {
    expect(isPlanExitDialog(PLAN_EXIT_PROMPT)).toBe(true);
    expect(isPlanExitDialog(PLAN_ARTIFACT_PROMPT)).toBe(false);
    expect(isPlanExitDialog(BASH_PERMISSION_PROMPT)).toBe(false);
  });
});
