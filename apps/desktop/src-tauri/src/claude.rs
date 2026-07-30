//! Claude Code session detection — answers "does this agent's worktree already
//! have a prior `claude` conversation we can resume?" so the app can spawn
//! `claude --continue` (resume) vs plain `claude` (fresh start).
//!
//! Claude Code stores per-directory session history under
//! `<config>/projects/<slug>/`, where `<config>` is `$CLAUDE_CONFIG_DIR` if set
//! else `$HOME/.claude`, and `<slug>` is the worktree's absolute path with every
//! `/` and `.` replaced by `-`. Sessions are `<uuid>.jsonl` transcript files.
//! Because each agent has a unique worktree path, that directory IS the session
//! key — `claude --continue` run from the worktree resumes the most recent
//! conversation there.

use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Encode an absolute directory path into Claude Code's `projects` slug: every
/// character that is NOT an ASCII alphanumeric becomes `-`, applied 1:1 per
/// character (consecutive separators are NOT collapsed — e.g. `/.sparkle`
/// yields `--sparkle`).
///
/// This mirrors Claude Code's real encoding. It matters on macOS, where agent
/// worktrees live under `~/Library/Application Support/ai.sparkle.desktop/…`:
/// the SPACE in "Application Support" (and the `.` in `ai.sparkle.desktop`) must
/// map to `-` so the computed slug matches Claude's actual transcript directory.
/// A prior version replaced only `/` and `.`, leaving the space intact — so
/// `claude_has_session` never matched and agents never resumed.
fn encode_project_slug(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The `projects` root Claude Code uses: `$CLAUDE_CONFIG_DIR/projects` when the
/// env var is set, else `$HOME/.claude/projects`. Returns `None` when neither is
/// resolvable. Pure form (takes the env values) so it's testable.
///
/// An EMPTY `config_dir` counts as unset, exactly as an `export CLAUDE_CONFIG_DIR=`
/// does — otherwise the bare join yields a RELATIVE `projects/` rooted at whatever
/// Sparkle's cwd happens to be, silently reporting zero transcripts (and so zero
/// usage, no learned ceiling, and no rate-limit events) for that account. The
/// default account stores exactly that empty string, because "no override" is what
/// makes it the same account the user's terminal uses — see `accounts::Account::config_dir`.
///
/// `pub(crate)` so `accounts.rs` resolves an account's transcript root the SAME
/// way session detection does (each account passes its own `config_dir` as
/// `Some(..)`), instead of re-deriving the `projects` join independently.
pub(crate) fn claude_projects_root(config_dir: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    match config_dir.filter(|c| !c.as_os_str().is_empty()) {
        Some(cfg) => Some(cfg.join("projects")),
        None => home.map(|h| h.join(".claude").join("projects")),
    }
}

/// The `CLAUDE_CONFIG_DIR` a spawned `claude` will ACTUALLY see, as a string ("" = none).
///
/// Sparkle's own process env is not authoritative. Launched from Finder a macOS GUI app inherits
/// almost nothing, and every spawn goes through `zsh -l -c`, which sources `.zprofile`/`.zlogin`
/// FIRST. So a user who exports `CLAUDE_CONFIG_DIR` there has it applied to the child while Sparkle
/// sees nothing — and recording "no override" for the default account would then point every read
/// (identity, transcripts, session detection) at `$HOME` while the child used their directory.
///
/// Order: Sparkle's own env when it has one (the multi-account spawn sets the variable on children
/// only, so a value here is the user's real one), else the login shell's, else "".
///
/// The probe is cached for the process and mirrors `claude_chat::cached_login_shell_path`'s policy —
/// same shell, same graceful degradation: any failure yields "", which is exactly the pre-probe
/// behavior. Callers should reach for this only when they actually need it; a login shell re-sources
/// dotfiles and costs 100-500ms.
pub(crate) fn effective_spawn_config_dir() -> String {
    if let Some(v) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(v).to_string_lossy().into_owned();
    }
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            std::process::Command::new("/bin/zsh")
                .args(["-l", "-c", "printf %s \"$CLAUDE_CONFIG_DIR\""])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default()
        })
        .clone()
}

/// The directory Claude Code would use to store sessions for `worktree_path`.
/// Pure form so it's testable without touching the environment.
fn claude_session_dir_for(projects_root: &Path, worktree_path: &str) -> PathBuf {
    projects_root.join(encode_project_slug(worktree_path))
}

/// True iff the session dir holds at least one real Claude transcript
/// (`<uuid>.jsonl`). We require an actual `.jsonl` file rather than "any entry"
/// so OS cruft (`.DS_Store`) or an empty subdir doesn't make us run
/// `claude --continue` against a directory with no conversation to resume.
fn has_session_file(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        if entry
            .path()
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
            && entry.file_type().map(|t| t.is_file()).unwrap_or(false)
        {
            return true;
        }
    }
    false
}

/// True iff `worktree_path` has a resumable Claude session under the given
/// config/home. Pure form of [`claude_has_session`].
fn claude_has_session_in(
    config_dir: Option<&Path>,
    home: Option<&Path>,
    worktree_path: &str,
) -> bool {
    match claude_projects_root(config_dir, home) {
        Some(root) => has_session_file(&claude_session_dir_for(&root, worktree_path)),
        None => false,
    }
}

