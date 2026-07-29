// A freshly spawned agent that has never been briefed is NEW, not BLOCKED.
//
// THE BUG. Spawn an agent and don't brief it. statusEngine never sees Claude's spinner (there is no
// turn to run), so it falls to the legacy time-based heuristic: settle to `idle` at 2500ms, then
// escalate to `blocked` at BLOCKED_MS (25s). `blocked` is RED (packages/ui/tokens.ts), so 25 seconds
// after spawn the row goes red, joins the cross-project red banding, and — via the concierge tool
// `get_agent_status` — reports `needsYou: true`. Nobody was asked anything.
//
// The root cause is that the stall timer cannot distinguish the two reasons an agent is quiet:
//   • quiet because it is WEDGED mid-task  → genuinely `blocked`, the human must unstick it.
//   • quiet because it has NOTHING TO DO   → not blocked on anything; it is waiting to be briefed.
// Both collapsed onto `blocked`, and on any fleet where agents are spawned ahead of being briefed
// that made red mean "an agent exists" rather than "an agent needs you" — which is how a constant
// stream of false "agent needs you" notifications gets produced.
//
// THE FIX, in two parts:
//   1. A distinct `new` status (GRAY) for "spawned, never briefed". It is a real member of the
//      status enum, not a colour special-case, so every consumer — the sidebar dot, the notification
//      set, the band taxonomy, `get_agent_status` — inherits it from one place and cannot disagree.
//   2. A 5-MINUTE BACKSTOP for anything part (1) cannot classify: within `NEW_AGENT_GRACE_MS` of
//      spawn, a briefless agent's red is held at `new`.
//
// WHAT THE BACKSTOP MUST NEVER DO IS SWALLOW A QUESTION. `waiting` and `approval` are the two
// statuses that constitute demonstrated evidence the agent drew something the human must answer:
// screenClassifier only produces them off an INTERACTIVE marker (the ❯ selection cursor, a picker
// footer, a shell prompt), never off prose, and the followup judge only produces them off a real
// finished-turn ask. Those go red immediately regardless of age or brief. The grace period applies
// to the states that carry no such evidence.
//
// SCOPE — everything here is gated on BOTH `createdAt` being present AND the agent being briefless:
//   • No `createdAt` → freshness cannot be established, so the agent is treated as OLD and nothing
//     changes. Legacy persisted rows (the field is optional) therefore keep their exact prior
//     behaviour, and no red can be retroactively calmed across a restart.
//   • Briefed → untouched, entirely. An agent that has been given work and then stalls or errors is
//     still your problem, at any age. This change cannot weaken red for any agent doing anything.
//
// Pure map overlay in the same family as engine/unmergedAttention.withUnmergedWork and
// engine/alertDismissal.withDismissedAlerts: same reference back when nothing changes (no render
// churn), never mutates its input. `now` is an injected parameter defaulting to `Date.now()` — the
// house style (see stores/conciergeApprovals.ts) — so the time-dependent rule is tested by passing
// a clock rather than by faking timers.
import type { AgentTabStatus } from "../types";
import { isRedStatus } from "../services/windowStatus";

/**
 * How long after spawn a briefless agent's unclassifiable red is held at `new`.
 *
 * Five minutes is a backstop, not the mechanism. The `blocked`/`idle` mapping below is not
 * time-limited at all (a never-briefed agent is never-briefed at any age); this window exists only
 * for reds that arrive by some path the taxonomy does not model, so that a brand-new row cannot go
 * red before the human has plausibly finished setting it up. After it lapses, those reds surface
 * normally — an agent that is genuinely broken must not stay hidden.
 */
export const NEW_AGENT_GRACE_MS = 5 * 60_000;

/** The fields this overlay reads. Structural, so callers pass `AgentTab` (or a test double) with no
 *  adapter and nothing here depends on the rest of the agent record. */
export interface BriefableAgent {
  id: string;
  /** The most recent prompt the human submitted. Empty string on a fresh row. */
  lastPrompt?: string;
  /** Every prompt ever submitted to this agent. Empty on a fresh row. */
  promptHistory?: readonly unknown[];
  /** For workers: the one-shot task its orchestrator assigned. That IS the worker's brief. */
  task?: string;
  /** For "shell" (Run-as-command) tabs: the command the tab runs. That IS its brief. */
  shellCommand?: string | null;
  /** Epoch ms at spawn. Absent on legacy persisted rows — see SCOPE in the module header. */
  createdAt?: number;
  /** Epoch ms of the first line the user submitted straight into this agent's terminal. PERSISTED
   *  (types.ts), which is what makes route 5 survive a relaunch when route 4 cannot. */
  terminalBriefedAt?: number;
}

