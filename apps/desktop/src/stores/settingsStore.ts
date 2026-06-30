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
// Type-only import: erased at compile time, so the store stays free of the Tauri runtime dep
// (services/config pulls in @tauri-apps) and remains testable under jsdom.
import type { EffectiveConfig } from "../services/config";

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
 * Persist migrations, applied in order against the stored `version`:
 *  - v0 → v1: the binary `aiEnabled` master became four per-feature flags (all default on).
 *    Without this, a user who set `aiEnabled=false` (to stop AI work and avoid consuming credits)
 *    would silently get every AI feature — including the billable cloud-dictation path — re-enabled
 *    on upgrade. Map a stored `aiEnabled===false` to all four flags off; absent/true lets the
 *    on-by-default values win.
 *  - v1 → v2: `autoApplyUpdates` was added (default on). An existing install has no stored value,
 *    so set it to `true` explicitly here — the same default a fresh install gets — rather than
 *    relying on merge alone, so the migrated shape is self-describing.
 * Pure + exported for testing.
 */
export function migrateSettings(persisted: unknown, version: number): unknown {
  let prev = persisted as
    | (Partial<AiFeatureFlags> & { aiEnabled?: boolean; autoApplyUpdates?: boolean })
    | null
    | undefined;
  if (version < 1 && prev && prev.aiEnabled === false) {
    prev = {
      ...prev,
      aiAutoRename: false,
      cloudDictation: false,
      aiBrainstorm: false,
      aiComposer: false,
    };
  }
  if (version < 2 && prev && prev.autoApplyUpdates === undefined) {
    prev = { ...prev, autoApplyUpdates: true };
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

// --- Sparkle self-improvement consent --------------------------------------------------------
// How the built-in Sparkle improvement agent may act on the user's anonymous logs. This gates the
// hourly log evaluation and whether improvement PRs are auto-submitted to the OSS project:
//   - "always"       → evaluate hourly AND auto-submit scrubbed PRs (only if the privacy scan passes).
//   - "case_by_case" → evaluate hourly and craft PRs, but the user reviews + approves each before submit.
//   - "never"        → do not evaluate logs at all.
// Default is the privacy-conservative "case_by_case": nothing leaves the machine without explicit
// per-PR approval. The default lives here (not behind a migration) — the store's `merge` makes any
// pre-existing persisted blob that lacks this field inherit this default on read.
export type SparkleImprovementConsent = "always" | "case_by_case" | "never";

/** The default consent mode for a fresh install: review-and-approve each PR. */
export const DEFAULT_SPARKLE_CONSENT: SparkleImprovementConsent = "case_by_case";

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
  /** Auto-apply desktop updates: when on (default), a found update downloads + installs silently
   *  and applies on the next restart, with a quiet "ready" affordance. When off, the user gets a
   *  "Restart to apply / Later" prompt instead and nothing is installed until they choose. Read by
   *  updaterService. */
  autoApplyUpdates: boolean;
  /** Which agent statuses fire a Notification Center banner on the transition INTO them. See
   *  DEFAULT_NOTIFY_STATUSES. Persisted; merged over the defaults on read so a status added later
   *  inherits its default rather than reading undefined. */
  notifyStatuses: Record<AgentTabStatus, boolean>;
  /** Consent for the Sparkle self-improvement agent to use the user's anonymous logs. See
   *  SparkleImprovementConsent. Persisted; defaults to "case_by_case". */
  sparkleImprovementConsent: SparkleImprovementConsent;

  // --- Editable config-file mirror (reflections of config.toml; the file is the source of truth) ---
  // Hydrated from the TOML config via `hydrateFromConfig` at startup and on every config-changed
  // event. NOT persisted to localStorage — re-read from the file each launch.
  /** true = open a PR & merge; false = allow pushing to the base branch directly. */
  requirePr: boolean;
  /** Each agent runs in its own isolated git worktree. */
  worktreeIsolation: boolean;
  /** Explicit base-branch override ("" = auto-detect from git). */
  defaultBranch: string;
  /** Cut each agent branch from a freshly-fetched base. */
  bornFreshFromBase: boolean;
  /** Drift-nudge thresholds: commits behind / ahead / changed lines. */
  driftBehindNudge: number;
  driftAheadNudge: number;
  driftChangedLines: number;
  /** Non-fatal warnings from the last config load (malformed layer, ignored per-project keys). */
  configWarnings: string[];

  setChiefPat: (pat: string) => void;
  setRuntimeChiefPat: (pat: string) => void;
  setChiefProject: (sparkleProjectId: string, chiefProjectId: string) => void;
  setChiefProjectDocState: (chiefProjectId: string, map: Record<string, ChiefDocState>) => void;
  clearChiefDocState: (chiefProjectId: string) => void;
  setMaxConcurrentWorkers: (n: number) => void;
  setCloudDictation: (on: boolean) => void;
  /** Toggle auto-apply of desktop updates (the "Automatically apply updates" checkbox). */
  setAutoApplyUpdates: (on: boolean) => void;
  /** Toggle notifications for one agent status. */
  setNotifyStatus: (status: AgentTabStatus, on: boolean) => void;
  /** Toggle one AI feature; the master segment re-derives automatically (aiFeatureMode). */
  setAiFeature: (key: AiFeatureKey, on: boolean) => void;
  /** Bulk-set every AI feature (the All / Off segments). */
  setAllAiFeatures: (on: boolean) => void;
  /** Set the Sparkle self-improvement consent mode (the banner's Always/Case by case/Never control). */
  setSparkleImprovementConsent: (mode: SparkleImprovementConsent) => void;
  /** Reflect the effective config (from config.toml) into the mirrored store fields. Called at
   *  startup and whenever the file changes. The file is the source of truth — this is the read side. */
  hydrateFromConfig: (eff: EffectiveConfig) => void;
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
      autoApplyUpdates: true,
      notifyStatuses: { ...DEFAULT_NOTIFY_STATUSES },
      sparkleImprovementConsent: DEFAULT_SPARKLE_CONSENT,

      // Config-file mirror defaults (match SparkleConfig::default() in config.rs; overwritten by hydrate).
      requirePr: true,
      worktreeIsolation: true,
      defaultBranch: "",
      bornFreshFromBase: true,
      driftBehindNudge: 10,
      driftAheadNudge: 15,
      driftChangedLines: 1000,
      configWarnings: [],

      setChiefPat: (pat) => set({ chiefPat: pat.trim() }),
      setRuntimeChiefPat: (pat) => set({ runtimeChiefPat: pat.trim() }),
      setCloudDictation: (on) => set({ cloudDictation: on }),
      setAutoApplyUpdates: (on) => set({ autoApplyUpdates: on }),
      setNotifyStatus: (status, on) =>
        set((s) => ({ notifyStatuses: { ...s.notifyStatuses, [status]: on } })),
      setAiFeature: (key, on) => set({ [AI_FEATURE_FIELD[key]]: on } as Partial<AiFeatureFlags>),
      setAllAiFeatures: (on) =>
        set({ aiAutoRename: on, cloudDictation: on, aiBrainstorm: on, aiComposer: on }),
      setSparkleImprovementConsent: (mode) => set({ sparkleImprovementConsent: mode }),

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

      hydrateFromConfig: (eff) => {
        const { config, warnings } = eff;
        set({
          // Concurrency + AI flags (also surfaced in the ⋯ menu controls).
          maxConcurrentWorkers: Math.max(1, Math.floor(config.workers.max_concurrent)),
          aiAutoRename: config.ai.auto_rename,
          cloudDictation: config.ai.voice_dictation,
          aiBrainstorm: config.ai.brainstorm,
          aiComposer: config.ai.composer,
          // Workflow rules (display / advanced).
          requirePr: config.workflow.require_pr,
          worktreeIsolation: config.workflow.worktree_isolation,
          defaultBranch: config.workflow.default_branch,
          bornFreshFromBase: config.workflow.born_fresh_from_base,
          driftBehindNudge: config.workflow.drift.behind_nudge,
          driftAheadNudge: config.workflow.drift.ahead_nudge,
          driftChangedLines: config.workflow.drift.changed_lines,
          configWarnings: warnings,
        });
      },
    }),
    {
      name: "sparkle-settings",
      storage: createJSONStorage(() => localStorage),
      // v0 → v1: preserve a prior `aiEnabled=false` opt-out across the binary→four-flag schema
      // change so we never silently re-arm AI/credits on upgrade. v1 → v2: seed autoApplyUpdates
      // (default on) for existing installs. See migrateSettings.
      version: 2,
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
      // NOTE on the config-mirrored fields: config.toml is the source of truth (hydrateFromConfig
      // overwrites these at startup + on every change). The NEW workflow-mirror fields (requirePr,
      // drift*, etc.) are intentionally NOT persisted here — re-read from the file each launch. But
      // maxConcurrentWorkers + the four AI flags STAY persisted as a migration-safe fallback: on a
      // first upgrade config.toml does not exist yet, and these localStorage values are the only
      // record of a user's prior AI opt-out (the v0→v1 migration that guards against silently
      // re-arming billable AI/credits). They stay in lockstep with the file because every UI write
      // goes through both (configActions: optimistic store update → file write → hydrate).
      partialize: (s) => ({
        chiefPat: s.chiefPat,
        chiefProjectByProject: s.chiefProjectByProject,
        chiefDocStateByProject: s.chiefDocStateByProject,
        maxConcurrentWorkers: s.maxConcurrentWorkers,
        cloudDictation: s.cloudDictation,
        aiAutoRename: s.aiAutoRename,
        aiBrainstorm: s.aiBrainstorm,
        aiComposer: s.aiComposer,
        autoApplyUpdates: s.autoApplyUpdates,
        notifyStatuses: s.notifyStatuses,
        sparkleImprovementConsent: s.sparkleImprovementConsent,
      }),
    },
  ),
);
