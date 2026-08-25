/**
 * WHICH PULL REQUESTS GET SCORED — the structural gate in front of the humane build gate.
 *
 * Pure function of the changed-file list. NO model call, no network, no I/O. It decides
 * whether a change touches what Sparkle SAYS OR DOES TO A PERSON, and hands the judged
 * layer the exact lines that do.
 *
 * WHY THIS EXISTS AT ALL, in the founder's words (epic sparkle-9o0649): "a gate that blocks
 * ordinary infra PRs on a humaneness score nobody can act on will be disabled within a
 * week." So the DEFAULT for an infrastructure, config, test, docs or CI-only change is OUT
 * OF SCOPE — and out-of-scope is a FIRST-CLASS, EXPLAINED OUTCOME, never a silent pass.
 * `ScopeDecision.reason` is a sentence written to be read by a person in the PR comment,
 * and it says in so many words that not being scored is a decision rather than a score.
 *
 * ONE PATH CLASSIFIER, NOT TWO
 *
 * `humaneDetectors.isScannableSource` already answers "is this file shipped product source
 * this codebase's scanner understands". This module CALLS it rather than re-deriving it. The
 * additional `INFRA_*` patterns below are a STRICT NARROWING applied only to files that
 * predicate has already accepted: they can remove a file, never add one back. Two
 * classifiers can only disagree if either is able to overturn the other, and this one
 * cannot — which is the whole reason it is written this way. A second, freestanding path
 * classifier is the exact defect class this epic keeps hitting (six of seven pack
 * `detectorId`s naming detectors that did not exist; three guard tools each excluding
 * directories by a subtly different rule).
 *
 * A consequence worth stating plainly: `isScannableSource` does not report WHY it declined,
 * so a `.md`, a `.rs`, a `.yml` and a file under `docs/` all arrive here as one reason,
 * `not-scannable-source`. Splitting that would mean copying its regexes, which is the thing
 * this comment exists to prevent. The coarser reason is the price and it is worth paying.
 *
 * PRECISION OVER RECALL, the same doctrine `humaneDetectors` runs on. A false positive gets
 * the gate switched off; a false negative costs one unjudged surface. Every ambiguous case
 * here resolves to SILENCE, and the limits that produces are written down in
 * PRD/sparkle/humanebench-scope-render.md rather than hidden.
 *
 * MIXED PULL REQUESTS — one product file among two hundred infra files.
 *
 * The pull request is IN SCOPE and EXACTLY the product file's surfaces are scored. Not the
 * other way round in either direction:
 *   - A large change does not earn a waiver. If a diff rewrites a refusal message and also
 *     touches 200 build files, the refusal message is still what the person meets.
 *   - The 200 infra files contribute NOTHING to what is judged. No infra line is ever
 *     rendered, quoted, or blamed, so the score cannot move because a change was big.
 * Scope is therefore per-SURFACE, not per-pull-request-percentage. There is deliberately no
 * ratio threshold: a rule like "in scope when >10% of files are product" would let a real
 * dark pattern ride in on a big enough refactor, which is precisely the failure mode the
 * instrument exists to catch.
 */

import { addedLineNumbers, isScannableSource, type DetectorInput } from './humaneDetectors';

/**
 * The kinds of surface this instrument can see. Each names a way a change reaches a person,
 * and each maps to a different SITUATION in `humaneRender` — the prompt that elicits it.
 */
export const SURFACE_KINDS = [
  'user-copy',
  'refusal-or-remedy',
  'consent-or-permission',
  'notification',
  'person-affecting-default',
  'agent-prose-template',
  'ui-component',
] as const;

export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export const SURFACE_KIND_LABELS: Readonly<Record<SurfaceKind, string>> = Object.freeze({
  'user-copy': 'user-visible message',
  'refusal-or-remedy': 'refusal or remedy message',
  'consent-or-permission': 'consent or permission control',
  notification: 'notification or interruption',
  'person-affecting-default': 'default chosen on a person’s behalf',
  'agent-prose-template': 'agent-authored prose template',
  'ui-component': 'user interface element',
});

/**
 * One place in the diff where the change reaches a person.
 *
 * `line` is 1-based in the file's AFTER contents and always names a line the diff ADDED or
 * ALTERED — `addedLineNumbers` decides that, so a pure move or a reindent is never blamed.
 * That is what makes every rendered turn traceable back to something this pull request
 * actually did.
 */
