// The one thing that WATCHES focus for dictation. Installed once at the app root (App.tsx), the
// same way installInputFreezeTrace is — that trace is what proved the terminal case was real
// (`activeElement=textarea .xterm-helper-textarea` while the mic was live), and this is the fix
// listening on the same event.
//
// It decides NOTHING. It records two observations into the dictation store — who holds the caret
// and whether this window is the active one — and the pure dictationPauseReason turns those into a
// verdict for the routing gate (useDictation) and for the copy (dictationCopy). Keeping the watcher
// dumb is what lets the decision stay in one testable place.
//
// COST: one `closest()` call per focus CHANGE, and a store write only when the answer actually
// changes (both de-duped below). `focusin` fires on focus transitions, not on keystrokes, so this
// is strictly cheaper than the freeze trace already bound to the same event — which is why it is
// NOT gated on the mic being armed. A gated watcher goes stale across a mute: mute while the caret
// is in a terminal, click into the composer, unmute, and a gated tracker would still be holding
// "terminal" and pause a mic that has nothing to pause. Inertness is achieved where it belongs
// instead — dictationPauseReason returns null whenever the mic is disarmed, so everything this
// records has exactly zero effect until the user arms the mic.

import { classifyFocusOwner, type FocusOwner } from "./dictationFocus";

export interface DictationFocusTrackerDeps {
  /** Record who holds the caret. Called only when the answer CHANGES. */
  setFocusOwner: (owner: FocusOwner) => void;
  /** Record whether this window is the active OS window. Called only when it CHANGES. */
  setWindowFocused: (focused: boolean) => void;
  /** Injected for tests; defaults to the real document/window. */
  doc?: Document;
  win?: Window;
}

/** Install the tracker; returns an uninstall fn.
 *
 *  Listens on `focusin` in the CAPTURE phase (it must see the transition even if something
 *  downstream stops propagation) plus window focus/blur, and re-reads `document.activeElement`
 *  rather than trusting `event.target` — the caret's final resting place after a focus transition
 *  is what routing cares about, and the two can differ. */
export function installDictationFocusTracker(deps: DictationFocusTrackerDeps): () => void {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;

  // Last values PUSHED to the store. Writing only on change keeps `focusin` off the store's
  // subscriber list in the common case (moving between two non-terminal elements is a no-op here).
  let lastOwner: FocusOwner | null = null;
  let lastWindowFocused: boolean | null = null;

  const readOwner = () => {
    const owner = classifyFocusOwner(doc.activeElement);
    if (owner === lastOwner) return;
    lastOwner = owner;
    deps.setFocusOwner(owner);
  };

  const writeWindowFocused = (focused: boolean) => {
    if (focused !== lastWindowFocused) {
      lastWindowFocused = focused;
      deps.setWindowFocused(focused);
    }
    // Re-read the caret on every window transition, not just on `focusin`: returning to the window
    // restores focus to whatever held it before WITHOUT necessarily emitting a focusin we'd see, so
    // a tracker that only listened to focusin could come back believing the caret is where it was
    // two windows ago.
    readOwner();
  };

  const onFocusIn = () => readOwner();
  // ══ `focusout` IS NOT OPTIONAL — LEAVING A TERMINAL OFTEN RAISES NO `focusin` AT ALL ═══════════
  // No browser fires `focusin` when focus leaves an element for a NON-FOCUSABLE target: `focusout`
  // fires, `activeElement` reverts to <body>, and nothing follows. That is the ordinary result of
  // clicking app chrome, a scroll region or the page background after the caret was in an xterm
  // pane — and on macOS/WKWebView, which is the webview this app actually ships in, it is ALSO what
  // clicking a plain <button> does, because WebKit blurs the focused element without focusing the
  // button unless Full Keyboard Access is on.
  //
  // NOTE (roborev 55555): `armedStatus` in dictationFocus.ts briefly claimed the OPPOSITE of that last
  // sentence — that a WKWebView button click leaves the caret on the textarea. The two were reconciled
  // in favour of THIS one, because it is the claim with live code riding on it, NOT because it was
  // re-measured. If anyone does measure it and this turns out wrong, the listener below is what has to
  // change, and `armedStatus`'s reachability note has to change with it.
  //
  // Without this listener `focusOwner` stays "terminal" indefinitely, and the two halves of this
  // feature then read DIFFERENT sources and disagree: the routing gate re-reads the live DOM and
  // happily starts routing again, while the store-fed copy still says "your cursor is in a
  // terminal". Text gets transcribed and the auto-send clock arms while both mic surfaces claim to
  // be paused — the exact half-state this feature exists to remove, inverted. The relay never
  // reopens either, since `streamTornDown` stays armed until something takes focus.
  //
  // DEFERRED to the next task, because `activeElement` is transiently <body> (or null) DURING the
  // transition: reading it synchronously inside `focusout` would report "other" for a click that is
  // about to land in another part of the same terminal, and flap the pause off and back on. By the
  // time the deferred read runs the caret has settled, and `readOwner`'s change guard collapses the
  // no-op case. Cancelled on uninstall so a pending read can't write to a torn-down tracker.
  let pendingRead: ReturnType<typeof setTimeout> | null = null;
  const onFocusOut = () => {
    if (pendingRead !== null) clearTimeout(pendingRead);
    pendingRead = setTimeout(() => {
      pendingRead = null;
      readOwner();
    }, 0);
  };
  const onWinFocus = () => writeWindowFocused(true);
  const onWinBlur = () => writeWindowFocused(false);

  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("focusout", onFocusOut, true);
  win.addEventListener("focus", onWinFocus);
  win.addEventListener("blur", onWinBlur);

  // Seed from the live DOM so the store is correct BEFORE the first focus event — a mic armed at
  // launch with the caret already in a terminal must read as paused immediately, not on the next
  // click. `hasFocus` is guarded for non-DOM/exotic hosts; a missing one means "assume focused",
  // which fails OPEN (dictation routes) rather than pausing a window nobody can un-pause.
  writeWindowFocused(typeof doc.hasFocus === "function" ? doc.hasFocus() : true);

  return () => {
    if (pendingRead !== null) clearTimeout(pendingRead);
    pendingRead = null;
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("focusout", onFocusOut, true);
    win.removeEventListener("focus", onWinFocus);
    win.removeEventListener("blur", onWinBlur);
  };
}
