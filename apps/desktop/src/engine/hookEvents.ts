// hookEvents (): derive agent status from Claude Code's own hook events instead
// of screen-scraping its TUI. Claude Code runs a command hook on lifecycle transitions
// (PreToolUse, Notification, Stop, SessionEnd, …); Sparkle registers a tiny emitter
// (resources/sparkle-hook.mjs) in each worktree's .claude/settings.local.json that appends
// one JSON line per event to a per-agent log. This module turns those structured events
// into the same AgentTabStatus taxonomy the UI already understands — deterministically,
// with none of the heuristics statusEngine.ts needs to recover state from rendered pixels.
//
// This is the authoritative status path for real `claude` agents. statusEngine.ts (TUI
// scraping) stays as the fallback for non-Claude programs and for the brief window before
// the first hook fires, so nothing regresses.
import type { AgentTabStatus } from "@sparkle/ui";

/** One normalized hook event, as written to the per-agent JSONL log by sparkle-hook.mjs.
 *  Mirrors the fields Claude Code passes a hook on stdin (snake_case preserved). */
export interface HookEvent {
  /** Claude Code's `hook_event_name` (PreToolUse, Notification, Stop, …). */
  event: string;
  /** `tool_name` for Pre/PostToolUse. */
  tool?: string;
  /** Notification `message` — distinguishes a permission request from an idle ping. */
  message?: string;
  /** Epoch ms the emitter stamped the event. */
  ts?: number;
  session_id?: string;
  /** UserPromptSubmit: the user's submitted prompt text (history capture, ). */
  prompt?: string;
  /** Stop: path to Claude Code's session transcript JSONL. Mapped from the raw `transcript_path`
   *  the emitter passes through; used to read the last assistant turn for history capture. */
  transcriptPath?: string;
}

// A Notification fires for two very different reasons: when Claude needs permission for a tool
// ("…needs your permission to use Bash") and when the prompt has simply sat IDLE (~60s) after a
// turn ended. Only the permission case is a genuine "approve this?" that should go red. The idle
// ping is NOT the agent asking you anything — it fires after the turn is already over (often while
// a background shell keeps running) — so it must stay gray, never red. Red is reserved for real
// approval prompts; treating the idle ping as red was the false-red bug (an agent that's done or
// working in the background showing as if it were blocking on you).
const PERMISSION_RE = /\b(permission|approve|allow)\b/i;

/** Pure map from a single hook event to a status, or null when the event shouldn't change it.
 *  Latest-event-wins: Claude's lifecycle is linear (prompt → tools → stop), so each event
 *  fully determines the current state without needing history. */
export function hookEventToStatus(ev: HookEvent): AgentTabStatus | null {
  switch (ev.event) {
    // A session merely STARTING (a fresh spawn, or a `--continue` resume on app launch) is not
    // the agent working — it's sitting at the prompt, idle, until you send something. Mapping it
    // to "working" was the bug behind every agent glowing green on launch: SessionStart fires with
    // no Stop after it (there's no turn to stop), so the green never cleared. Idle (gray, "your
    // turn") is the truthful resting state; the very next UserPromptSubmit flips it to green.
    case "SessionStart":
      return "idle";
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    // A subagent finishing doesn't end the main turn — Claude keeps working.
    case "SubagentStop":
      return "working";
    case "Notification":
      // Permission request → red (approval). Any other notification is Claude's idle ping after a
      // finished turn → gray (idle), NOT a red "needs you". See PERMISSION_RE note above.
      return PERMISSION_RE.test(ev.message ?? "") ? "approval" : "idle";
    // Claude finished responding for this turn: done with its turn, not blocked on you (gray).
    case "Stop":
      return "idle";
    case "SessionEnd":
      return "done";
    default:
      // PreCompact and anything we don't model leave the status untouched.
      return null;
  }
}

/** Parse one line of the JSONL event log. Defensive: returns null for blank/partial/malformed
 *  lines and for valid JSON that isn't an event object, so a half-written tail never throws. */
export function parseHookLine(line: string): HookEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { event?: unknown }).event !== "string"
  ) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  const ev = parsed as HookEvent;
  // Map the emitter's snake_case `transcript_path` onto the camelCase `transcriptPath` the rest of
  // the app uses (). Tolerant: a missing/non-string field simply leaves it undefined.
  if (typeof raw.transcript_path === "string") {
    ev.transcriptPath = raw.transcript_path;
    delete (raw as { transcript_path?: unknown }).transcript_path;
  }
  return ev;
}

