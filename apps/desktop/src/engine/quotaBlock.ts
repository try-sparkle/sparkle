// quotaBlock — "this agent cannot do ANYTHING until a wall-clock time, and every health surface
// said it was fine."
//
// THE FAILURE THIS CLOSES. Agent 61a5332f ("Cockpit Column Resize") hit:
//
//     You've hit your session limit · resets 4pm (America/Bogota) — /usage-credits to finish what
//     you're working on.
//
// and sat dead until the founder found it himself and typed "try again". Throughout,
// `get_agent_status` answered `status: "working"`, stall verdict `active`, detail "Working — tools
// are running and commands are not repeating." A session limit is the most TOTAL block the app can
// encounter — nothing the agent, the fleet, or the concierge does can clear it before the stated
// time — and it was the one condition no health surface could see.
//
// THIS MODULE ADDS NO NEW MATCHER, AND THAT IS DELIBERATE. Three separate pieces of the answer were
// already in the repo, correct and tested; none of them was wired to the status path:
//
//   • `engine/apiRecovery.classifyApiFailure` already returns `"terminal"` for exactly this string
//     (an ACCOUNT limit: session window or spend cap, as opposed to a transient vendor 5xx). It is
//     never consulted for a healthy-looking agent, because `decideRevive` refuses anything whose
//     status is not already `errored`.
//   • `engine/streamFailure.stripMarkers` already knows the TUI's "⏺ " assistant-message glyph. The
//     repo has been bitten twice by a second copy of that rule; there is not a third here.
//   • `services/rateLimitWatch.parseResetInstant` already turns "resets 4pm (America/Bogota)" into an
//     instant, DST-correctly, via `Intl` — the exact string, the exact zones, already under test.
//
// WHY THE STATUS PATH COULD NEVER SEE IT. The only mid-stream signal that paints a live agent red is
// `streamFailure`'s `^api error\s*:` anchor. A session-limit banner carries NO "API Error:" prefix, so
// the anchor could not match, the row never went red, and `apiRecovery`'s working account-limit
// classifier — sitting one gate downstream, behind `status === "errored"` — was never reached. The
// detector was present and unreachable. This module is the missing lead: it asks the existing
// classifier on the OUTPUT path, where the evidence actually arrives.
//
// PURE. Data in, data out; the clock arrives as a parameter. No timers, no I/O.
import { classifyApiFailure } from "./apiRecovery";
import { stripMarkers } from "./streamFailure";
import { SESSION_WINDOW_MS, parseResetInstant } from "../services/rateLimitWatch";

/**
 * The bounded backoff used when the message names no parseable reset time.
 *
 * ALIASED to `rateLimitWatch.SESSION_WINDOW_MS` rather than restated, so the two cannot drift. A
 * Claude Max session window is 5 hours, so a *session* limit always clears within one; for a monthly
 * spend cap (which names a billing URL and no clock time) it is simply a bounded re-check rather than
 * a claim about when the money appears. Either way it is the founder's stated requirement — "if it
 * cannot be parsed, fall back to a bounded backoff rather than a tight loop" — and it is strictly
 * better-founded than a blind guess.
 */
export const SESSION_LIMIT_FALLBACK_MS = SESSION_WINDOW_MS;

/** An account/quota wall observed in an agent's own output. */
export interface QuotaBlock {
  /**
   * The limit message VERBATIM, exactly as the agent printed it (markers stripped, nothing else).
   *
   * Verbatim is load-bearing: this string is what the human is shown, and it is the only place the
   * reset time and the remedy path (`/usage-credits`, `claude.ai/settings/usage`) appear. A
   * paraphrase would drop precisely the content that makes the block actionable.
   */
  message: string;
  /** Epoch ms the wall is expected to come down. */
  resetAt: number;
  /** Did {@link message} actually name a reset time, or is {@link resetAt} the bounded fallback?
   *
   *  Reported rather than inferred, so a caller can say "resets 4pm" versus "rechecking in a few
   *  hours" honestly instead of presenting a guess as a fact. */
  resetParsed: boolean;
  /** When the wall was observed — the instant {@link resetAt} was computed against. */
  at: number;
}

