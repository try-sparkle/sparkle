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

/** The SECOND jsdom-no-webview signature, from `@tauri-apps/api/event`'s `listen`/`once`/`emit`:
 *  they read `window.__TAURI_INTERNALS__.transformCallback`, so with no webview present the read
 *  throws `Cannot read properties of undefined (reading 'transformCallback')`. Call sites that
 *  subscribe to a Tauri event as a mount side effect (observed-attention, presence, audio-inputs,
 *  the Workspace listeners) each catch that rejection and log it once per mount — measured at
 *  ~4,478 console lines in a single CI shard, enough to starve vitest's worker→main RPC channel
 *  past its 60s `onTaskUpdate` timeout and redden a fully-passing shard (bead sparkle-2sntv2). Same
 *  cause as `invoke()` above, same benign-and-already-caught rejection, SAME fix: filter the console
 *  LINE only, never the behavior — `listen()` still rejects and still hits the same catch it always
 *  did; only whether that already-happening rejection is WRITTEN to console changes. This is why the
 *  established pattern is a console-line filter and not a `__TAURI_INTERNALS__` stub (see
 *  test-setup.ts's header for the two regressions stubbing caused). */
export const TAURI_LISTEN_UNAVAILABLE_IN_TEST =
  "Cannot read properties of undefined (reading 'transformCallback')";

/** Every Tauri-internal-unavailable signature the test console filter suppresses under jsdom.
 *  Appending one entry here is the ONLY change needed to fold a newly-discovered benign flood into
 *  the filter — the predicate below reads this list, so nothing else has to change. */
export const TAURI_UNAVAILABLE_SIGNATURES = [
  TAURI_UNAVAILABLE_IN_TEST,
  TAURI_LISTEN_UNAVAILABLE_IN_TEST,
] as const;

/** True if any argument to a console call renders down to (contains) ANY signature in
 *  `TAURI_UNAVAILABLE_SIGNATURES` — a plain string, a raw `Error` instance, or a JSON-ish object
 *  embedding it all match, since different call sites format their caught error differently
 *  (`console.debug(msg, e)`, `log.warn(scope, msg, {error: String(e)})`, …). */
export function argsCarryTauriUnavailableSignature(args: unknown[]): boolean {
  const carries = (s: string) => TAURI_UNAVAILABLE_SIGNATURES.some((sig) => s.includes(sig));
  return args.some((a) => {
    if (typeof a === "string") return carries(a);
    if (a instanceof Error) return carries(a.message);
    if (a && typeof a === "object") {
      try {
        return carries(JSON.stringify(a));
      } catch {
        return false;
      }
    }
    return false;
  });
}
