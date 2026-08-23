/**
 * Deterministic dark-pattern detectors for Sparkle's humane build gate.
 *
 * This is the CHEAP layer beneath the judged ensemble. No model is ever called here:
 * strings in, findings out. Every finding names the HumaneBench principle it evidences,
 * which is what lets `applicabilityViolations()` in `humaneTypes.ts` stop the judged layer
 * dismissing a principle the diff provably touched. A wrong `principle` id does not fail
 * loudly, it silently disables that integrity check, so the ids are asserted in tests.
 *
 * TWO PROPERTIES GOVERN EVERY HEURISTIC HERE, and both cut the same way:
 *
 *   1. PRECISION OVER RECALL. A false positive gets the whole gate switched off within a
 *      week; a false negative is caught by the judged layer above. So every ambiguous case
 *      resolves to SILENCE. Several detectors below carry suppressors strictly wider than
 *      the thing they guard against. That is deliberate.
 *
 *   2. ONLY CHANGED CODE IS BLAMED. A pull request is never held responsible for a
 *      violation it merely moved or reindented past. Every finding must anchor to a line
 *      the diff added or modified: see `addedLineNumbers`, which compares trimmed-line
 *      multisets so a pure move or a reindent registers as no change at all.
 *
 * This is NOT a general-purpose linter and takes no parser dependency. It is regex and
 * heuristic string analysis over the changed text, with a small shared scanner that blanks
 * comments and locates JSX-ish tags so the individual detectors stay readable.
 */

import { type DetectorFinding, type PrincipleId } from './humaneTypes.ts';

/**
 * One file as the gate sees it. `before` is null for a newly added file, `after` is null
 * for a deleted one. Both are whole-file contents, not diff hunks: the detectors work out
 * what changed themselves.
 */
export interface DetectorInput {
  path: string;
  before: string | null;
  after: string | null;
}

/** A detector, addressable by id so a config can enable or silence one by name. */
export interface Detector {
  id: string;
  principle: PrincipleId;
  run: (input: DetectorInput) => DetectorFinding[];
}

// ---------------------------------------------------------------------------------------
// Scope: which files are even looked at
// ---------------------------------------------------------------------------------------

/**
 * Extensions `scanSource` below actually understands.
 *
 * MARKUP IS DELIBERATELY ABSENT. `.html`, `.vue`, `.svelte` and `.astro` were listed here
 * once, and the scanner has only ever known JavaScript comment syntax — which gets markup
 * wrong in both directions at once. A `<!-- <img src="x"> -->` is never blanked, so dead
 * markup fires `meaningful-image-no-alt`, contradicting the very rationale that makes
 * blanking comments correct; and `//` is not a comment in markup but the middle of every
 * absolute URL, so a bare `https://…` blanks the rest of its line and eats live attributes
 * and closing tags out of the text the detectors read. Declining the file is the honest
 * answer: claiming support this module does not have is a false-positive generator, and a
 * false positive costs the whole gate. Adding markup back means teaching `scanSource`
 * `<!-- -->` AND suppressing `//`-as-comment per extension, with fixtures for both.
 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Directories whose contents are not shipped product. Test files and fixtures contain
 * deliberate dark patterns; firing on them is the fastest way to lose the gate.
 */
const NON_PRODUCT_DIR =
  /(?:^|\/)(?:node_modules|dist|build|out|coverage|__tests__|__mocks__|__fixtures__|tests?|fixtures?|mocks?|stories|storybook|e2e|examples?|docs?|vendor)\//i;

/**
 * The same names carrying a PREFIX: `humaneDetectorFixtures/`, `testFixtures/`,
 * `e2e-fixtures/`, `.storybook/`. Anchoring only on `/` matched a directory whose WHOLE
 * name is `fixtures`, so this module's own fixture directory read as shipped product and
 * the gate would have reported its own deliberate dark patterns as violations.
 *
 * The prefix must end at a real word boundary — a camelCase capital, or a `-`/`_`/`.`
 * separator — because the loose version of this rule is not a fix but a second bug:
 * `latest/`, `protests/` and `histories/` are product directories that merely contain the
 * letters. Hence the case-SENSITIVE alternation; do not add the `i` flag.
 */
const NON_PRODUCT_DIR_SUFFIXED =
  /(?:^|\/)[\w.-]*(?:[a-z0-9](?:Fixtures?|Mocks?|Stories|Storybook|Tests?|Examples?)|[-_.](?:fixtures?|mocks?|stories|storybook|tests?|examples?))\//;

const NON_PRODUCT_FILE =
  /\.(?:test|spec|stories|story|fixture|fixtures|mock|mocks|d)\.[cm]?[jt]sx?$/i;

export function isScannableSource(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (NON_PRODUCT_DIR.test(normalized)) return false;
  if (NON_PRODUCT_DIR_SUFFIXED.test(normalized)) return false;
  if (NON_PRODUCT_FILE.test(normalized)) return false;
  return SOURCE_EXTENSIONS.some((ext) => normalized.toLowerCase().endsWith(ext));
}

// ---------------------------------------------------------------------------------------
// Shared scanning
// ---------------------------------------------------------------------------------------

type Span = readonly [number, number];

interface Scan {
  /** Same length and line structure as the input, with comment bodies replaced by spaces. */
  code: string;
  /** Half-open ranges covering the CONTENTS of string and template literals. */
  stringSpans: Span[];
}

