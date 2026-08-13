//! The AGENT GOAL RECORD on disk — `<app_data>/agent-goals/<agentId>.json`.
//!
//! An agent's goal is the one thing meant to outlive a lost session, and it lives in localStorage
//! (zustand `persist`, key `sparkle-projects`), which a shell SessionStart hook cannot read. So a
//! resuming agent gets nothing back. This module is the durable mirror the hook CAN read; the
//! frozen contract is `docs/agent-goal-record.md` and its canonical instance is
//! `scripts/tests/fixtures/agent-goal-record.json`.
//!
//! ── RUST IS A DUMB BYTE-WRITER HERE, AND THAT IS THE DESIGN ─────────────────────────────────────
//! There is deliberately NO serde struct mirroring the goal. AGENTS.md records the failure that
//! would follow: a Rust `Option` crosses the wire as `null`, never as an absent key, so a
//! hand-written TypeScript `field?: T` describes a shape the wire cannot produce — an all-or-nothing
//! parser then discards the WHOLE payload, falls back to its "we did not look" default, and the
//! feature is inert forever with nothing logged. Two agents built the two halves of exactly such a
//! payload in parallel against a frozen field list; both suites passed, the merge was clean, and the
//! shipped feature never once ran.
//!
//! The renderer (`services/agentGoalDisk.ts`) owns the shape and hands us a STRING. Our whole job is
//! three properties:
//!
//!   1. it PARSES as JSON before anything is renamed over a good record,
//!   2. the path is CONFINED to the agent-goals dir (an `agentId` from the frontend is an
//!      untrusted path component — see `hooks::confine_to_worktrees` for the precedent),
//!   3. the write is ATOMIC, so the hook reading it concurrently never sees half a file.
//!
//! ── WHY NOT IN THE WORKTREE ─────────────────────────────────────────────────────────────────────
//! `agent_life.rs` already rejected `.sparkle/` inside the worktree for this purpose: `.sparkle` is
//! absent from `fleet::WALK_SKIP_DIRS`, so every write there bumps `newest_write_ms` and makes a
//! DEAD agent look active — the exact failure this mechanism exists to detect. Living outside the
//! repo also keeps `git status` clean, so a record can never wedge the hourly park.
use std::path::{Path, PathBuf};

use tauri::AppHandle;

/// `<app_data>/agent-goals`. Beside `hook-events/` and `agent-life/`, for the reason in the header.
pub fn goals_dir(base: &Path) -> PathBuf {
    base.join("agent-goals")
}

/// Environment override for the app-data root, named in the frozen contract because the SHELL side's
/// tests rely on it: the reader hook and this writer must be pointable at one temp dir so a test can
/// exercise both halves against the same file.
const APP_DATA_ENV: &str = "SPARKLE_APP_DATA";

/// The override rule as a PURE function of the raw variable — no environment read.
///
/// An EMPTY value is ignored rather than treated as the root — an unset-but-exported variable is a
/// routine shell accident, and honoring it would silently relocate every record to `/agent-goals`.
///
/// Split from the `var_os` read on purpose, and not merely for tidiness: `std::env::set_var` is
/// process-global and `cargo test` runs this module's other tests on parallel threads, every one of
/// which reaches `std::env::temp_dir()` → `getenv` through `tempfile::tempdir()`. Concurrent
/// `setenv`/`getenv` is UB, and it surfaces as a rare segfault or a mystery flake rather than a clean
/// failure. This crate has been burned by it before and encodes the counter-pattern deliberately
/// (`claude_oneshot.rs` states the rule; `beads_cmd.rs` introduced `ChildEnv` precisely so a test
/// need not reach for `set_var`). With the rule pure, the test asserts it with no environment at all.
fn app_data_override_from(raw: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    Some(PathBuf::from(raw))
}

/// The {@link APP_DATA_ENV} override, when one is set to a non-empty value. A one-line `var_os`
/// caller so the rule itself ({@link app_data_override_from}) tests without touching the environment.
fn app_data_override() -> Option<PathBuf> {
    app_data_override_from(std::env::var_os(APP_DATA_ENV))
}

