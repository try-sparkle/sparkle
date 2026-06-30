// The hide-style an inactive pane applies. Narrowed to concrete literal/number types (not the wide
// CSSProperties unions) so callers — and the unit tests — can compare zIndex numerically.
export interface PaneVisibilityStyle {
  display: "flex";
  visibility: "visible" | "hidden";
  pointerEvents: "auto" | "none";
  zIndex: number;
}

// How a stacked, absolutely-positioned agent pane (AgentPane / SparkleAgentPane) hides itself when
// it isn't the active tab.
//
// HISTORY — why this exists. Inactive panes used to hide with `display: none`. That collapses the
// pane (and the xterm container inside it) to a 0×0 box, so xterm's FitAddon measured zero width
// and the terminal either SPAWNED into a ~11-column strip or, on reveal, raced for many frames to
// re-converge to the true width — the recurring "terminal renders as a tiny box in the top-left
// until I scroll" bug. It was patched at least five times (spawn-size guards, a Rust clamp, a
// bounded reveal-convergence rAF loop, repaint-on-reveal) — each a band-aid on the same root cause:
// you cannot measure a `display: none` box.
//
// THE FIX: keep every pane LAID OUT at full size at all times and hide the inactive ones with
// `visibility` + `pointer-events` instead. A `visibility: hidden` element keeps its layout box
// (clientWidth/Height stay real), so the xterm container is measured correctly the instant it
// mounts AND on every reveal — there is no 0-width window to race against, so the whole bug class
// disappears. The panes are `position: absolute; inset: 0`, so they stack perfectly; only the
// active one paints and receives input.
export function paneVisibilityStyle(visible: boolean): PaneVisibilityStyle {
  return {
    // ALWAYS laid out — never `display: none`. This is the load-bearing line: it guarantees the
    // pane (and its terminal) keeps a real, measurable box even while backgrounded.
    display: "flex",
    // Paint only the active pane. Hidden panes keep their geometry but aren't drawn, removed from
    // the a11y tree, and dropped from tab order.
    visibility: visible ? "visible" : "hidden",
    // Belt-and-suspenders so a stacked hidden pane can never intercept a click meant for the active
    // one (independent of `visibility`, in case a descendant ever forces itself visible).
    pointerEvents: visible ? "auto" : "none",
    // Keep the active pane unambiguously on top of the inert hidden ones it overlaps.
    zIndex: visible ? 1 : 0,
  };
}
