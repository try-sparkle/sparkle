import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MATERIAL_TREND_DELTA,
  MS_PER_DAY,
  snapshotPrincipleScore,
  snapshotScore,
  summarizeTrend,
  type HumaneSnapshot,
} from './humaneTrend.ts';
import {
  aggregateScore,
  PRINCIPLE_IDS,
  type HumaneVerdict,
  type PrincipleAssessment,
  type PrincipleId,
} from './humaneTypes.ts';

const T0 = 1_700_000_000_000;
const ATTENTION: PrincipleId = 'respect-user-attention';
const LONG_TERM: PrincipleId = 'prioritize-long-term-wellbeing';

function scored(principle: PrincipleId, score: number): PrincipleAssessment {
  return { principle, applicability: 'scored', score, rationale: 'because', judgeScores: [] };
}

function na(principle: PrincipleId): PrincipleAssessment {
  return {
    principle,
    applicability: 'not-applicable',
    score: null,
    rationale: 'nothing in this diff touches it',
    judgeScores: [],
  };
}

/**
 * A verdict that FAILED QUORUM: one judge answered, so `humaneScore` is null — per
 * `humaneTypes.ts`, "NO VERDICT EXISTS". The partial per-principle scores that one judge
 * produced are still on the record, which is exactly the bait: they look like usable data.
 */
function noQuorum(principles: PrincipleAssessment[]): HumaneVerdict {
  return verdict(principles, {
    humaneScore: null,
    judgesAnswered: 1,
    judgesAttempted: 3,
    degraded: true,
  });
}

/** A snapshot `day` days after T0 whose verdict failed quorum, at `fill`. */
function silent(day: number, fill: number): HumaneSnapshot {
  return { sha: `silent-${day}`, at: T0 + day * MS_PER_DAY, verdict: noQuorum(allAt(fill)) };
}

/** Every principle at `fill`, then apply `overrides`. */
function allAt(fill: number, overrides: PrincipleAssessment[] = []): PrincipleAssessment[] {
  const by = new Map(overrides.map((o) => [o.principle, o]));
  return PRINCIPLE_IDS.map((id) => by.get(id) ?? scored(id, fill));
}

function verdict(principles: PrincipleAssessment[], over: Partial<HumaneVerdict> = {}): HumaneVerdict {
  return {
    scored: true,
    humaneScore: aggregateScore(principles),
    noVerdictCause: 'none' as const,
    noVerdictDetail: null,
    principles,
    detectors: [],
    citations: [],
    judgeSet: 'hb-v1',
    judgesAnswered: 3,
    judgesAttempted: 3,
    degraded: false,
    lane: 'openrouter',
    ...over,
  };
}

/** A snapshot `day` days after T0, with every principle at `fill` unless overridden. */
function snap(day: number, fill: number, overrides: PrincipleAssessment[] = []): HumaneSnapshot {
  return {
    sha: `sha-${day}`,
    at: T0 + day * MS_PER_DAY,
    verdict: verdict(allAt(fill, overrides)),
  };
}

/** One snapshot per entry of `fills`, one day apart, starting at T0. */
function series(fills: readonly number[]): HumaneSnapshot[] {
  return fills.map((f, i) => snap(i, f));
}

function trendFor(report: ReturnType<typeof summarizeTrend>, principle: PrincipleId) {
  const t = report.principles.find((p) => p.principle === principle);
  if (!t) throw new Error(`no trend for ${principle}`);
  return t;
}

