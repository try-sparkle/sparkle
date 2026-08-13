// apps/desktop/src/components/AgentPane.test.ts
// Unit tests for pure helpers extracted from AgentPane — kept thin and dependency-free
// so they can run in the node env without mocking any Tauri/React machinery.
import { describe, it, expect, vi, beforeEach } from "vitest";

// `noteTranscriptFromHook` writes into the concierge terminal module's registry. Mocked so the
// write is directly observable — the property under test is that the path is HANDED OVER, which is
// the wiring that was missing, not what the registry then does with it.
vi.mock("../services/conciergeTools/terminal", () => ({
  noteAgentTranscriptPath: vi.fn(),
  noteAgentSessionId: vi.fn(),
}));

import { buildShellSpawnArgs, noteTranscriptFromHook } from "./AgentPane";
import {
  noteAgentSessionId,
  noteAgentTranscriptPath,
} from "../services/conciergeTools/terminal";
import type { HookEvent } from "../engine/hookEvents";

describe("buildShellSpawnArgs — injection-safety invariant", () => {
  it("the command is passed strictly as a positional arg (args[4]), never interpolated into the script string (args[2])", () => {
    const cmd = 'npm run build && echo "done"';
    const args = buildShellSpawnArgs("/bin/zsh", cmd);
    // The command must be the last (positional) element, verbatim.
    expect(args[4]).toBe(cmd);
    // The script string must contain the $1 placeholder, NOT the literal command.
    expect(args[2]).toContain("$1");
    expect(args[2]).not.toContain(cmd);
  });

  it("a command with shell-injection characters stays in the positional slot without escaping", () => {
    // A selection ending in a backslash or containing quotes must not break the script string.
    const cmd = '"; rm -rf / #';
    const args = buildShellSpawnArgs("/bin/zsh", cmd);
    expect(args[4]).toBe(cmd);
    expect(args[2]).not.toContain(cmd);
  });

  it("the shell path is passed as $0 (args[3]), not concatenated into the script", () => {
    const shell = "/bin/zsh";
    const args = buildShellSpawnArgs(shell, "ls");
    expect(args[3]).toBe(shell);
    // args[2] is the script; the shell path must not be interpolated there.
    expect(args[2]).not.toContain(shell);
  });
});

// THE WIRING FOR TIER (d) OF THE CONCIERGE READ CHAIN. A Stop event is the only place a session
// transcript path is ever known, and this component the only thing that sees one. Without this
// hand-off `readAgentTerminal`'s transcript tier has no path for ANY agent — it doesn't fail, it
// silently reports "no transcript path is known" forever and the four-tier chain becomes three.
describe("noteTranscriptFromHook — the one writer of the transcript registry", () => {
  const noted = vi.mocked(noteAgentTranscriptPath);
  beforeEach(() => vi.clearAllMocks());

  it("registers a Stop event's transcript path against the agent", () => {
    noteTranscriptFromHook("ag-1", {
      event: "Stop",
      transcriptPath: "/tmp/session.jsonl",
    } as HookEvent);
    expect(noted).toHaveBeenCalledWith("ag-1", "/tmp/session.jsonl");
  });

  // It is offered EVERY hook event on purpose, so the if-chain in the capture handler can't drift
  // away from feeding it. That only works if the helper itself ignores everything else.
  it("ignores every event that is not a Stop carrying a path", () => {
    const ignored: HookEvent[] = [
      { event: "UserPromptSubmit", prompt: "hi" } as HookEvent,
      { event: "Stop" } as HookEvent,
      { event: "Stop", transcriptPath: "" } as HookEvent,
      { event: "Stop", transcriptPath: "   " } as HookEvent,
      { event: "Notification" } as HookEvent,
    ];
    for (const ev of ignored) noteTranscriptFromHook("ag-1", ev);
    expect(noted).not.toHaveBeenCalled();
  });

  it("trims the path it registers", () => {
    noteTranscriptFromHook("ag-2", {
      event: "Stop",
      transcriptPath: "  /tmp/padded.jsonl  ",
    } as HookEvent);
    expect(noted).toHaveBeenCalledWith("ag-2", "/tmp/padded.jsonl");
  });
});

// THE OTHER HALF OF THE SAME HAND-OFF: WHOSE conversation this agent's is.
//
// A worktree's session directory holds a `<session-id>.jsonl` for every `claude` that ever ran there,
// so the mounted concierge pane read the newest by mtime and rendered a DIFFERENT agent's turns under
// this agent's name. `session_id` is on every hook payload; this is where it gets bound to the agent.
describe("noteTranscriptFromHook — binding the agent to its Claude sessions", () => {
  const bound = vi.mocked(noteAgentSessionId);
  beforeEach(() => vi.clearAllMocks());

  // EVERY EVENT, not just Stop. Stop fires only when a turn ENDS, so an agent mounted mid-turn would
  // render empty for minutes with its session sitting right there in the log.
  it("binds the session id from any event that carries one", () => {
    for (const ev of [
      { event: "SessionStart", session_id: "sess-start" },
      { event: "UserPromptSubmit", session_id: "sess-start", prompt: "hi" },
      { event: "PreToolUse", session_id: "sess-start", tool: "Bash" },
      { event: "Notification", session_id: "sess-start" },
    ] as HookEvent[]) {
      noteTranscriptFromHook("ag-1", ev);
    }
    expect(bound.mock.calls).toEqual([
      ["ag-1", "sess-start"],
      ["ag-1", "sess-start"],
      ["ag-1", "sess-start"],
      ["ag-1", "sess-start"],
    ]);
  });

  it("binds nothing when the event carries no session id", () => {
    noteTranscriptFromHook("ag-1", { event: "SessionStart" } as HookEvent);
    noteTranscriptFromHook("ag-1", { event: "Stop" } as HookEvent);
    expect(bound).not.toHaveBeenCalled();
  });

  // A Stop's transcript path is `<projects>/<slug>/<session-id>.jsonl`, so its STEM is a session id.
  // Taken as a second source for an older emitter that passes `transcript_path` but no `session_id`
  // — which `parseHookLine` still tolerates, and which would otherwise leave the pane empty all run.
  it("also binds the session id carried in a Stop's transcript filename", () => {
    noteTranscriptFromHook("ag-1", {
      event: "Stop",
      transcriptPath: "/Users/x/.claude/projects/slug/abc-123.jsonl",
    } as HookEvent);
    expect(bound).toHaveBeenCalledWith("ag-1", "abc-123");
  });

  it("binds both the event's id and the filename's when a Stop carries both", () => {
    noteTranscriptFromHook("ag-1", {
      event: "Stop",
      session_id: "abc-123",
      transcriptPath: "/Users/x/.claude/projects/slug/abc-123.jsonl",
    } as HookEvent);
    // Same id twice is harmless — `noteAgentSessionId` is a set-add and no-ops on a known id.
    expect(bound.mock.calls).toEqual([
      ["ag-1", "abc-123"],
      ["ag-1", "abc-123"],
    ]);
  });
});
