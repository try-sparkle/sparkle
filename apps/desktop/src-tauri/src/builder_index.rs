//! Opt-in Builder Index (tokenmaxxing / tkmx) reporting — bead sparkle-s3g2.6.
//!
//! One consented click publishes this machine's DAILY TOKEN TOTALS to the public tokenmaxxing
//! leaderboard, whose operator has confirmed the integration is welcome. Everything here is
//! DEFAULT-OFF and triple-gated: `[tools].builder_index` must be on, the one-time consent modal
//! must have been answered "publish", and a username + API key must be stored. Miss any one of
//! those and [`report_once`] returns [`ReportOutcome::Skipped`] without opening a socket.
//!
//! WHAT LEAVES THE MACHINE (and nothing else):
//!   • one row per (calendar day, model): five token counters + an estimated cost
//!   • the username the user typed and a per-machine `client_id`
//!   • aggregate session activity: tool-call counts per CATEGORY, subagent-dispatch and plan-mode
//!     counts, and session counts — see [`SessionStats`]. Skills appear there only as a COUNT
//!     (`distinct_skills`); that blob has never carried a skill NAME and has no field for one.
//!   • this machine's hostname, OS, CPU and RAM, plus the names of the Claude Code PLUGINS
//!     installed here — see [`MachineConfig`]. Those names are read from
//!     `~/.claude/plugins/installed_plugins.json`, i.e. from what is INSTALLED. Nothing here
//!     reports which skills were INVOKED, or when: no transcript is consulted for this list, and a
//!     name the user never installed can't reach the profile (the manifest is an allowlist by
//!     construction). [`crate::config::BuilderIndexConfig::skills_exclude`] subtracts from it.
//! Apart from the hostname — which the profile's "Machines" card exists to display, and which the
//! community reporter already publishes for the same machine — there are no file paths, no project
//! or session names, no prompts, no code, no keys. The rollup below is built from
//! [`crate::spend::UsageRecord`] and structurally cannot carry them (a record's `project`/`session`
//! fields are dropped by [`rollup`], not merely omitted). The activity half is COUNTERS ONLY; it
//! never carries a tool's ARGUMENTS, so a Bash command, an edited path and a prompt cannot ride
//! along inside it either.
//!
//! WHY THE ACTIVITY HALF EXISTS. Reporting tokens natively fixed the token undercount but left the
//! profile's SUBAGENTS/SESSION, PLAN MODE and TOOL MIX panels sourced from the community indexer,
//! which showed 0.0 subagents/session and 0% plan mode for a machine running a large agent fleet.
//! Three measured causes, in order of size — the blind spot in this module's header is the SMALLEST
//! of them, so read `spend.rs`'s "session activity" header before assuming a wider scan is the fix:
//!   1. the fleet's real fan-out is an MCP tool the community metric does not count as a subagent;
//!   2. its denominator pools ~87% one-shot automation sessions with interactive ones;
//!   3. and it never saw the account stores.
//! [`rollup_activity`] fixes all three off the scan `spend.rs` already does, and OMITS any metric it
//! cannot compute completely rather than publishing a zero.
//!
//! WHY IT'S NATIVE. The community pipeline (tkmx-client + agentsview) UNDERREPORTED this machine
//! by ~84% (verified 2026-07-24: ~12.6B tokens/7d actual vs 2.03B on the profile), because
//! agentsview only indexes `~/.claude` and never sees Sparkle's per-account
//! `accounts/<id>/projects` stores. So the reporter reuses `spend.rs`'s scan — the one that
//! already walks every account store — rather than shelling out to a tool with that blind spot.
//!
//! WIRE PROTOCOL — read off github.com/srosro/tkmx-client v1.3.0 (reporter/report.ts,
//! reporter/usage.ts, reporter/merge.ts), not guessed:
//!   POST {SERVER_URL}/api/usage
//!   Authorization: Bearer <api key>          Content-Type: application/json
//!   { username, team?, client_id, client_version, report_days,
//!     data: [ { date: "YYYY-MM-DD",
//!               modelBreakdowns: [ { modelName, inputTokens, outputTokens,
//!                                    cacheCreationTokens, cacheReadTokens, totalTokens,
//!                                    cost?, source } ] } ],
//!     session_stats?: { schema_version, source, window, adoption?, tool_mix? },
//!     machine_config?: { hostname, os, cpu, memory_gb?, claude_skills? } }
//! `os` is NODE's platform token, not Rust's — `"darwin 25.6.0"`, never `"macos 25.6.0"`; see
//! [`platform_token`]. `memory_gb?` is OURS, not the reference's: its TS interface types it as a
//! required `number`, and we omit it when `hw.memsize` is unreadable rather than send a `0` that
//! claims the machine has no RAM. See the open question below — that trade is not free.
//! `machine_config` is likewise an existing field (tkmx-client reporter/report.ts's `MachineConfig`)
//! and its `claude_skills` array is what the profile's SKILLS row renders. Field names mirror that
//! interface exactly — the server reads by key, so a rename drops the value silently.
//! `session_stats` is an EXISTING field of that protocol (tkmx-client reporter/session-stats.ts
//! forwards the community indexer's blob in it verbatim), which is why the activity metrics need no
//! wire-protocol change and no coordination with the server operator. It is optional in both
//! directions: tkmx-client omits it when it cannot collect one, and so do we.
//!
//! COEXISTENCE — TWO WRITERS, LAST ONE WINS, AND WE CANNOT ARBITRATE IT. `session_stats` is replaced
//! WHOLESALE server-side, and the community launch agent (`com.token-tracking.reporter`,
//! `StartInterval` 7200) posts its own blob for the same username on this machine. So while both run,
//! the three panels alternate between two denominators every couple of hours — ours (~1.57
//! subagents/interactive session) and the community one (~0.03 over every transcript). `source` is a
//! LABEL, not a lock; nothing here can stop the overwrite. Two consequences we DO control:
//!   • the blob is a SUPERSET of the community shape, never a lossy replacement — `totals` at the
//!     top level and RFC-3339 `window.since`/`until`, so whichever writer lands last, no field the
//!     panel reads goes missing (roborev 55761);
//!   • the fix for the flapping is environmental, not code: set `REPORT_SESSION_STATS=false` for the
//!     community reporter while Sparkle reports natively. That is a change to the USER's launch
//!     agent, so this module does not make it silently — it is called out for the operator instead.
//! `machine_config` INHERITS THAT HAZARD, and we cannot fully honour the superset rule there.
//! Assume it is replaced wholesale too (it is the same server and the same shape of field), so
//! whatever Sparkle omits from it, the community reporter's last post loses:
//!   • `hostname`, `os`, `cpu` and `memory_gb` we compute, so those are a genuine superset — same
//!     keys, same meanings, same formatting.
//!     The one seam: if a fact reads as unknown we OMIT its key rather than send a placeholder, so
//!     that key is momentarily lost from the card. That is still the better trade — a placeholder
//!     (`""`, `0`) is not "unknown" on the wire, it is a wrong value that renders as fact — and it
//!     is why an unreadable HOSTNAME suppresses the whole object instead ([`build_machine_config`]).
//!   • `claude_skills` is a DELIBERATE SUBSET, and it is the one place we knowingly break the
//!     superset rule. MEASURED against tkmx-client `origin/main`, not assumed: `collectClaudeSkills`
//!     (reporter/skills.ts) unions the plugin manifest with every `~/.claude/skills/<name>/SKILL.md`
//!     directory, and `collectMachineConfig` (reporter/report.ts) then unions the configured MCP
//!     server names on top — so its list is a strict superset of ours. Sparkle publishes the PLUGIN
//!     MANIFEST ONLY: the founder's explicit choice, and the narrower one, since every name on it is
//!     backed by something the user deliberately installed.
//!     CONSEQUENCE, not hypothetical: on a machine where BOTH reporters post machine_config, the
//!     personal-skill and MCP badges appear after tkmx-client's post and vanish after Sparkle's,
//!     every couple of hours. It is bounded today — tkmx-client only builds this object when
//!     `REPORT_MACHINE_CONFIG=true`, and then only when a snapshot hash says the config CHANGED —
//!     but it is real wherever both run.
//!     THIS IS SETTLED, NOT OPEN. The founder was asked directly (2026-08-12) and chose the NARROW
//!     list: only names backed by an installed plugin. Personal `~/.claude/skills/*` directories and
//!     MCP server names are withheld deliberately — on the machine this was measured on that is 13
//!     directory names plus every MCP server name, all of which would become publicly visible in
//!     exchange for removing a flap that only occurs where the other reporter also runs. Do not
//!     reopen this as a "parity" cleanup: it is a privacy decision, and the flap is the accepted
//!     cost of it. `reporting_never_publishes_a_personal_skill_directory` is the tripwire, and it
//!     drives [`reported_skills_from`] — the function that holds `home` and is therefore where such
//!     a union would actually be written.
//!   • `codex_version` we CANNOT compute — it is tkmx-client's reading of the user's Codex install,
//!     which Sparkle does not manage. There is no carry-forward available: the POST is
//!     write-only, so the reporter cannot read the profile's current value back to re-send it.
//!     A machine running both reporters therefore alternates between having that field and not.
//!     OPEN QUESTION FOR THE SERVER OPERATOR: does `/api/usage` MERGE `machine_config` per-key
//!     rather than replacing it? If it merges, this is a non-issue and the paragraph can go. If it
//!     replaces, the fix is server-side (merge) or environmental (retire the other reporter) —
//!     inventing a value here would be worse than omitting one.
//!   • `memory_gb` we OMIT when `hw.memsize` is unreadable, and that omission is not evidenced.
//!     The reference client's TS interface types it as a required `number` (`reporter/report.ts`),
//!     and `os.totalmem()` cannot fail there, so it never has to make this choice and its shape
//!     tells us nothing about whether the server tolerates the key's ABSENCE. We chose absence over
//!     a `0` that would assert the machine has no RAM. SECOND OPEN QUESTION FOR THE SERVER OPERATOR:
//!     does `/api/usage` VALIDATE `machine_config`'s required keys? If it rejects the POST outright,
//!     that is strictly worse than a stale memory reading — the whole report dies and takes the
//!     usage rows with it, and it would be INVISIBLE today: `discard_reason` covers `rows: 0`, so a
//!     400 on a report with no rows to count carries nothing to notice. If that turns out to be the
//!     behaviour, send the last-known-good size (or drop just this key server-side), don't reinstate
//!     the zero. Until it is answered the exposure is bounded by how nearly-impossible the trigger
//!     is: `hw.memsize` is a boot-time kernel constant on the only platform this ships to.
//! [`MachineConfig`] is a plain struct with `skip_serializing_if` on every optional field, so
//! adding `codex_version` (or any later key) once it becomes computable is one field plus one
//! assignment, not a reshape.
//!
//! The server's primary key is (username, date, model, client_id, source), so `client_id` must be
//! STABLE per machine or every re-derivation double-counts the overlapping days on the profile.
//! We derive it exactly as the reference client does — sha256(machine_id | username), first 32
//! hex chars — and then PIN it in the state file so a later `ioreg` failure can't mint a second id.
//!
//! A 200 IS NOT PROOF THE REPORT LANDED — measured, not theorized (2026-08-11). This machine's
//! reporter had been posting successfully for weeks with `last_status` reading "Reported 21 row(s)
//! across 7 day(s)" while the profile read `tokens_28d: 0`. The server's actual reply:
//!   200 {"ok":true,"rows":0,
//!        "client_update":"Your tkmx-client is outdated (sparkle-desktop/0.98.0 → 1.3.0)…",
//!        "profile_frozen":true}
//! tkmx-server FREEZES a profile whose `client_version` is below its `minimum_client_version`
//! (1.2.0 at the time), keeps serving the last snapshot, and says so only in `profile_frozen` —
//! `ok` stays `true`. It parses `client_version` as bare semver: `sparkle-desktop/0.98.0` reads as
//! 0.98.0, and so does `sparkle-desktop/1.3.0` — the prefix is not understood, so NO app-version
//! bump can clear it. Both of the user's Sparkle reporters were frozen; both tkmx-client machines
//! were not.
//! [`discard_reason`] is the guard, and its PRIMARY rule is deliberately not a version check: if we
//! sent rows and the server stored none, the cycle FAILS — whatever the reason. That covers the
//! freeze, and it covers the next gate the operator invents without anyone having to hear about it.
//!
//! THE CUTOVER IS NOW MADE (2026-08-12). [`BUILDER_INDEX_PROTOCOL_VERSION`] sends the bare tkmx
//! protocol semver we implement, so the profile unfreezes; read that constant's comment for why an
//! app version — prefixed OR bare — structurally cannot clear the gate, and what identification is
//! being given up for it. The coexistence caveat above is now LIVE rather than hypothetical: both
//! reporters are writing the same profile, so `session_stats` will flap between two denominators
//! until the community launch agent is turned down, which is the user's launch agent to change and
//! not something this module does silently.
//!
//! TEAM. The leaderboard groups by team, and this module used to hardcode `"default"` into every
//! payload — so a user whose profile and tkmx-client rows all read `"Chief"` had their
//! Sparkle-native history filed under a team that does not exist. The team now comes from
//! [`BuilderIndexState::team`] (hand-edited in the state file; no UI), and when it is unset the
//! key is OMITTED ENTIRELY rather than defaulted.
//!
//! That omission is the whole point, and it took three recurrences to learn: replacing the
//! hardcode with a fallback moved the bug rather than fixing it. `team` is a field the server
//! takes as an ASSERTION — a sent value overwrites what it already holds — so a machine that was
//! never told its team was still overwriting the founder's `"Chief"` with `"default"` on every
//! two-hourly cycle, silently regrouping his leaderboard row while reporting looked perfectly
//! healthy. A machine with no team configured has nothing to assert and must say nothing.
//! This is the same rule the prose paragraph below states, applied to the one identity field that
//! was exempt from it; see `an_unset_team_is_omitted_from_the_payload_not_defaulted`.
//!
//! ONE ASSUMPTION HERE IS UNVERIFIED, AND IT IS RECORDED RATHER THAN HIDDEN (roborev 65650,
//! bead `sparkle-1zf88u`). `team` is not only a profile field: the live `GET /api/user/:username`
//! shows it stored PER USAGE ROW (`usage[].team` — 119 rows on the measured profile, split between
//! `"Chief"` and the `"default"` this change exists to stop writing). `POST /api/usage` upserts by
//! `(client_id, date)`, so for a row that does not exist yet there is no prior value to "leave
//! alone", and what the server does with an omitted `team` on an INSERT is not documented and was
//! not tested: it may inherit the profile's team, or it may file the row ungrouped.
//!
//! It was not tested because testing it means POSTing to the founder's live profile, which is
//! explicitly out of scope — a correction there is his call and is undone within two hours by the
//! reference client anyway. Note also that `live_report_roundtrip` (the only test that touches a
//! real server) is `#[ignore]` and refuses to run against production at all.
//!
//! The change is still the right one under EITHER server behaviour, which is why it ships: the
//! leaderboard groups by the PROFILE's team, and omission provably stops an unconfigured machine
//! from overwriting that — the measured bug. The worst case for the row-level field is that an
//! unconfigured machine's rows are ungrouped instead of grouped under a team that does not exist,
//! which is not worse than what it replaces. If a row-level regression does appear, the narrower
//! fix is to keep sending a CONFIGURED team (already the behaviour) and revisit only the
//! unconfigured case — not to restore the default.
//!
//! Profile prose (`tools`, `projects`, `communities`, `about`, `hn_username`, `demo_video_url`)
//! is deliberately NOT sent. The reference client posts those from its `.env` on every run, so a
//! Sparkle report that included them as empty strings could blank a profile the user filled in
//! elsewhere. Omitting the keys leaves whatever the server already holds untouched.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::spend::UsageRecord;

/// tkmx's reporting API host. Matches `SERVER_URL`'s default in tkmx-client's reporter/report.ts
/// (the human-facing Builder Index lives at watchmepivot.com, which is NOT the API host —
/// posting there would 404). Overridable for dev via `TKMX_SERVER_URL`.
pub const DEFAULT_SERVER_URL: &str = "https://tokenmaxxing.odio.dev";

/// The `source` discriminator on every row we post. Part of the server's primary key, so it must
/// match what the reference client reports Claude Code usage under ("claude") or the same day's
/// tokens would land in a second, parallel row instead of merging.
const SOURCE: &str = "claude";

/// The tkmx WIRE PROTOCOL version this module implements — **deliberately NOT Sparkle's app
/// version**, and it must never be wired to one.
///
/// tkmx-server parses `client_version` as BARE SEMVER and FREEZES any profile below its
/// `minimum_client_version` (1.2.0 as of 2026-08-12, readable at `GET /api/user/<username>`). Two
/// consequences that make an app version structurally unusable here:
///   • a PREFIXED value is not understood by that parser, so `sparkle-desktop/1.3.0` reads exactly
///     like `sparkle-desktop/0.98.0` and both stay frozen — measured, both directions;
///   • Sparkle's own `CARGO_PKG_VERSION` is 0.101.0, which is BELOW 1.2.0 as bare semver, so
///     stripping the prefix alone does not unfreeze either, and NO app-version bump ever can. The
///     app would have to reach 1.2.0 on its own release track to clear a gate it has no part in.
/// So this tracks the tkmx-client release whose protocol we implement (v1.3.0 — see the module
/// header's wire-protocol note), and it moves only when the server's minimum does.
///
/// THE COST WE ARE ACCEPTING: the `sparkle-desktop/` prefix existed so the operator could tell
/// Sparkle-native reports apart from tkmx-client's by this field alone. That identification is
/// gone. Functioning reporting was chosen over it — a profile frozen at `tokens_28d: 0` identifies
/// nothing. `source` and the pinned `client_id` still distinguish the rows themselves; if the
/// operator wants the client named again, that needs a server-side field the parser does not
/// semver-parse, not a value smuggled into this one.
const BUILDER_INDEX_PROTOCOL_VERSION: &str = "1.3.0";

/// The bare semver we send as `client_version`. See [`BUILDER_INDEX_PROTOCOL_VERSION`] for why it
/// carries a protocol version and not the app's.
fn client_version() -> String {
    BUILDER_INDEX_PROTOCOL_VERSION.to_string()
}

// NOTE: there is deliberately NO `DEFAULT_TEAM` constant any more. The reference client defaults
// to "default" when its own team is unset; Sparkle must NOT, because sending that value overwrites
// a team the server already holds. An unset team is OMITTED — see [`BuilderIndexState::team`] and
// the TEAM paragraph in the module header. Do not reintroduce a fallback constant here: a constant
// naming a default is how the fallback got written back in after the first fix.

/// Keychain ACCOUNT for the tkmx API key. A distinct account under Sparkle's existing keychain
/// service — never the desktop-token or trial-device-token item. Read in-process via `keyring`
/// (like auth.rs / trial_remote.rs); the key never enters JS, a log line, or the payload.
const KEYCHAIN_USER: &str = "builder-index-api-key";

/// Default trailing window per report. Short on purpose: the server MERGES `data` rows by date,
/// so a small window is safe and cheap, and 7 days re-states the recent past on every cycle
/// (self-healing after an offline stretch) without re-uploading a month each time.
pub const DEFAULT_REPORT_DAYS: u32 = 7;
/// Cap on the caller-supplied window — a first sync may want more history, but not unbounded.
const MAX_REPORT_DAYS: u32 = 90;

/// Reporting cadence. Matches the community launchd reporter's 2h so a user running both doesn't
/// see wildly different freshness.
const REPORT_INTERVAL: Duration = Duration::from_secs(2 * 60 * 60);
/// Delay before the FIRST cycle. Startup must never wait on a transcript scan or a socket.
const FIRST_REPORT_DELAY: Duration = Duration::from_secs(5 * 60);
/// Bound the POST so an unreachable server can't park a blocking thread indefinitely (ureq has no
/// default request timeout — same reasoning as trial_remote.rs).
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// Spread of the per-cycle jitter, in seconds. Every Sparkle install waking on the same 2h
/// boundary would hand the leaderboard a synchronized thundering herd.
const JITTER_SPREAD_SECS: u64 = 15 * 60;

// ── persisted state ─────────────────────────────────────────────────────────────────────────

/// Everything the reporter remembers between launches EXCEPT the API key (keychain) and the
/// on/off switch (`[tools].builder_index` in config.toml).
///
/// Lives in its own JSON file rather than config.toml so the feature adds exactly ONE key to the
/// shared `[tools]` table — and so a hand-edited config can never silently un-consent or re-point
/// someone's `client_id`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct BuilderIndexState {
    /// The tokenmaxxing username reports are attributed to. Empty = not configured.
    pub username: String,
    /// Per-machine id, pinned on first successful derivation. See the module note on why it must
    /// never change for a given (machine, username).
    pub client_id: String,
    /// Epoch seconds the user answered the consent modal with "publish". `None` = never consented,
    /// which blocks reporting even if the toggle is somehow on.
    pub consented_at: Option<i64>,
    /// Epoch seconds of the last SUCCESSFUL post.
    pub last_report_at: Option<i64>,
    /// One-line outcome of the last cycle, surfaced under the Tools row. Never contains the key.
    pub last_status: Option<String>,
    /// Trailing window per report. 0 / absent means [`DEFAULT_REPORT_DAYS`].
    pub report_days: u32,
    /// The tkmx team reports are filed under. Empty / absent means SEND NOTHING — never a default.
    ///
    /// The leaderboard GROUPS BY team, so reporting under the wrong one files a machine's history
    /// beside nobody — this user's tkmx-client rows and profile are all `"Chief"`, and Sparkle was
    /// hardcoding `"default"`, a team that does not exist for them. There is deliberately NO UI:
    /// the value is set by editing this file, so a mis-typed team can't be produced by a stray
    /// click.
    ///
    /// An empty value is NOT "the user has no team, send the generic one" — it is "this machine
    /// was never told", and those are different claims. Only the second is true, and the server
    /// cannot tell them apart because a sent `team` overwrites whatever it holds. So unset means
    /// omitted; see [`BuilderIndexState::team`].
    ///
    /// The struct-level `#[serde(default)]` above is what lets a state file written before this
    /// field existed keep deserializing (it supplies `String::default()` for every absent key), so
    /// no per-field attribute is needed — see `state_written_before_the_team_field_still_loads`.
    pub team: String,
}

impl BuilderIndexState {
    fn window(&self) -> u32 {
        match self.report_days {
            0 => DEFAULT_REPORT_DAYS,
            n => n.clamp(1, MAX_REPORT_DAYS),
        }
    }

    /// The team this machine reports under, or `None` when it was never configured.
    ///
    /// `None` means the `team` key is OMITTED from the payload — not sent as a default. See the
    /// field doc above and the module header's TEAM paragraph for why a default is actively
    /// harmful here rather than merely imprecise.
    ///
    /// Trimmed the way `username` is at the payload boundary — a hand-edited JSON file is the only
    /// way this gets set, and `"Chief "` and `"Chief"` are different groups to the server.
    fn team(&self) -> Option<&str> {
        match self.team.trim() {
            "" => None,
            t => Some(t),
        }
    }
}

/// `<app_data>/builder-index.json`.
fn state_path(app_data: &Path) -> PathBuf {
    app_data.join("builder-index.json")
}

/// Serializes every read-modify-write of the state file.
///
/// Re-reading before a write narrows the window but does not close it: two cycles (the loop tick
/// and a "Report now") that both find an empty `client_id` can still both derive and both write,
/// and they disagree whenever exactly one `read_machine_id()` falls back to a random id — the
/// double-count failure the module header warns about. Holding this across the read AND the write
/// makes the sequence atomic within the process. (roborev 48167)
///
/// Process-wide, not per-path: there is exactly one app-data dir per process, and a global lock
/// held for two syscalls costs nothing.
fn state_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    // Poison-tolerant: a panic while holding it must not permanently wedge the reporter.
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Read the state file. A missing or unreadable/corrupt file degrades to the default (not
/// configured, not consented) — the fail-safe direction: we stop reporting, we never start.
pub fn load_state(app_data: &Path) -> BuilderIndexState {
    std::fs::read_to_string(state_path(app_data))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_state(app_data: &Path, state: &BuilderIndexState) -> Result<(), String> {
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(state_path(app_data), text).map_err(|e| e.to_string())
}

// ── consent gate (pure) ─────────────────────────────────────────────────────────────────────

/// Why a cycle didn't post. Every variant is a REASON, not an error: a disabled or unconfigured
/// install is the normal state, and the loop keeps ticking quietly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// `[tools].builder_index` is off (the default).
    Disabled,
    /// The one-time consent modal has not been answered with "publish".
    NoConsent,
    /// No username stored.
    NoUsername,
    /// No API key in the keychain.
    NoApiKey,
    /// A key IS stored but can't be used as a header value (an old build, or another writer of the
    /// same item, stored one with an interior newline). Distinct from `NoApiKey` because "you
    /// haven't set one" and "the one you set is broken" need different fixes. (roborev 48168/48167)
    BadApiKey,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            SkipReason::Disabled => "Builder Index is off",
            SkipReason::NoConsent => "waiting for consent",
            SkipReason::NoUsername => "no tokenmaxxing username set",
            SkipReason::NoApiKey => "no API key set",
            SkipReason::BadApiKey => "the stored API key is unusable — re-enter it",
        }
    }
}

