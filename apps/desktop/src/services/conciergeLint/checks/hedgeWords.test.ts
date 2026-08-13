import { describe, expect, it } from "vitest";
import type { CheckPolicy, LintContext } from "../types";
import { DEFAULT_HEDGE_WORDS, hedgeWordsCheck, parseHedgeWords } from "./hedgeWords";

const ctx = (policy: Partial<CheckPolicy> = {}): LintContext => ({
  roster: [],
  toolCalls: [],
  refusals: [],
  prevReply: null,
  founderMessages: [],
  policy: {
    enabled: true,
    log: false,
    logMatches: false,
    checks: {
      "hedge-words": {
        enabled: true,
        severity: "warn",
        autofix: false,
        ...policy,
      },
    },
  },
});

const run = (text: string, policy: Partial<CheckPolicy> = {}) =>
  hedgeWordsCheck.run(text, ctx(policy));

describe("parseHedgeWords", () => {
  it("splits the comma-separated config value and drops blanks", () => {
    expect(parseHedgeWords("should, deserves to ,, maybe")).toEqual([
      "should",
      "deserves to",
      "maybe",
    ]);
  });

  it("falls back to the rule's own two words when unset", () => {
    expect(parseHedgeWords(undefined)).toEqual(["should", "deserves to"]);
    expect(DEFAULT_HEDGE_WORDS).toBe("should, deserves to");
  });
});

describe("hedgeWordsCheck", () => {
  it("reports a hedge in prose, with the matched length as the span", () => {
    const { violations } = run("The build should finish soon.");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      check: "hedge-words",
      severity: "warn",
      action: "warned",
      span: 6,
    });
    expect(violations[0]!.detail).toContain("should");
  });

  it("leaves the reply text untouched — this check never rewrites", () => {
    const reply = "The build should finish soon.";
    expect(run(reply).text).toBe(reply);
  });

  it("matches a multi-word entry across a line wrap", () => {
    const { violations } = run("That branch deserves\nto land today.");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.detail).toContain("deserves to");
  });

  it("matches case-insensitively", () => {
    expect(run("Should we merge it?").violations).toHaveLength(1);
  });

  it("reports every occurrence, not one per check", () => {
    expect(run("It should land, and the docs should follow.").violations).toHaveLength(2);
  });

  it("respects word boundaries", () => {
    expect(run("She tapped my shoulder; it shouldn't matter.").violations).toEqual([]);
  });

  it("does NOT fire inside a fenced code block", () => {
    const reply = "Landed it.\n\n```ts\nif (ready) should(merge);\n```\n\nGreen.";
    expect(run(reply).violations).toEqual([]);
  });

  it("does NOT fire inside an inline code span", () => {
    expect(run("Rule 13 forbids `should` in a reply.").violations).toEqual([]);
  });

  it("does NOT fire inside a blockquote quoting the user", () => {
    const reply = "You asked:\n\n> should I merge it?\n\nI merged it.";
    expect(run(reply).violations).toEqual([]);
  });

  it("does not read a hedge out of a link destination", () => {
    expect(run("See the [handbook](https://example.test/should.md).").violations).toEqual([]);
  });

  it("does not read a hedge out of a bare URL the renderer would autolink", () => {
    expect(run("Details at https://example.test/should-we-merge.md").violations).toEqual([]);
  });

  it("uses the words the policy configures, not the defaults", () => {
    const { violations } = run("It probably landed.", { words: "probably" });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.detail).toContain("probably");
    // And the default word is no longer configured, so it stops firing.
    expect(run("It should land.", { words: "probably" }).violations).toEqual([]);
  });

  it("reports nothing when the word list is emptied", () => {
    expect(run("It should land.", { words: "  ,  " }).violations).toEqual([]);
  });

  it("carries the policy's severity onto the violation", () => {
    const { violations } = run("It should land.", { severity: "block" });
    expect(violations[0]!.severity).toBe("block");
  });
});
