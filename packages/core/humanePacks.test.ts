import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DETECTOR_IDS } from './humaneDetectors';
import { bundledPackFiles, loadBundledPacks } from './humanePackData/loadBundled';
import {
  EmptyJurisdictionScopeError,
  evaluatePacks,
  judgedAnswerKey,
  jurisdictionScopeProblem,
  loadPacks,
  packInScope,
  parseIsoDate,
  parsePack,
  pendingJudgedQuestions,
  scopeUsable,
  type LoadResult,
  type Pack,
  type PacksInScope,
  type UnusableScope,
} from './humanePacks';
import {
  aggregateScore,
  PRINCIPLE_IDS,
  type ComplianceCitation,
  type HumaneVerdict,
  type PrincipleAssessment,
  type PrincipleId,
} from './humaneTypes';

/**
 * A raw pack document, as a policy author would write it. Deep-cloned per test so a
 * mutation in one case cannot leak into the next.
 */
function rawPack(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      pack: 'test-pack',
      version: '2026.08.1',
      maintainer: 'buildinghumanetech',
      jurisdiction: ['EU', 'EEA'],
      instrument: 'Regulation (EU) 2016/679',
      source: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
      notice: 'Paraphrase only; the source URL governs.',
      reviewRequired: true,
      checks: [
        {
          id: 'check-detector',
          article: 'Art. 7(3)',
          title: 'Withdrawing consent must be as easy as giving it',
          principles: ['enable-meaningful-choices'],
          effectiveFrom: '2018-05-25',
          detect: { kind: 'detector', detectorId: 'consent-withdrawal-asymmetry' },
          onFire: 'blocking',
          guidance: 'that withdrawal be as easy as consent',
          reviewRequired: true,
        },
      ],
    }),
  ) as Record<string, unknown>;
}

function firstCheck(raw: Record<string, unknown>): Record<string, unknown> {
  return (raw['checks'] as Record<string, unknown>[])[0] as Record<string, unknown>;
}

/** Parses a document that MUST be valid; fails loudly rather than returning undefined. */
function mustParse(raw: unknown): Pack {
  const result = parsePack(raw);
  if (!result.ok) throw new Error(`expected a valid pack, got errors: ${result.errors.join('; ')}`);
  return result.pack;
}

/** The errors of a document that MUST be rejected. */
function mustReject(raw: unknown): string[] {
  const result = parsePack(raw);
  if (result.ok) throw new Error('expected the pack to be REJECTED, but it parsed');
  return result.errors;
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

/** The arm of a `LoadResult` that has packs; fails loudly naming the refusal otherwise. */
function mustLoad(result: LoadResult): PacksInScope {
  if (!scopeUsable(result)) {
    throw new Error(`expected packs in scope, got ${result.scope.reason}: ${result.scope.message}`);
  }
  return result;
}

/** The scope of a `LoadResult` that MUST have refused; fails loudly if it loaded anything. */
function mustRefuse(result: LoadResult): UnusableScope {
  if (scopeUsable(result)) {
    throw new Error(
      `expected a scope refusal, but the load put [${result.scope.matched.join(', ')}] in scope`,
    );
  }
  return result.scope;
}

const IN_SCOPE = ['EU'];
const NOW = new Date('2026-08-22T00:00:00Z');
const FIRED = { firedDetectorIds: ['consent-withdrawal-asymmetry'], jurisdictions: IN_SCOPE };

describe('parsePack — a pack is remote-authored, untrusted data', () => {
  it('accepts a well-formed document and keeps the author fields', () => {
    const pack = mustParse(rawPack());
    expect(pack.pack).toBe('test-pack');
    expect(pack.version).toBe('2026.08.1');
    expect(pack.instrument).toBe('Regulation (EU) 2016/679');
    expect(pack.checks).toHaveLength(1);
    expect(only(pack.checks).detect).toEqual({
      kind: 'detector',
      detectorId: 'consent-withdrawal-asymmetry',
    });
  });

  it('ignores unknown keys, so a pack may carry its own header comment', () => {
    const raw = rawPack();
    raw['_readme'] = ['STARTER PACK — replace me'];
    expect(mustParse(raw).pack).toBe('test-pack');
  });

  it('rejects a document that is not an object', () => {
    expect(mustReject('eu-gdpr').join(' ')).toMatch(/must be a JSON object/);
    expect(mustReject(null).join(' ')).toMatch(/must be a JSON object/);
    expect(mustReject([rawPack()]).join(' ')).toMatch(/must be a JSON object/);
  });

  it('reports EVERY error at once, not just the first', () => {
    const raw = rawPack();
    delete raw['instrument'];
    delete raw['version'];
    firstCheck(raw)['guidance'] = '';
    const errors = mustReject(raw);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.join('\n')).toMatch(/instrument/);
    expect(errors.join('\n')).toMatch(/version/);
    expect(errors.join('\n')).toMatch(/guidance/);
  });
});