/// The whole gate, as a pure function of the four inputs, so "off means off" is a unit test
/// rather than a claim about control flow buried in an async loop.
///
/// Order matters for the message the UI shows: the toggle is reported first, because an install
/// that never opted in should say so rather than nag for credentials it will never use.
pub fn consent_gate(
    enabled: bool,
    consented: bool,
    has_username: bool,
    has_api_key: bool,
) -> Result<(), SkipReason> {
    if !enabled {
        return Err(SkipReason::Disabled);
    }
    if !consented {
        return Err(SkipReason::NoConsent);
    }
    if !has_username {
        return Err(SkipReason::NoUsername);
    }
    if !has_api_key {
        return Err(SkipReason::NoApiKey);
    }
    Ok(())
}

/// The part of [`consent_gate`] that can be evaluated WITHOUT touching the keychain, so
/// `report_once_sync` can answer "off" / "no consent" / "no username" for free and only pay (and
/// risk a macOS auth prompt) for the key read once everything else has passed.
///
/// Delegates to [`consent_gate`] with `has_api_key = true` rather than restating the precedence.
/// Two copies of the ordering would let the modal's `blockedBy` message and the reason the loop
/// actually skipped drift apart silently. (roborev 48168/48167)
fn pre_key_gate(enabled: bool, state: &BuilderIndexState) -> Result<(), SkipReason> {
    consent_gate(
        enabled,
        state.consented_at.is_some(),
        !state.username.trim().is_empty(),
        true,
    )
}

// ── client id ───────────────────────────────────────────────────────────────────────────────

/// sha256(`machine_id` + "|" + `username`), first 32 hex chars — byte-for-byte the reference
/// client's `deriveClientId`, so a user migrating off tkmx-client keeps the same machine identity
/// and their existing rows keep merging instead of doubling.
pub fn derive_client_id(machine_id: &str, username: &str) -> String {
    let mut h = Sha256::new();
    h.update(machine_id.as_bytes());
    h.update(b"|");
    h.update(username.as_bytes());
    let digest = h.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..32].to_string()
}

/// This machine's stable hardware id, using the same source per OS as the reference client:
/// `IOPlatformUUID` on macOS, `/etc/machine-id` on Linux, `MachineGuid` on Windows.
/// `None` when it can't be read — the caller then falls back to a random id and PINS it.
fn read_machine_id() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        return extract_io_platform_uuid(&text);
    }
    #[cfg(target_os = "linux")]
    {
        for p in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(id) = std::fs::read_to_string(p) {
                let id = id.trim().to_string();
                if !id.is_empty() {
                    return Some(id);
                }
            }
        }
        return None;
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        return extract_machine_guid(&text);
    }
    #[allow(unreachable_code)]
    None
}

/// Pull `IOPlatformUUID` out of `ioreg -rd1 -c IOPlatformExpertDevice` output. Split out from the
/// shell-out so the parse is testable without a Mac in the loop.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn extract_io_platform_uuid(ioreg_output: &str) -> Option<String> {
    for line in ioreg_output.lines() {
        // Per-line `continue`, never `?`: an early return on the first non-matching line would
        // make this find the UUID only when it happens to be the very first line of output.
        let Some(rest) = line.trim().strip_prefix("\"IOPlatformUUID\"") else { continue };
        // `"IOPlatformUUID" = "ABCD-..."` — take what's between the quotes after the `=`.
        let Some(eq) = rest.find('=') else { continue };
        let after = rest[eq + 1..].trim();
        let Some(inner) = after.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
            continue;
        };
        if !inner.is_empty() {
            return Some(inner.to_string());
        }
    }
    None
}

/// Pull `MachineGuid` out of `reg query …\Cryptography /v MachineGuid` output.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn extract_machine_guid(reg_output: &str) -> Option<String> {
    for line in reg_output.lines() {
        let mut parts = line.split_whitespace();
        if parts.next() != Some("MachineGuid") {
            continue;
        }
        if parts.next() != Some("REG_SZ") {
            continue;
        }
        if let Some(v) = parts.next() {
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// The pinned `client_id` for `username`, deriving + persisting one on first use.
///
/// Pinning is the point: the server keys rows on it, so re-deriving after a failed `ioreg` (which
/// would fall back to a random id) is exactly the double-counting failure the reference client's
/// `.env` warning is about.
fn ensure_client_id(app_data: &Path, state: &mut BuilderIndexState) -> String {
    if !state.client_id.is_empty() {
        return state.client_id.clone();
    }
    // Read AND write under the lock: re-reading alone only narrows the race (two cycles can both
    // see an empty pin, both derive, and disagree if exactly one read_machine_id() falls back to
    // random). (roborev 47460/48167)
    let _guard = state_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut fresh = load_state(app_data);
    if !fresh.client_id.is_empty() {
        state.client_id = fresh.client_id;
        return state.client_id.clone();
    }
    // Derive from the FRESH username, not the caller's snapshot. `builder_index_set_identity`
    // clears client_id on a rename precisely so the next cycle re-derives under the new name; an
    // in-flight cycle deriving from its stale username would pin sha256(machine|"old") next to
    // `username: "renamed"` — permanently attaching this machine's rows to the wrong profile,
    // which is the exact failure the clear-on-rename exists to prevent. (roborev 48168/48167)
    if !fresh.username.trim().is_empty() {
        state.username = fresh.username.clone();
    }
    let machine_id = read_machine_id().unwrap_or_else(random_machine_fallback);
    state.client_id = derive_client_id(&machine_id, state.username.trim());
    fresh.client_id = state.client_id.clone();
    let _ = save_state(app_data, &fresh);
    state.client_id.clone()
}

/// A one-shot random stand-in when the OS machine id is unreadable. Only ever used once, because
/// the derived id is pinned immediately afterwards.
fn random_machine_fallback() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

// ── wire payload ────────────────────────────────────────────────────────────────────────────

/// One (day, model) row. Field names are the EXACT camelCase keys tkmx-server reads — see
/// `ModelBreakdown` in tkmx-client's reporter/usage.ts. Renaming any of these silently drops the
/// counter server-side (the server reads by key; an unknown key is ignored, not rejected).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModelBreakdown {
    #[serde(rename = "modelName")]
    pub model_name: String,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "cacheCreationTokens")]
    pub cache_creation_tokens: u64,
    #[serde(rename = "cacheReadTokens")]
    pub cache_read_tokens: u64,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
    /// Estimated list-rate USD. OMITTED (not zero) for a model with no published price — a zero
    /// would read as "this was free" on the leaderboard rather than "we don't know".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    /// Part of the server's primary key; always [`SOURCE`].
    pub source: String,
}

/// One calendar day's rows.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DailyUsage {
    /// `YYYY-MM-DD`, UTC.
    pub date: String,
    #[serde(rename = "modelBreakdowns")]
    pub model_breakdowns: Vec<ModelBreakdown>,
}

/// The POST body. See the module header for the full contract.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReportBody {
    pub username: String,
    /// The team this row is filed under. OMITTED — never sent as `"default"` — when this machine
    /// has no team configured, because the server treats a sent value as an assertion and would
    /// overwrite a team it already holds. See [`BuilderIndexState::team`] and the module header.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    pub client_id: String,
    pub client_version: String,
    pub report_days: u32,
    pub data: Vec<DailyUsage>,
    /// The SUBAGENTS/SESSION, PLAN MODE and TOOL MIX panels. OMITTED — never sent as zeroes —
    /// whenever the scan cannot support them; see [`rollup_activity`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_stats: Option<SessionStats>,
    /// The "Machines" card and the SKILLS row. OMITTED when we learned nothing worth publishing;
    /// see [`build_machine_config`] and the module header's coexistence note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_config: Option<MachineConfig>,
}

/// This machine's identity + its installed feature list, as the profile renders them.
///
/// Field names mirror tkmx-client's `MachineConfig` interface (reporter/report.ts) EXACTLY, for the
/// reason on [`ModelBreakdown`]: the server reads by key, so a renamed key is dropped silently
/// rather than rejected — the field would simply never appear on the profile and nothing would say
/// why.
///
/// `hostname`, `os` and `cpu` are always present and always non-empty — [`build_machine_config`]
/// refuses to build the struct at all unless the hostname read succeeded, and the other two are
/// derived from it or from a compile-time constant. `memory_gb` and `claude_skills` are omitted
/// when unknown.
///
/// NOTHING HERE IS EVER A PLACEHOLDER. The reference client's `cpu: ""` is a transient INITIALIZER
/// that its very next lines overwrite whenever `os.cpus()` is non-empty; its `hostname` and
/// `memory_gb` come from `os.hostname()`/`os.totalmem()`, which do not return blanks. So an empty
/// string here would not be "matching the reference client" — it would be a value neither reporter
/// ever sends, and `memory_gb: 0` would be a positive false claim that this machine has no RAM.
/// Since the server REPLACES `machine_config` wholesale, such a write degrades a correct "Machines"
/// card rather than merely failing to improve it. Omit instead: see [`build_machine_config`].
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MachineConfig {
    pub hostname: String,
    /// `"<platform> <release>"`, e.g. `"darwin 25.6.0"` — matching the reference client's
    /// `os.platform() + " " + os.release()` so the two writers don't render this card differently.
    /// The platform half is NODE's token, which is not Rust's: see [`platform_token`], and do not
    /// "simplify" it back to `std::env::consts::OS`, which spells it `macos` and makes the card flap.
    pub os: String,
    /// `"<brand> (<n> cores)"`, e.g. `"Apple M3 Max (16 cores)"`.
    pub cpu: String,
    /// Whole gigabytes, base-10 like the reference client's `Math.round(os.totalmem() / 1e9)`.
    /// OMITTED rather than sent as `0` when the read fails — `0` is not "unknown", it is a claim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_gb: Option<u64>,
    /// The profile's SKILLS row. `None` OMITS the key, leaving whatever the server already holds;
    /// `Some(vec![])` deliberately CLEARS the row (see [`collect_claude_skills`] for why the two
    /// must not be collapsed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_skills: Option<Vec<String>>,
}

/// The window a [`SessionStats`] blob describes, so a reader never has to infer it.
///
/// `since`/`until` are RFC-3339, matching the community blob's shape rather than this module's
/// `YYYY-MM-DD` day labels. The server REPLACES `session_stats` wholesale, so a Sparkle post that
/// dropped or re-typed a field the community blob carries would be a LOSSY replacement of it — the
/// panel would lose data every time we won the race. Superset, not substitute. (roborev 55761)
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StatsWindow {
    pub days: u32,
    /// Start of the first day in the window, UTC.
    pub since: String,
    /// End of the last day in the window, UTC.
    pub until: String,
}

/// Session counts, at the blob's TOP LEVEL rather than inside [`Adoption`].
///
/// Deliberately not nested under `adoption`: that field is dropped when there is no interactive
/// session, and tkmx-client reads `ss.totals?.sessions_all` (reporter/report.ts) independently of
/// any rate. Nesting the counts would make them vanish exactly when someone is asking "did this
/// machine do anything at all?". (roborev 55761)
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StatsTotals {
    pub sessions_all: u64,
    /// Sessions a person drove — the denominator behind [`Adoption`]'s rates.
    pub sessions_human: u64,
    /// One-shot programmatic invocations (roborev reviews, hook probes, naming calls).
    pub sessions_automation: u64,
}

/// Per-session adoption rates.
///
/// The rates come with their own numerators and denominators. That is not redundancy: a bare
/// `0.031` is precisely the number nobody on this machine could explain, and the counts are what
/// let a reader (or a future agent) audit it instead of re-deriving it from scratch.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Adoption {
    pub subagents_per_session: f64,
    pub plan_mode_rate: f64,
    pub distinct_skills: u64,
    /// Which population the two rates are over. Spelled out because it is NOT the community
    /// indexer's denominator — see [`rollup_activity`].
    pub denominator: &'static str,
    pub sessions_interactive: u64,
    pub sessions_total: u64,
    pub subagent_dispatches: u64,
    pub plan_mode_sessions: u64,
}

/// Tool calls by category. Category names mirror the community indexer's so the panel renders.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ToolMix {
    pub by_category: std::collections::BTreeMap<String, u64>,
    pub total_calls: u64,
}

/// The `session_stats` blob — the field tkmx-server already reads for these three panels.
///
/// Sparkle sends it in the EXISTING protocol slot rather than inventing new top-level keys, so
/// nothing here needs the server operator to ship a change first.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SessionStats {
    /// Matches the community blob's version so the server parses this as the shape it knows.
    pub schema_version: u32,
    /// Tells the operator these numbers came from Sparkle's all-accounts scan, not from
    /// `agentsview`. Without it a corrected rate is indistinguishable from a miscomputed one.
    ///
    /// NOTE it does NOT arbitrate the write. See the module header's coexistence warning: `source`
    /// is a label, not a lock.
    pub source: &'static str,
    pub window: StatsWindow,
    /// Always present — see [`StatsTotals`] for why it is not nested under `adoption`.
    pub totals: StatsTotals,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adoption: Option<Adoption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_mix: Option<ToolMix>,
}

/// What [`SessionStats::source`] carries.
const STATS_SOURCE: &str = "-accounts";

/// The denominator label. `interactive_sessions` = transcripts with ≥2 typed user turns; see
/// `spend::FileActivity::is_interactive` for why that threshold and what it measured.
const STATS_DENOMINATOR: &str = "interactive_sessions";

// ── machine config + the SKILLS row ──────────────────────────────────────────────────────────

/// The manifest the REPORTER reads — `~/.claude/plugins/installed_plugins.json`, unconditionally.
///
/// DIVERGENCE 1 FROM [`crate::hooks`], and it is deliberate: `hooks::claude_plugins_dir` honours
/// `CLAUDE_CONFIG_DIR`, because the install-skip decision has to look wherever the
/// `claude plugin install` child it spawned actually wrote. REPORTING is a different question. The
/// community tkmx-client reporter reads this fixed path (`reporter/skills.ts`'s `DEFAULT_MANIFEST`
/// is `path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json")`), the server
/// REPLACES `claude_skills` wholesale, and both reporters post for the same profile every couple of
/// hours — so if Sparkle read a per-account config dir while tkmx-client read `~/.claude`, the
/// profile's SKILLS row would flap between two different lists forever. Agreeing on the path is
/// what makes the two writers idempotent with respect to each other.
fn reporting_manifest_path(home: &Path) -> PathBuf {
    home.join(".claude").join("plugins").join("installed_plugins.json")
}

/// tkmx-client's `pluginKey.split("@")[0]`: `warp@claude-code-warp` → `warp`.
fn plugin_display_name(id: &str) -> &str {
    id.split('@').next().unwrap_or(id)
}

/// The names for the profile's SKILLS row, read from the installed-plugin manifest at `manifest`.
///
/// `None` vs `Some(vec![])` is the whole contract, and collapsing them would be a data-loss bug:
///   • `None` — we could not look (no manifest, unreadable, or a shape we don't recognize). The
///     caller OMITS `claude_skills`, so the server keeps whatever it already has. A transient read
///     failure must never blank a profile.
///   • `Some(vec![])` — we looked, and this machine has no installed plugins (or the user excluded
///     all of them). The empty array is SENT, which clears the row. That is the only way a denylist
///     can remove the last badge, so it has to stay reachable.
///
/// DIVERGENCE 2 FROM [`crate::hooks`]: `observe_installed_plugins` UNIONS this manifest with a
/// `cache/<marketplace>/<plugin>/` directory scan. That union is right for its caller — for an
/// install-skip decision, over-reporting what's present costs at worst a skipped reinstall — but it
/// is wrong here: the cache holds `temp_git_*` clones and entries a user believes they uninstalled,
/// none of which is evidence that a plugin is installed NOW. The manifest is Claude Code's own
/// record, and reading only it is what makes this list an ALLOWLIST rather than a scrape. Manifest
/// only, no union — and do not "unify" these two readers on the strength of them sharing a parser.
///
/// WHAT THIS IS *NOT*: parity with the community reporter. An earlier version of this comment said
/// "tkmx-client reports the manifest only", and that is FALSE — MEASURED on its `origin/main`,
/// `collectClaudeSkills` (reporter/skills.ts) unions the manifest with every
/// `~/.claude/skills/<name>/SKILL.md` directory, and `collectMachineConfig` (reporter/report.ts)
/// unions the configured MCP server names after that. Its list is a strict SUPERSET of this one.
/// Sparkle is narrower ON PURPOSE — see the module header for what that costs and why widening it
/// is the user's call rather than a refactor.
///
/// The fixed `~/.claude` path above is a separate matter and still exactly right: where the two
/// reporters read the SAME source, they must read it from the same place.
fn collect_claude_skills(manifest: &Path) -> Option<Vec<String>> {
    let ids = crate::hooks::read_installed_plugin_ids(manifest)?;
    // Dedupe case-insensitively keeping the first spelling seen, then sort — tkmx-client's
    // `dedupeSkills`. Two plugins of the same name from different marketplaces collapse to one
    // badge, which is what the profile renders anyway.
    let mut out: Vec<String> = Vec::new();
    for name in ids.iter().map(|id| plugin_display_name(id)) {
        let Some(key) = crate::config::normalize_skill_name(name) else { continue };
        if !out.iter().any(|kept| crate::config::normalize_skill_name(kept) == Some(key.clone())) {
            out.push(name.to_string());
        }
    }
    out.sort();
    Some(out)
}

/// Drop the names the user asked us not to publish.
///
/// `exclude` arrives already normalized from [`crate::config::BuilderIndexConfig::skills_exclude`];
/// the candidate is normalized here through the SAME function, which is what makes the comparison
/// case-insensitive and whitespace-insensitive on both sides. That is tkmx-client's
/// `applyExclusions` semantics exactly, and the two reporters have to agree — see that config
/// field's doc for what disagreeing costs.
///
/// Applied LAST, after collection, so an entry catches a name however it was spelled in the
/// manifest.
fn apply_skill_exclusions(names: Vec<String>, exclude: &[String]) -> Vec<String> {
    if exclude.is_empty() {
        return names;
    }
    names
        .into_iter()
        .filter(|n| match crate::config::normalize_skill_name(n) {
            Some(key) => !exclude.iter().any(|e| *e == key),
            // An unnameable entry can't be matched by a denylist, so it can't be withheld either.
            None => true,
        })
        .collect()
}

/// The SKILLS row this machine should publish right now: collect from the manifest, then subtract
/// the configured denylist.
///
/// The impure seam — it locates `$HOME` and reads the live config — reduced to exactly those two
/// LOOKUPS, with every decision that composes the list living in [`reported_skills_from`] below.
/// `None` propagates: an unreadable manifest omits the field rather than clearing the profile, and
/// the denylist has nothing to subtract from.
fn reported_skills() -> Option<Vec<String>> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)?;
    let exclude = crate::config::current_effective().config.builder_index.skills_exclude;
    reported_skills_from(&home, &exclude)
}

/// [`reported_skills`] with its two impure inputs handed in: the home directory to read under, and
/// the already-normalized denylist.
///
/// THE SPLIT EXISTS TO MAKE THE WIDENING SITE TESTABLE, which is a narrower claim than "for
/// tidiness" and the reason it must not be inlined back. Composing the list inside `reported_skills`
/// put it behind a `std::env::var_os` read and a `config::current_effective()` call, so no test
/// could drive it — and this is the ONE function that holds `home`, which makes it the natural place
/// to add a `~/.claude/skills/*` union (the community reporter's shape). A union added there used to
/// compile clean, publish personal skill names on the wire, and leave
/// `reporting_never_publishes_a_personal_skill_directory` green, because that test drove
/// [`collect_claude_skills`] — which only ever receives the MANIFEST PATH and so could not have
/// grown the union in the first place. The tripwire now drives this function instead.
fn reported_skills_from(home: &Path, exclude: &[String]) -> Option<Vec<String>> {
    let names = collect_claude_skills(&reporting_manifest_path(home))?;
    Some(apply_skill_exclusions(names, exclude))
}

/// The machine facts, gathered impurely once so [`build_machine_config`] stays pure and testable.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HostFacts {
    pub hostname: Option<String>,
    /// Kernel release, e.g. `25.6.0` — the second half of the reference client's `os` string.
    pub os_release: Option<String>,
    pub cpu_brand: Option<String>,
    pub cores: Option<u32>,
    pub memory_bytes: Option<u64>,
}

/// Assemble the wire struct, or `None` to omit the key entirely.
///
/// THE HOSTNAME IS THE RECORD'S IDENTITY, so its absence — not the absence of everything — is what
/// makes this `None`. The "Machines" card is per-machine and the server REPLACES `machine_config`
/// wholesale, so a post that cannot name its machine cannot improve the card; it can only overwrite
/// a correct one with an unattributable blank. Staying silent leaves whatever the community
/// reporter published for this machine intact, which is the strictly safer degradation.
///
/// The cost of that choice is real and deliberate: a machine whose hostname read fails publishes no
/// skills either, so its denylist stops taking effect. That is accepted because the alternative is
/// destructive rather than merely inert, and because the read is a kernel constant (`kern.hostname`)
/// whose failure means something far more broken than this field.
///
/// Given a hostname, the other three are total: `os` is [`platform_token`] plus an optional release,
/// and `cpu` falls back to the hostname exactly as the reference client does — so neither can come
/// out blank. Only `memory_gb` can be genuinely unknown, and it is OMITTED rather than zeroed.
/// Nothing here is ever a placeholder; see [`MachineConfig`].
///
/// "Cannot come out blank" is a claim about EMPTINESS only, and is not a claim that either string is
/// correct — `os` shipped a well-formed wrong value (Rust's `macos` for Node's `darwin`) for two
/// commits under exactly this reasoning. Non-empty is the cheap property; agreeing with the other
/// writer is the one that matters, and only a test pinned to a LITERAL can hold it.
///
/// Never `Some` with an empty `claude_skills` derived from a FAILED read: that distinction is made
/// upstream in [`collect_claude_skills`] and simply carried here.
fn build_machine_config(facts: &HostFacts, claude_skills: Option<Vec<String>>) -> Option<MachineConfig> {
    let hostname = facts.hostname.clone()?;
    // The reference client falls back to the hostname when the CPU model reads as unknown, so the
    // "Machines" card can still tell two machines apart. Same fallback here.
    let brand = facts
        .cpu_brand
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty() && !b.eq_ignore_ascii_case("unknown"))
        .unwrap_or(hostname.as_str());
    let cpu = match facts.cores {
        Some(n) => format!("{brand} ({n} cores)"),
        None => brand.to_string(),
    };
    Some(MachineConfig {
        hostname,
        os: match facts.os_release.as_deref() {
            Some(r) => format!("{} {r}", platform_token()),
            None => platform_token().to_string(),
        },
        cpu,
        // Base-10 GB and rounded, matching `Math.round(os.totalmem() / 1e9)`.
        memory_gb: facts.memory_bytes.map(|b| (b as f64 / 1e9).round() as u64),
        claude_skills,
    })
}

/// The platform token the reference client's `os` field carries, which is NODE's spelling and not
/// Rust's.
///
/// MEASURED, not assumed (`node -e 'console.log(os.platform())'` on this machine prints `darwin`,
/// while `std::env::consts::OS` is `macos`). Emitting Rust's spelling made the "Machines" card's OS
/// field alternate between `"darwin 25.6.0"` and `"macos 25.6.0"` every couple of hours on any
/// machine running both reporters — the same wholesale-replace flap the fixed manifest path and the
/// `cpu` formatting already exist to prevent, just on the one field nobody re-checked.
///
/// Only the two names that actually differ are mapped; Node and Rust agree on `linux` and on the
/// BSDs, so anything else passes through rather than being silently renamed.
fn platform_token() -> &'static str {
    platform_token_for(std::env::consts::OS)
}

