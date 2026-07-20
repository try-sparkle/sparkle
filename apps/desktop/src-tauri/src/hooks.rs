//! Claude Code event hooks (): register Sparkle's event emitter
//! (resources/sparkle-hook.mjs) in each agent worktree's `.claude/settings.local.json` so the
//! app derives status from Claude's own lifecycle events instead of scraping its TUI.
//!
//! The emitter appends one JSON line per event to a per-agent log under the app-data dir
//! (outside the worktree, so it never shows up in the user's `git status`). A watcher tails
//! that log and feeds the frontend HookStatusEngine (see src/engine/hookEvents.ts).
//!
//! This installer composes with `worktree::install_worktree_guard`: both merge into the same
//! settings file, each preserving the other's entries (the guard is matched by
//! `worktree-guard.mjs`, the emitter by `sparkle-hook.mjs`).
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

/// Substring identifying a Sparkle emitter hook entry, for idempotent reinstall.
const EMITTER_MARKER: &str = "sparkle-hook.mjs";
/// Substring identifying the worktree write-guard hook entry (installed by `worktree.rs`). Healed
/// here too, since it has the same baked-absolute-path fragility as the emitter.
const GUARD_MARKER: &str = "worktree-guard.mjs";
/// Tool-scoped events carry a `matcher`; we want every tool, so `*`.
const TOOL_EVENTS: &[&str] = &["PreToolUse", "PostToolUse"];
/// Lifecycle events with no tool matcher.
const PLAIN_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "SubagentStop",
    "SessionStart",
    "SessionEnd",
];

/// Minimal POSIX single-quote escaping for embedding a path in a hook command string.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A hook command: `node '<script>' '<arg>'`. Both the emitter (arg = event-log path) and the
/// write-guard (arg = worktree path) share this shape.
fn hook_command(script: &Path, arg: &Path) -> String {
    format!(
        "node {} {}",
        shell_quote(&script.to_string_lossy()),
        shell_quote(&arg.to_string_lossy())
    )
}

/// Per-process counter so concurrent stages (several agents opening at once) never collide on the
/// same temp filename before the atomic rename below.
static STAGE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Copy a bundled resource script (`resources/<name>`) into a STABLE app-data location
/// (`<app_data>/bin/<name>`) and return that stable path.
///
/// Why: the absolute script path is baked into each worktree's `.claude/settings.local.json` hook
/// commands. If we pointed those at the app *bundle* (`<App>.app/Contents/Resources/...`), then
/// renaming/replacing/deleting the bundle (e.g. running "Sparkle 2.app", then swapping in a new
/// build) orphans every hook the old bundle ever wrote — Claude then fails to run them with
/// `MODULE_NOT_FOUND`. The app-data dir is independent of the bundle's name/location and lives
/// next to the worktrees themselves, so a path under it survives app rename/reinstall.
///
/// Published atomically (copy to a temp sibling, then rename) so a hook firing in parallel never
/// reads a half-written script.
pub fn stage_resource_script(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let src = app
        .path()
        .resolve(format!("resources/{name}"), BaseDirectory::Resource)
        .map_err(|e| format!("{name} missing in bundle: {e}"))?;
    let dir = crate::dev_identity::app_data_dir(app)?.join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir bin: {e}"))?;
    let dst = dir.join(name);
    let seq = STAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{name}.{}.{seq}.tmp", std::process::id()));
    std::fs::copy(&src, &tmp).map_err(|e| format!("stage {name}: {e}"))?;
    std::fs::rename(&tmp, &dst).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("publish {name}: {e}")
    })?;
    Ok(dst)
}

/// Replace a file atomically: write a temp sibling in the SAME dir, then rename over the target.
/// `settings.local.json` drives executable hooks and may be read by a running Claude (e.g. the
/// launch-time heal sweep races already-open agents), so a reader must never observe a
/// truncated/partial write. Same dir keeps the rename atomic (one filesystem).
///
/// Refuses to clobber the target with invalid JSON: `contents` is parsed first, so a bug upstream
/// can never replace a good settings file with garbage Claude would fail to load. Our merge/heal
/// producers always emit valid JSON, so this is belt-and-suspenders that also documents the invariant.
fn atomic_write_settings(path: &Path, contents: &str) -> Result<(), String> {
    serde_json::from_str::<Value>(contents)
        .map_err(|e| format!("atomic_write_settings: refusing to write invalid JSON: {e}"))?;
    let dir = path
        .parent()
        .ok_or_else(|| "atomic_write_settings: no parent dir".to_string())?;
    let seq = STAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".settings.{}.{seq}.tmp", std::process::id()));
    std::fs::write(&tmp, contents).map_err(|e| format!("atomic_write tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("atomic_write rename: {e}")
    })
}

