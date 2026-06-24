// settingsStore — app-level integration settings that aren't tied to a single project.
// Currently: the Chief (Storytell) Personal Access Token used by Brainstorm agents, plus the
// mapping from a Sparkle project id -> the Chief project id we auto-created for it. Persisted
// to localStorage like the other stores.
//
// NOTE: the PAT lives in localStorage for this MVP. That's fine for a single-user desktop app,
// but a follow-up should move it into Tauri's secure store / OS keychain (tracked on the epic).
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// Dev-only fallback PAT injected by vite.config from the user's CHIEF_API env (see vite.config.ts).
// Empty in production builds. Lets the localhost preview talk to Chief without pasting a token.
const ENV_CHIEF_PAT = ((import.meta.env.VITE_CHIEF_PAT as string | undefined) ?? "").trim();

/** The PAT to actually use: the user-entered one wins, else the dev env fallback. */
export function effectiveChiefPat(stored: string): string {
  return stored.trim() || ENV_CHIEF_PAT;
}

/** True when a PAT came from the env (so the UI can show "connected via env" instead of a field). */
export const hasEnvChiefPat = ENV_CHIEF_PAT.length > 0;

interface SettingsState {
  /** Chief / Storytell Personal Access Token (begins with `pat_`). Empty until the user connects. */
  chiefPat: string;
  /** sparkleProjectId -> chiefProjectId (the Chief project we created/linked for it). */
  chiefProjectByProject: Record<string, string>;

  setChiefPat: (pat: string) => void;
  setChiefProject: (sparkleProjectId: string, chiefProjectId: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      chiefPat: "",
      chiefProjectByProject: {},

      setChiefPat: (pat) => set({ chiefPat: pat.trim() }),

      setChiefProject: (sparkleProjectId, chiefProjectId) =>
        set((s) => ({
          chiefProjectByProject: {
            ...s.chiefProjectByProject,
            [sparkleProjectId]: chiefProjectId,
          },
        })),
    }),
    {
      name: "sparkle-settings",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
