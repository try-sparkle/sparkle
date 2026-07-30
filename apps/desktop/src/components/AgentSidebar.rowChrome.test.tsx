// @vitest-environment jsdom
//
// The Build column is a DENSE, QUIET LIST: every row is `[dot] Title` and nothing else.
//
// The column had accreted one decoration per feature — a disclosure chevron ahead of the dot, a
// pulsing dot, a muted "activity" sub-line, a gradient progress bar, a green landed ✓, and a
// left-click that threw a large L-shaped card over the terminal — plus a search input duplicating
// the concierge command palette. Each was individually defensible and collectively unreadable.
//
// This file pins the stripped-down contract so the decorations can't creep back one at a time:
//   • the header clears the project tab bar above it
//   • no pulse, no activity line, no progress bar, no search input IN THE COLUMN
//   • every row's title takes the neutral ink; color lives ONLY in the dot
//   • the chevron is gone, replaced by a `+N` count on a COLLAPSED parent
//   • left-click selects + folds; the detail card is right-click
//
// The detail card is deliberately NOT deleted — it is the only home for the model picker, Land,
// branch rebase, path reveal, the alert toggle and per-worker detail. It moved to right-click, so
// several assertions below check that the card is absent from a LEFT click and present on a right
// one, rather than that it is gone entirely.
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
import { C } from "../theme/colors";
import { asRgb } from "./statusDotTestUtils";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
// NOT stubbed to null like the other suites: this one asserts the sidebar stops MOUNTING it, and a
// null stub renders nothing either way, so the test would pass before the change too. A marker
// element makes the difference observable. The two helper exports are re-declared because
// Concierge/CommandPalette imports them from this module — the module survives, only the mount goes.
vi.mock("./HistorySearch", () => ({
  HistorySearch: () => <div data-testid="sidebar-history-search" />,
  relativeTime: () => "",
  renderSnippet: () => null,
}));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { resetCable } from "../stores/cableStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import { HINT_JUMP_ATTR } from "../keyboardHints/hintTargets";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import type { WorkflowStageId } from "../engine/workflowStage";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

const open = vi.fn();

/** "Alpha" with two workers, plus a childless "Solo" — the two shapes the `+N` badge distinguishes.
 *  `namePinned` everywhere so auto-naming can't rewrite the labels the assertions look up. */
function seed(
  status: Record<string, AgentTabStatus> = {},
  over: Partial<AgentTab> = {},
  stage: Record<string, WorkflowStageId> = {},
): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [
      mkAgent("a1", "Alpha", over),
      mkAgent("w1", "Parser Worker", { kind: "worker", parentId: "a1", baseBranch: "main" }),
      mkAgent("w2", "Lexer Worker", { kind: "worker", parentId: "a1", baseBranch: "main" }),
      mkAgent("solo", "Solo"),
    ],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: stage, status,
    openAgentIds: ["a1", "w1", "w2", "solo"],
    open,
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

/** Expanded is the non-default state. Set directly rather than by clicking, so a RENDERING test
 *  doesn't also depend on the toggle working. */
function seedExpanded(
  status: Record<string, AgentTabStatus> = {},
  over: Partial<AgentTab> = {},
  stage: Record<string, WorkflowStageId> = {},
): Project {
  useUiStore.setState({ collapsedOrchestrators: { a1: false } } as never);
  return seed(status, over, stage);
}

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
const card = () => screen.queryByTestId("agent-hover-card");
function liveProject() {
  const p = useProjectStore.getState().projects[0];
  if (!p) throw new Error("project p1 is gone from the store");
  return p;
}

beforeEach(() => {
  // statusFilter is reset too: one test below isolates a single band, and without this it would
  // leak into every test after it and quietly filter the fixture out from under them.
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    statusFilter: allBandsVisible(),
  } as never);
  // The DEFAULT state (helper island enabled) is the one that needs the header gap: with the helper
  // row absent, the Plan/Build strip would otherwise sit flush against the project tab bar.
  useHelperPrefs.setState({ enabled: true } as never);
  // AT REST, EXPLICITLY. Several tests here click a row, and a row click patches the cable — which
  // opens every row's CONCIERGE end (engine/rowGeometry: the wired pair bleeds at both ends). The
  // cable store is module state, so without this the geometry assertions below would read whatever
  // the previous test left patched and pass or fail on test ORDER. These measure the RESTING box.
  resetCable();
  open.mockClear();
});
afterEach(() => {
  cleanup();
  resetCable();
});

