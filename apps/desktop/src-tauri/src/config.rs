//! Editable TOML config — the single source of truth for Sparkle's workflow rules,
//! worker concurrency, and AI feature flags. Replaces constants that were previously
//! hardcoded in Rust + the frontend `settingsStore`. Advanced users hand-edit the file;
//! the in-app settings UI is a friendly editor over the same data.
//! Spec: docs/superpowers/specs/2026-06-29-editable-config-file-design.md
//!
//! Two layered files, both optional:
//!   - global:  `<app_data>/config.toml`         — machine/user prefs (all sections)
//!   - project: `<repo>/.sparkle/config.toml`     — per-repo `[workflow]` overrides only
//!
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
    /// The user's requested ceiling on parallel agents. This is a CEILING only — the value the app
    /// actually enforces is `EffectiveConfig::effective_max_concurrent`, which additionally caps
    /// concurrency at what installed RAM can hold (see `memory_aware_concurrency`).
    pub max_concurrent: u32,
    /// Per-agent V8 old-space cap in MiB, applied as `NODE_OPTIONS=--max-old-space-size=<n>` on
    /// every PTY child (pty.rs). 0 = opt out (agents then use V8's own ~4 GiB default, which is
    /// exactly the runaway that jetsam-killed a machine — see sparkle-01xv).
    pub agent_heap_mb: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AiConfig {
    pub auto_rename: bool,
    pub voice_dictation: bool,
    pub brainstorm: bool,
    pub composer: bool,
    pub suggested_actions: bool,
    /// Master switch for Sparkle Auto-Approve (nudging + auto-answering Claude Code permission
    /// prompts). Default true. By default every non-destructive category ([approvals] below) ships
    /// `"always"`, so with this on a fresh install auto-answers skill/edit/tool/web/other prompts
    /// (bash still asks). Off disables ALL nudging AND all auto-answering regardless of [approvals].
    pub auto_approve: bool,
}

/// Per-category Sparkle Auto-Approve rules. Each value is `"always"` (auto-approve that class of
/// Claude Code permission prompt) or `"never"` (ask, but stop nudging); absent (None) = ask + nudge.
/// Global `[approvals]` = all-projects rules; a project `.sparkle/config.toml [approvals]` overrides
/// per category (project value beats global). See the design spec.
///
/// DEFAULT (see `impl Default` below): everything EXCEPT `bash` ships `"always"`, so a fresh install
/// never blocks on a skill / edit / tool-call / web-request / other permission prompt out of the box.
/// `bash` deliberately stays ask-each-time — auto-approving commands also auto-approves destructive
/// ones (`rm -rf`, …), so it's the one category a user must opt into explicitly. The master switch
/// (`ai.auto_approve`, default on) still governs whether ANY of this fires; turning it off, or
/// setting a category to `"never"`, restores the old ask-each-time behavior.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ApprovalsConfig {
    pub skill: Option<String>,
    pub bash: Option<String>,
    pub edit: Option<String>,
    pub mcp: Option<String>,
    pub fetch: Option<String>,
    pub other: Option<String>,
}

impl Default for ApprovalsConfig {
    fn default() -> Self {
        // Ship auto-approve ON for every non-destructive category so users aren't blocked by
        // permission prompts out of the box. `bash` stays None (ask each time) because
        // auto-approving commands would also auto-approve destructive ones.
        let always = || Some("always".to_string());
        ApprovalsConfig {
            skill: always(),
            bash: None,
            edit: always(),
            mcp: always(),
            fetch: always(),
            other: always(),
        }
    }
}

/// Opinionated non-AI tools Sparkle uses (surfaced in the ⋯ Settings → "Tools" pane). Machine-wide
/// (like [ai]): a per-project value is ignored with a warning. Each bool default true = the tool
/// ships on for every new install; false = that tool is used nowhere in Sparkle. Chief/Deepgram are
/// NOT here — they stay in [ai] (brainstorm / voice_dictation) so there's no duplication.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ToolsConfig {
    /// Anonymous usage analytics + masked session replay (PostHog). Off sends nothing.
    pub analytics: bool,
    /// The in-repo work graph behind the Plan board (Beads / `bd`). Off hides the board + skips `bd`.
    pub beads: bool,
    /// Import a project straight from your GitHub repositories. Off hides the GitHub import path.
    pub github: bool,
    /// Opinionated quality guardrails for the code Sparkle's agents write in your project: run the
    /// project's tests + typecheck before committing, prefer test-first, and never call a red build
    /// "done". On (default) appends the guardrails workflow to every coding agent's system prompt;
    /// off omits it. Adaptive — strict where a test setup exists, a nudge where one doesn't.
    pub guardrails: bool,
    /// The roborev per-commit AI code-review daemon. On (default) installs + runs reviews on your
    /// BUILD-agent commits using your existing `claude login`; off tears the daemon down and stops
    /// reviewing.
    pub roborev: bool,
}

/// roborev machine-wide state that isn't a simple on/off tool toggle. Machine-wide (like [tools]):
/// a per-project value is ignored with a warning.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RoborevConfig {
    /// roborev first-run consent — whether the one-time "review your commits?" modal has been
    /// resolved. Default false; set true once the user picks Enable or Not-now.
    pub consent_prompted: bool,
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

/// Pre-warmed git worktree pool. At idle, Sparkle parks a few detached-HEAD worktrees checked out
/// to the base commit; a spawn then CLAIMS one (a near-instant `git worktree move` + branch create)
/// instead of paying the multi-second `git worktree add` on the critical path. Repo-scoped +
/// per-project overridable (like [freshness]) so a big repo can tune its own pool depth. A pure
/// optimization: disabling it, an empty pool, or any claim failure all fall back to the old cut.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct WorktreePoolConfig {
    /// Master switch. false = never pre-warm; every spawn cuts its worktree inline (the old path).
    pub enabled: bool,
    /// How many parked worktrees to keep ready per project. 0 disables warming (⇒ always falls back).
    pub size: u32,
}

/// Menu-bar capture flow. Machine-wide (like [workers]/[ai]): the OS registers ONE global
/// hotkey per machine, so a per-project value is meaningless and ignored with a warning.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CaptureConfig {
    /// Global accelerator toggling the menu-bar popover (tauri-plugin-global-shortcut
    /// syntax, e.g. "ctrl+shift+r", "alt+f9"). Unparseable/taken → warn + no shortcut.
    pub popover_shortcut: String,
}

/// Voice controls. Machine-wide (like [workers]/[ai]/[capture]): the wake/stop words and the
/// submit-listening behavior are per-user preferences, so a per-project value is ignored with a
/// warning. The DEFAULT words drive the tuned "sparkle" wake engine byte-for-byte; a custom word
/// switches the matcher to a generic fuzzy path (see voice/wakeWords.ts).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VoiceConfig {
    /// Spoken phrase that wakes dictation (default "Hey Sparkle").
    pub wake_word: String,
    /// Spoken phrase that ends active dictation (default "Sparkle, stop").
    pub stop_word: String,
    /// When a prompt is submitted, drop from active dictation back to passive wake-word listening
    /// (the mic stays on). Default true = pause listening on submit.
    pub pause_on_submit: bool,
}

/// One criterion in a stage definition. `kind` is "auto" (Sparkle observes it via `signal`)
/// or "manual" (a human ticks it). `signal` is a known AutoSignal id, required iff kind="auto".
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StageCriterion {
    pub text: String,
    pub kind: String,
    pub signal: Option<String>,
}

/// Per-project definition of what "Done" means. Undefined = None description + empty criteria.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DoneConfig {
    pub description: Option<String>,
    pub criteria: Vec<StageCriterion>,
}

/// Per-project definition of what "Delivered" means, plus the DETECTED production-ship signal
/// (method/confidence) and the learn-then-automate flag. Undefined = all None/false/empty.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DeliveredConfig {
    pub description: Option<String>,
    pub detected_method: Option<String>,
    pub confidence: Option<String>,
    pub confidence_note: Option<String>,
    pub learned: bool,
    pub criteria: Vec<StageCriterion>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SparkleConfig {
    pub workflow: WorkflowConfig,
    pub workers: WorkersConfig,
    pub ai: AiConfig,
    pub tools: ToolsConfig,
    /// roborev machine-wide state (the one-time consent flag). Kept in its own section so Rust can
    /// gate the first-run modal on it.
    pub roborev: RoborevConfig,
    pub freshness: FreshnessConfig,
    pub worktree_pool: WorktreePoolConfig,
    pub capture: CaptureConfig,
    pub voice: VoiceConfig,
    /// Per-category Sparkle Auto-Approve rules (repo-scoped overridable, like [workflow]/[freshness]).
    pub approvals: ApprovalsConfig,
    /// Per-project "Done" stage definition (see the Definable Done & Delivered feature).
    pub done: DoneConfig,
    /// Per-project "Delivered" stage definition + detected production-ship signal.
    pub delivered: DeliveredConfig,
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
            // NOTE: `max_concurrent` is a ceiling, not a promise — installed RAM narrows it further
            // (see EffectiveConfig::effective_max_concurrent). 3 GiB per agent sits well under
            // V8's ~4 GiB default so the cap actually bites, while leaving a real agent room to work.
            workers: WorkersConfig { max_concurrent: 20, agent_heap_mb: 3072 },
            ai: AiConfig {
                auto_rename: true,
                voice_dictation: true,
                brainstorm: true,
                composer: true,
                suggested_actions: true,
                auto_approve: true,
            },
            // Ships auto-approve ON for every category except bash (see ApprovalsConfig::default),
            // so a fresh install isn't blocked by permission prompts. bash stays ask-each-time.
            approvals: ApprovalsConfig::default(),
            // Opinionated defaults: every tool ships on for a new install.
            tools: ToolsConfig {
                analytics: true,
                beads: true,
                github: true,
                guardrails: true,
                roborev: true,
            },
            // First-run consent is unresolved until the user answers the one-time modal.
            roborev: RoborevConfig { consent_prompted: false },
            freshness: FreshnessConfig {
                // Keep these in sync with the bash fallback in scripts/lib/sparkle-config.sh.
                staleness_warn_commits: 25,
                stale_build_block_commits: 25,
                require_fresh_branch: true,
            },
            // Pre-warm a small pool by default so the common fan-out spawn skips `git worktree add`.
            worktree_pool: WorktreePoolConfig { enabled: true, size: 2 },
            capture: CaptureConfig { popover_shortcut: "ctrl+shift+r".into() },
            voice: VoiceConfig {
                wake_word: "Hey Sparkle".into(),
                stop_word: "Sparkle, stop".into(),
                pause_on_submit: true,
            },
            // Undefined by default: every project starts with no Done/Delivered definition until
            // the user defines one (see the Definable Done & Delivered feature).
            done: DoneConfig { description: None, criteria: Vec::new() },
            delivered: DeliveredConfig {
                description: None,
                detected_method: None,
                confidence: None,
                confidence_note: None,
                learned: false,
                criteria: Vec::new(),
            },
        }
    }
}

