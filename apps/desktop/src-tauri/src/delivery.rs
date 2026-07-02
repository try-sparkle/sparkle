//! Delivery detection (Unit 3 of "Definable Done & Delivered"). Answers "how does *this*
//! project ship to production?" by gathering repo-local, best-effort evidence — presence of
//! deploy config files, `.github/workflows` deploy verbs, and git tag/remote conventions — and
//! handing a flat, JSON-friendly `DeliveryEvidence` struct back to the TS `deliveryDetector`,
//! which classifies it (heuristics + optional Haiku enrichment) into a method + confidence.
//!
//! HONESTY: this module only REPORTS what it can observe from the local repo. It never claims a
//! delivery. It deliberately does NOT touch external dashboards (Vercel/Fly/Netlify APIs) — those
//! are only observable if the user's CLIs happen to be authed, and silently trusting them would
//! let Sparkle assert a ship it can't verify. Reliable signals only: files, workflows, git.
//!
//! Dependency-free: we read files with `std::fs` and shell out to the system `git` (mirroring
//! `worktree.rs`), so a missing/again-broken git degrades to empty evidence rather than an error.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

/// The closed set of deploy "verbs" we grep `.github/workflows/*` for. Matching is substring,
/// case-insensitive. Order is the report order; the TS classifier keys off the exact strings here.
const DEPLOY_VERBS: &[&str] = &[
    "vercel deploy",
    "fly deploy",
    "eas submit",
    "npm publish",
    "gh release",
    "action-gh-release", // softprops/action-gh-release — a GitHub Release cut from CI
    "docker push",
];

/// Flat, serialized-to-camelCase evidence bundle handed to the TS classifier. Every field is
/// best-effort: absence of a signal is a legitimate `false`/empty, never an error. Keep this a
/// FLAT, JSON-friendly struct (no nested maps) so `deliveryDetector.classifyEvidence` stays a
/// pure, easily-tested function over primitives.
#[derive(Serialize, Debug, Default, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryEvidence {
    /// `vercel.json` present, or a `.vercel` project-link directory.
    pub has_vercel: bool,
    /// `fly.toml` present (Fly.io).
    pub has_fly: bool,
    /// `netlify.toml` present.
    pub has_netlify: bool,
    /// A `Dockerfile` at the repo root.
    pub has_dockerfile: bool,
    /// `eas.json` or `app.json` present (Expo / React Native mobile).
    pub has_eas: bool,
    /// `serverless.yml`/`serverless.yaml` present (Serverless Framework).
    pub has_serverless: bool,
    /// `package.json` exists AND is publishable (not `"private": true` and has a `name`).
    pub npm_publishable: bool,
    /// `package.json` `name`, if present.
    pub package_name: Option<String>,
    /// `package.json` `version`, if present.
    pub package_version: Option<String>,
    /// `package.json` declared `"private": true`.
    pub package_private: bool,
    /// `package.json` carried a `publishConfig` block (a strong "we publish" hint).
    pub has_publish_config: bool,
    /// Relative path of the first release-ish script found (`scripts/*release*`, `cut-dmg*`).
    pub release_script: Option<String>,
    /// Which of `DEPLOY_VERBS` were found anywhere under `.github/workflows/*` (deduped, in
    /// `DEPLOY_VERBS` order).
    pub workflow_deploy_verbs: Vec<String>,
    /// The workflow filenames (basename) that matched at least one deploy verb.
    pub workflow_files: Vec<String>,
    /// Any git tag looks like a semver release tag (`v1.2.3` / `1.2.3`).
    pub has_semver_tags: bool,
    /// Total number of git tags.
    pub tag_count: u32,
    /// `git remote -v` remote names (deduped), e.g. `["origin"]`.
    pub remotes: Vec<String>,
    /// Resolved default branch name (best-effort), e.g. `main`.
    pub default_branch: Option<String>,
}

/// Run `git -C <cwd> <args>` non-interactively, returning trimmed stdout or `None` on any failure
/// (missing git, not a repo, etc.). Delivery detection is best-effort: a git error is "no evidence",
/// never a hard failure.
fn git_ok(cwd: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    // Never let git block on an interactive credential/host-key prompt (mirrors worktree.rs).
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "true");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
    let out = cmd.output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

/// True iff `line` looks like a semver-ish release tag: optional leading `v`, then `N.N`(`.N`)?.
fn is_semver_tag(line: &str) -> bool {
    let s = line.trim();
    let s = s.strip_prefix('v').or_else(|| s.strip_prefix('V')).unwrap_or(s);
    let mut parts = s.split('.');
    let major = parts.next();
    let minor = parts.next();
    match (major, minor) {
        (Some(a), Some(b)) => {
            !a.is_empty()
                && a.chars().all(|c| c.is_ascii_digit())
                && !b.is_empty()
                && b.chars().next().is_some_and(|c| c.is_ascii_digit())
        }
        _ => false,
    }
}

