// useThreadScrubber — the controller behind the concierge thread scrubber rail (bead sparkle-7m719).
//
// The rail is a ZOOM over a time axis. This hook is everything behind it: it asks the history table
// for the prompts inside the current scope, turns them into dots, and turns a pick on a dot into a
// thread that has actually LOADED that turn and scrolled to it. The rail itself (the peer worker's
// `ThreadScrubber.tsx` / `scrubberGeometry.ts`) draws; it takes no decisions.
//
// THE FOUNDER'S GOAL IS THE PICK, NOT THE DRAWING: *"dragging to an old prompt actually loads and
// scrolls to it"*. A rail that renders beautifully and answers an old dot with nothing is the failure
// this bead has been sitting in for sixteen days, which is why `onPick` — not the marker fetch — is
// the thing with a dedicated regression test.
import { useCallback, useEffect, useRef, useState } from "react";
import { promptsInRange } from "../../services/history";
import { useConciergeBacklogStore } from "../../stores/conciergeBacklogStore";
import { useConciergeThreadStore } from "../../stores/conciergeThreadStore";
import type { ConciergeMessage } from "./types";
// The ONE geometry module (see the contract note below). Imported for use in this file's body;
// re-exported just under it so this module's public surface is unchanged.
import { SCOPE_MS, type ScrubberMarker, type ScrubberScope } from "./scrubberGeometry";

// ── THE RAIL'S CONTRACT — ONE COPY, IN THE GEOMETRY MODULE ─────────────────────────────────────
//
// This file used to carry a structural COPY of `ScrubberScope`, `ScrubberMarker` and `SCOPE_MS`, so
// that this half and the view half could be built at the same time against a frozen contract. Both
// have landed, so the copy is gone and the real module is imported.
//
// `SCOPE_MS` in particular must never be duplicated again, and the reason is sharper than
// tidiness: THIS file uses it to choose the query window (`[now - SCOPE_MS[scope], now]`) while
// `ThreadScrubber` uses it to place the dots across the rail. Two tables that drift by one entry
// would fetch one span and draw another — every dot in the wrong place, with both suites green,
// because neither module can see the other's table.
//
// The re-exports keep every existing importer of these names from this module resolving.
export type { ScrubberScope, ScrubberMarker } from "./scrubberGeometry";
export { SCOPE_MS } from "./scrubberGeometry";
export interface ThreadScrubberController {
  markers: ScrubberMarker[];
  scope: ScrubberScope;
  setScope: (s: ScrubberScope) => void;
  now: number;
  /** 0..1, 0 = oldest/top. */
  position: number;
  onSeek: (fraction: number, nearest: ScrubberMarker | null) => void;
  onPick: (marker: ScrubberMarker) => void;
  loading: boolean;
  /** The history query REJECTED — distinct from it returning no rows. The rail says so rather than
   *  rendering a bridge failure as a quiet week (roborev 66429). */
  failed: boolean;
}

/**
 * THE IO SEAM — same shape and same reasoning as `conciergeBacklogStore`'s.
 *
 * Module-level, read on every call, production values baked in. NOT a `deps = realThing` default
 * parameter: AGENTS.md records that when every test injects its own deps, the line that supplies the
 * real value is covered by nothing and can be deleted with the suite green.
 *
 * `now` IS IN HERE ON PURPOSE, not read inline as `Date.now()`. It is COUPLED to the marker
 * timestamps — the fetch window is `[now - SCOPE_MS, now]` and every dot's position is a fraction of
 * that same span — so a test that controls the row timestamps but not the clock cannot tell a
 * working rail from one whose window is off by a scope.
 */
