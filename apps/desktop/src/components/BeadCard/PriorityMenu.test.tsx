// @vitest-environment jsdom
//
// ══ WHY THE MENU HAS ITS OWN SUITE AND NOT JUST THE CHIP'S ═════════════════════════════════════
// `BeadPriorityChip.test.tsx` drives this menu through the chip, which is the right way to test the
// FEATURE. It is not enough to test the COMPONENT, for one mechanical reason: `mutation-gate.sh`
// maps a test file to its sibling source, so with no `PriorityMenu.test.tsx` this file — which
// holds the press containment, the Escape etiquette and the scroll teardown that BOTH priority
// controls depend on — is swept by nothing. Breaking a line in here and watching the chip's suite
// stay green is the vacuity this closes.
//
// The other reason is coverage the chip cannot reach: `PriorityPill` (the detail card) mounts this
// same menu, so a regression here breaks a surface the chip's suite never renders.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BEAD_CARD_MENU_ATTR, PriorityMenu, beadCardMenuIsOpen } from "./PriorityMenu";
import { PRIORITY_OPTIONS } from "./beadPriority";

afterEach(cleanup);

/**
 * The menu inside a parent that is itself a `<button>` — which is what the board chip's call sites
 * are (the epic row, and the card face). The menu PORTALS to `document.body`, but React bubbles
 * portal events through the JSX tree, so a press inside it re-emerges HERE unless the menu
 * contains it. That is the whole reason this harness has a parent at all.
 */
function mount(
  over: Partial<Parameters<typeof PriorityMenu>[0]> = {},
  parent: Record<string, ReturnType<typeof vi.fn>> = {},
) {
  const props = {
    anchor: { top: 10, left: 10 },
    priority: 2 as number | undefined,
    onPick: vi.fn(),
    onClose: vi.fn(),
    onDismiss: vi.fn(),
    testId: "pm",
    ...over,
  };
  render(
    <button data-testid="parent" {...parent}>
      <span data-testid="sibling">not the menu</span>
      <PriorityMenu {...props} />
    </button>,
  );
  return props;
}

const menu = () => screen.getByTestId("pm-menu");
const backdrop = () => screen.getByTestId("pm-backdrop");

describe("PriorityMenu — the press never re-emerges at the parent", () => {
  // THE FOUNDER'S ASK, at the component that has to keep it: "Clicking on the priority chicklet
  // should not open the row." Each row is PAIRED with the same gesture landing outside the menu,
  // which MUST reach the parent — one test proving absence is ambiguous, because a menu that
  // rendered nothing at all would pass it.
  it("swallows a click on an OPTION, while the same click outside reaches the parent", () => {
    const onParentClick = vi.fn();
    const props = mount({}, { onClick: onParentClick });
    fireEvent.click(screen.getByTestId("pm-option-1"));
    expect(props.onPick).toHaveBeenCalledWith(1);
    expect(onParentClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("sibling"));
    expect(onParentClick).toHaveBeenCalledTimes(1);
  });

  it("swallows a click on the BACKDROP and closes, without reaching the parent", () => {
    const onParentClick = vi.fn();
    const props = mount({}, { onClick: onParentClick });
    fireEvent.click(backdrop());
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(onParentClick).not.toHaveBeenCalled();
  });

  // `pointerdown`/`mousedown` FIRE BEFORE `click`, and row-level handlers do listen there (the
  // board's overlay dismissal is a mousedown guard), so a menu that contained only `click` would
  // still toggle the row on the press that precedes it.
  it("swallows the presses that PRECEDE the click, on both layers", () => {
    const onParentDown = vi.fn();
    mount({}, { onMouseDown: onParentDown, onPointerDown: onParentDown });
    for (const layer of [menu(), backdrop(), screen.getByTestId("pm-option-0")]) {
      fireEvent.pointerDown(layer);
      fireEvent.mouseDown(layer);
    }
    expect(onParentDown).not.toHaveBeenCalled();

    // PAIRED: the same two presses outside the menu DO reach the parent.
    fireEvent.pointerDown(screen.getByTestId("sibling"));
    fireEvent.mouseDown(screen.getByTestId("sibling"));
    expect(onParentDown).toHaveBeenCalledTimes(2);
  });
});

