// @vitest-environment jsdom
//
// THE EPICS COLUMN'S OPEN EPIC CARD: TASK CARDS, WITH THEIR BUILD AGENTS INSIDE THEM.
//
// ══ THE FOUNDER'S RE-ASK, 2026-08-25 (bead sparkle-huw924.10) ═════════════════════════════════
// *"I had already previously asked that the build agents not show outside of the tasks — that the
// epic will surface the tasks. And I want the tasks to look more like they do in the Plan board
// cards."* And on WHY the old card failed: it drew `Tasks:` and `Build agents:` as two unrelated
// rows, *"so nothing tells you WHICH agent is on WHICH task — which is the entire question the card
// should answer."*
//
// This file used to assert those two rows. It now asserts what replaced them — and asserts their
// ABSENCE in the same breath, because a removal that nothing pins comes back.
//
// ══ WHAT THIS FILE IS FOR ═════════════════════════════════════════════════════════════════════
// `services/planView.agentsByTask.test.ts` proves the PARTITION is right; `BoardView.test.tsx`
// proves the task card itself expands, defers and opens. Neither can prove THIS card mounts them,
// or that its callbacks reach anything — the defect class here is a correct component rendered from
// a wrong argument, or a chip wired to a no-op. So every assertion below is on the SIDE EFFECT: the
// thing that got painted, or the store write a click produced. "A prop was passed" would stay green
// with the whole navigation deleted.
//
// ══ jsdom NEVER LAYS OUT ══════════════════════════════════════════════════════════════════════
// Every pill's `offsetWidth` reads 0, so `usePacking` FAILS OPEN and renders every pill it is given.
// That is what makes "there is no Tasks row" a real assertion here rather than an artefact of
// truncation, and it is why nothing in this file may assert a "+N more" count.
//
// ══ FAKE TIMERS ARE NOT A CONVENIENCE ═════════════════════════════════════════════════════════
// A task card DEFERS its single-click expand by `DOUBLE_CLICK_GRACE_MS` so the first click of a
// double click cannot toggle on the way past. Without advancing the clock a single click does
// nothing at all — which is exactly the property the double-click cases need to observe.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

const { EpicInlineCard } = await import("./EpicInlineCard");
const { DOUBLE_CLICK_GRACE_MS, UNASSIGNED_AGENTS_LABEL } = await import("./EpicTaskCard");
const { useProjectStore } = await import("../stores/projectStore");
const { useRuntimeStore } = await import("../stores/runtimeStore");
const { focusedBeadIdForSide, useUiStore } = await import("../stores/uiStore");
type Bead = import("../services/beads").Bead;
type AgentTab = import("../types").AgentTab;

const PROJECT = "p1";
const RIGHT_PROJECT = "p2";
const EPIC_ID = "sparkle-lineage";
const KID_A = `${EPIC_ID}.1`;
const KID_B = `${EPIC_ID}.2`;
const STRANGER_KID = "sparkle-elsewhere.1";

function beadOf(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, description: "", status: "open", labels: [], ...over } as Bead;
}

const EPIC = beadOf(EPIC_ID, { type: "epic", title: "Lineage epic" });
const KID1 = beadOf(KID_A, { title: "Wire the rows" });
const KID2 = beadOf(KID_B, { title: "Ship the rows" });
const STRANGER_EPIC = beadOf("sparkle-elsewhere", { type: "epic", title: "Someone else" });
const STRANGER = beadOf(STRANGER_KID, { parent: "sparkle-elsewhere", title: "Not my task" });
// ONE array identity, module-level: `epicIndexOf` is WeakMap-cached on exactly this, which is the
// property the card's own comment says must not be defeated by copying it at the call site.
const BEADS: readonly Bead[] = [EPIC, KID1, KID2, STRANGER_EPIC, STRANGER];

/** A LONE bead — no children, no workers — for the "renders nothing at all" case. */
const LONER = beadOf("sparkle-loner", { title: "All by itself" });
const LONER_BEADS: readonly Bead[] = [LONER];

/**
 * THE ROSTER THE CARD IS OPENED AGAINST — the shape a real epic has.
 *
 * One orchestrator bound to NO bead (which is the normal shape: `spawn_build_agent` takes no epic
 * parameter), two workers under it on two DIFFERENT children, and one worker inside somebody else's
 * epic. That last one is what makes every "and not X" assertion below a statement about the filter
 * rather than about a card that renders nothing under any circumstances.
 */
