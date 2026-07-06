// PTY read backpressure (flow control) — the frontend half of .
//
// Raw child output arrives as `pty:output` events and is handed to xterm via term.write(). xterm
// PARSES those bytes asynchronously on its own schedule; if a runaway-verbose child (a build log,
// `yes`, a chatty agent) outpaces the parser, xterm's internal write buffer — and the Tauri IPC
// queue feeding it — grow without bound, blowing up memory and stalling the UI.
//
// The fix: count bytes handed to term.write() but not yet parsed (xterm invokes the write callback
// once it consumes a chunk). Past HIGH_WATER we ask the PTY to pause reading (pty_set_paused(true));
// once the backlog drains below LOW_WATER we resume. The gap between the two marks prevents
// pause/resume thrashing, and both sit FAR above any interactive burst, so ordinary typing/echo and
// normal streaming never trip it — only a sustained flood does.
//
// The Rust reader thread, while paused, stops read()ing the master; the kernel PTY buffer then fills
// and the child blocks on its own write() — genuine end-to-end backpressure that drops/corrupts no
// bytes (unlike truncation). See pty.rs `PauseState` / `pty_set_paused`.

// Chosen generously: a couple MiB of un-parsed output is a real flood, not an interactive burst.
export const FLOW_HIGH_WATER_BYTES = 2 * 1024 * 1024; // pending ≥ this → pause the PTY
export const FLOW_LOW_WATER_BYTES = 512 * 1024; // drained ≤ this → resume the PTY

/**
 * Tracks the xterm write backlog and toggles PTY read-pause across the high/low-water marks.
 * Pure and framework-free so it's unit-testable; the caller supplies `setPaused` (which invokes
 * `pty_set_paused`) and feeds it byte counts on enqueue (before term.write) and on parse (the
 * term.write callback). Byte counts are approximate (string length is a fine proxy for watermark
 * purposes) — only the same measure must be used for both enqueue and parse so the backlog nets out.
 */
export class PtyFlowController {
  private pending = 0;
  private paused = false;

  constructor(
    private readonly setPaused: (paused: boolean) => void,
    private readonly high = FLOW_HIGH_WATER_BYTES,
    private readonly low = FLOW_LOW_WATER_BYTES,
  ) {}

  /** Account for a chunk about to be written to xterm; requests a pause once past the high mark. */
  onEnqueue(byteLength: number): void {
    this.pending += byteLength;
    if (!this.paused && this.pending >= this.high) {
      this.paused = true;
      this.setPaused(true);
    }
  }

  /** Account for a chunk xterm has finished parsing; requests a resume once drained below the low mark. */
  onParsed(byteLength: number): void {
    this.pending -= byteLength;
    if (this.pending < 0) this.pending = 0; // guard against double-accounting on teardown races
    if (this.paused && this.pending <= this.low) {
      this.paused = false;
      this.setPaused(false);
    }
  }

  get pendingBytes(): number {
    return this.pending;
  }

  get isPaused(): boolean {
    return this.paused;
  }
}
