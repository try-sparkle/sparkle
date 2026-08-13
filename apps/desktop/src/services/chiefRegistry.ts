// THE PROJECT CATALOG — a TTL cache over Chief's `list_projects`, plus the one function that turns a
// Sparkle project's binding into the `ChiefCaller` the access-control layer judges (bead
// `sparkle-8rr0c`).
//
// WHY A CACHE AT ALL: the token reaches 348 projects, and every scope decision in `chiefScope.ts`
// needs the catalog — name resolution, refusal messages that list what IS reachable, the
// "is this id real" check. Fetching 348 rows per tool call is the obvious waste; caching them
// FOREVER is the less obvious one, because a project created in Chief a minute ago would then be
// invisible until the app restarts. Five minutes is the compromise, and `force` exists for the
// moment a user has just made a project and is looking for it.
//
// WHY IT IS NOT PERSISTED: one call refills it. Writing 348 rows of somebody's live client work to
// disk buys a few hundred milliseconds at first use and creates a staleness problem — and a
// deleted-in-Chief project surviving on disk is exactly the "silently serve the wrong project"
// failure this feature exists to prevent.
//
// THE CLIENT IS INJECTED, never reached for. A `deps = realClient` default written at the call site
// leaves the production line covered by nothing — delete it and the suite stays green (bead
// `sparkle-lgbwf`, and the note on `ChiefClient` in chiefScope.ts says the same). The CLOCK is
// injected for the same reason and in the same object: TTL behaviour is only testable if the test
// controls time, and a real clock makes the expiry test either slow or flaky.

import type { ChiefCaller, ChiefClient, ChiefProject } from "./chiefScope";

/** Five minutes. Long enough that a burst of tool calls costs one fetch; short enough that a
 *  project created in Chief shows up without restarting Sparkle. */
export const CHIEF_CATALOG_TTL_MS = 5 * 60_000;

/** The binding fields as they sit on `Project` (types.ts). Taken structurally so the registry does
 *  not depend on the whole `Project` shape — and so a test can pass the two fields that matter. */
export interface ChiefBinding {
  chiefProjectIds?: string[];
  chiefPrimaryId?: string | null;
  name?: string;
}

export interface ChiefRegistry {
  /** The catalog, from cache when it is fresh. `force` refetches and reseeds. */
  listProjects(force?: boolean): Promise<ChiefProject[]>;
  /** Drop the cache — call after creating or deleting a Chief project. */
  invalidate(): void;
}

export interface ChiefRegistryOptions {
  ttlMs?: number;
  /** Injected clock (see header). Defaults to `Date.now`. */
  now?: () => number;
}