describe('parsePack — each rejection names the offending field', () => {
  it('rejects an unknown principle id', () => {
    const raw = rawPack();
    firstCheck(raw)['principles'] = ['enable-meaningful-choices', 'be-excellent-to-each-other'];
    const error = only(mustReject(raw).filter((e) => e.includes('principles[1]')));
    expect(error).toContain('unknown principle id');
    expect(error).toContain('be-excellent-to-each-other');
  });

  it('rejects an empty principles list — every check must bridge to the humane axis', () => {
    const raw = rawPack();
    firstCheck(raw)['principles'] = [];
    expect(only(mustReject(raw)).replace('test-pack.checks[0].', '')).toMatch(/^principles:/);
  });

  it('rejects a malformed date, naming effectiveFrom', () => {
    const raw = rawPack();
    firstCheck(raw)['effectiveFrom'] = '25 May 2018';
    const error = only(mustReject(raw));
    expect(error).toContain('checks[0].effectiveFrom');
    expect(error).toContain('YYYY-MM-DD');
  });

  it('rejects a date that is well-formed but not a real calendar day', () => {
    const raw = rawPack();
    firstCheck(raw)['effectiveFrom'] = '2026-02-30';
    expect(only(mustReject(raw))).toContain('checks[0].effectiveFrom');
  });

  it('rejects an unknown detect.kind', () => {
    const raw = rawPack();
    firstCheck(raw)['detect'] = { kind: 'regex', pattern: '.*' };
    const error = only(mustReject(raw));
    expect(error).toContain('checks[0].detect.kind');
    expect(error).toContain('unknown detect kind');
  });

  it('rejects a detector check with no detectorId', () => {
    const raw = rawPack();
    firstCheck(raw)['detect'] = { kind: 'detector' };
    expect(only(mustReject(raw))).toContain('checks[0].detect.detectorId');
  });

  it('rejects a judged check with no question', () => {
    const raw = rawPack();
    firstCheck(raw)['detect'] = { kind: 'judged', question: '   ' };
    expect(only(mustReject(raw))).toContain('checks[0].detect.question');
  });

  it('rejects a missing article', () => {
    const raw = rawPack();
    delete firstCheck(raw)['article'];
    expect(only(mustReject(raw))).toContain('checks[0].article');
  });

  it('rejects a missing instrument', () => {
    const raw = rawPack();
    delete raw['instrument'];
    expect(only(mustReject(raw))).toContain('test-pack.instrument');
  });

  it('rejects a missing guidance', () => {
    const raw = rawPack();
    delete firstCheck(raw)['guidance'];
    expect(only(mustReject(raw))).toContain('checks[0].guidance');
  });

  it('rejects an unknown onFire status', () => {
    const raw = rawPack();
    firstCheck(raw)['onFire'] = 'fatal';
    const error = only(mustReject(raw));
    expect(error).toContain('checks[0].onFire');
    expect(error).toContain('"blocking"');
  });

  it('rejects a source that is not an http(s) URL', () => {
    const raw = rawPack();
    raw['source'] = 'ask my lawyer';
    expect(only(mustReject(raw))).toContain('test-pack.source');
  });

  it('rejects an empty jurisdiction list', () => {
    const raw = rawPack();
    raw['jurisdiction'] = [];
    expect(only(mustReject(raw))).toContain('test-pack.jurisdiction');
  });

  it('rejects a pack with no checks', () => {
    const raw = rawPack();
    raw['checks'] = [];
    expect(only(mustReject(raw))).toContain('test-pack.checks');
  });

  it('rejects a duplicate check id within one pack', () => {
    const raw = rawPack();
    const checks = raw['checks'] as unknown[];
    checks.push(JSON.parse(JSON.stringify(checks[0])));
    expect(only(mustReject(raw))).toContain('duplicate check id');
  });
});

describe('a detector-backed check must name a detector that actually exists', () => {
  // THE REGRESSION: every detector-backed check in the shipped packs once named an id the
  // detector module never emits, so those checks were permanently inert and SILENT. A
  // rename is a one-word edit; without this guard nothing anywhere fails when it happens.
  it('rejects a check naming a detector the module does not emit, naming BOTH ids', () => {
    const raw = rawPack();
    firstCheck(raw)['detect'] = { kind: 'detector', detectorId: 'keyboard-inoperable-control' };
    const error = only(mustReject(raw));
    expect(error).toContain('checks[0].detect.detectorId');
    expect(error).toContain('check-detector');
    expect(error).toContain('keyboard-inoperable-control');
  });

  // PAIRED with the rejection above: the same shape, an id that IS registered.
  it('accepts every id the detector module really emits', () => {
    expect(DETECTOR_IDS.length).toBeGreaterThan(0);
    for (const id of DETECTOR_IDS) {
      const raw = rawPack();
      firstCheck(raw)['detect'] = { kind: 'detector', detectorId: id };
      expect(only(mustParse(raw).checks).detect).toEqual({ kind: 'detector', detectorId: id });
    }
  });

  it('lists the ids that would have worked, so a pack author can fix it', () => {
    const raw = rawPack();
    firstCheck(raw)['detect'] = { kind: 'detector', detectorId: 'no-such-detector' };
    const error = only(mustReject(raw));
    for (const id of DETECTOR_IDS) expect(error).toContain(id);
  });

  it('loadPacks drops the pack and reports it, rather than loading a silent hole', () => {
    const raw = rawPack();
    firstCheck(raw)['detect'] = { kind: 'detector', detectorId: 'no-such-detector' };
    const { packs, errors } = mustLoad(loadPacks([raw]));
    expect(packs).toEqual([]);
    expect(only(errors)).toContain('no-such-detector');
  });

  it('says nothing about detector ids for a JUDGED check', () => {
    const raw = rawPack();
    firstCheck(raw)['detect'] = { kind: 'judged', question: 'Is consent bundled?' };
    expect(mustParse(raw)).toBeTruthy();
  });
});

describe('reviewRequired — a pack may NEVER bypass legal review', () => {
  it('rejects a pack that sets reviewRequired: false', () => {
    const raw = rawPack();
    raw['reviewRequired'] = false;
    const error = only(mustReject(raw));
    expect(error).toContain('test-pack.reviewRequired');
    expect(error).toContain('must be true');
  });

  it('rejects a pack that omits reviewRequired entirely', () => {
    const raw = rawPack();
    delete raw['reviewRequired'];
    const error = only(mustReject(raw));
    expect(error).toContain('test-pack.reviewRequired');
    expect(error).toContain('required');
  });

  it('rejects a CHECK that sets reviewRequired: false, even in an affirming pack', () => {
    const raw = rawPack();
    firstCheck(raw)['reviewRequired'] = false;
    const error = only(mustReject(raw));
    expect(error).toContain('checks[0].reviewRequired');
    expect(error).toContain('must be true');
  });

  it('emits reviewRequired: true on every citation', () => {
    const pack = mustParse(rawPack());
    const citation = only(evaluatePacks([pack], FIRED, new Date('2026-08-22T00:00:00Z')));
    expect(citation.reviewRequired).toBe(true);
  });

  it('asks for counsel and never asserts compliance either way', () => {
    const pack = mustParse(rawPack());
    const citation = only(evaluatePacks([pack], FIRED, new Date('2026-08-22T00:00:00Z')));
    expect(citation.guidance).toMatch(/appears to touch/i);
    expect(citation.guidance).toMatch(/have counsel review/i);
    expect(citation.guidance).toMatch(/not a legal conclusion/i);
    // Neither "compliant" nor "non-compliant" — the word is a conclusion in both directions.
    expect(citation.guidance).not.toMatch(/compliant/i);
    expect(citation.guidance).toContain('https://eur-lex.europa.eu/eli/reg/2016/679/oj');
  });
});