/// The app-data root for goal records, honoring {@link APP_DATA_ENV}.
fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    match app_data_override() {
        Some(over) => Ok(over),
        None => crate::dev_identity::app_data_dir(app),
    }
}

/// The longest `agentId` we will turn into a filename. A UUID is 36 chars; this is slack, not a
/// budget. It exists so a pathological id cannot produce a name the filesystem rejects mid-write
/// (which would surface as a confusing IO error rather than a clear refusal).
const MAX_AGENT_ID_LEN: usize = 128;

/// Refuse an `agentId` that is anything other than a plain, boring filename component.
///
/// THIS IS A PATH-TRAVERSAL SURFACE, not a formality: the id arrives from the frontend and is
/// interpolated straight into a path, so `../../.claude/settings.json` would be a write-anywhere
/// primitive dressed up as a goal record. `hooks::confine_to_worktrees` is the precedent — refuse
/// rather than sanitize, because a sanitizer silently writes to a path the caller did not name.
///
/// An allowlist, not a denylist. `..` and `/` are the obvious attacks, but a denylist has to also
/// remember `\` (a separator on Windows and a literal on Unix, so a denylist gets ONE of those
/// wrong), NUL, and every control byte. Naming what is ALLOWED cannot be incomplete in that
/// direction.
fn validate_agent_id(agent_id: &str) -> Result<(), String> {
    if agent_id.is_empty() {
        return Err("agent goal record: empty agentId".into());
    }
    if agent_id.len() > MAX_AGENT_ID_LEN {
        return Err(format!(
            "agent goal record: agentId longer than {MAX_AGENT_ID_LEN} chars"
        ));
    }
    if !agent_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "agent goal record: refusing agentId with unsafe characters: {agent_id:?}"
        ));
    }
    // Unreachable given the allowlist above (`.` is not in it), but stated so the intent survives a
    // future widening of the character set — which is exactly when the traversal comes back.
    if agent_id == "." || agent_id == ".." {
        return Err("agent goal record: refusing a relative-path agentId".into());
    }
    Ok(())
}

/// The record path for `agent_id` under `dir`, CONFINED to `dir`.
///
/// Pure (no `AppHandle`), so the confinement rule unit-tests directly — same shape as
/// `hooks::confine_to_worktrees`. Two independent checks, deliberately: the id allowlist, and then a
/// structural assertion that the joined path's parent really is `dir`. The second is what would
/// still hold if someone widened the first.
pub fn record_path_in(dir: &Path, agent_id: &str) -> Result<PathBuf, String> {
    validate_agent_id(agent_id)?;
    let path = dir.join(format!("{agent_id}.json"));
    if path.parent() != Some(dir) {
        return Err(format!(
            "agent goal record: refusing a path outside the agent-goals dir: {}",
            path.display()
        ));
    }
    Ok(path)
}

/// Write one agent's record. Returns the path written, so a caller (and a test) can assert the
/// OUTCOME rather than a spy.
///
/// `json` is validated and written as-is — see the header for why nothing here understands its
/// shape. The atomic write is `hooks::atomic_write_settings`, reused rather than re-implemented so
/// the two properties that matter (invalid JSON is refused BEFORE the rename; a reader never
/// observes a partial file) cannot drift between two copies.
pub fn write_at(dir: &Path, agent_id: &str, json: &str) -> Result<PathBuf, String> {
    record_path_in(dir, agent_id)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("agent goal record: mkdir: {e}"))?;
    // Canonicalized AFTER the dir exists (`canonicalize` requires an existing path) for ONE reason:
    // the RETURNED path is then real and stable — no `..`, no symlink hops — so a caller comparing it
    // against another path is comparing like with like.
    //
    // It buys no confinement, and an earlier version of this comment claimed it did. `canonicalize`
    // RESOLVES a symlink rather than refusing it, so if `agent-goals` were itself a symlink the write
    // would happily follow it; and a `starts_with(&real_dir)` check on a path built as
    // `real_dir.join(...)` is true by construction, so it was a dead assertion no mutation could
    // kill. The real confinement is `record_path_in` above — the id allowlist plus the structural
    // parent check — which runs on the un-canonicalized `dir` first so a bad id is refused before any
    // directory is created. That the goals dir itself is app-derived (`<app_data>/agent-goals`) and
    // never frontend-supplied is what makes the symlink case a non-threat rather than an unchecked one.
    let real_dir = dir
        .canonicalize()
        .map_err(|e| format!("agent goal record: agent-goals dir unavailable: {e}"))?;
    let confined = record_path_in(&real_dir, agent_id)?;
    crate::hooks::atomic_write_settings(&confined, json)?;
    Ok(confined)
}

