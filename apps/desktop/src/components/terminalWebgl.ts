// Repaint and GPU-context primitives for the xterm WebGL renderer.
//
// Two separate concerns live here, both learned the hard way from bugs that kept coming back:
//
//   1. REPAINTING (forceFullRepaint, settleRepaintPlan) — the WebGL renderer skips any cell that
//      matches its per-cell cache, so cells written while a pane couldn't paint need the atlas
//      cleared, not a bare refresh(). This is the fix for "top half of the terminal is blank until
//      I scroll".
//
//   2. CONTEXT LIFECYCLE (releaseGlContext, findWebglCanvas, onWebglContextLostImmediately) — the
//      engine allows a MEASURED 16 concurrent webgl2 contexts and evicts the OLDEST past that, and
//      xterm neither releases a context on dispose nor reacts to a lost one in under 3 seconds.
//      This is the fix for text rendering as garbage glyphs. See the section header below.
//
// Both are kept as pure-ish functions over structural types so they are unit-testable without a
// real GPU — jsdom has no WebGL at all.

// Structural subsets of the xterm types so this stays trivially unit-testable.
type RefreshableTerm = { refresh: (start: number, end: number) => void; rows: number };
type AtlasClearableAddon = { clearTextureAtlas: () => void };

// Force a FULL, unconditional repaint of the terminal viewport.
//
// THIS IS THE FIX FOR THE RECURRING "top half of the terminal is blank until I scroll" bug.
// `term.refresh(start, end)` only marks rows dirty and schedules a render; the WebGL renderer
// then SKIPS any cell whose code/fg/bg/ext equals its per-cell model cache
// (WebglRenderer._updateModel — `if (cells match) continue`). Cells written while the canvas
// was display:none / 0-sized (a backgrounded pane) get stamped into that cache as "drawn" even
// though nothing reached the GPU, so every later `refresh()` is a no-op for them — they stay
// blank until a SCROLL changes their content and it finally differs from the cache. That is why
// three prior fixes that all called `term.refresh()` never stuck: refresh() is structurally
// incapable of repainting cache-poisoned cells.
//
// `clearTextureAtlas()` wipes the renderer's model + glyph atlas, so every non-empty cell then
// differs from the (now-empty) cache and is genuinely redrawn — the ONLY reliable way to defeat
// the cache. We follow with refresh() (mirrors the theme-toggle path that already works). When
// there is no WebGL renderer (DOM-renderer fallback, which has no such cache) a bare refresh()
// is sufficient.
export function forceFullRepaint(
  webgl: AtlasClearableAddon | null,
  term: RefreshableTerm | null,
): void {
  if (!term) return;
  try {
    // Order matters: clear the model FIRST so the following refresh isn't skipped by the cache.
    webgl?.clearTextureAtlas();
    term.refresh(0, term.rows - 1);
  } catch {
    /* terminal/addon torn down — nothing to repaint */
  }
}

// Decide how the debounced output-settle (and the ResizeObserver) should repaint, given whether
// output is cache-poisoned (written while the pane couldn't paint — see Terminal's poisonedRef)
// and whether the pane can paint right now. Three outcomes:
//   • SKIP  — the pane isn't paintable (backgrounded / hidden: visibility:hidden or 0-sized). It
//     isn't on screen, so a refresh would be pure wasted DOM/style work — and with 10-20 concurrent
//     background agents all streaming output that adds up (bead sparkle-6x3g). We skip painting and
//     PRESERVE the poisoned flag; the become-active reveal (which force-repaints) draws the buffered
//     output when the pane is next shown.
//   • FULL  — poisoned AND paintable: drain the poisoning with one forceFullRepaint (clears the WebGL
//     model so poisoned cells redraw) and clear the flag. Runs ONCE per poisoning episode.
//   • REFRESH — the normal visible-streaming path: a cheap refresh() marks the new rows dirty.
// Pure + tested so the "skip while hidden / repaint once per episode" guarantees can't be silently
// refactored away.
export function settleRepaintPlan(
  poisoned: boolean,
  paintable: boolean,
): { action: "full" | "refresh" | "skip"; poisoned: boolean } {
  if (!paintable) return { action: "skip", poisoned };
  if (poisoned) return { action: "full", poisoned: false };
  return { action: "refresh", poisoned };
}

