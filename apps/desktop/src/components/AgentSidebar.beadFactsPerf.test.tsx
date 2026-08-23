// @vitest-environment jsdom
//
// WHAT THE BEADS STORE COSTS THE AGENT SIDEBAR — measured through the REAL component (bead
// sparkle-nkoxqs).
//
// ══ THE DEFECT ══════════════════════════════════════════════════════════════════════════════════
// `AgentRow` used to select `beads` and `board` from the beads store ITSELF, once per row, and then
// per row run `beadLabel` / `epicForBuild` / `countAgentFeedbackBeads` (each a full-store scan) and
// `epicPillFor` (which additionally allocated a fresh 4-way concatenation of the WHOLE board). With
// the founder's ~60 agents against a ~7,400-bead store that is 60 full-store scans and 60
// whole-board allocations per store notification, on the main thread — and it is why switching
// Plan → Build stayed slow even after the Plan board unmounted. `stores/beadsStore.ts` documents
// the same hazard from the store's end; it fixed the half where an UNCHANGED poll no longer
// notifies. This file measures the other half: what a poll that genuinely DOES change costs.
//
// ══ WHY THESE ASSERTIONS AND NOT "THE PILL SHOWS THE RIGHT EPIC" ════════════════════════════════
// The values were already correct before the fix — that is what made this a performance bug rather
// than a visible one. A test asserting the rendered epic pill therefore passes identically against
// the quadratic code and proves nothing about the change. So the assertions here are COUNTS: how
// many times the store gets scanned, and how many rows re-render. `agentBeadFacts.test.ts` covers
// the values, against the un-indexed helpers, so the two halves cannot drift.
//
// Every case below FAILS on the pre-fix code, and each header says with what number.
//
// ══ THE TWO PROBES ══════════════════════════════════════════════════════════════════════════════
//   • `services/planView` — counts full-store index builds and, separately, calls to the
//     un-indexed `epicForBuild` / `epicPillFor` wrappers, which are the ones that rescan the store
//     and allocate the board copy. Both call through to the real implementations, so what is
//     measured is production's work, not a stub's.
//   • `./FittedAgentName` — the per-row render counter, borrowed verbatim from
//     `AgentSidebar.switchCost.test.tsx`. It rides a leaf that is rendered exactly once per row and
//     is not itself memoized, so its invocation count is a LOWER BOUND on row re-renders (a row
//     re-render that somehow never reached its name would be missed). That is the honest reading;
//     it is the same probe the existing switch-cost ratchet is built on.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

const { planViewCalls } = vi.hoisted(() => ({
  planViewCalls: { index: 0, boardIndex: 0, epicForBuild: 0, epicPillFor: 0, beadLabel: 0 },
}));
vi.mock("../services/planView", async (orig) => {
  const actual = await orig<typeof import("../services/planView")>();
  return {
    ...actual,
    // The indexed entry points: one call each is the whole fleet's work.
    buildPlanViewIndex: (...a: Parameters<typeof actual.buildPlanViewIndex>) => {
      planViewCalls.index++;
      return actual.buildPlanViewIndex(...a);
    },
    buildBoardPlanViewIndex: (...a: Parameters<typeof actual.buildBoardPlanViewIndex>) => {
      planViewCalls.boardIndex++;
      return actual.buildBoardPlanViewIndex(...a);
    },
    // The un-indexed wrappers: each rescans the whole store for ONE answer, and `epicPillFor`
    // allocates a whole-board copy while doing it. The sidebar must never reach these.
    epicForBuild: (...a: Parameters<typeof actual.epicForBuild>) => {
      planViewCalls.epicForBuild++;
      return actual.epicForBuild(...a);
    },
    epicPillFor: (...a: Parameters<typeof actual.epicPillFor>) => {
      planViewCalls.epicPillFor++;
      return actual.epicPillFor(...a);
    },
    beadLabel: (...a: Parameters<typeof actual.beadLabel>) => {
      planViewCalls.beadLabel++;
      return actual.beadLabel(...a);
    },
  };
});

