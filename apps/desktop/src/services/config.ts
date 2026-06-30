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
  drift: DriftConfig;
}
export interface WorkersConfig {
  max_concurrent: number;
}
export interface AiConfig {
  auto_rename: boolean;
  voice_dictation: boolean;
  brainstorm: boolean;
  composer: boolean;
}
/** Branch/build freshness guardrails (read by the build script + session-start staleness hook). */
export interface FreshnessConfig {
  staleness_warn_commits: number;
  stale_build_block_commits: number;
  require_fresh_branch: boolean;
}
export interface SparkleConfig {
  workflow: WorkflowConfig;
  workers: WorkersConfig;
  ai: AiConfig;
  freshness: FreshnessConfig;
}
/** The merged effective config plus any non-fatal load warnings (malformed layer, ignored keys). */
export interface EffectiveConfig {
  config: SparkleConfig;
  warnings: string[];
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
