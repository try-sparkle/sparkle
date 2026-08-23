import { describe, expect, it, vi } from "vitest";

import { beadLineageOf, inActiveBuild, packPills } from "./beadLineage";
import type { Bead } from "../services/beads";

// COUNTS the resolver's calls WITHOUT changing what it does — the real `agentIdsInEpic` still runs
// and still returns its real answer, so every other test in this file is unaffected. A plain
// `vi.fn()` stub would have had to re-implement membership, which is the one thing this module is
// forbidden from re-deriving (`scripts/lib/epic-membership-guard.sh`).
const resolverCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("./epicFocus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./epicFocus")>();
  return {
    ...actual,
    agentIdsInEpic: (...args: Parameters<typeof actual.agentIdsInEpic>) => {
      resolverCalls.n++;
      return actual.agentIdsInEpic(...args);
    },
  };
});

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return {
    id,
    title: `title ${id}`,
    description: "",
    status: "open",
    labels: [],
    ...over,
  };
}

function worker(id: string, name: string, beadId: string | undefined) {
  return { id, name, kind: "worker" as const, beadId, parentId: null };
}

function head(id: string, name: string, beadId: string | undefined) {
  return { id, name, kind: "build" as const, beadId, parentId: null };
}

describe("beadLineageOf", () => {
  // FLAT `parent` EDGES, not dotted ids, and the choice is load-bearing. `childrenOf` treats the
  // two forms differently — it walks ANY DEPTH for a dotted id (so `a.1.1` is a "child" of `a`) but
  // exactly ONE LEVEL for a reparented flat id. The Tasks row is about direct children, so the flat
  // form is the one that states the claim unambiguously. The dotted asymmetry is `services/beads.ts`
  // to own, not something to re-derive or work around here.
  const epic = bead("sparkle-epic", { type: "epic" });
  const kidA = bead("", { parent: "sparkle-epic" });
  const kidB = bead("", { parent: "sparkle-epic" });
  const grandkid = bead("", { parent: "" });
  const loner = bead("sparkle-solo");
  const beads = [epic, kidA, kidB, grandkid, loner];

  const lineage = (b: Bead, agents: Parameters<typeof beadLineageOf>[0]["agents"] = []) =>
    beadLineageOf({ beads, bead: b, agents, projectId: "proj-7" });

  it("names the children as pills carrying their TITLE, not their id", () => {
    // The founder asked for "the name of each task as a pill" — an id-labelled pill would be a
    // regression to the bare-handle rendering he rejected.
    expect(lineage(epic).tasks).toEqual([
      { id: "", label: "title " },
      { id: "", label: "title " },
    ]);
  });

  it("falls back to the id when a child has no title", () => {
    const parentEpic = bead("", { type: "epic" });
    const untitled = bead("", { title: "", parent: "" });
    const l = beadLineageOf({
      beads: [parentEpic, untitled],
      bead: parentEpic,
      agents: [],
      projectId: "p",
    });
    expect(l.tasks).toEqual([{ id: "", label: "" }]);
  });

  it("lists DIRECT children only on the Tasks row — the grandchild belongs to its own parent", () => {
    // The epic's row above shows two tasks, not three: `` is a task of ``.
    expect(lineage(epic).tasks.map((t) => t.id)).not.toContain("");
    expect(lineage(kidB).tasks.map((t) => t.id)).toEqual([""]);
  });

  it("resolves the parent epic for a child, and null for a bead with no parent", () => {
    expect(lineage(kidA).parent?.id).toBe("sparkle-epic");
    expect(lineage(loner).parent).toBeNull();
  });

  it("unions build agents across the CHILDREN, which is where workers actually bind", () => {
    const agents = [worker("ag-1", "Alpha", ""), worker("ag-2", "Beta", "")];
    // Neither worker is bound to the EPIC's own id. Asking only about `epic.id` — the bug this
    // union exists to prevent — returns an empty row on exactly the epic with work in flight.
    expect(lineage(epic, agents).buildAgents).toEqual([
      { id: "ag-1", label: "Alpha", projectId: "proj-7" },
      { id: "ag-2", label: "Beta", projectId: "proj-7" },
    ]);
  });

  it("includes an ORCHESTRATOR, not just workers — he said 'build agents', the Build column's word", () => {
    // A worker-only rule renders a head that has not yet spawned anyone on NO card at all, while it
    // still survives the build column's filter. That contradiction is what one resolver removes.
    expect(lineage(epic, [head("ag-9", "Orchestrator", "sparkle-epic")]).buildAgents.map((a) => a.id)).toEqual([
      "ag-9",
    ]);
  });

  it("reaches a worker on a GRANDCHILD — membership is transitive, not one level", () => {
    // `childrenOfIndexed` stops at one level, so a reparented grandchild used to be silently
    // missing from its epic's card while the column still showed it.
    expect(lineage(epic, [worker("ag-3", "Deep", "")]).buildAgents.map((a) => a.id)).toEqual(
      ["ag-3"],
    );
  });

  it("counts one head PLUS its two workers — three pills, and the Build column would draw ONE row", () => {
    // THE ASYMMETRY IS DELIBERATE and this test is what states it. `AgentSidebar` narrows to
    // `topLevelOf(...)` BEFORE intersecting with `agentIdsInEpic`, and `isTopLevelAgent` excludes
    // `kind === "worker"`, so the column draws the head alone. The card shows all three, because
    // the founder asked to see them: *"maybe I can't see the exact relationship between each child
    // task and its specific build agents, but I can see basically all of them."* Narrowing this row
    // to heads to make the two numbers match would hide the agents he named.
    const agents = [
      { id: "ag-head", name: "Head", kind: "build" as const, beadId: undefined, parentId: null },
      { id: "ag-w1", name: "Worker One", kind: "worker" as const, beadId: "", parentId: "ag-head" },
      { id: "ag-w2", name: "Worker Two", kind: "worker" as const, beadId: "", parentId: "ag-head" },
    ];
    const pills = lineage(epic, agents).buildAgents;
    expect(pills.map((p) => p.id)).toEqual(["ag-head", "ag-w1", "ag-w2"]);
    expect(pills).toHaveLength(3);
  });

  it("lifts a worker's HEAD onto the row, so the orchestrator is not the one row hidden", () => {
    const agents = [
      { id: "ag-head", name: "Head", kind: "build" as const, beadId: undefined, parentId: null },
      { id: "ag-kid", name: "Kid", kind: "worker" as const, beadId: "", parentId: "ag-head" },
    ];
    expect(lineage(epic, agents).buildAgents.map((a) => a.id).sort()).toEqual(["ag-head", "ag-kid"]);
  });

  it("narrows on a TASK id too — the resolver seeds with whatever id it is handed", () => {
    const agents = [worker("ag-1", "Alpha", ""), worker("ag-2", "Beta", "")];
    // A card for a single task must show that task's agents, not its epic's.
    expect(lineage(kidA, agents).buildAgents.map((a) => a.id)).toEqual(["ag-1"]);
  });

  it("keeps two agents that SHARE a display name — they are distinct rows", () => {
    // Merging on name would silently drop one of the founder's build agents from a row whose whole
    // purpose is "I can see basically all of them".
    const agents = [worker("ag-1", "Claude", ""), worker("ag-2", "Claude", "")];
    expect(lineage(epic, agents).buildAgents.map((a) => a.id)).toEqual(["ag-1", "ag-2"]);
  });

  it("drops the same agent listed twice — one id is one pill", () => {
    // The id is the rendered pill's React `key` (`BeadCard/BeadLineageRows`) AND what feeds the
    // count `inActiveBuild` gates the row on, so a roster carrying a duplicate would draw two
    // same-keyed pills and double the number. A roster CAN carry one: it is assembled from a poll.
    const dupe = worker("ag-1", "Alpha", "");
    expect(lineage(epic, [dupe, dupe]).buildAgents).toEqual([
      { id: "ag-1", label: "Alpha", projectId: "proj-7" },
    ]);
  });

  it("excludes an agent bound OUTSIDE the epic, and one bound to nothing", () => {
    const agents = [worker("ag-8", "Elsewhere", "sparkle-solo"), worker("ag-7", "Unbound", undefined)];
    expect(lineage(epic, agents).buildAgents).toEqual([]);
  });

  it("orders pills by the ROSTER, not by the resolver's set-insertion order", () => {
    // THE FIXTURE IS THE TEST. `agentIdsInEpic` builds its Set by iterating the roster, so for any
    // roster of directly-bound agents the set order and the roster order are ALREADY identical and
    // iterating either one passes — which is what made the previous version of this test vacuous.
    // A HEAD-LIFT is the shape where they diverge: the worker matches directly in the first pass
    // and its head is only lifted in a SECOND, so the set's insertion order is
    // ["ag-kid", "ag-head"] — the reverse of the roster.
    const agents = [
      { id: "ag-head", name: "Head", kind: "build" as const, beadId: undefined, parentId: null },
      { id: "ag-kid", name: "Kid", kind: "worker" as const, beadId: "", parentId: "ag-head" },
    ];
    // NOT sorted — a `.sort()` here is exactly what erased the property this pins.
    expect(lineage(epic, agents).buildAgents.map((p) => p.id)).toEqual(["ag-head", "ag-kid"]);
  });

  it("resolves membership ONCE per snapshot, so a re-render is not a second store walk", () => {
    // `agentIdsInEpic` composes the UNCACHED `descendantsOf` — three O(n) passes over the whole
    // store per call — and this module is called once per card render, on every 5s poll. Delete the
    // memo and this goes to 2.
    const agents = [worker("ag-1", "Alpha", "")];
    const before = resolverCalls.n;
    const first = beadLineageOf({ beads, bead: epic, agents, projectId: "proj-7" });
    const second = beadLineageOf({ beads, bead: epic, agents, projectId: "proj-7" });
    expect(resolverCalls.n - before).toBe(1);
    expect(second.buildAgents).toEqual(first.buildAgents);
  });

  it("re-resolves when the roster is mutated IN PLACE and its length changes", () => {
    // The memo is keyed on ARRAY IDENTITY, which a `push` does not change — the same staleness hole
    // `epicIndexOf` documents. The stored length is what closes the half of it that is cheap to
    // catch; without that guard the second assertion below still reads ["ag-1"].
    const agents = [worker("ag-1", "Alpha", "")];
    expect(lineage(epic, agents).buildAgents.map((p) => p.id)).toEqual(["ag-1"]);
    agents.push(worker("ag-2", "Beta", ""));
    expect(lineage(epic, agents).buildAgents.map((p) => p.id)).toEqual(["ag-1", "ag-2"]);
  });

  it("reads the LABEL off the roster on every call, so a rename is never served stale", () => {
    // Only MEMBERSHIP is memoised. A renamed agent keeps its id, so the cached set still hits —
    // and the pill must still read the new name, which it can only do by taking the label from the
    // roster inside the loop rather than from anything cached.
    const agents = [worker("ag-1", "Alpha", "")];
    expect(lineage(epic, agents).buildAgents[0]?.label).toBe("Alpha");
    agents[0] = worker("ag-1", "Renamed", "");
    expect(lineage(epic, agents).buildAgents[0]?.label).toBe("Renamed");
  });

  it("gates the Build agents row on there being agents to show", () => {
    expect(inActiveBuild({ buildAgents: [] })).toBe(false);
    expect(inActiveBuild({ buildAgents: [{ id: "a", label: "A" }] })).toBe(true);
  });
});

