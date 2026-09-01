// orchestratorLiveness — is an epic ACTUALLY being driven right now, and if not, is a restart the
// remedy? Two pure questions the epic sweep asks before it spends an agent slot.
//
// ── THE MEASURED FAILURE (bead sparkle-kwl5r2.2) ──────────────────────────────────────────────
// The founder came back from ~2 days offline and asked "why are there no active epics right now?"
// 25 epics read `in_progress`, 17 of them named an orchestrator, and NOT ONE of those orchestrators
// was running. Every one was idle/errored/waiting with an activity timestamp 93-121 HOURS old. The
// board reported 25 epics in progress while zero work was happening on any of them, and it stayed
// that way until a human noticed.
//
// It was not the sweep being switched off — `epicSweepRunner.RESTART_ENABLED` ships `true`. The
// sweep ran every tick and answered `skip: orchestrator-alive` every tick, forever, because of one
// expression in `epicSweepRunner.candidateFor`:
//
//     const orchestratorAlive = bound.some((a) => alive(a.id) !== false);
//
// `alive` is `goalContinuationRunner.processAliveFor`, which reads `runtimeStore.status` — a map
// written by exactly one writer, a MOUNTED `AgentPane`. For an orchestrator whose pane this window
// is not hosting it returns `undefined`, and `undefined !== false` is `true`. So the epic read
// STAFFED on the strength of nobody having looked. That is the defect class the bead names:
// absence of evidence about an agent read as evidence of a healthy one.
//
// A fleet-wide death is precisely the case that produces it. The founder's machine has an
// intermittent DNS fault that kills Claude agents in BATCHES — several at once on `API Error: ...
// (ENOTFOUND)` and `No response from API`. When the whole fleet dies together there is no surviving
// pane to observe anything, so every orchestrator answers `undefined` and every epic reads staffed.
// The one moment the sweep is most needed is the one moment it is guaranteed to say nothing.
//
// ── THE SECOND WITNESS ALREADY EXISTS; THE SWEEP SIMPLY NEVER ASKED IT ────────────────────────
// `src-tauri/src/fleet.rs` reads every agent's hook log STRAIGHT OFF DISK — the `PreToolUse` /
// `PostToolUse` stream `src-tauri/src/hooks.rs` appends per agent — and `services/fleetWatch` polls
// it over `knownAgents.openAgentIdSet()`, the APP-WIDE open set (in-memory merged with the
// persisted copy), which deliberately "does NOT narrow this to what THIS window can see". The
// result lands in `runtimeStore.agentMovement` as `MovementEvidence`, needing no pane and costing
// no agent turn. `engine/fleetVerdict`'s own header puts it best: "Artifacts do not have a point of
// view: the hook log, the worktree mtime and the branch tip are equally readable whether anyone is
// looking."
//
// So this module joins the two witnesses. A status enum is a LATCH — it holds whatever the last
// mounted pane wrote, and for a fleet-wide death that is the shape the founder saw: `idle`, five
// days stale, with nothing able to retract it. A hook-event timestamp is a MEASUREMENT. Where they
// disagree, the measurement wins.
//
// PURE. Data in, data out — no store, no clock of its own, no React — so every rule below is
// testable as arithmetic, which is the same reason `engine/epicContinuation` is pure.
import type { AgentTabStatus } from "@sparkle/ui";
import type { ObservedVerdict } from "./observedAttention";
import type { DeathCause } from "./deathTypes";

