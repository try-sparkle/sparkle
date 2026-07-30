//! Disk retention for the directories Sparkle grows without any upper bound.
//!
//! All three were unbounded by construction:
//!   - `<app_data>/hook-events/` — one `<agentId>.jsonl` per agent, appended to forever by
//!     `resources/sparkle-hook.mjs`. Never reaped: 606 files / 107 MB, oldest 3+ weeks old.
//!   - `<app_log_dir>/` — `tracing_appender::rolling::daily` rotates but never deletes:
//!     523 MB total, with single days at 116 MB.
//!   - `<app_data>/inbox/` — the Level 2 message queue (`inbox.rs`). Its `MAX_AGE_MS` expires a
//!     message LOGICALLY but nothing ever removed the bytes, so every `Stop` hook in every agent
//!     re-read and re-parsed that agent's ENTIRE message history at every turn boundary, and a
//!     spun-down worker's queue and claims directory persisted forever with nobody left to drain
//!     them. The store lives outside the worktree so it SURVIVES spin-down; "survives" was never
//!     meant to be "unbounded".
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

/// Retention rules for `<app_data>/inbox`.
#[derive(Clone, Copy, Debug)]
pub struct InboxPolicy {
    /// Drop message and ack records — and the claim files that go with them — once the RECORD is at
    /// least this old. Must be >= `inbox::MAX_AGE_MS`, or a still-deliverable message would be
    /// reaped out from under the agent it was queued for.
    pub max_record_age: Duration,
    /// Delete a whole per-agent inbox (messages + acks + claims) once its agent id has no worktree
    /// AND nothing in it has been touched for this long. The grace exists so an inbox written
    /// moments before its worktree appears is never reaped.
    pub orphan_max_age: Duration,
    /// Hard ceiling on records kept per file, whatever the age rule says. Bounds a burst that all
    /// lands inside the age window; the NEWEST records are the ones kept.
    pub max_records_per_file: usize,
}

