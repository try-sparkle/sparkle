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
 * A SUB-AGENT's banner, quoted onto the PARENT's screen behind a failure prefix.
 *
 * With the Task tool the child process dies on the account wall and the parent prints the child's
 * whole banner behind its own prose:
 *
 *     Agent "Fix auto-switch on expired account" failed: Claude Code process exited due to an API
 *     error: You've hit your session limit · resets 9:30am
 *
 * The opener is `^`-anchored, so that line matched NOTHING and the parent row painted GRAY while the
 * account was flatly out of session window. Stripping ONLY this exact shape and re-running the
 * unchanged opener+tail test on the remainder keeps the anchor's whole point: the remainder must
 * still OPEN with the banner, so prose that merely mentions a failed sub-agent, or quotes one
 * mid-sentence, still declines. Deliberately NOT applied before {@link API_BANNER_PATTERN} — a
 * retryable verdict is already the default for anything that reaches it, so widening its reach buys
 * nothing and costs the anchor.
 */
const SUBAGENT_FAILURE_PREFIX = /^agent\s+"[^"]*"\s+failed:\s*.*?\bapi error:\s*/i;

/**
 * The TUI's tool-result marker, stripped ONLY before the ACCOUNT-LIMIT test and NEVER before
 * {@link API_BANNER_PATTERN}. That asymmetry is the entire mechanism — read
 * {@link classifyFromScrollback}'s note on the backwards scan before touching it.
 *
 * A sub-agent's limit banner reaches the parent's screen as a tool RESULT row, so it wears `⎿`, not
 * `⏺`. Stripping it here makes "  ⎿  You've hit your session limit · resets 9:30am" classify
 * `terminal`, while "  ⎿  API Error: 529 Overloaded." still classifies NULL and therefore still
 * cannot win the backwards scan over a genuine limit banner above it. Adding `⎿` to
 * `streamFailure.MESSAGE_MARKERS` instead would strip it for BOTH tests and invert exactly that case.
 */
const TOOL_RESULT_MARKER = /^⎿\s*/;

/**
 * The AUTO-CONTINUE wording of the same wall:
 *
 *     Usage limit reached · continuing automatically at 9:30am
 *
 * Its own opener, because it does not start with "You've hit your", and it earns `terminal` the same
 * way every other account wall does — an anchored opener AND a separator-led tail — so prose about
 * usage limits stays null. Classified `terminal` like every other account wall: the founder's rule is
 * that the Improve Sparkle row and the build rows resolve colours IDENTICALLY, and every quota wall is
 * RED on every row today. (Whether "continuing automatically" should instead read as amber — the
 * agent says it will retry itself — is a real product question, and the founder's to decide.)
 */
const AUTO_CONTINUE_OPENER = /^(?:claude(?:\s+ai)?\s+)?usage limit reached\b/i;

/**
 * The tail {@link AUTO_CONTINUE_OPENER} accepts, in addition to {@link ACCOUNT_LIMIT_TAIL}.
 *
 * ⚠️ THE OPENER'S `claude` PREFIX AND THIS ALTERNATION ARE BOTH LOAD-BEARING, and both were missing
 * (roborev 67784). EVERY wording this repo has actually captured leads with "Claude" and none of
 * them ends in "· resets":
 *
 *     Claude usage limit reached. Your limit resets at 5:00pm.        (rateLimitWatch.test.ts)
 *     Claude usage limit reached - resuming at 5pm                    (claude_oneshot.rs tests)
 *     Claude usage limit reached — will reset at 3pm (America/Bogota) (rateLimitWatch.test.ts)
 *     Claude usage limit reached|1787412000                           (429 body)
 *
 * An opener anchored on `^usage limit reached` with a `· continuing` tail reaches NONE of them, so
 * the shape this arm was added for still painted gray on every real capture.
 *
 * THE EARN-IT RULE IS NOT RELAXED, and that is the difference between this and the wider fix that
 * was declined. `claude_oneshot.rs::is_account_limit` matches these phrases ANYWHERE, unanchored —
 * correct for ITS input (a JSON error body), wrong here, where the input is a terminal line and
 * `classifyApiFailure`'s whole false-positive discipline is that prose must not match. Matching the
 * bare phrase anywhere would reclassify all three of this module's own prose negatives, including
 * "Usage limit reached is the wall we must paint red". So the opener stays ANCHORED and a tail is
 * still REQUIRED; only the vocabulary of real tails is corrected.
 *
 * The trailing epoch alternative covers the 429 body's `|1787412000`: a separator followed by a long
 * bare integer is machine output, never prose.
 */
