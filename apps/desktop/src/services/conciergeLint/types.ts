// The pinned public contract of the concierge reply linter (PRD/sparkle/concierge-reply-linter-core.md,
// plan §5). Types only — no runtime, no React, no stores, no Tauri.
//
// ══ WHY THESE NAMES ARE PINNED ══════════════════════════════════════════════════════════════════
// The linter is built by several people at once: this module owns the core plus three text-only
// checks, and the roster/pill checks (`bare-agent-name`, `bare-pr-number`, `fat-pill-label`,
// `unresolved-agent-pill`) land beside them against THIS file. A rename here is not a refactor, it
// is a merge conflict in someone else's branch. Add fields; do not rename them.
//
// ══ WHY THE POLICY IS DATA AND NOT CODE ═════════════════════════════════════════════════════════
// A check that misfires while its severity is `block` makes the concierge unusable, so the escape
// hatch has to be cheaper than the failure. Severity/enabled/threshold arrive from
// `[concierge.checks]` in `<app_data>/config.toml`, hot-reloaded on `config-changed`, which makes
// disabling a bad check a one-line edit with no rebuild and no restart.

/**
 * The severity vocabulary, as a RUNTIME array so it can be pinned across the language boundary.
 *
 * ══ WHY THIS IS AN ARRAY AND NOT JUST A UNION (roborev 55687, Medium) ═══════════════════════════
 * This list exists three times: here, `config.rs::CONCIERGE_CHECK_SEVERITIES` (which owns it —
 * `[concierge.checks]` is where a user writes it), and `concierge_lint_log::SEVERITIES`. The two
 * Rust copies pin to each other in-crate. THIS was the unpinned one, and it is the copy that
 * crosses a language boundary — the same failure class the `ACTIONS` ↔ `LINT_ACTIONS` pin exists
 * for.
 *
 * The concrete bug that gap allows: add a `critical` tier, and both Rust pins force the author to
 * update both constants, so the suite goes green — while `lintReply` decides `blocked` on
 * `severity === "block"` and skips on `=== "off"`, having never heard of `critical`. A check the
 * user configured at the STRICTEST tier would silently render instead of blocking, and nothing in
 * the tree would fail.
 *
 * A `readonly` array with the union derived from it means Rust's
 * `the_severity_vocabulary_matches_the_typescript_one` can scrape this declaration with the same
 * extractor `LINT_ACTIONS` already uses, and adding a tier on either side fails the suite.
 *
 * The gap was latent when found — nothing builds a `LintPolicy` from the config yet — which is
 * exactly when it is cheap to close.
 */
export const LINT_SEVERITIES = ["block", "warn", "off"] as const;

/**
 * What each severity DOES — the two decisions with teeth, held exhaustively.
 *
 * ══ WHY THIS EXISTS AND THE PINS WERE NOT ENOUGH (roborev 55723, Medium) ════════════════════════
 * The three drift pins make the vocabulary lists agree. They do NOT make the code handle a new tier,
 * and the doc comments claiming otherwise were an overstatement of exactly the kind the review
 * history on this file is about. Walk the real scenario: someone adds `critical` to `config.rs`,
 * `concierge_lint_log::SEVERITIES` and `LINT_SEVERITIES` — which the pins now force — the suite goes
 * green, and `lintReply` still asked `severity === "block"`. A check the user configured at the
 * STRICTEST tier renders. The user-visible failure was untouched; only a type divergence was caught.
 *
 * `satisfies Record<Severity, ...>` moves that decision under exhaustiveness: widening
 * `LINT_SEVERITIES` is now a COMPILE ERROR here, at the site that decides blocking, until someone
 * says what the new tier does. It also gives `Severity` a real runtime consumer, so the derived
 * `(typeof LINT_SEVERITIES)[number]` cannot be quietly re-inlined as a literal union — which would
 * have left the Rust pin guarding an orphan array.
 */
export const SEVERITY_EFFECT = {
  block: { blocks: true, runs: true },
  warn: { blocks: false, runs: true },
  off: { blocks: false, runs: false },
} as const satisfies Record<Severity, { blocks: boolean; runs: boolean }>;

/** Does a violation at this severity force a revision? Unknown severities do not block. */
export function severityBlocks(severity: string): boolean {
  return SEVERITY_EFFECT[severity as Severity]?.blocks ?? false;
}

