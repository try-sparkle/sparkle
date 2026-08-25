/**
 * The judge ensemble: raw evaluator responses -> one `HumaneVerdict`.
 *
 * This is the third stage of `scope -> render -> judge` (bead `sparkle-4eqjil`, epic
 * `sparkle-9o0649`). `humaneScope` decides WHICH pull requests are scored, `humaneRender`
 * turns the scoped surfaces into the two strings the vendored evaluator consumes, and this
 * module turns what the evaluator says back into the verdict `verdictBlocks` grades.
 *
 * IT IS PURE. No model call, no network, no process spawn — the caller runs the judges and
 * hands the answers here. That is deliberate: the ensemble arithmetic is the part with a
 * right answer, so it must be testable without a paid model in the loop.
 *
 * ── THE SEAM THIS MODULE EXISTS TO HOLD ────────────────────────────────────────────────
 *
 * The vendored evaluator emits SNAKE_CASE principle codes (`respect_attention`); this repo's
 * contract in `humaneTypes` uses KEBAB-CASE ids (`respect-user-attention`). Those two
 * vocabularies were written by different people for different purposes and neither is going
 * to change, so something has to map them — and a mapping is exactly where this epic has
 * been bitten before (`sparkle-16y6h`: two halves built in parallel against a frozen field
 * list, both suites green, the shipped feature never once ran).
 *
 * So the mapping is EXHAUSTIVE IN BOTH DIRECTIONS AND TESTED IN BOTH DIRECTIONS, and an
 * unrecognised code is neither dropped nor guessed — it is REPORTED. See `unmappedCodes`.
 *
 * ── FAILURE CONTRACT, INHERITED AND NON-NEGOTIABLE ─────────────────────────────────────
 *
 * NO REACHABLE MODEL MEANS NO VERDICT, NEVER A PASS (`scripts/humanebench-check-run.sh`).
 * A judge that threw, timed out, or returned unparseable JSON is an ATTEMPT THAT DID NOT
 * ANSWER — it never contributes a score, and it never quietly lowers the denominator. Below
 * `MIN_JUDGE_QUORUM` answers this module still returns a verdict object, but with
 * `humaneScore: null`, which `verdictBlocks` reads as "could not evaluate" and BLOCKS on.
 * Nothing here may return a score that was not actually produced by an answering judge.
 */

import {
  AGGREGATE_THRESHOLD,
  MIN_JUDGE_QUORUM,
  ORDINAL_SCORES,
  PRINCIPLE_IDS,
  aggregateScore,
  isOrdinalScore,
} from './humaneTypes';
import type {
  ComplianceCitation,
  DetectorFinding,
  HumaneVerdict,
  Lane,
  OrdinalScore,
  PrincipleAssessment,
  PrincipleId,
} from './humaneTypes';

/**
 * The vendored evaluator's principle vocabulary -> this repo's.
 *
 * Keys are `VALID_PRINCIPLE_CODES` in `resources/humanebench/humanebench_evaluator.ts`.
 * Values are `PRINCIPLE_IDS` in `humaneTypes.ts`. Both sides are asserted complete by
 * `humaneJudge.test.ts`; adding a principle on either side without touching this table is a
 * test failure, not a silent gap.
 */
export const EVALUATOR_CODE_TO_PRINCIPLE: Readonly<Record<string, PrincipleId>> = Object.freeze({
  respect_attention: 'respect-user-attention',
  meaningful_choices: 'enable-meaningful-choices',
  enhance_capabilities: 'enhance-human-capabilities',
  dignity_safety: 'protect-dignity-and-safety',
  healthy_relationships: 'foster-healthy-relationships',
  longterm_wellbeing: 'prioritize-long-term-wellbeing',
  transparency_honesty: 'be-transparent-and-honest',
  equity_inclusion: 'design-for-equity-and-inclusion',
});