describe('summarizeTrend — paired directions', () => {
  // PAIRED ON PURPOSE. Asserting `improving` alone passes for a function that always
  // returns `improving`; the degrading case is the same shape with the y-axis reversed.
  const RISING = [-1, -0.5, 0, 0.5, 1];
  const FALLING = [...RISING].reverse();

  it('reports improving for a genuinely improving series', () => {
    const r = summarizeTrend(series(RISING));
    expect(r.direction).toBe('improving');
    expect(r.slope).toBeGreaterThan(0);
    expect(r.current).toBe(1);
    expect(trendFor(r, ATTENTION).direction).toBe('improving');
    expect(r.regressions).toEqual([]);
  });

  it('reports degrading for the same shape reversed', () => {
    const r = summarizeTrend(series(FALLING));
    expect(r.direction).toBe('degrading');
    expect(r.slope).toBeLessThan(0);
    expect(r.current).toBe(-1);
    expect(trendFor(r, ATTENTION).direction).toBe('degrading');
    // The actionable output: every principle fell, so every principle is named.
    expect(r.regressions).toEqual([...PRINCIPLE_IDS]);
  });

  it('reports flat for a series that genuinely does not move', () => {
    const r = summarizeTrend(series([0.5, 0.5, 0.5, 0.5]));
    expect(r.direction).toBe('flat');
    expect(r.slope).toBe(0);
    expect(r.regressions).toEqual([]);
  });
});

describe('summarizeTrend — unknown is never flat', () => {
  it('is unknown, not flat, below the minimum observations', () => {
    const r = summarizeTrend(series([0.5]));
    expect(r.direction).toBe('unknown');
    expect(r.direction).not.toBe('flat');
    expect(r.slope).toBeNull();
    // The SNAPSHOT half still answers even when the TRAJECTORY half cannot.
    expect(r.current).toBe(0.5);
    expect(r.snapshotsConsidered).toBe(1);
    expect(trendFor(r, ATTENTION).direction).toBe('unknown');
    expect(trendFor(r, ATTENTION).observations).toBe(1);
  });

  it('is unknown, not flat, when every snapshot marked the principle not-applicable', () => {
    // Everything else is moving, so this cannot be "the whole report is unknown".
    const history = [0, 1, 2, 3].map((d) => snap(d, -1 + d * 0.5, [na(LONG_TERM)]));
    const r = summarizeTrend(history);

    expect(r.direction).toBe('improving');
    const t = trendFor(r, LONG_TERM);
    expect(t.direction).toBe('unknown');
    expect(t.direction).not.toBe('flat');
    expect(t.observations).toBe(0);
    expect(t.first).toBeNull();
    expect(t.latest).toBeNull();
    expect(t.slope).toBeNull();
    expect(r.regressions).not.toContain(LONG_TERM);
  });

  it('is unknown when no two snapshots are separated in time', () => {
    // Three snapshots at the same instant: an ordering exists but a trajectory does not.
    const history: HumaneSnapshot[] = [1, 0, -1].map((s, i) => ({
      sha: `same-${i}`,
      at: T0,
      verdict: verdict(allAt(s)),
    }));
    const r = summarizeTrend(history);
    expect(r.direction).toBe('unknown');
    expect(r.direction).not.toBe('flat');
    expect(r.slope).toBeNull();
  });

  it('honours a raised minObservations and never a lowered one', () => {
    const rising = series([-1, 1]);
    expect(summarizeTrend(rising).direction).toBe('improving');
    expect(summarizeTrend(rising, { minObservations: 3 }).direction).toBe('unknown');
    // The floor of 2 cannot be undercut: one point still cannot make a line.
    expect(summarizeTrend(series([0.5]), { minObservations: 1 }).direction).toBe('unknown');
  });
});

