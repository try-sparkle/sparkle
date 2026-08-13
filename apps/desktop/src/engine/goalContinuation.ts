// goalContinuation — "the turn ended and the goal is not met, so start another one."
//
// THE FAILURE THIS CLOSES, from the log that commissioned it (sparkle.log.2026-07-29):
//
//   15:41:01  agent bfdaa698  transition {"from":"working","to":"idle"}  source="hook"
//   ...thirty minutes of nothing...
//   16:11:28  agent bfdaa698  transition {"from":"idle","to":"working"}  source="hook"
//
// It was not blocked, not waiting on the human, not waiting on CI. Its last output said "Now back
// to building" and it was mid-write on a file. Its turn simply ended — Claude Code turns end when
// the model stops emitting — and the only thing that restarted it was a human noticing a gray row
// half an hour later. Thirty-seven such stalls that day; 23.6 aggregate agent-hours; the longest a
// single agent idle for 153 minutes mid-task.
//
// THE DANGEROUS VERSION OF THIS FIX is a loop that restarts an agent that cannot make progress —
// which burns tokens forever and is strictly worse than the stall it replaces, because a stall at
// least stops. Every rule below exists to bound that, and they fall into two groups:
//
//   GATES (is restarting even meaningful?)   — a met/expired/escalated goal, a non-idle status, a
//     GUESSED idle, an agent that cannot take input, an idle that has not yet settled.
//   BOUNDS (has restarting stopped working?) — consecutive attempts without progress, and a
//     per-goal total that survives a flapping progress mark.
//
// PURE. `decideContinuation` is data-in-data-out — clock, status and progress all arrive as
// parameters — so every rule is tested as arithmetic. The mount that spends real money on the
// decision lives in services/goalContinuationRunner.
import type { AgentTabStatus } from "@sparkle/ui";
import { type AgentGoal, goalStateOf } from "./agentGoal";
// BOTH, and they are two halves of one rule rather than two rules. `agentOriginated` says text
// SPARKLE authored carries no information about the agent (so a resume is neither a repeated command
// nor progress); `quotaBlock` says an agent behind an account limit cannot act at all. Together they
// are why this module refuses to resume: once because resuming would prove nothing, once because it
// would achieve nothing. See the gate order in `decideContinuation`.
import { RESUME_PROMPT_MARKER } from "./agentOriginated";
import { type QuotaBlock, isQuotaBlocked } from "./quotaBlock";
// NOTE: this module deliberately does NOT import `CLOUD_MIN_START_CENTS`. It used to, to alias
// CLOUD_MIN_CONTINUE_CENTS to it — and that alias was the last route by which the START bar could
// reach a RESUME decision. The two floors answer different questions and the server states them
// separately, so the dependency is gone rather than merely unused. A test reads these import lines,
// because the two constants hold the same value and no behavioural assertion can see a re-alias.

/**
 * How long a row must sit CONTINUOUSLY idle before an auto-continue is allowed.
 *
 * This is the flap guard, and it is load-bearing rather than cosmetic. Status is derived from
 * whether Claude's spinner is on screen, so brief gaps between tool calls register as idle — the
 * commissioning log caught three full idle→working→idle cycles inside thirty seconds while the
 * agent was working the whole time:
 *
 *   15:17:06 idle->working trigger=spinner-seen
 *   15:17:08 working->idle trigger=spinner-gone-settle
 *   15:17:27 idle->working trigger=spinner-seen
 *   15:17:31 working->idle trigger=spinner-gone-settle
 *
 * Auto-continuing on one of those two-second gaps would type into a terminal mid-turn — the exact
 * interruption `send_to_agent_terminal` refuses to make. Forty-five seconds is comfortably longer
 * than any observed flap and still an order of magnitude below the two-minute floor the PRD counts
 * as a stall, so a real stall is caught long before a human could notice it.
 */
export const IDLE_SETTLE_MS = 45_000;

/** Consecutive auto-continues WITHOUT the progress mark moving, before we escalate to the human.
 *
 *  Three, not one: the first restart of a genuinely stuck agent often does produce progress (the
 *  common case is a turn that ended mid-thought), and escalating on a single unproductive attempt
 *  would page the human for the very thing this exists to handle. Three unproductive restarts in a
 *  row is no longer bad luck. */
export const MAX_CONTINUES_WITHOUT_PROGRESS = 3;

/** Auto-continues allowed on ONE goal in total, however much progress is observed in between.
 *
 *  The backstop for a mark that flaps. `MAX_CONTINUES_WITHOUT_PROGRESS` is measured against a
 *  progress signal, and any progress signal can be wrong — a value that changes for reasons
 *  unrelated to real work would reset the consecutive counter forever and turn "bounded retry"
 *  into an unbounded loop with extra steps. This bound cannot be reset by anything the agent
 *  itself does; only the human (or a NEW goal) clears it. Twenty restarts is far more than any
 *  healthy goal needs and still a hard ceiling on the spend. */
