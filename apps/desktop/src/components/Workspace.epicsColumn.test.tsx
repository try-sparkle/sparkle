// @vitest-environment jsdom
//
// DOES THE EPICS COLUMN ACTUALLY APPEAR, AND ON THE RIGHT SIDE OF THE BUILD COLUMN?
//
// `engine/columnResize.test.ts` proves the ARITHMETIC — where the nine rects land. It cannot prove
// anything mounts. This file proves the DOM the model assumes, and the two are both necessary and
// neither is sufficient: the geometry model would happily lay out a column that no component ever
// renders, and a render test in jsdom cannot measure a pixel.
//
// ── HOW MIRRORING IS ASSERTED WITHOUT A LAYOUT ENGINE ──────────────────────────────────────────
//
// jsdom has no layout: `getBoundingClientRect` is 0 everywhere and `flex-direction` is never
// applied, so "epics paints nearest the concierge" cannot be measured here. It CAN be derived, and
// from exactly the two facts that determine it in the browser:
//
//   1. the DOM order of `.paircols`'s children, and
//   2. that box's own `flexDirection` — `row-reverse` on the left pair, `row` on the right.
//
// So `paintedOrder()` below reads both and reverses when the flow does. That is not a restatement
// of the component's code — it is the CSS rule the browser applies, written out — and it is what
// makes one insertion (epics as the FIRST child) provably produce a mirrored row.
//
// BOTH PAIRS ARE MOUNTED IN EVERY MIRRORING CASE. One side alone is half the evidence, and a
// column asserted absent from a pair that was never rendered proves nothing at all (bead
// `sparkle-foqoe`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    setTitle: () => Promise.resolve(),
  }),
  getAllWindows: () => Promise.resolve([{}]),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../windowContext", async () => {
  const { useProjectStore } = await import("../stores/projectStore");
  return {
    useCurrentProjectId: () => useProjectStore((s) => s.selectedProjectId),
    useIsMainWindow: () => false,
    useCurrentWindowLabel: () => "main",
  };
});
vi.mock("../services/orchestrationListener", () => ({
  startOrchestrationListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/controlListener", () => ({
  startControlListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/crossWindowSync", () => ({ subscribeToCrossWindowSync: () => () => {} }));
vi.mock("../services/cloudAgents/startup", () => ({
  reattachProjectOnOpen: async () => [] as string[],
}));
// The `sparkleAgent` mock below SPREADS THE ORIGINAL rather than replacing it — the same shape
// `Workspace.cockpit.test.tsx` uses, and for a reason worth keeping: a full-replacement mock breaks
// the moment the module gains an export some unrelated transitive import needs. That is not
// hypothetical, it is why this line changed — `SPARKLE_AGENT_ID` arrived on main and
// `conciergeTools/terminal.ts` reads it at module scope, so a replacement mock made this whole file
// fail to LOAD (0 tests collected) while the suite still reported "no tests failed".
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} />,
}));
// THE STUB CARRIES THE REAL MARKER, keyed by the side it was handed — otherwise every build-column
// case here would be vacuous (a press would resolve to no column and the "do nothing" branch would
// make it pass for the wrong reason). That the REAL column emits this attribute is asserted in
// `AgentSidebar.pullTabs.test.tsx`; what this file pins is the routing that reads it.
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: ({ slotSide }: { slotSide?: "left" | "right" }) => (
    <div data-testid={`sidebar-${slotSide ?? "right"}`} data-zoom-column={`build-${slotSide ?? "right"}`} />
  ),
}));
// THE STUB PUBLISHES THE WIDTH IT WAS HANDED, and that is the whole point of it. A stub that
// ignored `width` — like the cockpit suite's, which renders a bare div — would make every
// assertion below vacuous: the drag could write into a prop nobody reads and the test would still
// be green, which is the exact defect class this file exists to catch.
vi.mock("./ConciergeHost", () => ({
  ConciergeHost: ({ width }: { width?: number }) => (
    <div data-testid="concierge" data-width={String(width)} style={{ width }} />
  ),
}));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({ BoardView: () => null }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));

import { Workspace } from "./Workspace";
// ONLY THE VARIABLE NAME. The geometry helpers were imported here to run the app's rendered numbers
// through `cockpitGeometry`, which turned out to prove nothing: the model's concierge centre reduces
// to `windowWidth / 2` algebraically for every input, so restating it at the app level was a
// pass-by-construction check (roborev 56086). The arithmetic lives in `engine/columnResize.test.ts`;
// what this file pins is the DOM structure that model assumes — see `assertRowStructure`.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import { useBeadsStore } from "../stores/beadsStore";
import { bucketBeads, type Bead } from "../services/beads";
import { newEpicGoal } from "../engine/epicGoal";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[]): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: agents[0]!.id, agents,
  };
}

