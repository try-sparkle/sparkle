import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  computeInitialProjectId,
  parseWindowLabelFromSearch,
} from "./services/projectWindows.url";
import { useProjectStore } from "./stores/projectStore";
import {
  setWindowProject,
  clearWindowProject,
  resetWindowRegistry,
} from "./services/windowRegistry";

interface Ctx {
  projectId: string | null;
  isMain: boolean;
  label: string;
  replace: (id: string | null) => void;
}

const CurrentProjectContext = createContext<Ctx | null>(null);

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
    if (isMain) resetWindowRegistry();
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
