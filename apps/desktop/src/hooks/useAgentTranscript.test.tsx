// @vitest-environment jsdom
//
// The concurrency-sensitive half of the reader, which the filter/render tests cannot reach.
//
// These are the paths where a WRONG-ATTRIBUTION or MISSED-RECORDS bug hides — a slow page for agent
// A landing under agent B's name, a tail read stacking on itself and rewinding its own offset, a
// re-mount throwing away a deep paging cursor. Each test below asserts the specific wrong outcome is
// absent, not merely that something was fetched.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useAgentTranscript } from "./useAgentTranscript";
import { useMountedThreadStore } from "../stores/mountedThreadStore";
import type { TranscriptEntry } from "../services/agentTranscript";

function human(id: string, text: string, ts: string): TranscriptEntry {
  return {
    kind: "human",
    id,
    text,
    timestamp: ts,
    sessionId: "s1",
    promptSource: "typed",
    raw: "{}",
    cursor: { file: "/s1.jsonl", line: 0 },
  };
}

function page(entries: TranscriptEntry[], over: Record<string, unknown> = {}) {
  return {
    entries,
    next: { file: "/s1.jsonl", line: 10 },
    hasMore: true,
    sessionsScanned: 1,
    filesOpened: 1,
    tailFile: "/s1.jsonl",
    tailByte: 500,
    ...over,
  };
}

/** Drives the hook with no UI of its own; the store is the observable surface. */
function Harness({ agentId, worktree }: { agentId: string | null; worktree: string | null }) {
  useAgentTranscript(agentId, worktree);
  return null;
}

let reader: ReturnType<typeof useAgentTranscript> | null = null;
function PagingHarness({ agentId, worktree }: { agentId: string; worktree: string }) {
  reader = useAgentTranscript(agentId, worktree);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  reader = null;
  useMountedThreadStore.setState({ threads: {} });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const entriesOf = (id: string) =>
  (useMountedThreadStore.getState().threads[id]?.entries ?? []).map((e) => e.id);

describe("useAgentTranscript", () => {
  it("does nothing at all when nothing is mounted — no reads, no timer", async () => {
    render(<Harness agentId={null} worktree={null} />);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("loads the first page and records where the live tail starts", async () => {
    invoke.mockResolvedValueOnce(page([human("h1", "hello", "2026-07-30T10:00:00.000Z")]));
    render(<Harness agentId="a1" worktree="/wt/a1" />);
    await flush();

    expect(entriesOf("a1")).toEqual(["h1"]);
    const t = useMountedThreadStore.getState().threads["a1"]!;
    // Taken from the PAGE, so the first tail poll does not have to re-read the whole session to
    // discover its end.
    expect(t.tailFile).toBe("/s1.jsonl");
    expect(t.tailByte).toBe(500);
  });

  // THE WRONG-ATTRIBUTION GUARD. Without the generation counter, agent A's slow page resolves after
  // B is mounted and lands in the store — the pane then shows A's conversation under B's name.
  it("drops a slow page for an agent that is no longer mounted", async () => {
    let resolveA: (v: unknown) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((r) => (resolveA = r)));
    const { rerender } = render(<Harness agentId="a1" worktree="/wt/a1" />);

    // Mount a DIFFERENT agent while A's page is still in flight.
    invoke.mockResolvedValueOnce(page([human("b1", "B's turn", "2026-07-30T11:00:00.000Z")]));
    rerender(<Harness agentId="a2" worktree="/wt/a2" />);
    await flush();

    // Now let A's page land, late.
    await act(async () => {
      resolveA(page([human("a1turn", "A's turn", "2026-07-30T10:00:00.000Z")]));
      await Promise.resolve();
    });

    expect(entriesOf("a2")).toEqual(["b1"]);
    // The late page must not have been written under EITHER key.
    expect(entriesOf("a1")).not.toContain("a1turn");
  });

  it("names the file its tail offset belongs to, so a new session cannot be seeked into", async () => {
    invoke.mockResolvedValueOnce(page([human("h1", "hello", "2026-07-30T10:00:00.000Z")]));
    render(<Harness agentId="a1" worktree="/wt/a1" />);
    await flush();

    invoke.mockResolvedValueOnce({ entries: [], file: "/s1.jsonl", nextByte: 500 });
    await act(async () => {
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
    });

    const tailCall = invoke.mock.calls.find(([cmd]) => cmd === "agent_transcript_tail");
    expect(tailCall).toBeTruthy();
    expect(tailCall![1]).toMatchObject({ fromByte: 500, fromFile: "/s1.jsonl" });
  });

  // THE RE-MOUNT CURSOR GUARD. A fresh page's cursor points ~40 entries below the TIP; adopting it
  // over a deeper one makes every later pageBack re-fetch records already held, so the reader sees
  // "Loading earlier…" and then nothing, repeatedly.
  it("keeps the deeper paging cursor when re-mounting onto entries it already holds", async () => {
    invoke.mockResolvedValueOnce(page([human("h1", "hello", "2026-07-30T10:00:00.000Z")]));
    const { unmount } = render(<Harness agentId="a1" worktree="/wt/a1" />);
    await flush();

    // Pretend the founder paged back: the cursor now points deep into history.
    act(() => {
      useMountedThreadStore
        .getState()
        .patch("a1", { next: { file: "/s0.jsonl", line: 3 }, hasMore: true });
    });
    unmount();

    invoke.mockResolvedValueOnce(page([human("h1", "hello", "2026-07-30T10:00:00.000Z")]));
    render(<Harness agentId="a1" worktree="/wt/a1" />);
    await flush();

    expect(useMountedThreadStore.getState().threads["a1"]!.next).toEqual({
      file: "/s0.jsonl",
      line: 3,
    });
  });

  it("pageBack does nothing once history is exhausted", async () => {
    invoke.mockResolvedValueOnce(page([human("h1", "x", "2026-07-30T10:00:00.000Z")], {
      next: null,
      hasMore: false,
    }));
    render(<PagingHarness agentId="a1" worktree="/wt/a1" />);
    await flush();
    const before = invoke.mock.calls.length;

    act(() => reader!.pageBack());
    await flush();
    expect(invoke.mock.calls.length).toBe(before);
  });

  it("a failed first page leaves an error rather than throwing, and shows no entries", async () => {
    invoke.mockRejectedValueOnce(new Error("no transcript dir"));
    render(<Harness agentId="a1" worktree="/wt/a1" />);
    await flush();

    const t = useMountedThreadStore.getState().threads["a1"]!;
    expect(t.loading).toBe(false);
    expect(t.error).toContain("no transcript dir");
    expect(t.entries).toEqual([]);
  });

  // A tail that cannot be read must not invoke once a second forever. The backoff starts skipping
  // ticks after the failures stop looking transient.
  it("backs off a tail that keeps failing instead of retrying every tick", async () => {
    invoke.mockResolvedValueOnce(page([human("h1", "x", "2026-07-30T10:00:00.000Z")]));
    render(<Harness agentId="a1" worktree="/wt/a1" />);
    await flush();

    invoke.mockRejectedValue(new Error("gone"));
    // 30 ticks. Un-backed-off that is 30 tail reads; with backoff it is far fewer.
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    }
    const tailCalls = invoke.mock.calls.filter(([cmd]) => cmd === "agent_transcript_tail").length;
    expect(tailCalls).toBeGreaterThan(0);
    expect(tailCalls).toBeLessThan(15);
  });
});
