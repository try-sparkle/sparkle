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

use std::collections::BTreeMap;
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
    /// The user's requested ceiling on parallel agents ON THIS MACHINE, or `None` for AUTO — let the
    /// machine decide.
    ///
    /// MACHINE-WIDE, not per build agent — ratified 2026-07-30 (bead `sparkle-axtkw`). The frontend
    /// counts every worker on the box against it (`orchestrationListener.globalGateBinds`). It had
    /// been documented both ways: this file's clamp warning said machine-wide, the ⋯-menu slider
    /// said "per build agent". Per-agent is the unsafe reading — N agents each under a per-agent cap
    /// put N × the cap on one machine, which is the `sparkle-hfhs` coalition blowup. A genuine
    /// per-agent limit would need its own key; do not re-overload this one.
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
    /// The SECOND value-domain sibling: how to answer Claude Code's PLAN-EXIT prompt — "Claude has
    /// written up a plan and is ready to execute. Would you like to proceed?" — when
    /// [ai].auto_approve is on. One of `"auto"` (default — pick "Yes, and use auto mode"),
    /// `"manual"` (pick "Yes, manually approve edits"), or `"ask"` (surface it). Any unrecognized
    /// value is treated as the default. Project [approvals].plan overrides the global value.
    ///
    /// NOTE THE DEFAULT RUNS THE OTHER WAY TO `resume` DIRECTLY ABOVE, deliberately. A resume mode
    /// left unanswered costs nothing; a plan prompt left unanswered costs an agent that has already
    /// finished thinking and now sits idle until a human presses a key — which is the exact stall
    /// this key was added to end.
    ///
    /// "auto" is not scoped to the one prompt: Claude Code keeps auto mode for the rest of the
    /// session and stops emitting edit prompts. Under the shipped config that changes nothing (every
    /// category above already defaults to "always", so those prompts were auto-answered anyway), but
    /// if you set a category to "never" to get its prompts back, use `plan = "manual"` — it ends the
    /// stall just as well and leaves your per-category rules in force.
    pub plan: Option<String>,
    /// May a prompt the local classifier declines to answer be handed to the CONCIERGE, which reads
    /// it and answers? Default true (see `impl Default`). Project [approvals].concierge_answers
    /// overrides the global value, exactly like the categories and `resume`.
    ///
    /// DELIBERATELY SEPARATE FROM `[ai].auto_approve`, and the distinction is the whole point:
    /// `auto_approve` means "let a purely local REGEX press buttons without anyone reading them".
    /// Routing to the concierge is a DIFFERENT act — a reasoning agent reads the question first,
    /// then answers. Coupling them onto one switch would mean that turning off the blind presser
    /// also silences the thing that reads, which is the opposite of what someone reaching for that
    /// switch wants. So: two switches, two honest meanings. `true` lets the concierge be handed the
    /// prompts the classifier won't answer; `false` sends every one of them to the founder.
    ///
    /// A plain `bool`, NOT an `Option<bool>` like its siblings above, on purpose. serde's derive
    /// emits `Option::None` as an explicit `null` (it omits the key only under
    /// `skip_serializing_if`), so an `Option` here would force the TypeScript mirror to tell `null`
    /// apart from absent for a value that has no third state to express. A bare bool crosses the
    /// wire as `true`/`false` and nothing else — see AGENTS.md, "A Rust `Option` crosses the wire as
    /// `null`". The per-layer "was this key set?" question still gets its `Option`, on
    /// `PartialApprovals`, which is where it belongs.
    pub concierge_answers: bool,
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
            // The plan-exit prompt defaults to ANSWERED ("auto"). See the field doc above: an
            // unanswered plan prompt is not a neutral pause, it is a finished agent stalling on a
            // keypress. Opting out is one key — `plan = "ask"` — or the [ai].auto_approve switch.
            plan: Some("auto".to_string()),
            // Concierge routing defaults ON. The problem this exists to solve, in the founder's own
            // framing, is prompts landing on HIM that something else should have answered — so the
            // safe default is that the concierge is ASKED, not that it is skipped. Note this is the
            // opposite reasoning to `resume` directly above, and for a good reason: an unanswered
            // prompt has a cost too (an agent stalls, a human is interrupted), so "do nothing" is
            // not the neutral choice here the way it is for a resume mode. Opting out is one key —
            // `concierge_answers = false` — which restores today's behaviour of routing every
            // unclassified prompt to the human.
            concierge_answers: true,
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
    /// The user's PERSISTED PREFERENCE for the HumaneBench reviewer. The reviewer scores a pull
    /// request changing what Sparkle says or does to a person against HumaneBench's 8
    /// humane-technology principles, posts the per-principle reasoning onto the PR as a verdict
    /// comment, and fails the HumaneBench check below 0.5. Read that as the DESIGNED behaviour of
    /// the review; this bool is not the thing that turns it on, and the next paragraph is why.
    ///
    /// WHAT THIS FLAG DOES NOT DO, stated precisely because the difference is the whole gate.
    /// Three things, and every one of them is a claim some earlier copy made and had to retract:
    ///
    /// 1. IT DOES NOT SWITCH THE REVIEW OFF — and it CANNOT, by construction. The review is
    ///    repo-side: `.github/workflows/humane-gate.yml`, triggered by the pull request itself,
    ///    running on a GitHub Actions runner that has no access to a machine-wide desktop config
    ///    and is never going to have one. Turning this off does not stop a PR being scored and
    ///    does not stop the verdict comment landing on it. That is deliberate, and it is the SAME
    ///    argument as the machine-wide scope in the closing paragraph rather than a separate one:
    ///    a checkout must not be able to switch off its own humaneness gate, and a local toggle
    ///    the workflow honoured would be exactly that switch reached by another route. An earlier
    ///    version of this comment ended "Off skips the review entirely." It never did.
    /// 2. IT DOES NOT HOLD A MERGE. A failing check run does not by itself block. `HumaneBench` is
    ///    deliberately NOT in ruleset 18343818's required contexts yet — bead `sparkle-4eqjil`
    ///    requires it to run green on real pull requests twice before an admin adds it. Until then
    ///    this scores and reports but does not block, and no copy anywhere may say otherwise.
    /// 3. IT HAS NO CONSUMER AT ALL, today — bead `sparkle-9o0649.1`. Nothing reads it: measured,
    ///    `grep -rn 'tools\.humanebench' apps/desktop/src-tauri/src/*.rs | grep -v config.rs`
    ///    returns nothing, while every sibling flag in this table has a real call-site consumer
    ///    (`tools.roborev` at roborev_probe.rs:443, `tools.builder_index` at builder_index.rs:1979,
    ///    `tools.straude` at straude.rs:1603). So what IS it for? It is the persisted preference
    ///    that consumer will read, and it is stated here rather than quietly left implied for the
    ///    reason `scripts/dormant-modules.allow` gives in its own header: an honest "no consumer
    ///    yet" note is the difference between a live entry and a stale one. When the consumer
    ///    lands, delete this point — from here, from `DEFAULT_TEMPLATE`, from `ToolsPane.tsx`,
    ///    from `services/config.ts` and from `settingsStore.ts`, all in the one change.
    ///
    /// Machine-wide like every key in this table, and here that scope is load-bearing rather than
    /// incidental: a cloned repo must not be able to switch off its own humaneness gate simply by
    /// being cloned, which is exactly what a per-project `[tools]` value would let it do.
    pub humanebench: bool,
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
    /// Publish your DAILY TOKEN TOTALS to straude.com, a SEPARATE public leaderboard that competes
    /// with the Builder Index. Independent of `builder_index` in every way — its own flag, its own
    /// sign-in, its own reporter — so a user can run either, both, or neither. Ships OFF for the
    /// same reason: it sends something about you to a third party, so it takes a deliberate opt-in
    /// plus a one-time consent confirmation (see straude.rs, which also gates on a stored sign-in
    /// token). Aggregates only — never file paths, prompts, code, project names, or keys. Note it
    /// receives strictly LESS than `builder_index` does: straude's wire format has no field for
    /// machine specs, installed plugins, or session-activity counters.
    pub straude: bool,
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
/// outward-facing, metered, disruptive, main-touching, branch-rewriting, or privacy-sensitive (a
/// screen capture, gated for what it can SEE rather than any change it makes) → ask. So this table holds only the rules
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
    /// GitHub org/user names the human considers HIS OWN (`[concierge].own_orgs`), lowercased and
    /// trimmed on read. Everything else is FOREIGN, and a foreign repo floors every `mutates-main`
    /// tool at `ask` in the policy layer.
    ///
    /// EMPTY BY DEFAULT, which makes every repo foreign. That is deliberate and it is not a
    /// regression: it reproduces exactly the global stopgap this design replaces (`merge_pr` pinned
    /// to `ask` for everything), so nobody gains authority by upgrading. Adding your org here is
    /// the ONLY way to lift that floor — there is no per-project entry that can, because a project
    /// entry can only tighten.
    pub own_orgs: Vec<String>,
    /// Per-repo tightenings (`[concierge.projects."<owner>/<repo>".tools]`), keyed by LOWERCASED
    /// slug. GitHub is case-insensitive about owner and repo, so a differently-cased key must not
    /// be able to miss its own rule.
    ///
    /// A project entry can only TIGHTEN: the policy layer takes the strictest of the global answer,
    /// the shipped pin, the foreign floor and this. `[concierge.tools].merge_pr = "deny"` plus a
    /// project `"allow"` is still `deny`. That asymmetry is the whole security property — otherwise
    /// this table would be a way to hand back authority the global layer withheld.
    ///
    /// Global-only, like the rest of `[concierge]`: a repo's own `.sparkle/config.toml` never
    /// reaches here, which matters MOST for repos the user does not own (see `apply_project`).
    pub projects: std::collections::BTreeMap<String, ConciergeProjectPolicy>,
}

/// One repo's entry in `[concierge.projects]`.
///
/// A struct with a single field rather than a bare map, because the wire shape is frozen as
/// `{ tools }` and the section is expected to grow siblings (a per-project note, a reason string).
/// An entry with no `tools` table is legal and contributes no tightening.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ConciergeProjectPolicy {
    /// Tool name → `"allow"` | `"ask"` | `"deny"`, VERBATIM — unrecognized values included, for the
    /// same reason as [`ConciergeConfig::tools`]: the frontend reads an unreadable rule as `ask`,
    /// and narrowing here would hand back the authority the user was trying to remove.
    pub tools: std::collections::BTreeMap<String, String>,
}

/// Repos where Sparkle will NEVER merge on its own authority, whatever any config says.
///
/// A FLOOR compiled into the build, not a default: config can tighten past it and can never loosen
/// it. That is what makes the owner's standing rule ("no PR merges without a human in a repo I do
/// not own") survive a reset, a hand-edit, or a future change to the shipped defaults.
///
/// Pinned byte-for-byte against `apps/desktop/shared/merge-protected-repos.json` by
/// `merge_protected_slugs_match_the_shared_fixture`, exactly as `SPARKLE_DENY_RULES` is pinned
/// against `destructive-commands.json` — `policy.ts` declares its own copy of the same list and
/// pins it against the same file, so a slug added on one side and forgotten on the other fails a
/// test instead of drifting.
pub const MERGE_PROTECTED_SLUGS: [&str; 2] = ["plow-pbc/tkmx-client", "plow-pbc/tkmx-server"];

/// Is this `owner/repo` on the shipped merge-protected pin list?
///
/// Case- and whitespace-insensitive: GitHub treats `Plow-PBC/TKMX-Server` and
/// `plow-pbc/tkmx-server` as one repo, and a pin that a differently-cased remote could slip past
/// would not be a floor at all.
///
/// NOT WIRED YET — say so rather than implying a guarantee that does not exist. The Rust backstop
/// in `worktree.rs` (§6 of the contract) WILL call this from `merge_pr` / `land_agent_branch`,
/// because `services/openPrs.ts` invokes `merge_pr` outside the concierge policy seam. Until that
/// gate lands, the only enforcement of this pin is in TypeScript, and nothing here will surface
/// that: both items are `pub` in a lib crate, so `dead_code` never fires. The gate's own PR owns
/// the structural test (the pattern is `knightwatch.rs`'s `merge_pr_actually_runs_the_gate`) that
/// keeps the wiring from being absent — or deleted later — silently.
///
/// When it is wired it enforces `deny` ONLY, never `ask` — there is no human on that path to answer
/// a question — so an unresolvable slug does not refuse there even though the concierge layer floors
/// it at `ask`. That asymmetry is deliberate, not a gap.
pub fn is_merge_protected_slug(slug: &str) -> bool {
    let slug = slug.trim().to_lowercase();
    MERGE_PROTECTED_SLUGS.contains(&slug.as_str())
}

/// The three values a `[concierge.tools]` entry may take. Mirrors PolicyDecision in policy.ts.
const CONCIERGE_TOOL_DECISIONS: [&str; 3] = ["allow", "ask", "deny"];

/// Does this already-trimmed, already-lowercased key look like a GitHub `owner/repo` slug?
///
/// SHAPE ONLY — it cannot know whether the repo exists, and it deliberately does not try. What it
/// catches is the class of hand-edit that fails OPEN: a key that can never match a resolved
/// `remote.origin.url` contributes no tightening at all, and without this the user gets no warning
/// on the one line he wrote to restrict a repo. The plausible misses are all shape errors —
/// `"tkmx-server"` (owner omitted), `"https://github.com/plow-pbc/tkmx-server"` (a pasted URL),
/// `"plow-pbc/tkmx-server.git"`, a stray inner space. Every OTHER mistake in this section already
/// warns, so silence here reads as acceptance.
///
/// Permissive about the character set on purpose (GitHub is stricter about owners than about
/// repos): the point is to catch "this is not an owner/repo at all", not to re-implement GitHub's
/// naming rules and reject a name a future GitHub allows.
fn looks_like_repo_slug(slug: &str) -> bool {
    let mut parts = slug.split('/');
    let (Some(owner), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    // A `.git` SUFFIX IS REJECTED EXPLICITLY, even though `.` is otherwise a legal character
    // (roborev 65417). `repo_slug_from_url` strips `.git` before lowercasing, so a resolved slug
    // NEVER carries the suffix — which makes `"plow-pbc/tkmx-server.git"` a key that cannot match
    // anything and therefore contributes no tightening at all. That is the fail-open case this
    // whole check exists to report, and it is the single most likely one: the `.git` form is what
    // you get by copying the tail of a clone URL. Both the doc comment above and the user-facing
    // remedy text already name it, so letting it pass silently was a promise nothing kept.
    if repo.strip_suffix(".git").is_some() {
        return false;
    }
    let ok = |s: &str| {
        !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    ok(owner) && ok(repo)
}

/// Does this already-trimmed, already-lowercased entry look like a bare GitHub org or username?
///
/// The mirror-image failure of [`looks_like_repo_slug`], and the more expensive one:
/// `own_orgs = ["drodio/sparkle"]` — a repo slug where an ORG goes — matches nothing, so every repo
/// stays foreign and Sparkle keeps asking, while the user believes he has lifted the floor. Silence
/// there is the difference between "I turned this off" and "I thought I turned this off".
fn looks_like_repo_owner(owner: &str) -> bool {
    !owner.is_empty()
        && owner
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

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
    // Said it DID something — sent, spawned, closed, filed, merged, set a goal — while the turn made
    // no tool call that could have done it. The other half of `ask-without-action`, and the more
    // expensive half: an unverifiable receipt retires the task in the human's head, so they stop
    // watching. Deterministic; the reply's claims are reconciled against the turn's own tool calls,
    // with no model in the path.
    //
    // `warn`, and never autofix. The compliant form of a true positive is not a rewrite at all — it
    // is the tool call that was not made — and the compliant form of a false positive is a sentence
    // only the model can write.
    DefaultCheck {
        id: "unbacked-claim",
        severity: "warn",
        autofix: false,
        threshold: None,
        words: None,
    },
    // Asserted that a DEFECT EXISTS — "there is a bug in X", "the pill never fires", "traced it to
    // workerRollup.ts" — and attached nothing durable to it. A bead filed or an agent spawned
    // passes; so does a stated reason for not acting. A MESSAGE TO AN OWNING AGENT DOES NOT — see
    // `tookDisposition`'s header for the founder's ruling of 2026-08-05, which turns on the fact that
    // the originating miss was exactly that. Reporting an already-handled defect ("already fixed on
    // main") is never a violation.
    //
    // The failure it exists for: the concierge diagnosed a real bug and filed no bead, and the
    // founder had to notice the omission himself. `ask-without-action` could not see it — that check
    // keys entirely on an interrogative ("want me to", "should I") and the miss contained no question
    // at all, and it returns clean the moment the turn takes ANY state-changing action.
    //
    // ══ THE FIRST CHECK IN THIS TABLE TO SHIP `"block"`, AND WHY IT MAY ═════════════════════════
    // Every `severity = "block"` here used to be inert: `lintReply` computed `blocked` and no caller
    // read it. That is no longer true — the mount now HOLDS a blocked reply and dispatches exactly one
    // correction turn (see `ConciergeHost.tsx`'s block path and `ConciergeHost.lintBlock.test.tsx`),
    // so `"block"` states something the app actually does.
    //
    // It blocks rather than warns because a warning here would be the same passivity one level up: it
    // hands the founder a note about a dropped bug to read and act on, which is precisely the labour
    // this check exists to remove. `askWithoutAction`'s header makes the argument in full.
    //
    // `ask-without-action` deliberately stays `"warn"` for now — raising it is a separate judgement
    // about a check with its own false-positive profile, and it should be made on its own evidence.
    DefaultCheck {
        id: "defect-without-disposition",
        severity: "block",
        autofix: false,
        threshold: None,
        words: None,
    },
    // Did not OPEN by quoting the message it is answering. The rule is the founder's own and has
    // been in `concierge-guidelines.md` — injected into the system prompt on every single turn — for
    // as long as that file has existed; it is violated anyway, repeatedly, which is the same
    // evidence `ask-without-action` rests on: a rule in prose competes with the task and loses
    // exactly when the turn is busiest. He asked for it to be reject-based (bead sparkle-j6jra).
    //
    // Deterministic and needs no model: the app already knows which of his messages were
    // outstanding when the reply began (`Concierge/replyAnchors.pendingAnchors` — the same fact the
    // "Answered below" stub is drawn from), so the check is a similarity test between the reply's
    // opening blockquote and those messages. An unprompted push answers nothing and is never flagged.
    //
    // `"block"`, and never autofix. Prepending a blockquote mechanically is the one thing the app
    // must NOT do here: the quote's value is that the model demonstrably read the message, and an
    // app-written quote asserts that on its behalf. Only the model can produce the compliant form.
    DefaultCheck {
        id: "reply-without-quote",
        severity: "block",
        autofix: false,
        threshold: None,
        words: None,
    },
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

/// The Pusher's operating envelope (`[pushers]`) — how often one observes, and how loud it may get.
///
/// A Pusher is the adversarial half of a pair: it watches a build agent and may send it a few
/// CITED challenges an hour. This section is what a human turns down when that is too much.
///
/// FLAT AND SCALAR ONLY, unlike `[concierge.checks]`: every field is a bool / integer / string
/// because `json_to_toml_value` accepts exactly those, and that is what makes the whole section
/// editable through the existing dotted setters (⋯ Settings and `set_value` both write scalars).
/// A nested table or an array here would parse from the file and then be unsettable from the UI.
///
/// GLOBAL ONLY. `build_effective` ignores `[pushers]` in a per-project `.sparkle/config.toml`, for
/// the same reason it ignores `[concierge]`: how much a machine nags its own agents is a property
/// of the human sitting at it, not of a repo that happens to be cloned onto it.
///
/// TWO OF THESE ARE CEILINGS, NOT SETTINGS. `messages_per_hour` and `inbox_yield_pct` are resolved
/// on the TypeScript side as `min(configured, <constant>)` (`resolvePusherPolicy` in
/// `packages/core/pusherPolicy.ts`), so a config file may only ever make a Pusher QUIETER. That is
/// the same shape `[workers] max_concurrent` already uses, and the reason is stated on each field.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BabysitConfig {
    /// Master switch for the `/babysit-pr` auto-dispatch sweep. Ships TRUE.
    ///
    /// THE REASON THIS SECTION EXISTS AT ALL. The sweep dispatches a full Claude session against the
    /// founder's own subscription quota whenever an open PR turns up carrying unanswered review
    /// probes, on a 180-second timer, with no human in the loop. Before this, `enabled` was hardwired
    /// true — `resolveBabysitConfig({})` — so the decision core's `disabled` hold was unreachable and
    /// the only way to stop the loop was to ship a new build. An autonomous loop that spends money
    /// must be switchable off without a rebuild.
    ///
    /// On-by-default is the same trade `[pushers]` records above and is defensible for the same
    /// reason: `max_dispatches_per_hour` below is what bounds the worst case.
    pub enabled: bool,
    /// Minutes a PR waits after a driver exits before another may start. Default 30.
    pub cooldown_minutes: i64,
    /// The SHORTER clock used when a lease reads dead — an app restart killed the driver, so the PR
    /// is unwatched and should be picked back up sooner. Default 5. Must stay below
    /// `cooldown_minutes`; the TypeScript resolver enforces that relation and falls back if not.
    pub recovery_cooldown_minutes: i64,
    /// Fleet-wide ceiling on dispatches per hour. Default 4. This is the number that makes
    /// on-by-default defensible, so treat raising it as a spend decision.
    pub max_dispatches_per_hour: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PushersConfig {
    /// Master switch. Ships TRUE.
    ///
    /// A deliberate founder decision, taken OVER the recommended fail-safe default of off. The
    /// reasoning: at the first rungs of autonomy the worst case of a misfiring trigger is noise,
    /// not a destroyed worktree — and `messages_per_hour` below is what bounds how much noise
    /// "noise" can be. Recorded here rather than left to look like an oversight, because the two
    /// facts are load-bearing together: on-by-default is only defensible while the budget holds.
    pub enabled: bool,
    /// Milliseconds between observation cycles for ONE partner. Default 300000 (5 minutes), the
    /// interval the design's cost model is computed at.
    ///
    /// Per-observation cost is already bounded by a hard terminal-snapshot cap, so how OFTEN a
    /// Pusher looks is the only term that can make a fleet of them expensive. `validate` warns
    /// below 60000 and the TypeScript resolver floors there.
    pub observe_interval_ms: i64,
    /// Challenges per partner per rolling hour. Default 4.
    ///
    /// A CEILING the TypeScript side clamps DOWN against its own `MESSAGES_PER_HOUR` constant: a
    /// config file may LOWER this, never raise it. If a hand-edited TOML could set it to 999 the
    /// bound would exist in name only, and the safety argument for `enabled = true` would quietly
    /// stop holding with nothing reporting that it had.
    pub messages_per_hour: i64,
    /// Partner-inbox fill percentage at or above which a Pusher declines to send. Default 80.
    ///
    /// Same ceiling-only rule as `messages_per_hour`: clamped against `INBOX_YIELD_PCT` on the
    /// TypeScript side, so raising it here cannot make a Pusher talk over a backed-up partner.
    pub inbox_yield_pct: i64,
    // THERE IS DELIBERATELY NO `model` FIELD. The design budgeted a cheap-model call per
    // observation to compose each challenge, and that call was removed: the citation rule in
    // `packages/core/pusherGate.ts` refuses any number the observation did not measure, which
    // leaves a composer nothing to do but restate arithmetic somebody else did — and a fixed
    // sentence shape is easier to recognise at a glance than varied prose.
    //
    // The key is gone rather than left inert because this struct is mirrored into `DEFAULT_TEMPLATE`,
    // which the user is invited to hand-edit. A knob nobody reads is worse than no knob: it invites
    // an edit, accepts it, warns about nothing, and changes not one thing. Phase 2 may reintroduce
    // one — together with the caller that reads it.
}

impl Default for PushersConfig {
    /// The shipped envelope. Stated here and mirrored by the `[pushers]` block in
    /// `DEFAULT_TEMPLATE` (asserted by `pushers_template_matches_the_default`).
    fn default() -> Self {
        Self {
            enabled: true,
            observe_interval_ms: 300_000,
            messages_per_hour: 4,
            inbox_yield_pct: 80,
        }
    }
}

/// The SECOND-MODEL ADVISOR PASS (`[advisor]`) — bead `sparkle-revqiv`.
///
/// At the moment an epic becomes a build orchestrator, a model DIFFERENT from the one that wrote the
/// plan reviews it through three lenses (scope one agent can hold, checkable completion criterion,
/// collision with work in flight) and comments. It never rewrites a plan and it never blocks a
/// handoff.
///
/// FLAT AND SCALAR ONLY, and GLOBAL ONLY, for the same two reasons `[pushers]` above records: every
/// field is a bool/string so the whole section stays editable through the existing dotted setters,
/// and which model this machine spends its owner's quota on is a property of the human sitting at
/// it, not of a repo that happens to be cloned onto it.
///
/// ══ WHY `enabled` SHIPS TRUE, WHEN `[pushers]` HAD TO ARGUE FOR IT ═════════════════════════════
///
/// Because the flag is NOT what bounds spend here — the ZERO-SPEND GATE is. Before every pass the
/// advisor reads the LIVE usage payload and dispatches only while `extra_usage.is_enabled` is FALSE,
/// i.e. only while the usage-credit meter is DISARMED and no call CAN bill outside the Claude Max
/// subscription. Armed credits, a reached spend limit, an unreadable payload and an absent field all
/// REFUSE (`services/advisor/spendGate.ts`). So the worst case of shipping this on is a pass that
/// declines to run, which is why the switch can default to the useful direction.
///
/// The switch still exists, and its job is the one the gate cannot do: turning the feature off for
/// reasons that have nothing to do with money — noise, a bad model, an investigation.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AdvisorConfig {
    /// Master switch. Ships TRUE — see the section doc for why that is defensible here and had to
    /// be argued for in `[pushers]`.
    pub enabled: bool,
    /// Which model reviews the plan. Ships `claude-opus-5`.
    ///
    /// A CONFIG LINE, NEVER A HARDCODED TIER, and the default is a considered choice rather than a
    /// reach for the biggest number: Opus 5 is a different FAMILY from the Sonnet planner (which is
    /// the entire premise — a model reviewing its own plan shares its own blind spots) at half
    /// Fable's price (`spend.rs` prices Fable at $10/$50 per Mtok, the most expensive row in the
    /// table; Opus 5 is $5/$25). Fable is one edit to this line away.
    ///
    /// RESOLVED, not obeyed blindly. `services/advisor/model.ts` takes this id only if it is in the
    /// model catalog AND is not the planner's own model; otherwise it falls to the first catalog
    /// entry that is not the planner's, and failing that SKIPS the pass with a reason. An id absent
    /// from the catalog is ignored rather than dispatched — `research.rs` would refuse it anyway
    /// (`RESEARCH_MODEL_ALLOWLIST`), and one typo in a hand-edited TOML must cost exactly that knob.
    ///
    /// A blank string means "unset", which is the same thing as absent: the catalog rule decides.
    pub model: String,
}

impl Default for AdvisorConfig {
    /// The shipped envelope. Stated here and mirrored by the `[advisor]` block in
    /// `DEFAULT_TEMPLATE` (asserted by `advisor_template_matches_the_default`).
    fn default() -> Self {
        Self { enabled: true, model: "claude-opus-5".to_string() }
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
    /// The 1Password account every `op` call acts as, as its `user_uuid`. `None` until chosen — and
    /// only *needed* when more than one account is signed in, where `op` otherwise refuses every
    /// call with "multiple accounts found".
    ///
    /// The uuid, never the email: one person can be signed in twice under the same email (personal
    /// + a family/team membership), and those two rows are indistinguishable by any other field.
    pub account_id: Option<String>,
    /// Restore backed-up env files into each newly created agent worktree. This is the payoff of
    /// the whole feature — `.env*` is gitignored, so a worktree never carries one and every worker
    /// agent starts without its project's secrets. Off by default: it writes files into a fresh
    /// worktree, which the user should ask for rather than discover.
    pub seed_worktrees: bool,
}

/// One place Sparkle can publish a post to ([publish.destinations.<id>]). Bead `sparkle-131ms.3`.
///
/// v1 validates exactly ONE destination (drodio.com), but this is modeled as a keyed table with an
/// `active` pointer anyway. That is the cheap half of the founder's "drodio.com now, but design for
/// X + LinkedIn next" decision — a second destination is then an added row, whereas promoting a
/// flat `url`/`name` pair into a table later is a config migration on every user's machine.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PublishDestination {
    /// What the user sees in the configure pane and on the approval card ("drodio.com").
    pub name: String,
    /// The destination's MCP endpoint. Stored as the user typed it and sent verbatim — the
    /// endpoint answers both the bare and trailing-slash forms with no redirect (verified
    /// 2026-08-17), so there is nothing to gain from normalizing and a normalized value would not
    /// match what the user reads back out of their own file. Validated by
    /// `publish_url::validate_destination_url`, at parse time AND again at call time.
    pub url: String,
    /// A credential REFERENCE, never the secret: the keychain account key is derived from the
    /// destination's id (`publish_credential::account_key`). Nothing in this struct is a token, so
    /// a serialized `config.toml` can be pasted into a bug report without leaking one — which is
    /// pinned by a test rather than left to review.
    pub has_credential_in_keychain: bool,
}

/// Where Sparkle may publish ([publish]).
///
/// MACHINE-WIDE, like [concierge] and [pushers], and for the same kind of reason: a destination is
/// a network egress target that Sparkle sends a bearer token to. A repo that could set this would
/// grant itself one merely by being cloned with a block in its checked-in config, on a machine
/// whose owner never chose it. `build_effective` therefore ignores `[publish]` in a per-project
/// `.sparkle/config.toml` and warns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PublishConfig {
    /// The destination id publish ops act on. `None` until one is configured — the concierge's
    /// publish tools then refuse with "no destination configured" rather than guessing, which is
    /// the right failure when there is more than one row and no stated choice.
    pub active: Option<String>,
    /// Configured destinations, keyed by id. Empty on a fresh install; Sparkle can publish nowhere
    /// until the user configures one, which is the correct default for an outward-facing action.
    pub destinations: BTreeMap<String, PublishDestination>,
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

// ── Third-party marketplaces (Tier 2, sparkle-s3g2.7) ────────────────────────────────────────
//
// Four marketplaces owned by NEITHER Anthropic NOR Sparkle. Each `name` below is the top-level
// `"name"` field of that repo's `.claude-plugin/marketplace.json` — re-verified by fetching the
// raw file on 2026-08-25 — and it is the `@<marketplace>` half of every `enabledPlugins` key, so a
// plausible-but-wrong guess produces a settings file Claude Code silently ignores. Three of the
// four do NOT match their repo name, which is exactly the trap:
//   * `trailofbits`, from a repo called `skills` (not "trailofbits/skills", not "skills")
//   * `2389-research`, from a repo called `claude-plugins`
//   * `compound-engineering-plugin`, whose single plugin is named `compound-engineering`
// Sparkle pins none of these. `declared_source()` returns `Some` for every non-official
// marketplace, so all four are written into each worktree's `extraKnownMarketplaces` — which is
// what makes their plugin ids resolvable at all.

/// obra's marketplace — the upstream home of superpowers, and of the two writing/reasoning
/// plugins Sparkle pre-enables from it (`elements-of-style`, `double-shot-latte`).
pub const SUPERPOWERS_MARKETPLACE: &str = "superpowers-marketplace";
pub const SUPERPOWERS_MARKETPLACE_REPO: &str = "obra/superpowers-marketplace";

/// Every Inc's marketplace. NOTE the asymmetry: the marketplace is named
/// `compound-engineering-plugin` and the one plugin inside it is named `compound-engineering`.
pub const COMPOUND_ENGINEERING_MARKETPLACE: &str = "compound-engineering-plugin";
pub const COMPOUND_ENGINEERING_MARKETPLACE_REPO: &str = "EveryInc/compound-engineering-plugin";

/// Trail of Bits' security-skills marketplace. Named `trailofbits`, hosted in `trailofbits/skills`.
pub const TRAIL_OF_BITS_MARKETPLACE: &str = "trailofbits";
pub const TRAIL_OF_BITS_MARKETPLACE_REPO: &str = "trailofbits/skills";

/// 2389 Research's marketplace. Named `2389-research`, hosted in `2389-research/claude-plugins`.
pub const RESEARCH_2389_MARKETPLACE: &str = "2389-research";
pub const RESEARCH_2389_MARKETPLACE_REPO: &str = "2389-research/claude-plugins";

/// obra's marketplace as a source value.
const SUPERPOWERS_SOURCE: MarketplaceSource =
    MarketplaceSource { name: SUPERPOWERS_MARKETPLACE, repo: SUPERPOWERS_MARKETPLACE_REPO };

/// Every Inc's marketplace as a source value.
const COMPOUND_ENGINEERING_SOURCE: MarketplaceSource = MarketplaceSource {
    name: COMPOUND_ENGINEERING_MARKETPLACE,
    repo: COMPOUND_ENGINEERING_MARKETPLACE_REPO,
};

/// Trail of Bits' marketplace as a source value.
const TRAIL_OF_BITS_SOURCE: MarketplaceSource =
    MarketplaceSource { name: TRAIL_OF_BITS_MARKETPLACE, repo: TRAIL_OF_BITS_MARKETPLACE_REPO };

/// 2389 Research's marketplace as a source value.
const RESEARCH_2389_SOURCE: MarketplaceSource =
    MarketplaceSource { name: RESEARCH_2389_MARKETPLACE, repo: RESEARCH_2389_MARKETPLACE_REPO };

/// The plugins Sparkle knows how to pre-enable, across SIX marketplaces:
///
///   * Anthropic's official one ([`OFFICIAL_MARKETPLACE`]) — `superpowers`, `frontend-design`,
///     `hookify`, `code-simplifier`. Verified against anthropics/claude-plugins-official's
///     marketplace.json (2026-07-24, re-verified 2026-08-25). The official listing for
///     `superpowers` pins the exact same commit obra/superpowers is at, and official marketplaces
///     auto-update by default, so sourcing it there costs nothing in freshness.
///   * Sparkle's own ([`SPARKLE_MARKETPLACE`]) — the `sparkle-*` rows.
///   * Four THIRD-PARTY marketplaces owned by neither Anthropic nor Sparkle
///     ([`SUPERPOWERS_MARKETPLACE`], [`COMPOUND_ENGINEERING_MARKETPLACE`],
///     [`TRAIL_OF_BITS_MARKETPLACE`], [`RESEARCH_2389_MARKETPLACE`]). Sparkle pins none of them,
///     and the `[plugins]` TRUST block in `DEFAULT_TEMPLATE` has to keep saying so — that is
///     user-facing copy about whose content lands in every agent worktree, not documentation.
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
    // Tier 2 (sparkle-s3g2.7): default INSTALLED, invoked on demand. Unlike superpowers (a
    // methodology that shapes how an agent works throughout), these carry skills and commands an
    // agent reaches for when the situation calls for them — so the cost of shipping them on is one
    // idempotent install, and the benefit is that they are there at the moment they are relevant
    // rather than needing to be discovered and installed first.
    //
    // Both names confirmed present in anthropics/claude-plugins-official's marketplace.json.
    KnownPlugin {
        toggle: "hookify",
        plugin: "hookify",
        marketplace: OFFICIAL_MARKETPLACE,
        source: Some(OFFICIAL_SOURCE),
        default_on: true,
    },
    KnownPlugin {
        toggle: "code_simplifier",
        plugin: "code-simplifier",
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
    // The four rows below ship OFF, and — unlike the two above — NOT on their own merits. Each one
    // earns an eventual ON (the per-row notes say why), but the plugin CONTENT does not exist yet:
    // `try-sparkle/marketplace`'s `.claude-plugin/marketplace.json` lists only `sparkle-guardrails`,
    // `sparkle-mutation-check` and `sparkle-freshness`. Verified against GitHub, not the local
    // read-only clone at `~/.claude/plugins/marketplaces/sparkle`, which can be stale.
    //
    // Shipping a row ON before its content is published is not a no-op that resolves itself. The
    // install pass iterates the ENABLED set, so each missing plugin fails `claude plugin install`,
    // is deliberately left out of the ledger, and is therefore retried on EVERY launch — four extra
    // sequential subprocess round-trips at startup, a `plugin pre-enable: not installed` warn per
    // launch, and four of the nine rows in Settings → Tools rendering a persistent "Sparkle couldn't
    // install this plugin" hint with raw stderr attached. Four of nine rows reading as broken is a
    // worse first impression than four rows a user has to opt into.
    //
    // So the ordering is: catalog rows + their mirrors land first (this commit), the content lands
    // in the separate marketplace repo, and then these flip to `true`. That flip is the point at
    // which they become detectable — a plugin has to be INSTALLED to be observable at all, since the
    // Builder Index profile's SKILLS row is computed from the keys of
    // `~/.claude/plugins/installed_plugins.json` and enabling a plugin in settings does not fetch it
    // (see the AUTO-INSTALL note at the top of this section). Tracked as a bead; do not flip one of
    // these ON without first confirming its name appears in that marketplace listing.
    //
    // THE FLIP IS NOT ONE LINE PER ROW, AND ASSUMING IT IS SILENTLY STRANDS AN ENTIRE COHORT.
    // `DEFAULT_TEMPLATE` below is not documentation: `load_document_for_write` falls back to it on
    // `NotFound` and the caller persists the whole rendered document, so the FIRST settings write on
    // a fresh machine materializes a real `config.toml` containing the literal lines
    // `sparkle_conflict_watch = false`, `sparkle_secrets = false`, `sparkle_review_probes = false`,
    // `sparkle_pusher = false`. A key PRESENT in the user's file beats `default_on`, so every user
    // who touched settings during this interim keeps all four OFF forever — silently, and precisely
    // in the undetectable state the paragraph above argues against. `every_known_plugin_has_a_live_toggle`
    // forces the table and the template to flip together, but neither reaches a file already on disk.
    //
    // So the flip commit MUST also carry a one-shot migration that removes these four keys from an
    // existing `config.toml` (dropping the key, not rewriting its value — a user who deliberately
    // set `false` keeps that, because the key they wrote is indistinguishable from ours only if we
    // stop at the value; prefer keying the migration on the template's exact rendered line). The
    // tripwire test that goes red on the flip repeats this, so it cannot be missed.
    //
    // Earns ON: a PR that cannot merge is a PR that was never TESTED, and nothing on the PR page
    // says so — a conflicting PR never fires GitHub's `pull_request` event, so no CI run is ever
    // created and its checks are absent rather than failing. That is a standing hazard on every
    // branch, not something to reach for.
    KnownPlugin {
        toggle: "sparkle_conflict_watch",
        plugin: "sparkle-conflict-watch",
        marketplace: SPARKLE_MARKETPLACE,
        source: Some(SPARKLE_SOURCE),
        default_on: false,
    },
    // Earns ON: this is the SKILL (how to back a project's `.env` up and, more importantly, how to
    // restore it without the traps that bite in practice). It is knowledge an agent needs at the
    // moment it is about to touch a secret, which is never a moment it thinks to go install
    // something. Distinct from `[tools].onepassword`, which ships OFF because that one needs an
    // account, the `op` CLI and a chosen vault before it can do anything — and which is the switch
    // that actually performs backups. This row only carries the knowledge.
    KnownPlugin {
        toggle: "sparkle_secrets",
        plugin: "sparkle-secrets",
        marketplace: SPARKLE_MARKETPLACE,
        source: Some(SPARKLE_SOURCE),
        default_on: false,
    },
    // Earns ON: an unanswered `[blocking]` review probe is only useful if it is checked BEFORE the
    // merge, and the merge is exactly when nobody stops to install a plugin.
    KnownPlugin {
        toggle: "sparkle_review_probes",
        plugin: "sparkle-review-probes",
        marketplace: SPARKLE_MARKETPLACE,
        source: Some(SPARKLE_SOURCE),
        default_on: false,
    },
    // Earns ON: the whole point is surfacing a fleet condition to a human PROACTIVELY. A version of
    // this that has to be asked for first has already failed at the one thing it does.
    KnownPlugin {
        toggle: "sparkle_pusher",
        plugin: "sparkle-pusher",
        marketplace: SPARKLE_MARKETPLACE,
        source: Some(SPARKLE_SOURCE),
        default_on: false,
    },
    // ── Tier 2, third-party marketplaces (sparkle-s3g2.7) ────────────────────────────────────
    //
    // These five ship ON, and unlike the `sparkle_*` rows above there is nothing provisional about
    // it: every plugin name below was confirmed present in its marketplace's live
    // `.claude-plugin/marketplace.json` on 2026-08-25, so the install pass resolves each on the
    // first try rather than retrying a failing `claude plugin install` every launch. The warning
    // above the four unpublished `sparkle_*` rows — "do not flip one of these ON without first
    // confirming its name appears in that marketplace listing" — is what that confirmation
    // satisfies; it does not apply to a row whose content already exists.
    //
    // What IS different about them: Sparkle neither owns nor pins these marketplaces, so turning
    // them on by default means Sparkle fetches third-party content into every agent worktree. The
    // `[plugins]` TRUST block in `DEFAULT_TEMPLATE` names each owner for exactly that reason.
    KnownPlugin {
        toggle: "elements_of_style",
        plugin: "elements-of-style",
        marketplace: SUPERPOWERS_MARKETPLACE,
        source: Some(SUPERPOWERS_SOURCE),
        default_on: true,
    },
    KnownPlugin {
        toggle: "double_shot_latte",
        plugin: "double-shot-latte",
        marketplace: SUPERPOWERS_MARKETPLACE,
        source: Some(SUPERPOWERS_SOURCE),
        default_on: true,
    },
    // The marketplace is `compound-engineering-plugin`; the plugin inside it is
    // `compound-engineering`. They are NOT the same string, and swapping them writes an
    // `enabledPlugins` key Claude Code ignores without complaint.
    KnownPlugin {
        toggle: "compound_engineering",
        plugin: "compound-engineering",
        marketplace: COMPOUND_ENGINEERING_MARKETPLACE,
        source: Some(COMPOUND_ENGINEERING_SOURCE),
        default_on: true,
    },
    KnownPlugin {
        toggle: "differential_review",
        plugin: "differential-review",
        marketplace: TRAIL_OF_BITS_MARKETPLACE,
        source: Some(TRAIL_OF_BITS_SOURCE),
        default_on: true,
    },
    KnownPlugin {
        toggle: "review_squad",
        plugin: "review-squad",
        marketplace: RESEARCH_2389_MARKETPLACE,
        source: Some(RESEARCH_2389_SOURCE),
        default_on: true,
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
    /// Runtime arm for the never-idle watcher (the in-app nudge that auto-resumes an idle Improve
    /// Sparkle agent). A plain `bool` — always serialized, never `null` — so the TS reader sees
    /// `true`/`false`, not an absent key. Defaults `true`: the founder chose to arm it by default,
    /// replacing the old build-time `VITE_SPARKLE_NEVER_IDLE` flag so it can be toggled from this
    /// file without cutting a new DMG. The watcher's other guards (an actually-idle Improve Sparkle
    /// agent with ready backlog, in the window that owns sparkle-self) are what keep an armed build
    /// from nudging when there is nothing to do.
    pub never_idle_armed: bool,
}

/// The BACKLOG DRAINER's master switch (`[drainer]`) — bead-backlog auto-drain, ON by default.
///
/// Once the app ships in a DMG, the launch-time consumer (`drainer.rs`, wired from `lib.rs`'s
/// `setup`) reads this value and, when ON, idempotently INSTALLS the LaunchAgent supervisor via
/// `scripts/backlog-drainer.sh --install`; when OFF it runs `--uninstall`, so nothing is scheduled
/// and no worker is ever spawned. The scheduled `--watchdog` pass then drains the sparkle-self
/// `agent-feedback` bead backlog, resting when it is at/below a floor. The deterministic
/// floor/cap/claim decisions live in `scripts/backlog-drainer.sh`; this section is only the KILL
/// SWITCH both the launch consumer and the watchdog read. (Modelled on the `[roborev]` daemon-ensure
/// at launch — a launchd job installed/removed from config — NOT an in-process Rust/TS loop.)
///
/// `enabled` is a CONCRETE bool, not `Option<String>` like `[improvement].consent`: unlike that
/// mirror, this value is NOT persisted to localStorage (see `settingsStore.ts` `drainerEnabled`,
/// modelled on `roborevEnabled`), so it is re-read from the file each launch and there is no
/// persisted choice for a defaulted value to clobber. It serializes as `true`/`false`.
///
/// Ships TRUE — the founder's directive: zero human steps, on by default. That is defensible for the
/// same reason as `[babysit]`/`[pushers]`: the worst case is bounded (the shell engine honors a
/// conservative worker cap and a rest floor, and refuses to CLAIM at all unless a dispatch consumer
/// is wired), and a human can switch it off without a rebuild by setting `enabled = false` — which
/// the launch consumer honors by uninstalling the LaunchAgent. The shell engine additionally honors
/// `SPARKLE_DRAINER_ENABLED=0`.
///
/// GLOBAL ONLY, like `[babysit]`: how much of this machine's Claude quota an autonomous loop may spend
/// is a property of the human at the machine, not of a repo. A `[drainer]` in a per-project file is
/// not applied (it is only overlaid in the global layer, `build_effective`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DrainerConfig {
    /// Master switch for the in-app backlog drainer loop. Ships TRUE. `false` makes the loop fully
    /// inert (it dispatches nothing and never spawns a worker).
    pub enabled: bool,
}

/// Settings for the Builder Index REPORTER (`builder_index.rs`) — what it publishes, once the
/// separate `[tools].builder_index` switch has turned it on.
///
/// Two different questions, deliberately two sections. `[tools].builder_index` is the master
/// on/off, alongside every other tool toggle; this section is the reporter's own behaviour and is
/// meaningless when the tool is off. Merging them would have put a name list inside a table
/// documented as one-boolean-per-tool.
///
/// Machine-wide, like [tools] and [roborev]: a cloned repo does not get to decide what this machine
/// publishes about its owner — in either direction. A per-project `[builder_index]` is ignored with
/// a warning.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BuilderIndexConfig {
    /// Skill names to withhold from the profile's SKILLS row — a DENYLIST applied on top of the
    /// allowlist that the installed-plugin manifest already is.
    ///
    /// Stored NORMALIZED (trimmed, lowercased, empties dropped), which is what makes matching total:
    /// the reporter lowercases and trims the candidate too, so `" WARP "` here excludes `warp` on
    /// the wire. That is not a stylistic choice — it is tkmx-client's `applyExclusions` semantics
    /// (`reporter/skills.ts`: `.trim().toLowerCase()` on both sides), and the two reporters MUST
    /// agree. They alternate posting for the same profile, and the server replaces `claude_skills`
    /// wholesale, so a name one of them drops and the other keeps makes the badge flap every couple
    /// of hours instead of disappearing.
    pub skills_exclude: Vec<String>,
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
    /// When true, a checkout that is PROVABLY safe to advance — clean working tree, sitting on the
    /// default branch, and a strict ancestor of `origin/<default>` — may be fast-forwarded without
    /// a click. Every other shape (dirty, detached, a feature branch, or diverged) still waits for
    /// an explicit user action, and nothing destructive is ever run. See `repo_freshness`.
    pub auto_fast_forward: bool,
}

/// The cross-agent + human @mention channel (bead sparkle-hdlhox, `mention.rs`). Per-project
/// overridable like [freshness]. The frontend reads these and passes them to `mention_send`; Rust
/// enforces the cap regardless (a hard stop lives in `route_mention`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct MentionConfig {
    /// ANTI-LOOP: how many rounds an @improve↔@sparkle exchange may run before it is hard-stopped.
    /// A round is one `mention_send`. Mirrors `DEFAULT_MAX_MENTION_ROUNDS` in `mention.rs`.
    pub max_rounds: u32,
    /// How long the sender waits for the recipient's ACK bead comment before treating the mention as
    /// UNDELIVERED (silence is never read as agreement). Mirrors `DEFAULT_ACK_DEADLINE_MS`.
    pub ack_deadline_ms: u32,
}

/// WHICH PR-SCOPED REVIEWER WATCHES A REPO, or `none` if there isn't one. Per-project overridable
/// (like [freshness]) because one machine routinely works on repos that have a reviewer and repos
/// that do not — this is a property of the REPO, not of the laptop.
///
/// WHY THIS IS CONFIGURABLE AT ALL. knightwatch runs on someone else's machine and is reachable
/// only through GitHub comments — there is no endpoint to probe and no credential we hold. When
/// that access ends, the COVERAGE half of the probe gate (`knightwatch::coverage`) stops being
/// "unanswered" and becomes UNANSWERABLE: no new review can ever name the current head, so
/// `NotCovered` is permanent and its own remedy ("post `/srosro-update-review` and wait for the
/// review to land") can never complete. Every already-reviewed PR in the repo becomes unmergeable
/// except through a recorded override — the remedy-that-cannot-be-followed shape AGENTS.md names.
///
/// IT RETIRES THE COVERAGE HALF ONLY. Unanswered `[blocking]` probes already posted on a PR are
/// REAL FINDINGS, and a reviewer going away does not answer the questions it already asked; those
/// still refuse the merge. Collapsing the two is the one way to get this wrong.
///
/// KEEP THE DEFAULT IN STEP WITH `scripts/lib/sparkle-config.sh`'s callers — the shell gate
/// (`scripts/probe-gate.sh`) reads this same key and passes its own fallback, and the two
/// implementations disagreeing about one PR is exactly the drift the shared fixture corpus exists
/// to prevent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ReviewConfig {
    /// `"knightwatch"` (default — today's behaviour) or `"none"`. Free-form rather than an enum so
    /// a future reviewer can be named here without a schema migration; any value that is not the
    /// word `none` means "a reviewer is expected", which is the fail-closed direction.
    pub pr_reviewer: String,
    /// Whether a PR carrying NO review at all is refused rather than waved through.
    ///
    /// `false` by default, and the default is the decision: the coverage half only applies when at
    /// least one review exists, so until this key is set, "never run the reviewer" is a free pass.
    /// Measured the day it landed, 31 of 32 open PRs in this repo were in exactly that state, so
    /// defaulting it on would have blocked the open fleet the moment it shipped.
    pub require_review: bool,
}

impl ReviewConfig {
    /// True when NO PR-scoped reviewer watches this repo, so the coverage gate cannot ever be
    /// satisfied and must not block.
    ///
    /// THE MATCH IS TRIMMED AND CASE-INSENSITIVE, and `scripts/probe-gate.sh` normalises the same
    /// way before its own comparison. That agreement is the whole point: the config reader used by
    /// the shell side (`_sparkle_awk_get`) returns the text between the quotes VERBATIM, so a
    /// byte-exact rule on one side and a lenient one on the other makes `"None"` retire the gate for
    /// the in-app merge button while `gh pr merge` still refuses the same PR — the harder direction
    /// to debug, because the app reports the gate as off. Change one side and you must change both.
    ///
    /// Leniency stops at whitespace and case: `nonesuch` is NOT `none`, so a typo leaves the gate
    /// ON rather than silently off.
    pub fn has_no_pr_reviewer(&self) -> bool {
        self.pr_reviewer.trim().eq_ignore_ascii_case("none")
    }

    /// True when a PR with NO review must be REFUSED rather than waved through.
    ///
    /// SUBORDINATE TO [`Self::has_no_pr_reviewer`], and the caller must check that FIRST. A repo
    /// nobody reviews cannot produce the review this would demand, so arming the key there would
    /// make every PR permanently unmergeable — the opposite of what the `none` hatch is for.
    ///
    /// THE TYPO DIRECTION IS INVERTED relative to its sibling above, deliberately. There, anything
    /// that is not `none` leaves the gate ON, because a misspelling must not silently DISARM a
    /// gate. Here the key ARMS one, so nothing but the word `true` counts — a misspelling must not
    /// silently start refusing every PR in a repo that never asked for it. One rule, both ways: a
    /// typo may never change behaviour by accident.
    ///
    /// NO NORMALISATION TO DO, unlike its sibling. This is a TOML *boolean*, whose grammar admits
    /// only the bare lowercase tokens `true` and `false` — `TRUE` and `"true"` are not booleans and
    /// this `Option<bool>` refuses them outright. `scripts/probe-gate.sh` reads the file as text
    /// rather than as TOML, so it compares against the exact string `true` and deliberately does
    /// NOT case-fold: folding there would arm the gate on input this side rejects, which is the
    /// two-implementations-disagree failure the shared corpus exists to prevent. Change one side
    /// and you must change both.
    pub fn requires_review(&self) -> bool {
        self.require_review
    }
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

/// Live in-app browser preview (`preview.rs`). Repo-scoped + per-project overridable (like
/// [freshness]/[worktree_pool]), because whether a project is worth previewing — and how eagerly —
/// is a property of the project.
///
/// **There is deliberately no `max_servers`.** A `PreviewSlot` covers one pair and there are two
/// pairs, so at most two previews can be visible at once: the ceiling is a property of the layout,
/// not of a counter. An earlier draft specified one with LRU eviction; that is machinery whose
/// eviction path could never fire. See `docs/live-browser-preview.md` §4.
///
/// A project's `.sparkle/config.toml` may ALSO carry `command`/`args`/`path` under `[preview]` as
/// the highest-priority detection override. Those keys are read straight off the worktree's own
/// file by `preview::detect_preview_target` — detection runs against an arbitrary worktree path,
/// not against this merged app config — so they deliberately do not appear here. Serde ignores
/// unknown keys, so their presence in a project file is inert rather than a load error.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PreviewConfig {
    /// Master switch. false = never detect, never spawn a preview server.
    pub enabled: bool,
    /// How long a preview keeps serving after the last SIGN OF LIFE, before it is stopped.
    ///
    /// THIS MEASURES IDLENESS, NOT INVISIBILITY. It used to be written as "after its pane is
    /// covered": a preview lived in a pane that flipping the pair to Plan would cover, so "nobody
    /// is looking" was a fact the frontend could read off the layout. The pane was removed on
    /// 2026-08-19 (a preview is a card in the concierge chat, not a peer column) and a CARD CANNOT
    /// BE COVERED — so the covered-ness this key was phrased around became permanently false for
    /// every healthy preview, and the timer that enforced it stopped bounding anything at all. A
    /// dev server ran until worktree teardown or app exit while this doc went on naming
    /// `idle_grace_min` as one of the three things that stop a server (bead `sparkle-9yck3i`).
    ///
    /// What restarts the window, per `services/previewIdleGrace.ts`, which owns the timer:
    ///   • any `preview:state` update for that preview — including a repeat that changes nothing;
    ///   • a human or an agent touching it: the card's refresh, a click through to the url, a
    ///     `preview_inspect` capture.
    /// Note that `supervise()` in `preview.rs` goes quiet once a server is `Ready` (it transitions
    /// again only to `Crashed`/`Failed`), so on a preview nobody touches the second bullet is the
    /// only thing that can move this clock — which is exactly the case the window is here to end.
    ///
    /// STILL A GRACE PERIOD, NOT A CAP. Anything that wants the preview restarts the whole window,
    /// so an actively-used server is never reclaimed on a schedule; and the window is generous
    /// because a cold restart is not free (10–30s of compile for Next).
    pub idle_grace_min: u32,
    /// How eagerly an AGENT is told to OPEN a preview of its own work, in the brief it is given.
    ///
    /// THE ONLY REMAINING QUESTION ABOUT WHEN, now that `auto_open` is gone. That key decided when a
    /// preview PANE could reveal itself unasked; the pane was removed on 2026-08-19 (the founder:
    /// a preview is a card in the concierge chat, not a peer column beside Build and Plan), and a
    /// card needs no permission to appear — it is a projection of the live preview state, so
    /// surfacing is automatic. What is left to govern is whether a preview is opened AT ALL.
    ///
    /// Values, and every one of them is a real position rather than a slider:
    ///   • `"visual"` (default) — the brief tells the agent to open a preview whenever the work
    ///     changes something a person would LOOK at. Silent on the rest, so a pure refactor or a
    ///     config edit costs nothing.
    ///   • `"always"` — open one whenever the project can be previewed at all, whatever the change.
    ///   • `"never"`  — the brief says nothing about previews. The manual affordances are untouched;
    ///     this only stops Sparkle from asking on your behalf.
    ///
    /// Anything else is rejected in `validate` and falls back to `"visual"`.
    pub agent_eagerness: String,
}

/// The accepted values of `[preview].agent_eagerness`.
const PREVIEW_AGENT_EAGERNESS_MODES: &[&str] = &["visual", "always", "never"];

/// Ceiling for `[preview].idle_grace_min`. Two hours is far past any pause in the work the grace
/// exists to absorb (a long build, a meeting, reading the diff), and short enough that a forgotten
/// preview cannot outlive a working session. See the note at its check in `validate`.
const PREVIEW_IDLE_GRACE_MAX_MIN: u32 = 120;

/// Display preferences for surfaces the founder READS rather than configures — today, just the
/// shape a bead card draws in when the concierge names a bead. Machine-wide (like
/// [capture]/[voice]): how a card renders is a property of the person reading the column, not of
/// any repo, so a per-project value is ignored with a warning.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct UiConfig {
    /// Render a bead card EXPANDED the moment the concierge names it, instead of as a pill the
    /// reader has to click open. The founder's ask, verbatim: "I wanna try changing things such
    /// that you show these bead cards as expanded by default and of me having to click on them to
    /// expand them." Default true.
    ///
    /// SET IT `false` AND THE BEHAVIOUR IS EXACTLY WHAT SHIPPED BEFORE — every card starts
    /// collapsed and opens on a click. That is the whole revert, and it is deliberately ONE key:
    /// "let's give that a try" is an experiment, and an experiment needs an off switch that does
    /// not require finding every place a default leaked to.
    pub bead_cards_expanded: bool,
    /// How many cards ONE REPLY may expand before the rest fall back to pills. `0` = NO CAP, and
    /// that is the shipped default: the founder chose to find the ceiling by feel rather than have
    /// one guessed for him. A reply routinely names eight or more beads and each expanded card runs
    /// several hundred pixels, so this is the knob to reach for if the transcript starts swamping
    /// the prose between the cards.
    ///
    /// THE CAP COUNTS ONLY IDS THAT RESOLVE to a real bead, which is not a detail. The linkifier
    /// upstream is loose BY DESIGN and hands the renderer every id-SHAPED token in the message —
    /// ordinary hyphenated English like "auto-heal" and "one-shot" included — so a cap spent on
    /// prose would collapse the one card the reader actually wanted. See `BeadPill.tsx`.
    pub bead_cards_expanded_max: u32,
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

/// Voice controls: which MICROPHONE Sparkle captures from, and nothing else. Machine-wide (like
/// [workers]/[ai]/[capture]) because a microphone belongs to the machine, not to a repo — a
/// per-project value is ignored with a warning.
///
/// The wake word is retired. Dictation is started and stopped by the send tray (Send / Push to
/// talk / Speak), so there are no spoken start/stop phrases and no submit-listening preference to
/// configure; `wake_word`, `stop_word` and `pause_on_submit` used to live here and are gone.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VoiceConfig {
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

/// The FLEET's global CI-concurrency budget — the systemic version of the manual "pause the fleet".
///
/// ~40 build agents each ship their branch (push + open a PR), and each PR fans out a full CI matrix
/// on ONE shared, hard-capped self-hosted runner pool (`linux-ci`). With no coordination they
/// collectively saturate it and starve everything downstream — most visibly the release DMG, whose
/// base-CI run then can't get a runner (see PRD/sparkle/ci-throughput-refactor.md, workstream D).
/// This caps how many ships may have CI-triggering work IN FLIGHT at once; the rest QUEUE and drain
/// as slots free, and a release in progress pauses the fleet's ships entirely so its CI gets runners.
///
/// MACHINE-WIDE, not per-project — the SAME reasoning as [workers]/[pushers]: a cloned repo does not
/// get to decide how much of this machine's fleet may hammer the shared pool. A per-project
/// `[fleet]` is ignored with a warning (build_effective), exactly like [workers].
///
/// The governor that reads this lives on the TS side (`services/ciBudgetGovernor.ts`); the
/// release-in-progress / pool-saturation backpressure it needs comes from `pipeline_health.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FleetConfig {
    /// Max number of build-agent ships that may have CI-triggering work presumed in flight at once.
    /// A new ship past this QUEUES until a slot frees. **0 disables the governor** (every ship pushes
    /// immediately, the pre-governor behaviour) — the opt-out, not "no budget". Default 6: sized just
    /// under the 8-VM `linux-ci` pool so a fleet burst leaves runner headroom for a release's base CI.
    pub ci_budget: u32,
    /// How long, in seconds, one occupied slot is held after its ship pushes — i.e. how long a CI run
    /// is PRESUMED in flight before the slot auto-frees. A safety drain, not a completion signal (the
    /// app does not poll each run to completion); the release-priority hold and pool-saturation
    /// backpressure are the real protections. Default 900 (15 min ≈ a full CI matrix's wall-clock).
    pub ci_lease_secs: u32,
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
    /// Where Sparkle may publish a post. Machine-wide for the same reason as [concierge]: a
    /// destination is a network egress target Sparkle sends a bearer token to.
    pub publish: PublishConfig,
    pub freshness: FreshnessConfig,
    /// The cross-agent + human @mention channel knobs (anti-loop cap, ACK deadline).
    pub mention: MentionConfig,
    /// Which PR-scoped reviewer watches this repo, or `none`. Per-project overridable; the shell
    /// merge gate reads the same key out of `.sparkle/config.toml`.
    pub review: ReviewConfig,
    pub worktree_pool: WorktreePoolConfig,
    /// Live in-app browser preview (repo-scoped + per-project overridable).
    pub preview: PreviewConfig,
    pub capture: CaptureConfig,
    /// Reader-facing display preferences (bead-card expansion). Machine-wide (see UiConfig).
    pub ui: UiConfig,
    pub voice: VoiceConfig,
    /// Per-category Sparkle Auto-Approve rules (repo-scoped overridable, like [workflow]/[freshness]).
    pub approvals: ApprovalsConfig,
    /// The concierge's per-tool autonomy policy. Machine-wide (see ConciergeConfig).
    pub concierge: ConciergeConfig,
    /// The Pusher's operating envelope. Machine-wide (see PushersConfig) — a repo does not get to
    /// decide how much this machine's agents are challenged.
    pub pushers: PushersConfig,
    /// The `/babysit-pr` auto-dispatch sweep's envelope, including its kill switch. Machine-wide for
    /// the same reason as [pushers]: a repo does not get to decide how much of this machine's
    /// Claude quota is spent answering review probes.
    pub babysit: BabysitConfig,
    /// The second-model advisor pass at the epic planning→execution boundary. Machine-wide for the
    /// same reason as [pushers]/[babysit] — which model this machine spends its owner's quota on is
    /// a property of the human at it. See AdvisorConfig.
    pub advisor: AdvisorConfig,
    /// Per-project "Done" stage definition (see the Definable Done & Delivered feature).
    pub done: DoneConfig,
    /// Per-project "Delivered" stage definition + detected production-ship signal.
    pub delivered: DeliveredConfig,
    /// What the Builder Index reporter publishes, once `[tools].builder_index` has turned it on.
    /// Machine-wide (see BuilderIndexConfig).
    pub builder_index: BuilderIndexConfig,
    /// The fleet's global CI-concurrency budget + release priority. Machine-wide (see FleetConfig) —
    /// a repo does not get to decide how much of this machine's fleet may hammer the shared pool.
    pub fleet: FleetConfig,
    /// The in-app backlog drainer's kill switch. Machine-wide (see DrainerConfig). Placed at the end
    /// of the struct, well away from `improvement:`, so it does not textually collide with PR #2281.
    pub drainer: DrainerConfig,
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
                // EMPTY for the reason on the field: every repo is foreign until the human names
                // his org, which reproduces today's global `ask` stopgap rather than loosening it.
                own_orgs: Vec::new(),
                // Empty like `tools`, and for the same reason: a project entry is a TIGHTENING the
                // human wrote, never something Sparkle infers.
                projects: std::collections::BTreeMap::new(),
            },
            // Ships ENABLED — the founder's decision over the fail-safe default; see
            // `PushersConfig::enabled`. Stated once in `PushersConfig::default()` so this line, the
            // struct, and DEFAULT_TEMPLATE cannot drift apart.
            pushers: PushersConfig::default(),
            // Opinionated defaults: every tool ships on for a new install — except onepassword,
            // which needs an external account + CLI before it can do anything (see the field doc).
            tools: ToolsConfig {
                analytics: true,
                beads: true,
                github: true,
                guardrails: true,
                humanebench: true,
                // The default-OFF reporting tools: nothing about this machine reaches EITHER public
                // leaderboard until the user turns one on AND answers its consent modal. They are
                // independent destinations — turning one on says nothing about the other.
                roborev: true,
                builder_index: false,
                straude: false,
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
            improvement: ImprovementConfig { consent: None, never_idle_armed: true },
            babysit: BabysitConfig {
                enabled: true,
                cooldown_minutes: 30,
                recovery_cooldown_minutes: 5,
                max_dispatches_per_hour: 4,
            },
            // Ships ENABLED, and unlike [pushers] that needs no argument: the ZERO-SPEND GATE bounds
            // this, not the flag. Stated once in `AdvisorConfig::default()` so this line, the struct
            // and DEFAULT_TEMPLATE cannot drift apart.
            advisor: AdvisorConfig::default(),
            // No vault and no account until the user picks them, and no worktree seeding until they
            // ask for it. An unset account_id means "let `op` decide", which is right whenever
            // exactly one account is signed in.
            onepassword: OnePasswordConfig {
                vault_id: None,
                account_id: None,
                seed_worktrees: false,
            },
            // Sparkle can publish nowhere until the user configures a destination. For an
            // outward-facing action that is the only defensible default: a shipped default
            // destination would be a network egress target nobody chose.
            publish: PublishConfig { active: None, destinations: BTreeMap::new() },
            freshness: FreshnessConfig {
                // Keep these in sync with the bash fallback in scripts/lib/sparkle-config.sh.
                staleness_warn_commits: 25,
                stale_build_block_commits: 25,
                require_fresh_branch: true,
                auto_fast_forward: true,
            },
            // Keep in sync with DEFAULT_MAX_MENTION_ROUNDS / DEFAULT_ACK_DEADLINE_MS in mention.rs.
            mention: MentionConfig { max_rounds: 6, ack_deadline_ms: 3 * 60 * 1000 },
            review: ReviewConfig {
                // Today's behaviour: assume a PR-scoped reviewer IS watching, so a repo that never
                // writes this key keeps its coverage gate. Keep in sync with the bash fallback
                // passed by scripts/probe-gate.sh.
                pr_reviewer: "knightwatch".to_string(),
                // OFF: a repo that never writes this key keeps waving unreviewed PRs through,
                // exactly as it did before the key existed. Keep in sync with the bash fallback
                // passed by scripts/probe-gate.sh.
                require_review: false,
            },
            // Pre-warm a small pool by default so the common fan-out spawn skips `git worktree add`.
            worktree_pool: WorktreePoolConfig { enabled: true, size: 2 },
            // On by default: previewability detection DECLINES cleanly (returns None) for a project
            // it can't read, so the cost of it being on for a non-web repo is one bounded scan.
            preview: PreviewConfig {
                enabled: true,
                idle_grace_min: 10,
                // VISUAL BY DEFAULT — a product default, not a preference. Sparkle's users judge a
                // change by looking at it, and a URL that scrolled past in a terminal is a change
                // nobody looked at. "visual" is the honest middle: it asks for a preview exactly
                // where one would have been worth having, and stays quiet for work that has
                // nothing to see.
                agent_eagerness: "visual".into(),
            },
            capture: CaptureConfig { popover_shortcut: "ctrl+shift+r".into() },
            // Expanded, uncapped. Both halves are the founder's explicit choice (see UiConfig):
            // cards open on sight, and NO cap — he would rather meet the ceiling and dial it down
            // than have a number picked for him. `bead_cards_expanded = false` is the whole revert.
            ui: UiConfig { bead_cards_expanded: true, bead_cards_expanded_max: 0 },
            voice: VoiceConfig { input_device_uid: None, allow_virtual_input: false },
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
            // Nothing withheld by default. An empty denylist is the honest default: the reporter's
            // allowlist is already "plugins you installed", so a name only reaches the profile
            // because the user put it on this machine.
            builder_index: BuilderIndexConfig { skills_exclude: Vec::new() },
            // Governor ON by default, sized just under the 8-VM linux-ci pool so a fleet burst leaves
            // runner headroom for a release's base CI. `ci_budget = 0` in the global config.toml opts
            // out. Lease ≈ a full CI matrix's wall-clock (the safety drain, not a completion signal).
            fleet: FleetConfig { ci_budget: 6, ci_lease_secs: 900 },
            // Ships ENABLED — the founder's directive (zero human steps, on by default). The worker
            // cap + rest floor in scripts/backlog-drainer.sh bound the worst case, and `enabled =
            // false` (or SPARKLE_DRAINER_ENABLED=0) is the rebuild-free kill switch. Stated as a
            // literal so this line, the struct, and DEFAULT_TEMPLATE cannot drift apart.
            drainer: DrainerConfig { enabled: true },
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
    plan: Option<String>,
    /// `Option` HERE, unlike the bare `bool` on `ApprovalsConfig`, because this struct answers a
    /// different question: not "what is the value" but "did THIS layer say anything?" — which is
    /// exactly what lets an absent project key fall through to the global one.
    concierge_answers: Option<bool>,
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
    /// A bare `Value` for the reason on `tools`: `own_orgs = "drodio"` (the singular form, an easy
    /// thing to reach for) would otherwise fail the WHOLE-FILE parse and revert every unrelated
    /// setting. It costs that one line instead.
    own_orgs: Option<toml::Value>,
    /// A bare `Value` for the reason on `tools`, and it matters more here than anywhere else in
    /// this struct: these keys are repo slugs, so they carry `/` and `.` and MUST be quoted. A
    /// missing quote is the single most likely hand-edit mistake in this section, and it must cost
    /// the reader that one rule rather than the whole global layer.
    projects: Option<toml::Value>,
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

/// `[pushers]` as read from TOML.
///
/// EVERY value is `toml::Value`, never a typed field, for the reason recorded on
/// `PartialConcierge::tools` (roborev 54240): with strong types, ONE hand-edit —
/// `enabled = "yes"`, `messages_per_hour = "two"` — fails `toml::from_str::<PartialConfig>` for the
/// WHOLE FILE. That discards the entire global layer and sets `hard_error`, so every unrelated
/// setting the user wrote silently reverts to its default. One typo in one Pusher knob must cost
/// exactly that knob, and `apply_pushers` drops it with a warning instead.
///
/// `#[serde(flatten)]` collects every key this build does not know into `rest`, so `apply_pushers`
/// can REPORT a misspelling. The field set is authoritative right here (`PushersConfig` is the
/// struct), unlike `[concierge.checks]`'s check ids — so `mesages_per_hour` is a typo, not a
/// setting from the future, and left silent it would parse, apply nothing, and say nothing while
/// the Pusher kept talking at its shipped rate.
#[derive(Debug, Default, Deserialize)]
struct PartialBabysit {
    enabled: Option<toml::Value>,
    cooldown_minutes: Option<toml::Value>,
    recovery_cooldown_minutes: Option<toml::Value>,
    max_dispatches_per_hour: Option<toml::Value>,
    #[serde(flatten)]
    rest: std::collections::BTreeMap<String, toml::Value>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialPushers {
    enabled: Option<toml::Value>,
    observe_interval_ms: Option<toml::Value>,
    messages_per_hour: Option<toml::Value>,
    inbox_yield_pct: Option<toml::Value>,
    #[serde(flatten)]
    rest: std::collections::BTreeMap<String, toml::Value>,
}

/// `[advisor]` as read from TOML.
///
/// EVERY value is `toml::Value` for the reason `PartialPushers` above records: with strong types,
/// ONE hand-edit (`enabled = "yes"`, `model = 3`) fails `toml::from_str::<PartialConfig>` for the
/// WHOLE FILE, discarding every unrelated setting the user wrote. One typo in one advisor knob must
/// cost exactly that knob, and `apply_advisor` drops it with a warning instead.
///
/// `#[serde(flatten)]` collects unknown keys into `rest` so a misspelling is REPORTED — the field
/// set is authoritative right here, so `modle` is a typo and not a setting from the future.
#[derive(Debug, Default, Deserialize)]
struct PartialAdvisor {
    enabled: Option<toml::Value>,
    model: Option<toml::Value>,
    #[serde(flatten)]
    rest: std::collections::BTreeMap<String, toml::Value>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialTools {
    analytics: Option<bool>,
    beads: Option<bool>,
    github: Option<bool>,
    guardrails: Option<bool>,
    humanebench: Option<bool>,
    roborev: Option<bool>,
    builder_index: Option<bool>,
    straude: Option<bool>,
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
    never_idle_armed: Option<bool>,
}

/// `[drainer]` as read from TOML. EVERY value is `toml::Value` for the reason `PartialPushers`/
/// `PartialBabysit` above record: with a strong `Option<bool>`, ONE hand-edit (`enabled = "false"`,
/// `enabled = "off"`) fails `toml::from_str::<PartialConfig>` for the WHOLE global layer, which is
/// then discarded (`hard_error`) — reverting every unrelated setting to defaults AND leaving the
/// drainer at its ON default, i.e. failing OPEN on a kill switch. `#[serde(flatten)] rest` reports a
/// misspelled key instead of silently swallowing it.
#[derive(Debug, Default, Deserialize)]
struct PartialDrainer {
    enabled: Option<toml::Value>,
    #[serde(flatten)]
    rest: std::collections::BTreeMap<String, toml::Value>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialOnePassword {
    vault_id: Option<String>,
    account_id: Option<String>,
    seed_worktrees: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialPublish {
    active: Option<String>,
    destinations: Option<BTreeMap<String, PartialPublishDestination>>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialPublishDestination {
    name: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialFleet {
    ci_budget: Option<u32>,
    ci_lease_secs: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialFreshness {
    staleness_warn_commits: Option<u32>,
    stale_build_block_commits: Option<u32>,
    require_fresh_branch: Option<bool>,
    auto_fast_forward: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialMention {
    max_rounds: Option<u32>,
    ack_deadline_ms: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialReview {
    pr_reviewer: Option<String>,
    require_review: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialWorktreePool {
    enabled: Option<bool>,
    size: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialPreview {
    enabled: Option<bool>,
    idle_grace_min: Option<u32>,
    agent_eagerness: Option<String>,
    // NOTE: `command`/`args`/`path` are NOT declared here on purpose — see `PreviewConfig`. Serde
    // ignores unknown keys, so a project file carrying them still parses.
}

#[derive(Debug, Default, Deserialize)]
struct PartialCapture {
    popover_shortcut: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialUi {
    bead_cards_expanded: Option<bool>,
    bead_cards_expanded_max: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct PartialVoice {
    // No `deny_unknown_fields` here (nor on any enclosing partial) ON PURPOSE: an install upgrading
    // from before the wake word was retired still has `wake_word` / `stop_word` /
    // `pause_on_submit` on disk. Serde's default is to IGNORE unknown keys, so those lines are
    // inert instead of failing the whole load and resetting every surviving setting.
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

/// `[builder_index]` as read from TOML.
///
/// `skills_exclude` is a bare `toml::Value` for the reason recorded on [`PartialConcierge::tools`]
/// (roborev 54240): with a typed `Vec<String>`, one hand-edit — `skills_exclude = "warp"`, the
/// comma-separated spelling tkmx-client's env var uses, which is the FIRST thing a user coming from
/// that reporter will type — fails `toml::from_str::<PartialConfig>` for the WHOLE FILE. That
/// discards the entire global layer and reverts every unrelated setting to its default. Here both
/// spellings are accepted and anything else costs exactly this one key.
#[derive(Debug, Default, Deserialize)]
struct PartialBuilderIndex {
    skills_exclude: Option<toml::Value>,
}

/// `[cleared]` in a `.sparkle/local.toml` — the SHADOW-UNSET list. Each entry is a dotted key that
/// the app was asked to clear and that is still SET in the tracked `.sparkle/config.toml`; the
/// tracked layer's value for it is dropped before the layers merge, so the resolved value falls
/// back exactly as if the tracked file had never carried the key.
///
/// It exists because the split gave "unset" nowhere to write. Removing a key from `local.toml`
/// cannot clear one that lives in the TRACKED file, and the writers may not touch that file — so
/// without this, clearing a pre-existing project rule wrote nothing, returned success, and the UI
/// re-pulled the tracked value and snapped the toggle back (roborev 66889). The rule was
/// unclearable from the UI, permanently, on every install that predates the split — which is every
/// install, since `.sparkle/config.toml` is simply where these values used to be written.
///
/// It is a LOCAL-layer mechanism only. In the tracked file it would be a repo asking to erase its
/// own keys, which is spelled "delete the line"; `apply_project_layer` warns and ignores it there.
#[derive(Debug, Default, Deserialize)]
struct PartialCleared {
    keys: Option<Vec<String>>,
}

/// The table name behind [`PartialCleared`]. Named once so the reader (serde, via the field above)
/// and the two writers cannot drift onto different spellings — a mismatch there is silent, and its
/// symptom is the original defect: a clear that writes a file and changes nothing.
const CLEARED_TABLE: &str = "cleared";

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
    babysit: Option<PartialBabysit>,
    onepassword: Option<PartialOnePassword>,
    publish: Option<PartialPublish>,
    freshness: Option<PartialFreshness>,
    mention: Option<PartialMention>,
    review: Option<PartialReview>,
    worktree_pool: Option<PartialWorktreePool>,
    preview: Option<PartialPreview>,
    capture: Option<PartialCapture>,
    ui: Option<PartialUi>,
    voice: Option<PartialVoice>,
    approvals: Option<PartialApprovals>,
    concierge: Option<PartialConcierge>,
    pushers: Option<PartialPushers>,
    advisor: Option<PartialAdvisor>,
    done: Option<PartialDone>,
    delivered: Option<PartialDelivered>,
    builder_index: Option<PartialBuilderIndex>,
    fleet: Option<PartialFleet>,
    drainer: Option<PartialDrainer>,
    cleared: Option<PartialCleared>,
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

fn apply_fleet(into: &mut FleetConfig, p: Option<PartialFleet>) {
    let Some(p) = p else { return };
    if let Some(v) = p.ci_budget {
        into.ci_budget = v;
    }
    if let Some(v) = p.ci_lease_secs {
        into.ci_lease_secs = v;
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
    if let Some(v) = p.auto_fast_forward {
        into.auto_fast_forward = v;
    }
}

fn apply_mention(into: &mut MentionConfig, p: Option<PartialMention>) {
    let Some(p) = p else { return };
    if let Some(v) = p.max_rounds {
        into.max_rounds = v;
    }
    if let Some(v) = p.ack_deadline_ms {
        into.ack_deadline_ms = v;
    }
}

fn apply_review(into: &mut ReviewConfig, p: Option<PartialReview>) {
    let Some(p) = p else { return };
    if let Some(v) = p.pr_reviewer {
        into.pr_reviewer = v;
    }
    if let Some(v) = p.require_review {
        into.require_review = v;
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

/// Which config file a partial came from. Two of the three are per-project and are treated
/// IDENTICALLY on authority — `Project` is the tracked `.sparkle/config.toml` (repo policy) and
/// `Local` the gitignored `.sparkle/local.toml` the app writes at runtime. Nothing keys off
/// `Local` to widen anything; it exists so a warning can name the file the user must actually edit,
/// and so `[preview]`'s asymmetric rule (a project may narrow it, never widen it) covers both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Layer {
    Global,
    Project,
    Local,
}

impl Layer {
    /// The path, as a user sees it in a warning, of the per-project file this layer came from.
    /// `Global` never reaches a per-project warning arm; it answers with the tracked file rather
    /// than panicking, because a wrong string in a remedy is better than a crashed config load.
    fn project_file(self) -> &'static str {
        match self {
            Layer::Local => ".sparkle/local.toml",
            _ => ".sparkle/config.toml",
        }
    }
}

/// `layer` says which file this partial came from. It exists for ONE field — see below.
fn apply_preview(
    into: &mut PreviewConfig,
    p: Option<PartialPreview>,
    layer: Layer,
    warnings: &mut Vec<String>,
) {
    let Some(p) = p else { return };
    if let Some(v) = p.enabled {
        // THE MASTER SWITCH ONLY EVER NARROWS AT PROJECT SCOPE. A project may turn preview OFF for
        // itself; it may NOT turn it back on for a user who disabled it globally.
        //
        // This is a security boundary of the same shape [concierge] and [pushers] draw a few
        // hundred lines below, and for the same reason: `enabled` gates SPAWNING A LONG-LIVED
        // PROCESS whose command line comes from repo-controlled data — the `[preview]`
        // command/args/path override in the project's own file, and failing that the `dev` script
        // out of its package.json. A repo that could flip this back on would hand itself the
        // ability to run a process on the user's machine merely by being cloned.
        //
        // SCOPE, stated because this is easy to over-read as more than it is: this closes the
        // RE-ENABLE path only. `enabled` defaults to TRUE, so in a default configuration a cloned
        // repo shipping `[preview] command`/`args` still supplies the command line of a long-lived
        // process and this narrowing never engages. It does NOT make a project-supplied command
        // safe by itself. That residual requirement belongs where the detector reads those keys:
        // a command/args from a repo the user has not vouched for should require confirmation, or
        // be restricted to naming a script already in the repo's package.json, rather than being
        // spawned on the first preview open. Tracked so it is not mistaken for handled.
        //
        // The other two fields are genuinely project properties and stay fully overridable: how
        // long a preview lingers, and how eagerly a pane opens, are not authority over the machine.
        if layer == Layer::Global || !v {
            into.enabled = v;
        } else if !into.enabled {
            // WARN ONLY WHEN THE VALUE IS ACTUALLY BEING REFUSED — i.e. the effective setting is
            // OFF and this project asked to turn it back on. That is the case the user needs told
            // about, and it is rare.
            //
            // The guard matters because `enabled` DEFAULTS TO TRUE. Warning unconditionally on
            // `layer == Project && v == true` fires on the overwhelmingly common shape — a project
            // file that writes `enabled = true` while the global layer is at its default — and
            // says "is ignored … set it in the global config.toml" about a preview that is already
            // ON. A permanent, incorrect instruction on every `build_effective` call, telling the
            // user to fix something that is not broken. (An earlier version of this arm did
            // exactly that; the test below now pins both halves.)
            //
            // The reason to warn at all is the sibling sections' ([capture], [voice], [concierge],
            // [pushers]): a hand-edited project file is the ONE path that still reaches here, and
            // silence would leave it with no feedback. The concierge refusal covers only the tool
            // path, which no longer reaches the config layer.
            warnings.push(format!(
                "[preview].enabled = true in a project's {} is ignored because the preview is \
                 disabled globally; a project may turn it off for itself but not back on — set it \
                 in the global config.toml",
                layer.project_file()
            ));
        }
    }
    if let Some(v) = p.idle_grace_min {
        into.idle_grace_min = v;
    }
    // Fully project-overridable, for the reason stated on `enabled` above: whether THIS project's
    // work is worth looking at is a property of the project, and asking an agent to open a preview
    // is not authority over the machine — `enabled` still gates whether any server may spawn.
    if let Some(v) = p.agent_eagerness {
        into.agent_eagerness = v;
    }
}

fn apply_capture(into: &mut CaptureConfig, p: Option<PartialCapture>) {
    if let Some(PartialCapture { popover_shortcut: Some(v) }) = p {
        into.popover_shortcut = v;
    }
}

/// Per-KEY, not per-section: a file that sets only `bead_cards_expanded` must leave the cap at its
/// default rather than resetting it, which is what a whole-struct overwrite would do.
fn apply_ui(into: &mut UiConfig, p: Option<PartialUi>) {
    let Some(p) = p else { return };
    if let Some(v) = p.bead_cards_expanded {
        into.bead_cards_expanded = v;
    }
    if let Some(v) = p.bead_cards_expanded_max {
        into.bead_cards_expanded_max = v;
    }
}

fn apply_voice(into: &mut VoiceConfig, p: Option<PartialVoice>) {
    let Some(p) = p else { return };
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
    if let Some(v) = p.plan {
        into.plan = Some(v);
    }
    // Same per-key rule as the categories: only a layer that actually wrote the key overrides, so a
    // project may turn concierge routing off (or back on) without disturbing the global value.
    if let Some(v) = p.concierge_answers {
        into.concierge_answers = v;
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
    // `[concierge].own_orgs` — the ONLY lever that lifts the foreign-repo floor. Assigned rather
    // than merged because it is a LIST, not a table of independent rules, and because `[concierge]`
    // is global-only so there is never a second layer to overlay onto.
    if let Some(orgs) = p.own_orgs {
        match orgs.as_array() {
            Some(entries) => {
                let mut collected: Vec<String> = Vec::new();
                for entry in entries {
                    // A non-string is DROPPED with a user-facing warning, never coerced. Silence
                    // here would leave the user believing he had named his org while every repo
                    // stayed foreign — i.e. the interruption he wrote the line to stop.
                    let Some(name) = entry.as_str() else {
                        warnings.push(format!(
                            "[concierge].own_orgs contains a {}, not a name in quotes, so that \
                             entry is ignored; repos under it stay foreign and Sparkle will keep \
                             asking before it touches your main branch there",
                            entry.type_str()
                        ));
                        continue;
                    };
                    // Trimmed and lowercased on read: GitHub is case-insensitive about owners, and
                    // a stray space is invisible in the file but would silently match nothing.
                    let name = name.trim().to_lowercase();
                    if name.is_empty() {
                        warnings.push(
                            "[concierge].own_orgs contains an empty name, which matches no repo; \
                             that entry is ignored"
                                .to_string(),
                        );
                        continue;
                    }
                    // KEPT, not dropped — the same discipline as an unrecognized decision value:
                    // rewriting or discarding what the user wrote would hide the mistake instead of
                    // reporting it. But an entry that cannot match any owner must SAY so, or the
                    // user believes he lifted the foreign-repo floor and Sparkle silently keeps
                    // asking. `own_orgs = ["drodio/sparkle"]` (a repo slug where an org goes) is the
                    // shape that does this.
                    if !looks_like_repo_owner(&name) {
                        warnings.push(format!(
                            "[concierge].own_orgs contains \"{name}\", which is not a bare GitHub \
                             org or username, so it matches no repo; write just the owner \
                             (\"drodio\"), not a repo slug or a URL"
                        ));
                    }
                    collected.push(name);
                }
                into.own_orgs = collected;
            }
            None => warnings.push(format!(
                "[concierge].own_orgs is a {}, not a list like own_orgs = [\"your-org\"], so it \
                 has no effect; every repo stays foreign",
                orgs.type_str()
            )),
        }
    }
    // `[concierge.projects."<owner>/<repo>".tools]` — per-repo TIGHTENINGS.
    if let Some(projects) = p.projects {
        match projects.as_table() {
            Some(projects) => {
                for (slug, entry) in projects.clone() {
                    let Some(entry) = entry.as_table() else {
                        warnings.push(format!(
                            "[concierge.projects.\"{slug}\"] is a {}, not a section like \
                             [concierge.projects.\"{slug}\".tools], so it has no effect",
                            entry.type_str()
                        ));
                        continue;
                    };
                    // Lowercased for the same reason as `own_orgs`: the slug is compared against a
                    // resolved `remote.origin.url`, and GitHub treats `Owner/Repo` and `owner/repo`
                    // as ONE repo. A differently-cased key would silently match nothing — which
                    // fails OPEN on a line the user wrote to tighten.
                    let slug_key = slug.trim().to_lowercase();
                    if slug_key.is_empty() {
                        warnings.push(
                            "[concierge.projects] has an entry with an empty name, which matches \
                             no repo; it is ignored"
                                .to_string(),
                        );
                        continue;
                    }
                    // KEPT and still applied, but REPORTED. A key that is not an `owner/repo` slug
                    // can never equal a resolved `remote.origin.url`, so the rule contributes no
                    // tightening — it fails OPEN on the one line the user wrote to restrict a repo,
                    // and nothing downstream can recover it (the frontend keys by the same string,
                    // where a miss is indistinguishable from "no rule set"). Case is only one of the
                    // ways a key misses; these are the rest.
                    if !looks_like_repo_slug(&slug_key) {
                        warnings.push(format!(
                            "[concierge.projects.\"{slug}\"] is not an \"owner/repo\" slug, so it \
                             matches no repo and none of its rules apply; use the two-part form \
                             (\"plow-pbc/tkmx-server\"), not a bare repo name, a URL, or a .git \
                             suffix"
                        ));
                    }
                    let Some(tools) = entry.get("tools") else {
                        // Not a warning: an entry reserving a slug with no rules yet is legal and
                        // contributes no tightening. It still gets a (possibly empty) row so the
                        // settings pane can show that the user has written something about it.
                        into.projects.entry(slug_key).or_default();
                        continue;
                    };
                    let Some(tools) = tools.as_table() else {
                        warnings.push(format!(
                            "[concierge.projects.\"{slug}\"].tools is a {}, not a section like \
                             [concierge.projects.\"{slug}\".tools], so no rule for that repo \
                             applies",
                            tools.type_str()
                        ));
                        into.projects.entry(slug_key).or_default();
                        continue;
                    };
                    // PER KEY, never wholesale: two `[concierge.projects."x".tools]` rules written
                    // in different places in the file must both survive, exactly as
                    // `[concierge.tools]` entries do.
                    let into_project = into.projects.entry(slug_key).or_default();
                    for (name, decision) in tools.clone() {
                        match decision.as_str() {
                            // VERBATIM, unnarrowed — see the identical note under [concierge.tools]
                            // below. The TS layer reads an unrecognized value as `ask`, stricter
                            // than the derived default, and narrowing here would erase the
                            // difference between "the user typo'd a rule" and "the user set none".
                            Some(v) => {
                                into_project.tools.insert(name, v.to_string());
                            }
                            None => warnings.push(format!(
                                "[concierge.projects.\"{slug}\".tools].{name} is a {}, not \
                                 \"allow\", \"ask\", or \"deny\", so that rule is ignored",
                                decision.type_str()
                            )),
                        }
                    }
                }
            }
            None => warnings.push(format!(
                "[concierge.projects] is a {}, not a section like \
                 [concierge.projects.\"owner/repo\".tools], so no per-repo rule applies",
                projects.type_str()
            )),
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

/// Overlay a partial `[pushers]` section onto the shipped envelope.
///
/// PER-FIELD, like `apply_concierge_checks` — the one-line edit this section exists for
/// (`messages_per_hour = 1` under an existing header) has to leave `observe_interval_ms` and
/// `inbox_yield_pct` at what they shipped with. Replacing the struct wholesale would turn "make it
/// quieter" into "silently reset everything else too".
///
/// A wrong-typed value is DROPPED with a warning rather than coerced or fatal — being fatal would
/// cost the user their whole config layer over one typo (roborev 54240) — WITH ONE EXCEPTION, and
/// the exception is the safety-relevant asymmetry of this section:
///
///   `enabled` honors an unambiguous OFF-spelling (`"false"`/`"off"`/`"no"`/`0`), never an
///   on-spelling. It is the only control over a feature that ships ON and attaches at birth, so a
///   dropped kill switch fails OPEN — the one direction the user cannot recover by noticing later.
///   Reading a string as truthy would be the dangerous coercion; reading one as false is not.
///
/// That distinction used to be stated backwards here — the header still gave "coercing would make
/// `enabled = "false"` read as ON" as the reason for dropping it, after the code had started
/// honoring exactly that spelling. In a file where the comments are the recorded contract, a
/// maintainer reading that would conclude the arm was a bug and revert the fix (roborev 56365).
///
/// Returns the user-facing warnings, which have to be handed back rather than logged: a rejected
/// value never enters the config, so nothing downstream — `validate` included — can rediscover it,
/// and a line the user deliberately wrote that silently does nothing is the worst outcome of the
/// three. Same contract as `apply_concierge` / `apply_plugins`.
#[must_use]
fn apply_babysit(into: &mut BabysitConfig, p: Option<PartialBabysit>) -> Vec<String> {
    let mut warnings = Vec::new();
    let Some(p) = p else { return warnings };

    // SAME OFF-SPELLING RULE AS `[pushers].enabled`, and for the same reason, which applies with
    // more force here: this switch stops a loop that spends a full Claude session per dispatch on
    // the founder's own quota. Dropping `enabled = "false"` with a warning would leave it RUNNING,
    // and the only signal that the edit did nothing is a string in the Advanced panel — not where
    // someone who just hand-edited the TOML to stop it is looking. Failing open on an off switch is
    // the one direction the user cannot recover by noticing later.
    if let Some(v) = p.enabled {
        let off = match &v {
            toml::Value::Boolean(false) => true,
            toml::Value::Integer(0) => true,
            toml::Value::String(s) => {
                matches!(s.trim().to_ascii_lowercase().as_str(), "false" | "off" | "no" | "0")
            }
            _ => false,
        };
        if off {
            into.enabled = false;
        } else {
            match v.as_bool() {
                Some(b) => into.enabled = b,
                None => warnings.push(format!(
                    "[babysit].enabled is a {}, not true or false, so it has no effect — the \
                     /babysit-pr sweep is still dispatching. Use `enabled = false` to stop it.",
                    v.type_str()
                )),
            }
        }
    }
    let mut int_field = |field: &str, v: Option<toml::Value>, into: &mut i64| {
        let Some(v) = v else { return };
        match v.as_integer() {
            Some(n) => *into = n,
            None => warnings.push(format!(
                "[babysit].{field} is a {}, not a whole number, so it has no effect",
                v.type_str()
            )),
        }
    };
    int_field("cooldown_minutes", p.cooldown_minutes, &mut into.cooldown_minutes);
    int_field(
        "recovery_cooldown_minutes",
        p.recovery_cooldown_minutes,
        &mut into.recovery_cooldown_minutes,
    );
    int_field("max_dispatches_per_hour", p.max_dispatches_per_hour, &mut into.max_dispatches_per_hour);

    for (field, _) in p.rest {
        warnings.push(format!(
            "[babysit].{field} is not a babysit setting (enabled, cooldown_minutes, \
             recovery_cooldown_minutes, max_dispatches_per_hour), so it has no effect"
        ));
    }
    warnings
}

fn apply_pushers(into: &mut PushersConfig, p: Option<PartialPushers>) -> Vec<String> {
    let mut warnings = Vec::new();
    let Some(p) = p else { return warnings };

    // THE KILL SWITCH READS UNAMBIGUOUS OFF-SPELLINGS, and this is the one exception to the
    // drop-a-wrong-type rule above (roborev 56226).
    //
    // `enabled` is the ONLY control a user has over a feature that ships ON and attaches to every
    // build agent at birth. Dropping `enabled = "false"` with a warning left Pushers RUNNING, and
    // the sole signal that the edit did nothing is a string in the ⋯ Advanced panel — not somewhere
    // the person who just hand-edited the TOML is necessarily looking. Failing open on the off
    // switch is the one direction that cannot be recovered by the user noticing later.
    //
    // This is NOT the coercion the header warns against. The hazard there is reading a string as
    // truthy and turning `"false"` into ON; recognising the spellings that unambiguously mean OFF
    // moves in the opposite, safe direction. Anything without a defensible off-reading still warns
    // and still has no effect, so the default is never flipped by a typo — only by an intent.
    // Mirrors `readsAsOff` in `packages/core/pusherPolicy.ts`; the TS half cannot see these values
    // unless this layer passes them through, which is why the fix has to live here too.
    if let Some(v) = p.enabled {
        let off = match &v {
            toml::Value::Boolean(false) => true,
            toml::Value::Integer(0) => true,
            toml::Value::String(s) => {
                matches!(s.trim().to_ascii_lowercase().as_str(), "false" | "off" | "no" | "0")
            }
            _ => false,
        };
        if off {
            into.enabled = false;
        } else {
            match v.as_bool() {
                Some(b) => into.enabled = b,
                None => warnings.push(format!(
                    "[pushers].enabled is a {}, not true or false, so it has no effect — Pushers \
                     are still running. Use `enabled = false` to stop them.",
                    v.type_str()
                )),
            }
        }
    }
    // The three integers share a reader so a new numeric knob cannot pick up different wrong-type
    // wording by accident. Kept VERBATIM when it reads — out-of-range values are `validate`'s job to
    // report, never this function's to rewrite (see the note there).
    let mut int_field = |field: &str, v: Option<toml::Value>, into: &mut i64| {
        let Some(v) = v else { return };
        match v.as_integer() {
            Some(n) => *into = n,
            None => warnings.push(format!(
                "[pushers].{field} is a {}, not a whole number, so it has no effect",
                v.type_str()
            )),
        }
    };
    int_field("observe_interval_ms", p.observe_interval_ms, &mut into.observe_interval_ms);
    int_field("messages_per_hour", p.messages_per_hour, &mut into.messages_per_hour);
    int_field("inbox_yield_pct", p.inbox_yield_pct, &mut into.inbox_yield_pct);

    for (field, _) in p.rest {
        warnings.push(format!(
            "[pushers].{field} is not a Pusher setting (enabled, observe_interval_ms, \
             messages_per_hour, inbox_yield_pct), so it has no effect"
        ));
    }
    warnings
}

/// Overlay a partial `[advisor]` section onto the shipped envelope.
fn apply_advisor(into: &mut AdvisorConfig, p: Option<PartialAdvisor>) -> Vec<String> {
    let mut warnings = Vec::new();
    let Some(p) = p else { return warnings };

    // THE SAME OFF-SPELLING RULE AS `[pushers].enabled`, and for the same reason: `enabled` is the
    // only control a user has over a feature that ships ON, and dropping `enabled = "false"` with a
    // warning would leave the advisor RUNNING while the person who just hand-edited the TOML
    // believes they stopped it. Recognising the spellings that unambiguously mean OFF moves in the
    // safe direction; anything without a defensible off-reading still warns and still has no effect,
    // so the default is never flipped by a typo.
    if let Some(v) = p.enabled {
        let off = match &v {
            toml::Value::Boolean(false) => true,
            toml::Value::Integer(0) => true,
            toml::Value::String(s) => {
                matches!(s.trim().to_ascii_lowercase().as_str(), "false" | "off" | "no" | "0")
            }
            _ => false,
        };
        if off {
            into.enabled = false;
        } else {
            match v.as_bool() {
                Some(b) => into.enabled = b,
                None => warnings.push(format!(
                    "[advisor].enabled is a {}, not true or false, so it has no effect — the \
                     advisor pass is still running. Use `enabled = false` to stop it.",
                    v.type_str()
                )),
            }
        }
    }

    // KEPT VERBATIM when it reads, exactly like the Pusher integers: whether the id is DISPATCHABLE
    // is not this function's question. `services/advisor/model.ts` resolves it against the catalog
    // and `research.rs` refuses an off-list id at dispatch, so an unknown model here costs a skipped
    // pass with a stated reason — never a rewritten config file, and never a silent substitution.
    if let Some(v) = p.model {
        match v.as_str() {
            Some(m) => into.model = m.trim().to_string(),
            None => warnings.push(format!(
                "[advisor].model is a {}, not a string, so it has no effect",
                v.type_str()
            )),
        }
    }

    for (field, _) in p.rest {
        warnings.push(format!(
            "[advisor].{field} is not an advisor setting (enabled, model), so it has no effect"
        ));
    }
    warnings
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
    if let Some(v) = p.humanebench {
        into.humanebench = v;
    }
    if let Some(v) = p.roborev {
        into.roborev = v;
    }
    if let Some(v) = p.builder_index {
        into.builder_index = v;
    }
    if let Some(v) = p.straude {
        into.straude = v;
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
    let Some(p) = p else { return };
    if let Some(v) = p.consent {
        into.consent = Some(v);
    }
    // A present key wins; an absent one (older file, or a [improvement] section that only sets
    // consent) leaves the `true` default in place — the founder's chosen armed-by-default.
    if let Some(v) = p.never_idle_armed {
        into.never_idle_armed = v;
    }
}

fn apply_drainer(into: &mut DrainerConfig, p: Option<PartialDrainer>) -> Vec<String> {
    let mut warnings = Vec::new();
    let Some(p) = p else { return warnings };

    // SAME OFF-SPELLING RULE AS `[babysit]`/`[pushers]`, and for the same reason, which applies with
    // full force here: this switch stops a loop that can spawn a background worker fleet on the
    // founder's Claude quota. Dropping `enabled = "false"` with a warning — or worse, letting a
    // wrong-typed value fail the whole layer — would leave the drainer ON, and the only signal that
    // the edit did nothing is a string in the Advanced panel, not where someone who just hand-edited
    // the TOML to stop it is looking. Failing open on an off switch is the one direction the user
    // cannot recover by noticing later.
    if let Some(v) = p.enabled {
        let off = match &v {
            toml::Value::Boolean(false) => true,
            toml::Value::Integer(0) => true,
            toml::Value::String(s) => {
                matches!(s.trim().to_ascii_lowercase().as_str(), "false" | "off" | "no" | "0")
            }
            _ => false,
        };
        if off {
            into.enabled = false;
        } else {
            match v.as_bool() {
                Some(b) => into.enabled = b,
                None => warnings.push(format!(
                    "[drainer].enabled is a {}, not true or false, so it has no effect — the \
                     backlog drainer is still running. Use `enabled = false` to stop it.",
                    v.type_str()
                )),
            }
        }
    }

    // Keys the SHELL watchdog (scripts/backlog-drainer.sh, PR #2417) reads from THIS SAME global
    // config.toml via `sparkle_cfg_get_int drainer …`. The app itself does not read them, but they are
    // real, honoured [drainer] settings — so they must NOT be reported as "has no effect" (telling a
    // user their `feedback_floor = 20` is inert, when deleting it makes the fleet drain to empty
    // instead of resting, is worse than saying nothing). Skip them; warn only on genuinely unknown keys.
    // `max_concurrency` is read APP-SIDE (drainer.rs `drainer_max_concurrency`), the others by the
    // SHELL watchdog; both are real honoured [drainer] settings, so neither may be flagged "no effect".
    const ENGINE_KEYS: &[&str] = &[
        "feedback_floor",
        "max_workers",
        "max_concurrency",
        "claim_max_age",
        "inprogress_max_age",
        "lock_ttl",
    ];
    for (field, _) in p.rest {
        if ENGINE_KEYS.contains(&field.as_str()) {
            continue;
        }
        warnings.push(format!(
            "[drainer].{field} is not a drainer setting (enabled, feedback_floor, max_workers, \
             max_concurrency, claim_max_age, inprogress_max_age, lock_ttl), so it has no effect"
        ));
    }
    warnings
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
    // Same rule, and it matters more here: a blank account_id would be passed as `--account ""` on
    // every single `op` invocation, which fails everything rather than degrading to "not chosen".
    if let Some(v) = p.account_id {
        let v = v.trim();
        into.account_id = if v.is_empty() { None } else { Some(v.to_string()) };
    }
    if let Some(v) = p.seed_worktrees {
        into.seed_worktrees = v;
    }
}

/// Apply `[publish]`, returning a warning per rejected row.
///
/// Every rejection is WARNED ABOUT rather than silently dropped. A destination that vanishes with
/// no explanation reads to the user as "Sparkle lost my config", and they re-add the same broken
/// row; the warning names the id and the rule so the next edit is the fixed one. This preserves
/// the module's "unknown/missing never errors" contract — a bad row is skipped, never fatal.
fn apply_publish(into: &mut PublishConfig, p: Option<PartialPublish>) -> Vec<String> {
    let Some(p) = p else { return Vec::new() };
    let mut warnings = Vec::new();

    if let Some(rows) = p.destinations {
        for (id, row) in rows {
            if !crate::publish_credential::destination_id_is_valid(&id) {
                warnings.push(format!(
                    "[publish.destinations.{id}] was ignored — a destination id may only contain \
                     lowercase letters, digits and dashes (it names a keychain item)"
                ));
                continue;
            }
            let Some(url) = row.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) else {
                warnings.push(format!(
                    "[publish.destinations.{id}] was ignored — it has no `url`"
                ));
                continue;
            };
            // Validated HERE, at parse time, so a bad URL is reported when the user edits the file
            // rather than at the moment they try to publish. The client re-validates at call time
            // too: this layer is a courtesy, not the security boundary.
            if let Err(e) = crate::publish_url::validate_destination_url(url) {
                warnings.push(format!(
                    "[publish.destinations.{id}] was ignored — {e}"
                ));
                continue;
            }
            let name = row
                .name
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .unwrap_or(&id)
                .to_string();
            into.destinations.insert(
                id.clone(),
                PublishDestination {
                    name,
                    url: url.to_string(),
                    // Whether a token is actually stored is a keychain question, answered live by
                    // `publish_credential::publish_token_present`. It is NOT read from the file:
                    // a config that could assert "I have a credential" would let a repo fake a
                    // configured destination, and the value would go stale the moment the user
                    // disconnects.
                    has_credential_in_keychain: false,
                },
            );
        }
    }

    match p.active.as_deref().map(str::trim) {
        Some("") | None => {
            // `active` omitted (or blanked). Configuring exactly one destination and nothing else
            // is what a first-time user writes, and leaving publishing OFF for it would be the
            // silently-inert-feature shape: everything looks configured, nothing works, and no
            // message says why. With exactly one destination there is no ambiguity to resolve, so
            // it IS the active one.
            if into.destinations.len() == 1 {
                into.active = into.destinations.keys().next().cloned();
            } else if into.destinations.len() > 1 && into.active.is_none() {
                // With several, Sparkle must not guess which one posts under the user's name.
                warnings.push(format!(
                    "[publish] has {} destinations but no `active` — publishing stays off until \
                     you set active to one of [{}]",
                    into.destinations.len(),
                    into.destinations.keys().cloned().collect::<Vec<_>>().join(", ")
                ));
            }
        }
        Some(active) if into.destinations.contains_key(active) => {
            into.active = Some(active.to_string());
        }
        Some(active) => {
            // Pointing `active` at a destination that does not exist is the shape that would
            // otherwise fail at publish time with "unknown destination", long after the edit.
            warnings.push(format!(
                "[publish] active = \"{active}\" names no configured destination — publishing \
                 stays off until it names one of [{}]",
                into.destinations.keys().cloned().collect::<Vec<_>>().join(", ")
            ));
            into.active = None;
        }
    }

    warnings
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

/// Normalize one denylist entry for MATCHING: trimmed and lowercased, `None` when nothing is left.
///
/// The single place the comparison shape is decided, called on BOTH sides (here for the configured
/// entry, and by the reporter for the candidate skill name), so the two can never drift apart into
/// a denylist that silently matches nothing. Mirrors tkmx-client's `applyExclusions`
/// (`reporter/skills.ts`), whose `.trim().toLowerCase()` this exists to reproduce exactly.
pub fn normalize_skill_name(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_lowercase())
    }
}

/// Read `[builder_index].skills_exclude` in either accepted spelling, normalized and deduped.
///
/// Total: every input shape yields a list, and anything unusable yields an empty one plus a
/// warning. A denylist that could fail the layer parse would be the worst possible shape for this
/// key — the user reaches for it precisely when they want something GONE from a public profile, and
/// a whole-file parse error would revert their config while continuing to publish the name.
///
/// Two spellings, because two reporters:
///   • a TOML array — `skills_exclude = ["warp"]` — idiomatic here, and what the template shows;
///   • a comma-separated string — `skills_exclude = "warp, frontend-design"` — the shape
///     tkmx-client's `SKILLS_EXCLUDE` env var takes, which is what someone consolidating the two
///     reporters copies across.
fn resolve_skills_exclude(v: &toml::Value, warnings: &mut Vec<String>) -> Vec<String> {
    let raw: Vec<String> = match v {
        toml::Value::String(s) => s.split(',').map(str::to_string).collect(),
        toml::Value::Array(items) => {
            let mut out = Vec::new();
            for item in items {
                match item.as_str() {
                    Some(s) => out.push(s.to_string()),
                    // One bad element costs that element, not the list. Dropping it is also the
                    // SAFE direction for a denylist read backwards: the name stays published, which
                    // is visible on the profile, rather than silently excluding something else.
                    None => warnings.push(format!(
                        "[builder_index].skills_exclude has a {} entry, not a skill name; \
                         ignoring that entry",
                        item.type_str()
                    )),
                }
            }
            out
        }
        other => {
            warnings.push(format!(
                "[builder_index].skills_exclude is a {}, not a list of skill names like \
                 [\"warp\"]; nothing is being excluded",
                other.type_str()
            ));
            Vec::new()
        }
    };
    let mut out: Vec<String> = Vec::new();
    for name in raw.iter().filter_map(|s| normalize_skill_name(s)) {
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// Test-only: resolve config layers the way `current_effective` does, without touching disk or the
/// process-wide cache. Exposed to sibling modules so a consumer of a setting (e.g.
/// `builder_index`'s denylist) can test against the REAL resolution path rather than hand-building
/// the struct the resolver was supposed to produce — a hand-built value passes whether or not the
/// TOML key is even wired up.
#[cfg(test)]
pub(crate) fn test_effective(
    global: Option<&str>,
    project: Option<&str>,
) -> (SparkleConfig, Vec<String>, bool) {
    build_effective(SparkleConfig::default(), global, project)
}

fn apply_builder_index(into: &mut BuilderIndexConfig, p: Option<PartialBuilderIndex>) -> Vec<String> {
    let mut warnings = Vec::new();
    let Some(p) = p else { return warnings };
    if let Some(v) = p.skills_exclude {
        into.skills_exclude = resolve_skills_exclude(&v, &mut warnings);
    }
    warnings
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

/// The per-run vitest worker cap the shared pool config (`vitest.pool.mjs`) picks when NOTHING
/// overrides it. Mirrored here as the ceiling for what we inject, so an agent PTY never RAISES a
/// run above the number an uncoordinated local run would already use. If you change one, change the
/// other — `agent_test_worker_cap_survives_the_default` pins them together.
const AGENT_TEST_WORKER_DEFAULT: u32 = 6;

/// How many vitest workers ONE agent may fan out to, handed to its PTY as `SPARKLE_TEST_MAX_WORKERS`.
///
/// THE AMPLIFICATION THIS BOUNDS. `AGENTS_PER_CORE` prices an agent as a mostly-idle process blocked
/// on model round-trips — true until it runs `pnpm test`, at which point one agent becomes a vitest
/// pool of `min(AGENT_TEST_WORKER_DEFAULT, cores)` CPU-pinned workers. That pool is sized PER RUN and
/// knows nothing of the other agents, so N agents each verifying at once is N × 6 workers on the same
/// cores — the process/CPU storm behind the 2026 swap-thrash incident (438 → 1600+ processes, load
/// 15 → 55), which the memory-only admission gate cannot see because reclaimable file cache reads as
/// "available". The concurrency CEILING and the per-agent HEAP are both bounded; the per-agent
/// PROCESS FAN-OUT was not, and a small cap times an unbounded count is still unbounded.
///
/// So divide the machine-wide worker budget (≈ one per core) among the agents that could be admitted
/// at once. At the ceiling every agent gets `cores / ceiling`, so even the worst case — all of them
/// verifying simultaneously — sums to about `cores`, not `ceiling × 6`. On the measured 18-core host
/// with an 81-agent ceiling that is 1 worker each; on a machine whose ceiling is at or below its core
/// count it stays at the default and nothing changes. Floored at 1 (a run needs at least one worker),
/// and `effective_max_concurrent` is the divisor because it is the number actually admitted — a user
/// who pins the ceiling to 4 lets each of those 4 keep `cores/4` workers.
pub fn agent_test_worker_cap(cores: u32, effective_max_concurrent: u32) -> u32 {
    let cores = cores.max(1);
    let ceiling = effective_max_concurrent.max(1);
    (cores / ceiling).max(1)
}

/// The value to inject into an agent PTY, or `None` to leave the pool's own CPU-count default in
/// charge. `None` in two cases, both meaning "do not narrow": we can't read the core count, or the
/// division lands at or above the default the pool would pick anyway — injecting then could only
/// RAISE a run, which is never the direction this exists to move.
pub fn agent_test_worker_cap_to_inject(cores: u32, effective_max_concurrent: u32) -> Option<u32> {
    let cap = agent_test_worker_cap(cores, effective_max_concurrent);
    (cap < AGENT_TEST_WORKER_DEFAULT).then_some(cap)
}

/// The live value to inject, reading this machine's cores and the effective ceiling. `None` when the
/// core count is unknown (unsupported platform) — the pool then keeps its own default, exactly as it
/// did before this existed.
pub fn agent_test_worker_cap_env() -> Option<u32> {
    let cores = cpu_core_count()?;
    let effective = current_effective().effective_max_concurrent;
    agent_test_worker_cap_to_inject(cores, effective)
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
    /// The CPU RUN QUEUE is the constraint: load average per core is past what the cores can
    /// retire, so another agent would add contention rather than throughput.
    ///
    /// THE DIMENSION THE MEMORY-ONLY GATE CANNOT SEE, and the gap is documented rather than
    /// theoretical — `AGENT_TEST_WORKER_CAP`'s comment names "the process/CPU storm behind the 2026
    /// swap-thrash incident (438 → 1600+ processes, load 15 → 55), which the memory-only admission
    /// gate cannot see because reclaimable file cache reads as 'available'". Every other runtime
    /// bound here is a QUANTITY (bytes left to hand out); this one is a RATE, which is why it
    /// hard-stops at the agents already running instead of computing how many more "fit" — you
    /// cannot divide a run queue into agent-sized pieces.
    ///
    /// Distinct from [`Bound::Cpu`], which is a fact about how many cores the machine HAS. This one
    /// is a fact about how busy they are RIGHT NOW, and the remedy is to wait or stop something,
    /// not to buy a bigger machine.
    Load,
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
    // The idle grace is CAPPED, for the same reason its neighbour caps worktree_pool.size — but
    // with more at stake. With no max_servers (deliberate: the two-pane layout is the ceiling) and
    // `agent_memory_watchdog` still unwired, the grace timeout is one of only three things that
    // ever stops a preview server. An unbounded value is a dev server — 400 MB to 1 GB resident for
    // Next — that never exits, configured by a typo rather than a decision.
    if cfg.preview.idle_grace_min > PREVIEW_IDLE_GRACE_MAX_MIN {
        warnings.push(format!(
            "[preview].idle_grace_min ({}) is very high; capping at {}",
            cfg.preview.idle_grace_min, PREVIEW_IDLE_GRACE_MAX_MIN
        ));
        cfg.preview.idle_grace_min = PREVIEW_IDLE_GRACE_MAX_MIN;
    }
    // Same rule, same reason, for the eagerness knob: an unmatched string would read downstream as
    // "no instruction", i.e. exactly `"never"` — the one value a typo must not be able to reach,
    // because its symptom is a feature that silently stops happening rather than an error.
    if !PREVIEW_AGENT_EAGERNESS_MODES.contains(&cfg.preview.agent_eagerness.as_str()) {
        warnings.push(format!(
            "[preview].agent_eagerness is \"{}\", which is not visual, always, or never; using \
             \"visual\"",
            cfg.preview.agent_eagerness
        ));
        cfg.preview.agent_eagerness = "visual".to_string();
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
    // Same rule, same reason, for the per-repo tightenings. Surfaced and NOT rewritten: an
    // unreadable per-project rule resolves to `ask`, which is stricter than the tier it would
    // otherwise inherit, so dropping it here would restore the more permissive answer on exactly
    // the line the user wrote to tighten one repo.
    for (slug, project) in &cfg.concierge.projects {
        for (tool, decision) in &project.tools {
            if !CONCIERGE_TOOL_DECISIONS.contains(&decision.as_str()) {
                warnings.push(format!(
                    "[concierge.projects.\"{slug}\".tools].{tool} is \"{decision}\", which is not \
                     allow, ask, or deny; Sparkle will ask you before that tool runs in that repo \
                     until it is fixed"
                ));
            }
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
    // `[pushers]` is WARNED ABOUT AND NEVER REWRITTEN. Deliberate, and the same discipline the
    // `[concierge.checks].threshold` rule above follows: the number is the user's, and the
    // TypeScript resolver (`resolvePusherPolicy`) already clamps every one of these into a safe
    // range before anything acts on it. Rewriting here would additionally make the value the
    // ⋯-menu shows disagree with the value in the file the user hand-edited — the standing-rewrite
    // failure that bit `max_concurrent = 20` (roborev 53140).
    let pu = &cfg.pushers;
    if pu.messages_per_hour <= 0 {
        warnings.push(format!(
            "[pushers].messages_per_hour is {}, so a Pusher can never send anything; set it to a \
             positive number, or use enabled = false if that is what you meant",
            pu.messages_per_hour
        ));
    }
    // ABOVE THE SHIPPED CEILING IS SILENTLY REDUCED, so it has to be SAID (roborev 56365). Both of
    // these are ceilings the TypeScript resolver clamps with `min()`, which means the plausible
    // edit — "let it talk even when my inbox is busy", `inbox_yield_pct = 100` — resolves to 80
    // with nothing in the file and nothing in the ⋯ pane to say so. A line the user deliberately
    // wrote that does nothing and reports nothing is the worst of the three outcomes this section
    // chooses between, and it was the one being produced.
    let shipped = PushersConfig::default();
    if pu.inbox_yield_pct > shipped.inbox_yield_pct {
        warnings.push(format!(
            "[pushers].inbox_yield_pct is {}, above the shipped ceiling, so Pushers will still \
             yield at {}%; lower it to make them yield sooner, not later",
            pu.inbox_yield_pct, shipped.inbox_yield_pct
        ));
    }
    if pu.messages_per_hour > shipped.messages_per_hour {
        warnings.push(format!(
            "[pushers].messages_per_hour is {}, above the shipped ceiling, so each partner will \
             still hear at most {} an hour; the budget can be lowered, never raised",
            pu.messages_per_hour, shipped.messages_per_hour
        ));
    }
    // A percentage below 1 is the other end: 0 (or less) means "yield on an empty inbox", i.e.
    // never send. That IS honored (`pctOrQuiet` clamps toward silence), so it is reported as the
    // muting it performs rather than as a clamp it does not.
    if pu.inbox_yield_pct < 1 {
        warnings.push(format!(
            "[pushers].inbox_yield_pct is {}, so a Pusher yields even on an empty inbox and never \
             sends; use enabled = false if that is what you meant",
            pu.inbox_yield_pct
        ));
    }
    // The only term that can make a fleet of Pushers expensive is how OFTEN they observe — the size
    // of one observation is already hard-capped. A few-second interval would multiply the whole
    // fleet's spend by orders of magnitude and nothing about it looks wrong in the file.
    if pu.observe_interval_ms < 60_000 {
        warnings.push(format!(
            "[pushers].observe_interval_ms is {}, which is under the one-minute floor; observing \
             that often multiplies what every Pusher costs, so Sparkle will use 60000",
            pu.observe_interval_ms
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

/// Apply ONE per-project layer on top of `cfg`.
///
/// There are TWO such layers and they are the SAME KIND of file, which is the whole point of
/// sharing this code: the tracked `.sparkle/config.toml` (repo policy, checked in, applies to
/// everyone who clones) and the gitignored `.sparkle/local.toml` (this machine's runtime writes —
/// see `local_path`). `local.toml` wins where both set a key, because it is applied second.
///
/// EVERY global-only refusal applies to BOTH, and that is the load-bearing property here. A
/// per-project file may not set `[workers]`, `[memory]`, `[ai]`, `[tools]`, `[roborev]`,
/// `[builder_index]`, `[fleet]`, `[improvement]`, `[onepassword]`, `[capture]`, `[ui]`,
/// `[publish]`, `[voice]`, `[concierge]` or `[pushers]`; `local.toml` is per-project too, so
/// routing the app's writes there must not quietly re-grant any of them. Sharing ONE body is what
/// keeps that true — a second copy of these arms would drift.
///
/// `layer` changes exactly two things: WHICH FILE each warning names (a remedy string is an
/// instruction the user will follow, so it has to name the file they actually edit), and the
/// asymmetric `[preview].enabled` narrowing, which `apply_preview` applies to any non-Global layer.
fn apply_project_layer(
    cfg: &mut SparkleConfig,
    text: &str,
    layer: Layer,
    warnings: &mut Vec<String>,
    hard_error: &mut bool,
    rejected_plugins: &mut Vec<(String, String)>,
) {
    let file = layer.project_file();
    match parse_layer(text) {
        Ok(p) => {
            if p.workers.is_some() {
                warnings.push(format!(
                    "[workers] in a per-project {file} is ignored — it is a \
                     machine-wide setting; set it in the global config.toml"
                ));
            }
            if p.memory.is_some() {
                // Same rule and same reason as [workers]: memory is a property of the MACHINE,
                // and one repo must not be able to arm auto-kill (or disarm the gate) for every
                // other project sharing the same RAM.
                warnings.push(format!(
                    "[memory] in a per-project {file} is ignored — it is a \
                     machine-wide setting; set it in the global config.toml"
                ));
            }
            if p.ai.is_some() {
                warnings.push(format!(
                    "[ai] in a per-project {file} is ignored — it is a \
                     machine-wide setting; set it in the global config.toml"
                ));
            }
            if p.tools.is_some() {
                warnings.push(format!(
                    "[tools] in a per-project {file} is ignored — it is a \
                     machine-wide setting; set it in the global config.toml"
                ));
            }
            if p.roborev.is_some() {
                warnings.push(format!(
                    "[roborev] in a per-project {file} is ignored — it is a \
                     machine-wide setting; set it in the global config.toml"
                ));
            }
            if p.builder_index.is_some() {
                // Machine-wide in BOTH directions, which is the point: a cloned repo must not
                // be able to un-exclude a skill its owner withheld from a public profile, any
                // more than it can flip [tools].builder_index on.
                warnings.push(format!(
                    "[builder_index] in a per-project {file} is ignored — what \
                     this machine publishes about you is machine-wide, not something a repo \
                     gets to set; put it in the global config.toml"
                ));
            }
            if p.fleet.is_some() {
                // Same rule and reason as [workers]: the fleet's CI budget protects one SHARED
                // runner pool, so a cloned repo must not be able to raise (or disable) the cap for
                // every other project's agents pushing against the same pool.
                warnings.push(format!(
                    "[fleet] in a per-project {file} is ignored — it is a \
                     machine-wide setting; set it in the global config.toml"
                ));
            }
            if p.improvement.is_some() {
                warnings.push(format!(
                    "[improvement] in a per-project {file} is ignored — your \
                     improvement-sharing consent is a machine-wide preference, not something a \
                     repo gets to set; change it in the app or the global config.toml"
                ));
            }
            if p.onepassword.is_some() {
                warnings.push(format!(
                    "[onepassword] in a per-project {file} is ignored — the \
                     vault belongs to your 1Password account, not to one repo; set it in the \
                     global config.toml"
                ));
            }
            if p.capture.is_some() {
                warnings.push(format!(
                    "[capture] in a per-project {file} is ignored — the \
                     global shortcut is a machine-wide setting; set it in the global \
                     config.toml"
                ));
            }
            if p.ui.is_some() {
                warnings.push(format!(
                    "[ui] in a per-project {file} is ignored — how a bead card \
                     renders belongs to the person reading the concierge column, not to one \
                     repo; set it in the global config.toml"
                ));
            }
            // A SECURITY boundary, the same one [concierge] draws. A publish destination is a
            // network egress target Sparkle sends a bearer token to; a repo that could set one
            // would point the user's publishing at a host of its choosing merely by being
            // cloned with a block in its checked-in config. The token itself never leaves the
            // keychain, but the URL it is sent TO is exactly the thing worth stealing.
            if p.publish.is_some() {
                warnings.push(format!(
                    "[publish] in a per-project {file} is ignored — where \
                     Sparkle may post on YOUR behalf, and which host it sends your token to, \
                     are not something a repo gets to set; set them in the global config.toml"
                ));
            }
            if p.voice.is_some() {
                warnings.push(format!(
                    "[voice] in a per-project {file} is ignored — the \
                     microphone Sparkle captures from is a machine-wide setting, not a \
                     repo-scoped one; set it in the global config.toml"
                ));
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
                warnings.push(format!(
                    "[concierge] in a per-project {file} is ignored — how \
                     autonomous the concierge is over YOUR machine, and which checks run over \
                     its replies, are not something a repo gets to set; set them in the global \
                     config.toml (the tools half is also editable in ⋯ Settings → \"Concierge \
                     tools\")"
                ));
            }
            // The same boundary [concierge] draws, for the same kind of reason: [pushers]
            // decides how often the agents on THIS machine get interrupted and challenged, and
            // how much they may be spent on doing it. A repo could otherwise crank its own
            // Pushers up — or switch them off — merely by being cloned with a block in its
            // checked-in config, on a machine whose owner never asked for either.
            if p.pushers.is_some() {
                warnings.push(format!(
                    "[pushers] in a per-project {file} is ignored — how much \
                     Sparkle challenges the agents on YOUR machine is a machine-wide setting, \
                     not something a repo gets to set; set it in the global config.toml"
                ));
            }
            // `[cleared]` is a LOCAL-layer mechanism (see `PartialCleared`): it drops keys from
            // the layer BELOW it. In the tracked file that would be a repo asking to erase its own
            // keys — spelled "delete the line" — and nothing applies it there, so say so rather
            // than leaving a hand-written block silently inert.
            if p.cleared.is_some() && layer == Layer::Project {
                warnings.push(format!(
                    "[cleared] in a per-project {file} is ignored — it is how the app records a \
                     setting you cleared in the UI that this file still sets, so it is only read \
                     from .sparkle/local.toml; to drop a key from this file, delete the line"
                ));
            }
            // Per-project layer: [workflow], [freshness], [review], [approvals], [plugins], and the
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
            apply_mention(&mut cfg.mention, p.mention);
            apply_review(&mut cfg.review, p.review);
            apply_worktree_pool(&mut cfg.worktree_pool, p.worktree_pool);
            apply_preview(&mut cfg.preview, p.preview, layer, warnings);
            apply_approvals(&mut cfg.approvals, p.approvals);
            apply_done(&mut cfg.done, p.done);
            apply_delivered(&mut cfg.delivered, p.delivered);
        }
        Err(e) => {
            warnings.push(format!(
                "per-project {file} has a syntax error and was ignored: {e}"
            ));
            *hard_error = true;
        }
    }
}

/// The dotted keys a `.sparkle/local.toml` asks to erase from the tracked layer — `[cleared].keys`.
///
/// An unparseable local file answers with an EMPTY list rather than an error: the layer itself is
/// about to be handed to `apply_project_layer`, which reports the syntax error and names the file.
/// Erasing nothing is the conservative direction — it leaves the tracked policy standing, which is
/// what a reader who cannot be told what to erase should do.
fn cleared_keys(local_text: &str) -> Vec<String> {
    parse_layer(local_text)
        .ok()
        .and_then(|p| p.cleared)
        .and_then(|c| c.keys)
        .unwrap_or_default()
}

/// Remove every dotted key in `keys` from one layer's TOML `text`, returning the re-rendered text.
///
/// `None` when the text does not parse — the caller then passes the ORIGINAL through, so the layer
/// still reaches `apply_project_layer` and produces its "syntax error and was ignored" warning. A
/// silent empty layer here would turn a typo in a repo's committed policy into a config that quietly
/// resolves to defaults with nothing said.
///
/// An individual key that cannot be removed (a path descending through a scalar) is SKIPPED, not
/// fatal: `[cleared]` is machine-local bookkeeping about a file it does not control, so a tracked
/// file reshaped by a human under a stale entry must not break the whole layer.
fn strip_cleared_keys(text: &str, keys: &[String]) -> Option<String> {
    let mut doc = text.parse::<toml_edit::DocumentMut>().ok()?;
    for key in keys {
        let _ = unset_dotted(&mut doc, key);
    }
    Some(doc.to_string())
}

/// Build the effective config from optional layer texts, with NO local layer. Kept as the
/// three-argument shape because most callers (and every test that predates the local layer) have
/// nothing local to pass — and "a repo with no `.sparkle/local.toml` behaves exactly as before" is
/// a property worth being able to state by construction rather than by inspection.
fn build_effective(
    base: SparkleConfig,
    global: Option<&str>,
    project: Option<&str>,
) -> (SparkleConfig, Vec<String>, bool) {
    build_effective_layered(base, global, project, None)
}

/// Build the effective config from optional layer texts. Precedence, weakest first:
///
///   defaults -> global `config.toml` -> project `.sparkle/config.toml` -> `.sparkle/local.toml`
///
/// The last two are BOTH per-project and carry identical authority (see `apply_project_layer`);
/// they are two files only so that the half a human checks in and the half the app writes at
/// runtime cannot collide. Local wins, because it is the more specific statement about THIS
/// machine.
///
/// Returns `(config, warnings, hard_error)`. `hard_error` is true when a *provided* layer failed
/// to parse — the watcher uses it to keep the last-good config live instead of swapping.
fn build_effective_layered(
    base: SparkleConfig,
    global: Option<&str>,
    project: Option<&str>,
    local: Option<&str>,
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
                // Extended immediately rather than collected: [publish] is global-only, so there is
                // no second layer whose warnings could interleave (same reasoning as [concierge]).
                warnings.extend(apply_publish(&mut cfg.publish, p.publish));
                apply_freshness(&mut cfg.freshness, p.freshness);
                apply_mention(&mut cfg.mention, p.mention);
                apply_review(&mut cfg.review, p.review);
                apply_worktree_pool(&mut cfg.worktree_pool, p.worktree_pool);
                apply_preview(&mut cfg.preview, p.preview, Layer::Global, &mut warnings);
                apply_capture(&mut cfg.capture, p.capture);
                apply_ui(&mut cfg.ui, p.ui);
                apply_voice(&mut cfg.voice, p.voice);
                apply_approvals(&mut cfg.approvals, p.approvals);
                // Extended immediately rather than collected like `rejected_plugins`: `[concierge]`
                // is global-only, so there is no second layer whose warnings could interleave.
                warnings.extend(apply_concierge(&mut cfg.concierge, p.concierge));
                // Extended immediately for the same reason as [concierge]: [pushers] is global-only,
                // so there is no second layer whose warnings could interleave with these.
                warnings.extend(apply_pushers(&mut cfg.pushers, p.pushers));
                // Global-only like [pushers], so its warnings cannot interleave with a repo layer's.
                warnings.extend(apply_advisor(&mut cfg.advisor, p.advisor));
                // Global-only like [pushers], so its warnings cannot interleave with a repo layer's.
                warnings.extend(apply_babysit(&mut cfg.babysit, p.babysit));
                // Global-only like [babysit]/[pushers], so its warnings cannot interleave with a
                // repo layer's — the project layer only ever reports that it was ignored.
                warnings.extend(apply_builder_index(&mut cfg.builder_index, p.builder_index));
                apply_fleet(&mut cfg.fleet, p.fleet);
                // Global-only like [babysit]/[pushers]: how much of this machine's quota an
                // autonomous drain loop may spend is a property of the human at the machine, not a
                // repo, so it is overlaid only here and a [drainer] in a project file is ignored.
                warnings.extend(apply_drainer(&mut cfg.drainer, p.drainer));
                apply_done(&mut cfg.done, p.done);
                apply_delivered(&mut cfg.delivered, p.delivered);
            }
            Err(e) => {
                warnings.push(format!("global config.toml has a syntax error and was ignored: {e}"));
                hard_error = true;
            }
        }
    }

    // SHADOW-UNSET, applied to the TRACKED layer's TEXT before it is parsed as a layer.
    //
    // The overlay direction is one-way — every `apply_*` arm writes a value or leaves the lower
    // layer's alone — so no value the local layer can hold makes a key ABSENT. That is fine for a
    // key the app itself wrote (the writer removes it from `local.toml`) and impossible for one
    // that lives in the tracked file, which the writers may not touch. So `unset_project_value`
    // records the key in `[cleared]` and the erasure happens HERE, by deleting it from the tracked
    // text — which makes the resolved value fall back exactly as it did before the split, when
    // there was one file and unset simply removed the line (roborev 66889, `PartialCleared`).
    //
    // Doing it on the text, with `unset_dotted`, is what keeps the two halves honest: the string
    // the UI unsets is removed by the SAME dotted-path parser that wrote it, so a key that can be
    // set is removable by the name it was set under, quoted segments and all.
    let cleared = local.map(cleared_keys).unwrap_or_default();
    // Owned, because `project` below borrows it. `None` when there is nothing to clear (the
    // overwhelmingly common case — no re-render, no reparse) and also when the tracked text does
    // not parse, so that layer still reaches `apply_project_layer` and produces its own syntax
    // warning rather than vanishing.
    let stripped: Option<String> = if cleared.is_empty() {
        None
    } else {
        project.and_then(|text| strip_cleared_keys(text, &cleared))
    };
    if let Some(text) = stripped.as_deref().or(project) {
        apply_project_layer(
            &mut cfg,
            text,
            Layer::Project,
            &mut warnings,
            &mut hard_error,
            &mut rejected_plugins,
        );
    }

    // The LOCAL layer, applied LAST so it WINS. Same kind of file, different job:
    // `.sparkle/local.toml` is gitignored and is where the app's own runtime writers land
    // (`set_project_value`, `unset_project_value`, `write_stage_definition`), so a UI toggle can no
    // longer dirty the TRACKED `.sparkle/config.toml` that carries repo policy — which is what
    // wedged the shared main checkout's fast-forward for ten days (sparkle-5ur8s, sparkle-v38y1n).
    //
    // It is NOT a wider grant. `apply_project_layer` refuses every global-only section here exactly
    // as it does for the tracked file, so `local.toml` cannot become a back door to `[workers]` or
    // `[concierge]` merely because the app writes it.
    if let Some(text) = local {
        apply_project_layer(
            &mut cfg,
            text,
            Layer::Local,
            &mut warnings,
            &mut hard_error,
            &mut rejected_plugins,
        );
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

/// Per-project config file: `<repo>/.sparkle/config.toml`. TRACKED in this repo (and meant to be
/// tracked in any repo that wants Sparkle policy to travel with a clone), so nothing that runs at
/// runtime may write it — see `local_path`.
pub fn project_path(repo_root: &str) -> PathBuf {
    Path::new(repo_root).join(".sparkle").join("config.toml")
}

/// Per-project LOCAL settings: `<repo>/.sparkle/local.toml`. Gitignored, and the ONLY per-project
/// file the app writes at runtime.
///
/// WHY IT EXISTS. `.sparkle/config.toml` became tracked so `[review].pr_reviewer` and the
/// `[done]`/`[delivered]` stage definitions could be repo POLICY. That inverted a property that
/// used to hold by construction: while the whole directory was ignored, the app's writes were
/// machine-local no matter where they landed. Once one file inside is tracked, every UI toggle —
/// a "this project" auto-approve rule, a Define Stage save — shows up as a modification to a
/// TRACKED file, with two consequences that were measured, not hypothesized:
///
///   * a `git add -A` sweeps one machine's `[approvals]`/`[plugins]` choices into repo policy for
///     everyone who clones; and
///   * the file is not in `TOOLING_CHURN_PATHS`, so a pending local edit reads as real
///     work-in-progress: `DirtyPolicy::Decline` refuses the park and `git merge --ff-only` aborts.
///     The shared main checkout sat 1,175 commits behind `origin/main` for ten days on exactly one
///     blocking path, and it was this file (sparkle-v38y1n).
///
/// Splitting the written half off is the fix: reads of the tracked file are unchanged, writes go
/// here, and `build_effective_layered` lays this on top so the resolved settings are the same.
pub fn local_path(repo_root: &str) -> PathBuf {
    Path::new(repo_root).join(".sparkle").join("local.toml")
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

/// Read a config layer for the RUNTIME, distinguishing "absent" from "could not be read".
///
/// `read_if_exists` cannot make that distinction — it is `read_to_string(..).ok()` — and at these
/// call sites the difference decides whether the user keeps their settings. An unreadable file
/// arriving as `None` is read as an ABSENT layer, so `build_effective` never enters its
/// `if let Some(text)` arm, never sets `hard_error`, and never pushes a warning: the cached layer
/// is replaced by pure DEFAULTS, silently, at launch and on every watcher event. Concurrency pins,
/// approvals, `[improvement]`, `[freshness]` all revert with nothing in the UI to say why — while a
/// merely UNPARSEABLE file, which is strictly less severe, correctly keeps last-good and warns.
///
/// `Ok(None)` is therefore reserved for a file that genuinely is not there; anything else is an
/// error the caller routes into the same last-good-plus-warning path as a syntax error.
fn read_layer_for_runtime(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{} could not be read: {e}", path.display())),
    }
}

/// Load the global file from disk and replace the cached global layer. Called at startup and
/// on every watcher event. On a syntax error the previous cached config is KEPT (last-good
/// stays live); only the warnings are refreshed so the UI can surface the problem.
pub fn reload_global(app_data: &Path) -> EffectiveConfig {
    // An unreadable file takes the SAME branch as a syntax error: keep last-good, surface a
    // warning. Letting it read as absent would silently swap every setting for a default.
    let (cfg, warnings, hard_error) = match read_layer_for_runtime(&global_path(app_data)) {
        Ok(text) => build_effective(SparkleConfig::default(), text.as_deref(), None),
        Err(msg) => (SparkleConfig::default(), vec![msg], true),
    };
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
    /// The `.sparkle/local.toml` stamp, keyed SEPARATELY from the tracked file's for the same
    /// reason the two files exist at all: it is the one that moves at runtime. Folding it into the
    /// tracked file's stamp would leave the memo valid across every UI write — an auto-approve
    /// toggle or a Define Stage save would land on disk and never reach a reader.
    local_mtime_ms: u128,
    local_len: u64,
    /// The global layer this result was merged against; when it changes (watcher reload) the memo
    /// is invalidated so a global edit still propagates into the per-project view.
    global_config: SparkleConfig,
    /// The global layer's WARNINGS, keyed separately from `global_config` because `effective` bakes
    /// them in (see the merge below) while the parsed config alone does not carry them.
    ///
    /// Without this the memo went stale in the direction that matters most: a global `config.toml`
    /// that becomes unreadable or unparseable takes `reload_global`'s hard-error branch, which
    /// deliberately KEEPS the last-good `config` and refreshes only `warnings` — so `global_config`
    /// is unchanged, every project entry stays valid, and each project-scoped reader keeps serving
    /// the stale (empty) warning list. `read_project_config` forwards these to the concierge, so
    /// the warning channel for the more severe of the two global failure modes went silent for
    /// exactly the surface meant to announce it. The repair direction was symmetric: fixing the
    /// file back to an equal parsed config cleared the warning globally and left the stale one
    /// baked into every project memo.
    global_warnings: Vec<String>,
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
    // The local layer is stamped too, and a MISSING file is a stable, valid key — (0, 0) — so a
    // repo that has never had one memoizes exactly as it did before this layer existed.
    let lpath = local_path(repo_root);
    let (local_mtime_ms, local_len) = file_stamp(&lpath);

    // Fast path: BOTH project files and the global layer are unchanged since we last computed.
    if let Ok(cache) = project_cache().lock() {
        if let Some(e) = cache.get(repo_root) {
            if e.mtime_ms == mtime_ms
                && e.len == len
                && e.local_mtime_ms == local_mtime_ms
                && e.local_len == local_len
                && e.global_config == global.config
                && e.global_warnings == global.warnings
            {
                return e.effective.clone();
            }
        }
    }

    // Same rule as reload_global: an unreadable project file must not read as an absent one, or
    // the project's auto-approve rules and [done]/[delivered] stage definitions vanish silently.
    // There is no last-good project layer to keep, so the honest result is the global layer plus a
    // warning naming the file — never a quiet fallback to "this project configures nothing".
    //
    // The LOCAL file gets the identical treatment, and it earns it: it is where every runtime write
    // lands, so reading an unreadable one as absent would silently drop the very settings the user
    // just changed in the UI.
    let mut read_failed = false;
    let (cfg, mut warnings, _) = match (read_layer_for_runtime(&path), read_layer_for_runtime(&lpath))
    {
        (Ok(project_text), Ok(local_text)) => {
            // `global.config` already has defaults+global folded in, so pass only the two
            // per-project layers; local is applied last and wins.
            build_effective_layered(
                global.config.clone(),
                None,
                project_text.as_deref(),
                local_text.as_deref(),
            )
        }
        // Either file being unreadable is reported and neither is guessed at. Both are named when
        // both failed, rather than the first one silently standing in for the pair.
        (a, b) => {
            read_failed = true;
            let msgs = [a.err(), b.err()].into_iter().flatten().collect::<Vec<_>>();
            (global.config.clone(), msgs, true)
        }
    };
    // Carry forward any standing global warnings so the UI sees them in a project context too.
    // Cloned rather than moved: the memo keys on them (see ProjectCacheEntry) precisely because
    // they are baked into `effective` here and the parsed config alone cannot represent them.
    let global_warnings = global.warnings.clone();
    let mut all = global.warnings;
    all.append(&mut warnings);
    let effective = EffectiveConfig::derive(cfg, all);

    // A READ FAILURE OBSERVED HERE IS NOT MEMOIZED, and the scope of that is worth stating exactly,
    // because the fast path above bounds it.
    //
    // What this covers: a failure seen on a cache MISS. The key has THREE parts — `(mtime_ms, len)`
    // AND the global layer's identity (`e.global_config == global.config` on the fast path) — so a
    // miss is the first read of a root, a moved stamp, OR a changed global layer. Without it the failure would be cached under that stamp, and
    // since the repair for a permissions problem is a `chmod` — which moves ctime, not `modified()`
    // or `len` — the entry would stay valid and freeze the failure for the process lifetime: the
    // project's rules and [done]/[delivered] definitions unloaded behind a stale banner even after
    // the user fixed it. Re-reading on the next call is cheap; a wrong answer nobody can clear is
    // not.
    //
    // What it does NOT cover, deliberately: a root already memoized as GOOD whose file then becomes
    // unreadable at an unchanged `(mtime_ms, len)` — again, `chmod 000` is exactly that. The fast
    // path matches and serves the last-good entry, so the user sees no warning until the stamp
    // moves, THE GLOBAL LAYER CHANGES, or the process restarts.
    //
    // That third exit is compared BY VALUE (`e.global_config == global.config` on a `PartialEq`
    // `SparkleConfig`), not by generation, so bound it precisely: a global edit that changes the
    // PARSED config invalidates every project entry at once. A reload that parses to an equal
    // config — a touch, a comment-only or whitespace edit — leaves every memo valid, and so does
    // one that fails to parse, since that branch deliberately keeps the last-good `config` and
    // refreshes only `warnings`.
    //
    // Closing THE PROJECT-FILE CASE — the `chmod 000` paragraph above, and nothing else here —
    // would mean re-reading the file on every hit of a hot poll path, or keying the stamp on
    // ctime/permissions; neither is worth it for a failure mode nobody has reported, and serving
    // last-good is the safe direction. That one is stated rather than fixed so the next reader does
    // not have to re-derive the boundary.
    //
    // The warnings-only case IS fixed, so do not read the paragraph above as declining it: the
    // entry also keys on `global_warnings` (see `ProjectCacheEntry`), because `effective` bakes the
    // global warnings in and the parsed config cannot represent them. Keying on the parsed config
    // alone left every project-scoped reader serving a stale warning list for the one global
    // failure mode that changes nothing but the warnings — and neither remedy named above would
    // have closed it, since the project file is not what went wrong.
    if !read_failed {
        if let Ok(mut cache) = project_cache().lock() {
            cache.insert(
                repo_root.to_string(),
                ProjectCacheEntry {
                    mtime_ms,
                    len,
                    local_mtime_ms,
                    local_len,
                    global_config: global.config,
                    global_warnings,
                    effective: effective.clone(),
                },
            );
        }
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
# WHERE THIS LIVES (three layers, all optional):
#   • Global  — this file, in Sparkle's app-data dir. Applies to every project. Holds your
#               machine-wide preferences ([workers], [memory], [ai]) plus default rules.
#   • Project — a `.sparkle/config.toml` CHECKED INTO a repo. Overrides ONLY the repo-scoped
#               rules ([workflow], [freshness], [review], [approvals], [plugins],
#               [worktree_pool], [preview], [done], [delivered]) for that one project, and
#               travels with the repo so a team shares them. [workers]/[memory]/[ai]/[tools]
#               there are ignored (they're per-machine).
#   • Local   — a `.sparkle/local.toml` NEXT TO IT, gitignored. Same rules, same refusals; it
#               just isn't shared. This is where Sparkle writes when YOU change a per-project
#               setting in the app — a "this project" auto-approve rule, a Define Stage save.
#
# WHY THE PROJECT LAYER IS TWO FILES. `.sparkle/config.toml` is tracked, so if the app wrote
# it, every click in the UI would leave a modified tracked file in your working tree: a
# `git add -A` would sweep one machine's choices into repo policy for everyone who clones,
# and `git merge --ff-only` would abort on a checkout that had done nothing but be used.
# Splitting them keeps the half a human commits and the half the app writes apart. Reads see
# both, so the resolved settings are the same — WITH ONE EXCEPTION, below.
#
# THE EXCEPTION: [preview]'s `command`, `args`, `path` and `port` are read STRAIGHT OFF a
# worktree's own `.sparkle/config.toml`, not from the merged config, because preview detection
# runs against an arbitrary worktree that is not necessarily the project this config was merged
# for. Put those FOUR KEYS IN THE TRACKED `.sparkle/config.toml`; in `local.toml` they are
# silently ignored. `[preview].enabled` is NOT affected — it goes through the merge like
# everything else (and a project may only turn preview off, never back on).
#
# CLEARING A SETTING: when you clear a per-project setting in the app that the repo's tracked
# `.sparkle/config.toml` sets, Sparkle records the key under `[cleared]` in `local.toml` rather
# than editing the tracked file. The repo's value is then ignored on THIS machine only. Delete
# the line from `[cleared].keys` to get it back.
#
# PRECEDENCE: built-in defaults → this global file → a project's .sparkle/config.toml →
# that project's .sparkle/local.toml (the most specific statement wins).
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
config_version = 4

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
# How many agents/worktrees run in parallel ON THIS MACHINE, counting every orchestrator's workers
# together — NOT a per-orchestrator allowance. Two orchestrators share this number rather than
# getting one each.
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
# Uncomment to pin your own CEILING for the whole machine. It only ever lowers the automatic value —
# setting 40 on a 16 GB Mac still gets you ~6, because the point of the clamp is to keep the kernel
# from killing your machine. A pin is reported AS a pin (the app says "pinned to N in config.toml",
# not "your RAM is full"), so it never masquerades as a hardware limit. To go back to automatic,
# delete the line rather than guessing a number.
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
# The `plan` key is a second SIBLING with its own value domain: how to answer Claude Code's
# "written up a plan and is ready to execute — proceed?" prompt, the one an agent stops on the
# moment it finishes planning. "auto" (DEFAULT) picks "Yes, and use auto mode"; "manual" picks
# "Yes, manually approve edits"; "ask" surfaces it and waits for you. It defaults ON — unlike
# `resume` — because an unanswered plan prompt stalls an agent that has already done the thinking.
# Only fires while [ai].auto_approve is on.
# The `concierge_answers` key is a third SIBLING, and it is NOT the same switch as
# [ai].auto_approve above: auto_approve lets a purely local REGEX press buttons with nobody reading
# them, while this lets the CONCIERGE — a reasoning agent that reads the question first — answer the
# prompts that classifier declines. Two switches so turning off the blind presser doesn't also
# silence the thing that reads. true (default) = hand those prompts to the concierge;
# false = send every one of them to you.
# [approvals]
# bash   = "never"     # opt bash back out — go back to confirming every command yourself
# fetch  = "never"     # or turn any other category back to ask-each-time
# resume = "summary"   # auto-resume from summary on every restart (or "full", or "ask")
# plan   = "manual"    # start the plan, but keep approving edits one by one (auto mode is
#                      # session-wide: it stops Claude Code emitting edit prompts at all)
# plan   = "ask"       # stop auto-starting plans — ask me before an agent executes one
# concierge_answers = false   # never route an unclassified prompt to the concierge — always ask me

# --- Which GitHub orgs are YOURS (per-machine; ignored in a project file) ----------------
# Repos under an org listed here are treated as your own. Everywhere else, Sparkle asks you
# first before it does anything to the MAIN branch — merging a PR, landing a branch —
# however permissive [concierge.tools] below is. Empty (the shipped value) means every repo
# gets that treatment, which is the safe default and exactly what you want until you say
# otherwise.
#
# This list is the ONLY way to lift that floor. A per-repo entry under
# [concierge.projects."owner/repo".tools] can only make a repo STRICTER, never looser — so
# there is no way for a repo you cloned to talk its way into more authority.
[concierge]
own_orgs = []          # e.g. ["your-github-org", "your-github-username"]

# --- Per-repo TIGHTENINGS (per-machine; ignored in a project file) -----------------------
# Same three values as [concierge.tools], scoped to one GitHub repo. The key is the repo's
# "owner/repo" slug IN QUOTES — it contains a slash, so the quotes are required.
#
# ONLY TIGHTENS. Sparkle takes the strictest of: your global [concierge.tools] rule, this
# rule, and the floors above. A global "deny" plus a per-repo "allow" is still deny.
#
# [concierge.projects."plow-pbc/tkmx-server".tools]
# merge_pr = "deny"    # never merge a PR in that repo, even though the global rule allows it

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
# that rewrites a branch's history, that reads your screen, or that touches your main branch asks
# first. Nothing defaults to "deny" —
# turning a tool off completely is always your explicit choice, never something Sparkle infers.
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
# Said it DID something — "I sent that to it", "I spawned an agent", "I closed it", "I filed
# the bead", "I merged it" — while the turn made no tool call that could have done it. The
# reply's claims are reconciled against the turn's own tool calls; no model is involved.
# A FUTURE tense ("I'll send it") is a promise about a later turn and is never flagged here,
# and neither is an offer ("I'm sending it if you confirm"), a phrase inside a noun phrase
# ("the agent I spawned"), or a sentence scoped to an earlier turn ("I closed one today").
[concierge.checks.unbacked-claim]
enabled   = true
severity  = "warn"
autofix   = false

# Said a DEFECT EXISTS — "there is a bug in X", "the pill never fires", "traced it to
# workerRollup.ts" — and attached nothing durable to it. What counts as attaching it: a bead
# filed, or an agent spawned. A message to the agent that owns the code does NOT count on its
# own — messaging is fine, but the defect still has to be written down somewhere you will find
# it again. Saying why you are not acting ("by design", "not worth filing because…") also
# passes. Reporting a defect that is already handled ("already fixed on main", "covered by
# sparkle-xxxx") is never flagged, and neither is a hypothetical ("if it were broken"), a defect
# you yourself reported back to you, or anything inside a code block or a quote.
# This one BLOCKS: the reply is held and the concierge is asked once for a corrected one. A mere
# warning would hand you a note about a dropped bug to read and act on, which is the labour this
# check exists to remove.
[concierge.checks.defect-without-disposition]
enabled   = true
severity  = "block"
autofix   = false

# Did not OPEN by quoting what you said. Every reply is supposed to start with a short blockquote
# of your own words — one for each message it is answering — before anything else; a quote buried
# under a preamble does not count, and neither does one at the end. Nothing is required of a reply
# that answers nothing (an unprompted push), or of one answering a send that was only attachments.
# The match is fuzzy on purpose: a reply quoting a cleaned-up version of something you dictated
# passes, a quote about a different subject does not.
# This one BLOCKS: the reply is held and the concierge is asked once for a corrected one. Sparkle
# will not write the quote for it — the point of the quote is that it read what you sent.
[concierge.checks.reply-without-quote]
enabled   = true
severity  = "block"
autofix   = false
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

# --- The Pusher (per-machine; ignored in a project file) --------------------------------
# A Pusher is the adversarial half of a pair: it watches one of your build agents and may send it
# a few CITED challenges an hour — "you claimed the suite is green; the last run you posted was
# red" — rather than doing any work itself. This section is how you turn that down.
#
# Ships ON. That is a deliberate choice over the safer default: at this level of autonomy the worst
# case of a misfiring trigger is noise, not a damaged worktree — and messages_per_hour is what
# bounds how much noise "noise" can be. Set enabled = false to switch every Pusher off.
#
# CEILINGS, NOT DIALS: messages_per_hour and inbox_yield_pct are clamped against Sparkle's own
# built-in limits, so a number here can only make a Pusher QUIETER. Raising one past the built-in
# does nothing. (Same rule [workers] max_concurrent follows.)
# Out-of-range values are reported and never rewritten in your file.
[pushers]
enabled             = true    # master switch — false stops every Pusher from observing or sending
observe_interval_ms = 300000  # ms between observation cycles for one partner (5 min). Floor: 60000
messages_per_hour   = 4       # challenges per partner per rolling hour. Ceiling only — lower it, never raise
inbox_yield_pct     = 80      # if the partner's inbox is this % full or more, the Pusher stays quiet

# --- Second-model advisor pass (per-machine; ignored in a project file) ------------------
# When an epic is handed to a build orchestrator, a model DIFFERENT from the one that wrote the plan
# reviews it — scope one agent can hold, is the completion criterion checkable, does it collide with
# work already in flight — and leaves a comment on the bead. It NEVER rewrites a plan and NEVER
# blocks a handoff; findings are advisory.
# SPEND: bounded by a gate, not by this flag. Before every pass Sparkle reads your LIVE usage payload
# and runs only while usage credits are DISARMED (extra_usage.is_enabled = false), so no call can
# bill outside your Claude subscription. Armed credits, a reached spend limit, or a payload it cannot
# read all REFUSE and record why on the bead.
[advisor]
enabled = true              # master switch — false stops the pass entirely
model   = "claude-opus-5"   # must differ from the planner's model, and be one Sparkle can dispatch

# --- Backlog drainer (per-machine; ignored in a project file) ---------------------------
# The in-app loop that drains the sparkle-self agent-feedback bead backlog with a bounded fleet of
# background worker agents, resting when the backlog is at/below a floor. The deterministic floor,
# worker cap and worst-first claim logic live in scripts/backlog-drainer.sh; this is only the switch.
#
# Ships ON — zero human steps, on by default. Defensible for the same reason as [pushers]/[babysit]:
# the shell engine's worker cap and rest floor bound the worst case. Set enabled = false to switch
# the loop fully off (it then dispatches nothing and spawns no worker). The shell engine also honors
# the SPARKLE_DRAINER_ENABLED=0 environment variable.
[drainer]
enabled = true              # master switch — false makes the in-app drain loop fully inert
# max_concurrency: how many in-app drain workers run in PARALLEL (a bounded fleet). Default 3, floored
# at 1 and hard-capped in the app. The effective bound is the strictest of this, the shell's
# max_workers cap, and the number of healthy pool accounts available to rotate across.
# max_concurrency = 3

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
humanebench = true  # score pull requests that change what Sparkle says or does to a person against
                    # HumaneBench's 8 humane-technology principles, and post the reasoning on the PR.
                    # Below 0.5 fails the HumaneBench check; that check holds a merge once an admin
                    # adds it to the branch ruleset. NOTE what setting this false does NOT do: the
                    # review is repo-side (.github/workflows/humane-gate.yml, triggered by the pull
                    # request), so it cannot be switched off from here and your PRs are scored and
                    # commented on either way. Today nothing reads this key at all — it is the
                    # saved preference a future consumer will read (bead sparkle-9o0649.1).
roborev    = true   # per-commit AI code review of your BUILD-agent commits (uses your claude login)
# One of the two default-OFF tools, and the only one that publishes anything about you. On, Sparkle
# posts your DAILY TOKEN TOTALS (per day, per model — never file paths, prompts, code, or keys) to the
# public tokenmaxxing leaderboard. Turning it on in ⋯ Settings → "Tools" also asks for your
# tokenmaxxing username + API key and a one-time consent confirmation; nothing is sent until all
# three are in place, so flipping this to true by hand alone does NOT start reporting.
builder_index = false
# The other reporting destination, and the other default-OFF publisher. straude.com is a SEPARATE
# leaderboard that competes with the Builder Index — this flag is independent of the one above, so
# you can run either, both, or neither. On, Sparkle posts your DAILY TOKEN TOTALS (per day, per
# model, plus an estimated cost — never file paths, prompts, code, project names, or keys). It sends
# strictly LESS than builder_index does: straude has no field for your machine specs, your installed
# plugins, or session-activity counters. Turning it on in ⋯ Settings → "Tools" opens a browser
# sign-in and a one-time consent confirmation; nothing is sent until both are done, so flipping this
# to true by hand alone does NOT start reporting. Note each day you report becomes a PUBLIC POST on
# straude.com showing your models and dollar spend.
straude = false
onepassword = false # back your .env* files up to a 1Password vault. Also ships OFF:
                    # it needs a 1Password account, the `op` CLI, and a chosen vault, so you opt in
                    # from ⋯ Settings → "Tools" once those exist.

# --- What the Builder Index reporter publishes (per-machine; ignored in a project file) --
# Only read when [tools] builder_index above is true. That flag is the on/off switch; this section
# is what goes out once it's on.
#
# Your profile's SKILLS row lists the Claude Code PLUGINS installed on this machine, read from
# ~/.claude/plugins/installed_plugins.json. That file is the whole list — Sparkle never scans your
# transcripts to see which skills you actually invoked, and never reports a skill you did not
# install. skills_exclude drops names from it before they leave the machine.
#
# Matching is case-insensitive and ignores surrounding spaces, so "WARP", " warp " and "warp" are
# the same entry. The list REPLACES the row on every report, so removing a name here makes the badge
# disappear from your profile on the next cycle (up to 2h) rather than needing anything cleared
# server-side.
#
# If you ALSO run the community tkmx-client reporter, set its SKILLS_EXCLUDE to the same names —
# the two alternate posting to the same profile, so a name excluded in only one of them keeps coming
# back every other cycle. But matching the two lists is NOT a complete fix, because the two
# reporters do not publish the same set: tkmx-client also publishes every ~/.claude/skills/<name>/
# directory you have and the names of your configured MCP servers, neither of which Sparkle ever
# sends. Those extra names keep flapping no matter what you put here (the MCP names are added after
# its exclusions are applied, so SKILLS_EXCLUDE may not suppress them at all). To stop that half,
# leave tkmx-client's REPORT_MACHINE_CONFIG off or retire it — it is the only writer of those names.
[builder_index]
# skills_exclude = ["warp"]   # e.g. a plugin that's installed but that you don't want on show

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
# account_id = ""      # which 1Password account to act as, as its user_uuid (see `op account list`).
                       # Only needed when you're signed in to MORE THAN ONE account, where `op`
                       # refuses every call with "multiple accounts found". Pick it in ⋯ Settings;
                       # unset means "let `op` decide", which is right for a single account.
seed_worktrees = false # restore backed-up env files into each newly created agent worktree

# --- Where Sparkle may publish (per-machine; ignored in a project file) ------------------
# Destinations Sparkle can post to. EMPTY BY DEFAULT — Sparkle publishes nowhere until you add
# one here, which is the only defensible default for something that posts under your name.
#
# IGNORED IN A PROJECT FILE, and that is a security boundary rather than tidiness: a destination
# is a network egress target Sparkle sends your bearer token to, so a repo you cloned must not be
# able to name one (or repoint an existing one) merely by shipping a .sparkle/config.toml.
#
# The TOKEN IS NOT WRITTEN HERE. It lives in your OS keychain (macOS Keychain / Windows Credential
# Manager) under `publish-<id>-token`; this file holds only the destination's id and URL, so it can
# be pasted into a bug report without leaking a credential. Set the token in ⋯ Settings.
#
# `url` must be https (plain http is allowed only for localhost, so you can develop a destination),
# and must carry no username/password. A row that breaks either rule is skipped with a warning
# naming it, rather than silently dropped.
#
# The table is keyed by id — lowercase letters, digits and dashes — so adding a second destination
# later is one more block, not a migration. v1 talks to exactly one at a time: `active`.
# [publish]
# active = "drodio"
#
# [publish.destinations.drodio]
# name = "drodio.com"                    # what you see on the approval card
# url  = "https://drodio.com/api/mcp"    # the destination's MCP endpoint, sent exactly as written

# --- Claude Code plugins pre-enabled for every agent (repo-scoped; overridable per project) --
# Sparkle turns these Claude Code marketplace plugins ON for every agent it spawns: it installs
# them once (shared, via `claude plugin install`) and writes the marketplace + enabledPlugins
# entries into each agent worktree's .claude/settings.local.json. Setting one false means Sparkle
# writes nothing about it and never installs it — it does NOT turn off a plugin you enabled
# yourself. Toggle these here or in ⋯ Settings → "Tools".
#
# These rows come from SIX different marketplaces, and who owns each one is the thing to read:
#   • Anthropic's official marketplace (anthropics/claude-plugins-official): superpowers,
#     frontend_design, hookify, code_simplifier.
#   • Sparkle's own public marketplace (github.com/try-sparkle/marketplace, Apache-2.0): the
#     sparkle_* rows — the same opinions Sparkle applies internally, published so you can read,
#     fork, or use them without Sparkle.
#   • FOUR THIRD-PARTY marketplaces, owned by neither Anthropic nor Sparkle:
#       obra/superpowers-marketplace ............ elements_of_style, double_shot_latte
#       EveryInc/compound-engineering-plugin .... compound_engineering
#       trailofbits/skills ...................... differential_review
#       2389-research/claude-plugins ............ review_squad
#
# TRUST: a default-on plugin means Sparkle fetches that content and enables it in every agent
# worktree. Three limits worth knowing, all stated as what is actually true rather than as
# reassurance:
#   • Content from SPARKLE'S marketplace is pinned; content from Anthropic's is not pinned by us.
#     Sparkle's marketplace names each plugin by an exact ref + commit sha, enforced by that repo's
#     CI, so editing a skill or hook file alone does not reach you. Anthropic's official marketplace
#     (superpowers, frontend_design, hookify, code_simplifier) is registered the same way any
#     marketplace is — by repo name — and what it serves is Anthropic's to decide; Sparkle adds no
#     pin of its own there.
#     Neither LISTING is pinned either way: Sparkle registers a marketplace by repo name, so a
#     change to the listing itself (a new row, or a row re-pointed at a different sha) is picked up
#     on the next fetch.
#   • THE FOUR THIRD-PARTY MARKETPLACES ARE PINNED BY NOBODY HERE. Sparkle does not own, audit, or
#     pin obra/superpowers-marketplace, EveryInc/compound-engineering-plugin, trailofbits/skills or
#     2389-research/claude-plugins. Sparkle registers each by repo name and installs whatever that
#     listing points at, at the time of the fetch — so what those five rows run in your agent
#     worktrees is whatever their owners publish, and it can change without Sparkle changing.
#     Setting a row false below stops SPARKLE fetching it for this config layer — read the next
#     point before relying on that, because a project you clone can turn it back on. These rows
#     ship ON because their skills and commands are useful at the moment they become relevant and
#     an agent will not stop to go install one; what you are trading for that is the paragraph
#     above, which is why it is stated rather than summarized as "trusted".
#   • A row set false here stops Sparkle for THIS config layer. [plugins] is repo-overridable, so a
#     .sparkle/config.toml checked into a project you clone can turn a row back on for that project
#     — the same way it can for [workflow]. If that matters to you, check a cloned repo's
#     .sparkle/config.toml. Turning a row off also never disables a plugin you installed yourself.
[plugins]
superpowers            = true    # the most-used agent methodology plugin: plan → TDD → review
frontend_design        = true    # Anthropic's official UI-quality skill
hookify                = true    # turn a "always do X after Y" instruction into a real Claude Code hook
code_simplifier        = true    # cut accidental complexity out of code you just wrote, on request
sparkle_guardrails     = false   # public copy of the built-in guardrails; on only if you want it as a skill
sparkle_freshness      = true    # warn when your branch is far behind the default branch
sparkle_mutation_check = false   # /mutation-check — prove a given test can actually fail
# The four below are OFF because their content is not published yet, not because they are optional
# in the way the two rows above are. Turning one on today makes Sparkle retry a failing install on
# every launch and the row shows a "couldn't install" hint; they flip to true once each name appears
# in github.com/try-sparkle/marketplace's listing.
sparkle_conflict_watch = false   # catch a PR that cannot merge and is therefore UNTESTED: a conflicting
                                 # PR never fires GitHub's pull_request event, so no CI run is ever
                                 # created — its checks are ABSENT, not failing
sparkle_secrets        = false   # the SKILL for restoring a project's .env from 1Password without the
                                 # traps that bite in practice. It does not back anything up on its own —
                                 # the [tools].onepassword switch above is what performs backups
sparkle_review_probes  = false   # don't merge a PR that still carries unanswered [blocking] review probes
sparkle_pusher         = false   # surface a fleet condition to you proactively instead of waiting to be asked

# Third-party rows — see the ownership list and the TRUST note above. Sparkle pins none of these.
elements_of_style      = true    # Strunk & White for what an agent writes back to you: prose that says
                                 # the thing instead of padding around it
double_shot_latte      = true    # a second, adversarial pass over an answer before it reaches you
compound_engineering   = true    # capture what a session learned so the next one starts from it
differential_review    = true    # Trail of Bits' review of what a diff CHANGED, security-first
review_squad           = true    # several reviewer personas over one change instead of a single pass

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
# never_idle_armed = true    # arm the never-idle watcher (auto-resumes an idle Improve Sparkle
#                            # agent when there is ready backlog). Defaults true; set false to mute.

# --- Reading preferences (per-machine; ignored in a project file) -----------------------
# How a BEAD CARD draws when the concierge names a bead id in its reply.
[ui]
# true  = the card renders already open — title, id, status, priority, type, progress and
#         "Build It" all visible with no click.
# false = the pre-2026-08 behaviour: every bead renders as a small pill you click to expand.
# Either way the collapse control still works: clicking the pill (or the card's x) collapses that
# one card, and it stays collapsed for as long as that message is on screen.
bead_cards_expanded = true
# How many cards ONE reply may expand before the rest fall back to pills. 0 = no cap.
# A reply can name a dozen beads and each card runs several hundred pixels tall, so lower this
# (3 is a good first try) if expanded cards start pushing the reply's own text off screen.
bead_cards_expanded_max = 0

# --- Menu-bar capture (per-machine; ignored in a project file) --------------------------
[capture]
# Global keyboard shortcut that toggles the Sparkle menu-bar popover from anywhere.
# Format: modifiers+key, e.g. "ctrl+shift+r", "alt+f9", "cmd+shift+7". If the value can't
# be parsed or the combo is taken by another app, Sparkle logs a warning and runs without
# a shortcut (the menu-bar icon still works).
popover_shortcut = "ctrl+shift+r"

# --- Voice controls (per-machine; ignored in a project file) ----------------------------
# Which microphone Sparkle captures from. A microphone belongs to the machine, not to a repo, so
# this lives in the global config only. Edit it here or in the ⋯ Settings → "Voice controls" pane.
# Dictation is started and stopped from the send tray (Send / Push to talk / Speak) — there is no
# spoken wake word.
[voice]
# Both keys below are COMMENTED OUT on purpose. Their defaults mean "decide automatically", and a
# stamped literal would read as a pinned CHOICE on every later load — which is the exact trap the
# v1/v3 migrations above exist to undo. Uncomment one only to override it.
#
# The stable CoreAudio device UID of the microphone to capture from — never a name, and never the
# numeric AudioDeviceID (that is reassigned whenever an audio plug-in loads). Unset or empty =
# choose automatically, preferring real hardware. The ⋯ Settings picker writes this for you.
# input_device_uid = "AppleUSBAudioEngine:Blue:Yeti:1"
#
# ADVANCED / PRIVACY. Several audio plug-ins publish system OUTPUT as an input device, so a virtual
# input can carry anything playing on this machine — a call, a video, a stream — into your
# transcript. Off means automatic selection binds real hardware only.
# allow_virtual_input = false

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
# When a checkout is PROVABLY safe to advance — clean tree, on the default branch, and a strict
# ancestor of origin/<default> — Sparkle may fast-forward it for you with no click. Anything else
# (dirty, detached, a feature branch, or diverged) still waits for you. Set false to always ask.
auto_fast_forward         = true

# --- PR-scoped code review (repo-scoped; overridable in a project file) -----------------
# Which PR-scoped reviewer watches this repo. Sparkle's merge gate refuses to land a PR that still
# carries an UNANSWERED [blocking] probe, and separately refuses one whose current head no NEW
# review has covered yet ("not converged").
#
# Set this to "none" when no PR-scoped reviewer watches the repo. That retires the CONVERGENCE
# half only — otherwise it can never be satisfied, because no new review will ever arrive, and the
# refusal's own remedy ("ask for a re-review and wait") cannot be followed.
#
# It does NOT retire the probe half: [blocking] probes already posted on a PR are real findings and
# still block the merge. A reviewer going away does not answer the questions it already asked.
#
# The value is matched TRIMMED and CASE-INSENSITIVELY, so "none", "None" and " none " are the same
# setting — the shell merge gate (scripts/probe-gate.sh) normalises identically, and the two must
# agree or the in-app merge button and `gh pr merge` disagree about the same PR. Anything that is
# not the word "none" — including a typo like "nonesuch" — means a reviewer IS expected.
[review]
pr_reviewer = "knightwatch"

# Whether a PR that has NEVER been reviewed is refused too. Off by default: the convergence half
# above only applies once at least one review exists, so until you set this, a PR nobody ever
# reviewed merges freely — running the reviewer ONCE arms the gate for every later push, while
# never running it leaves the PR ungated.
#
# Turning it on refuses an unreviewed PR and names a command the author can run themselves. It does
# nothing where pr_reviewer = "none": a repo nobody reviews cannot be asked to produce a review.
#
# Only the exact word true arms it — the opposite leniency to pr_reviewer above, on purpose. A typo
# there must not silently disarm a gate; a typo here must not silently arm one.
require_review = false

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

# --- Live in-app browser preview (repo-scoped; overridable in a project file) -----------
# Sparkle can run a project's dev server for an agent's worktree and show the live site in a
# pane, hot-reloading as the agent edits. There is deliberately NO max_servers: a preview pane
# covers one column pair and there are two pairs, so the layout is the ceiling.
[preview]
# false = never detect a preview target and never spawn a dev server.
# A PROJECT file may only NARROW this: it can set false to opt itself out, but a project
# `enabled = true` is IGNORED. Otherwise a repo could re-enable previews for a user who turned
# them off, merely by being cloned — and this switch gates spawning a long-lived process whose
# command line comes from that same repo's config and package.json.
enabled        = true
# How many minutes a preview keeps serving after its pane is covered, before Sparkle stops it.
# A grace period, not a cap — flipping to Plan and back shouldn't pay a full cold compile.
# Capped at 120: with no max_servers and no runaway-kill path, this is one of only three things
# that ever stops a server, so an unbounded value is a dev server that never exits.
idle_grace_min = 10
# How eagerly a Sparkle agent is TOLD to open a preview of its own work. What a preview LOOKS like
# is settled: a card in the concierge chat, showing a snapshot of the running site, which opens the
# real localhost url when clicked. This decides how often one gets opened at all.
#   "visual" = open one whenever the work changes something a person would look at (the default)
#   "always" = open one whenever the project can be previewed at all
#   "never"  = say nothing about previews in the brief; open them by hand
agent_eagerness = "visual"
# A PROJECT's .sparkle/config.toml may also set command / args / path / port here to override
# previewability detection outright, e.g.:
#   command = "pnpm"
#   args    = ["run", "dev:web"]
#   path    = "apps/web"
#   port    = 4321            # optional; skips port allocation and uses this one verbatim
# Those are read straight off the project's own file by the detector, so they are only
# meaningful in a project config, never in this global one. This is the escape hatch for a
# project detection declines to guess at — Sparkle itself is one, with four dev:* scripts and
# no plain `dev`.
#
# HAND-WRITTEN ONLY. Sparkle's own settings tool refuses to set command/args/path/port and will
# tell you to edit the file directly. They are not merged into the effective config — the
# detector reads them from the project file — so a tool that wrote one would have to report it
# back as unset. The three keys above (enabled / idle_grace_min / agent_eagerness) ARE merged and
# can be set through the app.

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

/// Split a dotted config path into key SEGMENTS, honouring TOML's quoted-key form.
///
/// A plain `split('.')` was correct for as long as every config key was a bare TOML key. It stopped
/// being correct with `[concierge.projects."<owner>/<repo>".tools]`: a repo slug contains a `/`,
/// which TOML cannot express as a bare key, so the quoting is LOAD-BEARING — and a slug may also
/// contain a `.` (`plow-pbc/tkmx.server`), which the naive splitter tears in half. The damage is
/// silent: the write lands under an invented nesting of tables nobody reads, so the rule the user
/// just set does nothing and the file still parses.
///
/// Both TOML quoted-key spellings are accepted: `"basic"` (with `\"` / `\\` escapes) and
/// `'literal'` (no escapes). An unterminated quote is an ERROR rather than a best guess — writing
/// to a mis-parsed path is exactly the silent failure above.
fn split_dotted_path(path: &str) -> Result<Vec<String>, String> {
    let mut parts: Vec<String> = Vec::new();
    let mut chars = path.chars().peekable();
    loop {
        // Skip separators; empty segments stay filtered out, as they always were.
        while chars.peek() == Some(&'.') {
            chars.next();
        }
        let Some(&c) = chars.peek() else { break };
        if c == '"' || c == '\'' {
            let quote = c;
            chars.next();
            let mut seg = String::new();
            let mut closed = false;
            while let Some(ch) = chars.next() {
                if ch == '\\' && quote == '"' {
                    // Basic strings honour escapes; the two that can appear in a key we write are
                    // the quote itself and the backslash. Anything else is passed through verbatim
                    // rather than being rejected — this is a config path, not a TOML parser.
                    match chars.next() {
                        Some(esc @ ('"' | '\\')) => seg.push(esc),
                        Some(other) => {
                            seg.push('\\');
                            seg.push(other);
                        }
                        None => break,
                    }
                    continue;
                }
                if ch == quote {
                    closed = true;
                    break;
                }
                seg.push(ch);
            }
            if !closed {
                return Err(format!("config path '{path}' has an unterminated quoted key"));
            }
            // A quoted segment is kept even when EMPTY (`""` is a legal TOML key), unlike the bare
            // form where an empty segment is just a doubled dot.
            parts.push(seg);
            // What follows a closing quote must be a separator or the end of the path.
            match chars.peek() {
                None | Some('.') => {}
                Some(other) => {
                    return Err(format!(
                        "config path '{path}' has '{other}' after a quoted key; expected '.'"
                    ));
                }
            }
        } else {
            let mut seg = String::new();
            while let Some(&ch) = chars.peek() {
                if ch == '.' {
                    break;
                }
                seg.push(ch);
                chars.next();
            }
            if !seg.is_empty() {
                parts.push(seg);
            }
        }
    }
    if parts.is_empty() {
        return Err("empty config path".to_string());
    }
    Ok(parts)
}

/// Surgically set a dotted `path` (e.g. `workers.max_concurrent`) in a TOML document,
/// creating intermediate tables as needed, WITHOUT disturbing surrounding comments/formatting.
///
/// Quoted segments are one key: `concierge.projects."owner/repo.x".tools.merge_pr` addresses four
/// levels, not six. See [`split_dotted_path`].
fn set_dotted(doc: &mut toml_edit::DocumentMut, path: &str, value: toml_edit::Value) -> Result<(), String> {
    let parts = split_dotted_path(path)?;
    let mut item: &mut toml_edit::Item = doc.as_item_mut();
    for part in &parts[..parts.len() - 1] {
        let part = part.as_str();
        match item.get(part) {
            // Implicit tables keep the file tidy (only `[workflow.drift]` appears, not `[workflow]`).
            None => {
                let mut t = toml_edit::Table::new();
                t.set_implicit(true);
                item[part] = toml_edit::Item::Table(t);
            }
            // A malformed path that tries to descend through a scalar (e.g. `workflow.require_pr.x`)
            // would otherwise panic in toml_edit's IndexMut — return an error instead.
            Some(existing) if !existing.is_table() => {
                return Err(format!("config path '{path}' traverses '{part}', which is not a table"));
            }
            Some(_) => {}
        }
        item = &mut item[part];
    }
    let last = parts[parts.len() - 1].as_str();
    item[last] = toml_edit::Item::Value(value);
    Ok(())
}

/// Surgically REMOVE a dotted `path` from a TOML document, preserving surrounding comments/format.
/// A missing key (or a missing intermediate table) is a no-op — removing an unset rule is harmless.
/// A path that tries to descend through a non-table scalar is an error (matches set_dotted).
fn unset_dotted(doc: &mut toml_edit::DocumentMut, path: &str) -> Result<(), String> {
    // Quoted segments parsed the same way `set_dotted` parses them — a path that can be SET must be
    // removable by the same string, or the ⋯ editor and the settings pane disagree about what a
    // per-repo rule is called.
    let parts = split_dotted_path(path)?;
    let mut item: &mut toml_edit::Item = doc.as_item_mut();
    for part in &parts[..parts.len() - 1] {
        let part = part.as_str();
        match item.get(part) {
            None => return Ok(()), // intermediate table absent → nothing to remove
            Some(existing) if !existing.is_table() => {
                return Err(format!("config path '{path}' traverses '{part}', which is not a table"));
            }
            Some(_) => {}
        }
        item = &mut item[part];
    }
    let last = parts[parts.len() - 1].as_str();
    if let Some(table) = item.as_table_mut() {
        table.remove(last);
    } else if let Some(inline) = item.as_inline_table_mut() {
        inline.remove(last);
    }
    Ok(())
}

/// Schema revision of the on-disk global config. Bump when adding a one-time migration below.
const CONFIG_MIGRATION_VERSION: i64 = 4;

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
    // Parse DIRECTLY. A shared loader USED TO fall back to DEFAULT_TEMPLATE on a syntax error
    // (roborev 53240); it is deleted, and `load_document_for_write` now refuses instead. That
    // fallback was safe behind an explicit user write, but here
    // it would stamp the template over a config the user merely typo'd and `write_atomic` it, wiping
    // every setting AND the broken text they need in order to fix it — silently, since the write
    // succeeds.
    //
    // (The `read_if_exists` on the line above shares the absent-vs-unreadable blind spot the rest
    // of this file now avoids, but the consequence HERE is benign and so it is left alone: an
    // unreadable file returns `Ok(())` before this parse is ever reached, which defers the
    // migration with no write and no loss, and the next launch retries it. That is unlike
    // `load_document_for_write` and `read_layer_for_runtime`, where the same collapse costs the
    // user's settings.)
    //
    // `reload_global` keeps the last-good config and warns precisely so the file can be
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

    // v2 — DELETED. It rewrote a stamped `stop_word = "Sparkle, stop"` to the then-current display
    // phrase. The wake word is retired outright now (dictation runs off the send tray), so
    // `stop_word` is not a key anything reads and migrating its VALUE would be migrating nothing.
    // A leftover line on disk is simply ignored — `PartialVoice` does not deny unknown fields, and
    // no unknown-key warning covers `[voice]` — so removing this block costs the user nothing.
    //
    // The revision NUMBER is deliberately not reused or renumbered: `applied < 3` below still means
    // exactly what it meant, and an install already stamped `config_version = 2` must not be walked
    // back through anything.

    // v3 — the RETIRED `[pushers].model` key, removed for the same reason v1 and v2 exist: the app
    // WROTE this line, so removing it discards nothing the user chose.
    //
    // `model = "claude-haiku-4-5"` shipped inside DEFAULT_TEMPLATE, and `load_document_for_write`
    // still starts from that template when the file is ABSENT (its `NotFound` arm), so the first
    // `set_value` on a fresh install writes the whole thing to disk.
    // The field is gone from `PartialPushers` now (nothing composes a challenge — see the note on
    // PushersConfig), so without this the line falls through to the unknown-key catch-all and emits
    // "[pushers].model is not a Pusher setting … so it has no effect" on EVERY load, permanently,
    // for a line nobody typed. A warning that is always on is a warning the user learns to dismiss,
    // which is the failure `MIN_AGENT_RSS_THRESHOLD_MB` describes from the other direction.
    //
    // Gated on `applied < 3` specifically, never on the aggregate — see the rule above. Unlike v1
    // and v2 the VALUE is not checked: any `model` here is retired regardless of what it says,
    // because the key itself no longer exists rather than merely having a new default.
    let had_retired_pusher_model = applied < 3
        && doc.get("pushers").and_then(|p| p.get("model")).is_some();
    if had_retired_pusher_model {
        // `as_table_like_mut` covers both `[pushers]` and a hand-written inline `pushers = { … }`,
        // exactly as the two blocks above do.
        let Some(t) = doc.get_mut("pushers").and_then(|p| p.as_table_like_mut()) else {
            return Err(
                "[pushers] is not a table; migration deferred until config.toml is fixed".into()
            );
        };
        t.remove("model");
        // Don't strand an empty `[pushers]` stanza the user opens in the Advanced editor.
        if doc.get("pushers").and_then(|p| p.as_table_like()).is_some_and(|t| t.is_empty()) {
            doc.remove("pushers");
        }
        tracing::debug!("config migration v3: removing the retired [pushers].model key");
    }

    // v4 — introduce `[concierge].own_orgs`, EMPTY, and NOTHING ELSE.
    //
    // A migration that CHANGES a tier would be the one thing this whole design must never do:
    // nobody may silently gain — or lose — authority by upgrading. So this writes a key whose value
    // is identical to the built-in default, purely so the lever is DISCOVERABLE in the file the
    // user hand-edits. An empty list means every repo is foreign, which floors main-touching tools
    // at `ask` — exactly the global stopgap this release replaces. Behaviour is preserved by
    // construction, and a tier the human tightened by hand is not readable from here, let alone
    // writable.
    //
    // Gated on `applied < 4` specifically, never on the aggregate — see the rule above. Skipped
    // outright when the key already exists: a user who set his org before upgrading keeps it.
    let concierge_is_new = doc.get("concierge").is_none();
    let add_own_orgs = applied < 4
        && doc
            .get("concierge")
            .map_or(true, |c| c.get("own_orgs").is_none());
    if add_own_orgs {
        if concierge_is_new {
            let mut table = toml_edit::Table::new();
            table.decor_mut().set_prefix(
                "\n# --- Which GitHub orgs are YOURS (per-machine) ---------------------------------\n\
                 # Repos under an org listed here are treated as your own. Everywhere else, Sparkle\n\
                 # asks you first before it does anything to the main branch — merging a PR, landing\n\
                 # a branch — however permissive [concierge.tools] is. Empty (the shipped value)\n\
                 # means every repo gets that treatment.\n\
                 #   own_orgs = [\"your-github-org\", \"your-github-username\"]\n\
                 # This list is the ONLY way to lift that. A per-repo entry under\n\
                 # [concierge.projects.\"owner/repo\".tools] can only make a repo STRICTER.\n",
            );
            doc.insert("concierge", toml_edit::Item::Table(table));
        }
        // `as_table_like_mut` covers both `[concierge]` and a hand-written inline
        // `concierge = { … }`, exactly as the `workers`/`pushers` blocks above do. A shape neither
        // one accepts DEFERS rather than falling through — stamping the version on a file we failed
        // to edit would mark the migration applied when it wasn't.
        let Some(t) = doc.get_mut("concierge").and_then(|c| c.as_table_like_mut()) else {
            return Err(
                "[concierge] is not a table; migration deferred until config.toml is fixed".into(),
            );
        };
        t.insert("own_orgs", toml_edit::value(toml_edit::Array::new()));
        tracing::debug!("config migration v4: adding the empty [concierge].own_orgs lever");
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
    // Announced only after the write lands — the error exits above persist nothing.
    if is_legacy_default {
        tracing::info!(
            "config migration v1: adopted automatic worker concurrency (removed the legacy \
             max_concurrent = {LEGACY_DEFAULT_MAX_CONCURRENT}, which was a default, not a choice)"
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

/// Load the global config as an editable document FOR A WRITE — deliberately not a plain read.
///
/// Every arm of this file now distinguishes "absent" from "present but unusable", and this function
/// is where that rule is strictest, because it is the one whose output gets persisted back.
///
/// TWO THINGS IT REFUSES, both of which used to be silent data loss:
///
/// 1. A PRESENT-BUT-UNPARSEABLE file. A shared loader once fell back to `DEFAULT_TEMPLATE` on any
///    parse failure and every writer went through it — so the document being edited was the
///    TEMPLATE rather than the user's file, and rendering it back replaced their config with the
///    default: every setting, every comment, and the malformed text needed to repair it, gone. The
///    `parse_layer` validation below could not catch that, because the template is perfectly valid
///    TOML — it was the WRONG document, not an invalid one. That loader is deleted; the editor's
///    read (`read_editor_text`) surfaces an error instead, since presenting the default as the
///    file's contents is one Save away from the same loss.
///
/// 2. A file it cannot READ AT ALL. This does not use `read_if_exists`, which is
///    `read_to_string(..).ok()` and collapses *every* read error into `None`: invalid UTF-8 from a
///    hand-edit saved in another encoding or a truncated write, `EACCES` on the file inside a
///    writable directory, `EIO` from failing storage. Each is a file that EXISTS and holds the
///    user's settings, and each would take the absent branch — template, then `write_atomic`'s
///    rename, then the config is the default. The same loss, through the one branch that looked
///    safe.
///
/// So only `NotFound` falls back to the template. A hand-edited config makes both reachable by a
/// typo, and neither needs user action to fire: any automatic launch-time write lands it at startup.
///
/// The governing rule, worth stating once for the whole file: **a read we could not complete is
/// never evidence that there is nothing to lose.** `load_project_document`, `write_stage_definition`,
/// `read_editor_text` and `read_layer_for_runtime` all follow it.
fn load_document_for_write(app_data: &Path) -> Result<toml_edit::DocumentMut, String> {
    match std::fs::read_to_string(global_path(app_data)) {
        Ok(text) => text.parse::<toml_edit::DocumentMut>().map_err(|e| {
            format!("existing config.toml is not valid TOML; fix it before editing it: {e}")
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DEFAULT_TEMPLATE
            .parse()
            .map_err(|e| format!("default template is not valid TOML: {e}")),
        Err(e) => Err(format!(
            "existing config.toml could not be read, so it will not be overwritten: {e}"
        )),
    }
}

/// Set one key in the global config file, preserving comments/formatting. `path` is dotted.
pub fn set_value(app_data: &Path, path: &str, value: &serde_json::Value) -> Result<(), String> {
    let v = json_to_toml_value(value)?;
    let mut doc = load_document_for_write(app_data)?;
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
    let mut doc = load_document_for_write(app_data)?;
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
    let mut doc = load_document_for_write(app_data)?;
    unset_dotted(&mut doc, path)?;
    let text = doc.to_string();
    parse_layer(&text)
        .map_err(|e| format!("rejected: that change would make config.toml invalid: {e}"))?;
    write_atomic(&global_path(app_data), &text)
}

/// Read the per-project `.sparkle/local.toml` as an editable document, preserving its comments +
/// other sections. Refuses to clobber an existing-but-unparseable file (matches
/// `write_stage_definition`); an absent file starts from an empty document.
///
/// THE TRACKED `.sparkle/config.toml` IS NEVER OPENED HERE, and that is the point of the split:
/// this is the write path, and writing repo policy at runtime is what dirties a tracked file and
/// wedges a checkout's fast-forward (see `local_path`). Reads still see both files — the layering
/// happens in `build_effective_layered`, not here.
///
/// ONLY `NotFound` MAY START FROM AN EMPTY DOCUMENT — the same rule as `load_document_for_write`,
/// and it matters MORE here. The absent branch on this side is an *empty* document, not the default
/// template, so a write that reaches it renders a file holding only the key just set. An unreadable
/// `.sparkle/local.toml` (invalid UTF-8 from a hand-edit, a truncated write, `EACCES`, `EIO`) would
/// therefore be replaced by a one-key file: every local setting and every locally-defined
/// `[done]`/`[delivered]` stage gone, along with the bytes needed to repair it. `read_if_exists`
/// collapses all of those into `None`, which is why this reads the error kind directly.
fn load_project_document(project_root: &str) -> Result<toml_edit::DocumentMut, String> {
    let path = local_path(project_root);
    match std::fs::read_to_string(&path) {
        Ok(text) => text.parse::<toml_edit::DocumentMut>().map_err(|e| {
            format!("existing .sparkle/local.toml is not valid TOML; fix it before editing it: {e}")
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(toml_edit::DocumentMut::new()),
        Err(e) => Err(format!(
            "existing .sparkle/local.toml could not be read, so it will not be overwritten: {e}"
        )),
    }
}

/// Set one dotted key in the PER-PROJECT `.sparkle/local.toml` (comment-preserving), validating the
/// rendered result first. Used for "this project" auto-approve rules.
///
/// Lands in `local.toml`, NOT the tracked `.sparkle/config.toml` — see `local_path` for why. The
/// resolved value is unchanged, because the local layer sits directly above the tracked one — so a
/// key the tracked file also sets resolves to the value written here.
///
/// It also DROPS any `[cleared]` entry for the same key, so setting and clearing are exact inverses
/// on this file. Leaving one would be inert today (the value written here is applied after the
/// erasure and wins), but it would mean a later hand-edit that deletes this key resolves past the
/// tracked file instead of back to it — a stale tombstone deciding an outcome nobody asked it to.
pub fn set_project_value(project_root: &str, path: &str, value: &serde_json::Value) -> Result<(), String> {
    let v = json_to_toml_value(value)?;
    let mut doc = load_project_document(project_root)?;
    set_dotted(&mut doc, path, v)?;
    discard_cleared_key(&mut doc, path);
    let text = doc.to_string();
    parse_layer(&text)
        .map_err(|e| format!("rejected: that change would make .sparkle/local.toml invalid: {e}"))?;
    write_atomic(&local_path(project_root), &text)
}

/// Clear one dotted key for a project: remove it from `.sparkle/local.toml` AND, when the tracked
/// `.sparkle/config.toml` still sets it, record a `[cleared]` tombstone so the resolved value
/// actually changes. A present-but-unparseable local file is refused rather than clobbered.
///
/// WHY THE TOMBSTONE, given that this file is a pure override stack: because "remove the key from
/// the top layer" does not clear a key set in the layer BELOW it, and this writer may not touch
/// that layer — it is tracked, and writing it is what wedged the shared checkout (`local_path`).
/// Without the tombstone the common case wrote nothing, returned Ok, and the UI's re-pull resolved
/// the tracked value and snapped the toggle back: the rule could not be cleared from the UI at all,
/// on every install predating the split, since `.sparkle/config.toml` is simply where these values
/// used to be written (roborev 66889). That is the "report a removal that never happened" failure
/// the `NotFound` note below argues against, arrived at from the other side.
///
/// The tracked file is still never written. What is recorded is this machine's statement that the
/// key does not apply here — gitignored, and no different in kind from any other local override.
///
/// NO-OP MEANS NO WRITE, not an empty file: when neither layer holds the key the rendered document
/// is unchanged and nothing is written, so a repo that has never had a `local.toml` still does not
/// get one from a stray clear.
pub fn unset_project_value(project_root: &str, path: &str) -> Result<(), String> {
    // NOT gated on the local file existing. It used to be — and that early return is exactly the
    // defect above, because the tombstone this may now need to record lives in a file that, on a
    // pre-split install, does not exist yet. `load_project_document` still splits the cases the
    // gate got right: `NotFound` starts from an empty document, and an unreadable-but-PRESENT file
    // is refused loudly rather than reporting a removal that never happened.
    let mut doc = load_project_document(project_root)?;
    let before = doc.to_string();
    unset_dotted(&mut doc, path)?;
    if tracked_layer_sets(project_root, path) {
        record_cleared_key(&mut doc, path)?;
    }
    let text = doc.to_string();
    if text == before {
        return Ok(());
    }
    parse_layer(&text)
        .map_err(|e| format!("rejected: that change would make .sparkle/local.toml invalid: {e}"))?;
    write_atomic(&local_path(project_root), &text)
}

/// Does the TRACKED `.sparkle/config.toml` set this dotted key? Asked so a tombstone is recorded
/// only when it would do something — `[cleared]` in a repo whose tracked file never mentions the
/// key would be noise in a file the user reads.
///
/// FALSE for a file that is absent, unreadable, or unparseable, and those collapse together on
/// purpose: each means the tracked LAYER contributes nothing to the resolved config (an unparseable
/// one is refused wholesale by `apply_project_layer`), so there is nothing for a tombstone to erase.
fn tracked_layer_sets(project_root: &str, path: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(project_path(project_root)) else {
        return false;
    };
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else {
        return false;
    };
    let Ok(parts) = split_dotted_path(path) else {
        return false;
    };
    let mut item = doc.as_item();
    for part in &parts {
        match item.get(part.as_str()) {
            Some(next) => item = next,
            None => return false,
        }
    }
    !item.is_none()
}

/// The `[cleared]` table as a mutable array, created on demand. `Err` when the file already carries
/// a `[cleared]` of the wrong shape (a hand-edit, or a name collision with something a future
/// Sparkle adds) — refusing beats overwriting a user's bytes on a path whose whole job is bookkeeping.
fn cleared_array<'a>(doc: &'a mut toml_edit::DocumentMut) -> Result<&'a mut toml_edit::Array, String> {
    if !doc.contains_key(CLEARED_TABLE) {
        let mut t = toml_edit::Table::new();
        // A user opens this file. Say what the block is for, next to it — a bare list of dotted
        // strings under an unexplained header reads like corruption.
        t.decor_mut().set_prefix(
            "\n# Settings you cleared in Sparkle that the repo's tracked .sparkle/config.toml still\n\
             # sets. Each entry is a dotted key; that file's value for it is ignored on THIS machine,\n\
             # so the setting falls back as if the repo never set it. Delete a line to get it back.\n",
        );
        doc.insert(CLEARED_TABLE, toml_edit::Item::Table(t));
    }
    let table = doc[CLEARED_TABLE]
        .as_table_mut()
        .ok_or_else(|| format!("existing [{CLEARED_TABLE}] in .sparkle/local.toml is not a table"))?;
    table
        .entry("keys")
        .or_insert(toml_edit::value(toml_edit::Array::new()))
        .as_array_mut()
        .ok_or_else(|| format!("existing [{CLEARED_TABLE}].keys in .sparkle/local.toml is not an array"))
}

/// Record `path` in `[cleared].keys`, idempotently — clearing an already-cleared key must not grow
/// the list, or a UI that re-sends the same clear (a re-render, a retry) appends forever.
fn record_cleared_key(doc: &mut toml_edit::DocumentMut, path: &str) -> Result<(), String> {
    let arr = cleared_array(doc)?;
    if !arr.iter().any(|v| v.as_str() == Some(path)) {
        arr.push(path);
    }
    Ok(())
}

/// Drop `path` from `[cleared].keys`, removing the table once it is empty so the file does not keep
/// an explanatory comment about a list with nothing in it. Silent when there is nothing to drop, and
/// silent on a malformed `[cleared]`: this runs inside a SET, and a set must not fail because of
/// bookkeeping it did not need.
fn discard_cleared_key(doc: &mut toml_edit::DocumentMut, path: &str) {
    let Some(table) = doc.get_mut(CLEARED_TABLE).and_then(|i| i.as_table_mut()) else {
        return;
    };
    if let Some(arr) = table.get_mut("keys").and_then(|i| i.as_array_mut()) {
        arr.retain(|v| v.as_str() != Some(path));
        if arr.is_empty() {
            table.remove("keys");
        }
    }
    if table.is_empty() {
        doc.remove(CLEARED_TABLE);
    }
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
// whole section into the PER-PROJECT `.sparkle/local.toml`, insert-or-replacing it while preserving
// the rest of the file (comments + other sections).
//
// LOCAL, NOT THE TRACKED FILE, and this writer is the reason the split exists at all: a Define
// Stage save landed in the tracked `.sparkle/config.toml`, uncommitted, and that ONE dirty path
// aborted `git merge --ff-only` in the shared main checkout for ten days (sparkle-v38y1n). A stage
// definition is still repo-scoped and a team still wants it checked in — that is a human committing
// a `[done]` block to `config.toml`, which keeps applying. What the UI writes is this machine's
// override of it.

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
/// local.toml`, preserving the rest of the file (comments + unrelated sections). `definition` is
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

    let path = local_path(project_root);
    // Preserve the existing local file (comments + other sections). If it exists but is
    // unparseable, refuse rather than clobber a hand-edited file; if absent, start from empty.
    // Only NotFound starts from empty; an unreadable file is refused rather than replaced by a
    // document holding just this stage. Same rule and same reason as `load_project_document`.
    let mut doc = match std::fs::read_to_string(&path) {
        Ok(text) => text.parse::<toml_edit::DocumentMut>().map_err(|e| {
            format!("existing .sparkle/local.toml is not valid TOML; fix it before defining a stage: {e}")
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => toml_edit::DocumentMut::new(),
        Err(e) => {
            return Err(format!(
                "existing .sparkle/local.toml could not be read, so it will not be overwritten: {e}"
            ))
        }
    };
    // Insert-or-replace: assigning the key REPLACES the whole prior `[done]`/`[delivered]` table
    // (and its `[[<key>.criteria]]`) in place, rather than appending a second one.
    doc[key] = toml_edit::Item::Table(table);

    let text = doc.to_string();
    // Round-trip validation: the rendered file must parse cleanly through the typed layer before we
    // persist it (matches the write_text / set_value contract — never write an invalid config).
    parse_layer(&text).map_err(|e| {
        format!("rejected: that stage definition would make local.toml invalid: {e}")
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

/// Set one dotted key in a PROJECT's gitignored `.sparkle/local.toml` (comment-preserving). Used
/// for a "this project" auto-approve rule; the tracked `.sparkle/config.toml` is never written. Emits a fresh GLOBAL `config-changed` so listeners re-pull —
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

/// Remove one dotted key from a PROJECT's gitignored `.sparkle/local.toml`. Used to clear a "this
/// project" auto-approve rule (or un-mute a `never`); a rule set in the tracked
/// `.sparkle/config.toml` is repo policy and is not removable from the UI. See `set_project_config_value` for the emit rationale.
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
    read_editor_text(&global_path(&ad))
}

/// The raw editor's read, split out so it is testable without an `AppHandle`.
///
/// THE READ ARM OF THE SAME DATA LOSS, and it needs one click rather than none. Showing
/// `DEFAULT_TEMPLATE` for a file that could not be READ is indistinguishable from a first-run empty
/// state: the editor gives no sign a file exists, and pressing Save calls `write_text`, which
/// validates the template (perfectly valid TOML) and atomically renames it over the user's
/// `config.toml` — destroying the settings and the bytes needed to repair them.
///
/// Only UNREADABLE files are affected. A merely-unparseable-but-UTF-8 file already shows its own
/// broken text, which is the point of the editor and must keep working.
fn read_editor_text(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DEFAULT_TEMPLATE.to_string()),
        Err(e) => Err(format!(
            "config.toml exists but could not be read: {e}. Fix or move it; the editor will not \
             show the default in its place, because saving that would overwrite your file."
        )),
    }
}

/// Insert-or-replace a per-project `[done]`/`[delivered]` stage definition in the project's
/// gitignored `.sparkle/local.toml`, preserving comments + other sections. `key` must be "done" or
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

    /// The four newer Sparkle rows, pinned by their EXACT `<plugin>@<marketplace>` id and by the
    /// fact that they ship OFF while `try-sparkle/marketplace` does not yet carry the content.
    ///
    /// Three assertions, each failing differently — and the third is what stops the second from
    /// being vacuous:
    ///   * A wrong `@marketplace` half writes a settings file Claude Code SILENTLY ignores — no
    ///     error, no missing-plugin message, the plugin simply never loads.
    ///   * ABSENCE from the shipped enabled set is the default being pinned. Shipping one ON before
    ///     its content is published makes the install pass retry a failing `claude plugin install`
    ///     on every launch and renders the row with a "couldn't install" hint. This assertion is
    ///     therefore meant to go RED on the eventual flip — that is the tripwire, not collateral:
    ///     flipping a row means confirming its name is in the marketplace listing and re-pointing
    ///     this test in the same commit.
    ///   * Absence ALONE would be satisfied by a row that does not exist, or whose toggle was never
    ///     wired into `PluginsConfig` — the two ways this catalog silently loses a plugin. So each
    ///     row is also asserted LIVE: with every toggle forced on it resolves to that same exact id.
    ///     Without this, deleting all four rows outright would leave the test green.
    #[test]
    fn the_newer_sparkle_plugins_resolve_to_their_exact_marketplace_ids_and_ship_off() {
        let (cfg, _, _) = effective(None, None);
        let shipped: Vec<String> = cfg.plugins.enabled().iter().map(|p| p.id()).collect();
        let when_on: Vec<String> = PluginsConfig::with_all(true)
            .enabled()
            .iter()
            .map(|p| p.id())
            .collect();

        for (toggle, want_id) in [
            ("sparkle_conflict_watch", "sparkle-conflict-watch@sparkle"),
            ("sparkle_secrets", "sparkle-secrets@sparkle"),
            ("sparkle_review_probes", "sparkle-review-probes@sparkle"),
            ("sparkle_pusher", "sparkle-pusher@sparkle"),
        ] {
            let row = KNOWN_PLUGINS
                .iter()
                .find(|p| p.toggle == toggle)
                .unwrap_or_else(|| panic!("no KNOWN_PLUGINS row for `{toggle}`"));
            assert_eq!(row.id(), want_id, "`{toggle}` must resolve to the exact Claude Code key");
            assert!(
                when_on.contains(&want_id.to_string()),
                "`{toggle}` must be a LIVE toggle — turning it on has to enable `{want_id}`"
            );
            assert!(
                !shipped.contains(&want_id.to_string()),
                "`{toggle}` must ship OFF until `{want_id}` exists in try-sparkle/marketplace — \
                 an enabled row whose content is unpublished retries a failing install every launch.\n\
                 \n\
                 IF YOU ARE FLIPPING THIS ON, THE FLIP IS NOT ONE LINE. DEFAULT_TEMPLATE has already \
                 written `{toggle} = false` into the config.toml of every user who touched settings \
                 during the interim, and a key present in that file beats `default_on` — so those \
                 users stay OFF forever unless the SAME commit carries a one-shot migration that \
                 removes the key. See the flip note above KNOWN_PLUGINS' four newer rows."
            );
        }
    }

    /// The frontend's `PLUGIN_DEFAULTS` must agree with this table's `default_on` column, row for
    /// row — and NOTHING enforced that until this test, which is exactly how it drifted.
    ///
    /// The four newer rows were flipped to `default_on: false` here while `settingsStore.ts` kept
    /// them `true`, and every suite stayed green: the Rust tests cannot see the TS file, the TS
    /// tests had no assertion on `PLUGIN_DEFAULTS` at all, and the mirror's own doc comment
    /// ("Rust is the authority") reads as a licence to let them diverge. The consequence is small
    /// but real and user-visible — four toggles paint ON for the first frame, then flip OFF when
    /// the config hydrate answers — and the comment sitting above the values kept asserting the
    /// retracted "these ship ON" reasoning, which is what the next reader would have believed.
    ///
    /// Read from disk rather than duplicated, because a hand-copied expectation is one more mirror
    /// to drift. Same technique as `vendored_roborev_post_commit_keeps_its_skip_guards`.
    ///
    /// Both directions are asserted. A missing key catches a Rust row the frontend never learned
    /// about; the count check catches a TS key with no Rust row behind it. A value mismatch is the
    /// drift this exists for.
    #[test]
    fn the_frontend_plugin_defaults_mirror_matches_this_tables_default_on_column() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/stores/settingsStore.ts"
        ))
        .expect("settingsStore.ts must be readable — it is the frontend mirror of KNOWN_PLUGINS");

        let start = src
            .find("export const PLUGIN_DEFAULTS")
            .expect("settingsStore.ts must still export PLUGIN_DEFAULTS");
        let body = &src[start..];
        let end = body.find("\n};").expect("PLUGIN_DEFAULTS must be a closed object literal");
        let body = &body[..end];

        // `key: true,` / `key: false,` — comment lines and the declaration head are skipped, so the
        // prose above each group cannot be mistaken for an entry.
        //
        // AN UNREADABLE LINE IS FATAL, NOT SKIPPED, and that is what gives the count assertion below
        // its teeth. A parser that drops what it cannot read makes the "extra TS key" direction
        // unable to fail in exactly the case it guards: `sparkleFoo: true, // flips once content
        // ships` parses to a value of `true, // flips once content ships`, matches neither literal,
        // and would vanish silently — leaving the counts equal and an orphan frontend toggle
        // shipping green. The sibling helper `template_toggle_value` strips its trailing `#` comment
        // for the same reason; this one has to strip `//`.
        let mut ts: std::collections::BTreeMap<String, bool> = std::collections::BTreeMap::new();
        for line in body.lines() {
            let line = line.trim();
            if line.is_empty()
                || line.starts_with("//")
                || line.starts_with("/*")
                || line.starts_with('*')
                || line.starts_with("export const")
            {
                continue;
            }
            let unparsed = || panic!("unparsed PLUGIN_DEFAULTS line: {line:?}");

            let Some((key, val)) = line.split_once(':') else { unparsed() };
            let key = key.trim().trim_matches('"');
            // Strip a trailing `// comment` before reading the value.
            let val = val.split("//").next().unwrap_or("").trim().trim_end_matches(',').trim();
            if key.is_empty() {
                unparsed()
            }
            match val {
                "true" => drop(ts.insert(key.to_string(), true)),
                "false" => drop(ts.insert(key.to_string(), false)),
                // A value that is neither literal (a constant, an expression) is not something this
                // guard can compare, so it must be loud rather than ignored.
                _ => unparsed(),
            }
        }

        assert!(!ts.is_empty(), "parsed no entries out of PLUGIN_DEFAULTS — has its shape changed?");

        for row in KNOWN_PLUGINS {
            // `sparkle_conflict_watch` -> `sparkleConflictWatch`, the frontend's key spelling.
            let mut camel = String::new();
            let mut upper = false;
            for c in row.toggle.chars() {
                if c == '_' {
                    upper = true;
                } else if upper {
                    camel.push(c.to_ascii_uppercase());
                    upper = false;
                } else {
                    camel.push(c);
                }
            }

            let got = ts.get(&camel).unwrap_or_else(|| {
                panic!(
                    "PLUGIN_DEFAULTS has no `{camel}` — every KNOWN_PLUGINS row needs a frontend \
                     mirror, or the toggle renders with no default at first paint"
                )
            });
            assert_eq!(
                *got, row.default_on,
                "`{}` ships default_on={} in KNOWN_PLUGINS but `{camel}` is {got} in \
                 settingsStore.ts — the toggle would paint wrong until the config hydrate lands, \
                 and the two must flip in the SAME commit",
                row.toggle, row.default_on
            );
        }

        assert_eq!(
            ts.len(),
            KNOWN_PLUGINS.len(),
            "PLUGIN_DEFAULTS has {} entries but KNOWN_PLUGINS has {} — a frontend key with no Rust \
             row behind it is a toggle the backend will never honor",
            ts.len(),
            KNOWN_PLUGINS.len()
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

        // THIRD-PARTY OWNERSHIP, keyed off the table for the same reason the Anthropic clause is:
        // the moment a DEFAULT-ON row comes from a marketplace owned by neither Anthropic nor
        // Sparkle, the trust paragraph's two-marketplace story is false BY OMISSION — it describes
        // what Sparkle fetches into every worktree and would be silently missing four owners. So
        // each such repo must be named in the prose, and adding a fifth third-party marketplace
        // forces this sentence to be revisited instead of quietly going stale.
        //
        // Asserted on the REPO string, not the marketplace name: `trailofbits` names both a
        // marketplace and an org, so a paragraph mentioning the org in passing would satisfy a
        // name check while never telling the reader which repo the content comes from.
        //
        // ...and asserted against the TRUST BLOCK ALONE, not the whole template. The ownership
        // list higher up in the same `[plugins]` comment names these repos too, so a
        // `DEFAULT_TEMPLATE.contains(repo)` check is satisfied by that list and CANNOT fail when
        // the trust paragraph — the part that tells the reader nobody pins this content — quietly
        // stops naming them. Measured: that exact mutation survived, which is the vacuous shape
        // this file's own guidance warns about, so the haystack is narrowed to the paragraph the
        // assertion message claims to be about.
        let trust = {
            let start = t.find("# TRUST:").expect("the [plugins] block must carry a TRUST paragraph");
            let rest = &t[start..];
            let end = rest.find("\n[plugins]\n").expect("the TRUST paragraph precedes the [plugins] table");
            &rest[..end]
        };
        let third_party_repos: std::collections::BTreeSet<&str> = KNOWN_PLUGINS
            .iter()
            .filter(|p| p.default_on)
            .filter(|p| p.marketplace != OFFICIAL_MARKETPLACE && p.marketplace != SPARKLE_MARKETPLACE)
            .filter_map(|p| p.source.map(|s| s.repo))
            .collect();
        assert!(
            !third_party_repos.is_empty(),
            "the Tier 2 rows ship from third-party marketplaces; if that stopped being true, the \
             trust paragraph naming them is what to revisit"
        );
        for repo in &third_party_repos {
            assert!(
                trust.contains(repo),
                "`{repo}` is a DEFAULT-ON marketplace owned by neither Anthropic nor Sparkle, so \
                 the [plugins] trust block must name it — a user deciding whether to keep these \
                 rows on cannot see the owner anywhere else in this file"
            );
        }
        assert!(
            trust.contains("THE FOUR THIRD-PARTY MARKETPLACES ARE PINNED BY NOBODY HERE"),
            "the trust block must say plainly that Sparkle pins none of the third-party \
             marketplaces; naming the repos without that is still an omission"
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

    /// The seven Tier 2 rows (sparkle-s3g2.7), pinned by their EXACT `<plugin>@<marketplace>` id
    /// and by the fact that they SHIP ON.
    ///
    /// The ids are the load-bearing part and are literal on purpose. Three of the four third-party
    /// marketplace names do not match their repo name — `trailofbits` lives in `trailofbits/skills`,
    /// `2389-research` in `2389-research/claude-plugins`, and `compound-engineering-plugin` holds a
    /// plugin called `compound-engineering` — so the plausible guess is wrong in each case, and a
    /// wrong `@marketplace` half writes a settings file Claude Code SILENTLY ignores: no error, no
    /// missing-plugin message, the plugin simply never loads. Every string below was confirmed
    /// against the live `.claude-plugin/marketplace.json` of each repo on 2026-08-25.
    ///
    /// Deriving the expectation from `KNOWN_PLUGINS` would make this agree with any table at all,
    /// including one with a typo — which is the whole failure mode. Hence literals.
    #[test]
    fn the_tier_two_plugins_resolve_to_their_exact_marketplace_ids_and_ship_on() {
        let (cfg, _, _) = effective(None, None);
        let shipped: Vec<String> = cfg.plugins.enabled().iter().map(|p| p.id()).collect();

        for (toggle, want_id, want_repo) in [
            ("hookify", "hookify@claude-plugins-official", "anthropics/claude-plugins-official"),
            (
                "code_simplifier",
                "code-simplifier@claude-plugins-official",
                "anthropics/claude-plugins-official",
            ),
            (
                "elements_of_style",
                "elements-of-style@superpowers-marketplace",
                "obra/superpowers-marketplace",
            ),
            (
                "double_shot_latte",
                "double-shot-latte@superpowers-marketplace",
                "obra/superpowers-marketplace",
            ),
            (
                "compound_engineering",
                "compound-engineering@compound-engineering-plugin",
                "EveryInc/compound-engineering-plugin",
            ),
            ("differential_review", "differential-review@trailofbits", "trailofbits/skills"),
            ("review_squad", "review-squad@2389-research", "2389-research/claude-plugins"),
        ] {
            let row = KNOWN_PLUGINS
                .iter()
                .find(|p| p.toggle == toggle)
                .unwrap_or_else(|| panic!("no KNOWN_PLUGINS row for `{toggle}`"));
            assert_eq!(row.id(), want_id, "`{toggle}` must resolve to the exact Claude Code key");
            let src = row.source.unwrap_or_else(|| {
                panic!("`{toggle}` needs a source — the installer `marketplace add`s from it")
            });
            assert_eq!(
                src.repo, want_repo,
                "`{toggle}` must be installed from the repo whose marketplace.json actually lists it"
            );
            assert!(
                shipped.contains(&want_id.to_string()),
                "`{toggle}` ships ON: the bead is `default installed, invoked on demand`, so the \
                 plugin has to be installed and enabled for the model to reach for it at all"
            );
        }

        // The four unpublished `sparkle_*` rows are NOT part of this change and must stay off —
        // this test would otherwise be satisfied by a blanket flip of the whole table.
        for id in [
            "sparkle-conflict-watch@sparkle",
            "sparkle-secrets@sparkle",
            "sparkle-review-probes@sparkle",
            "sparkle-pusher@sparkle",
        ] {
            assert!(!shipped.contains(&id.to_string()), "{id} must stay off — content unpublished");
        }
    }

    /// Every marketplace named by a row is BACKED by a declared source, and the non-official ones
    /// are the exact set the four new consts describe.
    ///
    /// `every_known_plugin_has_a_live_toggle` already asserts `src.name == p.marketplace` per row,
    /// which catches a source pointing at the wrong marketplace. What it CANNOT catch is a row
    /// whose marketplace name is a typo consistently repeated in its own source — `trailofbit`
    /// twice — because the two agree with each other. This pins the resulting set against the
    /// verified constants, so a name that is not one of the six known marketplaces fails loudly.
    #[test]
    fn every_marketplace_in_the_table_is_one_of_the_six_declared_ones() {
        let mut names: Vec<&str> = KNOWN_PLUGINS.iter().map(|p| p.marketplace).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(
            names,
            vec![
                RESEARCH_2389_MARKETPLACE,
                OFFICIAL_MARKETPLACE,
                COMPOUND_ENGINEERING_MARKETPLACE,
                SPARKLE_MARKETPLACE,
                SUPERPOWERS_MARKETPLACE,
                TRAIL_OF_BITS_MARKETPLACE,
            ],
            "a marketplace name no declared source backs is one Claude Code cannot resolve"
        );

        // The `@<marketplace>` half of an id must be the marketplace's own top-level `name`, never
        // its repo or the repo's trailing path segment — the two differ for three of these four.
        for (name, repo) in [
            (SUPERPOWERS_MARKETPLACE, "obra/superpowers-marketplace"),
            (COMPOUND_ENGINEERING_MARKETPLACE, "EveryInc/compound-engineering-plugin"),
            (TRAIL_OF_BITS_MARKETPLACE, "trailofbits/skills"),
            (RESEARCH_2389_MARKETPLACE, "2389-research/claude-plugins"),
        ] {
            let rows: Vec<&KnownPlugin> =
                KNOWN_PLUGINS.iter().filter(|p| p.marketplace == name).collect();
            assert!(!rows.is_empty(), "`{name}` is declared but no row uses it");
            for row in rows {
                let src = row.source.expect("every row needs a source");
                assert_eq!(src.repo, repo, "`{}` must install from `{repo}`", row.toggle);
                assert!(
                    row.declared_source().is_some(),
                    "`{}` lives in a marketplace Claude Code does not know; without a per-worktree \
                     declaration the settings file names a marketplace the agent cannot resolve",
                    row.id()
                );
            }
        }
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
    fn straude_defaults_off_and_is_independent_of_builder_index() {
        // The second publishing destination, and the second one that must be opted INTO. Same
        // outermost-gate reasoning as builder_index: the reporter also gates on consent + a stored
        // sign-in, but the toggle has to hold on its own.
        let (cfg, _, _) = effective(None, None);
        assert!(!cfg.tools.straude);

        // INDEPENDENCE, both directions. These are competing leaderboards, so consenting to one
        // must never be read as consenting to the other — that would be a silent enablement of a
        // third-party data egress the user never answered a modal for.
        let (cfg, warns, hard) = effective(Some("[tools]\nbuilder_index = true\n"), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(cfg.tools.builder_index);
        assert!(!cfg.tools.straude, "opting into the Builder Index must not opt into straude");

        let (cfg, warns, hard) = effective(Some("[tools]\nstraude = true\n"), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(cfg.tools.straude);
        assert!(!cfg.tools.builder_index, "opting into straude must not opt into the Builder Index");
        assert!(cfg.tools.roborev, "untouched tool keeps its default");
    }

    #[test]
    fn project_cannot_opt_a_machine_into_straude() {
        // Same rule as builder_index: [tools] is machine-wide, so a cloned repo shipping
        // `straude = true` must NOT be able to start publishing this machine's usage.
        let p = "[tools]\nstraude = true\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert!(!cfg.tools.straude);
        assert!(warns.iter().any(|w| w.contains("[tools]")));
    }

    // ── [builder_index] — what the reporter publishes ────────────────────────────────────

    #[test]
    fn nothing_is_excluded_from_the_skills_row_by_default() {
        let (cfg, warns, hard) = effective(None, None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(cfg.builder_index.skills_exclude.is_empty());
        // And a file that mentions the tool toggle does not implicitly configure the reporter.
        let (cfg, _, _) = effective(Some("[tools]\nbuilder_index = true\n"), None);
        assert!(cfg.builder_index.skills_exclude.is_empty());
    }

    #[test]
    fn skills_exclude_normalizes_case_and_whitespace_on_the_way_in() {
        // tkmx-client's `applyExclusions` does `.trim().toLowerCase()` on both sides. Sparkle
        // normalizes the CONFIGURED side here and the candidate side in the reporter, through the
        // same function — the two reporters post to one profile alternately, and the server
        // replaces `claude_skills` wholesale, so a name excluded by only one of them comes back
        // every other cycle instead of disappearing.
        let g = "[builder_index]\nskills_exclude = [\" WARP \", \"Frontend-Design\"]\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert_eq!(cfg.builder_index.skills_exclude, vec!["warp", "frontend-design"]);
    }

    #[test]
    fn skills_exclude_also_accepts_the_comma_separated_spelling() {
        // The shape tkmx-client's SKILLS_EXCLUDE env var takes, which is what someone consolidating
        // the two reporters copies across. Accepting it costs nothing; rejecting it would have cost
        // the whole config layer (see the next test).
        let (cfg, warns, hard) = effective(Some("[builder_index]\nskills_exclude = \"warp, WARP , \"\n"), None);
        assert!(!hard);
        assert!(warns.is_empty());
        // Empties dropped, and the duplicate collapses once both are normalized.
        assert_eq!(cfg.builder_index.skills_exclude, vec!["warp"]);
    }

    #[test]
    fn a_malformed_skills_exclude_costs_that_key_and_nothing_else() {
        // roborev 54240's rule, applied to a key whose failure mode is worse than most: the user
        // reaches for a denylist precisely when they want something GONE from a public profile, so
        // a whole-file parse error would revert their config while still publishing the name.
        let g = "[workflow]\nrequire_pr = false\n\n[builder_index]\nskills_exclude = 7\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard, "one bad key must not fail the layer");
        assert!(cfg.builder_index.skills_exclude.is_empty());
        assert!(
            warns.iter().any(|w| w.contains("[builder_index].skills_exclude")),
            "and it must say so: {warns:?}"
        );
        // The headline side effect: the unrelated setting in the same file SURVIVED.
        assert!(!cfg.workflow.require_pr, "an unrelated setting must not revert to its default");

        // A non-string element inside an otherwise good list costs that element only.
        let g = "[builder_index]\nskills_exclude = [\"warp\", 7]\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert_eq!(cfg.builder_index.skills_exclude, vec!["warp"]);
        assert!(warns.iter().any(|w| w.contains("skills_exclude")), "{warns:?}");
    }

    #[test]
    fn a_project_cannot_change_what_this_machine_publishes_about_you() {
        // Machine-wide in BOTH directions. The dangerous half is un-excluding: a cloned repo must
        // not be able to put a name back onto its owner's public profile.
        let g = "[builder_index]\nskills_exclude = [\"warp\"]\n";
        let p = "[builder_index]\nskills_exclude = []\n";
        let (cfg, warns, _) = effective(Some(g), Some(p));
        assert_eq!(cfg.builder_index.skills_exclude, vec!["warp"], "the global layer stands");
        assert!(warns.iter().any(|w| w.contains("[builder_index]")), "{warns:?}");
    }

    #[test]
    fn the_generated_template_documents_the_denylist_and_parses() {
        // The template is what a user actually edits, so a key misspelled there is a key that
        // silently does nothing. Round-trip it through the real resolver.
        let (cfg, warns, hard) = effective(Some(DEFAULT_TEMPLATE), None);
        assert!(!hard, "the shipped template must parse: {warns:?}");
        assert!(cfg.builder_index.skills_exclude.is_empty(), "the example ships COMMENTED OUT");
        assert!(DEFAULT_TEMPLATE.contains("[builder_index]"));
        // Seeded with the founder's actual case: `warp@claude-code-warp` is installed but unwanted.
        assert!(DEFAULT_TEMPLATE.contains("skills_exclude = [\"warp\"]"));

        // Uncommenting that exact line is what the user will do — prove it works verbatim.
        let uncommented = DEFAULT_TEMPLATE.replace("# skills_exclude = [\"warp\"]", "skills_exclude = [\"warp\"]");
        let (cfg, _, hard) = effective(Some(&uncommented), None);
        assert!(!hard);
        assert_eq!(cfg.builder_index.skills_exclude, vec!["warp"]);
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
    fn never_idle_armed_defaults_true_and_config_can_mute_it() {
        // Founder's armed-by-default: an absent [improvement] section (or one that sets only
        // consent) leaves the arm ON, so the never-idle watcher works out of the box in a build
        // that ships this key.
        let (cfg, _, _) = effective(None, None);
        assert!(cfg.improvement.never_idle_armed, "absent section => armed by default");

        let only_consent = "[improvement]\nconsent = \"always\"\n";
        let (cfg, _, _) = effective(Some(only_consent), None);
        assert!(cfg.improvement.never_idle_armed, "consent-only section keeps the armed default");

        // An explicit false is the mute switch — the whole point of moving off the build-time flag.
        let muted = "[improvement]\nnever_idle_armed = false\n";
        let (cfg, warns, hard) = effective(Some(muted), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(!cfg.improvement.never_idle_armed, "explicit false disarms");

        // It serializes as a plain bool (never null), so the TS reader sees true/false, not an
        // absent key — the Rust->TS seam contract for this field.
        let (cfg, _, _) = effective(None, None);
        let json = serde_json::to_string(&cfg.improvement).expect("serialize");
        assert!(json.contains("\"never_idle_armed\":true"), "emits a concrete bool, got {json}");
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
    fn drainer_enabled_defaults_true_and_config_can_mute_it() {
        // Ships ON with no config file — the founder's directive (zero human steps, on by default).
        // LITERAL expectation, never read back off DrainerConfig::default(), so flipping the shipped
        // default to off makes this test go red rather than silently agree with itself.
        let (cfg, warns, hard) = effective(None, None);
        assert!(!hard);
        assert!(cfg.drainer.enabled, "the backlog drainer ships ON by default");
        assert!(
            !warns.iter().any(|w| w.contains("[drainer]")),
            "the shipped default must load clean: {warns:?}"
        );

        // An explicit `enabled = false` is the rebuild-free KILL SWITCH.
        let g = "[drainer]\nenabled = false\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty(), "a clean off-switch must not warn: {warns:?}");
        assert!(!cfg.drainer.enabled, "enabled = false must mute the loop");

        // An absent [drainer] section (an older config file that predates it) leaves the ON default
        // in place — never read absence as "off".
        let g = "[workflow]\nrequire_pr = true\n";
        let (cfg, _, _) = effective(Some(g), None);
        assert!(cfg.drainer.enabled, "an absent [drainer] keeps the ON default");

        // Serializes as a CONCRETE bool (`"enabled":true`), never a null/absent key: the TS seam
        // (`config.drainer?.enabled ?? true`) depends on the wire carrying true/false, and this is
        // exactly the serde-Option-crosses-as-null trap AGENTS.md warns about, avoided by a plain bool.
        let json = serde_json::to_string(&DrainerConfig { enabled: true }).unwrap();
        assert_eq!(json, "{\"enabled\":true}", "wire shape must be a concrete bool: {json}");
    }

    #[test]
    fn drainer_template_matches_the_default() {
        // Same trap avoided the same way as `pushers_template_matches_the_default`: overlaying the
        // template onto SparkleConfig::default() would pass with the [drainer] block MISSING because
        // the base already holds the value. WIPE the section to something no default could be first.
        let mut base = SparkleConfig::default();
        base.drainer = DrainerConfig { enabled: false };
        let (cfg, warns, hard) = build_effective(base, Some(DEFAULT_TEMPLATE), None);
        assert!(!hard, "the shipped template must parse: {warns:?}");
        assert_eq!(
            cfg.drainer,
            SparkleConfig::default().drainer,
            "DEFAULT_TEMPLATE's [drainer] disagrees with SparkleConfig::default()"
        );
        // Ships LIVE, not commented out: this section is the only in-file place a human can turn the
        // loop off, so there must be something to edit.
        assert!(DEFAULT_TEMPLATE.contains("\n[drainer]\n"), "the block must ship uncommented");
    }

    #[test]
    fn drainer_enabled_reads_off_spellings_and_refuses_nonsense() {
        // The kill switch reads the SAME unambiguous off-spellings as [babysit]/[pushers], and a
        // wrong-typed value must NEVER fail the whole layer (which would discard every unrelated
        // setting AND leave the drainer at its ON default — failing open on a kill switch).
        for spelling in ["false", "\"false\"", "\"off\"", "\"no\"", "0"] {
            let toml = format!("[drainer]\nenabled = {spelling}\n");
            let (cfg, _w, hard) = build_effective(SparkleConfig::default(), Some(&toml), None);
            assert!(!hard, "{spelling} must not be a hard error");
            assert!(!cfg.drainer.enabled, "`enabled = {spelling}` must stop the drainer");
        }
        // A value with no defensible off-reading warns and changes nothing — the default is only ever
        // flipped by an intent, never by a typo, and crucially it stays ON rather than parsing fatally.
        let (cfg, warns, hard) =
            build_effective(SparkleConfig::default(), Some("[drainer]\nenabled = \"maybe\"\n"), None);
        assert!(!hard, "a wrong-typed kill switch must not discard the whole layer");
        assert!(cfg.drainer.enabled, "an unreadable value must leave the shipped default alone");
        assert!(
            warns.iter().any(|w| w.contains("[drainer].enabled")),
            "and it must SAY the edit did nothing: {warns:?}"
        );
        // An unknown key under [drainer] is reported, not silently swallowed or fatal.
        let (_cfg, warns, hard) =
            build_effective(SparkleConfig::default(), Some("[drainer]\nenabeld = false\n"), None);
        assert!(!hard, "one misspelled key must not discard the whole layer");
        assert!(warns.iter().any(|w| w.contains("[drainer].enabeld")), "{warns:?}");

        // Engine-owned knobs the SHELL watchdog reads from this same file (feedback_floor, max_workers,
        // claim_max_age, inprogress_max_age, lock_ttl) are valid settings — the app must NOT report
        // them as inert, or a user who set a rest floor would delete it and get a MORE aggressive fleet.
        for key in ["feedback_floor", "max_workers", "claim_max_age", "inprogress_max_age", "lock_ttl"] {
            let toml = format!("[drainer]\n{key} = 20\n");
            let (_cfg, warns, hard) = build_effective(SparkleConfig::default(), Some(&toml), None);
            assert!(!hard, "{key} must not be a hard error");
            assert!(
                !warns.iter().any(|w| w.contains(&format!("[drainer].{key}"))),
                "{key} is a real engine setting and must not be reported as having no effect: {warns:?}"
            );
        }
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
    fn onepassword_account_id_defaults_unset_and_a_global_file_sets_it() {
        // Unset means "let `op` decide", which is right for a single signed-in account. It only
        // becomes load-bearing on a multi-account machine, where `op` refuses every call without it.
        let (cfg, _, _) = effective(None, None);
        assert_eq!(cfg.onepassword.account_id, None);

        let g = "[onepassword]\naccount_id = \"NZ36HQYBEVBWZMSWZLH77XMFJA\"\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert_eq!(cfg.onepassword.account_id.as_deref(), Some("NZ36HQYBEVBWZMSWZLH77XMFJA"));
    }

    #[test]
    fn blank_account_id_reads_as_unset_not_as_a_chosen_account() {
        // Stored verbatim, a blank id would go out as `--account ""` on EVERY `op` invocation —
        // failing everything, rather than degrading to "no account chosen yet".
        let g = "[onepassword]\naccount_id = \"  \"\n";
        let (cfg, _, hard) = effective(Some(g), None);
        assert!(!hard);
        assert_eq!(cfg.onepassword.account_id, None);
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
        let p = "[onepassword]\nvault_id = \"attacker-vault\"\naccount_id = \"attacker-account\"\n\
                 seed_worktrees = true\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert_eq!(cfg.onepassword.vault_id, None);
        // The account is the same kind of boundary: a repo that could redirect which 1Password
        // account `op` acts as could point another project's secrets at an account it controls.
        assert_eq!(cfg.onepassword.account_id, None);
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
    fn humanebench_is_on_when_the_key_is_absent() {
        // THE "on by default" CLAIM, asserted where it is most likely to regress: no config file
        // at all, and a [tools] block that talks about some OTHER tool. Both must still review.
        let (cfg, _, hard) = effective(None, None);
        assert!(!hard);
        assert!(cfg.tools.humanebench, "no config at all must still ship the reviewer on");

        let g = "[tools]\nbeads = false\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(
            cfg.tools.humanebench,
            "a [tools] block that never mentions humanebench must leave it ON — an absent key is \
             not an opt-out"
        );

        // …and the shipped template, which is what `reset_config` actually writes, agrees.
        let (cfg, _, hard) = effective(Some(DEFAULT_TEMPLATE), None);
        assert!(!hard);
        assert!(cfg.tools.humanebench, "DEFAULT_TEMPLATE disagrees with SparkleConfig::default()");
    }

    #[test]
    fn the_templates_humanebench_line_is_a_live_key_not_a_lookalike() {
        // The template is what a user actually edits, so a key misspelled THERE silently does
        // nothing — and the default-true round-trip above cannot see it, because a dead key and a
        // live one both leave the tool on. Flipping the shipped line is the only assertion that
        // separates them. (Same reasoning as `the_generated_template_documents_the_denylist_and_
        // parses`, which proves its commented example works verbatim once uncommented.)
        let flipped = DEFAULT_TEMPLATE.replace("humanebench = true", "humanebench = false");
        assert_ne!(
            flipped, DEFAULT_TEMPLATE,
            "DEFAULT_TEMPLATE carries no `humanebench = true` line for a user to edit"
        );
        let (cfg, warns, hard) = effective(Some(&flipped), None);
        assert!(!hard, "the edited template must still parse: {warns:?}");
        assert!(
            !cfg.tools.humanebench,
            "editing the template's humanebench line changed nothing — the key is spelled wrong \
             there, and the line is decoration rather than configuration"
        );
    }

    #[test]
    fn global_can_disable_humanebench() {
        // On by default; the MACHINE's owner can turn the gate off. Modelled on
        // `global_can_disable_guardrails` — the same shape, because it is the same kind of tool.
        let g = "[tools]\nhumanebench = false\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(!cfg.tools.humanebench);
        assert!(cfg.tools.guardrails, "untouched tool keeps its default");
    }

    #[test]
    fn a_project_cannot_disable_humanebench() {
        // THE SCOPE PROPERTY THAT MAKES THIS A SAFETY GATE RATHER THAN A PREFERENCE. [tools] is
        // machine-wide, so a cloned repo cannot switch off its own humaneness review just by being
        // cloned. Asserted in BOTH the states a project layer can find the machine in:
        //   • no global opinion at all — the default stands;
        let p = "[tools]\nhumanebench = false\n";
        let (cfg, warns, hard) = effective(None, Some(p));
        assert!(!hard);
        assert!(cfg.tools.humanebench, "a project file must not be able to turn the reviewer off");
        assert!(
            warns.iter().any(|w| w.contains("[tools]") && w.contains("machine-wide")),
            "the ignored project value must be REPORTED, or it reads as having taken effect: {warns:?}"
        );

        //   • and a global that deliberately turned it ON — the project still loses.
        let g = "[tools]\nhumanebench = true\n";
        let (cfg, _, hard) = effective(Some(g), Some(p));
        assert!(!hard);
        assert!(cfg.tools.humanebench, "the global layer stands over the project layer");
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
    fn project_fleet_is_ignored_with_warning() {
        // Same rule as [workers]: the fleet's CI budget protects ONE shared runner pool, so a cloned
        // repo must not be able to raise (or disable) the cap for every other project's agents.
        let (cfg, warns, _) =
            effective(None, Some("[fleet]\nci_budget = 99\nci_lease_secs = 1\n"));
        assert_eq!(
            cfg.fleet,
            FleetConfig { ci_budget: 6, ci_lease_secs: 900 },
            "a project layer must not move the machine-wide fleet budget"
        );
        assert!(
            warns.iter().any(|w| w.contains("[fleet]") && w.contains("ignored")),
            "the ignoring must be visible, not silent: {warns:?}"
        );
    }

    #[test]
    fn global_fleet_applies_budget_and_lease() {
        // The GLOBAL layer is where [fleet] is honored — deleting `apply_fleet(&mut cfg.fleet, …)`
        // would leave the knob permanently at its default with no test failing without this.
        let (cfg, _, _) = effective(Some("[fleet]\nci_budget = 3\nci_lease_secs = 120\n"), None);
        assert_eq!(cfg.fleet, FleetConfig { ci_budget: 3, ci_lease_secs: 120 });
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
    fn agent_test_worker_cap_shrinks_as_the_agent_ceiling_rises() {
        // The measured incident machine: 18 cores, 81-agent ceiling. Every agent that verifies
        // gets ONE worker, so even all 81 verifying at once is ~81 workers, not 81 × 6 = 486.
        assert_eq!(agent_test_worker_cap(18, 81), 1);
        // A user-pinned ceiling of 4 on the same box: each of the 4 keeps cores/4 = 4 workers
        // (4 × 4 = 16 ≤ 18), so a lightly loaded machine is not needlessly throttled.
        assert_eq!(agent_test_worker_cap(18, 4), 4);
        // Ceiling equal to cores → exactly one worker each, the point where the sum meets the budget.
        assert_eq!(agent_test_worker_cap(18, 18), 1);
        // Ceiling below cores → the division exceeds one and each agent gets a real pool.
        assert_eq!(agent_test_worker_cap(36, 6), 6);
    }

    #[test]
    fn agent_test_worker_cap_floors_at_one_and_tolerates_zero_inputs() {
        // A run needs at least one worker; a ceiling far above the core count must not yield zero.
        assert_eq!(agent_test_worker_cap(2, 100), 1);
        // Zero cores (unmeasurable, defensively) and zero ceiling both floor to 1 rather than
        // panicking on a divide-by-zero.
        assert_eq!(agent_test_worker_cap(0, 5), 1);
        assert_eq!(agent_test_worker_cap(18, 0), 18);
    }

    #[test]
    fn agent_test_worker_cap_only_injects_when_it_lowers_the_default() {
        // Below the pool's own default → inject the narrowed number.
        assert_eq!(agent_test_worker_cap_to_inject(18, 81), Some(1));
        assert_eq!(agent_test_worker_cap_to_inject(18, 4), Some(4));
        // At or above the default → inject NOTHING, so the pool keeps its own value and a run is
        // never RAISED above what an uncoordinated local run would already pick.
        assert_eq!(agent_test_worker_cap_to_inject(36, 6), None); // == default
        assert_eq!(agent_test_worker_cap_to_inject(64, 4), None); // 16 > default
    }

    #[test]
    fn agent_test_worker_cap_survives_the_default() {
        // Pins the Rust ceiling to the JS pool default (vitest.pool.mjs DEFAULT_MAX_WORKERS). If
        // this fails the two have drifted and an agent PTY could raise a run above the local default.
        assert_eq!(AGENT_TEST_WORKER_DEFAULT, 6);
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

    // The v2 migration (rewriting a stamped `stop_word = "Sparkle, stop"` to the then-current
    // display phrase) and its six tests are GONE with the wake word itself: `stop_word` is not a
    // key anything reads any more, so there is no value left to migrate. The upgrade path those
    // tests guarded is now covered from the other side, by
    // `a_config_carrying_the_retired_wake_word_keys_still_loads` below — the retired lines must be
    // INERT rather than migrated.

    // roborev 55804 (High): EVERY VERSION BUMP RE-ARMED EVERY EARLIER MIGRATION. The gate
    // `if applied >= CONFIG_MIGRATION_VERSION` guards the whole function body, so raising the
    // constant put every install sitting at an earlier `config_version` — precisely the population
    // an upgrade touches — back through the v1 block. A user migrated by v1 who then DELIBERATELY
    // re-pinned `max_concurrent = 20` (a real choice; 20 was the old default and the ⋯ Advanced
    // editor can produce it) had that line silently deleted again, breaking the guarantee v1's own
    // doc comment makes: "a 20 the user sets later survives, because by then the recorded revision
    // has moved past this migration."
    //
    // Nothing existing could catch it: every other migration test starts from a config with no
    // `[meta]` (or from `reset`, which stamps the current max), so the already-applied path was
    // never exercised. This test therefore fixtures an install stamped PAST v1 but short of v3,
    // and asserts the pending migration runs while the applied one stays put.
    #[test]
    fn a_version_bump_does_not_re_arm_an_already_applied_migration() {
        // The exact shape of an upgrading install: v1 already ran, the user then chose 20 back,
        // and the retired [pushers].model line is still on disk waiting for v3.
        let dir = app_data_with(
            "[workers]\nmax_concurrent = 20\n\
             \n[pushers]\nmodel = \"claude-haiku-4-5\"\nenabled = true\n\
             \n[meta]\nconfig_version = 1\n",
        );
        migrate_global(dir.path()).unwrap();
        let text = global_text(&dir);
        let (cfg, _, _) = effective(Some(&text), None);

        // The still-pending migration must run…
        assert!(!text.contains("model ="), "the pending v3 migration still applies: {text}");
        assert!(text.contains("enabled = true"), "and only takes its own key: {text}");
        // …and v1 must NOT run again. This is the assertion that fails without per-migration
        // gating: the user's deliberate 20 is silently reverted to auto.
        assert_eq!(
            cfg.workers.max_concurrent,
            Some(20),
            "an ALREADY-APPLIED migration must not re-run and eat a later choice: {text}"
        );
        assert!(text.contains("max_concurrent = 20"), "the line itself survives: {text}");
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

    // roborev 53240 (High): a shared loader used to fall back to DEFAULT_TEMPLATE on a parse error,
    // and using it here would have stamped the template over a config the user merely typo'd and
    // written it — wiping every setting AND the broken text they need in order to fix it, silently.
    // That loader is gone; this pins the migration against reintroducing the behaviour.
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
            // …and the run-queue bound is the third of that family, added deliberately HERE at the
            // same time as the variant rather than left for the next roborev to catch. This table is
            // hand-written and NOT compiler-checked (`bound_wire_string` below is the exhaustive
            // one), so it is the half that silently rots — which is exactly what happened to the two
            // lines above.
            (Bound::Load, "\"load\""),
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
            Bound::Load => "\"load\"",
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
        const ALL_BOUNDS: [Bound; 8] = [
            Bound::Cpu,
            Bound::Ram,
            Bound::Both,
            Bound::Pinned,
            Bound::Available,
            Bound::Pressure,
            Bound::Load,
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

    /// `[review]` LAYERING, and the normalisation rule the shell twin mirrors.
    ///
    /// Without this the only path a user actually takes — writing `pr_reviewer = "none"` into a
    /// repo's `.sparkle/config.toml` — is untested by construction: `default_template_parses_to_
    /// defaults` ships the DEFAULT value, so it passes unchanged even with BOTH `apply_review`
    /// calls deleted, and the knightwatch wiring assertion only pins that `enforce` *calls*
    /// `has_no_pr_reviewer()`, never that the config carries the value. Drop the project-arm call
    /// and a repo that sets `none` keeps the permanent unmergeable refusal this exists to remove,
    /// while the app reports the write as ok — the defaulted-seam vacuity shape AGENTS.md names.
    #[test]
    fn review_defaults_and_overrides() {
        let (cfg, _, _) = effective(None, None);
        assert_eq!(cfg.review.pr_reviewer, "knightwatch", "absent [review] keeps today's behaviour");
        assert!(!cfg.review.has_no_pr_reviewer());

        // GLOBAL layer.
        let g = "[review]\npr_reviewer = \"none\"\n";
        let (cfg, _, _) = effective(Some(g), None);
        assert!(cfg.review.has_no_pr_reviewer(), "a global [review] must reach cfg.review");

        // PROJECT layer — per-project overridable (like [freshness]), so NO "ignored" warning.
        let p = "[review]\npr_reviewer = \"none\"\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert!(cfg.review.has_no_pr_reviewer(), "a project [review] must reach cfg.review");
        assert!(warns.is_empty(), "[review] is project-honored; it must not warn: {warns:?}");

        // Project beats global, per-key like every other repo-scoped section.
        let (cfg, _, _) = effective(Some("[review]\npr_reviewer = \"none\"\n"), Some(
            "[review]\npr_reviewer = \"knightwatch\"\n",
        ));
        assert!(!cfg.review.has_no_pr_reviewer(), "the project file wins");

        // THE NORMALISATION TABLE. scripts/probe-gate.sh trims the ends and compares
        // case-insensitively; these rows are the contract both sides implement. `nonesuch` is the
        // fail-closed row — leniency stops at whitespace and case, so a typo leaves the gate ON.
        for (value, expect_off) in [
            ("none", true),
            ("None", true),
            ("NONE", true),
            (" none ", true),
            ("knightwatch", false),
            ("nonesuch", false),
            ("", false),
        ] {
            let cfg = ReviewConfig { pr_reviewer: value.to_string(), require_review: false };
            assert_eq!(
                cfg.has_no_pr_reviewer(),
                expect_off,
                "pr_reviewer = {value:?} must {} the coverage gate",
                if expect_off { "retire" } else { "keep" }
            );
        }
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

    /// A cloned repo must not be able to switch the preview back ON for a user who turned it off.
    ///
    /// `enabled` gates spawning a LONG-LIVED PROCESS whose command line comes from repo-controlled
    /// data (the project's own `[preview] command/args/path`, else its `package.json` `dev`
    /// script), so it belongs in the same class as `[concierge]` and `[pushers]` — which this file
    /// refuses at project scope precisely so a repo cannot hand itself authority over the user's
    /// machine merely by being cloned.
    ///
    /// Asserts BOTH directions. Only checking that a project `true` is ignored would also pass if
    /// the project layer had been refused outright, which would break the legitimate
    /// "this repo is not worth previewing" case.
    #[test]
    fn a_project_may_turn_the_preview_off_but_never_back_on() {
        // The attack: user disabled it globally; a cloned repo ships `enabled = true`.
        let (cfg, warns, _) = effective(
            Some("[preview]\nenabled = false\n"),
            Some("[preview]\nenabled = true\n"),
        );
        assert!(
            !cfg.preview.enabled,
            "a project file re-enabled a globally-disabled preview — a cloned repo can now spawn \
             a process on this machine"
        );
        // AND IT SAYS SO. Dropping the key in silence leaves a hand-edited project file — the one
        // path that still reaches this code — with no feedback that it is inert.
        assert!(
            warns.iter().any(|w| w.contains("[preview].enabled")),
            "the ignored project value must be warned about by name; warnings were {warns:?}"
        );

        // The legitimate narrowing still works: default-on globally, this repo opts out — and it
        // must NOT warn, or the warning becomes noise on the supported path.
        let (cfg, warns, _) = effective(None, Some("[preview]\nenabled = false\n"));
        assert!(!cfg.preview.enabled, "a project must still be able to opt OUT");
        assert!(
            !warns.iter().any(|w| w.contains("[preview].enabled")),
            "opting out is legitimate and must be silent; warnings were {warns:?}"
        );

        // AND THE COMMON CASE MUST BE SILENT. `enabled` defaults to TRUE, so a project file that
        // writes `enabled = true` while the global layer is at its default is AGREEING with the
        // effective value, not being refused. Warning here would fire on nearly every project that
        // touches the section and tell the user to "set it in the global config.toml" about a
        // preview that is already on — a permanent, incorrect instruction. This assertion is the
        // whole reason the warning is guarded on `!into.enabled` rather than on the layer alone.
        let (cfg, warns, _) = effective(None, Some("[preview]\nenabled = true\n"));
        assert!(cfg.preview.enabled, "the effective value is on, as it already was");
        assert!(
            !warns.iter().any(|w| w.contains("[preview].enabled")),
            "a project agreeing with the default must be SILENT; warnings were {warns:?}"
        );

        // And the two knobs that ARE project properties are untouched by the asymmetry.
        let (cfg, _, _) = effective(
            Some("[preview]\nidle_grace_min = 30\n"),
            Some("[preview]\nidle_grace_min = 2\n"),
        );
        assert_eq!(cfg.preview.idle_grace_min, 2);
    }

    /// `agent_eagerness` decides whether a preview is ever OPENED. (It had a sibling, `auto_open`,
    /// which decided whether an existing one revealed itself in a pane; that pane and that key were
    /// removed on 2026-08-19 — a card surfaces itself, so there is nothing left to decide.)
    #[test]
    fn agent_eagerness_defaults_to_visual_and_is_project_overridable() {
        let (cfg, _, _) = effective(None, None);
        assert_eq!(
            cfg.preview.agent_eagerness, "visual",
            "the shipped default asks for a preview when the work is visual"
        );

        // A project may set its own eagerness — whether THIS repo's work is worth looking at is a
        // property of the repo. Unlike `enabled`, it confers no authority over the machine.
        let (cfg, warns, _) = effective(
            Some("[preview]\nagent_eagerness = \"never\"\n"),
            Some("[preview]\nagent_eagerness = \"always\"\n"),
        );
        assert_eq!(cfg.preview.agent_eagerness, "always");
        assert!(warns.is_empty(), "a legal project override must be silent; got {warns:?}");

    }

    /// An unmatched string reads downstream as "no instruction", which is exactly `"never"` — the
    /// one value a typo must not be able to reach, because its symptom is a feature that quietly
    /// stops happening. Asserts the SIDE EFFECT (the struct value was replaced), not the warning.
    #[test]
    fn an_unknown_agent_eagerness_falls_back_to_visual() {
        let g = "[preview]\nagent_eagerness = \"eagerly\"\n";
        let (cfg, warns, _) = effective(Some(g), None);
        assert_eq!(
            cfg.preview.agent_eagerness, "visual",
            "an unrecognized mode must be REPLACED with the default, not left in place"
        );
        assert!(
            warns.iter().any(|w| w.contains("[preview].agent_eagerness")),
            "the fallback must say so by name; warnings were {warns:?}"
        );
    }

    /// DEFAULT_TEMPLATE is not documentation — `load_document_for_write` writes it to disk on first
    /// run, so a template whose values disagree with `SparkleConfig::default()` ships a fresh
    /// install a different behaviour from an upgraded one, silently. Same guard
    /// `ui_template_matches_the_default` puts on `[ui]`.
    #[test]
    fn preview_template_matches_the_default() {
        let (cfg, warns, hard) = effective(Some(DEFAULT_TEMPLATE), None);
        assert!(!hard, "DEFAULT_TEMPLATE must parse");
        assert!(warns.is_empty(), "DEFAULT_TEMPLATE warnings: {warns:?}");
        let d = SparkleConfig::default();
        assert_eq!(cfg.preview.enabled, d.preview.enabled);
        assert_eq!(cfg.preview.idle_grace_min, d.preview.idle_grace_min);
        assert_eq!(
            cfg.preview.agent_eagerness, d.preview.agent_eagerness,
            "the template's agent_eagerness must be the built-in default, or a fresh install \
             briefs its agents differently from an upgraded one"
        );
    }

    /// The grace period is one of only three things that ever stops a preview server (there is no
    /// max_servers by design, and `agent_memory_watchdog` is unwired), so an unbounded value is a
    /// 400 MB – 1 GB dev server that never exits — configured by a typo rather than a decision.
    ///
    /// Asserts the SIDE EFFECT — the value in the struct changed — not merely that a warning was
    /// pushed. A warning nobody acts on would leave the server running just the same.
    #[test]
    fn an_absurd_idle_grace_is_capped_rather_than_honored() {
        let g = "[preview]\nidle_grace_min = 100000\n";
        let (cfg, warns, _) = effective(Some(g), None);
        assert_eq!(
            cfg.preview.idle_grace_min, PREVIEW_IDLE_GRACE_MAX_MIN,
            "an out-of-range idle_grace_min must be REPLACED with the ceiling"
        );
        assert!(
            warns.iter().any(|w| w.contains("[preview].idle_grace_min")),
            "the cap must say so by name; warnings were {warns:?}"
        );

        // The boundary is honored, not capped — a cap that also clamps legal values would quietly
        // shorten every configured grace.
        let g = format!("[preview]\nidle_grace_min = {PREVIEW_IDLE_GRACE_MAX_MIN}\n");
        let (cfg, warns, _) = effective(Some(&g), None);
        assert_eq!(cfg.preview.idle_grace_min, PREVIEW_IDLE_GRACE_MAX_MIN);
        assert!(!warns.iter().any(|w| w.contains("idle_grace_min")));

        // 0 is a legitimate "stop as soon as the pane is covered", not an error.
        let (cfg, warns, _) = effective(Some("[preview]\nidle_grace_min = 0\n"), None);
        assert_eq!(cfg.preview.idle_grace_min, 0);
        assert!(!warns.iter().any(|w| w.contains("idle_grace_min")));
    }

    #[test]
    fn preview_defaults_and_overrides() {
        // Absent [preview] → the built-in defaults.
        let (cfg, _, _) = effective(None, None);
        assert!(cfg.preview.enabled);
        assert_eq!(cfg.preview.idle_grace_min, 10);

        // Global override, field by field.
        let g = "[preview]\nenabled = false\nidle_grace_min = 30\n";
        let (cfg, warns, _) = effective(Some(g), None);
        assert!(!cfg.preview.enabled);
        assert_eq!(cfg.preview.idle_grace_min, 30);
        assert!(warns.is_empty());

        // Per-project overridable (like [freshness]/[worktree_pool]); no "ignored" warning.
        let p = "[preview]\nidle_grace_min = 2\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert_eq!(cfg.preview.idle_grace_min, 2);
        assert!(cfg.preview.enabled, "untouched field keeps its default");
        assert!(warns.is_empty());

        // `auto_open` IS GONE, and a config file that still carries it must stay INERT rather than
        // failing the layer. It is not declared in PartialPreview any more, and serde ignores an
        // unknown key — so an upgrading user whose file still names it loads cleanly and keeps
        // every sibling key in the same section. This is the whole migration story for that
        // removal, which is why it is asserted rather than assumed.
        let g = "[preview]\nauto_open = \"always\"\nidle_grace_min = 9\n";
        let (cfg, warns, hard_error) = effective(Some(g), None);
        assert!(!hard_error, "a leftover auto_open must not fail the layer");
        assert_eq!(cfg.preview.idle_grace_min, 9, "its siblings still apply");
        assert!(warns.is_empty(), "an ignored unknown key is silent; got {warns:?}");

        // A project file may carry the detection-override keys (command/args/path). They are not
        // declared in PartialPreview, so this asserts they are INERT — the file still loads and the
        // sibling keys in the same section still apply — rather than failing the whole layer.
        let p = "[preview]\nidle_grace_min = 7\ncommand = \"pnpm\"\nargs = [\"run\", \"dev:web\"]\npath = \"apps/web\"\n";
        let (cfg, warns, hard_error) = effective(None, Some(p));
        assert!(!hard_error, "unknown [preview] keys must not fail the layer");
        assert_eq!(cfg.preview.idle_grace_min, 7, "the sibling key must still apply");
        assert!(warns.is_empty());
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
    fn ui_bead_card_expansion_defaults_and_overrides() {
        // ABSENT [ui] → the founder's chosen default: cards render OPEN, with no cap on how many
        // one reply may expand. Both halves asserted, because "expanded" and "uncapped" are two
        // separate decisions and a merge that silently reset either one is the bug this catches.
        let (cfg, _, _) = effective(None, None);
        assert!(cfg.ui.bead_cards_expanded);
        assert_eq!(cfg.ui.bead_cards_expanded_max, 0);

        // THE REVERT PATH, and the reason this section exists at all: one key restores the
        // pre-2026-08 click-to-expand behaviour without touching code.
        let g = "[ui]\nbead_cards_expanded = false\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert!(!cfg.ui.bead_cards_expanded);
        // …and it leaves the SIBLING key alone. `apply_ui` merges per-key; a whole-struct
        // overwrite would silently reset the cap here and nothing else would notice.
        assert_eq!(cfg.ui.bead_cards_expanded_max, 0);

        // The cap on its own, likewise leaving `bead_cards_expanded` at its default. This is the
        // dial the founder reaches for if eight expanded cards start swamping his own text.
        let g = "[ui]\nbead_cards_expanded_max = 3\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert_eq!(cfg.ui.bead_cards_expanded_max, 3);
        assert!(cfg.ui.bead_cards_expanded);
    }

    #[test]
    fn project_ui_is_ignored_with_warning() {
        // How a bead card renders belongs to the person reading the concierge column, not to a
        // repo — the column is cross-project by construction, so a per-project value could not
        // even be resolved coherently when one reply names beads from three different projects.
        let p = "[ui]\nbead_cards_expanded = false\nbead_cards_expanded_max = 1\n";
        let (cfg, warns, _) = effective(None, Some(p));
        assert!(cfg.ui.bead_cards_expanded);
        assert_eq!(cfg.ui.bead_cards_expanded_max, 0);
        assert!(warns.iter().any(|w| w.contains("[ui]")));
    }

    #[test]
    fn ui_template_matches_the_default() {
        // DEFAULT_TEMPLATE is not documentation — `load_document_for_write` writes it to disk on
        // first run, so a template whose values disagree with `SparkleConfig::default()` ships a
        // fresh install a different behaviour from an upgraded one, silently.
        let (cfg, warns, hard) = effective(Some(DEFAULT_TEMPLATE), None);
        assert!(!hard, "DEFAULT_TEMPLATE must parse");
        assert!(warns.is_empty(), "DEFAULT_TEMPLATE warnings: {warns:?}");
        let d = SparkleConfig::default();
        assert_eq!(cfg.ui.bead_cards_expanded, d.ui.bead_cards_expanded);
        assert_eq!(cfg.ui.bead_cards_expanded_max, d.ui.bead_cards_expanded_max);
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
        // Absent [voice] section → automatic device selection, hardware inputs only.
        let (cfg, _, _) = effective(None, None);
        assert_eq!(cfg.voice.input_device_uid, None);
        assert!(!cfg.voice.allow_virtual_input);

        // Global layer overrides each field independently.
        let g = r#"
            [voice]
            input_device_uid = "AppleUSBAudioEngine:Blue:Yeti:1"
            allow_virtual_input = true
        "#;
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty());
        assert_eq!(cfg.voice.input_device_uid.as_deref(), Some("AppleUSBAudioEngine:Blue:Yeti:1"));
        assert!(cfg.voice.allow_virtual_input);

        // A partial override leaves the untouched field at its default.
        let g2 = "[voice]\nallow_virtual_input = true\n";
        let (cfg, _, _) = effective(Some(g2), None);
        assert_eq!(cfg.voice.input_device_uid, None);
        assert!(cfg.voice.allow_virtual_input);

        // An empty string means "automatic", not "bind a device whose UID is empty".
        let g3 = "[voice]\ninput_device_uid = \"  \"\n";
        let (cfg, _, _) = effective(Some(g3), None);
        assert_eq!(cfg.voice.input_device_uid, None);
    }

    // THE UPGRADE PATH for retiring the wake word (requirement 5). Every install that ever opened
    // the ⋯ Advanced editor or toggled an AI feature has the whole DEFAULT_TEMPLATE stamped to
    // disk, so `wake_word` / `stop_word` / `pause_on_submit` are sitting in real users' config
    // files right now. Those keys no longer exist in `PartialVoice`.
    //
    // The failure this guards is not hypothetical: `#[serde(deny_unknown_fields)]` on `PartialVoice`
    // (or on any struct enclosing it) would turn each of those lines into a WHOLE-LAYER parse
    // error, which `build_effective` reports as a hard error and answers by discarding the entire
    // global layer — so a user upgrading would silently lose their microphone choice and every
    // other global setting, because of three lines the app itself wrote for them. Serde's default
    // is to ignore unknown fields; this test is what keeps that default from being "tightened"
    // later by someone who does not know it is load-bearing.
    #[test]
    fn a_config_carrying_the_retired_wake_word_keys_still_loads() {
        let g = r#"
            [voice]
            wake_word = "Hey Sparkle"
            stop_word = "Sparkle, pause"
            pause_on_submit = true
            input_device_uid = "ABC123"

            [workflow]
            require_pr = false
        "#;
        let (cfg, warns, hard) = effective(Some(g), None);

        // 1. The load SUCCEEDS. A hard error here means the layer was thrown away wholesale.
        assert!(!hard, "retired [voice] keys must not fail the load");

        // 2. And it succeeds SILENTLY. This pins the second half of the "no cleanup migration is
        //    needed" rationale, which is otherwise only a comment: `[pushers]` and
        //    `[concierge.checks]` both have unknown-key catch-alls that warn "… has no effect",
        //    and the v3 migration exists precisely because one of them fired forever on a line the
        //    app itself wrote. `[voice]` has no such catch-all. If someone adds one, these three
        //    keys — sitting in every upgraded install's config.toml — would emit a permanent
        //    warning per load with no migration left to remove them, so that change must break
        //    here and be made to clean the lines up instead.
        assert!(
            warns.is_empty(),
            "a retired [voice] key must be inert, not a permanent per-load warning: {warns:?}"
        );

        // 3. The retired keys do not poison their surviving sibling in the SAME table — this is the
        //    assertion that actually fails under `deny_unknown_fields`, since the whole `[voice]`
        //    table (and with it `input_device_uid`) would never be applied.
        assert_eq!(
            cfg.voice.input_device_uid.as_deref(),
            Some("ABC123"),
            "the surviving sibling key is still read"
        );

        // 4. Nor do they poison an unrelated table, or the untouched defaults.
        assert!(!cfg.workflow.require_pr, "an unrelated table still applies");
        assert!(!cfg.voice.allow_virtual_input, "an unset [voice] key keeps its default");
        assert!(cfg.ai.voice_dictation, "a default outside [voice] is intact");
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
    fn approvals_concierge_answers_defaults_on() {
        // The default is ON because the problem it addresses is prompts landing on the human that
        // something else should have answered — so "the concierge is asked" is the safe state, not
        // the adventurous one. Asserts the VALUE, not merely that the config parsed.
        let (cfg, _, _) = effective(None, None);
        assert!(
            cfg.approvals.concierge_answers,
            "concierge_answers defaults on — an unclassified prompt goes to the concierge, not the human"
        );
        // It is a SEPARATE switch from the local-regex presser: a default read of one must not be
        // the other. (Coupling them is the mistake this key exists to prevent.)
        assert!(cfg.ai.auto_approve, "the master auto-approve switch is its own, unrelated default");
    }

    #[test]
    fn approvals_concierge_answers_can_be_turned_off() {
        // The opt-out: `false` routes every unclassified prompt to the human, as before this key.
        let (cfg, _, _) = effective(Some("[approvals]\nconcierge_answers = false\n"), None);
        assert!(!cfg.approvals.concierge_answers, "an explicit false beats the on-by-default");
        // Turning concierge routing off must not disturb its neighbours in the same table.
        assert_eq!(cfg.approvals.bash.as_deref(), Some("always"), "a sibling category is untouched");
        assert_eq!(cfg.approvals.resume.as_deref(), Some("ask"), "the resume sibling is untouched");
    }

    #[test]
    fn approvals_concierge_answers_project_overrides_global() {
        // Per-key layering, exactly like the categories and `resume`: a project decides for itself
        // in EITHER direction, and an absent project key leaves the global value standing.
        let g = "[approvals]\nconcierge_answers = true\n";
        let p = "[approvals]\nconcierge_answers = false\n";
        let (cfg, _, _) = effective(Some(g), Some(p));
        assert!(!cfg.approvals.concierge_answers, "project false beats global true");

        let (cfg, _, _) = effective(Some(p), Some(g));
        assert!(cfg.approvals.concierge_answers, "project true beats global false");

        // A project file that mentions the table but NOT this key falls through to the global one —
        // the assertion that would fail if the merge replaced the table wholesale.
        let (cfg, _, _) = effective(Some(p), Some("[approvals]\nbash = \"never\"\n"));
        assert!(
            !cfg.approvals.concierge_answers,
            "an unmentioned key keeps the global value rather than reverting to the built-in default"
        );
    }

    #[test]
    fn approvals_plan_defaults_to_auto() {
        // THE DEFAULT THAT ENDS THE STALL. A finished agent sits on Claude Code's "ready to
        // execute — proceed?" dialog until someone presses a key; shipping this OFF would leave the
        // feature inert for everyone who never finds the setting. Asserts the VALUE, not that the
        // config merely parsed.
        let (cfg, _, _) = effective(None, None);
        assert_eq!(
            cfg.approvals.plan.as_deref(),
            Some("auto"),
            "plan defaults to auto — an unanswered plan prompt is a stalled agent, not a safe pause"
        );
        // Its neighbour in the SAME table defaults the OTHER way, deliberately (an unanswered
        // resume prompt costs nothing). If someone ever unifies these, this line goes red.
        assert_eq!(
            cfg.approvals.resume.as_deref(),
            Some("ask"),
            "the resume sibling keeps its opposite default"
        );
    }

    #[test]
    fn approvals_plan_can_be_turned_off() {
        // The founder-visible opt-out named in the field doc: one key restores the prompt.
        let (cfg, _, _) = effective(Some("[approvals]\nplan = \"ask\"\n"), None);
        assert_eq!(cfg.approvals.plan.as_deref(), Some("ask"), "an explicit ask beats the default");
        // Turning it off must not disturb its neighbours in the same table.
        assert_eq!(cfg.approvals.bash.as_deref(), Some("always"), "a sibling category is untouched");
        assert!(cfg.approvals.concierge_answers, "the concierge sibling is untouched");
    }

    #[test]
    fn approvals_plan_project_overrides_global() {
        // Per-key layering, exactly like the categories, `resume` and `concierge_answers`.
        let g = "[approvals]\nplan = \"ask\"\n";
        let p = "[approvals]\nplan = \"manual\"\n";
        let (cfg, _, _) = effective(Some(g), Some(p));
        assert_eq!(cfg.approvals.plan.as_deref(), Some("manual"), "project beats global");

        // A project file that mentions the table but NOT this key leaves the global value standing
        // — the assertion that fails if the merge ever replaced the table wholesale.
        let (cfg, _, _) = effective(Some(g), Some("[approvals]\nbash = \"never\"\n"));
        assert_eq!(
            cfg.approvals.plan.as_deref(),
            Some("ask"),
            "an unmentioned key keeps the global value rather than reverting to the built-in default"
        );
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

    // ── [publish] — bead `sparkle-131ms.3` ───────────────────────────────────────────────────

    const DEST: &str = "[publish]\nactive = \"drodio\"\n\n\
                        [publish.destinations.drodio]\nname = \"drodio.com\"\n\
                        url = \"https://drodio.com/api/mcp\"\n";

    /// The positive case, and the PAIR to the global-only test below. Without it, that test is
    /// ambiguous: a `[publish]` section that never worked in ANY layer would also pass it.
    #[test]
    fn publish_in_the_global_file_configures_a_destination() {
        let (cfg, warns, hard) = effective(Some(DEST), None);
        assert!(!hard, "a valid [publish] block is not an error: {warns:?}");
        assert_eq!(cfg.publish.active.as_deref(), Some("drodio"));
        let d = cfg
            .publish
            .destinations
            .get("drodio")
            .expect("the destination is configured");
        assert_eq!(d.name, "drodio.com");
        // Sent exactly as configured — the endpoint answers both the bare and trailing-slash forms
        // with no redirect, so normalizing would only make the file disagree with what is used.
        assert_eq!(d.url, "https://drodio.com/api/mcp");
    }

    /// The security boundary. A repo must not be able to point the user's publishing — and the
    /// bearer token that goes with it — at a host of its choosing merely by being cloned.
    #[test]
    fn publish_is_ignored_in_a_project_file_with_a_warning() {
        let (cfg, warns, hard) = effective(None, Some(DEST));
        assert!(!hard);
        assert!(
            cfg.publish.destinations.is_empty() && cfg.publish.active.is_none(),
            "a per-project publish destination must not take effect: {:?}",
            cfg.publish
        );
        assert!(
            warns.iter().any(|w| w.contains("[publish]")),
            "the user must be told their project block was ignored: {warns:?}"
        );
    }

    /// …and it must not take effect even when a GLOBAL destination already exists — the shape that
    /// matters, since a repo overriding the real destination's url is the actual attack, not a repo
    /// adding one to an empty config.
    #[test]
    fn a_project_file_cannot_override_a_globally_configured_destination() {
        let evil = "[publish.destinations.drodio]\nurl = \"https://evil.example.com/api/mcp\"\n";
        let (cfg, _warns, _) = effective(Some(DEST), Some(evil));
        assert_eq!(
            cfg.publish.destinations["drodio"].url, "https://drodio.com/api/mcp",
            "a project file must not repoint a configured destination"
        );
    }

    /// The credential never rides in the config. Asserted on the SERIALIZED form, because that is
    /// the artifact that ends up in a backup, a screen share, or a pasted bug report.
    #[test]
    fn a_token_is_never_serialized_into_the_config() {
        let with_token = "[publish.destinations.drodio]\n\
                          url = \"https://drodio.com/api/mcp\"\n\
                          token = \"sk-super-secret-value\"\n";
        let (cfg, _warns, _) = effective(Some(with_token), None);
        let json = serde_json::to_string(&cfg).expect("config serializes");
        assert!(
            !json.contains("sk-super-secret-value"),
            "an unknown `token` key must not survive into the effective config"
        );
        // And the struct offers no field that could hold one: the only credential-shaped value is
        // a boolean presence flag, answered live by the keychain.
        assert!(!cfg.publish.destinations["drodio"].has_credential_in_keychain);
    }

    /// A non-https destination is refused by the config layer, not merely at call time — so the
    /// user learns at edit time. The row is DROPPED, and the warning names the id.
    #[test]
    fn a_non_https_destination_is_rejected_with_a_warning_naming_it() {
        let p = "[publish.destinations.drodio]\nurl = \"http://drodio.com/api/mcp\"\n";
        let (cfg, warns, hard) = effective(Some(p), None);
        assert!(!hard, "a bad row is skipped, never fatal");
        assert!(
            cfg.publish.destinations.is_empty(),
            "an http destination must not be configured: {:?}",
            cfg.publish.destinations
        );
        assert!(
            warns.iter().any(|w| w.contains("drodio") && w.contains("https")),
            "the warning names the destination and the rule: {warns:?}"
        );
    }

    /// A localhost destination over plain http IS allowed — the converse of the rule above, and the
    /// thing that makes developing a destination possible. Without this the cheap wrong
    /// implementation ("reject anything not https") passes every other test here.
    #[test]
    fn a_loopback_destination_over_http_is_allowed() {
        let p = "[publish.destinations.dev]\nurl = \"http://localhost:3000/api/mcp\"\n";
        let (cfg, _warns, _) = effective(Some(p), None);
        assert!(
            cfg.publish.destinations.contains_key("dev"),
            "a loopback dev destination must be configurable over http"
        );
    }

    /// `active` pointing at nothing is the shape that would otherwise fail at publish time with an
    /// opaque "unknown destination", long after the edit that caused it.
    #[test]
    fn an_active_pointer_naming_no_destination_is_cleared_with_a_warning() {
        let p = "[publish]\nactive = \"nope\"\n\n\
                 [publish.destinations.drodio]\nurl = \"https://drodio.com/api/mcp\"\n";
        let (cfg, warns, _) = effective(Some(p), None);
        assert_eq!(cfg.publish.active, None, "publishing stays off");
        assert!(
            warns.iter().any(|w| w.contains("nope")),
            "the warning names the dangling pointer: {warns:?}"
        );
    }

    /// A lone destination with no `active` is what a first-time user writes. Leaving publishing off
    /// for it is the silently-inert-feature shape — everything looks configured and nothing works.
    #[test]
    fn a_single_destination_is_active_without_having_to_say_so() {
        let p = "[publish.destinations.drodio]\nurl = \"https://drodio.com/api/mcp\"\n";
        let (cfg, warns, _) = effective(Some(p), None);
        assert_eq!(
            cfg.publish.active.as_deref(),
            Some("drodio"),
            "one destination and no ambiguity means publishing is on: {warns:?}"
        );
    }

    /// …but with more than one, Sparkle must not guess which one posts under the user's name — and
    /// must SAY that publishing is off, rather than leaving it silently inert.
    #[test]
    fn several_destinations_with_no_active_stays_off_and_says_so() {
        let p = "[publish.destinations.drodio]\nurl = \"https://drodio.com/api/mcp\"\n\n\
                 [publish.destinations.other]\nurl = \"https://example.com/api/mcp\"\n";
        let (cfg, warns, _) = effective(Some(p), None);
        assert_eq!(cfg.publish.active, None, "no guessing between two destinations");
        assert!(
            warns.iter().any(|w| w.contains("active")),
            "the user must be told publishing is off and why: {warns:?}"
        );
    }

    /// An explicit `active` still wins over the single-destination default — otherwise the default
    /// would be indistinguishable from the explicit case and this feature would be untestable.
    #[test]
    fn an_explicit_active_is_honored_over_the_single_destination_default() {
        let p = "[publish]\nactive = \"drodio\"\n\n\
                 [publish.destinations.drodio]\nurl = \"https://drodio.com/api/mcp\"\n\n\
                 [publish.destinations.other]\nurl = \"https://example.com/api/mcp\"\n";
        let (cfg, _warns, _) = effective(Some(p), None);
        assert_eq!(cfg.publish.active.as_deref(), Some("drodio"));
    }

    /// A destination id names a keychain item, so a permissive id rule is what would let a config
    /// file reach across to another item's slot.
    #[test]
    fn a_destination_id_that_could_not_name_a_keychain_item_is_rejected() {
        let p = "[publish.destinations.\"../chief\"]\nurl = \"https://drodio.com/api/mcp\"\n";
        let (cfg, warns, hard) = effective(Some(p), None);
        assert!(!hard);
        assert!(cfg.publish.destinations.is_empty(), "{:?}", cfg.publish.destinations);
        assert!(!warns.is_empty(), "the rejection is explained");
    }

    /// A fresh install can publish nowhere. For an outward-facing action that is the only
    /// defensible default.
    #[test]
    fn publishing_is_off_by_default() {
        let (cfg, _warns, _) = effective(None, None);
        assert!(cfg.publish.active.is_none() && cfg.publish.destinations.is_empty());
    }

    /// The shipped template must EXPLAIN the section without configuring one — an uncommented
    /// example would be a real egress target the user never chose. Same contract as [concierge].
    #[test]
    fn publish_template_documents_the_section_and_stays_commented_out() {
        assert!(DEFAULT_TEMPLATE.contains("[publish.destinations."));
        assert!(
            DEFAULT_TEMPLATE.contains("# [publish]"),
            "must ship commented out"
        );
        let (cfg, warns, hard) =
            build_effective(SparkleConfig::default(), Some(DEFAULT_TEMPLATE), None);
        assert!(!hard, "the shipped template must parse: {warns:?}");
        assert!(
            cfg.publish.destinations.is_empty() && cfg.publish.active.is_none(),
            "the template must not configure a destination: {:?}",
            cfg.publish
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
        // THE ONE SHIPPED `"block"`, and the only check in this table entitled to it: the mount's
        // block path holds a blocked reply and dispatches one correction turn, so `blocked` is read
        // rather than computed and dropped. `ask-without-action` stays `"warn"` above — raising it is
        // a separate judgement on its own false-positive profile, not a consequence of this one.
        ("defect-without-disposition", "block", false, None, None),
        ("fat-pill-label", "off", true, None, None),
        ("hedge-words", "warn", false, None, Some("should, deserves to")),
        ("naked-file-ref", "warn", false, None, None),
        ("relay-paste", "off", false, Some(240), None),
        // THE SECOND SHIPPED `"block"`, on the same entitlement as the one above: the mount holds a
        // blocked reply and spends one correction turn on it. It blocks rather than warns because
        // the founder asked for it to be reject-based after the prompt-level rule failed repeatedly
        // (bead sparkle-j6jra) — a warning would hand him a note saying the reply he is already
        // reading did not quote him, which is not the thing he asked for.
        ("reply-without-quote", "block", false, None, None),
        ("restated-state", "warn", false, Some(200), None),
        ("unbacked-claim", "warn", false, None, None),
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
        assert_eq!(ids, expected, "the shipped checks, no more and no fewer");
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

    // --- [pushers] — the Pusher's operating envelope -----------------------------------------

    #[test]
    fn pushers_ship_enabled_by_default_with_no_config_file() {
        // LITERAL expectations, never read back off PushersConfig::default() — an assertion derived
        // from the table under test passes whatever that table says, including after someone
        // flips the founder's on-by-default to off.
        let (cfg, warns, hard) = effective(None, None);
        assert!(!hard);
        let p = &cfg.pushers;
        assert!(p.enabled, "the founder's decision: Pushers ship ON, over the fail-safe default");
        assert_eq!(p.observe_interval_ms, 300_000, "five minutes, the costed interval");
        assert_eq!(p.messages_per_hour, 4);
        assert_eq!(p.inbox_yield_pct, 80);
        assert!(
            !warns.iter().any(|w| w.contains("[pushers]")),
            "the shipped envelope must load clean: {warns:?}"
        );
    }

    #[test]
    fn pushers_template_matches_the_default() {
        // Same trap avoided the same way as `concierge_checks_template_matches_the_default`:
        // overlaying the template onto SparkleConfig::default() would pass even with the [pushers]
        // block MISSING from the template, because the base already holds the values. So WIPE the
        // section to something no default could be — then this equality can only hold if the
        // template really writes every field.
        let mut base = SparkleConfig::default();
        base.pushers = PushersConfig {
            enabled: false,
            observe_interval_ms: 1,
            messages_per_hour: 999,
            inbox_yield_pct: 3,
        };
        let (cfg, warns, hard) = build_effective(base, Some(DEFAULT_TEMPLATE), None);
        assert!(!hard, "the shipped template must parse: {warns:?}");
        assert_eq!(
            cfg.pushers,
            SparkleConfig::default().pushers,
            "DEFAULT_TEMPLATE's [pushers] disagrees with SparkleConfig::default() — the bug class \
             that already bit [approvals].bash"
        );
        // And it ships LIVE, not commented out: this section is the only place a human can turn a
        // misfiring Pusher down, so there has to be something in the file to edit.
        assert!(DEFAULT_TEMPLATE.contains("\n[pushers]\n"), "the block must ship uncommented");
    }

    /// The `[advisor]` block in DEFAULT_TEMPLATE must reproduce `AdvisorConfig::default()` exactly.
    ///
    /// Same trap avoided the same way as `pushers_template_matches_the_default`: overlaying the
    /// template onto `SparkleConfig::default()` would pass with the block MISSING, because the base
    /// already holds the values. So WIPE the section to something no default could be first.
    #[test]
    fn advisor_template_matches_the_default() {
        let mut base = SparkleConfig::default();
        base.advisor = AdvisorConfig { enabled: false, model: "not-a-model".to_string() };
        let (cfg, warns, hard) = build_effective(base, Some(DEFAULT_TEMPLATE), None);
        assert!(!hard, "the shipped template must parse: {warns:?}");
        assert_eq!(
            cfg.advisor,
            SparkleConfig::default().advisor,
            "DEFAULT_TEMPLATE's [advisor] disagrees with SparkleConfig::default()"
        );
        assert!(DEFAULT_TEMPLATE.contains("\n[advisor]\n"), "the block must ship uncommented");
        // The shipped default must be DISPATCHABLE, or the advisor is inert out of the box: an id
        // absent from research.rs's allowlist is refused at dispatch, and one absent from the
        // frontend catalog never resolves. Both lists are elsewhere, which is exactly why this is
        // asserted here rather than assumed.
        assert!(
            crate::research::RESEARCH_MODEL_ALLOWLIST
                .contains(&SparkleConfig::default().advisor.model.as_str()),
            "the shipped [advisor].model must be one research.rs may dispatch"
        );
        // …and it must not BE the planner's model, which would make the pass self-review.
        assert_ne!(
            SparkleConfig::default().advisor.model,
            crate::ai::CHAT_MODEL,
            "the advisor must never default to the planner's own model"
        );
    }

    /// The kill switch reads unambiguous off-spellings, like `[pushers].enabled` — and a wrong-typed
    /// value leaves the shipped default ALONE rather than flipping it.
    #[test]
    fn advisor_enabled_reads_off_spellings_and_refuses_nonsense() {
        for spelling in ["false", "\"false\"", "\"off\"", "\"no\"", "0"] {
            let toml = format!("[advisor]\nenabled = {spelling}\n");
            let (cfg, _w, hard) = build_effective(SparkleConfig::default(), Some(&toml), None);
            assert!(!hard, "{spelling} must not be a hard error");
            assert!(!cfg.advisor.enabled, "`enabled = {spelling}` must stop the advisor");
        }
        // A value with no defensible off-reading warns and changes nothing — the default is only
        // ever flipped by an intent, never by a typo.
        let (cfg, warns, _h) =
            build_effective(SparkleConfig::default(), Some("[advisor]\nenabled = \"maybe\"\n"), None);
        assert!(cfg.advisor.enabled, "an unreadable value must leave the shipped default alone");
        assert!(
            warns.iter().any(|w| w.contains("[advisor].enabled")),
            "and it must SAY the edit did nothing: {warns:?}"
        );
    }

    /// A configured model is taken VERBATIM, a wrong-typed one warns and is dropped, and an unknown
    /// key is REPORTED rather than silently accepted.
    #[test]
    fn advisor_model_is_kept_verbatim_and_unknown_keys_are_reported() {
        let (cfg, _w, _h) = build_effective(
            SparkleConfig::default(),
            Some("[advisor]\nmodel = \"claude-fable-5\"\n"),
            None,
        );
        assert_eq!(cfg.advisor.model, "claude-fable-5");
        assert_ne!(
            cfg.advisor.model,
            AdvisorConfig::default().model,
            "vacuous unless the configured id differs from the shipped one"
        );

        let (cfg, warns, _h) =
            build_effective(SparkleConfig::default(), Some("[advisor]\nmodel = 3\n"), None);
        assert_eq!(
            cfg.advisor.model,
            AdvisorConfig::default().model,
            "a wrong-typed model must be dropped, not coerced"
        );
        assert!(warns.iter().any(|w| w.contains("[advisor].model")), "{warns:?}");

        let (_cfg, warns, hard) =
            build_effective(SparkleConfig::default(), Some("[advisor]\nmodle = \"x\"\n"), None);
        assert!(!hard, "one misspelled key must not discard the whole layer");
        assert!(
            warns.iter().any(|w| w.contains("[advisor].modle")),
            "a misspelling must be reported, not silently ignored: {warns:?}"
        );
    }

    #[test]
    fn a_pushers_edit_lands_and_leaves_its_siblings_alone() {
        // The one-line edit the section exists for — "this is too noisy" — must not silently reset
        // the interval or the model on its way through. Per-FIELD merge, not section replacement.
        let g = "[pushers]\nmessages_per_hour = 1\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        let p = &cfg.pushers;
        assert_eq!(p.messages_per_hour, 1, "the edit must take effect");
        assert_eq!(p.observe_interval_ms, 300_000, "an unmentioned sibling keeps its shipped value");
        assert_eq!(p.inbox_yield_pct, 80, "and so does this one");
        assert!(p.enabled, "lowering the budget is a different edit from switching Pushers off");
        assert!(warns.is_empty(), "a valid edit warns about nothing: {warns:?}");
    }

    #[test]
    fn migration_v3_removes_the_retired_pushers_model_key() {
        // The app WROTE this line — it shipped inside DEFAULT_TEMPLATE, and the first `set_value`
        // on a fresh install writes the whole template to disk. So removing it discards nothing the
        // user chose, which is the same standard v1 and v2 hold themselves to. Left in place it
        // warns "not a Pusher setting" on every single load, forever.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            "[workflow]\nrequire_pr = false\n\n[pushers]\nmessages_per_hour = 2\nmodel = \"claude-haiku-4-5\"\n",
        )
        .expect("seed");

        migrate_global(dir.path()).expect("migration must not fail");

        let after = std::fs::read_to_string(&path).expect("read back");
        assert!(!after.contains("model"), "the retired key must be gone: {after}");
        // ONLY that key. A migration that also ate a real setting would be far worse than the
        // warning it exists to silence.
        assert!(after.contains("messages_per_hour = 2"), "a real choice survives: {after}");
        assert!(after.contains("require_pr = false"), "an unrelated section survives: {after}");
        assert!(
            after.contains(&format!("config_version = {CONFIG_MIGRATION_VERSION}")),
            "the revision is stamped: {after}"
        );
    }

    #[test]
    fn migration_v3_leaves_no_empty_pushers_stanza() {
        // Same courtesy the v1/v2 blocks extend: the user opens this file in the Advanced editor,
        // and a `[pushers]` header attributable to nothing is clutter.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "[pushers]\nmodel = \"claude-haiku-4-5\"\n").expect("seed");
        migrate_global(dir.path()).expect("migration must not fail");
        let after = std::fs::read_to_string(&path).expect("read back");
        assert!(!after.contains("[pushers]"), "the emptied stanza must go too: {after}");
    }

    #[test]
    fn a_wrong_typed_pushers_value_is_dropped_with_a_warning_and_costs_nothing_else() {
        // roborev 54240's lesson applied to [pushers]: with strongly-typed fields any ONE of these
        // lines fails the WHOLE-FILE parse, discarding the entire global layer so every unrelated
        // setting silently reverts. Each bad value must cost exactly itself.
        let g = r#"
[workflow]
require_pr = false

[pushers]
enabled = "yes"
messages_per_hour = "two"
inbox_yield_pct = 25
model = 42
mesages_per_hour = 9
"#;
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard, "a wrong-typed Pusher knob must never be a hard error");
        // The unrelated setting in the same file survived — the whole point.
        assert!(!cfg.workflow.require_pr, "an unrelated section must still apply");
        let p = &cfg.pushers;
        assert!(p.enabled, "a non-bool master switch is dropped, so the shipped `true` stands");
        assert_eq!(p.messages_per_hour, 4, "the bad budget was dropped, not coerced");
        assert_eq!(p.inbox_yield_pct, 25, "the GOOD field in the same table still applied");
        // Every dropped line is REPORTED — including the misspelling, which would otherwise parse,
        // apply nothing, and say nothing while the Pusher kept its shipped rate.
        let said = |needle: &str| warns.iter().any(|w| w.contains(needle));
        assert!(said("[pushers].enabled is a string"), "master switch: {warns:?}");
        assert!(said("[pushers].messages_per_hour is a string"), "budget: {warns:?}");

        assert!(said("[pushers].mesages_per_hour is not a Pusher setting"), "typo: {warns:?}");
        // The RETIRED key still in the fixture. It is no longer a Pusher setting at all, so it must
        // be reported by the unknown-key path rather than silently accepted — the same sentence a
        // stale on-disk `model = ...` gets until the v3 migration removes it.
        assert!(said("[pushers].model is not a Pusher setting"), "retired key: {warns:?}");
    }

    #[test]
    fn an_out_of_range_pushers_value_is_reported_and_never_rewritten() {
        // WARN ONLY. The number stays the user's: the TypeScript resolver already clamps every one
        // of these before anything acts on it, and rewriting the merged config here would be the
        // standing rewrite that made `max_concurrent = 20` unsettable (roborev 53140) — the ⋯-menu
        // would show a value the file does not contain.
        let g = "[pushers]\nmessages_per_hour = 0\ninbox_yield_pct = 0\nobserve_interval_ms = 5000\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert_eq!(cfg.pushers.messages_per_hour, 0, "kept — warned about, not rewritten");
        assert_eq!(cfg.pushers.inbox_yield_pct, 0, "kept");
        assert_eq!(cfg.pushers.observe_interval_ms, 5000, "kept");
        let said = |needle: &str| warns.iter().any(|w| w.contains(needle));
        assert!(said("[pushers].messages_per_hour is 0"), "budget: {warns:?}");
        assert!(said("[pushers].inbox_yield_pct is 0"), "percentage: {warns:?}");
        assert!(said("[pushers].observe_interval_ms is 5000"), "interval: {warns:?}");
        // Values the resolver ACTUALLY HONORS are silent, so the warnings above mean something.
        //
        // This used to use `inbox_yield_pct = 100` — a value `resolvePusherPolicy` clamps to 80 —
        // so the suite was asserting the silence of a line that does nothing, pinning the gap as
        // intended behaviour (roborev 56365). Every number here now survives the resolver unchanged.
        let (_, quiet, _) = effective(
            Some("[pushers]\nmessages_per_hour = 2\ninbox_yield_pct = 50\nobserve_interval_ms = 60000\n"),
            None,
        );
        assert!(quiet.is_empty(), "a usable envelope warns about nothing: {quiet:?}");
    }

    #[test]
    fn a_pushers_value_above_the_shipped_ceiling_is_reported_not_silently_reduced() {
        // The plausible edit — "let it talk even when my inbox is busy" — is `inbox_yield_pct = 100`,
        // and the resolver's `min()` turns it into 80. Silently. A line the user deliberately wrote
        // that does nothing and says nothing is the worst of the three outcomes this section chooses
        // between (roborev 56365).
        let g = "[pushers]\ninbox_yield_pct = 100\nmessages_per_hour = 10\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        // Still never rewritten — the number stays the user's, exactly as for the low end.
        assert_eq!(cfg.pushers.inbox_yield_pct, 100, "kept — warned about, not rewritten");
        assert_eq!(cfg.pushers.messages_per_hour, 10, "kept");
        let said = |needle: &str| warns.iter().any(|w| w.contains(needle));
        assert!(said("inbox_yield_pct is 100, above the shipped ceiling"), "yield: {warns:?}");
        assert!(said("messages_per_hour is 10, above the shipped ceiling"), "budget: {warns:?}");
        // And the warning names the number the user will actually get, not just that it was wrong.
        assert!(said("yield at 80%"), "must name the effective value: {warns:?}");
        assert!(said("at most 4 an hour"), "must name the effective value: {warns:?}");
    }

    #[test]
    fn pushers_in_a_project_file_cannot_override_the_global_envelope() {
        // The boundary [concierge] already draws, for a related reason: how often the agents on
        // this machine get interrupted — and how much is spent doing it — is the machine owner's
        // call, not a property of a repo that happens to be cloned onto it.
        let p = "[pushers]\nenabled = false\nmessages_per_hour = 99\ninbox_yield_pct = 5\n";
        let (cfg, warns, hard) = effective(None, Some(p));
        assert!(!hard);
        assert!(cfg.pushers.enabled, "a repo must not be able to switch this machine's Pushers off");
        assert_eq!(cfg.pushers.messages_per_hour, 4, "nor crank the budget up");
        assert_eq!(cfg.pushers.inbox_yield_pct, 80, "nor make them yield sooner");
        let msg = warns
            .iter()
            .find(|w| w.contains("[pushers]"))
            .expect("the user must be told their project rules were ignored");
        assert!(msg.contains("global config.toml"), "the remedy must name the file: {msg}");
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
        // Read back from `local.toml`, which is where the project writer now lands, and layer it as
        // the LOCAL layer — the resolved precedence is what this test is about, and it is unchanged.
        // The tracked `config.toml` is asserted absent, so this cannot pass by reading the old file.
        assert!(!project_path(&root).exists(), "the tracked file must not be written at runtime");
        let p_text = read_if_exists(&local_path(&root));
        let (cfg, _, _) =
            build_effective_layered(SparkleConfig::default(), g_text.as_deref(), None, p_text.as_deref());
        assert_eq!(cfg.approvals.bash.as_deref(), Some("never"), "project overrides global");

        // Clear the project rule → falls back to the global rule.
        unset_project_value(&root, "approvals.bash").unwrap();
        let p_text = read_if_exists(&local_path(&root));
        let (cfg, _, _) =
            build_effective_layered(SparkleConfig::default(), g_text.as_deref(), None, p_text.as_deref());
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

    // ---- per-project concierge tool policy (bead sparkle-gylxbo) -----------------

    #[test]
    fn set_dotted_round_trips_a_quoted_slug_containing_a_dot() {
        // THE regression this splitter exists for. A repo slug carries a `/`, so TOML requires the
        // quotes; the naive `split('.')` then tore `"a/b.c"` into `"a/b` and `c"` and wrote the rule
        // under an invented nesting nobody reads — silently, because the resulting file still
        // parses. A slug with only a slash would pass a BROKEN parser (there is no dot to split on),
        // so the dot is the part that has power here.
        let mut doc = "".parse::<toml_edit::DocumentMut>().unwrap();
        set_dotted(
            &mut doc,
            "concierge.projects.\"a/b.c\".tools.merge_pr",
            "deny".into(),
        )
        .unwrap();
        let text = doc.to_string();

        // The document itself addresses ONE key named `a/b.c`, four levels down — not six.
        let entry = doc
            .get("concierge")
            .and_then(|c| c.get("projects"))
            .and_then(|p| p.get("a/b.c"))
            .and_then(|e| e.get("tools"))
            .and_then(|t| t.get("merge_pr"))
            .and_then(|v| v.as_str());
        assert_eq!(entry, Some("deny"), "the rule lands under the whole slug: {text}");

        // And the SIDE EFFECT that matters: the file we wrote loads back as a rule for that repo.
        let (cfg, warns, hard) = effective(Some(&text), None);
        assert!(!hard, "the written file must parse: {text}");
        assert!(warns.is_empty(), "a valid rule warns about nothing: {warns:?}");
        assert_eq!(
            cfg.concierge.projects["a/b.c"].tools["merge_pr"],
            "deny",
            "round-trips into the loaded config: {text}"
        );
    }

    #[test]
    fn unset_dotted_removes_a_quoted_slug_key() {
        // A path that can be SET must be removable by the same string, or the settings pane can
        // write a per-repo rule it can never clear.
        let src = "[concierge.projects.\"a/b.c\".tools]\nmerge_pr = \"deny\"\nland_agent_branch = \"ask\"\n";
        let mut doc = src.parse::<toml_edit::DocumentMut>().unwrap();
        unset_dotted(&mut doc, "concierge.projects.\"a/b.c\".tools.merge_pr").unwrap();
        let text = doc.to_string();
        let (cfg, _, hard) = effective(Some(&text), None);
        assert!(!hard);
        let tools = &cfg.concierge.projects["a/b.c"].tools;
        assert!(!tools.contains_key("merge_pr"), "the named rule goes: {text}");
        assert_eq!(tools["land_agent_branch"], "ask", "its sibling stays: {text}");
    }

    #[test]
    fn a_dotted_path_with_an_unterminated_quote_is_an_error_not_a_guess() {
        // Writing to a mis-parsed path is the silent failure this whole splitter exists to stop, so
        // an unreadable path must refuse rather than invent a nesting.
        let mut doc = "".parse::<toml_edit::DocumentMut>().unwrap();
        let err = set_dotted(&mut doc, "concierge.projects.\"a/b.tools", 1i64.into())
            .expect_err("an unterminated quote must not be guessed at");
        assert!(err.contains("unterminated"), "the reason is diagnosable: {err}");
        assert_eq!(doc.to_string(), "", "and nothing was written");
        // Bare paths are unaffected — every existing caller passes one.
        assert_eq!(
            split_dotted_path("workers.max_concurrent").unwrap(),
            vec!["workers".to_string(), "max_concurrent".to_string()]
        );
    }

    #[test]
    fn own_orgs_and_per_repo_rules_are_read_trimmed_and_lowercased() {
        let g = r#"
[concierge]
own_orgs = ["  DRodio ", "Try-Sparkle"]

[concierge.tools]
merge_pr = "allow"

[concierge.projects."Plow-PBC/TKMX-Server".tools]
merge_pr = "deny"
"#;
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert!(warns.is_empty(), "a valid section warns about nothing: {warns:?}");
        // Lowercased and trimmed: the answer is compared against a resolved remote URL, and GitHub
        // treats owner/repo case-insensitively. A verbatim key would silently match nothing —
        // failing OPEN on a line written to tighten one repo.
        assert_eq!(cfg.concierge.own_orgs, vec!["drodio", "try-sparkle"]);
        assert_eq!(
            cfg.concierge.projects["plow-pbc/tkmx-server"].tools["merge_pr"],
            "deny"
        );
        // The global tier is untouched by the per-repo rule — the strictest-of lattice lives in
        // TypeScript, and this layer must hand it BOTH numbers rather than pre-resolving one.
        assert_eq!(cfg.concierge.tools["merge_pr"], "allow");
    }

    #[test]
    fn a_second_per_repo_block_merges_per_key_instead_of_replacing_the_first() {
        // PER KEY, never wholesale — the same contract `[concierge.tools]` holds. A user who writes
        // two rules for one repo in two places must keep both.
        let g = r#"
[concierge.projects."owner/repo".tools]
merge_pr = "deny"
push_agent_branch = "ask"
"#;
        let (cfg, _, hard) = effective(Some(g), None);
        assert!(!hard);
        let tools = &cfg.concierge.projects["owner/repo"].tools;
        assert_eq!(tools["merge_pr"], "deny");
        assert_eq!(tools["push_agent_branch"], "ask");
        assert_eq!(tools.len(), 2);
    }

    #[test]
    fn an_unrecognized_per_repo_decision_is_kept_verbatim_and_warned_about() {
        // Kept, NOT narrowed. The frontend reads an unreadable rule as `ask`, which is stricter
        // than the tier the repo would inherit; rewriting it here to a value this build recognizes
        // would hand back exactly the authority the user was writing that line to remove.
        let g = "[concierge.projects.\"owner/repo\".tools]\nmerge_pr = \"nope\"\n";
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        assert_eq!(
            cfg.concierge.projects["owner/repo"].tools["merge_pr"],
            "nope",
            "the raw string survives so the frontend can read it as `ask`"
        );
        assert!(
            warns.iter().any(|w| w.contains("[concierge.projects.\"owner/repo\".tools].merge_pr")),
            "and the user is told: {warns:?}"
        );
    }

    #[test]
    fn a_wrong_typed_entry_in_the_new_sections_costs_only_itself() {
        // roborev 54240's lesson, applied to the two new keys: with strong types any ONE of these
        // lines fails the WHOLE-FILE parse and every unrelated setting silently reverts.
        let g = r#"
[workflow]
require_pr = false

[concierge]
own_orgs = ["good", 42]

[concierge.projects]
"owner/scalar" = "deny"

[concierge.projects."owner/repo".tools]
merge_pr = true
land_agent_branch = "deny"
"#;
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard, "a typo in one rule must never be a hard error: {warns:?}");
        assert!(!cfg.workflow.require_pr, "an unrelated section still applies");
        assert_eq!(cfg.concierge.own_orgs, vec!["good"], "the good entry survives");
        let tools = &cfg.concierge.projects["owner/repo"].tools;
        assert!(!tools.contains_key("merge_pr"), "the non-string rule is dropped, not coerced");
        assert_eq!(tools["land_agent_branch"], "deny", "its good sibling in the same table applies");
        let said = |needle: &str| warns.iter().any(|w| w.contains(needle));
        assert!(said("[concierge].own_orgs contains a integer"), "list entry: {warns:?}");
        assert!(said("[concierge.projects.\"owner/scalar\"] is a string"), "scalar entry: {warns:?}");
        assert!(said("[concierge.projects.\"owner/repo\".tools].merge_pr is a boolean"), "rule: {warns:?}");
    }

    #[test]
    fn own_orgs_as_a_bare_string_is_reported_rather_than_silently_ignored() {
        // The likely reach — the singular form. Left silent, the user believes he has named his org
        // while every repo stays foreign and Sparkle keeps interrupting him.
        let (cfg, warns, hard) = effective(Some("[concierge]\nown_orgs = \"drodio\"\n"), None);
        assert!(!hard);
        assert!(cfg.concierge.own_orgs.is_empty(), "nothing is inferred from a wrong shape");
        assert!(
            warns.iter().any(|w| w.contains("[concierge].own_orgs is a string")),
            "the user is told: {warns:?}"
        );
    }

    #[test]
    fn the_new_concierge_keys_are_still_ignored_in_a_project_config() {
        // THE SECURITY BOUNDARY, and it matters MOST for a repo the user does not own. If a cloned
        // repo could write `[concierge].own_orgs = ["its-own-org"]` into its checked-in
        // .sparkle/config.toml it would declare ITSELF owned, lifting the very floor that exists to
        // protect it — and a per-repo `merge_pr = "allow"` would be the same move from the other
        // side. Both must be inert with a warning.
        let p = r#"
[concierge]
own_orgs = ["plow-pbc"]

[concierge.projects."plow-pbc/tkmx-server".tools]
merge_pr = "allow"
"#;
        let (cfg, warns, hard) = effective(None, Some(p));
        assert!(!hard);
        assert!(
            cfg.concierge.own_orgs.is_empty(),
            "a repo must never be able to declare itself owned"
        );
        assert!(
            cfg.concierge.projects.is_empty(),
            "nor to write itself a rule; per-repo policy is global-only"
        );
        assert!(
            warns.iter().any(|w| w.contains("[concierge] in a per-project")),
            "and the reader is told why it did nothing: {warns:?}"
        );
    }

    #[test]
    fn migration_v4_adds_own_orgs_and_changes_no_tier() {
        // The whole promise of this migration: NOBODY silently gains — or loses — authority by
        // upgrading. So the assertion that has power is not "the file still parses", it is that a
        // tier the human tightened BY HAND reads back byte-identical afterwards.
        let dir = app_data_with(
            "[concierge.tools]\nmerge_pr = \"allow\"\ndiscard_agent = \"deny\"\n\
             \n[meta]\nconfig_version = 3\n",
        );
        migrate_global(dir.path()).expect("migration must not fail");
        let text = global_text(&dir);
        let (cfg, warns, hard) = effective(Some(&text), None);
        assert!(!hard, "the migrated file must load: {text}");

        assert_eq!(cfg.concierge.tools["merge_pr"], "allow", "a hand-set tier is UNCHANGED: {text}");
        assert_eq!(cfg.concierge.tools["discard_agent"], "deny", "and so is this one: {text}");
        assert!(cfg.concierge.own_orgs.is_empty(), "the lever ships EMPTY — every repo foreign");
        assert!(text.contains("own_orgs = []"), "the lever is written so it is discoverable: {text}");
        assert!(
            !text.contains("[concierge.projects"),
            "and NOTHING else is added: {text}"
        );
        assert!(warns.is_empty(), "the migrated file warns about nothing: {warns:?}");
        let doc = text.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(
            doc.get("meta").and_then(|m| m.get("config_version")).and_then(|v| v.as_integer()),
            Some(4),
            "stamped, so it runs once: {text}"
        );
    }

    #[test]
    fn migration_v4_writes_own_orgs_onto_concierge_not_onto_a_subtable() {
        // The reachable way to get this wrong: `[concierge]` already exists only as the PARENT of
        // `[concierge.checks]`, and a value appended after a subtable would render inside it —
        // making `own_orgs` a lint knob and leaving the real lever absent. Every real install has a
        // `[concierge.checks]` block (it ships in the template), so this is the common path.
        let dir = app_data_with("[concierge.checks]\nenabled = true\n");
        migrate_global(dir.path()).expect("migration must not fail");
        let text = global_text(&dir);
        let (cfg, warns, hard) = effective(Some(&text), None);
        assert!(!hard, "the migrated file must load: {text}");
        assert!(cfg.concierge.own_orgs.is_empty());
        assert!(
            cfg.concierge.checks.enabled,
            "the existing lint policy is untouched: {text}"
        );
        assert!(
            !warns.iter().any(|w| w.contains("own_orgs")),
            "own_orgs landed on [concierge], not inside [concierge.checks]: {warns:?} / {text}"
        );
        let doc = text.parse::<toml_edit::DocumentMut>().unwrap();
        assert!(
            doc.get("concierge").and_then(|c| c.get("own_orgs")).is_some(),
            "on the parent table: {text}"
        );
        assert!(
            doc.get("concierge")
                .and_then(|c| c.get("checks"))
                .and_then(|c| c.get("own_orgs"))
                .is_none(),
            "and NOT on the checks subtable: {text}"
        );
    }

    #[test]
    fn migration_v4_keeps_an_org_the_user_already_named() {
        // The upgrade path for someone who edited the file before this build shipped, or who is
        // re-migrated after a version bump. A migration that overwrote this would be exactly the
        // "silently changes a value the human chose" failure roborev 53140 was about.
        let dir = app_data_with(
            "[concierge]\nown_orgs = [\"drodio\"]\n\n[meta]\nconfig_version = 1\n",
        );
        migrate_global(dir.path()).expect("migration must not fail");
        let (cfg, _, hard) = effective(Some(&global_text(&dir)), None);
        assert!(!hard);
        assert_eq!(cfg.concierge.own_orgs, vec!["drodio"], "the user's choice survives");
    }

    #[test]
    fn a_project_key_that_can_never_match_a_repo_is_reported_rather_than_silently_inert() {
        // FAILS OPEN otherwise, which is the direction that matters: a key that is not an
        // `owner/repo` slug can never equal a resolved remote URL, so the rule contributes no
        // tightening — on the one line the user wrote to restrict a repo. Every other mistake in
        // this section warns, so silence here reads as acceptance.
        let g = r#"
[concierge.projects."tkmx-server".tools]
merge_pr = "deny"

[concierge.projects."https://github.com/plow-pbc/tkmx-server".tools]
merge_pr = "deny"

[concierge.projects."plow-pbc/tkmx server".tools]
merge_pr = "deny"

[concierge.projects."plow-pbc/tkmx-server.git".tools]
merge_pr = "deny"

[concierge.projects."plow-pbc/tkmx-server".tools]
merge_pr = "deny"
"#;
        let (cfg, warns, hard) = effective(Some(g), None);
        assert!(!hard);
        let said = |needle: &str| warns.iter().any(|w| w.contains(needle));
        assert!(said("[concierge.projects.\"tkmx-server\"] is not an \"owner/repo\" slug"), "bare repo name: {warns:?}");
        assert!(
            said("[concierge.projects.\"https://github.com/plow-pbc/tkmx-server\"] is not an"),
            "pasted URL: {warns:?}"
        );
        // THE `.git` SUFFIX — the likeliest miss of the four, because it is what you get by copying
        // the tail of a clone URL, and the one that used to pass silently (roborev 65417). `.` is a
        // legal slug character, so the character-set check alone waves it through; but
        // `repo_slug_from_url` strips `.git`, so a resolved slug can never carry it and this key
        // tightens nothing. Both the doc comment and the remedy string name it, so it has to warn.
        assert!(
            said("[concierge.projects.\"plow-pbc/tkmx-server.git\"] is not an"),
            ".git suffix: {warns:?}"
        );
        assert!(said("[concierge.projects.\"plow-pbc/tkmx server\"] is not an"), "inner space: {warns:?}");
        // The rule is KEPT, not dropped — reporting the mistake, not rewriting what the user wrote.
        assert_eq!(cfg.concierge.projects["tkmx-server"].tools["merge_pr"], "deny");
        // And the WELL-FORMED sibling in the same file draws no warning at all, so the check cannot
        // be satisfied by warning about everything.
        assert!(
            !warns.iter().any(|w| w.contains("\"plow-pbc/tkmx-server\"] is not an")),
            "a real slug must stay quiet: {warns:?}"
        );
        assert_eq!(cfg.concierge.projects["plow-pbc/tkmx-server"].tools["merge_pr"], "deny");
    }

    #[test]
    fn an_own_orgs_entry_that_can_never_match_an_owner_is_reported() {
        // The mirror-image failure, and the more expensive one: a repo slug where an ORG goes
        // matches nothing, so every repo stays foreign and Sparkle keeps asking — while the user
        // believes he lifted the floor.
        let (cfg, warns, hard) = effective(
            Some("[concierge]\nown_orgs = [\"drodio/sparkle\", \"https://github.com/drodio\", \"drodio\"]\n"),
            None,
        );
        assert!(!hard);
        let said = |needle: &str| warns.iter().any(|w| w.contains(needle));
        assert!(said("own_orgs contains \"drodio/sparkle\", which is not a bare GitHub org"), "slug: {warns:?}");
        assert!(said("own_orgs contains \"https://github.com/drodio\""), "URL: {warns:?}");
        // Kept, not dropped, and the good entry is silent — so the warning is about SHAPE, not
        // about there being more than one entry.
        assert_eq!(cfg.concierge.own_orgs, vec!["drodio/sparkle", "https://github.com/drodio", "drodio"]);
        assert!(
            !warns.iter().any(|w| w.contains("own_orgs contains \"drodio\",")),
            "a real org must stay quiet: {warns:?}"
        );
    }

    /// Read the ONE shared file both language halves declare their pin list against. `policy.ts`
    /// pins its own copy against this same file, so a slug added on one side and forgotten on the
    /// other fails a test here instead of drifting into a repo Sparkle would then merge in.
    #[test]
    fn merge_protected_slugs_match_the_shared_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("shared")
            .join("merge-protected-repos.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let fixture: serde_json::Value = serde_json::from_str(&raw).expect("fixture is valid JSON");
        assert_eq!(fixture["version"].as_i64(), Some(1), "wire version is frozen at 1");
        let expected: Vec<&str> = fixture["pinnedSlugs"]
            .as_array()
            .expect("pinnedSlugs array")
            .iter()
            .map(|e| e.as_str().expect("pinnedSlugs entries are strings"))
            .collect();
        assert_eq!(
            MERGE_PROTECTED_SLUGS.to_vec(),
            expected,
            "MERGE_PROTECTED_SLUGS drifted from apps/desktop/shared/merge-protected-repos.json"
        );
    }

    #[test]
    fn the_merge_protected_pin_is_case_insensitive_and_narrow() {
        // A resolved `remote.origin.url` can carry any casing, and GitHub treats owner/repo
        // case-insensitively — a pin a differently-cased remote could slip past would not be a
        // floor at all.
        assert!(is_merge_protected_slug("plow-pbc/tkmx-server"));
        assert!(is_merge_protected_slug("  Plow-PBC/TKMX-Server  "));
        // And it must not spread to repos nobody pinned.
        assert!(!is_merge_protected_slug("drodio/sparkle"));
        assert!(!is_merge_protected_slug("plow-pbc/something-else"));
        assert!(!is_merge_protected_slug(""));
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
    fn a_write_refuses_an_unparseable_global_config_instead_of_erasing_it() {
        // THE DATA-LOSS CASE. A shared loader used to fall back to DEFAULT_TEMPLATE when the file would not
        // parse — right for the read path (the editor still opens), catastrophic for a write: the
        // document being edited is then the TEMPLATE, so persisting it replaces the user's settings,
        // their comments, and the malformed text they need in order to repair it. `parse_layer`
        // cannot catch it, because the template is valid TOML; it is the WRONG document, not an
        // invalid one.
        //
        // Reachable by a typo in a hand-edited file, and it needs no user action to fire: any
        // automatic launch-time write lands it at startup.
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        let corrupt = "# my careful settings\n[approvals]\nbash = \"always\"\n[[[ oops";
        std::fs::write(global_path(ad), corrupt).unwrap();

        let err = set_value(ad, "improvement.consent", &serde_json::json!("always"))
            .expect_err("a write against an unparseable config must be refused");
        assert!(err.contains("not valid TOML"), "unexpected error: {err}");

        // The SIDE EFFECT is the assertion: the bytes on disk are untouched, including the comment
        // and the malformed tail. Asserting only the Err would pass against a version that errored
        // after writing.
        assert_eq!(
            std::fs::read_to_string(global_path(ad)).unwrap(),
            corrupt,
            "the user's file must survive byte-identical"
        );

        // Same for the other two writers, which shared the same loader.
        assert!(set_values(ad, &[("improvement.consent".into(), serde_json::json!("never"))]).is_err());
        assert!(unset_value(ad, "improvement.consent").is_err());
        assert_eq!(std::fs::read_to_string(global_path(ad)).unwrap(), corrupt);
    }

    #[test]
    fn a_write_refuses_a_file_it_cannot_read_rather_than_treating_it_as_absent() {
        // The residual branch of the fix above. `read_if_exists` is `read_to_string(..).ok()`, so it
        // collapses EVERY read error into "absent" — invalid UTF-8 from a hand-edit saved in another
        // encoding, a truncated write, EACCES, EIO. Each of those is a file that EXISTS and holds
        // the user's settings, and each would otherwise start the write from the template and let
        // the atomic rename replace their config with the default: the same data loss, through the
        // one branch that looked safe.
        //
        // Invalid UTF-8 is the case a hand-editor can actually produce, and it needs no unusual
        // permissions to set up, so it is the one asserted here.
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        let raw: &[u8] = b"[approvals]\nbash = \"alw\xffays\"\n";
        std::fs::write(global_path(ad), raw).unwrap();

        let err = set_value(ad, "improvement.consent", &serde_json::json!("always"))
            .expect_err("a write against an unreadable config must be refused");
        assert!(err.contains("could not be read"), "unexpected error: {err}");

        // The bytes, not the message: a version that errored AFTER writing would pass on the Err.
        assert_eq!(
            std::fs::read(global_path(ad)).unwrap(),
            raw,
            "the user's file must survive byte-identical"
        );
    }

    #[test]
    fn a_project_write_refuses_a_file_it_cannot_read_rather_than_emptying_it() {
        // The per-project sibling, and a STRICTLY WORSE loss than the global one: the absent branch
        // here is an EMPTY document, not the default template, so a write that wrongly reaches it
        // renders a file holding only the key just set — every project setting and every
        // [done]/[delivered] stage definition gone, along with the bytes needed to repair it.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        // `local.toml`, because that is the file the project writers open. The tracked
        // `config.toml` is never opened by a writer at all, so it has no such branch to test.
        let path = local_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let raw: &[u8] = b"# hand-written\n[workflow]\nrequire_pr = fa\xfflse\n";
        std::fs::write(&path, raw).unwrap();

        let err = set_project_value(&root, "approvals.bash", &serde_json::json!("always"))
            .expect_err("a project write against an unreadable config must be refused");
        assert!(err.contains("could not be read"), "unexpected error: {err}");
        assert_eq!(std::fs::read(&path).unwrap(), raw, "the project file must survive byte-identical");

        // The stage-definition writer reads the same file inline and had the same shape.
        let def = serde_json::json!({ "description": "x", "criteria": [] });
        assert!(write_stage_definition(&root, "done", &def).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), raw);

        // And the remover must not report a removal it did not perform.
        assert!(unset_project_value(&root, "approvals.bash").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), raw);
    }

    #[test]
    fn the_editor_refuses_to_show_the_template_for_a_file_it_cannot_read() {
        // The READ arm, and the cheapest path to the same loss: showing DEFAULT_TEMPLATE for an
        // unreadable file is indistinguishable from a first-run empty state, so one Save calls
        // write_text, which validates the template (valid TOML) and renames it over the user's
        // config. Zero clicks became one.
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        let raw: &[u8] = b"[approvals]\nbash = \"alw\xffays\"\n";
        std::fs::write(global_path(ad), raw).unwrap();

        let err = read_editor_text(&global_path(ad))
            .expect_err("an unreadable config must not render as the default template");
        assert!(err.contains("could not be read"), "unexpected error: {err}");

        // Absent still opens on the template — that is the first-run path and must keep working.
        let empty = tempfile::tempdir().unwrap();
        let text = read_editor_text(&global_path(empty.path())).expect("absent file opens");
        assert_eq!(text, DEFAULT_TEMPLATE);

        // ...and a merely-UNPARSEABLE but readable file still shows its OWN text, not the default:
        // repairing it in the editor is the whole point.
        let broken = tempfile::tempdir().unwrap();
        std::fs::write(global_path(broken.path()), "[[[ oops").unwrap();
        assert_eq!(read_editor_text(&global_path(broken.path())).unwrap(), "[[[ oops");
    }

    /// Serializes the tests that touch the PROCESS-GLOBAL cached config layer.
    ///
    /// `reload_global` writes a singleton, so two tests driving it in parallel interleave: one
    /// resets the cached layer to defaults between another's load and its assertion. The harness
    /// runs tests in parallel by default and nothing in this crate passes `--test-threads=1`, so
    /// this is not hypothetical — and the test it breaks is the only proof of the unreadable-file
    /// fix, which is the worst possible place for an intermittent red (it reads as "the fix is
    /// broken"). Poison-tolerant for the same reason the production lock is: one panicking test
    /// must not wedge the rest.
    static CONFIG_GLOBAL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn an_unreadable_project_config_keeps_the_global_layer_and_warns() {
        // The OTHER runtime arm. The previous commit claimed "restoring read_if_exists fails it",
        // and that held for only half the diff: nothing in the crate drove `for_project` at all, so
        // reverting its arm left the suite green. It is also the arm with the DIFFERENT contract —
        // there is no last-good project layer to keep, so the honest result is the global layer plus
        // a warning, never a silent "this project configures nothing".
        let _guard = CONFIG_GLOBAL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let path = project_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        // A project-scoped non-default, so its loss is observable.
        std::fs::write(&path, "[workflow]\nrequire_pr = false\n").unwrap();
        let good = for_project(&root);
        assert!(!good.config.workflow.require_pr, "fixture must load the project value");

        // Now unreadable. mtime and len both move here, so the (mtime,len) memo cannot serve the
        // previous entry — this exercises the read, not the cache.
        std::fs::write(&path, b"[workflow]\nrequire_pr = fa\xfflse\n").unwrap();
        let after = for_project(&root);

        // The GLOBAL layer's value, not the project's stale one and not a silent empty project.
        assert!(
            after.config.workflow.require_pr,
            "an unreadable project file must fall back to the global layer, not keep a stale value"
        );
        // MATCHED ON THIS FILE'S PATH, not on the phrase alone. `for_project` carries the GLOBAL
        // layer's warnings forward into its result, so a bare "could not be read" match also sees a
        // global-config warning left by another test — which made this assertion pass (and its
        // negative counterpart below fail) for a reason having nothing to do with the project file.
        let names_project_file =
            |ws: &[String]| ws.iter().any(|w| w.contains(&path.display().to_string()));
        assert!(
            names_project_file(&after.warnings),
            "the UI needs a warning naming the project file, got {:?}",
            after.warnings
        );

        // AND THE FAILURE IS NOT FROZEN — asserted via `chmod`, which is the ONLY way to reach the
        // state the memo fix targets.
        //
        // The first cut of this block rewrote the file's CONTENT to repair it and claimed that
        // "restoring readable content without touching the byte length keeps len equal". That was
        // false — the good fixture is 30 bytes and the invalid-UTF-8 one is 31 — so a memoized
        // failure would have missed on `len` regardless and all three assertions passed with the
        // guard removed. Vacuous, and self-certifying: the comment asserted the premise the
        // assertions needed instead of establishing it.
        //
        // Permissions are the real case anyway, and the one the production comment names: `chmod`
        // moves ctime only, so `modified()` and `len` are IDENTICAL across the failure and the
        // repair. A cached failure is therefore served, and the repair never takes effect for the
        // life of the process. Nothing but this shape exercises that.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let fresh = tempfile::tempdir().unwrap();
            let froot = fresh.path().to_string_lossy().to_string();
            let fpath = project_path(&froot);
            std::fs::create_dir_all(fpath.parent().unwrap()).unwrap();
            std::fs::write(&fpath, "[workflow]\nrequire_pr = false\n").unwrap();

            std::fs::set_permissions(&fpath, std::fs::Permissions::from_mode(0o000)).unwrap();

            // THE SKIP CONDITION IS THE OS, NOT THE CODE UNDER TEST. Gating on whether
            // `for_project` warned would make the whole proof self-referential: any regression that
            // stops it reporting an EACCES — reverting the read arm, or a message that drops the
            // path — would make this block SKIP and the test go green, which is the failure mode it
            // exists to catch. Asking the filesystem directly cannot be fooled that way, and it is
            // the only thing that actually distinguishes "root defeats mode bits" from "the
            // production path stopped reporting the failure".
            if std::fs::read_to_string(&fpath).is_err() {
                let denied = for_project(&froot);
                assert!(
                    denied
                        .warnings
                        .iter()
                        .any(|w| w.contains(&fpath.display().to_string())),
                    "an unreadable project file must warn, got {:?}",
                    denied.warnings
                );
                let before = std::fs::metadata(&fpath).unwrap();
                std::fs::set_permissions(&fpath, std::fs::Permissions::from_mode(0o644)).unwrap();
                let after_meta = std::fs::metadata(&fpath).unwrap();
                assert_eq!(
                    (before.len(), before.modified().unwrap()),
                    (after_meta.len(), after_meta.modified().unwrap()),
                    "the fixture must leave len and mtime untouched, or it does not test the memo"
                );

                let repaired = for_project(&froot);
                assert!(
                    !repaired.config.workflow.require_pr,
                    "a repaired project file must be re-read, not served from a cached failure"
                );
                assert!(
                    !repaired
                        .warnings
                        .iter()
                        .any(|w| w.contains(&fpath.display().to_string())),
                    "the stale warning must clear once the file reads again, got {:?}",
                    repaired.warnings
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_already_memoized_project_keeps_serving_last_good_when_it_becomes_unreadable() {
        // PINS THE BOUNDARY the production comment states, rather than leaving it asserted in prose.
        //
        // `for_project`'s fast path keys on `(mtime_ms, len)` plus the global layer. `chmod 000`
        // moves ctime only, so for a project ALREADY memoized as good — the common shape, since
        // this runs on a hot poll — the stamp still matches, the cache hit is served, and the
        // un-memoization code is never reached. The user therefore gets the last-good config and NO
        // warning until the stamp moves, THE GLOBAL LAYER CHANGES, or the process restarts.
        //
        // Both halves are pinned below, because the second is the one a reader trips over: the
        // silent window is not "until restart", it ends at the next global-config change.
        //
        // That is deliberate: closing it would mean re-reading the file on every hit of a hot path,
        // or keying the stamp on ctime/mode. Serving last-good is the safe direction. This test
        // exists so the decision is visible and a future change to the fast path has to confront it
        // — if someone makes it re-validate, this test fails and they update it on purpose.
        use std::os::unix::fs::PermissionsExt;
        let _guard = CONFIG_GLOBAL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let path = project_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "[workflow]\nrequire_pr = false\n").unwrap();

        // Warm the memo with a successful read.
        assert!(!for_project(&root).config.workflow.require_pr, "fixture must load first");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Gate on the OS, never on the code under test (see the sibling case for why).
        if std::fs::read_to_string(&path).is_err() {
            let after = for_project(&root);
            assert!(
                !after.config.workflow.require_pr,
                "an already-memoized project must keep serving last-good on an unchanged stamp"
            );
            assert!(
                !after.warnings.iter().any(|w| w.contains(&path.display().to_string())),
                "and it does NOT warn, because the fast path never reaches the read: {:?}",
                after.warnings
            );

            // THE INVALIDATION EDGE. A global-layer change fails `e.global_config == global.config`
            // for every project entry, so the very next call is a miss, reaches the read, and
            // surfaces the failure — with no stamp movement and no restart. Pinning it here keeps
            // the boundary from reading as "silent until restart", which is what it looks like from
            // the assertions above alone.
            let gdir = tempfile::tempdir().unwrap();
            std::fs::write(global_path(gdir.path()), "[workers]\nmax_concurrent = 5\n").unwrap();
            let _ = reload_global(gdir.path());

            let after_global_change = for_project(&root);
            assert!(
                after_global_change
                    .warnings
                    .iter()
                    .any(|w| w.contains(&path.display().to_string())),
                "a changed global layer must invalidate the entry and surface the failure, got {:?}",
                after_global_change.warnings
            );
        }
        // Restore so the tempdir can be cleaned up.
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644));
    }

    #[test]
    fn a_global_warning_reaches_project_scoped_readers_without_a_project_change() {
        // THE WARNING CHANNEL, and the failure mode that silences it.
        //
        // `reload_global`'s hard-error branch deliberately keeps the last-good `config` and
        // refreshes only `warnings` — so a global config.toml that becomes unparseable changes
        // NOTHING about the parsed config. Keying the project memo on `global_config` alone
        // therefore left every entry valid, and every project-scoped reader served the stale
        // (empty) warning list: `read_project_config` forwards these to the concierge, so the
        // channel meant to announce a broken global config went silent for exactly the surface that
        // announces it, until the project file's own stamp moved or the process restarted.
        let _guard = CONFIG_GLOBAL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let gdir = tempfile::tempdir().unwrap();
        let ad = gdir.path();
        // A value that changes nothing observable and warns about NOTHING — pinning
        // max_concurrent, for instance, emits its own advisory and would mask the assertion below.
        std::fs::write(global_path(ad), "[workflow]\nrequire_pr = true\n").unwrap();
        let _ = reload_global(ad);

        let pdir = tempfile::tempdir().unwrap();
        let root = pdir.path().to_string_lossy().to_string();
        let ppath = project_path(&root);
        std::fs::create_dir_all(ppath.parent().unwrap()).unwrap();
        std::fs::write(&ppath, "[workflow]\nrequire_pr = false\n").unwrap();

        // Warm the project memo against a clean global layer.
        let warm = for_project(&root);
        assert!(warm.warnings.is_empty(), "fixture must start clean, got {:?}", warm.warnings);

        // Break the GLOBAL file only. The parsed config is unchanged (hard-error keeps last-good);
        // the project file is untouched, so its stamp does not move.
        std::fs::write(global_path(ad), "[workflow]\nrequire_pr = true\n[[[ oops").unwrap();
        let reloaded = reload_global(ad);
        let global_warning = reloaded
            .warnings
            .first()
            .cloned()
            .expect("the global layer must warn");

        // MATCHED ON THE GLOBAL LAYER'S OWN WARNING, not on "the list is non-empty". `for_project`
        // concatenates global + project warnings, so a bare emptiness check would also be satisfied
        // by any future project-side warning — and would then pass with `global_warnings` dropped
        // from the fast-path guard, turning the only pin of this defect vacuous. The sibling test
        // above carries the same note for the same reason: it was bitten by exactly that.
        let after = for_project(&root);
        assert!(
            after.warnings.contains(&global_warning),
            "a project-scoped reader must see the GLOBAL warning ({global_warning:?}) without any \
             project-side change, got {:?}",
            after.warnings
        );
        // And the invalidation must RE-MERGE, not discard: the project overlay still has to win.
        assert!(
            !after.config.workflow.require_pr,
            "the re-merged entry must keep the project's own value, got the global one"
        );
    }

    #[test]
    fn an_unreadable_config_keeps_last_good_instead_of_reverting_to_defaults() {
        let _guard = CONFIG_GLOBAL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // THE RUNTIME ARM, and the one that needs no user action at all: reload_global runs at
        // launch and on every watcher event. An unreadable file arriving as `None` reads as an
        // ABSENT layer, so build_effective never sets hard_error and never warns — the cached
        // config is replaced by pure DEFAULTS, silently. Concurrency pins, approvals, [improvement]
        // and [freshness] all revert with nothing in the UI to say why, while a merely UNPARSEABLE
        // file (strictly less severe) correctly keeps last-good and warns.
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();

        // A good load first, with a non-default value to notice the loss of.
        std::fs::write(global_path(ad), "[workers]\nmax_concurrent = 7\n").unwrap();
        let good = reload_global(ad);
        assert_eq!(good.config.workers.max_concurrent, Some(7), "fixture must load a non-default value");

        // Now make it unreadable (invalid UTF-8 — what a hand-edit in another encoding produces).
        std::fs::write(global_path(ad), b"[workers]\nmax_concurrent = \xff7\n").unwrap();
        let after = reload_global(ad);

        assert_eq!(
            after.config.workers.max_concurrent, Some(7),
            "an unreadable file must keep the last-good config, not revert to defaults"
        );
        assert!(
            after.warnings.iter().any(|w| w.contains("could not be read")),
            "the UI needs a warning naming the problem, got {:?}",
            after.warnings
        );
    }

    #[test]
    fn a_write_still_starts_from_the_template_when_the_file_is_absent() {
        // The complement, and what stops the fix above from being "refuse everything": a first-run
        // write with no file yet must still work and produce a valid config.
        let dir = tempfile::tempdir().unwrap();
        let ad = dir.path();
        assert!(read_if_exists(&global_path(ad)).is_none(), "fixture must start with no file");

        set_value(ad, "improvement.consent", &serde_json::json!("always"))
            .expect("a first write with no existing file must succeed");

        let text = std::fs::read_to_string(global_path(ad)).unwrap();
        assert!(text.contains("always"), "the written value must be present: {text}");
        let (_cfg, _, hard) = effective(Some(&text), None);
        assert!(!hard, "the result must be valid TOML");
    }

    #[test]
    fn set_stage_definition_round_trips_and_replaces_preserving_other_sections() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let path = local_path(&root);
        // Pre-existing per-project LOCAL file with an UNRELATED [workflow] section + a comment,
        // which the stage-definition write must leave byte-intact.
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
        let ptext = std::fs::read_to_string(local_path(&root)).unwrap();
        let (cfg, _, hard) = build_effective(SparkleConfig::default(), None, Some(&ptext));
        assert!(!hard);
        assert_eq!(cfg.done.description.as_deref(), Some("Merged into origin/main."));
        assert_eq!(cfg.done.criteria.len(), 2);
        assert_eq!(cfg.done.criteria[0].signal.as_deref(), Some("merged_to_main"));
        assert_eq!(cfg.done.criteria[1].kind, "manual");
    }

    // ---- the tracked/local split (sparkle-5ur8s) ------------------------------------------------
    //
    // The property under test is NEGATIVE and is about a file nobody names in the call: a runtime
    // write must leave `.sparkle/config.toml` untouched. Every assertion below therefore compares
    // that file's BYTES before and after. Asserting merely that `local.toml` appeared would be the
    // vacuous shape — it is satisfied by a writer that wrote BOTH files.

    /// A repo policy file with the shapes that actually matter: comments (which a comment-preserving
    /// writer would rewrite), a scalar the write also sets, and a `[done]` table the stage writer
    /// would replace. If a writer touches this file at all, its bytes move.
    ///
    /// `resume` is here for the CLEAR tests, and the reason is worth stating so nobody "simplifies"
    /// them back onto `bash`. Every permission category defaults to `"always"`, so a cleared `bash`
    /// resolving to `"always"` is indistinguishable from a local `"always"` that was never removed
    /// — the assertion would pass against the defect. `resume` has three distinct values in play
    /// (tracked `"full"`, a global `"summary"`, default `"ask"`), so each outcome names exactly one
    /// layer.
    const TRACKED_POLICY: &str = "# repo policy — checked in\n\
                                  [approvals]\n\
                                  bash = \"never\"\n\
                                  resume = \"full\"\n\
                                  \n\
                                  [done]\n\
                                  description = \"Merged into the remote main branch.\"\n";

    fn seed_tracked_policy(root: &str) -> std::path::PathBuf {
        let path = project_path(root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, TRACKED_POLICY).unwrap();
        path
    }

    #[test]
    fn a_project_value_write_lands_in_local_toml_and_leaves_the_tracked_file_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let tracked = seed_tracked_policy(&root);
        let before = std::fs::read(&tracked).unwrap();

        set_project_value(&root, "approvals.bash", &serde_json::json!("always")).unwrap();

        // THE ASSERTION THIS TEST EXISTS FOR. Bytes, not "did it parse the same": a
        // comment-preserving rewrite that happens to be semantically equal is still a tracked-file
        // modification, and a tracked-file modification is what aborts `git merge --ff-only` in the
        // shared checkout. Equality of MEANING is not the property; equality of BYTES is.
        assert_eq!(
            std::fs::read(&tracked).unwrap(),
            before,
            "a runtime write must not touch the tracked .sparkle/config.toml"
        );

        // ...and the write really happened, in the other file, with the effect it is supposed to
        // have: the local value WINS over the tracked one through the real resolver.
        let ltext = std::fs::read_to_string(local_path(&root)).unwrap();
        let (cfg, _, hard) = build_effective_layered(
            SparkleConfig::default(),
            None,
            Some(TRACKED_POLICY),
            Some(&ltext),
        );
        assert!(!hard);
        assert_eq!(cfg.approvals.bash.as_deref(), Some("always"));

        // The remover is the same path and gets the same guarantee — aimed at `resume`, a key this
        // machine never set, so it can only be cleared by reaching past the tracked file.
        unset_project_value(&root, "approvals.resume").unwrap();
        assert_eq!(
            std::fs::read(&tracked).unwrap(),
            before,
            "clearing a rule must not touch the tracked file either"
        );
        let ltext = std::fs::read_to_string(local_path(&root)).unwrap();
        let (cfg, _, _) = build_effective_layered(
            SparkleConfig::default(),
            None,
            Some(TRACKED_POLICY),
            Some(&ltext),
        );
        // THIS ASSERTION USED TO READ "the tracked repo policy answers again" AND THAT WAS THE
        // DEFECT (roborev 66889). It is what the UI shows: clearing a rule and watching the toggle
        // come back with the value you just cleared is indistinguishable from the clear having
        // failed — which, for a rule living only in the tracked file, is what it had. Clear means
        // cleared, on this machine, wherever the value came from; the tracked file keeps its bytes
        // and keeps applying to everyone else.
        assert_eq!(
            cfg.approvals.resume.as_deref(),
            Some("ask"),
            "clearing must clear — a rule the tracked file sets falls through to the default, not \
             back to the tracked value"
        );
        // The local write from the first half is untouched by the clear of a different key.
        assert_eq!(cfg.approvals.bash.as_deref(), Some("always"));
    }

    #[test]
    fn a_stage_definition_write_lands_in_local_toml_and_leaves_the_tracked_file_byte_identical() {
        // The Define Stage modal's writer — the one whose uncommitted write actually wedged the
        // shared main checkout. It insert-or-REPLACES a whole table, so aimed at the tracked file it
        // would rewrite the committed `[done]`/`[delivered]` policy block wholesale.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let tracked = seed_tracked_policy(&root);
        let before = std::fs::read(&tracked).unwrap();

        let def = serde_json::json!({
            "description": "Shipped to production.",
            "detected_method": "release_tag",
            "confidence": "high",
            "criteria": [ { "text": "In a cut release", "kind": "auto", "signal": "in_release" } ]
        });
        write_stage_definition(&root, "delivered", &def).unwrap();

        assert_eq!(
            std::fs::read(&tracked).unwrap(),
            before,
            "Define Stage must not touch the tracked .sparkle/config.toml"
        );

        // A `[done]` write is the sharper case: the tracked file ALREADY HAS a `[done]` table, so a
        // writer aimed at it would replace a committed policy block rather than merely append.
        let done = serde_json::json!({
            "description": "Locally redefined.",
            "criteria": [ { "text": "x", "kind": "manual" } ]
        });
        write_stage_definition(&root, "done", &done).unwrap();
        assert_eq!(std::fs::read(&tracked).unwrap(), before, "the committed [done] block survives");

        let ltext = std::fs::read_to_string(local_path(&root)).unwrap();
        let (cfg, _, hard) = build_effective_layered(
            SparkleConfig::default(),
            None,
            Some(TRACKED_POLICY),
            Some(&ltext),
        );
        assert!(!hard);
        assert_eq!(cfg.delivered.description.as_deref(), Some("Shipped to production."));
        assert_eq!(
            cfg.done.description.as_deref(),
            Some("Locally redefined."),
            "the local [done] overrides the tracked one"
        );
    }

    #[test]
    fn the_local_layer_wins_over_the_tracked_project_layer() {
        // Precedence: defaults -> global -> tracked project -> local. Every pair is asserted in the
        // SAME resolve, so an implementation that applied local FIRST (or dropped it) fails here.
        let g = "[approvals]\nbash = \"summary\"\nresume = \"summary\"\n";
        let project = "[approvals]\nbash = \"never\"\n[workflow]\nrequire_pr = false\n";
        let local = "[approvals]\nbash = \"always\"\n";
        let (cfg, _, hard) =
            build_effective_layered(SparkleConfig::default(), Some(g), Some(project), Some(local));
        assert!(!hard);
        // set in all three → local wins
        assert_eq!(cfg.approvals.bash.as_deref(), Some("always"), "local beats project beats global");
        // set in global only → survives, so "local wins" is an override, not a wipe of the stack
        assert_eq!(cfg.approvals.resume.as_deref(), Some("summary"));
        // set in the tracked project file only → still applies with a local layer present
        assert!(!cfg.workflow.require_pr, "tracked repo policy keeps applying");
    }

    #[test]
    fn a_repo_with_no_local_toml_resolves_exactly_as_it_did_before() {
        // THE REGRESSION GUARD. Reads of the tracked file are supposed to be untouched by this
        // change, so a repo that has no `.sparkle/local.toml` must resolve to the identical config
        // AND the identical warning list as the pre-split three-layer path.
        let g = "[workers]\nmax_concurrent = 3\n[approvals]\nresume = \"summary\"\n";
        // Deliberately carries a refused section so the WARNINGS are non-empty and comparable —
        // an all-green pair would be equal for uninteresting reasons.
        let project = "[approvals]\nbash = \"never\"\n[workflow]\nrequire_pr = false\n[roborev]\nenabled = true\n";

        let (before, w_before, h_before) =
            build_effective(SparkleConfig::default(), Some(g), Some(project));
        let (after, w_after, h_after) =
            build_effective_layered(SparkleConfig::default(), Some(g), Some(project), None);

        assert_eq!(before, after, "no local.toml → byte-for-byte the same effective config");
        assert_eq!(w_before, w_after, "…and the same warnings, in the same order");
        assert_eq!(h_before, h_after);
        assert!(
            w_before.iter().any(|w| w.contains("[roborev]") && w.contains(".sparkle/config.toml")),
            "the tracked file's refusal must still name the TRACKED file: {w_before:?}"
        );
    }

    #[test]
    fn a_global_only_section_in_local_toml_is_ignored_and_warns_naming_local_toml() {
        // `local.toml` is per-project too, so it must not become a back door that re-grants a
        // machine-wide section to a repo. `[workers]` is the canonical one: it decides how many
        // agents run on THIS machine.
        let local = "[workers]\nmax_concurrent = 99\n";
        let (cfg, warns, hard) =
            build_effective_layered(SparkleConfig::default(), None, None, Some(local));
        assert!(!hard);
        // THE SIDE EFFECT, not the precondition: the value did not take.
        assert_eq!(cfg.workers.max_concurrent, None, "[workers] in local.toml must not apply");
        assert!(
            warns.iter().any(|w| w.contains("[workers]") && w.contains(".sparkle/local.toml")),
            "the warning must name local.toml, the file the user has to edit: {warns:?}"
        );
        // And it must not accidentally name the tracked file, which the user would then edit in
        // vain — a remedy string is an instruction they will follow.
        assert!(
            !warns.iter().any(|w| w.contains("[workers]") && w.contains(".sparkle/config.toml")),
            "a local-layer refusal must not send the user to the tracked file: {warns:?}"
        );
    }

    #[test]
    fn every_global_only_refusal_covers_the_local_layer_too() {
        // The back door would not be `[workers]` — it would be whichever section someone forgot
        // when copying the arms. Sweep ALL of them through the local layer at once. This is what
        // makes sharing ONE body (`apply_project_layer`) load-bearing rather than tidy.
        let cases: &[(&str, &str)] = &[
            ("[workers]", "[workers]\nmax_concurrent = 99\n"),
            ("[memory]", "[memory]\nauto_kill = true\n"),
            ("[ai]", "[ai]\nauto_approve = true\n"),
            ("[tools]", "[tools]\nbuilder_index = true\n"),
            ("[roborev]", "[roborev]\nenabled = true\n"),
            ("[builder_index]", "[builder_index]\nskills_exclude = [\"x\"]\n"),
            ("[fleet]", "[fleet]\nci_budget = 99\n"),
            ("[improvement]", "[improvement]\nconsent = \"always\"\n"),
            ("[onepassword]", "[onepassword]\nvault = \"x\"\n"),
            ("[capture]", "[capture]\nshortcut = \"cmd+x\"\n"),
            ("[ui]", "[ui]\nbead_card_density = \"compact\"\n"),
            ("[publish]", "[publish]\nbase_url = \"https://evil.example\"\n"),
            ("[voice]", "[voice]\ninput_device_uid = \"x\"\n"),
            ("[concierge]", "[concierge.tools]\nquit_app = \"allow\"\n"),
            ("[pushers]", "[pushers]\nenabled = true\n"),
        ];
        for (section, toml) in cases {
            let (_, warns, hard) =
                build_effective_layered(SparkleConfig::default(), None, None, Some(toml));
            assert!(!hard, "{section} in local.toml must not be a hard error");
            assert!(
                warns.iter().any(|w| w.starts_with(section) && w.contains(".sparkle/local.toml")),
                "{section} in local.toml was not refused with a local-named warning: {warns:?}"
            );
        }
    }

    #[test]
    fn the_local_layer_cannot_widen_preview_enabled_either() {
        // `[preview].enabled` is the asymmetric one: a project may turn it OFF for itself, never
        // back ON, because it gates spawning a long-lived process whose command line comes from the
        // repo. Routing the app's writes into `local.toml` must not hand a repo that re-enable.
        let g = "[preview]\nenabled = false\n";
        let (cfg, warns, _) =
            build_effective_layered(SparkleConfig::default(), Some(g), None, Some("[preview]\nenabled = true\n"));
        assert!(!cfg.preview.enabled, "local.toml must not re-enable a globally disabled preview");
        assert!(
            warns.iter().any(|w| w.contains("[preview].enabled") && w.contains(".sparkle/local.toml")),
            "{warns:?}"
        );
        // The narrowing direction still works from local.
        let (cfg, _, _) =
            build_effective_layered(SparkleConfig::default(), None, None, Some("[preview]\nenabled = false\n"));
        assert!(!cfg.preview.enabled, "local.toml may still turn preview OFF");
    }

    // ---- shadow-unset: clearing a rule that lives in the TRACKED file (roborev 66889) ----------
    //
    // The defect these pin is the one the split created and nothing caught: `unset_project_value`
    // could only remove keys from `local.toml`, so clearing a rule that lives in the tracked
    // `.sparkle/config.toml` wrote nothing, returned success, and left the resolved value exactly
    // as it was. In THIS repo the tracked file is curated policy; in every other repo on every
    // pre-split install it is simply where these values used to be written — so the unclearable
    // case was the DEFAULT one, not an edge.
    //
    // Every assertion below is on the RESOLVED value, through the real resolver. Asserting that a
    // file was written is asserting the precondition: the whole failure was a write that happened
    // and changed nothing.

    #[test]
    fn clearing_a_rule_that_lives_only_in_the_tracked_file_changes_the_resolved_value() {
        // THE REPORTED BUG, at the smallest scale that can show it: no `local.toml` at all, the
        // rule in the tracked file, one clear.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let tracked = seed_tracked_policy(&root);
        let before = std::fs::read(&tracked).unwrap();
        assert!(!local_path(&root).exists(), "fixture: a pre-split install has no local.toml");

        // A global rule to fall BACK to, distinct from BOTH the tracked value ("full") and the
        // built-in default ("ask"), so the outcome names one layer. A fallback that happened to
        // equal the default would pass just as well against a clear that did nothing at all.
        let g = "[approvals]\nresume = \"summary\"\n";
        let resolve = |root: &str| {
            let ltext = std::fs::read_to_string(local_path(root)).ok();
            build_effective_layered(
                SparkleConfig::default(),
                Some(g),
                Some(TRACKED_POLICY),
                ltext.as_deref(),
            )
        };

        let (cfg, _, _) = resolve(&root);
        assert_eq!(
            cfg.approvals.resume.as_deref(),
            Some("full"),
            "fixture: the tracked rule applies"
        );

        unset_project_value(&root, "approvals.resume").unwrap();

        let (cfg, warns, hard) = resolve(&root);
        assert!(!hard, "the tombstone must not break the layer: {warns:?}");
        assert_eq!(
            cfg.approvals.resume.as_deref(),
            Some("summary"),
            "clearing a tracked rule must resolve past it to the global one, not report success \
             and leave the value standing"
        );

        // ...and the property the entire split exists for is intact. BYTES, not meaning: a
        // semantically-equal rewrite is still a modified tracked file, and a modified tracked file
        // is what aborts `git merge --ff-only` in the shared checkout.
        assert_eq!(
            std::fs::read(&tracked).unwrap(),
            before,
            "clearing a tracked rule must not write the tracked file"
        );

        // Everything else the tracked file says still applies — a tombstone erases ONE key, not a
        // layer. `[done]` is the sharper witness: it is repo policy nobody asked to clear.
        assert_eq!(
            cfg.done.description.as_deref(),
            Some("Merged into the remote main branch."),
            "the rest of the tracked policy must survive the erasure"
        );
    }

    #[test]
    fn clearing_a_rule_that_lives_only_in_local_toml_still_works_and_writes_no_tombstone() {
        // THE PAIRED POSITIVE. One test showing a value became absent is ambiguous — it passes for
        // an implementation that erases too much. This is the same call on the same key with the
        // rule in the OTHER layer: it must still resolve back to the layer below, and it must not
        // leave `[cleared]` behind, because there is nothing in the tracked file to shadow.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        // A tracked file that is PRESENT but silent on this key — so a tombstone written anyway
        // would be visible here, rather than the test passing because nothing was tracked at all.
        let tracked_without_the_key = "[done]\ndescription = \"Merged.\"\n";
        std::fs::create_dir_all(project_path(&root).parent().unwrap()).unwrap();
        std::fs::write(project_path(&root), tracked_without_the_key).unwrap();

        let g = "[approvals]\nresume = \"summary\"\n";
        set_project_value(&root, "approvals.resume", &serde_json::json!("full")).unwrap();
        let ltext = std::fs::read_to_string(local_path(&root)).unwrap();
        let (cfg, _, _) = build_effective_layered(
            SparkleConfig::default(),
            Some(g),
            Some(tracked_without_the_key),
            Some(&ltext),
        );
        assert_eq!(cfg.approvals.resume.as_deref(), Some("full"), "fixture: the local rule applies");

        unset_project_value(&root, "approvals.resume").unwrap();
        let ltext = std::fs::read_to_string(local_path(&root)).unwrap();
        assert!(
            !ltext.contains(CLEARED_TABLE),
            "no tombstone when the tracked file does not set the key: {ltext}"
        );
        let (cfg, _, _) = build_effective_layered(
            SparkleConfig::default(),
            Some(g),
            Some(tracked_without_the_key),
            Some(&ltext),
        );
        assert_eq!(
            cfg.approvals.resume.as_deref(),
            Some("summary"),
            "with the local override gone the global rule answers, exactly as it did pre-split — \
             not the default, which is what an over-eager tombstone would give"
        );
    }

    #[test]
    fn setting_a_value_the_tracked_file_already_sets_resolves_to_the_new_value() {
        // Layering is supposed to give this for free — local is applied after the tracked layer —
        // but "supposed to" is what the unset half also was. Pinned through the real writer and the
        // real resolver, including the awkward order: clear first, then set the SAME key, which is
        // what a user does when they change their mind. A tombstone left standing must not erase
        // the value they just chose.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let tracked = seed_tracked_policy(&root);
        let before = std::fs::read(&tracked).unwrap();

        // Tracked says `resume = "full"`; every value below is distinct from it and from the
        // default, so no assertion can be satisfied by a layer that failed to apply.
        set_project_value(&root, "approvals.resume", &serde_json::json!("summary")).unwrap();
        let ltext = std::fs::read_to_string(local_path(&root)).unwrap();
        let (cfg, _, _) =
            build_effective_layered(SparkleConfig::default(), None, Some(TRACKED_POLICY), Some(&ltext));
        assert_eq!(cfg.approvals.resume.as_deref(), Some("summary"), "the local value wins");

        unset_project_value(&root, "approvals.resume").unwrap();
        set_project_value(&root, "approvals.resume", &serde_json::json!("summary")).unwrap();
        let ltext = std::fs::read_to_string(local_path(&root)).unwrap();
        assert!(
            !ltext.contains(CLEARED_TABLE),
            "setting a key must retire its tombstone, so set/clear are inverses: {ltext}"
        );
        let (cfg, _, _) =
            build_effective_layered(SparkleConfig::default(), None, Some(TRACKED_POLICY), Some(&ltext));
        assert_eq!(
            cfg.approvals.resume.as_deref(),
            Some("summary"),
            "a value set after a clear must resolve to the value that was set"
        );
        assert_eq!(std::fs::read(&tracked).unwrap(), before, "and none of it touched the tracked file");
    }

    #[test]
    fn a_clear_with_nothing_to_clear_writes_no_file_at_all() {
        // The old early return ("no local.toml → Ok(())") was the defect, so its ONE correct
        // consequence has to be re-established deliberately rather than assumed: a repo that has
        // never had a `local.toml` must not acquire one — an empty file is a `??` entry in a
        // gitignored path today, and tomorrow it is a file someone has to explain.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::create_dir_all(project_path(&root).parent().unwrap()).unwrap();
        std::fs::write(project_path(&root), "[done]\ndescription = \"Merged.\"\n").unwrap();

        unset_project_value(&root, "approvals.bash").unwrap();
        assert!(
            !local_path(&root).exists(),
            "clearing a key neither layer sets must not create .sparkle/local.toml"
        );
    }

    #[test]
    fn a_tombstone_is_recorded_once_and_erases_only_its_own_key() {
        // Two properties one call cannot show: repeated clears (a re-render, a retry) must not grow
        // the list, and the erasure must be keyed on the exact dotted path — including a quoted
        // segment, where the writer and the reader agreeing on how to split it is the whole risk.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let tracked = "[approvals]\nbash = \"never\"\nedit = \"never\"\n\
                       [plugins]\n\"frontend-design\" = true\n";
        std::fs::create_dir_all(project_path(&root).parent().unwrap()).unwrap();
        std::fs::write(project_path(&root), tracked).unwrap();

        unset_project_value(&root, "approvals.bash").unwrap();
        unset_project_value(&root, "approvals.bash").unwrap();
        unset_project_value(&root, "plugins.\"frontend-design\"").unwrap();
        let ltext = std::fs::read_to_string(local_path(&root)).unwrap();
        assert_eq!(
            ltext.matches("approvals.bash").count(),
            1,
            "clearing twice must not append twice: {ltext}"
        );

        let (cfg, _, hard) =
            build_effective_layered(SparkleConfig::default(), None, Some(tracked), Some(&ltext));
        assert!(!hard);
        // The tracked file says "never" and the built-in default is "always", so this can only be
        // "always" if the tracked line was actually erased.
        assert_eq!(cfg.approvals.bash.as_deref(), Some("always"), "the cleared key is gone");
        assert!(
            !cfg.plugins.is_enabled("frontend-design"),
            "a quoted segment must be erased under the same name it was written with"
        );
        assert_eq!(
            cfg.approvals.edit.as_deref(),
            Some("never"),
            "its sibling in the same table must be untouched"
        );
    }

    #[test]
    fn a_cleared_block_in_the_tracked_file_is_ignored_and_says_so() {
        // `[cleared]` erases the layer BELOW it, so in the tracked file it would ask a repo to
        // erase its own keys — and, worse, would read as a way for repo policy to reach past itself
        // into the global config. It applies from `local.toml` only. A hand-written block that
        // silently does nothing is the shape this repo keeps paying for, so it warns.
        let rule = "[approvals]\nresume = \"full\"\n";
        let block = "[cleared]\nkeys = [\"approvals.resume\"]\n";
        let g = "[approvals]\nresume = \"summary\"\n";

        // The block in the TRACKED file, alongside the very rule it names.
        let tracked = format!("{block}{rule}");
        let (cfg, warns, hard) =
            build_effective_layered(SparkleConfig::default(), Some(g), Some(&tracked), None);
        assert!(!hard);
        // THE SIDE EFFECT, not the warning: nothing was erased.
        assert_eq!(
            cfg.approvals.resume.as_deref(),
            Some("full"),
            "[cleared] in the tracked file must not erase anything"
        );
        assert!(
            warns.iter().any(|w| w.starts_with("[cleared]") && w.contains(".sparkle/config.toml")),
            "and the user must be told the block is inert: {warns:?}"
        );

        // The IDENTICAL block from local.toml, against the same tracked rule, DOES erase it —
        // otherwise the assertion above would pass just as well against an implementation that
        // never reads `[cleared]` anywhere.
        let (cfg, _, _) =
            build_effective_layered(SparkleConfig::default(), Some(g), Some(rule), Some(block));
        assert_eq!(
            cfg.approvals.resume.as_deref(),
            Some("summary"),
            "the same block in local.toml must erase the tracked rule"
        );

        // AND ITS REACH STOPS THERE. A tombstone drops the key from the layer directly below it,
        // which is what "clear this project's rule" means; it is not a way for one machine to
        // delete a GLOBAL setting through a per-project file. Pinned because the strip is applied
        // to text, and applying it one layer further down would be a one-line change nothing else
        // here would notice.
        let (cfg, _, _) = build_effective_layered(SparkleConfig::default(), Some(g), None, Some(block));
        assert_eq!(
            cfg.approvals.resume.as_deref(),
            Some("summary"),
            "a per-project tombstone must not reach into the global layer"
        );
    }

    #[test]
    fn an_unparseable_tracked_file_still_warns_when_a_tombstone_is_present() {
        // The strip runs on the tracked layer's TEXT. If a syntax error made it return an empty
        // layer instead of the original, a typo in a repo's committed policy would resolve to
        // defaults with NOTHING said — the layer would vanish rather than be refused. Pinned
        // because the failure is silent and only reachable with a `[cleared]` entry present.
        let tracked = "[approvals]\nbash = \"never\"\n[[[ oops";
        let local = "[cleared]\nkeys = [\"approvals.bash\"]\n";
        let (_, warns, hard) =
            build_effective_layered(SparkleConfig::default(), None, Some(tracked), Some(local));
        assert!(hard, "a broken tracked file is still a hard error with a tombstone present");
        assert!(
            warns.iter().any(|w| w.contains("syntax error") && w.contains(".sparkle/config.toml")),
            "…and still names the tracked file: {warns:?}"
        );
    }

    #[test]
    fn clearing_refuses_an_unreadable_local_file_rather_than_reporting_a_removal() {
        // The `NotFound` split in `load_project_document`, from the side that matters here: an
        // unreadable-but-PRESENT local.toml must not be treated as absent. Treating it as absent
        // would start from an empty document and render a file holding one `[cleared]` block —
        // every local setting and locally-defined stage gone — while returning Ok.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::create_dir_all(local_path(&root).parent().unwrap()).unwrap();
        std::fs::write(local_path(&root), "[approvals]\nbash = \"always\"\n[[[ oops").unwrap();

        let err = unset_project_value(&root, "approvals.bash").unwrap_err();
        assert!(err.contains("local.toml"), "the refusal must name the file: {err}");
        assert_eq!(
            std::fs::read_to_string(local_path(&root)).unwrap(),
            "[approvals]\nbash = \"always\"\n[[[ oops",
            "and the bytes needed to repair it must survive"
        );
    }

    // ---- for_project actually READS the local layer -------------------------------------------
    //
    // Every other test in this section calls `build_effective_layered` directly or reads the
    // writers' output files. Nothing drove the production reader, which is how BOTH halves of the
    // wiring — passing `local` to the resolver, and keying the memo on the local file's stamp —
    // could be deleted with the whole suite still green. These two mount the real path.

    #[test]
    fn for_project_resolves_the_local_layer_over_the_tracked_one() {
        // Pins the CALL SITE: drop the `local` argument inside `for_project` and this goes red.
        let _guard = CONFIG_GLOBAL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // A known-empty global layer, so the assertion is about the two project files and not
        // about whatever a sibling test last loaded into the process-wide cell.
        let gdir = tempfile::tempdir().unwrap();
        let _ = reload_global(gdir.path());

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        seed_tracked_policy(&root);
        std::fs::write(local_path(&root), "[approvals]\nbash = \"always\"\n").unwrap();

        let eff = for_project(&root);
        assert_eq!(
            eff.config.approvals.bash.as_deref(),
            Some("always"),
            "for_project must apply .sparkle/local.toml over the tracked file"
        );
        // The tracked layer still reaches it — so a green here cannot mean "read local instead of".
        assert_eq!(
            eff.config.done.description.as_deref(),
            Some("Merged into the remote main branch."),
            "…without dropping the tracked layer it sits on"
        );
    }

    #[test]
    fn for_project_invalidates_its_memo_when_only_local_toml_changes() {
        // Pins the MEMO KEY: delete `e.local_mtime_ms == local_mtime_ms && e.local_len == local_len`
        // from the fast-path guard and this goes red. That guard is the difference between a UI
        // write reaching a reader and landing on disk to be ignored for the process lifetime —
        // every per-project write goes to this file, and nothing else about the project moves when
        // it does: the tracked file's stamp does not change, and neither does the global layer.
        let _guard = CONFIG_GLOBAL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let gdir = tempfile::tempdir().unwrap();
        let _ = reload_global(gdir.path());

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        seed_tracked_policy(&root);

        // Warm the memo with NO local file. (0, 0) is a valid stamp, so this is a real cache entry.
        // `resume` again: tracked "full", written "summary", cleared "ask" — three distinct values,
        // so a stale memo cannot be mistaken for a fresh read at any step.
        assert_eq!(
            for_project(&root).config.approvals.resume.as_deref(),
            Some("full"),
            "fixture: the tracked rule resolves first"
        );

        // The exact production event: a per-project write, through the real writer.
        set_project_value(&root, "approvals.resume", &serde_json::json!("summary")).unwrap();

        assert_eq!(
            for_project(&root).config.approvals.resume.as_deref(),
            Some("summary"),
            "a write to local.toml must invalidate the memo — nothing else about the project moved"
        );

        // And the clear, which is the case that has to travel the whole path: writer → tombstone →
        // strip → memo. Same call the UI makes, read back through the same reader it re-pulls with.
        unset_project_value(&root, "approvals.resume").unwrap();
        assert_eq!(
            for_project(&root).config.approvals.resume.as_deref(),
            Some("ask"),
            "…and so must a clear, or the toggle snaps back to the tracked value"
        );
    }

    #[test]
    fn every_copy_of_the_split_names_the_preview_exception() {
        // USER-FACING COPY IS CODE, and this copy was WRONG (roborev 66889, Medium). All three
        // places said the split changes nothing about the resolved settings — "same rules, same
        // refusals", "reads see both". That is false for exactly one section: `read_preview_override`
        // in preview.rs reads `[preview]`'s command/args/path/port straight off a worktree's own
        // `.sparkle/config.toml`, deliberately bypassing the merged config, because detection runs
        // against an arbitrary worktree that is not necessarily the project the config was merged
        // for. Those four keys written into `local.toml` are silently INERT.
        //
        // A refusal or a remedy is an instruction the user will follow, so copy that sends them to
        // the wrong file costs them the setting and gives them no way to find out. preview.rs's
        // behaviour is deliberate and stays; the docs stop contradicting it.
        //
        // This is a DRIFT guard, not a proof: it pins that each copy still names the exception and
        // all four keys. Reword the marker and it fails on purpose — update it, don't delete it.
        let repo_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
        let gitignore = std::fs::read_to_string(format!("{repo_root}/.gitignore"))
            .expect("the repo's .gitignore must be readable");
        let repo_policy = std::fs::read_to_string(format!("{repo_root}/.sparkle/config.toml"))
            .expect("the repo's tracked .sparkle/config.toml must be readable");

        for (what, text, marker) in [
            ("DEFAULT_TEMPLATE", DEFAULT_TEMPLATE, "THE EXCEPTION"),
            (".sparkle/config.toml", repo_policy.as_str(), "ONE SECTION IS NOT LAYERED"),
            (".gitignore", gitignore.as_str(), "EXACTLY ONE EXCEPTION"),
        ] {
            let at = text
                .find(marker)
                .unwrap_or_else(|| panic!("{what} no longer marks the [preview] exception ({marker})"));
            // Bounded to the paragraph that raises it, so the four key names cannot be satisfied by
            // unrelated prose elsewhere in a long file.
            let para = &text[at..(at + 900).min(text.len())];
            for needle in ["command", "args", "path", "port", "local.toml"] {
                assert!(
                    para.contains(needle),
                    "{what}'s [preview] exception does not name `{needle}`"
                );
            }
        }
    }

    #[test]
    fn config_lock_recovers_after_poison() {
        // Shares the lock with the unreadable-config test: this one calls `reload_global` against
        // an empty tempdir, which resets the cached layer to defaults and would otherwise land
        // between that test's load and its assertion.
        let _guard = CONFIG_GLOBAL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
    //
    // THE `sparkle-{test,self-test,accounts,bridge}-` NEEDLES ARE GONE ON PURPOSE (2026-08-12,
    // bead sparkle-60gr7) — do not "restore" them. The guard they pinned was a name allowlist, and
    // an allowlist only ever stops the harnesses someone remembered to name: with all four in
    // place the daemon still showed 2,907 failed jobs, all `chdir <temp path>: no such file or
    // directory`, from roots named `posture-*`, `.tmp*` and `tmp.*`. The hook now skips ANY repo
    // under a temp root, so the names are no longer load-bearing and asserting them would pin a
    // heuristic the hook has stopped using. What replaces them below is the machinery that
    // heuristic became: the guard function, a temp root it recognises, and the opt-in.
    #[test]
    fn vendored_roborev_post_commit_keeps_its_skip_guards() {
        let hook = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/roborev/post-commit"
        ))
        .expect("vendored resources/roborev/post-commit must exist (bundled Tauri resource)");
        for needle in [
            "pytest-of-",         // pytest fixture repos aimed OUTSIDE a temp root
            "\" post-commit",     // the ACTUAL delegation invocation `"$ROBOREV" post-commit` —
                                  // not the bare word "post-commit", which also appears in comments
            // ── Sparkle-only, and the reason a seed re-sync must fail this test ──────────────
            // CODE-SHAPED, deliberately. A bare `/var/folders/` or `ROBOREV_REVIEW_TEMP_REPOS`
            // also appears in the hook's own comments — the error message it quotes, the prose
            // explaining the opt-in — so a hook that kept the comments and lost the guard would
            // satisfy those needles and this test would pass over a hook that reviews nothing.
            // Every needle below matches only the executable line it comes from.
            // The definition AND its first body line. The bare `is_ephemeral_repo() {` is not
            // enough: the hook's own self-heal greps for the guard, so that literal also appears
            // on the heal's assertion line, and a hook that lost the function but kept the heal
            // would satisfy it. Two lines pin the definition itself.
            "is_ephemeral_repo() {\n    _p=$1",
            "/tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*", // the temp-root case arm
            "\"${ROBOREV_REVIEW_TEMP_REPOS:-}\" != \"1\"",                 // the opt-in condition
            "--git-common-dir",   // owner-repo resolution (linked-worktree blind spot)
            "heal-failed",        // the self-heal's visible-failure sentinel
        ] {
            assert!(
                hook.contains(needle),
                "vendored post-commit lost the '{needle}' guard/behavior — did the copy drift from the seed?"
            );
        }
    }
}
