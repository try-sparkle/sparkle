//! Local token-spend analytics over Claude Code's session transcripts (bead sparkle-s3g2.3).
//!
//! Claude Code writes one JSONL file per session under `<config>/projects/<slug>/<session>.jsonl`
//! (`<config>` = `$CLAUDE_CONFIG_DIR` if set, else `$HOME/.claude` — the same root `claude.rs`
//! resolves for session detection). Assistant records carry a `message.usage` object with
//! `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`
//! (plus, on newer versions, a `cache_creation` breakdown of 5m vs 1h ephemeral writes) and a
//! `message.model`. Those transcripts are the authoritative record of what an agent actually
//! spent, which is why they — not Sparkle's own hook-event logs — are the data source here.
//!
//! Everything in this module is LOCAL: it reads files on this machine and returns a report. There
//! is no network egress of any kind, and there never should be — a future opt-in Builder Index
//! (tkmx) reporter would sit on top of [`SpendReport`], behind its own consent gate.
//!
//! Design notes:
//!   • Bounded — only the trailing `window_days` (default 30, clamped) are aggregated, and a file
//!     whose mtime predates the window is skipped without being opened (transcripts are
//!     append-only, so a record's timestamp can never exceed its file's mtime).
//!   • Tolerant — a malformed line, an unparseable timestamp, or a missing `usage` is skipped
//!     rather than failing the scan. Transcripts are read while Claude Code is still writing them.
//!   • Deduplicated — resuming a session copies prior turns into a NEW transcript, so the same
//!     assistant message id appears in several files. Records are deduped by message id across the
//!     whole scan; without that, a heavy resume user's totals are silently inflated.
//!   • Memoized — parsed records are cached per (path, mtime, len), so re-opening the pane costs
//!     a `stat` per file instead of a full re-parse.
//!   • Costs are ESTIMATES at list API rates (see [`PRICING_NOTE`]). Unknown models contribute
//!     tokens but no cost, and are reported in `unknownModels` so the table can say so out loud.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

/// Default trailing window when the caller doesn't ask for one.
const DEFAULT_WINDOW_DAYS: u32 = 30;
/// Clamp for the caller-supplied window. A year of transcripts is already a heavy scan; beyond
/// that the memo (which holds every in-window record in memory) stops being a good trade.
const MAX_WINDOW_DAYS: u32 = 365;
/// Backstop on how many transcript files one scan will open. A pathological `projects/` tree
/// (hundreds of thousands of files) must not wedge the pane; the report says when this bit.
const MAX_FILES: usize = 20_000;
/// How many session rows the report carries. The pane shows the heaviest sessions; the full list
/// would be thousands of rows of no value.
const MAX_SESSION_ROWS: usize = 50;

/// The caveat that rides along with every cost number, surfaced verbatim in the UI. Costs here are
/// arithmetic over token counts at published list rates — they are NOT a bill.
pub const PRICING_NOTE: &str = "Estimated from local transcripts at published list API rates \
    (cache writes 1.25×/2× input, cache reads 0.1× input). Actual charges differ: subscription \
    plans (Claude Pro/Max) bill no per-token cost at all, and batch, promotional, and \
    enterprise rates are not reflected. Models with no known price contribute tokens but no cost.";

// ── pricing ─────────────────────────────────────────────────────────────────────────────────

/// List price per MILLION tokens for one model family.
#[derive(Clone, Copy)]
struct Price {
    input: f64,
    output: f64,
}

/// Per-million list rates, keyed by model-id PREFIX so dated snapshots
/// (`claude-sonnet-4-5-20250929`) match their family. Longest matching prefix wins, so
/// `claude-opus-4-5` beats `claude-opus-4` for `claude-opus-4-5-20251101`.
const PRICING: &[(&str, Price)] = &[
    ("claude-fable-5", Price { input: 10.0, output: 50.0 }),
    ("claude-mythos-5", Price { input: 10.0, output: 50.0 }),
    ("claude-mythos-preview", Price { input: 10.0, output: 50.0 }),
    ("claude-opus-5", Price { input: 5.0, output: 25.0 }),
    ("claude-opus-4-8", Price { input: 5.0, output: 25.0 }),
    ("claude-opus-4-7", Price { input: 5.0, output: 25.0 }),
    ("claude-opus-4-6", Price { input: 5.0, output: 25.0 }),
    ("claude-opus-4-5", Price { input: 5.0, output: 25.0 }),
    ("claude-opus-4-1", Price { input: 15.0, output: 75.0 }),
    ("claude-opus-4", Price { input: 15.0, output: 75.0 }),
    ("claude-3-opus", Price { input: 15.0, output: 75.0 }),
    ("claude-sonnet-5", Price { input: 3.0, output: 15.0 }),
    ("claude-sonnet-4-6", Price { input: 3.0, output: 15.0 }),
    ("claude-sonnet-4-5", Price { input: 3.0, output: 15.0 }),
    ("claude-sonnet-4", Price { input: 3.0, output: 15.0 }),
    ("claude-3-7-sonnet", Price { input: 3.0, output: 15.0 }),
    ("claude-3-5-sonnet", Price { input: 3.0, output: 15.0 }),
    ("claude-haiku-4-5", Price { input: 1.0, output: 5.0 }),
    ("claude-3-5-haiku", Price { input: 0.80, output: 4.0 }),
    ("claude-3-haiku", Price { input: 0.25, output: 1.25 }),
];

/// Cache-write multipliers over the input rate: 1.25× for the default 5-minute TTL, 2× for 1 hour.
const CACHE_WRITE_5M_MULT: f64 = 1.25;
const CACHE_WRITE_1H_MULT: f64 = 2.0;
/// Cache reads bill at 0.1× the input rate.
const CACHE_READ_MULT: f64 = 0.1;

/// Normalize a raw `message.model` for pricing/grouping: lowercase, and drop a trailing bracketed
/// variant tag (`claude-opus-5[1m]` → `claude-opus-5`) which marks a context tier, not a model.
fn normalize_model(raw: &str) -> String {
    let s = raw.trim().to_ascii_lowercase();
    match s.find('[') {
        Some(i) => s[..i].trim_end_matches('-').to_string(),
        None => s,
    }
}

/// Does `model` match a [`PRICING`] prefix at a boundary the table INTENDED?
///
/// THE BUG THIS FIXES: a bare `starts_with` has no family-version boundary, so any unlisted future
/// member of a listed family silently inherits the shortest ancestor's rate instead of being
/// reported as unknown. `claude-opus-4-9-20261101` matched `claude-opus-4` and priced at the legacy
/// $15/$75 tier — a 3× OVERSTATEMENT, invisible because `priced` stayed true. That is exactly the
/// failure the `unknownModels` mechanism exists to prevent.
///
/// A match is only accepted when the model IS the prefix, or the remainder starts a DATED SNAPSHOT
/// (`-20…`, as in `claude-sonnet-4-5-20250929`) — the one continuation the table is written for.
/// Any other remainder (`-9`, `-5`, `-next`) is a version we haven't priced, so it falls through to
/// unknown: the report then counts its tokens and says the model is unpriced, which is the honest
/// answer and the safe direction.
fn matches_pricing_prefix(model: &str, prefix: &str) -> bool {
    let Some(rest) = model.strip_prefix(prefix) else {
        return false;
    };
    // `-20…` is the API's dated form; `@20…` and `-v<N>@20…` are Vertex AI's
    // (`claude-sonnet-4@20250514`, `claude-3-5-sonnet-v2@20241022`); `-latest` is the alias form.
    // All name the same family at the same rate. Anything else (`-9`, `-5`, `-next`) is a version
    // we haven't priced and falls through to unknown.
    rest.is_empty()
        || rest.starts_with("-20")
        || rest.starts_with("@20")
        || rest == "-latest"
        || (rest.starts_with("-v")
            && rest[2..].split_once('@').is_some_and(|(n, date)| {
                !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && date.starts_with("20")
            }))
}

/// Longest-prefix lookup into [`PRICING`], boundary-checked by [`matches_pricing_prefix`]. `None`
/// for a model we have no published rate for — callers must then count tokens without inventing a
/// cost.
fn price_for(model: &str) -> Option<Price> {
    PRICING
        .iter()
        .filter(|(prefix, _)| matches_pricing_prefix(model, prefix))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, p)| *p)
}

// ── civil-date arithmetic (no chrono dependency) ────────────────────────────────────────────

/// Days since the Unix epoch for a proleptic-Gregorian Y-M-D (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let (m, d) = (m as i64, d as i64);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverse of [`days_from_civil`] — epoch day → (year, month, day). Used to label the chart's
/// buckets, so a day with no usage still gets a dated column instead of vanishing.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn format_day(epoch_day: i64) -> String {
    let (y, m, d) = civil_from_days(epoch_day);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Epoch DAY (UTC) for a Claude Code ISO-8601 timestamp (`2026-06-25T21:20:25.931Z`). Only the
/// date part is needed, so the time and any fractional/offset tail are ignored. `None` on anything
/// malformed — the caller skips that record rather than bucketing it into the wrong day.
fn day_from_iso8601(s: &str) -> Option<i64> {
    let date = s.split('T').next()?;
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month)
    {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

/// Real length of a month, leap years included.
///
/// A flat `1..=31` check accepted `2026-02-31`, and `days_from_civil` then NORMALIZED it into
/// March 3 — a malformed timestamp landing silently in the wrong day bucket, which is precisely
/// what rejecting it is supposed to avoid.
fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

// ── record model ────────────────────────────────────────────────────────────────────────────

/// One billed assistant turn, flattened out of a transcript line. This is the atom the whole
/// module aggregates over; keeping it small matters because the memo holds every in-window record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageRecord {
    /// Dedup key — the API message id when present (stable across resume copies), else the
    /// record's own uuid. Two records with the same id are the same billed turn.
    pub id: String,
    /// Epoch day (UTC) the turn happened on.
    pub day: i64,
    /// Normalized model id (see [`normalize_model`]).
    pub model: String,
    /// Session id — the transcript's file stem.
    pub session: String,
    /// Human-readable project label (basename of the record's `cwd`, else the directory slug).
    pub project: String,
    pub input: u64,
    pub output: u64,
    /// 5-minute-TTL cache writes (the default TTL, and where an un-broken-down total lands).
    pub cache_5m: u64,
    /// 1-hour-TTL cache writes.
    pub cache_1h: u64,
    pub cache_read: u64,
}

impl UsageRecord {
    fn cache_creation(&self) -> u64 {
        self.cache_5m.saturating_add(self.cache_1h)
    }

    fn total_tokens(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_creation())
            .saturating_add(self.cache_read)
    }

    /// Estimated list-rate cost in USD, or `None` when the model has no published price.
    /// Delegates, so the arithmetic exists once — see [`estimate_cost_usd`].
    fn cost_usd(&self) -> Option<f64> {
        estimate_cost_usd(
            &self.model,
            self.input,
            self.output,
            self.cache_5m,
            self.cache_1h,
            self.cache_read,
        )
    }
}

// ── parsing ─────────────────────────────────────────────────────────────────────────────────

