// THE ADAPTER — app state in, `FleetSnapshot` out, and nothing else.
//
// `@sparkle/core` is a leaf: it must not import a store, an engine, or a Tauri command, so every
// fleet condition it decides is a pure function of a snapshot somebody else gathered. This is that
// somebody. It is the only file that knows both halves, and it is deliberately dumb — it maps
// fields, it does not decide anything. A judgement made here would be a second opinion about the
// same agent, invisible to the arithmetic tests in `packages/core`.
//
// ── PURE, AND TAKING ITS SOURCES AS PARAMETERS ───────────────────────────────────────────────────
// The stores and the engine registry arrive as arguments rather than being read from module scope,
// which is what lets the mapping be tested without a running app.
//
// WIRED 2026-08-04 (was roborev 57313/57341). An earlier version of this comment described a
// `fleetSnapshotsNow()` wrapper "at the bottom" that did the store reading; no such function ever
// existed, so the sentence told the next reader the app -> `@sparkle/core` seam was connected when
// it was not, and pointed this file's whole safety argument at code nobody had written.
//
// The seam is real now, and it is somewhere else: `services/pusherMount.ts` calls
// `buildFleetSnapshots` with `projectStore.projects`, `runtimeStore.branchStatus`, and
// `engineRegistry.quotaBlockForAgent` / `lastFailureForAgent` — the exact binding these unit tests
// structurally cannot cover, which is why it is named here rather than assumed.
//
// ── THE ONE RULE THAT MATTERS ────────────────────────────────────────────────────────────────────
// FAIL CLOSED, inherited verbatim from `pusherObserve`: `undefined` means WE DID NOT LOOK and must
// never satisfy anything. It has real teeth in exactly one place here — `hasUnlandedWork`, which
// feeds the "safe to retire" claim. Getting that wrong does not produce a noisy message; it tells
// the founder to discard an agent holding commits nobody merged. So it is only ever `false` on
// AFFIRMATIVE evidence of a clean tree, and `undefined` whenever the branch poll has not run.

import type { ConciergeQueue, FleetSnapshot, StandingDuty } from "@sparkle/core";
import type { AgentTab, LastObserved, Project } from "../types";
import type { AgentTabStatus } from "@sparkle/ui";
import type { BranchStatus } from "./branchStatus";
import type { QuotaBlock } from "../engine/quotaBlock";
import type { PassHoldReason } from "./improvementPass";
import { agentDisplayName } from "../engine/agentDisplayName";
// The codebase's SINGLE definition of "does this window actually know anything about this agent" —
// reused rather than re-derived, which is the mistake its own header records being made twice.
import { livenessOf } from "./agentLiveness";
// THE TWO STORES `buildConciergeQueue` JOINS. Read imperatively, at sweep time — the Pusher has no
// component to subscribe on. Both are three-valued about "we have not looked yet", which is the
// whole of what that function has to get right.
import { useConciergeQueueStore } from "../stores/conciergeQueueStore";
import { allTasksNow, liveTasks, useResearchStore } from "./research/store";

