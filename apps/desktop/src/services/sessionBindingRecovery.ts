// sessionBindingRecovery — recover an agent's Claude session binding from its OWN hook log.
//
// ══ THE DEFECT THIS EXISTS FOR ═══════════════════════════════════════════════════════════════════
// The mounted concierge pane fails CLOSED when it does not know which Claude sessions belong to an
// agent: `hooks/useAgentTranscript` returns early on an unknown binding and the pane renders
// "No conversation with <name> yet." That gate is CORRECT and this module does not touch it — a
// session DIRECTORY belongs to a WORKTREE, so it holds a `*.jsonl` for every `claude` that ever ran
// there (measured: 136 files in one agent's worktree of which 39 were that agent's; 1,292 in
// another). Reading "newest by mtime" rendered a STRANGER'S conversation under this agent's name.
//
// The defect is that the binding has exactly ONE production writer — AgentPane's hook handler —
// and panes mount LAZILY per visited project. An agent whose pane has never mounted in this window
// is unbound, so its mounted pane is empty forever. Measured on the reporting machine: 12 of 56
// live worktrees were in exactly that state.
//
// ══ THE SOURCE, AND WHY IT IS TRUSTWORTHY ════════════════════════════════════════════════════════
// Sparkle writes a per-agent hook log at `<app_data>/hook-events/<agentId>.jsonl`, keyed by the
// WORKTREE BASENAME — which for an app-cut worktree (`worktrees/<projectId>/<agentId>`) IS the agent
// id. Every hook event carries BOTH `session_id` AND `transcript_path` (verified across
// SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop and SubagentStop), and
// `transcript_path` is the absolute path Claude Code is writing:
//     <configDir>/projects/<slug>/<sessionId>.jsonl
// so ONE backwards read of that log yields both the session id and the account config dir.
//
// ══ ACCEPTED, DOCUMENTED RESIDUAL RISK — DO NOT "SIMPLIFY" THIS INTO A DIRECTORY READ ════════════
// The log is keyed by WORKTREE, so it interleaves the main interactive agent with background
// one-shot `claude` calls run in the same worktree (each a full SessionStart→…→SessionEnd). The most
// recent turn-opener could therefore be a one-shot's rather than the agent's.
//
// `engine/hookEvents`'s `HookStatusEngine` already takes exactly this trade-off and documents it in
// those terms — "A re-prepare while a prior background one-shot is still mid-flight could mis-lock
// onto that background session; this is rare and accepted". This module matches that reasoning.
//
// THE DISTINCTION THAT MAKES IT ACCEPTABLE, stated explicitly so a future reader does not widen it:
// the bounded harm here is showing a Sparkle-spawned one-shot that ran IN THIS AGENT'S OWN
// WORKTREE. That is categorically smaller than the CROSS-AGENT mis-attribution the fail-closed gate
// exists to prevent — a stranger's conversation under this agent's name. A directory-wide "newest
// jsonl" read reintroduces exactly that cross-agent case and is the thing this module refuses to be.
//
// ══ WHAT THIS MODULE IS NOT ══════════════════════════════════════════════════════════════════════
// It is a LEAF and must stay one: it does NOT import or call the registry (`noteAgentSessionId` /
// `noteAgentConfigDir`) — it RETURNS what it found and the caller records it. See
// `agentTranscriptRegistry`'s header for why that matters concretely: a leaf that drags the wrong
// dependency into a module graph once failed 16 test files at COLLECTION. Its only imports are that
// registry's pure `configDirFromTranscriptPath` and `engine/hookEvents`' pure `parseHookLine`, both
// of which are themselves import-free at runtime.
import { configDirFromTranscriptPath } from "./agentTranscriptRegistry";
import { parseHookLine, type HookEvent } from "../engine/hookEvents";

/** The chunk shape the Rust `read_events_since` command returns. Mirrors `services/hookWatcher`'s
 *  private interface; duplicated rather than imported because importing it would pull
 *  `@tauri-apps/api/core` into this leaf's module graph, which is the one thing its header forbids. */
export interface EventsChunk {
  lines: string[];
  offset: number;
  /** Set when the backend hit its per-poll byte cap and more data is already waiting. */
  truncated?: boolean;
}

