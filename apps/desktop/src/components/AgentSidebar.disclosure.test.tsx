// @vitest-environment jsdom
//
// WORKER SUBTREE DISCLOSURE IS USER STATE.
//
// A parent's expanded/collapsed state may be written by exactly two things: the user's own gesture
// (the row chevron, or the column header's expand-all / collapse-all control) and nothing else. Not a
// status transition, not a worker appearing, not a re-render, not a relaunch.
//
// The bug this file exists to pin: a subtree used to OPEN ITSELF when a worker under it went red, and
// deliberately did NOT close again when the red cleared. The two rules composed into a parent sitting
// open under a project the user never touched, showing a GREEN worker — no attention anywhere, just a
// wall of rows nobody asked for. The replacement for the capability that machinery provided is the
// one-line PEEK (below): a closed parent with a red worker under it shows a single inset line, which
// is not an expansion and does not survive the red clearing.
//
// WHY THESE ASSERTIONS AND NOT "IT DEFAULTS TO CLOSED": a missing `collapsedOrchestrators` entry
// ALREADY reads as collapsed, and always did, so "a fresh parent renders closed" passes just as well
// against the broken code. It proves nothing. Every test here therefore drives a worker through a
// real status TRANSITION — the same `runtimeStore.status` path the app uses — and asserts the parent
// is still closed AFTER it, which is precisely what used to fail.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { C } from "../theme/colors";
import { childRowOf, strayTreeChildren, treeContainerCount } from "./subtreeTestUtils";
import type { AgentTab, AgentTabStatus, Project } from "../types";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

/** Orchestrator `a1` ("Alpha") with one worker per entry of `workers`. Every worker gets a LIVE
 *  status entry and an open pane, because a worker with no live reading is deliberately inert for
 *  both expansion and peek — seeding one would make a "nothing happened" result meaningless. */
function seed(
  workers: Record<string, { name: string; status: AgentTabStatus }>,
  selectedAgentId: string | null = null,
): Project {
  const orchestrator = mkAgent("a1", "Alpha", { namePinned: true });
  const kids = Object.entries(workers).map(([id, w]) =>
    mkAgent(id, w.name, {
      kind: "worker", parentId: "a1", baseBranch: "main", worktreePath: `/wt/${id}`, createdAt: 1,
    }),
  );
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId,
    agents: [orchestrator, ...kids],
  };
  useProjectStore.setState({ projects: [project] } as never);
  const status: Record<string, AgentTabStatus> = {};
  for (const [id, w] of Object.entries(workers)) status[id] = w.status;
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {}, status,
    openAgentIds: ["a1", ...Object.keys(workers)],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

/** Drive a worker's status the way the app does — through the live PTY status map — and then let
 *  React commit, which is what actually runs the effects that used to write the expansion.
 *
 *  The `rerender` is NOT ceremony. A bare `setState` here leaves the assertion running before the
 *  effect has flushed, so EVERY test in this file passed against the very code it is meant to
 *  indict — the vacuous-test failure this repo keeps re-learning, reached by a stale render rather
 *  than by a too-weak assertion. Verified by construction: with the auto-expander still in place
 *  these tests fail, and they only go green once it is gone. */
function advance(
  rerender: ReturnType<typeof render>["rerender"],
  project: Project,
  id: string,
  status: AgentTabStatus,
) {
  useRuntimeStore.setState((s) => ({ status: { ...s.status, [id]: status } }) as never);
  rerender(<AgentSidebar project={project} />);
}

/** Fold/unfold a head's subtree — a plain left click on the head row, the gesture the column
 *  actually offers (there is no separate chevron button to target).
 *
 *  THE HEAD MUST ALREADY BE SELECTED for this to fold anything. Selection is click-only and the fold
 *  is its SECOND stage: a click on the row you are ALREADY on. So every caller below seeds the head
 *  as `selectedAgentId` — and it has to be the FIXTURE, not a first click, because the component
 *  reads selection from its `project` PROP, which these tests pass as a static object, so a click
 *  that updates the store never reaches the row. Without the pre-selection the first click here only
 *  selects, and a "did the subtree open?" assertion would be measuring the wrong gesture. */
