// Unit tests for the AgentTransport seam (W4). Covers:
//   - getTransport selection by runtime (local → LocalTransport, cloud → CloudTransport)
//   - LocalTransport delegation to pty.ts (ZERO behavior change) + listen-before-spawn ordering
//     + pty:exit id filtering + local-only ack/setPaused flow-control
//   - CloudTransport output/backfill/input/exit/kill/resize paths against a FAKE socket
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── pty.ts fake ───────────────────────────────────────────────────────────────────────────────
// Capture the callbacks LocalTransport registers so tests can push output/exit through them, and
// gate the async listen resolution so the ordering test can assert "listener registered before
// spawn". onPtyOutput/onPtyExit return a Promise<UnlistenFn> exactly like the real pty.ts.
const {
  spawnPty,
  writePty,
  resizePty,
  killPty,
  setPtyPaused,
  ptyAck,
  onPtyOutput,
  onPtyExit,
  outRef,
  exitRef,
  outUnlisten,
} = vi.hoisted(() => {
  const outRef = { id: null as string | null, cb: null as null | ((e: { chunk: string; bytes: number }) => void) };
  const exitRef = { cb: null as null | ((e: { id: string }) => void) };
  const outUnlisten = vi.fn();
  const exitUnlisten = vi.fn();
  return {
    spawnPty: vi.fn(() => Promise.resolve()),
    writePty: vi.fn(() => Promise.resolve()),
    resizePty: vi.fn(() => Promise.resolve()),
    killPty: vi.fn(() => Promise.resolve()),
    setPtyPaused: vi.fn((_id: string, _paused: boolean) => Promise.resolve()),
    ptyAck: vi.fn(() => Promise.resolve()),
    onPtyOutput: vi.fn((id: string, cb: (e: { chunk: string; bytes: number }) => void) => {
      outRef.id = id;
      outRef.cb = cb;
      return Promise.resolve(outUnlisten);
    }),
    onPtyExit: vi.fn((cb: (e: { id: string }) => void) => {
      exitRef.cb = cb;
      return Promise.resolve(exitUnlisten);
    }),
    outRef,
    exitRef,
    outUnlisten,
    exitUnlisten,
  };
});

vi.mock("../pty", () => ({
  spawnPty,
  writePty,
  resizePty,
  killPty,
  setPtyPaused,
  ptyAck,
  onPtyOutput,
  onPtyExit,
  ignorePtyGone: vi.fn(),
}));

// relayClient is imported by agentTransport for the default cloud socket accessor; stub it so no
// real socket is touched. Cloud tests inject their own fake socket via CloudTransportOpts.
vi.mock("./relayClient", () => ({ getRelaySocket: vi.fn(() => null) }));

// The default cloud kill path (deleteSession) reads the desktop bearer via Tauri invoke; stub it.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve("bearer-xyz")) }));

import {
  deleteCloudSession,
  getTransport,
  LocalTransport,
  CloudTransport,
  type RelaySocketLike,
} from "./agentTransport";

beforeEach(() => {
  vi.clearAllMocks();
  outRef.id = null;
  outRef.cb = null;
  exitRef.cb = null;
});
afterEach(() => vi.clearAllMocks());

describe("getTransport selection by runtime", () => {
  it("returns a LocalTransport for a local agent", () => {
    expect(getTransport({ id: "a1", runtime: "local" })).toBeInstanceOf(LocalTransport);
  });
  it("returns a CloudTransport for a cloud agent", () => {
    expect(getTransport({ id: "a1", runtime: "cloud" })).toBeInstanceOf(CloudTransport);
  });
});

