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
  noteAgentSessionId,
  noteAgentTranscriptPath,
  noteAgentTranscriptWorktree,
  readAgentTerminal,
} from "./conciergeTools/terminal";
import { SPARKLE_AGENT_ID } from "./sparkleAgent";

const WORKTREE = "/app-data/sparkle-self/worktrees/__sparkle_self__";
const LAST_HOUR = "/home/u/.claude/projects/-app-data-sparkle-self/pass-1.jsonl";
const THIS_HOUR = "/home/u/.claude/projects/-app-data-sparkle-self/pass-2.jsonl";
/** Another `claude` run in the SAME worktree — the file that must never be read as this agent's.
 *  A session directory belongs to a worktree, never to an agent, so this is the common case. */
const STRANGER = "/home/u/.claude/projects/-app-data-sparkle-self/someone-else.jsonl";

/** A transcript file's STEM is its session id — the convention `transcript.rs`'s `session_id_of`
 *  encodes, and the one `bindWorktreeSession` relies on to turn a resolved path into a binding. */
const stemOf = (path: string) => path.split("/").pop()!.replace(/\.jsonl$/, "");

/**
 * Stand in for the worktree's project directory. `files` is every session log in it, NEWEST FIRST —
 * mutate it to model a new pass starting to write — and `contents` maps each file to its last
 * assistant turn.
 *
 * IT SERVES THE TWO RESOLVE COMMANDS DIFFERENTLY, which is the whole reason this is a directory
 * model rather than a single canned answer (roborev 63135):
 *
 *   * `claude_latest_session_path` — the unfiltered LEARN seam. Answers the newest file, full stop.
 *     Its caller is trying to DISCOVER an id it does not have yet, so a filter there is incoherent.
 *   * `agent_own_session_path` — the READ seam. Answers the newest file whose stem the caller has
 *     already established is this agent's, and NOTHING when the caller sends no binding.
 *
 * The filter is honoured rather than ignored on purpose: a stub that returned the newest file
 * whatever `sessionIds` said would pass identically against a reader that never sent them, which is
 * the defect this models.
 */
function fakeProjectDir(dir: { files: string[]; contents: Record<string, string> }) {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "claude_latest_session_path") return dir.files[0] ?? null;
    if (cmd === "agent_own_session_path") {
      const ids = (args as { sessionIds?: string[] } | undefined)?.sessionIds;
      if (!ids) return null; // fail closed, exactly as the Rust command does
      return dir.files.find((p) => ids.includes(stemOf(p))) ?? null;
    }
    if (cmd === "read_transcript_last_assistant") {
      return dir.contents[(args as { path: string }).path] ?? "";
    }
    return undefined;
  });
  return dir;
}

/** `registerSparkleTranscript` is deliberately synchronous and infallible, so it fires the session
 *  bind fire-and-forget. Let that microtask land before asserting, rather than relying on the read
 *  chain happening to contain enough awaits. */
const flushBinding = () => Promise.resolve().then(() => undefined);

beforeEach(() => {
  invokeMock.mockReset();
  forgetAgentTranscriptPath(SPARKLE_AGENT_ID);
});

