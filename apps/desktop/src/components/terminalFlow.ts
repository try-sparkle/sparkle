// PTY read backpressure (flow control) — the frontend half of .
//
// Raw child output arrives as `pty:output` events and is handed to xterm via term.write(). xterm
// PARSES those bytes asynchronously on its own schedule; if a runaway-verbose child (a build log,
// `yes`, a chatty agent) outpaces the parser, xterm's internal write buffer grows without bound,
// blowing up memory and stalling the UI.
//
// SCOPE — this controller bounds the xterm PARSE backlog and nothing else. It used to claim it also
// bounded "the Tauri IPC queue feeding it", which it structurally cannot: onEnqueue runs inside the
// `pty:output` handler, i.e. only after the main thread has already dequeued the message, so queue
// depth is invisible here. That half of the job belongs to the producer-side credit gate — see
// `PtyAckBatcher` at the bottom of this file and `InflightState` in pty.rs.
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

// ── IPC credit return ─────────────────────────────────────────────────────────────────────────
//
// The controller above is, by construction, blind to the queue the header claims it bounds: its
// onEnqueue runs INSIDE the `pty:output` handler, so the main thread has already dequeued and
// deserialized the message by the time it counts anything. When the main thread is the bottleneck,
// messages pile up in tao's unbounded IPC channel while `pending` stays low and the brake never
// fires — and `pty_set_paused` is itself an invoke, so the pause would queue behind the very flood
// it was meant to stop.
//
// So the real bound lives on the PRODUCER side (pty.rs `InflightState`): Rust charges each emitted
// chunk's byte count and parks the flusher + reader past a per-PTY ceiling. This class is the
// consumer half — it returns that credit once xterm has actually parsed a chunk.
//
// Coalesced deliberately: acking per chunk would mean up to ~80 `pty_ack` invokes/sec/PTY (and 20×
// that across a full board) on the main thread we are trying to keep responsive. Batching returns
// the same credit in far fewer crossings, while the byte threshold keeps a genuine flood from
// waiting on a scheduler tick that a busy main thread may be slow to reach.

/** Send an ack once this much credit has accrued, without waiting for the scheduler tick. */
export const PTY_ACK_BATCH_BYTES = 32 * 1024;

/**
 * Coalesces per-chunk credit returns into fewer `pty_ack` invokes.
 *
 * Correctness contract: the total sent must EXACTLY equal the total added — over-releasing would
 * unbound the producer's queue again, under-releasing would leak credit until the PTY wedges
 * (until the Rust stall valve fires). `send` and `schedule` are injected so this stays pure and
 * unit-testable.
 */
export class PtyAckBatcher {
  private queued = 0;
  private scheduled = false;

  constructor(
    private readonly send: (bytes: number) => void,
    private readonly schedule: (fn: () => void) => void = (fn) => queueMicrotask(fn),
    private readonly threshold = PTY_ACK_BATCH_BYTES,
  ) {}

  /** Account for a chunk xterm has finished parsing. Non-positive counts are ignored. */
  add(bytes: number): void {
    if (bytes <= 0) return;
    this.queued += bytes;
    if (this.queued >= this.threshold) {
      this.flush();
      return;
    }
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => {
        this.scheduled = false;
        this.flush();
      });
    }
  }

  /** Return whatever credit has accrued right now (also called on teardown). No-op when empty. */
  flush(): void {
    const bytes = this.queued;
    this.queued = 0;
    if (bytes > 0) this.send(bytes);
  }
}
