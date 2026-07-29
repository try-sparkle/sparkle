// The roborev half of the merge gate: two thin `invoke` wrappers plus the PURE functions that turn
// a probe into a merge verdict.
//
// WHY THE SPLIT. The decision encoded below is the one that failed on PR #806 — merged on CI-green
// while twelve roborev rounds were open on the branch — so it is the part that must never regress
// silently. Everything from `summarizeRoborev` down is pure and testable with no Tauri host and no
// roborev binary anywhere near the machine; only the two fetchers touch IPC.
//
// The vocabulary (and the reasoning behind each nullable field) lives in `./types`. Read it first.
import { invoke } from "@tauri-apps/api/core";
import type {
  RoborevBranchState,
  RoborevFinding,
  RoborevGateVerdict,
  RoborevJobRow,
  RoborevProbe,
  RoborevSeverity,
} from "./types";

// ---------------------------------------------------------------------------------------------
// Severity ranking
// ---------------------------------------------------------------------------------------------

/**
 * How severities compare. `unknown` ties with `high` DELIBERATELY: a severity line we could not
 * read is not evidence of a low-severity finding, and ranking it below `medium` would let the one
 * finding we understand least sort to the bottom of a list a human skims.
 */
export const ROBOREV_SEVERITY_RANK: Record<RoborevSeverity, number> = {
  high: 3,
  unknown: 3,
  medium: 2,
  low: 1,
};

/** The worst severity present, or null for an empty set. Ties keep the FIRST one seen, so the
 *  order roborev wrote its findings in survives — we are ranking, not re-authoring the review. */
export function highestSeverity(findings: readonly RoborevFinding[]): RoborevSeverity | null {
  let worst: RoborevSeverity | null = null;
  for (const finding of findings) {
    if (worst === null || ROBOREV_SEVERITY_RANK[finding.severity] > ROBOREV_SEVERITY_RANK[worst]) {
      worst = finding.severity;
    }
  }
  return worst;
}

// ---------------------------------------------------------------------------------------------
// IPC wrappers
// ---------------------------------------------------------------------------------------------

/**
 * An error text that means "this build cannot even ASK the question" — the command is not in the
 * Tauri handler table (an older binary), or the invoke was rejected by capability config. Tauri
 * phrases these as "not allowed"/"not found"/"unknown command" depending on version.
 *
 * DELIBERATELY NARROW, because this is the ONE fail-OPEN branch in the module. A bare `not found`
 * anywhere in the text used to match — and "repository not found", "branch not found", "job not
 * found" are all ordinary daemon failures on a branch where roborev very much IS the gate. Each of
 * those would have disabled the gate and merged, which is the #806 outcome this file exists to
 * prevent. The command NAME (or an explicit capability refusal) has to be in the message.
 */
const COMMAND_ABSENT =
  /command [\w.]* ?not (found|allowed)|unknown command|not allowed by (the )?capabilit|missing command/i;

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * A payload that crossed the IPC boundary is not trusted to have the shape we compiled against —
 * an older Rust build is exactly the case this whole gate has to survive. The trap that matters:
 * `jobs` arriving as `undefined` rather than `null` would make `probe.jobs !== null` true and the
 * gate would read a MISSING answer as an authoritative one. So anything we cannot recognise
 * collapses to `jobs: null` (unknown, which blocks), never to `[]` (answered: nothing open).
 */
function normalizeProbe(raw: unknown, fallbackError: string | null): RoborevProbe {
  if (typeof raw !== "object" || raw === null) {
    return { enabled: true, jobs: null, error: fallbackError ?? "roborev probe returned no object" };
  }
  const probe = raw as Partial<RoborevProbe>;
  const error = typeof probe.error === "string" ? probe.error : null;
  // `enabled` DEFAULTS TO TRUE when it is missing or not a boolean, so an unrecognisable payload
  // fails CLOSED like every other unknown here. Reading it as `enabled === true` made a renamed or
  // dropped field yield `enabled: false` → "roborev is not the gate here" → canMerge, i.e. a Rust
  // rename would have silently disabled the gate everywhere with no test failing. Only an explicit
  // `false` turns the gate off.
  const enabled = typeof probe.enabled === "boolean" ? probe.enabled : true;
  return {
    enabled,
    jobs: normalizeJobs(probe.jobs),
    error,
  };
}

/** All-or-nothing on purpose: half a job list is a worse input than no job list, because the
 *  missing half is invisible to the gate while the present half looks authoritative. */