fn u64_field(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// Split a `usage` object's cache WRITES into (5m, 1h) TTL buckets.
///
/// Shared with `accounts.rs`'s pill scanner rather than spelled twice: the two bill differently
/// (1.25x vs 2x input), so a module that reads only the flat `cache_creation_input_tokens` values
/// every 1h write low — which is precisely the divergence the shared price table was introduced to
/// end, one level down in the inputs. One copy means a future TTL bucket or a renamed key can't
/// update only half the app.
///
/// Falls back to the flat total when the breakdown is absent OR present-but-empty (a `{}` or a
/// future key name we don't recognize): attributing the whole thing to the default 5m TTL
/// under-states slightly, whereas trusting an empty object would silently DROP the tokens.
pub(crate) fn cache_write_split(usage: &Value) -> (u64, u64) {
    if let Some(cc) = usage.get("cache_creation").filter(|v| v.is_object()) {
        let (m5, h1) = (
            u64_field(cc, "ephemeral_5m_input_tokens"),
            u64_field(cc, "ephemeral_1h_input_tokens"),
        );
        if m5 > 0 || h1 > 0 {
            return (m5, h1);
        }
    }
    (u64_field(usage, "cache_creation_input_tokens"), 0)
}

/// Parse one transcript line into a [`UsageRecord`], or `None` when the line isn't a billed
/// assistant turn (user turn, summary, half-written tail, synthetic/no-usage record).
///
/// `session` and `project_fallback` come from the file's path; `cwd` on the record wins for the
/// project label when present, because the slug is a lossy 1:1 character encoding of a path.
/// `ordinal` is the line's position in its file, used only to make the NO-ID fallback key unique:
/// the fallback key was `{session}:{day}:{input}:{output}:{cache_read}`, which
/// collides for two genuinely distinct turns in the same session on the same day with identical
/// token counts — very common for small repeated turns (`1:0:0`) — so those turns were deduped away
/// and undercounted. The ordinal keeps intra-file uniqueness while staying stable across re-scans
/// (transcripts are append-only, so line N is always line N).
pub fn parse_line(
    line: &str,
    session: &str,
    project_fallback: &str,
    ordinal: u64,
) -> Option<UsageRecord> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    // Cheap pre-filter: only a minority of lines carry token usage, and json parsing dominates.
    if !line.contains("\"usage\"") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;

    let usage = v
        .get("message")
        .and_then(|m| m.get("usage"))
        .or_else(|| v.get("usage"))?;

    let raw_model = v
        .get("message")
        .and_then(|m| m.get("model"))
        .and_then(Value::as_str)
        .or_else(|| v.get("model").and_then(Value::as_str))
        .unwrap_or("");
    // `<synthetic>` marks a locally fabricated turn (e.g. an interrupt notice). It has no real
    // provider cost and no real model, so counting it would inflate both tokens and spend.
    if raw_model.is_empty() || raw_model.starts_with('<') {
        return None;
    }
    let model = normalize_model(raw_model);

    let day = day_from_iso8601(v.get("timestamp").and_then(Value::as_str)?)?;

    let input = u64_field(usage, "input_tokens");
    let output = u64_field(usage, "output_tokens");
    let cache_read = u64_field(usage, "cache_read_input_tokens");
    // Newer Claude Code versions break cache writes down by TTL, which matters because a 1h write
    // bills at 2× input vs 1.25× for 5m. When the breakdown is absent, attribute the whole total
    // to the default 5m TTL rather than guessing high.
    let (cache_5m, cache_1h) = cache_write_split(usage);

    if input == 0 && output == 0 && cache_read == 0 && cache_5m == 0 && cache_1h == 0 {
        return None;
    }

    let id = v
        .get("message")
        .and_then(|m| m.get("id"))
        .and_then(Value::as_str)
        .or_else(|| v.get("requestId").and_then(Value::as_str))
        .or_else(|| v.get("uuid").and_then(Value::as_str))
        // No id at all: fall back to a positional key so the record still counts once per file.
        // (Duplicates across resume copies can't be detected without an id — accepted.)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{session}:{ordinal}:{day}:{input}:{output}:{cache_read}"));

    let project = v
        .get("cwd")
        .and_then(Value::as_str)
        .and_then(project_label_from_cwd)
        .unwrap_or_else(|| project_fallback.to_string());

    Some(UsageRecord {
        id,
        day,
        model,
        session: session.to_string(),
        project,
        input,
        output,
        cache_5m,
        cache_1h,
        cache_read,
    })
}

/// Human label for a working directory: its last path component. Empty/`/` yields `None` so the
/// caller falls back to the directory slug.
fn project_label_from_cwd(cwd: &str) -> Option<String> {
    Path::new(cwd)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

// ── report shape ────────────────────────────────────────────────────────────────────────────

/// Token counts for one rollup bucket. `total` is materialized (not derived in the UI) so every
/// consumer — pane, future tkmx reporter — agrees on what "total tokens" means.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_creation: u64,
    pub cache_read: u64,
    pub total: u64,
}

impl Tokens {
    fn add(&mut self, r: &UsageRecord) {
        self.input = self.input.saturating_add(r.input);
        self.output = self.output.saturating_add(r.output);
        self.cache_creation = self.cache_creation.saturating_add(r.cache_creation());
        self.cache_read = self.cache_read.saturating_add(r.cache_read);
        self.total = self.total.saturating_add(r.total_tokens());
    }
}

/// A bucket's tokens plus its cost split: `estimated_cost_usd` covers only the records we could
/// price, and `unpriced_tokens` is how many tokens sat behind unknown models. Reporting both
/// keeps "cost is low" and "cost is unknown" from looking identical.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub tokens: Tokens,
    pub estimated_cost_usd: f64,
    pub unpriced_tokens: u64,
    pub messages: u64,
}

