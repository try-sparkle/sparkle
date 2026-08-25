/**
 * Regulatory check-packs — the second axis of Sparkle's humane build gate.
 *
 * WHY THIS IS DATA AND NOT CODE
 *
 * Most of what the humane principles ask has already been legislated somewhere. GDPR
 * Art. 7(3) *is* "Enable Meaningful Choices". EU AI Act Art. 50 *is* "Be Transparent and
 * Honest". The European Accessibility Act *is* "Design for Equity and Inclusion". So the
 * gate carries a regulatory axis alongside the judged one.
 *
 * Nobody at Sparkle is the authority on what the law says, and regulations change on their
 * own schedule rather than on our release schedule. A pack is therefore a JSON document:
 * authorable by a policy person, reviewable by counsel as a document, and loadable without
 * shipping a build. The HumaneBench project and community are expected to define and
 * maintain the real ones; `humanePackData/` holds starting points meant to be replaced.
 *
 * THE TWO AXES ARE DIFFERENT KINDS OF CLAIM AND ARE NEVER CONFLATED
 *
 * A humane finding is arguable and scored on a four-point ordinal. A regulatory finding is
 * a citation naming an article. You cannot average a law onto an ordinal, so citations are
 * a separate output type (`ComplianceCitation`) and NEVER enter `humaneScore`. The bridge
 * between the axes runs the other way: every check names the humane principles the article
 * codifies, which is what makes these packs belong to HumaneBench rather than to a generic
 * compliance tool.
 *
 * THIS SYSTEM NEVER ASSERTS COMPLIANCE
 *
 * `reviewRequired` is the literal `true` on every emitted citation, and validation REJECTS
 * a pack that omits or falsifies it. A green run means no check fired — not that a product
 * is lawful. Every citation is phrased "this change appears to touch X, which requires Y;
 * have counsel review", never "you are compliant" or "you are non-compliant". A
 * confidently-wrong compliance tool is worse than none, because people stop reading it.
 *
 * A pack is REMOTE-AUTHORED DATA. It is untrusted input and is validated field by field.
 */

import { DETECTOR_IDS } from './humaneDetectors';
import {
  PRINCIPLE_IDS,
  type CitationStatus,
  type ComplianceCitation,
  type PrincipleId,
} from './humaneTypes';

/** How a check decides it fired. */
export type PackDetect =
  /**
   * Fires when a deterministic detector of this id fired. The id is validated against
   * `DETECTOR_IDS` at parse time — see `validateDetect`.
   */
  | { kind: 'detector'; detectorId: string }
  /** Fires when the ensemble answers yes. This module surfaces the question; it calls no model. */
  | { kind: 'judged'; question: string };

export const DETECT_KINDS = ['detector', 'judged'] as const;
export const CITATION_STATUSES = ['blocking', 'review', 'advisory'] as const;

export interface PackCheck {
  id: string;
  /** e.g. 'Art. 7(3)'. */
  article: string;
  title: string;
  /** Which humane principles this article codifies. The bridge to the judged axis. */
  principles: readonly PrincipleId[];
  /** ISO `YYYY-MM-DD`. Before it, an emitted citation is forced to 'advisory'. */
  effectiveFrom: string;
  detect: PackDetect;
  /** The status this check emits once in force. */
  onFire: CitationStatus;
  /** Plain-language, non-authoritative paraphrase of what the article requires. */
  guidance: string;
  /** Optional restatement of the pack-level affirmation. If present it must be `true`. */
  reviewRequired?: true;
}

export interface Pack {
  pack: string;
  /** Pack authors version their own data, e.g. '2026.08.1'. Named in every citation trail. */
  version: string;
  maintainer: string;
  jurisdiction: readonly string[];
  /** e.g. 'Regulation (EU) 2016/679'. */
  instrument: string;
  /** The URL that GOVERNS. Guidance text is paraphrase; this is the authority. */
  source: string;
  /** The pack's own non-authoritative-paraphrase notice, surfaced to readers. */
  notice?: string;
  /** Must be the literal `true`. A pack may never declare findings that skip legal review. */
  reviewRequired: true;
  checks: readonly PackCheck[];
}

