import { describe, it, expect } from "vitest";
import {
  AGENT_HINT,
  RECENT_HINT,
  RECENT_SWITCH_HINT,
  CHROME_HINTS,
  AGENT_OVERFLOW_POOL,
  RECENT_POOL,
  agentLabel,
  recentLabel,
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

describe("recentLabel", () => {
  it("labels recent-dropdown rows a..z by list order", () => {
    expect([0, 1, 25].map(recentLabel)).toEqual(["a", "b", "z"]);
  });

  it("returns null past the 26th row (more projects than letters)", () => {
    expect(recentLabel(RECENT_POOL.length)).toBeNull();
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

  it("labels recent rows a..z, counted independently of agents", () => {
    const out = assignLabels([
      { hintId: AGENT_HINT },
      { hintId: RECENT_HINT },
      { hintId: RECENT_HINT },
      { hintId: AGENT_HINT },
    ]);
    expect(out.map((t) => t.label)).toEqual(["1", "a", "b", "2"]);
  });

  it("continues the recent stream into Switch buttons so their letters can't collide", () => {
    // The overlay passes every row before any switch, so rows take a.. and switches resume after.
    const out = assignLabels([
      { hintId: RECENT_HINT },
      { hintId: RECENT_HINT },
      { hintId: RECENT_HINT },
      { hintId: RECENT_SWITCH_HINT },
      { hintId: RECENT_SWITCH_HINT },
    ]);
    expect(out.map((t) => t.label)).toEqual(["a", "b", "c", "d", "e"]);
    expect(new Set(out.map((t) => t.label)).size).toBe(5); // no duplicates
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
