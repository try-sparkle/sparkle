/**
 * Level 0 verdicts, computed from the artifact facts `src-tauri/src/fleet.rs` gathers.
 *
 * DIVISION OF LABOUR. Rust observes; this file judges; neither invents a vocabulary that another
 * subsystem already owns. Specifically it does NOT define idle-vs-stalled-vs-thrashing
 * (`engine/agentStall.ts`, `engine/agentThrash.ts`), goal state (`engine/agentGoal.ts`), the status
 * band (`engine/buildSections.ts`) or PR claims — those are owned elsewhere, and a second opinion
 * about the same agent is worse than none. What it owns is the question only artifacts can answer:
 * IS THERE ANY EVIDENCE THIS AGENT IS ALIVE AND MOVING, when no pane is open to watch it.
 *
 * The distinction that makes this worth having: every existing status signal is a statement about
 * what a WATCHER saw. `livenessOf()` reports `unknown` the moment a pane closes; the screen
 * classifier needs a rendered screen; the hook watcher is mounted per-pane. None of them can tell a
 * calm agent from an unobserved one — and `isRedStatus(undefined) === false` means an agent nobody
 * is watching reads exactly like an agent that is fine. Artifacts do not have a point of view: the
 * hook log, the worktree mtime and the branch tip are equally readable whether anyone is looking.
 *
 * WHY THE THRESHOLDS ARE WHAT THEY ARE. On 2026-07-29 the fleet lost 23.6 aggregate agent-hours
 * across 37 stalls longer than two minutes, the worst a single agent sitting 153 minutes mid-task.
 * Two minutes is therefore the first threshold worth naming, not an arbitrary round number.
 *
 * WHY THERE IS NO THRASH CONTRADICTION HERE, THOUGH THERE WAS ONE. A `turns-without-tools`
 * contradiction lived in this file and was removed, because it could not be made honest from what a
 * digest holds. It compared `turnsRecent` against a constant while `toolsRecent` was zero, and:
 *
 * - The counts span a window the CALLER supplies (`fleet_digest`'s `windowMs`, exposed all the way out
 *   to the MCP tool), so any constant is tuned to one window and silently becomes a no-op on a shorter
 *   one — the counts and the bar were not even measured over the same span.
 * - `toolsRecent` counts `PostToolUse`, so an agent mid-long-tool-call reads as zero-tools. Several
 *   queued follow-up prompts during one 20-minute build are therefore indistinguishable, by COUNT,
 *   from a loop of turns that open and close doing nothing.
 * - Three successive threshold values (1, 2, 6) each failed on one side or the other: low ones flagged
 *   healthy agents, and the value high enough to exclude a conversational stretch also excluded the
 *   three-`/compact` incident the detector was named for. Moving the number was never going to fix it;
 *   the count is simply not the discriminating fact.
 *
 * Which is what the DIVISION OF LABOUR paragraph above already said: thrash is `agentThrash.ts`'s,
 * and it has the per-event history — turn open/close times, tool interleaving — that actually
 * separates a loop from a conversation. {@link thrashInputFrom} exists to feed it these facts for an
 * agent with no pane open. A second, worse opinion computed here was the thing to delete, not tune.
 */

/** Mirror of `fleet::HookFacts`. Every field optional-or-zero for the same reason it is in Rust. */
export interface HookFacts {
  lastEvent: string | null;
  lastEventMs: number | null;
  sessionId: string | null;
  transcriptPath: string | null;
  lastTurnEndMs: number | null;
  turnsRecent: number;
  toolsRecent: number;
  compactionsRecent: number;
  recentTools: string[];
  linesScanned: number;
  tailTruncated: boolean;
}

/** Mirror of `fleet::GitFacts`. */
export interface GitFacts {
  ahead: number | null;
  dirtyFiles: number | null;
  lastCommitMs: number | null;
  branch: string | null;
  /**
   * `null` means the `git diff` FAILED — base ref not fetched, a detached or mid-rebase worktree, no
   * merge-base — not that the agent changed nothing. The distinction is load-bearing for the
   * cross-agent conflict detector: treating a failed read as "clean" would report no conflicts
   * fleet-wide with no signal that anything went wrong, which is precisely the silent-zero the
   * module's `None` means WE DID NOT LOOK doctrine exists to prevent.
   */
  changedFiles: string[] | null;
}

