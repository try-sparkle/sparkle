// @vitest-environment jsdom
//
// THE "CONCIERGE AGENTS" ROW — bead `sparkle-s7rfc`.
//
// The founder asked for one row above Improve Sparkle "like a build orchestrator with '+[n]' showing
// how many agents are running", openable into indented children, each openable into a detail. Every
// clause of that sentence has a test below, plus the two properties the row's own header argues for:
// its dot comes from the CALLER's rollup pipeline, and it is `memo`'d so an unrelated agent's status
// flip cannot re-render it.
//
// ══ THE ASSERTION MOST LIKELY TO GO VACUOUS, AND WHAT IS DONE ABOUT IT ═════════════════════════
//
// `+[n]` counts queued + running. A fixture containing only live tasks would let a `+tasks.length`
// bug pass; a fixture of six where two are live cannot. So the count is asserted against
// `researchTasks.sample.json`, which carries ALL FIVE statuses (queued, running, done ×2, failed,
// cancelled), and the test states the arithmetic it depends on — 6 tasks, 2 live — so a fixture edit
// that changed the mix would fail here rather than silently weaken the check.
//
// ══ jsdom ═════════════════════════════════════════════════════════════════════════════════════
//
// No layout, so nothing here measures geometry (`docs/jsdom-test-caveats.md`). Every assertion is on
// rendered text, roles, DOM order, or an inline style the component itself writes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

// THE TWO TAURI COMMANDS THIS ROW ISSUES, and nothing else about the store.
//
// `refreshResearch` really does run on mount (there is a test for it), and in jsdom its `invoke`
// would reject — harmless, since the real function swallows it, but it would also REPLACE whatever a
// test seeded with the empty listing. So the two commands are stubbed while `useResearchStore`,
// `liveTasks` and `sortedTasks` stay the genuine article: the seam is the backend, not the store.
const backend = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
  cancel: vi.fn(),
}));
vi.mock("../services/research/store", async (orig) => {
  const actual = await orig<typeof import("../services/research/store")>();
  return { ...actual, refreshResearch: backend.refresh, cancelResearch: backend.cancel };
});

// HOW A ROW RENDER IS COUNTED — the same technique AgentSidebar.revealRenderCost uses.
//
// `rowBoxFor` is called exactly once, unconditionally, in `ConciergeAgentsRow`'s body, so the REAL
// function wrapped in a counter is a faithful per-render tally. A stub would change the geometry the
// row paints with and would be measuring a different component than the one that ships.
//
// Callers are told apart by their ARGUMENTS: `AgentRow` and `ConciergeTaskRow` both pass
// `depthIndent`; of the two that do not, `SparkleAgentRow` is the other — so the memo test renders
// with `showSparkleRow={false}` and this predicate then names exactly one component.
const rowRenders = vi.hoisted(() => ({ n: 0 }));
vi.mock("./rowAnatomy", async (orig) => {
  const actual = await orig<typeof import("./rowAnatomy")>();
  return {
    ...actual,
    rowBoxFor: (opts: Parameters<typeof actual.rowBoxFor>[0]) => {
      if (opts.pinned === true && !("depthIndent" in opts)) rowRenders.n += 1;
      return actual.rowBoxFor(opts);
    },
  };
});

import { AGENT_STATUS } from "@sparkle/ui";
import { AgentSidebar } from "./AgentSidebar";
import { CONCIERGE_TITLE_FLOOR_PX } from "./rowWidthThresholds";
import {
  ConciergeAgentsRow,
  CONCIERGE_AGENTS_HINT,
  CONCIERGE_AGENTS_TITLE,
  livenessOfResearch,
  researchRollupStatuses,
} from "./ConciergeAgentsRow";
import { asRgb } from "./statusDotTestUtils";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useInteractionStore } from "../stores/interactionStore";
import { useConciergeQueueStore } from "../stores/conciergeQueueStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import {
  _resetResearchStoreForTests,
  groupTasks,
  RECENT_RESEARCH_WINDOW_LABEL,
  RECENT_RESEARCH_WINDOW_SHORT_LABEL,
  RECENT_RESEARCH_WINDOW_MS,
  RESEARCH_POLL_INTERVAL_MS,
  useResearchStore,
} from "../services/research/store";
import { openResearchTaskInPane } from "../services/research/selection";
import type { ResearchTask } from "../services/research/types";
import type { AgentTab, AgentTabStatus, Project } from "../types";

// THE SHARED FIXTURE — the same file `store.test.ts` and the Rust round-trip read. Loading it from
// disk rather than restating a few tasks inline is the point: a hand-built array here would be a
// second description of the wire shape, which is exactly the drift the contract file was split out
// to prevent.
const FIXTURE: ResearchTask[] = JSON.parse(
  readFileSync(
    join(__dirname, "..", "services", "research", "fixtures", "researchTasks.sample.json"),
    "utf8",
  ),
);
/** The arithmetic the `+[n]` assertion depends on, stated so a fixture edit fails loudly. */
const LIVE_IN_FIXTURE = 2;
const TASKS_IN_FIXTURE = 6;
/**
 * How many of those the row actually RENDERS. One fixture task is already claimed, and a claimed
 * terminal task is retired — the row tears it down rather than stacking it up forever.
 *
 * Derived from the fixture rather than hard-coded to 5, so adding a claimed task to the fixture
 * cannot make this drift into a number that means nothing.
 */
const VISIBLE_IN_FIXTURE = FIXTURE.filter(
  (t) => !(t.status !== "queued" && t.status !== "running" && t.readAt !== null),
).length;

const DONE_WITH_FINDINGS = FIXTURE.find((t) => t.status === "done" && t.findings !== null)!;
const RUNNING = FIXTURE.find((t) => t.status === "running")!;

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

function seed(status: Record<string, AgentTabStatus> = {}): Project {
  const agents = [mkAgent("a1", "Alpha")];
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents,
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {}, status,
    openAgentIds: agents.map((a) => a.id),
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

/** Put `tasks` in the store as though a listing had landed. `hydrated` separates "+0" from "we have
 *  not looked yet", so it is set explicitly rather than implied. */
function seedResearch(tasks: readonly ResearchTask[], hydrated = true) {
  useResearchStore.setState({
    byId: Object.fromEntries(tasks.map((t) => [t.id, t])),
    hydrated,
    openTaskId: null,
  });
}

const row = () =>
  screen.getByText(CONCIERGE_AGENTS_TITLE).closest(`[data-hint="${CONCIERGE_AGENTS_HINT}"]`)!;
const childRows = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-hint="concierge-agent"]'));

beforeEach(() => {
  rowRenders.n = 0;
  backend.refresh.mockClear();
  backend.cancel.mockReset();
  _resetResearchStoreForTests();
  // Back to NOBODY HAS LOOKED. A depth published by one test would otherwise be the standing
  // reading for every test after it — the exact "last reading stands forever" failure the store's
  // own header describes for a host that is torn down without clearing.
  useConciergeQueueStore.getState()._resetForTests();
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    statusFilter: allBandsVisible(),
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
  useSettingsStore.setState({ sparkleImprovementConsent: "always" } as never);
  useInteractionStore.setState({ lastAt: {} } as never);
});
afterEach(cleanup);

// ── 1. THE ROW ITSELF ──────────────────────────────────────────────────────────────────────────
describe("Concierge Agents — one row, always present", () => {
  it("renders `0 active now` and no children when there are no tasks", () => {
    seedResearch([]);
    render(<AgentSidebar project={seed()} />);
    expect(row().textContent).toContain("0 active now");
    expect(childRows()).toHaveLength(0);
  });

  // "0 active now" is a claim ("nothing is running"); before the first listing lands the row has no
  // basis for it. `hydrated` is the difference, and without this test the badge could be hardcoded on.
  //
  // ⚠️ THE ABSENCE ASSERTION NAMES THE BADGE'S OWN WORDS, and must keep naming them. It used to read
  // `not.toContain("+")`, which was load-bearing while the gauge rendered as `+0` — and the moment
  // the copy became "0 active now" that assertion went VACUOUS: no `+` is printed anywhere on the
  // row any more, so it passes against a component that renders the badge unconditionally. That is
  // the vacuous-test shape AGENTS.md names first (an assertion already true before the change), and
  // it would have shipped green.
  it("shows no badge at all before the first listing lands", () => {
    seedResearch([], false);
    render(<AgentSidebar project={seed()} />);
    expect(row().textContent).toContain(CONCIERGE_AGENTS_TITLE);
    expect(row().textContent).not.toContain("active now");
  });

  // The store is a cache and the disk is the truth: the concierge that dispatched a task has usually
  // exited before this window paints, so a row that trusted an empty store would report "+0" for
  // work running right now.
  it("hydrates itself on mount", () => {
    seedResearch([]);
    render(<AgentSidebar project={seed()} />);
    expect(backend.refresh).toHaveBeenCalled();
  });
});

