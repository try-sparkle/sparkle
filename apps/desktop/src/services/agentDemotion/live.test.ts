// `awaitLocalFirstFrameLive` — the gate the cloud sandbox's life hangs on. Everything here asserts
// what the function DOES to its listeners and timers, not merely what it resolves to: the failure
// that matters is a wait that tears down the PTY it was watching, or one that resolves without ever
// having seen a frame.

import { describe, it, expect, vi } from "vitest";
import { awaitLocalFirstFrameLive } from "./live";

/** A transport whose output/exit can be driven, recording every unlisten. */
function fakeTransport() {
  const outputs: Array<() => void> = [];
  const exits: Array<() => void> = [];
  const unlistened: string[] = [];
  return {
    transport: {
      onOutput(cb: (e: { chunk: string; bytes: number }) => void) {
        outputs.push(() => cb({ chunk: "hi", bytes: 2 }));
        return () => {
          unlistened.push("output");
        };
      },
      onExit(cb: (e: { exitCode?: number }) => void) {
        exits.push(() => cb({}));
        return () => {
          unlistened.push("exit");
        };
      },
    },
    emitOutput: () => outputs.forEach((f) => f()),
    emitExit: () => exits.forEach((f) => f()),
    unlistened,
  };
}

/** Controllable timers so the deadline can be fired without wall-clocking. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  const cleared: number[] = [];
  let next = 1;
  return {
    setTimer: (fn: () => void) => {
      const h = next++;
      pending.set(h, fn);
      return h;
    },
    clearTimer: (h: unknown) => {
      cleared.push(h as number);
      pending.delete(h as number);
    },
    fireAll: () => [...pending.values()].forEach((f) => f()),
    cleared,
    get pendingCount() {
      return pending.size;
    },
  };
}

describe("awaitLocalFirstFrameLive", () => {
  it("resolves on the FIRST output frame and clears its deadline", async () => {
    const t = fakeTransport();
    const timers = fakeTimers();
    const p = awaitLocalFirstFrameLive({
      agentId: "a",
      timeoutMs: 1000,
      transport: t.transport,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    t.emitOutput();
    await expect(p).resolves.toBeUndefined();
    // Both subscriptions AND the deadline are released — a listener left behind on a PTY that
    // outlives the wait is a leak per demoted agent.
    expect(t.unlistened.sort()).toEqual(["exit", "output"]);
    expect(timers.pendingCount).toBe(0);
  });

  it("does NOT resolve before a frame arrives", async () => {
    const t = fakeTransport();
    const timers = fakeTimers();
    let settled = false;
    const p = awaitLocalFirstFrameLive({
      agentId: "a",
      timeoutMs: 1000,
      transport: t.transport,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    t.emitOutput();
    await p;
    expect(settled).toBe(true);
  });

  it("rejects when the PTY exits before producing any output", async () => {
    const t = fakeTransport();
    const timers = fakeTimers();
    const p = awaitLocalFirstFrameLive({
      agentId: "a",
      timeoutMs: 1000,
      transport: t.transport,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    t.emitExit();
    await expect(p).rejects.toThrow(/exited before it produced any output/);
    // Failing fast on the exit is the point: a billing sandbox must not be held open for the full
    // deadline when the local spawn is already known to be dead.
    expect(timers.pendingCount).toBe(0);
  });

  it("rejects on the deadline, naming the timeout", async () => {
    const t = fakeTransport();
    const timers = fakeTimers();
    const p = awaitLocalFirstFrameLive({
      agentId: "a",
      timeoutMs: 1234,
      transport: t.transport,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    timers.fireAll();
    await expect(p).rejects.toThrow(/within 1234ms/);
  });

  it("a frame arriving after the deadline cannot flip a rejection into a resolve", async () => {
    const t = fakeTransport();
    const timers = fakeTimers();
    const p = awaitLocalFirstFrameLive({
      agentId: "a",
      timeoutMs: 10,
      transport: t.transport,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    timers.fireAll();
    t.emitOutput();
    await expect(p).rejects.toThrow();
  });

  it("never kills or detaches the transport it is watching", async () => {
    // For a LocalTransport `detach()` IS kill, so a wait that tore itself down that way would end
    // the very PTY it just proved was alive. Assert the verb is simply absent from what we use.
    const detach = vi.fn();
    const kill = vi.fn();
    const t = fakeTransport();
    const p = awaitLocalFirstFrameLive({
      agentId: "a",
      timeoutMs: 1000,
      transport: { ...t.transport, detach, kill } as never,
      setTimer: fakeTimers().setTimer,
      clearTimer: () => {},
    });
    t.emitOutput();
    await p;
    expect(detach).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });
});
