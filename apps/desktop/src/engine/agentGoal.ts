// agentGoal — an agent's GOAL as a readable, persisted fact, and the vocabulary for "is it met".
//
// WHY THIS EXISTS. Measured on 2026-07-29, the fleet lost 23.6 aggregate agent-hours to 37 stalls
// longer than two minutes — agents whose turn simply ENDED with work remaining and which nothing
// restarted. The longest was 153 minutes. A Claude Code turn ends when the model stops emitting;
// there is no "and it was finished" in that signal, so an agent that stops mid-task is
// indistinguishable, from the outside, from one that succeeded. The founder's requirement is
// "I never want agents to wait."
//
// The PRD that commissioned this assumed goals ALREADY existed ("the UI shows /goal active (4h)").
// They did not: there is no `/goal` command in Claude Code, no goal skill, and no goal field
// anywhere in Sparkle. So this module is the missing substrate rather than a wrapper over one — it
// is deliberately small, pure and persisted-shaped, because three separate consumers need to agree
// on what "unmet" means:
//
//   • engine/goalContinuation — decides whether an idle turn gets auto-restarted.
//   • engine/agentStall       — decides whether an idle row renders "done" or "stalled".
//   • the control surfaces     — get_state / get_agent_status report goal + met to the concierge,
//                                which is what lets it SWEEP for stalls instead of a human
//                                noticing a gray row by eye.
//
// EVERYTHING HERE IS PURE. The clock arrives as a parameter, never `Date.now()`, so the expiry and
// escalation rules are tested as arithmetic rather than by waiting four hours.

/** How long a goal stays live by default before it stops driving auto-continue: four hours.
 *
 *  A TTL is not decoration — it is the outermost bound on the whole mechanism. An agent whose goal
 *  never expires would be eligible for auto-continue forever, so a goal someone set and forgot
 *  becomes a permanent token burner. Four hours is long enough to cover a real build session and
 *  short enough that a forgotten goal dies the same working day. */
import { mayReplaceVerify, inferGoalVerify, type GoalVerify } from "@sparkle/core";

export const DEFAULT_GOAL_TTL_MS = 4 * 60 * 60_000;

/** An agent's current goal. Persisted on the AgentTab record (see types.ts), so it survives the
 *  relaunch that is itself one of the most common ways a turn gets ended with work remaining. */
