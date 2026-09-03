// epicStaffing — EPIC-COMPLETE IS THE UNIT FOR STAFFING, asked at the moment an agent LEAVES.
//
// ── THE MEASURED FAILURE (bead `sparkle-hrzitj`, failure 5, verbatim) ────────────────────────────
// "AGENT-GOAL-MET IS NOT EPIC-COMPLETE. Retiring an agent whose single goal was met silently
// unstaffed epics with 57, 39 and 3 open children. Nothing noticed until the pusher escalated them
// to the founder as 'Blocked'."
//
// An agent's goal and its epic are different units of work. `set_agent_goal_met` and `retire_agent`
// both answer the AGENT question — "is this one finished?" — and both were correct every time. The
// epic question, "is the WORK finished?", was asked by nobody at that moment, so an orchestrator
// walking away from 57 open children produced the same silence as one walking away from none.
//
// ── WHAT THIS MODULE DOES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────────
// It asks the epic question at the release seam and RECORDS the answer. It does NOT gate the
// release: the agent genuinely finished its goal, and refusing a truthful `set_agent_goal_met` would
// trade a silent unstaffed epic for a stuck agent — a worse bug wearing a louder shirt. Requirement
// 2 of the spec is explicit about this, and every entry point below returns an outcome and swallows
// its own failures for exactly that reason.
//
// ── IT INVENTS NO STAFFING RULE AND NO CHILD COUNT ───────────────────────────────────────────────
//   • "Which build agents are bound to this epic" is `epicSweepRunner.boundAgentsFor` — THE one
//     definition, shared with the sweep's watch gate and the pusher's three-alarm count.
//   • "Is a bound orchestrator actually staffing it" is `engine/orchestratorLiveness`'s
//     `orchestratorLivenessOf` folded by `epicOrchestratorLiveness` — the same join
//     `epicSweepRunner.candidateFor` uses, including the `goalQuiet` witness that reads a
//     goal-met agent as NOT staffing (bead `sparkle-70cu4y`).
//   • "How many children are still open" is `beads.openChildCount` — the resolver file, the only
//     place the parent-child edge may be stated (`scripts/lib/epic-membership-guard.sh`).
// A second copy of any of those would be a second answer, and this repo ranks that as worse than
// none.
//
// ── FAIL CLOSED, IN THE SAME DIRECTION `improveNudge.boardReadable` ALREADY FAILS ────────────────
// An unreadable board is not an empty one. Every "we could not tell" path here RECORDS the epic as
// possibly-unstaffed rather than dropping it, because the alternative is the exact false absence
// that made the never-idle watcher silent: `unstaffedBuildableEpicCount: 0` is the positive claim
// "every buildable epic is staffed", which an unread board cannot make (bead `sparkle-hrzitj`, and
// the `boardReadable` gate that landed for it).
//
// ── THE LEDGER IS SELF-HEALING, BECAUSE A STALE READING PRESENTED AS A FACT IS FAILURE 2 ─────────
// A record says "at time T, agent A left epic E, which had N open children and nobody else on it".
// That is a fact about T and stops being true the moment somebody picks the epic up. So the epic
// sweep clears a record whenever it observes the epic staffed again or out of open children
// (`epicSweepRunner.reconcileEpicStaffingRecords`), and the record carries `at` so any reader can
// say when it was measured.
import { openChildCount, type Bead } from "./beads";
import {
  epicOrchestratorLiveness,
  orchestratorLivenessOf,
  goalIsQuiet,
} from "../engine/orchestratorLiveness";
import { goalStateOf } from "../engine/agentGoal";
import type { AgentTabStatus } from "@sparkle/ui";
import type { ObservedVerdict } from "../engine/observedAttention";
import type { AgentTab } from "../types";
import { log } from "../logger";

/** Why an agent stopped carrying its epic. Both are the SAME fact for staffing purposes — nobody is
 *  on the epic any more — and they are kept apart only so the record can say what happened. */
export type EpicReleaseCause = "goal-met" | "retired";

/** An epic that lost its orchestrator and still has work in it. One per epic; a second release
 *  against the same epic overwrites, because the newest reading is the one worth acting on. */
