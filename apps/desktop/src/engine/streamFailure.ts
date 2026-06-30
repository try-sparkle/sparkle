// streamFailure (sparkle-pqxh): detect mid-stream failures Claude prints WHILE its process stays
// alive — the cases the PTY-exit `errored` path (statusEngine.exit) can never see, because the
// process never exits. Two real-world shapes the desktop kept reading as green/gray:
//
//   1. A mid-turn API failure that Claude prints but keeps churning under, e.g.
//      "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited".
//   2. A self-prompt / churn loop the agent falls into when wedged — repeating short pings like
//      "Are you there? Hey, Sparkler. Are you there?" with no real tool activity. The spinner keeps
//      ticking, so the old status logic read `working` forever and the turn never ended.
//
// This module is the PURE detector half: it decides, line by line, when the stream has entered a
// failed/stalled state. The caller (StatusEngine) owns the STICKY flag and the recovery rule (real
// tool activity or a real interactive prompt clears it), so this stays side-effect-free and unit-
// testable without a terminal. It deliberately FAILS CLOSED: these are red, attention-worthy signals
// ("needs you"), not something to swallow to gray — a missed red loses the user time, the whole
// reason this exists.

// Mid-stream API/server failure banner Claude / the Anthropic API print when a request fails but the
// agent keeps its PTY alive. Every real banner is surfaced as "API Error: <status> <message>" — e.g.
// "API Error: 500 Internal server error", "API Error: 529 overloaded_error", "API Error: Server is
// temporarily limiting requests (not your usage limit) · Rate limited" — so a SINGLE pattern
// anchored to "API Error:" (WITH the colon) at the start of the line catches every variant. The
// colon is what separates the banner from line-initial NARRATION/headings about the topic ("API
// Error handling: returns 500.", "API Error responses now return 529.") — those have a word after
// "API Error", not a colon, so they stay green (roborev 16182/16177). Anchoring also stops
// mid-sentence narration ("I'll handle the API Error case", "the model can be overloaded") from
// false-tripping a sticky RED that the router holds over even a hook `working`
// (roborev 16153/16169/16171). DELIBERATELY DROPPED: the bare keyword patterns (`rate limited`,
// `overloaded`, a standalone `internal server error`) — they false-trip on prose and on logs the
// agent is reading (e.g. tailing a server log line "500 Internal Server Error"); the "API Error:"
// prefix already covers the real banner. A standalone banner with no "API Error:" prefix is
// intentionally no longer matched (the self-prompt / churn detectors remain the backstop for a
// genuine wedge). NOTE: rateLimitWatch.ts has its own SEPARATE matcher for account-failover; this
// one is for STATUS — do not merge them.
export const API_ERROR_PATTERNS: readonly RegExp[] = [/^api error\s*:/i];

// The spinner redraws in place with carriage returns (no newline), so a single split-on-\n "line"
// can carry several \r-separated frames with the banner fused onto one of them ("…esc to interrupt\r
// API Error…", or a banner followed by another redraw). \r survives stripAnsi (it isn't an ESC
// sequence). We test EVERY \r-frame (not just the last) against the anchored pattern, so the banner
// is caught whichever frame it lands in (roborev 16169). Each frame is trimmed so leading spaces
// don't defeat `^`; note trim() strips only whitespace, NOT box-draw/marker glyphs — the live banner
// carries none, so a hypothetical "⎿ API Error" is out of scope here.
function frames(line: string): string[] {
  return line.split("\r").map((f) => f.trim());
}

/** True when any \r-frame of a line is a mid-stream API failure banner. Pure. */
export function isApiErrorLine(line: string): boolean {
  return frames(line).some((f) => API_ERROR_PATTERNS.some((re) => re.test(f)));
}

// Self-prompt / churn phrases the agent emits when it's wedged and pinging itself with no real work
// to make. These appear ONLY in the stuck loop (a healthy agent never asks the user "are you
// there?"), so a single occurrence is an unambiguous stall signal.
const SELF_PROMPT_PATTERNS: readonly RegExp[] = [
  /are you (still )?there\b/i,
  /\bhey,?\s*sparkler\b/i,
];

/** True when a single cleaned line is a self-prompt / churn ping. Pure. */
export function isSelfPromptLine(line: string): boolean {
  return SELF_PROMPT_PATTERNS.some((re) => re.test(line));
}

// A churn loop also shows up as the SAME short line repeating with no progress in between. Require
// SEVERAL identical repeats so legitimately repeated short tool output (a handful of "Installing…"
// echoes, a few progress dots) doesn't trip a false RED — a real wedge repeats far more than this,
// and the known self-prompt loop is already caught immediately by isSelfPromptLine, so this generic
// counter only needs to catch UNKNOWN churn and can afford to be conservative (roborev 16153). The
// caller resets the counter on any classified tool event, so only a truly progress-free run trips.
// Bounded to SHORT lines so a repeated long log line (real output) never counts.
export const STALL_REPEAT_THRESHOLD = 5;
export const STALL_SHORT_LINE_CHARS = 80;

/**
 * Stateful entry-detector for a mid-stream failure/stall. `observe(line)` returns true the MOMENT a
 * line constitutes a failure: an API-error banner, a self-prompt ping, or the Nth identical short
 * repeat (a churn loop). It tracks only the running repeat count — the caller owns the sticky
 * "we're failed" flag and decides recovery, so this object never needs to be told it recovered
 * except to reset the repeat counter (reset()). Feed it cleaned, trimmed, NON-EMPTY, NON-SPINNER
 * lines (the spinner re-draws every tick and would otherwise read as either progress or churn).
 */
export class StreamFailureDetector {
  private lastLine = "";
  private repeats = 1;

  observe(line: string): boolean {
    if (isApiErrorLine(line)) return true;
    if (isSelfPromptLine(line)) return true;
    if (line === this.lastLine && line.length <= STALL_SHORT_LINE_CHARS) {
      this.repeats += 1;
      return this.repeats >= STALL_REPEAT_THRESHOLD;
    }
    this.lastLine = line;
    this.repeats = 1;
    return false;
  }

  /** Reset the repeat counter — call when real progress resumes so post-recovery output starts
   *  fresh and a stale pre-failure line can't combine with new output to look like churn. */
  reset(): void {
    this.lastLine = "";
    this.repeats = 1;
  }
}
