// conciergeBacklogStore — the turns that are OLDER than the live thread, paged back in from SQLite.
//
// ── WHY THIS EXISTS AT ALL (bead sparkle-7m719, and the reason it stalled four times) ────────────
// `conciergeThreadStore` caps the visible conversation at CONCIERGE_THREAD_MAX = 200 and trims from
// the FRONT at persist time. So the thread scrubber rail can be dragged to a dot from three days ago
// and there is NOTHING LOADED to scroll to — the bubble the dot names was evicted from the live
// window and only exists in the durable history table. Drawing the rail without this store produces
// a control that answers every old pick by doing nothing, which is worse than not shipping it.
//
// ── EPHEMERAL, DELIBERATELY. NO `persist` MIDDLEWARE. ────────────────────────────────────────────
// Everything here is a CACHE of rows that are already durable in SQLite. Persisting it would mint a
// second copy of the human's verbatim words in `localStorage` beside the one
// `conciergeThreadStore` already keeps — the residue class `conciergeIdentityReset`'s header
// enumerates — and buy nothing: the query that filled it is cheap and indexed
// (`idx_entries_created`), so a relaunch can simply ask again.
//
// It is still per-human state that a reader can see, so it is registered in
// `resetConciergeIdentityState` regardless (see `clearConciergeBacklog` at the bottom). "Not
// persisted" is not the same as "cannot leak": the store outlives a sign-out inside one process,
// which is exactly the moment one person's conversation can reach another's screen.
import { create } from "zustand";
import type { ConciergeMessage } from "../components/Concierge/types";
import { entriesInRange, type HistoryRangeRow } from "../services/history";
import { bubbleIdForCurrentSession } from "../services/conciergeSessionToken";
import {
  RESTORED_ID_PREFIX,
  useConciergeThreadStore,
} from "./conciergeThreadStore";

/**
 * How many rows ONE `entriesInRange` call asks for.
 *
 * Matches the Rust-side default (`history.rs`), which is documented as ~20× the live thread's
 * `CONCIERGE_THREAD_MAX`. Named here rather than left to the default because the paging loop below
 * has to be able to TELL a full page from a short one, and it cannot do that against a limit it did
 * not choose.
 */
export const CONCIERGE_BACKLOG_PAGE = 400;

/**
 * How many rows one `loadBack` will walk before it gives up on reaching the target.
 *
 * The SQL cap drops from the OLDEST end (see `promptsInRange`'s doc), so a range wider than one page
 * comes back as the NEWEST 400 rows of it — with the very row the reader picked missing. The loop
 * therefore walks backwards a page at a time until the requested instant is inside what it fetched.
 * Bounded so a 1-year drag over a busy history cannot turn one gesture into an unbounded fan of
 * queries; at 3 pages that is 1,200 turns between the pick and now before the walk stops short.
 */
export const CONCIERGE_BACKLOG_MAX_PAGES = 3;

/**
 * The hard ceiling on retained backlog entries.
 *
 * REQUIRED, because `loadBack` accumulates: without it, repeated drags across a long history grow
 * one array until the tab is unusable, and nothing in the drag gesture bounds how many times it can
 * happen. 800 is 4× the live thread's own cap — enough that a reader who paged back twice still has
 * a continuous conversation, small enough that the rows are a few hundred KB rather than tens of MB.
 *
 * ── WHICH END IS DROPPED, AND WHY IT IS THE NEWEST ─────────────────────────────────────────────
 * The obvious rule — drop the oldest, like every other cache here — is exactly backwards for this
 * one. `loadBack` is called with the instant the reader just picked, which is the OLDEST end of what
 * it fetches; dropping from that end throws away the single message the whole gesture was about, and
 * the jump that follows finds nothing. The newest end is the safe one to lose: those turns are
 * adjacent to the live thread, which is still on screen above nothing and below everything, and many
 * of them are duplicates of it already.
 */
export const CONCIERGE_BACKLOG_MAX = 800;

