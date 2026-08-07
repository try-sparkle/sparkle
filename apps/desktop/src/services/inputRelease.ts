// THE ESCAPE HATCH — "my keyboard is dead and I cannot get out" (bead sparkle-thm9o).
//
// On 2026-08-06 the founder force-restarted Sparkle: no text box anywhere accepted typing, and the
// concierge could not be unmounted. The app was entirely healthy while it happened — the frontend
// kept logging, the watchdog heartbeat never missed a beat — so this was not a hang. It was a
// LOGICAL input-blocking state in a running app, and the app had no way to leave it.
//
// ── WHY THE TRIGGER IS NATIVE, NOT A KEY LISTENER ────────────────────────────────────────────────
//
// The obvious build is a document-level Escape handler. It is the wrong one, because it can be
// defeated by every condition this exists to escape: a capture-phase listener registered earlier
// wins (dispatch order is registration order, and `stopImmediatePropagation` from a surface that
// opened before us cannot be reached backwards); a full-viewport overlay swallows the press before
// any handler runs; and if focus has left the document entirely the webview never sees the key at
// all. A handler that lives inside the thing that is stuck cannot be relied on to unstick it.
//
// So the trigger is a native menu item with a key equivalent (`app_menu.rs`), which AppKit routes
// through the menu bar before the webview is consulted. `INPUT_RELEASE_EVENT` is what arrives here.
// The menu item is also clickable — which matters more than it looks: a user whose keyboard is the
// broken thing still has a mouse, and a keyboard-only hatch would be unreachable in precisely the
// case it was built for.
//
// ── WHY EVERY STEP IS INDEPENDENTLY GUARDED ──────────────────────────────────────────────────────
//
// This runs when the app is already in a state nobody predicted. Any one of these calls may throw
// against a torn store or a detached node, and a hatch that abandons the remaining five steps
// because the second one failed is not a hatch. Each step is therefore isolated, and the release is
// reported as a whole afterwards. Order is cheapest-and-most-general first, so the broadest
// remedies land even if a later one dies.
//
// ── WHY A SYNTHETIC `blur` DOES SO MUCH OF THE WORK ──────────────────────────────────────────────
//
// Every latch in this app that can strand input already treats losing focus as "stand down", and
// each of those paths is separately tested: `useHintMode` closes the chiclet overlay on `blur`,
// `usePushToTalk` abandons a held talk-key on `blur` (the macOS "keyup never arrives" case), and
// `ColumnPullTab` now ends a drag and tears down its shield on `blur`. Dispatching one `blur` reuses
// all of that rather than reimplementing each teardown here, where it would drift out of step with
// the real ones. The explicit store writes below cover what `blur` does not reach.

import { listen } from "@tauri-apps/api/event";

import { DRAG_SHIELD_SELECTOR } from "../components/ColumnPullTab";
import { log } from "../logger";
import { useCableStore } from "../stores/cableStore";
import { useKeybindingsStore } from "../stores/keybindingsStore";

/** Must match `INPUT_RELEASE_EVENT` in `src-tauri/src/app_menu.rs` — a Rust test reads THIS file and
 *  asserts the string appears, because a renamed event is otherwise silent on both sides and fails
 *  in the one state where nobody is able to report it. */
export const INPUT_RELEASE_EVENT = "input://release-requested";

/** Run `step`, and never let it take the rest of the release down with it. Returns whether it ran,
 *  so the log line can say what actually happened rather than asserting a clean sweep. */
function attempt(what: string, step: () => void): boolean {
  try {
    step();
    return true;
  } catch (e) {
    log.warn("input-release", `step "${what}" failed; continuing`, e);
    return false;
  }
}

/** How long after a release a second one is treated as the same gesture. See the coalescing note in
 *  {@link releaseAllInputCapture}. Long enough to swallow an OS auto-repeat burst (~30ms apart),
 *  short enough that a deliberate second press — press, look at the screen, press again — is never
 *  eaten. */
export const COALESCE_MS = 250;

let lastReleaseAt = -Infinity;

/** Test seam: forget the last release so a suite's cases cannot suppress each other. Successive
 *  tests run milliseconds apart, well inside {@link COALESCE_MS}, so without this the second case in
 *  a file would silently exercise the coalescing path instead of the release. */
export function resetInputReleaseCoalescing(): void {
  lastReleaseAt = -Infinity;
}