export interface AgentGoal {
  /** What the agent is trying to achieve, in the setter's own words. Shown to the human and
   *  replayed to the agent when auto-continue restarts it, so it has to read as an instruction. */
  text: string;
  /** Epoch ms the goal was set. With `ttlMs`, fixes the expiry. */
  setAt: number;
  /** Lifetime from {@link goalDeadline}'s origin — `rearmedAt` when present, else `setAt`.
   *  Defaults to {@link DEFAULT_GOAL_TTL_MS}. */
  ttlMs: number;
  /** Epoch ms of the last TTL RE-ARM, and the clock's origin once present. See {@link rearmGoal}.
   *
   *  A SEPARATE FIELD RATHER THAN AN OVERWRITE OF `setAt`, deliberately. `setAt` is the goal's birth
   *  fact, and it is what `goalRemainingMs` and the row's "active · 3h 20m left" badge are derived
   *  from; extending the clock by moving it would make a four-hour-old goal report as newborn, which
   *  is precisely the reading a human uses to decide whether an agent is worth waiting for. */
  rearmedAt?: number;
  /** TTL re-arms spent on this goal, bounded by `goalExpiry.MAX_TTL_REARMS`.
   *
   *  ⚠️ OPTIONAL, AND IT MUST STAY OPTIONAL. Every goal already in the persisted store deserializes
   *  without it. Read undefined-unsafely, `undefined >= MAX` is `false` (so a re-arm is always
   *  allowed) and `undefined + 1` is `NaN` (so the counter never climbs) — an unbounded re-arm loop
   *  that typechecks cleanly. Always read it as `?? 0`, at BOTH the compare and the write. */
  ttlRearms?: number;
  /** Epoch ms the goal was DISCHARGED — closed by Sparkle because git proved the work landed and the
   *  tree was clean. Latched, and distinct from `metAt`: `metAt` is a CLAIM (the agent's or a
   *  human's), this is a PROOF, and only the proof carries the shas below.
   *
   *  Named `discharged` rather than `retired` on purpose — "retirement" is already taken by the
   *  build-list feature whose contract is the opposite of this one ("no build agent leaves the build
   *  list without a retro on file and a human confirm"). `discharge` is this module's own existing
   *  word for an obligation settled by evidence. */
  dischargedAt?: number;
  /** The agent's branch tip that was proven contained. */
  dischargedSha?: string;
  /** The `origin/<default>` tip it was proven AGAINST — because "X is contained in origin/main" is
   *  unfalsifiable after a force-push, while "X was contained when origin/main was Y" stays checkable
   *  forever. A discharge nobody can audit is an assertion, not a proof. */
  dischargedBaseSha?: string;
  /** Epoch ms this goal was ABANDONED: it expired, its re-arm budget was spent, and git positively
   *  showed work nobody had landed. An ANNOTATION on an escalation rather than a state beside one —
   *  see {@link abandonGoal} for why that is what keeps it from becoming a second dead letter. */
  abandonedAt?: number;
  /** One sentence naming what git said, for the human who now owns the disposition call. */
  abandonedEvidence?: string;
  /** Epoch ms the goal was declared MET — by the agent itself, or by the human. Absent while unmet.
   *  This is the ONLY thing that makes an idle agent legitimately "done": a turn ending does not
   *  set it, which is precisely the distinction the whole feature rests on. */
  metAt?: number;
  /** Consecutive auto-continues since progress was last observed. Reset to 0 by {@link notePro
   *  gress}; the escalation bound is read against THIS, not the total, so an agent that keeps
   *  making progress keeps getting restarted. */
  continues: number;
  /** Auto-continues spent on this goal EVER, across progress resets. The backstop bound: without
   *  it, a mark that flaps (a value that changes for reasons unrelated to real progress) would
   *  reset `continues` indefinitely and the "bounded retry" guarantee would be vacuous. */
  totalContinues: number;
  /** The progress mark observed at the last auto-continue. A change means the agent DID something
   *  between restarts; see engine/goalContinuation for what the mark is built from. */
  mark?: string;
  /** Epoch ms auto-continue gave up and handed the agent to the human. Latched: an escalated goal
   *  never auto-continues again, so the escalation cannot be undone by a stray progress blip. */
  escalatedAt?: number;
  /** Why it escalated, in one sentence, for the human who now owns it. */
  escalationReason?: string;
  /** The goal text {@link escalationReason} QUOTES — stamped by {@link escalateGoal} from the text
   *  the goal held at that instant.
   *
   *  ⚠️ THIS EXISTS BECAUSE THE SENTENCE FREEZES AND THE OBJECT DOES NOT. `escalationReason` embeds
   *  the live text at the moment auto-continue gave up; {@link chargeGoalDebt} then deliberately
   *  carries that sentence onto whatever the agent's goal becomes next (an agent must not launder
   *  away an escalation by rewording its goal). Nothing regenerates the sentence, so a roster row
   *  can show the live goal beside an escalation quoting one two goals old — which reads as a live
   *  claim and has been acted on as one.
   *
   *  The sentence is NOT rewritten: it is the record of what the agent was actually stuck on, and
   *  regenerating it against current text destroys exactly the evidence the human needs. Recording
   *  the quote instead lets any reader ask {@link escalationQuotesStaleText} and say so.
   *
   *  ABSENT IS "CANNOT TELL", NOT "FRESH" — every escalation persisted before this field carries no
   *  quote, and the comparison fails closed to not-stale for them. See the strip note on
   *  {@link conciergeRearmGoal}: this must die wherever `escalationReason` dies, or the NEXT
   *  escalation is compared against a dead string and a TRUE escalation is dismissed as false. */
  escalatedGoalText?: string;
  /** WHO raised the escalation. `auto` is the continuation engine giving up; `concierge` is the
   *  concierge raising one deliberately through `set_agent_escalation`.
   *
   *  ⚠️ ABSENT MEANS `auto`, AND THAT DEFAULT IS THE SAFE DIRECTION. Every escalation persisted
   *  before this field existed was a machine give-up, and the only thing this flag unlocks is the
   *  FREE clear in {@link unraiseGoal} — undoing your own raise costs no re-arm budget because
   *  nothing was spent on it. Reading absence as `concierge` would hand that free clear to the
   *  entire installed base, i.e. an unbounded re-arm loop on every legacy escalation. */
  escalatedBy?: "auto" | "concierge";
  /** Concierge re-arms spent on this goal — {@link rearmGoal} calls that actually cleared a MACHINE
   *  escalation. Bounded by {@link MAX_CONCIERGE_REARMS}.
   *
   *  THIS IS THE ONLY BOUND ON THE CONCIERGE'S LEVER, so nothing the agent or the concierge can
   *  write may reset it — only a human release ({@link resetGoalRetries}). In particular it is
   *  deliberately NOT progress-gated: `engine/goalContinuation`'s progress mark is built from
   *  `promptHistoryLength ␀ activity ␀ aiTitle`, and `set_agent_activity` is a free-tier op an
   *  agent may call on itself, so a progress-gated counter is reset by one call from the very
   *  party it bounds. That is the same argument that produced `MAX_CONTINUES_TOTAL`; this counter
   *  is its analogue for re-arms rather than a second thing to re-litigate. */
  conciergeRearms?: number;
  /** Epoch ms of the last concierge re-arm, and the reason it gave. The audit trail the human reads
   *  to see that a machine — not they — put this agent back to work, and why.
   *
   *  ⚠️ DISTINCT FROM {@link AgentGoal.rearmedAt}, which is the TTL clock's ORIGIN and is read by
   *  {@link goalDeadline}. These two were both called `rearmedAt` on the branches that merged here,
   *  so writing this one under that name silently MOVED THE GOAL'S DEADLINE on every concierge
   *  re-arm — a lifetime extension nobody asked for, invisible at the call site. The clock and the
   *  escalation budget are different subjects; only the word "re-arm" was shared. */
  conciergeRearmedAt?: number;
  conciergeRearmReason?: string;
  /** HOW this goal is checked (see @sparkle/core goalVerify). Absent on every goal that predates the
   *  field, and absence is what keeps `set_agent_goal_met` working for those: a goal that never stated
   *  a check was never claiming to be verifiable, so it is still self-markable. A goal that DID state
   *  one cannot be latched on its claimant's WORD — `canSelfMarkMet` refuses `command` and `human`
   *  outright, and closes `landed` only against git's own reading of the branch (sparkle-vfkqz). */
  verify?: GoalVerify;
  /** Did a CALLER state {@link verify}, or did the machine default to it?
   *
   *  ONLY A STATED CHECK IS STICKY (roborev 57806). Without this the two are indistinguishable —
   *  a manufactured fallback is always exactly `{kind:"human"}`, the same value a caller states —
   *  and stickiness made the manufactured one PERMANENT: an agent that once stated a `command`
   *  check, then took new landing-shaped work, inherited a `human` check nobody chose, could not
   *  close it from git, and escalated. That is sparkle-vfkqz exactly, re-created by its own fix and
   *  latched for the rest of the agent's life (every later goal re-inheriting the sticky `human`).
   *
   *  So the rule reads: a check a PERSON or a caller chose binds; one the machine fell back to
   *  stays re-inferable from the next goal's text.
   *
   *  ⚠️ THREE-VALUED, AND `undefined` MEANS LEGACY → BINDING (roborev 57813). Reading absence as
   *  "not stated" was a MIGRATION HOLE: `verify` already ships on `origin/main`, and main's
   *  `chargeGoalDebt` downgraded every inherited check to exactly `{kind:"human"}`, so the installed
   *  base is full of persisted `human` checks with no flag. Treating those as non-binding would let
   *  one `set_agent_goal {verify:{kind:"landed"}}` swap a concierge-set sign-off for a self-closable
   *  check on upgrade — in the single direction this whole branch exists to block. So a
   *  MANUFACTURED check is written `false` EXPLICITLY, and only `false` means non-binding; absent
   *  fails closed. The "must not be retro-frozen" concern is answered by the `verify: null`
   *  take-back, which already exists and is the documented exit. */
  verifyStated?: boolean;
  /** Was {@link verify} carried over from an EARLIER goal rather than chosen for THIS one?
   *
   *  A SECOND, NARROWER QUESTION THAN {@link verifyStated} (roborev 57825). That flag answers "did a
   *  caller ever choose a check of this kind" — it is carried verbatim through same-kind
   *  inheritance, so it stays `true` across every later goal. Reusing it to mean "chosen for THIS
   *  goal" withheld the concierge take-back from precisely the population it was added for: an
   *  inherited `human` on unrelated new work read as caller-chosen, so the refusal named no exit and
   *  the agent was back to refuse → auto-continue → escalate with nothing for the human to do.
   *
   *  Kept SEPARATE rather than folded into `verifyStated` because the two gate different things:
   *  `verifyStated` decides whether the check BINDS (and must keep failing closed on absence), while
   *  this decides RELEVANCE — whether the obligation is about the work in front of you.
   *
   *  ⚠️ IT HAS A SECOND READER SINCE 2026-08-07, AND THIS DOCSTRING USED TO DENY IT (roborev 60339).
   *  It said "this decides only what the refusal TELLS the agent. Nothing about enforcement reads
   *  it." That is no longer true: `engine/agentStall`'s `chosenHere` reads this flag to decide
   *  whether the `human-verified-goal` cause fires, and that cause is the ONLY member of
   *  `stallEscalation.OUTSTANDING` — i.e. the only thing that paints a row RED.
   *
   *  The two readers have opposite tolerances, so know which you are affecting: the refusal copy is
   *  cosmetic, the attention tier is a user-visible alarm. WIDENING THIS FLAG SUPPRESSES THE RED
   *  CAUSE. Stamping it `true` on a population that does not have it today — legacy/absent
   *  provenance, say, so the refusal copy can always name the take-back exit — would silently switch
   *  `human-verified-goal` off for that whole population, and nothing in THIS module's suite would
   *  catch it. `engine/redAttentionTaxonomy.test.ts` is where that contract is pinned.
   *
   *  @see engine/agentStall.ts — `chosenHere`, and its "TERM 3 IS A RELEVANCE JUDGEMENT" block
   *  @see services/controlListener.ts — the original reader, the refusal's `chosenHere` evidence */
  verifyInherited?: boolean;
}

/** Where a goal is in its life. `none` is the absence of a goal, kept in the union so every
 *  consumer branches over one exhaustive vocabulary rather than juggling `undefined`. */
