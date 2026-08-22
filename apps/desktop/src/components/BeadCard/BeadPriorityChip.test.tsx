// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// THE WRITE IS MOCKED AT THE MODULE, NOT INJECTED AS A PROP. A `write` prop defaulting to the real
// `setBeadPriority` would leave the line that supplies the real one covered by nothing — delete it
// and this suite stays green while the chip saves nowhere (AGENTS.md, "a defaulted seam every test
// injects"). `importOriginal` keeps the vocabulary (`priorityShort`, `isUrgentPriority`,
// `PRIORITY_OPTIONS`) real, so only the one round trip is faked.
const setBeadPriority = vi.fn();
vi.mock("./beadPriority", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./beadPriority")>();
  return { ...actual, setBeadPriority: (...a: unknown[]) => setBeadPriority(...a) };
});

import { BeadPriorityChip } from "./BeadPriorityChip";
import { PRIORITY_OPTIONS } from "./beadPriority";

// BRACED BODY, DELIBERATELY. `mockReset()` is chainable, so a concise arrow returns the mock and
// vitest treats a function returned by `beforeEach` as a TEARDOWN callback — calling the mock after
// every test with whatever implementation that test installed. See `beadPriority.test.ts`.
beforeEach(() => {
  setBeadPriority.mockReset();
  setBeadPriority.mockResolvedValue(undefined);
});
afterEach(cleanup);

const ROOT = "/repo";
const ID = "sparkle-qogah";

/**
 * The chip inside a row that is itself a `<button>` — which is what BOTH real call sites are: the
 * epic row in `EpicsColumn` and the card face in `BoardView`. `rowOpen` exists because the founder
 * asked for this to work "whether the row is open or closed", so every interaction test runs twice.
 */
function harness(rowOpen: boolean, onRowClick = vi.fn(), priority: number | undefined = 2) {
  render(
    <button data-testid="row" onClick={onRowClick} aria-pressed={rowOpen}>
      <span data-testid="row-title">an epic</span>
      <BeadPriorityChip priority={priority} beadId={ID} projectPath={ROOT} />
      {rowOpen && <span data-testid="row-body">the opened card body</span>}
    </button>,
  );
  return onRowClick;
}

const chip = () => screen.getByTestId("bead-priority-chip");

// ── 1. THE READOUT IS UNCHANGED ────────────────────────────────────────────────────────────────
// These predate the control and still pin what the founder asked to SEE: the bead's own level, and
// the urgent band (P0/P1) visually distinct from the rest. Assertions are on the rendered OUTPUT.

describe("BeadPriorityChip — the readout", () => {
  it("renders the level it was given", () => {
    render(<BeadPriorityChip priority={0} />);
    expect(chip().getAttribute("data-priority")).toBe("0");
    expect(chip().textContent).toContain("P0");
  });

  it("shows P? for an unset priority rather than rendering nothing", () => {
    render(<BeadPriorityChip priority={undefined} />);
    expect(chip().getAttribute("data-priority")).toBe("");
    expect(chip().textContent).toContain("P?");
  });

  it("paints the URGENT band (P0/P1) differently from a low priority — the 'red descending' cue", () => {
    // Two chips, and the SIDE EFFECT is that their dot colours differ: an urgent bead is marked, a
    // low one is not. Comparing the two (rather than pinning a hex jsdom would normalise) keeps the
    // test about the banding, so flattening every level to one colour fails it.
    const { container: urgentC } = render(<BeadPriorityChip priority={0} testId="chip-urgent" />);
    const urgentDot = within(urgentC).getByTestId("chip-urgent").querySelector("span[aria-hidden]");
    const urgentColor = (urgentDot as HTMLElement).style.background;

    const { container: calmC } = render(<BeadPriorityChip priority={3} testId="chip-calm" />);
    const calmDot = within(calmC).getByTestId("chip-calm").querySelector("span[aria-hidden]");
    const calmColor = (calmDot as HTMLElement).style.background;

    expect(urgentColor).not.toBe("");
    expect(urgentColor).not.toBe(calmColor);
  });

  it("treats P1 as urgent and P2 as not — the band boundary the app already uses", () => {
    const { container: p1C } = render(<BeadPriorityChip priority={1} testId="chip-p1" />);
    const p1Color = (
      within(p1C).getByTestId("chip-p1").querySelector("span[aria-hidden]") as HTMLElement
    ).style.background;
    const { container: p2C } = render(<BeadPriorityChip priority={2} testId="chip-p2" />);
    const p2Color = (
      within(p2C).getByTestId("chip-p2").querySelector("span[aria-hidden]") as HTMLElement
    ).style.background;
    expect(p1Color).not.toBe(p2Color);
  });
});

