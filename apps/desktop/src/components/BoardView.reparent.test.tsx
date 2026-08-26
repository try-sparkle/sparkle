// @vitest-environment jsdom
//
// apps/desktop/src/components/BoardView.reparent.test.tsx
//
// THE END-TO-END GESTURE, driven through the REAL board: tick two cards, choose an epic, click
// "Move to epic…", and assert exactly ONE `beads_reparent` invoke carrying both ids.
//
// ══ WHY THIS SUITE EXISTS ALONGSIDE `services/beadReparent.test.ts` ═══════════════════════════
// That suite proves the SERVICE batches. It cannot prove the BOARD reaches it: a checkbox that was
// never mounted, a bar wired to a different project id, or a "Move" button that loops over the
// selection calling the service once per bead would all leave it green. So nothing below is
// mocked between the click and the bridge — the real `BeadSelectCheckbox`, the real
// `beadSelectionStore`, the real `reparentBeads`, and `@tauri-apps/api/core` at the very bottom.
// The one mock in that path is `invoke` itself, which is where the assertion lives.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bead, Board } from "../services/beads";
import type { Project } from "../types";

// ── The bridge. THE ASSERTION TARGET — everything above it is production code. ────────────────
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

// ── The beads store: no polling, no bd. `refresh` is a spy because the forced re-read after a
//    move is itself a side effect this suite asserts. ─────────────────────────────────────────
const startPolling = vi.fn();
const stopPolling = vi.fn();
const refresh = vi.fn(async () => {});
let snapshot: { beads: Bead[]; board: Board; loadedAt: number } | undefined;

function buildState() {
  return {
    byProject: { p1: snapshot } as Record<string, typeof snapshot>,
    loading: {} as Record<string, boolean>,
    error: {} as Record<string, string | undefined>,
    startPolling,
    stopPolling,
    refresh,
  };
}
vi.mock("../stores/beadsStore", () => {
  const useBeadsStore = ((selector?: (s: ReturnType<typeof buildState>) => unknown) => {
    const state = buildState();
    return selector ? selector(state) : state;
  }) as unknown as { (sel?: unknown): unknown; getState: () => ReturnType<typeof buildState> };
  useBeadsStore.getState = () => buildState();
  return { useBeadsStore };
});

// ── Everything else the board pulls in that would otherwise reach Tauri. ─────────────────────
vi.mock("../services/sendToBuild", () => ({
  sendToBuild: vi.fn(),
  sendToBuildBlockedReason: () => null,
}));
vi.mock("../services/config", () => ({
  getConfig: vi.fn(async () => ({
    config: {
      done: { description: null, criteria: [] },
      delivered: {
        description: null,
        detected_method: null,
        confidence: null,
        confidence_note: null,
        learned: false,
        criteria: [],
      },
    },
    warnings: [],
  })),
  onConfigChanged: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../services/deliveryMonitor", () => ({
  startDeliveryMonitor: vi.fn(),
  stopDeliveryMonitor: vi.fn(),
}));
vi.mock("./DefineStageModal", () => ({ DefineStageModal: () => null }));
// Keep every real beads helper — `epicIndexOf` / `isEpicIndexed` / `epicDisplayTitle` are what the
// epic picker is built from, so stubbing them would test a picker nothing populates. Only the bd
// WRITE wrappers are stubbed, and none of them is on this gesture's path.
vi.mock("../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beads")>();
  return {
    ...actual,
    claimBead: vi.fn().mockResolvedValue(undefined),
    labelBead: vi.fn().mockResolvedValue(undefined),
    closeBead: vi.fn().mockResolvedValue(undefined),
    markBeadDelivered: vi.fn().mockResolvedValue(undefined),
  };
});

import { BoardView } from "./BoardView";
import { bucketBeads } from "../services/beads";
import { useBeadSelectionStore } from "../stores/beadSelectionStore";
import { useProjectStore } from "../stores/projectStore";

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
    commentCount: 0,
    ...partial,
  };
}

/** Two loose tasks and one epic to consolidate them under — the founder's actual shape: beads
 *  filed separately, grouped once the theme is clear. */
const BEADS: Bead[] = [
  bead({ id: "p1-a1", title: "Loose one" }),
  bead({ id: "p1-a2", title: "Loose two" }),
  bead({ id: "p1-a3", title: "Loose three" }),
  bead({ id: "p1-epic", title: "The larger theme", type: "epic" }),
];

/** Mount the board and turn SELECT MODE on, through the real toggle.
 *
 *  The ticks are opt-in by design: the collapsed board holds no `input` at all until the user asks
 *  for one (see `beadSelectionStore.selectMode`). Every test below therefore goes through the same
 *  door the user does — clicking `board-select-mode` — rather than seeding the store, so a toggle
 *  that stopped mounting the checkboxes would fail here instead of passing on injected state. */
