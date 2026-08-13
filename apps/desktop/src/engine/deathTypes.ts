// deathTypes — the shared vocabulary for WHY an agent session ended, and the one rule that keeps a
// verdict honest.
//
// ── THE FAILURE THIS CLOSES ───────────────────────────────────────────────────────────────────
// Nothing in this app can tell a transient death from a permanent one, so nothing can safely bring
// an agent back. That gap is stated outright in the fleet-handoff retrospective, which declined to
// propose auto-resurrection for exactly this reason: "a transient death and a permanent one are not
// distinguishable today; auto-restart without that distinction risks looping on a real fault."
//
// Measured on the founder's machine:
//   • 2026-08-06 18:20 PT — 54 SessionEnd in ONE minute (the app quit); 45 resumed at 18:21; 49 more
//     died at 18:47 and exactly 1 came back. App restart is the largest single killer of agents.
//   • 2,273 account-wall records across 1,102 distinct sessions since 2026-07-01. One session retried
//     into a closed door 45 times; 79 retried 5+ times.
//
// ── THE TWO WALLS ARE NOT ONE WALL ────────────────────────────────────────────────────────────
// `You've hit your session limit · resets 10:30pm (America/Los_Angeles)` clears on a stated clock.
// `You've hit your monthly spend limit · raise it at claude.ai/settings/usage` clears when a HUMAN
// raises it — there is no reset instant and never will be. Treating them alike is how a fleet burns
// its retries against a door only a credit card opens. They are separate causes here, and the
// discriminator is NOT a new regex: `QuotaBlock.resetParsed === false` already reports it, by exact
// comparison against `parseResetInstant`'s documented fallback expression.
//
// ── NO MODEL CALL, EVER, ON ANY PATH THAT READS THESE ─────────────────────────────────────────
// When the wall is fleet-wide, every LLM in the app is gated by the SAME account limit: the
// concierge is a `claude -p` child, `turnFollowup` runs a Haiku judge, `claude_oneshot` is a model
// call. Each is dead precisely when recovery is needed. `src-tauri/src/nudger.rs` is the precedent —
// "NO model call on ANY path... a plain OS thread in the Rust process rather than in the WebView" —
// and every consumer of this vocabulary inherits that constraint.
//
// PURE. Types and one total function. No I/O, no clock, no state.

/**
 * How long an API-error banner stays admissible as evidence for a death that follows it.
 *
 * ── THE MEASUREMENT THIS NUMBER IS SIZED AGAINST ──────────────────────────────────────────────
 * Claude Code does not print a banner and exit. It RETRIES, for minutes, and only then gives up.
 * Measured directly (2026-08-08) by running a real `claude` against a non-resolving
 * `ANTHROPIC_BASE_URL`: it retried for **2m56s (176s)** and then exited 1, with this as its final
 * line of output — the banner IS the last thing printed before the PTY closes:
 *
 *     API Error: Unable to connect to API (ENOTFOUND)
 *
 * Against a local endpoint returning HTTP 529 it backs off ~38s per rung and stays up longer still.
 *
 * ── WHY A WINDOW IS NEEDED AT ALL ─────────────────────────────────────────────────────────────
 * Those retries emit exactly the signals `StatusEngine.clearStreamFailure()` treats as recovery — a
 * classified tool event, a re-drawn prompt, a token advance — so `lastFailure` is nulled by the
 * retry loop and is very often GONE by the time the PTY closes. Whether the banner survives to
 * `exit()` is a race against the last retry, and the census says it loses: of 76 agent-life records
 * on the founder's v0.95.0 install, **zero** are `transport-transient` while 25 are `unknown` with
 * evidence `pty-exit` — and `isResurrectable` refused `unknown` at the time, so all 25 were
 * structurally outside recovery. (That refusal is gone; see {@link isResurrectable}. This window
 * still matters, because `transport-transient` recovers on the FAST rungs and `unknown` on the
 * slowest — classifying honestly is what buys the difference.) The banner has to be RETAINED past
 * the recovery signal, and a retained banner has to
 * expire or it becomes a permanent stamp of the last bad turn.
 *
 * ── WHY 5 MINUTES ────────────────────────────────────────────────────────────────────────────
 * It must comfortably exceed the retry sequence, or the fix does not fire at all: anything at or
 * below the measured 176s can be outlived by the very loop it exists to see past. 300s is ~1.7× that
 * with headroom for the slower 529 ladder, and is still far short of any interval over which an
 * agent could plausibly print a banner, fully recover, work, and then die of something unrelated —
 * and even that case is already outranked by the gates above `transport-transient` (a met goal, a
 * wall, a blocking tool), which is what makes erring long the cheap direction here.
 */
