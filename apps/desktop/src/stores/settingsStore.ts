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
import {
  DEFAULT_WAKE_WORD,
  DEFAULT_STOP_WORD,
  DEFAULT_PAUSE_ON_SUBMIT,
} from "../voice/voiceDefaults";
import {
  toApprovalMap,
  asResumeRule,
  DEFAULT_RESUME_RULE,
  type ApprovalCategory,
  type ApprovalMap,
  type ApprovalRule,
  type ResumeRule,
} from "../services/suggestions/approvalCategories";

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
  // `unmerged` recolors the dot red and floats the row up, but does NOT ping by default (a finished
  // agent's un-merged branch is a passive "when you get to it" nudge, not a banner-worthy event).
  unmerged: false,
  stopped: false,
};

// --- AI features (gated by the "Use AI Features" control in the ⋯ menu) ----------------------
// Independent on/off feature flags plus a derived All|Some|Off mode. Each feature degrades to a
// non-AI baseline when off (on-device dictation, no auto-rename, bare terminal instead of the
// composer). Default ON so the app is fully featured out of the box.

/** Stable identifiers for the AI features, used by the menu + the generic setter. */
export type AiFeatureKey =
  | "autoRename"
  | "voiceDictation"
  | "composer"
  | "suggestedActions"
  | "autoApprove";

/** Derived state of the master segment: every feature on / off / a mix. */
export type AiMode = "all" | "some" | "off";

/** The subset of settings state that the AI-features mode is derived from. */
export interface AiFeatureFlags {
  aiAutoRename: boolean;
  /** The voice-dictation feature is the existing cloud-dictation flag (Deepgram on/off). */
  cloudDictation: boolean;
  aiComposer: boolean;
  aiSuggestedActions: boolean;
  /** Sparkle Auto-Approve master toggle (nudging + auto-answering permission prompts). */
  aiAutoApprove: boolean;
}

/** Map a menu feature key to its settings-store field name. The single source of this
 *  mapping — `aiGate` imports it so the key→field relationship is never duplicated. */
export const AI_FEATURE_FIELD: Record<AiFeatureKey, keyof AiFeatureFlags> = {
  autoRename: "aiAutoRename",
  voiceDictation: "cloudDictation",
  composer: "aiComposer",
  suggestedActions: "aiSuggestedActions",
  autoApprove: "aiAutoApprove",
};

// --- Tools (the opinionated [tools] flags, surfaced in the ⋯ Settings → "Tools" pane) ---------
// Non-AI, config-backed on/off tools. Each defaults ON; off means the tool is used nowhere in
// Sparkle (analytics stops sending, the Beads board hides, GitHub import is hidden). Like the
// workflow-mirror fields these are hydrated from config.toml and NOT persisted to localStorage.

/** Stable identifiers for the config-backed [tools] flags. */
export type ToolKey = "analytics" | "beads" | "github" | "guardrails" | "roborev";

/** Map a tool key to its settings-store field name (the single source of that relationship). */
export const TOOL_FIELD: Record<
  ToolKey,
  "analyticsEnabled" | "beadsEnabled" | "githubEnabled" | "guardrailsEnabled" | "roborevEnabled"
> = {
  analytics: "analyticsEnabled",
  beads: "beadsEnabled",
  github: "githubEnabled",
  guardrails: "guardrailsEnabled",
  roborev: "roborevEnabled",
};

// --- Chief sync state (replacing the legacy markdown-sync watermark) -----------------------

/** Per-path Chief sync state: a content hash + the asset id currently holding that content. */
export interface ChiefDocState {
  hash: string;
  assetId: string;
}

