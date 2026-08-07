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
  /** The owning app instance's epoch is provably dead (a kernel-released lock, not a timeout). */
  | "epoch-dead"
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
      return "clean-goal-met";
    case "epoch-dead":
      return "app-restart";
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
 * ── WHY `unknown` IS FALSE, DELIBERATELY (roborev 60067 / 60061 argued for TRUE) ───────────────
 * The review's case is real and worth stating fairly: `pty-exit` and `session-end-hook` are the most
 * common observations there are, both map to `unknown`, so a false here means most deaths never
 * recover — "today's behaviour restated as a contract".
 *
 * It is still false, for a reason the review did not weigh: **a human deliberately stopping an agent
 * produces exactly that observation.** A clean PTY exit with no error banner, no wall and no met
 * goal is indistinguishable, from here, from a person clicking stop. Making `unknown` resurrectable
 * would have the fleet restart agents their owner just killed — a wrong action against an explicit
 * human decision, which is strictly worse than the missed recovery it would buy.
 *
 * This is a gap in the TAXONOMY, not a policy to invert. The right fix is a distinct `human-stopped`
 * cause sourced from the app's own stop path; once that exists, `unknown` genuinely does mean "we do
 * not know" and can move to the most conservative pace rather than to a refusal. Until then the
 * refusal stays, and it is the one place this module chooses a missed recovery over a wrong action.
 */
export function isResurrectable(cause: DeathCause): boolean {
  switch (cause) {
    case "transport-transient":
    case "wall-session":
    case "wall-spend":
    case "app-restart":
      return true;
    case "clean-goal-met":
    case "blocked-on-human":
    case "unknown":
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
