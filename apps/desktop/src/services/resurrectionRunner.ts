// resurrectionRunner — THE MOUNT for `engine/resurrection` and `engine/resurrectionCohort`: it owns
// the per-cohort phase state, decides on a timer, and performs the one side effect (letting a dead
// agent's pane mount again).
//
// The engines are pure and know nothing about agents, stores or terminals. This module is the half
// that spends something, so everything it touches arrives as an injected dependency and every rule
// stays testable without a real terminal — the same split `services/apiRecoveryRunner` and
// `services/goalContinuationRunner` use, and it is modelled on the latter throughout: the same
// `ownsProjectInThisWindow` election, the same never-throws contract, the same in-flight guard, and
// the same "return outcomes so tests assert DECISIONS rather than spies".
//
// ── THE SIDE EFFECT IS AN ADMISSION, NOT A SPAWN ──────────────────────────────────────────────
// See `services/resurrectionAdmission` for the full argument. In one line: `claude --resume` already
// exists (`claudeSpawn.buildClaudeExec`, driven by `AgentPane` off `claudeSessionInfo`), and
// `AgentPane.prepare` is where worktree prep, write-guard install, hook install, account selection
// and resume detection live — so a headless spawn path would have to re-implement all of it and
// would then stall on `pty.rs`'s 256 KiB inflight high-water mark, because only xterm emits
// `pty_ack`.
//
// ── IT IS THE MIRROR OF apiRecoveryRunner, AND THE PAIR MUST NOT FIGHT ────────────────────────
// `apiRecovery.decideRevive` refuses anything whose process is not still alive; it recovers by
// TYPING into a living PTY. `decideResurrection` refuses anything whose process is not explicitly
// DEAD. `errored + alive` is apiRecovery's; `errored + dead` is this module's. The two are disjoint
// on the liveness axis BY CONSTRUCTION, and that invariant is asserted in
// `resurrectionRunner.noFight.test.ts` so the pair cannot start fighting silently.
//
// ── NO MODEL CALL ON ANY PATH ─────────────────────────────────────────────────────────────────
// A fleet-wide wall gates every LLM in the app behind the same account limit, so a recovery path
// that consults one is dead exactly when it is needed. This sweep is comparisons over timestamps and
// ids, two `invoke`s, and a Set write.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

// The SHARED router for findings handed to the concierge — extended additively with
// `routeRecoveryExhausted` rather than given a second copy of the words, so the routing decision
// and the sentence that carries it cannot drift (packages/core/pusherBlocker's own rule).
import { routeRecoveryExhausted } from "@sparkle/core";
import { agentDisplayName } from "../engine/agentDisplayName";
import { lastFailureForAgent, quotaBlockForAgent } from "../engine/engineRegistry";
import {
  MAX_RESURRECTS_PER_AGENT_PER_DAY,
  type NoResurrectReason,
  decideResurrection,
} from "../engine/resurrection";
import {
  type CohortMember,
  type CohortPhase,
  type ProbationEvidence,
  MAX_CANARY_ATTEMPTS,
  PROBATION_MS,
  RELEASE_BATCH,
  advanceProbation,
  afterFailure,
  decideCohortAdmission,
  electCanary,
  groupCohorts,
  stabilizeCohortKeys,
} from "../engine/resurrectionCohort";
import type { DeathCause } from "../engine/deathTypes";
import type { QuotaBlock } from "../engine/quotaBlock";
import { hasTurnEndAuthority, processAliveOf } from "../engine/turnEndAuthority";
import { log } from "../logger";
import { useProjectStore } from "../stores/projectStore";
import { mountedPaneIds as mountedPaneIdsFromRegistry } from "./paneControl";
import { notifyAttention } from "./attention";
import { notifyConcierge } from "./conciergeNotifier";
import { mountAgent, type MountResult } from "./agentMount";
import { ownsProjectInThisWindow, suppressContinuation } from "./goalContinuationRunner";
import { isTornOut } from "./satelliteWindows";

/** How often the sweep runs. Matches `GOAL_SWEEP_INTERVAL_MS`, and for the same reason: the ENGINE
 *  decides when a rung is due by comparing wall-clock instants, so this only bounds how late a due
 *  rung can fire. The shortest thing anyone waits on is the 60s first rung. */
export const RESURRECT_SWEEP_INTERVAL_MS = 15_000;

/**
 * The most respawns this window will start in ONE sweep.
 *
 * Equal to `RELEASE_BATCH` on purpose. `decideCohortAdmission` already drains a released cohort at
 * that rate, so matching it means this bound never becomes the binding constraint for a cohort — it
 * exists for the OTHER shape, a swarm of unrelated lone deaths (each below the cohort victim floor,
 * so each correctly skipping the canary) arriving at once. Without it, 20 independent transport
 * deaths would all be admitted in one tick, which is the flood by another route.
 */
export const MAX_RESPAWNS_PER_SWEEP = RELEASE_BATCH;

/**
 * The most panes this window will let the resurrector MOUNT INTO before it stops adding new ones.
 *
 * ── WHY A CEILING AND NOT JUST A RATE (bead sparkle-5j6re3) ──────────────────────────────────
 * `MAX_RESPAWNS_PER_SWEEP` bounds how many respawns start per 15s tick; it does NOT bound how many
 * panes end up mounted, and the two costs are different. Every NEW `AgentPane` mount forces a
 * full-document layout across every OTHER mounted pane (sparkle-gw36j: ~39 of 40 terminals are
 * DOM-rendered text grids, one layout measured at ~0.37s), so resurrecting into an already-large
 * fleet is an O(N) cost paid once per admitted mount, with N climbing on every tick. An app restart
 * that leaves hundreds of agents due is the shape that bites: measured on v0.130.0, a burst of
 * mounts drove a 7.7s main-thread stall after the fleet reached 40 panes, and the PTY spawns the
 * founder actually asked for landed ~7s late behind it.
 *
 * The mounted set only ever GROWS within a session (`Workspace.tsx` — a Terminal unmount kills its
 * PTY, so panes are sticky), so once the fleet is this large the cheapest safe thing is to stop
 * ADDING to it. Refused agents are not dropped: they stay due (the Rust ledger republishes the due
 * list every scan), and come back on the next app run with a fresh mounted set, or once the
 * amplifier bead lands and each mount is cheap again. Deferring some recoveries is strictly better
 * than melting the renderer for everyone.
 *
 * 40 is the fleet size at which the stall was measured. It bounds only NEW-pane mounts — see the
 * gate in {@link sweepResurrections}.
 */
export const MAX_MOUNTED_PANES_FOR_RESURRECTION = 40;

/** One dead agent the Rust ledger says is DUE. Mirrors `revival::DueAgent` field for field. */
export interface DueAgent {
  agentId: string;
  projectId: string;
  worktree: string;
  cause: DeathCause;
  epoch: string;
  diedAt: number;
  notBeforeMs: number;
  message?: string | null;
  attemptsAt: number[];
}

export interface ResurrectionOutcome {
  agentId: string;
  action: "respawn" | "none";
  /** A `NoResurrectReason`, a cohort/ownership refusal, or `attempt N` for a respawn. The field a
   *  human reads when they ask why a dead row was left alone. */
  detail: string;
}

/**
 * WHAT THE MOUNT ACTUALLY DID — and the reason this is no longer `void`.
 *
 * `mount` used to return nothing, so `admit` could not tell a real mount from a no-op and reported
 * `respawn` either way. On the founder's live v0.95.0 install that produced nine `respawned a dead
 * agent` lines in one day for nine agents whose `pty_spawn` count was ZERO and whose `agent-status`
 * event count was ZERO. Each of those fictions spent one of the 24 durable daily attempts, moved the
 * cohort into `probation`, failed 180s later on `no-turn-authority` (correctly — nothing had
 * started), rotated the canary, and after three rotations abandoned the whole cohort. Two full
 * cohort abandonments in one day, every one of them caused by the mount lying about itself.
 *
 * So the seam answers a QUESTION now, and `admit` believes the answer rather than the call
 * returning:
 *
 *   • `restarted`    — route 1: a mounted pane's own re-spawn lever was pulled. Real.
 *   • `opened`       — route 2: the agent has a projectStore row, so `Workspace` can and will mount
 *                      a fresh pane for it. Real.
 *   • `no-agent-row` — route 2 is STRUCTURALLY INERT: no `Project.agents` row names this id, so
 *                      `Workspace`'s project gate (`p.agents.some(a => admitted.has(a.id))`) matches
 *                      nothing and its mount loop (`for (const a of p.agents)`) iterates past it. The
 *                      admission set grows, `openAgentIds` grows, and nothing whatsoever mounts.
 */
// Re-exported so this module's existing consumers keep importing it from here; the type (and
// the logic behind it) now lives in `services/agentMount`.
export type { MountResult } from "./agentMount";

