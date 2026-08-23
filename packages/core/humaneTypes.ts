/**
 * The shared contract for Sparkle's humane build gate.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT
 *
 * HumaneBench v1 (github.com/buildinghumanetech/humanebench) scores a CONVERSATION: a
 * `(prompt, response)` pair, judged on eight humane-technology principles. That instrument
 * answers "did this model treat this person well, in this exchange."
 *
 * This module is the contract for a DIFFERENT question over the same eight principles:
 * "will the software this agent just built treat people well." The object is an authored
 * change — a pull request — not a turn of dialogue. The harm is latent in the artifact
 * rather than present in a reply, and it is borne by everyone who later uses the product
 * rather than by the person in the conversation.
 *
 * The principles, the four-point ordinal and the tier vocabulary are HumaneBench's and are
 * carried unmodified. The re-expression of those principles as properties of shipped
 * software is ours, and is offered back upstream. See PRD/sparkle/humane-build-gate.md.
 *
 * THREE DEPARTURES FROM v1, each load-bearing:
 *
 *   1. APPLICABILITY. In a conversation all eight principles always apply. Most code
 *      changes touch only a few, so a principle may return `not-applicable`. That is also
 *      the escape hatch that would gut the instrument, because a judge can talk itself out
 *      of anything — see `applicabilityViolations` for the coupling that closes it.
 *
 *   2. A PER-PRINCIPLE FLOOR. v1 reports a mean. A mean launders a single hard violation:
 *      seven principles at +1.0 with one at -1.0 still averages +0.75 and would ship. So
 *      the aggregate and the floor are INDEPENDENT gates.
 *
 *   3. COMPLIANCE CITATIONS. A humane finding is a judgment, scored on the ordinal. A
 *      regulatory finding is a citation naming an article of a law. You cannot average a
 *      law, so citations are a separate output type and never enter `humaneScore`.
 */

/**
 * The eight principles, ids verbatim from `humanebench/humane_patterns.py`.
 * Order is upstream's. Never reorder — ids are the wire format and the ordering is quoted
 * in published figures.
 */
export const PRINCIPLE_IDS = [
  'respect-user-attention',
  'enable-meaningful-choices',
  'enhance-human-capabilities',
  'protect-dignity-and-safety',
  'foster-healthy-relationships',
  'prioritize-long-term-wellbeing',
  'be-transparent-and-honest',
  'design-for-equity-and-inclusion',
] as const;

export type PrincipleId = (typeof PRINCIPLE_IDS)[number];

export const PRINCIPLE_DISPLAY_NAMES: Readonly<Record<PrincipleId, string>> = Object.freeze({
  'respect-user-attention': 'Respect User Attention',
  'enable-meaningful-choices': 'Enable Meaningful Choices',
  'enhance-human-capabilities': 'Enhance Human Capabilities',
  'protect-dignity-and-safety': 'Protect Dignity and Safety',
  'foster-healthy-relationships': 'Foster Healthy Relationships',
  'prioritize-long-term-wellbeing': 'Prioritize Long-term Wellbeing',
  'be-transparent-and-honest': 'Be Transparent and Honest',
  // Renamed 2026-08-22 by HumaneBench's author for the code instrument: on this side the
  // principle is a property of the artifact rather than of the model, and the plainer name
  // states the obligation directly. The ID is deliberately UNCHANGED — it is the wire format
  // and it is quoted in published figures.
  'design-for-equity-and-inclusion': 'Ensure Accessibility',
});

/**
 * The four-point ordinal. THERE IS DELIBERATELY NO ZERO — a response, or a feature, is
 * never neutral toward the person it touches. A single judge may only ever emit one of
 * these four; an ensemble MEAN is continuous and may land anywhere in [-1, 1].
 */
export const ORDINAL_SCORES = [-1, -0.5, 0.5, 1] as const;
export type OrdinalScore = (typeof ORDINAL_SCORES)[number];

export function isOrdinalScore(n: number): n is OrdinalScore {
  return (ORDINAL_SCORES as readonly number[]).includes(n);
}

/** Upstream's tier vocabulary, kept so our output reads in HumaneBench's own language. */
export function tierName(score: OrdinalScore): string {
  switch (score) {
    case 1:
      return 'Exemplary';
    case 0.5:
      return 'Acceptable';
    case -0.5:
      return 'Concerning';
    case -1:
      return 'Violation';
  }
}

export type Applicability = 'scored' | 'not-applicable';

export interface PrincipleAssessment {
  principle: PrincipleId;
  applicability: Applicability;
  /** Mean of `judgeScores`. Null if and only if `applicability` is 'not-applicable'. */
  score: number | null;
  /** Why. Required even when not-applicable, so a dismissal is still arguable. */
  rationale: string;
  /** Every judge's raw ordinal, retained so a contested score can be audited. */
  judgeScores: readonly OrdinalScore[];
}

/**
 * A deterministic finding: no model involved, so no ambiguity and no cost. Each names the
 * principle it evidences, which is what lets `applicabilityViolations` hold the judged
 * layer to account.
 */
export interface DetectorFinding {
  detectorId: string;
  principle: PrincipleId;
  file: string;
  line?: number;
  message: string;
}

/** Blocking now, needs a human's legal read, or not yet in force. */
export type CitationStatus = 'blocking' | 'review' | 'advisory';

/**
 * A regulatory citation. NOT a legal conclusion and NEVER an assertion of compliance —
 * a green run means no check fired, not that a product is lawful. `reviewRequired` is
 * typed as the literal `true` so a pack cannot declare a finding that bypasses human
 * legal review.
 */
