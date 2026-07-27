import { describe, it, expect } from "vitest";
import { topLevelAgents, firstVisibleAgentId } from "./agentOrdering";
import type { AgentKind } from "../types";

// This module used to attention-SORT the sidebar stack (STATUS_RANK / FRESH_BUILD_RANK /
// sortAgentsByAttention / orderAgents). All of that was deleted on 2026-07-26 — see the module
// header for why. What remains is "which agents are top-level rows" and "which one to select".
// The tests that used to pin the sort ordering are gone with it; the tests that replace them live
// in buildSections.test.ts and assert the OPPOSITE property: that status never moves a row.

type Row = { id: string; kind: AgentKind; parentId: string | null };

const ag = (id: string, kind: AgentKind = "build", parentId: string | null = null): Row => ({
  id,
  kind,
  parentId,
});
const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("topLevelAgents", () => {
  it("keeps project.agents order — it filters, it does not sort", () => {
    const agents = [ag("c"), ag("a"), ag("b")];
    expect(ids(topLevelAgents(agents))).toEqual(["c", "a", "b"]);
  });

  it("takes no status input at all, so no status flip can reorder rows", () => {
    // The structural regression guard for the whole feature: the signature itself makes it
    // impossible for a PTY status tick to move a row, because status is not an input.
    expect(topLevelAgents.length).toBeLessThanOrEqual(2); // (agents, workMode) — no statusMap
  });

  it("excludes workers whose parent is a build agent", () => {
    const agents = [ag("b1"), ag("w1", "worker", "b1")];
    expect(ids(topLevelAgents(agents))).toEqual(["b1"]);
  });

  it("excludes an ORPHANED worker too — a worker never claims a row of its own", () => {
    // A worker whose parent is missing (mid spawn/spin-down, or the parent just closed) must not
    // flash into the sidebar; that flicker is exactly the distraction the rule exists to remove.
    expect(ids(topLevelAgents([ag("w2", "worker", "gone")]))).toEqual([]);
    expect(ids(topLevelAgents([ag("w3", "worker", null)]))).toEqual([]);
  });

  it("keeps non-worker kinds, including a child of a NON-build parent", () => {
    // Only a BUILD parent nests its children; a child of a shell/other parent stays top-level.
    const agents = [ag("b1"), ag("s1", "shell"), ag("s2", "shell", "s1")];
    expect(ids(topLevelAgents(agents))).toEqual(["b1", "s1", "s2"]);
  });

  it("renders the same rows for Plan and Build", () => {
    const agents = [ag("b1"), ag("s1", "shell")];
    expect(ids(topLevelAgents(agents, "build"))).toEqual(ids(topLevelAgents(agents, "plan")));
  });

  it("does not mutate its input", () => {
    const agents = [ag("b"), ag("a")];
    const before = ids(agents);
    topLevelAgents(agents);
    expect(ids(agents)).toEqual(before);
  });
});

describe("firstVisibleAgentId", () => {
  it("picks the first top-level agent in array order", () => {
    expect(firstVisibleAgentId([ag("b1"), ag("b2")], "build")).toBe("b1");
  });

  it("skips workers when choosing", () => {
    expect(firstVisibleAgentId([ag("w1", "worker", "b1"), ag("b1")], "build")).toBe("b1");
  });

  it("returns null when there is no top-level row", () => {
    expect(firstVisibleAgentId([], "build")).toBeNull();
    expect(firstVisibleAgentId([ag("w2", "worker", "gone")], "build")).toBeNull();
  });

  it("treats plan like build, so switching back to Build keeps a selection", () => {
    expect(firstVisibleAgentId([ag("b1")], "plan")).toBe("b1");
  });

  it("takes no status input, so selection stability across a status tick is structural", () => {
    // The old implementation took a status map and returned a different agent as statuses moved.
    const agents = [ag("b1"), ag("b2")];
    expect(firstVisibleAgentId(agents, "build")).toBe("b1");
    expect(firstVisibleAgentId.length).toBeLessThanOrEqual(2); // (agents, mode) — no statusMap
  });
});