export type GoalState = "none" | "unmet" | "met" | "discharged" | "expired" | "escalated";

/**
 * When this goal's clock runs out.
 *
 * ONE PLACE, because the deadline is now computed from two possible origins and the arithmetic was
 * previously inlined at both {@link goalStateOf} and {@link goalRemainingMs}. Two copies of a rule
 * that has just grown a case is how the badge comes to disagree with the state machine about whether
 * an agent is still live.
 */
export function goalDeadline(goal: AgentGoal): number {
  return (goal.rearmedAt ?? goal.setAt) + goal.ttlMs;
}

/** Build a fresh goal. Counters start at zero; a new goal is never born escalated or met.
 *
 *  THROWS on empty/whitespace text, rather than producing a goal nobody can act on. An empty goal
 *  is fully live — `unmet`, so auto-continue restarts the agent up to `MAX_CONTINUES_TOTAL` times
 *  with a prompt reading `GOAL: ` and nothing after it (the exact "continue what?" failure
 *  `continuePrompt` exists to prevent), then escalates to a human with `The goal is still unmet:
 *  ""`. That is a four-hour, twenty-restart token burn carrying no recoverable instruction. Since
 *  this is the substrate all three consumers share, a blank from ANY caller — a mis-parsed
 *  `set_agent_goal`, a UI field submitted empty — would reach it, so the refusal belongs here
 *  rather than in each caller. Callers that want "empty means clear the goal" must check first;
 *  `projectStore.setAgentGoal` does exactly that. */
export function newGoal(
  text: string,
  now: number,
  ttlMs = DEFAULT_GOAL_TTL_MS,
  verify?: GoalVerify,
): AgentGoal {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("a goal needs text — an empty goal can never be acted on");
  // `verify` is spread conditionally so an unverified goal has NO `verify` key rather than an explicit
  // `undefined`. The two are equivalent to `canSelfMarkMet`, but only the former survives a JSON
  // round-trip through the persisted store identically, and the absence is load-bearing (it is what
  // marks a goal as pre-dating the field).
  // A `verify` reaching HERE always came from a caller — `newGoal` is never handed a fallback — so
  // it is recorded as STATED. The manufactured fallbacks are applied in `chargeGoalDebt`, which
  // clears the flag deliberately (see {@link AgentGoal.verifyStated}).
  return {
    text: trimmed,
    setAt: now,
    ttlMs,
    continues: 0,
    totalContinues: 0,
    ...(verify ? { verify, verifyStated: true } : {}),
  };
}

/**
 * The goal's state at `now`.
 *
 * ORDER IS LOAD-BEARING, and it is not the order you would guess. `met` is checked BEFORE
 * `expired` and before `escalated`: a goal that was achieved stays achieved, and reporting a met
 * goal as "expired" four hours later would tell the human an accomplished agent had stalled. An
 * ESCALATED goal is likewise still unmet work — but it is no longer OURS to retry, so it gets its
 * own state rather than folding back into `unmet`, where the continuation engine would pick it up
 * again and defeat the escalation.
 *
 * `escalated` IS CHECKED BEFORE `discharged`, and that ordering is the same argument pointed the
 * other way. The two are mutually exclusive by the writer's gate (`goalExpiry.decideExpiry` cannot
 * reach a discharge on a goal it has already escalated), but a record that can EXPRESS both must
 * resolve the impossible combination toward the LOUD reading rather than the calm one: a row wrongly
 * left red costs a glance, a row wrongly painted finished costs the work.
 *
 * `expired` REMAINS DERIVED FROM THE CLOCK, and that is load-bearing rather than incidental. The only
 * thing that could write it is the continuation sweep, which runs only for projects the current
 * window owns and only while a window is up. Were expiry a written state, an agent in a background
 * project — or on a laptop that slept through its TTL, which is the motivating case — would never
 * receive the write, would read `unmet` forever, and would go on being auto-continued against a
 * mandate that had lapsed. Deriving it is what makes the sweeper's ABSENCE safe.
 */
export function goalStateOf(goal: AgentGoal | undefined, now: number): GoalState {
  if (goal === undefined) return "none";
  if (goal.metAt !== undefined) return "met";
  if (goal.escalatedAt !== undefined) return "escalated";
  if (goal.dischargedAt !== undefined) return "discharged";
  if (now >= goalDeadline(goal)) return "expired";
  return "unmet";
}

/** Is there outstanding, still-live goal work? True ONLY for `unmet`.
 *
 *  `escalated` and `expired` are deliberately FALSE here even though the work was never finished.
 *  This predicate gates auto-continue, and both of those states mean "stop retrying" — an
 *  escalated goal belongs to the human now, and an expired one has outlived its mandate. The
 *  human-facing stall surface asks a different question and reads {@link goalStateOf} directly, so
 *  a stalled agent is still SHOWN as stalled after escalation; it just is not restarted again. */
export function hasUnmetGoal(goal: AgentGoal | undefined, now: number): boolean {
  return goalStateOf(goal, now) === "unmet";
}

/** Milliseconds until the goal expires; 0 once it has, and 0 when there is no goal. Used for the
 *  "active (4h)" style label the PRD described. */
export function goalRemainingMs(goal: AgentGoal | undefined, now: number): number {
  if (goal === undefined) return 0;
  return Math.max(0, goalDeadline(goal) - now);
}

/**
 * Extend a lapsed goal's clock, WITHOUT giving anything else back.
 *
 * Re-arm restores the MANDATE — the agent is still meant to be working on this — and deliberately not
 * the BUDGET. `continues` / `totalContinues` bound how much Sparkle may spend restarting an agent
 * that is getting nowhere, and a clock running out is not evidence that restarting has started
 * working. So this is shaped like {@link noteContinue} (purely additive) and pointedly NOT like
 * {@link resetGoalRetries} (the human's lever, which clears everything).
 *
 * THE CONSEQUENCE SOMEONE WILL TRY TO "FIX": a goal that lapses having already spent its twenty
 * continues re-arms to `unmet` and is then escalated on the very next sweep by the `MAX_CONTINUES_TOTAL`
 * arm of `decideContinuation`. That is correct and is the point — it reaches a human through the
 * existing, tested escalation path instead of quietly looping.
 *
 * IT DOES NOT SEND ANYTHING. The resume is left to the ordinary sweep, which sees `unmet` on its next
 * pass and restarts the agent through `continueAgent` like any other unmet goal. A bespoke send here
 * would be a SECOND sender: it would cost nothing from the retry budget (three free resumes per
 * goal) and would bypass the in-flight guard, the undelivered-send ceiling, and the idle-settle
 * window that the runner is arranged around. One sender, one budget.
 *
 * `ttlMs` is required rather than defaulted, so the re-arm policy (a shorter clock than the original)
 * lives with the rest of the expiry policy instead of being silently inherited here.
 */
export function rearmGoal(goal: AgentGoal, now: number, ttlMs: number): AgentGoal {
  return { ...goal, rearmedAt: now, ttlMs, ttlRearms: (goal.ttlRearms ?? 0) + 1 };
}

/**
 * Close the goal on GIT'S evidence rather than on anybody's say-so.
 *
 * Idempotent in the same shape as {@link markGoalMet}: a second discharge keeps the first timestamp,
 * so "when was this proven finished" does not drift each time something re-asserts it.
 *
 * The two shas are the audit trail — see {@link AgentGoal.dischargedBaseSha} for why one is not
 * enough. A caller that cannot supply both has not proven anything and must not call this.
 */
