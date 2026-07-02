import { describe, it, expect } from "vitest";
import { suggestionRowVisible } from "./suggestionVisibility";

describe("suggestionRowVisible", () => {
  it("is TRUE when the composer is empty and the mic is listening but nothing has been said", () => {
    // liveActive (mic hot) is deliberately NOT part of the gate — a parked cursor while listening
    // must still show the button. Only composerEmptyNow (true) and interimActive (false) matter.
    expect(suggestionRowVisible(true, false)).toBe(true);
  });

  it("is FALSE while there is interim speech (mid-utterance)", () => {
    expect(suggestionRowVisible(true, true)).toBe(false);
  });

  it("is FALSE when the composer is non-empty (typed content)", () => {
    expect(suggestionRowVisible(false, false)).toBe(false);
    expect(suggestionRowVisible(false, true)).toBe(false);
  });
});