/** Everything the mapping reads. Supplied by the caller so this stays testable and pure. */
export interface FleetSnapshotInput {
  /** `projectStore.projects` — the Pusher spans every project, ownership is filtered downstream. */
  projects: readonly Project[];
  /**
   * `runtimeStore.branchStatus`. A MISSING entry is "not polled", never "clean".
   *
   * A CLOUD AGENT NEVER HAS AN ENTRY, and that is correct rather than an oversight worth fixing
   * here. Branch status is polled from an app-managed worktree on this Mac (`pollProjectStatus`),
   * and a cloud agent's branch lives inside an E2B sandbox where nothing local can stat it. So a
   * cloud agent enters a Pusher sweep like any other and simply has no branch signal — which the
   * "missing is not polled" rule above already handles safely, since nothing may conclude "clean"
   * from its absence.
   *
   * Stated because it is otherwise INVISIBLE: nothing in this file mentions runtime, so a reader
   * would reasonably assume cloud agents are covered. The server does know each session's branch
   * (it is what the egress push targets); surfacing it would mean carrying it back over the relay,
   * which is a real feature and not a filter tweak.
   */
  branchStatus: Readonly<Record<string, BranchStatus>>;
  /** `engineRegistry.quotaBlockForAgent`. */
  quotaFor(agentId: string, now: number): QuotaBlock | undefined;
  /** `engineRegistry.lastFailureForAgent`. */
  failureFor(agentId: string): { message: string; at: number } | undefined;
  /**
   * Is this agent's retro step on file? `retroSettled(cachedReceipt(projectId, agentId))`.
   *
   * INJECTED rather than read here, for the same reason `quotaFor` and `failureFor` are: this module
   * maps agents to snapshots and owns no store lookups.
   *
   * It takes the PROJECT ID as well, unlike its two siblings, because the receipt cache is keyed by
   * project — and `buildFleetSnapshots` is already inside the project loop when it calls this, so
   * the id is free here and a store search anywhere else.
   */
  retroSettledFor(projectId: string, agentId: string): boolean;
  /**
   * Has this agent's session ENDED?
   * `sessionEndedOf(runtimeStore.status[agentId], runtimeStore.lastObserved[agentId])`.
   *
   * INJECTED for the same reason `quotaFor` and `failureFor` are — this module owns no store reads.
   * Three-valued, and `undefined` is the ordinary reading rather than the exceptional one: the live
   * status map has a single writer (a mounted pane), so most of the fleet has no entry at all. See
   * {@link sessionEndedOf} for why an absent entry may never be read as either answer, and for why
   * BOTH maps have to be consulted rather than just the live one.
   */
  sessionEndedFor(agentId: string): boolean | undefined;
  now: number;
}

/**
 * Is this agent's session affirmatively OVER, affirmatively still going, or unknown?
 *
 * ── NO NEW VOCABULARY, AND NO NEW STATUS ────────────────────────────────────────────────────────
 * `hookEventToStatus({event:"SessionEnd"})` already answers `done`, and `engine/hookEvents.test.ts`
 * pins it. This is the boolean projection of that one mapping, so "the session ended" keeps a
 * single definition; inventing an `AgentTabStatus` for it would be a second opinion about the same
 * event, and a labelling change would then silently reclassify deaths.
 *
 * ── WHY AN ABSENT ENTRY IS `undefined` AND NOT `false` ──────────────────────────────────────────
 * `runtimeStore.status` is live-only and written by a mounted `AgentPane`, so a missing entry is
 * `agentLiveness`'s `unknown` / `other-window` — "nothing in this window is watching", never "still
 * running". `livenessOf` is written on exactly that test (`status[id] !== undefined ⇒ "local"`), and
 * `isObserved` is the predicate a caller is supposed to pass before treating a derived boolean as a
 * fact. This is that predicate, inlined at the one place the value is produced.
 *
 * ── ...WHICH IS WHY THE CAPTURE IS CONSULTED, AND IT IS NOT A NICETY (roborev 61854) ────────────
 * `runtimeStore.close()` DELETES the live `status` entry, and only a mounted pane ever writes one —
 * so for a closed row the live map is empty from then on, permanently. Reading only the live map
 * would therefore blind this class to exactly the agent it exists to protect: closing the row is the
 * ordinary first step before retiring one, so the condition would fall silent at the precise moment
 * the destructive act became imminent.
 *
 * The other half of the snapshot does NOT fall silent with it, which is what makes this worth fixing
 * rather than accepting: `close()` drops `branchStatus` too, but the sidebar re-polls the CLOSED
 * rows on its next tick (`pollProjectStatus` with the PR probe off) and puts `dirty` straight back.
 * So without the capture the pair is permanently `sessionEnded: undefined` + `dirty: true` — one
 * field missing, forever, for the one agent about to be torn down. `close()` writes the status it is
 * deleting into the PERSISTED `lastObserved`, so the fact survives the close and a relaunch.
 *
 * ── BUT A CAPTURE IS ONLY THE LAST WORD WHEN NOBODY IS STILL WATCHING (roborev 61893) ───────────
 * ABSENCE OF A LOCAL ENTRY IS NOT DEATH, and the difference is exactly what `agentLiveness` exists
 * to name — so this routes through `livenessOf` rather than testing `status[id] === undefined`
 * itself, which is the mistake that module's header says was made twice in two files:
 *
 *   • `local` — this window has a reading. It is authoritative; the capture is irrelevant.
 *   • `other-window` — no local entry, but a pane is open SOMEWHERE (`openAgentIds` is persisted and
 *     merged app-wide). This window cannot observe it, so it answers `undefined`. Using the capture
 *     here is the false positive that matters: `lastObserved` is never cleared by re-opening a row
 *     (only a confident no-session fresh start clears it), so a resumed agent keeps its stale `done`
 *     indefinitely — and the sidebar's closed-row poll keeps `dirty` true. The report would then
 *     tell the founder that a CURRENTLY WORKING agent died holding work and that retiring it
 *     deletes the files. That is precisely the credibility spend `diedHoldingWork`'s own header
 *     forbids, in the direction that is hardest to notice.
 *   • `unknown` — no local entry and no open pane anywhere. Only here is the capture the last word.
 *
 * ── ONLY `done` IS EVER AFFIRMATIVE, AND FROM A CAPTURE NOTHING ELSE IS EVEN `false` ────────────
 * `stopped` reads like a session end — "not running (persisted tab)" — which is the trap. It is also
 * what `useRosterPublisher` substitutes for an agent it has NO reading for (`DEFAULT_STATUS`), and
 * what `close()` DEMOTES a red-tier row to. Treating it as affirmative evidence would let a default
 * stand in for an observation, which is the whole failure this file's header is about.
 *
 * On the CAPTURE path a non-`done` value does not even earn `false`: closing a row mid-work captures
 * `working`, and the close may well have killed the PTY, so "still running" is an overclaim about a
 * process nobody watched die. Live says `false` (a mounted pane really is observing it); a capture
 * says `undefined`. `diedHoldingWork` tests `=== true` so both behave alike today — but the field is
 * documented three-valued, and a future consumer reading `false` as "alive" would be reading a
 * guess.
 */
