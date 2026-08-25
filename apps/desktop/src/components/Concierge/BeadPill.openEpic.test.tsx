// @vitest-environment jsdom
//
// OPENING AN EPIC FROM THE CONCIERGE — "in column" and "on board", as one pair.
//
// The founder, reading a bead card in the chat: *"maybe instead of Build It, because it's already
// building… it could say something like Open. And then there's two options, and maybe they're just
// two clickable links. One is in column, and the other is on board. And I have the option to open
// the epic in the build column or open the epic on the planning board."*
//
// ══ WHAT IS ACTUALLY AT RISK HERE, WHICH IS NOT "DOES A LINK RENDER" ════════════════════════════
// "on board" already shipped. The new destination is the BUILD COLUMN, and every way of getting it
// wrong produces a card that looks perfect and a click that does nothing visible:
//
//   1. ONE STORE WRITE INSTEAD OF TWO. The narrowing is real but INVISIBLE while that side is
//      showing the Plan board — `AgentSidebar` gates the focus banner (and its only "Show all"
//      clear) on `mode !== "plan"`. So `openEpicFocus` alone is a filter the reader can neither see
//      nor undo. The row below asserts BOTH writes, and asserts the mode one by its effect.
//   2. THE TOGGLING SETTER. `setEpicFocus` CLEARS when handed the epic it already holds — correct
//      for the epics-column row, catastrophic for a link labelled Open, whose second press would
//      un-focus the epic. Nothing in the rendered output distinguishes the two setters, so the
//      idempotency row presses TWICE and asserts the focus SURVIVED.
//   3. THE EPIC GATE ANSWERED LOCALLY. `bead.type === "epic"` is a different question from epic
//      MEMBERSHIP (`isEpicIndexed`), and it misses every structural epic nobody declared. The gate
//      rows below feed a bead of each shape.
//
// Every assertion is therefore on a SIDE EFFECT — the store after the click, or the control that
// appears only when the other one has stood down — never on "a card rendered", which was true
// before any of this existed and would stay true with the whole feature deleted.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Markdown } from "../Markdown";
import { BeadPillHost, BeadPillProvider, type BeadPillContextValue } from "./BeadPill";
import { useBeadsStore } from "../../stores/beadsStore";
import { focusedBeadIdForSide, useUiStore } from "../../stores/uiStore";
import { useProjectStore } from "../../stores/projectStore";
import type { Bead } from "../../services/beads";

afterEach(() => cleanup());

// The poller would shell out to `bd` through a Tauri bridge jsdom does not have. Stubbed exactly as
// `BeadPill.test.tsx` does, so beads stay ON and the real resolution path runs.
const realPoller = {
  startPolling: useBeadsStore.getState().startPolling,
  stopPolling: useBeadsStore.getState().stopPolling,
};

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: "An epic the concierge mentioned",
    description: "",
    status: "open",
    type: "feature",
    priority: 0,
    labels: [],
    parent: null,
    commentCount: 0,
    ...over,
  };
}

// THREE BEAD SHAPES, and the middle one is the whole reason the gate cannot be `bead.type`.
/** A DECLARED epic — `issue_type = 'epic'`, no children yet. */
const DECLARED = bead({ id: "sparkle-decl", type: "epic" });
/** A STRUCTURAL epic — never declared one, but something points at it. `isEpicIndexed` says yes;
 *  `bead.type === "epic"` says no. A local gate would silently drop this card's links. */
const STRUCTURAL = bead({ id: "sparkle-struct", type: "feature" });
const STRUCTURAL_CHILD = bead({ id: "", parent: "sparkle-struct" });
/** A plain task — no children, not declared. It gets the destinations too: the column can narrow to
 *  a task, so withholding them hid a view it could already render. */
const TASK = bead({ id: "sparkle-task" });

const ALL = [DECLARED, STRUCTURAL, STRUCTURAL_CHILD, TASK];