/// The mapping itself, split out as a pure function OVER ITS INPUT so the table can be tested.
///
/// `platform_token` reads a compile-time constant, so a test calling it can only ever exercise the
/// one arm matching the host it runs on — the other arms are structurally unreachable, and an
/// assertion written against it has nothing to compare to but the function's own output. Taking the
/// os string as an argument is what makes every arm reachable from every host and lets the test pin
/// literals on both sides.
fn platform_token_for(os: &str) -> &str {
    match os {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Read the machine facts. Memoized — every one of these is fixed hardware or a boot-time constant,
/// and the reporter runs on a loop.
fn host_facts() -> HostFacts {
    static FACTS: std::sync::OnceLock<HostFacts> = std::sync::OnceLock::new();
    FACTS
        .get_or_init(|| HostFacts {
            hostname: sysctl_string("kern.hostname"),
            os_release: sysctl_string("kern.osrelease"),
            cpu_brand: sysctl_string("machdep.cpu.brand_string"),
            cores: std::thread::available_parallelism().ok().map(|n| n.get() as u32),
            memory_bytes: sysctl_string("hw.memsize").and_then(|s| s.parse::<u64>().ok()),
        })
        .clone()
}

/// One `sysctl -n <key>`, or `None`. Shelling out rather than taking a new dependency mirrors
/// `config::total_memory_bytes`, which reads `hw.memsize` the same way.
#[cfg(target_os = "macos")]
fn sysctl_string(key: &str) -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/sysctl").args(["-n", key]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

#[cfg(not(target_os = "macos"))]
fn sysctl_string(_key: &str) -> Option<String> {
    // Sparkle ships mac-only; off macOS the facts degrade to empty and the card just says less.
    None
}

// ── rollup (pure) ───────────────────────────────────────────────────────────────────────────

/// Roll records into the per-day, per-model rows the wire expects.
///
/// Contract, mirroring the Spend pane so the leaderboard and the pane can never disagree:
///   • the window is the `days` calendar days ending at `today`; anything outside is dropped
///     (including future-dated records from a clock-skewed synced transcript);
///   • a repeated message id is counted ONCE — resuming a session copies prior turns into a new
///     transcript, and without this a heavy resume user's leaderboard number is inflated;
///   • the window CLAMP is this function's own (`MAX_REPORT_DAYS` = 90, what the server accepts)
///     and is deliberately tighter than the pane's `MAX_WINDOW_DAYS` = 365. Totals agree with the
///     pane for any window ≤ 90, which is every window the reporter can ask for —
///     `BuilderIndexState::window` clamps to the same 90 before this is ever called;
///   • those first two rules are not reimplemented here: both come from `spend::dedupe_window`,
///     the same call `spend::aggregate_records` makes. This function used to keep the FIRST copy of
///     a repeated id while the pane kept the LAST, so the two surfaces could bucket the same turn
///     differently — a divergence a passing test suite would never show, because each module only
///     ever tested its own half;
///   • rows are summed per (date, model) — never concatenated — because the server's upsert would
///     otherwise see two rows colliding on the same primary key within one POST;
///   • days with no usage are OMITTED (unlike the pane's contiguous calendar): the server merges
///     `data` by date, so an empty row is pure noise;
///   • output order is deterministic (date asc, then model name) so two identical scans produce
///     byte-identical payloads.
///
/// KNOWN LIMIT, inherited from the scan: a turn whose transcript line carries no message id gets a
/// positional fallback key that includes its line ordinal, so the copy a resume writes into a new
/// transcript keys differently and is counted TWICE. The pane has the same blind spot, but here the
/// number is published — a heavy-resume user's leaderboard total reads high. Fixing it means a
/// resume-stable fallback key in `spend::parse_line`, not a second dedup rule here.
///
/// Takes BORROWED records (`WindowScan::records()` hands back the memo's blocks) so the reporter
/// never materializes a second copy of the scan.
///
/// Pure: no filesystem, no clock, no network. `today` is passed in.
pub fn rollup<'a>(
    records: impl Iterator<Item = &'a UsageRecord>,
    today: i64,
    days: u32,
) -> Vec<DailyUsage> {
    let window = days.clamp(1, MAX_REPORT_DAYS);
    let first_day = today - (window as i64 - 1);

    // (day, model) → accumulator. BTreeMap gives the deterministic (date, model) ordering for free.
    let mut buckets: std::collections::BTreeMap<(i64, String), ModelBreakdown> =
        std::collections::BTreeMap::new();

    for r in crate::spend::dedupe_window(records, first_day, today) {
        let entry = buckets
            .entry((r.day, r.model.clone()))
            .or_insert_with(|| ModelBreakdown {
                model_name: r.model.clone(),
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_tokens: 0,
                cache_read_tokens: 0,
                total_tokens: 0,
                cost: None,
                source: SOURCE.to_string(),
            });
        entry.input_tokens = entry.input_tokens.saturating_add(r.input);
        entry.output_tokens = entry.output_tokens.saturating_add(r.output);
        entry.cache_creation_tokens = entry
            .cache_creation_tokens
            .saturating_add(crate::spend::record_cache_creation(r));
        entry.cache_read_tokens = entry.cache_read_tokens.saturating_add(r.cache_read);
        entry.total_tokens = entry
            .total_tokens
            .saturating_add(crate::spend::record_total_tokens(r));
        if let Some(c) = crate::spend::record_cost_usd(r) {
            entry.cost = Some(entry.cost.unwrap_or(0.0) + c);
        }
    }

    let mut out: Vec<DailyUsage> = Vec::new();
    for ((day, _model), row) in buckets {
        let date = crate::spend::epoch_day_label(day);
        match out.last_mut() {
            Some(d) if d.date == date => d.model_breakdowns.push(row),
            _ => out.push(DailyUsage { date, model_breakdowns: vec![row] }),
        }
    }
    out
}

/// Build the `session_stats` blob, or `None` when this scan cannot honestly support one.
///
/// THE OMISSION RULE, which is the point of this function. An undercount presented confidently is
/// worse than a gap — a ~84% one sat on this profile looking authoritative for weeks. So every
/// metric here is either complete or ABSENT; none is ever emitted as a zero:
///
///   • `truncated` (the scan hit `MAX_FILES`) ⇒ the WHOLE blob is dropped. A capped scan has an
///     unknown denominator, and a rate over an unknown denominator is not a smaller number, it is a
///     meaningless one. This is stricter than the token half, which posts a capped total with a
///     PARTIAL label — a token count is still a valid lower bound, a rate is not.
///   • no interactive sessions ⇒ `adoption` is dropped (division by zero has no honest value) while
///     `tool_mix` survives, because a mix is a proportion of work actually seen, not a per-session
///     rate.
///   • no tool calls at all ⇒ `tool_mix` is dropped.
///   • nothing left to say ⇒ `None`, so the key never appears in the payload.
///
/// THE DENOMINATOR IS DELIBERATELY NOT THE COMMUNITY INDEXER'S. It counts every transcript, 87% of
/// which are one-shot automation on this machine, which is what divided these rates by ~7.5. Ours is
/// interactive sessions only, labelled as such in [`Adoption::denominator`], with both counts sent
/// alongside. The consequence to be honest about: these rates are NOT directly comparable to a
/// profile whose numbers came from the community indexer.
///
/// Pure: no clock, no filesystem, no network.
pub fn rollup_activity(
    totals: &crate::spend::ActivityTotals,
    truncated: bool,
    days: u32,
    today: i64,
) -> Option<SessionStats> {
    if truncated {
        return None;
    }

    let adoption = (totals.sessions_interactive > 0).then(|| {
        let denom = totals.sessions_interactive as f64;
        Adoption {
            subagents_per_session: totals.subagent_dispatches as f64 / denom,
            plan_mode_rate: totals.plan_mode_sessions as f64 / denom,
            distinct_skills: totals.distinct_skills,
            denominator: STATS_DENOMINATOR,
            sessions_interactive: totals.sessions_interactive,
            sessions_total: totals.sessions_total,
            subagent_dispatches: totals.subagent_dispatches,
            plan_mode_sessions: totals.plan_mode_sessions,
        }
    });

    let tool_mix = (totals.total_calls > 0).then(|| ToolMix {
        by_category: totals
            .by_category
            .iter()
            .map(|(k, v)| ((*k).to_string(), *v))
            .collect(),
        total_calls: totals.total_calls,
    });

    // NOTHING LEFT TO SAY ⇒ `None`. This was briefly relaxed to also publish a counts-only blob
    // (window + totals) whenever any session existed. That was a REGRESSION against the superset
    // rule this very function documents: `session_stats` is replaced WHOLESALE and the community
    // reporter writes the same key, so posting a stripped blob DELETES its `adoption` and `tool_mix`
    // and blanks all three panels until that reporter's next 2h tick. Omitting the key leaves the
    // existing blob untouched, which is strictly better than overwriting it with less. A light or
    // chat-only install is exactly the case that hit this. (roborev 55829)
    if adoption.is_none() && tool_mix.is_none() {
        return None;
    }

    let window = days.clamp(1, MAX_REPORT_DAYS);
    let first_day = today - (window as i64 - 1);
    Some(SessionStats {
        schema_version: 1,
        source: STATS_SOURCE,
        window: StatsWindow {
            days: window,
            // Whole UTC days: the scan's mtime cutoff is the START of `first_day`, and it includes
            // everything written up to the end of `today`.
            since: format!("{}T00:00:00Z", crate::spend::epoch_day_label(first_day)),
            until: format!("{}T23:59:59Z", crate::spend::epoch_day_label(today)),
        },
        totals: StatsTotals {
            sessions_all: totals.sessions_total,
            sessions_human: totals.sessions_interactive,
            sessions_automation: totals
                .sessions_total
                .saturating_sub(totals.sessions_interactive),
        },
        adoption,
        tool_mix,
    })
}

/// The `last_status` line for a successful post. Pure so BOTH branches are testable — the PARTIAL
/// wording is the whole point of propagating `truncated`, and building it inline inside
/// `report_once_sync` left it unreachable from a test. (roborev 47904/47899)
pub fn posted_status(rows: usize, days: usize, truncated: bool, notice: Option<&str>) -> String {
    let base = format!("Reported {rows} row(s) across {days} day(s).");
    let base = match notice {
        // The server's own words, not a paraphrase: a nag we re-word is a nag the operator can't
        // recognize when the user pastes it back at them.
        Some(n) => format!("{base} The server says: {n}"),
        None => base,
    };
    if truncated {
        // Say so out loud. "Reported N rows" over a capped scan is how a number ends up 84% low
        // and nobody notices. The activity metrics are named too, because "absent" is only honest
        // if the user can tell absent from zero — a silently missing panel reads as "I have no
        // subagents", which is the misreading this whole change exists to end.
        format!(
            "{base} PARTIAL — the transcript scan hit its file cap, so this understates your usage. \
             Subagent, plan-mode and tool-mix stats were omitted rather than published over an \
             incomplete scan."
        )
    } else {
        base
    }
}

/// Total rows across every day — what the per-cycle log line reports.
pub fn row_count(data: &[DailyUsage]) -> usize {
    data.iter().map(|d| d.model_breakdowns.len()).sum()
}

// ── dry run ─────────────────────────────────────────────────────────────────────────────────

/// What `--builder-index-dry-run` was asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct DryRunArgs {
    /// `None` = whatever window the REPORTER would actually use, read from the persisted state.
    /// Not `DEFAULT_REPORT_DAYS`: a user who set `report_days` to something else would otherwise
    /// be shown a window their reporter never posts, which defeats the one claim this tool makes.
    pub days: Option<u32>,
    /// Sparkle's app-data root. `None` = the platform default for THIS build. Explicit because a
    /// dry run must be able to point at the production store from a debug binary — measuring the
    /// `-dev` sibling and reporting it as "what Sparkle collects" would be a confidently wrong
    /// answer to the only question this tool exists to answer.
    pub app_data: Option<PathBuf>,
}

/// Parse the dry-run flags out of the process args. `None` = an ordinary launch, so this must stay
/// cheap and must never claim an argument the app itself uses.
///
/// `--builder-index-dry-run [--days N] [--app-data PATH]`
pub fn dry_run_args<I: IntoIterator<Item = String>>(args: I) -> Option<DryRunArgs> {
    let args: Vec<String> = args.into_iter().collect();
    if !args.iter().any(|a| a == "--builder-index-dry-run") {
        return None;
    }
    let value_after = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    Some(DryRunArgs {
        // An unparseable or absent `--days` falls back to the REPORTER'S OWN window (resolved in
        // `dry_run` from persisted state) rather than failing: the tool's job is to print numbers,
        // and refusing over a typo'd flag is worse than printing the real window.
        days: value_after("--days")
            .and_then(|v| v.parse::<u32>().ok())
            .map(|d| d.clamp(1, MAX_REPORT_DAYS)),
        app_data: value_after("--app-data").map(PathBuf::from),
    })
}

/// Compute exactly what [`report_once_sync`] would POST — and print it instead of posting it.
///
/// WHY THIS EXISTS. Retiring the community client requires proving Sparkle collects the same usage
/// it does, on the same machine, over the same window. Proving that by publishing is not available:
/// the leaderboard's primary key is (username, date, model, client_id) with SUM and no grouping, so
/// two clients reporting the same machine double-count every overlapping day PERMANENTLY. This runs
/// the real scan and the real [`rollup`] — not a reimplementation — and touches nothing:
///   • no POST, so nothing is published and nothing double-counts;
///   • no keychain read, so an unsigned dev binary can't trip the macOS authorization prompt;
///   • no state write, so the pinned `client_id`, consent, and `last_status` are exactly as found.
/// The `client_id` it prints is READ, never derived — the one identity that must survive the
/// migration untouched is not something a diagnostic should be able to mint.
pub fn dry_run(args: &DryRunArgs) -> String {
    let app_data = args.app_data.clone().or_else(default_app_data_dir);
    // The one line this function's seam leaves untested (`dry_run_over` is what the tests drive).
    // `transcript_roots` has its own coverage in spend.rs — including the account-store ordering
    // this feature exists for — so the untested surface here is the call, not the behavior.
    let roots = crate::spend::transcript_roots(app_data.as_deref());
    dry_run_over(args, app_data.as_deref(), &roots)
}

/// [`dry_run`] with ONLY the scan roots handed in.
///
/// Split out for the same reason `spend::scan_window` is: without it the only way to exercise this
/// is to scan whatever `$HOME/.claude` the machine happens to have — 3,697 project directories on
/// the machine this was written on. That makes the test slow, machine-dependent, and quietly
/// dependent on the tester's own `CLAUDE_CONFIG_DIR`, which is the exact contamination the
/// `warning` field below exists to flag.
///
/// THE SEAM IS DELIBERATELY CUT BELOW `load_state` AND THE DAY RESOLUTION (roborev 62729). An
/// earlier cut took the already-loaded state and the already-resolved `days` as parameters, which
/// left both behaviors the tests claim to guard on the untested side of it: the "writes nothing"
/// assertion ran against a function that provably never opens the state file, and the
/// `--days`-defers-to-`report_days` test asserted a value it had itself passed in. Everything
/// this function's tests assert on must therefore be computed HERE, not by the caller.
fn dry_run_over(args: &DryRunArgs, app_data: Option<&Path>, roots: &[PathBuf]) -> String {
    let state = app_data.map(load_state);
    // The REPORTER's window when `--days` is absent, not this module's default constant.
    let days = args
        .days
        .unwrap_or_else(|| state.as_ref().map_or(DEFAULT_REPORT_DAYS, |s| s.window()));
    let state = state.as_ref();
    let scan = crate::spend::scan_window(roots, days);
    let data = rollup(scan.records(), scan.today, days);
    let session_stats = rollup_activity(&scan.activity(), scan.truncated, days, scan.today);

    let mut totals = ModelBreakdown {
        model_name: "ALL".to_string(),
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
        cost: None,
        source: SOURCE.to_string(),
    };
    let mut cost = 0.0f64;
    let mut priced = false;
    for day in &data {
        for m in &day.model_breakdowns {
            totals.input_tokens = totals.input_tokens.saturating_add(m.input_tokens);
            totals.output_tokens = totals.output_tokens.saturating_add(m.output_tokens);
            totals.cache_creation_tokens =
                totals.cache_creation_tokens.saturating_add(m.cache_creation_tokens);
            totals.cache_read_tokens =
                totals.cache_read_tokens.saturating_add(m.cache_read_tokens);
            totals.total_tokens = totals.total_tokens.saturating_add(m.total_tokens);
            if let Some(c) = m.cost {
                cost += c;
                priced = true;
            }
        }
    }
    totals.cost = priced.then_some(cost);

    let report = serde_json::json!({
        "posted": false,
        "note": "DRY RUN — nothing was sent to the Builder Index and no state was written.",
        "window_days": days,
        "client_version_that_would_be_sent": client_version(),
        // RESOLVED, not raw: the leaderboard groups by team, and the whole failure this field
        // exists to make visible is a stored value that never reaches the wire. Printing
        // `state.team` would show the setting; this shows what a report would actually carry.
        //
        // JSON `null` means the key is OMITTED from the payload — nothing will be sent and the
        // server's existing team is left alone. That is a materially different outcome from
        // sending `"default"`, so it must not render as a string that looks like a team name.
        "team_that_would_be_sent": state.and_then(BuilderIndexState::team),
        "client_id": state.map(|s| s.client_id.clone()),
        "username": state.map(|s| s.username.clone()),
        "app_data": app_data.map(|p| p.display().to_string()),
        "roots": roots.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
        // MEASURED THE HARD WAY. Run from inside a Sparkle agent's shell, `CLAUDE_CONFIG_DIR`
        // points at ONE account store, so `transcript_roots` resolves the "primary" root to that
        // store, dedupes it against itself, and `~/.claude/projects` — 3,697 project directories
        // on the machine this was found on — is never scanned at all. The dry run answered 1.99B
        // where the truth was 56.4B: a 32x undercount, with `truncated: false` and no other tell.
        // A parity check that reads that number concludes Sparkle collects nothing. Say it out
        // loud rather than leaving the reader to notice a missing line in `roots`.
        "claude_config_dir": std::env::var("CLAUDE_CONFIG_DIR").ok(),
        "warning": dry_run_warning(std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref()),
        // A capped scan UNDERSTATES the total, which is precisely the failure mode a parity
        // comparison would otherwise misread as "Sparkle collects less than the other client".
        "truncated": scan.truncated,
        "rows": row_count(&data),
        "days_with_usage": data.len(),
        "totals": totals,
        "data": data,
        "session_stats": session_stats,
    });
    serde_json::to_string_pretty(&report).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
}

/// The caveat that belongs on a dry run's numbers, if any. Pure — taking the env value as an
/// argument rather than reading it, so the warning is testable without mutating process-global
/// state every other test in the binary shares.
fn dry_run_warning(claude_config_dir: Option<&str>) -> Option<&'static str> {
    claude_config_dir.filter(|s| !s.is_empty()).map(|_| {
        "CLAUDE_CONFIG_DIR is set, so the primary ~/.claude store is probably NOT in `roots` and \
         this total UNDERSTATES the machine. Re-run with `env -u CLAUDE_CONFIG_DIR`."
    })
}

/// The platform app-data root for THIS build, without an `AppHandle`.
///
/// Mirrors `dev_identity::app_data_dir`'s dev suffix so a debug dry run reads the same store a
/// debug app would. Only the macOS/Linux/Windows conventions Tauri itself uses.
fn default_app_data_dir() -> Option<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var_os("HOME")?).join("Library/Application Support")
    } else if cfg!(target_os = "windows") {
        PathBuf::from(std::env::var_os("APPDATA")?)
    } else {
        match std::env::var_os("XDG_DATA_HOME") {
            Some(x) => PathBuf::from(x),
            None => PathBuf::from(std::env::var_os("HOME")?).join(".local/share"),
        }
    };
    // Route through dev_identity rather than re-formatting the suffix here: the dev identity is
    // per-checkout as well as per-build-type, so a hand-rolled `-dev` would point a debug dry run at
    // a directory no app writes.
    Some(crate::dev_identity::dev_suffixed_path(&base.join("ai.sparkle.desktop")))
}

// ── keychain ────────────────────────────────────────────────────────────────────────────────

fn entry() -> Result<keyring::Entry, String> {
    // Dev-suffixed keychain service in debug builds (mirrors auth.rs / trial_remote.rs).
    keyring::Entry::new(&crate::dev_identity::keychain_service(), KEYCHAIN_USER)
        .map_err(|e| e.to_string())
}

/// How many times the keychain has been reached for. Test-only: the module's headline property is
/// that a not-opted-in install never touches the keychain, and asserting the ORDER of statements in
/// `report_once_sync` is the only way to keep a later edit from quietly reintroducing an
/// unconditional read. (roborev 48168/48167)
#[cfg(test)]
static KEYCHAIN_READS: AtomicUsize = AtomicUsize::new(0);

/// The stored key, or a reason it can't be used.
///
/// Validated on READ as well as write: a key stored by an older build (or by any other writer of
/// the same keychain item) with an interior newline would otherwise malform the `Authorization`
/// header on every cycle forever, surfacing only as a generic transport error.
/// (roborev 47460/48168/48167)
fn read_api_key() -> Result<String, SkipReason> {
    #[cfg(test)]
    KEYCHAIN_READS.fetch_add(1, Ordering::SeqCst);
    let Some(k) = entry().ok().and_then(|e| e.get_password().ok()) else {
        return Err(SkipReason::NoApiKey);
    };
    let k = k.trim().to_string();
    if k.is_empty() {
        return Err(SkipReason::NoApiKey);
    }
    validate_api_key(&k).map_err(|_| SkipReason::BadApiKey)?;
    Ok(k)
}

/// Reject anything that can't be a header value BEFORE it reaches the keychain, so a bad paste
/// fails loudly in the settings dialog instead of turning into a confusing transport error every
/// two hours forever. (roborev 47460)
fn validate_api_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("the API key is empty".to_string());
    }
    if !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err(
            "that API key contains spaces, line breaks, or non-ASCII characters — check for a \
             stray newline in the paste"
                .to_string(),
        );
    }
    Ok(())
}

fn write_api_key(key: &str) -> Result<(), String> {
    validate_api_key(key)?;
    entry()?.set_password(key).map_err(|e| e.to_string())
}

fn delete_api_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // Already absent is the state the caller wanted.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ── reporting ───────────────────────────────────────────────────────────────────────────────

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The reporting host: [`DEFAULT_SERVER_URL`] unless `TKMX_SERVER_URL` names an HTTPS host.
///
/// The override is scheme-checked, not taken as-is. This request carries
/// `Authorization: Bearer <api key>`, so anything that can seed Sparkle's environment (a shell
/// profile, a stray launch agent) could otherwise redirect the key to an arbitrary host over
/// plaintext HTTP. An override that isn't `https://` is refused and logged rather than honored.
/// (roborev 47458)
fn server_url() -> String {
    let raw = std::env::var("TKMX_SERVER_URL").ok();
    resolve_server_url(raw.as_deref(), crate::dev_identity::is_dev())
}

/// The override decision, as a pure function of the raw env value and whether this is a dev build.
/// Split out so the refusal paths are testable without mutating the process environment (which is
/// global state shared with every other test in the binary). (roborev 47904/47899)
fn resolve_server_url(raw: Option<&str>, is_dev: bool) -> String {
    let Some(raw) = raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
        return DEFAULT_SERVER_URL.to_string();
    };
    // DEV BUILDS ONLY. A scheme check alone narrows the exfiltration primitive to TLS rather than
    // closing it: `TKMX_SERVER_URL=https://attacker.example` would still receive
    // `Authorization: Bearer <api key>` every cycle. A shipped build has no legitimate reason to
    // report anywhere but the real host, so the override simply doesn't exist there.
    // (roborev 47460/47904/47899)
    if !is_dev {
        tracing::warn!(
            "builder index: ignoring TKMX_SERVER_URL — the override is dev-builds-only, because \
             the request carries a bearer token"
        );
        return DEFAULT_SERVER_URL.to_string();
    }
    if is_safe_override(&raw) {
        tracing::info!(host = %raw, "builder index: using TKMX_SERVER_URL override");
        return raw;
    }
    tracing::warn!(
        value = %raw,
        "builder index: ignoring TKMX_SERVER_URL — only https:// (or a localhost dev server) is \
         accepted, because the request carries a bearer token"
    );
    DEFAULT_SERVER_URL.to_string()
}

