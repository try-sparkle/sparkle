import { describe, expect, it } from 'vitest';

import { MAX_TURNS, renderSurfaces, toEvaluatorInput } from './humaneRender';
import { scopePullRequest, type ScopedSurface, type SurfaceKind } from './humaneScope';

function surface(
  kind: SurfaceKind,
  text: string[],
  overrides: Partial<ScopedSurface> = {},
): ScopedSurface {
  return {
    file: 'apps/desktop/src/Panel.tsx',
    line: 12,
    kind,
    evidence: 'const copy =',
    text,
    ...overrides,
  };
}

describe('renderSurfaces — the response is the pull request, never ours', () => {
  it("carries the diff's own words through byte for byte", () => {
    const copy = 'We cannot export your data right now. Try again after the sync finishes.';
    const result = renderSurfaces([surface('refusal-or-remedy', [copy])]);

    expect(result.rendered).toBe(true);
    expect(result.turns[0]?.response).toBe(copy);
    expect(result.turns[0]?.verbatim).toEqual([copy]);
    expect(result.turns[0]?.hasBehaviourNote).toBe(false);
  });

  it('never leaks the situation into the response, or the copy into the situation', () => {
    const copy = 'Your teammates are waiting on you right now.';
    const [turn] = renderSurfaces([surface('notification', [copy])]).turns;

    // The evaluator scores the RESPONSE. Anything of ours that lands in it is a sentence we
    // wrote being scored as if the pull request had written it.
    expect(turn?.response).toBe(copy);
    expect(turn?.userPrompt).not.toContain(copy);
    expect(turn?.userPrompt.length).toBeGreaterThan(0);
  });

  it('gives the same situation to the same kind whatever the diff says', () => {
    const a = renderSurfaces([surface('refusal-or-remedy', ['We cannot do that.'])]);
    const b = renderSurfaces([
      surface('refusal-or-remedy', ['This is not permitted for your account.'], {
        file: 'apps/desktop/src/Other.tsx',
      }),
    ]);

    // The anti-laundering property: context moves the score, so the context is fixed. A
    // per-diff prompt would let a better-worded pull request buy a better score for the
    // same shipped words.
    expect(a.turns[0]?.userPrompt).toBe(b.turns[0]?.userPrompt);
  });

  it('gives different situations to different kinds', () => {
    const prompts = new Set(
      renderSurfaces([
        surface('refusal-or-remedy', ['We cannot do that.']),
        surface('notification', ['Come back and finish your work.']),
        surface('user-copy', ['Everything is up to date.']),
      ]).turns.map((t) => t.userPrompt),
    );

    expect(prompts.size).toBe(3);
  });

  it('feeds the vendored evaluator exactly its two arguments', () => {
    const [turn] = renderSurfaces([surface('user-copy', ['Everything is up to date.'])]).turns;
    expect(turn).toBeDefined();

    expect(toEvaluatorInput(turn!)).toEqual({
      userPrompt: turn!.userPrompt,
      response: turn!.response,
    });
  });
});

describe('renderSurfaces — traceability', () => {
  it('names every file and line that contributed to a turn', () => {
    const result = renderSurfaces([
      surface('user-copy', ['Everything is up to date.'], { line: 4, evidence: 'const a =' }),
      surface('user-copy', ['Nothing needs your attention.'], { line: 9, evidence: 'const b =' }),
    ]);

    // One turn, because a screen's copy is one message a person reads — but the PR comment
    // must still be able to point at each line it was built from.
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.sources).toEqual([
      { file: 'apps/desktop/src/Panel.tsx', line: 4, evidence: 'const a =' },
      { file: 'apps/desktop/src/Panel.tsx', line: 9, evidence: 'const b =' },
    ]);
    expect(result.turns[0]?.response).toBe(
      'Everything is up to date.\nNothing needs your attention.',
    );
  });

  it('keeps different kinds and different files in different turns', () => {
    const result = renderSurfaces([
      surface('user-copy', ['Everything is up to date.']),
      surface('refusal-or-remedy', ['We cannot reach the server.']),
      surface('user-copy', ['All set.'], { file: 'apps/desktop/src/Other.tsx' }),
    ]);

    expect(result.turns.map((t) => t.id)).toEqual([
      'apps/desktop/src/Panel.tsx#user-copy',
      'apps/desktop/src/Panel.tsx#refusal-or-remedy',
      'apps/desktop/src/Other.tsx#user-copy',
    ]);
  });

  it('says the same thing twice only once', () => {
    const result = renderSurfaces([
      surface('user-copy', ['Everything is up to date.'], { line: 4 }),
      surface('user-copy', ['Everything is up to date.'], { line: 40 }),
    ]);

    expect(result.turns[0]?.verbatim).toEqual(['Everything is up to date.']);
    // Deduping the words must not dedupe the provenance: both lines added it.
    expect(result.turns[0]?.sources.map((s) => s.line)).toEqual([4, 40]);
  });
});

