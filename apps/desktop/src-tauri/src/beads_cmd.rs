// apps/desktop/src-tauri/src/beads_cmd.rs
//
// The PLANNING/BEADS COMMAND SURFACE: a typed, bounded, fail-soft way for a programmatic caller
// (the concierge) to read and mutate the work graph that backs the Plan board.
//
// WHY A SECOND MODULE AND NOT MORE OF `notes.rs`. `notes.rs` already owns the bd wrapper the BOARD
// uses, and this module deliberately does NOT duplicate it: bd's binary resolution
// (`notes::cached_bd_path`), the augmented PATH its `git` child needs (`notes::bd_exec_path`), and
// the flag-injection guard (`notes::valid_bead_id`) are all imported from there. What is new here is
// a different CONTRACT, and mixing the two contracts in one module would be the actual duplication:
//
//   * notes.rs returns bd's RAW stdout as `Result<String, String>` and lets the frontend parse it.
//     That is right for the board, which wants every field and re-reads every 5s into a component.
//   * a programmatic caller needs the opposite: PARSED rows, a BOUNDED payload, and errors it can
//     branch on without substring-matching English. An LLM-driven caller that receives an
//     unbounded blob pays for it permanently — a tool result is never evicted from its context —
//     and `bd list --all --limit 0 --json` over this repo's ~825 beads is ~2.9 MB, most of it
//     multi-KB descriptions. Handing that to a caller once would blow the context outright.
//
// So: `notes.rs` = the board's raw path (unchanged), `beads_cmd.rs` = the typed/capped path. bd
// remains the single source of truth for the work graph in both — nothing here reimplements its
// storage, every operation shells out.
//
// THE OUTPUT CAP, precisely. `omitted` is the EXACT count of rows dropped and `omittedIds` is a
// capped sample of their ids, mirroring the established shape in `services/controlListener.ts`
// (OMITTED_IDS_CAP there; the contract is "cap the id list, keep the count exact, so the truncation
// is always visible"). Two independent axes are capped, because the payload is rows x row-size:
//   1. ROW COUNT  — `limit` (default DEFAULT_LIMIT, hard ceiling MAX_LIMIT).
//   2. ROW SIZE   — each description is cut to DESCRIPTION_EXCERPT_CHARS with a
//      `descriptionTruncated` flag, since a single bead's description can exceed 3 KB on its own.
// We ask bd for ALL matching rows and cap in Rust rather than passing bd a `--limit`, so `total`
// and `omitted` are exact rather than "at least N" — bd's own truncation only reports "more results
// matched" on stderr, with no count. The unbounded read stays in native memory for a few ms and
// never reaches the caller; that is the boundary this cap is defending.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::notes::{bd_exec_path, cached_bd_path, valid_bead_id};

// ── Caps ──────────────────────────────────────────────────────────────────────────────────────

/// Rows returned when the caller does not ask for a specific `limit`.
const DEFAULT_LIMIT: usize = 100;
/// Hard ceiling on rows, applied even when the caller asks for more. A caller that wants the whole
/// backlog must page for it; there is no "give me all 825" mode by design.
const MAX_LIMIT: usize = 500;
/// Max ids listed in `omittedIds`. A convenience for resolving a specific dropped bead, not a second
/// page — `omitted` stays the exact count either way. Mirrors controlListener's OMITTED_IDS_CAP.
const OMITTED_IDS_CAP: usize = 20;
/// Per-row description budget. Descriptions are the dominant cost: this repo's beads average ~1.5 KB
/// and the largest exceed 3 KB, so 100 uncut rows would be ~150 KB while 100 cut rows are ~28 KB.
const DESCRIPTION_EXCERPT_CHARS: usize = 280;
/// Max dependency/dependent links reported per bead in `beads_detail`.
const LINKS_CAP: usize = 100;
/// Max chars of bd stderr echoed into a `BeadsError.message`. bd can emit a long trace; the caller
/// needs the first line to act on, not the whole thing.
const ERROR_MESSAGE_CHARS: usize = 600;
/// How long any single bd invocation may run before it is killed and reported as `timeout`.
/// Generous because bd's Dolt-backed storage can be slow to open a cold database, but finite:
/// the whole point is that a wedged bd surfaces as a typed error instead of hanging the caller.
///
/// `pub(crate)` so `notes::run_bd` bounds its own bd calls with THIS budget rather than declaring a
/// second one. Both modules drive the same Dolt store through the same binary, so two constants
/// would be two policies that silently drift apart.
pub(crate) const BD_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the POST-CREATE CONFIRMATION PROBE may run — deliberately shorter than `BD_TIMEOUT`,
/// and it is the only bd call in this module that is not on the full budget.
///
/// The probe is the second bd invocation inside ONE `beads_create`, so its budget is not free: it
/// adds to the create's. `plans:create_plan` reaches this through the concierge bridge, and that
/// bridge kills a tool call at `CONCIERGE_TOOL_TIMEOUT_MS` — 50s
/// (apps/mcp-control/src/tools.ts). At the full 30s each, a slow store puts the pair at 60s, so the
/// bridge would kill the call ten seconds AFTER bd had already confirmed the write: the model is
/// told the tool timed out for a bead that is sitting in the store, which is precisely the
/// "unknown outcome" this whole confirmation exists to eliminate. 30 + 10 = 40s fits with headroom.
///
/// SHORTENING IT COSTS NOTHING IN CORRECTNESS, and that is what makes 10s safe rather than a
/// guess: `confirm_written` fails OPEN on a probe that could not run (see its doc comment), and a
/// probe killed on this bound is exactly that case. So the worst outcome of too short a budget is
/// the pre-existing behaviour — an unconfirmed create reported as success — never a landed write
/// reported as lost. It is also a `bd show` of ONE id against a store the create just opened, so
/// the cold-open argument that earns `BD_TIMEOUT` its 30s does not apply to it.
const BD_CONFIRM_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long we wait for the pipe readers once the child itself is gone.
///
/// This is NOT a second timeout for bd; it is the bound that makes BD_TIMEOUT mean anything. bd is
/// Dolt-backed and starts a background `dolt sql-server`, and any grandchild that inherited the
/// stdout/stderr WRITE ends keeps them open after we kill the direct child — so `read_to_end` never
/// sees EOF and an unconditional `join()` wedges the thread permanently, which is the exact failure
/// the timeout exists to prevent. We wait this long, then give up on the readers and leave them
/// detached (they finish when the grandchild does).
const READER_DRAIN_GRACE: Duration = Duration::from_secs(5);

/// Hard ceiling on bd/Dolt subprocesses running AT ONCE across the whole process.
///
/// THE ROOT CAUSE this bounds. The work graph is one single-writer embedded Dolt store shared by
/// every worktree on the machine, and `beadsStore.ts` polls `bd list --all` + `bd blocked` every 5s
/// per watched project. Each poll and every mutation funnels through `run_cmd_timed` (below), which
/// had NO cap on how many bd children could be in flight. Under contention a cold `bd list` takes
/// ~44.8s — longer than BD_TIMEOUT — so every call burns the full 30s doing nothing while the 5s
/// poll launches yet more, a convoy that never drains and saturates the tokio blocking pool. Every
/// UI action needs a blocking-pool thread (git, pty, worktree), so they queue behind the jam and the
/// whole app goes unresponsive. This was a P0.
///
/// Capping concurrent bd children at a small N attacks the cause, not the symptom: fewer writers
/// contend for the one Dolt lock, so each call finishes in a fraction of the 44.8s cold time, which
/// turns the non-draining convoy into a queue that drains faster than the 5s poll refills it. 2 is
/// deliberately small — the store is single-writer, so extra parallelism buys almost nothing and
/// only deepens the contention this exists to relieve; a reader and a writer overlapping is the case
/// worth keeping. It is a `const` so the one policy lives in one place.
const BD_MAX_CONCURRENT: usize = 2;

/// The minimum budget that must remain AFTER acquiring a permit for it to be worth spawning bd.
///
/// Comfortably above the 20ms subprocess poll tick and a plausible process spawn, so a child we do
/// start has a real chance to finish. Below it, spawning only pays a cold Dolt open for a child that
/// will be killed on the next tick — and mislabels a queue-dominated call as a wedged bd — so
/// `run_cmd_until` returns the queue-saturation `StoreBusy` error without spawning instead.
const MIN_RUN_BUDGET_AFTER_QUEUE: Duration = Duration::from_millis(100);

// ── Typed errors ──────────────────────────────────────────────────────────────────────────────

/// What KIND of failure this was, as a stable machine-readable tag.
///
/// The existing frontend contract is stringly — `isBeadsUnavailable` substring-matches
/// "no beads database found" — which is fine for one call site and bad for a programmatic caller
/// that must branch on outcome. A caller can switch on `kind` and never parse English; `message`
/// stays for display only.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BeadsErrorKind {
    /// `bd` is not installed / not resolvable. The caller should offer to install it, not retry.
    BinaryNotFound,
    /// bd ran but this project has no beads workspace. Recoverable via `ensure_beads_db`.
    NoWorkspace,
    /// The request was rejected before bd was invoked (bad id, empty title, unknown field).
    InvalidInput,
    /// bd ran and exited non-zero for some other reason. `exitCode` carries its status.
    BdFailed,
    /// bd exceeded BD_TIMEOUT and was killed.
    Timeout,
    /// The call lost the race for the store, from either of TWO producers with DIFFERENT write-safety
    /// (this is why the kind alone is not enough to pick a remedy). Distinct from `BdFailed` because
    /// nothing about the request was wrong.
    ///  1. `classify_bd_message`: bd RAN, reached the store, and could not complete — its context was
    ///     canceled or the embedded DB refused the write because another writer holds it. Retry-safe
    ///     for a READ or an idempotent update, but for a non-idempotent mutation (`bd create`) this is
    ///     write-AMBIGUOUS — bd may have committed just before the lock was pulled, so a blind retry
    ///     can file a SECOND item. Check the board before retrying a create.
    ///  2. `queue_saturated`: bd was NEVER SPAWNED because the concurrency permit queue stayed
    ///     saturated past the deadline. Unconditionally write-SAFE — nothing ran, nothing was
    ///     written — so retry the same request as-is.
    /// Only producer 2 is unconditionally retry-safe. Today both reach the user via `describe_bd_failure`'s
    /// verbatim pass-through, so producer 1's write-ambiguity is NOT yet surfaced — a real gap tracked
    /// as a follow-up (sparkle-lncpoc: a machine-distinguishable never-spawned marker so consumers like
    /// `describe_bd_failure` and the frontend `createFailureVerdict` can tell the two apart). Until
    /// then, do NOT collapse them into one remedy in either direction: keep the never-spawned half's
    /// write-safe copy (guarded by a test in notes.rs), and do NOT tell a create that lost the lock to
    /// retry blindly.
    StoreBusy,
    /// bd exited cleanly but its output was not the JSON we expect (version skew, partial write).
    BadOutput,
}

/// The error every command in this module returns. Serializes to
/// `{ kind, message, exitCode }` — a caller branches on `kind` and shows `message`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BeadsError {
    pub kind: BeadsErrorKind,
    pub message: String,
    pub exit_code: Option<i32>,
}

impl BeadsError {
    // `pub(crate)` rather than private: `epic_prd` is a sibling module that constructs the same
    // error type, and a private constructor forced it to either duplicate the struct literal —
    // which would bypass the `excerpt` truncation every other error goes through — or invent a
    // second error type. One error type, one constructor, one truncation rule.
    pub(crate) fn new(kind: BeadsErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: excerpt(&message.into(), ERROR_MESSAGE_CHARS).0, exit_code: None }
    }
    fn with_code(kind: BeadsErrorKind, message: impl Into<String>, code: Option<i32>) -> Self {
        Self { exit_code: code, ..Self::new(kind, message) }
    }
}

// ── Wire types ────────────────────────────────────────────────────────────────────────────────

/// One bead, flattened to the fields a planning caller actually uses. Deliberately NOT a
/// pass-through of bd's row: bd emits ~20 keys including several multi-KB text blobs, and the point
/// of this surface is that the caller can hold a page of these in context.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BeadSummary {
    pub id: String,
    pub title: String,
    pub status: String,
    pub priority: Option<i64>,
    pub issue_type: Option<String>,
    pub assignee: Option<String>,
    pub parent: Option<String>,
    pub labels: Vec<String>,
    /// Description cut to DESCRIPTION_EXCERPT_CHARS. Use `beads_detail` for the full text.
    pub description: String,
    /// True when `description` was cut — so a caller never mistakes an excerpt for the whole field.
    pub description_truncated: bool,
    pub dependency_count: i64,
    pub dependent_count: i64,
    pub comment_count: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub closed_at: Option<String>,
}

/// A bounded page of beads. `total`/`omitted` are exact; `omittedIds` is a capped sample.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BeadPage {
    pub beads: Vec<BeadSummary>,
    /// How many rows matched the query in total, before this cap was applied.
    pub total: usize,
    /// Exactly how many matching rows are NOT in `beads`. Zero means the page is complete.
    pub omitted: usize,
    /// Ids of omitted rows, capped at OMITTED_IDS_CAP. A sample, not a page.
    pub omitted_ids: Vec<String>,
    /// The `limit` actually applied after clamping to MAX_LIMIT.
    pub limit: usize,
}

/// One edge in the work graph, as reported by `bd dep list`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BeadLink {
    pub id: String,
    pub link_type: String,
}

/// One comment on a bead, as reported by `bd show --json --include-comments`.
///
/// The read HALF of the comment feature — the write half (`beads_comment`) already shipped with no
/// reader. bd emits each comment as `{id, issue_id, author, text, created_at}`; only `text` is
/// load-bearing, so `author`/`created_at` are `Option` (a bd build that renames or drops one must
/// degrade the comment to "no author" rather than drop the whole thread). These are `Option`, so
/// serde emits them as an explicit `null` — the TS side reads them as `T | null`, never `T?`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BeadComment {
    pub id: String,
    pub author: Option<String>,
    pub text: String,
    pub created_at: Option<String>,
}

/// A single bead with its full description plus its immediate graph neighbourhood.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BeadDetail {
    pub bead: BeadSummary,
    /// The FULL description (uncut), unlike `bead.description` which stays excerpted so the two
    /// types serialize identically everywhere else.
    pub full_description: String,
    /// Children (beads whose parent is this one), bounded by the same cap as a query page.
    pub children: BeadPage,
    /// What this bead depends on / is blocked by.
    pub dependencies: Vec<BeadLink>,
    /// What depends on this bead.
    pub dependents: Vec<BeadLink>,
    /// The bead's comment thread, oldest-first as bd returns it. Read LAZILY — `--include-comments`
    /// rides only on this per-open detail call, never on the board's 5s list poll (which would pull
    /// every bead's whole thread against an already-contended store on every tick).
    pub comments: Vec<BeadComment>,
    /// True when the link lists were cut at LINKS_CAP.
    pub links_truncated: bool,
}

/// Query filters. Every field is optional; an all-`None` query lists open beads.
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BeadQuery {
    /// bd's stored status. Comma-separated is allowed ("open,in_progress").
    pub status: Option<String>,
    /// "0".."4" or "P0".."P4".
    pub priority: Option<String>,
    pub parent: Option<String>,
    pub assignee: Option<String>,
    pub issue_type: Option<String>,
    pub label: Option<String>,
    /// Beads carrying this label are EXCLUDED. Independent of `label` (bd treats include/exclude as
    /// separate axes), so both can apply at once. The board uses it to hide `sparkle-auto` telemetry.
    pub exclude_label: Option<String>,
    pub title_contains: Option<String>,
    /// Only beads with no active blockers.
    pub ready: Option<bool>,
    /// Only blocked beads. Ignored when `status` is set — see `build_query_args`.
    pub blocked: Option<bool>,
    /// Include closed beads. Ignored when `status` is set — see `build_query_args`.
    pub include_closed: Option<bool>,
    pub limit: Option<usize>,
}

/// Fields for a new bead.
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewBead {
    pub title: String,
    pub description: Option<String>,
    pub issue_type: Option<String>,
    pub priority: Option<String>,
    pub parent: Option<String>,
    pub assignee: Option<String>,
    pub labels: Option<String>,
}

/// A partial update. Only the `Some` fields are written.
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BeadPatch {
    pub status: Option<String>,
    pub priority: Option<String>,
    pub assignee: Option<String>,
}

// ── Pure helpers (unit-tested without invoking bd) ────────────────────────────────────────────

/// Cut `s` to at most `max` CHARACTERS, returning the cut text and whether anything was dropped.
/// Char-based, not byte-based: bead titles and descriptions routinely contain em-dashes and other
/// multi-byte characters, and slicing those by byte offset panics.
fn excerpt(s: &str, max: usize) -> (String, bool) {
    if s.chars().count() <= max {
        return (s.to_string(), false);
    }
    (s.chars().take(max).collect(), true)
}

/// Assemble the argv after `bd` for a query. Pure, so the whole filter matrix is testable without a
/// bd on the machine.
///
/// PRECEDENCE, because three of bd's filters overlap and silently override one another:
///   * `status` is the most specific, so it WINS. When it is set, `blocked` and `includeClosed` are
///     ignored rather than appended — `--all` "overrides the default filter" in bd and would widen
///     a caller's explicit `status=open` back to everything, which is the opposite of what was asked.
///   * `blocked` is expressed as `--status blocked` (bd has no `--blocked`), which is why it can
///     only apply when `status` is absent.
///   * `ready` is an independent flag and always applies.
/// We always pass `--json`. We do NOT pass `--limit`: capping happens in Rust so `total`/`omitted`
/// are exact (see the module note).
/// Append `flag` and its value as two SEPARATE argv tokens. A free fn rather than a closure so it
/// does not hold a mutable borrow of `args` across the rest of the assembly.
fn push_flag(args: &mut Vec<String>, flag: &str, val: &str) {
    args.push(flag.to_string());
    args.push(val.to_string());
}

fn build_query_args(q: &BeadQuery) -> Vec<String> {
    let mut args: Vec<String> = vec!["list".into()];

    let status = q.status.as_deref().map(str::trim).filter(|s| !s.is_empty());
    match status {
        Some(s) => push_flag(&mut args, "--status", s),
        None => {
            if q.blocked.unwrap_or(false) {
                push_flag(&mut args, "--status", "blocked");
            } else if q.include_closed.unwrap_or(false) {
                args.push("--all".into());
            }
        }
    }

    for (flag, val) in [
        ("--priority", &q.priority),
        ("--parent", &q.parent),
        ("--assignee", &q.assignee),
        ("--type", &q.issue_type),
        ("--label", &q.label),
        ("--exclude-label", &q.exclude_label),
        ("--title-contains", &q.title_contains),
    ] {
        if let Some(v) = val.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            push_flag(&mut args, flag, v);
        }
    }

    if q.ready.unwrap_or(false) {
        args.push("--ready".into());
    }
    // Ask bd for everything that matched; the cap is applied to the RESULT, not the query.
    args.push("--limit".into());
    args.push("0".into());
    args.push("--json".into());
    args
}

