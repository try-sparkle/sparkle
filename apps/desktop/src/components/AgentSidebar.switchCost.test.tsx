// @vitest-environment jsdom
//
// WHAT A SWITCH COSTS THE AGENT SIDEBAR, PER ROW — the surface hover-to-preview would fire from.
//
// `Workspace.switchCost.test.tsx` bounds the pane side of a switch (2 pane renders, 0 teardowns).
// This file bounds the OTHER side, and it is the one that matters for hover: the founder wants to
// "hover over a build agent and have that be the one that shows in the terminal", so every row the
// pointer crosses becomes a selection, and each selection re-renders some number of the sidebar's
// rows. If that number is "all of them", hover multiplies a 60-row render by the length of the
// pointer's path. See PRD/sparkle/terminal-switch-latency.md.
//
// WHY THIS EXISTS SEPARATELY FROM THE WORKSPACE SUITE. That suite stubs `AgentSidebar` to a bare
// `<div>`, so its sidebar counter can only ever read 0 or 1 and "not once per agent row" is
// unobservable there by construction — there are no rows. A roborev finding on the first commit of
// this branch called that out correctly. So this file renders the REAL `AgentSidebar` (the
// `AgentSidebar.agentRow.test.tsx` harness proves that is cheap) and counts actual rows.
//
// HOW THE PER-ROW COUNT IS TAKEN WITHOUT TOUCHING `AgentSidebar.tsx`. `AgentRow` is `memo(…,
// agentRowPropsEqual)` but is not exported, and `AgentSidebar.tsx` is 5,052 lines owned by
// concurrent work — so it must not be edited to make it observable. Instead the counter rides on
// `FittedAgentName`: its own leaf module, rendered exactly once per row, NOT itself memoized (so it
// re-renders whenever its parent row does), and receiving the agent's `name`.
//
// WHAT THE PROBE IS AND IS NOT. It counts invocations OF THE NAME LEAF, which is a **lower bound**
// on row re-renders — not a direct count of `AgentRow` renders. A row re-render that somehow did not
// reach its name (a memoized sub-branch) would be missed. That is the honest reading, and it matters
// because the resulting number is shipped as a ratchet and quoted in a PRD. The counting wrapper
// CALLS THROUGH to the real `FittedAgentName` rather than replacing it with a bare `<span>`, so the
// row subtree being measured is the production one — including the `rowTitleWeight(active)` work
// that genuinely does change on a selection switch, which a stub would have skipped and thereby
// measured a cheaper row than ships.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

// THE PROBE. Spread the real module — it also exports `AGENT_NAME_FONT_SIZE` and `rowTitleWeight`,
// which `AgentSidebar` imports at module scope, and a wholesale stub would drop them and break
// collection for a reason unrelated to this measurement.
const { rowRenders } = vi.hoisted(() => ({ rowRenders: new Map<string, number>() }));
vi.mock("./FittedAgentName", async (orig) => {
  const actual = await orig<typeof import("./FittedAgentName")>();
  const Real = actual.FittedAgentName;
  return {
    ...actual,
    FittedAgentName: (props: Parameters<typeof Real>[0]) => {
      rowRenders.set(props.name, (rowRenders.get(props.name) ?? 0) + 1);
      // Call through: the measured subtree is production's, not a cheaper stand-in.
      return (
        <span data-testid={`rowname-${props.name}`}>
          <Real {...props} />
        </span>
      );
    },
  };
});

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { PANES, resetCockpit, seedCockpit } from "./Workspace.costHarness";
import type { Project } from "../types";

/** The row count, which is the harness's pane count by definition — one row per open agent. Aliased
 *  rather than re-declared so the two cost suites cannot drift apart on what "a real cockpit" means.
 *  Fixtures (`mkAgent`/`mkProject`) and the store seeding come from the same harness; re-declaring
 *  them here is what commit 25a424e extracted them to stop. */
const ROWS = PANES;

