// @vitest-environment jsdom
//
// PersonRow — a human reading as a PEER of an agent row in the Build column.
//
// WHAT THESE ASSERTIONS ARE FOR. The failure this file exists to catch is not "the row looks wrong";
// it is "the row stopped being the same row." The build column is scannable straight down only
// because every row in it shares one anatomy, and the way that rule dies is silent: someone types
// a literal `10` or a `borderRadius: 6` into this file, it happens to match today, and the two
// definitions drift apart on the next geometry change with every test green.
//
// So the box assertions compare this row's COMPUTED box against `rowBoxFor(...)`'s output for the
// SAME inputs, across every combination of `paneSide` × `jointOpen` × `isActive` — eight cases. A
// hard-coded number can satisfy at most one of them, so the only way to stay green is to actually
// call the shared rule.
//
// jsdom NEVER LAYS OUT AND NEVER LOADS THE STYLESHEET (docs/jsdom-test-caveats.md), so nothing here
// measures a pixel. Every assertion reads an INLINE style property or the presence of an element —
// both of which jsdom evaluates for real.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PersonRow, personRowLabel, PERSON_ROW_TESTID } from "./PersonRow";
import { rowBoxFor } from "./rowAnatomy";
import { availabilityLabel } from "./AvailabilityDot";
import { DOT_SLOT_W, GLYPH_SLOT_H, type PairSide } from "../engine/rowGeometry";
import { AGENT_NAME_FONT_SIZE } from "./FittedAgentName";
import type { Person } from "../stores/socialStore";
import type { Availability } from "../engine/social";

afterEach(cleanup);

function mkPerson(over: Partial<Person> = {}): Person {
  return {
    socialId: "s1",
    username: "ada",
    displayName: "Ada Lovelace",
    availability: "available" as Availability,
    relationship: "connected",
    ...over,
  };
}

function renderRow(over: Partial<Parameters<typeof PersonRow>[0]> = {}) {
  const onSelect = over.onSelect ?? vi.fn();
  render(
    <PersonRow
      person={over.person ?? mkPerson()}
      isActive={over.isActive ?? false}
      // Defaults to TRUE so the anatomy cases below measure the full row. Production passes false
      // until U6 owns the mount; that wiring is asserted in `ChatSection.test.tsx` and in
      // `AgentSidebar.personRows.test.tsx`, not defaulted here.
      ownsPane={over.ownsPane ?? true}
      paneSide={over.paneSide ?? "right"}
      jointOpen={over.jointOpen ?? false}
      unread={over.unread ?? 0}
      onSelect={onSelect}
    />,
  );
  return { row: screen.getByTestId(PERSON_ROW_TESTID), onSelect };
}

