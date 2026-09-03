import { describe, expect, it } from 'vitest';

import {
  applicabilityViolations,
  PRINCIPLE_IDS,
  type HumaneVerdict,
  type PrincipleId,
} from './humaneTypes.ts';
import {
  addedLineNumbers,
  consentPrechecked,
  consentWithdrawalAsymmetry,
  DETECTOR_IDS,
  DETECTORS,
  fabricatedScarcityOrSocialProof,
  infiniteScrollNoTerminus,
  interactiveNoKeyboardPath,
  isScannableSource,
  meaningfulImageNoAlt,
  progressNotBoundToWork,
  runDetectors,
  stateByColorAlone,
  userContentInAnalytics,
  type DetectorInput,
} from './humaneDetectors.ts';
import * as fx from './humaneDetectorFixtures/index.fixture.ts';

/**
 * A newly added file: every line is a line this change is answerable for. Detectors that
 * gate on "was this line added" are exercised separately, further down.
 */
function newFile(path: string, after: string): DetectorInput {
  return { path, before: null, after };
}

/** 1-based line number of the first line containing `needle`. Throws rather than lying. */
function lineOf(source: string, needle: string): number {
  const index = source.indexOf(needle);
  if (index === -1) throw new Error(`fixture does not contain: ${needle}`);
  return source.slice(0, index).split('\n').length;
}

function idsIn(findings: ReadonlyArray<{ detectorId: string }>): string[] {
  return [...new Set(findings.map((f) => f.detectorId))].sort();
}

/**
 * The principle each detector evidences, written out here from the design rather than read
 * back from the module under test.
 *
 * This table is load-bearing, not documentation. `applicabilityViolations()` uses a
 * finding's `principle` to stop the judged layer marking that principle not-applicable, so
 * a wrong id does not fail loudly — it silently switches that integrity check off. Reading
 * the expectation out of `DETECTORS` would make the assertion true by construction.
 */
const EXPECTED_PRINCIPLE: Readonly<Record<string, PrincipleId>> = {
  'interactive-no-keyboard-path': 'design-for-equity-and-inclusion',
  'meaningful-image-no-alt': 'design-for-equity-and-inclusion',
  'state-by-color-alone': 'design-for-equity-and-inclusion',
  'consent-prechecked': 'enable-meaningful-choices',
  'consent-withdrawal-asymmetry': 'enable-meaningful-choices',
  'fabricated-scarcity-or-social-proof': 'be-transparent-and-honest',
  'progress-not-bound-to-work': 'be-transparent-and-honest',
  'infinite-scroll-no-terminus': 'respect-user-attention',
  'user-content-in-analytics': 'protect-dignity-and-safety',
};

/** Every fixture that MUST produce a finding, with the detector that must produce it. */
const FIRE_CASES: ReadonlyArray<{ id: string; path: string; source: string }> = [
  {
    id: 'interactive-no-keyboard-path',
    path: 'src/RowActions.tsx',
    source: fx.interactiveNoKeyboardFires,
  },
  { id: 'meaningful-image-no-alt', path: 'src/Avatar.tsx', source: fx.imageNoAltFires },
  { id: 'state-by-color-alone', path: 'src/HealthGrid.tsx', source: fx.stateByColorFires },
  { id: 'consent-prechecked', path: 'src/SignupExtras.tsx', source: fx.consentPrecheckedFires },
  { id: 'consent-prechecked', path: 'src/preferences.ts', source: fx.consentDefaultTrueFires },
  {
    id: 'consent-withdrawal-asymmetry',
    path: 'src/digest.ts',
    source: fx.withdrawalAsymmetryFires,
  },
  {
    id: 'consent-withdrawal-asymmetry',
    path: 'src/account.ts',
    source: fx.withdrawalAsymmetryFiresBelowCallSite,
  },
  {
    id: 'consent-withdrawal-asymmetry',
    path: 'src/PreferenceService.ts',
    source: fx.withdrawalAsymmetryFiresAsClassMethods,
  },
  {
    id: 'consent-withdrawal-asymmetry',
    path: 'src/DigestPrefs.ts',
    source: fx.withdrawalAsymmetryFiresBelowCallback,
  },
  {
    id: 'consent-withdrawal-asymmetry',
    path: 'src/TypedDigestPrefs.ts',
    source: fx.withdrawalAsymmetryFiresWithTypedParams,
  },
  {
    id: 'fabricated-scarcity-or-social-proof',
    path: 'src/StockBadge.tsx',
    source: fx.scarcityLiteralFires,
  },
  {
    id: 'fabricated-scarcity-or-social-proof',
    path: 'src/ViewerCount.tsx',
    source: fx.socialProofRandomFires,
  },
  { id: 'progress-not-bound-to-work', path: 'src/ImportProgress.tsx', source: fx.fakeProgressFires },
  { id: 'infinite-scroll-no-terminus', path: 'src/Feed.tsx', source: fx.infiniteScrollFires },
  {
    id: 'user-content-in-analytics',
    path: 'src/recordSend.ts',
    source: fx.analyticsUserContentFires,
  },
];

