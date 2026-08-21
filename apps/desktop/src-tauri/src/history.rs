// apps/desktop/src-tauri/src/history.rs
//! Durable, searchable local history of every prompt and response (Brainstorm + Build agents).
//! One SQLite database (FTS5 full-text) in the app-data dir, outside any worktree so it never
//! shows up in `git status` — same placement rationale as the hook logs.
//!
//! No new time/uuid crate: the frontend supplies `id` (`crypto.randomUUID()`) and `created_at`
//! (`Date.now()`, epoch ms UTC), and passes an absolute `cutoff_ms` to prune. Rust only stores.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Managed Tauri state: the single history DB connection behind a mutex (SQLite is fine for a
/// single guarded connection; our access is low-frequency capture + the occasional search/prune).
pub struct HistoryDb {
    pub(crate) conn: Mutex<Connection>,
}

/// The capture payload from the frontend. camelCase to match the `HistoryEntry` TS interface.
/// `deleted_at`/`synced_at` are owned by the backend (tombstone + future sync), never sent in.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub id: String,
    pub kind: String,
    pub source: String,
    pub project_id: Option<String>,
    pub agent_id: Option<String>,
    pub project_name: Option<String>,
    pub agent_name: Option<String>,
    pub text: String,
    pub created_at: i64,
}

/// A search result row. camelCase to match the `HistoryHit` TS interface. `text` is replaced by
/// `snippet` (FTS5 `snippet()` with `<b>..</b>` match markers around the hit).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: String,
    pub kind: String,
    pub source: String,
    pub project_id: Option<String>,
    pub agent_id: Option<String>,
    pub project_name: Option<String>,
    pub agent_name: Option<String>,
    pub snippet: String,
    pub created_at: i64,
}

/// One dot on the thread scrubber rail (bead `sparkle-7m719`).
///
/// PREFIX, NOT TEXT, and that is the whole reason this is a separate row type from [`Hit`]. The rail
/// draws a dot per prompt across a window that can be a YEAR wide; at the founder's measured rate
/// (1,234 prompts on 2026-08-05 alone, avg 573 chars) pulling full text for a 1y rail would move
/// tens of megabytes to render tooltips the reader may never hover. `substr(text, 1, 160)` is done
/// in SQL so the bytes never leave the database.
///
/// EVERY FIELD IS NON-OPTIONAL, deliberately. serde's derive emits `Option::None` as an explicit
/// `null` rather than omitting the key, and a hand-written TS parser typed `field?: T` describes a
/// shape the wire cannot produce — an all-or-nothing parser then discards the WHOLE payload and the
/// feature is silently inert (AGENTS.md records this costing two agents a full parallel build).
/// Nothing here can be absent, so the seam has no null to disagree about.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptMarker {
    /// The frontend's own id for the row. For `source = 'concierge'` this IS the concierge message
    /// id — `conciergeHistoryCapture.conversationEntry` writes `m.id` straight through — which is
    /// what lets the rail hand an id back to the thread and have it scroll to that exact bubble.
    pub id: String,
    pub created_at: i64,
    pub text_prefix: String,
}

/// A full history row inside a time range — what the thread pages IN when the rail is dragged past
/// the live window (`CONCIERGE_THREAD_MAX = 200` in `stores/conciergeThreadStore.ts`).
///
/// Carries whole `text`, unlike [`PromptMarker`]: these become rendered bubbles, so a prefix would
/// be a truncated message presented as the whole thing. Bounded by the caller's `limit`.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RangeRow {
    pub id: String,
    pub kind: String,
    pub created_at: i64,
    pub text: String,
}

impl HistoryDb {
    /// Open `<app_data>/history/history.db` (creating dirs), enable WAL, and ensure the schema.
    pub fn new(app_data_dir: &std::path::Path) -> Result<Self, String> {
        let dir = app_data_dir.join("history");
        std::fs::create_dir_all(&dir).map_err(|e| format!("create history dir: {e}"))?;
        // Owner-only: this DB stores prompt/response text in plaintext. Best-effort — a perms
        // failure must not block opening history.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        let db_path = dir.join("history.db");
        let conn = Connection::open(&db_path).map_err(|e| format!("open history.db: {e}"))?;
        // Owner-only on the FILE too, not just the directory above — security-audit finding M2.
        // SQLite creates history.db at the process umask default (verified: `-rw-r--r--`), so the
        // plaintext prompt/response corpus was world-readable inside an owner-only directory. Per
        // finding C1 this buys nothing against a same-UID agent (which can chmod it back), but it
        // is correct against other OS users and against backup/sync tools that copy modes along.
        // Best-effort and unix-only, matching the directory chmod; after `open` so the file exists.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o600));
        }
        // WAL for crash durability (a torn write can't corrupt the file). Note: all access is
        // serialized through the single `Mutex<Connection>` above, so WAL's read/write concurrency
        // isn't exercised here — it's kept for the durability guarantee, which is what we want.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("set WAL: {e}"))?;
        // The sidecars need the same treatment, and they are not covered by the chmod above. A
        // FRESH `-wal`/`-shm` does inherit the main file's mode, so on a clean install the line
        // above is enough — but a `-wal` left behind by a crash BEFORE this change keeps its old
        // `-rw-r--r--` and is reused as-is on the next open. That file holds the newest
        // uncheckpointed prompt/response text, i.e. exactly the plaintext M2 is about. Ordered
        // after the pragma so the files exist to be chmod'd; missing ones are simply ignored.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for suffix in ["-wal", "-shm"] {
                let mut side = db_path.clone().into_os_string();
                side.push(suffix);
                let _ = std::fs::set_permissions(
                    std::path::Path::new(&side),
                    std::fs::Permissions::from_mode(0o600),
                );
            }
        }
        init_schema(&conn).map_err(|e| format!("init schema: {e}"))?;
        Ok(Self { conn: Mutex::new(conn) })
    }
}