/// Resolve which `CLAUDE_CONFIG_DIR` a session lookup should use. An explicitly chosen account
/// config dir (multi Claude Max support — the spawn picks an account per job and sets its config
/// dir on the CHILD only, not Sparkle's own env) takes precedence over Sparkle's process-env
/// value (`env`, kept as a `PathBuf` so a non-UTF8 `CLAUDE_CONFIG_DIR` retains its bytes — no lossy
/// UTF-8 round-trip). Empty values are treated as unset in BOTH branches (the function re-asserts
/// the env guard rather than trusting the caller to pre-filter), so neither a stray `config_dir: ""`
/// nor an `export CLAUDE_CONFIG_DIR=` yields a relative `projects/<slug>` root that would skip the
/// `$HOME/.claude` fallback. Pure so the precedence is unit-testable.
fn resolve_session_config_dir(explicit: Option<&str>, env: Option<PathBuf>) -> Option<PathBuf> {
    match explicit.filter(|s| !s.is_empty()) {
        Some(e) => Some(PathBuf::from(e)),
        None => env.filter(|p| !p.as_os_str().is_empty()),
    }
}

/// True iff the agent's worktree already has a resumable `claude` conversation.
/// Drives the `claude` vs `claude --continue` choice when (re)opening an agent.
///
/// `config_dir` is the chosen account's config dir (Tauri maps JS `configDir` → this
/// `config_dir`). Since the spawn sets `CLAUDE_CONFIG_DIR` on the child only, the resume check
/// must be told the SAME dir — otherwise it looks for the session under the wrong account. When
/// absent, we fall back to Sparkle's own process env (the pre-accounts behavior). The env value
/// keeps its `OsString` form through to the `PathBuf` (no lossy conversion); an empty
/// `CLAUDE_CONFIG_DIR=` is treated as unset so the `$HOME/.claude` fallback still applies.
/// Sync core of [`claude_has_session`] (resolves config/home from the env, then probes the
/// transcript dir). `pub(crate)` so `preflight::claude_session_info` — which already runs on a
/// blocking task — can call it directly rather than the async command.
pub(crate) fn claude_has_session_sync(worktree_path: &str, config_dir: Option<&str>) -> bool {
    let env = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let config_dir = resolve_session_config_dir(config_dir, env);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    claude_has_session_in(config_dir.as_deref(), home.as_deref(), worktree_path)
}

#[tauri::command]
pub async fn claude_has_session(worktree_path: String, config_dir: Option<String>) -> bool {
    // `async` + `spawn_blocking`: the `read_dir` transcript-directory probe is filesystem I/O that
    // must not stall the UI thread. Best-effort, like the sync original — a panicked task (JoinError)
    // degrades to "no session" rather than surfacing an error the caller has no branch for.
    tauri::async_runtime::spawn_blocking(move || {
        claude_has_session_sync(&worktree_path, config_dir.as_deref())
    })
    .await
    .unwrap_or(false)
}

