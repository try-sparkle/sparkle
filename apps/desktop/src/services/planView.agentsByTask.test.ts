// WHICH AGENT IS ON WHICH TASK — the partition bead sparkle-huw924.10 is about.
//
// The founder: the epic card drew tasks and agents as two unrelated lists, *"so nothing tells you
// WHICH agent is on WHICH task — which is the entire question the card should answer."*
//
// Every assertion below is on the PARTITION ITSELF, never on the input: handing the function a
// roster and asserting the roster came back would stay green with the whole grouping deleted.
import { describe, expect, it } from "vitest";

import { groupEpicAgentsByTask, type EpicAgentPill } from "./planView";

const KID_A = "sparkle-epic.1";
const KID_B = "sparkle-epic.2";
const EPIC = "sparkle-epic";

function pill(id: string, label = id): EpicAgentPill {
  return { id, label, projectId: "p1" };
}

describe("groupEpicAgentsByTask", () => {
  it("files each agent under the TASK its roster row is bound to", () => {
    const out = groupEpicAgentsByTask({
      buildAgents: [pill("ag-a", "alpha"), pill("ag-b", "bravo")],
      agents: [
        { id: "ag-a", beadId: KID_A },
        { id: "ag-b", beadId: KID_B },
      ],
      taskIds: [KID_A, KID_B],
    });

    // THE ATTRIBUTION, not merely "two buckets exist": a grouping that put both agents in one
    // bucket, or swapped them, is exactly the defect this replaces and would pass a count check.
    expect(out.byTask.get(KID_A)?.map((p) => p.label)).toEqual(["alpha"]);
    expect(out.byTask.get(KID_B)?.map((p) => p.label)).toEqual(["bravo"]);
    expect(out.unassigned).toEqual([]);
  });

  it("keeps TWO agents on ONE task in the order they arrived", () => {
    const out = groupEpicAgentsByTask({
      buildAgents: [pill("ag-1", "first"), pill("ag-2", "second")],
      agents: [
        { id: "ag-1", beadId: KID_A },
        { id: "ag-2", beadId: KID_A },
      ],
      taskIds: [KID_A],
    });

    expect(out.byTask.get(KID_A)?.map((p) => p.label)).toEqual(["first", "second"]);
  });

  // ══ THE CONTRACT THAT MATTERS MOST ═══════════════════════════════════════════════════════════
  // The old flat `Build agents:` row NAMED every agent. A partition that silently dropped the
  // unattributable ones would turn the founder's re-ask into a net loss of information — which is
  // the outcome bead sparkle-huw924.10 explicitly forbids ("must NOT silently vanish").
  it("keeps an agent bound to NOTHING — the normal shape for an orchestrator", () => {
    const out = groupEpicAgentsByTask({
      buildAgents: [pill("ag-head", "orchestrator"), pill("ag-w", "worker")],
      agents: [
        { id: "ag-head", beadId: undefined },
        { id: "ag-w", beadId: KID_A },
      ],
      taskIds: [KID_A],
    });

    expect(out.unassigned.map((p) => p.label)).toEqual(["orchestrator"]);
    // …and the attributable one still landed on its task, so this is a PARTITION rather than a
    // function that gave up and put everything in the fallback.
    expect(out.byTask.get(KID_A)?.map((p) => p.label)).toEqual(["worker"]);
  });

  it("keeps an agent bound to the EPIC'S OWN bead, which is no task on this card", () => {
    const out = groupEpicAgentsByTask({
      buildAgents: [pill("ag-e", "on-the-epic")],
      agents: [{ id: "ag-e", beadId: EPIC }],
      taskIds: [KID_A, KID_B],
    });

    expect(out.unassigned.map((p) => p.label)).toEqual(["on-the-epic"]);
    expect(out.byTask.size).toBe(0);
  });

  it("keeps an agent bound to a bead this card does not draw — a grandchild, say", () => {
    const out = groupEpicAgentsByTask({
      buildAgents: [pill("ag-g", "grandchild-worker")],
      agents: [{ id: "ag-g", beadId: `${KID_A}.7` }],
      taskIds: [KID_A],
    });

    expect(out.unassigned.map((p) => p.label)).toEqual(["grandchild-worker"]);
  });

  it("keeps an agent MISSING from the roster entirely", () => {
    // The lineage snapshot and the roster snapshot are two arrays read at two moments; an agent
    // that left the roster between them must still be drawn rather than dropped on the floor.
    const out = groupEpicAgentsByTask({
      buildAgents: [pill("ag-ghost", "ghost")],
      agents: [],
      taskIds: [KID_A],
    });

    expect(out.unassigned.map((p) => p.label)).toEqual(["ghost"]);
  });

  it("LOSES NOTHING — every pill comes out exactly once, across a mixed set", () => {
    const buildAgents = [
      pill("ag-1", "one"),
      pill("ag-2", "two"),
      pill("ag-3", "three"),
      pill("ag-4", "four"),
    ];
    const out = groupEpicAgentsByTask({
      buildAgents,
      agents: [
        { id: "ag-1", beadId: KID_A },
        { id: "ag-2", beadId: KID_B },
        { id: "ag-3", beadId: undefined },
        { id: "ag-4", beadId: KID_A },
      ],
      taskIds: [KID_A, KID_B],
    });

    const drawn = [...[...out.byTask.values()].flat(), ...out.unassigned].map((p) => p.id).sort();
    expect(drawn).toEqual(["ag-1", "ag-2", "ag-3", "ag-4"]);
  });

  it("draws NO bucket for a task nobody is on, rather than an empty one", () => {
    // An empty bucket would make the card render a bare "Build agents:" label under a task with
    // nothing after it — the same empty-row defect `BeadLineageRows` rule 3 forbids.
    const out = groupEpicAgentsByTask({
      buildAgents: [pill("ag-a", "alpha")],
      agents: [{ id: "ag-a", beadId: KID_A }],
      taskIds: [KID_A, KID_B],
    });

    expect(out.byTask.has(KID_B)).toBe(false);
  });
});