beforeEach(() => {
  localStorage.clear();
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", [mkAgent("a1")])],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null, workModeBySide: { left: "build", right: "build" }, pinnedProjectId: null, openProjectIds: null,
    pairAssignment: {}, leftProjectId: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
  localStorage.clear();
});


/** Open the left pair, so BOTH halves of the row exist. */
function twoPairs() {
  useProjectStore.setState({
    projects: [
      mkProject("p1", "Alpha", [mkAgent("a1")]),
      mkProject("p2", "Beta", [mkAgent("a2")]),
    ],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1", "a2"], status: {} } as never);
  useUiStore.setState({ pairAssignment: { p2: "left" }, openProjectIds: ["p1", "p2"] } as never);
}



// ── FIXTURE ───────────────────────────────────────────────────────────────────────────────────
function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", labels: [], ...over } as Bead;
}
/** An epic with one child, so at least one ladder row has something to render. */
const BEADS: Bead[] = [bead("ep-1"), bead("ep-1.a", { status: "in_progress" })];

function seedBeads() {
  useBeadsStore.setState({
    byProject: {
      p1: { beads: BEADS, board: bucketBeads(BEADS), polledAt: 0 },
      p2: { beads: BEADS, board: bucketBeads(BEADS), polledAt: 0 },
    },
    error: {},
  } as never);
}

/**
 * The order these children PAINT in, derived from the two facts that decide it in a browser: DOM
 * order, and the box's own flow direction. jsdom applies neither, so this is the CSS rule written
 * out rather than a reading of the layout — see this file's header.
 */
function paintedOrder(side: "left" | "right"): string[] {
  const box = screen.getByTestId(`pair-cols-${side}`);
  const kids = Array.from(box.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.testid !== undefined,
  );
  const names = kids.map((el) => el.dataset.testid!);
  // The inline style the component sets; `row-reverse` reverses the visual order of flex ITEMS.
  const reversed = (box as HTMLElement).style.flexDirection === "row-reverse";
  return reversed ? [...names].reverse() : names;
}

describe("the epics column is mounted between the concierge and the build column", () => {
  beforeEach(() => {
    twoPairs();
    seedBeads();
  });

  it("renders ONE epics column per pair, and only where a pair exists", () => {
    render(<Workspace />);
    const cols = screen.queryAllByTestId("epics-column");
    expect(cols.map((c) => c.getAttribute("data-side")).sort()).toEqual(["left", "right"]);
  });

  it("does NOT render a left epics column when there is no left pair", () => {
    // The founder's requirement (5): the column "would be showing if I have any projects open on
    // the left side". It falls out of `pairCountFor()` — the whole `Pair` is gated on it — rather
    // than from anything this column does, and that is worth pinning because it means the column
    // can never appear beside a half that is not there.
    useUiStore.setState({ pairAssignment: {}, openProjectIds: ["p1"] } as never);
    render(<Workspace />);
    const cols = screen.queryAllByTestId("epics-column");
    expect(cols.map((c) => c.getAttribute("data-side"))).toEqual(["right"]);
  });

  it("paints INBOARD of the build column on BOTH sides — the mirror, in one assertion", () => {
    // THE CLAIM THE FOUNDER MADE ("mirrored left and right exactly"), and both pairs are mounted in
    // this single call because one direction alone is half the evidence. The right pair reads
    // outward from the concierge; the left pair reads outward from it in the other direction, which
    // is why its painted order is the reverse.
    render(<Workspace />);
    // Right pair: concierge is to its LEFT, so the row reads epics, build, terminal outward.
    expect(paintedOrder("right")).toEqual([
      "epics-column",
      "sidebar-right",
      "terminal-stage",
    ]);
    // Left pair: concierge is to its RIGHT, so the same three read terminal, build, epics.
    expect(paintedOrder("left")).toEqual([
      "terminal-stage-left",
      "sidebar-left",
      "epics-column",
    ]);
  });

  it("carries its own draggable seam on each side", () => {
    // Requirement (2), "its own draggable seam". A column with no seam is a fixed-width panel, and
    // the founder asked for a column.
    render(<Workspace />);
    expect(screen.queryByTestId("epics-pull-tab-left")).not.toBeNull();
    expect(screen.queryByTestId("epics-pull-tab-right")).not.toBeNull();
  });

  it("puts that seam on the BUILD-facing edge, never the one the concierge's rail already owns", () => {
    // THE BUG THIS PINS, found by photographing the running app rather than by a test. The first
    // version anchored the tab to the concierge-facing edge, which stacks TWO drag controls a few
    // pixels apart on one boundary — the row rail that moves the concierge, and this tab that moves
    // Epics — competing for the same press. It also parked the grip on top of the first ladder
    // row's chevron.
    //
    // Asserted as the anchoring EDGE rather than by measuring, because jsdom has no layout. The
    // wrapper is `position: absolute` with exactly one of `left`/`right` set to 0, and which one it
    // is IS the placement.
    //
    // BOTH SIDES IN ONE CALL: the row is mirrored, so the correct edge is the opposite physical side
    // on each pair. Checking one alone passes for a rule that hard-codes an edge instead of deriving
    // it, which is the exact defect being fixed.
    render(<Workspace />);
    const wrapperOf = (sideName: "left" | "right") =>
      screen.getByTestId(`epics-pull-tab-${sideName}`).closest("div[style*='absolute']") as
        | HTMLElement
        | null;

    // Right pair: Build is to our right, so the free edge is the right one.
    const right = wrapperOf("right");
    expect(right).not.toBeNull();
    expect(right!.style.right).toBe("0px");
    expect(right!.style.left).toBe("");

    // Left pair: `row-reverse` puts Build to our left, so the free edge mirrors.
    const left = wrapperOf("left");
    expect(left).not.toBeNull();
    expect(left!.style.left).toBe("0px");
    expect(left!.style.right).toBe("");
  });

  it("still MOUNTS with beads switched off, and says why instead of spinning forever", () => {
    // TWO CLAIMS, and the first is the one a bare "shows a message" test would miss. The column has
    // to keep its box: it owns a stored width and a seam, and unmounting it would move every other
    // column in the row the moment a setting changed. So the assertion is that the column is STILL
    // THERE and its copy changed — not that it disappeared.
    //
    // The second: without the gate this sits on "Loading epics…" forever, because with beads off no
    // snapshot is coming. A spinner for a thing that is not coming reads as a broken feature rather
    // than as a setting the user turned off.
    // THE STORE IS CLEARED, and that is what gives this case its power. Seeded, a snapshot exists
    // and the "Loading epics…" branch is unreachable — so asserting its absence would be vacuous
    // and would pass against the ungated code. (Verified: mutating the gate left the first draft of
    // this test green.) With beads off there is no poll and therefore never a snapshot, which is
    // precisely the state a real install lands in.
    useBeadsStore.setState({ byProject: {}, error: {} } as never);
    useSettingsStore.setState({ beadsEnabled: false } as never);
    render(<Workspace />);
    expect(screen.queryAllByTestId("epics-column")).toHaveLength(2);
    expect(document.body.textContent).toContain("Beads are switched off");
    expect(document.body.textContent).not.toContain("Loading epics");
  });

  it("hides a STALE ladder when beads are toggled off mid-session, not just at launch", () => {
    // THE COMMON BEADS-OFF STATE, and the one the case above cannot reach. Nothing clears
    // `byProject` when the setting is flipped: `setToolEnabled` only moves the flag, `beadsStore`
    // has no settings subscription, and the snapshot-drop branch only runs if a refresh is actually
    // invoked — which stops happening the moment every consumer's poll is gated. So the realistic
    // state is a STALE SNAPSHOT still sitting in the store.
    //
    // Without this case the `beadsEnabled &&` on the ladder itself is unverified: delete it and the
    // suite stays green while the UI paints "Beads are switched off" directly above a full stale
    // ladder. The store is deliberately NOT cleared here — that is the whole point.
    seedBeads();
    useSettingsStore.setState({ beadsEnabled: false } as never);
    render(<Workspace />);
    expect(document.body.textContent).toContain("Beads are switched off");
    // The ladder is GONE, not merely unmentioned — asserted on the stage rows themselves, which
    // exist only when the ladder renders.
    expect(screen.queryAllByTestId("epics-stage-backlog")).toHaveLength(0);
    expect(screen.queryAllByTestId("epics-stage-inProgress")).toHaveLength(0);
  });

  it("says a READ FAILED rather than spinning, which is the other state that never resolves", () => {
    // `refresh` writes `error[projectId]` and leaves `byProject[projectId]` undefined when bd is
    // missing or a read fails. Without reading that, this column sits on "Loading epics…" forever —
    // the same defect as the beads-off one, reached by a different cause.
    useBeadsStore.setState({ byProject: {}, error: { p1: "bd: command not found" } } as never);
    render(<Workspace />);
    const erroring = screen
      .getAllByTestId("epics-column")
      .find((c) => c.getAttribute("data-side") === "right")!;
    expect(erroring.textContent).toContain("Couldn’t read epics");
    expect(erroring.textContent).toContain("bd: command not found");
    // …AND NOT ALSO "LOADING", which is the second gate this pins. Without the `!readError`
    // conjunct the column paints BOTH notes stacked — it failed, and it is still loading — the exact
    // contradictory copy the branch was added to remove.
    //
    // SCOPED TO THE ERRORING COLUMN, not the document: `twoPairs()` mounts a second project that has
    // no error and legitimately still says "Loading epics…", so a document-wide absence check would
    // fail for a reason that has nothing to do with this gate.
    expect(erroring.textContent).not.toContain("Loading epics");
  });

  it("GROWS the column when dragged OUTBOARD from the concierge, on both sides", () => {
    // THE OTHER HALF OF THE SEAM FIX, and it had no coverage at all. Moving the tab flipped TWO
    // coupled things — the anchoring edge and `grows` — and the edge case above pins only the first.
    // Revert `grows` alone and the suite stays green while every epics drag INVERTS: `ColumnPullTab`
    // commits `origin.width - dx` when it believes the column is on the other side of the boundary,
    // so pulling the seam outward would shrink the column. That is this repo's "one fix, N sites"
    // shape — the edge site guarded, the direction site not.
    //
    // BOTH SIDES IN ONE CASE. Outboard is +x on the right pair and -x on the left, so one direction
    // alone passes for a rule that hard-codes `grows` instead of deriving it from the side.
    render(<Workspace />);

    const widthOfCol = (sideName: "left" | "right") =>
      Number(
        screen
          .getAllByTestId("epics-column")
          .find((c) => c.getAttribute("data-side") === sideName)!
          .getAttribute("data-width"),
      );

    const drag = (sideName: "left" | "right", dx: number) => {
      const dots = screen.getByTestId(`epics-pull-tab-${sideName}-dots`);
      fireEvent.mouseEnter(screen.getByTestId(`epics-pull-tab-${sideName}`));
      fireEvent.pointerDown(dots, { pointerId: 1, button: 0, buttons: 1, clientX: 800 });
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 800 + dx });
      fireEvent.pointerUp(window, { pointerId: 1 });
    };

    // RIGHT pair: the concierge is to its left, so outboard is to the RIGHT (+x).
    const beforeRight = widthOfCol("right");
    drag("right", 40);
    expect(widthOfCol("right")).toBeGreaterThan(beforeRight);

    // LEFT pair: the concierge is to its right, so outboard is to the LEFT (-x). Same physical
    // gesture — away from the concierge — mirrored, which is what "mirrored exactly" means here.
    const beforeLeft = widthOfCol("left");
    drag("left", -40);
    expect(widthOfCol("left")).toBeGreaterThan(beforeLeft);
  });

  it("is COVERED by that pair's Plan board, and only on that pair", () => {
    // Requirement (4): "When I'm on the Plan board I should not see the EPICS column." `covered` is
    // what makes it UNREACHABLE rather than merely unpainted — without it Tab walks controls nobody
    // can see and AT announces a column that is not on screen.
    //
    // ASSERTED ON BOTH PAIRS IN ONE CALL. Checking only the covered side would pass for a rule that
    // covered every epics column in the window whenever either pair opened its board.
    useUiStore.setState({ workModeBySide: { left: "build", right: "plan" } } as never);
    render(<Workspace />);
    const bySide = Object.fromEntries(
      screen.queryAllByTestId("epics-column").map((c) => [c.getAttribute("data-side"), c]),
    );
    expect(bySide.right!.getAttribute("data-covered")).toBe("true");
    expect(bySide.left!.getAttribute("data-covered")).toBe("false");
  });
});

