// The epic square's rollup rule — all five states, the orderings between them, and the rung a live
// fleet argues for.
//
// THE LOAD-BEARING ASSERTION IS THE PARITY ONE. The founder's hard rule, 2026-08-22: *"The colors
// work the same between the two and don't let any instruction ever override that."* So the first
// describe below pins `markOf` to the IDENTITY over every `RollupDot` — an epic's mark for an agent
// IS that agent's build-row dot. Any re-derivation anyone adds later (a band lookup, a status
// special case, an epic-only "amber") reds it, whatever colour it produces.
//
// EVERY FOLD CASE HERE MIXES AGENTS, and that is the point. "One red agent → red" passes against a
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
  rungForEpicHealth,
  worseEpicHealth,
  type EpicAgentReading,
  type EpicHealth,
} from "./epicHealth";
import { EPIC_LADDER } from "../services/epicBoard";
import { bandOfRollup, type RollupDot } from "./workerRollup";
import type { AgentTabStatus } from "../types";

function agent(
  id: string,
  dot: RollupDot,
  over: Partial<EpicAgentReading> = {},
): EpicAgentReading {
  return { id, dot, status: statusForDot(dot), ...over };
}

/** A plausible own-status for a dot, so a reading is never internally contradictory. Tests that
 *  care about the status pass it explicitly.
 *
 *  NOTHING IN THE RULE READS IT ANY MORE — the `lapsed` arm that did was an epic-only colour and is
 *  deleted (see `epicHealth.ts`'s header). It is still supplied here precisely so the tests below
 *  that vary it can PROVE it changes nothing. */
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

/** Every dot the BUILD ROW can paint, enumerated so that a sixth one cannot be forgotten.
 *
 *  Typed as `Record<RollupDot, true>` rather than a `readonly RollupDot[]`: a hand-written array can
 *  silently stop covering a new member, while this fails to COMPILE the moment `RollupDot` grows.
 *  That is the property every "all five" test in this file leans on. */
const ALL_DOTS_PRESENT: Record<RollupDot, true> = {
  green: true,
  red: true,
  blue: true,
  orange: true,
  gray: true,
};
const ALL_DOTS = Object.keys(ALL_DOTS_PRESENT) as readonly RollupDot[];

/** Every value the square can take. It is the SAME list as `ALL_DOTS`, by construction — assigning
 *  one to the other is a compile-time proof that `EpicHealth` has not sprouted a private member. */
const ALL_HEALTHS: readonly EpicHealth[] = ALL_DOTS;

describe("PARITY — the square is the build row's dot, drawn as a square", () => {
  it("marks each agent with its OWN RollupDot, unchanged, for every dot the build row can paint", () => {
    // THE FOUNDER'S HARD RULE, asserted directly rather than colour by colour: if `markOf` is the
    // identity then no epic-only colour can exist, because there is no step in which one could be
    // introduced. Every historical deviation this file's header lists (`questions` → amber, `lapsed`
    // → amber, an absent roster → hollow amber) fails this loop.
    for (const dot of ALL_DOTS) {
      expect(markOf(agent("a", dot)), dot).toBe(dot);
    }
    // ...and it is total: five dots in, five DISTINCT marks out. A `markOf` that folded any two
    // together — which is what "questions is amber" was — would shrink this set.
    expect(new Set(ALL_DOTS.map((d) => markOf(agent("a", d))))).toEqual(new Set(ALL_DOTS));
  });

  it("ignores the agent's own STATUS entirely — the mark is the dot and nothing else", () => {
    // The deleted `lapsed` arm read a status specifically to paint a colour the band table would
    // not, which is by definition a difference between the two surfaces. `lapsed` is the exact
    // status that arm keyed on, so this is the arm's own gravestone: same dot, same mark, whatever
    // the row's published status says.
    const statuses: readonly AgentTabStatus[] = ["lapsed", "idle", "done", "stopped", "unmerged"];
    for (const status of statuses) {
      expect(markOf(agent("a", "gray", { status })), status).toBe("gray");
    }
    // And the status is OPTIONAL, so a caller that has none still gets the same answer.
    expect(markOf({ id: "a", dot: "gray" })).toBe("gray");
  });

  it("does NOT go through the BAND, which is lossy in two places at once", () => {
    // The band table is right for the CHIP and wrong for the SQUARE, and this pins both losses so a
    // future "just read the band, it's simpler" reverts against a red test rather than a comment.
    // `orange` and `red` share a band; so, under the old rule, did `blue` and an epic-only amber.
    expect(bandOfRollup("orange")).toBe("needs_you");
    expect(bandOfRollup("red")).toBe("needs_you");
    expect(markOf(agent("a", "orange"))).not.toBe(markOf(agent("b", "red")));
    // Blue keeps its own colour rather than being recoloured to match its band's neighbours.
    expect(bandOfRollup("blue")).toBe("questions");
    expect(markOf(agent("a", "blue"))).toBe("blue");
  });
});