/** Mirror of `fleet::FleetAgentFacts`. */
export interface FleetAgentFacts {
  agentId: string;
  worktree: string;
  worktreeExists: boolean;
  hookMtimeMs: number | null;
  hooks: HookFacts;
  git: GitFacts;
  newestWriteMs: number | null;
  walkTruncated: boolean;
  task: string | null;
  resultStatus: string | null;
}

/** Mirror of `fleet::FileConflict`. */
export interface FileConflict {
  path: string;
  agentIds: string[];
}

/** Mirror of `fleet::FleetDigest`. */
export interface FleetDigest {
  generatedAtMs: number;
  windowMs: number;
  agents: FleetAgentFacts[];
  conflicts: FileConflict[];
}

/**
 * How much evidence of life there is, and how fresh.
 *
 * - `advancing` — something moved inside `QUIET_AFTER_MS`: a hook fired, a file was written, a
 *   commit landed. The agent is doing work, whatever the screen looks like.
 * - `quiet` — evidence exists but is older than `QUIET_AFTER_MS`. Not yet alarming: a long build, a
 *   long test run and a human-blocked approval all look like this.
 * - `silent` — nothing has moved for `SILENT_AFTER_MS`. This is the state that cost 23.6 agent-hours
 *   and it is knowable without asking the agent anything.
 * - `unobserved` — no artifact of any kind. Hooks never fired, no worktree, nothing to read. NOT the
 *   same as silent: silent means we looked and saw an agent that stopped moving; unobserved means
 *   there was nothing to look at, which usually means the hooks were never installed.
 */
export type ProgressVerdict = "advancing" | "quiet" | "silent" | "unobserved";

/** First threshold: the PRD's own "stalls longer than two minutes". */
export const QUIET_AFTER_MS = 2 * 60_000;

/**
 * Second threshold. Ten minutes is longer than almost any legitimate single tool call in this repo
 * (the full test suite and a Rust rebuild both fit inside it) and far shorter than the stalls that
 * actually hurt. An agent past this with no artifact movement is not thinking.
 */
export const SILENT_AFTER_MS = 10 * 60_000;


/**
 * A named, observable inconsistency between what the fleet SAYS about an agent and what its
 * artifacts show. Each of these is a bug report about the fleet's own reporting, not about the
 * agent — which is why they are separate from the progress verdict.
 */
export type Contradiction =
  /**
   * The one the founder named, and the one this author demonstrated in person: a row rendered gray
   * (a TERMINAL state — shipped, done, nothing outstanding) while the worktree holds uncommitted
   * work. An agent with uncommitted changes is working or blocked; it is never idle. Gray belongs
   * at the bottom of the list on finished work, and a gray row with dirty files is a lie about the
   * agent's state that sends it to the bottom where nobody looks.
   */
  | "idle-with-uncommitted-work"
  /**
   * No evidence of life while still carrying work that has not landed — uncommitted files or unpushed
   * commits. Distinct from a clean silent agent, which may simply be finished.
   *
   * Raised for a `silent` verdict AND for the `uncertainSilence` case, where a bounded read is the only
   * reason silence could not be established. Both mean "nothing shows this agent is alive and it still
   * holds work"; restricting it to `silent` meant the honest downgrade to `quiet` also erased the
   * contradiction.
   */
  | "silent-with-work-outstanding"
  /**
   * The worktree exists but the hook log does not. Hooks were never installed or never fired, so
   * every hook-derived status for this agent is guesswork and the screen scraper is the only
   * source. Worth surfacing because it silently degrades everything downstream.
   */
  | "hooks-never-fired";

