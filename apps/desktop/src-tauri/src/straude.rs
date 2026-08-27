//! Opt-in straude.com reporting — bead `sparkle-862tw9`.
//!
//! The SECOND publishing destination, beside [`crate::builder_index`]. straude.com is a
//! COMPETITOR to the Builder Index, not a tool listed on it, so the two are independent in every
//! way: their own flags, their own sign-ins, their own reporters, their own state files. Turning
//! one on says nothing about the other, and `config.rs`'s
//! `straude_defaults_off_and_is_independent_of_builder_index` pins that in both directions.
//!
//! Everything here is DEFAULT-OFF and triple-gated: `[tools].straude` must be on, the one-time
//! consent modal must have been answered "publish", and a sign-in token must be stored. Miss any
//! one and the cycle skips without opening a socket.
//!
//! WHAT LEAVES THE MACHINE (and nothing else):
//!   • one row per calendar day: input / output / cache-creation / cache-read / total tokens, an
//!     estimated cost in USD, and the list of model ids used that day with their per-model costs
//!   • a per-machine `device_id` and a `device_name` LABEL — see [`DEFAULT_DEVICE_NAME`]; the
//!     machine's hostname is never read for it
//!   • the coding-agent product, as the literal `"claude"` — see [`AgentProduct`], a closed enum
//!     so a Sparkle agent name cannot be written there by a later refactor
//!   • implicitly, the straude account, via the bearer token
//! No file paths, no project or session names, no prompts, no code, no keys. The rollup is built
//! from [`crate::spend::UsageRecord`] and structurally cannot carry them: [`rollup`] drops a
//! record's `project`/`session` fields rather than merely omitting them, and every model id is
//! shape-checked by [`is_model_id`] before it can reach the wire.
//!
//! THIS IS NARROWER THAN THE BUILDER INDEX PAYLOAD, deliberately and by necessity. straude's wire
//! format has no field for machine specs, installed plugin names, or session-activity counters, so
//! none of those are collected here at all.
//!
//! WHY THE DEVICE NAME IS NOT THE HOSTNAME, where `builder_index.rs` sends one.
//!
//! MEASURED FIRST, because the obvious reason turned out to be WRONG and the honest one is
//! narrower. `device_name` is NOT rendered on any public surface: it lives only in
//! `device_usage`, whose RLS policy scopes SELECT to the owning user and which grants `anon`
//! nothing; the public read model is `daily_usage`, which has no device column at all; and the
//! auto-generated post title is `"<date> — <models><cost>"`, with no device in it. Verified
//! against the operator's public source, not assumed. **So do not write, in this header or in the
//! consent copy, that the device name is published — it is not.** That claim was in an early draft
//! of this module and had to be removed; inaccurate consent copy is the specific failure this
//! feature exists to avoid.
//!
//! What IS true is enough on its own: the value is transmitted in cleartext and retained
//! server-side, where the operator can read it. `builder_index.rs`'s header records the hazard —
//! a Mac's default name is commonly its owner's real name — and `device_name` is the only field in
//! this payload that can carry personal identity. Sending it buys nothing, because nothing public
//! consumes it and the `device_id` already disambiguates devices. So the default is the literal
//! [`DEFAULT_DEVICE_NAME`], the user may set their own in the consent modal, and the hostname is
//! never read. Data minimization, not a claim about publication.
//!
//! WIRE PROTOCOL — read off the operator's public server source (github.com/ohong/straude,
//! `apps/web/app/api/usage/submit/route.ts` + `apps/web/types/index.ts`) and the published
//! `straude@0.1.30` CLI bundle, not guessed:
//!   POST {SERVER_URL}/api/usage/submit
//!   Authorization: Bearer <token>          Content-Type: application/json
//!   { entries: [ { date: "YYYY-MM-DD", data: CcusageDailyEntry } ],
//!     source: "cli",            // REQUIRED; the server accepts only "cli" | "web"
//!     device_id: "<uuid>",      // REQUIRED
//!     device_name?: "Sparkle" }
//!   CcusageDailyEntry = { date, agents?, models, inputTokens, outputTokens,
//!                         cacheCreationTokens, cacheReadTokens, totalTokens,
//!                         costUSD, modelBreakdown?: [{ model, cost_usd }] }
//! Note `costUSD` is camel while `modelBreakdown[].cost_usd` is snake — that asymmetry is the
//! server's, and the server reads by key, so a "tidy-up" rename drops the value silently.
//!
//! `source` IS A KNOWN MISLABEL. The server validates it against a closed two-value enum, so
//! Sparkle cannot identify itself there and reports as `"cli"`. This is the same trade
//! [`crate::builder_index`] made when it surrendered its `sparkle-desktop/` prefix: working
//! reporting was chosen over identification. Identification has to come back as a server-side field
//! that is not validated against a closed set — never as a value smuggled into one that is.
//!
//! `collector` AND `hash` ARE OMITTED ENTIRELY (absent, not null). Both are optional, and every
//! documented `collector` key asserts a fact about a ccusage run that did not happen here.
//! `ccusage_version` is the `client_version` incident verbatim — a version field a server silently
//! reinterpreted, answering `ok: true, rows: 0` invisibly for weeks. `pricing_mode` is worse: it
//! selects how cost is derived, so if the server ever recomputes or validates `costUSD` by mode it
//! would move the very number the monotonic guard below compares. A `hash` we cannot compute
//! byte-identically is a dedup key that silently means nothing.
//!
//! THE MONOTONIC COST GUARD IS A SILENT-DROP HAZARD — the analog of `builder_index.rs`'s "a 200 is
//! not proof the report landed". The server upserts on `(user_id, date, device_id)` and only writes
//! when the submitted `costUSD` is at least the cost it already holds. Sparkle prices from
//! [`crate::spend`]'s own static table, so a submission carrying MORE tokens at a LOWER cost is
//! discarded behind a 200. Only `action` and `previous_cost` in the reply can prove a row moved —
//! `daily_total` sums across devices and `device_count` is a population count. See [`RowVerdict`].
//!
//! Not fixed by sharing the CLI's `device_id`, which is why this module mints its own and pins it:
//! sharing the row would make every cycle a race between two different price tables where the
//! loser's tokens vanish. Racing only ourselves keeps cost monotonic with tokens. The cost is a
//! VISIBLE over-count when both reporters run (the profile sums two devices) — the deliberate
//! trade, since a legible over-count beats a silent under-count, and `device_count > 1` in the
//! reply detects it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::spend::UsageRecord;

/// straude's API host. The human-facing site and the API share this origin.
/// Overridable for dev via `STRAUDE_SERVER_URL` (dev builds only — see [`resolve_server_url`]).
pub const DEFAULT_SERVER_URL: &str = "https://straude.com";

/// The `source` discriminator. The server validates against exactly `"cli" | "web"`, so this is
/// forced — see the module header's "KNOWN MISLABEL" note before "fixing" it.
pub const SOURCE: &str = "cli";

/// The device label sent when the user has not set one.
///
/// NOT the hostname, and nothing here ever reads the hostname. straude does not render this value
/// publicly, but it does store it — see the module header for the measurement and the reasoning.
pub const DEFAULT_DEVICE_NAME: &str = "Sparkle";

/// Keychain ACCOUNT for the straude sign-in token. A distinct account under Sparkle's existing
/// keychain service — never the desktop-token, the trial-device-token, or the Builder Index key.
pub const KEYCHAIN_USER: &str = "straude-token";

/// Default trailing window per report. The server merges by date, so a small window is cheap and
/// self-heals after an offline stretch.
pub const DEFAULT_REPORT_DAYS: u32 = 7;

/// Cap on the window. The server rejects any date older than 30 days, so this is ITS limit, not a
/// preference — a wider window would post rows that can only be refused.
pub const MAX_REPORT_DAYS: u32 = 30;

/// Cap on `entries[]`. The server's own limit is 32 (a 30-day window plus two).
pub const MAX_ENTRIES: usize = 32;

/// The server's body cap. Checked before the POST so an oversized payload fails as our own
/// diagnosable error rather than an opaque 413.
pub const MAX_BODY_BYTES: usize = 256 * 1024;

// ── payload ─────────────────────────────────────────────────────────────────────────────────

/// The coding-agent PRODUCT, as ccusage means it — NEVER a Sparkle agent name.
///
/// Closed on purpose. A `String` here is one refactor away from publishing `reflective-breeze` to
/// a public feed; as an enum, that mistake is a compile error instead of a leak nobody notices.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentProduct {
    Claude,
    Codex,
}

/// One model's share of a day's cost. Note the snake_case key — the server's, not a typo.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModelCost {
    pub model: String,
    pub cost_usd: f64,
}

/// A day's aggregate, in ccusage's daily shape.
///
/// Deliberately has NO field for a project, a session, a path, or a prompt. ccusage's per-project
/// breakdown is never requested by straude's own CLI either, so this is the whole surface.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CcusageDailyEntry {
    pub date: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<AgentProduct>,
    pub models: Vec<String>,
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
    /// REQUIRED by the server, where tkmx's equivalent is optional. See [`rollup`] on why an
    /// unpriced model still ships its tokens with an honest partial sum rather than a zero.
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    #[serde(rename = "modelBreakdown", skip_serializing_if = "Vec::is_empty")]
    pub model_breakdown: Vec<ModelCost>,
}

/// One `entries[]` element. The date is repeated at both levels — the server's shape.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SubmitEntry {
    pub date: String,
    pub data: CcusageDailyEntry,
}

/// The POST body. `collector` and `hash` are absent by construction — there are no fields for
/// them, so they cannot be added by accident. See the module header for why.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SubmitBody {
    pub entries: Vec<SubmitEntry>,
    pub source: &'static str,
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}

// ── persisted state ─────────────────────────────────────────────────────────────────────────

/// What the reporter remembers between launches EXCEPT the token (keychain) and the on/off switch
/// (`[tools].straude` in config.toml).
///
/// Its own file rather than config.toml, for `builder_index.rs`'s reason: the feature adds exactly
/// ONE key to the shared `[tools]` table, and a hand-edited config can never silently un-consent
/// someone or re-point their `device_id`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct StraudeState {
    /// The straude username, learned from the sign-in. Display only — the token carries identity.
    pub username: String,
    /// This machine's device id, minted once and pinned. See [`ensure_device_id`].
    pub device_id: String,
    /// The device label sent to straude. Transmitted and retained server-side; NOT rendered
    /// publicly — see the module header for the measurement. Empty means [`DEFAULT_DEVICE_NAME`].
    pub device_name: String,
    /// Unix seconds when the consent modal was answered "publish". `None` = never consented, which
    /// is the only state in which the reporter is allowed to have written nothing.
    pub consented_at: Option<i64>,
    pub last_report_at: Option<i64>,
    pub last_status: String,
    /// 0 means [`DEFAULT_REPORT_DAYS`].
    pub report_days: u32,
    /// Unix seconds of the last cycle START, for the manual cooldown.
    pub last_cycle_at: Option<i64>,
    /// Unix seconds until which the server has rate-limited us. See the 429 handling.
    pub backoff_until: Option<i64>,
    /// date → the cost the server kept when it refused ours. Re-sending an equal or lower cost can
    /// only earn the same refusal, so those dates are held back until our number exceeds it.
    pub blocked_costs: BTreeMap<String, f64>,
}

impl StraudeState {
    /// The trailing window this machine reports, clamped to what the server will accept.
    pub fn window(&self) -> u32 {
        match self.report_days {
            0 => DEFAULT_REPORT_DAYS,
            n => n.clamp(1, MAX_REPORT_DAYS),
        }
    }

    /// The device label to publish: the user's, else [`DEFAULT_DEVICE_NAME`]. Never the hostname.
    pub fn device_label(&self) -> String {
        let t = self.device_name.trim();
        if t.is_empty() {
            DEFAULT_DEVICE_NAME.to_string()
        } else {
            t.to_string()
        }
    }
}

/// `<app_data>/straude.json`.
pub fn state_path(app_data: &Path) -> PathBuf {
    app_data.join("straude.json")
}

/// Read the state file. A missing or corrupt file degrades to the default — not configured, not
/// consented. The fail-safe direction: we stop reporting, we never start.
pub fn load_state(app_data: &Path) -> StraudeState {
    std::fs::read_to_string(state_path(app_data))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

// ── consent gate (pure) ─────────────────────────────────────────────────────────────────────

/// Why a cycle didn't post. Every variant is a REASON, not an error: a disabled or unconfigured
/// install is the normal state, and the loop keeps ticking quietly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// `[tools].straude` is off (the default).
    Disabled,
    /// The one-time consent modal has not been answered with "publish".
    NoConsent,
    /// No sign-in token stored.
    NoToken,
    /// A token IS stored but cannot be used as a header value. Distinct from [`SkipReason::NoToken`]
    /// because "you haven't signed in" and "the sign-in you have is broken" need different fixes.
    BadToken,
    /// The token's 30-day life ran out. Distinct again: only a browser sign-in fixes this, and
    /// unlike the others it is worth SAYING so, once.
    TokenExpired,
    /// A manual "Report now" arrived inside the cooldown. Never reached by the background loop.
    CoolingDown,
    /// The server rate-limited us and we are waiting out its `Retry-After`.
    RateLimited,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            SkipReason::Disabled => "straude reporting is off",
            SkipReason::NoConsent => "waiting for consent",
            SkipReason::NoToken => "not signed in to straude",
            SkipReason::BadToken => "the stored straude sign-in is unusable — sign in again",
            SkipReason::TokenExpired => "your straude sign-in expired — sign in again",
            SkipReason::CoolingDown => "just reported — wait a moment before reporting again",
            SkipReason::RateLimited => "straude is rate-limiting this account",
        }
    }

    /// A stable machine-readable discriminant.
    ///
    /// Exists so the UI can tell these apart WITHOUT matching on `as_str`'s prose. The frontend
    /// badge has to treat "off / not signed in" (benign, the normal state of an un-opted-in
    /// install) differently from "your sign-in is broken or lapsed" and "the server is refusing us"
    /// — and a reworded sentence must never silently reclassify one as the other.
    pub fn code(self) -> &'static str {
        match self {
            SkipReason::Disabled => "disabled",
            SkipReason::NoConsent => "no_consent",
            SkipReason::NoToken => "no_token",
            SkipReason::BadToken => "bad_token",
            SkipReason::TokenExpired => "token_expired",
            SkipReason::CoolingDown => "cooling_down",
            SkipReason::RateLimited => "rate_limited",
        }
    }

    /// Whether this reason is worth writing into `last_status` for the user to read.
    ///
    /// Most are not: an install that never opted in must stay silent rather than nag. The three
    /// that are describe a state the user has to act on and would otherwise never learn about — a
    /// lapsed sign-in in particular is invisible, because rotation only happens on a successful
    /// POST, so a machine that was offline for 30 days gets no other signal.
    ///
    /// `NoToken` is in that set even though it READS like "never signed in". It cannot mean that:
    /// [`consent_gate`] reports the toggle and consent FIRST, so this reason is only reachable on
    /// an install the user opted into — its keychain entry is gone, or the keychain is locked or
    /// denied ([`read_token`] folds every keychain error into `NoToken`). Reporting is dead until
    /// they sign in again and nothing else would say so.
    pub fn is_actionable(self) -> bool {
        matches!(self, SkipReason::NoToken | SkipReason::BadToken | SkipReason::TokenExpired)
    }
}

