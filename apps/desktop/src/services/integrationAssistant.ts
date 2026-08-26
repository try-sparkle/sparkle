// The integration assistant's frontend seam: the types the Rust side speaks, four thin `invoke`
// wrappers, and the PURE helpers that turn a plan and a set of gate verdicts into what a human is
// allowed to do next.
//
// WHY THE SPLIT. Everything below `IPC wrappers` is pure and testable with no Tauri host, no `gh`
// and no roborev anywhere near the machine. The part that must never regress silently is
// `nextActionable` — the rule that a SEQUENTIAL plan is only safe if it is executed sequentially —
// and it is pure for exactly that reason.
//
// NULLABILITY IS NOT DECORATION. A Rust `Option<T>` crosses serde's wire as an explicit `null`, NOT
// as an absent key (only `skip_serializing_if` omits it). `field?: T` in TypeScript means
// `T | undefined` and EXCLUDES null, so a mirror written that way describes a shape the wire cannot
// produce. Every optional below is `?: T | null`, and every consumer must treat null and absent as
// the same fact.
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------------------------
// The wire types — mirrors of `apps/desktop/src-tauri/src/integration_assistant.rs`
// ---------------------------------------------------------------------------------------------

/** One branch offered to the planner. */
export interface BranchCandidate {
  branch: string;
  /** The open PR for this branch, when it has one. Null when it does not. */
  pr?: number | null;
  agentId?: string | null;
}

/** Two branches whose diffs touch the same files, and every path they share. */
export interface OverlapWarning {
  a: string;
  b: string;
  /** Sorted, so the text is stable between runs. */
  paths: string[];
  /** The ONE canonical sentence for this collision, built on the Rust side. Rendered verbatim: a
   *  log line, a tooltip and a PR comment that each build their own wording drift apart. */
  sentence: string;
}

/** A ready-to-open pull request for a branch that does not have one yet. */
export interface PrDraft {
  title: string;
  body: string;
}

/** One branch's place in the merge order. */
export interface PlannedMerge {
  branch: string;
  pr?: number | null;
  /** 1-based. */
  position: number;
  changedFiles: number;
  /** The other branches in this plan whose diffs it collides with. */
  overlapsWith: string[];
  /** An advisory note about competitors OUTSIDE this queue. Null means the probe did not run or
   *  could not answer — never "no competitor". */
  externalOverlap?: string | null;
  /** The PR this branch would open. Null when it already has one. */
  prDraft?: PrDraft | null;
}

/** A branch that could not be placed, and why. Reported rather than dropped. */
export interface Unplannable {
  branch: string;
  reason: string;
}

export interface MergePlan {
  base: string;
  order: PlannedMerge[];
  warnings: OverlapWarning[];
  unplannable: Unplannable[];
}

/** The three verdicts. Only `ready` may merge; "could not tell" is never ready. */
export const GATE_READY = "ready";
export const GATE_BLOCKED = "blocked";
export const GATE_UNKNOWN = "unknown";

export interface GateReport {
  branch: string;
  pr?: number | null;
  /** `ready` | `blocked` | `unknown`. */
  verdict: string;
  /** Every reason, joined. Null only when the verdict is `ready`. */
  reason?: string | null;
  /** The check state as one word: `pass`, `failed`, `pending`, `unreadable`, `rebase-required`,
   *  `never-ran`, or `unexpected-<code>`. */
  checks: string;
  /** Open reviews carrying a FAIL verdict. NULL means roborev could not be read, or does not apply
   *  here — never zero. Collapsing null into 0 is how a gate merges over unresolved findings. */
  roborevBlocking?: number | null;
  /** The local-check-gate seam's word — `not-run` until bead .1 lands. */
  localGate: string;
}

/** A refusal, and the thing to do instead. The remedy is safe under the same conditions that
 *  produced the refusal — that is asserted on the Rust side, and it is why it can be shown as-is. */
export interface MergeRefusal {
  reason: string;
  remedy: string;
}

export interface MergeOutcome {
  branch: string;
  pr: number;
  /** TRUE only when ancestry proved it. Never the merge command's own claim. */
  landed: boolean;
  refusal?: MergeRefusal | null;
  headSha?: string | null;
  cleanup: string;
}

