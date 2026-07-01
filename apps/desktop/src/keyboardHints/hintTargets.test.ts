import { describe, it, expect } from "vitest";
import {
  AGENT_HINT,
  CHROME_HINTS,
  AGENT_OVERFLOW_POOL,
  agentLabel,
  assignLabels,
} from "./hintTargets";

describe("agentLabel", () => {
  it("numbers the first nine agents 1..9", () => {
    expect([0, 1, 8].map(agentLabel)).toEqual(["1", "2", "9"]);
  });

  it("spills into the overflow letter pool past the 9th", () => {
    expect(agentLabel(9)).toBe(AGENT_OVERFLOW_POOL[0]);
    expect(agentLabel(10)).toBe(AGENT_OVERFLOW_POOL[1]);
  });

  it("returns null once labels are exhausted", () => {
    expect(agentLabel(9 + AGENT_OVERFLOW_POOL.length)).toBeNull();
  });
});

describe("overflow pool", () => {
  it("never reuses a reserved chrome letter", () => {
    const reserved = new Set(Object.values(CHROME_HINTS));
    for (const ch of AGENT_OVERFLOW_POOL) expect(reserved.has(ch)).toBe(false);
  });
});

describe("assignLabels", () => {
  it("labels agents positionally and chrome by mnemonic", () => {
    const out = assignLabels([
      { hintId: AGENT_HINT },
      { hintId: AGENT_HINT },
      { hintId: "think" },
      { hintId: "menu" },
    ]);
    expect(out.map((t) => t.label)).toEqual(["1", "2", "t", "."]);
  });

  it("counts only agents toward the running number, regardless of interleaving", () => {
    const out = assignLabels([
      { hintId: AGENT_HINT },
      { hintId: "build" },
      { hintId: AGENT_HINT },
    ]);
    expect(out.map((t) => t.label)).toEqual(["1", "b", "2"]);
  });

  it("yields null for an unknown chrome id", () => {
    expect(assignLabels([{ hintId: "nope" }])[0]!.label).toBeNull();
  });

  it("preserves extra fields on each target", () => {
    const out = assignLabels([{ hintId: "plan", el: 42 }]);
    expect(out).toHaveLength(1);
    expect(out[0]!).toMatchObject({ hintId: "plan", el: 42, label: "p" });
  });
});