/// An override is acceptable if it's HTTPS, or plain HTTP pointed at the loopback interface (the
/// only case where a cleartext bearer never leaves the machine).
/// `pub(crate)` ONLY so `preview.rs` can assert, in one test, that this function and
/// `preview::preview_url_is_loopback` disagree on `https://evil.example`. That disagreement is the
/// whole point: this gate is right for an API base carrying a bearer token and catastrophically
/// wrong for a preview pane, and a shared test is what makes a future "just reuse it" refactor go
/// red instead of silently widening the preview gate.
pub(crate) fn is_safe_override(raw: &str) -> bool {
    if let Some(rest) = raw.strip_prefix("https://") {
        return !rest.is_empty();
    }
    if let Some(rest) = raw.strip_prefix("http://") {
        // A bracketed IPv6 host must be peeled BEFORE splitting on ':', or `[::1]` splits into a
        // bare "[" and the documented loopback case becomes unreachable. (roborev 47899)
        if let Some(after) = rest.strip_prefix('[') {
            return matches!(after.split(']').next(), Some("::1"));
        }
        let host = rest.split(['/', ':']).next().unwrap_or("");
        return host == "localhost" || host == "127.0.0.1";
    }
    false
}

/// What one cycle did. `Posted` carries the row count so the caller can log/show it.
#[derive(Clone, Debug, PartialEq)]
pub enum ReportOutcome {
    /// `truncated` = the transcript scan hit its file cap, so these numbers UNDERSTATE reality.
    /// It rides on the outcome (not just `last_status`) because the modal renders the fresh
    /// message and suppresses `last_status` — without this the warning existed only in the log,
    /// which is not "saying so out loud". (roborev 47899)
    ///
    /// `notice` is the server's own nag (an outdated client, an agentsview update) on a report that
    /// DID land. It rides here for the same reason `truncated` does — and because the freeze this
    /// module now fails loudly on arrives as a nag FIRST: the cycle before the server starts
    /// discarding is the one where a visible warning is still actionable.
    Posted { rows: usize, days: usize, truncated: bool, notice: Option<String> },
    Skipped(SkipReason),
}

/// Build the POST body from the reporter's state and this cycle's rollup.
///
/// Extracted for the reason [`classify_ok_response`] was: welded inline, the identity fields —
/// which team the rows are filed under, which `client_version` decides whether the server keeps
/// them at all — are reachable only through a live socket, so the two fields that silently zeroed
/// this machine's profile were the two nothing could assert on. This IS the production payload
/// builder; `report_once_sync` serializes whatever it returns.
fn build_report_body(
    state: &BuilderIndexState,
    client_id: String,
    window: u32,
    data: Vec<DailyUsage>,
    session_stats: Option<SessionStats>,
    machine_config: Option<MachineConfig>,
) -> ReportBody {
    ReportBody {
        username: state.username.trim().to_string(),
        team: state.team().map(str::to_string),
        client_id,
        client_version: client_version(),
        report_days: window,
        data,
        session_stats,
        machine_config,
    }
}

/// Run one reporting cycle: gate → scan → roll up → POST.
///
/// Blocking (filesystem + network); callers wrap it in `spawn_blocking`. Returns `Err` only for a
/// real failure to report (offline, auth rejected, malformed response) — a gate miss is `Ok`.
fn report_once_sync(app_data: PathBuf, enabled: bool) -> Result<ReportOutcome, String> {
    let mut state = load_state(&app_data);
    // The keychain read is LAST and lazy, behind the cheap gates. An unsigned/adhoc dev binary
    // touching a keychain item owned by the signed app pops a macOS authorization prompt (see
    // dev_identity's header), so a default-off install must never reach for it — being prompted
    // every 2h by a feature you never opted into is exactly the opposite of inert. (roborev 47460)
    if let Err(reason) = pre_key_gate(enabled, &state) {
        return Ok(ReportOutcome::Skipped(reason));
    }
    let api_key = match read_api_key() {
        Ok(k) => k,
        Err(reason) => return Ok(ReportOutcome::Skipped(reason)),
    };

    let window = state.window();
    let client_id = ensure_client_id(&app_data, &mut state);
    let scan = crate::spend::load_window_records(Some(&app_data), window);
    let data = rollup(scan.records(), scan.today, window);
    let session_stats = rollup_activity(&scan.activity(), scan.truncated, window, scan.today);
    let machine_config = build_machine_config(&host_facts(), reported_skills());
    let rows = row_count(&data);
    let days = data.len();
    if scan.truncated {
        tracing::warn!(
            rows,
            days,
            "builder index: transcript scan hit its file cap — this report is PARTIAL, and the \
             session-activity metrics are OMITTED rather than published over an unknown denominator"
        );
    }

    // `state` is passed rather than its fields: `ensure_client_id` above may have refreshed
    // `state.username`, and using the caller's original snapshot would post the OLD name alongside
    // a freshly-derived new-name id.
    let body = build_report_body(&state, client_id, window, data, session_stats, machine_config);
    // An empty `data: []` is still POSTed rather than short-circuited. That matches the reference
    // client (which falls through on an inactive day on purpose) and it is the only signal the
    // server gets that this machine is alive and still reporting — a silent gap and a genuinely
    // idle week would otherwise be indistinguishable on the profile.
    let payload = serde_json::to_string(&body).map_err(|e| e.to_string())?;

    let url = format!("{}/api/usage", server_url().trim_end_matches('/'));
    let resp = ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {api_key}"))
        .send_string(&payload);

    match resp {
        Ok(r) => {
            // A 200 is not proof of success: tkmx-server can answer 200 with an error payload
            // (unknown user, frozen profile). Recording "Reported N rows" then would send the user
            // to a profile that never updates, with no diagnostic. (roborev 47458)
            let body = r.into_string().unwrap_or_else(|e| {
                // A truncated/aborted body used to become "" ⇒ success. Say so instead of
                // silently recording a report we could not confirm landed. (roborev 47904)
                tracing::warn!(error = %e, "builder index: could not read the server response");
                String::new()
            });
            match classify_ok_response(&body, rows, days, scan.truncated) {
                Ok((outcome, status)) => {
                    record_outcome(&app_data, Some(now_secs()), status);
                    Ok(outcome)
                }
                Err(msg) => {
                    record_outcome(&app_data, None, format!("Last report failed — {msg}."));
                    Err(msg)
                }
            }
        }
        Err(e) => {
            // The error string can carry the URL but never the key (it lives only in a header we
            // build locally and ureq does not echo).
            let msg = match &e {
                ureq::Error::Status(code, _) => format!("server returned {code}"),
                ureq::Error::Transport(t) => format!("network error: {t}"),
            };
            record_outcome(&app_data, None, format!("Last report failed — {msg}."));
            Err(msg)
        }
    }
}

/// An explicit failure reported inside a 2xx body, or `None` when the response looks fine.
/// Non-JSON and unrecognized shapes are treated as success — the server's happy-path body is not
/// part of any documented contract, so we only act on an UNAMBIGUOUS failure marker.
fn server_side_error(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    // Prefer a human string wherever it lives: `error` as a string, `error.message`, or `message`.
    // Recognizing only two shapes let `{"ok":false}` and `{"error":{"message":…}}` fall through as
    // success — the "profile never updates, no diagnostic" outcome this exists to catch.
    // (roborev 47904)
    let detail = || {
        for key in ["error", "message"] {
            match v.get(key) {
                Some(serde_json::Value::String(m)) if !m.is_empty() => return m.clone(),
                Some(obj @ serde_json::Value::Object(_)) => {
                    return match obj.get("message").and_then(serde_json::Value::as_str) {
                        Some(m) if !m.is_empty() => m.to_string(),
                        _ => obj.to_string(),
                    };
                }
                _ => {}
            }
        }
        "the server reported a failure".to_string()
    };
    for key in ["success", "ok"] {
        if v.get(key).and_then(serde_json::Value::as_bool) == Some(false) {
            return Some(detail());
        }
    }
    if v.get("status").and_then(serde_json::Value::as_str) == Some("error") {
        return Some(detail());
    }
    match v.get("error") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(e)) if e.is_empty() => None,
        Some(_) => Some(detail()),
    }
}

/// How many rows the server says it STORED, when it says so at all.
///
/// tkmx-server answers `{"ok":true,"rows":N,…}`. `N` is what it PERSISTED, which is not the same
/// as what we sent — see [`discard_reason`] for the case where those differ.
///
/// THAT `N` IS THE STORED COUNT IS MEASURED, NOT ASSUMED, and the distinction matters: if the
/// server always answered 0, [`discard_reason`]'s primary rule would fail every healthy cycle
/// instead of catching a broken one. Both directions were observed against the live server on
/// 2026-08-11 — a healthy non-empty report answered `{"ok":true,"rows":28}`, and a discarded one
/// answered `{"ok":true,"rows":0}` for a payload carrying 21 rows.
fn stored_rows(v: &serde_json::Value) -> Option<u64> {
    v.get("rows").and_then(serde_json::Value::as_u64)
}

/// The operator's nag text (`client_update` / `agentsview_update`), reduced to its first line.
///
/// Those fields are multi-line install instructions; `last_status` is one line in a settings row.
/// The first line carries the diagnosis ("Your tkmx-client is outdated (X → Y)") and the rest is
/// shell commands the log already has in full.
fn server_notice(v: &serde_json::Value) -> Option<String> {
    for key in ["client_update", "agentsview_update"] {
        if let Some(s) = v.get(key).and_then(serde_json::Value::as_str) {
            let first = s.lines().next().unwrap_or("").trim();
            if !first.is_empty() {
                return Some(first.to_string());
            }
        }
    }
    None
}

/// Why a 200 response means the report did NOT land — `None` when it did.
///
/// THIS IS THE FIX FOR A SILENT ZERO, and it is deliberately not a version check. Measured against
/// the live server on 2026-08-11: a Sparkle report of 21 rows was answered
/// `200 {"ok":true,"rows":0,"client_update":"…outdated (sparkle-desktop/0.98.0 → 1.3.0)…",
/// "profile_frozen":true}` — accepted, counted as a success by [`server_side_error`] (which only
/// looks for `ok:false`/`error`), and thrown away. The profile read `tokens_28d: 0` for months
/// while `last_status` read "Reported 21 row(s) across 7 day(s)."
///
/// Two rules, and the ORDER of durability matters more than either one:
///   1. WE SENT ROWS AND THE SERVER STORED NONE. This is version-independent and reason-independent
///      — it catches a freeze, a future minimum-version gate, a schema rejection, a quota, and
///      whatever else the operator adds next. It is the rule that makes the silence structurally
///      impossible rather than fixed for one known cause.
///   2. `profile_frozen: true`, even on an empty post. A freeze means nothing we send LATER will
///      land either, so an idle cycle must still say so rather than wait for a busy one.
/// A SHORTFALL (stored some, but fewer than we sent) is deliberately NOT fatal: the server merges
/// rows by (date, model), so a smaller count can be legitimate, and a false failure every cycle
/// would train the user to ignore the one that is real.
fn discard_reason(v: &serde_json::Value, sent_rows: usize) -> Option<String> {
    let notice = server_notice(v);
    let because = || match &notice {
        Some(n) => format!(" The server says: {n}"),
        None => String::new(),
    };
    if v.get("profile_frozen").and_then(serde_json::Value::as_bool) == Some(true) {
        return Some(format!(
            "the server FROZE this profile — it accepted the request and kept none of it, so the \
             Builder Index will keep showing the last snapshot.{}",
            because()
        ));
    }
    if sent_rows > 0 && stored_rows(v) == Some(0) {
        return Some(format!(
            "the server accepted the request but stored 0 of {sent_rows} row(s), so none of this \
             usage reached the Builder Index.{}",
            because()
        ));
    }
    None
}

/// Decide a cycle's outcome from the server's 200 body. Pure, so every branch is testable.
///
/// Extracted rather than written inline for the reason `posted_status` was: the interesting paths
/// here are the ones a test can only reach if they are not welded to a live socket. `report_once_sync`
/// keeps exactly one untestable line — the POST itself — and hands the body straight to this.
///
/// `Err` = the report did not land. `Ok((outcome, status))` = it did; `status` is what goes in
/// `last_status`.
fn classify_ok_response(
    body: &str,
    rows: usize,
    days: usize,
    truncated: bool,
) -> Result<(ReportOutcome, String), String> {
    // An explicit failure marker still wins — it carries the operator's own wording.
    if let Some(err) = server_side_error(body) {
        return Err(format!("server accepted the request but reported: {err}"));
    }
    // A non-JSON or unreadable body is NOT treated as a discard: the happy-path shape is not a
    // documented contract, and failing every cycle because the server changed its 200 body would
    // be a worse bug than the one this catches.
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    if let Some(reason) = discard_reason(&v, rows) {
        return Err(reason);
    }
    let notice = server_notice(&v);
    Ok((
        ReportOutcome::Posted { rows, days, truncated, notice: notice.clone() },
        posted_status(rows, days, truncated, notice.as_deref()),
    ))
}

/// Write back ONLY the fields the reporter owns, re-reading state immediately beforehand.
///
/// The naive read-modify-write held a whole `BuilderIndexState` across a filesystem scan and a
/// 20-second POST, so a "Turn off and forget" landing in that window was silently undone — the
/// reporter restored the username, the pinned `client_id`, and (worst) `consented_at`, meaning a
/// withdrawn consent came back on its own. Re-loading here narrows the window to two adjacent
/// syscalls and, more importantly, means a concurrent write to the user-owned fields survives:
/// we never copy them forward from our stale snapshot. (roborev 47458)
fn record_outcome(app_data: &Path, reported_at: Option<i64>, status: String) {
    let _guard = state_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut fresh = load_state(app_data);
    // Withdrawn mid-cycle ⇒ write NOTHING. `builder_index_forget` is documented as complete
    // erasure, and re-creating the file with "Reported 12 rows…" would leave the user who just
    // asked to be forgotten looking at a bookkeeping record of a report tied to the identity they
    // deleted. Nothing the reporter owns is meaningful without consent. (roborev 47904/47899)
    if fresh.consented_at.is_none() {
        return;
    }
    if let Some(t) = reported_at {
        fresh.last_report_at = Some(t);
    }
    fresh.last_status = Some(status);
    let _ = save_state(app_data, &fresh);
}

/// Random per-cycle jitter in [0, [`JITTER_SPREAD_SECS`]).
///
/// Actually random, not clock-derived: a function of the wall clock gives every install whose
/// cycle lands in the same second the SAME offset, which is the thundering herd this exists to
/// prevent rather than a fix for it. (roborev 47460)
fn jitter_secs() -> u64 {
    use rand::Rng;
    rand::thread_rng().gen_range(0..JITTER_SPREAD_SECS)
}

/// Guard against two reporter loops (a second `setup` pass, a re-entrant spawn) racing the same
/// state file and posting twice per cycle.
static LOOP_RUNNING: AtomicBool = AtomicBool::new(false);

/// Start the background reporter. Idempotent — a second call is a no-op.
///
/// Runs on its own OS thread rather than the async runtime: every step of a cycle is blocking
/// (a transcript scan, then a socket), so this would be a `spawn_blocking` per tick anyway, and a
/// dedicated thread that spends 2 hours asleep is cheaper than parking a runtime worker.
///
/// Never blocks startup — the first cycle is [`FIRST_REPORT_DELAY`] out. Offline is not an error
/// state: the cycle logs a warning and the next tick retries, and because the window is a trailing
/// 7 days, a machine that was offline for a week catches up in a single post.
///
/// The enable check is re-read from the live config EVERY cycle, not captured at spawn: a user who
/// turns the toggle off mid-session must stop being reported without restarting the app.
pub fn spawn_reporter(app: tauri::AppHandle) {
    if LOOP_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_REPORT_DELAY);
        loop {
            match app_data_dir(&app) {
                Ok(dir) => {
                    let enabled = crate::config::current_effective().config.tools.builder_index;
                    match report_once_sync(dir, enabled) {
                        Ok(ReportOutcome::Posted { rows, days, truncated, notice }) => {
                            // The nag goes out at WARN with its FULL text (the status line only
                            // keeps the first line): when it fires, the install instructions are
                            // the actionable part, and the log is the only place they fit.
                            if let Some(n) = &notice {
                                tracing::warn!(
                                    notice = %n,
                                    "builder index: the server sent an update notice — a client it \
                                     considers outdated is one freeze away from being discarded"
                                );
                            }
                            tracing::info!(
                                rows,
                                days,
                                truncated,
                                "builder index: reported daily token totals"
                            )
                        }
                        Ok(ReportOutcome::Skipped(reason)) => {
                            tracing::debug!(reason = reason.as_str(), "builder index: cycle skipped")
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "builder index: report failed (will retry)")
                        }
                    }
                }
                Err(e) => tracing::warn!(error = %e, "builder index: no app data dir; skipping"),
            }
            std::thread::sleep(REPORT_INTERVAL + Duration::from_secs(jitter_secs()));
        }
    });
}

/// The app-data root, DEV-SUFFIXED in debug builds.
///
/// Must go through `dev_identity` for the same reason the keychain entry does: the two halves of
/// the gate have to agree. Using the raw `app_data_dir()` here while the API key comes from the
/// `-dev` keychain service means a debug run reads and WRITES the release install's reporter state
/// (inheriting consent it never asked for, re-pinning its `client_id`) and scans
/// `ai.sparkle.desktop/accounts/` while dev account stores live under `…-dev/accounts/` — which is
/// the exact multi-account blind spot this feature exists to close. (roborev 47458)
fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::dev_identity::app_data_dir(app)
}

// ── tauri commands ──────────────────────────────────────────────────────────────────────────

/// What the settings surface renders. Deliberately reports only WHETHER a key is stored.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuilderIndexStatus {
    pub enabled: bool,
    pub username: String,
    /// True when an API key is in the keychain. The key itself is never returned to JS.
    pub has_api_key: bool,
    pub consented: bool,
    pub client_id: String,
    pub report_days: u32,
    pub last_report_at: Option<i64>,
    pub last_status: Option<String>,
    /// `None` when a report would go out; otherwise why it wouldn't.
    pub blocked_by: Option<String>,
    pub server_url: String,
}

/// Current reporter status for the Tools row + settings modal.
#[tauri::command]
pub async fn builder_index_status(app: tauri::AppHandle) -> Result<BuilderIndexStatus, String> {
    let app_data = app_data_dir(&app)?;
    let enabled = crate::config::current_effective().config.tools.builder_index;
    tauri::async_runtime::spawn_blocking(move || {
        let state = load_state(&app_data);
        let consented = state.consented_at.is_some();
        // Same rule as the loop: an install that never opted in must not reach for the keychain
        // just because the settings pane was opened. On an unsigned dev build that read can pop
        // the macOS authorization prompt dev_identity warns about, and the "never touches the
        // keychain" invariant has to hold on EVERY path, not only the background one.
        // (roborev 48167)
        let key = if enabled || consented { read_api_key() } else { Err(SkipReason::NoApiKey) };
        let has_api_key = key.is_ok();
        let blocked_by = pre_key_gate(enabled, &state)
            .and(key.map(|_| ()))
            .err()
            .map(|r| r.as_str().to_string());
        BuilderIndexStatus {
            enabled,
            username: state.username.clone(),
            has_api_key,
            consented,
            client_id: state.client_id.clone(),
            report_days: state.window(),
            last_report_at: state.last_report_at,
            last_status: state.last_status.clone(),
            blocked_by,
            server_url: server_url(),
        }
    })
    .await
    .map_err(|e| format!("builder_index_status task failed: {e}"))
}

/// Store the tokenmaxxing username + API key and RECORD CONSENT. This is the write the consent
/// modal's confirm button makes — one call, so consent and credentials can't get out of step.
///
/// The key goes straight to the keychain and is never echoed back, logged, or written to disk.
/// An empty `api_key` keeps whatever key is already stored (so the modal can be re-opened to
/// change just the username without re-typing it).
#[tauri::command]
pub async fn builder_index_set_identity(
    app: tauri::AppHandle,
    username: String,
    api_key: String,
    consent: bool,
) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let username = username.trim().to_string();
        if username.is_empty() {
            return Err("a tokenmaxxing username is required".to_string());
        }
        if !api_key.trim().is_empty() {
            write_api_key(api_key.trim())?;
        }
        let mut state = load_state(&app_data);
        // Changing the username changes the derived client_id, so clear the pin and let the next
        // report re-derive it — reporting the OLD id under a new username would attach this
        // machine's rows to the wrong profile.
        if state.username != username {
            state.client_id = String::new();
        }
        state.username = username;
        if consent && state.consented_at.is_none() {
            state.consented_at = Some(now_secs());
        }
        save_state(&app_data, &state)
    })
    .await
    .map_err(|e| format!("builder_index_set_identity task failed: {e}"))?
}

/// Forget everything: consent, username, pinned client id, and the stored API key. The `[tools]`
/// toggle is the UI's business; this is the "and delete my credentials" half of turning it off.
#[tauri::command]
pub async fn builder_index_forget(app: tauri::AppHandle) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_api_key()?;
        save_state(&app_data, &BuilderIndexState::default())
    })
    .await
    .map_err(|e| format!("builder_index_forget task failed: {e}"))?
}

/// One-shot report, so the user can verify the integration immediately instead of waiting for the
/// next 2h tick. Same gate, same payload, same code path as the background loop.
#[tauri::command]
pub async fn builder_index_report_now(app: tauri::AppHandle) -> Result<ReportOutcome, String> {
    report_now(app).await
}

/// Shared body of the one-shot command and the loop's cycle.
async fn report_now(app: tauri::AppHandle) -> Result<ReportOutcome, String> {
    let app_data = app_data_dir(&app)?;
    let enabled = crate::config::current_effective().config.tools.builder_index;
    tauri::async_runtime::spawn_blocking(move || report_once_sync(app_data, enabled))
        .await
        .map_err(|e| format!("builder_index report task failed: {e}"))?
}

// `ReportOutcome` crosses the IPC boundary as `{"status":"posted","rows":12,"days":7}` /
// `{"status":"skipped","reason":"Builder Index is off"}` — a tagged shape the frontend can switch
// on without pattern-matching a bare string.
impl Serialize for ReportOutcome {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(None)?;
        match self {
            ReportOutcome::Posted { rows, days, truncated, notice } => {
                m.serialize_entry("status", "posted")?;
                m.serialize_entry("rows", rows)?;
                m.serialize_entry("days", days)?;
                m.serialize_entry("truncated", truncated)?;
                m.serialize_entry("notice", notice)?;
            }
            ReportOutcome::Skipped(reason) => {
                m.serialize_entry("status", "skipped")?;
                m.serialize_entry("reason", reason.as_str())?;
            }
        }
        m.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-07-24 as an epoch day, matching spend.rs's test anchor.
    fn today() -> i64 {
        // days_from_civil(2026, 7, 24) — computed here rather than importing spend's private
        // helper, and asserted against the label round-trip below.
        20_658
    }

    fn rec(day_offset: i64, model: &str, id: &str, input: u64, output: u64) -> UsageRecord {
        UsageRecord {
            id: id.into(),
            day: today() - day_offset,
            model: model.into(),
            session: "session-secret".into(),
            project: "a-private-project-name".into(),
            input,
            output,
            cache_5m: 0,
            cache_1h: 0,
            cache_read: 0,
        }
    }

    #[test]
    fn the_test_anchor_is_the_date_we_think_it_is() {
        assert_eq!(crate::spend::epoch_day_label(today()), "2026-07-24");
    }

    // ── rollup ───────────────────────────────────────────────────────────────────────────

    #[test]
    fn rollup_sums_one_row_per_day_and_model() {
        let recs = [
            rec(0, "claude-opus-5", "a", 100, 10),
            rec(0, "claude-opus-5", "b", 50, 5),
            rec(1, "claude-opus-5", "c", 7, 1),
        ];
        let data = rollup(recs.iter(), today(), 7);
        assert_eq!(data.len(), 2, "two distinct days");
        // Oldest first.
        assert_eq!(data[0].date, "2026-07-23");
        assert_eq!(data[1].date, "2026-07-24");
        let m = &data[1].model_breakdowns[0];
        assert_eq!(m.model_name, "claude-opus-5");
        assert_eq!((m.input_tokens, m.output_tokens), (150, 15));
        assert_eq!(m.total_tokens, 165);
        assert_eq!(m.source, "claude");
    }

    #[test]
    fn rollup_keeps_multi_model_days_as_separate_rows_ordered_by_model() {
        // A day with three models must post three rows, not one merged blob — the server's key is
        // (user, date, model, client_id, source), so collapsing them would lose two thirds of it.
        let recs = [
            rec(0, "claude-sonnet-5", "s", 300, 30),
            rec(0, "claude-opus-5", "o", 100, 10),
            rec(0, "claude-haiku-4-5", "h", 20, 2),
        ];
        let data = rollup(recs.iter(), today(), 7);
        assert_eq!(data.len(), 1);
        let names: Vec<&str> = data[0]
            .model_breakdowns
            .iter()
            .map(|m| m.model_name.as_str())
            .collect();
        assert_eq!(names, vec!["claude-haiku-4-5", "claude-opus-5", "claude-sonnet-5"]);
    }