/**
 * Find an account/quota wall in a chunk of terminal output. Pure; `undefined` when there is none.
 *
 * FRAME HANDLING mirrors `streamFailure`: the spinner redraws in place with carriage returns, so one
 * "line" can carry several \r-separated frames with the banner fused onto any of them. Every frame is
 * marker-stripped and tested, not just the last.
 *
 * ADJACENT FRAMES ARE ALSO JOINED, because xterm hard-wraps at the pane width and the real banner is
 * long enough to wrap — `classifyApiFailure` demands the opener AND the tail, and a wrap puts them on
 * different rows. `apiRecovery.classifyFromScrollback` solves the same problem the same way; this is
 * that rule applied to a live chunk rather than to scrollback.
 *
 * THE FALSE-POSITIVE DISCIPLINE IS INHERITED, NOT REINVENTED. `classifyApiFailure` requires the line
 * to START with the opener (so a markdown bullet, a quote, or mid-sentence narration never matches)
 * and to carry a separator-led `resets`/`raise it at` tail. An agent writing about session limits —
 * including this very module's write-up — stays green.
 */
export function quotaBlockIn(chunk: string, at: number): QuotaBlock | undefined {
  return quotaBlocksIn(chunk, at)[0];
}

/**
 * EVERY account-limit wall in a chunk, in order. The plural form exists for ARRIVAL DIFFING.
 *
 * A live banner lands in the still-unterminated tail, so it stays in the engine's `carry` buffer and
 * is re-read on every subsequent chunk. Asking "is there a wall in this buffer?" therefore answers
 * YES forever, which makes the block impossible for anyone — human or machine — to clear, and turns
 * any test of who may clear it into a test that passes for the wrong reason. (That is exactly what
 * happened while building this: the "a machine resume must not clear it" case went green on the
 * re-read, not on the rule it names.)
 *
 * The fix is the one `streamFailure.apiErrorFramesIn` already uses for the same buffer: count the
 * walls in the already-seen PREFIX, and treat only the extras as having ARRIVED now. Same shape, so
 * the two paths cannot drift.
 */
export function quotaBlocksIn(chunk: string, at: number): QuotaBlock[] {
  // EMPTY FRAMES ARE DROPPED, not merely skipped over, and that is what keeps `message` verbatim.
  // A live banner arrives as "\r⏺ You've hit…", which splits into ["", "⏺ You've hit…"] — so the
  // join below would otherwise pair the empty frame with the real one and hand back a message with a
  // leading space. `classifyApiFailure` trims internally and matched it happily; only the verbatim
  // assertion caught it. An empty frame carries nothing to join, so there is no case for keeping it.
  const frames = chunk
    .split(/[\r\n]/)
    .map((f) => stripMarkers(f))
    .filter((f) => f !== "");
  const found: QuotaBlock[] = [];
  for (let i = 0; i < frames.length; i++) {
    const line = frames[i] ?? "";
    if (classifyApiFailure(line) === "terminal") {
      found.push(blockFrom(line, at));
      continue;
    }
    // A hard wrap splits the opener from its tail. Join with the NEXT frame and retest.
    const next = frames[i + 1];
    if (next === undefined) continue;
    const joined = `${line} ${next}`;
    if (classifyApiFailure(joined) === "terminal") {
      found.push(blockFrom(joined, at));
      i++; // both frames are consumed by this one banner
    }
  }
  return found;
}

/** Resolve a matched banner to a block, recording whether the reset time was real or the fallback. */
function blockFrom(message: string, at: number): QuotaBlock {
  const resetAt = parseResetInstant(message, at);
  // `parseResetInstant` reports a failed parse by returning exactly its documented fallback
  // expression, so comparing against that same expression is an exact test rather than a heuristic.
  // Asked here (once) rather than by each caller, so nobody has to re-derive the convention.
  const resetParsed = resetAt !== at + SESSION_LIMIT_FALLBACK_MS;
  return { message, resetAt, resetParsed, at };
}

/** Is the wall still up at `now`? A block whose reset has passed is history, not a condition.
 *
 *  `undefined` reads as "no wall", never as "blocked" — an absent observation must not manufacture a
 *  block, the same evidence-not-inference default `agentStall` and `rollupDot` both use. */
export function isQuotaBlocked(block: QuotaBlock | undefined, now: number): boolean {
  return block !== undefined && now < block.resetAt;
}
