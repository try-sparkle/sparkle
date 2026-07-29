// @vitest-environment jsdom
//
// A worker subtree that OPENS ITSELF must also CLOSE ITSELF.
//
// Expansion was one-way: `expandOrchestrators` only ever wrote `false`, and nothing but the user's
// chevron wrote `true` back. The asymmetry was deliberate — yanking a subtree shut while someone is
// reading it is worse than leaving it open — but it is only true of the subtree being READ. For
// every other one it meant a settled fleet left a wall of green worker rows whose only undo was a
// chevron click per orchestrator.
//
// The rule these tests pin: a subtree the APP opened closes once nothing under it needs you, EXCEPT
// the one you are reading and EXCEPT one you opened yourself. The pure rule is unit-tested in
// engine/workerExpansion; this file proves the sidebar is wired to it, including both exemptions —
// which are the whole reason the feature is safe.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  // The sidebar's own poll tick calls this on mount. Stubbed so the suite doesn't print a page of
  // "no export defined on the mock" noise per test for a call none of these assertions read. It must
  // resolve to an ARRAY — pollProjectStatus spreads the result, so `{}` turns the quiet stub into an
  // unhandled "results is not iterable" rejection that fails the file.
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, AgentTabStatus, Project } from "../types";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

const open = vi.fn();

/** Two orchestrators; "Alpha" has two workers, "Beta" one. Every worker starts LIVE and calm
 *  (`working`), which is load-bearing twice over: a worker with no live PTY status is treated as
 *  CALM by `workerAttention` however red the overlays paint it (the synthetic strand red), so a test
 *  about red needs the fleet actually up. */
function seed(selectedAgentId: string | null = null): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId,
    agents: [
      mkAgent("a1", "Alpha"),
      mkAgent("w1", "Parser Worker", { kind: "worker", parentId: "a1", baseBranch: "main" }),
      mkAgent("w2", "Lexer Worker", { kind: "worker", parentId: "a1", baseBranch: "main" }),
      mkAgent("a2", "Beta"),
      mkAgent("w3", "Docs Worker", { kind: "worker", parentId: "a2", baseBranch: "main" }),
    ],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {}, workflowShipped: {},
    status: { ...ALL_WORKING },
    openAgentIds: ["a1", "w1", "w2", "a2", "w3"],
    open,
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

/** A SECOND project, for the switch cases. Ids disjoint from `seed`'s, and the status map is global
 *  across projects — which is exactly why a worker here can go red while you are looking elsewhere. */
const OTHER: Project = {
  id: "p2", name: "Other", rootPath: "/tmp/other", defaultBranch: "main",
  createdAt: new Date(0).toISOString(), selectedAgentId: null,
  agents: [
    mkAgent("b1", "Gamma"),
    mkAgent("bw1", "Gamma Worker", { kind: "worker", parentId: "b1", baseBranch: "main" }),
  ],
};

const ALL_WORKING: Record<string, AgentTabStatus> = {
  a1: "working", w1: "working", w2: "working", a2: "working", w3: "working",
  b1: "working", bw1: "working",
};

/** Push a new live-status map through the runtime store, the way a PTY status event does. */
function setStatus(status: Record<string, AgentTabStatus>) {
  act(() => {
    useRuntimeStore.setState({ status } as never);
  });
}

const queryRow = (name: string) => screen.queryByText(name);
const collapsed = (id: string) => useUiStore.getState().collapsedOrchestrators[id];
const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
/** The user's own fold gesture. The chevron button is gone — a head row's own left click toggles its
 *  subtree (and selects it), so this is what "expanded it by hand" means now. */
const toggleByHand = (name: string) => fireEvent.click(rowFor(name));
/** Move the selection, the way clicking another row does, and re-render with the new project. */
function selectAgent(project: Project, id: string | null, rerender: (ui: React.ReactElement) => void) {
  const next: Project = { ...project, selectedAgentId: id };
  useProjectStore.setState({ projects: [next] } as never);
  rerender(<AgentSidebar project={next} />);
  return next;
}

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {},
    autoExpandedOrchestrators: {},
    activeSpecial: null,
  } as never);
  open.mockClear();
});
afterEach(cleanup);

