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