/**
 * Statuses that mean A PERSON IS THE THING THIS AGENT IS WAITING ON — so its hook log going quiet is
 * the WAIT, not a death, and must never be read as one.
 *
 * ── WHY THIS EXEMPTION EXISTS (roborev 72648, High) ───────────────────────────────────────────
 * `processAliveFor`'s DEAD set is only `done|errored|stopped`, so `waiting`, `approval`, `blocked`
 * and `questions` all report ALIVE. And a hook log freezes at exactly those statuses:
 * `movementRetraction`'s header says it outright — a `PreToolUse` for a blocking tool with nothing
 * after it "is the picker being unanswered, not progress past it". Without this exemption the
 * silence rule below fires on a live agent sitting at an open prompt, and the sweep then hands the
 * epic back through `sendToBuild`, which for an already-live orchestrator writes the handoff text
 * into that PTY — a bracketed paste plus Enter, which ANSWERS the pending question with the handoff
 * text. A permission decision the human never made, taken while they are away, which is the exact
 * scenario the fix was written for.
 *
 * The remedy gate does not cover it either, and the reason is worth stating: `blocked-on-human` is a
 * DEATH cause, and a live blocked agent has no death record at all — so `deathCauseFor` returns
 * `undefined` and `restartRemedyFor` correctly answers `restart`. Liveness is the layer that has to
 * know this, not the remedy layer.
 *
 * ── IT IS NOT `windowStatus.isRedStatus`, AND THAT IS DELIBERATE ──────────────────────────────
 * That predicate asks a COLOUR question and is wrong at both edges here. It INCLUDES `errored`,
 * which is a death this module has already answered one rule earlier and which must stay
 * answerable. It EXCLUDES `questions`, which is blue by an explicit founder decision ("why are they
 * red when they don't require my assistance?") but is still, literally, an agent that asked a person
 * something and is waiting — so its log freezes identically.
 *
 * ── MEMBERSHIP IS NOT ENOUGH: THE LATCH CANNOT RETRACT (roborev 73028, High) ──────────────────
 * The status this set is tested against is `runtimeStore.status`, which is THE SAME
 * non-retractable latch this module was written to distrust. `AgentPane` is its only writer, the
 * entry is cleared by `close()` and by nothing else — not by unmount, not by PTY death — and
 * `livenessOf` calls an agent `local` merely because an entry EXISTS. So an orchestrator that hit
 * an `AskUserQuestion`, wrote `waiting`, and then died in the ENOTFOUND batch kill keeps `waiting`
 * for the window's life. Membership alone would therefore make the silence rule UNREACHABLE for
 * these four statuses and re-open the original incident for exactly the rows it named: the bead
 * records them as "idle/errored/**waiting**", so `waiting` was in the measured population.
 *
 * The asymmetry decides it. The hazard the exemption prevents — a paste into an open prompt —
 * requires the agent to be genuinely live NOW; the latch cannot tell "live and waiting" from "died
 * while waiting", and getting it wrong that way is PERMANENT. So the exemption requires a witness
 * that CAN retract: {@link OrchestratorEvidence.observedAttention}, read off the agent's own grid
 * every second in the Rust process and swept to `gone` when its PTY dies — which is precisely the
 * property `runtimeStore.status` lacks, and precisely why that channel exists ("a held verdict that
 * outlives its terminal is a latched reading with no writer that can move it").
 *
 * ── THE PRECEDENT ─────────────────────────────────────────────────────────────────────────────
 * `engine/busyLiveness` applies the same stale-movement rule and restricts it to `working` alone,
 * saying why in the same words: the red tiers "are someone waiting on the human, not a claim the
 * process is producing output". This module reintroduced what that one refuses; this set is the
 * repair. It is stated as an EXEMPTION rather than as an allowlist of working tiers because `idle`
 * must remain subject to the rule — the founder's 17 measured orchestrators read `idle`, and a
 * working-tiers-only reading would exempt exactly the population this module exists to catch.
 */
export const WAITING_ON_HUMAN: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "questions",
  "waiting",
  "approval",
  "blocked",
]);

