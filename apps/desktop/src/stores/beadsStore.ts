// beadsStore — holds the latest beads board snapshot per project and manages polling.
// The snapshot is live-only (re-fetched from `bd` on each poll) so nothing is persisted.
// Timer handles live at module scope (not in store state) so the store stays serializable
// and a re-render never touches the interval.
import { create } from "zustand";
import {
  listBeads,
  blockedBeadIds,
  bucketBeads,
  ensureBeadsDb,
  isBeadsUnavailable,
  type Bead,
  type Board,
} from "../services/beads";
import { runDecomposeWatcherForPoll } from "../services/epicDecompose";
import { useSettingsStore } from "./settingsStore";

/** Whether Beads ([tools].beads) is enabled right now. Off means the `bd` CLI is never invoked. */
function beadsEnabled(): boolean {
  try {
    return useSettingsStore.getState().beadsEnabled;
  } catch {
    return true; // store unavailable (shouldn't happen) — default to the on-by-default state
  }
}

/** Default poll interval. bd is local + cheap, but 5s keeps the board feeling live without
 *  hammering the CLI. */
export const BEADS_POLL_INTERVAL_MS = 5000;

interface ProjectSnapshot {
  beads: Bead[];
  board: Board;
  loadedAt: number;
}

/**
 * WHAT A VIEWER WANTS FROM A POLL, which is not the same question as whether it wants one.
 *
 * `"board"` is a surface a human is looking at — a `BoardView`. A successful poll for one of these
 * also runs `runDecomposeWatcherForPoll`, which can WRITE beads and reach the AI gate. That is
 * correct for a board: someone is watching the columns it decomposes into.
 *
 * `"passive"` is a surface that only needs to RESOLVE ids — `BeadPillHost`, which is mounted for the
 * whole app session because the concierge is. Running the decompose watcher on its behalf would turn
 * a background bead-writing process on permanently, which is a behaviour change nobody asked for and
 * one that is invisible until it has already written something (roborev 57655).
 *
 * The distinction is per-VIEWER, not per-timer: a project watched by both kinds runs the watcher,
 * because the board is genuinely being viewed. Only a project watched exclusively by passive viewers
 * skips it.
 */
export type PollKind = "board" | "passive";

interface BeadsState {
  byProject: Record<string, ProjectSnapshot | undefined>;
  loading: Record<string, boolean>;
  error: Record<string, string | undefined>;
  /** Fetch + bucket beads for a project and store the snapshot. Never throws — failures
   *  land in `error` and the previous snapshot is left intact.
   *
   *  `runWatchers` defaults to TRUE so every existing direct caller keeps the behaviour it had; the
   *  poll paths pass the answer derived from who is actually watching. */
  refresh: (projectId: string, projectPath: string, runWatchers?: boolean) => Promise<void>;
  /** Start polling a project: refresh immediately, then every intervalMs. Idempotent in the sense
   *  that matters — one timer per project — but REFERENCE-COUNTED, so N viewers of the same project
   *  each hold the poller up and the timer stops when the last one lets go. See `viewers` below.
   *
   *  `kind` defaults to `"board"`, which is the historical behaviour — so a call site that predates
   *  this parameter cannot have been silently downgraded. A viewer must RELEASE with the same kind
   *  it claimed with. */
  startPolling: (
    projectId: string,
    projectPath: string,
    intervalMs?: number,
    kind?: PollKind,
  ) => void;
  /** Release one viewer's claim on a project's poller; clears the timer when it was the last. */
  stopPolling: (projectId: string, kind?: PollKind) => void;
}

// One interval per project, kept out of store state so timers never serialize / re-render.
const timers = new Map<string, ReturnType<typeof setInterval>>();
/**
 * How many mounted viewers currently want each project polled.
 *
 * ══ WHY COUNTING, AND NOT JUST "ONE TIMER PER PROJECT" ══════════════════════════════════════════
 * `startPolling` was already idempotent, so a second viewer's call was a no-op — and `stopPolling`
 * unconditionally cleared the timer, so the FIRST viewer to unmount silently stopped polling for
 * everyone still watching. The board then sat frozen with no visible cause; nothing errors, the last
 * snapshot just stops advancing.
 *
 * That was reachable before this change: a project can be shown in BOTH pairs, and two `BoardView`s
 * on one project is exactly the two-viewer case. It became certain with `BeadPillHost`, which polls
 * the selected project for as long as the concierge is mounted — i.e. always — so every board close
 * would have killed the bead pills' liveness.
 *
 * Kept out of store state for the same reason as `timers`: it is bookkeeping about subscriptions,
 * not data any component renders.
 */
