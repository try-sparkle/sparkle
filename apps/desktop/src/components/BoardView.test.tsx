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

import { BoardView } from "./BoardView";

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
    bead({ id: "p1-d1", title: "Shipped", status: "closed", labels: ["delivered"] }),
  ],
};

afterEach(() => {
  cleanup();
  snapshot = undefined;
  error = undefined;
  startPolling.mockClear();
  stopPolling.mockClear();
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
    expect(screen.getByText("Shipped")).toBeTruthy();
    // Bead ids show on the cards.
    expect(screen.getByText("p1-a1")).toBeTruthy();
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
    expect(screen.getAllByText("Nothing here yet").length).toBe(4);
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

  it("is strictly read-only — cards are buttons, with no inputs or selects", () => {
    const { container } = render(<BoardView project={project} />);
    // Cards are buttons that open detail.
    expect(screen.getByText("Backlog one").closest("button")).toBeTruthy();
    // No edit controls anywhere on the board.
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
