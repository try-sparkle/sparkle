// The epic square's rollup rule — all four states, and the orderings between them.
//
// EVERY CASE HERE MIXES AGENTS, and that is the point. "One red agent → red" passes against a
// function that ignores its input and returns red; "one green agent → green" passes against one
// that returns the FIRST mark it sees. The interesting assertion is always the one where a worse
// and a better reading are present TOGETHER and the worse has to win from either position in the
// list — which is what actually breaks when someone reorders the scan or forgets the early return.
import { describe, expect, it } from "vitest";
import {
  epicHealth,
  epicHealthApplies,
  epicHealthLabel,
  markOf,
  worseEpicHealth,
  type EpicAgentReading,
  type EpicHealth,
} from "./epicHealth";
import { EPIC_LADDER } from "../services/epicBoard";
import type { RollupDot } from "./workerRollup";
import type { AgentTabStatus } from "../types";

function agent(
  id: string,
  dot: RollupDot,
  over: Partial<EpicAgentReading> = {},
): EpicAgentReading {
  return { id, dot, status: statusForDot(dot), ...over };
}

/** A plausible own-status for a dot, so a reading is never internally contradictory. Tests that
 *  care about the status pass it explicitly. */
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

describe("epicHealth — the four states", () => {
  it("is GREEN when a bound agent is working and nothing is worse", () => {
    expect(epicHealth([agent("a", "gray"), agent("b", "green")])).toBe("green");
  });

  it("is AMBER when an agent has a question, even beside a working one", () => {
    // Both orders: the amber must win whether it is scanned before or after the green.
    expect(epicHealth([agent("a", "green"), agent("b", "blue")])).toBe("amber");
    expect(epicHealth([agent("b", "blue"), agent("a", "green")])).toBe("amber");
  });

  it("is RED when an agent is stopped, beating both amber and green from either position", () => {
    expect(epicHealth([agent("a", "green"), agent("b", "blue"), agent("c", "red")])).toBe("red");
    expect(epicHealth([agent("c", "red"), agent("b", "blue"), agent("a", "green")])).toBe("red");
  });

  it("is UNSTAFFED when the epic has no bound build agent at all", () => {
    expect(epicHealth([])).toBe("unstaffed");
  });

  it("is UNSTAFFED — never green — when every bound agent has finished and gone calm", () => {
    // THE 'JUST SITTING THERE' CASE WITH AGENTS ON IT. The founder's green is "there are build
    // agents that are WORKING"; a roster of finished agents satisfies "there are build agents" and
    // not the rest. A rule written as "has agents → green" passes every other case in this file.
    const done: readonly AgentTabStatus[] = ["idle", "done", "stopped", "unmerged", "new"];
    for (const status of done) {
      expect(epicHealth([agent("a", "gray", { status })])).toBe("unstaffed");
    }
  });
});

describe("epicHealth — the mappings that are NOT the obvious ones", () => {
  it("files an ORANGE row under red, agreeing with bandOfRollup rather than with its pixels", () => {
    // Orange LOOKS amber on screen, so amber is the tempting reading. `bandOfRollup("orange")` is
    // `needs_you`, and filing it as amber would make this square disagree with the "Needs you"
    // filter chip about the same epic.
    expect(markOf(agent("a", "orange"))).toBe("red");
    expect(epicHealth([agent("a", "orange"), agent("b", "green")])).toBe("red");
  });

  it("reads a LAPSED agent as amber, though its band is `done`", () => {
    // `lapsed` is brand AMBER in packages/ui/tokens.ts but bands as `done`, so a band-only rule
    // drops it. Contrast with a plain `idle` gray, which contributes nothing.
    expect(epicHealth([agent("a", "gray", { status: "lapsed" })])).toBe("amber");
    expect(epicHealth([agent("a", "gray", { status: "idle" })])).toBe("unstaffed");
  });

  it("FOLDS a worker whose head is also bound, but keeps an orphan worker", () => {
    // A red worker under a head that is present cannot speak twice — `rollupDot` already folded it
    // into that head's dot, and the head here has been calmed (dismissed alert, in-motion
    // suppression). Counting the worker again would resurrect a red the shared pipeline retired.
    const head = agent("head", "green");
    const worker = agent("w", "red", { parentId: "head" });
    expect(epicHealth([head, worker])).toBe("green");
    // ...but the SAME worker with its head absent from the epic is the only row carrying it.
    expect(epicHealth([worker])).toBe("red");
  });
});

describe("epicHealthApplies — which rungs get a square", () => {
  it("suppresses the square on the three terminal rungs and nowhere else", () => {
    const live = EPIC_LADDER.filter((k) => epicHealthApplies(k));
    const terminal = EPIC_LADDER.filter((k) => !epicHealthApplies(k));
    expect(terminal).toEqual(["done", "delivered", "archived"]);
    // Asserted as the COMPLEMENT over the real ladder, so a rung added to EPIC_LADDER later shows
    // up here as a live rung rather than silently going unrendered.
    expect(live).toEqual(["backlog", "planning", "blocked", "inProgress"]);
  });
});

describe("worseEpicHealth / epicHealthLabel", () => {
  it("orders red > amber > green > unstaffed, both ways round", () => {
    const order: EpicHealth[] = ["red", "amber", "green", "unstaffed"];
    // `entries()` rather than index arithmetic: under `noUncheckedIndexedAccess` an `order[i]` read
    // is `EpicHealth | undefined`, which the function does not accept.
    for (const [i, a] of order.entries()) {
      for (const [j, b] of order.entries()) {
        expect(worseEpicHealth(a, b)).toBe(order[Math.min(i, j)]);
      }
    }
  });

  it("gives every state its own words — no two states share a label", () => {
    const labels = (["red", "amber", "green", "unstaffed"] as EpicHealth[]).map(epicHealthLabel);
    expect(new Set(labels).size).toBe(labels.length);
    // The unstaffed one has to say what is actually wrong, or the square is unreadable.
    expect(epicHealthLabel("unstaffed")).toMatch(/nobody is working/i);
  });
});