describe("PersonRow — the shared row anatomy", () => {
  // Every combination, so no single hard-coded value can satisfy the suite. See the header.
  const CASES: { paneSide: PairSide; jointOpen: boolean; isActive: boolean }[] = [
    { paneSide: "right", jointOpen: false, isActive: false },
    { paneSide: "right", jointOpen: false, isActive: true },
    { paneSide: "right", jointOpen: true, isActive: false },
    { paneSide: "right", jointOpen: true, isActive: true },
    { paneSide: "left", jointOpen: false, isActive: false },
    { paneSide: "left", jointOpen: false, isActive: true },
    { paneSide: "left", jointOpen: true, isActive: false },
    { paneSide: "left", jointOpen: true, isActive: true },
  ];

  it.each(CASES)(
    "takes its box from rowBoxFor (paneSide=$paneSide jointOpen=$jointOpen active=$isActive)",
    (c) => {
      const { row } = renderRow(c);
      const expected = rowBoxFor(c);

      // PADDING — read side by side rather than as the shorthand, because jsdom COLLAPSES a
      // symmetric `4px 18px 4px 18px` back to `4px 18px` and the two ends are exactly what this is
      // pinning. It is the assertion that catches a re-typed `ROW_PAD_X`: an open end pays its
      // bleed back in padding and a shut one does not, so the four side/joint combinations produce
      // four different pairs. `rowBox` builds the shorthand as `Ypx Rpx Ypx Lpx`.
      expect([row.style.paddingLeft, row.style.paddingRight]).toEqual([
        `${expected.padLeft}px`,
        `${expected.padRight}px`,
      ]);
      expect(`${row.style.paddingTop} ${row.style.paddingRight} ${row.style.paddingBottom} ${row.style.paddingLeft}`)
        .toBe(expected.padding.replace(/\s+/g, " "));

      // MARGIN — and it must be selection-INDEPENDENT. A margin that changes with `isActive`
      // narrows the content box the instant you click, so the title under the pointer jumps: the
      // list-twitch bug. Comparing against the rule (which ignores `isActive` for margins) is what
      // pins that, because the two active/inactive cases of each pair expect the SAME value.
      expect(row.style.marginLeft).toBe(`${expected.marginLeft}px`);
      expect(row.style.marginRight).toBe(`${expected.marginRight}px`);

      // RADIUS — a number while idle, a four-corner shorthand while selected, with the PANE end
      // squared. React writes a bare number as `px`, so the idle case is normalised the same way.
      const wantRadius =
        typeof expected.borderRadius === "number"
          ? `${expected.borderRadius}px`
          : expected.borderRadius;
      expect(row.style.borderRadius).toBe(wantRadius);
    },
  );

  it("paints the pane-end mouth only while selected, and the joint end only while wired", () => {
    // Idle: no fillets at all — a mouth on an unselected row would say it opens into the pane.
    renderRow({ isActive: false, paneSide: "right", jointOpen: false });
    expect(screen.queryByTestId("row-mouth-top")).toBeNull();
    expect(screen.queryByTestId("row-joint-top")).toBeNull();
    cleanup();

    // Selected, unwired: the PANE end is a mouth; the concierge end is still a plain radius.
    renderRow({ isActive: true, paneSide: "right", jointOpen: false });
    expect(screen.getByTestId("row-mouth-top")).toBeTruthy();
    expect(screen.getByTestId("row-mouth-bottom")).toBeTruthy();
    expect(screen.queryByTestId("row-joint-top")).toBeNull();
    cleanup();

    // Selected AND wired: both ends open — concierge ← row → terminal.
    renderRow({ isActive: true, paneSide: "right", jointOpen: true });
    expect(screen.getByTestId("row-mouth-top")).toBeTruthy();
    expect(screen.getByTestId("row-joint-top")).toBeTruthy();
    expect(screen.getByTestId("row-joint-bottom")).toBeTruthy();
  });

  it.each([
    { paneSide: "right" as PairSide, jointOpen: false },
    { paneSide: "right" as PairSide, jointOpen: true },
    { paneSide: "left" as PairSide, jointOpen: false },
    { paneSide: "left" as PairSide, jointOpen: true },
  ])(
    "claims NOTHING while selected but not owning the pane — idle radius AND no mouth (paneSide=$paneSide jointOpen=$jointOpen)",
    ({ paneSide, jointOpen }) => {
      // The state every person row is in today: picked, highlighted, but the terminal is still
      // showing an agent. BOTH halves of the junction must be absent — a mouth would be a second
      // row claiming a pane it does not own, and a squared pane-side corner on a row that bleeds
      // into the seam is the same claim made without the construction that renders it legible.
      const { row } = renderRow({ isActive: true, ownsPane: false, paneSide, jointOpen });
      expect(screen.queryByTestId("row-mouth-top")).toBeNull();
      expect(screen.queryByTestId("row-joint-top")).toBeNull();

      // The IDLE radius — the same value the rule gives an unselected row, read from the rule so a
      // change to it cannot leave this assertion pinning a stale number.
      const idle = rowBoxFor({ paneSide, jointOpen, isActive: false });
      expect(typeof idle.borderRadius).toBe("number"); // the idle case really is a plain radius
      expect(row.style.borderRadius).toBe(`${idle.borderRadius}px`);

      // LAYOUT is untouched: geometry belongs to every row. A row that stops claiming the pane
      // must not also stop reaching it, or the ink would shift when U6 flips `ownsPane`.
      expect(row.style.paddingLeft).toBe(`${idle.padLeft}px`);
      expect(row.style.marginLeft).toBe(`${idle.marginLeft}px`);

      // …and the row is still visibly and semantically the selected one.
      expect(row.getAttribute("aria-selected")).toBe("true");
      expect(row.style.background).not.toBe("transparent");
    },
  );

  it("still draws the full junction once the row DOES own the pane", () => {
    // The complement, so the case above cannot pass by the row having lost its anatomy outright.
    // This is the configuration U6 ships.
    const { row } = renderRow({ isActive: true, ownsPane: true, paneSide: "right", jointOpen: true });
    const claimed = rowBoxFor({ paneSide: "right", jointOpen: true, isActive: true });
    expect(row.style.borderRadius).toBe(String(claimed.borderRadius));
    expect(screen.getByTestId("row-mouth-top")).toBeTruthy();
    expect(screen.getByTestId("row-joint-top")).toBeTruthy();
  });

  it("mirrors the mouth with the pair — the fillet anchors on the row's own pane end", () => {
    // The left pair's terminal is to the LEFT, so its mouth must anchor left. Anchoring both pairs
    // on `right` is the exact bug `rowBox` was written to end, and it is invisible in one pair.
    renderRow({ isActive: true, paneSide: "left", jointOpen: false });
    expect(screen.getByTestId("row-mouth-top").style.left).toBe("0px");
    expect(screen.getByTestId("row-mouth-top").style.right).toBe("");
  });

  it("gives the avatar the SAME leading slot a build row gives its disc", () => {
    const { row } = renderRow();
    const slot = row.firstElementChild as HTMLElement;
    expect(slot.style.width).toBe(`${DOT_SLOT_W}px`);
    expect(slot.style.height).toBe(`${GLYPH_SLOT_H}px`);
    // …and the avatar is inside it, with its own availability overlay — not a second hand-placed
    // dot beside it, which would drift from `PersonAvatar`'s overlap ratio at the first size change.
    expect(slot.querySelector('[data-testid="person-avatar"]')).toBeTruthy();
    expect(row.querySelectorAll('[data-testid="availability-dot-slot"]').length).toBe(1);
  });

  it("titles the row at the column's ONE size, and weights the selected one", () => {
    // Same size for every row in the column — the property that makes it scannable. A row with its
    // own font size is a row you have to stop and read, which is what the pinned Sparkle row had
    // drifted into before its docstring wrote the rule down.
    renderRow({ isActive: false });
    const idle = screen.getByTestId("person-row-name");
    expect(idle.style.fontSize).toBe(`${AGENT_NAME_FONT_SIZE}px`);
    const idleWeight = idle.style.fontWeight;
    cleanup();

    renderRow({ isActive: true });
    const active = screen.getByTestId("person-row-name");
    expect(active.style.fontSize).toBe(`${AGENT_NAME_FONT_SIZE}px`);
    // Focus is carried by WEIGHT, not colour — colour in this column is spoken for by status.
    expect(active.style.fontWeight).not.toBe(idleWeight);
  });
});