/// Create the `entries` table, its indexes, the FTS5 mirror, and the sync triggers. Idempotent.
fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS entries (
            id            TEXT PRIMARY KEY,
            kind          TEXT NOT NULL,
            source        TEXT NOT NULL,
            project_id    TEXT,
            agent_id      TEXT,
            project_name  TEXT,
            agent_name    TEXT,
            text          TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            deleted_at    INTEGER,
            synced_at     INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
        CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
            text,
            content='entries',
            content_rowid='rowid'
        );

        -- Keep the FTS mirror in lock-step with `entries`. The 'delete' command rows are the
        -- external-content table idiom for removing a doc from the index by rowid.
        CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
            INSERT INTO entries_fts(rowid, text) VALUES (new.rowid, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, text) VALUES('delete', old.rowid, old.text);
            INSERT INTO entries_fts(rowid, text) VALUES (new.rowid, new.text);
        END;
        "#,
    )
}

/// INSERT the entry; a duplicate `id` (idempotent re-capture) is silently ignored.
pub(crate) fn record_into(conn: &Connection, e: &EntryInput) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO entries
            (id, kind, source, project_id, agent_id, project_name, agent_name, text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            e.id,
            e.kind,
            e.source,
            e.project_id,
            e.agent_id,
            e.project_name,
            e.agent_name,
            e.text,
            e.created_at,
        ],
    )?;
    Ok(())
}

/// FTS5 search over live (non-tombstoned) rows. Blank query → empty. Punctuation in the query is
/// neutralized (each whitespace term is quoted) so it can never be parsed as FTS5 syntax.
pub(crate) fn search_in(conn: &Connection, query: &str, limit: u32) -> rusqlite::Result<Vec<Hit>> {
    let Some(match_expr) = fts_query(query) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT e.id, e.kind, e.source, e.project_id, e.agent_id, e.project_name, e.agent_name,
                snippet(entries_fts, 0, '<b>', '</b>', '…', 12) AS snippet, e.created_at
         FROM entries_fts
         JOIN entries e ON e.rowid = entries_fts.rowid
         WHERE entries_fts MATCH ?1 AND e.deleted_at IS NULL
         ORDER BY rank, e.created_at DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![match_expr, limit], |r| {
        Ok(Hit {
            id: r.get(0)?,
            kind: r.get(1)?,
            source: r.get(2)?,
            project_id: r.get(3)?,
            agent_id: r.get(4)?,
            project_name: r.get(5)?,
            agent_name: r.get(6)?,
            snippet: r.get(7)?,
            created_at: r.get(8)?,
        })
    })?;
    rows.collect()
}

/// The longest prompt prefix a rail tooltip ever needs. Chosen to fill the hover card in the
/// founder's mockup ("Prompt 2: Search public data sources to find me 20 people that are most like
/// Zoe: linkedin.com/in/siegelzoe -- I'm looking for…") and stop there.
pub(crate) const PROMPT_PREFIX_CHARS: i64 = 160;

/// Dots for the scrubber rail: the prompts of one `source` inside `[from_ms, to_ms]`, oldest-first.
///
/// ── WHY THE LIMIT IS APPLIED NEWEST-FIRST AND THE RESULT THEN REVERSED ────────────────────────
/// The obvious spelling — `ORDER BY created_at ASC LIMIT ?` — silently truncates the NEWEST end of
/// a busy window, so a 1y rail would draw last January and nothing since, which reads as "the rail
/// is broken" rather than "the rail is capped". Taking the newest `limit` rows and reversing them
/// in Rust keeps the recent end intact, which is the end a reader is actually near.
///
/// `deleted_at IS NULL` matches `search_in`: a tombstoned row is not live history. Concierge rows
/// are never age-tombstoned (see `prune_in_with_max`), but this query is source-agnostic and
/// `build` rows very much are.
pub(crate) fn prompts_in_range_in(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
    source: &str,
    limit: u32,
) -> rusqlite::Result<Vec<PromptMarker>> {
    let mut stmt = conn.prepare(
        "SELECT id, created_at, substr(text, 1, ?5) AS text_prefix
         FROM entries
         WHERE source = ?3
           AND kind = 'prompt'
           AND deleted_at IS NULL
           AND created_at >= ?1 AND created_at <= ?2
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?4",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![from_ms, to_ms, source, limit, PROMPT_PREFIX_CHARS],
        |r| {
            Ok(PromptMarker {
                id: r.get(0)?,
                created_at: r.get(1)?,
                text_prefix: r.get(2)?,
            })
        },
    )?;
    let mut out: Vec<PromptMarker> = rows.collect::<rusqlite::Result<_>>()?;
    // Newest-first came out of SQL so the LIMIT kept the right end; the rail wants a time axis.
    out.reverse();
    Ok(out)
}

/// Full rows inside `[from_ms, to_ms]`, oldest-first — the thread's backlog page.
///
/// Both kinds (`prompt` and `response`), because a paged-in window that showed only the questions
/// would be half a conversation. Same newest-first-then-reverse limiting as
/// [`prompts_in_range_in`], and for the same reason: dragging to an old prompt pages the window
/// ENDING at that prompt, so the rows nearest it are the ones that must survive the cap.
pub(crate) fn entries_in_range_in(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
    source: &str,
    limit: u32,
) -> rusqlite::Result<Vec<RangeRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, created_at, text
         FROM entries
         WHERE source = ?3
           AND deleted_at IS NULL
           AND created_at >= ?1 AND created_at <= ?2
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?4",
    )?;
    let rows = stmt.query_map(rusqlite::params![from_ms, to_ms, source, limit], |r| {
        Ok(RangeRow {
            id: r.get(0)?,
            kind: r.get(1)?,
            created_at: r.get(2)?,
            text: r.get(3)?,
        })
    })?;
    let mut out: Vec<RangeRow> = rows.collect::<rusqlite::Result<_>>()?;
    out.reverse();
    Ok(out)
}

