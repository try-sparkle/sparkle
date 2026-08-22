// The bead square's rule — which is `epicHealth`'s rule, and the tests are mostly about PROVING
// that rather than re-testing the fold.
//
// THE ANTI-DRIFT PROPERTY IS THE DELIVERABLE. The founder asked for "no differences between the
// two", so the load-bearing assertion here is not "orange works" — `epicHealth.test.ts` owns that —
// it is that `beadHealth` and `epicHealth` return the SAME value for the SAME readings across every
// shape the fold distinguishes. That assertion goes red the instant somebody gives this module a
// branch of its own, which is the failure it exists to catch.
import { describe, expect, it } from "vitest";
import { beadHealth, beadHealthApplies, beadHealthLabel } from "./beadHealth";
import { epicHealth, type EpicAgentReading, type EpicHealth } from "./epicHealth";
import type { RollupDot } from "./workerRollup";
import type { AgentTabStatus } from "../types";
import type { BeadStatus } from "../services/beads";

function agent(
  id: string,
  dot: RollupDot,
  over: Partial<EpicAgentReading> = {},
): EpicAgentReading {
  return { id, dot, status: statusForDot(dot), ...over };
}

function statusForDot(dot: RollupDot): AgentTabStatus {
  switch (dot) {
    case "red":
    case "orange":
      return "blocked";
    case "blue":
      return "questions";
    case "green":
      return "working";
    case "gray":
      return "idle";
  }
}

/** Every mark the square can take — which is every dot the BUILD ROW can paint, because
 *  `EpicHealth` IS `RollupDot`. Typed as `Record<RollupDot, true>` rather than a hand-written array:
 *  a sixth dot fails to COMPILE here instead of silently going untested. */
const ALL_DOTS_PRESENT: Record<RollupDot, true> = {
  green: true,
  red: true,
  blue: true,
  orange: true,
  gray: true,
};
const ALL_HEALTHS: readonly EpicHealth[] = Object.keys(ALL_DOTS_PRESENT) as readonly EpicHealth[];

/** Every fleet shape the fold treats differently, named so a failure says WHICH one drifted. */
const FLEETS: readonly { name: string; readings: EpicAgentReading[] }[] = [
  { name: "empty", readings: [] },
  { name: "one working", readings: [agent("a", "green")] },
  { name: "one asking", readings: [agent("a", "blue")] },
  { name: "one stopped", readings: [agent("a", "red")] },
  { name: "one already-orange head", readings: [agent("a", "orange")] },
  { name: "all finished and calm", readings: [agent("a", "gray")] },
  // `lapsed` used to be the one status that escaped its band to a colour of its own. It no longer
  // does — the founder's hard rule forbids an epic-only colour — so it must agree with plain gray
  // here as well as with epicHealth.
  { name: "lapsed", readings: [agent("a", "gray", { status: "lapsed" })] },
  { name: "mixed red + green", readings: [agent("a", "red"), agent("b", "green")] },
  { name: "mixed, green first", readings: [agent("b", "green"), agent("a", "red")] },
  { name: "all red", readings: [agent("a", "red"), agent("b", "red")] },
  { name: "all green", readings: [agent("a", "green"), agent("b", "green")] },
  { name: "blue beside green", readings: [agent("a", "blue"), agent("b", "green")] },
  {
    name: "folded worker under a present head",
    readings: [agent("head", "green"), agent("w", "red", { parentId: "head" })],
  },
  { name: "orphan worker", readings: [agent("w", "red", { parentId: "head" })] },
];