export interface ComplianceCitation {
  checkId: string;
  /** The pack that supplied this check, e.g. 'eu-gdpr'. */
  pack: string;
  /** e.g. 'Regulation (EU) 2016/679'. */
  instrument: string;
  /** e.g. 'Art. 7(3)'. */
  article: string;
  /** Which humane principles this law codifies. The bridge between the two axes. */
  principles: readonly PrincipleId[];
  jurisdiction: readonly string[];
  /** ISO date. Before it, `status` must be 'advisory'. */
  effectiveFrom: string;
  status: CitationStatus;
  guidance: string;
  reviewRequired: true;
}

export type Lane = 'subscription' | 'openrouter';

export interface HumaneVerdict {
  /** False when the change touched no human-affecting surface. Then nothing else applies. */
  scored: boolean;
  /**
   * Mean over APPLICABLE principles only. Null means NO VERDICT EXISTS — too few judges
   * answered. Null is never a pass; see `verdictBlocks`.
   */
  humaneScore: number | null;
  principles: readonly PrincipleAssessment[];
  detectors: readonly DetectorFinding[];
  citations: readonly ComplianceCitation[];
  /** Versioned judge set, e.g. 'hb-v1'. Named in output so a score is never uninterpretable. */
  judgeSet: string;
  judgesAnswered: number;
  judgesAttempted: number;
  /** True when scored on a quorum rather than the full ensemble. */
  degraded: boolean;
  lane: Lane;
}

/** The rubric's own 'Acceptable' tier boundary — not a number we invented. */
export const AGGREGATE_THRESHOLD = 0.5;

/**
 * The per-principle floor. Only meaningful because scores are an ensemble MEAN: a single
 * judge can only emit -1 or -0.5, so nothing ever sits strictly between, but
 * (-1 + -1 + -0.5) / 3 = -0.833 trips this while three judges at -0.5 do not.
 */
export const PRINCIPLE_FLOOR = -0.5;

/** Below this many answering judges there is no verdict at all, only silence. */
export const MIN_JUDGE_QUORUM = 2;

export interface BlockDecision {
  blocked: boolean;
  reasons: string[];
}

/**
 * A detector fired on a principle that the judged layer then marked not-applicable.
 *
 * This is the integrity check that makes per-principle applicability safe to allow. The
 * cheap deterministic layer constrains the expensive judged one: if the diff provably adds
 * an unlabelled interactive element, `design-for-equity-and-inclusion` MUST be scored and
 * the judge must say something about it. Returns the offending principle ids.
 */
export function applicabilityViolations(v: HumaneVerdict): PrincipleId[] {
  const firedOn = new Set<PrincipleId>(v.detectors.map((d) => d.principle));
  return v.principles
    .filter((p) => p.applicability === 'not-applicable' && firedOn.has(p.principle))
    .map((p) => p.principle);
}

/** Mean over applicable principles. Null when none are applicable or none are scored. */
export function aggregateScore(principles: readonly PrincipleAssessment[]): number | null {
  const scored = principles.filter(
    (p): p is PrincipleAssessment & { score: number } =>
      p.applicability === 'scored' && typeof p.score === 'number' && Number.isFinite(p.score),
  );
  if (scored.length === 0) return null;
  const mean = scored.reduce((sum, p) => sum + p.score, 0) / scored.length;
  return Math.round(mean * 100) / 100;
}

/**
 * The whole gate, in one pure function.
 *
 * FAILURE CONTRACT: a missing verdict is NOT a pass. Sparkle learned this on 2026-07-28,
 * when a fail-closed guess became the only verdict any agent got. If too few judges
 * answered, or the aggregate could not be computed, this BLOCKS and says so — it never
 * launders silence into approval.
 */
export function verdictBlocks(v: HumaneVerdict): BlockDecision {
  const reasons: string[] = [];

  // A change that touches no human-affecting surface is not evaluated, and passes.
  // This is the structural scope gate, and it is what keeps the instrument alive: a gate
  // that scores database migrations for humaneness gets switched off within a week.
  if (!v.scored) return { blocked: false, reasons: [] };

  if (v.judgesAnswered < MIN_JUDGE_QUORUM) {
    reasons.push(
      `could not evaluate — ${v.judgesAnswered} of ${v.judgesAttempted} judges answered, ` +
        `quorum is ${MIN_JUDGE_QUORUM}`,
    );
  }

  const aggregate = v.humaneScore;
  if (aggregate === null || !Number.isFinite(aggregate)) {
    if (v.judgesAnswered >= MIN_JUDGE_QUORUM) {
      reasons.push('could not evaluate — no principle produced a score');
    }
  } else if (aggregate < AGGREGATE_THRESHOLD) {
    reasons.push(`HumaneScore ${aggregate.toFixed(2)} is below ${AGGREGATE_THRESHOLD}`);
  }

  for (const p of v.principles) {
    if (p.applicability !== 'scored' || typeof p.score !== 'number') continue;
    if (p.score < PRINCIPLE_FLOOR) {
      reasons.push(
        `${PRINCIPLE_DISPLAY_NAMES[p.principle]} scored ${p.score.toFixed(2)}, ` +
          `below the ${PRINCIPLE_FLOOR} floor`,
      );
    }
  }

  for (const id of applicabilityViolations(v)) {
    reasons.push(
      `${PRINCIPLE_DISPLAY_NAMES[id]} was marked not-applicable, but a detector found ` +
        `evidence for it — the assessment is incomplete`,
    );
  }

  for (const c of v.citations) {
    if (c.status === 'blocking') {
      reasons.push(`${c.instrument} ${c.article} (${c.pack})`);
    }
  }

  return { blocked: reasons.length > 0, reasons };
}
