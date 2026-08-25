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
import {
  mayReplaceVerify,
  inferGoalVerify,
  agentClosableKind,
  type GoalVerify,
} from "@sparkle/core";

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
   *  whether the `human-verified-goal` cause fires. From 2026-08-07 to 2026-08-18 that cause was the
   *  ONLY member of `stallEscalation.OUTSTANDING` and this flag gated a RED dot; on 2026-08-18 the
   *  cause moved to the AMBER `lapsed` tier (an agent awaiting a review-close is done, not stuck), so
   *  widening this flag now only changes whether the row shows the distinct "awaiting your sign-off"
   *  chip versus the generic "auto-continue gave up" one — both amber, both surfaced.
   *
   *  So the stakes are lower than they were, but keep the flag honest anyway: stamping it `true` on a
   *  population that does not have it today — legacy/absent provenance, say — would switch
   *  `human-verified-goal` off for that whole population and drop its chip, and nothing in THIS
   *  module's suite would catch it. `engine/redAttentionTaxonomy.test.ts` is where that contract is
   *  pinned.
   *
   *  @see engine/agentStall.ts — `chosenHere`, and its "TERM 3 IS A RELEVANCE JUDGEMENT" block
   *  @see services/controlListener.ts — the original reader, the refusal's `chosenHere` evidence */
  verifyInherited?: boolean;
  /** The `setAt` of the EPIC GOAL this goal was COPIED from, when it was copied by
   *  `services/sendToBuild`'s ladder rather than chosen by anyone (bead `sparkle-wab4lm`).
   *
   *  ⚠️ IT IS THE ONLY THING THAT MAKES A RE-SYNC SAFE (roborev 65882). An epic goal that is edited
   *  after an orchestrator was handed it leaves that orchestrator being judged against a sentence
   *  the epic no longer states — so the copy has to be refreshable. But `AgentGoal` records no
   *  AUTHOR, so a timestamp comparison alone cannot tell "a stale ladder copy" from "the objective a
   *  human deliberately wrote for this orchestrator", and the first cut of that re-sync silently
   *  destroyed the second: a human sets the goal at T1, the epic goal is edited at T2, and the next
   *  dispatch — which includes the epic sweep's TIMER, with no human gesture behind it at all —
   *  overwrote their wording.
   *
   *  Absent therefore means "this code did not write it", and a goal with no marker is NEVER
   *  re-synced. That is the fail-closed direction: the cost of not refreshing a copy is a stale
   *  sentence a person can see and fix, and the cost of refreshing a non-copy is losing what they
   *  wrote — which is the failure this whole feature is trying not to commit. */
  fromEpicGoalAt?: number;
}

/** Where a goal is in its life. `none` is the absence of a goal, kept in the union so every
 *  consumer branches over one exhaustive vocabulary rather than juggling `undefined`. */
export type GoalState =
  | "none"
  | "unmet"
  | "met"
  | "discharged"
  | "expired"
  | "escalated"
  /** THE WORK IS DONE AND ONLY A PERSON MAY CLOSE THE GOAL. Not "blocked" — see
   *  {@link awaitingClose} for the whole argument and {@link AwaitingCloseEvidence} for what a
   *  caller must supply to reach it. */
  | "awaiting_close";

/**
 * ⚠️ THE TOKEN `awaiting_close` IS FROZEN AND CROSSES A LANGUAGE BOUNDARY.
 *
 * `nudger.rs` will key a stand-down on this exact literal, read off the roster's `goal_state` field
 * (`useRosterPublisher`). There is no compile-time check across that seam — it is a VALUE
 * comparison over a string on both sides — so a variant spelling (`awaitingClose`, `awaiting-close`)
 * silently reads as "unfinished" on the Rust side, which is the safe direction and therefore the
 * SILENT one: the stand-down simply never fires and the feature ships permanently inert.
 *
 * ⚠️ SAY WHAT THE RUST SIDE DOES TODAY, not what it is about to do (roborev 65987). As of this
 * commit `src-tauri` contains NO occurrence of this token: `nudger.rs::goal_is_met` matches
 * `"met" | "discharged"` and nothing else, so an `awaiting_close` row reads to the ladder exactly as
 * `escalated` did — a live goal, still pinged. That is UNCHANGED behaviour rather than a regression
 * (the token this replaces was equally unrecognised), and it is the half of the founder's complaint
 * this branch does not close; the matching stand-down is landing in parallel in a Rust-side change
 * this worktree cannot see. A comment describing that as already-true would send the next reader
 * looking for a branch that is not there.
 *
 * Note that the three tokens in this feature are deliberately spelled three different ways, each
 * matching the convention of the vocabulary it joins: the GOAL STATE is `awaiting_close` (snake,
 * beside `unmet`/`escalated` on the wire), the STALL CAUSE is `awaiting-close` (kebab, beside
 * `blocked-on-human`), and the CONTINUATION REASON is `goal-awaiting-close` (kebab with the
 * `goal-` prefix its siblings carry). Do not "harmonise" them.
 */
