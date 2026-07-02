import { describe, it, expect } from "vitest";
import { makeLineScanState, scanSubmittedLines } from "./terminalSubmit";

// Sums the submit count across chunks fed to a single scan state, the way Terminal.onData does.
function countSubmits(chunks: string[]): number {
  const state = makeLineScanState();
  return chunks.reduce((n, c) => n + scanSubmittedLines(state, c), 0);
}

describe("scanSubmittedLines", () => {
  it("counts a typed, non-empty line submitted with Enter", () => {
    expect(countSubmits(["hello world", "\r"])).toBe(1);
  });

  it("counts once for a full line typed and submitted in one chunk", () => {
    expect(countSubmits(["make me a website\r"])).toBe(1);
  });

  it("does NOT count a bare Enter (empty submit)", () => {
    expect(countSubmits(["\r"])).toBe(0);
  });

  it("does NOT count whitespace-only input", () => {
    expect(countSubmits(["   \t ", "\r"])).toBe(0);
  });

  it("does NOT count menu navigation: arrow keys then Enter with no typed text", () => {
    // Down arrow, down arrow, Enter — a TUI selection, not a prompt.
    expect(countSubmits(["\x1b[B", "\x1b[B", "\r"])).toBe(0);
  });

  it("ignores arrow-key escape bytes so cursor movement isn't mistaken for typed text", () => {
    // Type text, move the cursor left/right, then submit: still exactly one prompt.
    expect(countSubmits(["fix the bug", "\x1b[D", "\x1b[C", "\r"])).toBe(1);
  });

  it("treats a pasted \\r\\n as a single submit, not two", () => {
    expect(countSubmits(["deploy the app\r\n"])).toBe(1);
  });

  it("counts each non-empty line in a multi-line paste and skips blank lines", () => {
    expect(countSubmits(["first prompt\r\n\r\nsecond prompt\r"])).toBe(2);
  });

  it("honors backspace: a typed-then-fully-erased line is an empty submit", () => {
    expect(countSubmits(["hi", "\x7f\x7f", "\r"])).toBe(0);
  });

  it("honors Ctrl-U (kill line): cleared input is an empty submit", () => {
    expect(countSubmits(["some prompt", "\x15", "\r"])).toBe(0);
  });

  it("resets the buffer after a submit so the next bare Enter doesn't recount", () => {
    expect(countSubmits(["real prompt\r", "\r"])).toBe(1);
  });

  it("honors Ctrl-C: a typed-then-cancelled line is an empty submit", () => {
    expect(countSubmits(["oops wrong thing", "\x03", "\r"])).toBe(0);
  });

  // A bare ESC (the user pressing the Escape key) must NOT swallow the rest of the typed line.
  it("treats a bare ESC as a no-op and still counts the line typed after it", () => {
    expect(countSubmits(["\x1b", "help me\r"])).toBe(1);
  });

  it("does not get stuck after a lone ESC followed by digits then Enter", () => {
    // Regression: previously ESC left the parser stuck (no letter to terminate), swallowing
    // "123" and never counting the submit.
    expect(countSubmits(["\x1b123\r"])).toBe(1);
  });

  it("consumes an SS3 F-key sequence (ESC O P) without leaking its final byte", () => {
    expect(countSubmits(["\x1bOP", "\r"])).toBe(0);
    expect(countSubmits(["\x1bOPtask\r"])).toBe(1); // 'P' consumed, 'task' typed → one prompt
  });

  it("terminates a CSI sequence on any final byte in 0x40-0x7e (e.g. '@')", () => {
    expect(countSubmits(["\x1b[@", "\r"])).toBe(0);
    expect(countSubmits(["\x1b[3@later\r"])).toBe(1); // '3' param, '@' final, then typed text
  });

  // A chunk-final bare ESC must not swallow a following chunk that begins with '[' or 'O'
  // (a real arrow/F-key sequence arrives whole in one chunk, so a trailing ESC is a bare Escape).
  it("treats a chunk-final ESC as bare, so a next chunk starting with '[' is typed text", () => {
    expect(countSubmits(["\x1b", "[A done\r"])).toBe(1);
  });

  it("treats a chunk-final ESC as bare, so a next chunk starting with 'O' is typed text", () => {
    expect(countSubmits(["\x1b", "OK go\r"])).toBe(1);
  });
});
