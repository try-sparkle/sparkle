// snapshotScreen — render the visible terminal viewport to plain text for the status
// classifier. Kept as a pure function over a minimal structural view of xterm's buffer
// (not the live Terminal) so the buffer-slicing math is unit-testable without xterm/React.
// A regression here would silently degrade status accuracy, so it earns its own test.

/** The slice of @xterm/xterm's IBufferLine we use. */
export interface BufferLineLike {
  translateToString(trimRight?: boolean): string;
}

/** The slice of @xterm/xterm's IBuffer we use. */
export interface ScreenBufferLike {
  readonly length: number;
  getLine(index: number): BufferLineLike | undefined;
}

/**
 * The bottom `rows` lines of `buffer` joined as plain text — i.e. the visible screen. Any
 * pending prompt the agent drew sits at the bottom, so the viewport is the right window.
 * Falls back gracefully when the buffer is shorter than `rows`.
 */
export function snapshotScreen(buffer: ScreenBufferLike, rows: number): string {
  const start = Math.max(0, buffer.length - rows);
  const lines: string[] = [];
  for (let i = start; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }
  return lines.join("\n");
}
