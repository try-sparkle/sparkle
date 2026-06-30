//! Editable TOML config — the single source of truth for Sparkle's workflow rules,
//! worker concurrency, and AI feature flags. Replaces constants that were previously
//! hardcoded in Rust + the frontend `settingsStore`. Advanced users hand-edit the file;
//! the in-app settings UI is a friendly editor over the same data.
//! Spec: docs/superpowers/specs/2026-06-29-editable-config-file-design.md
//!
//! Two layered files, both optional:
//!   - global:  `<app_data>/config.toml`         — machine/user prefs (all sections)
//!   - project: `<repo>/.sparkle/config.toml`     — per-repo `[workflow]` overrides only
//! Precedence: **defaults → global → per-project**. Per-project `[workers]`/`[ai]` are
//! ignored (with a warning) because they are machine-wide, not repo-scoped.
//!
//! Robustness contract: a missing file contributes nothing; a *malformed* file is rejected
//! and the last-good effective config stays live (the app never fails over a typo). Unknown
//! keys/sections and out-of-range values are non-fatal warnings, never errors.
//!
//! Concurrency model: the **global** layer (defaults + global file) is cached in a process
//! singleton and live-reloaded by a file watcher (wired in lib.rs). The per-project layer is
//! read on demand via `for_project` — cheap, and avoids watching arbitrary repo paths.

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

