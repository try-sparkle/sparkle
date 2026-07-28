// `AddAgentOpts.select` — whether creating an agent also SELECTS it.
//
// The default (omitted) is TRUE and every other caller depends on it: selectionActions,
// useSpawnBuildAgent, sendToBuild, captureSends, cloudAgents all create an agent precisely so the
// user can land on it. `false` exists for the one MACHINE-created agent — services/workerSpawn, which
// runs off an MCP request from an orchestrator — where moving the user's terminal to a tab they never
// asked for is disruptive, and where a selected worker would force its orchestrator's subtree open
// and defeat "subtrees open only when a worker needs you" (engine/workerExpansion).
import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "./projectStore";

function seed(): { pid: string; first: string } {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  const first = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
  return { pid, first };
}

const selectionIn = (pid: string) =>
  useProjectStore.getState().projects.find((p) => p.id === pid)?.selectedAgentId;

describe("projectStore.addAgent — the `select` option", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
  });

  it("selects the new agent when `select` is omitted (the default every other caller relies on)", () => {
    const { pid } = seed();
    const id = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
    expect(selectionIn(pid)).toBe(id);
  });

  it("selects the new agent when `select: true`", () => {
    const { pid } = seed();
    const id = useProjectStore.getState().addAgent(pid, { kind: "build", select: true })!;
    expect(selectionIn(pid)).toBe(id);
  });

  it("leaves the user's tab alone when `select: false`", () => {
    const { pid, first } = seed();
    const id = useProjectStore.getState().addAgent(pid, {
      kind: "worker",
      parentId: first,
      select: false,
    })!;
    expect(selectionIn(pid)).toBe(first);
    expect(selectionIn(pid)).not.toBe(id);
    // …and the agent is still created and parented; only the selection is suppressed.
    const p = useProjectStore.getState().projects.find((x) => x.id === pid)!;
    expect(p.agents.find((a) => a.id === id)?.parentId).toBe(first);
  });

  // `false` is ABSOLUTE. It briefly self-cancelled when nothing was selected ("fill the empty
  // slot"), which made one flag mean two different things depending on state the caller can't see:
  // a null selection is DELIBERATE (Workspace's ladder pick, closeAgent's selectionAfterClose — e.g.
  // every row hidden by the status filter), and backfilling it handed the user's terminal to a
  // machine-created worker AND forced its orchestrator's subtree open via the sidebar's
  // selection-reveal effect — the expand-on-spawn behavior §14 removed.
  it("leaves an explicit null selection null — a deselect is intent, not a hole to backfill", () => {
    const { pid, first } = seed();
    useProjectStore.getState().selectAgent(pid, null);
    expect(selectionIn(pid)).toBeNull();

    const id = useProjectStore.getState().addAgent(pid, {
      kind: "worker",
      parentId: first,
      select: false,
    })!;
    expect(selectionIn(pid)).toBeNull();
    expect(selectionIn(pid)).not.toBe(id);
  });

  // The ABSENT key, not just an explicit null: a persisted/merged project record can arrive with no
  // `selectedAgentId` at all. The old guard was a strict `!== null`, so `undefined` fell through to
  // "select it" — the loose/strict split that made even the fallback's own stated case behave
  // differently from the null one. With no branch left there is nothing to get wrong.
  it("leaves an ABSENT (undefined) selection unselected too", () => {
    const { pid, first } = seed();
    useProjectStore.setState({
      projects: useProjectStore.getState().projects.map((p) => {
        if (p.id !== pid) return p;
        const { selectedAgentId: _drop, ...rest } = p;
        return rest as typeof p;
      }),
    });
    expect(selectionIn(pid)).toBeUndefined();

    const id = useProjectStore.getState().addAgent(pid, {
      kind: "worker",
      parentId: first,
      select: false,
    })!;
    expect(selectionIn(pid)).toBeUndefined();
    expect(selectionIn(pid)).not.toBe(id);
  });
});