/// The whole gate, as a pure function, so "off means off" is a unit test rather than a claim about
/// control flow buried in a loop.
///
/// Order matters for the message the UI shows: the toggle is reported first, because an install
/// that never opted in should say so rather than nag for a sign-in it will never use.
pub fn consent_gate(
    enabled: bool,
    consented: bool,
    token: TokenState,
) -> Result<(), SkipReason> {
    if !enabled {
        return Err(SkipReason::Disabled);
    }
    if !consented {
        return Err(SkipReason::NoConsent);
    }
    match token {
        TokenState::Missing => Err(SkipReason::NoToken),
        TokenState::Unusable => Err(SkipReason::BadToken),
        TokenState::Expired => Err(SkipReason::TokenExpired),
        TokenState::ExpiringSoon { .. } | TokenState::Valid { .. } => Ok(()),
    }
}

/// The part of [`consent_gate`] evaluable WITHOUT touching the keychain, so a cycle can answer
/// "off" / "no consent" for free and only pay (and risk a macOS auth prompt) for the token read
/// once everything cheaper has passed.
///
/// Delegates rather than restating the precedence: two copies of the ordering would let the modal's
/// message and the reason the loop actually skipped drift apart silently.
pub fn pre_token_gate(enabled: bool, state: &StraudeState) -> Result<(), SkipReason> {
    consent_gate(
        enabled,
        state.consented_at.is_some(),
        TokenState::Valid { days_left: u32::MAX },
    )
}

/// How much life the stored sign-in has left.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenState {
    Missing,
    /// Present but not usable as a header value.
    Unusable,
    Expired,
    /// Inside [`EXPIRY_WARN_DAYS`] of the cliff.
    ExpiringSoon { days_left: u32 },
    Valid { days_left: u32 },
}

/// How long before expiry to start warning.
///
/// Not cosmetic. The token rotates ONLY on a successful authenticated POST, so a machine that is
/// offline, disabled, or gated for the token's whole life reaches the cliff with no other signal.
pub const EXPIRY_WARN_DAYS: u32 = 7;

/// Classify a token's remaining life. `exp` is read from our own copy of the JWT for UI purposes
/// only — it is never verified and must never be treated as authorization.
pub fn token_state(now: i64, exp: Option<i64>, usable: bool) -> TokenState {
    if !usable {
        return TokenState::Unusable;
    }
    let Some(exp) = exp else {
        // A token we cannot read an expiry out of is still a token. Treat it as valid and let the
        // server be the judge — refusing locally would brick a working sign-in over a parse.
        return TokenState::Valid { days_left: u32::MAX };
    };
    if exp <= now {
        return TokenState::Expired;
    }
    let days_left = ((exp - now) / 86_400) as u32;
    if days_left <= EXPIRY_WARN_DAYS {
        TokenState::ExpiringSoon { days_left }
    } else {
        TokenState::Valid { days_left }
    }
}

// ── model id shape guard ────────────────────────────────────────────────────────────────────

/// Does this look like a model id, as opposed to anything that could carry a path or a name?
///
/// `models` cannot be a closed enum the way [`AgentProduct`] can — new model ids appear — so the
/// guard is a shape check at the one place ids reach the wire. Anything failing it is DROPPED, not
/// published: a leak to a public feed is not worth a best-effort pass-through.
pub fn is_model_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_' | '@')
        })
}

// ── rollup ──────────────────────────────────────────────────────────────────────────────────

/// What [`rollup`] produced, plus what it had to leave out.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rollup {
    pub entries: Vec<SubmitEntry>,
    /// Model ids seen in the window that have no published price. Their TOKENS are still counted;
    /// only their cost is missing, so the day's `costUSD` is an honest partial sum. Named so the
    /// status line can say which — an undercount presented confidently is worse than a gap.
    pub unpriced_models: Vec<String>,
    /// Ids dropped by [`is_model_id`]. Should always be empty; a non-empty list is a bug worth
    /// seeing rather than a condition to handle.
    pub rejected_models: Vec<String>,
    /// Days held back because NOTHING on them could be priced. See the filter in [`rollup`].
    pub withheld_days: Vec<String>,
}

/// Fold the scan into straude's daily shape.
///
/// STRUCTURALLY CANNOT LEAK. It reads exactly five fields off each record — `day`, `model`, and the
/// token counters — and the record's `project`/`session` are dropped here rather than merely
/// omitted downstream. This is the ONLY function that sees a [`UsageRecord`], which is why the
/// guard lives here: a future leak would have to be written into this body.
///
/// Pure: no clock, no filesystem, no network.
pub fn rollup<'a>(
    records: impl Iterator<Item = &'a UsageRecord>,
    today: i64,
    days: u32,
) -> Rollup {
    let window = days.clamp(1, MAX_REPORT_DAYS);
    let first_day = today - (window as i64 - 1);

    struct Day {
        input: u64,
        output: u64,
        cache_creation: u64,
        cache_read: u64,
        total: u64,
        cost: f64,
        per_model_cost: BTreeMap<String, f64>,
        models: BTreeSet<String>,
        /// Any model on this day whose price we do not know.
        had_unpriced: bool,
    }
    let mut buckets: BTreeMap<i64, Day> = BTreeMap::new();
    let mut unpriced: BTreeSet<String> = BTreeSet::new();
    let mut rejected: BTreeSet<String> = BTreeSet::new();

    for r in crate::spend::dedupe_window(records, first_day, today) {
        // The shape check happens BEFORE the id is stored anywhere, so a rejected id never reaches
        // a struct that gets serialized.
        if !is_model_id(&r.model) {
            rejected.insert(r.model.clone());
            continue;
        }
        let d = buckets.entry(r.day).or_insert_with(|| Day {
            input: 0,
            output: 0,
            cache_creation: 0,
            cache_read: 0,
            total: 0,
            cost: 0.0,
            per_model_cost: BTreeMap::new(),
            models: BTreeSet::new(),
            had_unpriced: false,
        });
        d.models.insert(r.model.clone());
        d.input = d.input.saturating_add(r.input);
        d.output = d.output.saturating_add(r.output);
        d.cache_creation = d
            .cache_creation
            .saturating_add(crate::spend::record_cache_creation(r));
        d.cache_read = d.cache_read.saturating_add(r.cache_read);
        d.total = d.total.saturating_add(crate::spend::record_total_tokens(r));
        match crate::spend::record_cost_usd(r) {
            Some(c) => {
                d.cost += c;
                *d.per_model_cost.entry(r.model.clone()).or_insert(0.0) += c;
            }
            // Tokens counted, cost omitted. Never zero-filled: a 0.0 on the wire is not "unknown",
            // it is an assertion that the day was free — and here it would also drag the day's
            // total below what the server already holds and get the whole row refused.
            None => {
                unpriced.insert(r.model.clone());
                d.had_unpriced = true;
            }
        }
    }

    let mut withheld: Vec<String> = Vec::new();
    let entries = buckets
        .into_iter()
        // A day we cannot price AT ALL is WITHHELD, not published as free. `costUSD` is required
        // here (tkmx's equivalent is `Option`, so it can simply omit the key), and a 0.0 on the
        // wire is not "unknown" — it is an assertion that a day carrying real tokens cost nothing,
        // on a service whose whole subject is spend. It would also set the server's monotonic floor
        // at 0 and read back as `Landed`, so the false number would look confirmed. A withheld day
        // self-heals the moment `spend.rs`'s price table learns the model.
        .filter(|(day, d)| {
            if d.had_unpriced && d.cost <= 0.0 {
                withheld.push(crate::spend::epoch_day_label(*day));
                false
            } else {
                true
            }
        })
        .map(|(day, d)| {
            let date = crate::spend::epoch_day_label(day);
            SubmitEntry {
                date: date.clone(),
                data: CcusageDailyEntry {
                    date,
                    agents: vec![AgentProduct::Claude],
                    models: d.models.into_iter().collect(),
                    input_tokens: d.input,
                    output_tokens: d.output,
                    cache_creation_tokens: d.cache_creation,
                    cache_read_tokens: d.cache_read,
                    total_tokens: d.total,
                    cost_usd: d.cost,
                    model_breakdown: d
                        .per_model_cost
                        .into_iter()
                        .map(|(model, cost_usd)| ModelCost { model, cost_usd })
                        .collect(),
                },
            }
        })
        .collect();

    // No MAX_ENTRIES truncation here on purpose: `window` is already clamped to MAX_REPORT_DAYS
    // (30) above and `dedupe_window` drops everything outside it, so `buckets` can never hold more
    // than 30 days and a 32-entry cap is unreachable. A guard for a case that cannot happen is
    // worse than none — it reads as protection and can never be exercised, so nothing would notice
    // if it were wrong. `entries_never_exceed_the_servers_cap` asserts the CLAMP, which is the
    // property actually doing the work.
    Rollup {
        entries,
        unpriced_models: unpriced.into_iter().collect(),
        rejected_models: rejected.into_iter().collect(),
        withheld_days: withheld,
    }
}

/// Assemble the POST body.
pub fn build_submit_body(state: &StraudeState, device_id: String, entries: Vec<SubmitEntry>) -> SubmitBody {
    SubmitBody {
        entries,
        source: SOURCE,
        device_id,
        device_name: Some(state.device_label()),
    }
}

/// Does the serialized body fit the server's cap?
pub fn fits_wire_budget(payload: &str) -> bool {
    payload.len() <= MAX_BODY_BYTES
}

// ── response verdict ────────────────────────────────────────────────────────────────────────

/// One `results[]` element from a 200.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct SubmitResult {
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub previous_cost: Option<f64>,
    #[serde(default)]
    pub daily_total: Option<f64>,
    #[serde(default)]
    pub device_count: Option<u32>,
    #[serde(default)]
    pub post_url: Option<String>,
}

/// What happened to ONE submitted day.
#[derive(Clone, Debug, PartialEq)]
pub enum RowVerdict {
    Landed,
    /// The server kept its existing row because ours was cheaper. The tokens did NOT land.
    Superseded { sent: f64, kept: f64 },
    /// We sent this date and the reply said nothing about it.
    Missing,
    /// A 200-shaped reply we cannot read as either outcome.
    Unverifiable,
}

/// A millionth of a dollar. Float comparison against the server's own `>=` needs a tolerance, or a
/// round-trip through JSON can turn an equal cost into a spurious `Superseded`.
pub const COST_EPSILON: f64 = 1e-6;

/// Reproduce the server's own guard predicate from the reply.
pub fn cost_landed(sent: f64, kept: f64) -> bool {
    sent >= kept - COST_EPSILON
}

/// The reply row for one submitted date.
///
/// A separate function so the pairing is BY DATE and not by position. Zipping `entries` with
/// `results` by index compiles, passes a naive test, and misattributes every verdict the moment the
/// server reorders or omits a row — turning a `Superseded` (the tokens did not land) into a
/// `Landed`, which is precisely the silent drop [`RowVerdict`] exists to detect.
pub fn result_for<'a>(date: &str, results: &'a [SubmitResult]) -> Option<&'a SubmitResult> {
    results.iter().find(|r| r.date == date)
}

/// Judge one day. See the module header on why only `action` and `previous_cost` can prove this.
pub fn classify_row(sent_cost: f64, res: Option<&SubmitResult>) -> RowVerdict {
    let Some(res) = res else {
        return RowVerdict::Missing;
    };
    match (res.action.as_str(), res.previous_cost) {
        // No prior row for this (user, date, device), so the guard had nothing to compare against.
        ("created", _) => RowVerdict::Landed,
        ("updated", Some(kept)) if cost_landed(sent_cost, kept) => RowVerdict::Landed,
        ("updated", Some(kept)) => RowVerdict::Superseded { sent: sent_cost, kept },
        // A 200 is not proof. An update with no `previous_cost`, or an action word we do not know,
        // is never read as success — but it is not an error either, the same call
        // `builder_index::classify_ok_response` makes for a body it cannot parse.
        _ => RowVerdict::Unverifiable,
    }
}

/// Should this date be submitted, given what the server previously refused?
///
/// Re-sending a cost the server already beat can only earn the same refusal while burning
/// rate-limit budget and one of the 32 entry slots. Today's date clears itself as usage accrues; a
/// sealed past day never will, which the status line has to say rather than retry forever.
pub fn should_submit(date: &str, computed_cost: f64, state: &StraudeState) -> bool {
    match state.blocked_costs.get(date) {
        Some(&blocked) => computed_cost > blocked + COST_EPSILON,
        None => true,
    }
}

/// The reporting host: [`DEFAULT_SERVER_URL`] unless `STRAUDE_SERVER_URL` names a safe override.
pub fn resolve_server_url(raw: Option<String>, dev_build: bool) -> String {
    let Some(raw) = raw else {
        return DEFAULT_SERVER_URL.to_string();
    };
    let raw = raw.trim().to_string();
    if raw.is_empty() {
        return DEFAULT_SERVER_URL.to_string();
    }
    // Dev builds only. Otherwise anyone able to set an env var on a shipped install could redirect
    // a consented user's usage to a host of their choosing.
    if !dev_build {
        tracing::warn!(
            "straude: ignoring STRAUDE_SERVER_URL — the override is dev-builds-only"
        );
        return DEFAULT_SERVER_URL.to_string();
    }
    let ok = raw.starts_with("https://")
        || raw.starts_with("http://127.0.0.1")
        || raw.starts_with("http://localhost");
    if ok {
        tracing::info!(host = %raw, "straude: using STRAUDE_SERVER_URL override");
        return raw;
    }
    tracing::warn!("straude: ignoring STRAUDE_SERVER_URL — only https:// (or a localhost dev server) is allowed");
    DEFAULT_SERVER_URL.to_string()
}

// ── clock, state io ─────────────────────────────────────────────────────────────────────────

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Serializes every read-modify-write of the state file AND the paired keychain write.
///
/// Held across BOTH because the invariant is that the stored token and the stored expiry agree.
/// Re-reading before a write narrows the window but does not close it: two cycles that both find
/// an empty `device_id` can still both mint and both write, and they would disagree — the
/// double-count this module exists to avoid.
fn state_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    // Poison-tolerant: a panic while holding it must not permanently wedge the reporter.
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