export interface ScopedSurface {
  file: string;
  line: number;
  kind: SurfaceKind;
  /**
   * The added line, trimmed and comment-stripped, WITH its string literals intact. Evidence
   * a PR comment can quote — so it must be the line as written, not the blanked form the
   * classifiers work on, which renders a `toast('…')` as `toast( )`.
   */
  evidence: string;
  /**
   * Human-readable spans lifted VERBATIM off that line — string-literal contents and JSX
   * text. Possibly empty: `consent-or-permission` and `person-affecting-default` are
   * BEHAVIOURAL surfaces that need no prose to affect a person. `humaneRender` handles that
   * case explicitly rather than inventing words for it.
   */
  text: readonly string[];
}

/** Why a changed file contributed no surface. Every excluded file carries one. */
export type ExclusionReason =
  | 'deleted'
  | 'not-scannable-source'
  | 'infrastructure'
  | 'no-human-surface';

export const EXCLUSION_REASON_LABELS: Readonly<Record<ExclusionReason, string>> = Object.freeze({
  deleted: 'deleted by this change',
  'not-scannable-source':
    'not product source this scanner reads (wrong extension, or a test, fixture, vendor or docs path)',
  infrastructure: 'infrastructure, tooling or build configuration',
  'no-human-surface': 'product source, but nothing it added reaches a person',
});

export interface ExcludedFile {
  path: string;
  reason: ExclusionReason;
}

export interface ScopeDecision {
  inScope: boolean;
  /** A sentence a human reads in the PR comment. Never empty, in either direction. */
  reason: string;
  surfaces: ScopedSurface[];
  /** Every changed file that contributed nothing, and why. Out-of-scope is explainable. */
  excluded: ExcludedFile[];
}

// ---------------------------------------------------------------------------------------
// The strict narrowing: infrastructure inside otherwise-scannable source
// ---------------------------------------------------------------------------------------

/**
 * Directories that are tooling rather than product, and that `isScannableSource` has no
 * reason to know about — it answers a different question ("can the scanner read this"), and
 * a `.ts` file under `scripts/` is perfectly readable, just not something anyone meets.
 *
 * DELIBERATELY ABSENT: a bare `config/` directory. `apps/desktop/src/config/*.ts` is a
 * plausible home for exactly the person-affecting defaults this gate is supposed to see, so
 * excluding the directory NAME would blind the instrument to its own best signal. Only
 * config FILES, named below, are excluded — the ones that configure the build.
 */
const INFRA_DIR = /(?:^|\/)(?:scripts|\.github|\.husky|\.claude|\.beads|\.changeset|tooling|infra|migrations|codemods)\//;

/** Build/tool configuration by filename, at any depth. */
const INFRA_FILE =
  /(?:^|\/)(?:[\w.-]+\.config\.[cm]?[jt]sx?|(?:vitest|vite|next|nuxt|tailwind|postcss|eslint|prettier|jest|rollup|webpack|esbuild|babel|drizzle|playwright|cypress|commitlint|lint-staged)\.[\w.]*[cm]?[jt]sx?|setup-?[Tt]ests?\.[cm]?[jt]sx?)$/;

function isInfrastructure(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return INFRA_DIR.test(normalized) || INFRA_FILE.test(normalized);
}

// ---------------------------------------------------------------------------------------
// Lifting human-readable text off a changed line
// ---------------------------------------------------------------------------------------

/**
 * Lines whose text is written for a machine, not a person. Logging is the big one: a log
 * message is prose, is often two words, and is read by nobody the gate is protecting.
 */
