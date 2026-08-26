// verifyGateStore — the latest verify-before-PR report per agent (bead `.1`).
//
// IN-MEMORY ONLY, AND THAT IS DELIBERATE. The durable copy of every field here lives on disk, in
// the project's `.sparkle/verify-gate/<agentId>.json`, written by Rust. This store is a projection
// of that file — a cache the panel renders from so it does not re-invoke on every keystroke. A
// second persisted copy in the webview's `localStorage` blob could only ever drift from the file
// that is the actual evidence, and the whole feature is about the evidence being checkable. Same
// shape as `previewStore`: plain `create`, no `persist`, an unchanged-value bail in the setter.
//
// KEYED BY agentId, because a report is a fact about one agent's worktree. Two agents on the same
// project have different trees, different branches and different verdicts.
//
// ══ EVERY OPTIONAL FIELD IS `T | null`, NEVER `T | undefined` ═══════════════════════════════════
// serde's derive emits an `Option::None` as the key with an explicit `null` value; it omits the key
// only under `#[serde(skip_serializing_if)]`, which `verify_gate.rs` does not use anywhere. So a
// field written `branch?: string` describes a shape the wire CANNOT PRODUCE. That mistake does not
// fail loudly (bead `sparkle-16y6h`): an all-or-nothing parser rejects the whole payload, falls
// back to its "we did not look" default, and the feature is permanently inert with nothing logged.
// Fixtures must carry `null` too, or they test a case production never produces.
import { create } from "zustand";

/** On-disk shape version. Keep in step with `verify_gate::REPORT_VERSION`. */
export const VERIFY_GATE_REPORT_VERSION = 1;

/**
 * One check's outcome, verbatim from `verify_gate::CheckStatus`.
 *
 * `timeout` AND `not-run` ARE NOT `fail`, AND COLLAPSING THEM IS THE ONE WAY TO GET THIS WRONG.
 * `fail` means the check ran and judged the code. The other two mean it judged nothing — it never
 * started, or it never finished. All three refuse to be a pass, but only `fail` is a reason to go
 * and read a diff. This is the same distinction `scripts/pr-checks.sh` draws between its exit 1
 * ("judged — here is where to look") and its exit 5 ("never ran — stop reading your diff").
 */
export type CheckStatus = "pass" | "fail" | "timeout" | "not-run";

/** The gate's overall answer, verbatim from `verify_gate::Verdict`. */
export type Verdict = "pass" | "fail" | "not-run";

/** How an artifact renders, verbatim from `verify_gate::EvidenceKind`. */
export type EvidenceKind = "image" | "video" | "log" | "file";

/** One check as recorded. Mirrors `verify_gate::CheckResult` field for field. */
export interface CheckResult {
  name: string;
  cmd: string;
  status: CheckStatus;
  /** `null` when the process never produced one (spawn failure, or killed on timeout). */
  exitCode: number | null;
  durationMs: number;
  /** Last lines of combined stdout+stderr. Empty string, never null, when there was no output. */
  tail: string;
  logPath: string | null;
}

/** One agent's last verification run. Mirrors `verify_gate::VerifyGateReport`. */
export interface VerifyGateReport {
  version: number;
  agentId: string;
  worktree: string;
  /** `null` on a detached HEAD or a non-repo — both real states a report can be produced in. */
  branch: string | null;
  checks: CheckResult[];
  verdict: Verdict;
  startedAt: number;
  finishedAt: number;
}

/** One captured artifact. Mirrors `verify_gate::EvidenceItem`. */
export interface EvidenceItem {
  id: string;
  caption: string;
  fileName: string;
  path: string;
  kind: EvidenceKind;
  bytes: number;
  at: number;
  sourcePath: string | null;
}

/** Whether a PR may be opened. Mirrors `verify_gate::PrGateDecision`.
 *
 *  THREE STATES, NOT TWO: `enforced: false` means the gate is switched off for this project, which
 *  is a different fact from "it is on and you are clear". Collapsing them would make an
 *  unconfigured repo indistinguishable from a verified one. */
