// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "./projectStore";
import type { AgentTab } from "../types";

// `setAgentRuntime` backs local→cloud PROMOTION (services/agentPromotion; spec 2026-07-31
// §Decision 3: "one row, one id, one agent — only `runtime` changes"). The interesting assertion is
// therefore NOT that runtime became "cloud" — a store action that threw the whole tab away and
// inserted a fresh cloud one would pass that, and it is exactly the bug this exists to prevent.
// Everything below asserts what did NOT change.

const st = () => useProjectStore.getState();

function seed() {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  const pid = st().addProject("Demo", "/tmp/demo");
  const id = st().addAgent(pid, { kind: "build" })!;
  return { pid, id };
}

function agent(pid: string, id: string): AgentTab {
  return st().projects.find((p) => p.id === pid)!.agents.find((a) => a.id === id)!;
}

describe("projectStore.setAgentRuntime", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
  });

  it("changes runtime and NOTHING else on the tab", () => {
    const { pid, id } = seed();
    // Give the row a full complement of identity so a rebuild has something to lose.
    st().renameAgent(pid, id, "Retry Hardening");
    st().setAgentGoal(pid, id, "land the retry PR", undefined, "human");
    st().setAgentBeadId(pid, id, "sparkle-abcd");
    st().setAgentEpicId(pid, id, "epic-1");
    st().setAgentActivity(pid, id, "wiring the transport");
    st().setAgentModel(pid, id, "claude-opus-5");
    st().setAgentWorktree(pid, id, "/wt/a1", "sparkle/agent-42");
    st().appendPrompt(pid, id, "first prompt", "composer");
    st().noteTerminalBrief(pid, id);
    st().advanceAlerts(pid, { [id]: "errored" });

    const before = agent(pid, id);
    expect(before.runtime).toBe("local");

    st().setAgentRuntime(pid, id, "cloud");
    const after = agent(pid, id);

    expect(after.runtime).toBe("cloud");
    // Field-by-field: everything except `runtime` is byte-identical. Written as a whole-object
    // comparison so a NEW field added to AgentTab later is covered without editing this test.
    expect(after).toEqual({ ...before, runtime: "cloud" });
  });

  it("keeps the id, so every consumer that keys on it is unaffected", () => {
    const { pid, id } = seed();
    st().setAgentRuntime(pid, id, "cloud");
    expect(st().projects[0]!.agents.map((a) => a.id)).toEqual([id]);
  });

  it("does not add, remove or reorder rows", () => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    const pid = st().addProject("Demo", "/tmp/demo");
    const a = st().addAgent(pid, { kind: "build" })!;
    const b = st().addAgent(pid, { kind: "build" })!;
    const c = st().addAgent(pid, { kind: "build" })!;
    const order = st().projects[0]!.agents.map((x) => x.id);

    st().setAgentRuntime(pid, b, "cloud");

    expect(st().projects[0]!.agents.map((x) => x.id)).toEqual(order);
    expect(st().projects[0]!.agents.find((x) => x.id === a)!.runtime).toBe("local");
    expect(st().projects[0]!.agents.find((x) => x.id === c)!.runtime).toBe("local");
  });

  it("leaves the selection alone", () => {
    const { pid, id } = seed();
    st().selectAgent(pid, null);
    st().setAgentRuntime(pid, id, "cloud");
    expect(st().projects[0]!.selectedAgentId).toBeNull();
  });

  it("touches no OTHER project", () => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    const p1 = st().addProject("One", "/tmp/one");
    const p2 = st().addProject("Two", "/tmp/two");
    const a1 = st().addAgent(p1, { kind: "build" })!;
    const a2 = st().addAgent(p2, { kind: "build" })!;
    const other = st().projects.find((p) => p.id === p2)!;

    st().setAgentRuntime(p1, a1, "cloud");

    expect(st().projects.find((p) => p.id === p2)).toEqual(other);
    expect(st().projects.find((p) => p.id === p2)!.agents.find((a) => a.id === a2)!.runtime).toBe(
      "local",
    );
  });

  it("is a no-op for an unknown agent or project, rather than throwing", () => {
    const { pid, id } = seed();
    const snapshot = st().projects;
    st().setAgentRuntime(pid, "no-such-agent", "cloud");
    st().setAgentRuntime("no-such-project", id, "cloud");
    expect(st().projects).toEqual(snapshot);
    expect(agent(pid, id).runtime).toBe("local");
  });

  it("preserves the exact record identity when the runtime already matches", () => {
    // Re-flipping an already-cloud agent must not churn the object — subscribers key on identity.
    const { pid, id } = seed();
    st().setAgentRuntime(pid, id, "cloud");
    const first = agent(pid, id);
    st().setAgentRuntime(pid, id, "cloud");
    expect(agent(pid, id)).toBe(first);
  });

  it("can flip back to local — the store action forecloses nothing about demotion", () => {
    const { pid, id } = seed();
    st().renameAgent(pid, id, "Retry Hardening");
    const local = agent(pid, id);
    st().setAgentRuntime(pid, id, "cloud");
    st().setAgentRuntime(pid, id, "local");
    expect(agent(pid, id)).toEqual(local);
  });
});