export interface ResurrectionSweepOptions {
  /** Injected clock, house style — so the ladder arithmetic needs no fake timers. */
  now?: number;
  /** Single-owner election. Defaults to {@link ownsProjectInThisWindow}; injected by tests. */
  ownsProject?: (projectId: string) => boolean;
  /** Is this project displayed by a torn-off satellite window? */
  projectTornOut?: (projectId: string) => boolean;
  /** The due list, from `revival.rs`. */
  due?: () => Promise<DueAgent[]>;
  /** EVERY live PTY session id in this PROCESS. See the guard in {@link admit}. */
  liveSessions?: () => Promise<string[]>;
  /** Every agent id whose pane is MOUNTED right now IN THIS PROCESS (services/paneControl's restart
   *  registry — NOT the persisted `openAgentIds`, which survives a restart and would make the gate
   *  inert; see {@link mountedPaneIdsFromRegistry}). Its size is the fleet the per-mount layout cost
   *  scales with, and membership says whether resurrecting an agent needs a brand-new pane (absent →
   *  route 2, an O(N) mount) or a cheap route-1 restart (present). See the mount-ceiling gate in
   *  {@link sweepResurrections}. */
  mountedPaneIds?: () => Iterable<string>;
  /** Take the durable claim. `false` means a live epoch holds it — a refusal, not an error. */
  claim?: (agentId: string) => Promise<boolean>;
  /** Give the claim back, recording the attempt durably when `spawned`. */
  release?: (agentId: string, spawned: boolean) => Promise<void>;
  /** Let the pane mount, and SAY WHETHER IT LANDED. See {@link MountResult}. */
  mount?: (agentId: string) => MountResult;
  /** Does the projectStore still hold an agent row for this id? See {@link agentRowPresent} — the
   *  one question that separates a revivable dead agent from an orphaned ledger record. */
  hasAgentRow?: (agentId: string) => boolean;
  /** Hold the goal sweep off this agent until `untilMs`. */
  suppress?: (agentId: string, untilMs: number) => void;
  /** What was observed about a canary during its probation window. */
  probationEvidence?: (canaryId: string, spawnedAt: number, now: number) => ProbationEvidence;
  /**
   * Hand one finding to the concierge. Returns whether it was ACCEPTED — `false` means it went
   * nowhere and stays owed, which is `notifyConcierge`'s own published contract.
   *
   * Defaults to the real `services/conciergeNotifier`, so the production path is what every caller
   * that passes nothing exercises. Injected only so a test can drive the escalation without a
   * registered sink.
   */
  escalate?: (text: string) => boolean;
}

// ── module state: the phases, and who has been burned ────────────────────────────────────────
//
// Module-level rather than store state for the same reason `apiRecoveryRunner`'s episodes are: this
// is bookkeeping for a decision, not something any surface renders, and it must survive re-renders
// without being persisted (a cohort is an incident, and an incident does not outlive the app).
let cohortPhases = new Map<string, CohortPhase>();
/** agentId → cohort key. Carried across sweeps because `groupCohorts` is a pure function of the
 *  CURRENT death list and no pure function of that list can give a cohort an identity that survives
 *  its own members leaving — see `stabilizeCohortKeys`. */
let cohortBinding = new Map<string, string>();
/** cohort key → canary ids already tried and failed. Rotation is a property of `afterFailure`, but
 *  the SET has to be carried by the caller, and losing it makes `MAX_CANARY_ATTEMPTS` unreachable. */
let burnedCanaries = new Map<string, Set<string>>();
/**
 * cohort key → how many canaries have FAILED A PROBATION for it.
 *
 * Carried by the caller because the phase cannot carry it across a wait. `observed` has no
 * `attempt` field, so every path that drops back to it — the unelectable-this-sweep downgrade, a
 * re-election — would restart the budget at 1 and make `MAX_CANARY_ATTEMPTS` unreachable. That is
 * the exact bug `resurrectionCohort` documents: "afterFailure restarted at attempt 1 forever …
 * abandoned unreachable, no human ever asked."
 *
 * It counts FAILURES, not elections, so a canary re-elected because the old one went live or left
 * the due list costs nothing — it never failed anything.
 */
let cohortAttempts = new Map<string, number>();
/** Agents with an admission in flight RIGHT NOW. The intra-sweep half of the one-respawn rule: the
 *  claim/mount/release chain awaits, so without this a second sweep starting mid-chain would decide
 *  to respawn the same agent again off pre-admission state. */
const inFlight = new Set<string>();
/**
 * agentId → the `diedAt` of the episode whose exhausted recovery has ALREADY been handed to the
 * concierge.
 *
 * ONCE PER EPISODE, and keyed on the death instant rather than a bare boolean so a genuinely NEW
 * death re-escalates. The sweep runs every 15s and `daily-cap-spent` persists for hours, so an
 * unlatched escalation would be ~240 concierge findings an hour for one agent — and each one costs
 * a real turn against the same account limit the fleet is already fighting. Same reasoning, same
 * shape, as this module's `lastDecisionSignature` change detection.
 *
 * A REFUSED delivery is deliberately NOT latched: `notifyConcierge` returning false means the text
 * went nowhere, and `conciergeNotifier`'s own doctrine is that such a finding stays owed and comes
 * back next sweep. Latching on a failed hand-off is exactly how the Pusher lost findings.
 */
let recoveryExhaustedReported = new Map<string, number>();

/** Test seam: forget every cohort phase, binding, burned set and in-flight admission. */
export function _resetResurrectionRunnerForTests(): void {
  cohortPhases = new Map();
  cohortBinding = new Map();
  burnedCanaries = new Map();
  cohortAttempts = new Map();
  recoveryExhaustedReported = new Map();
  inFlight.clear();
  _resetResurrectionDecisionLogForTests();
}

/** Introspection seam: the phase this window currently holds for a cohort key. Lets a test assert
 *  the state machine directly rather than only through the absence of a respawn. */
export function cohortPhaseFor(key: string): CohortPhase | undefined {
  return cohortPhases.get(key);
}

/** Introspection seam: every cohort key this window is tracking. */
export function cohortKeys(): readonly string[] {
  return [...cohortPhases.keys()];
}

// ── the real edges ───────────────────────────────────────────────────────────────────────────

/** The four window-local readings a probation is judged on. Injectable ONLY so the recency rules
 *  below can be driven in both directions — a test that cannot produce a wall cannot tell
 *  "no wall was seen" from "the `>= spawnedAt` comparison works", and the first proves nothing. */
export interface ProbationSources {
  quota: (agentId: string, now: number) => QuotaBlock | undefined;
  lastFailure: (agentId: string) => { message: string; at: number } | undefined;
  processAlive: (agentId: string) => boolean | undefined;
  hasAuthority: (agentId: string) => boolean;
}

const REAL_PROBATION_SOURCES: ProbationSources = {
  quota: quotaBlockForAgent,
  lastFailure: lastFailureForAgent,
  processAlive: processAliveOf,
  hasAuthority: hasTurnEndAuthority,
};

function defaultProbationEvidence(
  canaryId: string,
  spawnedAt: number,
  now: number,
  src: ProbationSources = REAL_PROBATION_SOURCES,
): ProbationEvidence {
  const failure = src.lastFailure(canaryId);

  // ── EVERY FIELD MUST BE AN OBSERVATION MADE AT OR AFTER `spawnedAt` ─────────────────────────
  //
  // Without this the probation is not merely weak, it is INVERTED (roborev 60241). `status` has a
  // single writer — a mounted `AgentPane` — so between the death and the respawned pane's first
  // status write it stays frozen at the agent's PRE-DEATH value. For any death this window
  // observed, that value is `errored` (written by `StatusEngine.exit()`) or `stopped`. So the very
  // first probation check, one sweep after admission, read `exited: true`.
  //
  // `advanceProbation` fails FAST on `exited`, with no recency guard of its own — deliberately, and
  // it says so: a canary that died is decisive immediately. So the canary was failed ~15s after
  // being admitted, before `claude --resume` could plausibly have finished a worktree prep and a
  // transcript scan; `afterFailure` burned the next victim; and three rotations later the cohort
  // went `abandoned`. Fifty agents permanently unrecovered, three durable attempts spent, on
  // evidence that predated the respawn.
  //
  // EVERY FIELD IS READ FROM A SOURCE THAT RESETS ON RESPAWN. `runtimeStore.status` is NOT such a
  // source and is deliberately not consulted: it has a single writer (a mounted `AgentPane`), so
  // nothing rewrites it between the death and the new pane's first status write.
  //
  // `turnEndAuthority` is such a source, and that is why both positive witnesses come from it.
  // `StatusEngine.dispose()` calls `forgetAgent` and the new engine calls `trackAgent`, both
  // ownership-guarded against the remount race — so after a restart the record is genuinely about
  // THIS run and `processAliveOf` answers `undefined` ("no reading yet") rather than replaying the
  // exit that killed the previous one.
  const alive = src.processAlive(canaryId);

  return {
    // ONLY an explicit `false`. `undefined` is "this window has no reading yet", which is the state
    // for the whole boot, and it must not read as death — `advanceProbation` fails FAST on `exited`
    // with no recency guard of its own (deliberately: a canary that died is decisive immediately),
    // so a `true` here one sweep after admission fails the canary before `claude --resume` could
    // plausibly have finished a worktree prep and a transcript scan. Three rotations later the
    // cohort is `abandoned`: fifty agents permanently unrecovered on evidence that predated the
    // respawn.
    exited: alive === false,
    // Scoped the same way, explicitly: a wall observed BEFORE this respawn is the very door we are
    // testing, so counting it as the door shutting again would fail every canary sent at a wall.
    reWalled: (src.quota(canaryId, now)?.at ?? 0) >= spawnedAt,
    // Passed through unfiltered — `advanceProbation` compares `apiBannerAt >= spawnedAt` itself, and
    // that comparison should stay the one place the rule lives.
    apiBannerAt: failure?.at,
    // THE ONE WITNESS A SPINNER CANNOT FAKE. `hasTurnEndAuthority` is granted by a real hook event
    // from Claude Code's own stream, so it establishes that the model actually connected and ran a
    // turn — which is exactly the claim a probation has to make before releasing 48 agents behind
    // it. "The pane looks fine" is deliberately not one of these fields.
    hasTurnAuthority: src.hasAuthority(canaryId),
    // HONEST LIMITATION: today this is the SAME signal as `hasTurnAuthority`, so it adds no
    // independent failure. The two are distinct questions in `ProbationEvidence` — "did it connect
    // and finish a turn" vs "did it do any work at all" — but the only respawn-scoped witness this
    // window has is `turnEndAuthority`, and answering the second from `runtimeStore.status` is
    // exactly the stale read that inverted this function. A weaker-but-sound witness beats a
    // stronger-looking one that is wrong; a per-agent hook-event counter reset at spawn is the
    // right source when one exists.
    didWork: src.hasAuthority(canaryId),
  };
}

