//! The Sparkle self-improvement agent's app-owned meta-workspace.
//!
//! Unlike normal agents — which work inside the *user's* project — this special agent
//! works on Sparkle ITSELF: it reviews the user's session logs, drafts specs, and opens
//! PRs to the open-source Sparkle client. Its work is orthogonal to whatever the user is
//! building, so it must never touch a user project folder.
//!
//! Design: a single clone of the open-source repo, app-owned, under Sparkle's app-data dir
//! (`<app_data>/sparkle-self/repo`). It is the SAME for every project on this machine —
//! one clone, reused forever (idempotent). The agent then gets its own isolated git
//! worktree off that clone via the normal worktree machinery (see worktree.rs), so it can
//! never collide with the user's work. The log dir is passed to the agent via `--add-dir`
//! (the agent only needs to *read* the logs; --add-dir itself grants read+write).
//!
//! Dependency-free: we shell out to the system `git` via std::process::Command.

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::AppHandle;

/// The open-source Sparkle client the self-improvement agent files PRs against.
/// This is the PUBLIC mirror (try-sparkle/sparkle). The private source-of-truth repo is
/// not clonable by end users, so its URL must never appear here — this constant ships in
/// the public mirror, and a private URL would point customers at a repo they cannot access.
const SPARKLE_REPO_URL: &str = "https://github.com/try-sparkle/sparkle.git";

/// Synthetic project id namespacing the Sparkle agent's worktrees under app-data. MUST match
/// `SPARKLE_PROJECT_ID` in `src/services/sparkleAgent.ts`.
const SPARKLE_PROJECT_ID: &str = "sparkle-self";

/// The CANONICAL Sparkle agent id — the main window's interactive pane and the hourly headless
/// pass share it (one worktree). MUST match `SPARKLE_AGENT_ID` in `src/services/sparkleAgent.ts`.
/// Improve Sparkle is per-window; every OTHER (secondary) window uses `__sparkle_self__-<label>`.
const SPARKLE_CANONICAL_AGENT_ID: &str = "__sparkle_self__";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SparkleWorkspace {
    /// Absolute path to the app-owned clone of the open-source Sparkle repo. The agent's
    /// isolated worktree is cut from this (via create_agent_worktree with this as `root`).
    repo_path: String,
    /// Absolute path to the app log directory the agent reviews (exposed via --add-dir).
    log_dir: String,
    /// The clone's default branch (resolved from origin/HEAD), so the worktree is cut from the
    /// remote's real default rather than a hard-assumed "main".
    default_branch: String,
}

/// Mirror worktree.rs's non-interactive git env so a clone/fetch can never hang the UI on a
/// credential/host-key prompt. A public clone needs no auth; this just fails fast if it ever does.
fn apply_noninteractive(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "true");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
    // Mirrored too: this module's fixtures commit into throwaway repos under the temp dir, so they
    // must not fire the developer's hooks either. See worktree.rs for why.
    #[cfg(test)]
    crate::worktree::apply_test_hook_isolation(cmd);
}

fn is_git_repo(path: &Path) -> bool {
    let mut cmd = Command::new(crate::preflight::git_program());
    cmd.arg("-C").arg(path).args(["rev-parse", "--git-dir"]);
    apply_noninteractive(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// Core (AppHandle-free, testable): ensure the app-owned clone exists under `app_data`, cloning
/// the open-source repo once if absent. Idempotent — an existing valid clone is returned as-is.
pub fn ensure_sparkle_repo_at(app_data: &Path) -> Result<String, String> {
    let repo = app_data.join("sparkle-self").join("repo");

    // Already cloned and healthy → reuse it (clone once, forever).
    if is_git_repo(&repo) {
        return Ok(repo.to_string_lossy().to_string());
    }

    // A leftover non-repo dir (interrupted clone) would make `git clone` fail with "exists and
    // is not empty". Clear it so the clone is reproducible.
    if repo.exists() {
        std::fs::remove_dir_all(&repo)
            .map_err(|e| format!("failed to clear stale sparkle-self dir: {e}"))?;
    }
    if let Some(parent) = repo.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create sparkle-self dir: {e}"))?;
    }

    let mut cmd = Command::new(crate::preflight::git_program());
    cmd.args(["clone", SPARKLE_REPO_URL])
        .arg(&repo);
    apply_noninteractive(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("failed to run git clone: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "couldn't clone the open-source Sparkle repo ({SPARKLE_REPO_URL}): {stderr}"
        ));
    }

    Ok(repo.to_string_lossy().to_string())
}

