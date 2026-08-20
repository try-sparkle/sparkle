// The Concierge Agents badge's WIDTH RULES — bead `sparkle-8f4pj7`.
//
// ══ WHAT THIS FILE CAN AND CANNOT PROVE ════════════════════════════════════════════════════════
//
// It pins the DECISION, never the fit. jsdom has no layout engine — every `getBoundingClientRect`
// returns 0 and `text-overflow` is never applied — so a test that rendered the row and measured
// would read 0 at every width and pass just as happily against a badge clipped in half.
//
// So the labour is split, the same way `stageChipShows` splits it:
//   • THE DECISION (which phrasing at which width, and what each phrasing says) lives here.
//   • THE FIT (does that phrasing actually fit those pixels) lives in
//     `scripts/visual/concierge-header-probe.mjs`, which measures real Chrome at real widths.
// Neither is sufficient alone, and neither can be faked into passing for the other.

import { describe, it, expect } from "vitest";
import {
  CONCIERGE_BADGE_FULL_MIN_COLUMN_PX,
  CONCIERGE_BADGE_SHORT_MIN_COLUMN_PX,
  CONCIERGE_BADGE_TERSE_MIN_COLUMN_PX,
  CONCIERGE_QUEUE_SEGMENT_PX,
  CONCIERGE_QUEUE_SEGMENT_TERSE_PX,
  CONCIERGE_TITLE_FLOOR_MIN_COLUMN_PX,
  CONCIERGE_TITLE_FLOOR_PX,
  conciergeBadgeTier,
  conciergeLiveLabel,
  conciergeQueueLabel,
  conciergeRecentLabel,
  conciergeTitleFloor,
} from "./rowWidthThresholds";
import {
  RECENT_RESEARCH_WINDOW_LABEL,
  RECENT_RESEARCH_WINDOW_SHORT_LABEL,
  recentWindowLabel,
  recentWindowShortLabel,
} from "../services/research/store";

/** The width the app BOOTS at, and the width the founder's screenshot was taken at. */
const BUILD_COLUMN_DEFAULT_WIDTH = 220;
const TIERS = ["full", "short", "terse", "micro"] as const;

