// snapshotScreen — render the visible terminal viewport to plain text for the status
// classifier. Kept as a pure function over a minimal structural view of xterm's buffer
// (not the live Terminal) so the buffer-slicing math is unit-testable without xterm/React.
// A regression here would silently degrade status accuracy, so it earns its own test.

import { rejoinWrapped, type WrappedBufferLike, type WrappedLineLike } from "./rejoinWrapped";

/** The slice of @xterm/xterm's IBufferLine we use. */
export type BufferLineLike = WrappedLineLike;

/** The slice of @xterm/xterm's IBuffer we use. */
export type ScreenBufferLike = WrappedBufferLike;

/**
 * The bottom `rows` lines of `buffer` joined as plain text — i.e. the visible screen. Any
 * pending prompt the agent drew sits at the bottom, so the viewport is the right window.
 * Falls back gracefully when the buffer is shorter than `rows`.
 */
export function snapshotScreen(buffer: ScreenBufferLike, rows: number): string {
  // `rows` bounds the ROWS we walk — the visible grid. Soft-wrapped rows are then rejoined into the
  // logical lines every classifier here is anchored to (engine/rejoinWrapped, bead sparkle-99o9a):
  // a credential prompt or a picker footer that wrapped at a narrow pane width must not read as two
  // unrelated lines.
  const start = Math.max(0, buffer.length - rows);
  return rejoinWrapped(buffer, start, buffer.length).join("\n");
}