/**
 * BRING THE AGENT BACK. Two routes, because there are two genuinely different states — and getting
 * this wrong made the whole feature a no-op that still burned a durable attempt (roborev 60241).
 *
 * ── ROUTE 1: THE PANE IS STILL MOUNTED, SITTING ON "Agent exited — Start again" ────────────────
 * This is the COMMON case, not the rare one, and the reason is structural: `classifyDeath`'s Gate 0
 * only writes a real verdict when `liveness === "local"`, which requires a `runtimeStore.status`
 * entry, which only a MOUNTED pane produces. So every death this window classifies with evidence —
 * every `transport-transient`, every `wall-*` — is by construction one whose pane is still there.
 *
 * And for that case `admitAgent` + `runtimeStore.open` do NOTHING. `open` merges and returns the
 * same state when the id is already in `openAgentIds`, nothing removes an agent from that set when
 * its PTY exits, and admission only unlocks Workspace's VISITED-PROJECT gate — which a mounted pane
 * has already cleared. The pane would keep sitting on its overlay and no `claude --resume` would
 * ever run, while the sweep reported `respawn`, spent one of the 24 durable daily attempts, and
 * moved the cohort into probation on the strength of it.
 *
 * `restartPane` is the lever that actually works, and it is the same one "Start again" pulls —
 * `Terminal.restart()` tears the PTY down and re-spawns it, resuming the Claude session. It is not
 * a new mechanism: `services/authRecovery` already recovers a walled fleet through exactly this
 * call, for exactly this reason.
 *
 * ── ROUTE 2: NO PANE AT ALL ───────────────────────────────────────────────────────────────────
 * The app-restart case: the previous process died, `seal_stale_at` inferred the death at launch, and
 * this window has never mounted anything for that agent. `restartPane` returns false (no pane
 * registered its lever), and the admission set plus `open` are exactly right — they are what makes
 * `Workspace` mount a fresh pane, which prepares the worktree and resumes.
 *
 * ── ROUTE 2 HAS A PRECONDITION, AND SKIPPING THE CHECK IS WHY THIS SHIPPED AS A NO-OP ─────────
 * Route 2 only works when a `Project.agents` row names the id. `Workspace.tsx` gates the PROJECT on
 * `p.agents.some(a => admitted.has(a.id))` and then mounts with `for (const a of p.agents)` — an id
 * naming no row satisfies neither. So for an agent whose ledger record outlived its UI row, both
 * calls below "succeed" and nothing mounts. That is the exact state on the founder's install: 15
 * projects, 75 agent rows, and nine due agents present in none of them.
 *
 * The roborev-60241 fix closed route 1 (`restartPane` already returned a boolean) and left route 2
 * claiming success unconditionally. This is route 2's boolean.
 */
// THE BODY MOVED TO `services/agentMount`, unchanged, and this delegates. The two routes above are
// not resurrection-specific: `services/sendToBuild` re-derived half of them for its machine-driven
// handoff and shipped the identical no-op roborev 60241 had already paid to find here. One
// implementation, so there cannot be a fourth derivation.
function defaultMount(agentId: string, hasRow: (id: string) => boolean): MountResult {
  return mountAgent(agentId, hasRow);
}

/**
 * Does the projectStore hold a `Project.agents` row for this id?
 *
 * ── IT FAILS *OPEN*, AND THAT DIRECTION IS DELIBERATE ────────────────────────────────────────
 * An empty `projects` array cannot be told apart from "zustand's persist middleware has not
 * rehydrated `sparkle-projects` yet", and this sweep runs on a 15s interval that starts at app boot.
 * Answering `false` there would mark the entire fleet orphaned for one tick — and an orphan is a
 * PERMANENT refusal that also feeds `permanentlyUnfit`, so a single unlucky tick during rehydration
 * would write off every dead agent on the machine. `true` merely means the sweep tries a mount and,
 * at worst, `admit` catches the miss one layer down; that is the recoverable direction.
 *
 * Read-only on purpose: `getState()` rather than a hook, because the sweep is not a component and
 * must not subscribe to anything.
 */
export function agentRowPresent(agentId: string): boolean {
  const { projects } = useProjectStore.getState();
  if (projects.length === 0) return true;
  return projects.some((p) => p.agents.some((a) => a.id === agentId));
}

/** Test seam: the REAL probation evidence, so it can be driven directly. It is the default nobody
 *  injects, which is exactly why it shipped inverted once — see the comments inside it. */
export const defaultProbationEvidenceForTests = defaultProbationEvidence;

function liveOptions(opts: ResurrectionSweepOptions): Required<ResurrectionSweepOptions> {
  // ONE predicate, shared by the sweep's pre-gate and by `defaultMount`. Resolved here rather than
  // letting `defaultMount` reach for the real one itself, so a test that injects `hasAgentRow`
  // drives BOTH — otherwise the two could answer differently and the pairing that matters in
  // production would be untested by construction.
  const hasAgentRow = opts.hasAgentRow ?? agentRowPresent;
  return {
    hasAgentRow,
    now: opts.now ?? Date.now(),
    ownsProject: opts.ownsProject ?? ownsProjectInThisWindow,
    projectTornOut: opts.projectTornOut ?? ((projectId) => isTornOut(projectId)),
    due: opts.due ?? (() => tauriInvoke<DueAgent[]>("revival_due")),
    liveSessions: opts.liveSessions ?? (() => tauriInvoke<string[]>("pty_live_sessions")),
    // The IN-PROCESS pane registry (services/paneControl), NOT the persisted `openAgentIds`: the
    // latter is restored from localStorage at boot and names last session's open agents, none of
    // which has a pane in this process — which would make the ceiling inert in the restart storm it
    // exists for (bead sparkle-5j6re3). This registry is the exact set `restartPane` consults, so
    // membership matches `mountAgent`'s route-1 vs route-2 choice.
    mountedPaneIds: opts.mountedPaneIds ?? (() => mountedPaneIdsFromRegistry()),
    claim:
      opts.claim ??
      ((agentId) => tauriInvoke<boolean>("agent_life_claim", { agentId, by: "resurrectionRunner" })),
    release:
      opts.release ??
      (async (agentId, spawned) => {
        await tauriInvoke("agent_life_release", { agentId, spawned });
      }),
    mount: opts.mount ?? ((agentId) => defaultMount(agentId, hasAgentRow)),
    suppress: opts.suppress ?? suppressContinuation,
    probationEvidence: opts.probationEvidence ?? defaultProbationEvidence,
    // The REAL notifier by default, so every production sweep drives the escalation path.
    escalate: opts.escalate ?? ((text) => notifyConcierge(text)),
  };
}

// ── the sweep ────────────────────────────────────────────────────────────────────────────────

/** Respawns already spent on THIS death episode, from the durable list. An attempt recorded at or
 *  after the death belongs to this episode; earlier ones belong to previous ones and are counted
 *  only against the rolling daily cap. */
function episodeAttempts(attemptsAt: readonly number[], diedAt: number): number {
  return attemptsAt.filter((t) => t >= diedAt).length;
}

function lastAttemptAt(attemptsAt: readonly number[]): number | undefined {
  return attemptsAt.length === 0 ? undefined : Math.max(...attemptsAt);
}

/** The per-agent gate's input, built in ONE place so the canary probe above and the admission loop
 *  below cannot drift into asking two different questions. */
function resurrectionInputFor(d: DueAgent, processAlive: boolean, now: number) {
  return {
    cause: d.cause,
    processAlive,
    notBeforeMs: d.notBeforeMs,
    attemptsThisEpisode: episodeAttempts(d.attemptsAt, d.diedAt),
    lastAttemptAt: lastAttemptAt(d.attemptsAt),
    diedAt: d.diedAt,
    recentAttemptsAt: d.attemptsAt,
    now,
  };
}

/**
 * Refusals that are PERMANENT — the agent is not a victim and never will be, so it can be written
 * off durably.
 *
 * `daily-cap-spent` is NOT here, and that distinction is the whole point of splitting these two
 * sets. `decideResurrection` counts the cap over a ROLLING 24h window
 * (`attemptsInWindow(...) >= MAX_RESURRECTS_PER_AGENT_PER_DAY`), so it clears by itself exactly like
 * `waiting-for-next-rung`. Treating it as permanent leaked a per-sweep fact into two durable places
 * — the same mistake as folding `liveIds` into `burnedCanaries`: a merely-capped canary became
 * unelectable for its cohort key FOREVER, even after the window rolled off, and
 * `stabilizeCohortKeys`' supersedes copy carried that across re-keys.
 *
 * Worse, all-members-capped is the LIKELY state rather than an exotic one: cohort members die of one
 * cause and are admitted in the same batches, so their `attemptsAt` counts move in lockstep and a
 * flapping 2-victim cohort hits 24 on both at nearly the same moment. Marking that `abandoned` —
 * a phase nothing re-derives — would give up permanently on a cohort that only needed to wait.
 */