// ── 2. THE COUNT ───────────────────────────────────────────────────────────────────────────────
describe("Concierge Agents — +[n] counts only queued + running", () => {
  // THE ANTI-VACUITY GUARD, stated first: the fixture must keep containing every status, or the
  // assertion below degrades into "+n === tasks.length" without anyone noticing.
  it("is asserted against a fixture carrying all five statuses", () => {
    expect(FIXTURE).toHaveLength(TASKS_IN_FIXTURE);
    expect(new Set(FIXTURE.map((t) => t.status))).toEqual(
      new Set(["queued", "running", "done", "failed", "cancelled"]),
    );
    expect(FIXTURE.filter((t) => t.status === "queued" || t.status === "running")).toHaveLength(
      LIVE_IN_FIXTURE,
    );
  });

  it("counts the live tasks, not the terminal ones", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    expect(row().textContent).toContain(`${LIVE_IN_FIXTURE} active now`);
    // …and it is genuinely a subset: the total would read differently.
    expect(row().textContent).not.toContain(`${TASKS_IN_FIXTURE} active now`);
  });

  // The disc reads from the SAME live set the badge does. Green while anything is live, gray when
  // nothing is — so the number and the colour can never contradict each other.
  it("paints its disc from the same live set", () => {
    seedResearch(FIXTURE);
    const { rerender } = render(<AgentSidebar project={seed()} />);
    const disc = () => row().querySelector<HTMLElement>("span[title]")!;
    const busy = disc().style.background;
    expect(disc().getAttribute("title")).toBe("Workers running");

    // Every live task gone → the row goes calm and the badge goes to zero, together.
    act(() => seedResearch(FIXTURE.filter((t) => t.status !== "queued" && t.status !== "running")));
    rerender(<AgentSidebar project={seed()} />);
    expect(row().textContent).toContain("0 active now");
    expect(disc().style.background).not.toBe(busy);
  });
});

// ── 3. OPENING THE ROW, AND OPENING A CHILD ────────────────────────────────────────────────────
describe("Concierge Agents — click the row, then click an agent", () => {
  it("is collapsed by default and expands to one child per task", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    expect(childRows()).toHaveLength(0);
    expect(row().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(row());
    expect(row().getAttribute("aria-expanded")).toBe("true");
    // NOT `TASKS_IN_FIXTURE`: the already-claimed task is retired and must not be rendered. That
    // difference is the whole feature, so the two constants are deliberately kept apart.
    expect(childRows()).toHaveLength(VISIBLE_IN_FIXTURE);
    expect(VISIBLE_IN_FIXTURE).toBeLessThan(TASKS_IN_FIXTURE);
  });

  // THE FOUNDER'S COMPLAINT, in a real render: 28 rows stacked up because nothing ever retired one.
  // Asserting on the CHANGE — same task list, one claim stamped, one fewer row — rather than on a
  // count, which a fixture edit could satisfy by accident.
  it("tears a row down the moment its task is claimed, leaving the others alone", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    const before = childRows().length;
    const victim = FIXTURE.find((t) => t.status === "failed")!;
    expect(screen.getAllByText(victim.question).length).toBeGreaterThan(0);

    act(() => {
      seedResearch(
        FIXTURE.map((t) => (t.id === victim.id ? { ...t, readAt: 1_754_700_500_000 } : t)),
      );
    });

    expect(childRows()).toHaveLength(before - 1);
    expect(screen.queryByText(victim.question)).toBeNull();
  });

  // The other half, and the one that must never regress: a finished task whose findings have NOT
  // been delivered stays on screen. If this ever goes red, the row is discarding a finding.
  it("KEEPS a finished task whose findings are still owed", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    const owed = FIXTURE.find((t) => t.status === "done" && t.readAt === null)!;
    expect(screen.getAllByText(owed.question).length).toBeGreaterThan(0);
  });

  it("folds again on a second click", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    fireEvent.click(row());
    expect(childRows()).toHaveLength(0);
  });

  it("indents its children exactly as a build worker is indented", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    // The hanging indent is 32px of DEPTH_INDENT, landing on a SHUT end as margin or on an OPEN end
    // as padding (engine/rowGeometry). Whichever end this pair puts it on, the child must be inset
    // from the header by exactly that, and the header must not be inset at all.
    const header = row() as HTMLElement;
    const child = childRows()[0]!;
    const inset = (el: HTMLElement) =>
      parseFloat(el.style.marginLeft || "0") + parseFloat(el.style.paddingLeft || "0");
    expect(inset(child) - inset(header)).toBe(32);
  });

  // ══ THE FOUNDER'S ASK: A CHILD CLICK ROUTES TO THE MAIN PANE, NOTHING OPENS INLINE ═════════════
  //
  // Founder 2026-08-17: a research agent should work "exactly like any other worker" — click its
  // name and the RIGHT pane shows it, with nothing expanding in the builder column. So a child click
  // is a SELECTION (openTaskId + activeSpecial="research"), and the old inline detail panel is gone.
  // The pane content itself is asserted in ConciergeResearchPane.test.tsx (AgentSidebar does not
  // render the pane); here we prove the ROUTING and, as the paired negative, the ABSENCE of any
  // inline detail in the sidebar.
  it("selects the task into the main pane and renders NO inline detail in the sidebar", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    // PAIRED NEGATIVE, before: nothing selected, no research surface active.
    expect(useResearchStore.getState().openTaskId).toBeNull();
    expect(useUiStore.getState().activeSpecial).toBeNull();

    const target = childRows().find(
      (r) => r.getAttribute("data-task-id") === DONE_WITH_FINDINGS.id,
    )!;
    fireEvent.click(target);

    // The routing: this task is now the main-pane selection.
    expect(useResearchStore.getState().openTaskId).toBe(DONE_WITH_FINDINGS.id);
    expect(useUiStore.getState().activeSpecial).toBe("research");
    // …and the selected child reflects it.
    expect(target.getAttribute("aria-pressed")).toBe("true");
    // THE OLD INLINE PANEL IS GONE — the whole point. Neither the panel nor its findings/error/tier
    // render anywhere in the sidebar column.
    expect(screen.queryByTestId("concierge-agent-detail")).toBeNull();
    expect(screen.queryByTestId("concierge-agent-findings")).toBeNull();
    expect(screen.queryByTestId("concierge-agent-error")).toBeNull();
  });

  it("clicking the selected child again clears the main-pane selection", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    const target = childRows().find(
      (r) => r.getAttribute("data-task-id") === DONE_WITH_FINDINGS.id,
    )!;
    fireEvent.click(target);
    expect(useUiStore.getState().activeSpecial).toBe("research");

    // Click-again puts it away — same gesture a selected build head uses to fold.
    fireEvent.click(target);
    expect(useResearchStore.getState().openTaskId).toBeNull();
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(target.getAttribute("aria-pressed")).toBe("false");
  });
});

// ── 3b. THE CHAT LINK OPENS THE ROW AND THE MAIN PANE ────────────────────────────────────────────
//
// The concierge names a dispatched task as a `sparkle-research:` pill; clicking it calls
// `openResearchTaskInPane` (see `ResearchPill`), which sets `openTaskId` AND activeSpecial="research"
// so the task shows in the MAIN pane. This is the row's half of that gesture: it must EXPAND the
// collapsed group, mark that task's child selected, and scroll the row to the founder — otherwise
// the link would leave the child unreachable and read as dead.
describe("Concierge Agents — a chat-link click reveals the task's row and selects it", () => {
  it("expands the collapsed group and selects the task's child when the pane is opened", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    // Collapsed, nothing clicked — the founder has not touched the header.
    expect(row().getAttribute("aria-expanded")).toBe("false");
    expect(childRows()).toHaveLength(0);
    expect(screen.queryByTestId("concierge-agent-detail")).toBeNull();

    // The pill's whole effect: open the task in the main pane. No header click.
    act(() => openResearchTaskInPane(DONE_WITH_FINDINGS.id));

    expect(row().getAttribute("aria-expanded")).toBe("true");
    expect(childRows()).toHaveLength(VISIBLE_IN_FIXTURE);
    // …and it is THAT task's child that is selected, not merely the group that opened. Still no
    // inline detail — the content is in the main pane now.
    const selected = childRows().find(
      (r) => r.getAttribute("data-task-id") === DONE_WITH_FINDINGS.id,
    )!;
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("concierge-agent-detail")).toBeNull();
  });

  it("scrolls the opened row into view", () => {
    // jsdom implements no layout, so `scrollIntoView` is absent; the row optional-calls it, and this
    // supplies a spy to prove the call is made on the open edge.
    const spy = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      seedResearch(FIXTURE);
      render(<AgentSidebar project={seed()} />);
      act(() => openResearchTaskInPane(RUNNING.id));
      const opened = childRows().find((r) => r.getAttribute("data-task-id") === RUNNING.id)!;
      // The spy fires with the opened row as `this`; asserting the instance is what ties the scroll
      // to the RIGHT task rather than to any row that happened to mount.
      expect(spy.mock.instances).toContain(opened);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  // THE EDGE-VS-CONDITION BUG (roborev 63900). `openTaskId` is sticky and the poll rebuilds `byId`
  // every 5s, so a condition-based reveal re-fired within one interval of every manual collapse and
  // popped the group back open forever. The reveal fires on the OPEN GESTURE (seq), which a poll
  // never sends, so a collapse the founder made stays made across a poll that lands identical data.
  it("stays collapsed after the founder collapses it, even across a poll", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    act(() => useResearchStore.getState().setOpenTask(DONE_WITH_FINDINGS.id));
    expect(row().getAttribute("aria-expanded")).toBe("true");

    // Founder collapses from the header. `openTaskId` is left sticky by design.
    fireEvent.click(row());
    expect(row().getAttribute("aria-expanded")).toBe("false");

    // A FAITHFUL poll: `replaceAll` is exactly what `refreshResearch` calls — it rebuilds `byId`
    // (new `tasks` identity, same data) and leaves `openTaskId`/`openTaskSeq` sticky. `seedResearch`
    // could NOT stand in here: it also clears `openTaskId`, which sends the effect down the null
    // branch and would pass against the very bug this guards (roborev 63906). The condition-based
    // effect re-expands here; the seq-keyed one must not.
    act(() => useResearchStore.getState().replaceAll([...FIXTURE]));
    expect(row().getAttribute("aria-expanded")).toBe("false");
  });

  // THE PAIRED DIRECTION (roborev 63906/63907): the collapse must not make the pill a DEAD link.
  // Clicking the same pill again after a header collapse is a fresh gesture — the seq bumps even
  // though `openTaskId` is unchanged — so the group re-opens. Keyed on the value instead, this click
  // wrote a string the store already held, nothing re-rendered, and the click did nothing forever.
  it("re-opens the group when the SAME pill is clicked again after a manual collapse", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    act(() => openResearchTaskInPane(DONE_WITH_FINDINGS.id));
    expect(row().getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(row());
    expect(row().getAttribute("aria-expanded")).toBe("false");

    // Same id again — a repeat pill click. `openTaskId` does not change, but the gesture does.
    act(() => openResearchTaskInPane(DONE_WITH_FINDINGS.id));
    expect(row().getAttribute("aria-expanded")).toBe("true");
    const reselected = childRows().find(
      (r) => r.getAttribute("data-task-id") === DONE_WITH_FINDINGS.id,
    )!;
    expect(reselected.getAttribute("aria-pressed")).toBe("true");
  });

  // A stale id — a task since retired, or one this window never listed — must NOT force the group
  // open around nothing. The membership guard is what makes the reveal safe to drive from text the
  // model wrote at a time the task was live.
  it("does not expand for an openTaskId that names no visible task", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    act(() => useResearchStore.getState().setOpenTask("rsh_not_a_real_task"));
    expect(row().getAttribute("aria-expanded")).toBe("false");
    expect(childRows()).toHaveLength(0);
  });
});

