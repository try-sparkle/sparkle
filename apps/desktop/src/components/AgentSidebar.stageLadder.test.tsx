// @vitest-environment jsdom
//
// The Build column's stage ladder + status filter, end to end through the real sidebar.
//
// The bug this feature fixes: rows used to be sorted by live PTY status, so a `working ⇄ idle ⇄
// waiting` flip moved a row across a whole tier and the column re-shuffled under the cursor — even
// on the silent 15s poll tick. The load-bearing assertion in this file is "a status change does not
// move a row"; everything else is the scaffolding that makes that readable.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import type { WorkflowStageId } from "../engine/workflowStage";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

function seed(agents: AgentTab[]): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents,
  };
  useProjectStore.setState({ projects: [project] } as never);
  return project;
}

const proj = () => useProjectStore.getState().projects[0]!;

/** Put each agent at a workflow stage via the runtime store's stage override. */
function setStages(stages: Record<string, WorkflowStageId>) {
  useRuntimeStore.setState({ workflowStage: stages } as never);
}
function setStatuses(status: Record<string, AgentTabStatus>) {
  useRuntimeStore.setState({ status } as never);
}

/** Row names in rendered DOM order — the thing the user actually sees. */
function renderedNames(names: string[]): string[] {
  const found = names
    .map((n) => ({ n, el: screen.queryByText(n) }))
    .filter((x): x is { n: string; el: HTMLElement } => x.el != null);
  return found
    .sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    .map((x) => x.n);
}

beforeEach(() => {
  useRuntimeStore.setState({ status: {}, workflowStage: {}, branchStatus: {} } as never);
  useUiStore.getState().showAllStatusBands();
});
afterEach(() => cleanup());

describe("AgentSidebar — the stage ladder", () => {
  it("groups rows under their stage section, in ladder order", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta"), mkAgent("a3", "Gamma")]);
    setStages({ a1: "pull_request", a2: "building_unsaved", a3: "merged" });
    render(<AgentSidebar project={project} />);

    // Beta (uncommitted) → Alpha (PR) → Gamma (merged), regardless of array order.
    expect(renderedNames(["Alpha", "Beta", "Gamma"])).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(screen.getByTestId("stage-header-local_uncommitted")).toBeTruthy();
    expect(screen.getByTestId("stage-header-remote_pr")).toBeTruthy();
    expect(screen.getByTestId("stage-header-remote_merged")).toBeTruthy();
  });

  it("renders NO header for a stage with no rows", () => {
    const project = seed([mkAgent("a1", "Alpha")]);
    setStages({ a1: "pull_request" });
    render(<AgentSidebar project={project} />);
    expect(screen.getByTestId("stage-header-remote_pr")).toBeTruthy();
    expect(screen.queryByTestId("stage-header-local_committed")).toBeNull();
    expect(screen.queryByTestId("stage-header-remote_shipped")).toBeNull();
  });

  it("does NOT move a row when its status changes — the whole point", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta"), mkAgent("a3", "Gamma")]);
    setStages({ a1: "building_saved", a2: "building_saved", a3: "building_saved" });
    setStatuses({ a1: "idle", a2: "idle", a3: "idle" });
    const { rerender } = render(<AgentSidebar project={project} />);
    expect(renderedNames(["Alpha", "Beta", "Gamma"])).toEqual(["Alpha", "Beta", "Gamma"]);

    // Beta starts asking a question and Gamma starts working. Under the OLD attention sort Beta
    // (rank 0) would jump to the top and Gamma (rank 2) to the bottom.
    setStatuses({ a1: "idle", a2: "waiting", a3: "working" });
    rerender(<AgentSidebar project={proj()} />);
    expect(renderedNames(["Alpha", "Beta", "Gamma"])).toEqual(["Alpha", "Beta", "Gamma"]);

    // And an errored row still doesn't move.
    setStatuses({ a1: "errored", a2: "idle", a3: "idle" });
    rerender(<AgentSidebar project={proj()} />);
    expect(renderedNames(["Alpha", "Beta", "Gamma"])).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("DOES move a row when its stage advances", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")]);
    setStages({ a1: "building_unsaved", a2: "merged" });
    const { rerender } = render(<AgentSidebar project={project} />);
    expect(renderedNames(["Alpha", "Beta"])).toEqual(["Alpha", "Beta"]);

    // Alpha's PR merges — it joins Beta in the Merged section, below it (array order within a stage).
    setStages({ a1: "merged", a2: "merged" });
    rerender(<AgentSidebar project={proj()} />);
    expect(screen.queryByTestId("stage-header-local_uncommitted")).toBeNull();
    expect(renderedNames(["Alpha", "Beta"])).toEqual(["Alpha", "Beta"]);
  });
});