function normalizeJobs(jobs: unknown): RoborevJobRow[] | null {
  if (!Array.isArray(jobs)) return null;
  for (const row of jobs) {
    if (typeof row !== "object" || row === null) return null;
    if (typeof (row as RoborevJobRow).id !== "number") return null;
  }
  return jobs as RoborevJobRow[];
}

/**
 * Read every roborev review job on `branch`. NEVER throws — a merge gate that can be made to throw
 * is a merge gate a caller will wrap in a `catch` that merges anyway.
 *
 * The catch branch makes the one judgement that matters, and the two halves differ for opposite
 * reasons:
 *
 *   - COMMAND ABSENT → `{ enabled: false }`. The build in front of us has no such command, so we
 *     cannot ask the question on ANY branch, ever, in this process. Treating that as blocking would
 *     wedge every merge in the app until the user upgraded — a permanent deadlock traded for a
 *     gate that could never have answered anyway. "We cannot even ask" is "roborev is not the gate
 *     here", which is precisely what `enabled: false` means.
 *   - ANYTHING ELSE → `{ enabled: true, jobs: null }`. The command EXISTS and failed: the daemon is
 *     down, the repo is not registered, the CLI timed out. roborev *is* the gate here and we failed
 *     to read it, so this is UNKNOWN — and unknown blocks. That is the whole lesson of #806.
 */
export async function fetchRoborevProbe(
  root: string,
  branch: string,
  limit?: number,
): Promise<RoborevProbe> {
  try {
    const raw = await invoke("roborev_branch_probe", { root, branch, limit });
    return normalizeProbe(raw, null);
  } catch (err) {
    const error = errorText(err);
    if (COMMAND_ABSENT.test(error)) return { enabled: false, jobs: null, error };
    return { enabled: true, jobs: null, error };
  }
}

/**
 * The review markdown for one job, or null when it could not be read. Best-effort by design: a
 * body we cannot fetch must read as "unread" (null) and not as "clean" (`""`), which is the same
 * null-is-not-a-benign-default rule the probe follows.
 */
