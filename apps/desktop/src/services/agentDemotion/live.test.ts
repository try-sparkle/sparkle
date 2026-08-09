// `awaitLocalFirstFrameLive` — the gate the cloud sandbox's life hangs on. Everything here asserts
// what the function DOES to its listeners and timers, not merely what it resolves to: the failure
// that matters is a wait that tears down the PTY it was watching, or one that resolves without ever
// having seen a frame.

import { describe, it, expect, vi } from "vitest";
import { awaitLocalFirstFrameLive } from "./live";

// The PTY seam, mocked at the SAME layer the production default reaches — so the one test below
// that omits `transport` exercises the real `new LocalTransport(id, { observeAnyEpoch: true })`.
// Every other test here injects a fake transport, which is what let a change to the DEFAULT go
// unnoticed: the line that supplies it was covered by nothing.
const { exitRef, liveEpochRef } = vi.hoisted(() => ({
  exitRef: { cb: null as null | ((e: { id: string; epoch: number }) => void) },
  // The epoch live when the gate starts watching — the PTY its own spawn is about to replace.
  liveEpochRef: { value: 7 },
}));
vi.mock("../../pty", () => ({
  spawnPty: vi.fn(() => Promise.resolve(1)),
  writePty: vi.fn(() => Promise.resolve()),
  resizePty: vi.fn(() => Promise.resolve()),
  killPty: vi.fn(() => Promise.resolve()),
  setPtyPaused: vi.fn(() => Promise.resolve()),
  ptyAck: vi.fn(() => Promise.resolve()),
  onPtyOutput: vi.fn(() => Promise.resolve(() => {})),
  onPtyExit: vi.fn((cb: (e: { id: string; epoch: number }) => void) => {
    exitRef.cb = cb;
    return Promise.resolve(() => {});
  }),
  ignorePtyGone: vi.fn(),
  ptyLiveEpoch: vi.fn(() => Promise.resolve(liveEpochRef.value)),
}));

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

  // THE DEFAULT TRANSPORT, not an injected one. `pty:exit` carries the epoch of the PTY that died,
  // and this gate spawns nothing — so a transport bound to its OWN spawn's epoch would defer this
  // exit on a promise nothing resolves and never reject. The symptom would not be a crash: the wait
  // would run out its full deadline and blame the timeout, holding a billing sandbox open for it.
  it("rejects on the PTY's exit through its DEFAULT (uninjected) transport", async () => {
    const timers = fakeTimers();
    const p = awaitLocalFirstFrameLive({
      agentId: "agent-1",
      timeoutMs: 60_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    // The listener registers over an async `listen()`; let it land before driving the channel.
    await vi.waitFor(() => expect(exitRef.cb).not.toBeNull());
    // A life spawned AFTER we started watching (the floor is 7) — the one we are waiting for.
    exitRef.cb?.({ id: "agent-1", epoch: 8 });
    await expect(p).rejects.toThrow(/exited before it produced any output/);
  });

  // The other direction, through the same default transport. This gate subscribes BEFORE the spawn
  // it waits on, and that spawn is a restart that tears the existing PTY down — so the predecessor's
  // late exit lands with us listening. Accepting it would reject the wait, stand down a HEALTHY
  // newly-spawned local agent, and tell the user demotion failed.
  it("does not reject on the exit of the PTY its own spawn is replacing", async () => {
    const timers = fakeTimers();
    const settled: string[] = [];
    const p = awaitLocalFirstFrameLive({
      agentId: "agent-1",
      timeoutMs: 60_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    p.then(
      () => settled.push("resolved"),
      () => settled.push("rejected"),
    );
    await vi.waitFor(() => expect(exitRef.cb).not.toBeNull());
    exitRef.cb?.({ id: "agent-1", epoch: liveEpochRef.value }); // the doomed predecessor
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toEqual([]);
    // …and the deadline is still armed, so the wait is genuinely still waiting.
    expect(timers.pendingCount).toBe(1);
    timers.fireAll();
    await expect(p).rejects.toThrow(/within 60000ms/);
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
