// statusEngine (spec §6): turns a raw PTY stream into the agent tab status taxonomy,
// which the UI collapses to three colors (green=working, red=needs-you, gray=inactive).
//
// GREEN (working) comes from Claude Code's own "working" indicator: while it is actually
// busy (thinking or running a tool) it prints a live status line — "… esc to interrupt" —
// re-drawn about once a second. We treat that spinner as the authoritative working signal
// so a long, quiet tool run never looks stalled, and its disappearance means the turn
// ended. When the spinner stops (the turn settles), we read the RENDERED screen snapshot
// and ask `screenAwaitsInput`: a question/approval menu on screen → red (it needs your
// answer), anything else → gray (the turn is simply done). Classifying the clean rendered
// screen — not the ANSI-noisy raw stream — is what makes red-vs-gray reliable. Heuristic +
// retrainable: if the spinner is never seen we fall back to legacy time-based stall timers
// (which also settle through the screen check), so nothing regresses.
//
// Transitions:
//   spawn                         -> working
//   spinner present               -> working   (re-arm the "spinner gone" settle timer)
//   spinner gone > SPINNER_GRACE  -> settle: waiting/approval if a question is on screen,
//                                              else idle (turn done — gray)
//   a prompt appears mid-stream   -> waiting    (or approval, if a risky action was seen)
//   process exits                 -> done       (or errored, if errors were seen)
// Fallback when the spinner is never observed (TUI drift / non-Claude program):
//   output flowing                -> working
//   quiet > IDLE_MS               -> settle (screen check, as above)
//   quiet > BLOCKED_MS            -> blocked
import { classifyLine } from "@sparkle/core";
import type { AgentTabStatus } from "@sparkle/ui";
import { screenAwaitsInput } from "./screenClassifier";
import { StreamFailureDetector, apiErrorFramesIn, countApiErrorFrames, isApiErrorLine } from "./streamFailure";

// Strip ANSI/control sequences before classifying (xterm still renders the raw bytes).
// Built from a string with \u escapes so the source stays paste-safe (no literal ESC).
// Matches CSI/OSC-style sequences introduced by ESC, plus any stray ESC chars.
// eslint-disable-next-line no-control-regex
const ANSI = new RegExp("\\u001b[\\[\\]()#;?]*[0-9;]*[@-~]|\\u001b", "g");
function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

// Mid-stream input detection flips to red the instant a prompt streams past, ~2s before
// the settle screen-check would. It runs the SAME classifier as settle (`screenAwaitsInput`
// — one source of truth, zero duplicated markers), so it keys only off true interactive
// prompts (the ❯ menu, (y/n), passphrase…). It deliberately does NOT match conversational
// prose like "Do you want to proceed?": Claude ends think turns with exactly that
// phrasing, and treating it as a blocking prompt is the false-red this whole change exists
// to kill. A real prompt always carries an interactive marker, which we do catch.
const ERROR_PATTERNS: RegExp[] = [
  /\bpanic\b/i,
  /fatal error/i,
  /command not found/i,
  /\bEACCES\b/i,
  /unhandled exception/i,
  // Narrow: only a line that BEGINS with an error marker. Claude prints "Error:"
  // conversationally mid-sentence; matching that would mislabel clean sessions.
  // `m` so `^` anchors at each line start (ingest tests per-line, but this is robust
  // if ever run against a multi-line chunk).
  /^\s*error[:\s]/im,
  /^\s*(uncaught )?(type|reference|syntax|range)error\b/im,
  /traceback \(most recent call last\)/i,
];

