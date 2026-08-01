// WHICH COLUMN A ZOOM GESTURE LANDS IN — the pure half of "Cmd +/- resizes the column you are in".
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
//
// `Cmd +/-` used to drive ONE global number (`uiStore.zoom`), read by exactly one consumer
// (`Terminal.tsx`, as a multiplier on the xterm font size). So the shortcut worked in a terminal and
// nowhere else: pressing it while reading the concierge or a build column changed the text size of
// every terminal in the window instead, which is neither what the user asked for nor visible to them
// at the time. The founder's ask is that the gesture apply to WHATEVER COLUMN HAS FOCUS, and that
// each column remember its own level.
//
// The cockpit is `TERM │ BUILD │ CONCIERGE │ BUILD │ TERM`, so that is five independently zoomable
// regions. Those are exactly `engine/columnResize`'s `ColumnKey`s minus the two rails, and they are
// spelled here as a SUBSET of that type rather than as a fresh list — the two modules describe the
// same five boxes, and a second private spelling of "the columns of the cockpit" is the one-constant-
// two-files drift `columnResize` already exists to prevent.
//
// ── WHY DOM FOCUS ALONE CANNOT ANSWER IT ───────────────────────────────────────────────────────
//
// The obvious implementation — `classifyFocusOwner(document.activeElement)` — is the one that does
// not work, and the reason is already written down in this repo. `voice/dictationFocusTracker`'s own
// header records the measured behaviour of the webview this app ships in:
//
//     on macOS/WKWebView … clicking a plain <button> [blurs] the focused element without focusing
//     the button unless Full Keyboard Access is on.
//
// A terminal holds a real caret (`.xterm-helper-textarea`), so `activeElement` names it and the
// terminal case resolves. A build column is a list of BUTTONS and the concierge's chrome is buttons
// too, so clicking either leaves `activeElement` on `<body>` — indistinguishable from "the user is
// nowhere". Keying the zoom off the caret alone would therefore reproduce the exact bug being fixed:
// it would work in a terminal and silently do nothing in the other three regions.
//
// So the tracker that feeds this watches POINTER PRESSES as well as focus (see
// services/columnFocusTracker), and this module supplies the pure classification both paths share.
// `classifyFocusOwner` is still the right answer to ITS question ("may dictation route here"), and is
// left alone; this is a different question over the same DOM.
//
// ── AND WHY A REFUSAL IS A FIRST-CLASS ANSWER ──────────────────────────────────────────────────
//
// `null` — no column owns the gesture — is a real, common state: the app has just launched, the user
// clicked a banner or a dialog, or focus is on `<body>` with no press recorded yet. The founder was
// explicit that a zoom landing in the WRONG column is worse than one that does not fire, so every
// unresolvable case here returns `null` and the caller does nothing. That is why this classifier
// VALIDATES the attribute it reads against the known set instead of trusting it: a typo'd or
// stale marker resolves to "no column", never to a neighbouring one.

import type { ColumnKey } from "./columnResize";

/**
 * The regions `Cmd +/-` can address.
 *
 * A SUBSET OF `ColumnKey`, enforced by the compiler (see the `satisfies` below): the rails are not
 * zoomable — there is nothing in a 6px seam to make bigger — and everything else in the cockpit is.
 * `satellite` is the one member that is NOT a cockpit column, and it is here for a reason worth
 * stating: a torn-off terminal lives in its own window with exactly ONE region in it, so the "which
 * column has focus" question it would otherwise have to answer is answered by construction. Giving
 * it its own key keeps the satellite's text size independent of the main window's terminals — which
 * is the same promise this whole change makes about every other pair of columns — instead of making
 * it silently share whichever key the pane happened to be torn from.
 */
export type ZoomColumn =
  | "terminal-left"
  | "build-left"
  | "concierge"
  | "build-right"
  | "terminal-right"
  | "satellite";

/** THE COCKPIT MEMBERS ARE REAL COLUMNS — a compile-time assertion, not a comment. If a `ColumnKey`
 *  is ever renamed, this stops compiling here rather than resolving to `null` at runtime in a
 *  keyboard handler nobody is watching. `satellite` is excluded because it is not in the row. */
const _cockpitZoomColumnsAreColumnKeys = [
  "terminal-left",
  "build-left",
  "concierge",
  "build-right",
  "terminal-right",
] as const satisfies readonly ColumnKey[];