export const MAX_CONTINUES_TOTAL = 20;

/**
 * The FALLBACK balance a cloud auto-continue must clear, in cents — used only when `/me` stated no
 * resume floor of its own.
 *
 * The server's number is now wired: {@link CloudEvidence.minContinueCents} carries
 * `cloudAgentPricing.minContinueCents` and {@link cloudRefusal} prefers it. This constant is what
 * remains for an older orchestration build that does not send one, and it stays the 1¢ "obviously
 * empty wallet" check — deliberately fail-open, because an un-stated floor is a floor we do not
 * know, and the server refuses the resume itself if we are wrong.
 *
 * **A LITERAL, no longer aliased to `CLOUD_MIN_START_CENTS`.** Be precise about which number that
 * is: the CLIENT's start constant is also 1¢ today — it is the same "obviously empty" check — and
 * the server's flat $1 spawn rule lives only in `me.cloudAgentPricing.minStartCents`, never in a
 * constant here. So de-aliasing changed no value and fixes no live bug. It closes a FUTURE one: the
 * client start constant has moved before (it was 50¢), and while the two were joined by
 * `= CLOUD_MIN_START_CENTS`, moving it again would have dragged the resume bar along silently —
 * every user on an older `/me` refused a resume at the spawn bar, which is the stranded-runway
 * failure the rest of this doc exists to prevent. Two numbers that are equal today but answer
 * different questions get two definitions. Because the values match, no behavioural test can catch
 * a re-alias; `goalContinuation.test.ts` pins it by reading this file's imports instead.
 *
 * On the SERVER the two bars are far apart: starting requires a flat $1 minimum balance, resuming
 * only that the next few minutes are affordable (5¢ at today's rate). Substituting
 * `minStartCents` here — the way `useCloudAgents` and `conciergeTools/lifecycle` legitimately do on
 * the START path — is a money bug: the resume bar silently jumps 5¢ → $1, and a user holding 99¢
 * (about 110 affordable running minutes) has their paused agent abandoned by a background timer with
 * nothing on screen to explain it. On this path no round-trip corrects the over-refusal, so it
 * strands credit the user paid for. `goalContinuationRunner.cloud.test.ts` pins that a `/me`
 * carrying only `minStartCents` leaves a 50¢ wallet continuing.
 */
export const CLOUD_MIN_CONTINUE_CENTS = 1;

/** Why no auto-continue happened. Every arm is a REASON, never a bare false, because this is the
 *  field the concierge reads when it wants to know why a stalled-looking agent was left alone. */
export type NoContinueReason =
  | "no-goal"
  | "goal-met"
  /** Sparkle itself closed the goal after git proved the work reached the default branch. Distinct
   *  from `goal-met`, which is somebody's CLAIM — the concierge reading these out should be able to
   *  say which of the two happened, because only one of them is auditable. */
  | "goal-discharged"
  | "goal-expired"
  | "already-escalated"
  | "not-idle"
  | "process-gone"
  | "liveness-unknown"
  | "idle-not-settled"
  | "no-turn-end-authority"
  | "cannot-accept-input"
  | "quota-blocked"
  // ── CLOUD-ONLY. See `CloudEvidence` and the cloud gate block in `decideContinuation`. ──────────
  /** The account can no longer pay for sandbox minutes. Resuming would 402 at best. */
  | "cloud-out-of-credits"
  /** The sandbox is hibernated. Input written at it goes nowhere, and waking it is a billing
   *  decision that belongs to the user rather than to a 15-second timer. */
  | "cloud-session-paused"
  /** The server parked the session — credit exhaustion, or the agent is asking its human. */
  | "cloud-session-waiting"
  /** The session row exists but its sandbox has not come up yet; there is nothing to type into. */
  | "cloud-session-starting"
  /** The session finished or errored server-side. Nothing to continue. */
  | "cloud-session-ended"
  /** This window has no CURRENT reading of the session's lifecycle (never listed it, or the
   *  reading expired). Fails closed — see `CloudEvidence.sessionStatus`. */
  | "cloud-session-unknown"
  /** The desktop's relay socket is down, so `CloudTransport.write` would silently no-op. */
  | "cloud-offline";

export type ContinuationDecision =
  | { action: "continue"; prompt: string; attempt: number }
  | { action: "escalate"; reason: string }
  | { action: "none"; reason: NoContinueReason };

