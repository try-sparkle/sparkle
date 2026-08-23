// The fleet-wide beads derivation: does it agree with the per-call helpers it replaced, and does it
// hand back STABLE OBJECTS for rows whose facts did not move?
//
// The second question is the one with teeth. `buildAgentBeadFacts` would still be a real speedup if
// it minted a fresh object per agent per poll — the O(agents × beads) scan would be gone — but every
// row would still re-render, because `agentRowPropsEqual` compares this prop by reference. So
// "correct values" is necessary and proves nothing about the fix; the identity assertions below are
// what the change is actually for. See `AgentSidebar.beadFactsPerf.test.tsx` for the same property
// measured end-to-end through the real component.
import { describe, expect, it } from "vitest";
import {
  buildAgentBeadFacts,
  EMPTY_AGENT_BEAD_FACTS,
  type AgentBeadFacts,
} from "./agentBeadFacts";
import { beadLabel, epicForBuild, epicPillFor } from "../services/planView";
import { countAgentFeedbackBeads } from "./retroEvidence";
import { bucketBeads, type Bead } from "../services/beads";
import type { AgentTab } from "../types";

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return { title: "", description: "", status: "open", labels: [], parent: null, ...partial };
}

function agent(partial: Partial<AgentTab> & { id: string }): AgentTab {
  return {
    // `id` comes from the spread below; naming it here too would be an overwritten duplicate.
    name: partial.id,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
    ...partial,
  };
}

/**
 * FOUR ORCHESTRATORS ON FOUR DIFFERENT EPICS, EACH WITH ITS OWN WORKER, ALL AT ONCE.
 *
 * Deliberately not one agent in isolation. This derivation's whole job is to key N answers to N
 * agents off ONE pass, so the failure it can actually have is a map keyed to the wrong side — every
 * row handed row 0's facts, or the epic/worker halves crossed. A single-agent fixture passes just as
 * happily against that bug (bead `sparkle-foqoe`: absence in a candidate that was never mounted
 * proves nothing), so every candidate is present in every case below.
 */
function fleet() {
  const beads: Bead[] = [];
  const agents: AgentTab[] = [];
  for (let e = 0; e < 4; e++) {
    beads.push(bead({ id: `e${e}`, title: `Epic ${e}`, type: "epic" }));
    beads.push(bead({ id: `t${e}`, title: `Task ${e}`, parent: `e${e}` }));
    // `b${e}` carries its own epicId; `d${e}` has none, so it must fall back to the worker-derived
    // path — both arms of `epicPillFor` are exercised in the same fixture.
    agents.push(agent({ id: `b${e}`, kind: "build", epicId: `e${e}` }));
    agents.push(agent({ id: `d${e}`, kind: "build" }));
    agents.push(agent({ id: `w${e}`, kind: "worker", parentId: `d${e}`, beadId: `t${e}` }));
  }
  // Feedback labels: b0 filed FOUR, b1 filed one, everyone else none.
  beads.push(bead({ id: "f1", title: "f1", labels: ["agent:b0"] }));
  beads.push(bead({ id: "f2", title: "f2", labels: ["agent:b0", "other"] }));
  beads.push(bead({ id: "f3", title: "f3", labels: ["agent:b0"] }));
  beads.push(bead({ id: "f4", title: "f4", labels: ["agent:b1"] }));
  // ONE BEAD CARRYING THE SAME LABEL TWICE — the shape that separates a BEAD count from a LABEL
  // count, and without which the two implementations are indistinguishable (roborev 65598).
  // `normalizeLabels` filters non-strings but does NOT de-duplicate, so uniqueness is bd's
  // invariant, not one this client may assume. The fast path counts occurrences unless it folds
  // each bead's labels through a Set first; the predicate it replaced
  // (`beads.filter((b) => b.labels.includes(label)).length`) counts beads. A duplicate here makes
  // that difference observable — 5 vs 4 — so the equivalence case above fails on the wrong one.
  beads.push(bead({ id: "f5", title: "f5", labels: ["agent:b0", "agent:b0"] }));
  return { beads, agents, board: bucketBeads(beads) };
}

