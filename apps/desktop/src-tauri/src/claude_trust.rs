//! Derive the key Claude Code looks folder-trust up under.
//!
//! ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────────────────────────
//! Sparkle pre-seeds `projects[<key>].hasTrustDialogAccepted = true` into an account's
//! `.claude.json` so a freshly spawned agent does not stop on the "Quick safety check: Is this a
//! project you created or one you trust?" dialog. That seed is only worth anything if `<key>` is the
//! key Claude Code actually READS — and for years it was not (bead `sparkle-ubee5u`).
//!
//! Sparkle seeded the WORKTREE PATH. Claude Code, for a LINKED GIT WORKTREE — which every Sparkle
//! agent worktree is — looks trust up under the **MAIN REPOSITORY ROOT**. So the seed wrote a key
//! nothing ever read, every agent fell through to the dialog, and the founder answered it by hand
//! once per (account × project) forever. Measured at filing time: 117 agent worktrees on disk, 63
//! carrying no trust record at all, and the project root — the key that IS read — trusted in only 5
//! of 12 account config dirs.
//!
//! ── THE ALGORITHM, TRANSCRIBED FROM THE SHIPPED BINARY (Claude Code 2.1.240) ────────────────────
//! Read out of the bundle, with the minified names resolved via its own export table:
//!
//! ```text
//! isTrustKeyPersistedTrusted(k) = config.projects?.[k]?.hasTrustDialogAccepted === true
//! isPathPersistedTrusted(p)     = isTrustKeyPersistedTrusted(toTrustKey(p))
//! toTrustKey(p)                 = normalize( linkedWorktreeToMainRoot(gitRoot(p))
//!                                            ?? NFC(resolve(p)) )
//! ```
//!
//! Two properties of that lookup drive every decision below:
//!
//!   * It is an **exact map index** — `projects?.[k]` — with **no parent-directory walk**. Trusting
//!     the worktrees ROOT once would therefore NOT cover the worktrees inside it. Per-key seeding is
//!     the only thing that works.
//!   * `linkedWorktreeToMainRoot` reads `<dir>/.git`; when that is a `gitdir:` FILE it walks
//!     gitdir → commondir and returns `dirname(commondir)` — the main checkout. It bails out to the
//!     directory it was given (`return e`) on ANY deviation from the exact layout it expects.
//!
//! ── FIDELITY, AND WHY A MISS IS STILL SAFE ──────────────────────────────────────────────────────
//! [`trust_keys_for`] returns BOTH the derived key AND the literal resolved path, and the caller
//! seeds every key it returns. That is deliberate belt-and-braces: the CLI's own fallback when its
//! mapping bails out is `NFC(resolve(p))`, the literal path. So if this transcription is ever
//! imperfect, or git's on-disk layout changes under us, the key the CLI lands on is still one we
//! seeded. Being wrong costs a few dozen unread bytes in a JSON file; being absent costs a wedged
//! agent, which is the failure this module exists to remove.
//!
//! This module is pure path/file arithmetic — no `git` subprocess. `git rev-parse --show-toplevel`
//! is what the CLI uses to find the repo root, but Sparkle always launches an agent with the
//! worktree ROOT as cwd, and the walk in [`git_root_of`] reaches the same answer without paying for
//! a process spawn on the spawn path.

use std::path::{Path, PathBuf};

/// The name of the marker git writes in a working tree — a directory in a normal checkout, a file
/// containing `gitdir: …` in a linked worktree. Which of the two it is IS the branch point.
const DOT_GIT: &str = ".git";

