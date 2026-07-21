//! Disk retention for the two directories Sparkle grows without any upper bound.
//!
//! Both were measured unbounded in the field:
//!   - `<app_data>/hook-events/` — one `<agentId>.jsonl` per agent, appended to forever by
//!     `resources/sparkle-hook.mjs`. Never reaped: 606 files / 107 MB, oldest 3+ weeks old.
//!   - `<app_log_dir>/` — `tracing_appender::rolling::daily` rotates but never deletes:
//!     523 MB total, with single days at 116 MB.
//!
//! DELETION SAFETY is the whole design constraint here, because this code removes user files:
//!   - Every function takes the directory to operate on as an argument and only ever considers
//!     entries DIRECTLY inside it — no recursion, no traversal upward.
//!   - Symlinks are skipped outright (checked with `symlink_metadata`), so a link planted in the
//!     directory can never redirect an unlink outside it.
//!   - Only files matching the expected shape are candidates (`*.jsonl` for hook events; the
//!     `sparkle.log` prefix for logs). Anything else the user put there is left alone.
//!   - A hook-event log whose agent worktree still EXISTS is never deleted — only size-capped.
//!   - The newest log files are never deleted, so the file being written right now is safe.
//!
//! Nothing here touches `<app_data>/worktrees/` beyond READING the directory listing to learn
//! which agent ids are still live. Worktrees are live agent workspaces (~54 GB of in-flight work,
//! several agents running concurrently) and are deliberately out of scope: reaping them safely
//! needs liveness AND unpushed-work checks that this module has no business guessing at. Designing
//! that is tracked separately in bead sparkle-n5ty.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/// Retention rules for `<app_data>/hook-events`.
#[derive(Clone, Copy, Debug)]
pub struct HookEventsPolicy {
    /// Delete an ORPHANED log (no worktree for that agent id) once it is at least this old. The
    /// age grace exists so a log written moments before its worktree appears is never reaped.
    pub orphan_max_age: Duration,
    /// Any log larger than this gets tail-truncated, live agent or not.
    pub max_file_bytes: u64,
    /// How much of the tail to keep when truncating. Must be < `max_file_bytes`.
    pub keep_bytes: u64,
}

impl Default for HookEventsPolicy {
    fn default() -> Self {
        Self {
            orphan_max_age: Duration::from_secs(7 * 24 * 60 * 60),
            max_file_bytes: 8 * 1024 * 1024,
            keep_bytes: 2 * 1024 * 1024,
        }
    }
}

/// Retention rules for the app log directory.
#[derive(Clone, Copy, Debug)]
pub struct LogPolicy {
    /// Delete rotated log files older than this.
    pub max_age: Duration,
    /// Hard cap on the directory's total size; oldest files are deleted until it fits.
    pub max_total_bytes: u64,
    /// Never delete this many of the newest files, whatever the age/size rules say. Guarantees the
    /// file currently being appended to survives.
    pub keep_newest: usize,
}

