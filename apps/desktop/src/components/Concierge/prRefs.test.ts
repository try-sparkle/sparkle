import { describe, expect, it } from "vitest";

import {
  PR_REF_SCHEME,
  findPrRefs,
  parsePrRefHref,
  prRefHref,
  prWebUrl,
  slugFromPrUrl,
  stripPrRefs,
} from "./prRefs";

describe("parsePrRefHref", () => {
  it("reads an UNQUALIFIED reference — a number with no repo", () => {
    expect(parsePrRefHref("sparkle-pr:2164")).toEqual({ number: 2164, slug: null });
  });

  it("reads a QUALIFIED reference — the repo the writer knew", () => {
    expect(parsePrRefHref("sparkle-pr:drodio/sparkle#2164")).toEqual({
      number: 2164,
      slug: "drodio/sparkle",
    });
  });

  it("tolerates leading whitespace and a differently-cased scheme, as its siblings do", () => {
    expect(parsePrRefHref("  SPARKLE-PR:7")).toEqual({ number: 7, slug: null });
  });

  it("is null for anything that is not ours", () => {
    for (const href of [undefined, "", "https://example.com", "sparkle-bead:sparkle-17hm1"]) {
      expect(parsePrRefHref(href)).toBeNull();
    }
  });

  it("REFUSES a malformed number rather than guessing one", () => {
    for (const bad of [
      "sparkle-pr:",
      "sparkle-pr:0",
      "sparkle-pr:012",
      "sparkle-pr:-4",
      "sparkle-pr:12.5",
      "sparkle-pr:1234567",
      "sparkle-pr:12ab",
      "sparkle-pr:#12",
    ]) {
      expect(parsePrRefHref(bad), bad).toBeNull();
    }
  });

  it("REFUSES a slug that could mean something to a downstream consumer", () => {
    for (const bad of [
      "sparkle-pr:drodio#12",
      "sparkle-pr:a/b/c#12",
      "sparkle-pr:../etc#12",
      "sparkle-pr:a/../b#12",
      "sparkle-pr:dro dio/sparkle#12",
      "sparkle-pr:/sparkle#12",
      "sparkle-pr:drodio/#12",
      "sparkle-pr:drodio/sparkle#0",
    ]) {
      expect(parsePrRefHref(bad), bad).toBeNull();
    }
  });
});

describe("prRefHref", () => {
  it("round-trips both forms through the parser", () => {
    expect(parsePrRefHref(prRefHref({ number: 2164 }))).toEqual({ number: 2164, slug: null });
    expect(parsePrRefHref(prRefHref({ number: 2164, slug: "drodio/sparkle" }))).toEqual({
      number: 2164,
      slug: "drodio/sparkle",
    });
  });

  it("joins the scheme in ONE place", () => {
    expect(prRefHref({ number: 9 }).startsWith(PR_REF_SCHEME)).toBe(true);
  });
});

describe("prWebUrl", () => {
  it("builds the pull-request page for a slug", () => {
    expect(prWebUrl("drodio/sparkle", 2164)).toBe("https://github.com/drodio/sparkle/pull/2164");
  });
});

describe("slugFromPrUrl", () => {
  it("recovers owner/repo from the url the merge tool reports", () => {
    expect(slugFromPrUrl("https://github.com/drodio/sparkle/pull/2164")).toBe("drodio/sparkle");
  });

  it("is null for a url that is not a github pull request", () => {
    for (const bad of [
      "",
      "https://github.com/drodio/sparkle",
      "https://github.com/drodio/sparkle/issues/12",
      "https://evil.example.com/drodio/sparkle/pull/12",
      "https://github.com.evil.example/drodio/sparkle/pull/12",
      "not a url",
    ]) {
      expect(slugFromPrUrl(bad), bad).toBeNull();
    }
  });
});

describe("findPrRefs", () => {
  const numbers = (t: string) => findPrRefs(t).map((s) => s.number);
  const slices = (t: string) => findPrRefs(t).map((s) => t.slice(s.start, s.end));

  it("finds a bare number of two or more digits", () => {
    expect(numbers("merged #2164 into main")).toEqual([2164]);
    expect(slices("merged #2164 into main")).toEqual(["#2164"]);
  });

  it("finds several, in document order", () => {
    expect(numbers("#12 then #2164")).toEqual([12, 2164]);
  });

  it("LEAVES A ONE-DIGIT NUMBER ALONE — 'step #3' is prose, not a pull request", () => {
    expect(numbers("step #3 of the plan, my #1 priority")).toEqual([]);
  });

  it("…unless the word PR or 'pull request' says otherwise, and then spans only the number", () => {
    expect(numbers("PR #7 is green")).toEqual([7]);
    expect(slices("PR #7 is green")).toEqual(["#7"]);
    expect(numbers("PR#7 is green")).toEqual([7]);
    expect(numbers("pull request #7 is green")).toEqual([7]);
    expect(numbers("Pull Request #7 is green")).toEqual([7]);
  });

  it("stops at a token boundary rather than eating part of a longer word", () => {
    expect(numbers("colour #12ab34")).toEqual([]);
    expect(numbers("issue-abc#12")).toEqual([]);
    expect(numbers("version #12.5")).toEqual([]);
    expect(numbers("#1234567 is too long to be one")).toEqual([]);
  });

  it("treats a FULL STOP after the number as the sentence it is", () => {
    expect(numbers("Merged #2164.")).toEqual([2164]);
  });

  it("refuses a leading zero", () => {
    expect(numbers("#0012")).toEqual([]);
  });
});

describe("stripPrRefs", () => {
  it("flattens an explicit reference to the words the reader saw", () => {
    expect(stripPrRefs("Merged PR [#2164](sparkle-pr:drodio/sparkle#2164).")).toBe(
      "Merged PR #2164.",
    );
  });

  it("leaves a link that is not ours alone", () => {
    const md = "see [the docs](https://example.com)";
    expect(stripPrRefs(md)).toBe(md);
  });

  it("does not touch a reference quoted inside a code span", () => {
    const md = "run `[#12](sparkle-pr:12)` verbatim";
    expect(stripPrRefs(md)).toBe(md);
  });
});
