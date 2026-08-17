// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead, Board } from "../services/beads";
import type { AgentTab, Project } from "../types";

// Mock the beads store so no real `bd`/Tauri invoke happens. startPolling/stopPolling are spies;
// the snapshot is whatever `snapshot` holds when the component reads it (selector form).
const startPolling = vi.fn();
const stopPolling = vi.fn();
let snapshot: { beads: Bead[]; board: Board; loadedAt: number } | undefined;
let error: string | undefined;

function buildState() {
  return {
    byProject: { p1: snapshot } as Record<string, typeof snapshot>,
    loading: {} as Record<string, boolean>,
    error: { p1: error } as Record<string, string | undefined>,
    startPolling,
    stopPolling,
  };
}

vi.mock("../stores/beadsStore", () => {
  // Support both the hook form `useBeadsStore((s) => ...)` and `useBeadsStore.getState()`.
  const useBeadsStore = ((selector?: (s: ReturnType<typeof buildState>) => unknown) => {
    const state = buildState();
    return selector ? selector(state) : state;
  }) as unknown as { (sel?: unknown): unknown; getState: () => ReturnType<typeof buildState> };
  useBeadsStore.getState = () => buildState();
  return { useBeadsStore };
});

// `sendToBuildBlockedReason` is the PREFLIGHT every handoff below calls before it claims the bead
// (roborev 55139). It must be in the mock: an exhaustive factory like this one returns `undefined`
// for anything it omits, so a missing entry makes the guard throw and the handoff never runs —
// which is exactly how these four tests failed when it was added. `null` = "not blocked".
const blockedReasonMock = vi.fn<(p: string, e: string, m?: string) => string | null>(() => null);
vi.mock("../services/sendToBuild", () => ({
  sendToBuild: vi.fn(),
  // Forwards ALL args, so tests can assert the MODE each handler passes. The previous version
  // dropped them (`() => blockedReasonMock()`), which is why a call site that never passed "task"
  // went unnoticed while a unit test of the function itself passed (roborev 55145).
  sendToBuildBlockedReason: (...a: [string, string, string?]) => blockedReasonMock(...a),
}));

// ── Definable Done & Delivered (Unit 5) mocks ────────────────────────────────────────────────
// getConfig returns whatever `configState` holds; onConfigChanged is a no-op subscription. Tests
// set `configState` (via defineDone/defineDelivered) to drive the definitions the board reads.
import type { SparkleConfig, EffectiveConfig, StageCriterion } from "../services/config";

function emptyConfig(): SparkleConfig {
  return {
    workflow: {} as SparkleConfig["workflow"],
    workers: {} as SparkleConfig["workers"],
    ai: {} as SparkleConfig["ai"],
    roborev: {} as SparkleConfig["roborev"],
    freshness: {} as SparkleConfig["freshness"],
    capture: {} as SparkleConfig["capture"],
    done: { description: null, criteria: [] },
    delivered: {
      description: null,
      detected_method: null,
      confidence: null,
      confidence_note: null,
      learned: false,
      criteria: [],
    },
  };
}
let configState: SparkleConfig = emptyConfig();
const getConfig = vi.fn(
  async (..._a: unknown[]): Promise<EffectiveConfig> => ({ config: configState, warnings: [] }),
);
vi.mock("../services/config", () => ({
  getConfig: (...a: unknown[]) => getConfig(...a),
  onConfigChanged: vi.fn().mockResolvedValue(() => {}),
}));

const startDeliveryMonitor = vi.fn();
const stopDeliveryMonitor = vi.fn();
vi.mock("../services/deliveryMonitor", () => ({
  startDeliveryMonitor: (...a: unknown[]) => startDeliveryMonitor(...a),
  stopDeliveryMonitor: (...a: unknown[]) => stopDeliveryMonitor(...a),
}));

// The Define/Edit modal is exercised in its own suite; here we stub it to a marker so we can assert
// it opened with the right stageKey without pulling in Haiku/detector/config wiring.
vi.mock("./DefineStageModal", () => ({
  DefineStageModal: ({ stageKey, onClose }: { stageKey: string; onClose: () => void }) => (
    <div data-testid="define-modal">
      define-modal:{stageKey}
      <button onClick={onClose}>close-modal</button>
    </div>
  ),
}));

// Keep the real beads helpers (bucketBeads, childrenOf, labels) but stub the bd-write wrappers the
// Start button / badge chips call, so no Tauri invoke happens.
vi.mock("../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beads")>();
  return {
    ...actual,
    claimBead: vi.fn().mockResolvedValue(undefined),
    labelBead: vi.fn().mockResolvedValue(undefined),
    // The confirm-first "Mark as …" control drives these — stub so no Tauri/`bd` invoke happens.
    closeBead: vi.fn().mockResolvedValue(undefined),
    markBeadDelivered: vi.fn().mockResolvedValue(undefined),
  };
});

// Stub ONLY the two comment IPC wrappers the DetailOverlay now drives on open (read) and on submit
// (write), so opening a card triggers no real Tauri invoke. Everything else in the module (the error
// helpers `setBeadPriority` depends on) stays real via `importOriginal`.
const beadsDetailMock = vi.fn(async (..._a: unknown[]) => ({
  bead: {} as unknown,
  fullDescription: "",
  children: { beads: [], total: 0, omitted: 0, omittedIds: [], limit: 100 },
  dependencies: [],
  dependents: [],
  comments: [] as unknown[],
  linksTruncated: false,
}));
const beadsCommentMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../services/beadsCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beadsCommands")>();
  return {
    ...actual,
    beadsDetail: (...a: unknown[]) => beadsDetailMock(...a),
    beadsComment: (...a: unknown[]) => beadsCommentMock(...a),
  };
});

import { BoardView, boardScrollDelta } from "./BoardView";
import { sendToBuild } from "../services/sendToBuild";
import { claimBead, labelBead, closeBead, markBeadDelivered } from "../services/beads";
import { useCriteriaStore } from "../services/criteriaStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { NO_BOARD_FILTER } from "../services/boardFilters";
import { dismissibleSurfaceOpen, unbindsOnKey } from "../engine/cable";
import { useCableStore } from "../stores/cableStore";
import { waitFor } from "@testing-library/react";

/** Point the mocked config at a defined "Done" (a single criterion of the given kind). */
function defineDone(criterion: StageCriterion = { text: "Merged into origin/main", kind: "auto", signal: "merged_to_main" }) {
  configState.done = { description: "Merged into the remote main branch.", criteria: [criterion] };
}
/** Point the mocked config at a defined "Delivered". */
function defineDelivered(criterion: StageCriterion = { text: "Deployed to prod", kind: "manual", signal: null }) {
  configState.delivered = {
    description: "Shipped to production.",
    detected_method: "release_tag",
    confidence: "high",
    confidence_note: "Ships via GitHub Releases.",
    learned: false,
    criteria: [criterion],
  };
}

const project: Project = {
  id: "p1",
  name: "Demo",
  rootPath: "/tmp/demo",
  defaultBranch: "main",
  createdAt: "2026-01-01",
  agents: [],
  selectedAgentId: null,
};

function bead(partial: Partial<Bead> & { id: string; title: string }): Bead {
  return {
    description: "",
    status: "open",
    labels: [],
    parent: null,
    ...partial,
  };
}

const board: Board = {
  backlog: [
    bead({ id: "p1-a1", title: "Backlog one", description: "First backlog task description." }),
    bead({ id: "p1-a2", title: "Backlog two" }),
  ],
  blocked: [],
  inProgress: [bead({ id: "p1-b1", title: "Doing now", status: "in_progress" })],
  done: [bead({ id: "p1-c1", title: "Finished", status: "closed" })],
  delivered: [
    bead({ id: "p1-d1", title: "Delivered task", status: "closed", labels: ["delivered"] }),
  ],
  archived: [],
};

afterEach(() => {
  cleanup();
  snapshot = undefined;
  error = undefined;
  startPolling.mockClear();
  stopPolling.mockClear();
  vi.mocked(sendToBuild).mockClear();
  // Reset the Definable Done & Delivered state between tests.
  configState = emptyConfig();
  getConfig.mockClear();
  startDeliveryMonitor.mockClear();
  stopDeliveryMonitor.mockClear();
  vi.mocked(closeBead).mockClear();
  vi.mocked(markBeadDelivered).mockClear();
  // claimBead too: the at-capacity test asserts it was NOT called, which a leaked call from an
  // earlier test would silently defeat (or, worse, make pass only because of suite ordering).
  vi.mocked(claimBead).mockClear();
  // Reset the preflight globally, not per-describe: a test that sets it to "blocked" would
  // otherwise leak into every later handoff test and refuse handoffs they expect to succeed.
  blockedReasonMock.mockReset();
  blockedReasonMock.mockReturnValue(null);
  useCriteriaStore.setState({ ticks: {} });
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  beadsDetailMock.mockClear();
  beadsCommentMock.mockClear();
});

