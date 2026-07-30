import { describe, expect, it } from "vitest";
import { proseSpans, proseText, sourceOffsetOf } from "./mdast";

/** The joined prose of `text` — what every check actually reads. */
const prose = (text: string, excludeBlockquote = false): string =>
  proseText(text, { excludeBlockquote });

describe("proseSpans", () => {
  it("excludes a fenced code block's contents from the prose", () => {
    const reply = "The retry loop resets.\n\n```ts\nif (attempts) should();\n```\n\nDone.";
    expect(prose(reply)).not.toContain("should");
    expect(prose(reply)).toContain("The retry loop resets.");
  });

  it("excludes an inline code span from the prose", () => {
    const reply = "Rule 13 forbids `should` in a reply.";
    expect(prose(reply)).not.toContain("should");
    // The words AROUND the span survive — this is an exclusion, not a whole-node drop.
    expect(prose(reply)).toContain("Rule 13 forbids");
  });

  it("excludes a link DESTINATION but keeps the link's visible label", () => {
    const reply = "See the [handbook](https://example.test/should-not-leak.md) first.";
    expect(prose(reply)).not.toContain("should-not-leak");
    expect(prose(reply)).toContain("handbook");
  });

  it("excludes a BARE url run, which the renderer's gfm would have made a link destination", () => {
    const reply = "Details at https://example.test/should-we-merge/retry.ts:88 and that is all.";
    expect(prose(reply)).not.toContain("should-we-merge");
    expect(prose(reply)).not.toContain("retry.ts:88");
    // The words on either side of the url survive.
    expect(prose(reply)).toContain("Details at");
    expect(prose(reply)).toContain("and that is all.");
  });

  it("keeps a scheme GFM does not autolink as prose", () => {
    // Only http(s) and www. are autolinks; `file://` is a sentence the reader reads.
    expect(prose("Details at file:///Users/x/should-we-merge.md")).toContain("should-we-merge");
  });

  it("keeps trailing punctuation that GFM leaves outside the autolink", () => {
    // The full stop and the unmatched paren are prose, not part of the link.
    expect(prose("Merged https://example.test/pr/864.")).toContain(".");
    expect(prose("(see https://example.test/pr/864) and done")).toContain(") and done");
  });

  it("keeps a url-looking run that has no left boundary", () => {
    expect(prose("mailto:x@https://y.test/should-go")).toContain("should-go");
  });

  it("keeps a bare url's spans slicing their own source back out", () => {
    const reply = "Details at https://example.test/x and more.";
    for (const span of proseSpans(reply)) {
      expect(reply.slice(span.start, span.end)).toBe(span.value);
    }
  });

  it("keeps blockquote text by default and drops it when asked", () => {
    const reply = "I read it.\n\n> should I merge it?\n\nMerged.";
    expect(prose(reply, false)).toContain("should I merge it?");
    expect(prose(reply, true)).not.toContain("should I merge it?");
    // Dropping the quote must not drop the reply around it.
    expect(prose(reply, true)).toContain("Merged.");
  });

  it("reports offsets that slice the ORIGINAL source back out", () => {
    const reply = "alpha `beta` gamma";
    const spans = proseSpans(reply);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(reply.slice(span.start, span.end)).toBe(span.value);
    }
    // And the excluded span really is a hole in the coverage.
    expect(spans.map((s) => s.value).join("")).not.toContain("beta");
  });

  it("returns spans in document order", () => {
    const spans = proseSpans("first\n\nsecond\n\nthird");
    expect(spans.map((s) => s.value.trim())).toEqual(["first", "second", "third"]);
    expect(spans[0]!.start).toBeLessThan(spans[1]!.start);
    expect(spans[1]!.start).toBeLessThan(spans[2]!.start);
  });

  it("returns an empty list for text with no prose at all", () => {
    expect(proseSpans("```\njust code\n```")).toEqual([]);
  });
});

describe("sourceOffsetOf", () => {
  it("maps an index in the parsed value back to the source offset when aligned", () => {
    const reply = "hello world";
    const span = proseSpans(reply)[0]!;
    expect(sourceOffsetOf(span, 6)).toBe(6);
    expect(reply.slice(sourceOffsetOf(span, 6) as number, 11)).toBe("world");
  });

  it("refuses rather than guessing when a markdown escape shortens the value", () => {
    const reply = "a\\*b";
    const span = proseSpans(reply)[0]!;
    // The parser resolved the escape, so value is shorter than the source it came from.
    expect(span.value).toBe("a*b");
    expect(span.end - span.start).toBe(4);
    expect(sourceOffsetOf(span, 2)).toBeNull();
  });

  it("refuses an out-of-range index", () => {
    const span = proseSpans("hello")[0]!;
    expect(sourceOffsetOf(span, -1)).toBeNull();
    expect(sourceOffsetOf(span, 99)).toBeNull();
  });
});