const { rowRenders } = vi.hoisted(() => ({ rowRenders: new Map<string, number>() }));
vi.mock("./FittedAgentName", async (orig) => {
  const actual = await orig<typeof import("./FittedAgentName")>();
  const Real = actual.FittedAgentName;
  return {
    ...actual,
    FittedAgentName: (props: Parameters<typeof Real>[0]) => {
      rowRenders.set(props.name, (rowRenders.get(props.name) ?? 0) + 1);
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
import { useBeadsStore } from "../stores/beadsStore";
import { resetCockpit, seedCockpit, mkAgent, mkProject } from "./Workspace.costHarness";
import { bucketBeads, type Bead } from "../services/beads";
import type { AgentTab, Project } from "../types";

/** The founder's real fleet size — the number this whole change is about. */
const ROWS = 60;
/** The founder's real backlog size, rounded. The brief's figure is 7,364 / 11.6 MB. */
const BEADS = 8000;

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return { title: "", description: "", status: "open", labels: [], parent: null, ...partial };
}

/**
 * A backlog of {@link BEADS} beads in which the FIRST `rows` beads are the epics the orchestrators
 * are bound to. `salt` retitles those epics, which is how a case below makes exactly one row's
 * facts move.
 */
function backlog(rows: number, salt = ""): Bead[] {
  const out: Bead[] = [];
  for (let i = 0; i < rows; i++) out.push(bead({ id: `e${i}`, title: `Epic ${i}${salt}`, type: "epic" }));
  for (let i = rows; i < BEADS; i++) {
    out.push(bead({
      id: `filler-${i}`,
      title: `filler ${i}`,
      description: `body ${i}`,
      status: i % 3 === 0 ? "in_progress" : i % 5 === 0 ? "closed" : "open",
      labels: i % 7 === 0 ? ["agent-feedback"] : [],
    }));
  }
  return out;
}

/** `rows` orchestrators, `a{i}` bound to epic `e{i}` — so every row has a pill of its own. */
function fleetOf(rows: number): AgentTab[] {
  return Array.from({ length: rows }, (_, i) => ({ ...mkAgent(`a${i}`), epicId: `e${i}` }));
}

/** Seed a cockpit of `rows` agents over a {@link BEADS}-bead store. */
function seed(rows: number, salt = ""): void {
  seedCockpit();
  const agents = fleetOf(rows);
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", agents)],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({
    openAgentIds: agents.map((a) => a.id),
    status: {},
    branchStatus: {},
  } as never);
  writeBeads(backlog(rows, salt));
}

/** One store write of a whole new snapshot — the shape a real poll lands in. */
function writeBeads(beads: Bead[]): void {
  useBeadsStore.setState({
    byProject: { p1: { beads, board: bucketBeads(beads), loadedAt: 1 } },
    loading: {},
    error: {},
  } as never);
}

function Harness() {
  const project = useProjectStore((s) => s.projects[0] ?? null);
  return <AgentSidebar project={project} />;
}

const snapshot = () => new Map(rowRenders);
function rowsRenderedSince(base: Map<string, number>): string[] {
  const moved: string[] = [];
  for (const [name, n] of rowRenders) if (n > (base.get(name) ?? 0)) moved.push(name);
  return moved.sort();
}
function resetCalls(): void {
  planViewCalls.index = 0;
  planViewCalls.boardIndex = 0;
  planViewCalls.epicForBuild = 0;
  planViewCalls.epicPillFor = 0;
  planViewCalls.beadLabel = 0;
}

beforeEach(() => {
  rowRenders.clear();
  resetCalls();
  useBeadsStore.setState({ byProject: {}, loading: {}, error: {} } as never);
});
afterEach(() => {
  cleanup();
  resetCockpit();
  useBeadsStore.setState({ byProject: {}, loading: {}, error: {} } as never);
});

describe(`${ROWS} agent rows over a ${BEADS}-bead store`, () => {
  it(`renders all ${ROWS} rows — the precondition, pinned so no count below can be vacuous`, () => {
    // A harness that silently rendered zero rows would report "0 store scans per row" and pass
    // forever. Every measurement in this file is meaningless without this.
    seed(ROWS);
    render(<Harness />);
    expect(screen.getAllByTestId(/^rowname-/)).toHaveLength(ROWS);
    expect(rowRenders.size).toBe(ROWS);
    const project = useProjectStore.getState().projects[0] as Project;
    expect(project.agents).toHaveLength(ROWS);
    expect(useBeadsStore.getState().byProject.p1?.beads).toHaveLength(BEADS);
  });

  it("NEVER reaches the whole-store `epicForBuild` / `epicPillFor` wrappers", () => {
    // BEFORE THIS FIX: `epicForBuild` 60 and `epicPillFor` 60 on the mount alone — one full-store
    // scan and one ~6,600-element board concatenation PER ROW. AFTER: zero of each, because the
    // sidebar asks the indexed rule instead. This is assertion (2) of the brief — the per-row
    // allocation — stated as the thing that is no longer called at all.
    seed(ROWS);
    render(<Harness />);
    expect(planViewCalls.epicForBuild).toBe(0);
    expect(planViewCalls.epicPillFor).toBe(0);
    expect(planViewCalls.beadLabel).toBe(0);
  });

  it("scans the store a number of times that does NOT grow with the row count", () => {
    // THE QUADRATIC TEST, and the one that cannot be satisfied by accident. Rendering ten times as
    // many rows over the same backlog must not cost ten times as many full-store passes — so the
    // measurement is taken at two fleet sizes and the two must be EQUAL.
    //
    // Before the fix the two numbers were 6 and 60 (one scan per row, via `epicForBuild`), so this
    // fails on the old code whatever the constant happens to be. Comparing the sizes to each other
    // rather than to a literal is deliberate: it pins the COMPLEXITY, which is the defect, and
    // stays true if a future render pass legitimately changes the constant.
    seed(6);
    const { unmount } = render(<Harness />);
    const small = planViewCalls.index + planViewCalls.boardIndex + planViewCalls.epicForBuild
      + planViewCalls.epicPillFor + planViewCalls.beadLabel;
    unmount();

    rowRenders.clear();
    resetCalls();
    seed(ROWS);
    render(<Harness />);
    const large = planViewCalls.index + planViewCalls.boardIndex + planViewCalls.epicForBuild
      + planViewCalls.epicPillFor + planViewCalls.beadLabel;

    expect(large).toBe(small);
    // …and it is a small constant, not zero — a derivation that never ran would also be "equal".
    expect(large).toBeGreaterThan(0);
    expect(large).toBeLessThanOrEqual(4);
  });

  it("derives the whole fleet ONCE per store change, not once per row", () => {
    // The positive form of the same fact, across a real store write. One new snapshot → one bead
    // index + one board index, for all 60 rows. Before the fix a store write cost 60 of each,
    // because each row re-derived its own on its own subscription.
    seed(ROWS);
    render(<Harness />);
    resetCalls();

    act(() => writeBeads(backlog(ROWS, "-v2")));

    expect(planViewCalls.index).toBe(1);
    expect(planViewCalls.boardIndex).toBe(1);
    expect(planViewCalls.epicForBuild).toBe(0);
    expect(planViewCalls.epicPillFor).toBe(0);
  });
});

describe("React.memo on the row now bites — a store write re-renders only the rows it moved", () => {
  it("re-renders ZERO rows when the store lands a snapshot with the SAME facts", () => {
    // A fresh `beads` array with identical content — the store's own equality check is bypassed
    // here on purpose (`setState`, not `refresh`), because that half is already covered by
    // `beadsStore.rerender.test.tsx`. THIS is the half that has to hold when the array identity
    // really did change: the parent re-derives, every entry compares equal, every entry object is
    // reused, and `agentRowPropsEqual` skips all 60 rows.
    //
    // BEFORE THIS FIX: 60. Each row held its own selector, so a new array reference re-ran every
    // row body regardless of what the comparator said.
    seed(ROWS);
    render(<Harness />);
    const base = snapshot();

    act(() => writeBeads(backlog(ROWS)));

    expect(rowsRenderedSince(base)).toEqual([]);
  });

  it("re-renders EXACTLY the one row whose epic was retitled", () => {
    // THE HEADLINE. One bead moves; one row repaints. Before the fix this was 60 — which is the
    // founder-visible freeze, since it is 60 row bodies plus 60 whole-board allocations for a
    // one-word edit.
    seed(ROWS);
    render(<Harness />);
    const base = snapshot();

    const beads = backlog(ROWS);
    beads.find((b) => b.id === "e7")!.title = "Epic 7 RENAMED";
    act(() => writeBeads(beads));

    expect(rowsRenderedSince(base)).toEqual(["a7"]);
  });

  it("PAIRED: a change that touches every row still re-renders every row", () => {
    // The negative that makes the two zeros above mean something. A comparator hard-wired to
    // "unchanged" — or a derivation that reused entries unconditionally — would score 0 here too,
    // and would freeze the sidebar on stale epic titles forever. That is the exact failure
    // `agentRowPropsEqual`'s own header warns about: a SKIPPED render painting stale data.
    seed(ROWS);
    render(<Harness />);
    const base = snapshot();

    act(() => writeBeads(backlog(ROWS, "-all-moved")));

    expect(rowsRenderedSince(base)).toHaveLength(ROWS);
  });

  it("re-renders only the row whose FEEDBACK count changed", () => {
    // The fourth fact on the prop, moved independently of the other three — so the identity reuse
    // is keyed on all of them and not merely on the epic pill.
    seed(ROWS);
    render(<Harness />);
    const base = snapshot();

    const beads = backlog(ROWS);
    beads.push(bead({ id: "fb", title: "fb", labels: ["agent:a23"] }));
    act(() => writeBeads(beads));

    expect(rowsRenderedSince(base)).toEqual(["a23"]);
  });
});