export interface EpicStaffingRecord {
  epicId: string;
  /**
   * WHICH PROJECT the epic belongs to — and it is load-bearing, not bookkeeping (roborev 79589).
   *
   * The ledger is FLEET-WIDE (`locate` scans every project), while the alarm that reads it is
   * scoped to one board. Without this field there is nothing to join on, so a release in ANY other
   * project raised the Improve Sparkle three-alarm fire about an epic that is not in its project
   * and that it cannot see — and never self-cleared, because the retraction only fires when that
   * epic is restaffed or drained. A false alarm nobody can act on is the loud-direction failure
   * this whole bead is about.
   */
  projectId: string;
  /**
   * `unstaffed` — the roster and the board were both read, nobody else is staffing it, and it has
   * open children. `could-not-tell` — one of those readings failed, so this epic is POSSIBLY
   * unstaffed and is surfaced anyway. There is deliberately no `staffed` record: an epic somebody
   * else is carrying needs no entry.
   */
  state: "unstaffed" | "could-not-tell";
  /** Open children at the moment of release, or `null` when the board could not be read. */
  openChildren: number | null;
  /** The agent that left. Kept so a reader can say WHO, and so a re-release is attributable. */
  releasedAgentId: string;
  cause: EpicReleaseCause;
  /** When this was measured. Every claim carries its age — requirement B of the same bead. */
  at: number;
  /** One short clause naming which reading produced the verdict. */
  why: string;
}

/** What {@link decideEpicStaffingOnRelease} answers. Only the last two produce a record. */
export type EpicStaffingOutcome =
  /** The released agent was not bound to any epic — nothing to say. */
  | { kind: "not-bound" }
  /** Bound, but the epic has no open children left: the WORK finished with the agent. */
  | { kind: "epic-complete"; epicId: string; openChildren: number }
  /** Bound, and another orchestrator is still carrying it. This is the "restaffed" arm. */
  | { kind: "still-staffed"; epicId: string }
  | { kind: "unstaffed"; record: EpicStaffingRecord }
  | { kind: "could-not-tell"; record: EpicStaffingRecord };

/** Everything the decision needs, already read. Pure in, pure out — no store, no clock. */
export interface EpicReleaseReading {
  releasedAgentId: string;
  /** Which project the leaving agent belonged to — carried onto the record so a per-board reader
   *  can filter. See {@link EpicStaffingRecord.projectId} for what goes wrong without it. */
  projectId: string;
  cause: EpicReleaseCause;
  /** The epic the leaving agent was bound to, or `undefined` for an agent bound to none. */
  epicId: string | undefined;
  /**
   * Open children of that epic, or `null` when the board could not be read.
   *
   * ⚠️ `null`, NEVER `0`, for an unread board. `0` is the positive claim "this epic has no work
   * left", which is precisely what an absent snapshot cannot assert — the false absence that made
   * the never-idle watcher silent.
   */
  openChildren: number | null;
  /**
   * Is anyone ELSE still staffing the epic? `true` staffed, `false` read-and-nobody, `null` could
   * not be established. Folded by {@link epicOrchestratorLiveness} over the OTHER bound agents, so
   * the leaving agent never counts as its own successor.
   */
  otherStaffing: boolean | null;
  at: number;
}

/**
 * The whole rule, in one pure function.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. Staffing is read before the child count because a live
 * successor makes the epic staffed whatever the board says — including when the board is
 * unreadable, where inventing a `could-not-tell` alarm for an epic somebody is demonstrably
 * building would be a false three-alarm fire. After that, the fail-closed direction takes over:
 * an unknown successor (`null`) and an unreadable child count both surface.
 */
export function decideEpicStaffingOnRelease(r: EpicReleaseReading): EpicStaffingOutcome {
  if (r.epicId === undefined) return { kind: "not-bound" };
  const epicId = r.epicId;
  if (r.otherStaffing === true) return { kind: "still-staffed", epicId };
  const base = {
    epicId,
    projectId: r.projectId,
    releasedAgentId: r.releasedAgentId,
    cause: r.cause,
    at: r.at,
  };
  if (r.otherStaffing === null) {
    return {
      kind: "could-not-tell",
      record: {
        ...base,
        state: "could-not-tell",
        openChildren: r.openChildren,
        why: "could not establish whether any other orchestrator is on this epic",
      },
    };
  }
  if (r.openChildren === null) {
    return {
      kind: "could-not-tell",
      record: {
        ...base,
        state: "could-not-tell",
        openChildren: null,
        why: "the board could not be read, so the open-child count is unknown",
      },
    };
  }
  if (r.openChildren <= 0) return { kind: "epic-complete", epicId, openChildren: r.openChildren };
  return {
    kind: "unstaffed",
    record: {
      ...base,
      state: "unstaffed",
      openChildren: r.openChildren,
      why: `no other orchestrator is bound to it and ${r.openChildren} child(ren) are still open`,
    },
  };
}