/** Every fixture that MUST stay silent, across every detector. */
const NEAR_MISS_SOURCES: ReadonlyArray<{ name: string; path: string; source: string }> = [
  { name: 'keyboard path present', path: 'src/a.tsx', source: fx.interactiveNoKeyboardNearMiss },
  { name: 'real button', path: 'src/b.tsx', source: fx.interactiveNoKeyboardNearMissButton },
  {
    name: 'tabIndex alone',
    path: 'src/c.tsx',
    source: fx.interactiveNoKeyboardNearMissTabIndexOnly,
  },
  { name: 'decorative alt', path: 'src/d.tsx', source: fx.imageNoAltNearMissDecorative },
  { name: 'described image', path: 'src/e.tsx', source: fx.imageNoAltNearMissDescribed },
  { name: 'image props spread', path: 'src/f.tsx', source: fx.imageNoAltNearMissSpread },
  { name: 'labelled status dot', path: 'src/g.tsx', source: fx.stateByColorNearMissLabelled },
  { name: 'status with text', path: 'src/h.tsx', source: fx.stateByColorNearMissText },
  { name: 'non-status colour', path: 'src/i.tsx', source: fx.stateByColorNearMissNeutralColour },
  { name: 'consent unchecked', path: 'src/j.tsx', source: fx.consentPrecheckedNearMissUnchecked },
  { name: 'remember me ticked', path: 'src/k.tsx', source: fx.consentPrecheckedNearMissNotConsent },
  {
    name: 'consent bound to state',
    path: 'src/l.tsx',
    source: fx.consentPrecheckedNearMissBoundToState,
  },
  { name: 'defaults off', path: 'src/m.ts', source: fx.consentDefaultTrueNearMiss },
  {
    name: 'symmetric consent',
    path: 'src/n.ts',
    source: fx.withdrawalAsymmetryNearMissSymmetric,
  },
  {
    name: 'both sides confirm',
    path: 'src/o.ts',
    source: fx.withdrawalAsymmetryNearMissBothConfirm,
  },
  {
    name: 'no opt-in counterpart',
    path: 'src/p.ts',
    source: fx.withdrawalAsymmetryNearMissNoCounterpart,
  },
  {
    name: 'opt-in called before it is declared',
    path: 'src/ac.ts',
    source: fx.withdrawalAsymmetryNearMissCallSiteBeforeOptIn,
  },
  { name: 'measured stock', path: 'src/q.tsx', source: fx.scarcityLiteralNearMissRealData },
  { name: 'retry counter', path: 'src/r.ts', source: fx.scarcityLiteralNearMissRetryCounter },
  { name: 'random avatar', path: 'src/s.ts', source: fx.socialProofRandomNearMiss },
  { name: 'measured presence', path: 'src/t.tsx', source: fx.socialProofNearMissMeasured },
  { name: 'polled job progress', path: 'src/u.tsx', source: fx.fakeProgressNearMissRealJob },
  { name: 'byte-scaled progress', path: 'src/v.tsx', source: fx.fakeProgressNearMissRealBytes },
  { name: 'plain clock', path: 'src/w.tsx', source: fx.fakeProgressNearMissClock },
  { name: 'feed with an end', path: 'src/x.tsx', source: fx.infiniteScrollNearMissHasMore },
  { name: 'load-more control', path: 'src/y.tsx', source: fx.infiniteScrollNearMissManualControl },
  {
    name: 'analytics metrics only',
    path: 'src/z.ts',
    source: fx.analyticsUserContentNearMissMetrics,
  },
  {
    name: 'literal label and error text',
    path: 'src/aa.ts',
    source: fx.analyticsUserContentNearMissLiteralAndError,
  },
  {
    name: 'not an analytics call',
    path: 'src/ab.ts',
    source: fx.analyticsUserContentNearMissNotAnalytics,
  },
];

