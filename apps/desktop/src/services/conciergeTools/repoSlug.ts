/**
 * `owner/repo` for a worktree or repo root — SYNCHRONOUSLY, because the policy is synchronous.
 *
 * WHY A CACHE AND NOT AN AWAIT. `evaluateToolPolicy` is pure and synchronous by contract, and the
 * whole binding under it is too: `configuredToolPolicy` answers the dispatch seam in one call. The
 * slug, though, comes from git — `remote.origin.url` for the worktree — which only Rust can read.
 * Making the read async would mean making the policy async, i.e. changing the signature every
 * caller and every existing test is written against, to answer a question whose answer never
 * changes for a given root. So the answer is resolved ONCE, out of band, and read from memory.
 *
 * A MISS IS `null`, AND `null` IS FOREIGN. That is the fail-closed direction and it is the point:
 * an unresolved root floors merge-class tools at `ask` (see policy.ts's lattice), so the worst a
 * cold cache can do is ask the human once. It can never widen anything. `primeRepoSlug` is called
 * for every known project root at hydrate time so the miss is rare in practice.
 *
 * NEVER THROWS, on any path. This sits under the tool-dispatch gate: a throw here would take out
 * the policy decision itself, and a policy that crashes is a policy that is not consulted.
 */

import { invoke } from "@tauri-apps/api/core";

/** Resolved answers, keyed by NORMALIZED root. A `null` value is a resolved "this root has no
 *  GitHub slug we recognise" — distinct from an absent key, which is "we have not looked yet",
 *  though both read as `null` at the seam because both are fail-closed. */
const CACHE = new Map<string, string | null>();

/** Roots with a resolve in flight, so N tool calls in one turn cost one round trip. Cleared on
 *  BOTH settle paths — a failed prime must be retryable, since the usual cause is the Rust command
 *  not existing yet in this build rather than anything about the root. */
const INFLIGHT = new Set<string>();

/** Trim and drop a trailing slash so `/a/b` and `/a/b/` are one cache entry rather than two.
 *  Deliberately NOT lowercased: macOS paths are case-insensitive but Linux's are not, and a root
 *  is a filesystem path, not a slug. */
function normalizeRoot(root: string | null | undefined): string | null {
  if (typeof root !== "string") return null;
  const trimmed = root.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** Lowercase `owner/repo`, or null for anything that is not exactly that. The Rust side already
 *  refuses non-GitHub hosts and deeper paths; this is the belt to that braces, because the value
 *  arrives over the wire as an untyped JSON scalar. */
function normalizeSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().toLowerCase().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `${parts[0]}/${parts[1]}`;
}

/** `owner/repo` for a worktree/repo root, or null if we have not resolved it yet. Never throws. */
export function slugForRoot(root: string | null | undefined): string | null {
  const key = normalizeRoot(root);
  if (key === null) return null;
  return CACHE.get(key) ?? null;
}

/**
 * Fire-and-forget: resolve `root` via the Rust command and cache it. Safe to call repeatedly.
 *
 * THE INVOKE IS GUARDED IN BOTH DIRECTIONS — the synchronous throw and the rejected promise. A
 * Tauri command that does not exist (an older build, the browser dev server, a test that never
 * mocked `@tauri-apps/api/core`) rejects, and an unhandled rejection from a fire-and-forget call
 * made on the dispatch path is a crash with no owner. Degrading to "unresolved" is the right
 * answer anyway: unresolved is foreign, foreign asks.
 */
export function primeRepoSlug(root: string): void {
  const key = normalizeRoot(root);
  if (key === null || CACHE.has(key) || INFLIGHT.has(key)) return;
  INFLIGHT.add(key);
  try {
    void Promise.resolve(invoke("repo_slug_for_root", { root: key }))
      .then((value) => {
        CACHE.set(key, normalizeSlug(value));
      })
      .catch(() => {
        // Not cached: the failure says nothing about the root, so a later prime should try again.
      })
      .finally(() => {
        INFLIGHT.delete(key);
      });
  } catch {
    INFLIGHT.delete(key);
  }
}

/** Prime a batch of roots — what hydration calls, so the common case is a cache hit. */
export function primeRepoSlugs(roots: readonly (string | null | undefined)[]): void {
  for (const root of roots) {
    const key = normalizeRoot(root);
    if (key !== null) primeRepoSlug(key);
  }
}

/** Test seam. */
export function __setRepoSlugForTest(root: string, slug: string | null): void {
  const key = normalizeRoot(root);
  if (key !== null) CACHE.set(key, normalizeSlug(slug));
}

export function __clearRepoSlugCache(): void {
  CACHE.clear();
  INFLIGHT.clear();
}