/**
 * What this window knows about a CLOUD agent's sandbox. Required whenever `runtime` is `"cloud"`.
 *
 * WHY A CLOUD AGENT NEEDS ITS OWN EVIDENCE BUNDLE AT ALL. Every other field on
 * {@link ContinuationInput} is ultimately a reading of a process on THIS machine: `status` is
 * derived from a local terminal's output, `hasTurnEndAuthority` from a local hook stream or spinner,
 * `processAlive` from a local `pty:exit`. A cloud agent's sandbox is on someone else's computer, it
 * survives the laptop closing, and it can be hibernated or parked by a server this window never
 * hears from. So the local readings answer "what did the last frames we received look like" — which
 * is genuinely useful, and is why the fields above are still consulted — but they cannot answer "is
 * there a running sandbox at the other end of the wire, and may we spend the user's money on it".
 * These three do.
 *
 * ALL THREE FAIL CLOSED, with MORE force than the local ones. `processAlive`'s doc says never spend
 * money typing into a terminal that might not be there; a cloud sandbox bills by the minute, so the
 * same rule reads: never spend money waking one. A cloud agent must not be easier to auto-continue
 * than a local one, and the gate order below keeps that true — a cloud agent passes every gate a
 * local agent passes, and then these as well.
 */
export interface CloudEvidence {
  /**
   * The server-side session lifecycle as this window CURRENTLY reads it
   * (`services/cloudAgents/sessionStatus`), or `undefined` when it has no current reading.
   *
   * Only `active` is continuable. `paused`/`waiting` are refused by NAME rather than by falling
   * through some other gate, because "resuming would restart billing the user did not ask for" and
   * "the agent is asking you a question" are things a human needs told, and a generic `not-idle`
   * tells them neither. `undefined` refuses too: a lifecycle reading is a snapshot of a remote
   * machine and the reader expires it on purpose, so absent evidence is absent, never `active`.
   */
  sessionStatus: string | undefined;
  /**
   * The account balance in cents as this window last read it (`authStore.me.balanceCents`), or
   * `undefined` when it has not loaded.
   *
   * A KNOWN-EMPTY wallet is its own refusal ({@link CLOUD_MIN_CONTINUE_CENTS}) rather than something
   * the user discovers from a resume that 402s server-side. An UNKNOWN balance is deliberately NOT a
   * refusal here — it would fire on every cold start before `me` settles, and it does not need to
   * be, because `sessionStatus` already refuses everything this window has not currently observed.
   */
  balanceCents: number | undefined;
  /**
   * The server's RESUME floor (`me.cloudAgentPricing.minContinueCents`), or `undefined` when the
   * server stated none (an older orchestration build).
   *
   * THE RESUME NUMBER, NEVER THE START NUMBER. The server enforces two floors and publishes both;
   * this arm decides a resume, so it reads the resume one. Absent falls back to
   * {@link CLOUD_MIN_CONTINUE_CENTS} — the 1¢ obviously-empty check — and explicitly NOT to
   * `minStartCents`: quoting the $1 start floor at a resume would abandon a paused agent whose owner
   * can afford ~110 more minutes, and unlike the start path there is no server round-trip afterwards
   * to correct the refusal. See {@link CLOUD_MIN_CONTINUE_CENTS} for the whole argument.
   *
   * REQUIRED-but-nullable, like `balanceCents` beside it: a producer must SAY it does not know,
   * because omission here falls back to the permissive 1¢ constant, and a gate this file insists
   * must fail closed should not be able to fail open by an oversight that still compiles.
   */
  minContinueCents: number | undefined;
  /**
   * Is the desktop's relay socket connected? Asked because `CloudTransport.write` emits into
   * `getSocket()?.emit(...)` and SILENTLY NO-OPS on a null socket — a dropped resume would otherwise
   * be recorded as a delivered one, spending a retry against a mark that cannot move and eventually
   * escalating to a human with a reason that never happened.
   */
  relayConnected: boolean;
}

