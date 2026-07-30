// apiRecovery (sparkle-onzu) — "the vendor failed mid-turn, so retry it on a ladder instead of
// leaving a red row for a human to notice."
//
// THE FAILURE THIS CLOSES. Anthropic returns 529/500 in bursts. Claude Code prints the banner, the
// turn ends, and the agent sits there having done nothing — for as long as it takes a human to look.
// The founder's framing (2026-07-29): "Anthropic often has five twenty nines. And we need to do
// better at recovering from those… I want to just build basically intelligence around you being good
// at getting these agents to revive themselves."
//
// WHY THIS IS APP CODE AND NOT THE CONCIERGE. The founder described the concierge doing the pinging.
// It cannot, for two independent reasons, and the second is the decisive one:
//
//   1. services/conciergeProactive caps it at PROACTIVE_MAX_PER_HOUR = 6 turns/hour behind a
//      PROACTIVE_MIN_INTERVAL_MS = 2-minute floor. A ladder whose first rung is 5 SECONDS is not
//      expressible inside that budget, and raising the budget to fit would turn a chief of staff
//      into a pager.
//   2. THE CONCIERGE DIES IN THE SAME OUTAGE. It is an ordinary `claude -p` call against the same
//      API, so the event it is supposed to respond to is the event that silences it. Observed
//      directly on the day this was written: the concierge's own transcript carries 17 API-error
//      turns, and all three research subagents dispatched while designing this module were killed by
//      529s mid-flight. A recovery mechanism that shares a failure domain with the thing it
//      recovers is not a recovery mechanism.
//
// So the retry loop is deterministic, needs no model call, and costs nothing while idle. The
// concierge's job moves to REPORTING it (one push: "retried X five times over four minutes, still
// 529"), which is what it is actually good at and what its rate limit is sized for.
//
// PURE. `decideRevive` is data-in-data-out — clock, status, attempt count and liveness all arrive as
// parameters — so every rule below is tested as arithmetic rather than by waiting out a real ladder.
// The mount that performs the PTY write lives in services/apiRecoveryRunner.
import type { AgentTabStatus } from "@sparkle/ui";
import { stripMarkers } from "./streamFailure";

// ── Classifying the failure ───────────────────────────────────────────────────────────────────────
// Not every red API banner is worth retrying, and getting this wrong is expensive in both
// directions: pinging a spend cap burns the whole ladder against a wall that will not move, while
// declining to ping a 529 is the stall this module exists to abolish.

/** What kind of API failure a banner represents.
 *
 *  `retryable` — the vendor is transiently unable to serve the request (5xx, overload, a temporary
 *  server-side request limit). Time alone fixes these, which is exactly what a ladder buys.
 *
 *  `terminal` — the ACCOUNT is out of something (session window, spend cap). No number of retries
 *  changes it; only the clock rolling over or a human raising a limit does. These escalate straight
 *  to the human, and must never consume a rung. */
export type ApiFailureClass = "retryable" | "terminal";

/**
 * ACCOUNT-EXHAUSTION lines, which are TERMINAL. Claude Code writes these as its own message text
 * (not behind an "API Error:" prefix). The two real shapes, both observed on this machine on
 * 2026-07-29 — note the distinctive TAIL, which is the load-bearing part:
 *
 *     You've hit your session limit · resets 8:40am (America/Bogota)
 *     You've hit your monthly spend limit · raise it at claude.ai/settings/usage
 *
 * REQUIRING THE TAIL, not just the "You've hit your …" opener (roborev 55422). A line-initial
 * anchor alone matches a QUOTE of the banner — which appears in this module's own docstring, in its
 * tests, in `services/rateLimitWatch`'s header, and in any agent write-up of this feature. That is
 * not a cosmetic false positive: see the inverted fail direction on {@link classifyApiFailure} for
 * what a wrong `terminal` costs. The `·`-plus-`resets`/`raise it at` tail is what an agent
 * PARAPHRASING or partially quoting the message does not reproduce, and paraphrase is the
 * overwhelmingly common shape.
 *
 * RESIDUAL, stated plainly because it cannot be fixed from text: a PERFECT verbatim quote of a full
 * banner line — tail included — is textually identical to the real thing and still classifies
 * `terminal`. `services/rateLimitWatch`'s header records the real fix and why Phase 1 of that
 * feature had to be abandoned: read the structured transcript envelope (`isApiErrorMessage`,
 * `apiErrorStatus`, `error === "rate_limit"`), which prose can never forge, rather than scraping
 * text. That envelope is already parsed in-repo per account. Doing the same here is tracked as a
 * follow-up on bead `sparkle-onzu`; this pattern is the interim tightening, not the destination.
 *
 * The apostrophe is a class because the TUI may render a typographic ' where the source has '.
 */
