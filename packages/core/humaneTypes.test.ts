import { describe, expect, it } from 'vitest';

import {
  AGGREGATE_THRESHOLD,
  aggregateScore,
  applicabilityViolations,
  isOrdinalScore,
  MIN_JUDGE_QUORUM,
  PRINCIPLE_FLOOR,
  PRINCIPLE_IDS,
  tierName,
  verdictBlocks,
  type ComplianceCitation,
  type DetectorFinding,
  type HumaneVerdict,
  type PrincipleAssessment,
  type PrincipleId,
} from './humaneTypes';

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

/** Every principle at `fill`, then apply `overrides`. */
function allAt(fill: number, overrides: PrincipleAssessment[] = []): PrincipleAssessment[] {
  const by = new Map(overrides.map((o) => [o.principle, o]));
  return PRINCIPLE_IDS.map((id) => by.get(id) ?? scored(id, fill));
}

function verdict(over: Partial<HumaneVerdict> = {}): HumaneVerdict {
  const principles = over.principles ?? allAt(1);
  return {
    scored: true,
    humaneScore: aggregateScore(principles),
    noVerdictCause: 'none' as const,
    principles,
    detectors: [],
    citations: [],
    judgeSet: 'hb-v1',
    judgesAnswered: 3,
    judgesAttempted: 3,
    degraded: false,
    lane: 'openrouter',
    ...over,
    // `principles` must win over the spread so an explicit list is not clobbered.
    ...(over.principles ? { principles: over.principles } : {}),
  };
}

function citation(over: Partial<ComplianceCitation> = {}): ComplianceCitation {
  return {
    checkId: 'gdpr-art7-3-withdrawal-symmetry',
    pack: 'eu-gdpr',
    instrument: 'Regulation (EU) 2016/679',
    article: 'Art. 7(3)',
    principles: ['enable-meaningful-choices'],
    jurisdiction: ['EU'],
    effectiveFrom: '2018-05-25',
    status: 'blocking',
    guidance: 'withdrawal must be as easy as consent',
    reviewRequired: true,
    ...over,
  };
}

const A11Y_DETECTOR: DetectorFinding = {
  detectorId: 'interactive-no-keyboard-path',
  principle: 'design-for-equity-and-inclusion',
  file: 'feed/List.tsx',
  line: 240,
  message: 'interactive div with no role, tabindex or key handler',
};

describe('the four-point ordinal', () => {
  it('has no zero — the scale is the instrument and a feature is never neutral', () => {
    expect(isOrdinalScore(0)).toBe(false);
    for (const s of [-1, -0.5, 0.5, 1]) expect(isOrdinalScore(s)).toBe(true);
  });

  it('keeps upstream tier vocabulary', () => {
    expect(tierName(1)).toBe('Exemplary');
    expect(tierName(0.5)).toBe('Acceptable');
    expect(tierName(-0.5)).toBe('Concerning');
    expect(tierName(-1)).toBe('Violation');
  });
});

describe('aggregateScore', () => {
  it('averages only applicable principles, so N/A does not drag the mean toward zero', () => {
    // Two at +1, six not applicable. Naively summing over all eight would give 0.25.
    const principles = allAt(1).map((p, i) => (i < 2 ? p : na(p.principle)));
    expect(aggregateScore(principles)).toBe(1);
  });

  it('is null when nothing is applicable — absence of a score, not a score of zero', () => {
    expect(aggregateScore(PRINCIPLE_IDS.map((id) => na(id)))).toBeNull();
  });
});

describe('verdictBlocks — the aggregate gate', () => {
  it(`passes at exactly ${AGGREGATE_THRESHOLD}, the rubric's own Acceptable boundary`, () => {
    const d = verdictBlocks(verdict({ principles: allAt(0.5) }));
    expect(d.blocked).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it('blocks just below the threshold', () => {
    // Seven at +0.5 and one at -0.5 -> 0.375.
    const principles = allAt(0.5, [scored('be-transparent-and-honest', -0.5)]);
    const d = verdictBlocks(verdict({ principles }));
    expect(d.blocked).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/HumaneScore 0\.38 is below 0\.5/);
  });
});

describe('verdictBlocks — the per-principle floor', () => {
  // The reason the floor exists at all. Without it this verdict ships.
  it('blocks a single hard violation that the mean would launder', () => {
    const principles = allAt(1, [scored('be-transparent-and-honest', -1)]);
    const v = verdict({ principles });

    expect(v.humaneScore).toBe(0.75);
    expect(v.humaneScore).toBeGreaterThan(AGGREGATE_THRESHOLD); // aggregate alone would PASS

    const d = verdictBlocks(v);
    expect(d.blocked).toBe(true);
    expect(d.reasons).toHaveLength(1);
    expect(d.reasons[0]).toMatch(/Be Transparent and Honest scored -1\.00, below the -0\.5 floor/);
  });

  it(`passes at exactly ${PRINCIPLE_FLOOR} — the comparison is strict`, () => {
    // Three judges at -0.5 mean exactly -0.5, which is Concerning but not a Violation.
    const principles = allAt(1, [scored('respect-user-attention', -0.5)]);
    expect(verdictBlocks(verdict({ principles })).blocked).toBe(false);
  });

  it('blocks just below the floor, which only an ensemble mean can reach', () => {
    // (-1 + -1 + -0.5) / 3 = -0.8333 — unreachable by any single judge.
    const principles = allAt(1, [scored('respect-user-attention', -0.8333)]);
    const d = verdictBlocks(verdict({ principles }));
    expect(d.blocked).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/Respect User Attention scored -0\.83/);
  });
});