const AUTO_CONTINUE_TAIL =
  /(?:(?:·|•|\||—|-)\s*(?:continuing|resets|resuming|will reset)\b)|(?:\blimit resets at\b)|(?:\bwill reset at\b)|(?:\bresuming at\b)|(?:(?:·|•|\||—|-)\s*\d{6,})/i;

/**
 * The two multi-word phrases that mean "this is an ACCOUNT wall" when they appear INSIDE an
 * `API Error:` banner — the 429-delivered form of the very same limit.
 *
 * Same phrases `claude_oneshot.rs::is_account_limit` trusts, and its header records that each is "a
 * fragment of a real message, verified against captures". They are used here ONLY in conjunction
 * with {@link API_BANNER_PATTERN}, i.e. only on a line that already OPENS with "API Error:", which
 * is what keeps prose out — a sentence about usage limits does not begin that way.
 *
 * WHY IT MATTERS (roborev 67784): a subscription wall delivered as a 429 reaches
 * {@link API_BANNER_PATTERN} first and classifies `retryable`, so the ladder spends all eleven rungs
 * prompting an account that is flatly out of window. That is the exact inversion `claude_oneshot.rs`
 * reordered its own gates to prevent ("status first is what caused it").
 *
 * DISJOINT, not merely ordered, from the one banner that must stay retryable:
 * "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"
 * contains "usage limit" but neither "usage limit reached" nor "limit resets at".
 */
const ACCOUNT_WALL_IN_BANNER = /\busage limit reached\b|\blimit resets at\b/i;

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
  // Terminal must EARN it: an ANCHORED opener AND a separator-led tail, the latter anywhere in the
  // line. Tested against the line itself and against the two narrow UNWRAPPINGS below — never
  // against a search-anywhere opener, which is what keeps prose out.
  for (const candidate of accountLimitCandidates(s)) {
    if (ACCOUNT_LIMIT_OPENER.test(candidate) && ACCOUNT_LIMIT_TAIL.test(candidate)) return "terminal";
    if (
      AUTO_CONTINUE_OPENER.test(candidate) &&
      (AUTO_CONTINUE_TAIL.test(candidate) || ACCOUNT_LIMIT_TAIL.test(candidate))
    ) {
      return "terminal";
    }
  }
  // NOTE the input: `s`, never a candidate. Stripping `⎿` before this anchor is what would let a
  // tool-result "API Error: 529" win the backwards scan over a real limit banner above it.
  if (API_BANNER_PATTERN.test(s)) {
    // An ACCOUNT wall delivered as a 429 is still an account wall. Checked INSIDE this branch, so
    // the phrase can only ever be read on a line that already opens with the banner prefix — prose
    // never reaches it. See {@link ACCOUNT_WALL_IN_BANNER} for why retryable here is expensive.
    return ACCOUNT_WALL_IN_BANNER.test(s) ? "terminal" : "retryable";
  }
  return null;
}

/**
 * The forms of one line the ACCOUNT-LIMIT test is run against: the line itself, then it with a
 * leading `⎿` removed, then each of those with a {@link SUBAGENT_FAILURE_PREFIX} removed.
 *
 * Both peelings are narrowly anchored and BOTH exist for the same real shape — a sub-agent's wall
 * arriving on the parent's screen — which is why they compose rather than being alternatives. The
 * opener stays `^`-anchored against whatever remains, so nothing here loosens the discipline that
 * keeps prose, paraphrase and this module's own docstrings out of `terminal`.
 */
