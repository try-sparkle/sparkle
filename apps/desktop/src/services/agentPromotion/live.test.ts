import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The relay socket and the Tauri bearer are the only things live.ts touches that a test can't have.
// Stub them at the module boundary; everything else here runs the real code.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("../relayClient", () => ({ getRelaySocket: () => ({ emit() {}, on() {}, off() {} }) }));

import { awaitFirstFrameLive } from "./live";
import type { TransportOutput } from "../agentTransport";

/** A fake transport that records its calls and lets the test push a frame when it chooses. */
function fakeTransport() {
  const listeners: Array<(e: TransportOutput) => void> = [];
  const calls: string[] = [];
  return {
    calls,
    emitFrame: () => listeners.forEach((l) => l({ chunk: "hello", bytes: 5 })),
    unlistened: 0,
    transport: {
      spawn: async () => {
        calls.push("spawn");
      },
      onOutput: (cb: (e: TransportOutput) => void) => {
        calls.push("onOutput");
        listeners.push(cb);
        return () => {
          calls.push("unlisten");
        };
      },
    },
  };
}

const never = () => new Promise<string | null>(() => {});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("awaitFirstFrameLive", () => {
  it("resolves on the first output frame", async () => {
    const f = fakeTransport();
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 60_000,
      transport: f.transport,
      pollStatus: never,
    });
    await vi.advanceTimersByTimeAsync(0);
    f.emitFrame();
    await expect(p).resolves.toBeUndefined();
  });

  it("subscribes BEFORE it attaches, so the session's first bytes can't be missed", async () => {
    const f = fakeTransport();
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 60_000,
      transport: f.transport,
      pollStatus: never,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.indexOf("onOutput")).toBeLessThan(f.calls.indexOf("spawn"));
    f.emitFrame();
    await p;
  });

  it("removes its listener once settled — but never detaches", async () => {
    // `detach()` emits `unwatch` on the SHARED relay socket, which would tear down the terminal's
    // own stream the instant it attaches. Only our own handler comes off.
    const f = fakeTransport();
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 60_000,
      transport: f.transport,
      pollStatus: never,
    });
    await vi.advanceTimersByTimeAsync(0);
    f.emitFrame();
    await p;
    expect(f.calls).toContain("unlisten");
    expect(f.calls).not.toContain("detach");
  });

  it("rejects at the deadline when nothing ever streams", async () => {
    const f = fakeTransport();
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 5_000,
      transport: f.transport,
      pollStatus: never,
    });
    const assertion = expect(p).rejects.toThrow(/within 5000ms/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("fails FAST on a terminal server status instead of waiting out the clock", async () => {
    // Without the poll, the commonest failure — the sandbox refused to start — would cost the user
    // the full two-minute timeout before saying anything.
    const f = fakeTransport();
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 120_000,
      transport: f.transport,
      pollStatus: async () => "error",
      pollIntervalMs: 1_000,
    });
    const assertion = expect(p).rejects.toThrow(/reported "error"/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("keeps waiting through a LIVE status — 'pending' is a booting sandbox, not a failure", async () => {
    const f = fakeTransport();
    let settled = false;
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 120_000,
      transport: f.transport,
      pollStatus: async () => "pending",
      pollIntervalMs: 1_000,
    }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    f.emitFrame();
    await p;
    expect(settled).toBe(true);
  });

  it("keeps waiting when the status is UNREADABLE — 'I couldn't check' is not 'it failed'", async () => {
    const f = fakeTransport();
    let settled = false;
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 120_000,
      transport: f.transport,
      pollStatus: async () => null,
      pollIntervalMs: 1_000,
    }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    f.emitFrame();
    await p;
  });

  it("keeps waiting when the status poll THROWS", async () => {
    const f = fakeTransport();
    let settled = false;
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 120_000,
      transport: f.transport,
      pollStatus: async () => {
        throw new Error("offline");
      },
      pollIntervalMs: 1_000,
    }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    f.emitFrame();
    await p;
  });

  it("rejects when the attach itself fails", async () => {
    const f = fakeTransport();
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 60_000,
      transport: {
        ...f.transport,
        spawn: async () => {
          throw new Error("relay down");
        },
      },
      pollStatus: never,
    });
    const assertion = expect(p).rejects.toThrow(/relay down/);
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it("cleans up ONCE — a frame arriving after the deadline re-runs nothing", async () => {
    // NOT "the promise doesn't un-reject": JS guarantees that whatever this code does, so asserting
    // it would prove nothing. What the settled-latch actually buys is that the late frame doesn't
    // re-enter teardown — tearing an already-removed listener down a second time.
    const f = fakeTransport();
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 1_000,
      transport: f.transport,
      pollStatus: never,
    });
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.calls.filter((c) => c === "unlisten")).toHaveLength(1);
    f.emitFrame();
    expect(f.calls.filter((c) => c === "unlisten")).toHaveLength(1);
    await assertion;
  });

  // Wraps the injected timer seam so a test can see what is still pending. The poll-count test
  // below cannot distinguish "cleared the timer" from "the entry guard caught the tick" — three
  // cheap defences cover this path — so this one asserts the cleanup DIRECTLY.
  function timerSpy() {
    const outstanding = new Set<unknown>();
    return {
      outstanding,
      setTimer: (fn: () => void, ms: number) => {
        const h: unknown = setTimeout(() => {
          outstanding.delete(h);
          fn();
        }, ms);
        outstanding.add(h);
        return h;
      },
      clearTimer: (h: unknown) => {
        outstanding.delete(h);
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
    };
  }

  it("leaves NO timer pending once it resolves", async () => {
    const f = fakeTransport();
    const t = timerSpy();
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 120_000,
      transport: f.transport,
      pollStatus: never,
      pollIntervalMs: 1_000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.outstanding.size).toBeGreaterThan(0); // the deadline + the poll are armed
    f.emitFrame();
    await p;
    expect(t.outstanding.size).toBe(0);
  });

  it("leaves NO timer pending once it rejects", async () => {
    const f = fakeTransport();
    const t = timerSpy();
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 1_000,
      transport: f.transport,
      pollStatus: never,
      pollIntervalMs: 5_000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(t.outstanding.size).toBe(0);
  });

  it("stops polling once it has settled", async () => {
    const f = fakeTransport();
    const poll = vi.fn(async () => "pending");
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 120_000,
      transport: f.transport,
      pollStatus: poll,
      pollIntervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(2_500);
    f.emitFrame();
    await p;
    const after = poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(poll.mock.calls.length).toBe(after);
  });
});