export type ParseResult = { ok: true; pack: Pack } | { ok: false; errors: string[] };

export interface LoadOptions {
  /**
   * Jurisdictions the project declares it operates in. When given, packs that overlap none
   * of them are dropped. Matching is trimmed and case-insensitive. OMIT for no filtering.
   *
   * Two shapes are REFUSED rather than quietly applied, and both are reported through
   * `LoadResult.errors` with `scope.usable: false` — see `jurisdictionScopeProblem`:
   * a list that names NOTHING, and a list that names something NO loaded pack covers.
   */
  jurisdictions?: readonly string[];
  /** Labels each raw in error messages, e.g. a filename. Defaults to `pack[i]`. */
  label?: (index: number) => string;
}

/** Why a jurisdiction filter left the regulatory axis with nothing to look at. */
export type ScopeRefusal =
  /** `jurisdictions` was given but names no jurisdiction — `[]`, or all-blank entries. */
  | 'empty-scope'
  /** `jurisdictions` names something real that no loaded pack covers. */
  | 'no-matching-pack';

/** One loaded pack reduced to the two fields a scope message has to be able to name. */
export interface PackScope {
  pack: string;
  jurisdiction: readonly string[];
}

/** The filter applied, and left at least one pack to look at. */
export interface LoadedScope {
  usable: true;
  /** What the caller declared, or `undefined` when no filter was applied. */
  jurisdictions?: readonly string[];
  /** Ids of the packs that survived the filter — the packs that were actually LOOKED AT. */
  matched: readonly string[];
}

/** The filter left nothing to look at, so no pack list is offered at all. */
export interface UnusableScope {
  usable: false;
  reason: ScopeRefusal;
  /** Exactly what the caller declared, blanks and all. */
  jurisdictions: readonly string[];
  /** Every pack that parsed, whatever its jurisdiction — what the caller could have named. */
  available: readonly PackScope[];
  /** The actionable sentence. Also present in `errors`. */
  message: string;
}

/** A load that put at least one pack in scope. */
export interface PacksInScope {
  scope: LoadedScope;
  packs: Pack[];
  errors: string[];
}

/**
 * A load that put NO pack in scope — and therefore carries NO `packs` field at all.
 *
 * The absence is load-bearing, not tidiness. `result.packs` on an un-narrowed `LoadResult`
 * does not compile, so a caller cannot reach an empty pack list without first having read
 * `scope.usable` and decided what "we never looked" means for its gate. "Zero citations
 * because we looked and found nothing" and "zero citations because we never looked" are the
 * two outcomes this whole axis exists to keep apart, and a `packs: []` that BOTH shapes
 * share is exactly how they got confused: a gate that reports a clean pass because it looked
 * at nothing is worse than no gate at all.
 */
export interface NoPacksInScope {
  scope: UnusableScope;
  errors: string[];
}

export type LoadResult = PacksInScope | NoPacksInScope;

/** Narrows a `LoadResult` onto the arm that actually has packs. */
export function scopeUsable(result: LoadResult): result is PacksInScope {
  return result.scope.usable;
}

/** A judged check's answer. The object form lets a judge attach a one-line rationale. */
export type JudgedAnswer = boolean | { fired: boolean; note?: string };

export interface PackInput {
  /** Ids of deterministic detectors that fired on this change. */
  firedDetectorIds?: readonly string[];
  /**
   * Ensemble answers to judged checks, keyed by PACK-QUALIFIED check id — build the key
   * with `judgedAnswerKey`, or read it off `pendingJudgedQuestions().key`. A bare check id
   * answers nothing; see `judgedAnswerKey` for why.
   */
  judgedAnswers?: Readonly<Record<string, JudgedAnswer>>;
  /**
   * Jurisdictions the project operates in. Authoritative filter — a pack for a
   * jurisdiction not selected emits nothing. OMIT to disable filtering; an empty (or
   * all-blank) list throws `EmptyJurisdictionScopeError` rather than reading as a pass.
   *
   * WHAT THIS DOES NOT CATCH, because the return type has nowhere to report it: a
   * NON-EMPTY list that no supplied pack covers (`['US']` against EU-only packs) filters
   * every pack away and returns `[]`, indistinguishable from "no check fired". A caller
   * that loads UNFILTERED and scopes here must ask `jurisdictionScopeProblem` before
   * treating an empty citation list as a pass. A caller that scopes at LOAD time gets this
   * for free — `loadPacks` refuses both shapes through `LoadResult.errors`.
   */
  jurisdictions?: readonly string[];
}