// ── 2. AN ABSENT PROJECT IS AN ABSENT AFFORDANCE ───────────────────────────────────────────────

describe("BeadPriorityChip — editing is opt-in", () => {
  it("stays the inert readout when it is given no bead and no project", () => {
    render(<BeadPriorityChip priority={2} />);
    expect(chip().getAttribute("role")).toBeNull();
    expect(chip().getAttribute("tabindex")).toBeNull();
    fireEvent.click(chip());
    expect(screen.queryByTestId("bead-priority-chip-menu")).toBeNull();
  });

  // HALF-CONFIGURED IS NOT CONFIGURED. A chip that can name a bead but not a store cannot write, so
  // offering the menu would promise a save it cannot make.
  it("stays inert when only half the write target is supplied", () => {
    render(<BeadPriorityChip priority={2} beadId={ID} projectPath={null} />);
    fireEvent.click(chip());
    expect(screen.queryByTestId("bead-priority-chip-menu")).toBeNull();
    expect(setBeadPriority).not.toHaveBeenCalled();
  });

  it("becomes a keyboard-reachable control once both halves are supplied", () => {
    render(<BeadPriorityChip priority={2} beadId={ID} projectPath={ROOT} />);
    expect(chip().getAttribute("role")).toBe("button");
    expect(chip().getAttribute("tabindex")).toBe("0");
    // NOT a <button>: both call sites render this inside a row that IS one, and a nested button is
    // invalid HTML browsers reflow unpredictably.
    expect(chip().tagName).toBe("SPAN");
  });
});

// ── 3. THE WRITE — THE SIDE EFFECT, NOT THE MENU ROW ───────────────────────────────────────────

describe.each([
  ["row closed", false],
  ["row open", true],
] as const)("BeadPriorityChip — picking a priority (%s)", (_label, rowOpen) => {
  it("writes the picked level through setBeadPriority", async () => {
    harness(rowOpen);
    fireEvent.click(chip());
    fireEvent.click(screen.getByTestId("bead-priority-chip-option-0"));
    await waitFor(() => expect(setBeadPriority).toHaveBeenCalledWith(ROOT, ID, 0));
  });

  // P0 IS THE ONE A FALSY SLIP WOULD DROP, and it is also the level most worth setting from a
  // board. Asserted separately from the row above so "writes something" cannot stand in for it.
  it("writes P0 as the number 0, not as an omission", async () => {
    harness(rowOpen, vi.fn(), 3);
    fireEvent.click(chip());
    fireEvent.click(screen.getByTestId("bead-priority-chip-option-0"));
    await waitFor(() => expect(setBeadPriority.mock.calls[0]?.[2]).toBe(0));
  });

  it("opens the menu on click in this row state", () => {
    harness(rowOpen);
    fireEvent.click(chip());
    expect(screen.getByTestId("bead-priority-chip-menu")).toBeTruthy();
  });
});

// ── 4. THE CLICK MUST NOT REACH THE ROW — AND ITS PAIR ─────────────────────────────────────────
// "Clicking on the priority chicklet should not open the row but it should just change the
// priority." One test proving ABSENCE is ambiguous — a chip that rendered nothing at all would pass
// it — so each row here is paired with the same gesture landing OUTSIDE the chip, which MUST reach
// the row. The pair is what pins the cause.