// ── THE HEADER IS A BAND NOW, NOT A GAP ────────────────────────────────────────────────────────
//
// This used to pin a bare `marginTop: 20px` above the Plan/Build strip, whose whole job was to stop
// the strip welding onto ProjectTabsBar — the app's other piece of top chrome — because the strip
// floated at the top of the column with nothing marking where the column began.
//
// The blueprint `.bhd` solves that by BEING a boundary rather than by holding empty space: a
// `--hd-h` band with its own bottom hairline. So the assertions moved with the mechanism. Pinning
// the old gap here would fight the port; pinning nothing would let the weld come back silently,
// which is the regression the original test existed to prevent — hence the hairline assertion.
describe("Build column — the header is its own band, above the list", () => {
  const header = () => screen.getByTestId("build-column-header");

  it("draws a bottom rule, so it never welds onto the tab bar above it", () => {
    render(<AgentSidebar project={seed()} />);
    expect(header().style.borderBottom).toBe(`1px solid ${C.hairline}`);
    // …and it does NOT fall back to floating on a bare gap.
    expect(header().style.marginTop).toBe("");
  });

  it("holds the mock's --hd-h band height", () => {
    render(<AgentSidebar project={seed()} />);
    // minHeight, not height: the chip bar wraps at MIN_WIDTH and the band grows with it.
    expect(header().style.minHeight).toBe("34px");
  });

  // The helper island can still be hidden (§15 put Hide back on the island and in the View menu),
  // and no sidebar row rides on that flag — so nothing about this band may depend on it.
  it("is unchanged when the helper island is hidden", () => {
    useHelperPrefs.setState({ enabled: false } as never);
    render(<AgentSidebar project={seed()} />);
    expect(header().style.borderBottom).toBe(`1px solid ${C.hairline}`);
    expect(header().style.minHeight).toBe("34px");
  });

  it("carries the Build/Plan segment and the filter chips, in that order", () => {
    render(<AgentSidebar project={seed()} />);
    const seg = header().querySelector('[data-testid="plan-build-mini"]')!;
    const chips = header().querySelector('[data-testid="status-filter-bar"]')!;
    expect(seg).toBeTruthy();
    expect(chips).toBeTruthy();
    expect(seg.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // ONE FILTER MECHANISM. The chips governed the list from INSIDE the scrolling list, so the
  // control scrolled away from what it controls — and any "fix" for that which adds a second
  // filtering surface is the header-pill-vs-chips bug the mock's own CSS warns about.
  it("leaves no second filter bar behind in the scrolling list", () => {
    render(<AgentSidebar project={seed()} />);
    const list = screen.getByTestId("agent-list-scroll");
    expect(list.querySelector('[data-testid="status-filter-bar"]')).toBeNull();
    expect(screen.getAllByTestId("status-filter-bar")).toHaveLength(1);
  });
});

describe("Build column — the row is the title and nothing else", () => {
  it("does not pulse a working dot", () => {
    const project = seed({ a1: "working" });
    render(<AgentSidebar project={project} />);
    const dot = screen.getByTitle(AGENT_STATUS.working.label);
    expect(dot.className).not.toContain("sparkle-pulse");
  });

  it("drops the activity sub-line from the in-flow row", () => {
    const project = seed({}, { activity: "Wiring the control listener" });
    render(<AgentSidebar project={project} />);
    expect(rowFor("Alpha").textContent).not.toContain("Wiring the control listener");
  });

  // …but the card is still the full-detail surface, so the line lives on there.
  it("keeps the activity line on the detail card", () => {
    const project = seed({}, { activity: "Wiring the control listener" });
    render(<AgentSidebar project={project} />);
    fireEvent.contextMenu(rowFor("Alpha"));
    expect(card()!.textContent).toContain("Wiring the control listener");
  });

  // WorkflowLine renders role="img" with a "Workflow stage: …" label; that's the stable handle.
  it("drops the progress bar from the in-flow row", () => {
    const project = seed({}, {}, { a1: "building_saved" });
    render(<AgentSidebar project={project} />);
    expect(rowFor("Alpha").querySelector('[role="img"]')).toBeNull();
  });

  it("keeps the progress bar on the detail card", () => {
    const project = seed({}, {}, { a1: "building_saved" });
    render(<AgentSidebar project={project} />);
    fireEvent.contextMenu(rowFor("Alpha"));
    expect(card()!.querySelector('[role="img"]')).toBeTruthy();
  });

  // The landed ✓ went with the bar — the stage ladder's own sections carry "did this land" now, so
  // the glyph was saying it a second time in the one place with no room for it.
  it("renders no landed checkmark anywhere in the column", () => {
    const project = seed({}, {}, { a1: "merged", solo: "merged" });
    render(<AgentSidebar project={project} />);
    expect(screen.queryByLabelText(/landed at least once/i)).toBeNull();
  });

  it("no longer mounts the search-history bar", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(screen.queryByTestId("sidebar-history-search")).toBeNull();
  });
});

describe("Build column — color lives only in the dot", () => {
  // Build rows already used the neutral ink; WORKER rows took the status color, on the reasoning
  // that a child row is small and set back so a red name is what makes it stand out. With the row
  // stripped to a title, that's the only colored text left in the column — and it re-creates in
  // miniature the "wall of color" that drove build rows neutral in the first place.
  it("gives a red worker the same title ink as a calm build row", () => {
    const project = seedExpanded({ a1: "idle", w1: "waiting" });
    render(<AgentSidebar project={project} />);
    expect(screen.getByText("Parser Worker").style.color).toBe(
      screen.getByText("Alpha").style.color,
    );
  });

  it("gives a working worker the same title ink too", () => {
    const project = seedExpanded({ a1: "idle", w1: "working" });
    render(<AgentSidebar project={project} />);
    expect(screen.getByText("Parser Worker").style.color).toBe(
      screen.getByText("Alpha").style.color,
    );
  });

  // The guard that keeps the test above honest: it would also pass if every dot went neutral.
  it("still paints the DOT its status color", () => {
    const project = seedExpanded({ w1: "working" });
    render(<AgentSidebar project={project} />);
    expect(screen.getByTitle(AGENT_STATUS.working.label)).toBeTruthy();
  });
});

describe("Build column — the +N badge replaces the chevron", () => {
  it("renders no disclosure chevron", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(screen.queryByRole("button", { name: /workers for Alpha/i })).toBeNull();
  });

  it("shows the worker count on a collapsed parent", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(rowFor("Alpha").textContent).toContain("+2");
  });

  // Expanded, the workers are on screen and counting them again is noise.
  it("hides the count once the subtree is open", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    expect(rowFor("Alpha").textContent).not.toContain("+2");
  });

  it("shows no count on an orchestrator with no workers", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(rowFor("Solo").textContent).not.toContain("+");
  });
});

