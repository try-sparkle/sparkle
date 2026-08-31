// improveNudge — the founder's "watcher and pusher, pushing you whenever it doesn't see you doing
// anything", scoped to the ONE agent it is about: the Improve Sparkle agent (`__sparkle_self__`).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// The founder's directive: "You should basically never be idle. You should always be working on
// something to improve Sparkle." Layer 1 (the persona's NEVER-IDLE contract in sparkleAgent.ts) tells
// the agent that, and defines the INTAKE→PULL loop it runs. This is the enforcement half: when the
// agent falls idle without having advanced anything, something has to notice and nudge it back to
// work — otherwise the contract is only as good as the model's memory across a turn boundary.
//
// ── A DELIBERATELY THIN, SCOPED EXTENSION OF THE PUSHER, NOT A NEW WATCHER ────────────────────────
// This does not run its own timer, own its own roster, or invent a second delivery path. It is a
// step the PUSHER's existing sweep invokes once per tick (see pusherRunner.sweepPushers /
// pusherMount.buildPusherDeps), reusing: the Pusher's 60s cadence, its per-project ownership election
// (`ownsProjectInThisWindow`), and its verified inbox send (`sendVerified`). All this file adds is a
// PURE decision (`decideImproveNudge`) plus a thin, fully-injected orchestrator (`sweepImproveNudge`)
// so the side effect — the nudge actually being sent — is assertable in a unit test.
//
// The Pusher's ordinary per-partner challenge path is UNTOUCHED: this only ever targets the Improve
// Sparkle agent, so no ordinary build agent's nudge behaviour changes. (It also does not collide with
// `goalContinuationRunner`, which resumes goal-carrying agents by iterating `projectStore` agents —
// and the Improve Sparkle agent is deliberately never in any project's `agents` array, so that runner
// never touches it. There is only one resumer for this agent, and it is this one.)
//
// ── IDLE IS "DID NOT ADVANCE A CONCRETE ITEM", NOT "HAS NO CHILDREN" ──────────────────────────────
// This is the correction that makes the loop valuable rather than counter-productive. The Improve
// Sparkle agent DELEGATES through backgrounded Task subagents and then WATCHES them — so a naive
// "does it have live children / background tasks" signal reads BUSY at exactly the moments it is
// idle-watching with nothing actually progressing. A nudge gated on "no in-flight children" would
// therefore never fire when it most should.
//
// So idleness is judged by a CONCRETE-ADVANCE FINGERPRINT the wiring supplies: when it MOVES the
// agent advanced (its own turn re-opened to commit / edit / file work), and when it is flat across
// the whole idle interval it did not — an agent that only spawned-and-is-watching produces no
// movement and is nudge-eligible even though child processes exist. The wiring keys the fingerprint
// off signals ATTRIBUTABLE to this agent, never a project-wide quantity that would churn from other
// agents and re-stamp the clock forever (roborev 66016) — see `pusherMount.improveAdvanceFingerprint`.
//
// ── ARMED BY DEFAULT, VIA RUNTIME CONFIG ─────────────────────────────────────────────────────────
// A nudge is a WRITE — it auto-resumes the agent's next turn — so the decision still requires
// `armed`, and `armed === false` is the FIRST thing it checks, so a disarmed build computes every
// other signal and still never sends. What changed: the arm is no longer a build-time flag that
// ships OFF. It is config.toml `[improvement].never_idle_armed`, which the founder reviewed and
// DEFAULTS ON (pusherMount.neverIdleArmed resolves it; false only when config says so). The
// still-strict guards below — an actually-idle agent with ready backlog — are what make an
// armed-by-default watcher safe.
//
// ── THE FAILURE DIRECTION IS "MISS A NUDGE", NEVER "NUDGE A BUSY AGENT" ───────────────────────────
// Every absent or ambiguous signal resolves toward "do not nudge": an unread pane status (undefined)
// is NOT idle; an UNREADABLE fingerprint (null — no reading in this window) counts as "advanced", so
// a broken read can never manufacture an idle verdict; a not-yet-baselined clock also counts as
// "advanced" (grace). The cost of a missed nudge is one more 60s tick of idleness; the cost of a
// wrong nudge is spending the agent's attention on a turn it did not need.

import type { AgentTabStatus } from "../types";
import type { Bead } from "./beads";
import { log } from "../logger";

/**
 * The concrete next item the self-feeding pull-loop hands the agent — the identity of the highest-
 * priority ready bead, resolved in CODE so the resume no longer punts "pick one yourself" to the
 * model. `priority` is bd's numeric band (0 = P0, the most urgent); `title` is for a human-legible
 * nudge line. See `selectNextReadyBead`.
 */
export interface NextReadyBead {
  id: string;
  priority: number;
  title: string;
}

/** Sentinel priority for a ready bead bd left ungraded — sorts LAST (see `selectNextReadyBead`) and
 *  renders as "unprioritized" rather than a bogus "P<big number>" (see `namedPullNudgeText`). */
const UNGRADED_PRIORITY = Number.POSITIVE_INFINITY;

/**
 * SELECT THE NEXT READY ITEM — the code-level half of the founder's "run `bd ready` sorted by
 * priority, take the top item" (bead sparkle-n2feho.1, cause 4: a goal is a finish line, so make the
 * loop self-feeding, not supervised). Given the board's already-filtered READY column (open,
 * unblocked, non-stalled — the same `board.backlog` the idle COUNT reads), return the single
 * highest-priority bead so the never-idle nudge can NAME it instead of telling the agent to choose.
 * That is the supervision→self-feeding shift: the choice is made HERE, deterministically, not deferred
 * to a model turn that kept answering with a status line (the exact failure of bead sparkle-iiz0eu).
 *
 * ORDERING mirrors bd's own: priority ASCENDING (0 = P0 outranks P1 outranks …), so P0s are exhausted
 * before P1s — exactly what the founder asked for. A missing priority sorts LAST: it is the least
 * urgent thing to hand someone, and treating "unknown" as "urgent" would jump an un-graded bead ahead
 * of a real P0. Ties break by id ascending so the pick is STABLE across polls — a selector that
 * reordered equal-priority beads on every 5s snapshot would name a different "next item" each tick and
 * never let the agent converge on one. Returns `null` for an empty ready column (nothing to pull).
 *
 * PURE and non-mutating: it copies before sorting, so the caller's snapshot array is untouched.
 */