describe("epicHealth — the five states", () => {
  it("is GREEN when a bound agent is working and nothing is worse", () => {
    expect(epicHealth([agent("a", "gray"), agent("b", "green")])).toBe("green");
  });

  it("is BLUE when an agent has a question, even beside a working one", () => {
    // Blue, not amber. `rollupDot`'s own law is "blue loses to red and beats green", and a build row
    // paints that fleet blue; the epic above it now paints the same thing. Both orders: the blue
    // must win whether it is scanned before or after the green.
    expect(epicHealth([agent("a", "green"), agent("b", "blue")])).toBe("blue");
    expect(epicHealth([agent("b", "blue"), agent("a", "green")])).toBe("blue");
  });

  it("is RED when every agent is stopped — beating blue from either position", () => {
    // No GREEN here, deliberately: red beside green is the MIXED case and is asserted as `orange`
    // below. Blue still loses to red outright, from either end of the list.
    expect(epicHealth([agent("a", "blue"), agent("c", "red")])).toBe("red");
    expect(epicHealth([agent("c", "red"), agent("b", "blue")])).toBe("red");
    expect(epicHealth([agent("c", "red"), agent("d", "red")])).toBe("red");
  });

  it("is GRAY when the epic has no bound build agent at all", () => {
    // THE ONE CASE WITH NO BUILD-ROW ANALOGUE — a build row always has an agent — and it is kept
    // reachable rather than given a colour of its own. Gray is the honest answer: "not active right
    // now" is exactly true of an epic nobody is building.
    expect(epicHealth([])).toBe("gray");
  });

  it("is GRAY — never green — when every bound agent has finished and gone calm", () => {
    // THE 'JUST SITTING THERE' CASE WITH AGENTS ON IT. The founder's green is "there are build
    // agents that are WORKING"; a roster of finished agents satisfies "there are build agents" and
    // not the rest. A rule written as "has agents → green" passes every other case in this file.
    // `lapsed` is in this list on purpose: it used to be the one status that escaped to amber.
    const done: readonly AgentTabStatus[] = ["idle", "done", "stopped", "unmerged", "new", "lapsed"];
    for (const status of done) {
      expect(epicHealth([agent("a", "gray", { status })]), status).toBe("gray");
    }
  });
});