const viewers = new Map<string, number>();
/** How many of those viewers are BOARDS, i.e. want the post-poll decompose watcher. See `PollKind`.
 *  A separate tally rather than a flag on the timer: viewers come and go independently, and "is any
 *  board still watching" is only answerable by counting them. */
const boardViewers = new Map<string, number>();

/** Whether a poll for this project should run the post-poll watchers right now. */
function wantsWatchers(projectId: string): boolean {
  return (boardViewers.get(projectId) ?? 0) > 0;
}
// Projects we've already attempted a one-shot `bd init` auto-heal for this session (see refresh).
// Guards against re-initing every 5s poll, and against hammering `bd init` when it keeps failing
// (e.g. `bd` not installed) — one attempt per project per app session. Kept out of store state.
const autoInitAttempted = new Set<string>();
// Per-project one-shot `visibilitychange` listener, armed when a poll tick is skipped because the
// window is hidden. It re-syncs the board the instant the window is shown again, then removes
// itself. Kept out of store state for the same reason as `timers`. Torn down by stopPolling.
const visibilityListeners = new Map<string, () => void>();

/** Arm a one-shot listener that refreshes the board the moment the window becomes visible again,
 *  so a poll skipped while hidden doesn't leave the board stale on return. Idempotent: at most one
 *  armed listener per project. No-op when `document` is unavailable (non-DOM test env). */
function armVisibilityRefresh(projectId: string, projectPath: string): void {
  if (typeof document === "undefined") return;
  if (visibilityListeners.has(projectId)) return; // already armed
  const onVisible = () => {
    if (document.visibilityState !== "visible") return; // also fires on visible→hidden; ignore
    document.removeEventListener("visibilitychange", onVisible);
    visibilityListeners.delete(projectId);
    void useBeadsStore.getState().refresh(projectId, projectPath, wantsWatchers(projectId));
  };
  visibilityListeners.set(projectId, onVisible);
  document.addEventListener("visibilitychange", onVisible);
}

