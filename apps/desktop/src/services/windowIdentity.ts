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
// `?view=project&project=<id>` is the SATELLITE: a project tab torn out onto another monitor,
// created by src-tauri/src/project_window.rs from a fixed label pool. It renders columns ② + ③ for
// that one project — no concierge, no tab strip, no control listener — which is what keeps it from
// being the peer app window that CM-U7 part 2 purged. `?project=` finally has a writer; `?agent=`
// still does not, and `?focus=0` has none either (its parser is kept as the documented re-entry
// point if a deep link is wired again). Kept free of any Tauri import so they unit-test without a
// webview.

/** Which auxiliary webview this is, or null if the search names no KNOWN auxiliary view. Note the
 *  asymmetry with isAppWindowSearch: an unrecognized `?view=` is null here (we refuse to invent a
 *  webview kind) but is still NOT the app window. */
export function parseViewFromSearch(search: string): "helper" | "capture" | "project" | null {
  const view = new URLSearchParams(search).get("view");
  return view === "helper" || view === "capture" || view === "project" ? view : null;
}

/** The project a SATELLITE window renders, or null if this search isn't a well-formed satellite
 *  (src-tauri/project_window.rs).
 *
 *  A satellite renders columns ② + ③ for the one project named by `?project=`: no concierge, no tab
 *  strip, no control listener. It is deliberately NOT the app window, so it inherits the correct
 *  side of every `isAppWindowSearch` gate for free — the updater poller and the decompose watcher
 *  must run in exactly one webview, and that webview is `main`.
 *
 *  Returns the ID rather than a boolean ON PURPOSE. The predicate this replaced answered only
 *  "?view=project", so `?view=project` and `?view=project&project=` were both `true` while
 *  `parseProjectIdFromSearch` called them `null` — two helpers disagreeing about the same URL, and
 *  the natural caller shape `if (isSatellite(s)) render(parseProjectId(s))` got a satellite with no
 *  project and no compile error. A satellite without a project is not a meaningful window, so the
 *  pair is asserted here and the id comes back with the answer: the invalid state is now
 *  unrepresentable rather than merely tested for. Rust rejects empty ids too, but this module is
 *  pure precisely so it doesn't have to rely on a cross-language guarantee. */
export function parseSatelliteProjectId(search: string): string | null {
  return parseViewFromSearch(search) === "project" ? parseProjectIdFromSearch(search) : null;
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
