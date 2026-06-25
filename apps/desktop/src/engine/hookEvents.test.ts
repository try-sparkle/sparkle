import { describe, expect, it, vi } from "vitest";
import { HookStatusEngine, hookEventToStatus, parseHookLine } from "./hookEvents";

describe("hookEventToStatus", () => {
  it("maps in-turn lifecycle events to working (green)", () => {
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "SubagentStop",
    ]) {
      expect(hookEventToStatus({ event })).toBe("working");
    }
  });

  it("maps a permission Notification to approval (red)", () => {
    expect(
      hookEventToStatus({
        event: "Notification",
        message: "Claude needs your permission to use Bash",
      }),
    ).toBe("approval");
  });

  it("maps an idle/input Notification to waiting (red)", () => {
    expect(
      hookEventToStatus({
        event: "Notification",
        message: "Claude is waiting for your input",
      }),
    ).toBe("waiting");
    // A bare Notification with no message is a non-permission attention ping → waiting.
    expect(hookEventToStatus({ event: "Notification" })).toBe("waiting");
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