/** What Level 0 concluded about one agent. Facts are carried along so a reader never has to re-fetch. */
export interface FleetVerdict {
  agentId: string;
  progress: ProgressVerdict;
  /** Age of the freshest evidence of life, ms. `null` when there is no evidence at all. */
  evidenceAgeMs: number | null;
  /** Which artifact was freshest — so a reader can say WHY, not just what. */
  evidenceSource: EvidenceSource | null;
  contradictions: Contradiction[];
  /** True when this agent warrants a Level 1 look. The escalation trigger, in one boolean. */
  shouldEscalate: boolean;
  /**
   * True when at least one of the underlying reads hit its own budget — the worktree walk stopped at
   * `WALK_MAX_ENTRIES`/`WALK_MAX_DEPTH`, or the hook tail stopped at its byte cap. Every fact derived
   * from a bounded read is then a LOWER BOUND on freshness and activity, never the whole picture, and
   * a caller that presents such a verdict as complete is doing exactly what a truncated terminal read
   * does: showing a window and calling it the result.
   *
   * This is not an edge case. This repo's own worktree has directories deeper than the walk's depth
   * limit, so a routine pass returns `walkTruncated: true` and `newestWriteMs` becomes dependent on
   * traversal order.
   */
  evidenceIncomplete: boolean;
  /** One-line human-readable justification. Assembled here so every surface says the same thing. */
  reason: string;
}

export type EvidenceSource = "hook-event" | "hook-log-mtime" | "file-write" | "commit";

/** What the caller knows that the artifacts do not: how the fleet is currently rendering this agent. */
export interface VerdictContext {
  /**
   * True when the agent is being shown in a terminal/calm band — gray, done, shipped. Supplied by
   * the caller because the band vocabulary is owned by `engine/buildSections.ts`, not by this file.
   */
  renderedTerminal?: boolean;
  /** True when the agent has an unmet goal. Owned by `engine/agentGoal.ts`; passed in, not derived. */
  hasUnmetGoal?: boolean;
}

/**
 * Freshest artifact evidence and its source.
 *
 * Deliberately takes the MAXIMUM timestamp (the most recent evidence) rather than, say, requiring
 * all signals to agree: any one artifact moving is proof of life, and demanding consensus would
 * report a committing-but-not-tool-using agent as silent.
 *
 * Timestamps in the future are ignored rather than clamped to zero age. Clock skew between the hook
 * emitter's wall clock and ours is real, and a future timestamp treated as "just now" would mask a
 * genuinely dead agent forever — the exact failure this module exists to prevent. `null` (we cannot
 * tell) is the honest answer, and it escalates.
 */
export function freshestEvidence(
  facts: FleetAgentFacts,
  nowMs: number,
): { ageMs: number; source: EvidenceSource } | null {
  const candidates: Array<[number | null, EvidenceSource]> = [
    [facts.hooks.lastEventMs, "hook-event"],
    [facts.hookMtimeMs, "hook-log-mtime"],
    [facts.newestWriteMs, "file-write"],
    [facts.git.lastCommitMs, "commit"],
  ];
  let best: { ageMs: number; source: EvidenceSource } | null = null;
  for (const [ts, source] of candidates) {
    if (ts === null || !Number.isFinite(ts) || ts <= 0) continue;
    if (ts > nowMs) continue;
    const ageMs = nowMs - ts;
    if (best === null || ageMs < best.ageMs) best = { ageMs, source };
  }
  return best;
}

/** Classify freshness into the progress verdict. */
export function progressOf(ageMs: number | null): ProgressVerdict {
  if (ageMs === null) return "unobserved";
  if (ageMs < QUIET_AFTER_MS) return "advancing";
  if (ageMs < SILENT_AFTER_MS) return "quiet";
  return "silent";
}

/** True when the agent still holds work that has not reached `origin`. */
function hasOutstandingWork(facts: FleetAgentFacts): boolean {
  return (facts.git.dirtyFiles ?? 0) > 0 || (facts.git.ahead ?? 0) > 0;
}

