// A TASK-LEVEL orchestrator's rung on the ladder (bead sparkle-o05vcs.5).
//
// The decision this pins is written up in `docs/orchestrators-per-task.md`: ONE orchestrator per
// task bead, with disjoint file sets staying a WORKER-level axis. That decision is only auditable
// if the roster can answer "how many orchestrators are on this task, and under which epic" — and
// until this change it could not, for the one handoff shape that actually produces a task-level
// orchestrator.
//
// `sendToBuild` in "task" mode writes a TASK id into `AgentTab.epicId` (PRD/epic-linkage-at-spawn.md
// records it as a known defect). `epicIdForAgent` returned that field verbatim, so an orchestrator
// building `e1.t1` laddered to `e1.t1` — an id no caller ever queries, since `agentsLadderingTo` is
// called with EPIC ids. The agent was therefore absent from its epic's ladder entirely.
import { describe, it, expect } from "vitest";

import { agentsLadderingTo, epicIdForAgent, type LadderAgent } from "./epicLadder";
import type { Bead } from "./beads";

const bead = (over: Partial<Bead> & { id: string }): Bead => ({
  title: over.id,
  description: "",
  status: "open",
  labels: [],
  ...over,
});

/** Same shape as `epicLadder.test.ts`'s fixture: an epic with a plain task child AND a sub-epic
 *  child, so the rung that must NOT move is mounted alongside the one that must. */
const BEADS: Bead[] = [
  bead({ id: "e1", type: "epic" }),
  bead({ id: "e1.t1", parent: "e1" }),
  bead({ id: "e1.sub", type: "epic", parent: "e1" }),
  bead({ id: "e1.sub.t2", parent: "e1.sub" }),
  bead({ id: "loose" }),
];

/** What `sendToBuild.prepareHandoff` stamps in `mode: "task"` — the SAME id in both fields, and
 *  that id is a task, not an epic. */
const taskOrchestrator = (id: string, taskId: string): LadderAgent => ({
  id,
  epicId: taskId,
  beadId: taskId,
});

describe("a task-level orchestrator ladders to its parent EPIC, not to its own task", () => {
  it("resolves epicId through the bead when that id names a TASK", () => {
    expect(epicIdForAgent(taskOrchestrator("o", "e1.t1"), BEADS)).toBe("e1");
  });

  it("puts it in the epic's ladder — the side effect, which was previously empty", () => {
    const roster = [taskOrchestrator("o-task", "e1.t1")];
    expect(agentsLadderingTo(roster, BEADS, "e1").map((a) => a.id)).toEqual(["o-task"]);
    // PAIRED with the assertion above: it is not attributed to BOTH rungs. Querying the task id
    // itself now returns nothing, which is correct — a task is not a rung on the epic ladder.
    expect(agentsLadderingTo(roster, BEADS, "e1.t1")).toEqual([]);
  });

  it("makes the orchestrator COUNT on one task readable — the decision's audit surface", () => {
    // The decision is one orchestrator per task. `prepareHandoff` enforces it by reuse, but a
    // violation arriving by any other route must be VISIBLE rather than silently split across two
    // ids nobody queries. Two agents bound to the same task both surface under the same epic.
    const roster = [taskOrchestrator("o-a", "e1.t1"), taskOrchestrator("o-b", "e1.t1")];
    expect(agentsLadderingTo(roster, BEADS, "e1").map((a) => a.id)).toEqual(["o-a", "o-b"]);
  });

  it("does NOT move a rung an epic-mode orchestrator was already on", () => {
    // The nested case `epicLadder.ts` reads epicId first FOR. A sub-epic's orchestrator ladders to
    // the sub-epic; walking to a parent epic here would be the regression this change could cause.
    expect(epicIdForAgent(taskOrchestrator("o", "e1.sub"), BEADS)).toBe("e1.sub");
    expect(epicIdForAgent({ id: "o", epicId: "e1" }, BEADS)).toBe("e1");
    expect(agentsLadderingTo([taskOrchestrator("o", "e1.sub")], BEADS, "e1")).toEqual([]);
  });

  it("keeps an epicId the snapshot does not know, rather than dropping the agent", () => {
    // The board polls; a freshly-filed bead can be named by an agent before it is in the snapshot.
    // Answering null there would make the agent vanish from its epic on a partial read, which is a
    // worse failure than trusting the field it was explicitly stamped with.
    expect(epicIdForAgent({ id: "o", epicId: "not-in-snapshot" }, BEADS)).toBe("not-in-snapshot");
  });

  it("a task-level orchestrator on a PARENTLESS task ladders nowhere", () => {
    expect(epicIdForAgent(taskOrchestrator("o", "loose"), BEADS)).toBeNull();
  });
});