// =======================================================================================
// design-for-equity-and-inclusion
// =======================================================================================

describe('interactive-no-keyboard-path', () => {
  it('fires on a div that handles clicks and cannot be reached from a keyboard', () => {
    const found = interactiveNoKeyboardPath(
      newFile('src/RowActions.tsx', fx.interactiveNoKeyboardFires),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.detectorId).toBe('interactive-no-keyboard-path');
    expect(found[0]?.principle).toBe('design-for-equity-and-inclusion');
    expect(found[0]?.file).toBe('src/RowActions.tsx');
    expect(found[0]?.line).toBe(
      lineOf(fx.interactiveNoKeyboardFires, '<div className="row-actions" onClick'),
    );
    expect(found[0]?.message).toContain('keyboard');
  });

  it('stays silent when role, tabIndex and a key handler are all present', () => {
    expect(
      interactiveNoKeyboardPath(newFile('src/a.tsx', fx.interactiveNoKeyboardNearMiss)),
    ).toEqual([]);
  });

  it('stays silent for a real button, which already has the keyboard path', () => {
    expect(
      interactiveNoKeyboardPath(newFile('src/b.tsx', fx.interactiveNoKeyboardNearMissButton)),
    ).toEqual([]);
  });

  it('stays silent when only one escape hatch is present', () => {
    expect(
      interactiveNoKeyboardPath(newFile('src/c.tsx', fx.interactiveNoKeyboardNearMissTabIndexOnly)),
    ).toEqual([]);
  });
});

describe('meaningful-image-no-alt', () => {
  it('fires on an image with no alt attribute at all', () => {
    const found = meaningfulImageNoAlt(newFile('src/Avatar.tsx', fx.imageNoAltFires));
    expect(found).toHaveLength(1);
    expect(found[0]?.detectorId).toBe('meaningful-image-no-alt');
    expect(found[0]?.principle).toBe('design-for-equity-and-inclusion');
    expect(found[0]?.line).toBe(lineOf(fx.imageNoAltFires, '<img'));
  });

  /**
   * THE CANONICAL PAIR. `alt=""` is how a developer says "this image carries no meaning",
   * and it is the correct answer. A detector that fires on it teaches people to write
   * alt="Image", which is worse for a screen-reader user than silence.
   */
  it('does NOT fire on an explicitly empty alt, which marks the image decorative', () => {
    expect(meaningfulImageNoAlt(newFile('src/d.tsx', fx.imageNoAltNearMissDecorative))).toEqual([]);
  });

  it('does not fire on a described image', () => {
    expect(meaningfulImageNoAlt(newFile('src/e.tsx', fx.imageNoAltNearMissDescribed))).toEqual([]);
  });

  it('does not fire when a props spread could be supplying alt', () => {
    expect(meaningfulImageNoAlt(newFile('src/f.tsx', fx.imageNoAltNearMissSpread))).toEqual([]);
  });
});

describe('state-by-color-alone', () => {
  it('fires on a status dot with no label, no text and no icon', () => {
    const found = stateByColorAlone(newFile('src/HealthGrid.tsx', fx.stateByColorFires));
    expect(found).toHaveLength(1);
    expect(found[0]?.detectorId).toBe('state-by-color-alone');
    expect(found[0]?.principle).toBe('design-for-equity-and-inclusion');
    expect(found[0]?.line).toBe(lineOf(fx.stateByColorFires, 'bg-red-500'));
  });

  it('does not fire when the same dot carries an aria-label', () => {
    expect(stateByColorAlone(newFile('src/g.tsx', fx.stateByColorNearMissLabelled))).toEqual([]);
  });

  it('does not fire when the colour is accompanied by the word', () => {
    expect(stateByColorAlone(newFile('src/h.tsx', fx.stateByColorNearMissText))).toEqual([]);
  });

  it('does not fire on a colour that carries no status meaning', () => {
    expect(stateByColorAlone(newFile('src/i.tsx', fx.stateByColorNearMissNeutralColour))).toEqual(
      [],
    );
  });
});

// =======================================================================================
// enable-meaningful-choices
// =======================================================================================

