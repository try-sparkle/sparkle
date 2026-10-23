// THE FEEDBACK-DRAFT CARD IS A MENU THE PICKER READER CAN SEE — bead sparkle-eou3y0.5.
//
// "Bug report drafted … 1 review / 2 send / 0 dismiss" used to read as
// `blind: "footer-without-options"`: the footer matched, the option walk found no `1.` rows, and the
// concierge could neither read nor dismiss the card. These pin that the options now come back from
// the card's footer, that the card's question (its title) is what the fingerprint hashes, and — the
// paired negative — that a card QUOTED in output that has scrolled on is still nothing to press.
import { describe, expect, it } from "vitest";

import { findFeedbackDraftCard } from "../../engine/feedbackDraftCard";
import {
  FEEDBACK_DRAFT_CARD_QUOTED_SCREEN,
  FEEDBACK_DRAFT_CARD_SCREEN,
  FEEDBACK_DRAFT_CARD_SLASH_SCREEN,
  FOOTER_ONLY_SCREEN,
} from "../../engine/incidentScreens.fixture";
import { pickerQuestionBlock } from "../pickerFingerprint";
import { detectClaudeCodePicker, parsePickerOptions, pickerParseDiagnosis } from "./heuristics";

describe("the feedback-draft card's options are read from its footer", () => {
  it.each([
    ["the key-hint spelling", FEEDBACK_DRAFT_CARD_SCREEN],
    ["the slash spelling", FEEDBACK_DRAFT_CARD_SLASH_SCREEN],
  ])("%s yields review / send / dismiss with their own keystrokes", (_name, screen) => {
    expect(parsePickerOptions(screen), "the card's footer IS its option list").toEqual([
      { n: 1, label: "review" },
      { n: 2, label: "send" },
      { n: 0, label: "dismiss" },
    ]);
    expect(detectClaudeCodePicker(screen).map((b) => b.value)).toEqual(["1\n", "2\n", "0\n"]);
    expect(findFeedbackDraftCard(screen.split("\n"))).not.toBeNull();
  });

  it("fingerprints the card's title, not the transcript above it", () => {
    const q = pickerQuestionBlock(FEEDBACK_DRAFT_CARD_SCREEN, false);
    expect(q).toContain("Bug report drafted");
    expect(q, "transcript rows above the card would make the fingerprint churn").not.toContain("Not blocked");
  });
});

describe("…and only a LIVE card is offered", () => {
  it("a card quoted in output that has since scrolled on offers nothing", () => {
    expect(findFeedbackDraftCard(FEEDBACK_DRAFT_CARD_QUOTED_SCREEN.split("\n"))).toBeNull();
    expect(parsePickerOptions(FEEDBACK_DRAFT_CARD_QUOTED_SCREEN)).toEqual([]);
  });

  it("a digit hint bar with no drafted-report title is not the card", () => {
    const untitled = FEEDBACK_DRAFT_CARD_SCREEN.replace(
      "  Bug report drafted: Status-check nudges keep firing after goal is met",
      "  Pick one of these:",
    );
    expect(findFeedbackDraftCard(untitled.split("\n"))).toBeNull();
  });

  it("a footer with no dismiss segment is not the card", () => {
    const noDismiss = FEEDBACK_DRAFT_CARD_SCREEN.replace("0 to dismiss", "3 to archive");
    expect(findFeedbackDraftCard(noDismiss.split("\n"))).toBeNull();
  });

  it("the approval dead-end screen is still blind — this did not widen the generic footer path", () => {
    expect(pickerParseDiagnosis(FOOTER_ONLY_SCREEN)).toBe("footer-without-options");
  });
});
