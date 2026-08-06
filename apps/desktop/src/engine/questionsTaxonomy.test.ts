// `questions` is BLUE, and blue is not a quieter red — it is a DIFFERENT ANSWER to a different
// question.
//
// The bug this state fixes: an agent that stops to interview the founder before building was
// surfaced with the same red treatment as an agent that crashed. Those are opposite facts — one is
// the agent working exactly as intended, the other is work having stopped — and painting the good
// one in the alarm colour teaches the founder to dread the behaviour we want more of.
//
// Scope, deliberately narrow (mirroring redTaxonomySeparation.test.ts's rule): only facts that SPAN
// modules live here. Per-module behaviour stays in that module's own suite. What this file exists to
// stop is the drift that has already shipped twice in this taxonomy — a new tier added to one
// consumer and missed by another.
//
// EVERY ASSERTION HERE FAILS ON THE PRE-CHANGE CODE, most of them at compile time (`questions` did
// not exist as a status or a band). The ones that would still type-check are called out inline.
import { describe, expect, it } from "vitest";
import { AGENT_STATUS, C as BRAND, type AgentTabStatus } from "@sparkle/ui";
import { isRedStatus } from "../services/windowStatus";
import { needsAttention, countAttention } from "./attention";
import { bandOfStatus, STATUS_BANDS, allBandsVisible } from "./buildSections";
import { bandColor, bandCountLabel, bandLabel } from "./statusBandLabels";
import { bandOfRollup, rollupDot, rollupDotAccessor, rollupLabel } from "./workerRollup";
import { statusInk, C } from "../theme/colors";

// ── 1. Blue is not red, anywhere that asks ───────────────────────────────────────────────────────

describe("`questions` is not an alarm", () => {
  it("does not share the alarm red — the whole point of the state", () => {
    expect(AGENT_STATUS.questions.color).not.toBe(AGENT_STATUS.waiting.color);
    expect(AGENT_STATUS.questions.color).not.toBe(AGENT_STATUS.errored.color);
    expect(AGENT_STATUS.questions.color).toBe(BRAND.azure);
  });

  it("is excluded from the red COLOR tier", () => {
    // isRedStatus asks the token map, so this is the assertion that would silently start passing
    // if someone ever set `questions` to a red hex. It is the canary on the whole feature.
    expect(isRedStatus("questions")).toBe(false);
  });

  it("is NOT the accent blue — a status dot must not be the Send button's colour", () => {
    // BRAND.teal/gold/goldHot are the primary accent. A status tier that collided with them would
    // be unreadable as a status, which is why `azure` exists as its own token.
    expect(AGENT_STATUS.questions.color).not.toBe(BRAND.teal);
    expect(AGENT_STATUS.questions.color).not.toBe(BRAND.gold);
    expect(AGENT_STATUS.questions.color).not.toBe(BRAND.goldHot);
    // …and not the gray tier either, which is itself a blue-gray (#8aa0c4).
    expect(AGENT_STATUS.questions.color).not.toBe(AGENT_STATUS.idle.color);
  });
});

// ── 2. …but it is still an ASK, and asks are loud ────────────────────────────────────────────────

describe("`questions` still demands attention", () => {
  it("counts toward the badge and fires a banner, exactly like the red asks", () => {
    // THIS IS THE ASSERTION THAT STOPS THE STATE BEING COSMETIC. A blue dot that did not count is
    // one the founder finds by scrolling, on a fleet where a question can sit for hours.
    expect(needsAttention("questions")).toBe(true);
  });

  it("is counted by countAttention alongside the reds, not instead of them", () => {
    const n = countAttention(
      { a: "questions", b: "waiting", c: "working", d: "idle" },
      ["a", "b", "c", "d"],
    );
    expect(n).toBe(2);
  });

  it("breaks the old 'ATTENTION is a subset of red' assumption ON PURPOSE", () => {
    // For its whole life every needsAttention status was also isRedStatus. `questions` is the first
    // that is not, and code reaching for the wrong predicate is the bug that shipped twice before.
    expect(needsAttention("questions")).toBe(true);
    expect(isRedStatus("questions")).toBe(false);
  });
});

