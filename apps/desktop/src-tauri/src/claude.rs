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

use std::path::{Path, PathBuf};

/// Encode an absolute directory path into Claude Code's `projects` slug: every
/// `/` and `.` becomes `-`.
///
/// NOTE: this mirrors Claude Code's scheme for the paths we actually feed it —
/// agent worktree paths, which only contain `/`, `.`, `-`, and alphanumerics.
/// Claude's full encoding transforms additional characters (spaces, `~`, …); we
/// don't reproduce those because our worktree paths never contain them.
fn encode_project_slug(path: &str) -> String {
    path.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

/// The `projects` root Claude Code uses: `$CLAUDE_CONFIG_DIR/projects` when the
/// env var is set, else `$HOME/.claude/projects`. Returns `None` when neither is
/// resolvable. Pure form (takes the env values) so it's testable.
fn claude_projects_root(config_dir: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    match config_dir {
        Some(cfg) => Some(cfg.join("projects")),
        None => home.map(|h| h.join(".claude").join("projects")),
    }
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

/// True iff the agent's worktree already has a resumable `claude` conversation.
/// Drives the `claude` vs `claude --continue` choice when (re)opening an agent.
#[tauri::command]
pub fn claude_has_session(worktree_path: String) -> bool {
    // Treat an empty CLAUDE_CONFIG_DIR (a common shell artifact, e.g.
    // `export CLAUDE_CONFIG_DIR=`) as unset so we don't build a relative
    // `projects/<slug>` path and skip the $HOME/.claude fallback.
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    claude_has_session_in(config_dir.as_deref(), home.as_deref(), &worktree_path)
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
    fn empty_config_dir_is_treated_as_unset() {
        // An empty `OsStr` (e.g. `export CLAUDE_CONFIG_DIR=`) must not produce a
        // relative `projects/<slug>` root that skips the $HOME fallback. The
        // public command applies the empty filter; here we assert the resolver
        // contract it relies on: an empty path joins to a *relative* root, which
        // is exactly what the filter exists to avoid — so the command's
        // `.filter(|s| !s.is_empty())` must keep us on the $HOME branch.
        let empty = PathBuf::from("");
        let home = unique_home("emptyenv");
        let worktree = "/tmp/proj/.sparkle/worktrees/emptyenv";
        seed_session(&claude_session_dir_for(&home_root(&home), worktree));

        // With the empty value naively kept, the lookup roots at a relative dir
        // and misses the seeded session.
        assert!(!claude_has_session_in(Some(&empty), Some(&home), worktree));
        // Dropping the empty value (what the command does) finds it via $HOME.
        assert!(claude_has_session_in(None, Some(&home), worktree));
        let _ = std::fs::remove_dir_all(&home);
    }
}