describe("LocalTransport delegation to pty.ts", () => {
  it("spawn registers the output listener BEFORE spawning the PTY", async () => {
    const t = new LocalTransport("agent-1");
    t.onOutput(() => {});
    // The listen is in flight but spawn must await it before pty_spawn fires.
    await t.spawn({ command: "claude", args: ["--x"], cwd: "/repo", cols: 80, rows: 24 });
    expect(onPtyOutput).toHaveBeenCalledWith("agent-1", expect.any(Function));
    expect(spawnPty).toHaveBeenCalledWith({
      id: "agent-1",
      command: "claude",
      args: ["--x"],
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });
    // Ordering: the onPtyOutput call was issued before spawnPty.
    const outOrder = onPtyOutput.mock.invocationCallOrder[0] ?? Infinity;
    const spawnOrder = spawnPty.mock.invocationCallOrder[0] ?? -Infinity;
    expect(outOrder).toBeLessThan(spawnOrder);
  });

  it("onOutput forwards {chunk,bytes} from the PTY chunk", () => {
    const t = new LocalTransport("agent-1");
    const seen: Array<{ chunk: string; bytes: number }> = [];
    t.onOutput((e) => seen.push(e));
    outRef.cb?.({ chunk: "héllo", bytes: 6 });
    expect(seen).toEqual([{ chunk: "héllo", bytes: 6 }]);
  });

  it("onExit fires ONLY for this agent's id (pty:exit is a global channel)", () => {
    const t = new LocalTransport("agent-1");
    const exits: unknown[] = [];
    t.onExit((e) => exits.push(e));
    exitRef.cb?.({ id: "other-agent" });
    expect(exits).toHaveLength(0);
    exitRef.cb?.({ id: "agent-1" });
    expect(exits).toEqual([{}]);
  });

  it("write / resize / kill / ack / setPaused delegate to the matching pty verb", async () => {
    const t = new LocalTransport("agent-1");
    t.write("y\n");
    expect(writePty).toHaveBeenCalledWith("agent-1", "y\n");
    t.resize(120, 40);
    expect(resizePty).toHaveBeenCalledWith("agent-1", 120, 40);
    await t.kill();
    expect(killPty).toHaveBeenCalledWith("agent-1");
    t.ack(2048);
    expect(ptyAck).toHaveBeenCalledWith("agent-1", 2048);
    t.setPaused(true);
    await Promise.resolve();
    expect(setPtyPaused).toHaveBeenCalledWith("agent-1", true);
  });

  it("setPaused serializes pause/resume so a resume can't overtake an earlier pause", async () => {
    const order: boolean[] = [];
    setPtyPaused.mockImplementation((_id: string, paused: boolean) => {
      order.push(paused);
      return Promise.resolve();
    });
    const t = new LocalTransport("agent-1");
    t.setPaused(true);
    t.setPaused(false);
    // The serialized chain hops through several promises (setPtyPaused's own promise + the .catch);
    // drain the microtask queue fully before asserting order.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([true, false]);
  });

  it("the returned unlisten tears down the PTY listener", async () => {
    const t = new LocalTransport("agent-1");
    const off = t.onOutput(() => {});
    await Promise.resolve(); // let the listen resolve so the unlisten is stored
    off();
    expect(outUnlisten).toHaveBeenCalled();
  });
});