/**
 * How much of a message's text identifies it when its id cannot (see {@link dedupeAgainstLive}).
 *
 * Long enough that two different turns essentially never collide, short enough that a live bubble
 * clipped by `CONCIERGE_MSG_MAX_LEN` still matches its unclipped twin in history.
 */
const TEXT_KEY_CHARS = 200;

/**
 * THE IO SEAM — one object, read by the store's actions on every call, production values baked in.
 *
 * NOT `deps = realThing` on the action's signature. AGENTS.md records why that shape is a trap: when
 * every test passes its own `deps`, the one line that supplies the real value is covered by nothing
 * and can be deleted with the suite still green. Here the production line IS the only line — the
 * action always reads `io.entriesInRange` — so a test that swaps the query drives the identical code
 * path the app does, and deleting the wiring below reds every test in the file.
 *
 * `now` is in here for the same reason it is injected into `useThreadScrubber`: it is COUPLED to the
 * row timestamps (it bounds the fetch window), and a test that controls only one of the two cannot
 * tell a working pager from a broken one.
 */
const io = {
  entriesInRange,
  now: () => Date.now(),
};

export type ConciergeBacklogIo = typeof io;

/**
 * Swap the IO seam. TEST ONLY — returns a restore function.
 *
 * Exported rather than hidden behind a mock of `services/history` so a test drives the real store
 * with only the query replaced; mocking the module would also replace whatever else the store
 * happens to import from it later, silently.
 */
export function setConciergeBacklogIo(next: Partial<ConciergeBacklogIo>): () => void {
  const previous = { ...io };
  Object.assign(io, next);
  return () => Object.assign(io, previous);
}

/** One history row, as a bubble the thread can draw. See {@link bubbleIdForRow} for the id. */
export function rowToMessage(row: HistoryRangeRow): ConciergeMessage {
  const id = bubbleIdForRow(row.id);
  return row.kind === "prompt"
    ? { id, kind: "you", text: row.text }
    : { id, kind: "sparkle", text: row.text, settled: true };
}

/**
 * The namespace a history row draws under when THIS app load did not write it. See
 * {@link bubbleIdForRow} for why it exists — in short, a bare row id is one the bubble counter is
 * reissuing right now. Any string no id `nextId` mints can equal would do; this one reads.
 */
export const HISTORY_ROW_ID_PREFIX = "history:";