describe('evaluatePacks — detection', () => {
  it('emits when the named detector fired', () => {
    const pack = mustParse(rawPack());
    const citation = only(evaluatePacks([pack], FIRED, new Date('2026-08-22T00:00:00Z')));
    expect(citation.checkId).toBe('check-detector');
    expect(citation.article).toBe('Art. 7(3)');
    expect(citation.instrument).toBe('Regulation (EU) 2016/679');
    expect(citation.pack).toBe('test-pack');
    expect(citation.principles).toEqual(['enable-meaningful-choices']);
  });

  it('emits NOTHING when a different detector fired', () => {
    const pack = mustParse(rawPack());
    const citations = evaluatePacks(
      [pack],
      { firedDetectorIds: ['some-other-detector'], jurisdictions: IN_SCOPE },
      new Date('2026-08-22T00:00:00Z'),
    );
    expect(citations).toEqual([]);
  });

  it('emits a judged check only when the ensemble answered yes', () => {
    const raw = rawPack();
    firstCheck(raw)['detect'] = { kind: 'judged', question: 'Is consent bundled?' };
    const pack = mustParse(raw);
    const now = new Date('2026-08-22T00:00:00Z');

    expect(evaluatePacks([pack], { jurisdictions: IN_SCOPE }, now)).toEqual([]);
    expect(
      evaluatePacks(
        [pack],
        { judgedAnswers: { 'test-pack/check-detector': false }, jurisdictions: IN_SCOPE },
        now,
      ),
    ).toEqual([]);
    expect(
      only(
        evaluatePacks(
          [pack],
          { judgedAnswers: { 'test-pack/check-detector': true }, jurisdictions: IN_SCOPE },
          now,
        ),
      ).checkId,
    ).toBe('check-detector');
  });

  it('accepts the verdict-object answer form and carries its note into the guidance', () => {
    const raw = rawPack();
    firstCheck(raw)['detect'] = { kind: 'judged', question: 'Is consent bundled?' };
    const pack = mustParse(raw);
    const now = new Date('2026-08-22T00:00:00Z');

    expect(
      evaluatePacks(
        [pack],
        {
          judgedAnswers: { 'test-pack/check-detector': { fired: false, note: 'looks fine' } },
          jurisdictions: IN_SCOPE,
        },
        now,
      ),
    ).toEqual([]);

    const citation = only(
      evaluatePacks(
        [pack],
        {
          judgedAnswers: {
            'test-pack/check-detector': { fired: true, note: 'the opt-out is three menus deep' },
          },
          jurisdictions: IN_SCOPE,
        },
        now,
      ),
    );
    expect(citation.guidance).toContain('Judge note: the opt-out is three menus deep');
  });

  it('never treats a detector id as an answer to a judged check', () => {
    const raw = rawPack();
    firstCheck(raw)['detect'] = { kind: 'judged', question: 'Is consent bundled?' };
    const pack = mustParse(raw);
    // The detector of the same name fired, but this check is judged and unanswered.
    expect(evaluatePacks([pack], FIRED, new Date('2026-08-22T00:00:00Z'))).toEqual([]);
  });
});

describe('effectiveFrom gates status — the future-dated path', () => {
  const future = '2027-08-02';

  function futureRaw(): Record<string, unknown> {
    const raw = rawPack();
    firstCheck(raw)['effectiveFrom'] = future;
    return raw;
  }

  // PAIRED: the SAME check, the SAME declared onFire, only `now` differs.
  it('downgrades to advisory when now is BEFORE effectiveFrom', () => {
    const pack = mustParse(futureRaw());
    const citation = only(evaluatePacks([pack], FIRED, new Date('2027-08-01T00:00:00Z')));
    expect(citation.status).toBe('advisory');
    expect(citation.effectiveFrom).toBe(future);
  });

  it('emits the declared blocking status when now is AFTER effectiveFrom', () => {
    const pack = mustParse(futureRaw());
    const citation = only(evaluatePacks([pack], FIRED, new Date('2027-08-03T00:00:00Z')));
    expect(citation.status).toBe('blocking');
    expect(citation.effectiveFrom).toBe(future);
  });

  it('is in force ON the effective date itself, not the day after', () => {
    const pack = mustParse(futureRaw());
    expect(only(evaluatePacks([pack], FIRED, new Date('2027-08-02T00:00:00Z'))).status).toBe(
      'blocking',
    );
    expect(only(evaluatePacks([pack], FIRED, new Date('2027-08-01T23:59:59Z'))).status).toBe(
      'advisory',
    );
  });

  it('says how many days remain, and the count shrinks as now approaches', () => {
    const pack = mustParse(futureRaw());
    const far = only(evaluatePacks([pack], FIRED, new Date('2027-07-23T00:00:00Z'))).guidance;
    const near = only(evaluatePacks([pack], FIRED, new Date('2027-08-01T00:00:00Z'))).guidance;
    expect(far).toContain('10 day(s) away');
    expect(near).toContain('1 day(s) away');
    expect(far).toContain('Not yet in force');
  });

  it('says nothing about days remaining once the check is in force', () => {
    const pack = mustParse(futureRaw());
    const citation = only(evaluatePacks([pack], FIRED, new Date('2027-08-03T00:00:00Z')));
    expect(citation.guidance).not.toMatch(/Not yet in force/);
    expect(citation.guidance).not.toMatch(/day\(s\) away/);
  });

  it('downgrades a "review" check too — advisory is the floor, not a swap for blocking', () => {
    const raw = futureRaw();
    firstCheck(raw)['onFire'] = 'review';
    const pack = mustParse(raw);
    expect(only(evaluatePacks([pack], FIRED, new Date('2027-08-01T00:00:00Z'))).status).toBe(
      'advisory',
    );
    expect(only(evaluatePacks([pack], FIRED, new Date('2027-08-03T00:00:00Z'))).status).toBe(
      'review',
    );
  });

  it('reads `now` only from its argument — the same call twice is identical', () => {
    const pack = mustParse(futureRaw());
    const a = evaluatePacks([pack], FIRED, new Date('2027-08-01T00:00:00Z'));
    const b = evaluatePacks([pack], FIRED, new Date('2027-08-01T00:00:00Z'));
    expect(a).toEqual(b);
    expect(only(a).status).toBe('advisory');
  });
});

describe('jurisdiction filtering', () => {
  const now = new Date('2026-08-22T00:00:00Z');

  // PAIRED: the SAME pack, the SAME fired detector, only the declared scope differs.
  it('emits when the project operates in a jurisdiction the pack covers', () => {
    const pack = mustParse(rawPack());
    const citation = only(
      evaluatePacks(
        [pack],
        { firedDetectorIds: ['consent-withdrawal-asymmetry'], jurisdictions: ['EU', 'US-CA'] },
        now,
      ),
    );
    expect(citation.jurisdiction).toEqual(['EU', 'EEA']);
  });

  it('emits NOTHING when the pack covers no declared jurisdiction', () => {
    const pack = mustParse(rawPack());
    expect(
      evaluatePacks(
        [pack],
        { firedDetectorIds: ['consent-withdrawal-asymmetry'], jurisdictions: ['US-CA', 'BR'] },
        now,
      ),
    ).toEqual([]);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const pack = mustParse(rawPack());
    expect(
      evaluatePacks(
        [pack],
        { firedDetectorIds: ['consent-withdrawal-asymmetry'], jurisdictions: [' eu '] },
        now,
      ),
    ).toHaveLength(1);
  });

  it('applies no filter when the project declares no jurisdictions', () => {
    const pack = mustParse(rawPack());
    expect(
      evaluatePacks([pack], { firedDetectorIds: ['consent-withdrawal-asymmetry'] }, now),
    ).toHaveLength(1);
  });

  it('packInScope answers both directions', () => {
    const pack = mustParse(rawPack());
    expect(packInScope(pack, ['EEA'])).toBe(true);
    expect(packInScope(pack, ['UK'])).toBe(false);
    expect(packInScope(pack, undefined)).toBe(true);
  });
});