function mountBoard(beads: Bead[] = BEADS) {
  snapshot = { beads, board: bucketBeads(beads), loadedAt: Date.now() };
  const r = render(<BoardView project={project} side="left" />);
  fireEvent.click(screen.getByTestId("board-select-mode"));
  // THE CLICK IS A TOGGLE, so this helper's postcondition is not "clicked" but "the ticks are on
  // screen". `selectMode` lives in a module-level store shared by every test in this file, so a
  // helper that only clicks would silently turn the ticks OFF for any test that inherited an
  // already-on mode — and the failure would surface several lines later, inside a test whose real
  // subject is the batching, as a missing checkbox. Assert the door opened here instead, where the
  // message names the door. Non-vacuous in its own right: it is the assertion that the toggle is
  // what mounts the checkboxes, which is the whole reason these tests do not seed the store.
  // Keyed off `beads[0]` rather than a literal "p1-a1": this helper takes a beads argument, so a
  // caller passing its own set would otherwise fail here as a missing checkbox rather than mount.
  expect(screen.getByTestId(`board-card-select-${beads[0]!.id}`)).toBeTruthy();
  return r;
}

/** Tick a card by bead id, through the real checkbox the board renders. */
function tick(id: string) {
  fireEvent.click(screen.getByTestId(`board-card-select-${id}`));
}

afterEach(() => {
  cleanup();
  snapshot = undefined;
  invokeMock.mockReset();
  refresh.mockClear();
  startPolling.mockClear();
  stopPolling.mockClear();
  // BOTH HALVES OF THE STORE. zustand's `setState` MERGES, so naming only `selected` leaves the
  // previous test's `selectMode` in place — and the mode is what decides whether the per-card ticks
  // are mounted at all, i.e. whether the next test's `mountBoard()` click turns them on or off.
  // A suite whose starting state depends on the test before it is not testing the component.
  useBeadSelectionStore.setState({ selected: {}, selectMode: {} });
  useProjectStore.setState({ projects: [], selectedProjectId: null });
});