export function sessionEndedOf(
  agentId: string,
  status: Readonly<Record<string, AgentTabStatus>>,
  lastObserved: Readonly<Record<string, LastObserved>>,
  openAgentIds: ReadonlySet<string>,
): boolean | undefined {
  switch (livenessOf(agentId, status, openAgentIds)) {
    case "local":
      return status[agentId] === "done";
    // Open somewhere this window cannot see. No claim either way — see above.
    case "other-window":
      return undefined;
    case "unknown": {
      const captured = lastObserved[agentId];
      // `done` is the only affirmative; everything else (including an absent capture) is UNKNOWN.
      return captured?.status === "done" ? true : undefined;
    }
  }
}

/**
 * The agent's UNCOMMITTED work as the safety reading — raw, never filtered by `worktreeOnBranch`.
 *
 * ── THE OPPOSITE FILTER FROM {@link unlandedWorkOf}, ON PURPOSE ─────────────────────────────────
 * `BranchStatus` states the split in its own comments and it is worth restating rather than
 * inferring, because the two consumers sit in this same file and want opposite things from one
 * field. `unlandedWorkOf` is ATTRIBUTION — it feeds "safe to retire", so a parked tree's dirt
 * belongs to whatever branch was checked out into it and must not be counted as this agent's, which
 * is why it declines to answer. This is SAFETY: parking CARRIES the uncommitted files along, so
 * they are still on disk and are still the user's, and a tear-down still destroys them. Suppressing
 * `dirty` here would be suppressing the warning precisely for the tree somebody already moved.
 *
 * What the report does NOT do is name the FILES, which is the half of the parked-tree caveat that
 * still binds — naming them would attribute another branch's work to this agent by name. It reports
 * the agent and the count, and asks the founder to go and look.
 *
 * `undefined` in, `undefined` out: an unpolled branch is not evidence of a clean tree OR a dirty
 * one, and `diedHoldingWork` requires an affirmative `true`.
 */
