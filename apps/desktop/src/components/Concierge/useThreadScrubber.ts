// useThreadScrubber — the controller behind the concierge thread scrubber rail (beads sparkle-7m719,
// sparkle-bjbhw6).
//
// The rail REPLACES the thread's scrollbar. This hook is everything behind it: it holds the scroller
// element, measures where each of the founder's prompts sits in it, turns a drag into a scroll
// position frame by frame, and pages older turns back in out of SQLite when the scope asks for them.
// The rail itself (`ThreadScrubber.tsx` / `railGeometry.ts`) draws; it takes no decisions.
//
// ── WHAT CHANGED ON 2026-08-22, AND WHY IT IS A REVERSAL ───────────────────────────────────────
// The first cut deliberately kept the scroller's geometry AWAY from the rail: `onSeek` moved only
// the handle, and the thread scrolled once, at mouseup, through `onPick(marker)`. The founder tried
// it and reported *"it doesn't really seem to be doing anything, at least it's not scrolling in real
// time"* — then, a minute later, the important correction: *"Oh, and I'm seeing some of the prompts
// here. But it's okay. Now I'm seeing new things."* The rail was never dead. It was DISCONTINUOUS:
// nothing moved until he let go, so the first seconds of every drag read as no response at all.
//
// His requirement overrides the old design: *"It replaces the scroll. So I don't have the scroll
// anymore. I just have this draggable handle."* A control that replaces the scrollbar has to know
// the scroll range, so this hook now owns the scroller element and writes `scrollTop` directly on
// every pointermove. `onPick` survives for a CLICK on a mark and for the keyboard, where there is no
// continuous gesture to track.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { historyExtent, promptDensity, promptsInRange } from "../../services/history";
import { bubbleIdForRow, useConciergeBacklogStore } from "../../stores/conciergeBacklogStore";
import { useConciergeThreadStore } from "../../stores/conciergeThreadStore";
import type { ConciergeMessage } from "./types";
import {
  fractionForScrollTop,
  scrollTopForFraction,
  type RailMark,
} from "./railGeometry";
// The ONE geometry module (see the contract note below). Imported for use in this file's body;
// re-exported just under it so this module's public surface is unchanged.
import { scopeFromMs, type ScrubberScope } from "./scrubberGeometry";

// ── THE RAIL'S CONTRACT — ONE COPY, IN THE GEOMETRY MODULES ────────────────────────────────────
//
// `SCOPE_MS` must never be duplicated, and the reason is sharper than tidiness: this file's
// `scopeFromMs` turns it into the QUERY WINDOW while the rail's menu labels read the same table.
// Two tables that drift by one entry would fetch one span and describe another, with both suites
// green, because neither module can see the other's copy. `scrubberOneTable.test.ts` asserts the
// re-export below is the SAME OBJECT (`toBe`), which only a re-export can satisfy.
//
// The re-exports keep every existing importer of these names from this module resolving.
export type { ScrubberScope } from "./scrubberGeometry";
export type { RailMark } from "./railGeometry";
export { SCOPE_MS } from "./scrubberGeometry";
/** Kept as a re-export because callers outside this feature still import it from here. */
export type { ScrubberMarker } from "./scrubberGeometry";

/** How many prompt rows the rail asks for to enrich what it measured. See `enrich` below. */
const MARKER_FETCH_LIMIT = 4_000;

/**
 * The selector every one of the founder's prompts carries in the rendered thread.
 *
 * `data-quote-source="you"` is declared by `ConciergeMessageRow` on the `you` arm — it already
 * exists, is already tested, and already means exactly "this row is something the founder said".
 * Reusing it is what lets the rail measure real prompts without a second attribute that the next
 * message kind would forget to set. `data-message-id` on the same node is the jump target.
 */
export const PROMPT_ROW_SELECTOR = '[data-message-id][data-quote-source="you"]';