describe("epicHealth — the MIXED fleet reads orange, not red", () => {
  // THE PAIRED CASES ARE THE POINT. "One red + one green → orange" on its own passes against a
  // function that returns orange whenever it sees a red, and against one that ignores its input.
  // Pinning all-red → red and all-green → green beside it is what ties the new arm to its CAUSE —
  // the disagreement — rather than to a fixture.
  it("reads a red-beside-green fleet as ORANGE and explicitly NOT as red", () => {
    const mixed = [agent("a", "red"), agent("b", "green")];
    expect(epicHealth(mixed)).toBe("orange");
    expect(epicHealth(mixed)).not.toBe("red");
    // From either position: the fleet test must not depend on scan order, which is exactly what
    // the early-return-on-red it replaced got wrong.
    expect(epicHealth([agent("b", "green"), agent("a", "red")])).toBe("orange");
  });

  it("stays RED when the same fleet loses its green, and GREEN when it loses its red", () => {
    expect(epicHealth([agent("a", "red"), agent("b", "red")])).toBe("red");
    expect(epicHealth([agent("a", "green"), agent("b", "green")])).toBe("green");
  });

  it("still reads ORANGE when a green sits behind a blue later in the list", () => {
    // The blue must not absorb the green before the fleet test sees it — a max-only rule would
    // report `red` here, since red outranks both.
    expect(epicHealth([agent("a", "red"), agent("b", "blue"), agent("c", "green")])).toBe("orange");
  });

  it("is NOT orange for red-beside-blue — mixed means red beside GREEN", () => {
    // `rollupDot` paints a red-plus-blue subtree solid RED (`anyRed && anyGreen` is checked BEFORE
    // `anyRed`), and "the colors work the same between the two" is the requirement. Blue is
    // *waiting*, not *working*, so nothing in this fleet is moving.
    const redBesideBlue = [agent("a", "red"), agent("b", "blue")];
    expect(epicHealth(redBesideBlue)).toBe("red");
    expect(epicHealth(redBesideBlue)).not.toBe("orange");
    // ...and the rung follows the square: a human's turn, not "Build: Active".
    expect(rungForEpicHealth(epicHealth(redBesideBlue))).toBe("blocked");
    // The PAIRED case that ties it to its cause: swap that blue for a green and it IS mixed. If
    // this pair ever agrees, the fleet test has stopped distinguishing waiting from working.
    expect(epicHealth([agent("a", "red"), agent("b", "green")])).toBe("orange");
  });

  it("reads an ALREADY-ORANGE head as orange, without a green row beside it", () => {
    // `rollupDot` may have folded a mixed subtree into one head. That single reading carries both
    // facts, so the epic is mixed even though no second row is green.
    expect(epicHealth([agent("a", "orange")])).toBe("orange");
    expect(markOf(agent("a", "orange"))).toBe("orange");
  });

  it("reads an orange head beside a solid red as ORANGE — the green under it is not lost", () => {
    // Parity with `rollupDot`: `anyRed && anyGreen` is checked BEFORE `anyRed`, so a folded mixed
    // subtree keeps the fleet mixed rather than being swallowed by a sibling's red.
    expect(epicHealth([agent("a", "orange"), agent("b", "red")])).toBe("orange");
  });
});

describe("epicHealth — the fold", () => {
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

    // Asserted as the COMPLEMENT over the real ladder, so a rung added to EPIC_LADDER later shows
    // up here as a live rung rather than silently going unrendered. `unstaffed` — the Build:
    // Unstaffed rung — is in this list BECAUSE of that: the mechanism worked exactly as its comment
    // promised, forcing the new rung to be acknowledged here. It is emphatically a rung that WANTS
    // a square: an epic sitting there is one nobody is building, which is the whole reason it exists.
    //
    // NOTE THE VOCABULARY COLLISION THAT NO LONGER EXISTS. `"unstaffed"` here is a LADDER RUNG, and
    // it is the only `"unstaffed"` left in this module's world — the epic HEALTH value that used to
    // share the name is now `"gray"`, a `RollupDot`. See `epicHealth.ts`'s header.
    //
    // EXACT EQUALITY, NOT `arrayContaining`. The weaker form was tried and is a real loss: it passes
    // for a live list that has silently DROPPED a rung, which is precisely the failure this
    // assertion exists to catch — a rung rendering no square is how a sitting epic goes back to
    // looking calm.
    //
    // And NOT a `live.length + terminal.length === EPIC_LADDER.length` partition check either. That
    // looks like it recovers the lost strength and is a TAUTOLOGY: both arrays are
    // `EPIC_LADDER.filter()` over one source with complementary predicates, so the identity holds
    // for ANY predicate, a constant `true` included. It cannot fail, so it proves nothing — the
    // vacuous-assertion shape this repo's contract names. The two exact lists carry it instead.
    expect(live).toEqual(["backlog", "planning", "blocked", "unstaffed", "inProgress"]);
    // BOTH sides exact, and the terminal one is not redundant. Dropping it was tried and it broke
    // two ways at once: `terminal` became an unused local (`@typescript-eslint/no-unused-vars` is
    // an ERROR in this repo, and `pnpm verify` SKIPS lint — so a green 239-test run said nothing
    // about it and only CI would have caught it), and the guarantee that exactly these three rungs
    // are suppressed silently became a dependency on `EPIC_LADDER` being pinned in a DIFFERENT file
    // (`services/epicBoard.test.ts`). Stating both here keeps this file's claim self-contained.
    expect(terminal).toEqual(["done", "delivered", "archived"]);
  });
});