/// Write the state file ATOMICALLY — temp file, then rename.
///
/// `builder_index.rs` writes its state in place, and that is safe THERE because its `client_id` is
/// derived (sha256 of machine id + username) and so re-derivable from nothing. Ours is a RANDOM
/// uuid, minted once and pinned forever, and that difference is what makes a torn write
/// unrecoverable: a crash, power loss, or full disk mid-write leaves a truncated file that
/// `load_state` degrades to the default, `ensure_device_id` then mints a SECOND id for this
/// machine, and per the module header two device ids are exactly what over-counts the user's
/// profile. It would also silently drop `consented_at` and `blocked_costs`. This file is rewritten
/// every cycle, forever, so the window recurs indefinitely.
fn save_state(app_data: &Path, state: &StraudeState) -> Result<(), String> {
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let final_path = state_path(app_data);
    let tmp = final_path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    // Rename is atomic within a filesystem, so a reader sees either the old file or the new one.
    std::fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Record a cycle's result, re-reading fresh state inside the lock so a concurrent "forget" is not
/// undone by a cycle that started before it.
///
/// Writes NOTHING when consent has been withdrawn mid-cycle: a user who turned this off between
/// the POST and its reply must not find a fresh status line waiting for them.
pub fn record_outcome(app_data: &Path, reported_at: Option<i64>, status: String) {
    let _g = state_lock().lock();
    let mut state = load_state(app_data);
    if state.consented_at.is_none() {
        return;
    }
    if let Some(at) = reported_at {
        state.last_report_at = Some(at);
    }
    state.last_status = status;
    let _ = save_state(app_data, &state);
}

// ── device id ───────────────────────────────────────────────────────────────────────────────

/// A random v4 UUID, the shape the server requires.
///
/// Deliberately RANDOM rather than derived from a machine id: the contract says uuid, a derivation
/// could collide with the CLI's own namespace, and a derived id changes identity whenever its
/// source read fails — which is the double-count the pin below exists to prevent.
fn mint_device_id() -> String {
    use rand::Rng;
    let mut b = [0u8; 16];
    rand::thread_rng().fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 1
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// This machine's device id: the pinned one, or a freshly minted one pinned now.
///
/// PINNED, never re-derived, and never read from `~/.straude/config.json`. Sharing the CLI's id
/// would put both reporters on one `(user, date, device)` row, where the monotonic cost guard
/// makes every cycle a race between two different price tables and the loser's tokens vanish. A
/// file another tool owns can also be deleted or rewritten by `straude logout`, silently changing
/// this machine's identity mid-history.
pub fn ensure_device_id(app_data: &Path, state: &mut StraudeState) -> String {
    if !state.device_id.trim().is_empty() {
        return state.device_id.clone();
    }
    let _g = state_lock().lock();
    // Re-read INSIDE the lock: another cycle may have minted one while we waited.
    let mut fresh = load_state(app_data);
    if fresh.device_id.trim().is_empty() {
        fresh.device_id = mint_device_id();
        let _ = save_state(app_data, &fresh);
    }
    state.device_id = fresh.device_id.clone();
    fresh.device_id
}

// ── keychain ────────────────────────────────────────────────────────────────────────────────

fn entry() -> Result<keyring::Entry, String> {
    // Dev-suffixed keychain service in debug builds (mirrors auth.rs / builder_index.rs).
    keyring::Entry::new(&crate::dev_identity::keychain_service(), KEYCHAIN_USER)
        .map_err(|e| e.to_string())
}

/// How many times the keychain has been reached for. Test-only: the module's headline property is
/// that a not-opted-in install never touches the keychain, and asserting the ORDER of statements is
/// the only way to keep a later edit from quietly reintroducing an unconditional read.
#[cfg(test)]
pub static KEYCHAIN_READS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Reject anything that cannot be a header value or is not JWT-shaped.
///
/// Run on READ as well as write. A token stored by an older build — or truncated by a partial
/// rotation write — would otherwise malform the `Authorization` header on every cycle forever,
/// surfacing only as a generic transport error.
pub fn validate_token(token: &str) -> Result<(), String> {
    if token.is_empty() {
        return Err("the sign-in token is empty".to_string());
    }
    if !token.chars().all(|c| c.is_ascii_graphic()) {
        return Err("that token contains spaces, line breaks, or non-ASCII characters".to_string());
    }
    let segs: Vec<&str> = token.split('.').collect();
    if segs.len() != 3 || segs.iter().any(|s| s.is_empty()) {
        return Err("that does not look like a sign-in token (expected three dot-separated parts)"
            .to_string());
    }
    Ok(())
}

/// The stored token, or a reason it cannot be used.
pub fn read_token() -> Result<String, SkipReason> {
    #[cfg(test)]
    KEYCHAIN_READS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    // Guarded: in a DEBUG build this must never raise the macOS confidential-information
    // dialog for the dev-suffixed item this binary no longer owns the ACL of (sparkle-vvwbl).
    let Some(t) = entry().ok().and_then(|e| crate::dev_identity::no_prompt(|| e.get_password().ok()))
    else {
        return Err(SkipReason::NoToken);
    };
    let t = t.trim().to_string();
    if t.is_empty() {
        return Err(SkipReason::NoToken);
    }
    validate_token(&t).map_err(|_| SkipReason::BadToken)?;
    Ok(t)
}

pub fn write_token(token: &str) -> Result<(), String> {
    validate_token(token)?;
    let e = entry()?;
    // Guarded: in a DEBUG build this must never raise the macOS confidential-information
    // dialog for the dev-suffixed item this binary no longer owns the ACL of (sparkle-vvwbl).
    crate::dev_identity::no_prompt(|| e.set_password(token)).map_err(|e| e.to_string())
}

pub fn delete_token() -> Result<(), String> {
    let entry = entry()?;
    // Guarded: in a DEBUG build this must never raise the macOS confidential-information
    // dialog for the dev-suffixed item this binary no longer owns the ACL of (sparkle-vvwbl).
    match crate::dev_identity::no_prompt(|| entry.delete_credential()) {
        Ok(()) => Ok(()),
        // Already absent is the state the caller wanted.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// The `exp` claim, for UI purposes ONLY.
///
/// The signature is never checked and this must never be treated as authorization — the server is
/// the only judge of a token's validity. It exists so the user can be warned BEFORE the cliff,
/// which matters because the token rotates only on a successful POST: a machine that is offline for
/// the token's whole life gets no other signal.
pub fn jwt_exp(token: &str) -> Option<i64> {
    use base64::Engine as _;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("exp")?.as_i64()
}

/// Absorb a rotated token from a response header.
///
/// Called on EVERY reply, before the outcome is classified and even when the submission failed:
/// rotation is independent of whether rows landed, and a 4xx can still carry the header. A
/// rotation that fails validation is IGNORED rather than stored — the old token is still valid for
/// up to three more weeks, so keeping it is strictly better than bricking auth on a truncated
/// write.
/// Returns `Option`, not `Result`, ON PURPOSE. The ignore is STRUCTURAL rather than a convention
/// the caller has to remember: with a `Result` the idiomatic `absorb_rotated_token(h)?` would turn
/// a SUCCESSFUL submission — rows landed, 200 in hand — into a failed cycle and write a failure
/// status for a report that actually landed, which is the opposite of what a malformed header
/// should cost. There is no shape of caller that can make that mistake now. The rejection is
/// logged here instead.
pub fn absorb_rotated_token(header: Option<&str>) -> Option<String> {
    let raw = header?.trim();
    if raw.is_empty() {
        return None;
    }
    match validate_token(raw) {
        Ok(()) => Some(raw.to_string()),
        Err(e) => {
            tracing::warn!(error = %e, "straude: ignoring a malformed rotated token");
            None
        }
    }
}

// ── rate limiting ───────────────────────────────────────────────────────────────────────────

/// Minimum gap between MANUAL reports.
///
/// The background loop cannot trip the server's 20-req/60s limit at one post per 2h, so the manual
/// path is the whole exposure — and it is the one that matters, because every accepted submission
/// creates a post.
pub const MIN_MANUAL_INTERVAL_SECS: i64 = 60;

/// How long to wait when the server rate-limits us without a usable `Retry-After`.
pub const DEFAULT_BACKOFF_SECS: i64 = 120;

/// The longest backoff we will honour, so a hostile or fat-fingered header cannot park reporting
/// for a week.
pub const MAX_BACKOFF_SECS: i64 = 6 * 60 * 60;

/// When a 429 says we may try again. Handles delta-seconds; anything unparseable falls back to
/// [`DEFAULT_BACKOFF_SECS`] rather than retrying immediately — an immediate retry is what earned
/// the 429.
pub fn parse_retry_after(header: Option<&str>, now: i64) -> i64 {
    let secs = header
        .and_then(|h| h.trim().parse::<i64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(DEFAULT_BACKOFF_SECS)
        .min(MAX_BACKOFF_SECS);
    now + secs
}

/// Is a server-imposed backoff still in force?
///
/// The ceiling is enforced HERE, at the point of use, not only in [`parse_retry_after`. A stored
/// timestamp is an absolute instant written against whatever the clock said when the 429 arrived;
/// if that clock was ahead (a VM snapshot resume, a dead RTC battery, a user changing the date) the
/// window outlives its intended ceiling, and once the clock corrects, EVERY cycle is refused —
/// manual and scheduled — with `last_status` reading "straude is rate-limiting this account" for as
/// long as the skew lasted. The clear-on-success rule cannot recover that, because no cycle can run
/// to succeed. So a window further out than we would ever honour is treated as not active at all.
pub fn backoff_active(now: i64, backoff_until: Option<i64>) -> bool {
    matches!(backoff_until, Some(u) if u > now && u <= now + MAX_BACKOFF_SECS)
}

/// May a MANUAL report start now, as far as the cooldown is concerned?
///
/// This is only half the manual gate — see [`cycle_allowed`], which is what callers use.
pub fn manual_allowed(now: i64, last_cycle_at: Option<i64>) -> bool {
    match last_cycle_at {
        // A stamp in the FUTURE is a clock jump, not a recent cycle. Treated as stale rather than
        // as a live cooldown: `now - t` would otherwise be large and negative, killing "Report now"
        // for the whole skew duration while telling the user "just reported — wait a moment", which
        // is not what happened and gives them nothing to act on. (This repo has already been bitten
        // by the mirror of this bug — `saturating_duration_since` extending a TTL on a backwards
        // clock.)
        Some(t) if t > now => true,
        Some(t) => now - t >= MIN_MANUAL_INTERVAL_SECS,
        None => true,
    }
}

/// Which path is asking to run a cycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CycleKind {
    /// The 2h background loop.
    Scheduled,
    /// A "Report now" press.
    Manual,
}

/// The complete pre-flight gate for starting a cycle.
///
/// THE BACKOFF APPLIES TO BOTH KINDS, and that is the whole point of this function existing rather
/// than callers composing the two predicates themselves. Scoping the backoff to the loop alone
/// leaves the manual path — which is the entire rate-limit exposure, since the loop runs three
/// orders of magnitude under the limit — able to press once a minute against a server that has
/// explicitly asked us to stop, earning a fresh 429 each time. The cooldown alone does not cover
/// that: 60s is shorter than any backoff the server will ask for.
///
/// The two refusals stay DISTINCT because they mean different things to the user: "you just
/// reported" is a local nicety, "straude is rate-limiting this account" is the server talking and
/// is worth showing.
pub fn cycle_allowed(
    now: i64,
    last_cycle_at: Option<i64>,
    backoff_until: Option<i64>,
    kind: CycleKind,
) -> Result<(), SkipReason> {
    if backoff_active(now, backoff_until) {
        return Err(SkipReason::RateLimited);
    }
    if kind == CycleKind::Manual && !manual_allowed(now, last_cycle_at) {
        return Err(SkipReason::CoolingDown);
    }
    Ok(())
}

/// Persist (or clear) the server-imposed backoff, and stamp the cycle start.
///
/// `until: None` CLEARS it. A successful submission must clear the window rather than let a
/// persisted future timestamp keep suppressing cycles past the server's actual limit — a stale
/// backoff silently disables reporting, which is indistinguishable from the feature being broken.
pub fn record_backoff(app_data: &Path, until: Option<i64>, cycle_started_at: Option<i64>) {
    let _g = state_lock().lock();
    let mut state = load_state(app_data);
    if state.consented_at.is_none() {
        return;
    }
    state.backoff_until = until;
    if let Some(at) = cycle_started_at {
        state.last_cycle_at = Some(at);
    }
    let _ = save_state(app_data, &state);
}

/// Guards against two cycles posting at once.
///
/// [`crate::builder_index`] only needs a double-SPAWN guard; this needs a double-CYCLE one,
/// because a manual "Report now" landing on top of a background cycle would burn rate-limit budget
/// and — the part that matters — could create a duplicate public post.
static CYCLE_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Unforgeable outside this module: the private `()` field means only [`try_begin_cycle`] can
/// build one. As a unit struct any caller could write `CycleGuard`, and its `Drop` would release a
/// slot it never claimed — letting a manual "Report now" run beside the background cycle and create
/// the duplicate public post this guard exists to prevent, with no compile error.
pub struct CycleGuard(());

impl Drop for CycleGuard {
    fn drop(&mut self) {
        CYCLE_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Claim the right to run a cycle, or `None` if one is already running.
pub fn try_begin_cycle() -> Option<CycleGuard> {
    CYCLE_RUNNING
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .ok()
        .map(|_| CycleGuard(()))
}

// ── outcome ─────────────────────────────────────────────────────────────────────────────────

/// How a submission's days fared. Built by [`tally`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SubmitTally {
    pub landed: usize,
    /// The server kept a pricier row. These tokens did NOT land.
    pub superseded: Vec<(String, f64, f64)>,
    pub unverifiable: usize,
    pub missing: usize,
    pub device_count: Option<u32>,
    pub post_url: Option<String>,
}

impl SubmitTally {
    /// Did every day we sent actually land?
    ///
    /// `superseded` and `missing` are FAILURES, not decorated successes — the direct analog of
    /// `builder_index::discard_reason`'s reason-independent rule. `unverifiable` alone is not: the
    /// server's happy-path body is not a documented contract, and failing every healthy cycle over
    /// an unrecognized shape is a worse bug than the one it would catch.
    pub fn is_ok(&self) -> bool {
        self.superseded.is_empty() && self.missing == 0
    }

    /// The dates the server refused, with the cost it kept, so they can be held back.
    pub fn blocked(&self) -> Vec<(String, f64)> {
        self.superseded
            .iter()
            .map(|(d, _sent, kept)| (d.clone(), *kept))
            .collect()
    }
}

/// Judge every submitted day against the reply.
pub fn tally(entries: &[SubmitEntry], results: &[SubmitResult]) -> SubmitTally {
    let mut out = SubmitTally::default();
    for e in entries {
        let res = result_for(&e.date, results);
        match classify_row(e.data.cost_usd, res) {
            RowVerdict::Landed => out.landed += 1,
            RowVerdict::Superseded { sent, kept } => {
                out.superseded.push((e.date.clone(), sent, kept))
            }
            RowVerdict::Unverifiable => out.unverifiable += 1,
            RowVerdict::Missing => out.missing += 1,
        }
    }
    out.device_count = results.iter().find_map(|r| r.device_count);
    out.post_url = results.iter().find_map(|r| r.post_url.clone());
    out
}

/// A notice when straude can see more devices than this one, because the profile SUMS them and
/// Sparkle's number is a superset of the CLI's.
///
/// The fix is environmental — turn one reporter off — so this reports rather than acts, the same
/// posture `builder_index.rs` takes toward the community launch agent.
pub fn coexistence_notice(device_count: Option<u32>) -> Option<String> {
    match device_count {
        Some(n) if n > 1 => Some(format!(
            "straude sees {n} devices for this account and sums their totals. If the straude CLI \
             also reports from this machine, turn one of them off."
        )),
        _ => None,
    }
}

/// The status line for a cycle that had nothing left to send, or `None` when there is genuinely
/// nothing to say (an empty window on a quiet machine).
///
/// NOTHING LEFT TO SEND IS NOT SUCCESS. Both filters upstream are permanent for a past day — a
/// WITHHELD day waits on a price table that may never learn the model, and a `blocked_costs` day is
/// SEALED, because a past day's cost can only grow with new usage that will never arrive. Returning
/// silently left `last_status` reading whatever the previous cycle wrote and the loop logging
/// `landed=0 days=0` every 2h forever, which is the exact silent drop the rest of this module
/// exists to surface.
///
/// A PURE FUNCTION on purpose. The branch it replaced sat past the token read in
/// `submit_once_sync`, which no test can reach — the gate skips at `NoToken` first — so the logic
/// was untestable where it stood. Extracting the DECISION makes it coverable; see
/// `an_all_withheld_window_produces_a_status_rather_than_silence`.
///
/// KNOWN GAP, stated rather than papered over: this proves the decision, not that the call site
/// runs. `submit_once_sync` reaches the network and the keychain inline with no injectable seam, so
/// its post-gate half is untested by construction — the repo's documented "defaulted seam" shape.
/// Closing it means extracting a response/cycle core that takes its scan and transport as
/// parameters, which is a larger refactor than this fix.
pub fn nothing_to_send_status(
    withheld: &[String],
    held_back: usize,
    unpriced: &[String],
    truncated: bool,
) -> Option<String> {
    if withheld.is_empty() && held_back == 0 {
        return None;
    }
    let mut msg = submitted_status_with_withheld(&SubmitTally::default(), unpriced, truncated, withheld);
    if held_back > 0 {
        msg = format!(
            "{msg} {held_back} day(s) are held back because straude holds a higher cost for them \
             than Sparkle computes."
        );
    }
    Some(msg)
}

/// The user-facing line for a finished submission.
pub fn submitted_status_with_withheld(
    t: &SubmitTally,
    unpriced: &[String],
    truncated: bool,
    withheld: &[String],
) -> String {
    let mut s = submitted_status(t, unpriced, truncated);
    if !withheld.is_empty() {
        s = format!(
            "{s} {} day(s) held back because none of their models have a published price ({}) — \
             sending them would report those days as costing $0.",
            withheld.len(),
            withheld.join(", "),
        );
    }
    s
}

pub fn submitted_status(t: &SubmitTally, unpriced: &[String], truncated: bool) -> String {
    let mut s = format!("Reported {} day(s).", t.landed);
    if !t.superseded.is_empty() {
        // EVERY superseded day is named or counted. `blocked()` holds all of them back from future
        // submissions — and a sealed past day never clears — so disclosing only the first would
        // silently strand the rest, which is the exact silent drop this whole mechanism exists to
        // surface.
        let dates: Vec<String> = t.superseded.iter().map(|(d, _, _)| d.clone()).collect();
        let (_, sent, kept) = &t.superseded[0];
        s = format!(
            "{s} {} day(s) did not land — straude kept its existing rows ({}) because Sparkle's \
             estimate is lower (e.g. ${sent:.2} vs ${kept:.2}). Those days stay held back until \
             Sparkle's number exceeds straude's. Sparkle prices from its own table; straude's CLI \
             prices from ccusage.",
            t.superseded.len(),
            dates.join(", "),
        );
    }
    if t.missing > 0 {
        s = format!("{s} {} day(s) got no answer from the server.", t.missing);
    }
    if t.unverifiable > 0 {
        s = format!(
            "{s} The server did not say whether {} day(s) replaced the previous value.",
            t.unverifiable
        );
    }
    if !unpriced.is_empty() {
        s = format!(
            "{s} Cost is a partial sum — no published price for: {}.",
            unpriced.join(", ")
        );
    }
    if truncated {
        s = format!("{s} PARTIAL — the transcript scan hit its file cap, so this understates your usage.");
    }
    if let Some(n) = coexistence_notice(t.device_count) {
        s = format!("{s} {n}");
    }
    s
}

// ── cadence ─────────────────────────────────────────────────────────────────────────────────

/// Reporting cadence. Matches the Builder Index reporter's 2h so a user running both sees
/// comparable freshness — and it is three orders of magnitude under the server's rate limit.
const REPORT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2 * 60 * 60);
/// Delay before the FIRST cycle. Startup must never wait on a transcript scan or a socket.
const FIRST_REPORT_DELAY: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// Bound the POST: ureq has no default request timeout, so an unreachable server would otherwise
/// park a blocking thread indefinitely.
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// Spread of the per-cycle jitter. Every Sparkle install waking on the same 2h boundary would hand
/// the server a synchronized thundering herd.
const JITTER_SPREAD_SECS: u64 = 15 * 60;

fn jitter_secs() -> u64 {
    use rand::Rng;
    rand::thread_rng().gen_range(0..JITTER_SPREAD_SECS)
}

/// The reporting host, honouring a dev-only override.
pub fn server_url() -> String {
    resolve_server_url(std::env::var("STRAUDE_SERVER_URL").ok(), cfg!(debug_assertions))
}

// ── device-code sign-in ─────────────────────────────────────────────────────────────────────

/// What the user must do to finish signing in.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginChallenge {
    /// The short code shown on the verification page, so the user can confirm they are approving
    /// THIS machine and not a request someone else started.
    pub code: String,
    pub verify_url: String,
}

#[derive(Deserialize)]
struct InitReply {
    code: String,
    verify_url: String,
    poll_secret: String,
}

#[derive(Deserialize)]
struct PollReply {
    #[serde(default)]
    status: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    username: Option<String>,
}

/// The in-flight sign-in's secret.
///
/// IN MEMORY ONLY, never persisted. It is a bearer capability to complete a sign-in, and writing it
/// to disk would put a second, longer-lived credential beside the token for no benefit — the
/// exchange lasts a couple of minutes.
static PENDING_LOGIN: std::sync::OnceLock<std::sync::Mutex<Option<(String, String)>>> =
    std::sync::OnceLock::new();

fn pending_login() -> &'static std::sync::Mutex<Option<(String, String)>> {
    PENDING_LOGIN.get_or_init(|| std::sync::Mutex::new(None))
}

/// Start a device-code sign-in. Returns the code + URL for the user to approve in a browser.
fn login_begin_sync() -> Result<LoginChallenge, String> {
    let url = format!("{}/api/auth/cli/init", server_url().trim_end_matches('/'));
    let resp = ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Content-Type", "application/json")
        .send_string("{}")
        .map_err(|e| match &e {
            ureq::Error::Status(429, _) => {
                "straude is rate-limiting sign-in attempts — wait a minute and try again".to_string()
            }
            ureq::Error::Status(c, _) => format!("straude returned {c}"),
            ureq::Error::Transport(t) => format!("network error: {t}"),
        })?;
    let body = resp.into_string().map_err(|e| e.to_string())?;
    let init: InitReply =
        serde_json::from_str(&body).map_err(|_| "straude sent a sign-in reply we can't read".to_string())?;
    if init.code.trim().is_empty() || init.verify_url.trim().is_empty() {
        return Err("straude sent an incomplete sign-in reply".to_string());
    }
    *pending_login().lock().map_err(|_| "sign-in state is wedged")? =
        Some((init.code.clone(), init.poll_secret));
    Ok(LoginChallenge { code: init.code, verify_url: init.verify_url })
}

/// Ask whether the user has approved yet. `Ok(None)` means "still waiting", not an error.
fn login_poll_sync(app_data: &Path) -> Result<Option<String>, String> {
    let Some((code, secret)) = pending_login().lock().map_err(|_| "sign-in state is wedged")?.clone()
    else {
        return Err("no sign-in is in progress".to_string());
    };
    let url = format!("{}/api/auth/cli/poll", server_url().trim_end_matches('/'));
    let payload = serde_json::json!({ "code": code, "poll_secret": secret }).to_string();
    let resp = ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Content-Type", "application/json")
        .send_string(&payload);
    let body = match resp {
        Ok(r) => r.into_string().map_err(|e| e.to_string())?,
        // A pending sign-in is commonly signalled by a non-2xx; treat it as "keep waiting" rather
        // than an error the user has to read, and let the caller's own timeout end the wait.
        Err(ureq::Error::Status(404 | 425 | 428, _)) => return Ok(None),
        Err(ureq::Error::Status(c, _)) => return Err(format!("straude returned {c}")),
        Err(ureq::Error::Transport(t)) => return Err(format!("network error: {t}")),
    };
    let poll: PollReply =
        serde_json::from_str(&body).map_err(|_| "straude sent a reply we can't read".to_string())?;
    if poll.status != "completed" {
        return Ok(None);
    }
    let token = poll.token.unwrap_or_default();
    write_token(token.trim())?;
    // Clear the secret the moment it is spent.
    *pending_login().lock().map_err(|_| "sign-in state is wedged")? = None;

    let username = poll.username.unwrap_or_default().trim().to_string();
    let _g = state_lock().lock();
    let mut state = load_state(app_data);
    state.username = username.clone();
    save_state(app_data, &state)?;
    Ok(Some(username))
}

// ── the cycle ───────────────────────────────────────────────────────────────────────────────

/// What one cycle did.
#[derive(Clone, Debug, PartialEq)]
pub enum CycleOutcome {
    Skipped(SkipReason),
    Submitted { landed: usize, days: usize },
}

/// Run one reporting cycle. Blocking; callers run it off the event loop.
fn submit_once_sync(
    app_data: PathBuf,
    enabled: bool,
    kind: CycleKind,
) -> Result<CycleOutcome, String> {
    let mut state = load_state(&app_data);

    // The keychain read is LAST and lazy, behind the cheap gates. An unsigned dev binary touching
    // a keychain item owned by the signed app pops a macOS authorization prompt, so a default-off
    // install must never reach for it — being prompted every 2h by a feature you never opted into
    // is the opposite of inert.
    if let Err(reason) = pre_token_gate(enabled, &state) {
        return Ok(CycleOutcome::Skipped(reason));
    }
    let now = now_secs();
    if let Err(reason) = cycle_allowed(now, state.last_cycle_at, state.backoff_until, kind) {
        return Ok(CycleOutcome::Skipped(reason));
    }
    let Some(_cycle) = try_begin_cycle() else {
        return Ok(CycleOutcome::Skipped(SkipReason::CoolingDown));
    };
    let token = match read_token() {
        Ok(t) => t,
        Err(reason) => {
            // Past the consent gate, so this is an install the user DID opt into whose credential
            // is missing or unusable — reporting is dead until they act, and this line is the only
            // place that says so. Without it `is_actionable` had no production caller at all: the
            // one test asserting which reasons speak up was pinning a fact nothing consumed.
            if reason.is_actionable() {
                record_outcome(&app_data, None, reason.as_str().to_string());
            }
            return Ok(CycleOutcome::Skipped(reason));
        }
    };
    match token_state(now, jwt_exp(&token), true) {
        TokenState::Expired => {
            // The ONE skip that speaks up. A lapsed sign-in is otherwise invisible: the token
            // rotates only on a successful POST, so an offline machine reaches the cliff silently.
            // Posting anyway would burn rate-limit budget on a guaranteed 401.
            record_outcome(&app_data, None, SkipReason::TokenExpired.as_str().to_string());
            return Ok(CycleOutcome::Skipped(SkipReason::TokenExpired));
        }
        TokenState::ExpiringSoon { days_left } => {
            tracing::warn!(days_left, "straude: sign-in expires soon");
        }
        _ => {}
    }

    let window = state.window();
    let device_id = ensure_device_id(&app_data, &mut state);
    let scan = crate::spend::load_window_records(Some(&app_data), window);
    let roll = rollup(scan.records(), scan.today, window);
    if !roll.rejected_models.is_empty() {
        tracing::warn!(
            rejected = ?roll.rejected_models,
            "straude: dropped model ids that failed the shape check — this should never happen"
        );
    }
    // Captured before the HTTP arms below shadow it — the status line has to name the models whose
    // cost is missing, or the partial sum reads as a complete one.
    let unpriced = roll.unpriced_models.clone();
    let withheld = roll.withheld_days.clone();
    // Hold back days the server already refused: an equal-or-lower cost can only earn the same
    // refusal while burning a rate-limit slot and one of the 32 entry slots.
    let offered = roll.entries.len();
    let entries: Vec<SubmitEntry> = roll
        .entries
        .into_iter()
        .filter(|e| should_submit(&e.date, e.data.cost_usd, &state))
        .collect();
    let held_back = offered - entries.len();
    if entries.is_empty() {
        // NOTHING LEFT TO SEND IS NOT SUCCESS, and it must not be reported as one. Both filters
        // above are permanent for a past day — a withheld day waits on a price table that may
        // never learn the model, and a `blocked_costs` day is SEALED because its cost can only
        // grow with new usage. Returning silently here left `last_status` reading whatever the
        // previous cycle wrote and the loop logging `landed=0, days=0` every 2h forever, which is
        // the exact silent drop the rest of this module exists to surface. (Reached with an empty
        // window too, where there is genuinely nothing to say — hence the guard.)
        record_backoff(&app_data, state.backoff_until, Some(now));
        if let Some(msg) = nothing_to_send_status(&withheld, held_back, &unpriced, scan.truncated) {
            record_outcome(&app_data, None, msg);
        }
        return Ok(CycleOutcome::Submitted { landed: 0, days: 0 });
    }
    let days = entries.len();
    let body = build_submit_body(&state, device_id, entries.clone());
    let payload = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    if !fits_wire_budget(&payload) {
        let msg = format!(
            "the report is {} bytes, over straude's {MAX_BODY_BYTES}-byte limit — reduce report_days",
            payload.len()
        );
        record_outcome(&app_data, None, format!("Last report failed — {msg}."));
        return Err(msg);
    }

    let url = format!("{}/api/usage/submit", server_url().trim_end_matches('/'));
    let resp = ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {token}"))
        .send_string(&payload);

    // Rotation is absorbed from EITHER arm, before anything is classified.
    let absorb = |r: &ureq::Response| {
        if let Some(t) = absorb_rotated_token(r.header("X-Straude-Refreshed-Token")) {
            let _g = state_lock().lock();
            if let Err(e) = write_token(&t) {
                tracing::warn!(error = %e, "straude: could not store the rotated token");
            }
        }
    };

    match resp {
        Ok(r) => {
            absorb(&r);
            let text = r.into_string().unwrap_or_default();
            let results: Vec<SubmitResult> = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| serde_json::from_value(v.get("results")?.clone()).ok())
                .unwrap_or_default();
            let t = tally(&entries, &results);
            let status = submitted_status_with_withheld(&t, &unpriced, scan.truncated, &withheld);
            if t.is_ok() {
                // A success CLEARS the backoff — a stale window silently suppresses reporting.
                record_backoff(&app_data, None, Some(now));
                record_outcome(&app_data, Some(now), status);
                Ok(CycleOutcome::Submitted { landed: t.landed, days })
            } else {
                let _g = state_lock().lock();
                let mut fresh = load_state(&app_data);
                if fresh.consented_at.is_some() {
                    for (date, kept) in t.blocked() {
                        fresh.blocked_costs.insert(date, kept);
                    }
                    fresh.last_cycle_at = Some(now);
                    fresh.last_status = status.clone();
                    let _ = save_state(&app_data, &fresh);
                }
                drop(_g);
                Err(status)
            }
        }
        Err(ureq::Error::Status(429, r)) => {
            absorb(&r);
            let until = parse_retry_after(r.header("Retry-After"), now);
            record_backoff(&app_data, Some(until), Some(now));
            // NOT a failed report. "straude is rate-limiting this account" is a different fact from
            // "your report did not land", and conflating them sends the user to debug the wrong
            // thing — see SkipReason::RateLimited.
            record_outcome(&app_data, None, SkipReason::RateLimited.as_str().to_string());
            Ok(CycleOutcome::Skipped(SkipReason::RateLimited))
        }
        Err(ureq::Error::Status(401 | 403, r)) => {
            absorb(&r);
            record_outcome(&app_data, None, SkipReason::TokenExpired.as_str().to_string());
            Ok(CycleOutcome::Skipped(SkipReason::TokenExpired))
        }
        Err(e) => {
            // The error string can carry the URL but never the token — that lives only in a header
            // we build locally, and ureq does not echo it.
            let msg = match &e {
                ureq::Error::Status(code, _) => format!("straude returned {code}"),
                ureq::Error::Transport(t) => format!("network error: {t}"),
            };
            record_outcome(&app_data, None, format!("Last report failed — {msg}."));
            record_backoff(&app_data, load_state(&app_data).backoff_until, Some(now));
            Err(msg)
        }
    }
}

/// Guard against two reporter loops racing the same state file.
static LOOP_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Start the background reporter. Idempotent — a second call is a no-op.
///
/// Its own OS thread rather than the async runtime: every step of a cycle is blocking (a transcript
/// scan, then a socket), so this would be a `spawn_blocking` per tick anyway.
pub fn spawn_reporter(app: tauri::AppHandle) {
    if LOOP_RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_REPORT_DELAY);
        loop {
            match crate::dev_identity::app_data_dir(&app) {
                Ok(dir) => {
                    // Re-read the flag every cycle so toggling off takes effect without a restart.
                    let enabled = crate::config::current_effective().config.tools.straude;
                    match submit_once_sync(dir, enabled, CycleKind::Scheduled) {
                        Ok(CycleOutcome::Submitted { landed, days }) => {
                            tracing::info!(landed, days, "straude: reported daily token totals")
                        }
                        Ok(CycleOutcome::Skipped(reason)) => {
                            tracing::debug!(reason = reason.as_str(), "straude: cycle skipped")
                        }
                        Err(e) => tracing::warn!(error = %e, "straude: report failed (will retry)"),
                    }
                }
                Err(e) => tracing::warn!(error = %e, "straude: no app data dir; skipping"),
            }
            std::thread::sleep(REPORT_INTERVAL + std::time::Duration::from_secs(jitter_secs()));
        }
    });
}