export const AWAITING_CLOSE_STATE = "awaiting_close" as const;

/**
 * What a caller has COMPUTED about whether an agent's work has already shipped for THIS goal.
 *
 * Both bits come from outside this module and neither can be derived from the goal record, which is
 * why {@link goalStateOf} takes them as a parameter rather than reading them: `landed` is git
 * ancestry (`services/agentGoalReading.landedEvidenceFor`) and `shippedAfterGoalSet` compares the
 * merge watermark against `goal.setAt`. This module stays pure.
 *
 * ⚠️ BOTH DEFAULT TO REFUSING. `landed: undefined` means "nobody looked", not "not landed", and
 * either reading must leave the goal in its ordinary state. That is the correct direction here even
 * though it is the opposite of the usual fail-closed argument: reaching `awaiting_close` STOPS
 * auto-continue, so a false positive strands an agent that still had work to do. A false negative
 * costs only the status quo — the row keeps resuming, which is exactly what it does today.
 */
export interface AwaitingCloseEvidence {
  /** Git says this agent's branch reached the default branch. `undefined` = not looked up. */
  landed: boolean | undefined;
  /** The landing postdates {@link AgentGoal.setAt} — so it is evidence about THIS goal rather than
   *  about a watermark left by the previous one. */
  shippedAfterGoalSet: boolean;
}

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

/**
 * Phrases that mark a string as a STATUS NOTE rather than a goal — a description of the agent's
 * current STANCE (waiting, standing down, handing work off) instead of a future observable end
 * state. A status note is unachievable BY CONSTRUCTION: there is no state of the world in which
 * "awaiting the founder's next task" becomes true-and-done, so once one is set as a goal
 * auto-continue nudges the agent, sees no progress each time (correctly — there is none to make),
 * and spends its whole allowance discovering that a tautology cannot be satisfied before escalating
 * to a human as "something is blocking it" when nothing is (bead sparkle-lzb2qq).
 *
 * The entry gate (`validateWorkerGoal`) refuses an ABSENT or over-long goal at dispatch, but a
 * status note under the length cap passes it, and NOTHING re-checked a goal REPLACED later in an
 * agent's life — so a well-formed goal could be overwritten by one of these at turn 40 with no
 * guard firing. Enforcing here, at the substrate every goal write funnels through, closes that.
 *
 * These are the shapes the bead named ("awaiting", "stood down", "nothing pending", past-tense
 * handoff language). They are matched on WORD BOUNDARIES against the normalized text — deliberately
 * narrow, because a false positive REFUSES a legitimate goal: an agent cannot describe a checkable
 * end state with any of these, so the list is stance-of-waiting/handoff language, not any word that
 * could appear in a real criterion (which is why e.g. bare "next task" or "waiting for" is absent —
 * "waiting for CI to go green" is a real condition — while "waiting for the founder" is not).
 */
const STATUS_NOTE_MARKERS: readonly string[] = [
  "awaiting",
  "stood down",
  "standing down",
  "stand down",
  "standing by",
  "on standby",
  "nothing pending",
  "nothing further",
  "nothing to do",
  "no further work",
  "no further action",
  "no work pending",
  "waiting for the founder",
  "waiting for the human",
  "waiting for the next",
  "waiting for instructions",
  "waiting for further",
  "waiting for a new task",
  "handed off",
  "handed them",
  "handed it off",
  "handed back",
];

const STATUS_NOTE_RE = new RegExp(
  "\\b(" +
    STATUS_NOTE_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")\\b",
  "u",
);

/**
 * The offending status-note phrase if `text` reads as a status note (see {@link STATUS_NOTE_MARKERS})
 * rather than a future observable end state, or `undefined` if it does not. Pure; the caller decides
 * what to do with a hit (here, {@link newGoal} refuses it).
 *
 * Compared against the text lowercased with whitespace collapsed, so casing and spacing cannot
 * smuggle one past.
 */