/** Does a check configured at this severity run at all? An unrecognized tier RUNS — failing open on
 *  running is safe (it can only warn), while failing open on skipping would silently disable it. */
export function severityRuns(severity: string): boolean {
  return SEVERITY_EFFECT[severity as Severity]?.runs ?? true;
}

/** What a fired check does to the turn.
 *
 *  `"off"` is a THIRD state, not a synonym for `enabled: false`: `enabled` is the operator's
 *  switch and `severity: "off"` is the policy author's, and a config that sets one must not be
 *  read as having set the other. {@link LintPolicy} consumers skip a check on either.
 *
 *  Derived from {@link LINT_SEVERITIES} rather than written out, so there is ONE declaration here
 *  for the cross-language pin to hold. */
export type Severity = (typeof LINT_SEVERITIES)[number];

/** One check's policy row. Every field is scalar on purpose: `json_to_toml_value` in `config.rs`
 *  accepts only bool / i64 / String and REJECTS arrays and objects, so a table-per-check of
 *  scalars is writable from the UI through the existing `set_dotted` path. */
export interface CheckPolicy {
  enabled: boolean;
  severity: Severity;
  autofix: boolean;
  /** Check-specific number. Its UNIT is per-check and documented at each check — `restated-state`
   *  reads it as characters of verbatim overlap, `naked-file-ref` as words of explanation. */
  threshold?: number;
  /** Check-specific hand-editable list, comma-separated (`hedge-words` reads it as its words). */
  words?: string;
}

/** The whole linter's policy. `enabled: false` is the master switch — {@link LintPolicy} consumers
 *  must return the reply untouched, not merely downgrade every severity. */
export interface LintPolicy {
  enabled: boolean;
  log: boolean;
  logMatches: boolean;
  /** Keyed by check id (`"hedge-words"`, …). A MISSING key means the check does not run: an older
   *  config must not silently opt into a check shipped after it was written. */
  checks: Record<string, CheckPolicy>;
}

/** One live agent, as the RENDERER sees it. Deliberately the renderer's list and not a second one:
 *  a linter that validates a pill against a different roster than `AgentPill` resolves against can
 *  disagree with the thing it is checking, which is not a check. */
export interface LintRosterAgent {
  id: string;
  name: string;
  projectName?: string;
}

/** One tool call the concierge made THIS turn, with its arguments unredacted and untruncated.
 *  `input` is `unknown` because the shape is per-tool; checks must narrow it themselves. */
export interface LintToolCall {
  name: string;
  input: unknown;
}

/** A tool call this turn that refused or errored. */
export interface LintRefusal {
  domain: string;
  op: string;
  code?: string;
  message?: string;
}

/** Everything a check may read besides the reply text itself. */
export interface LintContext {
  roster: readonly LintRosterAgent[];
  toolCalls: readonly LintToolCall[];
  refusals: readonly LintRefusal[];
  /** The previous concierge reply in this thread, or null when this is the first. */
  prevReply: string | null;
  policy: LintPolicy;
  /** Owning build agent for a PR number. Returning `null` means UNRESOLVED OR AMBIGUOUS and NEVER
   *  a guess — a pill carrying the wrong id opens the wrong agent and the reader cannot tell,
   *  which is strictly worse than the bare number it replaced (`pr_owner.rs`'s discipline). */
  resolvePrOwner?: (prNumber: string) => string | null;
}

/** One finding. `span` is a CHARACTER COUNT of the matched text, never the text — the violation log
 *  records metadata only (`conciergeAudit.ts`'s standing decision against putting concierge prose
 *  on disk). `detail` is a short human-readable reason and is subject to the same rule. */
export interface Violation {
  check: string;
  severity: Severity;
  action: "warned" | "autofixed" | "revised" | "rendered_marked";
  span: number;
  detail: string;
}

/** What `lintReply` hands back. `text` is the reply to render — rewritten if a check autofixed it,
 *  byte-identical to the input otherwise. */
export interface LintResult {
  text: string;
  violations: Violation[];
  blocked: boolean;
}

/** A single check.
 *
 *  `run` is PURE: same `(text, ctx)` in, same result out, no I/O and no mutation of either
 *  argument. That is what lets the whole registry run inside one try/catch per check and lets the
 *  tests be plain function calls with no mocks. */
export interface Check {
  id: string;
  run(text: string, ctx: LintContext): { text: string; violations: Violation[] };
}