/**
 * How long an orchestrator may produce NO hook event before the sweep stops counting it as staffing
 * its epic.
 *
 * ── WHY IT IS NOT `fleetVerdict.SILENT_AFTER_MS` (10 minutes) ─────────────────────────────────
 * That constant answers "should a human look at this agent", and its cost of being wrong is one
 * unnecessary glance. This one authorizes SPENDING AN AGENT SLOT, so it is sized to be
 * embarrassingly generous rather than merely defensible.
 *
 * One hour is 6× that bar. `PostToolUse` fires on tool COMPLETION, so an agent inside a single long
 * call — a full `cargo test` cold build, a `pnpm verify` run, a long CI wait polled by one Bash
 * invocation — emits nothing for the duration of it, and the longest such call this repo produces
 * is well inside 20 minutes. An hour leaves 3× headroom over that and is still 1/121st of the
 * silence actually measured.
 *
 * ── AND THE COST OF ERRING SHORT IS ALREADY BOUNDED, WHICH IS WHY LONG IS AFFORDABLE ──────────
 * A wrong `false` does NOT spawn a rival: `services/sendToBuild` REUSES the build agent already
 * bound to an epic rather than creating a second one, `mountAgentAwaited` refuses to tear down an
 * orchestrator that recovered in the meantime (reporting `already-live`), and the sweep is capped
 * at `epicSweepRunner.MAX_RESTARTS_PER_SWEEP` per project per tick. A wrong `true` cost 25 epics
 * 121 hours each. The two directions are not symmetric and this number is not a compromise between
 * them — it is the largest window that still catches the measured failure by two orders of
 * magnitude.
 */
export const ORCHESTRATOR_SILENT_MS = 60 * 60 * 1000;

/**
 * What this window can establish about one bound orchestrator, from BOTH witnesses.
 *
 * Both fields carry their own "we did not look" value, and neither may be folded into the other —
 * that fold is the entire bug (see the header).
 */
export interface OrchestratorEvidence {
  /**
   * `goalContinuationRunner.processAliveFor`'s answer: `true` observed alive, `false` observed dead,
   * `undefined` NOT OBSERVED BY THIS WINDOW (no mounted pane, so `runtimeStore.status` has nothing
   * that can be trusted as current).
   */
  observedAlive: boolean | undefined;
  /**
   * The RAW observed status behind {@link observedAlive}, when this window has one.
   *
   * Read for exactly one thing: {@link WAITING_ON_HUMAN}. `undefined` means this window observed no
   * status, in which case the silence rule applies unmodified — which is the measured case (an
   * orchestrator whose pane nobody is hosting) and must keep working.
   *
   * RAW, not composited: the composite carries an `unmerged` overlay written over other statuses,
   * which is the same reason `processAliveFor` insists on the raw map.
   */
  observedStatus?: AgentTabStatus | undefined;
  /**
   * What the Rust nudger last read off this agent's GRID, or `undefined` for no reading.
   *
   * THE RETRACTING WITNESS. `services/observedAttentionListener` clears the entry on a `gone`
   * verdict — emitted when the PTY is swept — so unlike {@link observedStatus} an absence here is a
   * real signal rather than a frozen claim. That is the whole reason it is consulted.
   *
   * `undefined` covers BOTH "never had a reading" and "retracted", and they are deliberately not
   * distinguished: neither corroborates a live wait, and the answer for both is the same honest
   * `null`.
   */
  observedAttention?: ObservedVerdict | undefined;
  /**
   * Does the DURABLE ledger record that this agent's session ended?
   *
   * `deadSessionRegistry.deathCauseForAgent !== undefined` — this window's observations with a
   * fallback to the `agent-life` ledger republished by `revival_due`, so a death no surviving pane
   * witnessed still counts. It is the one POSITIVE statement available that the process is gone,
   * which is what makes it safe to act on a latched wait: a dead PTY has no prompt to type into.
   */
  deathRecorded?: boolean;
  /**
   * `MovementEvidence.lastEventMs` for this agent — when its hook log last recorded ANY event —
   * or `null`/`undefined` when there is no reading at all (`fleet_digest` has not polled yet, the
   * agent is cloud or has no worktree so the digest skips it, or its hook log is empty).
   *
   * ANY EVENT, NOT ONLY `PreToolUse`/`PostToolUse`, and the difference is deliberate. The bead asks
   * for "no PreToolUse/PostToolUse event inside a stated window"; counting `Stop` and `SessionStart`
   * as well is the STRICTLY MORE GENEROUS reading, so a `false` verdict here is stronger than what
   * was asked for, never weaker. Reading only the tool events would be the direction that invents
   * deaths.
   */
  lastHookEventMs: number | null | undefined;
}