describe("buildAgentBeadFacts — agrees with the helpers it replaced", () => {
  it("gives every agent its OWN facts, matching the un-indexed helpers exactly", () => {
    const { beads, agents, board } = fleet();
    const facts = buildAgentBeadFacts(beads, board, agents);

    // Every agent is answered, and answered the same way the pre-hoist row would have answered it.
    // Comparing against the ORIGINAL exported functions (rather than against hand-written expected
    // values) is what makes this a refactor pin: if the indexed rule and the wrapper ever disagree,
    // this fails, whichever of the two is wrong.
    expect(facts.size).toBe(agents.length);
    for (const a of agents) {
      const f = facts.get(a.id)!;
      expect(f.beadHover).toBe(a.kind === "worker" ? beadLabel(beads, a.beadId) : null);
      expect(f.epicHover).toBe(a.kind === "build" ? epicForBuild(beads, agents, a.id) : null);
      expect(f.epicPill).toEqual(a.kind === "build" ? epicPillFor(a, board, agents) : null);
      expect(f.feedbackCount).toBe(a.kind === "build" ? countAgentFeedbackBeads(beads, a.id) : 0);
    }
  });

  it("distinguishes the four orchestrators — each pill names ITS OWN epic, not a neighbour's", () => {
    // The explicit values behind the equivalence above. Written out because "matches the helper"
    // would still pass if BOTH sides were keyed wrong, and because a crossed map is the specific
    // regression a Map-based rewrite invites.
    const { beads, agents, board } = fleet();
    const facts = buildAgentBeadFacts(beads, board, agents);

    for (let e = 0; e < 4; e++) {
      // The `epicId` arm.
      expect(facts.get(`b${e}`)!.epicPill).toEqual({ id: `e${e}`, title: `Epic ${e}` });
      // The worker-derived arm: d{e} has no epicId, but its worker w{e} is on t{e}, whose parent is
      // e{e}. Both arms must land on the SAME epic for the same index.
      expect(facts.get(`d${e}`)!.epicPill).toEqual({ id: `e${e}`, title: `Epic ${e}` });
      expect(facts.get(`d${e}`)!.epicHover).toBe(`e${e} · Epic ${e}`);
      // …and the worker shows its own BEAD, never its parent's epic.
      expect(facts.get(`w${e}`)!.beadHover).toBe(`t${e} · Task ${e}`);
      expect(facts.get(`w${e}`)!.epicPill).toBeNull();
      expect(facts.get(`w${e}`)!.epicHover).toBeNull();
    }
  });

  it("counts each orchestrator's OWN feedback beads", () => {
    const { beads, agents, board } = fleet();
    const facts = buildAgentBeadFacts(beads, board, agents);
    // FOUR beads carry `agent:b0`, and one of them carries it twice. This is 4, not 5, precisely
    // because the count is per BEAD — see the duplicate in `fleet()`.
    expect(facts.get("b0")!.feedbackCount).toBe(4);
    expect(facts.get("b1")!.feedbackCount).toBe(1);
    expect(facts.get("b2")!.feedbackCount).toBe(0);
    // A worker never carries the pill, even if a bead somehow bore its label.
    expect(facts.get("w0")!.feedbackCount).toBe(0);
  });

  it("has no facts for an agent it was not given — and the render fallback is a SHARED object", () => {
    const { beads, agents, board } = fleet();
    const facts = buildAgentBeadFacts(beads, board, agents);
    expect(facts.get("nobody")).toBeUndefined();
    // The sidebar's `?? EMPTY_AGENT_BEAD_FACTS` must be one frozen singleton: a fresh `{}` there
    // would hand that row a new prop identity every parent render and silently un-memoize it.
    expect(facts.get("nobody") ?? EMPTY_AGENT_BEAD_FACTS).toBe(EMPTY_AGENT_BEAD_FACTS);
  });
});

