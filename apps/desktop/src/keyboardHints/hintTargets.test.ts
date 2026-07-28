import { describe, it, expect } from "vitest";
import {
  AGENT_HINT,
  PROJECT_TAB_HINT,
  RECENT_HINT,
  RECENT_SWITCH_HINT,
  CHROME_HINTS,
  AGENT_OVERFLOW_POOL,
  RECENT_POOL,
  agentLabel,
  projectTabLabel,
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

describe("projectTabLabel", () => {
  it("letters tabs from the head of the shared overflow pool, left to right", () => {
    expect([0, 1, 2].map(projectTabLabel)).toEqual(AGENT_OVERFLOW_POOL.slice(0, 3));
  });

  it("returns null past the pool — a tab with no label just gets no badge", () => {
    expect(projectTabLabel(AGENT_OVERFLOW_POOL.length)).toBeNull();
    expect(projectTabLabel(AGENT_OVERFLOW_POOL.length + 5)).toBeNull();
  });

  it("never hands a tab a reserved chrome mnemonic", () => {
    const reserved = new Set(Object.values(CHROME_HINTS));
    for (let i = 0; i < AGENT_OVERFLOW_POOL.length; i += 1) {
      expect(reserved.has(projectTabLabel(i)!)).toBe(false);
    }
  });
});

describe("overflow pool", () => {
  it("never reuses a reserved chrome letter", () => {
    const reserved = new Set(Object.values(CHROME_HINTS));
    for (const ch of AGENT_OVERFLOW_POOL) expect(reserved.has(ch)).toBe(false);
  });

  it("resumes agent overflow AFTER the letters the project tabs claimed", () => {
    // Two tabs on screen → the 10th agent (index 9, the first to spill out of 1..9) starts at the
    // THIRD pool letter, not the first.
    expect(agentLabel(9, 2)).toBe(AGENT_OVERFLOW_POOL[2]);
    expect(agentLabel(8, 2)).toBe("9"); // the numbered nine are unaffected by the offset
    expect(agentLabel(9 + AGENT_OVERFLOW_POOL.length - 2, 2)).toBeNull(); // exhausted two letters early
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

  it("letters project tabs while agents keep their numbers", () => {
    const out = assignLabels([
      { hintId: PROJECT_TAB_HINT },
      { hintId: PROJECT_TAB_HINT },
      { hintId: AGENT_HINT },
      { hintId: AGENT_HINT },
    ]);
    expect(out.map((t) => t.label)).toEqual([
      AGENT_OVERFLOW_POOL[0],
      AGENT_OVERFLOW_POOL[1],
      "1",
      "2",
    ]);
  });

  // THE POINT OF THE SHARED STREAM. Both lists are on screen together in concierge mode: tabs across
  // the top, builder rows down the sidebar. If they drew from two independent pools, the 10th agent
  // and the 1st tab would both be "e" and one of the two keys would be unreachable.
  it("never gives a project tab and an agent-overflow row the same letter", () => {
    for (let tabs = 0; tabs <= AGENT_OVERFLOW_POOL.length + 2; tabs += 1) {
      for (let agents = 0; agents <= 9 + AGENT_OVERFLOW_POOL.length + 2; agents += 1) {
        const out = assignLabels([
          ...Array.from({ length: tabs }, () => ({ hintId: PROJECT_TAB_HINT })),
          ...Array.from({ length: agents }, () => ({ hintId: AGENT_HINT })),
          ...Object.keys(CHROME_HINTS).map((hintId) => ({ hintId })),
        ]);
        // Every label that IS handed out is unique across tabs, agents and chrome alike; the
        // leftovers past the pool are null (no badge), never a wrapped-around duplicate.
        const labels = out.map((t) => t.label).filter((l): l is string => l !== null);
        expect(new Set(labels).size, `tabs=${tabs} agents=${agents}`).toBe(labels.length);
      }
    }
  });

  // Ordering must not be load-bearing: the overlay sorts each bucket by visual order, and tabs sit
  // ABOVE the sidebar, so a future reshuffle of the buckets must not silently reintroduce collisions.
  it("keeps the streams disjoint even when agents are listed before the tabs", () => {
    const agents = Array.from({ length: 11 }, () => ({ hintId: AGENT_HINT }));
    const tabs = [{ hintId: PROJECT_TAB_HINT }, { hintId: PROJECT_TAB_HINT }];
    const out = assignLabels([...agents, ...tabs]);
    expect(out.map((t) => t.label)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9",
      AGENT_OVERFLOW_POOL[2],
      AGENT_OVERFLOW_POOL[3],
      AGENT_OVERFLOW_POOL[0],
      AGENT_OVERFLOW_POOL[1],
    ]);
  });

  it("gives tabs past the pool no badge instead of wrapping", () => {
    const out = assignLabels(
      Array.from({ length: AGENT_OVERFLOW_POOL.length + 2 }, () => ({ hintId: PROJECT_TAB_HINT })),
    );
    expect(out.slice(-2).map((t) => t.label)).toEqual([null, null]);
    expect(out.at(-3)!.label).toBe(AGENT_OVERFLOW_POOL.at(-1));
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
