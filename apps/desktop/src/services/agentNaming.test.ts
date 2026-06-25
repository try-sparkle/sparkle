import { describe, it, expect } from "vitest";
import { shouldRename } from "./agentNaming";

describe("shouldRename heuristic", () => {
  it("names the first substantive prompt", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "fix the login redirect bug" })).toBe(true);
  });

  it("never renames a pinned name", () => {
    expect(shouldRename({ namePinned: true, autoNameBasis: null, prompt: "build a whole new dashboard feature" })).toBe(false);
  });

  it("ignores thin prompts (continue/ok/yes)", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "ok continue" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "yes" })).toBe(false);
  });

  it("does NOT re-name when follow-up work is similar", () => {
    expect(
      shouldRename({
        namePinned: false,
        autoNameBasis: "fix the login redirect bug",
        prompt: "please also fix the login redirect on mobile",
      }),
    ).toBe(false);
  });

  it("re-names when the work clearly shifts", () => {
    expect(
      shouldRename({
        namePinned: false,
        autoNameBasis: "fix the login redirect bug",
        prompt: "now write integration tests for the billing webhook handler",
      }),
    ).toBe(true);
  });

  it("treats minor wording changes of the same request as the same work", () => {
    expect(
      shouldRename({
        namePinned: false,
        autoNameBasis: "add dark mode toggle to settings",
        prompt: "add a dark mode toggle in the settings page",
      }),
    ).toBe(false);
  });
});

describe("shouldRename — tactical command filter", () => {
  it("skips a prompt that is entirely an operational command", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "push to production" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "commit and push" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "merge to main" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "rerun the build" })).toBe(false);
  });

  it("skips ack / filler prompts", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "looks good" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "perfect thanks" })).toBe(false);
  });

  it("still names a substantive prompt that merely contains a tactical word", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "run the onboarding analysis flow" })).toBe(true);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "build the project settings modal" })).toBe(true);
  });

  it("skips build/test/lint chores client-side (matching the model's SKIP examples)", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "run the tests" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "run lint" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "run the typecheck" })).toBe(false);
  });

  it("still names substantive test/build work (tactical word + a real subject)", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "write tests for the billing webhook" })).toBe(true);
  });

  it("does not re-name on a tactical follow-up after a real name exists", () => {
    expect(
      shouldRename({
        namePinned: false,
        autoNameBasis: "add dark mode toggle to settings",
        prompt: "push to production",
      }),
    ).toBe(false);
  });
});