const toggleHead = (name: string) =>
  fireEvent.click(screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement);

const isCollapsed = (id: string) => useUiStore.getState().collapsedOrchestrators[id] !== false;

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
});
afterEach(cleanup);

describe("worker subtree disclosure — only the user opens a parent", () => {
  // THE REGRESSION. A worker going red used to open its parent, and the parent then STAYED open once
  // the red cleared, which is the green-worker-in-an-untouched-subtree the founder found.
  it("a worker going red and then green leaves the parent CLOSED throughout", () => {
    const project = seed({ w1: { name: "Fix The Parser", status: "working" } });
    const { rerender } = render(<AgentSidebar project={project} />);
    expect(isCollapsed("a1")).toBe(true);

    advance(rerender, project, "w1", "errored"); // rising edge — used to force the subtree open
    expect(isCollapsed("a1")).toBe(true);
    expect(childRowOf("a1", "Fix The Parser")).toBe(false); // no child row appeared (a peek did)

    advance(rerender, project, "w1", "working"); // red clears — used to leave it open forever
    expect(isCollapsed("a1")).toBe(true);
    expect(childRowOf("a1", "Fix The Parser")).toBe(false);
  });

  // Every status in the needs_you band, not just `errored`: the auto-expander keyed off the shared
  // BAND, so any one of these would have opened the subtree.
  //
  // `blocked` is deliberately NOT in this list, even though `bandOfStatus` puts it in `needs_you`.
  // Measured against the pre-change code in THIS harness it passed — so it would be a test that is
  // green before and after, proving nothing. (It is not that `blocked` escapes the rule in general:
  // AgentSidebar.rowChrome.test.tsx drives `blocked` through a slightly different fixture and did
  // observe the auto-expansion there. The difference is the fixture, not the band.) Rather than keep
  // a case whose failure I could not demonstrate here, it is left to the file that can.
  for (const red of ["waiting", "approval", "errored"] as const) {
    it(`a worker entering "${red}" does not open its parent`, () => {
      const project = seed({ w1: { name: "Fix The Parser", status: "working" } });
      const { rerender } = render(<AgentSidebar project={project} />);
      advance(rerender, project, "w1", red);
      expect(isCollapsed("a1")).toBe(true);
    });
  }

  // The user's gesture is still the one thing that DOES write it — if this fails, the funnel has been
  // welded shut rather than narrowed, and the feature is broken in the opposite direction.
  it("the user's own gesture still opens and closes the subtree", () => {
    const project = seed({ w1: { name: "Fix The Parser", status: "working" } }, "a1");
    render(<AgentSidebar project={project} />);
    toggleHead("Alpha");
    expect(isCollapsed("a1")).toBe(false);
    expect(childRowOf("a1", "Fix The Parser")).toBe(true); // the real child row, not a peek
    toggleHead("Alpha");
    expect(isCollapsed("a1")).toBe(true);
  });

  // A subtree the user has just closed must not be re-opened by a worker that is STILL red. The old
  // module guarded this with an edge detector; with auto-expansion gone there is nothing to detect,
  // and this pins that nothing grew back.
  it("a steady red does not re-open a subtree the user just collapsed", () => {
    const project = seed({ w1: { name: "Fix The Parser", status: "errored" } }, "a1");
    const { rerender } = render(<AgentSidebar project={project} />);
    toggleHead("Alpha"); // user opens it
    expect(isCollapsed("a1")).toBe(false);
    toggleHead("Alpha"); // user closes it again, red still standing
    expect(isCollapsed("a1")).toBe(true);
    advance(rerender, project, "w1", "errored"); // another pass over the same red
    expect(isCollapsed("a1")).toBe(true);
  });
});

