//! Give a freshly-cut worktree the dependencies it needs to run its own tests.
//!
//! A git worktree carries only TRACKED files, and `node_modules` is gitignored in every JS repo.
//! So every agent and every worker starts life in a directory where `pnpm -r test` dies in about
//! four seconds with `sh: vitest: command not found`. Measured on this machine: 44 of 84 live agent
//! worktrees had no `node_modules` at any level.
//!
//! That is not a cosmetic gap. The agent instructions in this repo require an agent to run the test
//! suite before it commits, so a worktree that cannot run tests puts an agent in front of exactly
//! two bad options — spend a minute rediscovering that it must install first, or skip verification
//! and commit unverified work. The second one is what actually happens, and it is invisible in the
//! diff.
//!
//! This module decides WHAT to do; `run_plan` carries it out. The split exists so the decision is
//! testable without a package manager, a network, or a real install.
//!
//! Cost, measured rather than assumed (this repo, warm pnpm store, `--frozen-lockfile
//! --prefer-offline`): 27s wall, 0 downloads, 1,492 packages reused via hardlink, and **91 MB of
//! real disk** per worktree — the rest of the ~1.6 GB apparent size is hardlinked to the shared
//! store. That is why this is affordable to do per worktree at all, and why it runs in the
//! background instead of blocking the spawn.

use std::path::{Path, PathBuf};

/// The package manager to invoke, identified from what the repo checked in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageManager {
    Pnpm,
    Npm,
    Yarn,
    Bun,
}

impl PackageManager {
    /// The binary name. Deliberately not an absolute path: which pnpm/npm is correct depends on the
    /// user's node install (nvm, corepack, Homebrew), and resolving it here would pin the wrong one.
    pub fn program(self) -> &'static str {
        match self {
            PackageManager::Pnpm => "pnpm",
            PackageManager::Npm => "npm",
            PackageManager::Yarn => "yarn",
            PackageManager::Bun => "bun",
        }
    }

    /// The install invocation.
    ///
    /// Every one of these is a LOCKFILE-RESPECTING install, never a resolving one. A fresh worktree
    /// is not the place to re-resolve a dependency graph: doing so can produce a tree that differs
    /// from the one CI and the other worktrees use, and — worse — can rewrite the lockfile, which
    /// then shows up as an unexplained modification in the agent's very first `git status`.
    pub fn install_args(self) -> &'static [&'static str] {
        match self {
            // `--prefer-offline` is what makes this 27s rather than a network round-trip per
            // package: the global store is already warm from the main checkout.
            //
            // `--ignore-scripts` on EVERY arm is a trust-boundary decision, not a speed one — see
            // `no_install_runs_dependency_lifecycle_scripts`. This install is unattended and fires
            // from merely opening an agent, so it must not execute arbitrary `postinstall` code
            // from the repo's dependency graph. pnpm v10 already gates build scripts this way by
            // default; the flag makes that posture explicit and extends it to the managers that
            // don't.
            PackageManager::Pnpm => {
                &["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"]
            }
            PackageManager::Npm => &["ci", "--prefer-offline", "--ignore-scripts"],
            // Yarn Berry spells it `--immutable`; `--frozen-lockfile` is the v1 name and Berry
            // rejects it. Berry is what ships today, so a v1 repo fails loudly here rather than
            // silently re-resolving — which is the correct direction for this trade.
            PackageManager::Yarn => &["install", "--immutable", "--ignore-scripts"],
            PackageManager::Bun => &["install", "--frozen-lockfile", "--ignore-scripts"],
        }
    }
}

/// Why a worktree needs no install. Each variant is a genuinely different situation, and they are
/// kept distinct because "there was nothing to do" and "we could not tell what to do" must not
/// render the same way in a log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// `node_modules` is already there — a resumed worktree, or a pooled slot warmed earlier.
    AlreadyInstalled,
    /// No `package.json` at the root: not a JS project. Sparkle opens agents on Rust, Go and Python
    /// repos too, and this must be a silent no-op for them rather than a failed install.
    NotAJsProject,
    /// A `package.json` but no lockfile of any kind. Installing here would RESOLVE a fresh graph
    /// and write a lockfile the repo never had — a real, committable side effect on someone's repo
    /// from a background convenience task. Refuse.
    NoLockfile,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapPlan {
    Skip(SkipReason),
    Install(PackageManager),
}