/// True if this settings entry's `hooks[].command` contains `marker`.
fn entry_has_marker(e: &Value, marker: &str) -> bool {
    e.get("hooks")
        .and_then(|h| h.as_array())
        .map(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(marker))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Merge the emitter into each tracked event of a settings JSON (or a fresh object),
/// preserving any keys/hooks the user (or the write-guard) already has. Idempotent: a prior
/// Sparkle emitter entry is replaced, not duplicated.
pub fn merge_event_hooks(existing: Option<&str>, emitter_cmd: &str) -> String {
    let mut root: Value = existing
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks_obj = hooks.as_object_mut().unwrap();

    for (events, with_matcher) in [(TOOL_EVENTS, true), (PLAIN_EVENTS, false)] {
        for &ev in events {
            let arr_val = hooks_obj.entry(ev).or_insert_with(|| json!([]));
            if !arr_val.is_array() {
                *arr_val = json!([]);
            }
            let arr = arr_val.as_array_mut().unwrap();
            // Drop any prior emitter entry so reinstall is idempotent; keep everything else
            // (notably the worktree-guard's PreToolUse entry).
            arr.retain(|e| !entry_has_marker(e, EMITTER_MARKER));
            let mut entry = json!({ "hooks": [ { "type": "command", "command": emitter_cmd } ] });
            if with_matcher {
                entry
                    .as_object_mut()
                    .unwrap()
                    .insert("matcher".into(), json!("*"));
            }
            arr.push(entry);
        }
    }
    serde_json::to_string_pretty(&root).unwrap()
}

/// The per-agent log filename key: the worktree's basename (its agent UUID), or "agent" if the
/// path has no usable final component. Pure, so the basename/fallback is unit-testable without an
/// AppHandle.
fn log_key(worktree: &str) -> String {
    Path::new(worktree)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("agent")
        .to_string()
}

/// Per-agent event-log path: `<app_data>/hook-events/<agentId>.jsonl`. The worktree's basename
/// is the agent's UUID (worktrees live at `<app_data>/worktrees/<projectId>/<agentId>`), so it's
/// a stable, collision-free key — and the log sits outside the worktree, invisible to git.
pub fn event_log_path(app: &AppHandle, worktree: &str) -> Result<PathBuf, String> {
    let base = crate::dev_identity::app_data_dir(app)?;
    Ok(base
        .join("hook-events")
        .join(format!("{}.jsonl", log_key(worktree))))
}

/// Confine a frontend-supplied worktree path to the app's managed worktrees dir before we write
/// an executable hook config into it. `install_agent_hooks` writes `.claude/settings.local.json`,
/// which Claude Code runs hook *commands* from — so an unconfined path is a write-anywhere →
/// persistent-code-execution primitive (e.g. planting hooks in `$HOME`). Canonicalize BOTH sides
/// (resolving symlinks and `..`) and require the worktree to live under `<app_data>/worktrees`.
/// Fail-closed: a base that can't be resolved, or a non-existent worktree, is rejected. Pure core
/// (no AppHandle) so it unit-tests. Mirrors `pty::validate_spawn_inner`.
fn confine_to_worktrees(worktrees_base: &Path, worktree: &str) -> Result<PathBuf, String> {
    let base = worktrees_base
        .canonicalize()
        .map_err(|e| format!("install_agent_hooks: worktrees dir unavailable: {e}"))?;
    let real = std::fs::canonicalize(worktree)
        .map_err(|e| format!("install_agent_hooks: invalid worktree path: {e}"))?;
    if !real.starts_with(&base) {
        return Err("install_agent_hooks: worktree is outside the managed worktrees directory".into());
    }
    Ok(real)
}

/// Write/merge the event emitter into `<worktree>/.claude/settings.local.json`. Returns the
/// absolute event-log path so the frontend can start watching it.
#[tauri::command]
pub fn install_agent_hooks(app: AppHandle, worktree: String) -> Result<String, String> {
    // Confine the write target to the managed worktrees dir — this file drives executable hooks.
    let worktrees_base = crate::dev_identity::app_data_dir(&app)?.join("worktrees");
    let worktree_dir = confine_to_worktrees(&worktrees_base, &worktree)?;

    // Stage the emitter to a stable app-data path (not the app bundle) so the command baked into
    // settings.local.json survives the bundle being renamed/replaced/removed (see stage_resource_script).
    let emitter = stage_resource_script(&app, "sparkle-hook.mjs")?;
    let log = event_log_path(&app, &worktree)?;
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir hook-events: {e}"))?;
    }
    let emitter_cmd = hook_command(&emitter, &log);

    let dir = worktree_dir.join(".claude");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir .claude: {e}"))?;
    let file = dir.join("settings.local.json");
    let existing = std::fs::read_to_string(&file).ok();
    let merged = merge_event_hooks(existing.as_deref(), &emitter_cmd);
    // Atomic + JSON-validated: a concurrently-running Claude (this file drives its executable hooks)
    // must never read a truncated/partial write, and we refuse to clobber with invalid JSON.
    atomic_write_settings(&file, &merged)?;
    Ok(log.to_string_lossy().into_owned())
}

/// A settings file needs healing for `marker` when it still registers that hook but the command
/// does NOT reference the current stable script path — i.e. it points at an old/renamed bundle.
/// Pure (string-only) so it's unit-testable. A file that never had the hook is left untouched.
fn needs_heal(settings: &str, marker: &str, stable_path: &str) -> bool {
    settings.contains(marker) && !settings.contains(stable_path)
}

/// Rewrite stale emitter/guard hook commands in one settings file to the current stable paths,
/// preserving everything else (user keys, the other hook, ordering). Returns the updated JSON only
/// if something actually changed — so an already-stable (or hook-free) file is left byte-for-byte
/// intact and isn't needlessly rewritten. Pure, so the heal policy is unit-tested.
fn heal_settings(settings: &str, emitter: &Path, emitter_cmd: &str, guard: &Path, guard_cmd: &str) -> Option<String> {
    let mut out: Option<String> = None;
    if needs_heal(settings, EMITTER_MARKER, &emitter.to_string_lossy()) {
        out = Some(merge_event_hooks(Some(out.as_deref().unwrap_or(settings)), emitter_cmd));
    }
    if needs_heal(out.as_deref().unwrap_or(settings), GUARD_MARKER, &guard.to_string_lossy()) {
        out = Some(crate::worktree::merge_guard_settings(
            Some(out.as_deref().unwrap_or(settings)),
            guard_cmd,
        ));
    }
    out
}