// Claude Code's live "working" status line, re-drawn ~once a second while a turn is running. Two
// shapes have shipped, and BOTH must read as working:
//
//   today (>= ~2.1.218):  "✢ Metamorphosing… (40m 17s · ↓ 66.9k tokens)"
//   legacy:               "✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)"
//
// This was `[/esc to interrupt/i]` alone, tested against the WHOLE chunk. Claude Code then moved
// that hint off the status line and into the persistent footer bar, which broke the signal in both
// directions at once — and the suite stayed green, because every fixture here carried the old fused
// shape (2026-07-28).
//
//   * FALSE GRAY: once spinner mode is latched, only a marker frame re-arms the settle timer. The
//     status line redraws every second carrying no marker, so ~2s into every turn the engine
//     recorded `idle` — a gray dot on a plainly working agent. That `idle` also opens the CTA gate
//     (useSuggestions' YOUR_TURN set), which is how "Merge PR"/"Close Build Agent" came to be
//     offered over live work, and it pins `isInMotion` false, which removes the in-motion
//     suppression on the worker-red bubble in workerAttention.ts.
//   * FALSE GREEN, the more dangerous one: the footer carries the hint whether or not a turn is
//     running, so a whole-chunk match reads persistent chrome as proof of work and would pin every
//     agent green forever — hiding a real question behind a healthy-looking dot.
//
// So the marker is now the SHAPE OF THE STATUS LINE, matched per redraw frame (see isSpinnerFrame):
// the leading spinner glyph, plus a parenthetical carrying an elapsed clock and/or the token
// counter. "esc to interrupt" survives as one accepted tail so older Claude builds keep working,
// but it only counts ON a glyph-led frame — never on its own, which is what keeps the footer out.
//
// Retune point, like screenClassifier's markers: this tracks a Claude Code TUI detail that drifts.
// Add a fixture in TODAY's shape whenever it moves, or a green suite will again say nothing.

/** The rotating glyphs Claude leads its transient status line with. Kept in step with
 *  engine/composerOcclusion.ts's SPINNER_GLYPH — the two answer the same question about the same
 *  line, and letting them drift apart is how one of them silently stops matching. */
const SPINNER_GLYPH = /^\s*[✻✽✢✶✳·*∗+]\s/;