describe("beadHealth — agrees with epicHealth, reading for reading", () => {
  // THE ANTI-DRIFT ASSERTION. Not "returns a valid EpicHealth" — that passes for a function that
  // always returns "red". The pair has to match, on every shape, or the two squares are lying to
  // each other about the same agent.
  it.each(FLEETS)("matches epicHealth on: $name", ({ readings }) => {
    expect(beadHealth(readings)).toBe(epicHealth(readings));
  });

  it("carries the interesting values through, not just SOME value", () => {
    // The agreement test above would also pass if BOTH functions were broken in the same way, so
    // the four marks a bead card actually renders are pinned to their causes here too.
    expect(beadHealth([])).toBe("gray");
    expect(beadHealth([agent("a", "green")])).toBe("green");
    expect(beadHealth([agent("a", "red")])).toBe("red");
    // BLUE, not amber. A build row paints a questioning agent blue; the card above it now does too.
    expect(beadHealth([agent("a", "blue")])).toBe("blue");
    // The founder's mixed fleet, on a child task exactly as on its epic.
    expect(beadHealth([agent("a", "red"), agent("b", "green")])).toBe("orange");
    expect(beadHealth([agent("a", "red"), agent("b", "green")])).not.toBe("red");
  });

  it("covers every state the two can produce, so the agreement is not tested on a subset", () => {
    // A fixture list can silently stop exercising a state. If a sixth mark is added and no fleet
    // above reaches it, this fails and says so rather than reporting a green agreement over four.
    expect(new Set(FLEETS.map((f) => beadHealth(f.readings)))).toEqual(new Set(ALL_HEALTHS));
  });
});

describe("beadHealthApplies — finished work renders no square", () => {
  it("is FALSE for a closed bead and TRUE for the two live states", () => {
    expect(beadHealthApplies("closed")).toBe(false);
    expect(beadHealthApplies("open")).toBe(true);
    // `in_progress` is the state the whole feature exists to interrogate — a bead stamped
    // "in_progress" at promote-to-build with nothing running is exactly the epic the founder cannot
    // account for, so it MUST still get a square (a gray one) rather than being waved through.
    expect(beadHealthApplies("in_progress")).toBe(true);
  });

  it("suppresses the square on `closed` and NOWHERE else across BeadStatus", () => {
    // Asserted as the complement over the real vocabulary, mirroring epicHealthApplies' test: a
    // status added to BeadStatus later is live by default, and this says so out loud.
    const all: readonly BeadStatus[] = ["open", "in_progress", "closed"];
    expect(all.filter((s) => !beadHealthApplies(s))).toEqual(["closed"]);
  });
});

describe("beadHealthLabel — the same five meanings, a different noun", () => {
  it("gives every state its own words", () => {
    const labels = ALL_HEALTHS.map(beadHealthLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("never says 'epic' — this square rides on child tasks and planning cards", () => {
    // The one deliberate difference from epicHealth, and the reason it exists: "on this epic" is a
    // lie on an ordinary bead card, and hover text is user-facing copy.
    for (const h of ALL_HEALTHS) expect(beadHealthLabel(h)).not.toMatch(/epic/i);
  });

  it("still says what is wrong — gray and orange are the two that need words", () => {
    expect(beadHealthLabel("gray")).toMatch(/nobody is working/i);
    expect(beadHealthLabel("gray")).toMatch(/right now/i);
    expect(beadHealthLabel("orange")).toMatch(/need you/i);
    expect(beadHealthLabel("orange")).toMatch(/still working/i);
  });

  it("DOES use gray for the not-being-worked-on mark — the founder's hard rule", () => {
    // He asked for exactly this: *"gray square because it's not being worked on"*, and then settled
    // the apparent conflict with his own earlier gray rule himself — *"For the gray I do want it to
    // work exactly like the Build Agent. That's the hard rule ... Where it's not active right now,
    // however gray currently works, just make it the same."* This used to assert the OPPOSITE (that
    // the vocabulary contained no gray at all), which is why it is worth pinning in this direction:
    // a revert to the hollow-amber mark reds here rather than sliding through.
    expect(ALL_HEALTHS).toContain("gray");
    expect(beadHealth([agent("a", "gray")])).toBe("gray");
    // The empty roster — the one case with no build-row analogue — lands on the same gray.
    expect(beadHealth([])).toBe("gray");
  });
});