export interface IntegrationStatus {
  enabled: boolean;
  autoRebase: boolean;
  requireRoborevClean: boolean;
  mergeStrategy: string;
  cleanupAfterMerge: boolean;
  prChecksAvailable: boolean;
  prOverlapAvailable: boolean;
  slug?: string | null;
  mergeProtected: boolean;
  localGate: string;
}

// ---------------------------------------------------------------------------------------------
// IPC wrappers
// ---------------------------------------------------------------------------------------------

export function planIntegration(args: {
  root: string;
  projectId: string;
  base: string;
  candidates: BranchCandidate[];
}): Promise<MergePlan> {
  return invoke<MergePlan>("integration_plan", args);
}

export function gateBranch(args: {
  root: string;
  branch: string;
  pr?: number | null;
}): Promise<GateReport> {
  return invoke<GateReport>("integration_gate", args);
}

export function mergeBranch(args: {
  root: string;
  projectId: string;
  branch: string;
  pr: number;
}): Promise<MergeOutcome> {
  return invoke<MergeOutcome>("integration_merge", args);
}

export function readIntegrationStatus(root: string): Promise<IntegrationStatus> {
  return invoke<IntegrationStatus>("integration_status", { root });
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * Is this gate a pass?
 *
 * ASKED AS A PROPERTY, not as membership of a list of the not-ready words. `verdict !== "blocked"`
 * would silently stop covering the moment a fourth verdict is added, and it would read every
 * unrecognised string as a pass — the exact direction a gate must never fail in.
 */
export function isReady(gate: GateReport | null | undefined): boolean {
  return gate?.verdict === GATE_READY;
}

/** The tone a chip should carry. An unrecognised verdict renders as `unknown`, never as ready. */
export function gateTone(gate: GateReport | null | undefined): "ready" | "blocked" | "unknown" {
  if (gate == null) return "unknown";
  if (gate.verdict === GATE_READY) return "ready";
  if (gate.verdict === GATE_BLOCKED) return "blocked";
  return "unknown";
}

/** What one entry's queue state is, once its gate and its merge outcome are both taken in. */
export interface QueueEntry extends PlannedMerge {
  gate: GateReport | null;
  outcome: MergeOutcome | null;
  /** A command for this entry is in flight. */
  busy: boolean;
}

/**
 * The ONE entry a human may act on right now, or null with the reason nothing is actionable.
 *
 * THE RULE THIS ENCODES: a sequential plan is only safe when it is executed sequentially. Every
 * merge moves the base under everything still queued, so a gate verdict taken on position 3 is
 * evidence about a base that no longer exists once positions 1 and 2 land. Offering a green
 * position 3 while position 1 is unmerged therefore invites exactly the merge the ORDER existed to
 * prevent — and it is the one mistake a queue UI makes by default, because "show me what's green"
 * is the obvious rendering.
 *
 * So: the head of the queue is the only candidate. If it has not been gated, or its gate is not
 * ready, NOTHING is actionable and the caller is told which entry is holding the line.
 */
export function nextActionable(entries: readonly QueueEntry[]): {
  entry: QueueEntry | null;
  reason: string | null;
} {
  const head = entries.find((e) => e.outcome?.landed !== true);
  if (head === undefined) {
    return { entry: null, reason: entries.length === 0 ? "nothing is queued" : null };
  }
  if (head.busy) {
    return { entry: null, reason: `${head.branch} is already running` };
  }
  if (head.gate === null) {
    return { entry: null, reason: `${head.branch} has not been gated yet` };
  }
  if (!isReady(head.gate)) {
    return {
      entry: null,
      reason:
        `${head.branch} is next in the order and its gate says ${head.gate.verdict}` +
        (head.gate.reason ? `: ${head.gate.reason}` : "") +
        ". Nothing behind it can merge first — every merge moves the base under the rest of the queue.",
    };
  }
  return { entry: head, reason: null };
}

/** One line summarizing a queue, for a header. Counts LANDED by ancestry, never by a merge claim. */
export function summarizeQueue(entries: readonly QueueEntry[]): string {
  const landed = entries.filter((e) => e.outcome?.landed === true).length;
  const ready = entries.filter((e) => isReady(e.gate) && e.outcome?.landed !== true).length;
  const blocked = entries.filter((e) => e.gate !== null && !isReady(e.gate)).length;
  const ungated = entries.filter((e) => e.gate === null).length;
  return `${entries.length} queued · ${landed} landed · ${ready} ready · ${blocked} not ready · ${ungated} ungated`;
}