// ── sparkle-6csa: inner unlisten routed through safeUnlisten ─────────────────────────────────────
// LocalTransport's onOutput/onExit each called Tauri's unlisten RAW in two spots — the
// "cancelled before the listen resolved" branch and the returned disposer. Tauri's unlisten is
// async, so once the webview's listeners map is torn down it returns a REJECTED promise rather than
// throwing; a raw, un-awaited call leaks it as an app-level unhandled rejection (the ~37
// "…handlerId" rejections in the bug). Routing through safeUnlisten awaits + swallows that race.
//
// Non-vacuity: each test forces the unlisten fn to reject with the real teardown-race message and
// asserts NO such rejection escapes unhandled. Revert any call site to a raw `u()`/`un?.()` and the
// un-awaited rejected promise surfaces on `process`'s unhandledRejection — the filtered array is
// non-empty and the test fails.
describe("LocalTransport teardown routes inner unlisten through safeUnlisten (sparkle-6csa)", () => {
  // A REJECTING unlisten that mimics Tauri's async unlisten hitting a torn-down listeners map.
  // Deliberately a PLAIN function, NOT a vi.fn: a vi.fn attaches its own handler to the promise it
  // returns (for `mock.results`), which marks the rejection HANDLED — so a raw, dropped call to a
  // vi.fn would never surface on `unhandledRejection` and the test would be vacuous. A plain fn's
  // dropped rejection reaches node's handler, which is exactly the leak this fix prevents.
  // The `as unknown as typeof outUnlisten` cast is compile-time ONLY (the onPty* mock slots are
  // typed `Mock`); it must stay a plain arrow at runtime — do NOT replace it with a vi.fn.
  const rejectingUnlisten = (() =>
    Promise.reject(
      new Error("undefined is not an object (evaluating 'listeners[eventId].handlerId')"),
    )) as unknown as typeof outUnlisten;

  /** Run `trigger`, then wait past node's macrotask so any un-awaited rejection is reported; return
   *  only the teardown-race ("handlerId") rejections so unrelated noise can't flip the assertion. */
  async function teardownRaceRejections(trigger: () => void): Promise<unknown[]> {
    const seen: unknown[] = [];
    const handler = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", handler);
    try {
      trigger();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", handler);
    }
    return seen.filter((r) => (r instanceof Error ? r.message : String(r)).includes("handlerId"));
  }

  it("onOutput disposer swallows an async teardown-race unlisten", async () => {
    onPtyOutput.mockImplementationOnce(() => Promise.resolve(rejectingUnlisten));
    const t = new LocalTransport("agent-1");
    const off = t.onOutput(() => {});
    await Promise.resolve(); // let the listen resolve so `un` is stored
    expect(await teardownRaceRejections(() => off())).toHaveLength(0);
  });

  it("onOutput cancel-before-listen-resolves swallows an async teardown-race unlisten", async () => {
    onPtyOutput.mockImplementationOnce(() => Promise.resolve(rejectingUnlisten));
    const t = new LocalTransport("agent-1");
    // Dispose BEFORE the listen promise's .then runs → the `if (cancelled)` branch tears it down.
    expect(
      await teardownRaceRejections(() => {
        const off = t.onOutput(() => {});
        off();
      }),
    ).toHaveLength(0);
  });

  it("onExit disposer swallows an async teardown-race unlisten", async () => {
    onPtyExit.mockImplementationOnce(() => Promise.resolve(rejectingUnlisten));
    const t = new LocalTransport("agent-1");
    const off = t.onExit(() => {});
    await Promise.resolve();
    expect(await teardownRaceRejections(() => off())).toHaveLength(0);
  });

  it("onExit cancel-before-listen-resolves swallows an async teardown-race unlisten", async () => {
    onPtyExit.mockImplementationOnce(() => Promise.resolve(rejectingUnlisten));
    const t = new LocalTransport("agent-1");
    expect(
      await teardownRaceRejections(() => {
        const off = t.onExit(() => {});
        off();
      }),
    ).toHaveLength(0);
  });
});

// ── CloudTransport against a fake socket ────────────────────────────────────────────────────────

function fakeSocket() {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const socket: RelaySocketLike = {
    emit: (event, payload) => emitted.push({ event, payload }),
    on: (event, cb) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    off: (event, cb) => {
      handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== cb));
    },
  };
  const deliver = (event: string, payload: unknown) =>
    (handlers.get(event) ?? []).forEach((f) => f(payload));
  return { socket, emitted, deliver, handlers };
}

