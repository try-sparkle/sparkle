// activityNarrationPolicy (bead ) — WHEN may Sparkle spend a turn of the user's own
// Claude quota to regenerate an agent's activity line?
//
// PURE. Data in, data out — no store, no clock of its own, no invoke — so the whole spend policy
// unit-tests as arithmetic. That matters more here than in most of this tree: every `true` this
// function returns is a real charge against the user's subscription, and the failure mode of
// getting it wrong is invisible (a slightly larger bill), not red.
//
// WHY A THROTTLE AT ALL. Narration is triggered by Claude Code's `Stop` hook, i.e. once per TURN.
// A turn is not a fixed unit of work: an agent grinding through a long build produces one Stop in
// twenty minutes, while an agent in a tight question-and-answer loop with a human can produce one
// every few seconds. Without a floor, that second agent alone re-narrates dozens of times a minute
// — and this app routinely runs a fleet of 60+ agents at once, so the un-throttled worst case is
// hundreds of Haiku calls per minute to keep a muted secondary line current. The line is read by a
// human glancing at a sidebar; it does not need sub-minute resolution.

/**
 * Minimum gap between two narrations of the SAME agent.
 *
 * Deliberately just under `ACTIVITY_STALE_MS` (120s, engine/activityFreshness): the line is allowed
 * to reach the edge of stale before we pay to refresh it, but a chatty agent can never make us pay
 * more than once a minute. Under-shooting this wastes the user's quota; over-shooting it means a
 * narration that is routinely rendered as a stale past quote, which is the bug this feature exists
 * to remove. 60s sits at the point where a fresh-enough line costs at most one call per agent per
 * minute.
 */
export const NARRATION_MIN_INTERVAL_MS = 60_000;

/**
 * How long a DELIBERATE self-report is protected from being overwritten by a generated one.
 *
 * WHY THIS EXISTS (roborev 82272, High). Narration writes into the same
 * `activity`/`activityAt`/`activitySource` triple a real `set_agent_activity` call occupies. Judged
 * on AGE alone, a still-fresh self-report is clobbered by a generated recap — and the two constants
 * made that window unavoidable rather than rare: the throttle frees narration at 60s while the
 * notification path treats a self-report as usable until 120s, so EVERY self-report aged 60-120s
 * was both overwritable and still eligible to supply a notification body.
 *
 * That is not a labelling nit, it is a live cost regression. Sequence: an agent calls
 * `set_agent_activity("Blocked on the schema decision")` at T+0; a Stop at T+61s overwrites it as
 * `"narrated"`; the agent goes `waiting` at T+70s; `selfReportBody` now sees `"narrated"`, returns
 * null, and Sparkle PAYS for a `summarize_attention` call that the agent's own fresh, ask-relevant
 * words would have answered for free. Because narration re-fires at every Stop past the floor, the
 * Phase-2b saving is dead for essentially every narrated agent, not for an edge case.
 *
 * It also protects the ESCAPE HATCH. A self-report is the only way an agent can say something its
 * transcript does not show — "blocked on the schema decision", "waiting on the founder" — and a
 * recap of the turn that just ended is a strictly worse answer to "what is this agent doing".
 *
 * MUST BE >= the notification path's `ACTIVITY_FRESH_MS`, or the 60-120s hole reopens. Pinned by a
 * test in `useAttentionNotifications.selfReport.test.ts`, which is the one file that imports both —
 * this module stays free of the React hook module that owns that constant.
 */
export const SELF_REPORT_PROTECTED_MS = 120_000;

/**
 * Is the line currently on this agent a DELIBERATE self-report that narration must not overwrite?
 *
 * ONE DEFINITION, TWO CALL SITES, AND THE SECOND ONE IS THE POINT (roborev 82276, High). Reading
 * this once inside `shouldNarrate` makes the protection a CHECK-THEN-ACT with an unbounded gap: the
 * decision is taken, then the model call spends the whole of its latency (up to the backend's 60s
 * timeout), and the write lands unconditionally on whatever the row holds by then. A
 * `set_agent_activity("Blocked on the schema decision")` arriving inside that window — the ordinary
 * shape for an agent that has just been handed new work — is destroyed by a recap of the PREVIOUS
 * turn, and `activitySource` flips to `"narrated"` so the notification path pays for a
 * `summarize_attention` the free self-report would have answered. Worse, the write is stamped with
 * the `now` captured BEFORE the await, so it also rewinds `activityAt` backwards past the
 * self-report's own stamp. So `maybeNarrateActivity` re-asks this against the LIVE row at write
 * time and bails; extracting it here is what keeps the two asks from drifting apart.
 *
 * A line with NO stamp at all is not protected — that is what lets a brand-new agent get its first
 * narrated line. A line whose source is missing is treated as `"self"`: every line written before
 * provenance existed actually was one.
 */
