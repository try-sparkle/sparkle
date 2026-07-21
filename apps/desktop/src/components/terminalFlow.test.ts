import { describe, it, expect } from "vitest";
import { PtyAckBatcher, PtyFlowController } from "./terminalFlow";

describe("PtyFlowController ( flow control)", () => {
  it("pauses past the high-water mark and resumes once drained below the low-water mark", () => {
    const calls: boolean[] = [];
    const flow = new PtyFlowController((p) => calls.push(p), 1000, 200);

    flow.onEnqueue(500);
    expect(flow.isPaused).toBe(false);
    expect(calls).toEqual([]);

    flow.onEnqueue(600); // 1100 >= 1000 → pause
    expect(flow.isPaused).toBe(true);
    expect(flow.pendingBytes).toBe(1100);
    expect(calls).toEqual([true]);

    flow.onParsed(500); // 600 still > 200 → stay paused
    expect(flow.isPaused).toBe(true);
    expect(calls).toEqual([true]);

    flow.onParsed(500); // 100 <= 200 → resume
    expect(flow.isPaused).toBe(false);
    expect(calls).toEqual([true, false]);
  });

  it("never pauses for normal interactive bursts well below the mark", () => {
    const calls: boolean[] = [];
    const flow = new PtyFlowController((p) => calls.push(p));
    for (let i = 0; i < 200; i += 1) {
      flow.onEnqueue(80);
      flow.onParsed(80);
    }
    expect(flow.isPaused).toBe(false);
    expect(flow.pendingBytes).toBe(0);
    expect(calls).toEqual([]);
  });

  it("clamps the backlog at zero and emits no duplicate pause/resume", () => {
    const calls: boolean[] = [];
    const flow = new PtyFlowController((p) => calls.push(p), 1000, 200);

    flow.onParsed(999); // underflow must be clamped, not go negative
    expect(flow.pendingBytes).toBe(0);

    flow.onEnqueue(1000); // pause
    flow.onEnqueue(1000); // already paused → no duplicate
    expect(calls).toEqual([true]);

    flow.onParsed(2000); // 2000 pending → drained → single resume, clamped at 0
    expect(flow.pendingBytes).toBe(0);
    expect(calls).toEqual([true, false]);
  });
});

// The flow controller above can only ever see the xterm PARSE backlog — by the time onEnqueue runs,
// the main thread has already dequeued the IPC message, so the IPC queue depth is invisible to it.
// The credit gate (pty.rs InflightState) closes that hole on the producer side, and PtyAckBatcher is
// the consumer half: it returns credit as xterm finishes parsing, coalesced so a flood doesn't turn
// into one `pty_ack` invoke per chunk on the very main thread we're trying to keep responsive.
describe("PtyAckBatcher (IPC credit return)", () => {
  it("coalesces small acks into one send on the next scheduler tick", () => {
    const sent: number[] = [];
    let pending: (() => void) | null = null;
    const acks = new PtyAckBatcher((n) => sent.push(n), (fn) => { pending = fn; }, 32_000);

    acks.add(100);
    acks.add(250);
    acks.add(50);
    expect(sent).toEqual([]); // nothing sent synchronously — one invoke per chunk is the thing to avoid

    pending!();
    expect(sent).toEqual([400]); // a single coalesced credit return
  });

  it("sends immediately once the batch threshold is reached, without waiting for the tick", () => {
    const sent: number[] = [];
    const acks = new PtyAckBatcher((n) => sent.push(n), () => {}, 1000);

    acks.add(400);
    expect(sent).toEqual([]);
    acks.add(700); // 1100 >= 1000 → flush now; waiting would stall the producer needlessly
    expect(sent).toEqual([1100]);
  });

  it("returns credit exactly once — the total acked always equals the total added", () => {
    const sent: number[] = [];
    const ticks: (() => void)[] = [];
    const acks = new PtyAckBatcher((n) => sent.push(n), (fn) => ticks.push(fn), 1000);

    // Interleave threshold-triggered flushes with scheduled ones: a double-count would over-release
    // credit (unbounding the queue again), a miss would leak it (wedging the producer).
    let total = 0;
    for (const n of [300, 900, 100, 50, 2000, 10]) {
      acks.add(n);
      total += n;
    }
    for (const t of ticks) t();
    expect(sent.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it("ignores non-positive byte counts and never sends an empty ack", () => {
    const sent: number[] = [];
    const ticks: (() => void)[] = [];
    const acks = new PtyAckBatcher((n) => sent.push(n), (fn) => ticks.push(fn));
    acks.add(0);
    acks.add(-5);
    for (const t of ticks) t();
    acks.flush();
    expect(sent).toEqual([]);
  });

  it("flushes outstanding credit on demand (terminal teardown)", () => {
    const sent: number[] = [];
    const acks = new PtyAckBatcher((n) => sent.push(n), () => {}, 1000);
    acks.add(120);
    acks.flush();
    expect(sent).toEqual([120]);
    acks.flush(); // nothing left — must not re-send and double-release credit
    expect(sent).toEqual([120]);
  });
});
