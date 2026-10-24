// goal_landed_probe — the ON-DEMAND git answer to "is THIS agent's work on origin/<default>?".
//
// ── WHY A SECOND READER EXISTS AT ALL ────────────────────────────────────────────────────────────
// The frontend already answers this question, in `services/agentGoalReading.landedEvidenceFor`, and
// that reader is deliberately window-local: it reads already-polled store state and shells nothing,
// because `handleGetState` calls it for EVERY agent on a call orchestrators make routinely. That
// contract is load-bearing and is NOT weakened by this module.
//
// But it has a population it can never answer for. `runtimeStore.branchStatus` has exactly ONE
// writer — a MOUNTED AgentPane — and panes mount lazily per project. So for an agent whose pane is
// not mounted in this window (or right after a relaunch, or in a second window), `landedEvidenceFor`
// returns `undefined` FOREVER, `canSelfMarkMet` fails closed on it, and the refusal's own remedy
// ("retry after the next branch poll") never arrives because nothing is polling that agent. The
// measured cost is an agent whose work is provably merged being refused `set_agent_goal_met`, then
// auto-resumed until it escalates a false alarm to a human — beads sparkle-h3wqm, sparkle-ayj8oe,
// sparkle-k2ocyl, sparkle-e0f34k, sparkle-4s07tm, sparkle-3d4ouj, sparkle-ch57hz, sparkle-28ifhw,
// sparkle-aqd0xp, sparkle-v22kuv, sparkle-fiyfrn.
//
// This command is the fallback for that ONE seam: `set_agent_goal_met`, which is one call about one
// agent, made by an agent that believes it has finished. It can afford a few subprocesses; the
// roster hot path still must not, and does not call this.
//
// ── FIVE RULES THIS PROBE OWES ITS CALLER ────────────────────────────────────────────────────────
//  1. RESOLVE THE BRANCH FROM THE WORKTREE'S OWN HEAD, never by reconstructing a name like
//     `sparkle/agent-<id>`. Name-derived resolution is a separate live defect (beads sparkle-9vptk0
//     / sparkle-t58ekc) owned elsewhere; asking git for `HEAD` in the agent's own worktree is
//     correct independently of it, and it also survives an agent that renamed or moved its branch.
//  2. COMPARE AGAINST `refs/remotes/origin/<default>`, NEVER the local `<default>` ref. No agent
//     worktree ever updates its local `main`, so a local comparison reports "not landed" for work
//     that merged hours ago — the repo's own AGENTS.md records this (bead sparkle-ch57hz), and it
//     is the single most common way this answer comes back a lie.
//  3. REFRESH THAT REF FIRST, and let the refresh's outcome bound what a NEGATIVE may claim. A
//     merged PR deletes the remote topic branch (bead sparkle-28ifhw), so the topic branch's own
//     remote ref is deliberately NOT part of the proof — only ancestry into origin/<default> is.
//  4. ANCESTRY, not a commit count and not a PR state: `git merge-base --is-ancestor <head>
//     origin/<default>`. That is squash-safe in the direction that matters here (a merge commit
//     keeps the tip reachable) and it is the same proof the rest of this app uses.
//  5. FAIL CLOSED TO `None`, never to `Some(false)`. An unreadable git is not a yes — and it is
//     also not a no. `Some(false)` makes the caller emit "git says it is not on origin/main yet",
//     which is exactly the sentence these beads were filed about; `None` keeps the honest "nothing
//     has read your branch yet" copy.
//
// ── THE NEW-WORK VETO IS SATISFIED BY ANCESTRY ALONE ─────────────────────────────────────────────
// `landedEvidenceFor` carries an explicit veto: an agent that landed PR #1 and has since written
// unlanded commits must still be refused. That veto exists there because its positive half is a
// MONOTONIC WATERMARK (`workflowShipped`), which stays true across a new cycle of work.
//
// This probe has no watermark. Its positive answer IS "the worktree's CURRENT HEAD is reachable from
// origin/<default>", and if HEAD is an ancestor there are by definition ZERO commits on this branch
// that origin/<default> lacks — the first new commit moves HEAD off the ancestor set and the answer
// flips to `false` on its own. So do NOT "restore" a redundant ahead-count veto here: it could only
// ever subtract from an answer that is already exact, and an extra git call on this path is a
// second thing that can fail closed and re-open the escalation loop above.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