/// Delete one agent's record. A MISSING file is success, not an error.
///
/// Cleanup exists so the directory does not grow without bound: a record is written for every agent
/// that has ever had a goal, and agents are spawned and torn down all day. Idempotent because the
/// callers are teardown paths, which run more than once (a pane unmounts on tab close, on a
/// StrictMode double-mount, and on "Start again") and must not report failure for work already done.
pub fn delete_at(dir: &Path, agent_id: &str) -> Result<(), String> {
    let path = record_path_in(dir, agent_id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("agent goal record: delete: {e}")),
    }
}

/// Every `agentId` that currently has a record on disk. A MISSING directory is an empty list, not an
/// error — nothing has been written yet, which is the ordinary state on a first run.
///
/// This is what makes cleanup RECONCILE rather than merely remember. The renderer's own bookkeeping
/// only knows what THIS window wrote in THIS session, so a record left behind by a previous session —
/// an agent torn down while the app was closed, a window killed mid-session — is unreachable to it and
/// the directory grows without bound. Worse than unbounded: the reader hook locates its record by
/// matching `worktree` against `$PWD`, so an orphan whose worktree path still exists (or has been
/// reused) is served to a waking session as a live brief for an agent that no longer exists.
///
/// Only well-formed `<agentId>.json` names are returned. The stem is re-validated through
/// {@link validate_agent_id}, so a hand-dropped file cannot inject a name the caller would hand
/// straight back to `delete_agent_goal_record`; the atomic write's dotfile temp sibling is skipped for
/// the same reason it never matches the reader's `*.json` scan.
pub fn list_at(dir: &Path) -> Result<Vec<String>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("agent goal record: list: {e}")),
    };
    let mut ids = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        if validate_agent_id(stem).is_ok() {
            ids.push(stem.to_string());
        }
    }
    // Sorted so the command is deterministic — a caller diffing this against the live fleet should
    // not see spurious ordering churn from the filesystem's own iteration order.
    ids.sort();
    Ok(ids)
}