/**
 * A history row id, as the bubble id the live thread would know it by.
 *
 * ── THE ID IS THE WHOLE JUMP MECHANISM ─────────────────────────────────────────────────────────
 * A marker id off the rail is handed to `ConciergeThread`'s `jumpTo`, which scans for
 * `[data-message-id]` — so whatever this returns has to be the same string the bubble renders, end
 * to end. It also has to be the string the LIVE thread uses, because `dedupePairsAgainstLive` finds
 * an already-visible turn by a set membership test on exactly these ids.
 *
 * ── WHY THIS IS NO LONGER THE IDENTITY IT ONCE WAS ─────────────────────────────────────────────
 * It used to be, and this function used to be `row.id` verbatim: `conciergeHistoryCapture` wrote the
 * bubble id straight through as the row's primary key. That is precisely the defect that lost ten
 * days of the founder's messages — `ConciergeHost` mints bubble ids from a counter that RESTARTS AT
 * 0 on every app reload, so the second load's `you-1` collided with the first's in an
 * `INSERT OR IGNORE` sink and was dropped. Row ids are now namespaced per app load,
 * `${sessionToken}:${bubbleId}` (see `services/conciergeSessionToken`).
 *
 * So the storage key and the bubble id have come apart, and this is the ONE place that puts them
 * back together. `bubbleIdForCurrentSession` returns the bare bubble id for a row THIS app load
 * wrote — which is what makes a turn the reader can already see dedupe against its live twin
 * instead of rendering a second time — and `null` for a previous load's row or a legacy
 * un-namespaced one.
 *
 * Getting this wrong fails SILENTLY in both directions: too clever and the rail stops jumping, too
 * literal and every turn of the current session draws twice above the live thread.
 *
 * ── WHY A ROW THAT IS NOT OURS IS PREFIXED RATHER THAN PASSED THROUGH (bead sparkle-jmah0e) ─────
 * This used to be `?? rowId`, handing a LEGACY un-namespaced row id — `you-9`, `brain-4` — straight
 * back out. Those are exactly the ids `ConciergeHost`'s counter is minting again RIGHT NOW, because
 * it restarts at 0 on every app reload. So the founder's message from a previous load arrived here
 * wearing the same id as a live bubble holding completely different text, and the membership test in
 * `dedupePairsAgainstLive` threw the older one away — the same silent discard as the
 * `INSERT OR IGNORE` sink this bead fixed, one layer up and on the READ side. The scrubber's
 * `stored` map collided the same way, captioning a live mark with a legacy row's prompt and age,
 * which is the founder's own report: "it's giving me, like, some random prompts".
 *
 * The write half of the bead namespaced NEW rows and deliberately left the thousands of legacy rows
 * in place, on the argument that they "still read fine". That argument holds at the helper — which
 * correctly reports them not-on-screen — and was lost at this caller's `??`.
 *
 * The prefix is applied to EVERY row this load did not write, not just the legacy ones, so the
 * invariant is one sentence with no case analysis: A BACKLOG BUBBLE ID EQUALS A LIVE BUBBLE ID ONLY
 * WHEN THEY ARE THE SAME TURN. A previous load's namespaced key happens not to collide with any id
 * `nextId` mints today, but that is an accident of two formats, not a rule anything enforces.
 *
 * It stays UNIQUE and STABLE, which is all the rail needs: the row id is a primary key, and the
 * prefixed string is what the bubble RENDERS as `data-message-id`, what `stored` is keyed by, what
 * `isLoaded` tests and what `jumpTo` scans for — every one of those goes through this function, so
 * the two sides cannot drift apart.
 */
export function bubbleIdForRow(rowId: string): string {
  const mine = bubbleIdForCurrentSession(rowId);
  return mine ?? `${HISTORY_ROW_ID_PREFIX}${rowId}`;
}

/**
 * `kind` + a bounded prefix of the text — the identity of a turn whose id was rewritten.
 *
 * The separator is written as the ESCAPE `\u0000`, never as a literal NUL. A raw NUL in a source
 * file makes git treat the whole file as BINARY — no diff, no review — and it makes `grep` go silent
 * on it, which costs a debugging round before anyone suspects the file rather than the pattern.
 * `src/services/sourceIsText.test.ts` is the guard, and it caught exactly this here. The runtime
 * string is identical; a separator no message text can contain is what keeps `you` + "abc" from
 * colliding with a hypothetical kind `youa` + "bc".
 */
function textKey(kind: string, text: string): string {
  return `${kind}\u0000${text.trim().slice(0, TEXT_KEY_CHARS)}`;
}

/**
 * Drop every backlog entry the live thread is ALREADY showing.
 *
 * ── TWO MATCHES, BECAUSE A RESTORED BUBBLE HAS LOST ITS ID ─────────────────────────────────────
 * The easy half is by id: a turn from this session is in `chat` under the same id
 * {@link bubbleIdForRow} recovers from its history row, so a set membership test finds it. That
 * recovery is load-bearing here, not cosmetic — the row's own primary key is namespaced per app
 * load and would match nothing.
 *
 * The half that is easy to get wrong is the RESTORED thread. `rehydrateThread` re-ids every
 * persisted bubble as `restored:<i>` — deliberately, so a replayed message cannot collide with an id
 * a fresh session mints — which means the live bubble and its history row share NO id at all. They
 * are the same turn: it was captured under its original id during the session that produced it (and
 * `conciergeHistoryCapture` skips the restored replay precisely so it is not captured twice). So an
 * id-only dedupe renders the whole restored window twice, once as a `restored:` bubble and once as
 * its backlog twin, which is the state a reader would call broken.
 *
 * There is no honest way to recover the original id — it was overwritten — so those are matched on
 * `kind` + a text prefix instead. The prefix rather than the whole string because the persisted copy
 * is clipped to `CONCIERGE_MSG_MAX_LEN` with a suffix appended while the history row holds the
 * message whole; comparing the two in full would find no match on exactly the long messages a reader
 * is most likely to notice duplicated.
 */
