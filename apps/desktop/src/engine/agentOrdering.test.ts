import { describe, it, expect } from "vitest";
import {
  sortAgentsByAttention,
  orderAgents,
  orderedTopLevelAgents,
  firstVisibleAgentId,
  STATUS_RANK,
  FRESH_BUILD_RANK,
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
    // Tier 0 (red) first — the full red tier floats to the top: waiting/approval/errored plus
    // `blocked` (went quiet — needs you to unstick it), which is red now too.
    expect(sorted.slice(0, 4).sort()).toEqual(["approval1", "blocked1", "errored1", "waiting1"]);
    // Tier 1 next — idle/done.
    expect(sorted.slice(4, 6).sort()).toEqual(["done1", "idle1"]);
    // Tier 2 — working.
    expect(sorted[6]).toBe("working1");
    // Tier 3 (bottom) — only stopped is dormant now.
    expect(sorted.slice(7)).toEqual(["stopped1"]);
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

  it("STATUS_RANK encodes the tiers as ascending ranks", () => {
    expect(STATUS_RANK.waiting).toBe(STATUS_RANK.approval);
    // The full red tier shares tier 0 and floats to the top: errored (sparkle-pqxh), plus blocked
    // ('went quiet') and unmerged ('finished but not on main') which are red now too.
    expect(STATUS_RANK.errored).toBe(STATUS_RANK.waiting);
    expect(STATUS_RANK.blocked).toBe(STATUS_RANK.waiting);
    expect(STATUS_RANK.unmerged).toBe(STATUS_RANK.waiting);
    expect(STATUS_RANK.idle).toBe(STATUS_RANK.done);
    expect(STATUS_RANK.waiting).toBeLessThan(STATUS_RANK.idle);
    expect(STATUS_RANK.idle).toBeLessThan(STATUS_RANK.working);
    expect(STATUS_RANK.working).toBeLessThan(STATUS_RANK.stopped);
    // The whole red tier floats up, so none of it sits in the dormant bottom tier with stopped.
    expect(STATUS_RANK.errored).toBeLessThan(STATUS_RANK.stopped);
    expect(STATUS_RANK.blocked).toBeLessThan(STATUS_RANK.stopped);
  });
});

