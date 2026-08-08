// THE ONE DEFINITION of the message the transport synthesizes when an error body carries no prose
// of its own — an empty body, a non-JSON body, a proxy's HTML error page.
//
// It lives in its OWN leaf module, imported by both sides, and that is deliberate on two counts.
//
// ONE DEFINITION, because the alternative was two encodings of one string with nothing binding
// them: `api.ts`'s `ensureOk` built the message from a template literal, and `startError.ts`
// re-encoded that wording as a regex in order to suppress it. A reword on the producing side
// ("HTTP 403", a trailing period) would have silently stopped the match — and since suppressing it
// is what makes the status-aware sentences in `startError.ts` reachable at all, those sentences
// would have been shadowed again with the whole suite still GREEN, because every test hand-typed
// the same literal it was asserting (roborev 59357/59358).
//
// A LEAF, because `startError.ts` is a pure classifier and `api.ts` is the network module that five
// suites mock. Importing the matcher straight from `api.ts` gave the classifier a dependency on a
// commonly-mocked module, and a partial `vi.mock` of it broke three tests in a file that touches
// none of this ("No 'isSynthesizedErrorMessage' export is defined on the mock"). This module
// imports nothing, so it cannot be collateral damage of somebody else's mock.

/** The message the transport uses when an error response carries no message of its own. */
export const synthesizedErrorMessage = (status: number): string => `Request failed (${status})`;

/**
 * True when `message` is {@link synthesizedErrorMessage}'s output rather than the server's prose.
 *
 * When `status` is known this compares against what the producer WOULD emit for that status, so the
 * two cannot drift — that is the reciprocal binding, not a second pattern to keep in step. The
 * status-less form falls back to matching the shape, for a caller holding a message but no status.
 */
export function isSynthesizedErrorMessage(message: string, status?: number | null): boolean {
  const m = message.trim();
  if (status != null) return m === synthesizedErrorMessage(status);
  return /^Request failed \(\d{3}\)$/.test(m);
}