describe("worseEpicHealth / epicHealthLabel", () => {
  it("orders red > orange > blue > green > gray, both ways round", () => {
    // This ordering is `rollupDot`'s law as numbers — "blue loses to red and beats green", grey
    // ignored — so a flip here is a divergence from the build row, not merely a re-rank.
    const order: EpicHealth[] = ["red", "orange", "blue", "green", "gray"];
    // `entries()` rather than index arithmetic: under `noUncheckedIndexedAccess` an `order[i]` read
    // is `EpicHealth | undefined`, which the function does not accept.
    for (const [i, a] of order.entries()) {
      for (const [j, b] of order.entries()) {
        expect(worseEpicHealth(a, b)).toBe(order[Math.min(i, j)]);
      }
    }
    // ...and the rank covers every dot, so a sixth one cannot arrive without a rank.
    expect(new Set(order)).toEqual(new Set(ALL_DOTS));
  });

  it("gives every state its own words — no two states share a label", () => {
    const labels = ALL_HEALTHS.map(epicHealthLabel);
    expect(new Set(labels).size).toBe(labels.length);
    // The gray one has to say what is actually going on, or the square is unreadable. "Right now"
    // is the founder's own framing of gray — not active RIGHT NOW, rather than finished.
    expect(epicHealthLabel("gray")).toMatch(/nobody is working/i);
    expect(epicHealthLabel("gray")).toMatch(/right now/i);
    // Blue's words have to name the question, or the square says the same thing gray does.
    expect(epicHealthLabel("blue")).toMatch(/question/i);
    // Orange's words have to be true of the FLEET — both halves of it, or the square lies about
    // which one you are looking at.
    expect(epicHealthLabel("orange")).toMatch(/need you/i);
    expect(epicHealthLabel("orange")).toMatch(/still working/i);
  });
});

describe("rungForEpicHealth — where a LIVE FLEET puts an epic", () => {
  // Asserted as PAIRS over all five values, never as "returns something": a table that only checked
  // the function was total would pass with every arm flipped, which is the one failure that matters
  // here — an epic silently filed under Blocked is an epic the founder is told a human must unstick.
  it("maps all five marks to the founder's stated rungs, one assertion per pair", () => {
    const expected: Record<EpicHealth, "blocked" | "unstaffed" | "inProgress"> = {
      // "If there are Build Agents currently working on an Epic then it should be in the Being
      // Built status."
      green: "inProgress",
      // "should stay in Being Built" — the mixed fleet. The orange SQUARE is what reports the
      // trouble; the rung reports where the work is.
      orange: "inProgress",
      // Waiting on an answer is still live work, and the blue square is what says whose turn it is.
      blue: "inProgress",
      // "if the agents are Red then it would go into blocked."
      red: "blocked",
      // The rung the split created: nothing active, but nothing broken either.
      gray: "unstaffed",
    };
    for (const health of ALL_HEALTHS) {
      expect(rungForEpicHealth(health), health).toBe(expected[health]);
    }
  });

  it("sends an ALL-RED fleet to Blocked — and nothing else there", () => {
    expect(rungForEpicHealth("red")).toBe("blocked");
    const others = ALL_HEALTHS.filter((h) => h !== "red");
    for (const h of others) expect(rungForEpicHealth(h), h).not.toBe("blocked");
  });

  it("sends a fleet-less epic to Build: Unstaffed — NOT to Blocked", () => {
    // The split is what lets these two separate. Before it, "nothing is active on this" had to
    // borrow Blocked, which said a human was required when in fact nobody had ever been assigned.
    // Note the two words: `"gray"` in (a colour), `"unstaffed"` out (a rung).
    expect(rungForEpicHealth("gray")).toBe("unstaffed");
    expect(rungForEpicHealth("gray")).not.toBe("blocked");
  });

  it("never returns a terminal rung, whatever it is handed", () => {
    // The narrow return type is a compile-time guarantee; this is the runtime half of it, because a
    // fleet reading must never be able to un-ship a shipped epic.
    const rungs = ALL_HEALTHS.map(rungForEpicHealth);
    expect(new Set(rungs)).toEqual(new Set(["inProgress", "blocked", "unstaffed"]));
  });

  it("agrees with epicHealth end-to-end: a mixed fleet lands in Build: Active", () => {
    // The two functions composed, which is how the column will call them — a table test over
    // hand-written EpicHealth values cannot catch the fold and the rung disagreeing.
    expect(rungForEpicHealth(epicHealth([agent("a", "red"), agent("b", "green")]))).toBe(
      "inProgress",
    );
    expect(rungForEpicHealth(epicHealth([agent("a", "red")]))).toBe("blocked");
    expect(rungForEpicHealth(epicHealth([]))).toBe("unstaffed");
  });
});
