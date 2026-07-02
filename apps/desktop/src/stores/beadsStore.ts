// beadsStore — holds the latest beads board snapshot per project and manages polling.
// The snapshot is live-only (re-fetched from `bd` on each poll) so nothing is persisted.
// Timer handles live at module scope (not in store state) so the store stays serializable
// and a re-render never touches the interval.
import { create } from "zustand";
import { listBeads, bucketBeads, type Bead, type Board } from "../services/beads";
import { runDecomposeWatcherForPoll } from "../services/epicDecompose";

/** Default poll interval. bd is local + cheap, but 5s keeps the board feeling live without
 *  hammering the CLI. */
export const BEADS_POLL_INTERVAL_MS = 5000;

interface ProjectSnapshot {
  beads: Bead[];
  board: Board;
  loadedAt: number;
}

interface BeadsState {
  byProject: Record<string, ProjectSnapshot | undefined>;
  loading: Record<string, boolean>;
  error: Record<string, string | undefined>;
  /** Fetch + bucket beads for a project and store the snapshot. Never throws — failures
   *  land in `error` and the previous snapshot is left intact. */
  refresh: (projectId: string, projectPath: string) => Promise<void>;
  /** Start polling a project: refresh immediately, then every intervalMs. Idempotent —
   *  one timer per project; a second call is a no-op. */
  startPolling: (projectId: string, projectPath: string, intervalMs?: number) => void;
  /** Stop polling a project and clear its timer. */
  stopPolling: (projectId: string) => void;
}

// One interval per project, kept out of store state so timers never serialize / re-render.
const timers = new Map<string, ReturnType<typeof setInterval>>();
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
    void useBeadsStore.getState().refresh(projectId, projectPath);
  };
  visibilityListeners.set(projectId, onVisible);
  document.addEventListener("visibilitychange", onVisible);
}

export const useBeadsStore = create<BeadsState>()((set) => ({
  byProject: {},
  loading: {},
  error: {},

  refresh: async (projectId, projectPath) => {
    set((s) => ({ loading: { ...s.loading, [projectId]: true } }));
    try {
      const beads = await listBeads(projectPath);
      const board = bucketBeads(beads);
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: { beads, board, loadedAt: Date.now() } },
        loading: { ...s.loading, [projectId]: false },
        error: { ...s.error, [projectId]: undefined },
      }));
      // Post-poll auto-decompose watcher (spec §7). Every guard (main-window election, AI gate,
      // baseline, re-entrancy) lives in the service so the store stays dumb. Fire-and-forget —
      // it never throws, and the next poll picks up whatever labels/children it wrote.
      void runDecomposeWatcherForPoll(projectId, projectPath, board);
    } catch (e) {
      // Best-effort: a bd/parse failure must not break the UI. Keep the last snapshot,
      // surface the message, and clear the loading flag.
      set((s) => ({
        loading: { ...s.loading, [projectId]: false },
        error: { ...s.error, [projectId]: e instanceof Error ? e.message : String(e) },
      }));
    }
  },

  startPolling: (projectId, projectPath, intervalMs = BEADS_POLL_INTERVAL_MS) => {
    if (timers.has(projectId)) return; // already polling — idempotent
    // Fire immediately so the board isn't empty for a full interval, then on a cadence.
    void useBeadsStore.getState().refresh(projectId, projectPath);
    const timer = setInterval(() => {
      // Don't shell out to `bd` for a window nobody's looking at — a backgrounded Tasks tab would
      // otherwise spawn a subprocess every interval for hours doing work no one sees. Skip the
      // spawn and arm a one-shot listener that re-syncs the board the moment it's visible again.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        armVisibilityRefresh(projectId, projectPath);
        return;
      }
      void useBeadsStore.getState().refresh(projectId, projectPath);
    }, intervalMs);
    timers.set(projectId, timer);
  },

  stopPolling: (projectId) => {
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