/// The most-recently-modified `<uuid>.jsonl` transcript in `dir`, or None. A worktree accrues one
/// transcript per session (fresh start + each `--continue`); the newest mtime is the live one.
fn latest_session_file(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let is_jsonl = entry
            .path()
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
            && entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_jsonl {
            continue;
        }
        if let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) {
            if best.as_ref().is_none_or(|(t, _)| mtime > *t) {
                best = Some((mtime, entry.path()));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Bytes from the end of a transcript scanned on the fast path. `ai-title` lines are appended
/// frequently and the freshest sits near the end, so the last one almost always lives within this
/// final window — letting us bound per-poll I/O instead of re-reading a multi-MB file every tick.
const TAIL_SCAN_BYTES: u64 = 128 * 1024;

/// Scan a transcript from byte `start` line-by-line for the LAST `ai-title` value. Takes the handle
/// by `&mut` so the caller can reuse one open file for a tail scan and (on miss) a full rescan.
/// When `start > 0` the first line read began mid-record (we seeked into the middle of a line), so
/// it's discarded — harmless even on an exact line boundary, since a dropped sole title just defers
/// to the caller's full-scan fallback. Streams via `BufReader` so peak memory is one line, not the
/// whole file. The `contains("ai-title")` pre-filter skips JSON-parsing the overwhelming majority of
/// lines (plain message/tool records). A blank/whitespace `aiTitle` is ignored so it can't clobber
/// a prior one.
fn scan_last_ai_title(file: &mut File, start: u64) -> Option<String> {
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut reader = BufReader::new(file);
    if start > 0 {
        let mut partial = String::new();
        let _ = reader.read_line(&mut partial); // drop the partial line at the seek point
    }
    let mut latest: Option<String> = None;
    for line in reader.lines() {
        let Ok(line) = line else { break }; // stop on a read error; keep whatever we found
        let line = line.trim();
        if line.is_empty() || !line.contains("ai-title") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(serde_json::Value::as_str) != Some("ai-title") {
            continue;
        }
        if let Some(t) = v.get("aiTitle").and_then(serde_json::Value::as_str) {
            let t = t.trim();
            if !t.is_empty() {
                latest = Some(t.to_string());
            }
        }
    }
    latest
}

/// The freshest `ai-title` Claude Code wrote into a transcript. Claude Code appends
/// `{"type":"ai-title","aiTitle":"…","sessionId":"…"}` lines throughout the session.
///
/// IMPORTANT — it does NOT re-summarize as the conversation grows. It derives the title on the
/// first turn and then re-emits that SAME value verbatim on every subsequent line: measured across
/// 58/58 real transcripts, every one had exactly ONE distinct title, and a 702-line session emitted
/// it 39 times byte-identical from line 17 to line 691. So "latest" here means "the one title this
/// session has", NOT "its current view of the work" — callers must treat it as a FIRST-TURN name
/// that goes stale, not an authoritative running summary. (Naming used to assume the latter and
/// let it permanently freeze an agent's name; see agentNaming.namingOutcome rung 1.)
///
/// Taking the last occurrence is still the right read — it costs nothing and stays correct if
/// Claude Code ever does start refreshing the title. Best-effort: any read/parse failure (or no
/// title yet) yields None.
///
/// Reads only the final [`TAIL_SCAN_BYTES`] of a large transcript (the fast path), falling back to
/// a full scan only when the window holds no title (a session whose title predates the window).
/// This bounds the per-poll cost, which would otherwise grow with session length × open-agent count.
fn latest_ai_title_in(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    // Fast path: scan just the tail window of a large transcript.
    if len > TAIL_SCAN_BYTES {
        if let Some(t) = scan_last_ai_title(&mut file, len - TAIL_SCAN_BYTES) {
            return Some(t);
        }
    }
    // Full scan: small files, or a title older than the tail window. Reuses the same handle
    // (rewound to 0 inside scan_last_ai_title) rather than reopening.
    scan_last_ai_title(&mut file, 0)
}

/// Pure form of [`agent_session_title`]: the latest `ai-title` from the worktree's newest
/// transcript, under the given config/home.
fn agent_session_title_in(
    config_dir: Option<&Path>,
    home: Option<&Path>,
    worktree_path: &str,
) -> Option<String> {
    let root = claude_projects_root(config_dir, home)?;
    let file = latest_session_file(&claude_session_dir_for(&root, worktree_path))?;
    latest_ai_title_in(&file)
}

/// The agent's Claude Code session title (the `ai-title` it derived from the whole conversation),
/// for auto-naming the agent off its ACTUAL work rather than its (often thin) first prompt. Returns
/// None until Claude Code has written a title (a few lines into the first turn) or for non-Claude
/// agents. Best-effort — never errors; the caller leaves the current name as-is on None.
/// Sync core of [`agent_session_title`]. `pub(crate)` for parity with the other session helpers.
pub(crate) fn agent_session_title_sync(worktree_path: &str) -> Option<String> {
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    agent_session_title_in(config_dir.as_deref(), home.as_deref(), worktree_path)
}

#[tauri::command]
pub async fn agent_session_title(worktree_path: String) -> Option<String> {
    // `async` + `spawn_blocking`: reading (and tail-scanning) a potentially multi-MB transcript is
    // filesystem I/O that must not stall the UI thread. Best-effort — a panicked task degrades to
    // None, exactly like the sync original's any-failure-yields-None contract.
    tauri::async_runtime::spawn_blocking(move || agent_session_title_sync(&worktree_path))
        .await
        .unwrap_or_default()
}

/// Pure form of [`claude_latest_session_id`]: the newest transcript's session id (its filename
/// STEM — Claude names transcripts `<sessionId>.jsonl`) for the worktree under the given
/// config/home, or None when there is no transcript. This is the SAME session `--continue`
/// resumes; spawning `--resume <id>` instead makes Claude redraw the conversation on reopen.
fn claude_latest_session_id_in(
    config_dir: Option<&Path>,
    home: Option<&Path>,
    worktree_path: &str,
) -> Option<String> {
    let root = claude_projects_root(config_dir, home)?;
    let file = latest_session_file(&claude_session_dir_for(&root, worktree_path))?;
    file.file_stem().map(|s| s.to_string_lossy().into_owned())
}

/// The agent worktree's most-recent Claude session id, for spawning `claude --resume <id>` so the
/// prior conversation is visibly redrawn on app reopen (vs `--continue`, which resumes context but
/// drops you at a blank prompt). Returns None for a fresh worktree with no transcript — the caller
/// then falls back to `--continue`. Mirrors [`claude_has_session`]'s config/home resolution: an
/// explicit account `config_dir` wins over Sparkle's process `CLAUDE_CONFIG_DIR` (empty treated as
/// unset), else `$HOME/.claude`.
/// Sync core of [`claude_latest_session_id`]. `pub(crate)` so `preflight::claude_session_info`
/// (already on a blocking task) can call it directly rather than the async command.
pub(crate) fn claude_latest_session_id_sync(worktree_path: &str, config_dir: Option<&str>) -> Option<String> {
    let env = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let config_dir = resolve_session_config_dir(config_dir, env);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    claude_latest_session_id_in(config_dir.as_deref(), home.as_deref(), worktree_path)
}

/// Pure form of the combined probe: `(has_session, latest_session_id)` for `worktree_path` under
/// the given config/home. Both halves scan the SAME transcript dir, so callers that need both (the
/// spawn path, and the concierge's boot restore) resolve config/home once instead of twice.
pub(crate) fn claude_session_info_in(
    config_dir: Option<&Path>,
    home: Option<&Path>,
    worktree_path: &str,
) -> (bool, Option<String>) {
    (
        claude_has_session_in(config_dir, home, worktree_path),
        claude_latest_session_id_in(config_dir, home, worktree_path),
    )
}

/// Sync core of the combined probe: resolves config/home from the env exactly like
/// [`claude_has_session_sync`] / [`claude_latest_session_id_sync`], then runs
/// [`claude_session_info_in`]. `pub(crate)` for `preflight`'s two session-info commands, which are
/// already on a blocking task.
pub(crate) fn claude_session_info_sync(
    worktree_path: &str,
    config_dir: Option<&str>,
) -> (bool, Option<String>) {
    let env = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let config_dir = resolve_session_config_dir(config_dir, env);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    claude_session_info_in(config_dir.as_deref(), home.as_deref(), worktree_path)
}

/// Pure form of [`claude_latest_session_path`]: the FULL PATH of the worktree's newest transcript.
///
/// Distinct from [`claude_latest_session_id_in`], which returns only the filename stem. The stem is
/// what `claude --resume` wants; a READER needs the path, and deriving one from the other means
/// re-implementing the `<projects-root>/<slug>/` layout at the call site. That derivation is exactly
/// what the concierge's terminal module refuses to do (see its tier-(d) note: it will not guess a
/// `~/.claude/projects/<slug>/<id>.jsonl`, because the slug rule lives here and a wrong guess fails
/// confusingly). So the rule stays in one place and the path is handed out whole.
fn claude_latest_session_path_in(
    config_dir: Option<&Path>,
    home: Option<&Path>,
    worktree_path: &str,
) -> Option<String> {
    let root = claude_projects_root(config_dir, home)?;
    let file = latest_session_file(&claude_session_dir_for(&root, worktree_path))?;
    Some(file.to_string_lossy().into_owned())
}

/// Sync core of [`claude_latest_session_path`].
pub(crate) fn claude_latest_session_path_sync(
    worktree_path: &str,
    config_dir: Option<&str>,
) -> Option<String> {
    let env = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let config_dir = resolve_session_config_dir(config_dir, env);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    claude_latest_session_path_in(config_dir.as_deref(), home.as_deref(), worktree_path)
}

/// The absolute path of the newest transcript for `worktree_path`, or None.
///
/// Exists so an app-owned agent whose terminal pane is NOT mounted can still be read. The concierge's
/// read chain falls through to the session transcript as its last tier, but that tier is fed by a
/// registry which only the app writes — and the one agent with no pane to write it was the Sparkle
/// self-improvement agent, whose hourly headless pass has no PTY at all. This is how a caller that
/// legitimately knows the worktree (the pane's prepare, the hourly pass) can register it.
#[tauri::command]
pub async fn claude_latest_session_path(
    worktree_path: String,
    config_dir: Option<String>,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        claude_latest_session_path_sync(&worktree_path, config_dir.as_deref())
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn claude_latest_session_id(worktree_path: String, config_dir: Option<String>) -> Option<String> {
    // `async` + `spawn_blocking`: the `read_dir` transcript-directory scan is filesystem I/O that
    // must not stall the UI thread. Best-effort — a panicked task degrades to None.
    tauri::async_runtime::spawn_blocking(move || {
        claude_latest_session_id_sync(&worktree_path, config_dir.as_deref())
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sparkle-claude-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Create a `<uuid>.jsonl` transcript inside `dir` so it looks like a real
    /// Claude session directory.
    fn seed_session(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("b3d4494a-3b98.jsonl"), b"{}\n").unwrap();
    }

    fn home_root(home: &Path) -> PathBuf {
        claude_projects_root(None, Some(home)).unwrap()
    }

    /// Stamp an explicit mtime, so "newest wins" is asserted against a KNOWN order. Writing two files
    /// back-to-back and trusting the clock makes the assertion depend on filesystem timestamp
    /// granularity — it would pass here and be a coin flip on a coarser one.
    fn set_mtime(path: &Path, secs_after_epoch: u64) {
        let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs_after_epoch);
        let f = std::fs::File::options().write(true).open(path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(when)).unwrap();
    }

    /// The concierge reads an app-owned agent through this: the FULL path of the newest transcript in
    /// a worktree. "Newest" is what makes it correct for an agent that starts a fresh session every
    /// pass (the improvement pass passes no `--resume`), and resolving it late — at read time — is what
    /// keeps a long-running agent from being read one session behind (roborev 55363).
    #[test]
    fn claude_latest_session_path_returns_the_newest_transcript_as_a_full_path() {
        let home = unique_home("latest-path");
        let dir = claude_session_dir_for(&home_root(&home), "/wt/sparkle-self");
        std::fs::create_dir_all(&dir).unwrap();
        let older = dir.join("pass-1.jsonl");
        let newer = dir.join("pass-2.jsonl");
        std::fs::write(&older, b"{}\n").unwrap();
        std::fs::write(&newer, b"{}\n").unwrap();
        // Deliberately NOT in filename order: an implementation that sorted by name would pass a
        // fixture where the newer file also sorts last.
        set_mtime(&older, 2_000);
        set_mtime(&newer, 1_000);
        assert_eq!(
            claude_latest_session_path_in(None, Some(&home), "/wt/sparkle-self"),
            Some(older.to_string_lossy().into_owned())
        );

        // Now the other pass writes, as it does the moment a new session starts.
        set_mtime(&newer, 3_000);
        assert_eq!(
            claude_latest_session_path_in(None, Some(&home), "/wt/sparkle-self"),
            Some(newer.to_string_lossy().into_owned())
        );
    }

    /// The first-ever run of an agent, and the sibling case of a directory holding non-transcripts.
    /// Both are None rather than an error: the caller's honest answer is "nothing to read yet".
    #[test]
    fn claude_latest_session_path_is_none_until_a_transcript_exists() {
        let home = unique_home("latest-path-empty");
        // No project directory at all.
        assert_eq!(claude_latest_session_path_in(None, Some(&home), "/wt/fresh"), None);

        // Directory exists, but nothing in it is a transcript.
        let dir = claude_session_dir_for(&home_root(&home), "/wt/fresh");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        std::fs::create_dir_all(dir.join("subdir.jsonl")).unwrap();
        assert_eq!(claude_latest_session_path_in(None, Some(&home), "/wt/fresh"), None);

        // And with no home and no config dir there is no root to scan.
        assert_eq!(claude_latest_session_path_in(None, None, "/wt/fresh"), None);
    }

    #[test]
    fn claude_projects_root_treats_an_empty_config_dir_as_unset() {
        let home = Path::new("/home/me");
        let expected = Some(PathBuf::from("/home/me/.claude/projects"));
        // The default account stores config_dir = "" (meaning "export no CLAUDE_CONFIG_DIR").
        // Joining onto it would yield a RELATIVE `projects/` rooted at Sparkle's cwd, which reads
        // as zero transcripts — so zero usage, no learned ceiling, no rate-limit events.
        assert_eq!(claude_projects_root(Some(Path::new("")), Some(home)), expected);
        assert_eq!(claude_projects_root(None, Some(home)), expected);
        // A real dir still wins, and stays absolute.
        assert_eq!(
            claude_projects_root(Some(Path::new("/data/accounts/x")), Some(home)),
            Some(PathBuf::from("/data/accounts/x/projects"))
        );
        // Nothing resolvable at all → None (never a relative path).
        assert_eq!(claude_projects_root(Some(Path::new("")), None), None);
        assert_eq!(claude_projects_root(None, None), None);
    }

    #[test]
    fn encode_project_slug_matches_claude_scheme() {
        // Regression guard: the slug Claude Code derives for our worktree paths.
        // If a future claude version changes its encoding, this pins what we
        // relied on. Note `/.sparkle` -> `--sparkle` (slash AND dot).
        assert_eq!(
            encode_project_slug(
                "/Users/drodio/Projects/sparkle-desktop/.sparkle/worktrees/d9c408cc-b15d"
            ),
            "-Users-drodio-Projects-sparkle-desktop--sparkle-worktrees-d9c408cc-b15d"
        );
    }

    #[test]
    fn encode_project_slug_replaces_spaces_like_claude() {
        // macOS agent worktrees live under `~/Library/Application Support/...`.
        // The SPACE in "Application Support" must become `-`, exactly as Claude
        // Code encodes it — every non-alphanumeric char maps to `-`, 1:1 (no
        // collapsing of consecutive separators).
        assert_eq!(
            encode_project_slug("/Users/x/Application Support/wt"),
            "-Users-x-Application-Support-wt"
        );
    }

    #[test]
    fn has_session_resolves_space_path_to_dash_dir() {
        // End-to-end proof of the macOS crisis fix: a worktree path containing a
        // space must resolve to Claude's real transcript dir (space→dash). We seed
        // a `<uuid>.jsonl` under the correctly-encoded name and assert has_session
        // sees it — while the OLD space-PRESERVING name would miss entirely.
        let home = unique_home("space-path");
        let worktree = "/Users/x/Library/Application Support/ai.sparkle.desktop/worktrees/wt";

        // The correctly-encoded dir Claude Code actually uses.
        seed_session(&claude_session_dir_for(&home_root(&home), worktree));
        assert!(claude_has_session_in(None, Some(&home), worktree));

        // Prove the seeded dir's name has NO space (it was dashed), so the old
        // space-preserving encoder — which left "Application Support" intact —
        // would have looked in a directory that does not exist.
        let old_slug: String = worktree
            .chars()
            .map(|c| if c == '/' || c == '.' { '-' } else { c })
            .collect();
        assert!(
            old_slug.contains(' '),
            "old encoder leaves the space intact"
        );
        assert!(
            !home_root(&home).join(&old_slug).exists(),
            "old space-preserving slug points at a nonexistent dir → has_session would miss"
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn has_session_true_when_transcript_present() {
        let home = unique_home("present");
        let worktree = "/tmp/proj/.sparkle/worktrees/abc";
        seed_session(&claude_session_dir_for(&home_root(&home), worktree));

        assert!(claude_has_session_in(None, Some(&home), worktree));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn has_session_false_when_dir_missing() {
        let home = unique_home("missing");
        assert!(!claude_has_session_in(
            None,
            Some(&home),
            "/tmp/never/.sparkle/worktrees/xyz"
        ));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn has_session_false_when_dir_empty() {
        let home = unique_home("empty");
        let worktree = "/tmp/proj/.sparkle/worktrees/empty";
        std::fs::create_dir_all(claude_session_dir_for(&home_root(&home), worktree)).unwrap();
        assert!(!claude_has_session_in(None, Some(&home), worktree));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn has_session_false_when_only_cruft() {
        // A stray `.DS_Store` (or any non-`.jsonl` entry) must NOT count as a
        // resumable session — `claude --continue` would error there.
        let home = unique_home("cruft");
        let worktree = "/tmp/proj/.sparkle/worktrees/cruft";
        let dir = claude_session_dir_for(&home_root(&home), worktree);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".DS_Store"), b"\0").unwrap();
        std::fs::create_dir_all(dir.join("subdir")).unwrap();
        assert!(!claude_has_session_in(None, Some(&home), worktree));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn config_dir_overrides_home() {
        // When CLAUDE_CONFIG_DIR is set, sessions live under it — not $HOME/.claude.
        let base = unique_home("cfg");
        let config_dir = base.join("custom-claude");
        let home = base.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let worktree = "/tmp/proj/.sparkle/worktrees/cfg";

        // Seed only under the config dir; $HOME has nothing.
        seed_session(&claude_session_dir_for(
            &claude_projects_root(Some(&config_dir), None).unwrap(),
            worktree,
        ));

        assert!(claude_has_session_in(Some(&config_dir), Some(&home), worktree));
        // Without the config dir, the same lookup against $HOME finds nothing.
        assert!(!claude_has_session_in(None, Some(&home), worktree));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn false_when_neither_config_nor_home() {
        assert!(!claude_has_session_in(None, None, "/tmp/x"));
    }

    #[test]
    fn latest_ai_title_returns_the_last_one_and_ignores_other_lines() {
        let home = unique_home("aititle");
        let worktree = "/tmp/proj/.sparkle/worktrees/aititle";
        let dir = claude_session_dir_for(&home_root(&home), worktree);
        std::fs::create_dir_all(&dir).unwrap();
        // A realistic mix: metadata, message lines, and several ai-title updates. The LAST
        // ai-title is the freshest and must win; non-title lines (even ones mentioning the word)
        // and an empty/whitespace title must be ignored.
        let body = concat!(
            r#"{"type":"mode","sessionId":"s","mode":"default"}"#, "\n",
            r#"{"type":"user","message":{"role":"user","content":"do the thing"}}"#, "\n",
            r#"{"type":"ai-title","aiTitle":"First Rough Title","sessionId":"s"}"#, "\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":"talking about ai-title here"}}"#, "\n",
            r#"{"type":"ai-title","aiTitle":"  ","sessionId":"s"}"#, "\n",
            r#"{"type":"ai-title","aiTitle":"Debug Merged Agent On New Pop Open","sessionId":"s"}"#, "\n",
        );
        let file = dir.join("4b2a247c-ed39.jsonl");
        std::fs::write(&file, body).unwrap();
        assert_eq!(
            latest_ai_title_in(&file),
            Some("Debug Merged Agent On New Pop Open".to_string())
        );

        // End-to-end through the path resolver (single transcript present).
        assert_eq!(
            agent_session_title_in(None, Some(&home), worktree),
            Some("Debug Merged Agent On New Pop Open".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_title_is_none_when_no_ai_title_or_no_session() {
        let home = unique_home("notitle");
        let worktree = "/tmp/proj/.sparkle/worktrees/notitle";
        let dir = claude_session_dir_for(&home_root(&home), worktree);
        std::fs::create_dir_all(&dir).unwrap();
        // A transcript with messages but no ai-title yet → None (not an error).
        std::fs::write(
            dir.join("sess.jsonl"),
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        )
        .unwrap();
        assert_eq!(agent_session_title_in(None, Some(&home), worktree), None);
        // And a worktree with no session dir at all.
        assert_eq!(
            agent_session_title_in(None, Some(&home), "/tmp/proj/.sparkle/worktrees/absent"),
            None
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_trailing_whitespace_title_does_not_clobber_a_prior_valid_one() {
        // The freshest line is a blank title (Claude Code can emit one transiently). The
        // `!t.is_empty()` guard must keep the last VALID title rather than blanking the name.
        let home = unique_home("trailing-ws");
        let worktree = "/tmp/proj/.sparkle/worktrees/trailing-ws";
        let dir = claude_session_dir_for(&home_root(&home), worktree);
        std::fs::create_dir_all(&dir).unwrap();
        let body = concat!(
            r#"{"type":"ai-title","aiTitle":"Good Title","sessionId":"s"}"#, "\n",
            r#"{"type":"ai-title","aiTitle":"   ","sessionId":"s"}"#, "\n",
        );
        std::fs::write(dir.join("s.jsonl"), body).unwrap();
        assert_eq!(
            agent_session_title_in(None, Some(&home), worktree),
            Some("Good Title".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn large_transcript_uses_the_tail_window_and_falls_back_for_older_titles() {
        let home = unique_home("tail");
        let worktree = "/tmp/proj/.sparkle/worktrees/tail";
        let dir = claude_session_dir_for(&home_root(&home), worktree);
        std::fs::create_dir_all(&dir).unwrap();

        // >TAIL_SCAN_BYTES of filler so the tail window can't cover the whole file.
        let filler = format!(
            "{}\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":"padding line to grow the transcript past the tail window"}}"#
        )
        .repeat(2000); // ~200 KB
        assert!(filler.len() as u64 > TAIL_SCAN_BYTES, "fixture must exceed the tail window");

        // Fast path: the freshest title sits in the tail (after the filler).
        std::fs::write(
            dir.join("a.jsonl"),
            format!(
                "{filler}{}",
                "{\"type\":\"ai-title\",\"aiTitle\":\"Tail Title\",\"sessionId\":\"s\"}\n"
            ),
        )
        .unwrap();
        assert_eq!(
            latest_ai_title_in(&dir.join("a.jsonl")),
            Some("Tail Title".to_string())
        );

        // Fallback: the only title predates the tail window (at the very start) — a full scan
        // still finds it rather than returning None.
        std::fs::write(
            dir.join("b.jsonl"),
            format!(
                "{}{filler}",
                "{\"type\":\"ai-title\",\"aiTitle\":\"Early Title\",\"sessionId\":\"s\"}\n"
            ),
        )
        .unwrap();
        assert_eq!(
            latest_ai_title_in(&dir.join("b.jsonl")),
            Some("Early Title".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_title_reads_from_the_newest_transcript() {
        let home = unique_home("newest");
        let worktree = "/tmp/proj/.sparkle/worktrees/newest";
        let dir = claude_session_dir_for(&home_root(&home), worktree);
        std::fs::create_dir_all(&dir).unwrap();

        // Older session carries a stale title; newer session (a `--continue` resume) carries the
        // current one. We must read the newest file's title, not an arbitrary directory entry.
        let old = dir.join("old.jsonl");
        std::fs::write(
            &old,
            "{\"type\":\"ai-title\",\"aiTitle\":\"Stale Title\",\"sessionId\":\"a\"}\n",
        )
        .unwrap();
        let new = dir.join("new.jsonl");
        std::fs::write(
            &new,
            "{\"type\":\"ai-title\",\"aiTitle\":\"Current Title\",\"sessionId\":\"b\"}\n",
        )
        .unwrap();
        // Force `old` to be strictly older so mtime ordering is unambiguous (same-instant writes
        // would otherwise tie on fast filesystems).
        let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(hour_ago)
            .unwrap();

        assert_eq!(
            agent_session_title_in(None, Some(&home), worktree),
            Some("Current Title".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn latest_session_id_returns_stem_of_newest_transcript() {
        // Mirror of `session_title_reads_from_the_newest_transcript`: when a worktree has multiple
        // transcripts (a fresh start + each `--continue` resume), the id we resume by must be the
        // NEWEST file's stem — and it must drop the `.jsonl` extension.
        let home = unique_home("latest-id");
        let worktree = "/tmp/proj/.sparkle/worktrees/latest-id";
        let dir = claude_session_dir_for(&home_root(&home), worktree);
        std::fs::create_dir_all(&dir).unwrap();

        let old = dir.join("11111111-aaaa.jsonl");
        std::fs::write(&old, b"{}\n").unwrap();
        let new = dir.join("22222222-bbbb.jsonl");
        std::fs::write(&new, b"{}\n").unwrap();
        // Force `old` strictly older so mtime ordering is unambiguous on fast filesystems.
        let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(hour_ago)
            .unwrap();

        assert_eq!(
            claude_latest_session_id_in(None, Some(&home), worktree),
            Some("22222222-bbbb".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // The concierge's restore path (spec §3 subsystem C). `preflight::concierge_session_info` hands
    // this probe Sparkle's APP-DATA dir rather than a git worktree, because that is the cwd
    // `concierge.rs` spawns headless `claude -p` in — so Claude Code files the concierge's
    // transcripts under that path's slug. Nothing else pins that: the command itself needs an
    // AppHandle and can't be unit-tested, so if the slug encoding and the real transcript layout ever
    // disagreed for an app-data-shaped path, the concierge would silently restore nothing and the
    // conversation would look lost exactly as before the fix.
    //
    // The path shape is the point — `~/Library/Application Support/ai.sparkle.desktop` carries a
    // SPACE, which Claude encodes to `-`, and the `-dev` suffix a debug build appends.
    #[test]
    fn session_info_finds_the_concierge_transcript_under_the_app_data_dir() {
        let home = unique_home("concierge-appdata");
        for cwd in [
            "/Users/x/Library/Application Support/ai.sparkle.desktop",
            "/Users/x/Library/Application Support/ai.sparkle.desktop-dev",
        ] {
            // Nothing seeded yet: a first-run install must report "no session" rather than a
            // half-answer the caller would restore into.
            assert_eq!(claude_session_info_in(None, Some(&home), cwd), (false, None));

            seed_session(&claude_session_dir_for(&home_root(&home), cwd));
            assert_eq!(
                claude_session_info_in(None, Some(&home), cwd),
                (true, Some("b3d4494a-3b98".to_string())),
                "app-data cwd {cwd} must resolve to the transcript dir Claude Code actually writes"
            );
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    // The two halves must agree. They are separate scans of the same directory, so a caller that
    // trusted `has_session` and then found `latest_session_id` empty (or vice-versa) would resume
    // into nothing — worth pinning now that both ship as one value.
    #[test]
    fn session_info_halves_agree_with_the_probes_they_replace() {
        let home = unique_home("session-info-agree");
        let worktree = "/tmp/proj/.sparkle/worktrees/agree";
        seed_session(&claude_session_dir_for(&home_root(&home), worktree));
        assert_eq!(
            claude_session_info_in(None, Some(&home), worktree),
            (
                claude_has_session_in(None, Some(&home), worktree),
                claude_latest_session_id_in(None, Some(&home), worktree),
            )
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn latest_session_id_is_none_when_no_transcript_or_no_dir() {
        let home = unique_home("latest-id-none");
        // A session dir that exists but holds no `.jsonl` (only cruft) → None.
        let worktree = "/tmp/proj/.sparkle/worktrees/latest-id-none";
        let dir = claude_session_dir_for(&home_root(&home), worktree);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".DS_Store"), b"\0").unwrap();
        assert_eq!(claude_latest_session_id_in(None, Some(&home), worktree), None);
        // A worktree with no session dir at all → None.
        assert_eq!(
            claude_latest_session_id_in(None, Some(&home), "/tmp/proj/.sparkle/worktrees/absent"),
            None
        );
        // No config and no home → None (can't resolve a projects root).
        assert_eq!(claude_latest_session_id_in(None, None, worktree), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn latest_session_id_resolves_config_dir_over_home() {
        // When CLAUDE_CONFIG_DIR is set, the transcript lives under it — not $HOME/.claude — and the
        // id lookup must follow the same account, exactly like `claude_has_session`.
        let base = unique_home("latest-id-cfg");
        let config_dir = base.join("custom-claude");
        let home = base.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let worktree = "/tmp/proj/.sparkle/worktrees/latest-id-cfg";

        let dir = claude_session_dir_for(
            &claude_projects_root(Some(&config_dir), None).unwrap(),
            worktree,
        );
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("deadbeef-1234.jsonl"), b"{}\n").unwrap();

        assert_eq!(
            claude_latest_session_id_in(Some(&config_dir), Some(&home), worktree),
            Some("deadbeef-1234".to_string())
        );
        // Without the config dir, the same lookup against $HOME finds nothing.
        assert_eq!(claude_latest_session_id_in(None, Some(&home), worktree), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn explicit_config_dir_takes_precedence_over_env() {
        let env = || Some(PathBuf::from("/home/me/.claude"));
        // The chosen account's config dir (explicit) wins over Sparkle's process env.
        assert_eq!(
            resolve_session_config_dir(Some("/acct/ab12"), env()),
            Some(PathBuf::from("/acct/ab12"))
        );
        // No explicit dir → fall back to the env value (pre-accounts behavior).
        assert_eq!(resolve_session_config_dir(None, env()), env());
        // An empty explicit value is treated as unset and defers to env...
        assert_eq!(resolve_session_config_dir(Some(""), env()), env());
        // ...and with no env, an empty explicit yields None so the $HOME/.claude branch applies.
        assert_eq!(resolve_session_config_dir(Some(""), None), None);
        assert_eq!(resolve_session_config_dir(None, None), None);
        // An empty env PathBuf is guarded INSIDE the function (not just by the caller), so it's
        // unset too — defense in depth against a future caller that forgets to pre-filter.
        assert_eq!(resolve_session_config_dir(None, Some(PathBuf::from(""))), None);
        assert_eq!(resolve_session_config_dir(Some(""), Some(PathBuf::from(""))), None);
    }

    #[test]
    fn empty_config_dir_is_treated_as_unset() {
        // An empty `OsStr` (e.g. `export CLAUDE_CONFIG_DIR=`, or the default account's stored
        // `config_dir: ""`) must not produce a relative `projects/<slug>` root that skips the $HOME
        // fallback. The guard lives in `claude_projects_root` itself, not only in the callers that
        // pre-filter: `accounts.rs` hands an account's raw `config_dir` straight through, and for
        // the default account that string is empty by design.
        let empty = PathBuf::from("");
        let home = unique_home("emptyenv");
        let worktree = "/tmp/proj/.sparkle/worktrees/emptyenv";
        seed_session(&claude_session_dir_for(&home_root(&home), worktree));

        // An empty value resolves via $HOME and finds the seeded session — same as omitting it.
        assert!(claude_has_session_in(Some(&empty), Some(&home), worktree));
        assert!(claude_has_session_in(None, Some(&home), worktree));
        // Without a home there is nothing to fall back to, and still no relative root.
        assert_eq!(claude_projects_root(Some(&empty), None), None);
        assert!(!claude_has_session_in(Some(&empty), None, worktree));
        let _ = std::fs::remove_dir_all(&home);
    }
}