export interface ContinuationInput {
  goal: AgentGoal | undefined;
  /** The agent's OWN status (not a rollup). */
  status: AgentTabStatus;
  now: number;
  /**
   * Where the agent actually runs. STATED, never inferred from the presence of {@link cloud}:
   * inferring it would make a cloud agent whose evidence was forgotten look local, and take the
   * local path — the permissive one — which is the exact direction a fail-closed gate must not fail.
   */
  runtime: "local" | "cloud";
  /**
   * Cloud-only evidence; `undefined` for a local agent, and REQUIRED-BUT-NULLABLE for the same
   * reason `processAlive` is (see its note). A cloud agent that arrives here with no bundle is
   * refused as `cloud-session-unknown` — not waved through — and forgetting to pass the key at all
   * is a compile error rather than a silent permissive default.
   */
  cloud: CloudEvidence | undefined;
  /** Epoch ms the row last became idle, or undefined if it is not idle. Drives {@link IDLE_SETTLE_MS}. */
  idleSince: number | undefined;
  /**
   * Does some source actually WITNESS the end of a turn for this agent (engine/turnEndAuthority)?
   *
   * Reusing that module rather than inventing a second answer is the single most important
   * borrowing in this file. Without a witness, `idle` means "quiet", not "finished" — and quiet is
   * equally consistent with a six-minute `pnpm test` running. Auto-continuing on a guessed idle
   * would type a prompt into a terminal in the middle of a live tool call. The gate that protects
   * destructive git operations from that same ambiguity is the right gate here too.
   */
  hasTurnEndAuthority: boolean;
  /** `services/conciergeDispatch.agentCanAcceptInput` — fails closed for an unknown agent. */
  canAcceptInput: boolean;
  /**
   * Is the agent's PROCESS still alive? Only consulted for `unmerged`, and required there.
   *
   * `unmerged` is not a status an engine ever sets: `unmergedAttention.withUnmergedWork` OVERLAYS
   * it onto any row already resting in `idle`, `done` OR `stopped`. So unlike `idle` — which is
   * derived from a live PTY's output and therefore witnesses its own liveness — `unmerged` says
   * nothing about whether the process exists. Continuing a `done`/`stopped` agent that the overlay
   * relabelled would type `continuePrompt` into a dead PTY, spend a retry against a mark that
   * cannot move, and three rounds later escalate to the human with the false reason "something is
   * blocking it that restarting cannot fix" — while `canAcceptInput` (true for any local agent) and
   * `hasTurnEndAuthority` (an exited PTY is its STRONGEST witness) both wave it through.
   *
   * Fails CLOSED: absent, the band is not continued. Never spend money typing into a terminal that
   * might not be there.
   *
   * REQUIRED-BUT-NULLABLE rather than optional, and that distinction is the whole point (roborev
   * 55298). While it was optional the first caller written would have compiled without it, taken the
   * refusal branch for EVERY `unmerged` row — the fleet's most common band — and produced `none`,
   * which never reaches the bounds either: never continued AND never escalated, verbatim the
   * silent-forever state this module exists to abolish, with no test able to see it. Spelling it
   * `boolean | undefined` means "I looked and it is gone" and "I did not look" both stay
   * expressible, but forgetting to say is a compile error. The producer is
   * `engine/turnEndAuthority.processAliveOf`, which is exported in THIS polarity on purpose — an
   * earlier `hasExited` had the identical type and the opposite meaning, so the obvious wiring
   * compiled and inverted the gate (roborev 55338).
   */
  processAlive: boolean | undefined;
  /** The current progress mark (see {@link progressMark}). */
  mark: string;
  /**
   * An observed account/quota wall (engine/quotaBlock), or `undefined` for none seen.
   *
   * THE BOUND THIS ADDS IS A TIME, NOT A COUNT, and that is what the existing bounds could not
   * express. `MAX_CONTINUES_WITHOUT_PROGRESS` asks "has restarting stopped working?" — a reasonable
   * question that needs three wasted restarts to answer. Here the answer is stated IN THE ERROR
   * before the first attempt: nothing can run until 4pm. Resuming into that is not a retry with poor
   * odds, it is a retry with zero odds, and the observed loop burned turns against it for hours
   * while looking busy.
   *
   * Worse, the count-based bounds could not even catch it eventually: a refusal that costs an
   * attempt would have escalated to the human with "something is blocking it that restarting cannot
   * fix" — true, but arrived having spent the whole retry budget and told them nothing about WHEN.
   */
  quotaBlock?: QuotaBlock;
}

/**
 * Should this agent be restarted right now?
 *
 * Read the arms in order — the sequence encodes the priority, and two orderings matter:
 *
 *   • The GOAL gates come before the STATUS gates, so an agent with no goal is "no-goal" rather
 *     than "not-idle". The caller uses this reason to explain itself to a human, and "it has no
 *     goal" is the actionable sentence; "it isn't idle" sends them looking at the wrong thing.
 *   • The BOUNDS come LAST, after every gate. Escalation is a real event with a human cost, so it
 *     must only fire on an agent we would genuinely otherwise have restarted — never on one that
 *     merely looks bad while it is busy, un-witnessed, or unreachable.
 */
