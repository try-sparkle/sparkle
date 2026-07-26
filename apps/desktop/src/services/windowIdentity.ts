// Pure helpers for the app window's entry URL. The multi-window era minted `win-<uuid>` labels and
// carried `?project=`/`?label=`/`?focus=` on every secondary window; CM-U7 part 2 deleted the code
// that produced ALL of those, so what actually arrives today is exactly one param (roborev
// 46485-M):
//
//   - `?view=tray` / `?view=capture` — the two auxiliary webviews Rust opens
//     (src-tauri/src/tray.rs, capture_window.rs). The app window's URL comes from tauri.conf.json
//     and is a bare `index.html`, so "no ?view=" IS the app window.
//
// `?project=`/`?agent=` (a cold-start deep link from a notification hand-off) and `?focus=0` have
// no writer at present. Their parsers are kept — they are the documented re-entry points if a deep
// link is wired again — but nothing is claimed about them being produced today. Kept free of any
// Tauri import so they unit-test without a webview.

/** Which auxiliary webview this is, or null for the app window. */
export function parseViewFromSearch(search: string): "tray" | "capture" | null {
  const view = new URLSearchParams(search).get("view");
  return view === "tray" || view === "capture" ? view : null;
}

/** Is this the ONE app window (as opposed to the tray / capture webviews)? The single-window shell
 *  has no secondary app windows, so this is the whole of "am I the main window". */
export function isAppWindowSearch(search: string): boolean {
  return parseViewFromSearch(search) === null;
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
