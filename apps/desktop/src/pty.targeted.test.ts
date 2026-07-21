// `pty:output` used to be an APP-WIDE broadcast: every Terminal registered a global listener and
// filtered by id AFTER delivery. With N agents that is N producers × N listeners — every chunk
// materialized and handed to N callbacks that discard N-1 of them, i.e. O(N²) fanout of the single
// hottest event in the app. Delivery is now targeted via a per-agent event name, so a terminal's
// callback is only ever invoked for its OWN agent's output.

import { describe, it, expect, vi, beforeEach } from "vitest";

// A fake Tauri event bus: `listen(name, cb)` registers on an exact channel name, and `emit` only
// invokes the callbacks registered for that name — mirroring Tauri's own per-event-name dispatch.
const channels = new Map<string, Set<(ev: { payload: unknown }) => void>>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (ev: { payload: unknown }) => void) => {
    const set = channels.get(name) ?? new Set();
    set.add(cb);
    channels.set(name, set);
    return Promise.resolve(() => set.delete(cb));
  }),
}));

const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    return Promise.resolve();
  }),
}));

vi.mock("./engine/engineRegistry", () => ({ noteUserInputForAgent: vi.fn() }));

import { onPtyOutput, ptyAck, PTY_OUTPUT_EVENT_PREFIX } from "./pty";

function emit(name: string, payload: unknown) {
  for (const cb of channels.get(name) ?? []) cb({ payload });
}

describe("onPtyOutput targeted delivery", () => {
  beforeEach(() => {
    channels.clear();
    invoked.length = 0;
  });

  it("subscribes to a per-agent channel, not the app-wide one", async () => {
    await onPtyOutput("agent-a", () => {});
    expect([...channels.keys()]).toEqual([`${PTY_OUTPUT_EVENT_PREFIX}agent-a`]);
    // The old global channel must have no subscribers — that was the O(N²) fanout.
    expect(channels.has("pty:output")).toBe(false);
  });

  it("delivers a chunk only to the terminal that owns that agent", async () => {
    const a: string[] = [];
    const b: string[] = [];
    await onPtyOutput("agent-a", (e) => a.push(e.chunk));
    await onPtyOutput("agent-b", (e) => b.push(e.chunk));

    emit(`${PTY_OUTPUT_EVENT_PREFIX}agent-a`, { id: "agent-a", chunk: "hello", bytes: 5 });
    expect(a).toEqual(["hello"]);
    expect(b).toEqual([]); // never materialized for the other terminal at all

    emit(`${PTY_OUTPUT_EVENT_PREFIX}agent-b`, { id: "agent-b", chunk: "world", bytes: 5 });
    expect(a).toEqual(["hello"]);
    expect(b).toEqual(["world"]);
  });

  it("carries the authoritative UTF-8 byte count for the credit ack", async () => {
    const seen: { chunk: string; bytes: number }[] = [];
    await onPtyOutput("agent-a", (e) => seen.push({ chunk: e.chunk, bytes: e.bytes }));
    // "é" is 1 UTF-16 unit but 2 UTF-8 bytes — the frontend must echo Rust's count, not recompute
    // it from string length, or credit drifts and slowly wedges (or unbounds) the gate.
    emit(`${PTY_OUTPUT_EVENT_PREFIX}agent-a`, { id: "agent-a", chunk: "é", bytes: 2 });
    expect(seen).toEqual([{ chunk: "é", bytes: 2 }]);
  });

  it("unlistening removes only that agent's subscription", async () => {
    const a: string[] = [];
    const un = await onPtyOutput("agent-a", (e) => a.push(e.chunk));
    await onPtyOutput("agent-b", () => {});
    un();
    emit(`${PTY_OUTPUT_EVENT_PREFIX}agent-a`, { id: "agent-a", chunk: "x", bytes: 1 });
    expect(a).toEqual([]);
    expect(channels.get(`${PTY_OUTPUT_EVENT_PREFIX}agent-b`)?.size).toBe(1);
  });

  it("ptyAck returns credit to the owning PTY", async () => {
    await ptyAck("agent-a", 4096);
    expect(invoked).toEqual([{ cmd: "pty_ack", args: { id: "agent-a", bytes: 4096 } }]);
  });

  it("ptyAck swallows the benign teardown race", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("no such pty"));
    await expect(ptyAck("gone", 1)).resolves.toBeUndefined();
  });
});
