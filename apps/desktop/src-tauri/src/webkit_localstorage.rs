//! WebKit `localStorage` SQLite WAL maintenance.
//!
//! On macOS a Tauri app's `localStorage` is backed by an on-disk SQLite database WebKit owns at
//! `~/Library/WebKit/<bundle-id>/WebsiteData/Default/**/LocalStorage/localstorage.sqlite3`. That DB
//! runs in WAL mode, and WebKit is supposed to checkpoint the write-ahead log back into the main
//! file and truncate it on its own schedule. On the founder's machine it never did: the main file
//! was 4.4 MB while `localstorage.sqlite3-wal` reached **3.65 GB and was still growing** — 821x the
//! database, wasting disk and forcing every synchronous `localStorage` read on the main thread to
//! replay a multi-gigabyte WAL frame index (`sparkle-i061ug`).
//!
//! A passive WebKit checkpoint cannot truncate the WAL while any connection holds a read lock that
//! spans it, and Sparkle's zustand `persist` middleware rewrites whole store blobs on nearly every
//! `setState`, so the write rate outruns whatever passive checkpoint WebKit attempts. Rather than
//! wait on WebKit, Sparkle owns the checkpoint: a second SQLite connection runs
//! `PRAGMA wal_checkpoint(TRUNCATE)`, which flushes every committed frame into the main database and
//! then truncates the `-wal` file to zero bytes. This is coordinated through SQLite's shared-memory
//! index, so it is safe to run against the same file WebKit has open — it is emphatically **not** the
//! same as deleting the `-wal`, which would drop committed-but-not-yet-checkpointed state.
//!
//! [`spawn_maintenance`] runs one checkpoint immediately at launch (the cleanest window — nothing has
//! opened the webview yet) and then again on a fixed interval, so the WAL cannot grow unbounded
//! across a long-running session either. Everything is best-effort: a failure here only means the
//! WAL stays large, never that the app fails to boot.

#[cfg(any(target_os = "macos", test))]
use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// How long a checkpoint connection waits for WebKit's connection to yield a lock before giving up.
/// A checkpoint that cannot get the lock right now simply runs again next interval; it must never
/// wedge the maintenance thread.
const BUSY_TIMEOUT_MS: u32 = 2_000;

/// Interval between periodic checkpoints during a live session. WebKit's own passive checkpoint is
/// what failed to keep up, so this only has to be frequent enough that the WAL never reaches the
/// gigabytes the bug produced — not tight.
#[cfg(target_os = "macos")]
const CHECKPOINT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(300);

/// Bound on how deep [`find_localstorage_dbs`] descends. The real layout is
/// `WebsiteData/Default/<hash>/<hash>/LocalStorage/localstorage.sqlite3` (depth 5 below the base);
/// the cap keeps a surprise symlink or a pathological tree from turning discovery into an unbounded
/// walk on the launch-adjacent maintenance thread.
const MAX_WALK_DEPTH: usize = 8;

/// The filename WebKit gives every per-origin localStorage database.
const LOCALSTORAGE_DB_NAME: &str = "localstorage.sqlite3";

/// Outcome of one `PRAGMA wal_checkpoint(TRUNCATE)` against a single database, plus the `-wal` file
/// size on either side so a caller (and the test) can assert the truncation actually happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CheckpointOutcome {
    /// The pragma's first column: `0` means the checkpoint completed and the WAL was truncated;
    /// non-zero means a reader held a lock and the truncation was skipped (we just try again later).
    pub busy: i64,
    /// The pragma's second column: total frames in the WAL that were checkpointed (or would be).
    pub wal_frames: i64,
    /// The pragma's third column: frames actually moved into the main database.
    pub checkpointed: i64,
    /// Size of the `-wal` sidecar before the checkpoint, in bytes.
    pub wal_bytes_before: u64,
    /// Size of the `-wal` sidecar after the checkpoint, in bytes. `0` after a `busy == 0` run.
    pub wal_bytes_after: u64,
}

/// The `-wal` sidecar path for a SQLite database path.
#[cfg(any(target_os = "macos", test))]
fn wal_path(db_path: &Path) -> PathBuf {
    let mut s = db_path.as_os_str().to_os_string();
    s.push("-wal");
    PathBuf::from(s)
}