/// How many `source = 'concierge'` rows we keep, newest-first.
///
/// AGE and COUNT are two DIFFERENT bounds, and concierge rows are deliberately exempt from the age
/// one: the founder's conversations with the concierge are kept forever, never aged out by the
/// 24h/retention-tier prune that governs `build` rows. "Forever" with no second bound is just
/// "unbounded", though — a table that only ever grows. This count bound is what makes keep-forever
/// SAFE: the newest `CONCIERGE_HISTORY_MAX` conversation rows are kept whatever their age, and
/// anything past that falls off the oldest end. At ~50k rows the corpus is still small (single-digit
/// MB of text) while being far more history than a human conversation will ever revisit.
pub(crate) const CONCIERGE_HISTORY_MAX: usize = 50_000;

/// Retention prune. Two independent bounds, both applied here so they run on the same existing
/// schedule and under the same lock:
///
/// * AGE — `Some(cutoff)` soft-deletes then hard-deletes every **non-concierge** row strictly older
///   than `cutoff`. `None` (the "indefinite" tier) skips the age bound entirely.
/// * COUNT — the concierge rows past the newest [`CONCIERGE_HISTORY_MAX`] are deleted. This runs on
///   EVERY call, `None` included: the count bound is independent of the age bound, so an indefinite
///   user still gets it (it is the only thing bounding concierge growth at all).
///
/// Returns the total number of rows hard-deleted, age-pruned plus count-trimmed.
pub(crate) fn prune_in(conn: &Connection, cutoff: Option<i64>) -> rusqlite::Result<usize> {
    prune_in_with_max(conn, cutoff, CONCIERGE_HISTORY_MAX)
}

/// [`prune_in`] with the concierge count cap injected, so tests can drive the cap with a handful of
/// rows instead of 50,000.
pub(crate) fn prune_in_with_max(
    conn: &Connection,
    cutoff: Option<i64>,
    concierge_max: usize,
) -> rusqlite::Result<usize> {
    let mut deleted = 0usize;
    // The AGE bound. Two-step soft-then-hard delete per the spec's retention contract: tombstone
    // (`deleted_at`), then hard-delete. Today the tombstone isn't separately observable (both run
    // under one lock in one call), but the step is intentional schema-readiness for the future
    // cloud-backup path, where prune would tombstone now and a later pass would hard-delete only
    // already-synced rows. Both statements exclude `source = 'concierge'`: concierge conversation is
    // kept forever and must never be aged out — it is bounded by count instead, below. The tombstone
    // needs the same exclusion as the delete, or a concierge row would survive as an invisible
    // soft-deleted row (`search_in` filters on `deleted_at IS NULL`), which is "kept" in name only.
    if let Some(cutoff) = cutoff {
        conn.execute(
            "UPDATE entries SET deleted_at = ?1
             WHERE created_at < ?1 AND deleted_at IS NULL AND source <> 'concierge'",
            rusqlite::params![cutoff],
        )?;
        deleted += conn.execute(
            "DELETE FROM entries WHERE created_at < ?1 AND source <> 'concierge'",
            rusqlite::params![cutoff],
        )?;
    }
    // The COUNT bound — outside the `if`, because it does not depend on the age tier.
    deleted += prune_concierge_count_in(conn, concierge_max)?;
    Ok(deleted)
}

/// Delete the OLDEST `source = 'concierge'` rows beyond the newest `max`. Returns rows deleted.
///
/// Straight to a hard delete, no tombstone step: the age path's tombstone exists for the future
/// cloud-backup handshake on *expired* rows, whereas this is an overflow bound on rows that are
/// never expiring — there is nothing for a later sync pass to reconcile. `rowid` breaks `created_at`
/// ties so the choice is deterministic (the frontend stamps `Date.now()`, which collides).
pub(crate) fn prune_concierge_count_in(
    conn: &Connection,
    max: usize,
) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM entries
         WHERE source = 'concierge'
           AND rowid NOT IN (
               SELECT rowid FROM entries
               WHERE source = 'concierge'
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?1
           )",
        rusqlite::params![max as i64],
    )
}

/// Turn a free-text query into a punctuation-safe FTS5 match expression: each whitespace-separated
/// term becomes a quoted string (internal `"` doubled), joined by spaces (implicit AND). Returns
/// `None` when there is no searchable term (blank / whitespace-only).
fn fts_query(query: &str) -> Option<String> {
    let expr = query
        .split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ");
    if expr.is_empty() {
        None
    } else {
        Some(expr)
    }
}