// ══ THE CARD OPENS IN PLACE, UNDER ITS OWN ROW ═════════════════════════════════════════════════
//
// The founder: "when I click on an Epic row... it would open that Epic card below that row and it
// would push the rest of the epics down."
//
// jsdom does not lay out, so "below" and "pushes down" cannot be measured (see this file's header).
// They are asserted as the two facts that DECIDE them for an in-flow element: the card is a SIBLING
// of the row, and it sits BETWEEN that row and the next one. An implementation that portalled the
// card, or absolutely positioned it, or appended it at the end of the list, fails all three.
describe("clicking an epic opens its card inline", () => {
  /** Three epics in ONE stage group, so "between this row and the next" is a real claim. */
  const MANY: Bead[] = [
    bead("ep-1"),
    bead("ep-1.a", { status: "in_progress" }),
    bead("ep-2"),
    bead("ep-2.a", { status: "in_progress" }),
    bead("ep-3"),
    bead("ep-3.a", { status: "in_progress" }),
  ];
  function seedMany() {
    useBeadsStore.setState({
      byProject: {
        p1: { beads: MANY, board: bucketBeads(MANY), polledAt: 0 },
        p2: { beads: MANY, board: bucketBeads(MANY), polledAt: 0 },
      },
      error: {},
    } as never);
  }
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-epic-id]'));
  const rowFor = (id: string) => document.querySelector<HTMLElement>(`[data-epic-id="${id}"]`);

  beforeEach(seedMany);

  it("puts the card BETWEEN its own row and the next one, as a sibling", () => {
    render(<Workspace />);
    const before = rows().length;
    expect(before).toBeGreaterThanOrEqual(3); // the premise: several rows to be pushed down

    fireEvent.click(rowFor("ep-2")!);

    const card = document.querySelector<HTMLElement>('[data-testid="epic-inline-card"]')!;
    expect(card).toBeTruthy();
    // A SIBLING of the row — not a descendant of it (EpicRow is a <button>, which may not contain
    // the buttons this card carries) and not portalled to the body.
    expect(card.parentElement).toBe(rowFor("ep-2")!.parentElement);
    // ...and immediately AFTER it, which is what "below that row" means in normal flow.
    expect(rowFor("ep-2")!.nextElementSibling).toBe(card);
    // The rows below are still there, now beneath the card — "it would push the rest down".
    expect(card.compareDocumentPosition(rowFor("ep-3")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rows().length).toBe(before);
  });

  it("opens exactly ONE card, and it belongs to the row that was clicked", () => {
    // Every candidate row is mounted, which is what gives the absence claim any force: a card
    // missing from a row that was never rendered proves nothing (AGENTS.md, the "N targets" case).
    render(<Workspace />);
    fireEvent.click(rowFor("ep-2")!);

    const cards = document.querySelectorAll('[data-testid="epic-inline-card"]');
    expect(cards.length).toBe(1);
    expect(rowFor("ep-1")!.nextElementSibling).not.toBe(cards[0]);
    expect(rowFor("ep-2")!.nextElementSibling).toBe(cards[0]);
  });

  // THE TWO THINGS THE FOUNDER ASKED THE CARD TO CARRY. "The card rendered" does not imply either:
  // both are OPTIONAL props on `BeadCard` that the concierge's own wrapper omits for comments, so a
  // card wired without them looks identical from the outside and is missing exactly what was asked
  // for. Asserted by their own testids rather than by text, so a label change does not read as a
  // missing feature.
  it("carries Build It and a comment box", () => {
    render(<Workspace />);
    fireEvent.click(rowFor("ep-2")!);

    const card = document.querySelector<HTMLElement>('[data-testid="epic-inline-card"]')!;
    // "I should have a build it button as well to move it into a building state."
    expect(card.querySelector('[data-testid="epics-bead-card-build-it"]')).toBeTruthy();
    // "I want to make sure that I'll be able to make comments on that epic."
    expect(card.querySelector('[data-testid="epics-bead-card-comments-input"]')).toBeTruthy();
  });

  it("closes on a second click of the same row", () => {
    render(<Workspace />);
    fireEvent.click(rowFor("ep-2")!);
    expect(document.querySelector('[data-testid="epic-inline-card"]')).toBeTruthy();

    fireEvent.click(rowFor("ep-2")!);

    // `setEpicFocus` toggles, so the row that opened it closes it — and the build column's
    // narrowing lifts with it, because they are the same piece of state.
    expect(document.querySelector('[data-testid="epic-inline-card"]')).toBeNull();
    expect(useUiStore.getState().epicFocusBySide.right).toBeNull();
  });
});

