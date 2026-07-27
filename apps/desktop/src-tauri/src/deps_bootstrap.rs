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

    /// Whether this module will actually DRIVE this manager, as opposed to merely recognising its
    /// lockfile.
    ///
    /// Only pnpm and npm return true, and the reason is a bug this module already shipped once. The
    /// first version drove all four and asserted its trust-boundary property by checking that
    /// `--ignore-scripts` appeared in each arm's argv — an assertion that proves the flag is
    /// PRESENT and says nothing about whether the manager accepts it. Yarn Berry has no
    /// `--ignore-scripts` and rejects unknown options outright, so that arm failed before installing
    /// anything, silently, because the entire path is fire-and-forget.
    ///
    /// pnpm and npm were each run for real against a probe package before their arguments were
    /// written down. Yarn and bun are not installed on the machine this was developed on and could
    /// not be. Re-enabling one means installing it and verifying its actual invocation — reading its
    /// documentation is what produced the bug.
    pub fn is_supported(self) -> bool {
        matches!(self, PackageManager::Pnpm | PackageManager::Npm)
    }

    /// Whether the install leaves the project's OWN lifecycle scripts unrun, given the resolved
    /// major version of the manager.
    ///
    /// True for npm always — it cannot separate "the dependency graph's scripts" from "this
    /// project's", so blocking third-party `postinstall` necessarily blocks the repo's own — and for
    /// pnpm below v10, where `--ignore-scripts` is the only lever available (see `install_args`).
    ///
    /// Surfaced in the outcome because, combined with `plan_for`'s short-circuit on an existing
    /// `node_modules`, a scripts-less tree is cached as bootstrapped forever; a bare "installed"
    /// would give nobody a way to tell why a later `Cannot find module` is happening.
    pub fn skips_project_scripts(self, major: Option<u32>) -> bool {
        self.install_args(major).contains(&"--ignore-scripts")
    }

    /// The install invocation.
    ///
    /// Every one of these is a LOCKFILE-RESPECTING install, never a resolving one. A fresh worktree
    /// is not the place to re-resolve a dependency graph: doing so can produce a tree that differs
    /// from the one CI and the other worktrees use, and — worse — can rewrite the lockfile, which
    /// then shows up as an unexplained modification in the agent's very first `git status`.
    ///
    /// On the trust boundary: the code worth refusing to run unattended is THIRD-PARTY —
    /// `postinstall` from the dependency graph, which nobody reviewed. The project's own scripts are
    /// not an escalation, because the user deliberately opened an agent on this repo and the agent
    /// is about to run its tests and its build regardless.
    ///
    /// `major` is the manager's resolved major version, `None` when it could not be determined. It
    /// is a parameter rather than a probe so this stays a pure function the tests can drive across
    /// every version that changes the answer.
    pub fn install_args(self, major: Option<u32>) -> &'static [&'static str] {
        match self {
            // `--prefer-offline` is what makes this 27s rather than a network round-trip per
            // package: the global store is already warm from the main checkout.
            //
            // The `--ignore-scripts` decision is VERSION-GATED, and that gate is a trust boundary,
            // not a nicety. pnpm **v10** blocks third-party build scripts by default — the probe
            // install printed "Ignored build scripts: @clerk/shared, core-js, esbuild, sharp,
            // unrs-resolver" and the suite still ran — so on v10 the flag would only strip the
            // repo's OWN `prepare`/`postinstall` and, because `plan_for` treats any existing
            // `node_modules` as done, cache a tree that exists and does not work.
            //
            // pnpm 8 and 9 have no such default: they run every `preinstall`/`install`/`postinstall`
            // in the dependency graph. And the version is not ours to assume — `resolve_manager`
            // takes whatever `command -v pnpm` yields, which under a corepack shim is the TARGET
            // REPO'S pinned `packageManager`. Sparkle opens agents on arbitrary repos, so trusting
            // the default would let an untrusted repo pin `pnpm@9` and get arbitrary code execution
            // from someone merely opening an agent on it.
            //
            // An UNKNOWN version is treated as unsafe for the same reason. Failing toward "run less
            // code" costs a repo its own build step, which is visible and recoverable; failing the
            // other way is not.
            PackageManager::Pnpm if major.is_some_and(|m| m >= 10) => {
                &["install", "--frozen-lockfile", "--prefer-offline"]
            }
            PackageManager::Pnpm => {
                &["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"]
            }
            // npm has no equivalent of pnpm's default gate, so blocking third-party scripts
            // necessarily blocks the project's own too. Taken deliberately and REPORTED — see
            // `skips_project_scripts`.
            PackageManager::Npm => &["ci", "--prefer-offline", "--ignore-scripts"],
            // Not driven — see `is_supported`. `plan_for` turns these into a Skip before any of
            // this is reached; the arm exists so the match stays exhaustive if that ever changes.
            PackageManager::Yarn | PackageManager::Bun => &[],
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
    /// The repo's lockfile names a manager this module does not drive (see
    /// `PackageManager::is_supported`). Recognised so the log can say WHICH one, rather than
    /// reporting the repo as having no lockfile at all.
    UnsupportedManager(PackageManager),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapPlan {
    Skip(SkipReason),
    Install(PackageManager),
}

/// Every manager this module knows about. Iterated by the tests that assert a property must hold
/// for ALL of them, so adding a variant without satisfying those properties fails rather than
/// slipping through an enumeration someone forgot to extend.
#[cfg(test)]
const ALL_MANAGERS: [PackageManager; 4] = [
    PackageManager::Pnpm,
    PackageManager::Npm,
    PackageManager::Yarn,
    PackageManager::Bun,
];

/// Lockfile → package manager, in the order they are checked.
///
/// Order is load-bearing when a repo carries more than one, which happens after a migration leaves
/// the old lockfile behind. pnpm is first because that is the direction migrations run in practice
/// (npm/yarn → pnpm), so the newest lockfile is the one earliest in this list.
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
            return if pm.is_supported() {
                BootstrapPlan::Install(*pm)
            } else {
                // Recognised but not driven. Reported as its own reason rather than as NoLockfile,
                // because "we don't drive yarn" and "this repo has no lockfile" call for completely
                // different follow-ups.
                BootstrapPlan::Skip(SkipReason::UnsupportedManager(*pm))
            };
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
    /// Why it was skipped, what went wrong, or what a success did NOT do.
    ///
    /// Present for `skipped` and `failed`, and also for an `installed` that could not run the
    /// project's own lifecycle scripts — a success with a caveat is not the same success, and
    /// `plan_for` will treat the resulting `node_modules` as done forever either way. Every branch
    /// that sets this is read by `depsBootstrap.ts`; a detail nothing logs is not a feature.
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
                    SkipReason::AlreadyInstalled => {
                        "node_modules already present".to_string()
                    }
                    SkipReason::NotAJsProject => {
                        "no package.json — not a JS project".to_string()
                    }
                    SkipReason::NoLockfile => {
                        "package.json but no lockfile; refusing to resolve".to_string()
                    }
                    SkipReason::UnsupportedManager(pm) => format!(
                        "this repo uses {}, which Sparkle does not install unattended; \
                         run the install yourself in this worktree",
                        pm.program()
                    ),
                },
            ),
            // Named even though nothing ran, so the log can say WHICH manager went undriven.
            manager: match reason {
                SkipReason::UnsupportedManager(pm) => Some(pm.program()),
                _ => None,
            },
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
/// The runner reports back the manager's resolved major version (`None` if it could not be read),
/// because that is what decides whether the install ran the project's own scripts — and therefore
/// what the outcome has to disclose.
pub fn execute<F>(plan: BootstrapPlan, run: F) -> BootstrapOutcome
where
    F: FnOnce(PackageManager) -> Result<Option<u32>, String>,
{
    match plan {
        BootstrapPlan::Skip(reason) => BootstrapOutcome::skipped(reason),
        BootstrapPlan::Install(pm) => match run(pm) {
            Ok(major) => BootstrapOutcome {
                status: "installed",
                // A success that skipped the project's own lifecycle scripts is NOT the same
                // success as one that ran them, and `plan_for` will treat the resulting
                // `node_modules` as done forever. Saying so here is the only thing standing
                // between that and an unexplained `Cannot find module` later.
                detail: pm.skips_project_scripts(major).then(|| {
                    "lifecycle scripts were not run; if this project needs a build step, \
                     run the install yourself in this worktree"
                        .to_string()
                }),
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

/// Pull the major version out of a `--version` line.
///
/// Pure, and separated from the spawn precisely so it can be tested: this parse is what decides the
/// trust posture — `Some(10)` omits `--ignore-scripts`, everything else adds it — and it was the
/// only logic on that path with no test behind it.
///
/// Anything not confidently a version number returns `None`, which callers treat as unsafe. A
/// corepack shim that prints a download banner before the number must NOT be read as a version;
/// misreading one is how the gate reopens.
fn parse_major(version_output: &str) -> Option<u32> {
    version_output
        .trim()
        // `pnpm --version` prints a bare "10.7.1"; tolerate a leading "v".
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// Read the manager's major version by running `<program> --version` **in the worktree**.
///
/// The working directory is load-bearing, not incidental. Under a corepack shim — the exact threat
/// this version check exists for — the pnpm behind the shim is resolved from the `packageManager`
/// field of the nearest `package.json` walking up from the CURRENT DIRECTORY, not from the shim's
/// own path. Probing in Sparkle's CWD therefore reads a different pnpm than the one that will
/// install: Sparkle running where corepack resolves v10 probes `10`, drops `--ignore-scripts`, and
/// then installs in a worktree where the target repo pins `pnpm@9` — running every third-party
/// `preinstall`/`install`/`postinstall` in the graph, with the outcome reporting no caveat because
/// the probe said v10. That is the whole hole this check was added to close.
///
/// `CI` is set for the same reason it is set on the install: without it the probe can hit an
/// interactive corepack download prompt the install would never see, and hang on it.
///
/// Returns `None` on any doubt — a failed spawn, a non-zero exit, or unparseable output — so a
/// garbled probe costs a repo its build step rather than opening the gate.
fn major_version(worktree: &Path, program: &str) -> Option<u32> {
    let out = std::process::Command::new(program)
        .arg("--version")
        .current_dir(worktree)
        .env("CI", "1")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    parse_major(&String::from_utf8_lossy(&out.stdout))
}

/// Run the real install for `pm` in `worktree`.
///
/// NOT UNIT-TESTED, and deliberately kept to glue over pieces that are: it resolves a program,
/// spawns it, and maps the exit status. Every decision it could get wrong lives in `plan_for`,
/// `execute`, `install_args`, `program_or_error` or `parse_major` above.
///
/// NO TIMEOUT, on purpose. Killing a package manager mid-install leaves a half-written
/// `node_modules` that is worse than no `node_modules` — the next `pnpm install` may consider it
/// satisfied, and the agent then fails in a far more confusing way than "vitest not found". A hung
/// install occupies one blocking thread and nothing else: this never runs on the spawn path (the
/// caller does not await it) and never touches the UI thread. The same holds for the version probe
/// below it, which under corepack may fetch a pinned manager before answering.
fn run_install(worktree: &Path, pm: PackageManager) -> Result<Option<u32>, String> {
    let program = program_or_error(resolve_manager(pm), pm)?;
    // Probed BEFORE the install because it decides the argv (see `install_args`), and probed IN THE
    // WORKTREE so it reads the same manager the install will use.
    let major = major_version(worktree, &program);
    let output = std::process::Command::new(&program)
        .current_dir(worktree)
        .args(pm.install_args(major))
        // Package managers prompt (`pnpm approve-builds`, npm's audit fix prompts) and will sit
        // forever on a stdin that never closes. CI is the standard "nobody is watching" signal and
        // every one of these respects it.
        .env("CI", "1")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("failed to run {program}: {e}"))?;
    if output.status.success() {
        return Ok(major);
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
            Ok(None)
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
            Ok(None)
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
        // Only the managers actually driven — an unsupported one never reaches `run_install`, so it
        // carries no argv to constrain. Scoped by `is_supported` rather than by naming pnpm and npm,
        // so re-enabling a manager automatically brings it under this assertion.
        for pm in ALL_MANAGERS.into_iter().filter(|p| p.is_supported()) {
            let args = pm.install_args(None);
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
    fn only_managers_whose_flags_were_actually_verified_are_driven() {
        // The previous version of this module drove all four managers and asserted the trust-boundary
        // property by checking that `--ignore-scripts` appeared in each arm's argv. That assertion
        // was worthless in the one way that mattered: it proved the flag was PRESENT, never that the
        // manager ACCEPTS it. Yarn Berry has no `--ignore-scripts` — its `install` option set is
        // `--immutable`, `--mode=…`, etc. — and Berry rejects unknown options outright, so that arm
        // failed before installing anything, silently, because the whole path is fire-and-forget and
        // the failure only reaches a `console.warn`.
        //
        // Only pnpm and npm are installed on the machine this was developed on, and both arms were
        // run for real against a probe package before being written down. Yarn and bun could not be,
        // and guessing a flag is precisely what broke yarn. So they are DETECTED (so the log can say
        // what the repo uses) but not driven. Adding one back means installing it and verifying its
        // real invocation — not reading its docs.
        for pm in ALL_MANAGERS {
            assert_eq!(
                pm.is_supported(),
                matches!(pm, PackageManager::Pnpm | PackageManager::Npm),
                "{pm:?}: a manager is only driven once its actual invocation has been verified"
            );
        }
    }

    #[test]
    fn an_unverified_manager_is_skipped_rather_than_run_blind() {
        let d = TempDir::new("yarn");
        d.touch("package.json");
        d.touch("yarn.lock");
        assert_eq!(
            plan_for(d.path()),
            BootstrapPlan::Skip(SkipReason::UnsupportedManager(PackageManager::Yarn))
        );
    }

    #[test]
    fn the_version_parse_reads_real_output_and_doubts_everything_else() {
        // This parse decides the trust posture — `Some(10)` omits `--ignore-scripts`, anything else
        // adds it — and it was the only untested logic on that path. Every ambiguous input must come
        // back `None`, because `None` is the safe answer.
        assert_eq!(parse_major("10.7.1"), Some(10)); // pnpm
        assert_eq!(parse_major("11.17.0\n"), Some(11)); // npm, with the trailing newline
        assert_eq!(parse_major("v9.1.0"), Some(9)); // tolerate a leading v
        assert_eq!(parse_major("  10.7.1  "), Some(10)); // and surrounding whitespace

        assert_eq!(parse_major(""), None);
        assert_eq!(parse_major("not a version"), None);
        // A corepack shim that prints a banner before the number, or any other unexpected shape,
        // must not be read as a version — misreading one is what reopens the hole.
        assert_eq!(parse_major("Downloading pnpm@9.1.0\n9.1.0"), None);
        assert_eq!(parse_major("."), None);
    }

    #[test]
    fn pnpm_below_v10_is_not_trusted_to_gate_dependency_scripts() {
        // The default gate on third-party build scripts is a pnpm **v10** behaviour. On pnpm 8/9,
        // `pnpm install` runs every `preinstall`/`install`/`postinstall` in the dependency graph.
        //
        // That matters more here than it would anywhere else, because `resolve_manager` takes
        // whatever `command -v pnpm` yields — and under a corepack shim that resolves to the TARGET
        // REPO'S pinned `packageManager` version. Sparkle opens agents on arbitrary repos, so
        // without this check an untrusted repo picks the pnpm that decides whether its own
        // dependencies' scripts run: pin `pnpm@9`, and merely opening an agent executes arbitrary
        // code. Relying on an unverified default is not a trust boundary.
        for major in [None, Some(8), Some(9)] {
            assert!(
                PackageManager::Pnpm.install_args(major).contains(&"--ignore-scripts"),
                "pnpm {major:?} does not gate dependency scripts by default — it must be told to"
            );
            assert!(PackageManager::Pnpm.skips_project_scripts(major));
        }
    }

    #[test]
    fn pnpm_relies_on_its_own_default_rather_than_ignore_scripts() {
        // The trust boundary worth defending is THIRD-PARTY code: `postinstall` from the dependency
        // graph, which nobody reviewed. pnpm v10 already gates exactly that by default — the probe
        // install printed "Ignored build scripts: @clerk/shared, core-js, esbuild, sharp,
        // unrs-resolver" and the suite still ran.
        //
        // What pnpm still runs is the PROJECT'S OWN `prepare`/`postinstall`, and that is correct to
        // keep: the user deliberately opened an agent on this repo, and the agent is about to run
        // its tests and its build anyway, so the repo's own scripts are not an escalation. Adding
        // `--ignore-scripts` here would have STRICTLY REDUCED the posture rather than made it
        // explicit, and — because `plan_for` short-circuits on an existing `node_modules` — it would
        // have cached a half-provisioned tree forever for any repo with a root `prepare` step. That
        // fails as `Cannot find module …`, which is worse than the clean `vitest: command not found`
        // this module exists to fix.
        assert!(
            !PackageManager::Pnpm.install_args(Some(10)).contains(&"--ignore-scripts"),
            "pnpm v10's default already gates dependency build scripts; the flag only removes the \
             project's own, which risks caching a half-provisioned worktree"
        );
        assert!(!PackageManager::Pnpm.skips_project_scripts(Some(10)));
    }

    #[test]
    fn npm_blocks_dependency_scripts_and_says_so() {
        // npm has no way to separate "the dependency graph's scripts" from "this project's", so
        // blocking third-party `postinstall` necessarily blocks the project's too. That trade is
        // taken deliberately, but it must not be SILENT: combined with the `AlreadyInstalled`
        // short-circuit it can leave a tree that exists and does not work, and an outcome that
        // just says "installed" gives no way to tell.
        assert!(PackageManager::Npm.install_args(None).contains(&"--ignore-scripts"));
        let outcome = execute(BootstrapPlan::Install(PackageManager::Npm), |_| Ok(None));
        assert_eq!(outcome.status, "installed");
        let detail = outcome.detail.unwrap_or_default();
        assert!(
            detail.contains("script"),
            "an install that skipped lifecycle scripts must say so, got: {detail:?}"
        );
    }
}