const PERMANENT_NO_RESURRECT: ReadonlySet<NoResurrectReason> = new Set<NoResurrectReason>([
  "no-death-record",
  "clean-goal-met",
  "blocked-on-human",
  "unclassified-death",
]);

/** Refusals that make an agent a bad CANARY THIS SWEEP but say nothing about later ones. Excluded
 *  from election, never written down. */
const TRANSIENT_NO_RESURRECT: ReadonlySet<NoResurrectReason> = new Set<NoResurrectReason>([
  "daily-cap-spent",
]);

/** This agent's display name, or its id when no row holds it. Mirrors `apiRecoveryRunner`'s helper
 *  of the same name — a bare uuid in a concierge finding is unreadable to a human and unusable to
 *  the concierge, which resolves agents by name. */
function labelForAgent(agentId: string): string {
  const agent = useProjectStore
    .getState()
    .projects.flatMap((p) => p.agents)
    .find((a) => a.id === agentId);
  return agent === undefined ? agentId : agentDisplayName(agent);
}

/**
 * RECOVERY IS EXHAUSTED FOR THIS AGENT — TELL THE CONCIERGE, NOT THE FOUNDER.
 *
 * ── THE FACT THAT NOTHING USED TO REPORT ──────────────────────────────────────────────────────
 * `daily-cap-spent` is the ONLY terminal bound `decideResurrection` has — the ladder plateaus at 30
 * minutes rather than ending, so every other refusal clears by itself. It was reported through the
 * sweep's returned `outcomes`, which the interval caller discards, and through a grouped log line.
 * So the moment automatic recovery stopped trying reached nobody at all, which is the same shape as
 * the gap `apiRecoveryRunner.onEscalate` was built to close on the LIVE side of the liveness axis:
 * every existing signal fires when a row TURNS red, and giving up moves no digest — the row has
 * been dead the whole time.
 *
 * ── AND THE DE-REDDING IS WHAT MAKES IT REQUIRED, NOT MERELY NICE ─────────────────────────────
 * A dead session with a resurrectable cause now renders amber and is excluded from the needs-you
 * band (`engine/deadSessionAttention`), on the rule that red is reserved for the founder being the
 * only actor who can unblock something. That is correct precisely BECAUSE something else is coming
 * to act. When the budget is spent nothing is coming any more — so without this hand-off the row
 * would go quiet with no owner, which is a silently abandoned agent and strictly worse than the
 * false red that was removed.
 *
 * The concierge is the right recipient because it can actually act: restart it, or take its branch
 * over. That is the preference order every route in `pusherBlocker` follows — agent, concierge,
 * then the human.
 */
function reportRecoveryExhausted(d: DueAgent, escalate: (text: string) => boolean): void {
  if (recoveryExhaustedReported.get(d.agentId) === d.diedAt) return;
  const route = routeRecoveryExhausted({
    label: labelForAgent(d.agentId),
    // The REAL figure, from the durable ledger, rather than the cap constant. They coincide today
    // (the gate fires at `>=` the cap) but the router's sentence quotes this number to a human, and
    // a count restated from a constant is a claim about the ledger made without reading it.
    attempts: d.attemptsAt.length,
  });
  // `target` is always "concierge" here, so this is a self-check rather than a branch: if that route
  // is ever re-pointed at the founder, this stops delivering instead of quietly paging him — the
  // one outcome this whole change exists to prevent. Same guard `apiRecoveryRunner` applies.
  if (route.target !== "concierge") return;
  if (!escalate(route.text)) {
    // NOT LATCHED — see `recoveryExhaustedReported`. The finding stays owed and is re-offered next
    // sweep, exactly as `conciergeNotifier` instructs its callers.
    log.warn("resurrection", "recovery is exhausted and the concierge could not be told", {
      agentId: d.agentId,
    });
    return;
  }
  recoveryExhaustedReported.set(d.agentId, d.diedAt);
  log.info("resurrection", "handed an unrecoverable agent to the concierge", {
    agentId: d.agentId,
    attempts: d.attemptsAt.length,
  });
}

/**
 * Record ONE refusal — the outcome line, plus the concierge hand-off when the refusal is terminal.
 *
 * ── WHY THIS IS A FUNCTION AND NOT TWO CALL SITES ─────────────────────────────────────────────
 * The sweep refuses an agent in TWO structurally different places, and which one an agent lands in
 * depends on something entirely unrelated to its own state: `groupCohorts` discards a run below
 * `SHARED_FAILURE_MIN_VICTIMS` ("a lone death with no linked neighbour is not an incident"), so a
 * solo death never enters the cohort loop at all and is refused in the admission loop instead.
 *
 * That is exactly the shape this repo files under "one fix, N call sites": the escalation was first
 * wired into the cohort loop only, and every assertion about it passed EXCEPT the ones driving a
 * single dead agent — which is the founder's own case, since his workers die one at a time. One
 * implementation, called from both, removes the possibility of that asymmetry rather than relying on
 * whoever edits next to notice it.
 */
function pushRefusal(
  outcomes: ResurrectionOutcome[],
  d: DueAgent,
  reason: NoResurrectReason | "no-agent-row",
  escalate: (text: string) => boolean,
): void {
  // THE LADDER'S ONLY TERMINUS NOW REACHES SOMEBODY. Every other refusal here either clears by
  // itself or is a fact about what the agent IS; this one is the moment automatic recovery stopped
  // trying, and the row has just been de-redded on the promise that something else is acting.
  if (reason === "daily-cap-spent") reportRecoveryExhausted(d, escalate);
  outcomes.push({ agentId: d.agentId, action: "none", detail: reason });
}

function memberOf(d: DueAgent): CohortMember {
  return {
    agentId: d.agentId,
    cause: d.cause,
    // VERBATIM, and `null` is normalized to `undefined` only because that is what crosses the
    // serde boundary as "absent". Never trimmed or re-cased: grouping is exact-equality.
    message: d.message ?? undefined,
    epoch: d.epoch,
    diedAt: d.diedAt,
    attempts: d.attemptsAt.length,
  };
}

/**
 * One pass over every agent the ledger says is due.
 *
 * Exported (not just driven by the interval) so a caller can force a pass, and so the tests drive
 * the real thing rather than a re-implementation. NEVER THROWS: a failure on one agent must not stop
 * the sweep reaching the others, and a failure anywhere must not take down a recovery mechanism.
 */
