// @vitest-environment jsdom
//
// THE PRIORITY CHICLET ON AN EPIC ROW (bead sparkle-jjvkoc).
//
// The founder: "Want to show the priority of epics in the epics column, there should be a little
// priority chicklet pill to the right of the epic name, before the count like, the 9/10 etc."
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
import { cleanup, render, screen } from "@testing-library/react";

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

  // THE FOUNDER'S PLACEMENT, asserted as ORDER rather than as presence: "to the right of the epic
  // name, before the count like, the 9/10". A chiclet appended after the count would satisfy every
  // assertion above.
  it("sits between the epic name and the child count", () => {
    // `ep-parent` has one child, so its row actually renders the `9/10`-style count to sit before.
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
    // DOCUMENT_POSITION_FOLLOWING: the count comes AFTER the chiclet in document order.
    expect(chip.compareDocumentPosition(kids!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and the chiclet comes after the title text.
    //
    // FOUND BY ITS CONTENT, NOT BY `firstElementChild`. It was the row's first child until the
    // health square (bead `sparkle-l06ax7`) took the leading slot, and this line then asserted
    // `''` contains the epic id — a red on a change that did not touch the ordering this test is
    // about. What the founder's placement rule actually says is title → chiclet → count, so that
    // is what is asserted, positionally, against a title located by what it CONTAINS.
    const title = [...r.children].find((el) => el.textContent?.includes("ep-parent"));
    expect(title).toBeDefined();
    expect(title!.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
