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
// The tail tick has a fourth job, which is why it is not purely the third read: while the agent is
// bound and no live edge has been established yet, it re-issues the FIRST PAGE. See `readTail`.
//
// POLLING ONLY THE MOUNTED AGENT, ONLY WHILE MOUNTED, is a hard requirement and not an optimisation.
// A fleet can be 60 panes; a tail poll per agent would be 60 file reads a second for 59 views nobody
// is looking at. The effect keys on `agentId`, so unmounting (or mounting a different agent) tears
// the interval down.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import {
  TRANSCRIPT_PAGE_SIZE,
  fetchTranscriptPage,
  fetchTranscriptTail,
  filterSystemAuthored,
} from "../services/agentTranscript";
import {
  agentConfigDir,
  agentSessionIds,
  configDirFromTranscriptPath,
  noteAgentConfigDir,
  noteRecoveredSessionId,
  subscribeAgentConfigDirs,
  subscribeAgentSessionIds,
} from "../services/agentTranscriptRegistry";
import { recoverSessionBinding, type EventsChunk } from "../services/sessionBindingRecovery";
import { invoke } from "@tauri-apps/api/core";
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

/** How many times to ask an unbound agent's hook log before giving up for this mount, and the base
 *  delay between tries (multiplied by the attempt number, so 1s, 2s, 3s…).
 *
 *  Sized for the case that motivates the retry at all: an agent spawned seconds ago whose hook log
 *  is still empty. Its SessionStart lands almost immediately, so a handful of widening tries covers
 *  it comfortably, while the ceiling keeps a genuinely unrecoverable agent from reading on a timer
 *  for the life of the app. */