const io = {
  promptsInRange,
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

/** Is this message id currently on screen — in the live thread or in the paged-in backlog? */
function isLoaded(id: string): boolean {
  return (
    useConciergeThreadStore.getState().chat.some((m) => m.id === id) ||
    useConciergeBacklogStore.getState().backlog.some((m) => m.id === id)
  );
}

export interface ThreadScrubberDeps {
  /** Scroll the thread to this message id. The HOST owns the jump (it holds `jumpRequest`'s seq
   *  counter), so it is passed in rather than reached for — this hook has no view of the DOM. */
  onJump?: (id: string) => void;
  /** Which scope the rail opens on. */
  initialScope?: ScrubberScope;
}

export function useThreadScrubber(deps: ThreadScrubberDeps = {}): ThreadScrubberController {
  const { onJump, initialScope = "1d" } = deps;
  const [scope, setScope] = useState<ScrubberScope>(initialScope);
  const [markers, setMarkers] = useState<ScrubberMarker[]>([]);
  const [loading, setLoading] = useState(false);
  /** The last query REJECTED, as opposed to returning nothing. See the catch below. */
  const [failed, setFailed] = useState(false);
  const [position, setPosition] = useState(1);
  // The window's right edge, held as STATE rather than recomputed per render: it is handed to the
  // rail as `now` and every dot's x position is a fraction of `[now - SCOPE_MS, now]`. Recomputing
  // it inline would move every dot a few pixels on every unrelated re-render, and would disagree
  // with the clock the markers were actually fetched against.
  const [now, setNow] = useState(() => io.now());
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;
  /**
   * THE STALE-FETCH GUARD, and it is a real race rather than a hypothetical.
   *
   * Changing scope from "1y" to "1h" starts a second query while the first is still in the SQLite
   * bridge. The 1y query is the slow one BY CONSTRUCTION — it scans a year and can return thousands
   * of rows — so it very often resolves AFTER the 1h query it was superseded by, and a naive
   * `setMarkers(rows)` then paints a year of dots onto a rail whose axis says one hour. Every dot is
   * off-screen or wrong, the rail looks broken, and nothing errored.
   *
   * A monotonic ticket rather than an AbortController because the Tauri `invoke` bridge has no
   * cancellation: the query cannot be stopped, only its result ignored.
   *
   * ONE MECHANISM, NOT TWO. The effect's cleanup BUMPS this rather than setting a separate
   * `cancelled` flag beside it, and that is deliberate: with both, either flag alone gated every
   * case a test could construct, so deleting the ticket left the whole suite green — a guard nothing
   * can prove is a guard nobody can trust. With one, `useThreadScrubber.test.tsx`'s out-of-order
   * race goes red the moment the check below is dropped (verified by mutation).
   *
   * Stated exactly, because the two halves are not equally provable: the `++` at the TOP of the
   * effect is what supersedes an older scope's fetch, and that is the half the race test grips. The
   * `++` in the CLEANUP only covers UNMOUNT, whose sole effect is a `setState` on a component that
   * is gone — a no-op React 18 does not even warn about. It is hygiene, and no test can observe it;
   * do not go looking for the one that does.
   */
  const ticket = useRef(0);

  /** The newest user message id, subscribed — a prompt sent right now must get its dot without a
   *  reload. Subscribing to the ID (a string) rather than to `chat` is what keeps this from
   *  re-fetching on every streamed delta of the reply. */
  const newestUser = useConciergeThreadStore((s) => {
    for (let i = s.chat.length - 1; i >= 0; i--) {
      const m = s.chat[i]!;
      if (m.kind === "you") return m.id;
    }
    return "";
  });

  useEffect(() => {
    const mine = ++ticket.current;
    const at = io.now();
    setNow(at);
    setLoading(true);
    void (async () => {
      try {
        const rows = await io.promptsInRange(at - SCOPE_MS[scope], at, "concierge");
        // THE GATE. Anything but the newest ticket is a result nobody is waiting for any more —
        // a superseded scope, or an unmounted column.
        if (mine !== ticket.current) return;
        setMarkers(
          rows.map((r, i) => ({
            id: r.id,
            createdAt: r.createdAt,
            textPrefix: r.textPrefix,
            // 1-BASED, in ascending time order — the rail labels a dot "prompt 14 of 92", and a
            // 0-based index would make the oldest one "prompt 0".
            index: i + 1,
          })),
        );
        setFailed(false);
        setLoading(false);
      } catch {
        if (mine !== ticket.current) return;
        // NO dots and no throw. The rail is an affordance over history; a bridge that cannot answer
        // means there is nothing to draw, not that the column should fail to render.
        //
        // BUT IT IS RECORDED, NOT SWALLOWED (roborev 66429). "The query failed" and "you sent no
        // prompts in this window" produce the same empty rail, and collapsing them is not a
        // hypothetical loss: for four commits of this branch both history commands were missing
        // from `generate_handler!`, so EVERY call rejected — and the rail looked exactly like a
        // quiet week. The spec's own warning is that the founder reads an empty rail as broken;
        // the honest fix is for the rail to be able to SAY which of the two it is.
        setMarkers([]);
        setFailed(true);
        setLoading(false);
      }
    })();
    // Bumping the ticket IS the cancellation — see its header for why there is not a second flag.
    return () => {
      // The lint rule warns that `ticket.current` will have changed by cleanup time. Here that is
      // the POINT, not the hazard it is written for: this is a counter, not a ref to a rendered
      // node, and the whole mechanism is that cleanup advances whatever the newest value is. Copying
      // it into a variable inside the effect — the rule's suggested fix — would write back a stale
      // number and un-supersede a fetch.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ticket.current++;
    };
  }, [scope, newestUser]);

  const onSeek = useCallback((fraction: number, _nearest: ScrubberMarker | null) => {
    // Clamped, because the rail reports a pointer position and a drag can leave the track. The
    // NEAREST marker is the rail's business (it draws the hover card); this hook only owns where the
    // handle sits, so it is deliberately not stored.
    setPosition(fraction < 0 ? 0 : fraction > 1 ? 1 : fraction);
  }, []);

  /**
   * THE WHOLE POINT OF THE BEAD.
   *
   * Already rendered → jump. NOT rendered → page it in FIRST, then jump. The ordering is the
   * feature: `jumpTo` scans the thread's own scroller for `[data-message-id]` and returns silently
   * when it finds nothing, so a jump issued before the load is a click that does nothing at all —
   * which is exactly what the rail did in every previous attempt at this bead.
   */
  const onPick = useCallback(
    async (marker: ScrubberMarker, at: number, span: number) => {
      // The handle moves to the picked dot BEFORE the await, not after: the load can take a moment
      // and a handle that snaps back to where the pointer let go, then jumps once SQLite answers,
      // reads as the control fighting the reader.
      setPosition(fractionOf(marker.createdAt, at, span));
      if (!isLoaded(marker.id)) {
        await useConciergeBacklogStore.getState().loadBack(marker.createdAt);
      }
      onJumpRef.current?.(marker.id);
    },
    [],
  );

  /** Whether the RAIL is busy: its own fetch, or a backlog page a pick is waiting on. */
  const backlogLoading = useConciergeBacklogStore((s) => s.loading);

  return {
    markers,
    scope,
    setScope,
    now,
    position,
    onSeek,
    // The contract's `onPick` returns void; the promise is deliberately not surfaced — the rail must
    // not be able to await it and paint a spinner of its own, `loading` below already says so.
    onPick: useCallback(
      (marker: ScrubberMarker) => {
        void onPick(marker, now, SCOPE_MS[scope]);
      },
      [onPick, now, scope],
    ),
    loading: loading || backlogLoading,
    failed,
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
 * COUNTER is that line, and it is the thing the whole gesture depends on: picking the same dot twice
 * must scroll twice, which only works if the counter advances. Put it in a hook and a test drives
 * the identical code the host runs.
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
    // dot would do nothing at all. `ConciergeAnnouncement` carries the same counter in this host for
    // exactly this reason.
    setJumpRequest((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
  }, []);
  const scrubber = useThreadScrubber({ onJump, initialScope });
  return { backlog, jumpRequest, scrubber };
}