export interface ThreadScrubberController {
  /** Every prompt in the loaded thread, positioned on the scroller's own axis. */
  marks: RailMark[];
  scope: ScrubberScope;
  setScope: (s: ScrubberScope) => void;
  now: number;
  /** `MIN(created_at)` for concierge prompts, or null when unknown. Drives "All — since Aug 12". */
  oldestMs: number | null;
  /** 0..1, 0 = top of the loaded thread. Mirrors the scroller. */
  position: number;
  /** LIVE — called on every pointermove of a drag; writes `scrollTop` synchronously. */
  onScrub: (fraction: number) => void;
  /** The drag ended. Pages older turns in when it ended at the very top. */
  onScrubEnd: () => void;
  /** A click on a mark, or a keyboard step. */
  onPick: (mark: RailMark) => void;
  loading: boolean;
  /** The history query REJECTED — distinct from it returning no rows. The rail says so rather than
   *  rendering a bridge failure as a quiet week (roborev 66429). */
  failed: boolean;
  /** How many prompts the store holds ABOVE what is loaded. The rail must never imply the loaded
   *  thread is all there is. Counted by aggregate, never by fetching rows. */
  moreAbove: number;
  /** Hand the thread's scroller over. `ConciergeThread` calls this with its own scroll element. */
  attachScroller: (el: HTMLElement | null) => void;
}

/**
 * THE IO SEAM — same shape and same reasoning as `conciergeBacklogStore`'s.
 *
 * Module-level, read on every call, production values baked in. NOT a `deps = realThing` default
 * parameter: AGENTS.md records that when every test injects its own deps, the line that supplies the
 * real value is covered by nothing and can be deleted with the suite green.
 *
 * `now` IS IN HERE ON PURPOSE, not read inline as `Date.now()`. It is COUPLED to the row timestamps
 * — the fetch window is `[scopeFrom, now]` and every card's age is measured against it — so a test
 * that controls the row timestamps but not the clock cannot tell a working rail from one whose
 * window is off by a scope.
 */
const io = {
  promptsInRange,
  promptDensity,
  historyExtent,
  now: () => Date.now(),
};

export type ThreadScrubberIo = typeof io;

/** Swap the IO seam. TEST ONLY — returns a restore function. */
export function setThreadScrubberIo(next: Partial<ThreadScrubberIo>): () => void {
  const previous = { ...io };
  Object.assign(io, next);
  return () => Object.assign(io, previous);
}

