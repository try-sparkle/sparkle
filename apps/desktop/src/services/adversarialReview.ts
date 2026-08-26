// adversarialReview — the JS side of the independent diff audit (bead `.4`).
//
// The Rust half (`adversarial_review.rs`) runs a read-only reviewer against a branch diff with none
// of the implementing agent's plan, reasoning or self-report, and answers `ship` /
// `ship-with-notes` / `block` — or `unknown`, which is what its PARSER produces when it could not
// read a verdict at all. This module is the thin wrapper over those three commands, plus the
// normalisation that keeps a malformed payload from being read as approval.
//
// ── `Option<T>` CROSSES THE WIRE AS `null`, NEVER AS AN ABSENT KEY ─────────────────────────────
// serde emits the key with a `null` value for `None`; it omits the key only under
// `skip_serializing_if`. TypeScript's `field?: T` means `T | undefined`, which EXCLUDES `null` — so
// `line?: number` would describe a shape the wire cannot produce, and a fixture matching it would
// test a case that never occurs. Every optional here is `field?: T | null` and every fixture in the
// test carries a literal `null`.
//
// ── AND NOTHING HERE IS ALL-OR-NOTHING ────────────────────────────────────────────────────────
// The failure mode that rule exists to prevent is SILENT: a parser that rejects one field discards
// the WHOLE payload and falls back to its "we did not look" default, so the feature is inert
// permanently, for everyone, with nothing logged. So the normalisers below never throw and never
// return null for a recoverable payload — a bad field degrades to its safe value and the row
// survives. The one value they will not invent is a VERDICT: anything unrecognisable is `unknown`,
// which the default `block_on` treats as blocking.
import { invoke } from "@tauri-apps/api/core";

/** The reviewer's answer, or — for `unknown` — the parser's answer about the reply. */
export type AdversarialVerdictKind = "ship" | "ship-with-notes" | "block" | "unknown";

/** How bad one finding is. `unknown` for a severity nobody anticipated: never silently demoted. */
export type AdversarialSeverity = "high" | "medium" | "low" | "unknown";

/**
 * What a consumer should DO about a branch, as one field. Mirrors Rust `ReviewGate`.
 *
 * `off` the feature is not on for this project and has no opinion; `not-reviewed` nothing has run;
 * `stale` a record exists but describes a different commit; `blocking` the current verdict is in
 * the configured blocking set; `clear` it is not.
 *
 * A merge gate branches on THIS, not on `record.verdict` — the verdict alone cannot tell you that
 * it is about a commit you have since replaced.
 */
export type ReviewGate = "off" | "not-reviewed" | "stale" | "blocking" | "clear";

export interface AdversarialFinding {
  /** Repo-relative, as `git diff --name-only` prints it. Empty when the reviewer omitted it. */
  file: string;
  /** `null` when the finding is about the file as a whole. Rust `Option<u32>` ⇒ an explicit null. */
  line?: number | null;
  severity: AdversarialSeverity;
  /** `correctness` | `security` | `scope` | `style` | `dead-code` | `missing-tests`, or whatever
   *  else the reviewer wrote — kept verbatim rather than normalised to "other". */
  category: string;
  summary: string;
  rationale: string;
}

export interface AdversarialVerdict {
  verdict: AdversarialVerdictKind;
  summary: string;
  /** Always an array — `[]` when empty, never absent. */
  findings: AdversarialFinding[];
  model: string;
  /** Bytes of diff actually SENT (post-truncation). */
  diffBytes: number;
  truncated: boolean;
  /** The commit that was reviewed. Staleness is decided against this. */
  reviewedSha: string;
  branch: string;
  reviewedAtMs: number;
  /** Why the verdict is what it is, when the RUNNER (not the reviewer) had something to say — a
   *  parse failure, a CLI error, an escalation. `null` on a clean parse. */
  note?: string | null;
}

export interface AdversarialReviewStatus {
  enabled: boolean;
  branch: string;
  /** The branch's current head, or `""` when it could not be read. */
  headSha: string;
  /** `null` when nothing has been reviewed for this branch. */
  record?: AdversarialVerdict | null;
  stale: boolean;
  gate: ReviewGate;
  blockOn: string[];
}

const VERDICTS: readonly AdversarialVerdictKind[] = ["ship", "ship-with-notes", "block", "unknown"];
const SEVERITIES: readonly AdversarialSeverity[] = ["high", "medium", "low", "unknown"];
const GATES: readonly ReviewGate[] = ["off", "not-reviewed", "stale", "blocking", "clear"];

/** Worst first. The panel groups by this, and it is also the order a human should read them in. */
export const SEVERITY_ORDER: readonly AdversarialSeverity[] = ["high", "medium", "low", "unknown"];

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/**
 * Read a verdict from the wire. **Anything unrecognised is `unknown`, never `ship`.**
 *
 * This is the JS half of the fail-closed rule, and it has to exist separately from the Rust half:
 * a record can reach here from a file written by a different app version, or hand-edited. A
 * permissive read here would undo the guarantee the backend spends a whole parser establishing.
 */
export function normalizeVerdictKind(v: unknown): AdversarialVerdictKind {
  const s = asString(v).trim().toLowerCase().replace(/[_ ]/g, "-");
  return (VERDICTS as readonly string[]).includes(s) ? (s as AdversarialVerdictKind) : "unknown";
}

/**
 * Read a severity. **The alias table MIRRORS `Severity::parse` in `adversarial_review.rs` and must
 * stay in step with it.**
 *
 * Two implementations of one rule is a hazard, and this one had already drifted once: the Rust side
 * mapped `critical`/`nit`, this side did not, so a `critical` finding arriving from a hand-edited or
 * future-version record rendered as "Unspecified severity" in MUTED ink — a high finding drawn as
 * the mildest thing on screen. Reconciled toward the LENIENT side deliberately, because here
 * strictness moves in the unsafe direction: an unrecognised severity does not withhold anything, it
 * merely under-states a finding a human still has to read.
 */