beforeEach(() => {
  snapshot = { beads: [], board, loadedAt: Date.now() };
  error = undefined;
  // SEED THE STORE. DetailOverlay reads `rootPath` from it, and every overlay handler claims only
  // `if (rootPath)`. Unseeded, `rootPath` is null, so `claimBead` is DEAD in these tests and every
  // `expect(claimBead).not.toHaveBeenCalled()` here passed vacuously — with the guard deleted, with
  // the guard moved after the claim, and before the guard existed at all (roborev 55152). Seeding is
  // what makes "refuses WITHOUT claiming" — the ordering this whole change is about — assertable.
  // NO `as never` here. This seed is the single object the claim assertions depend on, and
  // `as never` satisfies every setState overload — so if ProjectState's fields are renamed,
  // BoardView fails to compile and gets fixed while this seed compiles unchanged, silently reverts
  // rootPath to null, and quietly makes every claim assertion vacuous again (roborev 55155). Typed,
  // a rename breaks HERE too, which is the point.
  useProjectStore.setState({ projects: [project], selectedProjectId: project.id });
  // Self-verifying: if this ever stops taking effect, `rootPath` silently returns to null and every
  // claimBead assertion in this file quietly re-inerts with a GREEN suite. Fail loudly instead.
  if (useProjectStore.getState().projects[0]?.rootPath !== project.rootPath) {
    throw new Error("BoardView tests: project store seed did not take effect — claim assertions would be vacuous");
  }
});

