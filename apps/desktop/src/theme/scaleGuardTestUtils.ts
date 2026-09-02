// Test-support: failure-message builder for the off-scale ratchet in scale.test.ts.
//
// WHY THIS IS A SEPARATE, TEST-SUPPORT MODULE (the `TestUtils` suffix is load-bearing — the
// dormant-module guard classifies it as test-only, so being imported solely by a test does not
// read as dead production code): the ratchet assertions run against the real source tree, so you
// cannot force them red to check the message they emit. Factoring the message into a pure function
// lets a unit test feed it synthetic hits and assert the CONTENT — specifically that it names the
// FILES each off-scale value came from, not just the distinct values. Before this, a tripped guard
// told you WHICH off-scale values existed but not WHICH FILES held them, so every failure began
// with a manual grep to locate the offending code.
//
// It deliberately holds no `<prop>: <number>` style literals of its own (the prop name is a
// parameter), so the scanner in scale.test.ts — which walks every non-`.test.` source file —
// counts nothing here.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";

export interface OffScaleHit {
  /** Repo-relative path (already sliced to below the theme SRC root by the scanner). */
  file: string;
  value: number;
}

// The most files we spell out for a single value before collapsing the tail to "and N more".
// This is a DISPLAY cap, not silent data loss: the header count is always the true total, and
// every distinct value is still listed with at least its first few files.
const MAX_FILES_PER_VALUE = 6;

// The most distinct IMPORT LINES we print before collapsing the tail. One line per distinct
// relative specifier, so in practice this is 1-3: everything under `components/` shares one.
const MAX_IMPORT_LINES = 4;

/**
 * WHERE THE TOKENS LIVE AND WHAT TO TYPE INSTEAD — the teaching half of a tripped ratchet.
 *
 * WHY THIS EXISTS (bead sparkle-qw9y62). The ratchet's message is, by construction, the ONLY place
 * a newcomer learns these ratchets exist at all: nothing else in the loop mentions them, and the
 * neighbouring files are full of the raw numbers the guard forbids, because ~250 of them predate
 * it. So the message is not a diagnostic, it is the documentation — and a message that names only
 * the token FAMILY ("use TYPE") still leaves the reader to work out which module TYPE comes from,
 * what the relative path is from the file they are standing in, and which step to pick. That is
 * three lookups spent on the one surface guaranteed to be read.
 *
 * Hence: the message prints the literal `import { … } from "…";` line to PASTE, computed for the
 * offending file's own directory, and a concrete replacement expression. Copy-pasteable, not a
 * description of something copy-pasteable.
 */
export interface OffScaleRemedy {
  /** The named exports, exactly as they go inside the braces — e.g. `TYPE`, or `RADIUS, PILL`. */
  named: string;
  /** The token module, as a path relative to the desktop `src` root — e.g. `theme/scale`. */
  module: string;
  /** A concrete replacement for the raw number — e.g. `TYPE.body`. */
  use: string;
  /** Every step available, rendered for picking — e.g. `TYPE.micro=10 TYPE.small=12 …`. */
  steps?: string;
}

/**
 * The exact module specifier to import `module` from, as written INSIDE `file`.
 *
 * Both arguments are paths below the desktop `src` root, the same form the scanner already reports
 * hits in (`components/appChrome.ts`), so this is pure string work with no filesystem access.
 * A generic "import it from the scale module" is not paste-able; `"../theme/scale"` is, and it is
 * different for a file in `components/` than for one in `theme/` or at the root — which is exactly
 * the lookup the reader would otherwise do by hand at the moment they are least inclined to.
 */
