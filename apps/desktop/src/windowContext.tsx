import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  computeInitialProjectId,
  parseAgentIdFromSearch,
  parseProjectIdFromSearch,
  parseWindowLabelFromSearch,
} from "./services/projectWindows.url";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import {
  setWindowProject,
  clearWindowProject,
  resetWindowRegistry,
} from "./services/windowRegistry";
import { resetWindowStatus } from "./services/windowStatus";

interface Ctx {
  projectId: string | null;
  isMain: boolean;
  label: string;
  replace: (id: string | null) => void;
}

const CurrentProjectContext = createContext<Ctx | null>(null);

/** Deep-link: a window opened from a history-search "jump to agent" carries `?agent=`. Once the
 *  window is on its project, select + mount that agent so it lands directly on it. A closed/unknown
 *  agent id is silently ignored (the search row itself reports "closed"). Shared so BOTH the fast
 *  path (project resolved at mount) and the late-hydration recovery below run it — otherwise a
 *  jump-to-agent window that hydrates late would adopt its project but never open the agent. */
function openDeepLinkAgent(projectId: string, agentId: string | null): void {
  if (!agentId) return;
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  if (!project?.agents.some((a) => a.id === agentId)) return;
  useRuntimeStore.getState().open(agentId);
  useProjectStore.getState().selectAgent(projectId, agentId);
}

/**
 * Supplies "this window's current project." A window's OPAQUE label comes from the `?label=`
 * URL param (the initial window has none → "main"); its initial project from `?project=` or
 * the restore hint. Replace swaps the project in place — the label never changes, so other
 * windows find/focus this one purely via the registry (label↔project lookup), never by
 * deriving a label from the project id.
 */
export function CurrentProjectProvider({ children }: { children: ReactNode }) {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const paramLabel = parseWindowLabelFromSearch(search);
  const isMain = paramLabel === null;
  const label = paramLabel ?? "main";

  // The window registry persists in localStorage and outlives the process, so on a cold start
  // its entries are all stale (no windows exist yet). The main window — the only one at cold
  // start (multi-window session restore is deferred, bead ) — clears it before
  // registering itself, so stale `win-*` labels can't mis-route a focus-existing lookup.
  useEffect(() => {
    if (isMain) {
      resetWindowRegistry();
      // Same cold-start reasoning for the cross-window status map: its entries outlive the process,
      // so a hard crash that skipped unload cleanup can leave ghost red-agent rows. Wipe them too.
      resetWindowStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initial project: param wins; else (main window) restore the last-selected/first project.
  // Validate the result against the hydrated project list so a stale `?project=` id (project
  // deleted in another window, or a leftover id after a force-quit) falls back to no-project
  // instead of pinning the window to a phantom — the window then behaves like a fresh one
  // (Open/New takes it over) rather than showing a confusing blank.
  const initial = useMemo(() => {
    const st = useProjectStore.getState();
    const id = computeInitialProjectId(search, {
      selectedProjectId: st.selectedProjectId,
      firstProjectId: st.projects[0]?.id ?? null,
    });
    return id && st.projects.some((p) => p.id === id) ? id : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [projectId, setProjectId] = useState<string | null>(initial);

  // Late-hydration recovery for deep-linked windows. A secondary window is created with
  // `?project=<id>` and its OS title is stamped from the OPENER's (already-populated) store, but
  // zustand's `persist` applies THIS window's hydrated localStorage snapshot in a microtask — even
  // with synchronous storage. So the one-shot `initial` memo above can run BEFORE the store
  // hydrates, find the id absent, and strand the window at null forever: the macOS title shows the
  // project name while the body says "No project open" (sparkle bug: created amforge, window still
  // "No project open"). If this window was deep-linked to a project that simply hasn't landed yet,
  // adopt it the instant it appears — via hydration OR a later cross-window sync. A genuinely stale
  // id (project deleted / force-quit leftover) never appears, so the intended fall-back-to-no-project
  // behavior is preserved. Only runs when `initial` failed to resolve an explicit param, and stops
  // as soon as it resolves — so it never fights a later user Open/New/close in this window.
  useEffect(() => {
    const paramId = parseProjectIdFromSearch(search);
    if (!paramId || initial !== null) return;
    const agentId = parseAgentIdFromSearch(search);
    // The project lands via a store `set`, and a single subscription catches every way it can:
    // this window's own late persist hydration goes through setState (which is exactly why
    // crossWindowSync guards `persist.rehydrate()` behind `applyingRemote` — the rehydrate set
    // notifies subscribers), and a cross-window sync rehydrate does too. So no separate
    // onFinishHydration listener is needed. A project always carries its full `agents` array, so
    // the `?agent=` target is present the instant its project is — openDeepLinkAgent resolves it in
    // the same tick, with no need to defer for a later-arriving agent.
    let unsub: (() => void) | null = null;
    const adoptIfPresent = (): boolean => {
      if (!useProjectStore.getState().projects.some((p) => p.id === paramId)) return false;
      // Detach BEFORE mutating: openDeepLinkAgent's selectAgent is itself a store `set`, so leaving
      // the subscription attached would re-enter this callback and recurse infinitely.
      unsub?.();
      unsub = null;
      setProjectId(paramId);
      // Same jump-to-agent landing the fast path does — now that the project has arrived.
      openDeepLinkAgent(paramId, agentId);
      return true;
    };
    if (adoptIfPresent()) return;
    unsub = useProjectStore.subscribe(() => adoptIfPresent());
    return () => unsub?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fast path: the project resolved synchronously at mount, so land its `?agent=` deep-link now.
  // (The late-hydration recovery above owns the `initial === null` case.)
  useEffect(() => {
    if (initial) openDeepLinkAgent(initial, parseAgentIdFromSearch(search));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Register this window's current project so other windows can focus it. In an effect —
  // never write to localStorage during render.
  useEffect(() => {
    // Keep the registry in sync with what this window shows. Clear on a null project so a stale
    // label→oldProject mapping can't make findWindowForProject focus a window that moved on.
    if (projectId) setWindowProject(label, projectId);
    else clearWindowProject(label);
  }, [label, projectId]);

  const value = useMemo<Ctx>(
    () => ({ projectId, isMain, label, replace: setProjectId }),
    [projectId, isMain, label],
  );
  return <CurrentProjectContext.Provider value={value}>{children}</CurrentProjectContext.Provider>;
}

function useCtx(): Ctx {
  const c = useContext(CurrentProjectContext);
  if (!c) throw new Error("useCurrentProject* must be used within CurrentProjectProvider");
  return c;
}

export const useCurrentProjectId = (): string | null => useCtx().projectId;
export const useIsMainWindow = (): boolean => useCtx().isMain;
export const useCurrentWindowLabel = (): string => useCtx().label;
export const useReplaceCurrentProject = (): ((id: string | null) => void) => useCtx().replace;
