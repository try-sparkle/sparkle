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
 * ── FAILURE CONTRACT ───────────────────────────────────────────────────────────────────
 *
 * A judge that threw, timed out, returned a non-2xx or unparseable JSON is an ATTEMPT THAT DID
 * NOT ANSWER — it never contributes a score, and it never quietly lowers the denominator. Below
 * `MIN_JUDGE_QUORUM` answers this module still returns a verdict object, but with
 * `humaneScore: null`. This module is UNCHANGED by the fail-open decision: it faithfully reports
 * how many judges answered and refuses to invent a score. What changed is downstream —
 * `verdictBlocks` now reads a below-quorum `humaneScore: null` as a NEUTRAL could-not-evaluate
 * that does NOT block (founder decision, 2026-08-25; `sparkle-4xvu29`, `sparkle-g6cc8q`), because
 * an unreachable model is a billing/infra state, not a humaneness finding. It is still never a
 * pass. Nothing here may return a score that was not actually produced by an answering judge.
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
  NoVerdictCause,
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
    // Nothing failed here — the gate looked and found no human-facing surface.
    noVerdictCause: 'none',
    noVerdictDetail: null,
  };
}

/** Round to two places, the precision every surface in this system reports. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Read WHY every judge failed out of the text they failed with.
 *
 * This is only possible because the gate quotes the API's response body rather than its
 * status line alone — the body is where a provider says "your credit balance is too low".
 * Classifying it is the second half of that change: quoting the cause put it on screen,
 * and this decides which sentence the reader is handed.
 *
 * PRECEDENCE is deliberate, not alphabetical. A single judge naming a billing state is
 * enough to return 'credit' even when its siblings merely timed out, because an exhausted
 * balance explains the timeouts and paying is the action that clears all of them; the
 * reverse — reporting an outage while an invoice is the true cause — is exactly the bug.
 * 'auth' ranks below it for the same reason and above 'unreachable'.
 *
 * Matching is on the PROVIDER'S OWN vocabulary (its `error.type` values and the words its
 * messages use), not on our wording, so a paraphrase on our side cannot silently unmatch it.
 */
export function classifyNoVerdictCause(
  failures: readonly { readonly error: string }[],
): NoVerdictCause {
  if (failures.length === 0) return 'unreachable';
  const text = failures.map((f) => f.error).join(' \n ');
  // 402 is the status a provider reserves for this; the words are what the JSON body uses.
  if (/\bHTTP 402\b|credit balance|insufficient[ _-]?(?:quota|credit|funds)|billing|payment required|quota exceeded|rate[ _-]?limit_error|\bHTTP 429\b/i.test(text)) {
    return 'credit';
  }
  if (/\bHTTP 40[13]\b|authentication[ _-]?error|permission[ _-]?error|invalid[ _-]?(?:x-)?api[ _-]?key|unauthorized|not authenticated/i.test(text)) {
    return 'auth';
  }
  // THE REQUEST ITSELF WAS REFUSED — the gate is wrong, not the infrastructure. Beads
  // `sparkle-dy8mu0` / `sparkle-fegwof`: a 400 `invalid_request_error` naming a rejected field
  // is an answer, delivered instantly by a healthy endpoint, and it will be delivered again on
  // every re-run until somebody edits the request. It ranks BELOW credit and auth on purpose:
  // a provider reports an exhausted balance with a 400 `invalid_request_error` as well, and
  // there the remedy is a payment, so the status code alone must never decide.
  if (/\bHTTP 4(?:00|04|22)\b|invalid[ _-]?request[ _-]?error|not[ _-]?found[ _-]?error|are not permitted|unexpected keyword argument|unrecognized[ _-]request[ _-]argument/i.test(text)) {
    return 'request-rejected';
  }
  return 'unreachable';
}

/** How much of the provider's sentence travels. Long enough to carry a rejected field name
 * and the clause around it; short enough that it stays one readable line beside a verdict. */
const NO_VERDICT_DETAIL_CHARS = 300;

/**
 * The provider's own sentence about the first failure, made safe to publish.
 *
 * Three things happen here and each has a reason. It is COLLAPSED to one line, because it is
 * rendered inside a check-run summary and a CI log line and a proxy's HTML error page must not
 * become the summary. It is REDACTED, because it is quoted onto a public pull request comment
 * and a provider that echoes part of the offending request would otherwise publish a key. It
 * is TRUNCATED, for the same reason as the collapse.
 */
export function noVerdictDetailFrom(
  failures: readonly { readonly error: string }[],
): string | null {
  const first = failures.find((f) => (f.error ?? '').trim().length > 0);
  if (!first) return null;
  const oneLine = first.error
    .replace(/\s+/g, ' ')
    // Anthropic-shaped keys and bearer tokens. Deliberately broad: a false redaction costs a
    // reader nothing, and a missed one is published forever on a pull request.
    .replace(/\b(?:sk-ant|sk|Bearer)[-_A-Za-z0-9]{8,}/g, '[redacted]')
    .trim();
  return oneLine.length > NO_VERDICT_DETAIL_CHARS
    ? `${oneLine.slice(0, NO_VERDICT_DETAIL_CHARS - 1)}…`
    : oneLine;
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
    // Only a run with NO score has a cause to report. A scored verdict that also carried
    // one would put a billing sentence on a pull request the judges evaluated perfectly.
    noVerdictCause: hasQuorum ? 'none' : classifyNoVerdictCause(failures),
    // The API's own explanation, carried to the surfaces a human reads. Null once a verdict
    // exists — a scored pull request has no failure to quote.
    noVerdictDetail: hasQuorum ? null : noVerdictDetailFrom(failures),
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
    // Every branch keeps the reserved "Could not evaluate" opening and the "not a pass"
    // closing — check-run.sh keys on both, and neither depends on the cause. What the cause
    // changes is the MIDDLE: the one sentence telling the reader what to actually go and do.
    const counts = `${v.judgesAnswered} of ${v.judgesAttempted} judges answered, and quorum is ${MIN_JUDGE_QUORUM}`;
    switch (v.noVerdictCause) {
      case 'credit':
        return (
          `Could not evaluate — the judge account is out of credit, so ${counts}. ` +
          `The model endpoint is healthy; this is an account balance to top up, and until ` +
          `someone does, no pull request touching human-facing copy can be scored. ` +
          `This is not a pass.`
        );
      case 'auth':
        return (
          `Could not evaluate — the judge API key was rejected as invalid or expired, so ` +
          `${counts}. The key needs re-issuing; nothing about the model or this pull ` +
          `request is at fault. This is not a pass.`
        );
      case 'request-rejected':
        // The one cause where the API's OWN SENTENCE is the actionable content, so it is in
        // the headline rather than a footnote — that sentence names the offending field, and
        // burying it is precisely what cost this gate its entire working life
        // (`sparkle-dy8mu0`). Note what this branch must NOT say: not "unreachable", because
        // the endpoint answered; and not "re-run", because a re-run reproduces it exactly.
        return (
          `Could not evaluate — the API REJECTED this gate's own request, so ${counts}. ` +
          `The endpoint is healthy and re-running will not change this; the request itself ` +
          `has to be fixed. The API said: ${v.noVerdictDetail ?? 'no detail was captured'}. ` +
          `This is not a pass, and it is not a finding about this pull request.`
        );
      default:
        return `Could not evaluate — ${counts}. This is not a pass.`;
    }
  }
  const verb = v.humaneScore < AGGREGATE_THRESHOLD ? 'below' : 'at or above';
  return `HumaneScore ${v.humaneScore.toFixed(2)} — ${verb} the ${AGGREGATE_THRESHOLD} bar.`;
}
