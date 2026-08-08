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
  type BoardColumn,
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

/** How long a single in-flight refresh may run before a later tick is allowed to STEAL its claim
 *  and retry. `bd` reads are unbounded (`run_bd` is a bare `Command::output()` with no timeout), so
 *  a scan blocked on the wedged store's lock can hang indefinitely; without a steal it would latch
 *  the concurrency guard for the rest of the session. Set well above a merely-slow-but-progressing
 *  scan (which the guard is meant to coalesce, not steal) so recovery only triggers for a genuinely
 *  stuck one: at 6× the interval a claim older than this is presumed hung. The steal fires at most
 *  once per window, so a wedged store retries on a slow trickle, never a convoy. */
export const BEADS_STALE_REFRESH_MS = 6 * BEADS_POLL_INTERVAL_MS;

/**
 * How often the concierge re-reads the projects it is NOT looking at, so a bead id belonging to one
 * of them still resolves. `BeadPillHost` owns the sweep and the reasoning behind it.
 *
 * SIX TIMES SLOWER than the poll interval, deliberately. Every refresh is a `bd list --all` +
 * `bd blocked` pair against the shared embedded store, so sweeping N projects at the board's
 * cadence would multiply the exact subprocess load the in-flight guard above exists to contain —
 * for projects nobody is looking at. A cross-project pill needs EXISTENCE, which does not change
 * second to second; the status dot lagging by up to this interval is the cheap half of the trade,
 * and the project the reader IS looking at keeps the fast cadence.
 */
export const BEADS_CROSS_PROJECT_REFRESH_MS = 30_000;

/** Cap on the exponential backoff between successive steals of a hung claim: the effective window is
 *  `BEADS_STALE_REFRESH_MS × 2^min(consecutiveSteals, this)`. A steal cannot CANCEL the `bd` process
 *  it abandons, so each one leaks a blocked subprocess until the store recovers; stealing on a fixed
 *  30s cadence forever would add ~4 such processes a minute and amplify the very lock convoy this
 *  guard exists to break. Backing off — 30s, 60s, 2m, 4m, 8m, then capped at 32× (~16m) — turns an
 *  hour-long wedge into a handful of retry processes instead of ~120, while still recovering
 *  promptly from a brief stall. Reset to 0 whenever a scan completes while owning its claim (the
 *  store is proven responsive again). The real fix is a bounded `bd` on the Rust side. */
const BEADS_STEAL_BACKOFF_MAX_SHIFT = 5;

interface ProjectSnapshot {
  beads: Bead[];
  board: Board;
  /**
   * When this snapshot's CONTENT was first observed — NOT when we last polled.
   *
   * An unchanged poll deliberately does not advance it, because advancing it would mint a new
   * entry object and re-notify every subscriber for a backlog that did not move (see
   * `snapshotUnchanged`). "When did we last shell out to `bd`" is a different question with a
   * different reader; it lives in `beadsPolledAt` below, outside store state, for the same reason
   * `timers`/`viewers` do — it is bookkeeping about the fetch, not data anything renders.
   */
  loadedAt: number;
}

// ── Snapshot equality: what makes a poll a NO-OP ───────────────────────────────────────────────
//
// ══ WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════════
// `refresh` runs every BEADS_POLL_INTERVAL_MS (5s) per watched project, and it used to write
// `{ beads, board, loadedAt: Date.now() }` unconditionally on every success. That mints a fresh
// `beads` ARRAY identity and a fresh `board` OBJECT identity every five seconds even when the
// backlog is byte-for-byte identical — and a zustand selector notifies on identity, not on value.
//
// `AgentSidebar`'s `AgentRow` selects exactly those two, once per row:
//     useBeadsStore((s) => s.byProject[project.id]?.beads ?? NO_BEADS)
//     useBeadsStore((s) => s.byProject[project.id]?.board ?? null)
// The row is `React.memo`'d, which does nothing here: the store notified, the selector returned a
// new reference, so the row re-runs its whole body — `epicForBuild` (O(agents × beads)),
// `epicPillFor` (allocates a fresh 4-way concatenated array), a `beads.filter(...)`, `stallReport`,
// `thrashReportFor`. With the ~60 agents the founder actually runs, that is 60 full row re-renders
// every 5 seconds for a backlog that did not move.
//
// ══ WHY A POSITIONAL COMPARE, AND NOT A NORMALISED ONE ══════════════════════════════════════════
// `bucketBeads` preserves input order within each column and the board RENDERS that order, so a
// reorder is a real change a reader can see. Normalising (sorting by id) before comparing would
// report a genuine reorder as "equal" and freeze the board mid-shuffle. Compare positionally.
//
// ══ WHY THIS IS CHEAPER THAN WHAT IT PREVENTS ═══════════════════════════════════════════════════
// O(beads) scalar comparisons plus O(beads) id comparisons across the five board columns — no
// allocation, no serialisation. `JSON.stringify` was rejected: it allocates two strings the size of
// the whole backlog (description fields included) every 5 seconds, which is the opposite of the
// point. See `beadsStore.identity.test.ts` for the measured numbers.