/**
 * Every contradiction this agent's artifacts expose, given how the fleet is rendering it.
 *
 * Order is stable (declaration order) so output is diffable across runs.
 */
export function contradictionsOf(
  facts: FleetAgentFacts,
  progress: ProgressVerdict,
  ctx: VerdictContext = {},
  uncertainSilence = false,
): Contradiction[] {
  const found: Contradiction[] = [];

  // Gray is terminal. Uncommitted work means the agent is working or blocked, never done.
  if (ctx.renderedTerminal && (facts.git.dirtyFiles ?? 0) > 0) {
    found.push("idle-with-uncommitted-work");
  }

  // `uncertainSilence` counts here as well as `silent`. An agent whose silence could not be
  // ESTABLISHED because a read hit its budget is still an agent with no evidence of life and work
  // that has not landed — the app-restart-killed worker of AGENTS.md. Gating this on `silent` alone
  // meant the honest downgrade to `quiet` also erased the contradiction, and with it the only thing
  // that put the agent on the escalation shortlist.
  if ((progress === "silent" || uncertainSilence) && hasOutstandingWork(facts)) {
    found.push("silent-with-work-outstanding");
  }


  // A worktree that exists but no readable hook line. EITHER condition is the same failure, which is
  // what the previous `&&` got wrong: an empty-or-unparseable-but-CREATED log (the emitter `mkdirSync`s
  // and appends, so a truncated or failed write leaves a file with a valid mtime and nothing in it) is
  // the likelier real-world shape, and it was never flagged.
  if (facts.worktreeExists && (facts.hooks.linesScanned === 0 || facts.hookMtimeMs === null)) {
    found.push("hooks-never-fired");
  }

  return found;
}

/**
 * The escalation trigger. Level 0 runs continuously and free; when it returns `true` here, the
 * concierge spends a Level 1 read — which is also free. Only if THAT shows the agent needs
 * something does an agent turn get spent.
 *
 * An unmet goal raises the bar deliberately: an agent that has been told what "done" looks like and
 * has gone quiet without reaching it is a different case from one that is merely between tasks.
 */
export function shouldEscalate(
  progress: ProgressVerdict,
  contradictions: Contradiction[],
  ctx: VerdictContext = {},
  uncertainSilence = false,
): boolean {
  if (progress === "silent" || progress === "unobserved") return true;
  if (contradictions.length > 0) return true;
  // DOWNGRADE THE VERDICT, NEVER THE ALARM. When a bounded read is the only reason we did not call
  // this agent silent, "we cannot tell" is the answer — and one screen up, `freshestEvidence`
  // documents that we-cannot-tell escalates. Escalating costs nothing (Level 1 is a free artifact
  // read); NOT escalating drops the agent off `fleetDigest`'s `escalate` shortlist, which is the only
  // actionable output, and hides precisely the agent most worth looking at. An earlier version of
  // this file made exactly that trade and turned an honest verdict into an invisible one.
  if (uncertainSilence) return true;
  if (progress === "quiet" && ctx.hasUnmetGoal === true) return true;
  return false;
}

function describeAge(ageMs: number): string {
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 1) return "under a minute";
  if (mins === 1) return "1 minute";
  return `${mins} minutes`;
}

/** One sentence explaining the verdict, so every surface phrases it identically. */
export function reasonFor(
  facts: FleetAgentFacts,
  progress: ProgressVerdict,
  evidence: { ageMs: number; source: EvidenceSource } | null,
  contradictions: Contradiction[],
  evidenceIncomplete = false,
): string {
  const parts: string[] = [];
  if (evidence === null) {
    parts.push("no artifact of any kind — hooks, worktree writes and commits are all absent");
  } else {
    const age = describeAge(evidence.ageMs);
    const what =
      evidence.source === "commit"
        ? "last commit"
        : evidence.source === "file-write"
          ? "last file write"
          : "last hook event";
    parts.push(`${progress}: ${what} ${age} ago`);
  }
  if ((facts.git.dirtyFiles ?? 0) > 0) {
    const n = facts.git.dirtyFiles ?? 0;
    parts.push(`${n} uncommitted file${n === 1 ? "" : "s"}`);
  }
  if ((facts.git.ahead ?? 0) > 0) parts.push(`${facts.git.ahead} unpushed commit(s)`);
  if (contradictions.length > 0) parts.push(`contradictions: ${contradictions.join(", ")}`);
  // Said last, and said explicitly, because the alternative is a reader who takes a bounded read for
  // a complete one. A verdict that does not admit what it left unread is indistinguishable from a
  // confident one.
  if (evidenceIncomplete) parts.push("reads were bounded, so freshness may be under-reported");
  return parts.join("; ");
}

