//! The spawn ledger: WHICH Claude account each agent spawn actually ran under.
//!
//! ## Why this exists
//!
//! Account rotation is invisible. `accounts.rs` picks an account for every spawn — pinned, sticky,
//! auto by learned ceiling, or none at all — and then **nothing writes that decision down**. So
//! neither a human nor a later agent can answer the only question that proves rotation works:
//! *which account did the last N spawns use, and did that change when one approached its ceiling?*
//! Rotation has twice been reported as shipped on the strength of code that reads correctly, which
//! is not evidence. This file is the evidence.
//!
//! ## Shape — deliberately `cat`-able
//!
//! `<app_data>/account-spawn-log.jsonl`, **one compact JSON object per line**, oldest first:
//!
//! ```text
//! {"at":1785886200123,"key":"agent-7f3","accountId":"acc-2","nickname":"work",…}
//! {"at":1785886260456,"key":"sparkle:concierge","accountId":null,…,"reason":"none",…}
//! ```
//!
//! JSONL rather than a JSON array on purpose: appending a line is one `write(2)` with `O_APPEND`,
//! so the common case never rewrites the file, and a crash mid-append damages exactly the last
//! line instead of the whole document. `cat`/`tail`/`jq -c` all read it directly — the founder is
//! a first-class consumer of this file, not just the UI.
//!
//! ## Never fatal, in both directions
//!
//! * A failed **append** must never break a spawn. Losing one log line is a gap in the evidence;
//!   failing the spawn is a broken product. The command returns `Err` and the caller ignores it.
//! * A damaged **read** must never blind the reader to the entries that are fine. A missing file is
//!   an empty vec (a ledger that does not exist yet is a normal state, not a failure), and a single
//!   unparseable line is skipped rather than failing the read. That case is not hypothetical: a
//!   crash mid-append leaves a truncated last line, and truncating a multi-byte UTF-8 sequence
//!   would take the whole file down with a naive `read_to_string`. So the read works on **bytes**
//!   and validates UTF-8 per line.
//!
//! Nothing here panics.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// One spawn's account decision, exactly as it is written to disk and handed to the frontend.
///
/// **The wire names are a FROZEN contract** shared with the TypeScript client, which is why
/// `rename_all = "camelCase"` is pinned by a test that asserts the literal key strings. This repo
/// has already shipped a snake_case/camelCase mismatch that made every field read `undefined` on
/// the JS side while the Rust side looked perfect.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpawnLogEntry {
    /// Epoch **milliseconds** of the selection. Milliseconds, not the seconds used everywhere in
    /// `accounts.rs`: spawns can land in the same second and their ORDER is the whole point.
    pub at: i64,
    /// Agent id, or `"sparkle:concierge"`, or `"__sparkle_self__"`.
    pub key: String,
    /// `None` = no account was chosen, so the spawn inherits the default login.
    pub account_id: Option<String>,
    pub nickname: Option<String>,
    pub config_dir: Option<String>,
    /// The account's real authenticated identity, when known.
    pub email: Option<String>,
    /// `"pinned" | "preferred" | "auto" | "sticky" | "fallback" | "remembered" | "none"`.
    /// (`"preferred"` = the fleet-wide account the user activated in the accounts modal, as
    /// distinct from `"pinned"`, which is one human choice about one agent.)
    pub reason: String,
    pub tokens5h: u64,
    /// Learned ceiling; `None` = not enough evidence to have learned one.
    pub ceiling: Option<u64>,
    /// `tokens5h / ceiling`; `None` whenever `ceiling` is `None`.
    pub fraction: Option<f64>,
    /// How many accounts auto-pick was allowed to choose from.
    pub eligible_count: usize,
    /// How many registered accounts are actually signed in.
    pub signed_in_count: usize,
    /// The ids that were healthy candidates at this instant.
    pub candidate_ids: Vec<String>,
}

/// Retained line count. Past this the oldest are dropped — see [`MAX_LINES_SLACK`] for why the file
/// can briefly hold slightly more.
pub const MAX_LINES: usize = 2000;

/// Appends between cap checks.
///
/// The cap CANNOT be enforced on every append: a full-file line count plus rewrite on each write
/// would, at steady state, turn every single spawn into a ~400 KB read + rewrite — the file sits at
/// exactly [`MAX_LINES`] after a trim, so the very next append would exceed it again. Amortising
/// the check means the common case stays a bare append and the rewrite happens once per this many
/// spawns.
///
/// The counter is seeded so the FIRST append of each process checks anyway — see `append_entry`.
/// Without that, this amortisation would silently disable the cap entirely for short sessions.
const CHECK_EVERY: usize = 64;