/**
 * Is this orchestrator actually driving anything?
 *
 * Three-valued, and the third value is the point: `null` is "we could not establish it", which
 * `engine/epicContinuation` already refuses to act on (`skip: staffing-unknown`) and already
 * refuses to CLEAR an escalation on. Collapsing it onto `true` is what this module exists to undo.
 *
 * The rules, in the order they are read:
 *
 *   1. A window WATCHED it die (`observedAlive === false`) ⇒ `false`. The strongest possible
 *      reading; no artifact can overturn a witnessed death, and a stale hook log would only agree.
 *   2. THE HOOK LOG IS OLDER THAN THE WINDOW ⇒ `false`, EVEN WHEN `observedAlive === true`. This is
 *      the arm that fixes the measured failure. A latched `idle` from a pane that mounted five days
 *      ago is not evidence about now; a timestamped absence of work is.
 *   3. The hook log moved inside the window ⇒ `true`. Something ran. Whatever the status says.
 *   4. No artifact reading, but this window OBSERVED the process alive ⇒ `true`. Unchanged from
 *      today's behaviour for a mounted, watched agent, and the only witness left.
 *   5. No artifact reading and no observation ⇒ `null`. Nobody looked, and nothing was readable.
 *      Today this answers `true` and holds an epic dead forever; naming it is the fix.
 *
 * A future `lastHookEventMs` (clock skew between the hook emitter's wall clock and ours) is treated
 * as NO READING rather than as "just now" — the same refusal `fleetVerdict.freshestEvidence` makes,
 * and for the same reason: a skewed stamp read as fresh would mask a genuinely dead orchestrator
 * permanently, which is the exact failure this module exists to end.
 */
export function orchestratorLivenessOf(
  e: OrchestratorEvidence,
  now: number,
  silentMs: number = ORCHESTRATOR_SILENT_MS,
): boolean | null {
  if (e.observedAlive === false) return false;

  // A PERSON IS THE BLOCKER, SO THE SILENCE IS THE WAIT. Checked before the artifact is read at all:
  // an agent sitting at an open prompt is STAFFING its epic — restarting it would type into that
  // prompt — and no hook-log age can make that untrue. See WAITING_ON_HUMAN. This returns the same
  // answer the one-witness code gave for these rows, so it is a preserved behaviour, not a new one.
  if (e.observedAlive === true && e.observedStatus !== undefined && WAITING_ON_HUMAN.has(e.observedStatus)) {
    // A LATCHED `waiting` IS A CLAIM, NOT A READING, so it is corroborated. Two POSITIVE witnesses
    // are accepted and nothing else; anything short of one answers `null` (`staffing-unknown`),
    // which spends nothing and — unlike `true` — makes no claim of health.
    //
    //   awaiting          the grid SAW a prompt on screen. Staffing. Never touch it.
    //   a death record    the DURABLE ledger says the session ended, so there is no prompt to type
    //                     into and acting is safe. This is the arm that actually recovers the
    //                     ENOTFOUND-batch-kill population.
    //
    // ── WHY `calm`/`delegating` ARE NOT A THIRD ARM (adversarial review of d9de06a04) ──────────
    // An earlier cut let those two fall through to the silence rule, on the reasoning that "the
    // grid saw NO prompt, so there is nothing to paste into". BOTH HALVES OF THAT WERE WRONG.
    //
    // `Calm` does not mean "no prompt". `observed_attention.rs` maps `Refusal::AwaitingInput` to
    // `Verdict::Calm` whenever `screen_awaits_input` fails to re-confirm — and `nudge_gate`'s
    // `write_refusal` has ALREADY failed that same predicate before it can return `AwaitingInput`,
    // so every prompt detected only by its live-region arm (`menu_line` / `question_opener`)
    // becomes `Calm` BY CONSTRUCTION. The Rust comment says so and defends the trade in the open —
    // "a prompt missed here is still caught by the pane's own classifier the moment anyone opens
    // it" — a trade made when the consumer was a ROW COLOUR. Letting it authorize a PTY write makes
    // this module overrule the classifier that was supposed to be the backstop.
    //
    // And the arm could never have helped the population it was written for. A dead PTY is swept by
    // `nudger.rs`, which emits `gone`, which CLEARS the entry — so a died-while-waiting orchestrator
    // reads `undefined` here, never `calm`. The only population in which that arm was reachable at
    // all was an agent whose PTY IS STILL LIVE: precisely where a paste is dangerous, and precisely
    // nowhere it was useful. Deleting it costs nothing and closes the hazard.
    //
    // ── AND WHY THERE IS NO FRESHNESS BOUND ON `awaiting` ─────────────────────────────────────
    // Deliberate, and the opposite of the rule one branch down. The producer emits ON CHANGE, not
    // every tick (`runtimeStore.setObservedAttention`: "a missing agent this tick means unchanged,
    // never no evidence"), so an agent legitimately parked at a prompt for three hours carries an
    // `atMs` three hours old. An age bound would expire exactly the long waits this exemption
    // exists to protect. The guarantee here is RETRACTION, not recency — which is why this witness
    // was chosen over the status latch in the first place. The residual is a wedged nudger leaving
    // a stale `awaiting`; that fails to `true` ⇒ skip, i.e. an epic not recovered, which is the
    // safe direction.
    if (e.observedAttention === "awaiting") return true;
    if (e.deathRecorded === true) return false;
    return null;
  }

  const ts = e.lastHookEventMs;
  const readable = ts !== null && ts !== undefined && Number.isFinite(ts) && ts > 0 && ts <= now;
  if (readable) return now - (ts as number) <= silentMs;

  if (e.observedAlive === true) return true;
  return null;
}