export interface PrGateDecision {
  allowed: boolean;
  reason: string;
  enforced: boolean;
}

/** The cheap poll answer. Mirrors `verify_gate::VerifyGateStatus`. */
export interface VerifyGateStatus {
  agentId: string;
  running: boolean;
  /** `null` when no report has ever been written for this agent. */
  verdict: Verdict | null;
  checksTotal: number;
  checksPassed: number;
  finishedAt: number | null;
  enabled: boolean;
  prGate: PrGateDecision;
}

/** What the panel needs about one agent: the last report, its evidence, and the live run flag. */
export interface VerifyGateEntry {
  /** `null` until a report has been read or produced. */
  report: VerifyGateReport | null;
  evidence: EvidenceItem[];
  /** True while a run is in flight. Ours, not the wire's — set optimistically on `run()` so the
   *  button disables on click rather than on the next poll. */
  running: boolean;
  /** The last failure of a COMMAND (not of a check): the invoke itself threw. Distinct from a
   *  report whose verdict is `fail`, and rendered differently — "we could not run the gate" is not
   *  "the gate says no". */
  error: string | null;
  /** The gate's own switch for this project, as of the last status read. */
  enabled: boolean;
  /** What the PR gate would say. Defaults to the fail-closed shape until a status has been read —
   *  an unknown gate must never render as "clear to open a PR". */
  prGate: PrGateDecision;
}

/** The fail-closed starting point. Exported so tests and callers seed the same shape the store
 *  does, rather than each inventing an optimistic one. */
export const UNKNOWN_PR_GATE: PrGateDecision = {
  allowed: false,
  reason: "the verification status has not been read yet",
  enforced: true,
};

/**
 * The blank entry — ONE FROZEN INSTANCE, not a fresh object per call, and that is load-bearing.
 *
 * `entryFor` is read inside a zustand selector. A selector that BUILDS an object returns a new
 * reference on every render, zustand's `Object.is` short-circuit never fires, and React re-renders
 * forever — measured here as "Maximum update depth exceeded" on exactly the agents that had no
 * entry yet, i.e. the first-run case the panel exists to handle. A shared constant makes the miss
 * path referentially stable. `Object.freeze` is what keeps that safe: a caller mutating the shared
 * blank would corrupt every future miss, so mutation throws in strict mode instead.
 *
 * `prGate` starts REFUSING: before we have looked, "we could not look" is the honest answer, and it
 * is the same fail-closed direction `verify_gate::fold_verdict` takes.
 */
const EMPTY_ENTRY: VerifyGateEntry = Object.freeze({
  report: null,
  evidence: Object.freeze<EvidenceItem[]>([]) as EvidenceItem[],
  running: false,
  error: null,
  enabled: false,
  prGate: UNKNOWN_PR_GATE,
});

/** The blank entry. See {@link EMPTY_ENTRY} for why this is a shared frozen value. */
export function emptyEntry(): VerifyGateEntry {
  return EMPTY_ENTRY;
}

interface VerifyGateState {
  byAgent: Record<string, VerifyGateEntry>;
  /** Merge a partial update into one agent's entry, creating it if absent. */
  patch: (agentId: string, next: Partial<VerifyGateEntry>) => void;
  /** Fold a `verify_gate_status` reply in. Never clears a report we already hold: status carries a
   *  verdict but not the checks, and dropping the detail on every poll would make the panel flash
   *  empty between ticks. */
  applyStatus: (status: VerifyGateStatus) => void;
  /** Fold a full report + evidence reply in. */
  applyReport: (
    agentId: string,
    report: VerifyGateReport | null,
    evidence: EvidenceItem[],
  ) => void;
  /** Drop one agent's entry (agent closed). */
  forget: (agentId: string) => void;
}

/** Are two entries the same reading? Reference-compares the two arrays' contents by identity-cheap
 *  proxies so a steady-state poll cannot churn subscribers into a re-render loop. */