export const TRANSPORT_FAILURE_WINDOW_MS = 300_000;

/**
 * Why an agent session ended.
 *
 * Kept deliberately small: each variant exists because it demands a DIFFERENT action, not because it
 * describes a different feeling. If two causes would be handled identically they should be one cause.
 */
export type DeathCause =
  /** A recoverable vendor/network fault — ENOTFOUND, 529, 5xx, a stalled stream. Retry on a ladder. */
  | "transport-transient"
  /** An account session window closed. It reopens at a stated instant; wait, then verify. */
  | "wall-session"
  /** A monthly spend cap. There is NO reset instant — only a human raises it. Never wait on a clock. */
  | "wall-spend"
  /** The agent marked its goal MET and exited. Never resurrect this, under any circumstance. */
  | "clean-goal-met"
  /** The agent stopped on a real question for a person. Resurrecting it re-asks nothing; escalate. */
  | "blocked-on-human"
  /** The app process that owned this agent is gone and wrote no close. Inferred, never observed. */
  | "app-restart"
  /**
   * THIS agent's process vanished while the app kept running, and no window saw it go.
   *
   * Written only by `agent_life::reap_dead_sessions_at`, from the absence of a PTY session under a
   * still-live epoch. Distinct from `app-restart` (the whole app died; keyed on a dead epoch) and
   * from `unknown` (a window WATCHED the exit and had nothing to say).
   *
   * Resurrectable — as `unknown` now is too, so the asymmetry this comment used to argue for is
   * gone. It was a workaround: `unknown` refused because a human clicking stop was recorded as
   * `unknown`, and this cause escaped the refusal by being reachable ONLY when nothing observed the
   * exit — the one case a deliberate stop cannot produce. It was "the distinct cause sourced from
   * the app's own liveness" the {@link isResurrectable} comment asked for, from the other side.
   * `human-stopped` is now that cause from the intended side, so the two are simply both eligible.
   *
   * It still earns its own name: `process-gone` is an inference from an ABSENCE with no observer,
   * which is a different fact from `unknown`'s "a window watched and had nothing to say" — and the
   * two now recover at different PACES (see `resurrection.armsOnSlowestRung`), so collapsing them
   * would slow every reaped agent to the 30-minute rung for no reason.
   */
  | "process-gone"
  /**
   * A PERSON DELIBERATELY STOPPED THIS AGENT — written by the app's own stop path, never inferred.
   *
   * The one cause sourced from an ACTION rather than from an observation: `pty_kill` calls
   * `agent_life::mark_stopped_at`, so the record says "we did this on a human's instruction"
   * instead of "the PTY closed and we have no idea why". Never resurrectable, and it is the reason
   * `unknown` no longer has to be — see {@link isResurrectable}.
   */
  | "human-stopped"
  /** Nothing was observed. A first-class, honest value — NOT a synonym for "healthy" or "fine". */
  | "unknown";

/**
 * WHAT WAS ACTUALLY SEEN. Not decoration — this is the field that keeps a record from claiming
 * knowledge it does not have.
 *
 * The window-local registries (`engineRegistry.quotaBlockForAgent`, `.lastFailureForAgent`) return
 * `undefined` for BOTH "this agent is healthy" and "no pane for it in this window". A verdict derived
 * from that ambiguity without recording its provenance is indistinguishable from a guess. Carrying
 * the evidence makes the guess impossible to state.
 */
