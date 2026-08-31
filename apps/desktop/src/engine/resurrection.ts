// resurrection — may this dead agent be brought back, and not before when?
//
// The per-agent gate. Its sibling `resurrectionCohort.ts` decides who goes FIRST when many agents
// died of one cause; this module decides whether a given agent is eligible at all.
//
// ── WHY IT IS NOT `apiRecovery`, WHICH LOOKS LIKE THE SAME THING ──────────────────────────────
// `engine/apiRecovery.ts` already ships a deterministic revive ladder, and it is good. It works by
// TYPING TEXT INTO A LIVING PTY — `decideRevive` refuses anything whose process is not still alive.
// So it cannot help a process that is GONE, which is every one of the 10 ENOTFOUND deaths and all
// 103 deaths from the two app quits on 2026-08-06. The two modules are disjoint on the liveness
// axis BY CONSTRUCTION: `errored + alive` is apiRecovery's, `errored + dead` is this one's. That
// mirror gate is asserted here, so the pair cannot start fighting silently.
//
// ── NO MODEL CALL ON ANY PATH ─────────────────────────────────────────────────────────────────
// When the wall is fleet-wide every LLM in the app is gated by the same account limit, so a
// recovery path that consults one is dead exactly when it is needed. This module is comparisons.
//
// PURE. Data in, data out; the clock arrives as a parameter.
import { REVIVE_LADDER_MS } from "./apiRecovery";
import { type DeathCause, armsOnClock, isResurrectable } from "./deathTypes";

/**
 * The respawn ladder, DERIVED from `apiRecovery.REVIVE_LADDER_MS` so the two curves cannot drift.
 *
 * The first three rungs (5s, 15s, 30s) are dropped, and that is the one real difference between a
 * revive and a respawn: a ping is a keystroke, while a respawn costs a worktree prep, a transcript
 * scan, an account pick, a `claude --resume` boot and the model re-reading its whole context.
 * Retrying that at 5s is a fork bomb, not a ladder.
 *
 * Yields 60s, 2m, 3m, 5m, 10m, 15m, 20m, 30m — 8 rungs, 1h 26m total. Both the shape and the total
 * are pinned BY VALUE in the tests, following this repo's own discipline, so an upstream edit to
 * `REVIVE_LADDER_MS` is NOTICED here rather than silently inherited.
 */
export const RESURRECT_LADDER_FIRST_RUNG = 3;
export const RESURRECT_LADDER_MS: readonly number[] = REVIVE_LADDER_MS.slice(
  RESURRECT_LADDER_FIRST_RUNG,
);

/**
 * THE LADDER IS A CEILING, NOT A CLIFF: past the last rung the gap STAYS at 30 minutes.
 *
 * This was originally a cliff, and the cliff was a bug that defeated the feature's main purpose
 * (roborev 60067). A monthly spend cap has no reset instant — it lifts when a human raises it,
 * which may be hours later — and the only way an agent comes back from one is by PROBING until a
 * probe succeeds. An episode that stops probing has simply lost that agent until someone notices,
 * which is the behaviour this whole module exists to end.
 *
 * So the backoff escalates to 30 minutes and then holds there. That is exactly the founder's
 * "exponential backoff with a ceiling"; the hard stop is the per-agent cap below, not the ladder.
 */
export const RESURRECT_LADDER_CEILING_MS =
  RESURRECT_LADDER_MS[RESURRECT_LADDER_MS.length - 1] ?? 30 * 60_000;

/**
 * The cross-episode backstop: total respawns allowed for one agent in a rolling 24h.
 *
 * Two bounds, and neither is redundant. The ladder governs PACE — after the ceiling above, at most
 * one attempt every 30 minutes, which is what actually prevents thrash. This one governs TOTAL, it
 * depends on nothing, and it is why a misidentified episode cannot become an unbounded loop.
 *
 * It MUST be counted in the durable ledger, not in memory: the largest killer of agents is the app
 * restart, which would zero an in-memory counter — the exact event the cap exists to survive.
 *
 * Why 24. It was 5, and 5 was WRONG in a way worth recording: the cap is checked before the ladder,
 * so a cap below the ladder's length made the last three rungs unreachable and burned an agent's
 * entire daily budget in 21 minutes — after which a wall lifting at hour three was never probed.
 * At the 30-minute ceiling, 24 attempts span at least ten hours of probing, which covers a session
 * limit and a same-day spend-cap raise, while still bounding the measured worst case (one session
 * retried into a closed door 45 times) well below what actually happened.
 */