/// Ensure the Sparkle self-improvement agent's app-owned workspace exists, returning the clone
/// path (for worktree creation), the log dir (passed to the agent via --add-dir), and the clone's
/// resolved default branch. Idempotent.
///
/// `async` + `spawn_blocking`: the first-run `git clone` is a multi-second network operation. A
/// sync `#[tauri::command]` runs on the main thread and would freeze the whole UI for the clone's
/// duration; offloading it keeps the window responsive (the frontend shows its "Preparing…" phase).
#[tauri::command]
pub async fn ensure_sparkle_repo(app: AppHandle) -> Result<SparkleWorkspace, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    let log_dir = crate::dev_identity::app_log_dir(&app)?;
    // Create the log dir so --add-dir never points at a missing path on a fresh install.
    let _ = std::fs::create_dir_all(&log_dir);

    // Run the (possibly slow, blocking) clone + branch resolution off the main thread.
    let (repo_path, default_branch) = tauri::async_runtime::spawn_blocking(move || {
        let repo_path = ensure_sparkle_repo_at(&app_data)?;
        let default_branch = crate::worktree::resolve_default_branch(&repo_path);
        Ok::<_, String>((repo_path, default_branch))
    })
    .await
    .map_err(|e| format!("clone task failed to run: {e}"))?
    .inspect_err(|e| tracing::error!(error = %e, "ensure_sparkle_repo failed"))?;
    tracing::info!(%repo_path, %default_branch, "ensure_sparkle_repo ready");

    Ok(SparkleWorkspace {
        repo_path,
        log_dir: log_dir.to_string_lossy().to_string(),
        default_branch,
    })
}

