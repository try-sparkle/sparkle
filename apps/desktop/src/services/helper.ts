// Frontend bindings for the floating helper island backend (src-tauri/src/helper.rs and
// frontmost.rs). Every call no-ops outside Tauri (tests, plain-browser dev) so callers never
// need to branch — same contract as services/attention.ts.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
// Imported, not re-declared: the island and the takeover must agree on this name, and a second
// literal is exactly how the CAPTURE_CLOSED contract below acquired a "must match" comment.
import { CAPTURE_SEND } from "../capture/captureEvents";

const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const noopUnlisten: UnlistenFn = () => {};

/** Band counts as computed by the MAIN window's concierge feed. The island shows the two bands
 *  worth interrupting for; `done` is deliberately absent — on a resting fleet it is nearly every
 *  agent, so a permanent "40 Done" would drown the two numbers that actually change. Field names
 *  match the Rust `Vitals` struct in src-tauri/src/helper.rs. */
export interface Vitals {
  needsYou: number;
  running: number;
}

/** Push the authoritative counts to the island. Main window only. */
export function publishHelperVitals(needsYou: number, running: number): void {
  if (!hasTauri) return;
  void invoke("publish_helper_vitals", { needsYou, running }).catch((e) =>
    console.debug("publish_helper_vitals failed", e),
  );
}

/** Seed a freshly-loaded island that missed the last push. Resolves null outside Tauri. */
export function getHelperVitals(): Promise<Vitals | null> {
  if (!hasTauri) return Promise.resolve(null);
  return invoke<Vitals>("get_helper_vitals").catch((e) => {
    // Logged, not swallowed: a missing capability or a payload mismatch would otherwise be
    // indistinguishable from "no vitals yet" and the island would show 0/0 forever with no trace.
    console.debug("get_helper_vitals failed", e);
    return null;
  });
}

export function onHelperVitalsChanged(cb: (v: Vitals) => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(noopUnlisten);
  return listen<Vitals>("helper://vitals-changed", (e) => cb(e.payload));
}

/** Seed the current frontmost value on mount. `app://frontmost-changed` only fires on TRANSITIONS,
 *  so a webview that loads after the last one would otherwise assume `false` and paint the island
 *  over the app. Resolves null outside Tauri. */
export function getFrontmost(): Promise<boolean | null> {
  if (!hasTauri) return Promise.resolve(null);
  return invoke<boolean>("get_frontmost").catch((e) => {
    console.debug("get_frontmost failed", e);
    return null;
  });
}

/** True when a real Sparkle window is frontmost (the helper and capture panels don't count). */
export function onFrontmostChanged(cb: (frontmost: boolean) => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(noopUnlisten);
  return listen<boolean>("app://frontmost-changed", (e) => cb(e.payload));
}

/** The global capture shortcut, forwarded to the island so one code path runs the capture flow. */
export function onCaptureRequested(cb: () => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(noopUnlisten);
  return listen("helper://capture-requested", () => cb());
}

/** Must match CAPTURE_CLOSED_EVENT in src-tauri/src/capture_window.rs — asserted by a test there
 *  (`the_typescript_listener_uses_the_same_event_name`), not merely by this comment. */
const CAPTURE_CLOSED = "capture://closed";

/** The takeover was dismissed. The island suppresses itself for the whole time the takeover is up
 *  — it is always-on-top and the takeover fills the display — and `showCaptureWindow` resolves when
 *  the takeover is SHOWN, not when the user is finished with it. This is the missing edge. */
export function onCaptureClosed(cb: () => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(noopUnlisten);
  return listen(CAPTURE_CLOSED, () => cb());
}