beforeEach(() => {
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} });
  // `useBeadBuildActions` reads the backlog from HERE, not from the pill context — the epic gate is
  // answered against this snapshot, so a case that seeds only the context would ask the resolver
  // about an empty backlog and every bead would come back "not an epic".
  useBeadsStore.setState({ byProject: { p1: { beads: ALL, board: {} as never, loadedAt: 1 } } });
  useProjectStore.setState({
    projects: [{ id: "p1", name: "Sparkle", rootPath: "/tmp/p1", agents: [] }],
    // RESET, and it is what gives the left-side rows below any grip at all. `setState` SHALLOW
    // MERGES, so without this `selectedProjectId` survives from the previous row — and the rows
    // above run with `pairAssignment: {}`, which `sideOf` resolves to "right", so by the time a
    // left-side row starts the selection is already "p1". A `toBe(captured-before)` assertion then
    // passes against the narrow `selectProject` writing "p1" again (roborev 68125).
    selectedProjectId: null,
  } as never);
  useUiStore.setState({
    epicFocusBySide: { left: null, right: null },
    beadFocusBySide: { left: null, right: null },
    workModeBySide: { left: "build", right: "build" },
    // RESET, because one row below deliberately assigns p1 to the LEFT pair — the only fixture the
    // side-vs-selection defect is visible in. Without this it leaks into every later row, which
    // then asserts against the right pair and reads null.
    pairAssignment: {},
    leftProjectId: null,
    // Two rows below close every tab; without this reset that leaks into the rest of the file.
    openProjectIds: null,
  } as never);
});
afterEach(() => {
  useBeadsStore.setState(realPoller);
  useBeadsStore.setState({ byProject: {}, loading: {}, error: {} });
});

/** A context whose board resolves `beads`, wired with BOTH destinations reporting success. */
function ctx(beads: Bead[], over: Partial<BeadPillContextValue> = {}): BeadPillContextValue {
  return {
    beads: new Map(beads.map((b) => [b.id, { bead: b, projectId: "p1" }])),
    onViewOnBoard: vi.fn(() => true),
    onViewInColumn: vi.fn(() => true),
    ...over,
  };
}

/** Mount the thread and OPEN the card for `id` — every row below starts here. */
function openCard(id: string, value: BeadPillContextValue = ctx(ALL)) {
  render(
    <BeadPillProvider value={value}>
      <Markdown text={`see ${id}`} />
    </BeadPillProvider>,
  );
  fireEvent.click(screen.getAllByTestId("concierge-bead-pill")[0]!);
  return value;
}

const inColumn = () => screen.queryByTestId("concierge-bead-card-open-in-column");
const onBoard = () => screen.queryByTestId("concierge-bead-card-open-on-board");
/** THE RETIRED CORNER BUTTON. It no longer exists anywhere — the founder moved both destinations up
 *  beside the epic pill on 2026-08-24 (bead sparkle-42onk2) and the bordered `View on board` in the
 *  corner cluster was deleted, not hidden. The probe is KEPT rather than removed so the rows below
 *  stay a live guard against it coming back: a card carrying both it and the pill-side link would
 *  offer one destination twice, which is what the pair-vs-standalone stand-down rule existed for. */
const standaloneBoard = () => screen.queryByTestId("concierge-bead-card-view-on-board");

// ── 1. WHO GETS THE PAIR ────────────────────────────────────────────────────────────────────────

describe("Open links — only an epic, and epic means MEMBERSHIP not type", () => {
  it("a declared epic gets both links", () => {
    openCard(DECLARED.id);
    expect(inColumn()).not.toBeNull();
    expect(onBoard()).not.toBeNull();
  });

  // THE ROW A RAW `type`-FIELD TEST FAILS. This bead was never declared an epic; it is one because
  // `` points at it. `isEpicIndexed` is the only check that sees that, and it is why
  // `scripts/lib/epic-membership-guard.sh` forbids a second definition. The rung no longer gates
  // whether the link RENDERS, but it still picks which store key the click writes — see part 3.
  it("a STRUCTURAL epic — children but no epic type — gets both links", () => {
    openCard(STRUCTURAL.id);
    expect(inColumn()).not.toBeNull();
    expect(onBoard()).not.toBeNull();
  });

  // A TASK GETS IT TOO, and this row is the one that changed. It was "a plain task gets NO Open
  // group", on the reading that both destinations are epic-shaped. The founder named the missing
  // half — *"see what actual active building is being done against any given task"* — and the
  // column can narrow to a task, so withholding the link hid a view it could already render.
  it("a plain TASK gets the Open group too", () => {
    openCard(TASK.id);
    expect(inColumn()).not.toBeNull();
    expect(onBoard()).not.toBeNull();
  });

  // ONE BOARD CONTROL PER CARD, whatever the bead's shape. This used to be a stand-down rule (the
  // corner button hid itself when the group appeared); it is now a deletion, and this row is what
  // would catch the corner button being restored beside the new link.
  it("no card renders the retired corner button AND the pill-side link", () => {
    openCard(DECLARED.id);
    expect(standaloneBoard()).toBeNull();
    expect(onBoard()).not.toBeNull();
    cleanup();
    openCard(TASK.id);
    expect(standaloneBoard()).toBeNull();
    expect(onBoard()).not.toBeNull();
  });

  // …and a surface with NO column destination gets the board link ALONE, in the same place — which
  // is the case the EPICS COLUMN is (it passes only `onViewOnBoard`). Before the move this fell
  // back to the corner button; there is one drawing now, so the fallback is the SAME control with
  // one fewer sibling rather than a different control somewhere else on the card.
  it("a surface with no column destination gets the board link alone, still beside the pill", () => {
    openCard(TASK.id, ctx(ALL, { onViewInColumn: undefined }));
    expect(inColumn()).toBeNull();
    expect(standaloneBoard()).toBeNull();
    expect(onBoard()).not.toBeNull();
    // Still in the chrome row, not relocated to the corner — the whole point of the move.
    const chrome = screen.getByTestId("concierge-bead-card-chrome");
    expect(chrome.contains(onBoard())).toBe(true);
    expect(screen.getByTestId("concierge-bead-card-corner").contains(onBoard())).toBe(false);
  });

  // ONE LINK WHEN ONLY ONE DESTINATION IS MEANINGFUL. A surface with no board still offers the
  // column rather than a dead second link.
  it("renders 'in column' alone when the surface has no board to open", () => {
    openCard(DECLARED.id, ctx(ALL, { onViewOnBoard: undefined }));
    expect(inColumn()).not.toBeNull();
    expect(onBoard()).toBeNull();
    expect(standaloneBoard()).toBeNull();
  });
});