const RECOVERY_ATTEMPTS = 5;
const RECOVERY_RETRY_MS = 1000;

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
): AgentTranscriptReader {
  const patch = useMountedThreadStore((s) => s.patch);
  const appendEntries = useMountedThreadStore((s) => s.appendEntries);

  // ---- WHOSE conversation this is ---------------------------------------------------------------
  //
  // A worktree is NOT an identity. Its session directory holds a `<session-id>.jsonl` for every
  // `claude` that ever ran there — the agent, each of its restarts, every background one-shot, and
  // every other agent pointed at the same tree (1,172 files in one measured worktree). Reading it
  // with only a worktree path returned whichever session had the newest mtime, so a pane whose footer
  // said "Chatting with Sparkle" rendered a stranger's roborev review. The binding is what fixes it.
  //
  // READ FROM THE REGISTRY HERE, NOT ACCEPTED AS AN ARGUMENT, and that is deliberate. An injectable
  // `sessionIds` param would be defaulted at the one production call site and overridden by every
  // test — the "defaulted seam" shape in AGENTS.md, where the single line that supplies the real
  // value is covered by nothing and can be deleted with the suite still green. One path only: tests
  // seed the registry through `noteAgentSessionId`, exactly as `AgentPane`'s hook handler does.
  //
  // SUBSCRIBED, not read once: the binding lands on the agent's FIRST hook event, which is routinely
  // after this pane's first render. A plain `agentSessionIds()` at render time would capture
  // `undefined`, never see the id arrive, and leave the pane permanently empty for an agent whose
  // session is perfectly well known — the subscribe-vs-getState mistake the worktree map beside it
  // already documents.
  const sessionIds = useSyncExternalStore(subscribeAgentSessionIds, () =>
    agentId ? (agentSessionIds(agentId) ?? null) : null,
  );

  // ---- WHICH ACCOUNT'S DIRECTORY that conversation is in ----------------------------------------
  //
  // Sparkle spawns each agent's `claude` with a per-account `CLAUDE_CONFIG_DIR`, so the transcript
  // is written under `<accountConfigDir>/projects/<slug>/` — not under `$HOME/.claude/projects/`.
  // Knowing WHOSE conversation it is does not help if we scan the wrong account's root: Rust's
  // `own_session_files` finds nothing there, returns an empty page AND a null tail anchor, and the
  // pane reads "No conversation with <name> yet." over a transcript being written at that moment.
  // Measured on the founder's machine: 42 of 52 live worktrees with a transcript on disk read empty
  // that way, and his failing agent went from 0 reachable records to 480.
  //
  // ══ THIS USED TO BE A PARAMETER, AND THE PARAMETER IS HOW THE BUG SURVIVED ═════════════════════
  // `configDir` was the third argument of this hook and NO caller — production or test — ever
  // supplied it. That is AGENTS.md's "defaulted seam" exactly: the one line that would have carried
  // the real value did not exist, so deleting it broke nothing and no test could see its absence.
  // Supplying the argument at the one call site would have left the seam open for the next person,
  // so the argument is GONE and the value is read here, from the same registry and by the same
  // mechanism as `sessionIds` above. One path only: tests seed it through `noteAgentConfigDir`,
  // exactly as `AgentPane`'s spawn and hook handler do.
  //
  // SUBSCRIBED, for the reason stated at `sessionIds`: the binding lands at spawn or on the agent's
  // first hook event, routinely after this pane's first render. A plain read would capture
  // `undefined` and never see the real value arrive.
  //
  // `null` IS NOT `sessionIds`' FAIL-CLOSED UNKNOWN. There is nothing to guess and nobody to
  // misattribute: it means "no account override recorded", we pass `null`, Rust falls back to
  // `$HOME/.claude`, and that is both today's behaviour and the right answer for an agent spawned
  // under the default config. This read can only ever widen where we look.
  const configDir = useSyncExternalStore(subscribeAgentConfigDirs, () =>
    agentId ? (agentConfigDir(agentId) ?? null) : null,
  );

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
  const configRef = useRef(configDir);
  const sessionRef = useRef(sessionIds);
  agentRef.current = agentId;
  worktreeRef.current = worktreePath;
  configRef.current = configDir;
  sessionRef.current = sessionIds;

  // ---- RECOVER A BINDING THE PANE WAS NEVER TOLD ---------------------------------------------
  //
  // The gate below fails closed on an agent whose Claude sessions we do not know, and that binding
  // has exactly ONE writer in production: `AgentPane`'s hook handler. Panes mount LAZILY, per
  // visited project, so an agent whose pane has never mounted in this window is unbound and its
  // mounted pane reads "No conversation with <name> yet." forever — with its terminal live beside
  // it. Measured on the founder's machine: 12 of 56 live worktrees were in exactly that state.
  //
  // So ask the agent's OWN hook log, which Sparkle writes at `<app_data>/hook-events/<agentId>.jsonl`
  // whether or not a pane is mounted. Every hook event carries both `session_id` and
  // `transcript_path`, so one bounded read of its tail yields the session id AND the account config
  // dir together. See `services/sessionBindingRecovery` for the rule and its accepted residual risk.
  //
  // THIS DOES NOT WEAKEN THE GATE. It supplies the same kind of evidence the hook handler does,
  // from the same source, without requiring a pane; a recovery that cannot VERIFY its answer returns
  // null and the pane stays honestly empty. It never widens the read to "whatever is in the
  // directory" — one agent's own worktree directory holds 136 session files of which 39 are its
  // own, so that widening is the cross-agent mis-attribution the gate exists to prevent.
  //
  // A MISS HERE IS USUALLY TRANSIENT, so this retries — bounded — rather than latching.
  //
  // `ConciergeHost` calls this hook ONCE for the window, so a ref here lives across every agent the
  // founder mounts; and the population this targets has no `AgentPane`, hence no other writer to
  // bind them later. A single attempt that happened to land in the seconds before an agent's hook
  // log was written would therefore leave that pane empty for the rest of the app session, with the
  // terminal live beside it — the very bug this is fixing, one layer down.
  //
  // So: `RECOVERY_ATTEMPTS` tries on a widening delay, keyed on agent AND worktree, with a success
  // latching permanently. The ceiling is what stops a genuinely unrecoverable agent (no log, or a
  // transcript under a since-removed account) from reading on a timer forever.
  const attemptedRef = useRef<Set<string>>(new Set());
  const attemptsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!agentId || !worktreePath || sessionIds) return;
    const key = `${agentId}\u0000${worktreePath}`;
    if (attemptedRef.current.has(key)) return;
    const id = agentId;
    const wt = worktreePath;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const attempt = async (): Promise<void> => {
      try {
        // Resolution only — `agent_event_log_path` creates nothing. The renderer must not build this
        // path itself: the app data dir carries a per-checkout `-dev` suffix on debug builds.
        const logPath = await invoke<string | null>("agent_event_log_path", { worktreePath: wt });
        if (!logPath) return;
        const found = await recoverSessionBinding({
          agentId: id,
          logPath,
          read: (p, offset, skipExisting) =>
            invoke<EventsChunk>("read_events_since", { logPath: p, offset, skipExisting }),
          // VERIFIED IN THE READ PATH'S OWN TERMS, which is stronger than "the file is there":
          // `agent_own_session_path` answers non-null only when a file whose stem is that session
          // exists in the directory THIS HOOK will page from. So a candidate that verifies is one
          // the very next read is guaranteed to find, and we can never register a binding that
          // resolves somewhere the reader does not look.
          exists: async (transcriptPath) => {
            // BOTH SEPARATORS. Windows is a shipped target and Claude writes `transcript_path`
            // with backslashes there, so a POSIX-only split returns the WHOLE path as the stem;
            // `own_session_files` matches stems exactly, so every recovery would be refused and the
            // feature would be silently inert on that platform with every POSIX fixture green.
            // Same rule as `configDirFromTranscriptPath` two lines below — they must not disagree.
            const stem = transcriptPath.split(/[/\\]/).pop()?.replace(/\.jsonl$/i, "") ?? "";
            if (stem === "") return false;
            const resolved = await invoke<string | null>("agent_own_session_path", {
              worktreePath: wt,
              sessionIds: [stem],
              configDir: configDirFromTranscriptPath(transcriptPath) ?? null,
            });
            return resolved !== null;
          },
        });
        // LATCH ONLY ON A DEFINITIVE ANSWER. A `null` here is usually TRANSIENT for exactly the
        // population this targets: a just-spawned agent's hook log is empty for its first seconds,
        // and these agents have no `AgentPane` to bind them later, so a permanent latch would leave
        // the pane empty for the rest of the app session while the agent worked beside it. The tail
        // tick re-runs this effect's siblings every second; leaving the key unset lets the next
        // render try again, and a success latches below so a bound agent never re-reads.
        if (cancelled) return;
        if (!found) {
          // Not established YET. Count the try and come back, unless we have spent the budget.
          const n = (attemptsRef.current.get(key) ?? 0) + 1;
          attemptsRef.current.set(key, n);
          if (n >= RECOVERY_ATTEMPTS) {
            attemptedRef.current.add(key);
            return;
          }
          timer = setTimeout(() => void attempt(), RECOVERY_RETRY_MS * n);
          return;
        }
        attemptedRef.current.add(key);
        // Order matters only in that both land before the re-page: the config dir is what makes the
        // session id readable at all for an account-spawned agent.
        if (found.configDir) noteAgentConfigDir(id, found.configDir);
        // WRITER (3b), NOT (3). This id was recovered without `createHookEventHandler`'s session
        // gate, so it goes in the provisional, memory-only channel that the first gated id retires.
        // See the registry's block above `provisionalSessionIds`.
        noteRecoveredSessionId(id, found.sessionId);
      } catch {
        // Best-effort by contract. A missing command (a stale webview against a new binary) or an
        // unreadable log leaves the pane exactly as fail-closed as it already was. Treated as a
        // spent attempt so a permanently-missing command cannot retry forever.
        if (cancelled) return;
        const n = (attemptsRef.current.get(key) ?? 0) + 1;
        attemptsRef.current.set(key, n);
        if (n >= RECOVERY_ATTEMPTS) attemptedRef.current.add(key);
        else timer = setTimeout(() => void attempt(), RECOVERY_RETRY_MS * n);
      }
    };

    void attempt();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [agentId, worktreePath, sessionIds]);

  // ---- first page, on mount / on agent change / WHEN THE BINDING ARRIVES ----------------------
  useEffect(() => {
    if (!agentId || !worktreePath) return;
    // UNKNOWN BINDING → READ NOTHING, and render the ordinary empty state rather than a spinner.
    //
    // FAIL CLOSED. The tempting fallback — "no ids, so just show the newest session in the
    // directory" — is precisely the defect: it renders another agent's conversation under this
    // agent's name, with full confidence and no way for the reader to tell. An empty pane under a
    // correct name is strictly better than a full pane under the wrong one.
    //
    // This also reads identically to the benign case (an agent seconds old that genuinely has no
    // turns yet), which is right — in both we have nothing we can honestly attribute to this agent —
    // and it self-heals: the agent's first hook event re-runs this effect with the binding in hand.
    if (!sessionIds) {
      patch(agentId, { loading: false, error: null });
      return;
    }
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
          configDir,
          limit: TRANSCRIPT_PAGE_SIZE,
          sessionIds,
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
    // `sessionIds` IS A DEPENDENCY, and it has to be: the binding usually arrives after this pane's
    // first render (the agent's first hook event), and it WIDENS on resume. Both must re-page, or the
    // pane stays empty for an agent we can now identify, or misses the session it just resumed into.
    // Safe as an identity dep — `agentTranscriptRegistry` hands back a frozen array whose identity
    // only changes when an id is genuinely added, so an idle agent's constant hook traffic does not
    // re-fetch.
    //
    // `configDir` IS A DEPENDENCY FOR THE SAME REASON, and without it half this fix would be inert.
    // The account binding lands at spawn or on the first hook event — routinely AFTER this pane has
    // painted — and a first page issued before it arrived read the wrong directory and came back
    // empty, permanently, because nothing re-pages a mounted pane. It is a plain string, so an
    // unchanged re-registration (the common case: every hook event re-notes the same dir) is
    // identical by value and does not re-fetch.
  }, [agentId, worktreePath, sessionIds, configDir, patch, appendEntries]);

  // ---- live tail ------------------------------------------------------------------------------
  const readTail = useCallback(async () => {
    const id = agentRef.current;
    const wt = worktreeRef.current;
    const bound = sessionRef.current;
    if (!id || !wt) return;
    // No binding, nothing to follow. "The newest session file" is the tail's whole file-selection
    // strategy, so an unbound tail live-follows whichever OTHER agent in this worktree is being
    // written to right now — a wrong-attribution bug that ARRIVES OVER TIME into a pane that looked
    // fine on mount. Bailing here also means an unidentified agent costs zero reads per second.
    if (!bound) return;
    // One tail read at a time. A slow read must not stack behind the timer: two concurrent reads
    // from the same offset would each return the same records, and the second would rewind
    // `tailByte` to a position already consumed.
    if (inFlightRef.current) return;
    const gen = genRef.current;
    const thread = useMountedThreadStore.getState().threads[id];
    // ── NO LIVE EDGE YET → RE-ISSUE THE FIRST PAGE, RATHER THAN GIVING UP FOR THE WHOLE MOUNT ────
    //
    // Rust returns `tailFile: null` whenever the filtered file list is empty — a bound agent that
    // has not written its first record yet, a page that came back empty because the account binding
    // had not landed, a worktree Claude has not touched. This branch used to `return` outright, so
    // the tail was FROZEN for the life of the mount: an agent mounted seconds before its first turn
    // never live-tailed again, however much it went on to write, and the only cure was a remount.
    //
    // Reading from byte 0 is still what we refuse to do (see `TranscriptPage.tailByte`) — so this is
    // a PAGE, not a tail. It establishes the live edge exactly the way the mount-time effect does,
    // and the very next tick becomes an ordinary cheap tail.
    if (!thread || thread.tailFile === null) {
      inFlightRef.current = true;
      try {
        const page = await fetchTranscriptPage({
          worktreePath: wt,
          configDir: configRef.current,
          limit: TRANSCRIPT_PAGE_SIZE,
          sessionIds: bound,
        });
        // The SAME generation drop rule as every other read here: a page issued for an agent that
        // has since been unmounted must not land in the store under whatever is mounted now.
        if (gen !== genRef.current) return;
        // STILL NOTHING ON DISK. Do not `patch` — it allocates a fresh thread object every call, so
        // writing an unchanged empty state here would repaint the pane once a second forever, which
        // is the exact cost `appendEntries`' unchanged-length bail exists to avoid. Count it toward
        // the shared backoff instead: the tick below then spaces these attempts out to ~a minute,
        // and any page that does find the file resets the counter and restores the 1 Hz tail.
        if (page.tailFile === null) {
          failuresRef.current += 1;
          return;
        }
        // KEEP THE DEEPER CURSOR, for the reason the mount-time effect states: a pane that has
        // already paged back reaches further into the past than a fresh page's tip cursor does.
        const had = (useMountedThreadStore.getState().threads[id]?.entries.length ?? 0) > 0;
        appendEntries(id, filterSystemAuthored(page.entries));
        patch(id, {
          loading: false,
          ...(had ? {} : { next: page.next, hasMore: page.hasMore }),
          tailFile: page.tailFile,
          tailByte: page.tailByte,
          error: null,
        });
        failuresRef.current = 0;
      } catch {
        // Same rule as a failed tail: not worth surfacing, and counted so a persistently broken
        // read stops being attempted every second.
        failuresRef.current += 1;
      } finally {
        inFlightRef.current = false;
      }
      return;
    }

    inFlightRef.current = true;
    try {
      const tail = await fetchTranscriptTail({
        worktreePath: wt,
        configDir: configRef.current,
        fromByte: thread.tailByte,
        // Name the file the offset belongs to, so a new session that started under us restarts the
        // read instead of seeking to a meaningless position inside it.
        fromFile: thread.tailFile,
        sessionIds: bound,
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
    const bound = sessionRef.current;
    // Same fail-closed rule as the first page: with no binding there is no history we can attribute
    // to this agent, so there is nothing to page back INTO.
    if (!id || !wt || !bound) return;
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
          sessionIds: bound,
        });
        if (gen !== genRef.current) return;
        appendEntries(id, filterSystemAuthored(page.entries));
        patch(id, { next: page.next, hasMore: page.hasMore });
      } catch (e) {
        if (gen !== genRef.current) return;
        patch(id, { error: describe(e) });
      } finally {
        // ALWAYS CLEAR `paging`, INCLUDING ON THE STALE-GENERATION RETURNS ABOVE.
        //
        // The two `gen !== genRef.current` guards drop a result that no longer belongs to what is
        // mounted — correct for the ENTRIES and the CURSOR, and wrong for this flag, because
        // `paging` is not data about the page: it is the in-flight LATCH that `pageBack`'s own
        // early return reads (`thread.paging` above). Returning without clearing it leaves the
        // latch set with nothing left to unset it, so every later `pageBack` no-ops, "Loading
        // earlier…" sticks, and the agent's history is unreachable until the pane remounts.
        //
        // Reachable since `sessionIds` joined the first-page effect's deps: the generation now
        // bumps on an event that could not happen mid-pane-life before — the binding WIDENING when
        // the agent resumes into a new session — which can land while a backwards page is in
        // flight. Keyed by the `id` this call captured, so a bump caused by mounting a DIFFERENT
        // agent settles this agent's thread rather than the newly-mounted one's.
        //
        // `finally` runs after the `try`/`catch` bodies, so the success path's cursor write is not
        // clobbered by this one.
        patch(id, { paging: false });
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