// ── THE PEEK ─────────────────────────────────────────────────────────────────────────────────────
//
// A CLOSED parent with a red worker under it shows ONE inset line. It is not the subtree: the head
// stays closed, no child rows render, and nothing is written to `collapsedOrchestrators`. It is the
// replacement for the capability the deleted auto-expander provided, without the cost that made
// that machinery wrong — it cannot leave a subtree standing open once the red has gone, because it
// never opened one.
describe("the peek — a closed parent with a red worker shows one line", () => {
  const peek = () => screen.queryByTestId("worker-peek");

  it("shows a peek naming the red worker, while the parent stays CLOSED", () => {
    const project = seed({ w1: { name: "Fix The Parser", status: "errored" } });
    render(<AgentSidebar project={project} />);
    expect(peek()).toBeTruthy();
    expect(peek()!.textContent).toContain("Fix The Parser");
    expect(peek()!.textContent).toContain("needs you");
    expect(isCollapsed("a1")).toBe(true);
  });

  // THE LINE THAT MAKES IT A PEEK AND NOT AN EXPANSION. Two red workers must produce ONE line
  // carrying a COUNT — not two lines, and not the child rows themselves.
  it("collapses SEVERAL red workers to one line with a count, and renders no child rows", () => {
    const project = seed({
      w1: { name: "Fix The Parser", status: "errored" },
      w2: { name: "Fix The Lexer", status: "waiting" },
    });
    render(<AgentSidebar project={project} />);
    expect(screen.queryAllByTestId("worker-peek")).toHaveLength(1);
    expect(peek()!.getAttribute("data-peek-count")).toBe("2");
    expect(peek()!.textContent).toContain("2 workers");
    // The actual child rows are ABSENT — this is the assertion that separates a peek from an
    // expansion. Neither red worker's own row exists.
    expect(childRowOf("a1", "Fix The Parser")).toBe(false);
    expect(childRowOf("a1", "Fix The Lexer")).toBe(false);
    expect(document.querySelector(`#agent-subtree-a1`)).toBeNull();
  });

  // GREEN AND GRAY NEVER PEEK. A nonzero number of calm workers is present, so the fixture COULD
  // have peeked — this fails if the peek keys off "has workers" rather than "has attention".
  it("does not peek for green or gray workers", () => {
    const project = seed({
      w1: { name: "Fix The Parser", status: "working" },
      w2: { name: "Fix The Lexer", status: "done" },
      w3: { name: "Fix The Emitter", status: "idle" },
    });
    render(<AgentSidebar project={project} />);
    expect(peek()).toBeNull();
    expect(isCollapsed("a1")).toBe(true);
  });

  // Opening the parent replaces the peek with the real children; closing it brings the peek back.
  it("is replaced by the real child rows when the parent opens, and returns when it closes", () => {
    const project = seed({ w1: { name: "Fix The Parser", status: "errored" } }, "a1");
    render(<AgentSidebar project={project} />);
    expect(peek()).toBeTruthy();

    toggleHead("Alpha");
    expect(peek()).toBeNull(); // no longer a peek…
    expect(childRowOf("a1", "Fix The Parser")).toBe(true); // …because the real row is there

    toggleHead("Alpha");
    expect(peek()).toBeTruthy();
    expect(childRowOf("a1", "Fix The Parser")).toBe(false);
  });

  // The peek FOLLOWS the red rather than latching: when the worker recovers the line goes, and the
  // parent is still exactly as closed as the user left it. This is the half the old auto-expander
  // got wrong — it opened on the red and then had no way back.
  it("disappears when the red clears, leaving the parent closed", () => {
    const project = seed({ w1: { name: "Fix The Parser", status: "errored" } });
    const { rerender } = render(<AgentSidebar project={project} />);
    expect(peek()).toBeTruthy();

    advance(rerender, project, "w1", "working");
    expect(peek()).toBeNull();
    expect(isCollapsed("a1")).toBe(true);
  });

  // Appearing does not write anything: the peek is derived, so a parent that has never been touched
  // still has NO entry in the record (not even `true`), and the persisted collapse is untouched.
  it("writes nothing to the collapse record", () => {
    const project = seed({ w1: { name: "Fix The Parser", status: "errored" } });
    render(<AgentSidebar project={project} />);
    expect(peek()).toBeTruthy();
    expect(useUiStore.getState().collapsedOrchestrators).toEqual({});
  });

  // The peek names a row the user cannot otherwise click, so the obvious gesture has to lead
  // somewhere — and it goes through the user-gesture path, not a second writer.
  it("clicking the peek opens the subtree for real", () => {
    const project = seed({ w1: { name: "Fix The Parser", status: "errored" } });
    render(<AgentSidebar project={project} />);
    fireEvent.click(peek()!);
    expect(isCollapsed("a1")).toBe(false);
    expect(childRowOf("a1", "Fix The Parser")).toBe(true);
  });
});

