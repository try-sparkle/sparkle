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

// TUI MESSAGE-MARKER GLYPHS, stripped before the `^` anchor is applied (sparkle-onzu).
//
// The banner does NOT reach us bare. Claude Code records an API failure as a synthetic ASSISTANT
// message (`isApiErrorMessage: true` in its own transcript), and the TUI prefixes assistant messages
// with "⏺ " and tool results with "⎿ " — so the line the PTY actually carries is
// "⏺ API Error: 529 Overloaded.", which `^api error:` cannot match however well it is trimmed.
// THE ABSENCE OF THIS STRIP is what kept every 529'd agent reading GREEN/GRAY: the anchor was applied
// to a line still carrying "⏺ ", so it could never match. A module that fails CLOSED on purpose was
// failing OPEN. (Attribution matters here because it was got wrong once: the cause was the missing
// `⏺` strip, NOT the exclusion of the tool-result glyph `⎿`, which is correct and is kept below.
// This glyph has already flip-flopped twice — do not "resolve" anything by re-adding `⎿`.)
//
// The evidence is in-repo and authoritative by this repo's own standard: engine/
// capturedScreens.fixture.ts is a byte-for-byte replay of a real Claude Code 2.1.220 viewport
// (captured via PTY + headless xterm, trailing spaces trimmed — the same surface `snapshotScreen()`
// hands the classifier in production), and it renders assistant text as "⏺ I'll run that command."
// and a tool result as "  ⎿  $ touch probe_ok.txt". Per that fixture's own header: absence in
// `strings` is not evidence about the UI; only a captured screen is.
//
// DELIBERATELY NARROW — the ASSISTANT-message marker ONLY, and the exclusions are the whole point.
//
// NOT `⎿`, the TOOL-RESULT marker (roborev 55416). That glyph prefixes the output of a command the
// agent RAN — the fixture renders it as "  ⎿  $ touch probe_ok.txt" — so stripping it would mean a
// tool result whose first line happens to begin "API Error:" trips a sticky RED on a perfectly
// healthy agent. That is not hypothetical: `curl` against a failing endpoint, a tailed server log, a
// `cat` of a saved error payload, another agent's transcript, or debugging THIS module all produce
// it. It is verbatim the false-positive class the header above says was deliberately dropped
// ("they false-trip on prose and on logs the agent is reading"), and the guards do not cover it —
// the completed-line path exempts classified tool EVENTS, but a result BODY is not an event, and the
// partial-tail path (statusEngine, the `arrived` diff) has no event guard at all. Nothing shows a
// real banner ever arriving behind `⎿` either: the banner is a synthetic ASSISTANT message
// (`isApiErrorMessage: true`), so it wears `⏺`. Adding `⎿` would buy no detection and only cost
// precision.
//
// ⚠️ WHAT EXCLUDING `⎿` DOES **NOT** BUY — stated plainly so the next reader does not over-trust it
// (roborev 55440). The TUI marks only the FIRST line of a tool result with `⎿`; subsequent output
// lines are plain indented text. This function trims leading whitespace before anchoring, so line 2+
// of a MULTI-LINE result — a `curl` body, a tailed log, a `cat`ed payload — that begins
// "API Error: 500 …" STILL trips a sticky red on a healthy agent. The `⎿` exclusion therefore closes
// the result-HEAD case, NOT the "logs the agent is reading" class in general.
//
// That residual is PRE-EXISTING and unchanged by the marker work: a bare, unmarked "API Error: …"
// line has always matched, and stripping `⏺` neither caused nor widened it. Closing it properly means
// tracking an active tool-result block ("last `⎿` seen, still indented"), which risks suppressing a
// GENUINE banner that lands while a block is open — a fail-open trade in a module that exists to fail
// closed. Deliberately not attempted here; tracked on bead `sparkle-onzu`.
//
// NOT markdown bullets an agent authors in its own prose (`-`, `*`, `•`, `>`, `1.`) either: an agent
// quoting a banner it read — or writing up this very bug — must not paint its own row red, and those
// are exactly the shapes such prose takes.
//
// The COLON rule is untouched and still does the heavy lifting — "⏺ API Error handling: returns 500."
// stays green because a word, not a colon, follows "API Error" (roborev 16182/16177/16171).
// ANY number of markers, in ONE pass. `⏺+` alone collapses only ADJACENT glyphs, so a redraw that
// leaves "⏺ ⏺ API Error: …" (glyph-SPACE-glyph) needs the repetition to span the separator too.
// This used to be `/^⏺+\s*/` applied in a loop bounded at 3 passes, which failed OPEN past that
// bound: "⏺ ⏺ ⏺ ⏺ API Error: 529" kept a glyph, so `classifyFromScrollback` returned null and the
// retry ladder was skipped on an already-red row (roborev 55467). A bounded loop over an unbounded
// input is the wrong shape — the group handles any count and cannot loop, so there is no bound left
// to fail open past. Anchored with a literal glyph, so a non-matching line fails at position 0.
const MESSAGE_MARKERS = /^(?:⏺\s*)+/;

/** A frame with leading whitespace and any assistant-message markers removed, so the `^` anchor sees
 *  the banner text itself. Pure.
 *
 *  EXPORTED so there is exactly ONE implementation of the marker rule (roborev 55440).
 *  `engine/apiRecovery.classifyFromScrollback` had its own single-`replace` copy that claimed to match
 *  this "exactly" and did not: on "⏺ ⏺ API Error: 529" it left a glyph behind, classified the failure
 *  as null, and skipped the ladder entirely — while THIS function, which looped, had already painted
 *  the row red. Red row, no retry, human waits: verbatim the split that feature exists to prevent.
 *  Two copies of one rule will always drift; share it. */
