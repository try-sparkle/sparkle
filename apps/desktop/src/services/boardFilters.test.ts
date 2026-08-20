import { describe, it, expect } from "vitest";
import {
  matchesBoardFilter,
  boardFilterIsActive,
  NO_BOARD_FILTER,
  type BoardFilter,
} from "./boardFilters";
import type { Bead } from "./beads";

const NOW = Date.parse("2026-08-05T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function bead(partial: Partial<Bead> = {}): Bead {
  return {
    id: "sparkle-x",
    title: "A bead",
    description: "",
    status: "open",
    labels: [],
    parent: null,
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
    commentCount: 0,
    ...partial,
  };
}

const filter = (over: Partial<BoardFilter> = {}): BoardFilter => ({ ...NO_BOARD_FILTER, ...over });

describe("boardFilterIsActive", () => {
  it("is false for the off position, so no banner claims a board is narrowed when it is not", () => {
    expect(boardFilterIsActive(NO_BOARD_FILTER)).toBe(false);
  });

  it("is true once either axis is set", () => {
    expect(boardFilterIsActive(filter({ priority: 0 }))).toBe(true);
    expect(boardFilterIsActive(filter({ dateWindow: "7d" }))).toBe(true);
  });

  // The date FIELD alone changes nothing — it only says which date a window would measure. Without
  // this, flipping created/updated with no window set would light up a banner over a full board.
  it("is NOT true merely because the date field was switched", () => {
    expect(boardFilterIsActive(filter({ dateField: "created" }))).toBe(false);
  });
});

describe("matchesBoardFilter — priority", () => {
  it("keeps only the chosen priority", () => {
    expect(matchesBoardFilter(bead({ priority: 0 }), filter({ priority: 0 }), NOW)).toBe(true);
    expect(matchesBoardFilter(bead({ priority: 1 }), filter({ priority: 0 }), NOW)).toBe(false);
  });

  // A bead bd never gave a priority is not P0. Treating undefined as a match would put every
  // unprioritised bead in the P0 lane, which is the opposite of what the filter is for.
  it("excludes a bead with NO priority when a priority is selected", () => {
    expect(matchesBoardFilter(bead({ priority: undefined }), filter({ priority: 0 }), NOW)).toBe(false);
  });

  it("keeps every priority when none is selected", () => {
    for (const p of [0, 1, 2, 3, undefined]) {
      expect(matchesBoardFilter(bead({ priority: p }), NO_BOARD_FILTER, NOW)).toBe(true);
    }
  });
});

describe("matchesBoardFilter — date window", () => {
  it("keeps a bead inside the window and drops one outside it", () => {
    const f = filter({ dateWindow: "24h" });
    expect(matchesBoardFilter(bead({ updatedAt: hoursAgo(2) }), f, NOW)).toBe(true);
    expect(matchesBoardFilter(bead({ updatedAt: hoursAgo(30) }), f, NOW)).toBe(false);
  });

  it("measures the field the switch selects, not always updated", () => {
    // Created long ago, updated minutes ago — the two fields must disagree, which is the whole
    // reason the switch exists.
    const b = bead({ createdAt: hoursAgo(400), updatedAt: hoursAgo(1) });
    expect(matchesBoardFilter(b, filter({ dateWindow: "24h", dateField: "updated" }), NOW)).toBe(true);
    expect(matchesBoardFilter(b, filter({ dateWindow: "24h", dateField: "created" }), NOW)).toBe(false);
  });

  it("respects each preset's boundary", () => {
    const b = (h: number) => bead({ updatedAt: hoursAgo(h) });
    expect(matchesBoardFilter(b(24 * 6), filter({ dateWindow: "7d" }), NOW)).toBe(true);
    expect(matchesBoardFilter(b(24 * 8), filter({ dateWindow: "7d" }), NOW)).toBe(false);
    expect(matchesBoardFilter(b(24 * 29), filter({ dateWindow: "30d" }), NOW)).toBe(true);
    expect(matchesBoardFilter(b(24 * 31), filter({ dateWindow: "30d" }), NOW)).toBe(false);
  });

  it("keeps everything at `all`, however old", () => {
    expect(matchesBoardFilter(bead({ updatedAt: hoursAgo(99999) }), NO_BOARD_FILTER, NOW)).toBe(true);
  });

  // ══ THE sparkle-qogah RULE, APPLIED TO A MISSING FIELD ═══════════════════════════════════════
  // An unreadable date means the DATA is wrong, not that the bead is old. Hiding on it would empty
  // the board and read as "there is no work" — silently concealing rows that may need action. The
  // filter degrades to "did not apply here" instead.
  it("KEEPS a bead whose date is missing, empty or unparseable rather than hiding it", () => {
    const f = filter({ dateWindow: "24h" });
    for (const updatedAt of [undefined, "", "not-a-date"]) {
      expect(matchesBoardFilter(bead({ updatedAt }), f, NOW)).toBe(true);
    }
  });
});

describe("matchesBoardFilter — the two axes combine", () => {
  it("requires BOTH to pass", () => {
    const f = filter({ priority: 0, dateWindow: "24h" });
    expect(matchesBoardFilter(bead({ priority: 0, updatedAt: hoursAgo(2) }), f, NOW)).toBe(true);
    // Right priority, too old.
    expect(matchesBoardFilter(bead({ priority: 0, updatedAt: hoursAgo(48) }), f, NOW)).toBe(false);
    // Recent, wrong priority.
    expect(matchesBoardFilter(bead({ priority: 2, updatedAt: hoursAgo(2) }), f, NOW)).toBe(false);
  });
});
