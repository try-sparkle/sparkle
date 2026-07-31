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
    /// The user's requested ceiling on parallel agents, or `None` for AUTO — let the machine decide.
    ///
    /// `None` is the default, and it is the important case: a fixed number cannot be right for both
    /// an 8 GiB Air and a 192 GiB Studio, and the old hardcoded 20 silently throttled every machine
    /// bigger than ~64 GiB to less than half of what it could run (the RAM clamp below only ever
    /// ratcheted DOWN, so spare capacity was unreachable). Auto derives the limit from the hardware
    /// — see `auto_concurrency_bound`.
    ///
    /// When set, it stays a CEILING ONLY: the app enforces `min(configured, auto)`, never more.
    /// Pinning a big number on a small machine must not be able to re-create the jetsam incident
    /// this whole module exists to prevent. Either way the enforced value is
    /// `EffectiveConfig::effective_max_concurrent`, which is what every concurrency gate reads.
    pub max_concurrent: Option<u32>,
    /// Per-agent V8 old-space cap in MiB, applied as `NODE_OPTIONS=--max-old-space-size=<n>` on
    /// every PTY child (pty.rs). 0 = opt out (agents then use V8's own ~4 GiB default, which is
    /// exactly the runaway that jetsam-killed a machine — see sparkle-01xv).
    pub agent_heap_mb: u32,
}

/// Runtime memory measurement — the MEASURED half of the concurrency ceiling, and the watchdog.
/// See `memwatch.rs` for what each of these drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct MemoryConfig {
    /// Whether a runtime memory sample may narrow the derived concurrency ceiling. On by default:
    /// the static ceiling is a PREDICTION (installed RAM ÷ an assumed per-agent budget, memoized
    /// once at startup) and it reacts to nothing — not to Chrome being resident, not to an agent
    /// exceeding its assumed share, not to the compressor thrashing. Off restores exactly the
    /// pre-`sparkle-0bye` behavior, which is the escape hatch if the sampler ever misjudges.
    ///
    /// It can only ever REFUSE. No sample, and no setting, can raise the ceiling above what
    /// `[workers].max_concurrent` and the machine derivation already allow.
    pub pressure_gate: bool,
    /// Per-AGENT (whole process tree, not one pid) RSS at which the UI warns, in MiB.
    ///
    /// Default 4096. Measured 2026-07-29: **1.11 GiB per agent** across 19 agents, and
    /// `sparkle-hfhs` measured ~525 MiB per PROCESS on a different day at a different agent count.
    /// 4 GiB is therefore ~3.6× the normal working set — high enough that ordinary heavy work
    /// (a build, a big test suite) does not cry wolf, low enough to catch a ramp long before the
    /// 2026-07-20 incident's ~4 GiB-per-process runaway became unrecoverable.
    pub agent_rss_warn_mb: u32,
    /// Per-agent RSS at which the UI OFFERS to kill, in MiB. Default 8192 — past the point where an
    /// agent is doing anything explicable with memory, given a 3072 MiB heap ceiling per process.
    /// 0 disables this tier.
    pub agent_rss_kill_mb: u32,
    /// Kill automatically at `agent_rss_kill_mb` instead of asking. **Default false, deliberately.**
    /// Killing an agent throws away work the user cannot recover, and a false positive is worse
    /// than a slow machine; `sparkle-0bye` asks to "warn in UI past a threshold, offer/auto kill",
    /// and the offer is what ships on by default.
    pub agent_rss_auto_kill: bool,
}

impl MemoryConfig {
    /// The shipped defaults, as a const so `Default for SparkleConfig` and any test can name the
    /// same values without a second literal that could drift.
    pub const DEFAULT: Self = MemoryConfig {
        pressure_gate: true,
        agent_rss_warn_mb: 4096,
        agent_rss_kill_mb: 8192,
        agent_rss_auto_kill: false,
    };
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AiConfig {
    pub auto_rename: bool,
    pub voice_dictation: bool,
    pub composer: bool,
    pub suggested_actions: bool,
    /// Master switch for Sparkle Auto-Approve (nudging + auto-answering Claude Code permission
    /// prompts). Default true. By default every category ([approvals] below) ships `"always"`, so
    /// with this on a fresh install auto-answers skill/bash/edit/tool/web/other prompts. Off
    /// disables ALL nudging AND all auto-answering regardless of [approvals].
    pub auto_approve: bool,
    /// The concierge column (bead sparkle-4562). Gates the two halves that cost money: the
    /// `claude -p` turn behind the chat, and the whole tool surface it can drive. Default true.
    ///
    /// The column's STATUS readout is deliberately not gated — it is derived from local app state
    /// and costs nothing — so a build with AI enhancements off still shows what needs the human,
    /// and only the thinking and acting are locked.
    pub concierge: bool,
}

/// Per-category Sparkle Auto-Approve rules. Each value is `"always"` (auto-approve that class of
/// Claude Code permission prompt) or `"never"` (ask, but stop nudging); absent (None) = ask + nudge.
/// Global `[approvals]` = all-projects rules; a project `.sparkle/config.toml [approvals]` overrides
/// per category (project value beats global). See the design spec.
///
/// DEFAULT (see `impl Default` below): EVERY category ships `"always"` — bash included — so a fresh
/// install never blocks on a permission prompt out of the box. Auto-approving commands also
/// auto-approves destructive ones (`rm -rf`, …); that is the accepted trade for agents that run
/// unattended in throwaway worktrees. The master switch (`ai.auto_approve`, default on) still
/// governs whether ANY of this fires; turning it off, or setting a category to `"never"`, restores
/// ask-each-time behavior.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ApprovalsConfig {
    pub skill: Option<String>,
    pub bash: Option<String>,
    pub edit: Option<String>,
    pub mcp: Option<String>,
    pub fetch: Option<String>,
    pub other: Option<String>,
    /// Sibling of the six categories above but with its OWN value domain (NOT "always"/"never"):
    /// how to answer the Claude Code session-resume prompt when [ai].auto_approve is on. One of
    /// `"ask"` (default — surface the prompt, don't auto-answer), `"summary"` (auto-pick "Resume
    /// from summary"), or `"full"` (auto-pick "Resume full session"). Any unrecognized value is
    /// treated as "ask". Project [approvals].resume overrides the global value, like the categories.
    pub resume: Option<String>,
}

impl Default for ApprovalsConfig {
    fn default() -> Self {
        // Ship auto-approve ON for EVERY category, bash included. Sparkle's whole point is agents
        // that keep working unattended; a bash prompt with nobody watching is a silent stall, and
        // bash is the category real work hits most (every test run, build, and git command).
        // The trade is explicit: this also auto-approves DESTRUCTIVE commands (`rm -rf`, …). The
        // mitigations are that agents work in throwaway per-agent worktrees, and that opting back
        // out is one setting — `bash = "never"`, or the [ai].auto_approve master switch.
        let always = || Some("always".to_string());
        ApprovalsConfig {
            skill: always(),
            bash: always(),
            edit: always(),
            mcp: always(),
            fetch: always(),
            other: always(),
            // Session resume defaults to "ask": unlike the permission categories, auto-picking a
            // resume mode has a real cost (a full resume can burn a big slice of usage limits), so
            // Sparkle stays hands-off until the user opts into "summary" or "full".
            resume: Some("ask".to_string()),
        }
    }
}

/// Opinionated non-AI tools Sparkle uses (surfaced in the ⋯ Settings → "Tools" pane). Machine-wide
/// (like [ai]): a per-project value is ignored with a warning. Each bool default true = the tool
/// ships on for every new install; false = that tool is used nowhere in Sparkle. Deepgram is
/// NOT here — it stays in [ai] (voice_dictation) so there's no duplication.
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
    /// Publish your DAILY TOKEN TOTALS to the public tokenmaxxing leaderboard (Builder Index).
    /// The ONE tool here that ships OFF: it is the only one that sends anything about you to a
    /// third party, so it takes a deliberate opt-in plus a one-time consent confirmation
    /// (see builder_index.rs, which also gates on a stored username + API key). Aggregates only —
    /// never file paths, prompts, code, or keys.
    pub builder_index: bool,
    /// Back your `.env*` files up to a 1Password vault, and restore them into fresh agent
    /// worktrees. Like `builder_index`, defaults OFF: every other flag toggles behavior Sparkle
    /// can deliver on its own, but this one needs an external account, the `op` CLI, and a chosen
    /// vault. Shipping it on would advertise a capability a new install cannot actually perform,
    /// so the user opts in from the Tools pane once those prerequisites are met.
    pub onepassword: bool,
}

/// The concierge's PER-TOOL AUTONOMY POLICY (`[concierge.tools]`).
///
/// One key per concierge tool, each `"allow"` (the concierge acts silently), `"ask"` (it needs the
/// human's word first), or `"deny"` (refused outright). This is deliberately NOT a single coarse
/// autonomy dial: a dial has to be set to the strictness of the most dangerous thing it governs, so
/// "read my terminals freely" and "never merge a PR unasked" would collapse into one number.
///
/// EVERY KEY IS OPTIONAL, and an absent key is the normal case rather than a gap. The frontend
/// policy layer (services/conciergeTools/policy.ts) derives a default for each tool from the risk
/// its tool domain already classifies it with — read-only/routine → allow, everything irreversible,
/// outward-facing, metered, disruptive or main-touching → ask. So this table holds only the rules
/// the human actually changed, and a missing key resolves through a total function rather than
/// falling into a hole.
///
/// A FREE-FORM MAP, not a struct of named fields, on purpose. The authoritative tool list lives in
/// the TypeScript domain modules, where each operation union is paired with an exhaustive risk map
/// (adding a tool without classifying it is a typecheck failure there). Restating ~40 tool names
/// here would create a second list that drifts from the first, and Rust would have no way to notice.
/// So this layer stays schema-agnostic about NAMES and validates only VALUES.
///
/// Machine-wide, like [ai]/[tools]: a per-project value is ignored with a warning. That is a
/// security boundary rather than tidiness — a `.sparkle/config.toml` checked into a repo could
/// otherwise grant the concierge silent `quit_app`/`remove_project` authority over the user's whole
/// machine just by being cloned.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ConciergeConfig {
    /// Tool name → `"allow"` | `"ask"` | `"deny"`. Empty by default (every tool on its derived
    /// default). Values are kept VERBATIM, including unrecognized ones: `validate` warns about them
    /// but does not drop them, because the frontend treats an unreadable rule as `ask` and dropping
    /// it here would silently restore a permissive default on a rule the user was trying to tighten.
    pub tools: std::collections::BTreeMap<String, String>,
    /// The deterministic reply linter's policy (`[concierge.checks]`). Unlike `tools`, this ships
    /// NON-empty: the checks ARE the policy, so a fresh install lints from the first turn.
    pub checks: ConciergeChecksConfig,
}

/// The three values a `[concierge.tools]` entry may take. Mirrors PolicyDecision in policy.ts.
const CONCIERGE_TOOL_DECISIONS: [&str; 3] = ["allow", "ask", "deny"];

/// The three values a `[concierge.checks.<id>].severity` may take, described as they BEHAVE in this
/// build rather than as designed — the two differ, and saying otherwise here is the same unkept
/// promise a configured-but-unimplemented check is:
///
/// * `"warn"` — the violation is counted and appended to `concierge-lint.jsonl`. The reply renders
///   UNCHANGED; there is no badge yet, because nothing consumes the metrics store outside the
///   runner.
/// * `"block"` — NOT YET IMPLEMENTED, and identical to `"warn"` at the mount today. It is designed
///   to re-prompt the concierge once for a corrected reply; `ConciergeHost` reads `LintResult.text`
///   and discards `blocked`. No shipped check uses it, and `conciergeLintRegistry.test.ts` refuses
///   one until the re-prompt exists.
/// * `"off"` — that one check is skipped, leaving its row (and any comment explaining WHY) in place.
///
/// `pub(crate)` so `concierge_lint_log::SEVERITIES` can be pinned against it by direct comparison.
/// That log restates this vocabulary (it must, to bucket a violation without depending on config),
/// and the sibling test `the_severity_vocabulary_matches_the_config_one` fails if the two ever
/// diverge. Comparing the constants beats re-parsing this file's text — the analogous
/// TypeScript pin has to scrape source because it crosses a language boundary, and it already broke
/// once on a too-greedy extractor. Same crate, so there is no reason to be that fragile here.
pub(crate) const CONCIERGE_CHECK_SEVERITIES: [&str; 3] = ["block", "warn", "off"];

/// The severity an unreadable `severity` value resolves to. `"warn"` and never `"off"`: a typo in a
/// line the user wrote to TIGHTEN a check must not silently switch that check off. Same direction as
/// `[concierge.tools]`, where an unrecognized decision reads as the stricter `"ask"`.
const CONCIERGE_CHECK_SEVERITY_FALLBACK: &str = "warn";

/// ONE check's policy in `[concierge.checks.<id>]`.
///
/// Every field is a SCALAR on purpose. `json_to_toml_value` accepts only bool / i64 / String and
/// rejects arrays and tables, so a table-per-check of scalars is writable from the UI through the
/// existing dotted setter (`concierge.checks.relay-paste.enabled = false`) — an array-of-tables
/// would need a bespoke writer like `write_stage_definition`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ConciergeCheck {
    /// Run this check at all. `false` and `severity = "off"` both disable it; the pair exists
    /// because they read differently in a hand-edited file ("switched off" vs "downgraded").
    pub enabled: bool,
    /// `"block"` | `"warn"` | `"off"`, KEPT VERBATIM including an unrecognized value: `validate`
    /// warns about it and [`ConciergeCheck::effective_severity`] resolves it, but nothing rewrites
    /// what the user typed — the raw string is what makes the warning nameable and fixable.
    pub severity: String,
    /// Rewrite the reply into the compliant form instead of just reporting it. Only meaningful for
    /// the checks whose compliant form is mechanically derivable (a bare name → its pill); a check
    /// whose fix is a rewrite only the model can produce ships `false`.
    pub autofix: bool,
    /// The check's numeric knob, where it has one — contiguous verbatim characters for the overlap
    /// checks. `None` for a check that takes no threshold, which is not the same as `0`.
    pub threshold: Option<i64>,
    /// The check's word list, where it has one, comma-separated so it stays hand-editable as a
    /// scalar (an array would not survive `json_to_toml_value`). `None` for a check with no list.
    pub words: Option<String>,
}

impl Default for ConciergeCheck {
    /// The policy an UNKNOWN check id resolves to: on, warning, no autofix. A check id this build
    /// has never heard of does nothing (no linter claims it), so the value only matters when a newer
    /// Sparkle reads the same file back — and "on and warning" is the honest, non-weakening default.
    fn default() -> Self {
        Self {
            enabled: true,
            severity: CONCIERGE_CHECK_SEVERITY_FALLBACK.to_string(),
            autofix: false,
            threshold: None,
            words: None,
        }
    }
}

impl ConciergeCheck {
    /// The severity the linter ACTS on: the configured value when it is one of
    /// [`CONCIERGE_CHECK_SEVERITIES`], otherwise [`CONCIERGE_CHECK_SEVERITY_FALLBACK`].
    ///
    /// Separate from the stored `severity` so a typo is both surfaced (the raw string is still there
    /// for `validate` to quote back) and harmless (the check keeps running). The TypeScript linter
    /// mirrors this fallback; if the two ever disagree, THIS is the reference.
    pub fn effective_severity(&self) -> &str {
        if CONCIERGE_CHECK_SEVERITIES.contains(&self.severity.as_str()) {
            &self.severity
        } else {
            CONCIERGE_CHECK_SEVERITY_FALLBACK
        }
    }
}

/// One row of the shipped check policy — the DEFAULT for a check id, stated once.
///
/// A SEED, not a closed set. `PluginsConfig::unknown_keys` can flag an unrecognized `[plugins]` key
/// because plugin toggles are authoritative in Rust; check ids are NOT — the authoritative list
/// lives in the TypeScript linter module, exactly as the tool list does (see [`ConciergeConfig`]).
/// So an id absent from this table is kept verbatim and never warned about; the table only decides
/// what a fresh install starts with.
struct DefaultCheck {
    id: &'static str,
    severity: &'static str,
    autofix: bool,
    threshold: Option<i64>,
    words: Option<&'static str>,
}

/// The shipped policy. Every check ships ENABLED: an off-by-default linter is a linter nobody has,
/// and the whole point is that the mechanical rules stop depending on the model's attention.
///
/// `block` is reserved for the four violations whose compliant form is a rewrite only the model can
/// produce (so there is nothing to autofix, and rendering them would show the human the thing the
/// rule exists to prevent). Everything derivable from data the app already holds is `warn` +
/// `autofix`. Keep this in step with the `[concierge.checks]` block in `DEFAULT_TEMPLATE` —
/// `concierge_checks_template_matches_the_default` asserts they agree.
const DEFAULT_CONCIERGE_CHECKS: &[DefaultCheck] = &[
    // THE MOST-REPEATED FAILURE, and the one the human named four times in a single session:
    // reporting accurately and then asking permission instead of acting. Its exemption for genuinely
    // irreversible or spend-bearing actions is keyed off the tool risk classification, not off
    // phrasing — phrasing is what a model under a linter learns to game.
    //
    // SHIPPED `"warn"`, THOUGH IT IS DESIGNED TO BLOCK, and the reason is the same one that put the
    // seven checks below at `"off"` (roborev 55981). `"block"` is documented as "re-prompts the
    // concierge once for a corrected reply", and NOTHING re-prompts: `ConciergeHost` consumes
    // `LintResult.text` and discards `blocked`. Shipping `"block"` would tell the reader a passive
    // reply cannot reach them, which is exactly the unkept promise the `"off"` rows exist to avoid —
    // and it would be worse here, because the check DOES run, so the failure is invisible.
    //
    // Raise this to `"block"` in the same change that implements the re-prompt, and upgrade
    // `askWithoutAction`'s emitted action from `"warned"` to `"revised"` there — not before, or the
    // rollup counts corrections that never happened.
    DefaultCheck {
        id: "ask-without-action",
        severity: "warn",
        autofix: false,
        threshold: None,
        words: None,
    },
    // ══ NOT YET IMPLEMENTED — SHIPPED `"off"` ON PURPOSE ═══════════════════════════════════════
    // The seven rows below describe checks the TypeScript linter does NOT implement yet. They
    // shipped at their intended severities (`relay-paste` and three others at `"block"`) while
    // nothing implemented them, which made this table a PROMISE THE APP DOES NOT KEEP: a user
    // reading `severity = "block"` for `relay-paste` reasonably concludes a relayed paste cannot
    // reach them, and it can.
    //
    // `"off"` is the honest value, and it is strictly better than deleting the rows. Deleting them
    // would lose the intended policy AND make a later implementation land silently switched ON for
    // every existing user — the row is where the design decision is recorded. `off` says "designed,
    // not built"; an absent row says nothing at all.
    //
    // WHAT MAKES THIS SELF-CORRECTING: `conciergeLintRegistry.test.ts` asserts that every id here
    // whose severity is NOT `"off"` has an implementation in the linter's `CHECKS` registry. Turning
    // one of these on without writing the check is a RED TEST, not a silent no-op. Flip the severity
    // in the same commit that implements the check — never before.
    //
    // Their intended severities, for whoever implements them: relay-paste = block,
    // unresolved-agent-pill = block, actions-first = block, unreported-refusal = block,
    // bare-agent-name = warn + autofix, bare-pr-number = warn + autofix, fat-pill-label = warn.
    // The most recently broken rule: never paste the text you just sent back into the reply.
    DefaultCheck {
        id: "relay-paste",
        severity: "off",
        autofix: false,
        threshold: Some(240),
        words: None,
    },
    DefaultCheck {
        id: "bare-agent-name",
        severity: "off",
        // Autofix ONLY on a unique roster match — an ambiguous name warns instead, because a pill
        // carrying the wrong id opens the wrong agent and the reader cannot tell it guessed.
        autofix: true,
        threshold: None,
        words: None,
    },
    DefaultCheck {
        id: "bare-pr-number",
        severity: "off",
        autofix: true,
        threshold: None,
        words: None,
    },
    DefaultCheck {
        id: "unresolved-agent-pill",
        // Intended to block: a pill whose id resolves to nothing is worse than the bare text it
        // replaced. Off until something implements it.
        severity: "off",
        autofix: false,
        threshold: None,
        words: None,
    },
    DefaultCheck {
        id: "fat-pill-label",
        severity: "off",
        autofix: true,
        threshold: None,
        words: None,
    },
    DefaultCheck {
        id: "actions-first",
        severity: "off",
        autofix: false,
        threshold: None,
        words: None,
    },
    DefaultCheck {
        id: "unreported-refusal",
        severity: "off",
        autofix: false,
        threshold: None,
        words: None,
    },
    // ══ IMPLEMENTED AND LIVE ═══════════════════════════════════════════════════════════════════
    DefaultCheck {
        id: "hedge-words",
        severity: "warn",
        autofix: false,
        threshold: None,
        // The rule names two; the list is hand-editable so a user can add their own.
        words: Some("should, deserves to"),
    },
    DefaultCheck {
        id: "restated-state",
        severity: "warn",
        autofix: false,
        threshold: Some(200),
        words: None,
    },
    DefaultCheck {
        id: "naked-file-ref",
        severity: "warn",
        autofix: false,
        threshold: None,
        words: None,
    },
];

/// The deterministic concierge-reply linter's policy (`[concierge.checks]`).
///
/// DATA for a linter, deliberately — the rules that can be decided mechanically live here so a
/// misfiring check is a one-line edit instead of a rebuild, while the rules that are dispositions
/// stay prose in `concierge-guidelines.md`. Hot reload is free: the existing `config.toml` watcher
/// emits `config-changed`, so a severity edit takes effect on the next turn.
///
/// GLOBAL ONLY, and this is a security boundary rather than tidiness. `build_effective` already
/// ignores `[concierge]` in a per-project `.sparkle/config.toml` so a cloned repo cannot grant
/// itself the concierge's authority; the same reasoning binds harder here — a repo must not be able
/// to disable the linter that governs the replies the human reads ABOUT that repo.
///
/// `checks` is a FREE-FORM MAP, schema-agnostic about check NAMES and validating only VALUES, for
/// the same reason `[concierge.tools]` is (see [`ConciergeConfig`]): the authoritative check list
/// lives in the TypeScript linter module, and a second copy here would drift with Rust unable to
/// notice. An unrecognized id is kept verbatim so a config written by a newer Sparkle survives a
/// round-trip through an older one.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ConciergeChecksConfig {
    /// Master switch. `false` disables the whole linter and every rule reverts to prose — the
    /// widest of the three escape hatches (one check off → the whole linter off → hand-annotate the
    /// file saying why), because a blocking check that misfires would make the concierge unusable
    /// and the way out has to be cheaper than the failure.
    pub enabled: bool,
    /// Append each violation to `concierge-lint.jsonl` (metadata only — never the reply text).
    pub log: bool,
    /// Also log a short HASH of the matched span, to tell "the same violation 40 times" from "40
    /// different ones" without putting reply text on disk. Opt-in and off by default.
    ///
    /// NOT YET IMPLEMENTED — setting it `true` currently does nothing (roborev 55981). The Rust sink
    /// is fully built for it (`concierge_lint_log` accepts, hex-validates and length-caps `hash`),
    /// but no producer computes one: `Violation` carries `span` as a character COUNT and never the
    /// matched text, so the runner has nothing to digest. Honoring the flag needs the checks to
    /// surface a digest themselves. Documented here rather than silently inert, for the same reason
    /// the unimplemented checks ship `"off"`.
    pub log_matches: bool,
    /// Check id → its policy. Seeded from [`DEFAULT_CONCIERGE_CHECKS`]; unknown ids are KEPT.
    ///
    /// A check RUNS when `enabled` (this struct's) is true, its own `enabled` is true, and its
    /// resolved severity ([`ConciergeCheck::effective_severity`]) is not `"off"`. That resolution
    /// lives in the TypeScript linter — deliberately not mirrored as an unused Rust helper, which
    /// would be a second implementation with nothing to keep it honest.
    pub checks: std::collections::BTreeMap<String, ConciergeCheck>,
}

impl ConciergeChecksConfig {
    /// The shipped policy, built from [`DEFAULT_CONCIERGE_CHECKS`] so the defaults are stated once
    /// rather than in the table, `SparkleConfig::default()`, and `DEFAULT_TEMPLATE` separately.
    pub fn defaults() -> Self {
        Self {
            enabled: true,
            log: true,
            log_matches: false,
            checks: DEFAULT_CONCIERGE_CHECKS
                .iter()
                .map(|d| {
                    (
                        d.id.to_string(),
                        ConciergeCheck {
                            enabled: true,
                            severity: d.severity.to_string(),
                            autofix: d.autofix,
                            threshold: d.threshold,
                            words: d.words.map(str::to_string),
                        },
                    )
                })
                .collect(),
        }
    }

}

impl Default for ConciergeChecksConfig {
    /// The shipped policy, NOT an empty map. `ConciergeConfig` derives `Default`, so an empty one
    /// here would make `ConciergeConfig::default()` mean "linter with no rules" and diverge from
    /// `SparkleConfig::default()` — the exact template-disagrees-with-Default bug class this file
    /// has been bitten by before.
    fn default() -> Self {
        Self::defaults()
    }
}

/// 1Password env-backup state that isn't a simple on/off toggle. Machine-wide (like [tools]): a
/// per-project value is ignored with a warning, because the vault is a property of the user's
/// 1Password account, not of any one repo.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct OnePasswordConfig {
    /// The vault chosen in the one-time picker. `None` until then — the backup UI stays in its
    /// "pick a vault" state rather than guessing, since writing secrets into the wrong vault (say,
    /// one shared with a team) is not something to do by default.
    pub vault_id: Option<String>,
    /// Restore backed-up env files into each newly created agent worktree. This is the payoff of
    /// the whole feature — `.env*` is gitignored, so a worktree never carries one and every worker
    /// agent starts without its project's secrets. Off by default: it writes files into a fresh
    /// worktree, which the user should ask for rather than discover.
    pub seed_worktrees: bool,
}

// ---------------------------------------------------------------------------------------
// Claude Code marketplace plugins Sparkle pre-enables for every agent ([plugins]).
//
// SCHEMA (verified 2026-07-24 against code.claude.com/docs/en/discover-plugins +
// /plugins-reference, `claude plugin --help`, and a live `claude plugin install` run — NOT
// guessed). Claude Code reads two settings keys, both OBJECTS (not arrays):
//
//   "extraKnownMarketplaces": { "<marketplace-name>": { "source": { "source": "github",
//                                                                   "repo": "owner/repo" } } }
//   "enabledPlugins":         { "<plugin>@<marketplace>": true }
//
// AUTO-INSTALL: enabling a plugin in settings alone does NOT fetch it. Verified by hand: a
// settings.local.json naming `code-simplifier@claude-plugins-official` left `claude plugin list`
// with no such plugin, and the docs say a settings-enabled plugin from an external source
// "doesn't load until the team member installs it". So the settings write is only half the job —
// `hooks::ensure_default_plugins_installed` runs the (headless, idempotent) `claude plugin install`
// that actually populates the shared `~/.claude/plugins/cache`.

/// Where a marketplace comes from, mirroring the nested `source` object Claude Code expects.
/// Only the `github` form is modeled — it is what every marketplace we ship uses.
///
/// NOT `Serialize`: the wire encoding Claude Code reads is built by hand in
/// `hooks::merge_plugin_settings` (`{ "source": { "source": "github", "repo": "o/r" } }`), which is
/// a different, NESTED shape from anything a derive on this struct would emit. A derive here would
/// be a second, silently-wrong encoding waiting to be picked up by mistake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarketplaceSource {
    /// The marketplace name Claude Code registers it under — the `@<marketplace>` half of a
    /// plugin id. Must match the `name` field in that repo's `.claude-plugin/marketplace.json`.
    pub name: &'static str,
    /// GitHub `owner/repo` hosting `.claude-plugin/marketplace.json`.
    pub repo: &'static str,
}

/// One row of the known-plugins table: a `[plugins]` toggle mapped to the marketplace + plugin id
/// Claude Code needs. Data-driven on purpose — adding episodic-memory, an LSP plugin, etc. is a new
/// row here plus a bool field on `PluginsConfig`, with no new merge/injection plumbing.
///
/// NOT `Serialize`, for the same reason as [`MarketplaceSource`]: nothing sends this struct over a
/// wire. What crosses to Claude Code is `id()` (an `enabledPlugins` key) and the hand-built
/// marketplace object in `hooks::merge_plugin_settings`; what crosses to the frontend is
/// [`PluginsConfig`], which IS serialized as part of `SparkleConfig`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnownPlugin {
    /// The `[plugins]` key (also the dotted config path suffix and the frontend toggle key).
    pub toggle: &'static str,
    /// Plugin name as listed in the marketplace's `marketplace.json` — the half before `@`.
    pub plugin: &'static str,
    /// Marketplace the plugin is installed from.
    pub marketplace: &'static str,
    /// Where that marketplace lives. Populated for EVERY row, including the official one: the
    /// installer runs an idempotent `claude plugin marketplace add <repo>` from this before
    /// installing, which is what makes a fresh machine work (see the field note below).
    pub source: Option<MarketplaceSource>,
    /// Whether this plugin ships enabled on a new install. The DEFAULT LIVES HERE, in the table
    /// row, rather than in `SparkleConfig::default()` and `DEFAULT_TEMPLATE` and a struct field —
    /// three places that previously had to be edited in lockstep and could silently disagree.
    /// `plugins_default_matches_the_template` asserts the template still agrees with this.
    pub default_on: bool,
}

impl KnownPlugin {
    /// The `<plugin>@<marketplace>` id — the `enabledPlugins` key and the `claude plugin install`
    /// argument. One definition so the settings write and the install shell-out can never diverge.
    pub fn id(&self) -> String {
        format!("{}@{}", self.plugin, self.marketplace)
    }