impl Default for InboxPolicy {
    fn default() -> Self {
        Self {
            // Twice the delivery TTL. Derived from `MAX_AGE_MS` rather than written out, so raising
            // the TTL can never leave the reaper deleting messages that are still deliverable.
            max_record_age: Duration::from_millis(crate::inbox::MAX_AGE_MS as u64 * 2),
            orphan_max_age: Duration::from_secs(7 * 24 * 60 * 60),
            max_records_per_file: 10 * crate::inbox::MAX_PER_AGENT,
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
// (2) inbox retention
// ---------------------------------------------------------------------------

/// The files that make up one agent's inbox, as found on disk.
#[derive(Default)]
struct InboxFiles {
    /// `<agentId>.jsonl` — queued messages.
    messages: Option<(PathBuf, u64, SystemTime)>,
    /// `<agentId>.acks.jsonl` — acknowledgements the agent appended.
    acks: Option<(PathBuf, u64, SystemTime)>,
    /// `claims/<agentId>/`, with the mtime of its NEWEST claim file (`None` when it holds none).
    /// The directory's own mtime is deliberately not used: it moves when the reaper itself removes
    /// a file, so it would report activity that is only our own.
    claims: Option<(PathBuf, Option<SystemTime>)>,
}

impl InboxFiles {
    /// Age of the most recently touched RECORD in this inbox. `None` when nothing was stattable,
    /// which the caller treats as "don't judge it" rather than "it's ancient".
    fn newest_age(&self, now: SystemTime) -> Option<Duration> {
        [
            self.messages.as_ref().map(|(_, _, m)| *m),
            self.acks.as_ref().map(|(_, _, m)| *m),
            self.claims.as_ref().and_then(|(_, m)| *m),
        ]
        .into_iter()
        .flatten()
        .map(|m| age(now, m))
        .min()
    }
}

/// What one compaction pass did, and — the part the claim reaper depends on — which record ids
/// SURVIVED it.
struct Compaction {
    bytes_freed: u64,
    rewritten: bool,
    kept_ids: Vec<String>,
}

fn epoch_ms(t: SystemTime) -> i64 {
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Did the file change under us between reading it and being ready to publish the rewrite?
///
/// Split out as a pure function so the STAT-FAILURE arm is testable — a filesystem that errors on
/// stat is not something a unit test can arrange, the same reason `classify_worktrees_entry` above
/// is split out. The happy/grew arms are additionally covered end-to-end through `compact_records`
/// itself: `cap_protects` is invoked during planning, before the temp write and before this check,
/// so a test predicate that appends a line lands it inside the window deterministically.
///
/// A stat failure counts as CHANGED: we cannot confirm the file is the one we read, and the
/// conservative answer in a path that overwrites user data is to not publish.
fn source_grew(current_len: std::io::Result<u64>, len_at_read: u64) -> bool {
    match current_len {
        Ok(len) => len != len_at_read,
        Err(_) => true,
    }
}

/// Rewrite `path` keeping only records at or after `min_ts`, and at most `max_records` of them.
///
/// Age comes from the RECORD's own `ts`, not the file's mtime: one append refreshes the mtime of
/// every record in the file, so mtime cannot distinguish a stale record from a fresh one.
///
/// A line that does not parse as a record is KEPT. It is inert — `inbox::read_jsonl` already skips
/// it — and we cannot date it, so dropping it would be deleting data on a guess.
///
/// `cap_protects(id)` names records the `max_records` cap may NOT drop. The age rule is safe by
/// construction (an expired record is not deliverable), but the cap drops records that are still
/// INSIDE the deliverable window — so for the messages file it is handed a predicate that protects
/// anything unclaimed, i.e. anything `inbox_send` promised to deliver and no path has delivered yet.
/// Whatever the cap does drop is logged: a silent truncation reads to the concierge as "the agent
/// drained it".
///
/// Written to a temp sibling and renamed, exactly like `truncate_to_tail`, so a `Stop` hook reading
/// the file mid-pass sees either the old inode or the new one and never a torn file. Unlike the
/// hook-event case, though, a line lost to the swap is not recoverable: the messages file is
/// appended by `inbox::enqueue` AFTER it has already returned `Ok(id)` to the concierge, and the
/// acks file is appended by the agent's own shell, an entirely separate process. So two things
/// narrow that window rather than one:
///   1. The rewrite is SKIPPED ENTIRELY when nothing is due to be dropped — the overwhelming
///      majority of passes never open the window at all.
///   2. When it does rewrite, the source is re-stat'ed just before the rename and the swap is
///      ABANDONED if the file grew. The next pass retries; a dropped ack would be permanent, and
///      would leave `status_of` reporting `awaiting_ack >= 1` for the life of the record.
fn compact_records(
    path: &Path,
    min_ts: i64,
    max_records: usize,
    cap_protects: &dyn Fn(&str) -> bool,
) -> Result<Compaction, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read inbox log: {e}"))?;
    let ids_of = |lines: &[&str]| -> Vec<String> {
        lines.iter().filter_map(|l| crate::inbox::record_id_and_ts(l).map(|(id, _)| id)).collect()
    };

    let mut kept: Vec<&str> = Vec::new();
    let mut dropped = 0usize;
    for line in raw.lines() {
        if line.trim().is_empty() {
            dropped += 1;
            continue;
        }
        match crate::inbox::record_id_and_ts(line) {
            Some((_, ts)) if ts < min_ts => dropped += 1,
            _ => kept.push(line),
        }
    }
    if kept.len() > max_records {
        let mut budget = kept.len() - max_records;
        let mut capped: Vec<String> = Vec::new();
        // Front-to-back over an append-only file, so the OLDEST droppable records go first.
        kept.retain(|line| {
            if budget == 0 {
                return true;
            }
            // A line we cannot identify cannot be checked for deliverability, so it is protected —
            // same reasoning as the age rule keeping unparseable lines.
            let Some((id, _)) = crate::inbox::record_id_and_ts(line) else {
                return true;
            };
            if cap_protects(&id) {
                return true;
            }
            budget -= 1;
            capped.push(id);
            false
        });
        if !capped.is_empty() {
            dropped += capped.len();
            tracing::warn!(
                path = %path.display(),
                max_records,
                ids = %capped.join(","),
                "inbox retention: record cap dropped delivered records"
            );
        }
    }
    let kept_ids = ids_of(&kept);

    if dropped == 0 {
        return Ok(Compaction { bytes_freed: 0, rewritten: false, kept_ids });
    }

    let mut out = String::with_capacity(raw.len());
    for line in &kept {
        out.push_str(line);
        out.push('\n');
    }
    let dir = path.parent().ok_or_else(|| "compact: no parent dir".to_string())?;
    let tmp = dir.join(format!(
        ".{}.{}.compact.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("inbox"),
        std::process::id()
    ));
    std::fs::write(&tmp, out.as_bytes()).map_err(|e| format!("write compacted inbox: {e}"))?;

    // Someone appended while we were rewriting. Publishing now would discard their line.
    if source_grew(std::fs::metadata(path).map(|m| m.len()), raw.len() as u64) {
        let _ = std::fs::remove_file(&tmp);
        tracing::debug!(path = %path.display(), "inbox compaction abandoned: file grew mid-pass");
        // The file still holds EVERY record we read, so the surviving-id set must say so — a claim
        // reaped against the planned-but-unpublished set would re-deliver a record still on disk.
        return Ok(Compaction {
            bytes_freed: 0,
            rewritten: false,
            kept_ids: ids_of(&raw.lines().collect::<Vec<_>>()),
        });
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("publish compacted inbox: {e}")
    })?;
    Ok(Compaction {
        bytes_freed: (raw.len() as u64).saturating_sub(out.len() as u64),
        rewritten: true,
        kept_ids,
    })
}

/// Nothing named here may be joined onto a path — these are the shapes that would escape the dir.
fn usable_agent_id(id: &str) -> bool {
    !id.is_empty() && id != "." && id != ".." && !id.contains('/') && !id.contains('\\')
}

/// Reap `<app_data>/inbox`.
///
/// - Every agent's `<id>.jsonl` and `<id>.acks.jsonl` is compacted down to records newer than
///   `max_record_age` (and no more than `max_records_per_file` of them).
/// - A claim file is deleted only when it is past `max_record_age` AND its message id did not
///   survive compaction. **Both conditions matter.** A claim is the sole guard against the `Stop`
///   hook and the app-side idle path both delivering the same message; deleting one while its
///   message is still in the queue makes that message pending again and DOUBLE-DELIVERS it.
/// - A whole per-agent inbox (messages, acks, claims dir) is deleted when the agent id has no
///   worktree and nothing in it has been touched for `orphan_max_age`.
///
/// FAIL-CLOSED, same as `reap_hook_events`: when `live_agent_ids` cannot establish liveness, every
/// agent reads as an orphan, so the whole-inbox DELETION arm is skipped entirely. Compaction still
/// runs — it is keyed on record age alone and can never lose a recent message.
///
/// `now` is injected so the age policy is testable without sleeping.
pub fn reap_inbox(
    inbox_dir: &Path,
    worktrees_base: &Path,
    policy: InboxPolicy,
    now: SystemTime,
) -> Result<ReapStats, String> {
    let mut stats = ReapStats::default();
    let entries = match std::fs::read_dir(inbox_dir) {
        Ok(rd) => rd,
        // No inbox dir yet — nothing to do. Not an error.
        Err(_) => return Ok(stats),
    };
    let live = live_agent_ids(worktrees_base);

    // Gather the flat `<id>.jsonl` / `<id>.acks.jsonl` files. Only these two shapes are candidates;
    // anything else in the directory is left alone, and symlinks never pass `plain_file`.
    let mut agents: std::collections::BTreeMap<String, InboxFiles> = Default::default();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name == "claims" {
            continue; // handled below, as a directory
        }
        let (agent_id, is_ack) = match name.strip_suffix(".acks.jsonl") {
            Some(id) => (id, true),
            None => match name.strip_suffix(".jsonl") {
                Some(id) => (id, false),
                None => continue,
            },
        };
        if !usable_agent_id(agent_id) {
            continue;
        }
        let Some((size, mtime)) = plain_file(&path) else {
            continue; // directory, symlink, or unstattable — never a deletion candidate
        };
        let slot = agents.entry(agent_id.to_string()).or_default();
        if is_ack {
            slot.acks = Some((path, size, mtime));
        } else {
            slot.messages = Some((path, size, mtime));
        }
    }

    // ...and the per-agent claims directories, which can outlive both files.
    for entry in std::fs::read_dir(inbox_dir.join("claims")).into_iter().flatten().flatten() {
        let path = entry.path();
        let Ok(md) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if md.file_type().is_symlink() || !md.is_dir() {
            continue;
        }
        let Some(agent_id) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if !usable_agent_id(agent_id) {
            continue;
        }
        let agent_id = agent_id.to_string();
        let newest_claim = std::fs::read_dir(&path)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| plain_file(&e.path()).map(|(_, m)| m))
            .max();
        agents.entry(agent_id).or_default().claims = Some((path, newest_claim));
    }

