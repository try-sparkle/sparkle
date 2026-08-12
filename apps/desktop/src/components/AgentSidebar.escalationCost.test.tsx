// @vitest-environment jsdom
//
// WHAT THE STALL ESCALATION COSTS, COUNTED — not eyeballed.
//
// `escalatedStatus` asks `withStallAttention` about every agent, and the per-id callback it passes
// needs that agent's record. It used to get it with `project.agents.find((x) => x.id === id)`: a
// linear scan nested inside a linear walk, so the whole memo was O(agents²) in ELEMENT VISITS. The
// memo's dependencies are the probe maps (`branchStatus`, `workflowState`, `workflowStage`), which
// any one agent's poll rewrites — so on the founder's 60-agent fleet it re-ran constantly, and each
// run walked the array ~1,830 times over (Σ i for i ≤ 60, because `find` stops at the match) to
// answer 60 questions.
//
// ── WHY THE ASSERTION IS ELEMENT VISITS AND NOT A STOPWATCH ─────────────────────────────────────
// A wall-clock bound is a flake generator on shared CI, and at n=60 the absolute cost is small
// enough that machine noise swamps it. Visits are deterministic, and they are the thing that
// actually grows quadratically: they are what a stopwatch would be measuring if it could.
//
// ── WHY IT IS MEASURED AT TWO SIZES ─────────────────────────────────────────────────────────────
// A single "visits are low" bound could be satisfied by code that simply stopped asking — an
// optimisation that answers nothing is not an optimisation. So the file pins THREE facts together:
//   1. the LOOKUP scan is gone (its visit count no longer grows with fleet size),
//   2. the escalation still REACHES every agent (the callback is still asked, n times),
//   3. the escalation still lands the same verdict on the row (the paired behavioural test).
// Fact 2 is the one that makes 1 non-vacuous: 60 lookups still happen, they are just not scans.
//
// ── WHAT THIS FILE DOES *NOT* CLAIM ─────────────────────────────────────────────────────────────
// It does not claim the sidebar render path is no longer quadratic, because it very much is. What
// this change removed is ONE of three quadratic terms — and, measured, the smallest of them.
// Everything the render path scans over the agents array, at n=30 vs n=60:
//
//     find    (the lookup FIXED here)         6 calls /   180 visits →  6 calls /   360 visits
//     some    (engine/inMotion.isInMotion)   30 calls /   900 visits → 60 calls / 3,600 visits
//     filter  (per-id parentId callbacks)    38 calls / 1,140 visits → 68 calls / 4,080 visits
//
// So the fix took 1,830 element visits out of a path that still does ~8,000. Both survivors are
// COUNTED and ASSERTED below, not merely logged — an instrument narrower than its claim is how the
// first version of this file managed to look like it proved something it did not (roborev 60536),
// and a counter that is logged but never asserted can go dead just as quietly (roborev 60568).
// They are tracked as sparkle-z5gq8 (`some`) and sparkle-k3wab (`filter`); neither is bounded here
// because the call sites are outside this change's scope.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STATUS } from "../theme/colors";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({
  HistorySearch: () => null,
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
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import { resetThrashTracking } from "../engine/agentThrash";
import { withStallAttention } from "../engine/stallEscalation";
import type { AgentTab, Project } from "../types";
import type { BranchStatus } from "../services/branchStatus";

/** Uncommitted work and nothing else — the cheapest fixture that makes a row ESCALATABLE, so the
 *  per-id callback under measurement is actually invoked for every agent. */
const DIRTY_BS: BranchStatus = {
  ahead: 0,
  behind: 0,
  dirty: true,
  filesChanged: 2,
  insertions: 1,
  deletions: 0,
  worktreeOnBranch: true,
};

function mkAgent(id: string, name: string): AgentTab {
  return {
    id,
    name,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: true,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  };
}

/** Per-method scan tallies. `calls` is how many times anyone reached for a linear scan of the
 *  agents array; `visits` is how many elements those scans touched, which is the quadratic term. */
interface ScanCount {
  calls: number;
  visits: number;
}
type Counts = Record<"find" | "some" | "filter", ScanCount>;