describe('summarizeTrend — not-applicable is missing data, never a zero', () => {
  it('does not report a dip when a principle is skipped mid-series', () => {
    const history = [snap(0, 1), snap(1, 1, [na(LONG_TERM)]), snap(2, 1)];
    const t = trendFor(summarizeTrend(history), LONG_TERM);

    expect(t.direction).toBe('flat');
    expect(t.direction).not.toBe('degrading');
    // Coercing the N/A to 0 would make this 3.
    expect(t.observations).toBe(2);
    expect(t.first).toBe(1);
    expect(t.latest).toBe(1);
  });

  it('does not report a collapse when a principle stops being applicable', () => {
    // Under an N/A -> 0 coercion this series reads [1, 1, 1, 0, 0]: a hard regression that
    // never happened, on a principle whose every real observation was Exemplary.
    const history = [
      snap(0, 1),
      snap(1, 1),
      snap(2, 1),
      snap(3, 1, [na(LONG_TERM)]),
      snap(4, 1, [na(LONG_TERM)]),
    ];
    const r = summarizeTrend(history);
    const t = trendFor(r, LONG_TERM);

    expect(t.direction).toBe('flat');
    expect(t.direction).not.toBe('degrading');
    expect(t.observations).toBe(3);
    expect(t.latest).toBe(1);
    expect(t.slope).toBe(0);
    expect(r.regressions).not.toContain(LONG_TERM);
  });

  it('still catches a real regression on a principle that is sometimes not-applicable', () => {
    // The paired half of the test above: same N/A gaps, but the scored points genuinely
    // fall. Skipping N/A must not also blind the trend to what IS scored.
    const history = [
      snap(0, 1, [scored(LONG_TERM, 1)]),
      snap(1, 1, [na(LONG_TERM)]),
      snap(2, 1, [scored(LONG_TERM, 0)]),
      snap(3, 1, [na(LONG_TERM)]),
      snap(4, 1, [scored(LONG_TERM, -1)]),
    ];
    const r = summarizeTrend(history);
    const t = trendFor(r, LONG_TERM);

    expect(t.direction).toBe('degrading');
    expect(t.observations).toBe(3);
    expect(t.latest).toBe(-1);
    expect(r.regressions).toEqual([LONG_TERM]);
  });

  it('skips a snapshot whose verdict was never scored, however it is decorated', () => {
    // `scored: false` is authoritative over any numbers the record still carries. This one
    // carries a full set of Violations, so a reader that trusted the numbers over the flag
    // would see a crater in an otherwise Exemplary history.
    //
    // THE FIXTURE IS ASYMMETRIC ON PURPOSE, and the previous symmetric one is why. With the
    // crater at the MIDPOINT of `[1, ?, 1]` its own presence cancels out: Theil-Sen's
    // pairwise slopes are {-2, 0, +2}, the median is 0, and the report reads `flat` with no
    // regressions WHETHER OR NOT the guard exists. Every assertion held either way — a
    // textbook vacuous test. Put the crater at the END instead and admitting it drags the
    // median negative, so deleting the guard changes the reported DIRECTION.
    const unscoredCrater = (day: number): HumaneSnapshot => ({
      sha: 'unscored',
      at: T0 + day * MS_PER_DAY,
      verdict: verdict(allAt(-1), { scored: false, humaneScore: -1 }),
    });
    const history: HumaneSnapshot[] = [snap(0, 1), snap(1, 1), snap(2, 1), unscoredCrater(3)];
    const r = summarizeTrend(history);

    expect(r.direction).toBe('flat');
    expect(r.direction).not.toBe('degrading');
    expect(r.current).toBe(1);
    expect(trendFor(r, ATTENTION).observations).toBe(3);
    expect(trendFor(r, ATTENTION).direction).toBe('flat');
    expect(r.regressions).toEqual([]);
    // Counted as considered — it is a placed snapshot; it just carries no point. This one
    // reads 4 either way, so it is documentation and not the discriminator.
    expect(r.snapshotsConsidered).toBe(4);

    // PAIRED, and this is what proves the fixture is genuinely asymmetric rather than
    // merely silent: flip the SAME crater to `scored: true` and the identical numbers do
    // move the trend. If they did not, the assertions above would prove nothing.
    const evaluated = [...history.slice(0, 3), { ...history[3]!, verdict: verdict(allAt(-1)) }];
    const e = summarizeTrend(evaluated);
    expect(e.direction).toBe('degrading');
    expect(e.current).toBe(-1);
    expect(trendFor(e, ATTENTION).observations).toBe(4);
    expect(e.regressions).toEqual([...PRINCIPLE_IDS]);
  });
});