export const MAX_RESURRECTS_PER_AGENT_PER_DAY = 24;
export const RESURRECT_DAY_MS = 24 * 60 * 60_000;

/**
 * The EARLY, cause-specific ceiling for a RESUME-THEN-EXIT LOOP (sparkle-y5dk8x).
 *
 * A mid-task self-exit (`unknown` + a `claude --resume` banner) that keeps recurring is not
 * converging: each exit is its OWN death episode, so the per-episode ladder restarts at its first
 * rung every cycle and the loop respawns on the FAST curve. The daily cap
 * ({@link MAX_RESURRECTS_PER_AGENT_PER_DAY}) would bound it eventually, but only after hours — and
 * every cycle in between loses the agent's in-flight work. This bounds the LOOP far earlier and hands
 * it to the concierge, WITHOUT touching the daily cap the wall-probing case depends on.
 *
 * Counted over the SAME rolling window as the daily cap, deliberately: a per-episode count resets
 * every cycle and so is blind to a loop. Smaller than the daily cap by construction, so the two
 * ceilings never collide — the loop is caught here first, and only a non-loop history reaches 24.
 *
 * Why 6. A genuinely transient one-off hiccup resumes and CONTINUES rather than re-exiting, so a
 * handful of automatic recoveries costs nothing and self-heals; a sixth clean-resume respawn still
 * ending in a mid-task death is a loop, not a blip. Six fast-ladder rungs span ~35 minutes, so a
 * human hears about a stuck agent within the half hour instead of the ten-plus hours 24 attempts run.
 */
export const MAX_MIDTASK_RESUMES = 6;

/** Why no respawn happened. A named reason rather than a bare `false`, mirroring
 *  `apiRecovery.NoReviveReason` and `goalContinuation.NoContinueReason` — this is the field a human
 *  reads when they ask why a dead row was left alone. */
export type NoResurrectReason =
  /** Nothing recorded this agent's death, so there is nothing to act on. */
  | "no-death-record"
  /** It is not dead. Respawning a live agent orphans the first child — see the double-spawn note. */
  | "already-live"
  /** It finished. Never resurrect, under any circumstance. */
  | "clean-goal-met"
  /** A person is the blocker; a respawn re-asks nothing. Escalate the question instead. */
  | "blocked-on-human"
  /**
   * A PERSON STOPPED IT. The safety property that pays for `unknown` becoming resurrectable.
   *
   * `deathTypes.isResurrectable` refused every unexplained death until 2026-08-13 for exactly one
   * reason: a deliberate stop was recorded as `unknown`, so refusing the whole class was the only
   * way to avoid restarting an agent its owner had just killed. Now that the stop path writes
   * `human-stopped`, this is the arm that keeps that promise — and it must stay a REFUSAL by name,
   * because a stop routed into any other reason is the regression, not a relabelling.
   */
  | "human-stopped"
  /**
   * A cause this module has no policy for — the exhaustive backstop behind `isResurrectable`.
   *
   * NOT `unknown` any more. It used to be exactly that ("observed, but nothing said why"), back when
   * `unknown` was refused; `unknown` now recovers, at the slowest pace ({@link armsOnSlowestRung}).
   * Nothing reaches this today: every non-resurrectable cause has its own named arm above. It is
   * kept so that a cause added later — declared non-resurrectable and given no arm here — is refused
   * rather than admitted, which is the direction that cannot lose work.
   */
  | "unclassified-death"
  /** A session wall whose stated reset instant has not arrived. */
  | "wall-not-yet-reset"
  /** On the ladder, between rungs. */
  | "waiting-for-next-rung"
  /** The rolling 24h per-agent cap is exhausted. This is the ONLY terminal bound on retrying — the
   *  ladder plateaus rather than ending, so there is deliberately no "ladder-spent". */
  | "daily-cap-spent"
  /** A RESUME-THEN-EXIT LOOP: a clean-resumable mid-task exit (`unknown` + a resume banner) that has
   *  been respawned past {@link MAX_MIDTASK_RESUMES} in the rolling window and is dead AGAIN. Bounded
   *  EARLIER than the daily cap and cause-specific — see {@link decideResurrection} Gate 4b
   *  (sparkle-y5dk8x). Transient, exactly like `daily-cap-spent`: it clears as the window rolls off,
   *  so `resurrectionRunner` must NOT write it down as permanent. */
  | "midtask-loop";

