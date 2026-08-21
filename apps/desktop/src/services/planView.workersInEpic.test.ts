// WHO IS BUILDING THIS EPIC — item 25 of the 2026-08-20 self-interview, bead `sparkle-huw924.6`.
//
// The founder, looking at an epic card that said nine-of-nine:
//   [18:18] "That there are, I don't know what, nine build agents. Is that what it means? But I
//            don't see any build agents."
//   [18:26] "it should be showing any build agent that's working on any bead that is part of the
//            card."
//
// ══ THE ASSERTION THAT MATTERS ═════════════════════════════════════════════════════════════════
// The bug was not "no workers were rendered". It was that the card asked
// `workersForBead(agents, epic.id)` — workers bound to the EPIC'S OWN bead — while every worker is
// dispatched against a CHILD. So a test that seeds a worker on the epic's own id would have passed
// against the broken code. The discriminating case is a worker on a CHILD bead, and it is the
// first one below.
import { describe, expect, it } from "vitest";
import { workersForBead, workersInEpic } from "./planView";
import type { Bead } from "./beads";
import type { AgentTab } from "../types";

type A = Pick<AgentTab, "name" | "kind" | "beadId">;

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, description: "", status: "open", labels: [], ...over } as Bead;
}
function worker(name: string, beadId: string | null): A {
  return { name, kind: "worker", beadId } as A;
}

const EPIC = "sparkle-huw924";
// Both membership forms, because `childrenOf` treats them as ONE edge: a dotted id derived from
// the parent, and a flat id carrying an explicit `parent`. A hand-rolled filter misses one.
const CHILD_DOTTED = bead(`${EPIC}.1`);
const CHILD_FLAT = bead("sparkle-flat1", { parent: EPIC });
const STRANGER = bead("sparkle-other", { parent: "sparkle-different-epic" });
const BEADS: Bead[] = [bead(EPIC, { type: "epic" }), CHILD_DOTTED, CHILD_FLAT, STRANGER];

describe("workersInEpic — every worker inside the epic, not just the epic's own bead", () => {
  it("FINDS A WORKER ON A CHILD, which is the whole defect", () => {
    const agents = [worker("nightwatch-1", CHILD_DOTTED.id)];

    // THE OLD QUESTION, asserted alongside so the difference is the test rather than a claim in a
    // comment. This is what the card used to ask, and it is empty — the founder's blank space.
    expect(workersForBead(agents, EPIC)).toEqual([]);
    // THE NEW ONE.
    expect(workersInEpic(agents, BEADS, EPIC)).toEqual(["nightwatch-1"]);
  });

  it("counts the reparented (flat-id) form of membership too", () => {
    const agents = [worker("nightwatch-2", CHILD_FLAT.id)];
    expect(workersInEpic(agents, BEADS, EPIC)).toEqual(["nightwatch-2"]);
  });

  it("still counts a worker bound to the epic's own bead", () => {
    const agents = [worker("on-the-epic", EPIC)];
    expect(workersInEpic(agents, BEADS, EPIC)).toEqual(["on-the-epic"]);
  });

  it("EXCLUDES a worker on another epic's child — mounted in the same agent list", () => {
    // Both candidates present at once. Seeding only the stranger and asserting an empty result
    // would pass for a resolver that returns nothing at all.
    const agents = [worker("mine", CHILD_DOTTED.id), worker("theirs", STRANGER.id)];
    const got = workersInEpic(agents, BEADS, EPIC);
    expect(got).toContain("mine");
    expect(got).not.toContain("theirs");
  });

  it("excludes non-worker agents bound to a child, and unbound agents", () => {
    const agents: A[] = [
      { name: "an-orchestrator", kind: "build", beadId: CHILD_DOTTED.id } as A,
      worker("unbound", null),
      worker("real", CHILD_DOTTED.id),
    ];
    expect(workersInEpic(agents, BEADS, EPIC)).toEqual(["real"]);
  });

  it("dedupes by name and keeps the agents array's order stable across polls", () => {
    const agents = [
      worker("b-worker", CHILD_DOTTED.id),
      worker("a-worker", CHILD_FLAT.id),
      worker("b-worker", CHILD_FLAT.id),
    ];
    // Order follows `agents`, NOT the bead list and NOT alphabetical — a line that reshuffles
    // between 5s polls is its own defect.
    expect(workersInEpic(agents, BEADS, EPIC)).toEqual(["b-worker", "a-worker"]);
  });

  it("returns nothing for an epic with no children and no workers", () => {
    expect(workersInEpic([], BEADS, EPIC)).toEqual([]);
  });
});