describe("AgentSidebar — a red worker opens its subtree, and closes it again", () => {
  it("expands the parent when one of its workers goes red", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(queryRow("Parser Worker")).toBeNull(); // collapsed by default

    setStatus({ ...ALL_WORKING, w1: "waiting" });

    expect(collapsed("a1")).toBe(false);
    expect(queryRow("Parser Worker")).toBeTruthy();
  });

  // THE bug this change exists to fix: the dot went back to green and the subtree stayed open.
  it("collapses the parent again once the red clears", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);

    setStatus({ ...ALL_WORKING, w1: "waiting" });
    expect(collapsed("a1")).toBe(false);

    setStatus(ALL_WORKING);

    expect(collapsed("a1")).toBe(true);
    expect(queryRow("Parser Worker")).toBeNull();
  });

  it("leaves the subtree open while ANOTHER of its workers is still red", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);

    setStatus({ ...ALL_WORKING, w1: "waiting", w2: "errored" });
    setStatus({ ...ALL_WORKING, w2: "errored" }); // w1 recovered, w2 has not

    expect(collapsed("a1")).toBe(false);
    expect(queryRow("Lexer Worker")).toBeTruthy();
  });

  it("closes one orchestrator's subtree without touching another that is still red", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);

    setStatus({ ...ALL_WORKING, w1: "waiting", w3: "waiting" });
    expect(collapsed("a1")).toBe(false);
    expect(collapsed("a2")).toBe(false);

    setStatus({ ...ALL_WORKING, w3: "waiting" });

    expect(collapsed("a1")).toBe(true);
    expect(collapsed("a2")).toBe(false);
  });
});

describe("AgentSidebar — the subtree you are reading never closes under you", () => {
  it("stays open when the orchestrator itself is the selected row", () => {
    const project = seed();
    const { rerender } = render(<AgentSidebar project={project} />);

    setStatus({ ...ALL_WORKING, w1: "waiting" });
    const reading: Project = { ...project, selectedAgentId: "a1" };
    useProjectStore.setState({ projects: [reading] } as never);
    rerender(<AgentSidebar project={reading} />);

    setStatus(ALL_WORKING);

    expect(collapsed("a1")).toBe(false);
    expect(queryRow("Parser Worker")).toBeTruthy();
  });

  // Collapsing here would hide the row for the very agent the terminal pane is showing — the
  // "an agent no row is highlighting" hazard the worker rows exist to prevent.
  it("stays open when one of its WORKERS is the selected row", () => {
    const project = seed();
    const { rerender } = render(<AgentSidebar project={project} />);

    setStatus({ ...ALL_WORKING, w1: "waiting" });
    const reading: Project = { ...project, selectedAgentId: "w1" };
    useProjectStore.setState({ projects: [reading] } as never);
    rerender(<AgentSidebar project={reading} />);

    setStatus(ALL_WORKING);

    expect(collapsed("a1")).toBe(false);
    expect(queryRow("Parser Worker")).toBeTruthy();
  });

  it("closes it as soon as you navigate away", () => {
    const project = seed("w1");
    const { rerender } = render(<AgentSidebar project={project} />);

    setStatus({ ...ALL_WORKING, w1: "waiting" });
    setStatus(ALL_WORKING);
    expect(collapsed("a1")).toBe(false); // held open: you were on w1

    const movedOn: Project = { ...project, selectedAgentId: "a2" };
    useProjectStore.setState({ projects: [movedOn] } as never);
    rerender(<AgentSidebar project={movedOn} />);

    expect(collapsed("a1")).toBe(true);
  });

  // The selection-reveal rule opens a subtree purely so the selected worker has a row. That reason
  // is spent the moment you look elsewhere, so the reveal is marked `auto` like the attention rule —
  // otherwise every worker you ever clicked leaves its subtree open for the rest of the session.
  it("puts away a subtree that was opened only to reveal the selection", () => {
    const project = seed();
    const { rerender } = render(<AgentSidebar project={project} />);

    const reading: Project = { ...project, selectedAgentId: "w2" };
    useProjectStore.setState({ projects: [reading] } as never);
    rerender(<AgentSidebar project={reading} />);
    expect(collapsed("a1")).toBe(false);
    expect(queryRow("Lexer Worker")).toBeTruthy();

    const movedOn: Project = { ...project, selectedAgentId: "a2" };
    useProjectStore.setState({ projects: [movedOn] } as never);
    rerender(<AgentSidebar project={movedOn} />);

    expect(collapsed("a1")).toBe(true);
  });
});