// ── EXPAND ALL / COLLAPSE ALL ────────────────────────────────────────────────────────────────────
//
// The column-header control, where the `«` chevron used to sit. It is the SECOND of the two things
// allowed to write `collapsedOrchestrators` (the first being the user's own row gesture), so these
// tests are as much about it staying a user-driven writer as about it working.
describe("the expand-all / collapse-all control", () => {
  /** Two orchestrators with a worker each — a control that acts on "every parent" needs more than
   *  one parent to be shown acting on them all. */
  function seedTwoHeads(): Project {
    const project: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [
        mkAgent("a1", "Alpha", { namePinned: true }),
        mkAgent("w1", "Fix The Parser", { kind: "worker", parentId: "a1", baseBranch: "main", worktreePath: "/wt/w1", createdAt: 1 }),
        mkAgent("a2", "Beta", { namePinned: true }),
        mkAgent("w2", "Fix The Lexer", { kind: "worker", parentId: "a2", baseBranch: "main", worktreePath: "/wt/w2", createdAt: 1 }),
      ],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      branchStatus: {}, workflowStage: {},
      status: { w1: "working", w2: "working" },
      openAgentIds: ["a1", "w1", "a2", "w2"],
      open: vi.fn(),
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    return project;
  }

  // The control is NOT hover-revealed, so there is no hidden-element trap to fall into here — but
  // assert reachability anyway rather than firing at a node a real user could never hit: a
  // `visibility: hidden` / `pointer-events: none` control takes neither hover nor click in a browser
  // while `fireEvent` sails straight through it, which is exactly how a green test ships a control
  // nobody can reach.
  it("is reachable — visible, and not pointer-events:none", () => {
    const project = seedTwoHeads();
    render(<AgentSidebar project={project} />);
    for (const id of ["expand-all-subtrees", "collapse-all-subtrees"]) {
      const el = screen.getByTestId(id);
      const css = getComputedStyle(el);
      expect(css.visibility).not.toBe("hidden");
      expect(css.pointerEvents).not.toBe("none");
      expect(el.hasAttribute("disabled")).toBe(false);
    }
  });

  it("expands EVERY parent in the column, not just the first", () => {
    const project = seedTwoHeads();
    render(<AgentSidebar project={project} />);
    expect(isCollapsed("a1")).toBe(true);
    expect(isCollapsed("a2")).toBe(true);

    fireEvent.click(screen.getByTestId("expand-all-subtrees"));

    expect(isCollapsed("a1")).toBe(false);
    expect(isCollapsed("a2")).toBe(false);
    expect(childRowOf("a1", "Fix The Parser")).toBe(true);
    expect(childRowOf("a2", "Fix The Lexer")).toBe(true);
  });

  it("collapses EVERY parent in the column", () => {
    const project = seedTwoHeads();
    useUiStore.setState({ collapsedOrchestrators: { a1: false, a2: false } } as never);
    render(<AgentSidebar project={project} />);
    expect(childRowOf("a1", "Fix The Parser")).toBe(true);

    fireEvent.click(screen.getByTestId("collapse-all-subtrees"));

    expect(isCollapsed("a1")).toBe(true);
    expect(isCollapsed("a2")).toBe(true);
    expect(childRowOf("a1", "Fix The Parser")).toBe(false);
    expect(childRowOf("a2", "Fix The Lexer")).toBe(false);
  });

  // A MIXED column: one open, one shut. Expand-all must reach the shut one rather than bailing
  // because "something is already expanded".
  it("expands the parents that are still closed when the column is mixed", () => {
    const project = seedTwoHeads();
    useUiStore.setState({ collapsedOrchestrators: { a1: false } } as never);
    render(<AgentSidebar project={project} />);

    fireEvent.click(screen.getByTestId("expand-all-subtrees"));

    expect(isCollapsed("a1")).toBe(false);
    expect(isCollapsed("a2")).toBe(false);
  });

  // Both halves are always live, so this is a no-op the store absorbs rather than a state change.
  it("collapse-all on an already-collapsed column changes nothing", () => {
    const project = seedTwoHeads();
    render(<AgentSidebar project={project} />);
    const before = useUiStore.getState().collapsedOrchestrators;
    fireEvent.click(screen.getByTestId("collapse-all-subtrees"));
    expect(useUiStore.getState().collapsedOrchestrators).toBe(before);
  });

  // A head with no workers has no subtree and no chevron; writing an entry for it would be state for
  // a row that cannot be expanded.
  it("acts only on heads that actually have workers", () => {
    const project: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [
        mkAgent("a1", "Alpha", { namePinned: true }),
        mkAgent("w1", "Fix The Parser", { kind: "worker", parentId: "a1", baseBranch: "main", worktreePath: "/wt/w1", createdAt: 1 }),
        mkAgent("solo", "Solo", { namePinned: true }), // no workers
      ],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      branchStatus: {}, workflowStage: {}, status: { w1: "working" },
      openAgentIds: ["a1", "w1", "solo"], open: vi.fn(),
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    render(<AgentSidebar project={project} />);

    fireEvent.click(screen.getByTestId("expand-all-subtrees"));

    expect(useUiStore.getState().collapsedOrchestrators).toEqual({ a1: false });
  });

  // Nothing to act on → no control. Three dead affordances over an empty column is worse than none.
  it("is absent when no head has workers", () => {
    const project = seed({}); // orchestrator a1, zero workers
    render(<AgentSidebar project={project} />);
    expect(screen.queryByTestId("subtree-disclosure-control")).toBeNull();
  });
});