// ── 3. Its own band — not folded into needs_you ──────────────────────────────────────────────────

describe("`questions` is its own band", () => {
  it("bands to `questions`, and specifically NOT to needs_you", () => {
    expect(bandOfStatus("questions")).toBe("questions");
    // The inflation this prevents: `needs_you` is the band the concierge digest counts and the red
    // chip narrows. Folding questions in would make "N agents need you" include the agents that are
    // working exactly as intended — the same false alarm `new` and `unmerged` were moved out to fix.
    expect(bandOfStatus("questions")).not.toBe("needs_you");
  });

  it("has a chip of its own, painted from its own status", () => {
    const meta = STATUS_BANDS.find((b) => b.id === "questions");
    expect(meta).toBeDefined();
    expect(meta!.colorFrom).toBe("questions");
    expect(bandColor("questions")).toBe(AGENT_STATUS.questions.color);
    expect(bandLabel("questions")).toBe("Questions");
  });

  it("is visible by default — a hidden band is an unanswerable question", () => {
    expect(allBandsVisible().questions).toBe(true);
  });

  it("sits second in chip order: after the alarm, ahead of the calm bands", () => {
    const ids = STATUS_BANDS.map((b) => b.id);
    expect(ids.indexOf("questions")).toBe(1);
    expect(ids.indexOf("questions")).toBeGreaterThan(ids.indexOf("needs_you"));
    expect(ids.indexOf("questions")).toBeLessThan(ids.indexOf("running"));
  });

  it("keeps every band a DIFFERENT colour — four tiers, four hues", () => {
    const seen = new Set(STATUS_BANDS.map((b) => bandColor(b.id)));
    expect(seen.size).toBe(STATUS_BANDS.length);
    expect(STATUS_BANDS.length).toBe(4);
  });
});

// ── 4. The count label inflects the NOUN, not the verb ───────────────────────────────────────────

describe("bandCountLabel — `questions` inflects opposite to `needs_you`", () => {
  it("says '1 Question' and '3 Questions'", () => {
    // The trap: reusing the needs_you rule (which STRIPS the -s at n===1) yields "1 Questions".
    expect(bandCountLabel("questions", 1)).toBe("1 Question");
    expect(bandCountLabel("questions", 2)).toBe("2 Questions");
    expect(bandCountLabel("questions", 27)).toBe("27 Questions");
  });

  it("agrees zero with the plural, as English does", () => {
    expect(bandCountLabel("questions", 0)).toBe("0 Questions");
  });

  it("still inflects needs_you the OTHER way — the two rules coexist", () => {
    expect(bandCountLabel("needs_you", 1)).toBe("1 Needs you");
    expect(bandCountLabel("needs_you", 3)).toBe("3 Need you");
  });
});

// ── 5. The rollup law: blue loses to red, beats green, never blends ──────────────────────────────

