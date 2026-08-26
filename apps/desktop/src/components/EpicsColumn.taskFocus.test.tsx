// @vitest-environment jsdom
//
// CLICKING A CHILD TASK NARROWS THE BUILD COLUMN — AND THE EPIC'S CARD STAYS ON SCREEN.
//
// The founder: *"If I click to open an epic on the epic column and then I click on one of the
// children, I can see the exact build agent or agents that are working on that child."* Plus the
// constraint that is easy to satisfy on paper and easy to break in practice: doing so must not
// close the card he just clicked into.
//
// ══ WHY THIS FILE EXISTS BESIDE `EpicInlineCard.lineage.test.tsx` ═══════════════════════════════
// That file mounts the CARD ALONE and asserts `epicFocusBySide` was not disturbed. That is the
// right unit assertion and it is a PROXY: it says the key the column reads is unchanged, not that
// the column still renders the card. Those come apart the moment anything else in the click path
// re-renders or unmounts the column — and "the card vanished under me" is precisely the failure the
// founder named, so it deserves an assertion on the CARD ITSELF rather than on its input.
//
// So this file mounts the REAL `EpicsColumn`, opens an epic the way a user does (clicking its row),
// clicks a child task pill inside the open card, and then asks the DOM whether the card is still
// there. `EpicsColumn.goalMount.test.tsx` beside it makes the same argument for a different field:
// a mount question has to be asked of the mounted tree.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { EpicsColumn } from "./EpicsColumn";
import { useBeadsStore } from "../stores/beadsStore";
import { useProjectStore } from "../stores/projectStore";
import { useSettingsStore } from "../stores/settingsStore";
import { focusedBeadIdForSide, useUiStore } from "../stores/uiStore";
import { bucketBeads, type Bead } from "../services/beads";
import type { Project } from "../types";

const PROJECT = {
  id: "p1",
  name: "Alpha",
  rootPath: "/tmp/alpha",
  agents: [],
} as unknown as Project;

const EPIC_ID = "ep-1";
const TASK_ID = "ep-1.a";
const OTHER_TASK_ID = "ep-1.b";

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", labels: [], type: "task", ...over } as Bead;
}

const EPIC = bead(EPIC_ID, { type: "epic", title: "The epic being worked" });
const TASK = bead(TASK_ID, { parent: EPIC_ID, title: "Wire the rows", status: "in_progress" });
const OTHER = bead(OTHER_TASK_ID, { parent: EPIC_ID, title: "Ship the rows" });
const BEADS = [EPIC, TASK, OTHER];

/** THE ARRAY HANDED TO THE COLUMN MUST BE THE VERY ONE IN THE STORE — the connected wrapper
 *  resolves its project by REFERENCE IDENTITY, and a copy renders nothing. Carried over from
 *  `EpicsColumn.goalMount.test.tsx`, which learned it the hard way. */
function seed(beads: Bead[] = BEADS, project: Project = PROJECT) {
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      [project.id]: { beads, board: bucketBeads(beads), polledAt: 0 },
    },
    error: {},
  }) as never);
  useProjectStore.setState({ projects: [project], selectedProjectId: project.id } as never);
}

