import { describe, it, expect } from "vitest";
import {
  countLines,
  shouldPasteAsPill,
  isImagePath,
  basename,
  buildSendPayload,
  buildDisplay,
  rangeSelect,
  PILL_MIN_LINES,
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
    ).toBe('"/Users/me/My Photos/a.png" look');
  });
  it("leaves space-free paths unquoted", () => {
    expect(
      buildSendPayload({ attachments: [img({ path: "/tmp/a.png" })], textBlocks: [], typed: "" }),
    ).toBe("/tmp/a.png");
  });
  it("escapes embedded quotes and backslashes inside a quoted path", () => {
    expect(
      buildSendPayload({
        attachments: [img({ path: '/tmp/a "b"/c.png' })],
        textBlocks: [],
        typed: "",
      }),
    ).toBe('"/tmp/a \\"b\\"/c.png"');
  });
  it("quotes a path containing a quote even with no whitespace", () => {
    expect(
      buildSendPayload({ attachments: [img({ path: '/tmp/a"b.png' })], textBlocks: [], typed: "" }),
    ).toBe('"/tmp/a\\"b.png"');
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
