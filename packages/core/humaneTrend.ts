/**
 * Trajectory for the humane build gate — the second half of `prioritize-long-term-wellbeing`.
 *
 * WHY THIS FILE EXISTS
 *
 * Seven of HumaneBench's eight principles can be judged from a single change. One cannot.
 * You cannot see "long-term" in one diff: it is a property of a trajectory, not of a
 * snapshot. Agreed with HumaneBench's author on 2026-08-22, the resolution is to measure
 * the principle in two parts —
 *
 *   (a) SNAPSHOT   — how well the codebase scores right now.  (`current`, `latest`)
 *   (b) TRAJECTORY — whether that is getting better or worse.  (`direction`, `slope`)
 *
 * The long-term part of prioritizing long-term wellbeing is that the codebase is becoming
 * MORE humane over time. A codebase steadily degrading on `respect-user-attention` is
 * failing that principle even if no single pull request ever breached the per-principle
 * floor — which is exactly the harm a per-PR gate is structurally blind to, and the reason
 * this gate keeps running rather than firing once.
 *
 * THREE INVARIANTS, each of which a plausible implementation gets wrong:
 *
 *   1. `unknown` IS A FIRST-CLASS ANSWER AND IS NEVER `flat`. Too few observations, or a
 *      principle that every snapshot marked not-applicable, means we do not know the
 *      direction. Reporting `flat` there would launder ignorance as stability.
 *
 *   2. NO CLOCK. Every instant comes from an injected snapshot's `at`, or from an explicit
 *      `now`. `Date.now()` / `new Date()` inside this module would make it untestable, so
 *      they are forbidden here — the same rule `concierge_lint_log.rs` and `history.rs`
 *      hold on the Rust side.
 *
 *   3. NOT-APPLICABLE IS MISSING DATA, NOT A ZERO. The ordinal in `humaneTypes.ts` has no
 *      zero at all, deliberately, so there is no zero to coerce to. A principle absent from
 *      one diff must be SKIPPED; folding it in as 0 manufactures a dip on every quiet
 *      change and corrupts every trend it touches.
 *
 * Pure: no I/O, no network, no filesystem, no model calls.
 */

import { PRINCIPLE_IDS, type HumaneVerdict, type PrincipleId } from './humaneTypes.ts';

/** Slopes are reported in score-units per DAY. Exported so a caller can re-scale. */
export const MS_PER_DAY = 86_400_000;

/**
 * The floor on observations before any direction may be claimed. Two points define a line
 * and nothing weaker does; a caller may raise this, never lower it.
 */
export const MIN_TREND_OBSERVATIONS = 2;

/**
 * MATERIALITY. The fitted change across the whole observed window must EXCEED this before
 * we call a series `improving` or `degrading`; at or below it the honest word is `flat`.
 *
 * 0.15 is just under a third of the 0.5 gap between adjacent tiers in the rubric. It is
 * deliberately smaller than any movement a single judge could express and smaller than one
 * tier step, so a real drift is caught early — while being large enough that ensemble
 * jitter between runs of the same codebase does not read as a trend.
 */
export const MATERIAL_TREND_DELTA = 0.15;

export interface HumaneSnapshot {
  sha: string;
  /** epoch ms. ALWAYS injected — never read a clock inside this module. */
  at: number;
  verdict: HumaneVerdict;
}

export type Direction = 'improving' | 'flat' | 'degrading' | 'unknown';

export interface PrincipleTrend {
  principle: PrincipleId;
  direction: Direction;
  /** Change per day, or null when not determinable. */
  slope: number | null;
  first: number | null;
  latest: number | null;
  /** How many snapshots actually SCORED this principle. Not-applicable ones do not count. */
  observations: number;
}

export interface TrendReport {
  /** The snapshot half: the most recent aggregate we have. */
  current: number | null;
  /** The trajectory half, over the aggregate series. */
  direction: Direction;
  slope: number | null;
  principles: PrincipleTrend[];
  windowStart: number | null;
  windowEnd: number | null;
  snapshotsConsidered: number;
  /** Principles degrading materially — the actionable output. */
  regressions: PrincipleId[];
}

export interface TrendOptions {
  /**
   * Explicit clock, epoch ms. Used only as the right edge of `windowMs`. When `windowMs`
   * is set and this is omitted, the newest snapshot's own `at` is used as "now" — still an
   * injected instant, never a read one.
   */
  now?: number;
  /** Consider only snapshots at or after `now - windowMs`. Omitted means all of history. */
  windowMs?: number;
  /** Observations required before a direction may be claimed. Clamped up to the floor of 2. */
  minObservations?: number;
  /**
   * Materiality threshold on the fitted change across the window. Defaults to the constant.
   * The fitted change must EXCEED it, so `0` means "report any real movement" and still
   * leaves `flat` reachable for a series that has not moved at all.
   */
  materialChange?: number;
}