/**
 * Blank comments while remembering where the string literals are.
 *
 * Comments are blanked because a commented-out `<img>` is not a shipped `<img>`. String
 * spans are kept because several detectors must only fire on text a person will actually
 * read. Single-quoted and double-quoted literals are bounded at the newline: an apostrophe
 * in JSX prose would otherwise open a string that runs to the end of the file, and a
 * one-line mistake is recoverable where a whole-file one is not.
 */
function scanSource(src: string): Scan {
  const out = src.split('');
  const stringSpans: Span[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }

    if (c === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const contentStart = i + 1;
      let j = contentStart;
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '\n' && quote !== '`') break;
        if (ch === quote) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        // Not a literal after all (a stray apostrophe, a regex character class). Treat the
        // quote as an ordinary character rather than swallowing the rest of the file.
        i += 1;
        continue;
      }
      stringSpans.push([contentStart, j]);
      i = j + 1;
      continue;
    }

    i += 1;
  }

  return { code: out.join(''), stringSpans };
}

/**
 * Line numbers (1-based) in `after` that the change introduced or altered.
 *
 * Compares multisets of TRIMMED lines, so re-indenting a block or moving it elsewhere in
 * the same file consumes its own budget and registers as unchanged. That over-suppresses
 * in one direction only (a genuinely new line that happens to duplicate an old one is
 * missed), which is the direction this whole module errs in.
 */
export function addedLineNumbers(before: string | null, after: string): Set<number> {
  const lines = after.split('\n');
  const added = new Set<number>();

  if (before === null) {
    for (let i = 0; i < lines.length; i += 1) added.add(i + 1);
    return added;
  }

  const budget = new Map<string, number>();
  for (const line of before.split('\n')) {
    const key = line.trim();
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const key = (lines[i] ?? '').trim();
    const remaining = budget.get(key) ?? 0;
    if (remaining > 0) budget.set(key, remaining - 1);
    else added.add(i + 1);
  }

  return added;
}

interface JsxTag {
  /** Tag name as written: `div`, `Image`, `Foo.Bar`. */
  name: string;
  /** Raw attribute text between the name and the closing angle bracket. */
  attrs: string;
  /** Attribute text with every VALUE blanked, so a name test cannot match inside a value. */
  skeleton: string;
  selfClosing: boolean;
  /** Index of the opening angle bracket. */
  start: number;
  /** Index just past the closing angle bracket. */
  end: number;
  startLine: number;
  endLine: number;
}

const TAG_START = /<([A-Za-z][\w.:-]*)/g;
const MAX_TAG_LENGTH = 4000;

/**
 * Locate JSX-ish opening tags. Deliberately loose: TypeScript generics (`useState<Foo>`)
 * parse as a tag named `Foo` with no attributes, and comparison operators can produce
 * nonsense names. Every detector filters by tag name AND by the attributes it needs, so a
 * bogus tag contributes nothing.
 */
function findTags(code: string, lineAt: (index: number) => number): JsxTag[] {
  const tags: JsxTag[] = [];
  const re = new RegExp(TAG_START.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = re.exec(code)) !== null) {
    const name = match[1];
    if (name === undefined) continue;
    let i = match.index + match[0].length;
    let depth = 0;
    let quote: string | null = null;
    let closeAt = -1;
    const limit = Math.min(code.length, match.index + MAX_TAG_LENGTH);

    while (i < limit) {
      const ch = code[i];
      if (quote !== null) {
        if (ch === '\\') i += 2;
        else {
          if (ch === quote) quote = null;
          i += 1;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth <= 0) {
        closeAt = i;
        break;
      }
      i += 1;
    }

    if (closeAt === -1) continue;
    const selfClosing = code[closeAt - 1] === '/';
    const attrsEnd = selfClosing ? closeAt - 1 : closeAt;
    const attrs = code.slice(match.index + match[0].length, attrsEnd);
    tags.push({
      name,
      attrs,
      skeleton: blankAttributeValues(attrs),
      selfClosing,
      start: match.index,
      end: closeAt + 1,
      startLine: lineAt(match.index),
      endLine: lineAt(closeAt),
    });
    re.lastIndex = closeAt + 1;
  }

  return tags;
}

