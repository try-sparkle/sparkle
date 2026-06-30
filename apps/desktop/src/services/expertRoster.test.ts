import { describe, expect, it } from "vitest";
import { EXPERT_ROSTER, searchVoices, findVoice } from "./expertRoster";

describe("EXPERT_ROSTER", () => {
  it("is a curated roster of 40+ personas", () => {
    expect(EXPERT_ROSTER.length).toBeGreaterThanOrEqual(40);
  });

  it("has unique, kebab-case handles", () => {
    const handles = EXPERT_ROSTER.map((v) => v.handle);
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) {
      // Lowercase letters and digits, single hyphens between segments, no leading/trailing hyphen.
      expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("includes the handles visible in the current product", () => {
    const handles = new Set(EXPERT_ROSTER.map((v) => v.handle));
    for (const expected of [
      "account-executive",
      "account-manager",
      "advocacy-marketing",
      "affiliate-marketing",
      "affiliate-recruitment",
      "architect",
      "art-direction",
      "athlete-endorsements",
      "back-end-developer",
      "blogging",
      "brand-communication",
      "brand-development",
      "brand-management",
    ]) {
      expect(handles.has(expected)).toBe(true);
    }
  });

  it("has a non-empty label, oneLiner, and instructions for every entry", () => {
    for (const v of EXPERT_ROSTER) {
      expect(v.label.trim()).not.toBe("");
      expect(v.oneLiner.trim()).not.toBe("");
      expect(v.instructions.trim()).not.toBe("");
    }
  });
});

describe("searchVoices", () => {
  it("returns the full roster for an empty or whitespace query", () => {
    expect(searchVoices("")).toHaveLength(EXPERT_ROSTER.length);
    expect(searchVoices("   ")).toHaveLength(EXPERT_ROSTER.length);
  });

  it("returns a copy, not the underlying array, for empty queries", () => {
    expect(searchVoices("")).not.toBe(EXPERT_ROSTER);
  });

  it("is case-insensitive", () => {
    const lower = searchVoices("account");
    const upper = searchVoices("ACCOUNT");
    expect(upper.map((v) => v.handle)).toEqual(lower.map((v) => v.handle));
    expect(lower.length).toBeGreaterThan(0);
  });

  it("ranks prefix matches before substring matches", () => {
    // "co" is a genuine dual case: it PREFIXES content-strategist / copywriter (and their labels),
    // and is a non-prefix SUBSTRING of brand-communication / pr-communications. Every prefix hit
    // must come before every substring hit.
    const results = searchVoices("co");
    const lastPrefix = results.reduce((acc, v, i) => {
      const isPrefix = v.handle.startsWith("co") || v.label.toLowerCase().startsWith("co");
      return isPrefix ? i : acc;
    }, -1);
    const firstSubstring = results.findIndex(
      (v) =>
        !(v.handle.startsWith("co") || v.label.toLowerCase().startsWith("co")) &&
        (v.handle.includes("co") || v.label.toLowerCase().includes("co")),
    );
    expect(lastPrefix).toBeGreaterThanOrEqual(0); // there are prefix hits
    expect(firstSubstring).toBeGreaterThanOrEqual(0); // there are substring hits
    expect(lastPrefix).toBeLessThan(firstSubstring); // all prefixes precede all substrings
  });

  it("returns prefix matches first for a handle prefix query", () => {
    // account-executive and account-manager both begin with "account".
    const results = searchVoices("account");
    expect(results[0]?.handle.startsWith("account")).toBe(true);
    expect(results.some((v) => v.handle === "account-manager")).toBe(true);
  });

  it("matches on the human label, not just the handle", () => {
    // "Software Architect" label; handle is "architect". Searching the label word works.
    const results = searchVoices("software");
    expect(results.some((v) => v.handle === "architect")).toBe(true);
  });
});

describe("findVoice", () => {
  it("finds a voice by exact handle", () => {
    expect(findVoice("architect")?.label).toBe("Software Architect");
  });

  it("is case-insensitive and trims", () => {
    expect(findVoice("  ARCHITECT  ")?.handle).toBe("architect");
  });

  it("returns undefined for an unknown handle", () => {
    expect(findVoice("nonexistent-voice")).toBeUndefined();
  });
});
