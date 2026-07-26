// Which projects the user has actually TOUCHED this session.
//
// The single-window shell (CM-U7) put every project in the store behind a tab, which cost us the
// old meaning of "open": a window used to hold exactly one project, so the window registry answered
// it. `projects` is the full persisted list — everything ever added, everything in Recent — and
// treating that as "open" leaked never-opened projects (and their prompt snippets) into the tray
// and the phone relay, and made the payload grow without bound.
//
// So the shell records the tabs it has selected. The set only ever GROWS within a session and is
// NOT persisted: it means "you looked at this since launch", which is exactly the honest reading of
// open for a shell where a tab exists for everything. Module-level (not React state) because two
// unrelated consumers need it — Workspace's lazy pane mounting and App's roster publisher — and
// they must agree.

const visited = new Set<string>();
const listeners = new Set<() => void>();
// Bumped on every real change so `useSyncExternalStore`-style consumers can take a cheap snapshot
// without materializing (or diffing) the set.
let version = 0;

/** Tell every subscriber the set moved. A listener's failure must never break the caller (a tab
 *  selection, or a test's reset) — nor starve the listeners after it. */
function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // Swallowed by design; see above.
    }
  }
}

/** Record that this project's tab has been selected. Idempotent; notifies only on a real change. */
export function markProjectVisited(projectId: string | null | undefined): void {
  if (!projectId || visited.has(projectId)) return;
  visited.add(projectId);
  version += 1;
  notify();
}

/** True when this project has been selected at least once this session. */
export function wasProjectVisited(projectId: string): boolean {
  return visited.has(projectId);
}

/** A monotonically increasing token that changes whenever the visited set grows. */
export function visitedProjectsVersion(): number {
  return version;
}

/** Subscribe to growth of the visited set. Returns an unsubscribe fn. */
export function onVisitedProjectsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Tests only: forget everything (module state outlives a component tree). Notifies, like every
 *  other writer — a mounted `useSyncExternalStore` consumer that isn't told keeps rendering the
 *  pre-reset snapshot until some unrelated re-render happens to correct it (roborev 46485-L). */
export function resetVisitedProjects(): void {
  visited.clear();
  version += 1;
  notify();
}