/// Assemble the argv for `bd create`. Pure. Values are argv tokens, never shell-interpolated.
///
/// The title goes through `--title=<t>`, NOT the positional `bd create <title>` slot, because a
/// positional operand is the one place bd's parser cannot tell content from a flag. `bd` rejects a
/// positional title starting with `-` outright — a plain markdown bullet (`"- fix the thing"`) is
/// enough — and its own error message names `--title=` as the way to mean it. The `=` form binds the
/// value to the flag inside a single argv token, so no leading dash can be re-read as an option.
/// A separate-token FLAG value (`-d <desc>`) needs no such care: pflag consumes the next token as
/// the value whatever it starts with (verified against bd 1.0.5).
fn build_create_args(n: &NewBead) -> Vec<String> {
    let mut args: Vec<String> = vec!["create".into(), format!("--title={}", n.title.trim())];
    push_flag(&mut args, "-d", n.description.as_deref().unwrap_or(""));
    push_flag(
        &mut args,
        "-t",
        n.issue_type.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("task"),
    );
    for (flag, val) in [
        ("-p", &n.priority),
        ("--parent", &n.parent),
        ("-a", &n.assignee),
        ("-l", &n.labels),
    ] {
        if let Some(v) = val.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            push_flag(&mut args, flag, v);
        }
    }
    args.push("--json".into());
    args
}

/// Assemble the argv for `bd update`. Returns None when the patch is empty, so the caller can
/// reject a no-op instead of shelling out to change nothing.
fn build_update_args(id: &str, p: &BeadPatch) -> Option<Vec<String>> {
    let mut args: Vec<String> = vec!["update".into(), id.to_string()];
    let before = args.len();
    for (flag, val) in [("-s", &p.status), ("-p", &p.priority), ("-a", &p.assignee)] {
        if let Some(v) = val.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            args.push(flag.to_string());
            args.push(v.to_string());
        }
    }
    if args.len() == before {
        return None;
    }
    Some(args)
}

/// Assemble the argv for `bd close`. Pure. `reason` rides a FLAG, so it needs no separator; the id
/// is already charset-checked by `require_id`.
fn build_close_args(id: &str, reason: &str) -> Vec<String> {
    let mut args: Vec<String> = vec!["close".into(), id.to_string()];
    // bd accepts a bare `close`; only pass --reason when there is one, so an empty string does not
    // overwrite a reason with nothing.
    if !reason.trim().is_empty() {
        push_flag(&mut args, "--reason", reason);
    }
    args
}

/// Assemble the argv for a REPARENT — `bd update <id>... --parent <epic>`. Pure, so the one
/// property that matters (every selected id rides ONE invocation) is assertable without bd.
///
/// ══ ONE CALL, N IDS — AND THAT IS THE CONTRACT, NOT AN OPTIMISATION ═══════════════════════════
/// `bd update` takes MULTIPLE positional ids and applies the same flags to all of them; verified
/// against bd directly on three throwaway ephemeral wisps before this was written (`bd update A B
/// --parent E` answered with one `✓ Updated issue` line per id, and `bd show A --json` then carried
/// `"parent": "E"` plus a `parent-child` dependency edge). A per-id loop would be N separate
/// mutations against a single embedded store that every worktree shares and this app polls every
/// five seconds — so a failure halfway leaves the board holding HALF a move with nothing saying
/// which half, and the poll can land between two of them and paint an epic mid-assembly.
///
/// ══ AN EMPTY PARENT IS THE UNPARENT PATH, AND IT MUST SURVIVE THE ASSEMBLY ════════════════════
/// bd documents `--parent` as *"New parent issue ID (reparents the issue, use empty string to
/// remove parent)"* — so the empty string is a VALUE here, never an omission. That is exactly where
/// `build_update_args` cannot be reused: it filters an empty value out entirely
/// (`.filter(|s| !s.is_empty())`), which would turn "take these off their epic" into an argv with
/// no flags at all and then reject it as an empty patch. The precedent for passing an empty flag
/// value deliberately is `notes::bead_unclaim_args`' `-a ""`, and it is verified the same way: `bd
/// update A B --parent ""` cleared `parent` on both wisps and dropped the dependency edge.
///
/// The parent is TRIMMED but not otherwise altered, so `"  "` reads as "remove the parent" rather
/// than as a bead named two spaces. The ids are charset-checked by the caller (`require_id`), which
/// is what stops one being re-read as a flag.
fn build_reparent_args(ids: &[String], parent: &str) -> Vec<String> {
    let mut args: Vec<String> = vec!["update".into()];
    args.extend(ids.iter().cloned());
    args.push("--parent".into());
    args.push(parent.trim().to_string());
    args
}

/// Assemble the argv for `bd comment`. Pure.
///
/// The comment body is a POSITIONAL operand, so it gets the same treatment as a title: a body
/// starting with `-` is otherwise parsed as an option (bd 1.0.5 answers `"- a bullet"` with
/// `unknown shorthand flag: ' '`). `comment` has no `--text=` flag, so we use the argument
/// terminator instead — everything after `--` is a positional, verified against bd 1.0.5.
/// `pub(crate)` so `bead_dup` records a fold through THIS assembly rather than growing a second
/// one — the `--` terminator above is the whole reason a hand-rolled copy would be a bug.
pub(crate) fn build_comment_args(id: &str, text: &str) -> Vec<String> {
    vec!["comment".into(), "--".into(), id.to_string(), text.to_string()]
}

fn as_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_string).filter(|s| !s.is_empty())
}

fn as_i64(v: Option<&Value>) -> Option<i64> {
    v.and_then(Value::as_i64)
}

/// Normalize one loosely-typed bd row. Tolerant of bd's key drift the same way
/// `services/beads.ts::normalizeBead` is — `id`/`issue_id`, `issue_type`/`type`, `status`/`state`,
/// `parent`/`parent_id`, `owner`/`assignee` — so a bd upgrade that renames a key degrades to a
/// missing field instead of an error.
fn normalize_bead(row: &Value) -> BeadSummary {
    let g = |k: &str| row.get(k);
    let (description, description_truncated) =
        excerpt(&as_str(g("description")).unwrap_or_default(), DESCRIPTION_EXCERPT_CHARS);
    BeadSummary {
        id: as_str(g("id")).or_else(|| as_str(g("issue_id"))).unwrap_or_default(),
        title: as_str(g("title")).unwrap_or_default(),
        status: as_str(g("status")).or_else(|| as_str(g("state"))).unwrap_or_else(|| "open".into()),
        priority: as_i64(g("priority")),
        issue_type: as_str(g("issue_type")).or_else(|| as_str(g("type"))),
        assignee: as_str(g("assignee")).or_else(|| as_str(g("owner"))),
        parent: as_str(g("parent")).or_else(|| as_str(g("parent_id"))),
        labels: row
            .get("labels")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
        description,
        description_truncated,
        dependency_count: as_i64(g("dependency_count")).unwrap_or(0),
        dependent_count: as_i64(g("dependent_count")).unwrap_or(0),
        comment_count: as_i64(g("comment_count")).unwrap_or(0),
        created_at: as_str(g("created_at")),
        updated_at: as_str(g("updated_at")),
        closed_at: as_str(g("closed_at")),
    }
}

/// Parse bd's `--json` stdout into rows.
///
/// Handles the three shapes bd actually emits: a JSON ARRAY (list/show), a single OBJECT (create),
/// and an `{"error": …}` object — which bd emits on stdout while ALSO exiting non-zero for some
/// subcommands and exiting ZERO for others, so it must be detected by content, not by status.
/// An empty body is a legitimately empty result set, not a failure.
fn parse_bead_rows(stdout: &str) -> Result<Vec<BeadSummary>, BeadsError> {
    let body = stdout.trim();
    if body.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Value = serde_json::from_str(body).map_err(|e| {
        BeadsError::new(BeadsErrorKind::BadOutput, format!("bd returned unparseable JSON: {e}"))
    })?;
    if let Some(err) = error_payload(&parsed) {
        return Err(classify_bd_message(&err, None));
    }
    match parsed {
        Value::Array(rows) => Ok(rows.iter().map(normalize_bead).collect()),
        Value::Object(_) => Ok(vec![normalize_bead(&parsed)]),
        _ => Err(BeadsError::new(
            BeadsErrorKind::BadOutput,
            "bd returned JSON that was neither an object nor an array",
        )),
    }
}

/// bd's `{"error": …}` payload as a message, if `v` carries one. The ONE definition of "this JSON
/// body is a failure", shared by the parsing path and the mutation-ack path so they cannot drift.
/// Tolerates a non-string `error` (bd could nest it) rather than reading it as success.
fn error_payload(v: &Value) -> Option<String> {
    let e = v.get("error")?;
    Some(e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string()))
}

/// The wordings that mean "the store was busy", not "the request was bad".
///
/// The store is ONE embedded database shared by every worktree in the repo, written by dozens of
/// agents and polled by this app every five seconds, so a write losing the race for it is an
/// ordinary event rather than an exceptional one. When that happens bd does not say "locked" — the
/// Go client's context is canceled first, and the caller is handed the bare runtime phrase
/// `context canceled`, which names the mechanism and not the cause. Read literally it describes a
/// call that someone aborted, which is why it reads as a fault in the caller's own request and gets
/// investigated as one.
///
/// Kept as a table rather than inlined so the wordings are auditable in one place. Deliberately
/// narrow: every entry here is a phrase that can ONLY be produced by the store being unavailable
/// for the length of the call. Generic exhaustion wordings ("resource temporarily unavailable") are
/// excluded — a spawn failure is not a busy store, and mistaking one for the other would tell a
/// caller to retry something that will never succeed.
const STORE_BUSY_WORDINGS: &[&str] = &[
    "context canceled",
    "context cancelled",
    "context deadline exceeded",
    "database is locked",
    "could not acquire lock",
    "failed to acquire lock",
    "lock is held",
    "database is in use",
];

/// Map a bd failure message onto a typed kind. The substrings are bd's stable wording — the same
/// contract `services/beads.ts::isBeadsUnavailable` already depends on — and anything unrecognized
/// stays `BdFailed` rather than being forced into a bucket it may not belong in.
fn classify_bd_message(msg: &str, code: Option<i32>) -> BeadsError {
    let lower = msg.to_lowercase();
    let kind = if lower.contains("no beads database found") || lower.contains("no beads workspace") {
        BeadsErrorKind::NoWorkspace
    } else if STORE_BUSY_WORDINGS.iter().any(|w| lower.contains(w)) {
        BeadsErrorKind::StoreBusy
    } else {
        BeadsErrorKind::BdFailed
    };
    BeadsError::with_code(kind, msg, code)
}

/// Apply the row cap to a full result set. `total` and `omitted` are exact; `omittedIds` is capped.
fn paginate(rows: Vec<BeadSummary>, requested: Option<usize>) -> BeadPage {
    // A caller asking for 0 gets the default, not an empty page — 0 reads as "unset", and bd's own
    // `--limit 0` means "unlimited", so honoring it literally here would be the exact opposite.
    let limit = requested.filter(|n| *n > 0).unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    let total = rows.len();
    if total <= limit {
        return BeadPage { beads: rows, total, omitted: 0, omitted_ids: Vec::new(), limit };
    }
    let dropped = &rows[limit..];
    let omitted_ids: Vec<String> =
        dropped.iter().take(OMITTED_IDS_CAP).map(|b| b.id.clone()).collect();
    let omitted = dropped.len();
    BeadPage { beads: rows.into_iter().take(limit).collect(), total, omitted, omitted_ids, limit }
}

/// Parse `bd dep list --json` into typed edges, split into what the bead depends ON versus what
/// depends on IT. bd reports each edge as `{issue_id, depends_on_id, type}`; the side `id` sits on
/// tells us the direction relative to `id`.
fn parse_links(stdout: &str, id: &str) -> (Vec<BeadLink>, Vec<BeadLink>, bool) {
    let body = stdout.trim();
    if body.is_empty() {
        return (Vec::new(), Vec::new(), false);
    }
    let Ok(parsed) = serde_json::from_str::<Value>(body) else {
        return (Vec::new(), Vec::new(), false);
    };
    let rows = match parsed {
        Value::Array(a) => a,
        // Some bd versions wrap the edges; tolerate both rather than reporting a graph as empty.
        Value::Object(ref o) => o
            .get("dependencies")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let (mut deps, mut dependents) = (Vec::new(), Vec::new());
    for r in &rows {
        let from = as_str(r.get("issue_id")).unwrap_or_default();
        let to = as_str(r.get("depends_on_id")).unwrap_or_default();
        let link_type = as_str(r.get("type")).unwrap_or_else(|| "blocks".into());
        if from == id && !to.is_empty() {
            deps.push(BeadLink { id: to, link_type });
        } else if to == id && !from.is_empty() {
            dependents.push(BeadLink { id: from, link_type });
        }
    }
    let truncated = deps.len() > LINKS_CAP || dependents.len() > LINKS_CAP;
    deps.truncate(LINKS_CAP);
    dependents.truncate(LINKS_CAP);
    (deps, dependents, truncated)
}

// ── The runner ────────────────────────────────────────────────────────────────────────────────

/// Raw result of one bd invocation.
///
/// `pub(crate)` because `notes::run_bd` returns this instead of `std::process::Output`: an
/// `ExitStatus` cannot be constructed portably on stable (`ExitStatusExt::from_raw` is unix-only)
/// and this crate must keep building on Windows, so a bounded runner has to hand back its own type.
#[derive(Debug)]
pub(crate) struct BdOutput {
    pub(crate) status: Option<i32>,
    pub(crate) success: bool,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

/// Extra environment applied to the CHILD only, as `(name, value)` pairs.
///
/// Production passes `NO_EXTRA_ENV`. It exists so a test can pin a variable for its own invocations
/// without calling `std::env::set_var`, which mutates this whole process — `cargo test` runs tests
/// on parallel threads, so a process-wide set leaks into every other test in the binary and is
/// `unsafe` under the 2024 edition besides.
pub(crate) type ChildEnv<'a> = &'a [(&'a str, &'a str)];

/// The production child environment: nothing beyond what `run_cmd_timed` already sets.
pub(crate) const NO_EXTRA_ENV: ChildEnv<'static> = &[];

/// Reject a project root that does not exist, BEFORE spawning.
///
/// `project_path` arrives unvalidated from the webview, and a deleted/renamed project root makes
/// `spawn` fail with the very same ENOENT a missing binary produces — which would answer "install
/// beads" for a problem installing beads cannot fix, and `binaryNotFound` is exactly the kind
/// callers are told never to retry. `notes.rs` gates its filesystem paths through
/// `validate_project_root` for the same reason. Checking first also means a `NotFound` from `spawn`
/// really is about the binary.
fn require_project_dir(project_path: &str) -> Result<(), BeadsError> {
    if std::path::Path::new(project_path).is_dir() {
        return Ok(());
    }
    Err(BeadsError::new(
        BeadsErrorKind::InvalidInput,
        format!("project path is not an existing directory: {project_path}"),
    ))
}

/// Read a child pipe to EOF on its own thread, handing the bytes back over a channel.
///
/// A channel rather than a `JoinHandle` so the caller can WAIT WITH A BOUND: `join()` has no
/// timeout, and this read may never finish (see READER_DRAIN_GRACE).
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(mut p) = pipe {
            p.read_to_end(&mut b).ok();
        }
        tx.send(b).ok();
    });
    rx
}

/// Run `bd <args>` in `project_path` with a hard timeout, returning typed errors.
///
/// Reuses `notes::cached_bd_path` / `notes::bd_exec_path` so bd is located and PATH-augmented
/// EXACTLY as the board's path does it (see the module note). The remaining difference from
/// `notes::run_bd` is the error type: typed `BeadsError` here, `String` there (the board's frontend
/// contract is stringly).
///
/// The BOUND is no longer a difference. `notes::run_bd` used `.output()`, which blocks forever on a
/// wedged bd — bd is Dolt-backed and takes a lock on a store shared by every worktree, so a hung
/// call there hung the caller with no way out, and surfaced to the concierge as
/// `bridge request timeout: concierge_tool`. It now delegates to `run_cmd_timed` with this same
/// `BD_TIMEOUT`, so both surfaces are bounded by one budget.
fn run_bd_timed(
    project_path: &str,
    args: &[String],
    timeout: Duration,
    env: ChildEnv<'_>,
) -> Result<BdOutput, BeadsError> {
    run_cmd_timed(&resolve_bd()?, project_path, args, timeout, env)
}

/// Resolve the bd binary or a typed `BinaryNotFound`. Shared by `run_bd_timed` and the confirmation
/// probe's `run_bd_unlimited` so the "install beads" wording lives in one place.
fn resolve_bd() -> Result<String, BeadsError> {
    cached_bd_path().ok_or_else(|| {
        BeadsError::new(
            BeadsErrorKind::BinaryNotFound,
            "bd not found — install beads (https://github.com/steveyegge/beads) or add `bd` to your PATH",
        )
    })
}

/// Run bd WITHOUT taking a store permit. ONLY for the post-create confirmation probe — see
/// `bd_stdout_unlimited_within`. It resolves and runs the real bd binary exactly as `run_bd_timed`
/// does, but passes `None` for the limiter so the probe never queues behind other bd traffic.
fn run_bd_unlimited(
    project_path: &str,
    args: &[String],
    timeout: Duration,
    env: ChildEnv<'_>,
) -> Result<BdOutput, BeadsError> {
    run_cmd_until(None, &resolve_bd()?, project_path, args, timeout, env)
}

/// A sync counting semaphore bounding how many bd children run at once.
///
/// std-only (a `Mutex<usize>` + `Condvar`) rather than tokio's `Semaphore` ON PURPOSE: `run_cmd_timed`
/// is a synchronous function reached from EVERY bd caller (`notes.rs`'s 5s board poll and mutations,
/// this module's commands, `bead_dup`), each already offloaded onto the blocking pool via
/// `spawn_blocking`, and also driven directly by tests that stand up NO tokio runtime. A tokio
/// `Semaphore::acquire().await` cannot be reached from this sync context, and `block_on` would panic
/// in the test path where no runtime exists. A std primitive works identically in all three.
///
/// The `Mutex` is held ONLY for the counter bookkeeping in `acquire`/`release`, never across the
/// subprocess — the permit (the decrement) is what spans the child; the lock is released the instant
/// the count is adjusted. So nothing holds a std `Mutex` across the wait, and there is no `.await`
/// here to hold one across in the first place.
struct BdConcurrencyLimiter {
    /// Permits still available. Guarded by its own `Mutex`; `Condvar` wakes a waiter on release.
    available: Mutex<usize>,
    ready: Condvar,
}