describe('an EMPTY jurisdictions list is a caller error, never a clean pass', () => {
  const now = new Date('2026-08-22T00:00:00Z');
  const detectors = { firedDetectorIds: ['consent-withdrawal-asymmetry'] };

  // THE POINT OF THIS BLOCK. `undefined` means "no filter, every pack applies" and `[]`
  // means "nothing applies" — two adjacent states at opposite extremes. Read as a filter,
  // `[]` returned no citations, `verdictBlocks` saw nothing, and the run went green with no
  // error and no warning: indistinguishable from "no check fired". That is silence
  // laundered into approval, which is the exact failure this axis exists to prevent.
  it('undefined and [] are DISTINGUISHABLE — one evaluates everything, the other refuses', () => {
    const pack = mustParse(rawPack());
    expect(evaluatePacks([pack], detectors, now)).toHaveLength(1);
    expect(() => evaluatePacks([pack], { ...detectors, jurisdictions: [] }, now)).toThrow(
      EmptyJurisdictionScopeError,
    );
  });

  it('the error says what to do instead, because a caller has to choose one of two things', () => {
    const pack = mustParse(rawPack());
    let message = '';
    try {
      evaluatePacks([pack], { ...detectors, jurisdictions: [] }, now);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/omit/i);
    expect(message).toMatch(/at least one/i);
    expect(message).toMatch(/regulatory/i);
  });

  it('refuses in pendingJudgedQuestions too — an unasked question is the same silence', () => {
    const raw = rawPack();
    firstCheck(raw)['detect'] = { kind: 'judged', question: 'Is consent bundled?' };
    const pack = mustParse(raw);
    expect(pendingJudgedQuestions([pack], undefined)).toHaveLength(1);
    expect(() => pendingJudgedQuestions([pack], [])).toThrow(EmptyJurisdictionScopeError);
  });

  // loadPacks is the one entry point with an error CHANNEL, and its own doc comment always
  // said bad input "is REPORTED AND SKIPPED rather than failing the batch". It threw anyway.
  // A caller written against the documented contract got an unhandled throw; this pins the
  // contract the comment describes.
  it('REPORTS in loadPacks rather than throwing, because loadPacks has somewhere to report', () => {
    expect(mustLoad(loadPacks([rawPack()])).packs).toHaveLength(1);

    const result = loadPacks([rawPack()], { jurisdictions: [] });
    const scope = mustRefuse(result);
    expect(scope.reason).toBe('empty-scope');
    expect(scope.jurisdictions).toEqual([]);
    expect(result.errors.join('\n')).toContain('names no jurisdiction');
  });

  it('refuses in packInScope, so no path into the filter can bypass it', () => {
    const pack = mustParse(rawPack());
    expect(() => packInScope(pack, [])).toThrow(EmptyJurisdictionScopeError);
  });

  // The up-front assert earns its keep here: with no packs loaded, nothing ever reaches
  // packInScope, so a filter-site check alone would let the emptiest run of all — no packs,
  // no jurisdictions — return [] and read as a clean pass.
  it('refuses even with NO packs loaded, where the filter is never reached', () => {
    expect(evaluatePacks([], detectors, now)).toEqual([]);
    expect(() => evaluatePacks([], { ...detectors, jurisdictions: [] }, now)).toThrow(
      EmptyJurisdictionScopeError,
    );
    expect(pendingJudgedQuestions([], undefined)).toEqual([]);
    expect(() => pendingJudgedQuestions([], [])).toThrow(EmptyJurisdictionScopeError);
    expect(mustLoad(loadPacks([])).packs).toEqual([]);
    expect(mustRefuse(loadPacks([], { jurisdictions: [] })).reason).toBe('empty-scope');
  });

  // Same silence, one step earlier: a config path that produced blank entries.
  it('treats a list whose every entry is blank as the same caller error', () => {
    const pack = mustParse(rawPack());
    expect(() => evaluatePacks([pack], { ...detectors, jurisdictions: ['', '  '] }, now)).toThrow(
      EmptyJurisdictionScopeError,
    );
  });

  // PAIRED with the blank-list case: one usable entry is enough, blanks and all.
  it('accepts a list carrying one real jurisdiction beside a blank one', () => {
    const pack = mustParse(rawPack());
    expect(evaluatePacks([pack], { ...detectors, jurisdictions: ['  ', 'EU'] }, now)).toHaveLength(
      1,
    );
  });
});

describe('loadPacks', () => {
  it('keeps the good packs and reports the bad one, rather than failing the batch', () => {
    const bad = rawPack();
    bad['pack'] = 'broken-pack';
    delete bad['reviewRequired'];
    const good = rawPack();

    const { packs, errors } = mustLoad(loadPacks([bad, good]));
    expect(packs.map((p) => p.pack)).toEqual(['test-pack']);
    expect(only(errors)).toContain('broken-pack.reviewRequired');
    expect(only(errors)).toContain('pack[0]');
  });

  it('labels errors with the caller-supplied name', () => {
    const bad = rawPack();
    delete bad['reviewRequired'];
    const { errors } = mustLoad(loadPacks([bad], { label: (i) => `eu-gdpr.json#${i}` }));
    expect(only(errors)).toContain('eu-gdpr.json#0');
  });

  it('rejects a second pack claiming an id already loaded', () => {
    const { packs, errors } = mustLoad(loadPacks([rawPack(), rawPack()]));
    expect(packs).toHaveLength(1);
    expect(only(errors)).toContain('duplicate pack id "test-pack"');
  });

  // PAIRED: the same two documents, filtered and unfiltered.
  it('pre-filters by jurisdiction when the caller declares one', () => {
    const other = rawPack();
    other['pack'] = 'us-ccpa';
    other['jurisdiction'] = ['US-CA'];

    expect(mustLoad(loadPacks([rawPack(), other])).packs.map((p) => p.pack)).toEqual([
      'test-pack',
      'us-ccpa',
    ]);
    expect(
      mustLoad(loadPacks([rawPack(), other], { jurisdictions: ['US-CA'] })).packs.map((p) => p.pack),
    ).toEqual(['us-ccpa']);
  });

  it('reports the packs it actually looked at, so "we looked" is a readable fact', () => {
    const other = rawPack();
    other['pack'] = 'us-ccpa';
    other['jurisdiction'] = ['US-CA'];

    const wide = mustLoad(loadPacks([rawPack(), other]));
    expect(wide.scope.matched).toEqual(['test-pack', 'us-ccpa']);
    expect(wide.scope.jurisdictions).toBeUndefined();

    const narrow = mustLoad(loadPacks([rawPack(), other], { jurisdictions: ['US-CA'] }));
    expect(narrow.scope.matched).toEqual(['us-ccpa']);
    expect(narrow.scope.jurisdictions).toEqual(['US-CA']);
  });
});