export function normalizeSeverity(v: unknown): AdversarialSeverity {
  const s = asString(v).trim().toLowerCase();
  if ((SEVERITIES as readonly string[]).includes(s)) return s as AdversarialSeverity;
  if (s === "critical" || s === "blocker") return "high";
  if (s === "moderate" || s === "warning") return "medium";
  if (s === "minor" || s === "nit" || s === "info") return "low";
  return "unknown";
}

/** An unrecognised gate is `not-reviewed`: it withholds approval without claiming a block. */
export function normalizeGate(v: unknown): ReviewGate {
  const s = asString(v).trim().toLowerCase();
  return (GATES as readonly string[]).includes(s) ? (s as ReviewGate) : "not-reviewed";
}

/**
 * Read one finding. NEVER returns null — a row the reviewer bothered to write is a row a human
 * should see, and dropping it makes the review quietly less complete than it claims to be.
 *
 * `line` accepts a number or a numeric string and rejects anything ≤ 0: there is no line 0, so a
 * bogus value is better shown as "no line" than as a wrong location.
 */
export function normalizeFinding(raw: unknown): AdversarialFinding {
  const r = asRecord(raw);
  const rawLine = r.line;
  const n =
    typeof rawLine === "number"
      ? rawLine
      : typeof rawLine === "string" && rawLine.trim() !== ""
        ? Number(rawLine)
        : Number.NaN;
  const line = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  const category = asString(r.category).trim();
  return {
    file: asString(r.file).trim(),
    line,
    severity: normalizeSeverity(r.severity),
    category: category === "" ? "unspecified" : category,
    summary: asString(r.summary).trim(),
    rationale: asString(r.rationale).trim(),
  };
}

/** Read a persisted record, or `null` when there is genuinely none. */
export function normalizeVerdict(raw: unknown): AdversarialVerdict | null {
  if (raw === null || raw === undefined) return null;
  const r = asRecord(raw);
  const findings = Array.isArray(r.findings) ? r.findings.map(normalizeFinding) : [];
  return {
    verdict: normalizeVerdictKind(r.verdict),
    summary: asString(r.summary).trim(),
    findings,
    model: asString(r.model),
    diffBytes: typeof r.diffBytes === "number" ? r.diffBytes : 0,
    truncated: r.truncated === true,
    reviewedSha: asString(r.reviewedSha),
    branch: asString(r.branch),
    reviewedAtMs: typeof r.reviewedAtMs === "number" ? r.reviewedAtMs : 0,
    note: typeof r.note === "string" ? r.note : null,
  };
}

/**
 * Read a status payload.
 *
 * `branch` is passed in rather than trusted from the payload alone, so a reply that lost the field
 * still labels itself with the branch the caller asked about — a panel that renders an empty branch
 * name is indistinguishable from one showing the wrong branch's verdict.
 */
export function normalizeStatus(raw: unknown, branch: string): AdversarialReviewStatus {
  const r = asRecord(raw);
  return {
    enabled: r.enabled === true,
    branch: asString(r.branch, branch) || branch,
    headSha: asString(r.headSha),
    record: normalizeVerdict(r.record ?? null),
    stale: r.stale === true,
    gate: normalizeGate(r.gate),
    blockOn: Array.isArray(r.blockOn) ? r.blockOn.filter((x): x is string => typeof x === "string") : [],
  };
}

/** Findings grouped worst-first, with empty groups omitted. Order is [`SEVERITY_ORDER`]. */
export function groupBySeverity(
  findings: readonly AdversarialFinding[],
): { severity: AdversarialSeverity; findings: AdversarialFinding[] }[] {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    findings: findings.filter((f) => f.severity === severity),
  })).filter((g) => g.findings.length > 0);
}

/**
 * The sentence a surface shows for a gate.
 *
 * Written HERE rather than in the panel so that a second consumer (a merge gate, a badge tooltip)
 * says the same thing — the repo has already paid for two descriptions of one fact drifting apart,
 * and the one on screen is the one that goes wrong.
 */
export function gateSentence(status: AdversarialReviewStatus): string {
  switch (status.gate) {
    case "off":
      return "Adversarial review is off for this project.";
    case "not-reviewed":
      return "This branch has not been reviewed yet.";
    case "stale":
      return "The last review was of a different commit — re-run it before relying on the verdict.";
    case "blocking":
      return "The current verdict is in this project's blocking set.";
    case "clear":
      return "The current verdict does not block.";
  }
}

/** Run a fresh review. Rejects when the feature is off, or when the diff could not be built. */
export async function runAdversarialReview(
  root: string,
  branch: string,
): Promise<AdversarialVerdict> {
  const raw = await invoke("adversarial_review_run", { root, branch });
  const record = normalizeVerdict(raw);
  if (record === null) {
    // A run that answered with nothing is not a run that approved anything.
    throw new Error("the adversarial review returned no record");
  }
  return record;
}

/** The persisted record for a branch, verbatim, or `null`. */
export async function readAdversarialVerdict(
  root: string,
  branch: string,
): Promise<AdversarialVerdict | null> {
  return normalizeVerdict(await invoke("adversarial_review_verdict", { root, branch }));
}

/** The derived read — record + staleness + gate. This is what a merge gate should consume. */
export async function readAdversarialStatus(
  root: string,
  branch: string,
): Promise<AdversarialReviewStatus> {
  return normalizeStatus(await invoke("adversarial_review_status", { root, branch }), branch);
}