export const useBeadsStore = create<BeadsState>()((set) => ({
  byProject: {},
  loading: {},
  error: {},

  refresh: async (projectId, projectPath, runWatchers = true) => {
    // "Off means off": with [tools].beads disabled, never shell out to `bd`. This is the single
    // chokepoint for the CLI (startPolling's immediate + interval + visibility-refresh paths all
    // route through here), and it also gates the post-poll decompose watcher below. Drop any prior
    // snapshot so a board reached in some edge case shows empty, not stale.
    if (!beadsEnabled()) {
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: undefined },
        loading: { ...s.loading, [projectId]: false },
      }));
      return;
    }
    set((s) => ({ loading: { ...s.loading, [projectId]: true } }));
    try {
      // CONCURRENTLY, not in sequence. `list_beads` is the 5s-poll hot path the perf work in
      // notes.rs targets, and the blocked query is independent of it — running them together costs
      // one wall-clock round trip instead of two. `blockedBeadIds` never rejects (it degrades to an
      // empty set), so this cannot turn a working board into a failed one.
      const [beads, blocked] = await Promise.all([listBeads(projectPath), blockedBeadIds(projectPath)]);
      const board = bucketBeads(beads, blocked);
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: { beads, board, loadedAt: Date.now() } },
        loading: { ...s.loading, [projectId]: false },
        error: { ...s.error, [projectId]: undefined },
      }));
      // Post-poll auto-decompose watcher (spec §7). Every guard (main-window election, AI gate,
      // baseline, re-entrancy) lives in the service so the store stays dumb. Fire-and-forget —
      // it never throws, and the next poll picks up whatever labels/children it wrote.
      if (runWatchers) void runDecomposeWatcherForPoll(projectId, projectPath, board);
    } catch (e) {
      // Brand-new project whose beads DB was never created: bd rejects every read with
      // "no beads database found". Auto-init one (once per project this session) and retry the
      // list so the board self-heals into an empty state instead of surfacing that raw error —
      // "beads by default". Only the recognized "no DB" case triggers this; any other failure, or
      // a still-failing retry, falls through to the normal error path below.
      if (isBeadsUnavailable(e) && !autoInitAttempted.has(projectId)) {
        autoInitAttempted.add(projectId);
        try {
          await ensureBeadsDb(projectPath);
          const [beads, blocked] = await Promise.all([
            listBeads(projectPath),
            blockedBeadIds(projectPath),
          ]);
          const board = bucketBeads(beads, blocked);
          set((s) => ({
            byProject: { ...s.byProject, [projectId]: { beads, board, loadedAt: Date.now() } },
            loading: { ...s.loading, [projectId]: false },
            error: { ...s.error, [projectId]: undefined },
          }));
          if (runWatchers) void runDecomposeWatcherForPoll(projectId, projectPath, board);
          return;
        } catch (initErr) {
          // Init (or the retried list) failed — e.g. `bd` isn't installed. Surface THIS error
          // instead of the original "no DB" one, and clear loading. The one-shot guard above
          // stays set so we don't hammer `bd init` on every subsequent poll.
          set((s) => ({
            loading: { ...s.loading, [projectId]: false },
            error: {
              ...s.error,
              [projectId]: initErr instanceof Error ? initErr.message : String(initErr),
            },
          }));
          return;
        }
      }
      // Best-effort: a bd/parse failure must not break the UI. Keep the last snapshot,
      // surface the message, and clear the loading flag.
      set((s) => ({
        loading: { ...s.loading, [projectId]: false },
        error: { ...s.error, [projectId]: e instanceof Error ? e.message : String(e) },
      }));
    }
  },

  startPolling: (projectId, projectPath, intervalMs = BEADS_POLL_INTERVAL_MS, kind = "board") => {
    // ══ THE CLAIM IS TAKEN FIRST, BEFORE EVERY GATE ═════════════════════════════════════════════
    // A claim tracks a MOUNTED VIEWER, and `stopPolling` releases unconditionally, so anything that
    // makes the claim conditional makes the two asymmetric — and an unmatched release then tears the
    // timer down while a viewer is still watching, which is the exact frozen-board bug the counting
    // exists to prevent, reintroduced by the back door.
    //
    // `beadsEnabled()` is the gate that made this concrete (roborev 57655): it is a RUNTIME setting,
    // so a viewer could mount while beads were off (no claim), the user could switch them on, a
    // board could start polling (count 1), and that first viewer's unmount would then release a
    // claim it never took and stop the poller for the board still on screen. Claiming here costs
    // nothing when beads are off — `timers` stays empty, so nothing is armed and nothing polls.
    viewers.set(projectId, (viewers.get(projectId) ?? 0) + 1);
    if (kind === "board") boardViewers.set(projectId, (boardViewers.get(projectId) ?? 0) + 1);
    if (!beadsEnabled()) return; // Beads off: don't arm a timer (refresh would no-op anyway)
    if (timers.has(projectId)) return; // already polling — one timer per project
    // Fire immediately so the board isn't empty for a full interval, then on a cadence.
    void useBeadsStore.getState().refresh(projectId, projectPath, wantsWatchers(projectId));
    const timer = setInterval(() => {
      // Don't shell out to `bd` for a window nobody's looking at — a backgrounded Tasks tab would
      // otherwise spawn a subprocess every interval for hours doing work no one sees. Skip the
      // spawn and arm a one-shot listener that re-syncs the board the moment it's visible again.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        armVisibilityRefresh(projectId, projectPath);
        return;
      }
      // ASKED EVERY TICK, not captured when the timer was armed: the last board can close while a
      // passive viewer keeps the timer alive, and from that moment the watcher must stop running.
      void useBeadsStore.getState().refresh(projectId, projectPath, wantsWatchers(projectId));
    }, intervalMs);
    timers.set(projectId, timer);
  },

  stopPolling: (projectId, kind = "board") => {
    if (kind === "board") {
      const boards = (boardViewers.get(projectId) ?? 0) - 1;
      if (boards > 0) boardViewers.set(projectId, boards);
      else boardViewers.delete(projectId);
    }
    // One viewer letting go is not a stop while others are still watching.
    //
    // FALLS THROUGH TO A FULL TEARDOWN at zero OR BELOW, deliberately. An unmatched `stopPolling`
    // — a viewer that never started because `[tools].beads` was off, or a double-unmount — drives
    // the count negative, and treating that as "still claimed" would leave a timer nothing can ever
    // stop. Tearing down is idempotent and safe; refusing to would not be.
    const remaining = (viewers.get(projectId) ?? 0) - 1;
    if (remaining > 0) {
      viewers.set(projectId, remaining);
      return;
    }
    viewers.delete(projectId);
    const timer = timers.get(projectId);
    if (timer !== undefined) {
      clearInterval(timer);
      timers.delete(projectId);
    }
    // Tear down any armed visibility listener so it can't fire a refresh after the board unmounts.
    const onVisible = visibilityListeners.get(projectId);
    if (onVisible !== undefined) {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      visibilityListeners.delete(projectId);
    }
  },
}));