describe("rollupDot — where blue sits in the law", () => {
  it("paints a head that is itself asking BLUE when nothing under it is redder", () => {
    expect(rollupDot("questions", [])).toBe("blue");
    expect(rollupDot("questions", ["working", "working"])).toBe("blue");
    expect(rollupDot("questions", ["idle"])).toBe("blue");
  });

  it("does NOT let a head's own blue short-circuit a RED worker underneath it", () => {
    // THE REGRESSION THIS PINS, because it shipped: own-blue was an early `return "blue"` placed
    // beside the own-red one, so the worker list was never read. `bandOfRollup` then filed the row
    // under `questions`, and a stopped worker DISAPPEARED from an isolated "Needs you" view — the
    // one view whose entire job is to show everything that has stopped.
    //
    // Own RED may short-circuit (nothing outranks it). Own BLUE may not, because red does. If that
    // asymmetry is not honoured, "blue loses to red" is not a law, just a preference about workers.
    expect(rollupDot("questions", ["blocked"])).toBe("red");
    expect(rollupDot("questions", ["waiting"])).toBe("red");
    // …and it still files where the alarm can be found.
    expect(bandOfRollup(rollupDot("questions", ["blocked"]))).toBe("needs_you");
    // Mixed subtree under a questioning head is orange, for the same reason it is anywhere else.
    expect(rollupDot("questions", ["waiting", "working"])).toBe("orange");
  });

  it("lets the head's OWN red outrank its own blue — the alarm is seen first", () => {
    // Not reachable from a single status today, but the ordering is the contract: red is checked
    // before blue, so a head that is somehow both reports the alarm.
    expect(rollupDot("blocked", ["questions"])).toBe("red");
  });

  it("bubbles a worker's question up to a calm head", () => {
    // Without this the fold hides the only row that has something to say — the exact lie this
    // module exists to remove.
    expect(rollupDot("idle", ["questions"])).toBe("blue");
    expect(rollupDot("working", ["questions"])).toBe("blue");
  });

  it("BEATS green and does not blend with it — no blue+green mix colour", () => {
    // A question you can answer is strictly more actionable than "something is running".
    expect(rollupDot("idle", ["questions", "working"])).toBe("blue");
    expect(rollupDot("idle", ["working", "questions", "working"])).toBe("blue");
  });

  it("LOSES to red — a stopped worker is seen before a questioning one", () => {
    expect(rollupDot("idle", ["questions", "blocked"])).toBe("red");
    expect(rollupDot("idle", ["questions", "waiting"])).toBe("red");
  });

  it("red + blue + green is ORANGE, not a fourth blend", () => {
    // The orange is reporting the RED, and orange already files under needs_you.
    expect(rollupDot("idle", ["questions", "waiting", "working"])).toBe("orange");
  });

  it("files blue under its own band, never under needs_you", () => {
    expect(bandOfRollup("blue")).toBe("questions");
    expect(bandOfRollup("red")).toBe("needs_you");
    expect(bandOfRollup("orange")).toBe("needs_you");
  });

  it("has a tooltip that says workers, not the row", () => {
    expect(rollupLabel("blue")).toBe("Workers have questions");
  });
});

// ── 6. Dismissal silences alarms, never questions ────────────────────────────────────────────────

describe("dismissal cannot hide a pending question", () => {
  const agents = [
    { id: "head", kind: "build", parentId: null },
    { id: "w1", kind: "worker", parentId: "head" },
    { id: "w2", kind: "worker", parentId: "head" },
  ];

  it("re-rolls a dismissed head to BLUE when a worker is still asking", () => {
    // Dismissal is the "I've seen the red, stop shouting" control. A question is not resolved by
    // acknowledging it — it is resolved by ANSWERING it. So the red goes and the blue stays.
    const status: Record<string, AgentTabStatus> = {
      head: "idle",
      w1: "blocked", // the red being dismissed
      w2: "questions", // must survive
    };
    const dot = rollupDotAccessor(
      agents,
      (id) => status[id]!,
      (id) => status[id]!,
      { isDismissed: (id) => id === "head" },
    );
    expect(dot("head")).toBe("blue");
  });

  it("without the dismissal that same head is RED — proving the dismissal did something", () => {
    // Guards against the assertion above passing for the wrong reason (i.e. if blue simply always
    // won). The red must genuinely be present and genuinely be removed.
    const status: Record<string, AgentTabStatus> = {
      head: "idle",
      w1: "blocked",
      w2: "questions",
    };
    const dot = rollupDotAccessor(agents, (id) => status[id]!, (id) => status[id]!, {});
    expect(dot("head")).toBe("red");
  });
});

// ── 7. As TEXT it flips to the themed ink ────────────────────────────────────────────────────────

describe("statusInk maps the blue tier to its themed twin", () => {
  it("flips brand azure to questionsInk", () => {
    expect(statusInk(AGENT_STATUS.questions.color)).toBe(C.questionsInk);
  });

  it("really is a change, not an identity", () => {
    // Without this, the mapping could be a no-op fallthrough and the test above would still pass.
    expect(C.questionsInk).not.toBe(AGENT_STATUS.questions.color);
  });

  it("leaves the other tiers where they were", () => {
    expect(statusInk(AGENT_STATUS.waiting.color)).toBe(C.dangerInk);
    expect(statusInk(AGENT_STATUS.working.color)).toBe(C.successInk);
    expect(statusInk(AGENT_STATUS.idle.color)).toBe(C.agentIdle);
  });
});
