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
use tauri::State;

/// Managed Tauri state: the single history DB connection behind a mutex (SQLite is fine for a
/// single guarded connection; our access is low-frequency capture + the occasional search/prune).
pub struct HistoryDb {
    conn: Mutex<Connection>,
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
        let conn = Connection::open(dir.join("history.db"))
            .map_err(|e| format!("open history.db: {e}"))?;
        // WAL for crash durability (a torn write can't corrupt the file). Note: all access is
        // serialized through the single `Mutex<Connection>` above, so WAL's read/write concurrency
        // isn't exercised here — it's kept for the durability guarantee, which is what we want.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("set WAL: {e}"))?;
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
fn record_into(conn: &Connection, e: &EntryInput) -> rusqlite::Result<()> {
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
fn search_in(conn: &Connection, query: &str, limit: u32) -> rusqlite::Result<Vec<Hit>> {
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

/// Retention prune. `None` (indefinite) → no-op, 0. `Some(cutoff)` → soft-delete then hard-delete
/// every row strictly older than `cutoff`; returns the number of rows hard-deleted.
fn prune_in(conn: &Connection, cutoff: Option<i64>) -> rusqlite::Result<usize> {
    let Some(cutoff) = cutoff else {
        return Ok(0);
    };
    // Two-step soft-then-hard delete per the spec's retention contract: tombstone (`deleted_at`),
    // then hard-delete. Today the tombstone isn't separately observable (both run under one lock in
    // one call), but the step is intentional schema-readiness for the future cloud-backup path,
    // where prune would tombstone now and a later pass would hard-delete only already-synced rows.
    conn.execute(
        "UPDATE entries SET deleted_at = ?1 WHERE created_at < ?1 AND deleted_at IS NULL",
        rusqlite::params![cutoff],
    )?;
    let deleted = conn.execute(
        "DELETE FROM entries WHERE created_at < ?1",
        rusqlite::params![cutoff],
    )?;
    Ok(deleted)
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

#[tauri::command]
pub fn history_record(db: State<HistoryDb>, entry: EntryInput) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| format!("lock: {e}"))?;
    record_into(&conn, &entry).map_err(|e| format!("record: {e}"))
}

#[tauri::command]
pub fn history_search(
    db: State<HistoryDb>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<Hit>, String> {
    let conn = db.conn.lock().map_err(|e| format!("lock: {e}"))?;
    search_in(&conn, &query, limit.unwrap_or(50)).map_err(|e| format!("search: {e}"))
}

#[tauri::command]
pub fn history_prune(db: State<HistoryDb>, cutoff_ms: Option<i64>) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| format!("lock: {e}"))?;
    prune_in(&conn, cutoff_ms).map_err(|e| format!("prune: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn entry(id: &str, kind: &str, text: &str, created_at: i64) -> EntryInput {
        EntryInput {
            id: id.into(),
            kind: kind.into(),
            source: "build".into(),
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
    fn prune_none_is_a_noop() {
        let conn = mem();
        record_into(&conn, &entry("1", "prompt", "keep me", 1000)).unwrap();
        assert_eq!(prune_in(&conn, None).unwrap(), 0);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
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

    #[test]
    fn search_respects_limit() {
        let conn = mem();
        for i in 0..5 {
            record_into(&conn, &entry(&format!("{i}"), "prompt", "rust", 1000 + i)).unwrap();
        }
        assert_eq!(search_in(&conn, "rust", 2).unwrap().len(), 2);
    }
}
