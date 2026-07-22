// Frontend wrapper over the Rust editable-config commands (config.rs). The TOML config file is
// the single source of truth; this module is the only place the UI talks to it. See the design
// spec: docs/superpowers/specs/2026-06-29-editable-config-file-design.md
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface DriftConfig {
  behind_nudge: number;
  ahead_nudge: number;
  changed_lines: number;
}
export interface WorkflowConfig {
  require_pr: boolean;
  worktree_isolation: boolean;
  default_branch: string;
  born_fresh_from_base: boolean;
  delete_merged_branch: boolean;
  drift: DriftConfig;
}
export interface WorkersConfig {
  /** The user's requested ceiling. The number actually enforced is
   *  `EffectiveConfig.effective_max_concurrent`, which also accounts for installed RAM. */
  max_concurrent: number;
  /** Per-agent V8 heap cap in MiB (NODE_OPTIONS=--max-old-space-size). 0 = opt out.
   *  Optional so callers guard: a Rust backend predating this key omits it. */
  agent_heap_mb?: number;
}
export interface AiConfig {
  auto_rename: boolean;
  voice_dictation: boolean;
  composer: boolean;
  suggested_actions: boolean;
  /** Master switch for Sparkle Auto-Approve (nudging + auto-answering). Default true. */
  auto_approve: boolean;
}
/** Per-category Sparkle Auto-Approve rules. Each is `"always"` / `"never"` / null (absent = ask +
 *  nudge). Serde serializes an absent rule as null. Mirrors ApprovalsConfig in config.rs. */
export interface ApprovalsConfig {
  skill: string | null;
  bash: string | null;
  edit: string | null;
  mcp: string | null;
  fetch: string | null;
  other: string | null;
  /** Session-resume rule. NOT an "always"/"never" category — one of "ask" | "summary" | "full"
   *  (default "ask"). Governs how the Claude Code session-resume prompt is auto-answered while
   *  [ai].auto_approve is on. Optional so callers guard: a Rust backend predating it omits it. */
  resume?: string | null;
}
/** Opinionated non-AI tools (machine-wide; ignored in a per-project file). Each defaults on for a
 *  new install; false means that tool is used nowhere in Sparkle. Surfaced in the "Tools" pane. */
export interface ToolsConfig {
  analytics: boolean;
  beads: boolean;
  github: boolean;
  guardrails: boolean;
  roborev: boolean;
}
/** roborev machine-wide state (the one-time consent flag), its own section so Rust can gate the
 *  first-run modal on it. Machine-wide (like [tools]); ignored in a per-project file. */
export interface RoborevConfig {
  consent_prompted: boolean;
}
/** Branch/build freshness guardrails (read by the build script + session-start staleness hook). */
export interface FreshnessConfig {
  staleness_warn_commits: number;
  stale_build_block_commits: number;
  require_fresh_branch: boolean;
}
/** Voice controls (machine-wide; ignored in a per-project file). The wake/stop words and the
 *  submit-listening behavior, editable in the ⋯ Settings → "Voice controls" pane. */
export interface VoiceConfig {
  wake_word: string;
  stop_word: string;
  pause_on_submit: boolean;
}
/** Menu-bar capture flow (machine-wide; ignored in a per-project file). */
export interface CaptureConfig {
  popover_shortcut: string;
}
/** One criterion in a stage definition. `kind` is "auto" (observed via `signal`) or "manual"
 *  (a human ticks it); `signal` is a known auto-signal id, present iff kind === "auto".
 *  Field casing mirrors the Rust serde output exactly (snake_case, Option → value | null). */
