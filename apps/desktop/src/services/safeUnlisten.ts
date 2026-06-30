// Shared teardown for Tauri event listeners.
//
// `listen(...)` resolves to an UnlistenFn. During rapid mount/unmount (StrictMode double-mount,
// fast tab switching) or a window close, two races throw an UNHANDLED rejection
// "Cannot read properties of undefined (reading 'handlerId')" (WebKit phrasing:
// "undefined is not an object (evaluating '...handlerId')"):
//
//   1. The unlisten fn runs AFTER Tauri has already torn down its internal listeners map
//      (window closing), so the lookup it does by handlerId hits `undefined`.
//   2. The `listen(...)` promise itself resolves AFTER the component unmounted; the late
//      unlisten then hits the same torn-down map.
//
// `safeUnlisten` accepts either an UnlistenFn or a Promise<UnlistenFn> (or null/undefined),
// awaits it if needed so a late-resolving listener is STILL cleaned up, calls it, and swallows
// (debug-logs) exactly that teardown race while rethrowing anything unexpected. Route every
// effect-cleanup / teardown unlisten call through this so the race can't surface as an app-level
// unhandled rejection.
import type { UnlistenFn } from "@tauri-apps/api/event";

/** True for the benign "listeners map already torn down" rejection (see file header). The
 *  `handlerId` token is stable across the V8 ("reading 'handlerId'") and WebKit
 *  ("evaluating '...handlerId'") phrasings, so match on it. */
function isTeardownRace(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("handlerId");
}

/**
 * Await (if needed) and invoke a Tauri unlisten fn, swallowing only the benign teardown race.
 * Returns a promise that always resolves cleanly for that race; an unexpected error rejects so it
 * isn't silently lost. Callers fire-and-forget: `void safeUnlisten(unlistenOrPromise)`.
 */
export async function safeUnlisten(
  target: UnlistenFn | Promise<UnlistenFn | null | undefined> | null | undefined,
): Promise<void> {
  if (target == null) return;
  try {
    const fn = typeof target === "function" ? target : await target;
    fn?.();
  } catch (e) {
    if (isTeardownRace(e)) {
      console.debug("safeUnlisten: swallowed Tauri listener teardown race", e);
      return;
    }
    throw e;
  }
}
