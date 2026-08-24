// A per-app-load namespace for concierge HISTORY ROW ids.
//
// ── THE DEFECT THIS CLOSES (ten days of the founder's messages overwritten) ─────────────────────
// `ConciergeHost` mints every bubble id from a module-level counter — `let seq = 0; nextId(p) =>
// `${p}-${++seq}`` — which RESTARTS AT 0 ON EVERY APP RELOAD. `conciergeHistoryCapture` used that
// bubble id directly as the history row's PRIMARY KEY, and the Rust sink writes rows with
// `INSERT OR IGNORE` on that key. So the second app load's `you-1` collided with the first load's
// `you-1` and was DROPPED — silently, with a successful-looking write.
//
// Measured against the live history DB before this fix: of 200 on-screen concierge bubbles, 199 had
// the same id as an existing row but DIFFERENT text, and only 1 new row was written (its number
// happened to land in a hole in the id space). Concierge RESPONSES stopped being recorded at all
// once `sparkle-N` / `brain-N` filled up. One day held 41 distinct prompts and ZERO rows.
//
// ── THE FIX, AND WHY IT LIVES HERE RATHER THAN AT THE BUBBLE ────────────────────────────────────
// The row id becomes `${sessionToken}:${bubbleId}` — e.g. `9f2c1a7e-…:you-1`. That is the founder's
// sanctioned "(session id, sequence) composite" identity, applied at the ONE boundary that needs it:
// storage.
//
// It is deliberately NOT applied by making the bubble ids themselves opaque. `brain-<N>` ids are not
// minted by `nextId` at all — the N is the RUST TURN ID, and `endStreamsThrough` in
// `conciergeThreadStore` parses it numerically (`/^\d+$/`, then `Number(raw) > throughTurn`) to
// decide which still-streaming bubbles to mark dead. That number is SEMANTIC. Opaque bubble ids
// would break that sweep, the streaming upsert's `findIndex((m) => m.id === k)`, React keys and
// `rehydrateThread`'s positional reindex, all at once. Namespacing at the sink is a two-file blast
// radius instead of six.
//
// ── LEGACY ROWS ─────────────────────────────────────────────────────────────────────────────────
// The DB already holds thousands of un-namespaced ids (`you-1`, `brain-7`, UUID-shaped ones, a few
// `approval-ran*`). Nothing here re-keys them and no migration is wanted: they still read fine, and
// `bubbleIdForCurrentSession` reports them as not-on-screen, which is the truth.

/**
 * Minted ONCE per module load and memoized. Module load ≙ app load, which is exactly the boundary
 * the colliding counter resets at — so one token per load is precisely the namespace we need.
 */
let memoized: string | null = null;

function mint(): string {
  // `crypto.randomUUID` is the preferred source: 122 bits of entropy, and no truncation is applied
  // to it. A shortened token would reintroduce the very failure mode being fixed — two app loads on
  // the same day colliding — for the sake of a few characters in a column nobody reads by eye.
  const c: Crypto | undefined = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    try {
      return sanitize(c.randomUUID());
    } catch {
      // Some embedders expose `randomUUID` but throw on a non-secure origin. Fall through.
    }
  }
  // Fallback for jsdom and older WebKit, where `randomUUID` may be absent. Time gives monotonic
  // separation between loads; the random suffix covers two loads inside the same millisecond.
  return sanitize(Date.now().toString(36) + Math.random().toString(36).slice(2));
}

/**
 * A token may never contain ":" — the row id is split on its FIRST colon, so a colon inside the
 * token would make the namespace ambiguous and hand the reader back a truncated bubble id. Neither
 * generator above can produce one; the strip is a cheap guard against a future one that could.
 */
function sanitize(raw: string): string {
  return raw.replace(/:/g, "");
}

/** This app load's namespace. Stable for the life of the module; different on the next load. */
export function conciergeSessionToken(): string {
  if (memoized === null) memoized = mint();
  return memoized;
}

/** The history row primary key for an on-screen bubble. */
export function historyRowId(bubbleId: string): string {
  return `${conciergeSessionToken()}:${bubbleId}`;
}

/**
 * The INVERSE — "is this stored row a bubble that is on screen RIGHT NOW, and under what id?"
 *
 * This is what the scrubber rail needs to jump from a history hit to the live bubble. It returns
 * null rather than a best guess in the two cases where jumping would be wrong:
 *
 *   • a row from a PREVIOUS app load — its bubble id may well be reused by a bubble on screen now
 *     (that id-reuse is the whole defect), so honouring it would scroll to somebody else's message;
 *   • a LEGACY un-namespaced row (no ":" at all) — written before this scheme existed, so it cannot
 *     be attributed to any session and certainly not to this one.
 *
 * Splits on the FIRST colon only, so a bubble id that itself contains a colon round-trips intact.
 */
export function bubbleIdForCurrentSession(rowId: string): string | null {
  const at = rowId.indexOf(":");
  if (at < 0) return null; // legacy row, written before ids were namespaced
  if (rowId.slice(0, at) !== conciergeSessionToken()) return null; // a previous app load
  const bubbleId = rowId.slice(at + 1);
  // A trailing-colon row names no bubble; an empty id would be a falsy handle the rail cannot use.
  return bubbleId.length > 0 ? bubbleId : null;
}

/**
 * TEST-ONLY. Clears the memoized token so a test can simulate a SECOND APP LOAD.
 *
 * It exists solely for the cross-session collision test — the regression here was invisible within
 * one session and only appears when two loads mint the same bubble ids, so a test that cannot
 * re-mint the token cannot express the bug at all. The leading underscores mark it as not
 * production API; nothing outside a test may call it.
 */
export function __resetConciergeSessionTokenForTest(): void {
  memoized = null;
}
