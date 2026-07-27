// Pure helpers for the app window's entry URL. The multi-window era minted `win-<uuid>` labels and
// carried `?project=`/`?label=`/`?focus=` on every secondary window; CM-U7 part 2 deleted the code
// that produced ALL of those, so what actually arrives today is exactly one param (roborev
// 46485-M):
//
//   - `?view=helper` / `?view=capture` — the two auxiliary webviews Rust opens
//     (src-tauri/src/helper.rs, capture_window.rs). The app window's URL comes from
//     tauri.conf.json and is a bare `index.html`, so "no ?view= AT ALL" IS the app window.
//     (`?view=tray` was the third until the menu-bar tray was deleted with the helper island;
//     nothing persists a webview URL — no window-state plugin, and the deep-link plugin only
//     emits an event — so no stale tray URL can arrive and the value is gone for good.)
//
// `?project=`/`?agent=` (a cold-start deep link from a notification hand-off) and `?focus=0` have
// no writer at present. Their parsers are kept — they are the documented re-entry points if a deep
// link is wired again — but nothing is claimed about them being produced today. Kept free of any
// Tauri import so they unit-test without a webview.

/** Which auxiliary webview this is, or null if the search names no KNOWN auxiliary view. Note the
 *  asymmetry with isAppWindowSearch: an unrecognized `?view=` is null here (we refuse to invent a
 *  webview kind) but is still NOT the app window. */
export function parseViewFromSearch(search: string): "helper" | "capture" | null {
  const view = new URLSearchParams(search).get("view");
  return view === "helper" || view === "capture" ? view : null;
}

/** Is this the ONE app window (as opposed to the helper / capture webviews)? The single-window
 *  shell has no secondary app windows, so this is the whole of "am I the main window".
 *
 *  Keyed on `?view=` being ABSENT, not on its value being unrecognized — this deliberately fails
 *  CLOSED. The app window's URL is a bare `index.html` from tauri.conf.json and no writer ever
 *  appends `?view=` to it, so any window carrying the param is by construction auxiliary. Testing
 *  the value instead is what let the helper island claim to be the app window: `?view=helper`
 *  parsed to null while this module still only knew `tray`/`capture`, and the exclusive work this
 *  guards (the update poller, the decompose watcher) would have silently run twice with no compile
 *  error. Adding a view in Rust must not be able to break the invariant before the TS catches up. */
export function isAppWindowSearch(search: string): boolean {
  return new URLSearchParams(search).get("view") === null;
}

/** Extract the project id a deep link would name, or null. No current writer — see the header. */
export function parseProjectIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("project");
  return id && id.trim() ? id : null;
}

/** Extract the agent id a deep link would name, or null. No current writer — see the header. */
export function parseAgentIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("agent");
  return id && id.trim() ? id : null;
}

/** Should this window skip the show-on-ready self-focus? (`?focus=0`). No current writer — the
 *  relaunch flow that set it went with the multi-window shell. */
export function parseSuppressSelfFocus(search: string): boolean {
  return new URLSearchParams(search).get("focus") === "0";
}