/// Slack the file may carry above [`MAX_LINES`] between checks: at most `CHECK_EVERY - 1` extra
/// lines. Exposed so the cap test can assert bounded growth rather than an exact count.
pub const MAX_LINES_SLACK: usize = CHECK_EVERY - 1;

/// A conservative LOWER bound on the bytes one serialized entry occupies, used as a cheap
/// "could this file even hold [`MAX_LINES`] lines?" gate before any counting happens.
///
/// Sound because every field is always emitted (no `skip_serializing_if` anywhere on
/// [`SpawnLogEntry`]), so the key names alone put the floor near 190 bytes. 100 leaves ample room
/// for the contract to gain or lose a field without the gate becoming wrong in the dangerous
/// direction — a bound that is too HIGH would silently disable the cap, which is why
/// `the_minimum_line_is_never_smaller_than_the_size_gate_assumes` pins it.
const MIN_LINE_BYTES: u64 = 100;

/// `<app_data>/account-spawn-log.jsonl`.
pub fn spawn_log_path(app_data: &Path) -> PathBuf {
    app_data.join("account-spawn-log.jsonl")
}

/// Process-wide lock serializing appends and the trim's read-modify-write, and carrying the
/// per-path append counter that amortises the cap check.
///
/// A `static` rather than Tauri-managed state for the same reason as `identity_log::log_lock`:
/// every caller does its work inside `spawn_blocking`, whose closure must be `Send + 'static`, so a
/// `MutexGuard` borrowed from managed state could not reach inside it.
///
/// Keyed by path so that two ledgers (production and each test's tempdir) amortise independently —
/// a single shared counter would make the cap non-deterministic under a parallel test runner.
fn state() -> &'static std::sync::Mutex<HashMap<PathBuf, usize>> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, usize>>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Acquire the ledger lock, recovering from poisoning — a panicking prior holder must not
/// permanently disable spawn recording.
fn guard() -> std::sync::MutexGuard<'static, HashMap<PathBuf, usize>> {
    state().lock().unwrap_or_else(|e| e.into_inner())
}

/// Append ONE line for `entry`, creating the parent directory if it is missing.
///
/// Append-only in the common case: `O_APPEND` + one `write_all`, no read and no rewrite. The cap is
/// enforced out-of-band every [`CHECK_EVERY`] appends, and a failure THERE is swallowed — a ledger
/// that grew past its cap is a far smaller problem than an append reported as failed.
pub fn append_entry(path: &Path, entry: &SpawnLogEntry) -> std::io::Result<()> {
    let mut counters = guard();

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    // Serialize BEFORE opening: a serialization failure then costs nothing and cannot leave a
    // half-written line behind.
    let mut line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
    line.push('\n');

    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    f.write_all(line.as_bytes())?;

    // Seeded at CHECK_EVERY rather than 0, so the FIRST append of each process always checks.
    //
    // This counter is process-local and resets on every app launch, and `trim_to_cap` is called
    // from nowhere else — so a seed of 0 would mean a session performing fewer than CHECK_EVERY
    // spawns never checks the cap AT ALL. That is the normal desktop pattern (launch, spawn a
    // handful of agents, quit), so the ledger would grow without bound across many short sessions
    // while every doc and test here claimed it was capped. The `stat` gate makes this first check
    // near-free — one `metadata` call, no read — when the file is under the cap, so the steady
    // state is unchanged.
    let n = counters.entry(path.to_path_buf()).or_insert(CHECK_EVERY);
    *n += 1;
    if *n >= CHECK_EVERY {
        *n = 0;
        // Best effort by design — see the doc comment.
        let _ = trim_to_cap(path, MAX_LINES);
    }
    Ok(())
}