/** Derive the master segment from the four flags: all on → "all", all off → "off", else "some". */
export function aiFeatureMode(f: AiFeatureFlags): AiMode {
  const vals = [
    f.aiAutoRename,
    f.cloudDictation,
    f.aiComposer,
    f.aiSuggestedActions,
    f.aiAutoApprove,
  ];
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

/**
 * The worker-concurrency limit to actually enforce: the MIN of what the user configured and what
 * this machine's RAM can hold. Both are ceilings — neither may raise the other — so taking the min
 * is correct in every ordering, including before the first hydrate lands.
 *
 * Every concurrency gate must read this rather than `maxConcurrentWorkers` directly. Spawning to
 * the raw configured number is what let 24 agents × ~4 GiB of V8 heap exhaust a Mac's RAM and get
 * system daemons jetsam-killed (sparkle-01xv / sparkle-asz5).
 */
export function enforcedWorkerCap(s: {
  maxConcurrentWorkers: number;
  effectiveMaxConcurrentWorkers: number;
}): number {
  return Math.max(1, Math.min(s.maxConcurrentWorkers, s.effectiveMaxConcurrentWorkers));
}

// --- Sparkle self-improvement consent --------------------------------------------------------
// How the built-in Sparkle improvement agent may act on the user's anonymous logs. This gates the
// hourly log evaluation and whether improvement PRs are auto-submitted to the OSS project:
//   - "always"       → evaluate hourly AND auto-submit scrubbed PRs (only if the privacy scan passes).
//   - "case_by_case" → evaluate hourly and craft PRs, but the user reviews + approves each before submit.
//   - "never"        → do not evaluate logs at all.
// Default is the privacy-conservative "case_by_case": no PR leaves the machine without explicit
// per-PR approval. Note this governs PRs only — it is NOT a blanket "nothing is transmitted" claim.
// Crash reports are gated separately in crash.rs (`upload_allowed`/`logs_allowed`): "case_by_case"
// uploads the scrubbed crash report (message + backtrace, no log tail) without per-crash approval,
// and only "always" adds the ~200KB recent-logs tail. See SparkleConsentBanner's `consentCopy`,
// which states this per mode — that copy and the Rust gate must not drift apart (they once did:
// the gate required "always" while the default was "case_by_case", so crash reports were captured
// but NEVER uploaded, and the crash table sat empty while real crashes went undiagnosed).
// The default lives here (not behind a migration) — the store's `merge` makes any
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
  /** The concurrency the app actually ENFORCES: `maxConcurrentWorkers` narrowed by how many
   *  agent-sized V8 heaps this machine's RAM can hold (computed in Rust, see
   *  `EffectiveConfig.effective_max_concurrent`). Always ≤ `maxConcurrentWorkers`, always ≥ 1.
   *
   *  Why it's separate from `maxConcurrentWorkers`: that one is the user's *request* and stays
   *  intact so the ⋯-menu slider keeps showing what they chose. This one is what the machine can
   *  survive. Spawning to the request instead of this is what let 24 agents × ~4 GiB of V8 heap
   *  exhaust a Mac's RAM and get system daemons jetsam-killed (sparkle-01xv / sparkle-asz5).
   *  Derived, never persisted — recomputed from config on every hydrate. */
  effectiveMaxConcurrentWorkers: number;
  /** Use the cloud streaming STT (Deepgram Nova-3) for active dictation when available. Default
   *  on — the gold-standard path. Falls back to the on-device model automatically when off, when
   *  no key is present, or when offline. The always-listening wake word stays on-device either way.
   *  This is also AI feature "voiceDictation" in the Use AI Features menu. */
  cloudDictation: boolean;
  /** Auto-name worker agents from their first prompt (the generate_agent_name call). Off → agents
   *  keep their default names. */
  aiAutoRename: boolean;
  /** Use the AI-enhanced composer (ghost text, screenshot drop, dictation insert, Send). Off →
   *  the composer is replaced by the bare terminal input. */
  aiComposer: boolean;
  /** Show one-click suggested action buttons in the composer (Haiku-learned actions). Off → only the free heuristic direct-answer buttons remain. */
  aiSuggestedActions: boolean;
  /** Sparkle Auto-Approve master toggle. On (default) → nudges + auto-answers matching Claude Code
   *  permission prompts per the [approvals] rules. Off → no nudging AND no auto-answering. Mirrors
   *  [ai].auto_approve. */
  aiAutoApprove: boolean;
  /** GLOBAL (all-projects) auto-approve rules, mirrored from config.toml's `[approvals]`. Per-project
   *  overrides live in approvalsStore (read via `get_config(root)`); this is the global layer used
   *  as the effective value when no project is in context and as the "all projects" scope in the
   *  approvals pane. Config-mirrored, NOT persisted. */
  approvals: ApprovalMap;
  /** GLOBAL (all-projects) session-resume rule, mirrored from config.toml's `[approvals].resume`.
   *  A SIBLING of `approvals` (own value domain — "ask"/"summary"/"full", not "always"/"never").
   *  Per-project overrides live in approvalsStore; this is the all-projects layer / the effective
   *  value when no project is in context. Config-mirrored, NOT persisted. */
  resumeRule: ResumeRule;
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
  /** Epoch ms of the last hourly improvement-pass ATTEMPT (recorded at pass start, success or
   *  not, so a failing setup retries next hour instead of hot-looping). null = never — the
   *  scheduler seeds it on its first tick, so the first pass lands ~1h after consent is active
   *  rather than the moment the app opens. Persisted (a restart must not reset the hour). */
  improvementLastRunAt: number | null;
  /** Opt-in for warming the Improve Sparkle pane at app launch (main window only), so the agent is
   *  already up when the user opens its row instead of cold-starting on click. Only consulted in
   *  "case_by_case" consent — "always" is standing authority and warms without asking, "never"
   *  never warms. null = not yet decided (treated as opt-out until the user ticks the box).
   *  Persisted. See sparkleAgent.shouldWarmSparkleAtLaunch — that gate, not this flag, is the
   *  single place the three modes are resolved. */
  improvementLaunchWarm: boolean | null;

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
  /** On closing a shipped build agent, safe-delete its now-merged branch (true) or keep it. */
  deleteMergedBranch: boolean;
  /** Drift-nudge thresholds: commits behind / ahead / changed lines. */
  driftBehindNudge: number;
  driftAheadNudge: number;
  driftChangedLines: number;
  /** Custom wake word (default "Hey Sparkle"). Mirrors [voice].wake_word; the always-listening
   *  matcher (useDictation → wakeMachine) uses it. Config-mirrored, NOT persisted — re-read from
   *  the file each launch. */
  wakeWord: string;
  /** Custom stop word (default "Sparkle, stop"). Mirrors [voice].stop_word. */
  stopWord: string;
  /** When true (default), submitting a prompt drops active dictation back to passive wake-word
   *  listening (mic stays on). When false, dictation keeps listening. Mirrors [voice].pause_on_submit. */
  pauseOnSubmit: boolean;
  /** Usage analytics + masked session replay (PostHog). Off → analytics.ts sends nothing. Mirrors
   *  [tools].analytics. Config-backed, NOT persisted — re-read from the file each launch. */
  analyticsEnabled: boolean;
  /** The in-repo work graph behind the Plan board (Beads / `bd`). Off → the board is hidden and no
   *  `bd` shell-out runs. Mirrors [tools].beads. */
  beadsEnabled: boolean;
  /** Import a project straight from GitHub. Off → the GitHub import path is hidden. Mirrors
   *  [tools].github. */
  githubEnabled: boolean;
  /** Opinionated quality guardrails for the code Sparkle's agents write. On (default) → the
   *  guardrails workflow (test-first, run tests+typecheck before commit, never call a red build
   *  "done") is appended to every coding agent's system prompt; off omits it. Mirrors
   *  [tools].guardrails. */
  guardrailsEnabled: boolean;
  /** roborev — the per-commit AI code-review daemon. On (default) → the Tools toggle is on and
   *  the daemon reviews each BUILD-agent commit; off → dormant. Mirrors [tools].roborev. Config-
   *  backed, NOT persisted — re-read from the file each launch. */
  roborevEnabled: boolean;
  /** Whether the one-time roborev consent modal has already been shown. Set true the first time it
   *  appears (whichever choice the user made) so it never appears again. Mirrors
   *  [roborev].consent_prompted. Config-backed, NOT persisted. */
  roborevConsentPrompted: boolean;
  /** UI-only flag: is the roborev consent modal currently mounted/open? Not config-backed and not
   *  persisted — a transient session flag flipped on at the first reviewable commit (runtimeStore)
   *  and off when the modal resolves (RoborevConsentModal). */
  roborevConsentOpen: boolean;
  /** Why roborev can't actually review, from the last auth self-test — shown under the Roborev row.
   *  UI-only (never persisted): it's re-probed each time the toggle is turned on. null = no problem
   *  observed. This is what keeps a daemon that can't authenticate from *looking* like it's working. */
  roborevAuthWarning: string | null;
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
  /** Toggle deleting a shipped agent's merged branch on close (optimistic; configActions persists). */
  setDeleteMergedBranch: (on: boolean) => void;
  /** Toggle notifications for one agent status. */
  setNotifyStatus: (status: AgentTabStatus, on: boolean) => void;
  /** Toggle one AI feature; the master segment re-derives automatically (aiFeatureMode). */
  setAiFeature: (key: AiFeatureKey, on: boolean) => void;
  /** Optimistically set/clear a GLOBAL approval rule (configActions persists to [approvals]).
   *  `rule` null removes the category from the global mirror. */
  setGlobalApproval: (category: ApprovalCategory, rule: ApprovalRule | null) => void;
  /** Optimistically set the GLOBAL session-resume rule (configActions persists to
   *  [approvals].resume). Mirrors setGlobalApproval but for the resume sibling. */
  setGlobalResume: (rule: ResumeRule) => void;
  /** Bulk-set every AI feature (the All / Off segments). */
  setAllAiFeatures: (on: boolean) => void;
  /** Optimistically set the custom wake word (configActions persists it to [voice].wake_word). */
  setWakeWord: (word: string) => void;
  /** Optimistically set the custom stop word (configActions persists it to [voice].stop_word). */
  setStopWord: (word: string) => void;
  /** Optimistically set the pause-on-submit toggle (configActions persists [voice].pause_on_submit). */
  setPauseOnSubmit: (on: boolean) => void;
  /** Optimistically toggle one [tools] flag; configActions persists it to config.toml. */
  setToolEnabled: (key: ToolKey, on: boolean) => void;
  /** Mark the one-time roborev consent modal as shown (configActions persists
   *  [roborev].consent_prompted). */
  setRoborevConsentPrompted: (prompted: boolean) => void;
  /** Open/close the roborev consent modal (UI-only; controls whether the modal is mounted). */
  setRoborevConsentOpen: (open: boolean) => void;
  /** Set (or clear, with null) the roborev auth self-test warning shown under the Roborev row. */
  setRoborevAuthWarning: (warning: string | null) => void;
  /** Set the Sparkle self-improvement consent mode (the banner's Always/Case by case/Never control). */
  setSparkleImprovementConsent: (mode: SparkleImprovementConsent) => void;
  /** Record when an hourly improvement pass was last attempted (see improvementLastRunAt). */
  setImprovementLastRunAt: (at: number) => void;
  /** Set the launch-warm opt-in (the "Start automatically when Sparkle opens" control). */
  setImprovementLaunchWarm: (on: boolean) => void;
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
      // Starts permissive and is narrowed by the first hydrate; the enforced cap is always the
      // MIN of this and maxConcurrentWorkers (see enforcedWorkerCap), so a pre-hydrate spawn is
      // still bounded by the user's configured value rather than running unlimited.
      effectiveMaxConcurrentWorkers: 20,
      cloudDictation: true,
      aiAutoRename: true,
      aiComposer: true,
      aiSuggestedActions: true,
      aiAutoApprove: true,
      approvals: {},
      resumeRule: DEFAULT_RESUME_RULE,
      autoApplyUpdates: true,
      notifyStatuses: { ...DEFAULT_NOTIFY_STATUSES },
      sparkleImprovementConsent: DEFAULT_SPARKLE_CONSENT,
      improvementLastRunAt: null,
      improvementLaunchWarm: null,

      // Config-file mirror defaults (match SparkleConfig::default() in config.rs; overwritten by hydrate).
      requirePr: true,
      worktreeIsolation: true,
      defaultBranch: "",
      bornFreshFromBase: true,
      deleteMergedBranch: true,
      driftBehindNudge: 10,
      driftAheadNudge: 15,
      driftChangedLines: 1000,
      wakeWord: DEFAULT_WAKE_WORD,
      stopWord: DEFAULT_STOP_WORD,
      pauseOnSubmit: DEFAULT_PAUSE_ON_SUBMIT,
      analyticsEnabled: true,
      beadsEnabled: true,
      githubEnabled: true,
      guardrailsEnabled: true,
      roborevEnabled: true,
      roborevConsentPrompted: false,
      roborevConsentOpen: false,
      roborevAuthWarning: null,
      configWarnings: [],

      setChiefPat: (pat) => set({ chiefPat: pat.trim() }),
      setRuntimeChiefPat: (pat) => set({ runtimeChiefPat: pat.trim() }),
      setCloudDictation: (on) => set({ cloudDictation: on }),
      setAutoApplyUpdates: (on) => set({ autoApplyUpdates: on }),
      setDeleteMergedBranch: (on) => set({ deleteMergedBranch: on }),
      setNotifyStatus: (status, on) =>
        set((s) => ({ notifyStatuses: { ...s.notifyStatuses, [status]: on } })),
      setAiFeature: (key, on) => set({ [AI_FEATURE_FIELD[key]]: on } as Partial<AiFeatureFlags>),
      setAllAiFeatures: (on) =>
        set({
          aiAutoRename: on,
          cloudDictation: on,
          aiComposer: on,
          aiSuggestedActions: on,
          aiAutoApprove: on,
        }),
      setGlobalApproval: (category, rule) =>
        set((s) => {
          const next = { ...s.approvals };
          if (rule) next[category] = rule;
          else delete next[category];
          return { approvals: next };
        }),
      setGlobalResume: (rule) => set({ resumeRule: asResumeRule(rule) }),
      setWakeWord: (wakeWord) => set({ wakeWord }),
      setStopWord: (stopWord) => set({ stopWord }),
      setPauseOnSubmit: (pauseOnSubmit) => set({ pauseOnSubmit }),
      setToolEnabled: (key, on) => set({ [TOOL_FIELD[key]]: on } as Partial<SettingsState>),
      setRoborevConsentPrompted: (prompted) => set({ roborevConsentPrompted: prompted }),
      setRoborevConsentOpen: (open) => set({ roborevConsentOpen: open }),
      setRoborevAuthWarning: (warning) => set({ roborevAuthWarning: warning }),
      setSparkleImprovementConsent: (mode) => set({ sparkleImprovementConsent: mode }),
      setImprovementLastRunAt: (at) => set({ improvementLastRunAt: at }),
      setImprovementLaunchWarm: (on) => set({ improvementLaunchWarm: on }),

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
          // `?? max_concurrent` covers a backend predating memory-aware concurrency. The extra
          // Math.min re-asserts the ceiling here so a bad/large backend value can never RAISE the
          // cap above what the user configured — this store field is what the spawn gate reads.
          effectiveMaxConcurrentWorkers: Math.max(
            1,
            Math.min(
              Math.floor(config.workers.max_concurrent),
              Math.floor(eff.effective_max_concurrent ?? config.workers.max_concurrent),
            ),
          ),
          aiAutoRename: config.ai.auto_rename,
          cloudDictation: config.ai.voice_dictation,
          aiComposer: config.ai.composer,
          aiSuggestedActions: config.ai.suggested_actions,
          // Auto-approve master toggle (`?? true` covers an older backend predating [ai].auto_approve).
          aiAutoApprove: config.ai.auto_approve ?? true,
          // GLOBAL approval rules mirror. App.tsx hydrates from the global layer (no project root),
          // so this stays the all-projects view; per-project overrides come from approvalsStore.
          approvals: toApprovalMap(config.approvals),
          // GLOBAL session-resume rule (sibling of approvals; own value domain). Coerced so an
          // absent/unknown value degrades to "ask".
          resumeRule: asResumeRule(config.approvals?.resume),
          // Workflow rules (display / advanced).
          requirePr: config.workflow.require_pr,
          worktreeIsolation: config.workflow.worktree_isolation,
          defaultBranch: config.workflow.default_branch,
          bornFreshFromBase: config.workflow.born_fresh_from_base,
          deleteMergedBranch: config.workflow.delete_merged_branch,
          driftBehindNudge: config.workflow.drift.behind_nudge,
          driftAheadNudge: config.workflow.drift.ahead_nudge,
          driftChangedLines: config.workflow.drift.changed_lines,
          // Voice controls. Trim + `|| default` treats an absent [voice] block (older backend) AND
          // an empty/whitespace word alike — a blank custom word would otherwise take the generic
          // matcher's custom path with an empty phrase and never wake.
          wakeWord: (config.voice?.wake_word ?? "").trim() || DEFAULT_WAKE_WORD,
          stopWord: (config.voice?.stop_word ?? "").trim() || DEFAULT_STOP_WORD,
          pauseOnSubmit: config.voice?.pause_on_submit ?? DEFAULT_PAUSE_ON_SUBMIT,
          // Tools flags. `?? true` treats an absent [tools] block (older backend) as the on-by-default
          // state, matching SparkleConfig::default() — a new install ships every tool on.
          analyticsEnabled: config.tools?.analytics ?? true,
          beadsEnabled: config.tools?.beads ?? true,
          githubEnabled: config.tools?.github ?? true,
          guardrailsEnabled: config.tools?.guardrails ?? true,
          roborevEnabled: config.tools?.roborev ?? true,
          // `?? false`: an absent [roborev] block (older backend) means we've never prompted, so a
          // first reviewable commit still surfaces the one-time consent modal.
          roborevConsentPrompted: config.roborev?.consent_prompted ?? false,
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
        aiComposer: s.aiComposer,
        aiSuggestedActions: s.aiSuggestedActions,
        aiAutoApprove: s.aiAutoApprove,
        autoApplyUpdates: s.autoApplyUpdates,
        notifyStatuses: s.notifyStatuses,
        sparkleImprovementConsent: s.sparkleImprovementConsent,
        improvementLastRunAt: s.improvementLastRunAt,
        improvementLaunchWarm: s.improvementLaunchWarm,
      }),
    },
  ),
);