use crate::worktree::{output_with_timeout, resolve_default_branch, validate_ref};

/// Wall-clock bound for the local, no-network git calls (`rev-parse`, `merge-base`).
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Wall-clock bound for the ONE network call (`fetch`). A partition must not hold the agent's
/// `set_agent_goal_met` open; an expiry here degrades the answer, it does not fail the call.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// The probe's tri-state answer plus a human-readable reason.
///
/// `landed` is `Option<bool>` and crosses the wire as `true` / `false` / **`null`** — serde emits
/// the key with a null value for `None`, it does not omit it. The TypeScript side must therefore
/// spell the field `boolean | null`, never `boolean | undefined` (a whole feature has shipped inert
/// in this repo on exactly that mismatch — bead sparkle-16y6h).
///
/// `reason` is for logs and for the test suite; nothing user-facing renders it, so it is free to
/// name paths and git exit codes.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LandedProbe {
    /// `Some(true)` HEAD is reachable from origin/<default>; `Some(false)` it provably is not;
    /// `None` we could not tell — which the caller must NOT render as a negative.
    pub landed: Option<bool>,
    pub reason: String,
    /// The branch the worktree has CHECKED OUT (`rev-parse --abbrev-ref HEAD`), or `None` when HEAD
    /// is detached or unreadable. Reported so a refusal can NAME what was measured (bead
    /// sparkle-q4r8z2) — never used to resolve anything: rule 1 reads HEAD, not a name.
    pub branch: Option<String>,
    /// The sha HEAD resolved to — the LEFT side of the ancestry comparison.
    pub head_sha: Option<String>,
    /// The fully-qualified ref compared against, e.g. `refs/remotes/origin/main`.
    pub base_ref: Option<String>,
    /// The sha that ref resolved to AFTER the refresh — the RIGHT side of the comparison.
    pub base_sha: Option<String>,
    /// Did a commit AUTHORED IN THIS WORKTREE reach origin/<default>? Read from the worktree's own
    /// HEAD reflog — see [`authored_commit_landed`] for why ancestry alone cannot answer it.
    /// `Some(true)` one did; `Some(false)` the reflog was read and none did (or none exists);
    /// `None` it was not asked (the probe bailed earlier) or could not be read.
    pub authored_landed: Option<bool>,
    /// Committer time (unix SECONDS) of the newest authored commit found on origin/<default>, when
    /// `authored_landed` is `Some(true)`. Lets a caller refuse to credit a goal with work that
    /// landed BEFORE the goal was set — a re-tasked agent whose HEAD still sits on its previous,
    /// merged work satisfies both ancestry and `authored_landed` without having done the new task.
    pub authored_landed_at: Option<i64>,
}

impl LandedProbe {
    fn unknown(reason: impl Into<String>) -> Self {
        Self {
            landed: None,
            reason: reason.into(),
            branch: None,
            head_sha: None,
            base_ref: None,
            base_sha: None,
            authored_landed: None,
            authored_landed_at: None,
        }
    }
    fn with_landed(mut self, landed: Option<bool>) -> Self {
        self.landed = landed;
        self
    }
}

/// Reflog subjects that record a commit CREATED in this worktree, as opposed to HEAD merely moving
/// onto one someone else made (`checkout:`, `reset:`, `pull: Fast-forward`, `merge …: Fast-forward`,
/// `rebase (start)` / `(finish)`). A rebase's `(pick)` / `(reword)` / `(squash)` / `(fixup)` /
/// `(edit)` / `(continue)` entries write NEW commits carrying the agent's own changes, so they count.
fn reflog_subject_is_authored(subject: &str) -> bool {
    let s = subject.trim_start();
    if s.starts_with("commit") || s.starts_with("cherry-pick") || s.starts_with("revert") {
        return true;
    }
    if s.starts_with("rebase") {
        return ["(pick)", "(reword)", "(squash)", "(fixup)", "(edit)", "(continue)"]
            .iter()
            .any(|m| s.contains(m));
    }
    false
}

