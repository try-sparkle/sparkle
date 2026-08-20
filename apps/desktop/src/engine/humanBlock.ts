// humanBlock — THE AGENT'S OWN ANSWER THAT A PERSON IS THE BLOCKER.
//
// ── THE FOUNDER'S RULE, verbatim (2026-08-18) ─────────────────────────────────────────────────
// *"It seems like this should be a red dot so that seems problematic that it's not showing as red
// when it says it's blocked on human."* — on the 'Sparkle CI Runner Spot Autoscale' row, which read
// blocked-on-human in its goal badge and drew AMBER.
//
// ── WHY THE ROW COULD SAY THAT WHILE DRAWING AMBER ────────────────────────────────────────────
// Because the two came from different systems that never met. The DOT is derived structurally from
// `agentStall`'s causes; the WORDS were agent-authored prose — `goal.escalationReason`, interpolated
// verbatim into the goal badge by `components/rowAttention.goalBadgeFor` and printed by `AgentRow`.
// Nothing in the app owns the phrase "blocked on human" as a label; it arrived as DATA, through
// `set_agent_escalation`'s free-text `reason`. So the row could assert any blocker at all and the
// colour system had no way to hear it. Prose cannot be a colour input — this module is the
// structured signal that replaces it.
//
// ── THE SIGNAL ALREADY EXISTED AND WAS WIRED TO NOTHING ───────────────────────────────────────
// `nudge_ladder.rs` asks a silent agent point-blank — *"Reply with ONE line: blocked-on-human |
// blocked-on-ci | blocked-on-another-agent | blocked-on-quota | not-blocked | no-task-assigned |
// out-of-context"* — and routes an answer of `blocked-on-human` to `Standdown::AwaitHuman` →
// `Escalation::Founder`, published as a `NudgeFlag`. `services/authRecovery` mirrors that flag into
// TypeScript and exposes `nudgeFlagFor(agentId)`.
//
// `nudgeFlagFor` HAD ZERO CALL SITES. The one machine-verified "a human is the blocker" fact the app
// produces never reached the dot, the band, or any notification. This module is that missing edge,
// and it is the whole reason the fix is narrow: nothing here infers a human blocker, it only relays
// one the agent stated when asked.
//
// ── WHY THIS AND NOT "ANY ESCALATED GOAL" ─────────────────────────────────────────────────────
// Because `escalated-goal` is AMBER by the founder's own instruction of 2026-08-06 — *"why are they
// red when they don't require my assistance?"* — after he triaged rows that owed him nothing six
// times in one day. Reddening that tier again would rebuild exactly the wall of false red that cost
// him a day, which is how red stops meaning anything. `stallEscalation.LIFECYCLE` keeps its five
// members untouched. What this adds is a SIXTH, narrower fact that sits beside them: the agent was
// asked and said a person is what it is waiting on.
//
// PURE. Data in, data out; no clock, no registry read, no I/O. The caller supplies the flag.
/**
 * The wire token `nudge_ladder.rs` writes for `Reply::Human`, and the only reply that means a
 * PERSON is the blocker. Its siblings (`blocked-on-ci`, `blocked-on-another-agent`,
 * `blocked-on-quota`, `no-task-assigned`, `out-of-context`) all name an actor who is NOT the
 * founder, and each is deliberately routed elsewhere by the ladder — see `Standdown::of`.
 */
const BLOCKED_ON_HUMAN_REPLY = "blocked-on-human";

/**
 * The escalation target `nudge_ladder::Escalation::Founder` serialises to.
 *
 * REQUIRED IN ADDITION TO THE REPLY, and that is not belt-and-braces. `Standdown::flag()` is the
 * authority on who a stand-down is FOR, and it deliberately routes several *blocked-shaped* replies
 * to `Escalation::Concierge` instead — a task-less agent (`sparkle-dfy3d`) and an out-of-context one
 * (`sparkle-umtx1`) were both found raising founder-level rows that no person could act on. Reading
 * the reply alone would re-open that class of false alarm one layer up, in a module whose entire
 * job is to avoid it. Asking for BOTH means this cause fires only where Rust already concluded the
 * founder is the target.
 */
const FOUNDER_TARGET = "founder";

/**
 * The shape this module needs from a raised nudger flag.
 *
 * STRUCTURAL ON PURPOSE — `services/authRecovery.NudgeFlag` satisfies it without being imported, so
 * `engine/` keeps its no-dependency-on-`services/` direction and this stays unit-testable with a
 * literal. Widening `NudgeFlag` cannot silently change what is read here.
 */
export interface HumanBlockFlag {
  /** `"founder"` | `"concierge"` — `nudge_ladder::Escalation::as_str`. */
  target: string;
  /** The agent's own one-line answer, or null/absent if it never answered. */
  reply?: string | null;
  /** Epoch ms the episode was first raised. Carried across refreshes by `nudger.rs::apply_flags`,
   *  so it is the age of the ASK and not of the last look. */
  raisedAtMs: number;
}

/** An agent that answered, in its own words, that a person is what it is waiting on. */
export interface HumanBlock {
  /** When the ask was first raised — the age a reader needs to tell one minute from six hours. */
  raisedAtMs: number;
}

/**
 * The human block this flag asserts, or `undefined`.
 *
 * ⚠️ `undefined` FOR EVERY UNCERTAIN CASE, and that direction is the point. No flag, a flag for the
 * concierge, an agent that never answered, or an answer naming any other blocker all return
 * `undefined` — this is the loudest tier the app has, so it fires only on a positive statement.
 * That is the opposite default from `agentStall`'s git-evidence fields, which may report `undefined`
 * as "not looked up"; here there is nothing to look up, only something the agent did or did not say.
 *
 * ⚠️ IT CANNOT GO STALE, which is why no clock is needed and why the founder's "stale can never be
 * red" rule does not veto it. `nudger.rs::apply_flags` CLEARS the flag on the first look where the
 * agent has moved and raises no flag of its own, so a live flag means the agent is still silent and
 * still standing on this answer. That is a different fact from `agentGoal.escalationQuotesStaleText`,
 * which reports that a FROZEN escalation SENTENCE quotes a goal the agent no longer holds — prose
 * that nothing regenerates and that outlives what it describes. Staleness is a property of the
 * record there and is impossible here, so the veto belongs on that path, not on this one.
 */
export function humanBlockOf(flag: HumanBlockFlag | undefined): HumanBlock | undefined {
  if (flag === undefined) return undefined;
  if (flag.target !== FOUNDER_TARGET) return undefined;
  if (flag.reply !== BLOCKED_ON_HUMAN_REPLY) return undefined;
  return { raisedAtMs: flag.raisedAtMs };
}
