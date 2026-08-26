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
  /**
   * SessionStart's `source`: `startup` | `resume` | `clear` | `compact` (Claude Code's own matcher
   * vocabulary for the event — the official plugin hooks register exactly
   * `"matcher": "startup|resume|clear|compact"`).
   *
   * LOAD-BEARING for `engine/agentThrash`, because a SessionStart is NOT only a human restarting an
   * agent: Claude Code fires one after every COMPACTION too. Those two demand opposite handling — a
   * restart means the human applied the remedy and prior evidence should be dropped, while a
   * compaction is itself evidence OF context pressure and must not erase the history that proves
   * it. Absent (an older emitter, or any other event) it is simply `undefined`, and the consumer
   * must fail toward keeping evidence rather than destroying it.
   */
  source?: string;
}

// A Notification fires for two very different reasons: when Claude needs permission for a tool
// ("…needs your permission to use Bash") and when the prompt has simply sat IDLE (~60s) after a
// turn ended. Only the permission case is a genuine "approve this?" that should go red. The idle
// ping is NOT the agent asking you anything — it fires after the turn is already over (often while
// a background shell keeps running) — so it must stay gray, never red. Red is reserved for real
// approval prompts; treating the idle ping as red was the false-red bug (an agent that's done or
// working in the background showing as if it were blocking on you).
//
// The `approv` STEM (not the word `approve`) is load-bearing: production payloads say "approval"
// far more than "approve", and `\bapprove\b` MISSES "approval" — the word boundary demands a
// non-word char after the final "e", which "approval" does not have. That gap flipped 77 genuinely
// blocked-on-a-human agents to gray/idle (sparkle-gzu9yc); two source comments elsewhere wrongly
// claimed no Notification fires at all for this case, which is why it went unlooked-at. So this
// alternative carries a leading `\b` (scoping it to word-initial "approv", so "disapprove" and the
// like don't match) but NO trailing boundary — it must span approve/approval/approved/approving.
// `permission` and `allow` keep both boundaries: those are the exact whole words Claude Code emits.
const PERMISSION_RE = /\bpermission\b|\bapprov|\ballow\b/i;

// A handful of tools BLOCK the turn on the user rather than doing work: their PreToolUse fires and
// then Claude sits waiting for an answer, with NO Stop and — unlike a permission request — NO
// Notification (sparkle-t2up). So a PreToolUse for one of these is a real mid-turn "answer me", not
// the agent working. Every OTHER tool (Bash, Read, Edit, Task, …) is the agent working. This is the
// only place the tool name changes the status; the matching PostToolUse maps back to `working`
// (below), so the state self-clears the instant Claude resumes — no screen signal involved, so the
// status-router's mid-turn hook authority (and the founder's false-handback protection) is
// untouched.
//
// `AskUserQuestion` → `questions` (BLUE), NOT `waiting` (RED), as of 2026-08-05.
//
// THIS ONE LINE IS THE WHOLE DETECTION STORY, and it is worth saying why it is not something
// cleverer. Claude Code fires this hook DETERMINISTICALLY whenever an agent opens a question menu:
// no string matching, no model call, no inference from "plan mode plus an idle terminal". The app
// already received this event and already knew the tool's name — it was simply painting the result
// in the alarm colour. So every agent running right now gets the blue treatment with no change to
// how agents behave and nothing new to remember.
//
// The alternative that was explicitly rejected: scraping the terminal for question-shaped prose.
// This repo has tried that twice and both attempts are still in the tree as cautionary tales —
// services/suggestions/pendingQuestion.ts (a regex list, with a documented false-negative
// regression) and services/turnFollowup.ts (which gave up on regex and pays for a Haiku call per
// turn, and whose header records being wrong in BOTH directions, including a fleet-wide false-alarm
// storm on 2026-07-28). A false blue pill trains the founder to ignore the pill, which costs more
// than the state is worth. Structured signal or nothing.
//
// `ExitPlanMode` deliberately stays `approval` (RED). It is the agent DELIVERING a finished plan,
// not asking a question, and "Questions" is the wrong word on a pill for it. That is a judgement
// call about labelling, not a claim that plan delivery is bad news — if the founder wants plan
// hand-offs blue too, this is the line to change and nothing else.
const BLOCKING_TOOL_STATUS: Record<string, AgentTabStatus> = {
  AskUserQuestion: "questions",
  ExitPlanMode: "approval",
};

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
    // A PreToolUse for a BLOCKING tool (AskUserQuestion / ExitPlanMode) is a mid-turn picker → red;
    // every other tool is the agent working. See BLOCKING_TOOL_STATUS above.
    case "PreToolUse":
      return BLOCKING_TOOL_STATUS[ev.tool ?? ""] ?? "working";
    case "UserPromptSubmit":
    case "PostToolUse":
    // A subagent finishing doesn't end the main turn — Claude keeps working.
    // falls through
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
      // PreCompact and anything we don't model leave the STATUS untouched — which is right, since
      // compacting is not a status. It is emphatically NOT ignored, though: PreCompact is the only
      // structured signal that an agent is running out of usable context, and engine/agentThrash
      // consumes it from the same stream to surface that pressure before it degenerates into a
      // compaction retry loop. Returning null here means "no status change", not "discard".
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

