import { TERMINAL_PANE_Z } from "./layers";

// The hide-style an inactive pane applies. Narrowed to concrete literal/number types (not the wide
// CSSProperties unions) so callers — and the unit tests — can compare zIndex numerically.
export interface PaneVisibilityStyle {
  display: "flex";
  visibility: "visible" | "hidden";
  pointerEvents: "auto" | "none";
  zIndex: number;
  contentVisibility: "visible" | "hidden";
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
//
// PER-PANE LAYOUT COST — the second half, added for sparkle-gw36j. `visibility: hidden` skips PAINT
// but NOT LAYOUT, so every one of ~50 backgrounded panes still participates in every layout pass.
// Past MAX_WEBGL_CONTEXTS each terminal falls back to xterm's DOM renderer — thousands of text
// spans per grid — so a single forced synchronous layout (a caret blink, an `offsetWidth` read)
// re-lays-out every hidden terminal's DOM. Measured on the shipped renderer: ~0.37 s PER LAYOUT at
// 40 panes, which froze the app for seconds during a spawn burst. `content-visibility: hidden` on
// the hidden panes tells the engine to skip laying out their SUBTREE entirely while backgrounded —
// the box stays (position:absolute/inset:0 sizes it from the insets, not its contents, so it does
// not collapse), only the ~50 terminals' worth of internal DOM drop out of every layout pass.
//
// Why this is safe now, when the comment above insists on measurability: `content-visibility:
// hidden` DOES make the hidden subtree unmeasurable, exactly like `display: none` did — but the
// terminal is no longer measured while hidden. Terminal.tsx's ResizeObserver already declines to
// fit/resize an off-screen pane (it records the debt on `resizeDirtyRef` and defers everything to
// reveal, PTY size included), and the become-active reveal effect pays that deferred fit once, on
// show, with the ResizeObserver as the backstop for the subtree laying out a frame late. So the
// terminal is measured on mount-while-visible and on every reveal — never while hidden — which is
// the invariant `content-visibility: hidden` needs. Reveal flips it back to `visible`, the subtree
// lays out, and the settle machinery refits. Only applied to hidden panes; the active pane renders
// exactly as before (no containment, fillets/overhang/portals unaffected).
export function paneVisibilityStyle(visible: boolean): PaneVisibilityStyle {
  return {
    // ALWAYS laid out — never `display: none`. This is the load-bearing line: it guarantees the
    // pane (and its terminal) keeps a real, measurable box even while backgrounded.
    display: "flex",
    // Paint only the active pane. Hidden panes keep their geometry but aren't drawn, removed from
    // the a11y tree, and dropped from tab order.
    visibility: visible ? "visible" : "hidden",
    // Shed the hidden pane's SUBTREE layout cost (sparkle-gw36j). `hidden` skips laying out the
    // pane's contents — the ~thousands of DOM-rendered terminal spans — so a forced layout in the
    // active pane no longer re-lays-out every backgrounded terminal. The active pane stays
    // `visible` (normal rendering); the terminal refits on reveal via Terminal.tsx's become-active
    // settle. See the block comment above for why this is safe alongside the measurability rule.
    contentVisibility: visible ? "visible" : "hidden",
    // Belt-and-suspenders so a stacked hidden pane can never intercept a click meant for the active
    // one (independent of `visibility`, in case a descendant ever forces itself visible).
    pointerEvents: visible ? "auto" : "none",
    // Keep the active pane unambiguously on top of the inert hidden ones it overlaps — and, just
    // as load-bearing, keep it BELOW the Build column. The selected agent row bleeds 9px out of
    // that column into this pane; the pane is later in the DOM, so at an equal level it paints over
    // the overhang and the bleed vanishes. See components/layers.ts.
    zIndex: visible ? TERMINAL_PANE_Z : 0,
  };
}