impl BdConcurrencyLimiter {
    const fn new(permits: usize) -> Self {
        Self { available: Mutex::new(permits), ready: Condvar::new() }
    }

    /// Wait for a permit until `deadline`, take it, and hand back an RAII guard that returns it on
    /// drop — or `None` if no permit came free in time.
    ///
    /// The wait is BOUNDED on purpose. An unbounded wait would move the caller's hang from "the bd
    /// subprocess never finishes" (which BD_TIMEOUT already catches) to "no permit ever frees",
    /// defeating the very contract this module documents — a wedged store must surface as a typed
    /// error, never a hung caller. `run_cmd_until` passes the SAME deadline it uses for the
    /// subprocess, so a call's TOTAL wall clock (queue + run) stays inside the caller's `timeout`.
    ///
    /// `wait_timeout_while` re-checks the predicate across spurious wakeups; on return, a non-zero
    /// count means a permit is ours to take, and a still-zero count means the deadline elapsed.
    /// `unwrap_or_else(PoisonError::into_inner)` rather than `unwrap`: a bd call that panicked while
    /// holding the brief bookkeeping lock must not wedge every future bd call behind a poisoned
    /// mutex — the counter is a plain integer, so proceeding with it is safe.
    fn acquire_by(&self, deadline: Instant) -> Option<BdPermit<'_>> {
        let available = self.available.lock().unwrap_or_else(|e| e.into_inner());
        let wait = deadline.saturating_duration_since(Instant::now());
        let (mut available, _timed_out) = self
            .ready
            .wait_timeout_while(available, wait, |n| *n == 0)
            .unwrap_or_else(|e| e.into_inner());
        if *available == 0 {
            return None;
        }
        *available -= 1;
        Some(BdPermit { limiter: self })
    }

    fn release(&self) {
        let mut available = self.available.lock().unwrap_or_else(|e| e.into_inner());
        *available += 1;
        // Drop the lock before signalling so the woken waiter does not immediately re-block on it.
        drop(available);
        self.ready.notify_one();
    }
}

/// Held for the lifetime of one bd subprocess; releases its permit on drop, so EVERY return path out
/// of `run_cmd_until` — success, timeout, spawn failure, an undrainable pipe — gives the permit back
/// without a manual release at each `return`.
struct BdPermit<'a> {
    limiter: &'a BdConcurrencyLimiter,
}

impl Drop for BdPermit<'_> {
    fn drop(&mut self) {
        self.limiter.release();
    }
}

/// The one process-wide limiter every bd child passes through. `Mutex::new`/`Condvar::new` are
/// const, so this needs no `OnceLock` lazy init.
///
/// Production uses `BD_MAX_CONCURRENT`. The `cfg(test)` build raises it, because this crate's own
/// suite runs many real-bd integration tests IN PARALLEL (`create_then_close_round_trips`, the fold
/// tests, `notes.rs`'s round-trips), each holding a permit through a slow cold Dolt open — at a cap
/// of 2 they would starve one another into spurious permit timeouts now that the wait is bounded.
/// The cap ITSELF is proven independently, on a dedicated fresh `BdConcurrencyLimiter::new(
/// BD_MAX_CONCURRENT)` in `run_cmd_until_never_runs_more_children_than_the_permit_allows`, so
/// loosening the shared instance here costs no coverage of the bound.
#[cfg(not(test))]
static BD_LIMITER: BdConcurrencyLimiter = BdConcurrencyLimiter::new(BD_MAX_CONCURRENT);
#[cfg(test)]
static BD_LIMITER: BdConcurrencyLimiter = BdConcurrencyLimiter::new(64);

/// Whether a child of `program` CONTENDS for the shared Dolt store — i.e. it is the bd binary
/// `bd_path` resolved to — and so must take a permit. PURE, with the resolved bd path passed in.
///
/// Split out from `contends_for_store` precisely so BOTH branches are testable WITHOUT bd installed:
/// CI has no bd, so a decision that reached `cached_bd_path()` directly could only ever assert the
/// FALSE branch there, and a mutation flipping it to always-`false` — which silently restores the P0
/// poll convoy — would stay green. That is the "defaulted seam" the repo contract warns about. With
/// the bd path as a parameter, `should_bound_is_true_only_for_the_resolved_bd_binary` pins the true
/// branch on every machine.
///
/// `run_cmd_timed` is deliberately program-agnostic and is the shared runner for children that are
/// NOT bd — most importantly `bead_dup`'s `scripts/bead-dup-check.sh`, the filing-time dedupe
/// scanner, which by `docs/bead-dedupe-contract.md` reads a cached TSV in ~1s and never touches the
/// Dolt lock, PRECISELY so it can sit on the create hot path. Making it wait behind bd traffic for a
/// permit it needs for nothing would add the very latency the cap exists to remove. When bd is not
/// installed `bd_path` is `None`, so nothing is gated; correct, because with no bd there are no bd
/// children to contend in the first place.
fn should_bound(program: &str, bd_path: Option<&str>) -> bool {
    bd_path == Some(program)
}

/// `should_bound` against the resolved bd binary — the exact string `run_bd_timed` and
/// `notes::run_bd` pass, so every real bd call is gated while the scanner and tests' `/bin/sh` are
/// not.
fn contends_for_store(program: &str) -> bool {
    should_bound(program, cached_bd_path().as_deref())
}

/// Whether enough of the caller's budget survived the permit wait to be worth spawning bd. Pure, so
/// the floor is testable without racing a permit free exactly at a deadline.
fn enough_budget_to_run(remaining: Duration) -> bool {
    remaining >= MIN_RUN_BUDGET_AFTER_QUEUE
}

/// The typed error for "a permit never came free within budget". `StoreBusy`, deliberately NOT
/// `Timeout`, and that KIND is load-bearing: `notes::describe_bd_failure` reads a `Timeout` with no
/// exit code as the KILL path — "bd was still running, so whether the write landed is UNKNOWN; do not
/// retry blindly." Here bd was NEVER SPAWNED, so nothing was written and the honest remedy is the
/// opposite: retry, nothing ran. `StoreBusy` already means exactly that ("retry unchanged in a
/// moment; nothing about the request was wrong"), and `describe_bd_failure` passes a non-`Timeout`
/// message through verbatim, so the user is told the truth. One definition, shared by the "no permit
/// at all" and "permit came too late to use" branches.
pub(crate) fn queue_saturated(timeout: Duration) -> BeadsError {
    BeadsError::new(
        BeadsErrorKind::StoreBusy,
        format!(
            "bd was not started within {}s — the bd concurrency limit stayed saturated (the store is contended), so nothing was run and nothing was written; retrying in a moment is safe",
            timeout.as_secs()
        ),
    )
}

/// The runner every bd caller shares. Selects the store permit — the process-wide `BD_LIMITER` for
/// bd children, none for anything else (see `contends_for_store`) — and delegates.
///
/// `pub(crate)` so `notes::run_bd` delegates here rather than growing a SECOND timeout
/// implementation. The subtleties in `run_cmd_until` (drain threads, kill-on-expiry, the deliberate
/// refusal to touch the readers on the timeout path, the bounded permit wait) are the whole reason a
/// second one would be wrong: each is a hang this already survives, and a re-implementation would
/// have to rediscover all of them.
pub(crate) fn run_cmd_timed(
    program: &str,
    project_path: &str,
    args: &[String],
    timeout: Duration,
    env: ChildEnv<'_>,
) -> Result<BdOutput, BeadsError> {
    let limiter = if contends_for_store(program) { Some(&BD_LIMITER) } else { None };
    run_cmd_until(limiter, program, project_path, args, timeout, env)
}

/// The runner proper, with the program AND the limiter parameters so the timeout behaviour and the
/// concurrency bound are both testable without a real bd: a test drives it with a FRESH
/// `BdConcurrencyLimiter` and its own `/bin/sh`, which exercises the real acquire/hold/release path
/// while touching neither the process-wide `BD_LIMITER` nor any bd — so it cannot perturb, or be
/// perturbed by, the other tests sharing this binary.
///
/// The child is killed on timeout (std's `Child::kill`, so this stays portable — `libc` is
/// unix-gated in Cargo.toml). Output is drained on threads so a child that fills a pipe buffer
/// cannot deadlock against our own wait, and the wait on those threads is itself bounded — see
/// READER_DRAIN_GRACE.
///
/// ONE DEADLINE bounds the whole call. It is computed once, up front, and used for BOTH the permit
/// wait and the subprocess wait, so a caller's TOTAL wall clock — however the time splits between
/// queueing for a permit and running bd — never exceeds its `timeout`. That is what keeps the
/// module's contract true (a wedged subprocess surfaces as `Timeout`, a saturated queue as `StoreBusy`, never a hung
/// caller) now that a permit sits in front of the spawn. The wait is a plain blocking wait: callers
/// already arrive on a blocking-pool thread (or a test thread), never on a tokio worker.
fn run_cmd_until(
    limiter: Option<&BdConcurrencyLimiter>,
    program: &str,
    project_path: &str,
    args: &[String],
    timeout: Duration,
    env: ChildEnv<'_>,
) -> Result<BdOutput, BeadsError> {
    require_project_dir(project_path)?;

    // The single budget for this call: permit wait AND subprocess share it, so the total is bounded.
    let deadline = Instant::now() + timeout;

    // Bound concurrent bd/Dolt children. Held until this fn returns, covering spawn, wait, and drain.
    // A saturated store that never frees a permit within budget is a typed StoreBusy error, not a hang.
    let _permit = match limiter {
        Some(l) => {
            let permit = l.acquire_by(deadline).ok_or_else(|| queue_saturated(timeout))?;
            // If queueing ate nearly the whole budget, do NOT spawn: a child started with a sliver
            // left is SIGKILLed on the next poll tick after paying a cold Dolt open for nothing, and
            // for a mutation that mid-startup kill re-opens the ambiguous-write window. It would also
            // report "bd did not finish within Ns" — mislabelling a queue-dominated call as a wedged
            // bd. Report the queue-saturation StoreBusy instead, so the diagnosis points at contention.
            if !enough_budget_to_run(deadline.saturating_duration_since(Instant::now())) {
                return Err(queue_saturated(timeout));
            }
            Some(permit)
        }
        None => None,
    };

    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(project_path)
        .env("PATH", bd_exec_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| {
        // The project root was checked above, so a NotFound here is the resolved binary having gone
        // away (bd uninstalled mid-session — the resolver caches positive hits): the caller's remedy
        // is to install, not to retry. Anything else (permissions, ENOMEM, exec format) is an
        // environment failure and must NOT be reported as a missing binary.
        if e.kind() == std::io::ErrorKind::NotFound {
            BeadsError::new(
                BeadsErrorKind::BinaryNotFound,
                format!("{program} could not be executed: {e} — reinstall beads or add `bd` to your PATH"),
            )
        } else {
            BeadsError::new(BeadsErrorKind::BdFailed, format!("failed to run {program}: {e}"))
        }
    })?;

    // Drain both pipes on their own threads. A child writing more than a pipe buffer (64 KB) blocks
    // until someone reads, and `bd list` over this repo emits ~2.9 MB — polling try_wait() without
    // draining would deadlock every large query.
    let out_rx = drain(child.stdout.take());
    let err_rx = drain(child.stderr.take());

    // Reuse the single `deadline` computed before the permit wait, so queue time counts against the
    // caller's budget too — never a fresh `timeout` here, which would let the total exceed it.
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if Instant::now() >= deadline {
                    child.kill().ok();
                    child.wait().ok();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                child.kill().ok();
                return Err(BeadsError::new(
                    BeadsErrorKind::BdFailed,
                    format!("failed while waiting on bd: {e}"),
                ));
            }
        }
    };

    // On TIMEOUT, return immediately and never touch the readers: the whole point of the timeout is
    // that this thread comes back, and a grandchild holding the pipes means the readers may never
    // return at all. They are left detached and finish when that grandchild does.
    let Some(status) = status else {
        // Name the BUDGET, not the child's runtime: this string is grepped operationally by
        // scripts/bd-contention-bench.sh, session-beads-gc.sh, the bd-timeout-ladder test and the
        // notes.rs describe_bd_failure fixtures. A runtime-based message truncated sub-second kills
        // to "bd ran 0s" (colliding with the never-spawned queue_saturated copy) and dropped the
        // greppable bound — reverted (roborev 67767/67768). Queue time counts toward the budget by
        // design (one shared deadline), so "within {timeout}s" is the honest, stable phrasing.
        return Err(BeadsError::new(
            BeadsErrorKind::Timeout,
            format!("bd did not finish within {}s and was terminated", timeout.as_secs()),
        ));
    };

    // The child is reaped, so its own write ends are closed and the readers should be at EOF —
    // unless a grandchild inherited them. Bound the wait either way, and report a stdout we could
    // not read as an error: silently substituting an empty body would look to `parse_bead_rows`
    // like a legitimately empty result set, i.e. a query answering "no beads" for a wedged pipe.
    let stdout = out_rx.recv_timeout(READER_DRAIN_GRACE).map_err(|_| {
        BeadsError::with_code(
            BeadsErrorKind::Timeout,
            "bd exited but its output pipe stayed open (a background child still holds it), so its output could not be read",
            status.code(),
        )
    })?;
    // stderr is diagnostic only; an undrainable one degrades to empty rather than losing the run.
    let stderr = err_rx.recv_timeout(READER_DRAIN_GRACE).unwrap_or_default();

    Ok(BdOutput {
        status: status.code(),
        success: status.success(),
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
    })
}

/// Decide whether a completed bd run is usable, FOR A CALLER THAT GOES ON TO PARSE THE OUTPUT.
///
/// Non-zero exit is NOT automatically fatal here: bd writes its `{"error": …}` payload to stdout,
/// and `parse_bead_rows` turns that into a precise typed error. So we only fail when the exit was
/// non-zero AND stdout carries nothing parseable — in which case stderr is the only diagnosis
/// available. Pure, so the branch ordering is testable without a bd.
///
/// That deferral is ONLY sound when a parse actually follows. A mutation has nothing downstream to
/// parse, so it must not use this — see `ack_outcome`.
fn check_run(out: &BdOutput) -> Result<(), BeadsError> {
    if out.success {
        return Ok(());
    }
    let has_json = out.stdout.trim_start().starts_with('{') || out.stdout.trim_start().starts_with('[');
    if has_json {
        return Ok(());
    }
    let msg = if !out.stderr.trim().is_empty() {
        out.stderr.trim()
    } else if !out.stdout.trim().is_empty() {
        out.stdout.trim()
    } else {
        "bd exited non-zero with no output"
    };
    Err(classify_bd_message(msg, out.status))
}

/// Run bd and return its stdout, applying `check_run`. The choke point every READ goes through; its
/// caller is always a parser, which is what makes `check_run`'s deferral safe.
fn bd_stdout(project_path: &str, args: &[String], env: ChildEnv<'_>) -> Result<String, BeadsError> {
    bd_stdout_within(project_path, args, BD_TIMEOUT, env)
}

/// `bd_stdout` with an explicit budget, for the one read that must fit INSIDE another call's.
/// Everything else goes through `bd_stdout` and gets `BD_TIMEOUT`; this exists so the confirmation
/// probe can be bounded separately rather than by declaring a second default anywhere.
fn bd_stdout_within(
    project_path: &str,
    args: &[String],
    timeout: Duration,
    env: ChildEnv<'_>,
) -> Result<String, BeadsError> {
    let out = run_bd_timed(project_path, args, timeout, env)?;
    check_run(&out)?;
    Ok(out.stdout)
}

/// `bd_stdout_within` that BYPASSES the concurrency limiter. ONLY for the post-create confirmation
/// probe: it is a single-id read against the store the create just opened, and forcing it to
/// re-queue for a permit is exactly what would defeat it under the contention it exists to detect.
/// `confirm_written` fails OPEN on a probe that could not run (see its doc), so a permit-starved
/// probe would silently report an unverified create as filed — reintroducing the write-drop this
/// guard exists to catch, precisely when the store is busiest. One extra quick read beyond the cap
/// is a negligible price; creates are user-initiated and rare (see `create_bead`).
fn bd_stdout_unlimited_within(
    project_path: &str,
    args: &[String],
    timeout: Duration,
    env: ChildEnv<'_>,
) -> Result<String, BeadsError> {
    let out = run_bd_unlimited(project_path, args, timeout, env)?;
    check_run(&out)?;
    Ok(out.stdout)
}

/// Decide whether a MUTATION was ACKNOWLEDGED. The choke point every write goes through.
///
/// The distinction from `check_run` is the whole point: nothing downstream of a mutation parses, so
/// this is the only place bd's `{"error": …}` payload can ever be seen. Deferring to a parser that
/// does not exist reports a bead as closed that was never closed — for a caller that then TELLS A
/// HUMAN it closed the bead, that is the worst failure this surface has.
///
/// So the payload is detected by CONTENT, not by exit status (bd emits it with a non-zero exit for
/// some subcommands and with exit ZERO for others — see the note on `parse_bead_rows`), AND a
/// non-zero exit with no payload is still a failure. Pure, so both branches are testable without bd.
fn ack_outcome(out: &BdOutput) -> Result<(), BeadsError> {
    let body = out.stdout.trim();
    if body.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<Value>(body) {
            if let Some(msg) = error_payload(&v) {
                return Err(classify_bd_message(&msg, out.status));
            }
        }
    }
    if out.success {
        return Ok(());
    }
    let msg = if !out.stderr.trim().is_empty() {
        out.stderr.trim()
    } else if !body.is_empty() {
        body
    } else {
        "bd exited non-zero with no output"
    };
    Err(classify_bd_message(msg, out.status))
}

/// Run a mutating bd command and confirm it took effect.
fn bd_ack(project_path: &str, args: &[String], env: ChildEnv<'_>) -> Result<(), BeadsError> {
    ack_outcome(&run_bd_timed(project_path, args, BD_TIMEOUT, env)?)
}

/// Reject an id that bd would parse as a flag, before shelling out. Shares `notes::valid_bead_id`
/// so both surfaces enforce the same charset.
fn require_id(id: &str) -> Result<(), BeadsError> {
    if valid_bead_id(id) {
        return Ok(());
    }
    Err(BeadsError::new(BeadsErrorKind::InvalidInput, format!("invalid bead id: {id}")))
}

/// Run a blocking bd job on the blocking pool. Every command funnels through this so a slow bd
/// never occupies the async runtime.
async fn blocking<T, F>(f: F) -> Result<T, BeadsError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, BeadsError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| BeadsError::new(BeadsErrorKind::BdFailed, format!("bd task panicked: {e}")))?
}