describe("Build column — left-click selects and folds, right-click opens the card", () => {
  it("selects the agent on a left click", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    fireEvent.click(rowFor("Alpha"));
    expect(liveProject().selectedAgentId).toBe("a1");
    expect(open).toHaveBeenCalledWith("a1");
  });

  it("toggles the subtree on a left click", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    fireEvent.click(rowFor("Alpha"));
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
    expect(screen.queryByText("Parser Worker")).toBeTruthy();

    fireEvent.click(rowFor("Alpha"));
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
    expect(screen.queryByText("Parser Worker")).toBeNull();
  });

  it("does NOT open the detail card on a left click", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    fireEvent.click(rowFor("Alpha"));
    expect(card()).toBeNull();
  });

  it("opens the detail card on a right click", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    fireEvent.contextMenu(rowFor("Alpha"));
    expect(card()).toBeTruthy();
  });

  it("selects the agent on a right click too, so the card matches the terminal", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    fireEvent.contextMenu(rowFor("Alpha"));
    expect(liveProject().selectedAgentId).toBe("a1");
  });

  // A childless row has nothing to fold; a left click must not throw or half-toggle it.
  it("leaves a childless row's collapse state untouched", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    fireEvent.click(rowFor("Solo"));
    expect(useUiStore.getState().collapsedOrchestrators.solo).toBeUndefined();
    expect(liveProject().selectedAgentId).toBe("solo");
  });
});

describe("Build column — workers nest tightly under their orchestrator", () => {
  // With the chevron gone the parent's title starts at padding(10) + dot slot(24) + gap(8) = 42px.
  // A worker at marginLeft 32 + its own padding(10) puts its DOT at exactly that 42px, so a child's
  // status disc lines up with where its parent's text begins.
  it("indents a worker so its dot aligns with the parent's title", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    expect(rowFor("Alpha").style.marginLeft).toBe("0px");
    expect(rowFor("Parser Worker").style.marginLeft).toBe("32px");
  });

  it("closes the vertical gap under a worker row", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    expect(rowFor("Parser Worker").style.marginBottom).toBe("0px");
    expect(rowFor("Alpha").style.marginBottom).toBe("2px");
  });

  // The RIGHT padding is deliberately larger than the left: every row now runs to the column's
  // pane-side edge (`marginRight: -8`) and pays that back in padding, so the ink sits at a constant
  // 10px from both edges whatever the selection is. AgentSidebar.rowGeometry.test.tsx owns that
  // contract; this one just pins that the vertical padding stayed tight through the change.
  it("tightens every row's vertical padding", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    const row = rowFor("Alpha");
    expect(row.style.paddingTop).toBe("4px");
    expect(row.style.paddingBottom).toBe("4px");
    expect(row.style.paddingLeft).toBe("10px");
  });
});