/// Lockfile → package manager, in the order they are checked.
///
/// Order is load-bearing when a repo carries more than one, which happens after a migration leaves
/// the old lockfile behind. pnpm is first because that is the direction migrations run in practice
/// (npm/yarn → pnpm), so the newest lockfile is the one earliest in this list.
/// Every manager this module can drive. Iterated by the tests that assert a property must hold for
/// ALL of them, so adding a variant without satisfying those properties fails rather than slipping
/// through an enumeration someone forgot to extend.
#[cfg(test)]
const ALL_MANAGERS: [PackageManager; 4] = [
    PackageManager::Pnpm,
    PackageManager::Npm,
    PackageManager::Yarn,
    PackageManager::Bun,
];

const LOCKFILES: &[(&str, PackageManager)] = &[
    ("pnpm-lock.yaml", PackageManager::Pnpm),
    ("bun.lock", PackageManager::Bun),
    ("bun.lockb", PackageManager::Bun),
    ("yarn.lock", PackageManager::Yarn),
    ("package-lock.json", PackageManager::Npm),
];

/// Decide what a freshly-cut worktree needs.
///
/// Pure apart from reading directory entries: no subprocess, no network. That is what makes the
/// policy above testable without installing anything.
pub fn plan_for(worktree: &Path) -> BootstrapPlan {
    // Checked FIRST, before `package.json`, because it is the cheap common case: worktree slots get
    // reused and `prepareAgentWorkspace` runs on every agent mount, not only on a fresh cut.
    if worktree.join("node_modules").is_dir() {
        return BootstrapPlan::Skip(SkipReason::AlreadyInstalled);
    }
    if !worktree.join("package.json").is_file() {
        return BootstrapPlan::Skip(SkipReason::NotAJsProject);
    }
    for (name, pm) in LOCKFILES {
        if worktree.join(name).is_file() {
            return BootstrapPlan::Install(*pm);
        }
    }
    BootstrapPlan::Skip(SkipReason::NoLockfile)
}

/// What a bootstrap pass concluded, as it crosses into the frontend.
///
/// `status` is a closed string set rather than an enum-with-payload because it is serialized to TS,
/// and a flat discriminant is what the caller actually switches on when writing a log line.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapOutcome {
    /// `"installed"` | `"skipped"` | `"failed"`.
    pub status: &'static str,
    /// Why it was skipped, or what went wrong. Present for `skipped` and `failed`, `None` for
    /// `installed` — there is nothing to explain about a success.
    pub detail: Option<String>,
    /// The package manager used, when one was.
    pub manager: Option<&'static str>,
}

impl BootstrapOutcome {
    fn skipped(reason: SkipReason) -> Self {
        BootstrapOutcome {
            status: "skipped",
            detail: Some(
                match reason {
                    SkipReason::AlreadyInstalled => "node_modules already present",
                    SkipReason::NotAJsProject => "no package.json — not a JS project",
                    SkipReason::NoLockfile => "package.json but no lockfile; refusing to resolve",
                }
                .to_string(),
            ),
            manager: None,
        }
    }
}

/// Carry out a plan.
///
/// The install itself is injected rather than called directly, which is what lets the policy below
/// be tested without a package manager, a network, or 27 seconds. The production caller passes a
/// closure that spawns the real subprocess.
///
/// NEVER RETURNS `Err` FOR AN INSTALL FAILURE. A failed bootstrap must degrade to exactly the
/// status quo — a worktree without `node_modules`, which is what every worktree had before this
/// module existed — and must not surface as a spawn error. `Err` is reserved for "the pass could
/// not run at all", which the Tauri command maps from a bad path argument.
pub fn execute<F>(plan: BootstrapPlan, run: F) -> BootstrapOutcome
where
    F: FnOnce(PackageManager) -> Result<(), String>,
{
    match plan {
        BootstrapPlan::Skip(reason) => BootstrapOutcome::skipped(reason),
        BootstrapPlan::Install(pm) => match run(pm) {
            Ok(()) => BootstrapOutcome {
                status: "installed",
                detail: None,
                manager: Some(pm.program()),
            },
            // Caught and REPORTED, never propagated. See the contract above.
            Err(e) => BootstrapOutcome {
                status: "failed",
                detail: Some(e),
                manager: Some(pm.program()),
            },
        },
    }
}