/// The merged config plus any non-fatal warnings produced while loading it.
#[derive(Debug, Clone, Serialize)]
pub struct EffectiveConfig {
    pub config: SparkleConfig,
    pub warnings: Vec<String>,
    /// The concurrency limit the app ENFORCES: `workers.max_concurrent` narrowed by how many
    /// agent-sized heaps this machine's RAM can actually hold (see `memory_aware_concurrency`).
    /// Always ≤ `config.workers.max_concurrent`, always ≥ 1. The frontend's concurrency gate reads
    /// this, not the raw configured value.
    pub effective_max_concurrent: u32,
}

impl EffectiveConfig {
    /// Build an EffectiveConfig, deriving the RAM-aware concurrency and appending the clamp
    /// warning when installed RAM forces the limit below what the user configured.
    fn derive(config: SparkleConfig, mut warnings: Vec<String>) -> Self {
        let (effective_max_concurrent, warn) =
            memory_aware_concurrency(&config.workers, total_memory_bytes());
        if let Some(w) = warn {
            // `for_project` re-derives on top of warnings that already came from the global layer,
            // so guard against showing the user the same clamp twice.
            //
            // This string-equality dedup is exact only because `[workers]` is GLOBAL-ONLY (a
            // per-project [workers] is rejected with a warning in build_effective), so both
            // derivations always see identical max_concurrent / agent_heap_mb / RAM inputs. If
            // per-project [workers] overrides are ever allowed, the two messages will diverge and
            // this needs a keyed warning instead. (roborev 40088)
            if !warnings.contains(&w) {
                warnings.push(w);
            }
        }
        Self { config, warnings, effective_max_concurrent }
    }
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
    agent_heap_mb: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialAi {
    auto_rename: Option<bool>,
    voice_dictation: Option<bool>,
    brainstorm: Option<bool>,
    composer: Option<bool>,
    suggested_actions: Option<bool>,
    auto_approve: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialApprovals {
    skill: Option<String>,
    bash: Option<String>,
    edit: Option<String>,
    mcp: Option<String>,
    fetch: Option<String>,
    other: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialTools {
    analytics: Option<bool>,
    beads: Option<bool>,
    github: Option<bool>,
    guardrails: Option<bool>,
    roborev: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialRoborev {
    consent_prompted: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialFreshness {
    staleness_warn_commits: Option<u32>,
    stale_build_block_commits: Option<u32>,
    require_fresh_branch: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialWorktreePool {
    enabled: Option<bool>,
    size: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialCapture {
    popover_shortcut: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialVoice {
    wake_word: Option<String>,
    stop_word: Option<String>,
    pause_on_submit: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialStageCriterion {
    text: Option<String>,
    kind: Option<String>,
    signal: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialDone {
    description: Option<String>,
    criteria: Option<Vec<PartialStageCriterion>>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialDelivered {
    description: Option<String>,
    detected_method: Option<String>,
    confidence: Option<String>,
    confidence_note: Option<String>,
    learned: Option<bool>,
    criteria: Option<Vec<PartialStageCriterion>>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialConfig {
    workflow: Option<PartialWorkflow>,
    workers: Option<PartialWorkers>,
    ai: Option<PartialAi>,
    tools: Option<PartialTools>,
    roborev: Option<PartialRoborev>,
    freshness: Option<PartialFreshness>,
    worktree_pool: Option<PartialWorktreePool>,
    capture: Option<PartialCapture>,
    voice: Option<PartialVoice>,
    approvals: Option<PartialApprovals>,
    done: Option<PartialDone>,
    delivered: Option<PartialDelivered>,
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
    let Some(p) = p else { return };
    if let Some(v) = p.max_concurrent {
        into.max_concurrent = v;
    }
    if let Some(v) = p.agent_heap_mb {
        into.agent_heap_mb = v;
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

fn apply_worktree_pool(into: &mut WorktreePoolConfig, p: Option<PartialWorktreePool>) {
    let Some(p) = p else { return };
    if let Some(v) = p.enabled {
        into.enabled = v;
    }
    if let Some(v) = p.size {
        into.size = v;
    }
}

fn apply_capture(into: &mut CaptureConfig, p: Option<PartialCapture>) {
    if let Some(PartialCapture { popover_shortcut: Some(v) }) = p {
        into.popover_shortcut = v;
    }
}

fn apply_voice(into: &mut VoiceConfig, p: Option<PartialVoice>) {
    let Some(p) = p else { return };
    if let Some(v) = p.wake_word {
        into.wake_word = v;
    }
    if let Some(v) = p.stop_word {
        into.stop_word = v;
    }
    if let Some(v) = p.pause_on_submit {
        into.pause_on_submit = v;
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
    if let Some(v) = p.auto_approve {
        into.auto_approve = v;
    }
}

/// Overlay a partial `[approvals]` table. Each category present in the layer overrides; an absent
/// category leaves the lower layer's value (so a project rule beats a global one per category, and
/// removing a project key falls back to the global rule).
fn apply_approvals(into: &mut ApprovalsConfig, p: Option<PartialApprovals>) {
    let Some(p) = p else { return };
    if let Some(v) = p.skill {
        into.skill = Some(v);
    }
    if let Some(v) = p.bash {
        into.bash = Some(v);
    }
    if let Some(v) = p.edit {
        into.edit = Some(v);
    }
    if let Some(v) = p.mcp {
        into.mcp = Some(v);
    }
    if let Some(v) = p.fetch {
        into.fetch = Some(v);
    }
    if let Some(v) = p.other {
        into.other = Some(v);
    }
}

fn apply_tools(into: &mut ToolsConfig, p: Option<PartialTools>) {
    let Some(p) = p else { return };
    if let Some(v) = p.analytics {
        into.analytics = v;
    }
    if let Some(v) = p.beads {
        into.beads = v;
    }
    if let Some(v) = p.github {
        into.github = v;
    }
    if let Some(v) = p.guardrails {
        into.guardrails = v;
    }
    if let Some(v) = p.roborev {
        into.roborev = v;
    }
}

fn apply_roborev(into: &mut RoborevConfig, p: Option<PartialRoborev>) {
    if let Some(PartialRoborev { consent_prompted: Some(v) }) = p {
        into.consent_prompted = v;
    }
}

/// Materialize partial criteria into effective ones. A missing `text`/`kind` degrades to an empty
/// string rather than erroring (preserves the "unknown/missing never errors" contract); downstream
/// units validate/normalize kind + signal.
fn apply_criteria(p: Vec<PartialStageCriterion>) -> Vec<StageCriterion> {
    p.into_iter()
        .map(|c| StageCriterion {
            text: c.text.unwrap_or_default(),
            kind: c.kind.unwrap_or_default(),
            signal: c.signal,
        })
        .collect()
}

fn apply_done(into: &mut DoneConfig, p: Option<PartialDone>) {
    let Some(p) = p else { return };
    if let Some(v) = p.description {
        into.description = Some(v);
    }
    if let Some(c) = p.criteria {
        into.criteria = apply_criteria(c);
    }
}

fn apply_delivered(into: &mut DeliveredConfig, p: Option<PartialDelivered>) {
    let Some(p) = p else { return };
    if let Some(v) = p.description {
        into.description = Some(v);
    }
    if let Some(v) = p.detected_method {
        into.detected_method = Some(v);
    }
    if let Some(v) = p.confidence {
        into.confidence = Some(v);
    }
    if let Some(v) = p.confidence_note {
        into.confidence_note = Some(v);
    }
    if let Some(v) = p.learned {
        into.learned = v;
    }
    if let Some(c) = p.criteria {
        into.criteria = apply_criteria(c);
    }
}

// ============================ memory-aware concurrency ============================
// `max_concurrent` is a raw process count: it knows nothing about how much RAM the machine has or
// how big each agent can get. That combination is what killed a machine on 2026-07-20 (sparkle-01xv
// / sparkle-asz5) — 24 agents × V8's ~4 GiB default heap = 99 GiB, and the kernel started killing
// system daemons. Here we turn the two knobs into a number the machine can actually survive:
// how many agent-sized heaps fit in RAM after leaving the OS and Sparkle itself room to breathe.

/// Smallest per-agent heap worth allowing. Below this an agent OOMs before doing useful work.
const MIN_AGENT_HEAP_MB: u32 = 512;

/// V8's own default old-space ceiling on a 64-bit machine with plenty of RAM (~4 GiB — the machines
/// in the incident reported 4.09 GiB). Used as the per-agent budget when the user opts OUT of our
/// cap, since that is then exactly how big each agent can get.
const V8_DEFAULT_HEAP_MB: u32 = 4096;

/// RAM held back for the OS, the Tauri app (~0.84 GiB observed), and everything else the user is
/// running. Deliberately generous: over-reserving costs a little parallelism, under-reserving costs
/// the user their machine.
const MEMORY_RESERVE_BYTES: u64 = 6 * 1024 * 1024 * 1024;

/// How many agents of `agent_heap_mb` fit in `total_ram_bytes` after `reserve_bytes`.
/// Always at least 1: a machine too small for even one agent must still be able to run one
/// (degraded, possibly swapping) rather than be told it may run zero and deadlock the orchestrator.
fn ram_derived_concurrency(total_ram_bytes: u64, reserve_bytes: u64, agent_heap_mb: u32) -> u32 {
    let per_agent = (agent_heap_mb as u64) * 1024 * 1024;
    if per_agent == 0 {
        return 1;
    }
    let usable = total_ram_bytes.saturating_sub(reserve_bytes);
    // u32 saturation is fine: nothing downstream cares about a distinction above 4 billion agents.
    (usable / per_agent).clamp(1, u32::MAX as u64) as u32
}

/// The concurrency the app will actually enforce, plus an optional warning when RAM forced it below
/// what the user configured. `total_ram` is None when we can't measure it.
///
/// The configured `max_concurrent` is a CEILING in both directions of reasoning: spare RAM never
/// raises it (the user asked for at most N), and scarce RAM lowers it (the machine can't hold N).
fn memory_aware_concurrency(w: &WorkersConfig, total_ram: Option<u64>) -> (u32, Option<String>) {
    // No measurement means no basis to narrow anything — honor the configured value rather than
    // inventing a limit that could throttle a big machine to nothing.
    let Some(total) = total_ram else {
        return (w.max_concurrent, None);
    };
    // Opting OUT of the heap cap must not also opt out of the concurrency clamp (roborev 40088) —
    // coupling them would restore the exact runaway this exists to prevent. With no cap, agents use
    // V8's own default, so that becomes the per-agent budget.
    let budget_mb = if w.agent_heap_mb > 0 { w.agent_heap_mb } else { V8_DEFAULT_HEAP_MB };
    let by_ram = ram_derived_concurrency(total, MEMORY_RESERVE_BYTES, budget_mb);
    if by_ram >= w.max_concurrent {
        return (w.max_concurrent, None);
    }
    // The remedy differs by branch, and telling a user to "lower" a value that is already 0 is
    // impossible advice — 0 maps to the LARGEST budget, so the fix there is to set a positive one
    // (roborev 40311).
    let (per_agent, remedy) = if w.agent_heap_mb > 0 {
        (format!("{budget_mb} MiB per agent"), "Lower agent_heap_mb to allow more.".to_string())
    } else {
        (
            format!("{budget_mb} MiB per agent, V8's default since agent_heap_mb = 0"),
            format!("Set a positive agent_heap_mb below {budget_mb} to allow more."),
        )
    };
    let warning = format!(
        "[workers].max_concurrent ({}) is more than this machine's RAM can hold; using {} \
         (total {} GiB − {} GiB reserved, ÷ {}). {}",
        w.max_concurrent,
        by_ram,
        total / (1024 * 1024 * 1024),
        MEMORY_RESERVE_BYTES / (1024 * 1024 * 1024),
        per_agent,
        remedy,
    );
    (by_ram, Some(warning))
}

/// Installed physical RAM in bytes, or None when we can't determine it (in which case the caller
/// leaves concurrency alone rather than guessing). macOS: `sysctl hw.memsize`.
#[cfg(target_os = "macos")]
fn total_memory_bytes() -> Option<u64> {
    // Memoized: this is a fixed hardware property, and `for_project` runs on a hot poll.
    static TOTAL: OnceLock<Option<u64>> = OnceLock::new();
    *TOTAL.get_or_init(|| {
        let out = std::process::Command::new("/usr/sbin/sysctl").args(["-n", "hw.memsize"]).output().ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().ok().filter(|n| *n > 0)
    })
}

#[cfg(not(target_os = "macos"))]
fn total_memory_bytes() -> Option<u64> {
    // Not implemented off macOS (Sparkle ships mac-only today); None = leave concurrency as configured.
    None
}

/// Clamp out-of-range values into something usable; collect a warning for each adjustment.
/// Never errors — a bad value degrades gracefully rather than breaking the app.
fn validate(cfg: &mut SparkleConfig, warnings: &mut Vec<String>) {
    if cfg.workers.max_concurrent < 1 {
        warnings.push("[workers].max_concurrent must be >= 1; using 1".to_string());
        cfg.workers.max_concurrent = 1;
    }
    // 0 is the deliberate opt-out ("no cap"), so only a positive-but-unusable value is floored.
    // Below ~512 MiB an agent OOMs before it gets anything done, which reads as a hang, not a cap.
    if cfg.workers.agent_heap_mb > 0 && cfg.workers.agent_heap_mb < MIN_AGENT_HEAP_MB {
        warnings.push(format!(
            "[workers].agent_heap_mb ({}) is too small to run an agent; using {}",
            cfg.workers.agent_heap_mb, MIN_AGENT_HEAP_MB
        ));
        cfg.workers.agent_heap_mb = MIN_AGENT_HEAP_MB;
    }
    // Cap the pool so a fat-fingered size can't spawn a huge burst of parked worktrees (each a real
    // checkout on disk). 16 is far above any sane fan-out; anything higher is almost certainly a typo.
    if cfg.worktree_pool.size > 16 {
        warnings.push(format!(
            "[worktree_pool].size ({}) is very high; capping at 16",
            cfg.worktree_pool.size
        ));
        cfg.worktree_pool.size = 16;
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
                apply_tools(&mut cfg.tools, p.tools);
                apply_roborev(&mut cfg.roborev, p.roborev);
                apply_freshness(&mut cfg.freshness, p.freshness);
                apply_worktree_pool(&mut cfg.worktree_pool, p.worktree_pool);
                apply_capture(&mut cfg.capture, p.capture);
                apply_voice(&mut cfg.voice, p.voice);
                apply_approvals(&mut cfg.approvals, p.approvals);
                apply_done(&mut cfg.done, p.done);
                apply_delivered(&mut cfg.delivered, p.delivered);
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
                if p.tools.is_some() {
                    warnings.push(
                        "[tools] in a per-project .sparkle/config.toml is ignored — it is a \
                         machine-wide setting; set it in the global config.toml"
                            .to_string(),
                    );
                }
                if p.roborev.is_some() {
                    warnings.push(
                        "[roborev] in a per-project .sparkle/config.toml is ignored — it is a \
                         machine-wide setting; set it in the global config.toml"
                            .to_string(),
                    );
                }
                if p.capture.is_some() {
                    warnings.push(
                        "[capture] in a per-project .sparkle/config.toml is ignored — the \
                         global shortcut is a machine-wide setting; set it in the global \
                         config.toml"
                            .to_string(),
                    );
                }
                if p.voice.is_some() {
                    warnings.push(
                        "[voice] in a per-project .sparkle/config.toml is ignored — the wake/stop \
                         words are a machine-wide preference; set them in the global config.toml"
                            .to_string(),
                    );
                }
                // Per-project layer: [workflow], [freshness], [approvals], and the [done]/[delivered]
                // stage definitions are repo-scoped and may override. [approvals] is honored here so
                // "this project" auto-approve rules actually take effect (per category, project beats
                // global). [ai].auto_approve stays global-only (it's the machine-wide master toggle,
                // ignored per-project like the rest of [ai] above).
                apply_workflow(&mut cfg.workflow, p.workflow);
                apply_freshness(&mut cfg.freshness, p.freshness);
                apply_worktree_pool(&mut cfg.worktree_pool, p.worktree_pool);
                apply_approvals(&mut cfg.approvals, p.approvals);
                apply_done(&mut cfg.done, p.done);
                apply_delivered(&mut cfg.delivered, p.delivered);
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
        RwLock::new(EffectiveConfig::derive(SparkleConfig::default(), Vec::new()))
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
        *guard = EffectiveConfig::derive(cfg, warnings);
        // Log the derived concurrency WITH its inputs, so a user asking "why is Sparkle only
        // running 3 agents?" can answer it from the daily log alone.
        tracing::info!(
            configured_max_concurrent = guard.config.workers.max_concurrent,
            agent_heap_mb = guard.config.workers.agent_heap_mb,
            total_ram_bytes = ?total_memory_bytes(),
            reserve_bytes = MEMORY_RESERVE_BYTES,
            effective_max_concurrent = guard.effective_max_concurrent,
            "resolved memory-aware worker concurrency"
        );
    }
    guard.clone()
}

/// The cached global EffectiveConfig (config + warnings), for `get_config` with no project.
pub fn current_effective() -> EffectiveConfig {
    // Poison-tolerant read: a panicking writer must not brick every future config read.
    cell().read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// One memoized `for_project` result plus the inputs it was derived from. The project file is
/// re-read+re-parsed only when its (mtime, len) changes OR the global layer it was merged against
/// changes — so a hot poll (`resolve_default_branch` → `for_project` on every batch tick) skips the
/// disk read + TOML parse when nothing moved, without ever going stale on a real edit.
struct ProjectCacheEntry {
    mtime_ms: u128,
    len: u64,
    /// The global layer this result was merged against; when it changes (watcher reload) the memo
    /// is invalidated so a global edit still propagates into the per-project view.
    global_config: SparkleConfig,
    effective: EffectiveConfig,
}

fn project_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, ProjectCacheEntry>> {
    static CACHE: OnceLock<std::sync::Mutex<std::collections::HashMap<String, ProjectCacheEntry>>> =
        OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// (mtime_ms, len) of `path`, or (0, 0) when it's absent/unreadable. A missing project file is a
/// stable, valid key: as long as it stays missing the memo holds; creating it changes `len`/mtime.
fn file_stamp(path: &Path) -> (u128, u64) {
    std::fs::metadata(path)
        .ok()
        .map(|m| {
            let mtime_ms = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            (mtime_ms, m.len())
        })
        .unwrap_or((0, 0))
}

/// Effective config for a specific project: the cached global layer with that project's
/// `.sparkle/config.toml` overlaid (its `[workflow]` only). Memoized on the project file's
/// (mtime, len) + the global layer's identity, so a hot poll only re-reads+re-parses the file when
/// something actually changed (the disk read + TOML parse dominated this call on every batch tick).
pub fn for_project(repo_root: &str) -> EffectiveConfig {
    // One snapshot of the cached global layer, so the config and its warnings can't be spliced
    // across a concurrent watcher reload.
    let global = current_effective();
    let path = project_path(repo_root);
    let (mtime_ms, len) = file_stamp(&path);

    // Fast path: the project file and the global layer are both unchanged since we last computed.
    if let Ok(cache) = project_cache().lock() {
        if let Some(e) = cache.get(repo_root) {
            if e.mtime_ms == mtime_ms && e.len == len && e.global_config == global.config {
                return e.effective.clone();
            }
        }
    }

    let project_text = read_if_exists(&path);
    // `global.config` already has defaults+global folded in, so pass only the project layer here.
    let (cfg, mut warnings, _) =
        build_effective(global.config.clone(), None, project_text.as_deref());
    // Carry forward any standing global warnings so the UI sees them in a project context too.
    let mut all = global.warnings;
    all.append(&mut warnings);
    let effective = EffectiveConfig::derive(cfg, all);

    if let Ok(mut cache) = project_cache().lock() {
        cache.insert(
            repo_root.to_string(),
            ProjectCacheEntry {
                mtime_ms,
                len,
                global_config: global.config,
                effective: effective.clone(),
            },
        );
    }
    effective
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
# The most agents/worktrees an orchestrator may run in parallel. This is a CEILING, not a
# promise: Sparkle also caps concurrency at what your RAM can hold — roughly
#   (installed_RAM - 6 GiB reserved for the OS and Sparkle) / agent_heap_mb
# — and uses whichever is smaller. So on a 16 GB Mac you get ~3 agents even if this says 20,
# while lowering this to 4 always gives you 4. The resolved number is logged at startup.
# Floored at 1; there is no hard upper limit.
max_concurrent = 20
# Memory ceiling per agent, in MiB, applied as NODE_OPTIONS=--max-old-space-size. Agents are
# Node processes, and Node's OWN default ceiling is ~4 GiB — high enough that a handful of
# runaway agents can exhaust a Mac's RAM and get system daemons killed by the kernel. This caps
# each agent well below that. Raise it if agents hit out-of-memory errors on huge repos; lower it
# to run more agents at once. Set 0 to opt out entirely (agents then use Node's ~4 GiB default —
# not recommended; the RAM-based max_concurrent clamp above stays in force either way, and simply
# budgets 4 GiB per agent instead). If you set your own NODE_OPTIONS, yours is preserved and merged
# with this; an explicit --max-old-space-size of your own always wins.
agent_heap_mb = 3072

# --- AI features (per-machine; each degrades to a non-AI baseline when off) ------------
[ai]
auto_rename     = true   # auto-name worker agents from the work they're doing
voice_dictation = true   # use the cloud (Deepgram) STT for dictation; off = on-device model
brainstorm      = true   # show the Think agent (chat with Chief)
composer        = true   # use the AI-enhanced composer; off = a plain terminal input
# suggested_actions = true   # show one-click suggested action buttons in the composer
# auto_approve  = true   # Sparkle Auto-Approve: MASTER switch for auto-answering Claude Code
                         # permission prompts (per [approvals] below). On by default. Off disables
                         # all nudging AND all auto-answering regardless of [approvals].

# --- Sparkle Auto-Approve rules (repo-scoped; overridable in a project file) -------------
# Per-CATEGORY rules for auto-answering Claude Code permission prompts. Each value is:
#   "always" = auto-answer the plain "Yes" for that whole class of prompt (Sparkle stays
#              authoritative — turning [ai].auto_approve off restores the prompts), or
#   "never"  = keep asking, but stop nudging you to remember an answer for that class.
# DEFAULTS (so you're never blocked out of the box): every category EXCEPT bash ships "always".
# bash is the sole exception — it stays ask-each-time because auto-approving commands also
# auto-approves DESTRUCTIVE ones (rm -rf, …); set bash = "always" only if you accept that.
# Edit here or via ⋯ Settings → "Auto-approve". Global rules apply to every project; a project's
# .sparkle/config.toml [approvals] overrides per category (project wins).
# Categories: skill (skills) · bash (commands) · edit (file edits) · mcp (tool calls) ·
# fetch (web requests) · other (other prompts).
# [approvals]
# bash  = "always"   # opt bash in too (accepts destructive commands)
# fetch = "never"    # or turn a category back to ask-each-time

# --- Opinionated tools (per-machine; ignored in a project file) -------------------------
# The non-AI tools Sparkle leans on, surfaced in ⋯ Settings → "Tools". Each defaults on for a
# new install; setting one false means that tool is used NOWHERE in Sparkle. (Chief and Deepgram
# voice are AI features — toggle them under [ai] as brainstorm / voice_dictation.)
[tools]
analytics  = true   # anonymous usage + masked session replay (PostHog); off sends nothing
beads      = true   # the in-repo work graph behind the Plan board; off hides it + skips `bd`
github     = true   # import a project from your GitHub repositories; off hides that path
guardrails = true   # opinionated quality workflow (test-first, run tests+typecheck before commit,
                    # never call a red build "done") appended to every coding agent; off omits it
roborev    = true   # per-commit AI code review of your BUILD-agent commits (uses your claude login)

# --- roborev first-run consent (per-machine; ignored in a project file) -----------------
# roborev reviews your BUILD-agent commits locally. The first time it's about to turn on, Sparkle
# asks once — this flag records that the "review your commits?" prompt has been resolved (Enable or
# Not-now) so you're never asked again. Toggle the tool itself under [tools] (roborev), not here.
[roborev]
consent_prompted = false   # set true once the one-time "review your commits?" prompt is resolved

# --- Menu-bar capture (per-machine; ignored in a project file) --------------------------
[capture]
# Global keyboard shortcut that toggles the Sparkle menu-bar popover from anywhere.
# Format: modifiers+key, e.g. "ctrl+shift+r", "alt+f9", "cmd+shift+7". If the value can't
# be parsed or the combo is taken by another app, Sparkle logs a warning and runs without
# a shortcut (the menu-bar icon still works).
popover_shortcut = "ctrl+shift+r"

# --- Voice controls (per-machine; ignored in a project file) ----------------------------
# The spoken wake/stop words and what happens to dictation when you submit a prompt. Edit these
# here or in the ⋯ Settings → "Voice controls" pane. The DEFAULT words below run Sparkle's tuned
# "Hey Sparkle" recognition engine; changing them switches to a generic fuzzy matcher (a
# distinctive, multi-syllable phrase recognizes best).
[voice]
# Spoken phrase that starts dictation.
wake_word = "Hey Sparkle"
# Spoken phrase that ends active dictation.
stop_word = "Sparkle, stop"
# true  = submitting a prompt drops from active dictation back to passive wake-word listening
#         (the mic stays on; say the wake word again to resume).
# false = keep listening — stay in active dictation after a submit.
pause_on_submit = true

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

# --- Pre-warmed worktree pool (repo-scoped; overridable in a project file) --------------
# The slow part of spawning an agent is `git worktree add`, which materializes the whole working
# tree (seconds — and longer when several spawns queue behind each other). Instead, Sparkle keeps a
# few worktrees pre-checked-out at the base commit while you're idle; a spawn then just MOVES one
# into place and creates the agent's branch (near-instant). This is a pure speedup: if it's off, the
# pool is empty, or the base has moved, Sparkle transparently falls back to the normal cut.
[worktree_pool]
# false = never pre-warm; every agent cuts its own worktree inline (the original behavior).
enabled = true
# How many ready worktrees to keep parked per project. Higher = more spawns skip the wait, at the
# cost of that many extra checkouts on disk. 0 disables warming. Capped at 16 defensively.
size    = 2

# --- What "Done" and "Delivered" mean for THIS project (repo-scoped) --------------------
# These two sections let each project define its own Plan/Tasks board semantics. They are
# normally written by Sparkle's in-app "Define Done/Delivered" flow (a short chat), not by
# hand — but you can edit them here. Leaving them out (as below) means "undefined": the board
# behaves with its built-in defaults and offers a Define button. Example shapes:
#
# [done]
# description = "Merged into the remote main branch."
# [[done.criteria]]
# text   = "Merged into origin/main"
# kind   = "auto"              # "auto" = Sparkle observes it | "manual" = a human ticks it
# signal = "merged_to_main"    # required iff kind="auto"; one of the known auto-signal ids
# [[done.criteria]]
# text = "Reviewed by a teammate"
# kind = "manual"
#
# [delivered]
# description = "Shipped to production."
# detected_method = "release_tag"   # how this repo ships; DETECTED per project
# confidence      = "high"          # high | medium | low | none
# confidence_note = "Ships via GitHub Releases (v* tags)."
# learned         = false           # true once a human confirms >=1 real delivery for this signal
# [[delivered.criteria]]
# text   = "Commit is in a cut release"
# kind   = "auto"
# signal = "in_release"
# [[delivered.criteria]]
# text = "Deployed to prod verified"
# kind = "manual"
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

/// Surgically REMOVE a dotted `path` from a TOML document, preserving surrounding comments/format.
/// A missing key (or a missing intermediate table) is a no-op — removing an unset rule is harmless.
/// A path that tries to descend through a non-table scalar is an error (matches set_dotted).
fn unset_dotted(doc: &mut toml_edit::DocumentMut, path: &str) -> Result<(), String> {
    let parts: Vec<&str> = path.split('.').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Err("empty config path".to_string());
    }
    let mut item: &mut toml_edit::Item = doc.as_item_mut();
    for part in &parts[..parts.len() - 1] {
        match item.get(part) {
            None => return Ok(()), // intermediate table absent → nothing to remove
            Some(existing) if !existing.is_table() => {
                return Err(format!("config path '{path}' traverses '{part}', which is not a table"));
            }
            Some(_) => {}
        }
        item = &mut item[*part];
    }
    let last = parts[parts.len() - 1];
    if let Some(table) = item.as_table_mut() {
        table.remove(last);
    } else if let Some(inline) = item.as_inline_table_mut() {
        inline.remove(last);
    }
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

/// Remove one dotted key from the global config file, preserving comments/formatting. Validates the
/// rendered result before persisting. Removing an absent key is a harmless no-op.
pub fn unset_value(app_data: &Path, path: &str) -> Result<(), String> {
    let mut doc = load_document(app_data);
    unset_dotted(&mut doc, path)?;
    let text = doc.to_string();
    parse_layer(&text)
        .map_err(|e| format!("rejected: that change would make config.toml invalid: {e}"))?;
    write_atomic(&global_path(app_data), &text)
}

/// Read the per-project `.sparkle/config.toml` as an editable document, preserving its comments +
/// other sections. Refuses to clobber an existing-but-unparseable file (matches
/// `write_stage_definition`); an absent file starts from an empty document.
fn load_project_document(project_root: &str) -> Result<toml_edit::DocumentMut, String> {
    let path = project_path(project_root);
    match read_if_exists(&path) {
        Some(text) => text.parse::<toml_edit::DocumentMut>().map_err(|e| {
            format!("existing .sparkle/config.toml is not valid TOML; fix it before editing it: {e}")
        }),
        None => Ok(toml_edit::DocumentMut::new()),
    }
}

/// Set one dotted key in the PER-PROJECT `.sparkle/config.toml` (comment-preserving), validating the
/// rendered result first. Used for "this project" auto-approve rules.
pub fn set_project_value(project_root: &str, path: &str, value: &serde_json::Value) -> Result<(), String> {
    let v = json_to_toml_value(value)?;
    let mut doc = load_project_document(project_root)?;
    set_dotted(&mut doc, path, v)?;
    let text = doc.to_string();
    parse_layer(&text)
        .map_err(|e| format!("rejected: that change would make .sparkle/config.toml invalid: {e}"))?;
    write_atomic(&project_path(project_root), &text)
}

/// Remove one dotted key from the PER-PROJECT `.sparkle/config.toml`. No-op when the file (or key)
/// is absent — but a present-but-unparseable file is refused rather than clobbered.
pub fn unset_project_value(project_root: &str, path: &str) -> Result<(), String> {
    let path_buf = project_path(project_root);
    // Nothing to remove from a file that doesn't exist yet.
    if read_if_exists(&path_buf).is_none() {
        return Ok(());
    }
    let mut doc = load_project_document(project_root)?;
    unset_dotted(&mut doc, path)?;
    let text = doc.to_string();
    parse_layer(&text)
        .map_err(|e| format!("rejected: that change would make .sparkle/config.toml invalid: {e}"))?;
    write_atomic(&path_buf, &text)
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

// ---- per-project stage-definition writer (Definable Done & Delivered) --------------------------
// Unlike the scalar dotted setter, a stage definition is an ENTIRE `[done]`/`[delivered]` table
// with a `[[<key>.criteria]]` array-of-tables — not expressible as a dotted scalar. This writes the
// whole section into the PER-PROJECT `.sparkle/config.toml` (the stage definitions are repo-scoped),
// insert-or-replacing it while preserving the rest of the file (comments + other sections).

/// Build the `[[<key>.criteria]]` array-of-tables from parsed partial criteria. A `manual`
/// criterion carries no `signal`, so it's emitted only when present.
fn criteria_array_of_tables(criteria: &Option<Vec<PartialStageCriterion>>) -> toml_edit::ArrayOfTables {
    let mut aot = toml_edit::ArrayOfTables::new();
    if let Some(list) = criteria {
        for c in list {
            let mut t = toml_edit::Table::new();
            t["text"] = toml_edit::value(c.text.clone().unwrap_or_default());
            t["kind"] = toml_edit::value(c.kind.clone().unwrap_or_default());
            if let Some(sig) = &c.signal {
                t["signal"] = toml_edit::value(sig.clone());
            }
            aot.push(t);
        }
    }
    aot
}

/// Build the `[done]` table (description + criteria) from a parsed partial.
fn done_table(p: &PartialDone) -> toml_edit::Table {
    let mut t = toml_edit::Table::new();
    if let Some(d) = &p.description {
        t["description"] = toml_edit::value(d.clone());
    }
    t["criteria"] = toml_edit::Item::ArrayOfTables(criteria_array_of_tables(&p.criteria));
    t
}

/// Build the `[delivered]` table (description + detected signal metadata + criteria) from a parsed
/// partial.
fn delivered_table(p: &PartialDelivered) -> toml_edit::Table {
    let mut t = toml_edit::Table::new();
    if let Some(d) = &p.description {
        t["description"] = toml_edit::value(d.clone());
    }
    if let Some(m) = &p.detected_method {
        t["detected_method"] = toml_edit::value(m.clone());
    }
    if let Some(c) = &p.confidence {
        t["confidence"] = toml_edit::value(c.clone());
    }
    if let Some(n) = &p.confidence_note {
        t["confidence_note"] = toml_edit::value(n.clone());
    }
    if let Some(l) = p.learned {
        t["learned"] = toml_edit::value(l);
    }
    t["criteria"] = toml_edit::Item::ArrayOfTables(criteria_array_of_tables(&p.criteria));
    t
}

/// Insert-or-replace the `[done]`/`[delivered]` stage definition in `<project_root>/.sparkle/
/// config.toml`, preserving the rest of the file (comments + unrelated sections). `definition` is
/// the snake_case config shape (see `PartialDone`/`PartialDelivered`); it is validated against the
/// typed layer both up front (rejecting wrong types) and after rendering (so a malformed result can
/// never be persisted). Written atomically. Pure over the filesystem so it's unit-testable.
fn write_stage_definition(
    project_root: &str,
    key: &str,
    definition: &serde_json::Value,
) -> Result<(), String> {
    // Validate the incoming JSON against the typed partial schema and build the section table.
    let table = match key {
        "done" => {
            let p: PartialDone = serde_json::from_value(definition.clone())
                .map_err(|e| format!("invalid [done] definition: {e}"))?;
            done_table(&p)
        }
        "delivered" => {
            let p: PartialDelivered = serde_json::from_value(definition.clone())
                .map_err(|e| format!("invalid [delivered] definition: {e}"))?;
            delivered_table(&p)
        }
        other => {
            return Err(format!(
                "unknown stage key '{other}' (expected \"done\" or \"delivered\")"
            ))
        }
    };

    let path = project_path(project_root);
    // Preserve the existing project file (comments + other sections). If it exists but is
    // unparseable, refuse rather than clobber a hand-edited file; if absent, start from empty.
    let mut doc = match read_if_exists(&path) {
        Some(text) => text.parse::<toml_edit::DocumentMut>().map_err(|e| {
            format!("existing .sparkle/config.toml is not valid TOML; fix it before defining a stage: {e}")
        })?,
        None => toml_edit::DocumentMut::new(),
    };
    // Insert-or-replace: assigning the key REPLACES the whole prior `[done]`/`[delivered]` table
    // (and its `[[<key>.criteria]]`) in place, rather than appending a second one.
    doc[key] = toml_edit::Item::Table(table);

    let text = doc.to_string();
    // Round-trip validation: the rendered file must parse cleanly through the typed layer before we
    // persist it (matches the write_text / set_value contract — never write an invalid config).
    parse_layer(&text).map_err(|e| {
        format!("rejected: that stage definition would make config.toml invalid: {e}")
    })?;
    write_atomic(&path, &text)
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

/// Remove one dotted key from the GLOBAL config file (comment-preserving). Used to clear an
/// all-projects auto-approve rule. Removing an absent key succeeds as a no-op.
#[tauri::command]
pub fn unset_config_value(app: AppHandle, path: String) -> Result<(), String> {
    let ad = app_data(&app)?;
    unset_value(&ad, &path)?;
    reload_and_emit(&app, &ad);
    Ok(())
}

/// Set one dotted key in a PROJECT's `.sparkle/config.toml` (comment-preserving). Used for a
/// "this project" auto-approve rule. Emits a fresh GLOBAL `config-changed` so listeners re-pull —
/// per-project consumers re-read `get_config(project_root)` themselves, and emitting the global
/// layer (rather than the project-merged one) keeps the global settings mirror uncontaminated by a
/// project-scoped value.
#[tauri::command]
pub fn set_project_config_value(
    app: AppHandle,
    project_root: String,
    path: String,
    value: serde_json::Value,
) -> Result<(), String> {
    set_project_value(&project_root, &path, &value)?;
    let ad = app_data(&app)?;
    reload_and_emit(&app, &ad);
    Ok(())
}

/// Remove one dotted key from a PROJECT's `.sparkle/config.toml`. Used to clear a "this project"
/// auto-approve rule (or un-mute a `never`). See `set_project_config_value` for the emit rationale.
#[tauri::command]
pub fn unset_project_config_value(
    app: AppHandle,
    project_root: String,
    path: String,
) -> Result<(), String> {
    unset_project_value(&project_root, &path)?;
    let ad = app_data(&app)?;
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

/// Insert-or-replace a per-project `[done]`/`[delivered]` stage definition in the project's
/// `.sparkle/config.toml`, preserving comments + other sections. `key` must be "done" or
/// "delivered"; `definition` is the snake_case config shape (description, criteria[{text,kind,
/// signal}], and for delivered: detected_method, confidence, confidence_note, learned). Emits a
/// `config-changed` carrying the fresh per-project effective config so the board/modal re-render.
#[tauri::command]
pub fn set_stage_definition(
    app: AppHandle,
    project_root: String,
    key: String,
    definition: serde_json::Value,
) -> Result<(), String> {
    write_stage_definition(&project_root, &key, &definition)?;
    let _ = app.emit("config-changed", for_project(&project_root));
    Ok(())
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
    fn tools_default_all_true() {
        let (cfg, _, _) = effective(None, None);
        assert!(cfg.tools.analytics);
        assert!(cfg.tools.beads);
        assert!(cfg.tools.github);
        assert!(cfg.tools.guardrails);
        assert!(cfg.tools.roborev);
    }

    #[test]
    fn global_can_disable_roborev() {
        // roborev is on by default; a global file can turn the review daemon off.
        let g = "[tools]\nroborev = false\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(!cfg.tools.roborev);
        assert!(cfg.tools.guardrails, "untouched tool keeps its default");
    }

    #[test]
    fn roborev_consent_defaults_false_and_global_sets_it() {
        // The one-time consent flag starts unresolved.
        let (cfg, _, _) = effective(None, None);
        assert!(!cfg.roborev.consent_prompted);

        // A global [roborev] section resolves it.
        let g = "[roborev]\nconsent_prompted = true\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(cfg.roborev.consent_prompted);
    }

    #[test]
    fn project_roborev_is_ignored_with_warning() {
        // [roborev] is machine-wide (like [tools]); a per-project value is ignored with a warning.
        let p = "[roborev]\nconsent_prompted = true\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert!(!cfg.roborev.consent_prompted);
        assert!(warns.iter().any(|w| w.contains("[roborev]")));
    }

    #[test]
    fn global_tools_override_field_by_field() {
        // A global file can flip a single tool off; untouched tools keep their defaults.
        let g = "[tools]\nbeads = false\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(!cfg.tools.beads);
        assert!(cfg.tools.analytics, "untouched tool keeps its default");
        assert!(cfg.tools.github, "untouched tool keeps its default");
        assert!(cfg.tools.guardrails, "untouched tool keeps its default");
    }

    #[test]
    fn global_can_disable_guardrails() {
        // Guardrails is on by default; a global file can turn the opinionation off.
        let g = "[tools]\nguardrails = false\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(!cfg.tools.guardrails);
        assert!(cfg.tools.analytics, "untouched tool keeps its default");
    }

    #[test]
    fn unknown_tools_key_is_tolerated() {
        // A forward-compatible [tools] key never errors (serde ignores unknown fields).
        let g = "[tools]\nanalytics = false\nsome_future_tool = true\n";
        let (cfg, _, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(!cfg.tools.analytics);
    }

    #[test]
    fn project_tools_are_ignored_with_warning() {
        // [tools] is machine-wide (like [ai]); a per-project value is ignored with a warning.
        let p = "[tools]\nbeads = false\ngithub = false\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert!(cfg.tools.beads);
        assert!(cfg.tools.github);
        assert!(warns.iter().any(|w| w.contains("[tools]")));
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

    // ── per-agent heap cap + memory-aware concurrency (sparkle-01xv / sparkle-asz5) ────────
    // `max_concurrent` alone is a raw process count blind to installed RAM: 20 agents × V8's
    // ~4 GiB default heap = 82 GiB, which is how a machine got jetsam-killed. The heap cap bounds
    // each agent; the RAM-derived concurrency bounds how many of them can exist at once.

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn agent_heap_mb_defaults_below_v8s_own_ceiling() {
        let (cfg, _, _) = effective(None, None);
        // Must be meaningfully BELOW V8's ~4 GiB default, or the cap accomplishes nothing.
        assert_eq!(cfg.workers.agent_heap_mb, 3072);
        assert!(cfg.workers.agent_heap_mb < 4096);
    }

    #[test]
    fn agent_heap_mb_merges_without_disturbing_max_concurrent() {
        // Setting only the new key leaves its sibling at the default...
        let (cfg, _, _) = effective(Some("[workers]\nagent_heap_mb = 2048\n"), None);
        assert_eq!(cfg.workers.agent_heap_mb, 2048);
        assert_eq!(cfg.workers.max_concurrent, 20);
        // ...and setting only the old key leaves the new one at the default.
        let (cfg, _, _) = effective(Some("[workers]\nmax_concurrent = 6\n"), None);
        assert_eq!(cfg.workers.max_concurrent, 6);
        assert_eq!(cfg.workers.agent_heap_mb, 3072);
    }

    #[test]
    fn validate_floors_agent_heap_mb_at_a_workable_size() {
        // A sub-512 MiB heap would OOM a real agent before it did anything useful.
        let (cfg, warns, _) = effective(Some("[workers]\nagent_heap_mb = 64\n"), None);
        assert_eq!(cfg.workers.agent_heap_mb, 512);
        assert!(warns.iter().any(|w| w.contains("agent_heap_mb")));
    }

    #[test]
    fn agent_heap_mb_zero_is_the_documented_opt_out() {
        // 0 = "no cap" — deliberately preserved, not floored, so a power user can opt out.
        let (cfg, warns, _) = effective(Some("[workers]\nagent_heap_mb = 0\n"), None);
        assert_eq!(cfg.workers.agent_heap_mb, 0);
        assert!(!warns.iter().any(|w| w.contains("agent_heap_mb")));
    }

    #[test]
    fn ram_derived_concurrency_divides_usable_ram_by_the_heap_cap() {
        // 64 GiB − 6 GiB reserve = 58 GiB usable ÷ 3 GiB per agent = 19.
        assert_eq!(ram_derived_concurrency(64 * GIB, 6 * GIB, 3072), 19);
        // 16 GiB − 6 = 10 ÷ 3 = 3. (The machine that died would have allowed 3, not 20.)
        assert_eq!(ram_derived_concurrency(16 * GIB, 6 * GIB, 3072), 3);
        assert_eq!(ram_derived_concurrency(128 * GIB, 6 * GIB, 3072), 40);
    }

    #[test]
    fn ram_derived_concurrency_floors_at_one() {
        // A machine with less RAM than the reserve must still be able to run ONE agent —
        // returning 0 would deadlock the orchestrator instead of degrading.
        assert_eq!(ram_derived_concurrency(8 * GIB, 6 * GIB, 3072), 1);
        assert_eq!(ram_derived_concurrency(4 * GIB, 6 * GIB, 3072), 1);
        assert_eq!(ram_derived_concurrency(0, 6 * GIB, 3072), 1);
    }

    #[test]
    fn configured_max_concurrent_is_a_ceiling_never_a_floor() {
        let mut w = WorkersConfig { max_concurrent: 20, agent_heap_mb: 3072 };
        // RAM allows fewer than configured → RAM wins, and the clamp is surfaced as a warning.
        let (n, warn) = memory_aware_concurrency(&w, Some(16 * GIB));
        assert_eq!(n, 3);
        let warn = warn.expect("a clamp must be diagnosable as a config warning");
        assert!(warn.contains("max_concurrent"), "warning names the key: {warn}");

        // RAM allows MORE than configured → the config ceiling holds; nothing to warn about.
        w.max_concurrent = 4;
        let (n, warn) = memory_aware_concurrency(&w, Some(128 * GIB));
        assert_eq!(n, 4, "an explicit max_concurrent must never be raised by spare RAM");
        assert!(warn.is_none());
    }

    #[test]
    fn memory_aware_concurrency_no_ops_when_it_cannot_measure() {
        let w = WorkersConfig { max_concurrent: 20, agent_heap_mb: 3072 };
        // Unknown RAM (unsupported platform / sysctl failure): fall back to the configured value
        // rather than guessing a number that could throttle a big machine to nothing.
        assert_eq!(memory_aware_concurrency(&w, None), (20, None));
    }

    #[test]
    fn opting_out_of_the_heap_cap_still_bounds_concurrency_by_ram() {
        // roborev 40088: the two protections must not be coupled. A user who sets agent_heap_mb = 0
        // to let agents use bigger heaps would otherwise ALSO lose the RAM-derived concurrency
        // clamp — restoring the exact 20-agents × uncapped-heap runaway this whole change exists to
        // prevent. With no cap, agents use V8's own default, so that's the budget we divide by.
        let w = WorkersConfig { max_concurrent: 20, agent_heap_mb: 0 };
        // 16 GiB − 6 GiB reserve = 10 GiB ÷ V8's ~4 GiB default = 2.
        let (n, warn) = memory_aware_concurrency(&w, Some(16 * GIB));
        assert_eq!(n, 2);
        let warn = warn.expect("the clamp must still be diagnosable when the cap is opted out");
        // The remedy must be actionable: "lower agent_heap_mb" is impossible at 0, which maps to
        // the LARGEST per-agent budget. The way out is a positive value (roborev 40311).
        assert!(warn.contains("Set a positive agent_heap_mb"), "actionable remedy: {warn}");
        assert!(!warn.contains("Lower agent_heap_mb"), "impossible remedy: {warn}");
        // And the configured ceiling still wins when RAM is plentiful.
        let w = WorkersConfig { max_concurrent: 4, agent_heap_mb: 0 };
        assert_eq!(memory_aware_concurrency(&w, Some(128 * GIB)), (4, None));
    }

    #[test]
    fn effective_config_exposes_the_derived_concurrency() {
        // The frontend concurrency gate reads this field, so it must be populated (and never 0)
        // on a plain default construction.
        let eff = EffectiveConfig::derive(SparkleConfig::default(), Vec::new());
        assert!(eff.effective_max_concurrent >= 1);
        assert!(eff.effective_max_concurrent <= eff.config.workers.max_concurrent);
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
    fn worktree_pool_defaults_overrides_and_cap() {
        // Absent [worktree_pool] → the built-in defaults (enabled, size 2).
        let (cfg, _, _) = effective(None, None);
        assert!(cfg.worktree_pool.enabled);
        assert_eq!(cfg.worktree_pool.size, 2);

        // Global override, field by field.
        let g = "[worktree_pool]\nenabled = false\nsize = 4\n";
        let (cfg, _, _) = effective(Some(g), None);
        assert!(!cfg.worktree_pool.enabled);
        assert_eq!(cfg.worktree_pool.size, 4);

        // Per-project overridable (like [freshness]); no "ignored" warning.
        let p = "[worktree_pool]\nsize = 3\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert_eq!(cfg.worktree_pool.size, 3);
        assert!(cfg.worktree_pool.enabled, "untouched field keeps its default");
        assert!(warns.is_empty());

        // An absurd size is capped (with a warning) rather than spawning a burst of checkouts.
        let g = "[worktree_pool]\nsize = 999\n";
        let (cfg, warns, _) = effective(Some(g), None);
        assert_eq!(cfg.worktree_pool.size, 16);
        assert!(warns.iter().any(|w| w.contains("worktree_pool")));

        // Boundary: exactly 16 is the max allowed — unchanged, no warning (the cap is `> 16`).
        let g = "[worktree_pool]\nsize = 16\n";
        let (cfg, warns, _) = effective(Some(g), None);
        assert_eq!(cfg.worktree_pool.size, 16);
        assert!(!warns.iter().any(|w| w.contains("worktree_pool")));

        // size = 0 is a valid "disable warming" value — accepted as-is, no floor, no warning.
        let g = "[worktree_pool]\nsize = 0\n";
        let (cfg, warns, _) = effective(Some(g), None);
        assert_eq!(cfg.worktree_pool.size, 0);
        assert!(!warns.iter().any(|w| w.contains("worktree_pool")));
    }

    #[test]
    fn capture_defaults_and_overrides() {
        // Absent [capture] section → the built-in default shortcut.
        let (cfg, _, _) = effective(None, None);
        assert_eq!(cfg.capture.popover_shortcut, "ctrl+shift+r");

        // Global layer overrides it.
        let g = "[capture]\npopover_shortcut = \"alt+f9\"\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert_eq!(cfg.capture.popover_shortcut, "alt+f9");
    }

    #[test]
    fn project_capture_is_ignored_with_warning() {
        // A global keyboard shortcut is machine-wide, not repo-scoped — a per-project
        // [capture] section is ignored (like [workers]/[ai]) so two repos can't fight
        // over which accelerator the one OS-level hotkey uses.
        let p = "[capture]\npopover_shortcut = \"alt+f9\"\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert_eq!(cfg.capture.popover_shortcut, "ctrl+shift+r");
        assert!(warns.iter().any(|w| w.contains("[capture]")));
    }

    #[test]
    fn voice_defaults_and_overrides() {
        // Absent [voice] section → the built-in wake/stop words + pause-on-submit default.
        let (cfg, _, _) = effective(None, None);
        assert_eq!(cfg.voice.wake_word, "Hey Sparkle");
        assert_eq!(cfg.voice.stop_word, "Sparkle, stop");
        assert!(cfg.voice.pause_on_submit);

        // Global layer overrides each field independently.
        let g = r#"
            [voice]
            wake_word = "Hey Jarvis"
            stop_word = "Jarvis, halt"
            pause_on_submit = false
        "#;
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert_eq!(cfg.voice.wake_word, "Hey Jarvis");
        assert_eq!(cfg.voice.stop_word, "Jarvis, halt");
        assert!(!cfg.voice.pause_on_submit);

        // A partial override leaves the untouched fields at their defaults.
        let g2 = "[voice]\nwake_word = \"Computer\"\n";
        let (cfg, _, _) = effective(Some(g2), None);
        assert_eq!(cfg.voice.wake_word, "Computer");
        assert_eq!(cfg.voice.stop_word, "Sparkle, stop");
        assert!(cfg.voice.pause_on_submit);
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
    fn ai_auto_approve_defaults_on_and_overrides() {
        let (cfg, _, _) = effective(None, None);
        assert!(cfg.ai.auto_approve, "auto_approve defaults on");

        let g = "[ai]\nauto_approve = false\n";
        let (cfg, _, _) = effective(Some(g), None);
        assert!(!cfg.ai.auto_approve);
        // Untouched [ai] fields keep their defaults.
        assert!(cfg.ai.suggested_actions);
    }

    #[test]
    fn approvals_default_ships_on_except_bash() {
        // A fresh install auto-approves every non-destructive category out of the box, so users
        // aren't blocked by permission prompts. bash stays ask-each-time (destructive).
        let (cfg, _, _) = effective(None, None);
        assert_eq!(cfg.approvals, ApprovalsConfig::default());
        assert_eq!(cfg.approvals.skill.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.edit.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.mcp.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.fetch.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.other.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.bash, None, "bash is the one category that must stay ask-each-time");
    }

    #[test]
    fn approvals_global_applies_and_project_overrides_per_category() {
        // Global sets skill=always, bash=never; the project overrides skill and adds edit.
        let g = "[approvals]\nskill = \"always\"\nbash = \"never\"\n";
        let p = "[approvals]\nskill = \"never\"\nedit = \"always\"\n";
        let (cfg, warns, hard) = effective(Some(g), Some(p));
        assert!(!hard);
        // Project value beats global for skill; bash falls back to the global rule; edit is the
        // project's own; a category no layer mentions keeps its shipped default ("always" for mcp).
        assert_eq!(cfg.approvals.skill.as_deref(), Some("never"));
        assert_eq!(cfg.approvals.bash.as_deref(), Some("never"));
        assert_eq!(cfg.approvals.edit.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.mcp.as_deref(), Some("always"));
        // [approvals] is repo-scoped BY DESIGN — it must NOT be reported as ignored in a project file
        // (unlike [ai]/[workers]); this is the per-project-honored assertion from the spec.
        assert!(
            !warns.iter().any(|w| w.contains("[approvals]")),
            "per-project [approvals] must be honored, not ignored"
        );
    }

    #[test]
    fn partial_approvals_section_preserves_defaults_for_omitted_categories() {
        // Regression: a user who writes ONLY `bash = "always"` must NOT lose the shipped "always"
        // default on every other category. TOML parses into PartialApprovals (per-field Option) and
        // apply_approvals overlays field-by-field over ApprovalsConfig::default(), so an omitted
        // field keeps the default rather than reverting to None ("ask"). Guards against a future
        // refactor that deserializes straight into ApprovalsConfig (which WOULD zero the omitted
        // fields to None).
        let g = "[approvals]\nbash = \"always\"\n";
        let (cfg, _, hard) = effective(Some(g), None);
        assert!(!hard);
        assert_eq!(cfg.approvals.bash.as_deref(), Some("always"), "the one field written wins");
        // Every omitted category still carries the shipped default.
        assert_eq!(cfg.approvals.skill.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.edit.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.mcp.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.fetch.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.other.as_deref(), Some("always"));
    }

    #[test]
    fn approvals_round_trip_through_set_and_unset() {
        // A round-trip over the comment-preserving writers: set a project rule, then clear it, and
        // confirm the effective precedence (project overrides global) at each step. Uses a temp dir
        // as the "app_data"/project root so no real file is touched.
        let dir = std::env::temp_dir().join(format!("sparkle-approvals-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();

        // Seed a global rule and a project rule.
        set_value(&dir, "approvals.bash", &serde_json::json!("always")).unwrap();
        set_project_value(&root, "approvals.bash", &serde_json::json!("never")).unwrap();

        let g_text = read_if_exists(&global_path(&dir));
        let p_text = read_if_exists(&project_path(&root));
        let (cfg, _, _) = build_effective(SparkleConfig::default(), g_text.as_deref(), p_text.as_deref());
        assert_eq!(cfg.approvals.bash.as_deref(), Some("never"), "project overrides global");

        // Clear the project rule → falls back to the global rule.
        unset_project_value(&root, "approvals.bash").unwrap();
        let p_text = read_if_exists(&project_path(&root));
        let (cfg, _, _) = build_effective(SparkleConfig::default(), g_text.as_deref(), p_text.as_deref());
        assert_eq!(cfg.approvals.bash.as_deref(), Some("always"), "falls back to global");

        // Clear the global rule → fully unset.
        unset_value(&dir, "approvals.bash").unwrap();
        let g_text = read_if_exists(&global_path(&dir));
        let (cfg, _, _) = build_effective(SparkleConfig::default(), g_text.as_deref(), None);
        assert_eq!(cfg.approvals.bash, None, "fully cleared");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn done_and_delivered_default_to_undefined() {
        let (cfg, _, _) = effective(None, None);
        assert_eq!(cfg.done.description, None);
        assert!(cfg.done.criteria.is_empty());
        assert_eq!(cfg.delivered.description, None);
        assert_eq!(cfg.delivered.detected_method, None);
        assert_eq!(cfg.delivered.confidence, None);
        assert_eq!(cfg.delivered.confidence_note, None);
        assert!(!cfg.delivered.learned);
        assert!(cfg.delivered.criteria.is_empty());
    }

    #[test]
    fn done_and_delivered_honored_per_project_and_global() {
        // A definition with a description + one auto criterion and one manual criterion per stage.
        let toml = r#"
            [done]
            description = "Merged into origin/main."
            [[done.criteria]]
            text   = "Merged into origin/main"
            kind   = "auto"
            signal = "merged_to_main"
            [[done.criteria]]
            text = "Reviewed by a teammate"
            kind = "manual"

            [delivered]
            description = "Shipped to production."
            detected_method = "release_tag"
            confidence      = "high"
            confidence_note = "Ships via GitHub Releases (v* tags)."
            learned         = true
            [[delivered.criteria]]
            text   = "Commit is in a cut release"
            kind   = "auto"
            signal = "in_release"
            [[delivered.criteria]]
            text = "Deployed to prod verified"
            kind = "manual"
        "#;

        // (1) Per-project honoring — [done]/[delivered] are repo-scoped BY DESIGN (unlike
        // [workers]/[ai]/[capture], which are ignored in a project file with a warning).
        let (cfg, warns, hard) = effective(None, Some(toml));
        assert!(!hard);
        assert!(
            !warns.iter().any(|w| w.contains("[done]") || w.contains("[delivered]")),
            "stage definitions must NOT be reported as ignored in a project file"
        );

        assert_eq!(cfg.done.description.as_deref(), Some("Merged into origin/main."));
        assert_eq!(cfg.done.criteria.len(), 2);
        assert_eq!(cfg.done.criteria[0].text, "Merged into origin/main");
        assert_eq!(cfg.done.criteria[0].kind, "auto");
        assert_eq!(cfg.done.criteria[0].signal.as_deref(), Some("merged_to_main"));
        assert_eq!(cfg.done.criteria[1].kind, "manual");
        assert_eq!(cfg.done.criteria[1].signal, None); // manual → no signal

        assert_eq!(cfg.delivered.description.as_deref(), Some("Shipped to production."));
        assert_eq!(cfg.delivered.detected_method.as_deref(), Some("release_tag"));
        assert_eq!(cfg.delivered.confidence.as_deref(), Some("high"));
        assert_eq!(
            cfg.delivered.confidence_note.as_deref(),
            Some("Ships via GitHub Releases (v* tags).")
        );
        assert!(cfg.delivered.learned);
        assert_eq!(cfg.delivered.criteria.len(), 2);
        assert_eq!(cfg.delivered.criteria[0].signal.as_deref(), Some("in_release"));
        assert_eq!(cfg.delivered.criteria[1].kind, "manual");
        assert_eq!(cfg.delivered.criteria[1].signal, None);

        // (2) The SAME sections in the GLOBAL file are also honored (global holds defaults).
        let (gcfg, gwarns, ghard) = effective(Some(toml), None);
        assert!(!ghard);
        assert!(gwarns.is_empty());
        assert_eq!(gcfg.done.criteria.len(), 2);
        assert_eq!(gcfg.delivered.confidence.as_deref(), Some("high"));
        assert!(gcfg.delivered.learned);
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
    fn set_stage_definition_round_trips_and_replaces_preserving_other_sections() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let path = project_path(&root);
        // Pre-existing per-project file with an UNRELATED [workflow] section + a comment, which the
        // stage-definition write must leave byte-intact.
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "# keep this comment\n[workflow]\nrequire_pr = false\n").unwrap();

        // A [delivered] def: description + one AUTO + one MANUAL criterion + confidence metadata.
        let def = serde_json::json!({
            "description": "Shipped to production.",
            "detected_method": "release_tag",
            "confidence": "high",
            "confidence_note": "Ships via GitHub Releases (v* tags).",
            "learned": false,
            "criteria": [
                { "text": "Commit is in a cut release", "kind": "auto", "signal": "in_release" },
                { "text": "Deployed to prod verified", "kind": "manual", "signal": null }
            ]
        });
        write_stage_definition(&root, "delivered", &def).unwrap();

        // (1) Round-trips through build_effective (per-project honoring, project_root = temp).
        let ptext = std::fs::read_to_string(&path).unwrap();
        let (cfg, _, hard) = build_effective(SparkleConfig::default(), None, Some(&ptext));
        assert!(!hard);
        assert_eq!(cfg.delivered.description.as_deref(), Some("Shipped to production."));
        assert_eq!(cfg.delivered.detected_method.as_deref(), Some("release_tag"));
        assert_eq!(cfg.delivered.confidence.as_deref(), Some("high"));
        assert_eq!(
            cfg.delivered.confidence_note.as_deref(),
            Some("Ships via GitHub Releases (v* tags).")
        );
        assert!(!cfg.delivered.learned);
        assert_eq!(cfg.delivered.criteria.len(), 2);
        assert_eq!(cfg.delivered.criteria[0].kind, "auto");
        assert_eq!(cfg.delivered.criteria[0].signal.as_deref(), Some("in_release"));
        assert_eq!(cfg.delivered.criteria[1].kind, "manual");
        assert_eq!(cfg.delivered.criteria[1].signal, None);
        // The unrelated [workflow] override still applies + the comment survived.
        assert!(!cfg.workflow.require_pr);
        assert!(ptext.contains("# keep this comment"));

        // (2) Writing AGAIN REPLACES (not appends) the [delivered] section.
        let def2 = serde_json::json!({
            "description": "Only one criterion now.",
            "detected_method": "ci_deploy",
            "confidence": "medium",
            "confidence_note": null,
            "learned": true,
            "criteria": [ { "text": "Deployed by CI", "kind": "auto", "signal": "in_release" } ]
        });
        write_stage_definition(&root, "delivered", &def2).unwrap();
        let ptext2 = std::fs::read_to_string(&path).unwrap();
        // Exactly ONE [delivered] header — replaced in place, not appended.
        assert_eq!(ptext2.matches("[delivered]").count(), 1, "section replaced, not appended");
        let (cfg2, _, _) = build_effective(SparkleConfig::default(), None, Some(&ptext2));
        assert_eq!(cfg2.delivered.description.as_deref(), Some("Only one criterion now."));
        assert_eq!(cfg2.delivered.detected_method.as_deref(), Some("ci_deploy"));
        assert!(cfg2.delivered.learned);
        assert_eq!(cfg2.delivered.criteria.len(), 1);
        // The old confidence_note key is gone (wholesale replace), not carried over.
        assert_eq!(cfg2.delivered.confidence_note, None);
        // [workflow] + comment STILL intact after the second write.
        assert!(ptext2.contains("# keep this comment"));
        assert!(!cfg2.workflow.require_pr);

        // (3) An unknown stage key is rejected (only done/delivered allowed).
        assert!(write_stage_definition(&root, "backlog", &def2).is_err());
    }

    #[test]
    fn set_stage_definition_creates_missing_sparkle_dir_and_file() {
        // No pre-existing .sparkle dir: the writer must create it and the file.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let def = serde_json::json!({
            "description": "Merged into origin/main.",
            "criteria": [
                { "text": "Merged into origin/main", "kind": "auto", "signal": "merged_to_main" },
                { "text": "Reviewed by a teammate", "kind": "manual", "signal": null }
            ]
        });
        write_stage_definition(&root, "done", &def).unwrap();
        let ptext = std::fs::read_to_string(project_path(&root)).unwrap();
        let (cfg, _, hard) = build_effective(SparkleConfig::default(), None, Some(&ptext));
        assert!(!hard);
        assert_eq!(cfg.done.description.as_deref(), Some("Merged into origin/main."));
        assert_eq!(cfg.done.criteria.len(), 2);
        assert_eq!(cfg.done.criteria[0].signal.as_deref(), Some("merged_to_main"));
        assert_eq!(cfg.done.criteria[1].kind, "manual");
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

    // Drift guard for the vendored roborev git hook bundled at resources/roborev/post-commit.
    // It is a byte-for-byte copy of the upstream seed-auto-roborev wrapper (which carries its own
    // exhaustive skip-glob test suite). The subtle pytest/sparkle-fixture skip heuristics are easy
    // to regress if someone edits the Sparkle copy, so assert the load-bearing guard tokens survive.
    #[test]
    fn vendored_roborev_post_commit_keeps_its_skip_guards() {
        let hook = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/roborev/post-commit"
        ))
        .expect("vendored resources/roborev/post-commit must exist (bundled Tauri resource)");
        for needle in [
            "pytest-of-",         // pytest tmp_path_factory fixture repos
            "sparkle-test-",      // Sparkle Rust/TS suite throwaway repos
            "sparkle-accounts-",
            "sparkle-bridge-",
            "\" post-commit",     // the ACTUAL delegation invocation `"$ROBOREV" post-commit` —
                                  // not the bare word "post-commit", which also appears in comments
        ] {
            assert!(
                hook.contains(needle),
                "vendored post-commit lost the '{needle}' guard/behavior — did the copy drift from the seed?"
            );
        }
    }
}
