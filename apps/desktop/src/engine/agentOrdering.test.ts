import { describe, it, expect } from "vitest";
import {
  sortAgentsByAttention,
  orderAgents,
  firstVisibleAgentId,
  STATUS_RANK,
} from "./agentOrdering";
import type { AgentKind, AgentTabStatus } from "../types";

// Minimal agent shape — the helper only needs `id`.
const a = (id: string) => ({ id });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("sortAgentsByAttention", () => {
  it("orders tiers top→bottom: waiting/approval, then idle/done, then working, then dormant", () => {
    const agents = [
      a("working1"),
      a("stopped1"),
      a("waiting1"),
      a("idle1"),
      a("approval1"),
      a("errored1"),
      a("done1"),
      a("blocked1"),
    ];
    const status: Record<string, AgentTabStatus> = {
      working1: "working",
      stopped1: "stopped",
      waiting1: "waiting",
      idle1: "idle",
      approval1: "approval",
      errored1: "errored",
      done1: "done",
      blocked1: "blocked",
    };
    const sorted = ids(sortAgentsByAttention(agents, status));
    // Tier 0 (red) first — waiting/approval before everything.
    expect(sorted.slice(0, 2).sort()).toEqual(["approval1", "waiting1"]);
    // Tier 1 next — idle/done.
    expect(sorted.slice(2, 4).sort()).toEqual(["done1", "idle1"]);
    // Tier 2 — working.
    expect(sorted[4]).toBe("working1");
    // Tier 3 (bottom) — blocked/errored/stopped.
    expect(sorted.slice(5).sort()).toEqual(["blocked1", "errored1", "stopped1"]);
  });

  it("is stable within a tier — keeps insertion order for equal-rank agents", () => {
    const agents = [a("w1"), a("w2"), a("w3")];
    const status: Record<string, AgentTabStatus> = {
      w1: "working",
      w2: "working",
      w3: "working",
    };
    expect(ids(sortAgentsByAttention(agents, status))).toEqual(["w1", "w2", "w3"]);
  });

  it("floats a red agent above earlier-inserted working agents", () => {
    const agents = [a("w1"), a("w2"), a("needsYou"), a("w3")];
    const status: Record<string, AgentTabStatus> = {
      w1: "working",
      w2: "working",
      needsYou: "waiting",
      w3: "working",
    };
    const sorted = ids(sortAgentsByAttention(agents, status));
    expect(sorted[0]).toBe("needsYou");
    // The working agents keep their relative order beneath it.
    expect(sorted.slice(1)).toEqual(["w1", "w2", "w3"]);
  });

  it("is a pure reordering — output holds exactly the same ids (selection safety)", () => {
    const agents = [a("x"), a("y"), a("z")];
    const status: Record<string, AgentTabStatus> = { x: "stopped", y: "waiting", z: "working" };
    const sorted = sortAgentsByAttention(agents, status);
    expect(ids(sorted).sort()).toEqual(["x", "y", "z"]);
    expect(sorted).toHaveLength(agents.length);
  });

  it("does not mutate the input array", () => {
    const agents = [a("working1"), a("waiting1")];
    const status: Record<string, AgentTabStatus> = { working1: "working", waiting1: "waiting" };
    const before = ids(agents);
    sortAgentsByAttention(agents, status);
    expect(ids(agents)).toEqual(before);
  });

  it("treats an agent missing from the status map as stopped (bottom tier)", () => {
    const agents = [a("unknown"), a("waiting1")];
    const status: Record<string, AgentTabStatus> = { waiting1: "waiting" };
    expect(ids(sortAgentsByAttention(agents, status))).toEqual(["waiting1", "unknown"]);
  });

  it("sorts an unmapped status to the bottom", () => {
    const agents = [a("weird"), a("working1")];
    // Cast through unknown to simulate a status with no STATUS_RANK entry.
    const status = { weird: "bogus", working1: "working" } as unknown as Record<string, AgentTabStatus>;
    expect(ids(sortAgentsByAttention(agents, status))).toEqual(["working1", "weird"]);
  });

  it("STATUS_RANK encodes the four tiers as ascending ranks", () => {
    expect(STATUS_RANK.waiting).toBe(STATUS_RANK.approval);
    expect(STATUS_RANK.idle).toBe(STATUS_RANK.done);
    expect(STATUS_RANK.waiting).toBeLessThan(STATUS_RANK.idle);
    expect(STATUS_RANK.idle).toBeLessThan(STATUS_RANK.working);
    expect(STATUS_RANK.working).toBeLessThan(STATUS_RANK.stopped);
    expect(STATUS_RANK.stopped).toBe(STATUS_RANK.errored);
    expect(STATUS_RANK.stopped).toBe(STATUS_RANK.blocked);
  });
});

type Row = { id: string; pinnedIndex: number | null };
const mk = (id: string, pinnedIndex: number | null = null): Row => ({ id, pinnedIndex });
const allWorking = (xs: string[]) =>
  Object.fromEntries(xs.map((id) => [id, "working" as AgentTabStatus]));

