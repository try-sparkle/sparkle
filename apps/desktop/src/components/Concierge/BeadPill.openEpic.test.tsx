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
import { useUiStore } from "../../stores/uiStore";
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
/** A plain task — no children, not declared. Must get NO Open group, and must KEEP the standalone
 *  "View on board" button it had before any of this. */
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
  } as never);
  useUiStore.setState({
    epicFocusBySide: { left: null, right: null },
    workModeBySide: { left: "build", right: "build" },
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
const standaloneBoard = () => screen.queryByTestId("concierge-bead-card-view-on-board");

// ── 1. WHO GETS THE PAIR ────────────────────────────────────────────────────────────────────────

describe("Open links — only an epic, and epic means MEMBERSHIP not type", () => {
  it("a declared epic gets both links", () => {
    openCard(DECLARED.id);
    expect(inColumn()).not.toBeNull();
    expect(onBoard()).not.toBeNull();
  });

  // THE ROW A LOCAL `bead.type === "epic"` GATE FAILS. This bead was never declared an epic; it is
  // one because `` points at it. `isEpicIndexed` is the only check that sees that, and
  // it is why `scripts/lib/epic-membership-guard.sh` forbids a second definition.
  it("a STRUCTURAL epic — children but no epic type — gets both links", () => {
    openCard(STRUCTURAL.id);
    expect(inColumn()).not.toBeNull();
    expect(onBoard()).not.toBeNull();
  });

  it("a plain task gets NO Open group", () => {
    openCard(TASK.id);
    expect(inColumn()).toBeNull();
    expect(onBoard()).toBeNull();
  });

  // THE OTHER HALF OF THE PREVIOUS ROW, and it is a separate fact: absence of the new group would
  // also be satisfied by the card having lost its board affordance ENTIRELY. A task must still be
  // able to reach the board exactly as it could before this feature existed.
  it("a plain task KEEPS the standalone View on board button", () => {
    openCard(TASK.id);
    expect(standaloneBoard()).not.toBeNull();
  });

  // …and the mirror: on an epic the standalone button must STAND DOWN, or "on board" appears twice
  // on one card doing one thing. This is the assertion that pins the hand-off between the two.
  it("an epic does NOT also render the standalone button — no duplicate board control", () => {
    openCard(DECLARED.id);
    expect(standaloneBoard()).toBeNull();
    expect(onBoard()).not.toBeNull();
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
    expect(onViewInColumn).toHaveBeenCalledWith({ beadId: STRUCTURAL.id, projectId: "p1" });
  });
});