    let min_ts = epoch_ms(now).saturating_sub(policy.max_record_age.as_millis() as i64);

    for (agent_id, files) in agents {
        // --- orphan arm: delete the WHOLE inbox, but only when liveness is actually known ---
        let is_orphan = match &live {
            Some(ids) => !ids.contains(&agent_id),
            None => false, // unknown liveness → treat as live → never delete
        };
        if is_orphan && files.newest_age(now).is_some_and(|a| a >= policy.orphan_max_age) {
            for (path, size, _) in [files.messages.as_ref(), files.acks.as_ref()].into_iter().flatten()
            {
                match std::fs::remove_file(path) {
                    Ok(()) => {
                        stats.deleted += 1;
                        stats.bytes_freed += size;
                    }
                    Err(e) => tracing::warn!(path = %path.display(), "reap inbox file failed: {e}"),
                }
            }
            if let Some((claims, _)) = &files.claims {
                let n = std::fs::read_dir(claims).into_iter().flatten().flatten().count() as u32;
                match std::fs::remove_dir_all(claims) {
                    Ok(()) => stats.deleted += n,
                    Err(e) => tracing::warn!(path = %claims.display(), "reap inbox claims failed: {e}"),
                }
            }
            continue;
        }

        // --- compaction arm: safe whether or not liveness is known ---
        // `None` means we could not read the message file, so we do not know which ids are still
        // live and MUST NOT touch this agent's claims — see the double-delivery note above.
        // The cap may only drop messages that have already been DELIVERED. An unclaimed, unexpired
        // message is one `inbox_send` reported success for and nobody has shown the agent yet;
        // dropping it would make the concierge believe a message it never delivered was drained.
        // `MAX_PER_AGENT` bounds the unclaimed set at 50, well under any sane cap, so protecting
        // them cannot wedge the cap open.
        let agent_claims = inbox_dir.join("claims").join(&agent_id);
        let cap_protects_undelivered = |id: &str| !crate::inbox::is_claimed(&agent_claims, id);

        let mut surviving_ids: Option<Vec<String>> = match &files.messages {
            Some((path, _, _)) => match compact_records(
                path,
                min_ts,
                policy.max_records_per_file,
                &cap_protects_undelivered,
            ) {
                Ok(c) => {
                    if c.rewritten {
                        stats.truncated += 1;
                        stats.bytes_freed += c.bytes_freed;
                    }
                    Some(c.kept_ids)
                }
                Err(e) => {
                    tracing::warn!(path = %path.display(), "compact inbox messages failed: {e}");
                    None
                }
            },
            // No message file at all: nothing can be delivered, so no claim can be a live one.
            None => Some(Vec::new()),
        };
        if let Some((path, _, _)) = &files.acks {
            // An ack is a record of something that already happened; nothing is owed a delivery, so
            // the cap has nothing to protect here.
            match compact_records(path, min_ts, policy.max_records_per_file, &|_| false) {
                Ok(c) if c.rewritten => {
                    stats.truncated += 1;
                    stats.bytes_freed += c.bytes_freed;
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(path = %path.display(), "compact inbox acks failed: {e}"),
            }
        }

        let (Some((claims, _)), Some(kept)) = (&files.claims, surviving_ids.take()) else {
            continue;
        };
        let kept: std::collections::HashSet<&str> = kept.iter().map(String::as_str).collect();
        for entry in std::fs::read_dir(claims).into_iter().flatten().flatten() {
            let path = entry.path();
            let Some(id) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if kept.contains(id) {
                continue; // its message is still queued — removing the claim re-delivers it
            }
            let Some((size, mtime)) = plain_file(&path) else {
                continue;
            };
            if age(now, mtime) < policy.max_record_age {
                continue;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    stats.deleted += 1;
                    stats.bytes_freed += size;
                }
                Err(e) => tracing::warn!(path = %path.display(), "reap inbox claim failed: {e}"),
            }
        }
        // An emptied claims dir would otherwise linger forever per agent. `remove_dir` is
        // non-recursive, so it simply fails and leaves things alone if anything is still in there.
        let _ = std::fs::remove_dir(claims);
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

    // -- (2) inbox retention -----------------------------------------------

    use crate::inbox;

    const HOUR: Duration = Duration::from_secs(60 * 60);

    /// A test policy with short, obvious windows so the intent of each assertion is readable.
    fn inbox_policy() -> InboxPolicy {
        InboxPolicy {
            max_record_age: 24 * HOUR,
            orphan_max_age: 7 * DAY,
            max_records_per_file: 100,
        }
    }

    fn set_mtime(path: &Path, t: SystemTime) {
        let f = std::fs::File::options().write(true).open(path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }

    fn msg_line(id: &str, ts: i64) -> String {
        serde_json::to_string(&inbox::InboxMessage {
            id: id.into(),
            ts,
            from: "concierge".into(),
            text: format!("message {id}"),
            severity: inbox::Severity::Fyi,
        })
        .unwrap()
    }

    fn ack_line(id: &str, ts: i64) -> String {
        serde_json::to_string(&inbox::InboxAck { id: id.into(), ts, note: None }).unwrap()
    }

    /// Write whole JSONL lines and stamp the file's mtime `age_ago` in the past.
    fn write_records(path: &Path, lines: &[String], now: SystemTime, age_ago: Duration) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut body = String::new();
        for l in lines {
            body.push_str(l);
            body.push('\n');
        }
        std::fs::write(path, body).unwrap();
        set_mtime(path, now - age_ago);
    }

    /// A delivered-message claim file, backdated to `age_ago`.
    fn write_claim(claims: &Path, id: &str, now: SystemTime, age_ago: Duration) {
        std::fs::create_dir_all(claims).unwrap();
        std::fs::write(claims.join(id), b"").unwrap();
        set_mtime(&claims.join(id), now - age_ago);
    }

    /// Ids currently in a messages/acks file, in order.
    fn ids_in(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| inbox::record_id_and_ts(l).map(|(id, _)| id))
            .collect()
    }