/** Release every input capture we know how to release. Exported for tests and for any in-app caller
 *  that wants the same remedy without the menu round trip.
 *
 *  ── COALESCED, AND IT HAS TO BE HERE RATHER THAN AT THE TRIGGERS ────────────────────────────────
 *
 *  The `e.repeat` guard on the DOM fallback does NOT cover the shipping path. With the accelerator
 *  attached, AppKit routes the chord through the menu bar and the webview never sees the keydown at
 *  all — but macOS re-invokes a menu key equivalent on auto-repeat, and `on_menu_event` emits
 *  INPUT_RELEASE_EVENT unconditionally on each one, to EVERY webview. Holding the chord for ~700ms
 *  would therefore fan out ~20 broadcasts × 2 subscribed roots = ~40 full releases and ~40 WARN
 *  lines — drowning the very log line that is this bead's recurrence signal (roborev 59717).
 *
 *  Coalescing at the single shared entry point covers every trigger at once — menu, keyboard
 *  fallback, and any future in-app caller — instead of re-deriving "is this a repeat?" per path in
 *  a form that only one of them can express. */
export function releaseAllInputCapture(source: string): void {
  const at = Date.now();
  if (at - lastReleaseAt < COALESCE_MS) {
    // A SUPPRESSED REPEAT EXTENDS THE WINDOW — this is a leading-edge DEBOUNCE, not a fixed-window
    // rate limiter. Without this line the window lapses on a fixed schedule while the key is still
    // held, so a continuous auto-repeat stream (~30ms apart) fires again every 250ms: ~4 releases a
    // second for as long as the user leans on the chord, which is the flood this exists to stop
    // rather than a bounded version of it (roborev 59763). Extending means one release at the
    // leading edge and silence until the repeats actually STOP.
    lastReleaseAt = at;
    return;
  }
  lastReleaseAt = at;
  releaseNow(source);
}

function releaseNow(source: string): void {
  const done: string[] = [];
  const failed: string[] = [];
  const run = (what: string, step: () => void) => (attempt(what, step) ? done : failed).push(what);

  // 1. Drop the DOM caret. If focus is parked on a non-editable node — or inside a surface that is
  //    hidden but still mounted — this is what makes the next click able to land anywhere.
  run("blur-active-element", () => {
    const el = document.activeElement;
    if (el instanceof HTMLElement) el.blur();
  });

  // 2. The synthetic blur that every latch already stands down on. See the header.
  run("dispatch-window-blur", () => window.dispatchEvent(new Event("blur")));

  // NO CORRECTIVE `focus` IS DISPATCHED HERE, deliberately — the correction lives in the two
  // listeners that need it, not in this broadcast.
  //
  // The blur above is a lie, and two listeners are LEVEL-HELD rather than edge-triggered:
  // `useDictation` and `voice/dictationFocusTracker` latch "not focused" and clear only on a real
  // `focus`. The obvious repair — follow the blur with a synthetic `focus` — was written and then
  // removed, because it is far more expensive than it looks (roborev 59651):
  //
  //   * `useDictation`'s blur tears down the owned Deepgram relay and its focus resumes it, in the
  //     SAME tick. Metering is debited per elapsed minute UP FRONT, so pressing the hatch would bill
  //     the user for a relay restart nothing asked for; worse, `stop_cloud_stream` is issued
  //     unawaited and `start_cloud_stream` follows immediately, and Tauri orders neither — a stop
  //     landing after the start kills the fresh relay and leaves dictation dead. That is the exact
  //     outcome the hatch exists to prevent.
  //   * a `window` focus dispatch reaches EVERY focus listener, ~10 of them unrelated: an auth
  //     re-probe that can mount a blocking gate over the user who just asked to be un-blocked, three
  //     credit refreshes, a satellite reconcile, the updater. A hatch that runs in an unpredictable
  //     state must not also fire a burst of network calls.
  //
  // So both trackers now ignore a blur that `document.hasFocus()` contradicts, which fixes the
  // stranding for any spurious blur rather than only the one this file dispatches.

  // 3. The rebind latch, which `blur` does NOT clear: while `capturingShortcut` is set,
  //    KeyboardShortcutsMenu preventDefaults EVERY keydown and keyup in the app from window/capture.
  run("clear-shortcut-capture", () => useKeybindingsStore.getState().setCapturingShortcut(null));

  // 4. Unmount the concierge. This is the symptom the founder reported by name, and the reason it
  //    goes here rather than being left to the Escape ladder is that the ladder fails closed on a
  //    leaked `[role="dialog"]` node anywhere in the document — see `engine/cable.ts`.
  run("unbind-cable", () => useCableStore.getState().unbind());

  // 5. Sweep any stranded drag shield. A transparent, full-viewport, pointer-taking sheet at the
  //    maximum z-index is invisible AND blocks every click, so it must not depend on the component
  //    that raised it still being mounted, or on `dragging` being correct.
  run("sweep-drag-shields", () => {
    document.querySelectorAll(DRAG_SHIELD_SELECTOR).forEach((n) => n.remove());
  });

  // WARN, not info, and it names the source. A line here means a user was stuck enough to reach for
  // the hatch — that is the recurrence signal for sparkle-thm9o, and it must not be filtered out
  // with routine chatter. `failed` is reported rather than swallowed: if the hatch itself is
  // degrading, the next report needs to say so.
  log.warn(
    "input-release",
    `released all input capture (via ${source}); ran=[${done.join(",")}]${
      failed.length ? ` failed=[${failed.join(",")}]` : ""
    }`,
  );
}