/** The sentence a human or an agent reads. The count is the point — "unstaffed" alone is a label,
 *  "57 open children" is a reason to act. */
export function describeEpicStaffingRecord(rec: EpicStaffingRecord): string {
  const kids =
    rec.openChildren === null
      ? "open children UNKNOWN — the board could not be read"
      : `${rec.openChildren} open children`;
  const verb = rec.state === "unstaffed" ? "is now UNSTAFFED" : "MAY now be unstaffed";
  return `epic ${rec.epicId} ${verb} (${kids}) after ${rec.releasedAgentId} ${rec.cause}: ${rec.why}`;
}

// ── THE LEDGER ───────────────────────────────────────────────────────────────────────────────────
// Module state, deliberately: this is a fact about THIS window's observation of a release, exactly
// like `goalContinuationRunner`'s idle clock, and it must not be persisted — a record that outlived
// a relaunch would be a reading nobody can refresh, which is failure 2 of the same bead.

const ledger = new Map<string, EpicStaffingRecord>();

/** Every epic currently recorded as unstaffed-or-possibly-unstaffed, newest reading per epic. */
export function epicStaffingRecords(): readonly EpicStaffingRecord[] {
  return [...ledger.values()];
}

/**
 * The alarm input, shaped for the `unstaffed-epic-alarm` nudge (`services/improveNudge`).
 *
 * ⚠️ `count` INCLUDES the `could-not-tell` epics, and that is the whole fail-closed point: an epic
 * we could not read is surfaced, never assumed staffed. The two id lists are kept apart so the
 * message can say which is which — a reader must be able to tell a measured alarm from a hedge.
 *
 * COMPOSE, DO NOT REPLACE. `pusherMount.improveUnstaffedEpics` counts epics that are unstaffed RIGHT
 * NOW from the board; this counts epics observed going unstaffed AT A RELEASE. The board-derived
 * count misses exactly the window this exists for — an epic whose orchestrator has just left and
 * whose `in_progress` status or child index has not been re-read yet.
 */
export function unstaffedEpicsFromReleases(projectId?: string): {
  epicIds: string[];
  couldNotTellEpicIds: string[];
  count: number;
} {
  const epicIds: string[] = [];
  const couldNotTellEpicIds: string[] = [];
  for (const rec of ledger.values()) {
    // SCOPE FIRST (roborev 79589). Omitting the filter is the fleet-wide read and stays available
    // for a fleet-wide surface; every caller that folds this into a per-board count must pass one,
    // or it reports another project's epic as that board's emergency.
    if (projectId !== undefined && rec.projectId !== projectId) continue;
    if (rec.state === "unstaffed") epicIds.push(rec.epicId);
    else couldNotTellEpicIds.push(rec.epicId);
  }
  epicIds.sort();
  couldNotTellEpicIds.sort();
  return { epicIds, couldNotTellEpicIds, count: epicIds.length + couldNotTellEpicIds.length };
}

/**
 * THE ONE-LINE COMPOSITION for `pusherMount.improveUnstaffedEpics` — fold this ledger into the
 * board-derived three-alarm count without either reader losing what it knows.
 *
 * ⚠️ `null` WINS, AND THAT IS NOT A ROUNDING OF THE RULE. `null` from the board reader means the
 * snapshot could not be read, and `improveNudge` carries that fact on `boardReadable`, which nudges
 * on its own arm. Replacing it with a number here would assert a board we never read — the exact
 * false claim bead `sparkle-hrzitj` records — and would silence the unreadable arm at the same time.
 * Nothing is lost: an unreadable board already nudges.
 *
 * ⚠️ MAX, NOT SUM. The two populations OVERLAP — an epic that is `in_progress` with children and
 * whose orchestrator just left is counted by both — and the board reader hands over a COUNT with no
 * ids, so there is no join available to dedupe with. A sum would inflate a number a human reads as
 * "how many epics are on fire". Max can understate the magnitude and can never understate the
 * ALARM: whenever this ledger holds anything, the result is at least 1, so the `> 0` gate the nudge
 * actually fires on is reached from either side.
 */