/**
 * Whether a verdict exists at all — the single gate both accessors below run first.
 *
 * TWO WAYS A SNAPSHOT SAYS NOTHING, and `humaneTypes.ts` gives them different names:
 *
 *   `scored: false`        — the change touched no human-affecting surface, so it was never
 *                            evaluated. Authoritative over any numbers the record carries.
 *   `humaneScore === null` — NO VERDICT EXISTS. Per `HumaneVerdict.humaneScore`, null means
 *                            too few judges answered, and `verdictBlocks` treats it as
 *                            blocking. Null is never a pass, and it is never a data point.
 *
 * THE SECOND ONE IS WHY THIS FUNCTION IS NOT AN `if (!v.scored)` INLINE. A quorum-failed
 * verdict still carries whatever partial scores the one judge that answered produced. It is
 * tempting — and this module used to do it — to recompute an aggregate from `v.principles`
 * when the recorded field is null, on the theory that null means "field never persisted".
 * It does not: the contract gives null exactly one meaning, and recomputing RESURRECTS a
 * verdict the gate has already refused, as a real point in the trajectory. A run of
 * degraded or silent evaluations then reads as `flat` or even `improving` — silence
 * laundered into a signal, which is the one failure this whole module exists to prevent.
 *
 * Fewer usable points means the direction may fall to `unknown`. That is the correct and
 * honest outcome, not a shortfall to be patched over. See invariant 1.
 */
function verdictExists(v: HumaneVerdict): boolean {
  if (!v.scored) return false;
  return typeof v.humaneScore === 'number' && Number.isFinite(v.humaneScore);
}

/**
 * The aggregate a single snapshot contributes, or null when it contributes none.
 *
 * NULL MEANS THE POINT IS ABSENT FROM THE SERIES, never that it is zero. The recorded
 * `humaneScore` is the only source; there is deliberately no fallback (see above).
 */
export function snapshotScore(snapshot: HumaneSnapshot): number | null {
  const v = snapshot.verdict;
  if (!verdictExists(v)) return null;
  return v.humaneScore;
}

/**
 * The score a snapshot carries for ONE principle, or null when that snapshot says nothing
 * about it — because no verdict exists (unscored, or below judge quorum), because the
 * principle is absent from the assessment list, or because it was explicitly marked
 * not-applicable. See invariant 3.
 *
 * The quorum gate is applied HERE TOO, not only to the aggregate. Letting a quorum-failed
 * verdict's partial per-principle scores through would compute `regressions` — the module's
 * one actionable output — over a verdict the contract says does not exist.
 */
export function snapshotPrincipleScore(
  snapshot: HumaneSnapshot,
  principle: PrincipleId,
): number | null {
  const v = snapshot.verdict;
  if (!verdictExists(v)) return null;
  const a = v.principles.find((p) => p.principle === principle);
  if (!a) return null;
  if (a.applicability !== 'scored') return null;
  if (typeof a.score !== 'number' || !Number.isFinite(a.score)) return null;
  return a.score;
}

interface Point {
  /** epoch ms */
  x: number;
  y: number;
}

function median(sorted: readonly number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(n: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * THEIL–SEN: the median of every pairwise slope, in score-units per day.
 *
 * Chosen over least squares deliberately, because invariant 4 of the brief is that a
 * `degrading` verdict must survive noise. One bad pull request inside an improving series
 * is not a regression, and least squares gives an extreme point — especially an endpoint —
 * enough leverage to flip the sign on its own. Theil–Sen tolerates almost 30% of the
 * observations being outliers before its estimate moves, at O(n^2) cost that is irrelevant
 * for a bounded window and is the reason `windowMs` exists.
 *
 * Returns null when no pair is separated in time: with no time variance there is no
 * trajectory to report, and that is `unknown`, not `flat`.
 */
function theilSenSlopePerDay(points: readonly Point[]): number | null {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j]!.x - points[i]!.x;
      if (dx === 0) continue;
      slopes.push(((points[j]!.y - points[i]!.y) / dx) * MS_PER_DAY);
    }
  }
  if (slopes.length === 0) return null;
  slopes.sort((a, b) => a - b);
  return median(slopes);
}

/**
 * The one place a Direction is decided, so the aggregate series and every principle series
 * cannot drift apart. Every early return is an `unknown`, and none of them is a `flat`.
 */
