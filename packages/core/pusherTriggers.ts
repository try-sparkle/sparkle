// WHAT A PUSHER IS ALLOWED TO NOTICE — the measured conditions that can raise it off rung 0, and
// the persistence rule that keeps it quiet about everything transient.
//
// ── THE ANTI-TUNE-OUT RULE ───────────────────────────────────────────────────────────────────────
// A Pusher may speak only about a condition it has now observed TWICE IN A ROW. A condition that
// clears itself between two observations never reaches rung 1 at all.
//
// This is the mechanism that stops the Pusher becoming a thing its partner learns to ignore, and it
// works because of what it structurally cannot say. Most of what looks alarming in a terminal
// snapshot is a partner mid-stride: commits unpushed because a push is three seconds away, a
// question that was already answered, a goal about to be marked. One observation cannot tell those
// apart from a genuine stall; two, spaced a cycle apart, can. So the cost of the rule is latency —
// a real stall is challenged one cycle later than it could have been — and the benefit is that
// nearly every false positive dies before it is ever spoken. That trade is the right way round: a
// late challenge is still useful, and a wrong one spends credibility the channel does not get back.
//
// ── EVERY TRIGGER CARRIES ITS OWN ARITHMETIC ─────────────────────────────────────────────────────
// A trigger is not a boolean. It carries the numbers that made it fire, because `pusherGate` will
// refuse any challenge quoting a number that is not in that list — see `pusherGate`'s header for
// why "contains a digit" is not the rule. The consequence for anyone adding a trigger here: if you
// do not put a measurement in `measured`, no challenge may mention it. That is deliberate. It makes
// the citation rule total rather than best-effort, and it means the way to let a Pusher say
// something new is to MEASURE something new.
//
// ── THE CHALLENGE IS A TEMPLATE, AND NO MODEL COMPOSES IT ────────────────────────────────────────
// Each trigger carries the finished sentence, built from its own `measured` values. There is no
// model call anywhere at rungs 0-1.
//
// The design budgeted a Haiku call per observation to compose this text. Once the citation rule in
// `pusherGate` was built, that call had almost nothing left to do: a composer that may only restate
// numbers somebody else measured, and may not invent, round, or estimate any of them, is buying
// phrasing variety and nothing else.
//
// And phrasing variety has NEGATIVE value here. A challenge has to be recognisable at a glance as a
// Pusher challenge carrying a measured number; varied prose makes each one look like a fresh piece
// of writing to read and weigh. A fixed shape is what lets a partner take it in without stopping.
// So the template is not a fallback for when the model is unavailable — it is the whole mechanism,
// and it passes the gate by construction rather than by hoping a composer stayed in bounds.
//
// If Phase 2's demand rung turns out to need judgement rather than arithmetic, that is the place to
// revisit this, with evidence from Phase 1's hit-rate log.
//
// ── PURE ────────────────────────────────────────────────────────────────────────────────────────
// No clock (callers pass `now`), no git, no terminal read, no model. It turns an already-gathered
// observation into triggers. Gathering is the caller's job precisely because that is the part that
// needs the app; keeping it out is what makes every rule here testable as arithmetic.

/** The conditions a Phase 1 Pusher may notice. Adding one means measuring one — see the header. */
export type TriggerId =
  /** Verified commits sitting unpushed on the partner's branch. */
  | "unpushed-commits"
  /** The goal's TTL elapsed and it was never marked met. The design's highest-value trigger. */
  | "goal-expired"
  /** roborev has reviewed this branch enough times to be past its documented plateau. */
  | "roborev-rounds"
  /** The partner asked a question and nothing has answered it. */
  | "unanswered-question";

export interface Trigger {
  id: TriggerId;
  /**
   * Every number this trigger measured, as the literal token a challenge may quote — the
   * measurement AND the threshold it fired against. `pusherGate.gateChallenge` refuses any number
   * outside this list.
   */
  measured: string[];
  /** A cited sentence built only from `measured`. Used when the composing model cannot be. */
  challenge: string;
}

/**
 * What one observation cycle gathered about a partner. Every field is a MEASUREMENT, not a
 * judgement — there is deliberately no `looksStuck` here, because a Pusher that can be told
 * something is wrong without being told the number is a Pusher that can say so without one.
 */
export interface Observation {
  /** Commits on the partner's branch not present on its upstream. */
  unpushedCommits: number;
  /** When the oldest unpushed commit was authored, epoch ms; undefined when there are none. */
  oldestUnpushedAt?: number;
  /** Goal expiry, epoch ms (`setAt + ttlMs`); undefined when there is no goal. */
  goalExpiresAt?: number;
  /** True once the goal is marked met — a met goal is never a trigger, however long ago it expired. */
  goalMet: boolean;
  /** Open roborev reviews recorded against this branch. */
  roborevRounds: number;
  /** When the partner last asked a question with no recorded answer, epoch ms. */
  questionUnansweredSince?: number;
  /** Epoch ms this observation was taken. */
  now: number;
}

