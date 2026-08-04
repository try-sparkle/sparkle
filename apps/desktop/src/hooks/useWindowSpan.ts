// useWindowSpan — the ONE action path for "span the window across every display".
//
// Extracted out of components/WindowSpanControls.tsx (the Appearance → Window group) when the
// concierge header grew a shortcut to the same action (bead sparkle-6b96h). It is a hook rather
// than a second copy of the same three invokes for one reason: `windowIsSpanned` is not decoration.
// hooks/useDisplayRespan.ts gates on it to decide whether to re-fit the window when a display is
// plugged or unplugged, so a caller that spans WITHOUT writing that flag silently disables
// auto-respan — and a caller that writes it without going through the same helpers would drift from
// whatever the pane believes. Two code paths that both claim to know whether the window is spanned
// WILL disagree; there is one.
//
// The rectangle math itself is deliberately in Rust (src-tauri/src/display_span.rs), where it is
// unit-tested against real arrangements. This layer only sequences: read layout → run one action →
// record which action ran → re-read layout.
import { useCallback, useEffect, useState } from "react";
import { safeUnlisten } from "../services/safeUnlisten";
import { useSettingsStore } from "../stores/settingsStore";
import {
  fitWindowToCurrentDisplay,
  getDisplayLayout,
  onDisplaysChanged,
  resetWindowSize,
  spanWindow,
  type DisplayLayout,
  type SpanMode,
} from "../services/displaySpan";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface WindowSpan {
  /** The live display arrangement, or null while it is being read (or unreadable). */
  layout: DisplayLayout | null;
  /** "I can't see your displays" — kept apart from `actionError` so one doesn't read as the other. */
  readError: string | null;
  /** "That button didn't work." */
  actionError: string | null;
  displayCount: number;
  /** Nothing is actionable until we know what displays exist. */
  noLayout: boolean;
  /** macOS "Displays have separate Spaces" is ON and there is more than one display to span. */
  blockedBySpaces: boolean;
  /** Is the window spanned right now? The shared flag `useDisplayRespan` gates on. */
  isSpanned: boolean;
  /** The user's chosen span rectangle. Callers must NOT pick their own. */
  spanMode: SpanMode;
  span: () => Promise<void>;
  fit: () => Promise<void>;
  reset: () => Promise<void>;
  /** Spanned → back to this display; not spanned → span. The toggle both surfaces offer. */
  toggle: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useWindowSpan(): WindowSpan {
  const spanMode = useSettingsStore((s) => s.windowSpanMode);
  const isSpanned = useSettingsStore((s) => s.windowIsSpanned);
  const setIsSpanned = useSettingsStore((s) => s.setWindowIsSpanned);

  const [layout, setLayout] = useState<DisplayLayout | null>(null);
  // Read failures and action failures are tracked apart so the user can tell "I can't see your
  // displays" from "that button didn't work" — folding them into one string made a failed action
  // look like a second copy of the read error.
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLayout(await getDisplayLayout());
      setReadError(null);
    } catch (e) {
      // A layout we can't read is the one state where guessing would be worst: the buttons would
      // claim a geometry that isn't real. Say so instead.
      setReadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Keep the readout honest while a consumer is mounted — the numbers under the Span button are a
    // claim about the user's actual hardware, and the header shortcut's very VISIBILITY is one
    // (it hides when there is nothing to span across).
    //
    // THE SUBSCRIBE IS FULLY CONTAINED, and all three layers of that are load-bearing.
    //
    //  • `.catch` — `listen` REJECTS when there is no Tauri IPC (a jsdom render, a window
    //    mid-teardown), and this promise isn't awaited until cleanup runs, so without it the
    //    rejection surfaces as an app-level unhandled error.
    //  • `Promise.resolve(...)` — `listen` is only CONTRACTUALLY a promise. A test double that
    //    returns `undefined` makes `.catch` a TypeError, and because this hook now runs inside the
    //    concierge header, that TypeError is thrown from an effect during the column's mount and
    //    takes the WHOLE column down with it. It did: nine tests in
    //    ConciergeHost.lintEndToEnd.test.tsx died on `Cannot read properties of undefined
    //    (reading 'catch')` the moment the header grew this control.
    //  • `try/catch` — same reasoning for a subscribe that throws SYNCHRONOUSLY.
    //
    // Losing live refresh in any of those situations is the correct degradation; a window-geometry
    // convenience must never be able to unmount its host.
    let pending: Promise<UnlistenFn | undefined>;
    try {
      pending = Promise.resolve(onDisplaysChanged(() => void refresh())).catch(() => undefined);
    } catch {
      pending = Promise.resolve(undefined);
    }
    return () => void safeUnlisten(pending);
  }, [refresh]);

  /**
   * Run one window action and record whether the window is now spanned.
   *
   * `spanned` comes from WHICH action ran, not from measuring the result. Measuring is impossible
   * synchronously — macOS applies window geometry on the main dispatch queue, so a read-back
   * reports the pre-action frame (see src-tauri/src/display_span.rs). Two attempts to verify made
   * every span read as clamped, which left the flag permanently false and silently killed
   * auto-respan. The known cost of trusting the action: resize the window by hand afterwards and
   * the flag is stale until the next Fit/Reset.
   *
   * A FAILED action writes NOTHING. Arming auto-respan off a span that errored would re-stretch a
   * window on every display change despite the span never having happened.
   */
  const run = useCallback(
    async (action: () => Promise<unknown>, spanned: boolean) => {
      try {
        await action();
        setIsSpanned(spanned);
        setActionError(null);
        await refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh, setIsSpanned],
  );

  const displayCount = layout?.displays.length ?? 0;
  // Nothing is actionable until we know what displays exist: acting on a null layout just produces
  // a second error next to the one that caused it.
  const noLayout = !layout || displayCount === 0;
  // With one display "spanning" is just maximizing, which works regardless of the Spaces setting —
  // so only warn (and only block) when there is actually more than one display to span across.
  const blockedBySpaces = !!layout && !layout.spanning_enabled && displayCount > 1;

  // THE PRECONDITIONS LIVE HERE, NOT IN THE CALLERS' `disabled` PROPS.
  //
  // `span_window` (src-tauri/src/display_span.rs) does NOT check `spanning_enabled` — under macOS
  // "Displays have separate Spaces" it applies the geometry, the window does not actually span, and
  // it still returns Ok. So a caller that invokes `span()` in that state gets a resolved promise and
  // `run` writes `windowIsSpanned = true` for a window that never spanned. That arms
  // useDisplayRespan to re-fire `spanWindow` on every display change, and it inverts the next
  // `toggle()` into a "fit".
  //
  // Leaving that gate in each caller's `disabled` attribute is exactly the drift this hook exists to
  // remove: the flag is supposed to have ONE writer that cannot be wrong, and a second surface that
  // must independently remember to check is not that. The panes' `disabled` props stay, but they are
  // now presentation rather than the only guard.
  //
  // A refused action writes NOTHING — same rule as a failed one.
  //
  // `spanMode` is read from the store so every caller inherits the user's Settings choice rather
  // than nominating one of its own.
  const span = useCallback(async () => {
    if (blockedBySpaces || noLayout) return;
    await run(() => spanWindow(spanMode), true);
  }, [blockedBySpaces, noLayout, run, spanMode]);

  // GETTING OUT IS NEVER GATED. Un-spanning is blocked by neither separate Spaces nor an unreadable
  // layout: `fit_window_to_current_display` and `reset_window_size` do not consume the frontend
  // layout at all (they act on the window's current display, in Rust), so a `noLayout` gate here
  // would buy nothing and cost the escape hatch.
  //
  // It would cost it in precisely the state the header button is kept visible FOR. That button
  // exempts `isSpanned` from its hide rule, so it renders — and stays enabled — while `layout` is
  // still null on first paint, and again whenever `display_layout` fails outright. Gating `fit`
  // there turned the click into a silent no-op: nothing invoked, no flag cleared, no `actionError`,
  // while `useDisplayRespan` kept re-spanning a window the user was trying to bring back. That is
  // the stranded geometry the direction-gated `disabled` above exists to make escapable, walked back
  // in through another door — and a REFUSED action is silent by construction, which contradicts the
  // rule that a failed one must not be.
  //
  // `span` keeps its gate: there, `blockedBySpaces` is load-bearing.
  const fit = useCallback(async () => {
    await run(fitWindowToCurrentDisplay, false);
  }, [run]);

  const reset = useCallback(async () => {
    await run(resetWindowSize, false);
  }, [run]);

  const toggle = useCallback(() => (isSpanned ? fit() : span()), [isSpanned, fit, span]);

  return {
    layout,
    readError,
    actionError,
    displayCount,
    noLayout,
    blockedBySpaces,
    isSpanned,
    spanMode,
    span,
    fit,
    reset,
    toggle,
    refresh,
  };
}