export function decideContinuation(input: ContinuationInput): ContinuationDecision {
  const { goal, status, now, idleSince, hasTurnEndAuthority, canAcceptInput, mark, processAlive } =
    input;

  const state = goalStateOf(goal, now);
  if (state === "none") return { action: "none", reason: "no-goal" };
  if (state === "met") return { action: "none", reason: "goal-met" };
  // BESIDE `met`, NOT AFTER THE STATUS GATES. A discharged goal is finished work; without this arm
  // `discharged` falls past every goal gate to the status checks and a proven-complete agent is
  // auto-continued — restarted to do a job git has already confirmed it did.
  if (state === "discharged") return { action: "none", reason: "goal-discharged" };
  if (state === "expired") return { action: "none", reason: "goal-expired" };
  if (state === "escalated") return { action: "none", reason: "already-escalated" };
  // `state === "unmet"` here, which `goalStateOf` only returns for a defined goal — but that
  // implication lives in another module, so the guard is restated rather than asserted away with a
  // cast. An impossible branch that returns a reason is cheaper than a `!` that becomes a crash if
  // the state machine ever grows an arm.
  if (goal === undefined) return { action: "none", reason: "no-goal" };
  const live = goal;

  // `idle` OR `unmerged`. Not `waiting`/`approval`/`blocked`/`errored` — those are the red tier,
  // where the agent is genuinely stuck on the human and typing an unrelated "continue" would answer
  // a question it never read. Not `done`/`stopped` either: the process is gone, so there is no turn
  // to continue and a prompt would vanish into a dead PTY. Not `new`: nobody has briefed it.
  //
  // `unmerged` IS continued, deliberately (roborev 55252). It is the gray "Needs merge" state
  // `unmergedAttention` overlays onto a resting row with committed-but-unlanded work — on a real
  // fleet the single most common band — and an agent sitting there with an unmet goal is the
  // motivating case almost exactly: it did the work, its turn ended before the work landed, and
  // nothing is coming to finish it. Restarting is precisely right, because landing the branch is
  // work the agent can do itself. Leaving it in `not-idle` meant such an agent was never continued
  // AND never escalated, which is the silent-forever state this whole module exists to abolish.
  // THE QUOTA WALL COMES BEFORE THE STATUS GATE, and the order is the entire fix.
  //
  // Tripping the wall forces `status: "blocked"`, which is NOT a resting status — so with this check
  // placed after the gate below, every quota-walled agent was refused as `not-idle` and the quota
  // reason was unreachable by construction. That is the same uninformative answer the founder was
  // given by `get_agent_status`, reproduced in the one field the concierge reads to explain why an
  // agent was left alone. It is also why the first cut's "resumes once the reset has passed" test
  // proved nothing: it passed `status: "idle"`, which a live wall can never produce.
  //
  // Before the BOUNDS too, so waiting out a wall never spends a retry and never escalates. The reset
  // instant is the schedule: StatusEngine releases the row at that instant (armQuotaRelease), it
  // settles back to idle, and the next 15s sweep resumes it — the "then resume ONCE automatically"
  // half of the requirement, with no second timer here to drift from that one.
  if (isQuotaBlocked(input.quotaBlock, now)) return { action: "none", reason: "quota-blocked" };

  // ══ THE CLOUD GATES, AND WHY THEY SIT HERE ══════════════════════════════════════════════════════
  // Same placement argument as the quota wall directly above, for the same reason. A hibernated
  // sandbox stops emitting, so the LOCAL reading of a paused cloud agent is whatever its last frames
  // said — often `working` (it froze mid-spinner), sometimes `idle`. Put after the status gate, a
  // paused session would usually be refused as `not-idle`, and the refusal a human reads would be
  // "it isn't idle" about a sandbox that has been frozen for an hour. Asked FIRST, the reason names
  // the actual fact, which is what requirement 3 of this gate is: never continue a paused or
  // out-of-credits session BY NAME, not by accident of some other arm.
  //
  // Before the BOUNDS too, exactly as the quota wall is: a session the user paused must not spend
  // retries or eventually page them with "restarting cannot fix this" — restarting was never tried.
  if (input.runtime === "cloud") {
    const refusal = cloudRefusal(input.cloud);
    if (refusal !== null) return { action: "none", reason: refusal };
  }

  if (!isRestingStatus(status)) return { action: "none", reason: "not-idle" };
  // ...but `unmerged` must prove the process still EXISTS, because the overlay that writes it also
  // covers `done` and `stopped`. See ContinuationInput.processAlive: `idle` witnesses its own
  // liveness, `unmerged` cannot, and the two gates that would otherwise catch a dead process
  // (`canAcceptInput`, `hasTurnEndAuthority`) both pass for one. Fails closed on absent evidence.
  //
  // TWO REFUSALS, NOT ONE, because this reason string is what the concierge reads out to a human
  // (see NoContinueReason). Reporting "its process is gone" about an agent nobody looked up is the
  // same false-positive-from-silence that `agentLiveness` was written to prevent and that
  // `stallReport`'s `unknown` arm preserves in the sibling module — and it would have said it about
  // every live agent in the band, sending the human to close a tab whose agent is running
  // (roborev 55298). Both still refuse; only the sentence differs.
  if (status === "unmerged" && processAlive !== true) {
    return { action: "none", reason: processAlive === false ? "process-gone" : "liveness-unknown" };
  }
  if (!hasTurnEndAuthority) return { action: "none", reason: "no-turn-end-authority" };
  if (idleSince === undefined || now - idleSince < IDLE_SETTLE_MS) {
    return { action: "none", reason: "idle-not-settled" };
  }
  if (!canAcceptInput) return { action: "none", reason: "cannot-accept-input" };

  // BOUNDS. `continues` counts attempts since the mark last moved; a mark that has moved since the
  // last attempt means the agent DID something, so that streak is over and this attempt starts a
  // fresh one (mirroring agentGoal.noteContinue, which applies the same rule when recording).
  const progressed = live.mark !== undefined && live.mark !== mark;
  const consecutive = progressed ? 0 : live.continues;
  if (consecutive >= MAX_CONTINUES_WITHOUT_PROGRESS) {
    return {
      action: "escalate",
      reason:
        `Auto-continued ${consecutive} times with no sign of progress. The goal is still unmet: ` +
        `"${live.text}". Something is blocking it that restarting cannot fix.` +
        whereItRuns(input.runtime),
    };
  }
  if (live.totalContinues >= MAX_CONTINUES_TOTAL) {
    return {
      action: "escalate",
      reason:
        `Auto-continued ${live.totalContinues} times on this goal — the per-goal ceiling. The goal ` +
        `is still unmet: "${live.text}".` +
        whereItRuns(input.runtime),
    };
  }

  // `consecutive + 1`, NOT `live.continues + 1`. The bound above is read from `consecutive`, so
  // reporting an attempt number derived from the un-reset counter made the two disagree in exactly
  // the progressed case the reset exists for — and made `attempt` non-monotonic: continues=2 with a
  // moved mark reported attempt 3, `noteContinue` then set continues=1, and the next sweep reported
  // attempt 2. A runner surfacing "auto-continue attempt N" printed 3 then 2 for consecutive
  // restarts of a healthy agent, and could print a number above the limit while the streak was
  // zero. (roborev 55252.)
  // ONE expression feeds both fields. `attempt` was already correct here and the prompt simply did
  // not receive it, which is how the agent came to be the only party in the loop that could not
  // tell its second resume from its first. Computing it twice would let them drift.
  const attempt = consecutive + 1;
  return { action: "continue", prompt: continuePrompt(live, attempt), attempt };
}

