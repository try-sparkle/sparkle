// PTY event classifier (§6.2). Parses Claude Code stdout line by line and assigns a
// risk class. Rules apply in order: dangerous → caution → safe → progress. Returns
// null for lines to discard. Shared by the backend and the desktop terminal-emulator.
//
// SECURITY NOTE: a `risk_class: "safe"` result drives an AUTO-APPROVE gate (approve +
// resume immediately). Two properties therefore matter more than raw recall:
//   1. A SAFE token must NEVER auto-approve a shell-chained line — the segments after
//      `&&`, `||`, `|`, `;`, backticks, or `$(` are unclassified, so a benign leading
//      command (`git add`, `git commit`) can smuggle an arbitrary payload. Such lines
//      fall through to "caution" (queued for a human) instead.
//   2. The prose-prone DANGEROUS heuristics (push→main, deploy→production,
//      drop/delete→table/database) must not fire on Claude's narration ("I won't push
//      to main"), which erodes trust with false-alarm interrupts. They are adjacency-
//      bounded and suppressed when preceded by a negation.
//
// The caller must persist the raw stdout line alongside any emitted event — the
// classifier is retrainable and Claude Code's output format drifts between versions.

import type { ClassifiedEvent } from "./risk";

export interface SessionContext {
  sessionId: string;
  branch?: string;
}

// Only ever inspect a bounded prefix of a line for risk patterns. Claude Code echoes
// long prose/plans; bounding the scan (a) keeps matches() consistent with describe()
// (which truncates to the same length) and (b) stops a greedy pattern from spanning an
// entire paragraph. Matches this to describe()'s truncation length.
const MAX_SCAN = 200;

// --- DANGEROUS: interrupt immediately, require explicit approval ---
// Unambiguous, command-shaped patterns — flagged regardless of surrounding prose.
const DANGEROUS: RegExp[] = [
  /\bdeploy\b[\w\s-]{0,20}?--?prod(?:uction)?\b/i, // `vercel deploy --prod`, `deploy prod`
  /stripe.*charge|create.*payment/i,
  /rm -rf/i,
  /curl.*--upload|POST.*external-api/i,
  /secrets.*write|\.env.*production/i,
];