/// Walk every managed worktree (`<worktrees_base>/<project>/<agent>`) and re-point any stale
/// emitter/guard hook in its `settings.local.json` at the stable script paths. Returns how many
/// worktrees were healed. Takes resolved paths (no AppHandle) so it unit-tests with temp dirs.
fn scan_and_heal(
    worktrees_base: &Path,
    hook_events_base: &Path,
    emitter: &Path,
    guard: &Path,
) -> Result<u32, String> {
    let mut healed = 0u32;
    let projects = match std::fs::read_dir(worktrees_base) {
        Ok(rd) => rd,
        Err(_) => return Ok(0), // no worktrees dir yet — nothing to heal
    };
    for project in projects.flatten() {
        let agents = match std::fs::read_dir(project.path()) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for agent in agents.flatten() {
            let worktree = agent.path();
            let settings_path = worktree.join(".claude").join("settings.local.json");
            let existing = match std::fs::read_to_string(&settings_path) {
                Ok(s) => s,
                Err(_) => continue, // no hooks installed for this worktree
            };
            let log = hook_events_base.join(format!("{}.jsonl", log_key(&worktree.to_string_lossy())));
            let emitter_cmd = hook_command(emitter, &log);
            let guard_cmd = hook_command(guard, &worktree);
            if let Some(updated) = heal_settings(&existing, emitter, &emitter_cmd, guard, &guard_cmd) {
                atomic_write_settings(&settings_path, &updated)
                    .map_err(|e| format!("heal {}: {e}", settings_path.to_string_lossy()))?;
                healed += 1;
            }
        }
    }
    Ok(healed)
}

/// Self-heal stale hook script paths across every existing agent worktree. Called at app launch:
/// re-stages the emitter + write-guard to the stable app-data location, then re-points any
/// worktree whose baked hook paths reference an old/renamed/removed bundle. Idempotent — a no-op
/// once everything already points at the stable path. Returns the number of worktrees healed.
#[tauri::command]
pub fn heal_agent_hooks(app: AppHandle) -> Result<u32, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    let emitter = stage_resource_script(&app, "sparkle-hook.mjs")?;
    let guard = stage_resource_script(&app, "worktree-guard.mjs")?;
    scan_and_heal(
        &app_data.join("worktrees"),
        &app_data.join("hook-events"),
        &emitter,
        &guard,
    )
}

/// Hard cap on how many bytes ONE poll may pull off disk.
///
/// Without it a single poll read the whole remaining log with `read_to_end`, then copied it again
/// via `from_utf8_lossy`, again into a `Vec<String>`, and a fourth time through serde over the IPC —
/// ~4x the file size, transiently, ON THE MAIN THREAD. With a 100 MB accumulated log that is a
/// multi-hundred-MB spike per poll. 1 MiB is far more than a 500 ms tick can legitimately produce,
/// so in normal operation the cap never engages; it only bounds the pathological case.
pub const MAX_READ_BYTES: u64 = 1024 * 1024;

/// A batch of newly-appended event-log lines plus the byte offset to resume from.
#[derive(serde::Serialize)]
pub struct EventsChunk {
    pub lines: Vec<String>,
    pub offset: u64,
    /// True when this poll hit `MAX_READ_BYTES` and more data is already waiting at `offset`. The
    /// watcher uses it to poll again immediately instead of idling a full interval while behind.
    pub truncated: bool,
}

/// Incrementally read complete (newline-terminated) lines from the event log starting at byte
/// `offset`. The frontend polls this while an agent pane is open. A partial trailing line (the
/// emitter mid-write) is left unconsumed so it's read whole on the next poll; a shrunken file
/// (rotated/cleared) restarts from 0. A missing file (no event yet) yields an empty batch.
/// Confinement check for `read_events_since`, factored out for tests. `base` is the canonicalized
/// `<app_data>/hook-events`. When the log file EXISTS we canonicalize it fully (following symlinks)
/// and require the resolved path to be a regular file under `base` — so a symlink planted inside
/// the dir can't redirect the read to `/etc/passwd` etc. When the file is absent (no events emitted
/// yet) we fall back to validating that its existing PARENT directory resolves to `base`.
fn log_path_within(base: &Path, log_path: &str) -> bool {
    let p = Path::new(log_path);
    if let Ok(canon) = p.canonicalize() {
        // Existing file (symlink target resolved): must be a regular file that is a DIRECT child of
        // base (the event-log layout is flat) — `parent() == base`, consistent with the branch below.
        return canon.is_file() && canon.parent() == Some(base);
    }
    // File absent (no events yet). Reject if the final component is itself a (dangling) symlink — its
    // target could be created later to redirect the read outside base — so only a genuinely-absent
    // regular path that is a direct child of base is accepted.
    if std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return false;
    }
    p.parent()
        .and_then(|par| par.canonicalize().ok())
        .map(|par| par == base)
        .unwrap_or(false)
}