export type DeathEvidence =
  /** `quotaBlock.quotaBlocksIn` matched the agent's own output. */
  | "quota-block"
  /** The structured `{"error":"rate_limit","isApiErrorMessage":true}` transcript envelope. Survives
   *  the app dying, because Claude Code writes it, not us. */
  | "transcript-429"
  /** `apiRecovery.classifyApiFailure` returned "retryable" for a banner the agent printed. */
  | "api-banner"
  /** A `PreToolUse` hook for `AskUserQuestion` or `ExitPlanMode` — the ONLY sound blocked-on-human
   *  signal. The string "Claude is waiting for your input" is an ANTI-signal: it is a benign idle
   *  ping ~60s after Stop, and keying on it marks finished agents as blocked. */
  | "blocking-tool"
  /** `agentGoal.markGoalMet` recorded a positive `metAt`. A turn merely ENDING is not this. */
  | "goal-met-marked"
  /** `goalExpiry` discharged the goal: GIT proved the work is contained in the default branch and
   *  the tree is clean, recorded as `dischargedAt` with both proving shas. Distinct from
   *  `goal-met-marked` because the claimant differs — that one is the agent's assertion about
   *  itself, this one is evidence about its branch — and a reader deciding whether to resurrect
   *  should be able to tell which it has. Both mean FINISHED. */
  | "goal-discharged-on-git-proof"
  /** The owning app instance's epoch is provably dead (a kernel-released lock, not a timeout). */
  | "epoch-dead"
  /**
   * The agent's PTY session was absent from the app's own session map while its epoch was still
   * alive — read by `agent_life::reap_dead_sessions_at` on the revival tick.
   *
   * Distinct from `"pty-exit"`, which means a WINDOW watched the PTY close. This is an inference
   * from an ABSENCE, made with no observer, and it is the only evidence that supports
   * `"process-gone"`. Sharing `"pty-exit"` would have made `verdictIsSupported` false for every
   * record the reaper writes — the invariant stated but untrue (roborev 61705).
   */
  | "session-vanished"
  /**
   * THE APP ITSELF KILLED THE PTY, on a human's instruction — `pty_kill` → `mark_stopped_at`.
   *
   * Distinct from `"pty-exit"`, and the distinction is the whole of this change. Both describe a
   * closed PTY that a window watched; only this one knows WHO closed it. `"pty-exit"` is what a
   * window sees from the outside and is compatible with every cause there is, which is why it
   * supports only `"unknown"`; this is written from INSIDE the stop path, before the close, by the
   * code that performed it. Nothing infers it, so nothing can mistake a crash for it.
   */
  | "user-stop"
  /** The PTY ended, or a SessionEnd hook landed, with nothing else to say about why. */
  | "pty-exit"
  | "session-end-hook"
  /** Nothing was observed at all. Forces `cause: "unknown"` — see {@link causeOf}. */
  | "none";

/** A wall the agent hit, carried INDEPENDENTLY of {@link DeathCause}.
 *
 *  Orthogonal on purpose. An agent that hit a session limit at 18:19 and then died to the app quit at
 *  18:20 has BOTH facts true, and recovery needs both: resurrect *because the app died*, but *not
 *  before the reset*. Collapsing them into one field loses whichever is written second. */
export interface DeathWall {
  /** VERBATIM, byte for byte. Cohort correlation keys a Map on exact equality — a shared-outage
   *  report has already silently never fired because two agents' bytes differed by a newline. */
  message: string;
  /** Epoch ms the wall is expected to lift. ABSENT when {@link resetParsed} is false: persisting a
   *  bounded-recheck fallback as a reset instant converts a re-check into a claim about billing. */
  resetAt?: number;
  /** Did the message actually NAME a reset time? False is the spend-cap signal. */
  resetParsed: boolean;
  /** When the wall was observed. */
  observedAt: number;
}

/** A classification, plus the evidence that produced it. */
export interface DeathVerdict {
  cause: DeathCause;
  evidence: DeathEvidence;
  /** The terminating message VERBATIM, when there was one. Never normalized. */
  message?: string;
  wall?: DeathWall;
  /** Required when `cause === "clean-goal-met"`; its absence makes that cause unjustifiable. */
  goalMetAt?: number;
}

/**
 * The cause a given evidence can support ON ITS OWN, or `null` when the evidence is compatible with
 * more than one and a caller must supply the discriminator.
 *
 * TOTAL over {@link DeathEvidence}. This is the invariant in executable form: a verdict may never
 * carry a cause its evidence cannot support, and `"none"` can support only `"unknown"`. Enforced at
 * the persistence boundary as well as here, so a record written by any path obeys it.
 *
 * `"quota-block"` and `"transcript-429"` return `null` because the session/spend split comes from
 * `resetParsed`, which lives on the observation rather than in the evidence tag.
 */
export function causeOf(evidence: DeathEvidence): DeathCause | null {
  switch (evidence) {
    case "quota-block":
    case "transcript-429":
      return null; // "wall-session" | "wall-spend", split by DeathWall.resetParsed
    case "api-banner":
      return "transport-transient";
    case "blocking-tool":
      return "blocked-on-human";
    case "goal-met-marked":
    case "goal-discharged-on-git-proof":
      return "clean-goal-met";
    case "epoch-dead":
      return "app-restart";
    case "session-vanished":
      return "process-gone";
    case "user-stop":
      return "human-stopped";
    case "pty-exit":
    case "session-end-hook":
      return "unknown";
    case "none":
      return "unknown";
  }
}