export function mergeUnstaffedEpicCount(
  boardCount: number | null,
  release: { count: number },
): number | null {
  if (boardCount === null) return null;
  return Math.max(boardCount, release.count);
}

/** Put a record in the ledger. Exported for the seams and for the sweep's own re-reads. */
export function recordEpicStaffing(rec: EpicStaffingRecord): void {
  ledger.set(rec.epicId, rec);
}

/**
 * Retract a record — the epic is staffed again, or its work is done.
 *
 * Returns whether anything was cleared, so a caller can log the retraction rather than clearing
 * silently. A record nobody retracts becomes a stale reading asserted as a present-tense fact,
 * which is the other half of this bead.
 */
export function clearEpicStaffingRecord(epicId: string): boolean {
  return ledger.delete(epicId);
}

/** TESTS ONLY — module state shared across a file's tests is the classic order-dependent suite. */
export function resetEpicStaffingLedger(): void {
  ledger.clear();
}

// ── THE MOUNT ────────────────────────────────────────────────────────────────────────────────────

/** The per-agent artifact readings the liveness join needs — the SAME shape
 *  `epicSweepRunner.candidateFor` takes, so the two cannot drift about what "staffing" means. */
export interface EpicStaffingStaffingReaders {
  aliveFor: (agentId: string) => boolean | undefined;
  statusFor: (agentId: string) => AgentTabStatus | undefined;
  attentionFor: (agentId: string) => ObservedVerdict | undefined;
  deathRecordedFor: (agentId: string) => boolean;
  lastHookEventFor: (agentId: string) => number | null | undefined;
}

export interface EpicStaffingDeps extends EpicStaffingStaffingReaders {
  /**
   * THE ONE DEFINITION of "which build agents are bound to this epic", injected rather than
   * re-stated: production passes `epicSweepRunner.boundAgentsFor` (see
   * `epicSweepRunner.buildEpicStaffingDeps`). It is a dependency instead of an import so the module
   * graph stays one-directional — the sweep imports this module to retract records, and a second
   * edge back would make a cycle out of two files that already share a rule.
   */
  boundAgents: (agents: readonly AgentTab[], epicId: string) => readonly AgentTab[];
  /** The roster row for the leaving agent plus its project's roster, or `undefined` when the agent
   *  cannot be resolved at all (already torn down, or never in a project). */
  locate: (agentId: string) => { agent: AgentTab; agents: readonly AgentTab[]; projectId: string } | undefined;
  /** The project's beads, or `undefined` when the board could not be read. `undefined` is a
   *  FAILURE value here and must never be spelled as `[]` — see {@link EpicReleaseReading}. */
  beadsFor: (projectId: string) => readonly Bead[] | undefined;
  now: () => number;
}

/**
 * Ask the epic question for one agent that is leaving, record the answer, and hand it back.
 *
 * CALL IT BEFORE THE TEARDOWN. The epic binding lives on the agent's roster row (`AgentTab.epicId`),
 * so a caller that closes the tab first hands this an agent it cannot resolve, and the answer
 * degrades to `not-bound` — silence, which is the bug.
 *
 * NEVER THROWS. It sits inside `set_agent_goal_met` and `retire_agent`, and a bookkeeping failure
 * must not turn a legitimate release into an error the agent has to work around.
 */