/** A judged question awaiting an ensemble answer, surfaced by `pendingJudgedQuestions`. */
export interface JudgedQuestion {
  /**
   * The key this question's answer must be filed under in `PackInput.judgedAnswers`. What
   * the ensemble is ASKED under is what it ANSWERS under; nothing else has to agree.
   */
  key: string;
  checkId: string;
  pack: string;
  instrument: string;
  article: string;
  question: string;
  principles: readonly PrincipleId[];
}

/**
 * The key a judged check's answer is filed under: the check id QUALIFIED BY ITS PACK.
 *
 * Check-id uniqueness is enforced within a pack and pack-id uniqueness across packs, so the
 * pair is unique while a bare check id is NOT. Two packs carrying the same check id is not a
 * corner case — it is the anticipated one, a community pack extending a starter pack, where
 * the natural id for "GDPR Art. 7(3)" is the same on both sides. Keyed by check id alone
 * those collapse onto one answer slot and misfire in BOTH directions: a "yes" judged for
 * pack A silently fires pack B's check, emitting a blocking citation for an article no judge
 * was ever asked about, and the reverse ordering silently suppresses a real finding.
 *
 * Qualifying is preferred over rejecting a colliding id because rejection would break the
 * extension case this feature is for, and because the pack id already namespaces everything
 * else a citation carries. The separator is `/`, matching how a citation already reads
 * (`pack/check`); it is not parsed back apart anywhere, so a `/` inside either half is
 * harmless.
 */
export function judgedAnswerKey(packId: string, checkId: string): string {
  return `${packId}/${checkId}`;
}

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const PRINCIPLE_SET: ReadonlySet<string> = new Set(PRINCIPLE_IDS);

/**
 * The detectors that actually exist, read from the detector module itself rather than
 * restated here. Restating it is how the two lists drift apart in the first place.
 */
const DETECTOR_ID_SET: ReadonlySet<string> = new Set(DETECTOR_IDS);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Parses `YYYY-MM-DD` as UTC midnight. Returns null for anything that is not a real
 * calendar date — '2026-02-30' round-trips to March 2nd, so the round-trip is the test.
 */
