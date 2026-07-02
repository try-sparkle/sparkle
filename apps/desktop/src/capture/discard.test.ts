// Discard rule for the capture modal (spec §3): Esc / scrim-click closes immediately when the
// narration textarea is empty; only a real (non-whitespace) transcript earns the inline
// "Discard capture?" confirm.
import { describe, it, expect } from "vitest";
import { shouldConfirmDiscard } from "./discard";

describe("shouldConfirmDiscard", () => {
  it("empty text → no confirm (close immediately)", () => {
    expect(shouldConfirmDiscard("")).toBe(false);
  });

  it("whitespace-only text counts as empty", () => {
    expect(shouldConfirmDiscard("   \n\t  ")).toBe(false);
  });

  it("real narration → confirm before discarding", () => {
    expect(shouldConfirmDiscard("fix the login button")).toBe(true);
  });

  it("narration with surrounding whitespace still confirms", () => {
    expect(shouldConfirmDiscard("  hmm  ")).toBe(true);
  });
});