describe("AgentSidebar — the status filter", () => {
  it("shows all three chips with their counts, all on by default", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta"), mkAgent("a3", "Gamma")]);
    setStatuses({ a1: "waiting", a2: "working", a3: "idle" });
    render(<AgentSidebar project={project} />);
    for (const b of ["needs_you", "running", "done"]) {
      expect(screen.getByTestId(`status-chip-${b}`).getAttribute("data-on")).toBe("true");
    }
  });

  it("renders the count ALONE — the band name lives on aria-label, not in the chip", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta"), mkAgent("a3", "Gamma")]);
    setStatuses({ a1: "waiting", a2: "working", a3: "idle" });
    render(<AgentSidebar project={project} />);
    // The words never fit at sidebar width ("2 Needs you" truncated to "2 Need…"), so the chip is
    // dot + count. If a label creeps back into the chip body it truncates again.
    for (const b of ["needs_you", "running", "done"]) {
      expect(screen.getByTestId(`status-chip-${b}`).textContent).toBe("1");
    }
    // ...but the band must still be NAMED somewhere, or three bare dots are unidentifiable.
    expect(screen.getByTestId("status-chip-needs_you").getAttribute("aria-label")).toContain(
      "1 Needs you",
    );
    expect(screen.getByTestId("status-chip-running").getAttribute("aria-label")).toContain(
      "1 Running",
    );
    expect(screen.getByTestId("status-chip-done").getAttribute("aria-label")).toContain("1 Done");
  });

  it("pluralizes the verb in the accessible name: '1 Needs you' but '2 Need you'", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")]);
    setStatuses({ a1: "waiting", a2: "approval" });
    render(<AgentSidebar project={project} />);
    const label = screen.getByTestId("status-chip-needs_you").getAttribute("aria-label") ?? "";
    expect(label).toContain("2 Need you");
    expect(label).not.toContain("2 Needs you");
  });

  it("clicking a chip hides that band's rows", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")]);
    setStages({ a1: "building_saved", a2: "building_saved" });
    setStatuses({ a1: "working", a2: "idle" });
    render(<AgentSidebar project={project} />);
    expect(screen.queryByText("Alpha")).toBeTruthy();

    fireEvent.click(screen.getByTestId("status-chip-running"));
    expect(screen.queryByText("Alpha")).toBeNull(); // the working row is gone
    expect(screen.queryByText("Beta")).toBeTruthy(); // the idle one stays
    expect(screen.getByTestId("status-chip-running").getAttribute("data-on")).toBe("false");
  });

  it("keeps showing the count of a HIDDEN band, so nothing is silently lost", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")]);
    setStatuses({ a1: "working", a2: "idle" });
    render(<AgentSidebar project={project} />);
    fireEvent.click(screen.getByTestId("status-chip-running"));
    // Still says 1 — counted over the UNFILTERED rows. A hidden band reading "0" would leave the
    // user with no idea anything is behind it.
    expect(screen.getByTestId("status-chip-running").textContent).toBe("1");
    expect(screen.getByTestId("status-chip-running").getAttribute("aria-label")).toContain(
      "1 Running",
    );
  });

  it("offers Reset only once a band is off, and it restores every band", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")]);
    setStatuses({ a1: "working", a2: "idle" });
    render(<AgentSidebar project={project} />);
    // Nothing is filtered yet, so Reset is not OFFERED — but it stays MOUNTED, invisible and
    // disabled. Unmounting it re-flows the row and, worse, blurs it on the very click that
    // succeeds, which is what stranded keyboard focus on <body> (see StatusFilterBar's slot
    // comment). So "not offered" is asserted as the state a user can actually perceive, rather
    // than as absence from the DOM.
    const resetBtn = () => screen.getByTestId("status-filter-reset") as HTMLButtonElement;
    expect(resetBtn().style.visibility).toBe("hidden");
    expect(resetBtn().disabled).toBe(true);

    fireEvent.click(screen.getByTestId("status-chip-running"));
    expect(screen.queryByText("Alpha")).toBeNull();

    fireEvent.click(screen.getByTestId("status-filter-reset"));
    expect(screen.queryByText("Alpha")).toBeTruthy();
    for (const b of ["needs_you", "running", "done"]) {
      expect(screen.getByTestId(`status-chip-${b}`).getAttribute("data-on")).toBe("true");
    }
    // And it retires itself again — there is nothing left to reset.
    // And it retires itself again — there is nothing left to reset.
    expect(resetBtn().style.visibility).toBe("hidden");
    expect(resetBtn().disabled).toBe(true);
  });

  it("hides a section the filter emptied, header and all", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")]);
    setStages({ a1: "building_unsaved", a2: "pull_request" });
    setStatuses({ a1: "working", a2: "idle" });
    render(<AgentSidebar project={project} />);
    expect(screen.getByTestId("stage-header-local_uncommitted")).toBeTruthy();

    fireEvent.click(screen.getByTestId("status-chip-running"));
    expect(screen.queryByTestId("stage-header-local_uncommitted")).toBeNull();
    expect(screen.getByTestId("stage-header-remote_pr")).toBeTruthy();
  });

  it("offers a way back when every band is toggled off", () => {
    const project = seed([mkAgent("a1", "Alpha")]);
    setStatuses({ a1: "idle" });
    render(<AgentSidebar project={project} />);
    for (const b of ["needs_you", "running", "done"]) {
      fireEvent.click(screen.getByTestId(`status-chip-${b}`));
    }
    expect(screen.queryByText("Alpha")).toBeNull();
    // An empty column with no explanation reads as data loss; the escape hatch has to be visible.
    const showAll = screen.getByText("Show all");
    fireEvent.click(showAll);
    expect(screen.queryByText("Alpha")).toBeTruthy();
  });

  it("wraps rather than overflowing — the sidebar drags down to 160px", () => {
    const project = seed([mkAgent("a1", "Alpha")]);
    setStatuses({ a1: "working" });
    render(<AgentSidebar project={project} />);
    // STALE RATIONALE REPLACED. This used to reason about the SCROLL CONTAINER's `overflowY: auto`
    // forcing overflow-x to `auto`; the bar does not live in that container any more — it moved
    // into the `.bhd` column header. The need is the same and the geometry is tighter: the header
    // hands the bar only what the mini Build/Plan segment leaves, so at the sidebar's MIN_WIDTH of
    // 160 the bar must be able to wrap BOTH ways — the header wraps it onto a full-width second
    // line (asserted below), and this inner wrap then keeps `Reset` on the row instead of letting
    // a nowrap, unshrinkable control overflow a container that sets no overflow.
    expect(screen.getByTestId("status-filter-bar").style.flexWrap).toBe("wrap");
  });

  // THE OTHER HALF OF THAT WRAP, and the one the move introduced. The bar is the only item in the
  // header with a real shrink share — the mini segment is `0 0 auto` (~80px) and the spacer's basis
  // is 0 — so without a wrap on the BAND the bar absorbs the whole deficit: ~42px at MIN_WIDTH,
  // narrower than a single chip, every chip on its own line, `Reset` overflowing. jsdom performs no
  // layout, so this is asserted as the two properties that make the wrap possible rather than as a
  // measured height.
  it("lets the header drop the whole bar to a second line, rather than squeezing it", () => {
    const project = seed([mkAgent("a1", "Alpha")]);
    setStatuses({ a1: "working" });
    render(<AgentSidebar project={project} />);

    expect(screen.getByTestId("build-column-header").style.flexWrap).toBe("wrap");
    // `auto` basis, so the bar's hypothetical size is its max-content width and the header's wrap
    // fires at all — flex resolves wrapping BEFORE shrinking. A `0` basis would silently restore
    // the squeeze with this file still green.
    expect(screen.getByTestId("status-filter-bar").style.flexBasis).toBe("auto");
    // GROW 0, and this row used to demand 1 — locking in a layout regression. Only the BASIS makes
    // the wrap possible; grow decides what happens to the leftover space in the WIDE case, and
    // grow:1 split it 50/50 with the header's spacer, pushing the chips roughly halfway back off
    // the pane-side edge. The mock has the spacer take all of it (`.bhd .sp{flex:1}`) so the chips
    // sit flush there (roborev 54779). Asserted rather than dropped so the wide case has a guard.
    expect(screen.getByTestId("status-filter-bar").style.flexGrow).toBe("0");
  });

  it("does not render the filter at all when the project has no agents", () => {
    const project = seed([]);
    render(<AgentSidebar project={project} />);
    expect(screen.queryByTestId("status-filter-bar")).toBeNull();
  });
});

