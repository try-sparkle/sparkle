// @vitest-environment jsdom
//
// THE EPICS COLUMN'S OPEN CARD SHOWS ITS LINEAGE — AND BOTH PILL KINDS REALLY NAVIGATE.
//
// bead sparkle-h9wgyf. The founder: *"I SHOULD ALWAYS BE ABLE TO SEE THE CHILDREN OR PARENT OF ANY
// CARD"*, and about the pills: build-agent pills *"are REAL LINKS: clicking one jumps to that
// agent, the same affordance the concierge uses in chat."*
//
// ══ WHAT THIS FILE IS FOR ═════════════════════════════════════════════════════════════════════
// `engine/beadLineage.test.ts` proves the resolver answers the right question; `BeadLineageRows`
// has its own suite for the rows. Neither can prove THIS card asks, or that its callbacks reach
// anything — the defect class here is a correct component rendered from a wrong argument, or a pill
// wired to a no-op. So every assertion below is on the SIDE EFFECT: the pill that got painted, or
// the store write the click produced. "A prop was passed" would stay green with the whole
// navigation deleted.
//
// ══ jsdom NEVER LAYS OUT ══════════════════════════════════════════════════════════════════════
// Every pill's `offsetWidth` reads 0, so `usePacking` FAILS OPEN and renders them all — which is
// why the names are readable here at all. Nothing in this file may assert a "+N more" count.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

const { EpicInlineCard } = await import("./EpicInlineCard");
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
    // next click CLEAR the focus instead of setting it, so the suite alternates pass/fail on the
    // same code. That is the cross-test hygiene this block exists for, extended to the rung the
    // Tasks pill now writes.
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

