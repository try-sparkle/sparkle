// hookWatcher (): poll an agent's hook event log and surface parsed events. Runs
// while an agent pane is open; the Rust `read_events_since` command returns only newly-appended
// complete lines (tracking a byte offset), so each poll is cheap and never replays old events.
// Polling (vs a Rust file-watch + Tauri event) keeps lifecycle trivial: start on mount, stop on
// unmount, no background thread to reap.
import { invoke } from "@tauri-apps/api/core";
import { parseHookLine, type HookEvent } from "../engine/hookEvents";

interface EventsChunk {
  lines: string[];
  offset: number;
}

/** Injectable so tests can drive the poll without Tauri. */
export type PollFn = (logPath: string, offset: number) => Promise<EventsChunk>;

export interface HookWatcher {
  stop: () => void;
}

const defaultPoll: PollFn = (logPath, offset) =>
  invoke<EventsChunk>("read_events_since", { logPath, offset });

export interface WatchOpts {
  intervalMs?: number;
  poll?: PollFn;
  /** Skip everything already in the log (start at EOF) and only dispatch newly-appended events.
   *  The per-agent log is keyed by worktree, so it accumulates every past `claude` run plus any
   *  background one-shot sessions. Status must derive from the session this watch is for (the
   *  freshly-spawned agent), so we drain the stale backlog without dispatching it — the first
   *  event the consumer sees is then the live session's, which it can lock onto. */
  skipExisting?: boolean;
}

/** Begin tailing `logPath`; calls `onEvent` for each parsed hook event in order. Returns a
 *  handle whose `stop()` halts polling. Transient read errors are swallowed and retried on the
 *  next tick so a momentarily-missing/locked file never tears the watcher down. */
export function watchHookEvents(
  logPath: string,
  onEvent: (ev: HookEvent) => void,
  opts: WatchOpts = {},
): HookWatcher {
  const intervalMs = opts.intervalMs ?? 500;
  const poll = opts.poll ?? defaultPoll;
  let offset = 0;
  // When skipExisting, the first poll only advances the offset past the existing backlog without
  // dispatching it. Flips false after that first drain so all later polls dispatch normally.
  let skipping = opts.skipExisting ?? false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const chunk = await poll(logPath, offset);
      // stop() may have fired while the poll was in flight; don't dispatch into a torn-down
      // consumer (e.g. an unmounted pane) after the caller has stopped us.
      if (stopped) return;
      offset = chunk.offset;
      if (skipping) {
        skipping = false; // drained the pre-existing backlog; dispatch from here on
      } else {
        for (const line of chunk.lines) {
          const ev = parseHookLine(line);
          if (ev) onEvent(ev);
        }
      }
    } catch {
      // transient (file not created yet, mid-rotation) — retry next tick
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
