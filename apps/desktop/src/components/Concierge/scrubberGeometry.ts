// The concierge thread scrubber's PURE GEOMETRY: every number the rail draws, with no React and no
// DOM anywhere in this file.
//
// ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────────────────────────
// jsdom has no layout engine. `getBoundingClientRect` reads 0 for everything, so a test that tried
// to prove a dot "sits two thirds of the way down the rail" by measuring would pass vacuously
// against a rail that painted nothing (docs/jsdom-test-caveats.md, and the spec says so directly:
// "assert positions and cluster boundaries as numbers"). The honest coverage for a rail is
// therefore NUMERIC, and numeric coverage needs a module a node-environment test can import
// without dragging React, the theme, or the concierge stores in behind it. Same argument
// `trayGeometry.ts` makes for the send tray, and for the same reason: the component MUST read
// these functions rather than re-deriving positions inline, or the tests stop describing the rail
// that ships.
//
// ── THE ONE IDEA THE WHOLE MODULE ENCODES: THE SCOPE IS A ZOOM, NOT A FILTER ─────────────────────
// The founder was explicit (PRD/sparkle/thread-scrubber-and-retention.md, verbatim at the bottom):
// *"If it has one week at the top of the slider, it takes me all the way back to one week ago."*
// So the rail ALWAYS spans exactly the chosen window — fraction 0 is `now - SCOPE_MS[scope]` and
// fraction 1 is `now`, whether that window holds a thousand prompts or none. Changing the scope
// rescales the axis; it does not hide dots from a fixed axis. That is why `fractionFor` takes a
// window rather than a list, and why a marker outside the window is DROPPED by `clusterMarkers`
// instead of being pinned to an end: a dot outside the axis has no position to draw at, and
// clamping it to the top would draw a "prompt from a week ago" that is really a month old.

/** The scope steps, exactly as the founder listed them in his originating message. */
export type ScrubberScope =
  | "1h"
  | "3h"
  | "6h"
  | "12h"
  | "1d"
  | "3d"
  | "7d"
  | "1w"
  | "2w"
  | "1m"
  | "3m"
  | "6m"
  | "1y"
  /** EVERY live prompt, however old — the axis's top edge is `MIN(created_at)`, read from the store
   *  rather than assumed. See {@link scopeFromMs}. The founder asked for this directly: *"I wanna
   *  know how far back you have history... I basically wanna go as far back as we can"*. */
  | "all";

/**
 * The dropdown's order — HIS order, tightest first, so scrolling the list walks steadily further
 * back. `7d` and `1w` are the same duration and both are here on purpose: he wrote both, and the
 * dropdown reading the way he wrote it costs one dead-equal entry.
 */
export const SCRUBBER_SCOPES: readonly ScrubberScope[] = [
  "1h",
  "3h",
  "6h",
  "12h",
  "1d",
  "3d",
  "7d",
  "1w",
  "2w",
  "1m",
  "3m",
  "6m",
  "1y",
  "all",
] as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * How far back each scope reaches, in milliseconds.
 *
 * Months and years are NOMINAL — 30 and 365 days — not calendar-aware. A scrubber axis is a ruler,
 * not a date arithmetic library: the user reads it as "roughly a month back", and a February-aware
 * `1m` would make the rail's top edge jump by three days depending on when you opened it, for no
 * gain anyone can see at rail resolution.
 */
export const SCOPE_MS: Record<ScrubberScope, number> = {
  "1h": HOUR,
  "3h": 3 * HOUR,
  "6h": 6 * HOUR,
  "12h": 12 * HOUR,
  "1d": DAY,
  "3d": 3 * DAY,
  "7d": 7 * DAY,
  "1w": 7 * DAY,
  "2w": 14 * DAY,
  "1m": 30 * DAY,
  "3m": 90 * DAY,
  "6m": 180 * DAY,
  "1y": 365 * DAY,
  /**
   * A SENTINEL, not a duration, and it is finite on purpose.
   *
   * `"all"`'s real top edge is `MIN(created_at)`, which only the store knows — so every caller must
   * go through {@link scopeFromMs}, which takes that measured value. This entry exists so the
   * `Record` stays total and so arithmetic on it can never produce `NaN` or `-Infinity` (both of
   * which would silently place every mark at an invalid position rather than failing loudly). 100
   * years is far outside any real history and reads as "unbounded" to anyone who prints it.
   */
  all: 100 * 365 * DAY,
};

