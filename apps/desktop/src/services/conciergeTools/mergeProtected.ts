// THE MERGE-PROTECTION FLOOR — a LEAF module, and being a leaf is the point.
//
// ── WHY THIS IS NOT IN `policy.ts` ───────────────────────────────────────────────────────────────
// It was, and that produced a CIRCULAR IMPORT that only failed from certain entry points:
//
//   policy.ts → conciergeTools/lifecycle.ts → epicSweepRunner.ts → goalContinuationRunner.ts → policy.ts
//
// `policy.ts` does real work at module-init (`translateRisk` walks each op-module's risk table), so
// when the cycle is entered from the `lifecycle` side that table is still `undefined` and init dies
// with `TypeError: Cannot convert undefined or null to object` — a whole test file failing to LOAD,
// with no assertion involved and nothing naming the real cause.
//
// It is worth being precise about how that arrived, because it is the shape this repo keeps paying
// for: TWO independent changes, each correct and green on its own. One added the merge-authority
// read to `goalContinuationRunner` (bead sparkle-hrzitj spec D); the other made `lifecycle` ask the
// epic question at the retire seam (spec F). Neither closed the loop alone. The suites that would
// have caught it are the ones NEITHER author ran, because each ran only their own.
//
// So the data lives here instead: this module imports NOTHING, which is what makes the cycle
// impossible to re-form rather than merely absent today. `policy.ts` re-exports it, so every
// existing importer is unaffected.
//
// ── THE LIST IS A FLOOR COMPILED INTO THE BUILD, not a default ──────────────────────────────────
// Config can tighten past it and nothing can loosen it. That is what makes the owner's standing
// rule survive a future change to the global default, a reset config file, or a hand-edit.
// Declared here rather than imported from the JSON so no build-config change is needed
// (`resolveJsonModule`, bundler asset handling); `policy.pinnedRepos.test.ts` reads
// `shared/merge-protected-repos.json` FROM DISK and pins this list against it, so a slug added on
// one side and forgotten here fails a test.
export const MERGE_PROTECTED_SLUGS: readonly string[] = Object.freeze([
  "plow-pbc/tkmx-client",
  "plow-pbc/tkmx-server",
]);

/**
 * `owner/repo`, lowercased — or `null` when the input is not a slug at all.
 *
 * `...rest` is what rejects `a/b/c`: a three-part path is not a slug, and guessing at one would
 * point the policy at a repo nobody named. Destructured rather than indexed because under
 * `noUncheckedIndexedAccess` an array read is typed possibly-undefined, and the `!owner || !repo`
 * guard narrows both halves in one step.
 */
export function normalizeSlug(slug: string | null | undefined): string | null {
  if (typeof slug !== "string") return null;
  const [owner, repo, ...rest] = slug.trim().toLowerCase().split("/");
  if (rest.length > 0) return null;
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/** Is this slug on the shipped merge-protected list? A null slug is NOT pinned — it cannot name a
 *  pinned repo — and does not need to be: null is foreign, which floors it at `ask` anyway. */
export function isPinnedMergeProtectedSlug(slug: string | null): boolean {
  const normalized = normalizeSlug(slug);
  return normalized !== null && MERGE_PROTECTED_SLUGS.includes(normalized);
}