export function dirtyOf(
  status: BranchStatus | undefined,
): { dirty: boolean; dirtyCount?: number } | undefined {
  if (status === undefined) return undefined;
  return {
    dirty: status.dirty,
    // INDEPENDENTLY OPTIONAL. A Rust build predating `dirtyCount` sends `dirty: true` with no count,
    // and the report says "did not record how many" rather than printing a 0 nobody measured.
    ...(status.dirtyCount !== undefined ? { dirtyCount: status.dirtyCount } : {}),
  };
}

/**
 * Is this agent's tree affirmatively CLEAN, affirmatively HOLDING work, or unknown?
 *
 * Three-valued on purpose, and the `undefined` arm is the one doing the safety work — see the header.
 *
 * `worktreeOnBranch === false` reads as UNKNOWN rather than as either answer. `BranchStatus` says a
 * parked tree's dirt belongs to some other branch, so `dirty` cannot be attributed to this agent —
 * but `ahead` is derived from the branch ref and stays true. Rather than mix one trustworthy field
 * with one untrustworthy one to reach a claim as consequential as "safe to retire", a parked tree
 * declines to answer.
 */
export function unlandedWorkOf(status: BranchStatus | undefined): boolean | undefined {
  if (status === undefined) return undefined;
  if (status.worktreeOnBranch === false) return undefined;
  if (status.ahead > 0 || status.dirty) return true;
  return false;
}

/** One agent's snapshot. Exported for the tests, which assert the mapping field by field. */
export function snapshotOfAgent(
  agent: AgentTab,
  input: FleetSnapshotInput,
  projectId: string,
): FleetSnapshot & { agentId: string } {
  const branch = input.branchStatus[agent.id];
  const quota = input.quotaFor(agent.id, input.now);
  const failure = input.failureFor(agent.id);
  const sessionEnded = input.sessionEndedFor(agent.id);
  const uncommitted = dirtyOf(branch);
  const goal = agent.goal;

  return {
    agentId: agent.id,
    // The SHARED naming rule, not a local one: the concierge, the sidebar and this report must call
    // the same agent the same thing, or a report names something the founder cannot find on screen.
    label: agentDisplayName(agent),
    ...(quota !== undefined
      ? {
          quota: {
            message: quota.message,
            resetAt: quota.resetAt,
            resetParsed: quota.resetParsed,
          },
        }
      : {}),
    // Passed through UNNORMALISED — `sharedFailureCohorts` groups on these exact bytes to recognise
    // that one host event killed several agents, and any tidying here would tidy away the evidence.
    ...(failure !== undefined ? { failure: { message: failure.message, at: failure.at } } : {}),
    // `escalatedAt` is what `goalStateOf` latches on; the reason is quoted verbatim in the report.
    ...(goal?.escalatedAt !== undefined
      ? { escalation: { ...(goal.escalationReason !== undefined ? { reason: goal.escalationReason } : {}) } }
      : {}),
    ...(goal?.metAt !== undefined ? { goalMetAt: goal.metAt } : {}),
    ...(unlandedWorkOf(branch) !== undefined ? { hasUnlandedWork: unlandedWorkOf(branch) } : {}),
    // SPREAD CONDITIONALLY, like every reading above and unlike `retroSettled` below: an absent
    // entry here is "nothing in this window is watching this agent", which `diedHoldingWork` must be
    // able to tell apart from "it is still running".
    ...(sessionEnded !== undefined ? { sessionEnded } : {}),
    // The RAW dirty reading — see `dirtyOf` for why this one is deliberately not filtered the way
    // `hasUnlandedWork` is, and for why `dirtyCount` rides along separately.
    ...(uncommitted !== undefined ? uncommitted : {}),
    // ALWAYS SET, unlike the fields above — `retroSettled` is a total function of the cache, where
    // "no receipt" IS the answer `false` rather than a missing reading. Spreading it conditionally
    // would make an unsettled agent indistinguishable from one nobody asked, and `retirableAgents`
    // treats those the same anyway; setting it plainly keeps the snapshot readable in a log.
    retroSettled: input.retroSettledFor(projectId, agent.id),
  };
}

/**
 * Every agent, with the project it belongs to.
 *
 * BUILD AGENTS ONLY. Workers are excluded because the report's actions do not apply to them: a
 * worker is retired by its orchestrator rather than by the founder, and reporting one as "safe to
 * retire" would route the action to the wrong person. They still appear in their orchestrator's own
 * accounting, which is where that decision belongs.
 *
 * `projectId` rides along so the sweep's per-project ownership election and per-project report both
 * work without a second lookup.
 */
