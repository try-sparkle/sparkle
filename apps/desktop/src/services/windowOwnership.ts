// "Which window handles this?" — the single-owner election for app-wide broadcast events.
//
// Tauri's `app.emit(...)` / `emit(...)` delivers to EVERY open webview, but several of our events
// carry a request that must be serviced exactly ONCE: a capture://send that opens a composer, an
// orchestration:request that destroys a worker tab. Every window holds the same persisted
// projectStore, so every window passes any "do I know this project?" test — per-window module state
// (queues, in-flight counters, claims) therefore cannot bound the fan-out, because each window has
// its own independent copy of it.
//
// The election keys off the window REGISTRY (windowRegistry: label -> displayed project id), which
// is already the app's authority for "who shows what". For a given project id at most one label
// answers `true`, and main adopts anything unowned — so the pair of guarantees is at-most-one AND
// at-least-one handler.
//
// This logic was written for and proven by the capture://send route (spec §9); it is factored out
// here so other broadcast request channels get the same guarantees rather than a second
// almost-identical copy. captureSends re-exports its own named wrappers over these.

export interface WindowRouteDeps {
  /** This window's opaque label ("main" for the initial window). */
  myLabel: string;
  isMain: boolean;
  /** Registry lookup: which window (label) currently shows this project, or null. */
  findWindowForProject: (projectId: string) => string | null;
}

/** Should THIS window handle a request targeting `projectId`? Pure — at most one window across the
 *  app answers true: the registered owner, or main when no window owns the project.
 *  Caveat: a registry entry can be stale after a hard crash (unload cleanup skipped), leaving
 *  a dead label as owner and zero live handlers — `shouldHandleInThisWindow` closes that hole. */
export function routeToOwningWindow(projectId: string, deps: WindowRouteDeps): boolean {
  const owner = deps.findWindowForProject(projectId);
  if (owner === null) return deps.isMain;
  return owner === deps.myLabel;
}

export interface WindowDispatchDeps extends WindowRouteDeps {
  /** Does a window with this label actually exist right now? (WebviewWindow.getByLabel-backed.) */
  isWindowAlive: (label: string) => Promise<boolean>;
  /** Drop a stale registry entry (crash skipped the owner's cleanup). */
  evictWindow: (label: string) => void;
}

/** The dispatch-layer decision: routeToOwningWindow, plus main's stale-owner self-heal. When the
 *  registry names an owner but that window no longer exists (hard crash — the registry's own
 *  docs acknowledge stale entries outlive windows), main evicts the dead label and adopts the
 *  request as orphaned, so it is never silently dropped by every window. Mirrors
 *  openProjectInWindow's stale-entry eviction. Non-main windows never fall back, preserving
 *  the at-most-one-handler guarantee.
 *
 *  Re-resolves after each eviction (roborev 25170/25171): a crash + "Replace" can leave two
 *  labels mapped to one project (`{win-dead, win-alive}`); if the dead label resolves first,
 *  main evicts it and looks again rather than adopting — the LIVE replacement window is the real
 *  owner and handles it, so main only adopts when NO live owner remains. A liveness probe that
 *  rejects (IPC hiccup / window mid-teardown) is treated as ALIVE: the resolved owner already
 *  answered true via routeToOwningWindow in its own window, so assuming-dead here would risk a
 *  double dispatch — staying out is the at-most-one-handler-preserving default. */
export async function shouldHandleInThisWindow(
  projectId: string,
  deps: WindowDispatchDeps,
): Promise<boolean> {
  if (routeToOwningWindow(projectId, deps)) return true;
  if (!deps.isMain) return false;
  let owner = deps.findWindowForProject(projectId);
  while (owner !== null) {
    if (owner === deps.myLabel) return true; // a re-resolution surfaced us as the owner
    let alive: boolean;
    try {
      alive = await deps.isWindowAlive(owner);
    } catch {
      alive = true; // inconclusive probe → assume alive, main stays out
    }
    if (alive) return false; // a live owner exists — it handles the request, not main
    deps.evictWindow(owner);
    owner = deps.findWindowForProject(projectId);
  }
  return true; // no owner remains — main adopts the orphan
}
