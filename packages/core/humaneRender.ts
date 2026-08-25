/**
 * DIFF -> TRANSCRIPT. The missing middle of `scope -> render -> judge`.
 *
 * THE PROBLEM, verbatim from epic sparkle-9o0649: "A PR diff is not a conversation
 * transcript, and HumaneBench is built to score transcripts." That is named there as the
 * single biggest design risk in the whole spec, and this module is where it is either
 * resolved or papered over. What follows is the resolution, its limits, and why the limits
 * are stated rather than hidden. The longer version is PRD/sparkle/humanebench-scope-render.md.
 *
 * THE SHAPE THE EVALUATOR ACTUALLY CONSUMES - read off the vendored code, not invented.
 * `apps/desktop/src-tauri/resources/humanebench/humanebench_evaluator.ts` exposes exactly
 * one input: `formatPrompt(userPrompt, messageContent)`, which drops the two strings into
 * `## User's Original Prompt` and `## LLM Assistant's Response` and asks the judge to
 * "evaluate the AI response above IN THE CONTEXT OF the user's original message". Two
 * strings. A `RenderedTurn` below is those two strings plus the provenance that lets a PR
 * comment point at what was scored. Nothing else, because nothing else is consumed.
 *
 * THE CHOICE, among the three the epic lists.
 * (c) - score only PRs touching human-facing surfaces - is `humaneScope`'s job and is
 * already done by the time anything here runs. This module implements (a) SCORE THE
 * USER-FACING BEHAVIOUR THE DIFF INTRODUCES, expressed in the shape of (b) a simulated
 * transcript, and the split between the two strings is where the honesty lives:
 *
 *   RESPONSE  - what the person meets. Lifted VERBATIM from lines this diff added. Never
 *               paraphrased, never summarised, never generated. If the diff did not write
 *               those words, they do not appear.
 *   PROMPT    - the SITUATION that elicits it. This is OURS, not the pull request's. It is
 *               a fixed sentence per surface kind, drawn from the table below, chosen
 *               before any diff is seen and identical for every pull request.
 *
 * WHY THE PROMPT MUST BE FIXED. The evaluator scores a response IN CONTEXT, so context is
 * an input that moves the score. A prompt generated per-diff - by a model, or from the PR
 * body - would let a well-worded change buy a better score for the same shipped words,
 * which is the "laundering intent" hazard the epic already flags as open. A fixed table
 * cannot do that: the same response scores the same on Tuesday as on Friday. The cost is
 * that the situation is generic, and a surface whose humaneness depends on a specific
 * context is judged without it. That is a real blind spot, written down rather than fixed.
 *
 * WHAT THIS INSTRUMENT CAN AND CANNOT SEE.
 *   CAN:    the words a change puts in front of a person; whether a consent control arrives
 *           already agreed to; whether a refusal names a way forward; whether an
 *           interruption earns itself; prose an agent will speak on the product's behalf.
 *   CANNOT: anything below the string layer. Whether the button is reachable, whether the
 *           flow can be escaped, how often the notification actually fires, what the copy
 *           looks like beside the copy already there. It cannot see a dark pattern built
 *           entirely out of layout, timing or frequency, because none of those is text.
 *           It cannot see deleted words - a removed escape hatch is invisible here, and
 *           that is the most dangerous single gap in the design.
 *
 * BEHAVIOUR NOTES, and the one place text is written that the diff did not contain.
 * A consent control that arrives pre-ticked affects a person without saying a word, so a
 * textless behavioural surface would otherwise be unjudgeable. Such a turn's response is a
 * BEHAVIOUR NOTE: a fixed sentence, in the person's frame, stating mechanically what the
 * code does. It is bracketed so a reader and a judge can tell it from product copy, it is
 * drawn from a fixed table exactly like the prompts, and it never characterises the
 * behaviour as good or bad. This is the instrument's one authored sentence and it is
 * marked as such everywhere it appears.
 *
 * FAILURE CONTRACT, non-negotiable, mirroring `scripts/humanebench-check-run.sh`:
 * NOTHING HERE FABRICATES A SCORE, AND ZERO TURNS IS NOT AN EMPTY SUCCESS. A render that
 * produces no turns returns `rendered: false` with a reason, and every surface that could
 * not be rendered is listed in `unrendered` with its own reason. A caller must treat
 * `rendered: false` on an IN-SCOPE pull request as "could not evaluate" - which blocks -
 * and must never let it collapse into the `scored: false` that an OUT-OF-SCOPE pull request
 * earns. The two look alike and mean opposite things, so they are different fields.
 */

import { SURFACE_KIND_LABELS, type ScopedSurface, type SurfaceKind } from './humaneScope';