/// Turn a login-shell resolution into the program to spawn, or an error that says what is missing.
pub fn program_or_error(
    resolved: Option<String>,
    pm: PackageManager,
) -> Result<String, String> {
    resolved.ok_or_else(|| {
        format!(
            "could not find `{}` on the login-shell PATH; \
             install it (or add it to your shell profile) and reopen the agent",
            pm.program()
        )
    })
}

/// Run the real install for `pm` in `worktree`.
///
/// NOT UNIT-TESTED, and deliberately kept to glue over pieces that are: it resolves a program,
/// spawns it, and maps the exit status. Every decision it could get wrong lives in `plan_for`,
/// `execute`, `install_args` or `program_or_error` above.
///
/// NO TIMEOUT, on purpose. Killing a package manager mid-install leaves a half-written
/// `node_modules` that is worse than no `node_modules` — the next `pnpm install` may consider it
/// satisfied, and the agent then fails in a far more confusing way than "vitest not found". A hung
/// install occupies one blocking thread and nothing else: this never runs on the spawn path (the
/// caller does not await it) and never touches the UI thread.
/// Locate the package manager. Unix form: the login-shell PATH probe.
///
/// A Finder/Dock-launched Sparkle inherits a bare GUI PATH with no nvm, corepack or `~/.local/bin`,
/// so `pnpm` resolves to nothing there while working fine in a terminal. Every other user-scope
/// binary in this app (`claude`, `git`, `gh`, `roborev`, `op`) is resolved the same way.
#[cfg(unix)]
fn resolve_manager(pm: PackageManager) -> Option<String> {
    crate::preflight::run_in_login_shell(&format!("command -v {}", pm.program()))
}

/// Windows form: `where` (GUI apps inherit PATH there).
///
/// This arm is not optional. `run_in_login_shell` is `#[cfg(unix)]`, so calling it unconditionally
/// fails the `windows-latest` `tauri build` in .github/workflows/windows-build.yml with "cannot
/// find function run_in_login_shell". `where` is also the only thing that returns the `.cmd` shim
/// that `Command::new` needs to launch pnpm/npm/yarn on Windows at all.
#[cfg(not(unix))]
fn resolve_manager(pm: PackageManager) -> Option<String> {
    crate::preflight::resolve_on_path(pm.program())
}

fn run_install(worktree: &Path, pm: PackageManager) -> Result<(), String> {
    let program = program_or_error(resolve_manager(pm), pm)?;
    let output = std::process::Command::new(&program)
        .current_dir(worktree)
        .args(pm.install_args())
        // Package managers prompt (`pnpm approve-builds`, npm's audit fix prompts) and will sit
        // forever on a stdin that never closes. CI is the standard "nobody is watching" signal and
        // every one of these respects it.
        .env("CI", "1")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("failed to run {program}: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let msg = if stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        stderr
    };
    // Bounded: a failing install can emit megabytes, and this string ends up in a log line.
    Err(msg.chars().take(600).collect())
}

