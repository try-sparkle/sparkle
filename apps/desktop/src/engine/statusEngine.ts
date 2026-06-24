// statusEngine (spec §6): turns a raw PTY stream into the agent tab status taxonomy.
// Heuristic + retrainable — Claude Code's TUI output format drifts between versions, so
// this leans on the shared @sparkle/core classifier plus prompt/stall/exit detection.
//
// Transitions:
//   spawn            -> working
//   output flowing   -> working   (re-arm idle/blocked timers)
//   a prompt appears -> waiting   (or approval, if a risky action was just seen)
//   quiet > IDLE_MS  -> idle      (alive, awaiting your next prompt)
//   quiet > BLOCKED  -> blocked   (stalled on something external)
//   process exits    -> done      (or errored, if errors were seen)
import { classifyLine } from "@sparkle/core";
import type { AgentTabStatus } from "@sparkle/ui";

// Strip ANSI/control sequences before classifying (xterm still renders the raw bytes).
// Built from a string with \u escapes so the source stays paste-safe (no literal ESC).
// Matches CSI/OSC-style sequences introduced by ESC, plus any stray ESC chars.
// eslint-disable-next-line no-control-regex
const ANSI = new RegExp("\\u001b[\\[\\]()#;?]*[0-9;]*[@-~]|\\u001b", "g");
function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

// Claude (and shells) ask for input in these shapes.
const PROMPT_PATTERNS: RegExp[] = [
  /do you want to proceed/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /❯\s*1\.\s*yes/i,
  /press enter to continue/i,
  /overwrite\?/i,
];

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

const IDLE_MS = 2500;
const BLOCKED_MS = 25000;

export interface StatusEngineOpts {
  agentId: string;
  onStatus: (s: AgentTabStatus) => void;
}

export class StatusEngine {
  private partial = "";
  private status: AgentTabStatus = "working";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private blockedTimer: ReturnType<typeof setTimeout> | null = null;
  private sawRecentRisk = false;
  private sawRecentError = false;

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

  private armTimers(): void {
    this.clearTimers();
    this.idleTimer = setTimeout(() => {
      // Reaching a calm idle means the session didn't crash — clear the error flag so a
      // later clean exit isn't mislabeled `errored`.
      this.sawRecentError = false;
      this.set("idle");
    }, IDLE_MS);
    this.blockedTimer = setTimeout(() => {
      // Escalate from working OR idle (idle fires first at IDLE_MS, so gating on
      // "working" alone made `blocked` unreachable).
      if (this.status === "working" || this.status === "idle") this.set("blocked");
    }, BLOCKED_MS);
  }

  /** Feed a raw PTY chunk. Splits into lines, classifies, updates status. */
  ingest(chunk: string): void {
    this.partial += stripAnsi(chunk);
    const lines = this.partial.split(/\r?\n/);
    this.partial = lines.pop() ?? "";

    let prompt = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (ERROR_PATTERNS.some((re) => re.test(line))) this.sawRecentError = true;
      const ev = classifyLine(line, { sessionId: this.opts.agentId });
      if (ev?.event_type === "approval_needed") this.sawRecentRisk = true;
      if (PROMPT_PATTERNS.some((re) => re.test(line))) prompt = true;
    }
    // Claude prints its input prompt without a trailing newline — check the partial too.
    if (PROMPT_PATTERNS.some((re) => re.test(this.partial))) prompt = true;

    if (prompt) {
      this.clearTimers();
      this.set(this.sawRecentRisk ? "approval" : "waiting");
      this.sawRecentRisk = false;
      // A calm prompt means the agent recovered and is awaiting you — not a crash.
      this.sawRecentError = false;
    } else {
      this.set("working");
      this.armTimers();
    }
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
