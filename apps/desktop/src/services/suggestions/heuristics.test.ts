import { describe, it, expect } from "vitest";
import { detectTerminalPrompts } from "./heuristics";

describe("detectTerminalPrompts", () => {
  it("detects a y/n confirmation as Approve/Deny", () => {
    const out = detectTerminalPrompts("Do you want to continue? (y/n) ");
    expect(out.map((b) => b.label)).toEqual(["Approve", "Deny"]);
    expect(out.map((b) => b.value)).toEqual(["y\n", "n\n"]);
    expect(out.every((b) => b.kind === "terminal" && b.source === "heuristic")).toBe(true);
  });

  it("detects [Y/n] default-yes prompts", () => {
    const out = detectTerminalPrompts("Overwrite file? [Y/n]");
    expect(out.map((b) => b.label)).toEqual(["Approve", "Deny"]);
  });

  it("detects a numbered menu and emits one button per option (max 3)", () => {
    const menu = [
      "Select an option:",
      "  1) Keep current",
      "  2) Use incoming",
      "  3) Merge both",
      "Enter your choice: ",
    ].join("\n");
    const out = detectTerminalPrompts(menu);
    expect(out.map((b) => b.label)).toEqual(["1", "2", "3"]);
    expect(out.map((b) => b.value)).toEqual(["1\n", "2\n", "3\n"]);
  });

  it("caps a longer numbered menu at the first 3 options", () => {
    const menu = "1. a\n2. b\n3. c\n4. d\n5. e\n? ";
    expect(detectTerminalPrompts(menu).map((b) => b.label)).toEqual(["1", "2", "3"]);
  });

  it("returns nothing for ordinary output", () => {
    expect(detectTerminalPrompts("Compiling... done in 4.2s\n$ ")).toEqual([]);
  });

  it("only considers the tail, not stale earlier prompts", () => {
    const txt = "Continue? (y/n)\n" + "build log line\n".repeat(80) + "All done.\n$ ";
    expect(detectTerminalPrompts(txt)).toEqual([]);
  });

  it("does NOT treat a numbered changelog ending in a header colon as a menu", () => {
    const log = ["Changes:", "  1. Fixed foo", "  2. Added bar", "Results:"].join("\n");
    expect(detectTerminalPrompts(log)).toEqual([]);
  });

  it("ignores a single numbered option (needs >= 2)", () => {
    expect(detectTerminalPrompts("1) only one\nEnter your choice: ")).toEqual([]);
  });

  it("ignores scattered / non-1-based option numbers", () => {
    const log = ["7) seven", "9) nine", "Pick one: "].join("\n");
    expect(detectTerminalPrompts(log)).toEqual([]);
  });

  it("ignores duplicate option numbers (non-contiguous run)", () => {
    const log = ["1) retry attempt", "1) retry attempt", "? "].join("\n");
    expect(detectTerminalPrompts(log)).toEqual([]);
  });

  it("detects a real menu even if a stray numbered line precedes it in the tail", () => {
    const txt = ["3) old log entry", "Select an option:", "  1) a", "  2) b", "Pick one: "].join("\n");
    expect(detectTerminalPrompts(txt).map((b) => b.label)).toEqual(["1", "2"]);
  });
});