describe('summarizeTrend — a failed quorum is silence, never a data point', () => {
  it('does not let a quorum-failed verdict launder a real regression into improving', () => {
    // ASYMMETRIC ON PURPOSE. The silent snapshot sits at the START and far BELOW the real
    // series, so admitting it does not merely add a point — it flips the reported
    // direction, which is the whole harm. Real, scored history: 0.5 -> 0.3 -> 0.1, a
    // material fall. Resurrect day 0 and Theil-Sen's median slope turns positive.
    const history: HumaneSnapshot[] = [silent(0, -1), snap(1, 0.5), snap(2, 0.3), snap(3, 0.1)];
    const r = summarizeTrend(history);

    expect(r.direction).toBe('degrading');
    expect(r.direction).not.toBe('improving');
    expect(r.slope).toBeLessThan(0);
    expect(r.current).toBe(0.1);
    // The silent snapshot is still COUNTED as considered; it just carries no point.
    expect(r.snapshotsConsidered).toBe(4);
    expect(trendFor(r, ATTENTION).observations).toBe(3);
    expect(trendFor(r, ATTENTION).first).toBe(0.5);
    // The actionable output, computed over real verdicts only.
    expect(r.regressions).toEqual([...PRINCIPLE_IDS]);
  });

  it('falls to unknown, not flat, when too few verdicts survive the quorum gate', () => {
    // Three snapshots, two of them silence. One usable point cannot make a line, and the
    // honest word for that is `unknown` — the SNAPSHOT half still answers.
    const history: HumaneSnapshot[] = [snap(0, 1), silent(1, -1), silent(2, -1)];
    const r = summarizeTrend(history);

    expect(r.direction).toBe('unknown');
    expect(r.direction).not.toBe('flat');
    expect(r.slope).toBeNull();
    expect(r.current).toBe(1);
    expect(r.snapshotsConsidered).toBe(3);
    expect(trendFor(r, ATTENTION).observations).toBe(1);
    expect(r.regressions).toEqual([]);
  });
});

describe('summarizeTrend — robustness to noise', () => {
  it('still reports improving when one bad change sits inside a rising series', () => {
    const r = summarizeTrend(series([0.5, 0.6, -1, 0.8, 0.9, 1]));
    expect(r.direction).toBe('improving');
    expect(r.regressions).toEqual([]);
  });

  it('still reports degrading when one good change sits inside a falling series', () => {
    const r = summarizeTrend(series([1, 0.9, 0.8, 1, 0.6, 0.5]));
    expect(r.direction).toBe('degrading');
  });
});