/** The resting statuses an auto-continue may act on. See the note at the `not-idle` gate for why
 *  `unmerged` belongs here and the red tier does not. */
function isRestingStatus(status: AgentTabStatus): boolean {
  return status === "idle" || status === "unmerged";
}

/**
 * The clause that tells a human WHERE the agent they are being paged about actually is. Empty for a
 * local agent, whose escalation copy has always been implicitly about a pane on this Mac.
 *
 * AGENTS.md's rule that user-facing copy is code applies with unusual force here: this string is the
 * body of a notification whose whole purpose is to get someone to act, and the action is different.
 * A local agent is a terminal they can open and type into. A cloud agent is a remote sandbox that
 * keeps billing whether or not this laptop is even awake, and nothing they do on this machine
 * restarts it — so an escalation that silently reuses the local wording sends them hunting for a
 * pane that does not exist and leaves the meter running while they look.
 */
function whereItRuns(runtime: "local" | "cloud"): string {
  if (runtime !== "cloud") return "";
  return (
    ` It runs in a Sparkle CLOUD sandbox — remotely, and still on the clock — so nothing on this ` +
    `Mac will restart it. Open it to take over, or stop it.`
  );
}

/**
 * Why this cloud agent must not be resumed, or `null` when nothing here objects.
 *
 * ORDER IS THE MESSAGE. The LIFECYCLE is asked first, because it is the server's own verdict on the
 * sandbox and it is the fact that decides whether any other fact is even relevant. The balance is
 * then allowed to RE-EXPLAIN exactly one lifecycle — `waiting`, which is the state an empty wallet
 * causes (`cloudAgentRunner` maps exhaustion → `waiting`) — and to refuse an otherwise-healthy
 * `active` session we could not afford to keep running. The relay comes last, because "we cannot
 * reach it right now" is the most transient of the three.
 *
 * THE BALANCE USED TO RUN FIRST, AND THAT WAS A REMEDY STRING THAT LIED (roborev 58287). Ahead of
 * the switch it pre-empted lifecycles it has no causal relationship with: a user below the floor was
 * told to buy credits for a session that had FINISHED, or — the common case, since a lost network
 * takes the reading and the socket down together — for one this window simply has no reading of.
 * Buying credits fixes neither. AGENTS.md's rule that a remedy has to be true for the path that
 * produced it is exactly this: the sentence a human acts on must describe why THIS agent is stuck.
 *
 * `undefined` evidence is a refusal, never a pass: see {@link ContinuationInput.cloud}.
 */
