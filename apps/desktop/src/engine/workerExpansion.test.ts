import { describe, expect, it } from "vitest";
import { attentionWorkersOf } from "./workerExpansion";
import type { AgentKind, AgentTabStatus } from "../types";

interface Node {
  id: string;
  kind: AgentKind;
  parentId: string | null;
}

// THE PEEK'S CONTENT. `attentionWorkersOf` names the workers a CLOSED head should peek for, and it
// is the ONLY thing that decides whether a peek appears at all — the render calls it and shows a line
// iff the result is non-empty. There was briefly a second gate in the component (a per-head "does
// this subtree read needs_you" memo) which could only ever agree with this; while both existed
// neither could be shown to matter, because mutating either left the other masking it and the
// "green never peeks" test passed against both mutants. One mechanism, one thing to test.
const PEEK: Node[] = [
  { id: "p1", kind: "build", parentId: null },
  { id: "w1", kind: "worker", parentId: "p1" },
  { id: "w2", kind: "worker", parentId: "p1" },
  { id: "p2", kind: "build", parentId: null },
  { id: "w3", kind: "worker", parentId: "p2" },
];
const peekIds = (map: Record<string, AgentTabStatus>, head = "p1") =>
  attentionWorkersOf(PEEK, head, (id) => map[id] ?? "stopped", (id) => map[id] !== undefined).map(
    (w) => w.id,
  );

describe("attentionWorkersOf — who the peek names", () => {
  it("names only the red workers under the head asked about", () => {
    expect(peekIds({ w1: "waiting", w2: "working", w3: "errored" })).toEqual(["w1"]);
  });

  it("names every red worker, so the caller can show a COUNT rather than one arbitrary name", () => {
    expect(peekIds({ w1: "waiting", w2: "errored" })).toEqual(["w1", "w2"]);
  });

  // The rule that keeps the peek from becoming a second expansion: a settled fleet peeks NOTHING,
  // however many workers it has.
  it("names nobody when every worker is green or gray", () => {
    expect(peekIds({ w1: "working", w2: "done" })).toEqual([]);
    expect(peekIds({ w1: "idle", w2: "stopped" })).toEqual([]);
  });

  it("ignores a red worker belonging to a DIFFERENT head", () => {
    expect(peekIds({ w3: "errored" })).toEqual([]);
    expect(peekIds({ w3: "errored" }, "p2")).toEqual(["w3"]);
  });

  // Same liveness rule as the snapshot: a synthetic red on a never-live worker would make the peek
  // flicker at the rate of the open/evict race.
  it("does not name a worker with no live status, however red it reads", () => {
    expect(attentionWorkersOf(PEEK, "p1", () => "errored", () => false)).toEqual([]);
  });

  // Every status in the needs_you band peeks, because the shared BAND decides — not a second
  // hand-rolled "is it red" list that could drift from the dots and the filter chips.
  it.each<AgentTabStatus>(["waiting", "approval", "blocked", "errored"])(
    "peeks for a %s worker",
    (st) => {
      expect(peekIds({ w1: st })).toEqual(["w1"]);
    },
  );

  // …and no status outside it does.
  it.each<AgentTabStatus>(["working", "idle", "done", "stopped", "unmerged", "new"])(
    "does not peek for a %s worker",
    (st) => {
      expect(peekIds({ w1: st })).toEqual([]);
    },
  );
});
