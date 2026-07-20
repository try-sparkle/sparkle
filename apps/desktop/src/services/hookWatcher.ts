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
  /** Set when the backend hit its per-poll byte cap and more data is already waiting. */
  truncated?: boolean;
}

/** Injectable so tests can drive the poll without Tauri. */
export type PollFn = (
  logPath: string,
  offset: number,
  skipExisting: boolean,
) => Promise<EventsChunk>;

export interface HookWatcher {
  stop: () => void;
}

const defaultPoll: PollFn = (logPath, offset, skipExisting) =>
  invoke<EventsChunk>("read_events_since", { logPath, offset, skipExisting });

export interface WatchOpts {
  intervalMs?: number;
  poll?: PollFn;
  /** Skip everything already in the log (start at EOF) and only dispatch newly-appended events.
   *  The per-agent log is keyed by worktree, so it accumulates every past `claude` run plus any
   *  background one-shot sessions. Status must derive from the session this watch is for (the
   *  freshly-spawned agent), so we start at EOF — the first event the consumer sees is then the
   *  live session's, which it can lock onto.
   *
   *  The skip happens SERVER-SIDE: the backend seeks to EOF and returns the offset without reading
   *  anything. It used to start at offset 0 and read the entire accumulated log (megabytes, on the
   *  main thread) just so this watcher could throw the lines away — so every pane mount paid for
   *  the whole backlog. */
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
  // Only the FIRST poll asks the backend to seek past the backlog; every later poll tails normally.
  let skipNext = opts.skipExisting ?? false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let behind = false;
    try {
      const chunk = await poll(logPath, offset, skipNext);
      // stop() may have fired while the poll was in flight; don't dispatch into a torn-down
      // consumer (e.g. an unmounted pane) after the caller has stopped us.
      if (stopped) return;
      const skipped = skipNext;
      skipNext = false;
      offset = chunk.offset;
      // A skipped poll returns no lines by construction; guard anyway so a backend that ignores
      // the flag can never replay a stale backlog into the status engine.
      if (!skipped) {
        for (const line of chunk.lines) {
          const ev = parseHookLine(line);
          if (ev) onEvent(ev);
        }
      }
      behind = chunk.truncated === true;
    } catch {
      // transient (file not created yet, mid-rotation) — retry next tick
    }
    // When the backend capped the read there is already more waiting, so catch up immediately
    // instead of idling a full interval per 1 MiB.
    if (!stopped) timer = setTimeout(tick, behind ? 0 : intervalMs);
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
