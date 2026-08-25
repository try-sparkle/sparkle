// @vitest-environment jsdom
//
// `Board view` ON THE EPICS COLUMN'S CARD — the PRODUCTION SEAM (bead sparkle-42onk2).
//
// The founder, 2026-08-24: *"For epics on the epic column, I want a [link] to the right of the
// yellow epic pill that says 'board view' and opens the epic on the planning board"*.
//
// ══ WHY THIS EXISTS ALONGSIDE `BeadCard/BeadCardBoardView.test.tsx` ════════════════════════════
// That suite drives `BeadCard` directly and passes `onViewOnBoard` BY HAND, so it proves the card
// draws the link where he asked and calls whatever it was given. It cannot prove the two halves
// that actually make the feature exist:
//
//   1. THAT `EpicInlineCard` SUPPLIES THE CALLBACK AT ALL. It supplied neither destination before
//      this change — the epics column had no route to the board anywhere. That prop is a DEFAULTED
//      SEAM in the component suite (AGENTS.md's second vacuous shape, bead `sparkle-lgbwf`, seen
//      4×): delete the `onViewOnBoard={…}` line from `EpicInlineCard` and every row over there
//      stays green while the link vanishes from the app. It is red here.
//   2. THAT PRESSING IT NAVIGATES. `expect(spy).toHaveBeenCalled()` is a statement about a mock.
//      The founder asked for the epic to OPEN ON THE BOARD, so the assertions below are on the ui
//      store after the click — the board is showing, on the bead's own side, focused on this bead —
//      which is the state `BoardView` actually consumes.
//
// The Tauri boundary is the only thing stubbed, exactly as `EpicInlineCard.chrome.test.tsx` does.
// Mocking `openBeadOnBoard` would mock the wiring this file exists to exercise.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

const { EpicInlineCard } = await import("./EpicInlineCard");
const { useProjectStore } = await import("../stores/projectStore");
const { useUiStore } = await import("../stores/uiStore");
type Bead = import("../services/beads").Bead;

const PROJECT = "p1";
const ROOT = "/repo";
const EPIC_ID = "sparkle-s3g2";
const T = "epics-bead-card";

const EPIC: Bead = {
  id: EPIC_ID,
  title: "Token-maxer defaults epic: plugin foundation + Tier 1 tools",
  description: "The card in the founder's screenshot.",
  status: "open",
  labels: [],
  type: "epic",
};

function seed() {
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT,
        name: "repo",
        rootPath: ROOT,
        defaultBranch: null,
        createdAt: new Date(0).toISOString(),
        selectedAgentId: null,
        agents: [],
      },
    ],
    // RESET. `setState` shallow-merges, so a selection left by an earlier row would make the
    // "it selected the project" half of the navigation assertion pass without this click having
    // done anything (the shape roborev 68125 caught in the concierge's own suite).
    selectedProjectId: null,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  useUiStore.setState({
    // BUILD, not plan — so "the board is showing" is a state this click has to CREATE. Seeded as
    // "plan" it would already be true and the row would pass with the handler deleted.
    workModeBySide: { left: "build", right: "build" },
    boardFocusBeadId: null,
    pairAssignment: {},
    leftProjectId: null,
    openProjectIds: null,
  } as never);
});
afterEach(cleanup);

function mount(over: Partial<Parameters<typeof EpicInlineCard>[0]> = {}) {
  return render(
    <EpicInlineCard bead={EPIC} projectId={PROJECT} rootPath={ROOT} allBeads={[EPIC]} {...over} />,
  );
}

/** The card really rendered. Every absence claim runs after this — absence in a component that is
 *  not in the tree proves nothing (AGENTS.md's fourth vacuous shape). */
function assertTheCardIsReallyThere() {
  expect(screen.getByTestId(`${T}-title`).textContent).toBe(EPIC.title);
  expect(screen.getByTestId(`${T}-id`).textContent).toBe(EPIC_ID);
  expect(screen.getByTestId(`${T}-description`).textContent).toContain("screenshot");
}

// ── THE LINK IS ON THE CARD THE COLUMN ACTUALLY MOUNTS ──────────────────────────────────────────

