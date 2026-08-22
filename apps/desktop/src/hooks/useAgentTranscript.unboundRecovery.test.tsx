// @vitest-environment jsdom
//
// AN AGENT NOBODY EVER TOLD US ABOUT STILL RENDERS ITS TRANSCRIPT.
//
// The pane fails CLOSED when it does not know which Claude sessions are an agent's — correctly, because
// a session DIRECTORY belongs to a WORKTREE and holds a file for every `claude` that ever ran there
// (measured: one agent's own directory holds 136 session files of which 39 are its own). But that
// binding had exactly ONE production writer, `AgentPane`'s hook handler, and panes mount LAZILY per
// visited project. So an agent whose pane never mounted in this window was unbound, and its mounted
// pane read "No conversation with <name> yet." forever with its terminal live beside it. Measured on
// the founder's machine: 12 of 56 live worktrees.
//
// The recovery asks the agent's OWN hook log — which Sparkle writes whether or not a pane is mounted —
// and accepts what it finds ONLY if `agent_own_session_path` confirms the transcript is where this
// hook will page from. These rows assert the SIDE EFFECT: entries in the store, or the page read
// never being issued at all.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useAgentTranscript } from "./useAgentTranscript";
import { useMountedThreadStore } from "../stores/mountedThreadStore";
import { agentConfigDir, forgetAgentTranscriptPath } from "../services/agentTranscriptRegistry";
import type { TranscriptEntry } from "../services/agentTranscript";

const AGENT = "8e78e87c";
const WORKTREE = `/home/u/Library/Application Support/ai.sparkle.desktop/worktrees/proj/${AGENT}`;
const ACCOUNT = "/home/u/Library/Application Support/ai.sparkle.desktop/accounts/c7c0d098";
const SESSION = "b09a087f";
const TRANSCRIPT = `${ACCOUNT}/projects/-home-u-wt/${SESSION}.jsonl`;
const LOG = `/home/u/Library/Application Support/ai.sparkle.desktop/hook-events/${AGENT}.jsonl`;

function turn(id: string): TranscriptEntry {
  return {
    kind: "human",
    id,
    text: "the words his terminal was showing",
    timestamp: "2026-08-22T05:29:00Z",
    sessionId: SESSION,
    promptSource: "typed",
    raw: "{}",
    cursor: { file: TRANSCRIPT, line: 0 },
  };
}

const hookLine = (event: string) =>
  JSON.stringify({ event, session_id: SESSION, transcript_path: TRANSCRIPT, ts: 1 });

/** Rust, as far as this hook can tell. `transcriptExists` is the ONLY knob — it is what
 *  `agent_own_session_path` answers with, and the whole safety of the recovery rides on it. */
function fakeBackend(opts: { transcriptExists: boolean }) {
  invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "agent_event_log_path") return LOG;
    if (cmd === "read_events_since") {
      const { offset, skipExisting } = args as { offset: number; skipExisting: boolean };
      // The seek-to-EOF probe returns the size without reading; the real read returns the tail.
      if (skipExisting) return { lines: [], offset: 400 };
      return { lines: [hookLine("SessionStart"), hookLine("UserPromptSubmit")], offset: 400 + offset };
    }
    if (cmd === "agent_own_session_path") {
      // STRICT ON THE PAYLOAD, not a boolean knob. `own_session_files` matches a file STEM exactly
      // and resolves the directory from `configDir`, so a permissive stub here would let the stem
      // extraction, the `sessionIds` list and the `configDir` argument each be deleted with every
      // row still green — while in production every real call returned null and the whole recovery
      // became a silent no-op. This answers ONLY for the exact payload the read path needs.
      const a = args as { worktreePath?: string; sessionIds?: string[]; configDir?: string | null };
      const exact =
        a.worktreePath === WORKTREE &&
        Array.isArray(a.sessionIds) &&
        a.sessionIds.length === 1 &&
        a.sessionIds[0] === SESSION &&
        a.configDir === ACCOUNT;
      return exact && opts.transcriptExists ? TRANSCRIPT : null;
    }
    if (cmd === "agent_transcript_page") {
      // Only answers for a read that named the ACCOUNT root — a permissive stub could not tell
      // "the recovered config dir reached the command" from "the command ignored it".
      const dir = (args as { configDir?: string | null }).configDir ?? null;
      return dir === ACCOUNT
        ? {
            entries: [turn("t1")],
            next: null,
            hasMore: false,
            sessionsScanned: 1,
            filesOpened: 1,
            tailFile: TRANSCRIPT,
            tailByte: 10,
          }
        : { entries: [], next: null, hasMore: false, sessionsScanned: 0, filesOpened: 0, tailFile: null, tailByte: 0 };
    }
    if (cmd === "agent_transcript_tail") return { entries: [], file: TRANSCRIPT, nextByte: 10 };
    return undefined;
  });
}