/** Injectable reader, the same seam (and the same argument order) as `hookWatcher`'s `PollFn`, so a
 *  caller wires `invoke<EventsChunk>("read_events_since", { logPath, offset, skipExisting })` and a
 *  test drives this without Tauri. Reads are confined server-side to `<app_data>/hook-events`. */
export type ReadEventsFn = (
  logPath: string,
  offset: number,
  skipExisting: boolean,
) => Promise<EventsChunk>;

export interface RecoverSessionBindingOpts {
  /** Whose binding this is. Not used to locate anything — `logPath` is already agent-keyed — but a
   *  blank one means the caller has nothing to record the result under, which is a miss, not a
   *  binding. */
  agentId: string;
  /** `<app_data>/hook-events/<agentId>.jsonl`. */
  logPath: string;
  /** See {@link ReadEventsFn}. */
  read: ReadEventsFn;
  /**
   * Does this absolute path exist on disk?
   *
   * NO DEFAULT, DELIBERATELY. There is no renderer-side file-existence helper in this app to reuse
   * (`env_dirs_exist` is `Path::is_dir`, which cannot answer for a `.jsonl` file), and inventing a
   * Rust command is out of scope here. Requiring it makes the wiring explicit so it cannot be
   * silently left unsupplied — an unsupplied check would quietly turn the load-bearing verification
   * below into a no-op.
   */
  exists: (path: string) => Promise<boolean>;
  /** Override the tail window. See {@link TAIL_BYTES}. */
  tailBytes?: number;
}

export interface RecoveredSessionBinding {
  /** A session id verified to have a transcript file that still exists. */
  sessionId: string;
  /** The account `CLAUDE_CONFIG_DIR` implied by that transcript path, or `null` when the path is not
   *  shaped like one and a config dir would therefore be an invention. `null` is correct-and-safe:
   *  the reader falls back to `$HOME/.claude`, which is today's behaviour. A WRONG one is not. */
  configDir: string | null;
}

/**
 * How much of the END of the log to scan, in bytes.
 *
 * WHY BOUNDED: the log can be megabytes (measured 1,884 events in one agent's), and this runs on a
 * pane mount. WHY THE END: we want the MOST RECENT turn-opener, so the newest bytes are the only
 * ones that can hold the answer — reading from the front would find the OLDEST session and be worse
 * than reading nothing. WHY THIS SIZE IS SAFE: hook lines run a few hundred bytes to a few KB, so
 * 256 KiB covers hundreds of the newest events — far more than the one we need — and it sits well
 * under the backend's own 1 MiB `MAX_READ_BYTES` cap, so a single call returns the whole window
 * rather than a `truncated` prefix that would need a follow-up read.
 *
 * The window almost always starts mid-line. That first fragment is not valid JSON, so `parseHookLine`
 * returns null for it and it is dropped — no special handling, and no risk of a half-parsed event.
 */
const TAIL_BYTES = 256 * 1024;

/** Events that (re)open a turn. Mirrors `engine/hookEvents`' own private `TURN_OPENERS`, which is
 *  not exported; kept in sync by hand because the vocabulary is Claude Code's, not ours. */
const TURN_OPENERS = new Set(["SessionStart", "UserPromptSubmit"]);

function sessionOf(ev: HookEvent): string | null {
  const id = (ev.session_id ?? "").trim();
  return id === "" ? null : id;
}

/**
 * Recover `agentId`'s Claude session binding from its own hook-events log, or `null`.
 *
 * THE RULE — this is the safety contract:
 *   Choose the session id of the MOST RECENT turn-opener (`SessionStart` or `UserPromptSubmit`) in
 *   the log, falling back to the most recent event carrying a `session_id`, AND ONLY ACCEPT IT IF
 *   ITS `transcript_path` STILL EXISTS ON DISK. If nothing verifies, return `null` and let the pane
 *   stay honestly empty. Never guess; never fall back to "newest file in the directory".
 *
 * THE EXISTENCE CHECK IS LOAD-BEARING, not defensive dressing. Measured on the 6 unbound agents on
 * the reporting machine: 4 resolved to a file that exists; 2 resolved to a file under a
 * since-removed account that does NOT. Without the check those 2 would register a binding naming a
 * file nothing can read, and the pane would sit in a permanently-failing read instead of an honest
 * empty state — strictly worse than the bug this fixes.
 *
 * NEVER THROWS. A reader that rejects, an `exists` that rejects, an empty log, a log of garbage —
 * all are `null`, which leaves the caller in exactly the fail-closed state it was already in.
 */
