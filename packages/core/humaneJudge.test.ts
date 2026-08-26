import { describe, expect, it } from 'vitest';

import {
  EVALUATOR_CODE_TO_PRINCIPLE,
  PRINCIPLE_TO_EVALUATOR_CODE,
  headline,
  notScoredVerdict,
  summarizeJudgements,
} from './humaneJudge';
import type { JudgeAttempt, JudgeOptions, RawJudgeResult } from './humaneJudge';
import { MIN_JUDGE_QUORUM, PRINCIPLE_IDS, verdictBlocks } from './humaneTypes';
import type { DetectorFinding } from './humaneTypes';

const OPTS: JudgeOptions = { judgeSet: 'hb-v1', lane: 'openrouter' };

/** The evaluator's own vocabulary, so a fixture cannot drift from the real wire format. */
const CODES = Object.keys(EVALUATOR_CODE_TO_PRINCIPLE);

function allPrinciples(score: number, rationale = 'because'): RawJudgeResult {
  return { principles: CODES.map((name) => ({ name, score, rationale })) };
}

function answered(judgeId: string, result: RawJudgeResult, turnId = 't1'): JudgeAttempt {
  return { turnId, judgeId, result };
}

function silent(judgeId: string, error = 'timed out', turnId = 't1'): JudgeAttempt {
  return { turnId, judgeId, result: null, error };
}

describe('the evaluator <-> contract principle mapping', () => {
  // The seam that made a whole feature inert once before (sparkle-16y6h). Asserted in BOTH
  // directions, because a table can be complete one way and short the other.
  it('covers all eight contract principles', () => {
    expect(Object.values(EVALUATOR_CODE_TO_PRINCIPLE).sort()).toEqual([...PRINCIPLE_IDS].sort());
  });

  it('covers all eight evaluator codes, and round-trips', () => {
    expect(CODES).toHaveLength(8);
    for (const code of CODES) {
      const id = EVALUATOR_CODE_TO_PRINCIPLE[code];
      expect(id).toBeDefined();
      expect(PRINCIPLE_TO_EVALUATOR_CODE[id!]).toBe(code);
    }
  });

  it('maps the renamed principle by its UNCHANGED wire id', () => {
    // 'Ensure Accessibility' was renamed for display on 2026-08-22; the id is the wire format
    // and is quoted in published figures, so it must not have moved with the display name.
    expect(EVALUATOR_CODE_TO_PRINCIPLE.equity_inclusion).toBe('design-for-equity-and-inclusion');
  });
});