describe('verdictBlocks — the fail-open contract when no model was reachable', () => {
  // Founder decision (2026-08-25, sparkle-4xvu29 / sparkle-g6cc8q): a gate that cannot reach its
  // model must NOT become a repository-wide merge block. Below quorum there is no judged verdict,
  // so this is a NEUTRAL could-not-evaluate — non-blocking — not a red check.
  it('does NOT block when too few judges answered — it fails open, model unreachable', () => {
    const d = verdictBlocks(verdict({ judgesAnswered: 1, judgesAttempted: 3, humaneScore: null }));
    expect(d.blocked).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it('does NOT block when ZERO judges answered — the exhausted-key / non-2xx case', () => {
    const d = verdictBlocks(verdict({ judgesAnswered: 0, judgesAttempted: 3, humaneScore: null }));
    expect(d.blocked).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it(`scores on a quorum of ${MIN_JUDGE_QUORUM} and says it is degraded`, () => {
    const v = verdict({ judgesAnswered: 2, judgesAttempted: 3, degraded: true });
    expect(verdictBlocks(v).blocked).toBe(false);
    expect(v.degraded).toBe(true);
  });

  it('does NOT block a null aggregate at quorum with nothing else found — still a could-not-evaluate', () => {
    // The reachable judges produced nothing scoreable, and no detector fired. That is another
    // could-not-evaluate, not a violation: neutral, not a block.
    const principles = PRINCIPLE_IDS.map((id) => na(id));
    const d = verdictBlocks(verdict({ judgesAnswered: 3, principles, humaneScore: null, detectors: [] }));
    expect(d.blocked).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it('DOES block a null aggregate at quorum when a detector refutes an N/A dismissal — the paired positive', () => {
    // With the model REACHABLE (quorum met), the deterministic detector still holds the judged
    // layer to account: a principle dismissed as N/A that a detector found evidence for blocks.
    // Without this pair, the neutral cases above could be satisfied by a gate that never blocks.
    const principles = PRINCIPLE_IDS.map((id) => na(id));
    const d = verdictBlocks(
      verdict({ judgesAnswered: 3, principles, humaneScore: null, detectors: [A11Y_DETECTOR] }),
    );
    expect(d.blocked).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/marked not-applicable, but a detector found evidence/);
  });
});

describe('scope — the defence that keeps the gate alive', () => {
  // Paired with every blocking case above: if this passed for a verdict that SHOULD block,
  // the scope escape would be a universal bypass.
  it('does not block a change that touched no human-affecting surface', () => {
    const d = verdictBlocks(verdict({ scored: false, principles: [], humaneScore: null }));
    expect(d.blocked).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it('still blocks an identical unscoped verdict once it IS in scope', () => {
    const principles = allAt(1, [scored('respect-user-attention', -1)]);
    expect(verdictBlocks(verdict({ scored: false, principles })).blocked).toBe(false);
    expect(verdictBlocks(verdict({ scored: true, principles })).blocked).toBe(true);
  });
});

describe('applicability — the coupling that keeps the judged layer honest', () => {
  it('names a principle dismissed as N/A that a detector found evidence for', () => {
    const principles = allAt(1, [na('design-for-equity-and-inclusion')]);
    const v = verdict({ principles, detectors: [A11Y_DETECTOR] });

    expect(applicabilityViolations(v)).toEqual(['design-for-equity-and-inclusion']);

    const d = verdictBlocks(v);
    expect(d.blocked).toBe(true);
    expect(d.reasons.join(' ')).toMatch(
      /Ensure Accessibility was marked not-applicable, but a detector found evidence/,
    );
  });

  it('permits N/A on principles no detector fired on', () => {
    const principles = allAt(1, [na('foster-healthy-relationships')]);
    const v = verdict({ principles, detectors: [A11Y_DETECTOR] });
    expect(applicabilityViolations(v)).toEqual([]);
    expect(verdictBlocks(v).blocked).toBe(false);
  });

  it('is satisfied when the judge scored the principle the detector fired on', () => {
    // Same detector, but the principle was actually assessed. No violation.
    const v = verdict({ principles: allAt(1), detectors: [A11Y_DETECTOR] });
    expect(applicabilityViolations(v)).toEqual([]);
    expect(verdictBlocks(v).blocked).toBe(false);
  });
});

describe('compliance citations', () => {
  it('blocks on a citation whose status is blocking', () => {
    const d = verdictBlocks(verdict({ citations: [citation()] }));
    expect(d.blocked).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/Regulation \(EU\) 2016\/679 Art\. 7\(3\) \(eu-gdpr\)/);
  });

  // The pair. Without this, a bug that blocked on EVERY citation would pass the test above.
  it('does not block on advisory or review citations — a rule not yet in force informs, it does not stop', () => {
    const advisory = citation({ checkId: 'aiact-art50', status: 'advisory', effectiveFrom: '2027-08-02' });
    const review = citation({ checkId: 'uk-aadc-13', status: 'review' });
    const d = verdictBlocks(verdict({ citations: [advisory, review] }));
    expect(d.blocked).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it('never enters the humane score — a law is not averaged onto an ordinal', () => {
    const withCitation = verdict({ citations: [citation()] });
    const without = verdict();
    expect(withCitation.humaneScore).toBe(without.humaneScore);
  });
});

describe('verdictBlocks — reporting', () => {
  it('reports every independent reason, not just the first', () => {
    const principles = allAt(-0.5, [scored('respect-user-attention', -1)]);
    const d = verdictBlocks(verdict({ principles, citations: [citation()] }));
    expect(d.blocked).toBe(true);
    // aggregate + floor + citation
    expect(d.reasons.length).toBeGreaterThanOrEqual(3);
    expect(d.reasons.join(' ')).toMatch(/HumaneScore/);
    expect(d.reasons.join(' ')).toMatch(/floor/);
    expect(d.reasons.join(' ')).toMatch(/Art\. 7\(3\)/);
  });
});
