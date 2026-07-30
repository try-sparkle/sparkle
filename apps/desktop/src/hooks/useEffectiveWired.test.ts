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
import { act, renderHook } from "@testing-library/react";
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
  // `openProjectIds: null` is the pre-feature state and means "every project is open"
  // (engine/openProjects) — the seed a fresh install has, so it is what these resolve against.
  useUiStore.setState({ pairAssignment: {}, leftProjectId: null, openProjectIds: null } as never);
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

  it("asks about the side's SELECTED project, not the first one assigned to it", () => {
    // THE FINDING (roborev 55490). The first cut resolved the far end with
    // `projects.find(p => sideOf(assignment, p.id) === wired)` — the first project on that side, over
    // ALL projects — while the shell renders from the side's SELECTED, OPEN project. `sideOf`
    // defaults to "right", so the right pair routinely holds several. Here P1 sits first in the store
    // with a live selection and P2 is the SELECTED project with its last agent closed: the shell
    // draws nothing on the far end, and the projection must agree.
    useProjectStore.setState({
      projects: [mkProject("p1", "p1-a1"), mkProject("p2", null)],
      selectedProjectId: "p2",
    } as never);
    useCableStore.getState().patch("right");
    expect(renderHook(() => useEffectiveWired()).result.current).toBe("off");

    // And the inverse, which the `find` got wrong in the other direction: P1 emptied, selected P2
    // live. Everything drew off while the circuit was real.
    useProjectStore.setState({
      projects: [mkProject("p1", null), mkProject("p2", "p2-a1")],
      selectedProjectId: "p2",
    } as never);
    expect(renderHook(() => useEffectiveWired()).result.current).toBe("right");
  });

  it("ignores a project whose tab is CLOSED, the way the shell does", () => {
    // Closed projects stay in `projects` — closing a tab is a view operation that keeps the panes and
    // PTYs alive — so a projection that reads the raw list answers about a project with no tab.
    useProjectStore.setState({
      projects: [mkProject("p1", "p1-a1"), mkProject("p2", null)],
      selectedProjectId: "p2",
    } as never);
    useUiStore.setState({ openProjectIds: ["p2"] } as never);
    useCableStore.getState().patch("right");
    expect(renderHook(() => useEffectiveWired()).result.current).toBe("off");
  });

  it("REACTS to the pair assignment changing, not just to its value at mount", () => {
    // The assignment was read imperatively through `getState()` inside the projectStore selector, so
    // the hook joined three stores and woke on two. `ConciergeHost` subscribes to no pair state of
    // its own, so it kept a stale snapshot and stayed flooded while the root went off — roborev
    // 55386's contradiction, one store later (roborev 55490).
    useCableStore.getState().patch("right");
    const { result } = renderHook(() => useEffectiveWired());
    expect(result.current).toBe("right");

    // Move the right pair's only project to the LEFT pair. No cable write, no project write.
    act(() => useUiStore.setState({ pairAssignment: { p1: "left" } } as never));
    expect(result.current).toBe("off");
  });

  // THE SUBSCRIPTION'S WIDTH, which is a different property from every row above and was unguarded.
  //
  // Those rows assert the VALUE and its reactivity, and all of them pass identically with the join done
  // outside a `useProjectStore((s) => s.projects)` subscription — the value is the same either way. But
  // that shape wakes every consumer on every `projects` identity replacement (status, rename, prompt,
  // alerts, reorder — dozens of writes), which is a SILENT perf regression that nothing else surfaces,
  // and it defeats MemoAgentSidebar. So the same commit that argued the untested half is the half that
  // regresses had left its own other half untested (roborev 55591).
  //
  // A rename replaces the array and changes nothing about the far end, which is exactly the write this
  // must not wake for.
  it("does NOT re-render on a project write that leaves the far end alone", () => {
    useCableStore.getState().patch("right");
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useEffectiveWired();
    });
    expect(result.current).toBe("right");
    const before = renders;

    act(() => useProjectStore.getState().renameAgent("p1", "p1-a1", "Renamed"));
    // The array identity changed; the answer did not.
    expect(renders).toBe(before);
    expect(result.current).toBe("right");
  });

  it("DOES re-render when that same kind of write changes the far end — the inverse guard", () => {
    // Without this, the row above is satisfied by a hook that never wakes at all.
    useCableStore.getState().patch("right");
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useEffectiveWired();
    });
    const before = renders;

    act(() => useProjectStore.setState({ projects: [mkProject("p1", null)] } as never));
    expect(renders).toBeGreaterThan(before);
    expect(result.current).toBe("off");
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