describe('summarizeTrend — materiality', () => {
  // Both series are perfectly monotonic; the ONLY difference is how far they move.
  const drift = (perDay: number) =>
    series(Array.from({ length: 11 }, (_, i) => Math.round((0.5 - perDay * i) * 100) / 100));

  it('calls an immaterial drift flat', () => {
    const r = summarizeTrend(drift(0.01)); // fitted change 0.10 over the window
    expect(Math.abs(r.slope! * 10)).toBeLessThan(MATERIAL_TREND_DELTA);
    expect(r.direction).toBe('flat');
  });

  it('calls a material drift of the same shape degrading', () => {
    const r = summarizeTrend(drift(0.02)); // fitted change 0.20 over the window
    expect(Math.abs(r.slope! * 10)).toBeGreaterThan(MATERIAL_TREND_DELTA);
    expect(r.direction).toBe('degrading');
  });

  it('lets a caller tighten the threshold', () => {
    expect(summarizeTrend(drift(0.01), { materialChange: 0.05 }).direction).toBe('degrading');
  });

  it('leaves flat reachable at a threshold of 0, on a series that has not moved', () => {
    // `materialChange: 0` is validated as acceptable, and means "report any real movement".
    // Under a `fitted >= materialChange` test it would classify a dead-flat series as
    // `improving` and make `flat` unreachable for EVERY input — a direction claimed on a
    // codebase that did not move, which is the mirror of reporting `unknown` as `flat`.
    const dead = summarizeTrend(series([0.5, 0.5, 0.5, 0.5]), { materialChange: 0 });
    expect(dead.direction).toBe('flat');
    expect(dead.direction).not.toBe('improving');
    expect(dead.slope).toBe(0);
    expect(dead.regressions).toEqual([]);
    expect(trendFor(dead, ATTENTION).direction).toBe('flat');

    // PAIRED: at the same threshold a series that DID move is still reported, in both
    // directions — so "always flat" cannot satisfy this either.
    expect(summarizeTrend(series([0.5, 0.51]), { materialChange: 0 }).direction).toBe('improving');
    expect(summarizeTrend(series([0.51, 0.5]), { materialChange: 0 }).direction).toBe('degrading');
  });

  it('reads the threshold as "must exceed", so a fitted change exactly on it is flat', () => {
    // Two snapshots one day apart moving by exactly 0.5, against a threshold of exactly
    // 0.5: the fitted change IS the threshold. Values chosen to be exactly representable in
    // binary floating point, so this asserts the comparison and not rounding noise. This is
    // the boundary the strict comparison moves, asserted so a slide back to `>=` cannot
    // pass unnoticed.
    const onTheLine = summarizeTrend(series([0, 0.5]), { materialChange: 0.5 });
    expect(onTheLine.slope).toBe(0.5);
    expect(onTheLine.direction).toBe('flat');
    // A hair under the same threshold, same series: the movement is now material.
    expect(summarizeTrend(series([0, 0.5]), { materialChange: 0.49 }).direction).toBe('improving');
    expect(summarizeTrend(series([0.5, 0]), { materialChange: 0.49 }).direction).toBe('degrading');
  });
});

describe('summarizeTrend — window and ordering', () => {
  it('orders an unsorted history by time rather than by arrival', () => {
    const rising = series([-1, -0.5, 0, 0.5, 1]);
    const shuffled = [rising[3]!, rising[0]!, rising[4]!, rising[1]!, rising[2]!];
    const r = summarizeTrend(shuffled);
    expect(r.direction).toBe('improving');
    expect(r.current).toBe(1);
    expect(r.windowStart).toBe(T0);
    expect(r.windowEnd).toBe(T0 + 4 * MS_PER_DAY);
  });

  it('restricts to an injected window, changing the verdict when the window changes', () => {
    // Fell hard, then recovered. Whole history is flat-ish; the recent window is improving.
    const history = series([1, 0, -1, -0.5, 0, 0.5, 1]);
    const now = T0 + 6 * MS_PER_DAY;

    const recent = summarizeTrend(history, { now, windowMs: 4 * MS_PER_DAY });
    expect(recent.snapshotsConsidered).toBe(5);
    expect(recent.windowStart).toBe(T0 + 2 * MS_PER_DAY);
    expect(recent.direction).toBe('improving');

    const early = summarizeTrend(history, { now: T0 + 2 * MS_PER_DAY, windowMs: 2 * MS_PER_DAY });
    expect(early.snapshotsConsidered).toBe(3);
    expect(early.direction).toBe('degrading');
  });

  it('drops snapshots that carry no placeable timestamp', () => {
    const history: HumaneSnapshot[] = [
      ...series([-1, 0, 1]),
      { sha: 'unplaceable', at: Number.NaN, verdict: verdict(allAt(-1)) },
    ];
    const r = summarizeTrend(history);
    expect(r.snapshotsConsidered).toBe(3);
    expect(r.direction).toBe('improving');
    expect(r.current).toBe(1);
  });
});