export function buildFleetSnapshots(
  input: FleetSnapshotInput,
): Array<FleetSnapshot & { projectId: string }> {
  const out: Array<FleetSnapshot & { projectId: string }> = [];
  for (const project of input.projects) {
    for (const agent of project.agents) {
      if (agent.kind !== "build") continue;
      out.push({ ...snapshotOfAgent(agent, input, project.id), projectId: project.id });
    }
  }
  return out;
}

/**
 * The app's standing duties, as the fleet report understands them.
 *
 * ── WHY THE HOURLY PASS IS HERE AT ALL ───────────────────────────────────────────────────────────
 * The consent banner promises it runs once an hour. `useImprovementScheduler` really is mounted and
 * really does tick — but `shouldRunImprovementPass` can decline every tick, indefinitely, and until
 * `passHoldReason` existed nothing recorded which arm declined. One of those arms is
 * self-sustaining: a wedged Sparkle pane reads `working`, so the pass is skipped, so the pane never
 * stops being busy. The founder found this the only way it can be found — by asking.
 *
 * `heldBy` is what makes the report actionable, so it is passed through as the caller's own words
 * rather than re-derived here; `passHoldReason` is the single source of that decision.
 */
export function buildStandingDuties(input: {
  /** `settingsStore.improvementLastRunAt`. `null` means the scheduler has not seeded — NOT overdue. */
  improvementLastRunAt: number | null;
  /** `IMPROVEMENT_INTERVAL_MS`, passed in so this file does not pin the cadence. */
  improvementIntervalMs: number;
  /** A human-readable rendering of `passHoldReason`, or undefined when nothing is holding it. */
  improvementHeldBy?: string;
}): StandingDuty[] {
  return [
    {
      name: "the hourly improvement pass (logs + beads backlog)",
      intervalMs: input.improvementIntervalMs,
      // `null` → omitted → fail-closed. An unseeded clock is not an overdue duty.
      ...(input.improvementLastRunAt !== null ? { lastRunAt: input.improvementLastRunAt } : {}),
      ...(input.improvementHeldBy !== undefined ? { heldBy: input.improvementHeldBy } : {}),
    },
  ];
}

/**
 * WHAT THE CONCIERGE'S OWN QUEUE LOOKS LIKE RIGHT NOW — the app-global input for the fleet
 * condition about messages stacking up with nothing fanned out.
 *
 * ── A SIBLING OF `StandingDuty` AND `ConflictingPr`, NOT A FIELD ON `FleetSnapshot` ───────────────
 * `FleetSnapshot` is keyed by `agentId`, and the concierge has no agent id: `conciergeNotifier`'s
 * header states it outright — a headless `claude -p` child with no row in the roster and no self.
 * There is nothing for this to hang off, which is verbatim the argument `pusherFleet` records for
 * keeping `ConflictingPr` out of that structure. A parallel app-global input has no such
 * requirement, and it is the shape a CAPABILITY-shaped condition already uses.
 *
 * ── THE MERGE NOTE THAT USED TO BE HERE HAS BEEN CARRIED OUT (2026-08-13) ────────────────────────
 * This file declared its OWN `ConciergeQueue` — `{waiting, running, liveAgents?}` — while the
 * condition that consumes it was landing separately in `@sparkle/core` as
 * `{queued, liveAgents, oldestAt}`. Its note said: *"At merge: move it, and import it from
 * `@sparkle/core` in the three places that name it."*
 *
 * THAT STEP WAS NEVER PERFORMED, because no PR was ever opened for the branch — and the cost is the
 * whole reason this paragraph replaces the type. Structural typing made the mismatch INVISIBLE:
 * `pusherRunner` put the reading on its decision input under the key `conciergeQueue` while
 * `FleetReportInput` reads `queue`, so the value was silently dropped, `evaluateFleetConditions`
 * received `undefined`, and `queue-unfanned` stayed exactly as dead as it had been before the
 * producer was written. `pusherRunner.ts` even described that as a virtue — *"an extra key on a
 * structurally-typed input is inert until `FleetReportInput` names it"* — which was true, and was
 * the bug.
 *
 * So: ONE type, owned by the package that decides on it. Nothing here may re-declare it.
 */

