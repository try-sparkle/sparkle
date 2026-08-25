// @vitest-environment jsdom
//
// THE EPICS COLUMN'S SORT-BY CONTROL ACTUALLY REORDERS THE ROWS.
//
// The founder, item 4 of `sparkle-huw924`: *"a sort-by control belongs to the right of the filter.
// He looked and it is not there."*
//
// ══ WHAT THIS FILE REFUSES TO ASSERT ══════════════════════════════════════════════════════════
// That the control EXISTS. `getByTestId("epics-sort")` would go green against a chip wired to
// nothing at all — the exact vacuous shape `AGENTS.md` names, and the one that matters most here
// because "it renders" is precisely what a decorative control also satisfies. The discriminating
// fact is the ROW ORDER before and after a pick, so every case below reads the rendered `epic-row`
// sequence out of the DOM and compares two different sequences.
//
// ══ AND WHAT IT ASSERTS BESIDES THE ORDER ═════════════════════════════════════════════════════
// That the LADDER SURVIVES. This column groups epics into seven stage rungs and the sort must move
// rows WITHIN a rung, never flatten the ladder into one date-ordered list — so the third case seeds
// an epic in a second rung whose timestamp would float it to the very top of a flattened board and
// asserts it stays inside its own stage container. A test that only read the whole column's rows in
// document order could not tell the two apart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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

// ── THE FIXTURE IS DELIBERATELY SCRAMBLED, AND THE TWO ORDERS ARE REVERSES OF EACH OTHER ───────
// Priority ascends in one direction and `updatedAt` ascends in the other, so "did anything move"
// cannot be satisfied by the input order, by bd's own default order, or by a comparator that
// quietly stopped sorting. `boardSort.test.ts` makes the same argument for the same reason.
const LATE = epic("ep-late", { priority: 2, updatedAt: "2026-08-24T10:00:00Z" });
const MID = epic("ep-mid", { priority: 1, updatedAt: "2026-08-10T10:00:00Z" });
const URGENT = epic("ep-urgent", { priority: 0, updatedAt: "2026-08-01T10:00:00Z" });

/** Priority ascending, P0 first — `boardSort`'s `byPriority` and the column's default. */
const BY_PRIORITY = ["ep-urgent", "ep-mid", "ep-late"];
/** Newest `updatedAt` first — `byNewest`. The exact reverse, which is what makes the flip legible. */
const BY_NEWEST = ["ep-late", "ep-mid", "ep-urgent"];

/** THE ARRAY HANDED TO THE COLUMN MUST BE THE VERY ONE IN THE STORE — the connected wrapper
 *  resolves its project by REFERENCE IDENTITY, and a copy renders nothing. Carried over from
 *  `EpicsColumn.taskFocus.test.tsx`, which carried it over from `goalMount`. */
function seed(beads: Bead[], project: Project = PROJECT) {
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      [project.id]: { beads, board: bucketBeads(beads), polledAt: 0 },
    },
    error: {},
  }) as never);
}

beforeEach(() => {
  // A real poller shells out to `bd` and would clobber the seeded snapshot asynchronously, which
  // reads as a flake rather than as a wrong assertion.
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useUiStore.setState({ epicFocusBySide: { left: null, right: null } } as never);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** The ids of the rows rendered inside one stage rung, in painted order. */
function rowsIn(stage: string): string[] {
  return within(screen.getByTestId(`epics-stage-${stage}`))
    .getAllByTestId("epic-row")
    .map((el) => el.getAttribute("data-epic-id") ?? "");
}

/** Open the chip and pick one order, the way a user does. */
function pick(option: string) {
  fireEvent.click(screen.getByTestId("epics-sort"));
  fireEvent.click(screen.getByTestId(`epics-sort-option-${option}`));
}

describe("the Epics column's sort chip reorders the rows", () => {
  it("starts in the founder's default priority order", () => {
    // Seeded out of every order the comparator could be accused of inheriting: input order here is
    // late/mid/urgent, so a column that rendered its input verbatim would fail this outright.
    seed([LATE, MID, URGENT]);
    render(<EpicsColumn project={PROJECT} side="right" />);
    expect(rowsIn("backlog")).toEqual(BY_PRIORITY);
  });

  it("REORDERS the rows when a different order is picked — the side effect, not the control", () => {
    seed([LATE, MID, URGENT]);
    render(<EpicsColumn project={PROJECT} side="right" />);

    const before = rowsIn("backlog");
    expect(before).toEqual(BY_PRIORITY);

    pick("newest");

    const after = rowsIn("backlog");
    // THE ASSERTION THAT FLIPS. Both halves matter: `not.toEqual` alone would pass for any shuffle,
    // and `toEqual(BY_NEWEST)` alone would pass if the column had somehow already been in date
    // order. Together they say the pick moved the rows, and moved them to `byNewest`'s order.
    expect(after).not.toEqual(before);
    expect(after).toEqual(BY_NEWEST);
  });

  it("goes back when the original order is picked again", () => {
    seed([LATE, MID, URGENT]);
    render(<EpicsColumn project={PROJECT} side="right" />);

    pick("newest");
    expect(rowsIn("backlog")).toEqual(BY_NEWEST);
    pick("oldest");
    // `byOldest` on this fixture is priority order by coincidence of the fixture, not by the
    // comparator — asserting it here is what shows the chip drives a THIRD distinct order rather
    // than toggling between two.
    expect(rowsIn("backlog")).toEqual(BY_PRIORITY);
    pick("priority");
    expect(rowsIn("backlog")).toEqual(BY_PRIORITY);
  });

  it("sorts WITHIN each rung and does not flatten the ladder", () => {
    // `ep-live` carries the newest timestamp in the whole fixture, so a flattened date sort would
    // paint it at the very top of the column. It must stay in its own stage instead. `in_progress`
    // with an EMPTY roster is `epicHealth`'s `"gray"`, which `rungForEpicHealth` files as
    // `unstaffed` — a rung that is open by default, so its rows are actually rendered.
    const LIVE = epic("ep-live", {
      status: "in_progress",
      priority: 3,
      updatedAt: "2026-09-01T10:00:00Z",
    });
    seed([LATE, MID, URGENT, LIVE]);
    render(<EpicsColumn project={PROJECT} side="right" />);

    pick("newest");

    expect(rowsIn("backlog")).toEqual(BY_NEWEST);
    // Its own rung, alone — not hoisted above the backlog rows it out-dates.
    expect(rowsIn("unstaffed")).toEqual(["ep-live"]);
    // And the stage counts still describe the stages, which is the other thing a flatten would break.
    expect(screen.getByTestId("epics-stage-count-backlog").textContent).toBe("3");
    expect(screen.getByTestId("epics-stage-count-unstaffed").textContent).toBe("1");
  });
});

describe("where the sort chip sits", () => {
  it("renders to the RIGHT of the epic filter's control, in the header's control group", () => {
    // Placement is the founder's stated requirement ("to the right of the filter"), so it gets an
    // assertion — but only alongside the order assertions above, never instead of them.
    seed([LATE, MID, URGENT]);
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-mid" } } as never);
    render(<EpicsColumn project={PROJECT} side="right" />);

    const clear = screen.getByTestId("epics-clear-focus");
    const sort = screen.getByTestId("epics-sort");

    // Same group as `Clear`, and after it. `DOCUMENT_POSITION_FOLLOWING` = 4.
    expect(clear.parentElement === sort.parentElement).toBe(true);
    expect(clear.compareDocumentPosition(sort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // NOT in the title's group — that side belongs to "Epics" and the board link.
    expect(screen.getByTestId("epics-header-left").contains(sort)).toBe(false);
  });
});