describe('summarizeTrend — degenerate input never throws', () => {
  it('returns a well-formed unknown report for an empty history', () => {
    const r = summarizeTrend([]);
    expect(r.direction).toBe('unknown');
    expect(r.current).toBeNull();
    expect(r.slope).toBeNull();
    expect(r.windowStart).toBeNull();
    expect(r.windowEnd).toBeNull();
    expect(r.snapshotsConsidered).toBe(0);
    expect(r.regressions).toEqual([]);
    expect(r.principles.map((p) => p.principle)).toEqual([...PRINCIPLE_IDS]);
    expect(r.principles.every((p) => p.direction === 'unknown')).toBe(true);
    expect(r.principles.every((p) => p.observations === 0)).toBe(true);
  });

  it('returns a well-formed report for a single snapshot', () => {
    const r = summarizeTrend(series([-0.5]));
    expect(r.direction).toBe('unknown');
    expect(r.current).toBe(-0.5);
    expect(r.windowStart).toBe(T0);
    expect(r.windowEnd).toBe(T0);
    expect(r.principles).toHaveLength(PRINCIPLE_IDS.length);
  });

  it('reports every principle even when a verdict omits some', () => {
    const partial = [0, 1, 2].map((d) => ({
      sha: `partial-${d}`,
      at: T0 + d * MS_PER_DAY,
      verdict: verdict([scored(ATTENTION, 1 - d)]),
    }));
    const r = summarizeTrend(partial);
    expect(r.principles).toHaveLength(PRINCIPLE_IDS.length);
    expect(trendFor(r, ATTENTION).direction).toBe('degrading');
    expect(trendFor(r, LONG_TERM).direction).toBe('unknown');
    expect(trendFor(r, LONG_TERM).observations).toBe(0);
  });
});

describe('snapshot accessors', () => {
  it('returns null for a quorum-failed verdict rather than recomputing its partial scores', () => {
    // THE CONTRACT: `HumaneVerdict.humaneScore === null` means NO VERDICT EXISTS, not "the
    // field was never persisted". Recomputing an aggregate from `principles` here would
    // resurrect a verdict `verdictBlocks` already refuses, as a real trajectory point.
    const s: HumaneSnapshot = { sha: 'no-quorum', at: T0, verdict: noQuorum(allAt(0.5)) };
    expect(snapshotScore(s)).toBeNull();
    // Same gate on the per-principle accessor, or `regressions` is computed over it.
    expect(snapshotPrincipleScore(s, ATTENTION)).toBeNull();

    // PAIRED: the identical assessment list WITH a quorum does yield its aggregate, so
    // "always returns null" cannot satisfy this.
    const withQuorum: HumaneSnapshot = { sha: 'quorum', at: T0, verdict: verdict(allAt(0.5)) };
    expect(snapshotScore(withQuorum)).toBe(0.5);
    expect(snapshotPrincipleScore(withQuorum, ATTENTION)).toBe(0.5);
  });

  it('returns null for an unscored verdict even when it still carries scores', () => {
    // The paired half of the test above: `scored: false` wins over a populated aggregate and
    // a populated assessment list, so an unevaluated change can never contribute a point.
    const unscored: HumaneSnapshot = {
      sha: 'skip',
      at: T0,
      verdict: verdict(allAt(1), { scored: false, humaneScore: 1 }),
    };
    expect(snapshotScore(unscored)).toBeNull();
    expect(snapshotPrincipleScore(unscored, ATTENTION)).toBeNull();

    const evaluated: HumaneSnapshot = { sha: 'keep', at: T0, verdict: verdict(allAt(1)) };
    expect(snapshotScore(evaluated)).toBe(1);
    expect(snapshotPrincipleScore(evaluated, ATTENTION)).toBe(1);
  });

  it('returns null rather than zero for a not-applicable principle', () => {
    const s = snap(0, 1, [na(LONG_TERM)]);
    expect(snapshotPrincipleScore(s, LONG_TERM)).toBeNull();
    expect(snapshotPrincipleScore(s, ATTENTION)).toBe(1);
  });
});

describe('no clock inside the module', () => {
  it('never reads a clock — every instant is injected', () => {
    const src = readFileSync(new URL('./humaneTrend.ts', import.meta.url), 'utf8');
    // Strip block and line comments: the doc comments discuss `Date.now()` by name.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/new Date/);
    expect(code).not.toMatch(/performance\.now/);
  });
});
