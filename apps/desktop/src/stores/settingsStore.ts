// settingsStore — app-level integration settings that aren't tied to a single project.
// Currently: the Chief (Storytell) Personal Access Token used by Think agents, plus the
// mapping from a Sparkle project id -> the Chief project id we auto-created for it. Persisted
// to localStorage like the other stores.
//
// NOTE: the PAT lives in localStorage for this MVP. That's fine for a single-user desktop app,
// but a follow-up should move it into Tauri's secure store / OS keychain (tracked on the epic).
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AgentTabStatus } from "../types";

// --- Status-change notifications -------------------------------------------------------------
// Which agent statuses fire a Notification Center banner when an agent crosses INTO them. The
// user picks these via the "Notifications" section of the ⋯ menu. Defaults: the red tier
// (waiting/approval/errored) plus the "finished" tier (idle = your turn, done) — i.e. tell me
// when an agent needs me OR is done. The dock badge is separate (always waiting/approval).
//
// Why `idle` is ON but `working` is OFF, even though both can flip often for loop-style agents:
// `idle` is the "I'm done, your turn" edge the user explicitly asked to be notified about (most
// interactive agents finish a turn as idle, not done), so it earns a ping; `working` is pure
// churn (start of every turn/tool) with no actionable signal. Both are one toggle away if the
// default is wrong for a given workflow. blocked/stopped are passive and default OFF too.
export const DEFAULT_NOTIFY_STATUSES: Record<AgentTabStatus, boolean> = {
  waiting: true,
  approval: true,
  errored: true,
  idle: true,
  done: true,
  working: false,
  blocked: false,
  stopped: false,
};

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

/** Map a menu feature key to its settings-store field name. The single source of this
 *  mapping — `aiGate` imports it so the key→field relationship is never duplicated. */
export const AI_FEATURE_FIELD: Record<AiFeatureKey, keyof AiFeatureFlags> = {
  autoRename: "aiAutoRename",
  voiceDictation: "cloudDictation",
  brainstorm: "aiBrainstorm",
  composer: "aiComposer",
};

// --- Chief sync state (replacing the legacy markdown-sync watermark) -----------------------

/** Per-path Chief sync state: a content hash + the asset id currently holding that content. */
export interface ChiefDocState {
  hash: string;
  assetId: string;
}

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
  /** chiefProjectId -> (doc path -> { content hash, asset id }). The current-state sync ledger:
   *  one entry per path, replaced wholesale each sync. */
  chiefDocStateByProject: Record<string, Record<string, ChiefDocState>>;
  /** Maximum number of concurrent workers an orchestrator may run at once, per build agent
   *  (floored at 1, otherwise unbounded). Adjustable via the slider in the ⋯ menu; the
   *  orchestration persona reads this same value so the cap it's told about always matches. */
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
  /** Which agent statuses fire a Notification Center banner on the transition INTO them. See
   *  DEFAULT_NOTIFY_STATUSES. Persisted; merged over the defaults on read so a status added later
   *  inherits its default rather than reading undefined. */
  notifyStatuses: Record<AgentTabStatus, boolean>;

  setChiefPat: (pat: string) => void;
  setRuntimeChiefPat: (pat: string) => void;
  setChiefProject: (sparkleProjectId: string, chiefProjectId: string) => void;
  setChiefProjectDocState: (chiefProjectId: string, map: Record<string, ChiefDocState>) => void;
  clearChiefDocState: (chiefProjectId: string) => void;
  setMaxConcurrentWorkers: (n: number) => void;
  setCloudDictation: (on: boolean) => void;
  /** Toggle notifications for one agent status. */
  setNotifyStatus: (status: AgentTabStatus, on: boolean) => void;
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
      chiefDocStateByProject: {},
      maxConcurrentWorkers: 20,
      cloudDictation: true,
      aiAutoRename: true,
      aiBrainstorm: true,
      aiComposer: true,
      notifyStatuses: { ...DEFAULT_NOTIFY_STATUSES },

      setChiefPat: (pat) => set({ chiefPat: pat.trim() }),
      setRuntimeChiefPat: (pat) => set({ runtimeChiefPat: pat.trim() }),
      setCloudDictation: (on) => set({ cloudDictation: on }),
      setNotifyStatus: (status, on) =>
        set((s) => ({ notifyStatuses: { ...s.notifyStatuses, [status]: on } })),
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

      setChiefProjectDocState: (chiefProjectId, map) =>
        set((s) => ({
          chiefDocStateByProject: { ...s.chiefDocStateByProject, [chiefProjectId]: map },
        })),

      clearChiefDocState: (chiefProjectId) =>
        set((s) => {
          const { [chiefProjectId]: _drop, ...rest } = s.chiefDocStateByProject;
          return { chiefDocStateByProject: rest };
        }),

      setMaxConcurrentWorkers: (n) => set({ maxConcurrentWorkers: Math.max(1, Math.floor(n)) }),
    }),
    {
      name: "sparkle-settings",
      storage: createJSONStorage(() => localStorage),
      // v0 → v1: preserve a prior `aiEnabled=false` opt-out across the binary→four-flag schema
      // change so we never silently re-arm AI/credits on upgrade (see migrateSettings).
      version: 1,
      migrate: migrateSettings,
      // Merge persisted state over the live defaults, but DEEP-merge notifyStatuses so a store
      // saved before this field existed (or one missing a newly-added status) inherits the
      // per-status defaults instead of dropping to undefined. Everything else is a shallow
      // override, matching zustand's default merge.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...p,
          notifyStatuses: { ...DEFAULT_NOTIFY_STATUSES, ...(p.notifyStatuses ?? {}) },
        };
      },
      // Persist everything EXCEPT runtimeChiefPat — it's re-resolved from env at each launch, so
      // persisting it would let a removed/rotated env token linger stale until startup runs.
      partialize: (s) => ({
        chiefPat: s.chiefPat,
        chiefProjectByProject: s.chiefProjectByProject,
        chiefDocStateByProject: s.chiefDocStateByProject,
        maxConcurrentWorkers: s.maxConcurrentWorkers,
        cloudDictation: s.cloudDictation,
        aiAutoRename: s.aiAutoRename,
        aiBrainstorm: s.aiBrainstorm,
        aiComposer: s.aiComposer,
        notifyStatuses: s.notifyStatuses,
      }),
    },
  ),
);
