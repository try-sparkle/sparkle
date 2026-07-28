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
import { bandOfStatus } from "./buildSections";
import type { AgentKind, AgentTabStatus } from "../types";

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

/** RED workers per orchestrator id — the same shape and the same explicit-zero discipline as
 *  {@link workerCounts}, and for the same reason: {@link expandOnRedWorker} reads a missing id as
 *  "never observed" and skips it, so a parent omitted while calm would have its FIRST red worker
 *  classified as a first sighting and stay folded — the one case the expansion exists for.
 *
 *  "Red" here is the DOT color (waiting | approval | blocked | errored), asked via `bandOfStatus`
 *  so this can't drift from the taxonomy. Deliberately not `needsAttention`, which excludes
 *  `blocked` — reaching for it in this exact situation is the bug that shipped twice. */
export function redWorkerCounts<T extends { id: string; kind: AgentKind; parentId: string | null }>(
  agents: readonly T[],
  statusOf: (id: string) => AgentTabStatus,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of agents) {
    if (a.kind === "build") out[a.id] = 0;
  }
  for (const a of agents) {
    if (a.kind !== "worker" || !a.parentId) continue;
    if (bandOfStatus(statusOf(a.id)) !== "needs_you") continue;
    out[a.parentId] = (out[a.parentId] ?? 0) + 1;
  }
  return out;
}

/** The orchestrator ids whose subtree just went from NO red workers to at least one, and so should
 *  pop open to show the worker that needs you.
 *
 *  Fires on the TRANSITION, exactly once, and never again while the worker stays red. That is the
 *  whole design: a subtree the user deliberately folded after seeing the problem must stay folded,
 *  or the control fights them every render for as long as the agent is stuck. What keeps the signal
 *  alive afterwards is the head's own disc, which rolls its workers up (engine/workerRollup) and
 *  goes red or orange regardless of the fold.
 *
 *  Ids absent from `prev` are skipped for the same reason as `expandOnGrowth`: on boot the previous
 *  snapshot is empty, so every parent with an already-red worker would look like a fresh
 *  transition, blowing open every such subtree on every relaunch and making the persisted collapse
 *  choice worthless. */
export function expandOnRedWorker(
  prev: Record<string, number>,
  next: Record<string, number>,
): string[] {
  const turned: string[] = [];
  for (const [id, count] of Object.entries(next)) {
    const before = prev[id];
    if (before === undefined) continue; // first sighting is a baseline, not a transition
    if (before === 0 && count > 0) turned.push(id);
  }
  return turned;
}