export function dischargeGoal(
  goal: AgentGoal,
  now: number,
  sha: string,
  baseSha: string,
): AgentGoal {
  if (goal.dischargedAt !== undefined) return goal;
  return { ...goal, dischargedAt: now, dischargedSha: sha, dischargedBaseSha: baseSha };
}

/**
 * Give up on a goal that lapsed repeatedly while visibly holding work nobody landed.
 *
 * IT WRITES THROUGH {@link escalateGoal}, and that is the whole design rather than an implementation
 * detail. A fresh terminal state would need its own retry suppression, its own notification, its own
 * ager, and its own tier membership — i.e. it would be a second dead letter one state over from the
 * one this module is being changed to fix. Riding on the escalation inherits all four for free:
 * `decideContinuation` already answers `already-escalated`, the runner already notifies exactly once
 * by latch, the amber `escalated-goal` cause is already a FLOOR (so the row can never fall back to
 * calm even if the red cause is later demoted), and anything built to age escalations covers this too.
 *
 * `abandonedAt` is therefore an ANNOTATION: it says WHY this particular escalation happened, and it is
 * what the red `abandoned-goal` stall cause keys on.
 */
export function abandonGoal(goal: AgentGoal, now: number, evidence: string): AgentGoal {
  const escalated = escalateGoal(goal, now, evidence);
  if (goal.abandonedAt !== undefined) return escalated;
  return { ...escalated, abandonedAt: now, abandonedEvidence: evidence };
}

/** Mark the goal met. Idempotent — a second call keeps the FIRST timestamp, so "when was this
 *  achieved" does not drift every time something re-asserts it. */
export function markGoalMet(goal: AgentGoal, now: number): AgentGoal {
  if (goal.metAt !== undefined) return goal;
  return { ...goal, metAt: now };
}

/** Record that an auto-continue was just spent, against the mark it was spent at.
 *
 *  If the mark MOVED since the last continue the agent did something in between, so the consecutive
 *  counter resets to 1 (this attempt) rather than climbing. `totalContinues` never resets — it is
 *  the bound that survives a flapping mark. */
export function noteContinue(goal: AgentGoal, mark: string): AgentGoal {
  const progressed = goal.mark !== undefined && goal.mark !== mark;
  return {
    ...goal,
    continues: progressed ? 1 : goal.continues + 1,
    totalContinues: goal.totalContinues + 1,
    mark,
  };
}

/** How many times the CONCIERGE may re-arm one goal before the escalation becomes the human's
 *  again. Two, not one: the first re-arm is often right (the concierge unblocked something real),
 *  and a second covers the case where its first fix was incomplete. A third says the concierge has
 *  been wrong twice about the same goal, which is precisely the evidence that the thing in the way
 *  is not something it can clear. See {@link AgentGoal.conciergeRearms} for why this is not
 *  progress-gated. */
export const MAX_CONCIERGE_REARMS = 2;

/**
 * Auto-continues a concierge re-arm hands back.
 *
 * A TOP-UP, NOT A RESET, and the distinction is the whole safety argument. `resetGoalRetries` — the
 * HUMAN's lever — zeroes `totalContinues` outright. If a re-arm did the same, three separate
 * emptiness predicates (`goalDebtOf`, `projectStore.releaseGoalDebt`, `projectStore.stripVerify`)
 * would read the re-armed goal as "nothing owed", because every one of them keys on
 * `totalContinues === 0 && escalatedAt === undefined`. The consequences are not cosmetic: the debt
 * stash carrying `conciergeRearms` would be dropped by one free-tier `set_agent_goal` from the agent
 * (unbounded re-arms), and the human's own typing would stop reaching `resetGoalRetries` at all.
 *
 * Subtracting instead keeps the goal visibly in debt, bounds the worst case at
 * `MAX_CONTINUES_TOTAL + MAX_CONCIERGE_REARMS * REARM_GRANT`, and keeps `continuePrompt`'s
 * attempt counter honest — a full reset makes a fourth resume render as a first, losing the
 * "an identical message arriving twice is NOT the human repeating themselves" banner that exists
 * because of a measured failure.
 *
 * The predicates are ALSO taught about `conciergeRearms` directly, because this subtraction can still
 * floor to 0 (a goal escalated by `MAX_CONTINUES_WITHOUT_PROGRESS` may have spent only 3). Belt
 * and braces, deliberately: the arithmetic makes the clean shape rare, the predicates make it safe.
 */
export const REARM_GRANT = 5;

/** Hand the goal to the human. Latched (see {@link AgentGoal.escalatedAt}); a second escalation
 *  keeps the first reason, so the human reads why it ORIGINALLY gave up.
 *
 *  `by` records WHO raised it, and the LATCH is what makes that trustworthy: a concierge raise
 *  against an already-`auto` escalation is a no-op, so it cannot re-stamp a machine give-up as its
 *  own and then clear it for free through {@link unraiseGoal}.
 *
 *  ALSO REFUSES A GOAL ALREADY MARKED MET (sparkle-i5v42). `decideContinuation` already declines
 *  to DECIDE "escalate" against a goal it reads as met — but the decision and this write are two
 *  separate reads of the goal, so a goal marked met in the gap between them (the sweep's decision
 *  is made against a snapshot; the write lands after an await elsewhere in the same pass) would
 *  otherwise still receive `escalatedAt` on top of `metAt`. `goalStateOf` resolves that
 *  combination to `met` (met is checked first), so the roster row was always right — but the
 *  Pusher's founder-facing digest read `escalatedAt`'s presence directly and kept reporting an
 *  already-finished goal as an active, unmet escalation. Guarding the write here closes the race
 *  at its source instead of relying on every reader to re-derive state correctly. */
export function escalateGoal(
  goal: AgentGoal,
  now: number,
  reason: string,
  by: "auto" | "concierge" = "auto",
): AgentGoal {
  if (goal.escalatedAt !== undefined) return goal;
  if (goal.metAt !== undefined) return goal;
  return {
    ...goal,
    escalatedAt: now,
    escalationReason: reason,
    escalatedBy: by,
    // Stamped in the SAME write as the sentence, deliberately: the two are one fact, and any path
    // that could set one without the other reintroduces "a quote nobody can check".
    escalatedGoalText: goal.text,
  };
}

/**
 * Does this escalation's sentence quote goal text the agent no longer holds?
 *
 * The one question a reader of {@link AgentGoal.escalationReason} cannot answer for themselves. The
 * sentence embeds the goal text as it stood when auto-continue gave up; {@link chargeGoalDebt}
 * carries that sentence forward onto new text on purpose, and {@link escalateGoal}'s latch means a
 * later, correct escalation is a NO-OP that cannot replace it. So the stale quote is permanent, and
 * nothing in the record marks it as stale.
 *
 * FAILS CLOSED IN BOTH DIRECTIONS, which is what makes the marker worth trusting:
 *  • no escalation at all → `false`. There is no quote to be stale.
 *  • escalated but no {@link AgentGoal.escalatedGoalText} → `false`. Pre-field records cannot be
 *    compared, and reporting the whole installed base as stale would discredit the flag on the day
 *    it shipped.
 *
 * Compares raw text, not a normalised form: `set_agent_goal` already trims, and treating a
 * whitespace-only edit as "the same goal" would hide a real restatement.
 */
