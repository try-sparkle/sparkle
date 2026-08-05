// THE SHARED CONTRACT for the merge-collision guardrails — the types the roborev probe, the PR
// claim registry, and the concierge's workflow domain all speak.
//
// WHY THIS FILE EXISTS AT ALL. On 2026-07-29 PR #806 was merged by the concierge on CI-green while
// its owning agent was deliberately holding it for a roborev round it had already drained eleven
// times. Two actors could both merge; neither could see the other's intent or gating criteria. This
// module is the vocabulary that makes both VISIBLE — it is deliberately types-only (no logic, no
// `invoke`) so that the Rust probe, the pure summarizers, and the tool layer are written against one
// definition instead of three compatible-looking ones.
//
// THE ONE DISTINCTION EVERYTHING HERE TURNS ON: "the answer is no" vs "I could not find out".
// `project_open_prs` already learned this the hard way (a confident "no PRs waiting" from a probe
// that merely failed to look). Every optional/nullable field below is nullable for exactly that
// reason, and a consumer that collapses null into a benign default is reintroducing the bug.

// ---------------------------------------------------------------------------------------------
// roborev — the review system this project treats as a required gate
// ---------------------------------------------------------------------------------------------

/**
 * One review job as `roborev list --json` reports it, narrowed to the fields a merge gate needs.
 *
 * Mirrors the Rust `RoborevJobRow` (serde camelCase). The CLI emits far more per row — the full
 * review prompt alone runs to kilobytes — and none of it belongs in a concierge's context, so the
 * Rust side projects the row down to this before it ever crosses the IPC boundary.
 */
export interface RoborevJobRow {
  /** roborev's own job id. This is what a caller names to acknowledge a finding, via `merge_pr`'s
   *  `roborevOverride` — the blocking set must be a SUBSET of the ids acknowledged, and an
   *  in-flight round is never acknowledgeable. That shape is validated where it arrives off the
   *  wire (conciergeTools/workflow.ts), which is the only place that can enforce it. */
  id: number;
  branch: string;
  /** The commit SHA the review was enqueued for. */
  gitRef: string;
  /** `queued` | `running` | `done` | `failed`, per the CLI. Kept as a bare string: an unrecognized
   *  status must be classifiable as "I don't know what this is" rather than crash a merge gate. */
  status: string;
  /**
   * roborev's pass/fail letter: `"P"` (clean) or `"F"` (findings). Null while a job is still
   * queued/running, and null on a job that errored before producing one.
   *
   * NULL IS NOT "PASSING". A done-but-verdictless job is an unread review, and the gate treats it
   * as blocking for the same reason it treats an unreadable probe as blocking.
   */
  verdict: string | null;
  /** Whether a human/agent has resolved this review (`roborev close`). A closed FAIL is a finished
   *  decision — someone judged it — so it does not block. An OPEN fail is backlog nobody read. */
  closed: boolean;
  commitSubject: string | null;
  finishedAt: string | null;
}

/**
 * What the Rust `roborev_branch_probe` command answers. THREE states, not two:
 *
 *   `{ enabled: false }`              — roborev is not in play on this machine (binary absent, or
 *                                       `[tools].roborev` is off). The gate DOES NOT APPLY; merging
 *                                       is not blind, there is simply no second gate to honour.
 *   `{ enabled: true, jobs: null }`   — roborev IS the gate here, and we could not read it (daemon
 *                                       down, non-zero exit, unparseable output, timeout). UNKNOWN,
 *                                       and unknown blocks — this is the whole lesson of #806.
 *   `{ enabled: true, jobs: [...] }`  — authoritative. An EMPTY array means "answered: no reviews
 *                                       exist for this branch", which is a real and different fact.
 */
export interface RoborevProbe {
  enabled: boolean;
  jobs: RoborevJobRow[] | null;
  /** The underlying tool's own words when it failed. Present only to be shown; never parsed. */
  error?: string | null;
}