export function importSpecifierFor(file: string, module: string): string {
  const clean = file.replace(/^\/+/, "");
  const fromDir = posix.dirname(clean);
  const rel = posix.relative(fromDir, module);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** The paste-me block: one import line per distinct specifier, then what to write. */
function remedyBlock(prop: string, hits: readonly OffScaleHit[], remedy: OffScaleRemedy): string {
  const bySpecifier = new Map<string, string[]>();
  for (const h of hits) {
    const spec = importSpecifierFor(h.file, remedy.module);
    const files = bySpecifier.get(spec) ?? [];
    if (!files.includes(h.file)) files.push(h.file);
    bySpecifier.set(spec, files);
  }
  const entries = [...bySpecifier.entries()];
  const lines = entries.slice(0, MAX_IMPORT_LINES).map(([spec, files]) => {
    const shown = files.slice(0, MAX_FILES_PER_VALUE).join(", ");
    const extra =
      files.length > MAX_FILES_PER_VALUE ? ` and ${files.length - MAX_FILES_PER_VALUE} more` : "";
    return `    import { ${remedy.named} } from "${spec}";   // in ${shown}${extra}`;
  });
  const omitted = entries.length - lines.length;
  if (omitted > 0) lines.push(`    …and ${omitted} more import path(s), one per directory depth.`);
  // NOTE the template literal: this file is SCANNED by the very ratchet it reports for, and a
  // literal `<prop>:` followed by a number anywhere in it — a comment included — would be counted
  // as a violation of the guard it exists to serve. The prop name is always interpolated.
  return (
    `\nPASTE THIS IMPORT, then use the token in place of the raw number:\n` +
    `${lines.join("\n")}\n` +
    `    ${prop}: ${remedy.use}\n` +
    (remedy.steps ? `  every step: ${remedy.steps}\n` : "")
  );
}

/**
 * Build the assertion failure message for one off-scale ratchet.
 *
 * @param prop    the style prop being guarded, e.g. the font-size or corner-radius prop — verbatim.
 * @param advice  the migration guidance clause, e.g. "use TYPE" / "use RADIUS/PILL".
 * @param hits    every off-scale occurrence, each carrying the file it was found in.
 * @param ceiling the recorded ceiling the count is compared against.
 * @param remedy  where the tokens live — REQUIRED, so a caller cannot build a message that names
 *                the problem and withholds the fix. See {@link OffScaleRemedy}.
 */
export function offScaleMessage(
  prop: string,
  advice: string,
  hits: readonly OffScaleHit[],
  ceiling: number,
  remedy: OffScaleRemedy,
): string {
  const byValue = [...new Set(hits.map((h) => h.value))].sort((a, b) => a - b);
  const locations = byValue
    .map((v) => {
      const files = [...new Set(hits.filter((h) => h.value === v).map((h) => h.file))];
      const shown = files.slice(0, MAX_FILES_PER_VALUE).join(", ");
      const extra =
        files.length > MAX_FILES_PER_VALUE ? ` and ${files.length - MAX_FILES_PER_VALUE} more` : "";
      return `${v} → ${shown}${extra}`;
    })
    .join("; ");
  return (
    `${hits.length} off-scale ${prop} values (${byValue.join(", ")}) vs recorded ceiling ${ceiling}. ` +
    `Locations — ${locations}. ` +
    `You added off-scale sprawl — ${advice}. ` +
    `(If you MIGRATED some, this passes; lower the constant to ${hits.length} in this PR to keep the ceiling tight.)` +
    remedyBlock(prop, hits, remedy) +
    `  Run this guard ALONE in ~25-40s, without the 22-minute unit suite:\n` +
    `    bash scripts/design-token-ratchets.sh\n`
  );
}

// ── ATTRIBUTION: WHOSE COMMIT PUT THIS LINE HERE ───────────────────────────────────────────────
//
// The tree-wide ratchets in this repo (labelTreatment's hand-typed-tracking count, linkContrast's
// underlined-link scan, the off-scale counts above) all share one reading problem: a single feature
// commit reddens them, and the failure is then reported against whichever UNRELATED branch runs CI
// next. The message lists every CURRENT hit and marks none of them as NEW, so the agent staring at
// it has to diff the list by hand against the constant's comment history to find the one line its
// own branch added.
//
// So every listed site now carries its introducing commit, and the list is sorted NEWEST FIRST.
// The sort is the half that makes it readable: alphabetical order buries the new entry in the
// middle, while newest-first puts it at the top, and an UNCOMMITTED line — which is exactly what
// the agent who just typed it is looking at — sorts above everything.
//
// TWO NON-NEGOTIABLES, both of which a naive implementation gets wrong:
//
//  1. IT DEGRADES, IT NEVER THROWS. `git blame` fails outside a repo, on a path that does not
//     exist, on an out-of-range line, and in a shallow or grafted checkout. Each of those returns
//     UNATTRIBUTED and the ratchet reports its hit exactly as it did before. A ratchet that
//     CRASHES instead of reporting its finding is strictly worse than one with terse output.
//
//  2. IT COSTS A GREEN RUN NOTHING. These ratchets scan the whole tree; shelling out per hit on
//     the happy path would put hundreds of `git` processes in every suite run. Nothing here is
//     called unless the assertion is ABOUT TO FAIL and the failure message is being built — the
//     call sites guard it with `count > ceiling ? report(...) : ""`, because vitest evaluates the
//     message argument of `expect(actual, message)` EAGERLY. `blameInvocationCount()` is exported
//     so a test can pin that a green scan spawns zero of them.


/** What `git blame` could establish about one line. Every field is empty when it could not. */
export interface BlameAttribution {
  /** Abbreviated commit sha, or "" when unknown / uncommitted. */
  sha: string;
  /** Commit author, or "" when unknown. */
  author: string;
  /** Author date as YYYY-MM-DD, or "" when unknown. */
  date: string;
  /** True when the line is not committed yet — i.e. almost certainly the reader's own edit. */
  uncommitted: boolean;
  /** False when nothing at all could be established; the other fields are then empty. */
  known: boolean;
  /**
   * Sort key, newest-first descending. An uncommitted line sorts ABOVE every commit, and an
   * unattributable one sorts below every commit, so an unreadable checkout degrades to
   * "everything at the bottom" rather than to a scrambled list.
   */
  time: number;
  /** One-line rendering, e.g. `a1b2c3d 2026-08-31 Jane Doe`. "" when nothing is known. */
  label: string;
}

const UNATTRIBUTED: BlameAttribution = {
  sha: "",
  author: "",
  date: "",
  uncommitted: false,
  known: false,
  time: 0,
  label: "",
};

/** Sort key for a line git has not been told about yet — above every real commit. */
const UNCOMMITTED_TIME = Number.MAX_SAFE_INTEGER;

/** What the display prints where an attribution is missing. The API still returns empty fields. */
export const UNATTRIBUTED_LABEL = "(unattributed)";

/** What the display prints for a line the reader has almost certainly just written themselves. */
export const UNCOMMITTED_LABEL = "(uncommitted — yours)";

let gitInvocations = 0;

/** How many `git` processes `blameSite` has spawned in this module instance. */
export function blameInvocationCount(): number {
  return gitInvocations;
}

/** Test seam: reset the counter above. */
export function resetBlameInvocationCount(): void {
  gitInvocations = 0;
}

function porcelainField(out: string, key: string): string {
  // `--line-porcelain` writes one `<key> <value>` header per line; `committer` must not match
  // `author`, hence the anchored key.
  const m = out.match(new RegExp(`^${key} (.*)$`, "m"));
  return m ? m[1]!.trim() : "";
}

const UNCOMMITTED_ATTRIBUTION: BlameAttribution = {
  ...UNATTRIBUTED,
  uncommitted: true,
  known: true,
  time: UNCOMMITTED_TIME,
  label: UNCOMMITTED_LABEL,
};

/** Run a git command for its exit status alone. Throws exactly as execFileSync does. */
function gitQuiet(cwd: string, args: string[]): void {
  gitInvocations += 1;
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 10000,
  });
}