    /// The source to DECLARE in a worktree's `extraKnownMarketplaces` — `None` for the official
    /// marketplace, which Claude Code owns and registers itself. Declaring that name ourselves
    /// would re-point a marketplace Claude Code manages and put a redundant entry in every agent's
    /// settings file, so registration for it happens the other way: the installer's `marketplace
    /// add`, which is a machine-level, idempotent no-op once it's registered.
    pub fn declared_source(&self) -> Option<MarketplaceSource> {
        self.source.filter(|_| self.marketplace != OFFICIAL_MARKETPLACE)
    }
}

/// Anthropic's curated marketplace, and the GitHub repo backing it. Claude Code registers this
/// marketplace itself — but only once it has been launched INTERACTIVELY at least once. Sparkle
/// spawns agents on a machine where that may never have happened, so the installer registers it
/// explicitly rather than assuming; see [`KnownPlugin::declared_source`].
pub const OFFICIAL_MARKETPLACE: &str = "claude-plugins-official";
pub const OFFICIAL_MARKETPLACE_REPO: &str = "anthropics/claude-plugins-official";

/// Sparkle's OWN marketplace — the public, Apache-2.0 home of the opinionated tooling Sparkle
/// applies to every agent it runs (<https://github.com/try-sparkle/marketplace>). Unlike the
/// official one, Claude Code does not know this marketplace exists, so it must be BOTH registered
/// by the installer (`marketplace add`) AND declared in each worktree's `extraKnownMarketplaces`
/// — which is exactly what `declared_source()` already arranges by returning `Some` for any
/// marketplace that is not the official one.
pub const SPARKLE_MARKETPLACE: &str = "sparkle";
pub const SPARKLE_MARKETPLACE_REPO: &str = "try-sparkle/marketplace";

/// The official marketplace as a source value, for the rows that live in it.
const OFFICIAL_SOURCE: MarketplaceSource =
    MarketplaceSource { name: OFFICIAL_MARKETPLACE, repo: OFFICIAL_MARKETPLACE_REPO };

/// Sparkle's own marketplace as a source value.
const SPARKLE_SOURCE: MarketplaceSource =
    MarketplaceSource { name: SPARKLE_MARKETPLACE, repo: SPARKLE_MARKETPLACE_REPO };

/// The plugins Sparkle knows how to pre-enable. Both current entries live in the official
/// marketplace (verified against anthropics/claude-plugins-official's marketplace.json on
/// 2026-07-24) — the official listing for `superpowers` pins the exact same commit obra/superpowers
/// is at, and official marketplaces auto-update by default, so sourcing it there costs nothing in
/// freshness.
///
/// Every row carries its `source`. It was tempting to leave the official rows at `None` ("Claude
/// Code pre-registers it"), but that only holds on a machine where Claude Code has already been run
/// interactively; on a fresh one `claude plugin install x@claude-plugins-official` fails with an
/// unknown marketplace, and that failure is only warn-logged, so the plugins would silently never
/// install. With a source present the installer's idempotent `marketplace add` always runs first.
/// The settings-file declaration is a separate question — see `declared_source`.
pub const KNOWN_PLUGINS: &[KnownPlugin] = &[
    KnownPlugin {
        toggle: "superpowers",
        plugin: "superpowers",
        marketplace: OFFICIAL_MARKETPLACE,
        source: Some(OFFICIAL_SOURCE),
        default_on: true,
    },
    KnownPlugin {
        toggle: "frontend_design",
        plugin: "frontend-design",
        marketplace: OFFICIAL_MARKETPLACE,
        source: Some(OFFICIAL_SOURCE),
        default_on: true,
    },
    // Sparkle's own published tooling (github.com/try-sparkle/marketplace, Apache-2.0).
    //
    // sparkle_guardrails ships OFF, and that is deliberate: it is the PUBLIC copy of
    // `guardrailsProtocol()` in buildAgent.ts, which `[tools].guardrails` already appends to every
    // coding agent's system prompt. Turning both on would hand each agent the same discipline
    // twice. Its value is portability — it is the form you can install into plain Claude Code, or
    // keep if you turn the built-in off — so it belongs in the catalog but not in the default set.
    KnownPlugin {
        toggle: "sparkle_guardrails",
        plugin: "sparkle-guardrails",
        marketplace: SPARKLE_MARKETPLACE,
        source: Some(SPARKLE_SOURCE),
        default_on: false,
    },
    KnownPlugin {
        toggle: "sparkle_freshness",
        plugin: "sparkle-freshness",
        marketplace: SPARKLE_MARKETPLACE,
        source: Some(SPARKLE_SOURCE),
        default_on: true,
    },
    // Off by default: mutation-check is a deliberate, targeted act ("prove THIS test can fail"),
    // not a background discipline, so it should be reached for rather than always present.
    KnownPlugin {
        toggle: "sparkle_mutation_check",
        plugin: "sparkle-mutation-check",
        marketplace: SPARKLE_MARKETPLACE,
        source: Some(SPARKLE_SOURCE),
        default_on: false,
    },
];

/// Which marketplace plugins are turned on for every agent Sparkle spawns. Repo-scoped and
/// per-project overridable (like [workflow]/[freshness]): a frontend-only repo may want
/// frontend-design on and a backend one may not, and the choice travels with the repo.
///
/// Each bool default true = the plugin ships on for every new install. Off means Sparkle writes
/// nothing about it into an agent's `.claude/settings.local.json` (and never installs it) — it does
/// NOT disable a plugin the user enabled themselves.
/// KEYED BY TOGGLE NAME, not a struct of named bools. The struct form required editing eight
/// places in lockstep to add one plugin (a `KNOWN_PLUGINS` row, a field, an `is_enabled` arm, a
/// `PartialPlugins` field, an `apply_plugins` arm, the default, the template, and the TS mirror),
/// which is why the catalog could not grow. This mirrors the `[concierge.tools]` shape above:
/// a free-form map with a TOTAL resolution function, so a missing key cannot fall into a hole.
///
/// `#[serde(transparent)]` keeps the wire shape the frontend already reads — a flat
/// `{ "superpowers": true, … }` object — so this is not a breaking change across the Tauri
/// boundary.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct PluginsConfig {
    enabled: std::collections::BTreeMap<String, bool>,
}

impl PluginsConfig {
    /// Every known plugin at the default declared on its own table row.
    pub fn defaults() -> Self {
        Self {
            enabled: KNOWN_PLUGINS
                .iter()
                .map(|p| (p.toggle.to_string(), p.default_on))
                .collect(),
        }
    }

    /// Every known plugin forced to `on`. Derived from the table, so a new `KNOWN_PLUGINS` row is
    /// covered without touching callers — which is the whole point of the keyed shape.
    ///
    /// Test-only: production code builds this layer from [`Self::defaults`] plus the config
    /// overlay, never by forcing every toggle to one value.
    #[cfg(test)]
    pub fn with_all(on: bool) -> Self {
        Self {
            enabled: KNOWN_PLUGINS
                .iter()
                .map(|p| (p.toggle.to_string(), on))
                .collect(),
        }
    }

    /// Is the `[plugins]` toggle named `toggle` on? Unknown names are off (a forward-compatible
    /// key from a newer Sparkle must never resolve to "enabled").
    ///
    /// The `KNOWN_PLUGINS` membership check is load-bearing, not belt-and-braces. Unknown keys are
    /// deliberately KEPT in the map so a config written by a newer Sparkle survives a round-trip
    /// through an older one — but a bare map lookup would then hand back the `true` that file
    /// wrote, turning "we don't know what this is" into "it's on". Resolve only what this build
    /// actually knows how to install.
    pub fn is_enabled(&self, toggle: &str) -> bool {
        if !KNOWN_PLUGINS.iter().any(|p| p.toggle == toggle) {
            return false;
        }
        self.enabled.get(toggle).copied().unwrap_or(false)
    }

    /// Set one toggle. Used by the config overlay; kept private-ish in spirit — callers outside
    /// config go through the dotted-path setter so the write lands in the right layer.
    fn set(&mut self, toggle: &str, on: bool) {
        self.enabled.insert(toggle.to_string(), on);
    }

    /// Keys present in the file that no `KNOWN_PLUGINS` row claims, in sorted order.
    ///
    /// Unlike `[concierge.tools]` — whose authoritative name list lives in TypeScript, so Rust
    /// deliberately does not check it — plugin toggles ARE a closed set right here. That makes a
    /// typo (`frontend-design` for `frontend_design`) something we can tell the user about instead
    /// of leaving as a line that parses, applies nothing, and never explains itself.
    pub fn unknown_keys(&self) -> Vec<&str> {
        self.enabled
            .keys()
            .filter(|k| !KNOWN_PLUGINS.iter().any(|p| p.toggle == k.as_str()))
            .map(String::as_str)
            .collect()
    }

    /// The known plugins currently switched on, in table order.
    pub fn enabled(&self) -> Vec<&'static KnownPlugin> {
        KNOWN_PLUGINS
            .iter()
            .filter(|p| self.is_enabled(p.toggle))
            .collect()
    }
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

/// Machine-wide mirror of the user's Sparkle-improvement consent (`"always"|"case_by_case"|"never"`).
/// Its ONLY reason to exist is a file-based read path: the improvement/orchestrator agents run as
/// headless `claude` processes with no access to the webview's localStorage, where this setting
/// otherwise lives alone (`settingsStore.ts` `sparkleImprovementConsent`). Mirroring it here lets
/// those agents gate an auto-forward on `consent == "always"` by reading the file. Machine-wide
/// (like [roborev]/[tools]): a per-project value is ignored with a warning — a repo doesn't get to
/// decide how the user's own usage is shared.
///
/// `consent` is `Option<String>`, NOT a concrete default, on PURPOSE. Unlike roborev's flag, the
/// webview store is `persist`ed to localStorage, so `None` here must stay distinguishable from a
/// written value: on first launch after upgrade the file has no `[improvement]` section, and if
/// this resolved to a concrete "case_by_case" the hydrate would CLOBBER a user's persisted
/// "always" back to the default. `None` lets the store keep its persisted value (see
/// `hydrateFromConfig`). An unset section also means an orchestrator reading the raw file falls
/// back to its own fail-closed default (anything but "always" ⇒ no auto-forward).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ImprovementConfig {
    /// The mirrored consent mode, or `None` when the user has never set it (no `[improvement]`
    /// section on disk). Stored as a free string; the TS union `SparkleImprovementConsent`
    /// (`"always"|"case_by_case"|"never"`) is the contract, and the reader fail-closes on anything
    /// outside it.
    pub consent: Option<String>,
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
    /// Spoken phrase that ends active dictation (default "Sparkle, pause").
    pub stop_word: String,
    /// When a prompt is submitted, drop from active dictation back to passive wake-word listening
    /// (the mic stays on). Default true = pause listening on submit.
    pub pause_on_submit: bool,
    /// The stable CoreAudio `kAudioDevicePropertyDeviceUID` of the microphone to capture from.
    /// `None` (the default) = choose automatically, preferring real hardware — see
    /// `audio_devices::select_device`.
    ///
    /// A UID, never a name or a numeric AudioDeviceID: the numeric id is reassigned whenever a HAL
    /// plug-in loads or unloads, which is exactly the event this setting exists to survive.
    pub input_device_uid: Option<String>,
    /// ADVANCED, off by default: allow capture to bind a VIRTUAL input device (a HAL plug-in's
    /// loopback/aggregate) when choosing automatically.
    ///
    /// This is a privacy setting, not a convenience one. Several plug-ins publish system OUTPUT as
    /// an input device, so a virtual input can carry anything playing on the machine — a call, a
    /// video, a stream — into the transcript. On 2026-07-29 that put a Twitch stream and third
    /// parties' voices into the composer. "Sparkle listens to your microphone" and "Sparkle can
    /// transcribe anything playing on this machine" are materially different promises and users
    /// assume the first, so this stays opt-in and is surfaced in the UI when on.
    pub allow_virtual_input: bool,
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
    /// Runtime memory sampling + the per-agent RSS watchdog (`memwatch.rs`). Its own section rather
    /// than more `[workers]` keys because it governs a different KIND of decision: `[workers]` is
    /// what the machine is predicted to hold, `[memory]` is what it is observed to hold.
    pub memory: MemoryConfig,
    pub ai: AiConfig,
    pub tools: ToolsConfig,
    /// Claude Code marketplace plugins pre-enabled for every agent (repo-scoped overridable).
    pub plugins: PluginsConfig,
    /// roborev machine-wide state (the one-time consent flag). Kept in its own section so Rust can
    /// gate the first-run modal on it.
    pub roborev: RoborevConfig,
    /// Sparkle-improvement consent, mirrored from the webview store so headless agents can read it
    /// from the file. Machine-wide, like [roborev]; `consent` is `None` until the user sets it.
    pub improvement: ImprovementConfig,
    /// 1Password env-backup state (chosen vault + worktree seeding). Its own section for the same
    /// reason as [roborev]: it is machine-wide state, not a per-repo preference.
    pub onepassword: OnePasswordConfig,
    pub freshness: FreshnessConfig,
    pub worktree_pool: WorktreePoolConfig,
    pub capture: CaptureConfig,
    pub voice: VoiceConfig,
    /// Per-category Sparkle Auto-Approve rules (repo-scoped overridable, like [workflow]/[freshness]).
    pub approvals: ApprovalsConfig,
    /// The concierge's per-tool autonomy policy. Machine-wide (see ConciergeConfig).
    pub concierge: ConciergeConfig,
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
            // `max_concurrent: None` = AUTO, derived from the machine (see `auto_concurrency_bound`).
            // It replaced a hardcoded 20 — a number that fit a ~64 GiB Mac by coincidence and
            // throttled everything larger to a fraction of its capacity, because the RAM clamp could
            // only lower the configured value, never raise it. 3 GiB per agent sits well under V8's
            // ~4 GiB default so the heap cap actually bites, while leaving a real agent room to work.
            workers: WorkersConfig { max_concurrent: None, agent_heap_mb: 3072 },
            memory: MemoryConfig::DEFAULT,
            ai: AiConfig {
                auto_rename: true,
                voice_dictation: true,
                composer: true,
                suggested_actions: true,
                auto_approve: true,
                concierge: true,
            },
            // Ships auto-approve ON for every category except bash (see ApprovalsConfig::default),
            // so a fresh install isn't blocked by permission prompts. bash stays ask-each-time.
            approvals: ApprovalsConfig::default(),
            concierge: ConciergeConfig {
                // EMPTY by design, and it is meant to stay mostly empty: every concierge tool sits
                // on the default derived from its risk class (policy.ts), so the file only ever
                // carries the rules the human actually changed. An empty table is not "no policy" —
                // it is "the derived policy", which is total.
                tools: std::collections::BTreeMap::new(),
                // The OPPOSITE of `tools`: non-empty, because here the shipped defaults ARE the
                // policy. A user with no config file gets exactly the [concierge.checks] block
                // DEFAULT_TEMPLATE describes (asserted by
                // `concierge_checks_template_matches_the_default`).
                checks: ConciergeChecksConfig::defaults(),
            },
            // Opinionated defaults: every tool ships on for a new install — except onepassword,
            // which needs an external account + CLI before it can do anything (see the field doc).
            tools: ToolsConfig {
                analytics: true,
                beads: true,
                github: true,
                guardrails: true,
                // The lone default-OFF tool: nothing about this machine reaches the public
                // leaderboard until the user turns this on AND answers the consent modal.
                roborev: true,
                builder_index: false,
                onepassword: false,
            },
            // Defaults come from the KNOWN_PLUGINS rows themselves, so there is one place to state
            // them. superpowers and frontend-design ship on because the July 2026 Builder Index
            // found them in 11 and 10 of the top 15 token maxers' setups respectively — on-by-default
            // is what a new install would otherwise have to discover by hand.
            plugins: PluginsConfig::defaults(),
            // First-run consent is unresolved until the user answers the one-time modal.
            roborev: RoborevConfig { consent_prompted: false },
            // No consent mirrored until the user sets it — see ImprovementConfig on why this stays
            // None rather than defaulting to "case_by_case" (it must not clobber a persisted choice).
            improvement: ImprovementConfig { consent: None },
            // No vault until the user picks one, and no worktree seeding until they ask for it.
            onepassword: OnePasswordConfig { vault_id: None, seed_worktrees: false },
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
                stop_word: "Sparkle, pause".into(),
                pause_on_submit: true,
                input_device_uid: None,
                allow_virtual_input: false,
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
    /// The concurrency limit the app ENFORCES: `workers.max_concurrent` narrowed by what this
    /// machine's RAM and cores can carry (see `memory_aware_concurrency`). Always ≤
    /// `config.workers.max_concurrent`, always ≥ 1. The frontend's concurrency gate reads this, not
    /// the raw configured value.
    pub effective_max_concurrent: u32,
    /// What the MACHINE alone could carry, ignoring any pinned ceiling. Equal to
    /// `effective_max_concurrent` unless a `[workers].max_concurrent` pin is holding it down.
    /// Reported so the UI can tell "your Mac is full" apart from "you chose this number" — the
    /// remedy for the second is a config line, not different hardware.
    pub machine_max_concurrent: u32,
    /// Which dimension binds `effective_max_concurrent`: `"cpu" | "ram" | "both" | "pinned" |
    /// "unknown"`. Serialized so the human-facing at-capacity refusal can name it instead of
    /// asserting RAM unconditionally (which is wrong on every core-bound machine).
    pub concurrency_bound: Bound,
    /// One sentence naming that dimension with its arithmetic, e.g.
    /// `"CPU-bound: 18 cores × 2 agents per core"`. Composed alongside the number it explains so the
    /// two can never disagree.
    pub concurrency_basis: String,
}

impl EffectiveConfig {
    /// Build an EffectiveConfig, deriving the machine-aware concurrency and appending the clamp
    /// warning when the hardware forces the limit below what the user configured.
    fn derive(config: SparkleConfig, warnings: Vec<String>) -> Self {
        Self::derive_measured(config, warnings, total_memory_bytes(), cpu_core_count())
    }

