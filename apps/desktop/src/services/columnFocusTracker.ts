// WHICH COLUMN THE USER IS WORKING IN — the watcher half of per-column zoom.
//
// Installed once at the app root (App.tsx), exactly like `installDictationFocusTracker`, and just as
// dumb: it records an observation and decides nothing. `engine/columnZoom` owns the classification;
// `Workspace`'s Cmd +/- handler owns what to do with it.
//
// ── WHY THIS IS NOT JUST A `focusin` LISTENER ──────────────────────────────────────────────────
//
// Because in this app's webview, three of the five columns never take focus. `dictationFocusTracker`
// measured it and its header states it plainly: on macOS/WKWebView, clicking a plain `<button>`
// BLURS the focused element without focusing the button (unless Full Keyboard Access is on). A
// terminal owns a real caret, so it resolves through focus alone — but a build column is a list of
// buttons and the concierge's chrome is buttons, so clicking either leaves `activeElement` on
// `<body>`. A focus-only tracker would therefore report "no column" for precisely the three regions
// this feature was asked for, and Cmd +/- would go on working in terminals and nowhere else — the
// original bug, reimplemented at greater cost.
//
// So a POINTER PRESS is the primary signal: it is the gesture that actually means "I am working
// here", it fires before focus settles, and it is unaffected by whether the target is focusable.
// Focus is kept as a second signal so the keyboard-only paths still work — tabbing into a terminal,
// or a relaunch that restores the caret without any press at all.
//
// ── THE ASYMMETRY, WHICH IS THE WHOLE DESIGN ───────────────────────────────────────────────────
//
// The two signals are treated DIFFERENTLY when they resolve to no column, and getting this backwards
// breaks the feature in one direction or the other:
//
//   • A PRESS outside every column CLEARS. The user deliberately went somewhere else — a banner, a
//     dialog, a seam rail — so the honest answer to "which column has focus" is "none", and the
//     founder's requirement 4 says the gesture must then do nothing rather than guess.
//
//   • A FOCUS event that resolves to no column is IGNORED. This is the WKWebView blur described
//     above: clicking a button inside a column emits `focusout`, `activeElement` reverts to `<body>`
//     and no `focusin` follows. Treating that as "left the column" would clear the very column the
//     user just clicked INTO — so every press in a build column would arm the tracker and then
//     immediately disarm it, and Cmd +/- would do nothing there. The press already recorded the
//     right answer; a blur to nowhere is not new information.
//
// Neither signal ever GUESSES a column. Both go through `classifyZoomColumn`, which validates the
// marker it finds, so the only two outcomes are a real column or `null`.
//
// COST: one `closest()` per press and per focus change, and a write only when the answer actually
// changes. `pointerdown` in the CAPTURE phase for the reason `Workspace`'s unbind gesture gives for
// the same choice — the observation must survive handlers that stop propagation, and it must be
// judged on where the gesture STARTED rather than on where a re-render left the element.

import { classifyZoomColumn, type ZoomColumn } from "../engine/columnZoom";

/** The column the user is working in, or `null` when that is not knowable. Module-scoped rather
 *  than a store slice ON PURPOSE: nothing RENDERS from this. The only reader is a keydown handler
 *  that reads it imperatively at press time, so putting it in `uiStore` would add a subscriber
 *  wake-up on every click of the app in exchange for nothing. */
let focused: ZoomColumn | null = null;

/** Listeners for tests and for any future surface that wants to paint the focused column. */
const listeners = new Set<(c: ZoomColumn | null) => void>();

/** THE COLUMN A ZOOM GESTURE ADDRESSES RIGHT NOW. `null` means "do nothing" — never a default. */
export function focusedZoomColumn(): ZoomColumn | null {
  return focused;
}

/** Subscribe to changes; returns an unsubscribe. */
export function onZoomColumnChange(fn: (c: ZoomColumn | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(next: ZoomColumn | null): void {
  if (next === focused) return; // de-duped: moving between two elements of one column is a no-op
  focused = next;
  for (const fn of listeners) fn(next);
}

/** Reset to the launch state. Tests only — module state outlives a component tree, and a suite that
 *  leaked the previous case's column into the next one would be asserting on a stale reading. */
export function __resetZoomColumnForTest(): void {
  focused = null;
  listeners.clear();
}

export interface ColumnFocusTrackerDeps {
  doc?: Document;
  win?: Window;
}

/**
 * Install the tracker; returns an uninstall fn.
 *
 * The SATELLITE WINDOW does not install this. It holds exactly one region, so its zoom key is a
 * constant (`"satellite"`) and there is no "which column" question to answer — see `ZoomColumn`.
 */
export function installColumnFocusTracker(deps: ColumnFocusTrackerDeps = {}): () => void {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;

  // A PRESS IS AUTHORITATIVE, INCLUDING WHEN IT LANDS NOWHERE — see the asymmetry note above.
  // Read off `event.target` rather than `activeElement`: at `pointerdown` time focus has not moved
  // yet, so `activeElement` still names wherever the caret WAS, which is the previous column.
  const onPointerDown = (e: Event) => {
    set(classifyZoomColumn(e.target as Element | null));
  };

  // FOCUS ONLY EVER PROMOTES. A focus landing in a column is real news (tab, restore, click into a
  // terminal's textarea); a focus landing nowhere is the WKWebView blur artifact and is discarded.
  const readFocus = () => {
    const col = classifyZoomColumn(doc.activeElement);
    if (col !== null) set(col);
  };

  const onFocusIn = () => readFocus();

  // Deferred for the reason `dictationFocusTracker` defers its own: during a transition
  // `activeElement` is transiently `<body>` (or null), so a synchronous read inside `focusout`
  // reports nothing for a click that is about to land elsewhere in the SAME column. By the time this
  // runs the caret has settled. Harmless here even so — `readFocus` ignores a null result — but it
  // keeps the promotion accurate for a click that moves between two columns.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const onFocusOut = () => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      readFocus();
    }, 0);
  };

  // Returning to the window restores focus to whatever held it, often WITHOUT a `focusin` we would
  // see. Re-read so a column is not lost to an app switch. Deliberately does NOT clear on blur: the
  // user coming back expects the column they left to still be the one Cmd +/- addresses.
  const onWinFocus = () => readFocus();

  win.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("focusout", onFocusOut, true);
  win.addEventListener("focus", onWinFocus);

  // Seed from the live DOM, so a relaunch that restores the caret into a terminal can be zoomed
  // before the user clicks anything.
  readFocus();

  return () => {
    if (pending !== null) clearTimeout(pending);
    pending = null;
    win.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("focusout", onFocusOut, true);
    win.removeEventListener("focus", onWinFocus);
  };
}