/** Replace every attribute value with spaces so `title="alt text"` cannot look like `alt`. */
function blankAttributeValues(attrs: string): string {
  const out = attrs.split('');
  let i = 0;
  while (i < attrs.length) {
    if (attrs[i] !== '=') {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < attrs.length && /\s/.test(attrs[j] ?? '')) j += 1;
    const opener = attrs[j];
    if (opener === '"' || opener === "'") {
      out[j] = ' ';
      j += 1;
      while (j < attrs.length && attrs[j] !== opener) {
        if (attrs[j] !== '\n') out[j] = ' ';
        j += 1;
      }
      if (j < attrs.length) out[j] = ' ';
      i = j + 1;
      continue;
    }
    if (opener === '{') {
      let depth = 0;
      while (j < attrs.length) {
        if (attrs[j] === '{') depth += 1;
        else if (attrs[j] === '}') depth -= 1;
        if (attrs[j] !== '\n') out[j] = ' ';
        j += 1;
        if (depth === 0) break;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Does the tag carry an attribute with this name (any value, or none)? */
function hasAttr(tag: JsxTag, name: string): boolean {
  return new RegExp(`(^|\\s)${name}(\\s|=|$|/)`, 'i').test(tag.skeleton);
}

function hasAnyAttr(tag: JsxTag, names: readonly string[]): boolean {
  return names.some((n) => hasAttr(tag, n));
}

/** The raw text of an attribute's value, or null when the attribute is absent or bare. */
function attrValue(tag: JsxTag, name: string): string | null {
  const re = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{([\\s\\S]*?)\\})`,
    'i',
  );
  const m = re.exec(tag.attrs);
  if (m === null) return null;
  return m[1] ?? m[2] ?? m[3] ?? '';
}

/** True for `foo`, `foo={true}`, `foo="true"`: a hard-coded on. */
function isLiterallyTrue(tag: JsxTag, name: string): boolean {
  if (!hasAttr(tag, name)) return false;
  const value = attrValue(tag, name);
  if (value === null) return true; // bare attribute, e.g. `defaultChecked`
  return /^\s*true\s*$/.test(value);
}

interface FileContext {
  path: string;
  after: string;
  code: string;
  lines: string[];
  added: Set<number>;
  stringSpans: Span[];
  tags: JsxTag[];
  lineAt: (index: number) => number;
  /** Was any line in this inclusive 1-based range added or modified? */
  touched: (startLine: number, endLine: number) => boolean;
}

function buildContext(input: DetectorInput): FileContext | null {
  const { path, before, after } = input;
  if (after === null) return null;
  if (!isScannableSource(path)) return null;

  const { code, stringSpans } = scanSource(after);
  const lineStarts: number[] = [0];
  for (let i = 0; i < after.length; i += 1) {
    if (after[i] === '\n') lineStarts.push(i + 1);
  }
  const lineAt = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const added = addedLineNumbers(before, after);
  const touched = (startLine: number, endLine: number): boolean => {
    for (let l = startLine; l <= endLine; l += 1) {
      if (added.has(l)) return true;
    }
    return false;
  };

  return {
    path,
    after,
    code,
    lines: code.split('\n'),
    added,
    stringSpans,
    tags: findTags(code, lineAt),
    lineAt,
    touched,
  };
}

function lineText(ctx: FileContext, line: number): string {
  return ctx.lines[line - 1] ?? '';
}

/** The joined text of a symmetric window of lines around `line`, clamped to the file. */
function windowText(ctx: FileContext, line: number, radius: number): string {
  const from = Math.max(1, line - radius);
  const to = Math.min(ctx.lines.length, line + radius);
  return ctx.lines.slice(from - 1, to).join('\n');
}

function finding(
  ctx: FileContext,
  detectorId: string,
  principle: PrincipleId,
  line: number,
  message: string,
): DetectorFinding {
  return { detectorId, principle, file: ctx.path, line, message };
}

/**
 * Text a person will actually read: the contents of string literals, plus JSX text nodes.
 * A JSX text node is approximated as the run between a tag's closing angle bracket and the
 * next angle bracket of any kind.
 */
function visibleTextSpans(ctx: FileContext): Span[] {
  const spans: Span[] = [...ctx.stringSpans];
  for (const tag of ctx.tags) {
    const gapStart = tag.end;
    const nextAngle = ctx.code.indexOf('<', gapStart);
    const gapEnd = nextAngle === -1 ? ctx.code.length : nextAngle;
    if (gapEnd <= gapStart) continue;
    const gap = ctx.code.slice(gapStart, gapEnd);
    if (/[;=()]/.test(gap)) continue;
    spans.push([gapStart, gapEnd]);
  }
  return spans;
}

function inSpans(spans: readonly Span[], index: number): boolean {
  return spans.some(([from, to]) => index >= from && index < to);
}

/**
 * From `open` (the index of an opening delimiter) to its match, capped so an unbalanced
 * one cannot run away with the whole file.
 */
function balancedSlice(
  code: string,
  open: number,
  openCh: string,
  closeCh: string,
  cap = 3000,
): string {
  let depth = 0;
  const limit = Math.min(code.length, open + cap);
  for (let i = open; i < limit; i += 1) {
    const ch = code[i];
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return code.slice(open, limit);
}

// =======================================================================================
// design-for-equity-and-inclusion
// =======================================================================================

const EQUITY: PrincipleId = 'design-for-equity-and-inclusion';

const KEYBOARD_ESCAPE_HATCHES = [
  'role',
  'tabindex',
  'onkeydown',
  'onkeyup',
  'onkeypress',
  'onkeydowncapture',
];

/**
 * A `div` or `span` given a click handler but no way to reach or trigger it from a
 * keyboard. Only native `div`/`span` are considered: a custom component named `Card` may
 * well handle keys internally, and guessing is how false positives start.
 */
function detectInteractiveNoKeyboardPath(ctx: FileContext): DetectorFinding[] {
  const findings: DetectorFinding[] = [];
  for (const tag of ctx.tags) {
    if (tag.name !== 'div' && tag.name !== 'span') continue;
    if (!hasAnyAttr(tag, ['onclick', 'onpress'])) continue;
    if (hasAnyAttr(tag, KEYBOARD_ESCAPE_HATCHES)) continue;
    // A spread could carry any of the escape hatches. Unknowable, so stay silent.
    if (/\{\s*\.\.\./.test(tag.attrs)) continue;
    if (!ctx.touched(tag.startLine, tag.endLine)) continue;
    findings.push(
      finding(
        ctx,
        'interactive-no-keyboard-path',
        EQUITY,
        tag.startLine,
        `This <${tag.name}> handles clicks but has no role, no tabIndex and no key handler, so it cannot be reached or activated from a keyboard. Use a <button>, or add role, tabIndex={0} and an onKeyDown.`,
      ),
    );
  }
  return findings;
}

/**
 * An image with NO `alt` attribute at all. An explicitly empty `alt=""` marks the image
 * decorative and is the correct, deliberate answer, so it must never fire. That
 * distinction is the whole point of this detector.
 */
function detectMeaningfulImageNoAlt(ctx: FileContext): DetectorFinding[] {
  const findings: DetectorFinding[] = [];
  for (const tag of ctx.tags) {
    if (tag.name !== 'img' && tag.name !== 'Image' && tag.name !== 'Img') continue;
    if (hasAttr(tag, 'alt')) continue; // includes the decorative alt=""
    if (hasAttr(tag, 'aria-hidden')) continue; // already declared decorative
    if (/\{\s*\.\.\./.test(tag.attrs)) continue; // alt may arrive through the spread
    if (!ctx.touched(tag.startLine, tag.endLine)) continue;
    findings.push(
      finding(
        ctx,
        'meaningful-image-no-alt',
        EQUITY,
        tag.startLine,
        `This <${tag.name}> has no alt attribute, so screen-reader users get nothing in its place. Describe it with alt="...", or mark it decorative with an explicit alt="".`,
      ),
    );
  }
  return findings;
}

/** Colours that carry status meaning. Blue and grey are excluded: they usually do not. */
const STATUS_COLOR =
  /(?:\b(?:bg|text|border|fill|stroke|ring|from|to)-(?:red|green|amber|yellow|orange|emerald|rose|lime)(?:-\d{2,3})?\b)|(?:\b(?:bg|text|border)-(?:danger|error|success|warning|critical)\b)|(?:(?:backgroundColor|background-color|(?<![-\w])color)\s*:\s*['"]?(?:red|green|orange|amber|yellow|crimson|lime))|(?:\b(?:statusColor|severityColor|healthColor|stateColor)\b)/i;

/** Anything that would give the same state a channel other than colour. */
const ACCESSIBLE_TEXT_NEARBY =
  /aria-label|aria-describedby|\btitle\s*=|\brole\s*=\s*["']img|<(?:svg|Icon|[A-Z]\w*Icon)\b|>[^<>{}]*[A-Za-z]{3,}[^<>{}]*</;

/**
 * A status shown only as a colour: an empty, colour-coded element with no label, and
 * nothing textual beside it. Colour-blind and screen-reader users get no state at all.
 *
 * The sibling check is a two-line window rather than a parse, and it SUPPRESSES on any
 * doubt. A status dot sitting next to its own label reads as fine here even when the label
 * is not the status; the judged layer is the backstop for that.
 */
function detectStateByColorAlone(ctx: FileContext): DetectorFinding[] {
  const findings: DetectorFinding[] = [];
  for (const tag of ctx.tags) {
    if (tag.name !== 'div' && tag.name !== 'span' && tag.name !== 'i') continue;
    const className = attrValue(tag, 'className') ?? attrValue(tag, 'class') ?? '';
    const style = attrValue(tag, 'style') ?? '';
    if (!STATUS_COLOR.test(className) && !STATUS_COLOR.test(style)) continue;
    if (
      hasAnyAttr(tag, ['aria-label', 'aria-labelledby', 'title', 'alt', 'role', 'aria-hidden'])
    ) {
      continue;
    }

    // Only an EMPTY element qualifies: anything with children already says something.
    if (!tag.selfClosing) {
      const closeIndex = ctx.code.indexOf('</', tag.end);
      if (closeIndex === -1) continue;
      const body = ctx.code.slice(tag.end, closeIndex);
      if (body.trim() !== '') continue;
    }

    if (ACCESSIBLE_TEXT_NEARBY.test(windowText(ctx, tag.startLine, 2))) continue;
    if (!ctx.touched(tag.startLine, tag.endLine)) continue;

    findings.push(
      finding(
        ctx,
        'state-by-color-alone',
        EQUITY,
        tag.startLine,
        `This <${tag.name}> shows a status using colour and nothing else: no text, no icon, no aria-label. Anyone who cannot distinguish the colour gets no status at all. Add a label or a shape alongside it.`,
      ),
    );
  }
  return findings;
}

// =======================================================================================
// enable-meaningful-choices
// =======================================================================================

const CHOICES: PrincipleId = 'enable-meaningful-choices';

const CONSENT_WORDS =
  /consent|marketing|newsletter|subscribe|subscription|promotion|tracking|analytics|telemetry|terms|privacy|cookie|opt-?in|opt_in|mailing|emails/i;

const CONSENT_DEFAULT_KEY =
  /\b\w*(?:consent|opt-?in|opt_in|newsletter|marketing|promotional|acceptterms|agreeto|allowtracking|allowanalytics|sharedata|subscribeto)\w*\s*:\s*true\b/i;

const TOGGLE_COMPONENTS = /^(?:Checkbox|CheckBox|Switch|Toggle|ToggleSwitch|ConsentToggle)$/;

/**
 * A consent control that starts turned on. Pre-ticking a consent box makes the default the
 * choice, which is exactly the choice the person never made.
 *
 * Consent binding is read from the control's OWN attributes only. Widening it to nearby
 * label text would catch a "remember me" box next to a privacy link, and one such false
 * positive costs more than every true positive this detector will ever find.
 */
function detectConsentPrechecked(ctx: FileContext): DetectorFinding[] {
  const findings: DetectorFinding[] = [];

  for (const tag of ctx.tags) {
    const isNativeToggle =
      tag.name === 'input' && /^\s*(?:checkbox|radio)\s*$/i.test(attrValue(tag, 'type') ?? '');
    const isComponentToggle = TOGGLE_COMPONENTS.test(tag.name);
    if (!isNativeToggle && !isComponentToggle) continue;

    const identity = [
      attrValue(tag, 'name'),
      attrValue(tag, 'id'),
      attrValue(tag, 'field'),
      attrValue(tag, 'label'),
      attrValue(tag, 'aria-label'),
      attrValue(tag, 'data-testid'),
    ]
      .filter((v): v is string => v !== null)
      .join(' ');
    if (!CONSENT_WORDS.test(identity)) continue;

    const prechecked =
      isLiterallyTrue(tag, 'defaultChecked') ||
      isLiterallyTrue(tag, 'checked') ||
      isLiterallyTrue(tag, 'defaultValue') ||
      isLiterallyTrue(tag, 'defaultSelected');
    if (!prechecked) continue;
    if (!ctx.touched(tag.startLine, tag.endLine)) continue;

    findings.push(
      finding(
        ctx,
        'consent-prechecked',
        CHOICES,
        tag.startLine,
        'This consent control starts already ticked, so agreement is the default rather than a choice. Ship it unchecked and let the person opt in.',
      ),
    );
  }

  for (let i = 0; i < ctx.lines.length; i += 1) {
    const line = ctx.lines[i] ?? '';
    if (!CONSENT_DEFAULT_KEY.test(line)) continue;
    const lineNo = i + 1;
    if (!ctx.added.has(lineNo)) continue;
    findings.push(
      finding(
        ctx,
        'consent-prechecked',
        CHOICES,
        lineNo,
        'This consent field defaults to true, so it is granted unless the person notices and turns it off. Default it to false.',
      ),
    );
  }

  return findings;
}

/** Opt-out and opt-in counterparts, paired so the comparison is like for like. */
const CONSENT_PAIRS: ReadonlyArray<{ out: RegExp; opt: RegExp }> = [
  { out: /\bun_?subscribe\w*/i, opt: /\bsubscribe\w*/i },
  { out: /\bopt_?out\w*/i, opt: /\bopt_?in\w*/i },
  { out: /\b(?:revoke|withdraw|decline)consent\w*/i, opt: /\b(?:grant|give|accept)consent\w*/i },
  {
    out: /\b(?:disable|turnoff)(?:tracking|analytics|notifications|emails)\w*/i,
    opt: /\b(?:enable|turnon)(?:tracking|analytics|notifications|emails)\w*/i,
  },
  {
    out: /\b(?:cancel|delete)(?:subscription|account|plan)\w*/i,
    opt: /\b(?:start|create)(?:subscription|account|plan)\w*/i,
  },
];

const CONFIRMATION_MARKER =
  /\bwindow\.confirm\s*\(|(?:^|[^.\w])confirm\s*\(|\bareYouSure\b|\bConfirmDialog\b|\bConfirmationModal\b|\bsetShowConfirm\w*\s*\(|\bsetConfirmOpen\s*\(|\bopenConfirm\w*\s*\(|\bsetStep\s*\(|\bstep\s*\+\s*1|\brequirePassword\b|\bverifyPassword\b|\btypeToConfirm\b|\bpromptForReason\b|\bexitSurvey\w*/i;

/**
 * A line that BINDS a name: `function foo`, `class Foo`, or `const|let|var foo =`.
 *
 * The name is captured, so `findDeclaration` can require that the name it matched is the
 * name being bound. The earlier version tested the line for declaration-ish SHAPE instead
 * — `=>` anywhere, or a leading `name(` — which an ordinary call site satisfies. The first
 * call of a function then stood in for its declaration and `declarationBody` collected the
 * CALLER's lines, so the comparison below ran on the wrong function entirely: silent where
 * it should fire, and firing where it should not, depending only on which side got mixed up.
 *
 * The third alternative restores METHOD SHORTHAND — `foo() {` in a class or object literal —
 * which the shape-based predicate did handle and the first binding-only rewrite dropped.
 *
 * The trailing `{` is NOT on its own enough — a CALL taking a callback ends in one too:
 *   `unsubscribe(function () {`   `describe('x', () => {`
 *
 * The discriminator is BALANCED PARENS BEFORE THE BRACE, not the absence of nested ones. An
 * earlier version of this comment claimed "a real method's parameter list cannot contain a nested
 * `(`" and excluded them outright. That is FALSE for the TypeScript this scans, and it silently
 * dropped genuine declarations:
 *   `onUnsubscribe(cb: () => void) {`                      — a callback TYPE
 *   `async unsubscribe(id: string, opts = defaults()) {`   — a default that calls something
 * In a declaration the parameter list CLOSES before the brace; in `foo(function () {` the brace
 * belongs to the function expression and the outer paren is still open. `(?:[^()]|\([^()]*\))*`
 * allows one level of nesting and requires that close, which admits both shapes above and still
 * rejects both calls.
 *
 * The keyword lookahead is DEFENCE IN DEPTH and is currently UNOBSERVABLE: `findDeclaration` is
 * the only consumer and applies the caller's pattern to the bound NAME alone, and the only
 * patterns passed are the `CONSENT_PAIRS` regexes, none of which can match `if`/`for`/`while`.
 * Kept because it costs nothing and a future caller passing a broader pattern would need it —
 * not because anything today would fail without it. Anchored to line start; `findDeclaration`
 * execs per line.
 */
const BINDING_LINE =
  /\b(?:function|class)\s+([\w$]+)|\b(?:const|let|var)\s+([\w$]+)\s*=|^\s*(?:async\s+)?(?!(?:if|for|while|switch|catch|do|else|return|typeof|new|await|yield)\b)([\w$]+)\s*\((?:[^()]|\([^()]*\))*\)\s*\{/g;

/** The lines belonging to a declaration starting at `declIndex`, bounded by indentation. */
function declarationBody(ctx: FileContext, declIndex: number, maxLines = 30): string {
  const declLine = ctx.lines[declIndex] ?? '';
  const indent = declLine.length - declLine.trimStart().length;
  const collected: string[] = [declLine];
  for (let i = declIndex + 1; i < ctx.lines.length && collected.length < maxLines; i += 1) {
    const line = ctx.lines[i] ?? '';
    if (line.trim() === '') {
      collected.push(line);
      continue;
    }
    const thisIndent = line.length - line.trimStart().length;
    collected.push(line);
    if (thisIndent <= indent) break;
  }
  return collected.join('\n');
}

/**
 * The first line that BINDS a name matching `pattern`, and the matched name.
 *
 * The pattern is applied to the bound NAME rather than to the whole line, so a call, an
 * import, a string mentioning the function or a comment about it can never be mistaken for
 * the declaration. Anything more exotic than `function` / `class` / `const|let|var` — an
 * object method, a decorated class property — reads as absent, which resolves to silence.
 */
function findDeclaration(
  ctx: FileContext,
  pattern: RegExp,
): { index: number; name: string } | null {
  for (let i = 0; i < ctx.lines.length; i += 1) {
    const line = ctx.lines[i] ?? '';
    const binding = new RegExp(BINDING_LINE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = binding.exec(line)) !== null) {
      const bound = m[1] ?? m[2] ?? m[3];
      if (bound === undefined) continue;
      const named = pattern.exec(bound);
      if (named === null) continue;
      return { index: i, name: named[0] };
    }
  }
  return null;
}

/**
 * Withdrawing consent costs more than granting it: the opt-out path has a confirmation or
 * an extra step that its opt-in counterpart does not. Both halves must be present in the
 * same file. Without the counterpart there is nothing to compare against, and a lone
 * confirmed opt-out is often perfectly reasonable.
 */
function detectConsentWithdrawalAsymmetry(ctx: FileContext): DetectorFinding[] {
  const findings: DetectorFinding[] = [];

  for (const pair of CONSENT_PAIRS) {
    const outDecl = findDeclaration(ctx, pair.out);
    if (outDecl === null) continue;
    const optDecl = findDeclaration(ctx, pair.opt);
    // `subscribe` also occurs inside `unsubscribe`; require a distinct declaration.
    if (optDecl === null || optDecl.index === outDecl.index) continue;

    const outBody = declarationBody(ctx, outDecl.index);
    const optBody = declarationBody(ctx, optDecl.index);
    if (!CONFIRMATION_MARKER.test(outBody)) continue;
    if (CONFIRMATION_MARKER.test(optBody)) continue;

    const outEndLine = outDecl.index + outBody.split('\n').length;
    if (!ctx.touched(outDecl.index + 1, outEndLine)) continue;

    findings.push(
      finding(
        ctx,
        'consent-withdrawal-asymmetry',
        CHOICES,
        outDecl.index + 1,
        `Turning this off (${outDecl.name}) goes through a confirmation or an extra step that turning it on (${optDecl.name}) does not. Withdrawing consent should be at least as easy as giving it.`,
      ),
    );
  }

  return findings;
}

// =======================================================================================
// be-transparent-and-honest
// =======================================================================================

const HONESTY: PrincipleId = 'be-transparent-and-honest';

const SCARCITY_LITERAL =
  /\bonly\s+(\d+)\s+(?:left|remaining|spots?|seats?|tickets?|items?|in\s+stock)\b/i;

const SOCIAL_PROOF_LITERAL =
  /\b(\d+)\s+(?:people|others|users|customers|shoppers|members|travellers|travelers)\b[^<>{}]{0,40}?\b(?:viewing|watching|looking|bought|purchased|joined|booked|signed\s+up|are\s+here)\b/i;

/** Engineering counters that read like scarcity but are not addressed to a buyer. */
const NOT_SCARCITY =
  /\b(?:retry|retries|attempts?|tokens?|bytes?|chars?|characters?|quota|budget|timeout|seconds?|minutes?|credits?|slots?|workers?|requests?)\b/i;

const SCARCITY_VOCAB =
  /\b(?:left|remaining|viewing|watching|viewers|stock|bought|purchased|spots?|seats?|shoppers|signed\s+up|recently)\b/i;

/**
 * Urgency invented rather than measured: a stock count or a viewer count that is a
 * hard-coded number, or one produced by `Math.random`.
 *
 * The literal branch only fires on text a person will read (a string literal or a JSX text
 * node), and never when the sentence is plainly about retries, tokens or timeouts.
 */
function detectFabricatedScarcityOrSocialProof(ctx: FileContext): DetectorFinding[] {
  const findings: DetectorFinding[] = [];
  const visible = visibleTextSpans(ctx);
  const seen = new Set<number>();

  const push = (line: number, message: string): void => {
    if (seen.has(line)) return;
    if (!ctx.added.has(line)) return;
    seen.add(line);
    findings.push(finding(ctx, 'fabricated-scarcity-or-social-proof', HONESTY, line, message));
  };

  for (const pattern of [SCARCITY_LITERAL, SOCIAL_PROOF_LITERAL]) {
    const re = new RegExp(pattern.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(ctx.code)) !== null) {
      if (!inSpans(visible, m.index)) continue;
      if (NOT_SCARCITY.test(m[0])) continue;
      const line = ctx.lineAt(m.index);
      if (NOT_SCARCITY.test(lineText(ctx, line))) continue;
      push(
        line,
        `This urgency message uses a hard-coded number ("${m[0].trim()}"), so it says the same thing whatever the real figure is. Show a measured value or drop the claim.`,
      );
    }
  }

  for (let i = 0; i < ctx.lines.length; i += 1) {
    const line = ctx.lines[i] ?? '';
    if (!/Math\.random\s*\(/.test(line)) continue;
    if (!SCARCITY_VOCAB.test(windowText(ctx, i + 1, 1))) continue;
    push(
      i + 1,
      'This scarcity or social-proof number comes from Math.random, so it is invented rather than measured. Use real data or remove the claim.',
    );
  }

  return findings;
}

const PROGRESS_SETTER =
  /\bset(?:Progress|Percent|Percentage|Completion|Complete|Loaded|Value|Bar)\w*\s*\(|\bprogress\s*(?:\+=|=\s*[^=;]*\+)/i;

/** Anything that would tie the bar to work actually happening. */
const REAL_WORK_SIGNAL =
  /\bawait\b|\bfetch\s*\(|\bxhr\b|\bloaded\b|\bbytes\w*\b|\btotal\b|\bresponse\b|\bjob\b|\btask\b|\bstatus\b|\bonProgress\b|\bupload\w*Progress\b|\bevent\.\w+|\bthen\s*\(/i;

const LITERAL_INCREMENT = /\+=\s*\d|\+\s*\d+(?:\.\d+)?\b|\bMath\.random\s*\(/;

/**
 * A progress bar advanced by a clock rather than by work. It tells the person a number
 * that has no relationship to what the machine is doing.
 */
function detectProgressNotBoundToWork(ctx: FileContext): DetectorFinding[] {
  const findings: DetectorFinding[] = [];
  const re = /\bset(?:Interval|Timeout)\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(ctx.code)) !== null) {
    const openParen = ctx.code.indexOf('(', m.index);
    if (openParen === -1) continue;
    const block = balancedSlice(ctx.code, openParen, '(', ')');
    if (!PROGRESS_SETTER.test(block)) continue;
    if (!LITERAL_INCREMENT.test(block)) continue;
    if (REAL_WORK_SIGNAL.test(block)) continue;

    const startLine = ctx.lineAt(m.index);
    const endLine = ctx.lineAt(m.index + block.length);
    if (!ctx.touched(startLine, endLine)) continue;

    findings.push(
      finding(
        ctx,
        'progress-not-bound-to-work',
        HONESTY,
        startLine,
        'This progress indicator is advanced by a timer, not by the work it claims to be reporting, so the number it shows is not true. Drive it from real completion, or show an indeterminate spinner instead.',
      ),
    );
  }

  return findings;
}

// =======================================================================================
// respect-user-attention
// =======================================================================================

const ATTENTION: PrincipleId = 'respect-user-attention';

const SCROLL_FETCH =
  /new\s+IntersectionObserver\s*\(|addEventListener\s*\(\s*['"]scroll|\bonScroll\s*=|\buseInfiniteScroll\b|\buseInfiniteQuery\b|<InfiniteScroll\b/;

const PAGINATION_HINT =
  /\bfetchNext\w*|\bloadMore\w*|\bloadNext\w*|\bfetchMore\w*|\bfetchPage\w*|\bnextPage\b|\bsetPage\s*\(|\bpage\s*\+\s*1/i;

/** Any signal that the list can end, or that the person chose to continue. */
const TERMINUS_SIGNAL =
  /\bhasMore\b|\bhasNextPage\b|\bisLastPage\b|\bendReached\b|\breachedEnd\b|\bnoMore\w*|\ballLoaded\b|\bisEnd\b|\bmaxPages\b|\bMAX_PAGES\b|\bpageLimit\b|\bnextCursor\b|\btotalPages\b|\btotalCount\b|load\s+more|show\s+more|caught\s+up|end\s+of\s+(?:results|list|feed)|no\s+more\s+(?:posts|items|results)/i;

/**
 * A feed that fetches as you scroll and never admits to an end: no end-of-list state, no
 * "load more" control the person presses, no session boundary. The scroll never stops
 * because it was never designed to.
 */
function detectInfiniteScrollNoTerminus(ctx: FileContext): DetectorFinding[] {
  if (!PAGINATION_HINT.test(ctx.code)) return [];
  if (TERMINUS_SIGNAL.test(ctx.code)) return [];

  const re = new RegExp(SCROLL_FETCH.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(ctx.code)) !== null) {
    const line = ctx.lineAt(m.index);
    if (!ctx.added.has(line)) continue;
    return [
      finding(
        ctx,
        'infinite-scroll-no-terminus',
        ATTENTION,
        line,
        'This list fetches more as the person scrolls and has no end state, no load-more control and no page limit, so it never gives them a place to stop. Add an end-of-list message, a limit, or a control they press to continue.',
      ),
    ];
  }
  return [];
}

// =======================================================================================
// protect-dignity-and-safety
// =======================================================================================

const DIGNITY: PrincipleId = 'protect-dignity-and-safety';

const ANALYTICS_CALL =
  /\b(?:analytics|telemetry|tracker|posthog|mixpanel|amplitude|segment|heap|rudder|snowplow)\s*\.\s*(?:track|capture|logEvent|log|record|identify|event)\s*\(|\b(?:trackEvent|logEvent|captureEvent|recordEvent|sendTelemetry|reportEvent|gtag)\s*\(/;

/**
 * Free-text keys. Matching requires the key to END here, so `messageId`, `bodyLength`,
 * `emailHash` and `contentType` all fail. That is the difference between a metric and the
 * thing the person actually wrote.
 */
const FREE_TEXT_KEY = /\b(body|prompt|message|content|email|comment|query|transcript|note)\s*(:|,|\}|$)/;

/**
 * An analytics or telemetry event carrying free text the person wrote. Product analytics
 * is not a place for someone's words to end up.
 */
function detectUserContentInAnalytics(ctx: FileContext): DetectorFinding[] {
  const findings: DetectorFinding[] = [];
  const seen = new Set<string>();
  const callRe = new RegExp(ANALYTICS_CALL.source, 'g');
  let call: RegExpExecArray | null;

  while ((call = callRe.exec(ctx.code)) !== null) {
    const openParen = call.index + call[0].length - 1;
    if (ctx.code[openParen] !== '(') continue;
    const payload = balancedSlice(ctx.code, openParen, '(', ')', 1200);

    const keyRe = new RegExp(FREE_TEXT_KEY.source, 'g');
    let key: RegExpExecArray | null;
    while ((key = keyRe.exec(payload)) !== null) {
      const name = key[1];
      if (name === undefined) continue;
      // `draft.body` is a property READ, not a payload key. Without this, `{ message:
      // err.message }` would be caught by its own second half after the first half was
      // correctly excused.
      if (payload[key.index - 1] === '.') continue;
      if (key[2] === ':') {
        const rest = payload.slice(key.index + key[0].length);
        // A hard-coded label is not the person's words; nor is a thrown error's message.
        if (/^\s*['"`]/.test(rest)) continue;
        if (/^\s*(?:err|error|ex|e)\s*\.\s*message\b/.test(rest)) continue;
      }
      const line = ctx.lineAt(openParen + key.index);
      const dedupe = `${line}:${name}`;
      if (seen.has(dedupe)) continue;
      if (!ctx.added.has(line)) continue;
      seen.add(dedupe);
      findings.push(
        finding(
          ctx,
          'user-content-in-analytics',
          DIGNITY,
          line,
          `This analytics event carries "${name}", which is free text the person wrote. Send a count, a length or an id instead of the content itself.`,
        ),
      );
    }
    callRe.lastIndex = openParen + 1;
  }

  return findings;
}

// =======================================================================================
// Registry
// =======================================================================================

function wrap(
  run: (ctx: FileContext) => DetectorFinding[],
): (input: DetectorInput) => DetectorFinding[] {
  return (input: DetectorInput) => {
    const ctx = buildContext(input);
    return ctx === null ? [] : run(ctx);
  };
}

export const interactiveNoKeyboardPath = wrap(detectInteractiveNoKeyboardPath);
export const meaningfulImageNoAlt = wrap(detectMeaningfulImageNoAlt);
export const stateByColorAlone = wrap(detectStateByColorAlone);
export const consentPrechecked = wrap(detectConsentPrechecked);
export const consentWithdrawalAsymmetry = wrap(detectConsentWithdrawalAsymmetry);
export const fabricatedScarcityOrSocialProof = wrap(detectFabricatedScarcityOrSocialProof);
export const progressNotBoundToWork = wrap(detectProgressNotBoundToWork);
export const infiniteScrollNoTerminus = wrap(detectInfiniteScrollNoTerminus);
export const userContentInAnalytics = wrap(detectUserContentInAnalytics);

interface Registered {
  id: string;
  principle: PrincipleId;
  run: (ctx: FileContext) => DetectorFinding[];
}

const REGISTERED: readonly Registered[] = [
  { id: 'interactive-no-keyboard-path', principle: EQUITY, run: detectInteractiveNoKeyboardPath },
  { id: 'meaningful-image-no-alt', principle: EQUITY, run: detectMeaningfulImageNoAlt },
  { id: 'state-by-color-alone', principle: EQUITY, run: detectStateByColorAlone },
  { id: 'consent-prechecked', principle: CHOICES, run: detectConsentPrechecked },
  {
    id: 'consent-withdrawal-asymmetry',
    principle: CHOICES,
    run: detectConsentWithdrawalAsymmetry,
  },
  {
    id: 'fabricated-scarcity-or-social-proof',
    principle: HONESTY,
    run: detectFabricatedScarcityOrSocialProof,
  },
  { id: 'progress-not-bound-to-work', principle: HONESTY, run: detectProgressNotBoundToWork },
  { id: 'infinite-scroll-no-terminus', principle: ATTENTION, run: detectInfiniteScrollNoTerminus },
  { id: 'user-content-in-analytics', principle: DIGNITY, run: detectUserContentInAnalytics },
];

/** Every detector, addressable by id, with the principle each one evidences. */
export const DETECTORS: readonly Detector[] = REGISTERED.map((d) => ({
  id: d.id,
  principle: d.principle,
  run: wrap(d.run),
}));

export const DETECTOR_IDS: readonly string[] = REGISTERED.map((d) => d.id);

/**
 * Run every detector over a change set. Pure: no I/O, no network, no model calls.
 *
 * Findings are sorted by file, then line, then detector id, so the same diff always
 * produces byte-identical output. A gate whose output reorders between runs cannot be
 * diffed, and an undiffable gate stops being read.
 */
export function runDetectors(files: readonly DetectorInput[]): DetectorFinding[] {
  const findings: DetectorFinding[] = [];

  for (const file of files) {
    const ctx = buildContext(file);
    if (ctx === null) continue;
    for (const detector of REGISTERED) {
      findings.push(...detector.run(ctx));
    }
  }

  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = `${f.file} ${f.line ?? -1} ${f.detectorId} ${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.detectorId.localeCompare(b.detectorId),
  );
}