const blank = (s: string | null | undefined): boolean => !s || s.trim() === "";

/**
 * Has nobody given this agent anything to do?
 *
 * FIVE ROUTES, because a brief arrives by five different mechanisms and missing any one of them
 * makes a working agent look unbriefed — which permanently rewrites the `blocked` red that means
 * "this wedged, go unstick it" into a gray "New — not briefed". That is a worse bug than the one
 * this module fixes, so the predicate errs toward "briefed":
 *
 *   1. `promptHistory` / `lastPrompt` — the human typed into the composer. `promptHistory` is the
 *      durable record and `lastPrompt` the live one; a picker answer advances history without moving
 *      `lastPrompt` (projectStore.appendPrompt), so both are consulted rather than either alone.
 *   2. `task` — an orchestrator spawned this worker with an assigned job.
 *   3. `shellCommand` — a Run-as-command tab. `selectionActions.runAsCommand` creates these with a
 *      name and a command and NOTHING else, so without this every shell tab is briefless by
 *      construction and a one-shot command that fails in its first five minutes — the common case —
 *      has its red swallowed.
 *   4. `interactedAt` — the user has typed DIRECTLY into the terminal pane. This one is invisible to
 *      the agent record: Terminal.tsx's `onData` forwards keystrokes straight to the PTY and only
 *      touches `useInteractionStore`; it never calls `appendPrompt`. An agent driven entirely by
 *      hand therefore keeps empty prompt fields forever, and since the `blocked`/`idle` mapping is
 *      deliberately not time-limited it would be classified briefless forever. Callers pass the
 *      agent's stamp from that store. (Routes 1-4: roborev 54696; route 5 below: roborev 54771.)
 */
export function isBriefless(a: BriefableAgent, interactedAt?: number): boolean {
  if (a.promptHistory && a.promptHistory.length > 0) return false;
  if (!blank(a.lastPrompt)) return false;
  if (!blank(a.task)) return false;
  if (!blank(a.shellCommand)) return false;
  if (interactedAt !== undefined && interactedAt > 0) return false;
  //   5. `terminalBriefedAt` — the DURABLE form of route 4. `useInteractionStore` is in-memory only,
  //      while `createdAt` is persisted with the agent record, so after a relaunch an agent briefed
  //      ONLY by terminal keystrokes had empty prompt fields AND an empty interaction map: briefless
  //      again by every other route, and — since the `blocked` → `new` mapping is deliberately not
  //      time-limited — rendered calm gray the moment it wedged, indefinitely, until someone
  //      happened to type into it. That is this module's own bug reintroduced on the one path its
  //      header promises to protect ("no red is retroactively calmed across a restart"), and it bites
  //      exactly when the user reopens the app to look for reds. Stamped write-once by
  //      projectStore.noteTerminalBrief from Terminal's onSubmitLine (roborev 54771).
  if (a.terminalBriefedAt !== undefined && a.terminalBriefedAt > 0) return false;
  return true;
}

/** The statuses that are POSITIVE EVIDENCE the agent asked the human something. These are exempt
 *  from every de-escalation below — a real question goes red immediately, at any age, briefed or
 *  not. See the module header for why these two and nothing else. */
const DEMONSTRATED_ASK: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "waiting",
  "approval",
]);

/** Is this status positive evidence the agent asked the human something? Exported because the
 *  notification edge-detector needs the same answer this module reasons with, and two copies of
 *  "which statuses are a real ask" is how they drift apart. */
export function isDemonstratedAsk(status: AgentTabStatus | undefined): boolean {
  return status !== undefined && DEMONSTRATED_ASK.has(status);
}

/**
 * One agent's status, corrected for "spawned but never briefed". Returns the input unchanged in
 * every case this rule does not own, so it is safe to apply universally.
 *
 * `undefined` in → `undefined` out: an agent this window has no status entry for was never observed,
 * and inventing `new` there would convert a missing observation into a confident claim — exactly the
 * mistake services/agentLiveness.ts exists to prevent.
 */