impl Bucket {
    fn add(&mut self, r: &UsageRecord) {
        self.tokens.add(r);
        self.messages = self.messages.saturating_add(1);
        match r.cost_usd() {
            Some(c) => self.estimated_cost_usd += c,
            None => self.unpriced_tokens = self.unpriced_tokens.saturating_add(r.total_tokens()),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayTotal {
    /// `YYYY-MM-DD`, UTC.
    pub date: String,
    #[serde(flatten)]
    pub bucket: Bucket,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelTotal {
    pub model: String,
    /// False when the model has no published rate — the UI shows "—" instead of "$0.00".
    pub priced: bool,
    #[serde(flatten)]
    pub bucket: Bucket,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTotal {
    pub project: String,
    pub sessions: u64,
    /// `YYYY-MM-DD` of the most recent in-window activity.
    pub last_active: String,
    #[serde(flatten)]
    pub bucket: Bucket,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTotal {
    pub session_id: String,
    pub project: String,
    pub last_active: String,
    #[serde(flatten)]
    pub bucket: Bucket,
}

/// The whole local spend picture for a trailing window. This is the reusable data shape: the
/// History & Spend pane renders it, and a future opt-in Builder Index reporter would summarize it
/// — neither needs to re-derive anything from the transcripts.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpendReport {
    pub window_days: u32,
    /// Epoch SECONDS the report was produced.
    pub generated_at: i64,
    /// One entry per day in the window, oldest first, INCLUDING zero-usage days so the chart's
    /// x-axis is a real calendar rather than a list of busy days.
    pub days: Vec<DayTotal>,
    /// Heaviest model first.
    pub models: Vec<ModelTotal>,
    /// Heaviest project first.
    pub projects: Vec<ProjectTotal>,
    /// Heaviest sessions first, capped at [`MAX_SESSION_ROWS`].
    pub sessions: Vec<SessionTotal>,
    pub totals: Bucket,
    /// Models seen with no published rate — surfaced so an unpriced total is explainable.
    pub unknown_models: Vec<String>,
    pub files_scanned: usize,
    /// True when [`MAX_FILES`] cut the scan short, so the UI never presents a partial scan as complete.
    pub truncated: bool,
    /// Where transcripts were read from (empty when no root could be resolved).
    pub roots: Vec<String>,
    pub pricing_note: String,
    /// The timezone every `date`/`lastActive` in this report is bucketed in — always
    /// [`REPORT_TIMEZONE`]. Carried explicitly so the pane can SAY so: days are UTC civil days, and
    /// for a user in UTC-7 an evening session is attributed to "tomorrow", so "today's spend" reads
    /// as zero until mid-morning. Stating it beats surprising them.
    pub timezone: String,
}

/// The timezone the report buckets days in. UTC because that is what the transcript timestamps are
/// and re-bucketing them locally would make the report depend on the reader's machine.
pub const REPORT_TIMEZONE: &str = "UTC";

// ── aggregation (pure) ──────────────────────────────────────────────────────────────────────

/// The window filter + resume-dedup that EVERY consumer of a scan shares. Returns the in-window
/// records, one per message id, in input order.
///
/// Both facts here are contract, not detail:
///   • the window is `[first_day, today]` inclusive, so a future-dated record from a clock-skewed
///     synced transcript is dropped rather than creating a row dated after today;
///   • a repeated id keeps the LAST occurrence, and `load_records` hands records oldest-file-first,
///     so a turn a resume copied into a newer transcript is attributed to the session the user
///     actually sees. The winner REPLACES its predecessor in place, so accumulation order stays the
///     input order instead of a `HashMap`'s.
///
/// It is shared — rather than reimplemented per consumer — because it is the one rule the Spend
/// pane and the published Builder Index row must agree on. `builder_index::rollup` had its own copy
/// that kept the FIRST occurrence, so any field that differed between a resumed copy and its
/// original (a corrected token count, a timestamp crossing the UTC day boundary) bucketed one way
/// locally and the other way on the wire — the exact "they can never disagree" invariant both
/// modules' docs claim.
pub(crate) fn dedupe_window<'a>(
    records: impl Iterator<Item = &'a UsageRecord>,
    first_day: i64,
    today: i64,
) -> Vec<&'a UsageRecord> {
    let mut position: HashMap<&str, usize> = HashMap::new();
    let mut chosen: Vec<&UsageRecord> = Vec::new();
    for r in records {
        if r.day < first_day || r.day > today {
            continue;
        }
        match position.get(r.id.as_str()) {
            Some(&i) => chosen[i] = r,
            None => {
                position.insert(r.id.as_str(), chosen.len());
                chosen.push(r);
            }
        }
    }
    chosen
}

/// Roll borrowed records into a [`SpendReport`] over the window ending at `today` (epoch day).
///
/// Pure and dedup-aware, and free of filesystem and clock access, so the whole aggregation contract
/// is unit-testable from fixtures. Takes BORROWED records so the scan can roll up the memo's
/// `Arc<Vec<_>>` contents in place instead of cloning every record into one flat vec first (which
/// doubled the footprint of a heavy scan).
///
/// DEDUP, and why the order matters: resuming a session copies prior turns into a NEW transcript, so
/// the same message id appears in several files. This used to keep the FIRST occurrence in
/// `read_dir` order — which is OS/inode-dependent and unstable — so which session/project a turn was
/// attributed to could flip between two runs over identical files: session rows, per-project
/// `sessions` counts and `lastActive` all changed on a pane reopen, and `MAX_SESSION_ROWS` could cut
/// a different set. Callers now hand records in a deterministic order (see `load_records`: oldest
/// file first) and the LAST occurrence wins, so a resumed turn lands in the session the user
/// actually sees. The chosen record REPLACES its predecessor in place, so the accumulation order
/// stays the input order rather than a HashMap's.
pub fn aggregate_records<'a>(
    records: impl Iterator<Item = &'a UsageRecord>,
    today: i64,
    window_days: u32,
) -> SpendReport {
    let window = window_days.clamp(1, MAX_WINDOW_DAYS);
    let first_day = today - (window as i64 - 1);

    let records = dedupe_window(records, first_day, today);

    let mut totals = Bucket::default();
    let mut by_day: HashMap<i64, Bucket> = HashMap::new();
    let mut by_model: HashMap<String, Bucket> = HashMap::new();
    // Project rollups also track distinct sessions and the newest day touched.
    let mut by_project: HashMap<String, (Bucket, HashSet<String>, i64)> = HashMap::new();
    let mut by_session: HashMap<String, (Bucket, String, i64)> = HashMap::new();
    let mut unknown: HashSet<String> = HashSet::new();

    for r in records {
        totals.add(r);
        by_day.entry(r.day).or_default().add(r);
        by_model.entry(r.model.clone()).or_default().add(r);
        if price_for(&r.model).is_none() {
            unknown.insert(r.model.clone());
        }
        let proj = by_project.entry(r.project.clone()).or_insert_with(|| {
            (Bucket::default(), HashSet::new(), r.day)
        });
        proj.0.add(r);
        proj.1.insert(r.session.clone());
        proj.2 = proj.2.max(r.day);
        let sess = by_session
            .entry(r.session.clone())
            .or_insert_with(|| (Bucket::default(), r.project.clone(), r.day));
        sess.0.add(r);
        sess.2 = sess.2.max(r.day);
    }

    // Contiguous calendar, oldest first — zero-usage days are real information in a spend chart.
    let days: Vec<DayTotal> = (first_day..=today)
        .map(|d| DayTotal {
            date: format_day(d),
            bucket: by_day.remove(&d).unwrap_or_default(),
        })
        .collect();

    let mut models: Vec<ModelTotal> = by_model
        .into_iter()
        .map(|(model, bucket)| ModelTotal {
            priced: price_for(&model).is_some(),
            model,
            bucket,
        })
        .collect();
    // Deterministic order: heaviest first, ties broken by name so the table never reshuffles
    // between two identical reports.
    models.sort_by(|a, b| {
        b.bucket
            .tokens
            .total
            .cmp(&a.bucket.tokens.total)
            .then_with(|| a.model.cmp(&b.model))
    });

    let mut projects: Vec<ProjectTotal> = by_project
        .into_iter()
        .map(|(project, (bucket, sessions, last))| ProjectTotal {
            project,
            sessions: sessions.len() as u64,
            last_active: format_day(last),
            bucket,
        })
        .collect();
    projects.sort_by(|a, b| {
        b.bucket
            .tokens
            .total
            .cmp(&a.bucket.tokens.total)
            .then_with(|| a.project.cmp(&b.project))
    });

    let mut sessions: Vec<SessionTotal> = by_session
        .into_iter()
        .map(|(session_id, (bucket, project, last))| SessionTotal {
            session_id,
            project,
            last_active: format_day(last),
            bucket,
        })
        .collect();
    sessions.sort_by(|a, b| {
        b.bucket
            .tokens
            .total
            .cmp(&a.bucket.tokens.total)
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    sessions.truncate(MAX_SESSION_ROWS);

    let mut unknown_models: Vec<String> = unknown.into_iter().collect();
    unknown_models.sort();

    SpendReport {
        window_days: window,
        generated_at: 0,
        days,
        models,
        projects,
        sessions,
        totals,
        unknown_models,
        files_scanned: 0,
        truncated: false,
        roots: Vec::new(),
        pricing_note: PRICING_NOTE.to_string(),
        timezone: REPORT_TIMEZONE.to_string(),
    }
}

// ── filesystem scan + memo ──────────────────────────────────────────────────────────────────

/// A file's parsed records, keyed by the identity we validate on re-scan. Transcripts only grow,
/// so (mtime, len) unchanged ⇒ contents unchanged ⇒ the cached records are still correct.
struct CachedFile {
    mtime: SystemTime,
    len: u64,
    records: Arc<Vec<UsageRecord>>,
    /// The scan generation that last USED this entry. Drives LRU eviction and protects the current
    /// pass's own entries — see [`MEMO_CAPACITY`] and [`evict_to`].
    last_touch: u64,
    /// WHEN that touch happened, so staleness is measured in time rather than in other callers'
    /// scan counts — see [`MEMO_STALE_AFTER`]. MONOTONIC (`Instant`, not `SystemTime`): with a wall
    /// clock, one NTP correction or a sleep/resume puts every entry "in the future" and the whole
    /// memo is swept — a full re-parse of a heavy install triggered by a clock tick.
    touched_at: std::time::Instant,
}

/// How many files' records the memo retains.
///
/// It used to be REBUILT from each pass (`*cache = next`), which dropped every entry the pass
/// didn't see. Alternating window sizes — the 7d chip vs the 28d default — therefore evicted each
/// other's entries and re-parsed from scratch every switch, defeating the memo's stated purpose.
/// Now entries are retained and evicted least-recently-touched.
///
/// The bound is a WORKING SET, deliberately far below [`MAX_FILES`]: the memo exists so the 7d and
/// 28d panes share a warm cache, and both are served by the last pass or two — while `MAX_FILES`
/// would let ~20k files' records (hundreds of MB on a heavy install) sit resident for the process
/// lifetime just because the pane was opened once. Eviction also drops entries untouched for
/// [`MEMO_STALE_AFTER`] and entries whose file no longer exists, so a deleted or aged-out
/// transcript doesn't pin memory until capacity forces it out. The CURRENT pass's entries are
/// preferred over everything else — see [`evict_to`] — but only up to [`MEMO_HARD_CAP`], which is
/// the number that actually bounds memory.
///
/// Note the memo has TWO consumers: the Spend pane and `builder_index`'s 2h reporter loop, which
/// scans its own (fixed) window in the background. They share this bound.
const MEMO_CAPACITY: usize = 4_000;

/// The ceiling that is ENFORCED, current pass or not.
///
/// [`MEMO_CAPACITY`] is a soft target: a pass whose working set is larger than it keeps its own
/// entries, because evicting them mid-pass is what made a heavy install re-parse the same files
/// forever. But "prefer the current pass" alone is not a bound — on an install whose in-window set
/// exceeds the capacity, EVERY pass touches every entry, so nothing is ever evictable and the memo
/// settles at `MAX_FILES` files' records (the hundreds of megabytes `MEMO_CAPACITY` exists to
/// prevent). Past this hard cap the current pass's own entries are evicted too, OLDEST FILE FIRST
/// (by mtime), so what survives is the recently-written transcripts a re-scan is most likely to
/// want — not an alphabetical prefix.
const MEMO_HARD_CAP: usize = 2 * MEMO_CAPACITY;

/// Entries untouched for this long are dropped at eviction time even under capacity — they belong
/// to files that fell out of every window anyone is looking at.
///
/// TIME, not a scan count. Counting generations made the unit caller-frequency dependent, and with
/// the background reporter scanning every 2h that is a live problem rather than a theoretical one:
/// N reporter passes at a fixed window would age out every entry only the pane's larger window
/// needs, with no user interaction at all.
///
/// It MUST exceed `builder_index::REPORT_INTERVAL` (2h) — otherwise the reporter can never hit its
/// own previous pass, and each of its passes sweeps every pane entry older than the horizon. Set
/// above it with margin rather than tuned independently.
const MEMO_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(3 * 60 * 60);

fn memo() -> &'static Mutex<HashMap<PathBuf, CachedFile>> {
    static MEMO: OnceLock<Mutex<HashMap<PathBuf, CachedFile>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A scan generation, LIVE for as long as this value exists.
///
/// RAII rather than a mint/retire pair, because the two cannot then be separated by an unwind: a
/// panic between them (a hostile transcript in `parse_file`, an OOM, a failing assert in a test on
/// this path) would leak the generation into the live set permanently, and every memo entry stamped
/// with it becomes exempt from tier-1 eviction forever. This module already treats a panicking scan
/// as a real scenario — the memo lock is deliberately poison-tolerant.
struct ScanGeneration(u64);

impl ScanGeneration {
    /// Monotonic, so "least recently used" is a comparison rather than a clock read.
    fn start() -> Self {
        static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let g = GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        live_generations()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(g);
        Self(g)
    }

    fn id(&self) -> u64 {
        self.0
    }
}

impl Drop for ScanGeneration {
    fn drop(&mut self) {
        live_generations()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// Parse every usage record out of one transcript file. Streams line-by-line so a multi-hundred-MB
/// transcript never lands in memory whole.
///
/// Reads BYTES and decodes lossily rather than using `BufRead::lines()`, which yields `Err` on the
/// first invalid UTF-8 byte. The old code broke out of the loop there, silently discarding every
/// remaining record in the file — one stray byte in a large tool-output line zeroed out the rest of
/// that session's spend, and the caller had no way to know. A malformed byte now costs at most the
/// characters it replaces.
fn parse_file(path: &Path) -> Vec<UsageRecord> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let session = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();
    let project_fallback = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    let mut out = Vec::new();
    let mut reader = BufReader::new(file);
    let mut raw = Vec::new();
    let mut ordinal: u64 = 0;
    loop {
        raw.clear();
        // A genuine IO error (not a decode error) ends the file; records already collected are kept.
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&raw);
        if let Some(r) = parse_line(&line, &session, &project_fallback, ordinal) {
            out.push(r);
        }
        ordinal += 1;
    }
    out
}

/// Depth-first collect of every `.jsonl` under `root` whose mtime is at or after `cutoff_secs`.
///
/// Recursion follows REAL directories only (`file_type()` does not follow links), which is the
/// cycle guard against a self-referential symlink under `projects/`. The mtime pre-filter is exact
/// rather than heuristic: transcripts are append-only, so every record in a file untouched since
/// before the window is itself out of window.
///
/// Sets `stopped_early` when the `limit` actually cut the walk short. Inferring that from
/// `len() == limit` (the old rule) reports a partial scan on a tree that holds exactly the cap
/// and was in fact scanned completely.
///
/// `limit` is THIS root's budget, not the whole scan's. See [`collect_all`]: one shared budget
/// consumed in root order let a single busy store starve every root behind it, which is the
/// underreporting the multi-root scan exists to prevent, just moved to a different root.
fn collect_files(
    root: &Path,
    cutoff_secs: i64,
    out: &mut Vec<PathBuf>,
    stopped_early: &mut bool,
    limit: usize,
) {
    if out.len() >= limit {
        *stopped_early = true;
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            // There was still something left to look at — the cap is what stopped us.
            *stopped_early = true;
            return;
        }
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            collect_files(&path, cutoff_secs, out, stopped_early, limit);
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        {
            // std::fs::metadata FOLLOWS symlinks (unlike DirEntry::metadata's lstat), so a
            // symlinked transcript is judged by the mtime of the file we'd actually parse.
            // Fail OPEN on a stat error — never silently under-count.
            if let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) {
                if let Ok(dur) = modified.duration_since(UNIX_EPOCH) {
                    if (dur.as_secs() as i64) < cutoff_secs {
                        continue;
                    }
                }
            }
            out.push(path);
        }
    }
}

/// Collect the in-window transcripts under every root, giving each root a GUARANTEED share of the
/// [`MAX_FILES`] budget before any root gets seconds.
///
/// One shared budget consumed in root order meant whichever root came last could be skipped
/// entirely — and with several busy account stores that root is `~/.claude`, typically the user's
/// largest. `truncated: true` was the only signal, while the pane still listed the unscanned root.
/// Each root now gets `MAX_FILES / roots.len()` first; whatever the modest roots leave unused is
/// then redistributed to the roots that hit their share, in REVERSE root order — `order_roots` puts
/// the primary store last precisely because it is the biggest, so handing out seconds front-to-back
/// would let a small account store absorb the remainder ahead of the root most likely to need it.
///
/// Each root is guaranteed at least ONE file, so with more roots than budget the result can exceed
/// `budget` (bounded by `roots.len()`). Unreachable at `MAX_FILES`; stated because "≤ budget" is
/// otherwise the natural assumption.
///
/// The cross-root dedupe happens AFTER budgeting, so with overlapping roots a duplicate consumes
/// share and is then discarded: the returned set can be smaller than what the budget paid for, and
/// `truncated` can be true while the result sits below `budget`. Acceptable because overlapping
/// roots are the rare shape (`transcript_roots` already collapses the identical ones) and because
/// budgeting per canonical path would mean canonicalizing during the walk itself, on every file.
///
/// What the cap drops WITHIN a root is an arbitrary walk-order subset, not the oldest files:
/// [`collect_files`] walks in `read_dir` (inode/OS) order and only filters on the window, and the
/// oldest-first sort happens afterwards in [`load_records`]. So a truncated root's dropped set is
/// unordered — `truncated` says the number is short, not which files are missing.
/// `budget` is injected so the starvation policy is testable without writing 20 000 files.
fn collect_all(roots: &[PathBuf], cutoff_secs: i64, budget: usize) -> (Vec<PathBuf>, bool) {
    if roots.is_empty() {
        return (Vec::new(), false);
    }
    let share = (budget / roots.len()).max(1);
    let mut per_root: Vec<Vec<PathBuf>> = Vec::with_capacity(roots.len());
    let mut hungry: Vec<usize> = Vec::new();
    for (i, root) in roots.iter().enumerate() {
        let mut out = Vec::new();
        let mut stopped = false;
        collect_files(root, cutoff_secs, &mut out, &mut stopped, share);
        if stopped {
            hungry.push(i);
        }
        per_root.push(out);
    }

    // Seconds: hand the unclaimed remainder to the roots that used their whole share, in root
    // order. Re-walking a hungry root with the larger limit is cheap next to parsing its files.
    let used: usize = per_root.iter().map(Vec::len).sum();
    let mut spare = budget.saturating_sub(used);
    let mut truncated = false;
    hungry.reverse();
    for i in hungry {
        if spare == 0 {
            truncated = true;
            continue;
        }
        let mut out = Vec::new();
        let mut stopped = false;
        collect_files(&roots[i], cutoff_secs, &mut out, &mut stopped, share + spare);
        spare = spare.saturating_sub(out.len().saturating_sub(per_root[i].len()));
        truncated |= stopped;
        per_root[i] = out;
    }
    // Deduped on the CANONICAL path across roots: `transcript_roots` collapses roots that ARE the
    // same tree, but not roots that OVERLAP (one nested under the other, or reaching a shared tree
    // by different spellings). The same transcript would otherwise get two `stats` entries, two
    // blocks, and double-counted id-less records — the same defect `accounts.rs`'s walk fixed.
    // ACROSS roots only — a duplicate WITHIN one root (a transcript symlinked into a second
    // project) is existing counted behavior, and changing it is a separate decision.
    //
    // Skipped entirely for a single root: `canonical_key` is an `fs::canonicalize` per file, and
    // with one root a cross-root duplicate cannot exist (`read_dir` doesn't repeat entries and the
    // walk never descends symlinked dirs). One root is the common shape — no account stores — and
    // this walk is on the pane's path over the largest tree in the install.
    if per_root.len() < 2 {
        return (per_root.into_iter().flatten().collect(), truncated);
    }
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut files: Vec<PathBuf> = Vec::new();
    for root_files in per_root {
        let keys: Vec<PathBuf> = root_files.iter().map(|p| canonical_key(p)).collect();
        files.extend(
            root_files
                .into_iter()
                .zip(keys.iter())
                .filter(|(_, key)| !seen.contains(*key))
                .map(|(p, _)| p),
        );
        seen.extend(keys);
    }
    (files, truncated)
}

/// Read every in-window record under `roots`, using (and refreshing) the per-file memo.
///
/// Returns the per-file record blocks (shared, NOT cloned — see [`aggregate_records`]) in a
/// DETERMINISTIC order: oldest mtime first, ties broken by path. That ordering is what makes the
/// report reproducible, because the resume-dedup rule is "the newest file wins" and `read_dir`
/// order is OS/inode-dependent.
///
/// The global memo lock is taken TWICE, briefly, and never across the parsing: holding it for a
/// whole scan serialized concurrent `spend_report` calls behind hundreds of milliseconds of
/// blocking IO.
fn load_records(roots: &[PathBuf], cutoff_secs: i64) -> (Vec<Arc<Vec<UsageRecord>>>, usize, bool) {
    let (files, truncated) = collect_all(roots, cutoff_secs, MAX_FILES);

    // Stat once, up front: the mtime is both the sort key and half the memo's validity key.
    let mut stats: Vec<(PathBuf, SystemTime, u64)> = files
        .into_iter()
        .filter_map(|p| {
            let meta = std::fs::metadata(&p).ok()?;
            Some((p, meta.modified().unwrap_or(UNIX_EPOCH), meta.len()))
        })
        .collect();
    // Oldest first, path as the tiebreaker so two files with identical mtimes still order stably.
    stats.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));