export async function sweepResurrections(
  options: ResurrectionSweepOptions = {},
): Promise<ResurrectionOutcome[]> {
  const o = liveOptions(options);
  const outcomes: ResurrectionOutcome[] = [];

  let due: DueAgent[];
  let liveIds: Set<string>;
  try {
    // Both reads before any decision, so the whole sweep judges ONE consistent snapshot. Reading
    // the live-session set per agent would let a spawn we ourselves started land between two
    // agents' checks and be missed by the second.
    [due, liveIds] = await Promise.all([
      o.due(),
      o.liveSessions().then((ids) => new Set(ids)),
    ]);
  } catch (e) {
    log.warn("resurrection", "could not read the due list", { error: String(e) });
    return outcomes;
  }

  // ── THE MOUNT CEILING (bead sparkle-5j6re3), READ ONCE FOR THE WHOLE SWEEP ───────────────────
  // The fleet the per-mount layout cost scales with. Every new `AgentPane` mount forces a
  // full-document layout across every OTHER mounted pane (sparkle-gw36j), so an app restart that
  // leaves hundreds of agents due turns resurrection into an O(N) layout paid once per mount — the
  // storm this bead exists to end. `newMountHeadroom` is how many BRAND-NEW panes this sweep may
  // still add before the fleet reaches `MAX_MOUNTED_PANES_FOR_RESURRECTION`; the selection loops
  // below spend it, counting ONLY new-pane (route 2) mounts — a route-1 restart of an
  // already-mounted pane adds no pane and pays no layout, so the common one-at-a-time death still
  // recovers on a full fleet. Refused agents are not dropped: they stay due (the Rust ledger
  // republishes every scan) and return on the next app run or once each mount is cheap again.
  const mountedNow = new Set(o.mountedPaneIds());
  const newMountHeadroom = Math.max(0, MAX_MOUNTED_PANES_FOR_RESURRECTION - mountedNow.size);
  let newMountsPlanned = 0;
  // Reserve a mount slot against the ceiling, returning whether the caller may proceed. An agent
  // already in the pane registry recovers via a cheap route-1 restart (no new pane, no layout) and
  // always passes; a brand-new pane passes only while headroom remains, and consumes one slot when
  // it does. Callers that get `false` refuse the agent WITHOUT spending the sweep's respawn budget —
  // one shared definition so the cohort loop and the lone-death loop cannot drift, and so a backlog
  // of new-pane deaths can never starve the cheap route-1 restarts of the whole budget.
  const reserveMount = (agentId: string): boolean => {
    if (mountedNow.has(agentId)) return true;
    if (newMountsPlanned >= newMountHeadroom) return false;
    newMountsPlanned += 1;
    return true;
  };

  // ── the two gates that are about THIS WINDOW, applied before anything is grouped ────────────
  const mine: DueAgent[] = [];
  for (const d of due) {
    // A project displayed by a torn-off satellite is not ours to mount — the same ownership gate
    // Workspace's `live` memo applies, and for the same reason: two webviews mounting one agent id
    // means `pty_spawn`'s `sessions.insert` orphans one of the two children.
    if (o.projectTornOut(d.projectId)) {
      outcomes.push({ agentId: d.agentId, action: "none", detail: "project-torn-out" });
      continue;
    }
    if (!o.ownsProject(d.projectId)) {
      outcomes.push({ agentId: d.agentId, action: "none", detail: "not-this-window" });
      continue;
    }
    // A LIVE AGENT STAYS IN THIS LIST, AND THAT IS DELIBERATE — see the election gate below.
    //
    // Filtering it out here (which is what this code did first) looks obviously right and is
    // wrong, because it changes cohort MEMBERSHIP rather than admission eligibility, and
    // `groupCohorts` discards any cluster below `SHARED_FAILURE_MIN_VICTIMS` (2). For the most
    // common cohort size — exactly two victims — the moment the canary is mounted and its PTY goes
    // live the cohort drops to ONE member, vanishes from `groups`, its phase and burned set are
    // deleted by the prune below, and the survivor falls through as a "lone death" and is respawned
    // IMMEDIATELY, while the canary is still mid-probation and has proven nothing. That is exactly
    // the retry-into-a-closed-door this module exists to prevent, reintroduced by the guard against
    // it. For larger cohorts it is subtler and just as bad: removing the earliest death re-anchors
    // `groupCohorts`'s span split, so a cluster can re-split into a group carrying two different
    // prior bindings — `priorKeys.size === 2`, a fresh key, no `supersedes` entry, and the in-flight
    // `released` evidence orphaned (the starvation `stabilizeCohortKeys` documents).
    mine.push(d);
  }

  // ── AN ORPHANED LEDGER RECORD IS A NAMED, PERMANENT REFUSAL — NOT A CANARY ──────────────────
  //
  // An `agent-life` record whose projectStore row is gone can NEVER be brought back by this
  // mechanism: route 1 has no pane to restart and route 2 cannot mount an id that no `Project.agents`
  // array names. Treating it as an ordinary victim is what burned the founder's fleet — `electCanary`
  // prefers the OLDEST death, and an orphaned record is exactly that, so an orphan is the MOST
  // likely canary. It "spawns" instantly, proves nothing for 180 seconds, fails on
  // `no-turn-authority`, and rotates. Three of those and the whole cohort is `abandoned`.
  //
  // So it is handled the way `PERMANENT_NO_RESURRECT` reasons are: excluded from election, counted
  // as permanently unfit, and reported BY NAME so a human reading the log sees `no-agent-row` rather
  // than a cohort phase. Computed ONCE per sweep, before grouping, because the answer is the same for
  // the cohort pre-pass and the lone-death loop and asking twice invites the two to disagree.
  //
  // MEMBERSHIP IS NOT TOUCHED. An orphan stays in `mine`, so `groupCohorts` still sees it and the
  // cohort keeps its identity and its 2-victim floor — the same reason a LIVE agent stays in the list
  // (see the note by `mine.push`). Only eligibility changes.
  //
  // THE LEDGER RECORD IS DELIBERATELY LEFT ALONE. `agent_life`'s retire path would stop it being
  // republished on every 5s scan forever, which is the tidy answer, and it is the wrong risk to take
  // from here: `agentRowPresent` can only fail OPEN (see its docstring), a retire is DURABLE and
  // irreversible, and this sweep would be writing the record off on the strength of one webview's
  // view of a store another window may hold differently. A record that is merely re-listed costs one
  // comparison per scan; a wrongly retired one is unrecoverable. Left to the Rust side, which can see
  // the whole machine rather than one window.
  const orphaned = new Set<string>();
  for (const d of mine) if (!o.hasAgentRow(d.agentId)) orphaned.add(d.agentId);

  const byId = new Map(mine.map((d) => [d.agentId, d]));
  const groups0 = groupCohorts(mine.map(memberOf));
  const { groups, binding, supersedes } = stabilizeCohortKeys(cohortBinding, groups0);
  cohortBinding = binding;

  // CARRY THE EVIDENCE ACROSS A RE-KEY, WITHOUT CARRYING THE IDENTITY.
  //
  // `stabilizeCohortKeys` mints a fresh key when a cohort GAINS a member, and says which key it
  // supersedes. Discarding the old phase there is what starved the drain: one trickling death
  // mid-release sends 40 already-vetted agents back through a full probation, and since the next
  // tick re-binds everyone again, a steady drip admits nothing but canaries and the drain never
  // finishes. So a `released` phase whose canary is still proven is carried forward — the newcomers
  // simply join the drain queue, which the `drained` list already bounds correctly.
  //
  // ONLY `released` is carried. A probation in flight is evidence about a canary, not about the
  // newcomers, and inheriting it would leave a cohort waiting on a window that is already over.
  for (const [fresh, prior] of supersedes) {
    const phase = cohortPhases.get(prior);
    if (phase?.phase === "released") cohortPhases.set(fresh, phase);
    const burned = burnedCanaries.get(prior);
    if (burned) burnedCanaries.set(fresh, new Set(burned));
    const attempts = cohortAttempts.get(prior);
    if (attempts !== undefined) cohortAttempts.set(fresh, attempts);
  }

  // Forget cohorts that no longer exist, so the maps cannot grow for the life of the app.
  const liveKeys = new Set(groups.keys());
  for (const key of [...cohortPhases.keys()]) if (!liveKeys.has(key)) cohortPhases.delete(key);
  for (const key of [...burnedCanaries.keys()]) if (!liveKeys.has(key)) burnedCanaries.delete(key);
  for (const key of [...cohortAttempts.keys()]) if (!liveKeys.has(key)) cohortAttempts.delete(key);

  const inCohort = new Set<string>();
  const admissible: Array<{ due: DueAgent; cohortKey?: string }> = [];
  /** Everything this sweep has already decided to admit, across ALL cohorts and lone deaths. */
  let planned = 0;

  for (const [key, cohort] of groups) {
    for (const m of cohort) inCohort.add(m.agentId);

    let phase =
      cohortPhases.get(key) ??
      ({
        phase: "observed",
        victims: cohort.map((m) => m.agentId),
        since: o.now,
      } as CohortPhase);

    /** Who may NOT be elected: burned canaries, plus anyone whose PTY is already live.
     *
     *  THIS IS WHERE LIVENESS BELONGS — at election, not at membership (see the note above the
     *  `mine.push`). `electCanary` picks the OLDEST death, and the oldest death is exactly the one
     *  most likely to have already been brought back by something else: a stale record, another
     *  window's respawn, a straggler from the dying app. Electing it produces a canary that can
     *  never be admitted, and `decideCohortAdmission` then returns that one id and nobody else. */
    const unelectable = new Set([...(burnedCanaries.get(key) ?? []), ...liveIds]);
    // …and anyone the PER-AGENT gate refuses for a reason that will never resolve on its own.
    //
    // Computed for the whole cohort BEFORE any election, not just checked on a stored
    // `canary-elected`, because the very first sweep elects through the `observed` branch — so a
    // check that only ran on a stored phase would still elect an unadmittable canary once and stall
    // for a whole interval before noticing.
    //
    // `daily-cap-spent` is the case that matters, and it is not exotic: it is the only TERMINAL
    // bound `decideResurrection` has, and the agent carrying it is the MOST likely to be elected
    // because `electCanary` prefers the oldest death and a flapping agent that has burned its 24
    // attempts is exactly that. `waiting-for-next-rung` and `wall-not-yet-reset` are deliberately
    // absent: those clear by themselves, and rotating over them would burn victims for nothing.
    /** Why a member was passed over, for its outcome line. Both permanent and transient refusals
     *  land here — a human asking "why was this row left alone" wants `daily-cap-spent`, not
     *  `cohort-canary-elected`. Only {@link permanentlyUnfit} feeds the abandonment decision. */
    const refusedReason = new Map<string, NoResurrectReason | "no-agent-row">();
    /** Members that will never be victims again. The ONLY refusals allowed to influence whether a
     *  cohort is given up on. */
    const permanentlyUnfit = new Set<string>();
    for (const m of cohort) {
      const member = byId.get(m.agentId);
      if (member === undefined) {
        unelectable.add(m.agentId);
        permanentlyUnfit.add(m.agentId);
        continue;
      }
      // Checked BEFORE `decideResurrection`, because the per-agent gate would happily approve an
      // orphan — it reasons about causes, clocks and attempt counts, none of which know anything
      // about whether a pane can exist at all. The structural fact wins.
      if (orphaned.has(m.agentId)) {
        unelectable.add(m.agentId);
        permanentlyUnfit.add(m.agentId);
        refusedReason.set(m.agentId, "no-agent-row");
        continue;
      }
      const probe = decideResurrection(
        resurrectionInputFor(member, liveIds.has(m.agentId), o.now),
      );
      if (probe.action !== "none") continue;
      if (PERMANENT_NO_RESURRECT.has(probe.reason)) {
        unelectable.add(m.agentId);
        permanentlyUnfit.add(m.agentId);
        refusedReason.set(m.agentId, probe.reason);
      } else if (TRANSIENT_NO_RESURRECT.has(probe.reason)) {
        // Excluded from election this sweep, and NOT written down anywhere.
        unelectable.add(m.agentId);
        refusedReason.set(m.agentId, probe.reason);
      } else {
        // Any OTHER decline — `waiting-for-next-rung`, `wall-not-yet-reset` — clears on its own, so
        // it must NOT make the member unelectable (rotating over a member that just needs to wait
        // would burn victims for nothing). But it is recorded so the member loop refuses it BY
        // REASON before it can reserve a mount slot it cannot use this sweep (bead sparkle-5j6re3):
        // an elected canary the gate declines for a timing reason would otherwise consume the
        // ceiling's headroom every sweep and starve a revivable agent behind it, then be declined
        // again in the final loop. It reserves nothing now and mounts as soon as its rung clears.
        refusedReason.set(m.agentId, probe.reason);
      }
    }

    // ── A STORED `canary-elected` IS THE ONE PHASE NOTHING RE-DERIVES ──────────────────────────
    //
    // `probation`, `failed` and `observed` are all advanced below; a stored `canary-elected` is
    // used VERBATIM. So once a canary becomes unadmittable AFTER being elected, the cohort stalls
    // permanently: `decideCohortAdmission` keeps returning that id, the member loop never matches
    // it, and every other member reports `cohort-canary-elected` on every sweep — with no log, no
    // abandonment and no expiry. `stabilizeCohortKeys` deliberately preserves the key when the
    // anchor member departs, so the phase is carried forward rather than reset by the prune.
    //
    // Every route here is ordinary, not exotic: `admit` returned `claimed-elsewhere` and the other
    // window respawned it; `capacity` was 0 that tick; `decideResurrection` refused it on
    // `waiting-for-next-rung` or `daily-cap-spent`; or a human clicked "Start again" on that pane,
    // which reopens its record and drops it from `due` entirely.
    //
    // Burning it is right in all of them: an agent that is live, or gone from the death list, is
    // not a victim any more, so it cannot be the sample the rest of the cohort is waiting on.
    if (phase.phase === "canary-elected") {
      // Captured out of the narrowed phase before the reassignment below: `phase` is a `let`, so
      // writing to it inside this block widens the union back and every later `phase.canaryId`
      // stops compiling.
      const electedId = phase.canaryId;
      // WHY it cannot serve, not merely THAT it cannot — a human reading the log needs to tell the
      // answers apart. `unelectable` already carries every reason computed above.
      const unfit: string | undefined = !cohort.some((m) => m.agentId === electedId)
        ? "left-the-due-list"
        : liveIds.has(electedId)
          ? "already-live"
          : unelectable.has(electedId)
            ? (refusedReason.get(electedId) ?? "refused")
            : undefined;
      if (unfit !== undefined) {
        // NOTHING IS WRITTEN DOWN HERE. Every reason this branch fires — the canary went live, left
        // the due list, or was refused — has ALREADY put the id into `unelectable` for this sweep,
        // and every one of them is re-derived from scratch on the next sweep. Burning it durably
        // would be recording a per-sweep fact in a permanent place, which is the exact defect this
        // module has now hit twice (`liveIds` folded into `burnedCanaries`, and `daily-cap-spent`
        // treated as terminal). `burnedCanaries` is for canaries that actually FAILED A PROBATION,
        // and the `failed` branch below is the only thing that writes it.
        unelectable.add(electedId);
        log.info("resurrection", "re-electing a canary that can no longer serve", {
          cohort: key,
          canaryId: electedId,
          why: unfit,
        });
        phase = { phase: "observed", victims: cohort.map((m) => m.agentId), since: o.now };
      }
    }

    // ADVANCE FIRST, then decide who may go. A probation that has just failed must elect its next
    // canary in the SAME sweep, or every failure costs a whole extra interval.
    if (phase.phase === "probation") {
      phase = advanceProbation(
        phase,
        o.probationEvidence(phase.canaryId, phase.spawnedAt, o.now),
        o.now,
      );
    }
    if (phase.phase === "failed") {
      const burned = burnedCanaries.get(key) ?? new Set<string>();
      burned.add(phase.canaryId);
      burnedCanaries.set(key, burned);
      unelectable.add(phase.canaryId);
      // THE BUDGET LIVES HERE, not in the phase. A probation has just failed, so record it before
      // anything can drop the phase back to `observed` and lose the count.
      cohortAttempts.set(key, Math.max(cohortAttempts.get(key) ?? 0, phase.attempt));
      log.warn("resurrection", "a canary failed its probation", {
        cohort: key,
        canaryId: phase.canaryId,
        why: phase.why,
        attempt: phase.attempt,
      });
      // `unelectable`, not `burned`: a re-election must skip a live agent too, or `afterFailure`
      // hands the cohort a successor that can never be admitted and the stall returns one layer up.
      phase = afterFailure(phase, cohort, unelectable, o.now);
    }
    if (phase.phase === "observed") {
      // The next attempt is derived from the FAILURE count, so it survives every route back to
      // `observed` — the unelectable-this-sweep downgrade below, and a re-election. Without this the
      // budget restarts at 1 whenever a sweep happens to find nobody electable, and a 12-victim
      // cohort burns its members one at a time through three-minute probations against a door it
      // already knows is shut, escalating only once every member is gone.
      const nextAttempt = (cohortAttempts.get(key) ?? 0) + 1;
      if (nextAttempt > MAX_CANARY_ATTEMPTS) {
        phase = { phase: "abandoned", at: o.now, why: `${MAX_CANARY_ATTEMPTS} canaries failed` };
      } else {
        const canaryId = electCanary(cohort, unelectable);
        phase =
          canaryId === null
            ? { phase: "abandoned", at: o.now, why: "no untried victim remains" }
            : { phase: "canary-elected", canaryId, electedAt: o.now, attempt: nextAttempt };
      }
    }

    // ── NOBODY ELECTABLE IS NOT THE SAME AS NOBODY LEFT ─────────────────────────────────────────
    //
    // `electCanary` returning null means nobody could be elected THIS SWEEP, and `unelectable` is
    // seeded from `liveIds` and the transient refusals as well as the burned set — so a cohort whose
    // members are all currently live, or all momentarily over the rolling daily cap, produces
    // exactly that. `abandoned` is a phase nothing re-derives: it is sticky for the life of the key,
    // `decideCohortAdmission` returns `[]` forever, and the cohort is unrecoverable without a human.
    //
    // Giving up is only honest when every member is GENUINELY finished — burned by a failed
    // probation, or permanently unfit. Otherwise the cohort simply waits, which is what it did
    // before any of this existed. A canary budget that has been spent (`MAX_CANARY_ATTEMPTS`) is a
    // real abandonment and keeps its own `why`, so it is deliberately not caught here.
    if (phase.phase === "abandoned" && phase.why === "no untried victim remains") {
      const burned = burnedCanaries.get(key) ?? new Set<string>();
      const everyoneFinished = cohort.every(
        (m) => burned.has(m.agentId) || permanentlyUnfit.has(m.agentId),
      );
      if (!everyoneFinished) {
        phase = { phase: "observed", victims: cohort.map((m) => m.agentId), since: o.now };
      }
    }
    // ── AN ORPHANED COHORT IS NOT AN ABANDONED ONE ──────────────────────────────────────────────
    //
    // `permanentlyUnfit` feeds `everyoneFinished` above, so without this an all-orphan cohort walks
    // straight to `abandoned` — a sticky phase that fires a "N agents could not be brought back"
    // notification and gives up on the key for good. That is precisely the failure this change
    // exists to end, reached by the guard against it: two full cohort abandonments in one day on the
    // founder's install, both from cohorts that were never revivable in the first place.
    //
    // `abandoned` means "canaries were sent and the door stayed shut — a human is needed". Nothing
    // was sent here, and there is nothing for a human to click: the ledger record simply outlived its
    // UI row. So the cohort goes back to waiting, which is what it did before any of this existed,
    // and the per-agent `no-agent-row` outcomes below are what actually tell the story.
    //
    // NARROW ON PURPOSE — `every`, not `some`. A mixed cohort whose real victims burned their
    // probations IS honestly abandoned, and suppressing that would hide a genuinely shut door behind
    // one stale record.
    if (phase.phase === "abandoned" && cohort.every((m) => orphaned.has(m.agentId))) {
      phase = { phase: "observed", victims: cohort.map((m) => m.agentId), since: o.now };
    }
    // GIVING UP HAS TO BE SAID OUT LOUD (roborev 60241). `abandoned` is the state the engine
    // documents as "give up and ask a human", and the phase is sticky for as long as the key
    // lives — so a whole cohort stops being recoverable. Reporting it only through the returned
    // `outcomes` told nobody: the interval caller discards the return value. That is precisely the
    // "an agent sits dead and nobody is told" failure this feature was built to end, re-created
    // inside the recovery mechanism.
    if (phase.phase === "abandoned" && cohortPhases.get(key)?.phase !== "abandoned") {
      const stranded = cohort.map((m) => m.agentId);
      log.warn("resurrection", "gave up on a cohort — a human is needed", {
        cohort: key,
        why: phase.why,
        stranded: stranded.length,
        agentIds: stranded,
      });
      // THE COPY BRANCHES ON EVIDENCE, NOT ON THE `why` STRING.
      //
      // Keying it on `why` was wrong because `"no untried victim remains"` has TWO causes, and the
      // common one is the opposite of what it implies: `afterFailure` returns it whenever
      // `electCanary` comes back null AFTER a probation failure, which is the ordinary exhaustion
      // path for a 2-victim cohort (A fails, B elected, B fails, nobody left). Both canaries WERE
      // sent, and the copy told the human none of them had been — pointing them at "these agents
      // are done or blocked" when the truth is "the door is still shut".
      //
      // The burned set is the actual record of who was sent, so it is what the sentence is built
      // from. Zero burned genuinely means nobody could be tried.
      const sent = burnedCanaries.get(key)?.size ?? 0;
      const body =
        sent === 0
          ? `Automatic recovery gave up: none of these agents could be sent as a test case. They died of the same cause, and each is either finished, waiting on a person, or unclassifiable.`
          : `Automatic recovery gave up: ${phase.why}. They died of the same cause, and ${
              sent === 1 ? "the canary" : `all ${sent} canaries`
            } sent to test it failed.`;
      notifyAttention({
        projectId: byId.get(stranded[0] ?? "")?.projectId ?? "",
        agentId: stranded[0] ?? "",
        title: `${stranded.length} agents could not be brought back`,
        body,
      });
    }
    cohortPhases.set(key, phase);

    // BUDGETED ACROSS THE WHOLE SWEEP, not per cohort (roborev 60241). Deriving capacity from
    // `inFlight.size` here was self-defeating: `inFlight` is not written until the admission loop
    // BELOW, so every cohort in one sweep saw the full budget and three released cohorts admitted
    // 3 x RELEASE_BATCH in one tick. `planned` is the running count of everything this sweep has
    // already decided to admit, so the bound is what it claims to be.
    const capacity = Math.max(0, MAX_RESPAWNS_PER_SWEEP - planned);
    const allowed = decideCohortAdmission(phase, cohort, capacity, o.now);
    const allowedSet = new Set(allowed);
    for (const m of cohort) {
      const d = byId.get(m.agentId);
      if (d === undefined) continue;
      // A live member is refused by NAME rather than by cohort phase. It is kept in the cohort so
      // membership and identity stay stable (see the note by `mine.push`), but "its PTY is already
      // running" is a more useful answer than "its cohort is on probation" — and it must not spend
      // any of this sweep's budget, which is why `planned` is counted from real admissions below
      // rather than from `allowed.length`.
      if (liveIds.has(m.agentId)) {
        outcomes.push({ agentId: m.agentId, action: "none", detail: "already-live" });
        continue;
      }
      // A member the per-agent gate refused is reported BY THAT REASON rather than by its cohort's
      // phase — permanent or transient alike. "daily-cap-spent" is what a human needs to see;
      // "cohort-canary-elected" would be true and useless, and it is the row most likely to be
      // asked about.
      const terminal = refusedReason.get(m.agentId);
      if (terminal !== undefined) {
        // REFUSAL SITE 1 OF 2 — the cohort path, for an agent that died alongside neighbours. See
        // `pushRefusal` for why the escalation cannot live at either site alone.
        pushRefusal(outcomes, d, terminal, o.escalate);
        continue;
      }
      if (!allowedSet.has(m.agentId)) {
        outcomes.push({
          agentId: m.agentId,
          action: "none",
          detail: `cohort-${phase.phase}`,
        });
        continue;
      }
      // THE MOUNT CEILING, AT SELECTION (bead sparkle-5j6re3) — a new-pane admission that cannot
      // land must not consume this sweep's respawn budget, so it is refused here (before `planned`)
      // exactly like the live/refused/not-allowed cases above. See {@link reserveMount}.
      if (!reserveMount(m.agentId)) {
        outcomes.push({ agentId: m.agentId, action: "none", detail: "fleet-at-mount-ceiling" });
        continue;
      }
      admissible.push({ due: d, cohortKey: key });
      planned += 1;
    }
  }

  // A death with no linked neighbour is not an incident — `groupCohorts` correctly returns it in no
  // cohort, and it skips the canary entirely. One agent's death is that agent's bad luck.
  //
  // THEY ARE BOUNDED TOO, and this is the case `MAX_RESPAWNS_PER_SWEEP` was written for. Ten agents
  // dying within a minute with ten DISTINCT banner texts (different codes, different request ids)
  // fall below the 2-victim floor individually, so `groupCohorts` returns ten lone deaths, all of
  // which clear the same 60s rung together — the simultaneous-resume flood this feature exists to
  // prevent, reached by the one route the canary cannot cover. The `appRestart` replay cannot catch
  // it: its 54 agents share one epoch, so it only ever exercises a single cohort's own drain.
  for (const d of mine) {
    if (inCohort.has(d.agentId)) continue;
    // Refused BEFORE the cap is consulted, and it does not touch `planned`: an admission that cannot
    // possibly land must not push a revivable agent out of this sweep's budget.
    if (orphaned.has(d.agentId)) {
      outcomes.push({ agentId: d.agentId, action: "none", detail: "no-agent-row" });
      continue;
    }
    // PROBE THE PER-AGENT GATE BEFORE RESERVING A MOUNT SLOT (bead sparkle-5j6re3). The cohort loop
    // gets this from its election pre-pass; the lone-death path has none, so without this probe an
    // agent the gate will decline — `daily-cap-spent` (stable for HOURS), `waiting-for-next-rung`,
    // `wall-not-yet-reset` — would reserve one of the ceiling's headroom slots, mount nothing, and,
    // because the due-list order is stable, starve a revivable agent behind it every sweep forever.
    // Refuse it here (which also spends no `planned`); the final loop re-checks as the double-spawn
    // backstop.
    const decision = decideResurrection(resurrectionInputFor(d, liveIds.has(d.agentId), o.now));
    if (decision.action === "none") {
      pushRefusal(outcomes, d, decision.reason satisfies NoResurrectReason, o.escalate);
      continue;
    }
    if (planned >= MAX_RESPAWNS_PER_SWEEP) {
      outcomes.push({ agentId: d.agentId, action: "none", detail: "sweep-cap" });
      continue;
    }
    // THE MOUNT CEILING, AT SELECTION (bead sparkle-5j6re3) — see {@link reserveMount}. Reached only
    // after the gate has APPROVED this agent, so a slot is reserved only for a mount that can happen;
    // a `false` here refuses the new pane without touching `planned`, so a backlog of new-pane deaths
    // cannot starve the cheap route-1 restarts later in the stable due-list order.
    if (!reserveMount(d.agentId)) {
      outcomes.push({ agentId: d.agentId, action: "none", detail: "fleet-at-mount-ceiling" });
      continue;
    }
    planned += 1;
    admissible.push({ due: d });
  }

  const pending: Promise<void>[] = [];
  for (const { due: d, cohortKey } of admissible) {
    if (inFlight.has(d.agentId)) {
      outcomes.push({ agentId: d.agentId, action: "none", detail: "admission-in-flight" });
      continue;
    }

    // ── THE PROCESS-GLOBAL DOUBLE-SPAWN BACKSTOP ─────────────────────────────────────────────
    //
    // `decideResurrection` already requires `processAlive === false`, and the ownership election
    // already stops two WINDOWS acting on one agent. Both are window-local evidence. This is the
    // reading neither can provide: `pty_live_sessions` answers from the PROCESS's own session map,
    // and the PTY host is app-global — `pty_spawn` from any webview reaches any agent id.
    //
    // Getting this wrong is the worst failure available here. `pty.rs`'s `sessions.insert` REPLACES
    // silently, so a second spawn for one id drops the first `PtySession` on the floor: its child
    // keeps running, keeps holding its worktree, keeps burning tokens, and is invisible to every
    // surface in the app because nothing holds a handle to it any more.
    const processAlive = liveIds.has(d.agentId) ? true : false;

    const decision = decideResurrection(resurrectionInputFor(d, processAlive, o.now));

    if (decision.action === "none") {
      // REFUSAL SITE 2 OF 2 — the admission path, and the one a SOLO death always takes, because
      // `groupCohorts` discards a run below `SHARED_FAILURE_MIN_VICTIMS`. The founder's workers die
      // one at a time, so this is the site his case actually runs through. See `pushRefusal`.
      pushRefusal(outcomes, d, decision.reason satisfies NoResurrectReason, o.escalate);
      continue;
    }

    const outcome: ResurrectionOutcome = {
      agentId: d.agentId,
      action: "respawn",
      detail: `attempt ${decision.attempt}`,
    };
    outcomes.push(outcome);
    inFlight.add(d.agentId);
    pending.push(
      admit(d, decision.attempt, cohortKey, o, outcome).finally(() => {
        inFlight.delete(d.agentId);
      }),
    );
  }

  await Promise.all(pending);
  return outcomes;
}