describe('consent-prechecked', () => {
  it('fires on a consent checkbox that ships already ticked', () => {
    const found = consentPrechecked(newFile('src/SignupExtras.tsx', fx.consentPrecheckedFires));
    expect(found).toHaveLength(1);
    expect(found[0]?.detectorId).toBe('consent-prechecked');
    expect(found[0]?.principle).toBe('enable-meaningful-choices');
    expect(found[0]?.line).toBe(lineOf(fx.consentPrecheckedFires, 'defaultChecked'));
  });

  it('fires on a consent field defaulted to true in an object literal', () => {
    const found = consentPrechecked(newFile('src/preferences.ts', fx.consentDefaultTrueFires));
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(lineOf(fx.consentDefaultTrueFires, 'marketingEmails: true'));
  });

  it('does not fire on the same control shipped unchecked', () => {
    expect(consentPrechecked(newFile('src/j.tsx', fx.consentPrecheckedNearMissUnchecked))).toEqual(
      [],
    );
  });

  it('does not fire on a pre-ticked box that is not a consent control', () => {
    expect(consentPrechecked(newFile('src/k.tsx', fx.consentPrecheckedNearMissNotConsent))).toEqual(
      [],
    );
  });

  it('does not fire when the box is bound to stored state rather than hard-coded on', () => {
    expect(
      consentPrechecked(newFile('src/l.tsx', fx.consentPrecheckedNearMissBoundToState)),
    ).toEqual([]);
  });

  it('does not fire on defaults that are off, or on non-consent fields that are on', () => {
    expect(consentPrechecked(newFile('src/m.ts', fx.consentDefaultTrueNearMiss))).toEqual([]);
  });
});

describe('consent-withdrawal-asymmetry', () => {
  it('fires when opting out confirms and opting in does not', () => {
    const found = consentWithdrawalAsymmetry(newFile('src/digest.ts', fx.withdrawalAsymmetryFires));
    expect(found).toHaveLength(1);
    expect(found[0]?.detectorId).toBe('consent-withdrawal-asymmetry');
    expect(found[0]?.principle).toBe('enable-meaningful-choices');
    expect(found[0]?.line).toBe(
      lineOf(fx.withdrawalAsymmetryFires, 'export async function unsubscribeFromDigest'),
    );
    expect(found[0]?.message).toContain('unsubscribeFromDigest');
    expect(found[0]?.message).toContain('subscribeToDigest');
  });

  it('does not fire when both directions cost the same', () => {
    expect(
      consentWithdrawalAsymmetry(newFile('src/n.ts', fx.withdrawalAsymmetryNearMissSymmetric)),
    ).toEqual([]);
  });

  it('does not fire when both directions confirm', () => {
    expect(
      consentWithdrawalAsymmetry(newFile('src/o.ts', fx.withdrawalAsymmetryNearMissBothConfirm)),
    ).toEqual([]);
  });

  it('does not fire without an opt-in counterpart to compare against', () => {
    expect(
      consentWithdrawalAsymmetry(newFile('src/p.ts', fx.withdrawalAsymmetryNearMissNoCounterpart)),
    ).toEqual([]);
  });

  /**
   * THE CALL-SITE PAIR. A declaration finder that accepts any `name(` line — or any line
   * carrying an arrow — takes the first CALL of a function for its declaration, and then
   * collects the caller's lines as the body. Both members of this pair are decided by that
   * one mistake, in opposite directions, which is what pins the cause to the finder rather
   * than to either fixture.
   */
  it('anchors the finding to the declaration, not to an earlier call of it', () => {
    const source = fx.withdrawalAsymmetryFiresBelowCallSite;
    const found = consentWithdrawalAsymmetry(newFile('src/account.ts', source));
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(lineOf(source, 'export async function unsubscribeFromDigest'));
    // The call site sits above the declaration; blaming it would report the wrong line.
    expect(found[0]?.line).toBeGreaterThan(lineOf(source, '  unsubscribeFromDigest(userId);'));
  });

  it('does not fire when the opt-in confirms in its declaration but is called earlier', () => {
    expect(
      consentWithdrawalAsymmetry(
        newFile('src/ac.ts', fx.withdrawalAsymmetryNearMissCallSiteBeforeOptIn),
      ),
    ).toEqual([]);
  });
});

// =======================================================================================
// be-transparent-and-honest
// =======================================================================================