export function noteEpicRelease(
  agentId: string,
  cause: EpicReleaseCause,
  deps: EpicStaffingDeps,
): EpicStaffingOutcome {
  // HOISTED OUT OF THE `try` ON PURPOSE (roborev 78693). Once an epic has been resolved, a later
  // throw must not be reportable as `not-bound` — see the catch for why that was worse than silence.
  let resolvedEpicId: string | undefined;
  let resolvedProjectId = "";
  let at = 0;
  try {
    const now = deps.now();
    at = now;
    const found = deps.locate(agentId);
    if (!found) return { kind: "not-bound" };
    const epicId = found.agent.kind === "build" ? found.agent.epicId : undefined;
    if (!epicId) return { kind: "not-bound" };
    resolvedEpicId = epicId;
    resolvedProjectId = found.projectId;

    const beads = deps.beadsFor(found.projectId);
    // `null` for an unread board, never `0` — the child count is the claim, and an absent snapshot
    // makes no claim.
    const openChildren = beads === undefined ? null : openChildCount(beads, epicId);

    // THE OTHER BOUND AGENTS, with the leaver removed BY ID rather than by hoping the roster has
    // already been updated. Both seams call this while the row is still present, and reading the
    // leaver as its own successor would make every release read `still-staffed` — a gate that can
    // never fire, which is the vacuous shape this repo keeps finding.
    const others = deps.boundAgents(found.agents, epicId).filter((a) => a.id !== agentId);
    const otherStaffing = epicOrchestratorLiveness(
      others.map((a) =>
        orchestratorLivenessOf(
          {
            observedAlive: deps.aliveFor(a.id),
            observedStatus: deps.statusFor(a.id),
            observedAttention: deps.attentionFor(a.id),
            deathRecorded: deps.deathRecordedFor(a.id),
            lastHookEventMs: deps.lastHookEventFor(a.id),
            goalQuiet: goalIsQuiet(goalStateOf(a.goal, now)),
          },
          now,
        ),
      ),
    );

    const outcome = decideEpicStaffingOnRelease({
      releasedAgentId: agentId,
      projectId: found.projectId,
      cause,
      epicId,
      openChildren,
      otherStaffing,
      at: now,
    });
    if (outcome.kind === "unstaffed" || outcome.kind === "could-not-tell") {
      recordEpicStaffing(outcome.record);
      // LOUD, and at `warn` rather than `info`: this is the line whose absence let three epics go
      // quiet. It names the epic and the count, so it is actionable from the log alone.
      log.warn("epics", describeEpicStaffingRecord(outcome.record), {
        epic: outcome.record.epicId,
        openChildren: outcome.record.openChildren,
        state: outcome.record.state,
        cause,
        agent: agentId,
      });
    } else if (outcome.kind === "epic-complete" || outcome.kind === "still-staffed") {
      // A release that leaves the epic covered RETRACTS any earlier alarm for it, so a restaffed
      // epic stops being reported as unstaffed the moment the successor is observed.
      clearEpicStaffingRecord(outcome.epicId);
    }
    return outcome;
  } catch (e) {
    // FAIL CLOSED, WHICH HERE MEANS SURFACE IT (roborev 78693).
    //
    // This catch used to return `not-bound` for every throw. That is a POSITIVE CLAIM — "this agent
    // carried no epic" — which the code cannot make once `resolvedEpicId` is set, and it produced no
    // ledger record, nothing in `unstaffedEpicsFromReleases()`, and a warn line that did not even
    // name the epic. So a throwing `beadsFor` or liveness reader left the epic in exactly the
    // silence this module exists to end, and did it WORSE than the `beads === undefined` path beside
    // it, which correctly records `could-not-tell`. It also contradicted this file's own stated
    // contract in the header.
    //
    // `not-bound` is now reserved for the two cases that genuinely establish it: `locate` found
    // nothing, or the agent carries no `epicId`. Both return before anything else can throw.
    log.warn("epics", "could not judge epic staffing at release", {
      agent: agentId,
      epic: resolvedEpicId,
      error: String(e),
    });
    if (resolvedEpicId === undefined) return { kind: "not-bound" };
    const record: EpicStaffingRecord = {
      epicId: resolvedEpicId,
      projectId: resolvedProjectId,
      state: "could-not-tell",
      // The board may never have been read, so no count can be claimed.
      openChildren: null,
      releasedAgentId: agentId,
      cause,
      at,
      why: "the release-time read threw, so neither the board nor the roster could be judged",
    };
    recordEpicStaffing(record);
    log.warn("epics", describeEpicStaffingRecord(record), {
      epic: record.epicId,
      openChildren: record.openChildren,
      state: record.state,
      cause,
      agent: agentId,
    });
    return { kind: "could-not-tell", record };
  }
}