/**
 * An agents array that COUNTS every linear scan run over it.
 *
 * ⚠️ THE INSTRUMENT MUST BE AS WIDE AS THE CLAIM. An earlier version of this file counted `find`
 * alone, and that is exactly narrow enough to make a false statement look proven: the escalation
 * memo ALSO reaches `Array.prototype.some`, via `engine/inMotion.isInMotion`, once per escalatable
 * agent — and an uncounted native `some` reads as zero cost. A test whose instrument is narrower
 * than the property it asserts is a test that cannot see its own counterexample (roborev 60536).
 *
 * The replacements walk the array themselves rather than delegating to the natives, because a
 * native cannot be asked how far it got before it short-circuited.
 */
function countingAgents(agents: AgentTab[]): { agents: AgentTab[]; counts: Counts } {
  const counts: Counts = {
    find: { calls: 0, visits: 0 },
    some: { calls: 0, visits: 0 },
    filter: { calls: 0, visits: 0 },
  };
  const install = (
    name: keyof Counts,
    impl: (
      self: AgentTab[],
      pred: (v: AgentTab, i: number, arr: AgentTab[]) => boolean,
      thisArg: unknown,
      visit: () => void,
    ) => unknown,
  ) => {
    Object.defineProperty(agents, name, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function (
        this: AgentTab[],
        pred: (v: AgentTab, i: number, arr: AgentTab[]) => boolean,
        thisArg?: unknown,
      ) {
        counts[name].calls += 1;
        return impl(this, pred, thisArg, () => {
          counts[name].visits += 1;
        });
      },
    });
  };
  install("find", (self, pred, thisArg, visit) => {
    for (let i = 0; i < self.length; i += 1) {
      visit();
      if (pred.call(thisArg, self[i]!, i, self)) return self[i];
    }
    return undefined;
  });
  install("some", (self, pred, thisArg, visit) => {
    for (let i = 0; i < self.length; i += 1) {
      visit();
      if (pred.call(thisArg, self[i]!, i, self)) return true;
    }
    return false;
  });
  install("filter", (self, pred, thisArg, visit) => {
    const out: AgentTab[] = [];
    for (let i = 0; i < self.length; i += 1) {
      visit();
      if (pred.call(thisArg, self[i]!, i, self)) out.push(self[i]!);
    }
    return out;
  });
  return { agents, counts };
}

function seedFleet(n: number): { project: Project; counts: Counts } {
  const ids = Array.from({ length: n }, (_, i) => `a${i}`);
  const { agents, counts } = countingAgents(ids.map((id, i) => mkAgent(id, `Agent ${i}`)));
  const project: Project = {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: "main",
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents,
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    // Every row calm-but-owing: `idle` is escalatable and the dirty tree is the outstanding cause.
    status: Object.fromEntries(ids.map((id) => [id, "idle"])),
    branchStatus: Object.fromEntries(ids.map((id) => [id, DIRTY_BS])),
    workflowState: {},
    workflowStage: {},
    workflowShipped: {},
    openAgentIds: ids,
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return { project, counts };
}

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    statusFilter: allBandsVisible(),
    revealAgentId: null,
    revealAnchorY: null,
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
  resetThrashTracking();
});
afterEach(() => {
  cleanup();
  resetThrashTracking();
});

