// useAgentTranscript — load, page and LIVE-TAIL one build agent's transcript while it is mounted.
//
// The three reads this owns are the same reader pointed in different directions:
//   • FIRST PAGE   — newest `TRANSCRIPT_PAGE_SIZE` entries, on mount.
//   • PAGE BACK    — older entries, on scroll-to-top, using the cursor the last page returned.
//   • LIVE TAIL    — bytes appended since the last poll, on a timer, while mounted.
//
// The tail is what makes the pane a terminal replacement rather than a history panel: Claude Code
// APPENDS to the session JSONL as the agent works, so reading further IS watching it work.
//
// POLLING ONLY THE MOUNTED AGENT, ONLY WHILE MOUNTED, is a hard requirement and not an optimisation.
// A fleet can be 60 panes; a tail poll per agent would be 60 file reads a second for 59 views nobody
// is looking at. The effect keys on `agentId`, so unmounting (or mounting a different agent) tears
// the interval down.
import { useCallback, useEffect, useRef } from "react";

import {
  TRANSCRIPT_PAGE_SIZE,
  fetchTranscriptPage,
  fetchTranscriptTail,
  filterSystemAuthored,
} from "../services/agentTranscript";
import { useMountedThreadStore } from "../stores/mountedThreadStore";

/** How often to look for newly-appended records while mounted.
 *
 *  One second is chosen against what it costs, not what feels responsive: a tail read seeks to a
 *  known byte offset and reads only the delta, so an idle tick is a `stat` plus a zero-length read.
 *  It is the ONLY tail signal: a turn-end (Stop) trigger would show nothing during the stretch the
 *  founder most wants to watch — the middle of a turn, while the work is happening. */
const TAIL_POLL_MS = 1000;

/** Backoff bounds for a tail that keeps failing. `2^6 = 64` ticks ≈ one minute between attempts,
 *  which is slow enough to stop hammering a genuinely broken read and fast enough that the pane
 *  heals on its own once the cause is gone. */
const MAX_BACKOFF_EXP = 6;
const MAX_BACKOFF_TICKS = 64;

export interface AgentTranscriptReader {
  /** Load the next page of OLDER entries. Safe to call spuriously — it no-ops while a page is in
   *  flight or when history is exhausted, so a scroll handler can call it without its own guard. */
  pageBack: () => void;
}

/**
 * Keep `stores/mountedThreadStore` fed for `agentId`, whose worktree is `worktreePath`.
 *
 * Pass `agentId: null` (or a worktree we do not know) to do nothing at all — that is the unmounted
 * state, and it must cost zero reads and zero timers.
 */