describe("sortAgentsByAttention — fresh build agent boost", () => {
  it("floats the fresh agent to the TOP of the non-red rows (above idle/done/working)", () => {
    const agents = [a("idle1"), a("working1"), a("fresh"), a("done1")];
    const status: Record<string, AgentTabStatus> = {
      idle1: "idle",
      working1: "working",
      fresh: "working", // its real status is working (tier 2) — the boost overrides that
      done1: "done",
    };
    // Without the boost, `fresh` (working, tier 2) would sink below idle/done.
    expect(ids(sortAgentsByAttention(agents, status))).toEqual([
      "idle1",
      "done1",
      "working1",
      "fresh",
    ]);
    // With the boost it leads the non-red group.
    expect(ids(sortAgentsByAttention(agents, status, "fresh"))).toEqual([
      "fresh",
      "idle1",
      "done1",
      "working1",
    ]);
  });

  it("keeps the fresh agent BELOW red/needs-you rows", () => {
    const agents = [a("red1"), a("fresh"), a("idle1")];
    const status: Record<string, AgentTabStatus> = {
      red1: "waiting",
      fresh: "idle",
      idle1: "idle",
    };
    // Red still wins the top; fresh leads the rest.
    expect(ids(sortAgentsByAttention(agents, status, "fresh"))).toEqual(["red1", "fresh", "idle1"]);
  });

  it("does NOT demote a fresh agent that is itself red — it stays in the red tier", () => {
    const agents = [a("red1"), a("fresh"), a("idle1")];
    const status: Record<string, AgentTabStatus> = {
      red1: "waiting",
      fresh: "approval", // fresh AND red
      idle1: "idle",
    };
    // FRESH_BUILD_RANK (0.5) must not push a red (rank 0) fresh agent below its red sibling.
    const sorted = ids(sortAgentsByAttention(agents, status, "fresh"));
    expect(sorted.slice(0, 2).sort()).toEqual(["fresh", "red1"]);
    expect(sorted[2]).toBe("idle1");
  });

  it("no-ops when freshId is undefined or matches no agent (unchanged ordering)", () => {
    const agents = [a("idle1"), a("working1")];
    const status: Record<string, AgentTabStatus> = { idle1: "idle", working1: "working" };
    expect(ids(sortAgentsByAttention(agents, status))).toEqual(["idle1", "working1"]);
    expect(ids(sortAgentsByAttention(agents, status, "ghost"))).toEqual(["idle1", "working1"]);
  });

  it("FRESH_BUILD_RANK sits strictly between the red tier and the next tier", () => {
    expect(STATUS_RANK.waiting).toBeLessThan(FRESH_BUILD_RANK);
    expect(FRESH_BUILD_RANK).toBeLessThan(STATUS_RANK.idle);
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

  it("Build mode lands on the first top-level row in insertion order", () => {
    const agents = [ag("b1", "build"), ag("b2", "build")];
    expect(firstVisibleAgentId(agents, "build", "manual", {})).toBe("b1");
  });

  it("Plan mode is treated like Build for selection (plan sidebar paints no rows)", () => {
    // Selection still matters in plan mode (it persists for the switch back to Build), so the
    // helper deliberately picks the first row rather than null.
    const agents = [ag("b1", "build"), ag("b2", "build")];
    expect(firstVisibleAgentId(agents, "plan", "manual", {})).toBe("b1");
  });

  it("returns null when there are no rows (→ blank first-load state)", () => {
    expect(firstVisibleAgentId([], "build", "manual", {})).toBeNull();
  });

  it("excludes ALL workers — nested and orphaned — from the top-level selection", () => {
    const agents = [
      ag("b1", "build"),
      ag("w1", "worker", "b1"), // nested under present build → hidden
      ag("w2", "worker", "gone"), // orphaned (parent absent) → still hidden, never a top-level row
    ];
    // Manual order keeps insertion order, so the build agent is first.
    expect(firstVisibleAgentId(agents, "build", "manual", {})).toBe("b1");
    // A worker never surfaces as a row, even orphaned or alone — the user works with orchestrators
    // and reaches a worker only via its parent's card, so there is nothing to select here.
    expect(firstVisibleAgentId([ag("w2", "worker", "gone")], "build", "manual", {})).toBeNull();
  });

  it("respects attention ordering — a waiting build agent floats above a working one", () => {
    const agents = [ag("b1", "build"), ag("b2", "build")];
    const status: Record<string, AgentTabStatus> = { b1: "working", b2: "waiting" };
    expect(firstVisibleAgentId(agents, "build", "attention", status)).toBe("b2");
    // Manual ordering ignores status and keeps insertion order.
    expect(firstVisibleAgentId(agents, "build", "manual", status)).toBe("b1");
  });

  it("lands on the fresh build agent when one is set (top of the non-red rows)", () => {
    const agents = [ag("b1", "build"), ag("b2", "build")];
    const status: Record<string, AgentTabStatus> = { b1: "idle", b2: "working" };
    // b2 (working) would normally sink below b1 (idle); the fresh boost puts it first.
    expect(firstVisibleAgentId(agents, "build", "attention", status, "b2")).toBe("b2");
    // A red row still outranks the fresh agent.
    const status2: Record<string, AgentTabStatus> = { b1: "waiting", b2: "idle" };
    expect(firstVisibleAgentId(agents, "build", "attention", status2, "b2")).toBe("b1");
  });
});

describe("orderedTopLevelAgents — fresh boost end-to-end", () => {
  type Ag = { id: string; kind: AgentKind; parentId: string | null; pinnedIndex: number | null };
  const ag = (
    id: string,
    kind: AgentKind,
    parentId: string | null = null,
    pinnedIndex: number | null = null,
  ): Ag => ({ id, kind, parentId, pinnedIndex });

  it("puts the fresh build agent at the top of the non-red rows in Build mode", () => {
    const agents = [ag("b1", "build"), ag("b2", "build"), ag("b3", "build")];
    const status: Record<string, AgentTabStatus> = { b1: "waiting", b2: "idle", b3: "working" };
    // b3 is fresh: below the red b1, above idle b2 (and above its own working tier).
    expect(orderedTopLevelAgents(agents, status, "build", true, "b3").map((x) => x.id)).toEqual([
      "b1",
      "b3",
      "b2",
    ]);
  });

  it("ignores the fresh boost when attention ordering is off (manual = insertion order)", () => {
    const agents = [ag("b1", "build"), ag("b2", "build")];
    const status: Record<string, AgentTabStatus> = { b1: "working", b2: "working" };
    expect(orderedTopLevelAgents(agents, status, "build", false, "b2").map((x) => x.id)).toEqual([
      "b1",
      "b2",
    ]);
  });

  it("never surfaces worker agents as top-level rows — nested or orphaned", () => {
    const agents = [
      ag("b1", "build"),
      ag("w1", "worker", "b1"), // nested under a live orchestrator
      ag("w2", "worker", "gone"), // orphaned (parent gone)
      ag("s1", "shell"),
    ];
    // Only the build orchestrator + the shell agent, no workers.
    expect(orderedTopLevelAgents(agents, {}, "build", false).map((x) => x.id)).toEqual(["b1", "s1"]);
    // Plan is treated the same as Build for the row set (Plan renders a board in the main pane).
    expect(orderedTopLevelAgents(agents, {}, "plan", false).map((x) => x.id)).toEqual(["b1", "s1"]);
    // A lone orphaned worker yields an empty stack, not a stray row.
    expect(orderedTopLevelAgents([ag("w2", "worker", "gone")], {}, "build", false)).toEqual([]);
  });
});