// Prose-prone DANGEROUS heuristics: a verb…noun pair that also shows up in Claude's
// narration. Treated as dangerous only when it reads as an executed command — i.e. the
// verb is reasonably ADJACENT to the noun (bounded gap, no whitespace-spanning greedy
// match) AND is not preceded by a negation (see NEGATION_BEFORE).
const PROSE_PRONE_DANGEROUS: RegExp[] = [
  // `git push origin main` / `git push -u origin main` — allow up to two intervening
  // tokens (remote, flags) but not a run of prose words ("push a fix so the main …").
  /\bpush\s+(?:[\w/.@:+~^-]+\s+){0,2}(?:main|master)\b/i,
  // `deploying to production` — bounded gap, not the greedy `deploy.*production`.
  /\bdeploy\w*\b[\w\s-]{0,20}?\bproduction\b/i,
  // `DROP TABLE x` (adjacent) / `delete … database` (bounded gap).
  /\bdrop\s+table\b|\bdelete\s+(?:[\w'’-]+\s+){0,2}\bdatabase\b/i,
];

// A negation appearing just before a prose-prone match marks it as narration of
// something NOT being done ("I won't push to main", "we're not going to deploy …").
const NEGATION_BEFORE =
  /\b(?:not|never|no|won['’]?t|wo\s?n['’]?t|do\s?n['’]?t|does\s?n['’]?t|did\s?n['’]?t|cannot|can\s?n['’]?t|can['’]?t|would\s?n['’]?t|should\s?n['’]?t|instead|rather)\b/i;

// --- CAUTION: queue for next app open ---
const CAUTION: RegExp[] = [
  /git push/i,
  /deploy.*staging/i,
  /ALTER TABLE|CREATE TABLE/i,
  // Destructive SQL by its distinctive multi-word syntax — catches `DELETE FROM x`,
  // `TRUNCATE TABLE x`, `INSERT INTO x`, `UPDATE x SET …` issued inside a live psql/mysql
  // session (where there's no client-binary prefix to trip MUTATING_COMMAND). The adjacency
  // (from/into/table, or `<table> set`) is what keeps prose like "Update the README" or
  // "Delete this line" from matching — the bare verbs alone were deliberately NOT used.
  /\b(?:delete\s+from|truncate\s+table|insert\s+into|update\s+\w+\s+set)\b/i,
  /npm publish/i,
  /vercel deploy/i,
  /kubectl apply/i,
];

// --- SAFE: auto-approve, log silently, resume immediately ---
const SAFE: RegExp[] = [
  /mkdir|touch|echo/i,
  /npm install|yarn add|pnpm add/i,
  /npm test|jest|vitest/i,
  /eslint|prettier/i,
  /git add|git commit/i, // commit is safe; push is caution
  /Reading file|Writing file/i,
];

// Shell-chain metacharacters. Their presence means the line runs more than one command
// (or a command substitution), so a leading SAFE token is insufficient to auto-approve.
const SHELL_CHAIN = /&&|\$\(|[|;`]/;

// A leading shell prompt (`$ `, `# `, `> `) marks an actually-executed command line.
const SHELL_PROMPT = /^\s*[$#>]\s+/;

// Commands that mutate state or reach the network. If one leads an otherwise
// unrecognized line, we QUEUE it (caution) rather than silently discarding it — an
// unknown command must never be treated as a no-op. Read-only tools (ls/cat/grep/…)
// are intentionally excluded to keep the human queue low-noise.
// NB: only unambiguous CLI *binaries* belong here. Bare SQL/English verbs (drop, alter,
// truncate, insert, update, delete, create) were deliberately REMOVED — anchored at line
// start they matched ordinary prose narration ("Update the README", "Create a helper",
// "Delete this line") and queued it as caution, reintroducing the false-alarm noise the
// PROSE_PRONE_DANGEROUS work eliminated. Real SQL still reaches the queue via its client
// binary (psql/mysql/mongo) or the CAUTION `ALTER TABLE|CREATE TABLE` patterns.
const MUTATING_COMMAND =
  /^\s*(?:sudo\s+)?(?:git|npm|pnpm|yarn|npx|vercel|netlify|fly|flyctl|heroku|kubectl|helm|docker|podman|terraform|ansible|aws|gcloud|az|psql|mysql|mongo|createdb|dropdb|pg_dump|curl|wget|ssh|scp|rsync|rm|mv|chmod|chown|make|cargo|pip3?|gem|bundle|brew|apt(?:-get)?|yum|dnf|systemctl|service|kill|pkill|stripe)\b/i;

function matches(line: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(line));
}

/** Index of the earliest match across `patterns`, or -1. Used so a queued/interrupt event's
 *  human-readable description can center on the actual trigger when it sits past the scan
 *  window, instead of showing only the leading prose. */
function matchIndex(line: string, patterns: RegExp[]): number {
  let best = -1;
  for (const re of patterns) {
    const m = re.exec(line);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

// SECURITY — this guard FAILS CLOSED, by deliberate design. It gates auto-approve+resume, so a
// missed command chain runs arbitrary code with no human in the loop. We therefore test SHELL_CHAIN
// against the RAW line: ANY chain metacharacter (`&&`, `||`, `|`, `;`, backtick, `$(`), even one
// inside a quoted argument, forces the line to the human queue instead of auto-approving.
//
// We tried the "smarter" alternative — neutralize quoted literals so a metachar inside a commit
// message (`git commit -m "fix: a; b"`) still auto-approves — and it produced TWO separate
// auto-approve BYPASSES (apostrophe-in-double-quotes mis-pairing, then backslash-escaped quotes),
// because faithfully reproducing shell quoting/escaping (`\"`, `$'…'`, nested `$( )`, …) is a
// bottomless lexer no regex/scanner gets right. Over-queuing a commit message whose text contains a
// `;` is a minor, safe UX cost; under-queuing is a security hole. The trade is not close — do not
// reintroduce quote neutralization here.

// True when a hard DANGEROUS pattern matches, or a prose-prone pattern reads as a real
// command rather than narration of something NOT being done.
function isDangerous(line: string, scanned: string): boolean {
  // Hard, unambiguous DANGEROUS patterns scan the FULL line — like CAUTION and the SAFE
  // shell-chain guard — so a token such as `rm -rf` sitting past the 200-char window still
  // interrupts instead of falling through to discard (dangerous must never be weaker than
  // caution). Only the prose-prone heuristics stay bounded to the prefix, since that bound
  // exists precisely to stop them matching across a whole paragraph of narration.
  if (matches(line, DANGEROUS)) return true;
  for (const re of PROSE_PRONE_DANGEROUS) {
    const m = re.exec(scanned);
    if (!m) continue;
    const before = scanned.slice(Math.max(0, m.index - 40), m.index);
    if (!NEGATION_BEFORE.test(before)) return true;
  }
  return false;
}

// Does this line read as an actual command being executed (vs Claude's prose)? Used
// only to decide that an UNRECOGNIZED command should be queued (caution) instead of
// discarded — we never auto-approve on this signal.
function looksLikeCommand(scanned: string): boolean {
  return SHELL_PROMPT.test(scanned) || MUTATING_COMMAND.test(scanned);
}

/** Compress a raw stdout line into a short human-readable description. When the triggering token
 *  sits past the leading window (`focusIndex > MAX_SCAN`), center the snippet on it so the human
 *  sees the actual cause of a flag rather than only the leading prose. */
function describe(line: string, focusIndex = 0): string {
  if (focusIndex <= MAX_SCAN) {
    return line.trim().replace(/\s+/g, " ").slice(0, MAX_SCAN);
  }
  const start = Math.max(0, focusIndex - 32);
  return `…${line.slice(start).trim().replace(/\s+/g, " ").slice(0, MAX_SCAN)}`;
}

export function classifyLine(
  line: string,
  _context: SessionContext,
): ClassifiedEvent | null {
  const description = describe(line);
  if (!description) return null;

  // Match only a bounded prefix so a greedy pattern can't span a whole paragraph and
  // so matching stays consistent with the (equally truncated) description.
  const scanned = line.slice(0, MAX_SCAN);

  if (isDangerous(line, scanned)) {
    return {
      event_type: "approval_needed",
      risk_class: "dangerous",
      description: describe(line, Math.max(0, matchIndex(line, DANGEROUS))),
      payload: { raw: line },
    };
  }
  // CAUTION is scanned against the FULL line (not the bounded prefix) — same as the SAFE
  // shell-chain guard below — so a caution signal (e.g. `git push`) past the scan window
  // can't slip through unqueued. Erring toward queuing is safe; under-queuing is the risk.
  if (matches(line, CAUTION)) {
    return {
      event_type: "approval_needed",
      risk_class: "caution",
      description: describe(line, Math.max(0, matchIndex(line, CAUTION))),
      payload: { raw: line },
    };
  }
  if (matches(scanned, SAFE)) {
    // A SAFE token never auto-approves a shell-chained line: the segments after a chain
    // metacharacter are unclassified, so queue for a human instead. FAIL CLOSED — test the RAW
    // line (see the SECURITY note on SHELL_CHAIN): any metacharacter, even inside a quoted
    // argument, forces the queue. We do NOT try to exempt quoted metachars — that produced two
    // separate auto-approve bypasses.
    if (SHELL_CHAIN.test(line)) {
      return {
        event_type: "approval_needed",
        risk_class: "caution",
        description: describe(line, Math.max(0, matchIndex(line, [SHELL_CHAIN]))),
        payload: { raw: line },
      };
    }
    return {
      event_type: "file_write",
      risk_class: "safe",
      description,
      payload: { raw: line },
    };
  }

  if (line.includes("Task:")) {
    return { event_type: "task_start", risk_class: null, description, payload: {} };
  }
  if (line.includes("Complete:") || line.includes("Done:")) {
    return { event_type: "task_complete", risk_class: null, description, payload: {} };
  }

  // Unrecognized but command-like → queue rather than silently discard/auto-run.
  if (looksLikeCommand(scanned)) {
    return {
      event_type: "approval_needed",
      risk_class: "caution",
      description,
      payload: { raw: line },
    };
  }

  return null; // discard — do not emit
}