export function createChiefRegistry(
  client: ChiefClient,
  opts: ChiefRegistryOptions = {},
): ChiefRegistry {
  const ttlMs = opts.ttlMs ?? CHIEF_CATALOG_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  let cached: ChiefProject[] | null = null;
  let fetchedAt = 0;
  /** In-flight de-dupe: a burst of tool calls on a cold cache must issue ONE `list_projects`, not
   *  one per caller. Without this the cache only helps AFTER the first fetch settles. */
  let inflight: Promise<ChiefProject[]> | null = null;
  /**
   * WHICH ANSWERS ARE STILL WANTED. Bumped by `force` and by `invalidate()` — the two statements of
   * "what is in flight is now known to be out of date" — and captured when a fetch starts, so a
   * fetch that resolves after one of them cannot write its rows.
   *
   * The bug this exists for: call A (no `force`) starts; the user creates a Chief project and the UI
   * calls `listProjects(true)`; B fetches and caches the NEW rows; then A resolves with the
   * PRE-CREATION rows and unconditionally does `cached = rows; fetchedAt = now()`. The catalog
   * reverts to the stale set AND is stamped fresh, so the project the user just made stays invisible
   * for another five minutes — the exact outcome `force` exists to prevent. `invalidate()` had the
   * same hole in the other direction: a fetch begun before it repopulated the cache after it.
   */
  let generation = 0;

  return {
    async listProjects(force = false): Promise<ChiefProject[]> {
      if (!force && cached && now() - fetchedAt < ttlMs) return cached;
      if (!force && inflight) return inflight;
      // A FAILED refresh is REPORTED, never swallowed into an empty catalog: `[]` would turn every
      // scope decision into "unknown_project", which reads to the user as "your projects are gone".
      // `cached` is assigned only on success, so a failure cannot overwrite it — and those surviving
      // rows ARE observable, through the `force` path: a forced refresh skips both cache checks
      // above, so when it fails it leaves `cached` AND `fetchedAt` untouched and the next ordinary
      // call, still inside the TTL, is served the retained catalog. That is the scenario `force` is
      // for (the user just created a project) and it is pinned in chiefRegistry.test.ts with a
      // FROZEN clock, so a refetch cannot masquerade as the surviving cache. Serving stale rows
      // after a TTL-expiry failure would be a different, deliberately unmade, behaviour change — a
      // silently stale catalog hides a real outage.
      if (force) generation += 1;
      const gen = generation;
      const mine = (async () => {
        const rows = await client.listProjects();
        // Only if nothing has invalidated or forced past us while this was in flight.
        if (gen === generation) {
          cached = rows;
          fetchedAt = now();
        }
        return rows;
      })();
      inflight = mine;
      try {
        return await mine;
      } finally {
        // ONLY the promise this call published. Clearing unconditionally lets an earlier call wipe a
        // LATER one's slot, and the de-dupe then silently stops covering everyone who arrives after.
        if (inflight === mine) inflight = null;
      }
    },
    invalidate(): void {
      cached = null;
      fetchedAt = 0;
      generation += 1;
      // AND THE DE-DUPE SLOT, not just the cache. Bumping `generation` stops an in-flight fetch from
      // WRITING pre-invalidation rows, but leaving its promise here still HANDS them to anyone who
      // arrives in the window before it settles (`if (!force && inflight) return inflight`) — so the
      // project the user just deleted is still in the catalog their next scope decision reads, which
      // is the one thing this call exists to prevent. The `inflight === mine` guard below makes
      // dropping it safe: that fetch simply no longer clears a slot it no longer owns.
      inflight = null;
    },
  };
}

/**
 * A Sparkle project's binding → the `ChiefCaller` that `resolveChiefProject` judges.
 *
 * ABSENT OR EMPTY IS A REFUSAL, NEVER A FALLBACK. An agent whose project carries no
 * `chiefProjectIds` gets `allowed: []`, which `chiefScope` turns into an "unbound" refusal naming
 * what to do about it. Defaulting it to Chief's own `default: true` project, or to the first of the
 * 348, is the failure this whole feature exists to prevent.
 *
 * The concierge is `allowed: "all"` by definition of the founder's rule (concierge reaches
 * everything, a build agent reaches only its scope) — but it still takes its DEFAULT from the
 * project binding when there is one, so "chat about this project" means the right project without
 * the human re-naming it every turn.
 *
 * The `primary` handling has one deliberate asymmetry. With a non-empty `allowed`, an inconsistent
 * primary is passed THROUGH so `resolveChiefProject` can refuse it as a store-consistency bug —
 * silently dropping it would hide a real binding defect. With an EMPTY `allowed`, a leftover primary
 * is dropped, because "unbound" is the honest description of that state and it produces the refusal
 * that tells the human to bind a project.
 */
export function chiefCallerFor(
  kind: "concierge" | "agent",
  project: ChiefBinding | null | undefined,
  agentId?: string,
): ChiefCaller {
  const allowedIds = (project?.chiefProjectIds ?? []).filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0,
  );
  const rawPrimary = project?.chiefPrimaryId?.trim() ? project.chiefPrimaryId.trim() : null;

  if (kind === "concierge") {
    return {
      kind,
      allowed: "all",
      primary: rawPrimary,
      sparkleProjectName: project?.name,
    };
  }
  return {
    kind,
    agentId,
    allowed: allowedIds,
    primary: allowedIds.length === 0 ? null : rawPrimary,
    sparkleProjectName: project?.name,
  };
}

/** Is this Sparkle project bound to any Chief project at all? The UI's "unbound" affordance and the
 *  refusal path must agree on one definition of bound, so both read this. */
export function isChiefBound(project: ChiefBinding | null | undefined): boolean {
  return (project?.chiefProjectIds ?? []).some((id) => typeof id === "string" && id.trim().length > 0);
}