export function escalationQuotesStaleText(goal: AgentGoal | undefined): boolean {
  if (goal?.escalatedAt === undefined) return false;
  if (goal.escalatedGoalText === undefined) return false;
  return goal.escalatedGoalText !== goal.text;
}

/** Re-arms remaining on this goal — what the concierge has left before the escalation locks back to
 *  the human. Reads absence as 0 spent, so a legacy goal gets the full allowance. */
export function rearmsRemaining(goal: AgentGoal | undefined): number {
  if (goal === undefined) return MAX_CONCIERGE_REARMS;
  return Math.max(0, MAX_CONCIERGE_REARMS - (goal.conciergeRearms ?? 0));
}

/** May the concierge still re-arm this goal? False once the allowance is spent — at which point the
 *  escalation is the human's again and nothing the concierge calls may take it back. */
export function mayRearmGoal(goal: AgentGoal | undefined): boolean {
  return rearmsRemaining(goal) > 0;
}

/**
 * THE CONCIERGE'S LEVER: clear a MACHINE escalation and hand back a bounded slice of retry budget.
 *
 * Deliberately weaker than {@link resetGoalRetries} in the two ways that matter. It hands back
 * {@link REARM_GRANT} continues rather than the whole ceiling, and it SPENDS a re-arm — a counter
 * only a human can reset. So the concierge can put an agent back to work, twice, and then the
 * escalation is the human's again by construction rather than by anyone's good behaviour.
 *
 * Callers must check {@link mayRearmGoal} first; this function does not enforce the bound itself,
 * because the refusal has to reach the caller as a typed code AND re-notify the human, neither of
 * which belongs in a pure reducer.
 *
 * `mark` is dropped for the same reason {@link resetGoalRetries} drops it: the next continue must
 * compare against a fresh observation, not a stale one recorded before the blockage was cleared.
 */
export function conciergeRearmGoal(goal: AgentGoal, now: number, reason: string): AgentGoal {
  // `escalatedGoalText` goes with the sentence it belongs to, and this is the strip that matters
  // most of the three. A re-armed agent goes back to work, restates its goal, and may stall again —
  // and if the DEAD quote survived this clear, that fresh escalation would be compared against text
  // from the previous one and marked stale on arrival. A true escalation dismissed as false is a
  // worse failure than the stale quote this field exists to catch.
  const {
    escalatedAt: _e,
    escalationReason: _r,
    escalatedGoalText: _egt,
    escalatedBy: _b,
    mark: _m,
    ...rest
  } = goal;
  return {
    ...rest,
    continues: 0,
    totalContinues: Math.max(0, goal.totalContinues - REARM_GRANT),
    conciergeRearms: (goal.conciergeRearms ?? 0) + 1,
    conciergeRearmedAt: now,
    conciergeRearmReason: reason,
  };
}

/**
 * Undo an escalation the CONCIERGE ITSELF raised — free, because nothing was spent on it.
 *
 * ⚠️ IT CLEARS THE LATCH AND NOTHING ELSE. Not `continues`, not `totalContinues`, not
 * `conciergeRearms`. A raise costs no retry budget, so undoing one must return none: if this reset the
 * counters, `set_agent_escalation {escalated:true}` followed by `{escalated:false}` would be an
 * unlimited budget refill in two calls — and `MAX_CONTINUES_TOTAL`, the bound the whole feature
 * rests on, could never fire again. Callers must gate this on `escalatedBy === "concierge"`;
 * a machine give-up goes through {@link rearmGoal} and is charged for.
 */
export function unraiseGoal(goal: AgentGoal): AgentGoal {
  const {
    escalatedAt: _e,
    escalationReason: _r,
    escalatedGoalText: _egt,
    escalatedBy: _b,
    ...rest
  } = goal;
  return rest;
}

/** Clear the retry budget because a HUMAN changed the picture — they typed to the agent, or
 *  rewrote the goal. Also clears an escalation: the human acting on the escalation is exactly the
 *  event that makes retrying reasonable again.
 *
 *  THIS IS THE HUMAN'S LEVER, and that is why it resets `totalContinues` too. Nothing the agent
 *  can do reaches it — see {@link clearGoalMet} for the agent-facing counterpart, which
 *  deliberately cannot refill the ceiling.
 *
 *  ⚠️ IT ALSO ZEROES `conciergeRearms`, AND THAT IS WHAT KEEPS THE HUMAN STRICTLY STRONGER THAN THE
 *  CONCIERGE. {@link rearmGoal} hands back a slice of budget and SPENDS a re-arm; this hands back
 *  the whole ceiling and REFILLS the re-arm allowance. If both levers reset the same things the
 *  bound on the concierge would be vacuous — it could re-arm, and its own re-arm would restore its
 *  allowance to re-arm again. Only a human changing the picture refills the allowance. */
export function resetGoalRetries(goal: AgentGoal): AgentGoal {
  const {
    escalatedAt: _e,
    escalationReason: _r,
    escalatedGoalText: _egt,
    escalatedBy: _b,
    mark: _m,
    // The expiry latches and the re-arm budget go the same way and for the same reason: a human who
    // has just engaged with this agent has overtaken every conclusion Sparkle reached about it in
    // their absence. Leaving `dischargedAt` latched would be roborev 55254 (a `metAt` that stayed
    // latched forever) reproduced on the new field — the human retypes the goal and gets back an
    // agent the machine still considers finished.
    dischargedAt: _d,
    dischargedSha: _ds,
    dischargedBaseSha: _db,
    abandonedAt: _a,
    abandonedEvidence: _ae,
    ttlRearms: _tr,
    // The CONCIERGE's allowance and its audit trail, cleared for exactly the reason above: this
    // lever has to stay strictly stronger than the concierge's, and it is only stronger if it is
    // the thing that refills what the concierge spent.
    conciergeRearms: _cr,
    conciergeRearmedAt: _cra,
    conciergeRearmReason: _crr,
    ...rest
  } = goal;
  // ⚠️ `rearmedAt` and `ttlMs` SURVIVE, and dropping them would be a regression rather than a
  // tidy-up. A re-arm leaves a SHORTER `ttlMs` behind it, so clearing the origin while keeping that
  // lifetime recomputes the deadline from the goal's original birth — moving it EARLIER, and usually
  // into the past, so the human's own lever would hand back a goal that is instantly expired again.
  // The clock is not part of the retry budget; this lever is about the budget.
  //
  // ⚠️ AND `rearmedAt` IS *THEIRS*, NOT THE CONCIERGE'S — the two nearly collided. `rearmedAt` is
  // the TTL clock's origin (`goalDeadline` reads `(rearmedAt ?? setAt) + ttlMs`); the concierge's
  // audit stamp is `conciergeRearmedAt`. They were both called `rearmedAt` on the two branches that
  // merged here, and keeping that name would have made every concierge re-arm silently MOVE THE
  // GOAL'S DEADLINE — a lifetime extension nobody asked for, invisible at the call site.
  return { ...rest, continues: 0, totalContinues: 0 };
}