/// Core, testable evidence collection over a filesystem path. No AppHandle, no async — just fs +
/// git reads. Tolerant of every absence.
pub fn collect_evidence_at(root: &Path) -> DeliveryEvidence {
    let mut ev = DeliveryEvidence::default();

    let exists = |rel: &str| root.join(rel).exists();

    ev.has_vercel = exists("vercel.json") || exists(".vercel");
    ev.has_fly = exists("fly.toml");
    ev.has_netlify = exists("netlify.toml");
    ev.has_dockerfile = exists("Dockerfile");
    ev.has_eas = exists("eas.json") || exists("app.json");
    ev.has_serverless = exists("serverless.yml") || exists("serverless.yaml");

    // package.json: name/version/private/publishConfig + "publishable" derivation.
    if let Ok(text) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            ev.package_name = json.get("name").and_then(|v| v.as_str()).map(str::to_string);
            ev.package_version = json.get("version").and_then(|v| v.as_str()).map(str::to_string);
            ev.package_private = json.get("private").and_then(|v| v.as_bool()).unwrap_or(false);
            ev.has_publish_config = json.get("publishConfig").is_some();
            ev.npm_publishable = !ev.package_private && ev.package_name.is_some();
        }
    }

    // Release-ish scripts: scan `scripts/` for `*release*` or `cut-dmg*` (also honor a top-level
    // `cut-dmg*`). Record the first hit's repo-relative path.
    ev.release_script = find_release_script(root);

    // .github/workflows/*: read every yml/yaml and grep for deploy verbs.
    let (verbs, files) = scan_workflows(root);
    ev.workflow_deploy_verbs = verbs;
    ev.workflow_files = files;

    // git: tags + remotes + default branch (all best-effort).
    if let Some(tags) = git_ok(root, &["tag"]) {
        let lines: Vec<&str> = tags.lines().filter(|l| !l.trim().is_empty()).collect();
        ev.tag_count = lines.len() as u32;
        ev.has_semver_tags = lines.iter().any(|l| is_semver_tag(l));
    }
    if let Some(remotes) = git_ok(root, &["remote"]) {
        let mut names: Vec<String> = remotes
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        names.dedup();
        ev.remotes = names;
    }
    // origin/HEAD symref → default branch, else local main/master.
    ev.default_branch = git_ok(root, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
        .map(|s| s.rsplit('/').next().unwrap_or(&s).to_string())
        .or_else(|| {
            for b in ["main", "master"] {
                if git_ok(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{b}")]).is_some() {
                    return Some(b.to_string());
                }
            }
            None
        });

    ev
}

/// Scan `scripts/` (and repo root for `cut-dmg*`) for the first release-ish script; returns its
/// repo-relative path.
fn find_release_script(root: &Path) -> Option<String> {
    // Top-level cut-dmg* first (matches this very project's release entrypoint).
    if let Ok(rd) = std::fs::read_dir(root) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.starts_with("cut-dmg") {
                return Some(entry.file_name().to_string_lossy().to_string());
            }
        }
    }
    let scripts = root.join("scripts");
    if let Ok(rd) = std::fs::read_dir(&scripts) {
        // Deterministic order so the "first" hit is stable across runs/platforms.
        let mut hits: Vec<String> = rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let lower = name.to_lowercase();
                if lower.contains("release") || lower.starts_with("cut-dmg") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();
        hits.sort();
        if let Some(first) = hits.into_iter().next() {
            return Some(format!("scripts/{first}"));
        }
    }
    None
}

/// Read every `.github/workflows/*.{yml,yaml}` and collect which `DEPLOY_VERBS` appear and in which
/// files. Verbs are returned deduped in `DEPLOY_VERBS` order; files are basenames that matched ≥1.
fn scan_workflows(root: &Path) -> (Vec<String>, Vec<String>) {
    let dir = root.join(".github").join("workflows");
    let mut matched_verbs: Vec<String> = Vec::new();
    let mut matched_files: Vec<String> = Vec::new();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return (matched_verbs, matched_files);
    };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if !(lower.ends_with(".yml") || lower.ends_with(".yaml")) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let hay = text.to_lowercase();
        let mut file_matched = false;
        for verb in DEPLOY_VERBS {
            if hay.contains(verb) {
                file_matched = true;
                if !matched_verbs.iter().any(|v| v == verb) {
                    matched_verbs.push((*verb).to_string());
                }
            }
        }
        if file_matched {
            matched_files.push(name);
        }
    }
    // Keep DEPLOY_VERBS order regardless of file-scan order.
    matched_verbs.sort_by_key(|v| DEPLOY_VERBS.iter().position(|d| d == v).unwrap_or(usize::MAX));
    (matched_verbs, matched_files)
}