function accountLimitCandidates(s: string): string[] {
  const out = [s];
  const unmarked = s.replace(TOOL_RESULT_MARKER, "");
  if (unmarked !== s) out.push(unmarked);
  for (const base of [...out]) {
    const unprefixed = base.replace(SUBAGENT_FAILURE_PREFIX, "");
    if (unprefixed !== base) out.push(unprefixed);
  }
  return out;
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
 * `streamFailure`'s header proposes; unlike over there it would be fail-SAFE here.
 *
 * ⚠️ "A GENUINE BANNER WEARS `⏺`, NEVER `⎿`" — which this note used to assert — IS FALSE, and
 * believing it is what left a session-limited agent GRAY. With the Task tool a SUB-AGENT hits the
 * wall, and its banner reaches the parent's screen as a tool RESULT row: "  ⎿  You've hit your
 * session limit · resets 9:30am". So `⎿` is stripped — in {@link classifyApiFailure}, before the
 * ACCOUNT-LIMIT test ONLY (see {@link TOOL_RESULT_MARKER}). It is deliberately NOT stripped before
 * `^api error:`, so the inversion described above stays impossible by construction rather than by
 * the accident of one glyph being left alone. Tracked on bead `sparkle-onzu`.
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
    const rawNext = i + 1 < tail.length ? (tail[i + 1] ?? "") : null;
    const joined = rawNext === null ? null : `${line} ${stripMarkers(rawNext)}`;
    // A wrapped row is the SAME TUI row continued, so it carries no marker of its own.
    //
    // ESCAPES, NOT LITERAL GLYPHS, and deliberately (the `glyphIcons` ratchet counted this line as a
    // fifth glyph-as-icon site and reds CI at a ceiling of four). That ratchet is about glyphs used
    // as ICONS, which react-icons/fi should own; this is a PARSER matching the TUI's own markers, so
    // the honest fix is to spell the codepoints rather than to exempt the file and blunt the ratchet
    // for every future edit to it. U+23FA ⏺ message, U+23BF ⎿ tool result, U+25CF ● bullet.
    const isWrapContinuation =
      rawNext !== null && !/^\s*[\u23FA\u23BF\u25CF]/.test(rawNext);
    // ⚠️ A `retryable` LINE-ALONE VERDICT MUST STILL BE UPGRADABLE BY THE JOIN (roborev 67803).
    // `alone ?? joined` consults the join only when the row alone is NULL — and an `API Error:` row
    // is never null, it is `retryable`. So a 429-delivered account wall, which is ~100 chars and
    // therefore wraps on any narrow pane, returned `retryable` on its first row and the row carrying
    // "usage limit reached" was never joined in: all eleven rungs spent against a walled account,
    // verbatim the inversion the in-banner rule was added to end. `quotaBlock.quotaBlocksIn` already
    // gates its join on `!== "terminal"` for this reason; these two read the same rows and must not
    // disagree about them.
    const alone = classifyApiFailure(line);
    if (alone === "terminal") return alone;
    const fromJoined = joined === null ? null : classifyApiFailure(joined);
    // ⚠️ AN UPGRADE MAY ONLY COME FROM A WRAP CONTINUATION (roborev 67814, HIGH).
    // The in-banner rule's whole safety is that it is read only on a line already opening with
    // "API Error:" — "prose never reaches it". An unconditional join defeats exactly that: an
    // innocent 529 followed by ANY row mentioning the phrase became `terminal`. Measured on
    //     ⏺ API Error: 529 Overloaded.
    //     ⏺ Usage limit reached is the wall we must paint red
    // — and that second line is verbatim one of this file's own prose negatives, i.e. a line an
    // agent working on this feature actually prints. The cost is the expensive direction the header
    // names: a false billing claim, zero rungs spent, the row red for hours.
    //
    // A hard wrap never starts a new TUI row, so a continuation CANNOT begin with a message marker.
    // Requiring that is what separates "the rest of this banner" from "the next thing that happened".
    // NOTE it gates BOTH doors — the upgrade AND the null-verdict arm. An earlier cut gated only the
    // upgrade, and the same false `terminal` was still reachable through the other: a row that
    // classifies null on its own could take a tail from a marker-bearing next row. A genuine hard
    // wrap carries no marker, so it still unwraps a split account-limit banner exactly as before.
    // ⚠️ THE GATE COVERS BOTH DOORS (roborev 67824). A first cut applied it only to the UPGRADE arm
    // and left `alone === null ? fromJoined` unconditional — so a marker-bearing next row could
    // still lend a tail to an anchored prose opener and produce the same false `terminal`, reached
    // the other way. A join is only ever evidence when the next row is a wrap CONTINUATION; when it
    // is a new TUI row, the two lines are separate events and neither may complete the other.
    const joinedEvidence = isWrapContinuation ? fromJoined : null;
    const verdict =
      alone === null
        ? joinedEvidence
        : joinedEvidence === "terminal"
          ? "terminal"
          : alone;
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
   * Is the agent's PROCESS still alive (`engine/turnEndAuthority.processAliveOf`)?
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
 * Told to the human when an agent has used up its whole retry budget — we are done trying and the row
 * stays red. Distinct from the exhaustion reason on {@link decideRevive}, which is about ONE ladder
 * running out of rungs; this is the across-ladders stop.
 *
 * Claims only what is known. A predecessor said "without this settling", which was false on the very
 * path it served — the last retry may well have worked before an unrelated failure arrived (roborev
 * 55566). That constant is now deleted rather than reworded, since nothing announces a restart any more.
 */
export const BUDGET_SPENT_REASON =
  `This agent has been auto-retried as much as is useful and is still failing. ` +
  `Leaving it red — it needs you now.`;

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