    // Pass 1 (lock held, no IO): collect the hits, and note which entries this pass isn't touching
    // so their files can be checked for deletion WITHOUT the lock.
    let pass = ScanGeneration::start();
    let generation = pass.id();
    let now = std::time::Instant::now();
    let mut blocks: Vec<Option<Arc<Vec<UsageRecord>>>> = vec![None; stats.len()];
    let untouched: Vec<PathBuf>;
    {
        // Poison-tolerant: a panic in a prior scan must not permanently disable the memo.
        let mut cache = memo().lock().unwrap_or_else(|e| e.into_inner());
        for (i, (path, mtime, len)) in stats.iter().enumerate() {
            if let Some(entry) = cache.get_mut(path) {
                if entry.mtime == *mtime && entry.len == *len {
                    entry.last_touch = generation;
                    entry.touched_at = now;
                    blocks[i] = Some(Arc::clone(&entry.records));
                }
            }
        }
        untouched = cache
            .iter()
            .filter(|(_, c)| c.last_touch != generation)
            .map(|(p, _)| p.clone())
            .collect();
    }

    // Pass 2 (NO lock): parse the misses — the expensive part, which another scan can run
    // concurrently through — and, in the same unlocked stretch, find the cached files that are gone
    // from disk. That `stat` per entry used to run under the lock inside eviction.
    let parsed: Vec<(usize, Arc<Vec<UsageRecord>>)> = blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b.is_none())
        .map(|(i, _)| (i, Arc::new(parse_file(&stats[i].0))))
        .collect();
    let gone: Vec<PathBuf> = untouched.into_iter().filter(|p| !p.exists()).collect();

    // Pass 3 (lock held, no IO): publish what we parsed, then evict.
    {
        let mut cache = memo().lock().unwrap_or_else(|e| e.into_inner());
        for (i, records) in parsed {
            let (path, mtime, len) = &stats[i];
            cache.insert(
                path.clone(),
                CachedFile {
                    mtime: *mtime,
                    len: *len,
                    records: Arc::clone(&records),
                    last_touch: generation,
                    touched_at: now,
                },
            );
            blocks[i] = Some(records);
        }
        evict_to_capacity(&mut cache, generation, now, &gone);
    }

    drop(pass); // no longer live: its entries become tier-1 evictable from here on
    let count = blocks.len();
    (blocks.into_iter().flatten().collect(), count, truncated)
}

/// Production eviction, run under the memo lock with NO filesystem access: drop the entries a
/// preceding unlocked pass found gone from disk (`gone`), then the ones untouched for longer than
/// [`MEMO_STALE_AFTER`], then enforce the size bounds.
///
/// The deleted-file check is NOT here, deliberately. It is a `stat` per entry, and doing it under
/// the global lock is the one thing `load_records`' own doc promises not to do ("never across the
/// parsing… holding it for a whole scan serialized concurrent `spend_report` calls"). `load_records`
/// now collects the candidate paths under the pass-1 lock, stats them while unlocked, and hands the
/// dead ones here.
///
/// Retaining by last touch — rather than wiping everything this pass didn't see — is what lets the
/// 7d and 28d views share a warm cache instead of evicting each other.
fn evict_to_capacity(
    cache: &mut HashMap<PathBuf, CachedFile>,
    generation: u64,
    now: std::time::Instant,
    gone: &[PathBuf],
) {
    for path in gone {
        // Unless this pass just touched it: the file existed moments ago as far as this scan is
        // concerned, and the unlocked check races with a concurrent write.
        if cache.get(path).is_some_and(|c| c.last_touch != generation) {
            cache.remove(path);
        }
    }
    cache.retain(|_, c| {
        c.last_touch == generation || now.duration_since(c.touched_at) < MEMO_STALE_AFTER
    });
    evict_two_tier(
        cache,
        MEMO_CAPACITY,
        MEMO_HARD_CAP,
        |g| live_generations().lock().unwrap_or_else(|e| e.into_inner()).contains(&g),
        |c| (c.last_touch, c.mtime),
    );
}

/// The scan generations currently RUNNING. A pass registers itself in `next_generation` and clears
/// itself when it finishes; tier 1 of the eviction never touches an entry belonging to one of them.
///
/// Comparing against a single generation was not enough: the Spend pane and the 2h Builder Index
/// reporter share this memo and overlap, so whichever finished first saw the other's freshly
/// touched entries as "nobody wants these" and trimmed the working set out from under a running
/// scan — the exact failure the generation exemption exists to prevent, one level up.
fn live_generations() -> &'static Mutex<HashSet<u64>> {
    static LIVE: OnceLock<Mutex<HashSet<u64>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashSet::new()))
}