function sameEntry(a: VerifyGateEntry, b: VerifyGateEntry): boolean {
  return (
    a.report === b.report &&
    a.evidence === b.evidence &&
    a.running === b.running &&
    a.error === b.error &&
    a.enabled === b.enabled &&
    a.prGate.allowed === b.prGate.allowed &&
    a.prGate.enforced === b.prGate.enforced &&
    a.prGate.reason === b.prGate.reason
  );
}

export const useVerifyGateStore = create<VerifyGateState>((set, get) => ({
  byAgent: {},

  patch: (agentId, next) => {
    const prev = get().byAgent[agentId] ?? emptyEntry();
    const merged = { ...prev, ...next };
    if (sameEntry(prev, merged) && get().byAgent[agentId]) return;
    set((s) => ({ byAgent: { ...s.byAgent, [agentId]: merged } }));
  },

  applyStatus: (status) => {
    const prev = get().byAgent[status.agentId] ?? emptyEntry();
    // The verdict on the wire is authoritative over a report we are holding: the file may have been
    // rewritten by another window, or by a run this process did not start. But a status that says
    // `verdict: null` does NOT mean "forget the report" — it means no report exists on disk, which
    // for a store that has one means the file went away, so we drop it too.
    const report =
      status.verdict === null
        ? null
        : prev.report && prev.report.verdict !== status.verdict
          ? { ...prev.report, verdict: status.verdict }
          : prev.report;
    get().patch(status.agentId, {
      running: status.running,
      enabled: status.enabled,
      prGate: status.prGate,
      report,
    });
  },

  applyReport: (agentId, report, evidence) => {
    get().patch(agentId, { report, evidence, error: null });
  },

  forget: (agentId) => {
    if (!get().byAgent[agentId]) return;
    set((s) => {
      const next = { ...s.byAgent };
      delete next[agentId];
      return { byAgent: next };
    });
  },
}));

/** One agent's entry, or a blank one. Never `undefined`, so callers need no null branch.
 *
 *  SAFE INSIDE A SELECTOR, but only because the miss path returns the shared {@link EMPTY_ENTRY}
 *  rather than building one — see there for the render loop that costs. */
export function entryFor(
  state: Pick<VerifyGateState, "byAgent">,
  agentId: string,
): VerifyGateEntry {
  return state.byAgent[agentId] ?? EMPTY_ENTRY;
}

/** Is this a check the reader should go and investigate their own diff over?
 *
 *  FALSE FOR `timeout` AND `not-run`, which is the whole point — see {@link CheckStatus}. A UI that
 *  treated an unspawnable `pnpm` as "your tests failed" would send someone to read a diff that was
 *  never judged. */
export function isJudgedFailure(status: CheckStatus): boolean {
  return status === "fail";
}

/** Did this check reach a verdict about the code at all? */
export function isJudged(status: CheckStatus): boolean {
  return status === "pass" || status === "fail";
}

/** Human label for a status. Words, not emoji — see the founder's no-emoji-icons rule; the panel
 *  pairs these with `react-icons/fi` glyphs. */
export function statusLabel(status: CheckStatus): string {
  switch (status) {
    case "pass":
      return "pass";
    case "fail":
      return "failed";
    case "timeout":
      return "timed out";
    case "not-run":
      return "not run";
  }
}

/** Human label for the overall verdict. */
export function verdictLabel(verdict: Verdict | null): string {
  switch (verdict) {
    case "pass":
      return "Verified";
    case "fail":
      return "Not verified — checks failed";
    case "not-run":
      // Named as an absence rather than a failure. "We could not look" is not "your code is bad".
      return "Not verified — checks did not run";
    default:
      return "Not verified — never run";
  }
}

/** `1234` → `1.2s`; `125000` → `2m 5s`. Mirrors `verify_gate::human_ms` so the panel and the PR
 *  body never disagree about how long a check took. */
export function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const secs = Math.floor(ms / 1000);
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