// ══ A GOAL ON THE EPIC MUST NOT CHANGE WHAT A CLICK DOES ═══════════════════════════════════════
//
// The bug the founder hit live (bead `sparkle-huw924.3`, transcript 01:59-02:33): "looking at an
// epic we'll open the card, which is good. But if I have given it a goal, it seems like it has a
// different behavior… instead of opening up the card, it opens up the goal."
//
// The mechanism: `EpicRow` is one `<button>`, and the goal painted INSIDE it as a `role="button"`
// span whose handler called `stopPropagation()` and opened the goal editor. With a goal, that span
// took `flex: 1 1 auto` and covered most of the row, so most clicks never reached the row. With no
// goal it was only the words "Set a goal" — a small target — so the same defect was there but
// rarely hit. Same gesture, different result purely from what data the epic carried.
//
// The fix the founder chose when asked ("No goal should show in the row at all"), which the
// transcript states three times — 02:33 "let's not have the goals showing on the build rows",
// 04:29 "we're not gonna show the goal in the row… we should, however, be showing the goal in the
// epic when it's opened up", 14:13 "we're not gonna show 'set a goal' on here" — is to take the
// goal off the row entirely. The row is then one undivided click target again.
//
// ── WHY THE ASSERTION IS "EVERY DESCENDANT", NOT "THE ROW" ────────────────────────────────────
// `fireEvent.click(row)` dispatches on the `<button>` itself, so it opens the card whether or not
// anything inside the row swallows clicks — it passed throughout the bug and proves nothing here.
// A person clicks PIXELS, and every pixel of that row belongs to one of its children. So each
// descendant is clicked in turn and judged on its own. That is what reds on the old code (the goal
// span is one of them) and what keeps reding if any future child re-swallows the row's click.
//
// The row's other children are read-only by design and must stay that way for this to hold:
// `BeadPriorityChip` is documented as "no title/click: it is a readout". If item 7 of the epic
// (a clickable STAGE name) ever lands ON THE ROW rather than on the card, this test is the place
// that decides what a click on it means — that is the point of it, not a reason to weaken it.
describe("an epic that HAS a goal opens its card, exactly like one that does not", () => {
  const GOAL = "Land the epics cockpit the founder asked for";
  // BOTH CASES MOUNTED AT ONCE, in one stage group. Testing the goal-bearing epic alone could not
  // tell "the goal broke the click" apart from "clicks are broken for every epic", and testing the
  // plain one alone is the branch that already worked (AGENTS.md, the N-targets rule).
  const PAIR: Bead[] = [
    bead("ep-goal"),
    bead("ep-goal.a", { status: "in_progress" }),
    bead("ep-plain"),
    bead("ep-plain.a", { status: "in_progress" }),
  ];
  const rowFor = (id: string) => document.querySelector<HTMLElement>(`[data-epic-id="${id}"]`);
  const cardUnder = (id: string) => {
    const next = rowFor(id)?.nextElementSibling;
    return next instanceof HTMLElement && next.dataset.testid === "epic-inline-card" ? next : null;
  };

  beforeEach(() => {
    useBeadsStore.setState({
      byProject: {
        p1: { beads: PAIR, board: bucketBeads(PAIR), polledAt: 0 },
        p2: { beads: PAIR, board: bucketBeads(PAIR), polledAt: 0 },
      },
      error: {},
    } as never);
    // THE GOAL IS BUILT BY THE REAL CONSTRUCTOR, not hand-assembled. A literal shaped to whatever
    // the reader happens to check is the fixture that already carries the field under test, and it
    // makes the premise pass for the wrong reason (AGENTS.md).
    useProjectStore.setState({
      projects: [
        { ...mkProject("p1", "Alpha", [mkAgent("a1")]), epicGoals: { "ep-goal": newEpicGoal(GOAL, 0, "human") } },
      ],
      selectedProjectId: "p1",
    } as never);
  });

  // THE PREMISE. Without this, every assertion below passes for an epic that simply has no goal —
  // which is the exact shape of a vacuous test, since "no goal is shown" is trivially true then.
  it("really does hold a goal for the one epic, and not for the other", () => {
    const p = useProjectStore.getState().projects.find((x) => x.id === "p1")!;
    expect(p.epicGoals?.["ep-goal"]?.text).toBe(GOAL);
    expect(p.epicGoals?.["ep-plain"]).toBeUndefined();
  });

  it("opens the card for the epic WITH a goal and the one WITHOUT — same gesture, same result", () => {
    render(<Workspace />);
    for (const id of ["ep-goal", "ep-plain"]) {
      fireEvent.click(rowFor(id)!);
      expect(cardUnder(id)).toBeTruthy();
      fireEvent.click(rowFor(id)!); // toggles shut, so each epic is judged on its own
      expect(cardUnder(id)).toBeNull();
    }
  });

  it("shows NO goal anywhere in either row — not the text, not the 'Set a goal' placeholder", () => {
    render(<Workspace />);
    for (const id of ["ep-goal", "ep-plain"]) {
      const row = rowFor(id)!;
      expect(row.querySelector('[data-testid="epic-goal-row"]')).toBeNull();
      expect(row.querySelector('[data-testid="epic-goal"]')).toBeNull();
      expect(row.querySelector('[data-testid="epic-goal-empty"]')).toBeNull();
      expect(row.textContent).not.toContain(GOAL);
      expect(row.textContent).not.toContain("Set a goal");
    }
    // ...and the row still says what it is for. An empty row would satisfy every line above.
    expect(rowFor("ep-goal")!.textContent).toContain("ep-goal");
  });

  // ── ITEM 15 — THE COUNT SLOT BECOMES THE CLOSE X WHILE THE CARD IS OPEN ───────────────────────

  const closeX = (id: string) => rowFor(id)!.querySelector('[data-testid="epic-row-close"]');
  const ratio = (id: string) => rowFor(id)!.querySelector('[data-testid="epic-row-children"]');

  it("swaps the ratio for an X on the OPEN row, while a closed row beside it keeps its ratio", () => {
    // BOTH ROWS MOUNTED, and that is what gives this power. Asserting "the X is here" on a single
    // open row would also pass for an X rendered unconditionally on every row; asserting "no X" on
    // a single closed row would pass for an X that never renders at all. Only the pair pins the
    // substitution to the SELECTED row (`sparkle-foqoe`).
    render(<Workspace />);

    expect(ratio("ep-goal")).toBeTruthy();
    expect(closeX("ep-goal")).toBeNull();

    fireEvent.click(rowFor("ep-goal")!);
    expect(cardUnder("ep-goal")).toBeTruthy();

    // The open one traded its ratio for the X...
    expect(closeX("ep-goal")).toBeTruthy();
    expect(ratio("ep-goal")).toBeNull();
    // ...and the CLOSED one next to it did not.
    expect(closeX("ep-plain")).toBeNull();
    expect(ratio("ep-plain")).toBeTruthy();

    // Closing puts the ratio back — the substitution is reversible, not a one-way replacement.
    fireEvent.click(rowFor("ep-goal")!);
    expect(cardUnder("ep-goal")).toBeNull();
    expect(closeX("ep-goal")).toBeNull();
    expect(ratio("ep-goal")).toBeTruthy();
  });

  it("has exactly ONE close control, and it is the row's — not a second one on the card", () => {
    // ITEM 16: the chat button REPLACES the close button on the card, and item 15 moves the X up
    // into the row. Those are one change seen from two sides, and while the two halves sat in
    // separate PRs the tree briefly carried BOTH — a card X and a row X, one line apart.
    //
    // THE ASSERTION IS A COUNT, not "the card has no X". Asserting absence alone would also pass
    // for a card that failed to render at all, and for a row that never grew its X — so this opens
    // the card, proves the card really is there by finding content only it has, and only then
    // counts the close controls in the whole open row + card region.
    render(<Workspace />);
    fireEvent.click(rowFor("ep-goal")!);

    const card = cardUnder("ep-goal");
    expect(card).toBeTruthy();
    // The card is genuinely rendered — its id line is card-only content.
    expect(card!.querySelector('[data-testid="epics-bead-card-id"]')).toBeTruthy();

    expect(card!.querySelector('[data-testid="epics-bead-card-close"]')).toBeNull();
    expect(closeX("ep-goal")).toBeTruthy();
  });

  it("clicking the X CLOSES the card — it must not swallow the row's click", () => {
    // THE ASSERTION THAT MATTERS. The X is a readout with no handler of its own: the row underneath
    // is what closes. Make it a real nested <button> with stopPropagation — the shape that caused
    // `sparkle-huw924.3`, where the goal span ate the click meant for the row — and this reds,
    // because the click would never reach the row.
    render(<Workspace />);
    fireEvent.click(rowFor("ep-goal")!);
    const x = closeX("ep-goal");
    expect(x).toBeTruthy();

    fireEvent.click(x as HTMLElement);

    expect(cardUnder("ep-goal")).toBeNull();
  });

  it("opens the card wherever inside the row the click lands", () => {
    render(<Workspace />);
    for (const id of ["ep-goal", "ep-plain"]) {
      const parts = Array.from(rowFor(id)!.querySelectorAll<HTMLElement>("*"));
      expect(parts.length).toBeGreaterThan(0); // the premise: there are children to click
      for (const [i, part] of parts.entries()) {
        fireEvent.click(part);
        expect(cardUnder(id), `${id}: click on child #${i} <${part.tagName.toLowerCase()}> did not open the card`).toBeTruthy();
        fireEvent.click(rowFor(id)!);
        expect(cardUnder(id)).toBeNull();
      }
    }
  });
});