function cloudRefusal(cloud: CloudEvidence | undefined): NoContinueReason | null {
  if (cloud === undefined) return "cloud-session-unknown";
  // The server's RESUME floor when it stated one, the 1¢ obviously-empty fallback otherwise. Not the
  // start floor, ever — see CLOUD_MIN_CONTINUE_CENTS for why that substitution destroys paid runway.
  const floor = cloud.minContinueCents ?? CLOUD_MIN_CONTINUE_CENTS;
  const broke = cloud.balanceCents !== undefined && cloud.balanceCents < floor;
  switch (cloud.sessionStatus) {
    case "active":
      // Alive and reachable, so the wallet is the next thing that can stop us — and here it really
      // is the whole story: nothing else objects, we simply cannot pay for the minutes.
      if (broke) return "cloud-out-of-credits";
      break; // the ONLY continuable lifecycle
    case "paused":
      return "cloud-session-paused";
    case "waiting":
      // THE ONE STATE THE BALANCE MAY RE-EXPLAIN. `waiting` is either exhaustion or the agent asking
      // its human; a wallet below the floor identifies which, and "you are out of credits" is the
      // actionable half of that pair. Without the balance we can only report the symptom.
      return broke ? "cloud-out-of-credits" : "cloud-session-waiting";
    case "pending":
      return "cloud-session-starting";
    case undefined:
      return "cloud-session-unknown";
    default:
      // `complete`, `error`, and anything a future server adds. A lifecycle this build does not
      // recognise is not evidence of a healthy sandbox, so it lands with the terminal ones rather
      // than falling through to a send.
      return "cloud-session-ended";
  }
  if (!cloud.relayConnected) return "cloud-offline";
  return null;
}

/**
 * What we actually type into the agent's terminal.
 *
 * It restates the GOAL rather than saying "continue", and that is the difference between a prompt
 * that works and one that produces "continue what?". The agent's context may have been compacted,
 * or the process relaunched, since the goal was set — so the prompt has to carry enough to stand
 * alone.
 *
 * It also tells the agent how to STOP. An auto-continue loop with no exit the agent can reach is
 * one the agent will fight: it would keep being restarted after genuinely finishing, and the only
 * way out would be the bounds firing, which reports a false escalation to the human. Naming the
 * op that marks the goal met makes finishing a thing the agent can do, so the common case ends
 * cleanly instead of by exhaustion.
 *
 * IT SAYS WHICH RESUME THIS IS, and that is the difference between a banner an agent acts on and
 * one it answers. Until it did, every resume for one goal was BYTE-IDENTICAL, so an agent reading
 * its own transcript saw the same text two and three times over with nothing to distinguish the
 * copies — which reads exactly like a human repeating themselves, and the courteous response to a
 * human repeating themselves is to restate your status, not to do more work. That is the observed
 * failure: three identical banners, three status reports, no progress, on a goal whose work was
 * finished and ready to land the whole time. The banner already knew the attempt number —
 * `decideContinuation` computes it for the runner — it just never told the one party who needed it.
 *
 * The extra line is emitted from the SECOND attempt on, because that is when the ambiguity starts;
 * a first resume has nothing to be confused with. It states the fact the agent cannot otherwise
 * see (nothing Sparkle can observe moved since the last one), the inference it should draw (an
 * identical banner is this timer, not the human), and the ceiling it is heading for.
 *
 * IT OPENS WITH A SHARED CONSTANT, and that is load-bearing rather than tidiness. This string is
 * SYSTEM-AUTHORED: no human and no agent chose to send it, a timer did — so `engine/agentThrash`
 * must not count it as a repeated command and this module must not count it as progress (see
 * engine/agentOriginated for the one statement of that rule). The thrash detector recognises
 * Sparkle's own send by this opening, so the sender and the recogniser have to be ONE string rather
 * than two copies of one. Reword it here and `agentOriginated.test.ts` fails; that is the point —
 * the alternative is the detector going silently blind, which is how agent 0bf08c64 came to be
 * badged "It is looping, not working" through 46 minutes of real work.
 */
export function continuePrompt(goal: AgentGoal, attempt = 1): string {
  return (
    `${RESUME_PROMPT_MARKER} automatically. ` +
    `Do not stop to acknowledge this — pick up exactly where you left off and keep working.\n\n` +
    `GOAL: ${goal.text}\n\n` +
    repeatedResumeLine(attempt) +
    // NAME THE OP THAT EXISTS. This said `set_agent_goal with met: true`, which cannot work:
    // `set_agent_goal`'s schema is `{ targetAgentId?, goal, ttlMs? }` — there is no `met`, and
    // `goal` is required. An agent that obeyed either failed zod validation or, if it invented a
    // goal string to satisfy it, landed in `setAgentGoal` → `newGoal`, which builds a fresh record
    // that is never born met and CLEARS any existing `metAt`. Either way it could not stop being
    // resumed, and burned continues until the bound escalated to a human with a false "still
    // unmet" — the exact outcome this prompt exists to prevent. `set_agent_goal_met` is the op;
    // no `targetAgentId`, which agents are not offered.
    `If the goal IS in fact met, say so and mark it met (sparkle-control: set_agent_goal_met with ` +
    `met: true) so you stop being resumed. If you are blocked on something only the human can ` +
    `resolve, say what you need — do not sit idle.`
  );
}

