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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { AgentSidebar } from "./AgentSidebar";
import { CONCIERGE_AGENTS_HINT, CONCIERGE_AGENTS_TITLE } from "./ConciergeAgentsRow";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useInteractionStore } from "../stores/interactionStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import {
  _resetResearchStoreForTests,
  RESEARCH_POLL_INTERVAL_MS,
  useResearchStore,
} from "../services/research/store";
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
  it("renders +0 and no children when there are no tasks", () => {
    seedResearch([]);
    render(<AgentSidebar project={seed()} />);
    expect(row().textContent).toContain("+0");
    expect(childRows()).toHaveLength(0);
  });

  // "+0" is a claim ("nothing is running"); before the first listing lands the row has no basis for
  // it. `hydrated` is the difference, and without this test the badge could be hardcoded on.
  it("shows no badge at all before the first listing lands", () => {
    seedResearch([], false);
    render(<AgentSidebar project={seed()} />);
    expect(row().textContent).toContain(CONCIERGE_AGENTS_TITLE);
    expect(row().textContent).not.toContain("+");
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
    expect(row().textContent).toContain(`+${LIVE_IN_FIXTURE}`);
    // …and it is genuinely a subset: the total would read differently.
    expect(row().textContent).not.toContain(`+${TASKS_IN_FIXTURE}`);
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
    expect(row().textContent).toContain("+0");
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
    expect(childRows()).toHaveLength(TASKS_IN_FIXTURE);
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

  it("opens a detail with the question and the full findings", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    expect(screen.queryByTestId("concierge-agent-detail")).toBeNull();

    const target = childRows().find(
      (r) => r.getAttribute("data-task-id") === DONE_WITH_FINDINGS.id,
    )!;
    fireEvent.click(target);

    const detail = screen.getByTestId("concierge-agent-detail");
    expect(detail.textContent).toContain(DONE_WITH_FINDINGS.question);
    // IN FULL, not clipped — types.ts records the same rule on the write side.
    expect(screen.getByTestId("concierge-agent-findings").textContent).toBe(
      DONE_WITH_FINDINGS.findings,
    );
    // Status and elapsed: 1754700120000 − 1754700004000 = 116_000ms, which formatElapsed spells
    // "1.9m". Asserted as a value rather than as "some digits" so a broken span reads red.
    expect(detail.textContent).toContain("Done");
    expect(detail.textContent).toContain("1.9m");
  });

  it("shows a failed task's error in its detail", () => {
    const failed = FIXTURE.find((t) => t.status === "failed")!;
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    fireEvent.click(childRows().find((r) => r.getAttribute("data-task-id") === failed.id)!);
    expect(screen.getByTestId("concierge-agent-error").textContent).toBe(failed.error);
  });

  it("closes the detail when the open agent is clicked again", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    const target = childRows().find(
      (r) => r.getAttribute("data-task-id") === DONE_WITH_FINDINGS.id,
    )!;
    fireEvent.click(target);
    fireEvent.click(target);
    expect(screen.queryByTestId("concierge-agent-detail")).toBeNull();
  });
});

// ── 4. THE KILL ────────────────────────────────────────────────────────────────────────────────
//
// The founder chose NO CAP on concurrent research, so "visible and killable" is the entire guardrail
// and this is the killable half. A detail that offered no way to stop a running task would leave the
// row as a viewer rather than a control.
describe("Concierge Agents — cancel", () => {
  it("cancels a running task and reflects the new state", async () => {
    const cancelled: ResearchTask = { ...RUNNING, status: "cancelled", finishedAt: 1754700099000 };
    backend.cancel.mockResolvedValue(cancelled);
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    fireEvent.click(childRows().find((r) => r.getAttribute("data-task-id") === RUNNING.id)!);

    fireEvent.click(screen.getByText("Cancel"));
    expect(backend.cancel).toHaveBeenCalledWith(RUNNING.id);
    // THE SIDE EFFECT, not the call: the returned task lands in the store, so the row's own count
    // drops and the detail stops offering a kill.
    await waitFor(() => expect(screen.queryByText("Cancel")).toBeNull());
    expect(row().textContent).toContain(`+${LIVE_IN_FIXTURE - 1}`);
  });

  it("offers no Cancel on a task that has already finished", () => {
    seedResearch(FIXTURE);
    render(<AgentSidebar project={seed()} />);
    fireEvent.click(row());
    fireEvent.click(
      childRows().find((r) => r.getAttribute("data-task-id") === DONE_WITH_FINDINGS.id)!,
    );
    expect(screen.queryByText("Cancel")).toBeNull();
  });
});

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
    expect(row().textContent).toContain(`+${LIVE_IN_FIXTURE + 1}`);
  });
});
