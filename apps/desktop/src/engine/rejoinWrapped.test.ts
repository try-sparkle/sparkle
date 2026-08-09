import { describe, expect, it } from "vitest";
import { rejoinWrapped, type WrappedBufferLike } from "./rejoinWrapped";

/**
 * An xterm-shaped buffer. `translateToString(trimRight)` models the real thing: a row the terminal
 * wrapped is FULL so there is nothing to trim, while a row ending a logical line is padded with
 * never-written cells that xterm walks back over. A fake that always trimmed would hide the exact
 * bug this module can introduce — a rejoin that eats the space between two words.
 */
function buffer(rows: readonly { text: string; wrapped: boolean }[]): WrappedBufferLike {
  return {
    length: rows.length,
    getLine: (i) => {
      const row = rows[i];
      if (!row) return undefined;
      return {
        translateToString: (trimRight?: boolean) => (trimRight ? row.text.replace(/\s+$/, "") : row.text),
        isWrapped: row.wrapped,
      };
    },
  };
}

const row = (text: string, wrapped = false) => ({ text, wrapped });

describe("rejoinWrapped", () => {
  it("leaves unwrapped rows alone", () => {
    const b = buffer([row("alpha"), row("beta"), row("gamma")]);
    expect(rejoinWrapped(b, 0, 3)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("joins a run of continuation rows into one logical line", () => {
    const b = buffer([row("Enter to sele"), row("ct · Esc to c", true), row("ancel", true)]);
    expect(rejoinWrapped(b, 0, 3)).toEqual(["Enter to select · Esc to cancel"]);
  });

  // THE SEAM. Only the run's LAST row may be right-trimmed; trimming a continued row would delete
  // the space that separates two words and corrupt every long line silently.
  it("does not trim a row that is continued, so a space at the break survives", () => {
    const b = buffer([row("hello "), row("world", true)]);
    expect(rejoinWrapped(b, 0, 2)).toEqual(["hello world"]);
  });

  it("still trims the padding on the row that ends the run", () => {
    const b = buffer([row("hello "), row("world     ", true)]);
    expect(rejoinWrapped(b, 0, 2)).toEqual(["hello world"]);
  });

  // The callers slice a tail, so `start` can land inside a run — the head of that line is off the
  // top of the window, exactly as it is off the top of the screen.
  it("starts mid-run without inventing the part that scrolled off", () => {
    const b = buffer([row("aaa"), row("bbb", true), row("ccc", true), row("ddd")]);
    expect(rejoinWrapped(b, 1, 4)).toEqual(["bbbccc", "ddd"]);
  });

  it("stops at `end` rather than swallowing the row after it", () => {
    const b = buffer([row("aaa"), row("bbb", true), row("ccc", true)]);
    expect(rejoinWrapped(b, 0, 2)).toEqual(["aaabbb"]);
  });

  it("renders a missing row as empty rather than crashing", () => {
    const b: WrappedBufferLike = { length: 2, getLine: (i) => (i === 0 ? { translateToString: () => "first", isWrapped: false } : undefined) };
    expect(rejoinWrapped(b, 0, 2)).toEqual(["first", ""]);
  });

  it("returns nothing for an empty range", () => {
    expect(rejoinWrapped(buffer([row("a")]), 0, 0)).toEqual([]);
  });
});
