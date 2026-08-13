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
import {
  forgetAgentTranscriptPath,
  noteAgentSessionId,
} from "../services/agentTranscriptRegistry";
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

/** Agent ids these tests mount. Their session bindings are seeded/cleared per case below. */
const AGENTS = ["a1", "a2"];

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  reader = null;
  useMountedThreadStore.setState({ threads: {} });
  localStorage.clear();
  // A MOUNTED PANE READS NOTHING UNTIL IT KNOWS WHOSE SESSIONS TO READ. Seeded through the real
  // writer, the same one `AgentPane`'s gated hook handler calls — the reader takes no injectable
  // sessionIds argument precisely so the production path is the tested one. Every case below except
  // the fail-closed ones needs this, which is itself the point.
  for (const id of AGENTS) {
    forgetAgentTranscriptPath(id);
    noteAgentSessionId(id, `sess-${id}`);
  }
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  for (const id of AGENTS) forgetAgentTranscriptPath(id);
  localStorage.clear();
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

// ── WHOSE CONVERSATION IS THIS? (the session binding) ────────────────────────────────────────────
//
// A worktree's session directory holds a `<session-id>.jsonl` for every `claude` that ever ran there
// (1,172 files in one measured worktree). Reading it with only a worktree path returned whichever
// session had the newest mtime, so a pane whose footer read "Chatting with ● Sparkle" rendered a
// different agent's roborev review. These tests pin the two halves of the fix: the binding is SENT,
// and an unknown binding reads NOTHING rather than borrowing the newest file.
describe("useAgentTranscript — the session binding", () => {
  it("sends the agent's own session ids with every read", async () => {
    noteAgentSessionId("a1", "sess-resumed");
    invoke.mockResolvedValue(page([human("h1", "hello", "2026-07-30T10:00:00.000Z")]));
    render(<Harness agentId="a1" worktree="/wt/a1" />);
    await flush();

    const pageCall = invoke.mock.calls.find(([cmd]) => cmd === "agent_transcript_page");
    // BOTH ids — the binding is a SET, because an agent that resumes owns every session it has had.
    // Sending only the newest would drop the history before the resume.
    expect(pageCall![1]).toMatchObject({ sessionIds: ["sess-a1", "sess-resumed"] });

    invoke.mockResolvedValue({ entries: [], file: "/s1.jsonl", nextByte: 500 });
    await act(async () => {
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
    });
    const tailCall = invoke.mock.calls.find(([cmd]) => cmd === "agent_transcript_tail");
    // The tail needs it at least as much: "newest file" is its whole file-selection strategy, so an
    // unbound tail live-follows whichever OTHER agent in the worktree is being written to now.
    expect(tailCall![1]).toMatchObject({ sessionIds: ["sess-a1", "sess-resumed"] });
  });

  // THE FAIL-CLOSED GUARD, and the most important test here. The tempting fallback — no binding, so
  // show the newest session in the directory — IS the defect. An empty pane under a correct name
  // beats a full pane under the wrong one.
  it("reads NOTHING for an agent whose session binding is unknown", async () => {
    forgetAgentTranscriptPath("a1");
    invoke.mockResolvedValue(page([human("stranger", "another agent's words", "2026-07-30T10:00:00.000Z")]));

    render(<Harness agentId="a1" worktree="/wt/a1" />);
    await flush();
    // Plus a tail tick, because an unbound tail is the version of this bug that arrives over time
    // into a pane that looked correct on mount.
    await act(async () => {
      vi.advanceTimersByTime(2100);
      await Promise.resolve();
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(entriesOf("a1")).toEqual([]);
    // And not stuck on a spinner: an unknown binding is a settled empty state, not a pending read.
    expect(useMountedThreadStore.getState().threads["a1"]?.loading).toBe(false);
  });

  // THE TAIL'S OWN FAIL-CLOSED GUARD, reached only with a tail cursor already in hand.
  //
  // Written because a mutation check proved the first version of this test could not see it: with no
  // binding the first page never runs, so `tailFile` stays null and the poll bailed on THAT guard
  // instead — the "an earlier guard short-circuits the path" shape from AGENTS.md. Seeding the cursor
  // is what makes the binding the only thing left standing between the poll and a stranger's session.
  it("does not tail an unbound agent even when a tail cursor is already present", async () => {
    forgetAgentTranscriptPath("a1");
    act(() => {
      useMountedThreadStore.getState().patch("a1", { tailFile: "/s1.jsonl", tailByte: 500 });
    });
    invoke.mockResolvedValue({
      entries: [human("stranger", "another agent's words", "2026-07-30T10:00:00.000Z")],
      file: "/s1.jsonl",
      nextByte: 600,
    });

    render(<Harness agentId="a1" worktree="/wt/a1" />);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(2100);
      await Promise.resolve();
    });

    expect(invoke.mock.calls.filter(([cmd]) => cmd === "agent_transcript_tail")).toEqual([]);
    expect(entriesOf("a1")).toEqual([]);
  });

  // PAGING BACK CARRIES IT TOO. Also written off a mutation check: every other case here either
  // never reaches the pageBack fetch or has history exhausted, so the binding could have been
  // dropped from this one call site with the suite still green — and a pageBack without it walks
  // backwards through every other agent's sessions in the directory.
  it("carries the binding when paging back into history", async () => {
    invoke.mockResolvedValueOnce(page([human("h1", "tip", "2026-07-30T10:00:00.000Z")]));
    render(<PagingHarness agentId="a1" worktree="/wt/a1" />);
    await flush();

    invoke.mockResolvedValueOnce(page([human("h0", "older", "2026-07-30T09:00:00.000Z")]));
    act(() => reader!.pageBack());
    await flush();

    // The older entry really arrived and merged in oldest-first — the side effect, not the call.
    expect(entriesOf("a1")).toEqual(["h0", "h1"]);
    const backCall = invoke.mock.calls.filter(([cmd]) => cmd === "agent_transcript_page")[1];
    expect(backCall![1]).toMatchObject({
      before: { file: "/s1.jsonl", line: 10 },
      sessionIds: ["sess-a1"],
    });
  });

  it("pageBack reads nothing while the binding is unknown", async () => {
    forgetAgentTranscriptPath("a1");
    render(<PagingHarness agentId="a1" worktree="/wt/a1" />);
    await flush();
    act(() => {
      useMountedThreadStore
        .getState()
        .patch("a1", { next: { file: "/s0.jsonl", line: 3 }, hasMore: true });
    });

    invoke.mockResolvedValue(page([human("stranger", "not ours", "2026-07-30T10:00:00.000Z")]));
    act(() => reader!.pageBack());
    await flush();

    expect(invoke).not.toHaveBeenCalled();
    expect(entriesOf("a1")).toEqual([]);
  });

  // SELF-HEALING, and why the binding is SUBSCRIBED rather than read once. It lands on the agent's
  // first hook event, which is routinely after the pane's first render — a one-shot read would
  // capture `undefined` and leave the pane empty forever for an agent we can now identify.
  it("pages as soon as the binding arrives, without a remount", async () => {
    forgetAgentTranscriptPath("a1");
    render(<Harness agentId="a1" worktree="/wt/a1" />);
    await flush();
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValue(page([human("h1", "at last", "2026-07-30T10:00:00.000Z")]));
    await act(async () => {
      noteAgentSessionId("a1", "sess-late");
      await Promise.resolve();
    });
    await flush();

    expect(entriesOf("a1")).toEqual(["h1"]);
    const pageCall = invoke.mock.calls.find(([cmd]) => cmd === "agent_transcript_page");
    expect(pageCall![1]).toMatchObject({ sessionIds: ["sess-late"] });
  });

  // A hook event carrying an id we already hold must not re-page. Events arrive continuously, and a
  // fresh snapshot identity per event would re-fetch the first page once a second forever.
  it("does not re-page when a known session id is re-registered", async () => {
    invoke.mockResolvedValue(page([human("h1", "hello", "2026-07-30T10:00:00.000Z")]));
    render(<Harness agentId="a1" worktree="/wt/a1" />);
    await flush();
    const pagesBefore = invoke.mock.calls.filter(([c]) => c === "agent_transcript_page").length;
    expect(pagesBefore).toBe(1);

    await act(async () => {
      noteAgentSessionId("a1", "sess-a1");
      noteAgentSessionId("a1", "sess-a1");
      await Promise.resolve();
    });
    await flush();

    expect(invoke.mock.calls.filter(([c]) => c === "agent_transcript_page").length).toBe(pagesBefore);
  });

  // THE LATCH THAT THE BINDING DEP MADE REACHABLE (roborev 63135).
  //
  // `pageBack` sets `paging: true` and both of its late returns are gated on the GENERATION. Adding
  // `sessionIds` to the first-page effect's deps introduced a generation bump that cannot be a
  // remount — the binding widening when the agent resumes — so a backwards page in flight when that
  // lands used to return without ever clearing the flag. `paging` is what `pageBack`'s own guard
  // reads, so history became unreachable for the rest of the pane's life.
  //
  // The assertion is the SIDE EFFECT and not the flag: a later `pageBack` must actually ISSUE a
  // read and merge the older entries. Asserting `paging === false` alone would pass against a fix
  // that cleared the flag but left the reader wedged some other way.
  it("clears the paging latch when the binding widens mid-page, so history stays reachable", async () => {
    invoke.mockResolvedValueOnce(page([human("h1", "tip", "2026-07-30T10:00:00.000Z")]));
    render(<PagingHarness agentId="a1" worktree="/wt/a1" />);
    await flush();

    // A backwards page that has NOT resolved yet.
    let resolveBack: (v: unknown) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((r) => (resolveBack = r)));
    act(() => reader!.pageBack());
    await flush();
    expect(useMountedThreadStore.getState().threads["a1"]!.paging).toBe(true);

    // The agent resumes: a SECOND session id joins the binding. The first-page effect re-runs with
    // the widened set and bumps the generation, which is what strands the in-flight page.
    invoke.mockResolvedValueOnce(page([human("h1", "tip", "2026-07-30T10:00:00.000Z")]));
    await act(async () => {
      noteAgentSessionId("a1", "sess-a1-resumed");
      await Promise.resolve();
    });
    await flush();

    // The stranded page lands under the old generation and is dropped — correctly, for its entries.
    await act(async () => {
      resolveBack(page([human("stale", "dropped", "2026-07-30T08:00:00.000Z")]));
      await Promise.resolve();
    });
    await flush();
    expect(entriesOf("a1")).not.toContain("stale");

    // THE POINT: paging back still works. It issues a real read, carrying the widened binding, and
    // the older entry merges in.
    const backsBefore = invoke.mock.calls.filter(([c]) => c === "agent_transcript_page").length;
    invoke.mockResolvedValueOnce(page([human("h0", "older", "2026-07-30T09:00:00.000Z")]));
    act(() => reader!.pageBack());
    await flush();

    expect(invoke.mock.calls.filter(([c]) => c === "agent_transcript_page").length).toBe(
      backsBefore + 1,
    );
    expect(entriesOf("a1")).toEqual(["h0", "h1"]);
  });
});