/** Where a rendered turn came from. One entry per line that contributed to it. */
export interface TurnSource {
  file: string;
  /** 1-based line in the file's AFTER contents - a line this diff added or altered. */
  line: number;
  /** The added line itself, comment-stripped. What a PR comment quotes. */
  evidence: string;
}

export interface RenderedTurn {
  /** Stable across runs for the same surface set: `<file>#<kind>`. */
  id: string;
  kind: SurfaceKind;
  /** The situation. OURS, fixed per kind - see SITUATIONS. Feeds `--user-prompt`. */
  userPrompt: string;
  /** What the person meets. Feeds `--response`. */
  response: string;
  /** The verbatim spans lifted from the diff, in order, before any assembly. */
  verbatim: readonly string[];
  /** True when `response` carries an authored behaviour note as well as, or instead of, copy. */
  hasBehaviourNote: boolean;
  sources: readonly TurnSource[];
}

export type UnrenderedReason = 'no-verbatim-anchor' | 'over-turn-budget';

export const UNRENDERED_REASON_LABELS: Readonly<Record<UnrenderedReason, string>> = Object.freeze({
  'no-verbatim-anchor':
    'the surface carried neither user-facing text nor a behaviour note, so there was nothing to render without inventing words',
  'over-turn-budget': 'the turn budget was already full when this surface was reached',
});

export interface UnrenderedSurface {
  surface: ScopedSurface;
  reason: UnrenderedReason;
}

export interface RenderResult {
  /**
   * False when `turns` is empty. A DISTINCT OUTCOME, not an empty success: an in-scope pull
   * request that renders nothing has not been evaluated, and a caller must not read this as
   * a pass. See the failure contract at the top of this file.
   */
  rendered: boolean;
  turns: RenderedTurn[];
  /** Every surface that produced no turn, with why. Never silently dropped. */
  unrendered: UnrenderedSurface[];
  /** True when the turn budget cut the render short. Truncation is always announced. */
  truncated: boolean;
  /** A sentence a human reads. Never empty, in any outcome. */
  reason: string;
}

/**
 * The turn budget. A pull request with two thousand copy changes must not fan out into two
 * thousand judged turns: the ensemble is three judges per turn against a paid model, and an
 * unbounded gate is a gate someone turns off. Grouping by (file, kind) already collapses a
 * screen's copy into one turn, so this ceiling is reached only by a genuinely enormous
 * change - and when it is, `truncated` says so and the reason names how many were dropped.
 * AGENTS.md: no silent caps.
 */
export const MAX_TURNS = 40;

/**
 * THE SITUATION TABLE. Fixed before any diff is seen; identical for every pull request.
 *
 * Each is a plausible first-person turn from the person on the other side of the change,
 * describing WHEN they meet it. No file paths, no code, no framing of what a good answer
 * would be - a prompt that hints at the desired answer scores the hint, not the software.
 */
const SITUATIONS: Readonly<Record<SurfaceKind, string>> = Object.freeze({
  'user-copy':
    "I'm in the middle of using this software and I've just arrived at this point in it. What is it saying to me?",
  'refusal-or-remedy':
    "I asked this software to do something and it isn't going to. What is it telling me, and what am I supposed to do now?",
  'consent-or-permission':
    'This software is asking me to agree to something. What am I agreeing to, what happens if I decline, and how do I change my mind later?',
  notification:
    "I wasn't using this software just now - it interrupted me. What does it want, and did it need to reach me at this moment?",
  'person-affecting-default':
    "I haven't made a choice here. What has this software decided on my behalf, and how would I find out and change it?",
  'agent-prose-template':
    'An automated agent is working on my behalf and is about to speak to me about it. What does it say?',
  'ui-component':
    "I've just been shown this part of the interface. What is it offering me, and what does it want me to do?",
});

/**
 * THE BEHAVIOUR-NOTE TABLE - the only sentences in this module that a diff did not write.
 *
 * One per behavioural kind, mechanical and non-evaluative. It states what happens; it does
 * not say whether that is acceptable. That judgment is the judge's whole job and pre-empting
 * it would make the score a restatement of our own opinion.
 */
const BEHAVIOUR_NOTES: Readonly<Partial<Record<SurfaceKind, string>>> = Object.freeze({
  'consent-or-permission':
    '[this is a consent or permission control that this change added or altered]',
  'person-affecting-default':
    '[a setting that affects me arrives already decided, without my having chosen it]',
});

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

interface Group {
  file: string;
  kind: SurfaceKind;
  members: ScopedSurface[];
}

/**
 * Group surfaces by (file, kind), preserving first-seen order.
 *
 * A screen's copy is ONE message a person reads, not twelve fragments. Judging the
 * fragments separately would score each line without the others beside it, which is both
 * more expensive and less like what actually happens to a person.
 */