const ROSTER: Partial<AgentTab>[] = [
  { id: "ag-head", name: "Epic Id At Spawn", kind: "build" },
  { id: "ag-a", name: "rows-worker", kind: "worker", beadId: KID_A, parentId: "ag-head" },
  { id: "ag-b", name: "ship-worker", kind: "worker", beadId: KID_B, parentId: "ag-head" },
  { id: "ag-theirs", name: "stranger-worker", kind: "worker", beadId: STRANGER_KID },
];

function projectRecord(id: string, agents: Partial<AgentTab>[]) {
  return {
    id,
    name: id === PROJECT ? "repo" : "other-repo",
    rootPath: id === PROJECT ? "/repo" : "/other-repo",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents,
  };
}

function seed(agents: Partial<AgentTab>[]) {
  useProjectStore.setState({
    projects: [projectRecord(PROJECT, agents)],
    selectedProjectId: PROJECT,
  } as never);
}

/**
 * THE TWO-PAIR SEED: this card's project on the LEFT, a different project selected on the RIGHT.
 *
 * `projectStore.selectProject` writes `selectedProjectId`, which is the RIGHT pair's selection, so
 * a card that "selects its project" with it writes a LEFT id into the RIGHT pair's slot — where
 * `Workspace`'s reconcile effect discards it and the right pair falls back to its own first project
 * (engine/pairs.resolveSideSelection). That is invisible in a one-project fixture and invisible for
 * a right-assigned project; it takes both a left assignment AND a distinct right selection to
 * observe, which is why this seed exists alongside the one above.
 */