// ── Operations ────────────────────────────────────────────────────────────────────────────────
//
// The bodies live here, separate from the `#[tauri::command]` wrappers below, and every one takes a
// `ChildEnv`. Two reasons: the round-trip test can drive the REAL bodies (so a mutation that stops
// checking its acknowledgement is caught by a test, not by a human noticing a bead did not close),
// and it can pass its git guard to the child instead of mutating this process's environment.

fn query_beads(project_path: &str, q: &BeadQuery, env: ChildEnv<'_>) -> Result<BeadPage, BeadsError> {
    let rows = parse_bead_rows(&bd_stdout(project_path, &build_query_args(q), env)?)?;
    Ok(paginate(rows, q.limit))
}

fn detail_bead(project_path: &str, id: &str, env: ChildEnv<'_>) -> Result<BeadDetail, BeadsError> {
    require_id(id)?;
    // ONE `bd show`, read three ways out of the same stdout — the summary, the uncut description,
    // AND the comment thread. `--include-comments` rides here and ONLY here: a second invocation is
    // the wrong way to get any of it, because each `bd show` is a cold-Dolt-open candidate with the
    // full BD_TIMEOUT budget (doubling worst-case latency) and two reads can straddle a concurrent
    // edit and hand back parts that do not belong together. The flag stays off the board's 5s list
    // poll, which must not pull every bead's whole thread against a contended store on every tick.
    let shown = bd_stdout(
        project_path,
        &["show".into(), id.to_string(), "--json".into(), "--include-comments".into()],
        env,
    )?;
    let bead = parse_bead_rows(&shown)?.into_iter().next().ok_or_else(|| {
        BeadsError::new(BeadsErrorKind::InvalidInput, format!("no bead found with id {id}"))
    })?;
    let full_description =
        full_description_from(&shown).unwrap_or_else(|| bead.description.clone());
    let comments = comments_from(&shown);

    // Children and links are ENRICHMENT: a bead whose neighbourhood fails to load is still
    // worth returning, so these degrade to empty rather than failing the whole detail read.
    let children = child_page(project_path, id, env);
    let (dependencies, dependents, links_truncated) = match bd_stdout(
        project_path,
        &["dep".into(), "list".into(), id.to_string(), "--json".into()],
        env,
    ) {
        Ok(s) => parse_links(&s, id),
        Err(_) => (Vec::new(), Vec::new(), false),
    };

    Ok(BeadDetail {
        bead,
        full_description,
        children,
        dependencies,
        dependents,
        comments,
        links_truncated,
    })
}

/// The comment thread out of a raw `bd show --json --include-comments` body. Pure, and TOLERANT: a
/// bd build that drops the `comments` key (or one comment missing a `text`) degrades to fewer
/// comments rather than failing the whole detail read — comments are enrichment, exactly like the
/// child/link neighbourhood above. bd reports each as `{id, issue_id, author, text, created_at}`.
fn comments_from(stdout: &str) -> Vec<BeadComment> {
    let Ok(parsed) = serde_json::from_str::<Value>(stdout.trim()) else {
        return Vec::new();
    };
    let row = match &parsed {
        Value::Array(a) => match a.first() {
            Some(r) => r,
            None => return Vec::new(),
        },
        other => other,
    };
    let Some(arr) = row.get("comments").and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|c| {
            // `text` is the one load-bearing field: a comment with none is not renderable, so it is
            // dropped rather than shown blank. `id` falls back to empty (bd always supplies it).
            let text = as_str(c.get("text"))?;
            Some(BeadComment {
                id: as_str(c.get("id")).unwrap_or_default(),
                author: as_str(c.get("author")),
                text,
                created_at: as_str(c.get("created_at")),
            })
        })
        .collect()
}

/// The UNCUT `description` out of a raw `bd show --json` body. Pure — the counterpart to
/// `normalize_bead`, which excerpts the same field for the summary.
fn full_description_from(stdout: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(stdout.trim()).ok()?;
    let row = match &parsed {
        Value::Array(a) => a.first()?,
        other => other,
    };
    as_str(row.get("description")).or(Some(String::new()))
}

/// Children of `id` as a bounded page. Never fails the caller — an unreadable child list is
/// reported as an empty page.
fn child_page(project_path: &str, id: &str, env: ChildEnv<'_>) -> BeadPage {
    let q = BeadQuery { parent: Some(id.to_string()), include_closed: Some(true), ..Default::default() };
    match query_beads(project_path, &q, env) {
        Ok(page) => page,
        Err(_) => BeadPage { limit: DEFAULT_LIMIT, ..Default::default() },
    }
}

/// bd's own wording for "there is no such issue", as it arrives in an `{"error": …}` payload from
/// `bd show`. The ONE bd failure that PROVES a row is absent; every other failure means the probe
/// itself was broken. Pure.
fn is_missing_issue(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("no issue") && lower.contains("matching")
}

/// The error a confirmed write drop produces. Says what was lost, so a caller that already told a
/// human "filed <id>" can retract it instead of leaving them with an id that names nothing.
fn write_dropped(id: &str) -> BeadsError {
    BeadsError::new(
        BeadsErrorKind::BadOutput,
        format!(
            "bd reported creating {id}, but {id} does not read back from the work graph — the write did not land, so nothing was filed"
        ),
    )
}

/// Decide, from a `bd show <id> --json` PROBE, whether the create actually landed.
///
/// Pure, and it takes the probe's `Result` rather than running it, so BOTH interesting branches —
/// a genuine drop and an unreadable probe — are testable without a bd that can lose a write on cue.
///
/// The asymmetry is deliberate: only a probe that RAN CLEANLY and found no matching row (or bd's own
/// no-such-issue payload) is evidence of a drop. A probe that could not run — bd missing, killed on
/// BD_TIMEOUT, no workspace, unparseable output — proves nothing about the row, and inventing a
/// failure there would report a create that DID land as lost. Unproven fails OPEN, absent fails LOUD.
fn confirm_written(probe: Result<String, BeadsError>, id: &str) -> Result<(), BeadsError> {
    let Ok(body) = probe else { return Ok(()) };
    if body.trim().is_empty() {
        return Ok(());
    }
    match parse_bead_rows(&body) {
        Ok(rows) if rows.iter().any(|b| b.id == id) => Ok(()),
        Ok(_) => Err(write_dropped(id)),
        Err(e) if is_missing_issue(&e.message) => Err(write_dropped(id)),
        Err(_) => Ok(()),
    }
}

/// Create a bead, and CONFIRM it is in the store before reporting success.
///
/// `bd create` echoing back a row is not proof the row persisted. The work graph is one shared
/// embedded Dolt database — every worktree in this repo resolves `.beads/` through `git-common-dir`
/// to the same store, and the desktop board re-reads it every 5s — and a create under that
/// contention has been observed to return an id for a bead that never appeared in `bd list`: a
/// silent WRITE DROP with no error anywhere. `beads_create`'s callers TELL A HUMAN the item was
/// filed, so passing that back unverified is the same class of lie `ack_outcome` closed for failed
/// mutations, just arriving through a bd exit of ZERO instead of non-zero.
///
/// Cost is one extra `bd show` per create, bounded by `BD_CONFIRM_PROBE_TIMEOUT` (10s) rather than
/// the full `BD_TIMEOUT` — the sum of the two is what a concierge bridge call has to fit inside, and
/// this is a single-id read against a store the create just opened, so the cold-Dolt-open argument
/// that earns `BD_TIMEOUT` its 30s does not apply to it. Creates are user-initiated and rare;
/// silently losing one is not worth saving that read.
///
/// NOT a retry. Re-running `bd create` on a row we cannot see would duplicate the item whenever the
/// first write actually landed and only the probe was wrong, and a duplicated work item is worse
/// than an honest refusal — the caller can retry deliberately once it knows nothing was filed.
fn create_bead(project_path: &str, bead: &NewBead, env: ChildEnv<'_>) -> Result<BeadSummary, BeadsError> {
    if bead.title.trim().is_empty() {
        return Err(BeadsError::new(BeadsErrorKind::InvalidInput, "title must not be empty"));
    }
    if let Some(p) = bead.parent.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        require_id(p)?;
    }
    // File-time duplicate detection, gated by `bead_dup`'s ARGV-LEVEL SKIP LIST. A fold returns the
    // EXISTING bead's row — `bd show --json` and `bd create --json` emit the same object, so
    // `normalize_bead` handles it unchanged and the caller sees a `BeadSummary` either way. Every
    // uncertainty inside `fold_or_create` answers `None` and falls through to the create below.
    if let Some(row) = crate::bead_dup::fold_or_create(
        project_path,
        &bead.title,
        bead.description.as_deref().unwrap_or(""),
        bead.labels.as_deref().unwrap_or(""),
        bead.issue_type.as_deref().unwrap_or(""),
        bead.parent.as_deref().unwrap_or(""),
        env,
    ) {
        return Ok(normalize_bead(&row));
    }
    let rows = parse_bead_rows(&bd_stdout(project_path, &build_create_args(bead), env)?)?;
    let created = rows
        .into_iter()
        .next()
        .ok_or_else(|| BeadsError::new(BeadsErrorKind::BadOutput, "bd create returned no bead"))?;
    // An id we cannot pass back to bd is unusable to the caller AND unprobeable here, so it is a
    // failed create rather than something to hand on and confirm later.
    if !valid_bead_id(&created.id) {
        return Err(BeadsError::new(
            BeadsErrorKind::BadOutput,
            format!("bd create returned an unusable bead id: {}", created.id),
        ));
    }
    // BOUNDED SEPARATELY, and shorter — see `BD_CONFIRM_PROBE_TIMEOUT`. Two full budgets in one
    // command exceed the concierge bridge's own ceiling, which turns a CONFIRMED create into a
    // reported timeout. It also BYPASSES the concurrency limiter (`bd_stdout_unlimited_within`): a
    // probe that re-queued for a permit would be starved out under the very contention it exists to
    // detect, and `confirm_written` fails open on a probe that could not run — so it would report an
    // unverified create as filed exactly when the store is busiest.
    let probe = bd_stdout_unlimited_within(
        project_path,
        &["show".into(), created.id.clone(), "--json".into()],
        BD_CONFIRM_PROBE_TIMEOUT,
        env,
    );
    confirm_written(probe, &created.id)?;
    Ok(created)
}

fn update_bead(
    project_path: &str,
    id: &str,
    patch: &BeadPatch,
    env: ChildEnv<'_>,
) -> Result<(), BeadsError> {
    require_id(id)?;
    let args = build_update_args(id, patch).ok_or_else(|| {
        BeadsError::new(
            BeadsErrorKind::InvalidInput,
            "patch is empty — set at least one of status, priority, assignee",
        )
    })?;
    bd_ack(project_path, &args, env)
}

/// Re-parent a SET of beads onto one epic — or off any epic, when `parent` is empty.
///
/// The write half of epic membership. bd has supported this the whole time; the app had no path to
/// it, so beads filed weeks apart could never be gathered under the theme that connects them once
/// it became clear (bead `sparkle-xelans.2`, founder: *"I want the individual beads to be able to
/// be consolidated into a larger epic"*).
///
/// EVERY ID IS VALIDATED BEFORE ANYTHING IS SENT, which is a stronger guarantee than validating as
/// we go: a bad id in the middle of the list would otherwise be discovered only after bd had
/// already been handed the whole batch. `parent` is validated too whenever it is non-empty — an
/// empty one is the unparent path and has no id to check.
///
/// A bead may not be its own parent. bd does not forbid the cycle (`descendantsOf` in
/// `services/beads.ts` is cycle-safe precisely because of that), so a self-parent would be accepted
/// and would then render as an epic containing itself. Refused here rather than downstream, where
/// it is a data repair rather than a rejected input.
fn reparent_beads(
    project_path: &str,
    ids: &[String],
    parent: &str,
    env: ChildEnv<'_>,
) -> Result<(), BeadsError> {
    if ids.is_empty() {
        return Err(BeadsError::new(
            BeadsErrorKind::InvalidInput,
            "no beads selected — nothing to re-parent",
        ));
    }
    for id in ids {
        require_id(id)?;
    }
    let parent = parent.trim();
    if !parent.is_empty() {
        require_id(parent)?;
        if let Some(hit) = ids.iter().find(|id| id.as_str() == parent) {
            return Err(BeadsError::new(
                BeadsErrorKind::InvalidInput,
                format!("a bead cannot be its own parent: {hit}"),
            ));
        }
    }
    bd_ack(project_path, &build_reparent_args(ids, parent), env)
}

fn close_bead(project_path: &str, id: &str, reason: &str, env: ChildEnv<'_>) -> Result<(), BeadsError> {
    require_id(id)?;
    bd_ack(project_path, &build_close_args(id, reason), env)
}

fn comment_bead(project_path: &str, id: &str, text: &str, env: ChildEnv<'_>) -> Result<(), BeadsError> {
    require_id(id)?;
    if text.trim().is_empty() {
        return Err(BeadsError::new(BeadsErrorKind::InvalidInput, "comment text must not be empty"));
    }
    bd_ack(project_path, &build_comment_args(id, text), env)
}

/// Post a comment on a bead, for callers OUTSIDE the `beads_comment` command (the @mention channel,
/// `mention.rs`). Routes through the same `comment_bead` → `build_comment_args` assembly the command
/// uses, so the `--` argument-terminator handling (see `build_comment_args`) is shared rather than
/// re-derived — a hand-rolled copy in another module is exactly the bug that doc warns about.
pub(crate) fn comment_for_mention(project_path: &str, id: &str, text: &str) -> Result<(), BeadsError> {
    comment_bead(project_path, id, text, NO_EXTRA_ENV)
}

