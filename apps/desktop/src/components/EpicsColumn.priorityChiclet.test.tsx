// @vitest-environment jsdom
//
// THE PRIORITY CHICLET ON AN EPIC ROW (beads sparkle-jjvkoc and sparkle-5izbbz).
//
// The founder asked for the chiclet in `sparkle-jjvkoc` ("Want to show the priority of epics in the
// epics column, there should be a little priority chicklet pill..."), and then, having seen it,
// MOVED IT in `sparkle-5izbbz`: *"The priority pills need to be to the right of the '9/13' etc, not
// to the left"*, *"The pills should be the farthest thing on the right. For that column."*
//
// The second ask supersedes the first, and the placement block far below is where it is asserted —
// including the case a naive sibling swap gets wrong, the row with no count at all.
//
// ══ WHY THIS ASSERTS TWO EPICS AT DIFFERENT PRIORITIES, ALWAYS ════════════════════════════════
// EpicRow had NO render test at all before this file, and the tempting first one — render one epic,
// assert "P1" is on screen — is vacuous in the exact way AGENTS.md names: it passes against a
// hard-coded string, against a chip wired to the wrong bead, and against a chip that ignores its
// prop entirely. Every case below mounts a P1 epic and a P3 epic AT ONCE and asserts the two
// rendered chiclets DIFFER, so the only thing that satisfies it is a chip actually reading the
// priority of the row it sits in.
//
// Today's store makes that mismatch easy to ship unnoticed: 18 of the founder's 19 epics are P2, so
// a chip stuck on one value would look completely correct on his screen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { EpicsColumn } from "./EpicsColumn";
import { useBeadsStore } from "../stores/beadsStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { bucketBeads, type Bead } from "../services/beads";
import type { Project } from "../types";

const PROJECT = { id: "p1", name: "Alpha", rootPath: "/tmp/alpha", agents: [] } as unknown as Project;

function epic(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", labels: [], type: "epic", ...over } as Bead;
}

/** Seed the store with exactly this bead list, as one already-bucketed snapshot. */
function seed(beads: Bead[]) {
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      p1: { beads, board: bucketBeads(beads), polledAt: 0 },
    },
    error: {},
  }) as never);
}

/** The row for one epic id, and the chiclet inside it. */
function row(id: string): HTMLElement {
  const hit = screen
    .queryAllByTestId("epic-row")
    .find((r) => r.getAttribute("data-epic-id") === id);
  if (!hit) throw new Error(`no epic row for ${id}`);
  return hit;
}
function chiclet(id: string): HTMLElement {
  const hit = row(id).querySelector<HTMLElement>('[data-testid="epic-row-priority"]');
  if (!hit) throw new Error(`no priority chiclet in the row for ${id}`);
  return hit;
}