export interface HookStatusEngineOpts {
  agentId: string;
  onStatus: (s: AgentTabStatus) => void;
}

/** Events that (re)open the main turn — only a new prompt or session start. Notably NOT tool
 *  events: a background subagent's PreToolUse/PostToolUse must not reopen a turn closed by Stop. */
const TURN_OPENERS = new Set(["SessionStart", "UserPromptSubmit"]);
/** Events that close the main turn (Claude finished its turn, or the session ended). */
const TURN_CLOSERS = new Set(["Stop", "SessionEnd"]);

/** Stateful adapter mirroring StatusEngine's onStatus/dedup contract so callers can swap it in
 *  wherever the scraping engine is wired. It carries the two pieces of history the pure,
 *  latest-event-wins `hookEventToStatus` can't:
 *
 *  1. SESSION LOCK. The per-agent hook log is keyed by worktree, so it interleaves the main
 *     interactive agent with background one-shot `claude` calls run in the same worktree (each a
 *     full SessionStart→…→SessionEnd) AND its subagents (whose events carry the MAIN session_id).
 *     We lock onto the first session_id we see — and because the watcher starts at EOF
 *     (skipExisting), that first event is the freshly-spawned main agent's. Events from any OTHER
 *     session are ignored, so a concurrent background call's Stop/SessionEnd can't flip this tab.
 *
 *  2. TURN-CLOSED. Once the main turn closes (Stop/SessionEnd), trailing background-subagent
 *     events under the same (main) session_id must not resurrect the finished tab to green:
 *     PreToolUse/PostToolUse are ignored, and a trailing SubagentStop settles to idle (gray).
 *
 *  Starts from a null status baseline (does NOT emit on construction): the first real event must
 *  always reach the UI, so seeding a concrete baseline would let dedup swallow it. `turnClosed`
 *  starts false so a first tool event (watcher attaching mid-turn) still reads "working". */
export class HookStatusEngine {
  private status: AgentTabStatus | null = null;
  private mainSession: string | null = null;
  private turnClosed = false;

  constructor(private readonly opts: HookStatusEngineOpts) {}

  private set(s: AgentTabStatus): void {
    if (s !== this.status) {
      this.status = s;
      this.opts.onStatus(s);
    }
  }

  /** Feed one parsed hook event. Unknown events leave the status unchanged. */
  ingest(ev: HookEvent): void {
    // Session lock: adopt the first session_id we see as the main agent's; drop any other
    // session's events (events with no session_id at all are kept — defensive for older logs).
    // ASSUMPTION: the main agent's first post-EOF event precedes any background `claude` call it
    // later spawns — true at spawn, when nothing else is running yet. A re-prepare while a prior
    // background one-shot is still mid-flight could mis-lock onto that background session; this is
    // rare and accepted (a fresh spawn re-creates the engine and re-locks correctly).
    if (ev.session_id) {
      if (this.mainSession === null) this.mainSession = ev.session_id;
      else if (ev.session_id !== this.mainSession) return;
    }

    if (TURN_OPENERS.has(ev.event)) this.turnClosed = false;
    else if (TURN_CLOSERS.has(ev.event)) this.turnClosed = true;

    // After the turn has closed, trailing background-subagent events (same main session_id) must
    // not flip the finished tab back to green: tool calls are ignored, and a trailing SubagentStop
    // settles the agent's background work to idle (gray). We don't clobber a terminal `done`
    // (SessionEnd). A post-close `waiting` CAN occur — the idle-ping Notification ("Claude is
    // waiting for your input") fires ~60s after Stop and maps to waiting (red) — but it's benign
    // ("your turn"), not a real blocking question (those only arrive mid-turn), so overriding it
    // to gray on a trailing SubagentStop is intentional. (Whether the idle-ping itself should read
    // gray rather than red is a separate, still-open question.)
    if (this.turnClosed) {
      if (ev.event === "PreToolUse" || ev.event === "PostToolUse") return;
      if (ev.event === "SubagentStop") {
        if (this.status !== "done") this.set("idle");
        return;
      }
    }

    const next = hookEventToStatus(ev);
    if (next) this.set(next);
  }
}
