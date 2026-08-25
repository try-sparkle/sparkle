import { beforeEach, describe, expect, it } from "vitest";
import { newGoal, statusNoteMarker } from "./agentGoal";
import { useProjectStore } from "../stores/projectStore";
import type { AgentTab, Project } from "../types";

// bead sparkle-lzb2qq — a real goal overwritten with a STATUS NOTE ("Awaiting the founder's next
// task") is unachievable by construction: the entry gate lets it through (under the length cap,
// not filler) and nothing re-checked a goal REPLACED mid-life, so auto-continue burned its whole
// allowance and escalated as a phantom blocker. The fix refuses the status-note SHAPE at the goal
// substrate (`newGoal`), which every write funnels through.

/** The exact field value observed on the stranded agent, verbatim from the bead body. */
const OBSERVED =
  "Stood down from the pr-checks.sh fix (a peer is ahead with a better base); handed them the " +
  "fail-open finding. Awaiting the founder's next task.";

describe("statusNoteMarker", () => {
  it("flags the exact status note observed in the wild", () => {
    // Whichever marker fires, it must fire — the point is that this string is refusable by shape.
    expect(statusNoteMarker(OBSERVED)).toBeDefined();
  });

  it.each([
    ["awaiting the founder's next task", "awaiting"],
    ["Stood down; a peer is ahead", "stood down"],
    ["nothing pending right now", "nothing pending"],
    ["standing by for instructions", "standing by"],
    ["handed off to the peer agent", "handed off"],
    ["waiting for the founder to weigh in", "waiting for the founder"],
  ])("flags %j via marker %j", (text, marker) => {
    expect(statusNoteMarker(text)).toBe(marker);
  });

  it("is insensitive to case and surrounding whitespace", () => {
    expect(statusNoteMarker("   STOOD   DOWN   for now  ")).toBe("stood down");
  });

  it.each([
    // Real completion criteria — an observable end state anyone else can check.
    "nested groups parse and parser.test.ts passes",
    "Land the concierge dispatch-memory PR: every delegation recorded at spawn, recallable by subject",
    "the CLI exits 0 and dist/bundle.js is under 200kb",
    // Narrowness: these CONTAIN a near-miss of a marker but state a checkable condition, so they
    // must NOT be flagged — a false positive would refuse a legitimate goal.
    "waiting for CI to go green and the deploy job exits 0",
    "no rows remain where status = 'pending' after the migration",
  ])("does NOT flag the real goal %j", (text) => {
    expect(statusNoteMarker(text)).toBeUndefined();
  });
});

describe("newGoal refuses a status note", () => {
  const NOW = 1_700_000_000_000;

  it("throws on the observed status note rather than minting an unsatisfiable goal", () => {
    expect(() => newGoal(OBSERVED, NOW)).toThrow(/status note/i);
  });

  it("still throws on empty text (the pre-existing contract is intact)", () => {
    expect(() => newGoal("   ", NOW)).toThrow(/empty goal/i);
  });

  it("mints a real goal unchanged — the guard does not block well-formed criteria", () => {
    const g = newGoal("nested groups parse and parser.test.ts passes", NOW);
    expect(g.text).toBe("nested groups parse and parser.test.ts passes");
    expect(g.setAt).toBe(NOW);
  });
});

// The bead scenario end-to-end: a status note must NOT be able to overwrite a real standing goal.
// Drives the real production entry point (`setAgentGoal`), whose new-text branch funnels through
// `newGoal`. A throw from `newGoal` propagates out of the zustand updater, so the prior goal stays.

function mkAgent(): AgentTab {
  return {
    id: "a1", name: "A1", kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}

function seed() {
  const project: Project = {
    id: "p1", name: "P", rootPath: "/tmp/p", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [mkAgent()],
  };
  useProjectStore.setState({ projects: [project] } as never);
}

const agent = () => useProjectStore.getState().projects[0]!.agents[0]!;
const store = () => useProjectStore.getState();

describe("setAgentGoal will not let a status note overwrite a real goal", () => {
  const REAL = "Land the dispatch-memory PR: every delegation recorded at spawn and folded per turn";

  beforeEach(seed);

  it("keeps the standing real goal when a status note is set over it (agent actor)", () => {
    store().setAgentGoal("p1", "a1", REAL, undefined, "agent");
    expect(agent().goal?.text).toBe(REAL);

    expect(() => store().setAgentGoal("p1", "a1", OBSERVED, undefined, "agent")).toThrow(
      /status note/i,
    );
    // The prior, achievable goal survives the rejected overwrite unchanged.
    expect(agent().goal?.text).toBe(REAL);
  });

  it("a well-formed replacement DOES apply — proving the refusal is the status-note shape, not the write", () => {
    store().setAgentGoal("p1", "a1", REAL, undefined, "agent");
    const NEXT = "parser handles nested groups and parser.test.ts passes";
    store().setAgentGoal("p1", "a1", NEXT, undefined, "agent");
    expect(agent().goal?.text).toBe(NEXT);
  });
});
