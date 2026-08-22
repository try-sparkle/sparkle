// @vitest-environment jsdom
//
// TWO PRODUCTION BEHAVIOURS THAT SHIPPED UNCOVERED, AND BOTH CAN SILENTLY REGRESS.
//
// The tail tick gained a fourth job — re-issuing the FIRST PAGE while an agent is bound but has no
// live edge yet. That path made two latent defects reachable on the ORDINARY path rather than the
// exceptional one, and the fixes for both were invisible to every existing row:
//
//   • The heal branch's only concurrency guard was `inFlightRef`, which the mount-time first-page
//     effect never sets (it sets `loading`). Existing heal rows resolve the mount page synchronously
//     before the first tick, so `loading` is already false and the guard is never exercised.
//   • `failuresRef`/`skippedRef` live for the lifetime of the hook INSTANCE, and `ConciergeHost`
//     calls this hook once for the window. No row mounted a quiet agent long enough to reach the
//     backoff ceiling and THEN switched agents.
//
// Each row here fails with its fix removed.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useAgentTranscript } from "./useAgentTranscript";
import { useMountedThreadStore } from "../stores/mountedThreadStore";
import { forgetAgentTranscriptPath, noteAgentSessionId } from "../services/agentTranscriptRegistry";

const A = "agent-a";
const B = "agent-b";
const WT_A = "/wt/agent-a";
const WT_B = "/wt/agent-b";
const FILE = "/home/u/.claude/projects/-wt-agent-a/sess-a.jsonl";

const emptyPage = (over: Record<string, unknown> = {}) => ({
  entries: [],
  next: null,
  hasMore: false,
  sessionsScanned: 0,
  filesOpened: 0,
  tailFile: null,
  tailByte: 0,
  ...over,
});

function Harness({ agentId, worktree }: { agentId: string; worktree: string }) {
  useAgentTranscript(agentId, worktree);
  return null;
}

const pageCalls = () => invoke.mock.calls.filter(([c]) => c === "agent_transcript_page");
const tailCalls = () => invoke.mock.calls.filter(([c]) => c === "agent_transcript_tail");

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  useMountedThreadStore.setState({ threads: {} });
  localStorage.clear();
  for (const id of [A, B]) {
    forgetAgentTranscriptPath(id);
    noteAgentSessionId(id, `sess-${id}`);
  }
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("useAgentTranscript — the heal branch", () => {
  it("does not stack a second page under a first page that is still loading", async () => {
    // A page is the EXPENSIVE read — it scans and mtime-sorts the whole session directory, and one
    // measured worktree holds 1,172 files. A first page slower than one tick used to get a fully
    // redundant second one issued underneath it, exactly when reads are already slow.
    let releaseFirstPage: (v: unknown) => void = () => {};
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_transcript_page") {
        return new Promise((resolve) => {
          releaseFirstPage = resolve;
        });
      }
      if (cmd === "agent_transcript_tail") return { entries: [], file: null, nextByte: 0 };
      return undefined;
    });

    render(<Harness agentId={A} worktree={WT_A} />);
    await act(async () => { await Promise.resolve(); });
    expect(pageCalls()).toHaveLength(1); // the mount-time page, still in flight

    // Several ticks pass while it is STILL loading. None of them may issue a second page.
    for (let i = 0; i < 4; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    }
    expect(pageCalls()).toHaveLength(1);

    await act(async () => {
      releaseFirstPage(emptyPage());
      await Promise.resolve();
    });
  });

  it("gives a newly mounted agent a fresh backoff instead of the previous agent's", async () => {
    // The hook instance outlives the agent, so a quiet agent that drove the counters to the ceiling
    // used to hand the NEXT agent a ~60s tail interval on its first second of life.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_transcript_page") return emptyPage(); // bound, but no live edge yet
      if (cmd === "agent_transcript_tail") return { entries: [], file: null, nextByte: 0 };
      return undefined;
    });

    const { rerender } = render(<Harness agentId={A} worktree={WT_A} />);
    await act(async () => { await Promise.resolve(); });
    // Drive A well past the backoff ceiling: every heal attempt returns a null tail anchor.
    for (let i = 0; i < 40; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    }
    const aPages = pageCalls().length;
    expect(aPages).toBeGreaterThan(1); // it really did back off rather than never trying

    // Now mount a DIFFERENT agent on the same hook instance, and give it a live edge.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_transcript_page") return emptyPage({ tailFile: FILE, tailByte: 10 });
      if (cmd === "agent_transcript_tail") return { entries: [], file: FILE, nextByte: 10 };
      return undefined;
    });
    rerender(<Harness agentId={B} worktree={WT_B} />);
    await act(async () => { await Promise.resolve(); });
    const tailsBefore = tailCalls().length;

    // ONE tick. With A's exhausted counters inherited, B would be skipping ~64 of them.
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(tailCalls().length).toBeGreaterThan(tailsBefore);
  });
});