/**
 * Minutes of unpushed work before it is worth mentioning.
 *
 * Not zero, and not small: a partner that just committed is usually about to push, and the
 * two-observation rule alone would not save us here because a slow verification run keeps the state
 * true across both cycles without anything being wrong. Thirty minutes is long enough that the
 * ordinary commit → run tests → push rhythm completes inside it.
 */
export const UNPUSHED_MINUTES = 30;

/**
 * roborev round at which the repo's own measured FAIL-rate plateau makes another lap pointless.
 *
 * The repo documents this: FAIL rates by review ordinal run 61.6% on the first, then 53.5, 46.2,
 * 46.0, and plateau around 40-48% through at least the 14th. Every fix is itself reviewable, so the
 * loop does not converge — an agent told to "keep going until it's clean" burns a session and is
 * still not clean. Past this round the useful advice is to land, not to iterate, which is exactly
 * the kind of thing a partner deep in the loop cannot see and an outside observer can.
 */
export const ROBOREV_PLATEAU_ROUND = 8;

/** Minutes an unanswered question waits before it is worth pointing at. */
export const UNANSWERED_MINUTES = 20;

/** Whole minutes between two epoch-ms instants, floored. */
export function minutesBetween(from: number, to: number): number {
  return Math.floor((to - from) / 60_000);
}

/** `{h, m}` for a duration in ms, floored. Used so an elapsed goal reads "3h 12m", not "192m". */
export function splitHoursMinutes(ms: number): { h: number; m: number } {
  const total = Math.max(0, Math.floor(ms / 60_000));
  return { h: Math.floor(total / 60), m: total % 60 };
}

/**
 * Which conditions hold, with the arithmetic that makes each one true.
 *
 * Order is by how directly the condition blocks SHIPPING — an expired goal and unpushed work are
 * about work that exists but has not moved; a roborev lap and an unanswered question are about
 * work that is moving but circling. Callers that raise only one trigger per cycle should take the
 * first, so the order is a priority, not a presentation detail.
 */
export function evaluateTriggers(obs: Observation): Trigger[] {
  const out: Trigger[] = [];

  // GOAL EXPIRED — the design's highest-value trigger, and the reason is that it is a DEAD LETTER
  // everywhere else: `goalStateOf` returns "expired" at `setAt + ttlMs`, and `decideContinuation`
  // answers an expired goal with `{action:"none", reason:"goal-expired"}`. Nothing acts on it. The
  // auto-continue machinery deliberately stops, which is correct for a machine that would otherwise
  // retry forever, and it leaves the state with no owner at all.
  if (obs.goalExpiresAt !== undefined && !obs.goalMet && obs.now >= obs.goalExpiresAt) {
    const { h, m } = splitHoursMinutes(obs.now - obs.goalExpiresAt);
    out.push({
      id: "goal-expired",
      measured: [String(h), String(m)],
      challenge: `Your goal expired ${h}h ${m}m ago and is still unmet.`,
    });
  }

  if (obs.unpushedCommits > 0 && obs.oldestUnpushedAt !== undefined) {
    const mins = minutesBetween(obs.oldestUnpushedAt, obs.now);
    if (mins >= UNPUSHED_MINUTES) {
      out.push({
        id: "unpushed-commits",
        measured: [String(obs.unpushedCommits), String(mins), String(UNPUSHED_MINUTES)],
        challenge: `You have ${obs.unpushedCommits} commits unpushed for ${mins} minutes.`,
      });
    }
  }

  if (obs.roborevRounds >= ROBOREV_PLATEAU_ROUND) {
    out.push({
      id: "roborev-rounds",
      measured: [String(obs.roborevRounds), String(ROBOREV_PLATEAU_ROUND), "40", "48", "3", "14"],
      challenge:
        `This is roborev round ${obs.roborevRounds}. The repo's own measured data plateaus at ` +
        `40-48% FAIL from round 3 through at least round 14. Land it.`,
    });
  }

  if (obs.questionUnansweredSince !== undefined) {
    const mins = minutesBetween(obs.questionUnansweredSince, obs.now);
    if (mins >= UNANSWERED_MINUTES) {
      out.push({
        id: "unanswered-question",
        measured: [String(mins), String(UNANSWERED_MINUTES)],
        challenge: `You asked a question ${mins} minutes ago; no reply is recorded in your inbox.`,
      });
    }
  }

  return out;
}

/**
 * The trigger ids present in BOTH the previous cycle and this one — the only ones eligible to be
 * spoken about.
 *
 * Compares by id, not by measured value, and that is the point: "4 commits unpushed for 38 minutes"
 * and "4 commits unpushed for 43 minutes" are the SAME persisting condition, and requiring the
 * numbers to match would mean a condition that persists but keeps getting worse never qualifies —
 * exactly inverting the rule. The numbers a challenge cites come from the CURRENT observation, so
 * what the partner hears is always the fresh measurement of a condition that has now been true
 * twice.
 */
export function persistedTriggers(previous: readonly Trigger[], current: readonly Trigger[]): Trigger[] {
  const before = new Set(previous.map((t) => t.id));
  return current.filter((t) => before.has(t.id));
}