/// Core (AppHandle-free, testable): remove every PER-WINDOW Sparkle worktree under
/// `<app_data>/worktrees/sparkle-self` whose agent id is NOT the canonical one, returning how many
/// were removed. Improve Sparkle is per-window — each secondary window (`win-<uuid>`) cuts its own
/// worktree — but secondary windows are never restored across an app restart (multi-window session
/// restore is deferred), so their worktrees would accumulate forever. The canonical worktree (shared
/// by the main window's pane and the hourly pass) is always preserved. Idempotent: a missing
/// worktrees dir is a no-op (`Ok(0)`), and per-entry failures are skipped so one bad dir can't
/// strand the rest. For each reaped worktree we also drop its `sparkle/agent-<id>` branch (which
/// `remove_worktree_at` intentionally leaves behind) so refs don't pile up in the shared clone, and
/// we force-remove any leftover directory whose git metadata is already gone (a crash orphan that
/// `git worktree remove` reports as "not a working tree" without deleting). `removed` counts only
/// directories actually gone from disk afterward, so the returned count never over-reports.
pub fn reap_secondary_sparkle_worktrees_at(app_data: &Path) -> Result<u32, String> {
    // The clone whose worktrees these are — `remove_worktree_at` runs `git worktree remove` against it.
    let repo = app_data.join(SPARKLE_PROJECT_ID).join("repo");
    let repo_str = repo.to_string_lossy().to_string();

    let wt_dir = app_data.join("worktrees").join(SPARKLE_PROJECT_ID);
    let entries = match std::fs::read_dir(&wt_dir) {
        Ok(e) => e,
        Err(_) => return Ok(0), // dir absent (no Sparkle worktrees yet) → nothing to reap
    };

    let mut removed = 0u32;
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == SPARKLE_CANONICAL_AGENT_ID {
            continue; // keep the canonical (main-window + hourly-pass) worktree
        }
        let dir = wt_dir.join(&name);
        // Reuse the exact removal path agents use (validates the id, force-removes the worktree,
        // idempotent). Best-effort — a validation/removal failure just falls through to the disk
        // fallback below rather than aborting the whole sweep.
        let _ = crate::worktree::remove_worktree_at(&repo_str, SPARKLE_PROJECT_ID, &name, app_data);
        // Crash-orphan fallback: `git worktree remove` returns Ok for a dir it doesn't recognize as
        // a worktree WITHOUT deleting it. If the dir is still on disk, force-remove it so a
        // metadata-less orphan (the exact case that produces accumulation) is actually cleaned.
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        // Drop the per-window branch too (`remove_worktree_at` keeps it, which is right for a real
        // agent that may resume — but a reaped secondary window never restores, bead , so
        // its branch would only accumulate as a dead ref in the clone). INVARIANT: a secondary
        // window's meaningful output is a PUSHED PR; this force-delete discards only local-only
        // commits in an app-internal, never-restored clone that nothing else can reach. We log the
        // branch as it goes so the (rare) loss isn't fully silent. Best-effort.
        let branch = format!("sparkle/agent-{name}");
        tracing::info!(%branch, "reaping orphaned per-window Sparkle branch");
        let mut cmd = Command::new(crate::preflight::git_program());
        cmd.arg("-C").arg(&repo_str).args(["branch", "-D", &branch]);
        apply_noninteractive(&mut cmd);
        let _ = cmd.output();
        // Count only if the directory is genuinely gone now, so the tally never over-reports.
        if !dir.exists() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Reap orphaned per-window Sparkle worktrees (see [`reap_secondary_sparkle_worktrees_at`]). Called
/// once on main-window boot, which at cold start is the only live window — so no in-use secondary
/// worktree can be clobbered. Returns the number removed.
///
/// `async` + `spawn_blocking`: `git worktree remove --force` deletes whole dirs from disk (seconds
/// each); offloading keeps the window responsive.
#[tauri::command]
pub async fn reap_secondary_sparkle_worktrees(app: AppHandle) -> Result<u32, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || reap_secondary_sparkle_worktrees_at(&app_data))
        .await
        .map_err(|e| format!("reap task failed to run: {e}"))?
}

/// Can this machine actually SUBMIT the improvement agent's work upstream?
///
/// The agent's whole loop ends in `gh pr create` against the public mirror — but only the repo's
/// maintainers have push access to it. For everyone else the push 403s at the very last step,
/// after a full pass has already been spent, and the failure surfaces as a quiet gray "blocked"
/// row with no explanation. Worse, the consent banner has already promised that PRs get
/// submitted, which for a read-only user is simply false.
///
/// So we ask BEFORE spending the pass, and let the persona degrade to propose-only rather than
/// march into a wall. The verdicts are deliberately distinct: they mean different things to the
/// user (install a tool / log in / you're read-only / we couldn't tell).
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmitVerdict {
    /// The authenticated account has push access — the normal `gh pr create` path is available.
    CanSubmit,
    /// Authenticated, but read-only on the upstream repo. The common case for a public user.
    NoPush,
    /// `gh` is installed but has no usable credentials.
    NotAuthenticated,
    /// No `gh` binary on this machine.
    GhMissing,
    /// We could not determine it (offline, API error, unexpected output). Treated as "assume the
    /// normal path" everywhere downstream: a transient network blip must never silently downgrade
    /// a maintainer's agent to propose-only.
    Unknown,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubmitCapability {
    pub verdict: SubmitVerdict,
    /// `owner/repo` the verdict is about, so the UI can name it without re-deriving it.
    pub repo: String,
}

/// `owner/repo` for a GitHub clone URL. Pure so the slug the probe asks about is testable without
/// touching the network. Handles the `https://…/owner/repo(.git)` form this app ships with; any
/// other shape yields None rather than a guess (a wrong slug would probe the wrong repo).
pub fn repo_slug_from_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://github.com/")?;
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty())?;
    if parts.next().is_some() {
        return None; // deeper path — not a bare repo URL
    }
    Some(format!("{owner}/{repo}"))
}

