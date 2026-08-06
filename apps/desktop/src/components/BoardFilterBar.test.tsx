// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BoardFilterBar } from "./BoardFilterBar";
import { useUiStore } from "../stores/uiStore";
import { NO_BOARD_FILTER } from "../services/boardFilters";
import { dismissibleSurfaceOpen, isInsideCircuit } from "../engine/cable";

afterEach(() => {
  cleanup();
  useUiStore.getState().setBoardFilter("right", NO_BOARD_FILTER);
});

const filter = () => useUiStore.getState().boardFilterBySide.right;

function openMenu(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
  return screen.getByTestId(`${testId}-menu`);
}

describe("BoardFilterBar — picking a filter WRITES it to the store", () => {
  // The side effect, not the render: a bar that showed four options and stored nothing would pass
  // any "the option is on screen" assertion while filtering exactly nothing.
  it("writes the chosen priority", () => {
    render(<BoardFilterBar side="right" />);
    const menu = openMenu("board-filter-priority");
    fireEvent.click(within(menu, "P0: Do it now"));
    expect(filter().priority).toBe(0);
  });

  it("writes the chosen date window", () => {
    render(<BoardFilterBar side="right" />);
    const menu = openMenu("board-filter-window");
    fireEvent.click(within(menu, "Last 7 days"));
    expect(filter().dateWindow).toBe("7d");
  });

  it("writes the created/updated switch", () => {
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, dateWindow: "24h" });
    render(<BoardFilterBar side="right" />);
    const menu = openMenu("board-filter-field");
    fireEvent.click(within(menu, "By created"));
    expect(filter().dateField).toBe("created");
  });

  it("keys the write by SIDE, so the other board is untouched", () => {
    render(<BoardFilterBar side="right" />);
    fireEvent.click(within(openMenu("board-filter-priority"), "P0: Do it now"));
    expect(filter().priority).toBe(0);
    expect(useUiStore.getState().boardFilterBySide.left.priority).toBeNull();
  });
});

describe("BoardFilterBar — the controls reflect and clear state", () => {
  it("hides the created/updated switch until a window is chosen", () => {
    render(<BoardFilterBar side="right" />);
    // "Any date" — the switch would select which date a filter that is not running would measure.
    expect(screen.queryByTestId("board-filter-field")).toBeNull();

    cleanup();
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, dateWindow: "24h" });
    render(<BoardFilterBar side="right" />);
    expect(screen.getByTestId("board-filter-field")).toBeTruthy();
  });

  it("shows Clear only while something is filtered, and Clear resets every axis", () => {
    render(<BoardFilterBar side="right" />);
    expect(screen.queryByTestId("board-filter-clear")).toBeNull();

    cleanup();
    useUiStore
      .getState()
      .setBoardFilter("right", { priority: 1, dateField: "created", dateWindow: "30d" });
    render(<BoardFilterBar side="right" />);

    fireEvent.click(screen.getByTestId("board-filter-clear"));
    expect(filter()).toEqual(NO_BOARD_FILTER);
    // And the affordance goes away with the filter it cleared.
    expect(screen.queryByTestId("board-filter-clear")).toBeNull();
  });

  // ── P4 IS REAL, AND THE FILTER HAS TO REACH IT ──────────────────────────────────────────────
  // bd's domain is 0-4 (AGENTS.md; scripts/lib/retro-beads.sh), and the retro pain-point path files
  // at P4 by default, so the backlog genuinely holds them. Capping the filter at P3 — as it shipped
  // in the first commit, caught by roborev 59043 — left those beads reachable only by clearing the
  // filter, which is a control that looks complete while hiding rows.
  //
  // The EDITABLE pill is deliberately narrower (the founder specified exactly four options); this
  // asserts the filter side only.
  it("offers every priority bd can emit, P4 included, and writes it", () => {
    render(<BoardFilterBar side="right" />);
    const menu = openMenu("board-filter-priority");
    const labels = Array.from(menu.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(labels).toEqual([
      "Any priority",
      "P0: Do it now",
      "P1: Do it next",
      "P2: Do it when most efficient",
      "P3: Do it when cycles are available",
      "P4: Backlog",
    ]);
    fireEvent.click(within(menu, "P4: Backlog"));
    expect(filter().priority).toBe(4);
  });

  it("labels the trigger with the active value, not the generic word", () => {
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 2 });
    render(<BoardFilterBar side="right" />);
    expect(screen.getByTestId("board-filter-priority").textContent).toContain("P2");
  });
});

describe("BoardFilterBar — the menu dismisses", () => {
  it("closes on Escape without writing anything", () => {
    render(<BoardFilterBar side="right" />);
    openMenu("board-filter-priority");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("board-filter-priority-menu")).toBeNull();
    expect(filter()).toEqual(NO_BOARD_FILTER);
  });

  it("leaves a key another layer already consumed alone", () => {
    render(<BoardFilterBar side="right" />);
    openMenu("board-filter-priority");
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    e.preventDefault(); // a deeper layer claimed this press
    window.dispatchEvent(e);
    // Still open — one press peels one layer, and this one was not ours.
    expect(screen.getByTestId("board-filter-priority-menu")).toBeTruthy();
  });
});

/** Find a button by its text inside a container. The menu is portaled, so a plain getByText would
 *  also match the trigger's own label for options like "P2". */
function within(container: HTMLElement, text: string): HTMLElement {
  const hit = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!hit) throw new Error(`no button "${text}" in menu`);
  return hit;
}

// ══ THE PORTALED PANEL MUST CARRY BOTH CABLE MARKERS ═══════════════════════════════════════════
// knightwatch probe 5199421526#1. `engine/cable.ts` answers two questions from the DOM:
//   * "did this press leave the circuit?" — by ANCESTRY (`closest`), and a portaled panel is a
//     sibling of the whole app, so without `data-circuit` a click on a filter option reads as a
//     press outside the circuit and unbinds the concierge alongside the filter it set;
//   * "is a surface that owns Escape open?" — by `DISMISSIBLE_SELECTOR`, so without a marker one
//     Escape both closes the menu and drops the cable.
// Only the BACKDROP was marked. `PriorityPill` marks both, which is why this is drift, not a gap.
describe("BoardFilterBar — the menu is part of the live circuit", () => {
  it("marks the portaled PANEL (not just the backdrop) as circuit + dismissible", () => {
    render(<BoardFilterBar side="right" />);
    const panel = openMenu("board-filter-priority");

    expect(panel.hasAttribute("data-circuit")).toBe(true);
    expect(isInsideCircuit(panel)).toBe(true);
    // A press on an OPTION — the thing a user actually clicks — is inside the circuit too.
    const option = within(panel, "P0: Do it now");
    expect(isInsideCircuit(option)).toBe(true);
  });

  it("makes the cable see an open menu, so Escape does not unbind", () => {
    render(<BoardFilterBar side="right" />);
    expect(dismissibleSurfaceOpen(document)).toBe(false);
    openMenu("board-filter-priority");
    expect(dismissibleSurfaceOpen(document)).toBe(true);
  });
});