// ============================ effective (merged) types =============================
// Every field is non-optional: this is the fully-resolved config the app reads.

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DriftConfig {
    pub behind_nudge: u32,
    pub ahead_nudge: u32,
    pub changed_lines: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkflowConfig {
    pub require_pr: bool,
    pub worktree_isolation: bool,
    pub default_branch: String,
    pub born_fresh_from_base: bool,
    /// After an agent's branch lands on the integration branch, delete the now-merged branch on
    /// close (a SAFE `git branch -d`, which refuses to delete a branch that isn't actually merged).
    /// Default true = keep things tidy; false = keep merged branches around.
    pub delete_merged_branch: bool,
    pub drift: DriftConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkersConfig {
    pub max_concurrent: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AiConfig {
    pub auto_rename: bool,
    pub voice_dictation: bool,
    pub brainstorm: bool,
    pub composer: bool,
    pub suggested_actions: bool,
}

/// Branch/build freshness rules — guardrails against doing work on (or shipping a DMG from) a
/// branch that has fallen far behind `origin/main`. Read by the build script and the session-start
/// staleness hook as well as the app. Per-project overridable (a repo can set its own thresholds).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FreshnessConfig {
    /// Warn (at session start) once the working branch is at least this many commits behind
    /// origin/main, so you rebase before sinking hours into a stale base. 0 disables the warning.
    pub staleness_warn_commits: u32,
    /// Hard cap for `--allow-branch` desktop builds: once the branch is more than this many commits
    /// behind origin/main, the build refuses even with `--allow-branch` and demands an explicit
    /// `BUILD_STALE_OK=1`, so a wildly-stale DMG can't be produced by reflex.
    pub stale_build_block_commits: u32,
    /// Advisory: new work should start from a fresh-from-origin/main branch (e.g. new-feature.sh).
    pub require_fresh_branch: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SparkleConfig {
    pub workflow: WorkflowConfig,
    pub workers: WorkersConfig,
    pub ai: AiConfig,
    pub freshness: FreshnessConfig,
}

impl Default for SparkleConfig {
    fn default() -> Self {
        SparkleConfig {
            workflow: WorkflowConfig {
                require_pr: true,
                worktree_isolation: true,
                // Empty = auto-detect the integration branch from git (origin/HEAD → main →
                // master → current). A non-empty value is an explicit override. This lets a
                // `master`/`develop` repo work with no config while still allowing a pin.
                default_branch: String::new(),
                born_fresh_from_base: true,
                delete_merged_branch: true,
                drift: DriftConfig {
                    behind_nudge: 10,
                    ahead_nudge: 15,
                    changed_lines: 1000,
                },
            },
            // NOTE: raised from the legacy settingsStore default of 4 (design decision, 2026-06-29).
            workers: WorkersConfig { max_concurrent: 20 },
            ai: AiConfig {
                auto_rename: true,
                voice_dictation: true,
                brainstorm: true,
                composer: true,
                suggested_actions: true,
            },
            freshness: FreshnessConfig {
                // Keep these in sync with the bash fallback in scripts/lib/sparkle-config.sh.
                staleness_warn_commits: 25,
                stale_build_block_commits: 25,
                require_fresh_branch: true,
            },
        }
    }
}

/// The merged config plus any non-fatal warnings produced while loading it.
#[derive(Debug, Clone, Serialize)]
pub struct EffectiveConfig {
    pub config: SparkleConfig,
    pub warnings: Vec<String>,
}

// ============================ partial (parsed-layer) types =========================
// All-Option mirror of the schema: distinguishes "absent" from "set to the default value".
// serde/toml ignores unknown fields by default, so a forward-compatible key never errors.

#[derive(Debug, Default, Deserialize)]
struct PartialDrift {
    behind_nudge: Option<u32>,
    ahead_nudge: Option<u32>,
    changed_lines: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialWorkflow {
    require_pr: Option<bool>,
    worktree_isolation: Option<bool>,
    default_branch: Option<String>,
    born_fresh_from_base: Option<bool>,
    delete_merged_branch: Option<bool>,
    drift: Option<PartialDrift>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialWorkers {
    max_concurrent: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialAi {
    auto_rename: Option<bool>,
    voice_dictation: Option<bool>,
    brainstorm: Option<bool>,
    composer: Option<bool>,
    suggested_actions: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialFreshness {
    staleness_warn_commits: Option<u32>,
    stale_build_block_commits: Option<u32>,
    require_fresh_branch: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialConfig {
    workflow: Option<PartialWorkflow>,
    workers: Option<PartialWorkers>,
    ai: Option<PartialAi>,
    freshness: Option<PartialFreshness>,
}

/// Parse one layer's TOML text into a partial config. Err carries a human-readable reason —
/// the full Display (which includes the line/column span), since the raw-editor Save surfaces
/// this string straight to the user, who needs to know *where* the syntax error is.
fn parse_layer(text: &str) -> Result<PartialConfig, String> {
    toml::from_str::<PartialConfig>(text).map_err(|e| e.to_string())
}

// ============================ merge + validate (pure) ==============================

fn apply_workflow(into: &mut WorkflowConfig, p: Option<PartialWorkflow>) {
    let Some(p) = p else { return };
    if let Some(v) = p.require_pr {
        into.require_pr = v;
    }
    if let Some(v) = p.worktree_isolation {
        into.worktree_isolation = v;
    }
    if let Some(v) = p.default_branch {
        into.default_branch = v;
    }
    if let Some(v) = p.born_fresh_from_base {
        into.born_fresh_from_base = v;
    }
    if let Some(v) = p.delete_merged_branch {
        into.delete_merged_branch = v;
    }
    if let Some(d) = p.drift {
        if let Some(v) = d.behind_nudge {
            into.drift.behind_nudge = v;
        }
        if let Some(v) = d.ahead_nudge {
            into.drift.ahead_nudge = v;
        }
        if let Some(v) = d.changed_lines {
            into.drift.changed_lines = v;
        }
    }
}

fn apply_workers(into: &mut WorkersConfig, p: Option<PartialWorkers>) {
    if let Some(PartialWorkers { max_concurrent: Some(v) }) = p {
        into.max_concurrent = v;
    }
}

fn apply_freshness(into: &mut FreshnessConfig, p: Option<PartialFreshness>) {
    let Some(p) = p else { return };
    if let Some(v) = p.staleness_warn_commits {
        into.staleness_warn_commits = v;
    }
    if let Some(v) = p.stale_build_block_commits {
        into.stale_build_block_commits = v;
    }
    if let Some(v) = p.require_fresh_branch {
        into.require_fresh_branch = v;
    }
}

fn apply_ai(into: &mut AiConfig, p: Option<PartialAi>) {
    let Some(p) = p else { return };
    if let Some(v) = p.auto_rename {
        into.auto_rename = v;
    }
    if let Some(v) = p.voice_dictation {
        into.voice_dictation = v;
    }
    if let Some(v) = p.brainstorm {
        into.brainstorm = v;
    }
    if let Some(v) = p.composer {
        into.composer = v;
    }
    if let Some(v) = p.suggested_actions {
        into.suggested_actions = v;
    }
}

/// Clamp out-of-range values into something usable; collect a warning for each adjustment.
/// Never errors — a bad value degrades gracefully rather than breaking the app.
fn validate(cfg: &mut SparkleConfig, warnings: &mut Vec<String>) {
    if cfg.workers.max_concurrent < 1 {
        warnings.push("[workers].max_concurrent must be >= 1; using 1".to_string());
        cfg.workers.max_concurrent = 1;
    }
    // Incoherent if a build would be blocked before staleness is even warned about.
    let f = &cfg.freshness;
    if f.stale_build_block_commits < f.staleness_warn_commits {
        warnings.push(format!(
            "[freshness].stale_build_block_commits ({}) is below staleness_warn_commits ({}); a \
             build would be blocked before you're even warned",
            f.stale_build_block_commits, f.staleness_warn_commits
        ));
    }
}

/// Build the effective config from optional layer texts. `is_global` distinguishes the two
/// callers' warning wording and enforces the "per-project `[workers]`/`[ai]` are ignored" rule.
///
/// Returns `(config, warnings, hard_error)`. `hard_error` is true when a *provided* layer failed
/// to parse — the watcher uses it to keep the last-good config live instead of swapping.
fn build_effective(
    base: SparkleConfig,
    global: Option<&str>,
    project: Option<&str>,
) -> (SparkleConfig, Vec<String>, bool) {
    let mut cfg = base;
    let mut warnings = Vec::new();
    let mut hard_error = false;

    if let Some(text) = global {
        match parse_layer(text) {
            Ok(p) => {
                apply_workflow(&mut cfg.workflow, p.workflow);
                apply_workers(&mut cfg.workers, p.workers);
                apply_ai(&mut cfg.ai, p.ai);
                apply_freshness(&mut cfg.freshness, p.freshness);
            }
            Err(e) => {
                warnings.push(format!("global config.toml has a syntax error and was ignored: {e}"));
                hard_error = true;
            }
        }
    }

    if let Some(text) = project {
        match parse_layer(text) {
            Ok(p) => {
                if p.workers.is_some() {
                    warnings.push(
                        "[workers] in a per-project .sparkle/config.toml is ignored — it is a \
                         machine-wide setting; set it in the global config.toml"
                            .to_string(),
                    );
                }
                if p.ai.is_some() {
                    warnings.push(
                        "[ai] in a per-project .sparkle/config.toml is ignored — it is a \
                         machine-wide setting; set it in the global config.toml"
                            .to_string(),
                    );
                }
                // Per-project layer: [workflow] and [freshness] are repo-scoped and may override.
                apply_workflow(&mut cfg.workflow, p.workflow);
                apply_freshness(&mut cfg.freshness, p.freshness);
            }
            Err(e) => {
                warnings.push(format!(
                    "per-project .sparkle/config.toml has a syntax error and was ignored: {e}"
                ));
                hard_error = true;
            }
        }
    }

    validate(&mut cfg, &mut warnings);
    (cfg, warnings, hard_error)
}

// ============================ file paths ==========================================

/// Global config file: `<app_data>/config.toml`.
pub fn global_path(app_data: &Path) -> PathBuf {
    app_data.join("config.toml")
}

/// Per-project config file: `<repo>/.sparkle/config.toml`.
pub fn project_path(repo_root: &str) -> PathBuf {
    Path::new(repo_root).join(".sparkle").join("config.toml")
}

fn read_if_exists(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

// ============================ process singleton ===================================
// Caches the GLOBAL layer (defaults + global file). The watcher refreshes it; worktree.rs and
// the command layer read it. Per-project overlays are applied on top, on demand, by `for_project`.

static GLOBAL: OnceLock<RwLock<EffectiveConfig>> = OnceLock::new();

fn cell() -> &'static RwLock<EffectiveConfig> {
    GLOBAL.get_or_init(|| {
        RwLock::new(EffectiveConfig { config: SparkleConfig::default(), warnings: Vec::new() })
    })
}

/// Load the global file from disk and replace the cached global layer. Called at startup and
/// on every watcher event. On a syntax error the previous cached config is KEPT (last-good
/// stays live); only the warnings are refreshed so the UI can surface the problem.
pub fn reload_global(app_data: &Path) -> EffectiveConfig {
    let text = read_if_exists(&global_path(app_data));
    let (cfg, warnings, hard_error) =
        build_effective(SparkleConfig::default(), text.as_deref(), None);
    let lock = cell();
    // Poison-tolerant: a panic in a prior writer must not permanently wedge config reloads for the
    // rest of the process. Recover the inner guard and carry on; the last-good cached config is
    // preserved on a hard parse error below. Matches accounts.rs / transcribe.rs / dictation.rs.
    let mut guard = lock.write().unwrap_or_else(|e| e.into_inner());
    if hard_error {
        // Keep the last-good config; only update the warning list.
        guard.warnings = warnings;
    } else {
        *guard = EffectiveConfig { config: cfg, warnings };
    }
    guard.clone()
}

/// The cached global EffectiveConfig (config + warnings), for `get_config` with no project.
pub fn current_effective() -> EffectiveConfig {
    // Poison-tolerant read: a panicking writer must not brick every future config read.
    cell().read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Effective config for a specific project: the cached global layer with that project's
/// `.sparkle/config.toml` overlaid (its `[workflow]` only). Reads the project file fresh.
pub fn for_project(repo_root: &str) -> EffectiveConfig {
    // One snapshot of the cached global layer, so the config and its warnings can't be spliced
    // across a concurrent watcher reload.
    let global = current_effective();
    let project_text = read_if_exists(&project_path(repo_root));
    // `global.config` already has defaults+global folded in, so pass only the project layer here.
    let (cfg, mut warnings, _) = build_effective(global.config, None, project_text.as_deref());
    // Carry forward any standing global warnings so the UI sees them in a project context too.
    let mut all = global.warnings;
    all.append(&mut warnings);
    EffectiveConfig { config: cfg, warnings: all }
}

// ============================ comment-preserving writes ===========================

/// The commented default file `reset_config` writes. Mirrors `SparkleConfig::default()`.
pub const DEFAULT_TEMPLATE: &str = r#"# ======================================================================================
# Sparkle configuration
# ======================================================================================
# This file is the single source of truth for how Sparkle behaves — the rules that used to
# be buried in code. Advanced users are meant to hand-edit it. The in-app settings UI reads
# from and writes back to this same file, and any comments or formatting you add here are
# preserved when the app changes a value.
#
# WHERE THIS LIVES (two layers, both optional):
#   • Global  — this file, in Sparkle's app-data dir. Applies to every project. Holds your
#               machine-wide preferences ([workers], [ai]) plus default rules.
#   • Project — a `.sparkle/config.toml` checked into a repo. Overrides ONLY the repo-scoped
#               rules ([workflow] and [freshness]) for that one project, and travels with the
#               repo so a team shares them. [workers]/[ai] there are ignored (they're per-machine).
#
# PRECEDENCE: built-in defaults  →  this global file  →  a project's .sparkle/config.toml.
#
# SAFETY: a missing file just uses the defaults below. A typo that makes the file invalid is
# rejected with a message (in the in-app editor) and your last good settings keep running —
# the app never fails to start over a bad edit. Edits take effect live (no restart needed).
# ======================================================================================

# --- How agents land their work -------------------------------------------------------
[workflow]
# true  = an agent opens a Pull Request and you merge it (safer, reviewable).
# false = an agent may push straight to the base branch (faster, less ceremony).
require_pr           = true
# true = every agent works inside its own isolated git worktree/branch, so agents can never
# clobber each other's files. Turning this off is not recommended.
worktree_isolation   = true
# The branch new agents are created from. Leave commented to auto-detect it from git
# (origin/HEAD, then main, then master). Uncomment to PIN a specific base for this project,
# e.g. a repo whose integration branch is "develop":
# default_branch     = "main"
# true = cut each agent's branch from a FRESH copy of the base (fetched first), so agents
# start from the latest work rather than a stale local copy.
born_fresh_from_base = true
# true = when you close a build agent whose branch has landed on the integration branch, delete
# the now-merged branch (a SAFE delete that refuses if the branch isn't actually merged). false =
# keep merged branches around.
delete_merged_branch = true

# --- When to nudge you that an agent's branch has drifted from its base ----------------
[workflow.drift]
behind_nudge   = 10      # warn once the base branch is this many commits AHEAD of the agent
ahead_nudge    = 15      # suggest "land or split" once the agent is this many commits ahead
changed_lines  = 1000    # ...or once the agent has changed this many lines (whichever first)

# --- How many agents run at once (per-machine; ignored in a project file) --------------
[workers]
# The most agents/worktrees an orchestrator may run in parallel. Higher = more parallel work
# and more token spend. Floored at 1; there is no hard upper limit.
max_concurrent = 20

# --- AI features (per-machine; each degrades to a non-AI baseline when off) ------------
[ai]
auto_rename     = true   # auto-name worker agents from the work they're doing
voice_dictation = true   # use the cloud (Deepgram) STT for dictation; off = on-device model
brainstorm      = true   # show the Think agent (chat with Chief)
composer        = true   # use the AI-enhanced composer; off = a plain terminal input
# suggested_actions = true   # show one-click suggested action buttons in the composer

# --- Branch/build freshness guardrails (repo-scoped; overridable in a project file) ----
# These stop work from being done on — or a DMG from being shipped from — a branch that has
# fallen far behind origin/main (the stale-build trap).
[freshness]
# Warn at session start once your branch is at least this many commits behind origin/main,
# so you rebase BEFORE sinking hours into a stale base. Set to 0 to disable the warning.
staleness_warn_commits    = 25
# A desktop build with --allow-branch normally proceeds even if slightly behind. But once the
# branch is more than this many commits behind origin/main, the build refuses unless you set
# BUILD_STALE_OK=1 — so a wildly-stale DMG can't be produced by reflex.
stale_build_block_commits = 25
# Advisory reminder that new work should start from a fresh-from-origin/main branch
# (e.g. scripts/new-feature.sh), not an inherited stale one.
require_fresh_branch      = true
"#;

/// Convert a JSON scalar from the frontend into a `toml_edit` value. Only bool / integer /
/// string are valid config value types; anything else is rejected.
fn json_to_toml_value(v: &serde_json::Value) -> Result<toml_edit::Value, String> {
    use serde_json::Value as J;
    match v {
        J::Bool(b) => Ok((*b).into()),
        J::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i.into())
            } else {
                Err("numeric config values must be integers".to_string())
            }
        }
        J::String(s) => Ok(s.as_str().into()),
        _ => Err("config values must be a boolean, integer, or string".to_string()),
    }
}

/// Surgically set a dotted `path` (e.g. `workers.max_concurrent`) in a TOML document,
/// creating intermediate tables as needed, WITHOUT disturbing surrounding comments/formatting.
fn set_dotted(doc: &mut toml_edit::DocumentMut, path: &str, value: toml_edit::Value) -> Result<(), String> {
    let parts: Vec<&str> = path.split('.').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Err("empty config path".to_string());
    }
    let mut item: &mut toml_edit::Item = doc.as_item_mut();
    for part in &parts[..parts.len() - 1] {
        match item.get(part) {
            // Implicit tables keep the file tidy (only `[workflow.drift]` appears, not `[workflow]`).
            None => {
                let mut t = toml_edit::Table::new();
                t.set_implicit(true);
                item[*part] = toml_edit::Item::Table(t);
            }
            // A malformed path that tries to descend through a scalar (e.g. `workflow.require_pr.x`)
            // would otherwise panic in toml_edit's IndexMut — return an error instead.
            Some(existing) if !existing.is_table() => {
                return Err(format!("config path '{path}' traverses '{part}', which is not a table"));
            }
            Some(_) => {}
        }
        item = &mut item[*part];
    }
    let last = parts[parts.len() - 1];
    item[last] = toml_edit::Item::Value(value);
    Ok(())
}

/// Read the current global file (or the default template if absent) as an editable document.
fn load_document(app_data: &Path) -> toml_edit::DocumentMut {
    let text = read_if_exists(&global_path(app_data)).unwrap_or_else(|| DEFAULT_TEMPLATE.to_string());
    text.parse::<toml_edit::DocumentMut>()
        .unwrap_or_else(|_| DEFAULT_TEMPLATE.parse().expect("default template is valid TOML"))
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create config dir: {e}"))?;
    }
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("write config: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("replace config: {e}"))
}

/// Set one key in the global config file, preserving comments/formatting. `path` is dotted.
pub fn set_value(app_data: &Path, path: &str, value: &serde_json::Value) -> Result<(), String> {
    let v = json_to_toml_value(value)?;
    let mut doc = load_document(app_data);
    set_dotted(&mut doc, path, v)?;
    let text = doc.to_string();
    // Validate the edited document against the schema BEFORE persisting (mirrors write_text). A
    // type/range mismatch the JSON shape can't catch — a string into `require_pr`, a negative or
    // oversized `max_concurrent` — is rejected here so a bad in-app write can never corrupt the
    // on-disk file (which would otherwise fail every future load and silently reset all settings).
    parse_layer(&text)
        .map_err(|e| format!("rejected: that change would make config.toml invalid: {e}"))?;
    write_atomic(&global_path(app_data), &text)
}

/// Set several dotted keys in ONE read-modify-write of the global file, validating the whole
/// result once. Used for bulk UI actions (e.g. the All/Off AI-features segment) so only a single
/// `config-changed` fires at a consistent end state — N separate `set_value` calls would each emit
/// mid-bulk, and an intermediate hydrate would read a partially-written file and revert the
/// not-yet-written keys (a visible flicker). All-or-nothing: if any value is invalid the file is
/// left untouched. On duplicate dotted paths the last entry wins (the command's `serde_json::Map`
/// source can't contain duplicates).
pub fn set_values(app_data: &Path, entries: &[(String, serde_json::Value)]) -> Result<(), String> {
    let mut doc = load_document(app_data);
    for (path, value) in entries {
        let v = json_to_toml_value(value)?;
        set_dotted(&mut doc, path, v)?;
    }
    let text = doc.to_string();
    parse_layer(&text)
        .map_err(|e| format!("rejected: that change would make config.toml invalid: {e}"))?;
    write_atomic(&global_path(app_data), &text)
}

/// Validate then overwrite the whole global file (the raw-editor Save). Rejects invalid TOML
/// WITHOUT touching the file or the live config.
pub fn write_text(app_data: &Path, text: &str) -> Result<(), String> {
    parse_layer(text)?; // typed-schema validation; ignores unknown keys, errors on bad types/syntax
    write_atomic(&global_path(app_data), text)
}

/// Reset the global file to the commented default template.
pub fn reset(app_data: &Path) -> Result<(), String> {
    write_atomic(&global_path(app_data), DEFAULT_TEMPLATE)
}

// ============================ Tauri command layer + watcher =======================

use tauri::{AppHandle, Emitter};

/// Resolve `<app_data>` via the existing worktree helper (single source of that path).
fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    crate::worktree::app_data_dir_pub(app)
}

/// Resolved file paths, surfaced to the UI for "Open file" / "Reveal in Finder".
#[derive(Debug, Clone, Serialize)]
pub struct ConfigPaths {
    pub global: String,
    /// Present only when a project root is in context.
    pub project: Option<String>,
}

/// The merged effective config (+ warnings) for the active project, or the global layer when
/// no project root is supplied.
#[tauri::command]
pub fn get_config(project_root: Option<String>) -> EffectiveConfig {
    match project_root {
        Some(root) if !root.trim().is_empty() => for_project(&root),
        _ => current_effective(),
    }
}

/// Resolved global + (optional) per-project config file paths.
#[tauri::command]
pub fn config_file_paths(app: AppHandle, project_root: Option<String>) -> Result<ConfigPaths, String> {
    let ad = app_data(&app)?;
    Ok(ConfigPaths {
        global: global_path(&ad).to_string_lossy().to_string(),
        project: project_root
            .filter(|r| !r.trim().is_empty())
            .map(|r| project_path(&r).to_string_lossy().to_string()),
    })
}

/// Reload the cached global layer and notify the frontend. Shared by every write command and the
/// watcher so a write reflects immediately even before the (async) filesystem event arrives.
fn reload_and_emit(app: &AppHandle, app_data: &Path) {
    let eff = reload_global(app_data);
    let _ = app.emit("config-changed", &eff);
}

/// Set one key in the global config file (comment-preserving). `path` is dotted,
/// e.g. `workers.max_concurrent` or `workflow.drift.behind_nudge`.
#[tauri::command]
pub fn set_config_value(app: AppHandle, path: String, value: serde_json::Value) -> Result<(), String> {
    let ad = app_data(&app)?;
    set_value(&ad, &path, &value)?;
    reload_and_emit(&app, &ad);
    Ok(())
}

/// Set several dotted keys atomically (one write, one event). `values` is a JS object mapping
/// dotted paths to scalar values. Preferred over N `set_config_value` calls for bulk toggles.
#[tauri::command]
pub fn set_config_values(
    app: AppHandle,
    values: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let ad = app_data(&app)?;
    let entries: Vec<(String, serde_json::Value)> = values.into_iter().collect();
    set_values(&ad, &entries)?;
    reload_and_emit(&app, &ad);
    Ok(())
}

/// Validate + overwrite the whole global file (the raw-editor Save). Invalid TOML is rejected
/// without touching the file or the live config.
#[tauri::command]
pub fn write_config_text(app: AppHandle, text: String) -> Result<(), String> {
    let ad = app_data(&app)?;
    write_text(&ad, &text)?;
    reload_and_emit(&app, &ad);
    Ok(())
}

/// Overwrite the global file with the commented default template.
#[tauri::command]
pub fn reset_config(app: AppHandle) -> Result<(), String> {
    let ad = app_data(&app)?;
    reset(&ad)?;
    reload_and_emit(&app, &ad);
    Ok(())
}

/// Read the raw text of the global config file (for the in-app editor). Returns the default
/// template when the file does not exist yet, so the editor always opens with something sensible.
#[tauri::command]
pub fn read_config_text(app: AppHandle) -> Result<String, String> {
    let ad = app_data(&app)?;
    Ok(read_if_exists(&global_path(&ad)).unwrap_or_else(|| DEFAULT_TEMPLATE.to_string()))
}

/// Load the global config at startup and watch it for live reload. Call once from `setup`.
/// The watcher is kept alive for the app's lifetime (dropping it would stop watching).
pub fn init_and_watch(app: &AppHandle) -> Result<(), String> {
    use notify::{RecursiveMode, Watcher};
    let ad = app_data(app)?;
    // The dir must exist before we can watch it (first launch may predate any worktree creation).
    std::fs::create_dir_all(&ad).map_err(|e| format!("create app_data: {e}"))?;
    // Initial load so `current()` is correct before the first event.
    let _ = reload_global(&ad);

    let app_handle = app.clone();
    let watch_dir = ad.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // We watch the whole app_data dir (config.toml lives directly under it); react only to
        // events touching config.toml so worktree churn in sibling dirs doesn't reload.
        let touches_config = event
            .paths
            .iter()
            .any(|p| p.file_name().map(|n| n == "config.toml").unwrap_or(false));
        if touches_config {
            reload_and_emit(&app_handle, &watch_dir);
        }
    })
    .map_err(|e| format!("config watcher init: {e}"))?;
    watcher
        .watch(&ad, RecursiveMode::NonRecursive)
        .map_err(|e| format!("config watch {}: {e}", ad.display()))?;
    // Keep the watcher alive for the process lifetime.
    Box::leak(Box::new(watcher));
    Ok(())
}

// ============================ tests ===============================================

#[cfg(test)]
mod tests {
    use super::*;

    fn effective(global: Option<&str>, project: Option<&str>) -> (SparkleConfig, Vec<String>, bool) {
        build_effective(SparkleConfig::default(), global, project)
    }

    #[test]
    fn defaults_when_no_files() {
        let (cfg, warns, hard) = effective(None, None);
        assert_eq!(cfg, SparkleConfig::default());
        assert_eq!(cfg.workers.max_concurrent, 20);
        assert!(warns.is_empty());
        assert!(!hard);
    }

    #[test]
    fn global_overrides_defaults_field_by_field() {
        let g = r#"
            [workflow]
            require_pr = false
            [workers]
            max_concurrent = 8
        "#;
        let (cfg, _, _) = effective(Some(g), None);
        assert!(!cfg.workflow.require_pr);
        assert_eq!(cfg.workers.max_concurrent, 8);
        // Untouched fields keep their defaults.
        assert!(cfg.workflow.worktree_isolation);
        assert_eq!(cfg.workflow.default_branch, ""); // empty = auto-detect
        assert!(cfg.ai.auto_rename);
    }

    #[test]
    fn project_overrides_global_for_workflow_only() {
        let g = r#"
            [workflow]
            require_pr = true
            default_branch = "main"
        "#;
        let p = r#"
            [workflow]
            require_pr = false
            default_branch = "develop"
        "#;
        // Precedence: project beats global for [workflow].
        let (cfg, _, _) = effective(Some(g), Some(p));
        assert!(!cfg.workflow.require_pr);
        assert_eq!(cfg.workflow.default_branch, "develop");
    }

    #[test]
    fn project_workers_and_ai_are_ignored_with_warning() {
        let p = r#"
            [workers]
            max_concurrent = 99
            [ai]
            auto_rename = false
        "#;
        let (cfg, warns, _) = effective(None, Some(p));
        // Per-project machine prefs do NOT apply.
        assert_eq!(cfg.workers.max_concurrent, 20);
        assert!(cfg.ai.auto_rename);
        assert!(warns.iter().any(|w| w.contains("[workers]")));
        assert!(warns.iter().any(|w| w.contains("[ai]")));
    }

    #[test]
    fn malformed_layer_is_a_hard_error_keeping_defaults() {
        let g = "this is not valid = = toml";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(hard);
        assert!(warns.iter().any(|w| w.contains("syntax error")));
        // Falls back to defaults for that layer rather than panicking.
        assert_eq!(cfg, SparkleConfig::default());
    }

    #[test]
    fn unknown_keys_are_ignored_not_errors() {
        let g = r#"
            [workflow]
            require_pr = false
            some_future_key = "ok"
            [brand_new_section]
            whatever = 1
        "#;
        let (cfg, _, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(!cfg.workflow.require_pr);
    }

    #[test]
    fn validate_floors_max_concurrent_at_one() {
        let g = "[workers]\nmax_concurrent = 0\n";
        let (cfg, warns, _) = effective(Some(g), None);
        assert_eq!(cfg.workers.max_concurrent, 1);
        assert!(warns.iter().any(|w| w.contains("max_concurrent")));
    }

    #[test]
    fn drift_subtable_overrides() {
        let g = "[workflow.drift]\nbehind_nudge = 3\n";
        let (cfg, _, _) = effective(Some(g), None);
        assert_eq!(cfg.workflow.drift.behind_nudge, 3);
        // Sibling drift fields keep defaults.
        assert_eq!(cfg.workflow.drift.ahead_nudge, 15);
        assert_eq!(cfg.workflow.drift.changed_lines, 1000);
    }

    #[test]
    fn freshness_defaults_and_overrides() {
        let (cfg, _, _) = effective(None, None);
        assert_eq!(cfg.freshness.staleness_warn_commits, 25);
        assert_eq!(cfg.freshness.stale_build_block_commits, 25);
        assert!(cfg.freshness.require_fresh_branch);

        // [freshness] is per-project overridable (like [workflow]).
        let p = "[freshness]\nstaleness_warn_commits = 5\nrequire_fresh_branch = false\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert_eq!(cfg.freshness.staleness_warn_commits, 5);
        assert!(!cfg.freshness.require_fresh_branch);
        // Untouched freshness field keeps its default; no "ignored" warning (unlike [workers]/[ai]).
        assert_eq!(cfg.freshness.stale_build_block_commits, 25);
        assert!(warns.is_empty());
    }

    #[test]
    fn validate_warns_when_block_is_below_warn() {
        // block (5) < warn (25 default) is incoherent — surface a non-fatal warning.
        let g = "[freshness]\nstale_build_block_commits = 5\n";
        let (_, warns, _) = effective(Some(g), None);
        assert!(warns.iter().any(|w| w.contains("stale_build_block_commits")));
    }

    #[test]
    fn default_template_parses_to_defaults() {
        // The reset template must round-trip to exactly the built-in defaults.
        let (cfg, warns, hard) = effective(Some(DEFAULT_TEMPLATE), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert_eq!(cfg, SparkleConfig::default());
    }

    #[test]
    fn set_dotted_preserves_comments() {
        let src = "# keep me\n[workers]\nmax_concurrent = 20 # inline note\n";
        let mut doc = src.parse::<toml_edit::DocumentMut>().unwrap();
        set_dotted(&mut doc, "workers.max_concurrent", 5i64.into()).unwrap();
        let out = doc.to_string();
        assert!(out.contains("# keep me"), "leading comment preserved");
        assert!(out.contains("max_concurrent = 5"), "value updated");
    }

    #[test]
    fn set_dotted_creates_nested_table() {
        let mut doc = "".parse::<toml_edit::DocumentMut>().unwrap();
        set_dotted(&mut doc, "workflow.drift.behind_nudge", 7i64.into()).unwrap();
        let (cfg, _, hard) = effective(Some(&doc.to_string()), None);
        assert!(!hard);
        assert_eq!(cfg.workflow.drift.behind_nudge, 7);
    }

    #[test]
    fn json_scalar_conversion() {
        assert!(json_to_toml_value(&serde_json::json!(true)).is_ok());
        assert!(json_to_toml_value(&serde_json::json!(5)).is_ok());
        assert!(json_to_toml_value(&serde_json::json!("main")).is_ok());
        // Floats and compound values are rejected.
        assert!(json_to_toml_value(&serde_json::json!(1.5)).is_err());
        assert!(json_to_toml_value(&serde_json::json!([1, 2])).is_err());
    }

    #[test]
    fn write_text_rejects_invalid_toml() {
        // parse_layer is the validator write_text uses; a bad type must error.
        assert!(parse_layer("[workers]\nmax_concurrent = \"not a number\"\n").is_err());
        assert!(parse_layer(DEFAULT_TEMPLATE).is_ok());
    }

    // ---- filesystem-facing write helpers (tempdir) -------------------------------

    #[test]
    fn set_value_writes_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        set_value(ad, "workers.max_concurrent", &serde_json::json!(7)).unwrap();
        let text = std::fs::read_to_string(global_path(ad)).unwrap();
        let (cfg, _, hard) = effective(Some(&text), None);
        assert!(!hard);
        assert_eq!(cfg.workers.max_concurrent, 7);
    }

    #[test]
    fn set_value_rejects_corrupting_writes_and_leaves_file_intact() {
        // Regression for roborev 16792/16793: an in-app write that would make config.toml
        // unparsable must be rejected and the prior good file left byte-for-byte intact.
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        reset(ad).unwrap();
        let before = std::fs::read_to_string(global_path(ad)).unwrap();
        // String into a bool field.
        assert!(set_value(ad, "workflow.require_pr", &serde_json::json!("yes")).is_err());
        // Negative into u32 max_concurrent.
        assert!(set_value(ad, "workers.max_concurrent", &serde_json::json!(-5)).is_err());
        // Malformed path traversing a scalar (set_dotted guard).
        assert!(set_value(ad, "workflow.require_pr.nested", &serde_json::json!(true)).is_err());
        let after = std::fs::read_to_string(global_path(ad)).unwrap();
        assert_eq!(before, after, "file must be untouched after a rejected write");
    }

    #[test]
    fn write_text_persists_valid_rejects_invalid_keeping_prior() {
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        write_text(ad, DEFAULT_TEMPLATE).unwrap();
        let before = std::fs::read_to_string(global_path(ad)).unwrap();
        assert!(before.contains("[workflow]"));
        assert!(write_text(ad, "max_concurrent = = bad").is_err());
        assert_eq!(before, std::fs::read_to_string(global_path(ad)).unwrap());
    }

    #[test]
    fn reset_writes_the_default_template() {
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        reset(ad).unwrap();
        assert_eq!(std::fs::read_to_string(global_path(ad)).unwrap(), DEFAULT_TEMPLATE);
    }

    #[test]
    fn set_values_writes_all_keys_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        reset(ad).unwrap();
        set_values(
            ad,
            &[
                ("ai.auto_rename".to_string(), serde_json::json!(false)),
                ("ai.composer".to_string(), serde_json::json!(false)),
                ("workers.max_concurrent".to_string(), serde_json::json!(3)),
            ],
        )
        .unwrap();
        let text = std::fs::read_to_string(global_path(ad)).unwrap();
        let (cfg, _, hard) = effective(Some(&text), None);
        assert!(!hard);
        assert!(!cfg.ai.auto_rename);
        assert!(!cfg.ai.composer);
        assert_eq!(cfg.workers.max_concurrent, 3);
        // Untouched key keeps its value.
        assert!(cfg.ai.brainstorm);
    }

    #[test]
    fn set_values_is_all_or_nothing_on_a_bad_value() {
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        reset(ad).unwrap();
        let before = std::fs::read_to_string(global_path(ad)).unwrap();
        // One good key + one type-mismatched key → the whole batch is rejected, file untouched.
        let err = set_values(
            ad,
            &[
                ("ai.auto_rename".to_string(), serde_json::json!(false)),
                ("workers.max_concurrent".to_string(), serde_json::json!("nope")),
            ],
        );
        assert!(err.is_err());
        assert_eq!(before, std::fs::read_to_string(global_path(ad)).unwrap());
    }

    #[test]
    fn load_document_falls_back_to_template_on_unparseable_toml() {
        // FIX 2 regression: a corrupt on-disk config.toml must not panic load_document — it falls
        // back to the (valid) default template so the in-app editor still opens with something sane.
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        std::fs::write(global_path(ad), "this is = = not valid toml [[[").unwrap();
        let doc = load_document(ad); // must not panic
        // The fallback document is itself valid and parses to the built-in defaults.
        let (cfg, _, hard) = effective(Some(&doc.to_string()), None);
        assert!(!hard, "fallback document must be valid TOML");
        assert_eq!(cfg, SparkleConfig::default());
    }

    #[test]
    fn config_lock_recovers_after_poison() {
        // Poison the process-wide config RwLock by panicking while holding the write guard, then
        // assert the poison-tolerant accessors still function. Without the recovery, every future
        // get_config/reload would panic for the rest of the process (a permanently wedged command).
        let _ = std::panic::catch_unwind(|| {
            let _g = cell().write().unwrap();
            panic!("simulated panic while holding the config write lock");
        });
        // Reader path must not propagate the poison.
        let _ = current_effective();
        // Writer path (reload) must not propagate the poison either.
        let dir = tempfile::tempdir().unwrap();
        let _ = reload_global(dir.path());
    }
}