export function parseIsoDate(value: string): number | null {
  if (!ISO_DATE.test(value)) return null;
  const [y, m, d] = value.split('-').map((part) => Number(part));
  if (y === undefined || m === undefined || d === undefined) return null;
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

function normalizeJurisdiction(value: string): string {
  return value.trim().toLowerCase();
}

/** True when the list names at least one usable (non-blank) jurisdiction. */
function namesAnyJurisdiction(jurisdictions: readonly string[]): boolean {
  return jurisdictions.some((j) => normalizeJurisdiction(j).length > 0);
}

function declaredSet(jurisdictions: readonly string[]): ReadonlySet<string> {
  return new Set(jurisdictions.map(normalizeJurisdiction));
}

/** The matching half of the filter, with no assertion in it, so a REPORTING caller can reuse it. */
function packMatches(pack: Pack, declared: ReadonlySet<string>): boolean {
  return pack.jurisdiction.some((j) => declared.has(normalizeJurisdiction(j)));
}

function packScope(pack: Pack): PackScope {
  return { pack: pack.pack, jurisdiction: pack.jurisdiction };
}

/** Names what the caller could have declared a jurisdiction for. */
function describeAvailable(available: readonly PackScope[]): string {
  if (available.length === 0) return 'no pack was loaded at all';
  return available.map((p) => `${p.pack} [${p.jurisdiction.join(', ')}]`).join('; ');
}

function emptyScopeMessage(
  jurisdictions: readonly string[],
  where: string,
  available: readonly PackScope[] | undefined,
): string {
  return (
    `${where}: jurisdictions was given but names no jurisdiction ` +
    `(${JSON.stringify(jurisdictions)}), which would silently disable the entire ` +
    `regulatory axis — every pack falls out of scope, nothing is cited, and the run reads ` +
    `as a clean pass it never earned. ` +
    (available === undefined ? '' : `Packs available: ${describeAvailable(available)}. `) +
    `OMIT jurisdictions entirely to apply every pack, or name at least one jurisdiction.`
  );
}

function noMatchingPackMessage(
  jurisdictions: readonly string[],
  where: string,
  available: readonly PackScope[],
): string {
  return (
    `${where}: jurisdictions ${JSON.stringify(jurisdictions)} match none of the packs ` +
    `loaded, so the entire regulatory axis looked at NOTHING — no citation can be emitted, ` +
    `and "no citations" here means "nothing was checked", not "everything is fine". ` +
    `Packs available: ${describeAvailable(available)}. ` +
    `Ship a pack covering ${JSON.stringify(jurisdictions)}, name at least one jurisdiction a ` +
    `loaded pack already covers, or OMIT jurisdictions entirely to apply every pack.`
  );
}

/**
 * The problem a jurisdiction filter has against a set of packs, or `null` when the filter is
 * usable. The one place both refusals are decided.
 *
 * THE TWO REFUSALS ARE ONE FAILURE WEARING TWO FACES, AND ONLY ONE WAS EVER GUARDED. `[]`
 * names nothing. `['US']` against a bundle shipping only `eu-gdpr`, `eu-ai-act` and
 * `eu-accessibility-act` names something perfectly real that nothing covers. Either way every
 * pack falls out of scope, zero citations are emitted, and the result is byte-identical to
 * "every check passed" — so the second shape walked straight through a guard built for the
 * first. A compliance gate that reports a clean pass because it looked at nothing is worse
 * than no gate at all, which is the whole reason this axis exists.
 *
 * Exported because `evaluatePacks` filters again and is authoritative for a caller that
 * loaded UNFILTERED and scopes at evaluation time: that caller holds no `LoadResult` to read,
 * and must ask this before treating an empty citation list as a pass.
 */
export function jurisdictionScopeProblem(
  jurisdictions: readonly string[] | undefined,
  packs: readonly Pack[],
  where: string,
): { reason: ScopeRefusal; message: string } | null {
  if (jurisdictions === undefined) return null;
  const available = packs.map(packScope);
  if (!namesAnyJurisdiction(jurisdictions)) {
    return { reason: 'empty-scope', message: emptyScopeMessage(jurisdictions, where, available) };
  }
  const declared = declaredSet(jurisdictions);
  if (packs.some((p) => packMatches(p, declared))) return null;
  return {
    reason: 'no-matching-pack',
    message: noMatchingPackMessage(jurisdictions, where, available),
  };
}

/**
 * Thrown when a caller declares a jurisdiction list that names nothing.
 *
 * `undefined` means "no filter, every pack applies" and `[]` means "nothing applies" — two
 * adjacent states at OPPOSITE extremes, one keystroke apart. Read as a filter, `[]` drops
 * every pack, emits no citation, and the run goes green with no error and no warning:
 * indistinguishable from "no check fired". That is silence laundered into approval, which
 * is the failure this whole axis exists to prevent.
 *
 * STILL THROWN, AND STILL EXPORTED, BY THE THREE ENTRY POINTS THAT HAVE NO ERROR CHANNEL.
 * `packInScope`, `pendingJudgedQuestions` and `evaluatePacks` each return a bare value with
 * nowhere to put a report, so for them a throw is the only way the caller cannot ignore it.
 * `loadPacks` is the one that DOES have a channel — `LoadResult.errors`, which its own doc
 * comment promised all along — so it reports there instead, and reaches the second, wider
 * refusal (`no-matching-pack`) that a throw at this seam could never see, because this
 * function is handed a jurisdiction list and never the packs to compare it against.
 */
export class EmptyJurisdictionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyJurisdictionScopeError';
  }
}

/**
 * Fails loudly on a jurisdiction list that names nothing usable. A list of only blank
 * entries is the same silence one step earlier — a config path that parsed nothing, or a
 * `.filter()` that removed everything — so it is refused on the same terms.
 *
 * A caller that means "every pack applies" omits `jurisdictions` entirely. This sees only
 * the list, never the packs, so it cannot answer the `no-matching-pack` half — that needs
 * `jurisdictionScopeProblem`.
 */