/// Walk up from `start` to the nearest ancestor carrying a `.git` entry, mirroring what
/// `git rev-parse --show-toplevel` would report. Returns `None` when nothing on the way up has one
/// (not a repository), which is the case in which the CLI falls back to the literal path.
///
/// Sparkle passes the worktree root, so this virtually always returns `start` on the first probe;
/// the walk exists so a cwd BELOW the worktree root still resolves the same way the CLI's git call
/// would, rather than silently deriving a different key.
fn git_root_of(start: &Path) -> Option<PathBuf> {
    let mut cur: Option<&Path> = Some(start);
    while let Some(dir) = cur {
        if dir.join(DOT_GIT).exists() {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

/// Read a small git control file, trimmed. `None` on any I/O error — every caller treats that as
/// "deviation → bail out to the literal directory", which is exactly the CLI's `catch { return e }`.
fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

/// Map a LINKED WORKTREE's root to the MAIN REPOSITORY root, or return `dir` unchanged.
///
/// A faithful transcription of the binary's `I8u`. Every early return here corresponds to one of its
/// `return e` guards; the shape is intentionally verbose and un-collapsed so it can be diffed
/// against the original when Claude Code changes. The chain, for a worktree cut as
/// `git worktree add <wt> …` from `<main>`:
///
/// ```text
/// <wt>/.git                              file: "gitdir: <main>/.git/worktrees/<name>"
/// <main>/.git/worktrees/<name>/commondir file: "../.."      → resolves to <main>/.git
/// <main>/.git/worktrees/<name>/gitdir    file: "<wt>/.git"  → must round-trip back to <wt>
/// ⇒ key = dirname(<main>/.git) = <main>
/// ```
fn linked_worktree_to_main_root(dir: &Path) -> PathBuf {
    let bail = || dir.to_path_buf();

    // `.git` must be a FILE beginning with `gitdir:`. A normal checkout has a DIRECTORY here, and
    // the CLI returns the directory itself — a plain clone is already its own trust key.
    let dot_git = match read_trimmed(&dir.join(DOT_GIT)) {
        Some(s) => s,
        None => return bail(),
    };
    let Some(rest) = dot_git.strip_prefix("gitdir:") else {
        return bail();
    };

    // `<main>/.git/worktrees/<name>` — the per-worktree admin dir.
    let admin = dir.join(rest.trim());
    let admin = match admin.canonicalize() {
        Ok(p) => p,
        Err(_) => return bail(),
    };

    // commondir points from the admin dir back at the shared `<main>/.git`.
    let commondir = match read_trimmed(&admin.join("commondir")) {
        Some(s) => s,
        None => return bail(),
    };
    let common = match admin.join(commondir).canonicalize() {
        Ok(p) => p,
        Err(_) => return bail(),
    };

    // The admin dir must actually live at `<common>/worktrees/<name>`. This is the CLI's structural
    // check, and it is what stops a hand-edited or exotic layout from being mapped anywhere.
    match admin.parent() {
        Some(parent) if parent == common.join("worktrees") => {}
        _ => return bail(),
    }

    // …and the admin dir's `gitdir` file must point back at THIS worktree's `.git`. Without this
    // round-trip a stale admin dir left behind by a removed worktree could redirect an unrelated
    // directory onto a repository it has nothing to do with.
    let gitdir_back = match read_trimmed(&admin.join("gitdir")) {
        Some(s) => s,
        None => return bail(),
    };
    let back = match admin.join(gitdir_back).canonicalize() {
        Ok(p) => p,
        Err(_) => return bail(),
    };
    let ours = match dir.canonicalize().map(|d| d.join(DOT_GIT)) {
        Ok(p) => p,
        Err(_) => return bail(),
    };
    if back != ours {
        return bail();
    }

    // `<main>/.git` → `<main>`. When the common dir is NOT named `.git` (a bare or relocated
    // repository) the CLI keeps it as-is rather than stripping a component that isn't there.
    if common.file_name().and_then(|n| n.to_str()) == Some(DOT_GIT) {
        match common.parent() {
            Some(main) => main.to_path_buf(),
            None => bail(),
        }
    } else {
        common
    }
}

/// The single key Claude Code will look folder trust up under for an agent launched with `cwd`.
///
/// This is the value that must appear in `.claude.json` as `projects[<key>]` for the trust dialog to
/// stay down. Prefer [`trust_keys_for`] when seeding — it adds the literal path as a safety net.
pub(crate) fn trust_key_for(cwd: &Path) -> PathBuf {
    let literal = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    match git_root_of(&literal) {
        Some(root) => linked_worktree_to_main_root(&root),
        // Not a repository at all — the CLI falls back to the resolved path.
        None => literal,
    }
}

/// Every key worth seeding for `cwd`, most-authoritative first and de-duplicated.
///
/// Returns the derived key (what the CLI reads) and the literal resolved path (what the CLI falls
/// back to if its own mapping bails out). For a NON-worktree directory the two collapse to one
/// entry. See the module header for why seeding both is deliberate rather than sloppy.
pub(crate) fn trust_keys_for(cwd: &Path) -> Vec<String> {
    let literal = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut keys: Vec<String> = Vec::with_capacity(3);
    let mut push = |p: PathBuf| {
        let s = p.to_string_lossy().to_string();
        if !s.is_empty() && !keys.contains(&s) {
            keys.push(s);
        }
    };
    push(trust_key_for(cwd));
    push(literal);
    // The path exactly as the caller spelled it. Sparkle's worktrees live under
    // `~/Library/Application Support/…`, which carries no symlink on a stock macOS, so this is
    // normally identical to `literal` and collapses away — but if a future app-data root ever sits
    // behind one, `canonicalize` would resolve it while the CLI's `path.resolve` would not, and the
    // seeded key would silently stop matching.
    push(cwd.to_path_buf());
    keys
}

/// Every DISTINCT trust key implied by the agent worktrees currently on disk under `app_data`.
///
/// Sparkle lays worktrees out as `<app_data>/worktrees/<projectId>/<agentId>`. Because every agent
/// worktree of one project derives the SAME key (that project's main checkout), a machine with 117
/// worktrees across a handful of projects yields a handful of keys — which is what makes a startup
/// sweep cheap enough to run unconditionally.
///
/// Deriving the keys from the worktrees ON DISK, rather than from the app's project list, is
/// deliberate: it needs no frontend state, and it heals exactly the population that can actually
/// wedge — including worktrees belonging to a project the user has since removed from the sidebar
/// but whose agents are still running.
pub(crate) fn managed_worktree_trust_keys(app_data: &Path) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    let root = app_data.join("worktrees");
    let Ok(projects) = std::fs::read_dir(&root) else {
        return keys; // no worktrees yet — a clean install, nothing to heal
    };
    for project in projects.flatten() {
        if !project.path().is_dir() {
            continue;
        }
        let Ok(agents) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for agent in agents.flatten() {
            let dir = agent.path();
            if !dir.is_dir() {
                continue;
            }
            for k in trust_keys_for(&dir) {
                if !keys.contains(&k) {
                    keys.push(k);
                }
            }
        }
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Build a REAL git repo with a REAL linked worktree. These tests are worthless against a
    /// hand-built fixture: the whole defect was a wrong belief about git's on-disk layout, so the
    /// layout has to come from git itself.
    fn repo_with_worktree() -> Option<(tempfile::TempDir, PathBuf, PathBuf)> {
        let tmp = tempfile::tempdir().ok()?;
        let main = tmp.path().join("main");
        std::fs::create_dir_all(&main).ok()?;
        let git = |args: &[&str], cwd: &Path| -> bool {
            Command::new("git")
                .args(args)
                .current_dir(cwd)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if !git(&["init", "-q", "-b", "main"], &main) {
            return None; // no git on this machine — caller skips
        }
        git(&["config", "user.email", "t@t"], &main);
        git(&["config", "user.name", "t"], &main);
        std::fs::write(main.join("f.txt"), "hi").ok()?;
        git(&["add", "-A"], &main);
        if !git(&["commit", "-qm", "init"], &main) {
            return None;
        }
        let wt = tmp.path().join("wt");
        if !git(
            &["worktree", "add", "-q", "-b", "feature", wt.to_str()?, "main"],
            &main,
        ) {
            return None;
        }
        Some((tmp, main, wt))
    }

    /// THE REGRESSION GUARD FOR THE WHOLE BEAD.
    ///
    /// A linked worktree's trust key is the MAIN REPO ROOT. If a refactor ever makes this return the
    /// worktree path again, the seed goes back to writing a key Claude Code never reads and every
    /// fresh agent goes back to stopping on the trust dialog — which is precisely how the original
    /// no-op survived unnoticed. This assertion is the thing that reds instead.
    #[test]
    fn linked_worktree_trust_key_is_the_main_repo_root_not_the_worktree() {
        let Some((_tmp, main, wt)) = repo_with_worktree() else {
            eprintln!("skipping: git unavailable");
            return;
        };
        let key = trust_key_for(&wt);
        let want = main.canonicalize().unwrap();
        assert_eq!(
            key, want,
            "a linked worktree must resolve to the main checkout — seeding the worktree path is the \
             bug in sparkle-ubee5u"
        );
        assert_ne!(
            key,
            wt.canonicalize().unwrap(),
            "if the key is the worktree path, Claude Code never reads it and the dialog returns"
        );
    }

    /// The seeded set must CONTAIN the key the CLI reads. This is the property the caller depends
    /// on; `trust_key_for` could change shape as long as this still holds.
    #[test]
    fn seeded_keys_contain_the_main_repo_root_for_a_worktree() {
        let Some((_tmp, main, wt)) = repo_with_worktree() else {
            eprintln!("skipping: git unavailable");
            return;
        };
        let keys = trust_keys_for(&wt);
        let want = main.canonicalize().unwrap().to_string_lossy().to_string();
        assert!(
            keys.contains(&want),
            "seeded keys {keys:?} must include the main repo root {want}"
        );
        // …and the literal worktree path too, as the documented fallback net.
        let lit = wt.canonicalize().unwrap().to_string_lossy().to_string();
        assert!(keys.contains(&lit), "seeded keys {keys:?} must include the literal path {lit}");
    }

    /// A cwd BELOW the worktree root still derives the same key — the CLI asks git for the toplevel,
    /// so a subdirectory must not seed something different.
    #[test]
    fn a_subdirectory_of_a_worktree_derives_the_same_key() {
        let Some((_tmp, main, wt)) = repo_with_worktree() else {
            eprintln!("skipping: git unavailable");
            return;
        };
        let sub = wt.join("nested/deeper");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(trust_key_for(&sub), main.canonicalize().unwrap());
    }

    /// An ORDINARY checkout (a `.git` DIRECTORY, not a worktree file) is its own key. Guards the
    /// other direction: over-eager mapping must not redirect a normal repo somewhere else.
    #[test]
    fn an_ordinary_checkout_is_its_own_trust_key() {
        let Some((_tmp, main, _wt)) = repo_with_worktree() else {
            eprintln!("skipping: git unavailable");
            return;
        };
        assert_eq!(trust_key_for(&main), main.canonicalize().unwrap());
    }

    /// A directory that is not in a repository at all falls back to its own resolved path.
    #[test]
    fn a_non_repository_directory_falls_back_to_its_own_path() {
        let tmp = tempfile::tempdir().unwrap();
        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(trust_key_for(&plain), plain.canonicalize().unwrap());
    }

    /// BOTH spellings of a path behind a symlink are seeded.
    ///
    /// This is not hypothetical bookkeeping: on macOS `/tmp` and `/var` are symlinks, so a path
    /// under them canonicalizes to something the CLI would never compute — Claude Code's fallback
    /// key is `NFC(path.resolve(p))`, which makes a path absolute WITHOUT resolving symlinks, while
    /// `canonicalize` resolves them. Seeding only one spelling would miss whichever one the CLI
    /// lands on. The keys must also be de-duplicated, so the common no-symlink case writes one
    /// entry rather than three identical ones.
    #[test]
    fn both_spellings_are_seeded_when_a_symlink_makes_them_differ() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let keys = trust_keys_for(&link);
        let as_spelled = link.to_string_lossy().to_string();
        let resolved = real.canonicalize().unwrap().to_string_lossy().to_string();
        assert!(keys.contains(&as_spelled), "keys {keys:?} must include the path as spelled");
        assert!(keys.contains(&resolved), "keys {keys:?} must include the symlink-resolved path");

        let mut deduped = keys.clone();
        deduped.sort();
        deduped.dedup();
        assert_eq!(deduped.len(), keys.len(), "trust_keys_for must not emit duplicates");
    }

    /// A `.git` file whose `gitdir:` target does not exist must BAIL OUT to the directory itself
    /// rather than derive a nonsense key — the CLI's `catch { return e }`.
    #[test]
    fn a_broken_gitdir_pointer_bails_out_to_the_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join("broken");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(".git"), "gitdir: /nowhere/that/exists/.git/worktrees/x").unwrap();
        assert_eq!(trust_key_for(&d), d.canonicalize().unwrap());
    }
}