/// Drop all but the newest `max_lines` lines. Returns whether the file was rewritten.
///
/// Two cheap gates run before any rewrite, in order: a `stat` (a file too small to POSSIBLY hold
/// `max_lines` lines cannot be over the cap), then a line count. Only a genuine overflow rewrites.
///
/// The kept lines are copied **verbatim** rather than re-serialized: this is a ledger, and a line
/// this build cannot parse may still be one a human or a later build can. Trimming must not become
/// a second, silent filter on top of the read path's skip.
///
/// The rewrite is atomic (temp sibling + `rename`) so a crash or a full disk leaves the previous
/// complete file rather than a truncated one.
pub fn trim_to_cap(path: &Path, max_lines: usize) -> std::io::Result<bool> {
    let meta = std::fs::metadata(path)?;
    if meta.len() < (max_lines as u64).saturating_mul(MIN_LINE_BYTES) {
        return Ok(false);
    }
    let bytes = std::fs::read(path)?;
    let lines: Vec<&[u8]> = bytes.split(|b| *b == b'\n').filter(|l| !l.is_empty()).collect();
    if lines.len() <= max_lines {
        return Ok(false);
    }
    let mut out = Vec::with_capacity(bytes.len());
    for l in &lines[lines.len() - max_lines..] {
        out.extend_from_slice(l);
        out.push(b'\n');
    }
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, &out)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp); // best-effort cleanup of the orphan temp
    })?;
    Ok(true)
}

/// Read at most `limit` entries, **NEWEST FIRST**.
///
/// Never fails and never panics: an absent, unreadable, empty, or partly corrupt file all yield
/// whatever good entries could be recovered — an empty vec at worst. See the module header for why
/// this is the only acceptable behaviour.
///
/// Walks the file backwards and stops once `limit` entries have been recovered, so asking for the
/// last 20 of 2000 parses 20 lines rather than 2000.
pub fn read_entries(path: &Path, limit: usize) -> Vec<SpawnLogEntry> {
    if limit == 0 {
        return Vec::new();
    }
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new(); // missing file — a ledger that does not exist yet is normal
    };
    // `MAX_LINES + MAX_LINES_SLACK` is the true ceiling on how many entries the file can hold
    // between cap checks, so a caller passing a huge `limit` cannot make this over-allocate.
    let mut out = Vec::with_capacity(limit.min(MAX_LINES + MAX_LINES_SLACK));
    for raw in bytes.split(|b| *b == b'\n').rev() {
        if raw.is_empty() {
            continue;
        }
        // UTF-8 is validated PER LINE. A crash that truncated a multi-byte sequence must cost that
        // one line, not the entire ledger — which is exactly what a whole-file `read_to_string`
        // would do.
        let Ok(text) = std::str::from_utf8(raw) else {
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<SpawnLogEntry>(text) else {
            continue; // a corrupt line is skipped, never fatal
        };
        out.push(entry);
        if out.len() >= limit {
            break;
        }
    }
    out
}

// ---- Tauri commands (thin wrappers) -------------------------------------------

/// Record the account decision for one spawn.
///
/// `async` + `spawn_blocking`: this runs ON THE SPAWN PATH. A synchronous `#[tauri::command]` body
/// executes inline on the Tauri event-loop thread, so doing file IO here without hopping off-thread
/// is the documented bug class in this repo that starves the bridge and can freeze the whole UI.
///
/// Errors are returned rather than logged-and-swallowed so a caller CAN see them, but the contract
/// is that the caller ignores the result: a lost log line must never break a spawn.
#[tauri::command]
pub async fn accounts_record_spawn(app: AppHandle, entry: SpawnLogEntry) -> Result<(), String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        append_entry(&spawn_log_path(&app_data), &entry)
            .map_err(|e| format!("append spawn log: {e}"))
    })
    .await
    .map_err(|e| format!("accounts_record_spawn task failed: {e}"))?
}