// ── WHAT THE FIRST CUT OF THESE TESTS COULD NOT SEE ──────────────────────────────────────────────
//
// The suites above assert `data-testid`, `textContent` and computed style. None of those sees ROLE
// VALIDITY or TAB ORDER, so the peek shipped as a plain `<button>` inside `role="tree"` — invalid
// tree content that AT drops — and as an extra Tab stop in a roving-tabindex column, and every test
// stayed green. These are the assertions that would have caught it (roborev 56163).
describe("the peek is valid tree content", () => {
  // A tree may own ONLY treeitems and groups — including at the TREE'S OWN level, which is where
  // the peek first shipped as a bare `<button>`. The probe lives in ./subtreeTestUtils so all three
  // suites share one definition of the contract; see its header for why aria-hidden is skipped and
  // why the ancestor walk stops at the tree.
  it("a rendered peek leaves the tree owning only treeitems and groups", () => {
    const project = seed({
      w1: { name: "Fix The Parser", status: "errored" },
      w2: { name: "Fix The Lexer", status: "working" },
    });
    render(<AgentSidebar project={project} />);
    expect(screen.getByTestId("worker-peek")).toBeTruthy(); // the fixture really renders one
    // POSITIVE CONTROL: an empty candidate set also returns [], so prove the probe looked at
    // something before trusting that it found nothing.
    expect(treeContainerCount()).toBeGreaterThan(1);
    expect(strayTreeChildren()).toEqual([]);
  });

  // The peek specifically — named, so a regression points at the right thing.
  it("the peek is a treeitem, and the fixture really does render one", () => {
    const project = seed({ w1: { name: "Fix The Parser", status: "errored" } });
    render(<AgentSidebar project={project} />);
    const p = screen.getByTestId("worker-peek");
    expect(p.getAttribute("role")).toBe("treeitem");
    // …and it exposes NO aria-expanded. It owns no group and can never be expanded — activating it
    // toggles the HEAD, after which the peek unmounts. Announcing "collapsed" here would duplicate
    // the head row's own aria-expanded for the same subtree and offer a state the user (deliberately
    // outside the Tab order and the arrow ring) has no keyboard path to act on.
    expect(p.hasAttribute("aria-expanded")).toBe(false);
    // It announces at the WORKER's level, one below the head it hangs off. The DOM is flat here —
    // the peek is a sibling of the head row — so without this it would read as another top-level
    // agent. Asserted against the head's OWN level rather than a bare `2`, so the pair cannot drift.
    const headLevel = Number(
      (screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement)
        .getAttribute("aria-level"),
    );
    expect(headLevel).toBeGreaterThan(0); // the fixture really does declare one
    expect(Number(p.getAttribute("aria-level"))).toBe(headLevel + 1);
  });

  // ONE Tab stop for the whole column. A peek at tabIndex=0 adds one per red subtree.
  it("does not add a Tab stop inside the tree", () => {
    const project = seed({ w1: { name: "Fix The Parser", status: "errored" } });
    render(<AgentSidebar project={project} />);
    expect(screen.getByTestId("worker-peek").getAttribute("tabindex")).toBe("-1");
    const tree = document.querySelector('[role="tree"]')!;
    expect(tree.querySelectorAll('[tabindex="0"]').length).toBeLessThanOrEqual(1);
  });
});