// THE TIER, THE FINDINGS, THE ERROR, AND CANCEL all moved to the MAIN pane
// (ConciergeResearchPane.test.tsx) — they no longer render in the sidebar. The row's job is now to
// SELECT; the pane's job is to SHOW. Keeping the display assertions here would test a surface that
// no longer draws them.

// ── 5. POSITION ────────────────────────────────────────────────────────────────────────────────
describe("Concierge Agents — pinned directly above Improve Sparkle", () => {
  it("comes before the Improve Sparkle row in DOM order", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    const improve = screen.getByText("Improve Sparkle").closest('[data-hint="improve"]')!;
    expect(
      row().compareDocumentPosition(improve) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("sits outside the scrolling list, below it", () => {
    seedResearch([]);
    render(<AgentSidebar project={seed()} />);
    const list = screen.getByTestId("agent-list-scroll");
    expect(list.contains(row())).toBe(false);
    expect(list.compareDocumentPosition(row()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // "always present": no project, no agents, still there. It is the only surface naming the research
  // tasks, so it cannot be something that appears only once work exists.
  it("renders with no project open at all", () => {
    seedResearch([]);
    useProjectStore.setState({ projects: [] } as never);
    useRuntimeStore.setState({
      status: {}, openAgentIds: [], branchStatus: {}, workflowStage: {},
    } as never);
    render(<AgentSidebar project={null} />);
    expect(row()).toBeTruthy();
  });
});

// ── 5b. THE POLL ───────────────────────────────────────────────────────────────────────────────
//
// THE POLL IS THE FIX FOR "THE FEATURE WAS INERT", AND NOTHING PINNED IT (roborev 61724).
//
// A task dispatched by a concierge that has since exited completes minutes later, and the row is the
// only thing watching: without a poll it hydrated once at mount and then froze — `+[n]` stuck, a
// finished task still rendering as `running`, for the life of the window. Deleting the `setInterval`
// left every suite green, so the exact failure being repaired could return silently.
//
// The assertion is on the INVOKE COUNT, not on the constant existing: a test that read
// `RESEARCH_POLL_INTERVAL_MS` would pass against a component that imports it and never uses it.
describe("Concierge Agents — the row keeps polling while it is mounted", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refreshes again one interval after mount, and stops when unmounted", () => {
    seedResearch([]);
    const view = render(<AgentSidebar project={seed()} />);
    expect(backend.refresh).toHaveBeenCalledTimes(1); // the hydrate-on-mount read

    act(() => void vi.advanceTimersByTime(RESEARCH_POLL_INTERVAL_MS));
    expect(backend.refresh).toHaveBeenCalledTimes(2);
    act(() => void vi.advanceTimersByTime(RESEARCH_POLL_INTERVAL_MS));
    expect(backend.refresh).toHaveBeenCalledTimes(3);

    // …AND THE TIMER IS CLEARED. A poll that outlives its component leaks one interval per window
    // open/close and keeps reading the disk for a row nobody is looking at.
    view.unmount();
    act(() => void vi.advanceTimersByTime(RESEARCH_POLL_INTERVAL_MS * 3));
    expect(backend.refresh).toHaveBeenCalledTimes(3);
  });
});

// ── 6. THE MEMO CONTRACT ───────────────────────────────────────────────────────────────────────
//
// `SparkleAgentRow` is `memo`'d with primitive props for a measured reason (sparkle-alrm.3): on a
// 60-agent fleet, a row that re-renders on every unrelated status flip costs a render of its whole
// body per flip. This row carries children and a detail block, so it costs more — and it subscribes
// to a store, which is the documented way around a comparator (see AgentSidebar.revealRenderCost).
//
// `showSparkleRow={false}` so the counter's predicate ("pinned, no depthIndent") names exactly one
// component. The guard case is what makes this test non-vacuous: a counter that never increments
// would satisfy the first assertion trivially.
describe("Concierge Agents — one row per window", () => {
  // TWO SIDEBARS, ONE ROW. AgentSidebar mounts twice when two pairs are open (Workspace.tsx), and a
  // duplicated pinned row is a founder-reported bug (sparkle-x0pvw) — it was rebuilt one row higher
  // here: two rows, both polling, a duplicated DOM id whose aria-controls resolved to the wrong
  // column, and a shared `openTaskId` that opened a task in both (roborev 61699).
  it("renders exactly once across two sidebars, the way the window mounts them", () => {
    seedResearch(FIXTURE);
    render(
      <>
        <AgentSidebar project={seed({ a1: "idle" })} showSparkleRow={false} showConciergeRow={false} />
        <AgentSidebar project={seed({ a1: "idle" })} showSparkleRow={false} />
      </>,
    );
    expect(screen.getAllByText(/Concierge Agents/i)).toHaveLength(1);
  });
});

describe("Concierge Agents — memo contract", () => {
  it("does not re-render when an unrelated project agent flips status", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed({ a1: "idle" })} showSparkleRow={false} />);
    const before = rowRenders.n;
    expect(before).toBeGreaterThan(0);

    act(() => {
      useRuntimeStore.setState({ status: { a1: "working" } } as never);
    });
    expect(rowRenders.n).toBe(before);

    act(() => {
      useRuntimeStore.setState({ status: { a1: "waiting" } } as never);
    });
    expect(rowRenders.n).toBe(before);
  });

  // THE GUARD. If the counter could not move, the assertions above would prove nothing — so a change
  // the row genuinely depends on must move it.
  it("does re-render when its own live count changes", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed({ a1: "idle" })} showSparkleRow={false} />);
    const before = rowRenders.n;

    act(() => {
      seedResearch([
        ...FIXTURE,
        { ...RUNNING, id: "rsh_extra_running" },
      ]);
    });
    expect(rowRenders.n).toBeGreaterThan(before);
    expect(row().textContent).toContain(`${LIVE_IN_FIXTURE + 1} active now`);
  });
});

// ── THE ROLLED-UP DISC IS DRAWN AS A RING, NOT A FILL (roborev 63208) ────────────────────────────
//
// `AgentSidebar` threads `dotRing` here exactly where it threads `dotColor`, so a borrowed colour
// reads as "something under this row", not "answer me" — the rule `AgentSidebar.rollupRing.test.tsx`
// pins for the ordinary head row and the Improve Sparkle row.
//
// ⚠️ IT IS ASSERTED ON THE COMPONENT, DELIBERATELY, and that is the honest scope. The sidebar-level
// state cannot be reached today: `researchRollupStatuses` maps every live task to `working` and
// drops the terminal ones, so `conciergeRollup` is never red or orange and the caller's
// `dotRing={…}` expression is always `false`. Its docstring states that as a decision and designs
// the extension — *"if research ever grows a state that genuinely blocks the founder, add it here
// and the whole rollup/band/chip chain follows for free."* "For free" is only true if the prop is
// threaded to the disc, which is precisely what these two rows prove, and what would otherwise be
// covered by nothing at all.
describe("ConciergeAgentsRow — a borrowed colour draws a ring", () => {
  const BORROWED = AGENT_STATUS.waiting.color;
  const props = {
    status: "stopped" as AgentTabStatus,
    dotColor: BORROWED,
    dotLabel: "a task under here needs you",
    liveCount: 1,
    recentCount: 0,
    hydrated: true,
    paneSide: "left" as const,
    jointOpen: false,
  };
  const disc = () => {
    const el = document.querySelector(`[data-hint="${CONCIERGE_AGENTS_HINT}"]`) as HTMLElement;
    const d = Array.from(el.querySelectorAll("span")).find(
      (s) => (s as HTMLElement).style.borderRadius === "50%",
    );
    if (!d) throw new Error("no status disc on the Concierge Agents row");
    return d as HTMLElement;
  };

  it("draws a hollow ring in the borrowed colour when dotRing is set", () => {
    render(<ConciergeAgentsRow {...props} dotRing />);
    expect(disc().style.boxShadow).toContain(BORROWED);
    expect(disc().style.boxShadow).toContain("inset");
    expect(disc().style.background).toBe("transparent");
  });

  // The paired direction: same colour, no ring. Without it, a `variant` hardcoded to `"ring"` would
  // satisfy the row above.
  it("draws a filled disc in the same colour when dotRing is not set", () => {
    render(<ConciergeAgentsRow {...props} />);
    expect(disc().style.background).toBe(asRgb(BORROWED));
    expect(disc().style.boxShadow).toBe("");
  });
});

