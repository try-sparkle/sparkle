// SINGLE-WINDOW SHELL (bead sparkle-qd80 / CM-U7 part 2). The multi-window era's per-window
// React context is gone: there is one app window, its current project is
// `projectStore.selectedProjectId` (driven by the project tabs), and its identity is constant.
// The hooks keep their original names because they still answer the same questions — the answers
// are just global now. `AppBoot` carries the two boot-time jobs the old provider did (cold-start
// hygiene + boot selection/deep-link landing) without providing any context.
import { useEffect, useMemo, type ReactNode } from "react";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useDictationStore } from "./stores/dictationStore";
import { setWindowProject, clearWindowProject, resetWindowRegistry } from "./services/windowRegistry";
import { resetWindowStatus } from "./services/windowStatus";
import { parseAgentIdFromSearch, parseProjectIdFromSearch } from "./services/windowIdentity";

/** The one window's fixed label. Kept exported for the persistence keys (per-window Sparkle agent
 *  id, roster publishing) that were keyed by label and must not change across the purge. */
export const APP_WINDOW_LABEL = "main";

/** The multi-window era's per-window session snapshot. Its module (services/windowSession) is gone;
 *  the key is named here only so AppBoot can clear the orphaned blob. Delete with that cleanup. */
const LEGACY_WINDOW_SESSION_KEY = "sparkle-window-session";

/** Deep-link: a `?agent=` param (notification hand-off from a cold start) selects + mounts that
 *  agent once its project is present. A closed/unknown agent id is silently ignored. */
function openDeepLinkAgent(projectId: string, agentId: string | null): void {
  if (!agentId) return;
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  if (!project?.agents.some((a) => a.id === agentId)) return;
  useRuntimeStore.getState().open(agentId);
  useProjectStore.getState().selectAgent(projectId, agentId);
}

/**
 * Boot-time effects for the single window (mounted once from App, wraps nothing):
 *  - cold-start hygiene: the window registry / cross-webview status maps persist in localStorage
 *    and outlive the process, so stale entries are wiped; a persisted "active" mic phase resets;
 *  - boot selection: adopt a `?project=` deep link, else keep a valid persisted selection, else
 *    the first project — tolerating a store that hydrates a tick after mount;
 *  - the `?agent=` deep link landing.
 */
export function AppBoot({ children }: { children: ReactNode }) {
  useEffect(() => {
    resetWindowRegistry();
    // One-time cleanups: the multi-window era left two durable blobs with no writer and no reader
    // since CM-U7 part 2 — the per-window status channel (resetWindowStatus, which sweeps its own
    // keys) and the per-window session snapshot below. Both can go a release or two from now.
    resetWindowStatus();
    try {
      localStorage.removeItem(LEGACY_WINDOW_SESSION_KEY);
    } catch {
      // best-effort
    }
    // The mic's active/paused `phase` is persisted, so it survives a relaunch. Reset a stale
    // "active" back to "passive" on a cold start. Must run AFTER the store hydrates, or the
    // persisted value would overwrite the reset.
    const resetMicPhase = () => useDictationStore.getState().setPhase("passive");
    if (useDictationStore.persist.hasHydrated()) return void resetMicPhase();
    return useDictationStore.persist.onFinishHydration(resetMicPhase);
  }, []);

  // Boot selection. Resolve ONCE against the hydrated store, then stop — so this can never fight
  // a later tab click. zustand's `persist` can apply the localStorage snapshot a microtask AFTER
  // mount even with synchronous storage, so a first pass that finds nothing subscribes and
  // retries until the projects land.
  useEffect(() => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    const paramProjectId = parseProjectIdFromSearch(search);
    const paramAgentId = parseAgentIdFromSearch(search);
    let unsub: (() => void) | null = null;
    const resolve = (): boolean => {
      const st = useProjectStore.getState();
      if (st.projects.length === 0) return false;
      const has = (id: string | null) => !!id && st.projects.some((p) => p.id === id);
      const target = has(paramProjectId)
        ? paramProjectId
        : has(st.selectedProjectId)
          ? st.selectedProjectId
          : (st.projects[0]?.id ?? null);
      if (!target) return false;
      // Detach BEFORE writing: the writes below are store `set`s that would re-enter this
      // subscription and recurse.
      unsub?.();
      unsub = null;
      // setSelectedProject, not selectProject: adopting a tab at boot must not rewrite recency.
      if (st.selectedProjectId !== target) st.setSelectedProject(target);
      openDeepLinkAgent(target, paramAgentId);
      return true;
    };
    if (resolve()) return;
    unsub = useProjectStore.subscribe(() => resolve());
    return () => unsub?.();
  }, []);

  // Keep the (single-entry) window registry pointing at the selected project, so the surfaces
  // that still ask "which window owns this project?" — the capture hand-off — stay truthful.
  const projectId = useProjectStore((s) => s.selectedProjectId);
  useEffect(() => {
    if (projectId) setWindowProject(APP_WINDOW_LABEL, projectId);
    else clearWindowProject(APP_WINDOW_LABEL);
  }, [projectId]);

  return <>{children}</>;
}

/** The project the app is showing — the selected TAB. Reads the store directly, so any leaf can
 *  call it without a provider. */
export const useCurrentProjectId = (): string | null =>
  useProjectStore((s) => s.selectedProjectId);

/** One window: it is always the main window. Constant, kept for call-site continuity. */
export const useIsMainWindow = (): boolean => true;
export const useCurrentWindowLabel = (): string => APP_WINDOW_LABEL;

/** Legacy seam: "show this project instead". Now simply selects its tab. */
export const useReplaceCurrentProject = (): ((id: string | null) => void) => {
  return useMemo(
    () => (id: string | null) => {
      const st = useProjectStore.getState();
      if (id) st.selectProject(id);
      else st.setSelectedProject(null);
    },
    [],
  );
};