/** Does `verdict` satisfy the evidence rule? Used as a boundary check, and as the thing a test can
 *  assert exhaustively rather than case by case. */
export function verdictIsSupported(verdict: DeathVerdict): boolean {
  if (verdict.evidence === "none" && verdict.cause !== "unknown") return false;
  if (verdict.cause === "clean-goal-met" && verdict.goalMetAt === undefined) return false;
  if (verdict.cause === "wall-spend" && verdict.wall?.resetAt !== undefined) return false;
  const only = causeOf(verdict.evidence);
  if (only === null) return verdict.cause === "wall-session" || verdict.cause === "wall-spend";
  return only === verdict.cause;
}

/**
 * May this cause EVER be brought back automatically?
 *
 * The two `false` answers are the load-bearing ones and they are false for opposite reasons:
 * `clean-goal-met` because the agent finished and resurrecting it would undo a completed decision;
 * `blocked-on-human` because a person, not a process, is the thing it is waiting on.
 *
 * `wall-spend` is TRUE — and this is the correction that matters. It cannot be resurrected on a
 * CLOCK (there is no reset), but it is resurrected by PROBING: the fleet keeps testing the door on a
 * bounded backoff and comes back the moment a probe succeeds. Telling the founder is a byproduct, so
 * he can shorten the outage; it is never what the system waits on.
 *
 * ── WHY `unknown` IS NOW TRUE — THE TAXONOMY GAP IS CLOSED ────────────────────────────────────
 * This function refused `unknown` until 2026-08-13, and the refusal was never about `unknown`. It
 * was about ONE cause wearing two meanings: `mark_stopped_at` — the ledger half of "a person clicked
 * stop" — wrote `{cause: unknown, evidence: pty-exit}`, on the reasoning that "`unknown` needs no new
 * vocabulary". So a deliberate stop and an unexplained crash were the SAME record, and the only
 * policy that is safe over that union is the conservative one: refuse. The earlier version of this
 * comment said as much and named the fix — "a distinct `human-stopped` cause sourced from the app's
 * own stop path; once that exists, `unknown` genuinely does mean 'we do not know' and can move to
 * the most conservative pace rather than to a refusal."
 *
 * {@link DeathCause.human-stopped} is that cause, and `"user-stop"` is its evidence. A stop is now
 * recorded as a stop, by the code that performs it, BEFORE the PTY closes — so it is not inferred
 * and cannot be confused with anything. `unknown` is therefore free to mean what it says.
 *
 * WHAT IT COST TO LEAVE IT FALSE, measured on the founder's v0.95.0 install: 25 of 76 agent-life
 * records were `unknown`/`pty-exit` and 0 were `transport-transient`, so essentially EVERY
 * unexplained death was structurally outside recovery — permanently, with the row painting red at a
 * human who could do nothing about it. His words: *"there's nothing I can do to resolve this. So why
 * am I seeing this?"* A dead session is blocked on a RESTART, not on a person.
 *
 * TRUE HERE IS NOT "TREAT IT LIKE A KNOWN FAULT". `unknown` recovers on the SLOWEST rung available
 * and never on the fast path — see `resurrection.armsOnSlowestRung`, which is where the "most
 * conservative pace" half of that sentence is implemented. This function answers ELIGIBILITY; the
 * pace is a separate question and a separate answer.
 *
 * The two remaining `false` answers are unchanged and are false for opposite reasons — see the head
 * of this comment — and `human-stopped` joins them for a third: the human already decided.
 */
export function isResurrectable(cause: DeathCause): boolean {
  switch (cause) {
    case "transport-transient":
    case "wall-session":
    case "wall-spend":
    case "app-restart":
    case "process-gone":
    case "unknown":
      return true;
    case "clean-goal-met":
    case "blocked-on-human":
    case "human-stopped":
      // `human-stopped` is an explicit human decision. Restarting it would be a wrong ACTION
      // against a stated one, which this module has always ranked strictly worse than a missed
      // recovery. (The note lives in the body rather than between the labels: a comment sitting
      // between two case labels is what `no-fallthrough` reports, and it is an ERROR in this
      // package's lint gate — it went red in CI written the other way.)
      return false;
  }
}

/**
 * May recovery arm on a CLOCK for this cause, or must it probe?
 *
 * Only `wall-session` names an instant. Everything else that is resurrectable either retries
 * immediately on a ladder or probes, and neither needs date arithmetic — which is why the Rust
 * revival thread can be a pure integer comparison with no date/time crate.
 */
export function armsOnClock(cause: DeathCause): boolean {
  return cause === "wall-session";
}