export type ResurrectionDecision =
  | { action: "respawn"; attempt: number }
  | { action: "none"; reason: NoResurrectReason };

export interface ResurrectionInput {
  /** From the durable ledger. `undefined` when no record exists. */
  cause: DeathCause | undefined;
  /**
   * Is the agent's PROCESS still alive?
   *
   * `boolean | undefined`, and the polarity matters: only an explicit `false` permits a respawn.
   * `undefined` means "this window cannot tell", and respawning on a maybe is what orphans a live
   * child — `pty.rs`'s session map REPLACES silently, so the first process keeps running, keeps
   * holding its worktree, keeps burning tokens, and is invisible to every surface.
   */
  processAlive: boolean | undefined;
  /** Epoch ms the wall is expected to lift. Present only for `wall-session`. */
  notBeforeMs: number | undefined;
  /** Respawns already spent on THIS death episode. */
  attemptsThisEpisode: number;
  /** Epoch ms of the last respawn attempt, if any. */
  lastAttemptAt: number | undefined;
  /** Epoch ms the death was recorded — the first rung is measured from here. */
  diedAt: number;
  /** Epoch-ms timestamps of respawns in the rolling window, from the DURABLE ledger. */
  recentAttemptsAt: readonly number[];
  /**
   * POSITIVE evidence that this death is a CLEAN, RESUMABLE STOP — the pane's PTY exited and its
   * viewport still carries Claude Code's `claude --resume <id>` graceful-exit banner
   * (`engineRegistry.resumeBannerForAgent`, sparkle-tab3nm). It lifts an `unknown` death OFF the
   * 30-minute slowest rung onto the normal fast ladder — see {@link armsOnSlowestRung}. Absent /
   * false for every other death, so nothing else changes pace.
   *
   * WHY IT IS SAFE TO SPEED UP HERE and nowhere else in `unknown`: Claude writes that resume line
   * only when it exits on its OWN — a segfault, an OOM-kill or a `pty_kill` prints nothing — so the
   * banner is exactly the witness that separates a session that stopped cleanly (resume almost
   * always works, and a resumed agent then waits on input rather than re-exiting, so it does not
   * fork-bomb) from a silent crash that must stay conservative. The daily cap
   * ({@link MAX_RESURRECTS_PER_AGENT_PER_DAY}) still bounds a pathological resume-then-exit loop and
   * hands it to the concierge when spent.
   */
  cleanResumableStop?: boolean;
  now: number;
}

