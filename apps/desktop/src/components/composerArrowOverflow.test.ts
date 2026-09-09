import { describe, it, expect } from "vitest";
import { arrowKeySequence } from "./composerArrowOverflow";

describe("arrowKeySequence", () => {
  it("emits CSI sequences in normal cursor-key mode", () => {
    expect(arrowKeySequence("up", false)).toBe("\x1b[A");
    expect(arrowKeySequence("down", false)).toBe("\x1b[B");
  });

  it("emits SS3 sequences in application cursor-key mode (DECCKM)", () => {
    expect(arrowKeySequence("up", true)).toBe("\x1bOA");
    expect(arrowKeySequence("down", true)).toBe("\x1bOB");
  });
});