describe("AgentSidebar — drag is confined to a stage section", () => {
  const draggableCards = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[draggable="true"]'));

  it("offers drop targets only within the dragged row's own section", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta"), mkAgent("a3", "Gamma")]);
    // Alpha + Beta share a section; Gamma is alone in another.
    setStages({ a1: "building_saved", a2: "building_saved", a3: "merged" });
    render(<AgentSidebar project={project} />);

    fireEvent.dragStart(draggableCards()[0]!); // grab Alpha, in local_committed
    // Two targets, not three: Gamma's row (a different section) offers none. A row that lights up
    // and then refuses the drop reads as a bug, so it never lights up.
    expect(screen.getAllByTestId("agent-drop-target")).toHaveLength(2);
  });

  it("reorders within a section", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")]);
    setStages({ a1: "building_saved", a2: "building_saved" });
    render(<AgentSidebar project={project} />);
    fireEvent.dragStart(draggableCards()[1]!); // grab Beta
    fireEvent.drop(screen.getAllByTestId("agent-drop-target")[0]!); // onto Alpha's row
    expect(proj().agents.map((a) => a.id)).toEqual(["a2", "a1"]);
  });
});

describe("AgentSidebar — an orchestrator's section matches its own progress bar", () => {
  it("buckets a delegating orchestrator by the WORKER ROLL-UP, not its own bare git state", () => {
    // The two signals used to be computed differently: the section from the head's own git state,
    // the bar from rollupStages(workers). For any orchestrator that delegates they disagreed BY
    // CONSTRUCTION — a head with no commits of its own sat under "Local: Uncommitted" ("closing
    // this agent loses them") while the bar on that very row showed its workers at "In PR"
    // (roborev 53371). The section is the load-bearing claim about where the work got to, so the
    // two must come from one value.
    const head = mkAgent("h1", "Orchestrator");
    const worker = mkAgent("w1", "Worker", { kind: "worker", parentId: "h1" });
    const project = seed([head, worker]);
    // Head has no commits of its own; its single worker has an open PR.
    setStages({ h1: "building_unsaved", w1: "pull_request" });
    render(<AgentSidebar project={project} />);

    expect(screen.getByTestId("stage-header-remote_pr")).toBeTruthy();
    expect(screen.queryByTestId("stage-header-local_uncommitted")).toBeNull();
  });

  it("rolls up to the LEAST-advanced worker — the whole build isn't done until every unit is", () => {
    const head = mkAgent("h1", "Orchestrator");
    const project = seed([
      head,
      mkAgent("w1", "Fast", { kind: "worker", parentId: "h1" }),
      mkAgent("w2", "Slow", { kind: "worker", parentId: "h1" }),
    ]);
    setStages({ h1: "merged", w1: "merged", w2: "building_saved" });
    render(<AgentSidebar project={project} />);
    // One laggard worker holds the whole row at Committed, even though the head itself has landed.
    expect(screen.getByTestId("stage-header-local_committed")).toBeTruthy();
    expect(screen.queryByTestId("stage-header-remote_merged")).toBeNull();
  });

  it("falls back to its own stage when it has no workers", () => {
    const project = seed([mkAgent("h1", "Solo")]);
    setStages({ h1: "pushed" });
    render(<AgentSidebar project={project} />);
    expect(screen.getByTestId("stage-header-remote_pushed")).toBeTruthy();
  });
});

