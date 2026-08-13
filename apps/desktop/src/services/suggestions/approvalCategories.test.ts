import { describe, it, expect } from "vitest";
import {
  asResumeRule,
  resumeRuleComplaint,
  asConciergeAnswers,
  DEFAULT_CONCIERGE_ANSWERS,
} from "./approvalCategories";

// `[approvals].resume` takes ask|summary|full, NOT the "always"/"never" its neighbouring keys take.
// The founder wrote `resume = "always"` and got the opposite of the intent — the prompt surfaced on
// every restart — because the value narrowed silently to "ask" with nothing reporting it.
describe("resumeRuleComplaint — an unaccepted value must not pass silently", () => {
  it("complains about \"always\", the value every NEIGHBOURING approvals key takes", () => {
    const c = resumeRuleComplaint("always");
    expect(c).not.toBeNull();
    expect(c).toContain("always");
    // It must name the accepted values, or the reader learns only that they were wrong.
    expect(c).toContain("summary");
    expect(c).toContain("full");
  });

  it("complains about \"never\" too — the other half of the categories' domain", () => {
    expect(resumeRuleComplaint("never")).not.toBeNull();
  });

  it("says NOTHING about the three values the key actually accepts", () => {
    expect(resumeRuleComplaint("ask")).toBeNull();
    expect(resumeRuleComplaint("summary")).toBeNull();
    expect(resumeRuleComplaint("full")).toBeNull();
  });

  it("does NOT complain when the key is simply absent — that is the documented default", () => {
    expect(resumeRuleComplaint(undefined)).toBeNull();
    expect(resumeRuleComplaint(null)).toBeNull();
    expect(resumeRuleComplaint("")).toBeNull();
  });

  it("still narrows to the hands-off default, so behavior is unchanged by the warning", () => {
    expect(asResumeRule("always")).toBe("ask");
  });
});

// `[approvals].concierge_answers` is the second sibling in that table with its own value domain — a
// plain boolean. It is NOT [ai].auto_approve: that one lets a local regex press buttons unread,
// this one lets the concierge READ a prompt and answer it. Every case below asserts the RETURNED
// value, because the only thing that matters about this coercion is what the caller receives.
describe("asConciergeAnswers — a real boolean survives, everything else is the default", () => {
  it("returns a real `true` unchanged", () => {
    expect(asConciergeAnswers(true)).toBe(true);
  });

  it("returns a real `false` unchanged — the opt-out must actually take", () => {
    // The one case where getting this wrong is worst: a human explicitly turned routing off, and a
    // coercion that fell back to the default here would silently re-enable it.
    expect(asConciergeAnswers(false)).toBe(false);
  });

  it("degrades `undefined` (an older backend omitting the key) to the ON default", () => {
    expect(asConciergeAnswers(undefined)).toBe(true);
    expect(asConciergeAnswers(undefined)).toBe(DEFAULT_CONCIERGE_ANSWERS);
  });

  it("degrades `null` — serde's wire form for an absent optional — to the same default", () => {
    expect(asConciergeAnswers(null)).toBe(DEFAULT_CONCIERGE_ANSWERS);
  });

  it("degrades a garbage string to the default rather than to `false`", () => {
    // A typo'd value must not silently DISABLE the feature; it lands on the documented default,
    // the same contract asResumeRule keeps for its own domain.
    expect(asConciergeAnswers("always")).toBe(DEFAULT_CONCIERGE_ANSWERS);
    expect(asConciergeAnswers("false")).toBe(DEFAULT_CONCIERGE_ANSWERS);
    expect(asConciergeAnswers(0)).toBe(DEFAULT_CONCIERGE_ANSWERS);
  });

  it("defaults ON, so an install that never sets the key gets the concierge asked", () => {
    expect(DEFAULT_CONCIERGE_ANSWERS).toBe(true);
  });
});