/// Read a bead's comment thread (oldest-first), for the @mention channel's ACK/round detection.
/// Reuses `detail_bead`'s `bd show … --include-comments` path — the only reader that carries the
/// comment thread — so the two cannot drift on how a comment is parsed.
pub(crate) fn comments_for_mention(project_path: &str, id: &str) -> Result<Vec<BeadComment>, BeadsError> {
    Ok(detail_bead(project_path, id, NO_EXTRA_ENV)?.comments)
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────

/// Query the work graph. Returns a BOUNDED page — see the module note on the cap.
#[tauri::command]
pub async fn beads_query(project_path: String, query: BeadQuery) -> Result<BeadPage, BeadsError> {
    blocking(move || query_beads(&project_path, &query, NO_EXTRA_ENV)).await
}

/// Show one bead with its full description, its children, and its dependency edges.
#[tauri::command]
pub async fn beads_detail(project_path: String, id: String) -> Result<BeadDetail, BeadsError> {
    blocking(move || detail_bead(&project_path, &id, NO_EXTRA_ENV)).await
}

/// Create a bead. Returns the created bead.
#[tauri::command]
pub async fn beads_create(project_path: String, bead: NewBead) -> Result<BeadSummary, BeadsError> {
    blocking(move || create_bead(&project_path, &bead, NO_EXTRA_ENV)).await
}

/// Update status / priority / assignee. Only the provided fields are written.
#[tauri::command]
pub async fn beads_update(
    project_path: String,
    id: String,
    patch: BeadPatch,
) -> Result<(), BeadsError> {
    blocking(move || update_bead(&project_path, &id, &patch, NO_EXTRA_ENV)).await
}

/// Move a SET of beads under one epic in a single `bd update`, or off their epic when `parent` is
/// the empty string. See [`reparent_beads`]; the batching is the contract, not a shortcut.
#[tauri::command]
pub async fn beads_reparent(
    project_path: String,
    ids: Vec<String>,
    parent: String,
) -> Result<(), BeadsError> {
    blocking(move || reparent_beads(&project_path, &ids, &parent, NO_EXTRA_ENV)).await
}

/// Close a bead with a reason. The reason is bd's own close-reason field, not a comment.
#[tauri::command]
pub async fn beads_close(
    project_path: String,
    id: String,
    reason: String,
) -> Result<(), BeadsError> {
    blocking(move || close_bead(&project_path, &id, &reason, NO_EXTRA_ENV)).await
}

/// Add a comment to a bead.
#[tauri::command]
pub async fn beads_comment(
    project_path: String,
    id: String,
    text: String,
) -> Result<(), BeadsError> {
    blocking(move || comment_bead(&project_path, &id, &text, NO_EXTRA_ENV)).await
}

// ── Seams for `epic_prd.rs` ───────────────────────────────────────────────────────────────────
//
// `epic_prd` writes and reads ONE bd metadata key and lives in its own module (bead
// `sparkle-xelans.5`), but it must reach bd exactly the way every command here does — through the
// same concurrency permit, the same BD_TIMEOUT, the same typed error classification and the same
// blocking pool. Hand-rolling any of that in another module is how a second, unbounded bd path
// gets built; these three wrappers hand it the real ones instead. Thin and additive on purpose:
// they widen visibility without moving a line of the code above them.

/// [`bd_stdout`] for `epic_prd`'s read.
pub(crate) fn bd_stdout_for_epic_prd(
    project_path: &str,
    args: &[String],
    env: ChildEnv<'_>,
) -> Result<String, BeadsError> {
    bd_stdout(project_path, args, env)
}

/// [`bd_ack`] for `epic_prd`'s write — checks bd's acknowledgement rather than only its exit code.
pub(crate) fn bd_ack_for_epic_prd(
    project_path: &str,
    args: &[String],
    env: ChildEnv<'_>,
) -> Result<(), BeadsError> {
    bd_ack(project_path, args, env)
}

/// [`require_id`] for `epic_prd`, so both surfaces reject a flag-like id on the SAME charset.
pub(crate) fn require_id_for_epic_prd(id: &str) -> Result<(), BeadsError> {
    require_id(id)
}

/// [`blocking`] for `epic_prd`, so its commands never occupy the async runtime either.
pub(crate) async fn blocking_for_epic_prd<T, F>(f: F) -> Result<T, BeadsError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, BeadsError> + Send + 'static,
{
    blocking(f).await
}

#[cfg(test)]
// `pub(crate)` so `notes.rs`'s tests reuse `TempWorkspace` instead of standing up a SECOND
// throwaway-bd harness. The two roborev guards in its doc are easy to get subtly wrong twice, and
// a temp repo missing them orphans review rows for a directory deleted seconds later.
pub(crate) mod tests {
    use super::*;

    /// A two-row fixture in bd's real `list --json` shape (captured from `bd list --json` against
    /// this repo, trimmed). Deliberately includes the key drift the normalizer tolerates.
    const LIST_FIXTURE: &str = r#"[
      {
        "id": "sparkle-8jfx",
        "title": "[bug] spawn_worker re-dispatches the PREVIOUS task",
        "description": "Observed live 2026-07-24 while orchestrating the epic — three calls were issued.",
        "status": "open",
        "priority": 0,
        "issue_type": "bug",
        "owner": "drodio@gmail.com",
        "created_at": "2026-07-24T22:23:35Z",
        "updated_at": "2026-07-24T22:23:35Z",
        "dependency_count": 2,
        "dependent_count": 1,
        "comment_count": 1,
        "labels": ["orchestrator", "p0"]
      },
      {
        "id": "sparkle-4562",
        "title": "EPIC: Concierge Mode",
        "status": "in_progress",
        "priority": 1,
        "issue_type": "epic",
        "parent": "sparkle-0001",
        "created_at": "2026-07-24T04:56:49Z"
      }
    ]"#;

    // ── Parsing a query result from a fixture ────────────────────────────────────────────────

    #[test]
    fn parses_typed_rows_from_a_bd_list_fixture() {
        let rows = parse_bead_rows(LIST_FIXTURE).expect("fixture parses");
        assert_eq!(rows.len(), 2);

        let a = &rows[0];
        assert_eq!(a.id, "sparkle-8jfx");
        assert_eq!(a.status, "open");
        assert_eq!(a.priority, Some(0));
        assert_eq!(a.issue_type.as_deref(), Some("bug"));
        // `owner` is bd's key; the normalizer maps it onto `assignee`.
        assert_eq!(a.assignee.as_deref(), Some("drodio@gmail.com"));
        assert_eq!(a.labels, vec!["orchestrator", "p0"]);
        assert_eq!(a.dependency_count, 2);
        assert_eq!(a.dependent_count, 1);
        assert_eq!(a.comment_count, 1);
        assert!(!a.description_truncated, "short description is not cut");

        let b = &rows[1];
        assert_eq!(b.parent.as_deref(), Some("sparkle-0001"));
        // Missing counts default to 0 rather than failing the parse.
        assert_eq!(b.dependency_count, 0);
        assert_eq!(b.description, "", "a row with no description parses as empty");
        assert_eq!(b.closed_at, None);
    }

    #[test]
    fn parses_a_single_object_as_one_row() {
        // `bd create --json` emits an object, not an array.
        let rows = parse_bead_rows(r#"{"id":"probe-1","title":"t","status":"open"}"#).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "probe-1");
    }

    #[test]
    fn empty_stdout_is_an_empty_result_not_an_error() {
        assert_eq!(parse_bead_rows("").unwrap().len(), 0);
        assert_eq!(parse_bead_rows("   \n ").unwrap().len(), 0);
    }

    #[test]
    fn parses_comments_from_a_show_with_include_comments() {
        // The exact shape `bd show --json --include-comments` emits (captured, trimmed).
        let shown = r#"[
          {
            "id": "sparkle-mzgqt",
            "title": "beads need comments",
            "status": "open",
            "comments": [
              {"id":"c-1","issue_id":"sparkle-mzgqt","author":"DROdio","text":"first note","created_at":"2026-08-12T00:21:39Z"},
              {"id":"c-2","issue_id":"sparkle-mzgqt","text":"authorless still shows"}
            ],
            "comment_count": 2
          }
        ]"#;
        let comments = comments_from(shown);
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].text, "first note");
        assert_eq!(comments[0].author.as_deref(), Some("DROdio"));
        assert_eq!(comments[0].created_at.as_deref(), Some("2026-08-12T00:21:39Z"));
        // A comment missing author/created_at is kept — text is the only load-bearing field.
        assert_eq!(comments[1].text, "authorless still shows");
        assert_eq!(comments[1].author, None);
        assert_eq!(comments[1].created_at, None);
    }

    #[test]
    fn a_show_without_comments_is_an_empty_thread_not_an_error() {
        // `bd show --json` (no --include-comments) has no `comments` key; a textless comment is
        // dropped rather than shown blank. Neither is a parse failure.
        assert!(comments_from(r#"[{"id":"x","status":"open"}]"#).is_empty());
        assert!(comments_from(r#"[{"id":"x","comments":[{"id":"c","author":"a"}]}]"#).is_empty());
        assert!(comments_from("").is_empty());
    }

    #[test]
    fn tolerates_bd_key_drift() {
        // issue_id/state/type/parent_id are the alternate spellings beads.ts already tolerates.
        let rows =
            parse_bead_rows(r#"[{"issue_id":"x-1","state":"closed","type":"chore","parent_id":"x-0"}]"#)
                .unwrap();
        assert_eq!(rows[0].id, "x-1");
        assert_eq!(rows[0].status, "closed");
        assert_eq!(rows[0].issue_type.as_deref(), Some("chore"));
        assert_eq!(rows[0].parent.as_deref(), Some("x-0"));
    }

    // ── A missing / failing bd produces a typed error, never a crash ─────────────────────────

    #[test]
    fn a_missing_bd_binary_is_a_typed_error_not_a_panic() {
        // Drive the real runner in a directory that EXISTS but has no workspace. Whatever happens,
        // the contract is: a typed error, and no panic.
        //
        // (This used to point at a non-existent directory. That is now a different, more specific
        // outcome — see the test below — so the case had to move to a real one to keep testing what
        // it says it tests: bd's own resolution, not the project-path guard in front of it.)
        let args = vec!["list".to_string(), "--json".to_string()];
        let dir = std::env::temp_dir();
        match run_bd_timed(&dir.to_string_lossy(), &args, Duration::from_secs(5), NO_EXTRA_ENV) {
            Err(e) => assert!(
                matches!(
                    e.kind,
                    BeadsErrorKind::BinaryNotFound
                        | BeadsErrorKind::BdFailed
                        | BeadsErrorKind::NoWorkspace
                ),
                "unexpected kind {:?}",
                e.kind
            ),
            // A machine WITH bd installed may still spawn; the point is that it did not panic.
            Ok(_) => {}
        }
    }

    #[test]
    fn a_project_path_that_is_not_a_directory_is_invalid_input_not_a_missing_binary() {
        // `binaryNotFound` tells the caller to install beads and never to retry. A deleted or
        // renamed project root makes `spawn` fail with the same ENOENT a missing binary does, so
        // without the up-front check every one of these was reported as "install beads".
        // Driven through `run_cmd_timed` with a program that always exists, NOT through
        // `run_bd_timed`. The latter resolves the `bd` binary FIRST and returns `BinaryNotFound`
        // when it is absent — so on any machine without beads installed (every CI runner) both
        // assertions below got `BinaryNotFound` and this test failed for a reason that has nothing
        // to do with what it is checking. The property under test is `require_project_dir`, which
        // `run_cmd_timed` applies before it spawns anything, so testing it here is both correct
        // and independent of whether beads happens to be installed.
        let args = vec!["--version".to_string()];
        let e = run_cmd_timed(
            "/bin/echo",
            "/nonexistent-dir-for-sparkle-test",
            &args,
            Duration::from_secs(5),
            NO_EXTRA_ENV,
        )
        .expect_err("a missing project root must not be runnable");
        assert_eq!(e.kind, BeadsErrorKind::InvalidInput);

        // A FILE is not a project root either.
        let file = std::env::temp_dir().join(format!("sparkle-test-beads-notadir-{}", std::process::id()));
        std::fs::write(&file, b"x").expect("write probe file");
        let e = run_cmd_timed(
            "/bin/echo",
            &file.to_string_lossy(),
            &args,
            Duration::from_secs(5),
            NO_EXTRA_ENV,
        )
        .expect_err("a file is not a project root");
        std::fs::remove_file(&file).ok();
        assert_eq!(e.kind, BeadsErrorKind::InvalidInput);
    }

    #[test]
    fn a_timeout_is_honoured_even_when_a_grandchild_holds_the_pipes() {
        // The failure this guards: bd starts a background `dolt sql-server`, and a grandchild that
        // inherited our stdout/stderr WRITE ends keeps them open after we kill the direct child.
        // `read_to_end` then never sees EOF, so an unconditional `join()` on the readers blocks
        // forever — the blocking-pool thread is wedged permanently and BD_TIMEOUT guarantees
        // nothing. `sh -c 'sleep 5 & sleep 5'` reproduces exactly that: the backgrounded sleep
        // inherits the pipes and outlives the shell we kill.
        //
        // Asserted on a WATCHDOG rather than inline, because the bug's symptom is a hang: a plain
        // call here would never return and would take the whole test binary with it.
        //
        // The grandchild must OUTLIVE the watchdog by a wide margin or this test proves nothing —
        // a short-lived one releases the pipe on its own and the broken code returns too, just
        // late. Hence 60s of grandchild against a 3s watchdog against a 300ms timeout; the pid is
        // parked in a file so the test can reap it instead of leaving a stray process behind.
        let pidfile = std::env::temp_dir()
            .join(format!("sparkle-test-beads-pipehold-{}.pid", std::process::id()));
        std::fs::remove_file(&pidfile).ok();
        let script = format!("sleep 60 & echo $! > {} ; sleep 60", pidfile.display());

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let r = run_cmd_timed(
                "/bin/sh",
                ".",
                &["-c".to_string(), script],
                Duration::from_millis(300),
                NO_EXTRA_ENV,
            );
            tx.send(r.map(|_| ())).ok();
        });
        let got = rx.recv_timeout(Duration::from_secs(3));

        // Reap the grandchild before asserting, so a failure does not also leak a process.
        if let Ok(pid) = std::fs::read_to_string(&pidfile) {
            Command::new("kill").arg(pid.trim()).status().ok();
        }
        std::fs::remove_file(&pidfile).ok();

        let got = got
            .expect("run_cmd_timed never returned — it is blocked on a pipe a grandchild still holds");
        let err = got.unwrap_err();
        assert_eq!(err.kind, BeadsErrorKind::Timeout);
        // Guard the kill-path MESSAGE, not just the kind (roborev 67779): this exact phrase is grepped
        // operationally by scripts/bd-contention-bench.sh, session-beads-gc.sh, the bd-timeout-ladder
        // test and the notes.rs describe_bd_failure fixtures. A test, not a code comment, is what keeps
        // production and those consumers from drifting apart (as commit 117ea51 did). Asserts the phrase
        // only, not the number — this test's 300ms budget renders as "0s", while production's is 30s.
        // Guard BOTH ends of the greppable contract (roborev 67798), not just the prefix: the
        // downstream fixtures/scripts key on "within {N}s" AND "terminated". A reword of either end
        // (or swapping the budget for an elapsed-runtime value) reds this.
        assert!(
            err.message.contains("did not finish within"),
            "kill-path message must carry the 'did not finish within Ns' prefix: {}",
            err.message
        );
        assert!(
            err.message.contains("and was terminated"),
            "kill-path message must carry the 'and was terminated' tail: {}",
            err.message
        );
    }

    // ── The bd-concurrency bound ─────────────────────────────────────────────────────────────

    #[test]
    fn the_limiter_admits_exactly_its_permit_count_then_blocks_until_one_is_freed() {
        // The primitive in isolation, on a FRESH limiter so the process-wide `BD_LIMITER` (shared
        // by every other test in this binary) cannot perturb the counts. Two properties:
        //   (1) it hands out exactly N permits at once, and the (N+1)th BLOCKS, and
        //   (2) releasing one wakes the blocked acquirer.
        // Both are false under the obvious mutations: `new(2)` -> `new(usize::MAX)` grants the third
        // immediately and (1) fails; dropping the `Condvar` wake path never resumes and (2) fails.
        let limiter = BdConcurrencyLimiter::new(2);
        let far = || Instant::now() + Duration::from_secs(3600);
        let p1 = limiter.acquire_by(far()).expect("first permit is free");
        let _p2 = limiter.acquire_by(far()).expect("second permit is free");

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|s| {
            s.spawn(|| {
                // A far deadline, so the ONLY thing that can release this is p1 being dropped.
                let _p3 = limiter.acquire_by(far()).expect("third permit after a release");
                tx.send(()).ok();
                // Return immediately, dropping _p3 — the scope must be able to join this thread.
            });

            // Both permits are held here, so the third acquire cannot have completed.
            assert!(
                rx.recv_timeout(Duration::from_millis(250)).is_err(),
                "a third permit was granted while all {BD_MAX_CONCURRENT} were already held",
            );

            // Free one; the blocked acquirer must now proceed.
            drop(p1);
            assert!(
                rx.recv_timeout(Duration::from_secs(2)).is_ok(),
                "releasing a permit did not wake the waiting acquirer",
            );
        });
    }

    #[test]
    fn a_saturated_limiter_times_out_at_its_deadline_instead_of_waiting_forever() {
        // The bounded-wait property that keeps `run_cmd_until`'s TOTAL wall clock inside the caller's
        // timeout: with every permit held, `acquire_by` returns None AT the deadline rather than
        // blocking. Mutate `acquire_by` back to an unbounded wait and this test hangs and is killed —
        // i.e. it can fail. Without the bound, the whole point of BD_TIMEOUT is defeated: a wedged
        // store would move the hang from "the subprocess never finishes" to "no permit ever frees".
        let limiter = BdConcurrencyLimiter::new(1);
        let _held =
            limiter.acquire_by(Instant::now() + Duration::from_secs(3600)).expect("the one permit");

        let start = Instant::now();
        let denied = limiter.acquire_by(Instant::now() + Duration::from_millis(150));
        let waited = start.elapsed();

        assert!(denied.is_none(), "a saturated limiter must time out, not conjure a permit");
        assert!(
            waited >= Duration::from_millis(120),
            "it must wait for its deadline, not return early: {waited:?}",
        );
        assert!(waited < Duration::from_secs(5), "it must not wait far past its deadline: {waited:?}");
    }

    #[test]
    fn should_bound_is_true_only_for_the_resolved_bd_binary() {
        // The gating DECISION, tested purely so BOTH branches are covered WITHOUT bd installed (CI
        // has none). This is the guard against the "defaulted seam": if the only positive assertion
        // sat behind `cached_bd_path()`, a mutation of the decision to always-`false` — which quietly
        // restores the P0 poll convoy — would stay green on CI. Here the true branch is pinned on
        // every machine, and the false branches keep the lock-free scanner and shells unthrottled.
        assert!(should_bound("/opt/homebrew/bin/bd", Some("/opt/homebrew/bin/bd")), "bd must be bounded");
        assert!(!should_bound("/bin/sh", Some("/opt/homebrew/bin/bd")), "a shell must not be bounded");
        assert!(
            !should_bound("scripts/bead-dup-check.sh", Some("/opt/homebrew/bin/bd")),
            "the lock-free dedupe scanner must not be bounded",
        );
        assert!(!should_bound("/opt/homebrew/bin/bd", None), "with no bd resolved, nothing is bounded");
    }

    #[test]
    fn only_the_bd_binary_takes_a_store_permit() {
        // The wiring of `should_bound` to the resolved bd path. The pure decision is proven above;
        // this confirms `contends_for_store` feeds it `cached_bd_path()`.
        assert!(!contends_for_store("/bin/sh"), "a shell does not contend for the store");
        assert!(!contends_for_store("/usr/bin/env"), "a non-bd program does not contend");
        assert!(
            !contends_for_store("scripts/bead-dup-check.sh"),
            "the lock-free dedupe scanner must not take a permit",
        );
        match cached_bd_path() {
            Some(bd) => {
                assert!(contends_for_store(&bd), "the resolved bd binary must take a permit")
            }
            None => assert!(!contends_for_store("bd"), "with no bd resolved, nothing is gated"),
        }
    }

    #[test]
    fn the_cap_wiring_cannot_be_silently_removed() {
        // Two production seams the concurrency fix hangs on are single lines that NO runtime test on
        // a bd-less CI can reach (see `should_bound`'s doc): `run_cmd_timed` selecting the global
        // limiter for bd, and `create_bead`'s probe using the UNLIMITED path. Both are the "a later
        // edit undoes it without noticing" shape `every_mutation_goes_through_the_acknowledged_path`
        // already guards for, so pin them the same way — a source guard that reds if either mutates
        // back. `let limiter = None;` or a limited probe compiles and passes every other test.
        let src = include_str!("beads_cmd.rs");
        let body_of = |sig: &str| -> &str {
            let from = src.find(sig).unwrap_or_else(|| panic!("{sig} still exists"));
            let rest = &src[from..];
            &rest[..rest.find("\n}\n").expect("the fn body ends")]
        };

        // run_cmd_timed must gate the process-wide BD_LIMITER on contends_for_store; replacing that
        // with `let limiter = None;` restores the P0 convoy and this catches it.
        let rct = body_of("pub(crate) fn run_cmd_timed(");
        assert!(rct.contains("contends_for_store("), "run_cmd_timed must gate on contends_for_store");
        assert!(rct.contains("&BD_LIMITER"), "run_cmd_timed must select the process-wide BD_LIMITER for bd");

        // create_bead's confirmation probe must use the UNLIMITED path; swapping it back to the
        // limited `bd_stdout_within` re-starves the probe under contention (confirm_written fails open).
        let cb = body_of("fn create_bead(");
        assert!(cb.contains("bd_stdout_unlimited_within("), "create_bead's probe must bypass the limiter");
        assert!(!cb.contains("bd_stdout_within("), "create_bead must not use the LIMITED probe path");
    }

    #[test]
    fn a_permit_that_ate_the_budget_is_not_spent_on_a_doomed_spawn() {
        // The budget floor: after queueing eats most of the budget, spawning bd only pays a cold Dolt
        // open for a child killed on the next tick (and, for a mutation, SIGKILLs it mid-startup).
        // Mutate the floor to zero and a sliver of budget would still spawn.
        assert!(!enough_budget_to_run(Duration::from_millis(0)), "no budget must not spawn");
        assert!(!enough_budget_to_run(Duration::from_millis(20)), "a poll-tick's worth must not spawn");
        assert!(enough_budget_to_run(Duration::from_secs(1)), "a real budget must spawn");
        assert!(enough_budget_to_run(MIN_RUN_BUDGET_AFTER_QUEUE), "exactly the floor must spawn");
    }

    #[cfg(unix)]
    #[test]
    fn run_cmd_until_reports_a_saturated_queue_as_store_busy_without_hanging() {
        // End to end through the real runner: a caller that cannot get a permit within its budget
        // returns PROMPTLY, never blocking — the whole point of bounding the permit wait. The kind is
        // StoreBusy, NOT Timeout: nothing was spawned, so nothing was written, and `describe_bd_failure`
        // must not dress this up as an ambiguous "did the write land?" — it is safe to retry. The kind
        // is what carries that, so this asserts it, not just the message.
        let dir = std::env::temp_dir()
            .join(format!("sparkle-test-beads-satq-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.to_string_lossy().to_string();

        let limiter = BdConcurrencyLimiter::new(1);
        let _held = limiter.acquire_by(Instant::now() + Duration::from_secs(3600)).expect("hold the one permit");

        let start = Instant::now();
        let err = run_cmd_until(
            Some(&limiter),
            "/bin/sh",
            &path,
            &["-c".to_string(), "echo hi".to_string()],
            Duration::from_millis(200),
            NO_EXTRA_ENV,
        )
        .expect_err("a saturated queue must not run the child");
        let waited = start.elapsed();
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(
            err.kind,
            BeadsErrorKind::StoreBusy,
            "queue saturation is StoreBusy (retry-safe), never Timeout (write-ambiguous)",
        );
        assert!(err.message.contains("concurrency limit"), "the message names the queue, not a wedged bd: {}", err.message);
        assert!(err.message.contains("retrying"), "the message must tell the user retrying is safe: {}", err.message);
        assert!(waited < Duration::from_secs(3), "it must return near its deadline, not hang: {waited:?}");
    }

    #[cfg(unix)]
    #[test]
    fn run_cmd_until_never_runs_more_children_than_the_permit_allows() {
        // The SIDE EFFECT, through the real bounded runner: fire far more concurrent callers than the
        // cap, and prove no more than the permit count are ever alive at once.
        //
        // Driven with `/bin/sh` (so it runs on every machine — CI has no bd) and a FRESH limiter, so
        // this exercises the real acquire/hold/release path in `run_cmd_until` while touching neither
        // the process-wide `BD_LIMITER` nor any other test's permits — no cross-test flakiness in
        // either direction. Each child records that it is IN FLIGHT by creating a uniquely-named
        // marker on entry and removing it on exit; a monitor thread samples the marker directory and
        // keeps the peak. The assertion is that peak, i.e. the maximum ACTUAL concurrency — not that
        // the limiter was called. Delete the permit acquire in `run_cmd_until` and the peak climbs to
        // the number of callers, so this cannot pass without the bound.
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

        let dir = std::env::temp_dir()
            .join(format!("sparkle-test-beads-concurrency-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let markers = dir.join("inflight");
        std::fs::create_dir_all(&markers).expect("marker dir");
        let path = dir.to_string_lossy().to_string();

        let limiter = BdConcurrencyLimiter::new(BD_MAX_CONCURRENT);

        // Comfortably above BD_MAX_CONCURRENT so the cap is under real pressure.
        const CALLERS: usize = 8;
        assert!(CALLERS > BD_MAX_CONCURRENT, "the test must offer more load than the cap");
        // A child that outlives a monitor tick by a wide margin, so overlap is observable.
        let script = format!(r#"f="{}/$$"; : > "$f"; sleep 0.4; rm -f "$f""#, markers.display());

        let peak = AtomicUsize::new(0);
        let done = AtomicBool::new(false);
        std::thread::scope(|s| {
            // Monitor: sample the in-flight marker count and keep the maximum seen.
            s.spawn(|| {
                while !done.load(Ordering::Relaxed) {
                    if let Ok(rd) = std::fs::read_dir(&markers) {
                        let n = rd.filter(|e| e.is_ok()).count();
                        peak.fetch_max(n, Ordering::Relaxed);
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            });

            // Fire every caller through the real runner at once, all sharing the one fresh limiter.
            let handles: Vec<_> = (0..CALLERS)
                .map(|_| {
                    let path = path.clone();
                    let script = script.clone();
                    let limiter = &limiter;
                    s.spawn(move || {
                        run_cmd_until(
                            Some(limiter),
                            "/bin/sh",
                            &path,
                            &["-c".to_string(), script],
                            Duration::from_secs(30),
                            NO_EXTRA_ENV,
                        )
                    })
                })
                .collect();
            for h in handles {
                // The stand-in may exit non-zero; we only care that the thread did not panic.
                let _ = h.join().expect("a caller thread panicked");
            }
            done.store(true, Ordering::Relaxed);
        });

        let observed = peak.load(Ordering::Relaxed);
        std::fs::remove_dir_all(&dir).ok();

        // The fresh limiter is uncontended, so the cap is genuinely reachable — assert it IS reached
        // (grip: permits are handed out concurrently, not accidentally serialized) AND never exceeded.
        // The lower bound is `min(cap, CALLERS)` so it tracks the constant either way: tuning the cap
        // down to 1 keeps the two bounds consistent (peak == 1) instead of contradicting each other,
        // and a cap above the offered load still expects only as many as there are callers.
        let expected_peak = BD_MAX_CONCURRENT.min(CALLERS);
        assert!(
            observed >= expected_peak,
            "expected up to {expected_peak} concurrent children, but the peak was only {observed}",
        );
        assert!(
            observed <= BD_MAX_CONCURRENT,
            "run_cmd_until allowed {observed} children at once, over the cap of {BD_MAX_CONCURRENT}",
        );
    }

    #[test]
    fn a_nonzero_exit_with_only_stderr_is_a_typed_bd_failure() {
        let out = BdOutput {
            status: Some(1),
            success: false,
            stdout: String::new(),
            stderr: "boom: something went wrong".into(),
        };
        let e = check_run(&out).unwrap_err();
        assert_eq!(e.kind, BeadsErrorKind::BdFailed);
        assert_eq!(e.exit_code, Some(1));
        assert!(e.message.contains("boom"));
    }

    #[test]
    fn a_missing_workspace_is_classified_as_no_workspace() {
        let out = BdOutput {
            status: Some(1),
            success: false,
            stdout: String::new(),
            stderr: "Error: no beads database found in this directory".into(),
        };
        assert_eq!(check_run(&out).unwrap_err().kind, BeadsErrorKind::NoWorkspace);
        // Also via bd's JSON error payload, which is the path `bd show` actually takes.
        let e = parse_bead_rows(r#"{"error":"no beads database found","schema_version":1}"#).unwrap_err();
        assert_eq!(e.kind, BeadsErrorKind::NoWorkspace);
    }

    #[test]
    fn a_bd_json_error_payload_becomes_an_error_even_on_exit_zero() {
        // `bd show <missing> --json` prints this and (for some subcommands) exits 0.
        let e = parse_bead_rows(r#"{"error":"no issues found matching the provided IDs"}"#).unwrap_err();
        assert_eq!(e.kind, BeadsErrorKind::BdFailed);
        assert!(e.message.contains("no issues found"));
    }

    #[test]
    fn non_zero_exit_still_succeeds_when_bd_wrote_its_json_payload() {
        // The payload carries the real diagnosis; parse_bead_rows turns it into a precise error.
        // Sound ONLY because every `check_run` caller goes on to parse — mutations use `ack_outcome`.
        let out = BdOutput {
            status: Some(1),
            success: false,
            stdout: r#"{"error":"nope"}"#.into(),
            stderr: "warning noise".into(),
        };
        assert!(check_run(&out).is_ok(), "defer to the JSON payload, not stderr");
    }

    // ── A mutation is only "done" when bd acknowledged it ────────────────────────────────────

    #[test]
    fn a_mutation_fails_on_a_json_error_payload_even_with_exit_zero() {
        // THE failure mode this exists for: bd reports the failure only in its stdout payload and
        // exits 0. `check_run` waves that through on the premise that a parser will catch it — and
        // for a mutation there is no parser, so the caller is told the bead was closed.
        let out = BdOutput {
            status: Some(0),
            success: true,
            stdout: r#"{"error":"no issue found matching \"sparkle-zzz9\"","schema_version":1}"#.into(),
            stderr: String::new(),
        };
        assert!(check_run(&out).is_ok(), "the read path deliberately defers; that is the hazard");
        let e = ack_outcome(&out).expect_err("a mutation must NOT report an error payload as success");
        assert_eq!(e.kind, BeadsErrorKind::BdFailed);
        assert!(e.message.contains("no issue found"), "the diagnosis reaches the caller: {}", e.message);
    }

    #[test]
    fn a_mutation_fails_on_a_json_error_payload_with_a_non_zero_exit() {
        let out = BdOutput {
            status: Some(1),
            success: false,
            stdout: r#"{"error":"no beads database found"}"#.into(),
            stderr: String::new(),
        };
        let e = ack_outcome(&out).unwrap_err();
        assert_eq!(e.kind, BeadsErrorKind::NoWorkspace, "classification is shared with the read path");
        assert_eq!(e.exit_code, Some(1));
    }

    #[test]
    fn a_mutation_fails_on_a_non_zero_exit_even_when_stdout_looks_like_json() {
        // The other half of the deferral: exit non-zero with a JSON body carrying no `error` key.
        // `check_run` accepts it and a parser would then find nothing wrong.
        let out = BdOutput {
            status: Some(2),
            success: false,
            stdout: r#"{"partial":true}"#.into(),
            stderr: "Error: write conflict".into(),
        };
        assert!(check_run(&out).is_ok());
        let e = ack_outcome(&out).expect_err("a non-zero exit is not an acknowledgement");
        assert_eq!(e.kind, BeadsErrorKind::BdFailed);
        assert_eq!(e.exit_code, Some(2));
        assert!(e.message.contains("write conflict"));
    }

    #[test]
    fn a_write_that_lost_the_store_is_store_busy_not_a_failed_request() {
        // The observed shape: `bd create` blocks on the shared embedded store until bd's own
        // context expires, then exits non-zero with the bare Go phrase. Driven through
        // `ack_outcome` because the mutation path is the one that hits it.
        let out = BdOutput {
            status: Some(1),
            success: false,
            stdout: String::new(),
            stderr: "Error: context canceled".into(),
        };
        let e = ack_outcome(&out).expect_err("a non-zero exit is not an acknowledgement");
        assert_eq!(e.kind, BeadsErrorKind::StoreBusy);
        assert_eq!(e.exit_code, Some(1));
        assert!(e.message.contains("context canceled"), "bd's own wording survives: {}", e.message);
    }

    #[test]
    fn a_locked_store_reported_as_a_json_error_payload_is_store_busy_on_the_read_path_too() {
        // The paired half: same classification, other transport (JSON body rather than stderr) and
        // other direction (read rather than write). Both call `classify_bd_message`, and this is
        // what proves it — a fix applied to only one of them passes the test above and fails here.
        let e = parse_bead_rows(r#"{"error":"database is locked","schema_version":1}"#).unwrap_err();
        assert_eq!(e.kind, BeadsErrorKind::StoreBusy);
    }

    #[test]
    fn an_ordinary_bd_failure_is_still_bd_failed() {
        // The guard on the table above. Without it, classifying everything as `StoreBusy` would
        // satisfy both cases above — and would tell a caller to retry a request that is simply
        // wrong, forever.
        for msg in ["Error: unknown flag: --nope", "Error: no issue found with id x", "canceled"] {
            assert_eq!(
                classify_bd_message(msg, Some(1)).kind,
                BeadsErrorKind::BdFailed,
                "over-matched: {msg}"
            );
        }
    }

    #[test]
    fn a_mutation_that_bd_acknowledged_succeeds() {
        // bd's mutations print human text, not JSON — that must stay a success.
        let ok = BdOutput {
            status: Some(0),
            success: true,
            stdout: "✓ Comment added to sparkle-4562 — EPIC: Concierge Mode\n".into(),
            stderr: String::new(),
        };
        assert!(ack_outcome(&ok).is_ok());
        // As must a silent success, and a JSON body that is not an error.
        for stdout in ["", "   \n", r#"{"id":"sparkle-4562","status":"closed"}"#] {
            let out = BdOutput {
                status: Some(0),
                success: true,
                stdout: stdout.into(),
                stderr: String::new(),
            };
            assert!(ack_outcome(&out).is_ok(), "unexpected failure for stdout {stdout:?}");
        }
    }

    #[test]
    fn every_mutation_goes_through_the_acknowledged_path() {
        // The routing is what makes `ack_outcome` matter, and it is exactly what a later edit
        // undoes without noticing: swapping `bd_ack` back for `bd_stdout` compiles, passes every
        // other test in this file, and starts reporting mutations that never happened as done.
        //
        // No live bd can catch that today — bd 1.0.5 reports a bad id for these three on stderr
        // with a non-zero exit, which `check_run` already fails on, so the hazard is the payload
        // shape bd uses elsewhere (`show`, `create`) arriving here on a version or subcommand that
        // does the same. Hence the same include_str! guard the lib.rs registration test uses.
        let src = include_str!("beads_cmd.rs");
        for op in
            ["fn update_bead(", "fn close_bead(", "fn comment_bead(", "fn reparent_beads("]
        {
            let from = src.find(op).unwrap_or_else(|| panic!("{op} still exists"));
            let body = &src[from..];
            let body = &body[..body.find("\n}\n").expect("the fn body ends")];
            assert!(body.contains("bd_ack("), "{op} must run through bd_ack");
            assert!(
                !body.contains("bd_stdout("),
                "{op} must NOT use the read path — its `check_run` defers to a parser that a \
                 mutation does not have"
            );
        }
    }

    #[test]
    fn a_mutation_with_no_output_at_all_still_fails_on_a_non_zero_exit() {
        let out =
            BdOutput { status: Some(1), success: false, stdout: String::new(), stderr: String::new() };
        assert_eq!(ack_outcome(&out).unwrap_err().kind, BeadsErrorKind::BdFailed);
    }

    #[test]
    fn garbage_stdout_is_bad_output_not_a_panic() {
        let e = parse_bead_rows("not json at all <html>").unwrap_err();
        assert_eq!(e.kind, BeadsErrorKind::BadOutput);
    }

    #[test]
    fn a_flag_like_id_is_rejected_before_bd_runs() {
        assert_eq!(require_id("--force").unwrap_err().kind, BeadsErrorKind::InvalidInput);
        assert_eq!(require_id("").unwrap_err().kind, BeadsErrorKind::InvalidInput);
        assert!(require_id("sparkle-4562.2").is_ok());
    }

    #[test]
    fn error_messages_are_capped() {
        let e = BeadsError::new(BeadsErrorKind::BdFailed, "x".repeat(5000));
        assert_eq!(e.message.chars().count(), ERROR_MESSAGE_CHARS);
    }

    // ── The output cap actually truncates and reports what it omitted ────────────────────────

    fn bead(n: usize) -> BeadSummary {
        BeadSummary { id: format!("b-{n}"), ..Default::default() }
    }

    #[test]
    fn the_cap_truncates_and_reports_the_exact_omitted_count() {
        // The motivating case: a query against 800+ beads.
        let rows: Vec<BeadSummary> = (0..825).map(bead).collect();
        let page = paginate(rows, None);

        assert_eq!(page.beads.len(), DEFAULT_LIMIT, "page is bounded");
        assert_eq!(page.total, 825, "total is the true match count, not the page size");
        assert_eq!(page.omitted, 725, "omitted is EXACT");
        assert_eq!(page.limit, DEFAULT_LIMIT);
        // The id list is a capped sample, but the count above stayed exact.
        assert_eq!(page.omitted_ids.len(), OMITTED_IDS_CAP);
        assert_eq!(page.omitted_ids[0], "b-100", "sample starts at the first dropped row");
        assert_eq!(page.beads.last().unwrap().id, "b-99");
    }

    #[test]
    fn a_complete_page_reports_nothing_omitted() {
        let page = paginate((0..5).map(bead).collect(), None);
        assert_eq!(page.total, 5);
        assert_eq!(page.omitted, 0);
        assert!(page.omitted_ids.is_empty(), "no omission means no sample");
    }

    #[test]
    fn a_caller_cannot_exceed_the_hard_ceiling() {
        let page = paginate((0..2000).map(bead).collect(), Some(99_999));
        assert_eq!(page.beads.len(), MAX_LIMIT, "clamped to MAX_LIMIT");
        assert_eq!(page.limit, MAX_LIMIT);
        assert_eq!(page.omitted, 2000 - MAX_LIMIT);
    }

    #[test]
    fn limit_zero_means_unset_not_empty() {
        // bd's own `--limit 0` means UNLIMITED, so honoring 0 literally would be doubly wrong.
        let page = paginate((0..10).map(bead).collect(), Some(0));
        assert_eq!(page.beads.len(), 10);
        assert_eq!(page.limit, DEFAULT_LIMIT);
    }

    #[test]
    fn long_descriptions_are_excerpted_and_flagged() {
        let long = "x".repeat(4000);
        let row = serde_json::json!({"id": "b-1", "description": long});
        let b = normalize_bead(&row);
        assert_eq!(b.description.chars().count(), DESCRIPTION_EXCERPT_CHARS);
        assert!(b.description_truncated, "the caller must be able to tell it is an excerpt");
    }

    #[test]
    fn the_full_description_is_read_out_of_the_same_show_payload_as_the_summary() {
        // Detail carries the uncut text; the summary beside it carries the excerpt. Both come from
        // ONE `bd show` stdout — a second invocation doubled the worst-case latency and could
        // straddle a concurrent edit, pairing a fullDescription with a bead it does not describe.
        let long = "z".repeat(4000);
        let stdout = serde_json::json!([{"id": "b-1", "description": long}]).to_string();

        let bead = parse_bead_rows(&stdout).unwrap().remove(0);
        assert!(bead.description_truncated, "the summary is still excerpted");
        assert_eq!(bead.description.chars().count(), DESCRIPTION_EXCERPT_CHARS);

        let full = full_description_from(&stdout).expect("the uncut text comes from the same body");
        assert_eq!(full.chars().count(), 4000);
        assert_eq!(full, long);

        // `bd show` emits an object for some shapes and an array for others; both must work.
        let obj = serde_json::json!({"id": "b-1", "description": "short"}).to_string();
        assert_eq!(full_description_from(&obj).as_deref(), Some("short"));
        // A bead with no description reads as empty, not as "could not read".
        assert_eq!(full_description_from(r#"[{"id":"b-1"}]"#).as_deref(), Some(""));
        // A body we cannot parse is None, so the caller falls back to the excerpt.
        assert_eq!(full_description_from("not json"), None);
        assert_eq!(full_description_from("[]"), None);
    }

    #[test]
    fn excerpt_never_splits_a_multibyte_character() {
        // Byte-slicing an em-dash would panic; bead titles are full of them.
        let s = "—".repeat(50);
        let (cut, truncated) = excerpt(&s, 10);
        assert!(truncated);
        assert_eq!(cut.chars().count(), 10);
        assert_eq!(cut, "—".repeat(10));
    }

    #[test]
    fn a_capped_page_is_dramatically_smaller_than_the_raw_bd_output() {
        // The whole justification for this surface, exercised END TO END through the real pipeline
        // (bd stdout -> parse_bead_rows -> paginate). Driving it through `parse_bead_rows` is the
        // point: BOTH caps have to fire, and they live in different places — the ROW cap in
        // `paginate`, the description cap in `normalize_bead`. Building `BeadSummary` values
        // directly would skip normalization and silently test only half of the bound.
        let raw_json = format!(
            "[{}]",
            (0..825)
                .map(|n| format!(
                    r#"{{"id":"b-{n}","title":"a bead","status":"open","description":"{}"}}"#,
                    "y".repeat(1500)
                ))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert!(raw_json.len() > 1_200_000, "fixture models the real workspace, got {}", raw_json.len());

        let page = paginate(parse_bead_rows(&raw_json).unwrap(), None);
        let capped = serde_json::to_string(&page).unwrap().len();

        assert_eq!(page.total, 825, "the true match count survives the cap");
        assert_eq!(page.omitted, 725);
        assert!(page.beads.iter().all(|b| b.description_truncated), "every row was excerpted");
        // ~100 rows x ~280 chars, versus the ~1.2 MB bd actually produced.
        assert!(capped < 60_000, "capped page must stay small, got {capped}");
        assert!(
            raw_json.len() / capped > 20,
            "the cap must be a real bound, not a rounding error: {} -> {capped}",
            raw_json.len()
        );
    }

    // ── Query / mutation argv assembly ───────────────────────────────────────────────────────

    #[test]
    fn a_default_query_asks_bd_for_json_and_caps_in_rust() {
        let args = build_query_args(&BeadQuery::default());
        assert_eq!(args, vec!["list", "--limit", "0", "--json"]);
    }

    #[test]
    fn filters_map_onto_bd_flags() {
        let q = BeadQuery {
            status: Some("open,in_progress".into()),
            priority: Some("0".into()),
            parent: Some("sparkle-4562".into()),
            assignee: Some("drodio".into()),
            issue_type: Some("bug".into()),
            label: Some("p0".into()),
            title_contains: Some("concierge".into()),
            ready: Some(true),
            ..Default::default()
        };
        let a = build_query_args(&q);
        let joined = a.join(" ");
        assert!(joined.contains("--status open,in_progress"));
        assert!(joined.contains("--priority 0"));
        assert!(joined.contains("--parent sparkle-4562"));
        assert!(joined.contains("--assignee drodio"));
        assert!(joined.contains("--type bug"));
        assert!(joined.contains("--label p0"));
        assert!(joined.contains("--title-contains concierge"));
        assert!(a.contains(&"--ready".to_string()));
    }

    #[test]
    fn an_explicit_status_is_not_widened_by_include_closed() {
        // `--all` overrides bd's filter, so appending it alongside --status would silently return
        // everything to a caller that explicitly narrowed. This is the precedence rule.
        let q = BeadQuery {
            status: Some("open".into()),
            include_closed: Some(true),
            blocked: Some(true),
            ..Default::default()
        };
        let a = build_query_args(&q);
        assert!(a.contains(&"--status".to_string()) && a.contains(&"open".to_string()));
        assert!(!a.contains(&"--all".to_string()), "explicit status must win");
        assert_eq!(a.iter().filter(|s| *s == "--status").count(), 1, "blocked must not add a second");
    }

    #[test]
    fn blocked_and_include_closed_apply_only_without_an_explicit_status() {
        let blocked = build_query_args(&BeadQuery { blocked: Some(true), ..Default::default() });
        assert!(blocked.join(" ").contains("--status blocked"));

        let closed = build_query_args(&BeadQuery { include_closed: Some(true), ..Default::default() });
        assert!(closed.contains(&"--all".to_string()));
    }

    #[test]
    fn blank_filters_are_dropped_rather_than_passed_as_empty_flags() {
        let q = BeadQuery {
            status: Some("   ".into()),
            parent: Some("".into()),
            label: Some(" ".into()),
            exclude_label: Some("\t".into()),
            ..Default::default()
        };
        assert_eq!(build_query_args(&q), vec!["list", "--limit", "0", "--json"]);
    }

    /// The board hides app-generated agent telemetry (`sparkle-auto`) this way. Without it those
    /// beads render as ordinary backlog cards — 299 of them had accumulated by 2026-07-29, 74 stuck
    /// in "Being built".
    #[test]
    fn exclude_label_maps_onto_bds_exclude_label_flag() {
        let q = BeadQuery { exclude_label: Some("sparkle-auto".into()), ..Default::default() };
        let a = build_query_args(&q);
        assert!(a.join(" ").contains("--exclude-label sparkle-auto"));
        // Two SEPARATE argv tokens, never one "--exclude-label sparkle-auto" string.
        let i = a.iter().position(|s| s == "--exclude-label").expect("flag present");
        assert_eq!(a[i + 1], "sparkle-auto");
    }

    /// `--label` (include) and `--exclude-label` are independent axes in bd, so both must survive.
    #[test]
    fn include_and_exclude_label_can_be_combined() {
        let q = BeadQuery {
            label: Some("p0".into()),
            exclude_label: Some("sparkle-auto".into()),
            ..Default::default()
        };
        let joined = build_query_args(&q).join(" ");
        assert!(joined.contains("--label p0"));
        assert!(joined.contains("--exclude-label sparkle-auto"));
    }

    #[test]
    fn create_args_default_the_type_and_omit_absent_fields() {
        let a = build_create_args(&NewBead { title: "hello".into(), ..Default::default() });
        assert_eq!(a, vec!["create", "--title=hello", "-d", "", "-t", "task", "--json"]);

        let full = build_create_args(&NewBead {
            title: "t".into(),
            description: Some("body".into()),
            issue_type: Some("bug".into()),
            priority: Some("1".into()),
            parent: Some("p-1".into()),
            assignee: Some("me".into()),
            labels: Some("a,b".into()),
        });
        let j = full.join(" ");
        assert!(j.contains("-t bug") && j.contains("-p 1") && j.contains("--parent p-1"));
        assert!(j.contains("-a me") && j.contains("-l a,b") && j.contains("-d body"));
    }

    /// The write-drop guard's whole point: a create is only successful once the row READS BACK.
    /// Each case is a probe body bd really emits, and the two that prove absence must FAIL — before
    /// this guard existed every one of these was reported to the caller as a successful create.
    #[test]
    fn a_create_whose_bead_does_not_read_back_is_a_failure() {
        // bd's no-such-issue payload — `bd show <missing> --json`, verbatim.
        let missing = r#"{"error":"no issues found matching the provided IDs","schema_version":1}"#;
        let e = confirm_written(Ok(missing.into()), "").expect_err("drop is reported");
        assert_eq!(e.kind, BeadsErrorKind::BadOutput);
        assert!(e.message.contains(""), "names the bead that was lost: {}", e.message);
        assert!(e.message.contains("did not land"), "says the write was lost: {}", e.message);

        // A clean read that returns rows, none of which is the id bd claimed to have created.
        let others = r#"[{"id":"","title":"someone else","status":"open"}]"#;
        assert!(confirm_written(Ok(others.into()), "").is_err());

        // And an empty result set is absence just the same.
        assert!(confirm_written(Ok("[]".into()), "").is_err());
    }

    /// The other half of the guard, and the half that keeps it safe to run on every create: an
    /// UNREADABLE probe is not evidence of a drop. Failing here would report a create that landed
    /// as lost every time bd was slow, missing, or newer than this parser.
    #[test]
    fn a_probe_that_could_not_run_never_condemns_the_create() {
        let id = "";
        // The row is there — the ordinary path.
        let present = r#"{"id":"","title":"filed","status":"open"}"#;
        assert!(confirm_written(Ok(present.into()), id).is_ok());
        let in_array = r#"[{"id":"","title":"filed","status":"open"}]"#;
        assert!(confirm_written(Ok(in_array.into()), id).is_ok());

        // bd never ran / was killed on BD_TIMEOUT / is not installed.
        for kind in [BeadsErrorKind::BinaryNotFound, BeadsErrorKind::Timeout, BeadsErrorKind::BdFailed]
        {
            assert!(confirm_written(Err(BeadsError::new(kind, "bd was killed")), id).is_ok());
        }
        // A bd failure that is NOT "no such issue" says nothing about the row.
        let locked = r#"{"error":"database is locked","schema_version":1}"#;
        assert!(confirm_written(Ok(locked.into()), id).is_ok());
        // Nothing readable, or output this parser does not understand (version skew).
        assert!(confirm_written(Ok("".into()), id).is_ok());
        assert!(confirm_written(Ok("   ".into()), id).is_ok());
        assert!(confirm_written(Ok("not json at all".into()), id).is_ok());
    }

    /// The confirmation probe made `beads_create` a TWO-INVOCATION command, so its budget is the
    /// SUM — and `plans:create_plan` reaches it through the concierge bridge, which kills a tool
    /// call at `CONCIERGE_TOOL_TIMEOUT_MS` (50s, apps/mcp-control/src/tools.ts). At the full 30s
    /// each the pair is 60s, so the bridge would kill the call TEN SECONDS AFTER bd confirmed the
    /// write: the model is told the tool timed out for a bead sitting in the store — the
    /// unknown-outcome case this confirmation exists to remove, reintroduced by the confirmation.
    ///
    /// THE CROSS-FILE HALF OF THIS GUARD IS IN TYPESCRIPT ON PURPOSE, not here
    /// (`src/services/beadsCommands.rustContract.test.ts` reads BOTH constants and asserts the real
    /// relationship). A Rust test reading `tools.ts` would have to add that path to `RUST_RE` in
    /// ci.yml — the filter that decides whether the macOS (10x billing) and Windows (2x) legs run —
    /// and `tools.ts` is an actively edited file. Same coverage, since any non-docs change already
    /// sets `code=true` and runs the TS suite, at none of the spend. What stays here is the local
    /// invariant, which is what a Rust-side widening trips first.
    #[test]
    fn the_confirmation_probe_is_bounded_well_under_a_full_bd_budget() {
        assert!(
            BD_CONFIRM_PROBE_TIMEOUT < BD_TIMEOUT,
            "a probe on the full budget doubles beads_create's worst case"
        );
        // 40s, against the bridge's 50s. Stated as a bound rather than an equality so shortening
        // either constant stays green and only a WIDENING reds — and shortening is always safe
        // here, because `confirm_written` fails OPEN on a probe that could not run.
        assert!(
            BD_TIMEOUT + BD_CONFIRM_PROBE_TIMEOUT <= Duration::from_secs(40),
            "create + probe must leave headroom under the 50s concierge bridge ceiling"
        );
    }

    /// `is_missing_issue` decides which bd failures are allowed to condemn a create, so it must not
    /// widen: bd's OTHER failures share the word "no" and would fail-closed on a live bead.
    #[test]
    fn only_bds_no_such_issue_wording_proves_absence() {
        assert!(is_missing_issue("no issues found matching the provided IDs"));
        assert!(is_missing_issue("Error: no issue found matching \"\""));
        assert!(!is_missing_issue("no beads database found"));
        assert!(!is_missing_issue("database is locked"));
        assert!(!is_missing_issue(""));
    }

    // ── Re-parenting a SET of beads onto an epic (bead sparkle-xelans.2) ───────────────────

    #[test]
    fn a_reparent_carries_every_selected_id_in_one_invocation() {
        // THE side effect this whole feature is: N beads, ONE `bd update`. A per-id loop would
        // still make the board look right and would still pass any test that only checked the
        // parent flag, so the assertion is on the SHAPE of the single argv — every id present, in
        // order, ahead of the flag.
        let ids: Vec<String> =
            ["sparkle-a1", "sparkle-b2", "sparkle-c3"].iter().map(|s| s.to_string()).collect();
        let args = build_reparent_args(&ids, "sparkle-epic");
        assert_eq!(
            args,
            vec!["update", "sparkle-a1", "sparkle-b2", "sparkle-c3", "--parent", "sparkle-epic"]
        );
    }

    #[test]
    fn an_empty_parent_survives_the_assembly_as_the_unparent_value() {
        // bd's documented "use empty string to remove parent". The hazard is a copy of
        // `build_update_args`' empty-value filter arriving here, which would silently turn "take
        // these off their epic" into an argv with no `--parent` at all.
        for blank in ["", "   "] {
            let ids = vec!["sparkle-a1".to_string()];
            let args = build_reparent_args(&ids, blank);
            assert_eq!(args, vec!["update", "sparkle-a1", "--parent", ""], "blank {blank:?}");
        }
        // …and a real parent is trimmed rather than passed with its whitespace.
        let ids = vec!["sparkle-a1".to_string()];
        assert_eq!(build_reparent_args(&ids, "  sparkle-epic  ")[3], "sparkle-epic");
    }

    #[test]
    fn a_reparent_refuses_the_inputs_bd_would_misread_or_corrupt() {
        // Nothing here reaches bd: every arm returns before the process is spawned, so these run
        // on a machine with no bd at all.
        let empty: Vec<String> = vec![];
        assert_eq!(
            reparent_beads("/proj", &empty, "sparkle-epic", NO_EXTRA_ENV).unwrap_err().kind,
            BeadsErrorKind::InvalidInput,
            "an empty selection must not shell out to change nothing"
        );
        // A flag-like id anywhere in the batch — including the LAST slot, which a validate-as-you-go
        // implementation would only discover after bd had the whole list.
        let hostile: Vec<String> = vec!["sparkle-a1".into(), "--force".into()];
        assert_eq!(
            reparent_beads("/proj", &hostile, "sparkle-epic", NO_EXTRA_ENV).unwrap_err().kind,
            BeadsErrorKind::InvalidInput
        );
        // A flag-like PARENT.
        let ok: Vec<String> = vec!["sparkle-a1".into()];
        assert_eq!(
            reparent_beads("/proj", &ok, "--parent", NO_EXTRA_ENV).unwrap_err().kind,
            BeadsErrorKind::InvalidInput
        );
        // A bead may not be its own parent — bd would accept the cycle and render an epic that
        // contains itself.
        let selfish: Vec<String> = vec!["sparkle-a1".into(), "sparkle-epic".into()];
        assert_eq!(
            reparent_beads("/proj", &selfish, "sparkle-epic", NO_EXTRA_ENV).unwrap_err().kind,
            BeadsErrorKind::InvalidInput
        );
    }

    #[test]
    fn a_title_is_never_parsed_as_a_flag() {
        // This test used to assert only that the title stayed ONE argv token — which does not
        // establish the safety it claimed. `"--force -d pwned"` IS a single token, and bd read it
        // as a flag anyway (bd 1.0.5: `Error: unknown flag: --force -d pwned`); a bare `"--json"`
        // would have been read as one too. The assertion is now the property that matters: the
        // title never occupies the positional slot, it rides `--title=`, where the `=` binds the
        // value to the flag inside one token and nothing after it can be re-read as an option.
        let benign = build_create_args(&NewBead { title: "safe".into(), ..Default::default() });
        for hostile in ["--force -d pwned", "--json", "-p 0", "- fix the thing", "--title=x"] {
            let a = build_create_args(&NewBead { title: hostile.into(), ..Default::default() });
            assert_eq!(a[1], format!("--title={hostile}"), "title {hostile:?} must ride --title=");
            // …and it must change NOTHING else about the argv: no token added, none shifted, none
            // reinterpreted. That is the property a "stays one token" assertion never had.
            assert_eq!(a.len(), benign.len(), "title {hostile:?} changed the argv length");
            for (i, (got, want)) in a.iter().zip(&benign).enumerate().skip(2) {
                assert_eq!(got, want, "title {hostile:?} disturbed argv[{i}]");
            }
        }
    }

    #[test]
    fn comment_text_is_never_parsed_as_a_flag() {
        // `bd comment` has no `--text=`, so the operands go behind the argument terminator. Without
        // it bd 1.0.5 answers a markdown bullet with `unknown shorthand flag: ' ' in - a bullet`.
        let a = build_comment_args("sparkle-4562", "- a bullet");
        assert_eq!(a, vec!["comment", "--", "sparkle-4562", "- a bullet"]);
        let sep = a.iter().position(|t| t == "--").expect("an argument terminator is present");
        for hostile in ["--json", "-f", "--force -d pwned"] {
            let a = build_comment_args("sparkle-4562", hostile);
            assert!(
                a.iter().position(|t| t == hostile).unwrap() > sep,
                "comment text {hostile:?} must sit after the terminator"
            );
        }
    }

    #[test]
    fn close_args_pass_the_reason_as_a_flag_value_and_omit_a_blank_one() {
        assert_eq!(build_close_args("b-1", "done"), vec!["close", "b-1", "--reason", "done"]);
        // A blank reason is dropped rather than overwriting a stored reason with nothing.
        assert_eq!(build_close_args("b-1", "   "), vec!["close", "b-1"]);
        // A dash-leading reason is safe as-is: pflag consumes the next token as the flag's value
        // whatever it starts with (verified against bd 1.0.5), unlike a positional operand.
        assert_eq!(build_close_args("b-1", "--json")[3], "--json");
    }

    #[test]
    fn an_empty_patch_is_rejected_instead_of_shelling_out() {
        assert!(build_update_args("b-1", &BeadPatch::default()).is_none());
        assert!(build_update_args("b-1", &BeadPatch { status: Some("  ".into()), ..Default::default() })
            .is_none());
    }

    #[test]
    fn a_patch_writes_only_the_fields_provided() {
        let a = build_update_args(
            "b-1",
            &BeadPatch { priority: Some("2".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(a, vec!["update", "b-1", "-p", "2"]);

        let all = build_update_args(
            "b-1",
            &BeadPatch {
                status: Some("in_progress".into()),
                priority: Some("0".into()),
                assignee: Some("me".into()),
            },
        )
        .unwrap();
        assert_eq!(all, vec!["update", "b-1", "-s", "in_progress", "-p", "0", "-a", "me"]);
    }

    // ── Dependency edges ─────────────────────────────────────────────────────────────────────

    #[test]
    fn links_are_split_by_direction() {
        let raw = r#"[
          {"issue_id":"b-2","depends_on_id":"b-1","type":"blocks"},
          {"issue_id":"b-3","depends_on_id":"b-1","type":"parent-child"},
          {"issue_id":"b-1","depends_on_id":"b-9","type":"blocks"}
        ]"#;
        let (deps, dependents, truncated) = parse_links(raw, "b-1");
        assert!(!truncated);
        assert_eq!(deps, vec![BeadLink { id: "b-9".into(), link_type: "blocks".into() }]);
        assert_eq!(
            dependents.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            vec!["b-2", "b-3"]
        );
    }

    #[test]
    fn an_empty_or_unparseable_dep_list_degrades_to_no_edges() {
        assert_eq!(parse_links("[]", "b-1").0.len(), 0);
        assert_eq!(parse_links("", "b-1").1.len(), 0);
        assert_eq!(parse_links("garbage", "b-1").0.len(), 0);
    }

    #[test]
    fn link_lists_are_capped() {
        let rows: Vec<String> = (0..LINKS_CAP + 40)
            .map(|n| format!(r#"{{"issue_id":"b-{n}","depends_on_id":"b-1","type":"blocks"}}"#))
            .collect();
        let (_, dependents, truncated) = parse_links(&format!("[{}]", rows.join(",")), "b-1");
        assert_eq!(dependents.len(), LINKS_CAP);
        assert!(truncated, "truncation must be visible to the caller");
    }

    // ── Wire shape ───────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_error_serializes_the_camel_case_shape_the_ts_wrapper_parses() {
        let v = serde_json::to_value(BeadsError::with_code(
            BeadsErrorKind::BinaryNotFound,
            "nope",
            Some(127),
        ))
        .unwrap();
        assert_eq!(v["kind"], "binaryNotFound");
        assert_eq!(v["message"], "nope");
        assert_eq!(v["exitCode"], 127);
    }

    #[test]
    fn every_error_kind_has_a_stable_camel_case_tag() {
        // These strings are the TS union; a Rust-side rename would silently break the caller.
        for (kind, tag) in [
            (BeadsErrorKind::BinaryNotFound, "binaryNotFound"),
            (BeadsErrorKind::NoWorkspace, "noWorkspace"),
            (BeadsErrorKind::InvalidInput, "invalidInput"),
            (BeadsErrorKind::BdFailed, "bdFailed"),
            (BeadsErrorKind::Timeout, "timeout"),
            (BeadsErrorKind::StoreBusy, "storeBusy"),
            (BeadsErrorKind::BadOutput, "badOutput"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), tag);
        }
    }

    #[test]
    fn the_page_serializes_the_camel_case_keys_the_ts_wrapper_reads() {
        let v = serde_json::to_value(paginate(vec![bead(1)], None)).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["beads", "total", "omitted", "omittedIds", "limit"]);
        let row = serde_json::to_value(bead(1)).unwrap();
        for k in ["issueType", "descriptionTruncated", "dependencyCount", "createdAt"] {
            assert!(row.get(k).is_some(), "missing camelCase key {k}");
        }
    }

    #[test]
    fn a_query_deserializes_from_the_camel_case_json_the_ts_wrapper_sends() {
        let q: BeadQuery =
            serde_json::from_str(r#"{"issueType":"bug","includeClosed":true,"titleContains":"x"}"#)
                .unwrap();
        assert_eq!(q.issue_type.as_deref(), Some("bug"));
        assert_eq!(q.include_closed, Some(true));
        assert_eq!(q.title_contains.as_deref(), Some("x"));
        // Absent fields are None, so `{}` is a valid query.
        assert!(serde_json::from_str::<BeadQuery>("{}").unwrap().status.is_none());
    }

    #[test]
    fn the_commands_stay_registered_in_the_invoke_handler() {
        // A registered command is the only thing the TS wrapper can reach. Dropping a line from
        // lib.rs compiles fine and fails at RUNTIME with "command not found" — the same rot
        // `accounts.rs` guards against with this include_str! trick.
        let lib_rs = include_str!("lib.rs");
        for cmd in [
            "beads_cmd::beads_query",
            "beads_cmd::beads_detail",
            "beads_cmd::beads_create",
            "beads_cmd::beads_update",
            "beads_cmd::beads_close",
            "beads_cmd::beads_comment",
        ] {
            assert!(lib_rs.contains(cmd), "{cmd} is not registered in lib.rs's invoke_handler");
        }
    }

    // ── Round trip against a real, throwaway bd workspace ────────────────────────────────────

    /// Locate bd, or None when it is not installed (the round-trip test then skips).
    pub(crate) fn bd_for_integration() -> Option<String> {
        cached_bd_path()
    }

    /// A throwaway beads workspace.
    ///
    /// TWO INDEPENDENT ROBOREV GUARDS, because `bd init` creates a git repo AND makes a commit, and
    /// this machine sets `core.hooksPath` GLOBALLY to roborev's hooks — so an unguarded temp repo
    /// enqueues a review for a directory that is deleted seconds later. That has orphaned thousands
    /// of dead-repo rows before (see scripts/tests/run.sh and the vendored post-commit hook):
    ///   1. The path carries a `sparkle-test-` component, which the vendored roborev post-commit
    ///      hook skips by name (`*/sparkle-test-*` in resources/roborev/post-commit). This is the
    ///      guard the rest of the Rust suite relies on.
    ///   2. Every bd child runs with `GIT_CONFIG_GLOBAL=/dev/null`, which drops the global config
    ///      (hence the global hooksPath) outright — the belt to the hook's braces, and the same
    ///      mechanism scripts/tests/run.sh uses for the shell suite.
    /// Guard 2 alone would suffice, but guard 1 costs nothing and keeps this consistent with the
    /// convention the other Rust tests already follow.
    ///
    /// Guard 2 is applied PER CHILD, both here and for the module's own runner (which takes a
    /// `ChildEnv` precisely so this test does not have to reach for `std::env::set_var` — a
    /// process-wide mutation that races every other test on the parallel runner, never gets
    /// restored, and is `unsafe` under the 2024 edition).
    pub(crate) const TEST_GIT_ENV: ChildEnv<'static> =
        &[("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_NOSYSTEM", "1"), ("BEADS_ACTOR", "sparkle-test")];

    pub(crate) struct TempWorkspace {
        pub(crate) dir: std::path::PathBuf,
    }

    impl TempWorkspace {
        pub(crate) fn new(tag: &str) -> Option<Self> {
            let bd = bd_for_integration()?;
            let dir = std::env::temp_dir()
                .join(format!("sparkle-test-beads-{tag}-{}", std::process::id()));
            std::fs::remove_dir_all(&dir).ok();
            std::fs::create_dir_all(&dir).ok()?;
            let ws = TempWorkspace { dir };
            let out = ws.bd(&bd, &["init", "--non-interactive", "--quiet"]);
            match out {
                Some(o) if o.status.success() => Some(ws),
                // bd is present but could not init here (sandbox, no git identity, Dolt refusing):
                // skip rather than fail the suite for an environment problem.
                _ => None,
            }
        }

        pub(crate) fn bd(&self, bd: &str, args: &[&str]) -> Option<std::process::Output> {
            Command::new(bd)
                .args(args)
                .current_dir(&self.dir)
                .env("PATH", bd_exec_path())
                // Guard 2 — see the struct doc.
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("BEADS_ACTOR", "sparkle-test")
                .output()
                .ok()
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            // A throwaway beads repo leaves a Dolt server running; stop it before removing the
            // directory or the process outlives the test (the precedent in
            // scripts/tests/beads-untrack-interactions.test.sh does the same).
            if let Some(bd) = cached_bd_path() {
                self.bd(&bd, &["dolt", "stop"]);
            }
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn create_then_close_round_trips_against_a_real_bd_workspace() {
        let Some(ws) = TempWorkspace::new("roundtrip") else {
            eprintln!("SKIP: bd not installed or could not init a workspace");
            return;
        };
        let path = ws.dir.to_string_lossy().to_string();
        // Everything below drives the REAL command bodies (`create_bead`, `query_beads`, …), not a
        // hand-assembled approximation of them, so a mutation that stops checking its
        // acknowledgement fails here rather than in production.

        // CREATE — with a title bd would reject in the positional slot, since that is the argv
        // shape this surface has to get right.
        let created = create_bead(
            &path,
            &NewBead {
                title: "- round trip probe".into(),
                description: Some("created by the beads_cmd round-trip test".into()),
                priority: Some("1".into()),
                ..Default::default()
            },
            TEST_GIT_ENV,
        )
        .expect("bd create ran");
        let id = created.id.clone();
        assert!(!id.is_empty(), "created bead has an id");

        // QUERY — it comes back, typed, in an open-status page.
        let page = query_beads(&path, &BeadQuery::default(), TEST_GIT_ENV).expect("bd list ran");
        let found = page.beads.iter().find(|b| b.id == id).expect("created bead is listed");
        assert_eq!(found.title, "- round trip probe", "a dash-leading title survives round trip");
        assert_eq!(found.status, "open");
        assert_eq!(found.priority, Some(1));
        assert_eq!(page.omitted, 0, "a fresh workspace fits in one page");

        // DETAIL — one `bd show`, carrying both the excerpt and the uncut description.
        let detail = detail_bead(&path, &id, TEST_GIT_ENV).expect("bd show ran");
        assert_eq!(detail.bead.id, id);
        assert_eq!(detail.full_description, "created by the beads_cmd round-trip test");

        // UPDATE / COMMENT / CLOSE — all three through the acknowledged path.
        update_bead(&path, &id, &BeadPatch { priority: Some("0".into()), ..Default::default() }, TEST_GIT_ENV)
            .expect("bd update ran");
        // A dash-leading body is the case the argument terminator exists for.
        comment_bead(&path, &id, "- a round-trip comment", TEST_GIT_ENV).expect("bd comment ran");

        // The comment must be READABLE, not merely counted. `detail_bead` carries `--include-comments`
        // (the read half this feature adds), so the written body round-trips back through the thread —
        // asserting only `comment_count` would pass even if the parse dropped every body.
        let with_comment = detail_bead(&path, &id, TEST_GIT_ENV).expect("bd show ran");
        assert!(
            with_comment.comments.iter().any(|c| c.text == "- a round-trip comment"),
            "the written comment reads back through the detail thread, got {:?}",
            with_comment.comments,
        );

        close_bead(&path, &id, "done in test", TEST_GIT_ENV).expect("bd close ran");

        // The bead is now closed — visible only with closed rows included.
        let closed_page =
            query_beads(&path, &BeadQuery { include_closed: Some(true), ..Default::default() }, TEST_GIT_ENV)
                .expect("bd list --all ran");
        let after = closed_page.beads.iter().find(|b| b.id == id).expect("closed bead still exists");
        assert_eq!(after.status, "closed", "close round-tripped");
        assert_eq!(after.priority, Some(0), "update round-tripped");
        assert_eq!(after.comment_count, 1, "comment round-tripped");
    }

    #[test]
    fn a_mutation_against_a_bead_that_does_not_exist_is_reported_as_a_failure() {
        // The end-to-end form of the ack contract, against a real bd: a concierge that reports a
        // close it never performed is the failure this whole path exists to prevent.
        let Some(ws) = TempWorkspace::new("noack") else {
            eprintln!("SKIP: bd not installed or could not init a workspace");
            return;
        };
        let path = ws.dir.to_string_lossy().to_string();
        let ghost = "sparkle-test-does-not-exist";

        for (label, res) in [
            ("close", close_bead(&path, ghost, "nope", TEST_GIT_ENV)),
            ("comment", comment_bead(&path, ghost, "nope", TEST_GIT_ENV)),
            (
                "update",
                update_bead(
                    &path,
                    ghost,
                    &BeadPatch { priority: Some("0".into()), ..Default::default() },
                    TEST_GIT_ENV,
                ),
            ),
        ] {
            let e = res.err().unwrap_or_else(|| {
                panic!("bd {label} against a non-existent bead was reported to the caller as SUCCESS")
            });
            assert!(
                matches!(e.kind, BeadsErrorKind::BdFailed | BeadsErrorKind::NoWorkspace),
                "bd {label}: unexpected kind {:?} ({})",
                e.kind,
                e.message
            );
        }
    }

    #[test]
    fn a_query_against_a_directory_with_no_workspace_is_a_typed_error() {
        if bd_for_integration().is_none() {
            eprintln!("SKIP: bd not installed");
            return;
        }
        // An empty temp dir with no .beads and no parent workspace.
        let dir = std::env::temp_dir()
            .join(format!("sparkle-test-beads-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).ok();
        let res = query_beads(&dir.to_string_lossy(), &BeadQuery::default(), TEST_GIT_ENV);
        std::fs::remove_dir_all(&dir).ok();
        // Either a typed no-workspace error, or (if a parent dir happens to carry a workspace)
        // a successful read. Never a panic, and never an untyped failure.
        if let Err(e) = res {
            assert!(
                matches!(e.kind, BeadsErrorKind::NoWorkspace | BeadsErrorKind::BdFailed),
                "unexpected kind {:?}: {}",
                e.kind,
                e.message
            );
        }
    }

    // ── THE FOLD, END TO END, AGAINST A REAL bd ──────────────────────────────────────────────
    //
    // These drive the PRODUCTION `create_bead` body with a fake scanner, and they assert the SIDE
    // EFFECT — that no second bead was filed and the existing one was commented. Both halves are
    // FALSE against the pre-change code, which always creates: the count would be 2 and the comment
    // thread empty. Asserting only "an id came back" would pass either way.

    /// A child env is `&[(&str, &str)]`, so the pairs must outlive the call. Returns TEST_GIT_ENV
    /// plus the scanner override.
    #[cfg(unix)]
    fn scan_env<'a>(scanner: &'a str) -> Vec<(&'a str, &'a str)> {
        let mut v: Vec<(&str, &str)> = TEST_GIT_ENV.to_vec();
        v.push((crate::bead_dup::SCANNER_ENV_VAR, scanner));
        v
    }

    #[cfg(unix)]
    #[test]
    fn a_duplicate_create_folds_onto_the_existing_bead_instead_of_filing_a_second() {
        let Some(ws) = TempWorkspace::new("fold") else {
            eprintln!("SKIP: bd not installed or could not init a workspace");
            return;
        };
        let path = ws.dir.to_string_lossy().to_string();
        let title = "Deepgram relay probe reports a false production outage over HTTP/2";

        // The bead the scanner will claim as the duplicate — filed through the same production fn,
        // with no scanner configured, so this first call MUST create.
        let first = create_bead(
            &path,
            &NewBead { title: title.into(), description: Some("first report".into()), ..Default::default() },
            TEST_GIT_ENV,
        )
        .expect("first create ran");

        let scanner = crate::bead_dup::write_fake_scanner(
            &ws.dir,
            "fake-dup-open.sh",
            10,
            &format!(r#"{{"id":"{}","status":"open","priority":1,"title":"x"}}"#, first.id),
        );
        let env = scan_env(scanner.to_str().unwrap());

        let folded = create_bead(
            &path,
            &NewBead {
                title: title.into(),
                description: Some("the same finding, worded differently".into()),
                ..Default::default()
            },
            &env,
        )
        .expect("second create ran");

        // (1) It handed back the EXISTING bead, not a new one.
        assert_eq!(folded.id, first.id, "the fold must return the matched bead's row");

        // (2) NO SECOND BEAD EXISTS. This is the assertion the whole feature is for, and it is the
        //     one that is false against today's code.
        let page = query_beads(&path, &BeadQuery::default(), TEST_GIT_ENV).expect("bd list ran");
        let matching: Vec<_> = page.beads.iter().filter(|b| b.title == title).collect();
        assert_eq!(matching.len(), 1, "a second bead was filed: {matching:?}");

        // (3) The sighting was RECORDED on the existing bead — a fold that writes nothing loses the
        //     report entirely, which is worse than the duplicate it avoided.
        let detail = detail_bead(&path, &first.id, TEST_GIT_ENV).expect("bd show ran");
        assert!(
            detail.comments.iter().any(|c| c.text.contains("Duplicate folded by Sparkle")),
            "the fold must comment on the matched bead, got {:?}",
            detail.comments
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_scanner_verdict_of_no_duplicate_still_creates() {
        let Some(ws) = TempWorkspace::new("nodup") else {
            eprintln!("SKIP: bd not installed or could not init a workspace");
            return;
        };
        let path = ws.dir.to_string_lossy().to_string();
        // Exit 0 = no duplicate, and exit 3 = could not tell. Contract §3: BOTH create. Exit 3 is
        // the one that matters — the safety direction here is inverted versus every other guard in
        // this repo, because falsely claiming a duplicate LOSES a finding.
        for (code, tag) in [(0, "clean"), (3, "unknown")] {
            let scanner = crate::bead_dup::write_fake_scanner(
                &ws.dir,
                &format!("fake-scan-{tag}.sh"),
                code,
                r#"{"id":null}"#,
            );
            let env = scan_env(scanner.to_str().unwrap());
            let title = format!("Scanner verdict {tag} must still file the pending report");
            let made = create_bead(
                &path,
                &NewBead { title: title.clone(), ..Default::default() },
                &env,
            )
            .expect("create ran");
            let detail = detail_bead(&path, &made.id, TEST_GIT_ENV).expect("bd show ran");
            assert_eq!(detail.bead.title, title, "exit {code} must create a NEW bead");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_scanner_answer_creates_rather_than_commenting_into_the_void() {
        let Some(ws) = TempWorkspace::new("stale") else {
            eprintln!("SKIP: bd not installed or could not init a workspace");
            return;
        };
        let path = ws.dir.to_string_lossy().to_string();
        // The scanner reads a cached TSV with a 900s TTL, so the bead it names may be gone. Without
        // the `bd show` re-verify this would comment on nothing and drop the report.
        let scanner = crate::bead_dup::write_fake_scanner(
            &ws.dir,
            "fake-stale.sh",
            10,
            r#"{"id":"sparkle-doesnotexist","status":"open","title":"x"}"#,
        );
        let env = scan_env(scanner.to_str().unwrap());
        let title = "A stale index entry must not swallow the incoming report";
        let made = create_bead(&path, &NewBead { title: title.into(), ..Default::default() }, &env)
            .expect("create ran");
        let detail = detail_bead(&path, &made.id, TEST_GIT_ENV).expect("bd show ran");
        assert_eq!(detail.bead.title, title, "an unverifiable match must fall through to a create");
    }

    #[cfg(unix)]
    #[test]
    fn an_auto_labelled_create_is_never_folded_even_when_the_scanner_says_duplicate() {
        let Some(ws) = TempWorkspace::new("autolabel") else {
            eprintln!("SKIP: bd not installed or could not init a workspace");
            return;
        };
        let path = ws.dir.to_string_lossy().to_string();
        // THE CATASTROPHIC CASE, end to end: `buildAgentSpawn.ts` files one of these per Build agent
        // and binds the id with `setAgentBeadId`. A fold here puts two live agents on ONE bead.
        // The scanner is rigged to say "duplicate" so this can only pass on the SKIP LIST — a score
        // threshold could never save it, since these beads are genuinely identical.
        let first = create_bead(
            &path,
            &NewBead {
                title: "Wire the duplicate scanner into the create paths".into(),
                labels: Some(crate::bead_dup::AUTO_LABEL.into()),
                ..Default::default()
            },
            TEST_GIT_ENV,
        )
        .expect("first create ran");
        let scanner = crate::bead_dup::write_fake_scanner(
            &ws.dir,
            "fake-always-dup.sh",
            10,
            &format!(r#"{{"id":"{}","status":"open","title":"x"}}"#, first.id),
        );
        let env = scan_env(scanner.to_str().unwrap());
        let second = create_bead(
            &path,
            &NewBead {
                title: "Wire the duplicate scanner into the create paths".into(),
                labels: Some(crate::bead_dup::AUTO_LABEL.into()),
                ..Default::default()
            },
            &env,
        )
        .expect("second create ran");
        assert_ne!(
            second.id, first.id,
            "a sparkle-auto create was FOLDED — two Build agents would share one bead id"
        );
    }
}
