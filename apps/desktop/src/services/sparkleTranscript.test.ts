// Making the Improve Sparkle agent READABLE with no pane mounted.
//
// The assertion that matters is not "the helper stored something" — it is that a subsequent
// `readAgentTerminal` for that agent comes back with the CURRENT session's content instead of
// `source: "none"` or, worse, the previous session's. That end-to-end shape is the whole point: the
// user was hand-relaying this agent's analysis because every tier of the read chain was empty for it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [string, unknown])) }));
// The read chain's live tiers must be genuinely EMPTY here — that is the situation being fixed
// (no mounted pane, nothing captured), so tier (d) is the only one that can answer.
vi.mock("./terminalScrollback", async (orig) => ({
  ...(await orig<typeof import("./terminalScrollback")>()),
  getAgentScrollback: vi.fn(() => null),
}));
vi.mock("./history", () => ({ searchHistory: vi.fn(async () => []) }));
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: vi.fn(() => ({ attentionScreen: {}, status: {} })) },
  mergeOpenAgentIds: (a: string[], b: string[]) => [...new Set([...a, ...b])],
  readPersistedOpenAgentIds: vi.fn((): string[] => []),
}));

import { registerSparkleTranscript } from "./sparkleTranscript";
import {
  forgetAgentTranscriptPath,
  noteAgentTranscriptPath,
  readAgentTerminal,
} from "./conciergeTools/terminal";
import { SPARKLE_AGENT_ID } from "./sparkleAgent";

const WORKTREE = "/app-data/sparkle-self/worktrees/__sparkle_self__";
const LAST_HOUR = "/home/u/.claude/projects/-app-data-sparkle-self/pass-1.jsonl";
const THIS_HOUR = "/home/u/.claude/projects/-app-data-sparkle-self/pass-2.jsonl";

/**
 * Stand in for the worktree's project directory. `newest` is what `claude_latest_session_path`
 * resolves right now — the thing that CHANGES as a new pass starts writing — and `contents` maps each
 * file to its last assistant turn.
 */
function fakeProjectDir(dir: { newest: string | null; contents: Record<string, string> }) {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "claude_latest_session_path") return dir.newest;
    if (cmd === "read_transcript_last_assistant") {
      return dir.contents[(args as { path: string }).path] ?? "";
    }
    return undefined;
  });
  return dir;
}

beforeEach(() => {
  invokeMock.mockReset();
  forgetAgentTranscriptPath(SPARKLE_AGENT_ID);
});

describe("registerSparkleTranscript", () => {
  it("makes an unmounted Improve Sparkle agent readable, with the transcript's content", async () => {
    fakeProjectDir({ newest: THIS_HOUR, contents: { [THIS_HOUR]: "Here are the three proposals…" } });

    // BEFORE: every tier is empty, which is exactly the reported bug.
    expect((await readAgentTerminal(SPARKLE_AGENT_ID)).source).toBe("none");

    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);

    // AFTER: the read answers, from the transcript, and SAYS that is where it came from — the
    // freshness label is load-bearing, since this is what the agent last SAID, not its live screen.
    const after = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(after.source).toBe("transcript");
    expect(after.freshness).toBe("historical");
    expect(after.text).toContain("three proposals");
  });

  // THE REGRESSION THAT ROBOREV 55363 CAUGHT. Registration happens BEFORE the pass spawns, and the
  // pass spawns with no `--resume` — so at registration time the newest file is LAST hour's. If the
  // file is chosen then, every mid-pass read returns the previous pass's closing message for the whole
  // hour: the wrong conversation, labelled as this agent's. One registration, two reads, and the
  // second must follow the directory.
  it("reads the session being written NOW, not the one that was newest at registration", async () => {
    const dir = fakeProjectDir({
      newest: LAST_HOUR,
      contents: { [LAST_HOUR]: "last hour: I opened PR #700", [THIS_HOUR]: "this hour: reading the logs" },
    });

    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    expect((await readAgentTerminal(SPARKLE_AGENT_ID)).text).toContain("last hour");

    // The pass spawns and Claude starts writing a brand-new session file. Nothing re-registers.
    dir.newest = THIS_HOUR;

    const during = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(during.text).toContain("this hour");
    expect(during.text).not.toContain("last hour");
  });

  it("resolves the path from the WORKTREE, never from the agent id", async () => {
    fakeProjectDir({ newest: THIS_HOUR, contents: { [THIS_HOUR]: "x" } });
    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    await readAgentTerminal(SPARKLE_AGENT_ID);
    const call = invokeMock.mock.calls.find(([c]) => c === "claude_latest_session_path");
    expect(call?.[1]).toMatchObject({ worktreePath: WORKTREE });
  });

  // The first-ever run: Claude has not written a transcript in this worktree yet. That is the normal
  // state, not an error, and the read must keep reporting honestly.
  it("reports nothing when the worktree has no transcript yet", async () => {
    fakeProjectDir({ newest: null, contents: {} });
    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    const read = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(read.source).toBe("none");
    expect(read.attempts.find((a) => a.source === "transcript")?.ok).toBe(false);
  });

  // A tier is best-effort; one failing IPC must not fail the read (that would blind the concierge).
  it("survives a failed resolve without throwing", async () => {
    invokeMock.mockRejectedValue(new Error("no such command"));
    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    const read = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(read.source).toBe("none");
    expect(read.attempts.find((a) => a.source === "transcript")?.why).toContain("no such command");
  });

  // Writer (1) is a Stop event behind a session gate; writer (2) is an mtime scan with no gate. When
  // an agent somehow has both, the better evidence has to win.
  it("lets an exact Stop-event path outrank the worktree scan", async () => {
    fakeProjectDir({
      newest: THIS_HOUR,
      contents: { [THIS_HOUR]: "from the scan", [LAST_HOUR]: "from the Stop event" },
    });
    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    noteAgentTranscriptPath(SPARKLE_AGENT_ID, LAST_HOUR);

    expect((await readAgentTerminal(SPARKLE_AGENT_ID)).text).toContain("from the Stop event");
  });
});
