// @vitest-environment jsdom
//
// THE AGENT WITH NO PANE — the case whose ABSENCE let a regression ship (roborev 63133 / 63135).
//
// Keying the mounted transcript on the agent's real Claude session ids fixed a wrong-conversation
// bug and, in the same stroke, turned the feature OFF for the agent the bug was reported against.
// Writer (3)'s only production writer was `AgentPane`'s gated hook handler; the app-owned Improve
// Sparkle agent has no `AgentPane` (`SparkleAgentPane` wires no hook handler, and the hourly pass is
// headless), so its binding was permanently `undefined`, the fail-closed branch fired forever, and
// the mounted pane rendered an empty transcript with no reads, no tail and no error. Every existing
// test seeded a binding through `noteAgentSessionId`, i.e. through the one writer that agent can
// never reach — so the whole suite stayed green.
//
// So this file mounts an agent whose ONLY registration is a WORKTREE, the way `SparkleAgentPane
// .prepare()` and the hourly pass register it, and asserts ITS OWN turns render. The counter-case is
// here too: an agent registered by the ordinary fleet path must STILL read nothing, because seeding
// every registered worktree from a directory scan is the original defect re-entered from the other
// side.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useAgentTranscript } from "./useAgentTranscript";
import { useSparkleSessionBinding } from "./useSparkleSessionBinding";
import { useMountedThreadStore } from "../stores/mountedThreadStore";
import {
  forgetAgentTranscriptPath,
  noteAgentTranscriptWorktree,
} from "../services/agentTranscriptRegistry";
import { registerSparkleTranscript } from "../services/sparkleTranscript";
import { SPARKLE_AGENT_ID } from "../services/sparkleAgent";
import type { TranscriptEntry } from "../services/agentTranscript";

/** The app-owned agent's worktree, and two sessions inside it — the hourly pass opens a NEW one
 *  every hour, which is why a registration-time resolve is not enough on its own. */
const WORKTREE = "/app-data/sparkle-self/worktrees/__sparkle_self__";
const DIR = "/home/u/.claude/projects/-app-data-sparkle-self";
const LAST_PASS = `${DIR}/pass-1.jsonl`;
const THIS_PASS = `${DIR}/pass-2.jsonl`;

function human(id: string, text: string, ts: string): TranscriptEntry {
  return {
    kind: "human",
    id,
    text,
    timestamp: ts,
    sessionId: "s1",
    promptSource: "typed",
    raw: "{}",
    cursor: { file: THIS_PASS, line: 0 },
  };
}

function page(entries: TranscriptEntry[]) {
  return {
    entries,
    next: { file: THIS_PASS, line: 10 },
    hasMore: true,
    sessionsScanned: 1,
    filesOpened: 1,
    tailFile: THIS_PASS,
    tailByte: 500,
  };
}

/**
 * Stand in for the worktree's project directory. `newest` is what `claude_latest_session_path`
 * resolves RIGHT NOW — the thing that changes as a new pass starts writing — and `turns` is what
 * `agent_transcript_page` returns for a read that carried a binding.
 *
 * `agent_transcript_page` here FAILS CLOSED exactly as Rust's `own_session_files` does: a read whose
 * `sessionIds` does not name the file is answered with an empty page. Without that, this suite could
 * not tell "the binding reached the read" from "the read ignored it", which is the whole question.
 */
function fakeProjectDir(dir: { newest: string | null; turns: Record<string, TranscriptEntry[]> }) {
  invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "claude_latest_session_path") return dir.newest;
    if (cmd === "agent_transcript_page") {
      const ids = (args as { sessionIds?: string[] }).sessionIds;
      if (!ids || ids.length === 0) return page([]);
      const entries = ids.flatMap((id) => dir.turns[id] ?? []);
      return page(entries);
    }
    if (cmd === "agent_transcript_tail") return { entries: [], file: THIS_PASS, nextByte: 500 };
    return undefined;
  });
  return dir;
}

/** Drives both hooks the way `ConciergeHost` does: the binding first, then the reader. */
function MountedPane({ agentId, worktree }: { agentId: string; worktree: string }) {
  useSparkleSessionBinding(agentId, worktree);
  useAgentTranscript(agentId, worktree);
  return null;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const entriesOf = (id: string) =>
  (useMountedThreadStore.getState().threads[id]?.entries ?? []).map((e) => e.id);

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  useMountedThreadStore.setState({ threads: {} });
  localStorage.clear();
  forgetAgentTranscriptPath(SPARKLE_AGENT_ID);
  forgetAgentTranscriptPath("build-agent");
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  forgetAgentTranscriptPath(SPARKLE_AGENT_ID);
  forgetAgentTranscriptPath("build-agent");
  localStorage.clear();
});