describe("AgentSidebar — the user's own chevron outranks the automation", () => {
  it("never auto-closes a subtree the user opened by hand", () => {
    const project = seed();
    const { rerender } = render(<AgentSidebar project={project} />);

    toggleByHand("Alpha"); // deliberate open, with nothing red
    expect(collapsed("a1")).toBe(false);

    // Navigate AWAY first, so this cannot pass on the you-are-reading-it exemption — the only thing
    // holding the subtree open from here is that the user, not the app, opened it.
    selectAgent(project, "a2", rerender);
    setStatus({ ...ALL_WORKING, w1: "waiting" });
    setStatus(ALL_WORKING);

    expect(collapsed("a1")).toBe(false);
    expect(queryRow("Parser Worker")).toBeTruthy();
  });

  // Expansion is a rising edge, so a subtree collapsed by hand while its worker is STILL red stays
  // collapsed. Auto-collapse must not quietly re-arm that: the head is no longer marked.
  it("does not re-open a subtree the user collapsed while the worker is still red", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);

    setStatus({ ...ALL_WORKING, w1: "waiting" });
    expect(collapsed("a1")).toBe(false);

    toggleByHand("Alpha");
    expect(collapsed("a1")).toBe(true);

    setStatus({ ...ALL_WORKING, w1: "waiting", a1: "waiting" }); // same red, another tick

    expect(collapsed("a1")).toBe(true);
    expect(queryRow("Parser Worker")).toBeNull();
  });

  // Once it goes quiet and asks again, that IS new information and gets to open the subtree.
  it("re-opens when the worker goes quiet and then red a second time", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);

    setStatus({ ...ALL_WORKING, w1: "waiting" });
    toggleByHand("Alpha");
    expect(collapsed("a1")).toBe(true);

    setStatus(ALL_WORKING);
    setStatus({ ...ALL_WORKING, w1: "waiting" });

    expect(collapsed("a1")).toBe(false);
  });
});