/**
 * Read the concierge queue and the concierge-agent count, and join them.
 *
 * IMPURE, unlike everything above it in this file, and that is a deliberate exception rather than
 * drift. The two other app-global inputs are assembled the same way one level up — `duties()` reads
 * `settingsStore` inside `pusherMount`, `conflicts()` reads `conflictStore` — and this one is
 * assembled here instead for one reason: the `hydrated` rule below is a JUDGEMENT about what may be
 * reported, and a judgement made at a wiring site is a judgement no unit test can reach. Its own
 * suite drives the two stores directly (`pusherSnapshots.conciergeQueue.test.ts`).
 *
 * `undefined` when no host has published, which is the whole three-valued point: no concierge is
 * mounted in this window, so there is no queue to report and nothing here may invent an empty one.
 *
 * ── UNHYDRATED RESEARCH ALSO RETURNS `undefined`, RATHER THAN OMITTING THE COUNT ────────────────
 * `liveTasks(allTasksNow()).length` is 0 both before the first `listResearch()` has landed and when
 * there genuinely are none, and getting that backwards is not a missed report — it is a FALSE ALARM
 * about the very condition being detected: "messages queued and nobody working them", raised by a
 * store nobody had read yet. The earlier shape spelled that as an OPTIONAL `liveAgents`, which is
 * the weaker guard: `queueUnfanned` then reads `undefined` as a non-finite count and declines, so
 * the two outcomes agreed by luck rather than by construction. Withholding the whole reading says
 * the true thing — WE DID NOT LOOK — in the vocabulary the consumer already has, and it keeps
 * `liveAgents` a required number so a producer cannot omit it silently.
 *
 * `hydrated` is set even by a FAILED first load (see `refreshResearch`), so this is only ever
 * `undefined` while nothing has tried.
 */
export function buildConciergeQueue(): ConciergeQueue | undefined {
  const depth = useConciergeQueueStore.getState().depth;
  if (depth === undefined) return undefined;
  // HYDRATION FIRST, then the count — never the count alone. See the header.
  if (!useResearchStore.getState().hydrated) return undefined;
  return {
    // `queued` is everything OWED behind the running turn — waiting PLUS delegated. A delegated
    // prompt (handed to a research worker by dispatch-and-continue) is still outstanding; counting
    // only `waiting` would let the fan-out blind the very `queue-unfanned` detector it feeds, reading
    // an empty queue while N questions are being worked. When each owed prompt has a live worker,
    // `queueUnfanned`'s own `liveAgents >= queued` guard correctly reads that as served.
    queued: depth.waiting + (depth.delegated ?? 0),
    liveAgents: liveTasks(allTasksNow()).length,
    oldestAt: depth.oldestAt,
  };
}

/**
 * The hold reasons as a sentence the report can quote. Kept beside the duty it describes.
 *
 * TYPED ON `PassHoldReason`, NOT `string` (roborev 57323). As `Record<string, string>` a sixth arm
 * compiled cleanly with no text and a typo'd key compiled too — and under this project's
 * `noUncheckedIndexedAccess` the lookup is `string | undefined`, which assigns silently into the
 * optional `heldBy`. The report would then say "Nothing reports why." about a hold whose cause was
 * known, which is silent failure in the exact direction this feature exists to prevent. Keyed on the
 * union, a new arm is a compile error.
 */
export const PASS_HOLD_TEXT: Record<PassHoldReason, string> = {
  "consent-off": "improvement consent is set to never",
  "already-running": "a pass is already in flight",
  "pane-busy": "the Sparkle agent pane reads 'working' — which also prevents the next tick, so this one does not clear itself",
  "pane-wedged":
    "the Sparkle agent pane has read 'working' for over three hours — the hourly duty has been off that whole time, and it will not clear itself: interrupt or restart that pane",
  "clock-unseeded": "the scheduler has not seeded its clock yet",
  offline: "this machine is offline",
};