describe("orderAgents — anchored pins among attention-sorted agents", () => {
  it("anchors a pinned agent at its index; others fill around it", () => {
    const rows = [mk("a"), mk("b", 0), mk("c")];
    expect(orderAgents(rows, allWorking(["a", "b", "c"])).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("honors a middle/bottom anchor", () => {
    const rows = [mk("a"), mk("b"), mk("c", 2)];
    expect(orderAgents(rows, allWorking(["a", "b", "c"])).map((r) => r.id)).toEqual(["a", "b", "c"]);
    const rows2 = [mk("a", 1), mk("b"), mk("c")];
    expect(orderAgents(rows2, allWorking(["a", "b", "c"])).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("multiple pins insert by ascending index", () => {
    const rows = [mk("a", 2), mk("b", 0), mk("c")];
    expect(orderAgents(rows, allWorking(["a", "b", "c"])).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("clamps out-of-range indices", () => {
    const rows = [mk("a", 99), mk("b")];
    expect(orderAgents(rows, allWorking(["a", "b"])).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("unanchored agents still attention-sort", () => {
    const rows = [mk("a"), mk("b")];
    expect(orderAgents(rows, { a: "working", b: "waiting" }).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("is id-preserving (selection safety)", () => {
    const rows = [mk("a", 0), mk("b"), mk("c", 5)];
    const out = orderAgents(rows, allWorking(["a", "b", "c"]));
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    expect(out).toHaveLength(3);
  });

  it("handles an empty agent list", () => {
    expect(orderAgents([] as Row[], {})).toEqual([]);
  });

  it("resolves two pins sharing an index by anchored-array order (ascending insert)", () => {
    // a and b both want row 0. Ascending insert (stable on equal index) places a first, then b
    // splices at 0 ahead of it → final order b, a, then the unanchored c.
    const rows = [mk("a", 0), mk("b", 0), mk("c")];
    expect(orderAgents(rows, allWorking(["a", "b", "c"])).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
});

describe("firstVisibleAgentId", () => {
  // Minimal AgentTab shape the helper actually reads.
  type Ag = { id: string; kind: AgentKind; parentId: string | null; pinnedIndex: number | null };
  const ag = (
    id: string,
    kind: AgentKind,
    parentId: string | null = null,
    pinnedIndex: number | null = null,
  ): Ag => ({ id, kind, parentId, pinnedIndex });

  it("Build mode skips think agents even when one is first in insertion order", () => {
    // The original bug: agents[0] is a think agent, so removeAgent's raw fallback strands the
    // Build sidebar on the Think pane. Build mode must land on the first BUILD row instead.
    const agents = [ag("t1", "think"), ag("b1", "build"), ag("b2", "build")];
    expect(firstVisibleAgentId(agents, "build", "manual", {})).toBe("b1");
  });

  it("Think mode lands on the first think agent", () => {
    const agents = [ag("b1", "build"), ag("t1", "think"), ag("t2", "think")];
    expect(firstVisibleAgentId(agents, "think", "manual", {})).toBe("t1");
  });

  it("Plan mode is treated like Build for selection (plan sidebar paints no rows)", () => {
    // Selection still matters in plan mode (it persists for the switch back to Build), so the
    // helper deliberately picks the first build-side row rather than null.
    const agents = [ag("t1", "think"), ag("b1", "build")];
    expect(firstVisibleAgentId(agents, "plan", "manual", {})).toBe("b1");
  });

  it("returns null when the active mode has no rows (→ blank first-load state)", () => {
    const agents = [ag("t1", "think"), ag("t2", "think")];
    expect(firstVisibleAgentId(agents, "build", "manual", {})).toBeNull();
    expect(firstVisibleAgentId([], "build", "manual", {})).toBeNull();
  });

  it("excludes a build agent's nested workers but keeps orphaned workers visible", () => {
    const agents = [
      ag("b1", "build"),
      ag("w1", "worker", "b1"), // nested under present build → hidden
      ag("w2", "worker", "gone"), // orphaned (parent absent) → surfaces at top level
    ];
    // Manual order keeps insertion order, so the build agent is first.
    expect(firstVisibleAgentId(agents, "build", "manual", {})).toBe("b1");
    // With only the orphan present, it's the first visible Build-mode row.
    expect(firstVisibleAgentId([ag("w2", "worker", "gone")], "build", "manual", {})).toBe("w2");
  });

  it("respects attention ordering — a waiting build agent floats above a working one", () => {
    const agents = [ag("b1", "build"), ag("b2", "build")];
    const status: Record<string, AgentTabStatus> = { b1: "working", b2: "waiting" };
    expect(firstVisibleAgentId(agents, "build", "attention", status)).toBe("b2");
    // Manual ordering ignores status and keeps insertion order.
    expect(firstVisibleAgentId(agents, "build", "manual", status)).toBe("b1");
  });
});
