import { describe, it, expect } from "vitest";
import { pickFittedVariant } from "./nameFit";

const variants = {
  short: "Fix Login",
  medium: "Fix OAuth Login Redirect",
  long: "Fix OAuth Login Redirect Loop After Token Refresh",
};

// Measure: 1px per character. Lets the tests reason about width in characters.
const byChar = (t: string) => t.length;

describe("pickFittedVariant", () => {
  it("picks long when the column is wide enough for everything", () => {
    expect(pickFittedVariant(variants, 1000, byChar)).toBe(variants.long);
  });

  it("picks medium when long overflows but medium fits", () => {
    // long is 49 chars, medium is 24.
    expect(pickFittedVariant(variants, 30, byChar)).toBe(variants.medium);
  });

  it("picks short when only short fits", () => {
    // medium is 24 chars, short is 9.
    expect(pickFittedVariant(variants, 12, byChar)).toBe(variants.short);
  });

  it("falls back to short when even short overflows (CSS ellipsis handles the rest)", () => {
    expect(pickFittedVariant(variants, 1, byChar)).toBe(variants.short);
  });

  it("prefers the longest that fits exactly at the boundary", () => {
    expect(pickFittedVariant(variants, variants.long.length, byChar)).toBe(variants.long);
    expect(pickFittedVariant(variants, variants.medium.length, byChar)).toBe(variants.medium);
  });

  it("skips an empty variant rather than selecting it", () => {
    const gappy = { short: "Quick Fix", medium: "", long: "A Much Longer Title Here" };
    // Width fits medium's slot but medium is empty → must not return "".
    expect(pickFittedVariant(gappy, 12, byChar)).toBe(gappy.short);
  });
})