/** Every zoomable region, for the reset-all path and for validating a marker read off the DOM. */
export const ZOOM_COLUMNS: readonly ZoomColumn[] = [
  ..._cockpitZoomColumnsAreColumnKeys,
  "satellite",
];

const ZOOM_COLUMN_SET: ReadonlySet<string> = new Set(ZOOM_COLUMNS);

/** Narrow an arbitrary string to a `ZoomColumn`. Exported because the persisted blob and the
 *  `set_zoom` control op both receive one from outside the type system. */
export function isZoomColumn(v: unknown): v is ZoomColumn {
  return typeof v === "string" && ZOOM_COLUMN_SET.has(v);
}

/**
 * The marker each zoomable column carries on its root element.
 *
 * AN APP-OWNED ATTRIBUTE, for the reason `TERMINAL_SURFACE_ATTR` gives for the same choice: matching
 * on class names or component structure couples this to vendor details and to the layout, both of
 * which move. One attribute, set at five render sites, found by a single `closest`.
 */
export const ZOOM_COLUMN_ATTR = "data-zoom-column";

/**
 * Which zoomable column contains `el`, or `null` when none does.
 *
 * `closest` matches the element ITSELF as well as its ancestors, so a press on the column root
 * resolves as readily as one on a deeply nested button. The guards mirror `classifyFocusOwner`'s
 * exactly, and for the same reason: this runs inside pointer and focus handlers, where a throw is a
 * broken app, and `document.activeElement` can hand back an `SVGElement`, a stale node, or something
 * with no `closest` at all.
 *
 * AN UNRECOGNISED MARKER IS `null`, NOT A GUESS. See the header — a wrong column is worse than none.
 */
export function classifyZoomColumn(el: Element | null | undefined): ZoomColumn | null {
  if (!el || typeof el.closest !== "function") return null;
  try {
    const host = el.closest(`[${ZOOM_COLUMN_ATTR}]`);
    const key = host?.getAttribute(ZOOM_COLUMN_ATTR);
    return isZoomColumn(key) ? key : null;
  } catch {
    return null;
  }
}

/** The cockpit column a pane belongs to, from the two facts a pane actually knows about itself.
 *  One spelling, so the render sites and the tests cannot disagree about which key is which side. */
export function zoomColumnFor(kind: "terminal" | "build", side: "left" | "right"): ZoomColumn {
  return `${kind}-${side}`;
}

// ── THE LEVELS ─────────────────────────────────────────────────────────────────────────────────
//
// The bounds and the step are UNCHANGED from the global zoom they replace, and deliberately so:
// this change is about WHICH column a press addresses, not about how far a column may be zoomed, and
// moving both at once would make a regression report ambiguous. They live here rather than in
// `uiStore` because the store is now one of several callers (the control op validates against them
// too) and because a pure module is testable without pulling zustand or a DOM in behind it.

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.8;
export const ZOOM_STEP = 0.1;
export const ZOOM_DEFAULT = 1.0;

/** Clamp a zoom factor into the supported range.
 *
 *  ROUNDED TO 2dp, which is load-bearing rather than cosmetic: the level is reached by repeatedly
 *  ADDING `0.1`, and binary floating point turns eight of those into `1.7999999999999998`. Without
 *  the rounding that value is `!== ZOOM_MAX`, so the "already at the ceiling" comparisons below (and
 *  any equality check a test writes) quietly stop holding, and the persisted number grows a tail of
 *  noise that survives every relaunch.
 *
 *  A NON-FINITE INPUT RESOLVES TO THE DEFAULT rather than propagating `NaN`. `NaN` fails every
 *  comparison silently, including both clamps, so it would sail through to `term.options.fontSize`
 *  and blank a terminal — and, being persisted, would do so on every subsequent launch. The control
 *  op validates its input too; this is the backstop for a corrupt or hand-edited stored blob, which
 *  has no validation in front of it at all.
 */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}

/** One step in `direction`, clamped. Separate from `clampZoom` so the step size is stated once and
 *  the keyboard, the ⋯ menu and the control op cannot drift to different increments. */
export function steppedZoom(current: number, direction: 1 | -1): number {
  return clampZoom(clampZoom(current) + direction * ZOOM_STEP);
}