describe("the epics column's epic card offers the board", () => {
  it("draws 'Board view' beside the epic pill", () => {
    mount();
    assertTheCardIsReallyThere();

    const kids = Array.from(screen.getByTestId(`${T}-chrome`).children);
    const at = (el: HTMLElement) => kids.findIndex((k) => k === el || k.contains(el));
    // `type-pill` — see the note in `BeadCard/BeadCardBoardView.test.tsx`: the yellow EPIC badge
    // is `TypePill` now, one component for every bead type.
    const pill = at(screen.getByTestId(`${T}-type-pill`));
    const board = at(screen.getByTestId(`${T}-open-on-board`));

    expect(pill, "no epic pill in the chrome row").toBeGreaterThan(-1);
    expect(board, "no board link in the chrome row").toBeGreaterThan(-1);
    expect(board).toBeGreaterThan(pill);
    expect(screen.getByTestId(`${T}-destinations`).textContent).toBe("Board view");
  });

  // THE FOUNDER'S EXPLICIT CHOICE, asked directly: the board link ALONE here. This column's whole
  // job is already to narrow the build column — clicking the epic ROW does exactly that — so a
  // `Column` link on the card would be a second, quieter way to do what opening the card just did.
  it("offers no 'Column' link, because the column is what the reader is already in", () => {
    mount();
    assertTheCardIsReallyThere();
    expect(screen.queryByTestId(`${T}-open-in-column`)).toBeNull();
    expect(screen.getByTestId(`${T}-destinations`).querySelectorAll("button")).toHaveLength(1);
  });

  // NAVIGATION IS NOT A WRITE. Chat, the priority control and the goal field are all gated on
  // `canWrite` because they go through `bd`; this one must not be, or a project with no path loses
  // a destination that works perfectly well.
  it("still offers the board on a read-only card with no project path", () => {
    mount({ rootPath: null });
    assertTheCardIsReallyThere();
    expect(screen.queryByTestId(`${T}-chat`)).toBeNull();
    expect(screen.getByTestId(`${T}-open-on-board`)).toBeTruthy();
  });
});

// ── AND PRESSING IT REALLY OPENS THE BOARD ──────────────────────────────────────────────────────

describe("pressing 'Board' opens this epic on the planning board", () => {
  it("shows the board on the bead's own side, focused on the bead", () => {
    mount();
    // THE STATE BEFORE, asserted — otherwise "the board is showing" afterwards could have been
    // true the whole time and the click could be doing nothing at all.
    expect(useUiStore.getState().workModeBySide.right).toBe("build");
    expect(useUiStore.getState().boardFocusBeadId).toBeNull();

    fireEvent.click(screen.getByTestId(`${T}-open-on-board`));

    const ui = useUiStore.getState();
    // The three writes `BoardView` consumes: the mode, the focus, and the project the side shows.
    expect(ui.workModeBySide.right).toBe("plan");
    expect(ui.boardFocusBeadId).toBe(EPIC_ID);
    expect(useProjectStore.getState().selectedProjectId).toBe(PROJECT);
  });

  // ══ THE SIDE IS READ FROM WHERE THE PROJECT LIVES, NEVER HARD-CODED ════════════════════════
  // `sideOf` defaults to "right", so every fixture that leaves `pairAssignment` empty is
  // ACCIDENTALLY CORRECT for a hard-coded "right" — which is exactly how the narrow `selectProject`
  // form survived a whole suite unnoticed (roborev 55149 / 68041, quoted in `openBeadOnBoard`).
  // This row is the one that can tell them apart: it puts the project on the LEFT pair.
  it("opens the LEFT board for a left-assigned project, not the right one", () => {
    useUiStore.setState({ pairAssignment: { [PROJECT]: "left" } } as never);
    mount();
    fireEvent.click(screen.getByTestId(`${T}-open-on-board`));

    const ui = useUiStore.getState();
    expect(ui.workModeBySide.left).toBe("plan");
    // …and the OTHER half of the cockpit was left alone. A hard-coded side passes the row above
    // and fails here; a side-blind project selection passes both and silently re-navigates the
    // right pair, which is the defect this pins.
    expect(ui.workModeBySide.right).toBe("build");
    expect(ui.leftProjectId).toBe(PROJECT);
    expect(ui.boardFocusBeadId).toBe(EPIC_ID);
  });

  // The card body is the expand/collapse target and the column reads that state, so a press that
  // navigates AND folds the card is one gesture doing two things. `BeadCard` stops the bubble; this
  // asserts it survives the real wrapper, where the click passes through `EpicCardFrame` too.
  it("does not also collapse the card out from under the reader", () => {
    mount();
    fireEvent.click(screen.getByTestId(`${T}-open-on-board`));
    // The navigation really happened…
    expect(useUiStore.getState().boardFocusBeadId).toBe(EPIC_ID);
    // …and the card is still on screen with its content intact.
    assertTheCardIsReallyThere();
    expect(screen.getByTestId(`${T}-open-on-board`)).toBeTruthy();
  });

  // A SECOND PRESS MUST STILL LAND THERE. `setBoardFocusBeadId` is a ONE-SHOT that `BoardView`
  // consumes and clears, so a reader who navigates away and comes back presses this again — and an
  // idempotence bug here reads as "the link stopped working", the hardest kind to report.
  it("re-arms the focus when pressed again after the board consumed it", () => {
    mount();
    fireEvent.click(screen.getByTestId(`${T}-open-on-board`));
    expect(useUiStore.getState().boardFocusBeadId).toBe(EPIC_ID);

    // BoardView's own clear, verbatim — the one-shot is spent.
    useUiStore.getState().setBoardFocusBeadId(null);
    fireEvent.click(screen.getByTestId(`${T}-open-on-board`));
    expect(useUiStore.getState().boardFocusBeadId).toBe(EPIC_ID);
  });
});