impl Default for LogPolicy {
    fn default() -> Self {
        Self {
            max_age: Duration::from_secs(14 * 24 * 60 * 60),
            max_total_bytes: 256 * 1024 * 1024,
            keep_newest: 2,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReapStats {
    pub deleted: u32,
    pub truncated: u32,
    pub bytes_freed: u64,
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// A regular (non-symlink) file directly inside `dir`, with its size and mtime. Returns `None` for
/// directories, symlinks, and anything we can't stat — the conservative answer, since every caller
/// uses this to decide whether to DELETE.
fn plain_file(path: &Path) -> Option<(u64, SystemTime)> {
    let md = std::fs::symlink_metadata(path).ok()?;
    if md.file_type().is_symlink() || !md.is_file() {
        return None;
    }
    Some((md.len(), md.modified().ok()?))
}

/// Age of `mtime` relative to `now`, saturating at zero for files with a future timestamp
/// (clock skew must never make a fresh file look ancient).
fn age(now: SystemTime, mtime: SystemTime) -> Duration {
    now.duration_since(mtime).unwrap_or(Duration::ZERO)
}

// ---------------------------------------------------------------------------
// (1) hook-events retention
// ---------------------------------------------------------------------------

/// The set of agent ids that still have a worktree on disk, read from
/// `<worktrees_base>/<projectId>/<agentId>`. `None` means LIVENESS IS UNKNOWN — the caller must
/// reap nothing, because an absent id is indistinguishable from an orphaned one and would send a
/// running agent's log to the deleter. `reap_hook_events` handles that explicitly.
///
/// Fail-closed applies at EVERY level, not just the top: a per-project read failure used to be
/// skipped, which silently dropped that project's agents from the set and made their live logs
/// look orphaned.
/// What an entry directly inside the worktrees base is, for liveness purposes.
#[derive(Debug, PartialEq, Eq)]
enum EntryKind {
    /// A directory — treat as a project and enumerate its agents.
    Project,
    /// Statted fine and is not a directory. Never held agents; skipping it loses nothing.
    NotAProject,
    /// Could not be statted, so we cannot tell the two apart. Liveness is unknowable.
    Unknown,
}

/// Split out as a pure function purely so the `Unknown` arm is TESTABLE: a real `file_type()`
/// failure needs a filesystem that errors on stat, which a unit test cannot arrange. Taking the
/// `Result` as a parameter lets the fail-closed path be exercised directly instead of documented
/// and hoped for.
fn classify_worktrees_entry(ft: std::io::Result<std::fs::FileType>) -> EntryKind {
    match ft {
        Ok(t) if t.is_dir() => EntryKind::Project,
        Ok(_) => EntryKind::NotAProject,
        Err(_) => EntryKind::Unknown,
    }
}

fn live_agent_ids(worktrees_base: &Path) -> Option<std::collections::HashSet<String>> {
    let projects = std::fs::read_dir(worktrees_base).ok()?;
    let mut ids = std::collections::HashSet::new();
    for project in projects.flatten() {
        match classify_worktrees_entry(project.file_type()) {
            // A non-directory entry (.DS_Store, a stray file) was never a project and never held
            // agents, so skipping it loses nothing and must NOT trip the fail-closed path —
            // otherwise one piece of junk in the worktrees dir disables retention permanently.
            EntryKind::NotAProject => continue,
            // Could not stat it, so we cannot tell a project from junk. `unwrap_or(false)` used to
            // resolve that to "junk" and skip it — fail OPEN, in the one function whose entire
            // contract is fail-closed. Its agents would then be absent from the live set, and an
            // absent id reads as orphaned, so a transient stat failure could delete a RUNNING
            // agent's log. Same bug this function's project-read path already guards; it survived
            // one level down.
            EntryKind::Unknown => return None,
            EntryKind::Project => {}
        }
        let Ok(agents) = std::fs::read_dir(project.path()) else {
            // A real project directory we cannot enumerate. Its agents are unknown, and an unknown
            // agent reads as orphaned, so continuing here would queue a RUNNING agent's log for
            // deletion the first time its project dir is briefly unreadable. Liveness is unknown:
            // give up for this whole sweep rather than reap on a partial set.
            return None;
        };
        for agent in agents.flatten() {
            // Directories only: a worktree IS a directory, so a stray regular file named like an
            // agent id would otherwise join the live set and protect an orphaned log forever.
            if !agent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if let Some(name) = agent.file_name().to_str() {
                ids.insert(name.to_string());
            }
        }
    }
    Some(ids)
}

/// Keep only the last `keep_bytes` of `path`, starting at the first line boundary inside that tail
/// so the file still contains only whole JSONL records.
///
/// Written to a temp sibling and renamed, so a crash mid-rotation can never leave a corrupt log.
/// The tradeoff: a hook process holding an O_APPEND fd on the old inode loses the events it writes
/// during the swap. That is acceptable — rotation runs at launch, and the watcher re-derives status
/// from the events that follow.
///
/// The shrink is safe because the READER, not the watcher, detects it: `read_events_since_impl`
/// (hooks.rs) resets a stale cursor with `if offset > len { offset = 0 }` before seeking, so a
/// caller whose offset now points past the end of the replaced file restarts from the top instead
/// of reading nothing forever. `hookWatcher.ts` itself just carries the offset the backend returns
/// and has no shrink handling of its own — the check lives server-side deliberately, so every
/// caller inherits it. Cited here because it is cross-module: a reviewer reading only this file
/// cannot see the guarantee this rename depends on.
fn truncate_to_tail(path: &Path, keep_bytes: u64) -> Result<u64, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut f = std::fs::File::open(path).map_err(|e| format!("open for rotate: {e}"))?;
    let len = f.metadata().map_err(|e| format!("stat for rotate: {e}"))?.len();
    if len <= keep_bytes {
        return Ok(0);
    }
    f.seek(SeekFrom::Start(len - keep_bytes))
        .map_err(|e| format!("seek for rotate: {e}"))?;
    let mut tail = Vec::with_capacity(keep_bytes as usize);
    f.read_to_end(&mut tail).map_err(|e| format!("read tail: {e}"))?;

    // Drop the leading partial line so every retained record is whole.
    let start = tail.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
    let mut kept = &tail[start..];
    // Floor: if the tail is ONE record longer than keep_bytes whose only newline is the final byte,
    // `start` lands past the last content and `kept` is empty — rewriting the file to zero bytes and
    // discarding everything. Losing whole records beats losing the file, so fall back to the raw
    // tail (a leading partial line the reader will skip) rather than publishing nothing.
    if kept.is_empty() && !tail.is_empty() {
        kept = &tail;
    }

    let dir = path.parent().ok_or_else(|| "rotate: no parent dir".to_string())?;
    let tmp = dir.join(format!(
        ".{}.{}.rotate.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("log"),
        std::process::id()
    ));
    std::fs::write(&tmp, kept).map_err(|e| format!("write rotated tail: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("publish rotated log: {e}")
    })?;
    Ok(len - kept.len() as u64)
}

/// Reap and size-cap `<app_data>/hook-events`.
///
/// - A log whose agent id still has a worktree is NEVER deleted (only size-capped) — that agent may
///   be running right now and its watcher is tailing this exact file.
/// - An orphaned log (worktree gone) is deleted once it is older than `orphan_max_age`.
/// - Any surviving log over `max_file_bytes` is tail-truncated to `keep_bytes`.
///
/// `now` is injected so the age policy is testable without sleeping.
pub fn reap_hook_events(
    hook_events_dir: &Path,
    worktrees_base: &Path,
    policy: HookEventsPolicy,
    now: SystemTime,
) -> Result<ReapStats, String> {
    let mut stats = ReapStats::default();
    let entries = match std::fs::read_dir(hook_events_dir) {
        Ok(rd) => rd,
        // No hook-events dir yet — nothing to do. Not an error.
        Err(_) => return Ok(stats),
    };
    // If the worktrees dir can't be read we cannot tell live from orphaned, so we must NOT delete
    // anything. Size-capping is still safe (it never loses an agent's recent events), so we keep
    // doing that and skip only the deletion arm.
    let live = live_agent_ids(worktrees_base);

    for entry in entries.flatten() {
        let path = entry.path();
        // Only ever the flat `<agentId>.jsonl` files this directory is supposed to contain.
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Some((size, mtime)) = plain_file(&path) else {
            continue; // directory, symlink, or unstattable — never a deletion candidate
        };
        let Some(agent_id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };

        let is_orphan = match &live {
            Some(ids) => !ids.contains(agent_id),
            None => false, // unknown liveness → treat as live → never delete
        };

        if is_orphan && age(now, mtime) >= policy.orphan_max_age {
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    stats.deleted += 1;
                    stats.bytes_freed += size;
                }
                Err(e) => tracing::warn!(path = %path.display(), "reap hook log failed: {e}"),
            }
            continue;
        }

        if size > policy.max_file_bytes {
            // keep_bytes >= max_file_bytes would make truncate_to_tail's `len <= keep_bytes` early
            // return always fire: rotation becomes a silent no-op and the size cap stops existing.
            // Documented as an invariant on HookEventsPolicy; assert it so a future misconfiguration
            // fails loudly in dev rather than quietly letting logs grow forever in prod.
            debug_assert!(
                policy.keep_bytes < policy.max_file_bytes,
                "HookEventsPolicy invariant violated: keep_bytes ({}) must be < max_file_bytes ({})",
                policy.keep_bytes,
                policy.max_file_bytes
            );
            match truncate_to_tail(&path, policy.keep_bytes) {
                Ok(freed) if freed > 0 => {
                    stats.truncated += 1;
                    stats.bytes_freed += freed;
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(path = %path.display(), "rotate hook log failed: {e}"),
            }
        }
    }
    Ok(stats)
}

// ---------------------------------------------------------------------------
// (3) log-directory retention
// ---------------------------------------------------------------------------

/// Prune rotated log files in `log_dir`.
///
/// Candidates are files whose name starts with `prefix` (the `tracing_appender` daily rotation
/// writes `sparkle.log.YYYY-MM-DD`). The `keep_newest` most recently modified candidates are always
/// retained — that is what guarantees the file being appended to right now is never unlinked.
/// Everything else goes if it is older than `max_age`, and then oldest-first until the directory
/// fits under `max_total_bytes`.
pub fn prune_logs(
    log_dir: &Path,
    prefix: &str,
    policy: LogPolicy,
    now: SystemTime,
) -> Result<ReapStats, String> {
    let mut stats = ReapStats::default();
    let entries = match std::fs::read_dir(log_dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(stats),
    };

    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let matches_prefix = path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|n| n.starts_with(prefix))
            .unwrap_or(false);
        if !matches_prefix {
            continue; // not ours — leave anything else in this directory alone
        }
        if let Some((size, mtime)) = plain_file(&path) {
            files.push((path, size, mtime));
        }
    }

