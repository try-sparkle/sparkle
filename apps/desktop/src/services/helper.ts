// Frontend bindings for the floating helper island backend (src-tauri/src/helper.rs and
// frontmost.rs). Every call no-ops outside Tauri (tests, plain-browser dev) so callers never
// need to branch — same contract as services/attention.ts.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const noopUnlisten: UnlistenFn = () => {};

/** P0/P1 counts as computed by the MAIN window's concierge feed. */
export interface Vitals {
  p0: number;
  p1: number;
}

/** Push the authoritative counts to the island. Main window only. */
export function publishHelperVitals(p0: number, p1: number): void {
  if (!hasTauri) return;
  void invoke("publish_helper_vitals", { p0, p1 }).catch((e) =>
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