/**
 * Un-mark a met goal — "it turned out not to be done after all".
 *
 * THE AGENT'S OWN LEVER, and deliberately much weaker than {@link resetGoalRetries}. It clears the
 * consecutive streak (the agent is going back to work and deserves a fresh run at it) but leaves
 * `totalContinues` and any escalation exactly where they were.
 *
 * The difference is a real hole otherwise. `setAgentGoalMet` is how an AGENT declares itself done,
 * so the actor holding this lever is precisely the one `MAX_CONTINUES_TOTAL` defends the fleet
 * against: an agent that marked itself met and then un-marked itself would refill its entire
 * twenty-restart budget, and could do it again every twenty restarts, forever. Worse, un-latching
 * `escalatedAt` would take back a goal a human had already been handed and quietly return it to
 * the auto-continue pool.
 *
 * A no-op when the goal was never met, so this cannot be used as a budget reset by calling it on
 * an unmet goal.
 */
export function clearGoalMet(goal: AgentGoal): AgentGoal {
  if (goal.metAt === undefined) return goal;
  const { metAt: _m, ...rest } = goal;
  return { ...rest, continues: 0 };
}

/**
 * What an agent still OWES after its goal record is gone.
 *
 * THE HOLE THIS CLOSES (roborev 55451). Every bound in engine/goalContinuation — `already-escalated`,
 * `MAX_CONTINUES_TOTAL`, `MAX_CONTINUES_WITHOUT_PROGRESS` — is read off the `AgentGoal` record and
 * NOWHERE ELSE. So deleting the record deletes the debt, and `set_agent_goal` is agent-reachable and
 * free-tier, with an empty string documented as "clears it". Two calls, no cleverness:
 *
 *   1. `set_agent_goal {goal: ""}`      → record dropped: budget spent AND escalation both gone
 *   2. `set_agent_goal {goal: "…"}`     → no prior goal, so the inherit-the-debts branch cannot fire
 *
 * …and the agent is back in the auto-continue pool with a full ceiling and a human's escalation
 * silently cancelled, repeatable forever. Carrying the debt forward across a text change (which the
 * `actor === "agent"` branch of `setAgentGoal` already did) is not enough on its own, because the
 * clear path erases the very record that branch reads.
 *
 * So the debt OUTLIVES the goal. It is deliberately the narrow set — the two latched facts a human
 * owns — and never `continues`, which is the "is restarting getting anywhere" signal and is supposed
 * to reset when the work genuinely changes.
 */
export interface GoalDebt {
  /** Auto-continues spent under the cleared goal. Feeds `MAX_CONTINUES_TOTAL` on the next goal. */
  totalContinues: number;
  /** The escalation the human was handed, if any. Latched across the clear for the same reason it is
   *  latched within a goal: taking it back is the human's call, not the agent's. */
  escalatedAt?: number;
  escalationReason?: string;
  /** The goal text the owed sentence quotes. Rides the stash for the same reason the sentence does —
   *  a clear-then-set is the LONGEST route between the escalation and the text it names, so it is
   *  the route on which the quote most needs to stay checkable. Dropping it here would make every
   *  escalation that survived a `set_agent_goal {goal:""}` read as pre-field, i.e. never stale. */
  escalatedGoalText?: string;
  /** Who raised the owed escalation. Rides along so a clear-then-set cannot launder a MACHINE
   *  give-up into a concierge raise — which would be the free {@link unraiseGoal} path, i.e. an
   *  escalation the concierge could take back without spending any of its allowance. */
  escalatedBy?: "auto" | "concierge";
  /** Concierge re-arms already spent. LATCHED ACROSS THE CLEAR, and it is the whole reason this
   *  field exists on the debt at all: `conciergeRearms` is the only bound on the concierge's lever, and
   *  `set_agent_goal {goal:""}` then `set_agent_goal {goal:"…"}` is two free-tier calls an AGENT
   *  can make. Without the carry those two calls reset the allowance and the concierge could re-arm
   *  the same agent forever — the exact laundering hole this whole debt mechanism was built to
   *  close, re-opened for the newer counter. */
  conciergeRearms?: number;
  /** The CHECK the cleared goal stated. Latched for the same reason as the escalation, and against
   *  the same escape: `verify` is what decides whether the claimant may latch `metAt`, so a goal that
   *  lost it on a rewrite would become self-markable in one extra call — the paraphrase-escape this
   *  debt mechanism already closes for the retry budget, left open for the field that gates the latch
   *  (roborev 55893).
   *
   *  THE ONE WAY OUT IS DELIBERATE AND THE CONCIERGE'S: `set_agent_goal {verify: null}`. This used to
   *  say "a HUMAN rewrite may still drop it", which was false twice over — no production caller passes
   *  `actor: "human"`, and the release that DID fire (`releaseGoalDebt`, on any typed line) was
   *  incidental rather than a take-back, so the check was simultaneously un-droppable on purpose and
   *  droppable by accident (roborev 55933). */
  verify?: GoalVerify;
  /** Was the owed {@link verify} STATED by a caller, or defaulted to by the machine? Only a stated
   *  check is sticky — see {@link AgentGoal.verifyStated} for why the distinction has to survive the
   *  clear, and what went wrong when it did not. */
  verifyStated?: boolean;
  /** Was the owed check carried over from an earlier goal? Rides along so a clear-then-set cannot
   *  launder an INHERITED check into one chosen for the new goal — see
   *  {@link AgentGoal.verifyInherited}.
   *
   *  ⚠️ NOT read by the CLOSE gate (`canSelfMarkMet` never sees it) — but this line used to say
   *  "read only by the refusal copy", and that is no longer true (roborev 60339).
   *  `engine/agentStall` reads it to decide whether the red `human-verified-goal` cause fires, so
   *  widening it suppresses the loudest signal in the app. The full warning is on
   *  {@link AgentGoal.verifyInherited}; read it before changing who gets this flag. */
  verifyInherited?: boolean;
}

/**
 * The debt to remember when a goal is cleared — or `undefined` when there is nothing to remember.
 *
 * Returning `undefined` for a clean goal matters: it keeps the stored field absent on the overwhelming
 * common path (an agent that never auto-continued and was never escalated), so this does not add a
 * `{ totalContinues: 0 }` to every agent in the persisted blob.
 */
export function goalDebtOf(goal: AgentGoal | undefined): GoalDebt | undefined {
  if (goal === undefined) return undefined;
  // `verify` counts as debt on its own: a goal with a clean budget and no escalation still owes its
  // CHECK across a clear, or clear-then-set launders a verified goal into an unverified one.
  // `conciergeRearms` counts on its own for the SAME reason, and it is the easiest of the three to
  // miss: a re-armed goal is deliberately left looking almost clean (`rearmGoal` subtracts from
  // `totalContinues` and can floor it to 0, and it drops `escalatedAt` — that is the point of a
  // re-arm), so without this clause the single field bounding the concierge's lever is dropped by
  // the one agent-reachable call this predicate guards.
  if (
    goal.totalContinues === 0 &&
    goal.escalatedAt === undefined &&
    goal.verify === undefined &&
    (goal.conciergeRearms ?? 0) === 0
  ) {
    return undefined;
  }
  return {
    totalContinues: goal.totalContinues,
    ...((goal.conciergeRearms ?? 0) > 0 ? { conciergeRearms: goal.conciergeRearms } : {}),
    // Provenance rides along with the check — a clear-then-set must not launder a MANUFACTURED
    // `human` into a stated one (which would re-freeze it), nor a stated one into a manufactured
    // one (which would shed the stickiness the debt exists to carry).
    // Absence binds (legacy), so it is carried as-is rather than normalised to `true`/`false` —
    // re-reading it here must not turn "we don't know" into a decision.
    ...(goal.verify !== undefined
      ? {
          verify: goal.verify,
          ...(goal.verifyStated !== undefined ? { verifyStated: goal.verifyStated } : {}),
          ...(goal.verifyInherited ? { verifyInherited: true } : {}),
        }
      : {}),
    ...(goal.escalatedAt !== undefined
      ? {
          escalatedAt: goal.escalatedAt,
          ...(goal.escalationReason !== undefined
            ? { escalationReason: goal.escalationReason }
            : {}),
          ...(goal.escalatedGoalText !== undefined
            ? { escalatedGoalText: goal.escalatedGoalText }
            : {}),
          // Carried as-is. Absence means `auto` (see `AgentGoal.escalatedBy`), and normalising it to
          // an explicit `"auto"` here would be harmless today but would destroy the marker that
          // identifies pre-field records, exactly as the `verifyStated` carry above refuses to.
          ...(goal.escalatedBy !== undefined ? { escalatedBy: goal.escalatedBy } : {}),
        }
      : {}),
  };
}