/**
 * The instant at the TOP of the axis for a scope — the one place `"all"` differs from every other
 * entry.
 *
 * `oldestMs` is `MIN(created_at)` for the source, or `null` when the store holds nothing (or has not
 * answered yet). A `null` under `"all"` falls back to the sentinel window rather than to 0: an epoch
 * of 1970 would put every real prompt in the last 0.0001 of the axis, which is precisely the
 * "the rail shows a couple of dots" failure this work exists to fix.
 */
export function scopeFromMs(now: number, scope: ScrubberScope, oldestMs: number | null): number {
  if (scope !== "all") return now - SCOPE_MS[scope];
  if (oldestMs === null || !Number.isFinite(oldestMs)) return now - SCOPE_MS.all;
  // A store whose oldest row is somehow in the future cannot define a window; fall back rather than
  // producing an inverted one.
  return oldestMs <= now ? oldestMs : now - SCOPE_MS.all;
}

/**
 * What the dropdown prints. The control sits at the top of a ~16px rail, so the label is the token
 * itself — "1h", "2w" — and nothing longer. This is the founder's standing rule for the concierge
 * header ("no words at all") applied to the one control the rail has.
 */
export const SCOPE_LABEL: Record<ScrubberScope, string> = {
  "1h": "1h",
  "3h": "3h",
  "6h": "6h",
  "12h": "12h",
  "1d": "1d",
  "3d": "3d",
  "7d": "7d",
  "1w": "1w",
  "2w": "2w",
  "1m": "1m",
  "3m": "3m",
  "6m": "6m",
  "1y": "1y",
  all: "All",
};

/**
 * The same scopes spelled out, for the places a SCREEN READER reads rather than the eye scans — the
 * handle's accessible name, and the empty-state note ("no prompts in the last 7 days"). The visual
 * label above is deliberately cryptic; an accessible name may not be.
 */
export const SCOPE_PHRASE: Record<ScrubberScope, string> = {
  "1h": "1 hour",
  "3h": "3 hours",
  "6h": "6 hours",
  "12h": "12 hours",
  "1d": "1 day",
  "3d": "3 days",
  "7d": "7 days",
  "1w": "1 week",
  "2w": "2 weeks",
  "1m": "1 month",
  "3m": "3 months",
  "6m": "6 months",
  "1y": "1 year",
  all: "all of your history",
};

/** One dot's worth of input. The caller truncates `textPrefix`; this module never touches text. */
export interface ScrubberMarker {
  /** The concierge message id — the rail hands this back so the thread can scroll to that bubble. */
  id: string;
  /** Epoch ms. */
  createdAt: number;
  /** First ~160 chars of the prompt, already truncated by the caller. */
  textPrefix: string;
  /** 1-based ordinal, for the hover card's "Prompt N". */
  index: number;
}

/** The visible time axis. `fromMs` is the TOP of the rail (oldest), `toMs` the bottom (newest). */
export interface ScrubberWindow {
  fromMs: number;
  toMs: number;
}

