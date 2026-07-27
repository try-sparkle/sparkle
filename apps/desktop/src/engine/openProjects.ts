// "Which projects have a TAB?" — the pure rules behind closable project tabs.
//
// Before this, the tab bar rendered EVERY project the store had ever heard of, so the bar only ever
// grew: try a repo once and its tab is with you forever, with no affordance to make it go away.
// "Exists in the project store" and "is open right now" are different facts, and this module is the
// second one.
//
// The open set is a persisted list of ids (uiStore.openProjectIds), deliberately NULLABLE:
//
//   • `null`  — nothing has ever written the set. That is EVERY user upgrading into this change, and
//               it must mean "every project is open", or the upgrade would silently blank the tab
//               bar of anyone who never clicks "+". The first open/close seeds a real array.
//   • `[]`    — the user closed the last tab. Distinct from `null` on purpose: an empty array is a
//               decision the app must honour (blank tab bar + the "+" onboarding hint), whereas
//               `null` is the absence of one.
//
// Closing is a VIEW operation, never a lifecycle one: a closed project keeps its store record, its
// agents, and — because Workspace mounts panes from `projects` × the visited set × `openAgentIds`,
// none of which this touches — its live PTYs. See services/projectTabs.ts for the wiring.
//
// Pure (no store, no React) so every rule below is unit-testable on its own.

/** The nullable persisted open set. `null` = never seeded → every project counts as open. */
export type OpenProjectIds = readonly string[] | null;

/** Is this project's tab showing? A `null` set predates the feature and opens everything. */
export function isProjectOpen(projectId: string, openIds: OpenProjectIds): boolean {
  return openIds === null || openIds.includes(projectId);
}

/**
 * The projects that get a tab, in the SAME order `projects` gives them. Ordering deliberately stays
 * the project store's, not the open set's: the tab strip's left-to-right reading is a property of
 * the project list (and its recency bumps), and re-deriving it from open/close order would make
 * tabs jump around every time one was closed and reopened.
 */
export function openProjectsOf<T extends { id: string }>(
  projects: readonly T[],
  openIds: OpenProjectIds,
): T[] {
  return openIds === null ? [...projects] : projects.filter((p) => openIds.includes(p.id));
}

/** The complement — projects that exist but have no tab. Feeds the "+" dialog's reopen list. */
export function closedProjectsOf<T extends { id: string }>(
  projects: readonly T[],
  openIds: OpenProjectIds,
): T[] {
  return openIds === null ? [] : projects.filter((p) => !openIds.includes(p.id));
}

/**
 * Seed the open set the first time it is written. A `null` set means "everything was open", so the
 * seed has to be every id — writing `[projectId]` instead would close every OTHER tab as a side
 * effect of opening one, which is the one thing an open must never do.
 */
export function seedOpenIds(allProjectIds: readonly string[], openIds: OpenProjectIds): string[] {
  return openIds === null ? [...allProjectIds] : [...openIds];
}

/**
 * Mark `projectId` open. Idempotent, and appends (rather than reordering) so reopening a project
 * doesn't shuffle the tabs that were already there.
 */
export function withProjectOpen(
  projectId: string,
  allProjectIds: readonly string[],
  openIds: OpenProjectIds,
): string[] {
  const seeded = seedOpenIds(allProjectIds, openIds);
  return seeded.includes(projectId) ? seeded : [...seeded, projectId];
}

/** Mark `projectId` closed. Idempotent; always returns a real array (never `null`). */
export function withProjectClosed(
  projectId: string,
  allProjectIds: readonly string[],
  openIds: OpenProjectIds,
): string[] {
  return seedOpenIds(allProjectIds, openIds).filter((id) => id !== projectId);
}

/**
 * Where the selection lands after `closingId`'s tab goes away.
 *
 * `openOrdered` is the tab strip AS DISPLAYED (openProjectsOf's output), because "sensible
 * neighbour" is a statement about what the user is looking at, not about persisted set order.
 *
 * Rules, in order:
 *   • closing a tab that isn't selected changes nothing — unless the selection is itself dangling,
 *     in which case we repair it rather than leave the shell pointed at no tab;
 *   • closing the SELECTED tab takes the one to its RIGHT (the tab that slides into the vacated
 *     slot, matching every browser), falling back to the one on its LEFT when it was the last tab;
 *   • closing the ONLY tab returns null — the app drops to its "Welcome to Sparkle / open a project
 *     with +" state, which is a real state it already renders, not a blank shell.
 */
export function selectionAfterClose(
  openOrdered: readonly string[],
  closingId: string,
  selectedId: string | null,
): string | null {
  const idx = openOrdered.indexOf(closingId);
  const remaining = openOrdered.filter((id) => id !== closingId);
  if (selectedId !== closingId) {
    // Untouched selection, provided it still names a visible tab. A selection that doesn't (a stale
    // persisted id, a project closed in another webview) is repaired to the first remaining tab —
    // the same repair the boot selection makes.
    if (selectedId !== null && remaining.includes(selectedId)) return selectedId;
    return remaining[0] ?? null;
  }
  if (idx < 0) return remaining[0] ?? null; // selected id wasn't in the strip at all
  return remaining[idx] ?? remaining[idx - 1] ?? null;
}

/**
 * The project the app should land on at boot: the persisted selection when it names an OPEN
 * project, else the first open one, else null. Closed projects are deliberately not eligible —
 * selecting one would leave the shell showing a project with no tab, the exact incoherence the
 * open set exists to prevent.
 */
export function bootSelection(
  allProjectIds: readonly string[],
  openIds: OpenProjectIds,
  selectedId: string | null,
): string | null {
  const open = allProjectIds.filter((id) => isProjectOpen(id, openIds));
  if (selectedId !== null && open.includes(selectedId)) return selectedId;
  return open[0] ?? null;
}
