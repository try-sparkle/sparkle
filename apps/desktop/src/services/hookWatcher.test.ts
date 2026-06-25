import { describe, it, expect, vi } from "vitest";
import { watchHookEvents } from "./hookWatcher";
import type { HookEvent } from "../engine/hookEvents";

// A controllable poll: hands back queued chunks one per call, then empty.
function queuedPoll(chunks: { lines: string[]; offset: number }[]) {
  let i = 0;
  const calls: { offset: number }[] = [];
  const poll = vi.fn(async (_logPath: string, offset: number) => {
    calls.push({ offset });
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

  it("skipExisting drains the pre-existing backlog without dispatching it, then tails new events", async () => {
    const { poll, calls } = queuedPoll([
      // First poll returns the stale backlog (prior runs + background sessions) — must be skipped.
      { lines: [JSON.stringify({ event: "Stop" }), JSON.stringify({ event: "SessionEnd" })], offset: 100 },
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
    // The backlog was skipped; only the post-EOF event reached the consumer.
    expect(events.map((e) => e.event)).toEqual(["UserPromptSubmit"]);
    // The offset still advanced past the skipped backlog so we don't re-read it.
    expect(calls[0]!.offset).toBe(0);
    expect(calls[1]!.offset).toBe(100);
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