/**
 * The buckets a branch's review jobs sort into, and the only thing a gate reads.
 *
 * A CLOSED JOB IS IN NO BUCKET AT ALL — not `blocking`, not `errored`, not `inFlight`. `roborev
 * close` IS somebody's judgement ("I read this and it does not stand"), so a closed review is a
 * finished decision rather than backlog, whatever its verdict or status says. Only `total` counts
 * closed rows, because it reports what the probe returned rather than what is outstanding.
 */
export interface RoborevBranchState {
  /** False when roborev is not in play here — the gate is a no-op, not a pass. */
  applicable: boolean;
  /** False when the probe could not answer. `applicable && !known` is the blocking-unknown case. */
  known: boolean;
  /** Queued or running: a round is IN FLIGHT. Never overridable — you cannot acknowledge a verdict
   *  that does not exist yet, which is precisely the state #806 was merged in. */
  inFlight: RoborevJobRow[];
  /** OPEN jobs that ended without a usable verdict (`status: "failed"`, done with a null verdict,
   *  or a status string we have no rule for). Unknown, not clean — an unread review and an
   *  unrecognised one are the same fact to a gate. */
  errored: RoborevJobRow[];
  /** Open (`closed: false`) reviews whose verdict is a FAIL. These are the findings a merge would
   *  bury — the 76-of-120 orphaned-backlog failure, one merge earlier. */
  blocking: RoborevJobRow[];
  /** Open reviews that PASSED. Informational; they do not gate. */
  openPassing: number;
  /** Every job the probe returned, before bucketing. */
  total: number;
  /**
   * The probe's OWN words when it could not answer — a wedged daemon, a non-zero exit, a saturated
   * row window. Carried through because the gate's generic "the daemon may be down" is actively
   * misleading for most of them: a truncated window is a healthy daemon, and sending the reader to
   * debug one wastes the only thing the refusal was supposed to buy them. Null when there is
   * nothing to add.
   */
  error: string | null;
}

/** Severity as roborev's review markdown spells it, plus `unknown` for a finding whose severity
 *  line we could not read. `unknown` sorts as high as `high` on purpose: an unreadable severity is
 *  not a low one. */
export type RoborevSeverity = "high" | "medium" | "low" | "unknown";

/** One finding parsed out of a review's markdown body. `location`/`problem` are best-effort — the
 *  review is prose written by a model, so a field we could not find is null rather than "". */
export interface RoborevFinding {
  severity: RoborevSeverity;
  location: string | null;
  problem: string | null;
}

/** A review job plus the findings parsed from its body. What the concierge's read op returns. */
export interface RoborevJobFindings {
  job: RoborevJobRow;
  /** Null when the review body could not be read at all — distinct from `[]` ("read it; clean"). */
  findings: RoborevFinding[] | null;
}

/** Why a roborev gate said no. Narrow on purpose: a caller must act on the difference between
 *  "wait" (`pending`) and "read these and decide" (`unresolved`) without parsing prose. */
export type RoborevGateCode = "roborev-pending" | "roborev-unresolved" | "roborev-unknown";

export interface RoborevGateVerdict {
  canMerge: boolean;
  /** Null exactly when `canMerge` is true. */
  code: RoborevGateCode | null;
  /** One line, naming the job ids at issue so the caller can go read them. Null when clean. */
  reason: string | null;
  /** The job ids this verdict is about — what a caller would have to acknowledge (when the code
   *  permits acknowledgement at all). Empty when clean. */
  jobIds: number[];
}

// ---------------------------------------------------------------------------------------------
// knightwatch — the review probes a PR must not merge past unanswered
// ---------------------------------------------------------------------------------------------

/**
 * A WRITTEN waiver for a PR carrying unanswered knightwatch `[blocking]` probes.
 *
 * An object with one required field rather than a bare string, for the same reason
 * `roborevOverride` is an object rather than a boolean: the shape is what stops a caller expressing
 * "override" without expressing WHY. Rust validates that the reason costs a sentence and records it
 * on the pull request, so the waiver is attributable to whoever wrote it — a human who typed it into
 * the PR menu, or a model whose words are recorded AS the model's words.
 *
 * NOTHING HERE MAKES A PROBE ANSWERED. The probe is a reviewer's question on the PR and the only
 * thing that answers it is a reply on the PR citing it. This type is the record of a decision to
 * merge anyway; every refusal message that mentions it has to say so, or the override quietly
 * becomes the cheaper path and the gate is worth nothing.
 */