    fn ms(now: SystemTime, ago: Duration) -> i64 {
        epoch_ms(now) - ago.as_millis() as i64
    }

    #[test]
    fn an_expired_message_is_removed_from_the_file_while_a_recent_one_survives() {
        // MAX_AGE_MS expires a message LOGICALLY; nothing removed the bytes, so every Stop hook
        // re-read the agent's whole history at every turn boundary. The side effect to assert is
        // that the FILE shrank — not merely that `pending` stopped returning the old message,
        // which was already true before this change.
        let root = tmpdir("inbox-compact");
        let worktrees = root.join("worktrees");
        mkagent(&worktrees, "proj", "a1");
        let now = SystemTime::now();

        let msgs = inbox::messages_path(&root, "a1");
        write_records(
            &msgs,
            &[msg_line("m-old", ms(now, 48 * HOUR)), msg_line("m-new", ms(now, HOUR))],
            now,
            HOUR,
        );
        let before = std::fs::metadata(&msgs).unwrap().len();

        let stats = reap_inbox(&inbox::inbox_dir(&root), &worktrees, inbox_policy(), now).unwrap();

        assert_eq!(stats.truncated, 1, "the messages file was rewritten");
        assert!(stats.bytes_freed > 0);
        assert_eq!(ids_in(&msgs), vec!["m-new".to_string()], "the expired record is gone from disk");
        assert!(std::fs::metadata(&msgs).unwrap().len() < before);
        // And the surviving message is still deliverable — compaction must not eat live work.
        let p = inbox::pending(&root, "a1", epoch_ms(now));
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].id, "m-new");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_ack_log_is_compacted_by_age_the_same_way() {
        let root = tmpdir("inbox-acks");
        let worktrees = root.join("worktrees");
        mkagent(&worktrees, "proj", "a1");
        let now = SystemTime::now();

        let acks = inbox::acks_path(&root, "a1");
        write_records(
            &acks,
            &[ack_line("m-old", ms(now, 72 * HOUR)), ack_line("m-new", ms(now, 2 * HOUR))],
            now,
            HOUR,
        );

        let stats = reap_inbox(&inbox::inbox_dir(&root), &worktrees, inbox_policy(), now).unwrap();

        assert_eq!(stats.truncated, 1);
        assert_eq!(ids_in(&acks), vec!["m-new".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_with_nothing_to_drop_is_left_byte_for_byte_intact() {
        // The rewrite races an O_APPEND writer, so it must not happen on the overwhelming majority
        // of passes where nothing is actually due.
        let root = tmpdir("inbox-noop");
        let worktrees = root.join("worktrees");
        mkagent(&worktrees, "proj", "a1");
        let now = SystemTime::now();
        let msgs = inbox::messages_path(&root, "a1");
        write_records(&msgs, &[msg_line("m1", ms(now, HOUR))], now, HOUR);
        let before = std::fs::read(&msgs).unwrap();
        let before_mtime = std::fs::metadata(&msgs).unwrap().modified().unwrap();

        let stats = reap_inbox(&inbox::inbox_dir(&root), &worktrees, inbox_policy(), now).unwrap();

        assert_eq!(stats, ReapStats::default(), "no rewrite, no deletions");
        assert_eq!(std::fs::read(&msgs).unwrap(), before);
        assert_eq!(std::fs::metadata(&msgs).unwrap().modified().unwrap(), before_mtime);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_stale_claim_goes_but_a_live_messages_claim_stays_so_nothing_is_delivered_twice() {
        // THE SHARPEST FAILURE MODE. A claim file is the only thing stopping the Stop hook and the
        // app-side idle path from both delivering the same message. Reaping a claim whose message
        // is still queued makes that message pending again — a DUPLICATE delivery, which is the
        // exact bug `claim()` exists to prevent.
        let root = tmpdir("inbox-claims");
        let worktrees = root.join("worktrees");
        mkagent(&worktrees, "proj", "a1");
        let now = SystemTime::now();

        let msgs = inbox::messages_path(&root, "a1");
        write_records(
            &msgs,
            &[msg_line("m-ancient", ms(now, 72 * HOUR)), msg_line("m-recent", ms(now, HOUR))],
            now,
            HOUR,
        );
        // BOTH claim files are old enough to look stale by mtime alone; only the one whose message
        // is gone may be removed.
        let claims = inbox::claims_dir(&root, "a1");
        write_claim(&claims, "m-ancient", now, 72 * HOUR);
        write_claim(&claims, "m-recent", now, 48 * HOUR);

        let stats = reap_inbox(&inbox::inbox_dir(&root), &worktrees, inbox_policy(), now).unwrap();

        assert_eq!(stats.deleted, 1, "only the orphaned claim");
        assert!(!claims.join("m-ancient").exists(), "a claim for a reaped message is dead weight");
        assert!(
            claims.join("m-recent").exists(),
            "its message is still queued; dropping the claim would re-deliver it"
        );
        // Proven, not assumed: the still-queued message stays out of `pending`.
        assert!(
            inbox::pending(&root, "a1", epoch_ms(now)).is_empty(),
            "m-recent must remain claimed — a second delivery path must find nothing to send"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_orphaned_agents_whole_inbox_is_removed() {
        let root = tmpdir("inbox-orphan");
        let worktrees = root.join("worktrees");
        mkagent(&worktrees, "proj", "a-live");
        let now = SystemTime::now();

        // A spun-down worker: worktree gone, inbox untouched for weeks.
        let gone_msgs = inbox::messages_path(&root, "a-gone");
        let gone_acks = inbox::acks_path(&root, "a-gone");
        let gone_claims = inbox::claims_dir(&root, "a-gone");
        write_records(&gone_msgs, &[msg_line("m1", ms(now, 30 * DAY))], now, 30 * DAY);
        write_records(&gone_acks, &[ack_line("m1", ms(now, 30 * DAY))], now, 30 * DAY);
        write_claim(&gone_claims, "m1", now, 30 * DAY);

        // A live agent whose inbox is equally ancient on disk but still holds a fresh message.
        let live_msgs = inbox::messages_path(&root, "a-live");
        write_records(
            &live_msgs,
            &[msg_line("m2-old", ms(now, 30 * DAY)), msg_line("m2-new", ms(now, HOUR))],
            now,
            30 * DAY,
        );

        let stats = reap_inbox(&inbox::inbox_dir(&root), &worktrees, inbox_policy(), now).unwrap();

        assert!(!gone_msgs.exists(), "orphan messages removed");
        assert!(!gone_acks.exists(), "orphan acks removed");
        assert!(!gone_claims.exists(), "orphan claims dir removed");
        assert_eq!(stats.deleted, 3, "two files plus the one claim");
        assert_eq!(
            ids_in(&live_msgs),
            vec!["m2-new".to_string()],
            "a live agent's inbox is compacted, never deleted — its pending message survives"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_fresh_orphan_inside_the_grace_is_kept() {
        // Its worktree may still be mid-creation.
        let root = tmpdir("inbox-orphan-fresh");
        let worktrees = root.join("worktrees");
        std::fs::create_dir_all(worktrees.join("proj")).unwrap();
        let now = SystemTime::now();
        let msgs = inbox::messages_path(&root, "a-new");
        write_records(&msgs, &[msg_line("m1", ms(now, HOUR))], now, HOUR);

        let stats = reap_inbox(&inbox::inbox_dir(&root), &worktrees, inbox_policy(), now).unwrap();

        assert_eq!(stats.deleted, 0);
        assert!(msgs.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inbox_never_deletes_when_the_worktrees_dir_is_unreadable() {
        // FAIL-CLOSED. An unreadable worktrees dir makes EVERY agent look orphaned, so the deletion
        // arm must be skipped wholesale. Compaction is keyed on record age alone and stays on —
        // asserted here so this test cannot pass by the reaper simply doing nothing at all.
        let root = tmpdir("inbox-failclosed");
        let now = SystemTime::now();
        let msgs = inbox::messages_path(&root, "a-looks-orphaned");
        let claims = inbox::claims_dir(&root, "a-looks-orphaned");
        write_records(
            &msgs,
            &[msg_line("m-old", ms(now, 90 * DAY)), msg_line("m-new", ms(now, HOUR))],
            now,
            90 * DAY,
        );
        write_claim(&claims, "m-new", now, 90 * DAY);

        let missing = root.join("does-not-exist");
        let stats = reap_inbox(&inbox::inbox_dir(&root), &missing, inbox_policy(), now).unwrap();

        assert!(msgs.exists(), "a possibly-live agent's inbox must survive unknown liveness");
        assert!(claims.join("m-new").exists(), "and its live claim with it");
        assert_eq!(stats.deleted, 0, "the deletion arm is skipped entirely");
        assert_eq!(
            ids_in(&msgs),
            vec!["m-new".to_string()],
            "compaction still runs — it can never lose a recent message"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_burst_of_delivered_messages_inside_the_age_window_is_capped_to_the_newest() {
        let root = tmpdir("inbox-burst");
        let worktrees = root.join("worktrees");
        mkagent(&worktrees, "proj", "a1");
        let now = SystemTime::now();
        let policy = InboxPolicy { max_records_per_file: 3, ..inbox_policy() };

        let lines: Vec<String> = (0..10).map(|i| msg_line(&format!("m{i}"), ms(now, HOUR))).collect();
        let msgs = inbox::messages_path(&root, "a1");
        write_records(&msgs, &lines, now, HOUR);
        // All ten were delivered, so the cap is free to drop the oldest.
        let claims = inbox::claims_dir(&root, "a1");
        for i in 0..10 {
            write_claim(&claims, &format!("m{i}"), now, Duration::from_secs(30));
        }

        reap_inbox(&inbox::inbox_dir(&root), &worktrees, policy, now).unwrap();

        assert_eq!(ids_in(&msgs), vec!["m7".to_string(), "m8".into(), "m9".into()], "newest kept");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_record_cap_never_drops_a_message_that_was_never_delivered() {
        // The age rule is safe by construction — an expired message is not deliverable. The CAP is
        // not: it drops records that are still inside the window. `inbox_send` has already returned
        // success for those, so dropping an unclaimed one loses a message the concierge believes it
        // sent, and `status_of` reports the lower `pending` as "the agent drained it".
        let root = tmpdir("inbox-cap-undelivered");
        let worktrees = root.join("worktrees");
        mkagent(&worktrees, "proj", "a1");
        let now = SystemTime::now();
        let policy = InboxPolicy { max_records_per_file: 2, ..inbox_policy() };

        let lines: Vec<String> = (0..6).map(|i| msg_line(&format!("m{i}"), ms(now, HOUR))).collect();
        let msgs = inbox::messages_path(&root, "a1");
        write_records(&msgs, &lines, now, HOUR);
        // Only the two oldest were ever delivered.
        let claims = inbox::claims_dir(&root, "a1");
        write_claim(&claims, "m0", now, Duration::from_secs(30));
        write_claim(&claims, "m1", now, Duration::from_secs(30));

        reap_inbox(&inbox::inbox_dir(&root), &worktrees, policy, now).unwrap();

        assert_eq!(
            ids_in(&msgs),
            vec!["m2".to_string(), "m3".into(), "m4".into(), "m5".into()],
            "the cap took the delivered pair and stopped; it may not exceed its budget by eating \
             undelivered messages"
        );
        // The side effect that actually matters: every undelivered message is still deliverable.
        let still_pending: Vec<String> =
            inbox::pending(&root, "a1", epoch_ms(now)).into_iter().map(|m| m.id).collect();
        assert_eq!(still_pending, vec!["m2".to_string(), "m3".into(), "m4".into(), "m5".into()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_fresh_claim_survives_even_when_its_message_is_gone() {
        // The OTHER half of the two-condition claim rule. `kept_ids` is not the only guard: a claim
        // written moments ago must survive whatever happened to its message (reaped by age, dropped
        // by the cap, a torn record, a short read), because the message could be re-appended or the
        // read could have been wrong, and a missing claim is a duplicate delivery.
        let root = tmpdir("inbox-fresh-claim");
        let worktrees = root.join("worktrees");
        mkagent(&worktrees, "proj", "a1");
        let now = SystemTime::now();

        let msgs = inbox::messages_path(&root, "a1");
        write_records(&msgs, &[msg_line("m-expired", ms(now, 72 * HOUR))], now, HOUR);
        let claims = inbox::claims_dir(&root, "a1");
        write_claim(&claims, "m-expired", now, Duration::from_secs(30)); // claimed 30s ago

        let stats = reap_inbox(&inbox::inbox_dir(&root), &worktrees, inbox_policy(), now).unwrap();

        assert_eq!(ids_in(&msgs), Vec::<String>::new(), "the message itself did age out");
        assert!(
            claims.join("m-expired").exists(),
            "its claim is younger than max_record_age, so the age half of the rule keeps it"
        );
        assert_eq!(stats.deleted, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn source_grew_treats_an_unstattable_file_as_changed() {
        // The arm a real filesystem cannot be made to produce on demand. The other two are covered
        // end-to-end below.
        assert!(!source_grew(Ok(4096), 4096), "unchanged → publish");
        assert!(source_grew(Ok(4200), 4096), "someone appended → abandon this pass and retry later");
        assert!(
            source_grew(Err(std::io::Error::other("stat failed")), 4096),
            "cannot confirm the file is the one we read → never publish over it"
        );
    }

    #[test]
    fn an_abandoned_rewrite_keeps_every_record_and_reports_the_full_on_disk_id_set() {
        // A line appended between the read and the rename would be discarded by the swap, and for
        // an ack — written by the agent's own shell, a separate process — that loss is permanent:
        // the claim survives, so `status_of` reports `awaiting_ack >= 1` forever.
        //
        // The subtler half is what the abandoned pass REPORTS. `kept_ids` must describe what is
        // actually on disk, not the rewrite we planned and threw away: the caller reaps claims
        // against it, so returning the shrunken planned set would make every claim the pass meant
        // to drop reapable while its message is still queued — the double delivery `claim()`
        // exists to prevent.
        //
        // `cap_protects` runs during planning, before the temp write and before the re-stat, so a
        // predicate that appends lands the line inside the window deterministically.
        use std::io::Write;
        let root = tmpdir("inbox-abandon");
        let now = SystemTime::now();
        let msgs = inbox::messages_path(&root, "a1");
        write_records(
            &msgs,
            &[
                msg_line("m-old", ms(now, 72 * HOUR)), // planned drop: age
                msg_line("m-a", ms(now, HOUR)),        // planned drop: cap
                msg_line("m-b", ms(now, HOUR)),
                msg_line("m-c", ms(now, HOUR)),
            ],
            now,
            HOUR,
        );
        let before = std::fs::read_to_string(&msgs).unwrap();

        let raced = std::cell::Cell::new(false);
        let racing_writer = |_id: &str| {
            if !raced.replace(true) {
                let mut f = std::fs::OpenOptions::new().append(true).open(&msgs).unwrap();
                writeln!(f, "{}", msg_line("m-raced", ms(now, Duration::ZERO))).unwrap();
            }
            false // protects nothing, so the cap arm actually drops and forces the rewrite
        };
        let min_ts = epoch_ms(now) - (24 * HOUR).as_millis() as i64;

        let c = compact_records(&msgs, min_ts, 2, &racing_writer).unwrap();

        assert!(raced.get(), "the test's own precondition: the append happened mid-plan");
        assert!(!c.rewritten, "the swap must be abandoned, not published");
        assert_eq!(c.bytes_freed, 0);
        assert_eq!(
            c.kept_ids,
            vec!["m-old".to_string(), "m-a".into(), "m-b".into(), "m-c".into()],
            "an abandoned pass reports what is ON DISK — including the records it planned to drop \
             — or their claims get reaped while the messages are still queued"
        );
        // Nothing was lost, and nothing was left behind.
        let after = std::fs::read_to_string(&msgs).unwrap();
        assert_eq!(after, format!("{before}{}\n", msg_line("m-raced", ms(now, Duration::ZERO))));
        let strays: Vec<_> = std::fs::read_dir(inbox::inbox_dir(&root))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".compact.tmp"))
            .collect();
        assert!(strays.is_empty(), "the temp file must be cleaned up, got {strays:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unparseable_line_is_kept_because_we_cannot_date_it() {
        let root = tmpdir("inbox-torn");
        let worktrees = root.join("worktrees");
        mkagent(&worktrees, "proj", "a1");
        let now = SystemTime::now();
        let msgs = inbox::messages_path(&root, "a1");
        write_records(
            &msgs,
            &[
                "{\"id\":\"torn\",".to_string(),
                msg_line("m-old", ms(now, 72 * HOUR)),
                msg_line("m-new", ms(now, HOUR)),
            ],
            now,
            HOUR,
        );

        reap_inbox(&inbox::inbox_dir(&root), &worktrees, inbox_policy(), now).unwrap();

        let body = std::fs::read_to_string(&msgs).unwrap();
        assert!(body.contains("torn"), "a line we cannot date is not deleted on a guess");
        assert!(!body.contains("m-old"), "but a datable expired record still goes");
        assert!(body.contains("m-new"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inbox_reap_ignores_symlinks_and_unrelated_files() {
        let root = tmpdir("inbox-shapes");
        let worktrees = root.join("worktrees");
        std::fs::create_dir_all(&worktrees).unwrap();
        let dir = inbox::inbox_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        let now = SystemTime::now();

        // Something valuable outside the inbox, with a symlink to it planted inside.
        let outside = root.join("precious.jsonl");
        write_records(&outside, &[msg_line("keep-me", ms(now, 90 * DAY))], now, 90 * DAY);
        std::os::unix::fs::symlink(&outside, dir.join("evil.jsonl")).unwrap();
        // And a file that is not part of the inbox at all.
        let readme = dir.join("README.txt");
        write_records(&readme, &[msg_line("x", ms(now, 90 * DAY))], now, 90 * DAY);

        let stats = reap_inbox(&dir, &worktrees, inbox_policy(), now).unwrap();

        assert_eq!(stats, ReapStats::default());
        assert!(outside.exists(), "a symlink must never let us rewrite or unlink outside the dir");
        assert_eq!(
            ids_in(&outside),
            vec!["keep-me".to_string()],
            "and never let us compact the target either"
        );
        assert!(readme.exists(), "unrelated user files are left alone");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_inbox_dir_is_not_an_error() {
        let root = tmpdir("inbox-nodir");
        let stats = reap_inbox(
            &inbox::inbox_dir(&root),
            &root.join("worktrees"),
            InboxPolicy::default(),
            SystemTime::now(),
        )
        .unwrap();
        assert_eq!(stats, ReapStats::default());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_default_compaction_window_outlives_the_delivery_ttl() {
        // If these ever cross, the reaper deletes messages the queue still considers deliverable.
        let p = InboxPolicy::default();
        assert!(
            p.max_record_age >= Duration::from_millis(crate::inbox::MAX_AGE_MS as u64),
            "compaction must not outrun the TTL"
        );
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

    /// The long-session case. A prune that runs only at launch enforces the cap against the state
    /// the process BOOTED into; `rolling::daily` then opens a new file at every midnight and the
    /// directory grows past the cap with nothing to reap it. Sparkle sessions span days, so this is
    /// the common case, not the edge one — measured in the field as a log dir sitting just over the
    /// 256 MB cap with no restart due.
    ///
    /// So: a second pass over a directory that has since grown must bring it back under budget, and
    /// must do it without touching the file being appended to right now.
    #[test]
    fn a_later_pass_reaps_the_days_that_rolled_over_since_the_first_one() {
        let root = tmpdir("logrollover");
        let now = SystemTime::now();
        let policy = LogPolicy { max_age: 365 * DAY, max_total_bytes: 2500, keep_newest: 2 };

        // Boot state: already inside the cap, so the launch pass has nothing to do.
        write_aged(&root.join("sparkle.log.day1"), 1000, now, 2 * DAY);
        write_aged(&root.join("sparkle.log.day2"), 1000, now, DAY);
        let first = prune_logs(&root, "sparkle.log", policy, now).unwrap();
        assert_eq!(first.deleted, 0, "a dir already under the cap is left alone");

        // Two midnights pass without a restart; the appender has rolled twice and is writing day4.
        write_aged(&root.join("sparkle.log.day3"), 1000, now, Duration::from_secs(3600));
        write_aged(&root.join("sparkle.log.day4"), 1000, now, Duration::from_secs(1));

        let second = prune_logs(&root, "sparkle.log", policy, now).unwrap();

        assert_eq!(second.deleted, 2, "4000 bytes must come back under the 2500 cap");
        assert!(!root.join("sparkle.log.day1").exists(), "oldest goes first");
        assert!(!root.join("sparkle.log.day2").exists());
        assert!(root.join("sparkle.log.day3").exists());
        assert!(
            root.join("sparkle.log.day4").exists(),
            "the file the appender holds open is the newest, so keep_newest protects it"
        );
        let _ = std::fs::remove_dir_all(&root);
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