describe("conciergeBadgeTier — which phrasing at which width", () => {
  // FAIL OPEN TO THE FULL FORM. 0 means "not measured yet", and the full phrase is the one that
  // states its window in words — so an unmeasured width must never silently drop it. Matches
  // `stageChipShows`, which takes the wide form at 0 for the same anti-flicker reason.
  it("treats an unmeasured width as FULL, never as narrow", () => {
    expect(conciergeBadgeTier(0)).toBe("full");
    expect(conciergeBadgeTier(-1)).toBe("full");
    expect(conciergeBadgeTier(Number.NaN)).toBe("full");
  });

  it("steps down one tier at each threshold, and never skips one", () => {
    expect(conciergeBadgeTier(CONCIERGE_BADGE_FULL_MIN_COLUMN_PX)).toBe("full");
    expect(conciergeBadgeTier(CONCIERGE_BADGE_FULL_MIN_COLUMN_PX - 1)).toBe("short");
    expect(conciergeBadgeTier(CONCIERGE_BADGE_SHORT_MIN_COLUMN_PX)).toBe("short");
    expect(conciergeBadgeTier(CONCIERGE_BADGE_SHORT_MIN_COLUMN_PX - 1)).toBe("terse");
    expect(conciergeBadgeTier(CONCIERGE_BADGE_TERSE_MIN_COLUMN_PX)).toBe("terse");
    expect(conciergeBadgeTier(CONCIERGE_BADGE_TERSE_MIN_COLUMN_PX - 1)).toBe("micro");
  });

  // MONOTONIC: a wider column may never get a shorter phrasing. Asserted as a sweep rather than at
  // the thresholds, because an ordering bug between the branches shows up BETWEEN boundaries.
  it("never gives a wider column a shorter phrasing", () => {
    const rank = { micro: 0, terse: 1, short: 2, full: 3 } as const;
    for (const hasQueue of [false, true]) {
      let last = 0;
      for (let w = 60; w <= 500; w += 5) {
        const r = rank[conciergeBadgeTier(w, hasQueue)];
        expect(r).toBeGreaterThanOrEqual(last);
        last = r;
      }
    }
  });

  // THE MEASURED CLAIM, stated as the decision it forces. The probe measures the full phrase at
  // 192px and the badge's budget at this width at ~147px — it does not fit, and rendering it here
  // produced `…63 in th…`, a label that ellipsized away its own window. So the DEFAULT column width
  // must not be on the full tier.
  it("does NOT use the full phrasing at the width the app boots at", () => {
    expect(conciergeBadgeTier(BUILD_COLUMN_DEFAULT_WIDTH)).not.toBe("full");
  });

  // ── THE THIRD SEGMENT ────────────────────────────────────────────────────────────────────────
  //
  // Every threshold was measured on the TWO-segment badge, because the fixture seeded no queue.
  // With `· 16 queued` in the middle the string is about a tier wider, and the badge is one nowrap
  // span — so the ellipsis eats the TAIL, which is the windowed count. A queue therefore steps the
  // ladder down. This is the finding that made the first version of this ladder wrong in the row's
  // own documented common case.
  // At each threshold the queue's own width is not there to spend, so that rung is denied. Which
  // rung it lands on instead follows the ALLOWANCES, not a fixed shift: the narrow rungs charge the
  // abbreviated segment (31px) rather than the spelled-out one (74px), so a width can skip a rung.
  it("steps down when a queue leaves too little room for the current tier", () => {
    for (const t of [
      CONCIERGE_BADGE_FULL_MIN_COLUMN_PX,
      CONCIERGE_BADGE_SHORT_MIN_COLUMN_PX,
      CONCIERGE_BADGE_TERSE_MIN_COLUMN_PX,
    ]) {
      const rank = { micro: 0, terse: 1, short: 2, full: 3 } as const;
      expect(rank[conciergeBadgeTier(t, true)]).toBeLessThan(rank[conciergeBadgeTier(t, false)]);
    }
  });

  // ══ THE FULL TIER MUST STAY REACHABLE WITH A QUEUE ═══════════════════════════════════════════
  //
  // The first version charged a queue as a fixed RUNG shift, which made `full` unreachable at ANY
  // width: a 1000px column with a queue dropped the spelled-out window with hundreds of pixels to
  // spare — the opposite of the fail-open rule the function documents. The cost is a fixed WIDTH,
  // so it is charged as width, and this is the assertion the rung-shift version could not pass.
  it("keeps the full phrasing reachable on a wide column that has a queue", () => {
    expect(conciergeBadgeTier(CONCIERGE_BADGE_FULL_MIN_COLUMN_PX + CONCIERGE_QUEUE_SEGMENT_PX, true))
      .toBe("full");
    expect(conciergeBadgeTier(1000, true)).toBe("full");
    // …and one pixel below the allowance it is still short, so the boundary is real.
    expect(
      conciergeBadgeTier(CONCIERGE_BADGE_FULL_MIN_COLUMN_PX + CONCIERGE_QUEUE_SEGMENT_PX - 1, true),
    ).toBe("short");
  });

  // The narrow rungs are charged the ABBREVIATED segment, which is what they would actually render.
  it("charges the abbreviated segment at the narrow rungs", () => {
    expect(
      conciergeBadgeTier(CONCIERGE_BADGE_TERSE_MIN_COLUMN_PX + CONCIERGE_QUEUE_SEGMENT_TERSE_PX, true),
    ).toBe("terse");
    expect(CONCIERGE_QUEUE_SEGMENT_TERSE_PX).toBeLessThan(CONCIERGE_QUEUE_SEGMENT_PX);
  });

  // A queue may never make a tier WIDER — the allowance is a cost, not a discount.
  it("never gives a queued badge a longer phrasing than an unqueued one", () => {
    const rank = { micro: 0, terse: 1, short: 2, full: 3 } as const;
    for (let w = 60; w <= 1000; w += 5) {
      expect(rank[conciergeBadgeTier(w, true)]).toBeLessThanOrEqual(rank[conciergeBadgeTier(w, false)]);
    }
  });

  // …and the counter-case, so "steps down" cannot be satisfied by always returning `micro`.
  it("does not step down when there is no queue", () => {
    expect(conciergeBadgeTier(CONCIERGE_BADGE_FULL_MIN_COLUMN_PX, false)).toBe("full");
    expect(conciergeBadgeTier(CONCIERGE_BADGE_SHORT_MIN_COLUMN_PX, false)).toBe("short");
  });

  it("floors at micro rather than falling off the bottom", () => {
    expect(conciergeBadgeTier(60, true)).toBe("micro");
    expect(conciergeBadgeTier(CONCIERGE_BADGE_TERSE_MIN_COLUMN_PX - 1, true)).toBe("micro");
  });
});