export function stripMarkers(frame: string): string {
  return frame.trim().replace(MESSAGE_MARKERS, "").trim();
}

// The spinner redraws in place with carriage returns (no newline), so a single split-on-\n "line"
// can carry several \r-separated frames with the banner fused onto one of them ("…esc to interrupt\r
// API Error…", or a banner followed by another redraw). \r survives stripAnsi (it isn't an ESC
// sequence). We test EVERY \r-frame (not just the last) against the anchored pattern, so the banner
// is caught whichever frame it lands in (roborev 16169). Each frame is trimmed AND marker-stripped
// (see MESSAGE_MARKERS) so neither leading spaces nor the TUI's own "⏺ " defeats `^`.
function frames(line: string): string[] {
  return line.split("\r").map((f) => stripMarkers(f));
}

/** The trimmed banner frames in a raw CHUNK, in order. Splits on \n as well as \r, because unlike
 *  the single lines the rest of this module takes, a chunk carries both. StatusEngine diffs two of
 *  these (a `base` prefix vs `base + tail`) to isolate the banners that ARRIVED in a chunk's
 *  unterminated tail, then applies its own per-frame guards — so this stays a pure extractor and the
 *  policy (which arrivals count) lives in the caller. See countApiErrorFrames for the count-only form
 *  and the StatusEngine partial-banner check for why arrival-diffing (not a whole-buffer count) is
 *  what survives a verbatim-repeated banner (46899) and a MAX_PARTIAL-saturated buffer (46920). */
export function apiErrorFramesIn(chunk: string): string[] {
  // Marker-stripped like `frames()`, and for the same reason — the live banner arrives as
  // "⏺ API Error: …" (see MESSAGE_MARKERS). The returned frames are ALSO what StatusEngine diffs and
  // then echo-checks against the user's own just-submitted text, and stripping helps there too: a
  // marker-free frame compares against that text more faithfully than one carrying the TUI's glyph.
  return chunk
    .split(/[\r\n]/)
    .map((f) => stripMarkers(f))
    .filter((f) => API_ERROR_PATTERNS.some((re) => re.test(f)));
}

/** How many banner frames a raw CHUNK contains. Count-only sugar over {@link apiErrorFramesIn}. */
export function countApiErrorFrames(chunk: string): number {
  return apiErrorFramesIn(chunk).length;
}

/** True when any \r-frame of a line is a mid-stream API failure banner. Pure. Kept as a `some` scan
 *  rather than `countApiErrorFrames(...) > 0` — it runs on every ingested line and only needs a
 *  boolean, so it can stop at the first match. */
export function isApiErrorLine(line: string): boolean {
  return frames(line).some((f) => API_ERROR_PATTERNS.some((re) => re.test(f)));
}

// Self-prompt / churn phrases the agent emits when it's wedged and pinging itself with no real work
// to make. The REAL wedge invariant is "a stuck agent REPEATS a self-ping in a loop with no
// progress" — NOT "nobody ever says this phrase once". The USER legitimately says these (e.g. "Are
// you there?", or "hey Sparkler" — the voice-UI wake phrase), and an agent may even QUOTE them in
// prose; those single utterances get echoed into pty:output and must NOT paint a healthy agent RED.
// So `isSelfPromptLine` stays a PURE phrase-matcher (other modules/tests import it), and the
// REPETITION gate lives in `StreamFailureDetector.observe()`: a self-prompt phrase must recur
// >= SELF_PROMPT_REPEAT_THRESHOLD times (with no intervening progress `reset()`) before it trips.
const SELF_PROMPT_PATTERNS: readonly RegExp[] = [
  /are you (still )?there\b/i,
  /\bhey,?\s*sparkler\b/i,
];

/** True when a single cleaned line matches a self-prompt / churn ping phrase. Pure phrase-matcher —
 *  a SINGLE match is NOT a wedge (the counting/repetition gate lives in StreamFailureDetector). */
export function isSelfPromptLine(line: string): boolean {
  return SELF_PROMPT_PATTERNS.some((re) => re.test(line));
}

// How many times a self-prompt phrase must recur (no intervening progress reset) before it counts
// as a wedge. Low enough to still catch a real self-ping loop fast, but > 1 so a single legitimate
// utterance / prose quote of the phrase never trips a false RED (Bug A).
export const SELF_PROMPT_REPEAT_THRESHOLD = 2;

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
  // Running count of self-prompt phrase occurrences since the last progress reset(). A single
  // occurrence is a legitimate user utterance / prose quote (Bug A) — only a REPEAT is a wedge.
  private selfPrompts = 0;

  observe(line: string): boolean {
    // A real API-error banner is unambiguous the moment it appears — single occurrence still trips.
    if (isApiErrorLine(line)) return true;
    // A self-prompt phrase only signals a wedge once it REPEATS with no intervening progress. Count
    // it and trip only at the threshold, so one legitimate utterance never paints RED (Bug A).
    if (isSelfPromptLine(line)) {
      this.selfPrompts += 1;
      return this.selfPrompts >= SELF_PROMPT_REPEAT_THRESHOLD;
    }
    if (line === this.lastLine && line.length <= STALL_SHORT_LINE_CHARS) {
      this.repeats += 1;
      return this.repeats >= STALL_REPEAT_THRESHOLD;
    }
    this.lastLine = line;
    this.repeats = 1;
    return false;
  }

  /** Reset the repeat + self-prompt counters — call when real progress resumes so post-recovery
   *  output starts fresh and a stale pre-failure line (or an earlier lone self-ping) can't combine
   *  with new output to look like churn. */
  reset(): void {
    this.lastLine = "";
    this.repeats = 1;
    this.selfPrompts = 0;
  }
}