/**
 * Roll the per-agent verdicts up to the one fact `EpicSweepCandidate.orchestratorAlive` carries.
 *
 * ANY staffing agent staffs the epic, so `true` wins outright — an epic with one live orchestrator
 * and three dead tabs is staffed, and restarting it would be the rival spawn the three-valued
 * reading exists to avoid.
 *
 * With no `true`, a single `null` makes the whole answer `null`: one unreadable agent means we
 * cannot say the epic is unstaffed, and "unstaffed" is the claim that authorizes the spend.
 *
 * EMPTY LIST ⇒ `false`, and that is a real observation rather than an accident of `Array.some`.
 * The caller has a roster and found nothing bound to this epic; that is exactly the genuinely
 * unstaffed epic the sweep was built for. (A caller that could NOT read the roster must not call
 * this at all — `epicSweepRunner.candidateFor` passes `null` directly for that case, because an
 * unread roster and an empty one are different facts.)
 */
export function epicOrchestratorLiveness(
  verdicts: readonly (boolean | null)[],
): boolean | null {
  if (verdicts.some((v) => v === true)) return true;
  if (verdicts.some((v) => v === null)) return null;
  return false;
}

/**
 * What a dead orchestrator actually NEEDS. Restarting is one of three answers, not the default.
 *
 * ── CONFLATING THE DEATH MODES IS THE TRAP THIS ANSWERS ───────────────────────────────────────
 * The sweep's restart costs a real agent slot and a real spawn. Spending one against a door that a
 * clock or a person has to open is not a recovery, it is a retry into a wall — and this app has
 * already measured what that costs: 2,273 account-wall records across 1,102 sessions, one session
 * retrying into a closed door 45 times (see `engine/deathTypes`). Every LLM in the app is gated by
 * the SAME account limit, so a fleet-wide wall is exactly when the fleet is most tempted to hammer.
 *
 * ── IT INVENTS NO VOCABULARY ──────────────────────────────────────────────────────────────────
 * The classification is `engine/deathRecord.classifyDeath`'s, durable in `src-tauri/agent_life.rs`
 * and read synchronously through `services/deadSessionRegistry.deathCauseForAgent`. This function
 * only maps that verdict onto the one decision the EPIC sweep has to make. A second classifier
 * over the same strings would be a second opinion, which this repo ranks as worse than none.
 */