export function statusNoteMarker(text: string): string | undefined {
  const norm = text.trim().toLowerCase().replace(/\s+/g, " ");
  const m = STATUS_NOTE_RE.exec(norm);
  return m ? m[1] : undefined;
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
 *  `projectStore.setAgentGoal` does exactly that.
 *
 *  ALSO THROWS on a STATUS-NOTE-shaped string (see {@link statusNoteMarker}) — same reasoning as the
 *  empty case, one shape worse: an empty goal at least reads as unmet, but a status note reads as a
 *  plausible goal while being unsatisfiable BY CONSTRUCTION, so it survives the entry gate and then
 *  burns the whole auto-continue allowance before escalating as a phantom blocker (bead
 *  sparkle-lzb2qq). Because this is the substrate every goal WRITE funnels through — dispatch AND the
 *  mid-life `set_agent_goal` replacement that had no gate at all — the refusal belongs here, so a
 *  status note cannot overwrite a real goal at turn 40 any more than it could be set at brief time. */
export function newGoal(
  text: string,
  now: number,
  ttlMs = DEFAULT_GOAL_TTL_MS,
  verify?: GoalVerify,
): AgentGoal {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("a goal needs text — an empty goal can never be acted on");
  const note = statusNoteMarker(trimmed);
  if (note !== undefined) {
    throw new Error(
      `a goal must state a future observable end state, not a status note — "${note}" reads as a ` +
        `standby/handoff note that nothing can ever satisfy. State what will be TRUE when the work ` +
        `is done and how anyone else could check it.`,
    );
  }
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
export function goalStateOf(
  goal: AgentGoal | undefined,
  now: number,
  awaiting?: AwaitingCloseEvidence,
): GoalState {
  const base = baseGoalStateOf(goal, now);
  // LAYERED OVER THE RECORD-ONLY ANSWER, never woven into it. `awaiting_close` is the only state
  // here that depends on something outside the goal record, so it is applied as a post-pass — which
  // is also what makes the two ordering guarantees below structural rather than a matter of where
  // an `if` happens to sit.
  if (base !== "unmet" && base !== "escalated") return base;
  if (goal === undefined) return base;
  return awaitingClose(goal, awaiting) ? "awaiting_close" : base;
}

/**
 * Is this goal's WORK done, with only a person's close outstanding?
 *
 * All FIVE conditions, and each rules out a specific way this would otherwise fire wrongly:
 *
 *   1. `landed === true` — git, not the agent. `undefined` ("nobody looked") and `false` both
 *      refuse, the same `=== true` discipline `canSelfMarkMet` uses on the same value.
 *   2. `shippedAfterGoalSet` — the landing must POSTDATE the goal. `workflowShipped` is a monotonic
 *      latch that survives into the next goal, so without this an agent that landed PR #1 and was
 *      then given a fresh objective would read as finished the moment it went quiet.
 *   3. The check is NOT agent-closable. If the agent could close it itself there is no person to
 *      wait for, and the honest state is `unmet` — it simply has not called the tool yet.
 *   4. A check was STATED at all. `verify === undefined` means the goal never claimed to be
 *      verifiable, `canSelfMarkMet` waves it through, and there is again nobody to wait for.
 *   5. ⚠️ THE CHECK WAS CHOSEN FOR THIS GOAL — `verifyStated === true && verifyInherited !== true`,
 *      the same `chosenHere` term `agentStall`'s `human-verified-goal` requires (roborev 65987).
 *      Without it this fires on the COMMON path, not an edge: `chargeGoalDebt` MANUFACTURES
 *      `INHERITED_VERIFY = {kind:"human"}` for any goal whose text is not landing-shaped and which
 *      inherited a binding obligation, so an ordinary work goal ends up carrying a sign-off nobody
 *      asked for. Here the consequence is far worse than the colour decision that term was written
 *      for: this state SHORT-CIRCUITS `decideContinuation`, so such an agent would never be
 *      auto-resumed for that goal again — labelled "done — awaiting your close", waiting on a
 *      verdict no person knows is owed. That is precisely the "a false positive strands an agent
 *      that still had work to do" outcome {@link AwaitingCloseEvidence} says must be avoided, and it
 *      is why this term is worth being narrower than the surrounding feature.
 *
 * ⚠️ WHAT THAT NARROWNESS COSTS, stated rather than left to be rediscovered: a genuinely-finished
 * agent whose human check was INHERITED keeps today's behaviour exactly — resumed, escalated,
 * and red if it answered `blocked-on-human`. The fix for that population is to stop manufacturing
 * `human` for unrelated work, which is `chargeGoalDebt`'s problem, not to widen this term; widening
 * it trades a bounded miss for an unbounded strand.
 *
 * ⚠️ THIS DOES NOT LET THE AGENT CLOSE ANYTHING. It changes what the ROW SAYS while it waits, and
 * nothing else. `canSelfMarkMet`, `mayReplaceVerify` and the withholding of `landed` evidence from
 * human-kind goals in `controlListener.handleSetGoalMet` are all untouched, deliberately: a
 * `{kind:"human"}` goal still refuses `set_agent_goal_met` with `goal_not_self_markable` whether or
 * not the work landed. The problem being fixed is a status that PRETENDS TO BE BLOCKED, not a
 * sign-off the agent should have been allowed to forge.
 */
function awaitingClose(goal: AgentGoal, awaiting: AwaitingCloseEvidence | undefined): boolean {
  if (awaiting?.landed !== true) return false;
  if (awaiting.shippedAfterGoalSet !== true) return false;
  if (goal.verify === undefined) return false;
  // Condition 5 — the provenance term. Written as its own statement rather than folded into the
  // return so the docblock's numbering maps one-to-one onto lines, and so mutating it is a
  // single-line change a mutation check can name.
  if (goal.verifyStated !== true || goal.verifyInherited === true) return false;
  return !agentClosableKind(goal.verify.kind);
}

/** {@link goalStateOf} over the RECORD ALONE — the whole state machine as it stood before
 *  `awaiting_close`, kept verbatim and kept private.
 *
 *  Two orderings survive from it unchanged, and both are guaranteed by this function running FIRST:
 *
 *  • `met` WINS. A goal somebody already closed is closed; re-opening it as "awaiting your close"
 *    would ask the reader for a click they already made. Evidence cannot reach past `metAt`.
 *  • `discharged` and `expired` WIN TOO. `awaiting_close` is entered only from `unmet` or
 *    `escalated` — a discharged goal is finished by git's own proof and needs no human, and an
 *    expired one has outlived its mandate, so neither is "waiting" on anybody.
 *
 *  An ESCALATED goal DOES reach `awaiting_close`, and that is the motivating case rather than an
 *  edge: the row this feature exists for had already escalated (auto-continue spent its budget)
 *  while its work sat merged on main. Note what is NOT done here — the `escalatedAt` LATCH is not
 *  cleared, and nothing writes to the record at all. This is a reading, so a row that stops
 *  qualifying (the evidence goes stale, a new goal is set) falls straight back to `escalated` with
 *  its history intact. */
function baseGoalStateOf(goal: AgentGoal | undefined, now: number): GoalState {
  if (goal === undefined) return "none";
  if (goal.metAt !== undefined) return "met";
  if (goal.escalatedAt !== undefined) return "escalated";
  if (goal.dischargedAt !== undefined) return "discharged";
  if (now >= goalDeadline(goal)) return "expired";
  return "unmet";
}

/**
 * Do this goal's ESCALATION FIELDS apply — its reason, its stale-quote flag, its remaining re-arms?
 *
 * ⚠️ ONE PREDICATE, TWO CALLERS, AND THE DRIFT BETWEEN THEM WAS A REAL BUG (roborev 66027). It is
 * NOT the bare `escalatedAt` latch, and it is NOT the bare state either — each of those is wrong in
 * a different direction, which is exactly why this is a function rather than an inline test at each
 * site:
 *
 *   • THE BARE LATCH IS TOO WIDE. `markGoalMet` does not clear `escalatedAt` and `baseGoalStateOf`
 *     answers `met` BEFORE `escalated`, so an escalation that was RESOLVED — the normal terminal
 *     shape — keeps the latch forever. Keyed on it alone, the roster publishes
 *     `{ state: "met", rearmsRemaining: 2 }` for a finished agent, and `conciergeRearmAgentGoal`
 *     gates only on `escalatedAt` too, so a concierge sweeping for a positive allowance is not
 *     refused: it spends a re-arm and hands `REARM_GRANT` continues back to a met goal.
 *
 *     ⚠️ THAT WRITE PATH IS STILL UNGUARDED — this predicate removes the roster CUE, not the call
 *     (`sparkle-0qq4hx`). A concierge acting on a stale notification or an older reading still
 *     reaches `conciergeRearmAgentGoal` and is still charged. The symmetric guard belongs at the
 *     source, the way `escalateGoal` added one for the mirror-image race (`sparkle-i5v42`).
 *   • THE BARE STATE IS TOO NARROW, which is the trap that produced this predicate. The state layers
 *     `escalated` into `awaiting_close`, so a row that escalated and then landed silently loses the
 *     sentence explaining why the fleet gave up, and loses the field that says whether the concierge
 *     may act on it — for the exact population `awaiting_close` exists for.
 *
 * So: the state must still be one where an escalation is OUTSTANDING, and for the derived state the
 * latch must actually be set. `met`, `discharged` and `expired` are all false whatever the latch
 * says. `agentStall` reaches the same conclusion for its own goal causes and states it at length.
 */
export function escalationFieldsApply(goal: AgentGoal | undefined, state: GoalState): boolean {
  if (goal === undefined) return false;
  if (state === "escalated") return true;
  return state === "awaiting_close" && goal.escalatedAt !== undefined;
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
   *  `engine/agentStall` reads it to decide whether the `human-verified-goal` cause fires. That cause
   *  is AMBER since 2026-08-18 (it was RED before), so widening this no longer suppresses a red dot —
   *  it drops the "awaiting your sign-off" chip. The full warning is on
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