/// Size of a file in bytes, or `0` if it does not exist / cannot be stat'd. A missing `-wal` after a
/// checkpoint is the success case (SQLite may remove it), so absence maps to `0`, not an error.
#[cfg(any(target_os = "macos", test))]
fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Open `db_path` on a fresh connection and run `PRAGMA wal_checkpoint(TRUNCATE)`, flushing every
/// committed WAL frame into the main database and truncating the `-wal` file to zero bytes.
///
/// Safe to call while WebKit has the same database open: SQLite coordinates the checkpoint through
/// the shared-memory index. If another connection holds a read lock the pragma reports `busy != 0`
/// and leaves the WAL in place, to be retried on the next interval — this never blocks longer than
/// [`BUSY_TIMEOUT_MS`], and never deletes uncheckpointed state.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn checkpoint_truncate(db_path: &Path) -> Result<CheckpointOutcome, String> {
    let wal = wal_path(db_path);
    let before = file_len(&wal);
    let conn = Connection::open(db_path).map_err(|e| format!("open {}: {e}", db_path.display()))?;
    conn.busy_timeout(std::time::Duration::from_millis(u64::from(BUSY_TIMEOUT_MS)))
        .map_err(|e| format!("busy_timeout: {e}"))?;
    // The pragma returns exactly one row: (busy, log, checkpointed).
    let (busy, wal_frames, checkpointed): (i64, i64, i64) = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| format!("wal_checkpoint(TRUNCATE) on {}: {e}", db_path.display()))?;
    // Drop the connection before measuring so its own file handle isn't what keeps the -wal around.
    drop(conn);
    let after = file_len(&wal);
    Ok(CheckpointOutcome {
        busy,
        wal_frames,
        checkpointed,
        wal_bytes_before: before,
        wal_bytes_after: after,
    })
}

/// Recursively collect every `localstorage.sqlite3` under `base`, bounded to [`MAX_WALK_DEPTH`].
/// A single WebKit profile normally holds one, but a multi-origin profile can hold several, so this
/// returns all of them. Best-effort: unreadable directories are skipped, never fatal.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn find_localstorage_dbs(base: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        if depth > MAX_WALK_DEPTH {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Do not follow symlinks — bound the walk to the real WebKit tree.
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                walk(&path, depth + 1, out);
            } else if file_type.is_file()
                && path.file_name().and_then(|n| n.to_str()) == Some(LOCALSTORAGE_DB_NAME)
            {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(base, 0, &mut out);
    out.sort();
    out
}

/// Checkpoint every localStorage database found under `base`. Returns `(attempted, truncated)`:
/// how many databases were found and checkpointed, and how many reported a full truncation
/// (`busy == 0`). Each database is independent; one failing does not stop the others.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn checkpoint_all(base: &Path) -> (usize, usize) {
    let dbs = find_localstorage_dbs(base);
    let mut attempted = 0usize;
    let mut truncated = 0usize;
    for db in dbs {
        attempted += 1;
        match checkpoint_truncate(&db) {
            Ok(outcome) => {
                if outcome.busy == 0 {
                    truncated += 1;
                }
                tracing::info!(
                    target: "webkit_localstorage",
                    db = %db.display(),
                    busy = outcome.busy,
                    wal_frames = outcome.wal_frames,
                    checkpointed = outcome.checkpointed,
                    wal_bytes_before = outcome.wal_bytes_before,
                    wal_bytes_after = outcome.wal_bytes_after,
                    "localStorage WAL checkpoint(TRUNCATE)"
                );
            }
            Err(e) => {
                tracing::warn!(target: "webkit_localstorage", db = %db.display(), error = %e, "localStorage WAL checkpoint failed");
            }
        }
    }
    (attempted, truncated)
}

/// `~/Library/WebKit/ai.sparkle.desktop/WebsiteData` — the root WebKit keeps this app's website data
/// (including localStorage) under. The bundle identifier is `ai.sparkle.desktop` for BOTH the shipped
/// app and dev builds (only app-data/log/keychain get the dev suffix; the Info.plist identifier that
/// keys this path does not — see `dev_identity`), so this one path covers every build.
#[cfg(target_os = "macos")]
fn webkit_website_data_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).map(|home| {
        home.join("Library")
            .join("WebKit")
            .join("ai.sparkle.desktop")
            .join("WebsiteData")
    })
}