// THE GAP THE EMPTY-LIST GUARD LEFT WIDE OPEN, and the one that matters more.
//
// The old guard fired only when the jurisdiction list named NOTHING. A list naming something
// perfectly real that no shipped pack covers — ['US'] against a bundle of eu-gdpr, eu-ai-act
// and eu-accessibility-act — filtered every pack away, emitted zero citations, and came back
// { packs: [], errors: [] }: byte-identical to "every check passed". A compliance gate that
// reports a clean pass because it looked at nothing is worse than no gate at all, and that is
// precisely the state the empty-list guard was added to close.
describe('a jurisdiction scope matching NO pack is the same silence, and is refused too', () => {
  it('refuses ["US"] against EU-only packs, where the old guard saw nothing wrong', () => {
    const scope = mustRefuse(loadPacks([rawPack()], { jurisdictions: ['US'] }));
    expect(scope.reason).toBe('no-matching-pack');
    expect(scope.jurisdictions).toEqual(['US']);
  });

  it('names the jurisdictions given AND the packs available, because both are the fix', () => {
    const result = loadPacks([rawPack()], { jurisdictions: ['US'] });
    const scope = mustRefuse(result);
    // The message has to answer "what did I ask for" and "what could I have asked for".
    expect(scope.message).toContain('"US"');
    expect(scope.message).toContain('test-pack');
    expect(scope.message).toContain('EU');
    expect(scope.message).toMatch(/omit/i);
    expect(scope.message).toMatch(/at least one/i);
    // It goes down the DOCUMENTED channel, not just onto the scope object.
    expect(result.errors).toContain(scope.message);
    expect(scope.available).toEqual([{ pack: 'test-pack', jurisdiction: ['EU', 'EEA'] }]);
  });

  it('says "nothing was checked" in words, since the number alone reads as a pass', () => {
    const scope = mustRefuse(loadPacks([rawPack()], { jurisdictions: ['US'] }));
    expect(scope.message).toMatch(/nothing was checked/i);
    expect(scope.message).toMatch(/looked at NOTHING/);
  });

  // "I looked and found nothing" vs "I could not look" — the whole distinction, side by side
  // on the SAME two packs. Both used to produce an empty pack list and no error.
  it('is DISTINGUISHABLE from a scope that matched and simply cited nothing', () => {
    const looked = mustLoad(loadPacks([rawPack()], { jurisdictions: ['EU'] }));
    expect(looked.scope.usable).toBe(true);
    expect(looked.scope.matched).toEqual(['test-pack']);
    expect(looked.errors).toEqual([]);
    // It looked, and evaluating found nothing to cite. That is a real, earned clean pass.
    expect(evaluatePacks(looked.packs, { jurisdictions: ['EU'] }, NOW)).toEqual([]);

    const blind = mustRefuse(loadPacks([rawPack()], { jurisdictions: ['US'] }));
    expect(blind.usable).toBe(false);
  });

  // THE TYPE IS THE GUARD. `result.packs` does not compile on an un-narrowed LoadResult, so a
  // caller cannot reach an empty pack list without having read scope.usable first. This pins
  // the runtime half of that: the field is genuinely ABSENT, not an empty array wearing a flag.
  it('offers no packs field at all to read, so there is no empty list to mistake for a pass', () => {
    const result: LoadResult = loadPacks([rawPack()], { jurisdictions: ['US'] });
    expect(scopeUsable(result)).toBe(false);
    expect('packs' in result).toBe(false);
  });

  it('reports a malformed pack alongside the refusal — two things are wrong, not one', () => {
    const bad = rawPack();
    bad['pack'] = 'broken-pack';
    delete bad['reviewRequired'];

    const result = loadPacks([bad, rawPack()], { jurisdictions: ['US'] });
    expect(mustRefuse(result).reason).toBe('no-matching-pack');
    expect(result.errors.join('\n')).toContain('broken-pack.reviewRequired');
    expect(result.errors.length).toBe(2);
    // The pack that failed to parse is not offered as something to have named.
    expect(mustRefuse(result).available.map((a) => a.pack)).toEqual(['test-pack']);
  });

  // Zero packs supplied is the emptiest look of all, and a declared scope cannot match it.
  it('refuses a real jurisdiction when no pack was loaded at all', () => {
    const scope = mustRefuse(loadPacks([], { jurisdictions: ['EU'] }));
    expect(scope.reason).toBe('no-matching-pack');
    expect(scope.message).toContain('no pack was loaded at all');
  });

  // PAIRED with the refusals: matching is still trimmed and case-insensitive, and one usable
  // entry beside a blank is enough. A guard that refused these would be worse than the gap.
  it('accepts a scope that matches on case, whitespace, or one entry out of several', () => {
    expect(mustLoad(loadPacks([rawPack()], { jurisdictions: ['  eu  '] })).scope.matched).toEqual([
      'test-pack',
    ]);
    expect(mustLoad(loadPacks([rawPack()], { jurisdictions: ['US', 'EEA'] })).scope.matched).toEqual(
      ['test-pack'],
    );
  });

  it('jurisdictionScopeProblem is the one place both refusals are decided', () => {
    const pack = mustParse(rawPack());
    expect(jurisdictionScopeProblem(undefined, [pack], 'here')).toBeNull();
    expect(jurisdictionScopeProblem(['EU'], [pack], 'here')).toBeNull();
    expect(jurisdictionScopeProblem([], [pack], 'here')?.reason).toBe('empty-scope');
    expect(jurisdictionScopeProblem(['  ', ''], [pack], 'here')?.reason).toBe('empty-scope');
    expect(jurisdictionScopeProblem(['US'], [pack], 'here')?.reason).toBe('no-matching-pack');
    expect(jurisdictionScopeProblem(['US'], [pack], 'evaluatePacks')?.message).toContain(
      'evaluatePacks',
    );
  });
});

