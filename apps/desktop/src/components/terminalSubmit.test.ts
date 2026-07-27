import { describe, it, expect } from "vitest";
import { makeLineScanState, scanSubmittedLines, hasPendingInput } from "./terminalSubmit";

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
  it("still counts the line typed after a bare ESC", () => {
    expect(countSubmits(["\x1b", "help me\r"])).toBe(1);
  });

  // Escape CLEARS the input box in the CLI this terminal hosts, so the CR that follows submits
  // nothing — counting it debited a free-trial prompt that was never sent.
  it("honors Escape: a typed-then-escaped line is an empty submit", () => {
    expect(countSubmits(["some prompt", "\x1b", "\r"])).toBe(0);
  });

  it("counts only what was typed after an Escape", () => {
    expect(countSubmits(["abandon this", "\x1b", "start over\r"])).toBe(1);
    expect(countSubmits(["abandon this", "\x1b", "\r"])).toBe(0);
  });

  // An arrow key is ESC-introduced but is NOT an Escape keypress: it must leave the line alone.
  it("does NOT clear the line on arrow keys or F-keys", () => {
    expect(countSubmits(["prompt", "\x1b[D", "\r"])).toBe(1);
    expect(countSubmits(["prompt", "\x1bOP", "\r"])).toBe(1);
  });

  // ESC with more bytes behind it in the SAME chunk is a meta prefix — xterm emits `ESC + DEL` for
  // Option+Backspace and `ESC + CR` for Option+Enter (verified in @xterm/xterm's keyboard mapping).
  // Treating those as a cancel wiped the whole line on an ordinary editing key (roborev 53587).
  // Option+Enter inserts a newline; it is NOT a submit. A two-line prompt is ONE prompt, and
  // counting the soft newline as well debited the free-trial meter twice — over-counting, the
  // direction this file's own rule forbids.
  it("counts a two-line prompt built with Option+Enter exactly once", () => {
    expect(countSubmits(["line one", "\x1b\r", "line two", "\r"])).toBe(1);
  });

  it("does not count an Option+Enter that is never followed by a real Enter", () => {
    expect(countSubmits(["line one", "\x1b\r", "line two"])).toBe(0);
  });

  // roborev 53628. `\` + Enter is the CLI's UNIVERSAL multiline idiom — it needs no meta mapping,
  // so it is the more common of the two spellings — and it arrives as an ordinary printable
  // backslash plus a bare CR. Before this it hit the submit branch and reproduced both defects the
  // Option+Enter handling exists to remove.
  it("treats a trailing backslash + Enter as a soft newline, not a submit", () => {
    expect(countSubmits(["line one\\", "\r", "line two", "\r"])).toBe(1);
  });

  it("keeps the line pending across a backslash continuation, so the pill stays hidden", () => {
    const state = makeLineScanState();
    scanSubmittedLines(state, "line one\\");
    scanSubmittedLines(state, "\r");
    expect(hasPendingInput(state)).toBe(true);
  });

  it("does not count a backslash continuation that never gets a real Enter", () => {
    expect(countSubmits(["line one\\", "\r", "line two"])).toBe(0);
  });

  // An ESCAPED backslash is a literal one, so the line really does end and Enter really does submit.
  it("still submits when the trailing backslash is itself escaped", () => {
    expect(countSubmits(["path C:\\\\", "\r"])).toBe(1);
  });

  // Option+Backspace deletes the previous WORD, not one character.
  it("treats Option+Backspace as a word delete, not a cancel or a character delete", () => {
    // "hi" is the only word: the line is empty by Enter, so nothing is counted.
    expect(countSubmits(["hi", "\x1b\x7f", "\r"])).toBe(0);
    // …but only the last word goes; what remains is still a real prompt.
    expect(countSubmits(["fix the bug", "\x1b\x7f", "\r"])).toBe(1);
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

// The SECOND consumer of the same scan: "is the user mid-line at the CLI prompt right now?", which
// is what the terminal-anchored action pill hides on. There is no React `value` for that line — it
// is painted by the CLI inside the xterm canvas — so this scanner is the only source of the signal.
describe("hasPendingInput", () => {
  function after(chunks: string[]): boolean {
    const state = makeLineScanState();
    for (const c of chunks) scanSubmittedLines(state, c);
    return hasPendingInput(state);
  }

  it("is false on a fresh, untouched prompt line", () => {
    expect(after([])).toBe(false);
  });

  it("is true the moment the user types", () => {
    expect(after(["w"])).toBe(true);
    expect(after(["what's the status"])).toBe(true);
  });

  it("stays false for whitespace only, matching the submit rule", () => {
    expect(after(["   "])).toBe(false);
  });

  it("clears on Enter — the line was submitted", () => {
    expect(after(["ship it", "\r"])).toBe(false);
  });

  it("clears on Ctrl-C, Ctrl-U and Escape — the line was cancelled", () => {
    expect(after(["never mind", "\x03"])).toBe(false);
    expect(after(["never mind", "\x15"])).toBe(false);
    expect(after(["never mind", "\x1b"])).toBe(false);
  });

  it("clears when the user backspaces the line away", () => {
    expect(after(["hi", "\x7f\x7f"])).toBe(false);
  });

  // Menu navigation is not composing: answering a permission prompt with arrows must leave the
  // recommended-action pill exactly where it is.
  it("stays false through arrow-key menu navigation", () => {
    expect(after(["\x1b[B", "\x1b[B"])).toBe(false);
  });

  it("survives cursor movement inside a line the user is still writing", () => {
    expect(after(["fix the bug", "\x1b[D", "\x1b[C"])).toBe(true);
  });

  // THE regression this signal exists to prevent: an ordinary editing key must not report the line
  // as empty and pop the action pill back over an input box the user is visibly still typing in.
  // Option+Backspace arrives as `ESC + DEL` in one chunk and was being read as a cancel
  // (roborev 53587).
  it("stays true through Option+Backspace — a word edit, not a cancel", () => {
    expect(after(["fix the bug", "\x1b\x7f"])).toBe(true);
  });

  // THE case the previous fix still got wrong: the user breaks the line with Option+Enter and
  // pauses before typing the second line — the normal rhythm of composing a multi-line prompt. The
  // line is still there, so the pill must stay away.
  it("stays true on the pause right after an Option+Enter line break", () => {
    expect(after(["line one", "\x1b\r"])).toBe(true);
    expect(after(["line one", "\x1b\r", "line two"])).toBe(true);
  });

  // A soft newline on its own is not content: trim() governs, so the pill still shows.
  it("is false for an Option+Enter pressed on an empty line", () => {
    expect(after(["\x1b\r"])).toBe(false);
  });
})