// SPLIT INTO OPENER + TAIL, tested independently and NOT required to be adjacent (roborev 55447).
// The first version demanded `·` immediately after the word "limit" on one physical line, and that
// broke on the shape these lines actually arrive in. `services/terminalScrollback` serializes one
// string per xterm BUFFER ROW (`getLine(i).translateToString(true)`), i.e. hard-wrapped at the pane's
// column width — and Sparkle runs agents in narrow grid panes. A ~62-char banner therefore arrives as
// two rows:
//
//     ⏺ You've hit your session limit ·
//     resets 8:40am (America/Bogota)
//
// Neither row matched: the first lost the tail, the second lost the opener. That was strictly worse
// than no tightening at all — a real spend cap either fell through to an older "API Error: 529" and
// classified RETRYABLE (eleven prompts against a wall, ending in the false "the outage is outlasting
// the ladder"), or classified null and produced NO ping and NO escalation whatsoever.
// {@link classifyFromScrollback} also joins adjacent rows before testing, because unwrapping is the
// other half of this fix.
const ACCOUNT_LIMIT_OPENER = /^you['’´`]?ve hit your\b[^\n]*\blimit\b/i;

// The tail, allowed ANYWHERE in the (possibly unwrapped) line rather than glued to "limit", so
// "You've hit your usage limit for Opus · resets 3pm" is caught too. Separator variants accepted
// because pinning U+00B7 exactly makes a single glyph substitution silently disable the whole check.
const ACCOUNT_LIMIT_TAIL = /(?:·|•|\||—|-)\s*(?:resets\b|raise it at\b)/i;

/**
 * ANY banner Claude Code prints for a failed request, tested only after the account-limit shapes
 * above have declined.
 *
 * THIS REPLACED A FIVE-PATTERN WHITELIST (roborev 55447), and the replacement is a simplification
 * that also makes this module's stated fail-direction TRUE. The whitelist matched 5xx, "overloaded",
 * "internal server error", "temporarily limiting requests" and "rate limited", defaulting everything
 * else to `null` — while the contract note below claimed ambiguous vendor failures lean `retryable`.
 * They did not. The concrete casualty: `API Error: 429 rate_limit_error`, a banner this repo already
 * uses as a real example elsewhere and the commonest transient shape after 529, matched nothing
 * (`5\d{2}` misses 429, `rate limited` misses `rate_limit_error`) and therefore spent ZERO rungs —
 * the exact stall this module exists to end.
 *
 * So the rule is now the one the docs describe: if Claude Code printed a request-failure banner and it
 * is not a proven account limit, retry it. That follows directly from the asymmetry argued on
 * {@link classifyApiFailure} — a wrong `retryable` costs eleven prompts that immediately re-error, a
 * wrong `terminal` costs a false billing claim and hours of stall — and it removes a list that had to
 * be extended every time Anthropic invented a status code.
 *
 * The one real string that made ORDER load-bearing is still handled by ordering alone:
 *
 *     API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited
 *
 * It contains "usage limit" while explicitly saying it is not one. It cannot reach the account-limit
 * branch because that requires the line to OPEN with "You've hit your", so the shapes stay disjoint
 * rather than merely ordered — and it lands here, retryable, which is correct.
 */
const API_BANNER_PATTERN = /^api error\s*:/i;

/**
 * Classify one CLEANED, MARKER-STRIPPED banner line; null when it is not an API failure at all.
 *
 * Takes the line already stripped of the TUI's "⏺ " marker, because that is what the caller has:
 * `streamFailure.apiErrorFramesIn` returns marker-free frames precisely so downstream consumers do
 * not each re-implement the stripping (and re-acquire the bug where a banner behind a glyph reads as
 * no banner at all).
 *
 * WHICH WAY THIS FAILS, and why it is NOT symmetric (revised per roborev 55422).
 *
 * The two mistakes cost wildly different amounts, so the ambiguous cases lean toward `retryable`:
 *   • A wrong `terminal` is EXPENSIVE. It escalates immediately, asserts to the user's face that
 *     they are out of session window or spend — a claim about their BILLING that may be flatly
 *     false — and consumes ZERO rungs, so the row sits red for hours exactly as it did before this
 *     module existed. It reproduces the very stall this feature exists to end.
 *   • A wrong `retryable` is CHEAP. Eleven app-authored prompts land on an agent that immediately
 *     re-errors; nothing is corrupted, and the ladder's own bound ends it inside two hours.
 *
 * So `terminal` must EARN its verdict (the tail requirement on {@link ACCOUNT_LIMIT_PATTERN}), and
 * everything else that still looks like a vendor failure is treated as retryable.
 *
 * A line that is not an API failure at all still returns `null`, and `decideRevive` refuses to ping
 * on null — typing into a live terminal is irreversible, so an unrecognised line is never a licence
 * to act. The row is RED in every one of these cases regardless: classification governs whether we
 * RETRY, never whether we ALARM.
 */
export function classifyApiFailure(line: string): ApiFailureClass | null {
  const s = line.trim();
  // Terminal must EARN it: the opener AND the tail, the latter anywhere in the line.
  if (ACCOUNT_LIMIT_OPENER.test(s) && ACCOUNT_LIMIT_TAIL.test(s)) return "terminal";
  if (API_BANNER_PATTERN.test(s)) return "retryable";
  return null;
}

/** How many trailing lines of scrollback {@link classifyFromScrollback} considers. The banner that
 *  ended the turn is within a handful of lines of the bottom; looking further back is how a banner
 *  from a PREVIOUS, already-recovered episode gets mistaken for the current one. */
export const SCROLLBACK_SCAN_LINES = 40;

/**
 * Classify the failure that ended the CURRENT turn, from the tail of an agent's scrollback.
 *
 * Scans backwards and returns the FIRST (i.e. most recent) line that classifies, which matters when
 * both shapes are present: an agent that burned through its session limit and later hit a 529 should
 * be judged on the 529 it is actually sitting on, not on the older wall.
 *
 * WHY NOT `streamFailure.apiErrorFramesIn`, which the status path already uses: that function is
 * anchored to "API Error:" by design, and the TERMINAL shape does not carry that prefix — Claude Code
 * writes "You've hit your session limit · resets 8:40am" as its own message text. Reusing it here
 * would therefore find every retryable banner and NO terminal one, i.e. it would silently classify
 * every account-exhaustion episode as retryable and ping a spend cap eleven times. Marker glyphs are
 * stripped locally for the same reason that function strips them (the banner wears a "⏺ ").
 *
 * WHY THE SHARED STRIPPER'S EXCLUSION OF `⎿` MATTERS *HERE*, and not just as a false-red concern over
 * in streamFailure (roborev 55467 — this rationale was dropped once and is restored).
 *
 * Because this scan returns the FIRST line that classifies while reading BACKWARDS, the LOWEST
 * classifying line wins. A tool result containing "API Error: 529" — a `curl` against a failing
 * endpoint, a tailed log, an agent debugging this very module — sits BELOW the genuine "You've hit
 * your session limit · resets …" banner that actually ended the turn. If `⎿` were stripped, that
 * result line would classify `retryable` and win the scan, inverting the verdict on a real spend cap
 * into eleven pings. `stripMarkers` leaves `⎿` alone, so `^api error:` cannot anchor there, the scan
 * walks past it, and the limit banner is reached. Pinned by test; re-adding `⎿` to the marker class
 * (the glyph has already flip-flopped twice) is what fails it.
 *
 * ⚠️ THAT COVERS THE RESULT **HEAD** ONLY — do not read it as an invariant (roborev 55485 caught this
 * comment overclaiming exactly that). The TUI marks only the FIRST row of a tool result with `⎿`;
 * continuation rows are plain indented text, and the strip trims leading whitespace before anchoring.
 * So a bare-indented "API Error: 529 …" on row 2 of a multi-line result DOES win the scan over a real
 * limit banner above it. Pinned by test, asserting today's `retryable`.
 *
 * That residual's harm lands on the CHEAP side of the asymmetry stated above, which is why it is
 * recorded rather than rushed: it inverts `terminal` → `retryable`, i.e. eleven bounded prompts and a
 * mis-worded escalation — not the expensive direction (a false billing claim with zero rungs spent).
 * Closing it means skipping rows that belong to an open tool-result block, the same block-tracking
 * `streamFailure`'s header proposes; unlike over there it would be fail-SAFE here, since a genuine
 * banner is an ASSISTANT message and wears `⏺`, never `⎿`. Tracked on bead `sparkle-onzu`.
 *
 * Pure — the caller supplies the scrollback.
 */
export function classifyFromScrollback(scrollback: string): ApiFailureClass | null {
  const lines = scrollback.split(/[\r\n]/);
  const tail = lines.slice(Math.max(0, lines.length - SCROLLBACK_SCAN_LINES));
  for (let i = tail.length - 1; i >= 0; i--) {
    // streamFailure's OWN stripper, imported rather than reimplemented (roborev 55440). A local
    // single-`replace` copy used to live here claiming to match it "exactly"; it did not, because that
    // one handled repeats. On "⏺ ⏺ API Error: 529" — a redraw leaving two markers, which `⏺+` does not
    // collapse across the space — the copy left a glyph behind, this function returned null, and the
    // runner refused with "unclassified-failure" and spent ZERO rungs, while streamFailure had already
    // painted the row red. Red row, no retry: the exact split this module exists to prevent. That
    // stripper is now a single unbounded pass, so ANY marker count strips (roborev 55467).
    const line = stripMarkers(tail[i] ?? "");
    // UNWRAP (roborev 55447). These are xterm buffer ROWS, hard-wrapped at the pane's column width, so
    // a banner wider than a narrow pane is split across two of them and NEITHER half classifies — the
    // account-limit opener lands on one row and its "· resets …" tail on the next. Test the row joined
    // with the following one as well as alone. Joined SECOND so an already-complete line is judged on
    // its own first, and only the immediately-next row is used: a wrap continues on the very next row,
    // and reaching further would let an unrelated later line lend a tail to an innocent opener.
    const joined = i + 1 < tail.length ? `${line} ${stripMarkers(tail[i + 1] ?? "")}` : null;
    const verdict = classifyApiFailure(line) ?? (joined === null ? null : classifyApiFailure(joined));
    if (verdict !== null) return verdict;
  }
  return null;
}

// ── The ladder ────────────────────────────────────────────────────────────────────────────────────

/**
 * How long to wait before each successive retry, in order. This is the founder's ladder, verbatim:
 * "you ping them, and then you ping them again five seconds later. And then fifteen seconds later,
 * and then thirty seconds later, and then a minute later… and then thirty minutes later."
 *
 * The SHAPE is what matters, and it is right for this failure: a 529 burst usually clears in
 * seconds, so the early rungs are cheap and dense and recover the common case almost invisibly;
 * a sustained outage is not helped by hammering, so the tail spreads out and costs nearly nothing.
 * Eleven rungs cover 1h 27m of a single episode before the human is asked to care. That total is
 * ASSERTED in the tests, so this sentence and the array cannot drift: the first version of this
 * comment claimed ~1h47m, which was wrong by one rung's worth of arithmetic while the escalation copy
 * the code actually emits said 1h 27m (roborev 55422). No rung is missing — the array is the founder's
 * eleven, verbatim; only the prose was wrong.
 *
 * The delays are measured from the LAST ATTEMPT (or from entering `errored` for the first rung), not
 * from the start of the episode, so they are gaps rather than absolute offsets.
 */
export const REVIVE_LADDER_MS: readonly number[] = [
  5_000,
  15_000,
  30_000,
  60_000,
  2 * 60_000,
  3 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  20 * 60_000,
  30 * 60_000,
];

/** Why no ping happened. Every arm is a REASON rather than a bare false, because this is the field
 *  the concierge reads when a human asks why a red row was left alone — mirroring
 *  `engine/goalContinuation.NoContinueReason`, which exists for the same purpose. */
export type NoReviveReason =
  | "not-errored"
  /** No status entry exists for this agent, so we cannot assert it is still failing. Distinct from
   *  `not-errored` because it is an ABSENCE of evidence, not evidence of health — and it is reachable
   *  in production: `runtimeStore.resetProgress` deletes an agent's status key while its pane stays
   *  mounted for a fresh run in the reused slot, a state in which `canAcceptInput` and `processAlive`
   *  both still pass (roborev 55433). Defaulting an unknown status to `errored` there would paste a
   *  retry into an agent that just started a brand-new session. */
  | "status-unknown"
  | "unclassified-failure"
  | "cannot-accept-input"
  | "process-gone"
  | "liveness-unknown"
  | "waiting-for-next-rung";

export type ReviveDecision =
  | { action: "ping"; attempt: number; prompt: string }
  | { action: "escalate"; reason: string }
  | { action: "none"; reason: NoReviveReason };

export interface ReviveInput {
  /** The agent's OWN status (not a rollup). Only `errored` is actionable — see the gate. */
  status: AgentTabStatus;
  /** Classification of the banner that tripped this episode ({@link classifyApiFailure}). */
  failure: ApiFailureClass | null;
  now: number;
  /** Epoch ms the row entered `errored`; undefined if it is not errored. Anchors the FIRST rung. */
  erroredSince: number | undefined;
  /** Pings already sent in THIS episode. Indexes {@link REVIVE_LADDER_MS}. */
  attempts: number;
  /** Epoch ms of the last ping in this episode; undefined before the first. Anchors later rungs. */
  lastPingAt: number | undefined;
  /** `services/conciergeDispatch.agentCanAcceptInput` — fails closed for an unknown agent. */
  canAcceptInput: boolean;
  /**
   * Is the agent's PROCESS still alive (`engine/turnEndAuthority.hasExited`)?
   *
   * REQUIRED, and required-but-nullable rather than optional, for the reason
   * `goalContinuation.ContinuationInput.processAlive` spells out at length: `errored` is reachable
   * from BOTH a live-process stream failure AND `StatusEngine.exit()` on a dead one, so unlike a
   * status derived from live output it does not witness its own liveness. Pinging a dead PTY spends
   * the whole ladder writing into nothing and then escalates to the human with a false reason.
   * Absent evidence refuses, and says which refusal it is.
   */
  processAlive: boolean | undefined;
}

/**
 * Should this agent be pinged right now?
 *
 * Read the arms in order; the sequence encodes the priority. Two orderings matter:
 *
 *   • CLASSIFICATION comes before liveness and timing, so a `terminal` failure escalates
 *     IMMEDIATELY rather than waiting out a 5-second rung to tell the human something no amount of
 *     waiting will fix. A spend cap should reach them at once.
 *   • EXHAUSTION comes after the gates, so the ladder can only be declared spent on an agent we
 *     would genuinely otherwise have pinged — never on one that merely looks bad while it is
 *     unreachable or already gone.
 */
export function decideRevive(input: ReviveInput): ReviveDecision {
  const { status, failure, now, erroredSince, attempts, lastPingAt, canAcceptInput, processAlive } =
    input;

  // Only the red `errored` band. NOT `waiting`/`approval` — those are a live question the agent
  // asked, and typing "retry and continue" would answer something it never read (the reasoning
  // `goalContinuation` applies to the whole red tier). The narrowing to `errored` specifically is
  // the correction this module makes to that rule: an API banner is red WITHOUT there being any
  // question, so it is the one red state where an unprompted retry is the right thing.
  if (status !== "errored") return { action: "none", reason: "not-errored" };

  // `null` means NO API-failure banner was found at all — not "a banner we didn't recognise", which is
  // no longer a case that exists: any "API Error:" line now classifies `retryable` (see
  // API_BANNER_PATTERN). This comment used to say the opposite and cited a note that had been revised
  // to contradict it (roborev 55447). So this arm is reached when the row is red for some other reason
  // — a self-prompt/churn wedge, or a banner already scrolled out of the scan window — and typing into
  // a live terminal on no evidence of a vendor failure is not something to guess at.
  if (failure === null) return { action: "none", reason: "unclassified-failure" };

  if (failure === "terminal") {
    return {
      action: "escalate",
      reason:
        "This agent is blocked on an ACCOUNT limit (session window or spend cap), not a transient " +
        "vendor error. Retrying cannot clear it — it needs the limit raised or the window to reset.",
    };
  }

  if (!canAcceptInput) return { action: "none", reason: "cannot-accept-input" };
  if (processAlive !== true) {
    return { action: "none", reason: processAlive === false ? "process-gone" : "liveness-unknown" };
  }

  if (attempts >= REVIVE_LADDER_MS.length) {
    return {
      action: "escalate",
      reason:
        `Auto-retried ${attempts} times over ${describeSpan(totalLadderMs())} and it is still ` +
        `failing on a vendor API error. The outage is outlasting the ladder.`,
    };
  }

  // The rung is measured from the last attempt, or from entering `errored` for the first one. A
  // missing anchor refuses rather than firing instantly: `erroredSince` is undefined exactly when
  // the caller could not say when the episode began, and "unknown start" must not read as "due now"
  // (the same fail-closed reading `goalContinuation` gives an undefined `idleSince`).
  const anchor = lastPingAt ?? erroredSince;
  if (anchor === undefined) return { action: "none", reason: "waiting-for-next-rung" };
  const rung = REVIVE_LADDER_MS[attempts];
  if (rung === undefined || now - anchor < rung) {
    return { action: "none", reason: "waiting-for-next-rung" };
  }

  return { action: "ping", attempt: attempts + 1, prompt: revivePrompt(attempts + 1) };
}

/**
 * When the next rung comes due, so the mount can set ONE timer instead of polling every tick.
 *
 * Returns null when no rung is pending — the ladder is spent, or there is no anchor to measure from.
 * A due-or-overdue rung returns `now`, never a negative wait, so a caller can pass the result
 * straight to a timer without clamping.
 */
export function nextRungDueAt(input: {
  attempts: number;
  erroredSince: number | undefined;
  lastPingAt: number | undefined;
  now: number;
}): number | null {
  const { attempts, erroredSince, lastPingAt, now } = input;
  if (attempts >= REVIVE_LADDER_MS.length) return null;
  const anchor = lastPingAt ?? erroredSince;
  if (anchor === undefined) return null;
  const rung = REVIVE_LADDER_MS[attempts];
  if (rung === undefined) return null;
  return Math.max(now, anchor + rung);
}

/** Total wall-clock the full ladder spans, for the escalation sentence. */
function totalLadderMs(): number {
  return REVIVE_LADDER_MS.reduce((a, b) => a + b, 0);
}

/** "1h 27m" / "45s" — for human-facing escalation copy only, never parsed. */
function describeSpan(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return `${Math.round(ms / 1000)}s`;
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * What we actually type into the agent's terminal.
 *
 * Three properties, each learned from the failure mode it prevents:
 *
 *   • It NAMES the API error as the reason. A bare "continue" produces "continue what?" from an
 *     agent whose last turn produced no output at all — which is the defining feature of this
 *     failure, and the reason `goalContinuation.continuePrompt` restates its goal rather than
 *     saying "continue".
 *   • It forbids acknowledging the nudge. An agent that replies "Sure, retrying now!" and stops has
 *     burned a rung and produced nothing; the point is to resume the WORK, not to answer us.
 *   • It says what to do if the failure is NOT transient. Without an exit the agent can reach, a
 *     genuinely blocked agent gets pinged until the ladder is spent and the human is then told the
 *     wrong thing ("the outage outlasted the ladder") about what is actually a hard blocker.
 *
 * The attempt number is included deliberately: on rung 6 the agent can see this has been failing
 * for minutes and reasonably choose to say so rather than silently retry a twelfth time.
 */
/** The stable phrase every {@link revivePrompt} carries, so a caller can locate where our last ping
 *  landed in a scrollback and read only what came AFTER it.
 *
 *  Exported rather than re-spelled at the call site for the reason `streamFailure.stripMarkers` is
 *  shared: a second copy of a rule drifts from the first, and that exact drift already cost this
 *  feature a round (roborev 55440). Change the prompt's wording and this constant must move with it —
 *  a test asserts the prompt contains it. */
export const REVIVE_PROMPT_MARKER = "This is automatic retry ";

/**
 * Told to the human when a ladder was spent and the agent failed again LATER — late enough that we
 * cannot tell whether the last retry worked and a new outage arrived, or the same one took a while to
 * re-print (roborev 55534). Deliberately does NOT claim the outage outlasted the ladder, which is what
 * the exhaustion reason says and would be a false statement about a failure seconds old.
 *
 * Lives here beside the other reasons rather than in the runner so all the copy the human can be shown
 * is in one file, and the runner keeps no strings of its own.
 */
export const SPENT_LADDER_REASON =
  `Auto-retried ${REVIVE_LADDER_MS.length} times without this settling, and it has failed again. ` +
  `Retrying from the start, but this one may need you.`;

export function revivePrompt(attempt: number): string {
  return (
    `Your last turn ended on a transient Anthropic API error (e.g. 529 Overloaded / 500), not on ` +
    `anything you did wrong. ${REVIVE_PROMPT_MARKER}${attempt} of ${REVIVE_LADDER_MS.length}. ` +
    `Do not stop to acknowledge this message — pick up exactly where you left off and keep ` +
    `working.\n\n` +
    `If you are in fact blocked on something a retry cannot fix — an account limit, a missing ` +
    `credential, a question only the human can answer — say so plainly instead of retrying, so you ` +
    `stop being pinged.`
  );
}