/**
 * The paragraph that tells a repeated resume apart from the first one. Empty for attempt 1.
 *
 * WHY IT NAMES A NUMBER RATHER THAN JUST SAYING "AGAIN". "You are being resumed again" is still the
 * same sentence on the second attempt and the third, so two consecutive turns remain
 * indistinguishable in a transcript — the exact property that produced the bug. A count is the
 * cheapest thing that is genuinely different on every attempt, and it doubles as the agent's
 * distance to the escalation it wants to avoid.
 *
 * THE CEILING IS DERIVED, NOT SPELLED. `MAX_CONTINUES_WITHOUT_PROGRESS` is the bound
 * `decideContinuation` actually escalates on, so interpolating it means retuning the bound cannot
 * leave this prose promising the old one — the sibling-literal failure that has bitten this repo
 * before.
 *
 * The claim about progress is precise rather than rhetorical: `attempt` is `consecutive + 1`, and
 * `consecutive` counts continues across which `progressMark` did NOT move. So from attempt 2 on,
 * "nothing observable changed since the last resume" is a fact the caller has already established,
 * not a guess. It is scoped to what Sparkle can SEE — an agent may well have been thinking — which
 * is why the line says so instead of accusing the agent of idling.
 */
function repeatedResumeLine(attempt: number): string {
  if (attempt < 2) return "";
  return (
    `THIS IS AUTO-RESUME ${attempt} OF ${MAX_CONTINUES_WITHOUT_PROGRESS} on this goal. Nothing ` +
    `Sparkle can observe has changed since resume ${attempt - 1}. An identical message arriving ` +
    `twice is NOT the human repeating themselves — it is this timer firing again, so restating ` +
    `your status will not clear it and does not count as progress. Take the next concrete step, ` +
    `mark the goal met, or name what is blocking you. At ${MAX_CONTINUES_WITHOUT_PROGRESS} this ` +
    `stops and escalates to a human.\n\n`
  );
}

/**
 * The cheap per-agent signal for "did anything happen between the last restart and this one".
 *
 * Built from evidence the store ALREADY holds, deliberately: a progress signal that costs a `git`
 * call would run on every idle sweep across a 64-agent fleet, and one that costs an LLM call would
 * cost more than the stall. Each input moves only when the agent genuinely did something:
 *
 *   • `promptHistoryLength` — a HUMAN sent it work. Explicitly NOT the auto-continue: that send
 *                             passes `userPrompt: false` precisely so it stays out of
 *                             `promptHistory` and therefore out of this mark. A resume is Sparkle
 *                             talking to itself, and counting it here would make the mark move on
 *                             every attempt, reset the consecutive streak forever, and leave
 *                             `MAX_CONTINUES_WITHOUT_PROGRESS` unable to fire at all. This is the
 *                             stall-side half of the rule stated in engine/agentOriginated — the
 *                             thrash side of the same rule is that the resume must not count as a
 *                             repeated COMMAND. One definition, two detectors, opposite failures.
 *   • `activity`            — the agent re-narrated what it is building (sparkle-control
 *                             set_agent_activity), which it only does at real phase boundaries.
 *   • `aiTitle`             — Claude Code re-derived the session title from the whole
 *                             conversation, which tracks the work actually shifting.
 *
 * NONE of these is a perfect proxy for progress, and the design does not pretend otherwise — an
 * agent can work hard and move none of them. That is exactly why {@link MAX_CONTINUES_TOTAL}
 * exists as a bound this function cannot influence: the consecutive counter is an OPTIMISATION
 * that keeps restarting an obviously-progressing agent, never the only thing standing between the
 * fleet and an unbounded loop.
 */
export function progressMark(input: {
  promptHistoryLength: number;
  activity?: string;
  aiTitle?: string | null;
}): string {
  // Joined on NUL, written as the ESCAPE and not a raw byte: a raw NUL makes git treat the whole
  // file as binary (no diffs, no review), which `services/sourceIsText.test.ts` guards against —
  // it caught exactly that here. The runtime string is identical. NUL rather than a space because
  // the fields are free text: an activity line containing the separator could otherwise make two
  // different states produce the same mark, which would read as "no progress" and burn a retry.
  return [input.promptHistoryLength, input.activity ?? "", input.aiTitle ?? ""].join("\u0000");
}
