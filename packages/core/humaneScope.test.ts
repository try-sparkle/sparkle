import { describe, expect, it } from 'vitest';

import { scopePullRequest, type ScopedSurface } from './humaneScope';

import type { DetectorInput } from './humaneDetectors';

function added(path: string, after: string): DetectorInput {
  return { path, before: null, after };
}

function kindsAt(surfaces: readonly ScopedSurface[], file: string): string[] {
  return surfaces.filter((s) => s.file === file).map((s) => s.kind);
}

/** The line a surface landed on, so a test can assert provenance rather than mere presence. */
function lineOfKind(surfaces: readonly ScopedSurface[], kind: string): number | undefined {
  return surfaces.find((s) => s.kind === kind)?.line;
}

describe('scopePullRequest — what is out of scope', () => {
  it('leaves an infrastructure-only pull request out of scope and says so in words', () => {
    const decision = scopePullRequest([
      added('scripts/deploy.ts', "const target = 'production release channel';\n"),
      added('vitest.config.ts', "export default { test: { name: 'core unit tests' } };\n"),
      added('apps/web/next.config.mjs', "const banner = 'we value your privacy';\n"),
    ]);

    expect(decision.inScope).toBe(false);
    expect(decision.surfaces).toEqual([]);
    expect(decision.excluded.map((e) => e.reason)).toEqual([
      'infrastructure',
      'infrastructure',
      'infrastructure',
    ]);
    // Out-of-scope must never be quotable as a passing score. That sentence is the whole
    // reason the founder's constraint does not turn into a silent waiver.
    expect(decision.reason).toContain('not scored');
    expect(decision.reason).toContain('not a passing score');
    expect(decision.reason).toContain('infrastructure');
  });

  it('reports an empty file list as nothing measured, not as a pass', () => {
    const decision = scopePullRequest([]);

    expect(decision.inScope).toBe(false);
    expect(decision.reason).toContain('no changed files were supplied');
    expect(decision.reason).toContain('nothing was measured');
  });

  it('never reads a deleted file, and records it as deleted', () => {
    const decision = scopePullRequest([
      { path: 'apps/desktop/src/Gone.tsx', before: "<p>We cannot help you here</p>\n", after: null },
    ]);

    expect(decision.inScope).toBe(false);
    expect(decision.excluded).toEqual([{ path: 'apps/desktop/src/Gone.tsx', reason: 'deleted' }]);
  });

  it('defers to isScannableSource for tests and fixtures rather than re-deciding', () => {
    // Deliberate dark-pattern copy, in files the SHARED classifier already declines. If this
    // module ever grows its own path rules, this is the test that goes red.
    const decision = scopePullRequest([
      added('apps/desktop/src/Consent.test.tsx', "const copy = 'You cannot opt out of this';\n"),
      added('packages/core/humaneDetectorFixtures/dark.ts', "const copy = 'You must agree now';\n"),
      added('docs/onboarding.ts', "const copy = 'We will email you forever';\n"),
      added('apps/desktop/src-tauri/src/main.rs', 'let copy = "you cannot leave";\n'),
    ]);

    expect(decision.inScope).toBe(false);
    expect(decision.excluded.map((e) => e.reason)).toEqual([
      'not-scannable-source',
      'not-scannable-source',
      'not-scannable-source',
      'not-scannable-source',
    ]);
  });

  it('does not blame a line the change only moved or reindented', () => {
    const before = "function Panel() {\n  const copy = 'We could not reach the server';\n}\n";
    const after =
      "function Panel() {\n  if (ready) {\n      const copy = 'We could not reach the server';\n  }\n}\n";

    const decision = scopePullRequest([{ path: 'apps/desktop/src/Panel.tsx', before, after }]);

    // The copy is untouched; only its indentation changed. A gate that blamed it would
    // block a pure refactor, which is exactly how the gate gets switched off.
    expect(decision.inScope).toBe(false);
    expect(decision.excluded).toEqual([
      { path: 'apps/desktop/src/Panel.tsx', reason: 'no-human-surface' },
    ]);
  });

  it('ignores prose that lives in a comment, in both comment syntaxes', () => {
    const decision = scopePullRequest([
      added(
        'apps/desktop/src/Panel.tsx',
        [
          '// You cannot cancel this subscription once it starts',
          '/*',
          ' * We will keep emailing you until you give in.',
          ' */',
          'const n = 1;',
          "const trailing = 2; // You must agree to continue using it",
        ].join('\n'),
      ),
    ]);

    expect(decision.inScope).toBe(false);
  });

  it('ignores utility class strings, URLs and machine-audience logging', () => {
    const decision = scopePullRequest([
      added(
        'apps/desktop/src/Panel.tsx',
        [
          "const cls = 'flex items-center gap-2 text-sm';",
          "const href = 'https://example.com/terms of service';",
          "console.warn('could not reach the relay, retrying now');",
          "logger.info('the worker has finished its run');",
        ].join('\n'),
      ),
    ]);

    expect(decision.inScope).toBe(false);
  });

  it('does not let an arrow function open a JSX text region and eat the next line', () => {
    const decision = scopePullRequest([
      added(
        'apps/desktop/src/Panel.tsx',
        ['const compute = () =>', '  totalItems * pricePerItem;', 'export default compute;'].join(
          '\n',
        ),
      ),
    ]);

    // `() =>` ends in `>`. The naive carry would read `totalItems * pricePerItem` as prose
    // a person reads, and every arrow function in the repo would become user copy.
    expect(decision.inScope).toBe(false);
  });
});