// ── THE CHILD RATIO COUNTS UP TO THE TOTAL ───────────────────────────────────────────────────────
//
// The founder read the old `{open}/{total}` as its own opposite: *"I'm not sure I understand what
// the '14/14' etc numbers mean exactly. […] I would make the assumption that if all of the children
// are done, then the epic itself is done but for example I see an epic called 'Productized Work Tree
// Workflow Book Ends' that has a 6/6 on it, and yet it is still in the 'being built' status so I
// don't understand why that's the case or how that could be possible."*
//
// `6/6` meant six STILL OPEN of six — nothing finished — which is exactly why it had not moved. His
// ruling: *"flip it so that it builds up to the total versus building down."*
describe("the epic row's child ratio counts COMPLETED work, not remaining work", () => {
  // THREE CHILDREN, DELIBERATELY UNEQUAL: two closed, one still open. A fixture where the two
  // numbers coincide (0 of 0, or n of n) is satisfied by BOTH directions of the fraction, which is
  // precisely how the old reading survived unnoticed — and `2/3` vs `1/3` cannot be confused.
  //
  // The open child is `in_progress` rather than `open` on purpose: bd's only terminal state is
  // `closed`, so work in flight must count as NOT done. A fixture using `open` for it would pass
  // for a rule that treated `in_progress` as finished.
  const MIXED: Bead[] = [
    bead("ep-ratio"),
    bead("ep-ratio.a", { status: "closed" }),
    bead("ep-ratio.b", { status: "closed" }),
    bead("ep-ratio.c", { status: "in_progress" }),
  ];
  const rowFor = (id: string) => document.querySelector<HTMLElement>(`[data-epic-id="${id}"]`);
  const ratioText = (id: string) =>
    rowFor(id)?.querySelector('[data-testid="epic-row-children"]')?.textContent?.trim() ?? null;

  beforeEach(() => {
    useBeadsStore.setState({
      byProject: { p1: { beads: MIXED, board: bucketBeads(MIXED), polledAt: 0 } },
      error: {},
    } as never);
    useProjectStore.setState({
      projects: [mkProject("p1", "Alpha", [mkAgent("a1")])],
      selectedProjectId: "p1",
    } as never);
  });

  it("renders DONE over total — 2/3, never the remaining-work 1/3", () => {
    render(<Workspace />);
    // Asserting the exact string BOTH ways round. `toBe("2/3")` alone would be satisfied by a
    // coincidence in some other fixture; naming the value it must NOT be pins this to the flip
    // itself, and is the assertion that goes red if the numerator ever counts down again.
    expect(ratioText("ep-ratio")).toBe("2/3");
    expect(ratioText("ep-ratio")).not.toBe("1/3");
  });

  it("reads 0/N while nothing has finished — the '6/6 but still building' case he hit", () => {
    // His actual confusion, reproduced: an epic with every child still open. Under the old reading
    // this rendered `3/3` and looked complete; it must now read `0/3` and look untouched, which is
    // the truth about it and the reason it has not moved off the build rung.
    const NONE: Bead[] = [
      bead("ep-none"),
      bead("ep-none.a", { status: "in_progress" }),
      bead("ep-none.b", { status: "open" }),
      bead("ep-none.c", { status: "in_progress" }),
    ];
    useBeadsStore.setState({
      byProject: { p1: { beads: NONE, board: bucketBeads(NONE), polledAt: 0 } },
      error: {},
    } as never);
    render(<Workspace />);
    expect(ratioText("ep-none")).toBe("0/3");
  });

  it("reads N/N once every child has closed", () => {
    // The far end of the same scale, and the one the founder's inference is about: an epic whose
    // children have ALL closed should read as fully done rather than as fully remaining.
    //
    // THE EPIC'S OWN BEAD IS `in_progress` ON PURPOSE, and it is what makes this assertable at all.
    // Left `open`, an epic whose children have all closed is rolled up to the DONE rung — which
    // `OPEN_BY_DEFAULT` deliberately leaves COLLAPSED, so the row is not in the DOM and the ratio
    // reads `null` rather than a number. That is correct product behaviour and a useless test.
    // `in_progress` with nobody bound puts it on the Build: Unstaffed rung, which IS open by
    // default — and it is also the more interesting row: an epic whose work is finished but whose
    // own bead nobody closed, which is precisely the stamped-not-derived class of bug this whole
    // change is about.
    const ALL: Bead[] = [
      bead("ep-all", { status: "in_progress" }),
      bead("ep-all.a", { status: "closed" }),
      bead("ep-all.b", { status: "closed" }),
    ];
    useBeadsStore.setState({
      byProject: { p1: { beads: ALL, board: bucketBeads(ALL), polledAt: 0 } },
      error: {},
    } as never);
    render(<Workspace />);
    expect(ratioText("ep-all")).toBe("2/2");
  });
});