describe('renderSurfaces — the behaviour note', () => {
  it('renders a wordless consent control as a bracketed, non-evaluative note', () => {
    const [turn] = renderSurfaces([surface('consent-or-permission', [])]).turns;

    expect(turn?.hasBehaviourNote).toBe(true);
    expect(turn?.response.startsWith('[')).toBe(true);
    expect(turn?.response.endsWith(']')).toBe(true);
    expect(turn?.verbatim).toEqual([]);
    // Mechanical, not a verdict. Pre-empting the judge would make the score a restatement
    // of our own opinion of the code.
    expect(turn?.response).not.toMatch(/\b(?:dark pattern|manipulat|coerc|unacceptable|bad)\b/i);
  });

  it('keeps the note beside the copy, not instead of it, when there are words too', () => {
    const [turn] = renderSurfaces([
      surface('consent-or-permission', ['Share my usage data to improve the product']),
    ]).turns;

    expect(turn?.verbatim).toEqual(['Share my usage data to improve the product']);
    expect(turn?.response.startsWith('Share my usage data to improve the product\n[')).toBe(true);
  });

  it('adds no note to a kind that is made of words', () => {
    const [turn] = renderSurfaces([surface('user-copy', ['Everything is up to date.'])]).turns;

    expect(turn?.hasBehaviourNote).toBe(false);
    expect(turn?.response).not.toContain('[');
  });
});

describe('renderSurfaces — the failure contract', () => {
  it('reports no surfaces as nothing evaluated, never as an empty pass', () => {
    const result = renderSurfaces([]);

    expect(result.rendered).toBe(false);
    expect(result.turns).toEqual([]);
    expect(result.reason).toContain('no scoped surface was supplied');
    expect(result.reason).toContain('not an empty pass');
  });

  it('refuses to invent words for a surface that anchors to nothing', () => {
    // A hand-built or deserialized surface — the pipeline crosses a process boundary — with
    // no text and a kind that carries no behaviour note.
    const result = renderSurfaces([surface('ui-component', [])]);

    expect(result.rendered).toBe(false);
    expect(result.turns).toEqual([]);
    expect(result.unrendered).toEqual([
      { surface: surface('ui-component', []), reason: 'no-verbatim-anchor' },
    ]);
    expect(result.reason).toContain('not an empty pass');
  });

  it('lists a surface it could not render beside the ones it could', () => {
    const result = renderSurfaces([
      surface('user-copy', ['Everything is up to date.']),
      surface('ui-component', []),
    ]);

    expect(result.rendered).toBe(true);
    expect(result.turns).toHaveLength(1);
    expect(result.unrendered.map((u) => u.reason)).toEqual(['no-verbatim-anchor']);
    // A dropped surface is announced in the sentence a human reads, not only in a field.
    expect(result.reason).toContain('produced no turn');
  });

  it('announces the turn budget rather than truncating in silence', () => {
    const many: ScopedSurface[] = Array.from({ length: MAX_TURNS + 3 }, (_, i) =>
      surface('user-copy', [`Message number ${i} for you.`], {
        file: `apps/desktop/src/File${i}.tsx`,
      }),
    );

    const result = renderSurfaces(many);

    expect(result.turns).toHaveLength(MAX_TURNS);
    expect(result.truncated).toBe(true);
    expect(result.unrendered).toHaveLength(3);
    expect(result.unrendered.every((u) => u.reason === 'over-turn-budget')).toBe(true);
    expect(result.reason).toContain('produced no turn');
  });

  it('does not claim truncation when everything fitted', () => {
    const result = renderSurfaces([surface('user-copy', ['Everything is up to date.'])]);
    expect(result.truncated).toBe(false);
    expect(result.unrendered).toEqual([]);
  });
});

describe('scope and render together, on a diff', () => {
  it('carries a refusal message from a changed file through to a judgeable turn', () => {
    const copy = 'We cannot delete your account while a backup is running. Try again in a minute.';
    const decision = scopePullRequest([
      {
        path: 'apps/desktop/src/DangerZone.tsx',
        before: 'export function DangerZone() {\n  return null;\n}\n',
        after: [
          'export function DangerZone() {',
          `  const blocked = '${copy}';`,
          '  return blocked;',
          '}',
        ].join('\n'),
      },
      { path: 'scripts/release.ts', before: null, after: 'export const version = 2;\n' },
    ]);

    expect(decision.inScope).toBe(true);

    const result = renderSurfaces(decision.surfaces);

    expect(result.rendered).toBe(true);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.kind).toBe('refusal-or-remedy');
    expect(result.turns[0]?.response).toBe(copy);
    // Traceable to the line the diff added, in the file the diff touched — and to nothing
    // in the infrastructure file that travelled with it.
    expect(result.turns[0]?.sources.map((s) => `${s.file}:${s.line}`)).toEqual([
      'apps/desktop/src/DangerZone.tsx:2',
    ]);
  });

  it('renders nothing at all from an infrastructure-only pull request', () => {
    const decision = scopePullRequest([
      { path: 'scripts/release.ts', before: null, after: "const stage = 'ship it now';\n" },
    ]);

    expect(decision.inScope).toBe(false);
    // Out of scope and could-not-evaluate look alike and mean opposite things. This asserts
    // the pair a caller must keep apart: scope says NOT MEASURED, render says NOTHING TO
    // JUDGE, and neither is a score.
    expect(renderSurfaces(decision.surfaces).rendered).toBe(false);
  });
});