function decide(
  points: readonly Point[],
  minObservations: number,
  materialChange: number,
): { direction: Direction; slope: number | null } {
  if (points.length < minObservations) return { direction: 'unknown', slope: null };
  const slope = theilSenSlopePerDay(points);
  if (slope === null || !Number.isFinite(slope)) return { direction: 'unknown', slope: null };

  const spanDays = (points[points.length - 1]!.x - points[0]!.x) / MS_PER_DAY;
  // Materiality is judged on the change the fit predicts across the WHOLE window, not on
  // the per-day rate. A rate is meaningless without a duration: 0.01/day is noise over an
  // afternoon and a two-tier collapse over half a year.
  const fitted = slope * spanDays;
  const rounded = round(slope);
  // STRICT, NOT `>=`. The comparison is the reason `materialChange: 0` is a legal option
  // rather than a validation error. `0` is the honest way to say "report any real
  // movement", and rejecting it would force a caller into an arbitrary epsilon; but under
  // `>=` a dead-flat series (`fitted === 0`) satisfies the improving branch first, so
  // `flat` becomes UNREACHABLE FOR EVERY INPUT and a codebase that has not moved at all is
  // reported as improving. That is the same shape as reporting `unknown` as `flat` — a
  // direction claimed on no evidence — and invariant 1 rules it out. Reading the threshold
  // as "must exceed" keeps `flat` reachable at every threshold >= 0.
  if (fitted > materialChange) return { direction: 'improving', slope: rounded };
  if (fitted < -materialChange) return { direction: 'degrading', slope: rounded };
  return { direction: 'flat', slope: rounded };
}

function emptyReport(): TrendReport {
  return {
    current: null,
    direction: 'unknown',
    slope: null,
    principles: PRINCIPLE_IDS.map((principle) => ({
      principle,
      direction: 'unknown',
      slope: null,
      first: null,
      latest: null,
      observations: 0,
    })),
    windowStart: null,
    windowEnd: null,
    snapshotsConsidered: 0,
    regressions: [],
  };
}

/**
 * Summarize a verdict history into the snapshot-and-trajectory report.
 *
 * `history` need not be sorted; it is ordered by `at` here. Snapshots with a non-finite
 * `at` are dropped, because an unplaceable point cannot contribute to a trajectory and
 * guessing a position for it would be inventing data.
 *
 * Never throws: an empty history and a one-snapshot history both return a well-formed
 * report whose every direction is `unknown`.
 */
export function summarizeTrend(
  history: readonly HumaneSnapshot[],
  opts: TrendOptions = {},
): TrendReport {
  const minObservations = Math.max(
    MIN_TREND_OBSERVATIONS,
    Number.isFinite(opts.minObservations) ? Math.floor(opts.minObservations!) : 0,
  );
  const materialChange =
    Number.isFinite(opts.materialChange) && opts.materialChange! >= 0
      ? opts.materialChange!
      : MATERIAL_TREND_DELTA;

  const placed = history.filter((s) => s && Number.isFinite(s.at));
  const ordered = [...placed].sort((a, b) => a.at - b.at);

  let considered = ordered;
  if (Number.isFinite(opts.windowMs) && opts.windowMs! >= 0) {
    // "now" is injected or borrowed from the newest snapshot — never read from a clock.
    const now = Number.isFinite(opts.now) ? opts.now! : ordered[ordered.length - 1]?.at;
    if (now !== undefined) {
      const cutoff = now - opts.windowMs!;
      considered = ordered.filter((s) => s.at >= cutoff && s.at <= now);
    }
  }

  if (considered.length === 0) return emptyReport();

  const aggregatePoints: Point[] = [];
  for (const s of considered) {
    const y = snapshotScore(s);
    if (y !== null) aggregatePoints.push({ x: s.at, y });
  }

  const overall = decide(aggregatePoints, minObservations, materialChange);

  const principles: PrincipleTrend[] = PRINCIPLE_IDS.map((principle) => {
    const points: Point[] = [];
    for (const s of considered) {
      const y = snapshotPrincipleScore(s, principle);
      // NOT-APPLICABLE FALLS THROUGH HERE AND IS SKIPPED. It is missing data. Pushing a 0
      // in its place is the single most likely bug in this module.
      if (y !== null) points.push({ x: s.at, y });
    }
    const { direction, slope } = decide(points, minObservations, materialChange);
    return {
      principle,
      direction,
      slope,
      first: points.length > 0 ? points[0]!.y : null,
      latest: points.length > 0 ? points[points.length - 1]!.y : null,
      observations: points.length,
    };
  });

  return {
    current: aggregatePoints.length > 0 ? aggregatePoints[aggregatePoints.length - 1]!.y : null,
    direction: overall.direction,
    slope: overall.slope,
    principles,
    windowStart: considered[0]!.at,
    windowEnd: considered[considered.length - 1]!.at,
    snapshotsConsidered: considered.length,
    regressions: principles.filter((p) => p.direction === 'degrading').map((p) => p.principle),
  };
}
