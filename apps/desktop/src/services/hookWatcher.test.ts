import { describe, it, expect, vi } from "vitest";
import { watchHookEvents } from "./hookWatcher";
import type { HookEvent } from "../engine/hookEvents";

// A controllable poll: hands back queued chunks one per call, then empty.
function queuedPoll(chunks: { lines: string[]; offset: number; truncated?: boolean }[]) {
  let i = 0;
  const calls: { offset: number; skipExisting: boolean }[] = [];
  const poll = vi.fn(async (_logPath: string, offset: number, skipExisting: boolean) => {
    calls.push({ offset, skipExisting });
    return chunks[i++] ?? { lines: [], offset };
  });
  return { poll, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("watchHookEvents", () => {
  it("parses appended lines into events in order and resumes from the returned offset", async () => {
    const { poll, calls } = queuedPoll([
      { lines: [JSON.stringify({ event: "UserPromptSubmit" })], offset: 30 },
      { lines: [JSON.stringify({ event: "Stop" })], offset: 50 },
    ]);
    const events: HookEvent[] = [];
    const w = watchHookEvents("/log", (e) => events.push(e), { intervalMs: 1, poll });

    await vi.waitFor(() => expect(events.length).toBe(2));
    w.stop();

    expect(events.map((e) => e.event)).toEqual(["UserPromptSubmit", "Stop"]);
    // First poll starts at 0; the second resumes from the first chunk's offset.
    expect(calls[0]!.offset).toBe(0);
    expect(calls[1]!.offset).toBe(30);
  });

  it("skips malformed lines without throwing", async () => {
    const { poll } = queuedPoll([
      { lines: ["{bad json", JSON.stringify({ event: "Stop" })], offset: 10 },
    ]);
    const events: HookEvent[] = [];
    const w = watchHookEvents("/log", (e) => events.push(e), { intervalMs: 1, poll });
    await vi.waitFor(() => expect(events.length).toBe(1));
    w.stop();
    expect(events[0]!.event).toBe("Stop");
  });

  it("does not dispatch events after stop(), even if a poll was already in flight", async () => {
    let resolvePoll!: (c: { lines: string[]; offset: number }) => void;
    const poll = vi.fn(
      () =>
        new Promise<{ lines: string[]; offset: number }>((res) => {
          resolvePoll = res;
        }),
    );
    const events: HookEvent[] = [];
    const w = watchHookEvents("/log", (e) => events.push(e), { intervalMs: 1, poll });
    await flush(); // let the first tick call poll (now pending)
    w.stop();
    // Resolve the in-flight poll after stop(): its events must be dropped.
    resolvePoll({ lines: [JSON.stringify({ event: "Stop" })], offset: 10 });
    await flush();
    expect(events).toHaveLength(0);
  });

  it("stop() halts further polling", async () => {
    const { poll } = queuedPoll([]);
    const w = watchHookEvents("/log", () => {}, { intervalMs: 1, poll });
    await flush();
    w.stop();
    const callsAfterStop = poll.mock.calls.length;
    await new Promise((r) => setTimeout(r, 10));
    expect(poll.mock.calls.length).toBe(callsAfterStop);
  });

  it("skipExisting asks the BACKEND to seek past the backlog, then tails new events", async () => {
    const { poll, calls } = queuedPoll([
      // The backend seeks to EOF and returns no lines at all — it never reads the backlog.
      { lines: [], offset: 100 },
      // Second poll returns a genuinely new event — must be dispatched.
      { lines: [JSON.stringify({ event: "UserPromptSubmit" })], offset: 130 },
    ]);
    const events: HookEvent[] = [];
    const w = watchHookEvents("/log", (e) => events.push(e), {
      intervalMs: 1,
      poll,
      skipExisting: true,
    });
    await vi.waitFor(() => expect(events.length).toBe(1));
    w.stop();
    expect(events.map((e) => e.event)).toEqual(["UserPromptSubmit"]);
    // THE FIX: the skip flag is pushed to the backend on the first poll only. Previously the
    // watcher always started at offset 0 with no flag, so Rust read the whole log every mount
    // and the JS side merely discarded it.
    expect(calls[0]).toEqual({ offset: 0, skipExisting: true });
    expect(calls[1]).toEqual({ offset: 100, skipExisting: false });
  });

  it("never dispatches a backlog the backend returns despite the skip flag", async () => {
    // Defence in depth: if the backend ignored skipExisting and handed back the backlog anyway,
    // replaying it would drive the status engine off a previous session's events.
    const { poll } = queuedPoll([
      { lines: [JSON.stringify({ event: "Stop" }), JSON.stringify({ event: "SessionEnd" })], offset: 100 },
      { lines: [JSON.stringify({ event: "UserPromptSubmit" })], offset: 130 },
    ]);
    const events: HookEvent[] = [];
    const w = watchHookEvents("/log", (e) => events.push(e), {
      intervalMs: 1,
      poll,
      skipExisting: true,
    });
    await vi.waitFor(() => expect(events.length).toBe(1));
    w.stop();
    expect(events.map((e) => e.event)).toEqual(["UserPromptSubmit"]);
  });

  it("without skipExisting, the first poll does not ask the backend to skip", async () => {
    const { poll, calls } = queuedPoll([{ lines: [JSON.stringify({ event: "Stop" })], offset: 20 }]);
    const events: HookEvent[] = [];
    const w = watchHookEvents("/log", (e) => events.push(e), { intervalMs: 1, poll });
    await vi.waitFor(() => expect(events.length).toBe(1));
    w.stop();
    expect(calls[0]).toEqual({ offset: 0, skipExisting: false });
  });

  it("catches up immediately when the backend flags a truncated (capped) read", async () => {
    // The backend caps each read at 1 MiB. When it reports more is waiting, the watcher must
    // re-poll right away rather than idling a full interval per chunk while it is behind.
    const { poll } = queuedPoll([
      { lines: [JSON.stringify({ event: "Stop" })], offset: 100, truncated: true },
      { lines: [JSON.stringify({ event: "SessionEnd" })], offset: 200, truncated: true },
      { lines: [JSON.stringify({ event: "UserPromptSubmit" })], offset: 300 },
    ]);
    const events: HookEvent[] = [];
    // A deliberately long interval: only the zero-delay catch-up path can drain all three
    // chunks inside the assertion window.
    const w = watchHookEvents("/log", (e) => events.push(e), { intervalMs: 10_000, poll });
    await vi.waitFor(() => expect(events.length).toBe(3));
    w.stop();
    expect(events.map((e) => e.event)).toEqual(["Stop", "SessionEnd", "UserPromptSubmit"]);
  });

  it("survives a transient poll rejection and keeps going", async () => {
    let n = 0;
    const poll = vi.fn(async (_l: string, offset: number) => {
      n += 1;
      if (n === 1) throw new Error("file not found yet");
      // Emit the Stop line exactly once (second call), then nothing further.
      if (n === 2) return { lines: [JSON.stringify({ event: "Stop" })], offset: offset + 16 };
      return { lines: [], offset };
    });
    const events: HookEvent[] = [];
    const w = watchHookEvents("/log", (e) => events.push(e), { intervalMs: 1, poll });
    await vi.waitFor(() => expect(events.length).toBe(1));
    w.stop();
    expect(events[0]!.event).toBe("Stop");
  });
});