export interface KnightwatchOverride {
  reason: string;
}

// ---------------------------------------------------------------------------------------------
// PR claims — an agent's "I will land this myself", made legible to the concierge
// ---------------------------------------------------------------------------------------------

/**
 * One agent's declared intent to land a PR. Held in the Rust process (one per app launch), so it is
 * visible from every window rather than only the one that happened to answer the bridge.
 *
 * A CLAIM IS A COURTESY, NOT A LOCK. It expires, it can be released by its owner, and it is
 * disregarded once the claiming agent is no longer live — a dead agent must not be able to wedge a
 * PR forever. That constraint is the reason for `expiresAtMs` existing at all.
 */
export interface PrClaim {
  /** The PROJECT root the PR belongs to. Claims are scoped per repo, not globally by number. */
  root: string;
  number: number;
  /** The agent that claimed it. Stamped from the bridge's caller identity, never from the payload. */
  agentId: string;
  /** The agent's own words: what it is waiting on. Shown to the human and to the concierge. */
  note: string | null;
  claimedAtMs: number;
  /** Wall-clock expiry. The registry prunes past this on every read, so an expired claim is never
   *  returned — a consumer still re-checks, because clocks and caches both drift. */
  expiresAtMs: number;
}

/** How a claim reads RIGHT NOW, once expiry and the claimant's liveness are taken into account. */
export type PrClaimStanding =
  /** The claimant is live and the claim has not expired — defer to it. */
  | "live"
  /**
   * Past `expiresAtMs`, but the claimant is STILL LIVE. Blocks, deliberately.
   *
   * This is the state that would otherwise replay #806 on a timer. An agent deep in a long turn —
   * the #806 owner drained eleven roborev rounds in one — issues no tool calls, so it cannot renew;
   * dropping its claim at T+TTL hands the PR to the concierge while the claimant is alive and
   * working. The risk is asymmetric: honouring a stale claim delays a merge, dropping a live one
   * buries findings. `expired` below is the ceiling that stops this from being permanent.
   */
  | "lapsed"
  /** Past `expiresAtMs` by more than `PR_CLAIM_GRACE_SECONDS`, or past it at all with no live
   *  claimant. Information, not a veto — this is the anti-wedge exit. */
  | "expired"
  /** Unexpired, but the claiming agent is not running any more — a dead agent's claim is not a
   *  veto. Distinct from `expired` because the remedy differs: this one is never coming back. */
  | "abandoned"
  /** No claim on this PR at all. */
  | "none";

/** A claim as the concierge sees it: the record, plus the standing it actually carries. */
export interface PrClaimView {
  claim: PrClaim | null;
  standing: PrClaimStanding;
  /** Whether this claim should stop another actor from merging. True for `live` and `lapsed` —
   *  i.e. whenever the claimant is still around. Derived from `standing`, never set by a caller. */
  blocks: boolean;
  /** One line for the human/model, naming the agent and what it said it was waiting on. */
  summary: string;
}

/** Default lifetime of a claim, and the range the registry clamps a caller's request into. Thirty
 *  minutes is deliberately shorter than a long agent turn: an agent that still wants the PR
 *  re-claims (cheap), whereas an over-long claim outlives the agent that made it, which is the
 *  failure mode the expiry exists to prevent. */
/**
 * How long past `expiresAtMs` a claim keeps blocking while its claimant is still live.
 *
 * The anti-wedge ceiling. Without it, an agent tab left open forever would hold a PR forever; with
 * it, the worst case is TTL + this. Generous on purpose — it has to comfortably exceed the longest
 * turn an agent can disappear into, because that turn is exactly when the claim matters most.
 */
export const PR_CLAIM_GRACE_SECONDS = 7200;

export const PR_CLAIM_DEFAULT_TTL_SECONDS = 1800;
export const PR_CLAIM_MIN_TTL_SECONDS = 60;
export const PR_CLAIM_MAX_TTL_SECONDS = 7200;
