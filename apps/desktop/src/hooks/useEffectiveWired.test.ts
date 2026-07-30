// @vitest-environment jsdom
//
// THE ONE DERIVATION EVERY SURFACE THAT DRAWS THE CABLE MUST SHARE.
//
// The first cut of this projected the effective side at the shell root only, while `wired` has THREE
// readers — the root, the concierge column (via ConciergeHost, for its own `data-wired`, the flood
// and the lift) and the sidebar's row joint. So the state the commit claimed was unrepresentable was
// still fully representable, and self-contradictory on top: the root reported "off" while the column
// still flooded and the rows still drew their joints open (roborev 55386).
//
// These pin the RULE and the SUBSCRIPTION. That the three components actually call it is pinned
// where they render — Workspace.cockpit / Workspace.resize for the root, and the sidebar's own
// geometry suites for the joint.
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { effectiveWired } from "../engine/cable";
import { useEffectiveWired, usePairIsLive } from "./useEffectiveWired";
import { useCableStore, resetCable } from "../stores/cableStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, selectedAgentId: string | null): Project {
  return {
    id, name: id, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId, agents: [mkAgent(`${id}-a1`)],
  };
}

beforeEach(() => {
  resetCable();
  useUiStore.setState({ pairAssignment: {}, leftProjectId: null } as never);
  useProjectStore.setState({ projects: [mkProject("p1", "p1-a1")], selectedProjectId: "p1" } as never);
});

describe("effectiveWired — the rule", () => {
  it("passes the patched side through when the far end has an agent", () => {
    expect(effectiveWired("right", true)).toBe("right");
    expect(effectiveWired("left", true)).toBe("left");
  });

  it("reports OFF when the far end is empty, whichever side is patched", () => {
    expect(effectiveWired("right", false)).toBe("off");
    expect(effectiveWired("left", false)).toBe("off");
  });

  it("leaves an unpatched cable off regardless", () => {
    expect(effectiveWired("off", true)).toBe("off");
  });
});

describe("useEffectiveWired — the subscription", () => {
  it("is off at rest", () => {
    expect(renderHook(() => useEffectiveWired()).result.current).toBe("off");
  });

  it("names the patched side while that pair has a selected agent", () => {
    useCableStore.getState().patch("right");
    expect(renderHook(() => useEffectiveWired()).result.current).toBe("right");
  });

  it("reports OFF once that pair's selection is cleared", () => {
    // The state no acquisition guard can prevent, because nothing is being acquired.
    useCableStore.getState().patch("right");
    useProjectStore.setState({ projects: [mkProject("p1", null)] } as never);
    expect(renderHook(() => useEffectiveWired()).result.current).toBe("off");
    // The STORE is untouched — the projection is read-side, so no removal path has to remember to
    // unbind and re-selecting relights it with no second gesture.
    expect(useCableStore.getState().wired).toBe("right");
  });

  it("resolves the LEFT pair against its own project, not the selected one", () => {
    useUiStore.setState({ pairAssignment: { p2: "left" }, leftProjectId: "p2" } as never);
    useProjectStore.setState({
      projects: [mkProject("p1", "p1-a1"), mkProject("p2", "p2-a1")],
      selectedProjectId: "p1",
    } as never);
    useCableStore.getState().patch("left");
    expect(renderHook(() => useEffectiveWired()).result.current).toBe("left");

    // Empty the LEFT pair specifically; the right pair still has a selection and must not rescue it.
    useProjectStore.setState({
      projects: [mkProject("p1", "p1-a1"), mkProject("p2", null)],
    } as never);
    expect(renderHook(() => useEffectiveWired()).result.current).toBe("off");
  });

  it("gives every surface the SAME answer — that is the whole point", () => {
    // Three readers, one value. The bug was three readers and two values.
    useCableStore.getState().patch("right");
    useProjectStore.setState({ projects: [mkProject("p1", null)] } as never);
    expect(renderHook(() => useEffectiveWired()).result.current).toBe("off");
    expect(renderHook(() => usePairIsLive("right")).result.current).toBe(false);
    expect(renderHook(() => usePairIsLive("left")).result.current).toBe(false);
  });
});