// Auto-collapse acts on the CURRENT snapshot with no baseline of its own, which is only safe while
// "nothing needs you" and "I have no reading" stay different answers. They were the same `false` at
// first, and closing on it meant the app acted on facts it did not have (roborev 53994).
describe("AgentSidebar — a subtree is never closed on a status we haven't read", () => {
  // AT LAUNCH `runtimeStore.status` is empty and fills in as panes mount. With no-reading folded
  // into calm, the very first commit closed every subtree carrying a PERSISTED auto mark and dropped
  // the mark, then re-opened a beat later when the PTY reported red — a visible open/shut/open, with
  // a persisted write per bounce.
  it("leaves a persisted auto-expanded subtree alone until a status arrives", () => {
    useUiStore.setState({
      collapsedOrchestrators: { a1: false },
      autoExpandedOrchestrators: { a1: true },
    } as never);
    const project = seed();
    setStatus({}); // nothing live yet — exactly the state one commit after launch
    render(<AgentSidebar project={project} />);

    expect(collapsed("a1")).toBe(false);
    expect(queryRow("Parser Worker")).toBeTruthy();
    // And the mark survives, so the subtree still puts itself away once the fleet reports in calm.
    expect(useUiStore.getState().autoExpandedOrchestrators.a1).toBe(true);

    setStatus(ALL_WORKING);

    expect(collapsed("a1")).toBe(true);
  });

  // The OTHER side of that rule, and the reason it is "a reading we are WAITING for" rather than
  // "a reading we don't have": `runtimeStore` does not persist `status`, so a worker whose pane is
  // closed is statusless for the whole session. Treating every one of those as unknown pinned its
  // head open forever — auto-collapse dead for that head, with a persisted mark that never cleared
  // either (roborev 54018).
  //
  // These two cases pin the line, and they use the PRODUCTION shape: a materialized worker always
  // carries a `worktreePath` (workerSpawn sets it at the cut, and the disk reconcile sets it on
  // adopt), so a test built on `mkAgent`'s default `worktreePath: null` proves nothing about either
  // (roborev 54031 — the first cut of this test did exactly that).
  const materialized = (id: string, name: string, parentId: string): AgentTab =>
    mkAgent(id, name, {
      kind: "worker",
      parentId,
      baseBranch: "main",
      worktreePath: `/tmp/demo/${id}`,
      // createdAt in the distant past so it clears the unstarted-worker dwell — this fixture models a
      // worker that HAS sat un-launched, i.e. a genuine strand, not one still inside its settling
      // window (engine/workerAttention.UNSTARTED_WORKER_DWELL_MS, sparkle-w340).
      createdAt: 1,
    });

  it("collapses a head whose workers are closed panes under a closed orchestrator", () => {
    useUiStore.setState({
      collapsedOrchestrators: { a1: false },
      autoExpandedOrchestrators: { a1: true },
    } as never);
    const project = seed();
    const restored: Project = {
      ...project,
      agents: [
        mkAgent("a1", "Alpha"),
        materialized("w1", "Parser Worker", "a1"),
        materialized("w2", "Lexer Worker", "a1"),
      ],
    };
    useProjectStore.setState({ projects: [restored] } as never);
    act(() => {
      // A relaunch that restored the ROWS but opened nothing: no panes, no statuses.
      useRuntimeStore.setState({ status: {}, openAgentIds: [] } as never);
    });
    render(<AgentSidebar project={restored} />);

    expect(collapsed("a1")).toBe(true);
    expect(useUiStore.getState().autoExpandedOrchestrators.a1).toBeUndefined();
  });

  // A materialized, statusless worker under a LIVE orchestrator is not a closed pane — it is the
  // STRAND (engine/workerAttention.isUnstartedWorker): its worktree is cut, its pane never mounted,
  // and the app paints it RED and re-opens it. Holding its subtree open is the point, not a leak —
  // the red row is the one the user has to click to start it. Pinned here so the day someone decides
  // an exhausted self-heal should collapse instead, they change this deliberately.
  it("holds a head open while a worker under it is an unstarted strand", () => {
    useUiStore.setState({
      collapsedOrchestrators: { a1: false },
      autoExpandedOrchestrators: { a1: true },
    } as never);
    const project = seed();
    const stranded: Project = {
      ...project,
      agents: [mkAgent("a1", "Alpha"), materialized("w1", "Parser Worker", "a1")],
    };
    useProjectStore.setState({ projects: [stranded] } as never);
    act(() => {
      // Orchestrator live, worker's pane never mounted — the spawn/evict strand.
      useRuntimeStore.setState({ status: { a1: "working" }, openAgentIds: ["a1"] } as never);
    });
    render(<AgentSidebar project={stranded} />);

    expect(collapsed("a1")).toBe(false);
    expect(queryRow("Parser Worker")).toBeTruthy();
    expect(useUiStore.getState().autoExpandedOrchestrators.a1).toBe(true);
  });

  // THE OPEN/EVICT RACE. `ensureWorkersOpen` has observed the same worker re-opened ~10 times in a
  // sub-millisecond burst; each round removes and restores its status entry. Reading the gap as calm
  // made every round a close followed by a rising-edge re-open — the flap the never-live rule exists
  // to prevent, reached from the collapse side.
  it("does not flap when a worker's status entry disappears and comes back", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);

    setStatus({ ...ALL_WORKING, w1: "waiting" }); // opened by the app, and marked
    expect(collapsed("a1")).toBe(false);

    const { w1: _evicted, ...withoutW1 } = ALL_WORKING;
    setStatus(withoutW1); // evicted mid-race: no reading for w1
    expect(collapsed("a1")).toBe(false);
    expect(useUiStore.getState().autoExpandedOrchestrators.a1).toBe(true);

    setStatus({ ...ALL_WORKING, w1: "waiting" }); // back, still asking
    expect(collapsed("a1")).toBe(false);

    // The race settles and the worker really is calm — NOW it puts itself away.
    setStatus(ALL_WORKING);
    expect(collapsed("a1")).toBe(true);
  });
});

