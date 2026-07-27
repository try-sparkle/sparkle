import { describe, it, expect, beforeEach, vi } from "vitest";

// Spy on the switch-waterfall trace so we can assert a redundant re-selection does NOT start one.
const perfStart = vi.fn();
vi.mock("../perfTrace", () => ({
  perfStart: (...args: unknown[]) => perfStart(...args),
  // projectStore also imports perfSpan; give it a harmless stub.
  perfSpan: () => () => {},
}));

import { useProjectStore } from "./projectStore";

describe("projectStore.selectAgent — no-op on re-selecting the already-selected agent", () => {
  beforeEach(() => {
    perfStart.mockClear();
    useProjectStore.setState({ projects: [], selectedProjectId: null });
  });

  // addAgent auto-selects the new agent, so establish a known selection state explicitly.
  function seedTwoAgents(): { pid: string; aid: string; aid2: string } {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid)!;
    const aid2 = useProjectStore.getState().addAgent(pid)!;
    return { pid, aid, aid2 };
  }

  it("a genuine selection (target differs) updates selectedAgentId and starts one switch trace", () => {
    const { pid, aid } = seedTwoAgents();
    useProjectStore.getState().selectAgent(pid, null); // clear to a known state
    perfStart.mockClear();

    useProjectStore.getState().selectAgent(pid, aid);

    const proj = useProjectStore.getState().projects.find((p) => p.id === pid)!;
    expect(proj.selectedAgentId).toBe(aid);
    expect(perfStart).toHaveBeenCalledWith(`switch:${aid}`, "switch");
    expect(perfStart).toHaveBeenCalledTimes(1);
  });

  it("re-selecting the same agent is a pure no-op: no new switch trace, same projects reference", () => {
    const { pid, aid } = seedTwoAgents();
    useProjectStore.getState().selectAgent(pid, aid);
    const before = useProjectStore.getState().projects;
    perfStart.mockClear();

    useProjectStore.getState().selectAgent(pid, aid);

    // No phantom switch waterfall for a selection that changes nothing.
    expect(perfStart).not.toHaveBeenCalled();
    // No new state object → subscribers don't re-render (the pane reveal doesn't re-run).
    expect(useProjectStore.getState().projects).toBe(before);
  });

  it("re-selecting the same NULL (already deselected) is also a no-op", () => {
    const { pid } = seedTwoAgents();
    useProjectStore.getState().selectAgent(pid, null);
    const before = useProjectStore.getState().projects;
    perfStart.mockClear();

    useProjectStore.getState().selectAgent(pid, null);

    expect(perfStart).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects).toBe(before);
  });

  it("still switches when the target actually differs", () => {
    const { pid, aid, aid2 } = seedTwoAgents();
    useProjectStore.getState().selectAgent(pid, aid);
    perfStart.mockClear();

    useProjectStore.getState().selectAgent(pid, aid2);

    expect(useProjectStore.getState().projects.find((p) => p.id === pid)!.selectedAgentId).toBe(aid2);
    expect(perfStart).toHaveBeenCalledWith(`switch:${aid2}`, "switch");
  });
});