function Harness() {
  useAgentTranscript(AGENT, WORKTREE);
  return null;
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
const entryIds = () =>
  (useMountedThreadStore.getState().threads[AGENT]?.entries ?? []).map((e) => e.id);
const callsTo = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  useMountedThreadStore.setState({ threads: {} });
  localStorage.clear();
  forgetAgentTranscriptPath(AGENT); // NO session ids, NO config dir — the founder's unbound case
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("useAgentTranscript — an agent with no recorded session ids", () => {
  it("recovers the binding from its hook log and renders the transcript", async () => {
    fakeBackend({ transcriptExists: true });
    render(<Harness />);
    await flush();

    // THE FOUNDER'S SYMPTOM, INVERTED: entries, not the empty placeholder.
    expect(entryIds()).toEqual(["t1"]);
  });

  it("also recovers the ACCOUNT config dir, which is what makes those entries reachable at all", async () => {
    fakeBackend({ transcriptExists: true });
    render(<Harness />);
    await flush();

    expect(agentConfigDir(AGENT)).toBe(ACCOUNT);
    // The page that produced the entries named the account root, not $HOME/.claude.
    expect((callsTo("agent_transcript_page").pop()?.[1] as { configDir?: string }).configDir).toBe(ACCOUNT);
  });

  it("stays honestly empty when the recovered transcript no longer exists, and issues no page read", async () => {
    // 2 of the 6 unbound agents measured on the founder's machine are exactly this: their hook log
    // names a transcript under a since-removed account. Binding one would leave the pane in a
    // permanently-failing read, which is strictly worse than the empty state it replaces.
    fakeBackend({ transcriptExists: false });
    render(<Harness />);
    await flush();

    expect(entryIds()).toEqual([]);
    expect(callsTo("agent_transcript_page")).toHaveLength(0);
  });

  it("asks its own hook log once per render pass, not once per render", async () => {
    fakeBackend({ transcriptExists: false });
    const { rerender } = render(<Harness />);
    await flush();
    const afterFirst = callsTo("agent_event_log_path").length;
    rerender(<Harness />);
    await flush();

    // A re-render with the same agent, worktree and (still unknown) binding must not re-probe: the
    // effect's deps have not moved. Retries come from its own bounded timer, not from rendering.
    expect(callsTo("agent_event_log_path")).toHaveLength(afterFirst);
  });

  it("verifies the candidate with the payload the read path itself will use", async () => {
    // The stem, the one-element id list and the recovered config dir are each load-bearing: Rust
    // matches file stems exactly and resolves the directory from `configDir`, so any one of them
    // being wrong makes every verification fail and the feature inert. Asserted directly, because
    // the rows above would still pass if the *page* happened to succeed for another reason.
    fakeBackend({ transcriptExists: true });
    render(<Harness />);
    await flush();

    expect(callsTo("agent_own_session_path")[0]?.[1]).toEqual({
      worktreePath: WORKTREE,
      sessionIds: [SESSION],
      configDir: ACCOUNT,
    });
  });

  it("retries a log that is still empty, then gives up rather than reading forever", async () => {
    // The population this targets has no AgentPane to bind it later, so a single attempt landing in
    // the seconds before an agent's hook log exists would leave the pane empty for the whole app
    // session. It must come back — and it must also stop.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_event_log_path") return LOG;
      if (cmd === "read_events_since") return { lines: [], offset: 0 };
      return undefined;
    });
    render(<Harness />);
    await flush();
    expect(callsTo("agent_event_log_path")).toHaveLength(1);

    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    }
    const total = callsTo("agent_event_log_path").length;
    expect(total).toBeGreaterThan(1); // it retried
    expect(total).toBeLessThanOrEqual(5); // and it stopped
  });

  it("verifies a WINDOWS transcript path, where the separator is a backslash", async () => {
    // Windows is a shipped target (`release.yml`'s build-windows / sparkle-windows-nsis) and Claude
    // writes `transcript_path` with backslashes there. A POSIX-only split returns the WHOLE path as
    // the stem, `own_session_files` matches stems exactly, so every verification fails and the
    // recovery is silently inert on that platform — with every other row in this file green, because
    // they are all POSIX. This row is the one that can see it.
    const WIN_ACCOUNT = "C:\\Users\\u\\AppData\\Roaming\\ai.sparkle.desktop\\accounts\\c7c0d098";
    const WIN_TRANSCRIPT = `${WIN_ACCOUNT}\\projects\\-c-wt\\${SESSION}.jsonl`;
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "agent_event_log_path") return LOG;
      if (cmd === "read_events_since") {
        const { skipExisting } = args as { skipExisting: boolean };
        if (skipExisting) return { lines: [], offset: 400 };
        return {
          lines: [
            JSON.stringify({
              event: "SessionStart",
              session_id: SESSION,
              transcript_path: WIN_TRANSCRIPT,
              ts: 1,
            }),
          ],
          offset: 400,
        };
      }
      if (cmd === "agent_own_session_path") {
        const a = args as { sessionIds?: string[]; configDir?: string | null };
        // Exactly as Rust would: the stem must be the bare session id, not a path fragment.
        return a.sessionIds?.[0] === SESSION && a.configDir === WIN_ACCOUNT ? WIN_TRANSCRIPT : null;
      }
      if (cmd === "agent_transcript_page") {
        return {
          entries: [turn("w1")],
          next: null,
          hasMore: false,
          sessionsScanned: 1,
          filesOpened: 1,
          tailFile: WIN_TRANSCRIPT,
          tailByte: 10,
        };
      }
      if (cmd === "agent_transcript_tail") return { entries: [], file: WIN_TRANSCRIPT, nextByte: 10 };
      return undefined;
    });

    render(<Harness />);
    await flush();

    expect(callsTo("agent_own_session_path")[0]?.[1]).toMatchObject({ sessionIds: [SESSION] });
    expect(entryIds()).toEqual(["w1"]);
  });
});