describe("AgentSidebar — selection never lands on a filtered-out row", () => {
  it("switching Plan→Build selects the first RENDERED row, not project.agents[0]", () => {
    // The bug three reviews found independently (roborev 53428/53439/53440): both Plan→Build
    // handlers used `firstVisibleAgentId`, which is plain array order and knows nothing about the
    // ladder or the filter. Hide a band, switch modes, and the pane shows a terminal for an agent
    // with no row beside it.
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")]);
    setStages({ a1: "building_saved", a2: "building_saved" });
    setStatuses({ a1: "working", a2: "idle" });
    useUiStore.getState().isolateStatusBand("done"); // Alpha (working) is now hidden

    render(<AgentSidebar project={project} />);
    // Sanity: the column really is rendering only Beta.
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Beta")).toBeTruthy();

    // Switch to Plan and back to Build via the chevrons.
    fireEvent.click(screen.getByText("Plan"));
    fireEvent.click(screen.getByText("Build"));

    // Selection must be Beta — the row actually on screen — not Alpha (array index 0, hidden).
    expect(proj().selectedAgentId).toBe("a2");
  });

  it("isolateStatusBand shows exactly that band and nothing else", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta"), mkAgent("a3", "Gamma")]);
    setStatuses({ a1: "waiting", a2: "working", a3: "idle" });
    render(<AgentSidebar project={project} />);

    // This is what a helper-island chiclet click does.
    act(() => useUiStore.getState().isolateStatusBand("needs_you"));
    expect(screen.queryByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();
    expect(screen.queryByText("Gamma")).toBeNull();
    // And the chip bar SHOWS that state, so the user can see why and clear it the normal way.
    expect(screen.getByTestId("status-chip-needs_you").getAttribute("data-on")).toBe("true");
    expect(screen.getByTestId("status-chip-running").getAttribute("data-on")).toBe("false");
  });
});