// NOTE: `recoverFromWebglContextLoss` used to live here — dispose the addon, null the caller's ref,
// refresh. It was REPLACED by Terminal's `detachWebgl`/`teardownWebgl`, which does all of that plus
// the two things it structurally could not: release the GPU context (xterm's dispose() does not) and
// hand back the concurrency permit. Keeping it as a second recovery path would have leaked a permit
// on every context loss, and after MAX_WEBGL_CONTEXTS losses no pane would ever get a WebGL renderer
// again. One teardown path only.

// ---------------------------------------------------------------------------
// GPU CONTEXT LIFECYCLE — releasing contexts, and reacting to a lost one in time.
//
// Two independent defects in the stack above conspired to produce the garbage-glyph bug (mojibake
// in the right positions, correct colors, recovering and re-corrupting). Both are handled here.
// ---------------------------------------------------------------------------

// A canvas, structurally — just enough to fetch its GL context. Keeps this unit-testable without
// jsdom needing real WebGL (jsdom has none, so a fake canvas is the ONLY way to test this).
// The listener half is optional so a test fake (and a canvas already torn down) is still assignable;
// onWebglContextLostImmediately guards before calling.
type ListenerTarget = {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

export type GlCanvasLike = ListenerTarget & {
  getContext: (contextId: string, options?: unknown) => unknown;
};

type LoseContextExtension = { loseContext: () => void };
type GlContextLike = { getExtension: (name: string) => unknown };

// DEFECT #1: xterm's WebglAddon.dispose() NEVER RELEASES THE GPU CONTEXT.
//
// Verified against @xterm/addon-webgl 0.19.0: the string "loseContext" does not appear anywhere in
// the shipped bundle. Its teardown is `this._canvas.parentElement?.removeChild(this._canvas)` —
// which detaches the canvas from the DOM and nothing more. The webgl2 context stays alive, counting
// against the engine's 16-context budget, until the canvas and the whole renderer object graph are
// garbage collected. WebKit's GC is lazy and non-deterministic, so under churn the dropped contexts
// pile up: one measured session attached 103 renderers across 81 agents, and the engine evicts the
// OLDEST live context — which by then is the terminal the human is looking at. Evicted, it keeps
// drawing from a dead texture atlas. That is the corruption.
//
// `WEBGL_lose_context.loseContext()` is the only way to hand a context back deterministically. It
// is a standard extension, universally available where webgl2 is.
//
// MUST be called AFTER the addon is disposed, never before: calling it on a canvas whose addon is
// still listening dispatches `webglcontextlost` into that addon and trips its restore machinery
// (see DEFECT #2), i.e. we would be manufacturing the very failure we are trying to prevent.
export function releaseGlContext(canvas: GlCanvasLike | null | undefined): void {
  if (!canvas) return;
  try {
    const gl = canvas.getContext("webgl2") as GlContextLike | null;
    const ext = gl?.getExtension("WEBGL_lose_context") as LoseContextExtension | null | undefined;
    ext?.loseContext();
  } catch {
    /* context already gone, or a canvas without webgl — nothing to release */
  }
}

// Locate the canvas holding the WebGL renderer's context.
//
// The addon appends its canvas to the terminal's screen element and exposes no handle to it, so we
// find it by probing: `getContext("webgl2")` returns the EXISTING context for the webgl canvas and
// null for xterm's 2d render layers (a canvas can only ever have one context type). Capture this at
// ATTACH time — after dispose the canvas is detached from the DOM and unfindable.
export function findWebglCanvas(root: {
  querySelectorAll: (selector: string) => ArrayLike<GlCanvasLike>;
} | null): GlCanvasLike | null {
  if (!root) return null;
  try {
    const canvases = root.querySelectorAll("canvas");
    for (let i = 0; i < canvases.length; i++) {
      const canvas = canvases[i];
      if (!canvas) continue;
      try {
        if (canvas.getContext("webgl2")) return canvas;
      } catch {
        /* this canvas already owns a different context type — not ours */
      }
    }
  } catch {
    /* no DOM to search */
  }
  return null;
}

// DEFECT #2: THE 3-SECOND GARBAGE WINDOW. This is what made the bug unrecoverable rather than
// merely likely.
//
// xterm's own `webglcontextlost` handler (addon-webgl 0.19.0, verbatim) is:
//
//     console.log("webglcontextlost event received");
//     e.preventDefault();
//     this._contextRestorationTimeout = setTimeout(() => {
//       console.warn("webgl context not restored; firing onContextLoss");
//       this._onContextLoss.fire(e);
//     }, 3e3);
//
// So `onContextLoss` — the ONLY signal the addon gives us, and the one recoverFromWebglContextLoss
// above is wired to — fires a full THREE SECONDS after the context died, and only if the engine
// never restored it. For those three seconds the terminal keeps rendering through a WebGL renderer
// whose context is gone, drawing from a stale/empty glyph atlas: correct layout, correct colors,
// wrong glyphs. If the engine then fires `webglcontextrestored`, the addon rebuilds its GL state and
// the screen snaps back to normal — and our onContextLoss handler is never called at all, so we
// never even learn it happened. Then the next eviction repeats it.
//
// That loop IS the reported symptom, exactly: "renders poorly, then re-renders okay, then renders
// poorly again."
//
// So we listen for `webglcontextlost` OURSELVES and fall back in the SAME event dispatch. Cost of
// acting immediately: the pane spends the rest of its visible life on xterm's DOM renderer (slightly
// less crisp box-drawing) until its next hide/show cycle re-attaches. Cost of waiting for the
// addon's signal: up to three seconds of unreadable text, repeatedly. The trade is not close —
// and unlike the addon's path, a DOM renderer has no texture atlas and so CANNOT corrupt.
//
// Note we deliberately do NOT preventDefault: we are not asking the engine to restore a context we
// have already stopped using. Whether our handler runs before or after the addon's does not matter
// — by the end of the dispatch the addon is disposed either way. If ours runs first, disposing the
// addon also removes ITS listener, so the 3-second timer is never even armed.
export function onWebglContextLostImmediately(
  canvas: ListenerTarget | null | undefined,
  onLost: () => void,
): () => void {
  if (!canvas?.addEventListener) return () => {};
  let fired = false;
  const handler = () => {
    if (fired) return; // one fallback per attach; a re-dispatch must not re-run teardown
    fired = true;
    onLost();
  };
  try {
    canvas.addEventListener("webglcontextlost", handler);
  } catch {
    return () => {};
  }
  return () => {
    try {
      canvas.removeEventListener?.("webglcontextlost", handler);
    } catch {
      /* canvas already torn down */
    }
  };
}

// DEFECT #3: THE SILENT-EVICTION WINDOW — the hole the other two fixes leave open.
//
// DEFECT #2 above closed the addon's 3-second timer by listening for `webglcontextlost` ourselves.
// But that still REACTS TO AN EVENT, and the event is not synchronous with the loss. The measurement
// in measure-webgl-context-limit.mjs is explicit about this: when the engine evicts a context to make
// room for a new one, `isContextLost()` flips to true IMMEDIATELY, while `webglcontextlost` is
// dispatched on a LATER task. Every frame painted in between is painted through a dead context.
//
// And nothing anywhere checks. `renderRows` in addon-webgl 0.19.0 is, in full:
//
//     renderRows(e, t) {
//       if (!this._isAttached) { ...; this._refreshCharAtlas(); this._isAttached = true }
//       for (const i of this._renderLayers) i.handleGridChanged(this._terminal, e, t);
//       this._glyphRenderer.value && this._rectangleRenderer.value && (
//         this._glyphRenderer.value.beginFrame() ? (...) : this._updateModel(e, t),
//         this._rectangleRenderer.value.renderBackgrounds(),
//         this._glyphRenderer.value.render(this._model), ...)
//     }
//
// There is no `isContextLost()` guard — the string does not appear in the bundle at all. On a lost
// context every GL call silently no-ops and every texture read returns nothing, so the glyph pass
// draws the RIGHT cells, at the RIGHT positions, in the RIGHT colors, with the WRONG glyphs. That is
// the reported signature exactly, and it is strictly worse than drawing nothing: a blank pane reads
// as broken, a garbage pane reads as data.
//
// WHY THE CONTEXT CAP DOES NOT ALREADY PREVENT THIS. The registry caps the renderers WE allocate at
// MAX_WEBGL_CONTEXTS, but the engine's budget of 16 is process-wide and counts every context the app
// holds — canvases outside xterm, and contexts whose canvases are dropped but not yet collected. A
// cap on our share cannot bound a budget we do not solely own, so "never reach the limit" is a
// probability argument, not a guarantee. This is the guarantee.
//
// So we guard the DRAW ITSELF rather than racing the notification: check `isContextLost()` on the
// way into renderRows and, if the context is gone, paint NOTHING and tear down. A frame that is
// never drawn cannot be drawn wrong, whatever order the events arrive in.
//
// This reaches through to `addon._renderer`, which is private. That is deliberate and load-bearing:
// the property is unmangled in the shipped bundle (the same bundle we already read `_core` out of),
// and if a future xterm bump moves it we warn and return a no-op rather than throwing — the pane
// keeps its renderer and degrades to the event-driven path, which is where we were before.
type GuardableRenderer = { renderRows?: (start: number, end: number) => unknown };
type GuardableAddon = { _renderer?: GuardableRenderer };
type LostCheckable = { isContextLost?: () => boolean };

export function guardWebglDrawPath(
  addon: unknown,
  canvas: GlCanvasLike | null | undefined,
  onLost: () => void,
): () => void {
  const renderer = (addon as GuardableAddon | null | undefined)?._renderer;
  const original = renderer?.renderRows;
  if (!renderer || typeof original !== "function") {
    console.warn(
      "Terminal: xterm WebglAddon._renderer.renderRows not found; a lost context can paint one or more garbage frames before the event fires (xterm internals changed?)",
    );
    return () => {};
  }

  let gl: LostCheckable | null = null;
  try {
    gl = canvas?.getContext("webgl2") as LostCheckable | null;
  } catch {
    gl = null;
  }
  if (typeof gl?.isContextLost !== "function") {
    console.warn(
      "Terminal: webgl2 context exposes no isContextLost(); cannot guard the draw path against silent eviction",
    );
    return () => {};
  }

  const checkable = gl;
  let fired = false;
  const guarded = function guardedRenderRows(this: unknown, start: number, end: number) {
    let lost = false;
    try {
      lost = checkable.isContextLost?.() === true;
    } catch {
      // A context so far gone it cannot even answer is not one we should draw through.
      lost = true;
    }
    if (lost) {
      // Draw nothing. Tear down exactly once — teardown disposes the addon, so this wrapper should
      // not be reachable again, but a re-entrant refresh must not fire a second fallback.
      if (!fired) {
        fired = true;
        onLost();
      }
      return undefined;
    }
    return original.call(this, start, end);
  };
  renderer.renderRows = guarded;

  return () => {
    // NEVER un-guard a renderer whose context we have already seen dead. Un-wrapping restores the
    // ORIGINAL renderRows — an unguarded glyph pass — onto a context that is gone, so any later
    // frame paints exactly the garbage this function exists to prevent. Teardown disposes the addon
    // right after this, so leaving the wrapper installed costs nothing and closes that window.
    if (fired) return;
    // Restore only if OUR wrapper is still installed. If something re-wrapped after us, blindly
    // assigning `original` back would silently drop their wrapper as well as ours.
    if (renderer.renderRows === guarded) renderer.renderRows = original;
  };
}