beforeEach(() => {
  rowRenders.clear();
  seedCockpit();
  // The sidebar reads branch status per row; the cost harness does not seed it (the pane suites
  // don't render rows). Empty is the "no branch info yet" state every row starts in.
  useRuntimeStore.setState({ branchStatus: {} } as never);
});
afterEach(() => {
  cleanup();
  resetCockpit();
});

/** Drive a real selection through the action a row click calls. */
function selectAgent(id: string) {
  act(() => {
    useProjectStore.getState().selectAgent("p1", id);
  });
}

/** How many rows re-rendered since `base`, and which. */
function rowsRenderedSince(base: Map<string, number>): string[] {
  const moved: string[] = [];
  for (const [name, n] of rowRenders) {
    if (n > (base.get(name) ?? 0)) moved.push(name);
  }
  return moved.sort();
}
const snapshot = () => new Map(rowRenders);

/** Total name-leaf invocations across ALL rows — render VOLUME, not the set of rows that moved.
 *  Unbounded by row count, so it catches a step that re-renders the same row twice. */
function totalRenders(): number {
  let n = 0;
  for (const c of rowRenders.values()) n += c;
  return n;
}

/** Mirrors how `Workspace` feeds the sidebar: `project` is DERIVED from the store on every render,
 *  not captured once. Passing a fixed prop would go stale the moment `selectAgent` mints a new
 *  project object, and every bound below would then be measuring a component that never saw the
 *  switch — the precondition, not the side effect. */
function Harness() {
  const project = useProjectStore((s) => s.projects[0] ?? null);
  return <AgentSidebar project={project} />;
}

/** The live project, read fresh from the store (not the stale render-time copy). */
function project(): Project {
  return useProjectStore.getState().projects[0]!;
}

/** THE MEASURED COST OF A PURE SELECTION CHANGE, as a RATCHET. Only the two rows whose selection
 *  highlight actually flips may re-render on a click — so this is 2, and it is recorded here so it
 *  cannot silently regress to "every row" again.
 *
 *  WHY IT IS 2, AND WHY IT WAS 60. `agentRowPropsEqual` (AgentSidebar.tsx) used to compare
 *  `prev.project === next.project`, and `selectAgent` routes through `mapProject`, which replaces the
 *  project OBJECT (changing only `selectedAgentId`). Every one of the 60 `<AgentRow project={project}>`
 *  elements therefore received a fresh reference, the comparator returned false for all of them, and
 *  the memo — which exists precisely so "one agent's frequent status flip re-paints just that agent's
 *  row instead of the whole sidebar subtree" — was defeated for every project-level write (the
 *  "latency moving between build-agent rows" report, ). The comparator now compares the
 *  three project FIELDS a row actually reads — `id`, `rootPath`, `agents` — so a selection change,
 *  which touches none of them, no longer re-renders any row except the two whose `isActive` prop
 *  flipped (a0 loses the highlight, a7 gains it). An agent-DATA write still costs the whole sidebar
 *  (see the last case below) because it mints a fresh `agents` array — that larger cost is separate.
 *
 *  WHY IT MATTERS HERE. Selection is what hover-to-preview fires per row crossed: at the old 60 a
 *  pointer sweeping N rows cost N × 60 row renders; at 2 it is N × 2. See
 *  PRD/sparkle/terminal-switch-latency.md. */
const ROWS_RERENDERED_PER_SELECTION = 2;

/** THE MEASURED COST OF AN AGENT-DATA WRITE, still a RATCHET at 60. Renaming (or any single-agent
 *  mutation) routes through `mapAgent`, which rebuilds the `agents` array, so every row's compared
 *  `project.agents` reference changes and the whole sidebar re-renders. This is the cost the
 *  selection fix deliberately does NOT touch — rows read `project.agents` for sibling-derived data
 *  (epic pills, worker rollups), so narrowing it further is a distinct, riskier change. Recorded so
 *  it stays visible and can't silently get worse. See PRD/sparkle/terminal-switch-latency.md. */
const ROWS_RERENDERED_PER_AGENT_WRITE = 60;