    #[test]
    fn rollup_dedupes_repeated_message_ids() {
        // Resuming a session copies prior turns into a new transcript. Counting the copy would
        // inflate the public leaderboard number — the exact kind of error that discredits it.
        let recs = [
            rec(0, "claude-opus-5", "msg_1", 100, 0),
            rec(0, "claude-opus-5", "msg_1", 100, 0),
            rec(0, "claude-opus-5", "msg_2", 50, 0),
        ];
        let data = rollup(recs.iter(), today(), 7);
        assert_eq!(data[0].model_breakdowns[0].input_tokens, 150);
    }

    #[test]
    fn rollup_keeps_the_last_copy_of_a_repeated_id_like_the_pane_does() {
        // `load_window_records` hands records oldest-file-first, so the LAST copy of a repeated id
        // is the one the resume wrote — and the one the Spend pane attributes. Keeping the first
        // copy here (what this did before `dedupe_window` was shared) published a different number
        // than the pane showed whenever the copies differed at all.
        let recs = [
            rec(0, "claude-opus-5", "msg_1", 100, 0),
            rec(0, "claude-sonnet-5", "msg_1", 400, 0),
        ];
        let data = rollup(recs.iter(), today(), 7);
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].model_breakdowns.len(), 1, "one turn, one row");
        let m = &data[0].model_breakdowns[0];
        assert_eq!(m.model_name, "claude-sonnet-5");
        assert_eq!(m.input_tokens, 400);
    }

    #[test]
    fn rollup_totals_match_the_spend_panes_totals_over_the_same_records() {
        // The "they can never disagree" invariant, asserted rather than assumed — on EVERY token
        // field and on cost, since the two accumulators map them independently and a mismapped
        // cache field is exactly the drift a totals-only check would miss. The fixture is built to
        // break dedupe/window drift too: a repeated id whose copies carry different counts, plus
        // an out-of-window record both sides must drop. Checked at both ends of the window range
        // the reporter can ask for (its own clamp is MAX_REPORT_DAYS, which the pane also accepts).
        let cached = |day_offset: i64, model: &str, id: &str, input: u64, c5: u64, c1h: u64, cr: u64| {
            UsageRecord {
                cache_5m: c5,
                cache_1h: c1h,
                cache_read: cr,
                ..rec(day_offset, model, id, input, 7)
            }
        };
        // The two msg_2 copies differ in INPUT as well as cache fields, so the absolute assertion
        // below can tell first-wins from last-wins. With identical inputs it could not.
        let recs = [
            cached(0, "claude-opus-5", "msg_1", 100, 11, 22, 33),
            cached(1, "claude-sonnet-5", "msg_2", 30, 1, 2, 3),
            cached(1, "claude-sonnet-5", "msg_2", 90, 4, 5, 6), // resume copy: the one counted
            cached(200, "claude-opus-5", "ancient", 100, 7, 8, 9), // outside every window here
            rec(0, "totally-unknown-model", "unpriced", 1_000, 0),
        ];

        for days in [7u32, MAX_REPORT_DAYS] {
            let pane = crate::spend::aggregate_records(recs.iter(), today(), days);
            let wire = rollup(recs.iter(), today(), days);
            let rows = || wire.iter().flat_map(|d| d.model_breakdowns.iter());
            let sum = |f: fn(&ModelBreakdown) -> u64| rows().map(f).sum::<u64>();

            assert_eq!(sum(|m| m.input_tokens), pane.totals.tokens.input, "{days}d input");
            assert_eq!(sum(|m| m.output_tokens), pane.totals.tokens.output, "{days}d output");
            assert_eq!(
                sum(|m| m.cache_creation_tokens),
                pane.totals.tokens.cache_creation,
                "{days}d cache creation"
            );
            assert_eq!(sum(|m| m.cache_read_tokens), pane.totals.tokens.cache_read, "{days}d cache read");
            assert_eq!(sum(|m| m.total_tokens), pane.totals.tokens.total, "{days}d total");

            let wire_cost: f64 = rows().filter_map(|m| m.cost).sum();
            assert!(
                (wire_cost - pane.totals.estimated_cost_usd).abs() < 1e-9,
                "{days}d cost: {wire_cost} vs {}",
                pane.totals.estimated_cost_usd
            );
            // The unpriced model contributes tokens to both and cost to neither.
            assert!(rows().any(|m| m.model_name == "totally-unknown-model" && m.cost.is_none()));
            assert_eq!(pane.unknown_models, vec!["totally-unknown-model".to_string()]);
        }

        let wire_input: u64 = rollup(recs.iter(), today(), 7)
            .iter()
            .flat_map(|d| d.model_breakdowns.iter())
            .map(|m| m.input_tokens)
            .sum();
        assert_eq!(
            wire_input, 1_190,
            "100 + 90 (the LAST copy of msg_2, not the 30) + 1000 unpriced; `ancient` is out of window"
        );
    }

    #[test]
    fn rollup_windows_out_old_and_future_records() {
        let recs = [
            rec(0, "claude-opus-5", "in", 10, 0),
            rec(30, "claude-opus-5", "old", 999, 0),
            // Clock skew on a synced transcript must not create a row dated after today.
            rec(-2, "claude-opus-5", "future", 500, 0),
        ];
        let data = rollup(recs.iter(), today(), 7);
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].date, "2026-07-24");
        assert_eq!(data[0].model_breakdowns[0].input_tokens, 10);
    }

    #[test]
    fn rollup_omits_idle_days_entirely() {
        // Unlike the Spend pane's contiguous calendar: the server merges `data` by date, so a
        // zero row is noise. One record in a 7-day window ⇒ exactly one day posted.
        let data = rollup([rec(3, "claude-opus-5", "a", 1, 1)].iter(), today(), 7);
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].date, "2026-07-21");
        assert!(rollup([].iter(), today(), 7).is_empty());
    }

    #[test]
    fn rollup_carries_cost_only_for_priced_models() {
        let recs = [
            rec(0, "claude-opus-5", "priced", 1_000_000, 0),
            rec(0, "totally-unknown-model", "unpriced", 1_000_000, 0),
        ];
        let data = rollup(recs.iter(), today(), 7);
        let by_name = |n: &str| {
            data[0]
                .model_breakdowns
                .iter()
                .find(|m| m.model_name == n)
                .unwrap()
        };
        // $5/M input for opus-5.
        assert!((by_name("claude-opus-5").cost.unwrap() - 5.0).abs() < 1e-9);
        // Unknown price ⇒ NO cost key at all (a 0.0 would read as "free").
        assert_eq!(by_name("totally-unknown-model").cost, None);
        assert_eq!(by_name("totally-unknown-model").total_tokens, 1_000_000);
    }

    #[test]
    fn rollup_counts_cache_tokens_in_the_right_buckets() {
        let r = UsageRecord {
            id: "c".into(),
            day: today(),
            model: "claude-opus-5".into(),
            session: "s".into(),
            project: "p".into(),
            input: 1,
            output: 2,
            cache_5m: 40,
            cache_1h: 60,
            cache_read: 500,
        };
        let data = rollup([r].iter(), today(), 7);
        let m = &data[0].model_breakdowns[0];
        // The two TTL buckets sum into the single cacheCreationTokens field the wire has.
        assert_eq!(m.cache_creation_tokens, 100);
        assert_eq!(m.cache_read_tokens, 500);
        assert_eq!(m.total_tokens, 1 + 2 + 100 + 500);
    }

    #[test]
    fn rollup_is_deterministic_for_the_same_input() {
        let recs = [
            rec(2, "claude-sonnet-5", "a", 1, 1),
            rec(0, "claude-opus-5", "b", 1, 1),
            rec(2, "claude-opus-5", "c", 1, 1),
        ];
        let a = serde_json::to_string(&rollup(recs.iter(), today(), 7)).unwrap();
        let b = serde_json::to_string(&rollup(recs.iter(), today(), 7)).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn row_count_counts_every_model_row_not_days() {
        let recs = [
            rec(0, "claude-opus-5", "a", 1, 1),
            rec(0, "claude-sonnet-5", "b", 1, 1),
            rec(1, "claude-opus-5", "c", 1, 1),
        ];
        let data = rollup(recs.iter(), today(), 7);
        assert_eq!(data.len(), 2);
        assert_eq!(row_count(&data), 3);
    }

    // ── payload shape ────────────────────────────────────────────────────────────────────

    #[test]
    fn payload_uses_the_exact_keys_the_tkmx_server_reads() {
        // Locked against tkmx-client v1.3.0 (reporter/report.ts ReportBody, reporter/usage.ts
        // ModelBreakdown). A rename here is invisible at runtime — the server ignores unknown
        // keys — so this test is the only thing standing between a typo and a silently empty
        // profile.
        let body = ReportBody {
            username: "someone".into(),
            team: Some("default".into()),
            client_id: "abc123".into(),
            client_version: "sparkle-desktop/0.0.0".into(),
            report_days: 7,
            data: rollup([rec(0, "claude-opus-5", "a", 100, 10)].iter(), today(), 7),
            // Absent here so the base key set stays the frozen one; the `session_stats` shape has
            // its own tests, and `an_omitted_session_stats_key_is_absent_not_null` covers this half.
            session_stats: None,
            // Absent for the same reason, and covered by `an_omitted_machine_config_key_is_absent`.
            machine_config: None,
        };
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&body).unwrap()).unwrap();

        let mut top: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        top.sort();
        assert_eq!(
            top,
            vec!["client_id", "client_version", "data", "report_days", "team", "username"]
        );

        let day = &v["data"][0];
        let mut day_keys: Vec<&str> = day.as_object().unwrap().keys().map(String::as_str).collect();
        day_keys.sort();
        assert_eq!(day_keys, vec!["date", "modelBreakdowns"]);
        assert_eq!(day["date"], "2026-07-24");

        let m = &day["modelBreakdowns"][0];
        let mut m_keys: Vec<&str> = m.as_object().unwrap().keys().map(String::as_str).collect();
        m_keys.sort();
        assert_eq!(
            m_keys,
            vec![
                "cacheCreationTokens",
                "cacheReadTokens",
                "cost",
                "inputTokens",
                "modelName",
                "outputTokens",
                "source",
                "totalTokens",
            ]
        );
        assert_eq!(m["modelName"], "claude-opus-5");
        assert_eq!(m["inputTokens"], 100);
        assert_eq!(m["outputTokens"], 10);
        assert_eq!(m["totalTokens"], 110);
        assert_eq!(m["source"], "claude");
    }

    #[test]
    fn payload_never_carries_paths_projects_sessions_or_prompts() {
        // The privacy promise, asserted rather than described. The fixture records deliberately
        // carry a project label and a session id; neither may appear anywhere in the JSON.
        let data = rollup(
            [
                rec(0, "claude-opus-5", "a", 100, 10),
                rec(1, "claude-sonnet-5", "b", 5, 5),
            ]
            .iter(),
            today(),
            7,
        );
        let body = ReportBody {
            username: "someone".into(),
            team: Some("default".into()),
            client_id: "abc123".into(),
            client_version: client_version(),
            report_days: 7,
            data: data.clone(),
            // Carried through the privacy check too: the activity blob is built from the SAME
            // records whose session/project labels must not escape. It contains no free strings at
            // all — skills appear only as the `distinct_skills` COUNT — so the category keys and
            // the fixed `source`/`denominator` labels are the whole of what it can spell.
            session_stats: rollup_activity(
                &crate::spend::ActivityTotals {
                    sessions_total: 9,
                    sessions_interactive: 4,
                    subagent_dispatches: 6,
                    plan_mode_sessions: 1,
                    by_category: [("Bash", 10u64), ("Task", 6)].into_iter().collect(),
                    total_calls: 16,
                    distinct_skills: 2,
                },
                false,
                7,
                today(),
            ),
            // And the machine half, which is the newest thing that could leak. Populated on
            // purpose: `None` here would make the assertions below vacuous, since a field that
            // isn't serialized trivially contains no secrets.
            machine_config: build_machine_config(
                &HostFacts {
                    hostname: Some("a-laptop".into()),
                    os_release: Some("25.6.0".into()),
                    cpu_brand: Some("Apple M3 Max".into()),
                    cores: Some(16),
                    memory_bytes: Some(128 * 1_000_000_000),
                },
                Some(vec!["superpowers".to_string()]),
            ),
        };
        let json = serde_json::to_string(&body).unwrap();
        assert!(!json.contains("a-private-project-name"), "{json}");
        assert!(!json.contains("session-secret"), "{json}");
        // No path separators in the usage rows at all. (Checked on `data` rather than the whole
        // body: the body's own strings — username, team, client_id — are user-supplied and are
        // covered by the two assertions above.)
        let rows_json = serde_json::to_string(&data).unwrap();
        assert!(!rows_json.contains('/'), "no path separators in the rows: {rows_json}");

        // The machine half is EXPECTED to be new data on the wire — the profile's "Machines" card
        // renders a per-machine hostname, and the community reporter already publishes one for this
        // same machine. So assert the boundary rather than absence: hostname is there BECAUSE we
        // chose to send it, and nothing beyond the five documented keys came with it.
        let mc = v_of(&body)["machine_config"].clone();
        assert_eq!(mc["hostname"], "a-laptop");
        let mut mc_keys: Vec<&str> = mc.as_object().unwrap().keys().map(String::as_str).collect();
        mc_keys.sort();
        assert_eq!(mc_keys, vec!["claude_skills", "cpu", "hostname", "memory_gb", "os"]);
        // No filesystem path ever reaches it: the manifest is READ from `~/.claude/...`, and only
        // the names inside it travel. A regression that published the path it read, or a per-account
        // config dir, shows up here as a separator.
        let mc_json = serde_json::to_string(&mc).unwrap();
        assert!(!mc_json.contains('/'), "no paths in machine_config: {mc_json}");
        assert!(!mc_json.contains(".claude"), "{mc_json}");
    }

    /// `serde_json::Value` of a body, for tests that assert on the SERIALIZED shape rather than on
    /// the struct — the only view that proves what actually leaves the machine.
    fn v_of(body: &ReportBody) -> serde_json::Value {
        serde_json::from_str(&serde_json::to_string(body).unwrap()).unwrap()
    }

    #[test]
    fn profile_prose_fields_are_omitted_not_blanked() {
        // Sending `tools: ""` / `about: ""` the way the reference client does would BLANK a
        // profile the user filled in from tkmx-client. Omitting the keys leaves them alone.
        let body = ReportBody {
            username: "someone".into(),
            team: Some("default".into()),
            client_id: "abc".into(),
            client_version: "v".into(),
            report_days: 7,
            data: vec![],
            session_stats: None,
            machine_config: None,
        };
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&body).unwrap()).unwrap();
        for k in ["tools", "projects", "communities", "about", "hn_username", "demo_video_url"] {
            assert!(v.get(k).is_none(), "{k} must not be sent");
        }
    }

    // ── client_version: the one field that decides whether ANY of the above is kept ───────

    /// The server's `minimum_client_version`, read from `GET /api/user/<username>` on 2026-08-12.
    /// A profile whose `client_version` parses below this is FROZEN: every post is answered
    /// `200 {"ok":true,...}` and stored as nothing.
    const SERVER_MINIMUM_CLIENT_VERSION: (u64, u64, u64) = (1, 2, 0);

    /// Parse the way tkmx-server does: BARE `major.minor.patch` and nothing else.
    ///
    /// The strictness IS the test. A parser that shrugged off a `sparkle-desktop/` prefix would
    /// re-admit the exact value that held this machine's profile at `tokens_28d: 0` for months —
    /// the server's parser does not shrug, so neither does this one.
    fn parse_bare_semver(s: &str) -> Option<(u64, u64, u64)> {
        let parts: Vec<&str> = s.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        // `u64::from_str` rejects any non-digit, so a prefixed component ("sparkle-desktop/1") or
        // a suffixed one ("0-rc1") fails here rather than being silently truncated to a number.
        Some((parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?))
    }

    #[test]
    fn the_client_version_we_send_parses_as_bare_semver_at_or_above_the_server_minimum() {
        // The property the server actually enforces — asserted as a property, not as the literal
        // "1.3.0", because it is the parse-and-compare that decides whether rows are kept.
        let sent = client_version();
        let parsed = parse_bare_semver(&sent).unwrap_or_else(|| {
            panic!(
                "client_version {sent:?} does not parse as BARE semver — tkmx-server would read it \
                 as below its minimum and FREEZE the profile, keeping none of what we post"
            )
        });
        assert!(
            parsed >= SERVER_MINIMUM_CLIENT_VERSION,
            "client_version {sent:?} parses as {parsed:?}, below the server's \
             minimum_client_version {SERVER_MINIMUM_CLIENT_VERSION:?} — the profile stays FROZEN"
        );

        // CONTROLS — the values this repo really sent while the profile was frozen. Without them
        // the assertions above could be read as vacuous; with them the check is shown to reject
        // BOTH prior forms, which is the whole reason this change exists.
        assert_eq!(
            parse_bare_semver("sparkle-desktop/0.101.0"),
            None,
            "the prefixed form must NOT parse — that is why no app-version bump could ever unfreeze"
        );
        assert_eq!(
            parse_bare_semver("sparkle-desktop/1.3.0"),
            None,
            "measured: even a prefixed 1.3.0 read as frozen, so the prefix is the defect, not the number"
        );
        assert!(
            parse_bare_semver("0.101.0").unwrap() < SERVER_MINIMUM_CLIENT_VERSION,
            "and stripping the prefix ALONE is not the fix: Sparkle's app version is below the gate, \
             so `client_version` cannot be sourced from CARGO_PKG_VERSION at all"
        );
    }

    // ── team: the field the leaderboard GROUPS BY ─────────────────────────────────────────

    #[test]
    fn the_posted_team_comes_from_state_and_is_omitted_when_unset() {
        // Driven through `build_report_body` — the same function `report_once_sync` posts the
        // return value of — rather than a hand-built `ReportBody`, which would assert only that a
        // struct field can hold a string.
        let body = |team: &str| {
            build_report_body(
                &BuilderIndexState {
                    username: "  someone  ".into(),
                    team: team.into(),
                    ..Default::default()
                },
                "abc123".into(),
                7,
                vec![],
                None,
                None,
            )
        };

        // The measured bug: this user's profile and every one of their tkmx-client rows read
        // "Chief", the leaderboard groups by team, and Sparkle hardcoded "default" — filing a
        // consolidated history under a team that does not exist.
        assert_eq!(body("Chief").team.as_deref(), Some("Chief"));
        // Hand-edited JSON is the only way this is set, and "Chief " is its own group server-side.
        assert_eq!(body("  Chief  ").team.as_deref(), Some("Chief"));
        // A machine with no team configured asserts NOTHING — it does not fall back to a generic
        // team name, which would overwrite whatever the server already holds. See
        // `an_unset_team_is_omitted_from_the_payload_not_defaulted` for the serialized proof.
        assert_eq!(body("").team, None);
        assert_eq!(body("   ").team, None);

        // ...and it survives serialization, which is the only form the server ever sees.
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&body("Chief")).unwrap()).unwrap();
        assert_eq!(v["team"], "Chief");
        assert_eq!(v["client_version"], client_version());
        // The rest of the payload is still assembled the same way (username still trimmed).
        assert_eq!(v["username"], "someone");
        assert_eq!(v["client_id"], "abc123");
        assert_eq!(v["report_days"], 7);
    }

    #[test]
    fn an_unset_team_is_omitted_from_the_payload_not_defaulted() {
        // THE MEASURED BUG, third recurrence: a machine with no team configured was sending
        // `team: "default"`, and the server takes a sent value as an assertion — so one unconfigured
        // machine silently REGROUPED the founder's leaderboard row away from "Chief". Omitting the
        // key leaves whatever the server already holds untouched, exactly as the profile-prose
        // fields do (`profile_prose_fields_are_omitted_not_blanked`).
        //
        // Asserted on the SERIALIZED body, never on the struct: `Option<String>` holding `None` is
        // a fact about a field, and only the JSON proves what actually leaves the machine.
        let v = |team: &str| {
            v_of(&build_report_body(
                &BuilderIndexState { team: team.into(), ..Default::default() },
                "abc123".into(),
                7,
                vec![],
                None,
                None,
            ))
        };

        assert!(v("").get("team").is_none(), "an unset team must not reach the wire at all");
        assert!(
            v("   ").get("team").is_none(),
            "whitespace is unset too — it would otherwise assert a team named \" \""
        );
        // A configured team is still sent, still trimmed: "Chief " and "Chief" are different
        // groups server-side, so the trimming is load-bearing rather than cosmetic.
        assert_eq!(v("Chief")["team"], "Chief");
        assert_eq!(v("  Chief  ")["team"], "Chief");
    }

    #[test]
    fn state_written_before_the_team_field_still_loads() {
        let tmp = tempfile::tempdir().unwrap();
        // The exact shape the previous build wrote — no `team` key at all.
        std::fs::write(
            tmp.path().join("builder-index.json"),
            r#"{
  "username": "sam",
  "client_id": "deadbeef",
  "consented_at": 1700000000,
  "last_report_at": 1700000100,
  "last_status": "Reported 3 row(s) across 2 day(s).",
  "report_days": 14
}"#,
        )
        .unwrap();

        // A field added without a default would fail the whole parse, and `load_state` degrades a
        // failed parse to `Default` — silently un-consenting the user and unpinning the client_id
        // that must never change. So this asserts every OTHER field survives, not just the new one.
        let loaded = load_state(tmp.path());
        assert_eq!(loaded.username, "sam");
        assert_eq!(loaded.client_id, "deadbeef");
        assert_eq!(loaded.consented_at, Some(1_700_000_000));
        assert_eq!(loaded.last_report_at, Some(1_700_000_100));
        assert_eq!(loaded.last_status.as_deref(), Some("Reported 3 row(s) across 2 day(s)."));
        assert_eq!(loaded.report_days, 14);
        assert_eq!(loaded.team, "", "an absent key stays empty — never a guess");
        assert_eq!(loaded.team(), None, "...and an empty setting sends nothing at all");

        // Round-trip: rewriting the file keeps every field and adds the new one as an empty string
        // rather than dropping it, so the user has something to edit.
        save_state(tmp.path(), &loaded).unwrap();
        assert_eq!(load_state(tmp.path()), loaded);
        let raw = std::fs::read_to_string(tmp.path().join("builder-index.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["team"], "");
        assert_eq!(v["username"], "sam");
        assert_eq!(v["client_id"], "deadbeef");
    }

    // ── machine_config + the SKILLS row ──────────────────────────────────────────────────

    /// Write a `<home>/.claude/plugins/installed_plugins.json` holding `ids`, and return the home.
    fn home_with_manifest(dir: &Path, ids: &[&str]) -> PathBuf {
        let home = dir.join("home");
        let plugins = home.join(".claude").join("plugins");
        std::fs::create_dir_all(&plugins).unwrap();
        let entries: Vec<String> = ids.iter().map(|id| format!("{id:?}:[{{\"scope\":\"user\"}}]")).collect();
        std::fs::write(
            plugins.join("installed_plugins.json"),
            format!("{{\"version\":2,\"plugins\":{{{}}}}}", entries.join(",")),
        )
        .unwrap();
        home
    }

    /// A body carrying exactly this skills list, serialized — the only view that proves what leaves
    /// the machine. Asserting on an intermediate `Vec` would pass even if the field never shipped.
    fn payload_with_skills(skills: Option<Vec<String>>) -> serde_json::Value {
        v_of(&ReportBody {
            username: "someone".into(),
            team: Some("default".into()),
            client_id: "abc".into(),
            client_version: "v".into(),
            report_days: 7,
            data: vec![],
            session_stats: None,
            machine_config: build_machine_config(
                &HostFacts { hostname: Some("a-laptop".into()), ..HostFacts::default() },
                skills,
            ),
        })
    }

    #[test]
    fn an_excluded_name_is_absent_from_the_serialized_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let home = home_with_manifest(
            tmp.path(),
            &["superpowers@claude-plugins-official", "warp@claude-code-warp"],
        );

        let names = collect_claude_skills(&reporting_manifest_path(&home)).expect("a readable manifest");
        assert_eq!(names, vec!["superpowers".to_string(), "warp".to_string()], "both installed");

        // The side effect that matters: the name is gone from the JSON that would be POSTed, not
        // merely from some intermediate list. `claude_skills` is replaced wholesale server-side, so
        // this absence IS the badge disappearing from the profile.
        let json = payload_with_skills(Some(apply_skill_exclusions(names, &["warp".to_string()])));
        assert_eq!(json["machine_config"]["claude_skills"], serde_json::json!(["superpowers"]));
        assert!(
            !serde_json::to_string(&json).unwrap().contains("warp"),
            "the excluded name must not appear anywhere on the wire: {json}"
        );
    }

    #[test]
    fn exclusion_is_case_insensitive_and_whitespace_trimmed() {
        // Both sides normalize, and both sides go through config's `normalize_skill_name`, because
        // the community reporter's `applyExclusions` does `.trim().toLowerCase()` on both. The two
        // post to the same profile alternately, so a mismatch here doesn't merely fail to exclude —
        // it makes the badge flap every couple of hours.
        let tmp = tempfile::tempdir().unwrap();
        let home = home_with_manifest(tmp.path(), &["Warp@claude-code-warp", "superpowers@official"]);
        let names = collect_claude_skills(&reporting_manifest_path(&home)).unwrap();

        // `" WARP "` as the user typed it, resolved through the real config path.
        let (cfg, warns, _) = crate::config::test_effective(
            Some("[builder_index]\nskills_exclude = [\" WARP \"]\n"),
            None,
        );
        assert!(warns.is_empty(), "a well-formed list warns about nothing: {warns:?}");
        let json = payload_with_skills(Some(apply_skill_exclusions(
            names,
            &cfg.builder_index.skills_exclude,
        )));
        assert_eq!(json["machine_config"]["claude_skills"], serde_json::json!(["superpowers"]));
    }

    #[test]
    fn a_name_not_in_the_manifest_is_never_published() {
        // The ALLOWLIST, which is the manifest itself. Nothing scans transcripts, a skills
        // directory, or the marketplace cache, so a name the user never installed has no path onto
        // the profile even though this machine's transcripts are full of it.
        let tmp = tempfile::tempdir().unwrap();
        let home = home_with_manifest(tmp.path(), &["superpowers@claude-plugins-official"]);
        let json = payload_with_skills(collect_claude_skills(&reporting_manifest_path(&home)));
        assert_eq!(json["machine_config"]["claude_skills"], serde_json::json!(["superpowers"]));
        assert!(!serde_json::to_string(&json).unwrap().contains("systematic-debugging"));
    }

    #[test]
    fn reporting_reads_the_manifest_only_never_the_marketplace_cache() {
        // DIVERGENCE 1 from `hooks::observe_installed_plugins`, pinned so a later refactor cannot
        // quietly "unify" the two readers on the strength of them sharing a parser.
        //
        // WHY: that function UNIONS the manifest with a `cache/<marketplace>/<plugin>/` scan, which
        // is correct for ITS caller — an install-skip decision may safely over-report what is
        // present. It is wrong for REPORTING: the cache holds `temp_git_*` clones and plugins the
        // user believes they uninstalled, so a cache-only entry is not evidence of an installed
        // plugin — it is exactly the kind of stale name a public profile should not grow.
        // NOT because "tkmx-client reports the manifest only" — an earlier version of this comment
        // said that and it is false; see `collect_claude_skills`, which records what was measured.
        let tmp = tempfile::tempdir().unwrap();
        let home = home_with_manifest(tmp.path(), &["superpowers@claude-plugins-official"]);
        // A stale payload for a plugin the manifest does NOT list — e.g. one the user uninstalled.
        std::fs::create_dir_all(home.join(".claude/plugins/cache/claude-code-warp/warp")).unwrap();

        let names = collect_claude_skills(&reporting_manifest_path(&home)).unwrap();
        assert_eq!(names, vec!["superpowers".to_string()]);
        assert!(!names.iter().any(|n| n == "warp"), "the cache dir must not be a source: {names:?}");
    }

    #[test]
    fn reporting_never_publishes_a_personal_skill_directory() {
        // DIVERGENCE 3 — and this one is a divergence from the COMMUNITY REPORTER, not from
        // `hooks`. It is pinned because it is the one place Sparkle knowingly sends a SUBSET of
        // what the other writer sends, and because the comment that used to sit here asserted the
        // opposite of the truth.
        //
        // MEASURED on tkmx-client `origin/main`: `collectClaudeSkills` unions the plugin manifest
        // with every `~/.claude/skills/<name>/SKILL.md` directory (`collectPersonalSkills`), and
        // `collectMachineConfig` unions the configured MCP server names after that. Sparkle
        // publishes the manifest ONLY — the founder's explicit "must be backed by an installed
        // plugin" rule.
        //
        // So this test does NOT claim the two reporters agree. It claims the narrowing is
        // DELIBERATE: widening it puts new names on a PUBLIC profile, so it must be a decision
        // someone makes and re-points this test at, never a silent side effect of "unifying" the
        // readers. The cost of the narrowing is recorded on `collect_claude_skills`.
        //
        // IT DRIVES `reported_skills_from`, NOT `collect_claude_skills`, and the altitude is the
        // whole point. `collect_claude_skills` only ever receives the MANIFEST PATH, so a personal-
        // skills union could not be written there without reconstructing `$HOME` by walking parents
        // or changing the signature — whereas `reported_skills_from` already holds `home` and is
        // where such a union goes naturally. Pinned at the lower altitude, this test stayed green
        // against exactly the change it exists to catch.
        let tmp = tempfile::tempdir().unwrap();
        let home = home_with_manifest(tmp.path(), &["superpowers@claude-plugins-official"]);
        // A personal skill exactly as tkmx-client recognizes one: a directory holding a SKILL.md.
        let personal = home.join(".claude").join("skills").join("clerk-webhooks");
        std::fs::create_dir_all(&personal).unwrap();
        std::fs::write(personal.join("SKILL.md"), "# clerk-webhooks\n").unwrap();

        // Assert on the SERIALIZED payload — the only view that proves what leaves the machine.
        let json = payload_with_skills(reported_skills_from(&home, &[]));
        assert_eq!(json["machine_config"]["claude_skills"], serde_json::json!(["superpowers"]));
        assert!(
            !serde_json::to_string(&json).unwrap().contains("clerk-webhooks"),
            "a ~/.claude/skills directory must not reach the wire: {json}"
        );
    }

    #[test]
    fn the_denylist_is_applied_on_the_path_the_reporter_actually_takes() {
        // `apply_skill_exclusions` has its own unit tests, but they call it directly — so they stay
        // green even if the composition stops calling it at all. This drives the same function the
        // live reporter does, one lookup below `reported_skills`, and is what proves the denylist
        // is actually WIRED rather than merely correct in isolation. Two names in, one excluded, so
        // the assertion distinguishes "the exclusion ran" from "the list happens to be short".
        let tmp = tempfile::tempdir().unwrap();
        let home = home_with_manifest(
            tmp.path(),
            &["superpowers@claude-plugins-official", "warp@claude-code-warp"],
        );

        let kept = reported_skills_from(&home, &[]).expect("a readable manifest must report");
        assert_eq!(kept, vec!["superpowers".to_string(), "warp".to_string()]);

        let denied = reported_skills_from(&home, &["warp".to_string()])
            .expect("a denylist must subtract, never suppress the whole report");
        assert_eq!(
            denied,
            vec!["superpowers".to_string()],
            "the `warp` badge must be droppable by the denylist alone"
        );
    }

    #[test]
    fn reporting_reads_the_fixed_home_claude_path_not_claude_config_dir() {
        // DIVERGENCE 2 from `hooks::claude_plugins_dir`, pinned for the same reason.
        //
        // WHY: that helper honours `CLAUDE_CONFIG_DIR` because the install-skip check must look
        // where the `claude plugin install` child actually wrote. REPORTING must instead agree with
        // tkmx-client, whose `DEFAULT_MANIFEST` is `~/.claude/plugins/installed_plugins.json`
        // unconditionally. If the two reporters read different trees they publish different lists,
        // and the wholesale server-side replace makes the SKILLS row alternate between them.
        let tmp = tempfile::tempdir().unwrap();
        let home = home_with_manifest(tmp.path(), &["superpowers@claude-plugins-official"]);
        // A rival per-account manifest, deliberately placed UNDER `home` so it is REACHABLE from the
        // only input this test hands the reader. An earlier version of this fixture sat in a sibling
        // of `home` (`tmp/account-2/…`), where no path derivable from `home` could ever reach it —
        // dead setup that a comment nonetheless credited with giving the assertion its teeth.
        let account = home.join(".claude").join("accounts").join("account-2").join("plugins");
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(
            account.join("installed_plugins.json"),
            r#"{"plugins":{"only-in-the-account-store@x":[]}}"#,
        )
        .unwrap();

        // WHAT THIS PINS: that the reporter reads the ONE fixed manifest and does not union or
        // prefer a per-account tree under `$HOME`. That is a real widening path — `hooks` already
        // enumerates per-account plugin trees — and the rival manifest above is what makes the
        // second assertion able to fail: a reader that grew that logic returns
        // `only-in-the-account-store`, not `superpowers`.
        //
        // WHAT THIS DOES NOT PIN, stated plainly so the next reader does not trust it further than
        // it goes: env-awareness. A body that kept `home: &Path` and consulted `CLAUDE_CONFIG_DIR`
        // only when set would compile against this call site unchanged and, with the variable unset
        // here, fall through to `home/.claude` and leave both assertions green. There is no way to
        // close that without mutating process env — and doing so is worse than the hole: `cargo
        // test` runs this binary across threads and `CLAUDE_CONFIG_DIR` is memoized in a `OnceLock`
        // by `claude::effective_spawn_config_dir`, so setting it here can poison an unrelated test
        // for the whole run, an intermittent failure with no visible connection to this file. The
        // env divergence is instead pinned on the `hooks` side, which is the half that reads it.
        let path = reporting_manifest_path(&home);
        let names = collect_claude_skills(&path);

        assert_eq!(path, home.join(".claude").join("plugins").join("installed_plugins.json"));
        assert_eq!(names, Some(vec!["superpowers".to_string()]));

        // ...and the path is a function of its ARGUMENT alone: a different home yields the
        // correspondingly different path, so a reader that pinned one absolute location (or cached
        // the first home it saw) fails here rather than in production on a second account.
        let other = tmp.path().join("other-home");
        assert_eq!(
            reporting_manifest_path(&other),
            other.join(".claude").join("plugins").join("installed_plugins.json")
        );
    }

    #[test]
    fn a_missing_or_malformed_manifest_omits_the_row_rather_than_clearing_it() {
        // The distinction the whole design rests on. `claude_skills` REPLACES the profile's row, so
        // "we could not look" must serialize as an ABSENT key — an empty array would wipe a list
        // the other reporter (or an earlier cycle) correctly published.
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join(".claude").join("plugins")).unwrap();
        let manifest = reporting_manifest_path(&home);

        assert_eq!(collect_claude_skills(&manifest), None, "absent manifest");
        let json = payload_with_skills(collect_claude_skills(&manifest));
        assert!(
            json["machine_config"].as_object().unwrap().get("claude_skills").is_none(),
            "an unreadable manifest must omit the key, not send []: {json}"
        );

        std::fs::write(&manifest, "{ truncated").unwrap();
        assert_eq!(collect_claude_skills(&manifest), None, "malformed manifest");

        // But a manifest that PARSES and lists nothing is real knowledge: send `[]`, which clears
        // the row. That is the only way a denylist can remove the last remaining badge, so it has
        // to stay reachable.
        std::fs::write(&manifest, r#"{"version":2,"plugins":{}}"#).unwrap();
        assert_eq!(collect_claude_skills(&manifest), Some(Vec::new()));
        let json = payload_with_skills(collect_claude_skills(&manifest));
        assert_eq!(json["machine_config"]["claude_skills"], serde_json::json!([]));
    }

    #[test]
    fn an_omitted_machine_config_key_is_absent() {
        // `machine_config: None` must vanish from the payload rather than serialize as `null` — the
        // same rule `session_stats` follows, and for the same reason: the server reads the key, and
        // a null is a value.
        let json = v_of(&ReportBody {
            username: "someone".into(),
            team: Some("default".into()),
            client_id: "abc".into(),
            client_version: "v".into(),
            report_days: 7,
            data: vec![],
            session_stats: None,
            machine_config: None,
        });
        assert!(
            !json.as_object().unwrap().contains_key("machine_config"),
            "the key must be absent, not null: {json}"
        );
        // And nothing to report really does produce `None`, rather than a shell of empty strings
        // that would overwrite a good "Machines" card with a blank one.
        assert_eq!(build_machine_config(&HostFacts::default(), None), None);

        // THE PAIRED HALF, and the one doing the mutation work here: an unreadable HOSTNAME
        // suppresses the object even when there IS a skills list to publish. Deleting the `?` (or
        // widening the guard back to "only when we learned nothing at all") builds the struct from
        // defaults instead — `hostname: ""`, `cpu: ""`, `memory_gb` absent — and since the server
        // replaces `machine_config` wholesale, that POST degrades a correct card to an
        // unattributable blank. `.is_some()` cannot see that, so assert the ABSENCE of the object.
        //
        // (The mirror case — hostname present, skills absent — is deliberately NOT re-asserted
        // here: `the_machine_facts_mirror_the_reference_clients_formatting` below and
        // `payload_with_skills` both already call this function that way and `.expect()` the
        // result, so a guard inverted to reject a hostname-only machine reds those instead. One
        // more copy here would add no coverage and would read as if it were closing a hole.)
        assert_eq!(
            build_machine_config(&HostFacts::default(), Some(vec!["superpowers".into()])),
            None,
            "no hostname means the record cannot be attributed to a machine — omit it entirely \
             rather than blanking the card this machine already has"
        );

        // A hostname alone IS reportable, and what it publishes must be facts, never placeholders.
        // Asserted on the serialized JSON because that is what the server replaces the card with:
        // an intermediate struct with `memory_gb: None` is fine, a wire `"memory_gb": 0` is a claim
        // that this machine has no RAM.
        assert!(
            build_machine_config(
                &HostFacts { hostname: Some("a-laptop".into()), ..HostFacts::default() },
                None
            )
            .is_some(),
            "a readable hostname is reportable even when nothing else is"
        );
        // `payload_with_skills` builds from exactly that fact set — a hostname and nothing else —
        // so this reads the machine half off a whole serialized report, the way the server sees it.
        let mc = payload_with_skills(None)["machine_config"].clone();
        assert_eq!(mc["hostname"], "a-laptop");
        // The CPU falls back to the hostname rather than going blank, so no empty string ships.
        assert_eq!(mc["cpu"], "a-laptop");
        assert!(
            mc.as_object().unwrap().get("memory_gb").is_none(),
            "an unreadable memory size must be OMITTED, never sent as 0: {mc}"
        );
        for (key, value) in mc.as_object().unwrap() {
            assert_ne!(value.as_str(), Some(""), "`{key}` shipped as an empty string: {mc}");
        }
    }

    #[test]
    fn the_platform_token_table_is_nodes_spelling_not_rusts() {
        // Literals on BOTH sides, and the input is an argument rather than the host's own constant,
        // so every arm is reachable from every host and none of these can be satisfied by the
        // implementation restating itself. Verified against the reference on a mac:
        // `node -e 'console.log(os.platform())'` prints `darwin`, not Rust's `macos`.
        assert_eq!(platform_token_for("macos"), "darwin", "Node calls it darwin");
        assert_eq!(platform_token_for("windows"), "win32", "Node calls it win32");
        // The pass-through the doc's "not silently renamed" claim rests on: where the two runtimes
        // already agree, nothing is rewritten.
        assert_eq!(platform_token_for("linux"), "linux");
        assert_eq!(platform_token_for("freebsd"), "freebsd");
        // And the real host goes through the same table, so the wire value can't bypass it.
        assert_eq!(platform_token(), platform_token_for(std::env::consts::OS));
    }

    #[test]
    fn the_machine_facts_mirror_the_reference_clients_formatting() {
        // Same machine, same strings: the two reporters overwrite each other's `machine_config`, so
        // a differently-formatted `cpu` or `os` would make the "Machines" card flip between two
        // spellings of the same truth.
        let mc = build_machine_config(
            &HostFacts {
                hostname: Some("a-laptop".into()),
                os_release: Some("25.6.0".into()),
                cpu_brand: Some("Apple M3 Max".into()),
                cores: Some(16),
                memory_bytes: Some(128 * 1_000_000_000),
            },
            None,
        )
        .expect("a hostname is enough to report");
        assert_eq!(mc.cpu, "Apple M3 Max (16 cores)");
        // Pinned to the LITERAL the reference client sends, not to `std::env::consts::OS`. Written
        // the latter way this assertion restated the implementation's own expression, so it was
        // green for whatever the code happened to produce — and it stayed green while the field
        // shipped Rust's `"macos"` against the contract's Node `"darwin"`. Verified against the
        // reference on this machine: `os.platform() + " " + os.release()` == "darwin 25.6.0".
        // Only asserted on macOS, and with a LITERAL — this covers the COMPOSITION (token + space +
        // release). The mapping table itself is covered host-independently by
        // `the_platform_token_table_is_nodes_spelling_not_rusts`; there is deliberately no
        // `cfg(not(macos))` arm here, because the only thing such an arm could compare `mc.os`
        // against is `platform_token()`'s own output, which is the vacuous form this test exists to
        // demonstrate the absence of.
        #[cfg(target_os = "macos")]
        assert_eq!(mc.os, "darwin 25.6.0", "the reference client sends Node's platform token");
        assert_eq!(mc.memory_gb, Some(128));

        // An unreadable CPU model falls back to the hostname, as the reference client does, so two
        // machines stay distinguishable on the card.
        let unknown = build_machine_config(
            &HostFacts {
                hostname: Some("a-laptop".into()),
                cpu_brand: Some("unknown".into()),
                cores: Some(4),
                ..HostFacts::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(unknown.cpu, "a-laptop (4 cores)");
    }

    // ── consent gate ─────────────────────────────────────────────────────────────────────

    #[test]
    fn a_disabled_toggle_blocks_reporting_even_when_fully_configured() {
        // The headline guarantee: off means no network, whatever else is stored.
        assert_eq!(consent_gate(false, true, true, true), Err(SkipReason::Disabled));
        assert_eq!(consent_gate(false, false, false, false), Err(SkipReason::Disabled));
    }

    #[test]
    fn consent_is_required_even_when_enabled_and_configured() {
        assert_eq!(consent_gate(true, false, true, true), Err(SkipReason::NoConsent));
    }

    #[test]
    fn missing_credentials_block_reporting() {
        assert_eq!(consent_gate(true, true, false, true), Err(SkipReason::NoUsername));
        assert_eq!(consent_gate(true, true, true, false), Err(SkipReason::NoApiKey));
    }

    #[test]
    fn the_gate_opens_only_when_all_four_conditions_hold() {
        assert_eq!(consent_gate(true, true, true, true), Ok(()));
    }

    #[test]
    fn a_gated_cycle_never_reaches_for_the_keychain() {
        // The commit's headline property, pinned about `report_once_sync` rather than about the
        // pure helper's shape — otherwise a later edit that precomputes `has_api_key` above the
        // gate silently reintroduces the macOS auth prompt for a never-opted-in install, and no
        // test notices. (roborev 48168/48167)
        let tmp = tempfile::tempdir().unwrap();
        let before = KEYCHAIN_READS.load(Ordering::SeqCst);

        // Disabled.
        report_once_sync(tmp.path().to_path_buf(), false).unwrap();
        // Enabled, but never consented.
        save_state(
            tmp.path(),
            &BuilderIndexState { username: "sam".into(), ..Default::default() },
        )
        .unwrap();
        report_once_sync(tmp.path().to_path_buf(), true).unwrap();
        // Consented, but no username.
        save_state(
            tmp.path(),
            &BuilderIndexState { consented_at: Some(1), ..Default::default() },
        )
        .unwrap();
        report_once_sync(tmp.path().to_path_buf(), true).unwrap();

        assert_eq!(
            KEYCHAIN_READS.load(Ordering::SeqCst),
            before,
            "a gated cycle must not read the keychain"
        );
    }

    #[test]
    fn a_gated_cycle_skips_without_touching_the_network() {
        // report_once_sync with `enabled = false` must return Skipped before it can scan or POST.
        // (There is no server in a unit test, so a POST attempt would surface as an Err.)
        let tmp = tempfile::tempdir().unwrap();
        let out = report_once_sync(tmp.path().to_path_buf(), false).unwrap();
        assert_eq!(out, ReportOutcome::Skipped(SkipReason::Disabled));
        // ...and it wrote no state file, so a disabled install leaves no reporting footprint.
        assert!(!tmp.path().join("builder-index.json").exists());
    }

    #[test]
    fn an_enabled_but_unconsented_cycle_also_skips() {
        let tmp = tempfile::tempdir().unwrap();
        let state = BuilderIndexState {
            username: "someone".into(),
            ..Default::default()
        };
        save_state(tmp.path(), &state).unwrap();
        let out = report_once_sync(tmp.path().to_path_buf(), true).unwrap();
        assert_eq!(out, ReportOutcome::Skipped(SkipReason::NoConsent));
    }

    // ── state ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn missing_or_corrupt_state_fails_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let fresh = load_state(tmp.path());
        assert_eq!(fresh, BuilderIndexState::default());
        assert!(fresh.consented_at.is_none(), "never consented by default");

        std::fs::write(tmp.path().join("builder-index.json"), "{ not json").unwrap();
        assert_eq!(load_state(tmp.path()), BuilderIndexState::default());
    }

    #[test]
    fn state_round_trips_and_forward_compatible_keys_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let state = BuilderIndexState {
            username: "sam".into(),
            client_id: "deadbeef".into(),
            consented_at: Some(1_700_000_000),
            last_report_at: Some(1_700_000_100),
            last_status: Some("Reported 3 row(s) across 2 day(s).".into()),
            report_days: 14,
            team: "Chief".into(),
        };
        save_state(tmp.path(), &state).unwrap();
        assert_eq!(load_state(tmp.path()), state);

        // A key written by a newer build must not reset the whole file to defaults.
        std::fs::write(
            tmp.path().join("builder-index.json"),
            r#"{"username":"sam","some_future_key":true}"#,
        )
        .unwrap();
        assert_eq!(load_state(tmp.path()).username, "sam");
    }

    #[test]
    fn the_report_window_defaults_and_clamps() {
        let d = |n: u32| BuilderIndexState { report_days: n, ..Default::default() }.window();
        assert_eq!(d(0), DEFAULT_REPORT_DAYS);
        assert_eq!(d(1), 1);
        assert_eq!(d(14), 14);
        assert_eq!(d(9_999), MAX_REPORT_DAYS);
    }

    // ── client id ────────────────────────────────────────────────────────────────────────

    #[test]
    fn client_id_matches_the_reference_clients_derivation() {
        // sha256("MACHINE|user") truncated to 32 hex chars — the same value tkmx-client's
        // deriveClientId produces, so migrating users keep their machine identity (and their
        // rows keep merging instead of double-counting).
        let id = derive_client_id("MACHINE", "user");
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        let expected = {
            let mut h = Sha256::new();
            h.update(b"MACHINE|user");
            let full: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
            full[..32].to_string()
        };
        assert_eq!(id, expected);
    }

    #[test]
    fn client_id_is_stable_per_machine_and_username() {
        assert_eq!(derive_client_id("m", "a"), derive_client_id("m", "a"));
        assert_ne!(derive_client_id("m", "a"), derive_client_id("m", "b"));
        assert_ne!(derive_client_id("m1", "a"), derive_client_id("m2", "a"));
    }

    #[test]
    fn ensure_client_id_pins_the_first_derivation() {
        // A later machine-id read failure must NOT mint a second id: the server keys rows on it,
        // and a "new machine" makes every overlapping day double-count on the public profile.
        let tmp = tempfile::tempdir().unwrap();
        let mut state = BuilderIndexState { username: "sam".into(), ..Default::default() };
        let first = ensure_client_id(tmp.path(), &mut state);
        assert!(!first.is_empty());
        // Reload from disk — the pin must have been persisted, not just held in memory.
        let mut reloaded = load_state(tmp.path());
        assert_eq!(ensure_client_id(tmp.path(), &mut reloaded), first);
    }

    #[test]
    fn machine_id_parsers_read_the_real_command_output() {
        let ioreg = r#"+-o Root  <class IORegistryEntry, id 0x100000100, retain 39>
    "IOPlatformUUID" = "F1D2D2F9-24E6-4A1B-9A0C-1A2B3C4D5E6F"
    "IOPlatformSerialNumber" = "C02XY1234567"
"#;
        assert_eq!(
            extract_io_platform_uuid(ioreg).as_deref(),
            Some("F1D2D2F9-24E6-4A1B-9A0C-1A2B3C4D5E6F")
        );
        assert_eq!(extract_io_platform_uuid("nothing here"), None);

        let reg = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    12345678-90ab-cdef-1234-567890abcdef\r\n\r\n";
        assert_eq!(
            extract_machine_guid(reg).as_deref(),
            Some("12345678-90ab-cdef-1234-567890abcdef")
        );
        assert_eq!(extract_machine_guid("MachineGuid REG_DWORD 5"), None);
    }

    // ── outcome wire shape ───────────────────────────────────────────────────────────────

    #[test]
    fn report_outcome_serializes_as_a_tagged_object() {
        let posted = serde_json::to_value(ReportOutcome::Posted {
            rows: 12,
            days: 7,
            truncated: false,
            notice: None,
        })
        .unwrap();
        assert_eq!(posted["status"], "posted");
        assert_eq!(posted["rows"], 12);
        assert_eq!(posted["days"], 7);
        // `truncated` must cross the IPC boundary: the modal shows the fresh outcome and suppresses
        // `last_status`, so without it a capped (understated) scan reads as a clean report on the
        // only surface the user actually looks at. (roborev 47899)
        assert_eq!(posted["truncated"], false);
        assert_eq!(posted["notice"], serde_json::Value::Null);
        let partial = serde_json::to_value(ReportOutcome::Posted {
            rows: 1,
            days: 1,
            truncated: true,
            notice: Some("Your tkmx-client is outdated".into()),
        })
        .unwrap();
        assert_eq!(partial["truncated"], true);
        // Same reasoning as `truncated`: the nag has to reach the modal, which is the only surface
        // the user reads. A warning that lives solely in `last_status` is one the modal suppresses.
        assert_eq!(partial["notice"], "Your tkmx-client is outdated");

        let skipped = serde_json::to_value(ReportOutcome::Skipped(SkipReason::Disabled)).unwrap();
        assert_eq!(skipped["status"], "skipped");
        assert_eq!(skipped["reason"], "Builder Index is off");
    }

    #[test]
    fn the_api_host_is_the_reporting_host_not_the_profile_site() {
        // Verified against tkmx-client v1.3.0 reporter/report.ts: SERVER_URL defaults to the
        // odio.dev API host; watchmepivot.com serves the human-facing profile only.
        assert_eq!(DEFAULT_SERVER_URL, "https://tokenmaxxing.odio.dev");
        assert!(!DEFAULT_SERVER_URL.contains("watchmepivot"));
    }

    #[test]
    fn a_report_write_preserves_fields_the_reporter_does_not_own() {
        // The race this guards: `report_once_sync` snapshots state, then spends a scan + a 20s POST
        // before writing back. A "Turn off and forget" landing in that window used to be UNDONE —
        // the reporter restored username, client_id, and (worst) consented_at, silently
        // re-recording a consent the user had just withdrawn. `record_outcome` re-reads first and
        // touches only its own two fields. (roborev 47458)
        let tmp = tempfile::tempdir().unwrap();
        save_state(
            tmp.path(),
            &BuilderIndexState {
                username: "old".into(),
                client_id: "old-id".into(),
                consented_at: Some(1),
                ..Default::default()
            },
        )
        .unwrap();

        // …the user forgets everything while a cycle is in flight…
        save_state(tmp.path(), &BuilderIndexState::default()).unwrap();
        // …and the in-flight cycle then records its outcome.
        record_outcome(tmp.path(), Some(1_700_000_000), "Reported 3 row(s).".into());

        // NOTHING is written. `builder_index_forget` is complete erasure, so leaving behind
        // "Reported 3 row(s)" and a timestamp tied to the deleted identity — which the modal would
        // then show on the next open — is its own privacy defect, not just cosmetic.
        // (roborev 47904/47899)
        assert_eq!(load_state(tmp.path()), BuilderIndexState::default());
    }

    #[test]
    fn a_report_write_lands_when_consent_is_still_in_place() {
        // The other half of the bail-on-withdrawn rule: a normal cycle must still record itself,
        // and must not disturb the user-owned fields it read.
        let tmp = tempfile::tempdir().unwrap();
        save_state(
            tmp.path(),
            &BuilderIndexState {
                username: "sam".into(),
                client_id: "pinned".into(),
                consented_at: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        record_outcome(tmp.path(), Some(1_700_000_000), "Reported 3 row(s).".into());

        let after = load_state(tmp.path());
        assert_eq!(after.last_report_at, Some(1_700_000_000));
        assert_eq!(after.last_status.as_deref(), Some("Reported 3 row(s)."));
        assert_eq!(after.username, "sam");
        assert_eq!(after.client_id, "pinned");
        assert_eq!(after.consented_at, Some(5));
    }

    #[test]
    fn a_200_with_an_error_payload_is_not_treated_as_success() {
        // tkmx-server can answer 200 with a failure body. Recording "Reported N rows" then sends
        // the user to a profile that never updates, with no diagnostic. (roborev 47458)
        assert_eq!(
            server_side_error(r#"{"success":false,"error":"unknown user"}"#).as_deref(),
            Some("unknown user")
        );
        // A bare negative with no message still fails — with a generic reason rather than nothing.
        assert_eq!(
            server_side_error(r#"{"success":false}"#).as_deref(),
            Some("the server reported a failure")
        );
        assert_eq!(server_side_error(r#"{"error":"profile frozen"}"#).as_deref(), Some("profile frozen"));
        // Shapes a proxy or a future server version might use — recognizing only two of them meant
        // the rest fell through as success, which is the "profile never updates, no diagnostic"
        // outcome this check exists to prevent. (roborev 47904)
        assert!(server_side_error(r#"{"ok":false}"#).is_some());
        assert_eq!(
            server_side_error(r#"{"status":"error","message":"rate limited"}"#).as_deref(),
            Some("rate limited")
        );
        assert_eq!(
            server_side_error(r#"{"error":{"message":"unknown user"}}"#).as_deref(),
            Some("unknown user")
        );
        // Happy paths and anything we don't recognize are NOT failures — the success body isn't a
        // documented contract, so only an unambiguous marker counts.
        assert_eq!(server_side_error(r#"{"ok":true}"#), None);
        assert_eq!(server_side_error(r#"{"client_update":"1.4.0"}"#), None);
        assert_eq!(server_side_error(r#"{"error":null}"#), None);
        assert_eq!(server_side_error(r#"{"error":""}"#), None);
        assert_eq!(server_side_error(""), None);
        assert_eq!(server_side_error("not json at all"), None);
    }

    #[test]
    fn a_non_https_server_override_is_refused() {
        // The request carries `Authorization: Bearer <api key>`, so an unvalidated env override is
        // a key-exfiltration primitive for anything that can seed the environment. (roborev 47458)
        assert!(is_safe_override("https://staging.example.com"));
        assert!(is_safe_override("http://localhost:8080"));
        assert!(is_safe_override("http://127.0.0.1:8080"));
        // The documented IPv6 loopback case: splitting on ':' before peeling the bracket yielded a
        // bare "[", so this branch was unreachable and the doc comment was a lie. (roborev 47899)
        assert!(is_safe_override("http://[::1]:8080"));
        assert!(is_safe_override("http://[::1]/api"));
        assert!(!is_safe_override("http://[::2]:8080"));
        assert!(!is_safe_override("http://evil.example.com"));
        assert!(!is_safe_override("http://localhost.evil.example.com"));
        assert!(!is_safe_override("ftp://example.com"));
        assert!(!is_safe_override("example.com"));
        assert!(!is_safe_override("https://"));
    }

    #[test]
    fn jitter_stays_inside_its_spread_and_is_not_a_clock_function() {
        let samples: Vec<u64> = (0..64).map(|_| jitter_secs()).collect();
        assert!(samples.iter().all(|j| *j < JITTER_SPREAD_SECS));
        // A clock-derived "jitter" returns the same value for every call inside one second, which
        // is the synchronized herd it was supposed to prevent. (roborev 47460)
        assert!(
            samples.iter().any(|j| *j != samples[0]),
            "jitter must actually vary"
        );
    }

    #[test]
    fn the_pre_key_gate_answers_off_without_reaching_for_the_keychain() {
        // An unsigned dev binary touching the signed app's keychain item pops a macOS auth prompt,
        // so a default-off install must decide "no" before it ever gets there. This asserts the
        // gate's SHAPE (it takes only the toggle + the state file, no key) as well as its answers.
        // (roborev 47460)
        let configured = BuilderIndexState {
            username: "sam".into(),
            consented_at: Some(1),
            ..Default::default()
        };
        assert_eq!(pre_key_gate(false, &configured), Err(SkipReason::Disabled));
        assert_eq!(
            pre_key_gate(true, &BuilderIndexState { username: "sam".into(), ..Default::default() }),
            Err(SkipReason::NoConsent)
        );
        assert_eq!(
            pre_key_gate(
                true,
                &BuilderIndexState { consented_at: Some(1), username: "   ".into(), ..Default::default() }
            ),
            Err(SkipReason::NoUsername)
        );
        // Everything the gate can check without a key passes — the key read is what comes next.
        assert_eq!(pre_key_gate(true, &configured), Ok(()));
    }

    #[test]
    fn an_unusable_api_key_is_rejected_before_it_is_stored() {
        // The value is interpolated into an `Authorization` header. A stray newline from a paste
        // would malform every request, every cycle, forever — fail loudly in the dialog instead.
        // (roborev 47460)
        assert!(validate_api_key("tkmx_live_abc123").is_ok());
        assert!(validate_api_key("").is_err());
        assert!(validate_api_key("abc\ndef").is_err());
        assert!(validate_api_key("abc\r\ndef").is_err());
        assert!(validate_api_key("abc def").is_err());
        assert!(validate_api_key("abc–def").is_err(), "non-ASCII (en dash) rejected");
    }

    #[test]
    fn a_client_id_already_on_disk_always_wins() {
        // Two racing derivations (the loop + a "Report now") could pin DIFFERENT ids if one
        // read_machine_id() failed into the random fallback — the double-count failure the module
        // header warns about. An id already persisted is authoritative. (roborev 47460)
        let tmp = tempfile::tempdir().unwrap();
        save_state(
            tmp.path(),
            &BuilderIndexState {
                username: "sam".into(),
                client_id: "pinned-by-the-other-cycle".into(),
                ..Default::default()
            },
        )
        .unwrap();
        // This caller's in-memory snapshot predates that write and has no id.
        let mut stale = BuilderIndexState { username: "sam".into(), ..Default::default() };
        assert_eq!(ensure_client_id(tmp.path(), &mut stale), "pinned-by-the-other-cycle");
        assert_eq!(load_state(tmp.path()).client_id, "pinned-by-the-other-cycle");
    }

    #[test]
    fn a_pinned_id_is_derived_from_the_fresh_username_not_the_callers_stale_one() {
        // The rename race. `builder_index_set_identity` clears client_id on a rename precisely so
        // the next cycle re-derives under the new name. An in-flight cycle that derived from its
        // OWN (stale) snapshot would pin sha256(machine|"old") into a record whose username is
        // "renamed" — permanently attaching this machine's rows to the wrong profile, and sticky
        // because a non-empty pin short-circuits. Asserting merely "not empty" pins the bug.
        // (roborev 48168/48167)
        let tmp = tempfile::tempdir().unwrap();
        save_state(
            tmp.path(),
            &BuilderIndexState { username: "renamed".into(), consented_at: Some(7), ..Default::default() },
        )
        .unwrap();
        let mut stale = BuilderIndexState { username: "old".into(), ..Default::default() };
        let pinned = ensure_client_id(tmp.path(), &mut stale);

        // Whatever machine id this host produced, the id must be the "renamed" derivation of it —
        // never the "old" one.
        let machine = read_machine_id().unwrap_or_else(random_machine_fallback);
        if read_machine_id().is_some() {
            assert_eq!(pinned, derive_client_id(&machine, "renamed"));
            assert_ne!(pinned, derive_client_id(&machine, "old"));
        }
        // And the caller's own snapshot is refreshed, so its POST doesn't carry the old username
        // alongside the new-name id.
        assert_eq!(stale.username, "renamed");
        let after = load_state(tmp.path());
        assert_eq!(after.username, "renamed");
        assert_eq!(after.consented_at, Some(7));
        assert_eq!(after.client_id, pinned);
    }

    #[test]
    fn the_partial_marker_is_in_the_status_line_both_ways() {
        // The wording is the whole point of propagating `truncated`; built inline it was
        // unreachable from a test. (roborev 47904/47899)
        assert_eq!(posted_status(3, 2, false, None), "Reported 3 row(s) across 2 day(s).");
        let partial = posted_status(3, 2, true, None);
        assert!(partial.starts_with("Reported 3 row(s) across 2 day(s)."));
        assert!(partial.contains("PARTIAL"));
        assert!(partial.contains("understates your usage"));
        // A capped scan drops the activity metrics (see `rollup_activity`), and the status line has
        // to SAY that — an absent panel the user can't distinguish from a zero teaches the same
        // wrong thing the zero did.
        assert!(partial.contains("omitted"), "{partial}");
        assert!(
            partial.contains("Subagent") && partial.contains("plan-mode"),
            "{partial}"
        );
        // The clean path stays clean: no scary omission text when nothing was omitted.
        assert!(!posted_status(3, 2, false, None).contains("omitted"));
    }

    // ── the server's 200 is not proof the report landed ──────────────────────────────────

    /// The exact body the live server returned to this machine's reporter on 2026-08-11, for a
    /// cycle that had 21 real rows in it. Everything in this section is anchored to it rather than
    /// to a shape someone guessed: `ok:true` with `rows:0` is what a discarded report looks like.
    const FROZEN_BODY: &str = r#"{"ok":true,"rows":0,"client_update":"Your tkmx-client is outdated (sparkle-desktop/0.98.0 → 1.3.0). From your tkmx-client folder:\n  git pull && npm install","profile_frozen":true}"#;

    #[test]
    fn a_frozen_profile_is_a_failed_report_not_a_successful_one() {
        // BEFORE this change `server_side_error` returned None here and the cycle recorded
        // "Reported 21 row(s) across 7 day(s)." while the profile showed tokens_28d: 0. The
        // assertion that matters is the OUTCOME — an Err — not that some field was parsed.
        assert_eq!(server_side_error(FROZEN_BODY), None, "precondition: the old check passes this body");
        let out = classify_ok_response(FROZEN_BODY, 21, 7, false);
        let msg = out.expect_err("a frozen profile must not report success");
        assert!(msg.contains("FROZE"), "{msg}");
        // The user has to be able to act on it, which means the server's own diagnosis has to
        // survive into the message rather than being flattened to "failed".
        assert!(msg.contains("outdated"), "{msg}");
    }

    #[test]
    fn storing_zero_of_the_rows_we_sent_fails_even_without_a_freeze_flag() {
        // The durable half of the guard: no `profile_frozen`, no `error`, no nag — just a server
        // that kept nothing. This is what a future gate (a new minimum version, a quota, a schema
        // rejection) looks like, and it has to fail without anyone teaching this code about it.
        let body = r#"{"ok":true,"rows":0}"#;
        assert_eq!(server_side_error(body), None);
        let msg = classify_ok_response(body, 21, 7, false)
            .expect_err("storing none of what we sent is not a success");
        assert!(msg.contains("stored 0 of 21"), "{msg}");
    }

    #[test]
    fn an_idle_cycle_that_sent_nothing_is_still_a_success() {
        // `rows: 0` back from a `data: []` post is CORRECT, not a discard — the reporter posts an
        // empty window on purpose so the server can tell "alive and idle" from "gone". Failing here
        // would make every quiet day look broken.
        let (outcome, status) = classify_ok_response(r#"{"ok":true,"rows":0}"#, 0, 0, false)
            .expect("an empty post is not a failure");
        assert!(matches!(outcome, ReportOutcome::Posted { rows: 0, .. }));
        assert_eq!(status, "Reported 0 row(s) across 0 day(s).");
    }

    #[test]
    fn a_freeze_fails_even_on_an_idle_cycle() {
        // ...but a FREEZE on an idle cycle is still fatal: it says nothing we send later will land
        // either, so waiting for a busy cycle to surface it just delays the diagnosis.
        let msg = classify_ok_response(r#"{"ok":true,"rows":0,"profile_frozen":true}"#, 0, 0, false)
            .expect_err("a freeze is fatal regardless of what we sent");
        assert!(msg.contains("FROZE"), "{msg}");
    }

    #[test]
    fn a_nag_without_a_freeze_still_counts_as_reported_and_is_surfaced() {
        // The cycle BEFORE the discard starts. It landed — so it must not fail — but the warning
        // is the only actionable moment, so it has to reach both the status line and the outcome.
        let body = r#"{"ok":true,"rows":21,"client_update":"Your tkmx-client is outdated (a → b).\n  git pull"}"#;
        let (outcome, status) = classify_ok_response(body, 21, 7, false).expect("this report landed");
        match outcome {
            ReportOutcome::Posted { notice: Some(n), .. } => {
                assert_eq!(n, "Your tkmx-client is outdated (a → b).", "first line only");
            }
            other => panic!("expected a notice on the outcome, got {other:?}"),
        }
        assert!(status.contains("Reported 21 row(s)"), "{status}");
        assert!(status.contains("outdated"), "{status}");
    }

    #[test]
    fn a_shortfall_is_not_treated_as_a_failure() {
        // The server merges rows by (date, model), so storing fewer than we sent can be legitimate.
        // A false failure every cycle is how a real one stops being read.
        let (outcome, _) = classify_ok_response(r#"{"ok":true,"rows":19}"#, 21, 7, false)
            .expect("a shortfall is not a discard");
        assert!(matches!(outcome, ReportOutcome::Posted { rows: 21, .. }));
    }

    #[test]
    fn an_unreadable_body_still_counts_as_reported() {
        // The 200 happy-path shape is not a documented contract. If the operator changes it, the
        // reporter must not start failing every cycle — that would be a worse bug than the silence.
        for body in ["", "not json at all", "{}"] {
            assert!(
                classify_ok_response(body, 21, 7, false).is_ok(),
                "an unrecognized 200 body must not fail the cycle: {body:?}"
            );
        }
    }

    // ── dry run ──────────────────────────────────────────────────────────────────────────

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn an_ordinary_launch_is_never_mistaken_for_a_dry_run() {
        // This runs before the event loop on EVERY launch, so a false positive means the app
        // prints JSON and exits instead of opening. Nothing but the exact flag may claim it.
        assert_eq!(dry_run_args(argv("")), None);
        assert_eq!(dry_run_args(argv("--days 28")), None);
        assert_eq!(dry_run_args(argv("--builder-index-dry-run-please")), None);
        assert_eq!(dry_run_args(argv("sparkle://open/agent/123")), None);
    }

    #[test]
    fn the_dry_run_window_defaults_and_clamps_like_the_reporter() {
        let days = |s: &str| dry_run_args(argv(s)).unwrap().days;
        // No `--days` ⇒ DEFER to the reporter's persisted window (resolved in `dry_run`), NOT a
        // constant. A user on report_days=14 must not be shown a 7-day figure and told it is what
        // their reporter posts.
        assert_eq!(days("--builder-index-dry-run"), None);
        assert_eq!(days("--builder-index-dry-run --days 28"), Some(28));
        // Clamped to what the server accepts, so a dry run can't advertise a window the reporter
        // could never post.
        assert_eq!(days("--builder-index-dry-run --days 9999"), Some(MAX_REPORT_DAYS));
        assert_eq!(days("--builder-index-dry-run --days 0"), Some(1));
        // A typo defers to the real window rather than refusing to print anything.
        assert_eq!(days("--builder-index-dry-run --days seven"), None);
        assert_eq!(days("--builder-index-dry-run --days"), None);
    }

    #[test]
    fn a_dry_run_with_no_days_flag_uses_the_reporters_persisted_window() {
        // The finding this fixes: it used to print DEFAULT_REPORT_DAYS regardless, so a machine
        // configured for a 14-day window was shown 7 days of usage labelled as what it reports.
        // The resolution has to happen INSIDE the function under test — passing in an
        // already-resolved `days` would make `window_days == 14` true by construction and the
        // assertion would hold against the buggy code too (roborev 62729).
        let window_days = |days: Option<u32>, app_data: &Path| -> serde_json::Value {
            let args = DryRunArgs { days, app_data: None };
            let out = dry_run_over(&args, Some(app_data), &[]);
            serde_json::from_str::<serde_json::Value>(&out).unwrap()["window_days"].clone()
        };

        let tmp = tempfile::tempdir().unwrap();
        save_state(tmp.path(), &BuilderIndexState { report_days: 14, ..Default::default() })
            .unwrap();
        // No `--days` ⇒ the persisted 14, read off disk by the function itself.
        assert_eq!(window_days(None, tmp.path()), 14);
        // An explicit `--days` still wins over the persisted window.
        assert_eq!(window_days(Some(28), tmp.path()), 28);

        // No state file at all ⇒ the module default, not a panic and not 0.
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(window_days(None, empty.path()), DEFAULT_REPORT_DAYS);
        // ...and no app_data at all takes the same default.
        let args = DryRunArgs { days: None, app_data: None };
        let v: serde_json::Value = serde_json::from_str(&dry_run_over(&args, None, &[])).unwrap();
        assert_eq!(v["window_days"], DEFAULT_REPORT_DAYS);
    }

    #[test]
    fn a_dry_run_shows_the_team_and_version_it_would_report_under() {
        // No UI sets the team, so the dry run is the ONLY way to confirm a hand-edit took effect
        // without posting — and both of these fields fail SILENTLY on the wire (a wrong team files
        // the history under a group nobody reads; a wrong version is answered 200 and discarded).
        let tmp = tempfile::tempdir().unwrap();
        // The state is written to disk rather than injected: `dry_run_over` opens it itself
        // (roborev 62729), so an injected struct would assert on a value the test supplied.
        let read = |state: &BuilderIndexState| -> serde_json::Value {
            save_state(tmp.path(), state).unwrap();
            let args = DryRunArgs { days: Some(7), app_data: None };
            serde_json::from_str(&dry_run_over(&args, Some(tmp.path()), &[])).unwrap()
        };

        let v = read(&BuilderIndexState { team: "  Chief  ".into(), ..Default::default() });
        assert_eq!(v["team_that_would_be_sent"], "Chief", "resolved, not the raw setting");
        assert_eq!(v["client_version_that_would_be_sent"], client_version());

        // Unset renders as JSON null — "the key will be OMITTED" — here too, so the dry run and
        // the real payload can never disagree. A string like "default" would read to a human as a
        // team that will be sent, which is the exact misreading this whole change removes.
        assert!(
            read(&BuilderIndexState::default())["team_that_would_be_sent"].is_null(),
            "an unset team must dry-run as null, not as a team name"
        );
    }

    #[test]
    fn the_dry_run_takes_an_explicit_app_data_root() {
        let a = dry_run_args(argv("--builder-index-dry-run --app-data /tmp/store")).unwrap();
        assert_eq!(a.app_data, Some(PathBuf::from("/tmp/store")));
        assert_eq!(dry_run_args(argv("--builder-index-dry-run")).unwrap().app_data, None);
    }

    #[test]
    fn a_dry_run_reports_the_roots_it_actually_scanned() {
        // The `roots` field is what let a 32x undercount be diagnosed at all (the missing
        // ~/.claude line was the only visible tell), so it must reflect the scan rather than be
        // re-derived from the environment at print time — those two answers can differ.
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("root-a");
        let b = tmp.path().join("root-b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let args = DryRunArgs { days: Some(7), app_data: None };
        let out = dry_run_over(&args, Some(tmp.path()), &[a.clone(), b.clone()]);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let roots: Vec<String> =
            serde_json::from_value(v["roots"].clone()).expect("roots must be a string list");
        assert_eq!(roots, vec![a.display().to_string(), b.display().to_string()]);
    }

    /// THE property the whole Builder Index rests on, asserted through the REPORTER'S OWN CHAIN:
    /// tokens from EVERY Sparkle account store reach the published payload.
    ///
    /// NINE stores, because that is what the machine this was written for has, and because the
    /// community client's measured defect is reading exactly ONE of them. A two-store test — which
    /// is what `spend.rs` already has — passes for a scanner that stops after two.
    ///
    /// Written so a DROPPED STORE CANNOT PASS. Each account carries its own model name and a
    /// distinct power-of-two token count, so the payload is a bitmask: omit any single store and
    /// its row vanishes AND the total falls to a value no other subset of stores can produce. That
    /// is deliberate belt-and-braces — an assertion on the grand total ALONE goes green for a scan
    /// that reads one store twice and another not at all, and a per-row assertion alone goes green
    /// for a scan that also invents a tenth.
    ///
    /// The roots are the ones [`crate::spend::transcript_roots`] RESOLVES from the app-data dir,
    /// not a list this test hands in — handing them in would assert the summing and prove nothing
    /// about the enumeration, which is the half that breaks. They are then narrowed to the temp
    /// app_data, which drops exactly one entry: the tester's own `$HOME/.claude` primary (3,697
    /// project dirs on this machine). Scanning that would make the test slow, machine-dependent,
    /// and quietly sensitive to the tester's `CLAUDE_CONFIG_DIR` — the same contamination
    /// [`dry_run_warning`] exists to flag. The narrowing cannot mask the bug being guarded against:
    /// the account stores are enumerated by production code and asserted EXACTLY, first, and it is
    /// that enumeration the scan below consumes.
    #[test]
    fn the_reporter_publishes_tokens_from_every_account_store() {
        const ACCOUNTS: usize = 9;
        let tmp = tempfile::tempdir().unwrap();
        let app_data = tmp.path();

        // Dated TODAY rather than at a fixed anchor: a hardcoded date eventually falls out of the
        // reporter's window, and this test would then pass over an empty scan — green, and proving
        // nothing at all.
        let today_day =
            (SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() / 86_400) as i64;
        let stamp = format!("{}T10:00:00Z", crate::spend::epoch_day_label(today_day));

        for i in 0..ACCOUNTS {
            let projects = app_data.join(format!("accounts/acct-{i}/projects/proj"));
            std::fs::create_dir_all(&projects).unwrap();
            std::fs::write(
                projects.join("session.jsonl"),
                format!(
                    r#"{{"type":"assistant","timestamp":"{stamp}","message":{{"id":"msg-{i}","model":"probe-model-{i}","usage":{{"input_tokens":{tokens},"output_tokens":0}}}}}}"#,
                    tokens = 1u64 << i
                ) + "\n",
            )
            .unwrap();
        }
        // Two entries under `accounts/` that must NOT become roots, so "reads every store" cannot
        // quietly degrade into "reads every directory".
        std::fs::create_dir_all(app_data.join("accounts/no-projects-yet")).unwrap();
        std::fs::write(app_data.join("accounts/stray.txt"), "x").unwrap();

        let roots = crate::spend::transcript_roots(Some(app_data));
        let enumerated: Vec<String> = roots
            .iter()
            .filter_map(|p| p.strip_prefix(app_data).ok())
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        let expected: Vec<String> = (0..ACCOUNTS)
            .map(|i| format!("accounts/acct-{i}/projects"))
            .collect();
        assert_eq!(
            enumerated, expected,
            "transcript_roots must enumerate all {ACCOUNTS} account stores — sorted, and nothing \
             else from accounts/"
        );

        // The reporter's two lines: scan the resolved roots, then roll up. `report_once_sync` runs
        // exactly this pair via `load_window_records`.
        let scoped: Vec<PathBuf> = roots.into_iter().filter(|p| p.starts_with(app_data)).collect();
        let scan = crate::spend::scan_window(&scoped, DEFAULT_REPORT_DAYS);
        let data = rollup(scan.records(), scan.today, DEFAULT_REPORT_DAYS);

        let mut published: std::collections::BTreeMap<String, u64> = Default::default();
        for day in &data {
            for m in &day.model_breakdowns {
                *published.entry(m.model_name.clone()).or_default() += m.input_tokens;
            }
        }
        for i in 0..ACCOUNTS {
            assert_eq!(
                published.get(&format!("probe-model-{i}")).copied(),
                Some(1u64 << i),
                "account store {i}'s tokens never reached the payload — published: {published:?}"
            );
        }
        assert_eq!(
            published.len(),
            ACCOUNTS,
            "the payload must carry one row per account store and no others: {published:?}"
        );
        assert_eq!(
            published.values().sum::<u64>(),
            (1u64 << ACCOUNTS) - 1,
            "the bitmask total pins WHICH stores were read, not merely how many: {published:?}"
        );
    }

    #[test]
    fn a_dry_run_under_claude_config_dir_says_its_total_is_low() {
        // The 32x undercount this warning exists for: with CLAUDE_CONFIG_DIR set, the primary
        // ~/.claude store drops out of `roots` and the total reads 1.99B instead of 56.4B, with
        // `truncated: false` and nothing else wrong-looking. A silent wrong answer is the exact
        // failure this whole change is about, so the diagnostic must not have one of its own.
        let w = dry_run_warning(Some("/some/account/store")).expect("must warn");
        assert!(w.contains("UNDERSTATES"), "{w}");
        assert!(w.contains("env -u CLAUDE_CONFIG_DIR"), "the fix has to be in the warning: {w}");
        // Unset or empty is the normal case and must stay quiet — a warning on every clean run is
        // one nobody reads on the run that matters.
        assert_eq!(dry_run_warning(None), None);
        assert_eq!(dry_run_warning(Some("")), None);
    }

    #[test]
    fn a_dry_run_writes_nothing_and_posts_nothing() {
        // The whole safety claim in one assertion: run it against a consented state file and the
        // file must come back byte-identical. A dry run that re-pinned `client_id` or stamped
        // `last_status` would be exactly the mutation the migration cannot survive.
        let tmp = tempfile::tempdir().unwrap();
        let before = BuilderIndexState {
            username: "DROdio".into(),
            client_id: "pinned-id-do-not-mint-a-new-one".into(),
            consented_at: Some(7),
            last_report_at: Some(11),
            last_status: Some("Reported 21 row(s) across 7 day(s).".into()),
            report_days: 0,
            team: "Chief".into(),
        };
        save_state(tmp.path(), &before).unwrap();
        // Then plant a forward-compatible key that `load_state` DROPS, so that even a faithful
        // round-trip rewrite changes the bytes. Without it the comparison below cannot fail:
        // re-saving the state just loaded produces a byte-identical file, so a `save_state`
        // creeping into the dry-run path would go unnoticed — confirmed by mutation, which added
        // exactly that write and left the whole suite green.
        {
            let p = state_path(tmp.path());
            let mut v: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
            v["a_key_a_future_version_added"] = serde_json::json!("must survive a dry run");
            std::fs::write(&p, serde_json::to_vec(&v).unwrap()).unwrap();
        }
        let raw_before = std::fs::read(state_path(tmp.path())).unwrap();

        // Empty ROOTS on purpose, but a real `app_data`: `dry_run` proper resolves roots from
        // `$HOME/.claude`, and a test that scanned the tester's real 3,697-project store would be
        // slow, machine-dependent, and silently sensitive to whether the tester's own
        // CLAUDE_CONFIG_DIR happened to be set. The state file is NOT injected — the function
        // opens it itself, which is the only way "it wrote nothing" and "it printed the id it
        // READ" can fail if the wiring regresses (roborev 62729).
        let args = DryRunArgs { days: None, app_data: None };
        let out = dry_run_over(&args, Some(tmp.path()), &[]);

        assert_eq!(
            std::fs::read(state_path(tmp.path())).unwrap(),
            raw_before,
            "a dry run must not write the reporter's state file"
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["posted"], false);
        // It reports the PINNED id it read off disk — never a freshly derived one.
        assert_eq!(v["client_id"], "pinned-id-do-not-mint-a-new-one");
        assert_eq!(v["username"], "DROdio");
        // `report_days: 0` is the "never configured" sentinel, so the window resolves to the
        // module default rather than a zero-day scan.
        assert_eq!(v["window_days"], DEFAULT_REPORT_DAYS);
        // The parity comparison is read off these two, so they have to be present even when the
        // scan found nothing.
        assert!(v["totals"]["totalTokens"].is_number(), "{out}");
        assert!(v["truncated"].is_boolean(), "{out}");
    }

    #[test]
    fn an_explicit_error_still_wins_over_the_discard_rules() {
        // Ordering: the operator's own wording is more useful than our inferred one.
        let msg = classify_ok_response(r#"{"ok":false,"error":"unknown user","rows":0}"#, 21, 7, false)
            .expect_err("an explicit error is still an error");
        assert!(msg.contains("unknown user"), "{msg}");
    }

    #[test]
    fn a_hostile_server_override_is_ignored_in_a_release_build() {
        // The refusal paths, without mutating the process env (global state shared with every
        // other test in this binary). (roborev 47904/47899)
        let d = DEFAULT_SERVER_URL;
        // Release: the override does not exist, however well-formed.
        assert_eq!(resolve_server_url(Some("https://attacker.example"), false), d);
        assert_eq!(resolve_server_url(Some("https://staging.example.com"), false), d);
        // Dev: https and loopback are honored, everything else falls back.
        assert_eq!(
            resolve_server_url(Some("https://staging.example.com"), true),
            "https://staging.example.com"
        );
        assert_eq!(resolve_server_url(Some("http://localhost:8080"), true), "http://localhost:8080");
        assert_eq!(resolve_server_url(Some("http://evil.example.com"), true), d);
        // Absent / blank always means the default.
        assert_eq!(resolve_server_url(None, true), d);
        assert_eq!(resolve_server_url(Some("   "), true), d);
    }

    #[test]
    fn a_stored_key_that_cannot_be_a_header_value_gets_its_own_reason() {
        // "You haven't set a key" and "the key you set is broken" need different fixes, and the
        // second used to surface as a generic transport error every 2h forever.
        // (roborev 48168/48167)
        assert_eq!(SkipReason::NoApiKey.as_str(), "no API key set");
        assert_eq!(
            SkipReason::BadApiKey.as_str(),
            "the stored API key is unusable — re-enter it"
        );
        // read_api_key's validation is the same predicate the write path uses.
        assert!(validate_api_key("abc\ndef").is_err());
    }

    // ── session_stats (the SUBAGENTS / PLAN MODE / TOOL MIX panels) ───────────────────────

    /// A representative rollup: 21 transcripts, 1 of them interactive, which is the shape this
    /// machine actually has (96% one-shot automation).
    fn totals() -> crate::spend::ActivityTotals {
        crate::spend::ActivityTotals {
            sessions_total: 21,
            sessions_interactive: 4,
            subagent_dispatches: 6,
            plan_mode_sessions: 1,
            by_category: [("Bash", 40u64), ("Task", 6), ("Read", 4)]
                .into_iter()
                .collect(),
            total_calls: 50,
            distinct_skills: 3,
        }
    }

    /// THE metric fix, asserted as the difference between the two denominators.
    ///
    /// Not written as `assert_eq!(rate, 1.5)` alone: that passes for the wrong denominator if the
    /// fixture happens to divide evenly. It asserts the published rate equals dispatches over
    /// INTERACTIVE sessions and is strictly greater than dispatches over every transcript — the
    /// pooling that turned a real 1.5 into a displayed 0.0.
    #[test]
    fn the_subagent_rate_is_over_interactive_sessions_not_every_transcript() {
        let t = totals();
        let s = rollup_activity(&t, false, 7, today()).expect("stats");
        let a = s.adoption.expect("adoption");

        assert_eq!(a.subagents_per_session, 6.0 / 4.0);
        let pooled = t.subagent_dispatches as f64 / t.sessions_total as f64;
        assert!(
            a.subagents_per_session > pooled,
            "the interactive denominator must not be the pooled one ({} vs {pooled})",
            a.subagents_per_session
        );
        // Rounded for display, the pooled rate is the 0.0 on the profile and ours is not.
        assert_eq!(format!("{pooled:.1}"), "0.3");
        assert_eq!(format!("{:.1}", a.subagents_per_session), "1.5");

        assert_eq!(a.plan_mode_rate, 1.0 / 4.0);
        // Both counts ride along so the rate is auditable rather than merely asserted.
        assert_eq!(a.sessions_interactive, 4);
        assert_eq!(a.sessions_total, 21);
        assert_eq!(a.subagent_dispatches, 6);
        assert_eq!(a.plan_mode_sessions, 1);
        assert_eq!(a.denominator, "interactive_sessions");
    }

    /// A capped scan has an unknown denominator, so the blob is dropped WHOLE. Stricter than the
    /// token half on purpose: a truncated token count is still a valid lower bound, a truncated rate
    /// is not a smaller number but a meaningless one.
    #[test]
    fn a_truncated_scan_omits_session_stats_entirely_rather_than_publishing_a_rate() {
        assert!(
            rollup_activity(&totals(), true, 7, today()).is_none(),
            "a capped scan must publish no activity metric at all"
        );
        // And the omission reaches the wire as an ABSENT key, not a null.
        let body = ReportBody {
            username: "someone".into(),
            team: Some("default".into()),
            client_id: "abc".into(),
            client_version: "v".into(),
            report_days: 7,
            data: vec![],
            session_stats: rollup_activity(&totals(), true, 7, today()),
            machine_config: None,
        };
        let json = serde_json::to_string(&body).unwrap();
        assert!(!json.contains("session_stats"), "{json}");
    }

    /// No interactive session ⇒ no honest denominator ⇒ `adoption` is absent. `tool_mix` survives,
    /// because a mix is a proportion of work actually observed rather than a per-session rate.
    #[test]
    fn without_an_interactive_session_adoption_is_absent_but_tool_mix_survives() {
        let t = crate::spend::ActivityTotals {
            sessions_interactive: 0,
            subagent_dispatches: 0,
            plan_mode_sessions: 0,
            ..totals()
        };
        let s = rollup_activity(&t, false, 7, today()).expect("tool_mix still worth sending");
        assert!(
            s.adoption.is_none(),
            "a 0/0 rate must be ABSENT, never published as 0.0 — that zero is the whole bug"
        );
        let mix = s.tool_mix.as_ref().expect("tool mix");
        assert_eq!(mix.total_calls, 50);

        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("adoption"), "absent, not null: {json}");
        assert!(json.contains("tool_mix"), "{json}");

        // THE POINT of putting `totals` at the top level: the session counts must survive the very
        // case that drops `adoption`. Nested under it, they would vanish exactly when a reader is
        // asking "did this machine do any work at all?" — and tkmx-client reads
        // `ss.totals?.sessions_all` independently of any rate. (roborev 55761)
        assert_eq!(s.totals.sessions_all, 21);
        assert_eq!(s.totals.sessions_human, 0);
        assert_eq!(s.totals.sessions_automation, 21);
        assert!(json.contains("sessions_all"), "counts must outlive adoption: {json}");
    }

    /// Nothing observed at all ⇒ the key never appears, rather than a blob of zeroes that would
    /// read on the profile as "this machine does no tool work".
    #[test]
    fn a_scan_with_nothing_to_report_omits_the_key_instead_of_publishing_zeroes() {
        let empty = crate::spend::ActivityTotals::default();
        assert!(rollup_activity(&empty, false, 7, today()).is_none());

        // A window with sessions but no tool calls drops tool_mix specifically.
        let quiet = crate::spend::ActivityTotals {
            sessions_total: 5,
            sessions_interactive: 2,
            ..Default::default()
        };
        let s = rollup_activity(&quiet, false, 7, today()).expect("adoption is still real");
        assert!(s.tool_mix.is_none(), "no calls ⇒ no mix");
        assert_eq!(s.adoption.expect("adoption").subagents_per_session, 0.0);
    }

    /// The keys the three panels read, frozen the way the token rows are. A rename is invisible at
    /// runtime — the server ignores unknown keys — so this test is what stands between a typo and a
    /// panel that silently stays wrong.
    #[test]
    fn session_stats_serializes_the_keys_the_panels_read() {
        let s = rollup_activity(&totals(), false, 7, today()).expect("stats");
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();

        let mut top: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        top.sort();
        assert_eq!(
            top,
            vec!["adoption", "schema_version", "source", "tool_mix", "totals", "window"]
        );
        assert_eq!(v["schema_version"], 1);
        assert_eq!(v["source"], "-accounts");
        assert_eq!(v["window"]["days"], 7);
        // RFC-3339 both ends, matching the community blob rather than this module's day labels —
        // the server replaces the blob wholesale, so a re-typed field is a lossy replacement.
        assert_eq!(v["window"]["until"], "2026-07-24T23:59:59Z");
        assert_eq!(v["window"]["since"], "2026-07-18T00:00:00Z");
        // Session counts live at the TOP level, not inside the droppable `adoption`.
        assert_eq!(v["totals"]["sessions_all"], 21);
        assert_eq!(v["totals"]["sessions_human"], 4);
        assert_eq!(v["totals"]["sessions_automation"], 17);

        let mut ad: Vec<&str> = v["adoption"].as_object().unwrap().keys().map(String::as_str).collect();
        ad.sort();
        assert_eq!(
            ad,
            vec![
                "denominator",
                "distinct_skills",
                "plan_mode_rate",
                "plan_mode_sessions",
                "sessions_interactive",
                "sessions_total",
                "subagent_dispatches",
                "subagents_per_session",
            ]
        );
        assert_eq!(v["adoption"]["distinct_skills"], 3);

        let mut tm: Vec<&str> = v["tool_mix"].as_object().unwrap().keys().map(String::as_str).collect();
        tm.sort();
        assert_eq!(tm, vec!["by_category", "total_calls"]);
        assert_eq!(v["tool_mix"]["by_category"]["Bash"], 40);
        assert_eq!(v["tool_mix"]["by_category"]["Task"], 6);
    }

    /// `session_stats: None` must vanish from the payload rather than serialize as `null` — a null
    /// could blank a blob the community reporter posted, the same way sending `tools: ""` would
    /// blank profile prose (see `profile_prose_fields_are_omitted_not_blanked`).
    #[test]
    fn an_omitted_session_stats_key_is_absent_not_null() {
        let body = ReportBody {
            username: "someone".into(),
            team: Some("default".into()),
            client_id: "abc".into(),
            client_version: "v".into(),
            report_days: 7,
            data: vec![],
            session_stats: None,
            machine_config: None,
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&body).unwrap()).unwrap();
        assert!(
            !v.as_object().unwrap().contains_key("session_stats"),
            "the key must be absent, not null: {v}"
        );
    }

    /// The window the blob claims must be the window that was scanned, clamped like the token half.
    #[test]
    fn the_reported_window_is_clamped_like_the_token_rollup() {
        let s = rollup_activity(&totals(), false, 9_999, today()).expect("stats");
        assert_eq!(s.window.days, MAX_REPORT_DAYS);
    }

    /// Print what THIS machine's real transcripts produce, with NO network and no state written.
    ///
    /// The unit tests above prove the arithmetic against fixtures; this is the check that the
    /// pipeline yields a sane number on a real 15,000-transcript install rather than a plausible
    /// zero — which is the failure the whole change exists to end, and one no fixture can catch.
    /// `#[ignore]`d because it depends on the machine it runs on.
    ///
    /// Run: `TKMX_APP_DATA=<app-data-dir> cargo test --lib \
    ///       builder_index::tests::show_this_machines_activity -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn show_this_machines_activity() {
        let app_data = std::env::var_os("TKMX_APP_DATA").map(PathBuf::from);
        if app_data.is_none() {
            eprintln!(
                "NOTE: TKMX_APP_DATA unset — scanning ~/.claude ONLY, which is the blind spot \
                 itself. Set it to compare."
            );
        }
        let window = 28;
        let scan = crate::spend::load_window_records(app_data.as_deref(), window);
        let totals = scan.activity();
        eprintln!("truncated={} totals={totals:#?}", scan.truncated);
        match rollup_activity(&totals, scan.truncated, window, scan.today) {
            Some(s) => eprintln!(
                "session_stats = {}",
                serde_json::to_string_pretty(&s).unwrap()
            ),
            None => eprintln!("session_stats OMITTED (nothing complete enough to publish)"),
        }
    }

    #[test]
    fn the_two_gates_can_never_disagree() {
        // pre_key_gate delegates to consent_gate, so the precedence exists once. If someone
        // reimplements it, this catches the divergence between the modal's `blockedBy` and the
        // reason the loop actually skipped. (roborev 48168/48167)
        for enabled in [false, true] {
            for consented in [false, true] {
                for named in [false, true] {
                    let state = BuilderIndexState {
                        username: if named { "sam".into() } else { String::new() },
                        consented_at: consented.then_some(1),
                        ..Default::default()
                    };
                    assert_eq!(
                        pre_key_gate(enabled, &state),
                        consent_gate(enabled, consented, named, true),
                        "enabled={enabled} consented={consented} named={named}"
                    );
                }
            }
        }
    }

    /// LIVE round-trip against the real tkmx server — the one check a unit test cannot give:
    /// that the payload this module builds is accepted end-to-end. `#[ignore]` + env-gated so CI
    /// and plain `cargo test` never touch the network or need credentials.
    ///
    /// Run: `TKMX_SERVER_URL=<staging> TKMX_USERNAME=<u> TKMX_API_KEY=<k> TKMX_TEAM=<t> \
    ///       TKMX_APP_DATA=<app-data-dir> cargo test --lib \
    ///       builder_index::tests::live_report_roundtrip -- --ignored --nocapture`
    ///
    /// NEVER posts to production. The server upserts by (client_id, date), so a run of this test
    /// would REPLACE today's real row for this machine — and with a partial scan behind it, replace
    /// it with an undercount, which is the exact ~84% underreporting the feature exists to fix. So
    /// `TKMX_SERVER_URL` must be set to something other than the production default, and the test
    /// refuses to run otherwise.
    ///
    /// `TKMX_APP_DATA` should be the app-data dir whose `accounts/` this machine really uses;
    /// without it the scan covers `~/.claude` ONLY, which is the same undercount in miniature.
    ///
    /// This posts `session_stats` too, so it can also REPLACE today's activity row — the same
    /// hazard, which is why the non-production gate below guards both halves and is not relaxed.
    ///
    /// Everything else is real (that's the point): real transcript scan, real `rollup`, real
    /// `derive_client_id` off the real machine id, 1-day window to keep the upsert surface minimal.
    #[test]
    #[ignore]
    fn live_report_roundtrip() {
        let (Ok(username), Ok(api_key)) =
            (std::env::var("TKMX_USERNAME"), std::env::var("TKMX_API_KEY"))
        else {
            eprintln!("live_report_roundtrip: TKMX_USERNAME/TKMX_API_KEY not set — skipping");
            return;
        };
        // Check the RAW override, not `server_url()`'s result: `resolve_server_url` silently falls
        // back to the default in a release build or for a non-https/non-loopback URL, so testing
        // the resolved value reports "not set" for an override that IS set and was rejected.
        let raw = std::env::var("TKMX_SERVER_URL").unwrap_or_default();
        assert!(
            !raw.trim().is_empty(),
            "refusing to post to production: set TKMX_SERVER_URL to a staging server — this \
             upserts by (client_id, date) and would overwrite today's real row"
        );
        let target = server_url();
        assert_ne!(
            target.trim_end_matches('/'),
            DEFAULT_SERVER_URL.trim_end_matches('/'),
            "TKMX_SERVER_URL is set to {raw:?} but was REJECTED (an override must be https or \
             loopback, and only a debug build honours it), so this would have posted to production"
        );
        // Unset (or blank) TKMX_TEAM means OMIT the key, matching production: this helper posts a
        // real row, so defaulting here would overwrite the target profile's team exactly the way
        // the production bug did.
        let team = std::env::var("TKMX_TEAM")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        let machine = read_machine_id().expect("machine id");
        let app_data = std::env::var_os("TKMX_APP_DATA").map(PathBuf::from);
        let scan = crate::spend::load_window_records(app_data.as_deref(), 1);
        let data = rollup(scan.records(), scan.today, 1);
        let session_stats = rollup_activity(&scan.activity(), scan.truncated, 1, scan.today);
        let rows = row_count(&data);
        let body = ReportBody {
            username: username.clone(),
            team,
            client_id: derive_client_id(&machine, &username),
            client_version: client_version(),
            report_days: 1,
            data,
            session_stats,
            // The real thing, not `None`: this probe exists to see what the SERVER does with a
            // genuine payload, and `machine_config` is the half that carries the SKILLS row.
            machine_config: build_machine_config(&host_facts(), reported_skills()),
        };
        let payload = serde_json::to_string(&body).expect("serialize");

        let url = format!("{}/api/usage", target.trim_end_matches('/'));
        let resp = ureq::post(&url)
            .timeout(HTTP_TIMEOUT)
            .set("Content-Type", "application/json")
            .set("Authorization", &format!("Bearer {api_key}"))
            .send_string(&payload)
            .expect("POST failed");
        let status = resp.status();
        let body = resp.into_string().expect("read response");
        eprintln!("live_report_roundtrip: {status} {body} ({rows} rows posted to {url})");
        assert_eq!(status, 200);
        assert!(
            server_side_error(&body).is_none(),
            "server reported an in-body error: {body}"
        );
    }
}
