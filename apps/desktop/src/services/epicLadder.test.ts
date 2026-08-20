import { describe, it, expect } from "vitest";

import {
  agentsForEpicSlices,
  agentsLadderingTo,
  epicIdForAgent,
  type LadderAgent,
} from "./epicLadder";
import type { Bead } from "./beads";

const bead = (over: Partial<Bead> & { id: string }): Bead => ({
  title: over.id,
  description: "",
  status: "open",
  labels: [],
  ...over,
});

/** An epic with two children, one of them itself an epic with a child — so the nested case that
 *  makes the read ORDER load-bearing is actually mounted, not merely described. */
const BEADS: Bead[] = [
  bead({ id: "e1", type: "epic" }),
  bead({ id: "e1.t1", parent: "e1" }),
  bead({ id: "e1.sub", type: "epic", parent: "e1" }),
  bead({ id: "e1.sub.t2", parent: "e1.sub" }),
  bead({ id: "loose" }),
];

describe("epicIdForAgent", () => {
  it("reads a build agent's epicId directly", () => {
    expect(epicIdForAgent({ id: "a", epicId: "e1" }, BEADS)).toBe("e1");
  });

  it("resolves a worker's bead to its parent epic", () => {
    expect(epicIdForAgent({ id: "w", beadId: "e1.t1" }, BEADS)).toBe("e1");
  });

  it("PREFERS epicId over beadId — an orchestrator carries BOTH, and the nested case diverges", () => {
    // `prepareHandoff` stamps the same bead as epicId AND beadId on an orchestrator. Reading beadId
    // first would ask parentEpicOf about an EPIC, which answers e1 — attributing the sub-epic's
    // orchestrator to its parent. The two answers must differ here or this test proves nothing.
    const orchestrator: LadderAgent = { id: "o", epicId: "e1.sub", beadId: "e1.sub" };
    expect(epicIdForAgent(orchestrator, BEADS)).toBe("e1.sub");
    expect(epicIdForAgent({ id: "o", beadId: "e1.sub" }, BEADS)).toBe("e1.sub");
  });

  it("a worker whose OWN bead is an epic ladders to that epic, not a rung higher", () => {
    expect(epicIdForAgent({ id: "w", beadId: "e1.sub" }, BEADS)).toBe("e1.sub");
  });

  it("is null for an agent with neither field, an unknown bead, or a parentless one", () => {
    expect(epicIdForAgent({ id: "a" }, BEADS)).toBeNull();
    expect(epicIdForAgent({ id: "a", beadId: "nope" }, BEADS)).toBeNull();
    expect(epicIdForAgent({ id: "a", beadId: "loose" }, BEADS)).toBeNull();
  });
});

describe("agentsLadderingTo — the epic's own view of what is outstanding against it", () => {
  it("returns both routes into the same epic, and excludes everyone else", () => {
    const roster: LadderAgent[] = [
      { id: "orch", epicId: "e1" },
      { id: "w1", beadId: "e1.t1" },
      { id: "sub", epicId: "e1.sub" },
      { id: "idle" },
    ];
    expect(agentsLadderingTo(roster, BEADS, "e1").map((a) => a.id)).toEqual(["orch", "w1"]);
    expect(agentsLadderingTo(roster, BEADS, "e1.sub").map((a) => a.id)).toEqual(["sub"]);
  });

  it("is empty for an epic nobody is working", () => {
    expect(agentsLadderingTo([{ id: "a", epicId: "other" }], BEADS, "e1")).toEqual([]);
  });
});

describe("agentsForEpicSlices — the rollup's list, which is NOT the laddering list", () => {
  /** The shape `sendToBuild.prepareHandoff` actually stamps: the epic id in BOTH fields. */
  const orchestrator = (epicId: string): LadderAgent => ({ id: `o-${epicId}`, epicId, beadId: epicId });

  it("KEEPS a sub-epic's orchestrator, which agentsLadderingTo correctly drops", () => {
    // roborev 65856, and this is the whole point of the second function. The rollup walks e1's
    // child beads and asks "is anybody carrying this slice"; for the child that IS e1.sub, the
    // answer is an agent laddering to e1.sub — precisely the one the laddering filter removes. Both
    // calls are made here on the same roster so the difference is the assertion, not a description.
    const roster = [orchestrator("e1"), { id: "w1", beadId: "e1.t1" }, orchestrator("e1.sub")];
    expect(agentsLadderingTo(roster, BEADS, "e1").map((a) => a.id)).toEqual(["o-e1", "w1"]);
    expect(agentsForEpicSlices(roster, BEADS, "e1").map((a) => a.id)).toEqual([
      "o-e1",
      "w1",
      "o-e1.sub",
    ]);
  });

  it("a WORKER deep under a sub-epic still counts as carrying that sub-epic slice", () => {
    // Deliberate, and worth stating because the instinct is to call it too wide. e1.sub.t2's worker
    // resolves to e1.sub, which IS one of e1's child beads — i.e. one of the slices this list
    // exists to attribute. So from e1's point of view somebody IS carrying the e1.sub slice, which
    // is true: retiring that sub-epic's orchestrator while a worker under it keeps going does not
    // make the slice unowned. Reporting it `stranded` there would be the false alarm again.
    const roster = [{ id: "deep", beadId: "e1.sub.t2" }];
    expect(agentsForEpicSlices(roster, BEADS, "e1").map((a) => a.id)).toEqual(["deep"]);
    expect(agentsForEpicSlices(roster, BEADS, "e1.sub").map((a) => a.id)).toEqual(["deep"]);
    // …and it is still NOT part of e1's laddering list, because its goal ladders to e1.sub.
    expect(agentsLadderingTo(roster, BEADS, "e1")).toEqual([]);
  });

  it("excludes an agent on an unrelated epic", () => {
    expect(agentsForEpicSlices([orchestrator("other")], BEADS, "e1")).toEqual([]);
  });
});