/**
 * Which causes recover at THE MOST CONSERVATIVE PACE — every attempt on the slowest rung the ladder
 * has, never on the fast ones.
 *
 * This is the second half of the taxonomy fix, and without it the first half is reckless.
 * `deathTypes.isResurrectable` used to refuse `unknown` outright, because a deliberate human stop
 * was recorded as `unknown` and restarting one of those is a wrong action against a stated decision.
 * `human-stopped` now carries the stops, so `unknown` means what it says — but what it says is *"a
 * window watched this exit and had nothing to say about why"*, which is the ONE classification with
 * no theory of the fault behind it. `deathTypes` states the requirement in those words: it "can move
 * to the most conservative pace rather than to a refusal".
 *
 * SO PACE, NOT ELIGIBILITY, IS WHERE THE CAUTION LIVES NOW. A cause with a known, retryable fault
 * behind it (`transport-transient`, a wall lifting, an app restart) has a reason to believe a quick
 * retry works, and the fast rungs are how it gets the founder's agent back in a minute. `unknown`
 * has no such reason: the fault may be a crash loop that re-fails instantly, so a 60s first rung
 * would spend a quarter of the 24-attempt daily budget in the first ten minutes and be out of
 * budget by the time a genuinely transient condition cleared. At the ceiling the same 24 attempts
 * span twelve hours.
 *
 * IMPLEMENTED HERE RATHER THAN AT A CALL SITE, deliberately. A caller that special-cased `unknown`
 * before calling would leave `nextRungDueAt` — which is exported precisely so a surface can say
 * "next try in 3m" — telling every reader the wrong number for the most common cause there is.
 *
 * ── THE ONE ESCAPE HATCH: A CLEAN, RESUMABLE STOP (sparkle-tab3nm) ──────────────────────────────
 * This answers the CAUSE, which is the right default: without any further evidence an `unknown`
 * death may be a silent crash and must recover slowly. But `nextRungDueAt` lifts the penalty when
 * `cleanResumableStop` is set — the pane's PTY exited AND its viewport still shows Claude's
 * `claude --resume <id>` banner, which Claude writes only when it exits on its OWN. That witness
 * distinguishes a graceful, resumable stop (safe to fast-track: resume works, and a resumed agent
 * waits on input rather than re-exiting) from a silent crash, so the fast ladder is applied ONLY
 * to the former. The founder's P0 — a stopped row sitting dead 45+ minutes — is exactly this case.
 */
export function armsOnSlowestRung(cause: DeathCause): boolean {
  // `startup-no-show` joins `unknown` on the slowest rung: a worker that produced no output at all by
  // the startup deadline is the crash-loop shape (the fault likely re-fails instantly on respawn), so
  // the fast rungs would spend a day's retry budget in the first ten minutes for nothing.
  return cause === "unknown" || cause === "startup-no-show";
}

/** When the next rung is due. ALWAYS defined: past the last rung the gap holds at the ceiling, so an
 *  agent waiting on a wall only a human can lift keeps probing. Exported so a caller can show "next
 *  try in 3m" without re-deriving the curve.
 *
 *  `cause` is REQUIRED rather than optional, and that is not pedantry: {@link armsOnSlowestRung}
 *  changes the answer for `unknown` — the single most common cause on the census — so a caller
 *  allowed to omit it would silently get the FAST curve for exactly the population the slow one
 *  exists for. This repo's own name for that shape is the defaulted seam, and it is the one where
 *  the production call site ends up untested by construction. */
export function nextRungDueAt(input: {
  cause: DeathCause;
  attemptsThisEpisode: number;
  lastAttemptAt: number | undefined;
  diedAt: number;
  /** See {@link ResurrectionInput.cleanResumableStop}. A true reading takes an `unknown` death off
   *  the slowest rung and onto the normal fast ladder; every other cause is unaffected. */
  cleanResumableStop?: boolean;
}): number {
  // The slowest-rung penalty applies to `unknown` ONLY when there is no positive clean-stop witness.
  // A resume banner (`cleanResumableStop`) means Claude exited on its own and is safe to resume fast
  // — see {@link armsOnSlowestRung} and {@link ResurrectionInput.cleanResumableStop}.
  const slowest = armsOnSlowestRung(input.cause) && !input.cleanResumableStop;
  const gap = slowest
    ? RESURRECT_LADDER_CEILING_MS
    : (RESURRECT_LADDER_MS[input.attemptsThisEpisode] ?? RESURRECT_LADDER_CEILING_MS);
  // Gaps are measured from the LAST attempt, or from the death itself for the first rung — the same
  // convention `REVIVE_LADDER_MS` documents, so the two read alike.
  return (input.lastAttemptAt ?? input.diedAt) + gap;
}

/** Respawns inside the rolling 24h window. Counted here rather than by the caller so the window
 *  edge is defined in one place. */
export function attemptsInWindow(recentAttemptsAt: readonly number[], now: number): number {
  const floor = now - RESURRECT_DAY_MS;
  return recentAttemptsAt.filter((t) => t > floor).length;
}

