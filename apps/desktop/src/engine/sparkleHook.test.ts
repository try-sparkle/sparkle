import { describe, it, expect } from "vitest";
// Import the pure normalizer straight from the shipped emitter script, and round-trip it
// through parseHookLine so the emitter and the reader are proven to agree on the wire shape.
import { normalize } from "../../src-tauri/resources/sparkle-hook.mjs";
import { hookEventToStatus, parseHookLine } from "./hookEvents";

describe("sparkle-hook normalize", () => {
  it("projects a PreToolUse payload to the compact event shape", () => {
    const out = normalize(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "s1",
        cwd: "/wt",
      },
      1000,
    );
    expect(out).toEqual({ ts: 1000, event: "PreToolUse", tool: "Bash", session_id: "s1" });
  });

  it("keeps the Notification message so permission vs idle can be told apart", () => {
    const out = normalize(
      { hook_event_name: "Notification", message: "Claude needs your permission to use Bash" },
      2000,
    );
    expect(out.event).toBe("Notification");
    expect(out.message).toBe("Claude needs your permission to use Bash");
  });

  it("tolerates a missing/!object payload without throwing", () => {
    expect(normalize(undefined, 1).event).toBe("");
    expect(normalize(null, 1).event).toBe("");
    expect(normalize(42, 1).event).toBe("");
  });

  it("round-trips through parseHookLine -> hookEventToStatus", () => {
    const wire = `${JSON.stringify(normalize({ hook_event_name: "Stop" }, 3000))}\n`;
    const parsed = parseHookLine(wire);
    expect(parsed).not.toBeNull();
    expect(hookEventToStatus(parsed!)).toBe("idle");
  });
});