export function useAgentTranscript(
  agentId: string | null,
  worktreePath: string | null,
  configDir?: string | null,
): AgentTranscriptReader {
  const patch = useMountedThreadStore((s) => s.patch);
  const appendEntries = useMountedThreadStore((s) => s.appendEntries);

  // Generation counter. Every async read captures the value at issue time and drops its result if
  // the value has since moved — which happens whenever the founder mounts a DIFFERENT agent while a
  // read is in flight. Without it a slow first page for agent A lands in the store after B is
  // mounted, and the pane shows A's conversation under B's name: a wrong-attribution bug, which is
  // worse than a slow one.
  const genRef = useRef(0);
  const inFlightRef = useRef(false);
  // Consecutive failed tail reads, and how many ticks we have skipped since the last attempt. Refs
  // rather than state: backoff must not re-render the pane, and only the timer reads them.
  const failuresRef = useRef(0);
  const skippedRef = useRef(0);

  // Async reads run after render and must not close over stale values.
  const agentRef = useRef(agentId);
  const worktreeRef = useRef(worktreePath);
  const configRef = useRef(configDir ?? null);
  agentRef.current = agentId;
  worktreeRef.current = worktreePath;
  configRef.current = configDir ?? null;

  // ---- first page, on mount / on agent change -------------------------------------------------
  useEffect(() => {
    if (!agentId || !worktreePath) return;
    const gen = ++genRef.current;
    let cancelled = false;

    // NOT `entries: []`. Clearing here would blank a re-mount of an agent we already have pages for,
    // replacing a complete thread with a spinner for the length of a disk read. The cached entries
    // stay painted and the fresh page merges in — which is also what picks up anything typed into
    // the terminal while this pane was unmounted.
    patch(agentId, { loading: true, error: null });

    void (async () => {
      try {
        const page = await fetchTranscriptPage({
          worktreePath,
          configDir: configRef.current,
          limit: TRANSCRIPT_PAGE_SIZE,
        });
        if (cancelled || gen !== genRef.current) return;
        // KEEP THE DEEPER CURSOR when we are re-mounting onto entries we already hold.
        //
        // A fresh page's `next` points ~40 entries below the TIP. If the founder had paged back
        // several pages before unmounting, `entries` already reaches much further into the past, and
        // adopting the tip cursor would make the next `pageBack` re-fetch records already held:
        // `mergeEntries` dedupes them, `appendEntries` bails on the unchanged length, and the reader
        // gets "Loading earlier…" followed by nothing visibly happening — repeatedly, until the
        // cursor walks back past the whole cached region. Only take the fresh cursor when there was
        // nothing cached to be deeper than.
        const had = (useMountedThreadStore.getState().threads[agentId]?.entries.length ?? 0) > 0;
        appendEntries(agentId, filterSystemAuthored(page.entries));
        patch(agentId, {
          loading: false,
          ...(had ? {} : { next: page.next, hasMore: page.hasMore }),
          tailFile: page.tailFile,
          tailByte: page.tailByte,
          error: null,
        });
      } catch (e) {
        if (cancelled || gen !== genRef.current) return;
        patch(agentId, { loading: false, error: describe(e) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agentId, worktreePath, patch, appendEntries]);

  // ---- live tail ------------------------------------------------------------------------------
  const readTail = useCallback(async () => {
    const id = agentRef.current;
    const wt = worktreeRef.current;
    if (!id || !wt) return;
    // One tail read at a time. A slow read must not stack behind the timer: two concurrent reads
    // from the same offset would each return the same records, and the second would rewind
    // `tailByte` to a position already consumed.
    if (inFlightRef.current) return;
    const gen = genRef.current;
    const thread = useMountedThreadStore.getState().threads[id];
    // Until the first page has established where the live edge is, there is nothing to tail. Reading
    // from 0 here is what we are specifically avoiding — see `TranscriptPage.tailByte`.
    if (!thread || thread.tailFile === null) return;

    inFlightRef.current = true;
    try {
      const tail = await fetchTranscriptTail({
        worktreePath: wt,
        configDir: configRef.current,
        fromByte: thread.tailByte,
        // Name the file the offset belongs to, so a new session that started under us restarts the
        // read instead of seeking to a meaningless position inside it.
        fromFile: thread.tailFile,
      });
      if (gen !== genRef.current) return;
      // A DIFFERENT file means the agent started a new session while we watched. Its byte offset is
      // meaningless in the new file, so adopt the new file and take what this read returned rather
      // than seeking to a stale position inside it.
      if (tail.entries.length > 0) appendEntries(id, filterSystemAuthored(tail.entries));
      patch(id, { tailFile: tail.file, tailByte: tail.nextByte });
      // A read that worked clears the backoff, so one transient failure does not slow the tail
      // down for the rest of the session.
      failuresRef.current = 0;
    } catch {
      // A tail read that fails is not worth surfacing: the file may be mid-rotation, and the next
      // tick retries. Failing the whole pane over a transient read would be the louder bug.
      //
      // BUT IT MUST NOT RETRY AT FULL RATE FOREVER. A failure that is not transient — the command
      // missing, the worktree deleted, permissions — otherwise means an invoke every second for as
      // long as the pane stays mounted, silently, with nothing in the UI to show for it. Counting
      // failures lets the tick below skip most of its attempts once the failures stop looking like
      // a blip, while still recovering on its own if the cause clears.
      failuresRef.current += 1;
    } finally {
      inFlightRef.current = false;
    }
  }, [appendEntries, patch]);

  useEffect(() => {
    if (!agentId || !worktreePath) return;
    const t = setInterval(() => {
      // Exponential-ish backoff on a persistently failing read: after the first few failures, skip
      // 2^n ticks between attempts, capped so the tail still recovers within ~a minute once the
      // cause clears. A healthy tail never reaches this branch — `failuresRef` is zeroed by any
      // successful read.
      const failures = failuresRef.current;
      if (failures > 2) {
        const skipTarget = Math.min(2 ** Math.min(failures - 2, MAX_BACKOFF_EXP), MAX_BACKOFF_TICKS);
        if (skippedRef.current < skipTarget) {
          skippedRef.current += 1;
          return;
        }
      }
      skippedRef.current = 0;
      void readTail();
    }, TAIL_POLL_MS);
    return () => clearInterval(t);
  }, [agentId, worktreePath, readTail]);

  // ---- page backwards -------------------------------------------------------------------------
  const pageBack = useCallback(() => {
    const id = agentRef.current;
    const wt = worktreeRef.current;
    if (!id || !wt) return;
    const thread = useMountedThreadStore.getState().threads[id];
    if (!thread || thread.paging || !thread.hasMore || thread.next === null) return;
    const gen = genRef.current;
    const before = thread.next;
    patch(id, { paging: true });
    void (async () => {
      try {
        const page = await fetchTranscriptPage({
          worktreePath: wt,
          configDir: configRef.current,
          before,
          limit: TRANSCRIPT_PAGE_SIZE,
        });
        if (gen !== genRef.current) return;
        appendEntries(id, filterSystemAuthored(page.entries));
        patch(id, { paging: false, next: page.next, hasMore: page.hasMore });
      } catch (e) {
        if (gen !== genRef.current) return;
        patch(id, { paging: false, error: describe(e) });
      }
    })();
  }, [appendEntries, patch]);

  // NO `refresh()` HERE. An earlier cut exposed one, to be wired to the agent's turn-end (Stop) hook
  // so the last chunk of a reply landed without waiting for the next tick. Nothing consumed it: the
  // poll interval is 1s, which is already under the threshold where a human reads the delay as lag,
  // and a Stop-triggered refresh cannot be the only signal anyway (it fires at turn END, so it shows
  // nothing while work is in flight). An exported function with no caller is a claim about a seam
  // that does not exist — add it back when something actually needs sub-second turn-end latency.
  return { pageBack };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
