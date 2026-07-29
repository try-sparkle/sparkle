import { describe, it, expect } from "vitest";
import {
  AGENT_HINT,
  PROJECT_TAB_HINT,
  RECENT_HINT,
  RECENT_SWITCH_HINT,
  CHROME_HINTS,
  ATTACH_ACTION_HINTS,
  AGENT_OVERFLOW_POOL,
  RECENT_POOL,
  PAIR_PREFIX,
  PAIR_SECONDS,
  agentLabel,
  projectTabLabel,
  recentLabel,
  isPairLabel,
  assignLabels,
} from "./hintTargets";

// Every slot a pool can hand out before it truly runs dry: its single characters, then the pairs.
const CAPACITY = (pool: string[]) => pool.length + PAIR_SECONDS.length;

describe("agentLabel", () => {
  it("numbers the first nine agents 1..9", () => {
    expect([0, 1, 8].map(agentLabel)).toEqual(["1", "2", "9"]);
  });

  it("spills into the overflow letter pool past the 9th", () => {
    expect(agentLabel(9)).toBe(AGENT_OVERFLOW_POOL[0]);
    expect(agentLabel(10)).toBe(AGENT_OVERFLOW_POOL[1]);
  });

  it("continues into PAIR_PREFIX pairs once the single characters run out", () => {
    const firstPair = 9 + AGENT_OVERFLOW_POOL.length;
    expect(agentLabel(firstPair)).toBe(`${PAIR_PREFIX}a`);
    expect(agentLabel(firstPair + 1)).toBe(`${PAIR_PREFIX}b`);
  });

  it("returns null only once the pairs are exhausted too", () => {
    expect(agentLabel(9 + CAPACITY(AGENT_OVERFLOW_POOL) - 1)).toBe(`${PAIR_PREFIX}z`);
    expect(agentLabel(9 + CAPACITY(AGENT_OVERFLOW_POOL))).toBeNull();
  });
});

describe("recentLabel", () => {
  it("labels recent-dropdown rows a..y by list order, skipping the pair prefix", () => {
    expect([0, 1, 24].map(recentLabel)).toEqual(["a", "b", "y"]);
    expect(RECENT_POOL).not.toContain(PAIR_PREFIX);
  });

  it("continues into pairs past the single characters instead of dropping the badge", () => {
    expect(recentLabel(RECENT_POOL.length)).toBe(`${PAIR_PREFIX}a`);
    expect(recentLabel(CAPACITY(RECENT_POOL) - 1)).toBe(`${PAIR_PREFIX}z`);
    expect(recentLabel(CAPACITY(RECENT_POOL))).toBeNull();
  });
});

describe("projectTabLabel", () => {
  it("letters tabs from the head of the shared overflow pool, left to right", () => {
    expect([0, 1, 2].map(projectTabLabel)).toEqual(AGENT_OVERFLOW_POOL.slice(0, 3));
  });

  it("continues into pairs past the single characters, and only then gives up", () => {
    expect(projectTabLabel(AGENT_OVERFLOW_POOL.length)).toBe(`${PAIR_PREFIX}a`);
    expect(projectTabLabel(CAPACITY(AGENT_OVERFLOW_POOL) - 1)).toBe(`${PAIR_PREFIX}z`);
    expect(projectTabLabel(CAPACITY(AGENT_OVERFLOW_POOL))).toBeNull();
  });

  it("never hands a tab a reserved chrome mnemonic, single or paired", () => {
    const reserved = new Set(Object.values(CHROME_HINTS));
    for (let i = 0; i < CAPACITY(AGENT_OVERFLOW_POOL); i += 1) {
      expect(reserved.has(projectTabLabel(i)!)).toBe(false);
    }
  });
});