/** Does this keystroke match the hatch chord the menu item advertises (CmdOrCtrl+Shift+Escape)?
 *
 *  Pure and exported so the chord is pinned by a unit test rather than by reading the handler. Meta
 *  OR Control, matching `CmdOrCtrl` on the Rust side: the accelerator resolves per-platform, and a
 *  fallback that only honoured one of them would be dead on the other. */
export function isReleaseChord(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey">,
): boolean {
  return e.key === "Escape" && e.shiftKey && (e.metaKey || e.ctrlKey);
}

/** Wire the native menu item to the release, plus the secondary DOM fallback. Returns an uninstall
 *  fn.
 *
 *  ── WHY A DOM FALLBACK EXISTS AT ALL, GIVEN THE HEADER ABOVE ─────────────────────────────────────
 *
 *  The header argues the trigger must not be a DOM key listener, and that still holds: a listener
 *  inside the stuck thing cannot be RELIED ON to unstick it. But "cannot be relied on" is not "never
 *  works", and this one costs nothing to add. It covers the two cases `app_menu.rs` documents and
 *  the native path does not reach:
 *
 *    * the dev server, where there is no Tauri runtime at all — `listen` rejects, and without this
 *      there is no hatch while developing the very feature;
 *    * a build where `build_input_release_item` degraded to a menu item with NO key equivalent (it
 *      is deliberately fail-soft), leaving a mouse-only hatch.
 *
 *  CAPTURE phase, so it runs before the surfaces that swallow keys — same reasoning as the rest of
 *  the app's window/capture cohort. It is strictly additive: if the native path also fires, the
 *  release is idempotent by construction. */
export function installInputRelease(): () => void {
  // `listen` is async, so a synchronous uninstall arriving first must still cancel the pending
  // subscription — the same shape `services/agentTransport.ts` documents.
  let cancelled = false;
  let un: (() => void) | null = null;
  void listen(INPUT_RELEASE_EVENT, () => releaseAllInputCapture("native menu"))
    .then((u) => {
      if (cancelled) u();
      else un = u;
    })
    .catch((e) => log.warn("input-release", "could not subscribe to the release event", e));

  const onKeyDown = (e: KeyboardEvent) => {
    // AN AUTOREPEAT IS NOT A SECOND PRESS — the same trap `Workspace.tsx`'s Escape handler names.
    // Holding the chord emits a keydown every ~30ms after the initial delay, and without this the
    // whole release runs on each one: tens of cable unbinds, shield sweeps and WARN lines from one
    // deliberate press. The log line is the recurrence signal for this bead, so a held key drowning
    // it is not cosmetic. Only the keydown path can repeat; a menu click cannot.
    if (e.repeat || !isReleaseChord(e)) return;
    // Consumed, so the press that frees the app does not ALSO reach the Escape ladder underneath and
    // spend a second, unrelated state change on one keystroke — the same over-reach the cable's
    // two-rung ladder is careful about.
    e.preventDefault();
    e.stopPropagation();
    releaseAllInputCapture("keyboard fallback");
  };
  window.addEventListener("keydown", onKeyDown, true);

  return () => {
    cancelled = true;
    un?.();
    un = null;
    window.removeEventListener("keydown", onKeyDown, true);
  };
}