describe('scopePullRequest — what is in scope', () => {
  it('scores a refusal message and anchors it to the line the diff added', () => {
    const decision = scopePullRequest([
      added(
        'apps/desktop/src/Panel.tsx',
        [
          'export function Panel() {',
          '  const busy = true;',
          "  const message = 'We cannot export your data right now. Try again after the sync finishes.';",
          '  return message;',
          '}',
        ].join('\n'),
      ),
    ]);

    expect(decision.inScope).toBe(true);
    expect(kindsAt(decision.surfaces, 'apps/desktop/src/Panel.tsx')).toEqual([
      'refusal-or-remedy',
    ]);
    expect(lineOfKind(decision.surfaces, 'refusal-or-remedy')).toBe(3);
    expect(decision.surfaces[0]?.text).toEqual([
      'We cannot export your data right now. Try again after the sync finishes.',
    ]);
    expect(decision.reason).toContain('refusal or remedy message');
  });

  it('quotes the line AS WRITTEN, with the message still inside the quotes', () => {
    // Found by review on PR #2619. `evidence` was the literal-BLANKED line the classifiers
    // work on, so the PR comment quoted `toast( )` back at a reviewer — losing the message
    // for exactly the surfaces whose entire point is the message. Evidence that omits the
    // words being judged cannot be argued with, which is the whole purpose of publishing it.
    const decision = scopePullRequest([
      added('apps/desktop/src/Panel.tsx', "  toast('Everything is up to date');\n"),
    ]);

    const surface = decision.surfaces[0]!;
    expect(surface.evidence).toBe("toast('Everything is up to date');");
    expect(surface.evidence).toContain('Everything is up to date');
    // …and the blanked form must not be what a human sees.
    expect(surface.evidence).not.toMatch(/toast\(\s+\)/);
  });

  it('falls back to user-visible copy for plain product prose', () => {
    const decision = scopePullRequest([
      added('apps/desktop/src/Panel.tsx', "const heading = 'Everything is up to date';\n"),
    ]);

    // The fallback arm of the classifier. Without a test naming it, blanking that arm leaves
    // every unclassified surface with no kind at all and every situation prompt undefined.
    expect(decision.surfaces.map((s) => s.kind)).toEqual(['user-copy']);
    expect(decision.reason).toContain('user-visible message');
  });

  it('reads JSX prose that begins on a line of its own', () => {
    const decision = scopePullRequest([
      added(
        'apps/desktop/src/Welcome.tsx',
        [
          'export function Welcome() {',
          '  return (',
          '    <p>',
          '      Sparkle keeps working while you are away.',
          '      Nothing is sent anywhere without you.',
          '    </p>',
          '  );',
          '}',
        ].join('\n'),
      ),
    ]);

    const texts = decision.surfaces.flatMap((s) => s.text);
    // Neither line holds an angle bracket, and this is how React copy is normally written.
    expect(texts).toContain('Sparkle keeps working while you are away.');
    expect(texts).toContain('Nothing is sent anywhere without you.');
  });

  it('classifies a pre-ticked box as a default even though it says nothing at all', () => {
    const decision = scopePullRequest([
      added(
        'apps/desktop/src/Consent.tsx',
        ['<Checkbox', '  name="marketingConsent"', '  defaultChecked={true}', '/>'].join('\n'),
      ),
    ]);

    expect(decision.inScope).toBe(true);
    const surface = decision.surfaces.find((s) => s.kind === 'person-affecting-default');
    expect(surface).toBeDefined();
    // A behavioural surface: it affects a person without a word of prose, which is exactly
    // why textless surfaces are admitted for this kind and one other, and for no more.
    expect(surface?.text).toEqual([]);
    expect(surface?.line).toBe(3);
  });

  it('classifies a wordless permission control as consent, not as an interface element', () => {
    const decision = scopePullRequest([
      added('apps/desktop/src/Consent.tsx', '<ConsentToggle permissionGranted={true} />\n'),
    ]);

    expect(decision.surfaces.map((s) => s.kind)).toEqual(['consent-or-permission']);
    expect(decision.surfaces[0]?.text).toEqual([]);
  });

  it('separates a notification, a default and an agent prose template by kind', () => {
    const decision = scopePullRequest([
      added(
        'apps/desktop/src/Nudges.tsx',
        [
          "showToast('Your teammates are waiting on you right now');",
          '  defaultExpanded: true,',
          "  systemPrompt: 'Tell the person their work is nearly done and keep them going.',",
        ].join('\n'),
      ),
    ]);

    expect(kindsAt(decision.surfaces, 'apps/desktop/src/Nudges.tsx')).toEqual([
      'notification',
      'person-affecting-default',
      'agent-prose-template',
    ]);
  });

  it('prefers the consent classification over the plain interface-element one', () => {
    const decision = scopePullRequest([
      added(
        'apps/desktop/src/Consent.tsx',
        ['<button onClick={grant}>Give permission to read my files</button>'].join('\n'),
      ),
    ]);

    // Both a `<button>` and a consent word are present. Reading this as `ui-component`
    // would hand the judge the wrong situation entirely.
    expect(decision.surfaces.map((s) => s.kind)).toEqual(['consent-or-permission']);
  });
});

