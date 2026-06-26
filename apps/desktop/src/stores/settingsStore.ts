// settingsStore — app-level integration settings that aren't tied to a single project.
// Currently: the Chief (Storytell) Personal Access Token used by Think agents, plus the
// mapping from a Sparkle project id -> the Chief project id we auto-created for it. Persisted
// to localStorage like the other stores.
//
// NOTE: the PAT lives in localStorage for this MVP. That's fine for a single-user desktop app,
// but a follow-up should move it into Tauri's secure store / OS keychain (tracked on the epic).
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// --- AI features (gated by the "Use AI Features" control in the ⋯ menu) ----------------------
// Four independent on/off feature flags plus a derived All|Some|Off mode. Each feature degrades
// to a non-AI baseline when off (on-device dictation, no auto-rename, no Brainstorm button, bare
// terminal instead of the composer). Default ON so the app is fully featured out of the box.

/** Stable identifiers for the AI features, used by the menu + the generic setter. */
export type AiFeatureKey = "autoRename" | "voiceDictation" | "brainstorm" | "composer";

/** Derived state of the master segment: every feature on / off / a mix. */
export type AiMode = "all" | "some" | "off";

/** The subset of settings state that the AI-features mode is derived from. */
export interface AiFeatureFlags {
  aiAutoRename: boolean;
  /** The voice-dictation feature is the existing cloud-dictation flag (Deepgram on/off). */
  cloudDictation: boolean;
  aiBrainstorm: boolean;
  aiComposer: boolean;
}

/** Map a menu feature key to its settings-store field name. */
const AI_FEATURE_FIELD: Record<AiFeatureKey, keyof AiFeatureFlags> = {
  autoRename: "aiAutoRename",
  voiceDictation: "cloudDictation",
  brainstorm: "aiBrainstorm",
  composer: "aiComposer",
};

/** Derive the master segment from the four flags: all on → "all", all off → "off", else "some". */
export function aiFeatureMode(f: AiFeatureFlags): AiMode {
  const vals = [f.aiAutoRename, f.cloudDictation, f.aiBrainstorm, f.aiComposer];
  if (vals.every(Boolean)) return "all";
  if (vals.every((v) => !v)) return "off";
  return "some";
}

/**
 * Persist migration v0 → v1: the binary `aiEnabled` master became four per-feature flags (all
 * default on). Without this, a user who set `aiEnabled=false` (to stop AI work and avoid consuming
 * credits) would silently get every AI feature — including the billable cloud-dictation path —
 * re-enabled on upgrade. Map a stored `aiEnabled===false` to all four flags off; absent/true lets
 * the on-by-default values win. Pure + exported for testing.
 */
export function migrateSettings(persisted: unknown, version: number): unknown {
  const prev = persisted as (Partial<AiFeatureFlags> & { aiEnabled?: boolean }) | null | undefined;
  if (version < 1 && prev && prev.aiEnabled === false) {
    return {
      ...prev,
      aiAutoRename: false,
      cloudDictation: false,
      aiBrainstorm: false,
      aiComposer: false,
    };
  }
  return prev;
}

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
  /** Use the cloud streaming STT (Deepgram Nova-3) for active dictation when available. Default
   *  on — the gold-standard path. Falls back to the on-device model automatically when off, when
   *  no key is present, or when offline. The always-listening wake word stays on-device either way.
   *  This is also AI feature "voiceDictation" in the Use AI Features menu. */
  cloudDictation: boolean;
  /** Auto-name worker agents from their first prompt (the generate_agent_name call). Off → agents
   *  keep their default names. */
  aiAutoRename: boolean;
  /** Show the ✦ Brainstorm button. Off → the button is hidden. */
  aiBrainstorm: boolean;
  /** Use the AI-enhanced composer (ghost text, screenshot drop, dictation insert, Send). Off →
   *  the composer is replaced by the bare terminal input. */
  aiComposer: boolean;

  setChiefPat: (pat: string) => void;
  setRuntimeChiefPat: (pat: string) => void;
  setChiefProject: (sparkleProjectId: string, chiefProjectId: string) => void;
  setChiefSync: (agentId: string, sha: string) => void;
  setMaxConcurrentWorkers: (n: number) => void;
  setCloudDictation: (on: boolean) => void;
  /** Toggle one AI feature; the master segment re-derives automatically (aiFeatureMode). */
  setAiFeature: (key: AiFeatureKey, on: boolean) => void;
  /** Bulk-set every AI feature (the All / Off segments). */
  setAllAiFeatures: (on: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      chiefPat: "",
      runtimeChiefPat: "",
      chiefProjectByProject: {},
      chiefSyncByAgent: {},
      maxConcurrentWorkers: 4,
      cloudDictation: true,
      aiAutoRename: true,
      aiBrainstorm: true,
      aiComposer: true,

      setChiefPat: (pat) => set({ chiefPat: pat.trim() }),
      setRuntimeChiefPat: (pat) => set({ runtimeChiefPat: pat.trim() }),
      setCloudDictation: (on) => set({ cloudDictation: on }),
      setAiFeature: (key, on) => set({ [AI_FEATURE_FIELD[key]]: on } as Partial<AiFeatureFlags>),
      setAllAiFeatures: (on) =>
        set({ aiAutoRename: on, cloudDictation: on, aiBrainstorm: on, aiComposer: on }),

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
      // v0 → v1: preserve a prior `aiEnabled=false` opt-out across the binary→four-flag schema
      // change so we never silently re-arm AI/credits on upgrade (see migrateSettings).
      version: 1,
      migrate: migrateSettings,
      // Persist everything EXCEPT runtimeChiefPat — it's re-resolved from env at each launch, so
      // persisting it would let a removed/rotated env token linger stale until startup runs.
      partialize: (s) => ({
        chiefPat: s.chiefPat,
        chiefProjectByProject: s.chiefProjectByProject,
        chiefSyncByAgent: s.chiefSyncByAgent,
        maxConcurrentWorkers: s.maxConcurrentWorkers,
        cloudDictation: s.cloudDictation,
        aiAutoRename: s.aiAutoRename,
        aiBrainstorm: s.aiBrainstorm,
        aiComposer: s.aiComposer,
      }),
    },
  ),
);