/**
 * True only for a real line of a real file that exists inside a git worktree and is NOT tracked —
 * i.e. a file the reader created and has not committed.
 *
 * Every other shape must come back false, because false means "(unattributed)" and true asserts
 * authorship: a missing file, a line past EOF, a path outside any repo, and a TRACKED file whose
 * blame failed for some other reason (a shallow or grafted checkout) are all genuinely unknown.
 * Only reached once blame has already failed, so it costs a green run nothing.
 */
function untrackedButPresent(abs: string, line: number): boolean {
  let lines: string[];
  try {
    lines = readFileSync(abs, "utf8").split("\n");
  } catch {
    return false;
  }
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (line > lines.length) return false;
  const cwd = dirname(abs);
  try {
    gitQuiet(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return false; // not a git worktree at all
  }
  try {
    gitQuiet(cwd, ["ls-files", "--error-unmatch", "--", abs]);
    return false; // tracked, so blame's failure is a real unknown
  } catch {
    return true;
  }
}

/**
 * Attribute ONE line of ONE file to its introducing commit.
 *
 * Returns {@link UNATTRIBUTED} — never throws — when the file is missing, the line is out of
 * range, the checkout is not a git repo, git is absent, or blame is otherwise unavailable.
 * A line that exists but has never been committed comes back `uncommitted: true`, which is the
 * single most useful answer this can give: it is the line the reader just wrote.
 *
 * @param file absolute or cwd-relative path to blame.
 * @param line 1-based line number.
 */
export function blameSite(file: string, line: number): BlameAttribution {
  if (!Number.isInteger(line) || line < 1) return UNATTRIBUTED;
  const abs = resolve(file);
  let out: string;
  try {
    gitInvocations += 1;
    out = execFileSync(
      "git",
      ["blame", "-L", `${line},${line}`, "--porcelain", "--line-porcelain", "--", abs],
      {
        // Run from the file's own directory so the right worktree is selected without a --git-dir.
        // A directory that does not exist makes execFileSync throw, which the catch handles.
        cwd: dirname(abs),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10000,
        maxBuffer: 1 << 20,
      },
    );
  } catch {
    // A file the reader just CREATED has no index entry, so `git blame` refuses to speak about it
    // at all — and "(unattributed)" is the least useful thing to print about the most attributable
    // line in the list. Resolve that one case, on this failing path only.
    return untrackedButPresent(abs, line) ? UNCOMMITTED_ATTRIBUTION : UNATTRIBUTED;
  }

  const sha = (out.slice(0, 40).match(/^[0-9a-f]{40}$/) ?? [""])[0];
  if (!sha) return UNATTRIBUTED;

  const author = porcelainField(out, "author");
  if (/^0+$/.test(sha)) {
    // The all-zero sha is git's "not committed yet" boundary commit.
    return UNCOMMITTED_ATTRIBUTION;
  }

  const epoch = Number(porcelainField(out, "author-time"));
  const time = Number.isFinite(epoch) && epoch > 0 ? epoch : 0;
  const date = time > 0 ? new Date(time * 1000).toISOString().slice(0, 10) : "";
  const short = sha.slice(0, 7);
  return {
    sha: short,
    author,
    date,
    uncommitted: false,
    known: true,
    time,
    label: [short, date, author].filter(Boolean).join(" "),
  };
}

/** One offending site a ratchet found, before it knows who wrote it. */
export interface GuardSite {
  /** Path as the ratchet already prints it — relative to `root`. */
  file: string;
  /** 1-based line. */
  line: number;
  /** The offending source text, or a sentence describing what is wrong with this element. */
  text: string;
}

export interface AttributedGuardSite extends GuardSite {
  blame: BlameAttribution;
}

/**
 * Attribute every site and return them NEWEST COMMIT FIRST.
 *
 * This is the whole point of the exercise: the entry the current branch added lands at the TOP,
 * where it is read, rather than in the middle of an alphabetical list nobody can diff by eye.
 * Ties keep their input order (Array#sort is stable), so sites from one commit stay grouped in
 * scan order.
 *
 * Spawns one `git` process per site, so call it only while building a failure message.
 */
export function attributeSites(root: string, sites: readonly GuardSite[]): AttributedGuardSite[] {
  return sites
    .map((s) => ({ ...s, blame: blameSite(join(root, s.file), s.line) }))
    .sort((a, b) => b.blame.time - a.blame.time);
}

/**
 * Render a ratchet's failure message: headline, then every site newest-first with its introducing
 * commit, then the remedy.
 *
 * The failure message is the product. AGENTS.md is explicit that it is the one surface guaranteed
 * to be read at the moment of violation, so it spends that surface on sha, date, author, file:line,
 * the offending text, and a sentence saying what to do about it.
 */
export function attributedGuardReport(opts: {
  root: string;
  headline: string;
  remedy: string;
  sites: readonly GuardSite[];
}): string {
  const attributed = attributeSites(opts.root, opts.sites);
  const labelOf = (s: AttributedGuardSite) => s.blame.label || UNATTRIBUTED_LABEL;
  const width = Math.max(0, ...attributed.map((s) => labelOf(s).length));
  const rows = attributed
    .map((s, i) => {
      const n = String(i + 1).padStart(2, " ");
      return `${n}. ${labelOf(s).padEnd(width)}  ${s.file}:${s.line}\n      ${s.text}`;
    })
    .join("\n");
  return (
    `${opts.headline}\n` +
    `NEWEST COMMIT FIRST — the top entry is the most likely cause of this failure; ` +
    `${UNCOMMITTED_LABEL} means the line is not committed yet, so it is almost certainly yours.\n` +
    `${rows}\n` +
    `${opts.remedy}`
  );
}