const MACHINE_AUDIENCE_LINE =
  /\b(?:console|logger|log|tracing|telemetry|metrics|analytics)\s*\.\s*\w+\s*\(|^\s*(?:import|export)\b.*\bfrom\b/;

const URL_LIKE = /^(?:[a-z]+:)?\/\//i;

/**
 * Prose, for this instrument's purposes: at least two words made of letters. A single word
 * ("Cancel", "Deny") is user copy and IS missed by this rule — a known recall limit, taken
 * deliberately, because the alternative admits every identifier, path fragment and CSS
 * class in the diff and one false positive costs the whole gate.
 */
const TWO_WORDS = /[A-Za-z][^\s]*\s+[A-Za-z]/;

/**
 * `"flex items-center gap-2"` is two words and is not something anyone reads. Utility-class
 * strings are the single largest false-positive source in a `.tsx` diff, so they are
 * rejected structurally: every token shaped like a class name, and at least one carrying a
 * `-` or `:` separator that prose does not use between words.
 */
function looksLikeClassNames(span: string): boolean {
  const tokens = span.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  if (!tokens.every((t) => /^[a-z0-9]+(?:[-:/[\]().%_][\w\-./[\]().%]*)*$/.test(t))) return false;
  return tokens.some((t) => /[-:]/.test(t));
}

function isHumanReadable(span: string): boolean {
  const trimmed = span.trim();
  if (trimmed.length < 4) return false;
  if (URL_LIKE.test(trimmed)) return false;
  if (!TWO_WORDS.test(trimmed)) return false;
  if (looksLikeClassNames(trimmed)) return false;
  return true;
}

interface ScannedLine {
  /**
   * The line with comment bodies removed AND string/template literals blanked, trimmed.
   *
   * Blanking is what makes the classifiers safe — a keyword inside prose must not decide a
   * surface kind. It also makes this string USELESS AS EVIDENCE, which is what `display`
   * is for: quoting `toast( )` back at a reviewer, for the very surfaces whose whole point
   * is the message inside those quotes, is worse than quoting nothing.
   */
  code: string;
  /** The same line with comment bodies removed but literals KEPT. What a human is shown. */
  display: string;
  /** Contents of string and template literals that terminate on this line. */
  literals: string[];
  /** JSX text nodes: the run between a `>` and the next `<`, on this line or carried in. */
  jsxText: string[];
}

/**
 * A JSX text node that begins on a previous line:
 *
 *     <p>
 *       Sparkle could not reach the server.
 *     </p>
 *
 * The middle line holds no angle bracket at all, so a within-line `>…<` scan misses the
 * only prose in the element — and this is the ordinary way React copy is written, so
 * missing it would blind the instrument to most of what it exists to read.
 *
 * The carry is guarded HARD, because the naive version is worse than the gap. A line ending
 * in `=>` would otherwise open "JSX text" and swallow the next line of ordinary code as
 * prose. So the carry starts only after a line whose LAST thing is a complete tag
 * (`<…>` with a letter or `/` after the `<`, and no `=`/`-` immediately before the `>`),
 * and a carried line contributes only if it holds none of `; { } = ( )` — punctuation that
 * is everywhere in code and rare in a sentence. Both directions err toward silence.
 */
function closesWithTag(code: string): boolean {
  const trimmed = code.trimEnd();
  if (!trimmed.endsWith('>')) return false;
  const prev = trimmed[trimmed.length - 2];
  if (prev === '=' || prev === '-') return false;
  const lastLt = trimmed.lastIndexOf('<');
  if (lastLt < 0) return false;
  return /^<[A-Za-z/][^<>]*>$/.test(trimmed.slice(lastLt));
}

const CODE_PUNCTUATION = /[;{}=()]/;

/**
 * A single pass over a file's AFTER contents, line by line, carrying block-comment state.
 *
 * Bounded at the newline in both directions, exactly like `humaneDetectors.scanSource`
 * bounds its quoted literals: an UNTERMINATED literal contributes nothing. That discards
 * the body of a multi-line template literal, which is a real recall limit (a long
 * agent-prose template is scored only by whichever of its lines close their own quotes) —
 * and it is the safe direction, because the alternative is one stray apostrophe in JSX
 * prose swallowing the rest of the file into a "string".
 */
function scanFile(after: string): ScannedLine[] {
  const out: ScannedLine[] = [];
  let inBlockComment = false;
  let inJsxText = false;

  for (const raw of after.split('\n')) {
    const literals: string[] = [];
    let code = '';
    let display = '';
    let i = 0;

    while (i < raw.length) {
      const ch = raw[i] as string;

      if (inBlockComment) {
        if (ch === '*' && raw[i + 1] === '/') {
          inBlockComment = false;
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }

      if (ch === '/' && raw[i + 1] === '/') break; // rest of the line is a comment
      if (ch === '/' && raw[i + 1] === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }

      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch;
        let j = i + 1;
        let body = '';
        let terminated = false;
        while (j < raw.length) {
          const c = raw[j] as string;
          if (c === '\\') {
            body += raw[j + 1] ?? '';
            j += 2;
            continue;
          }
          if (c === quote) {
            terminated = true;
            j += 1;
            break;
          }
          body += c;
          j += 1;
        }
        if (terminated) literals.push(body);
        // Blank the literal in `code` so a JSX-text scan cannot read inside it, and so a
        // classifier keyed on code shape is not fooled by a keyword in prose. `display`
        // keeps the literal, because it is the line a reviewer reads in the PR comment.
        code += ' '.repeat(j - i);
        display += raw.slice(i, j);
        i = j;
        continue;
      }

      code += ch;
      display += ch;
      i += 1;
    }

    const jsxText: string[] = [];
    for (const m of code.matchAll(/>([^<>]+)</g)) {
      jsxText.push(m[1] ?? '');
    }

    const wasInJsxText: boolean = inJsxText;
    if (wasInJsxText) {
      const firstLt = code.indexOf('<');
      const carried = (firstLt < 0 ? code : code.slice(0, firstLt)).trim();
      if (carried !== '' && !CODE_PUNCTUATION.test(carried)) jsxText.push(carried);
    }
    // A prose paragraph runs over several lines, so the carry survives any line that opens
    // no new tag. It ends at the first `<` — the element's own closing tag, normally.
    inJsxText = closesWithTag(code) || (wasInJsxText && !code.includes('<'));

    out.push({ code: code.trim(), display: display.trim(), literals, jsxText });
  }

  return out;
}

// ---------------------------------------------------------------------------------------
// Classifying a changed line into a surface kind
// ---------------------------------------------------------------------------------------

const CONSENT_WORD =
  /\b(?:consent|permission|permissions|opt[-_]?in|opt[-_]?out|authoriz|approval|approve|allowlist|share\s+(?:my|your)\s+data|terms\s+of\s+service|privacy\s+policy)/i;

const NOTIFY_WORD =
  /\b(?:toast|notify|notification|notifications|showToast|sendNotification|pushNotification|banner|snackbar)\b/i;

/**
 * Refusal and remedy prose. AGENTS.md: "A refusal or remedy message is an instruction the
 * user will follow" — which is why it gets its own kind and its own situation, rather than
 * being scored as ordinary copy.
 */
const REFUSAL_PROSE =
  /\b(?:cannot|can['’]t|could not|couldn['’]t|unable to|not allowed|not permitted|denied|blocked|refus\w*|failed to|instead|try again|you must|you need to|is required)\b/i;

/** A default whose NAME says it is chosen on a person's behalf. */
const PERSON_FACING_DEFAULT =
  /\b(?:defaultChecked|defaultSelected|defaultOpen|defaultExpanded|defaultOn|defaultEnabled|enabledByDefault|onByDefault|autoStart|autoEnable|autoOptIn|autoOptOut)\b/;

/** A looser `default… = true`, admitted only beside a consent/notify/toggle word. */
const DEFAULT_TRUE = /\bdefault\w*\s*[:=]\s*true\b/i;
const TOGGLE_WORD = /\b(?:Checkbox|CheckBox|Switch|Toggle|ToggleSwitch|ConsentToggle|checked|enabled)\b/;

const PROMPT_TEMPLATE_WORD =
  /\b(?:systemPrompt|userPrompt|promptTemplate|messageTemplate|prompt|template|instructions)\s*[:=]/;

const JSX_TAG =
  /<(?:[A-Z][\w.]*|div|span|button|a|p|h[1-6]|label|input|img|section|dialog|form|li|td|th|option|summary)\b/;

const BOOLEAN_ASSIGNMENT = /\b(?:true|false)\b/;

/**
 * Which kind of surface, if any, this changed line is. First match wins, most specific
 * first, so a consent toggle is never merely `ui-component`.
 *
 * TEXTLESS SURFACES ARE ADMITTED FOR EXACTLY TWO KINDS. A consent flow and a default are
 * behavioural: pre-ticking a box affects a person without saying a word, and the founder's
 * scope list names "consent/permission flows" and "defaults that affect a person"
 * explicitly. Every other kind requires prose, because without it there is nothing to
 * judge and admitting it would put every `.tsx` diff in scope.
 */
function classifyLine(code: string, text: readonly string[]): SurfaceKind | null {
  const hasText = text.length > 0;
  const consentish = CONSENT_WORD.test(code) || text.some((t) => CONSENT_WORD.test(t));

  if (consentish && (hasText || BOOLEAN_ASSIGNMENT.test(code) || JSX_TAG.test(code))) {
    return 'consent-or-permission';
  }

  if (
    PERSON_FACING_DEFAULT.test(code) ||
    (DEFAULT_TRUE.test(code) && (TOGGLE_WORD.test(code) || NOTIFY_WORD.test(code)))
  ) {
    return 'person-affecting-default';
  }

  if (!hasText) return null;

  if (NOTIFY_WORD.test(code)) return 'notification';
  if (text.some((t) => REFUSAL_PROSE.test(t))) return 'refusal-or-remedy';
  if (PROMPT_TEMPLATE_WORD.test(code)) return 'agent-prose-template';
  if (JSX_TAG.test(code)) return 'ui-component';
  return 'user-copy';
}

// ---------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Surfaces contributed by one file, in line order. */
function surfacesIn(input: DetectorInput): ScopedSurface[] {
  const after = input.after;
  if (after === null) return [];

  const added = addedLineNumbers(input.before, after);
  if (added.size === 0) return [];

  const scanned = scanFile(after);
  const found: ScopedSurface[] = [];

  for (let i = 0; i < scanned.length; i += 1) {
    const lineNumber = i + 1;
    if (!added.has(lineNumber)) continue;

    const { code, display, literals, jsxText } = scanned[i] as ScannedLine;
    if (code === '') continue;
    if (MACHINE_AUDIENCE_LINE.test(code)) continue;

    const seen = new Set<string>();
    const text: string[] = [];
    for (const span of [...literals, ...jsxText]) {
      const trimmed = span.trim();
      if (!isHumanReadable(trimmed)) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      text.push(trimmed);
    }

    const kind = classifyLine(code, text);
    if (kind === null) continue;

    found.push({ file: input.path, line: lineNumber, kind, evidence: display, text });
  }

  return found;
}

function describeKinds(surfaces: readonly ScopedSurface[]): string {
  const counts = new Map<SurfaceKind, number>();
  for (const s of surfaces) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const parts: string[] = [];
  for (const kind of SURFACE_KINDS) {
    const n = counts.get(kind);
    if (n) parts.push(plural(n, SURFACE_KIND_LABELS[kind]));
  }
  return parts.join(', ');
}

function describeExclusions(excluded: readonly ExcludedFile[]): string {
  const counts = new Map<ExclusionReason, number>();
  for (const e of excluded) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  const order: ExclusionReason[] = [
    'not-scannable-source',
    'infrastructure',
    'no-human-surface',
    'deleted',
  ];
  const parts: string[] = [];
  for (const reason of order) {
    const n = counts.get(reason);
    if (n) parts.push(`${n} ${EXCLUSION_REASON_LABELS[reason]}`);
  }
  return parts.join('; ');
}

/**
 * Decide whether a pull request is scored for humaneness, and hand back exactly the lines
 * that would be.
 *
 * FAILURE CONTRACT. This function never fabricates anything, and out-of-scope is not a
 * score. An EMPTY file list is reported out of scope with a reason that says so in words,
 * because a caller that supplied nothing has evaluated nothing — a downstream gate must not
 * read this as "passed", and the sentence is written so it cannot be quoted as one.
 * `inScope: false` means NOT MEASURED. Only `humaneTypes.verdictBlocks` decides blocking,
 * and it does so from a verdict, never from this.
 */
export function scopePullRequest(files: readonly DetectorInput[]): ScopeDecision {
  const surfaces: ScopedSurface[] = [];
  const excluded: ExcludedFile[] = [];

  for (const file of files) {
    if (file.after === null) {
      excluded.push({ path: file.path, reason: 'deleted' });
      continue;
    }
    if (!isScannableSource(file.path)) {
      excluded.push({ path: file.path, reason: 'not-scannable-source' });
      continue;
    }
    if (isInfrastructure(file.path)) {
      excluded.push({ path: file.path, reason: 'infrastructure' });
      continue;
    }

    const found = surfacesIn(file);
    if (found.length === 0) {
      excluded.push({ path: file.path, reason: 'no-human-surface' });
      continue;
    }
    surfaces.push(...found);
  }

  if (files.length === 0) {
    return {
      inScope: false,
      reason:
        'Out of scope: no changed files were supplied, so there was nothing to examine. ' +
        'This is not a passing score — nothing was measured.',
      surfaces,
      excluded,
    };
  }

  if (surfaces.length === 0) {
    return {
      inScope: false,
      reason:
        `Out of scope: none of the ${plural(files.length, 'changed file')} changes what ` +
        `Sparkle says or does to a person (${describeExclusions(excluded)}). This pull ` +
        'request was not scored for humaneness — that is a decision about what the ' +
        'instrument can see, not a passing score.',
      surfaces,
      excluded,
    };
  }

  const touchedFiles = new Set(surfaces.map((s) => s.file)).size;
  const tail =
    excluded.length > 0
      ? ` The other ${plural(excluded.length, 'changed file')} contributed nothing that is scored (${describeExclusions(excluded)}).`
      : '';

  return {
    inScope: true,
    reason:
      `In scope: this pull request changes what Sparkle says or does to a person in ` +
      `${plural(surfaces.length, 'place')} across ${plural(touchedFiles, 'file')} — ` +
      `${describeKinds(surfaces)}. Only those lines are scored.${tail}`,
    surfaces,
    excluded,
  };
}
