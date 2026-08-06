// Resolving WHICH REPOSITORY a folder belongs to, and keeping the project store's `repoKey` filled
// in — the store-writing half of engine/projectIdentity.
//
// The identity rule is pure and synchronous (engine/projectIdentity), but the FACT it runs on comes
// from a git subprocess, which is neither. This module is that seam: one cached async resolver, and
// one sweep that backfills records persisted before the field existed.
//
// WHY BACKFILL AT ALL, rather than resolving only at add time. The bug this feature exists for is
// already ON DISK: the founder's two records for one repository were created long before any of
// this. Resolving only for newly-added projects would ship a fix that does nothing for the person
// who reported it, and nothing for anyone else's existing store either — the defect would simply
// stop growing. So the sweep runs over what is already there.
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../stores/projectStore";
import type { Project } from "../types";

/** Resolved keys by rootPath, so the same folder is never asked about twice in a session. Holds
 *  `null` (a real answer: "not a repo") as well as strings — see the `has` check in `repoKeyFor`,
 *  which is what stops a non-repo folder being re-resolved on every sweep. */
const cache = new Map<string, string | null>();

/** In-flight lookups, so N callers asking about one folder at once share ONE subprocess. Without
 *  this the sweep and a concurrent picker open would both spawn git for the same path. */
const inFlight = new Map<string, Promise<string | null>>();

/** Exported for tests only — a module-level cache outlives a test file otherwise, and the second
 *  test would read the first one's answers. */
export function __resetRepoKeyCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Forget one folder's cached answer, because something CHANGED whether it is a repository.
 *
 * `ensure_project_repo` `git init`s an empty folder, and the dedupe that runs before it has
 * already asked (and cached) "not a repo". Without this the pre-init answer would be the one the
 * whole session sees, so a concierge-added project could never acquire a repo key.
 */
export function forgetRepoKey(rootPath: string): void {
  cache.delete(rootPath);
}

/**
 * The canonical `.git` common dir for `rootPath`, or `null` when it is not a git repository.
 *
 * NEVER THROWS. A folder that has been deleted, a git that will not run, no Tauri at all (dev
 * preview, jsdom) — all of them answer `null`, which the identity rule reads as "unknown, fall back
 * to path". A rejected promise here would have to be handled at every call site, and the one that
 * forgot would turn "we could not tell" into a broken open.
 */
export async function repoKeyFor(rootPath: string): Promise<string | null> {
  if (cache.has(rootPath)) return cache.get(rootPath) ?? null;
  const pending = inFlight.get(rootPath);
  if (pending) return pending;
  const p = (async () => {
    try {
      const key = await invoke<string | null>("project_repo_key", { root: rootPath });
      const value = key ?? null;
      cache.set(rootPath, value);
      return value;
    } catch {
      // DELIBERATELY NOT CACHED. A transient failure (git busy, a folder on a volume that is
      // remounting) must not pin this folder to "unknown" for the rest of the session — the next
      // sweep gets to ask again. A real "not a repo" comes back as a successful `null` above and IS
      // cached.
      return null;
    }
  })();
  inFlight.set(rootPath, p);
  try {
    return await p;
  } finally {
    inFlight.delete(rootPath);
  }
}

/** Does this project still need a repository resolved? Only a real key retires it — a `null` is
 *  never persisted (projectStore.setProjectRepoKey), because "could not resolve" must stay
 *  retryable rather than becoming a permanent answer. */
function needsKey(p: Project): boolean {
  return !p.repoKey;
}

/**
 * Fill in `repoKey` for every project that has never had one resolved, and write it to the store.
 *
 * Idempotent and cheap to re-run: a project that already carries a key is skipped without a
 * subprocess, and one we could not resolve is answered from this module's cache rather than a
 * second git call, so the steady state is zero subprocesses. Safe to call on mount and whenever
 * the project list changes.
 *
 * Sequential, not `Promise.all`. This runs at startup alongside everything else the shell is doing,
 * and a user with 15 projects would otherwise fan out 15 git subprocesses in one tick. The answer is
 * not needed urgently — until it lands, identity falls back to path, which is what the app did
 * before.
 */
export async function backfillRepoKeys(): Promise<void> {
  const store = useProjectStore.getState();
  const todo = store.projects.filter(needsKey);
  for (const p of todo) {
    const key = await repoKeyFor(p.rootPath);
    // Re-read the setter each iteration: the project may have been removed while we awaited, and
    // the store's own guard drops a write for a project that no longer exists.
    useProjectStore.getState().setProjectRepoKey(p.id, key);
  }
}

/**
 * Resolve and record the repo key for ONE project — used right after a project is added, so the
 * very next open can compare on repo identity instead of waiting for a sweep.
 */
export async function resolveRepoKeyFor(projectId: string): Promise<string | null> {
  const p = useProjectStore.getState().projects.find((x) => x.id === projectId);
  if (!p) return null;
  const key = await repoKeyFor(p.rootPath);
  useProjectStore.getState().setProjectRepoKey(projectId, key);
  return key;
}