/// What one `gh api repos/<slug>` probe told us. Most outcomes are decided on the spot; the
/// absent-permissions case genuinely isn't, and needs a second question (see below).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeOutcome {
    Decided(SubmitVerdict),
    /// The call succeeded but carried no `.permissions` block. In practice this is an ANONYMOUS
    /// read of a public repo: GitHub returns a `permissions` object for any authenticated request,
    /// so a signed-in token normally lands in the `true`/`false` branches above. We still refuse to
    /// call it "signed out" from this evidence alone — telling a signed-in user to sign in is
    /// exactly the dishonest failure this probe exists to end, and the cost of being sure is one
    /// extra call on a branch that is already rare. The signed-in resolution is therefore
    /// defensive rather than an observed case.
    PermissionsAbsent,
}

/// Classify one `gh api repos/<slug> --jq .permissions.push` invocation. Pure: the whole point is
/// that every branch is unit-testable, since the interesting cases (read-only user, logged out)
/// are exactly the ones a maintainer's machine can never reproduce locally.
pub fn classify_push_probe(ok: bool, stdout: &str, stderr: &str) -> ProbeOutcome {
    let out = stdout.trim();
    if ok {
        return ProbeOutcome::Decided(match out {
            "true" => SubmitVerdict::CanSubmit,
            "false" => SubmitVerdict::NoPush,
            "" | "null" => return ProbeOutcome::PermissionsAbsent,
            _ => SubmitVerdict::Unknown,
        });
    }
    ProbeOutcome::Decided(classify_probe_failure(stderr))
}

/// Resolve `PermissionsAbsent` from what a follow-up `gh api user` established:
/// `Some(true)` signed in, `Some(false)` definitely not, `None` we still couldn't tell.
///
/// `None` must NOT collapse to "signed out". The first probe had just succeeded, so a failure here
/// is far more likely a flaky second round-trip than a real credential problem — and answering it
/// with "you're signed out" would recreate the very mislabel this branch exists to prevent. An
/// honest `Unknown` keeps the normal submitting path instead.
pub fn resolve_permissions_absent(authenticated: Option<bool>) -> SubmitVerdict {
    match authenticated {
        Some(true) => SubmitVerdict::NoPush,
        Some(false) => SubmitVerdict::NotAuthenticated,
        None => SubmitVerdict::Unknown,
    }
}

/// Does this stderr say "no usable credentials"? gh's wording varies by version; match on the
/// stable fragments. Shared by both probes so they can't drift apart.
fn is_auth_error(stderr: &str) -> bool {
    is_auth_error_lower(&stderr.to_ascii_lowercase())
}

/// The actual test, on already-lowercased input, so a caller that needs `err` for other checks
/// lowercases once rather than once per question.
fn is_auth_error_lower(err: &str) -> bool {
    err.contains("gh auth login")
        || err.contains("authentication")
        || err.contains("not logged in")
        || err.contains("requires authentication")
        || err.contains("bad credentials")
        || err.contains("http 401")
}

fn classify_probe_failure(stderr: &str) -> SubmitVerdict {
    let err = stderr.to_ascii_lowercase();
    if is_auth_error_lower(&err) {
        return SubmitVerdict::NotAuthenticated;
    }
    // A 404 on a repo we know exists is GitHub's way of hiding a repo the token can't see.
    if err.contains("http 404") || err.contains("could not resolve to a repository") {
        return SubmitVerdict::NoPush;
    }
    // Anything else (offline, DNS, rate limit, timeout) stays Unknown — see the variant's note.
    SubmitVerdict::Unknown
}

