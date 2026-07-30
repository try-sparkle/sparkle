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

/** THE MEASURED COST, as a RATCHET. This is not the number anyone wants — it is 60, i.e. every row
 *  in the sidebar re-renders on every selection — and it is recorded here so it cannot get worse
 *  silently and cannot get BETTER silently either. If you fix the cause (below), this test fails;
 *  lower the constant in the same PR.
 *
 *  WHY IT IS 60. `agentRowPropsEqual` (AgentSidebar.tsx) compares `prev.project === next.project`,
 *  and `selectAgent` routes through `mapProject`, which replaces the project OBJECT. Every one of
 *  the 60 `<AgentRow project={project}>` elements therefore receives a fresh reference, the
 *  comparator returns false for all of them, and the memo — which exists precisely so "one agent's
 *  frequent status flip re-paints just that agent's row instead of the whole sidebar subtree" — is
 *  defeated for every project-level write. The comparator is not wrong to compare `project`: rows
 *  read it (beads, epic lookups, worker names) and its own comment warns that dropping a compared
 *  DATA prop leaves rows painting stale data. The cost is structural, not a typo.
 *
 *  WHY IT MATTERS HERE. This is the per-row cost hover-to-preview multiplies: a pointer crossing N
 *  rows costs N × 60 row renders. See PRD/sparkle/terminal-switch-latency.md. */
const ROWS_RERENDERED_PER_SWITCH = 60;

describe("what a switch costs the agent sidebar, per row", () => {
  it(`renders all ${ROWS} rows to begin with`, () => {
    // The precondition, pinned separately so it can never masquerade as the result: a harness that
    // silently rendered zero rows would report "0 rows re-rendered per switch" and pass forever.
    render(<Harness />);
    expect(screen.getAllByTestId(/^rowname-/)).toHaveLength(ROWS);
    expect(rowRenders.size).toBe(ROWS);
  });

  it(`re-renders ${ROWS_RERENDERED_PER_SWITCH} of ${ROWS} rows on ONE selection change`, () => {
    render(<Harness />);
    const base = snapshot();

    selectAgent("a7");

    // THE MEASUREMENT. Only two rows changed anything a reader can see — a0 lost the selection
    // highlight, a7 gained it — so two is the number this SHOULD be. It is 60.
    const moved = rowsRenderedSince(base);
    expect(moved).toHaveLength(ROWS_RERENDERED_PER_SWITCH);
    // …and the two rows that genuinely changed are among them, so this is a real switch and not a
    // store write that happened to touch everything while changing nothing.
    expect(moved).toContain("a0");
    expect(moved).toContain("a7");
    expect(project().selectedAgentId).toBe("a7");
  });

  it("costs that much AGAIN for every step of a hover-style sweep", () => {
    // What a hover sweep is: the pointer crosses a run of rows and each becomes the selection in
    // turn. The cost is N x 60, which is the number that makes hover-to-preview unaffordable on the
    // React side alone, independently of the xterm reveal cost measured in the PRD doc.
    //
    // This asserts RAW INVOCATION TOTAL, not the count of distinct rows that moved. The distinct
    // count is bounded above by ROWS by construction, so summing it could never exceed 5 x 60 no
    // matter how much real work happened — and given the single-switch case above, it would be
    // arithmetically implied rather than independently measured. The invocation total is the
    // quantity that actually grows if a step re-renders some row more than once.
    render(<Harness />);
    const before = totalRenders();

    for (const id of ["a1", "a2", "a3", "a4", "a5"]) selectAgent(id);

    expect(totalRenders() - before).toBe(5 * ROWS_RERENDERED_PER_SWITCH); // 300 row renders
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

  it("re-renders every row for a write that touches ONE agent, too", () => {
    // The generalisation, and why this is not only a hover problem: any projectStore write mints a
    // new project object, so renaming a single agent — or a single status flip, of which a busy
    // fleet produces many per second — costs the whole sidebar. Recorded because it makes the
    // background cost measured in the PRD doc plausible from this direction as well.
    render(<Harness />);
    const base = snapshot();

    act(() => {
      useProjectStore.getState().renameAgent("p1", "a42", "renamed-42");
    });

    const moved = rowsRenderedSince(base);
    expect(moved).toHaveLength(ROWS_RERENDERED_PER_SWITCH);
    // The renamed row really did re-render with its new name — without this the bound above could be
    // satisfied by a write that re-rendered everything and changed nothing.
    expect(moved).toContain("renamed-42");
  });
});