/**
 * Perform one admission: take the claim, let the pane mount, hold the goal sweep off it, give the
 * claim back.
 *
 * ORDER IS LOAD-BEARING. The claim comes FIRST, because it is the only cross-PROCESS exclusion there
 * is — two app instances (or one instance and a stale claim from a dead one) can otherwise both
 * decide to respawn the same agent, and `claim_at` refusing a live holder is what stops them. The
 * release comes LAST and records the attempt durably, which is the number the rolling daily cap
 * counts; recording it earlier would spend an attempt on a respawn that never happened.
 */
async function admit(
  d: DueAgent,
  attempt: number,
  cohortKey: string | undefined,
  o: Required<ResurrectionSweepOptions>,
  outcome: ResurrectionOutcome,
): Promise<void> {
  // ASSUME WE OWN THE CLAIM THE MOMENT WE ASK FOR IT (roborev 60246).
  //
  // `claimed = await o.claim(...)` looks like the careful version and is the leaky one: the invoke
  // can REJECT after the record was already written — a lost or timed-out ack is a documented
  // failure shape for these commands — and then nothing here ever learns it owns the claim, so the
  // `finally` skips the release. The record stays `Claimed` by this live epoch, and the ledger's
  // claim gate hides that agent for as long as the gate's staleness window allows.
  //
  // Releasing a claim we may not hold is harmless: `release_at` refuses a claim held by a DIFFERENT
  // live epoch, and clearing our own non-existent one is a no-op. Failing to release one we DO hold
  // is not harmless. So the flag is set before the await, not after it.
  let claimed = true;
  try {
    claimed = await o.claim(d.agentId);
    if (!claimed) {
      outcome.action = "none";
      outcome.detail = "claimed-elsewhere";
      return;
    }

    // ── EVERYTHING BELOW IS CONDITIONAL ON THE MOUNT HAVING LANDED ─────────────────────────────
    //
    // A mount that did not land must leave NO trace: no `respawn` outcome, no durable attempt (the
    // `finally` reads `outcome.action`, so returning here releases with `spawned: false`), no
    // `probation` transition, and no append to a released cohort's `drained`. Each of those is a
    // cost the founder's fleet paid nine times for respawns that never happened — the durable attempt
    // is one of 24 per agent per day, and the probation is what rotated the canary into abandonment.
    //
    // This is the LAST line of defence, not the first: the sweep already refused every orphan by name
    // above. It still has to be here, because `hasAgentRow` fails open on an unrehydrated store and
    // because a row can be deleted between the pre-gate and this call.
    // FAILS CLOSED: anything that is not a POSITIVE report of a landed mount counts as "did not
    // land" (roborev 61711). Testing `=== "no-agent-row"` was an allow-list of one — an injected
    // stub returning nothing, a partial mock, or a `MountResult` variant added later all read as
    // `undefined` and sailed through, booking a durable attempt and a probation for a mount that
    // never happened. That is the exact failure this block exists to stop, reachable through the
    // block itself. On the last line of defence the safe default is refusal.
    const mounted = o.mount(d.agentId);
    if (mounted !== "restarted" && mounted !== "opened") {
      outcome.action = "none";
      outcome.detail = mounted === "no-agent-row" ? "no-agent-row" : "mount-did-not-land";
      log.warn("resurrection", "nothing to mount — the agent's row is gone", {
        agentId: d.agentId,
        cause: d.cause,
        projectId: d.projectId,
        cohort: cohortKey,
      });
      return;
    }
    // WHICH ROUTE RAN, in the line a human reads. `restarted` means a real pane lever was pulled;
    // `opened` means a row exists and Workspace will mount one. Neither can be reported by a mount
    // that did nothing, which is the whole point of the seam returning a value.
    outcome.detail = `attempt ${attempt} (${mounted})`;

    // THE COLLISION WITH THE GOAL SWEEP, CLOSED HERE (see suppressContinuation).
    //
    // The pane mounts and then sits idle while `claude --resume` boots. At `IDLE_SETTLE_MS` (45s)
    // the goal sweep would see a goal-carrying agent continuously at rest and type a continue into
    // it — spending one of its 20 continues on a turn it never needed, and, if this agent is a
    // canary, MANUFACTURING the `hasTurnAuthority` and `didWork` evidence its whole cohort is
    // waiting on. Held for the full probation window whether or not this agent is the canary: the
    // boot takes just as long either way.
    o.suppress(d.agentId, o.now + PROBATION_MS);

    if (cohortKey !== undefined) {
      const phase = cohortPhases.get(cohortKey);
      if (phase?.phase === "canary-elected" && phase.canaryId === d.agentId) {
        cohortPhases.set(cohortKey, {
          phase: "probation",
          canaryId: d.agentId,
          spawnedAt: o.now,
          attempt: phase.attempt,
        });
      } else if (phase?.phase === "released") {
        cohortPhases.set(cohortKey, { ...phase, drained: [...phase.drained, d.agentId] });
      }
    }

    log.info("resurrection", "respawned a dead agent", {
      agentId: d.agentId,
      cause: d.cause,
      // The route, so this line stops being unfalsifiable. Nine of these were written on the
      // founder's install for agents whose `pty_spawn` count was zero.
      via: mounted,
      attempt,
      cap: MAX_RESURRECTS_PER_AGENT_PER_DAY,
      cohort: cohortKey,
    });
  } catch (e) {
    outcome.action = "none";
    outcome.detail = "threw";
    log.warn("resurrection", "respawn threw", { agentId: d.agentId, error: String(e) });
  } finally {
    // RELEASED ON BOTH PATHS, and `spawned` says which. A claim we took and did not give back would
    // return `HeldLive` to every other window for as long as this epoch lives; an attempt recorded
    // for a respawn that threw would spend a rung the agent never got.
    if (claimed) {
      try {
        await o.release(d.agentId, outcome.action === "respawn");
      } catch (e) {
        log.warn("resurrection", "could not release the claim", {
          agentId: d.agentId,
          error: String(e),
        });
      }
    }
  }
}

