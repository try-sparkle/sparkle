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
  /** Lifetime from `setAt`. Defaults to {@link DEFAULT_GOAL_TTL_MS}. */
  ttlMs: number;
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
   *  this decides only what the refusal TELLS the agent. Nothing about enforcement reads it. */
  verifyInherited?: boolean;
}

/** Where a goal is in its life. `none` is the absence of a goal, kept in the union so every
 *  consumer branches over one exhaustive vocabulary rather than juggling `undefined`. */
export type GoalState = "none" | "unmet" | "met" | "expired" | "escalated";

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
 */
export function goalStateOf(goal: AgentGoal | undefined, now: number): GoalState {
  if (goal === undefined) return "none";
  if (goal.metAt !== undefined) return "met";
  if (goal.escalatedAt !== undefined) return "escalated";
  if (now >= goal.setAt + goal.ttlMs) return "expired";
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
  return Math.max(0, goal.setAt + goal.ttlMs - now);
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

/** Hand the goal to the human. Latched (see {@link AgentGoal.escalatedAt}); a second escalation
 *  keeps the first reason, so the human reads why it ORIGINALLY gave up. */
export function escalateGoal(goal: AgentGoal, now: number, reason: string): AgentGoal {
  if (goal.escalatedAt !== undefined) return goal;
  return { ...goal, escalatedAt: now, escalationReason: reason };
}

/** Clear the retry budget because a HUMAN changed the picture — they typed to the agent, or
 *  rewrote the goal. Also clears an escalation: the human acting on the escalation is exactly the
 *  event that makes retrying reasonable again.
 *
 *  THIS IS THE HUMAN'S LEVER, and that is why it resets `totalContinues` too. Nothing the agent
 *  can do reaches it — see {@link clearGoalMet} for the agent-facing counterpart, which
 *  deliberately cannot refill the ceiling. */
export function resetGoalRetries(goal: AgentGoal): AgentGoal {
  const { escalatedAt: _e, escalationReason: _r, mark: _m, ...rest } = goal;
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
   *  {@link AgentGoal.verifyInherited}. Read only by the refusal copy, never by the gate. */
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
  if (goal.totalContinues === 0 && goal.escalatedAt === undefined && goal.verify === undefined) {
    return undefined;
  }
  return {
    totalContinues: goal.totalContinues,
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
    ...(escalatedAt !== undefined
      ? {
          escalatedAt,
          ...(escalationReason !== undefined ? { escalationReason } : {}),
        }
      : {}),
  };
}