export function assertJurisdictionScope(
  jurisdictions: readonly string[] | undefined,
  where: string,
): void {
  if (jurisdictions === undefined) return;
  if (namesAnyJurisdiction(jurisdictions)) return;
  throw new EmptyJurisdictionScopeError(emptyScopeMessage(jurisdictions, where, undefined));
}

/**
 * True when the pack covers at least one jurisdiction the project declares.
 *
 * Throws `EmptyJurisdictionScopeError` on a list that names nothing — every public entry
 * point filters through here, so no path can bypass the check by reaching this directly.
 */
export function packInScope(pack: Pack, jurisdictions: readonly string[] | undefined): boolean {
  assertJurisdictionScope(jurisdictions, 'packInScope');
  if (jurisdictions === undefined) return true;
  return packMatches(pack, declaredSet(jurisdictions));
}

/**
 * A detector check binds to a detector by ID STRING, so a rename on the detector side
 * leaves the pack pointing at nothing — and a check that can never fire is SILENT, not
 * loud: no error, no citation, a green run that means "we never looked". Every shipped
 * detector-backed check was in exactly that state, which is why an unknown id is a
 * REJECTION rather than a warning. `checkId` is threaded in so the message names the check
 * a pack author has to open, not just its array index.
 */
function validateDetect(
  raw: unknown,
  where: string,
  checkId: string | undefined,
  errors: string[],
): PackDetect | null {
  if (!isRecord(raw)) {
    errors.push(`${where}.detect: must be an object with a "kind" of ${DETECT_KINDS.join(' or ')}`);
    return null;
  }
  const kind = raw['kind'];
  if (kind === 'detector') {
    if (!nonEmptyString(raw['detectorId'])) {
      errors.push(`${where}.detect.detectorId: required non-empty string when kind is "detector"`);
      return null;
    }
    const detectorId = raw['detectorId'];
    if (!DETECTOR_ID_SET.has(detectorId)) {
      errors.push(
        `${where}.detect.detectorId: check ${JSON.stringify(checkId ?? '<unnamed check>')} names ` +
          `unknown detector ${JSON.stringify(detectorId)} — no such detector is registered, so ` +
          `this check could never fire. Expected one of ${DETECTOR_IDS.join(', ')}. ` +
          `A check with no deterministic detector belongs on detect.kind "judged".`,
      );
      return null;
    }
    return { kind: 'detector', detectorId };
  }
  if (kind === 'judged') {
    if (!nonEmptyString(raw['question'])) {
      errors.push(`${where}.detect.question: required non-empty string when kind is "judged"`);
      return null;
    }
    return { kind: 'judged', question: raw['question'] };
  }
  errors.push(
    `${where}.detect.kind: unknown detect kind ${JSON.stringify(kind)} — expected one of ` +
      DETECT_KINDS.map((k) => `"${k}"`).join(', '),
  );
  return null;
}