/** Full Level 0 verdict for one agent. Pure. */
export function verdictFor(
  facts: FleetAgentFacts,
  nowMs: number,
  ctx: VerdictContext = {},
): FleetVerdict {
  const evidenceIncomplete = facts.walkTruncated || facts.hooks.tailTruncated;
  const evidence = freshestEvidence(facts, nowMs);
  let progress = progressOf(evidence?.ageMs ?? null);

  // A TRUNCATED WALK CANNOT ESTABLISH SILENCE. `newestWriteMs` from a bounded walk is the newest write
  // we HAPPENED to reach before the budget ran out, so it is a lower bound on the agent's real
  // freshness — and when it is also the freshest of the four signals, the true newest write may be in
  // the part of the tree we never visited. Calling that `silent` asserts a fact we do not hold, in the
  // one direction that costs something: `silent` is the verdict the whole feature is built to act on.
  //
  // The downgrade is narrow on purpose. It fires only when a truncated walk's file-write IS the
  // deciding evidence; when a hook event or a commit is fresher, that signal is complete and stands.
  // The stall this module was written for reads its hook log, not its worktree, so it is unaffected.
  let uncertainSilence = false;
  if (progress === "silent" && facts.walkTruncated && evidence?.source === "file-write") {
    progress = "quiet";
    uncertainSilence = true;
  }

  const contradictions = contradictionsOf(facts, progress, ctx, uncertainSilence);
  return {
    agentId: facts.agentId,
    progress,
    evidenceAgeMs: evidence?.ageMs ?? null,
    evidenceSource: evidence?.source ?? null,
    contradictions,
    shouldEscalate: shouldEscalate(progress, contradictions, ctx, uncertainSilence),
    evidenceIncomplete,
    reason: reasonFor(facts, progress, evidence, contradictions, evidenceIncomplete),
  };
}

/** Verdicts for a whole digest. `ctxFor` supplies per-agent caller knowledge (band, goal state). */
export function verdictsFor(
  digest: FleetDigest,
  ctxFor: (agentId: string) => VerdictContext = () => ({}),
): FleetVerdict[] {
  return digest.agents.map((facts) => verdictFor(facts, digest.generatedAtMs, ctxFor(facts.agentId)));
}

/**
 * Shape a fact record into the input `engine/agentThrash.ts` reduces.
 *
 * This exists so the thrash reducer can run for an agent with NO PANE OPEN. Its own registry
 * (`noteThrashEvent`) is fed from `AgentPane.tsx`, i.e. only while mounted — which means today an
 * unwatched agent can thrash indefinitely and no reducer ever sees it. Feeding the pure reducer
 * from the hook tail closes that hole without duplicating the reducer.
 */
export function thrashInputFrom(facts: FleetAgentFacts): {
  recentTools: string[];
  turnsWithoutTools: number;
  compactions: number;
} {
  return {
    recentTools: facts.hooks.recentTools,
    // Same reasoning as the `turns-without-tools` contradiction: a bounded tail read cannot establish
    // that no tool ran, so reporting turns as toolless off a truncated read would feed the thrash
    // reducer a number manufactured by our own read limit.
    turnsWithoutTools:
      facts.hooks.toolsRecent === 0 && !facts.hooks.tailTruncated ? facts.hooks.turnsRecent : 0,
    compactions: facts.hooks.compactionsRecent,
  };
}