// ── 2. WHAT THE COLUMN LINK ACTUALLY DOES TO THE STORE ──────────────────────────────────────────

describe("viewInColumn — the two writes, and why one is not enough", () => {
  /**
   * Mount the REAL HOST — `BeadPillHost` is what installs the production `viewInColumn`, and it is
   * the only way to reach that function at all (it is module-private, so the context field IS its
   * public surface).
   *
   * ══ WHY NOT JUST PASS A CONTEXT WITH THE SAME BODY IN IT ════════════════════════════════════
   * Because that is the defaulted-seam trap: a test that supplies its own copy of the two store
   * writes asserts ITS OWN copy, and the line in `BeadPillHost` that supplies the real one is then
   * covered by nothing — delete `onViewInColumn: viewInColumn` from the provider value and every
   * row here would still pass while the shipped card's link did nothing. These rows go through the
   * host so that deletion is a failure.
   *
   * The side is DERIVED, not passed: `sideOf(pairAssignment, "p1")` is total and defaults to
   * "right" for a project no pair claims, which is what the seeded store leaves it as.
   */
  function realHost(id: string) {
    render(
      <BeadPillHost>
        <Markdown text={`see ${id}`} />
      </BeadPillHost>,
    );
    fireEvent.click(screen.getAllByTestId("concierge-bead-pill")[0]!);
  }

  it("focuses the epic in the build column", () => {
    realHost(DECLARED.id);
    fireEvent.click(inColumn()!);
    expect(useUiStore.getState().epicFocusBySide.right).toBe(DECLARED.id);
  });

  // THE WRITE THAT IS EASY TO OMIT AND IMPOSSIBLE TO SEE. Asserted by its EFFECT on the mode, not
  // by spying on the setter: `showBuildStage` is what makes the narrowing (and its clear control)
  // visible at all, and a version of this feature that skipped it would pass the row above.
  it("also puts that side into the Build stage, so the narrowing is visible", () => {
    useUiStore.setState({ workModeBySide: { left: "build", right: "plan" } } as never);
    realHost(DECLARED.id);
    fireEvent.click(inColumn()!);
    expect(useUiStore.getState().workModeBySide.right).toBe("build");
  });

  // ══ THE LEFT-ASSIGNED PROJECT — THE ONLY FIXTURE THIS DEFECT IS VISIBLE IN ═══════════════════
  // Every other row here runs with the DEFAULT `pairAssignment`, which `sideOf` resolves to
  // "right" — and `projectStore.selectProject` writes the RIGHT pair's slot, so it is accidentally
  // correct in all of them. That is why a High-severity defect sat green through this whole suite
  // (roborev 68120): the side and the write only disagree when the project is on the LEFT.
  //
  // What goes wrong without `selectProjectOnItsSide`: the left project's id is written into the
  // RIGHT pair's `selectedProjectId`, `Workspace`'s reconcile effect discards it, and the right
  // half of the cockpit silently re-navigates — while `leftProjectId` never moves, so the left
  // build column narrows to an epic the project it is showing does not contain.
  it("puts a LEFT-assigned project on its OWN side, leaving the right pair alone", () => {
    // Keyed PROJECT -> SIDE, not side -> project: `sideOf` reads `assignment[projectId]`.
    useUiStore.setState({ pairAssignment: { p1: "left" } } as never);

    realHost(DECLARED.id);
    fireEvent.click(inColumn()!);

    const ui = useUiStore.getState();
    // The side that actually moved is the LEFT one…
    expect(ui.leftProjectId).toBe("p1");
    expect(ui.epicFocusBySide.left).toBe(DECLARED.id);
    // …and the RIGHT pair's selection was never touched. ABSOLUTE, not a captured prior: `null` is a
    // value the narrow `selectProject` cannot produce, whereas `toBe(before)` was satisfied by it
    // writing the same id twice.
    expect(useProjectStore.getState().selectedProjectId).toBeNull();
  });

  // THE SAME RULE ON THE OTHER DESTINATION. `viewOnBoard` carries its own copy of the narrow write,
  // and every board-path store test seeds `pairAssignment: {}` — which resolves to "right", making
  // `selectProject` accidentally correct in all of them. So reverting that line alone left the whole
  // suite green: unpinned, and therefore losable in exactly the merge that reintroduced it once
  // already (roborev 68125). The two copies move together or neither is guarded.
  it("puts a LEFT-assigned project on its own side for the BOARD link too", () => {
    useUiStore.setState({ pairAssignment: { p1: "left" } } as never);

    realHost(DECLARED.id);
    fireEvent.click(onBoard()!);

    expect(useUiStore.getState().leftProjectId).toBe("p1");
    expect(useProjectStore.getState().selectedProjectId).toBeNull();
  });

  // ══ A CLOSED TAB — THE CASE THE ALL-OPEN DEFAULT HIDES ═══════════════════════════════════════
  // `openProjectIds` is `null` (meaning "all open") until the reader closes a tab, so every other
  // row here runs with the project already open and cannot see this. `selectProjectOnItsSide` writes
  // only the selection; `Workspace` resolves a side through `resolveSideProject`, which filters to
  // OPEN projects first and DISCARDS a selection that is not on that side's open list. Without
  // `markProjectOpen` the click therefore lands the focus writes on a side showing a different
  // project — an empty column and a board focused on a bead it does not contain — while the
  // function still returns `true`, so the card reports success (roborev 68127).
  it("OPENS the project's tab, not just selects it, when the reader had closed it", () => {
    useUiStore.setState({ openProjectIds: [] } as never);

    realHost(DECLARED.id);
    fireEvent.click(inColumn()!);

    expect(useUiStore.getState().openProjectIds).toContain("p1");
  });

  it("opens the tab for the BOARD link too — both destinations carry the same rule", () => {
    useUiStore.setState({ openProjectIds: [] } as never);

    realHost(DECLARED.id);
    fireEvent.click(onBoard()!);

    expect(useUiStore.getState().openProjectIds).toContain("p1");
  });

  // ══ IDEMPOTENCE — THE TOGGLE BUG, CAUGHT AT THE ONLY PLACE IT SHOWS ═══════════════════════════
  // `setEpicFocus` would clear on this second press. A link labelled Open must not.
  it("stays focused when Open is pressed TWICE", () => {
    realHost(DECLARED.id);
    fireEvent.click(inColumn()!);
    fireEvent.click(inColumn()!);
    expect(useUiStore.getState().epicFocusBySide.right).toBe(DECLARED.id);
  });

  // The navigation must not live in a state updater — React replays those, and StrictMode
  // double-invokes them on purpose. `BeadPill`'s board path carries the identical row.
  it("navigates exactly ONCE per click, even under StrictMode", () => {
    const onViewInColumn = vi.fn(() => true);
    render(
      <StrictMode>
        <BeadPillProvider value={ctx(ALL, { onViewInColumn })}>
          <Markdown text={`see ${DECLARED.id}`} />
        </BeadPillProvider>
      </StrictMode>,
    );
    fireEvent.click(screen.getAllByTestId("concierge-bead-pill")[0]!);
    fireEvent.click(inColumn()!);
    expect(onViewInColumn).toHaveBeenCalledTimes(1);
  });

  it("hands the link the bead's OWN id and project, not the reader's selection", () => {
    const onViewInColumn = vi.fn(() => true);
    openCard(STRUCTURAL.id, ctx(ALL, { onViewInColumn }));
    fireEvent.click(inColumn()!);
    // `isEpic: true` travels WITH the call — STRUCTURAL is an epic only because a child points at
    // it, so this also pins that the rung came from the shared resolver rather than from the raw
    // `type` field, which would have said false here.
    expect(onViewInColumn).toHaveBeenCalledWith({
      beadId: STRUCTURAL.id,
      projectId: "p1",
      isEpic: true,
    });
  });

  // THE MIRROR, and it is the assertion that catches a rung hard-coded to `true` — which would
  // typecheck, render identically, and write every task into the epic key.
  it("hands the link isEpic:false for a TASK", () => {
    const onViewInColumn = vi.fn(() => true);
    openCard(TASK.id, ctx(ALL, { onViewInColumn }));
    fireEvent.click(inColumn()!);
    expect(onViewInColumn).toHaveBeenCalledWith({
      beadId: TASK.id,
      projectId: "p1",
      isEpic: false,
    });
  });
});