/** The parenthetical the status line carries: an elapsed clock ("(12s", "(40m 17s", "(3m"). */
const SPINNER_ELAPSED = /\(\s*(?:\d+\s*h\s*)?(?:\d+\s*m\s*)?\d+\s*s\b|\(\s*\d+\s*m\b/;

/** Accepted tails for a glyph-led frame. The token counter is the strongest of these — it only
 *  climbs while the model is generating — and `esc to interrupt` is the legacy shape. */
const WORKING_PATTERNS: RegExp[] = [SPINNER_ELAPSED, /\d+(?:\.\d+)?\s*[km]?\s*tokens/i, /esc to interrupt/i];

/** Is ONE redraw frame Claude's live status line? Glyph-led AND carrying a clock/counter/legacy
 *  tail. Feed it a single frame — never a whole chunk: the glyph is anchored, so a chunk whose
 *  FIRST line happens to start with "* " (a markdown bullet, a diff line) would otherwise license
 *  every tail match anywhere in it. `hasSpinnerFrame` does the splitting for you. */
export function isSpinnerFrame(frame: string): boolean {
  return SPINNER_GLYPH.test(frame) && WORKING_PATTERNS.some((re) => re.test(frame));
}

/** Does this cleaned chunk contain a live status-line redraw? The spinner redraws in place with
 *  carriage returns, so one chunk holds several frames plus ordinary prose; we split and ask
 *  per-frame rather than testing the whole chunk, which is what keeps the persistent footer — and
 *  prose that merely mentions "12s" or "30k tokens" — from reading as a running turn. */
function hasSpinnerFrame(chunk: string): boolean {
  return chunk.split(/[\r\n]/).some(isSpinnerFrame);
}

// The spinner also carries a live token counter — "↑ 1.2k tokens", "↓ 2.1k tokens" — that only
// climbs while the model is ACTIVELY GENERATING. Parse the number (k → ×1000, m → ×1000000) so a
// strictly-higher count between frames can serve as positive proof of forward progress (see the
// token-advance recovery in ingest). Returns null when the frame carries no token figure (some
// spinners omit it), in which case the token signal simply doesn't apply and the other recovery
// paths still hold. Feed it ONE spinner frame — never a whole chunk: the pattern is unanchored, so
// prose that merely mentions "30k tokens" would otherwise read as the counter and could clear a
// sticky failure (roborev on da7c80c). `latestSpinnerTokens` below is the live path; it does the
// frame-splitting for you.
// Retune point: like WORKING_PATTERNS, this tracks a Claude Code TUI detail that may drift.
const SPINNER_TOKENS = /(?:↑|↓)?\s*(\d+(?:\.\d+)?)\s*([km])?\s*tokens/i;
// `| undefined` is deliberate: under noUncheckedIndexedAccess an unknown suffix reads as undefined,
// and the `?? 1` below turns that into "no scaling" rather than a silent NaN that would compare false
// in every advance check and quietly disable the recovery (roborev 46783).
const TOKEN_SUFFIX_SCALE: Record<string, number | undefined> = { k: 1_000, m: 1_000_000 };
export function parseSpinnerTokens(spinnerFrame: string): number | null {
  const m = SPINNER_TOKENS.exec(spinnerFrame);
  if (!m?.[1]) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const scaled = n * (TOKEN_SUFFIX_SCALE[m[2]?.toLowerCase() ?? ""] ?? 1);
  return Number.isFinite(scaled) ? Math.round(scaled) : null;
}

// The token figure from the NEWEST spinner frame in a cleaned chunk that actually carries one. The
// spinner redraws in place with carriage returns, so one chunk can hold several frames AND ordinary
// prose: walking BACK over the frames means (a) the count we read is the most recent one, not a stale
// earlier redraw, and (b) prose is never mistaken for a spinner frame, so "compacted 30k tokens" in
// the same chunk can't be read as the counter (roborev on da7c80c). Walking PAST figure-less frames
// matters because Claude drops the counter from some redraws: stopping at the newest marker frame
// alone would read null and skip both the comparison AND the baseline update for that chunk, silently
// delaying recovery (roborev 46783).
export function latestSpinnerTokens(chunk: string): number | null {
  const frames = chunk.split(/[\r\n]/);
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i] ?? "";
    if (!isSpinnerFrame(frame)) continue;
    const tokens = parseSpinnerTokens(frame);
    if (tokens !== null) return tokens;
  }
  return null;
}

const IDLE_MS = 2500;
const BLOCKED_MS = 25000;
// Spinner ticks ~1/s; if we don't see it for this long the turn has ended.
const SPINNER_GRACE_MS = 2000;
// How many ingested lines the "the user just submitted a message" echo-suppression window lasts
// (Fix 2). Bounded so it can't permanently mask a LATER genuine wedge: after this many lines with
// no further user input (and no progress event, which also clears it), detection re-arms fully.
const USER_INPUT_ECHO_WINDOW_LINES = 200;
// Below this noted-text length, echo suppression uses exact line equality only — a 1-2 char user
// message must not broadly suppress detection via a bare substring match (roborev).
const ECHO_SUBSTRING_MIN_CHARS = 8;
// Cap the unterminated-line buffer. The spinner redraws without a trailing newline, so
// `partial` would otherwise grow for the whole turn (memory + O(n^2) prompt scans). Prompt
// and spinner markers are short, so a bounded tail keeps detection intact.
const MAX_PARTIAL = 4096;

export interface StatusEngineOpts {
  agentId: string;
  onStatus: (s: AgentTabStatus) => void;
  // Returns a plain-text snapshot of the *rendered* terminal screen (the visible xterm
  // grid). Read on settle to decide red (a question is on screen) vs gray (a finished
  // turn). Optional: without it, settle falls back to gray/idle.
  getScreen?: () => string;
}