beforeEach(() => {
  // Neutralise the poller, not the data: a real one shells out to `bd` and would clobber the seed
  // asynchronously, which reads as a flake rather than as a wrong assertion.
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useUiStore.setState({ epicFocusBySide: { left: null, right: null } } as never);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("EpicsColumn — each epic row carries its own priority chiclet", () => {
  /** A P1 and a P3 epic, both childless and typed, so both land in Backlog (open on mount). */
  const PAIR = [epic("ep-urgent", { priority: 1 }), epic("ep-later", { priority: 3 })];

  it("renders a DIFFERENT chiclet for a P1 epic than for a P3 epic", () => {
    seed(PAIR);
    render(<EpicsColumn project={PROJECT} side="right" />);

    expect(chiclet("ep-urgent").textContent).toContain("P1");
    expect(chiclet("ep-later").textContent).toContain("P3");
    // Stated as an inequality as well as two literals: a chip that ignored its prop and printed one
    // fixed value would satisfy neither, and a test that only checked one row would miss it.
    expect(chiclet("ep-urgent").textContent).not.toBe(chiclet("ep-later").textContent);
  });

  // The chip BANDS its ink rather than colouring per level — P0/P1 wear the danger ink, everything
  // else the neutral one, so a board where everything is red never happens. That banding is the
  // signal the founder actually reads at a glance, and it is a second, independent way the two rows
  // must differ: a chip that printed the right text with one fixed colour would pass the case above.
  it("bands the ink, so the P1 row is visually distinct from the P3 row", () => {
    seed(PAIR);
    render(<EpicsColumn project={PROJECT} side="right" />);

    const urgent = chiclet("ep-urgent").style.color;
    const later = chiclet("ep-later").style.color;
    expect(urgent).not.toBe("");
    expect(later).not.toBe("");
    expect(urgent).not.toBe(later);
  });

  // ── THE PLACEMENT, REVERSED — `sparkle-5izbbz` SUPERSEDES ITEM 8 ─────────────────────────────
  //
  // This block used to assert the OPPOSITE ("sits between the epic name and the child count"),
  // which was item 8's placement: chiclet, then count. The founder changed his mind after seeing
  // it: *"The priority pills need to be to the right of the '9/13' etc, not to the left"* and *"The
  // pills should be the farthest thing on the right. For that column."*
  //
  // ══ WHY TWO CASES AND NOT ONE ══════════════════════════════════════════════════════════════
  // A pure sibling swap satisfies the WITH-count row and does nothing for the rows that have no
  // count at all — and his screenshot is full of those (a childless epic renders `total === 0`, so
  // the count slot is not rendered). That is the case he could already see, so it gets its own
  // test asserting the MECHANISM, per `docs/jsdom-test-caveats.md`: jsdom never lays out, so no
  // assertion here can read a painted x-position. What it CAN read is the declared style that
  // produces one.
  it("puts the chiclet AFTER the child count — the count is no longer the row's last element", () => {
    // `ep-parent` has one child, so its row actually renders the `9/10`-style count to sit after.
    seed([
      epic("ep-parent", { priority: 1 }),
      // A plain TASK, not a typed epic — `epic()` above stamps `type: "epic"`, and a child that
      // claimed to be one would put a second row in the column instead of a count on this one.
      { id: "kid", title: "kid", description: "", status: "open", labels: [], parent: "ep-parent" },
    ]);
    render(<EpicsColumn project={PROJECT} side="right" />);

    const r = row("ep-parent");
    const kids = r.querySelector('[data-testid="epic-row-children"]');
    expect(kids).not.toBeNull();
    const chip = chiclet("ep-parent");
    // DOCUMENT_POSITION_FOLLOWING: the chiclet comes AFTER the count in document order. This is
    // the line that reverses; against the old code it reds.
    expect(kids!.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and the chiclet still comes after the title text, which item 8 also asked for and this bead
    // did not disturb.
    //
    // FOUND BY ITS CONTENT, NOT BY `firstElementChild`. It was the row's first child until the
    // health square (bead `sparkle-l06ax7`) took the leading slot, and this line then asserted
    // `''` contains the epic id — a red on a change that did not touch the ordering this test is
    // about. So the title is located by what it CONTAINS.
    const title = [...r.children].find((el) => el.textContent?.includes("ep-parent"));
    expect(title).toBeDefined();
    expect(title!.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // "The farthest thing on the right" stated structurally: nothing at all follows the chiclet's
    // slot. Order alone would still pass for a chiclet with some third element after it.
    expect(r.lastElementChild!.contains(chip)).toBe(true);
  });

  // THE ROW WITH NO COUNT — the case a pure reorder gets wrong, and the one already on his screen.
  it("keeps the chiclet flush right on a CHILDLESS row, which renders no count to trail", () => {
    // BOTH SHAPES MOUNTED AT ONCE. A childless row alone cannot tell "the chiclet is pinned right"
    // apart from "the chiclet happens to be last because there is nothing else in the row", and it
    // is the pair that pins the rule to the ROW rather than to one row's contents.
    seed([
      epic("ep-childless", { priority: 2 }),
      epic("ep-parent", { priority: 1 }),
      { id: "kid", title: "kid", description: "", status: "open", labels: [], parent: "ep-parent" },
    ]);
    render(<EpicsColumn project={PROJECT} side="right" />);

    const lone = row("ep-childless");
    // The precondition this case exists for: this row genuinely has no count to sit after.
    expect(lone.querySelector('[data-testid="epic-row-children"]')).toBeNull();
    expect(row("ep-parent").querySelector('[data-testid="epic-row-children"]')).not.toBeNull();

    // ── THE MECHANISM, ON BOTH ROWS ────────────────────────────────────────────────────────────
    // `marginLeft: "auto"` on the chiclet's slot is what pins it to the column's right edge: the
    // slot absorbs every pixel of free space to its left, so it lands on the edge whether or not a
    // count precedes it and whatever the title's flex is later changed to. jsdom cannot tell us
    // where it PAINTED; this is the declared rule that decides where it paints.
    for (const id of ["ep-childless", "ep-parent"]) {
      const slot = row(id).querySelector<HTMLElement>('[data-testid="epic-row-priority-slot"]');
      expect(slot).not.toBeNull();
      expect(slot!.style.marginLeft).toBe("auto");
      // The pin has to be on the element that actually holds the chiclet, not on a stray span
      // somewhere else in the row.
      expect(slot!.contains(chiclet(id))).toBe(true);
      // …and nothing follows it.
      expect(row(id).lastElementChild).toBe(slot);
    }
  });

  // THE OPEN ROW. Item 15 put the close X *in the count slot* ("where it says the six out of six
  // when it's closed") — a statement about that slot, not about the row's right edge. So the
  // chiclet stays farthest right when the row is open too, and the X keeps its slot. Without this
  // case the two rules could silently disagree on exactly the row the founder is looking at.
  it("stays the last element on an OPEN row, where the X has taken the count's slot", () => {
    seed([
      epic("ep-parent", { priority: 1 }),
      { id: "kid", title: "kid", description: "", status: "open", labels: [], parent: "ep-parent" },
    ]);
    render(<EpicsColumn project={PROJECT} side="right" />);

    fireEvent.click(row("ep-parent"));

    const r = row("ep-parent");
    const x = r.querySelector('[data-testid="epic-row-close"]');
    // Proves the row really is open — otherwise every line below is about a closed row and the
    // case tests nothing it claims to.
    expect(x).not.toBeNull();
    expect(r.querySelector('[data-testid="epic-row-children"]')).toBeNull();

    const chip = chiclet("ep-parent");
    expect(x!.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(r.lastElementChild!.contains(chip)).toBe(true);
  });

  // A DISTINCT testid, because the default (`bead-priority-chip`) is already worn by every card on
  // the Plan board. Without this, a query for one surface's chips silently collects the other's.
  it("uses its own testid, not the board card's default", () => {
    seed(PAIR);
    render(<EpicsColumn project={PROJECT} side="right" />);
    expect(screen.queryAllByTestId("epic-row-priority").length).toBe(2);
    expect(screen.queryAllByTestId("bead-priority-chip").length).toBe(0);
  });

  // An epic with no priority key renders `P?` rather than nothing. None of the founder's 19 epics
  // is in that state today, which is exactly why it is worth pinning: an unset priority is the one
  // most worth SEEING, and a chiclet that silently vanished would read as "this epic has no row
  // metadata" rather than "nobody has prioritised this".
  it("still renders a chiclet for an epic with no priority", () => {
    seed([epic("ep-unset"), epic("ep-later", { priority: 3 })]);
    render(<EpicsColumn project={PROJECT} side="right" />);
    expect(chiclet("ep-unset").textContent).toContain("P?");
    expect(chiclet("ep-unset").textContent).not.toBe(chiclet("ep-later").textContent);
  });
});