/// How many distinct authored shas to test for ancestry. Newest first, short-circuiting on the first
/// hit, so the common landed case costs ONE `merge-base`; the cap bounds the unlanded case.
const AUTHORED_SCAN_MAX: usize = 25;

/// DID A COMMIT THIS WORKTREE AUTHORED REACH `remote_ref`? — the no-op guard ancestry cannot carry.
///
/// Ancestry of HEAD is satisfied TRIVIALLY by a branch that authored nothing (its HEAD *is* the
/// ancestor), so the TS caller refuses a probe `true` unless it can also prove work exists. Its only
/// other proof, `committedWorkSeen`, reads the WINDOW-LOCAL workflow state, which is resolved by the
/// NAME `sparkle/agent-<id>` in the project root (beads sparkle-t58ekc / sparkle-9vptk0) and which a
/// merged-then-deleted branch drives back to a bare cut's values — `ahead` 0, `pushed` false, no PR
/// (bead sparkle-28ifhw). So exactly the agents whose work provably landed were refused
/// `git-probe-unproven`.
///
/// The worktree's OWN `HEAD` reflog answers it from git alone: a linked worktree keeps a private HEAD
/// log, every `git commit` made there appends a `commit…` entry naming the new sha, and if any such
/// sha is an ancestor of origin/<default> then work AUTHORED HERE is on origin/<default>. That is
/// strictly stronger than "work exists": a commit made and then `reset` away is not an ancestor and
/// proves nothing. A SQUASH landing leaves no authored sha reachable, so it answers `Some(false)` —
/// the same population the caller already routes to the concierge.
fn authored_commit_landed(wt: &Path, remote_ref: &str) -> Option<(bool, Option<i64>)> {
    let out = git_output(wt, &["log", "-g", "--format=%H%x09%ct%x09%gs", "HEAD"], PROBE_TIMEOUT).ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut seen: Vec<&str> = Vec::new();
    for line in text.lines() {
        let mut fields = line.splitn(3, '\t');
        let (Some(sha), Some(ct), Some(subject)) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let sha = sha.trim();
        if sha.is_empty() || !reflog_subject_is_authored(subject) || seen.contains(&sha) {
            continue;
        }
        seen.push(sha);
        if seen.len() > AUTHORED_SCAN_MAX {
            break;
        }
        match git_output(wt, &["merge-base", "--is-ancestor", sha, remote_ref], PROBE_TIMEOUT) {
            Ok(o) if o.status.success() => return Some((true, ct.trim().parse::<i64>().ok())),
            Ok(o) if o.status.code() == Some(1) => continue,
            // A sha the object store no longer holds (gc'd after a reset) is not an answer either
            // way; skip it rather than failing the whole read.
            Ok(_) => continue,
            Err(_) => return None,
        }
    }
    Some((false, None))
}

fn stdout_line(cwd: &Path, args: &[&str]) -> Option<String> {
    match git_output(cwd, args, PROBE_TIMEOUT) {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            (!s.is_empty()).then_some(s)
        }
        _ => None,
    }
}

/// `git -C <cwd> <args…>` with the same non-interactive env every other git caller in this crate
/// uses (no credential prompt, no host-key prompt, no pager) and a hard wall-clock bound.
///
/// Returns the raw `Output` rather than a `Result<String, _>` on purpose: this module's whole job is
/// to read an EXIT STATUS (`merge-base --is-ancestor` answers in exit codes 0/1, and 1 is an answer
/// while anything else is a failure to ask). A helper that collapsed non-zero into `Err` would make
/// those two indistinguishable, which is rule 5 above, violated.
fn git_output(cwd: &Path, args: &[&str], timeout: Duration) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(crate::preflight::git_program());
    cmd.arg("-C").arg(cwd).args(args);
    // The ONE shared definition (git/gh non-interactive env + pager).
    crate::claude_oneshot::apply_noninteractive(&mut cmd);
    output_with_timeout(cmd, timeout)
}

