// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead, Board } from "../services/beads";
import type { Project } from "../types";

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

vi.mock("../services/sendToBuild", () => ({ sendToBuild: vi.fn() }));

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

import { BoardView } from "./BoardView";
import { sendToBuild } from "../services/sendToBuild";
import { claimBead, labelBead, closeBead, markBeadDelivered } from "../services/beads";
import { useCriteriaStore } from "../services/criteriaStore";
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
  inProgress: [bead({ id: "p1-b1", title: "Doing now", status: "in_progress" })],
  done: [bead({ id: "p1-c1", title: "Finished", status: "closed" })],
  delivered: [
    bead({ id: "p1-d1", title: "Delivered task", status: "closed", labels: ["delivered"] }),
  ],
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
  useCriteriaStore.setState({ ticks: {} });
});

beforeEach(() => {
  snapshot = { beads: [], board, loadedAt: Date.now() };
  error = undefined;
});

describe("BoardView", () => {
  it("starts polling on mount and stops on unmount", () => {
    const { unmount } = render(<BoardView project={project} />);
    expect(startPolling).toHaveBeenCalledWith("p1", "/tmp/demo");
    unmount();
    expect(stopPolling).toHaveBeenCalledWith("p1");
  });

  it("renders the four columns with their cards bucketed correctly", () => {
    render(<BoardView project={project} />);
    // Column headers (count rendered alongside).
    expect(screen.getByText("Backlog")).toBeTruthy();
    expect(screen.getByText("In Progress")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Delivered")).toBeTruthy();
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
    render(<BoardView project={project} />);
    // short stage labels: open→Planned, in_progress→Unsaved, closed→Merged, delivered→Shipped.
    expect(screen.getAllByText("Planned").length).toBeGreaterThanOrEqual(2); // two backlog beads
    expect(screen.getByText("Unsaved")).toBeTruthy(); // the in-progress bead
    expect(screen.getByText("Merged")).toBeTruthy(); // the done bead
    expect(screen.getByText("Shipped")).toBeTruthy(); // the delivered bead
  });

  it("shows the loading state when there is no snapshot yet", () => {
    snapshot = undefined;
    render(<BoardView project={project} />);
    expect(screen.getByText("Loading tasks…")).toBeTruthy();
  });

  it("shows an empty-column hint and keeps a prior snapshot visible on error", () => {
    snapshot = {
      beads: [],
      board: { backlog: [], inProgress: [], done: [], delivered: [] },
      loadedAt: Date.now(),
    };
    error = "bd blew up";
    render(<BoardView project={project} />);
    // Error surfaces but the (empty) board still renders.
    expect(screen.getByText("bd blew up")).toBeTruthy();
    // Backlog + In Progress show the empty hint; undefined Done/Delivered show the Define CTA instead.
    expect(screen.getAllByText("Nothing here yet").length).toBe(2);
    expect(screen.getByText("Define “Done”")).toBeTruthy();
    expect(screen.getByText("Define “Delivered”")).toBeTruthy();
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
        inProgress: [],
        done: [],
        delivered: [],
      },
      loadedAt: Date.now(),
    };
    // Raw-textContent matcher: the description preserves newlines (whiteSpace: pre-wrap), so we
    // match the literal string rather than the whitespace-normalized form getByText uses.
    const fullDesc = (_: string, el: Element | null) => el?.textContent === long;
    render(<BoardView project={project} />);
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

  it("has no free-form edit controls — no inputs, selects, or textareas", () => {
    const { container } = render(<BoardView project={project} />);
    // No edit controls anywhere on the board (buttons exist: cards open detail, epics get Start).
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    // Opening detail still introduces no inputs/selects.
    fireEvent.click(screen.getByText("Backlog one"));
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("counts each column", () => {
    render(<BoardView project={project} />);
    // Backlog header lives in a row that also shows its count (2). Scope the lookup to that header.
    const backlogHeader = screen.getByText("Backlog").parentElement as HTMLElement;
    expect(within(backlogHeader).getByText("2")).toBeTruthy();
  });
});

describe("BoardView — Build It (epic handoff)", () => {
  function epicSnapshot(description: string) {
    return {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-e1", title: "Build the app", type: "epic", description })],
        inProgress: [],
        done: [],
        delivered: [],
      },
      loadedAt: Date.now(),
    };
  }

  it("shows the status pill + Build It on an epic and hands off with the parsed PRD path", () => {
    snapshot = epicSnapshot("Ship the app.\n\nPRD file: PRD/2026-06-27-build-the-app.md");
    render(<BoardView project={project} />);
    fireEvent.click(screen.getByText("Build the app")); // open the epic's detail overlay
    expect(screen.getByText("not started")).toBeTruthy(); // rollup of an epic with no children
    // The backlog card ALSO carries a "Build It" (renamed from Start), so scope the click to the
    // overlay's status row — the "not started" pill and the overlay's Build It button are siblings.
    const statusRow = screen.getByText("not started").parentElement as HTMLElement;
    fireEvent.click(within(statusRow).getByText("Build It"));
    expect(sendToBuild).toHaveBeenCalledWith({
      projectId: "p1",
      epicId: "p1-e1",
      prdPath: "PRD/2026-06-27-build-the-app.md",
    });
  });

  it("hands off a PRD-less epic with prdPath null (no longer blocks)", () => {
    // The "no linked PRD" hard block was removed (unify Build It affordances): a PRD-less epic now
    // hands off with prdPath null and sendToBuild seeds off `bd show <epicId>` instead of blocking.
    snapshot = epicSnapshot("no PRD link in this body");
    render(<BoardView project={project} />);
    fireEvent.click(screen.getByText("Build the app"));
    const statusRow = screen.getByText("not started").parentElement as HTMLElement;
    fireEvent.click(within(statusRow).getByText("Build It"));
    expect(sendToBuild).toHaveBeenCalledWith({ projectId: "p1", epicId: "p1-e1", prdPath: null });
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
        inProgress: over.withChild === false ? [] : [child],
        done: [],
        delivered: [],
      },
      loadedAt: Date.now(),
    };
  }

  it("claims the epic then hands off to Build with the parsed PRD path", async () => {
    startSnapshot({});
    render(<BoardView project={project} />);
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
    render(<BoardView project={project} />);
    fireEvent.click(screen.getByText("Build It"));
    await waitFor(() => expect(sendToBuild).toHaveBeenCalled());
    expect(sendToBuild).toHaveBeenCalledWith({ projectId: "p1", epicId: "p1-e1", prdPath: null });
  });

  it("disables Start (tooltip decomposing…) while the epic has zero children", () => {
    startSnapshot({ withChild: false });
    render(<BoardView project={project} />);
    const start = screen.getByText("Build It") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toContain("decomposing…");
    fireEvent.click(start);
    expect(claimBead).not.toHaveBeenCalled();
    expect(sendToBuild).not.toHaveBeenCalled();
  });

  it("disables Start and shows a click-to-clear badge while labeled decomposing", async () => {
    startSnapshot({ labels: ["decomposing"] });
    render(<BoardView project={project} />);
    expect((screen.getByText("Build It") as HTMLButtonElement).disabled).toBe(true);
    // The badge itself clears the label (the user's way out of a stuck decompose).
    fireEvent.click(screen.getByText("decomposing…"));
    await waitFor(() =>
      expect(labelBead).toHaveBeenCalledWith("/tmp/demo", "remove", "p1-e1", "decomposing"),
    );
  });

  it("shows a decompose-failed chip whose click clears the label so the next sweep retries", async () => {
    startSnapshot({ labels: ["decompose-failed"] });
    render(<BoardView project={project} />);
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
        inProgress: [bead({ id: "p1-e2", title: "Running epic", type: "epic" })],
        done: [],
        delivered: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} />);
    expect(screen.queryByText("Build It")).toBeNull();
  });
});