/**
 * Decide whether to respawn one dead agent.
 *
 * GATE ORDER IS THE POLICY. Terminal classifications are checked FIRST — before liveness, before
 * rungs, before caps — so that "it finished" or "a person is waiting" never surfaces as
 * "waiting-for-next-rung", and never spends a rung it should not have. Same discipline
 * `decideContinuation` uses for its quota gate.
 */
export function decideResurrection(input: ResurrectionInput): ResurrectionDecision {
  const { cause } = input;

  // ── 1. Terminal, before anything else can mask them ─────────────────────────────────────────
  if (cause === undefined) return { action: "none", reason: "no-death-record" };
  if (cause === "clean-goal-met") return { action: "none", reason: "clean-goal-met" };
  if (cause === "blocked-on-human") return { action: "none", reason: "blocked-on-human" };
  // THE ARM THAT PAYS FOR `unknown` BECOMING RESURRECTABLE. A stop is a stated human decision, and
  // this module has always ranked a wrong action above a missed recovery. Named rather than folded
  // into the backstop below so a log reader — and a test — can see the refusal happen for the right
  // reason instead of by accident of exhaustiveness.
  if (cause === "human-stopped") return { action: "none", reason: "human-stopped" };
  if (!isResurrectable(cause)) return { action: "none", reason: "unclassified-death" };

  // ── 2. Liveness, failing CLOSED ─────────────────────────────────────────────────────────────
  // Only an explicit `false` gets past. This is the mirror of `decideRevive`'s gate, and the pair of
  // them is what keeps this module and apiRecovery from ever acting on the same agent.
  if (input.processAlive !== false) return { action: "none", reason: "already-live" };

  // ── 3. The wall's own clock ─────────────────────────────────────────────────────────────────
  // Only `wall-session` names an instant. A spend cap has none and must never be gated on one — it
  // is recovered by PROBING, which is why it falls straight through to the ladder below and comes
  // back by itself the moment a probe succeeds.
  if (armsOnClock(cause) && input.notBeforeMs !== undefined && input.now < input.notBeforeMs) {
    return { action: "none", reason: "wall-not-yet-reset" };
  }

  // ── 4. Caps. The durable one first, so a misidentified episode cannot outrun it ──────────────
  if (attemptsInWindow(input.recentAttemptsAt, input.now) >= MAX_RESURRECTS_PER_AGENT_PER_DAY) {
    return { action: "none", reason: "daily-cap-spent" };
  }

  // ── 4b. The resume-then-exit loop, bounded EARLY and cause-specific (sparkle-y5dk8x) ─────────
  // A clean, resumable mid-task exit (`unknown` + a resume banner) that has ALREADY been respawned
  // MAX_MIDTASK_RESUMES times in the rolling window and is dead AGAIN is a loop that will not
  // converge. The per-episode ladder below cannot see it — each exit is a fresh episode, so its
  // per-episode count is ~1 every cycle — which is why this is counted over the SAME rolling window
  // as the daily cap, and refused far below that cap so a human is told while there is still work to
  // save. Gated on the clean-resume shape ALONE: a wall recovers by probing and legitimately needs
  // all 24 attempts, so this must never shorten its budget. Kept BELOW the daily-cap gate so a fully
  // spent loop still surfaces as the stronger `daily-cap-spent`.
  if (
    cause === "unknown" &&
    input.cleanResumableStop === true &&
    attemptsInWindow(input.recentAttemptsAt, input.now) >= MAX_MIDTASK_RESUMES
  ) {
    return { action: "none", reason: "midtask-loop" };
  }

  // ── 5. The ladder, which plateaus rather than ending ────────────────────────────────────────
  // `cause` is spread back in NARROWED — the gates above have eliminated `undefined`, and
  // `nextRungDueAt` requires a real cause because the pace depends on it.
  if (input.now < nextRungDueAt({ ...input, cause })) {
    return { action: "none", reason: "waiting-for-next-rung" };
  }

  return { action: "respawn", attempt: input.attemptsThisEpisode + 1 };
}