describe("AgentSidebar — a deliberate reveal is not the app's to take back", () => {
  // The concierge's "Show me" and its rowless digest line expand exactly the heads the user clicked
  // to see, through this same store action. Marking those auto would fold every one but the selected
  // head away on the very next status tick — the 53737 bug, back again.
  it("leaves a non-auto expansion open across status ticks", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);

    act(() => {
      useUiStore.getState().expandOrchestrators(["a1", "a2"]); // a concierge reveal
    });
    setStatus(ALL_WORKING);

    expect(collapsed("a1")).toBe(false);
    expect(collapsed("a2")).toBe(false);
    expect(queryRow("Parser Worker")).toBeTruthy();
    expect(queryRow("Docs Worker")).toBeTruthy();
  });
});

describe("AgentSidebar — switching projects", () => {
  // At launch nothing has been observed, so first observation must be a baseline or every relaunch
  // blows open every collapse the user chose.
  it("expands nothing on first render, whatever the fleet looks like", () => {
    useUiStore.setState({ collapsedOrchestrators: { a1: true, a2: true } } as never);
    const project = seed();
    setStatus({ ...ALL_WORKING, w1: "waiting" });
    render(<AgentSidebar project={project} />);

    expect(collapsed("a1")).toBe(true);
    expect(collapsed("a2")).toBe(true);
    expect(queryRow("Parser Worker")).toBeNull();
  });

  it("expands nothing in the project you switch to", () => {
    const project = seed();
    const { rerender } = render(<AgentSidebar project={project} />);
    setStatus(ALL_WORKING);

    useUiStore.setState({ collapsedOrchestrators: { b1: true } } as never); // their choice
    useProjectStore.setState({ projects: [project, OTHER] } as never);
    rerender(<AgentSidebar project={OTHER} />);

    expect(collapsed("b1")).toBe(true);
    expect(queryRow("Gamma Worker")).toBeNull();
  });

  it("still opens a subtree that goes red AFTER the switch", () => {
    const project = seed();
    const { rerender } = render(<AgentSidebar project={project} />);
    setStatus(ALL_WORKING);

    useProjectStore.setState({ projects: [project, OTHER] } as never);
    rerender(<AgentSidebar project={OTHER} />);
    setStatus({ ...ALL_WORKING, bw1: "waiting" });

    expect(collapsed("b1")).toBe(false);
    expect(queryRow("Gamma Worker")).toBeTruthy();
  });

  // Statuses are global — a worker can go red while you are in another project — so the alarm must
  // still be waiting when you come back. With one shared snapshot, switching away drops the other
  // project's entries and the return trip reads as first observation; red is a level, not an edge,
  // so nothing would ever open that subtree again. Harmless while subtrees only opened; with
  // auto-collapse it means the subtree is SHUT on the one alarm that most needs seeing.
  it("opens a subtree whose worker went red while you were in another project", () => {
    const project = seed();
    const { rerender } = render(<AgentSidebar project={project} />);
    setStatus(ALL_WORKING);

    useProjectStore.setState({ projects: [project, OTHER] } as never);
    rerender(<AgentSidebar project={OTHER} />); // p2 observed once, calm
    rerender(<AgentSidebar project={project} />); // back to p1

    setStatus({ ...ALL_WORKING, bw1: "waiting" }); // p2's worker asks while you are on p1
    rerender(<AgentSidebar project={OTHER} />);

    expect(collapsed("b1")).toBe(false);
  });

  it("leaves the project you switched AWAY from as you left it", () => {
    const project = seed();
    const { rerender } = render(<AgentSidebar project={project} />);
    setStatus({ ...ALL_WORKING, w1: "waiting" });
    expect(collapsed("a1")).toBe(false); // p1's head opened for its red worker

    useProjectStore.setState({ projects: [project, OTHER] } as never);
    rerender(<AgentSidebar project={OTHER} />);
    setStatus({ ...ALL_WORKING, w1: "waiting" });

    // p1's head is untouched by p2's pass — neither collapsed nor re-expanded — and comes back the
    // way it was left.
    expect(collapsed("a1")).toBe(false);
    rerender(<AgentSidebar project={project} />);
    expect(collapsed("a1")).toBe(false);
    expect(queryRow("Parser Worker")).toBeTruthy();
  });
});