describe("BoardView — Definable Done & Delivered (Unit 5)", () => {
  it("shows the Define CTA for an undefined Done column and NOT for Backlog/In Progress", async () => {
    render(<BoardView project={project} />);
    await waitFor(() => expect(getConfig).toHaveBeenCalledWith("/tmp/demo"));
    // Undefined Done/Delivered → centered blue Define CTA in the column body.
    expect(screen.getByText("Define “Done”")).toBeTruthy();
    expect(screen.getByText("Define “Delivered”")).toBeTruthy();
    // The inert columns never get a Define affordance.
    expect(screen.queryByText("Define “Backlog”")).toBeNull();
    expect(screen.queryByText("Define “In Progress”")).toBeNull();
  });

  it("opens the Define modal for the matching stage when a Done/Delivered header is clicked", async () => {
    render(<BoardView project={project} />);
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
    render(<BoardView project={project} />);
    await waitFor(() => expect(screen.getByText("Define “Delivered”")).toBeTruthy());
    fireEvent.click(screen.getByText("Define “Delivered”"));
    expect(screen.getByTestId("define-modal").textContent).toContain("define-modal:delivered");
  });

  it("shows a defined-column status chip and no Define CTA once Done is defined", async () => {
    defineDone();
    snapshot = {
      beads: [],
      board: { backlog: [], inProgress: [], done: [], delivered: [] },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} />);
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
        inProgress: [],
        done: [],
        delivered: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} />);
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
        inProgress: [],
        done: [],
        delivered: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} />);
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
        inProgress: [],
        done: [bead({ id: "p1-d9", title: "Landed feature", status: "closed" })],
        delivered: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} />);
    await waitFor(() => expect(screen.getByText("0 of 1")).toBeTruthy());
    fireEvent.click(screen.getByText("0 of 1"));
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    fireEvent.click(await screen.findByText("Mark as Delivered"));
    await waitFor(() => expect(markBeadDelivered).toHaveBeenCalledWith("/tmp/demo", "p1-d9"));
    expect(closeBead).not.toHaveBeenCalled();
  });

  it("starts the delivery monitor only once Delivered is defined, and stops it on unmount", async () => {
    defineDelivered();
    const { unmount } = render(<BoardView project={project} />);
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