function validateCheck(raw: unknown, where: string, errors: string[]): PackCheck | null {
  if (!isRecord(raw)) {
    errors.push(`${where}: must be an object`);
    return null;
  }

  const before = errors.length;

  for (const field of ['id', 'article', 'title', 'guidance'] as const) {
    if (!nonEmptyString(raw[field])) {
      errors.push(`${where}.${field}: required non-empty string`);
    }
  }

  const rawPrinciples = raw['principles'];
  const principles: PrincipleId[] = [];
  if (!Array.isArray(rawPrinciples) || rawPrinciples.length === 0) {
    errors.push(`${where}.principles: required non-empty array of principle ids`);
  } else {
    rawPrinciples.forEach((p, i) => {
      if (typeof p !== 'string' || !PRINCIPLE_SET.has(p)) {
        errors.push(
          `${where}.principles[${i}]: unknown principle id ${JSON.stringify(p)} — ` +
            `expected one of ${PRINCIPLE_IDS.join(', ')}`,
        );
        return;
      }
      principles.push(p as PrincipleId);
    });
  }

  const effectiveFrom = raw['effectiveFrom'];
  if (typeof effectiveFrom !== 'string' || parseIsoDate(effectiveFrom) === null) {
    errors.push(
      `${where}.effectiveFrom: malformed date ${JSON.stringify(effectiveFrom)} — ` +
        `expected a calendar date as YYYY-MM-DD`,
    );
  }

  const onFire = raw['onFire'];
  if (typeof onFire !== 'string' || !(CITATION_STATUSES as readonly string[]).includes(onFire)) {
    errors.push(
      `${where}.onFire: expected one of ${CITATION_STATUSES.map((s) => `"${s}"`).join(', ')}, ` +
        `got ${JSON.stringify(onFire)}`,
    );
  }

  // A check may restate the pack-level affirmation, but may never weaken it.
  if ('reviewRequired' in raw && raw['reviewRequired'] !== true) {
    errors.push(
      `${where}.reviewRequired: must be true — a check may never bypass legal review ` +
        `(got ${JSON.stringify(raw['reviewRequired'])})`,
    );
  }

  const detect = validateDetect(
    raw['detect'],
    where,
    nonEmptyString(raw['id']) ? raw['id'] : undefined,
    errors,
  );

  if (errors.length !== before || detect === null) return null;

  return {
    id: raw['id'] as string,
    article: raw['article'] as string,
    title: raw['title'] as string,
    principles,
    effectiveFrom: effectiveFrom as string,
    detect,
    onFire: onFire as CitationStatus,
    guidance: raw['guidance'] as string,
    reviewRequired: true,
  };
}

/**
 * Validates one raw pack document. Collects EVERY error rather than stopping at the first,
 * because the reader is a policy author fixing a document, not a compiler.
 */