/** A send left the takeover, so the main window is ABOUT to be raised — `handleCaptureSend` routes
 *  the payload and only then calls `focusThisWindow()` (services/captureSends.ts).
 *
 *  The island needs this because `capture://closed` fires FIRST, at the tail of `hide_capture_window`,
 *  while `frontmost` is still false (the takeover is deliberately excluded from the frontmost
 *  policy). Lifting the suppression there re-showed the island for the length of one dispatch and
 *  then hid it again — a pop-and-vanish on every send from outside Sparkle, which is the primary
 *  flow. Suppression instead holds until frontmost actually settles. */
export function onCaptureSend(cb: () => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(noopUnlisten);
  return listen(CAPTURE_SEND, () => cb());
}

/** Is the takeover on screen RIGHT NOW? The seed for the island's suppression, mirroring
 *  `getFrontmost` and `getHelperVitals` — and for the same reason they exist: `capture://closed` is
 *  a single edge, so a helper webview that mounts (or reloads, or crashes and reloads) while the
 *  takeover is up would otherwise assume "closed" and paint over it, and a close edge that never
 *  arrives would otherwise suppress the island for the rest of the session with no recovery.
 *  Resolves null outside Tauri. */
export function getTakeoverOpen(): Promise<boolean | null> {
  if (!hasTauri) return Promise.resolve(null);
  return invoke<boolean>("is_capture_open").catch((e) => {
    console.debug("is_capture_open failed", e);
    return null;
  });
}

/** Reveal and focus the main window — the island's right-click "Open Sparkle".
 *
 *  Load-bearing, like quitApp beside it. Closing the main window only HIDES it, and the menu-bar
 *  extra that used to carry an "Open" item is gone, so without this the only ways back in are the
 *  macOS Dock icon and clicking a P0/P1 chiclet — neither of which reads as "open Sparkle". */
export function showMainWindow(): void {
  if (!hasTauri) return;
  void invoke("show_main_window").catch((e) => console.debug("show_main_window failed", e));
}

/** Must match `HELPER_TOGGLE_EVENT` in src-tauri/src/app_menu.rs — asserted by a test there
 *  (`the_typescript_listener_uses_the_same_event_name`), not merely by this comment. */
const HELPER_TOGGLE_REQUESTED = "helper://toggle-requested";

/** The native "View → Hide/Show Helper" item was picked.
 *
 *  PAYLOAD-FREE, and the listener must TOGGLE rather than set: the menu handler runs in Rust, which
 *  cannot read the localStorage-backed `helperPrefs` store, so it can only ask for a flip. The store
 *  stays the single authority on the value.
 *
 *  Emitted app-wide, so exactly ONE listener may act on it — HelperApp, the webview that owns the
 *  island. A second subscriber would flip the flag twice and the menu item would look dead. */
export function onHelperToggleRequested(cb: () => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(noopUnlisten);
  return listen(HELPER_TOGGLE_REQUESTED, () => cb());
}

/** Push the current preference onto the native menu item's label ("Hide Helper" ⇄ "Show Helper").
 *
 *  The other half of the bridge above. Called on mount and on every change, so the menu also follows
 *  a hide made from the island's OWN right-click menu — otherwise the menu bar would keep offering
 *  "Hide Helper" for an island that was already gone, which is the exact confusion the item exists
 *  to prevent. */
export function setHelperMenuState(enabled: boolean): void {
  if (!hasTauri) return;
  void invoke("set_helper_menu_state", { enabled }).catch((e) =>
    console.debug("set_helper_menu_state failed", e),
  );
}

export function showHelper(): void {
  if (!hasTauri) return;
  void invoke("show_helper").catch((e) => console.debug("show_helper failed", e));
}

export function hideHelper(): void {
  if (!hasTauri) return;
  void invoke("hide_helper").catch((e) => console.debug("hide_helper failed", e));
}

/** Move and resize together — a collapse changes both, and two round-trips would render an
 *  intermediate frame at the wrong geometry. */
export function setHelperBounds(x: number, y: number, width: number, height: number): void {
  if (!hasTauri) return;
  void invoke("set_helper_bounds", { x, y, width, height }).catch((e) =>
    console.debug("set_helper_bounds failed", e),
  );
}