/// `skip_existing` (optional, defaults false): jump straight to EOF and return an empty batch.
/// A pane mounting on an agent with a large accumulated log wants only NEW events; doing that
/// server-side means we stat the file and return, instead of reading and discarding megabytes.
#[tauri::command]
pub fn read_events_since(
    app: AppHandle,
    log_path: String,
    offset: u64,
    skip_existing: Option<bool>,
) -> Result<EventsChunk, String> {
    let skip = skip_existing.unwrap_or(false);
    // Confine reads to <app_data>/hook-events so a compromised renderer can't turn this into an
    // arbitrary-file read oracle. The legit path is always <app_data>/hook-events/<agentId>.jsonl.
    let base = match crate::dev_identity::app_data_dir(&app).map(|d| d.join("hook-events")) {
        Ok(b) => b,
        Err(_) => return Ok(EventsChunk { lines: vec![], offset, truncated: false }),
    };
    match base.canonicalize() {
        // hook-events dir not created yet → no events are possible; report an empty batch.
        Err(_) => Ok(EventsChunk { lines: vec![], offset, truncated: false }),
        Ok(canon_base) if log_path_within(&canon_base, &log_path) => {
            read_events_since_impl(Path::new(&log_path), offset, skip)
        }
        Ok(_) => Err("read_events_since: log_path is outside the managed hook-events dir".into()),
    }
}