describe("escalatedStatus resolves agents by index, not by scanning", () => {
  it("does not grow its LOOKUP cost with the fleet size", () => {
    // The two sizes are the measurement, and each was taken against both versions of the code:
    //
    //     old (project.agents.find)   30 agents: 36 find calls /   645 find visits
    //                                 60 agents: 66 find calls / 2,190 find visits  ← 3.4× for 2×
    //     new (Map lookup)            30 agents:  6 find calls /   180 find visits
    //                                 60 agents:  6 find calls /   360 find visits  ← 2.0×, linear
    //
    // The escalation's own share is the difference: 1,830 element visits per memo evaluation at 60
    // agents, gone. Six constant scans remain, from unrelated call sites on the render path.
    //
    // ⚠️ THE MEMO IS STILL QUADRATIC OVERALL, AND THIS TEST DOES NOT CLAIM OTHERWISE (roborev
    // 60536). `withStallAttention` also calls `engine/inMotion.isInMotion` once per escalatable
    // agent, and that does its own `agents.some(...)` full scan whenever the agent is not itself
    // `working` — which is the whole escalatable set, by definition. At 60 agents that is a further
    // 3,600 element visits, LARGER than the term this change removed. It is logged below so the
    // remaining cost is visible rather than implied, and it is deliberately not bounded here: the
    // scan lives in `engine/inMotion`, outside this change's file scope, and fixing it means giving
    // `withStallAttention` a precomputed parent→working-worker index. Tracked separately.
    const small = seedFleet(30);
    render(<AgentSidebar project={small.project} />);
    // ⚠️ BOTH COUNTERS SNAPSHOTTED HERE, BEFORE `cleanup()`, so the two fleets are compared in the
    // SAME lifecycle state. Reading one after unmount and the other while mounted let any scan
    // performed during teardown land on one side only, failing the comparison for a reason that has
    // nothing to do with fleet size (roborev 60536).
    const find30 = { ...small.counts.find };
    const some30 = { ...small.counts.some };
    const filter30 = { ...small.counts.filter };
    cleanup();

    const big = seedFleet(60);
    render(<AgentSidebar project={big.project} />);
    const find60 = { ...big.counts.find };
    const some60 = { ...big.counts.some };
    const filter60 = { ...big.counts.filter };

    // Reported so a future reader sees the real numbers rather than trusting the bound.
    console.log(
      `[escalationCost] find — 30 agents: ${find30.calls} calls / ${find30.visits} visits; ` +
        `60 agents: ${find60.calls} calls / ${find60.visits} visits | ` +
        `some (isInMotion, NOT fixed here) — 30 agents: ${some30.calls} calls / ` +
        `${some30.visits} visits; 60 agents: ${some60.calls} calls / ${some60.visits} visits | ` +
        `filter — 30 agents: ${filter30.calls} calls / ${filter30.visits} visits; ` +
        `60 agents: ${filter60.calls} calls / ${filter60.visits} visits`,
    );

    // ── THE CRISP ONE: HOW MANY LOOKUP SCANS, AND DOES IT DEPEND ON FLEET SIZE ──────────────────
    // The sidebar makes a handful of genuinely constant `find` calls elsewhere on the render path
    // (six, whatever the fleet size — one full scan each, which is the residual 6n visits below).
    // The escalation's agent lookup used to add ONE MORE PER AGENT on top of that. So "the number
    // of lookup scans is independent of the number of agents" is exactly the property that was
    // broken and is now fixed, and it cannot be satisfied by accident: against the old code these
    // read 36 and 66.
    expect(find60.calls).toBe(find30.calls);
    // …and the quadratic term IN THE LOOKUP is gone with it. Doubling the fleet may at most double
    // the work (the six constant scans are each O(n)); the old code went 645 → 2,190, a 3.4× jump.
    expect(find60.visits).toBeLessThanOrEqual(find30.visits * 2 + 60);

    // ── ⚠️ THESE PIN THE SCANS THAT ARE STILL THERE. THEY ARE MEANT TO GO RED ONE DAY. ──────────
    // Everything below asserts that a KNOWN, UNFIXED quadratic term is STILL PRESENT. It is not
    // guarding the defect — it keeps the instrument honest in both directions:
    //
    //   · A counter that is only LOGGED can go dead. Hand `withStallAttention` a derived array
    //     (`[...project.agents]`, a memoised copy, `topLevelAgents(...)`) and the override stops
    //     being reached; the log prints `0 calls / 0 visits` with the suite green, which reads as
    //     "the remaining scan is gone" (roborev 60568).
    //   · When the scans ARE fixed, the numbers in this file's header and in AgentSidebar's
    //     `agentsById` comment become false, and nothing else would force those to be updated.
    //
    // ⚠️ WHAT A RED MEANS IS ATTACHED TO EACH ASSERTION, NOT WRITTEN OUT HERE.
    // This block used to carry a prose decision tree enumerating the failing conditions, and it
    // drifted from the assertions on every single round of review that touched them (roborev
    // 60615, 60648, 60697, 60721, 60736, 61308) — each fix to an assertion left the tree
    // describing the old one, and more than once the stale tree would have routed a maintainer
    // into exactly the wrong action: deleting a live pin, or re-wiring a working instrument. A
    // condition restated in prose beside the code that computes it is a second source of truth
    // with no test. So the guidance lives in each assertion's own failure message, where it cannot
    // be read without the value that produced it and cannot name a threshold other than the one
    // being applied.
    //
    // (That count is deliberately a LIST OF JOBS rather than a number. The number was itself a
    // restated fact that went stale — it still said "three times" on the fourth round.)
    const AGENT_STEP = 30; // 60 - 30, the fleet-size increment measured above

    // ── THE LIVENESS PROBE IS THE SUM, NOT ANY ONE COUNTER (roborev 61308, 61518) ───────────────
    // This started as a per-scan `calls >= n` check with a three-case prose taxonomy, then became a
    // single probe on `find`. Both were the same mistake in different clothes: keying liveness to a
    // counter whose SUCCESS VALUE CAN LEGITIMATELY BE ZERO.
    //
    //   · The taxonomy was written for `some` (success value 0) and then applied to `filter`, whose
    //     success value is ~8 — so sparkle-k3wab landing fell into the case reading "neither of
    //     those", excluding the bead-landed verdict for the bead the message names.
    //   · `find` is no better: the header records its six remaining calls as UNRELATED render-path
    //     call sites, and indexing those away is the natural continuation of the very change this
    //     file pins (36 → 6 → 0). A probe on `find` alone would then red with "the overrides are
    //     not being reached" while `some`/`filter` were plainly still counting — contradicted by
    //     the same run's own log line. Their call sites are disjoint, so `find === 0` never implied
    //     anything about the others in the first place.
    //
    // A dead instrument is not "some particular scan stopped". It is "the array never reached the
    // component at all", and the only faithful expression of that is that NOTHING scanned it. The
    // sum can only be zero in exactly that case, so this red cannot mis-narrate a landed fix: a
    // zero `find` beside a live `some`/`filter` stays green here and the delta pins do the work.
    const instrumentAlive =
      `INSTRUMENT: not a single scan of the agents array was counted, so the counting overrides ` +
      `are not being reached at all — something now hands this call site a DERIVED or COPIED array ` +
      `([...project.agents], a memoised copy, topLevelAgents(...)). Every counter reads zero for ` +
      `THAT reason, not because a scan was optimised away. RE-WIRE the instrument: do not delete ` +
      `anything, and do not write "the scan is gone" into the header. (This is the SUM across ` +
      `find/some/filter on purpose — any individual counter reaching zero is a legitimate success ` +
      `state for the scan it tracks, and reading one of those as a dead instrument is the exact ` +
      `mis-narration this probe was rewritten twice to remove.)`;
    expect.soft(find30.calls + some30.calls + filter30.calls, instrumentAlive).toBeGreaterThan(0);
    expect.soft(find60.calls + some60.calls + filter60.calls, instrumentAlive).toBeGreaterThan(0);

    // NOTE on the `find` constancy assertion further up: if those six call sites are ever indexed
    // away it becomes 0 === 0 and passes trivially. That is acceptable — "the number of lookup
    // scans does not grow with the fleet" is still true, and more true, of zero of them.

    /** What a maintainer must do when a per-agent term assertion goes red. */
    const delta = (scan: string, bead: string) =>
      `PER-AGENT TERM ('${scan}'): 30 more agents no longer cost 30 more '${scan}' scans of the ` +
      `agents array. ZERO means the per-agent scan no longer runs over THIS array — and the ` +
      `counters cannot tell you which of two causes that is: ${bead} landed (the scan was replaced ` +
      `by an index), or this one call site is now handed a derived/copied array while the ` +
      `constant-count scans still see the instrumented one. They are genuinely indistinguishable ` +
      `from here, so READ THE CALL SITE: scan gone → DELETE this block and correct the prose it ` +
      `names (the header table, and AgentSidebar's agentsById comment); still scanning a copy → ` +
      `re-wire the instrument and delete nothing. Any value other than 0 or ${AGENT_STEP} means ` +
      `the per-agent shape changed — LARGER is a new scan, SMALLER a partial fix. Note this is a ` +
      `DELTA on purpose: '${scan}' has constant-count callers too, so its absolute count at ` +
      `success is not necessarily zero, and only the delta isolates the per-agent term.`;

    expect.soft(some60.calls - some30.calls, delta("some", "sparkle-z5gq8")).toBe(AGENT_STEP);
    expect.soft(some60.visits).toBeGreaterThan(some30.visits * 2);
    // `filter`, via the per-id `agents.filter((a) => a.parentId === id)` callbacks on the render
    // path — the largest of the three, and roughly 2.2× the 1,830 visits this change removed
    // (4,080 vs 1,830 at n=60; NOT an order of magnitude, which an earlier version of this comment
    // claimed while sitting 270 lines under the table that disproves it — roborev 60615).
    expect.soft(filter60.calls - filter30.calls, delta("filter", "sparkle-k3wab")).toBe(AGENT_STEP);
    expect.soft(filter60.visits).toBeGreaterThan(filter30.visits * 2);
  });

  it("STILL ASKS ABOUT EVERY AGENT — the lookups are indexed, not skipped", () => {
    // The half that keeps the bound above honest. An "optimisation" that stopped calling the
    // callback would satisfy every visit bound in this file and quietly delete the feature, so the
    // work itself is counted here: `withStallAttention` is handed a reportOf that must be asked once
    // per escalatable agent. Counted against the REAL engine, driven by the same fixture, so this
    // measures the contract the component relies on rather than restating the component.
    const n = 60;
    const ids = Array.from({ length: n }, (_, i) => `a${i}`);
    const agents = ids.map((id, i) => mkAgent(id, `Agent ${i}`));
    const asked: string[] = [];
    withStallAttention(
      agents,
      Object.fromEntries(ids.map((id) => [id, "idle" as const])),
      (id) => {
        asked.push(id);
        return undefined;
      },
      () => true,
    );
    expect(asked).toHaveLength(n);
    expect(new Set(asked).size).toBe(n);
  });
});