describe("the epic card's Tasks row", () => {
  it("names the epic's OWN children, and leaves another epic's child out", async () => {
    // Both epics' children are in the same snapshot, so "the stranger is absent" is a statement
    // about the filter rather than about a card that renders no tasks under any circumstances.
    seed([]);
    mount();

    const pills = await waitFor(() => screen.getAllByTestId(TASKS_PILL));
    const labels = pills.map((p) => p.textContent);
    expect(labels).toContain("Wire the rows");
    expect(labels).toContain("Ship the rows");
    expect(labels).not.toContain("Not my task");
    // The NAME, never the raw id — the founder asked for "the name of each task as a pill".
    expect(screen.getByTestId("epics-bead-card-tasks").textContent).not.toContain(KID_A);
  });

  // ══ THIS ROW CHANGED DESTINATION, DELIBERATELY ════════════════════════════════════════════════
  // It asserted that the pill HANDED THE TASK OFF TO THE BOARD. The founder asked for the other
  // thing by name — *"if I click on one of the children, I can see the exact build agent or agents
  // that are working on that child"* — so in THIS column the pill now narrows the build column.
  // The board remains where a task's own CARD is read; it is not what this gesture is for.
  it("NARROWS THE BUILD COLUMN to the task when its pill is clicked", async () => {
    seed([]);
    // THE OPPOSITE OF EVERY ANSWER BELOW, so each one is a TRANSITION rather than a restatement of
    // the seed: Plan mode (the click must reach Build) and the Improve-Sparkle pane up (the click
    // must take it down). The pane matters on its own — it renders into the same stage as the
    // column, so a Build mode set underneath it is a chevron that lies about what is on screen.
    useUiStore.setState({
      workModeBySide: { left: "plan", right: "plan" },
      activeSpecial: "sparkle",
    } as never);
    mount();

    const pill = (await waitFor(() => screen.getAllByTestId(TASKS_PILL))).find(
      (p) => p.textContent === "Ship the rows",
    )!;
    act(() => {
      pill.click();
    });

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
  // key matches no epic and would snap the card shut under the reader mid-click. Asserted on the
  // key the column reads, so it holds however the card is mounted.
  it("leaves the OPEN EPIC's own key untouched, so its card stays open", async () => {
    seed([]);
    const side = useUiStore.getState().pairAssignment[PROJECT] === "left" ? "left" : "right";
    act(() => {
      useUiStore.getState().openEpicFocus(side, EPIC_ID);
    });
    mount();

    const pill = (await waitFor(() => screen.getAllByTestId(TASKS_PILL))).find(
      (p) => p.textContent === "Ship the rows",
    )!;
    act(() => {
      pill.click();
    });

    expect(useUiStore.getState().epicFocusBySide[side]).toBe(EPIC_ID);
    // …and the column is nonetheless narrowed to the TASK, because the child rung wins while it
    // holds. Both halves, or this passes for a click that did nothing at all.
    expect(focusedBeadIdForSide(useUiStore.getState(), side)).toBe(KID_B);
  });

  // THE DESTINATION CHANGED ABOVE; THIS GUARANTEE DID NOT, and it is the expensive one, so the row
  // is re-aimed rather than retired.
  it("narrows the LEFT pair without disturbing what the RIGHT pair is showing", async () => {
    // THE TWO WRITES HAVE TO AGREE ON A SIDE. The focus write reads it from `sideOf`; the selection
    // used to be a bare `projectStore.selectProject`, which writes `selectedProjectId` — the RIGHT
    // pair's slot. So this click narrowed the left column correctly AND shoved a left project into
    // the right pair's selection, which `Workspace` then discards, dropping the right pair onto its
    // own first project: clicking a task on one half of the cockpit silently re-navigated the
    // other. `selectProjectOnItsSide` is what keeps the two writes on one side.
    seedTwoPairs();
    useUiStore.setState({ workModeBySide: { left: "plan", right: "build" } } as never);
    mount();

    const pill = (await waitFor(() => screen.getAllByTestId(TASKS_PILL))).find(
      (p) => p.textContent === "Ship the rows",
    )!;
    act(() => {
      pill.click();
    });

    // The LEFT pair moved — the card's own project is now the left selection, its column is showing
    // Build, and it is narrowed to the clicked task.
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

describe("the epic card's Build agents row", () => {
  it("names a worker bound to a CHILD, and not one working inside another epic", async () => {
    seed([
      { id: "ag-mine", name: "rows-worker", kind: "worker", beadId: KID_A },
      { id: "ag-theirs", name: "stranger-worker", kind: "worker", beadId: STRANGER_KID },
    ]);
    mount();

    const labels = (await waitFor(() => screen.getAllByTestId(AGENTS_PILL))).map(
      (p) => p.textContent,
    );
    expect(labels).toContain("rows-worker");
    expect(labels).not.toContain("stranger-worker");
  });

  it("REALLY JUMPS to the agent when its pill is clicked", async () => {
    seed([{ id: "ag-mine", name: "rows-worker", kind: "worker", beadId: KID_A }]);
    // BOTH SIDES INTO PLAN FIRST. A reveal has to SHOW the agent, which means leaving whatever
    // overlay covers the stage and landing on Build — so "build" is only an assertion at all if the
    // column was somewhere else when the pill was clicked. Seeded "build", the expectation restates
    // the seed and stays green with `openProjectTab` deleted outright (roborev 68041).
    useUiStore.setState({ workModeBySide: { left: "plan", right: "plan" } } as never);
    mount();

    const pill = (await waitFor(() => screen.getAllByTestId(AGENTS_PILL)))[0]!;
    act(() => {
      pill.click();
    });

    // THE REVEAL'S OWN WRITES — exactly what `selectAndOpen` performs, which is what the concierge's
    // `AgentPill` reaches through `openProjectTab`. Asserting these is what makes an inert wiring
    // (or a swapped `{agentId, projectId}`, which typechecks cleanly) fail here.
    expect(useRuntimeStore.getState().openAgentIds).toContain("ag-mine");
    expect(useProjectStore.getState().projects[0]?.selectedAgentId).toBe("ag-mine");
    const side = useUiStore.getState().pairAssignment[PROJECT] === "left" ? "left" : "right";
    expect(useUiStore.getState().workModeBySide[side]).toBe("build");
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
  });
});