// ── SAY WHY, EVERY TIME ──────────────────────────────────────────────────────────────────────
//
// `sweepResurrections` has always returned a per-agent reason and `tick` has always thrown it away,
// so `already-live`, `daily-cap-spent`, `not-this-window`, `waiting-for-next-rung`,
// `cohort-probation` and `blocked-on-human` were invisible to everyone. The only lines this module
// ever wrote were about things it DID — which is the wrong half: "an agent sits dead and nobody is
// told" is the exact failure the whole feature exists to end, and the sweep was reproducing it one
// layer up. The founder asked for precisely this: when resurrection declines to revive something,
// it should say so and why.
//
// ON CHANGE, NOT ON EVERY TICK. The sweep runs every 15s, so a steady state — twelve agents parked
// on `blocked-on-human`, which can last days — would be 5,760 identical lines a day. That is not
// visibility; it is the same burial `revival.rs` inflicted on itself with its own change detection,
// and it would drown this module's `respawned a dead agent` and `gave up on a cohort` lines.

/**
 * The last summary this window emitted, as a stable signature.
 *
 * Seeded with the EMPTY sweep's signature deliberately: a machine with nothing due — the ordinary
 * case, and the one that runs for hours — must never write a line at all. A transition INTO empty
 * still logs once, because "everything that was stuck has cleared" is news.
 */
