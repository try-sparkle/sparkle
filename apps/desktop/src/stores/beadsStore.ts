// beadsStore — holds the latest beads board snapshot per project and manages polling.
// The snapshot is live-only (re-fetched from `bd` on each poll) so nothing is persisted.
// Timer handles live at module scope (not in store state) so the store stays serializable
// and a re-render never touches the interval.
import { create } from "zustand";
import {
  listBeads,
  blockedBeadIdsOrNull,
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

/**
 * The FLOOR on the poll cadence, and the fixed interval a caller gets by passing `intervalMs`
 * explicitly. NOT what schedules an ordinary board poll any more — see `nextPollDelayMs`.
 *
 * ══ WHY A FIXED 5s INTERVAL WAS THE BUG, NOT THE BASELINE ══════════════════════════════════════
 * `bd` is neither local-and-cheap nor a constant cost, which is what the old comment here assumed.
 * Measured against this repo's real ~4,000-bead embedded-Dolt store:
 *
 *     bd version (opens no DB) :  ~230 ms
 *     bd list --all -n 0 --json: 2740 / 4611 / 4463 ms   (4002 rows, 5.7 MB)
 *     bd list --all -n 1 --json: 1681 / 2217 / 5177 ms   ← reading ONE row costs the same
 *     bd blocked --json        : 1860 / 1466 / 1285 ms
 *     bd update <id> (a WRITE) : 3438 / 3710 / 3866 / 29975 ms   ← the app's 30s ceiling
 *
 * Two facts follow. First, the cost is PER-INVOCATION, not per-row — a `-n 1` read costs what a
 * full scan costs — so shrinking or paging the query buys nothing and only the NUMBER of `bd`
 * processes matters. Second, one tick's work (a list + a blocked query, ~4.5–6.5 s together)
 * takes LONGER than the 5s interval that scheduled it. An interval shorter than the work it
 * launches saturates by construction: the store's lock is never free, and a user-initiated write
 * queues behind a read backlog that refills faster than it drains — which is how a `bd update`
 * reached the 30s ceiling and reported "whether the change landed is UNKNOWN". 44 distinct `bd`
 * processes were observed in one 30s window (18 `list`, 12 `blocked`).
 *
 * The in-flight claim below stops those ticks from STACKING, but coalescing a convoy is not the
 * same as leaving the store idle: it still ran back-to-back reads ~100% of the time.
 *
 * Kept exported and still honoured as an explicit `intervalMs` (several suites pin their cadence
 * with it, and a caller that names an interval means it), but the poll now DERIVES its own.
 */
export const BEADS_POLL_INTERVAL_MS = 5000;

/**
 * Fraction of wall-clock time the board poll is allowed to keep the shared `bd` store busy.
 *
 * ══ THE CONSTANT TO JUSTIFY IS THE DUTY CYCLE, NOT AN INTERVAL ═════════════════════════════════
 * An interval is a guess that goes wrong the moment the store's size changes; a duty cycle is a
 * budget that holds at any speed. Waiting `factor × T` after a refresh that itself took `T` gives
 * a cycle of `T × (1 + factor)`, of which `T` is busy — so the duty cycle is `1 / (1 + factor)`
 * and is INDEPENDENT of T. Solving for a 20% budget gives factor 4.
 *
 * Against the measurements above (list only — the blocked query moved to its own cadence, see
 * `BEADS_BLOCKED_REFRESH_MS`):
 *
 *     typical list ~4.0 s  → wait 16.0 s → 20.0 s cycle → 20% duty →  3 bd/min
 *     worst   list  5.2 s  → wait 20.8 s → 26.0 s cycle → 20% duty → ~2 bd/min
 *     a fast store, 0.3 s  → wait  1.2 s → clamped to the 5s floor →  12 bd/min
 *
 * versus the old fixed schedule: a 4.5–6.5 s refresh every 5 s ≈ 100% duty and 24 bd/min (a list
 * AND a blocked query per tick). 20% is chosen because the thing being protected is a user write:
 * at 20% duty a write arriving at a random moment has a 4-in-5 chance of finding the store idle,
 * and in the remaining case waits out at most one read (~4 s) rather than an unbounded backlog.
 * Pushing the budget lower would buy little — the write already gets in — and costs board
 * liveness linearly.
 */
export const BEADS_POLL_DUTY_FACTOR = 4;

/**
 * Floor on the derived cadence — what a FAST store gets.
 *
 * Deliberately the old fixed interval: 5s is the cadence the board has always felt like, nobody
 * has asked for faster, and this change must never be able to INCREASE the load it exists to cut.
 * It binds whenever a refresh completes in under 1.25 s (= 5000 / the factor above), i.e. on a
 * small backlog where the duty budget would allow a sub-second cadence that no human can read.
 */
export const BEADS_POLL_MIN_INTERVAL_MS = BEADS_POLL_INTERVAL_MS;

/**
 * Ceiling on the derived cadence — what a SLOW store gets, so it never goes silent.
 *
 * Binds only once a single refresh exceeds 15 s (= 60000 / the factor), which the measurements
 * above put well outside normal: the store is already pathological by then. The cap trades the
 * duty budget for a liveness floor at that point, because a board that has not moved in over a
 * minute reads as broken to the person watching it, and a poll that never comes back can never
 * observe the store recovering either. One minute also matches `BEADS_BLOCKED_REFRESH_MS`, so a
 * fully-degraded project settles at ~2 `bd` processes a minute in total.
 */
export const BEADS_POLL_MAX_INTERVAL_MS = 60_000;

/**
 * How long the cached blocked-id set is reused before `bd blocked` is asked again.
 *
 * ══ WHY THE BLOCKED QUERY IS NOT PART OF A POLL TICK ANY MORE ══════════════════════════════════
 * It is a WHOLE SEPARATE `bd` process with its own DB open (measured 1285–1860 ms), and it was
 * firing on every tick — 12 of the 44 processes in the observed 30s window — to answer a question
 * about a lane that holds THREE rows and changes only when someone adds or closes a dependency
 * edge. That is a human action, not a background one, so a second-by-second answer is worth
 * nothing. Decoupling it roughly HALVES the poll's process count on its own: a project polling at
 * the derived ~20 s cadence drops from ~6 `bd` processes a minute to ~3 + 1.
 *
 * The lane is allowed to be stale by up to this window. It is NOT allowed to be spuriously EMPTY:
 * a tick that skips the query reuses the last known set, and a FAILED query keeps it too (which is
 * why the store reads `blockedBeadIdsOrNull` rather than the collapsing `blockedBeadIds`). An
 * empty blocked lane is indistinguishable from a healthy one, so degrading to empty would be a
 * silent wrong answer — the failure mode the `columnFor` docstring rejects derived lanes for.
 *
 * NOT derived from the list payload, which would cost zero processes and is the obvious idea:
 * `dependency_count` counts CLOSED blockers too (a bead with all-closed deps is ready, not
 * blocked), and `dependencies` mixes parent-child edges in with real blockers. A lane that lies is
 * worse than a lane that lags.
 */
export const BEADS_BLOCKED_REFRESH_MS = 60_000;

/**
 * The delay before the next poll, derived from how long the last one actually took.
 *
 * Exported for direct unit tests of the clamps; the scheduler in `startPolling` is the only
 * production caller. A non-finite or negative measurement (a clock that jumped backwards) falls
 * back to the floor rather than propagating into the clamp.
 */
export function nextPollDelayMs(lastRefreshMs: number): number {
  if (!Number.isFinite(lastRefreshMs) || lastRefreshMs < 0) return BEADS_POLL_MIN_INTERVAL_MS;
  const derived = Math.round(BEADS_POLL_DUTY_FACTOR * lastRefreshMs);
  return Math.min(BEADS_POLL_MAX_INTERVAL_MS, Math.max(BEADS_POLL_MIN_INTERVAL_MS, derived));
}

/** How long a single in-flight refresh may run before a later tick is allowed to STEAL its claim
 *  and retry. `bd` reads are unbounded (`run_bd` is a bare `Command::output()` with no timeout), so
 *  a scan blocked on the wedged store's lock can hang indefinitely; without a steal it would latch
 *  the concurrency guard for the rest of the session. Set well above a merely-slow-but-progressing
 *  scan (which the guard is meant to coalesce, not steal) so recovery only triggers for a genuinely
 *  stuck one: at 30s — 6× the old fixed interval, and far above every measured read — a claim older
 *  than this is presumed hung. The steal fires at most once per window, so a wedged store retries on
 *  a slow trickle, never a convoy.
 *
 *  DOUBLES AS THE ADAPTIVE POLLER'S WATCHDOG: the self-scheduling chain gives up waiting on a
 *  refresh after exactly this long, so a tick still arrives while the claim is stealable and
 *  recovery does not depend on a scan that may never return. See `startAdaptivePoller`. */
export const BEADS_STALE_REFRESH_MS = 6 * BEADS_POLL_INTERVAL_MS;

/**
 * How often the concierge re-reads the projects it is NOT looking at, so a bead id belonging to one
 * of them still resolves. `BeadPillHost` owns the sweep and the reasoning behind it.
 *
 * SIX TIMES SLOWER than the poll FLOOR, deliberately. Every refresh is a `bd list --all` against
 * the shared embedded store (plus a `bd blocked` on the slow cadence — see
 * `BEADS_BLOCKED_REFRESH_MS`), so sweeping N projects at the board's cadence would multiply the
 * exact subprocess load the in-flight guard above exists to contain — for projects nobody is
 * looking at. A cross-project pill needs EXISTENCE, which does not change
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
  /** Start polling a project: refresh immediately, then on a cadence. Idempotent in the sense that
   *  matters — one poller per project — but REFERENCE-COUNTED, so N viewers of the same project
   *  each hold the poller up and it stops when the last one lets go. See `viewers` below.
   *
   *  `intervalMs` OMITTED (the normal case) means the cadence is DERIVED from how long each refresh
   *  actually takes, so the shared `bd` store stays inside a duty-cycle budget however big the
   *  backlog grows — see `BEADS_POLL_DUTY_FACTOR`. Passing one pins a fixed grid instead; a caller
   *  that names an interval means it.
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

/**
 * One poller per project, kept out of store state so timers never serialize / re-render.
 *
 * A poller owns its own teardown rather than exposing a raw handle, because there are now two
 * shapes behind it — a fixed `setInterval` for a caller that named an interval, and a
 * SELF-SCHEDULING `setTimeout` chain for the derived cadence — and only the poller knows which
 * handles it has armed. `stopPolling` calls `stop()`; a chain that is mid-refresh when that
 * happens must not re-arm, which a caller holding a handle could not enforce.
 */
interface Poller {
  stop: () => void;
}
const timers = new Map<string, Poller>();

/**
 * The last blocked-id set read for each project, and when it was read.
 *
 * `at` is stamped on every ATTEMPT, not only on success, so a project whose `bd blocked` keeps
 * failing is retried on the slow cadence rather than on every list poll — a failing query is still
 * a `bd` process, and retrying it every tick would put back the load this cache removes. `ids`
 * is only ever replaced by a successful read, so a failure leaves the previous (possibly
 * populated) lane standing. See `BEADS_BLOCKED_REFRESH_MS`.
 */
interface BlockedCache {
  ids: ReadonlySet<string>;
  at: number;
}
const blockedCache = new Map<string, BlockedCache>();

/**
 * Read the blocked-id set for a project, asking `bd` only when the cache is cold or past its
 * window. Never throws and never returns a spuriously empty set for a project whose lane was
 * populated — see `BEADS_BLOCKED_REFRESH_MS` for why that distinction is the whole point.
 */
async function blockedIdsFor(projectPath: string, projectId: string): Promise<ReadonlySet<string>> {
  const cached = blockedCache.get(projectId);
  if (cached !== undefined && Date.now() - cached.at < BEADS_BLOCKED_REFRESH_MS) return cached.ids;
  const fresh = await blockedBeadIdsOrNull(projectPath);
  // Stamp the attempt either way; keep the previous ids when the query could not answer. A cold
  // cache that fails settles on an empty lane — the same outcome the collapsing `blockedBeadIds`
  // always gave — but a WARM one is never degraded by a transient failure.
  const ids = fresh ?? cached?.ids ?? new Set<string>();
  blockedCache.set(projectId, { ids, at: Date.now() });
  return ids;
}
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
/** TEST-ONLY. Stamp (or clear) the freshness clock directly.
 *
 *  `polledAt` is written ONLY inside `refresh`'s success commit, so a case that seeds `byProject`
 *  imperatively — the normal way sidebar suites arrange a backlog — gets a snapshot that reads as
 *  never-successfully-polled. Anything gated on freshness then sees `unknown` no matter what beads
 *  it was handed. That is correct in production and useless in a test, so this is the seam.
 *
 *  It exists because the alternative was worse: without it, `engine/retroEvidence`'s honest
 *  "this agent reported nothing" arm is unreachable from a component test, which would leave the
 *  one branch that may write a PERMANENT gap receipt covered only at the unit level. */
export function __setBeadsPolledAtForTest(projectId: string, at: number | undefined): void {
  if (at === undefined) polledAt.delete(projectId);
  else polledAt.set(projectId, at);
}

export function __resetBeadsRefreshInFlightForTest(): void {
  refreshInFlight.clear();
  staleSteals.clear();
  // Freshness is module-scope too, so a case that polled project "p1" would otherwise leave the
  // next case's "p1" looking already-fresh.
  polledAt.clear();
  // Likewise the blocked-id cache: a case that read a populated blocked set for "p1" would
  // otherwise hand it to the next case, whose `bd blocked` mock is then never consulted — turning
  // an assertion about the lane into an assertion about the previous test.
  blockedCache.clear();
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

/** One poll: the visibility gate, then a refresh whose watcher flag is asked FOR THIS TICK.
 *
 *  `wantsWatchers` is asked every time rather than captured when the poller was armed: the last
 *  board can close while a passive viewer keeps the poller alive, and from that moment the
 *  decompose watcher must stop running. Returns the refresh promise, or `undefined` when the tick
 *  was skipped because nobody is looking. */
function pollOnce(
  projectId: string,
  projectPath: string,
  checkVisibility: boolean,
): Promise<void> | undefined {
  // Don't shell out to `bd` for a window nobody's looking at — a backgrounded Tasks tab would
  // otherwise spawn a subprocess every interval for hours doing work no one sees. Skip the spawn
  // and arm a one-shot listener that re-syncs the board the moment it's visible again.
  if (checkVisibility && typeof document !== "undefined" && document.visibilityState === "hidden") {
    armVisibilityRefresh(projectId, projectPath);
    return undefined;
  }
  return useBeadsStore.getState().refresh(projectId, projectPath, wantsWatchers(projectId));
}

/** The poller a caller gets by naming an `intervalMs`: a plain fixed-grid `setInterval`, exactly as
 *  before. Ticks fire on wall-clock regardless of whether the previous refresh has settled — the
 *  in-flight claim is what keeps that from stacking, and the steal path depends on a tick arriving
 *  while a hung scan is still latched. A caller that names an interval means it. */
function startFixedPoller(projectId: string, projectPath: string, intervalMs: number): Poller {
  // Fire immediately so the board isn't empty for a full interval, then on the caller's cadence.
  void pollOnce(projectId, projectPath, false);
  const timer = setInterval(() => void pollOnce(projectId, projectPath, true), intervalMs);
  return { stop: () => clearInterval(timer) };
}

/**
 * The default poller: a self-scheduling chain that waits `nextPollDelayMs(<how long that refresh
 * took>)` after each completed refresh, so the store's duty cycle stays inside the budget however
 * big the backlog grows. See `BEADS_POLL_DUTY_FACTOR` for the arithmetic.
 *
 * ══ WHY IT DOES NOT SIMPLY `await` THE REFRESH ═════════════════════════════════════════════════
 * A `bd` read is unbounded (`run_bd` has no timeout), so a scan against a wedged store can hang
 * forever. A chain that waits for its own refresh before re-arming would then stop for good — and
 * with it the ONLY thing that fires the stale-claim steal in `refresh`, which is what recovers a
 * wedged project. The fixed interval got that for free by ignoring in-flight state; the chain has
 * to buy it back, so it gives up waiting after `BEADS_STALE_REFRESH_MS`.
 *
 * That bound is the steal window and not a new constant on purpose: waiting LONGER would push
 * recovery past the moment the claim became stealable, and waiting less would only produce ticks
 * the in-flight claim drops. A tick with no measurement behind it re-arms at the floor, because a
 * dropped tick costs nothing — it spawns no process — and the point of it is to let the steal path
 * run, not to read anything.
 */
function startAdaptivePoller(projectId: string, projectPath: string): Poller {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  /** The delay to use when this tick produced no measurement (skipped or unsettled). */
  let lastDelay = BEADS_POLL_MIN_INTERVAL_MS;

  const arm = (delay: number) => {
    if (stopped) return; // torn down mid-refresh: never re-arm, or stopPolling would not stop it
    timer = setTimeout(() => void tick(), delay);
  };

  /** Resolve true if the refresh settled within the steal window, false if we gave up waiting. */
  const settleWithin = (p: Promise<void>): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (settled: boolean) => {
        if (done) return;
        done = true;
        if (watchdog !== undefined) clearTimeout(watchdog);
        watchdog = undefined;
        resolve(settled);
      };
      watchdog = setTimeout(() => finish(false), BEADS_STALE_REFRESH_MS);
      // `refresh` never rejects, but treat a rejection as settled rather than hanging the chain.
      void p.then(
        () => finish(true),
        () => finish(true),
      );
    });

  const tick = async (first = false) => {
    timer = undefined;
    if (stopped) return;
    const startedAt = Date.now();
    const running = pollOnce(projectId, projectPath, !first);
    if (running === undefined) {
      arm(lastDelay); // hidden window: nothing measured, keep the chain alive at the last cadence
      return;
    }
    const settled = await settleWithin(running);
    lastDelay = settled ? nextPollDelayMs(Date.now() - startedAt) : BEADS_POLL_MIN_INTERVAL_MS;
    arm(lastDelay);
  };

  // Fire immediately so the board isn't empty for a full cadence. The first refresh is also the
  // first MEASUREMENT, which is why it goes through the chain rather than beside it.
  void tick(true);

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // A chain torn down while waiting on a refresh leaves this armed; clear it so teardown
      // leaves NOTHING pending. (`arm` would no-op anyway — this is about not holding a timer.)
      if (watchdog !== undefined) clearTimeout(watchdog);
      watchdog = undefined;
    },
  };
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
      // would show dead ids for up to a full sweep interval. The cached blocked set goes with it
      // for the same reason: it would otherwise outlive the snapshot it belongs to and bucket the
      // first post-re-enable read against a set up to BEADS_BLOCKED_REFRESH_MS old.
      polledAt.delete(projectId);
      blockedCache.delete(projectId);
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
      // CONCURRENTLY, not in sequence — on the ticks where the blocked query runs at all. It is
      // independent of the list, so when both are due they cost one wall-clock round trip instead
      // of two; most ticks now answer `blockedIdsFor` from cache and spawn no second process (see
      // BEADS_BLOCKED_REFRESH_MS). Neither call rejects, so this cannot turn a working board into
      // a failed one.
      const [beads, blocked] = await Promise.all([
        listBeads(projectPath),
        blockedIdsFor(projectPath, projectId),
      ]);
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
            blockedIdsFor(projectPath, projectId),
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

  startPolling: (projectId, projectPath, intervalMs, kind = "board") => {
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
    if (timers.has(projectId)) return; // already polling — one poller per project
    timers.set(
      projectId,
      intervalMs === undefined
        ? startAdaptivePoller(projectId, projectPath)
        : startFixedPoller(projectId, projectPath, intervalMs),
    );
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
    // The poller owns its own teardown — a fixed interval clears one handle, the adaptive chain
    // also has to refuse to re-arm if it is mid-refresh right now. See `Poller`.
    const poller = timers.get(projectId);
    if (poller !== undefined) {
      poller.stop();
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