describe("the badge's words — an abbreviation may shed words, never the unit", () => {
  const recent = (n: number, t: (typeof TIERS)[number]) =>
    conciergeRecentLabel(n, t, RECENT_RESEARCH_WINDOW_LABEL, RECENT_RESEARCH_WINDOW_SHORT_LABEL);

  // THE INVARIANT OF THE WHOLE BEAD. The founder's complaint was *"it tells me they were 62
  // recently — it'd be helpful to know in what time period."* A narrow tier that abbreviated the
  // window AWAY would re-create that unreadable count at the widths he most often sees.
  it("names the window at EVERY tier", () => {
    for (const tier of TIERS) {
      expect(recent(63, tier)).toMatch(/hour|hr|\d+[mh]\b/);
      expect(recent(63, tier)).toContain("63");
    }
  });

  // ══ THE UNIT IS DERIVED, NOT TYPED ═══════════════════════════════════════════════════════════
  //
  // The strongest assertion in this file, and the one that catches the failure a literal cannot:
  // both spellings must come from the WINDOW CONSTANT, so changing the window changes the badge.
  // An earlier version defaulted the narrow tiers to a hardcoded `"last hr"` — which sat on the
  // tier the DEFAULT column lands on, so a six-hour window would have printed a believed, wrong
  // period on the most-viewed surface with every test green. Asserted against `recentWindow*Label`
  // applied to a DIFFERENT window, so a literal cannot satisfy it.
  it("tracks the window constant rather than restating it", () => {
    const SIX_HOURS = 6 * 60 * 60_000;
    expect(recentWindowLabel(SIX_HOURS)).toBe("the last 6 hours");
    expect(recentWindowShortLabel(SIX_HOURS)).toBe("last 6h");
    // The labels the row renders are these functions applied to the enforced bound…
    expect(conciergeRecentLabel(9, "full", recentWindowLabel(SIX_HOURS), recentWindowShortLabel(SIX_HOURS)))
      .toBe("9 in the last 6 hours");
    // …including the narrow tiers, which is where the hardcoded string used to live.
    for (const tier of ["short", "terse", "micro"] as const) {
      expect(
        conciergeRecentLabel(9, tier, recentWindowLabel(SIX_HOURS), recentWindowShortLabel(SIX_HOURS)),
      ).toBe("9 last 6h");
    }
  });

  // Sub-hour windows must keep minutes rather than rounding up to an hour nothing enforces.
  it("does not round a sub-hour window up to an hour", () => {
    expect(recentWindowShortLabel(20 * 60_000)).toBe("last 20m");
    expect(recentWindowLabel(20 * 60_000)).toBe("the last 20 minutes");
  });

  // A COUNTER-CASE, so "names the window" cannot be satisfied by one string reused at every tier —
  // which would defeat the tiers and would not fit the narrow column. Measured over the WHOLE
  // badge, because that is what has to fit: the recent label plateaus and the other halves shed.
  it("actually gets shorter as the column narrows", () => {
    const badge = (t: (typeof TIERS)[number]) =>
      `${conciergeLiveLabel(2, t)} · ${conciergeQueueLabel(16, t)} · ${recent(63, t)}`;
    for (let i = 1; i < TIERS.length; i++) {
      expect(badge(TIERS[i]!).length).toBeLessThanOrEqual(badge(TIERS[i - 1]!).length);
    }
    // …and strictly shorter end to end, so a no-op ladder cannot pass.
    expect(badge("micro").length).toBeLessThan(badge("full").length);
  });

  it("spells the window out in full when there is room for it", () => {
    expect(recent(63, "full")).toBe(`63 in ${RECENT_RESEARCH_WINDOW_LABEL}`);
  });

  // "ACTIVE", NEVER "RUNNING", wherever it still has a word. The gauge counts `queued` + `running`
  // (`phaseOf`), so "running" overclaims for a dispatched-but-unstarted task — which is what the
  // aria label said before this bead, and an abbreviation is where it would creep back in.
  it("never calls the live gauge `running` at any tier", () => {
    for (const tier of TIERS) {
      expect(conciergeLiveLabel(2, tier)).toContain("2");
      expect(conciergeLiveLabel(2, tier)).not.toMatch(/running/);
    }
  });

  // `63/hr` was rejected for reading as a RATE rather than a count inside a window. Pinned because
  // it is the obvious way to save pixels and the fault is easy to reintroduce without noticing.
  it("never expresses the count as a rate", () => {
    for (const tier of TIERS) expect(recent(63, tier)).not.toMatch(/\//);
  });

  it("sheds the live gauge's words last, and only from the bottom", () => {
    expect(conciergeLiveLabel(2, "full")).toBe("2 active now");
    expect(conciergeLiveLabel(2, "short")).toBe("2 active now");
    expect(conciergeLiveLabel(2, "terse")).toBe("2 active");
    expect(conciergeLiveLabel(2, "micro")).toBe("2");
  });

  // The queue segment shortens its WORD but never its NUMBER — a truncated count is a wrong count.
  it("abbreviates the queue's word at the narrow tiers and never its number", () => {
    expect(conciergeQueueLabel(16, "full")).toBe("16 queued");
    expect(conciergeQueueLabel(16, "short")).toBe("16 queued");
    expect(conciergeQueueLabel(16, "terse")).toBe("16 q");
    expect(conciergeQueueLabel(16, "micro")).toBe("16 q");
    for (const tier of TIERS) expect(conciergeQueueLabel(16, tier)).toContain("16");
  });
});

describe("the title floor", () => {
  // RELEASED at the narrowest widths — below the cutoff the floor plus the shortest badge exceed
  // the whole row, so holding it would clip the numbers to buy a name nobody dragged the column
  // that narrow to read.
  it("holds the floor at the default width and releases it below the cutoff", () => {
    expect(conciergeTitleFloor(BUILD_COLUMN_DEFAULT_WIDTH)).toBe(CONCIERGE_TITLE_FLOOR_PX);
    expect(conciergeTitleFloor(CONCIERGE_TITLE_FLOOR_MIN_COLUMN_PX)).toBe(CONCIERGE_TITLE_FLOOR_PX);
    expect(conciergeTitleFloor(CONCIERGE_TITLE_FLOOR_MIN_COLUMN_PX - 1)).toBe(0);
  });

  // Unmeasured takes the floor, matching `conciergeBadgeTier`'s fail-open: a width we have not read
  // yet must not boot the row without its name.
  it("keeps the floor when the width has not been measured", () => {
    expect(conciergeTitleFloor(0)).toBe(CONCIERGE_TITLE_FLOOR_PX);
  });

  it("reserves room for the row's name", () => {
    expect(CONCIERGE_TITLE_FLOOR_PX).toBeGreaterThan(0);
    // Enough for `Co…` at the row's title face, and deliberately SMALL: the shrink ratio already
    // leaves the title a sliver, so a large floor only takes pixels the counts needed. 46px was
    // tried first and CLIPPED THE COUNTS.
    expect(CONCIERGE_TITLE_FLOOR_PX).toBeGreaterThanOrEqual(24);
    expect(CONCIERGE_TITLE_FLOOR_PX).toBeLessThanOrEqual(40);
  });

  it("leaves the numbers the majority of the default column", () => {
    expect(CONCIERGE_TITLE_FLOOR_PX).toBeLessThan(BUILD_COLUMN_DEFAULT_WIDTH / 2);
  });
});