describe('a judged answer is keyed by PACK-QUALIFIED check id, never by check id alone', () => {
  const now = new Date('2026-08-22T00:00:00Z');

  /** Two packs carrying the SAME check id — a community pack extending a starter pack. */
  function collidingPack(name: string): Pack {
    const raw = rawPack();
    raw['pack'] = name;
    firstCheck(raw)['id'] = 'shared-check-id';
    firstCheck(raw)['detect'] = { kind: 'judged', question: 'Is consent bundled?' };
    return mustParse(raw);
  }

  const packA = collidingPack('pack-a');
  const packB = collidingPack('pack-b');

  it('a "yes" judged for pack A does not fire pack B — no citation for an unasked article', () => {
    const citations = evaluatePacks(
      [packA, packB],
      { judgedAnswers: { 'pack-a/shared-check-id': true }, jurisdictions: IN_SCOPE },
      now,
    );
    expect(citations.map((c) => c.pack)).toEqual(['pack-a']);
  });

  // PAIRED: the reverse ordering. Under a bare-id key the first pack absorbed the answer,
  // which silently SUPPRESSED the second pack's real finding.
  it('a "yes" judged for pack B fires pack B, whichever pack was loaded first', () => {
    const citations = evaluatePacks(
      [packA, packB],
      { judgedAnswers: { 'pack-b/shared-check-id': true }, jurisdictions: IN_SCOPE },
      now,
    );
    expect(citations.map((c) => c.pack)).toEqual(['pack-b']);
  });

  it('answers both when both are answered', () => {
    const citations = evaluatePacks(
      [packA, packB],
      {
        judgedAnswers: { 'pack-a/shared-check-id': true, 'pack-b/shared-check-id': true },
        jurisdictions: IN_SCOPE,
      },
      now,
    );
    expect(citations.map((c) => c.pack)).toEqual(['pack-a', 'pack-b']);
  });

  it('a bare check id answers nothing — the qualified key is the only key', () => {
    expect(
      evaluatePacks(
        [packA, packB],
        { judgedAnswers: { 'shared-check-id': true }, jurisdictions: IN_SCOPE },
        now,
      ),
    ).toEqual([]);
  });

  // The round trip is the contract: what the ensemble is ASKED under is what it ANSWERS under.
  it('pendingJudgedQuestions returns the key an answer must use, and it round-trips', () => {
    const questions = pendingJudgedQuestions([packA, packB], IN_SCOPE);
    expect(questions.map((q) => q.key)).toEqual([
      'pack-a/shared-check-id',
      'pack-b/shared-check-id',
    ]);
    expect(questions.map((q) => q.checkId)).toEqual(['shared-check-id', 'shared-check-id']);

    const answers = Object.fromEntries(questions.map((q) => [q.key, true]));
    expect(evaluatePacks([packA, packB], { judgedAnswers: answers }, now).map((c) => c.pack)).toEqual(
      ['pack-a', 'pack-b'],
    );
  });

  it('judgedAnswerKey is the one place the key shape is decided', () => {
    expect(judgedAnswerKey('pack-a', 'shared-check-id')).toBe('pack-a/shared-check-id');
    expect(pendingJudgedQuestions([packA])[0]?.key).toBe(
      judgedAnswerKey(packA.pack, 'shared-check-id'),
    );
  });
});

describe('pendingJudgedQuestions — this module surfaces questions, it calls no model', () => {
  it('lists judged questions in scope and omits detector checks', () => {
    const raw = rawPack();
    (raw['checks'] as unknown[]).push({
      id: 'check-judged',
      article: 'Art. 25',
      title: 'Data protection by design',
      principles: ['protect-dignity-and-safety'],
      effectiveFrom: '2018-05-25',
      detect: { kind: 'judged', question: 'Is personal data collected by default?' },
      onFire: 'review',
      guidance: 'that defaults be privacy-protective',
      reviewRequired: true,
    });
    const pack = mustParse(raw);

    const question = only(pendingJudgedQuestions([pack]));
    expect(question.checkId).toBe('check-judged');
    expect(question.question).toBe('Is personal data collected by default?');
    expect(question.article).toBe('Art. 25');
    expect(question.principles).toEqual(['protect-dignity-and-safety']);
  });

  it('asks nothing for a pack out of scope', () => {
    const raw = rawPack();
    firstCheck(raw)['detect'] = { kind: 'judged', question: 'Is consent bundled?' };
    const pack = mustParse(raw);
    expect(pendingJudgedQuestions([pack], ['EU'])).toHaveLength(1);
    expect(pendingJudgedQuestions([pack], ['UK'])).toEqual([]);
  });
});

describe('the two axes never mix — a law cannot be averaged onto an ordinal', () => {
  function assessments(): PrincipleAssessment[] {
    return PRINCIPLE_IDS.map((principle, i) => ({
      principle,
      applicability: 'scored' as const,
      score: i === 0 ? -0.5 : 1,
      rationale: 'because',
      judgeScores: [],
    }));
  }

  it('citations do not alter the humane score', () => {
    const principles = assessments();
    const before = aggregateScore(principles);
    expect(before).toBe(0.81);

    const pack = mustParse(rawPack());
    const citations = evaluatePacks([pack], FIRED, new Date('2026-08-22T00:00:00Z'));
    expect(citations.length).toBeGreaterThan(0); // the arm was actually exercised

    const verdict: HumaneVerdict = {
      scored: true,
      humaneScore: aggregateScore(principles),
      noVerdictCause: 'none' as const,
      principles,
      detectors: [],
      citations,
      judgeSet: 'hb-v1',
      judgesAnswered: 3,
      judgesAttempted: 3,
      degraded: false,
      lane: 'subscription',
    };

    expect(verdict.humaneScore).toBe(before);
    expect(aggregateScore(verdict.principles)).toBe(before);
  });

  it('a citation carries no score field at all', () => {
    const pack = mustParse(rawPack());
    const citation: ComplianceCitation = only(
      evaluatePacks([pack], FIRED, new Date('2026-08-22T00:00:00Z')),
    );
    expect(Object.keys(citation).sort()).toEqual([
      'article',
      'checkId',
      'effectiveFrom',
      'guidance',
      'instrument',
      'jurisdiction',
      'pack',
      'principles',
      'reviewRequired',
      'status',
    ]);
  });
});

