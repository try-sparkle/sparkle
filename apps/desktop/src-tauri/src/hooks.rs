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

use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

/// Substring identifying a Sparkle emitter hook entry, for idempotent reinstall.
const EMITTER_MARKER: &str = "sparkle-hook.mjs";
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
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
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
    let worktrees_base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("worktrees");
    let worktree_dir = confine_to_worktrees(&worktrees_base, &worktree)?;

    let emitter = app
        .path()
        .resolve("resources/sparkle-hook.mjs", BaseDirectory::Resource)
        .map_err(|e| format!("emitter script missing: {e}"))?;
    let log = event_log_path(&app, &worktree)?;
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir hook-events: {e}"))?;
    }
    let emitter_cmd = format!(
        "node {} {}",
        shell_quote(&emitter.to_string_lossy()),
        shell_quote(&log.to_string_lossy())
    );

    let dir = worktree_dir.join(".claude");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir .claude: {e}"))?;
    let file = dir.join("settings.local.json");
    let existing = std::fs::read_to_string(&file).ok();
    let merged = merge_event_hooks(existing.as_deref(), &emitter_cmd);
    std::fs::write(&file, merged).map_err(|e| format!("write settings.local.json: {e}"))?;
    Ok(log.to_string_lossy().into_owned())
}

/// A batch of newly-appended event-log lines plus the byte offset to resume from.
#[derive(serde::Serialize)]
pub struct EventsChunk {
    pub lines: Vec<String>,
    pub offset: u64,
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

#[tauri::command]
pub fn read_events_since(app: AppHandle, log_path: String, offset: u64) -> Result<EventsChunk, String> {
    // Confine reads to <app_data>/hook-events so a compromised renderer can't turn this into an
    // arbitrary-file read oracle. The legit path is always <app_data>/hook-events/<agentId>.jsonl.
    let base = match app.path().app_data_dir().map(|d| d.join("hook-events")) {
        Ok(b) => b,
        Err(_) => return Ok(EventsChunk { lines: vec![], offset }),
    };
    match base.canonicalize() {
        // hook-events dir not created yet → no events are possible; report an empty batch.
        Err(_) => Ok(EventsChunk { lines: vec![], offset }),
        Ok(canon_base) if log_path_within(&canon_base, &log_path) => {
            read_events_since_impl(Path::new(&log_path), offset)
        }
        Ok(_) => Err("read_events_since: log_path is outside the managed hook-events dir".into()),
    }
}

pub fn read_events_since_impl(path: &Path, mut offset: u64) -> Result<EventsChunk, String> {
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(EventsChunk { lines: vec![], offset });
        }
        Err(e) => return Err(format!("open log: {e}")),
    };
    let len = f.metadata().map_err(|e| format!("stat log: {e}"))?.len();
    if offset > len {
        offset = 0; // file was truncated/rotated — restart from the top
    }
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek log: {e}"))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)
        .map_err(|e| format!("read log: {e}"))?;
    // Consume only through the last newline; the emitter appends whole lines atomically, so the
    // remainder (if any) is a write in progress — leave it for the next poll. Counting bytes (not
    // chars) keeps the offset exact regardless of content.
    let consumed = bytes
        .iter()
        .rposition(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
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
        let chunk = read_events_since_impl(&p, 0).unwrap();
        assert!(chunk.lines.is_empty());
        assert_eq!(chunk.offset, 0);
    }

    #[test]
    fn reads_only_complete_lines_and_resumes_from_offset() {
        let p = temp_log("incremental");
        // Two complete lines plus a partial third (no trailing newline yet).
        std::fs::write(&p, "{\"event\":\"PreToolUse\"}\n{\"event\":\"Stop\"}\n{\"event\":\"Pa")
            .unwrap();
        let first = read_events_since_impl(&p, 0).unwrap();
        assert_eq!(first.lines.len(), 2);
        assert_eq!(first.lines[1], "{\"event\":\"Stop\"}");

        // Emitter finishes the partial line; resuming from the prior offset yields just it.
        std::fs::write(&p, "{\"event\":\"PreToolUse\"}\n{\"event\":\"Stop\"}\n{\"event\":\"Partial\"}\n")
            .unwrap();
        let second = read_events_since_impl(&p, first.offset).unwrap();
        assert_eq!(second.lines, vec!["{\"event\":\"Partial\"}".to_string()]);
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
        let chunk = read_events_since_impl(&p, 0).unwrap();
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
        let chunk = read_events_since_impl(&p, 9999).unwrap();
        assert_eq!(chunk.lines, vec!["{\"event\":\"Stop\"}".to_string()]);
        let _ = std::fs::remove_file(&p);
    }
}