// ── tauri commands ──────────────────────────────────────────────────────────────────────────

/// What the settings surface renders. Reports only WHETHER a token is stored, never the token.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StraudeStatus {
    pub enabled: bool,
    pub username: String,
    /// True when a sign-in token is in the keychain. The token itself never reaches JS.
    pub has_token: bool,
    pub consented: bool,
    pub device_id: String,
    pub device_name: String,
    pub report_days: u32,
    pub last_report_at: Option<i64>,
    pub last_status: Option<String>,
    /// `None` when a report would go out; otherwise why it wouldn't, in prose.
    pub blocked_by: Option<String>,
    /// The same answer as a stable code — see [`SkipReason::code`]. The UI keys its badge off this,
    /// never off `blocked_by`'s wording.
    pub blocked_code: Option<String>,
    /// Days until the sign-in lapses, when that is worth showing.
    pub expires_in_days: Option<u32>,
    /// The sign-in has lapsed. Its own field because `expires_in_days: Some(0)` cannot tell
    /// "already dead" from "expires within the day", and those need different words.
    pub expired: bool,
    pub server_url: String,
}

#[tauri::command]
pub async fn straude_status(app: tauri::AppHandle) -> Result<StraudeStatus, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    let enabled = crate::config::current_effective().config.tools.straude;
    tauri::async_runtime::spawn_blocking(move || {
        let state = load_state(&app_data);
        let consented = state.consented_at.is_some();
        // Same rule as the loop, and now literally the same condition. This read `enabled ||
        // consented` while `pre_token_gate` requires BOTH — so an install with the flag on and the
        // consent modal unanswered (the state the pane is opened in, by construction) reached the
        // keychain and, on an unsigned dev build, popped the macOS authorization prompt the
        // invariant exists to prevent.
        let token = if enabled && consented { read_token() } else { Err(SkipReason::NoToken) };
        let has_token = token.is_ok();
        let now = now_secs();
        // The token's real state, so the pane answers the same question the loop does.
        let ts = match &token {
            Ok(t) => token_state(now, jwt_exp(t), true),
            Err(SkipReason::BadToken) => TokenState::Unusable,
            Err(_) => TokenState::Missing,
        };
        // EXPIRED IS ITS OWN FIELD. `Some(0)` could not distinguish "already dead" from "expires
        // within the day", and those need different words from the UI.
        let expired = ts == TokenState::Expired;
        let expires_in_days = match ts {
            TokenState::ExpiringSoon { days_left } => Some(days_left),
            _ => None,
        };
        // THE REAL GATE, not a subset of it. This used to be `pre_token_gate ∧ read_token`, neither
        // of which sees the three things that actually stop a cycle: an EXPIRED token (read_token
        // validates shape, never `exp`), an active BACKOFF, and the manual COOLDOWN. So the pane
        // reported an unblocked reporter for exactly the states this module calls
        // "indistinguishable from the feature being broken".
        let blocked = consent_gate(enabled, consented, ts)
            .and_then(|()| cycle_allowed(now, state.last_cycle_at, state.backoff_until, CycleKind::Manual))
            .err();
        let blocked_by = blocked.map(|r| r.as_str().to_string());
        let blocked_code = blocked.map(|r| r.code().to_string());
        StraudeStatus {
            enabled,
            username: state.username.clone(),
            has_token,
            consented,
            device_id: state.device_id.clone(),
            device_name: state.device_label(),
            report_days: state.window(),
            last_report_at: state.last_report_at,
            // Empty means "nothing to say yet", which the UI renders as absent rather than as a
            // blank status line.
            last_status: Some(state.last_status.clone()).filter(|s| !s.trim().is_empty()),
            blocked_by,
            blocked_code,
            expires_in_days,
            expired,
            server_url: server_url(),
        }
    })
    .await
    .map_err(|e| format!("straude_status task failed: {e}"))
}