/// Install a freshly-cut worktree's dependencies so the agent in it can run the repo's tests.
///
/// Best-effort by contract. Resolves with a `status` the caller logs; it does not reject for an
/// install failure, because a worktree that could not install is exactly the worktree everyone had
/// before this command existed. The one `Err` is an unusable path argument.
#[tauri::command]
pub async fn bootstrap_worktree_deps(worktree: String) -> Result<BootstrapOutcome, String> {
    if worktree.trim().is_empty() {
        return Err("bootstrap_worktree_deps: empty worktree path".into());
    }
    let path = PathBuf::from(&worktree);
    if !path.is_dir() {
        return Err(format!("bootstrap_worktree_deps: not a directory: {worktree}"));
    }
    // spawn_blocking: the install is a multi-second synchronous subprocess and must not sit on the
    // async runtime's cooperative threads.
    tauri::async_runtime::spawn_blocking(move || {
        let plan = plan_for(&path);
        execute(plan, |pm| run_install(&path, pm))
    })
    .await
    .map_err(|e| format!("bootstrap_worktree_deps: task panicked: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A temp dir that cleans itself up. The repo has no `tempfile` dependency in this crate, and
    /// adding one to assert five filesystem branches would cost more than it explains.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "sparkle-deps-{}-{}-{:?}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn touch(&self, name: &str) {
            fs::write(self.0.join(name), "{}").unwrap();
        }
        fn mkdir(&self, name: &str) {
            fs::create_dir_all(self.0.join(name)).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_pnpm_worktree_with_no_node_modules_gets_installed() {
        let d = TempDir::new("pnpm");
        d.touch("package.json");
        d.touch("pnpm-lock.yaml");
        assert_eq!(plan_for(d.path()), BootstrapPlan::Install(PackageManager::Pnpm));
    }

    #[test]
    fn an_existing_node_modules_is_left_alone() {
        // The guard that keeps this off the hot path: `prepareAgentWorkspace` runs on every agent
        // mount, and worktree slots are reused, so without this a 27s install would fire every time
        // an agent is opened just to discover there was nothing to do.
        let d = TempDir::new("present");
        d.touch("package.json");
        d.touch("pnpm-lock.yaml");
        d.mkdir("node_modules");
        assert_eq!(
            plan_for(d.path()),
            BootstrapPlan::Skip(SkipReason::AlreadyInstalled)
        );
    }

    #[test]
    fn a_non_js_repo_is_skipped_rather_than_failed() {
        // Sparkle opens agents on Rust/Go/Python repos. Those must be a silent no-op, not a failed
        // `pnpm install` reported as a broken bootstrap.
        let d = TempDir::new("rust");
        d.touch("Cargo.toml");
        assert_eq!(
            plan_for(d.path()),
            BootstrapPlan::Skip(SkipReason::NotAJsProject)
        );
    }

    #[test]
    fn a_package_json_with_no_lockfile_is_refused() {
        // Installing here would resolve a fresh graph and WRITE a lockfile the repo never had —
        // a committable change to someone's repo, produced by a background convenience task that
        // nobody asked for. Refusing is the whole point of this branch.
        let d = TempDir::new("nolock");
        d.touch("package.json");
        assert_eq!(plan_for(d.path()), BootstrapPlan::Skip(SkipReason::NoLockfile));
    }

    #[test]
    fn pnpm_wins_when_a_stale_npm_lockfile_is_still_checked_in() {
        // Migrations run npm/yarn → pnpm and routinely leave the old lockfile behind. Picking the
        // stale one would install a graph that matches neither CI nor the main checkout.
        let d = TempDir::new("both");
        d.touch("package.json");
        d.touch("package-lock.json");
        d.touch("pnpm-lock.yaml");
        assert_eq!(plan_for(d.path()), BootstrapPlan::Install(PackageManager::Pnpm));
    }

    #[test]
    fn a_skip_plan_never_shells_out() {
        // The 27s install must not fire on a worktree that has nothing to do — this is what keeps
        // reopening an agent cheap. Asserted by observing that the injected runner was never
        // called, which is the real behavior, not a mock's call count.
        let mut called = false;
        let outcome = execute(BootstrapPlan::Skip(SkipReason::AlreadyInstalled), |_| {
            called = true;
            Ok(())
        });
        assert!(!called, "a skipped plan must not invoke the package manager");
        assert_eq!(outcome.status, "skipped");
        assert_eq!(outcome.manager, None);
    }

    #[test]
    fn an_install_plan_runs_the_chosen_package_manager() {
        let mut ran_with = None;
        let outcome = execute(BootstrapPlan::Install(PackageManager::Pnpm), |pm| {
            ran_with = Some(pm);
            Ok(())
        });
        assert_eq!(ran_with, Some(PackageManager::Pnpm));
        assert_eq!(outcome.status, "installed");
        assert_eq!(outcome.manager, Some("pnpm"));
    }

    #[test]
    fn a_failed_install_is_reported_not_raised() {
        // The load-bearing property of this whole module: a bootstrap that fails must degrade to
        // the status quo ante — a worktree with no node_modules — and must NEVER become a spawn
        // error. If this regresses, a machine with a broken pnpm stops being able to open agents
        // at all, which is far worse than the gap this module closes.
        let outcome = execute(BootstrapPlan::Install(PackageManager::Pnpm), |_| {
            Err("ERR_PNPM_NO_LOCKFILE".to_string())
        });
        assert_eq!(outcome.status, "failed");
        assert_eq!(outcome.detail.as_deref(), Some("ERR_PNPM_NO_LOCKFILE"));
        assert_eq!(outcome.manager, Some("pnpm"));
    }

    #[test]
    fn an_unresolvable_package_manager_names_the_remedy() {
        // A Finder/Dock-launched Sparkle gets a bare GUI PATH that does NOT include the user's node
        // install (nvm, corepack, ~/.local/bin), so `pnpm` resolves to nothing there while working
        // fine in a terminal. Spawning the bare name in that state fails with a raw ENOENT, which
        // reads as "the bootstrap is broken" rather than "we could not find your pnpm". The error
        // has to name the binary AND say it was the login-shell PATH we looked on.
        let err = program_or_error(None, PackageManager::Pnpm).unwrap_err();
        assert!(err.contains("pnpm"), "must name the binary, got: {err}");
        assert!(
            err.to_lowercase().contains("path"),
            "must say where we looked, got: {err}"
        );
    }

    #[test]
    fn a_resolved_package_manager_is_used_by_absolute_path() {
        // Resolution goes through the login shell precisely so the ABSOLUTE path is what gets
        // spawned; passing the bare name back would throw away the resolution and reintroduce the
        // GUI-PATH failure above.
        let p = program_or_error(Some("/opt/homebrew/bin/pnpm".into()), PackageManager::Pnpm)
            .unwrap();
        assert_eq!(p, "/opt/homebrew/bin/pnpm");
    }

    #[test]
    fn every_install_invocation_respects_the_lockfile() {
        // The property that matters across ALL package managers: a background task must never
        // re-resolve the dependency graph, because that can rewrite the lockfile and surface as an
        // unexplained modification in the agent's first `git status`. Asserted over the whole set so
        // adding a package manager without a lockfile-respecting flag fails here.
        for pm in ALL_MANAGERS {
            let args = pm.install_args();
            assert!(
                args.iter()
                    .any(|a| *a == "--frozen-lockfile" || *a == "--immutable" || *a == "ci"),
                "{:?} install must be lockfile-respecting, got {:?}",
                pm,
                args
            );
        }
    }

    #[test]
    fn no_install_runs_dependency_lifecycle_scripts() {
        // This is a TRUST BOUNDARY, not a preference. `preinstall`/`install`/`postinstall` scripts
        // are arbitrary code from a repo's dependency graph, and this bootstrap fires automatically,
        // in the background, merely because someone OPENED an agent on a project — no prompt, no
        // deliberate action. Before it existed, that code only ran when a human chose to install.
        //
        // `CI=1` does not suppress it. pnpm v10 happens to gate unapproved BUILD scripts by default
        // (the probe install for this feature printed exactly that: "Ignored build scripts:
        // @clerk/shared, core-js, esbuild, sharp, unrs-resolver" — and the suite still ran), but
        // `npm ci`, `yarn install` and `bun install` run root and workspace lifecycle scripts
        // unless told not to, and all three are reachable through LOCKFILES.
        //
        // So every manager is held to pnpm's posture explicitly. A repo that genuinely needs its
        // build scripts gets them when an agent runs the install itself, deliberately.
        for pm in ALL_MANAGERS {
            assert!(
                pm.install_args().contains(&"--ignore-scripts"),
                "{:?} must not run lifecycle scripts from an unattended background install, got {:?}",
                pm,
                pm.install_args()
            );
        }
    }
}