describe('quorum — below it there is no verdict, and no verdict is not a pass', () => {
  it(`scores nothing when fewer than ${MIN_JUDGE_QUORUM} judges answer`, () => {
    const { verdict } = summarizeJudgements(
      [answered('j1', allPrinciples(1)), silent('j2'), silent('j3')],
      OPTS,
    );

    expect(verdict.judgesAnswered).toBe(1);
    expect(verdict.judgesAttempted).toBe(3);
    // The single judge said 1.0 across the board. If quorum were ignored, humaneScore would
    // be 1.00 and this PR would sail through on ONE answer.
    expect(verdict.humaneScore).toBeNull();
    expect(verdict.principles.every((p) => p.applicability === 'not-applicable')).toBe(true);
    expect(verdict.principles.every((p) => p.score === null)).toBe(true);
  });

  it('does NOT block a sub-quorum verdict — fail open, the model was unreachable', () => {
    // Founder decision (sparkle-4xvu29, sparkle-g6cc8q): below quorum no model was reached, so
    // there is no verdict to gate on. That is a neutral could-not-evaluate, not a merge block —
    // an exhausted key or a non-2xx endpoint must not become a repository-wide block.
    const { verdict } = summarizeJudgements([answered('j1', allPrinciples(1)), silent('j2')], OPTS);
    expect(verdict.judgesAnswered).toBe(1);
    expect(verdict.humaneScore).toBeNull();
    const decision = verdictBlocks(verdict);
    expect(decision.blocked).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  it('STILL blocks once the model IS reachable and returns a low score — the paired positive', () => {
    // The fail-open above is specific to UNREACHABILITY, not a blanket "never block". Cross the
    // quorum with a genuine low score and the same gate blocks — otherwise a bug that simply
    // never blocked would pass the fail-open test above for the wrong reason.
    const { verdict } = summarizeJudgements(
      [answered('j1', allPrinciples(-0.5)), answered('j2', allPrinciples(-0.5))],
      OPTS,
    );
    expect(verdict.judgesAnswered).toBe(2);
    expect(verdict.humaneScore).toBe(-0.5);
    const decision = verdictBlocks(verdict);
    expect(decision.blocked).toBe(true);
    expect(decision.reasons.join(' ')).toContain('below');
  });

  it('is NOT degraded below quorum — there is no number to caveat', () => {
    const { verdict } = summarizeJudgements([answered('j1', allPrinciples(1)), silent('j2')], OPTS);
    expect(verdict.degraded).toBe(false);
  });

  it('records why each silent judge was silent', () => {
    const { failures } = summarizeJudgements(
      [answered('j1', allPrinciples(1)), silent('j2', 'HTTP 529 overloaded')],
      OPTS,
    );
    expect(failures).toEqual([{ turnId: 't1', judgeId: 'j2', error: 'HTTP 529 overloaded' }]);
  });

  it('never leaves a silent judge anonymous, even with no reason given', () => {
    const { failures } = summarizeJudgements(
      [answered('j1', allPrinciples(1)), { turnId: 't1', judgeId: 'j2', result: null }],
      OPTS,
    );
    expect(failures[0]?.error).toMatch(/gave no reason/);
  });
});

describe('scoring at quorum', () => {
  it('means the ensemble per principle and aggregates over applicable ones', () => {
    const { verdict } = summarizeJudgements(
      [answered('j1', allPrinciples(1)), answered('j2', allPrinciples(0.5))],
      OPTS,
    );

    expect(verdict.judgesAnswered).toBe(2);
    expect(verdict.humaneScore).toBe(0.75);
    expect(verdict.principles.every((p) => p.applicability === 'scored')).toBe(true);
    expect(verdict.principles[0]?.judgeScores).toEqual([1, 0.5]);
    expect(verdictBlocks(verdict).blocked).toBe(false);
  });

  it('blocks a below-bar score, naming the number', () => {
    const { verdict } = summarizeJudgements(
      [answered('j1', allPrinciples(-0.5)), answered('j2', allPrinciples(-0.5))],
      OPTS,
    );

    expect(verdict.humaneScore).toBe(-0.5);
    const decision = verdictBlocks(verdict);
    expect(decision.blocked).toBe(true);
    expect(decision.reasons.join(' ')).toContain('-0.50');
  });

  it('flags degraded when some judge was asked and did not answer', () => {
    const { verdict } = summarizeJudgements(
      [answered('j1', allPrinciples(1)), answered('j2', allPrinciples(1)), silent('j3')],
      OPTS,
    );
    expect(verdict.degraded).toBe(true);
    expect(verdict.humaneScore).toBe(1);
  });

  it('is not degraded when every judge answered', () => {
    const { verdict } = summarizeJudgements(
      [answered('j1', allPrinciples(1)), answered('j2', allPrinciples(1))],
      OPTS,
    );
    expect(verdict.degraded).toBe(false);
  });

  it('keeps every judge rationale, so a contested score is arguable', () => {
    const { verdict } = summarizeJudgements(
      [
        answered('j1', { principles: [{ name: 'respect_attention', score: 1, rationale: 'calm' }] }),
        answered('j2', { principles: [{ name: 'respect_attention', score: -1, rationale: 'nags' }] }),
      ],
      OPTS,
    );
    const attention = verdict.principles.find((p) => p.principle === 'respect-user-attention')!;
    expect(attention.rationale).toBe('calm nags');
    expect(attention.judgeScores).toEqual([1, -1]);
    expect(attention.score).toBe(0);
  });

  it('marks a principle no answering judge scored as not-applicable, not as zero', () => {
    const one: RawJudgeResult = {
      principles: [{ name: 'respect_attention', score: 1, rationale: 'fine' }],
    };
    const { verdict } = summarizeJudgements([answered('j1', one), answered('j2', one)], OPTS);

    const untouched = verdict.principles.find((p) => p.principle === 'protect-dignity-and-safety')!;
    expect(untouched.applicability).toBe('not-applicable');
    expect(untouched.score).toBeNull();
    expect(untouched.rationale).not.toBe('');
    // Aggregating over applicable principles only — one principle at 1.0, not 1/8th of it.
    expect(verdict.humaneScore).toBe(1);
  });
});

describe('malformed evaluator output is reported, never absorbed', () => {
  it('surfaces an unrecognised principle code instead of dropping it', () => {
    const rogue: RawJudgeResult = {
      principles: [{ name: 'respect_attention', score: 1 }, { name: 'ninth_principle', score: 1 }],
    };
    const { unmappedCodes } = summarizeJudgements([answered('j1', rogue), answered('j2', rogue)], OPTS);
    expect(unmappedCodes).toContain('ninth_principle');
  });

  it('refuses a score outside the four-point ordinal rather than averaging it in', () => {
    const hallucinated: RawJudgeResult = {
      principles: [{ name: 'respect_attention', score: 7 }],
    };
    const { verdict, unmappedCodes } = summarizeJudgements(
      [answered('j1', hallucinated), answered('j2', hallucinated)],
      OPTS,
    );

    // A 7 must not become a score. If it were absorbed, humaneScore would be 7.
    expect(verdict.humaneScore).toBeNull();
    expect(unmappedCodes.join(' ')).toContain('score 7');
  });

  it('keeps the valid lines when one line of the same answer is malformed', () => {
    const mixed: RawJudgeResult = {
      principles: [
        { name: 'respect_attention', score: 1, rationale: 'ok' },
        { name: 'dignity_safety', score: 42 },
      ],
    };
    const { verdict } = summarizeJudgements([answered('j1', mixed), answered('j2', mixed)], OPTS);

    expect(verdict.principles.find((p) => p.principle === 'respect-user-attention')!.score).toBe(1);
    expect(
      verdict.principles.find((p) => p.principle === 'protect-dignity-and-safety')!.applicability,
    ).toBe('not-applicable');
  });
});

describe('the out-of-scope verdict is the one honest pass', () => {
  it('does not block, and carries no score', () => {
    const v = notScoredVerdict(OPTS);
    expect(v.scored).toBe(false);
    expect(v.humaneScore).toBeNull();
    expect(verdictBlocks(v).blocked).toBe(false);
  });

  it('reads differently from "could not evaluate"', () => {
    // check-run.sh reserves the phrase "could not evaluate" for the NO-VERDICT paths and its
    // own suite asserts the not-scored summary never contains it. Same rule on this side.
    expect(headline(notScoredVerdict(OPTS))).not.toContain('could not evaluate');
    const { verdict } = summarizeJudgements([answered('j1', allPrinciples(1)), silent('j2')], OPTS);
    expect(headline(verdict)).toContain('Could not evaluate');
    expect(headline(verdict)).toContain('not a pass');
  });
});

describe('the detector layer still constrains the judged one', () => {
  it('blocks when a detector fired on a principle the judges called not-applicable', () => {
    const finding: DetectorFinding = {
      detectorId: 'meaningfulImageNoAlt',
      principle: 'design-for-equity-and-inclusion',
      file: 'apps/desktop/src/P.tsx',
      message: 'image has no alt text',
    };
    const partial: RawJudgeResult = {
      principles: [{ name: 'respect_attention', score: 1, rationale: 'fine' }],
    };
    const { verdict } = summarizeJudgements([answered('j1', partial), answered('j2', partial)], {
      ...OPTS,
      detectors: [finding],
    });

    const decision = verdictBlocks(verdict);
    expect(decision.blocked).toBe(true);
    expect(decision.reasons.join(' ')).toContain('not-applicable');
  });
});

describe('the verdict carries what the check run reads', () => {
  it('emits every field humanebench-check-run.sh derives its conclusion from', () => {
    const { verdict } = summarizeJudgements(
      [answered('j1', allPrinciples(1)), answered('j2', allPrinciples(1))],
      OPTS,
    );
    // Fields read by scripts/humanebench-check-run.sh in DERIVED mode. A rename here makes
    // the gate fail closed with "not a verdict this gate can read", so pin them.
    for (const key of [
      'scored',
      'humaneScore',
      'principles',
      'judgesAnswered',
      'judgesAttempted',
      'lane',
      'judgeSet',
      'degraded',
    ]) {
      expect(verdict).toHaveProperty(key);
    }
    expect(verdict.judgeSet).toBe('hb-v1');
    expect(verdict.lane).toBe('openrouter');
  });
});

describe('CANNOT-PAY is not CANNOT-REACH — an unpaid bill must not read as an outage', () => {
  // Bead sparkle-4xvu29. Every judge call failing because the account has no credit left
  // rendered word-for-word like a dead endpoint: "Could not evaluate — 0 of 3 judges
  // answered". Four green pull requests sat on that wording while the actual remedy was a
  // payment nobody knew was owed. The gate already quotes the API's response body, so the
  // cause is present in the failure text — it was simply never classified.
  const CREDIT = 'HTTP 400 Bad Request — {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
  const RATE = 'HTTP 429 Too Many Requests — {"type":"error","error":{"type":"rate_limit_error","message":"quota exceeded for this organization"}}';
  const AUTHFAIL = 'HTTP 401 Unauthorized — {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
  const DEAD = 'fetch failed: connect ECONNREFUSED 127.0.0.1:443';

  function noVerdict(error: string) {
    return summarizeJudgements([silent('j1', error), silent('j2', error), silent('j3', error)], OPTS)
      .verdict;
  }

  it('names the account balance, and the remedy, when the key is out of credit', () => {
    const line = headline(noVerdict(CREDIT));
    expect(line).toMatch(/credit|billing/i);
    // The remedy a reader will act on must be the one that works. Sending someone to check
    // the model endpoint when the endpoint is fine is how this cost four PRs and two days.
    expect(line).not.toMatch(/unreachable|could not be reached/i);
  });

  it('treats a quota/rate-limit refusal as the same account-state class', () => {
    expect(headline(noVerdict(RATE))).toMatch(/credit|quota|billing/i);
  });

  it('keeps an expired or invalid key DISTINCT from an unpaid bill', () => {
    // Different remedy, different person. Folding them together recreates the bug one level up.
    const line = headline(noVerdict(AUTHFAIL));
    expect(line).toMatch(/key|credential/i);
    expect(line).not.toMatch(/credit balance|billing/i);
  });

  it('still says the generic thing when the cause really IS an unreachable model', () => {
    // The paired negative: without it, a classifier that fires on everything passes the
    // three tests above while telling every reader to go pay a bill they do not owe.
    const line = headline(noVerdict(DEAD));
    expect(line).toMatch(/Could not evaluate/);
    expect(line).not.toMatch(/credit|billing|quota/i);
  });

  it('is still NOT A PASS, and still does not block, whatever the cause', () => {
    // The fail-open contract is the reason this bug was survivable. Classifying the cause
    // must not quietly convert a neutral no-verdict into a blocking one.
    for (const err of [CREDIT, RATE, AUTHFAIL, DEAD]) {
      const v = noVerdict(err);
      expect(v.humaneScore).toBeNull();
      expect(headline(v)).toContain('not a pass');
      expect(verdictBlocks(v).blocked).toBe(false);
    }
  });

  it('reports no cause at all once a real verdict exists', () => {
    // A cause field left populated on a scored verdict would put a billing sentence on a
    // pull request that was judged perfectly well.
    const { verdict } = summarizeJudgements(
      [answered('j1', allPrinciples(1)), answered('j2', allPrinciples(1))],
      OPTS,
    );
    expect(verdict.noVerdictCause).toBe('none');
    expect(headline(verdict)).not.toMatch(/credit|billing|quota|key/i);
  });
});