    // Newest first, so the protected window is a simple prefix of the list.
    files.sort_by(|a, b| b.2.cmp(&a.2));
    let protected = policy.keep_newest.min(files.len());
    let mut total: u64 = files.iter().map(|f| f.1).sum();

    // Age pass, oldest first (iterate the unprotected tail in reverse).
    let mut survivors: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    for (i, (path, size, mtime)) in files.into_iter().enumerate() {
        if i < protected || age(now, mtime) < policy.max_age {
            survivors.push((path, size, mtime));
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {
                stats.deleted += 1;
                stats.bytes_freed += size;
                total = total.saturating_sub(size);
            }
            Err(e) => {
                tracing::warn!(path = %path.display(), "prune log failed: {e}");
                survivors.push((path, size, mtime));
            }
        }
    }

    // Size pass: still over budget → drop the oldest survivors (never the protected newest).
    while total > policy.max_total_bytes && survivors.len() > protected {
        let (path, size, _) = survivors.pop().expect("len > protected >= 0");
        match std::fs::remove_file(&path) {
            Ok(()) => {
                stats.deleted += 1;
                stats.bytes_freed += size;
                total = total.saturating_sub(size);
            }
            Err(e) => {
                tracing::warn!(path = %path.display(), "prune log (size) failed: {e}");
                break; // can't make progress; stop rather than spin
            }
        }
    }

    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sparkle-retention-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// roborev 40335. The module header promises that a failure to establish liveness reaps
    /// NOTHING, but only the TOP-LEVEL read honored it: a project directory that could not be
    /// enumerated was skipped, dropping its agents from the live set. An absent id is
    /// indistinguishable from an orphaned one, so a still-RUNNING agent's log became eligible for
    /// deletion the first time its project dir was momentarily unreadable (a transient permission
    /// or IO error is enough). This is a delete-user-data path, so it must fail closed.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_project_dir_fails_closed_rather_than_orphaning_its_agents() {
        use std::os::unix::fs::PermissionsExt;
        let base = tmpdir("liveness-failclosed");
        // A readable project with a live agent, so the happy path is exercised in the same run.
        std::fs::create_dir_all(base.join("proj-ok").join("agent-alive")).unwrap();
        // ...and a real project directory whose contents cannot be enumerated.
        let blocked = base.join("proj-blocked");
        std::fs::create_dir_all(blocked.join("agent-also-alive")).unwrap();
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let live = live_agent_ids(&base);

