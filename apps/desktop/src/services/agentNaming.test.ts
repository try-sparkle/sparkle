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