describe("PriorityMenu — Escape has cable etiquette", () => {
  function escape() {
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    // `act`, because a bare dispatch runs the listener outside React's batching and the state it
    // sets is never flushed before the next line reads.
    act(() => {
      window.dispatchEvent(e);
    });
    return e;
  }

  it("closes on Escape and CONSUMES the press, so it peels this layer only", () => {
    const props = mount();
    const e = escape();
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("leaves an Escape a layer above already consumed alone", () => {
    const props = mount();
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    e.preventDefault(); // a layer above already took it
    act(() => {
      window.dispatchEvent(e);
    });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("ignores a key that is not Escape", () => {
    const props = mount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("PriorityMenu — a moved trigger dismisses it", () => {
  // The position was captured at OPEN time, so anything that moves the trigger leaves the menu
  // painted somewhere the trigger no longer is.
  it("dismisses on a scroll INSIDE a column, which never bubbles to window", () => {
    const props = mount();
    const column = document.createElement("div");
    document.body.appendChild(column);
    // Not cancelable and NOT bubbling — this is what a scroll inside a scrolling column actually
    // is. It reaches `window` only through the CAPTURE phase, so a listener registered without
    // `true` hears nothing and the menu hangs at a stale position.
    act(() => {
      column.dispatchEvent(new Event("scroll"));
    });
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
    // DISMISS, NOT CLOSE: `onClose` refocuses the trigger, which would scroll it back into view and
    // fight the very scroll that dismissed the menu.
    expect(props.onClose).not.toHaveBeenCalled();
    column.remove();
  });

  it("dismisses on a resize", () => {
    const props = mount();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stops listening once unmounted, so a later scroll dismisses nothing", () => {
    const props = mount();
    cleanup();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(props.onDismiss).not.toHaveBeenCalled();
  });
});

describe("PriorityMenu — the keyboard", () => {
  it("lands focus on the bead's CURRENT level, so a keyboard user opens inside the list", () => {
    mount({ priority: 3 });
    expect(document.activeElement).toBe(screen.getByTestId("pm-option-3"));
  });

  it("falls back to the first row when the bead carries no priority at all", () => {
    mount({ priority: undefined });
    expect(document.activeElement).toBe(screen.getByTestId("pm-option-0"));
  });

  it("moves focus with the arrows and WRAPS at both ends", () => {
    mount({ priority: 0 });
    const last = PRIORITY_OPTIONS[PRIORITY_OPTIONS.length - 1]!.value;
    // Up from the first row wraps to the last — the direction a bounded list would refuse.
    fireEvent.keyDown(menu(), { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId(`pm-option-${last}`));
    fireEvent.keyDown(menu(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("pm-option-0"));
  });

  it("jumps to the ends with Home and End", () => {
    mount({ priority: 1 });
    const last = PRIORITY_OPTIONS[PRIORITY_OPTIONS.length - 1]!.value;
    fireEvent.keyDown(menu(), { key: "End" });
    expect(document.activeElement).toBe(screen.getByTestId(`pm-option-${last}`));
    fireEvent.keyDown(menu(), { key: "Home" });
    expect(document.activeElement).toBe(screen.getByTestId("pm-option-0"));
  });

  it("keeps an arrow press off a parent that may act on arrows itself", () => {
    const onParentKey = vi.fn();
    mount({}, { onKeyDown: onParentKey });
    fireEvent.keyDown(menu(), { key: "ArrowDown" });
    expect(onParentKey).not.toHaveBeenCalled();
    // PAIRED: a key the menu does NOT claim still reaches the parent.
    fireEvent.keyDown(menu(), { key: "x" });
    expect(onParentKey).toHaveBeenCalledTimes(1);
  });
});

describe("PriorityMenu — what it announces", () => {
  it("offers every editable priority, by role", () => {
    mount();
    const rows = within(menu()).getAllByRole("menuitemradio");
    expect(rows.length).toBe(PRIORITY_OPTIONS.length);
    // The LABELS are the founder's own sentences, not `P0`/`P1` — the pill is a decision, not a
    // field, so the menu has to read as one.
    expect(rows.map((r) => r.textContent)).toEqual(PRIORITY_OPTIONS.map((o) => o.label));
  });

  it("marks exactly one row checked, and it is the bead's own level", () => {
    mount({ priority: 1 });
    const checked = within(menu())
      .getAllByRole("menuitemradio")
      .filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.length).toBe(1);
    expect(checked[0]).toBe(screen.getByTestId("pm-option-1"));
  });

  it("marks NOTHING checked for a priority outside the editable range, rather than guessing", () => {
    // P4 renders on a card but cannot be picked, so no row is current. Guessing at the nearest one
    // would tell the reader the bead is a P3 when the store says P4.
    mount({ priority: 4 });
    const checked = within(menu())
      .getAllByRole("menuitemradio")
      .filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.length).toBe(0);
  });
});

describe("PriorityMenu — the marker other surfaces probe for", () => {
  // The card that contains the trigger has its own Escape and click-outside dismissal, and both of
  // this menu's layers live at `document.body` — OUTSIDE the card. Without a marker the card reads
  // a click on a menu row as a click outside itself and closes under the reader's cursor.
  it("reports a menu as open while mounted, and NOT open once it is gone", () => {
    expect(beadCardMenuIsOpen()).toBe(false);
    mount();
    expect(beadCardMenuIsOpen()).toBe(true);
    cleanup();
    expect(beadCardMenuIsOpen()).toBe(false);
  });

  it("marks BOTH portaled layers, since a press can land on either", () => {
    mount();
    expect(menu().hasAttribute(BEAD_CARD_MENU_ATTR)).toBe(true);
    expect(backdrop().hasAttribute(BEAD_CARD_MENU_ATTR)).toBe(true);
    // `data-circuit` too: the concierge cable's "did the press leave the circuit" test walks DOM
    // ancestry and cannot reach a body-level portal from the row it belongs to.
    expect(menu().hasAttribute("data-circuit")).toBe(true);
    expect(backdrop().hasAttribute("data-circuit")).toBe(true);
  });

  it("portals to document.body, so a narrow scrolling column cannot clip it", () => {
    mount();
    // The PARENT is the harness `<button>`; if the menu rendered in place it would be inside it.
    expect(screen.getByTestId("parent").contains(menu())).toBe(false);
    expect(menu().parentElement).toBe(document.body);
  });
});