/**
 * What an inherited check becomes on NEW goal text — the obligation, without the stale proof.
 *
 * THE FALLBACK, NOT THE ANSWER (sparkle-vfkqz). This was a flat `{ kind: "human" }` for every
 * inherited check, and that constant is where two finished agents got a check nobody chose: the
 * concierge sets a goal, the agent restates it in its own words, and the rewrite silently acquired a
 * human sign-off requirement — on work whose goal text said "merged to origin/main". Neither agent
 * ever passed a `verify`; both were then refused by `set_agent_goal_met`, burned three
 * auto-continues, and escalated to the founder with nothing for him to do.
 *
 * `inheritedVerify` now READS THE NEW GOAL'S OWN TEXT and picks the check that can actually answer
 * it. `human` remains the fallback for everything it cannot infer.
 *
 * ⚠️ AN INHERITED `human` IS STICKY, AND THAT EXCEPTION IS THE WHOLE SAFETY ARGUMENT (roborev 57794).
 * The first version re-chose freely from the goal text and claimed it "can only move a goal toward a
 * machine-checkable check, never to a weaker one". That is false for `human` → `landed`, because
 * `landed` IS weaker for the one party that controls the text: the concierge sets *"the founder
 * approves the onboarding copy"* with `{kind:"human"}`, the agent restates it as *"the onboarding
 * copy fix is merged to origin/main"* with no `verify`, inherits `{kind:"landed"}`, merges its own
 * PR and closes the goal — a human sign-off discharged by a merge. That is the exact invariant this
 * change pins elsewhere ("ancestry must not launder a human sign-off"), defeated through the one
 * door an agent can reach, since `verify: null` is concierge-only precisely to stop it shedding a
 * check.
 *
 * So inference applies only to a debt the agent could already close (`landed`). Any other obligation
 * leaves it exactly one way out: ask the concierge for the `verify: null` take-back.
 *
 * THE STICKINESS IS ENFORCED BY THE CALLER, not here, and deliberately in ONE place. This function
 * first re-checked `owed.kind === "human"` itself, which was UNREACHABLE — `chargeGoalDebt` only
 * reaches this call on a non-`human` debt — and a hand-mutation proved it: deleting that line broke
 * no test. Two guards for one rule is how they drift; the caller's is the one that must hold,
 * because it also covers the explicitly-stated `verify` that never passes through here.
 */
function inheritedVerify(goalText: string): GoalVerify {
  return inferGoalVerify(goalText) ?? INHERITED_VERIFY;
}

/** What an un-inferable — or un-closable — inherited check becomes: the obligation, no stale proof. */
const INHERITED_VERIFY: GoalVerify = { kind: "human" };

/**
 * Charge a freshly-created goal with an outstanding {@link GoalDebt}.
 *
 * `debt` may be `undefined` (nothing owed) — the caller passes whatever it has and gets back a goal
 * either way, so no call site needs its own branch. The debt is the FLOOR, not an overwrite: a
 * `totalContinues` already on the goal wins if it is higher, so this can only ever tighten the bound.
 * An escalation on either side latches, matching {@link escalateGoal}.
 *
 * THIS IS AN AGENT-FACING PATH, so it must never be usable as a reset — see {@link clearGoalMet}.
 */