// ── The rollup: an orchestrator's disc reports its SUBTREE ────────────────────────────────────
//
// Subtrees fold by default, so a head is usually standing in for rows you can't see. Painting it
// from its own PTY status made it lie in the case that matters most: an orchestrator sitting in
// `idle` while its workers are blocked rendered GRAY — "nothing to do here" — with the fold hiding
// every row that disagreed. engine/workerRollup owns the law and its truth table; these tests pin
// that the COLUMN actually consults it, and that the filter chips agree with what they paint.
describe("Build column — the head's disc rolls up its workers", () => {
  const dotFor = (name: string) =>
    rowFor(name).querySelector<HTMLElement>('span[title]')!;

  it("paints a head with a red worker RED, though the head itself is calm", () => {
    const project = seed({ a1: "idle", w1: "blocked", w2: "idle" });
    render(<AgentSidebar project={project} />);
    expect(dotFor("Alpha").style.background).toBe(asRgb(AGENT_STATUS.waiting.color));
  });

  it("paints a head with only working workers GREEN", () => {
    const project = seed({ a1: "idle", w1: "working", w2: "done" });
    render(<AgentSidebar project={project} />);
    expect(dotFor("Alpha").style.background).toBe(asRgb(AGENT_STATUS.working.color));
  });

  // The one color with no status behind it. It is a themed var() rather than a hex because it has
  // to move between light and dark like every other opaque brand color.
  it("paints a head with BOTH a running and a red worker orange", () => {
    const project = seed({ a1: "idle", w1: "working", w2: "waiting" });
    render(<AgentSidebar project={project} />);
    expect(dotFor("Alpha").style.background).toBe("var(--c-mixed-ink)");
  });

  it("leaves a childless row reading its own status", () => {
    const project = seed({ solo: "working" });
    render(<AgentSidebar project={project} />);
    expect(dotFor("Solo").style.background).toBe(asRgb(AGENT_STATUS.working.color));
  });

  // A head asking YOU something is the thing you are most directly blocking; healthy workers must
  // not be able to paint over it, or the fold hides the question.
  it("lets the head's own red beat a full set of green workers", () => {
    const project = seed({ a1: "waiting", w1: "working", w2: "working" });
    render(<AgentSidebar project={project} />);
    expect(dotFor("Alpha").style.background).toBe(asRgb(AGENT_STATUS.waiting.color));
  });

  // A disc painted from one thing while hovering as another is the kind of small lie that makes
  // people stop trusting the column.
  it("hovers as its workers when it is painted from them", () => {
    const project = seed({ a1: "idle", w1: "working", w2: "waiting" });
    render(<AgentSidebar project={project} />);
    expect(dotFor("Alpha").getAttribute("title")).toBe("Workers running — some need you");
  });

  // When the rollup lands in the row's OWN band it adds nothing, so the row keeps the status label
  // it already had — a concrete status ("Blocked", "Approve?") tells you more than the generic
  // "Workers need you".
  //
  // Asserted as "not the rollup label" rather than "=== Blocked", deliberately. `withRedWorkerAttention`
  // (pre-existing, and untouched here) overwrites an orchestrator's own red KIND with its worker's,
  // so this row reports "Needs you" rather than "Blocked" for reasons that have nothing to do with
  // the rollup. Pinning the exact string would be pinning that overlay's behavior from the wrong file.
  it("does not relabel a head that is itself red", () => {
    const project = seed({ a1: "blocked", w1: "waiting", w2: "waiting" });
    render(<AgentSidebar project={project} />);
    const title = dotFor("Alpha").getAttribute("title");
    expect(title).not.toBe("Workers need you");
    expect([AGENT_STATUS.blocked.label, AGENT_STATUS.waiting.label]).toContain(title);
  });
});

describe("Build column — the filter chips agree with the discs", () => {
  const chipText = (band: string) =>
    screen.getByTestId(`status-chip-${band}`).textContent ?? "";

  // The whole reason the rollup drives filtering: a row painted red that the "Needs you" chip
  // cannot find is a signal you can see but not act on.
  it("counts a rolled-up red head under Needs you, not Done", () => {
    const project = seed({ a1: "idle", w1: "blocked", w2: "idle", solo: "done" });
    render(<AgentSidebar project={project} />);
    expect(chipText("needs_you")).toContain("1");
    expect(chipText("running")).toContain("0");
  });

  it("counts an ORANGE head under Needs you too", () => {
    const project = seed({ a1: "idle", w1: "working", w2: "waiting", solo: "done" });
    render(<AgentSidebar project={project} />);
    expect(chipText("needs_you")).toContain("1");
  });

  it("keeps a rolled-up red head visible when only Needs you is on", () => {
    useUiStore.setState({
      collapsedOrchestrators: {},
      activeSpecial: null,
      statusFilter: { needs_you: true, running: false, done: false },
    } as never);
    const project = seed({ a1: "idle", w1: "blocked", w2: "idle", solo: "done" });
    render(<AgentSidebar project={project} />);
    expect(screen.queryByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Solo")).toBeNull();
  });

  // `unmerged` is GRAY on purpose — a LANDING state, not an alarm. It was red until 27 of 51 agents
  // sat in that band and made red meaningless. The rollup must not quietly re-escalate it.
  it("does not let unmerged workers push their parent into Needs you", () => {
    const project = seed({ a1: "idle", w1: "unmerged", w2: "unmerged" });
    render(<AgentSidebar project={project} />);
    expect(chipText("needs_you")).toContain("0");
  });
});

describe("Build column — a worker going red opens its parent, once", () => {
  it("expands a folded parent when one of its workers turns red", () => {
    const project = seed({ a1: "idle", w1: "working", w2: "working" });
    const { rerender } = render(<AgentSidebar project={project} />);
    expect(screen.queryByText("Parser Worker")).toBeNull();

    useRuntimeStore.setState({ status: { a1: "idle", w1: "blocked", w2: "working" } } as never);
    rerender(<AgentSidebar project={{ ...project }} />);

    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
    expect(screen.queryByText("Parser Worker")).toBeTruthy();
  });

  // Holding it open for as long as the worker stays red turns a helpful reveal into a control that
  // won't take no for an answer. The head's disc keeps carrying the signal after the fold.
  it("stays folded once the user closes it again", () => {
    const project = seed({ a1: "idle", w1: "working", w2: "working" });
    const { rerender } = render(<AgentSidebar project={project} />);
    useRuntimeStore.setState({ status: { a1: "idle", w1: "blocked", w2: "working" } } as never);
    rerender(<AgentSidebar project={{ ...project }} />);
    expect(screen.queryByText("Parser Worker")).toBeTruthy();

    fireEvent.click(rowFor("Alpha")); // the user folds it back
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);

    rerender(<AgentSidebar project={{ ...project }} />); // still red, another render
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
    expect(screen.queryByText("Parser Worker")).toBeNull();
  });

  // On boot the previous snapshot is empty; without the baseline rule every parent with an
  // already-red worker would blow open on every relaunch.
  it("does not force a fold open on first render", () => {
    useUiStore.setState({ collapsedOrchestrators: { a1: true }, activeSpecial: null } as never);
    const project = seed({ a1: "idle", w1: "blocked" });
    render(<AgentSidebar project={project} />);
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
    expect(screen.queryByText("Parser Worker")).toBeNull();
  });
});