pub fn read_events_since_impl(
    path: &Path,
    mut offset: u64,
    skip_existing: bool,
) -> Result<EventsChunk, String> {
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(EventsChunk { lines: vec![], offset, truncated: false });
        }
        Err(e) => return Err(format!("open log: {e}")),
    };
    let len = f.metadata().map_err(|e| format!("stat log: {e}"))?.len();
    if offset > len {
        offset = 0; // file was truncated/rotated — restart from the top
    }
    // Seek-to-EOF fast path: the caller only wants events from here on, so skip the backlog without
    // ever reading it. This is what keeps a pane mount O(1) instead of O(size of the whole log).
    if skip_existing {
        return Ok(EventsChunk { lines: vec![], offset: len, truncated: false });
    }
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek log: {e}"))?;
    // Bounded read (see MAX_READ_BYTES): never pull an unbounded amount onto the main thread.
    let available = len - offset;
    let truncated = available > MAX_READ_BYTES;
    let to_read = if truncated { MAX_READ_BYTES } else { available };
    let mut bytes = Vec::with_capacity(to_read as usize);
    Read::by_ref(&mut f)
        .take(to_read)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read log: {e}"))?;
    // Consume only through the last newline; the emitter appends whole lines atomically, so the
    // remainder (if any) is a write in progress — leave it for the next poll. Counting bytes (not
    // chars) keeps the offset exact regardless of content.
    let mut consumed = bytes
        .iter()
        .rposition(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    // A capped read with NO newline in it means a single line longer than the cap (corruption, or
    // an enormous tool payload). Advancing by 0 here would re-read the same block forever and wedge
    // the watcher, so consume the whole block and drop the unusable fragment.
    if consumed == 0 && truncated {
        consumed = bytes.len();
    }
    // Lossy decode so a stray non-UTF-8 byte (corruption, external tampering) can't error and
    // wedge the reader re-reading the same tail forever — the offset still advances past it.
    // Our emitter only ever writes UTF-8, so this is belt-and-suspenders.
    let text = String::from_utf8_lossy(&bytes[..consumed]);
    let lines = text
        .lines()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    Ok(EventsChunk {
        lines,
        offset: offset + consumed as u64,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn emitter_present(v: &Value, event: &str) -> bool {
        v["hooks"][event]
            .as_array()
            .map(|a| a.iter().any(|e| entry_has_marker(e, EMITTER_MARKER)))
            .unwrap_or(false)
    }

    #[test]
    fn emitter_merge_preserves_the_guard_permissions_allowlist() {
        // The launch sequence writes the guard first (which seeds permissions.allow) then merges
        // the event emitter into the SAME settings.local.json. The emitter merge must not drop the
        // allowlist — otherwise interactive agents would start prompting for Sparkle's own tools.
        let after_guard =
            crate::worktree::merge_guard_settings(None, "node /abs/worktree-guard.mjs /wt/a");
        let after_emitter = merge_event_hooks(Some(&after_guard), "node /abs/sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&after_emitter).unwrap();
        let rules: Vec<&str> = v["permissions"]["allow"]
            .as_array()
            .expect("allowlist survives the emitter merge")
            .iter()
            .filter_map(|e| e.as_str())
            .collect();
        assert!(rules.contains(&"mcp__sparkle-control"), "sparkle-control still allowed");
        assert!(rules.contains(&"mcp__sparkle-orchestrator"), "sparkle-orchestrator still allowed");
        // And the emitter itself landed, so both writers coexist.
        assert!(emitter_present(&v, "PreToolUse"));
    }

    #[test]
    fn log_path_within_confines_reads_to_hook_events_dir() {
        let tmp = std::env::temp_dir().join(format!("sparkle-hooks-log-{}", std::process::id()));
        let base = tmp.join("hook-events");
        std::fs::create_dir_all(&base).unwrap();
        let cbase = base.canonicalize().unwrap();

        // A file in the hook-events dir passes even though it doesn't exist yet (no events).
        assert!(log_path_within(&cbase, base.join("agent.jsonl").to_str().unwrap()));
        // An arbitrary system file is rejected — closes the file-read oracle.
        assert!(!log_path_within(&cbase, "/etc/passwd"));
        // A sibling directory is rejected.
        let sib = tmp.join("evil");
        std::fs::create_dir_all(&sib).unwrap();
        assert!(!log_path_within(&cbase, sib.join("x.jsonl").to_str().unwrap()));

        // A symlink PLANTED INSIDE the managed dir but pointing OUTSIDE it is rejected — the full
        // path is canonicalized (symlink followed) and must still resolve under base.
        let outside_file = tmp.join("secret.txt");
        std::fs::write(&outside_file, b"top secret").unwrap();
        let planted = base.join("sneaky.jsonl");
        std::os::unix::fs::symlink(&outside_file, &planted).unwrap();
        assert!(!log_path_within(&cbase, planted.to_str().unwrap()));

        // A DANGLING symlink in the managed dir (target doesn't exist yet) is also rejected — its
        // target could be created later to redirect the read outside base.
        let dangling = base.join("dangling.jsonl");
        std::os::unix::fs::symlink(tmp.join("not-created-yet"), &dangling).unwrap();
        assert!(!log_path_within(&cbase, dangling.to_str().unwrap()));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn confine_to_worktrees_accepts_inside_rejects_outside_and_escape() {
        // PID + a distinct prefix keep this test's temp root from colliding with the other
        // hooks tests (PID isolates concurrent test *processes*; the prefix isolates within one).
        let tmp = std::env::temp_dir().join(format!("sparkle-hooks-confine-{}", std::process::id()));
        let base = tmp.join("worktrees");
        let inside = base.join("proj").join("agent");
        std::fs::create_dir_all(&inside).unwrap();

        // A real worktree under <base>/worktrees is accepted (returns the canonical path).
        assert!(confine_to_worktrees(&base, inside.to_str().unwrap()).is_ok());

        // A sibling directory OUTSIDE the worktrees dir (e.g. $HOME) is rejected — this is the
        // write-anywhere → persistent-code-execution vector the confinement closes.
        let outside = tmp.join("evil");
        std::fs::create_dir_all(&outside).unwrap();
        assert!(confine_to_worktrees(&base, outside.to_str().unwrap()).is_err());

        // A `..` escape is rejected because both sides are canonicalized before comparison.
        let escape = format!("{}/../../evil", inside.to_str().unwrap());
        assert!(confine_to_worktrees(&base, &escape).is_err());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn atomic_write_settings_writes_valid_and_refuses_invalid_json() {
        // FIX 3: settings.local.json must be replaced atomically and never clobbered with invalid
        // JSON (a concurrently-running Claude reads this to drive its executable hooks).
        let dir = std::env::temp_dir().join(format!("sparkle-hooks-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.local.json");

        // Valid JSON is written.
        atomic_write_settings(&file, r#"{"hooks":{}}"#).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"hooks":{}}"#);

        // Invalid JSON is refused and the prior good file is left byte-for-byte intact.
        let before = std::fs::read_to_string(&file).unwrap();
        assert!(atomic_write_settings(&file, "{not valid json").is_err());
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            before,
            "file must be untouched after a rejected write"
        );

        // No temp residue is left in the dir (rename consumed it; the rejected write never made one).
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp-file residue after writes");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reinstall_restores_a_clobbered_emitter_and_keeps_the_user_keys() {
        // THE RECOVERY PATH for a mid-session emitter clobber (a permission grant, /permissions, or
        // the agent editing .claude/settings.local.json drops the emitter and hook events stop
        // cold). AgentPane re-runs install_agent_hooks on EVERY prepare, and this merge is what
        // makes that a repair: the emitter comes back for every tracked event.
        //
        // Note `heal_agent_hooks` canNOT do this job — `needs_heal` requires the file to STILL
        // contain EMITTER_MARKER, so it only re-points a stale path and skips a file the emitter
        // was removed from entirely. Reinstall is strictly stronger for the target worktree, which
        // is why prepare does not also call heal.
        let clobbered = r#"{
            "model": "opus",
            "permissions": { "allow": ["Bash(ls:*)"] },
            "hooks": { "PreToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "node worktree-guard.mjs /wt" } ] } ] }
        }"#;
        let out = merge_event_hooks(Some(clobbered), "node /abs/sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&out).unwrap();
        for ev in TOOL_EVENTS.iter().chain(PLAIN_EVENTS.iter()) {
            assert!(emitter_present(&v, ev), "emitter not restored for {ev}");
        }
        // The clobber-survivors are preserved — a repair must not cost the user their settings.
        assert_eq!(v["model"], json!("opus"));
        assert_eq!(v["permissions"]["allow"][0], json!("Bash(ls:*)"));
        // ...including the unrelated guard hook sharing the PreToolUse array.
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(
            pre.iter().any(|e| e["hooks"][0]["command"]
                .as_str()
                .is_some_and(|c| c.contains("worktree-guard.mjs"))),
            "the guard hook must survive the emitter restore"
        );
    }

    #[test]
    fn heal_cannot_restore_a_fully_removed_emitter() {
        // Pins the asymmetry the test above depends on, so the reasoning behind "prepare reinstalls
        // rather than heals" stays honest if heal_settings is ever changed.
        let no_emitter = r#"{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"node /abs/worktree-guard.mjs /wt"}]}]}}"#;
        let healed = heal_settings(
            no_emitter,
            Path::new("/abs/sparkle-hook.mjs"),
            "node /abs/sparkle-hook.mjs /log",
            Path::new("/abs/worktree-guard.mjs"),
            "node /abs/worktree-guard.mjs /wt",
        );
        assert!(healed.is_none(), "heal is a no-op once the emitter marker is gone");
    }

    #[test]
    fn registers_emitter_for_every_tracked_event() {
        let out = merge_event_hooks(None, "node sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&out).unwrap();
        for ev in TOOL_EVENTS.iter().chain(PLAIN_EVENTS.iter()) {
            assert!(emitter_present(&v, ev), "emitter missing for {ev}");
        }
        // Tool events carry a matcher; plain events do not.
        assert_eq!(v["hooks"]["PreToolUse"][0]["matcher"], json!("*"));
        assert!(v["hooks"]["Stop"][0].get("matcher").is_none());
    }

    #[test]
    fn preserves_existing_guard_and_user_keys() {
        let existing = r#"{
            "model": "opus",
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Edit|Write", "hooks": [ { "type": "command", "command": "node worktree-guard.mjs /wt" } ] }
                ]
            }
        }"#;
        let out = merge_event_hooks(Some(existing), "node sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&out).unwrap();
        // User key untouched.
        assert_eq!(v["model"], json!("opus"));
        // Guard still present alongside the emitter in PreToolUse.
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(pre.iter().any(|e| entry_has_marker(e, "worktree-guard.mjs")));
        assert!(pre.iter().any(|e| entry_has_marker(e, EMITTER_MARKER)));
    }

    #[test]
    fn reinstall_is_idempotent() {
        let once = merge_event_hooks(None, "node sparkle-hook.mjs /log");
        let twice = merge_event_hooks(Some(&once), "node sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&twice).unwrap();
        // Exactly one emitter entry per event after a second install.
        for ev in TOOL_EVENTS.iter().chain(PLAIN_EVENTS.iter()) {
            let n = v["hooks"][ev]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| entry_has_marker(e, EMITTER_MARKER))
                .count();
            assert_eq!(n, 1, "duplicate emitter for {ev}");
        }
    }

    #[test]
    fn tolerates_non_object_existing_settings() {
        let out = merge_event_hooks(Some("[1,2,3]"), "node sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(emitter_present(&v, "Stop"));
    }

    fn temp_log(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("sparkle-hooks-test-{}-{tag}.jsonl", std::process::id()))
    }

    #[test]
    fn missing_log_yields_empty_batch_at_same_offset() {
        let p = temp_log("missing");
        let _ = std::fs::remove_file(&p);
        let chunk = read_events_since_impl(&p, 0, false).unwrap();
        assert!(chunk.lines.is_empty());
        assert_eq!(chunk.offset, 0);
        assert!(!chunk.truncated);
    }

    #[test]
    fn reads_only_complete_lines_and_resumes_from_offset() {
        let p = temp_log("incremental");
        // Two complete lines plus a partial third (no trailing newline yet).
        std::fs::write(&p, "{\"event\":\"PreToolUse\"}\n{\"event\":\"Stop\"}\n{\"event\":\"Pa")
            .unwrap();
        let first = read_events_since_impl(&p, 0, false).unwrap();
        assert_eq!(first.lines.len(), 2);
        assert_eq!(first.lines[1], "{\"event\":\"Stop\"}");

        // Emitter finishes the partial line; resuming from the prior offset yields just it.
        std::fs::write(&p, "{\"event\":\"PreToolUse\"}\n{\"event\":\"Stop\"}\n{\"event\":\"Partial\"}\n")
            .unwrap();
        let second = read_events_since_impl(&p, first.offset, false).unwrap();
        assert_eq!(second.lines, vec!["{\"event\":\"Partial\"}".to_string()]);
        let _ = std::fs::remove_file(&p);
    }

    /// Build a log of `n` identical whole lines; returns (path, line_len).
    fn write_lines(p: &Path, n: usize) -> usize {
        let line = "{\"event\":\"Stop\",\"tool\":\"Bash\"}\n";
        let mut s = String::with_capacity(line.len() * n);
        for _ in 0..n {
            s.push_str(line);
        }
        std::fs::write(p, &s).unwrap();
        line.len()
    }

    #[test]
    fn caps_a_single_read_at_max_read_bytes_and_flags_truncation() {
        // The unbounded-read fix: one poll must never pull more than MAX_READ_BYTES off disk,
        // however far behind the reader is.
        let p = temp_log("cap");
        let line_len = write_lines(&p, (MAX_READ_BYTES as usize / 30) * 3); // comfortably over the cap
        let total = std::fs::metadata(&p).unwrap().len();
        assert!(total > MAX_READ_BYTES, "fixture must exceed the cap");

        let first = read_events_since_impl(&p, 0, false).unwrap();
        assert!(first.truncated, "more data remains, so the flag is set");
        assert!(
            first.offset <= MAX_READ_BYTES,
            "consumed {} bytes, over the {MAX_READ_BYTES} cap",
            first.offset
        );
        // Truncation lands on a LINE boundary — every line handed out is whole and parseable.
        assert_eq!(first.offset as usize % line_len, 0);
        for l in &first.lines {
            serde_json::from_str::<Value>(l).expect("no partial line escaped the cap");
        }

        // Resuming drains the rest, and the final chunk is not flagged truncated.
        let mut offset = first.offset;
        let mut guard = 0;
        loop {
            let c = read_events_since_impl(&p, offset, false).unwrap();
            offset = c.offset;
            guard += 1;
            assert!(guard < 100, "draining must terminate");
            if !c.truncated {
                break;
            }
        }
        assert_eq!(offset, total, "every byte is eventually consumed exactly once");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn a_single_line_longer_than_the_cap_does_not_wedge_the_reader() {
        // Pathological: no newline within the capped block. Consuming 0 bytes would re-read the
        // same block forever. The reader must advance instead of spinning.
        let p = temp_log("hugeline");
        let mut data = vec![b'x'; (MAX_READ_BYTES + 4096) as usize];
        data.push(b'\n');
        std::fs::write(&p, &data).unwrap();

        let c = read_events_since_impl(&p, 0, false).unwrap();
        assert!(c.truncated);
        assert!(c.offset > 0, "offset must advance past an over-long line, not stall at 0");
        assert_eq!(c.offset, MAX_READ_BYTES);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn skip_existing_seeks_to_eof_without_reading_the_backlog() {
        // The pane-mount path. Previously the frontend started at offset 0 and read the ENTIRE
        // accumulated log on every mount, discarding it JS-side. Server-side skip returns EOF.
        let p = temp_log("skip");
        write_lines(&p, 50_000); // ~1.5 MB: more than one capped read could drain
        let total = std::fs::metadata(&p).unwrap().len();
        assert!(total > MAX_READ_BYTES, "backlog must be big enough that reading it would be the bug");

        let c = read_events_since_impl(&p, 0, true).unwrap();
        assert!(c.lines.is_empty(), "no backlog is dispatched");
        assert_eq!(c.offset, total, "and we resume from the true end of file");
        assert!(!c.truncated, "nothing was truncated — nothing was read");

        // Events appended after the skip ARE delivered, from the skipped offset.
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        use std::io::Write;
        f.write_all(b"{\"event\":\"Fresh\"}\n").unwrap();
        let next = read_events_since_impl(&p, c.offset, false).unwrap();
        assert_eq!(next.lines, vec!["{\"event\":\"Fresh\"}".to_string()]);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn skip_existing_on_a_missing_log_stays_at_the_caller_offset() {
        let p = temp_log("skipmissing");
        let _ = std::fs::remove_file(&p);
        let c = read_events_since_impl(&p, 0, true).unwrap();
        assert!(c.lines.is_empty());
        assert_eq!(c.offset, 0);
    }

    #[test]
    fn an_exactly_cap_sized_read_is_not_flagged_truncated() {
        // Boundary: available == MAX_READ_BYTES means everything fit; the flag must stay false so
        // the watcher doesn't spin an extra immediate poll for nothing.
        let p = temp_log("boundary");
        let mut data = vec![b'x'; (MAX_READ_BYTES - 1) as usize];
        data.push(b'\n');
        assert_eq!(data.len() as u64, MAX_READ_BYTES);
        std::fs::write(&p, &data).unwrap();

        let c = read_events_since_impl(&p, 0, false).unwrap();
        assert!(!c.truncated, "exactly-at-cap is complete, not truncated");
        assert_eq!(c.offset, MAX_READ_BYTES);
        assert_eq!(c.lines.len(), 1);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn log_key_uses_basename_and_falls_back() {
        assert_eq!(log_key("/app/worktrees/proj/agent-123"), "agent-123");
        // A trailing slash still resolves to the final component.
        assert_eq!(log_key("/app/worktrees/proj/agent-123/"), "agent-123");
        // Pathological inputs fall back to the shared key rather than panicking.
        assert_eq!(log_key(""), "agent");
        assert_eq!(log_key("/"), "agent");
    }

    #[test]
    fn merge_preserves_user_key_order() {
        // With serde_json's preserve_order feature, the user's keys keep their original order
        // rather than being alphabetized on merge.
        let existing = r#"{ "zebra": 1, "model": "opus", "alpha": 2 }"#;
        let out = merge_event_hooks(Some(existing), "node sparkle-hook.mjs /log");
        let zebra = out.find("zebra").unwrap();
        let model = out.find("\"model\"").unwrap();
        let alpha = out.find("alpha").unwrap();
        assert!(zebra < model && model < alpha, "user key order preserved");
    }

    #[test]
    fn a_non_utf8_byte_does_not_wedge_the_reader() {
        let p = temp_log("badbytes");
        // A valid line, then a line with a stray invalid byte, both newline-terminated.
        let mut data = b"{\"event\":\"Stop\"}\n".to_vec();
        data.extend_from_slice(b"{\"event\":\"\xFFx\"}\n");
        std::fs::write(&p, &data).unwrap();
        let chunk = read_events_since_impl(&p, 0, false).unwrap();
        // Both complete lines are returned (the bad byte is replaced, not fatal) and the offset
        // advances past everything so the next poll won't re-read the corrupt tail.
        assert_eq!(chunk.lines.len(), 2);
        assert_eq!(chunk.offset, data.len() as u64);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn restarts_when_file_shrinks() {
        let p = temp_log("rotated");
        std::fs::write(&p, "{\"event\":\"Stop\"}\n").unwrap();
        // Offset past a now-smaller file (rotated/cleared) → re-read from the top.
        let chunk = read_events_since_impl(&p, 9999, false).unwrap();
        assert_eq!(chunk.lines, vec!["{\"event\":\"Stop\"}".to_string()]);
        let _ = std::fs::remove_file(&p);
    }

    const OLD_EMITTER: &str = "/Applications/Old.app/Contents/Resources/resources/sparkle-hook.mjs";
    const OLD_GUARD: &str = "/Applications/Old.app/Contents/Resources/resources/worktree-guard.mjs";

    #[test]
    fn needs_heal_detects_stale_marker_present_without_stable_path() {
        let stale = format!(
            r#"{{"hooks":{{"Stop":[{{"hooks":[{{"type":"command","command":"node '{OLD_EMITTER}' '/log'"}}]}}]}}}}"#
        );
        // Marker present but the stable path isn't → stale.
        assert!(needs_heal(&stale, EMITTER_MARKER, "/data/bin/sparkle-hook.mjs"));
        // Already references the stable path → not stale.
        let fresh = stale.replace(OLD_EMITTER, "/data/bin/sparkle-hook.mjs");
        assert!(!needs_heal(&fresh, EMITTER_MARKER, "/data/bin/sparkle-hook.mjs"));
        // Marker absent → never heal (don't graft a hook that was never installed).
        assert!(!needs_heal("{}", EMITTER_MARKER, "/data/bin/sparkle-hook.mjs"));
    }

    #[test]
    fn heal_settings_repoints_both_hooks_then_noops() {
        let e_new = Path::new("/data/bin/sparkle-hook.mjs");
        let g_new = Path::new("/data/bin/worktree-guard.mjs");
        // A worktree with BOTH hooks pointing at an old bundle.
        let with_emitter =
            merge_event_hooks(None, &hook_command(Path::new(OLD_EMITTER), Path::new("/log")));
        let stale = crate::worktree::merge_guard_settings(
            Some(&with_emitter),
            &hook_command(Path::new(OLD_GUARD), Path::new("/wt")),
        );

        let e_cmd = hook_command(e_new, Path::new("/log"));
        let g_cmd = hook_command(g_new, Path::new("/wt"));
        let healed = heal_settings(&stale, e_new, &e_cmd, g_new, &g_cmd).expect("stale → healed");
        assert!(healed.contains("/data/bin/sparkle-hook.mjs"));
        assert!(healed.contains("/data/bin/worktree-guard.mjs"));
        assert!(!healed.contains("/Applications/Old.app"));
        // Both hooks survive (rewritten, not dropped).
        let v: Value = serde_json::from_str(&healed).unwrap();
        assert!(emitter_present(&v, "Stop"));
        assert!(v["hooks"]["PreToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| entry_has_marker(e, GUARD_MARKER)));
        // Re-running on the now-stable file is a no-op (no needless rewrite).
        assert!(heal_settings(&healed, e_new, &e_cmd, g_new, &g_cmd).is_none());
    }

    #[test]
    fn scan_and_heal_rewrites_only_stale_worktrees() {
        let tmp = std::env::temp_dir().join(format!("sparkle-heal-{}", std::process::id()));
        let worktrees = tmp.join("worktrees");
        let hook_events = tmp.join("hook-events");
        let e_new = tmp.join("bin").join("sparkle-hook.mjs");
        let g_new = tmp.join("bin").join("worktree-guard.mjs");

        // A: stale emitter from an old bundle → healed, log path recomputed from the agent basename.
        let a = worktrees.join("proj").join("agent-a").join(".claude");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(
            a.join("settings.local.json"),
            merge_event_hooks(None, &hook_command(Path::new(OLD_EMITTER), Path::new("/old/log"))),
        )
        .unwrap();

        // B: already points at the stable emitter → must be left byte-for-byte intact.
        let b = worktrees.join("proj").join("agent-b").join(".claude");
        std::fs::create_dir_all(&b).unwrap();
        let fresh =
            merge_event_hooks(None, &hook_command(&e_new, &hook_events.join("agent-b.jsonl")));
        std::fs::write(b.join("settings.local.json"), &fresh).unwrap();

        // C: a worktree dir with no settings file → skipped, nothing created.
        std::fs::create_dir_all(worktrees.join("proj").join("agent-c")).unwrap();

        let n = scan_and_heal(&worktrees, &hook_events, &e_new, &g_new).unwrap();
        assert_eq!(n, 1, "only the stale worktree is healed");

        let a_after = std::fs::read_to_string(a.join("settings.local.json")).unwrap();
        assert!(a_after.contains(&*e_new.to_string_lossy()));
        assert!(!a_after.contains("/Applications/Old.app"));
        assert!(a_after.contains("agent-a.jsonl"), "log path recomputed per agent");

        assert_eq!(
            std::fs::read_to_string(b.join("settings.local.json")).unwrap(),
            fresh,
            "already-stable worktree left untouched"
        );
        assert!(!worktrees
            .join("proj")
            .join("agent-c")
            .join(".claude")
            .join("settings.local.json")
            .exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn scan_and_heal_missing_worktrees_dir_is_ok() {
        let missing = std::env::temp_dir().join(format!("sparkle-heal-missing-{}", std::process::id()));
        let n = scan_and_heal(
            &missing.join("worktrees"),
            &missing.join("hook-events"),
            Path::new("/bin/e.mjs"),
            Path::new("/bin/g.mjs"),
        )
        .unwrap();
        assert_eq!(n, 0);
    }
}