/// The two-tier size bound, shared by BOTH transcript memos (this one and `accounts.rs`'s usage
/// memo) so they cannot drift apart again — they already had opposite rationales documented for the
/// same tier. Generic over the value type; `key` yields `(last_touch, mtime)`.
///
/// Tier 1 — down to `target`, evict entries no LIVE pass has touched, least-recently-used first
/// (ties by path, so the evicted set is deterministic). Evicting a running pass's own entries is
/// what made an install with more than `target` in-window files re-parse the same files on every
/// pass — the memo pinned at a fixed low hit rate forever. `is_live` is asked rather than comparing
/// against one generation because passes OVERLAP: the Spend pane and the 2h reporter (and, in
/// accounts.rs, `accounts_usage` and `accounts_spend`) run concurrently, and whichever finished
/// first used to trim the other's working set out from under it.
///
/// Tier 2 — past `hard_cap`, live entries go too, NEWEST-MTIME first. Tier 1 alone is no bound at
/// all when every entry belongs to a live pass, which is exactly the heavy install. Newest first
/// because an append-only transcript with an old mtime is settled — its entry stays valid and hits
/// forever — while the newest file is the one about to be appended to and invalidated anyway. The
/// scans are ordered oldest-mtime-first, so evicting the oldest would leave the next pass starting
/// on precisely the entries just dropped, missing every one.
pub(crate) fn evict_two_tier<V>(
    cache: &mut HashMap<PathBuf, V>,
    target: usize,
    hard_cap: usize,
    is_live: impl Fn(u64) -> bool,
    key: impl Fn(&V) -> (u64, SystemTime),
) {
    if cache.len() > target {
        let mut ages: Vec<(u64, PathBuf)> = cache
            .iter()
            .filter(|(_, v)| !is_live(key(v).0))
            .map(|(p, v)| (key(v).0, p.clone()))
            .collect();
        let excess = (cache.len() - target).min(ages.len());
        if excess > 0 {
            ages.select_nth_unstable_by(excess - 1, |a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
            for (_, path) in ages.into_iter().take(excess) {
                cache.remove(&path);
            }
        }
    }

    if cache.len() > hard_cap {
        let mut by_age: Vec<(std::cmp::Reverse<SystemTime>, PathBuf)> = cache
            .iter()
            .map(|(p, v)| (std::cmp::Reverse(key(v).1), p.clone()))
            .collect();
        let excess = cache.len() - hard_cap;
        by_age.select_nth_unstable_by(excess - 1, |a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        for (_, path) in by_age.into_iter().take(excess) {
            cache.remove(&path);
        }
    }
}

/// The transcript roots to scan. Mirrors `claude.rs`'s resolution so the pane reads exactly the
/// directory Claude Code writes: `$CLAUDE_CONFIG_DIR/projects` when set, else `$HOME/.claude/projects`
/// — plus every Sparkle-managed account store (`<app_data>/accounts/<id>/projects`), so
/// multi-account usage is counted. Field evidence (2026-07-24, bead sparkle-s3g2.3): one account
/// store alone held 4.6B tokens/7d that a `~/.claude`-only scan misses.
pub(crate) fn transcript_roots(app_data: Option<&Path>) -> Vec<PathBuf> {
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let primary = crate::claude::claude_projects_root(config_dir.as_deref(), home.as_deref());
    let mut accounts_roots: Vec<PathBuf> = Vec::new();
    if let Some(accounts) = app_data.map(|d| d.join("accounts")) {
        if let Ok(entries) = std::fs::read_dir(&accounts) {
            accounts_roots = entries
                .flatten()
                .map(|e| e.path().join("projects"))
                .filter(|p| p.is_dir())
                .collect();
            accounts_roots.sort();
        }
    }
    order_roots(primary, accounts_roots)
}

/// Order + dedupe the roots. Pure, so the ordering contract is testable without the process env
/// `transcript_roots` has to read.
///
/// Account stores come FIRST and the primary store last, because the scan shares one [`MAX_FILES`]
/// budget and `~/.claude` is routinely 10-50x larger than every account store combined: scanned
/// primary-first, the cap would silently skip the account stores — the multi-account blind spot
/// this whole function exists to close. (Each root also gets a floor of its own — see
/// [`collect_files`] — so "last" no longer means "possibly not at all".)
///
/// Built in that order rather than rotated into it. A `rotate_left(1)` assumed `roots[0]` was
/// always the primary, which is wrong twice over: with neither `CLAUDE_CONFIG_DIR` nor `HOME` there
/// IS no primary and the rotation just shuffled account stores, and when `CLAUDE_CONFIG_DIR` points
/// into an account store (how Sparkle launches agents) the surviving index-0 entry IS an account
/// store, so the rotation demoted the ACTIVE account store and `~/.claude` was never a root at all.
///
/// Dedupe is full (not `Vec::dedup`'s adjacent-only) and on the CANONICAL path, because
/// `CLAUDE_CONFIG_DIR` aliasing an account store and an account `projects/` symlinked back to
/// `~/.claude/projects` both scan the same tree twice otherwise. First spelling wins, and with
/// accounts first that means the account-store spelling survives — the more informative one for
/// `report.roots`. When `canonicalize` fails (the directory doesn't exist yet) it falls back to the
/// canonicalized PARENT joined with the file name: parents exist far more often, and canonicalizing
/// only one side is exactly how two spellings of one tree slip through as two roots.
fn order_roots(primary: Option<PathBuf>, accounts: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut roots = accounts;
    roots.extend(primary);
    let mut seen = HashSet::new();
    roots.retain(|p| seen.insert(canonical_key(p)));
    roots
}

/// Best-effort canonical identity of a path that may not exist yet. See [`order_roots`].
pub(crate) fn canonical_key(p: &Path) -> PathBuf {
    if let Ok(canon) = std::fs::canonicalize(p) {
        return canon;
    }
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => match std::fs::canonicalize(parent) {
            Ok(canon) => canon.join(name),
            Err(_) => p.to_path_buf(),
        },
        _ => p.to_path_buf(),
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Blocking core of [`spend_report`] — resolve roots, scan, aggregate. Split out so the async
/// command is a thin `spawn_blocking` wrapper.
fn spend_report_sync(window_days: u32, app_data: Option<PathBuf>) -> SpendReport {
    let window = window_days.clamp(1, MAX_WINDOW_DAYS);
    let now = now_secs();
    let today = now.div_euclid(86_400);
    // Cutoff is the START of the oldest in-window day, in seconds.
    let cutoff_secs = (today - (window as i64 - 1)) * 86_400;

    let roots = transcript_roots(app_data.as_deref());
    let (blocks, files_scanned, truncated) = load_records(&roots, cutoff_secs);

    // Aggregate over the memo's own records — no flattening clone of every record first.
    let mut report = aggregate_records(blocks.iter().flat_map(|b| b.iter()), today, window);
    report.generated_at = now;
    report.files_scanned = files_scanned;
    report.truncated = truncated;
    report.roots = roots
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    report
}

/// Local token-usage + estimated-cost report over the trailing `window_days` (default 30).
///
/// `async` + `spawn_blocking`: a full transcript scan is filesystem-bound work measured in
/// hundreds of milliseconds on a busy install, and must never run on the Tauri event-loop thread.
#[tauri::command]
pub async fn spend_report(
    app: tauri::AppHandle,
    window_days: Option<u32>,
) -> Result<SpendReport, String> {
    // `dev_identity`, not the raw `app.path()`: a debug build's account stores live under
    // `…ai.sparkle.desktop-dev/accounts/`. Using the raw dir made a dev pane read the PRODUCTION
    // stores and miss its own — and once builder_index.rs started consuming this same scan through
    // dev_identity, the pane and the leaderboard would have reported different totals for the same
    // machine, breaking the "they can never disagree" invariant. (roborev 47899, 47068)
    let app_data = crate::dev_identity::app_data_dir(&app).ok();
    tauri::async_runtime::spawn_blocking(move || {
        spend_report_sync(window_days.unwrap_or(DEFAULT_WINDOW_DAYS), app_data)
    })
    .await
    .map_err(|e| format!("spend_report task failed: {e}"))
}

// ── reporter surface (opt-in Builder Index) ─────────────────────────────────────────────────
// The opt-in tkmx reporter (`builder_index.rs`, bead sparkle-s3g2.6) needs the SAME scan this
// module already does — the one that covers `~/.claude` AND every Sparkle account store. The
// community pipeline it replaces underreported this machine by ~84% precisely because it only
// indexed `~/.claude`, so the reporter must not get its own second scanner. The `pub(crate)` shims
// below hand it the existing one; everything they expose is already computed here.

/// What one reporter-facing scan produced.
pub(crate) struct WindowScan {
    /// The scan's per-file record blocks, SHARED with the memo rather than copied — iterate them
    /// with [`WindowScan::records`].
    ///
    /// Raw: these are every record in every file whose mtime falls in the window. They are NOT
    /// deduped, and NOT filtered per record, so a pre-window record sitting in a recently-touched
    /// transcript is still here. Callers apply both — via [`dedupe_window`], which is what
    /// `builder_index::rollup` and [`aggregate_records`] both do. (Said explicitly because the
    /// previous doc claimed "deduped, in-window records", and the next caller to believe it would
    /// over-report.)
    blocks: Vec<Arc<Vec<UsageRecord>>>,
    /// The epoch day the window ends on (UTC "today").
    pub today: i64,
    /// True when [`MAX_FILES`] cut the scan short. The reporter MUST propagate this: publishing a
    /// silently partial total while saying "Reported N rows" would recreate, inside Sparkle, the
    /// exact underreporting this feature was built to fix. (roborev 47458)
    pub truncated: bool,
}

impl WindowScan {
    /// Every scanned record, borrowed. Feed it to [`dedupe_window`] before counting anything.
    pub fn records(&self) -> impl Iterator<Item = &UsageRecord> {
        self.blocks.iter().flat_map(|b| b.iter())
    }
}

/// Scan the trailing `window_days` for the reporter.
///
/// Same roots, same memo, same mtime pre-filter as [`spend_report`] — this is a second CONSUMER
/// of the scan, not a second scan. Blocking (filesystem-bound); callers run it off the event loop.
pub(crate) fn load_window_records(app_data: Option<&Path>, window_days: u32) -> WindowScan {
    scan_window(&transcript_roots(app_data), window_days)
}

/// [`load_window_records`] with the roots handed in, so the scan half is testable against a temp
/// tree instead of whatever `$HOME/.claude` this machine happens to have.
fn scan_window(roots: &[PathBuf], window_days: u32) -> WindowScan {
    let window = window_days.clamp(1, MAX_WINDOW_DAYS);
    let today = now_secs().div_euclid(86_400);
    let cutoff_secs = (today - (window as i64 - 1)) * 86_400;
    // Keep the `Arc` blocks. They already hold the records alive independently of the memo, so
    // flattening them into an owned `Vec<UsageRecord>` would be a second full copy of the scan —
    // held for the whole network POST — and that copy is exactly what taking BORROWED records in
    // `aggregate_records` was introduced to remove.
    let (blocks, _, truncated) = load_records(roots, cutoff_secs);
    WindowScan { blocks, today, truncated }
}

/// List-price USD for one turn's token counts, or `None` when the model has no published rate.
///
/// THE ONE PRICE TABLE. The concierge spend pill (`accounts.rs`) grew its own four-model table with
/// a Sonnet FALLBACK for everything else, so the same transcripts were valued differently in three
/// places: `claude-opus-4-20250514` came out 5x low in the pill, `claude-opus-4-5-*` ~40% low, and
/// an unknown model was silently given a Sonnet price there while the pane and the published
/// leaderboard row honestly reported it unpriced. Whatever the number is, the app must say the same
/// one everywhere — so the pill values its records through here.
///
/// `cache_write_5m`/`cache_write_1h` are separate because they bill differently (1.25x vs 2x
/// input). A caller that only has the flat `cache_creation_input_tokens` passes it as 5m, which is
/// what that field means when no TTL breakdown is present.
pub(crate) fn estimate_cost_usd(
    model: &str,
    input: u64,
    output: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
    cache_read: u64,
) -> Option<f64> {
    let p = price_for(&normalize_model(model))?;
    let m = 1_000_000.0;
    Some(
        (input as f64 * p.input
            + output as f64 * p.output
            + cache_write_5m as f64 * p.input * CACHE_WRITE_5M_MULT
            + cache_write_1h as f64 * p.input * CACHE_WRITE_1H_MULT
            + cache_read as f64 * p.input * CACHE_READ_MULT)
            / m,
    )
}

/// `YYYY-MM-DD` (UTC) for an epoch day — the date format both the pane and the tkmx wire use.
pub(crate) fn epoch_day_label(day: i64) -> String {
    format_day(day)
}

/// Estimated list-rate USD for one record, or `None` when the model has no published price.
/// Re-exported so the reporter's per-(day, model) rows carry the same cost arithmetic the pane
/// shows, instead of a second, silently-diverging price table.
pub(crate) fn record_cost_usd(r: &UsageRecord) -> Option<f64> {
    r.cost_usd()
}

/// Total tokens for one record (input + output + cache writes + cache reads).
pub(crate) fn record_total_tokens(r: &UsageRecord) -> u64 {
    r.total_tokens()
}

/// Cache-creation tokens for one record (5m + 1h TTL writes summed).
pub(crate) fn record_cache_creation(r: &UsageRecord) -> u64 {
    r.cache_creation()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-07-24 as an epoch day — the anchor "today" for the window tests.
    fn today() -> i64 {
        days_from_civil(2026, 7, 24)
    }

    fn line(ts: &str, model: &str, id: &str, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","cwd":"/Users/me/Projects/sparkle","message":{{"id":"{id}","role":"assistant","model":"{model}","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}}}}"#
        )
    }

    fn parse(l: &str) -> Option<UsageRecord> {
        parse_line(l, "sess-1", "slug", 0)
    }

    /// The slice-taking form of [`aggregate_records`], for fixtures. Production aggregates over the
    /// memo's `Arc` contents, which is why the real function takes an iterator.
    fn aggregate(records: &[UsageRecord], today: i64, window_days: u32) -> SpendReport {
        aggregate_records(records.iter(), today, window_days)
    }

    // ── date helpers ─────────────────────────────────────────────────────────────────────

    #[test]
    fn civil_day_conversions_round_trip() {
        for (y, m, d) in [(1970, 1, 1), (2000, 2, 29), (2026, 7, 24), (2026, 12, 31)] {
            let epoch = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(epoch), (y, m, d), "{y}-{m}-{d}");
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(format_day(days_from_civil(2026, 7, 4)), "2026-07-04");
    }

    #[test]
    fn day_from_iso8601_parses_and_rejects() {
        assert_eq!(
            day_from_iso8601("2026-07-24T21:20:25.931Z"),
            Some(days_from_civil(2026, 7, 24))
        );
        assert_eq!(day_from_iso8601("not-a-date"), None);
        assert_eq!(day_from_iso8601("2026-13-01T00:00:00Z"), None);
        assert_eq!(day_from_iso8601(""), None);
    }

    // ── pricing ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn pricing_matches_longest_model_prefix() {
        // Dated snapshot resolves to its family, and the LONGER prefix wins: opus-4-5 is $5/$25,
        // while a bare opus-4 is the older $15/$75 tier. Getting this backwards would misprice
        // every Opus 4.5 transcript by 3×.
        assert_eq!(price_for("claude-opus-4-5-20251101").unwrap().input, 5.0);
        assert_eq!(price_for("claude-opus-4-20250514").unwrap().input, 15.0);
        assert_eq!(price_for("claude-sonnet-4-5-20250929").unwrap().output, 15.0);
        assert_eq!(price_for("claude-haiku-4-5").unwrap().input, 1.0);
        assert!(price_for("gpt-9").is_none());
    }

    #[test]
    fn normalize_model_strips_context_tier_suffix() {
        assert_eq!(normalize_model("claude-opus-5[1m]"), "claude-opus-5");
        assert_eq!(normalize_model("Claude-Opus-5"), "claude-opus-5");
        assert_eq!(normalize_model(" claude-sonnet-5 "), "claude-sonnet-5");
        // And the stripped form still prices.
        assert!(price_for(&normalize_model("claude-opus-5[1m]")).is_some());
    }

    #[test]
    fn cost_applies_cache_multipliers() {
        let r = UsageRecord {
            id: "a".into(),
            day: 0,
            model: "claude-opus-5".into(),
            session: "s".into(),
            project: "p".into(),
            input: 1_000_000,
            output: 1_000_000,
            cache_5m: 1_000_000,
            cache_1h: 1_000_000,
            cache_read: 1_000_000,
        };
        // $5 input + $25 output + 1.25×5 + 2×5 + 0.1×5 = 5 + 25 + 6.25 + 10 + 0.5 = $46.75
        let cost = r.cost_usd().unwrap();
        assert!((cost - 46.75).abs() < 1e-9, "cost was {cost}");
    }

    #[test]
    fn unknown_model_has_no_cost_but_keeps_tokens() {
        let r = UsageRecord {
            id: "a".into(),
            day: 0,
            model: "some-future-model".into(),
            session: "s".into(),
            project: "p".into(),
            input: 10,
            output: 5,
            cache_5m: 2,
            cache_1h: 0,
            cache_read: 3,
        };
        assert!(r.cost_usd().is_none());
        assert_eq!(r.total_tokens(), 20);
    }

    // ── parsing ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn parses_a_normal_assistant_record() {
        let r = parse(&line("2026-07-24T10:00:00.000Z", "claude-opus-5", "msg_1", 100, 20)).unwrap();
        assert_eq!(r.id, "msg_1");
        assert_eq!(r.model, "claude-opus-5");
        assert_eq!(r.day, today());
        assert_eq!(r.session, "sess-1");
        // `cwd` wins over the directory slug for the project label.
        assert_eq!(r.project, "sparkle");
        assert_eq!((r.input, r.output), (100, 20));
    }

    #[test]
    fn skips_malformed_and_irrelevant_lines() {
        // Half-written tail line (Claude Code is still flushing).
        assert!(parse(r#"{"type":"assistant","message":{"usage":{"input_to"#).is_none());
        // Blank / whitespace.
        assert!(parse("").is_none());
        assert!(parse("   ").is_none());
        // A user turn — no usage object at all.
        assert!(parse(r#"{"type":"user","message":{"role":"user","content":"hi"}}"#).is_none());
        // Usage present but no timestamp to bucket it into a day.
        assert!(parse(
            r#"{"type":"assistant","message":{"model":"claude-opus-5","usage":{"input_tokens":5}}}"#
        )
        .is_none());
        // An all-zero usage record contributes nothing and would only inflate the message count.
        assert!(parse(&line("2026-07-24T10:00:00Z", "claude-opus-5", "z", 0, 0)).is_none());
    }

    #[test]
    fn skips_synthetic_model_records() {
        // Claude Code fabricates `<synthetic>` turns (interrupt notices, local errors). They carry
        // a usage object but no provider cost, so counting them would inflate both totals.
        let l = line("2026-07-24T10:00:00Z", "<synthetic>", "s1", 100, 100);
        assert!(parse(&l).is_none());
    }

    #[test]
    fn reads_cache_creation_ttl_breakdown_when_present() {
        let l = r#"{"type":"assistant","timestamp":"2026-07-24T10:00:00Z","message":{"id":"m","model":"claude-opus-5","usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":900,"cache_creation":{"ephemeral_5m_input_tokens":600,"ephemeral_1h_input_tokens":300},"cache_read_input_tokens":50}}}"#;
        let r = parse(l).unwrap();
        assert_eq!((r.cache_5m, r.cache_1h), (600, 300));
        assert_eq!(r.cache_creation(), 900);
        assert_eq!(r.cache_read, 50);
    }

    #[test]
    fn cache_creation_without_breakdown_bills_as_5m() {
        let l = r#"{"type":"assistant","timestamp":"2026-07-24T10:00:00Z","message":{"id":"m","model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":1000,"cache_read_input_tokens":0}}}"#;
        let r = parse(l).unwrap();
        assert_eq!((r.cache_5m, r.cache_1h), (1000, 0));
    }

    #[test]
    fn falls_back_to_directory_slug_without_cwd() {
        let l = r#"{"type":"assistant","timestamp":"2026-07-24T10:00:00Z","message":{"id":"m","model":"claude-opus-5","usage":{"input_tokens":1,"output_tokens":1}}}"#;
        assert_eq!(parse(l).unwrap().project, "slug");
    }

    // ── aggregation ──────────────────────────────────────────────────────────────────────

    fn rec(day_offset: i64, model: &str, id: &str, project: &str, session: &str, tokens: u64) -> UsageRecord {
        UsageRecord {
            id: id.into(),
            day: today() - day_offset,
            model: model.into(),
            session: session.into(),
            project: project.into(),
            input: tokens,
            output: 0,
            cache_5m: 0,
            cache_1h: 0,
            cache_read: 0,
        }
    }

    #[test]
    fn aggregate_emits_a_contiguous_calendar_including_idle_days() {
        // Only two of the 28 days have usage; the chart still needs 28 dated columns or the
        // x-axis silently compresses idle stretches.
        let recs = vec![
            rec(0, "claude-opus-5", "a", "p", "s", 10),
            rec(5, "claude-opus-5", "b", "p", "s", 20),
        ];
        let r = aggregate(&recs, today(), 28);
        assert_eq!(r.days.len(), 28);
        assert_eq!(r.days.first().unwrap().date, format_day(today() - 27));
        assert_eq!(r.days.last().unwrap().date, format_day(today()));
        assert_eq!(r.days.last().unwrap().bucket.tokens.total, 10);
        assert_eq!(r.days[22].bucket.tokens.total, 20); // today - 5
        assert_eq!(r.days[0].bucket.tokens.total, 0);
        assert_eq!(r.totals.tokens.total, 30);
    }

    #[test]
    fn aggregate_drops_records_outside_the_window() {
        let recs = vec![
            rec(0, "claude-opus-5", "in", "p", "s", 10),
            rec(40, "claude-opus-5", "old", "p", "s", 999),
            // A future-dated record (clock skew on a synced transcript) must not create a bucket
            // past `today`, which would break the fixed-length day list.
            rec(-3, "claude-opus-5", "future", "p", "s", 500),
        ];
        let r = aggregate(&recs, today(), 30);
        assert_eq!(r.totals.tokens.total, 10);
        assert_eq!(r.days.len(), 30);
    }

    #[test]
    fn aggregate_dedupes_repeated_message_ids_across_sessions() {
        // Resuming a session copies prior turns into a NEW transcript. Without dedup by message
        // id, a resumed conversation double-counts every turn it carried forward.
        let recs = vec![
            rec(0, "claude-opus-5", "msg_1", "p", "session-a", 100),
            rec(0, "claude-opus-5", "msg_1", "p", "session-b", 100),
            rec(0, "claude-opus-5", "msg_2", "p", "session-b", 50),
        ];
        let r = aggregate(&recs, today(), 30);
        assert_eq!(r.totals.tokens.total, 150);
        assert_eq!(r.totals.messages, 2);
        // The LAST occurrence wins, and `load_records` hands records oldest-file-first — so a
        // resumed turn is attributed to the resumed session, the one the user is actually looking
        // at, rather than to the abandoned original. (The old rule kept the FIRST occurrence in
        // `read_dir` order, which is OS/inode-dependent: the same files could produce different
        // session rows on different pane opens.)
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(r.sessions[0].session_id, "session-b");
        assert_eq!(r.sessions[0].bucket.tokens.total, 150);
    }

    #[test]
    fn aggregation_is_reproducible_and_prefers_the_newest_transcript() {
        // The report must not depend on the order records arrive in beyond the one rule we state.
        // Same three turns, two different session attributions — whichever comes LAST wins, so the
        // caller's deterministic file order (oldest first) fully determines the answer.
        let older = rec(0, "claude-opus-5", "msg_1", "p", "session-a", 100);
        let newer = rec(0, "claude-opus-5", "msg_1", "p", "session-b", 100);
        let other = rec(0, "claude-opus-5", "msg_2", "p", "session-a", 50);

        let a = aggregate(&[other.clone(), older.clone(), newer.clone()], today(), 30);
        assert_eq!(a.sessions.len(), 2);
        assert_eq!(a.totals.tokens.total, 150);
        let b_row = a.sessions.iter().find(|s| s.session_id == "session-b").unwrap();
        assert_eq!(b_row.bucket.tokens.total, 100, "the newest file's attribution wins");

        // Reversing which one is "newest" moves the turn, and NOTHING else changes.
        let b = aggregate(&[other, newer, older], today(), 30);
        assert_eq!(b.totals, a.totals, "totals never depend on attribution");
        let a_row = b.sessions.iter().find(|s| s.session_id == "session-a").unwrap();
        assert_eq!(a_row.bucket.tokens.total, 150);
    }

    #[test]
    fn an_unlisted_family_version_falls_through_to_unpriced() {
        // THE overstatement: a bare longest-PREFIX match let `claude-opus-4-9-…` inherit
        // `claude-opus-4`'s legacy $15/$75 rate — 3× the current opus tier — with `priced: true`,
        // so nothing in the UI could say the number was invented.
        assert!(price_for("claude-opus-4-9-20261101").is_none());
        assert!(price_for("claude-sonnet-4-9").is_none());
        assert!(price_for("claude-haiku-4-7-20260601").is_none());

        // …while every shape the table IS written for still prices.
        assert!(price_for("claude-opus-4").is_some());
        assert!(price_for("claude-opus-4-20250514").is_some());
        assert!(price_for("claude-opus-4-1-20250805").is_some());
        assert!(price_for("claude-sonnet-4-5-20250929").is_some());
        assert!(price_for("claude-opus-5").is_some());
        // Vertex AI emits `@`-dated ids and `-v<N>@` revisions; the API also serves `-latest`
        // aliases. Same family, same rate — these priced before the boundary rule and must
        // keep pricing after it.
        assert!(price_for("claude-sonnet-4@20250514").is_some());
        assert!(price_for("claude-3-5-sonnet-v2@20241022").is_some());
        assert!(price_for("claude-3-5-sonnet-latest").is_some());
        // …but the boundary still rejects lookalikes that aren't dated revisions.
        assert!(price_for("claude-sonnet-4-vnext").is_none());
        assert!(price_for("claude-sonnet-4-v2@next").is_none());
        // And the longest-prefix rule still beats its own ancestor.
        assert_eq!(price_for("claude-opus-4-5-20251101").unwrap().input, 5.0);
        assert_eq!(price_for("claude-opus-4-20250514").unwrap().input, 15.0);

        // End to end: the unpriced tokens are COUNTED and the model is named, not silently costed.
        let r = aggregate(&[rec(0, "claude-opus-4-9-20261101", "a", "p", "s", 1_000_000)], today(), 30);
        assert_eq!(r.totals.estimated_cost_usd, 0.0);
        assert_eq!(r.totals.unpriced_tokens, 1_000_000);
        assert_eq!(r.unknown_models, vec!["claude-opus-4-9-20261101".to_string()]);
    }

    #[test]
    fn a_malformed_calendar_date_is_rejected_not_normalized() {
        // `days_from_civil` happily normalizes Feb 31 into March 3, so a flat 1..=31 check put a
        // malformed timestamp in the WRONG day bucket — the exact thing rejecting it prevents.
        assert_eq!(day_from_iso8601("2026-02-30T00:00:00Z"), None);
        assert_eq!(day_from_iso8601("2026-02-31T00:00:00Z"), None);
        assert_eq!(day_from_iso8601("2026-04-31T00:00:00Z"), None);
        assert_eq!(day_from_iso8601("2026-02-29T00:00:00Z"), None, "2026 is not a leap year");
        // Real dates, including the leap-day edges, still parse.
        assert!(day_from_iso8601("2026-02-28T00:00:00Z").is_some());
        assert!(day_from_iso8601("2024-02-29T00:00:00Z").is_some());
        assert!(day_from_iso8601("2000-02-29T00:00:00Z").is_some(), "400-year rule");
        assert_eq!(day_from_iso8601("1900-02-29T00:00:00Z"), None, "100-year rule");
        assert!(day_from_iso8601("2026-12-31T00:00:00Z").is_some());
    }

    #[test]
    fn a_bad_utf8_byte_does_not_discard_the_rest_of_the_transcript() {
        // `BufRead::lines()` yields Err on the first invalid byte, and the old `break` threw away
        // every remaining record — one stray byte in a tool-output line zeroed out the rest of that
        // session's spend, silently.
        let dir = std::env::temp_dir().join(format!("sparkle-spend-utf8-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let proj = dir.join("projects").join("-Users-me-Projects-sparkle");
        std::fs::create_dir_all(&proj).unwrap();
        let path = proj.join("session-utf8.jsonl");

        let mut body = line("2026-07-24T10:00:00Z", "claude-opus-5", "m1", 100, 10).into_bytes();
        body.push(b'\n');
        body.extend_from_slice(b"{\"usage\":\"\xff\xfe garbage\"}\n");
        body.extend_from_slice(
            line("2026-07-24T11:00:00Z", "claude-haiku-4-5", "m2", 5, 1).as_bytes(),
        );
        body.push(b'\n');
        std::fs::write(&path, body).unwrap();

        let recs = parse_file(&path);
        assert_eq!(recs.len(), 2, "the record AFTER the bad bytes must survive: {recs:?}");
        assert_eq!(recs[1].model, "claude-haiku-4-5");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identical_no_id_turns_in_one_file_are_not_deduped_away() {
        // The fallback key was {session}:{day}:{in}:{out}:{cache_read}, which collides for two
        // genuinely distinct small turns — very common — so the second was silently dropped.
        let no_id = |ts: &str| {
            format!(
                r#"{{"type":"assistant","timestamp":"{ts}","message":{{"model":"claude-opus-5","usage":{{"input_tokens":1,"output_tokens":0,"cache_read_input_tokens":0}}}}}}"#
            )
        };
        let a = parse_line(&no_id("2026-07-24T10:00:00Z"), "s", "p", 0).unwrap();
        let b = parse_line(&no_id("2026-07-24T10:00:01Z"), "s", "p", 1).unwrap();
        assert_ne!(a.id, b.id, "two distinct turns must not share a dedup key");
        let r = aggregate(&[a, b], days_from_civil(2026, 7, 24), 30);
        assert_eq!(r.totals.messages, 2);
    }

    #[test]
    fn aggregate_splits_priced_and_unpriced_models() {
        let recs = vec![
            rec(0, "claude-opus-5", "a", "p", "s", 1_000_000),
            rec(0, "totally-unknown-model", "b", "p", "s", 7),
        ];
        let r = aggregate(&recs, today(), 30);
        assert_eq!(r.unknown_models, vec!["totally-unknown-model".to_string()]);
        // Only the priced record contributes cost; the unknown one contributes tokens.
        assert!((r.totals.estimated_cost_usd - 5.0).abs() < 1e-9);
        assert_eq!(r.totals.unpriced_tokens, 7);
        assert_eq!(r.totals.tokens.total, 1_000_007);
        let unknown = r.models.iter().find(|m| m.model == "totally-unknown-model").unwrap();
        assert!(!unknown.priced);
        assert!(r.models.iter().find(|m| m.model == "claude-opus-5").unwrap().priced);
    }

    #[test]
    fn aggregate_orders_rollups_by_weight_then_name() {
        let recs = vec![
            rec(0, "claude-haiku-4-5", "a", "small", "s1", 10),
            rec(0, "claude-opus-5", "b", "big", "s2", 900),
            rec(1, "claude-opus-5", "c", "big", "s3", 100),
        ];
        let r = aggregate(&recs, today(), 30);
        assert_eq!(r.models[0].model, "claude-opus-5");
        assert_eq!(r.projects[0].project, "big");
        assert_eq!(r.projects[0].sessions, 2);
        assert_eq!(r.projects[0].last_active, format_day(today()));
        assert_eq!(r.sessions[0].session_id, "s2");
        assert_eq!(r.sessions[0].project, "big");
    }

    #[test]
    fn aggregate_caps_the_session_table() {
        let recs: Vec<UsageRecord> = (0..(MAX_SESSION_ROWS + 25))
            .map(|i| rec(0, "claude-opus-5", &format!("id-{i}"), "p", &format!("s-{i}"), (i + 1) as u64))
            .collect();
        let r = aggregate(&recs, today(), 30);
        assert_eq!(r.sessions.len(), MAX_SESSION_ROWS);
        // Totals still cover EVERY session, not just the rows shown.
        let expected: u64 = (1..=(MAX_SESSION_ROWS as u64 + 25)).sum();
        assert_eq!(r.totals.tokens.total, expected);
    }

    #[test]
    fn aggregate_clamps_the_window() {
        assert_eq!(aggregate(&[], today(), 0).days.len(), 1);
        assert_eq!(
            aggregate(&[], today(), MAX_WINDOW_DAYS + 100).days.len(),
            MAX_WINDOW_DAYS as usize
        );
    }

    #[test]
    fn empty_input_is_a_zeroed_report_not_an_error() {
        let r = aggregate(&[], today(), 28);
        assert_eq!(r.days.len(), 28);
        assert!(r.models.is_empty() && r.projects.is_empty() && r.sessions.is_empty());
        assert_eq!(r.totals, Bucket::default());
        assert!(r.pricing_note.contains("Estimated"));
    }

    // ── roots resolution ─────────────────────────────────────────────────────────────────

    #[test]
    fn transcript_roots_include_every_account_store_with_a_projects_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = tmp.path();
        // Two real account stores, one accounts entry without projects/ (ignored),
        // and a stray file in accounts/ (ignored).
        std::fs::create_dir_all(app_data.join("accounts/acct-b/projects")).unwrap();
        std::fs::create_dir_all(app_data.join("accounts/acct-a/projects")).unwrap();
        std::fs::create_dir_all(app_data.join("accounts/no-projects-yet")).unwrap();
        std::fs::write(app_data.join("accounts/stray.txt"), "x").unwrap();

        let roots = transcript_roots(Some(app_data));
        let suffix: Vec<String> = roots
            .iter()
            .filter_map(|p| p.strip_prefix(app_data).ok())
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        // Both account stores are present, sorted, and nothing else from accounts/ leaks in.
        // Whether a primary store follows them depends on this machine's $HOME, so the ORDERING
        // contract is asserted on the pure half instead — see `order_roots` below.
        assert_eq!(
            suffix,
            vec!["accounts/acct-a/projects", "accounts/acct-b/projects"]
        );
    }

    /// `evict_two_tier` with one live generation — the shape these policy tests exercise.
    fn evict_here(
        cache: &mut HashMap<PathBuf, CachedFile>,
        target: usize,
        hard_cap: usize,
        live: u64,
    ) {
        evict_two_tier(cache, target, hard_cap, |g| g == live, |c| (c.last_touch, c.mtime));
    }

    /// A memo entry with no records — the shape the eviction-policy tests care about.
    fn memo_entry(last_touch: u64, mtime: SystemTime) -> CachedFile {
        CachedFile {
            mtime,
            len: 0,
            records: Arc::new(Vec::new()),
            last_touch,
            touched_at: std::time::Instant::now(),
        }
    }

    /// The cache-write TTL split, including the fallback the extraction added: an EMPTY or
    /// unrecognized `cache_creation` object must not swallow a nonzero flat total. Before this,
    /// such a line scored (0,0) and could be dropped entirely by `parse_line`'s all-zero guard.
    #[test]
    fn cache_write_split_falls_back_rather_than_dropping_tokens() {
        let v = |raw: &str| serde_json::from_str::<Value>(raw).unwrap();

        // A populated breakdown wins, and the flat total is ignored (it double-counts the same
        // writes, so trusting it here would inflate).
        assert_eq!(
            cache_write_split(&v(
                r#"{"cache_creation_input_tokens":900,"cache_creation":{"ephemeral_5m_input_tokens":600,"ephemeral_1h_input_tokens":300}}"#
            )),
            (600, 300)
        );
        // No breakdown at all (older transcripts): the whole total is the default 5m TTL.
        assert_eq!(cache_write_split(&v(r#"{"cache_creation_input_tokens":900}"#)), (900, 0));
        // Present but EMPTY, and present with a key we don't know: fall back rather than drop.
        assert_eq!(
            cache_write_split(&v(r#"{"cache_creation_input_tokens":900,"cache_creation":{}}"#)),
            (900, 0)
        );
        assert_eq!(
            cache_write_split(&v(
                r#"{"cache_creation_input_tokens":900,"cache_creation":{"ephemeral_12h_input_tokens":900}}"#
            )),
            (900, 0)
        );
        // Nothing anywhere is genuinely zero.
        assert_eq!(cache_write_split(&v(r#"{"cache_creation":{}}"#)), (0, 0));
    }

    /// The record that used to vanish: only cache writes, and only in a form the old split read as
    /// zero — `parse_line`'s all-zero guard then discarded the whole turn.
    #[test]
    fn a_turn_whose_only_usage_is_an_unrecognized_cache_breakdown_still_counts() {
        let l = r#"{"type":"assistant","timestamp":"2026-07-24T10:00:00Z","message":{"id":"m","model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":500,"cache_creation":{},"cache_read_input_tokens":0}}}"#;
        let r = parse_line(l, "s", "p", 0).expect("a cache-only turn is still a billed turn");
        assert_eq!((r.cache_5m, r.cache_1h), (500, 0));
        assert_eq!(r.total_tokens(), 500);
    }

    /// The shared window+dedup helper both surfaces route through, tested directly: the winner's
    /// IDENTITY and the retained ORDER are properties neither caller's totals can distinguish.
    #[test]
    fn dedupe_window_keeps_the_last_copy_in_input_order_and_drops_out_of_window_days() {
        let r = |id: &str, day: i64, input: u64| UsageRecord {
            id: id.into(),
            day,
            model: "claude-opus-5".into(),
            session: "s".into(),
            project: "p".into(),
            input,
            output: 0,
            cache_5m: 0,
            cache_1h: 0,
            cache_read: 0,
        };
        let (first_day, today) = (10, 12);
        let recs = [
            r("a", 10, 1),  // on the first day: in
            r("dup", 11, 1),
            r("b", 12, 1),  // on `today`: in
            r("dup", 11, 2),
            r("old", 9, 99),    // one day before the window: out
            r("future", 13, 99), // clock-skewed synced transcript: out
            r("dup", 11, 3),    // third copy — the last one is the winner
        ];

        let kept = dedupe_window(recs.iter(), first_day, today);
        let ids: Vec<&str> = kept.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["a", "dup", "b"],
            "input order is preserved — a repeated id keeps its FIRST position, not its last"
        );
        assert_eq!(kept[1].input, 3, "and the LAST copy's values win");
        assert!(dedupe_window([].iter(), first_day, today).is_empty());
    }

    /// The ordering + dedupe contract, on the pure half so it doesn't depend on the process env.
    #[test]
    fn order_roots_puts_account_stores_before_the_primary_and_survives_a_missing_primary() {
        let acct = |n: &str| PathBuf::from(format!("/app/accounts/{n}/projects"));
        let primary = PathBuf::from("/home/me/.claude/projects");

        assert_eq!(
            order_roots(Some(primary.clone()), vec![acct("a"), acct("b")]),
            vec![acct("a"), acct("b"), primary.clone()],
            "the primary store is scanned last — it is 10-50x larger and would eat the budget"
        );
        // No primary at all (neither CLAUDE_CONFIG_DIR nor HOME): the account order is untouched.
        // The old rotate_left(1) shuffled them here for no reason.
        assert_eq!(
            order_roots(None, vec![acct("a"), acct("b")]),
            vec![acct("a"), acct("b")]
        );
        assert_eq!(order_roots(Some(primary.clone()), vec![]), vec![primary]);
        assert!(order_roots(None, vec![]).is_empty());
    }

    /// Two spellings of ONE tree must scan once. `CLAUDE_CONFIG_DIR` pointing into an account store
    /// is how Sparkle launches agents, so this is the normal case, not a corner.
    #[test]
    fn order_roots_collapses_two_spellings_of_the_same_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("accounts/acct-a/projects");
        std::fs::create_dir_all(&real).unwrap();
        let link = tmp.path().join("claude-projects-link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        // The account-store spelling comes first and therefore survives; the alias drops out.
        assert_eq!(order_roots(Some(link.clone()), vec![real.clone()]), vec![real.clone()]);

        // A root that does not exist YET still dedupes against its alias, because the fallback
        // canonicalizes the PARENT. The two spellings must differ TEXTUALLY for this to test
        // anything — reaching the same parent through a symlink is the case that matters, and the
        // reason `canonical_key` exists at all.
        let acct_link = tmp.path().join("acct-link");
        std::os::unix::fs::symlink(tmp.path().join("accounts/acct-a"), &acct_link).unwrap();
        let missing = tmp.path().join("accounts/acct-a/not-created-yet");
        let missing_via_link = acct_link.join("not-created-yet");
        assert_ne!(missing, missing_via_link, "the two spellings must actually differ");
        assert_eq!(
            order_roots(Some(missing_via_link), vec![missing.clone()]),
            vec![missing],
            "same tree through a symlinked parent, neither leaf created yet"
        );

        // Neither parent resolvable: nothing to canonicalize against, so both survive rather than
        // being collapsed on a guess.
        let nowhere = PathBuf::from("/definitely/not/here/projects");
        let nowhere_alias = PathBuf::from("/definitely/not/there/projects");
        assert_eq!(
            order_roots(Some(nowhere_alias.clone()), vec![nowhere.clone()]),
            vec![nowhere, nowhere_alias]
        );
    }

    /// One shared budget consumed in root order let a busy store starve every root behind it —
    /// with several account stores, the starved root is `~/.claude`, typically the largest. Each
    /// root now gets a guaranteed share, and the unused remainder is redistributed.
    #[test]
    fn collect_all_guarantees_every_root_a_share_of_the_file_budget() {
        let tmp = tempfile::tempdir().unwrap();
        let busy = tmp.path().join("busy");
        let quiet = tmp.path().join("quiet");
        std::fs::create_dir_all(&busy).unwrap();
        std::fs::create_dir_all(&quiet).unwrap();
        // `busy` holds more than the whole budget on its own; `quiet` holds one file that must
        // still be scanned. Budget 4 over 2 roots ⇒ a guaranteed share of 2 each.
        for i in 0..10 {
            std::fs::write(busy.join(format!("s{i}.jsonl")), "").unwrap();
        }
        std::fs::write(quiet.join("only.jsonl"), "").unwrap();

        let (files, truncated) = collect_all(&[busy.clone(), quiet.clone()], 0, 4);
        assert!(
            files.iter().any(|p| p.starts_with(&quiet)),
            "the root scanned last must never be skipped entirely"
        );
        assert!(truncated, "busy still had files left — the report must say it is partial");
        // busy took its own share plus the remainder quiet didn't use (4 - 1 = 3).
        assert_eq!(files.iter().filter(|p| p.starts_with(&busy)).count(), 3);

        // Under the old single shared budget, root order alone decided who got nothing. With more
        // roots than budget every root still gets one file, so the result can exceed `budget` —
        // documented on `collect_all`, asserted here.
        let (files, _) = collect_all(&[busy.clone(), quiet.clone()], 0, 1);
        assert!(files.iter().any(|p| p.starts_with(&quiet)), "even a budget of 1 per root");
        assert_eq!(files.len(), 2, "one per root, which is 2 against a budget of 1");
    }

    /// The registry's LIFECYCLE, through the real functions rather than an injected closure: a
    /// generation is live while its `ScanGeneration` exists and evictable once it drops. Deleting
    /// the retire step used to leave every test green while making every generation ever minted
    /// permanently live — tier 1 then matches nothing, forever.
    #[test]
    fn a_generation_is_exempt_while_live_and_evictable_once_its_scan_ends() {
        let live = ScanGeneration::start();
        let dead = ScanGeneration::start();
        let (live_id, dead_id) = (live.id(), dead.id());
        drop(dead);

        let mut cache: HashMap<PathBuf, CachedFile> = HashMap::new();
        cache.insert(PathBuf::from("/live.jsonl"), memo_entry(live_id, UNIX_EPOCH));
        cache.insert(PathBuf::from("/dead.jsonl"), memo_entry(dead_id, UNIX_EPOCH));

        // The production predicate, not a stub.
        let is_live =
            |g: u64| live_generations().lock().unwrap_or_else(|e| e.into_inner()).contains(&g);
        evict_two_tier(&mut cache, 1, 100, is_live, |c| (c.last_touch, c.mtime));

        assert!(cache.contains_key(Path::new("/live.jsonl")), "a running scan's entry is exempt");
        assert!(!cache.contains_key(Path::new("/dead.jsonl")), "a finished scan's entry is not");

        drop(live);
        assert!(
            !live_generations().lock().unwrap().contains(&live_id),
            "the guard clears itself — no leak, even on an unwind"
        );
    }

    /// Two roots that reach ONE tree by different spellings — an account `projects/` symlinked to
    /// `~/.claude/projects`, a shape `order_roots`' doc names as real. Nested-directory tests can't
    /// catch this: there the two roots produce identical raw paths, so a raw-path key would pass.
    #[test]
    fn collect_all_collapses_two_spellings_of_the_same_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("s.jsonl"), "").unwrap();
        let alias = tmp.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();

        let (files, _) = collect_all(&[real.clone(), alias.clone()], 0, MAX_FILES);
        assert_eq!(files.len(), 1, "one file behind two spellings is scanned once");
    }

    /// Overlapping roots — one nested under the other — reach the same transcript twice.
    /// `transcript_roots` collapses roots that ARE the same tree, not roots that overlap.
    #[test]
    fn collect_all_scans_a_shared_transcript_once_across_overlapping_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let outer = tmp.path().join("outer");
        let nested = outer.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("s.jsonl"), "").unwrap();

        let (files, _) = collect_all(&[outer.clone(), nested.clone()], 0, MAX_FILES);
        assert_eq!(files.len(), 1, "one file, reachable from both roots, scanned once");
    }

    /// The reporter's scan shim: the seam a merge once broke silently. Runs against handed-in
    /// roots so it doesn't depend on this machine's ~/.claude.
    #[test]
    fn scan_window_returns_the_windows_records_for_the_reporter() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-Users-me-Projects-sparkle");
        std::fs::create_dir_all(&proj).unwrap();
        let today_iso = format_day(now_secs().div_euclid(86_400));
        std::fs::write(
            proj.join("session-a.jsonl"),
            format!(
                "{}\n",
                line(&format!("{today_iso}T10:00:00Z"), "claude-opus-5", "msg_1", 100, 7)
            ),
        )
        .unwrap();

        let scan = scan_window(&[tmp.path().to_path_buf()], 7);
        let ids: Vec<&str> = scan.records().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["msg_1"]);
        assert!(!scan.truncated);
        assert_eq!(scan.today, now_secs().div_euclid(86_400));
    }

    #[test]
    fn transcript_roots_without_app_data_still_resolve_the_primary_store() {
        // No app_data: behaves exactly like the single-store resolution (may be empty
        // in a hermetic test env, but must not panic and must not invent roots).
        let roots = transcript_roots(None);
        for r in roots {
            assert!(r.ends_with("projects"));
        }
    }

    // ── file scan ────────────────────────────────────────────────────────────────────────

    #[test]
    fn parse_file_reads_records_and_skips_junk() {
        let dir = std::env::temp_dir().join(format!("sparkle_spend_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let proj = dir.join("-Users-me-Projects-sparkle");
        std::fs::create_dir_all(&proj).unwrap();
        let path = proj.join("session-xyz.jsonl");
        let body = format!(
            "{}\n{}\n{}\n{}\n",
            line("2026-07-24T10:00:00Z", "claude-opus-5", "m1", 100, 10),
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
            r#"{"type":"assistant","message":{"usage":{"inp"#, // truncated tail
            line("2026-07-24T11:00:00Z", "claude-haiku-4-5", "m2", 5, 1),
        );
        std::fs::write(&path, body).unwrap();

        let recs = parse_file(&path);
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].session, "session-xyz");
        assert_eq!(recs[0].project, "sparkle");
        assert_eq!(recs[1].model, "claude-haiku-4-5");

        // And the scan finds it under a root, honoring the .jsonl filter.
        std::fs::write(proj.join("notes.txt"), "ignore me").unwrap();
        let mut found = Vec::new();
        let mut stopped_early = false;
        collect_files(&dir, 0, &mut found, &mut stopped_early, MAX_FILES);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0], path);
        assert!(!stopped_early, "a complete walk must not report a truncated scan");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_file_on_a_missing_path_is_empty_not_a_panic() {
        let missing = std::env::temp_dir().join("sparkle_spend_missing.jsonl");
        assert!(parse_file(&missing).is_empty());
    }

    /// The memo used to be REBUILT from each pass, so the 7d chip and the 28d default evicted each
    /// other's entries and re-parsed from scratch on every switch — the memo's stated purpose,
    /// defeated. Entries are now retained and evicted least-recently-touched.
    #[test]
    fn the_memo_evicts_least_recently_used_instead_of_wiping_what_this_pass_missed() {
        let mut cache: HashMap<PathBuf, CachedFile> = HashMap::new();
        // Three files from an old pass, two from the newest.
        for (name, touch) in [("a", 1u64), ("b", 1), ("c", 1), ("d", 9), ("e", 9)] {
            cache.insert(PathBuf::from(name), memo_entry(touch, UNIX_EPOCH));
        }

        // Under capacity: nothing is dropped, so a window switch keeps the other window warm.
        evict_here(&mut cache, 5, 100, 9);
        assert_eq!(cache.len(), 5, "a pass that saw only 2 files must not evict the other 3");

        // Over capacity: the OLDEST-touched go first, and the newest pass's entries survive.
        evict_here(&mut cache, 2, 100, 9);
        let mut kept: Vec<String> =
            cache.keys().map(|p| p.to_string_lossy().into_owned()).collect();
        kept.sort();
        assert_eq!(kept, vec!["d".to_string(), "e".to_string()]);
    }

    /// A single pass can insert far more files than [`MEMO_CAPACITY`]. Evicting from that pass's
    /// OWN entries left the tie-break to path order, so a heavy install kept the alphabetically
    /// earliest N and re-parsed the rest on every pass — a memo pinned at a fixed low hit rate.
    /// The current generation is therefore preferred, up to [`MEMO_HARD_CAP`].
    #[test]
    fn the_memo_prefers_the_running_pass_over_capacity_but_not_over_the_hard_cap() {
        let mut cache: HashMap<PathBuf, CachedFile> = HashMap::new();
        for name in ["a", "b", "c", "d"] {
            cache.insert(PathBuf::from(name), memo_entry(7, UNIX_EPOCH));
        }
        cache.insert(PathBuf::from("old"), memo_entry(1, UNIX_EPOCH));

        // Soft target 2, hard cap well above the set: only the previous pass's entry is evictable.
        evict_here(&mut cache, 2, 100, 7);
        let mut kept: Vec<String> =
            cache.keys().map(|p| p.to_string_lossy().into_owned()).collect();
        kept.sort();
        assert_eq!(
            kept,
            vec!["a".to_string(), "b".to_string(), "c".to_string(), "d".to_string()],
            "this pass's working set stays whole while the memo is under the hard cap"
        );
    }

    /// "Prefer the current pass" is not a bound: on an install whose working set exceeds the
    /// capacity, EVERY entry belongs to the current pass and nothing is evictable — the memo would
    /// settle at MAX_FILES for the process lifetime. Past the hard cap the current pass's entries
    /// go too, NEWEST file first: an append-only transcript with an old mtime is settled and hits
    /// forever, while the newest is the one about to be appended to and invalidated — and since the
    /// scan runs oldest-first, dropping the oldest would leave the next pass starting on exactly
    /// what was just evicted.
    #[test]
    fn past_the_hard_cap_the_running_pass_is_evicted_newest_file_first() {
        let mut cache: HashMap<PathBuf, CachedFile> = HashMap::new();
        for (name, secs) in [("oldest", 10u64), ("older", 20), ("newer", 30), ("newest", 40)] {
            let mtime = UNIX_EPOCH + std::time::Duration::from_secs(secs);
            cache.insert(PathBuf::from(name), memo_entry(7, mtime)); // all this pass's
        }

        evict_here(&mut cache, 1, 2, 7);
        let mut kept: Vec<String> =
            cache.keys().map(|p| p.to_string_lossy().into_owned()).collect();
        kept.sort();
        assert_eq!(
            kept,
            vec!["older".to_string(), "oldest".to_string()],
            "the hard cap is enforced, and it keeps the SETTLED transcripts — the ones that will \
             still be valid on the next pass"
        );
    }

    /// The capacity bound alone would let a deleted or aged-out transcript pin its records for the
    /// process lifetime; the production sweep drops both even when the memo is nowhere near full.
    #[test]
    fn the_memo_sweeps_stale_entries_and_deleted_files_even_under_capacity() {
        let now = std::time::Instant::now();
        let live = PathBuf::from("/tmp/sparkle-memo-live.jsonl");
        let deleted = PathBuf::from("/tmp/sparkle-memo-deleted.jsonl");
        let stale = PathBuf::from("/tmp/sparkle-memo-stale.jsonl");
        let aged = |touch: u64, age: std::time::Duration| CachedFile {
            touched_at: now - age,
            ..memo_entry(touch, UNIX_EPOCH)
        };

        let mut cache: HashMap<PathBuf, CachedFile> = HashMap::new();
        let gen_now = 100u64;
        // Touched by a PREVIOUS pass (so the sweep applies) but recently, and on disk: kept.
        cache.insert(live.clone(), aged(gen_now - 1, std::time::Duration::ZERO));
        // Reported gone by the unlocked existence check: swept.
        cache.insert(deleted.clone(), aged(gen_now - 1, std::time::Duration::ZERO));
        // Untouched for longer than MEMO_STALE_AFTER: swept.
        cache.insert(stale, aged(gen_now - 1, MEMO_STALE_AFTER + std::time::Duration::from_secs(1)));

        evict_to_capacity(&mut cache, gen_now, now, &[deleted]);
        assert_eq!(cache.len(), 1);
        assert!(cache.contains_key(&live));
    }

    /// The deleted-file check happens UNLOCKED in `load_records`, and its result is stale by the
    /// time the lock is retaken — so an entry the current pass just touched is kept even if it was
    /// reported gone. (It is also never a candidate: `load_records` only collects untouched paths.)
    #[test]
    fn a_path_this_pass_touched_survives_a_stale_deletion_report() {
        let now = std::time::Instant::now();
        let path = PathBuf::from("/tmp/sparkle-memo-racy.jsonl");
        let mut cache: HashMap<PathBuf, CachedFile> = HashMap::new();
        cache.insert(path.clone(), memo_entry(42, UNIX_EPOCH));

        evict_to_capacity(&mut cache, 42, now, std::slice::from_ref(&path));
        assert!(cache.contains_key(&path), "this pass's entry wins over a racy deletion report");

        evict_to_capacity(&mut cache, 43, now, &[path]);
        assert!(cache.is_empty(), "the next pass, which didn't touch it, drops it");
    }

    /// End-to-end over a real temp tree: the scan order is deterministic, the resume-dedup goes to
    /// the NEWEST transcript, and re-running produces a byte-identical report (the reproducibility
    /// the unstable `read_dir` order used to break).
    #[test]
    fn load_records_is_deterministic_and_attributes_a_resume_to_the_newer_file() {
        let dir = std::env::temp_dir().join(format!("sparkle-spend-load-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let proj = dir.join("projects").join("-Users-me-Projects-sparkle");
        std::fs::create_dir_all(&proj).unwrap();

        // `original` holds msg_1. `resumed` carries msg_1 forward and adds msg_2 — the real shape
        // of a `claude --resume`. Written a beat apart so their mtimes are distinguishable.
        let ts = "2026-07-24T10:00:00Z";
        std::fs::write(
            proj.join("session-original.jsonl"),
            format!("{}\n", line(ts, "claude-opus-5", "msg_1", 100, 0)),
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(
            proj.join("session-resumed.jsonl"),
            format!(
                "{}\n{}\n",
                line(ts, "claude-opus-5", "msg_1", 100, 0),
                line(ts, "claude-opus-5", "msg_2", 50, 0)
            ),
        )
        .unwrap();

        let roots = vec![dir.join("projects")];
        let day = days_from_civil(2026, 7, 24);
        let scan = || {
            let (blocks, files, truncated) = load_records(&roots, 0);
            assert_eq!(files, 2);
            assert!(!truncated, "two files is not a truncated scan");
            aggregate_records(blocks.iter().flat_map(|b| b.iter()), day, 30)
        };

        let first = scan();
        // Deduped: 150 tokens, not 250.
        assert_eq!(first.totals.tokens.total, 150);
        assert_eq!(first.totals.messages, 2);
        // …and the carried-forward turn belongs to the session the user is actually in.
        assert_eq!(first.sessions.len(), 1);
        assert_eq!(first.sessions[0].session_id, "session-resumed");

        // Same files, same answer — including the session rows and their order.
        assert_eq!(scan(), first, "a re-scan of unchanged files must be byte-identical");

        // Appending to the resumed transcript invalidates its memo entry (mtime AND len change).
        let resumed = proj.join("session-resumed.jsonl");
        let mut body = std::fs::read_to_string(&resumed).unwrap();
        body.push_str(&format!("{}\n", line(ts, "claude-opus-5", "msg_3", 7, 0)));
        std::fs::write(&resumed, body).unwrap();
        let after = scan();
        assert_eq!(after.totals.messages, 3, "an appended turn must be picked up");
        assert_eq!(after.totals.tokens.total, 157);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The serialized contract the pane reads. A rename here (or a change to the flattened `Bucket`)
    /// would compile fine and render `undefined`/`NaN` in the UI, which is exactly the class of
    /// break a type can't catch across an IPC boundary.
    #[test]
    fn the_report_serializes_the_camel_case_field_names_the_pane_reads() {
        let report = aggregate(&[rec(0, "claude-opus-5", "a", "proj", "sess", 10)], today(), 7);
        let v = serde_json::to_value(&report).unwrap();
        let obj = v.as_object().unwrap();
        for key in [
            "windowDays", "generatedAt", "days", "models", "projects", "sessions", "totals",
            "unknownModels", "filesScanned", "truncated", "roots", "pricingNote", "timezone",
        ] {
            assert!(obj.contains_key(key), "SpendReport must carry `{key}`");
        }
        assert_eq!(obj["timezone"], "UTC");

        // `Bucket` is FLATTENED into each row — the pane reads `estimatedCostUsd` at the top level
        // of a row, not nested under `bucket`.
        let day = v["days"][0].as_object().unwrap();
        for key in ["date", "tokens", "estimatedCostUsd", "unpricedTokens", "messages"] {
            assert!(day.contains_key(key), "DayTotal must carry `{key}`");
        }
        assert!(!day.contains_key("bucket"), "Bucket must stay flattened, not nested");
        let tokens = day["tokens"].as_object().unwrap();
        for key in ["input", "output", "cacheCreation", "cacheRead", "total"] {
            assert!(tokens.contains_key(key), "Tokens must carry `{key}`");
        }
        for key in ["model", "priced", "estimatedCostUsd"] {
            assert!(v["models"][0].as_object().unwrap().contains_key(key));
        }
        for key in ["project", "sessions", "lastActive", "estimatedCostUsd"] {
            assert!(v["projects"][0].as_object().unwrap().contains_key(key));
        }
        for key in ["sessionId", "project", "lastActive", "estimatedCostUsd"] {
            assert!(v["sessions"][0].as_object().unwrap().contains_key(key));
        }
    }
}