// ── Fixes for roborev 53814, each pinned so it can't silently come back ───────────────────────
describe("Build column — the row is a real control, not a div that happens to click", () => {
  // Deleting the chevron BUTTON deleted the only focusable, keyboard-operable way to fold a
  // subtree. Putting aria-expanded on a bare div is invalid ARIA and operable by nobody, so the
  // row has to actually take the semantics it inherited.
  //
  // `treeitem`, not `button`: `button` has PRESENTATIONAL CHILDREN, so AT prunes the subtree — and
  // this row owns a rename input, a close button, the model pill and several chips. It was `button`
  // for one commit; this assertion is what stops that from coming back.
  it("is focusable and exposes a treeitem role, not a button", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(rowFor("Alpha").getAttribute("role")).toBe("treeitem");
    expect(rowFor("Alpha").getAttribute("role")).not.toBe("button");
    expect(rowFor("Alpha").closest('[role="tree"]')).toBeTruthy();
  });

  // ONE tab stop for the column, not one per agent. Unconditional tabIndex={0} (also one commit)
  // meant reaching the terminal required tabbing past the entire fleet.
  it("gives the column a single roving tab stop", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    const stops = Array.from(
      document.querySelectorAll('[data-hint="agent"][tabindex="0"]'),
    );
    expect(stops).toHaveLength(1);
    // With nothing selected it falls to the first rendered row, so the column is always reachable.
    expect(stops[0]).toBe(rowFor("Alpha"));
  });

  it("moves focus between rows with the arrow keys", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    rowFor("Alpha").focus();
    fireEvent.keyDown(rowFor("Alpha"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowFor("Parser Worker"));
    fireEvent.keyDown(rowFor("Parser Worker"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(rowFor("Alpha"));
  });

  // Separated from Enter on purpose: a keyboard user can read a subtree without stealing the
  // terminal, which is what selecting the agent does.
  it("folds with ArrowLeft and unfolds with ArrowRight, without selecting", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    fireEvent.keyDown(rowFor("Alpha"), { key: "ArrowLeft" });
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
    expect(liveProject().selectedAgentId).toBeNull();

    fireEvent.keyDown(rowFor("Alpha"), { key: "ArrowRight" });
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
    expect(liveProject().selectedAgentId).toBeNull();
  });

  it("folds on Enter", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    fireEvent.keyDown(rowFor("Alpha"), { key: "Enter" });
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
  });

  it("folds on Space", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    fireEvent.keyDown(rowFor("Alpha"), { key: " " });
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
  });

  it("leaves other keys alone", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    fireEvent.keyDown(rowFor("Alpha"), { key: "a" });
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
  });
});

describe("Build column — a HINT JUMP selects without folding", () => {
  // HintOverlay's keyboard jump activates an agent with `el.click()`, marking the element with
  // HINT_JUMP_ATTR while it fires. A jump means "take me to this agent"; folding its subtree as
  // well — and persisting that — made repeated jumps flip-flop a subtree nobody touched.
  it("does not toggle the subtree on a marked hint jump", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    const row = rowFor("Alpha");
    row.setAttribute(HINT_JUMP_ATTR, ""); // exactly what HintOverlay does around its click()
    row.click();
    row.removeAttribute(HINT_JUMP_ATTR);
    expect(liveProject().selectedAgentId).toBe("a1"); // selection still happens…
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBeUndefined(); // …the fold does not
  });

  // The reason this is an explicit attribute rather than an `event.detail === 0` sniff: detail
  // describes the DISPATCH MECHANISM, and assistive-tech activations (VoiceOver / Switch Control
  // AXPress on a non-native control) also arrive with detail 0. Under the sniff they were
  // indistinguishable from a hint jump and silently lost the fold.
  it("DOES toggle on an unmarked programmatic click, the way an AT activation arrives", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    rowFor("Alpha").click(); // detail === 0, but no hint marker
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
  });
});

describe("Build column — the rename input keeps its own context menu", () => {
  // preventDefault on the row would suppress the NATIVE menu inside the input — i.e. cut/copy/paste
  // in the only text field in the column — and arm `hover`, so the card sprang open the moment the
  // rename committed.
  it("does not open the card, or eat the default menu, while renaming", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    // Grab the row BEFORE renaming: once the input mounts, the title text is gone from the DOM and
    // rowFor() (which looks the row up by its visible name) can no longer find it.
    const row = rowFor("Alpha");
    fireEvent.doubleClick(screen.getByText("Alpha"));
    expect(screen.getByDisplayValue("Alpha")).toBeTruthy(); // in rename mode

    const ev = createEvent.contextMenu(row);
    fireEvent(row, ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(card()).toBeNull();
  });
});