export type RestartRemedy =
  /** A restart is the right remedy and the sweep may spend one. */
  | "restart"
  /**
   * An ACCOUNT WALL. A restart cannot help: the door opens on the account's own clock
   * (`wall-session`) or when a human raises a cap (`wall-spend`), and neither is moved by spawning.
   * `engine/resurrection` already owns the ladder that waits and probes, so the epic's remedy is to
   * hold the epic eligible and try again next tick — NOT to escalate, because nothing is wrong with
   * the epic and a `stalled` mark would be a false alarm in the founder's Blocked lane.
   */
  | "wall"
  /**
   * A PERSON is the thing it is waiting on: the agent stopped on a real question
   * (`blocked-on-human`), or a human deliberately stopped it (`human-stopped`). Restarting re-asks
   * nothing and overrides a stated decision. `deathTypes.isResurrectable` refuses both for exactly
   * these reasons; this agrees with it rather than re-deciding it.
   */
  | "human";

/**
 * Map a death cause onto the epic sweep's decision.
 *
 * `undefined` — NO DEATH RECORD FOR THIS AGENT — is `"restart"`, and that is load-bearing: it is
 * the common case (an orchestrator whose process vanished with no observer, on a machine that has
 * since restarted the app) and reading it as a wall would switch the whole recovery off on the
 * strength of a missing record. Silence is not a wall. The staffing verdict above is what
 * established that the epic needs help; this function only declines the cases where help of THIS
 * shape is provably useless.
 *
 * `clean-goal-met` is `"restart"`, which reads backwards until you note WHICH question is being
 * asked. `deathTypes.isResurrectable` says never resurrect a met goal, and it is right: that is
 * about the AGENT, whose stated finish line is behind it. This is about the EPIC, and the sweep has
 * already established that the epic is NOT done (`decideEpicSweep` returns before here for
 * `status === "done"`). An orchestrator that marked its own goal met and left an epic with open
 * children is precisely the founder's measured population — 17 of them, goals reading `met` or
 * `expired` — and it is the one case where the agent's own verdict must not be the epic's.
 *
 * Exhaustive over `DeathCause` by construction: a new cause is a compile error here, which is the
 * only thing that keeps this map from silently defaulting a novel death to a spend.
 */
export function restartRemedyFor(cause: DeathCause | undefined): RestartRemedy {
  if (cause === undefined) return "restart";
  switch (cause) {
    case "wall-session":
    case "wall-spend":
      return "wall";
    case "blocked-on-human":
    case "human-stopped":
      return "human";
    case "transport-transient":
    case "app-restart":
    case "process-gone":
    case "startup-no-show":
    case "clean-goal-met":
    case "unknown":
      // `transport-transient` is the founder's own batch-death signature (ENOTFOUND / no response
      // from the API) and is the case this whole change is for: a restart IS the remedy, and it
      // should not need a human to notice. (Note in the body, not between labels — a comment
      // between two case labels is what `no-fallthrough` reports, and it is an ERROR in this
      // package's lint gate.)
      return "restart";
  }
}

/**
 * The remedy for a whole epic, given every bound orchestrator's death cause.
 *
 * `"restart"` wins if ANY bound agent can be restarted — one agent behind a wall must not hold an
 * epic that has another it could hand to. Otherwise a wall outranks a human block, because a wall
 * LIFTS ON ITS OWN and re-asking the founder about an epic that is merely waiting out an account
 * limit is the false alarm this vocabulary exists to avoid.
 *
 * EMPTY LIST ⇒ `"restart"`: nothing is bound, so no death record can argue against handing the
 * epic to a fresh agent. This is the label-watched epic with no agent bound at all, which the
 * runner already restarts today.
 */
export function epicRestartRemedy(
  causes: readonly (DeathCause | undefined)[],
): RestartRemedy {
  const remedies = causes.map(restartRemedyFor);
  if (remedies.length === 0 || remedies.includes("restart")) return "restart";
  if (remedies.includes("wall")) return "wall";
  return "human";
}