/** The inverse. Present so a caller can name a principle in the evaluator's own words. */
export const PRINCIPLE_TO_EVALUATOR_CODE: Readonly<Record<PrincipleId, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(EVALUATOR_CODE_TO_PRINCIPLE).map(([code, id]) => [id, code]),
  ) as Record<PrincipleId, string>,
);

/** One principle line as the vendored evaluator emits it. Mirrors its `PrincipleScore`. */
export interface RawPrincipleScore {
  name: string;
  score: number;
  rationale?: string;
}

/** One judge's answer for one turn, as the vendored evaluator's `HumaneBenchResult`. */
export interface RawJudgeResult {
  principles: RawPrincipleScore[];
  globalViolations?: string[];
  confidence?: number;
}

/**
 * One judge run against one rendered turn.
 *
 * `result` is `null` when that judge did not answer — it threw, timed out, or returned
 * something unparseable. A null is an ATTEMPT, never an answer, and never a zero.
 */
export interface JudgeAttempt {
  /** The `RenderedTurn.id` this judge was given. Retained so a score can be traced back. */
  turnId: string;
  /** Which member of the ensemble. Distinguishes three judges on one turn. */
  judgeId: string;
  result: RawJudgeResult | null;
  /** Why it did not answer. Required when `result` is null, so silence is never anonymous. */
  error?: string;
}

export interface JudgeOptions {
  /** Versioned judge set, e.g. `hb-v1`. Named in output so a score is never uninterpretable. */
  judgeSet: string;
  lane: Lane;
  /** Deterministic findings from `runDetectors`. They constrain the judged layer. */
  detectors?: readonly DetectorFinding[];
  citations?: readonly ComplianceCitation[];
}

export interface JudgeSummary {
  verdict: HumaneVerdict;
  /**
   * Evaluator codes that no principle claims. NOT dropped silently: an evaluator that starts
   * emitting a ninth principle, or misspells one, shows up here rather than shrinking the
   * assessment by one with everything still green.
   */
  unmappedCodes: string[];
  /** Every attempt that produced no answer, with its reason. */
  failures: { turnId: string; judgeId: string; error: string }[];
}

/**
 * The out-of-scope verdict.
 *
 * `scored: false` is the ONE honest pass in this system: the gate ran, looked, and found no
 * human-facing surface. `humanebench-check-run.sh` renders it as a NON-blocking `neutral`.
 * It is emphatically not the same as "we could not look" — that path is `humaneScore: null`
 * with `scored: true`, which blocks.
 */
export function notScoredVerdict(opts: JudgeOptions): HumaneVerdict {
  return {
    scored: false,
    humaneScore: null,
    principles: [],
    detectors: opts.detectors ?? [],
    citations: opts.citations ?? [],
    judgeSet: opts.judgeSet,
    judgesAnswered: 0,
    judgesAttempted: 0,
    degraded: false,
    lane: opts.lane,
  };
}

/** Round to two places, the precision every surface in this system reports. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Fold every judge attempt into one verdict.
 *
 * A principle is `scored` when at least one answering judge scored it, and `not-applicable`
 * only when NO answering judge did. That asymmetry is deliberate: `applicabilityViolations`
 * cross-checks not-applicable principles against the deterministic detectors, so marking a
 * principle not-applicable is a claim the cheap layer is allowed to refute.
 */