fn ok_status(cwd: &Path, args: &[&str], timeout: Duration) -> bool {
    matches!(git_output(cwd, args, timeout), Ok(o) if o.status.success())
}

/// The whole probe, synchronous and testable. `worktree` is the agent's OWN worktree; `root` is the
/// project's main checkout, used only to resolve the default branch NAME.
///
/// ⚠️ `root` IS NOT OPTIONAL, and that is a correctness requirement rather than an ergonomic one.
/// `resolve_default_branch` falls through, as its LAST resort, to "the branch currently checked out
/// at the path you gave me". Handed an agent worktree that is exactly the agent's own branch — so
/// the comparison would become `HEAD` against `origin/<the agent's own branch>`, which answers
/// "have I pushed?" while claiming to answer "have I landed?". An empty `root` therefore declines.
pub fn landed_probe_in(worktree: &str, root: &str) -> LandedProbe {
    let wt_str = worktree.trim();
    if wt_str.is_empty() {
        return LandedProbe::unknown("no worktree path is recorded for this agent");
    }
    if root.trim().is_empty() {
        // See the doc comment: without the project root the default-branch resolver can degrade to
        // the agent's own branch, and a probe that silently answers a different question is worse
        // than one that declines.
        return LandedProbe::unknown("no project root supplied, so the default branch is unknown");
    }
    let wt = Path::new(wt_str);
    if !wt.is_dir() {
        return LandedProbe::unknown(format!("worktree {wt_str} is not a directory"));
    }

    // RULE 1 — the branch is whatever this worktree's HEAD actually is. No name reconstruction.
    let head = match git_output(wt, &["rev-parse", "HEAD"], PROBE_TIMEOUT) {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Ok(_) => return LandedProbe::unknown("git could not resolve HEAD in this worktree"),
        Err(e) => return LandedProbe::unknown(format!("git rev-parse HEAD failed: {e}")),
    };
    if head.is_empty() {
        return LandedProbe::unknown("git returned an empty HEAD sha");
    }
    // Reported, never resolved through: `HEAD` (detached) carries no branch name worth printing.
    let branch = stdout_line(wt, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD");

    let default = resolve_default_branch(root);
    if let Err(e) = validate_ref(&default) {
        return LandedProbe::unknown(format!("resolved default branch is not a usable ref: {e}"));
    }
    // RULE 2 — the FULLY QUALIFIED remote-tracking ref. Spelled out rather than left as
    // `origin/<default>` so a local branch literally named `origin/main` cannot shadow it, and so
    // the local `<default>` ref — which no agent worktree ever updates — can never be what we
    // compared against by accident.
    let remote_ref = format!("refs/remotes/origin/{default}");

    // RULE 3 — refresh, and REMEMBER WHETHER IT WORKED. A fetch failure is not fatal (a stale ref
    // can still PROVE a landing: ancestry into an older origin/<default> implies ancestry into
    // every descendant of it), but it does forbid a NEGATIVE — "not an ancestor of a ref I could
    // not refresh" is precisely the stale reading that told finished agents to go land merged work.
    let fetched = ok_status(wt, &["fetch", "--quiet", "origin", &default], FETCH_TIMEOUT);

    let Some(base_sha) = stdout_line(wt, &["rev-parse", "--verify", "--quiet", &remote_ref]) else {
        let mut p = LandedProbe::unknown(format!(
            "{remote_ref} does not exist in this worktree, so there is nothing to compare against"
        ));
        p.branch = branch;
        p.head_sha = Some(head);
        return p;
    };

    // Everything a refusal needs to NAME what was compared (bead sparkle-q4r8z2) is known from here
    // on, whatever the verdict — so every return below carries it.
    let mut probe = LandedProbe {
        landed: None,
        reason: String::new(),
        branch,
        head_sha: Some(head.clone()),
        base_ref: Some(remote_ref.clone()),
        base_sha: Some(base_sha.clone()),
        authored_landed: None,
        authored_landed_at: None,
    };

    // RULE 4 — ancestry. Exit 0 = yes, exit 1 = no, anything else = we failed to ask.
    match git_output(wt, &["merge-base", "--is-ancestor", &head, &remote_ref], PROBE_TIMEOUT) {
        Ok(o) if o.status.success() => {
            // Only a POSITIVE needs the authored-work proof: a negative can only refuse.
            if let Some((hit, at)) = authored_commit_landed(wt, &remote_ref) {
                probe.authored_landed = Some(hit);
                probe.authored_landed_at = at;
            }
            probe.reason = format!("{head} is an ancestor of {remote_ref} ({base_sha})");
            probe.with_landed(Some(true))
        }
        Ok(o) if o.status.code() == Some(1) => {
            if fetched {
                probe.reason = format!("{head} is not an ancestor of {remote_ref} ({base_sha})");
                probe.with_landed(Some(false))
            } else {
                // RULE 5 — degrade a negative to "unknown" when the ref behind it is stale.
                probe.reason = format!(
                    "{head} is not an ancestor of {remote_ref} ({base_sha}), but the fetch that \
                     would have refreshed that ref failed — so this is a stale reading, not a no"
                );
                probe
            }
        }
        Ok(o) => {
            probe.reason = format!(
                "git merge-base --is-ancestor exited {:?}, which is a failure to ask rather than a no",
                o.status.code()
            );
            probe
        }
        Err(e) => {
            probe.reason = format!("git merge-base --is-ancestor failed: {e}");
            probe
        }
    }
}

/// One agent, one question, on demand. See this module's header for why the roster's window-local
/// reader is kept and this is used ONLY at the `set_agent_goal_met` seam.
///
/// `spawn_blocking` because it shells several git subprocesses including one network fetch, and a
/// synchronous `#[tauri::command]` body runs on the MAIN thread — which would stall the whole UI for
/// the duration.
#[tauri::command]
pub async fn agent_landed_probe(worktree: String, root: String) -> Result<LandedProbe, String> {
    tauri::async_runtime::spawn_blocking(move || landed_probe_in(&worktree, &root))
        .await
        .map_err(|e| format!("agent_landed_probe task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    /// Run git in a FIXTURE repo with the developer's global/system config removed.
    ///
    /// `GIT_CONFIG_GLOBAL=/dev/null` is not tidiness: this repo's own workflow installs a global
    /// `core.hooksPath` (the roborev review loop), and without this every fixture commit below fires
    /// those hooks and enqueues a review against a temp directory that is deleted seconds later.
    fn fx(cwd: &Path, args: &[&str]) -> std::process::Output {
        let out = Command::new(crate::preflight::git_program())
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        out
    }

    fn write(p: &Path, name: &str, body: &str) {
        std::fs::write(p.join(name), body).expect("write");
    }

    struct Fixture {
        dir: PathBuf,
        upstream: PathBuf,
        clone: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A BARE `upstream` whose HEAD is `main`, and a `clone` of it sitting on `main`.
    ///
    /// ⚠️ THE UPSTREAM MUST BE BARE. The first cut of this fixture used a non-bare upstream and
    /// parked it on a scratch branch so pushes to `main` would be accepted — which moved that
    /// repo's HEAD, and modern git then copies the remote's HEAD into `refs/remotes/origin/HEAD` on
    /// fetch. `resolve_default_branch` reads that symref FIRST, so every probe below silently
    /// compared against `origin/parked`. Two tests still went the colour they expected, for entirely
    /// the wrong reason — which is why the assertions now pin the REF NAME as well as the verdict.
    fn fixture(tag: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!("sparkle-landed-probe-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let upstream = dir.join("upstream");
        let clone = dir.join("clone");
        std::fs::create_dir_all(&upstream).expect("mkdir");
        fx(&upstream, &["init", "--bare", "--initial-branch=main", "."]);

        std::fs::create_dir_all(&clone).expect("mkdir");
        fx(&clone, &["init", "--initial-branch=main", "."]);
        fx(&clone, &["remote", "add", "origin", upstream.to_str().unwrap()]);
        write(&clone, "a.txt", "one\n");
        fx(&clone, &["add", "."]);
        fx(&clone, &["commit", "-m", "one"]);
        fx(&clone, &["push", "-q", "-u", "origin", "main"]);
        Fixture { dir, upstream, clone }
    }

    /// Every positive/negative case asserts this too. The verdict alone cannot distinguish "compared
    /// against origin/main" from "compared against whatever the default resolver happened to pick",
    /// and the fixture bug above proved that is not a hypothetical.
    fn assert_compared_against_origin_main(p: &LandedProbe) {
        assert!(
            p.reason.contains("refs/remotes/origin/main"),
            "probe did not compare against origin/main: {}",
            p.reason
        );
    }

    #[test]
    fn head_reachable_from_origin_default_answers_yes() {
        let f = fixture("yes");
        let p = landed_probe_in(f.clone.to_str().unwrap(), f.clone.to_str().unwrap());
        assert_eq!(p.landed, Some(true), "reason: {}", p.reason);
        assert_compared_against_origin_main(&p);
    }

    #[test]
    fn a_commit_origin_lacks_answers_no() {
        let f = fixture("no");
        fx(&f.clone, &["checkout", "-q", "-b", "topic"]);
        write(&f.clone, "b.txt", "two\n");
        fx(&f.clone, &["add", "."]);
        fx(&f.clone, &["commit", "-m", "two"]);
        let p = landed_probe_in(f.clone.to_str().unwrap(), f.clone.to_str().unwrap());
        assert_eq!(p.landed, Some(false), "reason: {}", p.reason);
        assert_compared_against_origin_main(&p);
    }

    /// THE CASE THE BEADS ARE ABOUT: the topic branch MERGED and its remote head was then deleted,
    /// which is GitHub's default. Every name-derived or remote-topic-ref-derived reading goes blind
    /// here; ancestry into origin/main still answers.
    #[test]
    fn merged_then_remote_topic_branch_deleted_still_answers_yes() {
        let f = fixture("merged");
        fx(&f.clone, &["checkout", "-q", "-b", "topic"]);
        write(&f.clone, "b.txt", "two\n");
        fx(&f.clone, &["add", "."]);
        fx(&f.clone, &["commit", "-m", "two"]);
        // Land it upstream, and never push the topic branch itself.
        fx(&f.clone, &["push", "-q", "origin", "topic:main"]);
        // The worktree still sits on `topic`, whose remote ref does not exist at all.
        let p = landed_probe_in(f.clone.to_str().unwrap(), f.clone.to_str().unwrap());
        assert_eq!(p.landed, Some(true), "reason: {}", p.reason);
        assert_compared_against_origin_main(&p);
    }

    fn rev(cwd: &Path, r: &str) -> String {
        String::from_utf8_lossy(&fx(cwd, &["rev-parse", r]).stdout).trim().to_string()
    }

    /// A LINKED worktree cut from origin/main on branch `name` — the shape every agent runs in. Its
    /// HEAD reflog is PRIVATE to it, which is what `authored_commit_landed` reads; the fixture's
    /// main clone holds the `commit (initial)` entry and must not be the tree under test.
    fn linked_worktree(f: &Fixture, name: &str) -> PathBuf {
        let wt = f.dir.join(format!("wt-{name}"));
        fx(&f.clone, &["fetch", "-q", "origin"]);
        fx(&f.clone, &["worktree", "add", "-q", "-b", name, wt.to_str().unwrap(), "origin/main"]);
        wt
    }

    fn commit_in(wt: &Path, file: &str) {
        write(wt, file, "work\n");
        fx(wt, &["add", "."]);
        fx(wt, &["commit", "-q", "-m", file]);
    }

    /// sparkle-28ifhw / sparkle-t58ekc: the branch MERGED, its remote head never existed (or was
    /// deleted), and the window-local reading — resolved by NAME — sees a bare cut. The probe must
    /// prove from git alone that work AUTHORED HERE is on origin/main, and name what it compared.
    #[test]
    fn merged_feature_branch_proves_authored_work_landed_and_names_both_shas() {
        let f = fixture("authored");
        let wt = linked_worktree(&f, "feature/differently-named");
        commit_in(&wt, "b.txt");
        let head = rev(&wt, "HEAD");
        // Land it with a MERGE COMMIT upstream (the PR shape), never pushing the topic branch.
        fx(&f.clone, &["fetch", "-q", "origin"]);
        fx(&f.clone, &["merge", "-q", "--no-ff", "-m", "merge pr", "feature/differently-named"]);
        fx(&f.clone, &["push", "-q", "origin", "main"]);
        let upstream_main = rev(&f.clone, "HEAD");

        let p = landed_probe_in(wt.to_str().unwrap(), f.clone.to_str().unwrap());
        assert_eq!(p.landed, Some(true), "reason: {}", p.reason);
        assert_eq!(p.authored_landed, Some(true), "reason: {}", p.reason);
        let ct: i64 = String::from_utf8_lossy(&fx(&wt, &["log", "-1", "--format=%ct", "HEAD"]).stdout)
            .trim()
            .parse()
            .unwrap();
        assert_eq!(p.authored_landed_at, Some(ct), "the newest authored commit's committer time");
        assert_eq!(p.branch.as_deref(), Some("feature/differently-named"));
        assert_eq!(p.head_sha.as_deref(), Some(head.as_str()));
        assert_eq!(p.base_ref.as_deref(), Some("refs/remotes/origin/main"));
        // The RIGHT side is the REFRESHED ref — the merge commit, not the stale pre-merge main.
        assert_eq!(p.base_sha.as_deref(), Some(upstream_main.as_str()));
    }

    /// THE OPPOSITE DIRECTION: a cut from origin/main that authored NOTHING satisfies ancestry
    /// trivially. `landed` stays a pure ancestry answer, but `authored_landed` must be `false`, or
    /// the caller would close a goal for an agent that wrote no code.
    #[test]
    fn a_bare_cut_is_an_ancestor_but_authored_nothing() {
        let f = fixture("bare");
        let wt = linked_worktree(&f, "noop");
        let p = landed_probe_in(wt.to_str().unwrap(), f.clone.to_str().unwrap());
        assert_eq!(p.landed, Some(true), "reason: {}", p.reason);
        assert_eq!(p.authored_landed, Some(false), "reason: {}", p.reason);
        assert_eq!(p.authored_landed_at, None);
    }

    /// Committed, then threw it away with a reset: HEAD is back on origin/main, the reflog still
    /// names the commit — but that commit is NOT on origin/main, so nothing authored here landed.
    #[test]
    fn a_commit_reset_away_does_not_count_as_authored_landed() {
        let f = fixture("reset");
        let wt = linked_worktree(&f, "resetter");
        commit_in(&wt, "b.txt");
        fx(&wt, &["reset", "-q", "--hard", "origin/main"]);
        let p = landed_probe_in(wt.to_str().unwrap(), f.clone.to_str().unwrap());
        assert_eq!(p.landed, Some(true), "reason: {}", p.reason);
        assert_eq!(p.authored_landed, Some(false), "reason: {}", p.reason);
    }

    /// A NEGATIVE must name what it compared too — that is the refusal sparkle-q4r8z2 is about.
    #[test]
    fn a_negative_still_names_the_branch_and_both_shas() {
        let f = fixture("named-no");
        let wt = linked_worktree(&f, "unlanded");
        commit_in(&wt, "b.txt");
        let p = landed_probe_in(wt.to_str().unwrap(), f.clone.to_str().unwrap());
        assert_eq!(p.landed, Some(false), "reason: {}", p.reason);
        assert_eq!(p.branch.as_deref(), Some("unlanded"));
        assert_eq!(p.head_sha.as_deref(), Some(rev(&wt, "HEAD").as_str()));
        assert_eq!(p.base_sha.as_deref(), Some(rev(&f.clone, "origin/main").as_str()));
    }

    #[test]
    fn reflog_subjects_classify_authored_versus_moved() {
        for yes in ["commit: x", "commit (amend): x", "commit (merge): x", "cherry-pick: x", "rebase (pick): x"] {
            assert!(reflog_subject_is_authored(yes), "{yes}");
        }
        for no in ["checkout: moving from a to b", "reset: moving to origin/main", "pull: Fast-forward",
                   "rebase (start): checkout origin/main", "rebase (finish): returning to refs/heads/x",
                   "merge origin/main: Fast-forward"] {
            assert!(!reflog_subject_is_authored(no), "{no}");
        }
    }

    /// The JSON shape the TS reader parses. camelCase, and `None` crosses as `null` (sparkle-16y6h).
    #[test]
    fn serializes_camel_case_with_null_for_none() {
        let v = serde_json::to_value(LandedProbe::unknown("x")).unwrap();
        for k in ["landed", "branch", "headSha", "baseRef", "baseSha", "authoredLanded", "authoredLandedAt"] {
            assert!(v.get(k).is_some_and(|x| x.is_null()), "{k} must be present and null: {v}");
        }
    }

    #[test]
    fn a_missing_worktree_is_unknown_not_false() {
        let p = landed_probe_in("/definitely/not/a/worktree", "/definitely/not/a/worktree");
        // `None`, NEVER `Some(false)` — a `false` makes the caller say "git says it is not on
        // origin/main yet", which is the lie this whole module exists to stop.
        assert_eq!(p.landed, None, "reason: {}", p.reason);
    }

    #[test]
    fn a_missing_project_root_declines_rather_than_guessing_the_default_branch() {
        let f = fixture("noroot");
        let p = landed_probe_in(f.clone.to_str().unwrap(), "   ");
        assert_eq!(p.landed, None, "reason: {}", p.reason);
    }

    /// A repo with NO `origin` at all must decline, not report "not landed". Nothing was compared.
    #[test]
    fn no_origin_remote_is_unknown() {
        let f = fixture("noremote");
        let solo = f.dir.join("solo");
        std::fs::create_dir_all(&solo).expect("mkdir");
        fx(&solo, &["init", "--initial-branch=main", "."]);
        write(&solo, "a.txt", "one\n");
        fx(&solo, &["add", "."]);
        fx(&solo, &["commit", "-m", "one"]);
        let p = landed_probe_in(solo.to_str().unwrap(), solo.to_str().unwrap());
        assert_eq!(p.landed, None, "reason: {}", p.reason);
    }

    /// The upstream is unreachable, so the fetch fails — and the ref we would have compared against
    /// is therefore stale. A non-ancestor reading against a stale ref must degrade to `None`.
    #[test]
    fn a_negative_against_an_unrefreshable_ref_degrades_to_unknown() {
        let f = fixture("stale");
        // Point origin at a path that does not exist: `rev-parse` still resolves the ref we already
        // fetched, but `fetch` can never succeed again.
        fx(&f.clone, &["remote", "set-url", "origin", "/definitely/not/a/repo"]);
        fx(&f.clone, &["checkout", "-q", "-b", "topic"]);
        write(&f.clone, "b.txt", "two\n");
        fx(&f.clone, &["add", "."]);
        fx(&f.clone, &["commit", "-m", "two"]);
        let p = landed_probe_in(f.clone.to_str().unwrap(), f.clone.to_str().unwrap());
        assert_eq!(p.landed, None, "reason: {}", p.reason);
        assert!(p.reason.contains("stale"), "reason: {}", p.reason);
        let _ = &f.upstream;
    }
}