describe("buildAgentBeadFacts — entry identity is what makes React.memo bite", () => {
  it("reuses EVERY previous entry object when the snapshot is equal-but-fresh", () => {
    const first = fleet();
    const before = buildAgentBeadFacts(first.beads, first.board, first.agents);

    // A genuinely new snapshot with identical CONTENT — what a `bd` poll hands back. Nothing here is
    // reference-equal to what `before` was built from, so reuse cannot come from an identity
    // shortcut upstream; it has to come from the field comparison.
    const second = fleet();
    const after = buildAgentBeadFacts(second.beads, second.board, second.agents, before);

    for (const a of second.agents) expect(after.get(a.id)).toBe(before.get(a.id));
  });

  it("mints a new object ONLY for the agents whose facts actually moved", () => {
    // THE ASSERTION THE WHOLE CHANGE IS FOR. One epic is retitled; one orchestrator's pill changes.
    // Every other row must keep its object, or the sidebar re-renders all 60 for a one-bead edit —
    // which is the behaviour before this fix, and it passes the value assertions above unchanged.
    const first = fleet();
    const before = buildAgentBeadFacts(first.beads, first.board, first.agents);

    const second = fleet();
    second.beads.find((b) => b.id === "e2")!.title = "Epic 2 RENAMED";
    const board = bucketBeads(second.beads);
    const after = buildAgentBeadFacts(second.beads, board, second.agents, before);

    const moved = second.agents.filter((a) => after.get(a.id) !== before.get(a.id)).map((a) => a.id);
    // b2 (epicId → e2) and d2 (worker-derived → e2). Nobody else reads e2's title.
    expect(moved.sort()).toEqual(["b2", "d2"]);
    // PAIRED with the reuse above: the rows that moved carry the NEW value, so this is not a
    // comparator hard-wired to "changed" any more than the previous case is one wired to "same".
    expect(after.get("b2")!.epicPill).toEqual({ id: "e2", title: "Epic 2 RENAMED" });
    expect(after.get("d2")!.epicHover).toBe("e2 · Epic 2 RENAMED");
    // …and an untouched neighbour still reads its own old value, not the renamed one.
    expect(after.get("b1")!.epicPill).toEqual({ id: "e1", title: "Epic 1" });
  });

  it("mints a new object when a feedback count moves, and only for that agent", () => {
    const first = fleet();
    const before = buildAgentBeadFacts(first.beads, first.board, first.agents);

    const second = fleet();
    second.beads.push(bead({ id: "f5", title: "f5", labels: ["agent:b3"] }));
    const board = bucketBeads(second.beads);
    const after = buildAgentBeadFacts(second.beads, board, second.agents, before);

    const moved = second.agents.filter((a) => after.get(a.id) !== before.get(a.id)).map((a) => a.id);
    expect(moved).toEqual(["b3"]);
    expect(after.get("b3")!.feedbackCount).toBe(1);
  });

  it("mints a new object when a pill APPEARS or DISAPPEARS", () => {
    // The null↔object flip specifically. `sameFacts` compares `epicPill?.id` / `?.title`, and `?.`
    // collapses null and undefined — so a pill vanishing entirely would read as "both undefined,
    // unchanged" without the explicit presence test beside them, and the row would keep painting a
    // pill for an epic it is no longer on. That is the omitted-prop failure `agentRowPropsEqual`'s
    // own header warns about: a SKIPPED render showing stale data, not merely a slow one.
    const beads = [bead({ id: "e0", title: "Epic 0" })];
    const withPill = [agent({ id: "b0", kind: "build", epicId: "e0" })];
    const before = buildAgentBeadFacts(beads, bucketBeads(beads), withPill);
    expect(before.get("b0")!.epicPill).toEqual({ id: "e0", title: "Epic 0" });

    // Same agent id, epic handed back (sendToBuild undone) → no pill at all.
    const withoutPill = [agent({ id: "b0", kind: "build" })];
    const after = buildAgentBeadFacts(beads, bucketBeads(beads), withoutPill, before);
    expect(after.get("b0")).not.toBe(before.get("b0"));
    expect(after.get("b0")!.epicPill).toBeNull();

    // …and back again.
    const restored = buildAgentBeadFacts(beads, bucketBeads(beads), withPill, after);
    expect(restored.get("b0")).not.toBe(after.get("b0"));
    expect(restored.get("b0")!.epicPill).toEqual({ id: "e0", title: "Epic 0" });
  });

  it("is idempotent when re-run against the map it just produced (React's dev double-invoke)", () => {
    // `AgentSidebar` stores the result in a ref and feeds it back as `previous`. React re-invokes
    // `useMemo` bodies in development StrictMode, so the second call receives the FIRST call's own
    // output — which must be a no-op rather than a wholesale re-mint, or every row would re-render
    // once per parent render in dev and the measurement would only hold in production.
    const { beads, agents, board } = fleet();
    const once = buildAgentBeadFacts(beads, board, agents);
    const twice = buildAgentBeadFacts(beads, board, agents, once);
    for (const a of agents) expect(twice.get(a.id)).toBe(once.get(a.id));
  });
});

describe("buildAgentBeadFacts — a fleet with no orchestrators", () => {
  it("answers every worker without walking the backlog's labels", () => {
    // The `agents.some(kind === "build")` short-circuit. Asserted through its OUTPUT (workers still
    // resolve, and nobody claims a feedback count) rather than by reaching for the private counter.
    const beads = [bead({ id: "t0", title: "Task 0", labels: ["agent:b0"] })];
    const agents = [agent({ id: "w0", kind: "worker", parentId: "gone", beadId: "t0" })];
    const facts = buildAgentBeadFacts(beads, bucketBeads(beads), agents);
    expect(facts.get("w0")).toEqual<AgentBeadFacts>({
      beadHover: "t0 · Task 0",
      epicHover: null,
      epicPill: null,
      feedbackCount: 0,
    });
  });
});