describe.each([
  ["row closed", false],
  ["row open", true],
] as const)("BeadPriorityChip — the press is contained (%s)", (_label, rowOpen) => {
  it("does not fire the row's handler when the chip is clicked", () => {
    const onRowClick = harness(rowOpen);
    fireEvent.click(chip());
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("DOES fire the row's handler when the click lands outside the chip", () => {
    const onRowClick = harness(rowOpen);
    fireEvent.click(screen.getByTestId("row-title"));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  // `pointerdown`/`mousedown` FIRE FIRST and row-level handlers do listen there (the board's
  // overlay dismissal is a mousedown guard), so a chip stopping only `click` would still toggle the
  // row on the press before it.
  it("does not let the press that precedes the click reach the row either", () => {
    const onRowDown = vi.fn();
    render(
      <button data-testid="row" onMouseDown={onRowDown} onPointerDown={onRowDown}>
        <span data-testid="row-title">an epic</span>
        <BeadPriorityChip priority={2} beadId={ID} projectPath={ROOT} />
        {rowOpen && <span data-testid="row-body">body</span>}
      </button>,
    );
    fireEvent.pointerDown(chip());
    fireEvent.mouseDown(chip());
    expect(onRowDown).not.toHaveBeenCalled();
    // PAIRED: the same two presses outside the chip DO reach the row.
    fireEvent.pointerDown(screen.getByTestId("row-title"));
    fireEvent.mouseDown(screen.getByTestId("row-title"));
    expect(onRowDown).toHaveBeenCalledTimes(2);
  });

  // The menu is PORTALED to `document.body`, but React bubbles portal events through the JSX tree —
  // so without containment in `PriorityMenu` a menu row's click re-emerges at the row `<button>`.
  it("does not fire the row's handler when a MENU ROW is clicked", async () => {
    const onRowClick = harness(rowOpen);
    fireEvent.click(chip());
    fireEvent.click(screen.getByTestId("bead-priority-chip-option-1"));
    await waitFor(() => expect(setBeadPriority).toHaveBeenCalledWith(ROOT, ID, 1));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("does not fire the row's handler when the BACKDROP is clicked to dismiss", () => {
    const onRowClick = harness(rowOpen);
    fireEvent.click(chip());
    fireEvent.click(screen.getByTestId("bead-priority-chip-backdrop"));
    expect(screen.queryByTestId("bead-priority-chip-menu")).toBeNull();
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

// ── 5. KEYBOARD PARITY ─────────────────────────────────────────────────────────────────────────
// The chip replaced part of a `<button>`, so a mouse-only control would be a regression against
// what it sits in.

describe("BeadPriorityChip — the keyboard", () => {
  it("opens the menu on Enter without firing the row", () => {
    const onRowClick = harness(false);
    chip().focus();
    fireEvent.keyDown(chip(), { key: "Enter" });
    expect(screen.getByTestId("bead-priority-chip-menu")).toBeTruthy();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("opens the menu on Space too", () => {
    harness(false);
    fireEvent.keyDown(chip(), { key: " " });
    expect(screen.getByTestId("bead-priority-chip-menu")).toBeTruthy();
  });

  it("closes on Escape and hands focus BACK to the chip", () => {
    harness(false);
    chip().focus();
    fireEvent.keyDown(chip(), { key: "Enter" });
    expect(screen.getByTestId("bead-priority-chip-menu")).toBeTruthy();
    // WRAPPED IN `act`: a bare `window.dispatchEvent` runs the listener outside React's batching,
    // so the state change it makes is never flushed before the next line reads the DOM.
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(e);
    });
    expect(screen.queryByTestId("bead-priority-chip-menu")).toBeNull();
    expect(document.activeElement).toBe(chip());
    // Cable etiquette: the press is consumed, so it peels THIS layer only.
    expect(e.defaultPrevented).toBe(true);
  });

  it("leaves an Escape a layer above already consumed alone", () => {
    harness(false);
    fireEvent.keyDown(chip(), { key: "Enter" });
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    e.preventDefault(); // a layer above already took it
    act(() => {
      window.dispatchEvent(e);
    });
    expect(screen.queryByTestId("bead-priority-chip-menu")).not.toBeNull();
  });

  // The ACTIVE option takes focus on open, so ArrowDown from P2 lands on P3 — a moved focus, not a
  // list that merely exists.
  it("moves focus between options with the arrow keys, and wraps", () => {
    harness(false, vi.fn(), 2);
    fireEvent.keyDown(chip(), { key: "Enter" });
    const menu = screen.getByTestId("bead-priority-chip-menu");
    expect(document.activeElement).toBe(screen.getByTestId("bead-priority-chip-option-2"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("bead-priority-chip-option-3"));
    // P3 is the last row; wrapping puts the next ArrowDown back on P0.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("bead-priority-chip-option-0"));
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("bead-priority-chip-option-3"));
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByTestId("bead-priority-chip-option-0"));
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(screen.getByTestId("bead-priority-chip-option-3"));
  });

  // WHICH LEVEL IS CURRENT MUST BE ANNOUNCED, not just painted. The active row is marked by a fill
  // colour, which a screen reader cannot see — so the checked state is the only thing that carries
  // it. `menuitemradio` rather than `menuitem` because `aria-checked` is not a supported attribute
  // of `menuitem`: on a plain menuitem the mark below is inert, which is the defect this pins.
  it("announces the bead's current level as the CHECKED row, and only that one", () => {
    harness(false, vi.fn(), 2);
    fireEvent.keyDown(chip(), { key: "Enter" });
    const rows = within(screen.getByTestId("bead-priority-chip-menu")).getAllByRole("menuitemradio");
    expect(rows.length).toBe(PRIORITY_OPTIONS.length);
    const checked = rows.filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.length).toBe(1);
    expect(checked[0]).toBe(screen.getByTestId("bead-priority-chip-option-2"));
  });

  it("does not let an arrow press inside the menu reach the row", () => {
    const onRowKey = vi.fn();
    render(
      <button data-testid="row" onKeyDown={onRowKey}>
        <BeadPriorityChip priority={2} beadId={ID} projectPath={ROOT} />
      </button>,
    );
    fireEvent.keyDown(chip(), { key: "Enter" });
    onRowKey.mockClear();
    fireEvent.keyDown(screen.getByTestId("bead-priority-chip-menu"), { key: "ArrowDown" });
    expect(onRowKey).not.toHaveBeenCalled();
  });
});

// ── 6. OPTIMISTIC, AND THE FAILURE IS HONEST ───────────────────────────────────────────────────

describe("BeadPriorityChip — the write's two endings", () => {
  it("shows the picked level immediately, before the 5s poll catches up", async () => {
    let release = () => {};
    setBeadPriority.mockImplementation(() => new Promise<void>((r) => (release = r)));
    harness(false, vi.fn(), 3);
    fireEvent.click(chip());
    fireEvent.click(screen.getByTestId("bead-priority-chip-option-0"));
    // The `priority` PROP still says 3 — nothing re-rendered it — so this passing means the chip is
    // showing its own optimistic value, not the prop.
    await waitFor(() => expect(chip().getAttribute("data-priority")).toBe("0"));
    await act(async () => {
      release();
    });
  });

  it("cannot be picked from again while a write is in flight", async () => {
    let release = () => {};
    setBeadPriority.mockImplementation(() => new Promise<void>((r) => (release = r)));
    harness(false);
    fireEvent.click(chip());
    fireEvent.click(screen.getByTestId("bead-priority-chip-option-1"));
    await waitFor(() => expect(chip().getAttribute("data-busy")).toBe("true"));
    fireEvent.click(chip());
    expect(screen.queryByTestId("bead-priority-chip-menu")).toBeNull();
    expect(setBeadPriority).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(chip().getAttribute("data-busy")).toBeNull());
  });

  // THE REJECTION PATH. A chip that kept showing a priority the store refused would be lying about
  // the state of the bead, which is worse than not offering the control at all.
  it("rolls back to the bead's real level and says why when bd refuses", async () => {
    setBeadPriority.mockRejectedValue(new Error("bd is busy — priority not saved"));
    harness(false, vi.fn(), 3);
    fireEvent.click(chip());
    fireEvent.click(screen.getByTestId("bead-priority-chip-option-0"));
    await waitFor(() =>
      expect(screen.getByTestId("bead-priority-chip-error").textContent).toBe(
        "bd is busy — priority not saved",
      ),
    );
    // ROLLED BACK: the chip reads the level the bead still carries, not the one that failed.
    expect(chip().getAttribute("data-priority")).toBe("3");
    expect(chip().getAttribute("title")).toBe("bd is busy — priority not saved");
  });

  it("clears a previous failure when the next pick is made", async () => {
    setBeadPriority.mockRejectedValueOnce(new Error("bd is busy — priority not saved"));
    harness(false, vi.fn(), 3);
    fireEvent.click(chip());
    fireEvent.click(screen.getByTestId("bead-priority-chip-option-0"));
    await waitFor(() => expect(screen.queryByTestId("bead-priority-chip-error")).not.toBeNull());
    setBeadPriority.mockResolvedValue(undefined);
    fireEvent.click(chip());
    fireEvent.click(screen.getByTestId("bead-priority-chip-option-1"));
    await waitFor(() => expect(screen.queryByTestId("bead-priority-chip-error")).toBeNull());
  });
});