describe("packPills", () => {
  const more = (n: number) => 60 + String(n).length * 6;

  it("shows everything and NO overflow when the row has room", () => {
    expect(packPills([50, 50], 200, more, 6)).toEqual({ shown: 2, overflow: 0 });
  });

  it("uses the whole width when nothing overflows — the '+N more' costs nothing then", () => {
    // 50 + 6 + 50 = 106. Exactly 106 available must still fit all, with no room reserved for an
    // affordance that will not be drawn.
    expect(packPills([50, 50], 106, more, 6)).toEqual({ shown: 2, overflow: 0 });
  });

  it("drops pills until the remainder plus its '+N more' fits", () => {
    // 3 pills of 50, gap 6, width 160. All three need 172 — too wide.
    // k=2: 50 + 6 + 50 = 106, plus gap 6 plus more(1)=66 => 178 > 160. No.
    // k=1: 50, plus gap 6 plus more(2)=66 => 122 <= 160. Yes.
    expect(packPills([50, 50, 50], 160, more, 6)).toEqual({ shown: 1, overflow: 2 });
  });

  it("keeps EVERY pill that fits beside the overflow — the founder's own 'two, then +N more'", () => {
    // *"If there's only space for two, that's fine. And it shows two pills basically. Then it says
    // plus seven more."* Five pills of 50 in 200px: two fit alongside "+3 more" (106 + 6 + 66 =
    // 178), a third does not (234). Without this the packer could stop at ONE pill on every
    // overflowing row and no test would notice — the row would still LOOK plausible.
    expect(packPills([50, 50, 50, 50, 50], 200, more, 6)).toEqual({ shown: 2, overflow: 3 });
  });

  it("charges the WIDER '+N more' when the count has more digits", () => {
    const widths = Array.from({ length: 30 }, () => 50);
    const packed = packPills(widths, 200, more, 6);
    // more(29) is 72, not 66 — rounding that away is what makes the row wrap.
    expect(packed.shown + packed.overflow).toBe(30);
    expect(50 + 6 + more(packed.overflow)).toBeLessThanOrEqual(200);
  });

  it("still shows ONE pill when not even one fits, rather than a bare '+N more'", () => {
    // A row reading "Tasks: +9 more" withholds the names, which is the thing he asked for.
    expect(packPills([500, 500], 40, more, 6)).toEqual({ shown: 1, overflow: 1 });
  });

  it("renders no row at all for an empty list", () => {
    expect(packPills([], 300, more, 6)).toEqual({ shown: 0, overflow: 0 });
  });
});