function seedTwoPairs(agents: Partial<AgentTab>[] = []) {
  useProjectStore.setState({
    projects: [projectRecord(PROJECT, agents), projectRecord(RIGHT_PROJECT, [])],
    selectedProjectId: RIGHT_PROJECT,
  } as never);
  useUiStore.setState({
    pairAssignment: { [PROJECT]: "left" },
    leftProjectId: null,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  useRuntimeStore.setState({ openAgentIds: [] } as never);
  // A BASELINE, NOT AN ANSWER. Every navigation test below seeds the state it is about to assert on
  // to the OPPOSITE value, immediately before the click — because seeding a test's own expected
  // value is the vacuous assertion this file's header swears off: `workModeBySide` seeded "build"
  // and then asserted "build" cannot fail even with the whole navigation deleted (roborev 68041).
  // What is left here is only the cross-test hygiene: the pair map and the left selection are
  // module-singleton state, and a left assignment leaking out of the two-pair test would send the
  // right-pair tests' board writes to the wrong side.
  useUiStore.setState({
    workModeBySide: { left: "build", right: "build" },
    activeSpecial: null,
    boardFocusBeadId: null,
    pairAssignment: {},
    leftProjectId: null,
    // THE TWO FOCUS RUNGS, AND THEY MATTER MORE THAN THE KEYS ABOVE, because `setBeadFocus`
    // TOGGLES: a value left behind by an earlier case (or by a vitest RETRY of this one) makes the
    // next gesture CLEAR the focus instead of setting it, so the suite alternates pass/fail on the
    // same code.
    epicFocusBySide: { left: null, right: null },
    beadFocusBySide: { left: null, right: null },
  } as never);
});
afterEach(cleanup);

function mount(bead: Bead = EPIC, allBeads: readonly Bead[] = BEADS) {
  return render(
    <EpicInlineCard bead={bead} projectId={PROJECT} rootPath="/repo" allBeads={allBeads} />,
  );
}

const TASKS_PILL = "epics-bead-card-tasks-pill";
const AGENTS_PILL = "epics-bead-card-build-agents-pill";

/** The task card drawn for one child bead. Addressed by bead id, never by position. */
function cardFor(beadId: string): HTMLElement {
  const hit = screen
    .getAllByTestId("epic-task-card")
    .find((c) => c.getAttribute("data-bead-id") === beadId);
  if (hit === undefined) throw new Error(`no task card for ${beadId}`);
  return hit;
}

function settle() {
  act(() => {
    vi.advanceTimersByTime(DOUBLE_CLICK_GRACE_MS + 50);
  });
}

// ── THE TWO FLAT ROWS ARE GONE FROM THE EPIC CARD ───────────────────────────────────────────────

describe("the epic card no longer draws Tasks: or Build agents: as flat rows", () => {
  it("draws NEITHER row, while the very things they listed are still on screen", async () => {
    seed(ROSTER);
    mount();

    // MOUNTED AND POPULATED FIRST. Absence in a card that rendered nothing proves nothing, so this
    // waits for the replacement to appear before claiming the originals are gone.
    const cards = await waitFor(() => screen.getAllByTestId("epic-task-card"));
    expect(cards.length).toBeGreaterThan(0);

    // ROW 5 AND ROW 6 OF THE FOUNDER'S SCREENSHOT, both gone.
    expect(screen.queryByTestId("epics-bead-card-tasks")).toBeNull();
    expect(screen.queryAllByTestId(TASKS_PILL)).toHaveLength(0);
    expect(screen.queryByTestId("epics-bead-card-build-agents")).toBeNull();
    expect(screen.queryAllByTestId(AGENTS_PILL)).toHaveLength(0);
  });

  // ══ THE REMOVAL IS SCOPED TO EPICS, AND THAT IS THE HALF THAT IS EASY TO BREAK ═══════════════
  // `Build agents:` is emptied on an EPIC card because those agents are redrawn inside the tasks.
  // A card that is not an epic has no task cards under it, so that row is the only place its agents
  // are ever named — emptying it there would delete information rather than a duplicate. Note the
  // `Tasks:` row cannot be tested the same way and deliberately is not: `services/beads.isEpic` is
  // "typed epic OR HAS CHILDREN", so any bead with a `Tasks:` row to keep is already an epic. The
  // two treatments are mutually exclusive by construction, not by a rule stated twice.
  it("KEEPS the Build agents row on a card that is NOT an epic", async () => {
    seed(ROSTER);
    // `KID1` is a childless task with a worker on it — not typed an epic and with no children, so
    // `isEpic` says no and the flat row is the only thing that can name `rows-worker`.
    mount(KID1);

    const pills = await waitFor(() => screen.getAllByTestId(AGENTS_PILL));
    expect(pills.map((p) => p.textContent)).toContain("rows-worker");
    // …and no task-card block, because that treatment belongs to epics.
    expect(screen.queryByTestId("epic-task-cards")).toBeNull();
  });
});

// ── THE TASKS, AS PLAN-BOARD CARDS ──────────────────────────────────────────────────────────────

describe("the epic's tasks render as Plan-board task cards", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("draws ONE card per child, by NAME, and leaves another epic's child out", () => {
    seed(ROSTER);
    mount();

    const cards = screen.getAllByTestId("epic-task-card");
    expect(cards.map((c) => c.getAttribute("data-bead-id"))).toEqual([KID_A, KID_B]);
    const text = screen.getByTestId("epic-task-cards").textContent ?? "";
    expect(text).toContain("Wire the rows");
    expect(text).toContain("Ship the rows");
    expect(text).not.toContain("Not my task");
  });

  // ══ THE WHOLE POINT OF THE BEAD ══════════════════════════════════════════════════════════════
  // *"nothing tells you WHICH agent is on WHICH task."* This is the assertion that says it does.
  it("puts each worker INSIDE the task it is bound to, and not inside its sibling", () => {
    seed(ROSTER);
    mount();

    // Collapsed to begin with, so the names appearing below are caused by the expand rather than by
    // a card that always paints them.
    expect(within(cardFor(KID_A)).queryAllByTestId("epic-task-card-agent")).toHaveLength(0);

    fireEvent.click(cardFor(KID_A));
    settle();

    const open = cardFor(KID_A);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    const names = within(open)
      .getAllByTestId("epic-task-card-agent")
      .map((n) => n.textContent);
    expect(names).toEqual(["rows-worker"]);
    // THE OTHER TASK'S WORKER IS NOT IN HERE — which is the difference between a per-task grouping
    // and the flat union this replaces. `ship-worker` is in the epic and would have appeared in the
    // old row; it must not appear in THIS card.
    expect(names).not.toContain("ship-worker");
    expect(names).not.toContain("stranger-worker");
    // …and the sibling holds the other one, so this is a partition and not one lucky bucket.
    fireEvent.click(cardFor(KID_B));
    settle();
    expect(
      within(cardFor(KID_B))
        .getAllByTestId("epic-task-card-agent")
        .map((n) => n.textContent),
    ).toEqual(["ship-worker"]);
  });

  // ══ NOTHING VANISHES ═════════════════════════════════════════════════════════════════════════
  // The flat row NAMED the orchestrator. `spawn_build_agent` takes no epic parameter, so an
  // orchestrator is normally bound to no bead at all and can be filed under no task — and a
  // partition that silently dropped it would make this change a net LOSS of information.
  it("keeps an orchestrator bound to no task visible, in the fallback group", () => {
    seed(ROSTER);
    mount();

    const group = screen.getByTestId("epic-unassigned-agents");
    expect(group.textContent).toContain(UNASSIGNED_AGENTS_LABEL);
    expect(
      within(group)
        .getAllByTestId("epic-task-card-agent")
        .map((n) => n.textContent),
    ).toEqual(["Epic Id At Spawn"]);
    // It is NOT behind an expand: there is no task here to expand into.
    expect(within(group).queryByRole("button", { name: /expand/i })).toBeNull();
  });

  it("draws NO fallback group when every agent could be filed under a task", () => {
    // The group is an anomaly report. Drawing an empty one would put a bare label on a card whose
    // whole complaint was rows that say nothing.
    seed([ROSTER[1]!]);
    mount();

    expect(screen.getAllByTestId("epic-task-card").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("epic-unassigned-agents")).toBeNull();
  });

  it("REALLY JUMPS to the agent when a chip inside a task card is clicked", () => {
    seed(ROSTER);
    // BOTH SIDES INTO PLAN FIRST. A reveal has to SHOW the agent, which means leaving whatever
    // overlay covers the stage and landing on Build — so "build" is only an assertion at all if the
    // column was somewhere else when the chip was clicked. Seeded "build", the expectation restates
    // the seed and stays green with `openProjectTab` deleted outright (roborev 68041).
    useUiStore.setState({ workModeBySide: { left: "plan", right: "plan" } } as never);
    mount();

    fireEvent.click(cardFor(KID_A));
    settle();
    const chip = within(cardFor(KID_A)).getAllByTestId("epic-task-card-agent")[0]!;
    act(() => {
      chip.click();
    });

    // THE REVEAL'S OWN WRITES — exactly what `selectAndOpen` performs, which is what the concierge's
    // `AgentPill` reaches through `openProjectTab`. Asserting these is what makes an inert wiring
    // (or a swapped `{agentId, projectId}`, which typechecks cleanly) fail here.
    expect(useRuntimeStore.getState().openAgentIds).toContain("ag-a");
    expect(useProjectStore.getState().projects[0]?.selectedAgentId).toBe("ag-a");
    const side = useUiStore.getState().pairAssignment[PROJECT] === "left" ? "left" : "right";
    expect(useUiStore.getState().workModeBySide[side]).toBe("build");
    // …AND THE CARD IT SITS IN DID NOT TOGGLE. A chip is an interactive child of a card body whose
    // own click expands, so without `stopPropagation` one gesture would do both.
    settle();
    expect(cardFor(KID_A).getAttribute("aria-expanded")).toBe("true");
  });

  it("REALLY JUMPS to an agent in the fallback group too", () => {
    seed(ROSTER);
    useUiStore.setState({ workModeBySide: { left: "plan", right: "plan" } } as never);
    mount();

    const chip = within(screen.getByTestId("epic-unassigned-agents")).getAllByTestId(
      "epic-task-card-agent",
    )[0]!;
    act(() => {
      chip.click();
    });

    expect(useRuntimeStore.getState().openAgentIds).toContain("ag-head");
    expect(useProjectStore.getState().projects[0]?.selectedAgentId).toBe("ag-head");
  });
});

