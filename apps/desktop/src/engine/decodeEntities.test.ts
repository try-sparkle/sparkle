import { describe, it, expect } from "vitest";
import { decodeHtmlEntities, normalizeAgentName } from "./decodeEntities";

describe("decodeHtmlEntities", () => {
  it("decodes the reported agent name", () => {
    // The exact string the roster held for the worker under Cockpit Column Resize.
    expect(normalizeAgentName("Pane Mounting &amp; Resize Perf")).toBe(
      "Pane Mounting & Resize Perf",
    );
  });

  it("decodes a DOUBLE-escaped ampersand, which a single pass would leave broken", () => {
    expect(normalizeAgentName("Pane Mounting &amp;amp; Resize Perf")).toBe(
      "Pane Mounting & Resize Perf",
    );
  });

  it("leaves an already-correct name byte-identical", () => {
    // The common case, and the one that proves this is safe to run on every ingest: the roster
    // holds plenty of raw ampersands ("Spider Chart & Live Task") that must not change.
    for (const name of ["Spider Chart & Live Task", "Waterfall & Team Health", "Plain Name"]) {
      expect(normalizeAgentName(name)).toBe(name);
    }
  });

  it("decodes the other entities escapeHtml produces", () => {
    expect(decodeHtmlEntities("a &lt;b&gt; c")).toBe("a <b> c");
    expect(decodeHtmlEntities("&quot;quoted&quot;")).toBe('"quoted"');
    expect(decodeHtmlEntities("it&#39;s")).toBe("it's");
    expect(decodeHtmlEntities("it&apos;s")).toBe("it's");
    expect(decodeHtmlEntities("hex &#x26; ref")).toBe("hex & ref");
  });

  it("leaves unknown entities literal rather than guessing", () => {
    // Silently rewriting entities we don't model is how a decoder starts mangling real text.
    expect(decodeHtmlEntities("wait&hellip;")).toBe("wait&hellip;");
    expect(decodeHtmlEntities("A&B")).toBe("A&B");
    expect(decodeHtmlEntities("100&percnt;")).toBe("100&percnt;");
  });

  it("refuses character refs that would inject control characters into a one-line label", () => {
    expect(decodeHtmlEntities("a&#10;b")).toBe("a&#10;b"); // newline
    expect(decodeHtmlEntities("a&#0;b")).toBe("a&#0;b"); // NUL
    expect(decodeHtmlEntities("a&#xD800;b")).toBe("a&#xD800;b"); // lone surrogate
    expect(decodeHtmlEntities("a&#99999999;b")).toBe("a&#99999999;b"); // out of range
  });

  it("terminates on a pathological input instead of looping", () => {
    // Each pass peels one layer; the cap stops it. The assertion is that it RETURNS — a decoder
    // that looped to a fixpoint unbounded would hang here.
    const nested = "&amp;".repeat(1) + "amp;".repeat(50) + "x";
    const out = decodeHtmlEntities(nested);
    expect(typeof out).toBe("string");
    expect(out.endsWith("x")).toBe(true);
  });
});