export function summarizeJudgements(
  attempts: readonly JudgeAttempt[],
  opts: JudgeOptions,
): JudgeSummary {
  const judgesAttempted = attempts.length;
  const answered = attempts.filter((a) => a.result !== null);
  const judgesAnswered = answered.length;

  const failures = attempts
    .filter((a) => a.result === null)
    .map((a) => ({
      turnId: a.turnId,
      judgeId: a.judgeId,
      error: a.error ?? 'the judge did not answer, and gave no reason',
    }));

  const byPrinciple = new Map<PrincipleId, { scores: OrdinalScore[]; rationales: string[] }>();
  const unmapped = new Set<string>();

  for (const attempt of answered) {
    for (const raw of attempt.result?.principles ?? []) {
      const id = EVALUATOR_CODE_TO_PRINCIPLE[raw.name];
      if (!id) {
        unmapped.add(raw.name);
        continue;
      }
      // A score outside the four-point ordinal is not a low score — it is a MALFORMED one,
      // and averaging it in would let a hallucinated 7 drag an aggregate anywhere. Drop the
      // line and let the principle stand on whatever valid scores it did receive.
      if (!isOrdinalScore(raw.score)) {
        unmapped.add(`${raw.name} (score ${String(raw.score)} is not one of ${ORDINAL_SCORES.join(', ')})`);
        continue;
      }
      const slot = byPrinciple.get(id) ?? { scores: [], rationales: [] };
      slot.scores.push(raw.score);
      const rationale = (raw.rationale ?? '').trim();
      if (rationale) slot.rationales.push(rationale);
      byPrinciple.set(id, slot);
    }
  }

  // QUORUM IS A PRECONDITION FOR HAVING A SCORE AT ALL, not a modifier applied afterwards.
  // Below it there is no verdict, so nothing is reported as scored — otherwise a single
  // answering judge would produce per-principle numbers that read exactly like an ensemble.
  const hasQuorum = judgesAnswered >= MIN_JUDGE_QUORUM;

  const principles: PrincipleAssessment[] = PRINCIPLE_IDS.map((id) => {
    const slot = hasQuorum ? byPrinciple.get(id) : undefined;
    if (!slot || slot.scores.length === 0) {
      return {
        principle: id,
        applicability: 'not-applicable' as const,
        score: null,
        rationale: hasQuorum
          ? 'No answering judge scored this principle for the surfaces this pull request changed.'
          : `No verdict: ${judgesAnswered} of ${judgesAttempted} judges answered, and quorum is ${MIN_JUDGE_QUORUM}.`,
        judgeScores: [],
      };
    }
    const mean = slot.scores.reduce((sum, s) => sum + s, 0) / slot.scores.length;
    return {
      principle: id,
      applicability: 'scored' as const,
      score: round2(mean),
      rationale: slot.rationales.length > 0
        ? slot.rationales.join(' ')
        : 'Scored, but the judge supplied no rationale.',
      judgeScores: slot.scores,
    };
  });

  const verdict: HumaneVerdict = {
    scored: true,
    humaneScore: hasQuorum ? aggregateScore(principles) : null,
    principles,
    detectors: opts.detectors ?? [],
    citations: opts.citations ?? [],
    judgeSet: opts.judgeSet,
    judgesAnswered,
    judgesAttempted,
    // DEGRADED means "scored on a quorum rather than the full ensemble" — some judge was
    // asked and did not answer, yet enough did that a score exists. It is a caveat printed
    // beside a real number, which is why it requires quorum: without quorum there is no
    // number to caveat.
    degraded: hasQuorum && judgesAnswered < judgesAttempted,
    lane: opts.lane,
  };

  return { verdict, unmappedCodes: [...unmapped].sort(), failures };
}

/**
 * The one-line headline a PR comment leads with.
 *
 * Kept here rather than in the shell so the wording of "no verdict" cannot drift away from
 * the arithmetic that produced it — `AGENTS.md` § *User-facing copy is code*.
 */
export function headline(v: HumaneVerdict): string {
  if (!v.scored) {
    return 'Not scored — this pull request changed no human-facing surface.';
  }
  if (v.humaneScore === null) {
    return `Could not evaluate — ${v.judgesAnswered} of ${v.judgesAttempted} judges answered, and quorum is ${MIN_JUDGE_QUORUM}. This is not a pass.`;
  }
  const verb = v.humaneScore < AGGREGATE_THRESHOLD ? 'below' : 'at or above';
  return `HumaneScore ${v.humaneScore.toFixed(2)} — ${verb} the ${AGGREGATE_THRESHOLD} bar.`;
}