describe('parseIsoDate', () => {
  it('accepts a real calendar date at UTC midnight', () => {
    expect(parseIsoDate('2018-05-25')).toBe(Date.UTC(2018, 4, 25));
  });

  it('rejects a well-formed date that does not exist, and any other shape', () => {
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('2026-8-2')).toBeNull();
    expect(parseIsoDate('2026-08-02T00:00:00Z')).toBeNull();
    expect(parseIsoDate('')).toBeNull();
  });
});

/** Yes to every judged check in `packs`, keyed the way evaluatePacks expects. */
function allJudgedYes(all: readonly Pack[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const pack of all) {
    for (const c of pack.checks) {
      if (c.detect.kind === 'judged') out[judgedAnswerKey(pack.pack, c.id)] = true;
    }
  }
  return out;
}

describe('the bundled starter packs', () => {
  const { packs, errors } = mustLoad(loadBundledPacks());
  const now = new Date('2026-08-22T00:00:00Z');
  const byId = new Map(packs.map((p) => [p.pack, p]));

  it('every bundled document parses — these ship, so they are tested as data', () => {
    expect(errors).toEqual([]);
    expect(bundledPackFiles().length).toBe(3);
    expect([...byId.keys()].sort()).toEqual(['eu-accessibility-act', 'eu-ai-act', 'eu-gdpr']);
  });

  // The guard that keeps the shipped packs honest. A detector rename that leaves a pack
  // behind turns that check into a permanently silent hole; this is what goes red.
  it('every detector-backed check in every shipped pack RAW FILE resolves to a real detector', () => {
    // Reads the pack documents OFF DISK rather than through loadBundledPacks().
    //
    // That is the whole point of this test and it was wrong once already: iterating the LOADED
    // packs is tautological, because parsePack now rejects an unknown detectorId, so the loader's
    // output can never contain one. Such a test passes whether or not the shipped data is sound —
    // it restates the validator instead of checking the files. Reading the raw JSON is what makes
    // it a real guard: edit a pack to name a detector that does not exist and this goes red, even
    // though the loader would merely have refused the pack and carried on.
    const known = new Set<string>(DETECTOR_IDS);
    const backed: Array<readonly [string, string]> = [];

    for (const file of bundledPackFiles()) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        pack: string;
        checks: Array<{ id: string; detect: { kind: string; detectorId?: string } }>;
      };
      for (const c of raw.checks) {
        if (c.detect.kind === 'detector') {
          backed.push([`${raw.pack}/${c.id}`, c.detect.detectorId ?? '<missing>'] as const);
        }
      }
    }

    expect(backed.length).toBeGreaterThan(0); // the detector arm is actually exercised by the data
    for (const [checkId, detectorId] of backed) {
      expect(known.has(detectorId), `${checkId} names unknown detector "${detectorId}"`).toBe(true);
    }
  });

  it('every check names only real principle ids and carries a source and a notice', () => {
    const known = new Set<string>(PRINCIPLE_IDS);
    for (const pack of packs) {
      expect(pack.source).toMatch(/^https:\/\//);
      expect(pack.notice).toBeTruthy();
      expect(pack.reviewRequired).toBe(true);
      for (const check of pack.checks) {
        expect(check.principles.length).toBeGreaterThan(0);
        for (const p of check.principles) expect(known.has(p)).toBe(true);
      }
    }
  });

  it('covers the articles the epic named', () => {
    const articles = (id: string) => (byId.get(id)?.checks ?? []).map((c) => c.article);
    expect(articles('eu-gdpr')).toEqual(['Art. 7(3)', 'Art. 25', 'Art. 5(1)(c)']);
    expect(articles('eu-ai-act')).toEqual([
      'Art. 50(1)',
      'Art. 50(2)',
      'Art. 5(1)(a)',
      'Art. 5(1)(b)',
    ]);
    expect(articles('eu-accessibility-act').join(' ')).toContain('2.1.1');
    expect(articles('eu-accessibility-act').join(' ')).toContain('1.1.1');
    expect(articles('eu-accessibility-act').join(' ')).toContain('4.1.3');
    expect(articles('eu-accessibility-act').join(' ')).toContain('1.4.1');
  });

  it('maps GDPR Art. 7(3) onto Enable Meaningful Choices — the bridge between the axes', () => {
    const check = byId.get('eu-gdpr')?.checks.find((c) => c.article === 'Art. 7(3)');
    expect(check?.principles).toEqual(['enable-meaningful-choices']);
  });

  it('maps the accessibility criteria onto Design for Equity and Inclusion', () => {
    for (const check of byId.get('eu-accessibility-act')?.checks ?? []) {
      expect(check.principles).toContain('design-for-equity-and-inclusion' as PrincipleId);
    }
  });

  it('maps AI Act Art. 50 onto Be Transparent and Honest', () => {
    for (const check of byId.get('eu-ai-act')?.checks.filter((c) =>
      c.article.startsWith('Art. 50'),
    ) ?? []) {
      expect(check.principles).toContain('be-transparent-and-honest' as PrincipleId);
    }
  });

  // Art. 113 applies Chapter IV — which contains ALL of Art. 50, 50(2) included — from
  // 2 Aug 2026. The 2 Aug 2027 stage governs Art. 6(1) high-risk classification, not Art. 50.
  // Dating 50(2) to 2027 made every emitted citation say "Not yet in force" about a duty that
  // is in force, which is the one thing this module exists not to do.
  it('dates BOTH Art. 50 duties to 2 Aug 2026, the Chapter IV applicability date', () => {
    const art50 = (byId.get('eu-ai-act')?.checks ?? []).filter((c) =>
      c.article.startsWith('Art. 50'),
    );
    expect(art50.map((c) => c.article)).toEqual(['Art. 50(1)', 'Art. 50(2)']);
    for (const check of art50) expect(check.effectiveFrom).toBe('2026-08-02');
  });

  it('blocks on Art. 50(2) today, rather than deferring a duty already in force', () => {
    const citation = only(
      evaluatePacks(
        packs,
        {
          judgedAnswers: { 'eu-ai-act/aiact-art50-2-synthetic-content-marking': true },
          jurisdictions: ['EU'],
        },
        now,
      ),
    );
    expect(citation.checkId).toBe('aiact-art50-2-synthetic-content-marking');
    expect(citation.effectiveFrom).toBe('2026-08-02');
    expect(citation.status).toBe('blocking');
    expect(citation.guidance).not.toMatch(/Not yet in force/);
  });

  // The genuinely future-dated shipped check. The advisory path is worth exercising against
  // real data — but with a date that is really in the future, not a wrong one standing in
  // for it. Test convenience does not get to shape shipped legal data.
  // The TOTAL property, asserted where it actually is total: over the raw pack documents, every
  // check regardless of jurisdiction or detect.kind. The test below it reaches only judged checks
  // in EU scope, because evaluatePacks emits a detector check only when its id fired — so on its
  // own it would let a future-dated detector check through while its title claimed otherwise.
  it('no shipped check in any pack file is dated in the future', () => {
    const today = new Date().toISOString().slice(0, 10);
    const dated: Array<readonly [string, string, string]> = [];
    for (const file of bundledPackFiles()) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        pack: string;
        checks: Array<{ id: string; effectiveFrom: string }>;
      };
      for (const c of raw.checks) dated.push([raw.pack, c.id, c.effectiveFrom] as const);
    }
    expect(dated.length).toBeGreaterThan(0);
    for (const [pack, id, from] of dated) {
      expect(from <= today, `${pack}/${id} is dated ${from}, in the future`).toBe(true);
    }
  });

  // The shipped packs deliberately contain NO future-dated check.
  //
  // One was added purely so the advisory path would be exercised against shipped data, and it was
  // wrong twice over — Annex III classification is Art. 6(2), not 6(1), and its date was a guess.
  // Test convenience must not shape shipped legal data in a pack whose stated premise is that a
  // confidently-wrong compliance tool is worse than none. The effectiveFrom mechanism is covered
  // against FIXTURES above, which is where a made-up date belongs.
  it('emits no advisory citation from the shipped judged checks in EU scope', () => {
    const nowCitations = evaluatePacks(
      packs,
      { judgedAnswers: allJudgedYes(packs), jurisdictions: ['EU'] },
      now,
    );
    expect(nowCitations.length).toBeGreaterThan(0);
    for (const c of nowCitations) {
      expect(c.status, `${c.checkId} is advisory in shipped data`).not.toBe('advisory');
      expect(c.guidance).not.toContain('Not yet in force');
    }
  });

  it('blocks on AI Act Art. 50(1), which is already in force', () => {
    const citation = only(
      evaluatePacks(
        packs,
        {
          judgedAnswers: { 'eu-ai-act/aiact-art50-1-ai-interaction-disclosure': true },
          jurisdictions: ['EU'],
        },
        now,
      ),
    );
    expect(citation.status).toBe('blocking');
    expect(citation.guidance).not.toMatch(/Not yet in force/);
  });

  it('emits nothing at all for a project that operates outside the EU', () => {
    expect(
      evaluatePacks(
        packs,
        {
          firedDetectorIds: [
            'consent-withdrawal-asymmetry',
            'interactive-no-keyboard-path',
            'meaningful-image-no-alt',
          ],
          jurisdictions: ['US-CA'],
        },
        now,
      ),
    ).toEqual([]);
  });

  it('surfaces the judged questions the ensemble has to answer', () => {
    const ids = pendingJudgedQuestions(packs, ['EU']).map((q) => q.checkId);
    expect(ids).toContain('gdpr-art25-protection-by-design-and-default');
    expect(ids).toContain('gdpr-art5-1-c-data-minimisation');
    expect(ids).toContain('aiact-art5-1-a-manipulative-techniques');
    expect(ids).not.toContain('gdpr-art7-3-withdrawal-symmetry');
  });

  it('emits nothing when no detector fired and no question was answered yes', () => {
    expect(evaluatePacks(packs, { jurisdictions: ['EU'] }, now)).toEqual([]);
  });

  // Reads the pack documents OFF DISK, for the same reason the detector guard does: asking the
  // LOADER which jurisdictions it loaded is tautological — it can only ever report what it just
  // filtered on. The shipped FILES are the fact under test, and they are what a pack author
  // edits. Ship a US pack tomorrow and this test tells you so, loudly, instead of a fixture
  // quietly ceasing to be a fixture.
  it('ships no pack covering "US", which is what makes the refusal below a real one', () => {
    const declared = new Set<string>();
    for (const file of bundledPackFiles()) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { jurisdiction: string[] };
      for (const j of raw.jurisdiction) declared.add(j.trim().toLowerCase());
    }
    expect(declared.size).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual(['eea', 'eu']);
    expect(declared.has('us')).toBe(false);
  });

  // THE FAILURE THE GATE EXISTS TO PREVENT, against the packs that actually ship. A US project
  // pointing the gate at this bundle used to get zero citations and no error — "no citations
  // because everything is fine" is what that looks like, and it was "no citations because
  // nothing was ever read".
  it('refuses a US scope against the EU-only bundle instead of reporting a clean pass', () => {
    const result = loadBundledPacks({ jurisdictions: ['US'] });
    const scope = mustRefuse(result);
    expect(scope.reason).toBe('no-matching-pack');
    for (const id of ['eu-gdpr', 'eu-ai-act', 'eu-accessibility-act']) {
      expect(scope.message, `the message must name ${id} as an available pack`).toContain(id);
    }
    expect(result.errors).toContain(scope.message);
  });

  // PAIRED: the same bundle, a scope it does cover. "I looked at three packs and cited nothing"
  // is a clean pass that was earned, and it has to stay readable as one.
  it('loads all three and says so when the scope does match', () => {
    const loaded = mustLoad(loadBundledPacks({ jurisdictions: ['EEA'] }));
    expect([...loaded.scope.matched].sort()).toEqual([
      'eu-accessibility-act',
      'eu-ai-act',
      'eu-gdpr',
    ]);
    expect(loaded.errors).toEqual([]);
    expect(evaluatePacks(loaded.packs, { jurisdictions: ['EEA'] }, now)).toEqual([]);
  });

  it('never emits the word "compliant" from shipped pack text, in either direction', () => {
    const everyDetector = packs.flatMap((p) =>
      p.checks.flatMap((c) => (c.detect.kind === 'detector' ? [c.detect.detectorId] : [])),
    );
    const everyJudged = Object.fromEntries(
      packs.flatMap((p) =>
        p.checks.flatMap((c) =>
          c.detect.kind === 'judged' ? [[judgedAnswerKey(p.pack, c.id), true] as const] : [],
        ),
      ),
    );
    const citations = evaluatePacks(
      packs,
      { firedDetectorIds: everyDetector, judgedAnswers: everyJudged, jurisdictions: ['EU'] },
      now,
    );
    // Every check in every bundled pack fired, so this sweeps all shipped guidance text.
    expect(citations).toHaveLength(packs.reduce((n, p) => n + p.checks.length, 0));
    for (const citation of citations) {
      expect(citation.guidance).not.toMatch(/compliant/i);
      expect(citation.guidance).toMatch(/have counsel review/i);
      expect(citation.reviewRequired).toBe(true);
    }
  });
});