export function selectNextReadyBead(readyColumn: readonly Bead[]): NextReadyBead | null {
  const ranked = [...readyColumn].sort((a, b) => {
    const pa = a.priority ?? UNGRADED_PRIORITY;
    const pb = b.priority ?? UNGRADED_PRIORITY;
    if (pa !== pb) return pa - pb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const top = ranked[0];
  if (top === undefined) return null;
  return { id: top.id, priority: top.priority ?? UNGRADED_PRIORITY, title: top.title };
}

/**
 * The nudge text delivered into the Improve Sparkle agent's inbox. Carries NO digits, so it can never
 * trip the Pusher's citation gate even if it were ever routed through the challenge path (it is not —
 * `sweepImproveNudge` sends directly). It restates the persona's INTAKE→PULL loop in one line so a
 * fresh turn cannot miss it: scan surfaces nobody reads and file beads, THEN work the highest-value
 * ready bead.
 */
export const NEVER_IDLE_NUDGE_TEXT =
  "You are idle and did not advance a concrete item this interval. Run one INTAKE→PULL cycle now, " +
  "do not end the turn idle. INTAKE: scan a surface nobody reads (autoscaler logs, roborev's " +
  "undrained reviews, GCP quota headroom, PRs whose checks never concluded, unread findings on " +
  "merged PRs) and FILE a bead for anything you find — a clean scan is itself a real result. PULL: " +
  "work the highest-value ready item — open P1/blocking pipeline-health beads first, then `bd " +
  "ready`, then the agent-feedback inbox. Advance one concrete item: commit, merge, file or comment " +
  "a bead, or make a real edit.";

/**
 * The ESCALATED nudge, sent once the agent has been nudged repeatedly WITHOUT advancing a concrete
 * item (see `NEVER_IDLE_ESCALATE_AFTER`). The soft nudge above is a reminder; this is the response to
 * an agent that keeps ANSWERING the nudge — with a status line, a plan, or a question back to the
 * founder — instead of shipping. That is the exact failure a prompt cannot fix, so this text does not
 * merely repeat the ask: it names the streak, DECLARES those non-artifact replies unacceptable, and
 * demands a concrete artifact THIS turn. The counter it keys off (`advanceFingerprint`) measures what
 * the agent DID, so rewording a deferral cannot satisfy it — only a real artifact resets the streak.
 */
export const NEVER_IDLE_ESCALATED_NUDGE_TEXT =
  "You have now been asked to work MULTIPLE times without producing a single concrete artifact. A " +
  "status line, a plan, a list of options, or a question back to the founder is NOT an acceptable " +
  "response — prioritizing and executing is your job, and deferring that choice is the failure being " +
  "corrected. Do ONE thing this turn that leaves an artifact: a commit, a pushed PR, a filed or " +
  "closed bead, or a real file edit. Pick the single highest-value ready item YOURSELF (open " +
  "P1/blocking pipeline-health beads first, then `bd ready`, then the agent-feedback inbox) and act " +
  "on it — do not ask which one. Reply `blocked-*` ONLY if a genuine consent, cost, or " +
  "product-direction decision that is truly the founder's is pending; 'which of these should I fix " +
  "first' is never such a decision.";

/**
 * How many nudges an agent may absorb WITHOUT a concrete advance before the escalated text replaces
 * the soft one. Two: the first nudge is a reminder and the second gives a resumed turn one more
 * chance to produce an artifact; a THIRD nudge in the same flat-signal streak means the agent is
 * answering the nudge instead of working, which is what escalation exists to break.
 */
export const NEVER_IDLE_ESCALATE_AFTER = 2;

/** The nudge text for a given streak of prior nudges-without-advance. Soft below the threshold, the
 *  escalated demand at or above it. Exported so the sweep and its test name the SAME selector. */
export function neverIdleNudgeText(priorNudgesWithoutAdvance: number): string {
  return priorNudgesWithoutAdvance >= NEVER_IDLE_ESCALATE_AFTER
    ? NEVER_IDLE_ESCALATED_NUDGE_TEXT
    : NEVER_IDLE_NUDGE_TEXT;
}

/** Render a ready bead's priority band for the nudge line: `P0`/`P1`/… for a graded bead, or
 *  `unprioritized` for one bd left ungraded (its sentinel is not a real band — see `UNGRADED_PRIORITY`). */
function priorityLabel(priority: number): string {
  return Number.isFinite(priority) ? `P${priority}` : "unprioritized";
}

/**
 * THE SELF-FEEDING PULL NUDGE — the fix for bead sparkle-n2feho.1, cause 4. Where the generic reminder
 * tells the agent to "work the highest-value ready item — pick it YOURSELF", this NAMES the item the
 * code already chose (`selectNextReadyBead`) so the resume hands over a concrete unit of work instead
 * of deferring the choice to a model turn. That deferral is the measured failure the founder called
 * out (bead sparkle-iiz0eu — "answered the nudge with a status line or a question instead of
 * shipping"): a prompt telling an agent to decide cannot fix an agent that keeps not deciding, so the
 * decision moves into code and the message merely relays it.
 *
 * It still ESCALATES by the flat-signal streak, exactly like the generic reminder, because naming the
 * item does not by itself stop an agent that answers with a status line: at/above the threshold the
 * text additionally names the streak and declares a non-artifact reply unacceptable. The item is named
 * in BOTH variants — that is the whole point — so escalation hardens the demand without ever dropping
 * the concrete target.
 *
 * Like `respinFleetNudgeText` this carries digits (the bead id and its priority band), which is safe
 * for the same reason: `sweepImproveNudge` sends it directly via `send`, never through the Pusher's
 * challenge path, so `checkCitations` never sees it. It must not be routed through the challenge path.
 */
export function namedPullNudgeText(bead: NextReadyBead, priorNudgesWithoutAdvance: number): string {
  const target = `${bead.id} (${priorityLabel(bead.priority)}) — "${bead.title}"`;
  const escalated = priorNudgesWithoutAdvance >= NEVER_IDLE_ESCALATE_AFTER;
  const lead = escalated
    ? `You have now been nudged MULTIPLE times without producing a single concrete artifact. A status ` +
      `line, a plan, a list of options, or a question back to the founder is NOT an acceptable ` +
      `response. `
    : ``;
  return (
    lead +
    `Your next item is ALREADY CHOSEN — ${target}. It is the highest-priority ready bead, so do NOT ` +
    `re-decide which to work and do NOT reply asking which one: CLAIM it (comment "taking <path>" on ` +
    `the bead / mark it in_progress), WORK it, CLOSE it, then pull the next one. End this turn having ` +
    `left an artifact ON THIS ITEM: a commit, a pushed PR, a filed or closed bead, or a real file edit.`
  );
}

/**
 * The SPECIFIC "re-spin the drain fleet" push — the fix for bead sparkle-4hwu2i. When the agent is
 * idle with ready backlog AND the machine has free agent slots AND no drain worker is currently
 * active, the generic "run an INTAKE→PULL cycle" reminder is too soft: the correct action is to
 * DISPATCH a drain fleet immediately, and the agent kept responding with a status report instead. So
 * this message names the exact numbers (ready beads, free slots, the zero active workers) and gives
 * the one imperative — spin the fleet NOW — with the founder's standing directive baked in so the
 * machine restates it every interval rather than trusting memory: caps and token cost are NEVER a
 * factor; machine headroom is the only bound.
 *
 * UNLIKE `NEVER_IDLE_NUDGE_TEXT` this DOES carry digits, which is safe here for the same reason the
 * header gives: `sweepImproveNudge` sends directly via `send`, never through the Pusher's challenge
 * path, so `checkCitations` never sees it. It must not be routed through the challenge path.
 */
export function respinFleetNudgeText(readyCount: number, freeSlots: number): string {
  return (
    `You have ${readyCount} ready beads and ${freeSlots} free agent slots and 0 active workers — ` +
    `spin a drain fleet NOW. Do not reply with a status report, a plan, or a question — DISPATCH. ` +
    `Fan out one background drain worker per ready item up to the ${freeSlots} free slots, pulling ` +
    `the highest-value ready work first (open P1/blocking pipeline-health beads, then \`bd ready\`, ` +
    `then the agent-feedback inbox). Account caps and token cost are NEVER a factor; spin maximally ` +
    `— machine headroom is the only bound, and thrash from over-spawning is the only thing to avoid.`
  );
}

/**
 * THE LOUDEST PUSH THERE IS — the fleet is 100% idle against a live backlog while FINISHED agents sit
 * on every slot (bead `sparkle-nu7gd9`).
 *
 * ── WHAT WAS MEASURED, AND WHY NOTHING FIRED ─────────────────────────────────────────────────────
 * The concierge measured ~30 build agents with ZERO working: almost all had goal state `met` and
 * stall `finished`, holding 79 of 81 slots, while `bd ready` reported 2148 ready issues. The
 * watcher raised NOTHING about it. It was, meanwhile, loud about stale PR-drift — several of those
 * alerts provably wrong. Loud about noise, silent about the thing that matters.
 *
 * That silence was STRUCTURAL, not a missing threshold, and both of the loud shapes were disabled by
 * the very condition they exist to detect:
 *
 *   • `unstaffed-epic-alarm` asks whether a bound orchestrator is LIVE, and a finished agent is very
 *     much alive — its process is up and its pane reads `idle`. So all 30 finished orchestrators read
 *     as STAFFED and the epic count was 0.
 *   • `respin` asks for `activeWorkers === 0`, and that number counts ROWS, not work. 79 finished rows
 *     are 79 "active workers", so the arm could not fire while a single finished row survived.
 *
 * Both readings are individually defensible and together they guarantee silence in exactly the state
 * the founder wants shouted about. The fix is one idea applied in both places: **a finished agent is
 * not a working agent**, so the judgment runs off `workingAgents` (alive AND not finished) rather than
 * off liveness or row count.
 *
 * ── WHY THIS SHAPE IS NOT GATED ON `freeSlots > 0`, WHEN EVERY OTHER LOUD SHAPE IS ────────────────
 * The headroom gate is correct for a push that says SPAWN — escalating into a saturated machine only
 * manufactures admission refusals ("29 of 19 agent slots taken"), which is the founder's own capacity
 * note. It is exactly WRONG for a push that says RECLAIM. When the slots are held by agents that have
 * finished, headroom is zero *because* of the defect, so gating on headroom makes the alarm silence
 * itself precisely when it is right. That is the inversion this shape exists to end: the remedy here
 * creates the headroom rather than needing it.
 *
 * So the message orders the two steps in the only order that can work — RETIRE the finished agents
 * first, THEN dispatch into the slots that frees — and surfaces the fact to the concierge, because a
 * fleet that has been idle against thousands of ready items is something the human should learn about
 * even though no human action is required to fix it. (That last clause is deliberate: an unretired
 * slot is machine-clearable, so under the founder's rule it must never render RED. It is a
 * three-alarm fire aimed at the MACHINE, not a summons for a human.)
 *
 * Like `respinFleetNudgeText` this carries digits, which is safe for the same reason: `sweepImproveNudge`
 * sends it directly via `send`, never through the Pusher's challenge path, so `checkCitations` never
 * sees it. It must not be routed through the challenge path.
 */
export function fleetIdleAlarmNudgeText(
  readyCount: number,
  reclaimable: number,
  totalRows: number,
  freeSlots: number,
): string {
  const finished =
    reclaimable === 1
      ? "1 agent has FINISHED (goal met / stall finished) and still holds its slot"
      : `${reclaimable} agents have FINISHED (goal met / stall finished) and still hold their slots`;
  const slots = freeSlots === 1 ? "1 slot is free" : `${freeSlots} slots are free`;
  return (
    `THREE-ALARM FIRE: the fleet is 100% IDLE — ZERO agents are working — against ${readyCount} ready ` +
    `beads. ${finished}, out of ${totalRows} local rows; only ${slots}. Nothing is being built. Do ` +
    `these three things NOW, in this order, and do not reply with a status report, a plan, or a ` +
    `question: (1) RECLAIM — retire/spin down every finished agent so its slot returns to the pool; ` +
    `this is what creates the headroom, and skipping it makes step 2 fail with admission refusals. ` +
    `(2) DISPATCH — fan out drain workers into the reclaimed slots, highest-value ready work first ` +
    `(open P1/blocking pipeline-health beads, then \`bd ready\`, then the agent-feedback inbox). ` +
    `(3) SURFACE — message the concierge (send_peer_message to sparkle:concierge) that the fleet was ` +
    `fully idle against ${readyCount} ready beads, so the human learns the backlog stalled. Account ` +
    `caps and token cost are NEVER factors; machine headroom is the only bound.`
  );
}

/**
 * The SPECIFIC "notify the concierge about a RED pipeline-health finding" push. When the board carries
 * an OPEN P1 pipeline-health bead — the fleet's highest-severity signal, the kind that needs a HUMAN to
 * unblock it — the correct action is not to quietly work the bead but to SURFACE it to the concierge,
 * which is the fleet hub and the only channel that routes the fix to the founder. The generic
 * INTAKE→PULL reminder is too soft for this: the agent kept working the red bead in silence while the
 * human stayed unaware. So this message names the finding and gives the one imperative — send the
 * concierge a message NOW via `send_peer_message` to `sparkle:concierge` — with the founder's standing
 * rule baked in so the machine restates it every window rather than trusting memory: caps, cost and
 * permission are NEVER factors for surfacing a red fleet signal.
 *
 * Like `respinFleetNudgeText` this carries digits, which is safe for the same reason: `sweepImproveNudge`
 * sends it directly via `send`, never through the Pusher's challenge path, so `checkCitations` never
 * sees it. It must not be routed through the challenge path.
 */
export function conciergeNotifyNudgeText(p1PipelineHealthCount: number): string {
  const finding =
    p1PipelineHealthCount === 1
      ? "a RED pipeline-health finding (1 open P1 pipeline-health bead)"
      : `${p1PipelineHealthCount} RED pipeline-health findings (${p1PipelineHealthCount} open P1 pipeline-health beads)`;
  return (
    `You have ${finding} — message the concierge NOW (send_peer_message to sparkle:concierge) with ` +
    `it; the concierge is the fleet hub and routes the human fix. Do NOT reply with a status report, ` +
    `a plan, or a question, and do NOT just work the bead in silence — SEND the concierge the finding ` +
    `so the human learns it is red. Caps, token cost, and permission are NOT factors; surfacing a red ` +
    `fleet signal to the human is the whole point.`
  );
}

/**
 * The SPECIFIC "unstaffed buildable epic" THREE-ALARM FIRE — the fix for bead sparkle-nu7gd9. The
 * founder: *"It should be like a three alarm fire when there is unstaffed work. That is supposed to be
 * actively built."* An `in_progress` epic that HAS CHILDREN (is buildable) but has NO live orchestrator
 * bound is unstaffed work that is supposed to be actively built, and the pusher used to say NOTHING
 * about it — it nagged individual agents about unlanded branches while thirteen buildable epics sat
 * with nobody on them. This is the loudest push the watcher emits, and it PRE-EMPTS every other shape.
 *
 * ── WHY IT NAMES BOTH STAFF AND SURFACE, AND WHY IT IS GATED ON HEADROOM ──────────────────────────
 * The founder's own capacity note (in the bead) is that escalation WITHOUT reclamation only produces
 * refusals: `promote_plan_to_build` was refused mid-sweep with *"29 of 19 agent slots taken … refusing
 * past 2.0x"*. So the correct response is NOT "spawn harder" into a saturated machine — a louder nudge
 * there manufactures admission refusals, not staffed epics. This shape therefore fires ONLY when there
 * is admission headroom (`freeSlots > 0`), and the message it carries does TWO things: (1) STAFF the
 * epics — bind/promote an orchestrator to each, bounded by the free slots, NEVER beyond machine
 * headroom; and (2) SURFACE the fact to the concierge (the fleet hub that routes the human fix) so a
 * human learns unstaffed buildable work is sitting idle. When the machine is full the shape does not
 * fire and the ordinary cadence resurfaces it once slots free — a persistently-unstaffed epic is not
 * silenced, it just is not shouted into a machine that cannot admit it.
 *
 * Like `respinFleetNudgeText` this carries digits, which is safe for the same reason: `sweepImproveNudge`
 * sends it directly via `send`, never through the Pusher's challenge path, so `checkCitations` never
 * sees it. It must not be routed through the challenge path.
 */
export function unstaffedEpicAlarmNudgeText(epicCount: number, freeSlots: number): string {
  const epics =
    epicCount === 1
      ? "1 in_progress epic with children has"
      : `${epicCount} in_progress epics with children have`;
  const slots = freeSlots === 1 ? "1 free agent slot" : `${freeSlots} free agent slots`;
  return (
    `THREE-ALARM FIRE: ${epics} NO live build agent — unstaffed work that is supposed to be actively ` +
    `built, and the machine has ${slots} to staff it. Do BOTH now, do not reply with a status report, ` +
    `a plan, or a question: (1) STAFF it — promote/bind an orchestrator to each unstaffed epic, up to ` +
    `the ${freeSlots} free slots and NEVER beyond machine headroom (spawning into a full machine only ` +
    `produces admission refusals, which is the failure being corrected). (2) SURFACE it — message the ` +
    `concierge NOW (send_peer_message to sparkle:concierge) that buildable epics are unstaffed, so the ` +
    `human learns unstaffed work is sitting idle. Account caps and token cost are NEVER factors; ` +
    `machine headroom is the only bound.`
  );
}

/**
 * How long the SAME still-open red pipeline-health finding waits before the concierge-notify push may
 * repeat. A CHANGED set of red beads (a new finding the concierge has not heard about) fires
 * immediately, subject only to the ordinary nudge cadence; the same unchanged set re-reminds the
 * concierge at most once per this window, so a persistently-unfixed red is resurfaced without spamming
 * it every tick. Thirty minutes — longer than the ordinary nudge cadence, because the concierge has
 * already been told and only a stale, still-red finding warrants a repeat.
 */
export const CONCIERGE_NOTIFY_CADENCE_MS = 30 * 60 * 1000;

/**
 * How long after a delivered nudge before another may be sent to the same agent.
 *
 * Ten minutes, chosen against the Pusher's 60s tick: without a floor the sweep would re-nudge every
 * tick for as long as the agent stayed idle-with-backlog, which is a storm, not a nudge. Ten minutes
 * gives a resumed turn room to actually pick up work and change the signal before the watcher speaks
 * again — and it only starts counting from a CONFIRMED delivery (see `sweepImproveNudge`), so a nudge
 * that never landed is retried on the next tick rather than suppressed for ten minutes.
 */
export const NEVER_IDLE_CADENCE_MS = 10 * 60 * 1000;

/**
 * How long the agent may go without a concrete advance before it counts as idle. Ten minutes — long
 * enough that a normal working turn (reading, thinking, running a subagent that then produces a
 * commit) never trips it, short enough that a genuinely idle-watching agent is caught within one
 * cadence of the Pusher's tick.
 */
export const ADVANCE_IDLE_MS = 10 * 60 * 1000;

/**
 * The statuses that mean "turn done, at rest" for the Improve Sparkle agent. Mirrors the resting set
 * `goalContinuationRunner.RESTING` uses, and deliberately EXCLUDES `waiting`/`approval` (a question
 * or approval is on screen — nudging would type over it) and `blocked`/`lapsed` (a stall the goal
 * runner and the ordinary Pusher already own). `undefined` — no reading in this window — is not
 * resting either, which is the fail-closed direction. NOTE this is the agent's OWN pane status: an
 * idle-watching agent whose backgrounded children are live still reads `idle` here (its own turn
 * closed), which is the exact case the concrete-advance signal, not this gate, is there to judge.
 */
const RESTING: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["idle", "unmerged"]);

/** Everything the decision reads. Pure inputs so the whole rule tests as arithmetic. */
export interface ImproveNudgeInput {
  /** Arm gate, from config.toml `[improvement].never_idle_armed` (defaults ON). `false` always
   *  refuses — checked FIRST — so an explicitly disarmed config mutes every other signal. */
  armed: boolean;
  /** Does THIS window own the sparkle-self project? Only the owner nudges, so two windows cannot
   *  double-send — the same single-owner election the Pusher and goal runner use. */
  ownsProject: boolean;
  /** Improvement consent is "never" (chat-only). A chat-only session is barred from mining backlog,
   *  so it must not be nudged to. Reading consent, never changing it. */
  consentIsNever: boolean;
  /** The agent's live pane status, or `undefined` when this window has no reading. */
  paneStatus: AgentTabStatus | undefined;
  /**
   * Did the agent ADVANCE A CONCRETE ITEM within the idle interval? This REPLACES an "in-flight
   * children" check, on purpose: the Improve Sparkle agent backgrounds subagents, so children-exist
   * reads busy while it is only watching. `true` suppresses the nudge (it is really working, or we
   * could not tell); `false` means it has been idle-watching or resting with no output for the whole
   * interval, which is exactly what to nudge.
   */
  advancedRecently: boolean;
  /**
   * THE ONE-SHOT RESUME KICK (bead sparkle-n2feho.1, cause 4). `true` on every sweep after a window
   * mounts / the app restarts until the kick is SPENT ON A CONFIRMED DELIVERY (armed by
   * `armImproveResumeKick`, consumed by `sweepImproveNudge`).
   * It lifts EXACTLY ONE suppression — the baseline `advancedRecently` GRACE — so a resume that finds
   * the agent idle-with-ready-work pulls/spawns on the FIRST eligible tick instead of sitting through a
   * full `ADVANCE_IDLE_MS` idle interval before the watcher is even allowed to speak. That grace is
   * stamped on the first readable fingerprint of a fresh window and exists to protect an agent we have
   * OBSERVED working; a window that has just resumed has observed nothing, so on resume the grace is
   * exactly the mechanism that makes the fleet "sit there idle after a restart" (the founder's
   * complaint). It lifts ONLY the grace: every other guard (armed / owner / consent / not-idle /
   * no-ready-backlog / rate-limit) still refuses, so a resume can never nudge a working agent (not-idle
   * wins) nor manufacture a spurious action when there is no ready work (no-ready-backlog wins).
   * `false` once spent, so the normal grace/cadence governs steady-state — this only ever fires once.
   */
  justResumed: boolean;
  /** How many open, unblocked improvement beads are ready (the board's `backlog` column). */
  readyBacklogCount: number;
  /** How many open P1 pipeline-health beads exist — the highest-value ready work, counted separately
   *  so a blocked-but-open P1 still satisfies "there is work" even if the backlog column is empty. */
  p1PipelineHealthCount: number;
  /** A stable fingerprint IDENTIFYING the current set of open P1 pipeline-health beads (their sorted
   *  ids joined), or `null` when there are none or nothing readable. Identity, not a count, so the
   *  concierge-notify push dedups per DISTINCT set of red beads — a changed fingerprint is a finding
   *  the concierge has not heard about. `null` here can never produce a concierge-notify. */
  pipelineHealthFingerprint: string | null;
  /** The pipeline-health fingerprint the concierge was last notified about, or `null` if never. A
   *  fingerprint that DIFFERS from this is a new/changed red finding → notify now; an unchanged one
   *  re-notifies only once `conciergeCadenceMs` has elapsed. Window-local, like `lastNudgedAt`. */
  lastConciergeNotifyFingerprint: string | null;
  /** When the last concierge-notify was delivered, or `null` if never. Feeds the same "re-remind only
   *  past the window" dedup as the fingerprint. */
  lastConciergeNotifiedAt: number | null;
  /** How long the SAME still-red fingerprint waits before the concierge-notify may repeat. */
  conciergeCadenceMs: number;
  /** Machine headroom: free local agent slots (`localAgentCapacity` `limit − used`, clamped ≥ 0).
   *  When > 0 there is room to spawn a drain fleet; when 0 the machine is full and the re-spin push
   *  would be counterproductive, so the generic reminder is used instead. */
  freeSlots: number;
  /** How many local build/worker ROWS exist (the capacity reading's occupied slots).
   *
   *  ⚠️ THIS IS NOT AN IDLENESS TEST, AND USING IT AS ONE WAS THE BUG (bead `sparkle-nu7gd9`). It
   *  counts rows, not work: a row whose agent finished hours ago still occupies a slot and still
   *  increments this number, so `activeWorkers === 0` is false while a single finished row survives.
   *  Measured, 79 finished rows made the re-spin arm unreachable at the exact moment the fleet was
   *  100% idle against 2148 ready beads. Judge idleness with {@link workingAgents}; this number is
   *  kept because the alarm message quotes it ("M of K rows are finished") to make the remedy legible. */
  activeWorkers: number;
  /** How many local build/worker rows are ACTUALLY WORKING right now — process alive AND goal not
   *  quiet (not `met`/`discharged`/`awaiting_close`). This is the honest "is anything being built?"
   *  reading, and it is what every idleness judgment below runs off. 0 means the fleet is doing
   *  nothing, however many rows exist. Reads conservatively: an agent whose liveness or goal cannot
   *  be read counts as WORKING, so an unreadable roster can never manufacture a false alarm. */
  workingAgents: number;
  /** How many local build/worker rows are FINISHED but still holding a slot — process alive, goal
   *  quiet. These are the slots a machine can reclaim with no human involved, which is why a fleet
   *  stuck behind them must be loud at the MACHINE and must never render RED (the founder's rule:
   *  red means a human is the only one who can unblock it). > 0 together with `workingAgents === 0`
   *  and a ready backlog is the `fleet-idle-alarm`. 0 when unreadable — fail toward silence. */
  reclaimableAgents: number;
  /** How many local build/worker rows this window has NOT observed at all — no runtime status entry,
   *  so their liveness is unknown (an unvisited project tab, a row owned by another window, or every
   *  row on the first sweep after an app restart).
   *
   *  ⚠️ IT GATES THE FLEET-IDLE ALARM, because "nothing is working" is a claim about the WHOLE fleet
   *  and one unobserved row means the evidence is incomplete (roborev 72764). Project A's tab open
   *  with one finished agent while project B is unvisited and flat out reads `workingAgents === 0`,
   *  and firing there would order a drain fan-out into a machine that is already busy. 0 means every
   *  row was actually looked at. */
  unobservedAgents: number;
  /** How many `in_progress` epics have children (are buildable) but NO live orchestrator bound — the
   *  founder's "unstaffed work that is supposed to be actively built" (bead sparkle-nu7gd9). > 0 makes
   *  the three-alarm-fire push eligible, but ONLY together with `freeSlots > 0`: with no admission
   *  headroom the alarm does not fire (escalating into a saturated machine only produces admission
   *  refusals). 0 when unreadable — the fail-toward-silence direction. */
  unstaffedBuildableEpicCount: number;
  /** The highest-priority ready bead the code has ALREADY chosen for the agent to pull next
   *  (`selectNextReadyBead` over the same ready column `readyBacklogCount` counts), or `null` when the
   *  ready column is empty/unreadable. When present it upgrades the terminal generic reminder into a
   *  `named-pull` that hands over the concrete item instead of telling the agent to pick one — the
   *  supervision→self-feeding shift (bead sparkle-n2feho.1). `null` keeps the plain generic reminder. */
  nextReadyBead: NextReadyBead | null;
  /** When the last nudge was delivered, or `null` if never. */
  lastNudgedAt: number | null;
  now: number;
  cadenceMs: number;
}

export type ImproveNudgeDecision =
  | { nudge: true; kind: "generic" }
  | { nudge: true; kind: "named-pull"; bead: NextReadyBead }
  | { nudge: true; kind: "respin"; readyCount: number; freeSlots: number }
  | { nudge: true; kind: "concierge-notify"; fingerprint: string; count: number }
  | { nudge: true; kind: "unstaffed-epic-alarm"; epicCount: number; freeSlots: number }
  | {
      nudge: true;
      kind: "fleet-idle-alarm";
      readyCount: number;
      reclaimable: number;
      totalRows: number;
      freeSlots: number;
    }
  | { nudge: false; reason: ImproveNudgeRefusal };

export type ImproveNudgeRefusal =
  | "not-armed"
  | "not-owner"
  | "consent-never"
  | "not-idle"
  | "advanced-recently"
  | "no-ready-backlog"
  | "rate-limited";

/**
 * Should the watcher nudge the Improve Sparkle agent right now?
 *
 * PURE. Refuses toward silence at every step, and each refusal names a distinct reason so a log or a
 * test can tell "nothing to do" from "already working" from "not armed". The guardrails, in order:
 *
 *   1. `not-armed`         — config.toml explicitly set never_idle_armed = false (default is ON).
 *   2. `not-owner`         — another window owns sparkle-self; it will decide.
 *   3. `consent-never`     — chat-only mode may not be told to mine backlog.
 *   4. `not-idle`          — the agent's own pane is not at rest (working / waiting / approval / unknown).
 *   5. `advanced-recently` — it advanced a concrete item within the interval (or we could not tell); it IS working.
 *                            BYPASSED by `justResumed`: on the first sweep after an app restart this
 *                            signal is the baseline grace, not real work, so a resume pulls immediately.
 *   6. `no-ready-backlog`  — nothing is ready, so resting is CORRECT; it may rest (guardrail a).
 *   7. `rate-limited`      — a nudge was delivered within `cadenceMs`; give the turn room to act.
 *
 * On a `nudge` verdict it chooses the SHAPE of the push, in priority order:
 *
 *   0. `fleet-idle-alarm` (bead sparkle-nu7gd9) — ZERO agents are working, there IS ready backlog, and
 *      FINISHED agents are still holding slots. The loudest shape there is, and the ONLY one not gated
 *      on `freeSlots > 0`: its remedy is RECLAMATION, which creates the headroom the other shapes wait
 *      for, so gating it on headroom would silence it exactly when it is right. See
 *      `fleetIdleAlarmNudgeText` for the measured failure it exists to end.
 *   0b. `unstaffed-epic-alarm` (bead sparkle-nu7gd9) — an `in_progress` epic with children (buildable)
 *      has NO live orchestrator AND the machine has admission headroom (`freeSlots > 0`). This is the
 *      LOUDEST push — a three-alarm fire — and PRE-EMPTS every shape below: the founder wants unstaffed
 *      buildable work surfaced and staffed, not silently ignored. It is gated on `freeSlots > 0` on
 *      purpose: escalating into a saturated machine only produces admission refusals ("29 of 19 slots
 *      taken"), so with no headroom the alarm does not fire and the ordinary cadence resurfaces it once
 *      slots free. `unstaffedBuildableEpicCount === 0` (staffed, or no buildable epics, or unreadable)
 *      can never take this shape.
 *   1. `concierge-notify` — an OPEN P1 pipeline-health bead exists (a RED fleet signal a human must
 *      unblock) that the concierge has not been told about this window. This PRE-EMPTS re-spin and the
 *      generic reminder: the founder wants a red signal SURFACED to the concierge (the fleet hub, which
 *      routes the human fix), not quietly worked. Deduped per DISTINCT set of red beads — a new/changed
 *      `pipelineHealthFingerprint` fires now, the same fingerprint re-fires only past `conciergeCadenceMs`
 *      (a persistently-unfixed red is resurfaced, but not every tick). `pipelineHealthFingerprint === null`
 *      (no red / unreadable) can never take this shape.
 *   2. `respin` (bead sparkle-4hwu2i) — ready backlog AND free agent slots AND zero active workers: the
 *      fleet is idle-with-work-and-headroom, so the correct action is to re-spin the drain fleet,
 *      carrying the numbers the message names.
 *   3. `generic` — otherwise (backlog exists but there is no headroom, or workers are already draining):
 *      the existing generic INTAKE→PULL reminder.
 */
export function decideImproveNudge(input: ImproveNudgeInput): ImproveNudgeDecision {
  if (!input.armed) return { nudge: false, reason: "not-armed" };
  if (!input.ownsProject) return { nudge: false, reason: "not-owner" };
  if (input.consentIsNever) return { nudge: false, reason: "consent-never" };
  if (input.paneStatus === undefined || !RESTING.has(input.paneStatus)) {
    return { nudge: false, reason: "not-idle" };
  }
  // A concrete advance within the interval means the agent IS working, so refuse — UNLESS this is the
  // one-shot resume kick (bead sparkle-n2feho.1, cause 4). On a fresh window/app-restart the
  // `advancedRecently` signal is the BASELINE GRACE (the first readable fingerprint stamps the clock
  // and reads as "just advanced"), not evidence of real work — and that grace is precisely what leaves
  // the fleet idle for a full interval after a restart. `justResumed` lifts ONLY this suppression; the
  // not-idle gate above already refused a genuinely-working agent, so bypassing here cannot nudge one.
  if (input.advancedRecently && !input.justResumed) {
    return { nudge: false, reason: "advanced-recently" };
  }
  if (
    input.readyBacklogCount <= 0 &&
    input.p1PipelineHealthCount <= 0 &&
    input.unstaffedBuildableEpicCount <= 0
  ) {
    return { nudge: false, reason: "no-ready-backlog" };
  }
  if (input.lastNudgedAt !== null && input.now - input.lastNudgedAt < input.cadenceMs) {
    return { nudge: false, reason: "rate-limited" };
  }
  // Idle, with work, past the cadence. Choose the shape.
  //
  // HIGHEST PRIORITY — the three-alarm fire (bead sparkle-nu7gd9): an in_progress epic with children
  // and no live orchestrator is unstaffed work that is supposed to be actively built. It PRE-EMPTS the
  // concierge-notify, re-spin and generic pushes. But it fires ONLY with admission headroom
  // (`freeSlots > 0`): the founder's measured failure was escalation INTO a saturated machine producing
  // admission refusals ("29 of 19 slots taken"), so with no headroom this shape does not fire — a
  // louder nudge could not admit a new orchestrator and would only manufacture refusals. The
  // staffing/surface push then waits for the ordinary cadence to resurface it once slots free.
  // HIGHEST PRIORITY OF ALL — THE FLEET IS 100% IDLE AND FINISHED AGENTS ARE HOLDING THE SLOTS
  // (bead `sparkle-nu7gd9`). Nothing is being built, there IS ready work, and the reason nothing can
  // start is that agents which already finished never gave their slots back.
  //
  // It pre-empts the unstaffed-epic alarm below because it is strictly worse: an unstaffed epic is
  // work nobody picked up, this is the WHOLE FLEET stopped. And it is deliberately NOT gated on
  // `freeSlots > 0` — the one shape here that is not. Every other loud push says SPAWN, and spawning
  // into a saturated machine only manufactures admission refusals, so those correctly wait for
  // headroom. This one says RECLAIM FIRST, and the headroom it would have waited for is precisely
  // what the defect consumed: gating it on free slots makes the alarm silence itself exactly when it
  // is right. That inversion — loud about noise, silent about the fleet being stopped — is the whole
  // bug (measured: ~30 finished agents, zero working, 79/81 slots held, 2148 ready, watcher silent).
  //
  // `reclaimableAgents > 0` is what separates this from the `respin` arm below rather than a
  // magnitude threshold: with nothing to reclaim, an idle fleet with headroom is an ordinary re-spin
  // and gets the ordinary push. Both arms are therefore reachable and neither shadows the other.
  // `unobservedAgents === 0` is the COMPLETENESS term, and it is not optional (roborev 72764):
  // `workingAgents === 0` is an absence of contrary evidence, not evidence of absence. A row this
  // window never observed is in neither count, so an unvisited project full of busy workers reads as
  // zero working — and this push would then order a drain fan-out into a machine that is already
  // flat out. The alarm speaks only when every row was actually looked at.
  if (
    input.workingAgents === 0 &&
    input.readyBacklogCount > 0 &&
    input.reclaimableAgents > 0 &&
    input.unobservedAgents === 0
  ) {
    return {
      nudge: true,
      kind: "fleet-idle-alarm",
      readyCount: input.readyBacklogCount,
      reclaimable: input.reclaimableAgents,
      totalRows: input.activeWorkers,
      freeSlots: input.freeSlots,
    };
  }
  if (input.unstaffedBuildableEpicCount > 0 && input.freeSlots > 0) {
    return {
      nudge: true,
      kind: "unstaffed-epic-alarm",
      epicCount: input.unstaffedBuildableEpicCount,
      freeSlots: input.freeSlots,
    };
  }
  //
  // SECOND PRIORITY (below the unstaffed-epic alarm above): a RED pipeline-health finding the concierge
  // has not been told about. This is the fleet's most urgent HUMAN-unblock signal — an open P1
  // pipeline-health bead needs a HUMAN to unblock it — so the
  // founder wants it surfaced to the concierge hub, ahead of any drain-fleet re-spin or generic
  // reminder. Deduped per distinct set of red beads: a changed fingerprint (a new finding) fires now,
  // an unchanged one re-fires only once `conciergeCadenceMs` has elapsed. A `null` fingerprint (no red
  // beads, or an unreadable board) can never reach here — the fail-toward-silence direction.
  if (input.p1PipelineHealthCount > 0 && input.pipelineHealthFingerprint !== null) {
    const isNewFinding = input.pipelineHealthFingerprint !== input.lastConciergeNotifyFingerprint;
    const windowElapsed =
      input.lastConciergeNotifiedAt === null ||
      input.now - input.lastConciergeNotifiedAt >= input.conciergeCadenceMs;
    if (isNewFinding || windowElapsed) {
      return {
        nudge: true,
        kind: "concierge-notify",
        fingerprint: input.pipelineHealthFingerprint,
        count: input.p1PipelineHealthCount,
      };
    }
  }
  // Push the SPECIFIC re-spin action when there are ready beads to drain, machine headroom to run them,
  // and zero workers already draining; otherwise the generic reminder. `readyBacklogCount > 0` (not the
  // P1 arm) gates re-spin because the message names "N ready beads" to dispatch — a lone blocked-but-open
  // P1 has nothing to fan a drain fleet across.
  // ⚠️ THIS ARM DELIBERATELY STILL JUDGES ROWS (`activeWorkers`), NOT WORK. It was changed to
  // `workingAgents` and changed back, because the two arms need OPPOSITE failure directions and only
  // this one can fire without positive evidence. `workingAgents` counts only rows observed alive, so
  // on the first sweep after an app restart — when `useRuntimeStore.status` is empty and every row
  // reads unobserved — it is 0 for a fleet that may be busily building, and this arm would push
  // "spin a drain fleet NOW" straight into it. The `fleet-idle-alarm` above cannot make that mistake
  // because it additionally requires `reclaimableAgents > 0`, which needs an agent POSITIVELY
  // observed alive with a quiet goal. `activeWorkers === 0` means "there is not a single local
  // build/worker row", which is narrow but is real evidence rather than an absence of it — so the
  // finished-fleet case belongs to the alarm above, and this arm keeps the reading it can trust.
  if (input.readyBacklogCount > 0 && input.freeSlots > 0 && input.activeWorkers === 0) {
    return { nudge: true, kind: "respin", readyCount: input.readyBacklogCount, freeSlots: input.freeSlots };
  }
  // SELF-FEEDING PULL (bead sparkle-n2feho.1, cause 4): the terminal case is "there is ready work but
  // no drain fleet to spin" (no headroom, or workers already draining and the orchestrator itself must
  // work a reserved unit). Rather than tell the agent to "pick the highest-value ready item YOURSELF",
  // NAME the item the code already chose so the resume hands over a concrete unit — that is the
  // supervision→self-feeding shift. Falls back to the plain generic reminder only when no ready bead
  // is readable (e.g. a lone blocked-but-open P1, or an unhydrated board), the fail-toward-silence
  // direction: never invent a target.
  if (input.nextReadyBead !== null) {
    return { nudge: true, kind: "named-pull", bead: input.nextReadyBead };
  }
  return { nudge: true, kind: "generic" };
}

/** What the sweep gathers from the live app. Every field is a getter so the orchestrator stays pure
 *  of store/registry reads and the whole thing tests with plain spies. */
export interface ImproveNudgeDeps {
  now(): number;
  /** Is the feature armed? Defaults false in the wiring — see the header. */
  armed(): boolean;
  /** Does this window own the sparkle-self project? */
  ownsProject(): boolean;
  /** Is improvement consent "never"? */
  consentIsNever(): boolean;
  /** The improve agent's live pane status, or undefined for "no reading in this window". */
  paneStatus(): AgentTabStatus | undefined;
  /**
   * A summary of the improve agent's own CONCRETE-ADVANCE signal this instant, or `null` when nothing
   * could be read. When this string CHANGES between sweeps the agent advanced; when it is flat across
   * the whole idle interval it did not. `null` (unreadable) never counts as idle. See
   * `pusherMount.improveAdvanceFingerprint` for what feeds it, and `sweepImproveNudge` for the clock.
   */
  advanceFingerprint(): string | null;
  /** The ready-work counts, read from the beads board, plus a fingerprint IDENTIFYING the open P1
   *  pipeline-health beads (their sorted ids joined, or `null` when there are none) — the identity the
   *  concierge-notify push dedups on — and `nextReadyBead`, the highest-priority ready bead the code
   *  has chosen for the self-feeding pull nudge (`selectNextReadyBead`; `null` when the ready column is
   *  empty/unreadable). */
  readyBacklog(): {
    ready: number;
    p1PipelineHealth: number;
    p1PipelineHealthFingerprint: string | null;
    nextReadyBead: NextReadyBead | null;
  };
  /** The machine-capacity reading behind the re-spin and fleet-idle decisions. `freeSlots` is the
   *  local agent headroom (`localAgentCapacity` `limit − used`, clamped ≥ 0); `activeWorkers` is how
   *  many local build/worker ROWS occupy slots (rows, not work — see the field doc); `workingAgents`
   *  is how many of those rows are actually working (alive AND goal not quiet); and
   *  `reclaimableAgents` is how many are finished-but-still-holding-a-slot. The last two are what
   *  every idleness judgment runs off — see `ImproveNudgeInput.activeWorkers` for why the row count
   *  cannot serve (bead `sparkle-nu7gd9`). */
  capacity(): {
    freeSlots: number;
    activeWorkers: number;
    workingAgents: number;
    reclaimableAgents: number;
    unobservedAgents: number;
  };
  /** How many `in_progress` epics have children (are buildable) but NO live orchestrator bound — the
   *  three-alarm-fire signal (bead sparkle-nu7gd9). Read from the cached beads board + agent roster +
   *  runtime liveness, no `bd` shell call. 0 when unreadable (the fail-toward-silence direction). */
  unstaffedBuildableEpics(): { unstaffedBuildableEpicCount: number };
  /** Deliver the nudge to the improve agent's inbox; returns whether delivery was CONFIRMED. */
  send(text: string): Promise<boolean>;
}

export interface ImproveNudgeOutcome {
  sent: boolean;
  /** `"nudged"` on a confirmed delivery, `"transport-failed"` on a decided-but-undelivered send,
   *  `"errored"` when a dep threw, or the decision's refusal reason. */
  detail: ImproveNudgeRefusal | "nudged" | "transport-failed" | "errored";
}

// ── Module state, window-local and NOT persisted, like the Pusher's and goal runner's own. ────────
let lastNudgedAt: number | null = null;
/** The last concrete-output fingerprint we saw, and WHEN it last moved. A fresh window has observed
 *  no advance, so the first non-null fingerprint stamps `lastAdvanceAt` as a BASELINE (grace), not as
 *  an advance — an agent gets one full idle interval before it can be judged stale, exactly like the
 *  goal runner's idle clock. */
let lastFingerprint: string | null = null;
let lastAdvanceAt: number | null = null;
/** How many nudges have been DELIVERED in the current flat-signal streak — i.e. since the agent last
 *  advanced a concrete item. Reset to 0 the instant `advancedRecently` is true (any real advance ends
 *  the streak) and incremented on each confirmed delivery. Feeds `neverIdleNudgeText` so the message
 *  escalates when the agent keeps answering the nudge without shipping. Window-local, not persisted. */
let consecutiveIdleNudges = 0;
/** When the concierge was last notified about a red pipeline-health finding, and the fingerprint of the
 *  finding it was told about. Window-local, not persisted, exactly like `lastNudgedAt`. Together they
 *  dedup the concierge-notify push per DISTINCT set of red beads per `CONCIERGE_NOTIFY_CADENCE_MS`. */
let lastConciergeNotifiedAt: number | null = null;
let lastConciergeNotifyFingerprint: string | null = null;
/**
 * THE ONE-SHOT RESUME KICK, window-local and NOT persisted (bead sparkle-n2feho.1, cause 4). Armed by
 * `armImproveResumeKick` when this window mounts / the app restarts, and SPENT ON THE FIRST CONFIRMED
 * DELIVERY. While armed it makes `sweepImproveNudge` pass `justResumed: true` into the decision, which
 * lifts the baseline-grace `advanced-recently` suppression — so a resume that finds the agent
 * idle-with-ready-work pulls/spawns on the first eligible tick instead of after a full
 * `ADVANCE_IDLE_MS` grace. Defaults FALSE (an un-armed window behaves exactly as before).
 *
 * SPENT ON THE ACTION, NOT ON THE LOOK, and that is the load-bearing half. The backlog this kick needs
 * is fed asynchronously from the SAME mount (`ensureSparkleRepo` may `git clone`, then a first `bd`
 * snapshot), while the pane fingerprint is readable almost immediately — so on the cold start this
 * feature exists to fix, the earliest ticks routinely see a READABLE agent and an EMPTY backlog.
 * Spending the kick there would burn it on a sweep that could not act and hand the fleet back the very
 * grace this exists to skip. It therefore survives any number of refusing ticks — "this window has not
 * yet self-fed" — which is also why it needs no separate blind-sweep case.
 */
let resumeKickArmed = false;

/** Test/introspection seam: the current flat-signal nudge streak. */
export function improveConsecutiveIdleNudges(): number {
  return consecutiveIdleNudges;
}

/**
 * ARM THE ONE-SHOT RESUME KICK (bead sparkle-n2feho.1, cause 4). The wiring (`startPusher`) calls this
 * exactly once when a window mounts / the app restarts, to declare "this window has just resumed and
 * has not yet taken a real look at the improve agent." It lifts ONLY the baseline-grace suppression on
 * every sweep until it is spent, so a resumed fleet that finds a ready P0/P1 backlog begins draining on
 * the first eligible pusher tick rather than sitting idle for a full idle interval — the founder's exact
 * complaint that "after restarting the app, the fleet does NOT automatically start draining."
 * Idempotent: calling it again while already armed is a no-op, and every non-grace guard still governs
 * the resulting sweep.
 */
export function armImproveResumeKick(): void {
  resumeKickArmed = true;
}

/** Test/introspection seam: when did the concierge last get a pipeline-health notify, and about what. */
export function improveLastConciergeNotifiedAt(): number | null {
  return lastConciergeNotifiedAt;
}
export function improveLastConciergeNotifyFingerprint(): string | null {
  return lastConciergeNotifyFingerprint;
}

/** Test seam: forget every clock so one suite cannot leak into the next. */
export function _resetImproveNudgeForTests(): void {
  lastNudgedAt = null;
  consecutiveIdleNudges = 0;
  lastFingerprint = null;
  lastAdvanceAt = null;
  lastConciergeNotifiedAt = null;
  lastConciergeNotifyFingerprint = null;
  // DISARMED by reset, so the existing sweep suites keep the baseline-silent contract they assert; the
  // resume-kick suite opts in by calling `armImproveResumeKick()` after the reset.
  resumeKickArmed = false;
}

/** Test/introspection seam: when did the last nudge land? */
export function improveLastNudgedAt(): number | null {
  return lastNudgedAt;
}

/**
 * Fold one sweep's fingerprint into the advance clock and answer "did it advance within the interval".
 *
 * `null` — UNREADABLE — RESTARTS the clock and returns `true`: a read we could not take is not
 * evidence of idleness, and — the subtle half (roborev 66023/66024) — the blind stretch must not be
 * COUNTED as idle time either. Leaving the clock alone would let a long null run (e.g. the improve
 * pane closed for an hour, which DELETES its `status` entry) be followed by one identical readable
 * sample and fire a nudge immediately, on evidence that covers none of that hour. Restarting the
 * clock on every null means a nudge can only ever fire after a FRESH full interval of readable, flat
 * signal. The first readable fingerprint after that is a BASELINE (grace); a change re-stamps.
 */
function advancedWithin(fingerprint: string | null, now: number, idleMs: number): boolean {
  if (fingerprint === null) {
    lastFingerprint = null;
    lastAdvanceAt = now;
    return true;
  }
  if (lastFingerprint === null || fingerprint !== lastFingerprint) {
    lastFingerprint = fingerprint;
    lastAdvanceAt = now;
  }
  // `lastAdvanceAt` is non-null here (just stamped, or stamped on an earlier sweep).
  return lastAdvanceAt === null || now - lastAdvanceAt < idleMs;
}

/**
 * One pass of the never-idle watcher. Advances the concrete-advance clock, decides, and — only on a
 * `nudge` verdict — sends. NEVER THROWS and NEVER REJECTS: a failure here (a dep read, the awaited
 * send) must not take the Pusher's sweep down, so the whole body is wrapped and a throw becomes an
 * `errored` outcome. The caller also guards, but the contract lives with the function that promises it.
 *
 * THE RATE-LIMIT CLOCK ADVANCES ONLY ON A CONFIRMED DELIVERY. A send the transport could not confirm
 * leaves `lastNudgedAt` untouched, so the next tick retries rather than suppressing for ten minutes —
 * the same "spend the budget against a confirmed delivery" discipline the Pusher uses. Overlapping
 * sweeps cannot double-nudge because the Pusher serialises its ticks and awaits this hook within one.
 */
export async function sweepImproveNudge(deps: ImproveNudgeDeps): Promise<ImproveNudgeOutcome> {
  try {
    const now = deps.now();
    // The advance clock is folded EVERY sweep, before the decision and regardless of every other
    // gate, so a window that is not the owner (or is disarmed) still tracks advance and does not
    // manufacture a false "idle for ages" the moment it becomes eligible.
    const advancedRecently = advancedWithin(deps.advanceFingerprint(), now, ADVANCE_IDLE_MS);
    // THE ONE-SHOT RESUME KICK (bead sparkle-n2feho.1, cause 4). Hand the armed flag to the decision as
    // `justResumed`; it is SPENT BELOW, on a confirmed delivery, never here on a mere look — see the
    // `resumeKickArmed` declaration for why the cold-start backlog race makes that the load-bearing
    // half. Once spent, the normal baseline grace and 10-minute cadence govern steady-state, so the
    // kick fires at most once per window: it only ever SKIPS the first-interval grace on resume.
    const justResumed = resumeKickArmed;
    // A real advance ENDS the streak: the agent worked, so the next nudge (if any) starts soft again.
    // Done every sweep, before the decision, so an advance resets escalation even on a tick that then
    // refuses to nudge for some other reason.
    if (advancedRecently) consecutiveIdleNudges = 0;
    const backlog = deps.readyBacklog();
    const capacity = deps.capacity();
    const unstaffed = deps.unstaffedBuildableEpics();
    const decision = decideImproveNudge({
      armed: deps.armed(),
      ownsProject: deps.ownsProject(),
      consentIsNever: deps.consentIsNever(),
      paneStatus: deps.paneStatus(),
      advancedRecently,
      justResumed,
      readyBacklogCount: backlog.ready,
      p1PipelineHealthCount: backlog.p1PipelineHealth,
      pipelineHealthFingerprint: backlog.p1PipelineHealthFingerprint,
      lastConciergeNotifyFingerprint,
      lastConciergeNotifiedAt,
      conciergeCadenceMs: CONCIERGE_NOTIFY_CADENCE_MS,
      freeSlots: capacity.freeSlots,
      activeWorkers: capacity.activeWorkers,
      workingAgents: capacity.workingAgents,
      reclaimableAgents: capacity.reclaimableAgents,
      unobservedAgents: capacity.unobservedAgents,
      unstaffedBuildableEpicCount: unstaffed.unstaffedBuildableEpicCount,
      nextReadyBead: backlog.nextReadyBead,
      lastNudgedAt,
      now,
      cadenceMs: NEVER_IDLE_CADENCE_MS,
    });

    if (!decision.nudge) return { sent: false, detail: decision.reason };

    // NO re-entrancy guard of its own: the Pusher already serialises its ticks with a `sweeping`
    // flag and AWAITS this hook inside that guarded tick, so a second sweep cannot start while this
    // send is in flight. A private `sending` flag here would be redundant with that and, worse, would
    // stay latched forever if a send never settled — permanently, silently disabling the watcher
    // (roborev 66023). The one serializer is the Pusher's.
    // SELECT THE MESSAGE by the decided shape. An `unstaffed-epic-alarm` verdict (an in_progress epic
    // with children and no live orchestrator, WITH admission headroom) sends the loudest push — the
    // three-alarm fire naming the epic count and free slots (bead sparkle-nu7gd9). A `respin` verdict
    // (idle + ready backlog + free slots + zero active workers) sends the specific, digit-carrying
    // "spin a drain fleet NOW" push naming the numbers (bead sparkle-4hwu2i). Otherwise the generic
    // INTAKE→PULL reminder, which ESCALATES by the
    // streak so far: `consecutiveIdleNudges` counts prior deliveries WITHOUT an advance, so the text
    // hardens the more the agent answers the nudge instead of shipping. Keyed on the advance
    // fingerprint (what the agent DID), so a reworded deferral cannot dodge it.
    const text =
      decision.kind === "unstaffed-epic-alarm"
        ? unstaffedEpicAlarmNudgeText(decision.epicCount, decision.freeSlots)
        : decision.kind === "fleet-idle-alarm"
          ? fleetIdleAlarmNudgeText(
              decision.readyCount,
              decision.reclaimable,
              decision.totalRows,
              decision.freeSlots,
            )
        : decision.kind === "respin"
          ? respinFleetNudgeText(decision.readyCount, decision.freeSlots)
          : decision.kind === "concierge-notify"
            ? conciergeNotifyNudgeText(decision.count)
            : // SELF-FEEDING PULL (bead sparkle-n2feho.1): when the code has chosen a concrete next item,
              // hand it over by NAME; escalation by streak applies exactly as it does to the generic
              // reminder, so an agent answering the nudge without shipping still gets the harder demand.
              decision.kind === "named-pull"
              ? namedPullNudgeText(decision.bead, consecutiveIdleNudges)
              : neverIdleNudgeText(consecutiveIdleNudges);
    const delivered = await deps.send(text);
    if (delivered) {
      lastNudgedAt = now;
      consecutiveIdleNudges += 1;
      // THE RESUME KICK IS SPENT HERE AND ONLY HERE — one delivered action per window mount. Beside
      // `lastNudgedAt` on purpose: both follow this function's stated "spend the budget against a
      // CONFIRMED delivery" discipline, so a send the transport could not confirm leaves the kick armed
      // and the next tick retries instead of falling back under the grace.
      resumeKickArmed = false;
      // A confirmed concierge-notify records WHICH red finding the concierge now knows about, so the
      // same still-open set is not re-surfaced until `CONCIERGE_NOTIFY_CADENCE_MS` has passed while a
      // brand-new red finding fires on its next eligible tick.
      if (decision.kind === "concierge-notify") {
        lastConciergeNotifiedAt = now;
        lastConciergeNotifyFingerprint = decision.fingerprint;
      }
    }
    return { sent: delivered, detail: delivered ? "nudged" : "transport-failed" };
  } catch (e) {
    log.warn("pusher", "never-idle nudge sweep threw", { error: String(e) });
    return { sent: false, detail: "errored" };
  }
}