// ── WHY THESE THREE ARE `async` + `spawn_blocking` ────────────────────────────────────────────
// Every one of them holds `Mutex<Connection>` across real SQLite work against a WAL database on
// disk: `record` writes a row AND its FTS5 index entry, `search` runs an FTS5 `MATCH` with
// `snippet()` over the whole prompt/response corpus, and `prune` mass-UPDATEs then mass-DELETEs
// every row past the cutoff (de-indexing each from FTS5 as it goes — thousands of rows on a
// long-lived install's first run). As plain `#[tauri::command]`s all of that executed on the AppKit
// main thread, and `prune` is additionally driven by a `setInterval` from `main.tsx`.
//
// They take `AppHandle` rather than `State<HistoryDb>` because `State<'_, T>` borrows from the
// invoke and so cannot cross a thread boundary; the handle is owned, `'static`, and resolves the
// same managed value inside the closure. Both are injected by Tauri, so the JS call signature is
// UNCHANGED — the frontend still passes only `entry` / `query`+`limit` / `cutoff_ms`.
//
// ── WHY `try_state` AND NOT `state` ───────────────────────────────────────────────────────────
// `HistoryDb` is managed CONDITIONALLY: `lib.rs` only calls `manage` if `HistoryDb::new` succeeded,
// because "a failure here must not stop the app from booting — capture/search just won't work."
// Tauri's `State` extractor returned a clean `InvokeError` in that case, but `Manager::state`
// PANICS ("state() called before manage() for …"). That panic would fire inside `spawn_blocking`
// — caught by tokio, so the user sees an error string — but on the way out it passes through the
// chained panic hook in `crash.rs`, which force-captures a backtrace and writes an UPLOADABLE crash
// record. `history_record` runs on every prompt and every response, so a user whose history DB
// failed to open would generate a false crash record per capture. `try_state` keeps the original
// contract: the feature degrades, the app does not report a crash.
fn history_db(app: &AppHandle) -> Result<tauri::State<'_, HistoryDb>, String> {
    app.try_state::<HistoryDb>()
        .ok_or_else(|| "history: DB unavailable (init failed at boot)".to_string())
}

#[tauri::command]
pub async fn history_record(app: AppHandle, entry: EntryInput) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = history_db(&app)?;
        // Poison-tolerant: a panic mid-query poisons the Mutex<Connection>; the recovered guard
        // still points at a valid SQLite connection, so don't permanently brick history on it.
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        record_into(&conn, &entry).map_err(|e| format!("record: {e}"))
    })
    .await
    .map_err(|e| format!("history_record task failed: {e}"))?
}

#[tauri::command]
pub async fn history_search(
    app: AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<Hit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = history_db(&app)?;
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        search_in(&conn, &query, limit.unwrap_or(50)).map_err(|e| format!("search: {e}"))
    })
    .await
    .map_err(|e| format!("history_search task failed: {e}"))?
}

#[tauri::command]
pub async fn history_prune(app: AppHandle, cutoff_ms: Option<i64>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = history_db(&app)?;
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        prune_in(&conn, cutoff_ms).map_err(|e| format!("prune: {e}"))
    })
    .await
    .map_err(|e| format!("history_prune task failed: {e}"))?
}

/// Default dot budget for one rail. Above this the rail is denser than pixels anyway — the
/// frontend clusters dots that land within ~6px of each other — so more rows would be drawn on top
/// of one another at real cost.
const PROMPTS_IN_RANGE_DEFAULT_LIMIT: u32 = 4_000;

/// Default backlog page. ~20x the live thread's `CONCIERGE_THREAD_MAX` of 200, which is a deep
/// enough scrollback around one jump target without rendering a day of conversation at once.
const ENTRIES_IN_RANGE_DEFAULT_LIMIT: u32 = 400;

#[tauri::command]
pub async fn history_prompts_in_range(
    app: AppHandle,
    from_ms: i64,
    to_ms: i64,
    source: String,
    limit: Option<u32>,
) -> Result<Vec<PromptMarker>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = history_db(&app)?;
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        prompts_in_range_in(
            &conn,
            from_ms,
            to_ms,
            &source,
            limit.unwrap_or(PROMPTS_IN_RANGE_DEFAULT_LIMIT),
        )
        .map_err(|e| format!("prompts_in_range: {e}"))
    })
    .await
    .map_err(|e| format!("history_prompts_in_range task failed: {e}"))?
}