/// Gather repo-local, best-effort delivery evidence for `project_root`. Async + `spawn_blocking`
/// (mirroring `create_agent_worktree`) so the fs reads and several `git` subprocesses never stall
/// the UI thread. Never errors on a missing repo/file — returns empty evidence.
#[tauri::command]
pub async fn collect_delivery_evidence(project_root: String) -> Result<DeliveryEvidence, String> {
    tracing::info!(%project_root, "collect_delivery_evidence");
    tauri::async_runtime::spawn_blocking(move || collect_evidence_at(Path::new(&project_root)))
        .await
        .map_err(|e| format!("collect_delivery_evidence task failed: {e}"))
}

/// Git tags that CONTAIN `sha` (i.e. the commit is an ancestor of the tag) — the "is this commit in
/// a shipped release?" signal for the delivery monitor. Best-effort: returns an empty vec on any
/// git failure (missing tag/sha/repo) rather than erroring, so the poller degrades quietly.
/// Async + `spawn_blocking` so the git subprocess never blocks the UI thread.
#[tauri::command]
pub async fn tag_contains_commit(project_root: String, sha: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&project_root);
        match git_ok(root, &["tag", "--contains", &sha]) {
            Some(out) => out
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect(),
            None => Vec::new(),
        }
    })
    .await
    .map_err(|e| format!("tag_contains_commit task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn detects_gh_release_verb_in_workflow() {
        let dir = tempfile::tempdir().unwrap();
        let wf = dir.path().join(".github").join("workflows");
        fs::create_dir_all(&wf).unwrap();
        fs::write(
            wf.join("release.yml"),
            "name: Release\non:\n  push:\n    tags: ['v*']\njobs:\n  release:\n    steps:\n      - run: gh release create \"$TAG\"\n",
        )
        .unwrap();

        let ev = collect_evidence_at(dir.path());
        assert!(
            ev.workflow_deploy_verbs.iter().any(|v| v == "gh release"),
            "expected 'gh release' verb, got {:?}",
            ev.workflow_deploy_verbs
        );
        assert!(ev.workflow_files.iter().any(|f| f == "release.yml"));
    }

    #[test]
    fn detects_action_gh_release_and_vercel() {
        let dir = tempfile::tempdir().unwrap();
        let wf = dir.path().join(".github").join("workflows");
        fs::create_dir_all(&wf).unwrap();
        fs::write(
            wf.join("ci.yaml"),
            "jobs:\n  deploy:\n    steps:\n      - uses: softprops/action-gh-release@v2\n",
        )
        .unwrap();
        fs::write(dir.path().join("vercel.json"), "{}").unwrap();

        let ev = collect_evidence_at(dir.path());
        assert!(ev.has_vercel);
        assert!(ev.workflow_deploy_verbs.iter().any(|v| v == "action-gh-release"));
    }

    #[test]
    fn package_json_publishable_and_private() {
        let publishable = tempfile::tempdir().unwrap();
        fs::write(
            publishable.path().join("package.json"),
            r#"{"name":"my-lib","version":"1.2.3","publishConfig":{"access":"public"}}"#,
        )
        .unwrap();
        let ev = collect_evidence_at(publishable.path());
        assert!(ev.npm_publishable);
        assert!(ev.has_publish_config);
        assert_eq!(ev.package_name.as_deref(), Some("my-lib"));
        assert_eq!(ev.package_version.as_deref(), Some("1.2.3"));

        let private = tempfile::tempdir().unwrap();
        fs::write(
            private.path().join("package.json"),
            r#"{"name":"app","private":true}"#,
        )
        .unwrap();
        let ev2 = collect_evidence_at(private.path());
        assert!(!ev2.npm_publishable);
        assert!(ev2.package_private);
    }

    #[test]
    fn empty_repo_yields_empty_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let ev = collect_evidence_at(dir.path());
        assert_eq!(ev, DeliveryEvidence::default());
    }

    #[test]
    fn semver_tag_recognition() {
        assert!(is_semver_tag("v1.2.3"));
        assert!(is_semver_tag("1.0"));
        assert!(is_semver_tag("v2.0.0-rc1"));
        assert!(!is_semver_tag("latest"));
        assert!(!is_semver_tag("release"));
    }
}