// ══ THE REGRESSION THE FOUNDER WAS LOOKING AT ═══════════════════════════════════════════════════
//
// He read `Concierge Agents +0` and concluded the concierge never delegates. The row was telling
// the truth — `+[n]` counts only `queued` + `running` — and the truth was unreadable: 28 dispatched
// tasks sat on disk and the most recent burst had simply finished. "Delegating, just finished" and
// "has never once delegated" rendered identically, and telling them apart was the entire complaint.
//
// The second number is what separates them. These tests are written against the DISPLAYED TEXT
// rather than the selector, because the selector was never the broken part.
describe("Concierge Agents — a recent count, so +0 is readable", () => {
  // ONE TICK OF AGE, SIZED AS A FRACTION OF THE WINDOW — not a literal hour. None of these tests is
  // about how big the window is; they are about what the second number MEANS. Written in literal
  // hours they broke as a body when the window moved 12h → 1h, which is noise that hides whether the
  // real invariants still hold. `AGO`, `2 * AGO` and `3 * AGO` are all comfortably inside the
  // window; `14 * AGO` and `40 * AGO` are outside it, which is what those call sites mean by
  // "ancient" and "a long runner". Relative ages cannot go stale on the next change either.
  const AGO = RECENT_RESEARCH_WINDOW_MS / 8;
  /** A task in a terminal state, dispatched `agoMs` ago — invisible to the live count by construction. */
  const finished = (id: string, agoMs: number): ResearchTask => ({
    ...DONE_WITH_FINDINGS,
    id,
    createdAt: Date.now() - agoMs,
  });

  it("shows +0 alongside the recent count when a burst has finished", () => {
    seedResearch([finished("rsh_r1", AGO), finished("rsh_r2", 2 * AGO), finished("rsh_r3", 3 * AGO)]);
    render(<AgentSidebar project={seed()} />);
    // Both halves. `0 active now` is still the honest live reading and is NOT suppressed…
    expect(row().textContent).toContain("0 active now");
    // …and the second number is what stops it reading as "this has never happened".
    expect(row().textContent).toContain("3 in the last hour");
  });

  // THE COUNTER-CASE. Without it, a row that appended "N recently" unconditionally would pass the
  // test above — and re-create the same unreadable display in the opposite direction.
  it("shows NOTHING but the live count when nothing has been dispatched recently", () => {
    seedResearch([finished("rsh_old", 40 * AGO)]);
    render(<AgentSidebar project={seed()} />);
    expect(row().textContent).toContain("0 active now");
    expect(row().textContent).not.toContain("in the last");
  });

  // A FAILED pass is still a delegation. Counting only successes would restate the same false zero
  // in a narrower window — and failures are common enough on this path to matter (a real burst on
  // 2026-08-12 was roughly half `failed`).
  it("counts a failed dispatch, because the question is whether it DELEGATED", () => {
    seedResearch([{ ...DONE_WITH_FINDINGS, id: "rsh_f", status: "failed", createdAt: Date.now() - AGO }]);
    render(<AgentSidebar project={seed()} />);
    expect(row().textContent).toContain("1 in the last hour");
  });

  // The live gauge keeps working alongside it — a running task must still be in BOTH numbers, or
  // the second one has quietly replaced the first rather than complementing it.
  it("still counts live work in +[n], and counts it as recent too", () => {
    seedResearch([{ ...RUNNING, id: "rsh_live", createdAt: Date.now() - 60_000 }]);
    render(<AgentSidebar project={seed()} />);
    expect(row().textContent).toContain("1 active now");
    expect(row().textContent).toContain("1 in the last hour");
  });

  // Before the first listing lands the row has no basis for EITHER number. Same rule as `+0`.
  it("shows no badge at all before the first listing lands", () => {
    seedResearch([finished("rsh_r1", AGO)], false);
    render(<AgentSidebar project={seed()} />);
    expect(row().textContent).not.toContain("in the last");
    expect(row().textContent).not.toContain("active now");
  });
});

// ══ BOTH NUMBERS SAY WHAT THEY ARE — THE FOUNDER COULD NOT INTERPRET EITHER ═════════════════════
//
// Founder, 2026-08-20, reading `Concierge Agents +2 · 63 recently`: *"the fact that it tells me they
// were 62 recently. It'd be helpful to know in what time period. I think we can do in the last hour,
// let's say. … instead of plus two, it could say something like '2 active now'"*.
//
// TWO SEPARATE AMBIGUITIES, and each needs its own assertion because a fix for one passes a test
// written for the other:
//
//   • `63 recently` never said over WHAT PERIOD. An hour, a day, since install — all read the same,
//     so the number carried no information at all.
//   • `+2` never said what the 2 WERE. Running? Queued? Finished and unread?
//
// ⚠️ EVERY TEST HERE ASSERTS THE OLD FORM IS GONE, not merely that the new one is present. A badge
// that appended the new wording while keeping the old — or that printed the period in a tooltip
// nobody hovers — satisfies a `toContain` and leaves the row exactly as unreadable as he found it.
describe("Concierge Agents — the badge names its period and its population", () => {
  const AGO = RECENT_RESEARCH_WINDOW_MS / 8;
  const finished = (id: string, agoMs: number): ResearchTask => ({
    ...DONE_WITH_FINDINGS,
    id,
    createdAt: Date.now() - agoMs,
  });

  // THE EXACT STRING, in the shape he was looking at: a live gauge and a recent count together.
  // Exact rather than `toContain` because that is what catches a segment appended beside the old
  // one, a reordering, and a separator change — none of which a containment test can see.
  it("renders the founder's row as a labelled sentence, with no bare `+N` and no bare `recently`", () => {
    seedResearch([
      { ...RUNNING, id: "rsh_a", createdAt: Date.now() - AGO },
      { ...RUNNING, id: "rsh_b", createdAt: Date.now() - AGO },
      finished("rsh_c", 2 * AGO),
    ]);
    render(<AgentSidebar project={seed()} />);

    const badge = Array.from(row().querySelectorAll("span")).find((n) =>
      n.textContent?.includes("active now"),
    )!;
    expect(badge.textContent).toBe("2 active now · 3 in the last hour");

    // THE TWO FORMS HE COMPLAINED ABOUT, asserted absent from the whole row — not just the badge —
    // so neither can survive somewhere else on the line.
    expect(row().textContent).not.toContain("+2");
    expect(row().textContent).not.toContain("recently");
  });

  // ══ THE WINDOW THE ROW STATES IS THE WINDOW THE ROW ENFORCES ══════════════════════════════════
  //
  // The failure mode of this whole change is a row that names a period it is not counting over —
  // strictly worse than the ambiguity it replaced, because a stated period is believed. The label is
  // DERIVED from `RECENT_RESEARCH_WINDOW_MS` for that reason, and this is what makes a hand-typed
  // literal fail: the phrase the row prints is compared against the constant's own words, and the
  // arithmetic is exercised at the exact boundary in the same test.
  it("states the period it counts over, and counts over the period it states", () => {
    // One task a hair INSIDE the window and one a hair OUTSIDE it. Both are dispatched, both are
    // terminal, and the only thing separating them is the bound the label claims.
    seedResearch([
      finished("rsh_in", RECENT_RESEARCH_WINDOW_MS - 60_000),
      finished("rsh_out", RECENT_RESEARCH_WINDOW_MS + 60_000),
    ]);
    render(<AgentSidebar project={seed()} />);

    // The count is bounded: two on disk, one inside the window.
    expect(row().textContent).toContain(`1 in ${RECENT_RESEARCH_WINDOW_LABEL}`);
    expect(row().textContent).not.toContain("2 in ");
    // …and the words are the constant's own, so a literal that drifts from it fails here.
    expect(row().textContent).toContain("in the last hour");
    expect(RECENT_RESEARCH_WINDOW_LABEL).toBe("the last hour");
  });

  // ══ THE BADGE GREW ~10× AND MUST NOT BE CLIPPED SILENTLY ══════════════════════════════════════
  //
  // roborev, on this change: naming the period took the badge from `+0` (~16px) to
  // `0 active now · 16 queued · 12 in the last hour` (~260px), while the Build column DEFAULTS to
  // 220px and drags to 50. Un-shrinkable, it overflowed and was cut by the list's own
  // `overflowX: "hidden"` — no ellipsis, because the clip happens on an ancestor — and what got cut
  // was the TAIL, i.e. the period label this change exists to add. Silently.
  //
  // ⚠️ WHAT THIS TEST CAN AND CANNOT DO. jsdom performs NO LAYOUT (see docs/jsdom-test-caveats.md),
  // so no assertion here can observe an actual overflow, a real ellipsis, or a measured width — and
  // a test written as though it could would be pure theatre. What IS real and worth pinning is the
  // POLICY: the badge is shrinkable at all, it degrades with an ellipsis rather than a hard cut, and
  // the title yields its width FIRST. Those are the three properties that were wrong, and each is a
  // property of the element rather than of the layout. The old `flex: "0 0 auto"` fails all three.
  it("lets the badge shrink with an ellipsis, and makes the title yield its width first", () => {
    render(
      <ConciergeAgentsRow
        status={"stopped" as AgentTabStatus}
        liveCount={0}
        recentCount={12}
        queuedCount={16}
        hydrated
        paneSide="left"
        jointOpen={false}
      />,
    );
    const badge = Array.from(row().querySelectorAll("span")).find((n) =>
      n.textContent?.includes("active now"),
    )! as HTMLElement;
    const title = Array.from(row().querySelectorAll("span")).find(
      (n) => n.textContent === CONCIERGE_AGENTS_TITLE,
    )! as HTMLElement;

    // (1) SHRINKABLE AT ALL. `flex: 0 0 auto` — the state this fixes — parses to flexShrink "0".
    expect(badge.style.flexShrink).not.toBe("0");
    // (2) AND ACTUALLY ABLE TO. A flex item's automatic minimum size is its CONTENT, so a shrink
    //     factor without `minWidth: 0` does nothing at all — the two are one mechanism, not two.
    //     ("0" rather than "0px": React writes a unitless numeric style through verbatim.)
    expect(badge.style.minWidth).toBe("0");
    // (3) DEGRADES LEGIBLY. An ellipsis tells the reader to widen the column; an ancestor's clip
    //     just looks like the row's copy ends there.
    expect(badge.style.textOverflow).toBe("ellipsis");
    expect(badge.style.overflow).toBe("hidden");

    // (4) ORDER. The title is recoverable from position; the numbers are not recoverable at all, so
    //     the title gives up its width first. Compared as numbers rather than pinned to literals —
    //     the invariant is the RELATION, and pinning 100-vs-1 would fail on a harmless retune.
    expect(Number(title.style.flexShrink)).toBeGreaterThan(Number(badge.style.flexShrink));
  });

  // "ACTIVE NOW" MUST COVER WHAT IT CLAIMS. The gauge counts `queued` + `running`, so a queued task
  // — dispatched, not yet started — is inside the number the row calls "active now". Asserted with
  // BOTH kinds mounted at once, per AGENTS.md's rule for a label that picks among populations:
  // asserting only the running side passes a gauge that silently dropped the queued one.
  it("counts a queued task as active now, alongside a running one", () => {
    seedResearch([
      { ...RUNNING, id: "rsh_run", createdAt: Date.now() - AGO },
      { ...RUNNING, id: "rsh_q", status: "queued", createdAt: Date.now() - AGO },
    ]);
    render(<AgentSidebar project={seed()} />);
    expect(row().textContent).toContain("2 active now");
    // The tooltip is where the precision that will not fit on the row lives — so the row can say
    // "active now" honestly without the reader having to guess which two states that spans.
    const badge = Array.from(row().querySelectorAll("span")).find((n) =>
      n.textContent?.includes("active now"),
    )!;
    expect(badge.getAttribute("title")).toContain("active now (running or queued)");
  });
});

