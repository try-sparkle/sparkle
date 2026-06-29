import { describe, it, expect } from "vitest";
import {
  detectChiefMention,
  stripChiefMention,
  summarizeCorpus,
  instructionsOneLiner,
} from "./expertVoices";

describe("detectChiefMention", () => {
  it("matches @chief as a whole token, case-insensitively", () => {
    expect(detectChiefMention("@chief help me")).toBe(true);
    expect(detectChiefMention("hey @Chief, spin up experts")).toBe(true);
    expect(detectChiefMention("please @CHIEF")).toBe(true);
  });
  it("does not match bare 'chief' or near-misses", () => {
    expect(detectChiefMention("chief, what do you think")).toBe(false);
    expect(detectChiefMention("@chiefly")).toBe(false);
    expect(detectChiefMention("@chefs are cooking")).toBe(false);
    expect(detectChiefMention("")).toBe(false);
  });
});

describe("stripChiefMention", () => {
  it("removes the @chief token and tidies whitespace", () => {
    expect(stripChiefMention("@chief draft expert voices")).toBe("draft expert voices");
    expect(stripChiefMention("hey @Chief  help with auth")).toBe("hey help with auth");
    expect(stripChiefMention("@chief")).toBe("");
  });
  it("leaves non-mentions untouched", () => {
    expect(stripChiefMention("no mention here")).toBe("no mention here");
  });
});

describe("summarizeCorpus", () => {
  it("summarizes up to `max` filenames", () => {
    const s = summarizeCorpus([{ filename: "a.md" }, { filename: "b.md" }]);
    expect(s).toContain("a.md");
    expect(s).toContain("b.md");
    expect(s.startsWith("Project library includes:")).toBe(true);
  });
  it("caps the number of filenames", () => {
    const assets = Array.from({ length: 30 }, (_, i) => ({ filename: `f${i}.md` }));
    const s = summarizeCorpus(assets, 3);
    expect(s).toContain("f0.md");
    expect(s).toContain("f2.md");
    expect(s).not.toContain("f3.md");
  });
  it("returns empty string when there's nothing to summarize", () => {
    expect(summarizeCorpus([])).toBe("");
    expect(summarizeCorpus([{ filename: "" }, {}])).toBe("");
  });
});

describe("instructionsOneLiner", () => {
  it("takes the first sentence/line", () => {
    expect(instructionsOneLiner("A skeptic. Pokes holes in plans.")).toBe("A skeptic.");
    expect(instructionsOneLiner("First line\nsecond line")).toBe("First line");
  });
  it("caps long single sentences with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = instructionsOneLiner(long, 20);
    // cap is an upper bound (trailing-whitespace trim before the ellipsis can make it shorter).
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
  });
  it("handles empty input", () => {
    expect(instructionsOneLiner("")).toBe("");
  });
});
