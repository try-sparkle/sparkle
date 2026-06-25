import { describe, expect, it, vi } from "vitest";
import { HookStatusEngine, hookEventToStatus, parseHookLine } from "./hookEvents";

describe("hookEventToStatus", () => {
  it("maps in-turn lifecycle events to working (green)", () => {
    for (const event of [
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "SubagentStop",
    ]) {
      expect(hookEventToStatus({ event })).toBe("working");
    }
  });

  it("maps SessionStart (spawn/resume, no turn yet) to idle (gray, NOT green)", () => {
    // Regression: a resumed session on app launch fires SessionStart with no Stop after it, so
    // mapping it to "working" left every agent stuck green. A starting session is idle until the
    // first UserPromptSubmit.
    expect(hookEventToStatus({ event: "SessionStart" })).toBe("idle");
  });

  it("maps a permission Notification to approval (red)", () => {
    expect(
      hookEventToStatus({
        event: "Notification",
        message: "Claude needs your permission to use Bash",
      }),
    ).toBe("approval");
  });

  it("maps a non-permission idle Notification to idle (gray, NOT red)", () => {
    // Regression: Claude's idle-60s ping fires after a turn ends (often while a background shell
    // keeps running). It is NOT the agent asking you anything, so it must stay gray — red is
    // reserved for genuine approval prompts.
    expect(
      hookEventToStatus({
        event: "Notification",
        message: "Claude is waiting for your input",
      }),
    ).toBe("idle");
    // A bare Notification with no message is a non-permission idle ping → idle (gray), not red.
    expect(hookEventToStatus({ event: "Notification" })).toBe("idle");
  });

  it("maps Stop (turn finished) to idle (gray — your turn)", () => {
    expect(hookEventToStatus({ event: "Stop" })).toBe("idle");
  });

  it("maps SessionEnd to done (gray)", () => {
    expect(hookEventToStatus({ event: "SessionEnd" })).toBe("done");
  });

  it("returns null for unknown events (no status change)", () => {
    expect(hookEventToStatus({ event: "PreCompact" })).toBeNull();
    expect(hookEventToStatus({ event: "Banana" })).toBeNull();
  });
});

describe("parseHookLine", () => {
  it("parses a well-formed JSONL event line", () => {
    const line = JSON.stringify({
      ts: 123,
      event: "PreToolUse",
      tool: "Bash",
      session_id: "abc",
    });
    expect(parseHookLine(line)).toEqual({
      ts: 123,
      event: "PreToolUse",
      tool: "Bash",
      session_id: "abc",
    });
  });

  it("returns null for blank or malformed lines (never throws)", () => {
    expect(parseHookLine("")).toBeNull();
    expect(parseHookLine("   ")).toBeNull();
    expect(parseHookLine("{not json")).toBeNull();
    // Valid JSON but not an event object (no `event` string) → null.
    expect(parseHookLine("42")).toBeNull();
    expect(parseHookLine(JSON.stringify({ tool: "Bash" }))).toBeNull();
  });
});

describe("HookStatusEngine", () => {
  it("does not emit on construction; the first real event drives", () => {
    const onStatus = vi.fn();
    const engine = new HookStatusEngine({ agentId: "a1", onStatus });
    // No constructor emit — otherwise a seeded "working" baseline would let dedup swallow the
    // first real working event (UserPromptSubmit/PreToolUse) when hooks take over.
    expect(onStatus).not.toHaveBeenCalled();
    engine.ingest({ event: "UserPromptSubmit" });
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith("working");
  });

  it("drives a full turn: prompt → tool → stop → idle", () => {
    const onStatus = vi.fn();
    const engine = new HookStatusEngine({ agentId: "a1", onStatus });
    engine.ingest({ event: "UserPromptSubmit" });
    engine.ingest({ event: "PreToolUse", tool: "Bash" });
    engine.ingest({ event: "PostToolUse", tool: "Bash" });
    engine.ingest({ event: "Stop" });
    expect(onStatus).toHaveBeenLastCalledWith("idle");
  });

  it("a resumed session with no new turn settles idle (gray), not working (green)", () => {
    // The reported bug: launch the app, every agent resumes (SessionStart) and glows green
    // forever because no Stop follows. SessionStart must land on idle so the dot is gray until
    // the user actually sends a prompt.
    const onStatus = vi.fn();
    const engine = new HookStatusEngine({ agentId: "a1", onStatus });
    engine.ingest({ event: "SessionStart" });
    expect(onStatus).toHaveBeenLastCalledWith("idle");
  });

  it("a finished turn that idle-pings stays gray, never flips to red", () => {
    // The inverse bug: an agent finishes (Stop → idle) with a background shell still running, then
    // Claude's idle-60s Notification fires. That ping must NOT turn the dot red — it's not asking
    // anything. Status stays idle (gray).
    const onStatus = vi.fn();
    const engine = new HookStatusEngine({ agentId: "a1", onStatus });
    engine.ingest({ event: "UserPromptSubmit" });
    engine.ingest({ event: "Stop" });
    engine.ingest({ event: "Notification", message: "Claude is waiting for your input" });
    expect(onStatus).toHaveBeenLastCalledWith("idle");
    expect(onStatus).not.toHaveBeenCalledWith("waiting");
  });

  it("surfaces a permission request as approval, then back to working once granted", () => {
    const onStatus = vi.fn();
    const engine = new HookStatusEngine({ agentId: "a1", onStatus });
    engine.ingest({ event: "Notification", message: "needs your permission to use Bash" });
    expect(onStatus).toHaveBeenLastCalledWith("approval");
    engine.ingest({ event: "PreToolUse", tool: "Bash" });
    expect(onStatus).toHaveBeenLastCalledWith("working");
  });

  it("dedupes repeated same-status events after the first", () => {
    const onStatus = vi.fn();
    const engine = new HookStatusEngine({ agentId: "a1", onStatus });
    engine.ingest({ event: "PreToolUse" }); // null → working: emits
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith("working");
    engine.ingest({ event: "PostToolUse" }); // still working: deduped
    expect(onStatus).toHaveBeenCalledTimes(1);
    engine.ingest({ event: "Stop" }); // working → idle: emits
    expect(onStatus).toHaveBeenCalledTimes(2);
  });

  it("ignores unknown events without changing status", () => {
    const onStatus = vi.fn();
    const engine = new HookStatusEngine({ agentId: "a1", onStatus });
    engine.ingest({ event: "Stop" }); // → idle
    onStatus.mockClear();
    engine.ingest({ event: "PreCompact" }); // unknown → no change
    expect(onStatus).not.toHaveBeenCalled();
  });
});