describe("the expand/collapse-all control dims only a direction that would do nothing", () => {
  function seedMixed(collapsedState: Record<string, boolean>): Project {
    const project: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [
        mkAgent("a1", "Alpha", { namePinned: true }),
        mkAgent("w1", "Fix The Parser", { kind: "worker", parentId: "a1", baseBranch: "main", worktreePath: "/wt/w1", createdAt: 1 }),
        mkAgent("a2", "Beta", { namePinned: true }),
        mkAgent("w2", "Fix The Lexer", { kind: "worker", parentId: "a2", baseBranch: "main", worktreePath: "/wt/w2", createdAt: 1 }),
      ],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      branchStatus: {}, workflowStage: {}, status: { w1: "working", w2: "working" },
      openAgentIds: ["a1", "w1", "a2", "w2"], open: vi.fn(),
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    useUiStore.setState({ collapsedOrchestrators: collapsedState } as never);
    return project;
  }
  /** The half's literal inline colour token. Read from `style`, NOT `getComputedStyle`: these are
   *  `var(--c-…)` references and jsdom has no cascade to resolve them through, so computed style
   *  reports the raw string anyway — reading `style` says that plainly instead of pretending to
   *  compute. */
  const ink = (id: string) => screen.getByTestId(id).style.color;

  // THE BUG: "mixed" is not "fully collapsed". Deriving one from `!allExpanded` painted collapse-all
  // as the dead direction in a mixed column while pressing it genuinely collapsed the open head.
  // ABSOLUTE tokens, not "the two halves differ". A relative assertion passes just as well when the
  // dim is INVERTED — dimming the live direction rather than the dead one — which is the exact bug
  // class this block is named for.
  it("dims NEITHER half when the column is mixed", () => {
    render(<AgentSidebar project={seedMixed({ a1: false })} />);
    expect(ink("expand-all-subtrees")).toBe(C.muted);
    expect(ink("collapse-all-subtrees")).toBe(C.muted);
    // …and pressing the one an inverted dim would have greyed out really does something.
    fireEvent.click(screen.getByTestId("collapse-all-subtrees"));
    expect(isCollapsed("a1")).toBe(true);
    expect(isCollapsed("a2")).toBe(true);
  });

  it("dims the EXPAND half once everything is already expanded", () => {
    render(<AgentSidebar project={seedMixed({ a1: false, a2: false })} />);
    expect(ink("expand-all-subtrees")).toBe(C.hairline);
    expect(ink("collapse-all-subtrees")).toBe(C.muted);
  });

  it("dims the COLLAPSE half once everything is already collapsed", () => {
    render(<AgentSidebar project={seedMixed({})} />);
    expect(ink("collapse-all-subtrees")).toBe(C.hairline);
    expect(ink("expand-all-subtrees")).toBe(C.muted);
  });
});