// ── THE GESTURE THE `Tasks:` PILL USED TO CARRY, PRESERVED ON THE CARD ──────────────────────────

describe("opening a task card narrows the build column to that task", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // The founder asked for this gesture by name: *"if I click on one of the children, I can see the
  // exact build agent or agents that are working on that child."* It moved from the pill onto the
  // task card's own open seam (double click / Enter) when the pill went away; losing it entirely
  // would be a regression this file is the only thing guarding.
  it("NARROWS THE BUILD COLUMN on a double click", () => {
    seed([]);
    // THE OPPOSITE OF EVERY ANSWER BELOW, so each one is a TRANSITION rather than a restatement of
    // the seed: Plan mode (the gesture must reach Build) and the Improve-Sparkle pane up (it must
    // take it down). The pane matters on its own — it renders into the same stage as the column, so
    // a Build mode set underneath it is a chevron that lies about what is on screen.
    useUiStore.setState({
      workModeBySide: { left: "plan", right: "plan" },
      activeSpecial: "sparkle",
    } as never);
    mount();

    // THE REAL BROWSER SEQUENCE: click(detail 1) → click(detail 2) → dblclick. Firing only
    // `doubleClick` would never arm the deferred expand, so the cancellation this depends on would
    // go untested.
    const card = cardFor(KID_B);
    fireEvent.click(card, { detail: 1 });
    fireEvent.click(card, { detail: 2 });
    fireEvent.doubleClick(card);
    settle();

    const side = useUiStore.getState().pairAssignment[PROJECT] === "left" ? "left" : "right";
    // THE NARROWING ITSELF, read through the composition rule rather than the raw key, because
    // `child ?? epic` is what the column actually renders from.
    expect(useUiStore.getState().beadFocusBySide[side]).toBe(KID_B);
    expect(focusedBeadIdForSide(useUiStore.getState(), side)).toBe(KID_B);
    // The column is actually SHOWING — the focus banner and its only clear control are gated on
    // `mode !== "plan"`, so a narrowing set under the board is one the reader can neither see nor
    // undo.
    expect(useUiStore.getState().workModeBySide[side]).toBe("build");
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  // ══ THE FOUNDER'S OTHER CONSTRAINT, IN ITS OWN ROW ════════════════════════════════════════════
  // *"…without closing the open epic card."* This card IS that card: the column expands it while
  // `focusedEpicId === epic.id`, which it reads from `epicFocusBySide`. A task id written into that
  // key matches no epic and would snap the card shut under the reader mid-gesture.
  it("leaves the OPEN EPIC's own key untouched, so its card stays open", () => {
    seed([]);
    const side = useUiStore.getState().pairAssignment[PROJECT] === "left" ? "left" : "right";
    act(() => {
      useUiStore.getState().openEpicFocus(side, EPIC_ID);
    });
    mount();

    const card = cardFor(KID_B);
    fireEvent.click(card, { detail: 1 });
    fireEvent.click(card, { detail: 2 });
    fireEvent.doubleClick(card);
    settle();

    expect(useUiStore.getState().epicFocusBySide[side]).toBe(EPIC_ID);
    // …and the column is nonetheless narrowed to the TASK, because the child rung wins while it
    // holds. Both halves, or this passes for a gesture that did nothing at all.
    expect(focusedBeadIdForSide(useUiStore.getState(), side)).toBe(KID_B);
  });

  it("narrows the LEFT pair without disturbing what the RIGHT pair is showing", () => {
    // THE TWO WRITES HAVE TO AGREE ON A SIDE. The focus write reads it from `sideOf`; the selection
    // used to be a bare `projectStore.selectProject`, which writes `selectedProjectId` — the RIGHT
    // pair's slot. So this gesture narrowed the left column correctly AND shoved a left project into
    // the right pair's selection, which `Workspace` then discards, dropping the right pair onto its
    // own first project: opening a task on one half of the cockpit silently re-navigated the other.
    // `selectProjectOnItsSide` is what keeps the two writes on one side.
    seedTwoPairs();
    useUiStore.setState({ workModeBySide: { left: "plan", right: "build" } } as never);
    mount();

    const card = cardFor(KID_B);
    fireEvent.click(card, { detail: 1 });
    fireEvent.click(card, { detail: 2 });
    fireEvent.doubleClick(card);
    settle();

    // The LEFT pair moved — the card's own project is now the left selection, its column is showing
    // Build, and it is narrowed to the opened task.
    expect(useUiStore.getState().leftProjectId).toBe(PROJECT);
    expect(useUiStore.getState().workModeBySide.left).toBe("build");
    expect(useUiStore.getState().beadFocusBySide.left).toBe(KID_B);
    // ...and the RIGHT pair was NOT touched: not its selection, not its mode, and NOT its narrowing.
    // This is the pair that fails with `selectProject`, and it is the whole point of the test — the
    // left-side assertions above pass either way.
    expect(useProjectStore.getState().selectedProjectId).toBe(RIGHT_PROJECT);
    expect(useUiStore.getState().workModeBySide.right).toBe("build");
    expect(useUiStore.getState().beadFocusBySide.right).toBeNull();
  });
});

describe("a bead with no lineage at all", () => {
  it("draws NO lineage block — not even a bare label", async () => {
    // The card IS mounted and rendered: absence in a component that is not in the tree proves
    // nothing. A worker exists too, bound elsewhere, so this cannot pass merely for want of agents.
    seed([{ id: "ag-theirs", name: "stranger-worker", kind: "worker", beadId: STRANGER_KID }]);
    const { container } = mount(LONER, LONER_BEADS);

    await waitFor(() =>
      expect(container.querySelector('[data-testid="epics-bead-card"]')).not.toBeNull(),
    );
    expect(screen.queryByTestId("epics-bead-card-lineage")).toBeNull();
    expect(screen.queryByTestId("epics-bead-card-tasks")).toBeNull();
    expect(screen.queryByTestId(AGENTS_PILL)).toBeNull();
    expect(screen.queryByTestId("epic-task-cards")).toBeNull();
  });
});