describe("the indexed lookup changes cost, not behaviour", () => {
  it("still escalates every owing row out of the calm tier", () => {
    // THE PAIRED TEST. Cheap lookups are worthless if the rows stop being escalated, and the failure
    // would be silent — a fleet of gray rows looks like a calm fleet. Asserted on the DISC's status
    // label, the one thing on the row that carries status (the column's rule is that status never
    // inks the row's text).
    const { project } = seedFleet(60);
    render(<AgentSidebar project={project} />);

    for (const name of ["Agent 0", "Agent 29", "Agent 59"]) {
      const row = screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
      // Uncommitted changes is a LIFECYCLE cause: amber `lapsed`, not red.
      expect(within(row).getByTitle(AGENT_STATUS.lapsed.label)).toBeTruthy();
      expect(within(row).queryByTitle(AGENT_STATUS.idle.label)).toBeNull();
    }
  });

  it("leaves a row with nothing outstanding calm", () => {
    // The other direction: the index must not turn the escalation into "escalate everything". A
    // clean tree with no goal and no PR owes nothing, so it keeps its gray.
    const { project } = seedFleet(3);
    useRuntimeStore.setState({
      branchStatus: {
        a0: { ...DIRTY_BS, dirty: false, filesChanged: 0, insertions: 0 },
        a1: DIRTY_BS,
        a2: DIRTY_BS,
      },
    } as never);
    render(<AgentSidebar project={project} />);

    const calm = screen.getByText("Agent 0").closest('[data-hint="agent"]') as HTMLElement;
    expect(within(calm).getByTitle(AGENT_STATUS.idle.label)).toBeTruthy();
    expect(within(calm).queryByTitle(AGENT_STATUS.lapsed.label)).toBeNull();

    const owing = screen.getByText("Agent 1").closest('[data-hint="agent"]') as HTMLElement;
    expect(within(owing).getByTitle(AGENT_STATUS.lapsed.label)).toBeTruthy();
  });
});
