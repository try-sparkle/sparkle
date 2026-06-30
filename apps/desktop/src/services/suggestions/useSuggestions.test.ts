import { describe, it, expect } from "vitest";
import { shouldRecompute, hashScrollback, withinRetryBudget } from "./useSuggestions";

describe("withinRetryBudget (bounds persistent-rejection retries)", () => {
  it("allows retries below the cap (3) and stops at it", () => {
    expect(withinRetryBudget(0)).toBe(true);
    expect(withinRetryBudget(1)).toBe(true);
    expect(withinRetryBudget(2)).toBe(true);
    expect(withinRetryBudget(3)).toBe(false);
    expect(withinRetryBudget(4)).toBe(false);
  });
});

describe("suggestion recompute gating", () => {
  it("recomputes on a new scrollback hash", () => {
    expect(shouldRecompute({ lastHash: "x", nextHash: "y", composerEmpty: true })).toBe(true);
  });
  it("skips when hash unchanged", () => {
    expect(shouldRecompute({ lastHash: "x", nextHash: "x", composerEmpty: true })).toBe(false);
  });
  it("skips when composer is non-empty", () => {
    expect(shouldRecompute({ lastHash: "x", nextHash: "y", composerEmpty: false })).toBe(false);
  });
  it("recomputes on first run (null lastHash)", () => {
    expect(shouldRecompute({ lastHash: null, nextHash: "y", composerEmpty: true })).toBe(true);
  });
});

describe("hashScrollback", () => {
  it("is stable for the same input", () => {
    expect(hashScrollback("abc")).toBe(hashScrollback("abc"));
  });
  it("differs on change", () => {
    expect(hashScrollback("abc")).not.toBe(hashScrollback("abd"));
  });
});