/// Write the record for `agent_id`.
///
/// `async` + `spawn_blocking` for the reason `agent_life.rs` states: a sync `#[tauri::command]` body
/// runs on the MAIN thread, and this one does filesystem work on every goal change.
#[tauri::command]
pub async fn write_agent_goal_record(
    app: AppHandle,
    agent_id: String,
    json: String,
) -> Result<String, String> {
    let dir = goals_dir(&app_data_root(&app)?);
    tauri::async_runtime::spawn_blocking(move || {
        write_at(&dir, &agent_id, &json).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("write_agent_goal_record task failed: {e}"))?
}

/// Every `agentId` with a record on disk (see {@link list_at}) — the renderer's reconcile input.
#[tauri::command]
pub async fn list_agent_goal_records(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = goals_dir(&app_data_root(&app)?);
    tauri::async_runtime::spawn_blocking(move || list_at(&dir))
        .await
        .map_err(|e| format!("list_agent_goal_records task failed: {e}"))?
}

/// Delete the record for `agent_id` (idempotent — see {@link delete_at}).
#[tauri::command]
pub async fn delete_agent_goal_record(app: AppHandle, agent_id: String) -> Result<(), String> {
    let dir = goals_dir(&app_data_root(&app)?);
    tauri::async_runtime::spawn_blocking(move || delete_at(&dir, &agent_id))
        .await
        .map_err(|e| format!("delete_agent_goal_record task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "36ad07ee-a425-42ed-a0a2-46074bacc85e";
    const GOOD: &str = r#"{"schemaVersion":1,"agentId":"x","goal":null}"#;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn writes_the_record_where_the_contract_says() {
        let d = dir();
        let goals = goals_dir(d.path());
        let written = write_at(&goals, ID, GOOD).expect("write");
        assert_eq!(written.file_name().unwrap(), format!("{ID}.json").as_str());
        assert_eq!(std::fs::read_to_string(&written).unwrap(), GOOD);
        // The dir is created on demand — a first write must not require a prior install step.
        assert!(goals.is_dir());
    }

    /// The rename is the LAST thing that happens, so a refused payload leaves the target untouched.
    /// Asserted as "the good record is still there", not merely "the call errored" — the point of
    /// validating before the rename is that a bug upstream cannot destroy a readable record.
    #[test]
    fn invalid_json_is_refused_before_the_rename() {
        let d = dir();
        let goals = goals_dir(d.path());
        let path = write_at(&goals, ID, GOOD).expect("seed a good record");

        let err = write_at(&goals, ID, "{not json").expect_err("must refuse");
        assert!(err.contains("invalid JSON"), "unexpected error: {err}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            GOOD,
            "the previous good record must survive a refused write"
        );
    }

    /// No partial file, and no debris. The temp sibling is renamed, so at no point does the target
    /// hold a prefix of the payload — and a refused write must not leave its staging file behind for
    /// the reader's `agent-goals/*.json` scan (or the next `ls`) to trip over.
    #[test]
    fn atomic_write_leaves_no_partial_or_stray_file() {
        let d = dir();
        let goals = goals_dir(d.path());
        write_at(&goals, ID, GOOD).expect("write");
        let _ = write_at(&goals, ID, "{not json");

        let entries: Vec<String> = std::fs::read_dir(&goals)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec![format!("{ID}.json")], "stray files: {entries:?}");
    }

    #[test]
    fn traversal_shaped_agent_ids_are_rejected() {
        let d = dir();
        let goals = goals_dir(d.path());
        std::fs::create_dir_all(&goals).unwrap();
        // The canary the traversal is aiming at.
        let outside = d.path().join("victim.json");
        std::fs::write(&outside, "untouched").unwrap();

        for bad in [
            "../victim",
            "..",
            ".",
            "a/b",
            "a\\b",
            "/etc/passwd",
            "",
            "with space",
            "semi;colon",
        ] {
            let err = write_at(&goals, bad, GOOD)
                .expect_err(&format!("must refuse agentId {bad:?}"));
            assert!(
                err.contains("agent goal record"),
                "unexpected error for {bad:?}: {err}"
            );
        }
        assert_eq!(
            std::fs::read_to_string(&outside).unwrap(),
            "untouched",
            "a refused id must not have written outside the goals dir"
        );
    }

    /// The confinement rule as pure arithmetic, independent of any filesystem — the half that would
    /// still be checkable if the write path changed.
    #[test]
    fn record_path_in_stays_under_its_dir() {
        let base = Path::new("/tmp/app-data/agent-goals");
        assert_eq!(
            record_path_in(base, ID).unwrap(),
            base.join(format!("{ID}.json"))
        );
        assert!(record_path_in(base, "../escape").is_err());
    }

    #[test]
    fn delete_removes_the_record_and_is_idempotent() {
        let d = dir();
        let goals = goals_dir(d.path());
        let path = write_at(&goals, ID, GOOD).expect("write");
        assert!(path.exists());

        delete_at(&goals, ID).expect("first delete");
        assert!(!path.exists());
        delete_at(&goals, ID).expect("a second delete is success, not an error");
    }

    #[test]
    fn delete_refuses_a_traversal_id() {
        let d = dir();
        let goals = goals_dir(d.path());
        std::fs::create_dir_all(&goals).unwrap();
        let outside = d.path().join("victim.json");
        std::fs::write(&outside, "untouched").unwrap();

        delete_at(&goals, "../victim").expect_err("must refuse");
        assert!(outside.exists(), "delete must not reach outside the goals dir");
    }

    /// `SPARKLE_APP_DATA` is the seam the shell reader's tests point at a temp dir. Exercised
    /// through `goals_dir` composition rather than the env read itself, which needs a process-wide
    /// mutation; `honors_app_data_env_override` below covers that read.
    #[test]
    fn goals_dir_hangs_off_the_app_data_root() {
        assert_eq!(
            goals_dir(Path::new("/tmp/somewhere")),
            PathBuf::from("/tmp/somewhere/agent-goals")
        );
    }

    /// `SPARKLE_APP_DATA` is honored, and a record really lands under it.
    ///
    /// Drives the REAL rule (`app_data_override_from`) rather than a re-implementation of the same
    /// check — but as a PURE function, with no `std::env::set_var` anywhere. The environment is
    /// process-global and `cargo test` runs this module's other tests on parallel threads, every one
    /// of which reaches `getenv` via `tempfile::tempdir()`; concurrent `setenv`/`getenv` is UB and
    /// shows up as a rare segfault rather than a clean failure. See `app_data_override_from`.
    ///
    /// The empty case is asserted too: an exported-but-unset variable is a routine shell accident,
    /// and honoring it would relocate every record to `/agent-goals`.
    #[test]
    fn honors_app_data_env_override() {
        let d = dir();
        let root = d.path().join("overridden-app-data");

        let over = app_data_override_from(Some(root.clone().into_os_string()))
            .expect("a non-empty override must be read");
        assert_eq!(over, root);

        let written = write_at(&goals_dir(&over), ID, GOOD).expect("write under the override");
        assert!(
            written.starts_with(root.canonicalize().unwrap()),
            "record landed outside the overridden root: {}",
            written.display()
        );

        assert_eq!(
            app_data_override_from(Some(std::ffi::OsString::new())),
            None,
            "an empty override must be ignored"
        );
        assert_eq!(app_data_override_from(None), None, "an unset variable is no override");
    }

    /// The length guard, at both sides of its boundary. Without the `>` case the whole
    /// `MAX_AGENT_ID_LEN` block could be deleted with every other test still green; without the `==`
    /// case, flipping `>` to `>=` would be equally invisible. One of the three stated validation
    /// properties had no mutation-killing test until this existed.
    #[test]
    fn agent_id_length_boundary_is_pinned() {
        let d = dir();
        let goals = goals_dir(d.path());

        let too_long = "a".repeat(MAX_AGENT_ID_LEN + 1);
        let err = write_at(&goals, &too_long, GOOD).expect_err("an over-long id must be refused");
        assert!(err.contains("longer than"), "unexpected error: {err}");

        let at_limit = "a".repeat(MAX_AGENT_ID_LEN);
        write_at(&goals, &at_limit, GOOD).expect("an id exactly at the limit must be accepted");
    }

    /// Listing is what lets the renderer RECONCILE against the directory instead of against its own
    /// per-session memory — the only way a record orphaned by a previous session is ever reclaimed.
    #[test]
    fn list_returns_well_formed_ids_and_ignores_everything_else() {
        let d = dir();
        let goals = goals_dir(d.path());
        write_at(&goals, "aaaa1111", GOOD).expect("write");
        write_at(&goals, "bbbb2222", GOOD).expect("write");
        // Debris that must never be offered back to the caller as an agent id: a non-record file, a
        // dotfile of the shape the atomic write stages under, and a name the id allowlist refuses.
        std::fs::write(goals.join("notes.txt"), "x").unwrap();
        std::fs::write(goals.join(".tmp-partial.json"), "{}").unwrap();
        std::fs::write(goals.join("has space.json"), "{}").unwrap();

        assert_eq!(
            list_at(&goals).expect("list"),
            vec!["aaaa1111".to_string(), "bbbb2222".to_string()]
        );
    }

    /// A first run has written nothing, so the directory does not exist — and an empty list is the
    /// honest answer. Erroring would make the renderer's reconcile pass fail on every fresh install.
    #[test]
    fn list_of_a_missing_dir_is_empty_not_an_error() {
        let d = dir();
        assert_eq!(list_at(&goals_dir(d.path())).expect("list"), Vec::<String>::new());
    }
}