describe("BoardView — consolidating beads under an epic", () => {
  it("puts NO checkbox on the resting board — the ticks are opt-in", () => {
    // The rule `BoardView.test.tsx` states for the whole surface, asserted here from the other
    // side: this feature must not be what puts an input on a board nobody asked to edit.
    snapshot = { beads: BEADS, board: bucketBeads(BEADS), loadedAt: Date.now() };
    const { container } = render(<BoardView project={project} side="left" />);
    expect(container.querySelector("input")).toBeNull();
    expect(screen.queryByTestId("board-card-select-p1-a1")).toBeNull();
    // …and the toggle is what brings them out.
    fireEvent.click(screen.getByTestId("board-select-mode"));
    expect(screen.getByTestId("board-card-select-p1-a1")).toBeTruthy();
  });

  it("leaving select mode drops the selection, so no tick is left invisible and live", () => {
    mountBoard();
    tick("p1-a1");
    tick("p1-a2");
    fireEvent.click(screen.getByTestId("board-select-mode")); // off again
    expect(screen.queryByTestId("board-selection-bar")).toBeNull();
    expect(useBeadSelectionStore.getState().selectionFor("p1")).toEqual([]);
  });

  it("has no selection bar until a card is ticked", () => {
    mountBoard();
    expect(screen.queryByTestId("board-selection-bar")).toBeNull();
    tick("p1-a1");
    expect(screen.getByTestId("board-selection-bar")).toBeTruthy();
    expect(screen.getByTestId("board-selection-count").textContent).toBe("1 bead selected");
  });

  it("moves a MULTI-bead selection in ONE invoke carrying every id", async () => {
    // ══ THE LOAD-BEARING ASSERTION OF THIS WHOLE BRANCH ═══════════════════════════════════════
    // Three ticks, one call. A "Move" handler that looped `reparentBeads` per bead would satisfy
    // "the beads moved" and every selection-state assertion, and would still be the defect the
    // Rust contract exists to prevent — so the count is asserted, not just the arguments.
    invokeMock.mockResolvedValue(undefined);
    mountBoard();
    tick("p1-a1");
    tick("p1-a2");
    tick("p1-a3");
    expect(screen.getByTestId("board-selection-count").textContent).toBe("3 beads selected");

    fireEvent.change(screen.getByTestId("board-selection-epic"), {
      target: { value: "p1-epic" },
    });
    fireEvent.click(screen.getByTestId("board-selection-move"));

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("beads_reparent", {
      projectPath: "/tmp/demo",
      ids: ["p1-a1", "p1-a2", "p1-a3"],
      parent: "p1-epic",
    });
  });

  it("forces a beads refresh so the new parent edge is on screen without waiting for the poll", async () => {
    // The poll's cadence is derived and capped at 60s, so "the poll will carry it" is up to a
    // minute of the board showing the OLD parent after a click that reported success.
    invokeMock.mockResolvedValue(undefined);
    mountBoard();
    tick("p1-a1");
    fireEvent.change(screen.getByTestId("board-selection-epic"), {
      target: { value: "p1-epic" },
    });
    refresh.mockClear(); // the board refreshes on mount too; only the post-move one is the claim
    fireEvent.click(screen.getByTestId("board-selection-move"));

    await waitFor(() => expect(refresh).toHaveBeenCalledWith("p1", "/tmp/demo"));
  });

  it("clears the selection once a move lands", async () => {
    invokeMock.mockResolvedValue(undefined);
    mountBoard();
    tick("p1-a1");
    tick("p1-a2");
    fireEvent.change(screen.getByTestId("board-selection-epic"), {
      target: { value: "p1-epic" },
    });
    fireEvent.click(screen.getByTestId("board-selection-move"));

    await waitFor(() => expect(screen.queryByTestId("board-selection-bar")).toBeNull());
    expect(useBeadSelectionStore.getState().selectionFor("p1")).toEqual([]);
  });

  it("unparents a MULTI-bead selection in ONE invoke, with the empty-string parent", async () => {
    invokeMock.mockResolvedValue(undefined);
    mountBoard();
    tick("p1-a1");
    tick("p1-a2");
    fireEvent.click(screen.getByTestId("board-selection-unparent"));

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("beads_reparent", {
      projectPath: "/tmp/demo",
      ids: ["p1-a1", "p1-a2"],
      parent: "",
    });
  });

  it("unparenting needs NO epic chosen — the picker is not the unparent path", async () => {
    // The gesture the founder needs after a bad grouping. If Unparent were wired through the
    // picker's value it would refuse here, which is precisely why the service has two entry points.
    invokeMock.mockResolvedValue(undefined);
    mountBoard();
    tick("p1-a1");
    expect((screen.getByTestId("board-selection-epic") as HTMLSelectElement).value).toBe("");
    fireEvent.click(screen.getByTestId("board-selection-unparent"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({ parent: "" });
  });

  it("refuses a Move with no epic chosen, and sends NOTHING", async () => {
    // A blank parent is bd's "remove parent". Reaching the bridge with one would silently detach
    // the selection under a button labelled "Move to epic…" — so the guard is asserted by the
    // ABSENCE of an invoke, not by the message alone.
    mountBoard();
    tick("p1-a1");
    fireEvent.click(screen.getByTestId("board-selection-move"));

    await waitFor(() => expect(screen.getByTestId("board-selection-note")).toBeTruthy());
    expect(screen.getByTestId("board-selection-note").textContent).toMatch(/choose an epic/i);
    expect(invokeMock).not.toHaveBeenCalled();
    // …and the ticks survive, so the fix is "choose an epic", not "find those cards again".
    expect(useBeadSelectionStore.getState().selectionFor("p1")).toEqual(["p1-a1"]);
  });

  it("shows bd's own message and KEEPS the selection when a move fails", async () => {
    invokeMock.mockRejectedValue({ kind: "storeBusy", message: "beads store is busy", exitCode: 1 });
    mountBoard();
    tick("p1-a1");
    tick("p1-a2");
    fireEvent.change(screen.getByTestId("board-selection-epic"), {
      target: { value: "p1-epic" },
    });
    fireEvent.click(screen.getByTestId("board-selection-move"));

    await waitFor(() =>
      expect(screen.getByTestId("board-selection-note").textContent).toContain(
        "beads store is busy",
      ),
    );
    // Retained: re-ticking several cards across a scrolled board is the expensive half of a retry.
    expect(useBeadSelectionStore.getState().selectionFor("p1")).toEqual(["p1-a1", "p1-a2"]);
    expect(refresh).not.toHaveBeenCalledWith("p1", "/tmp/demo");
  });

  it("offers the board's epics in the picker, keyed by id", () => {
    mountBoard();
    tick("p1-a1");
    const picker = screen.getByTestId("board-selection-epic") as HTMLSelectElement;
    const values = Array.from(picker.options).map((o) => o.value);
    expect(values).toContain("p1-epic");
    // The prompt option, which is NOT the unparent path.
    expect(values[0]).toBe("");
  });

  it("unticking a card takes it back out of the batch", async () => {
    invokeMock.mockResolvedValue(undefined);
    mountBoard();
    tick("p1-a1");
    tick("p1-a2");
    tick("p1-a1"); // untick
    fireEvent.change(screen.getByTestId("board-selection-epic"), {
      target: { value: "p1-epic" },
    });
    fireEvent.click(screen.getByTestId("board-selection-move"));

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({ ids: ["p1-a2"] });
  });

  it("ticking a card does not open its detail overlay", () => {
    // The checkbox is a SIBLING of the card's body button for this reason. If it were nested (or
    // its click bubbled), every tick would also open the card and bury the bar behind a scrim.
    mountBoard();
    tick("p1-a1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