export class StatusEngine {
  private partial = "";
  private status: AgentTabStatus = "working";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private blockedTimer: ReturnType<typeof setTimeout> | null = null;
  private sawRecentRisk = false;
  private sawRecentError = false;
  // Sticky: once we've seen Claude's spinner we trust it over the time heuristic.
  private sawSpinner = false;
  // Sticky (sparkle-pqxh): the stream is mid-stream FAILED/STALLED — an API-error banner the agent
  // kept churning under, or a self-prompt loop. Unlike `sawRecentError` (a one-shot flag consumed at
  // exit/settle), this drives a live RED `errored` WHILE the process is alive, and it OVERRIDES the
  // spinner: the bug is precisely that the spinner keeps ticking while the agent is wedged. Cleared
  // only by real forward progress (a classified tool/file event) or a real interactive prompt.
  private sawStreamFailure = false;
  // WHICH shape of failure latched `sawStreamFailure`, because only one of them is safe to clear on
  // token progress (roborev on da7c80c):
  //   "api"   — a transient API/server banner. The request failed; nothing was generated under it, so
  //             a climbing token counter is genuine proof the agent recovered and is generating again.
  //   "churn" — a self-prompt loop or a repeating-line churn wedge. A wedged agent GENERATES its own
  //             pings, so its token counter climbs too; token progress here proves nothing and must
  //             NEVER clear the red. Only real progress (a classified tool event), a real prompt, or
  //             user input clears a churn wedge — the original sparkle-pqxh contract.
  // "churn" outranks "api": once churn is seen, a later banner must not downgrade it to clearable.
  private failureKind: "api" | "churn" | null = null;
  // The token count from the most recent spinner frame that carried one, so a strictly-higher count
  // on a later frame proves the model is still GENERATING (forward progress) and clears a sticky
  // mid-stream failure — the healthy-but-transiently-blipped case (see the recovery in ingest). Null
  // until the first spinner frame with a token figure; a lone frame only sets the baseline (a frozen
  // count must never read as progress), so recovery needs a genuine frame-to-frame increase.
  // RESET AT EVERY TURN BOUNDARY (settle, noteUserInput — NOT a mid-turn prompt): Claude's counter is PER-TURN and
  // restarts low, so a stale high-water mark from a long previous turn would make the whole recovery
  // a silent no-op until the new turn out-grew it (roborev on da7c80c).
  private lastSpinnerTokens: number | null = null;
  private readonly failure = new StreamFailureDetector();
  // Fix 2 (Bug B): the normalized text of the message the user MOST RECENTLY submitted to this
  // agent, set by noteUserInput(). The TUI echoes the user's own input back into pty:output, so an
  // echo of "hey Sparkler" or "Are you there? Give me an update." would otherwise trip the
  // self-prompt/churn detector and paint a healthy, resuming agent RED. While this is set, any
  // ingested line that IS that echo is skipped for failure detection. Bounded by a line countdown
  // (and cleared on real progress) so it can never mask a later genuine wedge.
  private notedUserText = "";
  private notedUserLinesLeft = 0;

  constructor(private readonly opts: StatusEngineOpts) {
    this.opts.onStatus(this.status);
  }