/** The window a scope selects at a given instant. Top of rail = now minus scope, bottom = now. */
export function scopeWindow(now: number, scope: ScrubberScope): ScrubberWindow {
  return { fromMs: now - SCOPE_MS[scope], toMs: now };
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * 0 = top of rail = `fromMs` (oldest) … 1 = bottom = `toMs` (newest). CLAMPED to [0,1].
 *
 * A degenerate window (`toMs <= fromMs`, which `scopeWindow` cannot produce but a hand-built window
 * can) collapses to 1 rather than dividing by zero: with no span at all, every instant IS the
 * bottom of the rail.
 */
export function fractionFor(createdAt: number, w: ScrubberWindow): number {
  const span = w.toMs - w.fromMs;
  if (span <= 0) return 1;
  return clamp01((createdAt - w.fromMs) / span);
}

/** Inverse of `fractionFor` — the instant a rail fraction points at. Input is clamped the same way. */
export function timeAt(fraction: number, w: ScrubberWindow): number {
  return w.fromMs + clamp01(fraction) * (w.toMs - w.fromMs);
}

// ══ EVERYTHING BELOW THIS LINE IS THE RETIRED TIME AXIS ════════════════════════════════════════
//
// NOTHING IN PRODUCTION CALLS IT ANY MORE. As of bead `sparkle-bjbhw6` the rail is drawn on the
// CONTENT axis — `railGeometry.ts` — because a control that REPLACES the scrollbar has to be
// measured in the scroller's own units. `clusterMarkers`, `nearestCluster`, `nearestMarker`,
// `fractionFor`, `timeAt`, `scopeWindow` and `DotCluster` are reached only by their own tests.
//
// IF YOU ARE ABOUT TO USE ONE OF THESE, YOU ALMOST CERTAINLY WANT `railGeometry.ts` INSTEAD.
// `mergeMarks` / `nearestBand` / `pickFromBand` are the live equivalents and they take a 0..1
// content fraction rather than a timestamp and a window.
//
// It is left in place rather than deleted in the same change as the rewrite, so the diff reviewers
// read is the behaviour change and not a 150-line deletion mixed into it. Removing it is its own
// single-purpose commit — bead filed. What must NOT happen meanwhile is a new caller binding to it,
// which is the only reason this banner is here: a green test suite over an unreachable module is
// exactly the "guarantee defended for nobody" this file has already been bitten by twice.
//
// The SCOPE TABLE above (SCOPE_MS / SCOPE_LABEL / SCOPE_PHRASE / SCRUBBER_SCOPES / scopeFromMs /
// scopeMenuLabel) and `ageLabel` are LIVE and stay — the scope is still a time window, it is only
// the rail's axis that stopped being one.

/** The spec's figure: dots closer than ~6px merge (`PRD/sparkle/thread-scrubber-and-retention.md`). */
export const DEFAULT_MIN_GAP_PX = 6;

/** One drawn dot: a single prompt, or a fattened dot standing for several that would overlap. */
export interface DotCluster {
  key: string;
  fraction: number;
  markers: ScrubberMarker[];
}

/**
 * Dots closer together than `minGapPx` merge into ONE fatter dot.
 *
 * NON-NEGOTIABLE at the founder's measured volume, not a nicety: he sent 1,234 prompts in a day and
 * 161 in his busiest hour. At `1h` scope on a 320px rail that is a dot every 2px — a solid bar,
 * with no hoverable target anywhere in it. Clustering is what keeps the rail a rail.
 *
 * ── THE MERGE IS ANCHORED, NOT CHAINED, AND THE DIFFERENCE IS VISIBLE ───────────────────────────
 * Each cluster measures from the pixel of its FIRST member, not from the last one added. Chaining
 * ("merge with the previous dot if it is within the gap") lets an evenly-spaced ramp of dots
 * `minGapPx - 1` apart collapse into a single cluster spanning the whole rail, whose dot would then
 * be drawn in the middle of a burst that actually covers everything. Anchoring bounds every cluster
 * to strictly less than `minGapPx`, so a cluster's dot always sits where its members are.
 *
 * Ordering guarantees the caller may rely on: `markers[]` inside a cluster is ascending by
 * `createdAt`, and clusters are ascending by `fraction` (each cluster's mean is inside its own
 * sub-`minGapPx` band, and the bands do not overlap, so the means cannot cross).
 *
 * Markers outside `[fromMs, toMs]` are DROPPED — see the module header on why an out-of-window dot
 * is not clamped to an end.
 */
export function clusterMarkers(
  markers: ScrubberMarker[],
  w: ScrubberWindow,
  railHeightPx: number,
  minGapPx = DEFAULT_MIN_GAP_PX,
): DotCluster[] {
  const inWindow = markers
    .filter((m) => m.createdAt >= w.fromMs && m.createdAt <= w.toMs)
    // Ascending by time, ties broken by the prompt ordinal so the result is deterministic when two
    // prompts share a millisecond (which they do: the founder pastes bursts).
    .sort((a, b) => a.createdAt - b.createdAt || a.index - b.index);
  if (inWindow.length === 0) return [];

  // With no measured height (or no gap) there is no pixel distance to compare, so nothing may be
  // merged. Failing toward MORE dots is the safe direction: a rail that draws every prompt is ugly
  // at worst, whereas one that merged everything into a single dot on a 0px measurement would have
  // silently thrown the founder's history away.
  const canMerge = railHeightPx > 0 && minGapPx > 0;

  const out: DotCluster[] = [];
  let group: ScrubberMarker[] = [];
  let anchorPx = 0;
  const pxOf = (m: ScrubberMarker) => fractionFor(m.createdAt, w) * railHeightPx;

  const flush = () => {
    if (group.length === 0) return;
    const first = group[0]!;
    const mean = group.reduce((sum, m) => sum + fractionFor(m.createdAt, w), 0) / group.length;
    // Keyed on the first member's id: unique (a marker belongs to exactly one cluster) and stable
    // across a re-render that only appends newer prompts, so React does not tear down dots the user
    // is hovering.
    out.push({ key: first.id, fraction: mean, markers: group });
    group = [];
  };

  for (const m of inWindow) {
    if (group.length === 0) {
      group = [m];
      anchorPx = pxOf(m);
      continue;
    }
    if (canMerge && pxOf(m) - anchorPx < minGapPx) {
      group.push(m);
      continue;
    }
    flush();
    group = [m];
    anchorPx = pxOf(m);
  }
  flush();
  return out;
}

/**
 * The marker nearest a rail fraction, or null when the window holds none.
 *
 * Ties resolve to the OLDER marker. Any rule would do as long as it is deterministic — what must
 * not happen is a drag that sits exactly between two prompts flickering between them as the mouse
 * jitters by a sub-pixel, which is what an unspecified tie-break gives you.
 */
/**
 * The DOT nearest a rail fraction, or null when the window is empty.
 *
 * ── WHY THE DRAG MUST GO THROUGH CLUSTERS AND NOT THROUGH RAW MARKERS (roborev 66465) ──────────
 * What the reader sees on the rail is DOTS, not markers: `clusterMarkers` merges anything closer
 * than ~6px, and at a wide scope one fat dot can span days (at `1y` on a ~770px rail, roughly a
 * 2.8-day bucket). Both user-facing paths already speak in dots — a click commits
 * `markers[length - 1]` of the cluster it is on, and the hover card prints that same member's text.
 *
 * The DRAG did not: it ran `nearestMarker` over the raw marker list, so releasing the handle on the
 * upper half of a fat dot — or exactly on its centre, where the equidistant tie deliberately breaks
 * toward the OLDER — committed a different prompt from the one the card had just named and from the
 * one a click on that very dot commits. Aligning the same-millisecond tie-break fixed only the case
 * where a cluster's members share an instant, which is the rare one.
 *
 * Resolving the drag to a CLUSTER and then applying the cluster's own rule makes the two paths
 * identical by construction rather than by two rules that have to be kept in agreement.
 *
 * ORDER-INDEPENDENT BY CONSTRUCTION. `clusterMarkers` returns clusters ascending by `fraction`, so
 * with today's only caller the tie clause below never has to fire — the earlier-seen cluster is
 * already the lower one. That made it a branch no input could execute, which is precisely the inert
 * line this file has been bitten by before (roborev 66498). It is kept rather than deleted BECAUSE
 * the guarantee it defends lives in another function: relax `clusterMarkers`' ordering and this
 * silently stops holding. `scrubberGeometry.test.ts` therefore drives it with clusters in
 * DESCENDING order, which is the only way to make the clause executable and so falsifiable.
 */
export function nearestCluster(
  fraction: number,
  clusters: DotCluster[],
): DotCluster | null {
  // NO `clamp01` HERE, deliberately (roborev 66516). It looks like the obvious guard and it is
  // provably INERT for an argmin: for any x < 0 every distance is `c - x`, minimised by the
  // smallest fraction — exactly what x = 0 would give; for x > 1 it is `x - c`, minimised by the
  // largest. Clamping only changes `bestDist`, which is never returned. So no mutation of that line
  // could redden a test, and a row claiming to pin it would be the dead branch this module has
  // already been bitten by twice. An out-of-range fraction still answers with the end dot, which is
  // what the caller needs and what the suite asserts; `fractionFromClientY` clamps upstream anyway.
  const target = fraction;
  let best: DotCluster | null = null;
  let bestDist = Infinity;
  for (const c of clusters) {
    const dist = Math.abs(c.fraction - target);
    // Ties break toward the OLDER dot (lower fraction = higher on the rail), matching
    // `nearestMarker`'s equidistant rule: the reader is scrubbing backwards.
    if (dist < bestDist || (best !== null && dist === bestDist && c.fraction < best.fraction)) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

export function nearestMarker(
  fraction: number,
  markers: ScrubberMarker[],
  w: ScrubberWindow,
): ScrubberMarker | null {
  const target = clamp01(fraction);
  let best: ScrubberMarker | null = null;
  let bestDist = Infinity;
  for (const m of markers) {
    if (m.createdAt < w.fromMs || m.createdAt > w.toMs) continue;
    const dist = Math.abs(fractionFor(m.createdAt, w) - target);
    // The second clause is what makes the tie-break INDEPENDENT of the caller's array order: the
    // markers arrive in whatever order the store hands them over, so "keep the first one seen at
    // this distance" would be a different answer for the same rail depending on that order.
    //
    // THE ORDINAL IS PART OF THE COMPARATOR, not a refinement of it (roborev 66376). Time alone is
    // not a total order here: the founder pastes bursts, and `conciergeHistoryCapture` stamps
    // `Date.now()`, so two prompts SHARING a millisecond is a case this module elsewhere calls out
    // as real. Without an ordinal term the winner fell back to whichever the caller listed first —
    // the exact array-order dependence this clause exists to remove.
    //
    // ── THE TWO TIES ARE DIFFERENT QUESTIONS, AND THEY BREAK OPPOSITE WAYS ────────────────────
    // EQUIDISTANT, DIFFERENT INSTANTS (a drag landing exactly between two dots): prefer the OLDER.
    // The reader is scrubbing BACK through history, and the older of the two is the one further in
    // the direction they are travelling.
    //
    // THE SAME INSTANT (a burst, one merged dot): prefer the NEWEST — because that is the one the
    // user-facing paths already choose. `pickFromCluster` commits `markers[length - 1]` and the
    // hover card prints that same member's text. The first version of this clause preferred the
    // LOWEST index, so clicking a fat dot committed one prompt while dragging the handle onto that
    // same dot committed another (roborev 66397) — which is precisely the "the card names one
    // prompt and the control goes to a different one" failure the tie-break exists to prevent. The
    // earlier test could not see it: it asserted agreement with `cluster.markers[0]`, the member no
    // user-facing path uses.
    const closer =
      dist < bestDist ||
      (best !== null &&
        dist === bestDist &&
        (m.createdAt < best.createdAt ||
          (m.createdAt === best.createdAt && m.index > best.index)));
    if (closer) {
      best = m;
      bestDist = dist;
    }
  }
  return best;
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"} ago`;

/**
 * "13 days ago" / "4 hours ago" / "just now" — the second line of the hover card, in the founder's
 * own phrasing from the mockup.
 *
 * Floored, never rounded: a prompt sent 23 hours ago reads "23 hours ago", not "1 day ago". The
 * rail is a navigation aid, and rounding UP past a boundary makes the label disagree with the dot's
 * own position on the axis.
 *
 * A marker in the future (clock skew, or a `now` that has not ticked yet) reads "just now" rather
 * than a negative age.
 */
export function ageLabel(createdAt: number, now: number): string {
  const diff = now - createdAt;
  if (diff < 60_000) return "just now";
  if (diff < HOUR) return plural(Math.floor(diff / 60_000), "minute");
  if (diff < DAY) return plural(Math.floor(diff / HOUR), "hour");
  if (diff < 30 * DAY) return plural(Math.floor(diff / DAY), "day");
  if (diff < 365 * DAY) return plural(Math.floor(diff / (30 * DAY)), "month");
  return plural(Math.floor(diff / (365 * DAY)), "year");
}

/**
 * What the scope menu prints for one entry, INCLUDING the true extent behind `"all"`.
 *
 * ── WHY THE MENU REPORTS THE EXTENT RATHER THAN JUST NAMING THE SCOPE ──────────────────────────
 * The founder's question was *"I wanna know how far back you have history"* — and he had to ask a
 * person to measure the SQLite file to find out. A menu that answers it in place means he never has
 * to ask again, which is the whole reason this is a label and not a tooltip.
 *
 * `oldestMs` is `MIN(created_at)` for the source, or `null` when the store holds nothing or has not
 * answered yet. The extent is appended ONLY to `"all"`: on a bounded scope the axis's top edge is
 * the scope, not the data, so printing the data's edge there would describe a different window from
 * the one drawn.
 *
 * Deliberately DAY precision and no year — "since Aug 12". The menu sits in a 16px gutter and this
 * string is the widest thing in it; a full timestamp would be unreadable at that width and tells the
 * reader nothing a day does not. `Intl` rather than a hand-rolled month table so it follows the
 * platform locale, with a fixed `en-US` fallback for the test environment's sake.
 */
export function scopeMenuLabel(scope: ScrubberScope, oldestMs: number | null): string {
  const base = SCOPE_LABEL[scope];
  if (scope !== "all") return base;
  if (oldestMs === null || !Number.isFinite(oldestMs)) return base;
  return `${base} — since ${shortDay(oldestMs)}`;
}

/** "Aug 12". Its own function so the menu label above stays one readable line. */
export function shortDay(atMs: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
      new Date(atMs),
    );
  } catch {
    // An environment with no `Intl` is not a reason for the menu to fail to render.
    return new Date(atMs).toDateString().slice(4, 10);
  }
}
