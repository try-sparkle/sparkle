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

/**
 * WHERE THE CREDENTIAL THAT ANSWERED CAME FROM. Stamped into every published verdict.
 *
 * This replaces `Lane = 'subscription' | 'openrouter'`, which was a FICTION (bead
 * `sparkle-plmpnm`): the CLI defaulted to `'openrouter'`, there has never been an OpenRouter call
 * path anywhere in this repository, and the value was rendered into the PR comment table on every
 * verdict the gate ever published. A provenance field naming a provider the code cannot reach is
 * worse than no field, because a reader trusts it.
 *
 * These are CREDENTIAL SOURCES rather than vendors, because that is the distinction a reader of a
 * verdict actually needs: which pool of capacity answered, and who to talk to when it stops.
 */
export type CredentialSource =
  /** The account rotation fleet picked a live account at call time. No stored credential. */
  | 'fleet'
  /**
   * The machine's own default Claude login answered — NOT a fleet selection.
   *
   * Kept distinct because conflating the two is how a provenance field starts lying again. The
   * fleet selector exits 0 with EMPTY stdout to mean "no specific account; use the machine
   * default", and on a CI runner that is the normal path rather than an edge case: the gate is
   * checked out from the default branch, so the fleet SCRIPT exists even where no fleet does.
   * Reporting that as `fleet` would render `Judged via: fleet` on a box with no rotation accounts
   * — the same defect as the `openrouter` fiction this type replaced.
   */
  | 'local-login'
  /** A long-lived OAuth token (`claude setup-token`), drawing on a Claude subscription. */
  | 'oauth-token'
  /** A metered API key. Supported for portability; not what this repository's own lanes use. */
  | 'api-key'
  /** Canned answers from a file. Tests only — never a real judgement. */
  | 'stub'
  /** No judge was called at all. The verdict is a could-not-evaluate, never a pass. */
  | 'none';

export const CREDENTIAL_SOURCES: readonly CredentialSource[] = [
  'fleet',
  'local-login',
  'oauth-token',
  'api-key',
  'stub',
  'none',
] as const;

/**
 * The verdict field is still named `lane`, so every existing publisher and stored verdict keeps
 * reading. Only the VALUES changed — from a provider that did not exist to the credential source
 * that actually answered.
 */
export type Lane = CredentialSource;

/**
 * WHY there is no verdict — the distinction between a bill and an outage.
 *
 * A no-verdict run used to render identically whatever killed it, and the wording it chose
 * was the endpoint's: "no model was reachable". When the real cause was an exhausted account
 * balance, that sentence sent every reader to check an endpoint that was fine, while the
 * actual remedy — a payment — was owed by someone who was never told (bead `sparkle-4xvu29`;
 * four green pull requests sat on it). The causes are kept apart because their REMEDIES are
 * different and are owed by different people: 'credit' is paid, 'auth' is re-issued,
 * 'unreachable' is waited out or escalated.
 *
 * 'request-rejected' is the fourth, and it is the one this gate died of (beads
 * `sparkle-dy8mu0`, `sparkle-fegwof`): the API answered, immediately, to say OUR REQUEST is
 * invalid — a sampling parameter the current model generation rejects with a flat 400. That
 * is neither infrastructure nor a finding about the diff; it is the gate itself being wrong,
 * and its remedy is owed by whoever maintains the gate. Keeping it inside 'unreachable' is
 * what told three separate investigations to go inspect a healthy endpoint, and what made
 * "re-run once judging is reachable" — a dead instruction, since every re-run reproduces it
 * exactly — the advice on every surface.
 *
 * 'none' means a verdict exists, so no cause applies. It is a member rather than `null` so
 * the field is always present on the wire and a reader never has to tell absent from unknown.
 */
export type NoVerdictCause = 'none' | 'credit' | 'auth' | 'request-rejected' | 'unreachable';

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
  /**
   * Why no verdict exists, or 'none' when one does. NEVER a pass and never blocking on its
   * own — it only decides which sentence the reader is given, and therefore which remedy
   * they go and perform.
   */
  noVerdictCause: NoVerdictCause;
  /**
   * The PROVIDER'S OWN sentence about the first failure — one line, redacted and bounded —
   * or null when a verdict exists.
   *
   * NEVER DISCARD THE ERROR BODY (bead `sparkle-dy8mu0`). The body was already quoted into
   * the CI log, and that was still not enough: the log is not what a reviewer reads. A
   * check-run summary saying "no model was reachable" while the API had been saying
   * "temperature: Extra inputs are not permitted" on every call is how a one-line diagnosis
   * became three investigations. This field is that sentence, carried to the surfaces a human
   * actually looks at, so the NEXT parameter incompatibility is readable rather than bisected.
   */
  noVerdictDetail: string | null;
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
 * FAILURE CONTRACT — FAIL OPEN WHEN NO MODEL WAS REACHABLE (founder decision, 2026-08-25;
 * beads `sparkle-4xvu29`, `sparkle-g6cc8q`). HumaneBench is real but half-built, and the
 * founder's explicit instruction is that a gate which cannot reach its model must NOT become a
 * repository-wide merge block: an exhausted API key, a non-2xx endpoint or a network fault is a
 * billing/infra state, not a humaneness finding about the diff. So when too few judges answered
 * (below quorum), or a quorum answered but produced nothing scoreable, this returns a NEUTRAL
 * could-not-evaluate — `blocked: false`, no reasons — which the surfaces render as a
 * non-blocking `neutral` check rather than a red one. It is NOT laundered into a pass: no verdict
 * exists, and the PR comment / check summary say exactly that.
 *
 * This deliberately REVERSES the earlier fail-closed contract (2026-07-28), by the founder's
 * decision above. What still blocks is a GENUINE verdict from a REACHABLE, scoring model: an
 * aggregate below the bar, a single principle below the floor, a not-applicable dismissal that a
 * deterministic detector refutes, or a blocking regulatory citation.
 */
export function verdictBlocks(v: HumaneVerdict): BlockDecision {
  const reasons: string[] = [];

  // A change that touches no human-affecting surface is not evaluated, and passes.
  // This is the structural scope gate, and it is what keeps the instrument alive: a gate
  // that scores database migrations for humaneness gets switched off within a week.
  if (!v.scored) return { blocked: false, reasons: [] };

  // NO MODEL REACHED — FAIL OPEN. Below quorum there is no judged verdict: every judge attempt
  // errored, so nothing was actually scored. That is a could-not-evaluate, and by the founder
  // decision above it must NOT block or red the pull request. Step aside as a neutral; a
  // reachable model returning a real low score still blocks below.
  if (v.judgesAnswered < MIN_JUDGE_QUORUM) {
    return { blocked: false, reasons: [] };
  }

  const aggregate = v.humaneScore;
  // A null aggregate WITH quorum means the reachable judges produced nothing scoreable — another
  // could-not-evaluate, not a violation, so it no longer blocks on its own. The per-principle
  // floor and the applicability cross-check below still fire on anything the judges or the
  // deterministic detectors actually did find.
  if (aggregate !== null && Number.isFinite(aggregate) && aggregate < AGGREGATE_THRESHOLD) {
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
