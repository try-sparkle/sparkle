// The pure half of a research reference — parse, compose, and the clipboard flattener. No React,
// no store: this is the sibling of `agentRefs.test.ts` / `beadRefs.test.ts` and pins the same three
// properties (a conservative id boundary, a round-trip that cannot be spelled two ways, and a strip
// that agrees with the renderer's grammar).
import { describe, expect, it } from "vitest";
import {
  RESEARCH_REF_SCHEME,
  isWellFormedResearchId,
  parseResearchRefHref,
  researchRefHref,
  stripResearchRefs,
} from "./researchRefs";

// A real runner-minted id, `rsh_<epoch13>_<16hex>`. Used everywhere below so the tests exercise the
// shape production actually produces rather than a convenient stand-in.
const ID = "rsh_1754700004000_0a1b2c3d4e5f6071";

describe("parseResearchRefHref", () => {
  it("extracts the id from a well-formed reference", () => {
    expect(parseResearchRefHref(`${RESEARCH_REF_SCHEME}${ID}`)).toBe(ID);
  });

  it("round-trips through researchRefHref", () => {
    // The compose and parse halves must agree, since they are the two ends of one wire the persona
    // writes and the renderer reads.
    expect(parseResearchRefHref(researchRefHref(ID))).toBe(ID);
  });

  it("tolerates leading whitespace and mixed-case scheme, the way markdown delivers hrefs", () => {
    expect(parseResearchRefHref(`  SPARKLE-RESEARCH:${ID}`)).toBe(ID);
  });

  it("returns null for a different scheme so it falls through to the ordinary link path", () => {
    expect(parseResearchRefHref(`sparkle-agent:${ID}`)).toBeNull();
    expect(parseResearchRefHref("https://example.com")).toBeNull();
    expect(parseResearchRefHref(undefined)).toBeNull();
  });

  it("REFUSES an id carrying anything outside the trust boundary", () => {
    // The value reaches a store lookup, so path separators, whitespace, quotes and a second scheme
    // are all rejected — a rejected id yields null and the pill is never built.
    expect(parseResearchRefHref(`${RESEARCH_REF_SCHEME}../etc/passwd`)).toBeNull();
    expect(parseResearchRefHref(`${RESEARCH_REF_SCHEME}has space`)).toBeNull();
    expect(parseResearchRefHref(`${RESEARCH_REF_SCHEME}a/b`)).toBeNull();
    expect(parseResearchRefHref(`${RESEARCH_REF_SCHEME}`)).toBeNull();
    expect(parseResearchRefHref(`${RESEARCH_REF_SCHEME}${"x".repeat(129)}`)).toBeNull();
  });
});

describe("isWellFormedResearchId", () => {
  it("accepts a real runner id and rejects a malformed one", () => {
    expect(isWellFormedResearchId(ID)).toBe(true);
    expect(isWellFormedResearchId("../x")).toBe(false);
    expect(isWellFormedResearchId("")).toBe(false);
  });
});

describe("stripResearchRefs — the clipboard flattener", () => {
  it("replaces a reference with the words the reader saw", () => {
    const src = `I sent that off — see [how caching works](${researchRefHref(ID)}) for the answer.`;
    // THE SIDE EFFECT: the internal id is gone and the human-readable label remains, so a paste
    // carries the sentence rather than a dead link with a uuid in it.
    const out = stripResearchRefs(src);
    expect(out).toBe("I sent that off — see how caching works for the answer.");
    expect(out).not.toContain(RESEARCH_REF_SCHEME);
    expect(out).not.toContain(ID);
  });

  it("falls back to the id when the author wrote no label", () => {
    expect(stripResearchRefs(`[](${researchRefHref(ID)})`)).toBe(ID);
  });

  it("leaves ordinary links and non-research schemes untouched", () => {
    const src = `[docs](https://example.com) and [@Kraken](sparkle-agent:ag9) stay put.`;
    expect(stripResearchRefs(src)).toBe(src);
  });

  it("does NOT rewrite a reference inside a code span (remark never parses a link there)", () => {
    // The same over-stripping trap the sibling modules document: a regex would edit code the user is
    // copying verbatim; parsing with remark leaves a fenced/inline reference as the literal it is.
    const src = `the source is \`[x](${researchRefHref(ID)})\``;
    expect(stripResearchRefs(src)).toBe(src);
  });

  it("strips the CommonMark title and angle-bracketed forms remark unwraps into real pills", () => {
    // The under-stripping trap: these render as pills, so they MUST be flattened, and only reading
    // the destination from the same grammar the renderer uses catches them.
    expect(stripResearchRefs(`[q](<${researchRefHref(ID)}>)`)).toBe("q");
    expect(stripResearchRefs(`[q](${researchRefHref(ID)} "a title")`)).toBe("q");
  });
});