// ══ THE THIRD NUMBER: A DEEP QUEUE AND AN EMPTY ONE MUST NOT LOOK ALIKE ═════════════════════════
//
// Bead `sparkle-zx9knz`. The founder had SIXTEEN messages queued to the concierge while this row
// read `+2`, and asked why ten agents were not spun up. `+[n]` is a live gauge with no denominator
// — it decays toward zero as passes finish, while the turn queue stays deep because dispatching
// research dequeues nothing — so `+0` meant BOTH "nothing to do" and "sixteen of your messages are
// unanswered and nobody is working on any of them".
//
// ⚠️ WHY EVERY TEST BELOW RENDERS BOTH SIDES. The bug is a COLLISION between two states, so an
// assertion about one of them is half the evidence: `expect(text).toContain("16 queued")` passes
// against a component that printed the queue unconditionally, which re-creates the same
// indistinguishability in the opposite direction — exactly how `· N recently` overshot the first
// time this row was fixed. Each test therefore renders the pair and asserts they DIFFER, and what
// each one says.
describe("Concierge Agents — a queue depth, so +0 is not two different facts", () => {
  const baseProps = {
    status: "stopped" as AgentTabStatus,
    liveCount: 0,
    recentCount: 12,
    hydrated: true,
    paneSide: "left" as const,
    jointOpen: false,
  };
  /** The badge span — the one span in the header row carrying the live gauge's own words. */
  const badge = () =>
    Array.from(row().querySelectorAll("span")).find((s) =>
      s.textContent?.includes("active now"),
    ) as HTMLElement;

  // ── THE COLLISION ITSELF ─────────────────────────────────────────────────────────────────────
  it("renders a deep queue differently from an empty one, and says which is which", () => {
    const { rerender } = render(<ConciergeAgentsRow {...baseProps} queuedCount={16} />);
    const deep = badge().textContent;
    rerender(<ConciergeAgentsRow {...baseProps} queuedCount={0} />);
    const empty = badge().textContent;

    // The whole complaint, in one line: these two are not the same row any more.
    expect(deep).not.toBe(empty);
    // …and each says the right thing, so "different" cannot be satisfied by noise.
    expect(deep).toContain("16 queued");
    expect(empty).not.toContain("queued");
    // Neither number the row already had is disturbed by the new one.
    expect(deep).toContain("0 active now");
    expect(empty).toContain("0 active now");
    expect(deep).toContain("12 in the last hour");
    expect(empty).toContain("12 in the last hour");
  });

  // The founder's ACTUAL reading, which was not `+0` but `+2`. A fix keyed on `liveCount === 0`
  // would pass every test above and still leave him looking at the row he complained about.
  it("distinguishes the two at a NON-zero live count too", () => {
    const { rerender } = render(<ConciergeAgentsRow {...baseProps} liveCount={2} queuedCount={16} />);
    const deep = badge().textContent;
    rerender(<ConciergeAgentsRow {...baseProps} liveCount={2} queuedCount={0} />);
    expect(deep).not.toBe(badge().textContent);
    expect(deep).toContain("2 active now");
    expect(deep).toContain("16 queued");
  });

  // ── `undefined` IS NOT `0`, AND THEY RENDER THE SAME ANYWAY ──────────────────────────────────
  //
  // ⚠️ READ THIS BEFORE "FIXING" THE ASSERTION. The two are DIFFERENT FACTS and IDENTICAL OUTPUT,
  // deliberately. `undefined` is WE DID NOT LOOK — a window with no `ConciergeHost` mounted — and
  // `stores/conciergeQueueStore` states the rule for itself: conflating it with an empty queue puts
  // the fail-open answer at the front of a display built to end a silence. `0` is a measured empty
  // queue, and it is suppressed for the reason `· 0 recently` is: it is the ordinary state of every
  // single send. So the equality below is the SPEC, not a shortcut — but the suppressions stay
  // separate in the code, because the day one of them grows a treatment the other must not get it.
  it("renders `undefined` exactly as it rendered before this prop existed", () => {
    const { rerender } = render(<ConciergeAgentsRow {...baseProps} queuedCount={undefined} />);
    const notLooked = {
      text: badge().textContent,
      title: badge().getAttribute("title"),
      aria: badge().getAttribute("aria-label"),
    };
    // The pre-change rendering, spelled out rather than compared to itself.
    expect(notLooked.text).toBe("0 active now · 12 in the last hour");
    expect(notLooked.title).toBe(
      "0 research agents active now (running or queued) · 12 dispatched in the last hour",
    );
    expect(notLooked.aria).toBe("0 active now, 12 in the last hour");

    rerender(<ConciergeAgentsRow {...baseProps} queuedCount={0} />);
    expect(badge().textContent).toBe(notLooked.text);
    expect(badge().getAttribute("title")).toBe(notLooked.title);
    expect(badge().getAttribute("aria-label")).toBe(notLooked.aria);
  });

  // ── THE COPY, IN STEP WITH THE VISIBLE TEXT ──────────────────────────────────────────────────
  //
  // The repo treats user-facing copy as code: a tooltip that still describes the old behaviour is
  // the specific failure it names. Both strings are pinned in the same pair of states as the text.
  it("tells the same story in the tooltip and the accessible description", () => {
    const { rerender } = render(<ConciergeAgentsRow {...baseProps} queuedCount={16} />);
    // Worded against `ConciergeQueueDepth.waiting`, which EXCLUDES the turn in flight — so
    // "waiting behind the concierge's current turn", never "16 messages outstanding".
    expect(badge().getAttribute("title")).toBe(
      "0 research agents active now (running or queued) · 16 messages waiting behind the concierge's current turn · 12 dispatched in the last hour",
    );
    expect(badge().getAttribute("aria-label")).toBe(
      "0 active now, 16 queued, 12 in the last hour",
    );

    rerender(<ConciergeAgentsRow {...baseProps} queuedCount={0} />);
    expect(badge().getAttribute("title")).not.toContain("waiting");
    expect(badge().getAttribute("aria-label")).not.toContain("queued");
  });

  it("says `message` when exactly one is waiting", () => {
    render(<ConciergeAgentsRow {...baseProps} queuedCount={1} />);
    expect(badge().textContent).toContain("1 queued");
    expect(badge().getAttribute("title")).toContain("1 message waiting");
    expect(badge().getAttribute("title")).not.toContain("1 messages");
  });

  // ── (D) NO FOURTH GRAMMAR FOR "ALL DISPATCHED, ALL FINISHED, STILL QUEUED" ───────────────────
  //
  // The state named in the bead — `queuedCount > 0`, `liveCount === 0`, `recentCount > 0` — is
  // reported by the same three segments as every other state, and this pins that DECISION rather
  // than an oversight. The row could word it as "waiting on the concierge", and deliberately does
  // not: that would additionally claim the queue has STOPPED MOVING, which a count cannot support
  // (a 16-deep queue draining one turn at a time is healthy and looks identical from here). The
  // store says where that evidence lives — `oldestAt`, which this row is not given.
  //
  // The exact-string form is the point: it fails if a dialect word appears, if a segment goes
  // missing, and if the order changes.
  it("reports the bead's state in three numbers and invents no fourth word for it", () => {
    render(<ConciergeAgentsRow {...baseProps} liveCount={0} recentCount={12} queuedCount={16} />);
    expect(badge().textContent).toBe("0 active now · 16 queued · 12 in the last hour");
  });

  // NOW, then WAITING, then ALREADY BEEN THROUGH. Pinned because the segments are only a sentence
  // in that order, and nothing else would catch a reordering.
  it("orders the segments live · queued · recent-window", () => {
    render(<ConciergeAgentsRow {...baseProps} liveCount={3} recentCount={7} queuedCount={5} />);
    const t = badge().textContent!;
    expect(t.indexOf("3 active now")).toBeLessThan(t.indexOf("5 queued"));
    expect(t.indexOf("5 queued")).toBeLessThan(t.indexOf("7 in the last hour"));
  });

  // The queue segment lives INSIDE the `hydrated` gate, which is a choice: one badge, one grammar,
  // rather than a bare `· 16 queued` with no gauge in front of it. The state is a sub-second
  // transient (the row hydrates on mount), so it does not earn a second layout.
  it("says nothing about the queue before the first research listing lands", () => {
    render(<ConciergeAgentsRow {...baseProps} hydrated={false} queuedCount={16} />);
    expect(row().textContent).not.toContain("queued");
    expect(row().textContent).not.toContain("active now");
  });

  // ── THE WIRING: THE SIDEBAR READS THE PUBLISHED STORE, NOT A SECOND COUNTER ──────────────────
  //
  // Asserted through `AgentSidebar` rather than the row, because the prop threading is the half a
  // component test cannot see. `ConciergeHost` is the real publisher; this seeds the store the same
  // way it does. Both directions again: an unpublished store must leave the row exactly as it was.
  it("takes the depth from the published store, and shows nothing when nobody published", () => {
    seedResearch([]);
    const owner = {};
    act(() => {
      useConciergeQueueStore.getState().publish(owner, { waiting: 16, running: true, oldestAt: 1 });
    });
    render(<AgentSidebar project={seed()} />);
    expect(row().textContent).toContain("16 queued");

    // …and the reading is not sticky: a window whose host has gone reads WE DID NOT LOOK.
    act(() => useConciergeQueueStore.getState().clearFor(owner));
    expect(row().textContent).not.toContain("queued");
    expect(row().textContent).toContain("0 active now");
  });
});