    /// The measurement-injected core of `derive`. Split out so tests can pin the machine's RAM and
    /// core count instead of reading whatever CI runner they land on: a 7 GiB / 3-core macOS runner
    /// derives only ONE agent, so a pin that a real developer machine would clamp (and label
    /// `Pinned`) instead reads as `Ram` there — the honest answer for that box, but not the wiring
    /// the derive-path tests mean to exercise. Production always calls `derive`, which feeds the
    /// real hardware; only tests reach for a fixed machine.
    fn derive_measured(
        config: SparkleConfig,
        mut warnings: Vec<String>,
        total_ram: Option<u64>,
        cores: Option<u32>,
    ) -> Self {
        let d = memory_aware_concurrency(&config.workers, total_ram, cores);
        let ConcurrencyDerivation {
            effective: effective_max_concurrent,
            machine: machine_max_concurrent,
            bound: concurrency_bound,
            basis: concurrency_basis,
            warning: warn,
        } = d;
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
        Self {
            config,
            warnings,
            effective_max_concurrent,
            machine_max_concurrent,
            concurrency_bound,
            concurrency_basis,
        }
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
struct PartialMemory {
    pressure_gate: Option<bool>,
    agent_rss_warn_mb: Option<u32>,
    agent_rss_kill_mb: Option<u32>,
    agent_rss_auto_kill: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialAi {
    auto_rename: Option<bool>,
    voice_dictation: Option<bool>,
    composer: Option<bool>,
    suggested_actions: Option<bool>,
    auto_approve: Option<bool>,
    concierge: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialApprovals {
    skill: Option<String>,
    bash: Option<String>,
    edit: Option<String>,
    mcp: Option<String>,
    fetch: Option<String>,
    other: Option<String>,
    resume: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialConcierge {
    /// Deliberately `toml::Value`, NOT a typed map (roborev 54240).
    ///
    /// With a typed map, a single hand-edit — `merge_pr = true`, or a nested
    /// `[concierge.tools.x]` table — fails `toml::from_str::<PartialConfig>` for the WHOLE FILE.
    /// That discards the entire global layer and sets `hard_error`, so every unrelated setting in
    /// the file silently reverts to its default. One typo in one concierge rule should not cost
    /// the user their whole configuration.
    ///
    /// The tolerance has to reach the SECTION, not just its values: `tools = false` (reaching for a
    /// switch that does not exist) is exactly as fatal as `merge_pr = true` was, so this is a bare
    /// `Value` and `apply_concierge` checks `as_table()` first. Non-string entries inside it are
    /// dropped and read as "no rule", which is what the TS side already documents and asserts.
    tools: Option<toml::Value>,
    /// A bare `Value` for the reason on `tools` above, one level further out than it looks like it
    /// needs to be: a typed struct here would still make `[concierge]` + `checks = false` fatal to
    /// the whole global layer. `apply_concierge` requires a table before reading it as
    /// [`PartialConciergeChecks`], whose own fields cannot then fail.
    checks: Option<toml::Value>,
}

/// `[concierge.checks]` as read from TOML.
///
/// EVERY value is `toml::Value`, including the three named master switches, for the reason recorded
/// on `PartialConcierge::tools` (roborev 54240): with strong types, one hand-edit — `enabled = "yes"`
/// — fails `toml::from_str::<PartialConfig>` for the WHOLE FILE, which discards the entire global
/// layer and silently reverts every unrelated setting to its default. A wrong-typed value is dropped
/// with a warning in `apply_concierge_checks` instead, so a typo in one lint knob costs exactly that
/// knob. Nothing in this struct can fail to deserialize FROM A TABLE, which is what lets
/// `apply_concierge` treat "not a table" as the only failure it has to report.
///
/// `#[serde(flatten)]` puts every remaining key — the per-check tables — into `checks`. That is what
/// keeps this layer schema-agnostic about check NAMES: an id this build has never heard of parses,
/// merges, and round-trips instead of being rejected or erased.
#[derive(Debug, Default, Deserialize)]
struct PartialConciergeChecks {
    enabled: Option<toml::Value>,
    log: Option<toml::Value>,
    log_matches: Option<toml::Value>,
    #[serde(flatten)]
    checks: std::collections::BTreeMap<String, toml::Value>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialTools {
    analytics: Option<bool>,
    beads: Option<bool>,
    github: Option<bool>,
    guardrails: Option<bool>,
    roborev: Option<bool>,
    builder_index: Option<bool>,
    onepassword: Option<bool>,
}

/// `[plugins]` as read from TOML.
///
/// `toml::Value`, not `bool`, for the same reason `[concierge.tools]` uses it (see the note on
/// `PartialConcierge::tools`): with a strongly-typed map, ONE malformed entry — `superpowers = "yes"`
/// — fails `toml::from_str::<PartialConfig>` for the WHOLE FILE, discarding the entire layer and
/// silently reverting every unrelated setting to its default. A non-bool value is dropped in
/// `apply_plugins` and reads as "no opinion" instead.
#[derive(Debug, Default, Deserialize)]
struct PartialPlugins {
    #[serde(flatten)]
    toggles: std::collections::BTreeMap<String, toml::Value>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialRoborev {
    consent_prompted: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialImprovement {
    consent: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialOnePassword {
    vault_id: Option<String>,
    seed_worktrees: Option<bool>,
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
    input_device_uid: Option<String>,
    allow_virtual_input: Option<bool>,
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
    memory: Option<PartialMemory>,
    ai: Option<PartialAi>,
    tools: Option<PartialTools>,
    plugins: Option<PartialPlugins>,
    roborev: Option<PartialRoborev>,
    improvement: Option<PartialImprovement>,
    onepassword: Option<PartialOnePassword>,
    freshness: Option<PartialFreshness>,
    worktree_pool: Option<PartialWorktreePool>,
    capture: Option<PartialCapture>,
    voice: Option<PartialVoice>,
    approvals: Option<PartialApprovals>,
    concierge: Option<PartialConcierge>,
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
    // ABSENT means auto — and `into` already holds the default (None/auto), so leaving it alone is
    // exactly right. A present value is wrapped, never unwrapped: `Some(n)` is the user pinning a
    // ceiling. There is deliberately no way to write "auto" as a VALUE; deleting the key is how you
    // ask for auto, which keeps one representation of the concept instead of two.
    if let Some(v) = p.max_concurrent {
        into.max_concurrent = Some(v);
    }
    if let Some(v) = p.agent_heap_mb {
        into.agent_heap_mb = v;
    }
}

fn apply_memory(into: &mut MemoryConfig, p: Option<PartialMemory>) {
    let Some(p) = p else { return };
    if let Some(v) = p.pressure_gate {
        into.pressure_gate = v;
    }
    if let Some(v) = p.agent_rss_warn_mb {
        into.agent_rss_warn_mb = v;
    }
    if let Some(v) = p.agent_rss_kill_mb {
        into.agent_rss_kill_mb = v;
    }
    if let Some(v) = p.agent_rss_auto_kill {
        into.agent_rss_auto_kill = v;
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
    // An empty string in the file means "automatic" — the same normalization
    // `DeviceChoice::from_config` applies, so a hand-edited config behaves like the picker's
    // "Automatic" entry rather than trying to bind a device whose UID is "".
    if let Some(v) = p.input_device_uid {
        into.input_device_uid = Some(v).filter(|s| !s.trim().is_empty());
    }
    if let Some(v) = p.allow_virtual_input {
        into.allow_virtual_input = v;
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
    if let Some(v) = p.composer {
        into.composer = v;
    }
    if let Some(v) = p.suggested_actions {
        into.suggested_actions = v;
    }
    if let Some(v) = p.auto_approve {
        into.auto_approve = v;
    }
    if let Some(v) = p.concierge {
        into.concierge = v;
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
    if let Some(v) = p.resume {
        into.resume = Some(v);
    }
}

/// Overlay a partial `[concierge]` section. Per-KEY, like `apply_approvals` and for the same reason:
/// a layer that mentions two tools must not erase the rules the lower layer set for the other forty.
/// Wholesale-replacing the map would make writing one rule by hand a silent reset of every other.
///
/// Returns the user-facing warnings for values that were DROPPED as wrong-typed. They have to be
/// handed back: a rejected value never enters the config, so nothing downstream (`validate`
/// included) can rediscover it, and a line the user deliberately wrote that silently does nothing is
/// the worst of the three outcomes. Same contract as `apply_plugins`.
#[must_use]
fn apply_concierge(into: &mut ConciergeConfig, p: Option<PartialConcierge>) -> Vec<String> {
    let mut warnings = Vec::new();
    let Some(p) = p else { return warnings };
    // Both sections are read as a bare `Value` and required to be a TABLE here, so `checks = false`
    // / `tools = "allow"` — a plausible reach for a switch that does not exist — costs that one line
    // instead of failing the whole-file parse and reverting every unrelated setting. That is roborev
    // 54240's failure one level further out: the tolerance has to reach the section, not just the
    // values inside it.
    if let Some(checks) = p.checks {
        if checks.is_table() {
            match checks.try_into::<PartialConciergeChecks>() {
                Ok(p) => apply_concierge_checks(&mut into.checks, p, &mut warnings),
                // Unreachable today — every field of that struct is an Option<Value> or a Value
                // map, so a table always reads. Reported rather than swallowed if that ever changes.
                Err(e) => warnings.push(format!(
                    "[concierge.checks] could not be read ({e}); the built-in reply checks are \
                     still running"
                )),
            }
        } else {
            warnings.push(format!(
                "[concierge.checks] is a {}, not a section like [concierge.checks], so it has no \
                 effect; the master switch is `enabled` INSIDE that section",
                checks.type_str()
            ));
        }
    }
    if let Some(tools) = p.tools {
        let Some(tools) = tools.as_table() else {
            warnings.push(format!(
                "[concierge.tools] is a {}, not a section like [concierge.tools], so it has no \
                 effect; every tool stays on its derived default",
                tools.type_str()
            ));
            return warnings;
        };
        for (name, decision) in tools.clone() {
            // Keep the RAW string, unnarrowed — the TS policy layer reads an unrecognized value as
            // `ask`, which is stricter than the derived default, and narrowing here would erase the
            // difference between "the user typo'd a rule" and "the user set no rule", handing back
            // exactly the authority they were trying to remove.
            //
            // A non-string (a bool, a number, a nested table) is DROPPED rather than rejected: it
            // reads as no rule for that tool, and every other setting in the file survives.
            match decision.as_str() {
                Some(v) => {
                    into.tools.insert(name, v.to_string());
                }
                None => {
                    tracing::warn!(
                        tool = %name,
                        kind = decision.type_str(),
                        "[concierge.tools] value is not a string; ignoring this rule"
                    );
                }
            }
        }
    }
    warnings
}

/// Overlay a partial `[concierge.checks]` section onto the shipped policy.
///
/// PER-FIELD, per check — not per check, and not wholesale. The shipped defaults ARE the policy, so
/// the one-line edit the whole design rests on (`severity = "off"` under an existing check's header)
/// has to leave that check's `threshold`/`words` alone. Replacing the whole `ConciergeCheck` would
/// turn "downgrade one check" into "silently reset its other knobs to nothing".
///
/// A wrong-typed value is DROPPED with a warning rather than being coerced or fatal: coercing would
/// make `enabled = "false"` read as ON, and being fatal would cost the user their whole config layer
/// over one typo. An UNKNOWN check id is kept verbatim (a newer config must survive an older app),
/// and is never warned about — check ids are authoritative in TypeScript, not here. An unknown FIELD
/// inside a check IS warned about, because that set is authoritative here; see the arm that does it.
fn apply_concierge_checks(
    into: &mut ConciergeChecksConfig,
    p: PartialConciergeChecks,
    warnings: &mut Vec<String>,
) {
    /// Read a master switch, or record why it did nothing.
    fn master(field: &str, v: toml::Value, into: &mut bool, warnings: &mut Vec<String>) {
        match v.as_bool() {
            Some(b) => *into = b,
            None => warnings.push(format!(
                "[concierge.checks].{field} is a {}, not true or false, so it has no effect",
                v.type_str()
            )),
        }
    }
    if let Some(v) = p.enabled {
        master("enabled", v, &mut into.enabled, warnings);
    }
    if let Some(v) = p.log {
        master("log", v, &mut into.log, warnings);
    }
    if let Some(v) = p.log_matches {
        master("log_matches", v, &mut into.log_matches, warnings);
    }

    for (id, value) in p.checks {
        let Some(table) = value.as_table() else {
            warnings.push(format!(
                "[concierge.checks].{id} is a {}, not a table like [concierge.checks.{id}], so it \
                 has no effect",
                value.type_str()
            ));
            continue;
        };
        // `or_default()` on a KNOWN id yields the shipped row, so the fields this table omits keep
        // the values they shipped with; on an unknown one it yields the neutral on+warn default.
        let check = into.checks.entry(id.clone()).or_default();
        for (field, v) in table {
            let ok = match field.as_str() {
                "enabled" => v.as_bool().map(|b| check.enabled = b).is_some(),
                "autofix" => v.as_bool().map(|b| check.autofix = b).is_some(),
                // Kept VERBATIM, unrecognized values included — see `ConciergeCheck::severity`.
                "severity" => v.as_str().map(|s| check.severity = s.to_string()).is_some(),
                "threshold" => v.as_integer().map(|n| check.threshold = Some(n)).is_some(),
                "words" => v.as_str().map(|s| check.words = Some(s.to_string())).is_some(),
                // A field NAME this build doesn't know is reported, unlike an unknown check ID. The
                // asymmetry is the point: the id list is authoritative in TypeScript, so an id we
                // don't recognize is plausibly from the future — but the FIELD set is authoritative
                // right here (`ConciergeCheck` is the struct), so `sevrity`/`enable` is a typo, and a
                // typo on the one-line escape hatch would otherwise parse, apply nothing, and say
                // nothing while a blocking check kept firing. Same treatment `[plugins]` gives an
                // unknown toggle.
                _ => {
                    warnings.push(format!(
                        "[concierge.checks.{id}].{field} is not a check setting (enabled, severity, \
                         autofix, threshold, words), so it has no effect"
                    ));
                    true
                }
            };
            if !ok {
                let expected = match field.as_str() {
                    "threshold" => "a whole number",
                    "severity" | "words" => "text",
                    _ => "true or false",
                };
                warnings.push(format!(
                    "[concierge.checks.{id}].{field} is a {}, not {expected}, so it has no effect",
                    v.type_str()
                ));
            }
        }
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
    if let Some(v) = p.builder_index {
        into.builder_index = v;
    }
    if let Some(v) = p.onepassword {
        into.onepassword = v;
    }
}

/// Overlay a partial `[plugins]` table. Per-key, like [tools] — so a project can flip
/// `frontend_design` off without also re-stating `superpowers`.
///
/// A non-boolean value is DROPPED rather than coerced or fatal: coercing would make
/// `superpowers = "no"` mean enabled, and being fatal would cost the user their whole config layer
/// over one typo. Dropping it leaves the key at whatever the lower layer said.
///
/// An UNKNOWN key is kept verbatim. It costs nothing (`is_enabled` only ever consults keys that
/// `KNOWN_PLUGINS` asks about) and it means a config written by a newer Sparkle survives a
/// round-trip through an older one instead of being silently erased.
/// Returns the keys whose value was not a boolean, so the caller can tell the user.
///
/// Reporting them is not optional bookkeeping: a rejected value never enters the map, so
/// `unknown_keys()` cannot see it afterwards. If this function does not hand it back, nothing can.
#[must_use]
fn apply_plugins(into: &mut PluginsConfig, p: Option<PartialPlugins>) -> Vec<(String, String)> {
    let mut rejected = Vec::new();
    let Some(p) = p else { return rejected };
    for (key, value) in p.toggles {
        match value.as_bool() {
            Some(v) => into.set(&key, v),
            // Logged AND reported. `apply_concierge` warns on the same shape, and dropping a line
            // the user deliberately wrote with no trace is how `superpowers = "false"` reads as
            // "still enabled" forever with nothing anywhere saying the line did nothing.
            None => {
                tracing::warn!(
                    plugin = %key,
                    kind = value.type_str(),
                    "[plugins] value is not a boolean; ignoring this toggle"
                );
                rejected.push((key, value.type_str().to_string()));
            }
        }
    }
    rejected
}

fn apply_roborev(into: &mut RoborevConfig, p: Option<PartialRoborev>) {
    if let Some(PartialRoborev { consent_prompted: Some(v) }) = p {
        into.consent_prompted = v;
    }
}

fn apply_improvement(into: &mut ImprovementConfig, p: Option<PartialImprovement>) {
    if let Some(PartialImprovement { consent: Some(v) }) = p {
        into.consent = Some(v);
    }
}

fn apply_onepassword(into: &mut OnePasswordConfig, p: Option<PartialOnePassword>) {
    let Some(p) = p else { return };
    // An empty/whitespace vault_id is treated as "not chosen" rather than stored verbatim: a blank
    // string would otherwise read as a configured vault everywhere downstream and make every `op`
    // call fail with an opaque error instead of showing the picker.
    if let Some(v) = p.vault_id {
        let v = v.trim();
        into.vault_id = if v.is_empty() { None } else { Some(v.to_string()) };
    }
    if let Some(v) = p.seed_worktrees {
        into.seed_worktrees = v;
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

/// The floor under `[memory]`'s RSS thresholds, in MiB. Measured 2026-07-29: an agent's whole
/// process tree resides at ~1.11 GiB during ordinary work. A threshold at or below that marks every
/// healthy agent as a runaway on the first poll, and a warning that is always on is a warning the
/// user learns to dismiss — which is exactly the failure `sparkle-0bye` describes from the other
/// direction ("nothing watched it").
const MIN_AGENT_RSS_THRESHOLD_MB: u32 = 1536;

/// The `max_concurrent` the app used to ship as a hardcoded default, before the limit became
/// machine-derived. Installs carrying exactly this value are migrated to AUTO (see `validate`):
/// the app wrote it for them, so it is not a choice we would be discarding.
const LEGACY_DEFAULT_MAX_CONCURRENT: u32 = 20;

/// The `stop_word` the app used to ship as its default, before the displayed phrase became
/// "Sparkle, pause". Installs carrying exactly this value are migrated back to the default (see
/// `migrate_global` v2): the template wrote it for them, so it is not a choice we would discard.
///
/// This is the RETIRED DISPLAY STRING, not a retired command — the recogniser still accepts
/// "stop" as an undisplayed alias (see `STOP_VARIANTS` in `voice/wakeWords.ts`), and that alias is
/// deliberately permanent. Removing this line from a config changes what the UI SAYS, never what
/// the microphone answers to. Mirrors `LEGACY_STOP_WORD` in `voice/voiceDefaults.ts`.
const LEGACY_DEFAULT_STOP_WORD: &str = "Sparkle, stop";

/// V8's own default old-space ceiling on a 64-bit machine with plenty of RAM (~4 GiB — the machines
/// in the incident reported 4.09 GiB). Used as the per-agent budget when the user opts OUT of our
/// cap, since that is then exactly how big each agent can get.
const V8_DEFAULT_HEAP_MB: u32 = 4096;

/// RAM held back for the OS, the Tauri app (~0.84 GiB observed), and everything else the user is
/// running. Deliberately generous: over-reserving costs a little parallelism, under-reserving costs
/// the user their machine.
const MEMORY_RESERVE_BYTES: u64 = 6 * 1024 * 1024 * 1024;

/// Measured typical resident set of one AGENT — not one process (roborev 54816). The first
/// measurement here (2026-07-28, 30 concurrent Claude Code sessions, ~520 MiB each / 15.7 GiB
/// total) implicitly assumed one process per agent, which is only true when nothing has fanned out
/// to subagents. A second measurement the next day (2026-07-29, the AGENTS_PER_CORE raise below)
/// found 37 processes across 19 agent WORKTREES — 1.95 processes per agent, peak 5 when an agent
/// runs subagents — for 21.1 GiB total, i.e. **1.11 GiB per agent**. That is the number this
/// constant must divide by: `agent_ram_budget_mb` computes how many AGENTS fit, and a per-process
/// figure under-counts every agent that has fanned out. 1152 MiB is that measurement rounded up
/// with headroom for the tail, matching the ~10% margin the original 520→768 rounding used.
///
/// This exists because `agent_heap_mb` is the WRONG basis for a RAM budget and budgeting on it
/// over-reserved by ~6× at the old constant, ~2.7× at this one. A heap ceiling is a per-process
/// guard against ONE agent running away — it is not an estimate of what an agent resides at, and
/// dividing installed RAM by it prices every agent as though it were the runaway.
const AGENT_TYPICAL_RSS_MB: u32 = 1152;

/// How far the SUM of per-agent heap CEILINGS may exceed usable RAM. Ceilings are reached rarely
/// and not simultaneously, and macOS compresses memory, so some overcommit of ceilings is correct —
/// but not unbounded. The 2026-07-20 jetsam incident sat at roughly 3× (24 agents × V8's ~4 GiB
/// default against a machine that could not hold it), so 2× stays under the observed failure point
/// while still being ~3× more permissive than the measured working set actually needs.
const PEAK_HEAP_OVERCOMMIT: u32 = 2;

/// RAM to budget per agent, in MiB: the larger of what an agent actually resides at and its
/// amortized share of the heap ceiling. ONE divisor rather than two competing derivations, so the
/// user-facing sentence is arithmetic the human can check — `usable ÷ this = the RAM-derived limit`.
///
///   • the steady term (`AGENT_TYPICAL_RSS_MB`, itself capped by the ceiling — an agent cannot
///     reside far above a heap it is not allowed to grow into) sizes the normal case;
///   • the peak term (`ceiling / PEAK_HEAP_OVERCOMMIT`) keeps a large ceiling from being ignored,
///     which is what stops "budget on typical RSS" from re-creating the runaway coalition.
///
/// Taking the max of the two divisors is exactly `min()` of the two agent counts they would each
/// derive (same numerator, larger divisor → smaller quotient), stated once instead of twice.
pub(crate) fn agent_ram_budget_mb(heap_ceiling_mb: u32) -> u32 {
    let steady = AGENT_TYPICAL_RSS_MB.min(heap_ceiling_mb);
    let peak_share = heap_ceiling_mb / PEAK_HEAP_OVERCOMMIT;
    steady.max(peak_share).max(1)
}

/// How many agents fit in `total_ram_bytes` after `reserve_bytes`, at `agent_ram_budget_mb` each.
/// Always at least 1: a machine too small for even one agent must still be able to run one
/// (degraded, possibly swapping) rather than be told it may run zero and deadlock the orchestrator.
fn ram_derived_concurrency(total_ram_bytes: u64, reserve_bytes: u64, heap_ceiling_mb: u32) -> u32 {
    let per_agent = (agent_ram_budget_mb(heap_ceiling_mb) as u64) * 1024 * 1024;
    if per_agent == 0 {
        return 1;
    }
    let usable = total_ram_bytes.saturating_sub(reserve_bytes);
    // u32 saturation is fine: nothing downstream cares about a distinction above 4 billion agents.
    (usable / per_agent).clamp(1, u32::MAX as u64) as u32
}

/// How many agents each CPU core is allowed to carry. Agents are not memory-parked processes: each
/// one runs a real Claude Code session doing git, builds and test suites, so cores bound throughput
/// independently of RAM. This is the one tunable judgement in the derivation — RAM and core count
/// are measured.
///
/// RAISED 2 → 6 on 2026-07-29, deliberately and with a caveat that is NOT to be deleted.
///
/// Why raised: at 2, this was the SOLE binding dimension on every large-RAM Mac and it was binding
/// on a machine that was 90% memory-free with zero swap. Measured on an 18-core / 128 GiB host:
/// 37 live `claude` processes across 19 agent worktrees held 21.1 GiB — 1.11 GiB per AGENT — while
/// `by_cpu` held the ceiling at 36 and `by_ram` allowed 81. Nothing in that load suggested core
/// contention; the 36 came entirely from this multiplier. Agents spend most of their wall-clock
/// blocked on model round-trips, not saturating a core.
///
/// THE CAVEAT, which is real evidence and not a hedge: an earlier note here recorded that a higher
/// value made a big-RAM machine SLOWER, not faster, via context thrashing. That observation was not
/// reproduced or refuted before this change — it was overridden by a human decision. Agents' bursts
/// (cargo builds, full vitest suites, git) genuinely ARE CPU-bound, and 6 × 18 = 108 would let a
/// hundred of them burst at once on 18 cores.
///
/// roborev 54816: an earlier draft of this comment claimed, in the present tense, that runtime
/// pressure-aware admission and an RSS watchdog make that survivable. NEITHER EXISTED then, and this
/// raise shipped AHEAD OF them.
///
/// STATUS (be precise here — the whole point of this note is that it is not aspirational). The two
/// halves of `memwatch.rs` are in DIFFERENT states, and conflating them is how this comment has
/// already been wrong twice, in both directions:
///
///   * **Admission — WIRED.** `services/memoryAdmission.ts` polls `memory_admission` every 5s and
///     `localAgentCapacity()` narrows its ceiling by the result, so a spawn IS now gated on a live
///     memory reading and this constant is no longer the only guard on that path.
///   * **The RSS watchdog — NOT WIRED.** `agent_memory_watchdog` compiles, is tested and is
///     registered, but nothing calls it and nothing acts on a `WatchdogVerdict`. There is no kill
///     path and no warning surface. `agent_rss_auto_kill` therefore does nothing whatever its value.
///
/// So: still do NOT read this as clearance to raise the constant. Admission being connected removes
/// only the *ceiling* half of the risk; a runaway agent — the actual `sparkle-hfhs` failure mode, and
/// the one the 2026-07-20 incident was — is still unwatched, because the watchdog has no caller.
/// Raising this before that lands is the same unguarded arithmetic. Check for a real watchdog
/// consumer first, not just a `memory_admission` one.
///
/// Note this flips which dimension binds on a big-RAM Mac: 18 × 6 = 108 vs `by_ram` 81, so RAM now
/// binds at 81 and `Bound::Ram` is what the human is told. That is intended — RAM is the dimension
/// actually measured per agent.
const AGENTS_PER_CORE: u32 = 6;

/// Logical CPU count, or None when we can't determine it. Memoized (fixed hardware property).
fn cpu_core_count() -> Option<u32> {
    static CORES: OnceLock<Option<u32>> = OnceLock::new();
    *CORES.get_or_init(|| std::thread::available_parallelism().ok().map(|n| n.get() as u32))
}

/// How many agents this machine's cores can carry. Floored at 1 for the same reason
/// `ram_derived_concurrency` is: zero would deadlock the orchestrator rather than degrade it.
fn cpu_derived_concurrency(cores: u32) -> u32 {
    cores.saturating_mul(AGENTS_PER_CORE).max(1)
}

/// Which measured dimension held the automatic limit down. Returned BY the derivation rather than
/// re-inferred from its result: comparing the final value back against each dimension mis-attributes
/// a TIE (both derive the same number), and a tie routed to the RAM branch tells the user to lower
/// `agent_heap_mb` — advice that cannot work, because raising `by_ram` leaves `min()` unchanged when
/// cores bind equally. That is exactly the "useless advice" this attribution exists to prevent.
///
/// Serialized to the frontend on `EffectiveConfig` (`concurrency_bound`) because the attribution
/// existing in Rust was never enough: the at-capacity refusal the concierge shows a human said "the
/// ceiling is derived from installed RAM" unconditionally, which on a core-bound machine is the
/// exact mis-attribution this enum was written to prevent — it just wasn't reaching the human.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Bound {
    Ram,
    Cpu,
    /// Both dimensions derive the same limit — neither remedy alone raises it.
    Both,
    /// Neither dimension binds: the user's `[workers].max_concurrent` pin is below what the machine
    /// could carry, so the ceiling is a CHOICE, not a hardware fact. Telling the human about RAM or
    /// cores here would send them to tune hardware that is not the constraint.
    Pinned,
    /// A RUNTIME measurement bound it, not the static prediction: memory available *right now* is
    /// less than `installed − reserve` assumed (`memwatch::sampled_admission`). Distinct from
    /// [`Bound::Ram`], which is a fact about the machine; this one is a fact about this MOMENT, and
    /// the remedy is to close something, not to buy RAM.
    Available,
    /// The OS (or our own reading of the compressor/swap) says the machine is under memory
    /// PRESSURE, so no further agent is admitted regardless of what the arithmetic allows. The one
    /// bound that says "refused: memory pressure" rather than "at capacity".
    Pressure,
    /// Nothing measurable (unsupported platform / sysctl failure) and no pin either.
    Unknown,
}

/// The limit the MACHINE can carry (ignoring any configured ceiling) and the dimension that bound
/// it: the smaller of what RAM can hold and what the cores can drive. Both dimensions are real and
/// whichever binds first wins — RAM alone would let a 192 GiB / 8-core box run 62 agents that spend
/// their lives waiting for a core, and cores alone would let a 64-core / 16 GiB box swap itself to
/// death.
///
/// A dimension we cannot MEASURE does not constrain: `None` means "no basis to narrow", not "zero".
/// If neither is measurable this returns None and the caller honors the configured value as-is.
fn auto_concurrency_bound(
    w: &WorkersConfig,
    total_ram: Option<u64>,
    cores: Option<u32>,
) -> Option<(u32, Bound)> {
    // Opting OUT of the heap cap must not also opt out of the concurrency clamp (roborev 40088) —
    // coupling them would restore the exact runaway this exists to prevent. With no cap, agents use
    // V8's own default, so that becomes the per-agent budget.
    let budget_mb = if w.agent_heap_mb > 0 { w.agent_heap_mb } else { V8_DEFAULT_HEAP_MB };
    let by_ram = total_ram.map(|t| ram_derived_concurrency(t, MEMORY_RESERVE_BYTES, budget_mb));
    let by_cpu = cores.map(cpu_derived_concurrency);
    match (by_ram, by_cpu) {
        (Some(r), Some(c)) => Some(match r.cmp(&c) {
            std::cmp::Ordering::Less => (r, Bound::Ram),
            std::cmp::Ordering::Greater => (c, Bound::Cpu),
            std::cmp::Ordering::Equal => (r, Bound::Both),
        }),
        (Some(r), None) => Some((r, Bound::Ram)),
        (None, Some(c)) => Some((c, Bound::Cpu)),
        (None, None) => None,
    }
}

/// Everything the app knows about the concurrency ceiling, derived ONCE and carried together so the
/// number the app ENFORCES, the number it REPORTS, and the sentence explaining it cannot drift
/// apart. A cap that lies about itself is worse than a wrong cap: the concierge refused a spawn with
/// "at-capacity: 46 of 32 slots… the ceiling is derived from installed RAM" on a machine that was
/// CPU-bound at 36 and pinned at 32 — three different numbers and the wrong reason, which sent a
/// human chasing memory that was 94% free.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConcurrencyDerivation {
    /// The number the app enforces. Every concurrency gate reads this (via
    /// `EffectiveConfig::effective_max_concurrent`, mirrored into the frontend's `enforcedWorkerCap`).
    pub effective: u32,
    /// What the MACHINE alone could carry, ignoring any pinned ceiling. Equal to `effective` unless
    /// a pin is holding the number down — which is precisely the case the human needs told apart
    /// from a hardware limit, because the remedy is a config line, not a bigger Mac.
    pub machine: u32,
    /// Which dimension binds `effective`.
    pub bound: Bound,
    /// One human sentence naming that dimension WITH its arithmetic, for the at-capacity refusal and
    /// the ⋯-menu hint. Never speculative: it reports the dimension the derivation returned.
    pub basis: String,
    /// The config warning, when the situation is worth surfacing in the warnings list. Not part of
    /// the serialized payload — `EffectiveConfig::derive` folds it into `warnings`.
    #[serde(skip)]
    pub warning: Option<String>,
}

/// The concurrency the app will actually enforce, with its provenance. `total_ram` / `cores` are
/// None when we can't measure them.
///
/// Two cases:
///   - `max_concurrent = None` (AUTO, the default) → the machine-derived value, no warning. There is
///     nothing to warn about: the user asked for "whatever fits" and got exactly that.
///   - `max_concurrent = Some(n)` → `min(n, auto)`. A CEILING in both directions of reasoning: spare
///     capacity never raises it (the user asked for at most N), and a machine that can't hold N
///     lowers it, with a warning naming which dimension bound it.
fn memory_aware_concurrency(
    w: &WorkersConfig,
    total_ram: Option<u64>,
    cores: Option<u32>,
) -> ConcurrencyDerivation {
    let derived = auto_concurrency_bound(w, total_ram, cores);
    let heap_mb = if w.agent_heap_mb > 0 { w.agent_heap_mb } else { V8_DEFAULT_HEAP_MB };
    let budget_mb = agent_ram_budget_mb(heap_mb);
    let gib = |b: u64| b / (1024 * 1024 * 1024);
    // The per-agent RAM figure, stated so a human can check the division AND see where it came from.
    // It is deliberately NOT `agent_heap_mb`: that is a heap ceiling, ~2.7× what an agent resides at
    // (AGENT_TYPICAL_RSS_MB), and quoting it was how "lower agent_heap_mb" became the standing (and
    // useless) advice.
    // `agent_ram_budget_mb` is the max of the two divisors, so a budget ABOVE the steady term means
    // the heap ceiling's amortized share is what won.
    let per_agent = if budget_mb > AGENT_TYPICAL_RSS_MB.min(heap_mb) {
        format!("{budget_mb} MiB per agent (half the {heap_mb} MiB heap ceiling)")
    } else {
        format!("{budget_mb} MiB per agent (measured typical working set)")
    };
    // Telling a user to "lower" a value that is already 0 is impossible advice — 0 maps to the
    // LARGEST budget, so the fix there is to set a positive one (roborev 40311).
    //
    // And it is bounded advice: below `AGENT_TYPICAL_RSS_MB * PEAK_HEAP_OVERCOMMIT` the measured
    // working set becomes the floor, so lowering further buys nothing. Saying "lower it" without
    // that bound is how a human ends up tuning a knob that has stopped moving the number.
    let heap_floor = AGENT_TYPICAL_RSS_MB * PEAK_HEAP_OVERCOMMIT;
    let ram_remedy = if w.agent_heap_mb == 0 {
        format!("Set a positive agent_heap_mb (below {heap_mb}) to allow more.")
    } else if heap_mb > heap_floor {
        format!(
            "Lower agent_heap_mb to allow more, down to about {heap_floor} — below that the \
             measured per-agent working set is the floor and lowering it further changes nothing."
        )
    } else {
        "agent_heap_mb is already at the measured per-agent working set, so lowering it further \
         will not allow more; this machine simply has this much RAM."
            .to_string()
    };
    // The sentence for each MEASURED dimension, phrased to stand alone inside a user-facing refusal.
    let ram_basis = || {
        format!(
            "RAM-bound: {} GiB installed − {} GiB reserved, ÷ {}",
            total_ram.map_or(0, gib),
            gib(MEMORY_RESERVE_BYTES),
            per_agent,
        )
    };
    let cpu_basis =
        || format!("CPU-bound: {} cores × {} agents per core", cores.unwrap_or(0), AGENTS_PER_CORE);

    let Some(configured) = w.max_concurrent else {
        // AUTO. With nothing measurable, fall back to a single agent rather than inventing a number:
        // one always works, and the alternative is guessing on hardware we know nothing about.
        let Some((auto, bound)) = derived else {
            return ConcurrencyDerivation {
                effective: 1,
                machine: 1,
                bound: Bound::Unknown,
                basis: "no measurable CPU or RAM on this machine, so one agent at a time".into(),
                warning: None,
            };
        };
        let basis = match bound {
            Bound::Ram => ram_basis(),
            Bound::Cpu => cpu_basis(),
            _ => format!("{}, and equally {}", cpu_basis(), ram_basis()),
        };
        return ConcurrencyDerivation { effective: auto, machine: auto, bound, basis, warning: None };
    };
    // No measurement means no basis to narrow anything — honor the configured value rather than
    // inventing a limit that could throttle a big machine to nothing.
    let Some((auto, bound)) = derived else {
        return ConcurrencyDerivation {
            effective: configured,
            machine: configured,
            bound: Bound::Pinned,
            basis: format!(
                "pinned to {configured} by [workers].max_concurrent (this machine's CPU and RAM \
                 could not be measured)"
            ),
            warning: None,
        };
    };
    if auto >= configured {
        // The pin BINDS (or exactly matches). Either way the ceiling is a CHOICE, and naming RAM or
        // cores here would point the human at hardware that is not the constraint.
        //
        // Say so as a warning when it is costing real capacity. A ceiling set on older/smaller
        // hardware (or as a workaround, long since fixed) otherwise throttles the machine forever in
        // complete silence: the clamp warning below only ever fires the other way. `>` not `>=`, so
        // a pin that merely matches the machine says nothing.
        let warning = (auto > configured).then(|| {
            format!(
                "[workers].max_concurrent is pinned to {configured}, but this machine can run \
                 {auto}. Remove the line from config.toml to size automatically."
            )
        });
        let basis = if auto > configured {
            format!(
                "pinned to {configured} in config.toml ([workers].max_concurrent) — this machine \
                 could run {auto} ({})",
                match bound {
                    Bound::Ram => ram_basis(),
                    Bound::Cpu => cpu_basis(),
                    _ => format!("{}, and equally {}", cpu_basis(), ram_basis()),
                }
            )
        } else {
            format!("pinned to {configured} in config.toml, exactly what this machine can run")
        };
        return ConcurrencyDerivation {
            effective: configured,
            machine: auto,
            bound: Bound::Pinned,
            basis,
            warning,
        };
    }
    // Name the dimension that ACTUALLY bound it — "lower agent_heap_mb" is useless advice when the
    // limit is the core count, and on a TIE neither remedy alone raises the value, so say that
    // rather than offering one that cannot work.
    let (basis, cause) = match bound {
        Bound::Ram => (
            ram_basis(),
            format!(
                "this machine's RAM can hold (total {} GiB − {} GiB reserved, ÷ {}). {}",
                total_ram.map_or(0, gib),
                gib(MEMORY_RESERVE_BYTES),
                per_agent,
                ram_remedy,
            ),
        ),
        Bound::Cpu => (
            cpu_basis(),
            format!(
                "this machine's {} CPU cores can drive ({} agents per core).",
                cores.unwrap_or(0),
                AGENTS_PER_CORE,
            ),
        ),
        _ => (
            format!("{}, and equally {}", cpu_basis(), ram_basis()),
            format!(
                "this machine can run — its RAM (÷ {}) and its {} CPU cores ({} per core) both cap \
                 it at {}, so raising either one alone changes nothing.",
                per_agent,
                cores.unwrap_or(0),
                AGENTS_PER_CORE,
                auto,
            ),
        ),
    };
    let warning = format!(
        "[workers].max_concurrent ({configured}) is more than {cause} Using {auto}. \
         Remove max_concurrent to size automatically."
    );
    ConcurrencyDerivation {
        effective: auto,
        machine: auto,
        bound,
        basis,
        warning: Some(warning),
    }
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
    // NOTE: the legacy-`max_concurrent = 20` migration deliberately does NOT live here. `validate`
    // runs on every load and on the MERGED config, so doing it here was a standing rewrite rather
    // than a migration (roborev 53140): a user who deliberately chose 20 would have had it discarded
    // on every launch — permanently unsettable, with the ⋯-menu slider showing a value the app
    // ignored — and a per-project 20 would have been erased too. It is now a real one-time,
    // global-file-only migration in `migrate_global`.

    // Only a PINNED value can be out of range; auto (None) is derived and already floored at 1.
    if cfg.workers.max_concurrent == Some(0) {
        warnings.push("[workers].max_concurrent must be >= 1; using 1".to_string());
        cfg.workers.max_concurrent = Some(1);
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
    // A watchdog that fires below what an agent NORMALLY resides at is a watchdog nobody reads.
    // Measured 2026-07-29: 1.11 GiB per agent (whole process tree). A threshold under that would
    // mark every healthy agent as runaway on the first poll, and the first thing a user learns is
    // to ignore the warning. 0 stays meaningful — it disables that tier — so only a positive,
    // too-small value is floored.
    if cfg.memory.agent_rss_warn_mb > 0 && cfg.memory.agent_rss_warn_mb < MIN_AGENT_RSS_THRESHOLD_MB
    {
        warnings.push(format!(
            "[memory].agent_rss_warn_mb ({}) is below the measured normal per-agent working set; \
             using {}",
            cfg.memory.agent_rss_warn_mb, MIN_AGENT_RSS_THRESHOLD_MB
        ));
        cfg.memory.agent_rss_warn_mb = MIN_AGENT_RSS_THRESHOLD_MB;
    }
    if cfg.memory.agent_rss_kill_mb > 0 && cfg.memory.agent_rss_kill_mb < MIN_AGENT_RSS_THRESHOLD_MB
    {
        warnings.push(format!(
            "[memory].agent_rss_kill_mb ({}) is below the measured normal per-agent working set; \
             using {}",
            cfg.memory.agent_rss_kill_mb, MIN_AGENT_RSS_THRESHOLD_MB
        ));
        cfg.memory.agent_rss_kill_mb = MIN_AGENT_RSS_THRESHOLD_MB;
    }
    // Arming auto-kill with the kill tier DISABLED is a config that reads as protection and
    // provides none. Say so rather than silently doing nothing.
    if cfg.memory.agent_rss_auto_kill && cfg.memory.agent_rss_kill_mb == 0 {
        warnings.push(
            "[memory].agent_rss_auto_kill is on but agent_rss_kill_mb is 0 (disabled), so nothing \
             will ever be killed; set a threshold or turn auto-kill off"
                .to_string(),
        );
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
    // A [concierge.tools] value that isn't allow/ask/deny is surfaced but NOT dropped. The frontend
    // policy layer reads an unrecognized rule as "ask" — deliberately stricter than the derived
    // default — so deleting it here would silently restore the permissive default on exactly the
    // rule the user was trying to tighten. Names are not checked: the authoritative tool list lives
    // in the TypeScript domain modules (see ConciergeConfig), and a second copy here would drift.
    for (tool, decision) in &cfg.concierge.tools {
        if !CONCIERGE_TOOL_DECISIONS.contains(&decision.as_str()) {
            warnings.push(format!(
                "[concierge.tools].{tool} is \"{decision}\", which is not allow, ask, or deny; \
                 Sparkle will ask you before that tool runs until it is fixed"
            ));
        }
    }
    // A `[concierge.checks.<id>].severity` that isn't block/warn/off is surfaced but NOT rewritten,
    // and it resolves to "warn" (see `ConciergeCheck::effective_severity`). NEVER to "off": the user
    // was editing that line to change how strict a check is, and failing open on it would hand back
    // exactly the leniency they were trying to remove. Check IDS are not validated — the
    // authoritative list lives in the TypeScript linter module (see ConciergeChecksConfig), and an
    // unknown id is inert here anyway.
    for (id, check) in &cfg.concierge.checks.checks {
        // Asked through `effective_severity` rather than by re-testing the list, so the warning and
        // the behavior can never disagree about what counts as unrecognized.
        if check.effective_severity() != check.severity {
            warnings.push(format!(
                "[concierge.checks.{id}].severity is \"{}\", which is not block, warn, or off; that \
                 check will {} until it is fixed",
                check.severity,
                check.effective_severity()
            ));
        }
        // A non-positive threshold is meaningless for both shipped uses (contiguous characters
        // shared with a tool argument / with the previous reply) and matches trivially, so on a
        // `block` check it would re-prompt EVERY reply. Warned, not clamped: the number is the
        // user's, the linter owns what to do with it, and clamping 0 to 1 would not restore the
        // behavior they wanted anyway — only saying so does.
        if let Some(n) = check.threshold {
            if n <= 0 {
                warnings.push(format!(
                    "[concierge.checks.{id}].threshold is {n}, which every reply matches; that \
                     check will fire on everything until it is a positive number"
                ));
            }
        }
    }
    // A `[plugins]` key no row claims is almost always a typo for one that exists, and it is
    // otherwise indistinguishable from a working line: it parses, it round-trips, and it does
    // nothing. The VALUE is kept (a config from a newer Sparkle must survive an older one) — this
    // only says we didn't act on it.
    for key in cfg.plugins.unknown_keys() {
        warnings.push(format!(
            "[plugins].{key} is not a plugin Sparkle knows about, so it has no effect; check the \
             spelling against the [plugins] block in your config file"
        ));
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
    // `[plugins]` lines whose value was not a boolean. Collected from BOTH layers, because a
    // rejected value never enters the config and so cannot be rediscovered from `cfg` afterwards.
    let mut rejected_plugins: Vec<(String, String)> = Vec::new();

    if let Some(text) = global {
        match parse_layer(text) {
            Ok(p) => {
                apply_workflow(&mut cfg.workflow, p.workflow);
                apply_workers(&mut cfg.workers, p.workers);
                apply_memory(&mut cfg.memory, p.memory);
                apply_ai(&mut cfg.ai, p.ai);
                apply_tools(&mut cfg.tools, p.tools);
                rejected_plugins.extend(apply_plugins(&mut cfg.plugins, p.plugins));
                apply_roborev(&mut cfg.roborev, p.roborev);
                apply_improvement(&mut cfg.improvement, p.improvement);
                apply_onepassword(&mut cfg.onepassword, p.onepassword);
                apply_freshness(&mut cfg.freshness, p.freshness);
                apply_worktree_pool(&mut cfg.worktree_pool, p.worktree_pool);
                apply_capture(&mut cfg.capture, p.capture);
                apply_voice(&mut cfg.voice, p.voice);
                apply_approvals(&mut cfg.approvals, p.approvals);
                // Extended immediately rather than collected like `rejected_plugins`: `[concierge]`
                // is global-only, so there is no second layer whose warnings could interleave.
                warnings.extend(apply_concierge(&mut cfg.concierge, p.concierge));
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
                if p.memory.is_some() {
                    // Same rule and same reason as [workers]: memory is a property of the MACHINE,
                    // and one repo must not be able to arm auto-kill (or disarm the gate) for every
                    // other project sharing the same RAM.
                    warnings.push(
                        "[memory] in a per-project .sparkle/config.toml is ignored — it is a \
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
                if p.improvement.is_some() {
                    warnings.push(
                        "[improvement] in a per-project .sparkle/config.toml is ignored — your \
                         improvement-sharing consent is a machine-wide preference, not something a \
                         repo gets to set; change it in the app or the global config.toml"
                            .to_string(),
                    );
                }
                if p.onepassword.is_some() {
                    warnings.push(
                        "[onepassword] in a per-project .sparkle/config.toml is ignored — the \
                         vault belongs to your 1Password account, not to one repo; set it in the \
                         global config.toml"
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
                // A SECURITY boundary, not just tidiness. [concierge.tools] grants the concierge
                // standing authority over the whole app — quit_app, remove_project, discard_agent —
                // so a repo could otherwise hand itself that authority over the user's machine
                // merely by being cloned with a rule in its checked-in config.
                //
                // [concierge.checks] inherits the boundary for a STRONGER reason: those are the
                // deterministic checks run over every concierge reply, so a repo that could edit
                // them could disable the linter that governs what the human is told about that very
                // repo. One `if` covers both because both live under the same `[concierge]` table.
                //
                // The remedy names the GLOBAL FILE, not a pane. "⋯ Settings → Concierge tools"
                // lists tools with their risk and has no check rows at all, so pointing a
                // [concierge.checks] override there sends the user somewhere the setting is absent —
                // a remedy string is an instruction they will follow, so it gets scoped to the half
                // it actually covers.
                if p.concierge.is_some() {
                    warnings.push(
                        "[concierge] in a per-project .sparkle/config.toml is ignored — how \
                         autonomous the concierge is over YOUR machine, and which checks run over \
                         its replies, are not something a repo gets to set; set them in the global \
                         config.toml (the tools half is also editable in ⋯ Settings → \"Concierge \
                         tools\")"
                            .to_string(),
                    );
                }
                // Per-project layer: [workflow], [freshness], [approvals], [plugins], and the
                // [done]/[delivered] stage definitions are repo-scoped and may override. [approvals]
                // is honored here so "this project" auto-approve rules actually take effect (per
                // category, project beats global). [plugins] is repo-scoped because which agent
                // plugins a codebase wants is a property of the codebase (a frontend repo wants
                // frontend-design; a firmware one may not), and it travels with the repo for the
                // team. [ai].auto_approve stays global-only (it's the machine-wide master toggle,
                // ignored per-project like the rest of [ai] above).
                apply_workflow(&mut cfg.workflow, p.workflow);
                rejected_plugins.extend(apply_plugins(&mut cfg.plugins, p.plugins));
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


    // Said here rather than in validate(), which never sees the rejected list. A line like
    // `superpowers = "false"` parses cleanly and does nothing; without this it is invisible.
    for (key, kind) in &rejected_plugins {
        warnings.push(format!(
            "[plugins].{key} is a {kind}, not true or false, so it has no effect"
        ));
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
            // Rendered, not passed raw: `tracing` records a `None` as UNSET, so the field would
            // simply vanish on the AUTO path — which is now the majority case — leaving no way to
            // tell "auto" from "we forgot to log it".
            configured_max_concurrent = %guard
                .config
                .workers
                .max_concurrent
                .map_or_else(|| "auto".to_string(), |n| n.to_string()),
            agent_heap_mb = guard.config.workers.agent_heap_mb,
            total_ram_bytes = ?total_memory_bytes(),
            reserve_bytes = MEMORY_RESERVE_BYTES,
            // Cores bind as often as RAM does, so the log has to carry both inputs for the
            // "why is Sparkle only running N agents?" question to be answerable from it.
            cpu_cores = ?cpu_core_count(),
            agents_per_core = AGENTS_PER_CORE,
            agent_ram_budget_mb = agent_ram_budget_mb(if guard.config.workers.agent_heap_mb > 0 {
                guard.config.workers.agent_heap_mb
            } else {
                V8_DEFAULT_HEAP_MB
            }),
            effective_max_concurrent = guard.effective_max_concurrent,
            // The two fields that make the log ANSWER the question rather than just restate the
            // number: which dimension bound it, and what the machine could have done without a pin.
            machine_max_concurrent = guard.machine_max_concurrent,
            concurrency_bound = ?guard.concurrency_bound,
            concurrency_basis = %guard.concurrency_basis,
            "resolved machine-aware worker concurrency"
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
#               machine-wide preferences ([workers], [memory], [ai]) plus default rules.
#   • Project — a `.sparkle/config.toml` checked into a repo. Overrides ONLY the repo-scoped
#               rules ([workflow], [freshness], [approvals], [plugins]) for that one project, and
#               travels with the repo so a team shares them. [workers]/[memory]/[ai]/[tools] there
#               are ignored (they're per-machine).
#
# PRECEDENCE: built-in defaults  →  this global file  →  a project's .sparkle/config.toml.
#
# SAFETY: a missing file just uses the defaults below. A typo that makes the file invalid is
# rejected with a message (in the in-app editor) and your last good settings keep running —
# the app never fails to start over a bad edit. Edits take effect live (no restart needed).
# ======================================================================================

# --- Bookkeeping (written by Sparkle; you don't need to touch this) --------------------
[meta]
# Which one-time config migrations have already been applied to this file. Sparkle uses it to
# know it has already upgraded you, so it never re-applies a migration and never overrides a
# value you set yourself afterwards. Lowering or deleting this can re-run past migrations.
config_version = 2

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
# How many agents/worktrees run in parallel.
#
# LEFT OUT ON PURPOSE — with no value here, Sparkle sizes itself to YOUR machine, which is almost
# always what you want. It takes the smaller of two real limits:
#   by RAM   (installed_RAM - 6 GiB reserved for the OS and Sparkle) / per-agent RAM budget
#   by CPU   logical_cores x 6      (agents run builds and test suites; cores bound throughput too)
# The per-agent RAM budget is NOT agent_heap_mb. That is a heap CEILING — a guard against one
# runaway agent — and agents actually reside at ~1.1 GiB (accounting for the subagent processes one
# agent can fan out to). Budgeting on the ceiling over-reserved by ~2.7x at the default heap size.
# The budget is the larger of the measured working set (1152 MiB) and half the heap ceiling, which
# keeps a big ceiling from being ignored without pricing every agent as the runaway.
# So a 16 GB laptop gets ~6, while a 128 GB machine is usually held by its RAM (e.g. 128 GiB / 1.5
# GiB ~= 81), not its cores. Whichever of the two limits is smaller wins, and the resolved value —
# with both inputs AND which dimension bound it — is logged at startup and shown in the app.
#
# This derivation is a PREDICTION made once from installed RAM and cores. What it cannot see —
# memory actually free right now, the compressor, a runaway agent — is what the [memory] section
# below is being built for. NOTE that section is not yet wired to anything (see its own comment),
# so today this prediction is the only limit actually in force.
#
# Uncomment to pin your own CEILING. It only ever lowers the automatic value — setting 40 on a 16 GB
# Mac still gets you ~6, because the point of the clamp is to keep the kernel from killing your
# machine. A pin is reported AS a pin (the app says "pinned to N in config.toml", not "your RAM is
# full"), so it never masquerades as a hardware limit. To go back to automatic, delete the line
# rather than guessing a number.
# max_concurrent = 8
# Memory ceiling per agent, in MiB, applied as NODE_OPTIONS=--max-old-space-size. Agents are
# Node processes, and Node's OWN default ceiling is ~4 GiB — high enough that a handful of
# runaway agents can exhaust a Mac's RAM and get system daemons killed by the kernel. This caps
# each agent well below that. Raise it if agents hit out-of-memory errors on huge repos. NOTE this
# is a ceiling, not a reservation: lowering it only raises max_concurrent once it drops below
# ~1.5 GiB, and it does nothing at all on a machine whose CORES are the binding limit. Set 0 to opt
# out entirely (agents then use Node's ~4 GiB default — not recommended; the RAM-based
# max_concurrent clamp above stays in force either way, and simply budgets from 4 GiB instead). If
# you set your own NODE_OPTIONS, yours is preserved and merged with this; an explicit
# --max-old-space-size of your own always wins.
agent_heap_mb = 3072

# --- Watching memory for real, instead of predicting it (per-machine) ------------------
[memory]
# PARTLY ACTIVE — read the per-key notes, because the two halves of this section differ:
#   pressure_gate    ACTIVE. A live reading really does narrow how many agents are admitted.
#   agent_rss_*      NOT ACTIVE YET. The thresholds are parsed and validated, but nothing watches
#                    agent memory against them, so no agent is warned about, offered for kill, or
#                    killed. Setting them today records your preference for when that lands.
#
# [workers] above is a PREDICTION: it reads your installed RAM once at startup and divides. It
# cannot see that Chrome and Xcode are resident, that the compressor is thrashing, or that one
# agent has run away. This section is the part that actually looks.
#
# ACTIVE. true = a live memory reading may LOWER how many agents Sparkle will admit. It can never
# raise the number above what [workers] already allows — sampling only ever refuses. When it
# refuses, the app says "refused: memory pressure" (or names the available memory) rather than a
# bare "at capacity", so you can tell a full machine apart from a ceiling you set. Set false to go
# back to the prediction alone.
#
# What "squeezed" means, so a refusal is never a surprise: below 20% of RAM available is a warning
# (the ceiling is narrowed to what measurably fits), below 8% is critical (no further agent is
# admitted until one finishes). Swap only counts against you when free memory is ALSO under 35% —
# macOS keeps reporting swap it used hours ago, and treating that alone as pressure once froze
# spawns on machines with 95 GiB free.
pressure_gate = true
# NOT ACTIVE YET (nothing watches agent memory against these three keys — see the header above).
# Per-AGENT memory at which Sparkle warns you, in MiB. "Per agent" means the WHOLE process tree
# an agent runs, not one process: a measured agent is ~2 processes (5 when it fans out subagents)
# totalling ~1.1 GiB, so watching a single process undercounts by about half.
# 4096 is ~3.6x the normal working set — high enough that a big build doesn't cry wolf.
# Set 0 to disable this tier; the kill tier below stays independent of it.
agent_rss_warn_mb = 4096
# NOT ACTIVE YET. Per-agent memory at which Sparkle OFFERS to kill the agent, in MiB. Set 0 to
# disable this tier (the warn tier above keeps its own threshold either way).
agent_rss_kill_mb = 8192
# NOT ACTIVE YET — there is no kill path, so this does nothing whichever value you set.
# false (default) = you are warned and offered the kill; nothing is killed behind your back.
# true = kill automatically at agent_rss_kill_mb. Opt in only if you would rather lose an agent's
# in-progress work than risk the machine — a killed agent's work is not recoverable.
agent_rss_auto_kill = false

# --- AI features (per-machine; each degrades to a non-AI baseline when off) ------------
[ai]
auto_rename     = true   # auto-name worker agents from the work they're doing
voice_dictation = true   # use the cloud (Deepgram) STT for dictation; off = on-device model
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
# DEFAULTS (so you're never blocked out of the box): EVERY category ships "always", bash included.
# Note that auto-approving commands also auto-approves DESTRUCTIVE ones (rm -rf, …) — the trade
# Sparkle accepts so agents run unattended in throwaway worktrees. Opt back out per category below.
# Edit here or via ⋯ Settings → "Auto-approve". Global rules apply to every project; a project's
# .sparkle/config.toml [approvals] overrides per category (project wins).
# Categories: skill (skills) · bash (commands) · edit (file edits) · mcp (tool calls) ·
# fetch (web requests) · other (other prompts).
# The `resume` key is a SIBLING with its own value domain (not "always"/"never"): how to answer
# Claude Code's session-resume prompt. "ask" (default) surfaces it; "summary" auto-picks "Resume
# from summary"; "full" auto-picks "Resume full session". Only fires while [ai].auto_approve is on.
# [approvals]
# bash   = "never"     # opt bash back out — go back to confirming every command yourself
# fetch  = "never"     # or turn any other category back to ask-each-time
# resume = "summary"   # auto-resume from summary on every restart (or "full", or "ask")

# --- Concierge autonomy, PER TOOL (per-machine; ignored in a project file) ---------------
# How much the concierge may do on its own, tool by tool. Three values:
#   "allow" = it just does it, silently.
#   "ask"   = it asks you first, every time.
#   "deny"  = it refuses outright (not "asks and expects a no" — there is no prompt to answer).
#
# There is no single autonomy dial on purpose: one number would have to be set to the strictness
# of the most dangerous tool it governs, so "read my terminals freely" and "never merge a PR
# unasked" would end up sharing a setting. You tune each tool instead.
#
# EVERY KEY IS OPTIONAL, and leaving this section out entirely is the normal case. A tool with no
# line here uses a default DERIVED from how risky it is: read-only and local/reversible work is
# allowed silently, and anything irreversible, outward-facing (a push, a PR), metered, disruptive,
# or that touches your main branch asks first. Nothing defaults to "deny" — turning a tool off
# completely is always your explicit choice, never something Sparkle infers.
#
# Edit here or in ⋯ Settings → "Concierge tools", which lists every tool with its risk and its
# default. Ignored in a project file: how autonomous the concierge is over YOUR machine is not
# something a cloned repo gets to decide.
# [concierge.tools]
# read_agent_terminal = "allow"   # already the default (read-only) — shown for shape
# merge_pr            = "deny"    # never merge a PR, even if you ask it to in chat
# push_agent_branch   = "allow"   # let it push branches without stopping to ask
# discard_agent       = "deny"    # never let it destroy unmerged work

# --- Concierge reply checks (per-machine; ignored in a project file) ---------------------
# The deterministic linter that runs on every concierge reply BEFORE you see it.
# These are DATA for a linter; judgment rules live in concierge-guidelines.md.
# Set enabled = false to switch off a check that is misfiring. Global only:
# a project's .sparkle/config.toml cannot change these.
#
# UNLIKE [concierge.tools] above, this section ships LIVE rather than commented out: an empty
# [concierge.tools] means "every tool on its derived default", which is a complete policy, whereas
# an empty check list would mean no linting at all. Here the values below ARE the policy.
#
# Each check takes:
#   enabled   = true|false     run it at all
#   severity  = "block" | "warn" | "off"
#                              warn  = the violation is counted and appended to
#                                      concierge-lint.jsonl; the reply itself renders UNCHANGED.
#                              block = NOT YET IMPLEMENTED — behaves exactly like "warn" today.
#                                      It is designed to re-prompt the concierge once for a
#                                      corrected reply, and nothing does that yet, so writing it
#                                      buys you nothing over "warn". No shipped check uses it.
#                              off   = this check is skipped (the row and your comment stay).
# There is no badge and no other on-screen marker yet either: violations reach the JSONL and the
# session counters, not the thread. Said plainly here because a legend that describes behaviour the
# build does not have is the same broken promise as a check with no implementation.
#   autofix   = true|false     rewrite into the compliant form instead of just reporting — only
#                              where that form is mechanically derivable and cannot change meaning.
# Plus, where a check has one: threshold (a whole number) or words (comma-separated text).
# An unrecognized severity WARNS and behaves as "warn" — never as "off", because a typo in a line
# you wrote to tighten a check must not switch it off.
[concierge.checks]
enabled     = true      # master switch — false disables the whole linter
log         = true      # append violations to concierge-lint.jsonl
log_matches = false     # NOT YET IMPLEMENTED — nothing computes a hash, so this has no effect

# Offered to act ("want me to…", "should I…") while taking no action that turn.
# A genuine question about an IRREVERSIBLE or spend-bearing action (publish a release, delete a
# branch, remove a project, spend money) is exempt — that exemption is keyed off which tool the
# action belongs to, not off how the sentence is phrased. Merging is NOT exempt.
# DESIGNED to block and re-prompt once, but shipped "warn": nothing re-prompts yet, and
# "block" would promise you a passive reply cannot reach you. It can. Raise this in the
# same change that implements the re-prompt.
[concierge.checks.ask-without-action]
enabled   = true
severity  = "warn"
autofix   = false

# --- Designed but NOT YET IMPLEMENTED — shipped "off" -----------------------------------
# The seven checks below have a policy but no implementation in the linter. They are "off"
# because a severity of "block" here would promise you something the app does not do: it
# would read as "a relayed paste cannot reach me", and it can. The rows are kept rather than
# deleted so the intended policy survives — and so a later implementation does not land
# silently switched on for everyone. Turning one on without writing the check fails a test.
# Intended: relay-paste / unresolved-agent-pill / actions-first / unreported-refusal = block;
# bare-agent-name / bare-pr-number = warn + autofix; fat-pill-label = warn.
[concierge.checks.relay-paste]
enabled   = true
severity  = "off"       # "block" | "warn" | "off"
autofix   = false
# Contiguous verbatim chars shared with a tool argument before it counts.
threshold = 240

[concierge.checks.bare-agent-name]
enabled   = true
severity  = "off"
autofix   = true        # ONLY on a unique roster match; ambiguous never autofixes
[concierge.checks.bare-pr-number]
enabled   = true
severity  = "off"
autofix   = true        # only when pr_owner resolves an unambiguous owner
[concierge.checks.unresolved-agent-pill]
enabled   = true
severity  = "off"       # intended "block": a wrong id opens the WRONG agent
autofix   = false
[concierge.checks.fat-pill-label]
enabled   = true
severity  = "off"
autofix   = true
[concierge.checks.actions-first]
enabled   = true
severity  = "off"
autofix   = false
[concierge.checks.unreported-refusal]
enabled   = true
severity  = "off"
autofix   = false

# --- Implemented and live ---------------------------------------------------------------
[concierge.checks.hedge-words]
enabled   = true
severity  = "warn"
autofix   = false
# Hand-editable, comma-separated. The rule names two; add your own.
words     = "should, deserves to"
[concierge.checks.restated-state]
enabled   = true
severity  = "warn"
threshold = 200
[concierge.checks.naked-file-ref]
enabled   = true
severity  = "warn"

# --- Opinionated tools (per-machine; ignored in a project file) -------------------------
# The non-AI tools Sparkle leans on, surfaced in ⋯ Settings → "Tools". Each defaults on for a
# new install; setting one false means that tool is used NOWHERE in Sparkle. (Deepgram voice is an
# AI feature — toggle it under [ai] as voice_dictation.)
[tools]
analytics  = true   # anonymous usage + masked session replay (PostHog); off sends nothing
beads      = true   # the in-repo work graph behind the Plan board; off hides it + skips `bd`
github     = true   # import a project from your GitHub repositories; off hides that path
guardrails = true   # opinionated quality workflow (test-first, run tests+typecheck before commit,
                    # never call a red build "done") appended to every coding agent; off omits it
roborev    = true   # per-commit AI code review of your BUILD-agent commits (uses your claude login)
# One of the two default-OFF tools, and the only one that publishes anything about you. On, Sparkle
# posts your DAILY TOKEN TOTALS (per day, per model — never file paths, prompts, code, or keys) to the
# public tokenmaxxing leaderboard. Turning it on in ⋯ Settings → "Tools" also asks for your
# tokenmaxxing username + API key and a one-time consent confirmation; nothing is sent until all
# three are in place, so flipping this to true by hand alone does NOT start reporting.
builder_index = false
onepassword = false # back your .env* files up to a 1Password vault. Also ships OFF:
                    # it needs a 1Password account, the `op` CLI, and a chosen vault, so you opt in
                    # from ⋯ Settings → "Tools" once those exist.

# --- 1Password env backup (per-machine; ignored in a project file) ----------------------
# Where Sparkle backs your .env* files up to, and whether it restores them into fresh agent
# worktrees. .env/.env.* are gitignored, so a git worktree NEVER carries one — seed_worktrees is
# what stops every new worker agent from starting without its project's secrets.
# Requires the 1Password CLI (`brew install --cask 1password-cli`) plus 1Password → Settings →
# Developer → "Integrate with 1Password CLI", which is what lets `op` authenticate via Touch ID
# through the desktop app. Sparkle never sees or stores a 1Password credential.
# Toggle the tool itself under [tools] (onepassword), not here.
[onepassword]
# vault_id = ""        # the vault chosen in ⋯ Settings; unset means "no vault picked yet"
seed_worktrees = false # restore backed-up env files into each newly created agent worktree

# --- Claude Code plugins pre-enabled for every agent (repo-scoped; overridable per project) --
# Sparkle turns these Claude Code marketplace plugins ON for every agent it spawns: it installs
# them once (shared, via `claude plugin install`) and writes the marketplace + enabledPlugins
# entries into each agent worktree's .claude/settings.local.json. Setting one false means Sparkle
# writes nothing about it and never installs it — it does NOT turn off a plugin you enabled
# yourself. Toggle these here or in ⋯ Settings → "Tools".
#
# The first two come from Anthropic's official marketplace. The sparkle_* ones come from Sparkle's
# own public marketplace (github.com/try-sparkle/marketplace, Apache-2.0) — the same opinions
# Sparkle applies internally, published so you can read, fork, or use them without Sparkle.
#
# TRUST: a default-on plugin means Sparkle fetches that content and enables it in every agent
# worktree. Two limits worth knowing, both stated as what is actually true rather than as
# reassurance:
#   • Content from SPARKLE'S marketplace is pinned; content from Anthropic's is not pinned by us.
#     Sparkle's marketplace names each plugin by an exact ref + commit sha, enforced by that repo's
#     CI, so editing a skill or hook file alone does not reach you. Anthropic's official marketplace
#     (superpowers, frontend_design) is registered the same way any marketplace is — by repo name —
#     and what it serves is Anthropic's to decide; Sparkle adds no pin of its own there.
#     Neither LISTING is pinned either way: Sparkle registers a marketplace by repo name, so a
#     change to the listing itself (a new row, or a row re-pointed at a different sha) is picked up
#     on the next fetch.
#   • A row set false here stops Sparkle for THIS config layer. [plugins] is repo-overridable, so a
#     .sparkle/config.toml checked into a project you clone can turn a row back on for that project
#     — the same way it can for [workflow]. If that matters to you, check a cloned repo's
#     .sparkle/config.toml. Turning a row off also never disables a plugin you installed yourself.
[plugins]
superpowers            = true    # the most-used agent methodology plugin: plan → TDD → review
frontend_design        = true    # Anthropic's official UI-quality skill
sparkle_guardrails     = false   # public copy of the built-in guardrails; on only if you want it as a skill
sparkle_freshness      = true    # warn when your branch is far behind the default branch
sparkle_mutation_check = false   # /mutation-check — prove a given test can actually fail

# --- roborev first-run consent (per-machine; ignored in a project file) -----------------
# roborev reviews your BUILD-agent commits locally. The first time it's about to turn on, Sparkle
# asks once — this flag records that the "review your commits?" prompt has been resolved (Enable or
# Not-now) so you're never asked again. Toggle the tool itself under [tools] (roborev), not here.
[roborev]
consent_prompted = false   # set true once the one-time "review your commits?" prompt is resolved

# --- Sparkle-improvement consent (per-machine; ignored in a project file) ---------------
# Mirrors the "help improve Sparkle" choice from the in-app banner so headless agents (which can't
# read the app's webview storage) can honor it from this file. "always" lets Sparkle auto-submit an
# improvement PR from your usage; "case_by_case" drafts one for you to approve; "never" is off.
# Left UNSET by default: an absent [improvement] means "follow the app's default (case_by_case)" and
# is read fail-closed (anything but "always" ⇒ no auto-submit). Change it from the in-app banner, not
# here — the app writes this key when you pick a mode.
# [improvement]
# consent = "case_by_case"   # "always" | "case_by_case" | "never"

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
stop_word = "Sparkle, pause"
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

/// Schema revision of the on-disk global config. Bump when adding a one-time migration below.
const CONFIG_MIGRATION_VERSION: i64 = 2;

/// Apply one-time migrations to the global config FILE, recording the revision reached in
/// `[meta].config_version`.
///
/// One-time is the whole point (roborev 53140). Migrating inside `validate` — which runs on every
/// load, against the merged config — is not a migration but a standing rewrite: it would discard a
/// deliberately-chosen value on every launch, making that value permanently unsettable and leaving
/// the ⋯-menu slider displaying a number the app ignores. Recording the revision on disk means each
/// migration fires at most once per install, so anything the user sets AFTERWARDS is theirs to keep.
///
/// Scoped to the GLOBAL file: the rationale ("the app wrote this value, the user never chose it")
/// applies only to the file `set_value` rewrites whole. A per-project override is always deliberate.
///
/// Best-effort by design — a failure here must never block startup, so the caller logs and carries
/// on. Worst case the migration is retried next launch.
pub fn migrate_global(app_data: &Path) -> Result<(), String> {
    let path = global_path(app_data);
    // A config that doesn't exist yet has nothing to migrate, and CREATING one here would write a
    // file the user never asked for. Fresh installs already default to auto.
    let Some(text) = read_if_exists(&path) else {
        return Ok(());
    };
    // Parse DIRECTLY — deliberately NOT via `load_document`, which falls back to DEFAULT_TEMPLATE on
    // a syntax error (roborev 53240). That fallback is safe behind an explicit user write, but here
    // it would stamp the template over a config the user merely typo'd and `write_atomic` it, wiping
    // every setting AND the broken text they need in order to fix it — silently, since the write
    // succeeds. `reload_global` keeps the last-good config and warns precisely so the file can be
    // repaired; a migration must not undo that. Bail instead: the caller logs, and the migration is
    // retried on the NEXT LAUNCH — not mid-session. The watcher only calls `reload_global`, so
    // fixing the typo now reloads the config but does not re-run this.
    let mut doc = text.parse::<toml_edit::DocumentMut>().map_err(|e| {
        format!("config.toml is not valid TOML; migration deferred until it is fixed: {e}")
    })?;
    let applied = doc
        .get("meta")
        .and_then(|m| m.get("config_version"))
        .and_then(|v| v.as_integer())
        .unwrap_or(0);
    if applied >= CONFIG_MIGRATION_VERSION {
        return Ok(());
    }
    // EACH MIGRATION IS GATED ON ITS OWN REVISION (`applied < N`), never on the aggregate.
    // This check only decides whether there is ANY work to do; it cannot decide WHICH work.
    // Gating solely on it meant every version bump re-armed every earlier migration for exactly
    // the population an upgrade touches — installs sitting at the previous version (roborev
    // 55804). A user migrated by v1 who then deliberately re-pinned `max_concurrent = 20` had it
    // silently deleted again, breaking the promise v1's own comment makes below. When you add v3,
    // add `applied < 3` to it — do not rely on this gate.

    // v1 — adopt AUTO for installs still carrying the old hardcoded default.
    //
    // `max_concurrent` used to default to 20, and the config file is rewritten WHOLE on the first
    // `set_value`, so every user who ever toggled an AI feature or opened the ⋯ Advanced editor has
    // a literal `max_concurrent = 20` on disk they never chose. Under the new semantics that line is
    // a PINNED CEILING, which would leave exactly the population this change exists to unblock
    // (anything bigger than ~64 GiB) stuck at 20 forever — and silently, since `auto >= configured`
    // warns about nothing. Removing the LINE (not just the parsed value) is what makes this stick:
    // the next load sees no key at all, and a 20 the user sets later survives, because by then the
    // recorded revision has moved past this migration.
    let is_legacy_default = applied < 1
        && doc
        .get("workers")
        .and_then(|w| w.get("max_concurrent"))
        .and_then(|v| v.as_integer())
        == Some(LEGACY_DEFAULT_MAX_CONCURRENT as i64);
    if is_legacy_default {
        // Both TOML shapes: the standard `[workers]` header and a hand-written inline
        // `workers = { … }`. `as_table_like_mut` covers both; `unset_dotted` rejects the inline form
        // during traversal, which would strand that user on the legacy value forever.
        //
        // Belt-and-braces: unreachable by construction, because `is_legacy_default` above reads
        // through `Item::get`, whose `Index for str` resolves exactly the two shapes
        // `as_table_like_mut` accepts (`Table` and `Value::InlineTable`). Any other shape makes
        // `is_legacy_default` false and never gets here. Kept anyway so the read and write paths
        // can't silently drift apart later. (The reachable version of this hazard is the `meta`
        // block below, where the write runs unconditionally.)
        let Some(t) = doc.get_mut("workers").and_then(|w| w.as_table_like_mut()) else {
            return Err(
                "[workers] is not a table; migration deferred until config.toml is fixed".into()
            );
        };
        t.remove("max_concurrent");
        // Don't leave a dangling `[workers]` behind when that was its only key — the user opens this
        // file in the Advanced editor, and a stanza attributable to nothing is clutter.
        if doc.get("workers").and_then(|w| w.as_table_like()).is_some_and(|t| t.is_empty()) {
            doc.remove("workers");
        }
        tracing::debug!(
            "config migration v1: removing the legacy \
             max_concurrent = {LEGACY_DEFAULT_MAX_CONCURRENT} (a default, not a choice)"
        );
    }

    // v2 — drop the RETIRED STOP WORD for installs still carrying it as a stamped default.
    //
    // Same shape as v1, and the same root cause: `[voice]` is uncommented in DEFAULT_TEMPLATE and
    // `load_document` falls back to that template, so the first `set_value` on an install with no
    // config file writes the WHOLE template — including whichever `stop_word` line shipped that
    // day. From PR #375 until the rename it read "Sparkle, stop".
    //
    // Renaming the phrase therefore only reached FRESH installs. `hydrateFromConfig` cannot tell a
    // stamped default from a deliberate choice, so everyone else keeps seeing the retired phrase in
    // the composer placeholder, the waveform caption and the Voice-controls field — with no
    // migration and nothing on screen explaining it (roborev 55507). Removing the LINE is what
    // makes it stick: the next load sees no key and falls back to the current default, and a phrase
    // the user sets LATER survives, because by then the recorded revision has moved past this.
    //
    // Scope check, because this one is easy to over-apply: it changes only what the UI DISPLAYS.
    // The recogniser still answers to "stop" as a permanent undisplayed alias, so no user loses a
    // working voice command — see the retained-alias note beside `STOP_VARIANTS`.
    let is_legacy_stop_word = applied < 2
        && doc
        .get("voice")
        .and_then(|v| v.get("stop_word"))
        .and_then(|v| v.as_str())
        == Some(LEGACY_DEFAULT_STOP_WORD);
    if is_legacy_stop_word {
        // `as_table_like_mut` for the same reason as `workers`: it covers both the `[voice]` header
        // and a hand-written inline `voice = { … }`, where `unset_dotted`'s traversal would refuse
        // and strand that user on the retired phrase forever.
        let Some(t) = doc.get_mut("voice").and_then(|v| v.as_table_like_mut()) else {
            return Err(
                "[voice] is not a table; migration deferred until config.toml is fixed".into()
            );
        };
        t.remove("stop_word");
        // Don't leave a dangling `[voice]` behind when that was its only key — same reasoning as
        // `[workers]`: the user opens this file in the Advanced editor and an empty stanza
        // attributable to nothing is clutter.
        if doc.get("voice").and_then(|v| v.as_table_like()).is_some_and(|t| t.is_empty()) {
            doc.remove("voice");
        }
        tracing::debug!(
            "config migration v2: removing the retired \
             stop_word = {LEGACY_DEFAULT_STOP_WORD:?} (a default, not a choice)"
        );
    }

    // Written table-shape-agnostically for the same reason as `workers` above: `set_dotted` demands
    // a real `Table`, so a pre-existing inline `meta = { … }` would fail its traversal and defer the
    // migration forever. Creating the table when absent keeps the common path unchanged.
    //
    // THIS is where the read/write mismatch is genuinely reachable: `applied` above was read with
    // `Item::get`, but this write runs unconditionally — so a `meta` of any other shape (a string, an
    // array, an array-of-tables) reaches here. It must DEFER rather than fall through, because
    // stamping `config_version` on a config whose key we failed to remove would mark the migration
    // applied when it wasn't: permanently un-migratable, and silent about it.
    let meta_is_new = doc.get("meta").is_none();
    if meta_is_new {
        let mut table = toml_edit::Table::new();
        // Explain the table we are inventing. A bare stanza appended to the end of the file is
        // exactly what a user tidying their config deletes — which would re-arm every migration.
        // The template carries the same explanation for fresh installs; this gives migrated ones
        // parity. Set on the table BEFORE insertion, so there is no second lookup that advertises a
        // fallible path which cannot actually fail.
        table.decor_mut().set_prefix(
            "\n# --- Bookkeeping (written by Sparkle; you don't need to touch this) ---\n\
             # Which one-time config migrations have already been applied to this file. Sparkle\n\
             # uses it to know it has already upgraded you, so it never re-applies a migration\n\
             # and never overrides a value you set yourself afterwards. Lowering or deleting\n\
             # this can re-run past migrations.\n",
        );
        doc.insert("meta", toml_edit::Item::Table(table));
    }
    let Some(meta) = doc.get_mut("meta").and_then(|m| m.as_table_like_mut()) else {
        return Err("[meta] is not a table; migration deferred until config.toml is fixed".into());
    };
    meta.insert("config_version", toml_edit::value(CONFIG_MIGRATION_VERSION));
    let text = doc.to_string();
    // Same guard as `set_value`: never persist a document that would fail to parse, or every future
    // load silently resets all settings.
    parse_layer(&text)
        .map_err(|e| format!("rejected: the migration would make config.toml invalid: {e}"))?;
    write_atomic(&path, &text)?;
    // Announced only after the write lands — the three exits above persist nothing.
    if is_legacy_default {
        tracing::info!(
            "config migration v1: adopted automatic worker concurrency (removed the legacy \
             max_concurrent = {LEGACY_DEFAULT_MAX_CONCURRENT}, which was a default, not a choice)"
        );
    }
    if is_legacy_stop_word {
        tracing::info!(
            "config migration v2: adopted the current spoken stop phrase (removed the retired \
             stop_word = {LEGACY_DEFAULT_STOP_WORD:?}, which was a default, not a choice). The \
             recogniser still answers to the old phrase."
        );
    }
    Ok(())
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
    // One-time on-disk migrations run BEFORE the first load, so `current()` reflects the migrated
    // file rather than a value we are about to remove. Best-effort: a migration failure must never
    // block startup — log it and load what's there; it will be retried next launch.
    if let Err(e) = migrate_global(&ad) {
        tracing::warn!("config migration skipped: {e}");
    }
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
    fn a_non_string_concierge_rule_does_not_discard_the_whole_config() {
        // roborev 54240. `tools: BTreeMap<String, String>` made a single hand-edit like
        // `merge_pr = true` fail the WHOLE-FILE parse, which discards the entire global layer and
        // sets hard_error — every unrelated setting silently reverts to its default. One typo in
        // one concierge rule must not cost the user their configuration.
        let global = r#"
[workflow]
require_pr = false

[concierge.tools]
merge_pr = true
discard_agent = "deny"
quit_app = 42
"#;
        let (cfg, _warns, hard) = effective(Some(global), None);
        assert!(!hard, "a bad concierge value must not be a hard error");
        // The unrelated setting survives — this is the property that actually matters.
        assert!(!cfg.workflow.require_pr, "an unrelated setting must not revert to its default");
        // The readable rule is kept, raw and unnarrowed.
        assert_eq!(cfg.concierge.tools.get("discard_agent").map(String::as_str), Some("deny"));
        // The non-string ones are DROPPED, so they read as "no rule" and fall to the derived
        // default — matching what the TS policy layer already documents.
        assert!(cfg.concierge.tools.get("merge_pr").is_none(), "a bool is not a rule");
        assert!(cfg.concierge.tools.get("quit_app").is_none(), "an int is not a rule");
    }

    #[test]
    fn an_unreadable_concierge_string_is_kept_not_dropped() {
        // The two cases are different on purpose: a non-string is not a rule at all, but a
        // misspelt STRING is a rule we cannot read — and the TS layer resolves that to `ask`,
        // stricter than the derived default. Narrowing it away here would hand back exactly the
        // authority the user was trying to remove.
        let global = "[concierge.tools]\nmerge_pr = \"denyy\"\n";
        let (cfg, _warns, hard) = effective(Some(global), None);
        assert!(!hard);
        assert_eq!(cfg.concierge.tools.get("merge_pr").map(String::as_str), Some("denyy"));
    }

    #[test]
    fn defaults_when_no_files() {
        let (cfg, warns, hard) = effective(None, None);
        assert_eq!(cfg, SparkleConfig::default());
        assert_eq!(cfg.workers.max_concurrent, None, "unset means AUTO, not a fixed number");
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
        assert_eq!(cfg.workers.max_concurrent, Some(8));
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
        assert_eq!(cfg.workers.max_concurrent, None, "unset means AUTO, not a fixed number");
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
    fn plugins_default_to_their_table_row_and_resolve_to_exact_marketplace_ids() {
        let (cfg, _, _) = effective(None, None);

        // The default of every toggle comes from its own KNOWN_PLUGINS row — one place, so the
        // built-in default, the template, and the frontend can no longer disagree.
        for kp in KNOWN_PLUGINS {
            assert_eq!(
                cfg.plugins.is_enabled(kp.toggle),
                kp.default_on,
                "{} must default to its table row",
                kp.toggle
            );
        }

        // Each enabled row resolves to the exact `<plugin>@<marketplace>` id Claude Code keys
        // `enabledPlugins` by. These strings were verified against the live marketplace.json of
        // each marketplace — a typo here silently produces a settings file that enables a plugin
        // that does not exist.
        let ids: Vec<String> = cfg.plugins.enabled().iter().map(|p| p.id()).collect();
        assert!(ids.contains(&"superpowers@claude-plugins-official".to_string()));
        assert!(ids.contains(&"frontend-design@claude-plugins-official".to_string()));
        assert!(ids.contains(&"sparkle-freshness@sparkle".to_string()));
        assert!(
            !ids.contains(&"sparkle-mutation-check@sparkle".to_string()),
            "mutation-check ships OFF: it is a deliberate act, not a background discipline"
        );
        assert!(
            !ids.contains(&"sparkle-guardrails@sparkle".to_string()),
            "the guardrails PLUGIN ships OFF: [tools].guardrails already injects the same prose, \
             and enabling both would give every agent the identical discipline twice"
        );
    }

    /// The `<toggle> = <bool>` assignment for `toggle` in a TOML source, or None if there is no
    /// such assignment line. Used to check the shipped template ACTUALLY sets a key, rather than
    /// merely mentioning its name somewhere in prose.
    fn template_toggle_value(toml_src: &str, toggle: &str) -> Option<bool> {
        toml_src.lines().find_map(|line| {
            // Strip a trailing `# comment`, then split on the first `=`.
            let code = line.split('#').next().unwrap_or("");
            let (k, v) = code.split_once('=')?;
            if k.trim() != toggle {
                return None;
            }
            v.trim().parse::<bool>().ok()
        })
    }

    #[test]
    fn every_known_plugin_has_a_live_toggle() {
        // The table and PluginsConfig are two halves of one mapping. Adding a row without adding
        // its bool field would leave `is_enabled` falling through to the unknown-name arm, so the
        // plugin could never turn on — and nothing else would fail. This is that guard.
        let all_on = PluginsConfig::with_all(true);
        let defaults = SparkleConfig::default();
        for p in KNOWN_PLUGINS {
            assert!(
                all_on.is_enabled(p.toggle),
                "KNOWN_PLUGINS row '{}' has no matching PluginsConfig field",
                p.toggle
            );
            // Not a substring check: the template must contain a real `toggle = <bool>` ASSIGNMENT
            // (a name mentioned only in a comment or a prose paragraph would satisfy `contains` and
            // leave `reset_config` writing a file with no such key), and its value must match the
            // built-in default — a template that disagrees silently changes behavior on reset.
            let templated = template_toggle_value(DEFAULT_TEMPLATE, p.toggle).unwrap_or_else(|| {
                panic!("DEFAULT_TEMPLATE has no `{} = <bool>` assignment line", p.toggle)
            });
            assert_eq!(
                templated,
                defaults.plugins.is_enabled(p.toggle),
                "DEFAULT_TEMPLATE's `{}` disagrees with SparkleConfig::default()",
                p.toggle
            );
            // Every row needs a source: the installer runs `marketplace add <repo>` from it, which
            // is what makes a machine that never launched Claude Code interactively work at all.
            let src = p.source.expect("every KNOWN_PLUGINS row needs a marketplace source");
            assert_eq!(src.name, p.marketplace, "source name must match the plugin id's marketplace half");
            // ...and only a NON-official marketplace is declared per-worktree.
            assert_eq!(p.declared_source().is_some(), p.marketplace != OFFICIAL_MARKETPLACE);
        }
        // An unknown/forward-compatible toggle never resolves to enabled.
        assert!(!all_on.is_enabled("episodic_memory"));
        // And the helper itself only accepts real assignments (guards the guard).
        assert_eq!(template_toggle_value("superpowers = false # note", "superpowers"), Some(false));
        assert_eq!(template_toggle_value("# superpowers are great", "superpowers"), None);
    }

    #[test]
    fn plugins_config_serializes_exactly_the_known_plugin_toggles() {
        // The other direction of the table↔struct mapping. `every_known_plugin_has_a_live_toggle`
        // catches a row with no field; this catches a FIELD with no row — which would ship a
        // frontend-visible toggle that hydrates and persists but is never read by
        // `enabled()`, so flipping it would do nothing at all.
        let json = serde_json::to_value(SparkleConfig::default().plugins).unwrap();
        let mut serialized: Vec<&str> = json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        let mut rows: Vec<&str> = KNOWN_PLUGINS.iter().map(|p| p.toggle).collect();
        serialized.sort_unstable();
        rows.sort_unstable();
        assert_eq!(
            serialized, rows,
            "PluginsConfig's serialized keys must match KNOWN_PLUGINS exactly (the JSON key is what \
             the frontend store mirrors, and the toggle is what `enabled()` looks up)"
        );
    }

    #[test]
    fn global_and_project_can_disable_plugins_field_by_field() {
        // Global turns one off; the other keeps its default.
        let g = "[plugins]\nfrontend_design = false\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(!cfg.plugins.is_enabled("frontend_design"));
        assert!(cfg.plugins.is_enabled("superpowers"), "untouched plugin keeps its default");
        // Only the one key named in the file moved; every other row still sits at its own default.
        for kp in KNOWN_PLUGINS.iter().filter(|k| k.toggle != "frontend_design") {
            assert_eq!(
                cfg.plugins.is_enabled(kp.toggle),
                kp.default_on,
                "{} must be untouched by a file that never mentions it",
                kp.toggle
            );
        }

        // [plugins] is repo-scoped (like [workflow]), so a project file overrides the global — and
        // does NOT produce a "machine-wide setting ignored" warning the way [tools] does.
        let p = "[plugins]\nsuperpowers = false\nfrontend_design = true\n";
        let (cfg, warns, hard) = effective(Some(g), Some(p));
        assert!(!hard);
        assert!(
            !warns.iter().any(|w| w.contains("[plugins]")),
            "[plugins] is repo-overridable; it must not be warned about: {warns:?}"
        );
        assert!(!cfg.plugins.is_enabled("superpowers"), "project beats global");
        assert!(cfg.plugins.is_enabled("frontend_design"), "project re-enables what global turned off");
    }

    /// The TRUST block is security-relevant prose a user acts on, so it is held to the same
    /// standard as the code — an overstatement there is a bug, not a typo. Two claims were wrong in
    /// exactly this way once (roborev 55099): "both marketplaces pin what they serve" (the listing
    /// is fetched from the default branch, only the entries are pinned) and "set a row false to
    /// stop Sparkle fetching it at all" (a project layer can turn it back on).
    ///
    /// These are substring assertions on purpose. They cannot prove the prose is accurate; what
    /// they do is make the behavior and its description fail TOGETHER, so anyone who makes a global
    /// `false` authoritative — or pins the listing — has to come here and find the sentence that
    /// stopped being true.
    #[test]
    fn the_template_trust_block_states_the_limits_it_actually_has() {
        let t = DEFAULT_TEMPLATE;
        assert!(
            t.contains("Neither LISTING is pinned"),
            "the template must not imply a listing is pinned; only Sparkle's plugin content is"
        );
        // KEYED OFF THE TABLE, not a fixed string: the pinning claim is Sparkle-marketplace-only,
        // and it is only *honest* while some rows come from elsewhere. If a row from a marketplace
        // Sparkle does not pin exists — and superpowers/frontend_design are exactly that, and are
        // default-on — the prose must say so out loud. Adding or removing such a row therefore
        // forces this sentence to be revisited instead of quietly becoming an overstatement.
        if KNOWN_PLUGINS.iter().any(|p| p.marketplace == OFFICIAL_MARKETPLACE) {
            assert!(
                t.contains("content from Anthropic's is not pinned by us"),
                "rows from a marketplace Sparkle does not pin exist, so the template must not \
                 claim plugin content is pinned without qualification"
            );
        }
        assert!(
            t.contains("repo-overridable"),
            "the template must say a project layer can re-enable a globally disabled row"
        );
        // The behavior the second claim describes, pinned right next to it — if this stops holding,
        // the sentence above is the thing to change.
        let g = "[plugins]\nsuperpowers = false\n";
        let p = "[plugins]\nsuperpowers = true\n";
        let (cfg, _, _) = effective(Some(g), Some(p));
        assert!(
            cfg.plugins.is_enabled("superpowers"),
            "a project layer really can re-enable what the global layer turned off"
        );
    }

    #[test]
    fn a_hyphenated_plugin_toggle_is_reported_rather_than_silently_doing_nothing() {
        // The reported scenario: a user writes the PLUGIN id (`frontend-design`) where the TOGGLE
        // name (`frontend_design`) belongs. It parses, it is retained, and it changes nothing — so
        // without a warning the plugin stays on and no surface anywhere says the line was inert.
        let g = "[plugins]\nfrontend-design = false\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(cfg.plugins.is_enabled("frontend_design"), "the real toggle is untouched");
        assert!(
            warns.iter().any(|w| w.contains("[plugins].frontend-design")),
            "the typo must be surfaced, got: {warns:?}"
        );
    }

    #[test]
    fn a_config_naming_only_real_toggles_warns_about_nothing() {
        // The other half: a correct file must stay silent, or the warning becomes noise people
        // learn to scroll past.
        let mut g = String::from("[plugins]\n");
        for kp in KNOWN_PLUGINS {
            g.push_str(&format!("{} = {}\n", kp.toggle, kp.default_on));
        }
        let (_cfg, warns, _hard) = effective(Some(&g), None);
        assert!(
            !warns.iter().any(|w| w.contains("[plugins]")),
            "a valid [plugins] block must produce no warnings, got: {warns:?}"
        );
    }

    #[test]
    fn all_plugins_off_yields_no_enabled_plugins() {
        // Built from the table rather than a hand-listed pair, so this keeps meaning "every toggle
        // off" as the catalog grows instead of quietly testing a subset.
        let mut g = String::from("[plugins]\n");
        for kp in KNOWN_PLUGINS {
            g.push_str(&format!("{} = false\n", kp.toggle));
        }
        let (cfg, _, _) = effective(Some(&g), None);
        assert!(cfg.plugins.enabled().is_empty());
    }

    #[test]
    fn an_unreadable_plugin_value_is_dropped_without_costing_the_whole_config_layer() {
        // The [concierge.tools] lesson, applied to [plugins]: a strongly-typed map would fail
        // `toml::from_str` for the WHOLE FILE on one bad value, discarding every unrelated setting
        // in it. A non-bool must be dropped per-key instead.
        let g = "[workflow]\nrequire_pr = false\n\n[plugins]\nsuperpowers = \"yes\"\nframework = 42\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard, "a bad plugin value must not be a hard error");
        assert!(!cfg.workflow.require_pr, "an unrelated setting must not revert to its default");
        assert!(
            cfg.plugins.is_enabled("superpowers"),
            "a non-bool is no opinion at all, so the row keeps its default rather than reading as off"
        );
        // `framework` is a typo for nothing: it parses, round-trips, and does nothing. Say so,
        // otherwise it is indistinguishable from a line that worked.
        assert!(
            warns.iter().any(|w| w.contains("[plugins].framework")),
            "an unrecognized [plugins] key must be surfaced, got: {warns:?}"
        );
    }

    #[test]
    fn an_unknown_plugin_key_survives_a_round_trip_but_never_reads_as_enabled() {
        // A config written by a NEWER Sparkle must not be silently erased by an older one, but an
        // unknown key must never resolve to "enabled" either.
        let g = "[plugins]\nfrom_the_future = true\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(
            warns.iter().any(|w| w.contains("[plugins].from_the_future")),
            "kept verbatim, but the user is still told it had no effect: {warns:?}"
        );
        assert!(!cfg.plugins.is_enabled("from_the_future"), "unknown keys are never enabled");
        assert!(
            !cfg.plugins.enabled().iter().any(|p| p.toggle == "from_the_future"),
            "and never reach the installer"
        );
        let json = serde_json::to_value(&cfg.plugins).unwrap();
        assert_eq!(json["from_the_future"], serde_json::json!(true), "but it is kept verbatim");
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
    fn builder_index_is_the_one_tool_that_defaults_off() {
        // Every other [tools] flag ships ON. This one publishes daily token totals to a public
        // leaderboard, so a fresh install — and any config file that never mentions it — must be
        // opted OUT. (The reporter also gates on consent + credentials, but the toggle is the
        // outermost gate and it has to hold on its own.)
        let (cfg, _, _) = effective(None, None);
        assert!(!cfg.tools.builder_index);
        // A config that sets other tools must not drag it on.
        let (cfg, _, _) = effective(Some("[tools]\nbeads = false\n"), None);
        assert!(!cfg.tools.builder_index);
        // And it is opt-IN-able from the global file.
        let (cfg, warns, hard) = effective(Some("[tools]\nbuilder_index = true\n"), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(cfg.tools.builder_index);
        assert!(cfg.tools.roborev, "untouched tool keeps its default");
    }

    #[test]
    fn project_cannot_opt_a_machine_into_builder_index() {
        // [tools] is machine-wide. A cloned repo shipping `builder_index = true` in its
        // .sparkle/config.toml must NOT be able to start publishing this machine's usage.
        let p = "[tools]\nbuilder_index = true\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert!(!cfg.tools.builder_index);
        assert!(warns.iter().any(|w| w.contains("[tools]")));
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
    fn improvement_consent_defaults_none_and_global_sets_it() {
        // Unset by default (None, NOT "case_by_case") so a first-launch hydrate can't clobber a
        // persisted webview choice — an absent [improvement] means "the app's default applies".
        let (cfg, _, _) = effective(None, None);
        assert_eq!(cfg.improvement.consent, None);

        // A global [improvement] section mirrors the chosen mode into the file.
        let g = "[improvement]\nconsent = \"always\"\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert_eq!(cfg.improvement.consent.as_deref(), Some("always"));
    }

    #[test]
    fn project_improvement_is_ignored_with_warning() {
        // [improvement] is machine-wide (like [roborev]); a repo can't set how the user's usage is
        // shared, so a per-project value is ignored and a warning is surfaced.
        let p = "[improvement]\nconsent = \"always\"\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert_eq!(cfg.improvement.consent, None);
        assert!(warns.iter().any(|w| w.contains("[improvement]")));
    }

    #[test]
    fn onepassword_is_the_one_tool_that_ships_off() {
        // Every other [tools] flag defaults on; this one can't (it needs an external account + CLI),
        // so a fresh install must not advertise it as active.
        let (cfg, _, _) = effective(None, None);
        assert!(!cfg.tools.onepassword);
        assert!(cfg.tools.roborev, "the other tools still ship on");

        // Opting in is a plain global [tools] flip.
        let g = "[tools]\nonepassword = true\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(cfg.tools.onepassword);
    }

    #[test]
    fn onepassword_vault_and_seeding_default_unset_and_global_sets_them() {
        // No vault picked and no worktree seeding until the user asks for both.
        let (cfg, _, _) = effective(None, None);
        assert_eq!(cfg.onepassword.vault_id, None);
        assert!(!cfg.onepassword.seed_worktrees);

        let g = "[onepassword]\nvault_id = \"abc123\"\nseed_worktrees = true\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert_eq!(cfg.onepassword.vault_id.as_deref(), Some("abc123"));
        assert!(cfg.onepassword.seed_worktrees);
    }

    #[test]
    fn blank_vault_id_reads_as_unset_not_as_a_configured_vault() {
        // A whitespace-only vault_id must degrade to "pick a vault", not be stored verbatim — a
        // blank string would read as configured everywhere downstream and turn every `op` call
        // into an opaque failure instead of showing the picker.
        let g = "[onepassword]\nvault_id = \"   \"\n";
        let (cfg, _, hard) = effective(Some(g), None);
        assert!(!hard);
        assert_eq!(cfg.onepassword.vault_id, None);
    }

    #[test]
    fn project_onepassword_is_ignored_with_warning() {
        // The vault belongs to the user's 1Password account, not to a repo, so a project file
        // must not be able to redirect where another repo's secrets get written.
        let p = "[onepassword]\nvault_id = \"attacker-vault\"\nseed_worktrees = true\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert_eq!(cfg.onepassword.vault_id, None);
        assert!(!cfg.onepassword.seed_worktrees);
        assert!(warns.iter().any(|w| w.contains("[onepassword]")));
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
        assert_eq!(cfg.workers.max_concurrent, Some(1));
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
        assert_eq!(cfg.workers.max_concurrent, None, "unset means AUTO, not a fixed number");
        // ...and setting only the old key leaves the new one at the default.
        let (cfg, _, _) = effective(Some("[workers]\nmax_concurrent = 6\n"), None);
        assert_eq!(cfg.workers.max_concurrent, Some(6));
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

    // ── [memory]: the section memwatch.rs reads (bead sparkle-0bye) ──────────────────────────

    #[test]
    fn a_memory_section_round_trips_from_toml_into_the_effective_config() {
        // The WIRING test. `memwatch::memory_admission` / `agent_memory_watchdog` read these four
        // fields off `current_effective()`, so a `[memory]` block that parses but never reaches the
        // effective config would leave the whole feature running on defaults while looking
        // configured. EVERY value here is deliberately the opposite of `MemoryConfig::DEFAULT`, so
        // this fails if `apply_memory` is not called (the config would still hold the defaults).
        let (cfg, warns, hard) = effective(
            Some(
                "[memory]\n\
                 pressure_gate = false\n\
                 agent_rss_warn_mb = 5000\n\
                 agent_rss_kill_mb = 9000\n\
                 agent_rss_auto_kill = true\n",
            ),
            None,
        );
        assert!(!hard, "a valid [memory] block is not a parse failure: {warns:?}");
        assert!(!cfg.memory.pressure_gate, "pressure_gate did not survive the merge");
        assert_eq!(cfg.memory.agent_rss_warn_mb, 5000);
        assert_eq!(cfg.memory.agent_rss_kill_mb, 9000);
        assert!(cfg.memory.agent_rss_auto_kill);
        assert_ne!(cfg.memory, MemoryConfig::DEFAULT, "…and it is not merely the default");
        assert!(
            !warns.iter().any(|w| w.contains("[memory]")),
            "a valid, above-floor [memory] block must warn about nothing: {warns:?}"
        );
    }

    #[test]
    fn an_absent_memory_section_leaves_the_shipped_defaults_intact() {
        // The other half of the merge: a partial section must not zero the fields it omits.
        let (cfg, _, _) = effective(Some("[memory]\npressure_gate = false\n"), None);
        assert!(!cfg.memory.pressure_gate);
        assert_eq!(
            cfg.memory.agent_rss_warn_mb,
            MemoryConfig::DEFAULT.agent_rss_warn_mb,
            "an omitted key keeps its default rather than becoming 0"
        );
        assert_eq!(cfg.memory.agent_rss_kill_mb, MemoryConfig::DEFAULT.agent_rss_kill_mb);
    }

    #[test]
    fn validate_floors_a_below_floor_agent_rss_warn_mb_and_says_so() {
        // A threshold under the measured ~1.11 GiB per-agent working set marks every healthy agent
        // as a runaway on the first poll. Assert BOTH side effects: the value is rewritten, and the
        // user is told — a silent floor would leave them believing the number they typed is live.
        let (cfg, warns, _) = effective(Some("[memory]\nagent_rss_warn_mb = 256\n"), None);
        assert_eq!(cfg.memory.agent_rss_warn_mb, MIN_AGENT_RSS_THRESHOLD_MB, "floored to 1536");
        assert!(
            warns.iter().any(|w| w.contains("agent_rss_warn_mb") && w.contains("1536")),
            "the floor must be announced, not applied silently: {warns:?}"
        );
    }

    #[test]
    fn validate_floors_a_below_floor_agent_rss_kill_mb_and_says_so() {
        let (cfg, warns, _) = effective(Some("[memory]\nagent_rss_kill_mb = 900\n"), None);
        assert_eq!(cfg.memory.agent_rss_kill_mb, MIN_AGENT_RSS_THRESHOLD_MB);
        assert!(warns.iter().any(|w| w.contains("agent_rss_kill_mb")), "{warns:?}");
    }

    #[test]
    fn a_zero_rss_threshold_is_the_documented_opt_out_not_a_floored_value() {
        // 0 disables that tier (memwatch's `watchdog_verdicts` never fires on it). Flooring it to
        // 1536 would silently re-arm a watchdog the user turned off.
        let (cfg, warns, _) =
            effective(Some("[memory]\nagent_rss_warn_mb = 0\nagent_rss_kill_mb = 0\n"), None);
        assert_eq!(cfg.memory.agent_rss_warn_mb, 0);
        assert_eq!(cfg.memory.agent_rss_kill_mb, 0);
        assert!(
            !warns.iter().any(|w| w.contains("below the measured")),
            "0 is an opt-out, not a too-small value: {warns:?}"
        );
    }

    #[test]
    fn arming_auto_kill_with_the_kill_tier_disabled_warns_that_nothing_will_be_killed() {
        // Reads as protection, provides none. The config is left as written — this one only warns.
        let (cfg, warns, _) =
            effective(Some("[memory]\nagent_rss_kill_mb = 0\nagent_rss_auto_kill = true\n"), None);
        assert!(cfg.memory.agent_rss_auto_kill);
        assert_eq!(cfg.memory.agent_rss_kill_mb, 0);
        assert!(
            warns.iter().any(|w| w.contains("agent_rss_auto_kill") && w.contains("nothing")),
            "an armed-but-inert auto-kill must be called out: {warns:?}"
        );
    }

    #[test]
    fn project_memory_is_ignored_with_warning() {
        // Same rule as [workers]: one repo must not be able to arm auto-kill — or disarm the
        // pressure gate — for every other project sharing the machine's RAM.
        let (cfg, warns, _) = effective(
            None,
            Some("[memory]\npressure_gate = false\nagent_rss_auto_kill = true\n"),
        );
        assert_eq!(
            cfg.memory,
            MemoryConfig::DEFAULT,
            "a project layer must not move a machine-wide setting"
        );
        assert!(
            warns.iter().any(|w| w.contains("[memory]") && w.contains("ignored")),
            "the ignoring must be visible, not silent: {warns:?}"
        );
    }

    #[test]
    fn the_shipped_template_parses_to_exactly_the_memory_defaults() {
        // DEFAULT_TEMPLATE is what `reset_config` writes. If its [memory] block ever drifts from
        // `MemoryConfig::DEFAULT`, a user who resets their config gets different behavior than a
        // user who has no config at all.
        let (cfg, _, hard) = effective(Some(DEFAULT_TEMPLATE), None);
        assert!(!hard);
        assert_eq!(cfg.memory, MemoryConfig::DEFAULT);
    }

    #[test]
    fn ram_derived_concurrency_divides_usable_ram_by_the_agent_ram_budget() {
        // At the default 3072 MiB ceiling the budget is 1536 MiB (half the ceiling — above the
        // 768 MiB measured working set), NOT the 3072 the old derivation used.
        // 64 GiB − 6 GiB reserve = 59392 MiB usable ÷ 1536 = 38.
        assert_eq!(ram_derived_concurrency(64 * GIB, 6 * GIB, 3072), 38);
        // 16 GiB − 6 = 10240 ÷ 1536 = 6. (The old basis said 3 — a 6x over-reserve against a
        // measured ~520 MiB RSS.)
        assert_eq!(ram_derived_concurrency(16 * GIB, 6 * GIB, 3072), 6);
        // 128 GiB − 6 = 124928 ÷ 1536 = 81.
        assert_eq!(ram_derived_concurrency(128 * GIB, 6 * GIB, 3072), 81);
    }

    // THE point of the new basis: `agent_heap_mb` is a heap CEILING, not a working-set estimate, and
    // pricing every agent at the ceiling was the ~6x over-reserve. The budget is the larger of the
    // measured working set and the ceiling's amortized share, so it neither over-reserves nor lets a
    // huge ceiling be ignored.
    #[test]
    fn the_ram_budget_is_a_working_set_not_the_heap_ceiling() {
        // Default ceiling: half of it (1536) exceeds the measured working set (1152 — roborev
        // 54816 corrected this from a per-PROCESS figure to the per-AGENT one), so it wins — still
        // ~2.7x more permissive than dividing by the whole ceiling would be.
        assert_eq!(agent_ram_budget_mb(3072), 1536);
        // A ceiling at or below ~1.33x the working set: the MEASURED number takes over, and the
        // budget stops tracking the ceiling downward past what an agent actually needs.
        assert_eq!(agent_ram_budget_mb(1536), 1152);
        assert_eq!(agent_ram_budget_mb(1024), 1024);
        // ...but never above the ceiling itself: an agent cannot reside far past a heap it may not
        // grow into, so a deliberately tiny ceiling does raise concurrency.
        assert_eq!(agent_ram_budget_mb(512), 512);
        // The opt-out (V8's own ~4 GiB) is still budgeted, not ignored — 2048, not 4096.
        assert_eq!(agent_ram_budget_mb(V8_DEFAULT_HEAP_MB), 2048);
    }

    // Roborev 54816: every existing fixture used 3072, 1024 (asserted on warning text only), or 0 —
    // none exercised the regime where the RAM budget FLOORS at the measured working set and CPU
    // becomes the sole bound, which is exactly where a stale AGENT_TYPICAL_RSS_MB would silently
    // over-admit. This machine, this constant: 128 GiB, 18 cores, agent_heap_mb pushed low enough
    // that RAM would otherwise be the generous side.
    #[test]
    fn a_low_agent_heap_mb_floors_the_ram_budget_at_the_measured_working_set() {
        let w = WorkersConfig { max_concurrent: None, agent_heap_mb: 900 };
        // budget = max(steady=min(1152,900)=900, peak=900/2=450) = 900.
        // by_ram = 124928 / 900 = 138; by_cpu = 18 * 6 = 108. CPU binds.
        let d = memory_aware_concurrency(&w, Some(128 * GIB), Some(18));
        assert_eq!((d.effective, d.bound), (108, Bound::Cpu));
    }

    // The guard that keeps "budget on typical RSS" from re-creating the 2026-07-20 coalition: the
    // SUM of heap ceilings across the derived count may exceed usable RAM, but only by
    // PEAK_HEAP_OVERCOMMIT. The incident sat at roughly 3x; this holds the line at 2x.
    #[test]
    fn the_sum_of_heap_ceilings_never_exceeds_usable_ram_by_more_than_the_overcommit_factor() {
        for (total_gib, heap_mb) in [(16u64, 3072u32), (64, 3072), (128, 3072), (32, 4096), (192, 512)] {
            let n = ram_derived_concurrency(total_gib * GIB, 6 * GIB, heap_mb);
            let usable_mb = (total_gib * GIB).saturating_sub(6 * GIB) / (1024 * 1024);
            // n == 1 is the floor for a machine too small to hold even one agent; it is allowed to
            // exceed the factor because refusing to run at all is worse.
            if n > 1 {
                assert!(
                    (n as u64) * (heap_mb as u64) <= usable_mb * (PEAK_HEAP_OVERCOMMIT as u64),
                    "{n} agents x {heap_mb} MiB overcommits {usable_mb} MiB usable by more than \
                     {PEAK_HEAP_OVERCOMMIT}x on a {total_gib} GiB machine",
                );
            }
        }
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
        let mut w = WorkersConfig { max_concurrent: Some(20), agent_heap_mb: 3072 };
        // RAM allows fewer than configured → RAM wins, and the clamp is surfaced as a warning.
        // Cores are plentiful here so RAM is unambiguously the binding dimension.
        let d = memory_aware_concurrency(&w, Some(16 * GIB), Some(64));
        assert_eq!(d.effective, 6);
        let warn = d.warning.expect("a clamp must be diagnosable as a config warning");
        assert!(warn.contains("max_concurrent"), "warning names the key: {warn}");
        assert!(warn.contains("RAM"), "warning names the binding dimension: {warn}");

        // RAM allows MORE than configured → the config ceiling holds. The value is never raised,
        // but the user is now TOLD they are leaving capacity on the table (see
        // `a_pin_below_what_the_machine_can_run_is_diagnosable`) rather than throttled in silence.
        w.max_concurrent = Some(4);
        let d = memory_aware_concurrency(&w, Some(128 * GIB), Some(64));
        assert_eq!(d.effective, 4, "an explicit max_concurrent must never be raised by spare RAM");
        assert!(d.warning.expect("an under-pin is advisory, not silent").contains("pinned to 4"));
    }

    // THE regression this change exists to prevent: the old code could only ratchet DOWN from a
    // hardcoded 20, so every machine bigger than ~64 GiB was throttled to a number that fit a
    // smaller one. Auto must scale UP with the hardware.
    #[test]
    fn auto_scales_up_with_the_machine_instead_of_capping_at_a_fixed_number() {
        let w = WorkersConfig { max_concurrent: None, agent_heap_mb: 3072 };
        // 128 GiB − 6 = 124928 MiB ÷ 1536 = 81 by RAM; 24 cores × 6 = 144 by CPU. RAM binds → 81.
        // (Under the OLD heap-ceiling basis RAM derived 40; under the old 2-per-core multiplier CPU
        // derived 48 and bound instead. Both of those under-reported what the machine can hold.)
        let d = memory_aware_concurrency(&w, Some(128 * GIB), Some(24));
        assert_eq!((d.effective, d.bound), (81, Bound::Ram));
        assert!(d.warning.is_none());
        // The same machine under the OLD hardcoded ceiling would have been held to 20.
        assert!(d.effective > 20);
        // And it still scales DOWN: 16 GiB − 6 = 10240 ÷ 1536 = 6.
        assert_eq!(memory_aware_concurrency(&w, Some(16 * GIB), Some(24)).effective, 6);
        // Auto never warns — the user asked for "whatever fits" and got exactly that.
        assert!(memory_aware_concurrency(&w, Some(8 * GIB), Some(4)).warning.is_none());
    }

    #[test]
    fn cpu_cores_bound_concurrency_independently_of_ram() {
        let w = WorkersConfig { max_concurrent: None, agent_heap_mb: 3072 };
        // 192 GiB − 6 = 190464 MiB ÷ 1536 = 124 by RAM, but only 8 cores × 6 = 48 by CPU. CPU binds.
        let d = memory_aware_concurrency(&w, Some(192 * GIB), Some(8));
        assert_eq!((d.effective, d.bound), (48, Bound::Cpu));
        // Inverted: 64 cores × 6 = 384 by CPU, but 16 GiB holds only 6. RAM binds.
        let d = memory_aware_concurrency(&w, Some(16 * GIB), Some(64));
        assert_eq!((d.effective, d.bound), (6, Bound::Ram));
    }

    #[test]
    fn a_cpu_bound_clamp_names_cores_not_the_heap_size() {
        // Telling a user to "lower agent_heap_mb" when the limit is their CORE COUNT is useless
        // advice — the remedy must name the dimension that actually bound the value.
        let w = WorkersConfig { max_concurrent: Some(40), agent_heap_mb: 3072 };
        let d = memory_aware_concurrency(&w, Some(512 * GIB), Some(4));
        assert_eq!(d.effective, 24, "4 cores × 6 = 24, well under what 512 GiB could hold");
        let warn = d.warning.expect("a clamp must be diagnosable");
        assert!(warn.contains("CPU cores"), "names cores: {warn}");
        assert!(!warn.contains("agent_heap_mb"), "does not offer a RAM remedy: {warn}");
    }

    #[test]
    fn memory_aware_concurrency_no_ops_when_it_cannot_measure() {
        let w = WorkersConfig { max_concurrent: Some(20), agent_heap_mb: 3072 };
        // Unknown RAM *and* cores (unsupported platform / sysctl failure): fall back to the
        // configured value rather than guessing a number that could throttle a big machine. The
        // ceiling is then a CHOICE, not a hardware fact, and is reported as one.
        let d = memory_aware_concurrency(&w, None, None);
        assert_eq!((d.effective, d.bound), (20, Bound::Pinned));
        assert!(d.warning.is_none());
        // One dimension missing still constrains by the other — a measurement we DO have is not
        // discarded just because its partner is absent. Each still clamps (and warns) on its own.
        let d = memory_aware_concurrency(&w, Some(16 * GIB), None);
        assert_eq!(d.effective, 6, "RAM alone still bounds a pinned ceiling");
        assert!(d.warning.expect("clamping a pinned value is diagnosable").contains("RAM"));
        let d = memory_aware_concurrency(&w, None, Some(2));
        assert_eq!(d.effective, 12, "cores alone still bound a pinned ceiling");
        assert!(d.warning.expect("clamping a pinned value is diagnosable").contains("CPU cores"));
    }

    // BUG 2 of the ceiling audit: the `Bound` attribution existed but never reached the human. The
    // concierge's at-capacity refusal asserted "the ceiling is derived from installed RAM"
    // unconditionally — the exact mis-attribution `Bound` was written to prevent. It is now carried
    // as a ready-to-show sentence alongside the number it explains.
    #[test]
    fn the_basis_sentence_names_the_cpu_bound_on_a_core_bound_machine() {
        // A genuinely core-bound machine: 128 GiB but only 8 cores.
        // by_ram = 124928 ÷ 1536 = 81; by_cpu = 8 × 6 = 48. CPU binds.
        //
        // This fixture used to be the 18-core measured host, which WAS core-bound while
        // AGENTS_PER_CORE was 2. Raising that constant to 6 flipped it to RAM-bound, so the fixture
        // moved to a machine that is still core-bound rather than the assertion being relaxed —
        // the sentence under test is "does the CPU basis render correctly", and it needs a CPU
        // bound to render. The measured host's new behaviour is pinned separately, below.
        let w = WorkersConfig { max_concurrent: None, agent_heap_mb: 3072 };
        let d = memory_aware_concurrency(&w, Some(128 * GIB), Some(8));
        assert_eq!((d.effective, d.machine, d.bound), (48, 48, Bound::Cpu));
        assert_eq!(d.basis, "CPU-bound: 8 cores × 6 agents per core");
        assert!(!d.basis.contains("RAM"), "must not point at memory that is 94% free: {}", d.basis);
    }

    /// The measured host (18 logical cores, 128 GiB, 90% memory free, zero swap) after
    /// AGENTS_PER_CORE was raised 2 → 6 on 2026-07-29.
    ///
    /// Both dimensions moved for this machine and the ORDER matters: the per-agent RAM budget
    /// dropped from the 3072 MiB heap ceiling to a measured 1536 MiB (by_ram 40 → 81), and the core
    /// multiplier went 2 → 6 (by_cpu 36 → 108). The ceiling therefore rose 36 → 81 and the binding
    /// dimension flipped CPU → RAM. RAM binding is the intended end state: it is the dimension we
    /// actually measure per agent (1.11 GiB observed across 19 agents / 37 processes), whereas the
    /// core multiplier is a judgement call. If a later change makes CPU bind here again, that is a
    /// signal the multiplier was lowered — not that this test needs its number updated.
    #[test]
    fn the_measured_host_is_ram_bound_at_eighty_one_after_the_per_core_raise() {
        let w = WorkersConfig { max_concurrent: None, agent_heap_mb: 3072 };
        let d = memory_aware_concurrency(&w, Some(128 * GIB), Some(18));
        assert_eq!((d.effective, d.machine, d.bound), (81, 81, Bound::Ram));
        assert!(
            d.basis.starts_with("RAM-bound: 128 GiB installed − 6 GiB reserved, ÷ 1536 MiB"),
            "the arithmetic must be checkable by hand: {}",
            d.basis
        );
        assert!(d.warning.is_none(), "auto never warns — the user asked for whatever fits");
        // The regression that motivated the raise: 36 was the old ceiling on a machine with 90% of
        // its memory free. Whatever else changes, this must not fall back to a core-count answer.
        assert!(d.effective > 36, "must exceed the old core-bound ceiling");
    }

    #[test]
    fn the_basis_sentence_names_ram_with_checkable_arithmetic_when_ram_binds() {
        let w = WorkersConfig { max_concurrent: None, agent_heap_mb: 3072 };
        let d = memory_aware_concurrency(&w, Some(16 * GIB), Some(64));
        assert_eq!((d.effective, d.bound), (6, Bound::Ram));
        assert!(
            d.basis.starts_with("RAM-bound: 16 GiB installed − 6 GiB reserved, ÷ 1536 MiB"),
            "{}",
            d.basis
        );
        // The DIVISOR is the working-set budget, not the heap ceiling — dividing by 3072 is the ~6x
        // over-reserve. The ceiling may still be NAMED (it is where 1536 comes from, and the human
        // needs to be able to check the arithmetic); what it may not be is the number divided by.
        assert!(!d.basis.contains("÷ 3072"), "must not divide by the heap cap: {}", d.basis);
        assert!(d.basis.contains("half the 3072 MiB heap ceiling"), "shows its work: {}", d.basis);
        // 10240 MiB usable ÷ 1536 = 6, and the sentence must describe the number it ships with.
        assert_eq!(d.effective, (16 - 6) * 1024 / 1536);
    }

    // BUG 3: the app reported a ceiling of 32 while the machine derived 36 — the difference was a
    // PIN in config.toml, but the message blamed RAM. A pin must be reported AS a pin, naming the
    // file, and must still say what the machine could have done.
    #[test]
    fn a_pin_is_reported_as_a_pin_not_as_a_hardware_limit() {
        // The exact reported situation: pinned to 32 on an 18-core / 128 GiB machine. The machine's
        // own derivation was 36 when this bug was found; after the per-agent RAM basis and the
        // per-core raise it is 81. The pin is unchanged, which is the whole point — a pin does not
        // move with the hardware, and the gap it opens is now larger, not smaller.
        let w = WorkersConfig { max_concurrent: Some(32), agent_heap_mb: 3072 };
        let d = memory_aware_concurrency(&w, Some(128 * GIB), Some(18));
        assert_eq!(d.effective, 32, "the pin is what the app enforces");
        assert_eq!(d.machine, 81, "and the machine's own limit is still reported");
        assert_eq!(d.bound, Bound::Pinned);
        assert!(d.basis.contains("pinned to 32 in config.toml"), "names the real cause: {}", d.basis);
        assert!(d.basis.contains("81"), "says what the machine could run: {}", d.basis);
        assert!(
            !d.basis.starts_with("RAM-bound"),
            "a pin is never a RAM limit — this attribution sent a human chasing memory: {}",
            d.basis
        );
    }

    // roborev 53087 (High): the old default was written to disk for users who never chose it, and
    // under the new semantics that line is a PINNED CEILING — so the very machines this change
    // exists to unblock would have stayed at 20 forever, silently.
    /// Write a global config.toml into a temp app-data dir and return the dir.
    fn app_data_with(global: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(global_path(dir.path()), global).unwrap();
        dir
    }
    fn global_text(dir: &tempfile::TempDir) -> String {
        std::fs::read_to_string(global_path(dir.path())).unwrap()
    }

    #[test]
    fn a_config_still_carrying_the_legacy_default_migrates_to_auto() {
        let dir = app_data_with("[workers]\nmax_concurrent = 20\nagent_heap_mb = 3072\n");
        migrate_global(dir.path()).unwrap();
        let text = global_text(&dir);
        assert!(!text.contains("max_concurrent"), "the LINE is removed, not just the value: {text}");
        assert!(text.contains("agent_heap_mb = 3072"), "siblings untouched: {text}");
        // The negative case for the empty-stanza cleanup: [workers] still holds a key, so it stays.
        assert!(text.contains("[workers]"), "a still-populated table keeps its header: {text}");
        let (cfg, _, _) = effective(Some(&text), None);
        assert_eq!(cfg.workers.max_concurrent, None, "loads as AUTO");
        // And the point of it all: the machine's own limit now applies instead of a flat 20.
        let w = WorkersConfig { max_concurrent: cfg.workers.max_concurrent, agent_heap_mb: 3072 };
        let d = memory_aware_concurrency(&w, Some(128 * GIB), Some(24));
        assert_eq!(d.effective, 81);
        assert!(d.warning.is_none());
    }

    // roborev 53140 (High): migrating on every load is a standing rewrite, not a migration — it
    // would make 20 permanently unsettable and desync the ⋯-menu slider from the value in force.
    // Both TOML shapes must migrate. An inline `workers = { ... }` is the one `unset_dotted` cannot
    // touch (its traversal demands a real Table), so routing through it would strand that user at
    // the legacy 20 forever — and the empty container must go in either shape.
    #[test]
    fn the_migration_handles_both_the_header_and_inline_table_shapes() {
        for src in ["[workers]\nmax_concurrent = 20\n", "workers = { max_concurrent = 20 }\n"] {
            let dir = app_data_with(src);
            migrate_global(dir.path()).unwrap();
            let text = global_text(&dir);
            // Assert on STRUCTURE, not substrings: `!contains("workers = {")` would miss
            // `workers={` and would false-fire on an unrelated `default_workers = { … }`.
            let doc = text.parse::<toml_edit::DocumentMut>().expect("still valid TOML");
            assert!(doc.get("workers").is_none(), "the emptied container goes ({src:?}): {text}");
            let (cfg, _, _) = effective(Some(&text), None);
            assert_eq!(cfg.workers.max_concurrent, None, "loads as AUTO ({src:?})");
        }
    }

    #[test]
    fn an_inline_workers_table_keeps_its_other_keys() {
        let dir = app_data_with("workers = { max_concurrent = 20, agent_heap_mb = 2048 }\n");
        migrate_global(dir.path()).unwrap();
        let text = global_text(&dir);
        let doc = text.parse::<toml_edit::DocumentMut>().expect("still valid TOML");
        let workers = doc.get("workers").and_then(|w| w.as_table_like()).expect("container kept");
        assert!(workers.get("max_concurrent").is_none(), "the legacy key goes: {text}");
        assert!(workers.get("agent_heap_mb").is_some(), "its siblings stay: {text}");
        let (cfg, _, _) = effective(Some(&text), None);
        // The user-visible outcome the migration exists to produce.
        assert_eq!(cfg.workers.max_concurrent, None, "loads as AUTO");
        assert_eq!(cfg.workers.agent_heap_mb, 2048);
    }

    // The same class of bug the `workers` handling fixes, one step later: `set_dotted` demands a
    // real Table, so an inline `meta = { … }` would have deferred the migration forever.
    #[test]
    fn a_pre_existing_inline_meta_table_still_migrates() {
        let dir = app_data_with("meta = { note = \"hi\" }\n[workers]\nmax_concurrent = 20\n");
        migrate_global(dir.path()).unwrap();
        let text = global_text(&dir);
        let doc = text.parse::<toml_edit::DocumentMut>().expect("still valid TOML");
        let meta = doc.get("meta").and_then(|m| m.as_table_like()).expect("meta kept");
        assert_eq!(
            meta.get("config_version").and_then(|v| v.as_value()).and_then(|v| v.as_integer()),
            Some(CONFIG_MIGRATION_VERSION),
            "the marker is written into the existing inline table: {text}"
        );
        assert!(meta.get("note").is_some(), "its existing keys survive: {text}");
        let (cfg, _, _) = effective(Some(&text), None);
        assert_eq!(cfg.workers.max_concurrent, None, "and the migration actually ran");
    }

    #[test]
    fn the_dotted_key_form_migrates_because_it_is_a_table() {
        // `workers.max_concurrent = 20` in dotted-key form: toml_edit represents it as a Table, so
        // the reader and the writer agree on it and it MIGRATES rather than defers.
        let dir = app_data_with("workers.max_concurrent = 20\n");
        migrate_global(dir.path()).unwrap();
        let (cfg, _, _) = effective(Some(&global_text(&dir)), None);
        assert_eq!(cfg.workers.max_concurrent, None, "dotted-key form migrates: it is a table");
    }

    // THE invariant this whole round exists to establish: when the migration cannot apply, it must
    // leave the file completely alone — in particular it must NOT stamp `config_version`, because a
    // config marked "migrated" that never was is permanently un-migratable and silent about it.
    // `meta` is the reachable branch: `PartialConfig` has no `meta` field and does not deny unknown
    // ones, so a non-table `meta` loads fine and is a config a user can really have.
    #[test]
    fn a_deferred_migration_writes_nothing_at_all() {
        let src = "meta = \"hi\"\n[workers]\nmax_concurrent = 20\n";
        let dir = app_data_with(src);
        let err = migrate_global(dir.path()).expect_err("a shape the writer cannot edit defers");
        assert!(err.contains("meta"), "the reason names the offending table: {err}");
        assert_eq!(
            global_text(&dir),
            src,
            "nothing is written — not the key removal, and above all not the version marker"
        );
        // The deferral is not permanent. REPAIR the offending shape rather than replacing the file
        // (replacing it would just re-run a fixture another test already covers), so this pins the
        // thing that matters: the same config, with only `meta` corrected, now migrates AND stamps.
        std::fs::write(global_path(dir.path()), "[meta]\n[workers]\nmax_concurrent = 20\n").unwrap();
        migrate_global(dir.path()).unwrap();
        let text = global_text(&dir);
        let (cfg, _, _) = effective(Some(&text), None);
        assert_eq!(cfg.workers.max_concurrent, None, "the repaired file migrates");
        let doc = text.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(
            doc.get("meta")
                .and_then(|m| m.get("config_version"))
                .and_then(|v| v.as_integer()),
            Some(CONFIG_MIGRATION_VERSION),
            "and is stamped, so it won't be migrated again: {text}"
        );
    }

    #[test]
    fn the_migration_runs_at_most_once_so_a_later_20_is_the_users_to_keep() {
        let dir = app_data_with("[workers]\nmax_concurrent = 20\n");
        migrate_global(dir.path()).unwrap();
        let migrated = global_text(&dir);
        assert!(!migrated.contains("max_concurrent"));
        assert!(!migrated.contains("[workers]"), "the empty stanza goes too: {migrated}");
        assert!(
            migrated.contains("one-time config migrations"),
            "the generated [meta] explains itself, so a tidying user doesn't delete it: {migrated}"
        );

        // The user now DELIBERATELY picks 20 — exactly the value the migration removes.
        set_value(dir.path(), "workers.max_concurrent", &serde_json::json!(20)).unwrap();
        // Every subsequent launch re-runs migrations. This one must not fire again.
        migrate_global(dir.path()).unwrap();
        migrate_global(dir.path()).unwrap();
        let text = global_text(&dir);
        assert!(text.contains("max_concurrent = 20"), "a chosen 20 survives forever: {text}");
        let (cfg, _, _) = effective(Some(&text), None);
        assert_eq!(cfg.workers.max_concurrent, Some(20));
    }

    #[test]
    fn a_deliberately_chosen_value_is_never_migrated() {
        // Any number that is NOT the old default is a real choice, at both layers.
        for pinned in [1u32, 4, 19, 21, 32, 40] {
            let dir = app_data_with(&format!("[workers]\nmax_concurrent = {pinned}\n"));
            migrate_global(dir.path()).unwrap();
            let (cfg, _, _) = effective(Some(&global_text(&dir)), None);
            assert_eq!(cfg.workers.max_concurrent, Some(pinned), "kept {pinned}");
        }
    }

    // ---- v2: the retired stop word ------------------------------------------------------------
    //
    // roborev 55507 (High). The UPGRADE path is the whole point of these: renaming the displayed
    // stop word to "Sparkle, pause" only reached FRESH installs. `[voice]` is uncommented in
    // DEFAULT_TEMPLATE and `load_document` falls back to that template, so the first `set_value` on
    // an install with no config file stamps the WHOLE template — including the `stop_word` line of
    // the day. From PR #375 until the rename, that line read "Sparkle, stop". `hydrateFromConfig`
    // cannot tell a stamped default from a deliberate choice, so every one of those installs keeps
    // displaying the retired phrase forever, in the composer placeholder, the waveform caption and
    // the Voice-controls field.
    //
    // A fresh-install test cannot see any of this — which is exactly how it shipped. Each test here
    // therefore starts from a config file that ALREADY CARRIES the old value.

    #[test]
    fn a_config_carrying_the_retired_stop_word_migrates_to_the_new_default() {
        // The shape a real upgrading install has: the whole [voice] stanza as the template stamped
        // it, and `config_version = 1` because the v1 migration already ran here.
        let dir = app_data_with(
            "[voice]\n\
             wake_word = \"Hey Sparkle\"\n\
             stop_word = \"Sparkle, stop\"\n\
             pause_on_submit = true\n\
             \n[meta]\nconfig_version = 1\n",
        );
        migrate_global(dir.path()).unwrap();
        let text = global_text(&dir);

        // The LINE goes, not just the value — the next load must see no key at all, so the Rust
        // default supplies the new phrase.
        let doc = text.parse::<toml_edit::DocumentMut>().expect("still valid TOML");
        let voice = doc.get("voice").and_then(|v| v.as_table_like()).expect("[voice] kept");
        assert!(voice.get("stop_word").is_none(), "the retired key is removed: {text}");
        assert!(voice.get("wake_word").is_some(), "its siblings stay: {text}");
        assert!(voice.get("pause_on_submit").is_some(), "its siblings stay: {text}");

        // THE user-visible outcome this migration exists to produce. Asserting the parsed config —
        // not the file text — is what makes this the side effect rather than the precondition:
        // it is the exact value `hydrateFromConfig` reads and every caption renders.
        let (cfg, _, _) = effective(Some(&text), None);
        assert_eq!(
            cfg.voice.stop_word, "Sparkle, pause",
            "the upgraded install now displays the CURRENT phrase, not the retired one"
        );
    }

    // roborev 55804 (High): EVERY VERSION BUMP RE-ARMED EVERY EARLIER MIGRATION. The gate
    // `if applied >= CONFIG_MIGRATION_VERSION` guards the whole function body, so raising the
    // constant to 2 put every install sitting at `config_version = 1` — precisely the population
    // an upgrade touches — back through the v1 block. A user migrated by v1 who then DELIBERATELY
    // re-pinned `max_concurrent = 20` (a real choice; 20 was the old default and the ⋯ Advanced
    // editor can produce it) had that line silently deleted again, breaking the guarantee v1's own
    // doc comment makes: "a 20 the user sets later survives, because by then the recorded revision
    // has moved past this migration."
    //
    // Nothing existing could catch it: every other migration test starts from a config with no
    // `[meta]` (or from `reset`, which stamps the current max), so the `applied == 1` path was
    // never exercised, and the v2 tests fixture `config_version = 1` with no `[workers]` key.
    #[test]
    fn a_version_bump_does_not_re_arm_an_already_applied_migration() {
        // The exact shape of an upgrading install: v1 already ran, the user then chose 20 back,
        // and the retired stop word is still on disk waiting for v2.
        let dir = app_data_with(
            "[workers]\nmax_concurrent = 20\n\
             \n[voice]\nstop_word = \"Sparkle, stop\"\n\
             \n[meta]\nconfig_version = 1\n",
        );
        migrate_global(dir.path()).unwrap();
        let text = global_text(&dir);
        let (cfg, _, _) = effective(Some(&text), None);

        // v2 must run…
        assert_eq!(
            cfg.voice.stop_word, "Sparkle, pause",
            "the pending v2 migration still applies: {text}"
        );
        // …and v1 must NOT run again. This is the assertion that fails without per-migration
        // gating: the user's deliberate 20 is silently reverted to auto.
        assert_eq!(
            cfg.workers.max_concurrent,
            Some(20),
            "an ALREADY-APPLIED migration must not re-run and eat a later choice: {text}"
        );
        assert!(text.contains("max_concurrent = 20"), "the line itself survives: {text}");
    }

    #[test]
    fn a_deliberately_chosen_stop_word_survives_the_migration() {
        // The counterpart risk: this migration must never eat a phrase someone actually picked.
        // "Sparkle, pause" is in the list on purpose — a user who typed the new default by hand
        // keeps a real (if redundant) line, and removing it would still be correct behaviour, so
        // the assertion below is on the EFFECTIVE value rather than the file text.
        for chosen in ["Jarvis, halt", "Computer, enough", "Sparkle, pause", "stop"] {
            let dir = app_data_with(&format!(
                "[voice]\nstop_word = \"{chosen}\"\n\n[meta]\nconfig_version = 1\n"
            ));
            migrate_global(dir.path()).unwrap();
            let (cfg, _, _) = effective(Some(&global_text(&dir)), None);
            assert_eq!(cfg.voice.stop_word, chosen, "kept {chosen:?}");
        }
    }

    #[test]
    fn the_stop_word_migration_runs_at_most_once_so_a_later_choice_is_the_users_to_keep() {
        let dir = app_data_with(
            "[voice]\nstop_word = \"Sparkle, stop\"\n\n[meta]\nconfig_version = 1\n",
        );
        migrate_global(dir.path()).unwrap();

        // The user now DELIBERATELY types the retired phrase back — they liked it, or they are on
        // a team that still says it. Every later launch re-runs migrations; this must not fire
        // again, or the phrase becomes permanently unsettable.
        set_value(dir.path(), "voice.stop_word", &serde_json::json!("Sparkle, stop")).unwrap();
        migrate_global(dir.path()).unwrap();
        migrate_global(dir.path()).unwrap();

        let (cfg, _, _) = effective(Some(&global_text(&dir)), None);
        assert_eq!(cfg.voice.stop_word, "Sparkle, stop", "a chosen phrase survives forever");
    }

    #[test]
    fn an_emptied_voice_stanza_is_removed_and_an_inline_one_migrates_too() {
        // Mirrors the `workers` handling: a stanza whose only key we removed is clutter in the
        // Advanced editor, and the inline shape is the one a dotted-key traversal cannot touch —
        // routing through that would strand an inline-table user on the retired phrase forever.
        for src in [
            "[voice]\nstop_word = \"Sparkle, stop\"\n\n[meta]\nconfig_version = 1\n",
            "voice = { stop_word = \"Sparkle, stop\" }\n\n[meta]\nconfig_version = 1\n",
        ] {
            let dir = app_data_with(src);
            migrate_global(dir.path()).unwrap();
            let text = global_text(&dir);
            let doc = text.parse::<toml_edit::DocumentMut>().expect("still valid TOML");
            assert!(doc.get("voice").is_none(), "the emptied container goes ({src:?}): {text}");
            let (cfg, _, _) = effective(Some(&text), None);
            assert_eq!(cfg.voice.stop_word, "Sparkle, pause", "and the phrase updates ({src:?})");
        }
    }

    #[test]
    fn a_project_level_stop_word_is_never_touched_by_the_migration() {
        // Same rationale as the `workers` case: "the app wrote this, the user never chose it" is
        // only ever true of the GLOBAL file. A per-project override is always deliberate.
        let dir = app_data_with(
            "[voice]\nstop_word = \"Sparkle, stop\"\n\n[meta]\nconfig_version = 1\n",
        );
        let project = dir.path().join("some-repo");
        std::fs::create_dir_all(project.join(".sparkle")).unwrap();
        let project_file = project.join(".sparkle").join("config.toml");
        let original = "[voice]\nstop_word = \"Sparkle, stop\"\n";
        std::fs::write(&project_file, original).unwrap();

        migrate_global(dir.path()).unwrap();

        assert_eq!(std::fs::read_to_string(&project_file).unwrap(), original, "project untouched");
        assert!(!global_text(&dir).contains("Sparkle, stop"), "global migrated");
    }

    // roborev 53140 (Medium): `validate` sees the MERGED config, so migrating there also erased a
    // per-project override — where "the app wrote it, not the user" was never true. roborev 53240
    // (Low) correctly called the first version of this test vacuous: it never ran the migration.
    // This one writes a real project file and asserts its BYTES survive.
    #[test]
    fn a_project_level_20_is_never_touched_by_the_migration() {
        let dir = app_data_with("[workers]\nmax_concurrent = 20\n");
        let project = dir.path().join("some-repo");
        std::fs::create_dir_all(project.join(".sparkle")).unwrap();
        let project_file = project.join(".sparkle").join("config.toml");
        let original = "[workers]\nmax_concurrent = 20\n";
        std::fs::write(&project_file, original).unwrap();

        migrate_global(dir.path()).unwrap();

        assert_eq!(std::fs::read_to_string(&project_file).unwrap(), original, "project untouched");
        assert!(!global_text(&dir).contains("max_concurrent"), "global migrated");
    }

    // roborev 53240 (High): `load_document` falls back to DEFAULT_TEMPLATE on a parse error. Using
    // it here would stamp the template over a config the user merely typo'd and write it — wiping
    // every setting AND the broken text they need in order to fix it, silently.
    #[test]
    fn an_unparseable_config_survives_the_migration_byte_for_byte() {
        let broken = "[workers\nmax_concurrent = 20\nthis is not toml";
        let dir = app_data_with(broken);
        let err = migrate_global(dir.path()).expect_err("a broken file defers, it does not clobber");
        assert!(err.contains("not valid TOML"), "the reason is diagnosable: {err}");
        assert_eq!(global_text(&dir), broken, "the user's file is untouched");
    }

    // roborev 53240 (Medium): the one-time guarantee is only as durable as the marker, and `reset`
    // writes DEFAULT_TEMPLATE — so a template without [meta] would rewind the version to 0 and
    // re-arm every migration, breaking the "a later 20 is yours" promise after any reset.
    #[test]
    fn the_default_template_carries_the_current_migration_version() {
        let doc = DEFAULT_TEMPLATE.parse::<toml_edit::DocumentMut>().unwrap();
        let v = doc
            .get("meta")
            .and_then(|m| m.get("config_version"))
            .and_then(|v| v.as_integer())
            .expect("the template must record the schema revision it ships at");
        assert_eq!(
            v, CONFIG_MIGRATION_VERSION,
            "template and CONFIG_MIGRATION_VERSION drifted — bump the template when adding a migration"
        );
    }

    #[test]
    fn a_reset_does_not_re_arm_the_migration() {
        let dir = app_data_with("[workers]\nmax_concurrent = 4\n");
        reset(dir.path()).unwrap();
        // After a reset the user deliberately pins the one value the migration would remove.
        set_value(dir.path(), "workers.max_concurrent", &serde_json::json!(20)).unwrap();
        migrate_global(dir.path()).unwrap();
        assert!(
            global_text(&dir).contains("max_concurrent = 20"),
            "a reset must not rewind the marker and re-delete a chosen value"
        );
    }

    #[test]
    fn migration_does_not_create_a_config_file_that_did_not_exist() {
        // A fresh install already defaults to auto; writing a file the user never asked for would
        // be a side effect, not a migration.
        let dir = tempfile::tempdir().unwrap();
        migrate_global(dir.path()).unwrap();
        assert!(!global_path(dir.path()).exists());
    }

    // A pin that costs the user capacity must SAY so. The clamp warning only ever fires the other
    // way, so without this a ceiling set on older hardware throttles the machine in total silence.
    #[test]
    fn a_pin_below_what_the_machine_can_run_is_diagnosable() {
        let w = WorkersConfig { max_concurrent: Some(8), agent_heap_mb: 3072 };
        // 128 GiB → 81 by RAM, 24 cores → 144 by CPU; auto is 81, well above the pin of 8.
        let d = memory_aware_concurrency(&w, Some(128 * GIB), Some(24));
        assert_eq!(d.effective, 8, "the pin still holds — this is a notice, not an override");
        let warn = d.warning.expect("a pin that costs capacity must be visible");
        assert!(warn.contains("pinned to 8"), "names the pin: {warn}");
        assert!(warn.contains("81"), "names what the machine could do: {warn}");

        // A pin that exactly matches the machine has nothing to report.
        let w = WorkersConfig { max_concurrent: Some(81), agent_heap_mb: 3072 };
        let d = memory_aware_concurrency(&w, Some(128 * GIB), Some(24));
        assert_eq!((d.effective, d.machine), (81, 81));
        assert!(d.warning.is_none());
    }

    // roborev 53087 (Medium): attribution by value-comparison mis-reads a TIE, and routing a tie to
    // the RAM branch offers "Lower agent_heap_mb" — advice that cannot work, because raising by_ram
    // leaves min() unchanged while cores bind equally.
    #[test]
    fn a_tie_between_ram_and_cores_offers_neither_single_dimension_remedy() {
        // 4 cores → 24 by CPU; 42 GiB − 6 = 36864 MiB ÷ 1536 = 24 by RAM. Both bind at 24.
        // (Re-tuned when AGENTS_PER_CORE went 2 → 6: the old 8-core/30 GiB fixture tied at 16 under
        // the 2× multiplier and stopped being a tie under 6×. A tie test needs an actual tie.)
        let w = WorkersConfig { max_concurrent: Some(40), agent_heap_mb: 3072 };
        let d = memory_aware_concurrency(&w, Some(42 * GIB), Some(4));
        assert_eq!((d.effective, d.bound), (24, Bound::Both));
        let warn = d.warning.expect("a clamp must be diagnosable");
        assert!(
            warn.contains("raising either one alone changes nothing"),
            "a tie says neither remedy suffices: {warn}"
        );
        assert!(!warn.contains("Lower agent_heap_mb"), "impossible remedy on a tie: {warn}");
        // The user-facing sentence says the same thing rather than picking a side.
        assert!(d.basis.contains("CPU-bound") && d.basis.contains("RAM-bound"), "{}", d.basis);
    }

    #[test]
    fn the_binding_dimension_is_reported_by_the_derivation_not_guessed_from_it() {
        let w = WorkersConfig { max_concurrent: None, agent_heap_mb: 3072 };
        // RAM 81 vs CPU 144 → RAM binds.
        assert_eq!(auto_concurrency_bound(&w, Some(128 * GIB), Some(24)), Some((81, Bound::Ram)));
        // RAM 124 vs CPU 48 → CPU binds.
        assert_eq!(auto_concurrency_bound(&w, Some(192 * GIB), Some(8)), Some((48, Bound::Cpu)));
        // Equal → neither alone.
        assert_eq!(auto_concurrency_bound(&w, Some(42 * GIB), Some(4)), Some((24, Bound::Both)));
        // A dimension we cannot measure is attributed to the one we can.
        assert_eq!(auto_concurrency_bound(&w, Some(16 * GIB), None), Some((6, Bound::Ram)));
        assert_eq!(auto_concurrency_bound(&w, None, Some(2)), Some((12, Bound::Cpu)));
        assert_eq!(auto_concurrency_bound(&w, None, None), None);
    }

    #[test]
    fn auto_on_an_unmeasurable_machine_degrades_to_one_agent() {
        // Auto with NOTHING measurable: one agent always works. Inventing a number for hardware we
        // know nothing about is how a small machine gets jetsam-killed.
        let w = WorkersConfig { max_concurrent: None, agent_heap_mb: 3072 };
        let d = memory_aware_concurrency(&w, None, None);
        assert_eq!((d.effective, d.machine, d.bound), (1, 1, Bound::Unknown));
        assert!(d.warning.is_none());
        // Even here the reason is stated rather than blamed on a dimension we never read.
        assert!(d.basis.contains("no measurable"), "{}", d.basis);
    }

    #[test]
    fn opting_out_of_the_heap_cap_still_bounds_concurrency_by_ram() {
        // roborev 40088: the two protections must not be coupled. A user who sets agent_heap_mb = 0
        // to let agents use bigger heaps would otherwise ALSO lose the RAM-derived concurrency
        // clamp — restoring the exact 20-agents × uncapped-heap runaway this whole change exists to
        // prevent. With no cap, agents use V8's own default, so that's the budget we divide by.
        let w = WorkersConfig { max_concurrent: Some(20), agent_heap_mb: 0 };
        // 16 GiB − 6 GiB reserve = 10240 MiB ÷ 2048 (half V8's ~4 GiB default) = 5.
        let d = memory_aware_concurrency(&w, Some(16 * GIB), Some(64));
        assert_eq!(d.effective, 5);
        let warn = d.warning.expect("the clamp must still be diagnosable when the cap is opted out");
        // The remedy must be actionable: "lower agent_heap_mb" is impossible at 0, which maps to
        // the LARGEST per-agent budget. The way out is a positive value (roborev 40311).
        assert!(warn.contains("Set a positive agent_heap_mb"), "actionable remedy: {warn}");
        assert!(!warn.contains("Lower agent_heap_mb"), "impossible remedy: {warn}");
        // And the configured ceiling still wins when RAM is plentiful (with the advisory that the
        // machine could do more — the pin is honored, not overridden).
        let w = WorkersConfig { max_concurrent: Some(4), agent_heap_mb: 0 };
        let d = memory_aware_concurrency(&w, Some(128 * GIB), Some(64));
        assert_eq!(d.effective, 4);
        assert!(d.warning.expect("an under-pin is advisory").contains("pinned to 4"));
    }

    // "Lower agent_heap_mb" stops being true once the ceiling drops to the measured working set —
    // below that the budget floors and the knob has no effect. Advice that has silently stopped
    // working is the same failure class as attributing a core limit to RAM.
    #[test]
    fn the_ram_remedy_states_where_lowering_the_heap_cap_stops_helping() {
        let w = WorkersConfig { max_concurrent: Some(40), agent_heap_mb: 3072 };
        let warn = memory_aware_concurrency(&w, Some(16 * GIB), Some(64)).warning.unwrap();
        assert!(warn.contains("down to about 2304"), "bounds the advice: {warn}");
        // At/below the floor the advice is withdrawn rather than repeated.
        let w = WorkersConfig { max_concurrent: Some(40), agent_heap_mb: 1024 };
        let warn = memory_aware_concurrency(&w, Some(16 * GIB), Some(64)).warning.unwrap();
        assert!(!warn.contains("Lower agent_heap_mb"), "knob no longer moves the number: {warn}");
        assert!(warn.contains("already at the measured per-agent working set"), "{warn}");
    }

    #[test]
    fn effective_config_exposes_the_derived_concurrency() {
        // The frontend concurrency gate reads this field, so it must be populated (and never 0)
        // on a plain default construction. The default is AUTO, so there is no configured ceiling
        // to compare against — the guarantee is simply that a real machine gets a usable number.
        let eff = EffectiveConfig::derive(SparkleConfig::default(), Vec::new());
        assert!(eff.effective_max_concurrent >= 1);
        assert_eq!(eff.config.workers.max_concurrent, None, "ships as auto, not a fixed number");
        // The provenance travels with the number, so the UI never has to guess it (and never has to
        // assert "derived from installed RAM" on a machine whose cores are the limit).
        assert_eq!(eff.machine_max_concurrent, eff.effective_max_concurrent, "auto has no pin");
        assert!(!eff.concurrency_basis.is_empty(), "the number always comes with its reason");
        assert_ne!(eff.concurrency_bound, Bound::Pinned, "auto is never a pin");
    }

    #[test]
    fn a_pinned_ceiling_still_bounds_the_effective_value() {
        let mut cfg = SparkleConfig::default();
        cfg.workers.max_concurrent = Some(2);
        // Inject a machine that can carry far more than 2 (128 GiB, 64 cores) so the pin is the
        // binding constraint. Reading the real host here made this flaky: a 7 GiB CI runner holds
        // only one agent, so its honest bound is `Ram`, not `Pinned` — a true answer for that box
        // but not the wiring this test means to exercise (that `derive` surfaces `Pinned` and
        // clamps when a pin binds below machine capacity).
        let eff = EffectiveConfig::derive_measured(cfg, Vec::new(), Some(128 * GIB), Some(64));
        assert!(eff.effective_max_concurrent <= 2, "a pinned ceiling is never exceeded");
        assert!(eff.effective_max_concurrent >= 1);
        // Machine INJECTED above (derive_measured), so every output here is DETERMINISTIC and the
        // assertions are exact rather than environment-tolerant (roborev 55070): `<= 2` / `>= 1`
        // would still pass if a regression clamped a pinned 2 down to 1, and a bare `>=` on the
        // machine value would pass if it reported anything above 2.
        assert_eq!(eff.effective_max_concurrent, 2, "the pin is what gets enforced");
        // 2 is below what this machine derives, so this must read as a pin — not as RAM.
        assert_eq!(eff.concurrency_bound, Bound::Pinned);
        // 128 GiB − 6 reserved = 124928 MiB ÷ 1536 = 81; 64 cores × 6 = 384. RAM binds at 81, which
        // is what the machine's own limit must report alongside the pin.
        assert_eq!(eff.machine_max_concurrent, 81, "the machine's own limit is reported too");
    }

    /// The `auto == configured` TIE, which had no assertion anywhere (roborev 55070).
    ///
    /// A comment in the test above once claimed the neighbouring `memory_aware_concurrency` tests
    /// covered it. They did not: the only two that assert `Bound::Pinned` exercise the
    /// unmeasurable-hardware branch and the strict `auto > configured` branch. This path — pin
    /// exactly equal to what the machine derives — has its own basis string and, unlike a clamped
    /// pin, emits NO warning, because nothing is being taken away from the user. Writing the claim
    /// without the test was the same "asserts behavior the code lacks" defect this branch has now
    /// hit three times, so the test is added rather than the claim deleted.
    #[test]
    fn a_pin_equal_to_the_machines_own_limit_is_still_reported_as_a_pin() {
        // 128 GiB / 64 cores derives 81 (RAM-bound); pin exactly 81 so the two tie.
        let w = WorkersConfig { max_concurrent: Some(81), agent_heap_mb: 3072 };
        let d = memory_aware_concurrency(&w, Some(128 * GIB), Some(64));
        assert_eq!((d.effective, d.machine, d.bound), (81, 81, Bound::Pinned));
        // A tie costs the user nothing, so there is nothing to warn about.
        assert!(d.warning.is_none(), "a pin that matches the machine takes nothing away");
        // …and the sentence says so, rather than implying a hardware limit.
        assert!(
            d.basis.contains("exactly what this machine can run"),
            "the tie has its own basis string: {}",
            d.basis
        );
    }

    // The frontend reads `concurrency_bound` as a lowercase string discriminant; a rename here
    // silently breaks the copy that branches on it.
    #[test]
    fn the_bound_serializes_as_the_lowercase_discriminant_the_frontend_reads() {
        for (b, s) in [
            (Bound::Cpu, "\"cpu\""),
            (Bound::Ram, "\"ram\""),
            (Bound::Both, "\"both\""),
            (Bound::Pinned, "\"pinned\""),
            // The two memory bounds carry the "refused: memory pressure" copy, so they are the ones
            // whose renaming would most visibly break a refusal — and they were the ones this
            // hardcoded table forgot when they were added (roborev 55384). The frontend branches on
            // these exact strings in services/config.ts's `ConcurrencyBound` union.
            (Bound::Available, "\"available\""),
            (Bound::Pressure, "\"pressure\""),
            (Bound::Unknown, "\"unknown\""),
        ] {
            assert_eq!(serde_json::to_string(&b).unwrap(), s);
        }
    }

    /// The wire string for each `Bound`, as an EXHAUSTIVE match with no wildcard arm.
    ///
    /// This is the enforcement mechanism, and the compiler is the thing doing the enforcing: adding a
    /// variant to `Bound` makes this function fail to COMPILE until its wire string is declared here.
    ///
    /// The first attempt at this guard (roborev 55425) was a hand-written array plus
    /// `assert_eq!(all.len(), 7)`. That is a compile-time tautology — a new variant changes neither
    /// the literal nor its length, so the test stayed green while the variant went unpinned, which is
    /// precisely how `Available`/`Pressure` were missed in the first place. It was the repo's #1
    /// defect shape (an assertion already true before the change) written *while fixing* an instance
    /// of it. Recorded rather than quietly deleted, because the seductive part is that it reads like
    /// a real check.
    fn bound_wire_string(b: Bound) -> &'static str {
        match b {
            Bound::Cpu => "\"cpu\"",
            Bound::Ram => "\"ram\"",
            Bound::Both => "\"both\"",
            Bound::Pinned => "\"pinned\"",
            Bound::Available => "\"available\"",
            Bound::Pressure => "\"pressure\"",
            Bound::Unknown => "\"unknown\"",
        }
    }

    /// Every variant serializes to the string `bound_wire_string` declares, and all of them are
    /// distinct and lowercase. Exhaustiveness is guaranteed by the compiler, not by this test.
    #[test]
    fn every_bound_variant_is_covered_by_the_serialization_table() {
        // ALL_BOUNDS is checked against the match above by construction: if a variant were missing
        // here, `bound_wire_string` would still compile — so the real guard is that adding a variant
        // breaks `bound_wire_string`, and whoever fixes that lands here next.
        const ALL_BOUNDS: [Bound; 7] = [
            Bound::Cpu,
            Bound::Ram,
            Bound::Both,
            Bound::Pinned,
            Bound::Available,
            Bound::Pressure,
            Bound::Unknown,
        ];
        let mut seen = std::collections::HashSet::new();
        for b in ALL_BOUNDS {
            let s = serde_json::to_string(&b).unwrap();
            assert_eq!(s, bound_wire_string(b), "{b:?} serializes to an undeclared string");
            assert_eq!(s, s.to_lowercase(), "{s} is not lowercase");
            assert!(seen.insert(s.clone()), "{s} is a duplicate discriminant");
        }
        assert_eq!(seen.len(), ALL_BOUNDS.len());
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
        assert_eq!(cfg.voice.stop_word, "Sparkle, pause");
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
        assert_eq!(cfg.voice.stop_word, "Sparkle, pause");
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
    fn approvals_default_ships_on_for_every_category() {
        // A fresh install auto-approves EVERY category out of the box — including bash — so an
        // agent is never blocked mid-run by a permission prompt with nobody watching. Opting back
        // out is a per-category `"never"` (or the [ai].auto_approve master switch).
        let (cfg, _, _) = effective(None, None);
        assert_eq!(cfg.approvals, ApprovalsConfig::default());
        assert_eq!(cfg.approvals.skill.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.edit.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.mcp.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.fetch.as_deref(), Some("always"));
        assert_eq!(cfg.approvals.other.as_deref(), Some("always"));
        assert_eq!(
            cfg.approvals.bash.as_deref(),
            Some("always"),
            "bash ships auto-approve ON; opt out with bash = \"never\""
        );
    }

    #[test]
    fn approvals_bash_can_be_opted_back_out() {
        // The escape hatch for the new default: an explicit "never" must beat it, at either layer.
        let (cfg, _, _) = effective(Some("[approvals]\nbash = \"never\"\n"), None);
        assert_eq!(cfg.approvals.bash.as_deref(), Some("never"), "global opt-out wins");
        let (cfg, _, _) = effective(None, Some("[approvals]\nbash = \"never\"\n"));
        assert_eq!(cfg.approvals.bash.as_deref(), Some("never"), "project opt-out wins");
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
        // The sibling `resume` key defaults to "ask" and is untouched by writing only bash.
        assert_eq!(cfg.approvals.resume.as_deref(), Some("ask"));
    }

    // --- [concierge.tools] — the concierge's per-tool autonomy policy ------------------------

    #[test]
    fn concierge_tools_default_to_an_empty_table() {
        // Empty is not "no policy" — every tool sits on the default DERIVED from its risk class in
        // policy.ts. The file only ever carries rules the human changed, which is why a missing key
        // can never be a policy hole.
        let (cfg, warns, _) = effective(None, None);
        assert!(cfg.concierge.tools.is_empty());
        assert!(!warns.iter().any(|w| w.contains("[concierge")));
    }

    #[test]
    fn concierge_tools_reads_each_key_verbatim() {
        let g = "[concierge.tools]\nmerge_pr = \"deny\"\npush_agent_branch = \"allow\"\n\
                 list_projects = \"ask\"\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert_eq!(cfg.concierge.tools.get("merge_pr").map(String::as_str), Some("deny"));
        assert_eq!(cfg.concierge.tools.get("push_agent_branch").map(String::as_str), Some("allow"));
        assert_eq!(cfg.concierge.tools.get("list_projects").map(String::as_str), Some("ask"));
        // A tool nobody mentioned is simply absent — the frontend resolves it from its risk class.
        assert!(cfg.concierge.tools.get("quit_app").is_none());
        assert!(warns.is_empty(), "three valid rules produce no warnings: {warns:?}");
    }

    #[test]
    fn concierge_tools_accepts_a_name_this_backend_has_never_heard_of() {
        // Rust is deliberately schema-agnostic about tool NAMES: the authoritative list lives in the
        // TypeScript domain modules, where an unclassified op is a typecheck failure. A second copy
        // here would drift, and a desktop binary older than a tool would reject that tool's rule.
        let g = "[concierge.tools]\nsome_future_tool = \"deny\"\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert_eq!(cfg.concierge.tools.get("some_future_tool").map(String::as_str), Some("deny"));
        assert!(warns.is_empty(), "an unknown NAME is not a warning: {warns:?}");
    }

    #[test]
    fn concierge_tools_warns_about_an_unreadable_value_but_keeps_it() {
        // KEEPS it. The frontend reads an unrecognized rule as "ask" — stricter than the derived
        // default — so dropping it here would silently restore the permissive default on exactly the
        // rule the user was trying to tighten (list_projects defaults to "allow").
        let g = "[concierge.tools]\nlist_projects = \"dney\"\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard, "a bad VALUE is a warning, never a hard error");
        assert_eq!(cfg.concierge.tools.get("list_projects").map(String::as_str), Some("dney"));
        assert!(
            warns.iter().any(|w| w.contains("[concierge.tools].list_projects") && w.contains("dney")),
            "the warning must name the key and the value: {warns:?}"
        );
    }

    #[test]
    fn partial_concierge_section_preserves_rules_it_does_not_mention() {
        // Per-KEY overlay, like [approvals]. Writing one rule must not reset the other forty — the
        // failure mode of a wholesale map replacement, which would look like the settings pane
        // silently forgetting everything the moment a second rule is written.
        let g = "[concierge.tools]\nmerge_pr = \"deny\"\nquit_app = \"deny\"\n";
        let (cfg, _, _) = effective(Some(g), None);
        let mut base = SparkleConfig::default();
        base.concierge = cfg.concierge.clone();
        // Now overlay a layer that mentions only ONE of them.
        let (merged, _, _) = build_effective(base, Some("[concierge.tools]\nmerge_pr = \"ask\"\n"), None);
        assert_eq!(merged.concierge.tools.get("merge_pr").map(String::as_str), Some("ask"));
        assert_eq!(
            merged.concierge.tools.get("quit_app").map(String::as_str),
            Some("deny"),
            "a rule the layer didn't mention must survive"
        );
    }

    #[test]
    fn concierge_is_ignored_in_a_project_file_with_a_warning() {
        // A SECURITY boundary, not tidiness: [concierge.tools] grants standing authority over the
        // whole app (quit_app, remove_project, discard_agent), so a cloned repo must not be able to
        // hand itself that authority over the user's machine.
        let p = "[concierge.tools]\nquit_app = \"allow\"\n";
        let (cfg, warns, hard) = effective(None, Some(p));
        assert!(!hard);
        assert!(
            cfg.concierge.tools.is_empty(),
            "a per-project concierge rule must not take effect: {:?}",
            cfg.concierge.tools
        );
        assert!(
            warns.iter().any(|w| w.contains("[concierge]")),
            "the user must be told their project rule was ignored: {warns:?}"
        );
    }

    #[test]
    fn concierge_template_documents_the_section_and_stays_commented_out() {
        // The shipped template must EXPLAIN the section without writing any rule: a default install
        // has to sit on the derived defaults, and an uncommented example would be a real policy the
        // user never chose.
        assert!(DEFAULT_TEMPLATE.contains("[concierge.tools]"));
        assert!(DEFAULT_TEMPLATE.contains("# [concierge.tools]"), "must ship commented out");
        let (cfg, warns, hard) = build_effective(SparkleConfig::default(), Some(DEFAULT_TEMPLATE), None);
        assert!(!hard, "the shipped template must parse: {warns:?}");
        assert!(
            cfg.concierge.tools.is_empty(),
            "the template must not set a rule: {:?}",
            cfg.concierge.tools
        );
    }

    #[test]
    fn concierge_tools_round_trip_through_the_dotted_setter() {
        // The settings pane writes `concierge.tools.<name>` and clears it by unsetting the key —
        // both must work on a nested section the file doesn't have yet.
        let mut doc: toml_edit::DocumentMut = "".parse().unwrap();
        set_dotted(&mut doc, "concierge.tools.merge_pr", "deny".into()).unwrap();
        set_dotted(&mut doc, "concierge.tools.quit_app", "ask".into()).unwrap();
        let (cfg, _, hard) = effective(Some(&doc.to_string()), None);
        assert!(!hard, "the written file must parse: {}", doc);
        assert_eq!(cfg.concierge.tools.get("merge_pr").map(String::as_str), Some("deny"));
        assert_eq!(cfg.concierge.tools.get("quit_app").map(String::as_str), Some("ask"));

        unset_dotted(&mut doc, "concierge.tools.merge_pr").unwrap();
        let (cfg, _, _) = effective(Some(&doc.to_string()), None);
        assert!(cfg.concierge.tools.get("merge_pr").is_none(), "cleared rule is gone");
        assert_eq!(
            cfg.concierge.tools.get("quit_app").map(String::as_str),
            Some("ask"),
            "clearing one rule must not disturb its neighbour"
        );
    }

    // --- [concierge.checks] — the deterministic reply linter's policy -------------------------

    /// The shipped policy, spelled out LITERALLY rather than read back from
    /// `DEFAULT_CONCIERGE_CHECKS`. Deriving the expectation from the table under test would make
    /// every assertion below true by construction — it would still pass after someone deleted a
    /// check or flipped a severity, which is exactly the drift these tests exist to catch.
    /// `(id, severity, autofix, threshold, words)`, in BTreeMap (sorted) order.
    /// The four `"off"` rows are the checks that are DESIGNED BUT NOT IMPLEMENTED — see the
    /// "NOT YET IMPLEMENTED" banner in `DEFAULT_CONCIERGE_CHECKS`. They previously shipped at
    /// `"block"`/`"warn"` with nothing implementing them, which made the table a promise the app did
    /// not keep. The TypeScript side (`conciergeLintRegistry.test.ts`) is what refuses to let one be
    /// switched back on without an implementation; this table just records what ships.
    const EXPECTED_CHECKS: &[(&str, &str, bool, Option<i64>, Option<&str>)] = &[
        ("actions-first", "off", false, None, None),
        // `"warn"`, not `"block"`: designed to block, but nothing re-prompts yet. See the row's
        // comment in DEFAULT_CONCIERGE_CHECKS.
        ("ask-without-action", "warn", false, None, None),
        ("bare-agent-name", "off", true, None, None),
        ("bare-pr-number", "off", true, None, None),
        ("fat-pill-label", "off", true, None, None),
        ("hedge-words", "warn", false, None, Some("should, deserves to")),
        ("naked-file-ref", "warn", false, None, None),
        ("relay-paste", "off", false, Some(240), None),
        ("restated-state", "warn", false, Some(200), None),
        ("unreported-refusal", "off", false, None, None),
        ("unresolved-agent-pill", "off", false, None, None),
    ];

    #[test]
    fn concierge_checks_ship_the_whole_policy_with_no_config_file() {
        // The OPPOSITE of [concierge.tools], whose empty default is a complete policy. An empty
        // check list would mean no linting at all, so the shipped values ARE the policy and a user
        // with no config file has to get them.
        let (cfg, warns, _) = effective(None, None);
        let c = &cfg.concierge.checks;
        assert!(c.enabled, "the linter must be ON for a fresh install");
        assert!(c.log, "violations are counted from the first turn — drift has to be a number");
        assert!(!c.log_matches, "hashing the matched span is opt-in");

        let ids: Vec<&str> = c.checks.keys().map(String::as_str).collect();
        let expected: Vec<&str> = EXPECTED_CHECKS.iter().map(|e| e.0).collect();
        assert_eq!(ids, expected, "the ten shipped checks, no more and no fewer");
        for (id, severity, autofix, threshold, words) in EXPECTED_CHECKS {
            let got = c.checks.get(*id).unwrap_or_else(|| panic!("no shipped policy for {id}"));
            assert!(got.enabled, "{id} must ship enabled");
            assert_eq!(got.severity, *severity, "{id} severity");
            assert_eq!(got.effective_severity(), *severity, "{id} must resolve to its own severity");
            assert_eq!(got.autofix, *autofix, "{id} autofix");
            assert_eq!(got.threshold, *threshold, "{id} threshold");
            assert_eq!(got.words.as_deref(), *words, "{id} words");
        }
        assert!(
            !warns.iter().any(|w| w.contains("[concierge.checks")),
            "the shipped policy must load clean: {warns:?}"
        );
    }

    #[test]
    fn concierge_checks_template_matches_the_default() {
        // Modeled on `plugins_default_matches_the_template`, with the same trap avoided explicitly:
        // overlaying the template onto SparkleConfig::default() would pass even if the block were
        // MISSING from the template, because the base already holds the policy. So start from a
        // WIPED policy — then this equality can only hold if the template really writes every field.
        let mut base = SparkleConfig::default();
        base.concierge.checks = ConciergeChecksConfig {
            enabled: false,
            log: false,
            log_matches: true,
            checks: std::collections::BTreeMap::new(),
        };
        let (cfg, warns, hard) = build_effective(base, Some(DEFAULT_TEMPLATE), None);
        assert!(!hard, "the shipped template must parse: {warns:?}");
        assert_eq!(
            cfg.concierge.checks,
            SparkleConfig::default().concierge.checks,
            "DEFAULT_TEMPLATE's [concierge.checks] disagrees with SparkleConfig::default() — the \
             bug class that already bit [approvals].bash"
        );
        // And it ships LIVE, unlike [concierge.tools]: a commented-out block would leave the user
        // nothing to edit for the one-line escape hatch the design depends on.
        assert!(
            DEFAULT_TEMPLATE.contains("\n[concierge.checks]\n"),
            "the block must ship uncommented"
        );
    }

    #[test]
    fn a_global_check_edit_lands_and_leaves_the_rest_of_the_policy_alone() {
        // The one-line hatch the whole design rests on: switch off a misfiring check with no
        // rebuild — without silently resetting that check's other knobs, or its neighbours'.
        // Aimed at `restated-state`, NOT `relay-paste`. relay-paste now ships `"off"` (designed, not
        // implemented), so `severity = "off"` would be a no-op edit and "the edit must take effect"
        // would pass without anything taking effect. `restated-state` ships `"warn"` WITH a
        // threshold, which is what this test needs: a severity that actually changes, plus an
        // unmentioned field whose survival proves the merge is per-FIELD.
        let g = "[concierge.checks.restated-state]\nseverity = \"off\"\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        let c = &cfg.concierge.checks;
        let edited = c.checks.get("restated-state").expect("restated-state must still exist");
        assert_eq!(edited.effective_severity(), "off", "the edit must take effect");
        assert_eq!(
            edited.threshold,
            Some(200),
            "a field the edit didn't mention keeps its shipped value — per-FIELD merge, not \
             per-check replacement"
        );
        assert!(edited.enabled, "severity = \"off\" is a different edit from enabled = false");
        assert_eq!(
            c.checks.get("ask-without-action").map(|k| k.severity.as_str()),
            Some("warn"),
            "another check must not move"
        );
        assert!(c.enabled, "one check off is not the whole linter off");
        assert!(warns.is_empty(), "a valid edit warns about nothing: {warns:?}");
    }

    #[test]
    fn the_master_switch_turns_the_whole_linter_off() {
        // The widest escape hatch. Asserted on the resolved config rather than on the file text,
        // because "the line is in the file" is not "the linter is off".
        let (cfg, _, hard) = effective(Some("[concierge.checks]\nenabled = false\n"), None);
        assert!(!hard);
        assert!(!cfg.concierge.checks.enabled);
        assert_eq!(
            cfg.concierge.checks.checks.len(),
            EXPECTED_CHECKS.len(),
            "the master switch must not erase the per-check rows — turning the linter back on has \
             to restore the policy the user tuned, not a blank one"
        );
    }

    #[test]
    fn an_unknown_check_id_survives_verbatim() {
        // Same discipline as [concierge.tools]: the authoritative check list lives in the TypeScript
        // linter, so a config written by a NEWER Sparkle must round-trip through this one rather
        // than having its unrecognized rows rejected or erased.
        let g = "[concierge.checks.rule-from-the-future]\nseverity = \"block\"\nthreshold = 9\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        let got = cfg
            .concierge
            .checks
            .checks
            .get("rule-from-the-future")
            .expect("an unknown id must be kept");
        assert_eq!(got.severity, "block");
        assert_eq!(got.threshold, Some(9));
        assert!(got.enabled, "an unknown id resolves to on+warn, never to silently-off");
        assert!(
            !warns.iter().any(|w| w.contains("rule-from-the-future")),
            "an unknown NAME is not a warning — Rust does not own the check list: {warns:?}"
        );
        // ...and it did not disturb the shipped rows.
        assert_eq!(cfg.concierge.checks.checks.len(), EXPECTED_CHECKS.len() + 1);
    }

    #[test]
    fn a_wrong_typed_check_value_is_dropped_with_a_warning_and_costs_nothing_else() {
        // roborev 54240's lesson applied to [concierge.checks]: with strongly-typed fields any ONE
        // of these lines fails the WHOLE-FILE parse, discarding the entire global layer so every
        // unrelated setting silently reverts. Each bad value must cost exactly itself.
        let g = r#"
[workflow]
require_pr = false

[concierge.checks]
enabled = "yes"
hedge-words = true

[concierge.checks.relay-paste]
threshold = "lots"
autofix = 1
severity = "warn"
"#;
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard, "a wrong-typed lint knob must never be a hard error");
        // The unrelated setting in the same file survived — the whole point.
        assert!(!cfg.workflow.require_pr, "an unrelated section must still apply");
        let c = &cfg.concierge.checks;
        assert!(c.enabled, "a non-bool master switch is dropped, so the shipped `true` stands");
        let relay = c.checks.get("relay-paste").unwrap();
        assert_eq!(relay.threshold, Some(240), "the bad threshold was dropped, not coerced");
        assert!(!relay.autofix, "the bad autofix was dropped, not coerced to true");
        assert_eq!(relay.severity, "warn", "the GOOD field in the same table still applied");
        // `hedge-words = true` is a scalar where a table belongs; the shipped row is untouched.
        assert_eq!(
            c.checks.get("hedge-words").and_then(|k| k.words.as_deref()),
            Some("should, deserves to")
        );
        // Every dropped line is REPORTED. A line the user deliberately wrote that silently does
        // nothing is worse than either applying it or refusing it.
        let said = |needle: &str| warns.iter().any(|w| w.contains(needle));
        assert!(said("[concierge.checks].enabled"), "master switch: {warns:?}");
        assert!(said("[concierge.checks.relay-paste].threshold"), "threshold: {warns:?}");
        assert!(said("[concierge.checks.relay-paste].autofix"), "autofix: {warns:?}");
        assert!(said("[concierge.checks].hedge-words"), "non-table check: {warns:?}");
    }

    #[test]
    fn a_bad_severity_resolves_to_warn_and_never_to_off() {
        // DIRECTION MATTERS. Failing open on a check the user was editing to TIGHTEN hands back
        // exactly the leniency they were trying to remove, so an unreadable severity warns.
        let g = "[concierge.checks.relay-paste]\nseverity = \"blokc\"\n\
                 [concierge.checks.hedge-words]\nseverity = \"of\"\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard, "a bad severity is a warning, never a hard error");
        let relay = cfg.concierge.checks.checks.get("relay-paste").unwrap();
        assert_eq!(relay.severity, "blokc", "the raw value is KEPT so the warning can name it");
        assert_eq!(relay.effective_severity(), "warn", "and it resolves to warn");
        assert_ne!(relay.effective_severity(), "off", "never to off");
        // A near-miss for "off" is the case that would silently disable a check.
        let hedge = cfg.concierge.checks.checks.get("hedge-words").unwrap();
        assert_eq!(hedge.effective_severity(), "warn", "\"of\" must not read as \"off\"");
        assert!(
            warns.iter().any(|w| {
                w.contains("[concierge.checks.relay-paste].severity") && w.contains("blokc")
            }),
            "the warning must quote the key and the value: {warns:?}"
        );
    }

    #[test]
    fn concierge_checks_in_a_project_file_cannot_override_the_global_policy() {
        // The security boundary [concierge.tools] already draws, inherited for a stronger reason: a
        // cloned repo must not be able to disable the linter that governs what the concierge tells
        // the human ABOUT that repo.
        // Aimed at `ask-without-action` and NOT at `relay-paste`. relay-paste now ships `"off"`
        // (designed, not implemented), so a project file setting it to `"off"` would agree with the
        // global value and this test would pass without the boundary doing anything — a vacuous
        // assertion of exactly the kind this repo's #1 finding is about. `ask-without-action` ships
        // `"block"`, so "the global severity stands" is a claim the override could actually break.
        let p = "[concierge.checks]\nenabled = false\n\
                 [concierge.checks.ask-without-action]\nseverity = \"off\"\nenabled = false\n";
        let (cfg, warns, hard) = effective(None, Some(p));
        assert!(!hard);
        let c = &cfg.concierge.checks;
        assert!(c.enabled, "a repo must not be able to switch the linter off");
        let gated = c.checks.get("ask-without-action").unwrap();
        assert!(gated.enabled, "a repo must not be able to disable one check either");
        assert_eq!(gated.effective_severity(), "warn", "the global severity stands");
        assert!(
            warns.iter().any(|w| w.contains("[concierge]")),
            "the user must be told their project rules were ignored: {warns:?}"
        );
    }

    #[test]
    fn a_misspelled_check_field_is_reported_rather_than_silently_doing_nothing() {
        // The ASYMMETRY with an unknown check id, and it is deliberate. The id list is authoritative
        // in TypeScript, so an unknown id is plausibly from the future; the FIELD set is
        // authoritative in this very struct, so `sevrity` is a typo. Left silent it would parse,
        // apply nothing, and say nothing — while the blocking check the user was trying to switch
        // off kept firing on every reply. Same treatment [plugins] gives an unknown toggle.
        // Aimed at `ask-without-action`, which ships `"block"`. Pointed at `relay-paste` — now
        // shipped `"off"` — the central assertion would read "off" whether the typo took effect or
        // not, so it would pass while proving nothing.
        let g = "[concierge.checks.ask-without-action]\nsevrity = \"off\"\nenable = false\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        let gated = cfg.concierge.checks.checks.get("ask-without-action").unwrap();
        assert_eq!(gated.effective_severity(), "warn", "the typo cannot have taken effect");
        assert!(gated.enabled, "nor can `enable`");
        assert!(
            warns.iter().any(|w| w.contains("[concierge.checks.ask-without-action].sevrity")),
            "the misspelled field must be named: {warns:?}"
        );
        assert!(
            warns.iter().any(|w| w.contains("[concierge.checks.ask-without-action].enable")),
            "both misspellings, not just the first: {warns:?}"
        );
    }

    #[test]
    fn a_wrong_typed_concierge_section_costs_that_line_and_not_the_whole_config() {
        // roborev 54240 one level FURTHER OUT than it was originally fixed. Making the values inside
        // a section tolerant is not enough: `checks = false` / `tools = "allow"` — a plausible reach
        // for a master switch that lives elsewhere — would fail the WHOLE-FILE parse, discard the
        // entire global layer, and silently revert every unrelated setting in it.
        let g = r#"
[workflow]
require_pr = false

[concierge]
checks = false
tools = "allow"
"#;
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard, "a wrong-typed SECTION must not be a hard error");
        assert!(!cfg.workflow.require_pr, "the unrelated section in the same file must survive");
        assert!(cfg.concierge.checks.enabled, "the shipped policy stands");
        assert_eq!(
            cfg.concierge.checks.checks.len(),
            EXPECTED_CHECKS.len(),
            "and no check row was lost"
        );
        assert!(cfg.concierge.tools.is_empty(), "a scalar [concierge.tools] sets no rule");
        assert!(
            warns.iter().any(|w| w.contains("[concierge.checks] is a boolean")),
            "the dropped section must be reported: {warns:?}"
        );
        assert!(
            warns.iter().any(|w| w.contains("[concierge.tools] is a string")),
            "both halves report: {warns:?}"
        );
    }

    #[test]
    fn a_non_positive_threshold_is_reported_because_every_reply_matches_it() {
        // `threshold = 0` on a `block` check means every reply is a violation and gets re-prompted.
        // Warned, not clamped: 1 matches just as trivially, so only saying so helps. Every other
        // numeric knob in this file is policed the same way.
        let g = "[concierge.checks.relay-paste]\nthreshold = 0\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert_eq!(
            cfg.concierge.checks.checks.get("relay-paste").unwrap().threshold,
            Some(0),
            "the value is kept — warned about, not rewritten"
        );
        assert!(
            warns.iter().any(|w| w.contains("[concierge.checks.relay-paste].threshold is 0")),
            "the warning must quote the key and the value: {warns:?}"
        );
        // A positive threshold is silent, so the warning means something.
        let (_, quiet, _) = effective(Some("[concierge.checks.relay-paste]\nthreshold = 9\n"), None);
        assert!(quiet.is_empty(), "a usable threshold warns about nothing: {quiet:?}");
    }

    #[test]
    fn the_project_refusal_points_at_the_file_that_can_actually_change_checks() {
        // A remedy string is an instruction the user will follow. "⋯ Settings → Concierge tools"
        // lists tools with their risk and has no check rows, so sending a [concierge.checks]
        // override there lands them on a pane where the setting is absent.
        let p = "[concierge.checks]\nenabled = false\n";
        let (_, warns, _) = effective(None, Some(p));
        let msg = warns
            .iter()
            .find(|w| w.contains("[concierge]"))
            .expect("the override must be reported");
        assert!(msg.contains("global config.toml"), "the remedy must name the file: {msg}");
        assert!(
            msg.contains("tools half"),
            "and must scope the pane pointer to the half it covers: {msg}"
        );
    }

    #[test]
    fn a_check_survives_a_dotted_write_with_the_file_comments_intact() {
        // The file promises hand-editability AND comment preservation; the settings UI writes
        // through `set_value`, whose `json_to_toml_value` accepts only bool/i64/String — which is
        // why every check field is a scalar. Assert the RESOLVED config changed and the human's
        // annotations survived, not merely that the write returned Ok.
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        reset(ad).unwrap();
        // A comment a human might add to record WHY a check is off — the thing that must survive.
        let annotated = std::fs::read_to_string(global_path(ad))
            .unwrap()
            .replace(
                "[concierge.checks.relay-paste]",
                "# off since Tuesday: it fired on the quoted diff\n[concierge.checks.relay-paste]",
            );
        std::fs::write(global_path(ad), &annotated).unwrap();

        set_value(ad, "concierge.checks.relay-paste.enabled", &serde_json::json!(false)).unwrap();
        set_value(ad, "concierge.checks.restated-state.threshold", &serde_json::json!(400)).unwrap();
        set_value(ad, "concierge.checks.hedge-words.words", &serde_json::json!("should, might")).unwrap();

        let text = std::fs::read_to_string(global_path(ad)).unwrap();
        let (cfg, warns, hard) = effective(Some(&text), None);
        assert!(!hard, "the written file must parse: {warns:?}");
        let c = &cfg.concierge.checks;
        assert!(!c.checks.get("relay-paste").unwrap().enabled, "the bool write took effect");
        assert_eq!(
            c.checks.get("relay-paste").unwrap().threshold,
            Some(240),
            "writing one field must not disturb its siblings"
        );
        assert_eq!(c.checks.get("restated-state").unwrap().threshold, Some(400), "the int write");
        assert_eq!(
            c.checks.get("hedge-words").unwrap().words.as_deref(),
            Some("should, might"),
            "the string write"
        );
        assert!(
            text.contains("# off since Tuesday: it fired on the quoted diff"),
            "the human's own comment must survive an in-app write:\n{text}"
        );
        assert!(
            text.contains("# Contiguous verbatim chars shared with a tool argument"),
            "the shipped explanatory comments must survive too:\n{text}"
        );
    }

    #[test]
    fn approvals_resume_defaults_to_ask() {
        // Unlike the permission categories (which ship "always"), the session-resume sibling ships
        // "ask" — Sparkle never auto-picks a resume mode until the user opts in.
        let (cfg, _, _) = effective(None, None);
        assert_eq!(cfg.approvals.resume.as_deref(), Some("ask"));
    }

    #[test]
    fn approvals_resume_global_applies_and_project_overrides() {
        // Global sets resume=summary; the project flips it to full. Project value beats global,
        // same as the categories, and [approvals] stays repo-scoped (not reported as ignored).
        let g = "[approvals]\nresume = \"summary\"\n";
        let (cfg, _, _) = effective(Some(g), None);
        assert_eq!(cfg.approvals.resume.as_deref(), Some("summary"), "global resume applies");

        let p = "[approvals]\nresume = \"full\"\n";
        let (cfg, warns, hard) = effective(Some(g), Some(p));
        assert!(!hard);
        assert_eq!(cfg.approvals.resume.as_deref(), Some("full"), "project resume beats global");
        assert!(
            !warns.iter().any(|w| w.contains("[approvals]")),
            "per-project [approvals] (incl. resume) must be honored, not ignored"
        );
    }

    #[test]
    fn approvals_resume_project_ask_overrides_global_auto_resume() {
        // The per-project opt-out end to end: a project's explicit resume="ask" must beat a global
        // "summary"/"full", so ONE project can stop auto-resuming even when all-projects auto-resumes.
        // This is the exact regression the configActions fix guards — assert it at the merge layer.
        let g = "[approvals]\nresume = \"summary\"\n";
        let p = "[approvals]\nresume = \"ask\"\n";
        let (cfg, _, hard) = effective(Some(g), Some(p));
        assert!(!hard);
        assert_eq!(cfg.approvals.resume.as_deref(), Some("ask"), "project ask beats global summary");
    }

    #[test]
    fn approvals_resume_preserved_when_only_a_category_is_written() {
        // Writing only `bash = "always"` must NOT wipe the shipped "ask" default on resume — the
        // same field-by-field overlay guarantee the categories rely on.
        let g = "[approvals]\nbash = \"always\"\n";
        let (cfg, _, _) = effective(Some(g), None);
        assert_eq!(cfg.approvals.resume.as_deref(), Some("ask"));
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

        // Clear the global rule too → no file layer left, so the built-in default answers (which
        // now ships bash auto-approve ON, not unset).
        unset_value(&dir, "approvals.bash").unwrap();
        let g_text = read_if_exists(&global_path(&dir));
        let (cfg, _, _) = build_effective(SparkleConfig::default(), g_text.as_deref(), None);
        assert_eq!(
            cfg.approvals.bash.as_deref(),
            Some("always"),
            "both file layers cleared → falls back to the built-in default"
        );

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
        assert_eq!(cfg.workers.max_concurrent, Some(7));
    }

    /// TYPE FIDELITY, asserted on the BYTES rather than on the parsed struct.
    ///
    /// `effective()` would deserialize `max_concurrent = "64"` … no, it would REJECT it — which is
    /// precisely how the unsettable-numbers defect surfaced ("invalid type: string \"64\", expected
    /// u32"). The type was lost at the MCP tool boundary, where a schema-less `value` made clients
    /// send the model's literal text; every hop from here down was already correct. These pin that
    /// correctness so a future change to `json_to_toml_value` can't quietly start quoting scalars:
    /// a number must render bare, a bool bare, and a string quoted.
    #[test]
    fn set_value_writes_each_json_type_with_the_right_toml_type() {
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        reset(ad).unwrap();

        set_value(ad, "workers.max_concurrent", &serde_json::json!(64)).unwrap();
        set_value(ad, "workflow.require_pr", &serde_json::json!(false)).unwrap();
        set_value(ad, "workflow.default_branch", &serde_json::json!("dev")).unwrap();

        let text = std::fs::read_to_string(global_path(ad)).unwrap();
        // The template pads its `=` for alignment, and toml_edit preserves that padding, so compare
        // against whitespace-normalised assignments rather than one exact spelling of the spacing.
        let assignments: Vec<String> = text
            .lines()
            .map(|l| l.trim().split_whitespace().collect::<Vec<_>>().join(" "))
            .collect();
        let written = |needle: &str| assignments.iter().any(|l| l == needle);

        // A number renders BARE. `= "64"` is the exact byte pattern of the reported bug.
        assert!(written("max_concurrent = 64"), "number must be unquoted:\n{text}");
        assert!(!written("max_concurrent = \"64\""), "number must not be quoted:\n{text}");
        // A bool renders bare, not as the text "false".
        assert!(written("require_pr = false"), "bool must be unquoted:\n{text}");
        assert!(!written("require_pr = \"false\""), "bool must not be quoted:\n{text}");
        // A string DOES render quoted — the fidelity runs both ways.
        assert!(written("default_branch = \"dev\""), "string must be quoted:\n{text}");

        // And the whole document still satisfies the schema with the values we meant.
        let (cfg, _, hard) = effective(Some(&text), None);
        assert!(!hard);
        assert_eq!(cfg.workers.max_concurrent, Some(64));
        assert!(!cfg.workflow.require_pr);
        assert_eq!(cfg.workflow.default_branch, "dev");
    }

    /// The two JSON types the scalar writer does NOT accept, pinned as a deliberate contract rather
    /// than left to be discovered. An OBJECT never arrives here — the control listener flattens it
    /// to dotted scalar leaves first — and the config schema has no scalar-array key, so both are
    /// refused with a message that names the accepted types instead of corrupting the file.
    #[test]
    fn set_value_refuses_array_and_object_values_by_design() {
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        reset(ad).unwrap();
        let before = std::fs::read_to_string(global_path(ad)).unwrap();

        for bad in [serde_json::json!([1, 2, 3]), serde_json::json!({"a": 1}), serde_json::json!(null)] {
            let err = set_value(ad, "workers.max_concurrent", &bad).unwrap_err();
            assert!(
                err.contains("boolean, integer, or string"),
                "refusal must name the accepted types, got: {err}"
            );
        }
        assert_eq!(before, std::fs::read_to_string(global_path(ad)).unwrap());
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
        assert_eq!(cfg.workers.max_concurrent, Some(3));
        // Untouched key keeps its value.
        assert!(cfg.ai.voice_dictation);
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

    /// The settings pane's "Reset all to defaults" clears every per-tool rule with ONE
    /// `unset_value("concierge.tools")` rather than N unsets of its keys — each write emits a
    /// `config-changed`, so key-by-key lets a hydrate land mid-clear and revert the rest. That only
    /// works if unsetting a dotted path can remove a whole TABLE, which nothing pinned before.
    #[test]
    fn unset_value_removes_a_whole_table_and_leaves_its_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        reset(ad).unwrap();
        set_values(
            ad,
            &[
                ("concierge.tools.merge_pr".to_string(), serde_json::json!("deny")),
                ("concierge.tools.quit_app".to_string(), serde_json::json!("allow")),
                // A hand-edited key naming no tool. "Reset to defaults" has to take this too, or the
                // pane still shows an "unreadable" warning on a row the user just reset.
                ("concierge.tools.not_a_tool".to_string(), serde_json::json!("allwo")),
                // A SIBLING section that must survive.
                ("ai.composer".to_string(), serde_json::json!(false)),
            ],
        )
        .unwrap();
        let (before, _, _) = effective(Some(&std::fs::read_to_string(global_path(ad)).unwrap()), None);
        assert_eq!(before.concierge.tools.len(), 3);

        unset_value(ad, "concierge.tools").unwrap();

        let text = std::fs::read_to_string(global_path(ad)).unwrap();
        let (cfg, _, hard) = effective(Some(&text), None);
        assert!(!hard, "the file must still be valid TOML after the table is removed");
        assert!(cfg.concierge.tools.is_empty(), "every rule is gone: {:?}", cfg.concierge.tools);
        // Only the policy went. The rest of the file is untouched.
        assert!(!cfg.ai.composer);
    }

    #[test]
    fn unset_value_on_an_absent_table_is_a_no_op() {
        // Pressing "Reset all to defaults" on a machine that never wrote a rule must not fail, and
        // must not rewrite the file into some other shape.
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        reset(ad).unwrap();
        let before = std::fs::read_to_string(global_path(ad)).unwrap();
        unset_value(ad, "concierge.tools").unwrap();
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
    //
    // It WAS a byte-for-byte copy of the upstream seed-auto-roborev wrapper. As of 2026-07-26 it
    // deliberately DIVERGES, and that divergence is the point of half the needles below: Sparkle
    // added (a) owner-repo resolution via `--git-common-dir`, because the upstream basename-only
    // test cannot see a fixture from inside a linked worktree, and (b) a self-heal that strips the
    // stub `roborev install-hook --force` splices in above this wrapper. Without those, Sparkle's
    // own suites flooded the review queue with ~11.5k dead-repo jobs.
    //
    // So this test now guards TWO things: that the upstream skip heuristics survive an edit to the
    // Sparkle copy, AND that a future seed re-sync cannot silently drop the Sparkle-only fixes by
    // overwriting this file with the upstream version. Behaviour for all of it is covered end-to-end
    // in scripts/tests/roborev-hook-guard.test.sh, which drives the hook as a real git hook; these
    // are cheap token assertions that fail fast at the Rust layer.
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
            // ── Sparkle-only, and the reason a seed re-sync must fail this test ──────────────
            "sparkle-self-test-", // the nested <tmp>/sparkle-self-test-*/sparkle-self/repo layout
            "--git-common-dir",   // owner-repo resolution (linked-worktree blind spot)
            "*/sparkle-test-*",   // path-COMPONENT matching, not basename-only
            "heal-failed",        // the self-heal's visible-failure sentinel
        ] {
            assert!(
                hook.contains(needle),
                "vendored post-commit lost the '{needle}' guard/behavior — did the copy drift from the seed?"
            );
        }
    }
}