beforeEach(() => {
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  // BOTH RUNGS RESET. `setBeadFocus` TOGGLES, so a value surviving from an earlier case — or from a
  // vitest RETRY of this one — makes the next click CLEAR the focus instead of setting it, and the
  // file alternates pass/fail on identical code. That is a real defect this feature's own sibling
  // suite shipped with; it is not a hypothetical.
  useUiStore.setState({
    epicFocusBySide: { left: null, right: null },
    beadFocusBySide: { left: null, right: null },
    workModeBySide: { left: "plan", right: "plan" },
    pairAssignment: {},
    leftProjectId: null,
  } as never);
  seed();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const card = () => screen.queryByTestId("epic-inline-card");

/**
 * THE CHILD TASKS, AS THE CARD NOW DRAWS THEM.
 *
 * They were `Tasks:` PILLS until bead sparkle-huw924.10; they are now the Plan board's own
 * `EpicTaskCard`, one per child, with that child's build agents inside it. The founder's gesture
 * did not change — *"if I click on one of the children, I can see the exact build agent or agents
 * that are working on that child"* — it moved onto the card's OPEN seam, which is a double click.
 * A single click expands the card in place instead, which is the other half of the same ask.
 */
const taskCards = () => screen.queryAllByTestId("epic-task-card");
const taskCardTitled = (title: string) =>
  taskCards().find((c) => (c.textContent ?? "").includes(title))!;

/** THE REAL BROWSER SEQUENCE: click(detail 1) → click(detail 2) → dblclick. Firing only
 *  `doubleClick` would never arm the deferred single-click expand, so the cancellation the open
 *  depends on would go untested — and a card left expanded behind the task it opened is exactly
 *  the side effect `EpicTaskCard` defers for. */
function openTask(el: HTMLElement) {
  fireEvent.click(el, { detail: 1 });
  fireEvent.click(el, { detail: 2 });
  fireEvent.doubleClick(el);
}

/** Open the epic the way a user does — by clicking its ROW — rather than by writing the store.
 *  Seeding the focus directly would skip the very state transition the card's presence depends on. */
async function openTheEpic() {
  render(<EpicsColumn project={PROJECT} side="right" />);
  const row = await waitFor(() => screen.getByTestId("epic-row"));
  fireEvent.click(row);
  return await waitFor(() => screen.getByTestId("epic-inline-card"));
}

describe("clicking a child task in the epics column", () => {
  // POSITIVE CONTROL, and the file is worthless without it: every assertion below is about a card
  // that must still be there, which is trivially satisfied by a column that never opened one.
  it("opens the epic's card when its row is clicked", async () => {
    await openTheEpic();
    expect(card()).not.toBeNull();
    expect(useUiStore.getState().epicFocusBySide.right).toBe(EPIC_ID);
  });

  it("renders a TASK CARD for each child task", async () => {
    await openTheEpic();
    const cards = await waitFor(() => {
      const found = taskCards();
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(cards.map((c) => c.getAttribute("data-bead-id"))).toEqual([TASK_ID, OTHER_TASK_ID]);
    const text = screen.getByTestId("epic-task-cards").textContent ?? "";
    expect(text).toContain("Wire the rows");
    expect(text).toContain("Ship the rows");
    // …AND THE ROW THEY REPLACED IS GONE. A removal nothing pins comes back; this is the surface
    // the founder was looking at when he re-asked for it (bead sparkle-huw924.10).
    expect(screen.queryAllByTestId("epics-bead-card-tasks-pill")).toHaveLength(0);
    expect(screen.queryByTestId("epics-bead-card-build-agents")).toBeNull();
  });

  // ══ THE FOUNDER'S SENTENCE, BOTH HALVES, ON THE RENDERED TREE ════════════════════════════════
  it("narrows the build column to that task AND leaves the card on screen", async () => {
    await openTheEpic();
    await waitFor(() => expect(taskCards().length).toBeGreaterThan(0));
    openTask(taskCardTitled("Wire the rows"));

    // The narrowing, read through the composition rule — `child ?? epic` is what the build column
    // actually renders from, so asserting the raw key alone would not prove the column moved.
    expect(focusedBeadIdForSide(useUiStore.getState(), "right")).toBe(TASK_ID);
    // …and THE CARD IS STILL IN THE DOCUMENT. This is the assertion the sibling suite cannot make:
    // it owns the key, this owns the tree.
    expect(card()).not.toBeNull();
  });

  // The narrowing is invisible while the side shows the Plan board — `AgentSidebar` gates the focus
  // banner, and its only clear control, on `mode !== "plan"`. The seed starts in "plan" so this is a
  // TRANSITION rather than a restatement.
  it("puts the side into Build, so the narrowing is visible and clearable", async () => {
    await openTheEpic();
    await waitFor(() => expect(taskCards().length).toBeGreaterThan(0));
    openTask(taskCardTitled("Wire the rows"));
    expect(useUiStore.getState().workModeBySide.right).toBe("build");
  });

  // RULE 2 FROM THE READER'S SIDE: the gesture is its own off-switch, so pressing the same task again
  // hands the column back to the EPIC — not to everything — and the card is still open throughout.
  // That is what makes it a drill-DOWN rather than a jump.
  it("pressing the same task again returns the column to the epic, card still open", async () => {
    await openTheEpic();
    await waitFor(() => expect(taskCards().length).toBeGreaterThan(0));
    openTask(taskCardTitled("Wire the rows"));
    openTask(taskCardTitled("Wire the rows"));

    expect(useUiStore.getState().beadFocusBySide.right).toBeNull();
    expect(focusedBeadIdForSide(useUiStore.getState(), "right")).toBe(EPIC_ID);
    expect(card()).not.toBeNull();
  });

  // Moving between two children of the same epic must land on the SECOND one, not toggle the first
  // off and leave the column on the epic — the shape a naive "click clears then sets" would produce.
  it("moves between two child tasks without falling back to the epic", async () => {
    await openTheEpic();
    await waitFor(() => expect(taskCards().length).toBeGreaterThan(0));
    openTask(taskCardTitled("Wire the rows"));
    openTask(taskCardTitled("Ship the rows"));

    expect(focusedBeadIdForSide(useUiStore.getState(), "right")).toBe(OTHER_TASK_ID);
    expect(card()).not.toBeNull();
  });
});
