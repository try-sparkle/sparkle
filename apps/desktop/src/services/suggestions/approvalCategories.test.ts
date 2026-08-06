import { describe, it, expect } from "vitest";
import { asResumeRule, resumeRuleComplaint } from "./approvalCategories";

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