export interface StageCriterion {
  text: string;
  kind: string;
  signal: string | null;
}
/** Per-project "Done" stage definition. Undefined = null description + empty criteria. */
export interface DoneConfig {
  description: string | null;
  criteria: StageCriterion[];
}
/** Per-project "Delivered" stage definition + the detected production-ship signal. */
export interface DeliveredConfig {
  description: string | null;
  detected_method: string | null;
  confidence: string | null;
  confidence_note: string | null;
  learned: boolean;
  criteria: StageCriterion[];
}
export interface SparkleConfig {
  workflow: WorkflowConfig;
  workers: WorkersConfig;
  ai: AiConfig;
  // Optional so callers guard: an older Rust backend (predating [tools]) omits it. The current
  // backend always sends it; hydrateFromConfig defaults each flag to on when absent.
  tools?: ToolsConfig;
  // Optional for the same back-compat reason as `tools?` above: a payload from a Rust backend
  // predating [roborev] omits it. Callers read `config.roborev?.consent_prompted ?? false`.
  roborev?: RoborevConfig;
  freshness: FreshnessConfig;
  capture: CaptureConfig;
  // Optional so callers must guard: an older Rust backend (predating [voice]) omits it at runtime.
  // The current backend always sends it, but the type stays honest about the config-changed payload.
  voice?: VoiceConfig;
  /** Per-category Sparkle Auto-Approve rules. Optional so callers guard: an older Rust backend
   *  (predating [approvals]) omits it; the current backend always sends it. */
  approvals?: ApprovalsConfig;
  /** Per-project "Done" stage definition (Definable Done & Delivered feature). */
  done: DoneConfig;
  /** Per-project "Delivered" stage definition + detected production-ship signal. */
  delivered: DeliveredConfig;
}
/** The merged effective config plus any non-fatal load warnings (malformed layer, ignored keys). */
export interface EffectiveConfig {
  config: SparkleConfig;
  warnings: string[];
  /** The concurrency limit to ENFORCE: `workers.max_concurrent` narrowed by how many agent-sized
   *  heaps this machine's RAM can hold. Always ≤ max_concurrent. Optional so callers guard: a Rust
   *  backend predating memory-aware concurrency omits it (fall back to `workers.max_concurrent`). */
  effective_max_concurrent?: number;
}
export interface ConfigPaths {
  global: string;
  /** Present only when a project root is in context. */
  project: string | null;
}

/** Effective config for the active project (global + that project's overrides), or the global
 *  layer when no project root is supplied. The startup mirror passes no root (global-only) by
 *  design — see App.tsx; per-project [workflow] overrides are applied by the Rust engine itself. */
export function getConfig(projectRoot?: string | null): Promise<EffectiveConfig> {
  return invoke("get_config", { projectRoot: projectRoot ?? null });
}

/** Set one dotted key (e.g. "workers.max_concurrent") in the global file, preserving comments. */
export function setConfigValue(path: string, value: boolean | number | string): Promise<void> {
  return invoke("set_config_value", { path, value });
}

/** Set several dotted keys in ONE atomic write (one config-changed event). Use for bulk actions
 *  (e.g. All/Off AI features) to avoid the partial-file flicker of separate writes. */
export function setConfigValues(
  values: Record<string, boolean | number | string>,
): Promise<void> {
  return invoke("set_config_values", { values });
}

/** Remove one dotted key from the GLOBAL file (comment-preserving). No-op if the key is absent. */
export function unsetConfigValue(path: string): Promise<void> {
  return invoke("unset_config_value", { path });
}

/** Set one dotted key in a PROJECT's `.sparkle/config.toml` (comment-preserving). */
export function setProjectConfigValue(
  projectRoot: string,
  path: string,
  value: boolean | number | string,
): Promise<void> {
  return invoke("set_project_config_value", { projectRoot, path, value });
}

/** Remove one dotted key from a PROJECT's `.sparkle/config.toml`. No-op if the file/key is absent. */
export function unsetProjectConfigValue(projectRoot: string, path: string): Promise<void> {
  return invoke("unset_project_config_value", { projectRoot, path });
}

/** Validate + overwrite the whole global file (raw editor Save). Rejects invalid TOML. */
export function writeConfigText(text: string): Promise<void> {
  return invoke("write_config_text", { text });
}

/** Overwrite the global file with the commented default template. */
export function resetConfig(): Promise<void> {
  return invoke("reset_config", {});
}

/** Raw text of the global config file (the default template if it doesn't exist yet). */
export function readConfigText(): Promise<string> {
  return invoke("read_config_text", {});
}

/** Resolved global + (optional) per-project config file paths, for "Reveal in Finder". */
export function configFilePaths(projectRoot?: string | null): Promise<ConfigPaths> {
  return invoke("config_file_paths", { projectRoot: projectRoot ?? null });
}

/** Subscribe to live-reload events (fired on hand-edit, in-app write, or reset). Returns the
 *  unlisten fn. Handlers MUST be idempotent — an in-app write emits this twice (the write path
 *  plus the file watcher); the frontend just re-pulls, so duplicates are harmless. */
export function onConfigChanged(cb: (eff: EffectiveConfig) => void): Promise<UnlistenFn> {
  return listen<EffectiveConfig>("config-changed", (e) => cb(e.payload));
}