/// The last `limit` spawn decisions, newest first. A missing ledger is an empty vec, not an error.
///
/// `async` + `spawn_blocking`: reads a file up to ~[`MAX_LINES`] lines long off the event loop.
#[tauri::command]
pub async fn accounts_spawn_log(
    app: AppHandle,
    limit: usize,
) -> Result<Vec<SpawnLogEntry>, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_entries(&spawn_log_path(&app_data), limit))
        .await
        .map_err(|e| format!("accounts_spawn_log task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A private tempdir per test. `std::process::id()` plus the test's own label keeps parallel
    /// tests — and repeat runs — from sharing a path, which matters because the append counter is
    /// keyed by path.
    fn unique_dir(label: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("spawn-ledger-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("tempdir");
        d
    }

    fn entry(at: i64, key: &str, account: Option<&str>) -> SpawnLogEntry {
        SpawnLogEntry {
            at,
            key: key.to_string(),
            account_id: account.map(str::to_string),
            nickname: account.map(|a| format!("nick-{a}")),
            config_dir: account.map(|a| format!("/tmp/{a}")),
            email: account.map(|a| format!("{a}@example.invalid")),
            reason: if account.is_some() { "auto".into() } else { "none".into() },
            tokens5h: 1_234,
            ceiling: Some(88_000),
            fraction: Some(0.25),
            eligible_count: 2,
            signed_in_count: 3,
            candidate_ids: vec!["acc-1".into(), "acc-2".into()],
        }
    }

    // ── Round trip ──────────────────────────────────────────────────────────────────────────────

    #[test]
    fn three_appends_read_back_newest_first() {
        // Asserts the ORDER, not the count: a read that returned oldest-first would still return 3.
        let dir = unique_dir("roundtrip");
        let path = spawn_log_path(&dir);

        append_entry(&path, &entry(1_000, "a", Some("acc-1"))).unwrap();
        append_entry(&path, &entry(2_000, "b", Some("acc-2"))).unwrap();
        append_entry(&path, &entry(3_000, "c", None)).unwrap();

        let got = read_entries(&path, 10);
        assert_eq!(
            got.iter().map(|e| e.at).collect::<Vec<_>>(),
            vec![3_000, 2_000, 1_000],
            "newest first"
        );
        assert_eq!(got[0].key, "c");
        assert_eq!(got[0].account_id, None, "a spawn with no account survives the round trip");
        assert_eq!(got[2].account_id.as_deref(), Some("acc-1"));
        // Every field, not just the ones the ordering assertion happens to touch.
        assert_eq!(got[1], entry(2_000, "b", Some("acc-2")));
    }

    #[test]
    fn the_file_is_one_json_object_per_line_so_a_human_can_cat_it() {
        // The file IS the evidence — a pretty-printed or array-wrapped writer would still round
        // trip through `read_entries` while being useless to `cat`/`tail`/`jq -c`.
        let dir = unique_dir("catable");
        let path = spawn_log_path(&dir);
        append_entry(&path, &entry(1, "a", Some("acc-1"))).unwrap();
        append_entry(&path, &entry(2, "b", Some("acc-2"))).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 2, "exactly one line per entry");
        for l in &lines {
            assert!(l.starts_with('{') && l.ends_with('}'), "each line is a whole JSON object: {l}");
            assert!(!l.contains('\n'));
            serde_json::from_str::<SpawnLogEntry>(l).expect("each line parses standalone");
        }
        assert!(raw.ends_with('\n'), "trailing newline, so the next append starts a new line");
    }

    // ── limit ───────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn limit_truncates_to_the_newest_entries() {
        // Asserts WHICH two, not just that two came back — returning the OLDEST two would also
        // satisfy a length-only assertion.
        let dir = unique_dir("limit");
        let path = spawn_log_path(&dir);
        for i in 1..=5 {
            append_entry(&path, &entry(i * 100, &format!("k{i}"), Some("acc-1"))).unwrap();
        }

        let got = read_entries(&path, 2);
        assert_eq!(got.len(), 2);
        assert_eq!(got.iter().map(|e| e.at).collect::<Vec<_>>(), vec![500, 400]);
        assert_eq!(got.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), vec!["k5", "k4"]);

        // A limit larger than the file returns everything, and asking for none returns none.
        assert_eq!(read_entries(&path, 99).len(), 5);
        assert!(read_entries(&path, 0).is_empty());
    }

    // ── Missing file ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_missing_ledger_reads_as_empty_and_not_as_an_error() {
        // `read_entries` cannot return an error by signature, so the real risk is a PANIC on the
        // absent file. Nothing has been appended here, so the file does not exist at all.
        let dir = unique_dir("missing");
        let path = spawn_log_path(&dir);
        assert!(!path.exists());
        assert!(read_entries(&path, 10).is_empty());

        // Nor does a path whose whole directory is absent.
        let gone = dir.join("no").join("such").join("dir").join("account-spawn-log.jsonl");
        assert!(read_entries(&gone, 10).is_empty());
    }

    #[test]
    fn appending_creates_the_app_data_dir_when_it_is_missing() {
        let dir = unique_dir("mkdir");
        let path = spawn_log_path(&dir.join("nested").join("deeper"));
        assert!(!path.parent().unwrap().exists());
        append_entry(&path, &entry(7, "k", Some("acc-1"))).unwrap();
        assert_eq!(read_entries(&path, 10).len(), 1);
    }

    // ── Corruption ──────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_corrupt_line_in_the_middle_is_skipped_and_its_neighbours_still_parse() {
        let dir = unique_dir("corrupt-mid");
        let path = spawn_log_path(&dir);
        append_entry(&path, &entry(1, "first", Some("acc-1"))).unwrap();

        // Garbage written straight into the middle of the ledger.
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(b"{ this is not json at all\n").unwrap();
            f.write_all(b"\n").unwrap(); // and a stray blank line
            f.write_all(b"{\"at\":5}\n").unwrap(); // valid JSON, wrong shape
        }

        append_entry(&path, &entry(3, "third", Some("acc-2"))).unwrap();

        let got = read_entries(&path, 10);
        assert_eq!(
            got.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(),
            vec!["third", "first"],
            "both good entries survive, in newest-first order, with the junk skipped"
        );
    }

    #[test]
    fn a_truncated_final_line_with_invalid_utf8_does_not_blind_the_reader() {
        // The crash-mid-append case. A naive whole-file `read_to_string` fails on the partial
        // multi-byte sequence and returns NOTHING — hiding every good entry above it, which is the
        // exact failure this ledger must not have.
        let dir = unique_dir("corrupt-utf8");
        let path = spawn_log_path(&dir);
        for i in 1..=3 {
            append_entry(&path, &entry(i, &format!("k{i}"), Some("acc-1"))).unwrap();
        }
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            // A lone continuation byte: never valid UTF-8, and no trailing newline.
            f.write_all(b"{\"at\":9,\"key\":\"\xf0\x9f").unwrap();
        }

        // Pin the premise: the naive read really would lose everything.
        assert!(std::fs::read_to_string(&path).is_err(), "the file is not valid UTF-8 as a whole");

        let got = read_entries(&path, 10);
        assert_eq!(got.iter().map(|e| e.at).collect::<Vec<_>>(), vec![3, 2, 1]);
    }

    // ── Append-only ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_common_case_appends_rather_than_rewriting_the_file() {
        // A "read everything, re-serialize, write it all back" implementation passes every test
        // above. This one distinguishes them: an unparseable marker planted in the file survives an
        // append only if the append never rewrote from parsed state.
        let dir = unique_dir("append-only");
        let path = spawn_log_path(&dir);
        append_entry(&path, &entry(1, "a", Some("acc-1"))).unwrap();
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(b"SENTINEL-NOT-JSON\n").unwrap();
        }
        append_entry(&path, &entry(2, "b", Some("acc-2"))).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 3, "the new line was appended, nothing was rewritten");
        assert_eq!(lines[1], "SENTINEL-NOT-JSON", "the untouched middle line kept its position");
        assert!(lines[2].contains("\"at\":2"), "the newest entry is last on disk");
    }

    // ── The cap ─────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn trim_to_cap_keeps_the_newest_and_drops_the_oldest() {
        // The cap mechanism itself, at a small size so the retention is asserted exactly.
        let dir = unique_dir("trim-exact");
        let path = spawn_log_path(&dir);
        for i in 1..=10 {
            append_entry(&path, &entry(i, &format!("k{i}"), Some("acc-1"))).unwrap();
        }
        // `max_lines * MIN_LINE_BYTES` must stay under the file's real size for the size gate to
        // let the count run; 10 entries are ~2 KB, so a cap of 4 (400 bytes) clears it.
        assert!(trim_to_cap(&path, 4).unwrap(), "the file was over the cap, so it was rewritten");

        let got = read_entries(&path, 99);
        assert_eq!(got.iter().map(|e| e.at).collect::<Vec<_>>(), vec![10, 9, 8, 7]);
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 4);

        // Idempotent: at the cap, nothing is rewritten.
        assert!(!trim_to_cap(&path, 4).unwrap(), "a file already at the cap is left alone");
    }

    #[test]
    fn the_two_thousand_line_cap_drops_the_oldest_and_keeps_the_newest() {
        // The real cap, driven through `append_entry` exactly as production does — so this covers
        // the amortised check firing on its own, not just `trim_to_cap` called by hand.
        let dir = unique_dir("cap-2000");
        let path = spawn_log_path(&dir);
        let total = MAX_LINES + CHECK_EVERY + 40; // enough appends to cross a check boundary
        for i in 1..=total {
            append_entry(&path, &entry(i as i64, &format!("k{i}"), Some("acc-1"))).unwrap();
        }

        let on_disk = std::fs::read(&path).unwrap();
        let line_count = on_disk.split(|b| *b == b'\n').filter(|l| !l.is_empty()).count();
        assert!(
            line_count <= MAX_LINES + MAX_LINES_SLACK,
            "the ledger stays bounded: {line_count} lines"
        );
        assert!(line_count >= MAX_LINES - MAX_LINES_SLACK, "it did not over-trim: {line_count}");
        assert!(line_count < total, "something was actually dropped");

        // The NEWEST survive, in order...
        let newest = read_entries(&path, 3);
        assert_eq!(
            newest.iter().map(|e| e.at).collect::<Vec<_>>(),
            vec![total as i64, total as i64 - 1, total as i64 - 2]
        );
        // ...and the OLDEST are gone. Asserted on the raw bytes so this cannot be satisfied by the
        // read path's `limit` merely not reaching them.
        let raw = String::from_utf8_lossy(&on_disk);
        assert!(!raw.contains("\"key\":\"k1\""), "the very first entry was dropped");
        assert!(raw.contains(&format!("\"key\":\"k{total}\"")), "the very last entry is present");
    }

    #[test]
    fn a_fresh_process_trims_an_over_cap_file_on_its_very_first_append() {
        // THE RESTART CASE, and the one the cap test above cannot see.
        //
        // `the_two_thousand_line_cap_…` drives every append inside ONE process, which is exactly
        // the case that works. But the counter is process-local and resets on each app launch, and
        // the normal desktop pattern is launch → spawn a handful of agents → quit. Seeded at 0, a
        // session doing fewer than CHECK_EVERY spawns would never check the cap at all, and the
        // ledger would grow without bound across many short sessions while every doc here claimed
        // it was capped.
        //
        // A path this process has never touched IS the fresh-process state — no counter entry
        // exists for it — so this drives the real thing rather than simulating it.
        let dir = unique_dir("restart-trim");
        let path = spawn_log_path(&dir);

        // An over-cap ledger left behind by a PREVIOUS run, written directly.
        let mut seed = String::new();
        for i in 1..=(MAX_LINES + 1) {
            seed.push_str(&serde_json::to_string(&entry(i as i64, &format!("k{i}"), Some("acc-1")))
                .unwrap());
            seed.push('\n');
        }
        std::fs::write(&path, &seed).unwrap();
        assert_eq!(seed.lines().count(), MAX_LINES + 1, "the file starts over the cap");

        // One append — the first this process makes against that path.
        append_entry(&path, &entry(9_999, "after-restart", Some("acc-2"))).unwrap();

        let line_count =
            std::fs::read(&path).unwrap().split(|b| *b == b'\n').filter(|l| !l.is_empty()).count();
        assert_eq!(
            line_count, MAX_LINES,
            "a single append by a fresh process brings an over-cap ledger back to the cap"
        );
        // And it trimmed from the correct end.
        assert_eq!(read_entries(&path, 1)[0].key, "after-restart", "the newest entry survived");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("\"key\":\"k1\""), "the oldest entries were the ones dropped");
    }

    #[test]
    fn the_minimum_line_is_never_smaller_than_the_size_gate_assumes() {
        // `trim_to_cap`'s cheap `stat` gate is only SOUND while MIN_LINE_BYTES is a true lower
        // bound. If the contract ever loses enough fields to fall under it, the gate silently stops
        // the cap from ever engaging and the ledger grows without limit — a failure with no visible
        // symptom until the file is enormous. This is the tripwire for that.
        let minimal = SpawnLogEntry {
            at: 0,
            key: String::new(),
            account_id: None,
            nickname: None,
            config_dir: None,
            email: None,
            reason: String::new(),
            tokens5h: 0,
            ceiling: None,
            fraction: None,
            eligible_count: 0,
            signed_in_count: 0,
            candidate_ids: vec![],
        };
        let len = serde_json::to_string(&minimal).unwrap().len() + 1; // + the newline
        assert!(
            len as u64 >= MIN_LINE_BYTES,
            "the smallest possible line is {len} bytes, under the {MIN_LINE_BYTES}-byte floor the \
             size gate assumes — lower MIN_LINE_BYTES or the cap will never engage"
        );
    }

    // ── The frozen wire contract ────────────────────────────────────────────────────────────────

    #[test]
    fn the_wire_keys_are_camel_case() {
        // Pinned as literal strings because the TypeScript client is written against exactly these
        // names. This repo has already shipped a snake_case/camelCase mismatch that made every
        // field read `undefined` on the JS side while both halves looked correct in isolation.
        let json = serde_json::to_string(&entry(1, "k", Some("acc-1"))).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let obj = v.as_object().expect("an object");

        for key in [
            "at",
            "key",
            "accountId",
            "nickname",
            "configDir",
            "email",
            "reason",
            "tokens5h",
            "ceiling",
            "fraction",
            "eligibleCount",
            "signedInCount",
            "candidateIds",
        ] {
            assert!(obj.contains_key(key), "the wire contract is missing `{key}`: {json}");
        }
        assert_eq!(obj.len(), 13, "no extra fields leaked onto the wire: {json}");

        // The negative half — without it, a struct that emitted BOTH forms would pass.
        for snake in ["account_id", "config_dir", "eligible_count", "signed_in_count", "candidate_ids"]
        {
            assert!(!obj.contains_key(snake), "`{snake}` leaked in snake_case: {json}");
        }

        // And the values arrive under those names, not merely the keys.
        assert_eq!(obj["accountId"], serde_json::json!("acc-1"));
        assert_eq!(obj["tokens5h"], serde_json::json!(1_234));
        assert_eq!(obj["candidateIds"], serde_json::json!(["acc-1", "acc-2"]));

        // A `None` account is `null` on the wire, never omitted — the JS side distinguishes
        // "no account chosen" from "field missing".
        let none_json = serde_json::to_string(&entry(1, "k", None)).unwrap();
        let nv: serde_json::Value = serde_json::from_str(&none_json).unwrap();
        assert_eq!(nv["accountId"], serde_json::Value::Null);
        assert!(nv.as_object().unwrap().contains_key("accountId"));
    }

    #[test]
    fn an_entry_deserializes_from_the_camel_case_json_the_frontend_sends() {
        // The other direction: `accounts_record_spawn` receives this shape from TypeScript.
        let e: SpawnLogEntry = serde_json::from_str(
            r#"{"at":1785886200123,"key":"sparkle:concierge","accountId":"acc-9",
                "nickname":"work","configDir":"/x","email":"a@b.invalid","reason":"sticky",
                "tokens5h":42,"ceiling":null,"fraction":null,"eligibleCount":1,
                "signedInCount":2,"candidateIds":["acc-9"]}"#,
        )
        .expect("the frontend's camelCase payload deserializes");
        assert_eq!(e.at, 1_785_886_200_123);
        assert_eq!(e.account_id.as_deref(), Some("acc-9"));
        assert_eq!(e.reason, "sticky");
        assert_eq!(e.tokens5h, 42);
        assert_eq!(e.ceiling, None);
        assert_eq!(e.signed_in_count, 2);
        assert_eq!(e.candidate_ids, vec!["acc-9".to_string()]);
    }

    // ── Wiring ──────────────────────────────────────────────────────────────────────────────────

    fn assert_async_command<A, B, Fut: std::future::Future>(_f: fn(A, B) -> Fut) {}

    #[test]
    fn both_commands_stay_off_the_event_loop() {
        // A non-`async` `#[tauri::command]` runs INLINE on the Tauri event-loop thread, so doing
        // file IO in one starves the bridge and can freeze the UI (a documented bug class here).
        // The coercion only type-checks while each command returns a future: revert either to
        // `pub fn` and its return type becomes a plain `Result`, which is not a `Future`, and the
        // build breaks HERE. Every other test drives the pure `*_entry`/`*_entries` cores, so
        // without this guard such a revert would pass silently.
        assert_async_command(accounts_record_spawn);
        assert_async_command(accounts_spawn_log);
    }

    #[test]
    fn the_commands_stay_registered_in_the_invoke_handler() {
        // A registered command is the only thing the TS client can reach. Dropping a line from
        // lib.rs compiles fine and fails at RUNTIME with "command not found".
        let lib_rs = include_str!("lib.rs");
        for cmd in [
            "account_ledger::accounts_record_spawn",
            "account_ledger::accounts_spawn_log",
        ] {
            assert!(lib_rs.contains(cmd), "{cmd} is not registered in lib.rs's invoke_handler");
        }
        assert!(lib_rs.contains("mod account_ledger;"), "the module is not declared in lib.rs");
    }
}
