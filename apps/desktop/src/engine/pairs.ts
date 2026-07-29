// "Which pair does this project live in?" — the pure rules behind the SECOND pair.
//
// The cockpit's full form is `TERM │ BUILD │ CONCIERGE │ BUILD │ TERM`. The app shipped the right
// half of it; this module is what makes the left half real. `Workspace` renders the geometry and
// `ProjectTabsBar` renders the tabs, but every rule about ownership lives here, pure, so it can be
// tested without a DOM — the same split `engine/cable.ts` uses for `data-wired`.
//
// THE ONE INVARIANT, and the reason this is a module rather than two `useState`s:
//
//     A project's panes are mounted in EXACTLY ONE stage.
//
// Not zero (its terminals would be dead while its tab still claimed to be open) and never two. Two
// is the expensive one: `Terminal.tsx` spawns a PTY per mount, so the same agent id mounted in both
// stages puts two xterms on one PTY and `pty_spawn`'s `sessions.insert` orphans one of the child
// processes. That is the identical failure the tear-off ownership map exists to prevent
// (services/satelliteWindows), and the reason `Workspace` partitions its `live` list through
// `sideOf` rather than rendering the same list twice.
//
// WHAT MOVING A PROJECT BETWEEN PAIRS COSTS, stated plainly because it looks alarming and is not:
// re-assigning a project unmounts its panes on one side and mounts them on the other, and a
// Terminal unmount KILLS its PTY — so its agents respawn (`claude --resume`) and lose scrollback.
// That is exactly what tearing a project out to its own window already does, where the code calls
// it "the user loses a respawn, not the project". It is a real cost, it is survivable, and it is
// precedented; what is NOT survivable is the double mount above. So this module makes moving
// possible and makes double-mounting unrepresentable.

import type { PairCount, PairSide } from "./cable";

export type { PairCount, PairSide };

/**
 * Which side owns each project. ABSENT MEANS RIGHT, deliberately.
 *
 * The map is sparse and only ever names left-assigned projects, which makes the upgrade path free:
 * every existing install has no map, reads as "everything on the right", and renders exactly the
 * single-pair layout it had. It also means the empty map and "no left pair" are the same state, so
 * there is no way to persist a left pair that has nothing in it.
 */
export type PairAssignment = Readonly<Record<string, PairSide>>;

/** The side that owns `projectId`. Unassigned → `"right"`, the historical single-pair home. */
export function sideOf(assignment: PairAssignment, projectId: string): PairSide {
  return assignment[projectId] === "left" ? "left" : "right";
}

/**
 * The projects belonging to `side`, in the SAME order `projects` gives them.
 *
 * Ordering stays the project store's for the reason `openProjectsOf` gives: the strip's
 * left-to-right reading is a property of the project list, and re-deriving it from assignment order
 * would make tabs jump whenever one moved sides and back.
 */
export function projectsOnSide<T extends { id: string }>(
  projects: readonly T[],
  assignment: PairAssignment,
  side: PairSide,
): T[] {
  return projects.filter((p) => sideOf(assignment, p.id) === side);
}

/**
 * How many pairs flank the concierge — `data-pairs` on the shell root.
 *
 * DERIVED, never stored. A stored count could disagree with the assignment map (a left pair with
 * nothing in it, or a left-assigned project with no pair to render it), and every such disagreement
 * is a project whose panes have nowhere to mount. Deriving it makes that unrepresentable.
 *
 * Note this counts ASSIGNMENT, not open tabs: a left-assigned project whose tab is closed still
 * holds the left pair open, because closing a tab is a view operation that deliberately keeps the
 * project's panes and PTYs alive (engine/openProjects). Collapsing the pair under it would unmount
 * them — the exact cost this module exists to control.
 */
export function pairCountFor(projects: readonly { id: string }[], assignment: PairAssignment): PairCount {
  return projects.some((p) => sideOf(assignment, p.id) === "left") ? 2 : 1;
}

/** The other side. */
export function otherSide(side: PairSide): PairSide {
  return side === "left" ? "right" : "left";
}

/**
 * Move a project to `side`, returning a NEW assignment (or the same object when nothing changes).
 *
 * Returning the identical object for a no-op keeps zustand's shallow equality meaningful, exactly
 * as `engine/cable.ts`'s reducers do: re-assigning a project to the side it is already on must not
 * re-render the shell, and — far more important here — must not churn the `live` partition and
 * remount panes that never moved.
 */
export function assignToSide(
  assignment: PairAssignment,
  projectId: string,
  side: PairSide,
): PairAssignment {
  if (sideOf(assignment, projectId) === side) return assignment;
  const next = { ...assignment };
  // Right is the absence of an entry, not an entry saying "right" — see PairAssignment. Writing
  // `right` explicitly would work but would let the map grow without bound and would make the
  // "empty map == no left pair" identity false.
  if (side === "right") delete next[projectId];
  else next[projectId] = "left";
  return next;
}

/**
 * Drop assignments for projects that no longer exist.
 *
 * Called when the project list changes. Without it a removed project's entry keeps `pairCountFor`
 * returning 2 forever, leaving an empty left pair on screen with no tab in it and no way to close
 * it — the pair equivalent of the stale-tab problem `openProjects` was written for.
 *
 * Returns the same object when there is nothing to prune, for the equality reason above.
 */
export function pruneAssignment(
  assignment: PairAssignment,
  projects: readonly { id: string }[],
): PairAssignment {
  const alive = new Set(projects.map((p) => p.id));
  const stale = Object.keys(assignment).filter((id) => !alive.has(id));
  if (stale.length === 0) return assignment;
  const next = { ...assignment };
  for (const id of stale) delete next[id];
  return next;
}

/**
 * Resolve a side's selected project id against what that side actually holds.
 *
 * A selection is only valid while it names a project ON THAT SIDE. Three ways it stops being:
 * the project moved sides, its tab was closed, or it was removed outright. In each case the side
 * falls back to its first project rather than rendering a sidebar for a project the other pair is
 * showing — which would put two build columns on the same project and, worse, invite a click that
 * selects an agent whose pane is mounted in the other stage.
 *
 * `null` when the side holds nothing: that is a real state (the left pair before anything is sent
 * to it) and the caller renders an empty pair for it, rather than a wrong one.
 */
export function resolveSideSelection(
  selectedId: string | null,
  sideProjects: readonly { id: string }[],
): string | null {
  if (selectedId !== null && sideProjects.some((p) => p.id === selectedId)) return selectedId;
  return sideProjects[0]?.id ?? null;
}