describe("PersonRow — who it says this is", () => {
  it("uses personName, so a display name wins over the username", () => {
    const { row } = renderRow({ person: mkPerson({ displayName: "Ada Lovelace" }) });
    expect(row.textContent).toContain("Ada Lovelace");
    expect(row.textContent).not.toContain("ada");
  });

  it("falls back to the username when there is no display name", () => {
    const { row } = renderRow({ person: mkPerson({ displayName: null }) });
    expect(row.textContent).toContain("ada");
  });

  it.each(["available", "away", "offline"] as Availability[])(
    "names the availability IN WORDS for %s — colour is never the only channel",
    (availability) => {
      const person = mkPerson({ availability });
      const { row } = renderRow({ person });
      expect(row.getAttribute("aria-label")).toBe(`Ada Lovelace — ${availabilityLabel(availability)}`);
    },
  );

  it("says how many are unread in the accessible name, and badges the count", () => {
    const person = mkPerson();
    const { row } = renderRow({ person, unread: 3 });
    expect(row.getAttribute("aria-label")).toBe(personRowLabel(person, 3));
    expect(row.getAttribute("aria-label")).toContain("3 unread");
    expect(screen.getByTestId("person-row-unread").textContent).toBe("3");
  });

  it("shows no badge at zero", () => {
    renderRow({ unread: 0 });
    expect(screen.queryByTestId("person-row-unread")).toBeNull();
  });
});

describe("PersonRow — it is a treeitem you can reach", () => {
  it("publishes treeitem + aria-selected", () => {
    const { row } = renderRow({ isActive: true });
    expect(row.getAttribute("role")).toBe("treeitem");
    expect(row.getAttribute("aria-selected")).toBe("true");
    cleanup();
    const { row: idle } = renderRow({ isActive: false });
    expect(idle.getAttribute("aria-selected")).toBe("false");
  });

  it("is focusable and activates on click, Enter and Space — naming WHO", () => {
    const onSelect = vi.fn();
    const { row } = renderRow({ onSelect, person: mkPerson({ socialId: "s-who" }) });
    expect(row.tabIndex).toBe(0);

    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    // The id is an ARGUMENT, not a closure — that is what lets the list share one stable handler
    // and is the whole reason the memo on this component is not inert.
    expect(onSelect).toHaveBeenLastCalledWith("s-who");

    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith("s-who");

    // Space must also `preventDefault` — otherwise it scrolls the list out from under the row the
    // user just picked. `defaultPrevented` is what fireEvent reports back.
    const spaceHandled = !fireEvent.keyDown(row, { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(spaceHandled).toBe(true);
  });

  it("ignores keys that are not an activation", () => {
    const onSelect = vi.fn();
    const { row } = renderRow({ onSelect });
    fireEvent.keyDown(row, { key: "a" });
    fireEvent.keyDown(row, { key: "ArrowDown" });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