describe("Build column — the card stands over its row without anything jumping", () => {
  // The card is pinned at the row's own rect and stands in for it, but carries a 2/4px border the
  // row doesn't. A flat padding here put the disc and title several px down-and-right of where they
  // had just been. The horizontal half was always slightly off; cutting the row's vertical padding
  // to 4px made the vertical half obvious.
  // Read side-by-side rather than by splitting the `padding` shorthand: the row's horizontal
  // padding is ASYMMETRIC now (right pays back the pane-side bleed, see rowGeometry), so a
  // positional split would compare the card's left inset against the row's RIGHT one and pass or
  // fail for reasons that have nothing to do with alignment. The card is pinned at the row's left
  // edge, so the left inset is the one that has to agree.
  // MEASURED IN THE STATE THE CARD IS ACTUALLY OPEN IN, and parameterised over the two inputs that
  // move the row's box. Both halves were wrong before and hid a real regression (roborev 55270):
  //
  //  • The row's padding was read BEFORE the card opened. Opening one patches the cable, which opens
  //    the row's concierge end and changes its left padding from 10 to 18 — so the assertion compared
  //    a resting row against a wired card and the two genuinely disagreed.
  //  • It only ever ran in the resting RIGHT pair, which is the one configuration where the row's
  //    left padding happens to be the bare `ROW_PAD_X` the card used to hard-code. Every other
  //    configuration — any left pair, any wired pair — was unmeasured, which is exactly where the
  //    card slid 8px on open.
  for (const paneSide of ["left", "right"] as const) {
    it(`matches the row's content offset on BOTH axes (${paneSide} pair)`, () => {
      const project = seed();
      if (paneSide === "left") {
        useUiStore.setState({ pairAssignment: { [project.id]: "left" }, leftProjectId: project.id } as never);
      }
      render(<AgentSidebar project={project} />);

      // Hold the ELEMENT from before the card opens — React updates it in place, so its style is
      // read post-open below. Looking it up by name afterwards is ambiguous: the open card renders
      // the same agent name a second time.
      const row = rowFor("Alpha");
      fireEvent.contextMenu(row);

      const strip = screen.getByTestId("agent-hover-card").firstElementChild as HTMLElement;
      const border = parseInt(strip.style.border, 10);
      const padY = parseInt(strip.style.paddingTop, 10);
      const padX = parseInt(strip.style.paddingLeft, 10);

      // Read the ROW's padding NOW — this is the state the card is standing in for.
      const rowY = parseInt(row.style.paddingTop, 10);
      const rowX = parseInt(row.style.paddingLeft, 10);

      // border + padding on the card must equal the row's own padding, or the content shifts.
      expect(border + padY).toBe(rowY);
      expect(border + padX).toBe(rowX);
    });
  }

  // THE CARD'S RIGHT EDGE STANDS OVER THE TERMINAL, NOT OVER THE ROW. The two-value `padding`
  // shorthand applied the row's LEFT padding to the card's right as well, and `padLeft` carries the
  // depth indent on an open end — so a worker's card got a ~46px right inset where it had been 6–8,
  // pulling the close ×, the timer and the progress bar in off the card's edge (roborev 55287).
  it("takes the row's RIGHT padding on its right, indent-free", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    const row = rowFor("Alpha");
    fireEvent.contextMenu(row);
    const strip = screen.getByTestId("agent-hover-card").firstElementChild as HTMLElement;
    const border = parseInt(strip.style.border, 10);
    expect(border + parseInt(strip.style.paddingRight, 10)).toBe(
      parseInt(row.style.paddingRight, 10),
    );
  });

  // THE INDENT IS THE CASE THAT BIT. With the two-value shorthand there was one horizontal number to
  // go round, so the card's right side inherited the LEFT's — indent included — and a worker's card
  // got a ~46px right inset. `padRight` never carries the indent at any depth (rowGeometry.test pins
  // that); this is the half that makes sure the CARD actually reads it rather than the left one.
  it("does not let a worker's indent reach the card's right inset", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    const worker = rowFor("Parser Worker");
    fireEvent.contextMenu(worker);
    const strip = screen.getByTestId("agent-hover-card").firstElementChild as HTMLElement;
    const border = parseInt(strip.style.border, 10);
    expect(border + parseInt(strip.style.paddingRight, 10)).toBe(
      parseInt(worker.style.paddingRight, 10),
    );
    // The indent lands on the LEFT and nowhere else, so the two sides genuinely differ here — which
    // is precisely what a single shorthand value could not express.
    expect(parseInt(worker.style.paddingLeft, 10)).toBeGreaterThan(
      parseInt(worker.style.paddingRight, 10),
    );
  });

  // THE RECT AND THE PADDING MUST DESCRIBE THE SAME MOMENT. Opening a card patches the cable, which
  // moves the row's box left and grows its left padding by the same amount — the ink does not move.
  // The card measured the row BEFORE that and padded from AFTER, so it landed 8px off. jsdom rects
  // are all zero, which is why the padding-only assertions above cannot see this: the rect has to be
  // stubbed with real numbers for the absolute ink line to mean anything.
  it("lands its content on the row's ink line, not 8px off it", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    const row = rowFor("Alpha");

    // The row's box left as the browser would report it, and it MOVES with the cable: unwired the
    // box starts inside the list padding, wired it bleeds out to the column edge.
    const COLUMN_EDGE = 100;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const marginLeft = parseInt(row.style.marginLeft || "0", 10);
        return { left: COLUMN_EDGE + 8 + marginLeft, top: 50, width: 200, height: 28 } as DOMRect;
      },
    });

    fireEvent.contextMenu(row);
    const card = screen.getByTestId("agent-hover-card") as HTMLElement;
    const strip = card.firstElementChild as HTMLElement;
    const border = parseInt(strip.style.border, 10);

    // Where the row's own ink sits, post-patch.
    const rowInk =
      COLUMN_EDGE + 8 + parseInt(row.style.marginLeft || "0", 10) + parseInt(row.style.paddingLeft, 10);
    // Where the card's ink sits.
    const cardInk = parseInt(card.style.left, 10) + border + parseInt(strip.style.paddingLeft, 10);
    expect(cardInk).toBe(rowInk);
  });
});

