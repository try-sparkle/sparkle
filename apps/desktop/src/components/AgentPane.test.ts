// apps/desktop/src/components/AgentPane.test.ts
// Unit tests for pure helpers extracted from AgentPane — kept thin and dependency-free
// so they can run in the node env without mocking any Tauri/React machinery.
import { describe, it, expect, vi, beforeEach } from "vitest";

// `noteTranscriptFromStop` writes into the concierge terminal module's registry. Mocked so the
// write is directly observable — the property under test is that the path is HANDED OVER, which is
// the wiring that was missing, not what the registry then does with it.
vi.mock("../services/conciergeTools/terminal", () => ({
  noteAgentTranscriptPath: vi.fn(),
}));

import { buildShellSpawnArgs, noteTranscriptFromStop } from "./AgentPane";
import { noteAgentTranscriptPath } from "../services/conciergeTools/terminal";
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
describe("noteTranscriptFromStop — the one writer of the transcript registry", () => {
  const noted = vi.mocked(noteAgentTranscriptPath);
  beforeEach(() => vi.clearAllMocks());

  it("registers a Stop event's transcript path against the agent", () => {
    noteTranscriptFromStop("ag-1", {
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
    for (const ev of ignored) noteTranscriptFromStop("ag-1", ev);
    expect(noted).not.toHaveBeenCalled();
  });

  it("trims the path it registers", () => {
    noteTranscriptFromStop("ag-2", {
      event: "Stop",
      transcriptPath: "  /tmp/padded.jsonl  ",
    } as HookEvent);
    expect(noted).toHaveBeenCalledWith("ag-2", "/tmp/padded.jsonl");
  });
});
