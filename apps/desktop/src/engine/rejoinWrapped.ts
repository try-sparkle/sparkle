// rejoinWrapped — turn xterm's PHYSICAL rows back into the LOGICAL lines the user is reading.
//
// ── WHY THIS EXISTS (bead sparkle-99o9a) ──────────────────────────────────────────────────────
// xterm stores one buffer line per SCREEN ROW. A line longer than the grid is wide occupies
// several rows, and every continuation row carries `IBufferLine.isWrapped`. Both of this app's
// buffer readers — `services/terminalScrollback.serializeScrollback` and
// `engine/screenSnapshot.snapshotScreen` — used to call `translateToString` per row and concatenate
// with newlines, which throws that flag away and hands every downstream matcher a document whose
// lines break wherever the pane happens to be wide.
//
// EVERY SCREEN MATCHER IN THIS APP IS LINE-ANCHORED, so that is not cosmetic. The measured case: a
// picker footer ("Enter to select · Tab/Arrow keys to navigate · Esc to cancel", 59 characters) in
// a 13-column agent column landed on six rows, splitting mid-word; `PICKER_FOOTER` is anchored to
// one rendered line, so it matched none of them; `parsePickerOptionsWithBounds` returns early with
// no footer and never looks at the option rows at all. A five-option menu detected as nothing,
// `read_picker_options` answered `present: false`, and the concierge — which could still READ the
// menu, because an LLM reads across a wrap without noticing — had no way to answer it.
//
// The same class had already been hit and patched in the wrong place: `nudger.rs`'s
// `the_rendered_screen_rejoins_hard_wrapped_lines` pins that Rust's `vt100::contents()` rejoins,
// and names the frontend consequence for credential prompts — a password prompt whose colon landed
// on the next row defeating every `…:\s*$` pattern, which is why `voice/dictationTerminalRoute`
// grew a wrap-tolerant `screenTail` arm. One matcher was taught to cope; the reader was left
// broken for all the others. This fixes the reader.
//
// ── THE ONE SUBTLETY: WHICH ROWS MAY BE TRIMMED ───────────────────────────────────────────────
// A row the terminal wrapped is FULL — its last cell is real content, and the next row continues
// mid-word. A row that ENDS a logical line is padded out with cells that were never written, which
// is what `translateToString(true)` walks back over. So the trim is applied to the LAST row of a
// run and to nothing else: trimming a continued row would delete the space between two words and
// silently corrupt the rejoined line.

/** The slice of `@xterm/xterm`'s `IBufferLine` this needs. `isWrapped` is REQUIRED, not optional:
 *  a field every test double may omit is a seam that defaults to "nothing ever wrapped", which
 *  would make the rejoin untestable by construction. */
export interface WrappedLineLike {
  translateToString(trimRight?: boolean): string;
  readonly isWrapped: boolean;
}

/** The slice of `@xterm/xterm`'s `IBuffer` this needs. */
export interface WrappedBufferLike {
  readonly length: number;
  getLine(index: number): WrappedLineLike | undefined;
}

/**
 * The logical lines spanning buffer rows `[start, end)`.
 *
 * A run is a row plus every following row whose `isWrapped` is set. `start` may land inside a run —
 * the caller is slicing a tail, so the head of that line is simply off the top, exactly as it is on
 * screen.
 */
export function rejoinWrapped(buffer: WrappedBufferLike, start: number, end: number): string[] {
  const out: string[] = [];
  let i = Math.max(0, start);
  while (i < end) {
    let last = i;
    while (last + 1 < end && buffer.getLine(last + 1)?.isWrapped) last++;
    let text = "";
    for (let row = i; row <= last; row++) {
      const line = buffer.getLine(row);
      // Only the run's final row may be right-trimmed — see the header.
      text += line ? line.translateToString(row === last) : "";
    }
    out.push(text);
    i = last + 1;
  }
  return out;
}
