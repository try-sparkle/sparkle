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
// prose like "Do you want to proceed?": Claude ends brainstorm turns with exactly that
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
      if (ev?.event_type === "approval_needed") this.sawRecentRisk = true;
      if (screenAwaitsInput(line)) prompt = true;
    }
    // Claude prints its input prompt without a trailing newline — check the partial too.
    if (screenAwaitsInput(this.partial)) prompt = true;

    // The spinner status line is re-drawn in place (often no trailing newline), so test
    // the whole cleaned chunk rather than only completed lines.
    const hasSpinner = WORKING_PATTERNS.some((re) => re.test(clean));
    if (hasSpinner) this.sawSpinner = true;

    // 1. An input prompt always wins: the agent is asking for you.
    if (prompt) {
      this.clearTimers();
      this.set(this.sawRecentRisk ? "approval" : "waiting");
      this.sawRecentRisk = false;
      // A calm prompt means the agent recovered and is awaiting you — not a crash.
      this.sawRecentError = false;
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
    this.set(this.sawRecentError ? "errored" : "done");
  }

  dispose(): void {
    this.clearTimers();
  }
}