/** Where an instant sits on a `[now - span, now]` track, as a 0..1 fraction with 0 = oldest. */
export function fractionOf(atMs: number, nowMs: number, span: number): number {
  if (span <= 0) return 1;
  const f = (atMs - (nowMs - span)) / span;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * Measure every rendered prompt's position on the scroller's axis.
 *
 * EXPORTED AND PURE-ISH so it can be driven from a test with a hand-built element, which matters
 * because jsdom lays nothing out: `offsetTop`, `scrollHeight` and `clientHeight` all read 0 there, so
 * a test has to install them and then assert the fractions that come back. A version of this buried
 * inside the hook could only ever be asserted through a rail that draws nothing.
 *
 * POSITIONS ARE RELATIVE TO THE SCROLLER'S CONTENT, not to the viewport: `rect.top - scrollerTop +
 * scrollTop` is the row's offset within the scrolled content, which is the only reading that does
 * not change as the reader scrolls. Using a raw `getBoundingClientRect().top` would make every mark
 * move whenever the thread did — a rail whose dots slide under the handle.
 *
 * The denominator is the SCROLLABLE RANGE (`scrollHeight - clientHeight`), matching
 * `fractionForScrollTop` exactly, so a mark at fraction f and the handle at fraction f name the same
 * scroll position. Dividing by `scrollHeight` instead would put every mark systematically above the
 * handle that reaches it — off by one viewport, which at the bottom of the thread is everything.
 */
export function measurePromptMarks(scroller: HTMLElement): RailMark[] {
  const range = scroller.scrollHeight - scroller.clientHeight;
  const rows = Array.from(scroller.querySelectorAll<HTMLElement>(PROMPT_ROW_SELECTOR));
  const scrollerTop = scroller.getBoundingClientRect().top;
  const scrollTop = scroller.scrollTop;
  return rows.map((el, i) => {
    const offset = el.getBoundingClientRect().top - scrollerTop + scrollTop;
    // A thread with nothing to scroll has every row at the top — 0, not a division by zero.
    const contentFraction = range > 0 ? Math.min(1, Math.max(0, offset / range)) : 0;
    return {
      id: el.dataset.messageId ?? `row-${i}`,
      // BOTH, and they are the same number HERE on purpose. This function measures the CONTENT axis
      // and nothing else — it has no clock and no window, so it cannot know a time fraction. `enrich`
      // in the hook overwrites `fraction` with the mark's position on the selected time window once
      // the store has answered; until then the content reading is the best available guess and is
      // strictly better than a 0 that would pile every mark at the top of the rail.
      contentFraction,
      fraction: contentFraction,
      // The rendered words are ALWAYS available, where the history row may not be (a bubble exists
      // before its history write lands). `enrich` below prefers the stored prefix when there is one.
      textPrefix: (el.textContent ?? "").trim().slice(0, 160),
      // 1-BASED, in document order — the card says "Prompt 14", and a 0-based index would make the
      // oldest one "prompt 0".
      index: i + 1,
    };
  });
}

/** Is this message id currently on screen — in the live thread or in the paged-in backlog? */
function isLoaded(id: string): boolean {
  return (
    useConciergeThreadStore.getState().chat.some((m) => m.id === id) ||
    useConciergeBacklogStore.getState().backlog.some((m) => m.id === id)
  );
}

export interface ThreadScrubberDeps {
  /** Scroll the thread to this message id. The HOST owns the jump (it holds `jumpRequest`'s seq
   *  counter), so it is passed in rather than reached for. */
  onJump?: (id: string) => void;
  /** Which scope the rail opens on. */
  initialScope?: ScrubberScope;
}

export function useThreadScrubber(deps: ThreadScrubberDeps = {}): ThreadScrubberController {
  const { onJump, initialScope = "1d" } = deps;
  const [scope, setScope] = useState<ScrubberScope>(initialScope);
  const [marks, setMarks] = useState<RailMark[]>([]);
  const [loading, setLoading] = useState(false);
  /** The last query REJECTED, as opposed to returning nothing. See the catch below. */
  const [failed, setFailed] = useState(false);
  const [position, setPosition] = useState(0);
  const [oldestMs, setOldestMs] = useState<number | null>(null);
  const [moreAbove, setMoreAbove] = useState(0);
  // The window's right edge, held as STATE rather than recomputed per render: it is handed to the
  // rail as `now` and every card's age is measured against it. Recomputing it inline would disagree
  // with the clock the rows were actually fetched against.
  const [now, setNow] = useState(() => io.now());
  /** id → what the STORE knows about that prompt, for cards the DOM cannot supply. */
  const [stored, setStored] = useState<Map<string, { createdAt: number; textPrefix: string }>>(
    () => new Map(),
  );

  const scrollerRef = useRef<HTMLElement | null>(null);
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;
  /**
   * THE STALE-FETCH GUARD, and it is a real race rather than a hypothetical.
   *
   * Changing scope from "all" to "1h" starts a second query while the first is still in the SQLite
   * bridge. The "all" query is the slow one BY CONSTRUCTION — it scans everything — so it very often
   * resolves AFTER the query it was superseded by, and a naive `setStored(rows)` then describes a
   * year of prompts on a rail whose scope says one hour.
   *
   * A monotonic ticket rather than an AbortController because the Tauri `invoke` bridge has no
   * cancellation: the query cannot be stopped, only its result ignored.
   *
   * ONE MECHANISM, NOT TWO. The effect's cleanup BUMPS this rather than setting a separate
   * `cancelled` flag beside it: with both, either flag alone gated every case a test could
   * construct, so deleting the ticket left the whole suite green — a guard nothing can prove is a
   * guard nobody can trust.
   */
  const ticket = useRef(0);

  /** The newest user message id, subscribed — a prompt sent right now must get its mark without a
   *  reload. Subscribing to the ID (a string) rather than to `chat` is what keeps this from
   *  re-measuring on every streamed delta of the reply. */
  const newestUser = useConciergeThreadStore((s) => {
    for (let i = s.chat.length - 1; i >= 0; i--) {
      const m = s.chat[i]!;
      if (m.kind === "you") return m.id;
    }
    return "";
  });
  const backlogCount = useConciergeBacklogStore((s) => s.backlog.length);

  // ── MEASUREMENT ────────────────────────────────────────────────────────────────────────────────
  /**
   * Re-measure the marks and the handle from the live scroller.
   *
   * Cheap on purpose: the live thread is capped at 200 rows and the backlog is bounded, so this is a
   * bounded `querySelectorAll` plus one rect read per row. It runs on scroll, on resize and whenever
   * the thread's content changes — all of which move marks, and none of which the rail can observe
   * for itself.
   */
  const remeasure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setMarks(measurePromptMarks(el));
    setPosition(fractionForScrollTop(el.scrollTop, el.scrollHeight, el.clientHeight));
  }, []);

  /**
   * The HANDLE only — no mark measurement.
   *
   * ── WHY SCROLLING MUST NOT RE-MEASURE THE MARKS ────────────────────────────────────────────────
   * Mark positions are in CONTENT space, so they are INVARIANT under scrolling: moving `scrollTop`
   * changes which part of the content is visible and moves no row relative to any other. Measuring
   * them on a scroll is therefore not merely wasteful, it is provably a no-op — and an expensive
   * one, because `setMarks` hands back a fresh array every time and re-renders the whole concierge
   * column. During a drag that is one full column render PER FRAME, in the exact gesture this work
   * exists to make smooth. (`useThreadScrubber.test.tsx` pins the invariance directly: the same rows
   * measured at two different `scrollTop`s produce identical fractions.)
   *
   * What DOES move a mark is the content changing or the box resizing, and those have their own
   * paths — `remeasure` above, driven by the content key and the ResizeObserver.
   */
  const readPosition = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setPosition(fractionForScrollTop(el.scrollTop, el.scrollHeight, el.clientHeight));
  }, []);

  const attachScroller = useCallback(
    (el: HTMLElement | null) => {
      scrollerRef.current = el;
      // Measure IMMEDIATELY on attach rather than waiting for the first scroll: a thread that is
      // never scrolled would otherwise show an empty rail forever, which is the "the rail is broken"
      // reading the whole feature exists to avoid.
      if (el) remeasure();
    },
    [remeasure],
  );

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // rAF-COALESCED, NOT DEBOUNCED. A scroll fires many times per frame and the handle must track
    // it; a debounce would make the handle lag the content by its own interval, which is the same
    // discontinuity the drag half of this work is fixing. One measurement per frame is exactly the
    // budget the browser paints at.
    let queued = 0;
    const scheduled = { full: false };
    const schedule = (full: boolean) => {
      if (full) scheduled.full = true;
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        const full2 = scheduled.full;
        scheduled.full = false;
        // A RESIZE COALESCED WITH A SCROLL MUST STILL RE-MEASURE. Both land in the same frame when
        // the column is being dragged wider, and collapsing them to the cheaper of the two would
        // leave every mark at its pre-resize position until something else moved.
        if (full2) remeasure();
        else readPosition();
      });
    };
    const onScroll = () => schedule(false);
    const onResize = () => schedule(true);
    el.addEventListener("scroll", onScroll, { passive: true });
    let ro: ResizeObserver | undefined;
    // Guarded: jsdom does not implement ResizeObserver in every setup, and a missing one must
    // degrade to scroll-driven measurement rather than throw at mount.
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onResize);
      ro.observe(el);
    }
    // SYNCHRONOUS, not scheduled. The rAF above exists to coalesce a STREAM of scroll and resize
    // events to one measurement per frame; a CONTENT change is a single discrete event, and
    // deferring it a frame means the prompt he just sent has no mark until something else moves.
    // (It also makes the behaviour observable: a scheduled-only measurement is invisible to a test
    // environment that never runs an animation frame, so the rule would be pinned by nothing.)
    remeasure();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      if (queued) cancelAnimationFrame(queued);
    };
    // `newestUser` and `backlogCount` are here because they are what "the thread's content changed"
    // means for this component: a new prompt, or a page of history landing above. Both move every
    // mark below them, and neither fires a scroll event of its own.
  }, [remeasure, readPosition, newestUser, backlogCount]);

  // ── THE STORE'S ANSWER: the true extent, the prompts behind the marks, and what is still above ──
  useEffect(() => {
    const mine = ++ticket.current;
    const at = io.now();
    setNow(at);
    setLoading(true);
    void (async () => {
      try {
        const extent = await io.historyExtent("concierge");
        // THE GATE. Anything but the newest ticket is a result nobody is waiting for any more — a
        // superseded scope, or an unmounted column.
        if (mine !== ticket.current) return;
        setOldestMs(extent.oldestMs);
        const from = scopeFromMs(at, scope, extent.oldestMs);
        const rows = await io.promptsInRange(from, at, "concierge", MARKER_FETCH_LIMIT);
        if (mine !== ticket.current) return;
        // KEYED BY BUBBLE ID, NOT BY ROW ID. `enriched` looks this up with a mark id read off
        // `data-message-id`, which is the bubble id — and a history row's primary key stopped being
        // the bubble id when concierge rows were namespaced per app load to stop the
        // `INSERT OR IGNORE` sink discarding them. `bubbleIdForRow` is the one inverse; keying on
        // `r.id` here misses EVERY mark of the current session, silently, leaving each card with no
        // age and the rendered node's chrome in place of the prompt.
        const map = new Map<string, { createdAt: number; textPrefix: string }>();
        for (const r of rows) {
          map.set(bubbleIdForRow(r.id), { createdAt: r.createdAt, textPrefix: r.textPrefix });
        }
        setStored(map);
        setFailed(false);
        setLoading(false);
      } catch {
        if (mine !== ticket.current) return;
        // NO enrichment and no throw. The rail is an affordance over the THREAD, and the thread is
        // rendered whatever SQLite says — so a bridge that cannot answer costs the cards their ages,
        // not the rail its marks.
        //
        // BUT IT IS RECORDED, NOT SWALLOWED (roborev 66429). "The query failed" and "you sent no
        // prompts" produce the same quiet rail, and collapsing them is not hypothetical: for four
        // commits of this feature both history commands were missing from `generate_handler!`, so
        // EVERY call rejected — and the rail looked exactly like a quiet week.
        setStored(new Map());
        setFailed(true);
        setLoading(false);
      }
    })();
    return () => {
      // The lint rule warns that `ticket.current` will have changed by cleanup time. Here that is
      // the POINT, not the hazard it is written for: this is a counter, not a ref to a rendered
      // node, and the whole mechanism is that cleanup advances whatever the newest value is.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ticket.current++;
    };
  }, [scope, newestUser]);

  /**
   * HOW MANY PROMPTS ARE STILL ABOVE THE LOADED WINDOW — by AGGREGATE, never by fetching rows.
   *
   * The founder's constraint, stated when he asked for the full history: *"draw the rail from an
   * aggregate query (counts bucketed by time), and page entries in as the viewport needs them. Do
   * not load every row into the renderer to draw the rail — at the current rate this table reaches
   * ~1 GB/year and he wants all of it kept."* One bucket over `[0, oldest loaded]` is a `COUNT(*)`
   * against `idx_entries_created`; the alternative — counting the rows you fetched — is the thing
   * that does not scale, and is also the thing that cannot see what it did not fetch.
   *
   * It is what stops the rail LYING. A rail drawn only from what is loaded silently claims the
   * loaded thread is all there is, which is exactly the *"it's definitely not giving me all of
   * them"* the founder reported.
   */
  const oldestLoadedMs = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    for (const v of stored.values()) if (v.createdAt < min) min = v.createdAt;
    // NOTHING TIMESTAMPED IN THE WINDOW is not the same as "nothing is older". A quiet scope returns
    // no rows, and reading that as `null` would report "everything is loaded" while ten days of
    // history sat above it — the precise shape of the lie this field exists to prevent. The SCOPE'S
    // OWN EDGE is the honest boundary in that case: the rail is not drawing anything older than it,
    // whether or not the window happened to contain a prompt.
    return Number.isFinite(min) ? min : scopeFromMs(now, scope, oldestMs);
  }, [stored, now, scope, oldestMs]);

  useEffect(() => {
    if (oldestMs === null || oldestMs >= oldestLoadedMs) {
      setMoreAbove(0);
      return;
    }
    let live = true;
    void (async () => {
      try {
        // ONE bucket: this is a count, not a profile. `- 1` because the range is inclusive at both
        // ends and the oldest loaded row must not be counted as also being above itself.
        const buckets = await io.promptDensity(oldestMs, oldestLoadedMs - 1, "concierge", 1);
        if (!live) return;
        setMoreAbove(buckets.reduce((n, b) => n + b.count, 0));
      } catch {
        // A count we could not take is reported as "none known", never as a guess. The handle's
        // label then simply omits the clause rather than claiming a number.
        if (live) setMoreAbove(0);
      }
    })();
    return () => {
      live = false;
    };
  }, [oldestMs, oldestLoadedMs]);

  /**
   * The marks the rail draws: measured positions, enriched with what the store knows.
   *
   * The DOM is the authority on POSITION and the store is the authority on TIME. Neither can supply
   * the other: a row's pixel offset does not exist in SQLite, and a bubble's `createdAt` is not in
   * the DOM. Merging here rather than in `measurePromptMarks` keeps that function drivable from a
   * test with no store at all.
   */
  const enriched = useMemo<RailMark[]>(
    () =>
      marks.map((m) => {
        const s = stored.get(m.id);
        if (!s) return m;
        // The STORED prefix wins over the rendered text: the rendered node includes the row's
        // chrome (timestamps, receipts) in its `textContent`, where the stored prefix is the prompt
        // itself, which is what the card is for.
        return { ...m, createdAt: s.createdAt, textPrefix: s.textPrefix || m.textPrefix };
      }),
    [marks, stored],
  );

  // ── THE GESTURES ───────────────────────────────────────────────────────────────────────────────
  /**
   * THE WHOLE POINT OF THIS REVISION: every pointermove scrolls the thread.
   *
   * Written SYNCHRONOUSLY to `scrollTop`, with no rAF of our own and no state round-trip. The
   * browser already coalesces `mousemove` to one per frame, so a second buffer on top only adds
   * latency — and latency is the entire defect: *"as I move the slider, I want it to be scrolling in
   * real time... it actually moves the chat thread."*
   *
   * `position` is set from the value we just wrote rather than waiting for the scroll event, so the
   * handle cannot lag the content by a frame. The scroll listener's own measurement then agrees with
   * it, because both go through `fractionForScrollTop`.
   */
  const onScrub = useCallback((fraction: number) => {
    const el = scrollerRef.current;
    const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
    setPosition(clamped);
    if (!el) return;
    el.scrollTop = scrollTopForFraction(clamped, el.scrollHeight, el.clientHeight);
  }, []);

  /**
   * The drag ended. If it ended AT THE TOP and there is older history, page it in.
   *
   * At the top and not DURING the drag, deliberately. Paging inserts rows ABOVE the reader, which
   * moves everything below them — doing that mid-gesture would yank the transcript out from under
   * the hand that is dragging it. Waiting for the release means the reader asked for the top, got
   * the top, and then the thread deepens beneath the handle.
   */
  const onScrubEnd = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const atTop = fractionForScrollTop(el.scrollTop, el.scrollHeight, el.clientHeight) <= 0.001;
    if (!atTop) return;
    if (oldestMs === null || oldestMs >= oldestLoadedMs) return;
    void useConciergeBacklogStore.getState().loadBack(oldestLoadedMs);
  }, [oldestLoadedMs, oldestMs]);

  /**
   * A click on a mark, or a keyboard step.
   *
   * Already rendered → jump. NOT rendered → page it in FIRST, then jump. The ordering is the
   * feature: `jumpTo` scans the thread's own scroller for `[data-message-id]` and returns silently
   * when it finds nothing, so a jump issued before the load is a click that does nothing at all.
   */
  const onPick = useCallback(
    (mark: RailMark) => {
      void (async () => {
        // The handle moves to the picked mark BEFORE the await: the load can take a moment, and a
        // handle that sits still until SQLite answers reads as the control ignoring the click.
        setPosition(mark.fraction);
        if (!isLoaded(mark.id) && mark.createdAt !== undefined) {
          await useConciergeBacklogStore.getState().loadBack(mark.createdAt);
        }
        onJumpRef.current?.(mark.id);
      })();
    },
    [],
  );

  /**
   * A NEW SCOPE IS A PAGING REQUEST, not just a relabelling.
   *
   * On the time axis the rail used to have, the scope rescaled a ruler and nothing loaded. On a
   * CONTENT axis it has to mean what the founder always said it meant — *"if it has one week at the
   * top of the slider, it takes me all the way back to one week ago"* — which is only true if a week
   * of turns is actually in the thread. So picking a wider scope pages back to its edge.
   */
  const pagedForScope = useRef<ScrubberScope | null>(null);
  useEffect(() => {
    // NOT ON MOUNT — only when the reader CHANGES the scope.
    //
    // Paging inserts turns ABOVE the live window. Doing that at mount would mean every time the
    // column opens, the founder is looking at a day of history he did not ask to see, with the
    // "Earlier — loaded from history" seam above it. The scope is what the rail is SET to, and only
    // an act of setting it is a request to go back. Dragging the handle to the top is the other
    // request, and `onScrubEnd` handles that one.
    if (pagedForScope.current === null) {
      pagedForScope.current = scope;
      return;
    }
    if (pagedForScope.current === scope) return;
    pagedForScope.current = scope;
    const from = scopeFromMs(now, scope, oldestMs);
    void useConciergeBacklogStore.getState().loadBack(from);
    // `now` is deliberately absent: it is re-stamped by the fetch effect above on every scope
    // change, so including it would run this a second time for the same user action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, oldestMs]);

  /** Whether the RAIL is busy: its own fetch, or a backlog page a pick is waiting on. */
  const backlogLoading = useConciergeBacklogStore((s) => s.loading);

  return {
    marks: enriched,
    scope,
    setScope,
    now,
    oldestMs,
    position,
    onScrub,
    onScrubEnd,
    onPick,
    loading: loading || backlogLoading,
    failed,
    moreAbove,
    attachScroller,
  };
}

/**
 * What `ConciergeHost` passes down — the whole rail wiring in ONE call.
 *
 * ── WHY THIS EXISTS RATHER THAN FIVE LINES IN THE HOST ────────────────────────────────────────
 * Two reasons, and the second is the important one.
 *
 * `ConciergeHost` is 7,000+ lines and is edited on several branches at once, so every line this
 * feature adds there is a merge conflict waiting to happen. That is the cheap reason.
 *
 * The real one: wiring that lives only at a call site nothing can mount is wiring nothing tests.
 * AGENTS.md's "defaulted seam" note is the same shape — the one line that supplies the real value
 * ends up covered by nothing and can be deleted with the suite still green. Here the jump's SEQ
 * COUNTER is that line, and it is the thing the whole gesture depends on: picking the same mark
 * twice must scroll twice, which only works if the counter advances.
 */
export interface ConciergeScrubberWiring {
  /** Older turns to render above the live thread. */
  backlog: ConciergeMessage[];
  /** The pending scroll request, or undefined before the first pick. */
  jumpRequest: { id: string; seq: number } | undefined;
  /** The rail's controller — hand it straight to `<ThreadScrubber>`. */
  scrubber: ThreadScrubberController;
}

export function useConciergeScrubberWiring(
  initialScope?: ScrubberScope,
): ConciergeScrubberWiring {
  const backlog = useConciergeBacklogStore((s) => s.backlog);
  const [jumpRequest, setJumpRequest] = useState<{ id: string; seq: number } | undefined>(
    undefined,
  );
  const onJump = useCallback((id: string) => {
    // A COUNTER, NOT A BARE ID. Setting `{id}` twice with the same id is an `Object.is`-equal
    // setState that React bails out of — no render, no effect, no scroll — so the second pick of a
    // mark would do nothing at all. `ConciergeAnnouncement` carries the same counter in this host
    // for exactly this reason.
    setJumpRequest((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
  }, []);
  const scrubber = useThreadScrubber({ onJump, initialScope });
  return { backlog, jumpRequest, scrubber };
}