describe('scopePullRequest — the mixed pull request', () => {
  const productFile = added(
    'apps/desktop/src/Panel.tsx',
    "const copy = 'We cannot undo this once you confirm it.';\n",
  );

  function infraFiles(n: number): DetectorInput[] {
    return Array.from({ length: n }, (_, i) =>
      added(`scripts/generated-${i}.ts`, `export const n${i} = ${i};\n`),
    );
  }

  it('scores one product file among two hundred infrastructure files', () => {
    const decision = scopePullRequest([...infraFiles(200), productFile]);

    // A big change does not earn a waiver: the person still meets the refusal message.
    expect(decision.inScope).toBe(true);
    expect(decision.surfaces).toHaveLength(1);
    expect(decision.surfaces[0]?.file).toBe('apps/desktop/src/Panel.tsx');
    expect(decision.excluded).toHaveLength(200);
    expect(decision.reason).toContain('Only those lines are scored');
  });

  it('scores exactly the same surfaces whether or not the infrastructure files are there', () => {
    const withInfra = scopePullRequest([...infraFiles(200), productFile]);
    const alone = scopePullRequest([productFile]);

    // No infra line is ever rendered, quoted or blamed, so the score cannot move because
    // the pull request was large. There is deliberately no ratio threshold.
    expect(withInfra.surfaces).toEqual(alone.surfaces);
  });
});