describe('fabricated-scarcity-or-social-proof', () => {
  it('fires on a hard-coded stock count', () => {
    const found = fabricatedScarcityOrSocialProof(
      newFile('src/StockBadge.tsx', fx.scarcityLiteralFires),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.detectorId).toBe('fabricated-scarcity-or-social-proof');
    expect(found[0]?.principle).toBe('be-transparent-and-honest');
    expect(found[0]?.line).toBe(lineOf(fx.scarcityLiteralFires, 'Only 3 left'));
  });

  it('fires on a viewer count produced by Math.random', () => {
    const found = fabricatedScarcityOrSocialProof(
      newFile('src/ViewerCount.tsx', fx.socialProofRandomFires),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(lineOf(fx.socialProofRandomFires, 'Math.random'));
    expect(found[0]?.message).toContain('Math.random');
  });

  it('does not fire when the number comes from real data', () => {
    expect(
      fabricatedScarcityOrSocialProof(newFile('src/q.tsx', fx.scarcityLiteralNearMissRealData)),
    ).toEqual([]);
  });

  it('does not fire on an engineering counter that happens to read like scarcity', () => {
    expect(
      fabricatedScarcityOrSocialProof(newFile('src/r.ts', fx.scarcityLiteralNearMissRetryCounter)),
    ).toEqual([]);
  });

  it('does not fire on Math.random far away from any scarcity claim', () => {
    expect(
      fabricatedScarcityOrSocialProof(newFile('src/s.ts', fx.socialProofRandomNearMiss)),
    ).toEqual([]);
  });

  it('does not fire on a measured presence count', () => {
    expect(
      fabricatedScarcityOrSocialProof(newFile('src/t.tsx', fx.socialProofNearMissMeasured)),
    ).toEqual([]);
  });
});

describe('progress-not-bound-to-work', () => {
  it('fires on a progress bar advanced by a timer', () => {
    const found = progressNotBoundToWork(newFile('src/ImportProgress.tsx', fx.fakeProgressFires));
    expect(found).toHaveLength(1);
    expect(found[0]?.detectorId).toBe('progress-not-bound-to-work');
    expect(found[0]?.principle).toBe('be-transparent-and-honest');
    expect(found[0]?.line).toBe(lineOf(fx.fakeProgressFires, 'setInterval'));
  });

  it('does not fire when the interval polls the real job', () => {
    expect(progressNotBoundToWork(newFile('src/u.tsx', fx.fakeProgressNearMissRealJob))).toEqual([]);
  });

  it('does not fire when the step is scaled by bytes actually received', () => {
    expect(progressNotBoundToWork(newFile('src/v.tsx', fx.fakeProgressNearMissRealBytes))).toEqual(
      [],
    );
  });

  it('does not fire on a timer that has nothing to do with progress', () => {
    expect(progressNotBoundToWork(newFile('src/w.tsx', fx.fakeProgressNearMissClock))).toEqual([]);
  });
});

// =======================================================================================
// respect-user-attention
// =======================================================================================

describe('infinite-scroll-no-terminus', () => {
  it('fires on a scroll-fed list with no end state and no control', () => {
    const found = infiniteScrollNoTerminus(newFile('src/Feed.tsx', fx.infiniteScrollFires));
    expect(found).toHaveLength(1);
    expect(found[0]?.detectorId).toBe('infinite-scroll-no-terminus');
    expect(found[0]?.principle).toBe('respect-user-attention');
    expect(found[0]?.line).toBe(lineOf(fx.infiniteScrollFires, 'new IntersectionObserver'));
  });

  it('does not fire when the feed knows it can run out', () => {
    expect(infiniteScrollNoTerminus(newFile('src/x.tsx', fx.infiniteScrollNearMissHasMore))).toEqual(
      [],
    );
  });

  it('does not fire when the person presses a control to load more', () => {
    expect(
      infiniteScrollNoTerminus(newFile('src/y.tsx', fx.infiniteScrollNearMissManualControl)),
    ).toEqual([]);
  });
});

// =======================================================================================
// protect-dignity-and-safety
// =======================================================================================

describe('user-content-in-analytics', () => {
  it('fires on an analytics payload carrying the message body and an address', () => {
    const found = userContentInAnalytics(newFile('src/recordSend.ts', fx.analyticsUserContentFires));
    expect(found.map((f) => f.line)).toEqual([
      lineOf(fx.analyticsUserContentFires, 'body: draft.body'),
      lineOf(fx.analyticsUserContentFires, 'email: user.email'),
    ]);
    expect(found.every((f) => f.principle === 'protect-dignity-and-safety')).toBe(true);
    expect(found[0]?.message).toContain('body');
  });

  it('does not fire on lengths, ids and domains derived from the same fields', () => {
    expect(userContentInAnalytics(newFile('src/z.ts', fx.analyticsUserContentNearMissMetrics))).toEqual(
      [],
    );
  });

  it('does not fire on a hard-coded label or on an error object message', () => {
    expect(
      userContentInAnalytics(newFile('src/aa.ts', fx.analyticsUserContentNearMissLiteralAndError)),
    ).toEqual([]);
  });

  it('does not fire on a product API call that is not analytics', () => {
    expect(
      userContentInAnalytics(newFile('src/ab.ts', fx.analyticsUserContentNearMissNotAnalytics)),
    ).toEqual([]);
  });
});

// =======================================================================================
// Cross-cutting properties
// =======================================================================================

describe('principle ids', () => {
  it('registers exactly the nine detectors, each with the principle it evidences', () => {
    expect([...DETECTOR_IDS].sort()).toEqual(Object.keys(EXPECTED_PRINCIPLE).sort());
    for (const detector of DETECTORS) {
      expect(detector.principle).toBe(EXPECTED_PRINCIPLE[detector.id]);
    }
  });

  it('tags every emitted finding with the principle that finding evidences', () => {
    const seen = new Set<string>();
    for (const { path, source } of FIRE_CASES) {
      for (const found of runDetectors([newFile(path, source)])) {
        expect(EXPECTED_PRINCIPLE[found.detectorId]).toBeDefined();
        expect(found.principle).toBe(EXPECTED_PRINCIPLE[found.detectorId]);
        expect(PRINCIPLE_IDS).toContain(found.principle);
        seen.add(found.detectorId);
      }
    }
    // Every detector must have contributed, or the assertion above proved nothing for it.
    expect([...seen].sort()).toEqual(Object.keys(EXPECTED_PRINCIPLE).sort());
  });

  /**
   * The reason `principle` has to be right. `applicabilityViolations()` uses it to stop the
   * judged layer marking a principle not-applicable that a detector already proved
   * applicable. A wrong id here does not throw — it quietly lets the dismissal stand.
   */
  it('feeds applicabilityViolations, which catches a principle dismissed despite evidence', () => {
    const detectors = runDetectors([newFile('src/Avatar.tsx', fx.imageNoAltFires)]);
    expect(detectors).not.toHaveLength(0);

    const verdict: HumaneVerdict = {
      scored: true,
      humaneScore: 1,
      noVerdictCause: 'none' as const,
      noVerdictDetail: null,
      principles: PRINCIPLE_IDS.map((principle) => ({
        principle,
        applicability: 'not-applicable' as const,
        score: null,
        rationale: 'this change touches no human-facing surface',
        judgeScores: [],
      })),
      detectors,
      citations: [],
      judgeSet: 'hb-v1',
      judgesAnswered: 3,
      judgesAttempted: 3,
      degraded: false,
      lane: 'fleet',
    };

    expect(applicabilityViolations(verdict)).toEqual(['design-for-equity-and-inclusion']);
  });
});

describe('every fire fixture fires, and nothing else', () => {
  it.each(FIRE_CASES)('$id fires on $path', ({ id, path, source }) => {
    const found = runDetectors([newFile(path, source)]);
    expect(found.length).toBeGreaterThan(0);
    // A single id proves both halves: the right detector fired, and no other one did.
    expect(idsIn(found)).toEqual([id]);
    for (const f of found) {
      expect(f.file).toBe(path);
      expect(typeof f.line).toBe('number');
      expect(f.message.length).toBeGreaterThan(20);
    }
  });
});

describe('every near miss stays silent', () => {
  it.each(NEAR_MISS_SOURCES)('$name produces nothing', ({ path, source }) => {
    expect(runDetectors([newFile(path, source)])).toEqual([]);
  });
});

// =======================================================================================
// Only changed code is blamed
// =======================================================================================

describe('unchanged code', () => {
  it.each(FIRE_CASES)('$id does not fire when $path is unchanged', ({ path, source }) => {
    expect(runDetectors([{ path, before: source, after: source }])).toEqual([]);
  });

  it.each(FIRE_CASES)('$id does not fire when $path is only reindented', ({ path, source }) => {
    const reindented = source
      .split('\n')
      .map((line) => (line.trim() === '' ? line : `  ${line}`))
      .join('\n');
    expect(runDetectors([{ path, before: source, after: reindented }])).toEqual([]);
  });

  it('does not blame a pull request for a violation that was already there', () => {
    const before = fx.imageNoAltFires;
    const after = `${before}\nexport function Spacer() {\n  return <hr />;\n}\n`;
    expect(runDetectors([{ path: 'src/Avatar.tsx', before, after }])).toEqual([]);
  });

  it('does fire when the change modifies the offending line itself', () => {
    const before = fx.imageNoAltFires;
    const after = before.replace('src={user.photoUrl}', 'src={user.avatarUrl}');
    expect(before).not.toBe(after);
    const found = runDetectors([{ path: 'src/Avatar.tsx', before, after }]);
    expect(idsIn(found)).toEqual(['meaningful-image-no-alt']);
  });

  it('does fire when the change adds an attribute line inside an existing element', () => {
    const before = [
      'export function Row({ onOpen }) {',
      '  return (',
      '    <div',
      '      className="row"',
      '    >',
      '      Open',
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    const after = before.replace('      className="row"', '      className="row"\n      onClick={onOpen}');
    const found = runDetectors([{ path: 'src/Row.tsx', before, after }]);
    expect(idsIn(found)).toEqual(['interactive-no-keyboard-path']);
  });

  it('reports a deleted file as nothing at all', () => {
    expect(runDetectors([{ path: 'src/Avatar.tsx', before: fx.imageNoAltFires, after: null }])).toEqual(
      [],
    );
  });
});

describe('addedLineNumbers', () => {
  it('treats a brand new file as entirely added', () => {
    expect([...addedLineNumbers(null, 'a\nb\nc')]).toEqual([1, 2, 3]);
  });

  it('reports only the changed line', () => {
    expect([...addedLineNumbers('a\nb\nc', 'a\nB\nc')]).toEqual([2]);
  });

  it('reports nothing for a pure move', () => {
    expect([...addedLineNumbers('a\nb\nc', 'c\na\nb')]).toEqual([]);
  });

  it('reports nothing for a pure reindent', () => {
    expect([...addedLineNumbers('a\n  b', '    a\n        b')]).toEqual([]);
  });

  it('counts a duplicated line as added the second time', () => {
    expect([...addedLineNumbers('a\nb', 'a\na\nb')]).toEqual([2]);
  });
});

// =======================================================================================
// Scope and shape
// =======================================================================================

describe('scope', () => {
  it.each([
    'src/components/Card.tsx',
    'apps/web/pages/index.jsx',
    'packages/ui/Badge.ts',
    'packages/core/index.mjs',
  ])('scans %s', (path) => {
    expect(isScannableSource(path)).toBe(true);
  });

  it.each([
    'src/components/Card.test.tsx',
    'src/components/Card.stories.tsx',
    'src/__tests__/Card.tsx',
    'test/fixtures/Card.tsx',
    'node_modules/thing/index.js',
    'README.md',
    'migrations/001_init.sql',
  ])('skips %s', (path) => {
    expect(isScannableSource(path)).toBe(false);
  });

  /**
   * THE GATE MUST NOT FLAG ITS OWN FIXTURES. Anchoring each excluded segment to a `/`
   * matches only a directory whose WHOLE name is `fixtures`, so every fixture directory
   * named for what it holds — this module's own included — reads as shipped product. The
   * sources in it are deliberate dark patterns; scanning them reports the detector suite
   * itself as a pile of violations, which is how a gate gets switched off in its first week.
   */
  it.each([
    'packages/core/humaneDetectorFixtures/equity.fixture.ts',
    'packages/core/humaneDetectorFixtures/index.fixture.ts',
    'apps/web/testFixtures/Card.tsx',
    'apps/web/e2eFixtures/checkout.ts',
    'packages/ui/uiStories/Badge.tsx',
    'packages/ui/ui-stories/Badge.tsx',
    'packages/ui/ui_mocks/api.ts',
    'apps/web/.storybook/preview.ts',
  ])('skips %s, whose directory only ENDS with an excluded name', (path) => {
    expect(isScannableSource(path)).toBe(false);
  });

  /**
   * The paired half. "Ends with an excluded name" must mean a real word boundary — a
   * camelCase capital or a separator — or the fix is just "exclude everything", and a
   * product directory that happens to contain those letters stops being scanned at all.
   */
  it.each([
    'packages/latest/index.ts',
    'apps/web/protests/PetitionForm.tsx',
    'packages/contests/LeaderBoard.tsx',
    'apps/web/histories/Timeline.tsx',
    'packages/ui/Fixtures.tsx',
  ])('still scans %s, which only CONTAINS the letters', (path) => {
    expect(isScannableSource(path)).toBe(true);
  });

  it('finds nothing in a file it does not scan, even when the pattern is there', () => {
    expect(runDetectors([newFile('src/Avatar.test.tsx', fx.imageNoAltFires)])).toEqual([]);
    expect(runDetectors([newFile('docs/example.tsx', fx.imageNoAltFires)])).toEqual([]);
  });

  it('finds nothing in its own fixture directory, where the dark patterns are on purpose', () => {
    expect(
      runDetectors([newFile('packages/core/humaneDetectorFixtures/equity.fixture.ts', fx.imageNoAltFires)]),
    ).toEqual([]);
    // Paired: the same bytes one directory up ARE product, and are still reported.
    expect(
      idsIn(runDetectors([newFile('packages/core/Avatar.tsx', fx.imageNoAltFires)])),
    ).toEqual(['meaningful-image-no-alt']);
  });

  it('is pure: the same input twice gives byte-identical output', () => {
    const files = FIRE_CASES.map(({ path, source }) => newFile(path, source));
    expect(JSON.stringify(runDetectors(files))).toBe(JSON.stringify(runDetectors(files)));
  });

  it('sorts findings by file, then line, then detector id', () => {
    const files = [...FIRE_CASES].reverse().map(({ path, source }) => newFile(path, source));
    const found = runDetectors(files);
    for (let i = 1; i < found.length; i += 1) {
      const prev = found[i - 1];
      const next = found[i];
      if (prev === undefined || next === undefined) continue;
      const order =
        prev.file.localeCompare(next.file) ||
        (prev.line ?? 0) - (next.line ?? 0) ||
        prev.detectorId.localeCompare(next.detectorId);
      expect(order).toBeLessThanOrEqual(0);
    }
  });

  it('finds nothing in an empty change set', () => {
    expect(runDetectors([])).toEqual([]);
  });
});

/**
 * MARKUP IS OUT OF SCOPE, AND THAT IS THE HONEST ANSWER.
 *
 * The scanner understands `//` and comment blocks. It does not understand `<!-- -->`, and
 * in markup `//` is not a comment at all — it is the middle of every absolute URL. Declaring
 * `.html`, `.vue`, `.svelte` and `.astro` in scope while understanding neither is worse than
 * declining them: it turns dead markup into findings and eats live attributes out of the
 * text the detectors read. Both fixtures below are bait, and each is asserted BOTH ways —
 * silent under a markup extension, and firing under one the scanner really does understand.
 */
describe('markup extensions', () => {
  it.each(['site/promo.html', 'src/components/Hero.vue', 'src/Card.svelte', 'src/Page.astro'])(
    'declines %s rather than reading it with JavaScript comment rules',
    (path) => {
      expect(isScannableSource(path)).toBe(false);
    },
  );

  it('does not report a commented-out image in an HTML comment', () => {
    expect(runDetectors([newFile('site/promo.html', fx.markupCommentedOutImage)])).toEqual([]);
    expect(runDetectors([newFile('src/components/Promo.vue', fx.markupCommentedOutImage)])).toEqual(
      [],
    );
  });

  it('does not report an image whose alt a bare URL would have blanked away', () => {
    expect(runDetectors([newFile('site/hero.html', fx.markupBareUrlEatsAlt)])).toEqual([]);
    expect(runDetectors([newFile('src/components/Hero.vue', fx.markupBareUrlEatsAlt)])).toEqual([]);
  });

  /**
   * The vacuity guard. Without this the two assertions above would also pass for fixtures
   * containing nothing a detector could ever key on. Under a `.tsx` path — where `<!-- -->`
   * really is not a comment, and `//` really does start one — both fixtures produce exactly
   * the false positive the scope rule is there to prevent.
   */
  it.each([
    { name: 'commented-out image', source: fx.markupCommentedOutImage },
    { name: 'bare URL before the alt', source: fx.markupBareUrlEatsAlt },
  ])('$name is real bait: the same bytes fire under .tsx', ({ source }) => {
    expect(idsIn(runDetectors([newFile('src/Promo.tsx', source)]))).toEqual([
      'meaningful-image-no-alt',
    ]);
  });
});