/// Spawn the background maintenance thread: one checkpoint immediately (the launch window, before the
/// webview opens the DB, is when a full TRUNCATE is most likely to win the lock cleanly), then one
/// every [`CHECKPOINT_INTERVAL`] for the life of the process so a long session cannot let the WAL
/// grow back to the gigabytes `sparkle-i061ug` measured. No-op off macOS, where there is no WebKit
/// localStorage SQLite store.
pub fn spawn_maintenance() {
    #[cfg(target_os = "macos")]
    {
        std::thread::Builder::new()
            .name("webkit-ls-checkpoint".into())
            .spawn(|| {
                let base = match webkit_website_data_dir() {
                    Some(b) => b,
                    None => {
                        tracing::warn!(target: "webkit_localstorage", "no home dir; localStorage WAL maintenance disabled");
                        return;
                    }
                };
                loop {
                    let (attempted, truncated) = checkpoint_all(&base);
                    if attempted > 0 {
                        tracing::info!(
                            target: "webkit_localstorage",
                            attempted,
                            truncated,
                            "localStorage WAL maintenance pass complete"
                        );
                    }
                    std::thread::sleep(CHECKPOINT_INTERVAL);
                }
            })
            .ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Open `path`, enable WAL, DISABLE autocheckpoint, and write `rows` rows so the `-wal` sidecar
    /// grows and STAYS grown — the exact shape of the bug, where committed frames pile up in the WAL
    /// because nothing truncates it. Returns the writer connection, left OPEN and idle to stand in
    /// for WebKit holding the database open across the checkpoint.
    fn seed_bloated_wal(path: &Path, rows: usize) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        // Without this, SQLite's own 1000-page autocheckpoint would truncate for us and the test
        // could pass with our code deleted — the whole point is that nothing checkpoints on its own.
        conn.pragma_update(None, "wal_autocheckpoint", 0i64).unwrap();
        conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)", [])
            .unwrap();
        let blob = "x".repeat(4000);
        for _ in 0..rows {
            conn.execute("INSERT INTO t (blob) VALUES (?1)", [&blob])
                .unwrap();
        }
        conn
    }

    #[test]
    fn checkpoint_truncate_shrinks_a_bloated_wal_to_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("localstorage.sqlite3");
        // Writer stays open and idle across the checkpoint, exactly as WebKit would.
        let _writer = seed_bloated_wal(&db, 2000);

        let wal = wal_path(&db);
        let before = file_len(&wal);
        assert!(
            before > 100_000,
            "precondition: the seeded WAL should be sizeable, got {before} bytes"
        );

        let outcome = checkpoint_truncate(&db).unwrap();

        // The side effect under test: `busy == 0` means no reader blocked the checkpoint, and a
        // TRUNCATE checkpoint only truncates the WAL AFTER every committed frame has been flushed into
        // the main database — so a `-wal` that went from 25 MB to zero bytes while the writer
        // connection is still open is proof the checkpoint completed and moved the data. Deleting the
        // `checkpoint_truncate` call (mutation) leaves the WAL at `before`, and both assertions fail.
        // (SQLite reports the `log`/`checkpointed` frame counts as 0 on a fresh connection here, so
        // the byte truncation — not those columns — is the reliable signal.)
        assert_eq!(outcome.busy, 0, "checkpoint should not have been blocked");
        assert_eq!(
            outcome.wal_bytes_after, 0,
            "TRUNCATE checkpoint must truncate the -wal to zero (was {before} bytes)"
        );
        assert_eq!(file_len(&wal), 0, "-wal on disk must be zero bytes after");

        // And the data survived — TRUNCATE flushes committed frames into the main file, it does not
        // drop them (the bead's explicit 'do not just delete the WAL' requirement).
        let n: i64 = _writer
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2000, "all committed rows must survive the checkpoint");
    }

    #[test]
    fn find_localstorage_dbs_discovers_nested_webkit_layout() {
        let tmp = tempfile::tempdir().unwrap();
        // Mirror the real WebKit tree: WebsiteData/Default/<hash>/<hash>/LocalStorage/<db>.
        let nested = tmp
            .path()
            .join("Default")
            .join("a1b2c3")
            .join("d4e5f6")
            .join("LocalStorage");
        std::fs::create_dir_all(&nested).unwrap();
        let db = nested.join("localstorage.sqlite3");
        std::fs::write(&db, b"not a real db, discovery only").unwrap();
        // A decoy file that must NOT match.
        std::fs::write(nested.join("other.sqlite3"), b"decoy").unwrap();

        let found = find_localstorage_dbs(tmp.path());
        assert_eq!(found, vec![db], "should find exactly the localstorage.sqlite3");
    }

    #[test]
    fn find_localstorage_dbs_empty_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(find_localstorage_dbs(tmp.path()).is_empty());
    }
}