describe("the pair prefix", () => {
  // THE FOUNDER'S RULE, and the whole reason a two-character label is safe: pressing PAIR_PREFIX has
  // to mean "open the pair layer" unambiguously, which it cannot if something is also labelled "z".
  it("is never a label on its own, in any pool", () => {
    expect(AGENT_OVERFLOW_POOL).not.toContain(PAIR_PREFIX);
    expect(RECENT_POOL).not.toContain(PAIR_PREFIX);
    expect(Object.values(CHROME_HINTS)).not.toContain(PAIR_PREFIX);
    expect(Object.values(ATTACH_ACTION_HINTS)).not.toContain(PAIR_PREFIX);
  });

  it("recognises pair labels and only pair labels", () => {
    expect(isPairLabel(`${PAIR_PREFIX}a`)).toBe(true);
    expect(isPairLabel(`${PAIR_PREFIX}${PAIR_PREFIX}`)).toBe(true);
    expect(isPairLabel("a")).toBe(false);
    expect(isPairLabel("1")).toBe(false);
    expect(isPairLabel("ab")).toBe(false); // a two-character label that isn't prefixed isn't ours
  });

  it("keeps zz usable as a real label — the prefix layer is left by Escape, not by a second z", () => {
    expect(PAIR_SECONDS).toContain(PAIR_PREFIX);
    expect(recentLabel(CAPACITY(RECENT_POOL) - 1)).toBe("zz");
  });
});

describe("the concierge compose-box mnemonics", () => {
  it("gives the prompt box, presence slider and paperclip their approved characters", () => {
    expect(CHROME_HINTS.prompt).toBe("/");
    expect(CHROME_HINTS.presence).toBe("h");
    expect(CHROME_HINTS.attach).toBe("k");
  });

  // "s" is deliberately shared with CHROME_HINTS.screenshot (the agent-pane composer's button); it is
  // legal ONLY because the overlay scopes the attach chain to these two badges. Keeping them out of
  // CHROME_HINTS is what preserves that map's own no-duplicates invariant.
  it("keeps the attach actions out of the chrome map so their letters can be reused", () => {
    expect(ATTACH_ACTION_HINTS["attach-screenshot"]).toBe("s");
    expect(ATTACH_ACTION_HINTS["attach-upload"]).toBe("u");
    expect(Object.keys(CHROME_HINTS)).not.toContain("attach-screenshot");
    expect(Object.keys(CHROME_HINTS)).not.toContain("attach-upload");
  });

  it("still hands out a distinct character for every chrome control", () => {
    const chars = Object.values(CHROME_HINTS);
    expect(new Set(chars).size).toBe(chars.length);
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
    // ...and it runs dry two slots early, now at the end of the PAIRS rather than the letters.
    expect(agentLabel(9 + CAPACITY(AGENT_OVERFLOW_POOL) - 2, 2)).toBeNull();
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
    // Ranged past the single characters and into the PAIRS: the shared-stream invariant has to hold
    // across the seam too, which is exactly where an off-by-one in poolLabel would show up.
    for (let tabs = 0; tabs <= CAPACITY(AGENT_OVERFLOW_POOL) + 2; tabs += 1) {
      for (let agents = 0; agents <= 9 + CAPACITY(AGENT_OVERFLOW_POOL) + 2; agents += 1) {
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

  it("carries tabs past the single characters into pairs, and gives up only at the very end", () => {
    const out = assignLabels(
      Array.from({ length: CAPACITY(AGENT_OVERFLOW_POOL) + 2 }, () => ({ hintId: PROJECT_TAB_HINT })),
    );
    expect(out[AGENT_OVERFLOW_POOL.length - 1]!.label).toBe(AGENT_OVERFLOW_POOL.at(-1));
    expect(out[AGENT_OVERFLOW_POOL.length]!.label).toBe(`${PAIR_PREFIX}a`); // straight across the seam
    expect(out.slice(-2).map((t) => t.label)).toEqual([null, null]);
    expect(out.at(-3)!.label).toBe(`${PAIR_PREFIX}z`);
  });

  it("labels the paperclip's two actions from their own map", () => {
    const out = assignLabels([
      { hintId: "attach-screenshot" },
      { hintId: "attach-upload" },
    ]);
    expect(out.map((t) => t.label)).toEqual(["s", "u"]);
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
