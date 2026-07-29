// Making the Improve Sparkle agent READABLE with no pane mounted.
//
// The assertion that matters is not "the helper called the invoke" — it is that a subsequent
// `readAgentTerminal` for that agent comes back with the transcript's CONTENT instead of
// `source: "none"`. That end-to-end shape is the whole point: the user was hand-relaying this
// agent's analysis because every tier of the read chain was empty for it.
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
import { forgetAgentTranscriptPath, readAgentTerminal } from "./conciergeTools/terminal";
import { SPARKLE_AGENT_ID } from "./sparkleAgent";

const WORKTREE = "/app-data/sparkle-self/worktrees/__sparkle_self__";
const TRANSCRIPT = "/home/u/.claude/projects/-app-data-sparkle-self/abc.jsonl";

/** Route the two commands this path uses; anything else resolves undefined. */
function routeInvokes(opts: { path?: string | null; lastAssistant?: string } = {}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "claude_latest_session_path") return opts.path === undefined ? TRANSCRIPT : opts.path;
    if (cmd === "read_transcript_last_assistant") return opts.lastAssistant ?? "";
    return undefined;
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  forgetAgentTranscriptPath(SPARKLE_AGENT_ID);
});

describe("registerSparkleTranscript", () => {
  it("makes an unmounted Improve Sparkle agent readable, with the transcript's content", async () => {
    routeInvokes({ lastAssistant: "Here are the three proposals I'd prioritise…" });

    // BEFORE: every tier is empty, which is exactly the reported bug.
    const before = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(before.source).toBe("none");

    await registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);

    // AFTER: the read answers, from the transcript, and SAYS that is where it came from — the
    // freshness label is load-bearing, since this is what the agent last SAID, not its live screen.
    const after = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(after.source).toBe("transcript");
    expect(after.freshness).toBe("historical");
    expect(after.text).toContain("three proposals");
  });

  it("resolves the path from the WORKTREE, never from the agent id", async () => {
    routeInvokes({ lastAssistant: "x" });
    await registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);
    const call = invokeMock.mock.calls.find(([c]) => c === "claude_latest_session_path");
    expect(call?.[1]).toMatchObject({ worktreePath: WORKTREE });
  });

  // The first-ever run: Claude has not written a transcript yet. That is the normal state, not an
  // error, and it must leave the read reporting honestly rather than registering a bogus path.
  it("registers nothing when there is no transcript yet", async () => {
    routeInvokes({ path: null });
    await expect(registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE)).resolves.toBeNull();
    expect((await readAgentTerminal(SPARKLE_AGENT_ID)).source).toBe("none");
  });

  // Every caller is on a spawn path that must not fail for a read convenience.
  it("never throws when the resolve fails", async () => {
    invokeMock.mockRejectedValue(new Error("no such command"));
    await expect(registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE)).resolves.toBeNull();
  });

  // A worktree accrues one transcript per session, so the newest file changes over the agent's
  // life; a path pinned at first launch would serve a stale conversation forever.
  it("re-registers the newest transcript rather than pinning the first", async () => {
    routeInvokes({ lastAssistant: "older" });
    await registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);

    const NEWER = "/home/u/.claude/projects/-app-data-sparkle-self/def.jsonl";
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "claude_latest_session_path") return NEWER;
      if (cmd === "read_transcript_last_assistant")
        return (args as { path: string }).path === NEWER ? "newer" : "older";
      return undefined;
    });
    await registerSparkleTranscript(SPARKLE_AGENT_ID, WORKTREE);

    expect((await readAgentTerminal(SPARKLE_AGENT_ID)).text).toContain("newer");
  });
});