export async function recoverSessionBinding(
  opts: RecoverSessionBindingOpts,
): Promise<RecoveredSessionBinding | null> {
  const { logPath, read, exists } = opts;
  if (opts.agentId.trim() === "" || logPath.trim() === "") return null;
  const tailBytes = opts.tailBytes ?? TAIL_BYTES;

  try {
    // Pass 1: the seek-to-EOF fast path. `skipExisting` makes the backend return the file's length
    // as `offset` without reading a byte, which is how we learn the size without a stat command.
    const eof = await read(logPath, 0, true);
    const size = Number.isFinite(eof.offset) && eof.offset > 0 ? eof.offset : 0;
    if (size === 0) return null;

    // Pass 2: the tail window itself.
    const start = Math.max(0, size - tailBytes);
    const chunk = await read(logPath, start, false);

    const events: HookEvent[] = [];
    for (const line of chunk.lines) {
      const ev = parseHookLine(line);
      if (ev) events.push(ev);
    }

    // ══ CANDIDATES IN PREFERENCE ORDER, THEN A FILTER — NOT A ONE-SHOT GATE ══════════════════════
    // Scan BACKWARDS so recency decides: a turn-opener (`SessionStart` / `UserPromptSubmit`) is the
    // strongest evidence of "this is the session in play", and any other event carrying a session id
    // is the weaker fallback for a window that holds no opener (a long mid-turn stretch of tool
    // events, or an emitter predating SessionStart).
    //
    // WHY EVERY CANDIDATE AND NOT JUST THE FIRST. Verifying only the top candidate makes one dead
    // transcript abort a recovery that the same window could still have satisfied. Measured by
    // replaying this rule over the reporting machine's real hook logs: of 353 logs carrying a session
    // id, 7 returned nothing under the one-shot form while ANOTHER session in the same window named a
    // transcript that is live on disk. Those are panes that would read "No conversation yet" over a
    // readable transcript — the exact state this module exists to end.
    //
    // This does NOT loosen the safety contract. Every candidate is still verified before it is
    // returned, and it is verified against ITS OWN transcript (see the session match below). What
    // changes is only that a refusal moves to the next candidate instead of ending the search.
    const ordered: string[] = [];
    const seen = new Set<string>();
    const push = (id: string | null) => {
      if (id === null || seen.has(id)) return;
      seen.add(id);
      ordered.push(id);
    };
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev && TURN_OPENERS.has(ev.event)) push(sessionOf(ev));
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev) push(sessionOf(ev));
    }
    if (ordered.length === 0) return null;

    for (const sessionId of ordered) {
      // THE TRANSCRIPT PATH FOR *THAT* SESSION, newest first — matched by session id rather than
      // taken off the chosen event alone, so an opener emitted without one (an older emitter) still
      // verifies against the same session's later events.
      //
      // THIS MATCH IS THE SAFETY, NOT A CONVENIENCE. Without it the loop can verify one session's
      // file and then return a DIFFERENT session's id, which is precisely the unverified binding the
      // existence check exists to refuse — and it fails silently, because both paths usually sit in
      // the same directory. `sessionBindingRecovery.test.ts` pins it with a log whose newest
      // transcript path belongs to a session that is NOT the chosen one.
      let transcriptPath: string | null = null;
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (!ev || sessionOf(ev) !== sessionId) continue;
        const p = (ev.transcriptPath ?? "").trim();
        if (p !== "") {
          transcriptPath = p;
          break;
        }
      }
      // Nothing to verify for this candidate — try the next rather than abandoning the search.
      if (transcriptPath === null) continue;
      if (!(await exists(transcriptPath))) continue;
      return { sessionId, configDir: configDirFromTranscriptPath(transcriptPath) ?? null };
    }
    // Every candidate refused. An honest empty pane is the correct outcome.
    return null;
  } catch {
    // A rejecting reader (log not created yet, a path the backend refuses) or a rejecting existence
    // check. Either way we did not establish a binding; say so rather than propagate.
    return null;
  }
}