  private set(s: AgentTabStatus): void {
    if (s !== this.status) {
      this.status = s;
      this.opts.onStatus(s);
    }
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.blockedTimer) clearTimeout(this.blockedTimer);
    this.idleTimer = null;
    this.blockedTimer = null;
  }

  // The ONE way into the sticky mid-stream failure, so the flag and the kind that governs its
  // recovery can never drift apart. "churn" outranks "api" (see failureKind).
  private tripStreamFailure(kind: "api" | "churn"): void {
    this.sawStreamFailure = true;
    if (kind === "churn" || this.failureKind === null) this.failureKind = kind;
  }

  // The ONE way out of it: every recovery path (a classified tool event, a real prompt, user input, a
  // token advance) must drop the flag, the kind AND the churn counters together — a leftover kind or
  // a half-counted repeat re-arms red on the next line.
  private clearStreamFailure(): void {
    this.sawStreamFailure = false;
    this.failureKind = null;
    this.failure.reset();
  }

  // A turn boundary (the turn settling, or the user submitting the next message — an approval prompt
  // is asked MID-turn and is deliberately NOT one): forget the spinner token baseline. Claude's
  // counter is per-turn and restarts low, so carrying a previous turn's high-water mark into the next
  // turn would silently disable the token-advance recovery (roborev on da7c80c).
  private resetSpinnerTokens(): void {
    this.lastSpinnerTokens = null;
  }

  /**
   * The user just submitted a message to this agent (Fix B / Bug B). Their presence is the
   * STRONGEST recovery signal: a NEW turn is starting and any prior stall/error latched from earlier
   * output is, by definition, stale — the user is here and driving. So:
   *   1. Clear the sticky/one-shot failure+error+risk flags and reset the churn detector, so a
   *      resuming spinner is no longer OVERRIDDEN by a dead `sawStreamFailure` and can go green. We
   *      do NOT force a color here — the next ingest/spinner tick classifies — we only lift the
   *      override so the real signal wins. (A genuine wedge with NO user input still goes red; the
   *      spinner alone never clears a stall — see sparkle-pqxh.)
   *   2. Record the submitted text (normalized) so its ECHO in the ingested output is not mistaken
   *      for a self-prompt/churn ping (Fix 2). Bounded to a line window so a LATER genuine wedge is
   *      still caught.
   */
  noteUserInput(text: string): void {
    this.clearStreamFailure();
    this.sawRecentError = false;
    this.sawRecentRisk = false;
    // A new turn starts here, and its token counter restarts from zero.
    this.resetSpinnerTokens();
    // stripAnsi also strips the bracketed-paste ESC[200~/ESC[201~ wrappers submitPrompt adds (they
    // are CSI sequences), so this normalizes both raw text and paste-wrapped payloads the same way.
    const norm = stripAnsi(text).trim().toLowerCase();
    this.notedUserText = norm;
    this.notedUserLinesLeft = norm ? USER_INPUT_ECHO_WINDOW_LINES : 0;
  }

  // True when `lowerLine` (an already-lowercased, trimmed ingested line) is an echo of the message
  // the user just submitted — so it must not be read as a self-prompt/churn wedge (Fix 2). Matches
  // when the line equals the noted text, is a fragment OF it (a multi-line message echoes line by
  // line), or contains it (an echo decorated with a prompt marker). The two SUBSTRING directions are
  // gated on a minimum noted-text length: a tiny submission ("ok", "go") must fall back to
  // exact-equality only, or `lowerLine.includes("go")` would suppress detection on any line that
  // merely contains that token for the whole window (roborev). Only meaningful while the window is open.
  private isUserEchoLine(lowerLine: string): boolean {
    if (this.notedUserLinesLeft <= 0 || !this.notedUserText || !lowerLine) return false;
    if (this.notedUserText === lowerLine) return true;
    if (this.notedUserText.length < ECHO_SUBSTRING_MIN_CHARS) return false;
    return this.notedUserText.includes(lowerLine) || lowerLine.includes(this.notedUserText);
  }

  // The turn has gone quiet (spinner stopped, or the legacy timer fired). Decide red vs
  // gray from the *rendered* screen: if Claude is showing a question/approval menu, the
  // user is on the hook (waiting/approval, red); otherwise the turn simply ended (idle,
  // gray). Reaching a calm settle means the session didn't crash — clear the error flag
  // so a later clean exit isn't mislabeled `errored`.
  private settle(): void {
    this.idleTimer = null;
    this.sawRecentError = false;
    // The turn is over; the next one's spinner counter starts from zero, so drop the baseline rather
    // than carry this turn's high-water mark into it (roborev on da7c80c).
    this.resetSpinnerTokens();
    const screen = this.opts.getScreen?.() ?? "";
    const awaiting = screenAwaitsInput(screen);
    // Consume the risk flag on every settle, not just the red branch: a non-blocking
    // turn that ends idle must not carry a stale risk into the next turn's question.
    const risky = this.sawRecentRisk;
    this.sawRecentRisk = false;
    this.set(awaiting ? (risky ? "approval" : "waiting") : "idle");
  }

  // Fallback path only: arm the legacy time-based stall timers (used when Claude's
  // spinner has never been observed, e.g. a non-Claude program or TUI drift).
  private armLegacyTimers(): void {
    this.clearTimers();
    this.idleTimer = setTimeout(() => this.settle(), IDLE_MS);
    this.blockedTimer = setTimeout(() => {
      // Escalate from working OR idle (idle fires first at IDLE_MS, so gating on
      // "working" alone made `blocked` unreachable).
      if (this.status === "working" || this.status === "idle") this.set("blocked");
    }, BLOCKED_MS);
  }

  /** Feed a raw PTY chunk. Splits into lines, classifies, updates status. */
  ingest(chunk: string): void {
    const clean = stripAnsi(chunk);
    // The frame that was still being drawn before this chunk landed (everything after the partial's
    // last \r). Joined with the incoming text below, it is how the partial-banner check counts what
    // ARRIVED in this chunk without ever re-scanning the whole buffer — see that check for why.
    const carry = this.partial.slice(this.partial.lastIndexOf("\r") + 1);
    this.partial += clean;
    const lines = this.partial.split(/\r?\n/);
    this.partial = lines.pop() ?? "";
    // The spinner redraws in place without a trailing newline, so an unterminated line can
    // accumulate for a whole turn. Keep only the tail: prompt/spinner markers are short and
    // land at the end, so a bounded buffer preserves detection while bounding memory + scan cost.
    if (this.partial.length > MAX_PARTIAL) this.partial = this.partial.slice(-MAX_PARTIAL);

    let prompt = false;
    // Whether THIS chunk freshly observed a failure line (an API banner, a self-prompt/churn repeat).
    // The token-advance recovery below is suppressed when true, so a churn/self-prompt chunk that
    // happens to also carry an advancing spinner can never clear the very failure it just tripped —
    // the repeated bad lines keep re-arming red, which is the intended sticky behavior.
    let trippedThisChunk = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (ERROR_PATTERNS.some((re) => re.test(line))) this.sawRecentError = true;
      const ev = classifyLine(line, { sessionId: this.opts.agentId });
      if (ev) {
        // A classified tool/file event is genuine forward progress — the agent is doing real work
        // again, not churning on a dead API call. Clear any sticky mid-stream failure (sparkle-pqxh)
        // and reset the churn counter so post-recovery output starts fresh. Real progress also ends
        // the user-input echo window (Fix 2): from here a repeated self-ping is a fresh wedge again.
        this.clearStreamFailure();
        this.notedUserText = "";
        this.notedUserLinesLeft = 0;
      }
      if (ev?.event_type === "approval_needed") this.sawRecentRisk = true;
      // Mid-stream failure/stall while the process is alive (sparkle-pqxh). Only observed when this
      // line did NOT classify as a tool/file event — a classified line is unambiguous progress, and
      // `if (ev)` above just reset the detector, so re-observing it (a tool arg/path that happens to
      // contain "api error") must not re-trip the failure (roborev 16153). The detector keys off the
      // visible \r-frame, so a banner fused onto a spinner redraw is still caught. Sticky once
      // tripped; only the recovery paths (a real tool event above, a real prompt below, or
      // noteUserInput) clear it. Fix 2: an echo of the user's own just-submitted message is NOT a
      // wedge — skip it entirely so it neither trips a self-prompt nor accrues churn.
      else if (!ev && !this.isUserEchoLine(line.toLowerCase()) && this.failure.observe(line)) {
        // A banner is an "api" failure (clearable by token progress); ANY other trip is a
        // self-prompt/churn wedge, which generates its own tokens and so is NEVER token-clearable.
        // A banner that REPEATS stays "api" on purpose: a long turn can survive several transient
        // blips while genuinely generating, and escalating repeats to "churn" would pin exactly that
        // healthy agent red — the false-red this whole line of work exists to kill. A retry loop with
        // no generation is still caught, by the frozen-counter rule.
        this.tripStreamFailure(isApiErrorLine(line) ? "api" : "churn");
        trippedThisChunk = true;
      }
      if (screenAwaitsInput(line)) prompt = true;
      // Spend one tick of the user-input echo window per non-empty line, so it can't mask a later
      // genuine wedge (Fix 2). Decremented AFTER this line's echo check so the final in-window line
      // is still covered (no boundary off-by-one). When it runs out, drop the noted text so
      // detection re-arms fully. A classified tool event above already cleared it (real progress).
      if (this.notedUserLinesLeft > 0 && --this.notedUserLinesLeft === 0) this.notedUserText = "";
    }
    // Claude prints its input prompt without a trailing newline — check the partial too.
    if (screenAwaitsInput(this.partial)) prompt = true;

    // An API-error banner can also sit in the still-unterminated partial: the spinner redraws without
    // a newline, so a fused banner may not have flushed as a completed line yet. This catches it so
    // detection isn't one missing '\n' away from silently not firing (roborev 16152). The banner-count
    // history that forced the current shape: keying on banner TEXT missed a verbatim-repeated banner
    // (a retry loop re-emits the same string — fail-OPEN, 46783/46899); a whole-partial COUNT stalled
    // once the MAX_PARTIAL trim started evicting one banner per arrival (fail-OPEN again, 46920). So
    // we diff banner frames to isolate ARRIVALS. Full rationale on `apiErrorFramesIn`.
    //
    // Scope: the UNTERMINATED TAIL ONLY, with the SAME user-echo guard the loop applies. Completed
    // lines are the loop's job; scanning them here re-counted a pasted "API Error: …" report the loop
    // deliberately skips (Fix 2), false-redding a healthy agent (47232/47233). Scoping to the tail
    // fixed the '\n'-terminated shape but not the common one — a TUI input-box redraw echoes with NO
    // trailing '\n', landing the echo entirely in the tail — so the guard must apply here too
    // (47981/47996). `base` is the already-flushed prefix (empty when this chunk had a '\n'; else
    // `carry`), so `arrived` is exactly the banner frames the tail ADDED; we then drop any that are an
    // echo of the user's own just-submitted message. The tool-event exemption (16153) needs no guard
    // here: a frame that later completes as a classified line hits the `if (ev)` clear above, and no
    // real tool-event line begins with "api error:" anyway.
    const nl = clean.lastIndexOf("\n");
    const base = nl >= 0 ? "" : carry; // a '\n' flushed carry + everything before it through the loop
    const tail = nl >= 0 ? clean.slice(nl + 1) : clean;
    const arrived = apiErrorFramesIn(base + tail)
      .slice(countApiErrorFrames(base))
      .filter((f) => !this.isUserEchoLine(f.toLowerCase()));
    if (arrived.length > 0) {
      this.tripStreamFailure("api");
      trippedThisChunk = true;
    }

    // The spinner status line is re-drawn in place (often no trailing newline), so scan the whole
    // cleaned chunk rather than only completed lines — but FRAME BY FRAME, so the persistent footer
    // bar can't be mistaken for a running turn. See the WORKING_PATTERNS header.
    const hasSpinner = hasSpinnerFrame(clean);
    if (hasSpinner) this.sawSpinner = true;

    // Token-advance recovery (sparkle-pqxh follow-up): after an API BANNER the request that failed
    // generated nothing, so a strictly-higher spinner token count is positive proof the agent is
    // generating again — the same thing a classified tool event proves. This rescues the false-red
    // where a HEALTHY agent hit a transient API blip early in a long turn and kept streaming tokens
    // with no tool event yet ("Incubating… ↓ 2.1k tokens"): without it the sticky flag pinned the row
    // red for the rest of the turn. Guards, each one load-bearing:
    //   (a) `failureKind === "api"` — a self-prompt/churn wedge GENERATES its own pings, so its
    //       counter climbs too; letting tokens clear it would make the pqxh wedge flap red↔green
    //       (roborev on da7c80c). Churn only clears on real progress / a prompt / user input.
    //   (b) only a genuine frame-to-frame INCREASE clears — a repeated/frozen count (the rate-limit
    //       retry loop, and the tests' static spinner) does not, preserving "sticky until progress".
    //   (c) `!trippedThisChunk` so a chunk that itself observed a failure line can't self-clear.
    //   (d) the figure is read from the NEWEST SPINNER FRAME only, so prose in the same chunk that
    //       mentions "30k tokens" is neither mistaken for the counter nor able to poison the baseline.
    // The baseline is tracked regardless of failure state (and reset at every turn boundary) so the
    // first frame after a blip already has something real to compare against.
    if (hasSpinner && !trippedThisChunk) {
      const tokens = latestSpinnerTokens(clean);
      if (tokens !== null) {
        if (
          this.sawStreamFailure &&
          this.failureKind === "api" &&
          this.lastSpinnerTokens !== null &&
          tokens > this.lastSpinnerTokens
        ) {
          this.clearStreamFailure();
          // Token progress is real progress, so — like a classified tool event — it also closes the
          // user-input echo window: from here a repeated self-ping is a fresh wedge again.
          this.notedUserText = "";
          this.notedUserLinesLeft = 0;
        }
        this.lastSpinnerTokens = tokens;
      }
    }

    // 1. An input prompt always wins: the agent is asking for you.
    if (prompt) {
      this.clearTimers();
      this.set(this.sawRecentRisk ? "approval" : "waiting");
      this.sawRecentRisk = false;
      // A calm prompt means the agent recovered and is awaiting you — not a crash or a stall. The
      // token baseline deliberately SURVIVES here: an approval question is asked MID-turn and the
      // counter keeps climbing from where it was once you answer, so dropping it would throw away a
      // still-valid high-water mark. The true boundaries — the turn settling, and the user submitting
      // the next message — reset it (roborev 46783).
      this.sawRecentError = false;
      this.clearStreamFailure();
      return;
    }

    // 1b. Mid-stream failure/stall (sparkle-pqxh): the agent printed an API-error banner and kept
    //     churning, or fell into a self-prompt loop, all while its process stays alive. Fail CLOSED
    //     to red `errored` and OVERRIDE the spinner below — the whole bug is that the spinner keeps
    //     ticking (so it looked "working") while the agent is wedged. The router lifts this to red
    //     even over a hook `working`. Recovery clears it above (a real tool event / a real prompt).
    if (this.sawStreamFailure) {
      this.clearTimers();
      this.set("errored");
      return;
    }

    // 2. Spinner visible → actively working. Re-arm the "spinner gone" settle timer so
    //    the turn settles to idle only after the spinner truly stops re-drawing.
    if (hasSpinner) {
      this.clearTimers();
      this.set("working");
      this.idleTimer = setTimeout(() => this.settle(), SPINNER_GRACE_MS);
      return;
    }

    // 3. Spinner mode, but no spinner in this chunk: either a frame between ticks or the
    //    post-turn idle screen. Don't force-flip — let the settle timer from the last
    //    spinner sighting decide. If none is pending (idle screen drew first), arm one.
    if (this.sawSpinner) {
      if (!this.idleTimer) this.idleTimer = setTimeout(() => this.settle(), SPINNER_GRACE_MS);
      return;
    }

    // 4. Fallback (spinner never seen): legacy output-flow + stall heuristic.
    this.set("working");
    this.armLegacyTimers();
  }

  /** Call when the PTY exits. */
  exit(): void {
    this.clearTimers();
    // A process that dies mid-stream-failure (an API error / self-prompt wedge that never recovered)
    // must read `errored`, not gray `done`: sawStreamFailure counts the same as a pre-exit error
    // marker here, so a wedged-then-killed agent doesn't settle green-gray (roborev 16152).
    this.set(this.sawRecentError || this.sawStreamFailure ? "errored" : "done");
  }

  dispose(): void {
    this.clearTimers();
  }
}
