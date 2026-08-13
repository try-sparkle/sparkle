// Guard xterm's render pass against a transient undefined-buffer-line crash.
//
// THE CRASH (bead sparkle-uhne8): `TypeError: undefined is not an object (evaluating 'a.loadCell')`,
// stack `_renderRows` <- `_innerRefresh`, thrown from inside the vendored @xterm bundle. It recurred
// 281 times in a single day's session log as an uncaught `ERROR ui:` line.
//
// ROOT CAUSE, verified against @xterm/xterm 6.0.0 + @xterm/addon-webgl 0.19.0 (the exact pinned
// versions; both are the newest NON-beta release on npm — `latest` dist-tag — so there is no
// in-range upstream patch to take, only 6.1.0/0.20.0 betas outside the `^6.0.0`/`^0.19.0` ranges):
//
//   · The WebGL renderer's `_updateModel` loops the render range and does
//         u = terminal.buffer.lines.get(row + buffer.ydisp);
//         u.loadCell(x, cell);            // <- NO null check; `u.loadCell` is the FIRST line access
//     so an undefined `u` throws exactly `undefined is not an object (evaluating 'a.loadCell')`.
//     (The DOM renderer's row factory would instead throw one call earlier, on
//     `t.getNoBgTrimmedLength()`, so the `loadCell` signature pins this to the WebGL path — the
//     visible/active pane, which is the only one holding a WebGL renderer.)
//   · Core `RenderService._renderRows(start, end)` clamps the range to `_rowCount - 1` but NOT to
//     the buffer's actually-available lines. When the render service's row count and the buffer's
//     `ydisp`/`length` are momentarily inconsistent — a resize/reflow or a scrollback trim landing
//     between the queued `refresh()` and the requestAnimationFrame that services it —
//     `lines.get(row + ydisp)` returns undefined and the glyph pass throws.
//
// WHY SPARKLE'S EXISTING try/catch CAN'T CATCH IT. The throw happens inside xterm's OWN rAF render
// callback (RenderDebouncer -> `_innerRefresh` -> `_renderRows` -> renderer.renderRows), NOT inside
// any synchronous `term.refresh()` call. `safeRefresh`/`forceFullRepaint` only wrap the synchronous
// call that SCHEDULES the frame; by the time the frame runs, their try/catch has long returned, so
// the throw escapes to `window.onerror` and is logged at ERROR — once per dropped frame.
//
// SAME FAMILY, MORE SYMBOLS. One day's log carried the identical crash under sibling vendor symbols
// — `d.getWidth` and `d.setCellFromCodepoint` (the same glyph pass, a cell/model access one step past
// `loadCell`) and `this._renderer.value.dimensions` (the RenderService `dimensions` getter, read by
// internal mouse/selection/IntersectionObserver callbacks AFTER dispose). The first two run inside
// the same render pass this guard wraps, so they are covered here; `dimensions` is NOT thrown through
// `_renderRows`, so it is caught at the escape boundary instead — logger.ts's window 'error' handler
// downgrades the whole transient xterm render/teardown undefined-access family to debug
// (isTransientXtermRenderError). The two guards together cover the family; neither alone does.
//
// THE GUARD. Wrap `RenderService._renderRows` — the exact frame named in the report, and the single
// renderer-agnostic chokepoint every render pass funnels through (`this._renderer.value.renderRows`
// is called from here for BOTH the WebGL and DOM renderers). A throw from the render pass is caught,
// counted, and reported through `onSwallowed` instead of propagating as an uncaught error. Dropping
// that one frame is harmless: the buffer<->renderer inconsistency is transient by construction, and
// xterm re-renders on the next write/refresh, painting the correct rows.
//
// This is the same shape as the two monkey-patches already in Terminal.tsx —
// `_core._selectionService.shouldForceSelection` and the WebGL `_renderer.renderRows` draw guard
// (`guardWebglDrawPath`) — and it composes with the latter: the WebGL guard is the INNER wrapper
// (checks `isContextLost()`), this is the OUTER one (catches the undefined-line throw the WebGL
// guard does not). The reassignment is honored because the RenderDebouncer was constructed with a
// closure `(c, d) => this._renderRows(c, d)` that looks `_renderRows` up on `this` at call time, so
// replacing the instance property is seen by every subsequent frame. If a future xterm bump renames
// the internals, we warn and return a no-op rather than throwing — the pane keeps its (unguarded)
// renderer, i.e. exactly the pre-fix behavior.

type RenderRowsFn = (start: number, end: number) => unknown;
type GuardableRenderService = { _renderRows?: RenderRowsFn };
type CoreWithRenderService = { _renderService?: GuardableRenderService };
type TermWithCore = { _core?: CoreWithRenderService };

/**
 * Wrap `term._core._renderService._renderRows` so a throw from xterm's render pass is swallowed and
 * reported to `onSwallowed(err, count)` instead of escaping as an uncaught error. Returns an
 * un-patch function that restores the original ONLY if our wrapper is still installed (so it never
 * clobbers a later wrapper). No-op + warn if the internals are not shaped as expected.
 */
export function guardTerminalRenderRows(
  term: unknown,
  onSwallowed: (err: unknown, count: number) => void,
): () => void {
  const svc = (term as TermWithCore | null | undefined)?._core?._renderService;
  const original = svc?._renderRows;
  if (!svc || typeof original !== "function") {
    console.warn(
      "Terminal: xterm _core._renderService._renderRows not found; a transient undefined-buffer-line " +
        "render throw will surface as an uncaught error (xterm internals changed?)",
    );
    return () => {};
  }

  let swallowed = 0;
  const guarded = function guardedRenderRows(this: unknown, start: number, end: number) {
    try {
      return original.call(this, start, end);
    } catch (err) {
      // Drop this frame. The undefined buffer line that produced the throw is a transient
      // buffer<->renderer inconsistency (a resize/reflow/scrollback-trim caught mid-flight); the
      // next write or refresh repaints the correct rows. Report, don't rethrow.
      swallowed += 1;
      onSwallowed(err, swallowed);
      return undefined;
    }
  };
  svc._renderRows = guarded;

  return () => {
    if (svc._renderRows === guarded) svc._renderRows = original;
  };
}

/**
 * Whether a swallowed-render-frame count is worth a log line. Logs the FIRST occurrence (so the
 * condition is visible once, with its error, rather than silently dropped) and then a heartbeat
 * every `HEARTBEAT` frames — so a genuinely recurring problem still leaves a trail with a running
 * total, without reproducing the 281-lines-a-day flood the guard exists to remove. Pure so the
 * cadence is unit-testable.
 */
export const SWALLOW_LOG_HEARTBEAT = 100;
export function shouldLogSwallow(count: number): boolean {
  return count === 1 || count % SWALLOW_LOG_HEARTBEAT === 0;
}
