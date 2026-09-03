import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "./projectStore";
import type { AgentTab, Project } from "../types";

function mkAgent(): AgentTab {
  return {
    id: "a1", name: "A1", kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,  };
}

function seed() {
  const project: Project = {
    id: "p1", name: "P", rootPath: "/tmp/p", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [mkAgent()],
  };
  useProjectStore.setState({ projects: [project] } as never);
}

const agent = () => useProjectStore.getState().projects[0]!.agents[0]!;

describe("projectStore.setAgentActivity", () => {
  beforeEach(seed);

  it("sets the agent's live activity line", () => {
    useProjectStore.getState().setAgentActivity("p1", "a1", "Wiring the control listener");
    expect(agent().activity).toBe("Wiring the control listener");
  });

  it("trims surrounding whitespace", () => {
    useProjectStore.getState().setAgentActivity("p1", "a1", "  Running tests  ");
    expect(agent().activity).toBe("Running tests");
  });

  it("clears the line when given whitespace-only text", () => {
    useProjectStore.getState().setAgentActivity("p1", "a1", "Building");
    useProjectStore.getState().setAgentActivity("p1", "a1", "   ");
    expect(agent().activity).toBe("");
  });

  it("does NOT pin the name or clear auto-name variants (unlike renameAgent)", () => {
    const variants = { title: "Auto Title", description: "some work" };
    useProjectStore.setState({
      projects: [
        { ...useProjectStore.getState().projects[0]!, agents: [{ ...mkAgent(), autoNameVariants: variants }] },
      ],
    } as never);
    useProjectStore.getState().setAgentActivity("p1", "a1", "Now doing X");
    expect(agent().namePinned).toBe(false);
    expect(agent().autoNameVariants).toEqual(variants);
    expect(agent().name).toBe("A1");
  });

  it("only touches the targeted agent", () => {
    useProjectStore.setState({
      projects: [
        {
          ...useProjectStore.getState().projects[0]!,
          agents: [mkAgent(), { ...mkAgent(), id: "a2", name: "A2" }],
        },
      ],
    } as never);
    useProjectStore.getState().setAgentActivity("p1", "a2", "sibling work");
    const agents = useProjectStore.getState().projects[0]!.agents;
    expect(agents.find((a) => a.id === "a1")!.activity).toBeUndefined();
    expect(agents.find((a) => a.id === "a2")!.activity).toBe("sibling work");
  });

  // ── TIMESTAMPED QUOTE (bead sparkle-s8y5t6) ─────────────────────────────────────────────────
  // A self-report with no age reads as perpetually current — the exact way a dead agent looked
  // "explained". Every write must STAMP `activityAt` so consumers can read the line as a quote.
  it("STAMPS activityAt on a write, using the injected clock", () => {
    const T = 1_800_000_000_000;
    useProjectStore.getState().setAgentActivity("p1", "a1", "Wiring the listener", T);
    expect(agent().activityAt).toBe(T);
  });

  it("re-stamps activityAt to the NEW time on a later write", () => {
    useProjectStore.getState().setAgentActivity("p1", "a1", "phase one", 1000);
    useProjectStore.getState().setAgentActivity("p1", "a1", "phase two", 5000);
    expect(agent().activity).toBe("phase two");
    expect(agent().activityAt).toBe(5000);
  });

  it("CLEARS activityAt when the line is cleared — an empty 'as of now' would be a false fresh report", () => {
    useProjectStore.getState().setAgentActivity("p1", "a1", "Building", 1000);
    expect(agent().activityAt).toBe(1000);
    useProjectStore.getState().setAgentActivity("p1", "a1", "   ", 2000);
    expect(agent().activity).toBe("");
    expect(agent().activityAt).toBeUndefined();
  });
});

// ── IDENTITY PRESERVATION (perf HIGH) ─────────────────────────────────────────────────────────
// `set_agent_activity` fires from every one of ~60 live agents. `mapProject` used to `.map(...)`
// into a FRESH `projects` array on every write, and `setAgentActivity` used to mint a fresh agent
// object with no equality bail — so a no-op write rebuilt the whole `projects`/`agents` reference
// graph and woke all 11 whole-`projects` subscribers fleet-wide. These tests assert REFERENCE
// stability, not just value equality: they are the whole point, and each REDS if the guard in
// `mapProject`, `mapAgent`, or the `setAgentActivity` writer is removed.
describe("projectStore.setAgentActivity — reference identity", () => {
  function seedTwo() {
    const mk = (id: string, name: string): AgentTab => ({ ...mkAgent(), id, name });
    const p1: Project = {
      id: "p1", name: "P1", rootPath: "/tmp/p1", defaultBranch: null,
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [mk("a1", "A1"), mk("a2", "A2")],
    };
    const p2: Project = {
      id: "p2", name: "P2", rootPath: "/tmp/p2", defaultBranch: null,
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [mk("b1", "B1")],
    };
    useProjectStore.setState({ projects: [p1, p2] } as never);
  }
  beforeEach(seedTwo);

  const projects = () => useProjectStore.getState().projects;
  const proj = (id: string) => projects().find((p) => p.id === id)!;
  const agentIn = (pid: string, aid: string) => proj(pid).agents.find((a) => a.id === aid)!;

  it("returns the SAME projects array reference when the write is a no-op", () => {
    // Establish a concrete line first, then re-send the IDENTICAL text at the IDENTICAL clock.
    useProjectStore.getState().setAgentActivity("p1", "a1", "reticulating splines", 1000);
    const before = projects();
    useProjectStore.getState().setAgentActivity("p1", "a1", "reticulating splines", 1000);
    // No field changed, so nothing downstream should re-render: the whole array reference holds.
    // Without the guard, `.map` mints a new array here and every `s.projects` subscriber wakes.
    expect(projects()).toBe(before);
  });

  it("returns the SAME projects array reference when clearing an already-clear line", () => {
    useProjectStore.getState().setAgentActivity("p1", "a1", "", 1000); // undefined -> "" (a real change)
    const before = projects();
    useProjectStore.getState().setAgentActivity("p1", "a1", "   ", 2000); // "" -> "" : a no-op
    expect(projects()).toBe(before);
  });

  it("keeps unrelated project and sibling agent references on a real single-agent update", () => {
    const before = projects();
    const p1Before = proj("p1");
    const p2Before = proj("p2");
    const a1Before = agentIn("p1", "a1");
    const a2Before = agentIn("p1", "a2");
    const b1Before = agentIn("p2", "b1");

    useProjectStore.getState().setAgentActivity("p1", "a1", "new work", 3000);

    // The array itself DID change — agent a1's data really changed, so a `s.projects` subscriber
    // must see it. But the change is surgical:
    expect(projects()).not.toBe(before); // a real change ripples to the array
    expect(proj("p2")).toBe(p2Before); // unrelated project: SAME reference
    expect(agentIn("p2", "b1")).toBe(b1Before); // unrelated agent: SAME reference
    expect(agentIn("p1", "a2")).toBe(a2Before); // sibling agent in same project: SAME reference
    expect(proj("p1")).not.toBe(p1Before); // touched project: new object
    expect(agentIn("p1", "a1")).not.toBe(a1Before); // touched agent: new object
    expect(agentIn("p1", "a1").activity).toBe("new work"); // ...carrying the new value
  });
});