describe("Build column — the rollup label belongs to HEADS only", () => {
  // A worker row has no subtree to summarize. Running one through the override anyway mislabelled
  // it: a stranded worker reads `approval` in the overlaid map but `stopped` in the un-bubbled one,
  // so the bands differed, the override fired, and the row hovered as "Workers need you" — a worker
  // with no workers, having lost the "Approve?" that tells you to start it.
  it("never labels a worker row 'Workers need you'", () => {
    const project = seedExpanded({ a1: "idle", w1: "approval", w2: "idle" });
    render(<AgentSidebar project={project} />);
    const dot = rowFor("Parser Worker").querySelector<HTMLElement>("span[title]")!;
    expect(dot.getAttribute("title")).toBe(AGENT_STATUS.approval.label);
  });
});

describe("Build column — the ACTIVE row still shows its status", () => {
  // The × close control used to take the leading slot on the active row, replacing the disc. That
  // was survivable while the title carried the status color; once titles went neutral it left the
  // one row you are actually working in with no status signal anywhere — no disc, no colored title,
  // no sub-line, no bar, no pulse. The × moved to a trailing slot.
  it("keeps the disc on the selected row, alongside the close control", () => {
    const project = { ...seed({ a1: "working" }), selectedAgentId: "a1" };
    useProjectStore.setState({ projects: [project] } as never);
    render(<AgentSidebar project={project} />);

    const row = rowFor("Alpha");
    expect(row.querySelector('[title="' + AGENT_STATUS.working.label + '"]')).toBeTruthy();
    expect(row.querySelector('[aria-label*="Close"], [title*="Close"]')).toBeTruthy();
  });
});

// ── The WIRING, not the accessor ──────────────────────────────────────────────────────────────
//
// engine/workerRollup.test.ts covers the rules. What it cannot cover is the sidebar handing them
// the right maps, and that is the fragile half: `alertControlKind(a.alert, status[a.id])` must read
// the BUBBLED, pre-dismissal map. Swapping it for `effectiveStatus` — the map every neighbouring
// line uses — returns null for every dismissed agent and silently disables the whole fix, with no
// test failing. Same for the in-motion source.
describe("Build column — the rollup's exceptions are actually wired up", () => {
  const dotFor = (name: string) => rowFor(name).querySelector<HTMLElement>("span[title]")!;

  it("a dismissed head with a red worker reads CALM, not red", () => {
    const project = seed({ a1: "idle", w1: "blocked", w2: "idle" });
    // The head's alarm episode, acknowledged: isAlertSuppressed is dismissedSeq === seq.
    project.agents[0]!.alert = { seq: 1, lastRed: "blocked", dismissedSeq: 1 };
    useProjectStore.setState({ projects: [project] } as never);
    render(<AgentSidebar project={project} />);
    expect(dotFor("Alpha").style.background).toBe(asRgb(AGENT_STATUS.idle.color));
  });

  // …but dismissal silences an ALARM, not the news that work is running.
  it("a dismissed head with a red AND a working worker stays GREEN", () => {
    const project = seed({ a1: "idle", w1: "waiting", w2: "working" });
    project.agents[0]!.alert = { seq: 1, lastRed: "waiting", dismissedSeq: 1 };
    useProjectStore.setState({ projects: [project] } as never);
    render(<AgentSidebar project={project} />);
    expect(dotFor("Alpha").style.background).toBe(asRgb(AGENT_STATUS.working.color));
  });

  // In-motion suppression: a `blocked` worker is red but is not ASKING anything, so it must not
  // paint an orchestrator that is visibly producing output.
  it("a working head with a blocked worker reads GREEN, not red", () => {
    const project = seed({ a1: "working", w1: "blocked", w2: "working" });
    render(<AgentSidebar project={project} />);
    expect(dotFor("Alpha").style.background).toBe(asRgb(AGENT_STATUS.working.color));
  });

  // …and a worker that IS asking always gets through, however busy its parent.
  it("a working head with a WAITING worker still goes orange", () => {
    const project = seed({ a1: "working", w1: "waiting", w2: "working" });
    render(<AgentSidebar project={project} />);
    expect(dotFor("Alpha").style.background).toBe("var(--c-mixed-ink)");
  });
});