const NO_DECISIONS = "[]";
let lastDecisionSignature = NO_DECISIONS;

/** Test seam: forget what was last logged, so a test can drive the change detection from scratch. */
export function _resetResurrectionDecisionLogForTests(): void {
  lastDecisionSignature = NO_DECISIONS;
}

/**
 * Group one sweep's outcomes by reason and log them IF they differ from the last summary. Returns
 * whether a line was written, so the change detection can be asserted directly rather than only
 * through a spy on the logger.
 *
 * Every respawn collapses into one `respawn` bucket rather than keeping its `attempt N (route)`
 * detail: the attempt number changes on every retry, so keying the signature on it would defeat the
 * change detection for the one shape that retries — and each respawn already writes its own line
 * carrying both the attempt and the route.
 */
export function reportSweepDecisions(outcomes: readonly ResurrectionOutcome[]): boolean {
  const byReason = new Map<string, string[]>();
  for (const oc of outcomes) {
    const reason = oc.action === "respawn" ? "respawn" : oc.detail;
    const ids = byReason.get(reason);
    if (ids === undefined) byReason.set(reason, [oc.agentId]);
    else ids.push(oc.agentId);
  }
  // Sorted on BOTH axes, so a sweep that reaches the same conclusion about the same agents in a
  // different order is recognised as unchanged. Without it the due list's ordering — a BTreeMap walk
  // on the Rust side, re-grouped here — would re-log a steady state.
  const grouped = [...byReason]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([reason, ids]) => [reason, [...ids].sort()] as const);
  const signature = JSON.stringify(grouped);
  if (signature === lastDecisionSignature) return false;
  lastDecisionSignature = signature;

  if (grouped.length === 0) {
    log.info("resurrection", "nothing is due for resurrection any more");
    return true;
  }
  log.info("resurrection", "resurrection sweep decisions", {
    total: outcomes.length,
    // reason → { count, agentIds }, which is what a human actually asks for: not "six agents were
    // skipped" but "these two are waiting on a person, these three have spent today's cap, and this
    // one has no row left".
    reasons: Object.fromEntries(
      grouped.map(([reason, ids]) => [reason, { count: ids.length, agentIds: ids }]),
    ),
  });
  return true;
}

// ── The mount ────────────────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/**
 * Start the sweep. Returns a teardown. Idempotent: a second call replaces the first interval rather
 * than running two.
 *
 * Mounted once, app-level, the same shape `startGoalContinuationRunner` uses and for the same
 * reason: a death belongs to an AGENT and one sweep serves the whole fleet, so a per-pane timer
 * would multiply the work to reach an identical conclusion — and, unlike a status poll, would
 * multiply the RESPAWNS.
 */
export function startResurrectionRunner(
  intervalMs: number = RESURRECT_SWEEP_INTERVAL_MS,
  /** Passed straight through to every sweep. Exists so a test can drive the REAL tick — including
   *  the real `reportSweepDecisions` call below — rather than a re-implementation of it. The app
   *  passes nothing, so production takes every default. */
  options: ResurrectionSweepOptions = {},
): () => void {
  stopResurrectionRunner();
  const tick = async () => {
    // A sweep awaits its claims, so a slow ledger write can outlast the interval. Overlapping ticks
    // would each read the pre-admission phase state.
    if (sweeping) return;
    sweeping = true;
    try {
      // THE RETURN VALUE IS THE POINT. Discarding it is what made every refusal invisible.
      reportSweepDecisions(await sweepResurrections(options));
    } catch (e) {
      log.warn("resurrection", "resurrection sweep failed", { error: String(e) });
    } finally {
      sweeping = false;
    }
  };
  // NO immediate tick. `seal_stale_at` runs in the Rust launch path and the revival thread needs a
  // tick of its own to publish; a sweep at t=0 would read an empty due list and prove nothing.
  timer = setInterval(() => void tick(), intervalMs);
  return stopResurrectionRunner;
}

/** Stop the sweep (idempotent). Leaves the cohort phases alone — a remount should not hand a
 *  mid-probation cohort a fresh canary and another three minutes. */
export function stopResurrectionRunner(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** Test/introspection helper: is the sweep armed? */
export function isResurrectionRunnerRunning(): boolean {
  return timer !== null;
}