// ══ THE DEAD CLICK: THE LABEL PROMISED FIFTEEN ROWS AND THE GROUP DREW NONE ══════════════════════
//
// Founder, 2026-08-18, on `Concierge Agents +0 · 15 recently`: *"I'm trying to click on agents, but
// it's not doing anything. … But I wanna be able to see the recent ones as well as the active ones."*
//
// The click was never broken. `· N recently` counts `recentTasks`, which KEEPS retired tasks on
// purpose; the group rendered `visibleTasks`, which drops them. Replayed against his records: live 0,
// recent 15, rendered 0. So the header opened an empty group and read as a dead row.
//
// EVERY TEST BELOW IS WRITTEN SO THE OLD CODE FAILS IT. In particular the first one seeds NOTHING
// but retired tasks — a fixture containing a live task would render a non-empty group under the bug
// as well, and prove nothing at all.
describe("Concierge Agents — the recent ones as well as the active ones", () => {
  /** A fraction of the recent window — see the note on `AGO` in the recent-count block above. */
  const AGO = RECENT_RESEARCH_WINDOW_MS / 8;
  /** A RETIRED task: terminal AND claimed (`readAt` stamped), dispatched `agoMs` ago. */
  const retired = (id: string, agoMs: number, status: ResearchTask["status"] = "done"): ResearchTask => ({
    ...DONE_WITH_FINDINGS,
    id,
    status,
    question: `Retired ${id}`,
    createdAt: Date.now() - agoMs,
    readAt: Date.now() - agoMs + 1_000,
  });
  /** A LIVE task, dispatched `agoMs` ago. Never retired — `readAt` is meaningless while running. */
  const live = (id: string, agoMs: number): ResearchTask => ({
    ...RUNNING,
    id,
    question: `Live ${id}`,
    createdAt: Date.now() - agoMs,
    readAt: null,
  });
  /**
   * THE THIRD POPULATION, and the whole reason it has a fixture: TERMINAL but UNCLAIMED.
   *
   * `readAt: null` on a stopped task — the run is over, but the concierge has not been told, so its
   * findings are still owed to the prompt preamble. `isRetired` says LIVE here and `isTerminal` says
   * RETIRED, which is the ONLY input on which the two disagree. Without it in the tree every fixture
   * is one the two predicates answer identically, and `livenessOfResearch` could be rewritten to the
   * wrong one with the whole suite green.
   */
  const unclaimed = (id: string, agoMs: number, status: ResearchTask["status"] = "done"): ResearchTask => ({
    ...DONE_WITH_FINDINGS,
    id,
    status,
    question: `Unclaimed ${id}`,
    createdAt: Date.now() - agoMs,
    readAt: null,
  });

  /** The one status disc inside a row — the only span the component gives a 50% radius. */
  const discIn = (r: HTMLElement) =>
    Array.from(r.querySelectorAll("span")).find(
      (s) => (s as HTMLElement).style.borderRadius === "50%",
    ) as HTMLElement;
  /** A row's TITLE span, found by its exact text so the elapsed timer beside it cannot be mistaken
   *  for it. */
  const titleIn = (r: HTMLElement, text: string) =>
    Array.from(r.querySelectorAll("span")).find((s) => s.textContent === text) as HTMLElement;
  const rowFor = (id: string) => childRows().find((r) => r.getAttribute("data-task-id") === id)!;

  // ── THE BUG ITSELF ───────────────────────────────────────────────────────────────────────────
  it("opens onto a NON-empty group when every task in the window is retired", () => {
    seedResearch([retired("r1", AGO), retired("r2", 2 * AGO, "failed"), retired("r3", 3 * AGO, "cancelled")]);
    render(<AgentSidebar project={seed()} />);

    // The header the founder was reading: nothing live, three dispatched recently.
    expect(row().textContent).toContain("0 active now");
    expect(row().textContent).toContain("3 in the last hour");
    expect(childRows()).toHaveLength(0);

    fireEvent.click(row());

    // The fix: what the label counted is what the click shows. Under the old `visibleTasks` group
    // this is 0 — the group did not even render, because it was gated on `tasks.length > 0`.
    expect(row().getAttribute("aria-expanded")).toBe("true");
    expect(childRows()).toHaveLength(3);
    expect(screen.getAllByText("Retired r1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Retired r2").length).toBeGreaterThan(0);
  });

  // THE INVARIANT, asserted on the two rendered numbers rather than on the selector: whatever
  // `· N recently` says, that many rows (at least) are behind the click. Stated over a MIXED store
  // so it cannot be satisfied by a group that renders everything the store has ever held.
  it("shows at least as many rows as the badge promises", () => {
    seedResearch([live("l1", 60_000), retired("r1", AGO), retired("r2", 2 * AGO)]);
    render(<AgentSidebar project={seed()} />);
    expect(row().textContent).toContain("3 in the last hour");
    fireEvent.click(row());
    expect(childRows().length).toBeGreaterThanOrEqual(3);
  });

  // ── THE TREATMENT: BOTH CANDIDATES MOUNTED AT ONCE ───────────────────────────────────────────
  //
  // AGENTS.md's rule for a change that picks one of N treatments — "render the state where all N
  // targets exist, then assert the chosen one is PAINTED and each other one is NOT". Asserting only
  // the retired side passes a `dotVariantFor` that ignores its argument and rings EVERY row, which
  // is the regression that would make the live rows unreadable.
  it("draws the retired row hollow-and-muted and the live row filled-and-cream, side by side", () => {
    seedResearch([live("l1", 60_000), retired("r1", AGO)]);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());

    const liveRow = rowFor("l1");
    const retiredRow = rowFor("r1");
    expect(liveRow).toBeTruthy();
    expect(retiredRow).toBeTruthy();

    // FILL vs HOLLOW. The live disc paints its status colour as a background and casts no ring;
    // the retired one is transparent with an INSET ring in the colour its own status resolves to.
    expect(discIn(liveRow).style.background).toBe(asRgb(AGENT_STATUS.working.color));
    expect(discIn(liveRow).style.boxShadow).toBe("");
    expect(discIn(retiredRow).style.background).toBe("transparent");
    expect(discIn(retiredRow).style.boxShadow).toContain("inset");

    // HUE IS UNTOUCHED — the retired ring is the row's OWN status ink, not a new grey. This is the
    // half that keeps a run which DIED distinguishable from one that ANSWERED.
    expect(discIn(retiredRow).style.boxShadow).toContain(AGENT_STATUS.done.color);

    // …and the titles, the other channel of the treatment.
    expect(titleIn(liveRow, "Live l1").style.color).toBe("var(--c-cream)");
    expect(titleIn(retiredRow, "Retired r1").style.color).toBe("var(--c-muted)");
    expect(titleIn(liveRow, "Live l1").style.color).not.toBe(
      titleIn(retiredRow, "Retired r1").style.color,
    );
  });

  // A FAILED retired run must not flatten into the same ink as a DONE one — the second reason the
  // treatment travels on FILL rather than on hue. Both mounted, both hollow, different colours.
  it("keeps the outcome readable across two retired rows", () => {
    seedResearch([retired("ok", AGO, "done"), retired("bad", 2 * AGO, "failed")]);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    const ok = discIn(rowFor("ok"));
    const bad = discIn(rowFor("bad"));
    expect(ok.style.background).toBe("transparent");
    expect(bad.style.background).toBe("transparent");
    expect(ok.style.boxShadow).not.toBe(bad.style.boxShadow);
    expect(bad.style.boxShadow).toContain(AGENT_STATUS.errored.color);
  });

  // ── THE BOUND IS REAL ────────────────────────────────────────────────────────────────────────
  //
  // The window is the label's 12h window and nothing else. The PAIRED positive is what stops this
  // passing against a group that renders no retired rows at all.
  it("does not render a retired task from outside the 12h window", () => {
    seedResearch([retired("recent", AGO), retired("ancient", 40 * AGO)]);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    expect(childRows().map((r) => r.getAttribute("data-task-id"))).toEqual(["recent"]);
    expect(screen.queryByText("Retired ancient")).toBeNull();
  });

  // The other half of the union: a long `deep` run older than the window is still LIVE work, and
  // tearing its row out mid-run would be a worse bug than the one being fixed.
  it("still renders a LIVE task older than the window", () => {
    seedResearch([live("long", 14 * AGO)]);
    render(<AgentSidebar project={seed()} />);
    // Outside the dispatch window, so the badge does not count it…
    expect(row().textContent).not.toContain("in the last");
    fireEvent.click(row());
    // …and it is on screen anyway, because it has not finished.
    expect(childRows().map((r) => r.getAttribute("data-task-id"))).toEqual(["long"]);
  });

  // ── RULE 2: A RETIRED ROW FEEDS NO ROLLUP ────────────────────────────────────────────────────
  //
  // A REGRESSION GUARD, and named as one: it passed before this change too, because retired tasks
  // were not rendered at all. It has grip on what comes NEXT — a retired `failed` task reaching
  // `researchRollupStatuses` paints the header red forever for work nobody can act on, which is the
  // "red that can never be cleared" the row's own header argues against. Asserted by holding the
  // live population FIXED and adding retired tasks around it: the badge and the disc must not move.
  it("leaves +N and the header disc untouched when retired tasks appear", () => {
    seedResearch([live("l1", 60_000)]);
    const { rerender } = render(<AgentSidebar project={seed()} />);
    const headerDisc = () => row().querySelector<HTMLElement>("span[title]")!;
    const badgeBefore = row().textContent;
    const discBefore = headerDisc().style.background;
    const labelBefore = headerDisc().getAttribute("title");
    expect(badgeBefore).toContain("1 active now");

    act(() =>
      seedResearch([
        live("l1", 60_000),
        retired("r1", AGO, "failed"),
        retired("r2", 2 * AGO, "cancelled"),
        retired("r3", 3 * AGO, "done"),
      ]),
    );
    rerender(<AgentSidebar project={seed()} />);

    // Four rows behind the click…
    fireEvent.click(row());
    expect(childRows()).toHaveLength(4);
    // …and the header still reports one live agent, in the same ink, with the same tooltip. A
    // retired `failed` task feeding the rollup would turn this disc red.
    expect(row().textContent).toContain("1 active now");
    expect(row().textContent).not.toContain("4 active now");
    expect(headerDisc().style.background).toBe(discBefore);
    expect(headerDisc().getAttribute("title")).toBe(labelBefore);
  });

  // …AND THE SAME RULE AT THE FUNCTION, because the test above cannot reach it. `AgentSidebar`
  // hands `researchRollupStatuses` an already-live-filtered list (`liveTasks`), so the filter INSIDE
  // that function is unreachable from a render and deleting it leaves the rendered assertion green —
  // measured, as a surviving mutant. This one drives the function directly with the very population
  // the expanded group now renders: a live task and a RETIRED FAILED one, together.
  it("keeps a retired FAILED task out of the rollup even when handed one", () => {
    const tasks = [live("l1", 60_000), retired("bad", AGO, "failed")];
    // Both are rows the founder can see…
    expect(groupTasks(tasks, Date.now()).map((t) => t.id).sort()).toEqual(["bad", "l1"]);
    // …and only the live one reaches the disc. `errored` here is the red that can never be cleared:
    // nobody can act on a research run that already finished and was already reported.
    expect(researchRollupStatuses(tasks)).toEqual(["working"]);
    expect(researchRollupStatuses(tasks)).not.toContain("errored");
  });

  // ── RULE 4: A RETIRED ROW LEADS SOMEWHERE ────────────────────────────────────────────────────
  //
  // The whole request is to READ a finished run — its question and its findings. A retired row that
  // is inert text is a failed fix, so the routing is asserted on the retired row specifically.
  it("routes a click on a RETIRED row into the main pane", () => {
    seedResearch([live("l1", 60_000), retired("r1", AGO)]);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    expect(useResearchStore.getState().openTaskId).toBeNull();
    expect(useUiStore.getState().activeSpecial).toBeNull();

    const target = rowFor("r1");
    fireEvent.click(target);

    expect(useResearchStore.getState().openTaskId).toBe("r1");
    expect(useUiStore.getState().activeSpecial).toBe("research");
    expect(target.getAttribute("aria-pressed")).toBe("true");
  });

  // The chat-link reveal's membership guard reads the SAME widened list, so a pill naming a task
  // that has since been claimed now opens onto its row instead of silently doing nothing. The
  // guard is still a guard — the stale-id test above proves an unknown id opens nothing.
  it("expands the group for a pill naming a retired task", () => {
    seedResearch([retired("r1", AGO)]);
    render(<AgentSidebar project={seed()} />);
    expect(row().getAttribute("aria-expanded")).toBe("false");

    act(() => openResearchTaskInPane("r1"));

    expect(row().getAttribute("aria-expanded")).toBe("true");
    expect(rowFor("r1").getAttribute("aria-pressed")).toBe("true");
  });

  // ══ BOTH HALVES OF THE ROLLUP CONJUNCTION, NOT JUST THE ONE THAT HAPPENS TO FIRE ═════════════
  //
  // `researchRollupStatuses` filters on `isLive(t) && countsTowardRollup(livenessOfResearch(t))`.
  // Once a terminal-but-unclaimed task maps to "live" — which the tests below now pin — the SECOND
  // half returns true for it, so only `isLive` keeps it out of the header disc. Every other rollup
  // test seeds a running task or a retired one, i.e. inputs on which the two halves agree, so
  // deleting `isLive` left all 44 tests green while letting an unclaimed FAILED run paint the
  // collapsed header red — the "red nobody can clear until the concierge is told" outcome that
  // function's own header argues against. Verified by mutation; raised as a Medium by roborev 65382.
  //
  // Stated as the DIFFERENCE between the two facts, because that is the whole content of the bug:
  // the row treats this task as live, and the rollup must still not count it.
  it("keeps a terminal-but-unclaimed task out of the rollup, though the row treats it as live", () => {
    const owedFailed = unclaimed("u_failed", AGO, "failed");
    const owedDone = unclaimed("u_done", AGO, "done");

    // The row-treatment half: these are LIVE, so they draw filled and cream.
    expect(livenessOfResearch(owedFailed)).toBe("live");
    expect(livenessOfResearch(owedDone)).toBe("live");

    // …and the rollup half: they are nevertheless absent from it, which is the half `isLive` alone
    // is holding up. A `failed` one is the case that matters — it is the only status that could
    // turn the header red.
    expect(researchRollupStatuses([owedFailed])).toEqual([]);
    expect(researchRollupStatuses([owedDone])).toEqual([]);
    expect(researchRollupStatuses([owedFailed])).not.toContain("errored");

    // The control: a genuinely live task in the same call IS counted, so the assertions above are
    // about this population rather than about a filter that rejects everything.
    expect(researchRollupStatuses([live("l1", 60_000), owedFailed])).toEqual(["working"]);
  });

  // ══ FINISHED IS NOT THE SAME AS HEARD — THE ONE INPUT THE TWO PREDICATES DISAGREE ON ══════════
  //
  // `livenessOfResearch` maps `isRetired` (terminal AND claimed) and DELIBERATELY not `isTerminal`.
  // Everything above seeds either a running task or a terminal-and-claimed one, and on both of those
  // the two predicates return the SAME answer — so rewriting the body to `isTerminal` left all 83
  // tests green while dimming the one row that still has findings to deliver. Verified by mutation,
  // and raised as a Medium finding on this commit by two independent reviews.
  //
  // The direct unit test is the cheap half and kills that mutant outright; the render test below is
  // the half that proves the treatment actually reaches the DOM for this population.
  it("calls a terminal-but-unclaimed task LIVE, and only a claimed one retired", () => {
    // EVERY terminal status on BOTH sides of the claim, not just one — `cancelled` is a state the
    // founder put the run in and it retires exactly like the other two, so a mapping that special-
    // cased any single status would still have to answer all six of these.
    expect(livenessOfResearch(live("l", 60_000))).toBe("live");
    expect(livenessOfResearch(unclaimed("u_done", AGO, "done"))).toBe("live");
    expect(livenessOfResearch(unclaimed("u_failed", AGO, "failed"))).toBe("live");
    expect(livenessOfResearch(unclaimed("u_cancelled", AGO, "cancelled"))).toBe("live");
    expect(livenessOfResearch(retired("r", AGO, "done"))).toBe("retired");
    expect(livenessOfResearch(retired("rf", AGO, "failed"))).toBe("retired");
    // THE SIXTH, and the one that was missing while the comment above claimed six. `readAt` is
    // stamped for EVERY terminal status and `cancelled` is terminal, so claimed-and-cancelled is a
    // real production shape. Without it, a mapping reading `isRetired(task) && status !== "cancelled"`
    // passes the whole suite and leaves a run the founder himself cancelled drawn as work in flight.
    expect(livenessOfResearch(retired("rc", AGO, "cancelled"))).toBe("retired");

    // THE DISCRIMINATOR, stated as a difference rather than as two absolutes: a `done` task is
    // terminal either way, so what separates the two rows is ONLY whether it has been claimed.
    expect(livenessOfResearch(unclaimed("u2", AGO, "done"))).not.toBe(
      livenessOfResearch(retired("r2", AGO, "done")),
    );
  });

  // ALL THREE CANDIDATES MOUNTED AT ONCE — AGENTS.md's rule, applied to the population the earlier
  // side-by-side test was missing. A `done`-with-findings-owed row must render exactly like a live
  // one: filled disc, cream title. If it dims, the founder loses the visual cue on the single row
  // that still owes him something.
  it("draws a terminal-but-unclaimed row filled-and-cream, beside a live one and a retired one", () => {
    seedResearch([live("l1", 60_000), unclaimed("u1", AGO), retired("r1", 2 * AGO)]);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());

    const liveRow = rowFor("l1");
    const unclaimedRow = rowFor("u1");
    const retiredRow = rowFor("r1");
    expect(liveRow).toBeTruthy();
    expect(unclaimedRow).toBeTruthy();
    expect(retiredRow).toBeTruthy();

    // The unclaimed row is FILLED, like the live one — not hollow like the retired one.
    expect(discIn(unclaimedRow).style.background).toBe(asRgb(AGENT_STATUS.done.color));
    expect(discIn(unclaimedRow).style.boxShadow).toBe("");
    expect(titleIn(unclaimedRow, "Unclaimed u1").style.color).toBe("var(--c-cream)");
    // Stated against the LIVE row as well as against the literal token: what this row must match is
    // whatever a row still in flight looks like, so a change to the live ink drags this with it
    // instead of leaving a hardcoded token behind that quietly stops meaning "same as live".
    expect(titleIn(unclaimedRow, "Unclaimed u1").style.color).toBe(
      titleIn(liveRow, "Live l1").style.color,
    );

    // …and the retired one, seeded with the SAME `done` status, is drawn the other way. Same status,
    // different treatment: the difference is claimed-ness alone, which is the point.
    expect(discIn(retiredRow).style.background).toBe("transparent");
    expect(discIn(retiredRow).style.boxShadow).toContain("inset");
    expect(titleIn(retiredRow, "Retired r1").style.color).toBe("var(--c-muted)");

    // Stated as a difference so a treatment that ignored liveness entirely cannot satisfy it.
    expect(discIn(unclaimedRow).style.boxShadow).not.toBe(discIn(retiredRow).style.boxShadow);
    expect(titleIn(unclaimedRow, "Unclaimed u1").style.color).not.toBe(
      titleIn(retiredRow, "Retired r1").style.color,
    );
  });
});