/// Probe whether the improvement agent's work can be submitted upstream from this machine.
///
/// Deliberately NOT cached: it is one `gh api` call against a per-pass or per-pane-open action, and
/// a stale verdict is worse than a cheap re-ask — a user who runs `gh auth login` and reopens the
/// pane must not stay stuck on "you're signed out" for the rest of the session.
///
/// `async` + `spawn_blocking`: it makes a network round-trip, which must never run on the main
/// thread.
#[tauri::command]
pub async fn sparkle_submit_capability() -> Result<SubmitCapability, String> {
    let repo = repo_slug_from_url(SPARKLE_REPO_URL)
        .ok_or_else(|| format!("unrecognized Sparkle repo URL: {SPARKLE_REPO_URL}"))?;
    let probe_repo = repo.clone();
    let verdict = tauri::async_runtime::spawn_blocking(move || {
        if crate::preflight::cached_gh_path().is_none() {
            return SubmitVerdict::GhMissing;
        }
        let mut cmd = Command::new(crate::preflight::gh_program());
        cmd.args([
            "api",
            &format!("repos/{probe_repo}"),
            "--jq",
            ".permissions.push",
        ]);
        apply_noninteractive(&mut cmd);
        let outcome = match cmd.output() {
            Ok(out) => classify_push_probe(
                out.status.success(),
                &String::from_utf8_lossy(&out.stdout),
                &String::from_utf8_lossy(&out.stderr),
            ),
            // Spawn failed even though a path was cached (deleted mid-session, permissions):
            // that's "no usable gh", not "no push".
            Err(_) => ProbeOutcome::Decided(SubmitVerdict::GhMissing),
        };
        match outcome {
            ProbeOutcome::Decided(v) => v,
            // Only the genuinely ambiguous case pays for a second round-trip.
            ProbeOutcome::PermissionsAbsent => {
                let mut auth = Command::new(crate::preflight::gh_program());
                auth.args(["api", "user", "--jq", ".login"]);
                apply_noninteractive(&mut auth);
                // Three-way on purpose: only a call that RAN and answered counts as evidence.
                let authenticated = match auth.output() {
                    Ok(o) if o.status.success() => {
                        let login = String::from_utf8_lossy(&o.stdout);
                        // A successful call with no login is not an answer we understand.
                        if login.trim().is_empty() { None } else { Some(true) }
                    }
                    // Non-zero: trust it only when gh actually said "no credentials". Anything
                    // else (offline, rate limit) is a failed question, not a negative answer.
                    Ok(o) if is_auth_error(&String::from_utf8_lossy(&o.stderr)) => Some(false),
                    _ => None,
                };
                resolve_permissions_absent(authenticated)
            }
        }
    })
    .await
    .map_err(|e| format!("submit-capability probe failed to run: {e}"))?;
    Ok(SubmitCapability { verdict, repo })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn repo_slug_parses_the_shipped_url_and_rejects_odd_shapes() {
        assert_eq!(repo_slug_from_url(SPARKLE_REPO_URL).unwrap(), "try-sparkle/sparkle");
        assert_eq!(
            repo_slug_from_url("https://github.com/owner/repo").unwrap(),
            "owner/repo"
        );
        // A wrong slug would probe the WRONG repo and could report CanSubmit for a repo the user
        // happens to own — so anything unexpected must be None, never a best guess.
        assert!(repo_slug_from_url("https://example.com/owner/repo.git").is_none());
        assert!(repo_slug_from_url("git@github.com:owner/repo.git").is_none());
        assert!(repo_slug_from_url("https://github.com/owner").is_none());
        assert!(repo_slug_from_url("https://github.com/owner/repo/tree/main").is_none());
    }

    fn decided(ok: bool, stdout: &str, stderr: &str) -> SubmitVerdict {
        match classify_push_probe(ok, stdout, stderr) {
            ProbeOutcome::Decided(v) => v,
            ProbeOutcome::PermissionsAbsent => panic!("expected a decided verdict"),
        }
    }

    #[test]
    fn push_true_is_the_only_thing_that_unlocks_submission() {
        assert_eq!(decided(true, "true\n", ""), SubmitVerdict::CanSubmit);
        assert_eq!(decided(true, "false\n", ""), SubmitVerdict::NoPush);
    }

    #[test]
    fn an_absent_permissions_block_is_ambiguous_and_is_never_guessed() {
        // It means EITHER an anonymous read of a public repo OR a token that can see the repo
        // without collaborator rights. Those need opposite advice, so the classifier refuses to
        // decide and the caller asks a second question.
        assert_eq!(classify_push_probe(true, "\n", ""), ProbeOutcome::PermissionsAbsent);
        assert_eq!(classify_push_probe(true, "null\n", ""), ProbeOutcome::PermissionsAbsent);
    }

    #[test]
    fn the_ambiguous_case_resolves_on_whether_the_cli_is_actually_signed_in() {
        // Signed in but no permissions block => read-only. Telling THIS user to `gh auth login`
        // would be the dishonest failure this whole probe exists to end.
        assert_eq!(resolve_permissions_absent(Some(true)), SubmitVerdict::NoPush);
        assert_eq!(
            resolve_permissions_absent(Some(false)),
            SubmitVerdict::NotAuthenticated
        );
    }

    #[test]
    fn a_follow_up_probe_that_could_not_answer_never_becomes_signed_out() {
        // The FIRST probe had just succeeded, so a failed second round-trip is far more likely
        // flaky than a real credential problem. Unknown keeps the normal submitting path.
        assert_eq!(resolve_permissions_absent(None), SubmitVerdict::Unknown);
    }

    #[test]
    fn auth_error_detection_is_shared_by_both_probes() {
        assert!(is_auth_error("error: Requires authentication (HTTP 401)"));
        assert!(is_auth_error("run: gh auth login"));
        // A network failure is not a credential failure — this is the distinction the whole
        // three-way resolution rests on.
        assert!(!is_auth_error("dial tcp: lookup api.github.com: no such host"));
        assert!(!is_auth_error("gh: Not Found (HTTP 404)"));
    }

    #[test]
    fn auth_failures_are_reported_as_auth_not_as_read_only() {
        for stderr in [
            "gh: To use GitHub CLI in a GitHub Actions workflow, run: gh auth login",
            "error: Requires authentication (HTTP 401)",
            "Bad credentials",
        ] {
            assert_eq!(
                decided(false, "", stderr),
                SubmitVerdict::NotAuthenticated,
                "stderr: {stderr}"
            );
        }
    }

    #[test]
    fn a_404_on_a_repo_we_know_exists_means_the_token_cannot_see_it() {
        assert_eq!(
            decided(false, "", "gh: Not Found (HTTP 404)"),
            SubmitVerdict::NoPush
        );
    }

    #[test]
    fn transient_failures_stay_unknown_so_offline_never_downgrades_a_maintainer() {
        for stderr in [
            "dial tcp: lookup api.github.com: no such host",
            "error connecting to api.github.com",
            "context deadline exceeded",
        ] {
            assert_eq!(decided(false, "", stderr), SubmitVerdict::Unknown, "stderr: {stderr}");
        }
        // Unparseable success output is equally "we couldn't tell".
        assert_eq!(decided(true, "maybe", ""), SubmitVerdict::Unknown);
    }

    fn unique_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sparkle-self-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reuses_an_existing_clone_without_recloning() {
        // Stand up a fake "clone" (a real local repo) at the expected path, then assert
        // ensure_*_at returns it as-is (no network) rather than trying to clone over it.
        let app_data = unique_dir("reuse");
        let repo = app_data.join("sparkle-self").join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        // Routed through apply_noninteractive so the fixture's commits can't fire the developer's
        // git hooks (a global core.hooksPath would otherwise queue a review per fixture commit
        // against a directory this test deletes on the way out).
        let run = |args: &[&str]| {
            let mut cmd = Command::new("git");
            cmd.arg("-C").arg(&repo).args(args);
            apply_noninteractive(&mut cmd);
            assert!(cmd.status().unwrap().success());
        };
        run(&["init"]);
        // Identity is required to commit; git does not validate the shape, so keep these
        // free of anything resembling a real address (same convention as worktree.rs).
        run(&["config", "user.email", "sparkle-test"]);
        run(&["config", "user.name", "sparkle-test"]);
        run(&["commit", "--allow-empty", "-m", "seed"]);

        let got = ensure_sparkle_repo_at(&app_data).expect("reuse existing clone");
        assert_eq!(got, repo.to_string_lossy());
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn reaps_secondary_worktrees_and_keeps_canonical() {
        // Stand up a real clone + two Sparkle worktrees off it (canonical + one per-window
        // secondary), then assert the reap removes ONLY the secondary and leaves the canonical.
        let app_data = unique_dir("reap");
        let repo = app_data.join("sparkle-self").join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        // Same hook isolation as above — this fixture commits AND cuts worktrees.
        let run = |cwd: &Path, args: &[&str]| {
            let mut cmd = Command::new("git");
            cmd.arg("-C").arg(cwd).args(args);
            apply_noninteractive(&mut cmd);
            assert!(cmd.status().unwrap().success(), "git {args:?} failed");
        };
        run(&repo, &["init"]);
        run(&repo, &["config", "user.email", "sparkle-test"]);
        run(&repo, &["config", "user.name", "sparkle-test"]);
        run(&repo, &["commit", "--allow-empty", "-m", "seed"]);

        // Worktrees live under <app_data>/worktrees/sparkle-self/<agent_id> (worktree_path layout).
        // Branch names follow the real convention `sparkle/agent-<dir name>` so the reaper's
        // branch-cleanup path is exercised (it derives the branch from the dir name).
        let wt_dir = app_data.join("worktrees").join(SPARKLE_PROJECT_ID);
        std::fs::create_dir_all(&wt_dir).unwrap();
        let canonical = wt_dir.join(SPARKLE_CANONICAL_AGENT_ID);
        let sec_name = format!("{SPARKLE_CANONICAL_AGENT_ID}-win-abc123");
        let secondary = wt_dir.join(&sec_name);
        let canon_branch = format!("sparkle/agent-{SPARKLE_CANONICAL_AGENT_ID}");
        let sec_branch = format!("sparkle/agent-{sec_name}");
        run(&repo, &["worktree", "add", "-b", &canon_branch, canonical.to_str().unwrap()]);
        run(&repo, &["worktree", "add", "-b", &sec_branch, secondary.to_str().unwrap()]);
        // A crash orphan: a leftover dir with NO git worktree metadata (git won't delete it).
        let orphan = wt_dir.join(format!("{SPARKLE_CANONICAL_AGENT_ID}-win-orphan"));
        std::fs::create_dir_all(&orphan).unwrap();
        assert!(canonical.exists() && secondary.exists() && orphan.exists());

        let branch_exists = |b: &str| {
            Command::new("git")
                .arg("-C").arg(&repo)
                .args(["rev-parse", "--verify", "--quiet", &format!("refs/heads/{b}")])
                .status().unwrap().success()
        };

        let removed = reap_secondary_sparkle_worktrees_at(&app_data).expect("reap");
        assert_eq!(removed, 2, "both the secondary worktree and the crash orphan are reaped");
        assert!(canonical.exists(), "canonical worktree is preserved");
        assert!(!secondary.exists(), "secondary worktree is removed from disk");
        assert!(!orphan.exists(), "crash-orphan dir (no git metadata) is force-removed");
        assert!(branch_exists(&canon_branch), "canonical branch is preserved");
        assert!(!branch_exists(&sec_branch), "secondary branch is deleted so refs don't accumulate");

        // Idempotent: a second sweep finds nothing left to reap.
        assert_eq!(reap_secondary_sparkle_worktrees_at(&app_data).expect("reap again"), 0);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn reap_is_noop_when_worktrees_dir_absent() {
        let app_data = unique_dir("reap-empty");
        assert_eq!(reap_secondary_sparkle_worktrees_at(&app_data).expect("noop"), 0);
        let _ = std::fs::remove_dir_all(&app_data);
    }
}
