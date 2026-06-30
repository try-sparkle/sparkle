import { describe, expect, it } from "vitest";
import {
  getAgentScrollback,
  registerScrollback,
  serializeScrollback,
  SNAPSHOT_MAX_LINES,
  type ScrollbackBuffer,
} from "./terminalScrollback";

// A fake xterm buffer over an array of line strings.
function fakeBuffer(lines: string[]): ScrollbackBuffer {
  return {
    get length() {
      return lines.length;
    },
    getLine: (i) => (i < lines.length ? { translateToString: () => lines[i] ?? "" } : undefined),
  };
}

describe("serializeScrollback", () => {
  it("joins lines with CRLF so the phone emulator resets the column each line (no staircase)", () => {
    const out = serializeScrollback(fakeBuffer(["hello", "world"]));
    expect(out).toBe("hello\r\nworld");
    expect(out).not.toContain("hello\nworld"); // a bare \n would staircase
  });

  it("trims trailing blank lines", () => {
    expect(serializeScrollback(fakeBuffer(["a", "", "b", "", ""]))).toBe("a\r\n\r\nb");
  });

  it("caps to the last SNAPSHOT_MAX_LINES", () => {
    const many = Array.from({ length: SNAPSHOT_MAX_LINES + 50 }, (_, i) => `line${i}`);
    const out = serializeScrollback(fakeBuffer(many));
    const rendered = out.split("\r\n");
    expect(rendered.length).toBe(SNAPSHOT_MAX_LINES);
    expect(rendered[rendered.length - 1]).toBe(`line${many.length - 1}`); // newest kept
    expect(out).not.toContain("line0\r\n"); // oldest dropped
  });
});

describe("registerScrollback", () => {
  it("exposes a provider by agent id and unregisters cleanly", () => {
    const off = registerScrollback("a1", () => "history");
    expect(getAgentScrollback("a1")).toBe("history");
    off();
    expect(getAgentScrollback("a1")).toBeNull();
  });

  it("a stale unregister can't delete a newer provider for the same agent (double-mount)", () => {
    const off1 = registerScrollback("a2", () => "first");
    registerScrollback("a2", () => "second"); // a remount replaced the provider
    off1(); // the OLD mount's cleanup must NOT remove the live one
    expect(getAgentScrollback("a2")).toBe("second");
  });

  it("returns null for an unknown agent", () => {
    expect(getAgentScrollback("nope")).toBeNull();
  });
});