describe("registerSparkleTranscript", () => {
  it("makes an unmounted Improve Sparkle agent readable, with the transcript's content", async () => {
    fakeProjectDir({ files: [THIS_HOUR], contents: { [THIS_HOUR]: "Here are the three proposals…" } });

    // BEFORE: every tier is empty, which is exactly the reported bug.
    expect((await readAgentTerminal(SPARKLE_AGENT_ID)).source).toBe("none");

    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    await flushBinding();

    // AFTER: the read answers, from the transcript, and SAYS that is where it came from — the
    // freshness label is load-bearing, since this is what the agent last SAID, not its live screen.
    const after = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(after.source).toBe("transcript");
    expect(after.freshness).toBe("historical");
    expect(after.text).toContain("three proposals");
  });

  // THE REGRESSION THAT ROBOREV 55363 CAUGHT, restated for the session-keyed reader. Registration
  // happens BEFORE the pass spawns, and the pass spawns with no `--resume` — so at registration time
  // the newest file is LAST hour's. If the FILE were chosen then, every mid-pass read would return
  // the previous pass's closing message for the whole hour.
  //
  // The resolve is still late; what constrains it now is the session SET, which is why this still
  // works: `noteAgentSessionId` accumulates, so the live session announced by the running pass
  // (`sparkle_improve:session`) joins the registration-time one and the resolve takes the newest of
  // the two. A binding that REPLACED, or a resolve pinned at registration, would both fail here.
  it("follows the session being written NOW once the pass announces it", async () => {
    const dir = fakeProjectDir({
      files: [LAST_HOUR],
      contents: { [LAST_HOUR]: "last hour: I opened PR #700", [THIS_HOUR]: "this hour: reading the logs" },
    });

    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    await flushBinding();
    expect((await readAgentTerminal(SPARKLE_AGENT_ID)).text).toContain("last hour");

    // The pass spawns, Claude starts a brand-new session file, and the pass announces which one it
    // is. Nothing re-registers the worktree.
    dir.files.unshift(THIS_HOUR);
    noteAgentSessionId(SPARKLE_AGENT_ID, stemOf(THIS_HOUR));

    const during = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(during.text).toContain("this hour");
    expect(during.text).not.toContain("last hour");
  });

  // THE OTHER HALF OF THE RULE, and the one the old unfiltered resolve got wrong. A file appearing in
  // the directory is not evidence that it is THIS agent's — every `claude` ever run in that worktree
  // writes there. So a newest file nobody has attributed must NOT be picked up; the read stays on the
  // agent's own known session and the pane keeps saying something true.
  //
  // Paired with the case above, which differs by exactly one line — the announcement — so "it did not
  // follow" is pinned to the binding rather than to a resolve that never re-runs.
  it("does not follow an unannounced newest file, which may be another claude's", async () => {
    const dir = fakeProjectDir({
      files: [LAST_HOUR],
      contents: { [LAST_HOUR]: "last hour: I opened PR #700", [STRANGER]: "a stranger's roborev review" },
    });

    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    await flushBinding();

    // Some other `claude` runs in the same worktree and takes the newest mtime.
    dir.files.unshift(STRANGER);

    const read = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(read.text).not.toContain("stranger");
    expect(read.text).toContain("last hour");
  });

  it("resolves the path from the WORKTREE, never from the agent id", async () => {
    fakeProjectDir({ files: [THIS_HOUR], contents: { [THIS_HOUR]: "x" } });
    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    await flushBinding();
    await readAgentTerminal(SPARKLE_AGENT_ID);
    const call = invokeMock.mock.calls.find(([c]) => c === "agent_own_session_path");
    expect(call?.[1]).toMatchObject({ worktreePath: WORKTREE });
  });

  // The first-ever run: Claude has not written a transcript in this worktree yet. That is the normal
  // state, not an error, and the read must keep reporting honestly.
  it("reports nothing when the worktree has no transcript yet", async () => {
    fakeProjectDir({ files: [], contents: {} });
    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    await flushBinding();
    const read = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(read.source).toBe("none");
    expect(read.attempts.find((a) => a.source === "transcript")?.ok).toBe(false);
  });

  // A tier is best-effort; one failing IPC must not fail the read (that would blind the concierge).
  // The binding is seeded directly here so the read gets PAST the fail-closed check and actually
  // reaches the rejecting command — otherwise this would assert the refusal, not the rescue.
  it("survives a failed resolve without throwing", async () => {
    noteAgentTranscriptWorktree(SPARKLE_AGENT_ID, WORKTREE);
    noteAgentSessionId(SPARKLE_AGENT_ID, stemOf(THIS_HOUR));
    invokeMock.mockRejectedValue(new Error("no such command"));

    const read = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(read.source).toBe("none");
    expect(read.attempts.find((a) => a.source === "transcript")?.why).toContain("no such command");
  });

  // Writer (1) is a Stop event behind a session gate; writer (2) is an mtime scan constrained by the
  // binding. When an agent somehow has both, the better evidence has to win.
  it("lets an exact Stop-event path outrank the worktree scan", async () => {
    fakeProjectDir({
      files: [THIS_HOUR, LAST_HOUR],
      contents: { [THIS_HOUR]: "from the scan", [LAST_HOUR]: "from the Stop event" },
    });
    registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    await flushBinding();
    noteAgentTranscriptPath(SPARKLE_AGENT_ID, LAST_HOUR);

    expect((await readAgentTerminal(SPARKLE_AGENT_ID)).text).toContain("from the Stop event");
  });
});
