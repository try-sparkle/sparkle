import { describe, it, expect } from "vitest";
import { snapshotScreen, type ScreenBufferLike } from "./screenSnapshot";

// A fake xterm buffer: each string is one line; translateToString returns it verbatim.
function fakeBuffer(lines: string[]): ScreenBufferLike {
  return {
    length: lines.length,
    getLine: (i) => {
      if (i < 0 || i >= lines.length) return undefined;
      const text = lines[i] ?? "";
      return { translateToString: () => text };
    },
  };
}

describe("snapshotScreen", () => {
  it("returns only the bottom `rows` lines (the visible viewport)", () => {
    const buf = fakeBuffer(["scrolled-1", "scrolled-2", "a", "b", "c"]);
    expect(snapshotScreen(buf, 3)).toBe("a\nb\nc");
  });

  it("returns the whole buffer when it is shorter than `rows`", () => {
    const buf = fakeBuffer(["only", "two"]);
    expect(snapshotScreen(buf, 10)).toBe("only\ntwo");
  });

  it("renders a missing line as an empty string rather than crashing", () => {
    const buf: ScreenBufferLike = {
      length: 2,
      getLine: (i) => (i === 0 ? { translateToString: () => "first" } : undefined),
    };
    expect(snapshotScreen(buf, 2)).toBe("first\n");
  });

  it("returns an empty string for an empty buffer", () => {
    expect(snapshotScreen(fakeBuffer([]), 5)).toBe("");
  });
});
