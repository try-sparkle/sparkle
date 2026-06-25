import { describe, it, expect } from "vitest";
import {
  arrowOverflowDirection,
  arrowKeySequence,
  type ArrowOverflowInput,
} from "./composerArrowOverflow";

// A plain ArrowDown with a collapsed caret at the very end of single-line text — the canonical
// "overflow off the last line" case. Override fields per test.
const ev = (over: Partial<ArrowOverflowInput>): ArrowOverflowInput => ({
  key: "ArrowDown",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  ghostActive: false,
  value: "hello",
  selectionStart: 5,
  selectionEnd: 5,
  ...over,
});

describe("arrowOverflowDirection", () => {
  it("hands off Down off the last line", () => {
    expect(arrowOverflowDirection(ev({ key: "ArrowDown" }))).toBe("down");
  });

  it("hands off Up off the first line", () => {
    expect(arrowOverflowDirection(ev({ key: "ArrowUp", selectionStart: 0, selectionEnd: 0 }))).toBe(
      "up",
    );
  });

  it("hands off either direction on a one-line composer regardless of caret column", () => {
    // Caret mid-line: still the first AND last logical line, so both arrows overflow.
    expect(arrowOverflowDirection(ev({ key: "ArrowDown", selectionStart: 2, selectionEnd: 2 }))).toBe(
      "down",
    );
    expect(arrowOverflowDirection(ev({ key: "ArrowUp", selectionStart: 2, selectionEnd: 2 }))).toBe(
      "up",
    );
  });

  it("hands off from an empty composer", () => {
    expect(arrowOverflowDirection(ev({ value: "", selectionStart: 0, selectionEnd: 0 }))).toBe(
      "down",
    );
  });

  it("stays native when there is a line to move into", () => {
    const value = "line1\nline2";
    // Down from the first line moves the caret down within the text — no handoff.
    expect(
      arrowOverflowDirection(ev({ key: "ArrowDown", value, selectionStart: 2, selectionEnd: 2 })),
    ).toBeNull();
    // Up from the last line likewise stays native.
    expect(
      arrowOverflowDirection(ev({ key: "ArrowUp", value, selectionStart: 8, selectionEnd: 8 })),
    ).toBeNull();
  });

  it("hands off at the true outer edges of multi-line text", () => {
    const value = "line1\nline2";
    expect(
      arrowOverflowDirection(ev({ key: "ArrowUp", value, selectionStart: 2, selectionEnd: 2 })),
    ).toBe("up"); // on the first line
    expect(
      arrowOverflowDirection(ev({ key: "ArrowDown", value, selectionStart: 8, selectionEnd: 8 })),
    ).toBe("down"); // on the last line
  });

  it("ignores non-vertical keys", () => {
    expect(arrowOverflowDirection(ev({ key: "ArrowLeft" }))).toBeNull();
    expect(arrowOverflowDirection(ev({ key: "ArrowRight" }))).toBeNull();
    expect(arrowOverflowDirection(ev({ key: "Enter" }))).toBeNull();
  });

  it("leaves Shift+arrow to native selection", () => {
    expect(arrowOverflowDirection(ev({ shiftKey: true }))).toBeNull();
  });

  it("leaves modified arrows (Cmd/Ctrl/Alt) to the textarea", () => {
    expect(arrowOverflowDirection(ev({ metaKey: true }))).toBeNull();
    expect(arrowOverflowDirection(ev({ ctrlKey: true }))).toBeNull();
    expect(arrowOverflowDirection(ev({ altKey: true }))).toBeNull();
  });

  it("never hands off mid-IME composition", () => {
    expect(arrowOverflowDirection(ev({ isComposing: true }))).toBeNull();
  });

  it("never hands off while a selection is active", () => {
    // A range selection (start !== end) means the arrow has its own native meaning.
    expect(arrowOverflowDirection(ev({ selectionStart: 1, selectionEnd: 5 }))).toBeNull();
  });

  it("keeps focus in the composer while a ghost suggestion is showing", () => {
    // Mid-compose against an autocomplete suggestion: don't yank focus to the terminal.
    expect(arrowOverflowDirection(ev({ key: "ArrowDown", ghostActive: true }))).toBeNull();
    expect(
      arrowOverflowDirection(
        ev({ key: "ArrowUp", ghostActive: true, selectionStart: 0, selectionEnd: 0 }),
      ),
    ).toBeNull();
  });
});

describe("arrowKeySequence", () => {
  it("emits CSI sequences in normal cursor-key mode", () => {
    expect(arrowKeySequence("up", false)).toBe("\x1b[A");
    expect(arrowKeySequence("down", false)).toBe("\x1b[B");
  });

  it("emits SS3 sequences in application cursor-key mode (DECCKM)", () => {
    expect(arrowKeySequence("up", true)).toBe("\x1bOA");
    expect(arrowKeySequence("down", true)).toBe("\x1bOB");
  });
});