#[tauri::command]
pub async fn history_entries_in_range(
    app: AppHandle,
    from_ms: i64,
    to_ms: i64,
    source: String,
    limit: Option<u32>,
) -> Result<Vec<RangeRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = history_db(&app)?;
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        entries_in_range_in(
            &conn,
            from_ms,
            to_ms,
            &source,
            limit.unwrap_or(ENTRIES_IN_RANGE_DEFAULT_LIMIT),
        )
        .map_err(|e| format!("entries_in_range: {e}"))
    })
    .await
    .map_err(|e| format!("history_entries_in_range task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0)).unwrap()
    }

    /// Surviving ids, oldest-first — so a count-cap assertion names WHICH rows were kept, not just
    /// how many.
    fn ids(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT id FROM entries ORDER BY created_at ASC, rowid ASC")
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    fn entry(id: &str, kind: &str, text: &str, created_at: i64) -> EntryInput {
        sourced_entry("build", id, kind, text, created_at)
    }

    /// A concierge-sourced row — same shape as `entry`, only `source` differs, which is exactly the
    /// column the retention rules key on.
    fn concierge(id: &str, text: &str, created_at: i64) -> EntryInput {
        sourced_entry("concierge", id, "prompt", text, created_at)
    }

    fn sourced_entry(
        source: &str,
        id: &str,
        kind: &str,
        text: &str,
        created_at: i64,
    ) -> EntryInput {
        EntryInput {
            id: id.into(),
            kind: kind.into(),
            source: source.into(),
            project_id: Some("p1".into()),
            agent_id: Some("a1".into()),
            project_name: Some("Proj".into()),
            agent_name: Some("Agent".into()),
            text: text.into(),
            created_at,
        }
    }

    #[test]
    fn record_then_search_round_trips_with_snippet() {
        let conn = mem();
        record_into(&conn, &entry("1", "prompt", "learning rust is fun", 1000)).unwrap();
        let hits = search_in(&conn, "rust", 50).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "1");
        assert_eq!(hits[0].kind, "prompt");
        // snippet() wraps the matched term in <b>..</b>.
        assert!(hits[0].snippet.contains("<b>rust</b>"), "snippet was {:?}", hits[0].snippet);
    }

    #[test]
    fn blank_query_returns_empty() {
        let conn = mem();
        record_into(&conn, &entry("1", "prompt", "hello world", 1000)).unwrap();
        assert!(search_in(&conn, "", 50).unwrap().is_empty());
        assert!(search_in(&conn, "   ", 50).unwrap().is_empty());
    }

    #[test]
    fn search_tolerates_punctuation_without_erroring() {
        let conn = mem();
        record_into(&conn, &entry("1", "prompt", "the rust compiler", 1000)).unwrap();
        // A query of raw FTS5 metacharacters must not throw — quoting neutralizes it (it just
        // matches nothing here). The point is Ok, not a particular count.
        assert!(search_in(&conn, "\"OR (* AND", 50).is_ok());
        // Trailing punctuation on a real term is tokenized away inside the quoted phrase, so the
        // term still matches its row.
        assert_eq!(search_in(&conn, "rust!", 50).unwrap().len(), 1);
    }

    #[test]
    fn duplicate_id_is_ignored() {
        let conn = mem();
        record_into(&conn, &entry("1", "prompt", "first text", 1000)).unwrap();
        // INSERT OR IGNORE: same id, different text — the second write is a no-op.
        record_into(&conn, &entry("1", "prompt", "second text", 2000)).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // Original row survived; the FTS index still points at the original text.
        assert_eq!(search_in(&conn, "first", 50).unwrap().len(), 1);
        assert_eq!(search_in(&conn, "second", 50).unwrap().len(), 0);
    }

    #[test]
    fn search_orders_newest_first_within_rank() {
        let conn = mem();
        record_into(&conn, &entry("old", "prompt", "rust rust", 1000)).unwrap();
        record_into(&conn, &entry("new", "prompt", "rust rust", 2000)).unwrap();
        let hits = search_in(&conn, "rust", 50).unwrap();
        assert_eq!(hits.len(), 2);
        // Equal rank → created_at DESC, so the newer row comes first.
        assert_eq!(hits[0].id, "new");
        assert_eq!(hits[1].id, "old");
    }

    #[test]
    fn search_excludes_soft_deleted_rows() {
        let conn = mem();
        record_into(&conn, &entry("1", "prompt", "rust matters", 1000)).unwrap();
        conn.execute("UPDATE entries SET deleted_at = 5 WHERE id = '1'", []).unwrap();
        assert!(search_in(&conn, "rust", 50).unwrap().is_empty());
    }

    #[test]
    fn prune_none_does_no_age_deletion() {
        // `None` is the "indefinite" tier: NO age bound at all, however old the row. It is no longer
        // a whole-function no-op — the concierge count bound still runs — so this pins the age half
        // specifically: nothing is deleted and nothing is tombstoned.
        let conn = mem();
        record_into(&conn, &entry("1", "prompt", "keep me", 1000)).unwrap();
        assert_eq!(prune_in(&conn, None).unwrap(), 0);
        assert_eq!(count(&conn), 1);
        let tombstoned: i64 = conn
            .query_row("SELECT COUNT(*) FROM entries WHERE deleted_at IS NOT NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tombstoned, 0);
    }

    #[test]
    fn prune_deletes_only_rows_older_than_cutoff() {
        let conn = mem();
        record_into(&conn, &entry("old", "prompt", "old text", 1000)).unwrap();
        record_into(&conn, &entry("new", "prompt", "new text", 3000)).unwrap();
        // cutoff = 2000 → only the row at 1000 is older.
        let deleted = prune_in(&conn, Some(2000)).unwrap();
        assert_eq!(deleted, 1);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let id: String =
            conn.query_row("SELECT id FROM entries", [], |r| r.get(0)).unwrap();
        assert_eq!(id, "new");
    }

    #[test]
    fn prune_soft_then_hard_leaves_zero_rows() {
        let conn = mem();
        record_into(&conn, &entry("1", "prompt", "stale", 1000)).unwrap();
        let deleted = prune_in(&conn, Some(2000)).unwrap();
        assert_eq!(deleted, 1);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        // And the FTS mirror was kept in sync by the delete trigger — no orphan match.
        assert!(search_in(&conn, "stale", 50).unwrap().is_empty());
    }

    // ── Concierge retention: kept forever by AGE, bounded by COUNT ─────────────────────────────

    #[test]
    fn prune_keeps_concierge_and_deletes_a_build_row_of_the_same_age() {
        // The paired assertion is the point: asserting only that the concierge row survived would
        // also pass if the prune had silently done nothing at all (a wrong cutoff, an early return).
        // The build row at the SAME created_at is the control that proves the prune really ran and
        // that `source` is the thing that spared the other row.
        let conn = mem();
        record_into(&conn, &entry("build-old", "prompt", "build text", 1000)).unwrap();
        record_into(&conn, &concierge("conc-old", "concierge text", 1000)).unwrap();

        let deleted = prune_in(&conn, Some(2000)).unwrap();

        assert_eq!(deleted, 1, "only the build row should have been hard-deleted");
        assert_eq!(ids(&conn), vec!["conc-old".to_string()]);
        // …and it is a LIVE row, not an invisible tombstone: the soft-delete step must carry the
        // same exclusion as the hard delete, or the row is "kept" but unsearchable.
        let deleted_at: Option<i64> = conn
            .query_row("SELECT deleted_at FROM entries WHERE id = 'conc-old'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(deleted_at, None, "concierge row was tombstoned by the soft-delete step");
        assert_eq!(search_in(&conn, "concierge", 50).unwrap().len(), 1);
        assert!(search_in(&conn, "build", 50).unwrap().is_empty());
    }

    #[test]
    fn concierge_count_cap_deletes_the_oldest_beyond_max() {
        // Drive the cap with an injected max of 3 rather than the 50k const — an injectable seam so
        // the mechanism is actually exercised instead of asserted around.
        let conn = mem();
        for i in 0..5 {
            record_into(&conn, &concierge(&format!("c{i}"), "chat", 1000 + i)).unwrap();
        }
        let deleted = prune_concierge_count_in(&conn, 3).unwrap();
        assert_eq!(deleted, 2);
        // Newest 3 kept, oldest 2 gone — not merely "3 rows remain".
        assert_eq!(ids(&conn), vec!["c2".to_string(), "c3".to_string(), "c4".to_string()]);
    }

    #[test]
    fn concierge_count_cap_under_max_deletes_nothing() {
        let conn = mem();
        for i in 0..3 {
            record_into(&conn, &concierge(&format!("c{i}"), "chat", 1000 + i)).unwrap();
        }
        assert_eq!(prune_concierge_count_in(&conn, 3).unwrap(), 0);
        assert_eq!(count(&conn), 3);
    }

    #[test]
    fn concierge_count_cap_ignores_build_rows() {
        // The cap is a bound on concierge rows only — build rows must neither be deleted by it nor
        // consume slots in it. With max=2 and 3 build rows present, only the oldest concierge row
        // may go.
        let conn = mem();
        for i in 0..3 {
            record_into(&conn, &entry(&format!("b{i}"), "prompt", "build", 1000 + i)).unwrap();
        }
        for i in 0..3 {
            record_into(&conn, &concierge(&format!("c{i}"), "chat", 2000 + i)).unwrap();
        }
        assert_eq!(prune_concierge_count_in(&conn, 2).unwrap(), 1);
        assert_eq!(
            ids(&conn),
            vec!["b0", "b1", "b2", "c1", "c2"].into_iter().map(String::from).collect::<Vec<_>>()
        );
    }

    #[test]
    fn count_cap_still_runs_when_cutoff_is_none() {
        // The indefinite tier is the case most likely to regress: `prune_in` used to early-return on
        // `None`, and the count bound is the ONLY thing bounding concierge growth. So `None` must
        // still trim by count while doing no age deletion at all — the old build row proves the age
        // bound really was skipped in the same call.
        let conn = mem();
        record_into(&conn, &entry("build-ancient", "prompt", "build", 1)).unwrap();
        for i in 0..4 {
            record_into(&conn, &concierge(&format!("c{i}"), "chat", 1000 + i)).unwrap();
        }
        let deleted = prune_in_with_max(&conn, None, 2).unwrap();
        assert_eq!(deleted, 2, "the two oldest concierge rows should be count-trimmed");
        assert_eq!(
            ids(&conn),
            vec!["build-ancient", "c2", "c3"].into_iter().map(String::from).collect::<Vec<_>>(),
            "no age deletion under None, but the count cap still applied"
        );
    }

    #[test]
    fn prune_in_with_max_returns_age_plus_count_deletions() {
        // The returned count is documented as both bounds summed; prove it can be > either alone.
        let conn = mem();
        record_into(&conn, &entry("b-old", "prompt", "build", 1000)).unwrap();
        for i in 0..4 {
            record_into(&conn, &concierge(&format!("c{i}"), "chat", 1000 + i)).unwrap();
        }
        // 1 build row aged out + 2 concierge rows over the cap of 2.
        assert_eq!(prune_in_with_max(&conn, Some(2000), 2).unwrap(), 3);
        assert_eq!(count(&conn), 2);
    }

    #[test]
    fn count_cap_delete_leaves_no_orphan_fts_match() {
        // Mirrors `prune_soft_then_hard_leaves_zero_rows` for the count path: the `entries_ad`
        // trigger must de-index the row, or search would keep returning a hit whose JOIN row is gone.
        let conn = mem();
        record_into(&conn, &concierge("c0", "stalechat", 1000)).unwrap();
        record_into(&conn, &concierge("c1", "freshchat", 2000)).unwrap();
        assert_eq!(search_in(&conn, "stalechat", 50).unwrap().len(), 1);
        assert_eq!(prune_concierge_count_in(&conn, 1).unwrap(), 1);
        assert!(search_in(&conn, "stalechat", 50).unwrap().is_empty());
        assert_eq!(search_in(&conn, "freshchat", 50).unwrap().len(), 1);
    }

    #[test]
    fn update_trigger_reindexes_changed_text() {
        // The `entries_au` AFTER UPDATE trigger keeps the FTS mirror in sync when `text` changes
        // (the external-content delete+reinsert idiom). Production only INSERT-OR-IGNOREs today,
        // but a future sync path may rewrite `text`, so prove the trigger actually re-indexes.
        let conn = mem();
        record_into(&conn, &entry("1", "prompt", "alpha term", 1000)).unwrap();
        assert_eq!(search_in(&conn, "alpha", 50).unwrap().len(), 1);
        conn.execute("UPDATE entries SET text = 'omega term' WHERE id = '1'", []).unwrap();
        // Old term no longer matches; the new term does.
        assert!(search_in(&conn, "alpha", 50).unwrap().is_empty());
        assert_eq!(search_in(&conn, "omega", 50).unwrap().len(), 1);
    }

    /// Security-audit finding M2: the db FILE, not just its directory, must be owner-only.
    ///
    /// The starting mode is set EXPLICITLY to 0644 rather than inherited from the ambient umask.
    /// That is the whole point of the setup: a fresh `Connection::open` creates the file at
    /// `0666 & ~umask`, so under a hardened `0077` umask SQLite already lands on 0600 and this
    /// assertion would pass with the `set_permissions` call deleted — a guard that holds only on
    /// the machine it was written on. Pre-creating at 0644 and re-opening makes the assertion about
    /// our chmod instead of about the environment.
    #[cfg(unix)]
    #[test]
    fn history_db_file_is_owner_only_regardless_of_umask() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("history");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.db");
        // A world-readable, pre-existing db — the upgrade case, and a mode no umask can produce
        // by accident here.
        std::fs::File::create(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o644);

        let db = HistoryDb::new(tmp.path()).unwrap();
        drop(db);

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "history.db mode was {mode:o}, expected 600");
    }

    /// The `-wal` sidecar holds the newest uncheckpointed prompt/response text. A fresh one inherits
    /// the main file's mode, but one left by a pre-upgrade crash keeps its old world-readable mode
    /// and is reused on the next open — so seed exactly that case, at 0644, and prove the open
    /// tightens it. Same reasoning as the test above: the mode is set explicitly, never inherited.
    ///
    /// The FIRST connection is deliberately held open for the whole test. SQLite checkpoints and
    /// DELETES the `-wal` on a clean close, so a version of this that dropped the db before looking
    /// found no sidecar and skipped its assertion — passing with the chmod removed. Holding the
    /// connection is what keeps the file on disk, and the `wal.exists()` assert below is a hard
    /// failure precisely so the test can never silently skip that way again.
    #[cfg(unix)]
    #[test]
    fn history_db_wal_sidecar_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let held = HistoryDb::new(tmp.path()).unwrap();
        {
            let conn = held.conn.lock().unwrap();
            record_into(&conn, &concierge("c0", "chat", 1000)).unwrap();
        }
        let wal = tmp.path().join("history").join("history.db-wal");
        assert!(wal.exists(), "expected a -wal to exist while a connection is open");
        // The upgrade case: a sidecar carrying the old world-readable mode.
        std::fs::set_permissions(&wal, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(std::fs::metadata(&wal).unwrap().permissions().mode() & 0o777, 0o644);

        // A second open of the same DB — the next app launch — must tighten it.
        let reopened = HistoryDb::new(tmp.path()).unwrap();

        let mode = std::fs::metadata(&wal).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "history.db-wal mode was {mode:o}, expected 600");
        drop(reopened);
        drop(held);
    }

    #[test]
    fn search_respects_limit() {
        let conn = mem();
        for i in 0..5 {
            record_into(&conn, &entry(&format!("{i}"), "prompt", "rust", 1000 + i)).unwrap();
        }
        assert_eq!(search_in(&conn, "rust", 2).unwrap().len(), 2);
    }

    // ── SCRUBBER RAIL RANGE QUERIES (bead sparkle-7m719) ─────────────────────────────────────

    /// A `source = 'concierge'` response row — the rail must NOT draw a dot for one, and the
    /// backlog page MUST include it.
    fn concierge_response(id: &str, text: &str, created_at: i64) -> EntryInput {
        sourced_entry("concierge", id, "response", text, created_at)
    }

    fn marker_ids(rows: &[PromptMarker]) -> Vec<&str> {
        rows.iter().map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn prompts_in_range_returns_concierge_prompts_oldest_first() {
        let conn = mem();
        // Deliberately inserted out of order, so passing this cannot be an accident of insert order.
        record_into(&conn, &concierge("c3", "third", 3_000)).unwrap();
        record_into(&conn, &concierge("c1", "first", 1_000)).unwrap();
        record_into(&conn, &concierge("c2", "second", 2_000)).unwrap();

        let got = prompts_in_range_in(&conn, 0, 10_000, "concierge", 100).unwrap();
        assert_eq!(marker_ids(&got), vec!["c1", "c2", "c3"]);
        assert_eq!(got[0].created_at, 1_000);
        assert_eq!(got[0].text_prefix, "first");
    }

    #[test]
    fn prompts_in_range_excludes_responses_other_sources_and_tombstones() {
        let conn = mem();
        record_into(&conn, &concierge("keep", "a question", 1_000)).unwrap();
        record_into(&conn, &concierge_response("resp", "an answer", 1_100)).unwrap();
        record_into(&conn, &entry("build", "prompt", "a build prompt", 1_200)).unwrap();
        record_into(&conn, &concierge("dead", "tombstoned", 1_300)).unwrap();
        conn.execute("UPDATE entries SET deleted_at = 9 WHERE id = 'dead'", []).unwrap();

        // Every excluded row IS in the table and IS inside the window — so this asserts the WHERE
        // clause, not an empty database.
        assert_eq!(count(&conn), 4);
        assert_eq!(marker_ids(&prompts_in_range_in(&conn, 0, 10_000, "concierge", 100).unwrap()), vec!["keep"]);
    }

    #[test]
    fn prompts_in_range_window_bounds_are_inclusive_and_exclude_outside() {
        let conn = mem();
        record_into(&conn, &concierge("before", "too old", 999)).unwrap();
        record_into(&conn, &concierge("lo", "on the lower bound", 1_000)).unwrap();
        record_into(&conn, &concierge("hi", "on the upper bound", 2_000)).unwrap();
        record_into(&conn, &concierge("after", "too new", 2_001)).unwrap();

        let got = prompts_in_range_in(&conn, 1_000, 2_000, "concierge", 100).unwrap();
        assert_eq!(marker_ids(&got), vec!["lo", "hi"]);
    }

    /// THE LIMIT KEEPS THE NEWEST ROWS, NOT THE OLDEST — the whole reason the query orders DESC and
    /// the result is reversed in Rust. Written against a window that is deliberately WIDER than the
    /// data: `ORDER BY created_at ASC LIMIT 2` would answer c1,c2 here, which is a rail showing the
    /// distant past and nothing recent. Mutating the DESC (or dropping the `reverse`) reds this.
    #[test]
    fn prompts_in_range_limit_keeps_the_newest_rows_still_oldest_first() {
        let conn = mem();
        for i in 1..=5 {
            record_into(&conn, &concierge(&format!("c{i}"), "q", i * 1_000)).unwrap();
        }
        let got = prompts_in_range_in(&conn, 0, 100_000, "concierge", 2).unwrap();
        assert_eq!(marker_ids(&got), vec!["c4", "c5"], "the limit must drop the OLDEST end");
    }

    #[test]
    fn prompts_in_range_truncates_long_text_to_the_prefix_cap() {
        let conn = mem();
        let long = "x".repeat(500);
        record_into(&conn, &concierge("long", &long, 1_000)).unwrap();
        record_into(&conn, &concierge("short", "hi", 1_100)).unwrap();

        let got = prompts_in_range_in(&conn, 0, 10_000, "concierge", 100).unwrap();
        assert_eq!(got[0].text_prefix.chars().count(), PROMPT_PREFIX_CHARS as usize);
        // …and a short prompt is returned whole, not padded or clipped to something shorter.
        assert_eq!(got[1].text_prefix, "hi");
    }

    #[test]
    fn entries_in_range_returns_both_kinds_with_full_text_oldest_first() {
        let conn = mem();
        let long = "y".repeat(500);
        record_into(&conn, &concierge("q", &long, 1_000)).unwrap();
        record_into(&conn, &concierge_response("a", "an answer", 1_100)).unwrap();
        record_into(&conn, &entry("build", "prompt", "not mine", 1_050)).unwrap();

        let got = entries_in_range_in(&conn, 0, 10_000, "concierge", 100).unwrap();
        assert_eq!(got.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["q", "a"]);
        assert_eq!(got[0].kind, "prompt");
        assert_eq!(got[1].kind, "response");
        // FULL text, unlike the rail's prefix — a paged-in bubble must not be a truncated message
        // presented as the whole thing.
        assert_eq!(got[0].text.chars().count(), 500);
    }

    /// THE SEAM PIN. Both halves of this wire are separately green even when they disagree — the
    /// Rust suite never sees the TS types and vice versa — which is exactly how a feature ships
    /// completely inert. So the field NAMES are asserted against the one fixture the TypeScript
    /// suite also parses (`services/history.wire.test.ts`): rename a field on either side and BOTH
    /// suites go red, rather than neither.
    #[test]
    fn range_row_shapes_match_the_shared_wire_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("shared")
            .join("history-range-wire.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let fixture: serde_json::Value = serde_json::from_str(&raw).expect("fixture is valid JSON");
        assert_eq!(fixture["version"].as_i64(), Some(1), "wire version is frozen at 1");

        let marker = PromptMarker {
            id: "you-42".into(),
            created_at: 1_754_400_000_000,
            text_prefix: "Search public data sources to find me 20 people that are most like Zoe"
                .into(),
        };
        assert_eq!(
            serde_json::to_value(&marker).unwrap(),
            fixture["promptMarker"],
            "PromptMarker drifted from apps/desktop/shared/history-range-wire.json"
        );

        let row = RangeRow {
            id: "you-42".into(),
            kind: "prompt".into(),
            created_at: 1_754_400_000_000,
            text: "Search public data sources to find me 20 people that are most like Zoe: I'm looking for..."
                .into(),
        };
        assert_eq!(
            serde_json::to_value(&row).unwrap(),
            fixture["rangeRow"],
            "RangeRow drifted from apps/desktop/shared/history-range-wire.json"
        );
    }

    /// `entries_in_range_in`'s OWN filters, not `prompts_in_range_in`'s (roborev 66374).
    ///
    /// The two are independent SQL strings, not a shared clause, so the coverage on one says
    /// nothing about the other: deleting `AND deleted_at IS NULL` from THIS query left the whole
    /// suite green. The user-visible consequence is a retention hole — a pruned or tombstoned row
    /// would reappear as a rendered bubble the moment the rail pages that window in, and this
    /// backlog read is the only place that happens.
    #[test]
    fn entries_in_range_excludes_tombstones_other_sources_and_out_of_window_rows() {
        let conn = mem();
        record_into(&conn, &concierge("keep", "in window", 1_500)).unwrap();
        record_into(&conn, &concierge_response("keep-a", "its answer", 1_600)).unwrap();
        record_into(&conn, &concierge("dead", "tombstoned", 1_700)).unwrap();
        conn.execute("UPDATE entries SET deleted_at = 9 WHERE id = 'dead'", []).unwrap();
        record_into(&conn, &entry("build", "prompt", "another source", 1_800)).unwrap();
        record_into(&conn, &concierge("before", "too old", 999)).unwrap();
        record_into(&conn, &concierge("after", "too new", 2_001)).unwrap();

        // Every excluded row IS in the table, so this asserts the WHERE clause and not an empty DB.
        assert_eq!(count(&conn), 6);
        let got = entries_in_range_in(&conn, 1_000, 2_000, "concierge", 100).unwrap();
        assert_eq!(
            got.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["keep", "keep-a"]
        );
    }

    /// The window bounds are INCLUSIVE at both ends, asserted for this query in its own right.
    #[test]
    fn entries_in_range_window_bounds_are_inclusive() {
        let conn = mem();
        record_into(&conn, &concierge("lo", "on the lower bound", 1_000)).unwrap();
        record_into(&conn, &concierge("hi", "on the upper bound", 2_000)).unwrap();
        let got = entries_in_range_in(&conn, 1_000, 2_000, "concierge", 100).unwrap();
        assert_eq!(got.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["lo", "hi"]);
    }

    #[test]
    fn entries_in_range_limit_keeps_the_newest_rows_still_oldest_first() {
        let conn = mem();
        for i in 1..=5 {
            record_into(&conn, &concierge(&format!("c{i}"), "q", i * 1_000)).unwrap();
        }
        let got = entries_in_range_in(&conn, 0, 100_000, "concierge", 2).unwrap();
        assert_eq!(got.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["c4", "c5"]);
    }
}
