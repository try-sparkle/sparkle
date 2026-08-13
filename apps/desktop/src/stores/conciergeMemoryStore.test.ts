// AUTO RE-GROUNDING preamble (PR #1877, bead sparkle-jce9).
//
// The load-bearing assertion is that a RECALLED MEMORY actually reaches the prompt — not merely that
// the store holds a row. That is the whole point of re-grounding: a fact the concierge saved is
// folded into the turn it is dispatching, so it re-orients without being asked. So these tests build
// the preamble from memories and assert the VALUE text is present in the string the turn will carry.
import { describe, expect, it } from "vitest";
import {
  buildMemoryPreamble,
  MAX_MEMORY_VALUE_CHARS,
  MEMORY_PREAMBLE_HEADER,
  withMemoryPreamble,
} from "./conciergeMemoryStore";

describe("buildMemoryPreamble", () => {
  it("puts each recalled memory's key AND value into the section", () => {
    const preamble = buildMemoryPreamble([
      { key: "founder-priority", value: "wall-clock speed over token cost" },
      { key: "account-storytell", value: "Storytell owns PR #1877" },
    ]);
    // THE SIDE EFFECT that matters: the actual remembered content is in the prompt text.
    expect(preamble).toContain("wall-clock speed over token cost");
    expect(preamble).toContain("founder-priority");
    expect(preamble).toContain("Storytell owns PR #1877");
    // It is introduced as the section the persona names, and announces how many facts there are.
    expect(preamble).toContain(MEMORY_PREAMBLE_HEADER);
    expect(preamble).toContain("2 fact(s)");
  });

  it("returns EXACTLY the empty string when there is nothing — no header noise on every prompt", () => {
    expect(buildMemoryPreamble([])).toBe("");
  });

  it("CLIPS a long value so a saturated store cannot dump ~50KB onto every turn", () => {
    const huge = "x".repeat(MAX_MEMORY_VALUE_CHARS * 3);
    const preamble = buildMemoryPreamble([{ key: "big", value: huge }]);
    // The rendered value is bounded (whole block ≈ header + one clipped value, not 3× the cap) and
    // marked as clipped — the full text stays one `recall` away.
    expect(preamble.length).toBeLessThan(MEMORY_PREAMBLE_HEADER.length + MAX_MEMORY_VALUE_CHARS + 100);
    expect(preamble).toContain("…");
    expect(preamble).not.toContain(huge);
  });

  it("DISCLOSES the count gap when the store holds more than is shown — never reads as the whole store", () => {
    const preamble = buildMemoryPreamble(
      [
        { key: "a", value: "alpha" },
        { key: "b", value: "beta" },
      ],
      27,
    );
    expect(preamble).toContain("25 more fact(s) not shown");
    expect(preamble).toContain("recall");
  });

  it("adds NO disclosure note when everything is shown", () => {
    const preamble = buildMemoryPreamble([{ key: "a", value: "alpha" }], 1);
    expect(preamble).not.toContain("more fact(s) not shown");
  });
});

describe("withMemoryPreamble", () => {
  it("prepends the preamble ahead of the prompt", () => {
    const combined = withMemoryPreamble("MEMORY BLOCK", "the founder's message");
    expect(combined).toBe("MEMORY BLOCK\n\nthe founder's message");
  });

  it("is IDENTITY when the preamble is empty — the same prompt, no blank line", () => {
    const prompt = "the founder's message";
    expect(withMemoryPreamble("", prompt)).toBe(prompt);
  });
});