describe("Build column — the tree owns only rows", () => {
  // role="tree" was briefly on the whole scroll container, which also holds the filter chips, the
  // sticky "+ New Agent" button, the section headers and the empty states. A tree may own only
  // treeitems and groups; everything else is invalid content that AT drops or misannounces — so
  // that version swallowed the only agent-creation control.
  it("keeps the filter bar and the new-agent button OUTSIDE the tree", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    const tree = document.querySelector('[role="tree"]')!;
    expect(tree).toBeTruthy();
    expect(tree.querySelector('[data-testid="status-filter-bar"]')).toBeNull();
    expect(tree.textContent).not.toContain("New Build Agent");
  });

  // ── THE "+ NEW BUILD AGENT" ROW'S HOVER IS AN INK, AND ITS ICON IS NOT TEXT ───────────────────
  // Both were one-word reverts away from the defects they fixed (roborev 54019). `hoverColor` lands
  // on `color` and `borderColor`, so handing it the chevron's FILL token puts a 3:1-floor colour on
  // a 13px label — ≈3.2:1 in light mode. And an emoji-font glyph ignores `color` outright, so the
  // icon could not follow the hover ink at all. chromeContrast measures the TOKENS; nothing tied
  // this row to the right one, which is what these two pin.
  it("lights the + New Build Agent row in the gold INK, not the chevron's fill", () => {
    render(<AgentSidebar project={seed()} />);
    const row = screen.getByText("+ New Build Agent").closest("button")!;
    expect(row.style.color).toBe(C.muted);
    fireEvent.mouseEnter(row);
    expect(row.style.color).toBe(C.goldInk);
    expect(row.style.borderColor).toBe(C.goldInk);
    // Stated as a failing pairing so the revert is what goes red, not just a value change.
    expect(row.style.color).not.toBe(C.goldFill);
  });

  it("draws that row's icon as an SVG, so it can take the hover ink", () => {
    render(<AgentSidebar project={seed()} />);
    const row = screen.getByText("+ New Build Agent").closest("button")!;
    expect(row.querySelector("svg")).toBeTruthy();
    expect(row.textContent).toBe("+ New Build Agent"); // no ⚒ riding along as text
  });

  // The head's aria-expanded has to own something structurally.
  it("wraps a head's workers in a labelled group", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    const group = document.querySelector('[role="group"][aria-label="Workers for Alpha"]');
    expect(group).toBeTruthy();
    expect(group!.contains(rowFor("Parser Worker"))).toBe(true);
  });

  it("renders no empty group for a childless orchestrator", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(document.querySelector('[role="group"][aria-label="Workers for Solo"]')).toBeNull();
  });
});

describe("Build column — an unmerged head outranks its green rollup, and what that costs", () => {
  // `unmerged` is gray but is still an ASK ("open or merge the PR"), so a running worker does not
  // get to paint over it. The COST of that, recorded here because it is the column that pays it:
  // the head bands `done`, so a Running-only view hides it — and with it the running subtree, since
  // worker rows only render under a visible head. Pinned at this level on purpose; asserting it in
  // the engine would be a tautology over two functions in one module (roborev 53931).
  const seedUnmerged = (status: Record<string, AgentTabStatus>) =>
    seedExpanded(status, {}, { a1: "building_saved", w1: "building_saved", w2: "building_saved" });

  it("keeps the head's dot gray rather than promoting it to green", () => {
    // Unchanged, and the stall escalation deliberately does NOT fire here: this head's worker is
    // `working`, so its subtree is IN MOTION and it is not stalled — the same refusal
    // withRedWorkerAttention makes with the same predicate. Painting it red would say "needs you to
    // unstick it" about a subtree visibly making progress (roborev 55423/55434). The escalation is
    // covered by the sibling case below, where the workers are idle.
    const project = seedUnmerged({ a1: "idle", w1: "working", w2: "idle" });
    render(<AgentSidebar project={project} />);
    const dot = rowFor("Alpha").querySelector<HTMLElement>("span[title]")!;
    expect(dot.style.background).toBe(asRgb(AGENT_STATUS.idle.color));
  });

  it("but a head whose whole subtree is RESTING with unlanded work goes red", () => {
    // The other half, so the in-motion refusal above cannot silently disable the escalation wholesale.
    // Nothing here is working: the head owes unlanded commits and nobody is finishing them.
    const project = seedUnmerged({ a1: "idle", w1: "idle", w2: "idle" });
    render(<AgentSidebar project={project} />);
    const dot = rowFor("Alpha").querySelector<HTMLElement>("span[title]")!;
    expect(dot.style.background).toBe(asRgb(AGENT_STATUS.blocked.color));
  });

  it("counts it under Done, not Running", () => {
    const project = seedUnmerged({ a1: "idle", w1: "working", w2: "idle" });
    render(<AgentSidebar project={project} />);
    expect(screen.getByTestId("status-chip-running").textContent).toContain("0");
  });

  // THE COST, stated as a failing-if-it-changes fact: with Done off, the head and its live worker
  // are both off screen. If this ever stops being acceptable, the fix is to revisit whether
  // `unmerged` should outrank the green rollup — not to split the dot from the band.
  it("hides the head AND its running worker when only Running is shown", () => {
    useUiStore.setState({
      collapsedOrchestrators: { a1: false },
      activeSpecial: null,
      statusFilter: { needs_you: true, running: true, done: false },
    } as never);
    const project = seedUnmerged({ a1: "idle", w1: "working", w2: "idle" });
    render(<AgentSidebar project={project} />);
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Parser Worker")).toBeNull();
  });
});