/**
 * The `Bead` fields the equality check compares.
 *
 * Exported because it is a DRIFT GUARD, not documentation: `beadsStore.identity.test.ts` asserts
 * (a) that this list plus `labels` covers every key of a fully-populated `Bead`, so a field added
 * to `Bead` cannot silently become invisible to the comparison, and (b) that changing each listed
 * field individually is actually detected, so the list cannot claim coverage it does not have.
 */
export const COMPARED_BEAD_FIELDS = [
  "id",
  "title",
  "description",
  "status",
  "type",
  "priority",
  "parent",
  "createdAt",
  "updatedAt",
] as const;

/** Every board column, exhaustively. The `Record<BoardColumn, true>` literal is the tie: adding a
 *  column to `BoardColumn` fails to compile here rather than silently dropping out of the compare. */
const BOARD_COLUMNS = Object.keys({
  backlog: true,
  blocked: true,
  inProgress: true,
  done: true,
  delivered: true,
} satisfies Record<BoardColumn, true>) as BoardColumn[];

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Field-wise equality over everything the UI reads off a bead. */
function sameBead(a: Bead, b: Bead): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.description === b.description &&
    a.status === b.status &&
    a.type === b.type &&
    a.priority === b.priority &&
    a.parent === b.parent &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    sameLabels(a.labels, b.labels)
  );
}

/**
 * Whether a freshly-fetched (beads, board) pair is equivalent to the snapshot already in the store.
 *
 * THE BOARD IS COMPARED SEPARATELY, and that is not redundant. `board = bucketBeads(beads, blocked)`
 * — and `blocked` is NOT part of the snapshot. So a poll can return beads that are field-for-field
 * identical while the blocked set changed underneath, which moves a bead between the `backlog` and
 * `blocked` columns. Comparing only `beads` would report that as unchanged and freeze the board on
 * a stale bucketing. Per-column positional id equality is sufficient given the beads already match
 * field-wise, since bucketing is a pure function of (beads, blocked) that preserves input order.
 */
