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
  return parsed as HookEvent;
}

export interface HookStatusEngineOpts {
  agentId: string;
  onStatus: (s: AgentTabStatus) => void;
}

/** Stateful adapter mirroring StatusEngine's onStatus/dedup contract so callers can swap it in
 *  wherever the scraping engine is wired. Holds only the current status — the event stream itself
 *  carries all the state we need. Starts from a null baseline and does NOT emit on construction:
 *  the first real event (commonly UserPromptSubmit/PreToolUse → "working") must always reach the
 *  UI, so seeding the baseline with a concrete status would let dedup swallow it. */
export class HookStatusEngine {
  private status: AgentTabStatus | null = null;

  constructor(private readonly opts: HookStatusEngineOpts) {}

  private set(s: AgentTabStatus): void {
    if (s !== this.status) {
      this.status = s;
      this.opts.onStatus(s);
    }
  }

  /** Feed one parsed hook event. Unknown events leave the status unchanged. */
  ingest(ev: HookEvent): void {
    const next = hookEventToStatus(ev);
    if (next) this.set(next);
  }
}