// ── 3. THE TASK RUNG — THE FOUNDER'S SECOND ASK ─────────────────────────────────────────────────
//
// *"Be able to see what actual active building is being done against any given task."*
//
// Everything here is about the DIFFERENCE between the two rungs, because that difference is
// invisible on screen: both links look identical and both narrow the column. What separates them is
// WHICH STORE KEY the click writes, and getting that backwards has two distinct visible costs —
// a task written into the epic key would blow away the epic card the reader has open, and an epic
// written into the child key would be swallowed the moment the child is cleared.
describe("viewInColumn — a TASK narrows one rung further, and leaves the epic alone", () => {
  function realHost(id: string) {
    render(
      <BeadPillHost>
        <Markdown text={`see ${id}`} />
      </BeadPillHost>,
    );
    fireEvent.click(screen.getAllByTestId("concierge-bead-pill")[0]!);
  }

  it("opening a TASK writes the CHILD rung, not the epic one", () => {
    realHost(TASK.id);
    fireEvent.click(inColumn()!);
    expect(useUiStore.getState().beadFocusBySide.right).toBe(TASK.id);
    expect(useUiStore.getState().epicFocusBySide.right).toBeNull();
  });

  it("opening an EPIC still writes the epic rung", () => {
    realHost(DECLARED.id);
    fireEvent.click(inColumn()!);
    expect(useUiStore.getState().epicFocusBySide.right).toBe(DECLARED.id);
  });

  // ══ THE GOAL'S OWN WORDING: "WITHOUT CLOSING THE OPEN EPIC CARD" ══════════════════════════════
  // The epics column decides which card is open from `epicFocusBySide` alone. Writing a TASK into
  // that key is the bug this pins: the open epic card would snap shut under the reader, because no
  // epic matches a task id. Asserted on the key the column actually reads, not on a rendered card,
  // so it holds regardless of which column happens to be mounted.
  it("leaves an OPEN EPIC's card open — the epic key is untouched by a task click", () => {
    useUiStore.getState().openEpicFocus("right", STRUCTURAL.id);
    realHost(TASK.id);
    fireEvent.click(inColumn()!);
    expect(useUiStore.getState().epicFocusBySide.right).toBe(STRUCTURAL.id);
    // …and the column is nonetheless narrowed to the TASK, because the child rung wins.
    expect(focusedBeadIdForSide(useUiStore.getState(), "right")).toBe(TASK.id);
  });

  // RULE 2, from the reader's side: clearing the task hands the column back to the epic it was
  // drilled into, rather than to everything. That is what makes it a drill-DOWN.
  it("clearing the task returns the column to the epic underneath", () => {
    useUiStore.getState().openEpicFocus("right", STRUCTURAL.id);
    realHost(TASK.id);
    fireEvent.click(inColumn()!);
    useUiStore.getState().setBeadFocus("right", null);
    expect(focusedBeadIdForSide(useUiStore.getState(), "right")).toBe(STRUCTURAL.id);
  });

  // IDEMPOTENT, like its epic sibling. Wired to the toggling `setBeadFocus`, this second press
  // would hand the column back to the epic — which is the link undoing itself.
  it("stays on the task when Open is pressed TWICE", () => {
    realHost(TASK.id);
    fireEvent.click(inColumn()!);
    fireEvent.click(inColumn()!);
    expect(useUiStore.getState().beadFocusBySide.right).toBe(TASK.id);
  });

  it("puts the side into Build, so the narrowing is visible", () => {
    useUiStore.setState({ workModeBySide: { left: "build", right: "plan" } } as never);
    realHost(TASK.id);
    fireEvent.click(inColumn()!);
    expect(useUiStore.getState().workModeBySide.right).toBe("build");
  });
});
