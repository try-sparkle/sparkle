import { describe, it, expect } from "vitest";
import { PtyFlowController } from "./terminalFlow";

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
