// The epics column's one gesture, as arithmetic: click an epic, and which orchestrators survive.
//
// These assert the SIDE EFFECT — which agent ids come back — never that a store field was written.
// "The selection was recorded" is a precondition; the thing the founder asked for is that the build
// column beside it narrows, and that is a statement about a set of agents.
import { describe, expect, it } from "vitest";
import { agentIdsInEpic, beadIdsInEpic, type EpicFocusAgent } from "./epicFocus";
import type { Bead } from "../services/beads";

/** A bead with only the fields this rule reads. The dotted ids are bd's DISPLAY form of the
 *  parent-child edge, and `childrenOf` matches on both that and an explicit `parent`, so the
 *  fixture carries both shapes deliberately — a test built from one alone would pass for a rule
 *  that only understood the other. */
function bead(id: string, over: Partial<Bead> = {}): Bead {
  return {
    id,
    title: id,
    status: "open",
    labels: [],
    ...over,
  } as Bead;
}

const BEADS: Bead[] = [
  bead("sparkle-epic"),
  bead("sparkle-epic.1"), // dotted child
  bead("sparkle-epic.2"),
  bead("sparkle-epic.2.a"), // dotted GRANDchild
  bead("sparkle-edge", { parent: "sparkle-epic" }), // explicit parent edge, undotted id
  bead("sparkle-other"), // a different epic entirely
  bead("sparkle-other.1"),
];

describe("beadIdsInEpic", () => {
  it("includes the epic's OWN id, not only its descendants", () => {
    // The case a descendants-only set silently drops. An orchestrator pointed straight at the epic
    // bead is the most direct possible match, and it would have been the one row the filter hid.
    expect(beadIdsInEpic(BEADS, "sparkle-epic").has("sparkle-epic")).toBe(true);
  });

  it("takes descendants by BOTH the dotted id and an explicit parent edge", () => {
    const ids = beadIdsInEpic(BEADS, "sparkle-epic");
    expect(ids.has("sparkle-epic.1")).toBe(true);
    expect(ids.has("sparkle-epic.2.a")).toBe(true); // any depth, per the dotted prefix
    expect(ids.has("sparkle-edge")).toBe(true); // no dot in the id at all
  });

  it("does NOT reach into a different epic", () => {
    const ids = beadIdsInEpic(BEADS, "sparkle-epic");
    expect(ids.has("sparkle-other")).toBe(false);
    expect(ids.has("sparkle-other.1")).toBe(false);
  });

  it("does not confuse a SIBLING whose id merely shares a prefix", () => {
    // `sparkle-epic` and `sparkle-epicother` share a string prefix but not a dotted one. Matching on
    // a bare `startsWith(id)` rather than `startsWith(id + ".")` would pull the sibling in.
    const withSibling = [...BEADS, bead("sparkle-epicother"), bead("sparkle-epicother.1")];
    const ids = beadIdsInEpic(withSibling, "sparkle-epic");
    expect(ids.has("sparkle-epicother")).toBe(false);
    expect(ids.has("sparkle-epicother.1")).toBe(false);
  });
});

describe("agentIdsInEpic — null is NOT an empty set", () => {
  const agents: EpicFocusAgent[] = [
    { id: "head-in", beadId: "sparkle-epic.1" },
    { id: "head-out", beadId: "sparkle-other.1" },
  ];

  it("returns null when NO epic is selected, which renders everything", () => {
    // THE DEFAULT STATE OF THE APP. Nothing is selected on launch, so collapsing `null` onto an
    // empty set would empty the build column for every user on every start — the filter would be
    // "working" and the product would be broken.
    expect(agentIdsInEpic(agents, BEADS, null)).toBeNull();
  });

  it("returns an EMPTY set for an epic nothing is working, which renders nothing", () => {
    const got = agentIdsInEpic(agents, BEADS, "sparkle-epic.2");
    expect(got).not.toBeNull();
    expect(got!.size).toBe(0);
  });
});

describe("agentIdsInEpic — the narrowing itself", () => {
  it("keeps the agent on the epic and DROPS the unrelated one", () => {
    // THE ASSERTION THAT HAS POWER, and the reason both agents are in the fixture: a test that only
    // checked the related agent survives would pass for a rule that kept everything. The claim is a
    // PARTITION, so both sides have to be present in the same call.
    const agents: EpicFocusAgent[] = [
      { id: "related", beadId: "sparkle-epic.1" },
      { id: "unrelated", beadId: "sparkle-other.1" },
    ];
    const got = agentIdsInEpic(agents, BEADS, "sparkle-epic")!;
    expect(got.has("related")).toBe(true);
    expect(got.has("unrelated")).toBe(false);
  });

  it("keeps an orchestrator with NO bead of its own when a WORKER under it is on the epic", () => {
    // The normal shape of a fan-out: the head carries no `beadId` and its workers each carry one.
    // Narrowing on the head's own bead alone hides exactly the orchestrators with the most work
    // under them — the ones the founder is looking for.
    const agents: EpicFocusAgent[] = [
      { id: "head" }, // no beadId at all
      { id: "worker", parentId: "head", beadId: "sparkle-epic.2" },
      { id: "other-head" },
      { id: "other-worker", parentId: "other-head", beadId: "sparkle-other.1" },
    ];
    const got = agentIdsInEpic(agents, BEADS, "sparkle-epic")!;
    expect(got.has("head")).toBe(true);
    expect(got.has("worker")).toBe(true);
    // …and the head whose worker is on a DIFFERENT epic is still dropped, which is what makes the
    // assertion above about the epic rather than about having any worker at all.
    expect(got.has("other-head")).toBe(false);
    expect(got.has("other-worker")).toBe(false);
  });

  it("lifts through MORE THAN ONE level of parent", () => {
    const agents: EpicFocusAgent[] = [
      { id: "head" },
      { id: "mid", parentId: "head" },
      { id: "leaf", parentId: "mid", beadId: "sparkle-epic.2.a" },
    ];
    const got = agentIdsInEpic(agents, BEADS, "sparkle-epic")!;
    expect(got.has("head")).toBe(true);
    expect(got.has("mid")).toBe(true);
    expect(got.has("leaf")).toBe(true);
  });

  it("terminates on a corrupt parent CYCLE instead of hanging the render", () => {
    // Not hypothetical enough to skip: this runs inside a render, so an infinite walk is a frozen
    // app rather than a wrong answer. A cycle cannot be reached through the normal spawn path, but
    // nothing in the type system forbids one.
    const agents: EpicFocusAgent[] = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a", beadId: "sparkle-epic" },
    ];
    const got = agentIdsInEpic(agents, BEADS, "sparkle-epic")!;
    expect(got.has("b")).toBe(true);
    expect(got.has("a")).toBe(true);
  });

  it("ignores an agent whose beadId names a bead that does not exist", () => {
    const agents: EpicFocusAgent[] = [{ id: "ghost", beadId: "sparkle-deleted.9" }];
    expect(agentIdsInEpic(agents, BEADS, "sparkle-epic")!.size).toBe(0);
  });
});
