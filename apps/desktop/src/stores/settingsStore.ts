// settingsStore — app-level integration settings that aren't tied to a single project.
// Currently: the Chief (Storytell) Personal Access Token used by Brainstorm agents, plus the
// mapping from a Sparkle project id -> the Chief project id we auto-created for it. Persisted
// to localStorage like the other stores.
//
// NOTE: the PAT lives in localStorage for this MVP. That's fine for a single-user desktop app,
// but a follow-up should move it into Tauri's secure store / OS keychain (tracked on the epic).
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// Build-time fallback PAT injected by vite.config from the user's CHIEF_API env (dev only; see
// vite.config.ts). Empty in production builds. The primary env path is now the RUNTIME one below
// (`runtimeChiefPat`), resolved by the Rust `chief_pat` command from the user's .env.local at
// launch — that works in packaged builds too and never bakes the secret into the bundle.
const BUILD_ENV_CHIEF_PAT = ((import.meta.env.VITE_CHIEF_PAT as string | undefined) ?? "").trim();

/**
 * The PAT to actually use, in priority order: the user-entered (stored) one, then the runtime
 * env-resolved one (Rust `chief_pat`, seeded into the store at startup), then the dev build-time
 * fallback. `runtime` is passed by callers reading `runtimeChiefPat` from the store so they
 * re-render when it lands.
 */
export function effectiveChiefPat(stored: string, runtime = ""): string {
  return stored.trim() || runtime.trim() || BUILD_ENV_CHIEF_PAT;
}

interface SettingsState {
  /** Chief / Storytell Personal Access Token (begins with `pat_`). Empty until the user connects. */
  chiefPat: string;
  /** PAT the Rust backend resolved from env / .env.local at launch. Not persisted — re-resolved
   *  fresh each session (the env token can rotate). Used as a fallback when none is stored. */
  runtimeChiefPat: string;
  /** sparkleProjectId -> chiefProjectId (the Chief project we created/linked for it). */
  chiefProjectByProject: Record<string, string>;
  /** agentId -> last commit sha whose markdown we synced to Chief (the sync watermark). */
  chiefSyncByAgent: Record<string, string>;
  /** Maximum number of concurrent workers (floored at 1). */
  maxConcurrentWorkers: number;

  setChiefPat: (pat: string) => void;
  setRuntimeChiefPat: (pat: string) => void;
  setChiefProject: (sparkleProjectId: string, chiefProjectId: string) => void;
  setChiefSync: (agentId: string, sha: string) => void;
  setMaxConcurrentWorkers: (n: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      chiefPat: "",
      runtimeChiefPat: "",
      chiefProjectByProject: {},
      chiefSyncByAgent: {},
      maxConcurrentWorkers: 4,

      setChiefPat: (pat) => set({ chiefPat: pat.trim() }),
      setRuntimeChiefPat: (pat) => set({ runtimeChiefPat: pat.trim() }),

      setChiefProject: (sparkleProjectId, chiefProjectId) =>
        set((s) => ({
          chiefProjectByProject: {
            ...s.chiefProjectByProject,
            [sparkleProjectId]: chiefProjectId,
          },
        })),

      setChiefSync: (agentId, sha) =>
        set((s) => ({
          chiefSyncByAgent: { ...s.chiefSyncByAgent, [agentId]: sha },
        })),

      setMaxConcurrentWorkers: (n) => set({ maxConcurrentWorkers: Math.max(1, Math.floor(n)) }),
    }),
    {
      name: "sparkle-settings",
      storage: createJSONStorage(() => localStorage),
      // Persist everything EXCEPT runtimeChiefPat — it's re-resolved from env at each launch, so
      // persisting it would let a removed/rotated env token linger stale until startup runs.
      partialize: (s) => ({
        chiefPat: s.chiefPat,
        chiefProjectByProject: s.chiefProjectByProject,
        chiefSyncByAgent: s.chiefSyncByAgent,
        maxConcurrentWorkers: s.maxConcurrentWorkers,
      }),
    },
  ),
);