export function snapshotUnchanged(prev: ProjectSnapshot, beads: Bead[], board: Board): boolean {
  if (prev.beads.length !== beads.length) return false;
  for (let i = 0; i < beads.length; i++) {
    // `noUncheckedIndexedAccess` is on, so both reads are `Bead | undefined` even though the equal
    // lengths make them present. A sparse array would land here as undefined; treat that as CHANGED
    // rather than equal — the guard must never report "equal" for something it could not compare.
    const a = prev.beads[i];
    const b = beads[i];
    if (a === undefined || b === undefined || !sameBead(a, b)) return false;
  }
  for (const col of BOARD_COLUMNS) {
    const before = prev.board[col];
    const after = board[col];
    if (before.length !== after.length) return false;
    for (let i = 0; i < after.length; i++) {
      const x = before[i];
      const y = after[i];
      if (x === undefined || y === undefined || x.id !== y.id) return false;
    }
  }
  return true;
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
   *  poll paths pass the answer derived from who is actually watching.
   *
   *  `allowAutoInit` likewise defaults to TRUE. Passing `false` means "read this project, but do not
   *  CREATE anything in it" — see the auto-init branch in the catch below for why the cross-project
   *  resolution sweep must say so. */
  refresh: (
    projectId: string,
    projectPath: string,
    runWatchers?: boolean,
    allowAutoInit?: boolean,
  ) => Promise<void>;
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
 * The `refresh` currently in flight for each project — the per-project CONCURRENCY-1 guard.
 *
 * ══ WHY: THE LOCK CONVOY ═══════════════════════════════════════════════════════════════════════
 * `refresh` shells out to `bd list --all` + `bd blocked`, which read the shared embedded store.
 * When a scan takes LONGER than the poll interval — the store is under write contention and has
 * grown large — the next tick would fire anyway and spawn ANOTHER overlapping pair. Those contend
 * on the store's single lock, so each slows the others, scan time grows, and more ticks stack: a
 * self-sustaining convoy that can pile up dozens of `bd` subprocesses and wedge the store for the
 * whole app AND every CLI sharing it.
 *
 * The guard caps the poll path at one in-flight refresh per project. Polling is idempotent, so an
 * overlapping tick is DROPPED, not queued — the next un-blocked tick reads the latest state anyway.
 * Placed in `refresh` (the single CLI chokepoint) so every caller — immediate fire, interval, and
 * the visibility-refresh listener — is covered by one guard. Kept out of store state for the same
 * reason as `timers`: bookkeeping, not rendered data.
 *
 * ══ TWO PROPERTIES THAT MATTER ═════════════════════════════════════════════════════════════════
 * (1) TOKENIZED. Each claim carries a unique `token`, and only the refresh that OWNS the current
 *     token may release it or write store state. A `bd` read is unbounded, so a scan can be
 *     abandoned (its claim stolen — see below) and settle much later; without the token its stale
 *     `finally` would free a newer claim (re-opening the convoy) and its stale `set()` would clobber
 *     the fresher snapshot. The token makes a stolen-from scan a silent no-op.
 * (2) STEALABLE. A claim older than `BEADS_STALE_REFRESH_MS` is presumed hung and a later tick
 *     takes it over. This is the recovery path for a wedged store, and it does NOT depend on
 *     teardown — which matters because `BeadPillHost` holds a permanent passive claim on the
 *     SELECTED project (the one polled every 5s, so the one most likely to wedge), meaning its
 *     viewer count never reaches zero and a teardown-based release would never fire for it.
 */
interface InFlightClaim {
  token: object;
  startedAt: number;
}
const refreshInFlight = new Map<string, InFlightClaim>();
/** Consecutive steals of a hung claim per project since the last completed scan. Drives the
 *  exponential backoff — see `BEADS_STEAL_BACKOFF_MAX_SHIFT`. Reset when an owning scan completes. */
const staleSteals = new Map<string, number>();

/**
 * When each project last completed a SUCCESSFUL `bd` read — the freshness clock.
 *
 * ══ WHY THIS IS NOT `ProjectSnapshot.loadedAt` ANY MORE ═════════════════════════════════════════
 * It used to be, and that is precisely what made the per-project entry a new object on every poll:
 * even with `beads` and `board` preserved, a moving `loadedAt` re-minted the entry, so anything
 * selecting the entry (`BoardView`) or the whole map (`BeadPillHost`) re-rendered every 5 seconds
 * for a backlog that did not move. Freshness has to keep advancing on an unchanged poll, and the
 * snapshot has to stay identical on one — those two requirements cannot share a field.
 *
 * Kept at module scope, like `timers`/`viewers`/`refreshInFlight`, because it is bookkeeping about
 * the fetch rather than data anything renders: its one reader, `BeadPillHost`'s cross-project
 * sweep, reads it imperatively at sweep time via `beadsPolledAt` and wants the freshest value, not
 * a subscription. Storing it in state instead would put the churn back — one notification per poll
 * per project — for a value no selector ever reads.
 *
 * STAMPED ONLY ON SUCCESS. A failed poll must leave it untouched so the sweep retries that project
 * rather than treating a failure as a fresh read (the same reason the old `loadedAt` was only ever
 * written inside the success commits).
 */
const polledAt = new Map<string, number>();

/**
 * When this project's beads were last successfully read, or `undefined` if never.
 *
 * The freshness gate in `BeadPillHost`'s cross-project sweep is the reader: `others` changes on
 * every selection change and re-fires that sweep, so without a freshness check, clicking through
 * the project strip produces back-to-back `bd` convoys against the shared store. That gate needs
 * "when did we last READ this", which is why it must not be answered from the snapshot — an
 * unchanged poll deliberately leaves the snapshot (and its `loadedAt`) alone.
 */
export function beadsPolledAt(projectId: string): number | undefined {
  return polledAt.get(projectId);
}

/** TEST-ONLY. Drain the module-scope PER-PROJECT bookkeeping between cases — the in-flight claim,
 *  its steal-backoff counter, and the freshness clock.
 *
 *  Unlike `timers`/`viewers`, which the suites drain via `stopPolling`, none of these is touched by
 *  teardown (claim recovery is time-based), so a case that leaves a scan latched — e.g. a hand-held
 *  or never-settling mock — would leak that claim into the next case reusing the same project id.
 *  `polledAt` leaks the same way and is easier to miss, because it does not live in store state:
 *  `setState({ byProject: {} })` looks like a full reset but leaves a project the previous case
 *  read still looking freshly-read, so a freshness-gated sweep silently skips it. Call in
 *  `beforeEach`. Not part of the store's runtime surface. */
export function __resetBeadsRefreshInFlightForTest(): void {
  refreshInFlight.clear();
  staleSteals.clear();
  // Freshness is module-scope too, so a case that polled project "p1" would otherwise leave the
  // next case's "p1" looking already-fresh.
  polledAt.clear();
}
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

  refresh: async (projectId, projectPath, runWatchers = true, allowAutoInit = true) => {
    // "Off means off": with [tools].beads disabled, never shell out to `bd`. This is the single
    // chokepoint for the CLI (startPolling's immediate + interval + visibility-refresh paths all
    // route through here), and it also gates the post-poll decompose watcher below. Drop any prior
    // snapshot so a board reached in some edge case shows empty, not stale.
    if (!beadsEnabled()) {
      // Drop the freshness stamp with the snapshot. Leaving it would make the cross-project sweep
      // treat a project whose snapshot we just discarded as recently read, so re-enabling beads
      // would show dead ids for up to a full sweep interval.
      polledAt.delete(projectId);
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: undefined },
        loading: { ...s.loading, [projectId]: false },
      }));
      return;
    }
    // IN-FLIGHT GUARD (see `refreshInFlight`): at most one refresh per project at a time. A poll
    // tick that fires while a prior refresh is still shelling out to `bd` is DROPPED here, not
    // queued — polling is idempotent, so the next un-blocked tick reads the latest state. This is
    // what breaks the Dolt lock convoy: overlapping ticks can no longer stack `bd list --all`s.
    // EXCEPT a claim older than the staleness window is presumed hung (unbounded `bd` blocked on the
    // wedged store's lock) and is STOLEN so the project can recover — see BEADS_STALE_REFRESH_MS.
    const now = Date.now();
    const existing = refreshInFlight.get(projectId);
    if (existing) {
      // A claim is held. Coalesce (drop) this tick unless the holder is older than the staleness
      // window — then it's presumed hung and we STEAL it. The window grows exponentially per
      // consecutive steal (capped) so a persistently wedged store isn't hammered with a fresh,
      // uncancellable `bd` pair every 30s forever.
      const shift = Math.min(staleSteals.get(projectId) ?? 0, BEADS_STEAL_BACKOFF_MAX_SHIFT);
      const staleWindow = BEADS_STALE_REFRESH_MS * 2 ** shift;
      if (now - existing.startedAt < staleWindow) return;
      staleSteals.set(projectId, (staleSteals.get(projectId) ?? 0) + 1);
    }
    // Take (or steal) the claim with a fresh token. Only the holder of THIS token may release it or
    // write store state below, so an abandoned (stolen-from) scan settling later is a no-op.
    const token = {};
    refreshInFlight.set(projectId, { token, startedAt: now });
    /** True only while THIS refresh still owns the claim — a steal replaces the token. */
    const ownsClaim = () => refreshInFlight.get(projectId)?.token === token;
    /** Apply a store update only if this refresh still owns the claim, so a stolen-from scan can't
     *  clobber the fresher snapshot or flip `loading` out from under the scan that replaced it. */
    const commit = (updater: (s: BeadsState) => Partial<BeadsState>) => {
      if (ownsClaim()) set(updater);
    };
    /**
     * Write a SUCCESSFUL read.
     *
     * ══ AN UNCHANGED POLL REUSES THE PREVIOUS SNAPSHOT OBJECT ═════════════════════════════════
     * …and with it the `beads` array and `board` object references that ~60 `AgentRow`s select
     * every 5 seconds. `snapshotUnchanged` is the whole point of this branch; see its docstring
     * for why a positional compare (and why comparing the board separately) is the right test.
     * When it holds, the `byProject` MAP is returned unchanged too, so a selector reading the
     * per-project entry (`BoardView`) or the whole map (`BeadPillHost`) is equally unaffected.
     *
     * Freshness is stamped either way — an unchanged read is still a read, and the cross-project
     * sweep's back-to-back guard depends on that. It is deliberately NOT `snapshot.loadedAt`; see
     * `polledAt`.
     *
     * `loading` and `error` are written exactly as before: `loading` genuinely toggles true→false
     * around every fetch, so suppressing that would change the loading contract, and clearing
     * `error` on success is the behaviour `clears a prior error on a subsequent successful
     * refresh` pins. Neither is what re-renders the rows.
     */
    const commitSnapshot = (beads: Bead[], board: Board) => {
      if (ownsClaim()) polledAt.set(projectId, Date.now());
      commit((s) => {
        const prev = s.byProject[projectId];
        const next =
          prev !== undefined && snapshotUnchanged(prev, beads, board)
            ? prev
            : { beads, board, loadedAt: Date.now() };
        return {
          byProject: next === prev ? s.byProject : { ...s.byProject, [projectId]: next },
          loading: { ...s.loading, [projectId]: false },
          error: { ...s.error, [projectId]: undefined },
        };
      });
    };
    commit((s) => ({ loading: { ...s.loading, [projectId]: true } }));
    try {
      // CONCURRENTLY, not in sequence. `list_beads` is the 5s-poll hot path the perf work in
      // notes.rs targets, and the blocked query is independent of it — running them together costs
      // one wall-clock round trip instead of two. `blockedBeadIds` never rejects (it degrades to an
      // empty set), so this cannot turn a working board into a failed one.
      const [beads, blocked] = await Promise.all([listBeads(projectPath), blockedBeadIds(projectPath)]);
      const board = bucketBeads(beads, blocked);
      commitSnapshot(beads, board);
      // Post-poll auto-decompose watcher (spec §7). Every guard (main-window election, AI gate,
      // baseline, re-entrancy) lives in the service so the store stays dumb. Fire-and-forget —
      // it never throws, and the next poll picks up whatever labels/children it wrote.
      // GATED ON THE CLAIM: this watcher WRITES beads and spends AI, and its service-side re-entrancy
      // guard covers overlap, not a late replay. A scan whose claim was stolen would run it against a
      // board ≥ a staleness window old — re-picking an epic the successor already decomposed and
      // firing a second paid decompose with duplicate children. So it, like the writes, only runs
      // while this refresh still owns the claim.
      if (runWatchers && ownsClaim()) void runDecomposeWatcherForPoll(projectId, projectPath, board);
    } catch (e) {
      // Brand-new project whose beads DB was never created: bd rejects every read with
      // "no beads database found". Auto-init one (once per project this session) and retry the
      // list so the board self-heals into an empty state instead of surfacing that raw error —
      // "beads by default". Only the recognized "no DB" case triggers this; any other failure, or
      // a still-failing retry, falls through to the normal error path below.
      //
      // ══ `allowAutoInit` IS WHAT KEEPS "BEADS BY DEFAULT" FROM BECOMING "BEADS EVERYWHERE" ══════
      // Auto-init WRITES to the user's repo — it creates a `.beads/` store — and that is a fair
      // trade for a project someone has opened a board on, because they asked to see the board.
      // It is NOT a fair trade for the cross-project resolution sweep, which reads every registered
      // project the moment the concierge mounts: that would silently create a beads DB in every
      // repo the user has ever added, unprompted and invisibly. The sweep passes `false`, so a
      // project with no DB simply contributes no beads and its ids stay prose — the same outcome
      // the reader already had, at no cost to their repo.
      //
      // `autoInitAttempted` is deliberately NOT marked on the suppressed path. The one-shot budget
      // belongs to the caller that is allowed to spend it, so a later BOARD poll on the same
      // project can still self-heal exactly as it does today.
      if (isBeadsUnavailable(e) && allowAutoInit && !autoInitAttempted.has(projectId)) {
        autoInitAttempted.add(projectId);
        try {
          await ensureBeadsDb(projectPath);
          const [beads, blocked] = await Promise.all([
            listBeads(projectPath),
            blockedBeadIds(projectPath),
          ]);
          const board = bucketBeads(beads, blocked);
          commitSnapshot(beads, board);
          if (runWatchers && ownsClaim()) void runDecomposeWatcherForPoll(projectId, projectPath, board);
          return;
        } catch (initErr) {
          // Init (or the retried list) failed — e.g. `bd` isn't installed. Surface THIS error
          // instead of the original "no DB" one, and clear loading. The one-shot guard above
          // stays set so we don't hammer `bd init` on every subsequent poll.
          commit((s) => ({
            loading: { ...s.loading, [projectId]: false },
            error: {
              ...s.error,
              [projectId]: initErr instanceof Error ? initErr.message : String(initErr),
            },
          }));
          return;
        }
      }
      // ══ A SUPPRESSED AUTO-INIT REPORTS NOTHING, BECAUSE NOBODY ASKED ═══════════════════════════
      // Reached only when auto-init was declined above, i.e. the cross-project sweep found a project
      // with no beads DB. Falling through to the error commit below would be a WRITE the sweep's
      // whole design is trying to avoid — a different one than `bd init`, but visible in the same
      // way: `error` is shared, and `BoardView` renders `s.error[project.id]` as a banner. So the
      // concierge merely mounting would record "no beads database found" for a project in the
      // background, and the banner would then paint the moment the user opened that board — for the
      // whole duration of the init + retry that used to happen silently. Before the sweep existed
      // that entry was never set at all: the board's OWN refresh auto-healed inside the catch and
      // the user saw an empty board.
      //
      // "A project the sweep could not read" is not news for a surface nobody has opened. Clear
      // `loading` and say nothing; the board's own refresh will still heal it when someone looks.
      if (isBeadsUnavailable(e) && !allowAutoInit) {
        commit((s) => ({ loading: { ...s.loading, [projectId]: false } }));
        return;
      }
      // Best-effort: a bd/parse failure must not break the UI. Keep the last snapshot,
      // surface the message, and clear the loading flag.
      commit((s) => ({
        loading: { ...s.loading, [projectId]: false },
        error: { ...s.error, [projectId]: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      // Release the guard, but ONLY if we still own it. The `return`s inside the catch still run
      // this. A scan whose claim was stolen (presumed hung, then a later tick took over) must NOT
      // delete the successor's claim — that would re-open the convoy — so the release is gated on
      // the token, exactly like the writes above. Reaching here while still owning the claim also
      // proves this scan COMPLETED (success or error) rather than hanging, so the store is
      // responsive: reset the steal-backoff counter.
      if (ownsClaim()) {
        refreshInFlight.delete(projectId);
        staleSteals.delete(projectId);
      }
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
    // NB: recovery of a hung in-flight refresh is NOT done here. Teardown only fires when the viewer
    // count reaches zero, and `BeadPillHost` holds a permanent passive claim on the selected project
    // — the one most likely to wedge — so its count never reaches zero. Releasing the claim on
    // teardown would therefore miss exactly that project, and (being untokenized) could free a claim
    // a remount had already replaced. Recovery is instead time-based: a claim older than
    // BEADS_STALE_REFRESH_MS is stolen by a later tick in `refresh`, which covers every project.
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