describe("BoardView", () => {
  it("starts polling on mount and stops on unmount", () => {
    const { unmount } = render(<BoardView project={project} side="right" />);
    expect(startPolling).toHaveBeenCalledWith("p1", "/tmp/demo");
    unmount();
    expect(stopPolling).toHaveBeenCalledWith("p1");
  });

  it("renders the four columns with their cards bucketed correctly", () => {
    render(<BoardView project={project} side="right" />);
    // Column headers, addressed by lane so they cannot be confused with card text — the terminal
    // lane and the terminal STAGE badge are both "Shipped", deliberately (one vocabulary).
    expect(screen.getByTestId("lane-label-backlog").textContent).toContain("Backlog");
    expect(screen.getByTestId("lane-label-inProgress").textContent).toContain("Being built");
    expect(screen.getByTestId("lane-label-done").textContent).toContain("Done");
    expect(screen.getByTestId("lane-label-delivered").textContent).toContain("Shipped");
    // The count renders UNDER the title, inside the same lane stack.
    expect(screen.getByTestId("lane-count-backlog").textContent).toBe("2");
    // Cards land in the right buckets.
    expect(screen.getByText("Backlog one")).toBeTruthy();
    expect(screen.getByText("Backlog two")).toBeTruthy();
    expect(screen.getByText("Doing now")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getByText("Delivered task")).toBeTruthy();
    // Bead ids show on the cards.
    expect(screen.getByText("p1-a1")).toBeTruthy();
  });

  it("renders each card's unified progress stage label (mapped from bead status)", () => {
    render(<BoardView project={project} side="right" />);
    // short stage labels: open→Planned, in_progress→Unsaved, closed→Merged, delivered→Shipped.
    expect(screen.getAllByText("Planned").length).toBeGreaterThanOrEqual(2); // two backlog beads
    expect(screen.getByText("Unsaved")).toBeTruthy(); // the in-progress bead
    expect(screen.getByText("Merged")).toBeTruthy(); // the done bead
    // "Shipped" is now BOTH the terminal lane label and this card's stage badge, so scope to the
    // card: the lane's copy lives inside lane-label-delivered.
    const shipped = screen.getAllByText("Shipped");
    expect(shipped.length).toBe(2);
    const lane = screen.getByTestId("lane-label-delivered");
    expect(shipped.filter((el) => !lane.contains(el))).toHaveLength(1); // the delivered bead
  });

  it("shows the loading state when there is no snapshot yet", () => {
    snapshot = undefined;
    render(<BoardView project={project} side="right" />);
    expect(screen.getByText("Loading tasks…")).toBeTruthy();
  });

  it("shows an empty-column hint and keeps a prior snapshot visible on error", () => {
    snapshot = {
      beads: [],
      board: { backlog: [], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    error = "bd blew up";
    render(<BoardView project={project} side="right" />);
    // Error surfaces but the (empty) board still renders.
    expect(screen.getByText("bd blew up")).toBeTruthy();
    // The four non-definable lanes (Backlog, Blocked, Being built, Archived) show the empty hint;
    // the two definable ones (Done, Shipped) show the Define CTA instead. An empty Archived column
    // is collapsible but has nothing to collapse, so it falls through to the same hint.
    expect(screen.getAllByText("Nothing here yet").length).toBe(4);
    expect(screen.getByText("Define “Done”")).toBeTruthy();
    expect(screen.getByText("Define “Shipped”")).toBeTruthy();
  });

  it("opens a detail overlay with the full description when a card is clicked", () => {
    const long = "Line one of the description.\nLine two after a newline that is quite long ".repeat(3);
    snapshot = {
      beads: [],
      board: {
        backlog: [
          bead({
            id: "p1-x1",
            title: "Detailed task",
            description: long,
            type: "feature",
            priority: 2,
            labels: ["ui", "kanban"],
          }),
        ],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    // Raw-textContent matcher: the description preserves newlines (whiteSpace: pre-wrap), so we
    // match the literal string rather than the whitespace-normalized form getByText uses.
    const fullDesc = (_: string, el: Element | null) => el?.textContent === long;
    render(<BoardView project={project} side="right" />);
    // Before click, the full description text is not present (only a truncated preview).
    expect(screen.queryByText(fullDesc)).toBeNull();
    fireEvent.click(screen.getByText("Detailed task"));
    // After click, the detail overlay shows the full description plus metadata.
    expect(screen.getByText(fullDesc)).toBeTruthy();
    expect(screen.getByText("feature")).toBeTruthy();
    expect(screen.getByText("ui, kanban")).toBeTruthy();
    // A close affordance exists.
    expect(screen.getByLabelText("Close")).toBeTruthy();
  });

  // ══ ESCAPE CLOSES THE OVERLAY — AND MUST NOT COST THE CABLE ══════════════════════════════════
  // Adding an Escape handler made this an Escape-owning surface. `engine/cable.ts` decides whether
  // a press unbinds the concierge by PROBING THE DOM (`dismissibleSurfaceOpen`), and Workspace's
  // listener is registered at app mount so it runs BEFORE this one. Without a marker the probe can
  // see, rung 1 unwires the cable and arms rung 2, and the user's NEXT Escape clears the build row
  // in every pair — the failure roborev 55478 was closed to prevent (roborev 59115, High).
  describe("BoardView — the detail overlay's Escape contract", () => {
    function overlaySnapshot() {
      snapshot = {
        beads: [],
        board: {
          backlog: [bead({ id: "p1-x1", title: "Detailed task", priority: 2 })],
          blocked: [],
          inProgress: [],
          done: [],
          delivered: [],
          archived: [],
        },
        loadedAt: Date.now(),
      };
    }

    it("marks the panel as a dismissible surface, so Escape does not unbind the cable", () => {
      overlaySnapshot();
      render(<BoardView project={project} side="right" />);
      expect(dismissibleSurfaceOpen(document)).toBe(false);

      fireEvent.click(screen.getByText("Detailed task"));
      // THE ASSERTION THAT MATTERS: the cable's own probe must see this overlay. Asserting
      // `role="dialog"` directly would pin the attribute; asserting the probe pins the BEHAVIOUR,
      // and still fails if someone swaps the marker for one the selector does not list.
      expect(dismissibleSurfaceOpen(document)).toBe(true);
      // …which is what makes the cable decline to unbind on this press.
      expect(unbindsOnKey({ ...useCableStore.getState() }, "Escape", { dismissibleOpen: true })).toBe(
        false,
      );
    });

    it("closes on Escape", () => {
      overlaySnapshot();
      render(<BoardView project={project} side="right" />);
      fireEvent.click(screen.getByText("Detailed task"));
      expect(screen.getByTestId("board-bead-card")).toBeTruthy();

      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByTestId("board-bead-card")).toBeNull();
    });

    it("yields the press to an OPEN priority menu instead of closing underneath it", () => {
      overlaySnapshot();
      render(<BoardView project={project} side="right" />);
      fireEvent.click(screen.getByText("Detailed task"));
      // Open the priority menu — it is the innermost layer. The `-trigger` suffix matters: the bare
      // testid is the wrapper span, and clicking that does nothing.
      fireEvent.click(screen.getByTestId("board-bead-card-priority-trigger"));
      expect(screen.getByTestId("board-bead-card-priority-menu")).toBeTruthy();

      fireEvent.keyDown(window, { key: "Escape" });
      // Same-phase listeners fire in REGISTRATION order, so this overlay's handler runs FIRST —
      // without the beadCardMenuIsOpen() guard it would close the card out from under the menu and
      // the menu's own defaultPrevented bail would swallow the press entirely.
      expect(screen.getByTestId("board-bead-card")).toBeTruthy();
    });

    it("leaves a press another layer already claimed alone", () => {
      overlaySnapshot();
      render(<BoardView project={project} side="right" />);
      fireEvent.click(screen.getByText("Detailed task"));

      const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      e.preventDefault();
      window.dispatchEvent(e);
      expect(screen.getByTestId("board-bead-card")).toBeTruthy();
    });
  });

  // ══ THE COMMENT READ PATH IS LAZY — ON OPEN, NEVER ON THE 5s POLL ════════════════════════════
  // `beads_detail` carries `--include-comments`; pulling it on every poll for every bead would
  // hammer the contended bd store. These pin that it fires ONLY when a card opens, and that the
  // compose box drives the real `beadsComment` write path.
  describe("BoardView — the bead comment thread", () => {
    function overlaySnapshot() {
      snapshot = {
        beads: [],
        board: {
          backlog: [bead({ id: "p1-x1", title: "Detailed task", priority: 2 })],
          blocked: [],
          inProgress: [],
          done: [],
          delivered: [],
          archived: [],
        },
        loadedAt: Date.now(),
      };
    }

    it("does NOT read comments on the board poll — only when a card is opened", async () => {
      overlaySnapshot();
      render(<BoardView project={project} side="right" />);
      // The board is rendered from the poll snapshot. The comment read must not have run yet: if it
      // were wired into the list path this would already be non-zero.
      expect(beadsDetailMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("Detailed task"));
      // Opening the card is the ONLY thing that fetches comments — and with this bead's id.
      await waitFor(() => expect(beadsDetailMock).toHaveBeenCalledTimes(1));
      expect(beadsDetailMock).toHaveBeenCalledWith("/tmp/demo", "p1-x1");
    });

    it("posts a typed comment through beadsComment with the bead id and text", async () => {
      overlaySnapshot();
      render(<BoardView project={project} side="right" />);
      fireEvent.click(screen.getByText("Detailed task"));
      await waitFor(() => expect(beadsDetailMock).toHaveBeenCalled());

      const box = screen.getByTestId("board-bead-card-comments-input") as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: "a human note" } });
      fireEvent.click(screen.getByTestId("board-bead-card-comments-submit"));

      // THE SIDE EFFECT: the shipped write path was called with THIS project, THIS bead, THIS text —
      // not merely that a button rendered.
      await waitFor(() => expect(beadsCommentMock).toHaveBeenCalledWith("/tmp/demo", "p1-x1", "a human note"));
    });

    it("renders comments returned by the detail read", async () => {
      overlaySnapshot();
      beadsDetailMock.mockResolvedValueOnce({
        bead: {} as unknown,
        fullDescription: "",
        children: { beads: [], total: 0, omitted: 0, omittedIds: [], limit: 100 },
        dependencies: [],
        dependents: [],
        comments: [
          { id: "c-1", author: "DROdio", text: "the first comment", createdAt: "2026-08-12T00:00:00Z" },
        ],
        linksTruncated: false,
      });
      render(<BoardView project={project} side="right" />);
      fireEvent.click(screen.getByText("Detailed task"));
      // The thread shows the fetched comment body once the lazy read resolves.
      expect(await screen.findByText("the first comment")).toBeTruthy();
    });
  });

  // The batch button is gated on the bead being an EPIC, not merely on its body naming a PRD.
  // `parsePrdRef` matches a "PRD file:" line in ANY body, so a task carrying a back-link resolved a
  // non-empty prdEpics — and a length-only gate offered "Build all N epics in this PRD" on a card
  // for a bead that is not one of them, one press from claiming every epic in that PRD.
  it("does NOT offer build-all-PRD on a non-epic that merely links a PRD", () => {
    const prd = "PRD file: PRD/2026-06-27-build-the-app.md";
    const task = bead({ id: "p1-t1", title: "A mere task", type: "task", description: prd });
    const e1 = bead({ id: "p1-e1", title: "Epic one", type: "epic", description: prd });
    const e2 = bead({ id: "p1-e2", title: "Epic two", type: "epic", description: prd });
    snapshot = {
      beads: [task, e1, e2],
      board: { backlog: [task, e1, e2], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("A mere task"));
    // Two epics DO share this PRD, so a length-only gate would render the batch button here.
    expect(screen.queryByTestId("board-bead-card-build-all-prd")).toBeNull();
    // The single-bead Build It is still correct for a task.
    expect(screen.getByTestId("board-bead-card-build-it")).toBeTruthy();
  });

  // ══ THE OPEN CARD FOLLOWS THE POLL ═══════════════════════════════════════════════════════════
  // The overlay used to hold the clicked Bead OBJECT, and `beadsStore` replaces its snapshot
  // wholesale every 5s — so an open card was a photograph. That silently broke the priority write:
  // `BeadCard` clears its optimistic value only when `bead.priority` agrees, an acknowledgement a
  // frozen object can never deliver (knightwatch probe 5199421526#6).
  it("shows the LATEST bead, not the one captured at click time", () => {
    const before = bead({ id: "p1-x1", title: "Old title", priority: 3 });
    snapshot = {
      beads: [before],
      board: { backlog: [before], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    const { rerender } = render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Old title"));
    expect(screen.getByTestId("board-bead-card")).toBeTruthy();

    // A poll lands with a NEW title and priority for the same id.
    const after = bead({ id: "p1-x1", title: "New title", priority: 0 });
    snapshot = {
      beads: [after],
      board: { backlog: [after], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now() + 1,
    };
    rerender(<BoardView project={project} side="right" />);

    // The OPEN card re-reads it. Holding the object showed "Old title" forever.
    const card = screen.getByTestId("board-bead-card");
    expect(card.textContent).toContain("New title");
    expect(card.textContent).not.toContain("Old title");
  });

  it("closes the overlay when the bead leaves the board entirely", () => {
    const b = bead({ id: "p1-x1", title: "Vanishing" });
    snapshot = {
      beads: [b],
      board: { backlog: [b], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    const { rerender } = render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Vanishing"));
    expect(screen.getByTestId("board-bead-card")).toBeTruthy();

    snapshot = {
      beads: [],
      board: { backlog: [], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now() + 1,
    };
    rerender(<BoardView project={project} side="right" />);
    // A detail card for a bead the board no longer has would contradict everything else on screen.
    expect(screen.queryByTestId("board-bead-card")).toBeNull();
  });

  it("has no free-form edit controls on the COLLAPSED board — inputs/selects/textareas appear only on open", () => {
    const { container } = render(<BoardView project={project} side="right" />);
    // No edit controls anywhere on the collapsed board (buttons exist: cards open detail, epics get
    // Start). The board is a read/navigate surface — the one deliberate exception is the comment
    // compose box, which lives on the OPENED card, not here.
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    // Opening detail introduces exactly ONE edit control — the comment compose box (the founder's
    // ask). Still no `input`/`select`: this is a comment thread, not an edit grid.
    fireEvent.click(screen.getByText("Backlog one"));
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    // The compose textarea IS present now, and it is the only textbox on the surface.
    expect(screen.getByTestId("board-bead-card-comments-input")).toBeTruthy();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("counts each column", () => {
    render(<BoardView project={project} side="right" />);
    // Backlog header lives in a row that also shows its count (2). Scope the lookup to that header.
    const backlogHeader = screen.getByText("Backlog").parentElement as HTMLElement;
    expect(within(backlogHeader).getByText("2")).toBeTruthy();
  });
});

describe("BoardView — Build It (epic handoff)", () => {
  beforeEach(() => blockedReasonMock.mockReturnValue(null));
  function epicSnapshot(description: string) {
    return {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-e1", title: "Build the app", type: "epic", description })],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
  }

  // AT CAPACITY THE HANDOFF MUST NOT CLAIM THE BEAD FIRST.
  //
  // Every handoff here calls claimBead (→ in_progress) before sendToBuild. That was harmless while
  // sendToBuild only threw for an unknown project — a state the caller had ruled out — but the
  // machine-wide cap makes claim-then-fail routine: the epic would sit in progress with no
  // orchestrator, and nothing un-claims it. On a BACKLOG card it is worse, because the claim moves
  // the card out of the `backlog` column that renders the button at all, so the affordance the user
  // just pressed disappears and the retry is only reachable through the detail overlay
  // (roborev 55139). So: refuse BEFORE mutating, show why, and leave the bead alone.
  it("at capacity, refuses without claiming the bead — and says why", async () => {
    blockedReasonMock.mockReturnValue("This machine has 8 of its 8 agent slots taken.");
    snapshot = epicSnapshot("Ship the app.");
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Build the app"));
    // BY TESTID. This used to walk up from the epic status pill ("not started") to find a sibling
    // Build It — a pill the unified card replaced with the workflow stage, per the founder's call
    // that the Think→Plan→Build vocabulary wins. The card exposes the button directly, which also
    // disambiguates it from the backlog CARD's own Build It without any DOM walking.
    fireEvent.click(screen.getByTestId("board-bead-card-build-it"));

    await waitFor(() => expect(screen.getByText(/8 of its 8 agent slots/)).toBeTruthy());
    expect(sendToBuild).not.toHaveBeenCalled();
    // THE point: the bead is untouched, so the card stays where the user can retry it.
    expect(claimBead).not.toHaveBeenCalled();
  });

  // ASSERTED AT THE CALL SITE, not on the function.
  //
  // The preflight's `mode` DEFAULTS to "epic", and each handler must pass its own. A unit test of
  // sendToBuildBlockedReason("p1","e1","task") passes whether or not any caller actually supplies
  // the argument — which is precisely how the single-task handler shipped without it, rendering
  // "Starting this plan…" for a one-bead handoff (roborev 55145). So: assert what the HANDLERS pass.
  it("each handoff tells the preflight which KIND of build it is", async () => {
    snapshot = epicSnapshot("Ship the app.");
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Build the app"));
    // BY TESTID. This used to walk up from the epic status pill ("not started") to find a sibling
    // Build It — a pill the unified card replaced with the workflow stage, per the founder's call
    // that the Think→Plan→Build vocabulary wins. The card exposes the button directly, which also
    // disambiguates it from the backlog CARD's own Build It without any DOM walking.
    fireEvent.click(screen.getByTestId("board-bead-card-build-it"));

    // SETTLE the handler before returning: it now suspends at `await claimBead(...)`, so without
    // this its continuation (sendToBuild / onClose / setBuildBusy) runs after the test body — outside
    // act(), and in the same window as afterEach's mockClear, which can leak a call into the next
    // test where `expect(claimBead).not.toHaveBeenCalled()` cannot tell a leak from a real call.
    await waitFor(() => expect(sendToBuild).toHaveBeenCalled());

    const epicCall = blockedReasonMock.mock.calls.at(-1)!;
    expect(epicCall[1]).toBe("p1-e1");
    // NOW EXPLICITLY "epic", where this used to assert the absence of a mode.
    //
    // The original assertion existed because the call site passed NOTHING and leaned on the
    // preflight's "epic" default, so `?? "epic"` would have passed against `undefined` too
    // (roborev 55155). The shared hook states the mode on both paths, which removes the ambiguity
    // that assertion was defending against rather than weakening it — and this still fails if the
    // epic path ever starts announcing itself as a task, which is the fact the row is here to pin.
    expect(epicCall[2]).toBe("epic");
  });

  // The build-all LOOP: the ceiling can be reached partway through a batch, and claiming an epic we
  // then cannot hand off would mark it in progress with no orchestrator. It must stop cleanly and
  // say how far it got — and without a test here, neutralising that guard leaves the suite green
  // (roborev 55150).
  it("build-all stops at the ceiling, reporting progress and leaving the rest untouched", async () => {
    const prd = "PRD file: PRD/shared.md";
    const e1 = bead({ id: "p1-e1", title: "Epic one", type: "epic", description: prd });
    const e2 = bead({ id: "p1-e2", title: "Epic two", type: "epic", description: prd });
    snapshot = {
      beads: [e1, e2],
      board: { backlog: [e1, e2], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    // Let the FIRST epic through, then hit the ceiling on the second.
    let call = 0;
    blockedReasonMock.mockImplementation(() =>
      ++call > 1 ? "This machine has 8 of its 8 agent slots taken." : null,
    );

    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Epic one")); // open the detail overlay
    fireEvent.click(screen.getByTestId("board-bead-card-build-all-prd"));

    // Stopped partway, and SAID so — the number is what tells the user the batch is incomplete.
    await waitFor(() => expect(screen.getByText(/Started 1 of 2/)).toBeTruthy());
    expect(screen.getByText(/the rest are untouched/)).toBeTruthy();
    // Only the FIRST epic was handed off AND claimed; the blocked one is left alone rather than
    // marked in progress with no orchestrator behind it. With the store seeded, the claim assertion
    // is real rather than inert.
    expect(vi.mocked(sendToBuild)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendToBuild)).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: "p1-e1" }),
    );
    expect(vi.mocked(claimBead)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(claimBead)).toHaveBeenCalledWith("/tmp/demo", "p1-e1");
  });

  // The single-task guard's REFUSAL BEHAVIOUR, not just the argument it passes.
  //
  // The mode test below runs with the preflight returning null, so deleting the whole
  // `if (blocked) { … return; }` block leaves it green — the mutated code takes the identical path.
  // (My earlier mutation neutralised the CALL, which only broke the argument assertion. Deleting the
  // BLOCK is the mutation that matters here.) roborev 55152.
  it("the SINGLE-TASK Build It refuses at capacity without claiming or handing off", async () => {
    blockedReasonMock.mockReturnValue("Building this task would need another agent.");
    snapshot = {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-t2", title: "Another small task", type: "task" })],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Another small task"));
    fireEvent.click(
      screen.getByTestId("board-bead-card-build-it"),
    );

    await waitFor(() => expect(screen.getByText(/Building this task/)).toBeTruthy());
    expect(vi.mocked(sendToBuild)).not.toHaveBeenCalled();
    expect(vi.mocked(claimBead)).not.toHaveBeenCalled();
  });

  it("the SINGLE-TASK Build It passes mode 'task', so the refusal never calls it a plan", async () => {
    // A task-typed bead renders the task-level Build It (BoardView's `isTask` branch).
    snapshot = {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-t1", title: "One small task", type: "task" })],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("One small task")); // open the detail overlay
    fireEvent.click(
      screen.getByTestId("board-bead-card-build-it"),
    );

    // Same reason as above: settle the async handler inside the test.
    await waitFor(() => expect(sendToBuild).toHaveBeenCalled());

    const call = blockedReasonMock.mock.calls.at(-1)!;
    expect(call[1]).toBe("p1-t1");
    // THE assertion: without this argument the preflight silently defaults to "epic" and the user is
    // told "Starting this plan…" for a one-bead build (roborev 55145).
    expect(call[2]).toBe("task");
  });

  it("shows the status pill + Build It on an epic and hands off with the parsed PRD path", async () => {
    snapshot = epicSnapshot("Ship the app.\n\nPRD file: PRD/2026-06-27-build-the-app.md");
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Build the app")); // open the epic's detail overlay
    // The epic rollup pill ("not started") is gone; the unified card states progress in the
    // Think→Plan→Build vocabulary instead — one status vocabulary across every surface, which was
    // the point. An open epic with no worker reads "Planned".
    expect(screen.getByTestId("board-bead-card-stage-label").textContent).toBe("Planned");
    // The backlog card ALSO carries a "Build It" (renamed from Start), so scope the click to the
    // overlay's status row — the "not started" pill and the overlay's Build It button are siblings.
    // BY TESTID. This used to walk up from the epic status pill ("not started") to find a sibling
    // Build It — a pill the unified card replaced with the workflow stage, per the founder's call
    // that the Think→Plan→Build vocabulary wins. The card exposes the button directly, which also
    // disambiguates it from the backlog CARD's own Build It without any DOM walking.
    fireEvent.click(screen.getByTestId("board-bead-card-build-it"));
    // AWAITED: with the store seeded, `await claimBead(...)` genuinely runs before the handoff, so
    // this is a microtask later. It only read as synchronous while the claim was dead code.
    await waitFor(() =>
      expect(sendToBuild).toHaveBeenCalledWith({
        projectId: "p1",
        epicId: "p1-e1",
        prdPath: "PRD/2026-06-27-build-the-app.md",
        // EXPLICIT now. The old call site omitted `mode` and leaned on sendToBuild's "epic"
        // default; the shared hook states it. Behaviourally identical (sendToBuild.ts branches
        // only on `=== "task"`), and stating it is what roborev 55145 asked for after an omitted
        // mode made a single-task build announce itself as a plan.
        mode: "epic",
      }),
    );
    // …and the claim really happened, which the null-rootPath fixture could never show.
    expect(claimBead).toHaveBeenCalledWith("/tmp/demo", "p1-e1");
  });

  it("hands off a PRD-less epic with prdPath null (no longer blocks)", async () => {
    // The "no linked PRD" hard block was removed (unify Build It affordances): a PRD-less epic now
    // hands off with prdPath null and sendToBuild seeds off `bd show <epicId>` instead of blocking.
    snapshot = epicSnapshot("no PRD link in this body");
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Build the app"));
    // BY TESTID. This used to walk up from the epic status pill ("not started") to find a sibling
    // Build It — a pill the unified card replaced with the workflow stage, per the founder's call
    // that the Think→Plan→Build vocabulary wins. The card exposes the button directly, which also
    // disambiguates it from the backlog CARD's own Build It without any DOM walking.
    fireEvent.click(screen.getByTestId("board-bead-card-build-it"));
    await waitFor(() =>
      expect(sendToBuild).toHaveBeenCalledWith({
        projectId: "p1",
        epicId: "p1-e1",
        prdPath: null,
        mode: "epic",
      }),
    );
  });
});

describe("BoardView — Start button + decompose badges (spec §7)", () => {
  afterEach(() => {
    vi.mocked(claimBead).mockClear();
    vi.mocked(labelBead).mockClear();
  });

  /** A backlog epic (with an optional child so Start is enabled) + labels. */
  function startSnapshot(over: { labels?: string[]; withChild?: boolean; description?: string }) {
    const epic = bead({
      id: "p1-e1",
      title: "Epic to start",
      type: "epic",
      description: over.description ?? "Body.\n\nPRD file: PRD/2026-07-01-epic.md",
      labels: over.labels ?? [],
    });
    const child = bead({ id: "p1-e1.1", title: "Child task", type: "task", parent: "p1-e1" });
    const beads = over.withChild === false ? [epic] : [epic, child];
    snapshot = {
      beads,
      board: {
        backlog: [epic],
        blocked: [],
        inProgress: over.withChild === false ? [] : [child],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
  }

  // The FOURTH call site (StartControls.handleStart). Without this, deleting its guard leaves the
  // suite green — the other Start tests all run with the preflight returning null (roborev 55150).
  it("Start refuses at capacity WITHOUT claiming, so the card keeps its button", async () => {
    blockedReasonMock.mockReturnValue("This machine has 8 of its 8 agent slots taken.");
    startSnapshot({});
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Build It"));

    await waitFor(() => expect(screen.getByText(/8 of its 8 agent slots/)).toBeTruthy());
    expect(sendToBuild).not.toHaveBeenCalled();
    // The claim is what would move this card out of `backlog` — the column that renders the button
    // at all — so leaving the bead alone is what keeps the retry reachable.
    expect(claimBead).not.toHaveBeenCalled();
  });

  it("claims the epic then hands off to Build with the parsed PRD path", async () => {
    startSnapshot({});
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Build It"));
    await waitFor(() => expect(sendToBuild).toHaveBeenCalled());
    expect(claimBead).toHaveBeenCalledWith("/tmp/demo", "p1-e1");
    expect(sendToBuild).toHaveBeenCalledWith({
      projectId: "p1",
      epicId: "p1-e1",
      prdPath: "PRD/2026-07-01-epic.md",
    });
    // Start must not ALSO open the detail overlay (stopPropagation).
    expect(screen.queryByLabelText("Close")).toBeNull();
  });

  it("passes prdPath null for a PRD-less epic instead of blocking", async () => {
    startSnapshot({ description: "no prd reference" });
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Build It"));
    await waitFor(() => expect(sendToBuild).toHaveBeenCalled());
    expect(sendToBuild).toHaveBeenCalledWith({ projectId: "p1", epicId: "p1-e1", prdPath: null });
  });

  it("disables Start (tooltip decomposing…) while the epic has zero children", () => {
    startSnapshot({ withChild: false });
    render(<BoardView project={project} side="right" />);
    const start = screen.getByText("Build It") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toContain("decomposing…");
    fireEvent.click(start);
    expect(claimBead).not.toHaveBeenCalled();
    expect(sendToBuild).not.toHaveBeenCalled();
  });

  it("disables Start and shows a click-to-clear badge while labeled decomposing", async () => {
    startSnapshot({ labels: ["decomposing"] });
    render(<BoardView project={project} side="right" />);
    expect((screen.getByText("Build It") as HTMLButtonElement).disabled).toBe(true);
    // The badge itself clears the label (the user's way out of a stuck decompose).
    fireEvent.click(screen.getByText("decomposing…"));
    await waitFor(() =>
      expect(labelBead).toHaveBeenCalledWith("/tmp/demo", "remove", "p1-e1", "decomposing"),
    );
  });

  it("shows a decompose-failed chip whose click clears the label so the next sweep retries", async () => {
    startSnapshot({ labels: ["decompose-failed"] });
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText(/decompose failed/i));
    await waitFor(() =>
      expect(labelBead).toHaveBeenCalledWith("/tmp/demo", "remove", "p1-e1", "decompose-failed"),
    );
  });

  it("shows Build It only on backlog epic cards (not tasks, not other columns)", () => {
    snapshot = {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-t1", title: "Plain task", type: "task" })],
        blocked: [],
        inProgress: [bead({ id: "p1-e2", title: "Running epic", type: "epic" })],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByText("Build It")).toBeNull();
  });
});

describe("BoardView — Definable Done & Delivered (Unit 5)", () => {
  it("shows the Define CTA for an undefined Done column and NOT for Backlog/In Progress", async () => {
    render(<BoardView project={project} side="right" />);
    await waitFor(() => expect(getConfig).toHaveBeenCalledWith("/tmp/demo"));
    // Undefined Done/Delivered → centered blue Define CTA in the column body.
    expect(screen.getByText("Define “Done”")).toBeTruthy();
    expect(screen.getByText("Define “Shipped”")).toBeTruthy();
    // The inert columns never get a Define affordance.
    expect(screen.queryByText("Define “Backlog”")).toBeNull();
    expect(screen.queryByText("Define “Being built”")).toBeNull();
  });

  it("opens the Define modal for the matching stage when a Done/Delivered header is clicked", async () => {
    render(<BoardView project={project} side="right" />);
    // The Done column TITLE is a button (Backlog/In Progress titles are plain text). Its accessible
    // name is the label; the "Define what …" hover lives on the title attribute.
    const doneHeader = screen.getByRole("button", { name: "Done" });
    expect(doneHeader.title).toMatch(/Define what “Done” means/i);
    fireEvent.click(doneHeader);
    expect(screen.getByTestId("define-modal").textContent).toContain("define-modal:done");
    // Closing the modal removes it.
    fireEvent.click(screen.getByText("close-modal"));
    expect(screen.queryByTestId("define-modal")).toBeNull();
    // Backlog / In Progress headers are inert (not buttons).
    expect(screen.queryByRole("button", { name: "Backlog" })).toBeNull();
    expect(screen.queryByRole("button", { name: "In Progress" })).toBeNull();
  });

  it("opens the Delivered modal from its empty-state CTA button", async () => {
    render(<BoardView project={project} side="right" />);
    await waitFor(() => expect(screen.getByText("Define “Shipped”")).toBeTruthy());
    fireEvent.click(screen.getByText("Define “Shipped”"));
    expect(screen.getByTestId("define-modal").textContent).toContain("define-modal:delivered");
  });

  it("shows a defined-column status chip and no Define CTA once Done is defined", async () => {
    defineDone();
    snapshot = {
      beads: [],
      board: { backlog: [], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    await waitFor(() => expect(screen.getByText("defined")).toBeTruthy());
    expect(screen.queryByText("Define “Done”")).toBeNull();
  });

  it("surfaces a per-card criteria chip and, once all criteria are met, a Mark control", async () => {
    // Done defined with a single MANUAL criterion → a backlog card evaluates toward Done.
    defineDone({ text: "Reviewed by a teammate", kind: "manual", signal: null });
    snapshot = {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-m1", title: "Needs review" })],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    // Compact progress chip appears ("0 of 1" met) — no Mark control yet.
    await waitFor(() => expect(screen.getByText("0 of 1")).toBeTruthy());
    expect(screen.queryByText("Mark as Done")).toBeNull();
    // Expand the popover, tick the manual criterion → allMet → the Mark control appears.
    fireEvent.click(screen.getByText("0 of 1"));
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    await waitFor(() => expect(screen.getByText("1 of 1")).toBeTruthy());
    expect(screen.getByText("Mark as Done")).toBeTruthy();
  });

  it("clicking Mark as Done performs the real bd move (closeBead) once criteria are met", async () => {
    defineDone({ text: "Reviewed by a teammate", kind: "manual", signal: null });
    snapshot = {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-m1", title: "Needs review" })],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    await waitFor(() => expect(screen.getByText("0 of 1")).toBeTruthy());
    fireEvent.click(screen.getByText("0 of 1")); // expand popover
    fireEvent.click(screen.getAllByRole("checkbox")[0]!); // tick the manual criterion → allMet
    fireEvent.click(await screen.findByText("Mark as Done"));
    await waitFor(() => expect(closeBead).toHaveBeenCalledWith("/tmp/demo", "p1-m1"));
    expect(markBeadDelivered).not.toHaveBeenCalled();
  });

  it("clicking Mark as Delivered performs the real bd move (markBeadDelivered)", async () => {
    // A closed card in the Done column evaluates toward Delivered; a met manual criterion enables Mark.
    defineDelivered({ text: "Deployed to prod verified", kind: "manual", signal: null });
    snapshot = {
      beads: [],
      board: {
        backlog: [],
        blocked: [],
        inProgress: [],
        done: [bead({ id: "p1-d9", title: "Landed feature", status: "closed" })],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    await waitFor(() => expect(screen.getByText("0 of 1")).toBeTruthy());
    fireEvent.click(screen.getByText("0 of 1"));
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    fireEvent.click(await screen.findByText("Mark as Delivered"));
    await waitFor(() => expect(markBeadDelivered).toHaveBeenCalledWith("/tmp/demo", "p1-d9"));
    expect(closeBead).not.toHaveBeenCalled();
  });

  it("starts the delivery monitor only once Delivered is defined, and stops it on unmount", async () => {
    defineDelivered();
    const { unmount } = render(<BoardView project={project} side="right" />);
    await waitFor(() =>
      expect(startDeliveryMonitor).toHaveBeenCalledWith(
        "/tmp/demo",
        expect.any(Function),
        expect.any(Function),
      ),
    );
    unmount();
    expect(stopDeliveryMonitor).toHaveBeenCalled();
  });
});

// The per-agent FEEDBACK filter (feedback-pill-and-filter): a build-agent row's FEEDBACK pill sets
// uiStore.boardAgentFilter to its agent id, then jumps here. The board must then show ONLY beads
// carrying that agent's `agent:<id>` label — the beads it created or commented on — and offer a
// clearable banner. Client-side over the already-bucketed columns; the poll/fetch are untouched.
describe("BoardView — per-agent feedback filter (feedback-pill-and-filter)", () => {
  afterEach(() => {
    // The filter lives in the real uiStore singleton (a module-level store), so clear it or it leaks
    // into every later suite in this file and silently hides their beads.
    useUiStore.getState().setBoardAgentFilter("right", null);
  });

  function labeledSnapshot() {
    const mine = bead({ id: "p1-mine", title: "My feedback bead", labels: ["agent:agent-x"] });
    const other = bead({ id: "p1-other", title: "Someone elses bead", labels: ["agent:agent-y"] });
    snapshot = {
      beads: [mine, other],
      board: { backlog: [mine, other], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
  }

  // THE mutation-check target for the filter: deleting the client-side narrow (so displayBoard ===
  // board) renders BOTH beads, which fails the `queryByText(...).toBeNull()` below.
  it("with boardAgentFilter set, renders ONLY beads labeled agent:<id> and hides the rest", () => {
    labeledSnapshot();
    useUiStore.getState().setBoardAgentFilter("right", "agent-x");
    render(<BoardView project={project} side="right" />);
    // The matching bead is shown…
    expect(screen.getByText("My feedback bead")).toBeTruthy();
    // …and the non-matching one is HIDDEN. This is the assertion the filter exists to satisfy.
    expect(screen.queryByText("Someone elses bead")).toBeNull();
  });

  it("shows a clearable banner, and Clear restores the full board", () => {
    labeledSnapshot();
    useUiStore.getState().setBoardAgentFilter("right", "agent-x");
    render(<BoardView project={project} side="right" />);
    const banner = screen.getByTestId("board-agent-filter-banner");
    // No agent by that id is registered on the project here, so this exercises the CLOSED-AGENT
    // fallback — see the two tests below, which pin each branch explicitly.
    expect(banner.textContent).toContain("agent-x");
    // Clear drops the filter → the store goes null AND the hidden bead comes back.
    fireEvent.click(within(banner).getByText("Clear"));
    expect(useUiStore.getState().boardAgentFilterBySide.right).toBeNull();
    expect(screen.getByText("Someone elses bead")).toBeTruthy();
  });

  // ── THE BANNER NAMES THE AGENT, NOT ITS UUID ────────────────────────────────────────────────
  // The founder's report: 'it tells me "Showing feedback from agent a4e23b93-0b03-…" but I need to
  // know what that agent name is'. The id was always resolvable — `agents` is scoped to this
  // board's project and already read for the worker rows — so this is a lookup that was simply
  // never done, not missing data.
  //
  // MUTATION TARGET: reverting the banner to `{boardAgentFilter}` makes the name assertion fail AND
  // the not-the-uuid assertion fail. A test that only asserted the name were present would stay
  // green if both were printed, so the negative is the load-bearing half.
  it("resolves the filtered agent's id to its DISPLAY NAME and does not print the uuid", () => {
    labeledSnapshot();
    const agentId = "a4e23b93-0b03-4be8-bd6f-f8c5df274c84";
    const mine = bead({ id: "p1-mine", title: "My feedback bead", labels: [`agent:${agentId}`] });
    snapshot = {
      beads: [mine],
      board: { backlog: [mine], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    useProjectStore.setState({
      projects: [
        {
          ...project,
          agents: [
            {
              id: agentId,
              name: "Stripe Checkout Flow",
              namePinned: true,
              selfNamed: false,
              aiTitle: null,
              autoNameVariants: null,
            } as AgentTab,
          ],
        },
      ],
      selectedProjectId: project.id,
    });
    useUiStore.getState().setBoardAgentFilter("right", agentId);
    render(<BoardView project={project} side="right" />);

    const label = screen.getByTestId("board-agent-filter-label");
    expect(label.textContent).toContain("Stripe Checkout Flow");
    // The whole point: the uuid is GONE from the banner.
    expect(label.textContent).not.toContain(agentId);
  });

  // The agent was closed, or the project switched under an open board. The filter is NOT cleared
  // (the beads are still labelled `agent:<id>`, so the board really is narrowed and this banner is
  // the only explanation for why) — but it must say so in words rather than printing a bare uuid as
  // if it were a name, and it must never render an empty <strong>.
  it("says the agent is closed, with a truncated id, when the id does not resolve", () => {
    labeledSnapshot();
    useUiStore.getState().setBoardAgentFilter("right", "a4e23b93-0b03-4be8-bd6f-f8c5df274c84");
    render(<BoardView project={project} side="right" />);

    const label = screen.getByTestId("board-agent-filter-label");
    expect(label.textContent).toContain("closed agent");
    expect(label.textContent).toContain("a4e23b93");
    // Truncated, not the whole uuid.
    expect(label.textContent).not.toContain("f8c5df274c84");
    // The filter survives — dropping it would leave a silently short board.
    expect(useUiStore.getState().boardAgentFilterBySide.right).toBe(
      "a4e23b93-0b03-4be8-bd6f-f8c5df274c84",
    );
  });

  it("renders the full board (and NO banner) when no filter is set", () => {
    labeledSnapshot();
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByTestId("board-agent-filter-banner")).toBeNull();
    expect(screen.getByText("My feedback bead")).toBeTruthy();
    expect(screen.getByText("Someone elses bead")).toBeTruthy();
  });
});

// ── PRIORITY + DATE-RANGE FILTER ──────────────────────────────────────────────────────────────
// The founder: "I want to be able to only look at cards of a certain priority status and also a
// certain date range." The rules themselves are unit-tested in services/boardFilters.test.ts; what
// these cover is that BoardView actually APPLIES them, and that an emptied board explains itself.
describe("BoardView — priority and date filters", () => {
  afterEach(() => {
    useUiStore.getState().setBoardFilter("right", NO_BOARD_FILTER);
  });

  const RECENT = new Date(Date.now() - 3600_000).toISOString();
  const OLD = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();

  function mixedSnapshot() {
    const p0 = bead({ id: "p1-p0", title: "Urgent one", priority: 0, updatedAt: RECENT });
    const p2 = bead({ id: "p1-p2", title: "Later one", priority: 2, updatedAt: RECENT });
    const stale = bead({ id: "p1-old", title: "Ancient one", priority: 0, updatedAt: OLD });
    snapshot = {
      beads: [p0, p2, stale],
      board: { backlog: [p0, p2, stale], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
  }

  // MUTATION TARGET: dropping `matchesBoardFilter` from BoardView's keep() renders all three.
  it("shows only the selected priority and hides the others", () => {
    mixedSnapshot();
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 0 });
    render(<BoardView project={project} side="right" />);
    expect(screen.getByText("Urgent one")).toBeTruthy();
    expect(screen.getByText("Ancient one")).toBeTruthy();
    expect(screen.queryByText("Later one")).toBeNull();
  });

  it("applies the date window, and the created/updated switch selects which date", () => {
    mixedSnapshot();
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, dateWindow: "24h" });
    const { unmount } = render(<BoardView project={project} side="right" />);
    expect(screen.getByText("Urgent one")).toBeTruthy();
    // 60 days old on `updatedAt` — outside a 24h window.
    expect(screen.queryByText("Ancient one")).toBeNull();
    unmount();

    // The same bead has NO createdAt, and an unreadable date must KEEP a bead rather than hide it
    // (sparkle-qogah). Flipping the field therefore brings it back.
    useUiStore
      .getState()
      .setBoardFilter("right", { ...NO_BOARD_FILTER, dateWindow: "24h", dateField: "created" });
    render(<BoardView project={project} side="right" />);
    expect(screen.getByText("Ancient one")).toBeTruthy();
  });

  it("both axes combine — a recent bead of the wrong priority is still hidden", () => {
    mixedSnapshot();
    useUiStore
      .getState()
      .setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 0, dateWindow: "24h" });
    render(<BoardView project={project} side="right" />);
    expect(screen.getByText("Urgent one")).toBeTruthy();
    expect(screen.queryByText("Later one")).toBeNull(); // recent, wrong priority
    expect(screen.queryByText("Ancient one")).toBeNull(); // right priority, too old
  });

  // ══ AN EMPTIED BOARD MUST SAY WHY ═══════════════════════════════════════════════════════════
  // Five empty columns read as "this project has no work". The count is the honest part: it says
  // the cards exist and the filter is why they are not on screen.
  it("explains an emptied board and reports how many cards are hidden", () => {
    mixedSnapshot();
    // No bead has priority 3, so everything is filtered out.
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 3 });
    render(<BoardView project={project} side="right" />);

    const notice = screen.getByTestId("board-filter-empty-notice");
    expect(notice.textContent).toContain("No cards match this filter");
    expect(notice.textContent).toContain("3");
    // And Clear restores every card.
    fireEvent.click(within(notice).getByText("Clear filters"));
    expect(screen.getByText("Urgent one")).toBeTruthy();
    expect(screen.getByText("Later one")).toBeTruthy();
    expect(screen.getByText("Ancient one")).toBeTruthy();
  });

  // A PARTIAL narrow is self-evident — cards are on screen — so the notice must not fire. Without
  // this the banner would appear over a board that is visibly working.
  it("shows NO empty notice while the filter still leaves cards on screen", () => {
    mixedSnapshot();
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 0 });
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByTestId("board-filter-empty-notice")).toBeNull();
  });

  // ══ THE TWO FILTERS STACK, AND THE NOTICE MUST ONLY SPEAK FOR ITS OWN ═══════════════════════
  // The agent filter and the priority/date filter sit on the same seam. Measuring the doubly
  // filtered board against the UNfiltered snapshot attributes the agent filter's removals to this
  // notice (roborev 59075). Both rows below failed before the baseline was moved.
  describe("with the per-agent feedback filter ALSO active", () => {
    afterEach(() => {
      useUiStore.getState().setBoardAgentFilter("right", null);
    });

    function stackedSnapshot() {
      // 4 beads; only 1 belongs to agent-x; that one is P2.
      const mine = bead({ id: "p1-m", title: "Mine P2", priority: 2, labels: ["agent:agent-x"] });
      const others = [1, 2, 3].map((n) =>
        bead({ id: `p1-o${n}`, title: `Other ${n}`, priority: 0, labels: ["agent:agent-y"] }),
      );
      const all = [mine, ...others];
      snapshot = {
        beads: all,
        board: { backlog: all, blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
        loadedAt: Date.now(),
      };
    }

    it("counts only what the PRIORITY filter hid, not the agent filter's removals", () => {
      stackedSnapshot();
      useUiStore.getState().setBoardAgentFilter("right", "agent-x");
      // The agent filter leaves 1 bead (P2); filtering to P0 hides that ONE.
      useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 0 });
      render(<BoardView project={project} side="right" />);

      const notice = screen.getByTestId("board-filter-empty-notice");
      // ONE, not four. The other three were never this filter's to hide.
      expect(notice.textContent).toContain("1");
      expect(notice.textContent).not.toContain("4");
    });

    it("stays silent when the AGENT filter is what emptied the board", () => {
      stackedSnapshot();
      // No bead carries this agent, so the agent filter alone empties the board…
      useUiStore.getState().setBoardAgentFilter("right", "agent-nobody");
      // …while a board filter is set but is not the cause.
      useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 0 });
      render(<BoardView project={project} side="right" />);

      // Firing here would blame the wrong control AND offer a "Clear filters" button that resets
      // only boardFilter — leaving the board just as empty. The agent banner above owns this case.
      expect(screen.queryByTestId("board-filter-empty-notice")).toBeNull();
      expect(screen.getByTestId("board-agent-filter-banner")).toBeTruthy();
    });
  });

  it("shows NO empty notice when the board is genuinely empty and no filter is set", () => {
    snapshot = {
      beads: [],
      board: { backlog: [], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByTestId("board-filter-empty-notice")).toBeNull();
  });
});

// ── THE WHEEL MOVES THE BOARD, NOT ONE COLUMN'S CARDS ─────────────────────────────────────────
//
// A kanban is a HORIZONTAL thing and the wheel is the gesture people reach for to travel along it,
// but the browser will not do that unaided: `deltaY` scrolls the nearest ancestor overflowing on Y,
// and the only such ancestor here is a column's card list. So the board could never be moved by a
// wheel at all — the founder's BACKLOG (606 items) ate every scroll while BLOCKED sat clipped at
// the right edge with no gesture that would bring it in.
describe("boardScrollDelta — which thing the wheel moves", () => {
  const atRest = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
  const roomBelow = { scrollTop: 0, scrollHeight: 900, clientHeight: 300 };
  const atBottom = { scrollTop: 600, scrollHeight: 900, clientHeight: 300 };

  it("moves the BOARD when the pointer is not over a card list at all", () => {
    // Column headers, the gaps between columns, the padding — most of the board's surface.
    expect(boardScrollDelta({ deltaX: 0, deltaY: 120 }, null)).toBe(120);
    expect(boardScrollDelta({ deltaX: 0, deltaY: -120 }, null)).toBe(-120);
  });

  it("moves the BOARD over a column whose cards all fit — there is nothing to scroll there", () => {
    expect(boardScrollDelta({ deltaX: 0, deltaY: 120 }, atRest)).toBe(120);
  });

  it("leaves a column that can still move in the wheel's own direction alone", () => {
    // The exception, and the reason a 606-card column stays readable: while the list has room the
    // list keeps the event. Board-always-wins would make those cards reachable only by dragging a
    // scrollbar, which trades the founder's bug for a worse one.
    expect(boardScrollDelta({ deltaX: 0, deltaY: 120 }, roomBelow)).toBe(0);
    expect(boardScrollDelta({ deltaX: 0, deltaY: -120 }, atBottom)).toBe(0);
  });

  it("hands the board the event once that column is at its end — one continuous gesture", () => {
    expect(boardScrollDelta({ deltaX: 0, deltaY: 120 }, atBottom)).toBe(120);
    expect(boardScrollDelta({ deltaX: 0, deltaY: -120 }, roomBelow)).toBe(-120);
  });

  it("keeps its hands off a horizontal gesture, which already lands on the board", () => {
    // The board row IS the nearest X scroller, so the browser does this one right unaided; adding
    // to scrollLeft as well would double every trackpad swipe.
    expect(boardScrollDelta({ deltaX: 90, deltaY: 4 }, null)).toBe(0);
    expect(boardScrollDelta({ deltaX: 0, deltaY: 0 }, null)).toBe(0);
  });

  it("reads a LINE-mode wheel in pixels, like the sidebar's forwarder already does", () => {
    // A mouse in DOM_DELTA_LINE mode reports ~3 per notch. Taken raw, the board would creep 3px a
    // notch — indistinguishable from "the wheel does nothing", which is the bug being fixed.
    expect(boardScrollDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, null)).toBe(48);
    expect(boardScrollDelta({ deltaX: 0, deltaY: -3, deltaMode: 1 }, null)).toBe(-48);
    expect(boardScrollDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, null)).toBe(400);
    // The normalisation reaches the RETURNED VALUE with a list in play too, not just the null case:
    // a list at its end hands the gesture over, and what it hands over is 48px, not 3.
    expect(boardScrollDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, atBottom)).toBe(48);
  });

  it("decides the handoff on DIRECTION alone — never on how big the gesture is", () => {
    // Worth pinning because the obvious "improvement" is to compare travel against slack, which
    // would change when the board takes over on every column. It does not: `room`/`scrollTop` are
    // tested against a sub-pixel constant, and the delta contributes only its SIGN. A list with
    // 20px left keeps a 3-line gesture and a 1000px one alike.
    const nearlyDone = { scrollTop: 0, scrollHeight: 320, clientHeight: 300 };
    expect(boardScrollDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, nearlyDone)).toBe(0);
    expect(boardScrollDelta({ deltaX: 0, deltaY: 3, deltaMode: 0 }, nearlyDone)).toBe(0);
    expect(boardScrollDelta({ deltaX: 0, deltaY: 1000, deltaMode: 0 }, nearlyDone)).toBe(0);
  });

  it("treats a sub-pixel remainder as 'at the end'", () => {
    // Fractional scrollHeight (zoom, fractional DPR) otherwise leaves a list able to scroll by a
    // hair forever, and the board would never take over — the original bug, restored by rounding.
    expect(boardScrollDelta({ deltaX: 0, deltaY: 120 }, { scrollTop: 0, scrollHeight: 300.4, clientHeight: 300 })).toBe(120);
  });
});

describe("the board's scroll containers", () => {
  it("scrolls the columns sideways when a wheel arrives over a list with no room left", () => {
    render(<BoardView project={project} side="right" />);
    const row = screen.getByTestId("board-columns");
    // jsdom has no layout, so scrollLeft is a permanent 0 there — make it a real settable property
    // so the handler's write is observable. The GEOMETRY below is the test's actual input.
    Object.defineProperty(row, "scrollLeft", { value: 0, writable: true, configurable: true });
    const list = row.querySelector("[data-board-column-list]") as HTMLElement;
    expect(list).toBeTruthy();

    fireEvent.wheel(list, { deltaX: 0, deltaY: 150 });
    expect(row.scrollLeft).toBe(150);
  });

  it("leaves the board alone while the column under the pointer still has cards to reveal", () => {
    render(<BoardView project={project} side="right" />);
    const row = screen.getByTestId("board-columns");
    Object.defineProperty(row, "scrollLeft", { value: 0, writable: true, configurable: true });
    const list = row.querySelector("[data-board-column-list]") as HTMLElement;
    Object.defineProperty(list, "scrollHeight", { value: 900, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 300, configurable: true });

    fireEvent.wheel(list, { deltaX: 0, deltaY: 150 });
    expect(row.scrollLeft).toBe(0);
  });

  it("gives each axis exactly one owner", () => {
    const { container } = render(<BoardView project={project} side="right" />);
    const row = screen.getByTestId("board-columns");
    // The row is the X scroller and NOT a Y one. Left `visible`, CSS would force overflow-y to
    // `auto` here (one axis non-visible forces the other) and put a second vertical scroller around
    // the columns, so "which thing did I just scroll" would have no answer.
    expect(row.style.overflowX).toBe("auto");
    expect(row.style.overflowY).toBe("hidden");
    // ...and each card list is the Y scroller and NOT an X one. That same CSS rule is what silently
    // made these horizontal scrollers: any card wider than its column gave the list scrollable
    // width, and one sideways nudge pushed the text out of view on the LEFT — the founder's clipped
    // titles ("window drop is", "causes").
    const lists = container.querySelectorAll<HTMLElement>("[data-board-column-list]");
    // Six columns now: Backlog / Blocked / Being built / Done / Shipped / Archived. Each owns one
    // vertical scroller (the archived column's list is present even while collapsed).
    expect(lists.length).toBe(6);
    for (const l of lists) {
      expect(l.style.overflowY).toBe("auto");
      expect(l.style.overflowX).toBe("hidden");
      // CONTAINED ON Y ONLY, and the suffix is load-bearing (roborev 57312). A hidden axis is a
      // CLIPPED scrollport, not an absent one, so this element is still a scroll container on X —
      // an unsuffixed `overscroll-behavior: contain` latches a horizontal swipe HERE, where nothing
      // can move, instead of letting it chain to the board row. Over a column tall enough to be a
      // scroller that leaves NO gesture that reaches the board, since the vertical rule hands the
      // list the wheel: the exact bug this file is guarding, on the exact column that reported it.
      expect(l.style.overscrollBehaviorY).toBe("contain");
      expect(l.style.overscrollBehavior).toBe("");
      expect(l.style.overscrollBehaviorX).toBe("");
    }
  });

  it("leaves a horizontal gesture to the browser rather than half-handling it", () => {
    render(<BoardView project={project} side="right" />);
    const row = screen.getByTestId("board-columns");
    Object.defineProperty(row, "scrollLeft", { value: 0, writable: true, configurable: true });
    const list = row.querySelector("[data-board-column-list]") as HTMLElement;
    // The row is the nearest X scroller, so the browser already moves it; adding to scrollLeft here
    // as well would double every trackpad swipe.
    fireEvent.wheel(list, { deltaX: 150, deltaY: 2 });
    expect(row.scrollLeft).toBe(0);
  });

  it("lets a card be narrower than its longest word, so a title wraps instead of overflowing", () => {
    // The other half of the clipped-title fix: hiding the axis alone would CLIP the overflow rather
    // than scroll it, which is no better. Bead titles carry paths and branch names with no break
    // opportunity, so the text has to be allowed to break anywhere and the card to shrink below it.
    render(<BoardView project={project} side="right" />);
    const title = screen.getByText("Backlog one");
    expect(title.style.overflowWrap).toBe("anywhere");
    // The description preview carries the same text, and the same risk.
    expect(screen.getByText("First backlog task description.").style.overflowWrap).toBe("anywhere");
    // And NO `minWidth: 0` anywhere on the way up (roborev 57312): the content-based automatic
    // minimum is a MAIN-AXIS rule, and every box here is an item of a column-direction flex
    // container, so `min-width: auto` already resolves to 0. Declaring it is dead style that reads
    // as load-bearing — pin its absence so it does not come back as cargo.
    const body = title.closest("button") as HTMLElement;
    const card = body.parentElement as HTMLElement;
    expect(card.style.background).toBeTruthy(); // it really is the card shell, not another wrapper
    expect(body.style.minWidth).toBe("");
    expect(card.style.minWidth).toBe("");
  });
});

describe("the board's header", () => {
  it("does not restate the project name above the columns", () => {
    // Founder's call: the tab bar directly above already says which project this is, and a 17px
    // row plus its hairline was ~44px of board height spent repeating it — taken from the cards.
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByText(/Tasks —/)).toBeNull();
    expect(screen.queryByText(`Tasks — ${project.name}`)).toBeNull();
  });

  it("still surfaces a fetch error, which that row also carried", () => {
    error = "bd blew up";
    render(<BoardView project={project} side="right" />);
    expect(screen.getByTestId("board-error").textContent).toBe("bd blew up");
  });

  it("reserves no banner when there is no error", () => {
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByTestId("board-error")).toBeNull();
  });
});

// ── Fix #1: PRIORITY ON THE CARD FACE ──────────────────────────────────────────────────────────
// The founder asked to see a bead's priority on EVERY card in the columns, not only after opening
// one. These assert the SIDE EFFECT — the chip on a collapsed card reflects that bead's OWN
// priority — so a chip wired to a constant (or to the wrong bead) fails rather than passing.
describe("the priority chip on a card face", () => {
  function boardWith(beads: Bead[]): Board {
    return { backlog: beads, blocked: [], inProgress: [], done: [], delivered: [], archived: [] };
  }

  it("shows each backlog card's own priority, on the card and not just in the overlay", () => {
    const p0 = bead({ id: "p1-pri0", title: "Urgent one", priority: 0 });
    const p3 = bead({ id: "p1-pri3", title: "Someday", priority: 3 });
    snapshot = { beads: [p0, p3], board: boardWith([p0, p3]), loadedAt: Date.now() };
    render(<BoardView project={project} side="right" />);

    // Two chips, one per card, each carrying THAT card's priority — the wiring, not a constant.
    const chips = screen.getAllByTestId("bead-priority-chip");
    expect(chips).toHaveLength(2);
    const byPriority = chips.map((c) => c.getAttribute("data-priority"));
    expect(byPriority).toContain("0");
    expect(byPriority).toContain("3");
    // The label reads P0 for the urgent one — the collapsed card is where it now lives.
    const p0Chip = chips.find((c) => c.getAttribute("data-priority") === "0");
    expect(p0Chip?.textContent).toContain("P0");
  });

  it("renders P? for a card with no priority set (an unset priority is worth seeing, not hiding)", () => {
    const none = bead({ id: "p1-nopri", title: "Unprioritised" });
    snapshot = { beads: [none], board: boardWith([none]), loadedAt: Date.now() };
    render(<BoardView project={project} side="right" />);
    const chip = screen.getByTestId("bead-priority-chip");
    expect(chip.getAttribute("data-priority")).toBe("");
    expect(chip.textContent).toContain("P?");
  });
});

// ── Fix #4: THE ARCHIVED COLUMN ────────────────────────────────────────────────────────────────
// A far-right column for closed+archived beads, collapsed by default and render-capped so a
// ~1,800-bead pile never mounts eagerly.
describe("the archived column", () => {
  function boardWithArchived(archived: Bead[]): Board {
    return { backlog: [], blocked: [], inProgress: [], done: [], delivered: [], archived };
  }

  it("renders an Archived column header after Shipped", () => {
    snapshot = { beads: [], board, loadedAt: Date.now() };
    render(<BoardView project={project} side="right" />);
    const columns = screen.getByTestId("board-columns");
    const labels = Array.from(columns.querySelectorAll("[data-board-column]")).map((el) =>
      el.getAttribute("data-board-column"),
    );
    expect(labels).toEqual(["backlog", "blocked", "inProgress", "done", "delivered", "archived"]);
  });

  it("does NOT mount archived cards by default — it shows a count and an expand affordance", () => {
    const a1 = bead({ id: "p1-arc1", title: "Old junk one", status: "closed", labels: ["archived"] });
    const a2 = bead({ id: "p1-arc2", title: "Old junk two", status: "closed", labels: ["archived"] });
    snapshot = { beads: [a1, a2], board: boardWithArchived([a1, a2]), loadedAt: Date.now() };
    render(<BoardView project={project} side="right" />);
    // The SIDE EFFECT of "collapsed/lazy": the cards are NOT in the DOM.
    expect(screen.queryByText("Old junk one")).toBeNull();
    expect(screen.queryByText("Old junk two")).toBeNull();
    // ...but the way in is, and it names the count.
    const expand = screen.getByTestId("board-column-expand-archived");
    expect(expand.textContent).toContain("2");
  });

  it("mounts the cards once expanded", () => {
    const a1 = bead({ id: "p1-arc1", title: "Old junk one", status: "closed", labels: ["archived"] });
    snapshot = { beads: [a1], board: boardWithArchived([a1]), loadedAt: Date.now() };
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByText("Old junk one")).toBeNull();
    fireEvent.click(screen.getByTestId("board-column-expand-archived"));
    expect(screen.getByText("Old junk one")).toBeTruthy();
  });

  it("caps how many cards it mounts even when expanded, and counts the overflow", () => {
    // 60 archived beads, cap 50: expanding must mount at most the cap, never all 60.
    const many = Array.from({ length: 60 }, (_, i) =>
      bead({ id: `p1-arc-${i}`, title: `Archived ${i}`, status: "closed", labels: ["archived"] }),
    );
    snapshot = { beads: many, board: boardWithArchived(many), loadedAt: Date.now() };
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-column-expand-archived"));
    // The first card mounts; a card past the cap does not.
    expect(screen.getByText("Archived 0")).toBeTruthy();
    expect(screen.queryByText("Archived 59")).toBeNull();
    // The unrendered remainder is a count (60 - 50 = 10), never DOM nodes.
    expect(screen.getByTestId("board-column-overflow-archived").textContent).toContain("10");
  });
});
