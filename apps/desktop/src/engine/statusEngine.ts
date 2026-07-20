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
import { StreamFailureDetector, isApiErrorLine } from "./streamFailure";

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

// Claude Code's live "working" status line, re-drawn ~once a second while it is busy.
// "esc to interrupt" is the stable marker across spinner glyph / wording changes.
const WORKING_PATTERNS: RegExp[] = [/esc to interrupt/i];

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
    this.sawStreamFailure = false;
    this.sawRecentError = false;
    this.sawRecentRisk = false;
    this.failure.reset();
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
    this.partial += clean;
    const lines = this.partial.split(/\r?\n/);
    this.partial = lines.pop() ?? "";
    // The spinner redraws in place without a trailing newline, so an unterminated line can
    // accumulate for a whole turn. Keep only the tail: prompt/spinner markers are short and
    // land at the end, so a bounded buffer preserves detection while bounding memory + scan cost.
    if (this.partial.length > MAX_PARTIAL) this.partial = this.partial.slice(-MAX_PARTIAL);

    let prompt = false;
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
        this.sawStreamFailure = false;
        this.failure.reset();
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
        this.sawStreamFailure = true;
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

    // An API-error banner can also sit in the still-unterminated partial: the spinner redraws
    // without a newline, so a fused banner may not have flushed as a completed line yet. Mirror the
    // partial prompt-check above so detection isn't one missing '\n' away from silently not firing
    // (roborev 16152). Only the API-error signal (which keys off the visible \r-frame and trips on a
    // single occurrence), NOT self-prompt — a self-prompt is a wedge only once it REPEATS (Bug A),
    // and repetition needs discrete completed lines the detector counts, so a lone self-ping in the
    // partial must NOT trip. Set-only (never clears), keeping it sticky.
    if (!this.sawStreamFailure && isApiErrorLine(this.partial)) {
      this.sawStreamFailure = true;
    }

    // The spinner status line is re-drawn in place (often no trailing newline), so test
    // the whole cleaned chunk rather than only completed lines.
    const hasSpinner = WORKING_PATTERNS.some((re) => re.test(clean));
    if (hasSpinner) this.sawSpinner = true;

    // 1. An input prompt always wins: the agent is asking for you.
    if (prompt) {
      this.clearTimers();
      this.set(this.sawRecentRisk ? "approval" : "waiting");
      this.sawRecentRisk = false;
      // A calm prompt means the agent recovered and is awaiting you — not a crash or a stall.
      this.sawRecentError = false;
      this.sawStreamFailure = false;
      this.failure.reset();
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