/// Begin a browser sign-in. Returns the code + URL the UI opens.
#[tauri::command]
pub async fn straude_login_begin() -> Result<LoginChallenge, String> {
    tauri::async_runtime::spawn_blocking(login_begin_sync)
        .await
        .map_err(|e| format!("straude_login_begin task failed: {e}"))?
}

/// Poll for approval. `Ok(None)` means "still waiting" — the UI keeps polling.
#[tauri::command]
pub async fn straude_login_poll(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || login_poll_sync(&app_data))
        .await
        .map_err(|e| format!("straude_login_poll task failed: {e}"))?
}

/// Record consent and the device label. This is the write the consent modal's confirm makes.
#[tauri::command]
pub async fn straude_consent(
    app: tauri::AppHandle,
    device_name: String,
    consent: bool,
) -> Result<(), String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _g = state_lock().lock();
        let mut state = load_state(&app_data);
        state.device_name = device_name.trim().to_string();
        // TWO-WAY. `consent: false` WITHDRAWS — it does not merely decline to grant. A one-way
        // flag made `straude_consent(name, false)`, the obvious wiring for a decline, write the
        // device name and leave `consented_at` untouched, so a consented user who declined kept
        // publishing every 2h with no signal. The only revoke was `straude_forget`, which is a far
        // bigger hammer: it also destroys the pinned `device_id`, and per this module's header a
        // new id is what over-counts the profile if they ever re-consent.
        state.consented_at = if consent { state.consented_at.or_else(|| Some(now_secs())) } else { None };
        save_state(&app_data, &state)
    })
    .await
    .map_err(|e| format!("straude_consent task failed: {e}"))?
}

/// Forget everything: consent, username, the pinned device id, and the stored token.
#[tauri::command]
pub async fn straude_forget(app: tauri::AppHandle) -> Result<(), String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        // STATE FIRST, and no `?` between them. Clearing consent is the step that actually STOPS
        // publication, and it is the one that cannot fail against the keychain. Deleting the token
        // first with a `?` meant any keychain error (locked keychain, denied authorization on an
        // unsigned build) left consent, the device id AND the token intact — so "Forget everything"
        // returned an error while the reporter kept publishing on the next tick. Fail safe, not open.
        let cleared = {
            let _g = state_lock().lock();
            save_state(&app_data, &StraudeState::default())
        };
        let deleted = delete_token();
        // Report a token-deletion failure WITHOUT undoing the revoke.
        cleared.and(deleted)
    })
    .await
    .map_err(|e| format!("straude_forget task failed: {e}"))?
}