export async function fetchRoborevReview(root: string, jobId: number): Promise<string | null> {
  try {
    const body = await invoke("roborev_job_review", { root, jobId });
    return typeof body === "string" ? body : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Pure summarizer
// ---------------------------------------------------------------------------------------------

/**
 * Sort a probe's jobs into the buckets a gate reads. Pure.
 *
 * Two rules carry all the weight here:
 *   - A CLOSED job is out of every bucket. `roborev close` IS someone's judgement; a closed FAIL is
 *     a finished decision, not backlog, and re-raising it would make the gate unclosable.
 *   - Anything that is not a legible PASS lands in `errored`, never in `openPassing`. A `done` job
 *     with a null verdict is an UNREAD review; a status or verdict string we do not recognise is a
 *     question we failed to answer. Both are unknown, and unknown blocks.
 */
export function summarizeRoborev(probe: RoborevProbe): RoborevBranchState {
  const jobs = probe.jobs ?? [];
  const inFlight: RoborevJobRow[] = [];
  const errored: RoborevJobRow[] = [];
  const blocking: RoborevJobRow[] = [];
  let openPassing = 0;

  for (const job of jobs) {
    if (job.closed) continue;
    const status = String(job.status ?? "")
      .trim()
      .toLowerCase();

    if (status === "queued" || status === "running") {
      inFlight.push(job);
      continue;
    }
    if (status !== "done") {
      // `failed`, and equally anything we have no rule for — a status we cannot classify is not a
      // reason to let a merge through.
      errored.push(job);
      continue;
    }

    const verdict = String(job.verdict ?? "")
      .trim()
      .toUpperCase();
    if (verdict === "F") blocking.push(job);
    else if (verdict === "P") openPassing += 1;
    else errored.push(job);
  }

  return {
    applicable: probe.enabled,
    known: probe.jobs !== null,
    inFlight,
    errored,
    blocking,
    openPassing,
    total: jobs.length,
    error: probe.error ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Pure gate
// ---------------------------------------------------------------------------------------------

function idsOf(jobs: readonly RoborevJobRow[]): number[] {
  return jobs.map((job) => job.id);
}

function clean(): RoborevGateVerdict {
  return { canMerge: true, code: null, reason: null, jobIds: [] };
}

/**
 * The gate itself. Pure, and ordered — each step answers a question the next one would get wrong.
 *
 * `acknowledgedJobIds` is the escape hatch from the design doc, and it reaches EXACTLY ONE step
 * (`roborev-unresolved`). It cannot clear `roborev-pending`, because you cannot waive a verdict
 * that does not exist yet — a caller that "acknowledged" an in-flight round has acknowledged
 * nothing, and that is the precise state PR #806 was merged in. It cannot clear `roborev-unknown`
 * either: there is nothing to name.
 */
export function roborevMergeGate(
  state: RoborevBranchState,
  acknowledgedJobIds?: readonly number[],
): RoborevGateVerdict {
  // 1. roborev is not in play here. NOT a pass — there is simply no second gate to honour, and
  //    refusing would block every merge on machines that never had roborev installed.
  if (!state.applicable) return clean();

  // 2. It IS the gate and we could not read it.
  if (!state.known) {
    return {
      canMerge: false,
      code: "roborev-unknown",
      // The probe's own words FIRST when it has any. It knows things this layer does not — that the
      // row window saturated, that the CLI rejected a flag — and a generic "could not be read"
      // discards exactly the detail the reader needs to act.
      reason: state.error
        ? `roborev is the gate on this branch and this reading cannot be trusted: ${state.error}`
        : "roborev is the gate on this branch but its state could not be read — refusing rather than merging blind.",
      jobIds: [],
    };
  }

  // 3. A round is still running. Deliberately BEFORE the acknowledgement check.
  if (state.inFlight.length > 0) {
    const ids = idsOf(state.inFlight);
    return {
      canMerge: false,
      code: "roborev-pending",
      reason: `roborev has ${ids.length} review(s) in flight on this branch (job${ids.length === 1 ? "" : "s"} ${ids.join(", ")}); a verdict that does not exist yet cannot be acknowledged.`,
      jobIds: ids,
    };
  }

  // 4. Jobs that ended without a usable verdict — unread, not clean.
  if (state.errored.length > 0) {
    const ids = idsOf(state.errored);
    return {
      canMerge: false,
      code: "roborev-unknown",
      reason: `roborev job${ids.length === 1 ? "" : "s"} ${ids.join(", ")} ended without a readable verdict; treat as unread, not clean.`,
      jobIds: ids,
    };
  }

  // 5. Open FAILs, minus the ones the caller named. Subtraction, not a boolean: a round that
  //    appeared since the caller read the findings is not covered by what it acknowledged.
  const acknowledged = new Set(acknowledgedJobIds ?? []);
  const unresolved = state.blocking.filter((job) => !acknowledged.has(job.id));
  if (unresolved.length > 0) {
    const ids = idsOf(unresolved);
    return {
      canMerge: false,
      code: "roborev-unresolved",
      reason: `roborev job${ids.length === 1 ? "" : "s"} ${ids.join(", ")} carry open FAIL verdicts that have not been read or acknowledged.`,
      jobIds: ids,
    };
  }

  return clean();
}

// ---------------------------------------------------------------------------------------------
// Pure markdown parser
// ---------------------------------------------------------------------------------------------

// roborev review bodies are prose written by a model against a template, so every part of the
// template is negotiable in practice. The parse is anchored on the `Severity` field line because
// that is the one line every finding has actually carried; `---` rules give a second, coarser
// boundary that still catches a block whose severity line went missing entirely.

/** A markdown thematic break: `---`, `***`, `___`. Notably NOT `- **Severity**: …`, which starts
 *  with `-` but does not repeat it. */
const HORIZONTAL_RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

/** Optional bullet, optional `**bold**` label, colon, value. */
const FIELD_LINE = /^\s{0,3}(?:[-*+]\s+)?(\*\*)?\s*([A-Za-z][A-Za-z ]{0,24}?)\s*(?:\*\*)?\s*:\s*(.*)$/;

/** Labels we accept WITHOUT bold markers. The whitelist exists so that a `Problem:` prose line
 *  running "the cause: a stale ref" is read as prose, not as the start of a new field. */
const FINDING_LABELS = new Set([
  "severity",
  "location",
  "problem",
  "fix",
  "impact",
  "evidence",
  "recommendation",
  "category",
  "file",
  "confidence",
]);

interface FieldLine {
  line: number;
  label: string;
  value: string;
}

/** Tolerant on purpose: `High`, `high`, `HIGH`, `` `Medium` ``, `**Low**`, `Medium (perf)` all
 *  land. Anything else — `Critical`, an empty value, a sentence — is `unknown`, which ranks as
 *  high as `high`. We never guess DOWNWARD from an unreadable severity. */
function parseSeverity(raw: string): RoborevSeverity {
  const word = raw
    .replace(/[`*_]/g, "")
    .split(/[^A-Za-z]+/)
    .filter(Boolean)[0]
    ?.toLowerCase();
  if (word === "high" || word === "medium" || word === "low") return word;
  return "unknown";
}

/** `` `path/to/file.ts:261` `` → `path/to/file.ts:261`. Location is a machine-ish field, so the
 *  decoration comes off; `problem` keeps its markdown because a human reads that one verbatim. */
function cleanInline(value: string): string | null {
  const out = value.replace(/[`*]/g, "").trim();
  return out.length > 0 ? out : null;
}

function buildFinding(
  lines: readonly string[],
  fields: readonly FieldLine[],
  from: number,
  to: number,
  hasSeverityLine: boolean,
): RoborevFinding {
  const own = fields.filter((f) => f.line >= from && f.line < to);
  const severityField = own.find((f) => f.label === "severity");

  const locationField = own.find((f) => f.label === "location");
  const problemField = own.find((f) => f.label === "problem");

  let problem: string | null = null;
  if (problemField) {
    // Problem prose can wrap across lines; it ends at the next field line, at the first blank line
    // (markdown's own paragraph break — this is what stops a trailing `Summary:` from being read
    // as part of the last finding), or at the block's end. Never at a colon inside the prose.
    const next = own.find((f) => f.line > problemField.line);
    const end = next ? next.line : to;
    const parts = [problemField.value];
    for (let i = problemField.line + 1; i < end && i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim().length === 0) break;
      parts.push(line);
    }
    const joined = parts
      .map((p) => p.trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    problem = joined.length > 0 ? joined : null;
  }

  return {
    severity: hasSeverityLine && severityField ? parseSeverity(severityField.value) : "unknown",
    location: locationField ? cleanInline(locationField.value) : null,
    problem,
  };
}

/**
 * Pull findings out of a review body. Pure, and tolerant by construction:
 *   - `No issues found.` (and any other prose with no finding fields in it) → `[]`.
 *   - A block missing Location or Problem yields nulls for those, not a dropped finding.
 *   - A block whose severity is unreadable — or absent altogether — yields `"unknown"`. Swallowing
 *     a finding because we could not grade it would turn the worst-understood finding into no
 *     finding at all, which is the failure this parser exists to avoid.
 */
export function parseRoborevFindings(markdown: string): RoborevFinding[] {
  if (!markdown || markdown.trim().length === 0) return [];

  const lines = markdown.split(/\r?\n/);
  const fields: FieldLine[] = [];
  const rules: number[] = [];

  lines.forEach((raw, i) => {
    if (HORIZONTAL_RULE.test(raw)) {
      rules.push(i);
      return;
    }
    const m = FIELD_LINE.exec(raw);
    if (!m) return;
    const label = (m[2] ?? "").trim().toLowerCase();
    const bold = Boolean(m[1]);
    if (!bold && !FINDING_LABELS.has(label)) return;
    fields.push({ line: i, label, value: m[3] ?? "" });
  });

  if (fields.length === 0) return [];

  const segments: Array<[number, number]> = [];
  let start = 0;
  for (const rule of rules) {
    segments.push([start, rule]);
    start = rule + 1;
  }
  segments.push([start, lines.length]);

  const findings: RoborevFinding[] = [];
  for (const [segStart, segEnd] of segments) {
    const segFields = fields.filter((f) => f.line >= segStart && f.line < segEnd);
    if (segFields.length === 0) continue;

    const severityLines = segFields.filter((f) => f.label === "severity").map((f) => f.line);
    if (severityLines.length === 0) {
      // No severity anywhere in this block. If it still carries finding content, it is a finding
      // we could not grade — emit it as `unknown` rather than lose it.
      if (segFields.some((f) => f.label === "location" || f.label === "problem")) {
        findings.push(buildFinding(lines, fields, segStart, segEnd, false));
      }
      continue;
    }
    for (let k = 0; k < severityLines.length; k++) {
      const from = severityLines[k]!;
      const to = k + 1 < severityLines.length ? severityLines[k + 1]! : segEnd;
      findings.push(buildFinding(lines, fields, from, to, true));
    }
  }
  return findings;
}
