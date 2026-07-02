// Detects genuine prompt submissions in raw-terminal USER input, so the free-trial meter only
// counts a prompt when the user actually typed non-whitespace content and pressed Enter.
//
// A naive "any carriage return = one prompt" rule over-counts badly in a TUI: bare Enters,
// permission/y-n confirmations answered without typing, and menu navigation (arrow keys + Enter)
// all carry a CR but are NOT prompts. This scanner tracks the user's input line the way a line
// editor would — accumulating printable characters, honoring backspace / kill-line, and skipping
// ANSI escape sequences (arrow keys etc.) — and treats a CR/LF as a submit ONLY when the line held
// non-whitespace text. It cannot know the semantic intent of a short answer (a typed "y" + Enter
// still counts), but it eliminates the empty-submit false positives the naive rule produced.
//
// The escape parser is deliberately BOUNDED: a stray/bare ESC (e.g. the user pressing the Escape
// key) must not swallow the rest of the typed line, or a real prompt would be under-counted. We
// recognize the two forms that actually occur in user keyboard input — CSI (`ESC [ … final`, the
// arrow/nav keys) and SS3 (`ESC O x`, the F-keys) — and treat any other post-ESC byte as ordinary
// input. Program-emitted forms like OSC (`ESC ] … BEL`) are not modeled: they appear in terminal
// OUTPUT, effectively never in USER onData, so handling them would be dead weight.

export interface LineScanState {
  /** Printable text the user has typed since the last submit. */
  buf: string;
  /**
   * ANSI escape-sequence parser state:
   *  - "none": ordinary input
   *  - "esc":  a lone ESC was seen; the next byte decides CSI / SS3 / not-a-sequence
   *  - "csi":  inside `ESC [ …`; consume until a final byte in 0x40–0x7E
   *  - "ss3":  inside `ESC O …`; consume exactly one final byte
   */
  esc: "none" | "esc" | "csi" | "ss3";
}

export function makeLineScanState(): LineScanState {
  return { buf: "", esc: "none" };
}

/**
 * Feed one chunk of USER terminal input (never programmatic agent output). Mutates `state` and
 * returns the number of non-empty lines submitted within this chunk (0, 1, or more for a paste
 * spanning multiple lines). The caller records that many trial prompts.
 */
export function scanSubmittedLines(state: LineScanState, chunk: string): number {
  let submits = 0;
  for (const ch of chunk) {
    // --- ANSI escape-sequence handling (bounded so a stray ESC can't swallow real input) ---
    if (state.esc === "csi") {
      // Parameter (0x30–0x3F) and intermediate (0x20–0x2F) bytes continue the sequence; a final
      // byte in 0x40–0x7E ends it.
      const code = ch.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) state.esc = "none";
      continue;
    }
    if (state.esc === "ss3") {
      state.esc = "none"; // SS3 (`ESC O x`) is exactly one byte after the O
      continue;
    }
    if (state.esc === "esc") {
      if (ch === "[") {
        state.esc = "csi";
        continue;
      }
      if (ch === "O") {
        state.esc = "ss3";
        continue;
      }
      state.esc = "none"; // bare ESC (e.g. the Escape key): not a sequence — handle ch normally
      // fall through to ordinary handling of ch below
    }

    // --- ordinary input handling ---
    if (ch === "\x1b") {
      state.esc = "esc"; // start of a possible escape sequence
    } else if (ch === "\r" || ch === "\n") {
      if (state.buf.trim().length > 0) submits += 1; // submit boundary — count only non-empty
      state.buf = "";
    } else if (ch === "\x7f" || ch === "\b") {
      state.buf = state.buf.slice(0, -1); // backspace / DEL
    } else if (ch === "\x15" || ch === "\x03") {
      state.buf = ""; // Ctrl-U (kill line) or Ctrl-C (cancel): the pending line is gone
    } else if (ch >= " ") {
      state.buf += ch; // printable character
    }
    // other C0 control bytes (tab, etc.) are ignored for submission purposes
  }
  // A lone ESC left pending at the end of a chunk is a bare Escape keypress, NOT the start of a
  // sequence split across reads: for USER keyboard input, arrow/nav sequences arrive whole in a
  // single onData chunk, so ESC is only ever its own event when it's the last byte. Reset it so a
  // following chunk that happens to begin with '[' or 'O' is counted as typed text rather than
  // silently swallowed as a CSI/SS3 introducer. (Only the pre-introducer "esc" state is reset; a
  // mid-CSI/SS3 split is left to resolve on the next byte.)
  if (state.esc === "esc") state.esc = "none";
  return submits;
}