/// "Report now" from the consent modal.
#[tauri::command]
pub async fn straude_report_now(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    let enabled = crate::config::current_effective().config.tools.straude;
    tauri::async_runtime::spawn_blocking(move || {
        match submit_once_sync(app_data, enabled, CycleKind::Manual)? {
            CycleOutcome::Submitted { landed, days } => {
                Ok(format!("Reported {landed} of {days} day(s)."))
            }
            CycleOutcome::Skipped(r) => Err(r.as_str().to_string()),
        }
    })
    .await
    .map_err(|e| format!("straude_report_now task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A record carrying deliberately identifying `project` / `session` values, so the leak
    /// tripwires have something to find if the rollup ever starts reading them.
    fn rec(day: i64, model: &str, input: u64, output: u64) -> UsageRecord {
        UsageRecord {
            id: format!("msg-{day}-{model}-{input}"),
            day,
            model: model.to_string(),
            session: "sess-secret-client-onboarding".to_string(),
            project: "reflective-breeze".to_string(),
            input,
            output,
            cache_5m: 10,
            cache_1h: 0,
            cache_read: 100,
        }
    }

    const TODAY: i64 = 20_600;

    /// Serializes the tests that touch this module's PROCESS-GLOBAL state — `CYCLE_RUNNING` (via
    /// `try_begin_cycle`, which `submit_once_sync` claims) and the `KEYCHAIN_READS` counter.
    ///
    /// vitest-style file parallelism does not apply here, but cargo runs test fns on a THREAD POOL,
    /// so without this two of them interleave and produce a flake that looks like a real failure:
    /// `two_cycles_cannot_post_at_once` cannot claim the slot while an open cycle holds it, and the
    /// "never reads the keychain" assertions compare a global counter another test is incrementing.
    /// Found the honest way — a mutation run went red on the WRONG test.
    ///
    /// Poison-tolerant: one failing test must not cascade into the rest.
    fn cycle_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static L: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        match L.get_or_init(|| std::sync::Mutex::new(())).lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    // ── the leak tripwires ──────────────────────────────────────────────────────────────

    #[test]
    fn straude_payload_never_carries_a_sparkle_agent_or_project_name() {
        // Deliberately STRING-LEVEL over the whole serialized body rather than field-by-field: a
        // field added to the payload next year is covered without anyone remembering to extend
        // this test. Per-field assertions are what let a new key leak quietly.
        let recs = vec![
            rec(TODAY, "claude-opus-5", 100, 200),
            rec(TODAY - 1, "claude-sonnet-5", 50, 60),
        ];
        let r = rollup(recs.iter(), TODAY, 7);
        let state = StraudeState::default();
        let body = build_submit_body(&state, "device-abc".into(), r.entries);
        let json = serde_json::to_string(&body).unwrap();

        // The absence assertions below are only worth anything over a payload that actually
        // CARRIES this usage. Without this, an empty rollup would satisfy every one of them.
        assert_eq!(body.entries.len(), 2, "the fixture's two days must be present");
        assert!(body.entries.iter().all(|e| e.data.total_tokens > 0));
        assert!(json.contains("claude-opus-5"), "the real model id must be on the wire");

        for sentinel in [
            "reflective-breeze",           // a Sparkle agent / project name
            "sess-secret-client-onboarding", // a session id
            "/Users/",                     // any absolute path
            "Projects",
        ] {
            assert!(
                !json.contains(sentinel),
                "payload leaked {sentinel:?}: {json}"
            );
        }
    }

    #[test]
    fn the_hostname_is_never_sent_as_the_device_name() {
        // The default label must be the literal constant, not anything read off the machine.
        let state = StraudeState::default();
        let body = build_submit_body(&state, "device-abc".into(), vec![]);

        // EXACT equality, not "does not contain a hostname I made up". A test that asserts the
        // absence of a sentinel string never present in the fixture cannot fail, whatever the code
        // does. This one can: `device_label()` reaching for the machine's real name would return
        // something that is not the constant, on any machine, and go red immediately.
        assert_eq!(body.device_name.as_deref(), Some(DEFAULT_DEVICE_NAME));

        // And the constant itself must stay a fixed literal rather than become host-derived.
        assert_eq!(DEFAULT_DEVICE_NAME, "Sparkle");
        assert_eq!(StraudeState::default().device_label(), "Sparkle");
    }

    #[test]
    fn a_user_supplied_device_name_is_sent_verbatim() {
        // The PAIR to the test above. Absence alone would pass against a field that never works at
        // all, so this proves the field is genuinely wired before the other proves what it omits.
        let state = StraudeState {
            device_name: "  Studio in the loft  ".into(),
            ..Default::default()
        };
        let body = build_submit_body(&state, "device-abc".into(), vec![]);
        assert_eq!(body.device_name.as_deref(), Some("Studio in the loft"));
    }

    #[test]
    fn agents_is_a_closed_set() {
        assert_eq!(serde_json::to_string(&AgentProduct::Claude).unwrap(), "\"claude\"");
        assert_eq!(serde_json::to_string(&AgentProduct::Codex).unwrap(), "\"codex\"");
        // Every entry the rollup builds reports the product, never an agent.
        let r = rollup([rec(TODAY, "claude-opus-5", 1, 1)].iter(), TODAY, 7);
        assert_eq!(r.entries[0].data.agents, vec![AgentProduct::Claude]);
    }

    #[test]
    fn a_model_id_polluted_with_a_project_name_is_dropped_not_published() {
        let recs = vec![
            rec(TODAY, "claude-opus-5", 100, 100),
            // Shapes a model id can never legitimately take.
            rec(TODAY, "/Users/drodio/Projects/sparkle", 5, 5),
            rec(TODAY, "claude opus with a space", 5, 5),
            rec(TODAY, "Claude-Opus-UPPER", 5, 5),
        ];
        let r = rollup(recs.iter(), TODAY, 7);
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].data.models, vec!["claude-opus-5".to_string()]);
        assert_eq!(r.rejected_models.len(), 3);
        let json = serde_json::to_string(&r.entries).unwrap();
        assert!(!json.contains("Users"), "a path-shaped model id reached the wire");
    }

    #[test]
    fn is_model_id_accepts_real_ids_and_rejects_carriers() {
        for good in [
            "claude-opus-5",
            "claude-haiku-4-5-20251001",
            "claude-sonnet-5",
            "gpt-5",
        ] {
            assert!(is_model_id(good), "{good} should be a model id");
        }
        for bad in [
            "",
            "/Users/me/Projects/x",
            "my project",
            "UPPER",
            "sparkle/agent-42",
            "a\nb",
        ] {
            assert!(!is_model_id(bad), "{bad:?} should be rejected");
        }
    }

    // ── payload shape ───────────────────────────────────────────────────────────────────

    #[test]
    fn the_body_key_set_is_exactly_the_documented_one() {
        let state = StraudeState::default();
        let body = build_submit_body(&state, "d".into(), vec![]);
        let v: serde_json::Value = serde_json::to_value(&body).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["device_id", "device_name", "entries", "source"]);
    }

    #[test]
    fn the_submitted_body_has_no_collector_or_hash_key_at_all() {
        // ABSENT, not null. A null would still be a value the server could interpret, and both
        // fields describe a ccusage run that did not happen here.
        let body = build_submit_body(&StraudeState::default(), "d".into(), vec![]);
        let v: serde_json::Value = serde_json::to_value(&body).unwrap();
        let obj = v.as_object().unwrap();
        assert!(!obj.contains_key("collector"));
        assert!(!obj.contains_key("hash"));
    }

    #[test]
    fn source_is_one_of_the_two_values_the_server_accepts() {
        assert!(matches!(SOURCE, "cli" | "web"));
        let body = build_submit_body(&StraudeState::default(), "d".into(), vec![]);
        assert_eq!(body.source, "cli");
    }

    #[test]
    fn the_entry_keys_are_exactly_the_ccusage_daily_shape() {
        let r = rollup([rec(TODAY, "claude-opus-5", 1, 1)].iter(), TODAY, 7);
        let v = serde_json::to_value(&r.entries[0]).unwrap();
        let mut outer: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        outer.sort_unstable();
        assert_eq!(outer, vec!["data", "date"]);

        let mut inner: Vec<&str> = v["data"]
            .as_object()
            .unwrap()
            .keys()
            .map(|s| s.as_str())
            .collect();
        inner.sort_unstable();
        assert_eq!(
            inner,
            vec![
                "agents",
                "cacheCreationTokens",
                "cacheReadTokens",
                "costUSD",
                "date",
                "inputTokens",
                "modelBreakdown",
                "models",
                "outputTokens",
                "totalTokens",
            ]
        );
        // The server reads by key and the camel/snake asymmetry is ITS shape, not a typo here.
        assert!(v["data"]["modelBreakdown"][0]
            .as_object()
            .unwrap()
            .contains_key("cost_usd"));
    }

    #[test]
    fn entries_have_unique_ascending_dates() {
        // The server rejects a duplicate date in one payload with a 400. Building out of a
        // BTreeMap keyed by day makes that structurally impossible; this pins it.
        let recs: Vec<UsageRecord> = (0..5)
            .flat_map(|i| {
                vec![
                    rec(TODAY - i, "claude-opus-5", 10, 10),
                    rec(TODAY - i, "claude-sonnet-5", 10, 10),
                ]
            })
            .collect();
        let r = rollup(recs.iter(), TODAY, 7);
        let dates: Vec<&str> = r.entries.iter().map(|e| e.date.as_str()).collect();
        let mut sorted = dates.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(dates, sorted, "dates must be unique and ascending");
        assert_eq!(r.entries.len(), 5, "one entry per DAY, not per (day, model)");
        assert_eq!(r.entries[0].data.models.len(), 2, "both models on the day");
    }

    #[test]
    fn entries_never_exceed_the_servers_cap_because_the_window_is_clamped() {
        // Asserting `len() <= MAX_ENTRIES` would be VACUOUS: the window clamp to MAX_REPORT_DAYS
        // (30) already makes >32 unreachable, so that assertion is true before any cap exists and
        // stays true if one is deleted. Assert the clamp itself — the property doing the work.
        let recs: Vec<UsageRecord> = (0..90)
            .map(|i| rec(TODAY - i, "claude-opus-5", 10, 10))
            .collect();
        let r = rollup(recs.iter(), TODAY, 90);
        assert_eq!(
            r.entries.len(),
            MAX_REPORT_DAYS as usize,
            "a 90-day request must be clamped to the 30 days the server accepts"
        );
        assert!(MAX_REPORT_DAYS as usize <= MAX_ENTRIES, "the clamp must imply the cap");
        // The most recent day survives; dropping today would be worse than dropping the oldest.
        assert_eq!(r.entries.last().unwrap().date, crate::spend::epoch_day_label(TODAY));
    }

    // ── cost honesty ────────────────────────────────────────────────────────────────────

    #[test]
    fn an_unpriced_model_ships_its_tokens_and_is_named_rather_than_zero_filled() {
        // A model with no published price contributes TOKENS but no cost. Zero-filling would
        // assert the day was free — and would also drag the total below whatever the server
        // already holds, getting the whole row refused by the monotonic guard.
        let recs = vec![
            rec(TODAY, "claude-opus-5", 1000, 1000),
            rec(TODAY, "some-unreleased-model-9", 1000, 1000),
        ];
        let r = rollup(recs.iter(), TODAY, 7);
        assert_eq!(r.entries.len(), 1);
        let d = &r.entries[0].data;
        assert!(d.total_tokens > 0);
        assert!(d.models.contains(&"some-unreleased-model-9".to_string()));
        assert_eq!(r.unpriced_models, vec!["some-unreleased-model-9".to_string()]);
        // The unpriced model contributes no cost row at all — not a 0.0 one.
        assert!(d.model_breakdown.iter().all(|m| m.model != "some-unreleased-model-9"));
    }

    // ── the monotonic cost guard ────────────────────────────────────────────────────────

    #[test]
    fn a_lower_cost_that_the_server_kept_is_a_failed_report_not_a_success() {
        let res = SubmitResult {
            date: "2026-08-18".into(),
            action: "updated".into(),
            previous_cost: Some(41.02),
            ..Default::default()
        };
        assert_eq!(
            classify_row(33.77, Some(&res)),
            RowVerdict::Superseded { sent: 33.77, kept: 41.02 }
        );
    }

    #[test]
    fn a_created_row_needs_no_previous_cost_to_count_as_landed() {
        let res = SubmitResult { action: "created".into(), ..Default::default() };
        assert_eq!(classify_row(0.0, Some(&res)), RowVerdict::Landed);
    }

    #[test]
    fn an_update_that_meets_the_kept_cost_lands() {
        let res = SubmitResult {
            action: "updated".into(),
            previous_cost: Some(10.0),
            ..Default::default()
        };
        assert_eq!(classify_row(10.5, Some(&res)), RowVerdict::Landed);
        // Exactly equal must land — the server's own predicate is `>=`, and a float round-trip
        // through JSON must not turn that into a spurious failure.
        assert_eq!(classify_row(10.0, Some(&res)), RowVerdict::Landed);
    }

    #[test]
    fn an_update_without_previous_cost_is_unverifiable_not_success() {
        let res = SubmitResult { action: "updated".into(), previous_cost: None, ..Default::default() };
        assert_eq!(classify_row(5.0, Some(&res)), RowVerdict::Unverifiable);
        let odd = SubmitResult { action: "queued".into(), ..Default::default() };
        assert_eq!(classify_row(5.0, Some(&odd)), RowVerdict::Unverifiable);
    }

    #[test]
    fn a_date_we_sent_with_no_result_row_fails() {
        assert_eq!(classify_row(5.0, None), RowVerdict::Missing);
    }

    #[test]
    fn a_blocked_date_is_not_resubmitted_until_our_cost_exceeds_the_kept_one() {
        let mut state = StraudeState::default();
        state.blocked_costs.insert("2026-08-18".into(), 41.02);
        assert!(!should_submit("2026-08-18", 33.77, &state), "cheaper — refused again");
        assert!(!should_submit("2026-08-18", 41.02, &state), "equal — the server already has it");
        assert!(should_submit("2026-08-18", 41.03, &state), "higher — worth another try");
        assert!(should_submit("2026-08-19", 0.0, &state), "an unblocked date is always sent");
    }

    // ── the gate ────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_gate_opens_only_when_every_condition_holds() {
        let valid = TokenState::Valid { days_left: 20 };
        assert_eq!(consent_gate(false, true, valid), Err(SkipReason::Disabled));
        assert_eq!(consent_gate(true, false, valid), Err(SkipReason::NoConsent));
        assert_eq!(consent_gate(true, true, TokenState::Missing), Err(SkipReason::NoToken));
        assert_eq!(consent_gate(true, true, TokenState::Unusable), Err(SkipReason::BadToken));
        assert_eq!(consent_gate(true, true, TokenState::Expired), Err(SkipReason::TokenExpired));
        assert_eq!(consent_gate(true, true, valid), Ok(()));
        assert_eq!(consent_gate(true, true, TokenState::ExpiringSoon { days_left: 2 }), Ok(()));
        // Being OFF is reported ahead of everything else, so an install that never opted in says
        // so rather than nagging for a sign-in it will never use.
        assert_eq!(consent_gate(false, false, TokenState::Missing), Err(SkipReason::Disabled));
    }

    #[test]
    fn the_two_gates_can_never_disagree() {
        // pre_token_gate delegates rather than restating the precedence, so the modal's message and
        // the reason the loop actually skipped cannot drift apart.
        for enabled in [false, true] {
            for consented in [false, true] {
                let state = StraudeState {
                    consented_at: consented.then_some(1),
                    ..Default::default()
                };
                let pre = pre_token_gate(enabled, &state);
                let full = consent_gate(enabled, consented, TokenState::Valid { days_left: 30 });
                assert_eq!(pre, full, "enabled={enabled} consented={consented}");
            }
        }
    }

    #[test]
    fn every_skip_reason_has_a_distinct_stable_code() {
        // The UI keys its "Not publishing" badge off these, so two reasons collapsing onto one code
        // would make an actionable state (a lapsed sign-in) indistinguishable from a benign one
        // (never opted in) — which is precisely the bug the codes were introduced to fix.
        let all = [
            SkipReason::Disabled,
            SkipReason::NoConsent,
            SkipReason::NoToken,
            SkipReason::BadToken,
            SkipReason::TokenExpired,
            SkipReason::CoolingDown,
            SkipReason::RateLimited,
        ];
        let codes: BTreeSet<&str> = all.iter().map(|r| r.code()).collect();
        assert_eq!(codes.len(), all.len(), "two reasons share a code");
        assert!(codes.iter().all(|c| !c.is_empty()));
        // Pin the three the frontend treats as BENIGN by name. A rename here is a silent
        // behaviour change on the badge, so it has to be a deliberate two-file edit.
        assert_eq!(SkipReason::Disabled.code(), "disabled");
        assert_eq!(SkipReason::NoConsent.code(), "no_consent");
        assert_eq!(SkipReason::NoToken.code(), "no_token");
        // And the ones that must NOT be treated as benign.
        assert_eq!(SkipReason::BadToken.code(), "bad_token");
        assert_eq!(SkipReason::TokenExpired.code(), "token_expired");
        assert_eq!(SkipReason::RateLimited.code(), "rate_limited");
    }

    #[test]
    fn only_the_credential_skips_speak_to_the_user() {
        // A default-off install must stay silent rather than nag; a lapsed sign-in is invisible
        // otherwise, because the token rotates only on a successful POST.
        //
        // The three that speak are exactly the CREDENTIAL states, and all three are reachable only
        // past the consent gate. Paired with
        // `a_credential_the_cycle_cannot_use_is_written_where_the_user_can_read_it`, which drives
        // the production path — this assertion alone pinned a predicate nothing called.
        assert!(!SkipReason::Disabled.is_actionable());
        assert!(!SkipReason::NoConsent.is_actionable());
        // Only reachable past the consent gate, so it means "your saved sign-in is gone", never
        // "you never signed in" — the same argument as BadToken.
        assert!(SkipReason::NoToken.is_actionable());
        assert!(SkipReason::BadToken.is_actionable());
        assert!(SkipReason::TokenExpired.is_actionable());
    }

    // ── token lifecycle ─────────────────────────────────────────────────────────────────

    #[test]
    fn token_state_boundaries_at_the_warning_and_the_cliff() {
        let now = 1_800_000_000;
        let day = 86_400;
        assert_eq!(token_state(now, None, false), TokenState::Unusable);
        assert_eq!(token_state(now, Some(now), true), TokenState::Expired);
        assert_eq!(token_state(now, Some(now - 1), true), TokenState::Expired);
        assert_eq!(
            token_state(now, Some(now + day), true),
            TokenState::ExpiringSoon { days_left: 1 }
        );
        assert_eq!(
            token_state(now, Some(now + EXPIRY_WARN_DAYS as i64 * day), true),
            TokenState::ExpiringSoon { days_left: EXPIRY_WARN_DAYS }
        );
        assert_eq!(
            token_state(now, Some(now + (EXPIRY_WARN_DAYS as i64 + 1) * day), true),
            TokenState::Valid { days_left: EXPIRY_WARN_DAYS + 1 }
        );
        // An unreadable expiry must not brick a working sign-in — the server is the judge.
        assert!(matches!(token_state(now, None, true), TokenState::Valid { .. }));
    }

    // ── misc ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_window_is_clamped_to_what_the_server_accepts() {
        assert_eq!(StraudeState::default().window(), DEFAULT_REPORT_DAYS);
        let s = StraudeState { report_days: 500, ..Default::default() };
        assert_eq!(s.window(), MAX_REPORT_DAYS);
        let s = StraudeState { report_days: 1, ..Default::default() };
        assert_eq!(s.window(), 1);
    }

    #[test]
    fn a_non_https_server_override_is_refused_and_a_release_build_ignores_it_entirely() {
        assert_eq!(resolve_server_url(None, true), DEFAULT_SERVER_URL);
        assert_eq!(
            resolve_server_url(Some("http://attacker.example".into()), true),
            DEFAULT_SERVER_URL
        );
        // Even a well-formed https override is ignored in a release build.
        assert_eq!(
            resolve_server_url(Some("https://attacker.example".into()), false),
            DEFAULT_SERVER_URL
        );
        assert_eq!(
            resolve_server_url(Some("https://staging.example".into()), true),
            "https://staging.example"
        );
        assert_eq!(
            resolve_server_url(Some("http://localhost:3000".into()), true),
            "http://localhost:3000"
        );
    }

    #[test]
    fn the_wire_budget_is_the_servers_cap() {
        assert!(fits_wire_budget(&"x".repeat(MAX_BODY_BYTES)));
        assert!(!fits_wire_budget(&"x".repeat(MAX_BODY_BYTES + 1)));
    }

    // ── token lifecycle ─────────────────────────────────────────────────────────────────

    fn jwt(exp: i64) -> String {
        use base64::Engine as _;
        let e = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "{}.{}.{}",
            e.encode(br#"{"alg":"HS256"}"#),
            e.encode(format!(r#"{{"exp":{exp},"sub":"u"}}"#).as_bytes()),
            e.encode(b"sig"),
        )
    }

    #[test]
    fn validate_token_rejects_what_cannot_be_a_header_or_is_not_jwt_shaped() {
        assert!(validate_token(&jwt(1)).is_ok());
        assert!(validate_token("").is_err());
        assert!(validate_token("a.b").is_err(), "two segments is not a JWT");
        assert!(validate_token("a.b.c.d").is_err());
        assert!(validate_token("a..c").is_err(), "an empty segment is not a JWT");
        assert!(validate_token("a b.c.d").is_err(), "a space cannot be a header value");
        assert!(validate_token("a\nb.c.d").is_err(), "a newline cannot be a header value");
    }

    #[test]
    fn jwt_exp_reads_the_claim_and_survives_garbage() {
        assert_eq!(jwt_exp(&jwt(1_800_000_000)), Some(1_800_000_000));
        assert_eq!(jwt_exp("not-a-jwt"), None);
        assert_eq!(jwt_exp("a.!!!!.c"), None);
        // A well-formed JWT with no `exp` reads as no expiry, not as expired — the fail-safe
        // direction, since refusing locally would brick a sign-in the server still honours.
        use base64::Engine as _;
        let e = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let no_exp = format!("{}.{}.{}", e.encode(b"{}"), e.encode(br#"{"sub":"u"}"#), e.encode(b"s"));
        assert_eq!(jwt_exp(&no_exp), None);
        assert!(matches!(token_state(0, jwt_exp(&no_exp), true), TokenState::Valid { .. }));
    }

    #[test]
    fn a_rotated_token_is_kept_even_when_the_submission_did_not_land() {
        // Rotation is independent of whether rows landed: a 4xx can still carry the header, and
        // dropping it there is how a token silently ages out.
        let t = jwt(1_900_000_000);
        assert_eq!(absorb_rotated_token(Some(&t)), Some(t.clone()));
        assert_eq!(absorb_rotated_token(Some("  ")), None);
        assert_eq!(absorb_rotated_token(None), None);
    }

    #[test]
    fn a_malformed_rotation_header_is_ignored_rather_than_bricking_auth() {
        // The old token is still valid for up to three more weeks, so keeping it beats storing a
        // truncated replacement that would malform every future Authorization header.
        //
        // `None`, not an error: the return type is what makes the ignore structural. An `Err` here
        // would invite `absorb_rotated_token(h)?` at the call site, which would turn a SUCCESSFUL
        // submission into a failed cycle over a header that should have cost nothing.
        assert_eq!(absorb_rotated_token(Some("truncated.token")), None);
        assert_eq!(absorb_rotated_token(Some("has space.b.c")), None);
    }

    // ── rate limiting ───────────────────────────────────────────────────────────────────

    #[test]
    fn a_retry_after_header_sets_the_backoff_window() {
        let now = 1_000_000;
        assert_eq!(parse_retry_after(Some("30"), now), now + 30);
        assert_eq!(parse_retry_after(Some(" 45 "), now), now + 45);
    }

    #[test]
    fn a_missing_or_unparseable_retry_after_falls_back_to_a_default_window() {
        // Never an immediate retry — an immediate retry is what earned the 429.
        let now = 1_000_000;
        for h in [None, Some("soon"), Some("0"), Some("-5"), Some("")] {
            assert_eq!(
                parse_retry_after(h, now),
                now + DEFAULT_BACKOFF_SECS,
                "header {h:?} must fall back, not retry now"
            );
        }
    }

    #[test]
    fn an_absurd_retry_after_is_capped_rather_than_parking_reporting_for_a_week() {
        let now = 1_000_000;
        assert_eq!(parse_retry_after(Some("999999999"), now), now + MAX_BACKOFF_SECS);
    }

    #[test]
    fn a_backoff_suppresses_cycles_until_it_expires() {
        let now = 1_000_000;
        assert!(!backoff_active(now, None));
        assert!(backoff_active(now, Some(now + 1)));
        assert!(!backoff_active(now, Some(now)), "expiry is not still active");
        assert!(!backoff_active(now, Some(now - 1)));
    }

    #[test]
    fn a_manual_report_inside_the_cooldown_is_refused() {
        let now = 1_000_000;
        assert!(manual_allowed(now, None), "a first report is always allowed");
        assert!(!manual_allowed(now, Some(now)));
        assert!(!manual_allowed(now, Some(now - MIN_MANUAL_INTERVAL_SECS + 1)));
        assert!(manual_allowed(now, Some(now - MIN_MANUAL_INTERVAL_SECS)));
    }

    #[test]
    fn a_manual_report_during_the_backoff_window_is_refused() {
        // The cooldown alone cannot cover this: 60s is shorter than any backoff the server asks
        // for, so without the backoff arm a user could press once a minute against a server that
        // has explicitly told us to stop, earning a fresh 429 each time.
        let now = 1_000_000;
        let backoff = Some(now + 300);
        assert_eq!(
            cycle_allowed(now, None, backoff, CycleKind::Manual),
            Err(SkipReason::RateLimited)
        );
        // ...and it refuses the BACKGROUND path too, which is the half that was already specified.
        assert_eq!(
            cycle_allowed(now, None, backoff, CycleKind::Scheduled),
            Err(SkipReason::RateLimited)
        );
        // The backoff outranks the cooldown, because it is the server talking rather than a local
        // nicety, and the two reasons stay distinct.
        assert_eq!(
            cycle_allowed(now, Some(now), backoff, CycleKind::Manual),
            Err(SkipReason::RateLimited)
        );
        assert_eq!(
            cycle_allowed(now, Some(now), None, CycleKind::Manual),
            Err(SkipReason::CoolingDown)
        );
        // A scheduled cycle is never subject to the manual cooldown.
        assert_eq!(cycle_allowed(now, Some(now), None, CycleKind::Scheduled), Ok(()));
        // Once the window passes, both paths are free again.
        assert_eq!(cycle_allowed(now + 301, None, backoff, CycleKind::Manual), Ok(()));
    }

    #[test]
    fn a_successful_cycle_clears_the_backoff() {
        // A persisted future timestamp with no clear-on-success rule silently disables reporting
        // past the server's actual window, which is indistinguishable from the feature being broken.
        let dir = tempfile::tempdir().unwrap();
        let consented = StraudeState { consented_at: Some(1), ..Default::default() };
        save_state(dir.path(), &consented).unwrap();

        record_backoff(dir.path(), Some(1_000_500), Some(1_000_000));
        let s = load_state(dir.path());
        assert_eq!(s.backoff_until, Some(1_000_500));
        assert_eq!(s.last_cycle_at, Some(1_000_000));

        record_backoff(dir.path(), None, Some(1_001_000));
        let s = load_state(dir.path());
        assert_eq!(s.backoff_until, None, "a success must clear the window");
        assert_eq!(s.last_cycle_at, Some(1_001_000));
    }

    #[test]
    fn two_cycles_cannot_post_at_once() {
        let _serial = cycle_test_lock();
        let first = try_begin_cycle().expect("the first cycle claims the slot");
        assert!(try_begin_cycle().is_none(), "a second cycle must be refused");
        drop(first);
        let again = try_begin_cycle().expect("the slot is released on drop");
        drop(again);
    }

    // ── tallying a reply ────────────────────────────────────────────────────────────────

    fn entry_for(date: &str, cost: f64) -> SubmitEntry {
        SubmitEntry {
            date: date.into(),
            data: CcusageDailyEntry {
                date: date.into(),
                agents: vec![AgentProduct::Claude],
                models: vec!["claude-opus-5".into()],
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_tokens: 0,
                cache_read_tokens: 0,
                total_tokens: 2,
                cost_usd: cost,
                model_breakdown: vec![],
            },
        }
    }

    #[test]
    fn a_superseded_day_makes_the_whole_cycle_fail() {
        let entries = vec![entry_for("2026-08-17", 33.77), entry_for("2026-08-18", 5.0)];
        let results = vec![
            SubmitResult {
                date: "2026-08-17".into(),
                action: "updated".into(),
                previous_cost: Some(41.02),
                ..Default::default()
            },
            SubmitResult { date: "2026-08-18".into(), action: "created".into(), ..Default::default() },
        ];
        let t = tally(&entries, &results);
        assert_eq!(t.landed, 1);
        assert_eq!(t.superseded.len(), 1);
        assert!(!t.is_ok(), "a kept-older-row day is a FAILED report, not a decorated success");
        assert_eq!(t.blocked(), vec![("2026-08-17".to_string(), 41.02)]);
        let status = submitted_status(&t, &[], false);
        assert!(status.contains("did not land"), "{status}");
        assert!(status.contains("2026-08-17"), "the status must name the day: {status}");
    }

    #[test]
    fn a_day_the_server_never_mentioned_fails_the_cycle() {
        let entries = vec![entry_for("2026-08-18", 5.0)];
        let t = tally(&entries, &[]);
        assert_eq!(t.missing, 1);
        assert!(!t.is_ok());
    }

    #[test]
    fn an_unverifiable_day_degrades_the_status_without_failing_the_cycle() {
        // The server's happy-path body is not a documented contract. Failing every healthy cycle
        // over an unrecognized shape would be a worse bug than the one it catches.
        let entries = vec![entry_for("2026-08-18", 5.0)];
        let results = vec![SubmitResult {
            date: "2026-08-18".into(),
            action: "updated".into(),
            previous_cost: None,
            ..Default::default()
        }];
        let t = tally(&entries, &results);
        assert_eq!(t.unverifiable, 1);
        assert!(t.is_ok(), "unverifiable is not a failure");
        assert!(submitted_status(&t, &[], false).contains("did not say"));
    }

    #[test]
    fn an_all_landed_cycle_is_ok_and_says_so_plainly() {
        let entries = vec![entry_for("2026-08-18", 5.0)];
        let results = vec![SubmitResult {
            date: "2026-08-18".into(),
            action: "created".into(),
            ..Default::default()
        }];
        let t = tally(&entries, &results);
        assert!(t.is_ok());
        let status = submitted_status(&t, &[], false);
        assert!(status.contains("Reported 1 day(s)."), "{status}");
        assert!(!status.contains("did not land"));
        assert!(!status.contains("PARTIAL"));
    }

    #[test]
    fn a_truncated_scan_and_unpriced_models_are_both_disclosed_in_the_status() {
        let entries = vec![entry_for("2026-08-18", 5.0)];
        let results = vec![SubmitResult {
            date: "2026-08-18".into(),
            action: "created".into(),
            ..Default::default()
        }];
        let t = tally(&entries, &results);
        let status = submitted_status(&t, &["some-unreleased-model-9".to_string()], true);
        assert!(status.contains("PARTIAL"), "{status}");
        assert!(status.contains("partial sum"), "{status}");
        assert!(status.contains("some-unreleased-model-9"), "{status}");
    }

    #[test]
    fn a_second_device_is_reported_because_the_profile_sums_them() {
        assert_eq!(coexistence_notice(None), None);
        assert_eq!(coexistence_notice(Some(1)), None);
        let n = coexistence_notice(Some(2)).expect("two devices must raise a notice");
        assert!(n.contains("2 devices"), "{n}");
        assert!(n.contains("turn one of them off"), "{n}");
    }

    // ── device id ───────────────────────────────────────────────────────────────────────

    #[test]
    fn a_minted_device_id_is_a_v4_uuid_and_is_never_repeated() {
        let a = mint_device_id();
        let b = mint_device_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        let parts: Vec<&str> = a.split('-').collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12]);
        assert!(a.starts_with(char::is_alphanumeric));
        assert_eq!(&parts[2][0..1], "4", "version nibble");
        assert!(matches!(&parts[3][0..1], "8" | "9" | "a" | "b"), "variant nibble");
    }

    #[test]
    fn the_device_id_is_pinned_on_first_use_and_never_rederived() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = StraudeState::default();
        let first = ensure_device_id(dir.path(), &mut state);
        assert!(!first.is_empty());
        assert_eq!(state.device_id, first);

        // A completely fresh read of the file must yield the SAME id — re-deriving would split
        // this machine's history across two devices and double-count the overlap.
        let mut reloaded = load_state(dir.path());
        let second = ensure_device_id(dir.path(), &mut reloaded);
        assert_eq!(second, first);

        // And an id already in hand is returned without touching the file at all.
        let mut held = StraudeState { device_id: "pinned-already".into(), ..Default::default() };
        assert_eq!(ensure_device_id(dir.path(), &mut held), "pinned-already");
    }

    #[test]
    fn the_reporter_never_reads_the_straude_cli_config() {
        // A decoy in the shape the CLI writes. Nothing in this module may consult it: sharing the
        // CLI's device row is what makes the monotonic cost guard a race between two price tables.
        let dir = tempfile::tempdir().unwrap();
        let decoy = dir.path().join("config.json");
        std::fs::write(
            &decoy,
            r#"{"device_id":"cli-owned-sentinel-uuid","device_name":"Dans-MacBook-Pro"}"#,
        )
        .unwrap();

        let mut state = StraudeState::default();
        let id = ensure_device_id(dir.path(), &mut state);
        assert_ne!(id, "cli-owned-sentinel-uuid");

        let body = build_submit_body(&state, id, vec![]);
        let json = serde_json::to_string(&body).unwrap();
        assert!(!json.contains("cli-owned-sentinel-uuid"), "{json}");
        assert!(!json.contains("Dans-MacBook-Pro"), "{json}");
    }

    #[test]
    fn a_withdrawn_consent_mid_cycle_leaves_no_status_behind() {
        // A user who turned this off between the POST and its reply must not find a fresh status
        // waiting for them.
        let dir = tempfile::tempdir().unwrap();
        record_outcome(dir.path(), Some(123), "Reported 3 day(s).".into());
        assert_eq!(load_state(dir.path()), StraudeState::default());

        // With consent recorded, the same call DOES write — the pair, so the test above cannot
        // pass against a record_outcome that never writes at all.
        let consented = StraudeState { consented_at: Some(1), ..Default::default() };
        save_state(dir.path(), &consented).unwrap();
        record_outcome(dir.path(), Some(123), "Reported 3 day(s).".into());
        let after = load_state(dir.path());
        assert_eq!(after.last_report_at, Some(123));
        assert_eq!(after.last_status, "Reported 3 day(s).");
    }

    #[test]
    fn a_gated_cycle_never_reaches_for_the_keychain_or_a_socket() {
        let _serial = cycle_test_lock();
        // THE HEADLINE INVARIANT. An install that never opted in must be completely inert: no
        // keychain read (an unsigned dev build touching the signed app's item pops a macOS
        // authorization prompt — being prompted every 2h by a feature you never enabled is the
        // opposite of inert) and no socket. Asserting the ORDER of statements in submit_once_sync
        // is the only thing that stops a later edit reintroducing an unconditional read.
        use std::sync::atomic::Ordering;
        let dir = tempfile::tempdir().unwrap();

        // Disabled AND unconsented — the default state of every install.
        let before = KEYCHAIN_READS.load(Ordering::SeqCst);
        let out = submit_once_sync(dir.path().to_path_buf(), false, CycleKind::Scheduled).unwrap();
        assert_eq!(out, CycleOutcome::Skipped(SkipReason::Disabled));
        assert_eq!(
            KEYCHAIN_READS.load(Ordering::SeqCst),
            before,
            "a disabled cycle read the keychain"
        );

        // Enabled but NOT consented — the state between flipping the toggle and answering the
        // modal. Still must not reach for a credential.
        let out = submit_once_sync(dir.path().to_path_buf(), true, CycleKind::Scheduled).unwrap();
        assert_eq!(out, CycleOutcome::Skipped(SkipReason::NoConsent));
        assert_eq!(
            KEYCHAIN_READS.load(Ordering::SeqCst),
            before,
            "an unconsented cycle read the keychain"
        );

        // Nothing was written either: a gated cycle leaves no trace at all.
        assert_eq!(load_state(dir.path()), StraudeState::default());
        assert!(!state_path(dir.path()).exists(), "a gated cycle created a state file");
    }

    #[test]
    fn a_fully_gated_open_cycle_DOES_read_the_keychain() {
        let _serial = cycle_test_lock();
        // THE POSITIVE CONTROL. Without it every keychain assertion in this module is `0 == 0`:
        // no test ever observed the counter INCREMENT, so deleting the `fetch_add` would leave the
        // "never touches the keychain" tests green forever while the invariant they name went
        // unguarded.
        //
        // Runs the gate open — enabled, consented, no backoff — so the read is reached. There is no
        // token in the test keychain, so it skips with NoToken immediately after; what is being
        // asserted is that it got FAR ENOUGH to look.
        use std::sync::atomic::Ordering;
        let dir = tempfile::tempdir().unwrap();
        let state = StraudeState { consented_at: Some(1), ..Default::default() };
        save_state(dir.path(), &state).unwrap();

        let before = KEYCHAIN_READS.load(Ordering::SeqCst);
        let out = submit_once_sync(dir.path().to_path_buf(), true, CycleKind::Scheduled).unwrap();
        let after = KEYCHAIN_READS.load(Ordering::SeqCst);
        assert_eq!(after, before + 1, "an open cycle must reach the keychain exactly once");
        // Whatever this machine's keychain holds for the dev service, the cycle cannot post: a
        // missing token skips with NoToken, a stored-but-unusable one with BadToken. Both prove the
        // read happened, which is the point.
        assert!(
            matches!(
                out,
                CycleOutcome::Skipped(SkipReason::NoToken)
                    | CycleOutcome::Skipped(SkipReason::BadToken)
                    | CycleOutcome::Skipped(SkipReason::TokenExpired)
            ),
            "unexpected outcome: {out:?}"
        );
    }

    #[test]
    fn a_credential_the_cycle_cannot_use_is_written_where_the_user_can_read_it() {
        let _serial = cycle_test_lock();
        // An opted-in install whose keychain entry was deleted (or whose keychain is locked) used
        // to skip in TOTAL silence: `read_token`'s Err returned straight out with no
        // `record_outcome`, so `last_status` kept whatever the last successful cycle wrote — or
        // stayed empty forever — and the badge saw a benign-looking `no_token`. Reporting was dead
        // and nothing on any surface said so. This is the paired positive control for
        // `skip_reasons_that_are_worth_telling_the_user_about`, which otherwise pinned an
        // `is_actionable` that no production code called.
        let dir = tempfile::tempdir().unwrap();
        let state = StraudeState { consented_at: Some(1), ..Default::default() };
        save_state(dir.path(), &state).unwrap();

        let out = submit_once_sync(dir.path().to_path_buf(), true, CycleKind::Scheduled).unwrap();
        // Whatever this machine's dev keychain holds, an open cycle cannot post here; all three
        // reachable reasons are actionable, so the assertion below always runs.
        let reason = match out {
            CycleOutcome::Skipped(r @ (SkipReason::NoToken | SkipReason::BadToken | SkipReason::TokenExpired)) => r,
            other => panic!("unexpected outcome: {other:?}"),
        };
        assert!(reason.is_actionable());
        assert_eq!(
            load_state(dir.path()).last_status,
            reason.as_str(),
            "an unusable credential must leave a status the user can act on"
        );
        // Not a landed report: the timestamp that drives the staleness badge must not advance.
        assert_eq!(load_state(dir.path()).last_report_at, None);
    }

    #[test]
    fn a_consented_cycle_inside_a_backoff_stops_before_the_keychain_too() {
        let _serial = cycle_test_lock();
        // The backoff check sits between the consent gate and the token read, so a rate-limited
        // cycle costs nothing — not a keychain prompt, not a socket.
        use std::sync::atomic::Ordering;
        let dir = tempfile::tempdir().unwrap();
        let now = now_secs();
        let state = StraudeState {
            consented_at: Some(1),
            backoff_until: Some(now + 3600),
            ..Default::default()
        };
        save_state(dir.path(), &state).unwrap();

        let before = KEYCHAIN_READS.load(Ordering::SeqCst);
        let out = submit_once_sync(dir.path().to_path_buf(), true, CycleKind::Scheduled).unwrap();
        assert_eq!(out, CycleOutcome::Skipped(SkipReason::RateLimited));
        assert_eq!(KEYCHAIN_READS.load(Ordering::SeqCst), before);
    }

    #[test]
    fn a_day_whose_models_are_all_unpriced_is_not_published_as_free() {
        // costUSD is REQUIRED here, so "omit the key" (tkmx's escape) is unavailable. Shipping 0.0
        // would assert a day with real tokens cost nothing, on a service whose subject is spend —
        // and it would set the server's monotonic floor at 0 and read back as Landed, so the false
        // number would look confirmed.
        let recs = vec![
            rec(TODAY, "some-unreleased-model-9", 5000, 5000),
            rec(TODAY - 1, "claude-opus-5", 100, 100),
        ];
        let r = rollup(recs.iter(), TODAY, 7);
        let dates: Vec<&str> = r.entries.iter().map(|e| e.date.as_str()).collect();
        assert_eq!(dates, vec![crate::spend::epoch_day_label(TODAY - 1)]);
        assert_eq!(r.withheld_days, vec![crate::spend::epoch_day_label(TODAY)]);
        // No entry anywhere may carry a zero cost while tokens are present.
        assert!(r.entries.iter().all(|e| e.data.cost_usd > 0.0 || e.data.total_tokens == 0));

        let t = SubmitTally { landed: 1, ..Default::default() };
        let status = submitted_status_with_withheld(&t, &r.unpriced_models, false, &r.withheld_days);
        assert!(status.contains("held back"), "{status}");
        assert!(status.contains("costing $0"), "{status}");
    }

    #[test]
    fn a_mixed_day_still_ships_with_an_honest_partial_cost() {
        // The PAIR to the test above: withholding must apply only when NOTHING can be priced, or
        // one unknown model would silently delete a day that is mostly known.
        let recs = vec![
            rec(TODAY, "claude-opus-5", 1000, 1000),
            rec(TODAY, "some-unreleased-model-9", 1000, 1000),
        ];
        let r = rollup(recs.iter(), TODAY, 7);
        assert_eq!(r.entries.len(), 1, "a mixed day must still be reported");
        assert!(r.withheld_days.is_empty());
        assert!(r.entries[0].data.cost_usd > 0.0);
    }

    #[test]
    fn a_valid_state_file_round_trips() {
        // The PAIR to the corrupt-file test, which passes identically against a load_state that
        // ignores the file and always returns the default. Without this, a serde shape mismatch
        // would silently reset consent and re-mint the device id on every launch.
        let dir = tempfile::tempdir().unwrap();
        let mut blocked = BTreeMap::new();
        blocked.insert("2026-08-17".to_string(), 41.02);
        let original = StraudeState {
            username: "drodio".into(),
            device_id: "abc-123".into(),
            device_name: "Studio".into(),
            consented_at: Some(1_700_000_000),
            last_report_at: Some(1_700_000_100),
            last_status: "Reported 3 day(s).".into(),
            report_days: 14,
            last_cycle_at: Some(1_700_000_050),
            backoff_until: Some(1_700_000_600),
            blocked_costs: blocked,
        };
        save_state(dir.path(), &original).unwrap();
        assert_eq!(load_state(dir.path()), original);
    }

    #[test]
    fn the_state_write_is_atomic_so_a_torn_write_cannot_re_mint_the_device_id() {
        // Our device_id is a RANDOM uuid pinned forever — unlike builder_index's, which is derived
        // and so re-derivable — so a truncated file is unrecoverable and costs the user a second
        // device on their profile.
        //
        // THE ASSERTION HAD TO BE THE INODE. "No .tmp left behind" and "the id round-trips" are
        // both true of the plain `fs::write` this replaced, so they proved nothing about atomicity
        // — the exact "would this pass against the code as it was before my change?" shape. A
        // rename swaps in a NEW inode; an in-place write reuses the old one, so this is the one
        // cheap observation that tells the two implementations apart.
        use std::os::unix::fs::MetadataExt as _;
        let dir = tempfile::tempdir().unwrap();
        let state = StraudeState { device_id: "pinned".into(), consented_at: Some(1), ..Default::default() };
        save_state(dir.path(), &state).unwrap();
        let first = std::fs::metadata(state_path(dir.path())).unwrap().ino();

        save_state(dir.path(), &state).unwrap();
        let second = std::fs::metadata(state_path(dir.path())).unwrap().ino();
        assert_ne!(first, second, "the state file was written IN PLACE, not renamed into position");

        // Weaker second check: no temp file survives a successful write.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left a temp file behind: {leftovers:?}");
        assert_eq!(load_state(dir.path()).device_id, "pinned");
    }

    #[test]
    fn a_reordered_results_array_is_still_matched_by_date() {
        // Pairing by INDEX compiles and passes a naive test, then misattributes every verdict the
        // moment the server reorders — turning a Superseded into a Landed, the exact silent drop
        // this mechanism exists to detect.
        let entries = vec![entry_for("2026-08-17", 10.0), entry_for("2026-08-18", 20.0)];
        let results = vec![
            // Deliberately REVERSED relative to `entries`.
            SubmitResult {
                date: "2026-08-18".into(),
                action: "created".into(),
                ..Default::default()
            },
            SubmitResult {
                date: "2026-08-17".into(),
                action: "updated".into(),
                previous_cost: Some(99.0),
                ..Default::default()
            },
        ];
        let t = tally(&entries, &results);
        assert_eq!(t.landed, 1, "only the 08-18 row landed");
        assert_eq!(t.superseded.len(), 1);
        assert_eq!(t.superseded[0].0, "2026-08-17", "the verdict followed the DATE, not the index");
    }

    #[test]
    fn a_result_for_a_date_we_did_not_send_is_not_credited() {
        let entries = vec![entry_for("2026-08-18", 5.0)];
        let results = vec![SubmitResult {
            date: "1999-01-01".into(),
            action: "created".into(),
            ..Default::default()
        }];
        let t = tally(&entries, &results);
        assert_eq!(t.landed, 0);
        assert_eq!(t.missing, 1, "a row for another date proves nothing about ours");
        assert!(!t.is_ok());
        assert_eq!(result_for("2026-08-18", &results), None);
    }

    #[test]
    fn every_superseded_day_is_named_or_counted_in_the_status() {
        // blocked() holds ALL of them back, and a sealed past day never clears, so disclosing only
        // the first would strand the rest silently.
        let entries = vec![
            entry_for("2026-08-16", 1.0),
            entry_for("2026-08-17", 2.0),
            entry_for("2026-08-18", 3.0),
        ];
        let results: Vec<SubmitResult> = entries
            .iter()
            .map(|e| SubmitResult {
                date: e.date.clone(),
                action: "updated".into(),
                previous_cost: Some(100.0),
                ..Default::default()
            })
            .collect();
        let t = tally(&entries, &results);
        assert_eq!(t.superseded.len(), 3);
        assert_eq!(t.blocked().len(), 3);
        let status = submitted_status(&t, &[], false);
        assert!(status.contains("3 day(s) did not land"), "{status}");
        for d in ["2026-08-16", "2026-08-17", "2026-08-18"] {
            assert!(status.contains(d), "status must name {d}: {status}");
        }
    }

    #[test]
    fn a_backoff_further_out_than_the_max_is_not_honoured() {
        // The ceiling has to hold where the value is USED, not only where it is parsed: a window
        // written under a fast clock outlives its intended life, and once the clock corrects it
        // refuses every cycle forever — the clear-on-success rule cannot recover that, because no
        // cycle can run to succeed.
        let now = 1_000_000;
        assert!(backoff_active(now, Some(now + MAX_BACKOFF_SECS)));
        assert!(!backoff_active(now, Some(now + MAX_BACKOFF_SECS + 1)));
        for kind in [CycleKind::Manual, CycleKind::Scheduled] {
            assert_eq!(
                cycle_allowed(now, None, Some(now + MAX_BACKOFF_SECS + 1), kind),
                Ok(()),
                "an unhonourable window must not gate {kind:?}"
            );
            assert_eq!(
                cycle_allowed(now, None, Some(now + MAX_BACKOFF_SECS - 1), kind),
                Err(SkipReason::RateLimited),
                "a window inside the ceiling must still gate {kind:?}"
            );
        }
    }

    #[test]
    fn a_future_last_cycle_at_from_a_clock_jump_does_not_wedge_the_manual_path() {
        // `now - t` on a future stamp is large and negative, which would kill "Report now" for the
        // whole skew while claiming the user had just reported.
        let now = 1_000_000;
        assert!(manual_allowed(now, Some(now + 86_400)), "a clock jump must not wedge the button");
        assert_eq!(cycle_allowed(now, Some(now + 86_400), None, CycleKind::Manual), Ok(()));
        // And the ordinary cooldown still works.
        assert!(!manual_allowed(now, Some(now - 1)));
    }

    #[test]
    fn the_module_never_claims_the_device_name_is_published() {
        // This claim has already been written twice and measured false twice. Pin it against the
        // SOURCE so it cannot come back a third time — including into the consent copy, which is
        // written from these docs.
        //
        // Deliberately narrow phrases: the module header's own warning contains "the device name is
        // published", so a broad grep would match the rule telling you not to write it — the
        // doc-pinning trap where a body-wide search is satisfied by its own narrative.
        // SCOPED to the module's own docs and code, not the whole file: this test's banned-phrase
        // LIST contains every phrase, so a body-wide search matches itself and can never pass. Same
        // trap as a doc grep satisfied by the rule's own "an earlier version said…" narrative.
        let src = include_str!("straude.rs");
        // Split on the test MODULE, not on the first `#[cfg(test)]` — that attribute also sits on
        // the KEYCHAIN_READS counter far above, which cut the guarded region to the top ~30% of the
        // file and left every user-facing status string and command doc unchecked. Those are
        // exactly the surfaces the false claim would reappear on.
        let doc = src
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("the module has a test block");
        // A sanity check the mis-split would FAIL, unlike a length threshold that 794 lines clears
        // as easily as 1621.
        assert!(
            doc.contains("pub fn submitted_status"),
            "the scoped region must reach the user-facing status copy"
        );
        for banned in [
            "published on the public post",
            "shown on the public post",
            "label published on",
            "publicly rendered",
        ] {
            assert!(
                !doc.contains(banned),
                "the module says {banned:?} — device_name is NOT rendered publicly"
            );
        }
        // And the true statement IS present, so this cannot pass by the text simply being deleted.
        // Matched on the header's contiguous phrasing: the field doc wraps mid-sentence across two
        // `///` lines, so a search for the wrapped form fails for a formatting reason rather than a
        // factual one.
        assert!(doc.contains("NOT rendered on any public surface"));
    }

    #[test]
    fn an_all_withheld_window_produces_a_status_rather_than_silence() {
        // The fix for "a day was published as free" reintroduced the same silent drop one branch
        // upstream: the days are correctly withheld and the user is told NOTHING, while the loop
        // logs landed=0 days=0 every 2h forever. Realistic right after a model release, when the
        // price table lags and every day in the window uses only the new model.
        let msg = nothing_to_send_status(&["2026-08-18".into()], 0, &["new-model-1".into()], false)
            .expect("a withheld day must produce a status");
        assert!(msg.contains("held back"), "{msg}");
        assert!(msg.contains("2026-08-18"), "the status must name the day: {msg}");
        assert!(msg.contains("costing $0"), "{msg}");

        // The sealed-past-day half lands in the same branch and must speak too.
        let msg = nothing_to_send_status(&[], 3, &[], false).expect("held-back days must say so");
        assert!(msg.contains("3 day(s) are held back"), "{msg}");
        assert!(msg.contains("higher cost"), "{msg}");

        // THE PAIR, and the reason this is not just an assertion that a formatter formats: a quiet
        // machine with a genuinely empty window has nothing to report, and must NOT get a status
        // line invented for it. Without this, returning `Some(..)` unconditionally would pass.
        assert_eq!(nothing_to_send_status(&[], 0, &[], false), None);
        assert_eq!(nothing_to_send_status(&[], 0, &["x".into()], true), None);
    }

    #[test]
    fn withdrawing_consent_does_not_disturb_the_pinned_device_id() {
        let _serial = cycle_test_lock();
        // `straude_consent(name, false)` must actually REVOKE. The one-way version wrote the device
        // name and left consented_at alone, so a user who declined kept publishing with no signal —
        // and the only revoke was `forget`, which also destroys the device id and so over-counts
        // the profile if they ever re-consent.
        let dir = tempfile::tempdir().unwrap();
        let granted = StraudeState {
            consented_at: Some(1_700_000_000),
            device_id: "pinned-uuid".into(),
            ..Default::default()
        };
        save_state(dir.path(), &granted).unwrap();

        // The withdraw, as the command performs it.
        {
            let _g = state_lock().lock();
            let mut st = load_state(dir.path());
            st.device_name = "Studio".to_string();
            st.consented_at = None;
            save_state(dir.path(), &st).unwrap();
        }
        let after = load_state(dir.path());
        assert_eq!(after.consented_at, None, "consent must actually be withdrawn");
        assert_eq!(after.device_id, "pinned-uuid", "the device id must survive a withdraw");

        // And the reporter honours it on the very next cycle.
        assert_eq!(
            submit_once_sync(dir.path().to_path_buf(), true, CycleKind::Scheduled).unwrap(),
            CycleOutcome::Skipped(SkipReason::NoConsent)
        );
    }

    #[test]
    fn a_backoff_or_an_expired_token_is_named_in_blocked_by() {
        // `blocked_by` used to be computed from a SUBSET of the gate, so the pane reported an
        // unblocked reporter for exactly the states that stop every cycle. Asserted against the
        // same functions `straude_status` composes.
        let now = 1_800_000_000;
        let valid = TokenState::Valid { days_left: 20 };

        let blocked = |ts, last: Option<i64>, backoff: Option<i64>| {
            consent_gate(true, true, ts)
                .and_then(|()| cycle_allowed(now, last, backoff, CycleKind::Manual))
                .err()
        };
        assert_eq!(blocked(valid, None, None), None, "a healthy reporter is not blocked");
        assert_eq!(blocked(TokenState::Expired, None, None), Some(SkipReason::TokenExpired));
        assert_eq!(blocked(valid, None, Some(now + 300)), Some(SkipReason::RateLimited));
        assert_eq!(blocked(valid, Some(now), None), Some(SkipReason::CoolingDown));
    }

    #[test]
    fn a_corrupt_state_file_reads_as_not_consented_rather_than_consented() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(state_path(dir.path()), "{ not json").unwrap();
        let s = load_state(dir.path());
        assert_eq!(s.consented_at, None, "a corrupt file must never read as consent");
        assert!(s.device_id.is_empty());
    }
}
