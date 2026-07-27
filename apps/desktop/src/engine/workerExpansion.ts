// When an orchestrator's worker subtree should pop open on its own.
//
// `uiStore.collapsedOrchestrators` treats a MISSING entry as collapsed, so a freshly-spawned worker
// would land in a subtree nobody can see — the spawn would look like it did nothing. The rule is
// "expand a parent the moment it gains a worker", and it has to be derived from a COMPARISON rather
// than from a spawn callback: workers also arrive from reconcileWorkersFromDisk and from a
// cross-window adopt, and those paths never run through spawnWorker.
//
// The subtlety that makes this a module instead of an inline `>` is first observation. On boot the
// previous snapshot is empty, so every parent looks like it gained its workers — expanding all of
// them and making the persisted collapse choice worthless on every relaunch. An id absent from the
// previous snapshot is therefore a BASELINE, never growth.
import type { AgentKind } from "../types";

/** Worker count per orchestrator id.
 *
 *  EVERY build agent gets an entry, explicitly `0` when it has no workers. That zero is the load-
 *  bearing part, not noise: `expandOnGrowth` reads a MISSING id as "never observed" and skips it, so
 *  if childless parents were omitted, an orchestrator's FIRST worker would arrive against an absent
 *  baseline and be classified as a first sighting rather than growth. The subtree would stay
 *  collapsed for the one spawn that most needs to be seen, and only the second worker onward would
 *  expand. (That was the first cut of this module — roborev 53672.)
 *
 *  Only `kind: "worker"` children are COUNTED: they are the only agents that render as child rows,
 *  so counting anything else would expand a parent for a row the subtree never shows. */
export function workerCounts<T extends { id: string; kind: AgentKind; parentId: string | null }>(
  agents: readonly T[],
): Record<string, number> {
  const out: Record<string, number> = {};
  // Two passes: a build agent can appear after its own worker in the array (disk reconcile adopts
  // in no guaranteed order), and seeding in one pass would let `out[parent] = 0` clobber a count
  // already accumulated for it.
  for (const a of agents) {
    if (a.kind === "build") out[a.id] = 0;
  }
  for (const a of agents) {
    if (a.kind !== "worker" || !a.parentId) continue;
    out[a.parentId] = (out[a.parentId] ?? 0) + 1;
  }
  return out;
}

/** The orchestrator ids that just GAINED a worker, and so should be expanded.
 *
 *  Growth only — a spin-down (count falling) leaves the user's collapse choice alone, and so does a
 *  steady count, so a collapsed orchestrator stays collapsed while it churns. Ids not present in
 *  `prev` are skipped: see the note above about boot. */
export function expandOnGrowth(
  prev: Record<string, number>,
  next: Record<string, number>,
): string[] {
  const grown: string[] = [];
  for (const [id, count] of Object.entries(next)) {
    const before = prev[id];
    if (before === undefined) continue; // first sighting is a baseline, not growth
    if (count > before) grown.push(id);
  }
  return grown;
}
