import { describe, it, expect } from "vitest";
import { topLevelAgents, firstVisibleAgentId, isTopLevelAgent } from "./agentOrdering";
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

// `isTopLevelAgent` — THE PREDICATE ITSELF, not the filter that wraps it (roborev 53562).
//
// It had no direct coverage, and it is the entire mechanism holding up the branch's headline
// invariant: the concierge digest states "N Need you in web", the click isolates that band in the
// Build column, and the number is only a promise the click can keep because BOTH sides ask this one
// predicate. `topLevelAgents` exercising it incidentally is not the same thing — that route can only
// ever ask it about a whole array, so the two properties below (it is CLOSED OVER a population, and
// "nested" is judged only against BUILD parents) are invisible from there.
describe("isTopLevelAgent — the shared predicate the sidebar and the concierge both ask", () => {
  it("is closed over the population: the SAME agent answers differently as its parent comes and goes", () => {
    const child = ag("c", "shell", "p");
    const parent = ag("p");
    // This is the property that makes it a predicate-over-a-population rather than a field on the
    // agent. Nesting is only meaningful relative to a parent that is PRESENT.
    expect(isTopLevelAgent([parent, child])(child)).toBe(false);
    expect(isTopLevelAgent([child])(child)).toBe(true);
  });

  it("judges nesting against BUILD parents only — a parent of another kind does not nest a child", () => {
    const child = ag("c", "shell", "p");
    // Only a `build` parent is in `buildIds`, so only it nests the child; against any other kind of
    // parent the child keeps a row of its own. Asserted per kind rather than as one "not build"
    // case, because this is the clause that decides whether an agent is reachable in column two.
    expect(isTopLevelAgent([ag("p", "shell"), child])(child)).toBe(true);
    expect(isTopLevelAgent([ag("p", "worker"), child])(child)).toBe(true);
    expect(isTopLevelAgent([ag("p", "build"), child])(child)).toBe(false);
  });

  it("excludes EVERY worker unconditionally — parented, orphaned, or parentless", () => {
    const parented = ag("w1", "worker", "p");
    const orphaned = ag("w2", "worker", "gone");
    const parentless = ag("w3", "worker", null);
    const pop = [ag("p"), parented, orphaned, parentless];
    for (const w of [parented, orphaned, parentless]) {
      expect(isTopLevelAgent(pop)(w)).toBe(false);
    }
  });

  it("agrees with topLevelAgents by construction — one rule, not two", () => {
    const pop = [ag("a"), ag("w", "worker", "a"), ag("s", "shell"), ag("n", "build", "a")];
    expect(ids(topLevelAgents(pop))).toEqual(ids(pop.filter(isTopLevelAgent(pop))));
  });
});
