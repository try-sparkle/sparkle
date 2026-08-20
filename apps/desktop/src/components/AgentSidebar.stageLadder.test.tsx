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
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { childRowOf, subtreeGroupExists } from "./subtreeTestUtils";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useBeadsStore } from "../stores/beadsStore";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import type { WorkflowStageId } from "../engine/workflowStage";
import { openAgentCard } from "../testing/rowGestures";

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

/** The minimum a bead needs to be walked by `descendantsOf` — id and parent edge. */
function mkBead(id: string, parent: string | null = null) {
  return {
    id, title: id, type: "task", status: "open", parent,
    labels: [], dependencies: [], priority: 2, description: "",
  } as never;
}

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
    //
    // DONE READS 2, NOT 1, AND THAT IS THE POINT. The three project agents contribute one per band;
    // the second Done is the pinned "Improve Sparkle" row, which has no live status here and so
    // falls back to `stopped`. It counts in the tally like any other row — a red Improve Sparkle
    // that left the red chip on 0 would be the same defect as a collapsed worker that doesn't
    // count: the number would claim nothing needs you while something did.
    const expected: Record<string, string> = { needs_you: "1", running: "1", done: "2" };
    for (const b of ["needs_you", "running", "done"]) {
      expect(screen.getByTestId(`status-chip-${b}`).textContent).toBe(expected[b]);
    }
    // ...but the band must still be NAMED somewhere, or three bare dots are unidentifiable.
    expect(screen.getByTestId("status-chip-needs_you").getAttribute("aria-label")).toContain(
      "1 Needs you",
    );
    expect(screen.getByTestId("status-chip-running").getAttribute("aria-label")).toContain(
      "1 Running",
    );
    expect(screen.getByTestId("status-chip-done").getAttribute("aria-label")).toContain("2 Done");
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
  });

  // THE WIDE CASE, which is the common one and which the wrap fix regressed on its first pass. The
  // basis above is what makes the narrow-width wrap possible; GROW is a separate knob and must stay
  // 0. The band is `segment (0 0 auto) · spacer (flex:1) · bar`, and the mock hands the spacer alone
  // the free space (`.bhd .sp{flex:1}`) so the chips sit flush at the pane-side edge. Giving the bar
  // grow:1 as well splits that space 50/50, which walks the chip cluster back toward the middle of
  // the header AND — because `Reset` is permanently mounted at `marginLeft: auto` — dumps the bar's
  // whole share into the gap in front of it, the one place that margin exists to keep still. Grow
  // buys the wrap nothing either: once the bar is alone on the wrapped line it fills that line
  // regardless. Asserted as the RELATIONSHIP (spacer grows, bar does not) because either half on its
  // own reads as an arbitrary number a later pass would feel free to "tidy".
  it("gives the header's free space to the spacer alone, so the chips stay flush right", () => {
    const project = seed([mkAgent("a1", "Alpha")]);
    setStatuses({ a1: "working" });
    render(<AgentSidebar project={project} />);

    expect(screen.getByTestId("build-header-spacer").style.flexGrow).toBe("1");
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

    // Via the STORE ACTIONS the surviving controls call, not via a button in this column — the
    // Build/Plan toggle that used to sit here is retired, and the rule deliberately no longer hangs
    // off any one control. `openPlanBoard`/`showBuildStage` are exactly what the Epics header's
    // "Open Planning Board" link and the board's "Close Planning Board" link invoke, so this drives
    // the production path; the button that reaches them is asserted in the Workspace-level suites.
    act(() => {
      useUiStore.getState().openPlanBoard("right");
    });
    act(() => {
      useUiStore.getState().showBuildStage("right");
    });

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

describe("the `local_none` rung is actually WIRED to the column (roborev 57842)", () => {
  // WHY THIS BLOCK EXISTS. `holdsWorkOf` is OPTIONAL on both `groupAgentsByStage` and
  // `firstLadderRowId`, so deleting the argument from any production call site is not a type error.
  // Before these tests, `local_none` appeared only in pure-function unit tests — every component
  // test here seeds `branchStatus: {}`, so every row read `undefined` and the whole rung was
  // invisible to the suite. It could have been silently removed from the UI with everything green,
  // which is precisely the drift the comments on `groupAgentsByStage` and `ladderSelection` claim is
  // impossible.

  /** A worktree reading as Rust sends it. `worktreeOnBranch: true` is required — a parked tree reads
   *  `undefined` and would put the row straight back in `local_uncommitted`. */
  const bs = (dirty: boolean) => ({
    ahead: 0, behind: 0, dirty, filesChanged: 0, insertions: 0, deletions: 0,
    worktreeOnBranch: true, dirtyFiles: dirty ? ["src/x.ts"] : [], dirtyCount: dirty ? 1 : 0,
  });

  it("files a CLEAN pre-commit row under `local_none` and a DIRTY one under `local_uncommitted`", () => {
    // THE DIRTY ROW IS SEEDED FIRST, ON PURPOSE (roborev 57877). An earlier version of this test put
    // "Cleanly" first in the array and asserted the rendered order was ["Cleanly", "Dirty"] — which
    // `groupAgentsByStage` preserves input order within and across buckets, so that expectation was
    // ALREADY TRUE before the split and stayed true with `holdsWorkOf` dropped entirely. It proved
    // nothing about the claim its own comment made. With array order and section order in
    // DISAGREEMENT, only the section split can produce the expected result.
    const project = seed([mkAgent("a1", "Dirty"), mkAgent("a2", "Cleanly")]);
    setStages({ a1: "building_unsaved", a2: "building_unsaved" });
    setStatuses({ a1: "idle", a2: "idle" });
    useRuntimeStore.setState({ branchStatus: { a1: bs(true), a2: bs(false) } } as never);
    render(<AgentSidebar project={project} />);

    expect(screen.getByTestId("stage-header-local_none")).toBeTruthy();
    expect(screen.getByTestId("stage-header-local_uncommitted")).toBeTruthy();
    // The clean row sorts ABOVE the dirty one despite being SECOND in the array.
    expect(renderedNames(["Cleanly", "Dirty"])).toEqual(["Cleanly", "Dirty"]);
  });

  it("keeps an UNREAD row in `local_uncommitted` — no branchStatus, no calmer heading", () => {
    // The conservative arm, asserted through the real column rather than the pure function: with the
    // store empty (as every other test in this file leaves it) the rung must not appear at all.
    const project = seed([mkAgent("a1", "Alpha")]);
    setStages({ a1: "building_unsaved" });
    render(<AgentSidebar project={project} />);
    expect(screen.queryByTestId("stage-header-local_none")).toBeNull();
    expect(screen.getByTestId("stage-header-local_uncommitted")).toBeTruthy();
  });

  it("renders NO row chip at all for a `local_none` row — it must not say 'Empty'", () => {
    // ══ THE RULE CHANGED, AND THIS IS THE STRONGER FORM OF IT (bead sparkle-tyter) ═══════════
    // roborev 57842 found a contradiction — the heading said "nothing here is at risk" while the
    // row beneath rendered the `building_unsaved` chip, whose tooltip reads "closing now loses this
    // work" — and `honestStageMeta` fixed it by substituting the word "Empty". The founder's
    // verdict on seeing that: *"If it's empty, we shouldn't say empty."* He is right: the chip costs
    // the same row width whatever it says, and the SECTION HEADING above the row already carries
    // the fact. So the row chip is now silent for this case entirely.
    //
    // This is strictly stronger than the assertion it replaces — an absent chip cannot contradict
    // the heading — and the honesty rule it came from is still covered, by the two card tests
    // below (the expanded card DOES still render "Nothing Built Yet" with its detail sentence,
    // which is the surface with room for it).
    const project = seed([mkAgent("a1", "Cleanly")]);
    setStages({ a1: "building_unsaved" });
    setStatuses({ a1: "idle" });
    useRuntimeStore.setState({ branchStatus: { a1: bs(false) } } as never);
    render(<AgentSidebar project={project} />);

    expect(screen.queryByTestId("row-stage-chip")).toBeNull();
    // …and the word itself appears nowhere on the row. `[data-hint="agent"]` is the row's REAL
    // attribute (roborev 58758): this read `[data-agent-row]`, which exists nowhere in the source,
    // so `closest()` returned null, `?? ""` swallowed it, and the check passed against the empty
    // string no matter what the row said. Non-null asserted first, so a renamed row fails here
    // instead of silently satisfying the assertion.
    const row = screen.getByText("Cleanly").closest('[data-hint="agent"]');
    expect(row, "the agent row must be findable for this assertion to mean anything").not.toBeNull();
    expect(row!.textContent).not.toContain("Empty");
  });

  it("the expanded CARD receives the section — the wiring, not just the rule", () => {
    // roborev 57902. WorkflowLine's own tests cover the copy RULE, but nothing asserted that
    // AgentSidebar actually passes `rowSection` to it: deleting the prop left the whole suite green.
    // An unverified path is exactly how this lie survived two previous fixes, so the wiring gets its
    // own end-to-end assertion, mutation-checked by removing the prop.
    //
    // The card opens on RIGHT click (`onContextMenu={openCard}`), not hover-in-jsdom.
    const project = seed([mkAgent("a1", "Cleanly")]);
    setStages({ a1: "building_unsaved" });
    setStatuses({ a1: "idle" });
    useRuntimeStore.setState({ branchStatus: { a1: bs(false) } } as never);
    render(<AgentSidebar project={project} />);

    openAgentCard(screen.getByText("Cleanly"));
    const line = screen.getByTestId("card-workflow-line");
    expect(line.textContent).not.toMatch(/loses this work/);
    expect(line.textContent).toMatch(/nothing here is at risk/);
  });

  it("…and the card still WARNS on a genuinely dirty row", () => {
    // The control. Without it, dropping the copy for every card line would satisfy the case above
    // while destroying the warning the dirty row actually needs.
    const project = seed([mkAgent("a1", "Dirty")]);
    setStages({ a1: "building_unsaved" });
    setStatuses({ a1: "idle" });
    useRuntimeStore.setState({ branchStatus: { a1: bs(true) } } as never);
    render(<AgentSidebar project={project} />);

    openAgentCard(screen.getByText("Dirty"));
    expect(screen.getByTestId("card-workflow-line").textContent).toMatch(/loses this work/);
  });

  it("STILL says unsaved on a genuinely dirty row — the override is not blanket", () => {
    const project = seed([mkAgent("a1", "Dirty")]);
    setStages({ a1: "building_unsaved" });
    setStatuses({ a1: "idle" });
    useRuntimeStore.setState({ branchStatus: { a1: bs(true) } } as never);
    render(<AgentSidebar project={project} />);

    const chip = screen.getByTestId("row-stage-chip");
    expect(chip.textContent).toBe("Unsaved");
    expect(chip.getAttribute("title")).toMatch(/loses this work/);
  });
});

// ══ SELECTING A WORKER STICKS ══════════════════════════════════════════════════════════════════
//
// The regression roborev caught in review (job 65606) before it shipped, and the reason the
// "arrive in Build" rule is a TRANSITION rather than a standing invariant.
//
// The first cut of that effect answered "is my selection still rendered?" by re-running the ladder
// derivation over a ONE-AGENT population. `isTopLevelAgent` drops `kind: "worker"` unconditionally,
// so a selected worker always came back "not rendered" — and since selecting one produces a new
// `project` object, the effect re-fired and immediately re-seated the head. A user could not select
// a worker in Build mode at all: every click bounced up to its orchestrator.
//
// The whole suite was green through that, because nothing here selected a worker. This is that
// missing case, and it asserts the SIDE EFFECT — where the selection ended up — not that a handler
// ran.
describe("AgentSidebar — a worker row can be selected in Build mode", () => {
  // THE TRANSITION IS THE POINT, and seeding it is not optional scaffolding. `mode` reads
  // `workModeBySide`, whose default is `{left:"build", right:"build"}` — so a test that never
  // writes it leaves the effect UNREACHABLE: `prev === null` returns on the first run (mount is not
  // a transition) and `prev === "build"` returns on every run after. An earlier version of this
  // case asserted `selectedAgentId` without seeding the mode, and so was asserting only the store
  // write it had performed two lines earlier — the precondition, not the side effect. It passed
  // against every mutation of the code it names, including deleting the guard outright.
  type Rerender = ReturnType<typeof render>["rerender"];
  function arriveInBuild(rerender: Rerender) {
    act(() => {
      useUiStore.setState({ workModeBySide: { left: "build", right: "build" } } as never);
    });
    rerender(<AgentSidebar project={proj()} />);
  }

  beforeEach(() => {
    // Start in Plan on BOTH sides, so whichever side `sideOf(p1)` resolves to has a real
    // `plan → build` edge to travel. Set before the first render: `prevModeRef` latches on mount.
    useUiStore.setState({ workModeBySide: { left: "plan", right: "plan" } } as never);
  });

  it("leaves the selection ON the worker rather than bouncing it to the orchestrator", () => {
    const head = mkAgent("h1", "Head");
    const worker = mkAgent("w1", "Worker", { kind: "worker", parentId: "h1" });
    seed([head, worker]);
    setStages({ h1: "building_saved", w1: "building_saved" });
    useRuntimeStore.setState({ openAgentIds: ["h1", "w1"] } as never);
    // The head must be EXPANDED, or the worker is not a rendered row and the premise below is false
    // — a closed head draws only a one-line peek. `false` means "not collapsed".
    useUiStore.setState({ collapsedOrchestrators: { h1: false } } as never);

    // RE-RENDERED WITH THE NEW PROJECT, not just written to the store. `project` is a PROP here, so
    // a store write alone leaves this component holding the object it was given — the effect never
    // re-runs and the test cannot reproduce the bug it is written for. `Workspace` passes a live
    // project, so re-rendering is what production actually does.
    const { rerender } = render(<AgentSidebar project={proj()} />);

    act(() => {
      useProjectStore.setState({
        projects: [{ ...proj(), selectedAgentId: "w1" }],
      } as never);
    });
    rerender(<AgentSidebar project={proj()} />);

    arriveInBuild(rerender);

    // The premise, asserted AFTER arriving: the worker really is a row the column renders, or "it
    // stayed selected" would be a statement about a row that was never there. `childRowOf` is
    // scoped to the head's subtree group, so a closed head's one-line PEEK cannot satisfy it.
    expect(subtreeGroupExists("h1")).toBe(true);
    expect(childRowOf("h1", "Worker")).toBe(true);

    expect(proj().selectedAgentId).toBe("w1");
  });

  // THE CONTROL. Without it, the case above is satisfied by an effect that never fires at all —
  // which is exactly the defect it was rewritten to close. This proves the SAME setup DOES reach
  // the re-seating branch when the selection is genuinely absent, so the assertion above is a
  // statement about the membership rule rather than about an inert effect.
  it("DOES re-seat the selection when it names an agent the column does not render", () => {
    const head = mkAgent("h1", "Head");
    seed([head]);
    setStages({ h1: "building_saved" });
    useRuntimeStore.setState({ openAgentIds: ["h1"] } as never);

    act(() => {
      useProjectStore.setState({
        projects: [{ ...proj(), selectedAgentId: "ghost" }],
      } as never);
    });
    const { rerender } = render(<AgentSidebar project={proj()} />);
    arriveInBuild(rerender);

    expect(proj().selectedAgentId).toBe("h1");
  });

  // THE EPIC FILTER IS NOT AN ABSENCE. A selection hidden by the epic narrowing is out of
  // `renderedRowIds` for a reason that has nothing to do with the row being gone, so re-seating it
  // would `open()` another agent and re-patch the cable — and pressing Clear afterwards would
  // restore a column showing a DIFFERENT terminal than the user left.
  it("leaves an epic-filtered selection alone rather than re-seating it", () => {
    // The narrowing reads each agent's OWN `beadId` against the epic's bead set, so membership is
    // seeded on the agents themselves. `e1.1` is under epic `e1` by dotted id; `z9.1` is not.
    const a = mkAgent("a1", "Alpha", { beadId: "e1.1" } as Partial<AgentTab>);
    const b = mkAgent("b1", "Bravo", { beadId: "z9.1" } as Partial<AgentTab>);
    seed([a, b]);
    setStages({ a1: "building_saved", b1: "building_saved" });
    useRuntimeStore.setState({ openAgentIds: ["a1", "b1"] } as never);
    useBeadsStore.setState({
      byProject: { p1: { beads: [mkBead("e1"), mkBead("e1.1"), mkBead("z9.1")] } },
    } as never);

    act(() => {
      useProjectStore.setState({
        projects: [{ ...proj(), selectedAgentId: "b1" }],
      } as never);
    });
    const { rerender } = render(<AgentSidebar project={proj()} />);

    // Narrow to an epic that contains ONLY a1, hiding the selected b1.
    act(() => {
      useUiStore.setState({ epicFocusBySide: { left: "e1", right: "e1" } } as never);
    });
    rerender(<AgentSidebar project={proj()} />);

    arriveInBuild(rerender);

    expect(proj().selectedAgentId).toBe("b1");
  });
});