describe("mounting an agent that has no pane, hence no hook events", () => {
  // THE TEST WHOSE ABSENCE LET THE REGRESSION SHIP. No `noteAgentSessionId` anywhere in it: the only
  // registration is the worktree one the app itself performs, and the pane must still render this
  // agent's OWN turns.
  it("renders its own turns for an agent whose only registration is a worktree", async () => {
    fakeProjectDir({
      newest: THIS_PASS,
      turns: {
        "pass-2": [human("mine", "reading the retro logs", "2026-08-12T10:00:00.000Z")],
        "someone-else": [human("stranger", "pr-checks.sh review", "2026-08-12T10:05:00.000Z")],
      },
    });

    // Exactly what `SparkleAgentPane.prepare()` and the hourly pass do, and nothing else.
    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    await flush();

    render(<MountedPane agentId={SPARKLE_AGENT_ID} worktree={WORKTREE} />);
    await flush();

    // ITS OWN TURNS RENDERED — the side effect, not "a read was attempted".
    expect(entriesOf(SPARKLE_AGENT_ID)).toEqual(["mine"]);
    // …and the read was CONSTRAINED to this agent, so the stranger sharing the directory is absent
    // because it was never eligible, not because the fixture happened not to return it.
    const call = invoke.mock.calls.find(([c]) => c === "agent_transcript_page");
    expect(call![1]).toMatchObject({ worktreePath: WORKTREE, sessionIds: ["pass-2"] });
  });

  // THE REFRESH. Registration happens BEFORE the pass spawns and the pass spawns with no `--resume`,
  // so at registration time the newest file is the PREVIOUS pass's. A binding taken only there names
  // last hour's conversation for the whole hour — roborev 55363's bug, one layer up. The mount has
  // to resolve again, and because writer (3) ACCUMULATES, both passes stay readable.
  it("picks up the session the current pass is writing, without losing the previous one", async () => {
    const dir = fakeProjectDir({
      newest: LAST_PASS,
      turns: {
        "pass-1": [human("older", "last hour: I opened PR #700", "2026-08-12T09:00:00.000Z")],
        "pass-2": [human("newer", "this hour: reading the logs", "2026-08-12T10:00:00.000Z")],
      },
    });

    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    await flush();

    // The pass spawns and Claude begins writing a brand-new session file. NOTHING re-registers.
    dir.newest = THIS_PASS;

    render(<MountedPane agentId={SPARKLE_AGENT_ID} worktree={WORKTREE} />);
    await flush();
    await flush();

    expect(entriesOf(SPARKLE_AGENT_ID)).toEqual(["older", "newer"]);
    const last = invoke.mock.calls.filter(([c]) => c === "agent_transcript_page").pop();
    expect((last![1] as { sessionIds: string[] }).sessionIds).toEqual(["pass-1", "pass-2"]);
  });

  // THE COUNTER-CASE, and it is the reason the binding hook is gated rather than applied to every
  // registered worktree. An ordinary build agent has one too (`projectStore.setAgentWorktree`), and
  // it gets a REAL session-gated binding from its own pane's hook stream. Seeding it from a
  // directory scan instead would render whichever `claude` last wrote there — the original defect.
  it("still reads nothing for an ordinary agent that only has a registered worktree", async () => {
    fakeProjectDir({
      newest: THIS_PASS,
      turns: { "pass-2": [human("stranger", "not this agent's", "2026-08-12T10:00:00.000Z")] },
    });

    noteAgentTranscriptWorktree("build-agent", WORKTREE);
    render(<MountedPane agentId="build-agent" worktree={WORKTREE} />);
    await flush();
    await flush();

    expect(entriesOf("build-agent")).toEqual([]);
    expect(invoke.mock.calls.filter(([c]) => c === "agent_transcript_page")).toEqual([]);
    // Not even the resolve: an unbindable agent costs zero IPC, not one wasted round trip per mount.
    expect(invoke.mock.calls.filter(([c]) => c === "claude_latest_session_path")).toEqual([]);
  });

  // A worktree Claude has never run in — the very first pass. That is the normal state of a fresh
  // install, not a fault, and it must land in the honest empty state rather than binding something.
  it("stays honestly empty when the worktree has no transcript yet", async () => {
    fakeProjectDir({ newest: null, turns: {} });

    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    await flush();
    render(<MountedPane agentId={SPARKLE_AGENT_ID} worktree={WORKTREE} />);
    await flush();

    expect(entriesOf(SPARKLE_AGENT_ID)).toEqual([]);
    expect(invoke.mock.calls.filter(([c]) => c === "agent_transcript_page")).toEqual([]);
    expect(useMountedThreadStore.getState().threads[SPARKLE_AGENT_ID]?.error ?? null).toBe(null);
  });

  // A failed resolve must not fail the mount. The binding is fire-and-forget by contract — both
  // callers sit on a spawn path that cannot be delayed or failed for a read convenience.
  it("survives a resolve that rejects, leaving the pane in its fail-closed state", async () => {
    invoke.mockRejectedValue(new Error("no such command"));

    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    await flush();
    render(<MountedPane agentId={SPARKLE_AGENT_ID} worktree={WORKTREE} />);
    await flush();

    expect(entriesOf(SPARKLE_AGENT_ID)).toEqual([]);
    expect(useMountedThreadStore.getState().threads[SPARKLE_AGENT_ID]?.error ?? null).toBe(null);
  });
});