export function selfReportProtected(
  existingSource: "self" | "narrated" | undefined,
  existingAt: number | undefined,
  now: number,
): boolean {
  if (existingSource === "narrated") return false;
  if (existingAt === undefined) return false;
  const age = now - existingAt;
  // A future stamp (skew) counts as fresh: the conservative direction is to leave the agent's own
  // words alone, never to destroy them on the strength of a bad clock.
  return age < 0 || age <= SELF_REPORT_PROTECTED_MS;
}

/**
 * The shortest assistant turn worth spending a model call on.
 *
 * A one-word turn ("Done.", "Yes.") carries nothing to narrate — the summarizer would either echo
 * it or invent something, and inventing is strictly worse than leaving the previous line in place
 * with its honest age showing.
 */
export const NARRATION_MIN_TURN_CHARS = 40;

export interface NarrationDecisionInput {
  /** The agent's last assistant turn, as read from the transcript at Stop. */
  turnText: string;
  /**
   * Epoch ms we last SPENT on this agent — an ATTEMPT, not a success. Undefined if never.
   *
   * ATTEMPT, EMPHATICALLY, AND THIS WAS A REAL BUG (roborev 82233, High). Keying the throttle on a
   * successful WRITE leaves every failure arm unthrottled: `narrateActivity` returns null for a
   * missing CLI, a signed-out CLI, `ai_busy`, a 60s timeout, a parse failure AND a whitespace-only
   * model reply, and none of those advance an activity line. So a persistently failing narrator was
   * judged against the SAME stamp on every turn and retried at full Stop frequency — reinstating
   * precisely the "hundreds of Haiku calls per minute across 60+ agents" case this module's header
   * says it exists to prevent, and worst exactly when the CLI is wedged, where each attempt also
   * occupies one of only 3 `Tier::Background` permits for up to 60s. `cacheable: true` does not
   * bound it either: the cache key includes the turn text, and every Stop carries a different turn.
   *
   * A whitespace-only reply is the sharpest case — a child really ran and really answered, so it is
   * a genuine spend that used to leave no trace in the throttle at all.
   */
  lastSpendAt: number | undefined;
  /** Now, injected so this is testable without a clock. */
  now: number;
  /** Whether the user has narration switched on at all. */
  enabled: boolean;
  /**
   * Provenance of the line currently on this agent, or undefined when there is none. A legacy
   * record carries no source and is treated as `"self"` — which is what every line written before
   * provenance existed actually was.
   */
  existingSource: "self" | "narrated" | undefined;
  /** Epoch ms the line currently on this agent was written, or undefined when there is none. */
  existingAt: number | undefined;
}

/**
 * Should we narrate this agent right now?
 *
 * Every arm is a REFUSAL to spend; the default is not to call. Returns a reason string rather than
 * a bare boolean so a caller can log WHY a narration did not happen — a silently-skipped call and a
 * silently-failed call look identical from the outside, and telling them apart is what makes this
 * debuggable at all.
 */
export function shouldNarrate(
  input: NarrationDecisionInput,
): { narrate: true } | { narrate: false; reason: string } {
  if (!input.enabled) return { narrate: false, reason: "disabled" };

  const text = input.turnText.trim();
  if (!text) return { narrate: false, reason: "empty-turn" };
  if (text.length < NARRATION_MIN_TURN_CHARS) return { narrate: false, reason: "turn-too-short" };

  // NEVER overwrite a DELIBERATE, still-fresh self-report (roborev 82272). The predicate lives in
  // `selfReportProtected` because the ORCHESTRATOR has to ask it a SECOND time, immediately before
  // it writes — see that helper's header.
  if (selfReportProtected(input.existingSource, input.existingAt, input.now)) {
    return { narrate: false, reason: "self-report-fresh" };
  }

  // A missing stamp means we have never spent on this agent — always narrate, so a newly-seen agent
  // gets a line on its first turn rather than waiting out an interval it was never in.
  if (input.lastSpendAt === undefined) return { narrate: true };

  const since = input.now - input.lastSpendAt;
  // A stamp in the FUTURE is clock skew. Treat it as "just narrated" and refuse: the conservative
  // direction is to under-spend the user's quota, never to over-spend it on a bad clock.
  if (since < 0) return { narrate: false, reason: "clock-skew" };
  if (since < NARRATION_MIN_INTERVAL_MS) return { narrate: false, reason: "throttled" };

  return { narrate: true };
}