/**
 * THE SESSION RULE, as a pure function so there is exactly ONE of it.
 *
 * The per-agent hook log is keyed by WORKTREE, not by session, so it interleaves the main
 * interactive agent with every background one-shot `claude` run in the same worktree (each a full
 * SessionStart→…→SessionEnd) and with its subagents (whose events carry the MAIN session_id). Any
 * consumer of that log has to answer this before it believes anything — {@link HookStatusEngine} and
 * {@link createHookEventHandler} gate on it for the watcher path, and `engine/movementRetraction`
 * gates on it for the `fleet_digest` path, which reads the SAME log off disk and would otherwise
 * read a background one-shot's tool call as the agent resuming.
 *
 * Permissive in both directions where it has to be: an event with no `session_id` (an older emitter)
 * is accepted, and so is anything seen before a lock is adopted — before adoption there is no
 * "other" session to reject it in favour of. Every caller adopts before it gates.
 */
export function isMainSessionId(main: string | null, session: string | null | undefined): boolean {
  if (!session) return true;
  if (main === null) return true;
  return session === main;
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

  /** Does this event belong to the main agent's session? PURE — a query, never a latch, so a caller
   *  can gate on it without accidentally locking onto whatever event it happens to pass. Adoption
   *  is `adoptSession`'s job alone.
   *
   *  Exposed rather than kept inline in `ingest` so every consumer — status, hook liveness, and
   *  history/judge dispatch — gates on the SAME decision instead of duplicating the rule. A
   *  background `claude` in the same worktree must not drive any of them.
   *
   *  Accepts an event with no session_id (defensive, for older logs), and accepts anything while
   *  the lock is unset — before adoption there is no "other" session to reject it in favour of.
   *  That permissive branch is safe because the single real call path, `createHookEventHandler`,
   *  adopts before it gates, so the lock is always already set by the same event. A caller that
   *  gated WITHOUT adopting first would accept one foreign event; don't add one. */
  isMainSession(ev: HookEvent): boolean {
    return isMainSessionId(this.mainSession, ev.session_id);
  }

  /** Adopt the first session_id seen as the main agent's. A COMMAND, named as one — the single
   *  latch path, kept separate from the `isMainSession` query so the two can't be confused.
   *  Idempotent after the first adopting call. `createHookEventHandler` — the real call path — calls
   *  this once per event, before any gate; `ingest` also calls it so a direct `ingest()` (tests, or
   *  any future caller wiring the engine on its own) still locks on correctly.
   *
   *  ASSUMPTION: the main agent's first post-EOF event precedes any background `claude` call it
   *  later spawns — true at spawn, when nothing else is running yet. A re-prepare while a prior
   *  background one-shot is still mid-flight could mis-lock onto that background session; this is
   *  rare and accepted (a fresh spawn re-creates the engine and re-locks correctly). */
  adoptSession(ev: HookEvent): void {
    if (ev.session_id && this.mainSession === null) this.mainSession = ev.session_id;
  }

  /** Feed one parsed hook event. Unknown events leave the status unchanged. */
  ingest(ev: HookEvent): void {
    this.adoptSession(ev);
    if (!this.isMainSession(ev)) return;

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

/** Wiring for `createHookEventHandler` — the four consumers of a hook event, injected so the
 *  handler is testable without AgentPane's worktree/PTY/store surface. */
export interface HookEventHandlerDeps {
  engine: HookStatusEngine;
  /** `router.activate()` — "a real event arrived, hooks own the status now". Also stamps the
   *  router's hook-liveness clock, which is why it MUST NOT see foreign sessions. */
  activate: () => void;
  /** Persist prompts/responses to history (and dispatch the followup judge). */
  captureHistory: (ev: HookEvent) => void;
  /**
   * Park what this event says about WHERE this agent's conversation lives and WHOSE it is —
   * `components/AgentPane.noteTranscriptFromHook`. Two registrations, from the same gated stream:
   *
   *   • a Stop event's transcript PATH, for the concierge's terminal read chain (tier d);
   *   • every event's `session_id`, which is what lets the mounted concierge pane tell this agent's
   *     transcript apart from every other `claude` that has run in the same worktree.
   *
   * REQUIRED, not optional, and that is the point of it living here rather than inline in the
   * component. A Stop event is the only place a session transcript path is ever known, and the
   * concierge's `readAgentTerminal` has no other way to obtain one — it refuses to guess a path, and
   * it no longer accepts one as a caller argument (a tool argument naming a file to read is an
   * arbitrary-file read whose contents land in an LLM context). So this hand-off is the entire
   * difference between a four-tier read chain and a three-tier one, and when it lived as a line
   * inside AgentPane's capture closure, deleting it broke nothing that any test could see. As a
   * required dep, dropping it is a compile error.
   *
   * THE SESSION HALF RAISES THE STAKES OF THE GATE ABOVE, rather than adding a new requirement:
   * registering a foreign session id here would point the pane at another agent's words with full
   * confidence — the exact wrong-attribution defect the binding exists to remove. The gate in
   * `createHookEventHandler` already covers it; this note is so nobody moves this call in front of it.
   */
  noteTranscript: (ev: HookEvent) => void;
  /**
   * Fold the event into the agent's thrash/context-pressure accumulator
   * (`engine/agentThrash.noteThrashEvent`).
   *
   * REQUIRED rather than optional, for the same reason `noteTranscript` is: this is the ONLY place
   * the app sees `PreToolUse.tool`, `UserPromptSubmit.prompt` and `PreCompact` together, and they
   * are the entire evidence base for telling a working agent from one repeating a failing command.
   * As a required dep, dropping it is a compile error rather than a silent return to screen-only
   * signals — which is precisely the regression that let a three-`/compact` loop read as healthy.
   */
  noteThrash: (ev: HookEvent) => void;
}

/**
 * The watcher callback: what happens when one line lands in the per-agent hook log.
 *
 * Extracted from AgentPane so the ORDER encoded here — which is load-bearing three times over — is
 * stated once and tested directly, rather than living inline in a component with no test harness:
 *
 *  1. `adoptSession` first, so the very first event of the run sets the lock.
 *  2. The session gate SECOND, before anything else, so a background `claude` sharing this
 *     worktree's log drives NOTHING. It must not reach `captureHistory` (its Stop would be read,
 *     judged, and fromJudge("waiting")-ed onto this agent's row; its UserPromptSubmit would bump
 *     the turn counter and make the turn-token guard discard a legitimate verdict), it must not
 *     reach `noteTranscript` (a foreign session's transcript path registered against this agent
 *     would point the concierge's tier (d) at ANOTHER session's words and report them as this
 *     agent's, with full confidence), and it must not reach `activate` (which stamps the
 *     hook-liveness clock — a chatty background session would keep the clock fresh and defeat the
 *     status router's staleness watchdog precisely when the main session's own stream is dead or
 *     mis-locked).
 *  3. `activate` BEFORE `ingest`, because ingest drives the router's fromHook, which only emits once
 *     hooks are live — activating after it would swallow the first event's status.
 *  4. `noteTranscript` BEFORE `captureHistory`, so the registry write does not ride on the history
 *     store resolving. `captureHistory` reads `useHistoryStore.getState()` inside its own
 *     error-swallowing try, and a throw there must not cost the concierge its transcript path.
 *  5. `noteThrash` sits INSIDE the session gate with everything else. A background `claude` in the
 *     same worktree runs its own prompts and its own tools; counting those would both mask a real
 *     no-progress streak (a foreign tool call reads as this agent working) and manufacture false
 *     repetition. It goes before `captureHistory` for the same reason `noteTranscript` does — that
 *     call swallows its own errors, and a throw there must not cost us the thrash signal.
 */
export function createHookEventHandler(deps: HookEventHandlerDeps): (ev: HookEvent) => void {
  return (ev) => {
    deps.engine.adoptSession(ev);
    if (!deps.engine.isMainSession(ev)) return;
    deps.activate();
    deps.engine.ingest(ev);
    deps.noteTranscript(ev);
    deps.noteThrash(ev);
    deps.captureHistory(ev);
  };
}