export function chargeGoalDebt(goal: AgentGoal, debt: GoalDebt | undefined): AgentGoal {
  if (debt === undefined) return goal;
  const escalatedAt = goal.escalatedAt ?? debt.escalatedAt;
  const escalationReason = goal.escalationReason ?? debt.escalationReason;
  // Resolved from the SAME side as the sentence above, and that pairing is load-bearing: taking the
  // quote from one source and the sentence from the other would compare a fresh goal's text against
  // an owed goal's sentence and invent staleness that never happened.
  const escalatedGoalText = goal.escalatedGoalText ?? debt.escalatedGoalText;
  const escalatedBy = goal.escalatedBy ?? debt.escalatedBy;
  // THE FLOOR, exactly like `totalContinues` below — a new goal cannot start with fewer re-arms
  // spent than the agent already owes. `newGoal` never sets it, so in practice the debt always
  // wins; `Math.max` is written anyway so the direction is stated rather than relied upon.
  const conciergeRearms = Math.max(goal.conciergeRearms ?? 0, debt.conciergeRearms ?? 0);
  // THE OBLIGATION IS INHERITED; THE PROOF IS NOT (roborev 55933).
  //
  // The incoming goal's own `verify` wins when it has one — the caller stated a NEW check. When it
  // states none, the owed check is inherited, but never restored VERBATIM, because this branch runs
  // on genuinely NEW goal text and nothing here can know the old proof still applies to it.
  // Restoring it verbatim was actively wrong on the routine path: `send_to_agent_terminal` records
  // every work goal with no `verify` at all, so an agent that once stated
  // `{ kind: "command", cmd: "pnpm test parser" }` had that command silently re-attached to "write
  // the release notes" — `selfMarkRefusal` then instructs it to run a command unrelated to its goal,
  // and once an executor exists a stale command exiting 0 closes an unrelated goal, which is the
  // false "done" this whole mechanism exists to prevent.
  //
  // WHAT IS INHERITED IS THE OBLIGATION, and `inheritedVerify` decides its KIND from the new text
  // rather than assuming a person must settle it. Both directions of that are load-bearing: a goal
  // reading "the fix is merged to origin/main" inherits `landed`, which git can close on its own;
  // anything it cannot read inherits `human`, keeping the goal non-self-markable exactly as before
  // while asserting no machine proof about work nobody checked.
  //
  // ⚠️ EXCEPT AGAINST AN OWED CHECK THE AGENT CANNOT CLOSE ITSELF, WHICH OUTRANKS EVEN AN EXPLICIT
  // NEW CHECK (roborev 57794, widened by 57801). "The caller stated a NEW check, so it wins" was
  // safe only while NO stated kind was self-markable — every substitution landed on something a
  // person still had to close, so the swap bought an agent nothing. Now that `landed` closes itself
  // on git's evidence, that same precedence is a one-call bypass: an agent owing a check it cannot
  // discharge states `{kind:"landed"}` on its restated goal, merges its own PR, and the obligation
  // is gone.
  //
  // EXPRESSED AS A STRENGTH RANK (`mayReplaceVerify`), NOT AS A KIND NAME. Written as a literal
  // `human` check it left the identical trade open through `command`; written as closable/not it
  // left `human` → `command` open, which is not a lateral move — a founder's judgement became a
  // command the AGENT wrote, whose own refusal copy then invites a rubber-stamp close. The rank
  // states the real rule once — AN AGENT MAY NEVER MAKE ITS OWN CHECK WEAKER — and both doors into
  // a goal's check share it, having drifted apart twice already. The concierge's `verify: null`
  // take-back remains the only exit, exactly as `GoalDebt.verify` documents.
  //
  // THIS BINDS THE CONCIERGE TOO, and that is a deliberate consequence rather than an oversight:
  // `handleSetGoal` passes `actor: "agent"` for EVERY caller on the control socket (its own comment
  // says so), so nothing at this layer can tell the human-driven surface from the agent it is
  // gating. Rather than invent a trust distinction here — where getting it wrong reopens the bypass
  // — the concierge changes a `human` check in TWO calls, which it already can: `verify: null` to
  // take the check back (that path also strips it from the stash), then set the new one. An
  // agent-reachable one-call swap is exactly what must not exist.
  //
  // ⚠️ THE INVARIANT IS "NEVER WEAKEN THE CHECK", NOT "KEEP THE EXACT CHECK", and the difference is
  // load-bearing on THIS branch, which runs on genuinely NEW goal text. Carrying a check forward
  // VERBATIM would undo roborev 55933: `{kind:"command", cmd:"pnpm test parser"}` re-attached to
  // "write the release notes" instructs the agent to run a command unrelated to its goal, and once
  // an executor exists a stale command exiting 0 closes an unrelated goal — the false "done" all of
  // this exists to prevent. So a stated obligation that inference cannot match DOWNGRADES to
  // `human`: no weaker than what was owed, and carrying no stale proof.
  //
  // ⚠️ ONLY A *STATED* CHECK IS STICKY (roborev 57806), and this is where that matters most. The
  // fallback below MANUFACTURES a `human` check; freezing those re-created sparkle-vfkqz inside its
  // own fix — an agent that once stated a `command` check took new landing-shaped work, inherited a
  // `human` nobody chose, could not close it from git, and escalated, permanently, since every
  // later goal re-inherited it. A machine-defaulted check therefore stays RE-INFERABLE from the
  // next goal's text; only a check a caller actually chose binds.
  const owed = debt.verify;
  // `!== false`, not `=== true`: absence is a LEGACY goal and must bind (see `verifyStated`).
  const owedBinds = owed !== undefined && debt.verifyStated !== false;
  // What the goal gets when the caller stated no check of its own: the check that fits the new
  // text, unless that would weaken a BINDING obligation, in which case the honest carry is `human`.
  const inferred = owed === undefined ? undefined : inheritedVerify(goal.text);
  const forcedDowngrade = inferred !== undefined && owedBinds && !mayReplaceVerify(owed, inferred);
  const fallback = forcedDowngrade ? INHERITED_VERIFY : inferred;
  // A STATED check still wins — unless it would WEAKEN a binding obligation.
  const stated = goal.verify;
  const statedWins = stated !== undefined && (!owedBinds || mayReplaceVerify(owed, stated));
  const verify = statedWins ? stated : fallback;
  // ── PROVENANCE DESCRIBES THE OBLIGATION, NOT THE VALUE (roborev 57813) ─────────────────────────
  // Marking every fallback un-stated let a BINDING check stop binding after exactly one hop, which
  // put this branch's own P0 back in two free-tier calls: a concierge `{kind:"human"}` sign-off,
  // restated once with landing-shaped text, became an un-stated `human`; the next restatement saw
  // nothing binding, re-inferred `landed`, and the agent closed the founder's approval by merging
  // its own PR. `.claude/commands/goal.md` published the recipe verbatim.
  //
  // A fallback that IS the owed check stands in for it and inherits its binding. The test is
  // SAME KIND — nothing else.
  //
  // ⚠️ IT IS NOT "was a downgrade forced" (roborev 57814). Keying on that closed only the sub-case
  // where inference DISAGREES with the owed kind, and lost the binding in every case where it
  // agrees — which is most of them, since `inferGoalVerify` answers `undefined` for any text that
  // is not landing-shaped and the fallback is then `human` anyway. So: a `{kind:"human"}` sign-off
  // restated once in judgement words ("the founder signs off on …") produced an UN-STATED `human`,
  // and the next landing-shaped restatement re-inferred `landed` and self-closed. One non-landing
  // intermediate hop was the whole bypass, and the previous round's test could not see it because
  // it walked only landing-shaped texts, the one arm where the downgrade fires.
  //
  // Same-kind alone still preserves the 57806 floor: a `human` manufactured over an owed `command`
  // has a DIFFERENT kind, so it still decays to something re-inferable — which is exactly the
  // distinction that stopped a spent `command` obligation from freezing an agent forever.
  const inheritsBinding =
    owedBinds &&
    !statedWins &&
    owed !== undefined &&
    fallback !== undefined &&
    fallback.kind === owed.kind;
  // CARRIED VERBATIM WHEN INHERITED, NOT STAMPED `true` (roborev 57816). `goalDebtOf` promises not
  // to turn "we don't know" into a decision, and stamping would break that on the first hop: a
  // LEGACY check (absent flag) would be rewritten as caller-chosen, destroying the only marker that
  // could ever identify the installed base for a migration. It binds either way — `owedBinds` reads
  // `!== false` — so nothing about enforcement changes; only the provenance stays honest.
  const verifyStated = statedWins ? true : inheritsBinding ? debt.verifyStated : false;
  // Recorded at the exact moment inheritance happens, which is the only place that knows. A check
  // the caller stated for THIS goal is not inherited, whatever it was before.
  const verifyInherited = statedWins ? false : inheritsBinding || debt.verifyInherited === true;
  // `verifyStated` is stripped from the spread and re-added, never left to `...goal`: when the
  // caller's stated check was REFUSED above, the incoming goal still carries `verifyStated: true`
  // from `newGoal`, and spreading it would mark the manufactured fallback as caller-chosen — the
  // exact laundering this flag exists to prevent, in the one place it is easiest to miss.
  const { verifyStated: _incoming, verifyInherited: _incomingInh, ...withoutProvenance } = goal;
  return {
    ...withoutProvenance,
    totalContinues: Math.max(goal.totalContinues, debt.totalContinues),
    // Written EXPLICITLY in both directions — a manufactured check records `false` rather than
    // omitting the key, because absence now means "persisted before this field existed" and binds.
    // `verifyStated` may legitimately be `undefined` here (an inherited LEGACY check, whose
    // provenance is genuinely unknown), and that must stay an ABSENT key rather than an explicit
    // undefined — absence is what a future migration reads.
    ...(verify !== undefined
      ? {
          verify,
          ...(verifyStated !== undefined ? { verifyStated } : {}),
          ...(verifyInherited ? { verifyInherited: true } : {}),
        }
      : {}),
    ...(conciergeRearms > 0 ? { conciergeRearms } : {}),
    ...(escalatedAt !== undefined
      ? {
          escalatedAt,
          ...(escalationReason !== undefined ? { escalationReason } : {}),
          ...(escalatedGoalText !== undefined ? { escalatedGoalText } : {}),
          ...(escalatedBy !== undefined ? { escalatedBy } : {}),
        }
      : {}),
  };
}
