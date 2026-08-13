/** The stable TypeError message `@tauri-apps/api/core`'s real `invoke()` throws under jsdom with
 *  no Tauri webview present: `window.__TAURI_INTERNALS__` is `undefined`, so reading `.invoke`
 *  off it throws `Cannot read properties of undefined (reading 'invoke')`. Every call site that
 *  catches an unmocked `invoke()` rejection carries this exact message somewhere in its caught
 *  error, however differently each formats it into its own log line (see test-setup.ts, which
 *  filters console output on it — never `invoke()`'s own behavior; see that file's header for
 *  why). Kept in its own module, not inlined in test-setup.ts, so a test can import the pure
 *  predicate directly instead of importing test-setup.ts itself — the latter has no OTHER
 *  importer (it is wired via vite.config.ts's `setupFiles`, invisible to import-graph scanning),
 *  so a test importing it directly would make it read as "reachable only from a test" to
 *  scripts/dormant-modules.mjs. */
export const TAURI_UNAVAILABLE_IN_TEST = "Cannot read properties of undefined (reading 'invoke')";

/** True if any argument to a console call renders down to (contains) the signature above — a
 *  plain string, a raw `Error` instance, or a JSON-ish object embedding it all match, since
 *  different call sites format their caught error differently (`console.debug(msg, e)`,
 *  `log.warn(scope, msg, {error: String(e)})`, …). */
export function argsCarryTauriUnavailableSignature(args: unknown[]): boolean {
  return args.some((a) => {
    if (typeof a === "string") return a.includes(TAURI_UNAVAILABLE_IN_TEST);
    if (a instanceof Error) return a.message.includes(TAURI_UNAVAILABLE_IN_TEST);
    if (a && typeof a === "object") {
      try {
        return JSON.stringify(a).includes(TAURI_UNAVAILABLE_IN_TEST);
      } catch {
        return false;
      }
    }
    return false;
  });
}