export function calmNewAgent(
  status: AgentTabStatus | undefined,
  agent: BriefableAgent,
  now: number = Date.now(),
  /** When the user last typed into THIS agent's terminal (useInteractionStore.lastAt[id]). Route 4
   *  of `isBriefless` — see there for why the agent record alone cannot answer this. */
  interactedAt?: number,
): AgentTabStatus | undefined {
  if (status === undefined) return status;
  // No spawn stamp → treat as old. Conservative by design (see SCOPE).
  if (agent.createdAt === undefined) return status;
  if (!isBriefless(agent, interactedAt)) return status;
  // A real ask always wins, before any grace-period reasoning can reach it.
  if (DEMONSTRATED_ASK.has(status)) return status;
  // The two states a never-briefed agent actually reaches, and neither is time-limited:
  //   `blocked` — the stall timer fired; it is quiet because it has no work, not because it wedged.
  //   `idle`    — the settle path's default. Labelled "Done — your turn" and pinging by default,
  //               both of which are false for an agent that was never given a turn to finish.
  if (status === "blocked" || status === "idle") return "new";
  // BACKSTOP: any other red this soon after spawn is held. Covers states the taxonomy does not
  // model; lapses after NEW_AGENT_GRACE_MS so a genuinely broken agent still surfaces.
  if (isRedStatus(status) && now - agent.createdAt < NEW_AGENT_GRACE_MS) return "new";
  return status;
}

/**
 * Overlay `new` onto every briefless, freshly-spawned agent in the map. Returns the SAME reference
 * when no agent is corrected; never mutates the input.
 *
 * Unlike `withUnmergedWork`, an agent MISSING from `statusMap` is left missing rather than defaulted
 * — this overlay only corrects observations it actually has, and a row with no runtime entry is
 * handled by the liveness vocabulary instead.
 */
export function withNewAgentCalm<T extends BriefableAgent>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  now: number = Date.now(),
  /** agentId → when the user last typed into that agent's terminal (useInteractionStore.lastAt).
   *  Defaults to empty, which reads as "never touched" — so a caller that cannot supply it gets the
   *  pre-route-4 behaviour rather than a crash. */
  interaction: Record<string, number> = {},
): Record<string, AgentTabStatus> {
  let out: Record<string, AgentTabStatus> | null = null;
  for (const a of agents) {
    const st = statusMap[a.id];
    if (st === undefined) continue;
    const calmed = calmNewAgent(st, a, now, interaction[a.id]);
    if (calmed === st) continue;
    (out ??= { ...statusMap })[a.id] = calmed!;
  }
  return out ?? statusMap;
}

/**
 * When the NEXT held red would surface on its own, or null if none is being held on a clock.
 *
 * THE BACKSTOP NEEDS SOMETHING TO WAKE IT (roborev 54743, finding 1). `now` reaches this module as
 * an argument, so the overlay is only ever recomputed when its caller re-renders — and the one
 * status the timed branch actually governs is `errored`, which emits no further status writes
 * (`runtimeStore.setStatus` skips an unchanged value, and `waiting`/`approval` are exempt while
 * `blocked`/`idle` are mapped unconditionally). So for exactly the case the window exists for,
 * nothing would ever change the memo's inputs again: the row would sit gray `new` forever, silently
 * contradicting {@link NEW_AGENT_GRACE_MS}'s promise that a genuinely broken agent still surfaces.
 * Worse, `get_agent_status` samples the clock per call, so the concierge would report `errored` /
 * `needsYou: true` while every on-screen surface still said `new`.
 *
 * This gives a caller the one timestamp it needs to arm a single timer. Only the TIMED branch is
 * reported: `blocked`/`idle` → `new` is deliberately not time-limited, so those never expire and
 * scheduling a wake-up for them would be a wasted render.
 */
export function nextGraceExpiry<T extends BriefableAgent>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  now: number = Date.now(),
  interaction: Record<string, number> = {},
): number | null {
  let soonest: number | null = null;
  for (const a of agents) {
    const st = statusMap[a.id];
    if (st === undefined || a.createdAt === undefined) continue;
    if (!isBriefless(a, interaction[a.id])) continue;
    // Only the backstop is on a clock — see above.
    if (isDemonstratedAsk(st) || st === "blocked" || st === "idle") continue;
    if (!isRedStatus(st)) continue;
    const at = a.createdAt + NEW_AGENT_GRACE_MS;
    if (at > now && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}