export function dedupeAgainstLive(
  entries: ConciergeMessage[],
  live: ConciergeMessage[],
): ConciergeMessage[] {
  // A THIN WRAPPER, deliberately: the filtering rule lives once, in the timed version below. The
  // untimed callers (and this function's own suite) keep working unchanged.
  return dedupePairsAgainstLive(
    entries.map((m) => ({ m, t: 0 })),
    live,
  ).map((p) => p.m);
}

/** A backlog entry travelling with the instant it was sent. See `backlogTimes` for why the time is
 *  carried rather than re-derived. */
export interface TimedEntry {
  m: ConciergeMessage;
  t: number;
}

/**
 * {@link dedupeAgainstLive}, but keeping each entry's instant attached.
 *
 * THE PRIMITIVE, with `dedupeAgainstLive` delegating to it — one filtering rule, so the timed and
 * untimed paths cannot disagree about which turns survive. The trim that follows this reads the
 * surviving times to state the window honestly, and a second implementation here would be a second
 * chance to get that wrong.
 */
export function dedupePairsAgainstLive(entries: TimedEntry[], live: ConciergeMessage[]): TimedEntry[] {
  const ids = new Set(live.map((m) => m.id));
  const restoredText = new Set(
    live
      .filter((m) => m.id.startsWith(RESTORED_ID_PREFIX) && "text" in m)
      .map((m) => textKey(m.kind, (m as { text: string }).text)),
  );
  const seen = new Set<string>();
  return entries.filter(({ m: e }) => {
    if (ids.has(e.id)) return false;
    if (!("text" in e)) return true;
    const key = textKey(e.kind, e.text);
    if (restoredText.has(key)) return false;
    // …and against ITSELF: two `loadBack` calls whose windows overlap would otherwise stack the same
    // rows twice, which looks identical to the restored-twin bug from the reader's chair.
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

/**
 * The contiguous run of at most `max` entries surrounding `targetMs`.
 *
 * `entries` must be sorted ascending by `t`. Returns the whole array when it already fits. The
 * window is anchored on the entry nearest the target and then clamped to the array's ends, so the
 * target's own turn is always inside it — which is the property that stops a hole-filling load from
 * discarding the very turn it just fetched (roborev 66541).
 */
export function sliceAround(entries: TimedEntry[], targetMs: number, max: number): TimedEntry[] {
  if (entries.length <= max) return entries;
  let anchor = 0;
  let best = Infinity;
  for (let i = 0; i < entries.length; i++) {
    const d = Math.abs(entries[i]!.t - targetMs);
    if (d < best) {
      best = d;
      anchor = i;
    }
  }
  // Bias the window OLDER than the anchor: the reader picked this turn and reads downward from it.
  let start = anchor - Math.floor(max / 2);
  if (start < 0) start = 0;
  if (start + max > entries.length) start = entries.length - max;
  return entries.slice(start, start + max);
}

export interface ConciergeBacklogState {
  /** Older turns, OLDEST-FIRST, ready to render above the live thread. */
  backlog: ConciergeMessage[];
  loading: boolean;
  /** The oldest instant currently paged in, or null when nothing is. */
  loadedFromMs: number | null;
  /**
   * The NEWEST instant currently paged in, or null when nothing is.
   *
   * Not part of the contract the rail was specified against, and held because `loadedFromMs` alone
   * cannot answer the idempotence question once {@link CONCIERGE_BACKLOG_MAX} has dropped entries
   * off the new end: a target inside `[loadedFromMs, ∞)` may sit in the hole that trim left, and
   * treating it as loaded is how a pick silently does nothing.
   */
  loadedToMs: number | null;
  /**
   * `backlog[i]`'s instant, same order and same length.
   *
   * A PARALLEL ARRAY because `ConciergeMessage` carries no timestamp of its own — the type predates
   * this feature and widening it would touch every producer of a bubble. Without it the store
   * cannot answer "what is the newest turn I actually still hold", which is exactly the question
   * {@link CONCIERGE_BACKLOG_MAX}'s trim makes load-bearing (VADE r3827348136): `loadedToMs` was
   * derived from the newest FETCHED row, but the trim can drop rows that were just fetched, so the
   * claimed window reached past the newest RETAINED turn. A pick landing in that gap satisfied the
   * idempotence check, returned without querying, and scrolled to a message that is not there.
   *
   * Not part of the public rail contract; the thread renders `backlog` alone.
   */
  backlogTimes: number[];
  error: string | null;
  /** Page in everything from `targetMs` up to whatever is already loaded (or now). Idempotent:
   *  a target already inside the loaded window resolves without a query. */
  loadBack: (targetMs: number) => Promise<void>;
  clear: () => void;
}

/** Serialises overlapping `loadBack` calls — a drag can emit several before the first resolves. */
let inFlight: Promise<void> | null = null;

export const useConciergeBacklogStore = create<ConciergeBacklogState>()((set, get) => ({
  backlog: [],
  backlogTimes: [],
  loading: false,
  loadedFromMs: null,
  loadedToMs: null,
  error: null,
  loadBack: async (targetMs: number) => {
    // Wait out whatever is already running before deciding anything: the window this call would
    // widen is the one that call is about to write, and reading it early makes two overlapping drags
    // issue the same query twice and render the result twice.
    while (inFlight) await inFlight.catch(() => {});
    const covered = (): boolean => {
      const { loadedFromMs, loadedToMs } = get();
      // BOTH ends, not just the old one. A target NEWER than what is retained sits in the hole
      // CONCIERGE_BACKLOG_MAX's trim left behind, and reporting that as loaded is precisely how a
      // pick resolves instantly and scrolls to nothing.
      return (
        loadedFromMs !== null &&
        loadedToMs !== null &&
        targetMs >= loadedFromMs &&
        targetMs <= loadedToMs
      );
    };
    if (covered()) return;
    const run = (async () => {
      set({ loading: true, error: null });
      try {
        const state = get();
        // The top of the window: the oldest thing already paged in, or NOW on the first load. Using
        // the loaded edge is what keeps the backlog contiguous — a second drag extends the same
        // window rather than opening a detached one with a hole between them.
        /**
         * Is this walk EXTENDING the window downward, or opening a new one?
         *
         * The distinction decides whether the previous backlog may be kept, and getting it wrong is
         * how the store came to hold two DISJOINT time ranges as one flat block (roborev 66546).
         * Extending down starts at the loaded edge and meets what is already held, so the union is
         * contiguous. Starting at `now` — which is what a target NEWER than the window requires —
         * covers `[target, now]` while the old window sits below `loadedToMs`, with a genuine gap
         * between them. Merging those two produced a backlog rendering `r899` directly beneath
         * `r799` with a hundred turns silently missing: a plausible-looking false history, which is
         * worse than the out-of-order render it replaced.
         */
        const extendingDown = state.loadedFromMs !== null && state.loadedFromMs > targetMs;
        let edge = extendingDown ? state.loadedFromMs! : io.now();
        const fetched: HistoryRangeRow[] = [];
        /** Did the walk actually get back as far as `targetMs`? See `from` below — this is the ONE
         *  fact that decides whether the store may claim coverage, and inferring it from the rows
         *  instead is wrong in the ordinary case: a quiet window legitimately returns its oldest row
         *  well after the requested instant, and that IS full coverage. */
        let reachedTarget = false;
        for (let page = 0; page < CONCIERGE_BACKLOG_MAX_PAGES; page++) {
          const rows = await io.entriesInRange(
            targetMs,
            edge,
            "concierge",
            CONCIERGE_BACKLOG_PAGE,
          );
          fetched.unshift(...rows);
          // A SHORT PAGE means the range is exhausted — every row between the target and the edge is
          // now in hand, however few that is. A FULL page means the SQL cap may have dropped rows off
          // the old end (it drops oldest-first), so the walk only stops if the oldest row it did
          // return is already at or before the target.
          if (rows.length < CONCIERGE_BACKLOG_PAGE) {
            reachedTarget = true;
            break;
          }
          const oldest = rows[0]!.createdAt;
          if (oldest <= targetMs) {
            reachedTarget = true;
            break;
          }
          // Strictly older every iteration, so the loop cannot spin on one instant.
          edge = oldest - 1;
        }
        const live = useConciergeThreadStore.getState().chat;
        // EVERY ENTRY TRAVELS WITH ITS INSTANT, through the dedupe and through the trim. The times
        // cannot be recovered afterwards — `ConciergeMessage` has no timestamp — and re-deriving
        // them from `fetched` is what produced VADE r3827348136: the trim can drop rows that were
        // just fetched, so "the newest row I fetched" is not "the newest turn I still hold".
        const prev = get();
        // The previous backlog is carried ONLY when this walk joins it (see `extendingDown`). A
        // fresh window REPLACES: holding a disjoint older range alongside it would claim a history
        // the store does not have.
        const carried = extendingDown
          ? prev.backlog.map((m, i) => ({ m, t: prev.backlogTimes[i] ?? 0 }))
          : [];
        const mergedPairs = dedupePairsAgainstLive(
          [...fetched.map((r) => ({ m: rowToMessage(r), t: r.createdAt })), ...carried],
          live,
        );
        // ORDERED BY TIME BEFORE ANYTHING READS A POSITION (roborev 66541). `mergedPairs` is
        // `[...fetched, ...previous]`, and on the path that FILLS A HOLE the fetched block is NEWER
        // than what is already held — so the array runs newest-block-first and "the last element"
        // is not the newest turn. Two things went wrong on that unsorted array: the window came out
        // INVERTED (`from > to`, which `covered()` can never satisfy, killing idempotence for the
        // rest of the session), and the backlog would have RENDERED out of order above the live
        // thread. Sorting once fixes both; ties break on id so the order is total and stable.
        const sorted = [...mergedPairs].sort((a, b) => a.t - b.t || a.m.id.localeCompare(b.m.id));
        // KEEP THE WINDOW AROUND THE TARGET, not simply the oldest N. Trimming from the new end is
        // right when paging BACKWARD — the old end is what the reader picked — but it is exactly
        // wrong when filling a hole: the turn just fetched IS the newest, so a blind
        // trim-the-new-end throws away the thing the reader asked for and the next pick re-fetches
        // it forever. Centring on the target keeps the slice contiguous and always containing it.
        const boundedPairs = sliceAround(sorted, targetMs, CONCIERGE_BACKLOG_MAX);
        const trimmed = boundedPairs.length < sorted.length;
        // WHICH END the trim took from — they claim different halves of the window and only the end
        // that actually lost entries may be clamped.
        const droppedNewest =
          trimmed && boundedPairs[boundedPairs.length - 1] !== sorted[sorted.length - 1];
        const droppedOldest = trimmed && boundedPairs[0] !== sorted[0];
        // The window we can HONESTLY claim to hold. `targetMs` when the walk reached it, the oldest
        // row we did get otherwise — a walk that ran out of pages must not report coverage it does
        // not have, or the next pick inside the gap resolves without a query and scrolls to nothing.
        const oldestFetched = fetched.length > 0 ? fetched[0]!.createdAt : null;
        const oldestRetained = boundedPairs.length > 0 ? boundedPairs[0]!.t : null;
        const claimedFrom = reachedTarget
          ? targetMs
          : (oldestFetched ?? state.loadedFromMs ?? targetMs);
        // …and never older than what SURVIVED, but ONLY when the trim actually took from the old
        // end. Clamping unconditionally breaks the ordinary case: a QUIET window legitimately
        // returns its oldest row well after the requested instant, and that is full coverage — so
        // raising `from` to it would make every repeat pick re-query and kill idempotence.
        const from =
          droppedOldest && oldestRetained !== null
            ? Math.max(claimedFrom, oldestRetained)
            : claimedFrom;
        // …and the NEW end, read off what SURVIVED the trim rather than off what was fetched. When
        // nothing was dropped the window still runs to the live thread, which covers everything
        // newer (the dedupe above is what makes that true).
        // Now that the slice is sorted AND contiguous, its ends ARE the window — no scan needed.
        const newestRetained =
          boundedPairs.length > 0 ? boundedPairs[boundedPairs.length - 1]!.t : null;
        // A FRESH window's new end is NOW — the live thread covers above it. Carrying the old
        // `loadedToMs` forward here is what let `to` sit BELOW an advanced `from` and invert the
        // window (roborev 66546): the previous window is not this one.
        const priorTo = extendingDown ? (state.loadedToMs ?? io.now()) : io.now();
        const claimedTo = droppedNewest ? (newestRetained ?? priorTo) : priorTo;
        // THE WINDOW MUST AT LEAST COVER WHAT IT HOLDS. On the hole-filling path the fetched rows
        // are NEWER than the previous window, so carrying the old `loadedToMs` forward left `to`
        // behind turns now actually retained — and with `from` advanced to the target that produced
        // an INVERTED window (`from > to`), which `covered()` can never satisfy: idempotence dead,
        // every later drag re-querying (roborev 66541). Under-claiming is safe; inverting is not.
        const to =
          newestRetained !== null ? Math.max(claimedTo, newestRetained) : claimedTo;
        // THE INVARIANT IS `from <= to`, and it is upheld BY CONSTRUCTION rather than by a clamp.
        // `covered()` tests `from <= x <= to`, so an inverted window is not merely wrong — it can
        // never be satisfied again, killing idempotence for the session and making every later drag
        // re-query. Two separate bugs reached that state (roborev 66541 via an unsorted array,
        // 66546 via a fetch the dedupe emptied), so a defensive `Math.min(from, to)` was the
        // obvious third guard — and mutation-checking it showed it INERT: with `priorTo` keyed to
        // `extendingDown` above, no input reaches it. An inert line with a confident comment is
        // worse than no line, so it is gone; `never inverts its window …` in the suite is what
        // actually holds this, and it goes red if `priorTo` regresses.
        set({
          backlog: boundedPairs.map((p) => p.m),
          backlogTimes: boundedPairs.map((p) => p.t),
          loading: false,
          loadedFromMs: from,
          loadedToMs: to,
        });
      } catch (e) {
        // KEPT, NOT THROWN. `onPick` awaits this before it jumps, and a rejection there would take
        // out the rail's own click handler — the reader would get a dead control and a console
        // trace instead of a thread that simply did not grow.
        set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    inFlight = run;
    try {
      await run;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  },
  clear: () =>
    set({
      backlog: [],
      backlogTimes: [],
      loading: false,
      loadedFromMs: null,
      loadedToMs: null,
      error: null,
    }),
}));

/** Subscribe to the paged-in turns. */
export function useConciergeBacklog(): ConciergeMessage[] {
  return useConciergeBacklogStore((s) => s.backlog);
}

/**
 * Drop the paged-in conversation — the IDENTITY reset.
 *
 * The FIFTH-and-counting per-human concierge store, and it is registered in
 * `resetConciergeIdentityState` in the same commit that creates it rather than a roborev round later
 * (see that module's header: every previous instance was written with a reset function nobody
 * called). What it holds is the same class as `conciergeThreadStore`'s — the human's own words,
 * verbatim, not a redaction — and it has both halves that make residue reachable: `ConciergeHost`
 * reads it, and the rail hands it a fresh reason to fill on any drag.
 *
 * It is not `persist`ed, so there is no storage key to remove; clearing the live state IS the whole
 * job here, unlike the thread store where `clearStorage()` had to follow the `set`.
 */
export function clearConciergeBacklog(): void {
  useConciergeBacklogStore.getState().clear();
}