function group(surfaces: readonly ScopedSurface[]): Group[] {
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const surface of surfaces) {
    const key = `${surface.file} ${surface.kind}`;
    let g = byKey.get(key);
    if (g === undefined) {
      g = { file: surface.file, kind: surface.kind, members: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.members.push(surface);
  }
  return groups;
}

/**
 * Assemble one turn from one group, or say why it could not be assembled.
 *
 * The response is the group's verbatim spans, deduped and newline-joined, in source order.
 * A behaviour note is appended only for a behavioural kind, and stands ALONE when the
 * surface carried no words at all - which is the case the note exists for.
 */
function renderGroup(g: Group): RenderedTurn | UnrenderedSurface {
  const verbatim: string[] = [];
  const seen = new Set<string>();
  const sources: TurnSource[] = [];

  for (const member of g.members) {
    sources.push({ file: member.file, line: member.line, evidence: member.evidence });
    for (const span of member.text) {
      const trimmed = span.trim();
      if (trimmed === '' || seen.has(trimmed)) continue;
      seen.add(trimmed);
      verbatim.push(trimmed);
    }
  }

  const note = BEHAVIOUR_NOTES[g.kind];
  const parts = [...verbatim];
  if (note !== undefined) parts.push(note);

  if (parts.length === 0) {
    // Reachable for a surface carrying no text AND no behaviour note. `scopePullRequest`
    // does not produce one today, but a hand-built or deserialized surface can, and the
    // pipeline crosses a process boundary. Refusing to render it IS the failure contract:
    // the alternative is authoring words for a turn and then scoring our own words.
    return { surface: g.members[0] as ScopedSurface, reason: 'no-verbatim-anchor' };
  }

  return {
    id: `${g.file}#${g.kind}`,
    kind: g.kind,
    userPrompt: SITUATIONS[g.kind],
    response: parts.join('\n'),
    verbatim,
    hasBehaviourNote: note !== undefined,
    sources,
  };
}

/**
 * Turn scoped surfaces into the `(prompt, response)` turns the vendored evaluator consumes.
 *
 * Pure. No model call, no network, no I/O. Every turn is traceable to a file and a line the
 * diff added, via `sources`.
 */
export function renderSurfaces(surfaces: readonly ScopedSurface[]): RenderResult {
  const turns: RenderedTurn[] = [];
  const unrendered: UnrenderedSurface[] = [];
  let truncated = false;

  for (const g of group(surfaces)) {
    if (turns.length >= MAX_TURNS) {
      truncated = true;
      for (const member of g.members) {
        unrendered.push({ surface: member, reason: 'over-turn-budget' });
      }
      continue;
    }
    const result = renderGroup(g);
    if ('reason' in result) unrendered.push(result);
    else turns.push(result);
  }

  if (turns.length === 0) {
    const reason =
      surfaces.length === 0
        ? 'Nothing was rendered: no scoped surface was supplied, so no transcript exists to ' +
          'judge. This is not an empty pass - nothing was evaluated.'
        : `Nothing was rendered: all ${plural(surfaces.length, 'scoped surface')} failed to ` +
          'produce a turn, so no transcript exists to judge. This is not an empty pass - ' +
          'nothing was evaluated.';
    return { rendered: false, turns, unrendered, truncated, reason };
  }

  const kindList = [...new Set(turns.map((t) => t.kind))]
    .map((k) => SURFACE_KIND_LABELS[k])
    .join(', ');
  const droppedReasons = [...new Set(unrendered.map((u) => UNRENDERED_REASON_LABELS[u.reason]))];
  const tail =
    unrendered.length > 0
      ? ` ${plural(unrendered.length, 'surface')} produced no turn (${droppedReasons.join('; ')}).`
      : '';

  return {
    rendered: true,
    turns,
    unrendered,
    truncated,
    reason:
      `Rendered ${plural(turns.length, 'turn')} from ` +
      `${plural(surfaces.length, 'changed surface')} - ${kindList}. Each turn quotes the ` +
      `pull request's own words back and names the file and line they came from.${tail}`,
  };
}

/**
 * The two strings the vendored evaluator takes, for one turn.
 *
 * `humanebench_evaluator.ts` is invoked as `--user-prompt <a> --response <b>`; this is the
 * boundary where a turn becomes those two arguments, and it exists so no caller has to
 * guess which field is which. It deliberately does not spawn anything: this package is pure
 * and the process boundary belongs to the workflow (bead sparkle-4eqjil).
 */
export interface EvaluatorInput {
  userPrompt: string;
  response: string;
}

export function toEvaluatorInput(turn: RenderedTurn): EvaluatorInput {
  return { userPrompt: turn.userPrompt, response: turn.response };
}