describe("CloudTransport over the relay", () => {
  it("spawn is a no-op attach: it emits `watch` for the agent id (no PTY spawned)", async () => {
    const s = fakeSocket();
    const t = new CloudTransport("sess-9", { getSocket: () => s.socket });
    await t.spawn({ command: "ignored", args: [] });
    expect(s.emitted).toEqual([{ event: "watch", payload: { agent_id: "sess-9" } }]);
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it("onOutput streams backfill + live agent_output frames for THIS id only", () => {
    const s = fakeSocket();
    const t = new CloudTransport("sess-9", { getSocket: () => s.socket });
    const seen: Array<{ chunk: string; bytes: number }> = [];
    t.onOutput((e) => seen.push(e));
    // Backfill replay + a live frame for us, plus a frame for another agent (must be ignored).
    s.deliver("agent_output", { agent_id: "sess-9", chunk: "backfill…" });
    s.deliver("agent_output", { agent_id: "other", chunk: "not mine" });
    s.deliver("agent_output", { agent_id: "sess-9", chunk: "live" });
    expect(seen).toEqual([
      { chunk: "backfill…", bytes: "backfill…".length },
      { chunk: "live", bytes: 4 },
    ]);
  });

  it("write sends remote input as an agent_input frame", () => {
    const s = fakeSocket();
    const t = new CloudTransport("sess-9", { getSocket: () => s.socket });
    t.write("hello\r");
    expect(s.emitted).toContainEqual({
      event: "agent_input",
      payload: { agent_id: "sess-9", text: "hello\r" },
    });
  });

  it("onExit maps the cloud_exit event (with exit_code) for this id only", () => {
    const s = fakeSocket();
    const t = new CloudTransport("sess-9", { getSocket: () => s.socket });
    const exits: Array<{ exitCode?: number }> = [];
    t.onExit((e) => exits.push(e));
    s.deliver("cloud_exit", { agent_id: "other", exit_code: 1 });
    s.deliver("cloud_exit", { agent_id: "sess-9", exit_code: 0 });
    expect(exits).toEqual([{ exitCode: 0 }]);
  });

  it("kill unwatches then ends the server session", async () => {
    const s = fakeSocket();
    const killSession = vi.fn(() => Promise.resolve());
    const t = new CloudTransport("sess-9", { getSocket: () => s.socket, killSession });
    await t.kill();
    expect(s.emitted).toContainEqual({ event: "unwatch", payload: { agent_id: "sess-9" } });
    expect(killSession).toHaveBeenCalledWith("sess-9");
  });

  it("resize is client-side only — it never sends a wire message", () => {
    const s = fakeSocket();
    const t = new CloudTransport("sess-9", { getSocket: () => s.socket });
    t.resize(120, 40);
    expect(s.emitted).toHaveLength(0);
  });

  it("tolerates a not-yet-connected relay (null socket) without throwing", async () => {
    const t = new CloudTransport("sess-9", { getSocket: () => null, killSession: () => Promise.resolve() });
    expect(() => t.write("x")).not.toThrow();
    expect(() => t.onOutput(() => {})()).not.toThrow();
    await expect(t.spawn({ command: "", args: [] })).resolves.toBeUndefined();
    await expect(t.kill()).resolves.toBeUndefined();
  });

  it("the onOutput unlisten stops further frames", () => {
    const s = fakeSocket();
    const t = new CloudTransport("sess-9", { getSocket: () => s.socket });
    const seen: unknown[] = [];
    const off = t.onOutput((e) => seen.push(e));
    s.deliver("agent_output", { agent_id: "sess-9", chunk: "a" });
    off();
    s.deliver("agent_output", { agent_id: "sess-9", chunk: "b" });
    expect(seen).toEqual([{ chunk: "a", bytes: 1 }]);
  });
});

describe("CloudTransport default kill (deleteSession REST path)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("DELETEs /sessions/:id with the bearer token, url-encoding the id", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetchMock);
    const s = fakeSocket();
    // No killSession injected → the default deleteSession REST path runs.
    const t = new CloudTransport("sess/9 x", { getSocket: () => s.socket });
    await t.kill();
    expect(s.emitted).toContainEqual({ event: "unwatch", payload: { agent_id: "sess/9 x" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/sessions/sess%2F9%20x",
      expect.objectContaining({
        method: "DELETE",
        headers: { Authorization: "Bearer bearer-xyz" },
      }),
    );
  });

  // The close path AWAITS this call, so a black-holed connection must not hang the tab teardown
  // until the platform's TCP timeout — the request carries its own deadline (roborev 46881). The
  // deadline is AbortController-driven, NOT `AbortSignal.timeout`, which the macOS 11 WKWebView
  // floor lacks (there it would throw before `fetch` is even called, silently sending no DELETE at
  // all — roborev 46918). Asserted by aborting a never-settling request under fake timers.
  it("aborts a DELETE that never settles, instead of hanging the teardown", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const done = vi.fn();
      const p = deleteCloudSession("sess-9").catch(done);
      await vi.advanceTimersByTimeAsync(1); // let the bearer-token await resolve
      expect(fetchMock).toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled(); // still in flight before the deadline
      await vi.advanceTimersByTimeAsync(10_000);
      await p;
      expect(done).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the deadline timer once the DELETE succeeds", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));
      await deleteCloudSession("sess-9");
      expect(vi.getTimerCount()).toBe(0); // no straggler keeping the event loop warm
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when the server responds non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 500 } as Response)));
    const s = fakeSocket();
    const t = new CloudTransport("sess-9", { getSocket: () => s.socket });
    await expect(t.kill()).rejects.toThrow(/500/);
  });
});