describe("what a switch costs the agent sidebar, per row", () => {
  it(`renders all ${ROWS} rows to begin with`, () => {
    // The precondition, pinned separately so it can never masquerade as the result: a harness that
    // silently rendered zero rows would report "0 rows re-rendered per switch" and pass forever.
    render(<Harness />);
    expect(screen.getAllByTestId(/^rowname-/)).toHaveLength(ROWS);
    expect(rowRenders.size).toBe(ROWS);
  });

  it(`re-renders only ${ROWS_RERENDERED_PER_SELECTION} of ${ROWS} rows on ONE selection change`, () => {
    render(<Harness />);
    const base = snapshot();

    selectAgent("a7");

    // THE MEASUREMENT. Only two rows change anything a reader can see — a0 lost the selection
    // highlight, a7 gained it — so two is the number this SHOULD be, and now is (was 60 before the
    // field-wise `agentRowPropsEqual` fix, ).
    const moved = rowsRenderedSince(base);
    expect(moved).toHaveLength(ROWS_RERENDERED_PER_SELECTION);
    // …and the two rows that genuinely changed are exactly those two — so this is a real switch that
    // moved only the selection, not a write that happened to touch everything while changing nothing.
    expect(moved).toContain("a0");
    expect(moved).toContain("a7");
    expect(project().selectedAgentId).toBe("a7");
  });

  it("costs only that much AGAIN for every step of a hover-style sweep", () => {
    // What a hover sweep is: the pointer crosses a run of rows and each becomes the selection in
    // turn. The cost is now N x 2, not N x 60 — which is what makes hover-to-preview affordable on
    // the React side, independently of the xterm reveal cost measured in the PRD doc.
    //
    // This asserts RAW INVOCATION TOTAL, not the count of distinct rows that moved — the total is the
    // quantity that actually grows if a step re-renders some row more than once. Each of the 5 steps
    // re-renders the row it deselects plus the row it selects: 2 per step, 10 in all. (The very first
    // step deselects a0, seeded selected by the harness; subsequent steps deselect the prior target.)
    render(<Harness />);
    const before = totalRenders();

    for (const id of ["a1", "a2", "a3", "a4", "a5"]) selectAgent(id);

    expect(totalRenders() - before).toBe(5 * ROWS_RERENDERED_PER_SELECTION); // 10 row renders
  });

  it("costs ZERO row re-renders when re-selecting the row already selected", () => {
    // `selectAgent`'s redundant-selection bail, measured on the sidebar — and the one thing standing
    // between hover and a continuous 60-row render loop while the pointer merely RESTS on a row.
    // This is also the control that proves the probe above is live: the same harness reports 60 for
    // a real switch and 0 here, so it is counting selections and not simply counting rows.
    render(<Harness />);
    const base = snapshot();

    selectAgent("a0");
    selectAgent("a0");

    expect(rowsRenderedSince(base)).toEqual([]);
    expect(project().selectedAgentId).toBe("a0");
  });

  it("STILL re-renders every row for a write that touches ONE agent — the cost the fix does not claim", () => {
    // The generalisation, and the boundary of the selection fix: renaming a single agent routes
    // through `mapAgent`, which rebuilds the `agents` array, so every row's compared `project.agents`
    // reference changes and the whole sidebar re-renders. This is DELIBERATELY still 60 (rows read
    // `project.agents` for sibling-derived data, so narrowing it further is a separate change), and
    // pinning it is what proves the selection fix above narrowed the SELECTION path specifically
    // rather than dropping a compared DATA prop and going blind to real changes.
    render(<Harness />);
    const base = snapshot();

    act(() => {
      useProjectStore.getState().renameAgent("p1", "a42", "renamed-42");
    });

    const moved = rowsRenderedSince(base);
    expect(moved).toHaveLength(ROWS_RERENDERED_PER_AGENT_WRITE);
    // The renamed row really did re-render with its new name — without this the bound above could be
    // satisfied by a write that re-rendered everything and changed nothing.
    expect(moved).toContain("renamed-42");
  });
});
