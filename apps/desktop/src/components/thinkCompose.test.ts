import { describe, it, expect } from "vitest";
import { composeThinkTurn } from "./thinkCompose";

describe("composeThinkTurn", () => {
  it("text only → the trimmed text, no screenshot lines", () => {
    expect(composeThinkTurn("  fix the header  ", [])).toBe("fix the header");
  });

  it("image only → a single Screenshot line (image alone is sendable)", () => {
    expect(composeThinkTurn("", ["/tmp/a.png"])).toBe("[Screenshot: /tmp/a.png]");
  });

  it("text + shots → text, blank line, then one line per shot", () => {
    expect(composeThinkTurn("make it blue", ["/tmp/a.png", "/tmp/b.png"])).toBe(
      "make it blue\n\n[Screenshot: /tmp/a.png]\n[Screenshot: /tmp/b.png]",
    );
  });

  it("neither → empty string (callers guard against dispatching it)", () => {
    expect(composeThinkTurn("   ", [])).toBe("");
  });
});