// ══ THE WIDTH LADDER, AT THE RENDER SITE ═══════════════════════════════════════════════════════
//
// `rowWidthThresholds.concierge.test.ts` pins the DECISION functions. This pins that the component
// actually CALLS them — a separate fact, and the one that was untested.
//
// It is the defaulted-seam shape AGENTS.md warns about: `columnWidth ?? 0` resolves to the `full`
// tier, and every other test in this file renders without the prop. So deleting
// `columnWidth={columnWidth}` at the `AgentSidebar` call site, or reverting the render back to
// literals, left the whole jsdom suite AND the thresholds suite green — only the manual, non-CI
// probe would have caught it. Choosing which STRING to render needs no layout engine, so this gap
// was never a jsdom limitation; it was a missing test.
describe("Concierge Agents — the badge's phrasing follows the column width", () => {
  const props = {
    status: "stopped" as AgentTabStatus,
    liveCount: 2,
    recentCount: 63,
    hydrated: true,
    paneSide: "left" as const,
    jointOpen: false,
  };
  const badge = () =>
    Array.from(row().querySelectorAll("span")).find((s) =>
      (s.getAttribute("aria-label") ?? "").includes("active now"),
    ) as HTMLElement;

  it("spells the window out at a wide column", () => {
    render(<ConciergeAgentsRow {...props} columnWidth={420} />);
    expect(badge().textContent).toBe(`2 active now · 63 in ${RECENT_RESEARCH_WINDOW_LABEL}`);
  });

  it("abbreviates the window at the width the app boots at", () => {
    render(<ConciergeAgentsRow {...props} columnWidth={220} />);
    // The unit survives; the words around it shrink.
    expect(badge().textContent).toBe(`2 active · 63 ${RECENT_RESEARCH_WINDOW_SHORT_LABEL}`);
    expect(badge().textContent).toContain(RECENT_RESEARCH_WINDOW_SHORT_LABEL);
  });

  it("drops the live gauge's word, never the window, at the narrowest columns", () => {
    render(<ConciergeAgentsRow {...props} columnWidth={160} />);
    expect(badge().textContent).toBe(`2 · 63 ${RECENT_RESEARCH_WINDOW_SHORT_LABEL}`);
  });

  // AN UNMEASURED WIDTH TAKES THE FULL FORM — the fail-open direction, matching `stageChipShows`.
  // Rendering without the prop at all must be identical to rendering it wide.
  it("renders the full form when the width has not been measured", () => {
    const { unmount } = render(<ConciergeAgentsRow {...props} />);
    const unmeasured = badge().textContent;
    unmount();
    render(<ConciergeAgentsRow {...props} columnWidth={420} />);
    expect(unmeasured).toBe(badge().textContent);
  });

  // ── THE QUEUE SEGMENT IS ON THE LADDER TOO ─────────────────────────────────────────────────
  //
  // It used to be the one segment that never shortened, so it pushed the windowed count off the
  // end of a badge that is a single nowrap span. The row's own header quotes this state as
  // ordinary. Both halves are asserted: the word abbreviates, AND the tier steps down so the
  // three-segment string still fits the budget the ladder documents.
  // A QUEUE COSTS WIDTH, NOT A RUNG. On a WIDE column the queue simply fits and the spelled-out
  // window survives — an earlier version shifted the ladder down unconditionally, which dropped the
  // full phrase on a 1000px column with hundreds of pixels to spare.
  it("keeps the full phrasing when a wide column can afford the queue too", () => {
    render(<ConciergeAgentsRow {...props} columnWidth={420} queuedCount={16} />);
    const t = badge().textContent!;
    expect(t).toContain("16 queued");
    expect(t).toContain(`in ${RECENT_RESEARCH_WINDOW_LABEL}`);
  });

  // …and where the column CANNOT afford it, the badge steps down and the unit still survives —
  // which is the whole reason the queue segment was put on the ladder.
  it("steps down, keeping the window, when the column cannot afford the queue", () => {
    const { unmount } = render(<ConciergeAgentsRow {...props} columnWidth={330} />);
    expect(badge().textContent).toContain(`in ${RECENT_RESEARCH_WINDOW_LABEL}`);
    unmount();
    render(<ConciergeAgentsRow {...props} columnWidth={330} queuedCount={16} />);
    const withQueue = badge().textContent!;
    expect(withQueue).toContain("16");
    expect(withQueue).not.toContain(`in ${RECENT_RESEARCH_WINDOW_LABEL}`);
    expect(withQueue).toContain(RECENT_RESEARCH_WINDOW_SHORT_LABEL);
  });

  it("abbreviates the queue's word at a narrow column, keeping its number", () => {
    render(<ConciergeAgentsRow {...props} columnWidth={220} queuedCount={16} />);
    const t = badge().textContent!;
    expect(t).toContain("16 q");
    expect(t).not.toContain("16 queued");
    // …and the unit is STILL there, which is the point of stepping the tier down.
    expect(t).toContain(RECENT_RESEARCH_WINDOW_SHORT_LABEL);
  });

  // THE ARIA LABEL IS NOT ON THE LADDER. A screen reader has no column to run out of, and `63 last
  // hr` read aloud is worse than the sentence it abbreviates. Asserted at the NARROWEST width, the
  // only place where a tier leaking into the copy would show.
  it("speaks the full sentence at every width", () => {
    for (const w of [420, 220, 160]) {
      const { unmount } = render(<ConciergeAgentsRow {...props} columnWidth={w} />);
      expect(badge().getAttribute("aria-label")).toBe(
        `2 active now, 63 in ${RECENT_RESEARCH_WINDOW_LABEL}`,
      );
      unmount();
    }
  });

  // The title's floor is released below the cutoff so the numbers take the row. Asserted on the
  // STYLE rather than on a measured width, which jsdom cannot give.
  it("releases the title's floor only below the cutoff", () => {
    const title = () =>
      Array.from(row().querySelectorAll("span")).find(
        (s) => (s.textContent ?? "").trim() === CONCIERGE_AGENTS_TITLE,
      ) as HTMLElement;
    const { unmount } = render(<ConciergeAgentsRow {...props} columnWidth={220} />);
    expect(title().style.minWidth).toBe(`${CONCIERGE_TITLE_FLOOR_PX}px`);
    unmount();
    render(<ConciergeAgentsRow {...props} columnWidth={160} />);
    // jsdom serializes a zero length as bare "0", not "0px" — assert the RELEASE, not the spelling.
    expect(["0", "0px"]).toContain(title().style.minWidth);
  });
});
