// Pure — no jsdom docblock, no DOM. Everything the chip's face, the persisted stub and the brain's
// prompt agree on is decided here, so this is where the agreement is pinned.
import { describe, expect, it } from "vitest";
import { ANCHOR_QUOTE_MAX } from "./replyAnchors";
import {
  QUOTE_TEXT_MAX,
  makeQuote,
  quoteFace,
  quoteLabel,
  quotePrompt,
  type ComposeQuote,
} from "./composeQuote";

const quote = (over: Partial<ComposeQuote> = {}): ComposeQuote => ({
  text: "PR #1430 is blocked on the CI check that never ran",
  sourceId: "sparkle-15",
  source: "sparkle",
  label: "Concierge",
  ...over,
});

describe("makeQuote", () => {
  it("refuses a selection with no words in it", () => {
    expect(makeQuote({ text: "   \n\t ", sourceId: "sparkle-1", source: "sparkle" })).toBeNull();
    expect(makeQuote({ text: "", sourceId: "sparkle-1", source: "sparkle" })).toBeNull();
  });

  it("keeps the WHOLE selection, not the one-line face", () => {
    const text = "first line\nsecond line\nthird line";
    const q = makeQuote({ text, sourceId: "sparkle-2", source: "sparkle" });
    // The chip shows a line; the brain gets the words. If this ever collapses to one line the
    // founder's quote silently loses its middle.
    expect(q?.text).toBe(text);
  });

  it("caps a runaway selection INCLUDING the ellipsis, so the stored string never exceeds the cap", () => {
    const q = makeQuote({ text: "x".repeat(QUOTE_TEXT_MAX + 500), sourceId: "s", source: "sparkle" });
    expect(q).not.toBeNull();
    expect(q!.text.length).toBeLessThanOrEqual(QUOTE_TEXT_MAX);
    expect(q!.text.endsWith("…")).toBe(true);
  });

  it("leaves a selection at exactly the cap alone", () => {
    const q = makeQuote({ text: "y".repeat(QUOTE_TEXT_MAX), sourceId: "s", source: "sparkle" });
    expect(q!.text).toBe("y".repeat(QUOTE_TEXT_MAX));
    expect(q!.text.endsWith("…")).toBe(false);
  });

  it("carries the source id — the invisible ref the brain resolves against", () => {
    const q = makeQuote({ text: "hello", sourceId: "you-9", source: "you" });
    expect(q).toMatchObject({ sourceId: "you-9", source: "you", label: "You" });
  });
});

describe("quoteLabel", () => {
  it("names each surface", () => {
    expect(quoteLabel("sparkle")).toBe("Concierge");
    expect(quoteLabel("you")).toBe("You");
    expect(quoteLabel("agent", "Kraken Auth")).toBe("Kraken Auth");
  });

  it("falls back rather than captioning an agent chip with nothing", () => {
    // An agent's name can be unresolved when the quote is taken; an empty caption reads as a broken
    // chip, which is worse than a generic one.
    expect(quoteLabel("agent")).toBe("Agent");
    expect(quoteLabel("agent", "   ")).toBe("Agent");
  });
});

describe("quoteFace", () => {
  it("flattens a multi-line quote to ONE line for the chip", () => {
    const face = quoteFace(quote({ text: "first line\n\nsecond   line" }));
    expect(face).toBe("first line second line");
    expect(face).not.toContain("\n");
  });

  it("caps the face at the shared anchor width, not the storage width", () => {
    // The chip and the concierge's own reply stubs must shorten identically — that is the whole
    // reason this delegates to `anchorQuote` instead of rolling its own ellipsis.
    const face = quoteFace(quote({ text: "z".repeat(QUOTE_TEXT_MAX) }));
    expect(face.length).toBeLessThanOrEqual(ANCHOR_QUOTE_MAX);
    expect(face.endsWith("…")).toBe(true);
  });
});

describe("quotePrompt", () => {
  it("puts the fragment above the reply, with the id the brain resolves", () => {
    expect(quotePrompt(quote(), "this one's actually a flake, not us")).toBe(
      "> [quoting Concierge, message sparkle-15]\n" +
        "> PR #1430 is blocked on the CI check that never ran\n" +
        "\n" +
        "this one's actually a flake, not us",
    );
  });

  it("prefixes EVERY line, so a multi-line quote cannot leak into the user's own voice", () => {
    // The failure this guards: with only the first line prefixed, the second paragraph of something
    // the CONCIERGE said reads as something the founder said. That is the one misreading this
    // feature must never produce.
    const out = quotePrompt(quote({ text: "line one\nline two\nline three" }), "my reply");
    const body = out.split("\n\n")[0]!.split("\n");
    expect(body.every((l) => l.startsWith("> "))).toBe(true);
    expect(out).toContain("> line two");
    expect(out).toContain("> line three");
    // …and the reply itself is NOT quoted.
    expect(out.endsWith("\nmy reply")).toBe(true);
  });

  it("does not leave a trailing space on a blank line inside the quote", () => {
    const out = quotePrompt(quote({ text: "para one\n\npara two" }), "r");
    expect(out).toContain("\n>\n");
    expect(out).not.toContain("> \n");
  });

  it("degrades to the quote alone when there is no reply body", () => {
    const out = quotePrompt(quote(), "   ");
    expect(out.endsWith("never ran")).toBe(true);
    expect(out).not.toContain("\n\n");
  });
});