describe("awaitFirstFrameLive — the attach must actually land", () => {
  it("rejects IMMEDIATELY when there is no relay socket", async () => {
    // CloudTransport no-ops both `watch` and `onOutput` with a null socket and never retries the
    // subscription, so the wait could only ever run out the clock — and the caller reads a timeout
    // as "the sandbox never came up" and DELETEs a session that is perfectly healthy.
    const f = fakeTransport();
    await expect(
      awaitFirstFrameLive({
        sessionId: "s1",
        timeoutMs: 120_000,
        transport: f.transport,
        pollStatus: never,
        relayConnected: () => false,
      }),
    ).rejects.toThrow(/relay/i);
    // And it does so without waiting: no timers armed, nothing attached.
    expect(f.calls).toEqual([]);
  });

  it("re-emits `watch` on every tick, so a session that registers LATE is still picked up", async () => {
    // The start POST returns the id and kicks the runner off fire-and-forget; the relay's `watch`
    // handler installs nothing for a session its registry doesn't have yet, and never retries.
    // Emitting once, in the tick the start resolved, races that window and loses silently.
    const f = fakeTransport();
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 120_000,
      transport: f.transport,
      pollStatus: async () => "pending",
      pollIntervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter((c) => c === "spawn")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(f.calls.filter((c) => c === "spawn").length).toBeGreaterThan(1);
    f.emitFrame();
    await p;
  });

  it("keeps waiting on a status it does not RECOGNIZE, rather than deleting a live sandbox", async () => {
    // `LIVE_CLOUD_STATUSES` means "worth re-attaching to", not "definitely dead", so failing on its
    // complement makes any status this build has never heard of — a runner adding `queued` — a
    // 3-second failure that destroys a healthy session.
    const f = fakeTransport();
    let settled = false;
    const p = awaitFirstFrameLive({
      sessionId: "s1",
      timeoutMs: 120_000,
      transport: f.transport,
      pollStatus: async () => "provisioning",
      pollIntervalMs: 1_000,
    }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    f.emitFrame();
    await p;
    expect(settled).toBe(true);
  });

  it("still fails fast on the statuses it DOES recognize as terminal", async () => {
    for (const status of ["error", "complete"]) {
      const f = fakeTransport();
      const p = awaitFirstFrameLive({
        sessionId: "s1",
        timeoutMs: 120_000,
        transport: f.transport,
        pollStatus: async () => status,
        pollIntervalMs: 1_000,
      });
      const assertion = expect(p).rejects.toThrow(new RegExp(`reported "${status}"`));
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    }
  });
});