export function parsePack(raw: unknown): ParseResult {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ['pack: must be a JSON object'] };
  }

  const name = nonEmptyString(raw['pack']) ? raw['pack'] : '<unnamed pack>';
  const at = (field: string) => `${name}.${field}`;

  for (const field of ['pack', 'version', 'maintainer', 'instrument', 'source'] as const) {
    if (!nonEmptyString(raw[field])) {
      errors.push(`${at(field)}: required non-empty string`);
    }
  }

  if (nonEmptyString(raw['source']) && !/^https?:\/\//i.test(raw['source'])) {
    errors.push(`${at('source')}: expected an http(s) URL to the governing text`);
  }

  if ('notice' in raw && !nonEmptyString(raw['notice'])) {
    errors.push(`${at('notice')}: when present, must be a non-empty string`);
  }

  const jurisdiction = raw['jurisdiction'];
  if (!Array.isArray(jurisdiction) || jurisdiction.length === 0) {
    errors.push(`${at('jurisdiction')}: required non-empty array of jurisdiction codes`);
  } else {
    jurisdiction.forEach((j, i) => {
      if (!nonEmptyString(j)) {
        errors.push(`${at(`jurisdiction[${i}]`)}: required non-empty string`);
      }
    });
  }

  // The affirmation that makes a pack safe to load from anywhere: it may cite the law, it
  // may never conclude on it. Missing is rejected as loudly as false.
  if (!('reviewRequired' in raw)) {
    errors.push(
      `${at('reviewRequired')}: required, and must be true — a pack must affirm that every ` +
        `citation it emits needs human legal review`,
    );
  } else if (raw['reviewRequired'] !== true) {
    errors.push(
      `${at('reviewRequired')}: must be true — a pack may never assert compliance or bypass ` +
        `legal review (got ${JSON.stringify(raw['reviewRequired'])})`,
    );
  }

  const rawChecks = raw['checks'];
  const checks: PackCheck[] = [];
  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    errors.push(`${at('checks')}: required non-empty array of checks`);
  } else {
    const seen = new Set<string>();
    rawChecks.forEach((c, i) => {
      const label = `${name}.checks[${i}]`;
      const check = validateCheck(c, label, errors);
      if (check === null) return;
      if (seen.has(check.id)) {
        errors.push(`${label}.id: duplicate check id ${JSON.stringify(check.id)} within pack`);
        return;
      }
      seen.add(check.id);
      checks.push(check);
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const pack: Pack = {
    pack: raw['pack'] as string,
    version: raw['version'] as string,
    maintainer: raw['maintainer'] as string,
    jurisdiction: jurisdiction as string[],
    instrument: raw['instrument'] as string,
    source: raw['source'] as string,
    reviewRequired: true,
    checks,
  };
  if (nonEmptyString(raw['notice'])) pack.notice = raw['notice'];
  return { ok: true, pack };
}

/**
 * Parses many raw pack documents. A malformed pack is REPORTED AND SKIPPED rather than
 * failing the batch — one bad document must not silence the packs that are fine.
 *
 * A JURISDICTION SCOPE THAT LEAVES NOTHING TO LOOK AT GOES DOWN THAT SAME CHANNEL. It used
 * to throw, which contradicted this very comment two lines up: the loud-but-recoverable
 * channel existed and was bypassed, so a caller written against the documented contract got
 * an unhandled throw instead. It now reports — but through a return type that will not let
 * the report be skipped. `errors` carries the sentence, `scope.usable` is `false`, and the
 * refusing arm has no `packs` field to read, so the reason "we never looked" cannot be
 * mistaken for "nothing fired". See `NoPacksInScope` and `jurisdictionScopeProblem`.
 *
 * Documents are parsed BEFORE the scope is judged, so a refused scope still reports every
 * malformed pack it found. Two things are wrong with the run, and it says so.
 *
 * The `jurisdictions` option is a pre-filter for callers that already know the project's
 * scope. `evaluatePacks` filters again and is authoritative; this only avoids carrying
 * packs that can never emit.
 */
export function loadPacks(raws: readonly unknown[], opts: LoadOptions = {}): LoadResult {
  const parsed: Pack[] = [];
  const errors: string[] = [];
  const label = opts.label ?? ((i: number) => `pack[${i}]`);
  const seen = new Map<string, number>();

  raws.forEach((raw, i) => {
    const result = parsePack(raw);
    if (!result.ok) {
      for (const e of result.errors) errors.push(`${label(i)}: ${e}`);
      return;
    }
    const previous = seen.get(result.pack.pack);
    if (previous !== undefined) {
      errors.push(
        `${label(i)}: duplicate pack id "${result.pack.pack}" — already loaded from ` +
          `${label(previous)}`,
      );
      return;
    }
    seen.set(result.pack.pack, i);
    parsed.push(result.pack);
  });

  const problem = jurisdictionScopeProblem(
    opts.jurisdictions,
    parsed,
    'loadPacks(opts.jurisdictions)',
  );
  if (problem !== null) {
    return {
      scope: {
        usable: false,
        reason: problem.reason,
        jurisdictions: [...(opts.jurisdictions ?? [])],
        available: parsed.map(packScope),
        message: problem.message,
      },
      // First, because it is the headline: whatever else this batch says, nothing was read.
      errors: [problem.message, ...errors],
    };
  }

  const declared = opts.jurisdictions === undefined ? undefined : declaredSet(opts.jurisdictions);
  const packs =
    declared === undefined ? parsed : parsed.filter((pack) => packMatches(pack, declared));

  return {
    scope: {
      usable: true,
      jurisdictions: opts.jurisdictions,
      matched: packs.map((pack) => pack.pack),
    },
    packs,
    errors,
  };
}

function judgedFired(answer: JudgedAnswer | undefined): boolean {
  if (answer === undefined) return false;
  return typeof answer === 'boolean' ? answer : answer.fired === true;
}

function judgedNote(answer: JudgedAnswer | undefined): string | undefined {
  if (answer === undefined || typeof answer === 'boolean') return undefined;
  return nonEmptyString(answer.note) ? answer.note.trim() : undefined;
}

function daysUntil(effectiveMs: number, now: Date): number {
  return Math.max(1, Math.ceil((effectiveMs - now.getTime()) / MS_PER_DAY));
}

/**
 * Every judged question in scope, for handing to the ensemble. This module NEVER calls a
 * model — it surfaces the questions and takes booleans back through `PackInput`.
 */
export function pendingJudgedQuestions(
  packs: readonly Pack[],
  jurisdictions?: readonly string[],
): JudgedQuestion[] {
  assertJurisdictionScope(jurisdictions, 'pendingJudgedQuestions(jurisdictions)');
  const out: JudgedQuestion[] = [];
  for (const pack of packs) {
    if (!packInScope(pack, jurisdictions)) continue;
    for (const check of pack.checks) {
      if (check.detect.kind !== 'judged') continue;
      out.push({
        key: judgedAnswerKey(pack.pack, check.id),
        checkId: check.id,
        pack: pack.pack,
        instrument: pack.instrument,
        article: check.article,
        question: check.detect.question,
        principles: check.principles,
      });
    }
  }
  return out;
}

/**
 * Turns fired checks into citations.
 *
 * `now` is INJECTED, never read from the clock inside this function — the whole
 * future-dated-regulation behaviour is untestable otherwise.
 *
 * Three behaviours are the point of the feature:
 *   1. `effectiveFrom` gates status. A check whose date is still in the future can never
 *      emit 'blocking'; it downgrades to 'advisory' and says how many days remain. That is
 *      how "regulations that are coming" works.
 *   2. Jurisdiction filtering. A pack for a jurisdiction the project did not declare emits
 *      nothing at all — which is why a caller scoping HERE rather than at load time must ask
 *      `jurisdictionScopeProblem` first: a jurisdiction list no supplied pack covers filters
 *      everything away and returns `[]`, and `[]` is what a clean pass looks like too.
 *   3. `reviewRequired` is always the literal `true`, and the guidance always asks for
 *      counsel rather than concluding.
 *
 * Judged answers are read under `judgedAnswerKey(pack, check)`, never under the bare check
 * id — see that function for the collision it prevents.
 */
export function evaluatePacks(
  packs: readonly Pack[],
  input: PackInput,
  now: Date,
): ComplianceCitation[] {
  assertJurisdictionScope(input.jurisdictions, 'evaluatePacks(input.jurisdictions)');
  const fired = new Set(input.firedDetectorIds ?? []);
  const answers = input.judgedAnswers ?? {};
  const citations: ComplianceCitation[] = [];

  for (const pack of packs) {
    if (!packInScope(pack, input.jurisdictions)) continue;

    for (const check of pack.checks) {
      const answer =
        check.detect.kind === 'judged'
          ? answers[judgedAnswerKey(pack.pack, check.id)]
          : undefined;
      const didFire =
        check.detect.kind === 'detector' ? fired.has(check.detect.detectorId) : judgedFired(answer);
      if (!didFire) continue;

      // Validation guarantees this parses; the fallback keeps a hand-built Pack honest.
      const effectiveMs = parseIsoDate(check.effectiveFrom) ?? Number.NEGATIVE_INFINITY;
      const inForce = now.getTime() >= effectiveMs;
      const status: CitationStatus = inForce ? check.onFire : 'advisory';

      const parts: string[] = [
        `This change appears to touch ${pack.instrument} ${check.article} ` +
          `(${check.title}), which requires ${check.guidance.replace(/\.?$/, '.')}`,
      ];
      if (!inForce) {
        parts.push(
          `Not yet in force: ${check.effectiveFrom}, ` +
            `${daysUntil(effectiveMs, now)} day(s) away — reported as advisory until then, ` +
            `whatever the pack declares.`,
        );
      }
      const note = judgedNote(answer);
      if (note !== undefined) parts.push(`Judge note: ${note}`);
      parts.push(
        `Have counsel review. This is a pointer to a legal text, not a legal conclusion — ` +
          `Sparkle cannot judge whether this change satisfies the law, and does not claim to.`,
      );
      if (pack.notice !== undefined) parts.push(pack.notice);
      parts.push(`Pack ${pack.pack}@${pack.version} (${pack.maintainer}); source: ${pack.source}`);

      citations.push({
        checkId: check.id,
        pack: pack.pack,
        instrument: pack.instrument,
        article: check.article,
        principles: check.principles,
        jurisdiction: pack.jurisdiction,
        effectiveFrom: check.effectiveFrom,
        status,
        guidance: parts.join(' '),
        reviewRequired: true,
      });
    }
  }

  return citations;
}