        // Restore permissions BEFORE asserting: a failure here must not leave an undeletable
        // directory behind in the temp dir.
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&base);

        assert!(
            live.is_none(),
            "liveness is UNKNOWN when a project dir can't be read; returning a partial set would \
             mark agent-also-alive an orphan and delete a running agent's log"
        );
    }

    /// roborev 40818. The entry classifier used `file_type().map(is_dir).unwrap_or(false)`, so a
    /// STAT FAILURE resolved to "not a project" and was skipped — fail OPEN, inside the one
    /// function whose entire contract is fail-closed. Its agents would then be missing from the
    /// live set, and an absent id reads as orphaned, so a transient stat error could send a
    /// RUNNING agent's log to the deleter. Exactly the bug fixed one level up at the project-read
    /// path; it survived one level down.
    #[test]
    fn an_unstattable_entry_is_unknown_not_junk() {
        use std::io::{Error, ErrorKind};
        assert_eq!(
            classify_worktrees_entry(Err(Error::new(ErrorKind::PermissionDenied, "stat failed"))),
            EntryKind::Unknown,
            "a stat failure must not be silently downgraded to 'not a project'"
        );
    }

    /// The other two arms, so the fix above cannot overshoot into treating ordinary junk as
    /// unknown — which would let one .DS_Store disable retention forever.
    #[test]
    fn a_statted_entry_is_classified_by_what_it_actually_is() {
        let dir = tmpdir("classify-arms");
        std::fs::create_dir_all(dir.join("proj")).unwrap();
        std::fs::write(dir.join("junk"), b"x").unwrap();

        let mut saw_project = false;
        let mut saw_junk = false;
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            match classify_worktrees_entry(e.file_type()) {
                EntryKind::Project => saw_project = true,
                EntryKind::NotAProject => saw_junk = true,
                EntryKind::Unknown => panic!("a readable temp dir must stat cleanly"),
            }
        }
        assert!(saw_project && saw_junk);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The fail-closed path must be reserved for real read failures. A stray file in the worktrees
    /// base is not a project, and letting it disable the sweep would mean one .DS_Store silently
    /// turns retention off forever — trading a data-loss bug for a leak.
    #[test]
    fn a_stray_file_in_the_worktrees_base_does_not_disable_the_sweep() {
        let base = tmpdir("liveness-strayfile");
        std::fs::create_dir_all(base.join("proj-ok").join("agent-alive")).unwrap();
        std::fs::write(base.join(".DS_Store"), b"junk").unwrap();

        let live = live_agent_ids(&base).expect("a stray file must not make liveness unknown");

        assert!(live.contains("agent-alive"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Write `path` with `size` bytes of whole JSONL lines and stamp its mtime `age_ago` in the past.
    /// Backdating the mtime (rather than sleeping) is what makes the age policies testable.
    fn write_aged(path: &Path, size: usize, now: SystemTime, age_ago: Duration) {
        let mut buf = Vec::with_capacity(size + 32);
        let mut i = 0u64;
        while buf.len() < size {
            buf.extend_from_slice(format!("{{\"event\":\"Stop\",\"n\":{i}}}\n").as_bytes());
            i += 1;
        }
        buf.truncate(size);
        // Keep the content whole-line: trim back to the last newline, then re-terminate.
        if let Some(nl) = buf.iter().rposition(|&b| b == b'\n') {
            buf.truncate(nl + 1);
        }
        std::fs::write(path, &buf).unwrap();
        let f = std::fs::File::options().write(true).open(path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(now - age_ago))
            .unwrap();
    }

    fn mkagent(worktrees: &Path, project: &str, agent: &str) {
        std::fs::create_dir_all(worktrees.join(project).join(agent)).unwrap();
    }

    // -- (1) hook-events ---------------------------------------------------

    #[test]
    fn keeps_a_live_agents_log_however_old_it_is() {
        // THE SAFETY INVARIANT: a log whose worktree still exists is never deleted, even when it is
        // far past the orphan age. That agent may be running right now with a watcher tailing it.
        let root = tmpdir("live");
        let hooks = root.join("hook-events");
        let worktrees = root.join("worktrees");
        std::fs::create_dir_all(&hooks).unwrap();
        mkagent(&worktrees, "proj", "agent-live");

        let now = SystemTime::now();
        let log = hooks.join("agent-live.jsonl");
        write_aged(&log, 500, now, 90 * DAY);

        let stats = reap_hook_events(&hooks, &worktrees, HookEventsPolicy::default(), now).unwrap();
        assert_eq!(stats.deleted, 0, "a live agent's log must never be deleted");
        assert!(log.exists());
    }

    #[test]
    fn deletes_only_orphaned_logs_past_the_age_grace() {
        let root = tmpdir("orphans");
        let hooks = root.join("hook-events");
        let worktrees = root.join("worktrees");
        std::fs::create_dir_all(&hooks).unwrap();
        mkagent(&worktrees, "proj", "agent-live");

        let now = SystemTime::now();
        let live = hooks.join("agent-live.jsonl");
        let old_orphan = hooks.join("agent-gone-old.jsonl");
        let fresh_orphan = hooks.join("agent-gone-fresh.jsonl");
        write_aged(&live, 200, now, 30 * DAY);
        write_aged(&old_orphan, 200, now, 30 * DAY);
        write_aged(&fresh_orphan, 200, now, Duration::from_secs(60)); // just written

        let stats = reap_hook_events(&hooks, &worktrees, HookEventsPolicy::default(), now).unwrap();

        assert_eq!(stats.deleted, 1);
        assert!(live.exists(), "live agent kept");
        assert!(!old_orphan.exists(), "aged-out orphan reaped");
        assert!(
            fresh_orphan.exists(),
            "an orphan inside the age grace is kept — its worktree may still be mid-creation"
        );
    }

    #[test]
    fn never_deletes_when_the_worktrees_dir_is_unreadable() {
        // Fail-safe: an unreadable worktrees dir makes EVERY log look orphaned. Deleting on that
        // basis would wipe every live agent's log, so the deletion arm must be skipped entirely.
        let root = tmpdir("noworktrees");
        let hooks = root.join("hook-events");
        std::fs::create_dir_all(&hooks).unwrap();
        let now = SystemTime::now();
        let log = hooks.join("agent-a.jsonl");
        write_aged(&log, 200, now, 90 * DAY);

        let missing = root.join("does-not-exist");
        let stats = reap_hook_events(&hooks, &missing, HookEventsPolicy::default(), now).unwrap();
        assert_eq!(stats.deleted, 0);
        assert!(log.exists());
    }

    #[test]
    fn ignores_non_jsonl_files_symlinks_and_subdirectories() {
        let root = tmpdir("shapes");
        let hooks = root.join("hook-events");
        let worktrees = root.join("worktrees");
        std::fs::create_dir_all(&hooks).unwrap();
        std::fs::create_dir_all(&worktrees).unwrap();
        let now = SystemTime::now();

        // Something valuable OUTSIDE the managed dir, and a symlink to it planted inside.
        let outside = root.join("precious.jsonl");
        write_aged(&outside, 100, now, 90 * DAY);
        let planted = hooks.join("evil.jsonl");
        std::os::unix::fs::symlink(&outside, &planted).unwrap();

        // A non-jsonl file the user dropped in, and a subdirectory.
        let readme = hooks.join("README.txt");
        write_aged(&readme, 50, now, 90 * DAY);
        std::fs::create_dir_all(hooks.join("nested.jsonl")).unwrap();

        let stats = reap_hook_events(&hooks, &worktrees, HookEventsPolicy::default(), now).unwrap();
        assert_eq!(stats.deleted, 0, "none of these shapes are deletion candidates");
        assert!(outside.exists(), "a symlink must never let us unlink outside the dir");
        assert!(planted.exists());
        assert!(readme.exists(), "unrelated user files are left alone");
    }

    #[test]
    fn truncates_an_oversized_log_to_whole_lines_keeping_the_newest_events() {
        let root = tmpdir("rotate");
        let hooks = root.join("hook-events");
        let worktrees = root.join("worktrees");
        std::fs::create_dir_all(&hooks).unwrap();
        mkagent(&worktrees, "proj", "agent-big");

        let now = SystemTime::now();
        let log = hooks.join("agent-big.jsonl");
        // Deliberately small caps so the test stays fast.
        let policy = HookEventsPolicy {
            orphan_max_age: 7 * DAY,
            max_file_bytes: 4096,
            keep_bytes: 1024,
        };
        write_aged(&log, 20_000, now, Duration::from_secs(10));
        let before = std::fs::read_to_string(&log).unwrap();

        let stats = reap_hook_events(&hooks, &worktrees, policy, now).unwrap();
        assert_eq!(stats.truncated, 1);
        assert_eq!(stats.deleted, 0);

        let after = std::fs::read_to_string(&log).unwrap();
        assert!(after.len() as u64 <= policy.keep_bytes, "capped to keep_bytes");
        assert!(!after.is_empty());
        // Every retained record is a WHOLE line — no leading fragment.
        for line in after.lines() {
            serde_json::from_str::<serde_json::Value>(line)
                .unwrap_or_else(|e| panic!("retained a partial line {line:?}: {e}"));
        }
        // The TAIL is what survived: the file's final record is unchanged.
        assert_eq!(before.trim_end().lines().last(), after.trim_end().lines().last());
        assert!(after.ends_with('\n'));
    }

    #[test]
    fn a_single_record_larger_than_keep_bytes_is_never_emptied() {
        // The degenerate shape: the retained tail's ONLY newline is its final byte, so dropping the
        // leading partial line leaves nothing. Writing that back would zero the file and discard
        // every event. Losing whole records beats losing the log entirely, so the raw tail survives.
        let root = tmpdir("nozero");
        let hooks = root.join("hook-events");
        let worktrees = root.join("worktrees");
        std::fs::create_dir_all(&hooks).unwrap();
        mkagent(&worktrees, "proj", "agent-huge");

        let now = SystemTime::now();
        let log = hooks.join("agent-huge.jsonl");
        // One record far larger than keep_bytes, newline only at the very end.
        let giant = format!("{{\"payload\":\"{}\"}}\n", "x".repeat(8000));
        std::fs::write(&log, &giant).unwrap();

        let policy =
            HookEventsPolicy { orphan_max_age: 7 * DAY, max_file_bytes: 4096, keep_bytes: 1024 };
        reap_hook_events(&hooks, &worktrees, policy, now).unwrap();

        let after = std::fs::read(&log).unwrap();
        assert!(!after.is_empty(), "truncation must never zero the file");
    }

    #[test]
    fn a_stray_file_named_like_an_agent_does_not_keep_an_orphan_log_alive() {
        // live_agent_ids takes DIRECTORY entries only: a worktree is a directory, so a regular file
        // sharing an agent id must not join the live set and shield that agent's log from reaping.
        let root = tmpdir("straydir");
        let hooks = root.join("hook-events");
        let worktrees = root.join("worktrees");
        std::fs::create_dir_all(&hooks).unwrap();
        std::fs::create_dir_all(worktrees.join("proj")).unwrap();
        // Not a worktree — just a file that happens to be named like one.
        std::fs::write(worktrees.join("proj").join("agent-ghost"), b"").unwrap();

        let now = SystemTime::now();
        let log = hooks.join("agent-ghost.jsonl");
        // Aged well past the orphan threshold, so liveness is the only thing keeping it.
        write_aged(&log, 100, now, 30 * DAY);

        let stats = reap_hook_events(&hooks, &worktrees, HookEventsPolicy::default(), now).unwrap();
        assert_eq!(stats.deleted, 1, "the stray file must not shield the orphaned log");
        assert!(!log.exists());
    }

    #[test]
    fn a_log_under_the_cap_is_left_byte_for_byte_intact() {
        let root = tmpdir("undercap");
        let hooks = root.join("hook-events");
        let worktrees = root.join("worktrees");
        std::fs::create_dir_all(&hooks).unwrap();
        mkagent(&worktrees, "proj", "agent-small");
        let now = SystemTime::now();
        let log = hooks.join("agent-small.jsonl");
        write_aged(&log, 500, now, Duration::from_secs(10));
        let before = std::fs::read(&log).unwrap();

        let stats = reap_hook_events(&hooks, &worktrees, HookEventsPolicy::default(), now).unwrap();
        assert_eq!(stats, ReapStats::default());
        assert_eq!(std::fs::read(&log).unwrap(), before);
    }

    #[test]
    fn missing_hook_events_dir_is_not_an_error() {
        let root = tmpdir("nodir");
        let stats = reap_hook_events(
            &root.join("hook-events"),
            &root.join("worktrees"),
            HookEventsPolicy::default(),
            SystemTime::now(),
        )
        .unwrap();
        assert_eq!(stats, ReapStats::default());
    }

    // -- (3) log retention -------------------------------------------------

    #[test]
    fn prunes_logs_older_than_max_age_but_keeps_the_newest() {
        let root = tmpdir("logage");
        std::fs::create_dir_all(&root).unwrap();
        let now = SystemTime::now();
        let policy = LogPolicy { max_age: 14 * DAY, max_total_bytes: u64::MAX, keep_newest: 2 };

        for (name, days) in [
            ("sparkle.log.2026-07-20", 0),
            ("sparkle.log.2026-07-19", 1),
            ("sparkle.log.2026-06-01", 40),
            ("sparkle.log.2026-06-02", 39),
        ] {
            write_aged(&root.join(name), 100, now, days * DAY);
        }

        let stats = prune_logs(&root, "sparkle.log", policy, now).unwrap();
        assert_eq!(stats.deleted, 2);
        assert!(root.join("sparkle.log.2026-07-20").exists());
        assert!(root.join("sparkle.log.2026-07-19").exists());
        assert!(!root.join("sparkle.log.2026-06-01").exists());
        assert!(!root.join("sparkle.log.2026-06-02").exists());
    }

    #[test]
    fn keep_newest_protects_the_active_file_even_when_everything_is_ancient() {
        // The file tracing_appender is appending to right now must survive any policy.
        let root = tmpdir("logactive");
        let now = SystemTime::now();
        let policy = LogPolicy { max_age: DAY, max_total_bytes: 1, keep_newest: 2 };
        for (name, days) in [("sparkle.log.a", 100), ("sparkle.log.b", 200), ("sparkle.log.c", 300)] {
            write_aged(&root.join(name), 5000, now, days * DAY);
        }

        prune_logs(&root, "sparkle.log", policy, now).unwrap();
        let left: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 2, "keep_newest files survive age AND size pressure");
        assert!(root.join("sparkle.log.a").exists(), "the newest is always kept");
        assert!(root.join("sparkle.log.b").exists());
    }

    #[test]
    fn enforces_the_total_size_cap_oldest_first() {
        let root = tmpdir("logsize");
        let now = SystemTime::now();
        // Nothing is old enough for the age pass; only the size cap should bite.
        let policy = LogPolicy { max_age: 365 * DAY, max_total_bytes: 2500, keep_newest: 1 };
        for (name, days) in [("sparkle.log.new", 1), ("sparkle.log.mid", 2), ("sparkle.log.old", 3)] {
            write_aged(&root.join(name), 1000, now, days * DAY);
        }

        let stats = prune_logs(&root, "sparkle.log", policy, now).unwrap();
        assert_eq!(stats.deleted, 1, "one 1000-byte file takes 3000 under the 2500 cap");
        assert!(!root.join("sparkle.log.old").exists(), "oldest goes first");
        assert!(root.join("sparkle.log.new").exists());
        assert!(root.join("sparkle.log.mid").exists());
    }

    #[test]
    fn never_touches_files_outside_the_prefix() {
        let root = tmpdir("logprefix");
        let now = SystemTime::now();
        let policy = LogPolicy { max_age: DAY, max_total_bytes: 1, keep_newest: 0 };
        write_aged(&root.join("sparkle.log.old"), 100, now, 100 * DAY);
        write_aged(&root.join("important-notes.txt"), 100, now, 100 * DAY);
        write_aged(&root.join("other-app.log"), 100, now, 100 * DAY);

        prune_logs(&root, "sparkle.log", policy, now).unwrap();
        assert!(!root.join("sparkle.log.old").exists());
        assert!(root.join("important-notes.txt").exists(), "unrelated files untouched");
        assert!(root.join("other-app.log").exists());
    }

    #[test]
    fn log_prune_skips_symlinks() {
        let root = tmpdir("logsymlink");
        let now = SystemTime::now();
        let outside = root.join("outside-precious");
        write_aged(&outside, 100, now, 100 * DAY);
        let logs = root.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::os::unix::fs::symlink(&outside, logs.join("sparkle.log.evil")).unwrap();

        let policy = LogPolicy { max_age: DAY, max_total_bytes: 1, keep_newest: 0 };
        let stats = prune_logs(&logs, "sparkle.log", policy, now).unwrap();
        assert_eq!(stats.deleted, 0);
        assert!(outside.exists(), "a symlink must never let us unlink outside the log dir");
    }

    #[test]
    fn missing_log_dir_is_not_an_error() {
        let root = tmpdir("nologdir");
        let stats = prune_logs(&root.join("nope"), "sparkle.log", LogPolicy::default(), SystemTime::now()).unwrap();
        assert_eq!(stats, ReapStats::default());
    }
}
