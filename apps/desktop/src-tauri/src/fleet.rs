//! Level 0 of the concierge fleet-awareness ladder: derive liveness and progress for every agent
//! from ARTIFACTS ON DISK, at zero agent cost.
//!
//! WHY THIS EXISTS. Every status path in the app today reads in-memory, window-local stores
//! (`stores/runtimeStore.ts`), fed by a hook watcher that is mounted at `components/AgentPane.tsx`
//! — i.e. only while a pane is OPEN. A closed pane, an agent owned by another window, or anything
//! at all after an app restart therefore reads "unknown", and the concierge falls back to guessing
//! from the rendered screen (`trigger=spinner-seen`, `trigger=quiet-settle`). Those surface signals
//! cannot distinguish working from stalled from thrashing. Measured cost of that blindness on
//! 2026-07-29: 23.6 aggregate agent-hours lost across 37 stalls over two minutes, the longest a
//! single agent idle for 153 minutes mid-task, every one of them found by a human noticing a gray
//! row.
//!
//! The filesystem has none of those blind spots. Claude Code's own hook emitter has been appending
//! a line per lifecycle event to `<app_data>/hook-events/<agentId>.jsonl` all along (see
//! `hooks.rs`), git records commits, and the worktree records writes. All of it survives a closed
//! pane, a second window and a relaunch, and all of it is free to read.
//!
//! WHY MESSAGING AGENTS IS NOT AN OPTION. Asking an agent whether it is alive costs a full turn: it
//! loads context, reads, responds — and can END the turn it was in the middle of. Across 40 agents
//! on a 10-minute ping that is ~240 turns an hour spent purely to learn who is alive. Reading these
//! artifacts costs nothing and can run every ten seconds. So: liveness and progress come from here,
//! and an agent's turn is spent only when the concierge has something that agent NEEDS.
//!
//! FACTS, NOT VERDICTS. This module deliberately stops at observations. The verdict vocabulary
//! (idle vs stalled vs thrashing, goal state, status truthfulness, PR claims) is owned by sibling
//! work — `engine/agentStall.ts`, `engine/agentThrash.ts`, `engine/agentGoal.ts` and the status
//! router. Emitting a second, competing verdict here is exactly the duplication that makes two
//! subsystems disagree about the same agent. What this module owns instead is the part nobody else
//! can compute: observations that survive a closed pane. The TypeScript side
//! (`engine/fleetVerdict.ts`) maps these facts into those reducers' input shapes.
//!
//! HONESTY ABOUT ABSENCE. Every field is an `Option`, and `None` means WE DID NOT LOOK or COULD NOT
//! TELL — never "zero" and never "no". A bounded walk that hit its budget sets `walk_truncated`
//! rather than reporting the newest write it happened to reach as if it were the newest write. A
//! truncated read is a window, not a result.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// How much of the tail of a hook log we parse per digest. The logs are reaped at 8 MiB down to
/// 2 MiB by `retention.rs`, so an unbounded read is megabytes per agent per pass; at 64 agents on a
/// ten-second cadence that is the difference between free and not. 256 KiB is far more than the
/// recent window ever needs (a busy agent writes a few hundred bytes per event) while keeping the
/// worst case at ~16 MiB across a 64-agent fleet.
const HOOK_TAIL_MAX_BYTES: u64 = 256 * 1024;

/// Max directory entries a single worktree walk will stat before giving up and reporting
/// `walk_truncated`. A worktree with `node_modules` installed is hundreds of thousands of files;
/// the skip list below removes most of that, and this bounds the rest.
const WALK_MAX_ENTRIES: u32 = 4_000;

/// Max depth for the same walk. Source trees that matter are shallow; anything deeper is vendored.
const WALK_MAX_DEPTH: u32 = 8;

/// Directories never worth walking for "did the agent write anything": build output and dependency
/// trees churn for reasons unrelated to agent progress, and `.git` churns on every read.
const WALK_SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    "coverage",
    ".venv",
    "__pycache__",
];

/// Most recent tool names to carry back per agent, newest last. The thrash reducer that consumes
/// this (`engine/agentThrash.ts`, `REPEAT_LIMIT = 3`) only ever looks at a short run, so a longer
/// tail is payload with no reader.
const RECENT_TOOLS_MAX: usize = 40;

/// One hook-log line, as written by `resources/sparkle-hook.mjs::normalize`. Every field past `ts`
/// and `event` is optional because the emitter only passes through what Claude Code supplied.
#[derive(Debug, Deserialize)]
struct HookLine {
    ts: Option<i64>,
    event: Option<String>,
    tool: Option<String>,
    session_id: Option<String>,
    transcript_path: Option<String>,
}

/// What an agent's hook stream says, reduced from the tail of its log.
#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HookFacts {
    /// Name of the most recent event (`PostToolUse`, `Stop`, …). `None` = the log is empty or absent,
    /// which for a spawned agent means its hooks never fired — itself a finding.
    pub last_event: Option<String>,
    /// Wall-clock the emitter observed the most recent event, epoch ms.
    pub last_event_ms: Option<i64>,
    /// Claude Code session id, needed to correlate with a transcript.
    pub session_id: Option<String>,
    /// Absolute path to the session transcript JSONL. Arrives free on `Stop` lines and is the
    /// entry point for a Level 1 deep read — no search, no guessing which file.
    pub transcript_path: Option<String>,
    /// Most recent `Stop`, i.e. the last time this agent reached a natural turn boundary. This is
    /// the fact Level 2 delivery depends on: a message queued to an agent that never reaches a
    /// boundary is never drained by the Stop hook.
    pub last_turn_end_ms: Option<i64>,
    /// `UserPromptSubmit` count inside the window — how many turns started.
    pub turns_recent: u32,
    /// `PostToolUse` count inside the window — how much work actually happened. An agent with turns
    /// but no tools is the signature of a turn that opens and immediately closes.
    pub tools_recent: u32,
    /// `PreCompact` count inside the window. Context-pressure thrash: an agent that compacts
    /// repeatedly is not progressing. NOTE: `PreCompact` is not yet registered in `hooks.rs`
    /// (sibling branch 0185f357 adds it), so this reads 0 until that lands — 0 here means
    /// "not observed", and the field exists now so the digest shape does not churn later.
    pub compactions_recent: u32,
    /// Tool names in the window, oldest first, capped at `RECENT_TOOLS_MAX`. Raw input for the
    /// repeating-command thrash check; deliberately not reduced to a verdict here.
    pub recent_tools: Vec<String>,
    /// Lines actually parsed. Paired with `tail_truncated` so a reader can tell a quiet agent from
    /// a window that simply did not reach far enough back.
    pub lines_scanned: u32,
    /// True when the log was longer than `HOOK_TAIL_MAX_BYTES` and we read only its tail.
    pub tail_truncated: bool,
}

/// Git observations for one agent's branch. Every field is optional: a worktree whose git commands
/// fail (mid-rebase, detached, deleted) reports `None` rather than a fabricated zero.
#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFacts {
    /// Commits this branch has that the base does not.
    pub ahead: Option<u32>,
    /// COUNT of dirty files, not a boolean. The existing `BranchStatus.dirty` is a bool, which
    /// cannot distinguish "one stray file" from "an hour of uncommitted work" — and that
    /// distinction is the whole point of the idle-with-uncommitted-work contradiction. Untracked
    /// directories are expanded to their individual files rather than collapsed to one entry, so
    /// this really is a file count and not a count of `git status` lines (see
    /// [`dirty_file_count`]). `None` = git could not tell us; it is NOT `Some(0)`.
    pub dirty_files: Option<u32>,
    /// Epoch ms of the branch tip's commit time. Nothing in the app computes this today, and it is
    /// the single most direct answer to "is this agent still landing work".
    pub last_commit_ms: Option<i64>,
    /// Branch the worktree is actually on, which is not always the branch we minted for it.
    pub branch: Option<String>,
    /// Files this branch changes relative to base. Feeds cross-agent conflict detection.
    ///
    /// `None` = the diff could not be read (base ref never fetched, detached or mid-rebase
    /// worktree, no merge-base) and is NOT the same answer as `Some(vec![])`. A plain `Vec` here
    /// collapsed those two into one value, so a fleet-wide failure to read diffs looked exactly
    /// like a fleet in which nobody had changed anything — and `find_conflicts` reported no
    /// conflicts, confidently, on no data. Serializes as `changedFiles: string[] | null`.
    pub changed_files: Option<Vec<String>>,
}

/// Everything Level 0 observed about one agent, all of it from disk.
#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FleetAgentFacts {
    pub agent_id: String,
    pub worktree: String,
    /// Whether the worktree directory still exists. A spun-down worker's does not.
    pub worktree_exists: bool,
    /// mtime of the hook log itself — the cheapest liveness signal there is, one `stat`, no parse.
    pub hook_mtime_ms: Option<i64>,
    pub hooks: HookFacts,
    pub git: GitFacts,
    /// Newest mtime of any non-skipped file in the worktree: "is this agent writing anything at
    /// all", independent of whether it commits.
    pub newest_write_ms: Option<i64>,
    /// True when the walk hit its entry/depth budget, so `newest_write_ms` is a lower bound rather
    /// than the answer.
    pub walk_truncated: bool,
    /// `task` from `.sparkle/worker.json` — what this agent was actually asked to do. Readable
    /// intent without spending a turn asking.
    pub task: Option<String>,
    /// `status` from `.sparkle/result.json`, present once a worker has reported.
    pub result_status: Option<String>,
}

/// Two or more agents changing the same file. Cheap to compute from data we already gathered, and
/// it prevents a class of collision that is currently discovered at merge time — on 2026-07-29 a
/// union merge of concurrent edits to `ConciergeColumn.tsx` produced two `ConciergeThread` elements
/// that would have rendered the thread twice, and nobody knew until the merge.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileConflict {
    pub path: String,
    /// Sorted, so the output is stable across runs and diffable.
    pub agent_ids: Vec<String>,
}

/// The whole Level 0 answer, in one call.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FleetDigest {
    pub generated_at_ms: i64,
    /// The window `*_recent` counts were taken over.
    pub window_ms: i64,
    pub agents: Vec<FleetAgentFacts>,
    pub conflicts: Vec<FileConflict>,
    /// Ids of the LIVE agents whose `git diff` could NOT be read, sorted.
    ///
    /// Empty means every agent that still has a worktree reported its diff. It does NOT mean the
    /// whole roster was examined: `conflicts` covers only agents with a live worktree. A spun-down
    /// agent is not listed here — it has no tree to diff, `worktree_exists: false` already says so,
    /// and re-reading a deleted worktree would fail forever — but if its branch still holds unmerged
    /// commits it remains a real collision source that this digest does not see. [`unread_diffs`]
    /// documents that gap and what closing it would take.
    ///
    /// Without this, `conflicts: []` is ambiguous in the worst possible direction: a fleet whose
    /// diffs all failed looks exactly like a fleet verified to have no collisions. The per-agent
    /// `changed_files: None` carries the same fact, but a caller reading a digest to answer "is
    /// anyone colliding" should not have to re-walk every agent to discover its answer was
    /// computed on no data.
    pub diffs_unread: Vec<String>,
}

// ---------------------------------------------------------------------------------------------
// Pure core. Everything below takes paths and returns data, so it tests without a running app.
// ---------------------------------------------------------------------------------------------

fn ms_of(t: SystemTime) -> Option<i64> {
    t.duration_since(UNIX_EPOCH).ok()?.as_millis().try_into().ok()
}

/// mtime of a path in epoch ms, or `None` if it cannot be read.
pub fn mtime_ms(path: &Path) -> Option<i64> {
    ms_of(std::fs::metadata(path).ok()?.modified().ok()?)
}

/// Read at most the last `max_bytes` of a file. Returns `(bytes, truncated)`.
///
/// Seeks rather than reading and discarding, so a 2 MiB log costs the same as a 2 KiB one. The
/// first (probably partial) line of a truncated read is dropped by `parse_hook_tail`.
pub fn read_tail(path: &Path, max_bytes: u64) -> Option<(Vec<u8>, bool)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let truncated = len > max_bytes;
    let start = if truncated { len - max_bytes } else { 0 };
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.take(max_bytes).read_to_end(&mut buf).ok()?;
    Some((buf, truncated))
}

/// Reduce a hook-log tail to `HookFacts`.
///
/// `truncated` says the buffer starts mid-file, in which case the first line is almost certainly a
/// fragment and is skipped — parsing it would either fail (harmless) or, worse, succeed on a
/// truncated JSON prefix. Unparseable lines are skipped silently and on purpose: the emitter is
/// explicitly allowed to fail without surfacing to Claude, so a malformed line means a bad write,
/// not a reason to fail the whole digest.
///
/// `window_ms` bounds the `*_recent` counts. `last_*` fields are NOT windowed — the most recent
/// event matters however old it is, and its age is the stall signal.
pub fn parse_hook_tail(bytes: &[u8], truncated: bool, now_ms: i64, window_ms: i64) -> HookFacts {
    let mut facts = HookFacts { tail_truncated: truncated, ..Default::default() };
    let text = String::from_utf8_lossy(bytes);
    let cutoff = now_ms.saturating_sub(window_ms);

    for (i, line) in text.lines().enumerate() {
        // A truncated read begins mid-line; that fragment is not a record.
        if truncated && i == 0 {
            continue;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<HookLine>(line) else {
            continue;
        };
        let Some(event) = parsed.event.filter(|e| !e.is_empty()) else {
            continue;
        };
        facts.lines_scanned += 1;

        // Last-wins fields. Guard each with a presence check so a later line that simply omits a
        // field does not erase what an earlier one told us.
        facts.last_event = Some(event.clone());
        if let Some(ts) = parsed.ts {
            facts.last_event_ms = Some(ts);
        }
        if let Some(sid) = parsed.session_id.filter(|s| !s.is_empty()) {
            facts.session_id = Some(sid);
        }
        if let Some(tp) = parsed.transcript_path.filter(|s| !s.is_empty()) {
            facts.transcript_path = Some(tp);
        }
        if event == "Stop" {
            if let Some(ts) = parsed.ts {
                facts.last_turn_end_ms = Some(ts);
            }
        }

        // Windowed counters. A line with no `ts` cannot be placed in the window, so it is counted
        // in neither direction rather than assumed recent.
        let in_window = parsed.ts.map(|ts| ts >= cutoff).unwrap_or(false);
        if !in_window {
            continue;
        }
        match event.as_str() {
            "UserPromptSubmit" => facts.turns_recent += 1,
            "PostToolUse" => {
                facts.tools_recent += 1;
                if let Some(tool) = parsed.tool.filter(|t| !t.is_empty()) {
                    facts.recent_tools.push(tool);
                    if facts.recent_tools.len() > RECENT_TOOLS_MAX {
                        facts.recent_tools.remove(0);
                    }
                }
            }
            "PreCompact" => facts.compactions_recent += 1,
            _ => {}
        }
    }
    facts
}

/// Newest mtime of any file under `root`, skipping `WALK_SKIP_DIRS`. Returns
/// `(newest_ms, truncated)`; `truncated` means the budget ran out, so the value is a lower bound.
///
/// Iterative rather than recursive so a pathological tree cannot blow the stack, and budgeted so a
/// worktree with an un-skipped dependency tree cannot make the digest unbounded.
pub fn newest_write_ms(root: &Path) -> (Option<i64>, bool) {
    let mut newest: Option<i64> = None;
    let mut seen: u32 = 0;
    let mut truncated = false;
    let mut stack: Vec<(PathBuf, u32)> = vec![(root.to_path_buf(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        if depth > WALK_MAX_DEPTH {
            truncated = true;
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if seen >= WALK_MAX_ENTRIES {
                truncated = true;
                return (newest, truncated);
            }
            seen += 1;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if WALK_SKIP_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                stack.push((entry.path(), depth + 1));
                continue;
            }
            // Symlinks are not followed: a link into node_modules or out of the worktree would
            // reintroduce exactly the unboundedness the skip list removes.
            if !ft.is_file() {
                continue;
            }
            if let Some(ms) = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(ms_of) {
                newest = Some(newest.map_or(ms, |n: i64| n.max(ms)));
            }
        }
    }
    (newest, truncated)
}

/// Group `changed_files` across agents into the paths more than one agent is touching.
///
/// Pure and total: agents with no changed files contribute nothing, and a path touched by exactly
/// one agent is not a conflict. Output is sorted by path, and each `agent_ids` is sorted, so two
/// runs over the same fleet produce byte-identical output and a diff means something changed.
///
/// An agent whose diff could NOT be read (`changed_files: None`) is SKIPPED, not treated as an
/// agent that changed nothing. The distinction is invisible in this function's output — an absent
/// list and an empty list both contribute zero paths — and that is precisely the trap: the caller
/// must not read "no conflicts" as "no collisions exist" when the underlying reads failed. The
/// per-agent `None` is the only channel carrying that, which is why it is preserved rather than
/// flattened here.
pub fn find_conflicts(agents: &[FleetAgentFacts]) -> Vec<FileConflict> {
    let mut by_path: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for agent in agents {
        let Some(changed) = agent.git.changed_files.as_ref() else {
            continue; // read failed — contributes no evidence in either direction
        };
        for path in changed {
            by_path.entry(path.as_str()).or_default().push(agent.agent_id.as_str());
        }
    }
    by_path
        .into_iter()
        .filter(|(_, ids)| ids.len() > 1)
        .map(|(path, mut ids)| {
            ids.sort_unstable();
            ids.dedup();
            FileConflict {
                path: path.to_string(),
                agent_ids: ids.into_iter().map(str::to_string).collect(),
            }
        })
        .filter(|c| c.agent_ids.len() > 1)
        .collect()
}

/// Ids of the LIVE agents whose diff did not read, sorted — a SUBSET of what `find_conflicts`
/// skips, not all of it. `find_conflicts` skips every `changed_files: None`, reaped agents
/// included; this reports only the ones still worth re-reading.
///
/// This is the observable half of that skip. `find_conflicts` alone cannot express it — an absent
/// list and an empty list both contribute zero paths, so its output is byte-identical either way —
/// which means a caller with only `conflicts` cannot tell "nobody collides" from "we failed to
/// look". Reporting WHICH agents were skipped, rather than a bare bool, lets a caller re-read just
/// those instead of the whole fleet.
///
/// KNOWN GAP, deliberately not papered over. A spun-down agent whose `sparkle/agent-<id>` branch
/// still holds unmerged commits contributes nothing to `conflicts` and is not named here either,
/// yet it is a genuine collision source — worktree teardown and branch deletion are separate steps,
/// and the second only runs for a shipped agent. Its diff IS still readable, from the surviving ref
/// rather than the missing tree (`git diff --name-only <base>...refs/heads/sparkle/agent-<id>` in
/// the project root), but nothing in this module has the project root to run that in: `build_digest`
/// takes worktree paths only. So `conflicts` covers agents with a LIVE worktree, and the doc on
/// [`FleetDigest::diffs_unread`] says so rather than implying full-roster coverage.
///
/// `worktree_exists` IS PART OF THE CONDITION, and leaving it out made the field useless. A
/// spun-down agent also carries `changed_files: None` — [`agent_facts`] short-circuits its whole
/// git block to `GitFacts::default()` because there is no tree to read — and a caller's roster
/// routinely includes long-dead agents whose worktrees were never reaped (see [`fleet_digest`]).
/// Counting those would leave this permanently non-empty for any real fleet, so "empty means every
/// diff was read" could never fire, and the ids would not be actionable either: re-reading a
/// deleted worktree fails forever. A reaped tree is already fully described by
/// `worktree_exists: false`, which is why it needs no second field here — this one is scoped to the
/// recoverable case, a live worktree whose diff we could not read.
pub fn unread_diffs(agents: &[FleetAgentFacts]) -> Vec<String> {
    let mut ids: Vec<String> = agents
        .iter()
        .filter(|a| a.worktree_exists && a.git.changed_files.is_none())
        .map(|a| a.agent_id.clone())
        .collect();
    ids.sort_unstable();
    ids
}

// ---------------------------------------------------------------------------------------------
// Git observations
// ---------------------------------------------------------------------------------------------

/// Count of dirty paths in a worktree. `None` = git could not tell us, NOT "clean".
///
/// `--no-optional-locks` matters and is not decoration: a plain `git status` refreshes and rewrites
/// the index, which bumps its mtime — and the index mtime is a component of the status-cache
/// fingerprint in `worktree.rs`. A digest that ran every ten seconds and bumped the index each time
/// would invalidate that cache continuously and make every OTHER status read expensive.
///
/// IT IS A TOP-LEVEL GIT OPTION AND MUST PRECEDE THE SUBCOMMAND. `git status --porcelain
/// --no-optional-locks` is not a slower spelling of this — it exits 129 with ``unknown option
/// `no-optional-locks'`` and produces NO output at all. This function shipped with that order and,
/// because the failure was swallowed by `.ok()?`, reported `None` for every agent on every pass:
/// the dirty-file signal the module exists for was entirely off, and nothing said so. Hence both
/// halves of the fix — the flag placement (matching `worktree::branch_status_with_base`, which gets
/// this right) and the logged error, so a future breakage of this command is visible instead of
/// indistinguishable from a fleet of clean worktrees.
///
/// `--untracked-files=all` is the difference between a count of FILES and a count of status lines.
/// In git's default untracked mode an untracked DIRECTORY collapses to one entry — an agent that
/// just wrote `src/newmod/` with thirty files in it reports `?? src/newmod/`, i.e. `Some(1)`, the
/// same number a single stray file produces. That understatement is not cosmetic: the count is
/// rendered to a human as "N uncommitted files" and feeds the idle-with-uncommitted-work
/// escalation, so writing a whole new module would read as trivially dirty. The extra scan is
/// affordable here because `.gitignore` still applies (so `node_modules` and `target` are not
/// walked) and because [`newest_write_ms`] already walks this same tree on every pass.
fn dirty_file_count(worktree: &str) -> Option<u32> {
    let args = &["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"];
    let out = match crate::worktree::git(worktree, args) {
        Ok(out) => out,
        Err(e) => {
            // `debug!`, not `warn!`: at 64 agents on a ten-second cadence a persistently
            // unreadable worktree (spun down mid-pass, mid-rebase) would flood the log. The text
            // is the whole git error, so the 129 above would have been one grep away.
            tracing::debug!(worktree, error = %e, "fleet: dirty-file count unavailable; reporting None");
            return None;
        }
    };
    // Reached only when git SUCCEEDED, so an empty result really is a clean tree: `Some(0)` and
    // `None` are different answers and this is the line that keeps them apart.
    Some(out.lines().filter(|l| !l.trim().is_empty()).count() as u32)
}

/// Commit time of a ref, epoch ms. `%ct` is the committer date, which is what "when did this agent
/// last land work" means; author date can be far older after a rebase.
fn last_commit_ms(worktree: &str, git_ref: &str) -> Option<i64> {
    let out = crate::worktree::git(worktree, &["log", "-1", "--format=%ct", git_ref]).ok()?;
    out.trim().parse::<i64>().ok().map(|secs| secs * 1000)
}

/// Gather git facts for one worktree against `base`.
///
/// Every command is independently fallible and independently optional: a worktree mid-rebase can
/// answer some of these and not others, and reporting the ones it can answer beats failing the
/// whole agent. `base` is only used for the two comparison reads.
pub fn git_facts(worktree: &str, base: &str) -> GitFacts {
    let branch = crate::worktree::git(worktree, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");

    let ahead = crate::worktree::git(worktree, &["rev-list", "--count", &format!("{base}..HEAD")])
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok());

    // `.ok()`, deliberately NOT `.unwrap_or_default()`: an unreadable diff must stay `None` so a
    // reader (and `find_conflicts`) can tell it apart from a branch that really changed nothing.
    let changed_files = crate::worktree::git(worktree, &["diff", "--name-only", &format!("{base}...HEAD")])
        .map_err(|e| {
            tracing::debug!(worktree, base, error = %e, "fleet: changed-file diff unavailable; reporting None");
        })
        .ok()
        .map(|out| {
            out.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        });

    GitFacts {
        ahead,
        dirty_files: dirty_file_count(worktree),
        last_commit_ms: last_commit_ms(worktree, "HEAD"),
        branch,
        changed_files,
    }
}

// ---------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------

/// Read `.sparkle/worker.json`'s `task` and `.sparkle/result.json`'s `status`, if present.
/// Both are written by the worker itself, so both are absent for a plain (non-worker) agent.
fn worker_facts(worktree: &Path) -> (Option<String>, Option<String>) {
    let field = |file: &str, key: &str| -> Option<String> {
        let raw = std::fs::read_to_string(worktree.join(".sparkle").join(file)).ok()?;
        let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
        v.get(key)?.as_str().map(str::to_string)
    };
    (field("worker.json", "task"), field("result.json", "status"))
}

/// Assemble facts for one agent. `hook_log` and `worktree` are passed in rather than derived so
/// this is testable against a tempdir with no `AppHandle`.
pub fn agent_facts(
    agent_id: &str,
    worktree: &Path,
    hook_log: &Path,
    base: &str,
    now_ms: i64,
    window_ms: i64,
) -> FleetAgentFacts {
    let worktree_exists = worktree.is_dir();

    let hook_mtime_ms = mtime_ms(hook_log);
    let hooks = match read_tail(hook_log, HOOK_TAIL_MAX_BYTES) {
        Some((bytes, truncated)) => parse_hook_tail(&bytes, truncated, now_ms, window_ms),
        None => HookFacts::default(),
    };

    // Git and the walk both require the worktree to still be there. A spun-down worker keeps its
    // hook log (it lives outside the worktree) but has no tree to read — reporting its last known
    // hook activity while saying nothing about git is the honest answer.
    let (git, newest_write_ms_val, walk_truncated, task, result_status) = if worktree_exists {
        let wt = worktree.to_string_lossy().to_string();
        let (newest, truncated) = newest_write_ms(worktree);
        let (task, result_status) = worker_facts(worktree);
        (git_facts(&wt, base), newest, truncated, task, result_status)
    } else {
        (GitFacts::default(), None, false, None, None)
    };

    FleetAgentFacts {
        agent_id: agent_id.to_string(),
        worktree: worktree.to_string_lossy().to_string(),
        worktree_exists,
        hook_mtime_ms,
        hooks,
        git,
        newest_write_ms: newest_write_ms_val,
        walk_truncated,
        task,
        result_status,
    }
}

/// Default window for the `*_recent` counters: long enough that a slow-but-working agent (a long
/// build, a long test run) still shows tool activity, short enough that yesterday's work does not
/// make a currently-dead agent look busy.
pub const DEFAULT_WINDOW_MS: i64 = 15 * 60 * 1000;

/// Build the whole digest from a list of `(agent_id, worktree)` pairs.
pub fn build_digest(
    agents: &[(String, PathBuf)],
    hook_events_dir: &Path,
    base: &str,
    now_ms: i64,
    window_ms: i64,
) -> FleetDigest {
    let facts: Vec<FleetAgentFacts> = agents
        .iter()
        .map(|(id, worktree)| {
            let log = hook_events_dir.join(format!("{id}.jsonl"));
            agent_facts(id, worktree, &log, base, now_ms, window_ms)
        })
        .collect();
    let conflicts = find_conflicts(&facts);
    let diffs_unread = unread_diffs(&facts);
    FleetDigest { generated_at_ms: now_ms, window_ms, agents: facts, conflicts, diffs_unread }
}

/// One agent the caller wants in the digest.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetAgentInput {
    pub agent_id: String,
    pub project_id: String,
}

fn now_ms() -> i64 {
    ms_of(SystemTime::now()).unwrap_or(0)
}

/// Level 0: one call, every agent, artifacts only, zero agent turns spent.
///
/// Deliberately takes the agent list from the caller rather than scanning every worktree on disk:
/// the caller knows which project is in scope, and a full scan would include long-dead agents whose
/// worktrees were never reaped. `base_branch` defaults to `origin/main`.
#[tauri::command]
/// `async` + `spawn_blocking` is REQUIRED here, not stylistic — the rule `hooks.rs` states: a sync
/// `#[tauri::command]` runs on the MAIN THREAD. This is the heaviest work in the file. Per agent it
/// is four `git` subprocess spawns plus a filesystem walk of up to [`WALK_MAX_ENTRIES`] stats, so at
/// the documented target of 64 agents on a ten-second cadence that is ~256 git processes and ~256k
/// `stat` calls per pass. On the UI thread that is the app frozen for the duration, every ten
/// seconds, by the very feature meant to make the fleet observable.
pub async fn fleet_digest(
    app: AppHandle,
    agents: Vec<FleetAgentInput>,
    base_branch: Option<String>,
    window_ms: Option<i64>,
) -> Result<FleetDigest, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    let base = base_branch.unwrap_or_else(|| "origin/main".to_string());
    let window = window_ms.unwrap_or(DEFAULT_WINDOW_MS);

    // Path validation stays on THIS thread: it is pure string work, and doing it before the hop
    // means a crafted agent id is rejected without occupying a blocking-pool slot at all.
    let mut pairs: Vec<(String, PathBuf)> = Vec::with_capacity(agents.len());
    for a in &agents {
        // Reuse worktree.rs's validated path builder: it rejects path traversal and metacharacters
        // in both ids, so a malicious agent id cannot walk us out of the worktrees dir.
        let wt = crate::worktree::worktree_path(&app_data, &a.project_id, &a.agent_id)?;
        pairs.push((a.agent_id.clone(), wt));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let hook_dir = app_data.join("hook-events");
        build_digest(&pairs, &hook_dir, &base, now_ms(), window)
    })
    .await
    .map_err(|e| format!("fleet_digest task failed: {e}"))
}

// ---------------------------------------------------------------------------------------------
// Level 1: targeted deep reads. Still free — no agent turn is spent — but read only when Level 0
// has flagged one agent, because these return real volume.
// ---------------------------------------------------------------------------------------------

/// Default page size for a Level 1 read. Large enough that most investigations finish in one page,
/// and paired with `remaining_bytes` so a caller always knows when it did not.
pub const PAGE_MAX_BYTES: u64 = 64 * 1024;

/// Hard ceiling a caller may request. Bounds a single read onto the blocking pool.
pub const PAGE_LIMIT_BYTES: u64 = 512 * 1024;

/// One page of a line-oriented file, plus everything a reader needs to know what it did NOT get.
///
/// THE DEFECT THIS EXISTS TO FIX. `conciergeTools/terminal.ts::readAgentTerminal` caps its result
/// with `capTail` at `TERMINAL_READ_MAX_CHARS = 4000`, keeping the tail and dropping the front. In
/// use that silently dropped 6k and then 12k characters mid-investigation — and what gets dropped
/// is exactly the content agents write when they have something important to say. Worse, `clamp()`
/// means a caller may only LOWER that cap, never raise it, so there is no way to ask for the rest.
///
/// So the contract here is the opposite one, and it is the whole point of the type: a page is
/// always accompanied by `next_cursor` and `remaining_bytes`. A truncated read is a WINDOW, and a
/// window that does not say how much it left behind is indistinguishable from a complete result.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamPage {
    /// Whole lines, EXCEPT when `partial_line` says otherwise. A trailing partial line is normally
    /// left for the next page rather than returned half-parsed — the emitter appends whole lines
    /// atomically, so a remainder is a write in progress.
    pub lines: Vec<String>,
    /// Byte offset to pass as `cursor` next time. Always advances when `lines` is non-empty.
    pub next_cursor: u64,
    /// Bytes after `next_cursor`. Zero means this page reached the end — the ONLY way a caller may
    /// conclude it has read everything.
    pub remaining_bytes: u64,
    /// Convenience for `remaining_bytes == 0`, so a reader cannot get the polarity wrong.
    pub eof: bool,
    /// Total size, so a caller can show progress rather than paging blind.
    pub total_bytes: u64,
    /// True when the LAST entry in `lines` is a fragment rather than a whole record, because a
    /// single line was longer than the budget and had to be cut to keep the cursor advancing.
    ///
    /// This is not a theoretical case. Claude Code transcript lines routinely exceed the 64 KiB
    /// [`PAGE_MAX_BYTES`] — one large tool result does it — so a caller parsing these as JSONL gets
    /// an unparseable fragment. Silently handing that over as a complete line is exactly the "a
    /// window that does not say what it left behind" failure this type exists to prevent, one level
    /// down. The fragment continues at `next_cursor`, and the cut is made on a UTF-8 character
    /// boundary so joining this line to the next page's FIRST line reproduces the record exactly.
    ///
    /// THE PROTOCOL IS ASYMMETRIC, and a caller must carry state across calls to use it: the
    /// continuation page reports `partial_line: false` — correctly, since ITS last line is whole —
    /// even though its FIRST line is the tail of the previous fragment. Nothing in a single page
    /// says "my first line is a continuation", because this command accepts an arbitrary cursor
    /// from a caller that may have no history at all. So a reader that pages must remember it saw
    /// `partial_line` and prepend that fragment; a reader that jumps to a cursor cannot know, which
    /// is the honest limit of what a stateless page can report.
    ///
    /// NOT YET READABLE BY THE CONSUMER — tracked as bead `sparkle-suv6`. The TS mirror
    /// (`conciergeTools/fleet.ts`) does not carry this field, and the `sparkle_fleet` tool text
    /// still tells the model only to page until `eof`, so today the flag is emitted into a channel
    /// nobody reads and the concierge still hands fragments to `JSON.parse`. Those files are owned
    /// by the concurrent TypeScript work rather than this module; the bead carries the exact shape.
    pub partial_line: bool,
}

/// Read one page of whole lines starting at `cursor`.
///
/// A `cursor` past the end restarts at 0 rather than erroring: the hook logs are reaped and
/// rewritten by `retention.rs`, so a stale cursor is an expected condition, not a caller bug.
pub fn read_page(path: &Path, cursor: u64, max_bytes: u64) -> Result<StreamPage, String> {
    use std::io::{Read, Seek, SeekFrom};
    let budget = max_bytes.clamp(1, PAGE_LIMIT_BYTES);

    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StreamPage {
                lines: vec![],
                next_cursor: 0,
                remaining_bytes: 0,
                eof: true,
                total_bytes: 0,
                partial_line: false,
            })
        }
        Err(e) => return Err(format!("open: {e}")),
    };
    let total = f.metadata().map_err(|e| format!("stat: {e}"))?.len();
    // Truncated or rotated underneath us — start over rather than returning garbage.
    let start = if cursor > total { 0 } else { cursor };

    f.seek(SeekFrom::Start(start)).map_err(|e| format!("seek: {e}"))?;
    let available = total - start;
    let to_read = budget.min(available);
    let mut buf = Vec::with_capacity(to_read as usize);
    Read::by_ref(&mut f)
        .take(to_read)
        .read_to_end(&mut buf)
        .map_err(|e| format!("read: {e}"))?;

    // Consume only through the last newline so a page does not split a record. If the budget landed
    // mid-line and there is no newline at all, take the whole chunk anyway — otherwise a single
    // line longer than the budget would make the cursor stick forever and the caller loop.
    let last_newline = buf.iter().rposition(|&b| b == b'\n');
    let consumed = match last_newline {
        // A newline can never be part of a multi-byte sequence (continuation bytes are all >= 0x80),
        // so stopping just past one is always a valid UTF-8 boundary.
        Some(i) => i + 1,
        // No newline: we must cut mid-record, and the cut has to land on a CHARACTER boundary or the
        // split is lossy rather than resumable. `from_utf8_lossy` would otherwise replace the
        // incomplete trailing sequence with U+FFFD here AND the orphaned continuation bytes with
        // another U+FFFD on the next page — destroying the character instead of deferring it, so a
        // caller that pages and rejoins exactly as `partial_line` instructs still gets corruption.
        // Transcript JSONL is full of non-ASCII and the split lines are the longest ones, so this is
        // the common case, not a corner.
        None => match std::str::from_utf8(&buf) {
            Ok(_) => buf.len(),
            Err(e) if e.valid_up_to() > 0 => e.valid_up_to(),
            // `valid_up_to() == 0` — not one whole character in the buffer. Take the chunk anyway;
            // honouring a boundary that does not exist would park the cursor forever.
            //
            // NOTE ON WHAT THIS CANNOT CAUSE: the cut above always lands ON a character boundary
            // (`valid_up_to()` is by definition the start of the incomplete sequence), so the
            // cursors THIS function hands out are always aligned, and from an aligned cursor
            // `valid_up_to() == 0` requires a budget too small to hold one character — under 4
            // bytes, versus the 64 KiB [`PAGE_MAX_BYTES`] real callers pass. Reaching it otherwise
            // takes a caller inventing a mid-character cursor rather than passing back the one it
            // was handed, and even then it self-corrects at the next newline in the stream, since
            // the branch above realigns on any `\n`. That is why this stays a single lossy chunk
            // rather than a realignment pass: the misalignment it would repair is not a state this
            // function can produce.
            Err(_) => buf.len(),
        },
    };
    let text = String::from_utf8_lossy(&buf[..consumed]);
    let lines: Vec<String> = text.lines().map(str::to_string).collect();

    let next_cursor = start + consumed as u64;
    let remaining_bytes = total.saturating_sub(next_cursor);
    // The record IS split exactly when we found no newline AND did not reach the end: the line
    // continues past `next_cursor`. Reaching EOF with no trailing newline is NOT a split — that
    // last line is whole, merely unterminated — which is why this tests `remaining_bytes` rather
    // than just `last_newline.is_none()`.
    let partial_line = last_newline.is_none() && remaining_bytes > 0;
    Ok(StreamPage {
        lines,
        next_cursor,
        remaining_bytes,
        eof: remaining_bytes == 0,
        total_bytes: total,
        partial_line,
    })
}

/// Level 1: page an agent's COMPLETE hook stream.
///
/// Unlike `hooks::read_events_since` (which a pane uses to tail new events and skips the backlog),
/// this is for reading history: the caller starts at 0 and pages forward.
#[tauri::command]
/// `async` + `spawn_blocking` for the same reason as [`fleet_digest`]: a sync `#[tauri::command]`
/// runs on the main thread, and this one seeks and reads up to [`PAGE_LIMIT_BYTES`] off disk.
pub async fn fleet_read_hook_stream(
    app: AppHandle,
    agent_id: String,
    cursor: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<StreamPage, String> {
    // Reject anything that is not a plain id before it reaches a path join. Mirrors the validation
    // `worktree::worktree_path` applies, so a crafted agent id cannot escape hook-events. Checked
    // before the thread hop so a crafted id never occupies a blocking-pool slot.
    if agent_id.is_empty()
        || agent_id.contains('/')
        || agent_id.contains('\\')
        || agent_id.contains("..")
        || agent_id.contains('\0')
    {
        return Err("fleet_read_hook_stream: invalid agent id".into());
    }
    let dir = crate::dev_identity::app_data_dir(&app)?.join("hook-events");
    let cursor = cursor.unwrap_or(0);
    let max_bytes = max_bytes.unwrap_or(PAGE_MAX_BYTES);

    tauri::async_runtime::spawn_blocking(move || {
        read_page(&dir.join(format!("{agent_id}.jsonl")), cursor, max_bytes)
    })
    .await
    .map_err(|e| format!("fleet_read_hook_stream task failed: {e}"))?
}

/// Every directory a Claude Code transcript may legitimately live under. Pure form: takes all three
/// inputs, so the multi-account case is testable and the answer cannot depend on the environment
/// the test binary happens to run under.
///
/// IT IS NOT JUST `$HOME/.claude/projects`, and — the subtler half — IT IS NOT SPARKLE'S OWN
/// `CLAUDE_CONFIG_DIR` EITHER. Claude Code stores transcripts under `$CLAUDE_CONFIG_DIR/projects`
/// whenever that is set, and this app's multi-account support sets it **on the agent's shell
/// command** (`claudeSpawn.ts`'s `buildClaudeExec`; `AgentPane.tsx` says "set on the child only"),
/// never on the desktop process. So resolving it from our own environment — or from the login
/// shell, which sees only a value the USER exported by hand — yields `$HOME/.claude` on every
/// normal Finder/Dock launch, while an agent on account `ab12` has its transcript under
/// `<app_data>/accounts/ab12/projects/<slug>/<uuid>.jsonl` and every read of it is refused.
///
/// `hooks::plugin_config_trees` carries a doc comment describing this exact failure for plugins,
/// because an earlier pass at THAT read the var from our own environment too.
///
/// `shared_roots` IS THE SAME NOTION OF THIS BOUNDARY THE REST OF THE CRATE USES —
/// `spend::transcript_roots`, which the Spend pane and `accounts_spend` already scan. Passing it in
/// rather than re-deriving one here is the point: it resolves account stores by ENUMERATING
/// `<app_data>/accounts/*/projects` on disk, whereas `account_config_dirs` comes from
/// `accounts.json`, and the two disagree in reachable states — account removal is best-effort
/// (`remove_account_at` ignores the `remove_dir_all` result), so a failed delete leaves a store on
/// disk with no metadata entry. Confining to only the metadata answer would make that agent's
/// transcripts unreadable with a "you may not have this" message, which is the very failure this
/// series exists to remove. So this is the UNION, mirroring `accounts_spend`'s precedent exactly:
/// the shared roots first, then any account whose `config_dir` points somewhere else entirely (an
/// imported account outside app-data), then the environment's, then the `$HOME` fallback.
///
/// Union, not intersection, is also the safe direction here: every root is a directory Sparkle
/// itself created and already reads for Spend, so admitting one is not an escalation — whereas
/// refusing one turns a routine read into a false security accusation.
///
/// Deduped on `spend::canonical_key`, not the raw path, for the same reason that function does it:
/// it collapses a symlinked store and the two spellings of the default account (a pre-fix literal
/// `$HOME/.claude` and a post-fix `""`, which both resolve to `$HOME/.claude/projects`).
fn transcript_roots_from(
    shared_roots: &[PathBuf],
    account_config_dirs: &[String],
    env_config_dir: &str,
    home: Option<&Path>,
) -> Vec<PathBuf> {
    let candidates = shared_roots.iter().cloned().chain(
        account_config_dirs
            .iter()
            .map(String::as_str)
            // Sparkle's own / the login shell's value. Covers a user who exported the var by hand,
            // which is a real configuration even though it is not the one the app itself creates.
            .chain(std::iter::once(env_config_dir))
            .filter_map(|d| crate::claude::claude_projects_root(Some(Path::new(d)), home))
            // The default-account location, always allowed.
            .chain(crate::claude::claude_projects_root(None, home)),
    );

    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    candidates
        .filter(|r| seen.insert(crate::spend::canonical_key(r)))
        .collect()
}

/// The allowed roots on THIS machine, plus a description of the metadata read if it FAILED.
///
/// Neither swallowing nor hard-gating the `accounts.json` read is right, and this module has now
/// tried both. Swallowing it (`unwrap_or_default`) silently degraded a corrupt file to "zero
/// accounts", leaving a non-empty root list, so every non-default-account read came back as
/// "outside the allowed roots" — a false accusation caused by our own unread error. Propagating it
/// with `?` swung the other way: `accounts.json` is a hard gate on EVERY read, yet most roots do not
/// need it at all — `spend::transcript_roots` enumerates the account stores from DISK and the
/// `$HOME` fallback needs no metadata either, so a transient `EACCES` refused reads of stores
/// sitting right there, and the Spend pane went on scanning exactly what the concierge could no
/// longer open. That contradicts this module's own rationale that refusing a root turns a routine
/// read into an accusation.
///
/// So: resolve everything that does not depend on the metadata unconditionally, and carry the
/// failure alongside rather than in place of the answer. `accounts.json` uniquely contributes only
/// accounts whose `config_dir` points OUTSIDE app-data (the imported case), so the error is
/// material exactly when a path is not inside the roots we did resolve — which is where
/// [`read_transcript_within`] surfaces it, instead of pre-emptively refusing everything.
fn transcript_roots(app_data: &Path) -> (Vec<PathBuf>, Option<String>) {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let (account_dirs, metadata_error) =
        match crate::accounts::read_accounts_at(&crate::accounts::accounts_json_path(app_data)) {
            Ok(accounts) => (accounts.into_iter().map(|a| a.config_dir).collect(), None),
            Err(e) => (Vec::new(), Some(e)),
        };
    let roots = transcript_roots_from(
        &crate::spend::transcript_roots(Some(app_data)),
        &account_dirs,
        &crate::claude::effective_spawn_config_dir(),
        home.as_deref(),
    );
    (roots, metadata_error)
}

/// How a candidate transcript path relates to the allowed roots.
///
/// `Missing` exists because conflating it with `Outside` was a bug: a transcript reaped by Claude
/// Code's own retention, or a rotated session, is a NOT-FOUND condition, and reporting it as
/// "outside the allowed roots" is a security accusation about a routine event. It also made
/// [`read_page`]'s documented behaviour ("a missing file is an empty eof page, not an error")
/// unreachable through this command.
#[derive(Debug, PartialEq)]
enum TranscriptPath {
    /// Resolved, present, and inside an allowed root.
    Allowed,
    /// Inside an allowed root, but no such file. Not an error.
    Missing,
    /// Outside every allowed root, or a dangling symlink whose target could later be created
    /// pointing outside one.
    Outside,
}

/// Classify `target` against `roots`. Mirrors `hooks::log_path_within`'s structure: canonicalize
/// the file when it EXISTS (so a planted symlink cannot redirect the read), and fall back to
/// canonicalizing its PARENT when it does not.
///
/// Unlike the hook-event layout, which is flat and compares `parent() == base`, transcripts are
/// nested one project-slug directory deep, so containment is `starts_with`.
fn classify_transcript(roots: &[PathBuf], target: &Path) -> TranscriptPath {
    let canon_roots: Vec<PathBuf> = roots.iter().filter_map(|r| r.canonicalize().ok()).collect();
    let inside = |p: &Path| canon_roots.iter().any(|r| p.starts_with(r));

    // The file exists: resolve it fully, symlinks included, and require the RESULT to be inside.
    if let Ok(canon) = target.canonicalize() {
        return if inside(&canon) { TranscriptPath::Allowed } else { TranscriptPath::Outside };
    }

    // Absent. Reject a dangling symlink outright — its target could be created later to redirect
    // the read outside the roots, and nothing here would notice.
    if std::fs::symlink_metadata(target).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return TranscriptPath::Outside;
    }

    // Absent file whose DIRECTORY exists: the ordinary reaped-transcript case.
    if let Some(canon_parent) = target.parent().and_then(|p| p.canonicalize().ok()) {
        return if inside(&canon_parent) { TranscriptPath::Missing } else { TranscriptPath::Outside };
    }

    // Neither the file nor its directory exists — which includes the whole projects root being
    // absent on a machine that has not run Claude Code yet. Canonicalization can say nothing here,
    // and the old code therefore called every such read a confinement violation. Nothing can be
    // read through a path whose directory does not exist, so a lexical containment check is safe;
    // `..` is rejected explicitly because there is no canonicalization left to resolve it.
    if target.components().any(|c| c == std::path::Component::ParentDir) {
        return TranscriptPath::Outside;
    }
    if roots.iter().any(|r| target.starts_with(r)) {
        TranscriptPath::Missing
    } else {
        TranscriptPath::Outside
    }
}

/// The confined read itself, taking `roots` so it tests without touching the environment.
fn read_transcript_within(
    roots: &[PathBuf],
    metadata_error: Option<&str>,
    transcript_path: &str,
    cursor: u64,
    max_bytes: u64,
) -> Result<StreamPage, String> {
    let target = PathBuf::from(transcript_path);
    match classify_transcript(roots, &target) {
        // `read_page` is what turns this into the empty eof page — the behaviour its own doc
        // promises and that the previous confinement check prevented ever being reached. Note a
        // failed `accounts.json` read does NOT block this: the roots that admitted the path did not
        // depend on it, so refusing here would be a false accusation over an irrelevant error.
        TranscriptPath::Allowed | TranscriptPath::Missing => read_page(&target, cursor, max_bytes),
        // Outside everything we could resolve. THIS is where an unreadable `accounts.json` becomes
        // material: it may have named the very root that would have admitted this path, so saying
        // "outside" would blame the caller for our own failed read. Report the cause instead.
        TranscriptPath::Outside => Err(match metadata_error {
            Some(e) => format!(
                "fleet_read_transcript: cannot resolve the Claude projects roots \
                 (accounts.json unreadable: {e}), so {transcript_path} could not be confirmed"
            ),
            None => format!(
                "fleet_read_transcript: {transcript_path} is outside the allowed Claude projects roots"
            ),
        }),
    }
}

/// Level 1: page a Claude Code session transcript.
///
/// The path is not guessed — it arrives free in the `transcript_path` of every `Stop` hook line, so
/// Level 0 already carries it. It is nonetheless CONFINED to the Claude projects roots: the value
/// originates in a hook payload, i.e. outside our trust boundary, and an unconfined read here would
/// be an arbitrary-file-read oracle reachable from the concierge. Same reasoning as the confinement
/// on `hooks::read_events_since`.
/// `async` + `spawn_blocking` for the same reason as [`fleet_digest`]. Doubly so here: besides the
/// read itself, root resolution parses `accounts.json`, enumerates the account stores on disk, and
/// can run a LOGIN SHELL on its first call (`effective_spawn_config_dir`, 100-500ms, cached per
/// process) — none of which may happen on the UI thread.
#[tauri::command]
pub async fn fleet_read_transcript(
    app: AppHandle,
    transcript_path: String,
    cursor: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<StreamPage, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    let cursor = cursor.unwrap_or(0);
    let max_bytes = max_bytes.unwrap_or(PAGE_MAX_BYTES);

    tauri::async_runtime::spawn_blocking(move || {
        read_transcript_at(&app_data, &transcript_path, cursor, max_bytes)
    })
    .await
    .map_err(|e| format!("fleet_read_transcript task failed: {e}"))?
}

/// The command's whole body, taking `app_data` rather than an `AppHandle` so the REAL root
/// resolution — accounts.json included — is what the tests exercise. Extracting this is not
/// cosmetic: the previous round's tests all passed a hand-built `roots` slice straight to
/// `read_transcript_within`, so they proved only that the read works GIVEN the right roots, and the
/// bug that the roots were wrong fell straight through the gap.
fn read_transcript_at(
    app_data: &Path,
    transcript_path: &str,
    cursor: u64,
    max_bytes: u64,
) -> Result<StreamPage, String> {
    let (roots, metadata_error) = transcript_roots(app_data);
    if roots.is_empty() {
        // Distinct from a confinement refusal on purpose: this is "we cannot tell where transcripts
        // live", not "you asked for something you may not have".
        return Err(match metadata_error {
            Some(e) => format!("fleet_read_transcript: cannot resolve a Claude projects root: {e}"),
            None => "fleet_read_transcript: cannot resolve a Claude projects root".to_string(),
        });
    }
    read_transcript_within(&roots, metadata_error.as_deref(), transcript_path, cursor, max_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(ts: i64, event: &str, extra: &str) -> String {
        if extra.is_empty() {
            format!(r#"{{"ts":{ts},"event":"{event}"}}"#)
        } else {
            format!(r#"{{"ts":{ts},"event":"{event}",{extra}}}"#)
        }
    }

    // ---- parse_hook_tail -------------------------------------------------------------------

    #[test]
    fn reduces_a_stream_to_last_event_and_windowed_counts() {
        let now = 1_000_000i64;
        let window = 10_000i64;
        let log = [
            // Outside the window: must NOT be counted, but is still eligible to be "last" if newest.
            line(now - 50_000, "UserPromptSubmit", ""),
            line(now - 50_000, "PostToolUse", r#""tool":"Bash""#),
            // Inside the window.
            line(now - 5_000, "UserPromptSubmit", ""),
            line(now - 4_000, "PostToolUse", r#""tool":"Read""#),
            line(now - 3_000, "PostToolUse", r#""tool":"Edit""#),
            line(now - 2_000, "Stop", r#""transcript_path":"/tmp/t.jsonl","session_id":"s1""#),
        ]
        .join("\n");

        let f = parse_hook_tail(log.as_bytes(), false, now, window);

        assert_eq!(f.last_event.as_deref(), Some("Stop"));
        assert_eq!(f.last_event_ms, Some(now - 2_000));
        assert_eq!(f.last_turn_end_ms, Some(now - 2_000));
        assert_eq!(f.session_id.as_deref(), Some("s1"));
        assert_eq!(f.transcript_path.as_deref(), Some("/tmp/t.jsonl"));
        // The out-of-window turn and tool are excluded — this is the assertion that would fail if
        // the window were ignored and everything counted.
        assert_eq!(f.turns_recent, 1);
        assert_eq!(f.tools_recent, 2);
        assert_eq!(f.recent_tools, vec!["Read".to_string(), "Edit".to_string()]);
        assert_eq!(f.lines_scanned, 6);
        assert!(!f.tail_truncated);
    }

    #[test]
    fn drops_the_partial_first_line_of_a_truncated_read() {
        let now = 1_000i64;
        // A fragment of a longer line, as a mid-file seek produces, then two whole records.
        let log = format!(
            "ts\":900,\"event\":\"PostToolUse\"}}\n{}\n{}",
            line(950, "PostToolUse", r#""tool":"Read""#),
            line(960, "Stop", "")
        );

        let truncated = parse_hook_tail(log.as_bytes(), true, now, 10_000);
        assert_eq!(truncated.lines_scanned, 2, "the fragment must not be parsed as a record");
        assert!(truncated.tail_truncated);

        // And with truncated=false the same buffer keeps its (unparseable) first line skipped by
        // the JSON parser anyway — so the flag's effect is specifically on a line that WOULD parse.
        let whole = format!("{}\n{}", line(950, "PostToolUse", r#""tool":"Read""#), line(960, "Stop", ""));
        assert_eq!(parse_hook_tail(whole.as_bytes(), true, now, 10_000).lines_scanned, 1);
        assert_eq!(parse_hook_tail(whole.as_bytes(), false, now, 10_000).lines_scanned, 2);
    }

    #[test]
    fn a_later_line_without_a_field_does_not_erase_an_earlier_one() {
        let now = 1_000i64;
        let log = [
            line(900, "Stop", r#""session_id":"s1","transcript_path":"/tmp/a.jsonl""#),
            line(950, "PostToolUse", r#""tool":"Bash""#), // no session_id, no transcript_path
        ]
        .join("\n");
        let f = parse_hook_tail(log.as_bytes(), false, now, 10_000);
        assert_eq!(f.session_id.as_deref(), Some("s1"));
        assert_eq!(f.transcript_path.as_deref(), Some("/tmp/a.jsonl"));
        assert_eq!(f.last_event.as_deref(), Some("PostToolUse"));
    }

    #[test]
    fn malformed_and_empty_lines_are_skipped_without_failing_the_parse() {
        let now = 1_000i64;
        let log = format!(
            "not json\n\n{{\"ts\":1,\n{}\n{{\"ts\":950}}\n",
            line(950, "PostToolUse", r#""tool":"Read""#)
        );
        let f = parse_hook_tail(log.as_bytes(), false, now, 10_000);
        // Only the one well-formed line with a non-empty `event` counts.
        assert_eq!(f.lines_scanned, 1);
        assert_eq!(f.tools_recent, 1);
    }

    #[test]
    fn a_line_without_a_timestamp_is_counted_in_neither_direction() {
        let now = 1_000i64;
        let log = r#"{"event":"PostToolUse","tool":"Bash"}"#;
        let f = parse_hook_tail(log.as_bytes(), false, now, 10_000);
        assert_eq!(f.lines_scanned, 1, "it is still a record");
        assert_eq!(f.tools_recent, 0, "but it cannot be placed in the window");
        assert_eq!(f.last_event_ms, None);
    }

    #[test]
    fn recent_tools_keeps_the_newest_and_is_capped() {
        let now = 1_000_000i64;
        let mut lines = Vec::new();
        for i in 0..(RECENT_TOOLS_MAX + 10) {
            lines.push(line(now - 1_000, "PostToolUse", &format!(r#""tool":"T{i}""#)));
        }
        let f = parse_hook_tail(lines.join("\n").as_bytes(), false, now, 10_000);
        assert_eq!(f.recent_tools.len(), RECENT_TOOLS_MAX);
        // Newest survives, oldest is evicted.
        assert_eq!(f.recent_tools.last().unwrap(), &format!("T{}", RECENT_TOOLS_MAX + 9));
        assert_eq!(f.recent_tools.first().unwrap(), "T10");
        assert_eq!(f.tools_recent, (RECENT_TOOLS_MAX + 10) as u32);
    }

    #[test]
    fn an_empty_or_missing_log_reports_nothing_rather_than_zero_activity() {
        let f = parse_hook_tail(b"", false, 1_000, 10_000);
        assert_eq!(f.last_event, None);
        assert_eq!(f.last_event_ms, None);
        assert_eq!(f.lines_scanned, 0);
    }

    #[test]
    fn precompact_counts_toward_context_pressure() {
        let now = 1_000i64;
        let log = [line(900, "PreCompact", ""), line(950, "PreCompact", "")].join("\n");
        let f = parse_hook_tail(log.as_bytes(), false, now, 10_000);
        assert_eq!(f.compactions_recent, 2);
    }

    // ---- read_tail -------------------------------------------------------------------------

    #[test]
    fn read_tail_returns_only_the_tail_and_says_so() {
        let dir = std::env::temp_dir().join(format!("sparkle-fleet-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("log.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(&vec![b'a'; 100]).unwrap();
        f.write_all(b"TAIL").unwrap();
        drop(f);

        let (bytes, truncated) = read_tail(&path, 4).unwrap();
        assert_eq!(&bytes, b"TAIL");
        assert!(truncated);

        let (all, not_truncated) = read_tail(&path, 10_000).unwrap();
        assert_eq!(all.len(), 104);
        assert!(!not_truncated);

        assert!(read_tail(&dir.join("missing.jsonl"), 10).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- newest_write_ms -------------------------------------------------------------------

    #[test]
    fn walk_finds_the_newest_file_and_ignores_skipped_dirs() {
        let dir = std::env::temp_dir().join(format!("sparkle-fleet-walk-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();

        std::fs::write(dir.join("src").join("a.ts"), "x").unwrap();
        let (with_src, _) = newest_write_ms(&dir);
        assert!(with_src.is_some(), "a real file under src must be seen");

        // A file in a skipped dir must not move the answer. Written second, so it is strictly
        // newer — if the skip list were ignored, `newest` would change.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(dir.join("node_modules").join("dep.js"), "y").unwrap();
        let (after_skip, _) = newest_write_ms(&dir);
        assert_eq!(after_skip, with_src, "node_modules must not count as agent progress");

        // A real write does move it.
        std::fs::write(dir.join("src").join("b.ts"), "z").unwrap();
        let (after_real, _) = newest_write_ms(&dir);
        assert!(after_real > with_src, "a real source write must advance newest_write_ms");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn walk_of_a_missing_dir_reports_nothing_not_zero() {
        let (newest, truncated) = newest_write_ms(Path::new("/nonexistent/sparkle/fleet"));
        assert_eq!(newest, None);
        assert!(!truncated);
    }

    // ---- find_conflicts --------------------------------------------------------------------

    /// A LIVE agent that reported a diff. `worktree_exists: true` is not incidental — `agent_facts`
    /// cannot emit a read diff for a worktree that is gone, so a fixture with it false would encode
    /// a state the production path never produces.
    fn facts_with(id: &str, files: &[&str]) -> FleetAgentFacts {
        FleetAgentFacts {
            agent_id: id.to_string(),
            worktree_exists: true,
            git: GitFacts {
                changed_files: Some(files.iter().map(|s| s.to_string()).collect()),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// A LIVE agent whose `git diff` failed: `None`, which is NOT `Some(vec![])`. Recoverable —
    /// the tree is still there to re-read.
    fn facts_with_unreadable_diff(id: &str) -> FleetAgentFacts {
        FleetAgentFacts {
            agent_id: id.to_string(),
            worktree_exists: true,
            git: GitFacts { changed_files: None, ..Default::default() },
            ..Default::default()
        }
    }

    /// A spun-down agent: no tree, so `agent_facts` never attempted git at all. Its
    /// `changed_files: None` is not a read failure and must not be reported as one.
    fn facts_of_reaped_worktree(id: &str) -> FleetAgentFacts {
        FleetAgentFacts {
            agent_id: id.to_string(),
            worktree_exists: false,
            git: GitFacts::default(),
            ..Default::default()
        }
    }

    #[test]
    fn conflicts_are_paths_more_than_one_agent_changes() {
        let agents = vec![
            facts_with("a", &["src/ConciergeColumn.tsx", "src/only-a.ts"]),
            facts_with("b", &["src/ConciergeColumn.tsx", "src/only-b.ts"]),
            facts_with("c", &["src/ConciergeColumn.tsx"]),
        ];
        let conflicts = find_conflicts(&agents);
        assert_eq!(conflicts.len(), 1, "single-owner paths are not conflicts");
        assert_eq!(conflicts[0].path, "src/ConciergeColumn.tsx");
        assert_eq!(conflicts[0].agent_ids, vec!["a", "b", "c"]);
    }

    #[test]
    fn one_agent_touching_a_file_twice_is_not_a_conflict() {
        // Guards the dedup: without it, a duplicate path within one agent's list would look like
        // two owners and raise a false conflict.
        let agents = vec![facts_with("a", &["src/x.ts", "src/x.ts"])];
        assert!(find_conflicts(&agents).is_empty());
    }

    #[test]
    fn conflict_output_is_stable_across_runs() {
        let agents = vec![facts_with("z", &["p"]), facts_with("a", &["p"])];
        let first = find_conflicts(&agents);
        let second = find_conflicts(&agents);
        assert_eq!(first, second);
        assert_eq!(first[0].agent_ids, vec!["a", "z"], "ids are sorted, not insertion-ordered");
    }

    #[test]
    fn no_agents_and_no_changes_produce_no_conflicts() {
        assert!(find_conflicts(&[]).is_empty());
        assert!(find_conflicts(&[facts_with("a", &[])]).is_empty());
    }

    #[test]
    fn a_fleet_with_an_unread_diff_says_which_agent_it_could_not_look_at() {
        // The OBSERVABLE half of the skip, and the assertion that gives it teeth: `conflicts` is
        // byte-identical whether `b` was skipped or genuinely clean, so it can never carry this.
        // `diffs_unread` names `b`, which is what separates "nobody collides" from "we did not
        // look". Asserting only `conflicts.is_empty()` here would pass under either behaviour.
        let partly_read = vec![facts_with("a", &["src/x.ts"]), facts_with_unreadable_diff("b")];
        assert!(find_conflicts(&partly_read).is_empty(), "one known owner is not a conflict");
        assert_eq!(unread_diffs(&partly_read), vec!["b".to_string()]);

        // A fully-read fleet — including a genuinely CLEAN agent — reports nothing unread. This is
        // the pair that makes the assertion above meaningful: `c` contributes no paths either, and
        // must not be confused with `b`.
        let all_read = vec![facts_with("a", &["src/x.ts"]), facts_with("c", &[])];
        assert!(unread_diffs(&all_read).is_empty(), "a clean agent is not an unread one");

        // Sorted, so the digest is stable across runs like `conflicts` is.
        let many = vec![facts_with_unreadable_diff("z"), facts_with_unreadable_diff("a")];
        assert_eq!(unread_diffs(&many), vec!["a".to_string(), "z".to_string()]);
    }

    #[test]
    fn a_reaped_worktree_is_not_reported_as_an_unread_diff() {
        // A spun-down agent carries changed_files: None too, because agent_facts short-circuits its
        // whole git block when there is no tree — but that was never a read FAILURE, and a caller's
        // roster routinely holds long-dead agents. Counting them would leave diffs_unread
        // permanently non-empty, so "empty means every diff was read" could never fire, and the ids
        // would be unactionable since re-reading a deleted worktree fails forever.
        let mixed = vec![facts_with_unreadable_diff("live"), facts_of_reaped_worktree("gone")];
        assert_eq!(
            unread_diffs(&mixed),
            vec!["live".to_string()],
            "only the live worktree is a recoverable read failure"
        );

        // A fleet whose only None is a reaped tree is FULLY read — this is the assertion that makes
        // the signal clearable at all.
        assert!(unread_diffs(&[facts_of_reaped_worktree("gone")]).is_empty());
    }

    #[test]
    fn the_digest_carries_the_unread_diffs_alongside_the_conflicts() {
        // End-to-end through `build_digest`: a caller holding only the digest can tell whether
        // `conflicts` was computed over every agent's diff or over some of them.
        let dir = std::env::temp_dir().join(format!("sparkle-fleet-unread-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // `live` exists but is not a git repo at all, so its diff cannot be read. `reaped` has no
        // worktree — it also carries changed_files: None, but through the spun-down short-circuit
        // rather than a read failure, so it must NOT be named. Both go through the real
        // `agent_facts`, so neither fixture can describe a state production cannot emit.
        let d = build_digest(
            &[
                ("live".to_string(), dir.clone()),
                ("reaped".to_string(), dir.join("no-such-worktree")),
            ],
            &dir,
            "origin/main",
            1_000,
            10_000,
        );
        assert_eq!(d.agents.len(), 2);
        assert!(d.agents[0].worktree_exists, "live");
        assert!(!d.agents[1].worktree_exists, "reaped");
        assert_eq!(d.agents[0].git.changed_files, None, "no git here, so no diff");
        assert_eq!(d.agents[1].git.changed_files, None, "and no tree to diff either");
        assert_eq!(
            d.diffs_unread,
            vec!["live".to_string()],
            "the digest names the recoverable read failure, and only that one"
        );
        assert!(d.conflicts.is_empty(), "and reports no conflicts — on no data, which is the point");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_diff_serializes_as_null_and_a_clean_one_as_an_empty_array() {
        // The TS side keys on exactly this: `changedFiles: string[] | null`. A failed read that
        // serialized as `[]` would be indistinguishable from a clean branch on the far side of the
        // bridge, which is the whole defect.
        let failed = serde_json::to_value(&facts_with_unreadable_diff("b").git).unwrap();
        assert_eq!(failed.get("changedFiles").unwrap(), &serde_json::Value::Null);

        let clean = serde_json::to_value(&facts_with("c", &[]).git).unwrap();
        assert_eq!(clean.get("changedFiles").unwrap(), &serde_json::json!([]));
    }

    // ---- agent_facts / build_digest ---------------------------------------------------------

    #[test]
    fn a_spun_down_worktree_still_reports_its_hook_history() {
        let dir = std::env::temp_dir().join(format!("sparkle-fleet-gone-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("agent.jsonl");
        std::fs::write(&log, format!("{}\n", line(900, "Stop", ""))).unwrap();

        let facts = agent_facts("agent", &dir.join("no-such-worktree"), &log, "origin/main", 1_000, 10_000);
        assert!(!facts.worktree_exists);
        assert_eq!(facts.hooks.last_event.as_deref(), Some("Stop"), "the log outlives the worktree");
        assert_eq!(facts.git, GitFacts::default(), "nothing is invented about a tree that is gone");
        assert_eq!(facts.newest_write_ms, None);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn digest_carries_the_window_and_the_conflicts_together() {
        let dir = std::env::temp_dir().join(format!("sparkle-fleet-digest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let d = build_digest(&[], &dir, "origin/main", 1_234, 5_678);
        assert_eq!(d.generated_at_ms, 1_234);
        assert_eq!(d.window_ms, 5_678);
        assert!(d.agents.is_empty());
        assert!(d.conflicts.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- git observations, against a REAL git worktree ---------------------------------------

    /// A real git repo in a temp dir, ready to commit into. Routed through `crate::worktree::git`
    /// so these fixture commits inherit the suite's `core.hooksPath` isolation (see
    /// `worktree::apply_test_hook_isolation`) and cannot fire a developer's global git hooks.
    fn git_repo(tag: &str) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("sparkle-fleet-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let wt = dir.to_string_lossy().to_string();
        crate::worktree::git(&wt, &["init"]).expect("git init");
        // Local, not global: a committer identity the fixture owns, so committing works on a
        // machine with no user.email configured.
        crate::worktree::git(&wt, &["config", "user.email", "fleet-test@example.invalid"]).unwrap();
        crate::worktree::git(&wt, &["config", "user.name", "Fleet Test"]).unwrap();
        (dir, wt)
    }

    #[test]
    fn git_facts_counts_dirty_files_and_reads_the_commit_time() {
        // THE regression guard for the argument-order defect: `--no-optional-locks` is a TOP-LEVEL
        // git option, and `git status --porcelain --no-optional-locks` exits 129 with "unknown
        // option". With the flag misplaced every one of these `dirty_files` reads is None, so the
        // whole dirty-file signal this module exists for is silently off for every agent.
        let (dir, wt) = git_repo("git-facts");

        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        let before = git_facts(&wt, "HEAD");
        assert_eq!(before.dirty_files, Some(1), "one uncommitted file is one dirty path");
        assert_eq!(before.last_commit_ms, None, "nothing is committed yet");

        // An untracked DIRECTORY is where a plain `--porcelain` lies: git's default untracked mode
        // collapses `src/newmod/` to a single `?? src/newmod/` line, so an agent that just wrote a
        // whole new module reports one dirty file. The count has to see through that, because it is
        // rendered to a human as "N uncommitted files" and drives an escalation decision.
        std::fs::create_dir_all(dir.join("src").join("newmod")).unwrap();
        std::fs::write(dir.join("src").join("newmod").join("a.rs"), "x").unwrap();
        std::fs::write(dir.join("src").join("newmod").join("b.rs"), "y").unwrap();
        assert_eq!(
            git_facts(&wt, "HEAD").dirty_files,
            Some(3),
            "two files in an untracked dir count as two, not as one collapsed `?? src/newmod/`"
        );

        crate::worktree::git(&wt, &["add", "-A"]).unwrap();
        crate::worktree::git(&wt, &["commit", "-m", "first"]).unwrap();

        let after = git_facts(&wt, "HEAD");
        assert_eq!(after.dirty_files, Some(0), "a committed tree is clean — Some(0), not None");
        assert!(after.last_commit_ms.is_some(), "a committed branch has a tip commit time");
        assert!(after.branch.is_some(), "the worktree is on a named branch");
        // Base == HEAD, so the diff SUCCEEDS and is legitimately empty: Some(vec![]), never None.
        assert_eq!(after.changed_files, Some(vec![]), "a readable, empty diff is Some, not None");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unresolvable_base_leaves_changed_files_none_rather_than_empty() {
        // The real-world trigger: `origin/main` was never fetched into this worktree, so
        // `git diff --name-only origin/main...HEAD` hard-fails. Reported as an empty list it would
        // read as "this agent changed nothing" and silence conflict detection fleet-wide.
        let (dir, wt) = git_repo("git-facts-base");
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        crate::worktree::git(&wt, &["add", "-A"]).unwrap();
        crate::worktree::git(&wt, &["commit", "-m", "first"]).unwrap();

        let unfetched = git_facts(&wt, "origin/main");
        assert_eq!(unfetched.changed_files, None, "an unreadable diff is None, not an empty list");
        assert_eq!(unfetched.ahead, None, "and the ahead count against a missing base is unknown");
        // The reads that do NOT depend on the base still answer — the point of per-command options.
        assert_eq!(unfetched.dirty_files, Some(0));
        assert!(unfetched.last_commit_ms.is_some());

        // Against a base that DOES resolve, the same worktree reports the file it changed. `...`
        // needs two COMMITS on both sides, so the base here is the first commit and the change
        // under test is a second one on top of it.
        let base = crate::worktree::git(&wt, &["rev-parse", "HEAD"]).unwrap();
        std::fs::write(dir.join("b.txt"), "world").unwrap();
        crate::worktree::git(&wt, &["add", "-A"]).unwrap();
        crate::worktree::git(&wt, &["commit", "-m", "second"]).unwrap();

        let resolved = git_facts(&wt, &base);
        assert_eq!(resolved.changed_files, Some(vec!["b.txt".to_string()]));
        assert_eq!(resolved.ahead, Some(1), "one commit past the base");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_worktree_git_cannot_read_reports_none_not_clean() {
        // The module's doctrine: None means WE COULD NOT TELL. A path that is not a git worktree
        // must not be reported as `Some(0)` dirty files, which reads as "this agent is clean".
        let dir = std::env::temp_dir().join(format!("sparkle-fleet-nogit-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let facts = git_facts(&dir.to_string_lossy(), "HEAD");
        assert_eq!(facts.dirty_files, None, "a failed git read is None, never Some(0)");
        assert_eq!(facts.last_commit_ms, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- read_page: the Level 1 paging contract ---------------------------------------------

    fn tmp_file(tag: &str, contents: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("sparkle-fleet-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.jsonl");
        std::fs::write(&path, contents).unwrap();
        (dir, path)
    }

    #[test]
    fn paging_walks_the_whole_file_and_loses_nothing() {
        // THE regression guard for this feature: the existing terminal read drops the front of a
        // long stream silently. Paging must reassemble byte-for-byte.
        let all: Vec<String> = (0..500).map(|i| format!(r#"{{"n":{i}}}"#)).collect();
        let (dir, path) = tmp_file("page-all", &format!("{}\n", all.join("\n")));

        let mut collected: Vec<String> = Vec::new();
        let mut cursor = 0u64;
        let mut pages = 0;
        loop {
            let page = read_page(&path, cursor, 256).unwrap();
            assert!(!page.partial_line, "these records all fit the budget; none may be split");
            collected.extend(page.lines.clone());
            pages += 1;
            assert!(pages < 1000, "paging must terminate");
            if page.eof {
                assert_eq!(page.remaining_bytes, 0);
                break;
            }
            assert!(page.next_cursor > cursor, "cursor must advance or the caller loops forever");
            cursor = page.next_cursor;
        }
        assert!(pages > 1, "a 256-byte budget over this file must take several pages");
        assert_eq!(collected, all, "every line survives paging, in order");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_page_reports_what_it_left_behind() {
        let (dir, path) = tmp_file("page-remaining", "aaaa\nbbbb\ncccc\n"); // 15 bytes
        let page = read_page(&path, 0, 5).unwrap();
        assert_eq!(page.lines, vec!["aaaa".to_string()]);
        assert_eq!(page.next_cursor, 5);
        assert_eq!(page.remaining_bytes, 10, "the caller must be told there is more");
        assert!(!page.eof);
        assert_eq!(page.total_bytes, 15);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_page_never_splits_a_line() {
        // Budget lands mid-record; the partial line must be left for the next page.
        let (dir, path) = tmp_file("page-split", "aaaa\nbbbb\n");
        let page = read_page(&path, 0, 7).unwrap();
        assert_eq!(page.lines, vec!["aaaa".to_string()], "no half of 'bbbb'");
        assert_eq!(page.next_cursor, 5, "cursor stops at the record boundary");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_line_longer_than_the_budget_still_advances_and_admits_the_split() {
        // Without the no-newline fallback the cursor would stick at 0 and a caller would loop. But
        // the fallback SPLITS the record, and returning that fragment as if it were a whole line is
        // what a JSONL caller cannot survive — Claude Code transcript lines routinely exceed the
        // 64 KiB budget, so this is the common path, not an edge case.
        let (dir, path) = tmp_file("page-long", &format!("{}\n", "x".repeat(100)));
        let page = read_page(&path, 0, 10).unwrap();
        assert!(page.next_cursor > 0, "must make progress on an over-long line");
        assert_eq!(page.lines.len(), 1);
        assert_eq!(page.lines[0], "x".repeat(10), "the fragment is the budget's worth, not the record");
        assert!(page.partial_line, "and the page must SAY the record was split");
        assert!(!page.eof);

        // Paging on, the caller can reassemble: the rest of the record arrives, and the final page
        // is not flagged because it completes the line.
        let rest = read_page(&path, page.next_cursor, 1024).unwrap();
        assert!(!rest.partial_line, "the page that finishes the record is whole");
        assert_eq!(
            format!("{}{}", page.lines[0], rest.lines[0]),
            "x".repeat(100),
            "the record is recoverable across the split"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_page_that_stops_at_a_record_boundary_is_not_flagged_partial() {
        // The counter-case that gives `partial_line` meaning: a budget landing mid-record still
        // returns only whole lines (it stops at the newline), so the flag must stay false. Without
        // this pair, a `partial_line` hardcoded to true would pass the test above.
        let (dir, path) = tmp_file("page-notpartial", "aaaa\nbbbb\n");
        let page = read_page(&path, 0, 7).unwrap();
        assert_eq!(page.lines, vec!["aaaa".to_string()]);
        assert!(!page.partial_line, "stopping at a newline is not a split");
        assert_eq!(page.remaining_bytes, 5, "'bbbb\\n' is still ahead");

        // A file whose FINAL line has no trailing newline: the unterminated tail is held back for
        // the next page (the normal "a remainder is a write in progress" rule), and the page that
        // then returns it is at EOF, so that line is whole — not split. This is the case that makes
        // `partial_line` test `remaining_bytes` rather than just "no newline found".
        let (dir2, path2) = tmp_file("page-noeol", "aaaa\nbbbb");
        let first = read_page(&path2, 0, 1024).unwrap();
        assert_eq!(first.lines, vec!["aaaa".to_string()], "the unterminated tail waits");
        assert!(!first.partial_line);
        assert!(!first.eof, "there is a remainder");

        let last = read_page(&path2, first.next_cursor, 1024).unwrap();
        assert_eq!(last.lines, vec!["bbbb".to_string()]);
        assert!(last.eof);
        assert!(!last.partial_line, "unterminated at EOF is complete, not split");

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&dir2).ok();
    }

    #[test]
    fn an_over_long_line_is_cut_on_a_utf8_boundary_so_the_join_is_lossless() {
        // The ASCII fixture above is the ONE input for which a byte-offset cut happens to be
        // lossless, so it could not see this. Cutting mid-sequence makes `from_utf8_lossy` plant a
        // U+FFFD at the tail of page N and another at the head of page N+1 — the character is
        // DESTROYED, not deferred, so the reassembly `partial_line` advertises silently corrupts.
        // Transcript JSONL is full of non-ASCII, and the lines being split are the largest ones.
        let original = "é".repeat(50); // 100 bytes, 50 chars
        let (dir, path) = tmp_file("page-utf8", &format!("{original}\n"));

        // 11 bytes lands inside the 6th 'é' (bytes 10..12).
        let page = read_page(&path, 0, 11).unwrap();
        assert!(page.partial_line);
        assert_eq!(page.next_cursor, 10, "the cursor stops on a character boundary, not at 11");
        assert!(!page.lines[0].contains('\u{FFFD}'), "no replacement char may be emitted");

        let rest = read_page(&path, page.next_cursor, 1024).unwrap();
        assert!(!rest.lines[0].contains('\u{FFFD}'), "and none at the head of the next page");
        assert_eq!(
            format!("{}{}", page.lines[0], rest.lines[0]),
            original,
            "the record must survive the split byte-for-byte"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_budget_too_small_for_one_character_still_advances() {
        // The guard on the boundary cut: if `valid_up_to()` is 0 there is no boundary to stop at,
        // and honouring it would park the cursor forever. Reachable because this command takes an
        // arbitrary caller-supplied cursor, which can land mid-character.
        let (dir, path) = tmp_file("page-tiny", &format!("{}\n", "é".repeat(4)));
        let page = read_page(&path, 0, 1).unwrap();
        assert!(page.next_cursor > 0, "must not stick");
        assert!(page.partial_line);

        // And a cursor the caller placed mid-character still makes progress rather than parking.
        let mid = read_page(&path, 1, 2).unwrap();
        assert!(mid.next_cursor > 1, "must not stick on a mid-character cursor either");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_partial_line_flag_serializes_as_partial_line_camel_case() {
        // Pins the wire name the TS mirror is CONTRACTED to use. Asserts the Rust side only — as of
        // this commit `conciergeTools/fleet.ts` has not added the field, so the consumer cannot read
        // the flag. That half is tracked as bead `sparkle-suv6`, not assumed done.
        let (dir, path) = tmp_file("page-serde", &format!("{}\n", "x".repeat(100)));
        let v = serde_json::to_value(read_page(&path, 0, 10).unwrap()).unwrap();
        assert_eq!(v.get("partialLine").unwrap(), &serde_json::Value::Bool(true));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stale_cursor_past_the_end_restarts_rather_than_erroring() {
        // retention.rs reaps and rewrites these logs, so a stale cursor is expected, not a bug.
        let (dir, path) = tmp_file("page-stale", "aaaa\n");
        let page = read_page(&path, 9_999, 1024).unwrap();
        assert_eq!(page.lines, vec!["aaaa".to_string()]);
        assert!(page.eof);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_file_is_an_empty_eof_page_not_an_error() {
        let page = read_page(Path::new("/nonexistent/sparkle/fleet.jsonl"), 0, 1024).unwrap();
        assert!(page.lines.is_empty());
        assert!(page.eof);
        assert_eq!(page.total_bytes, 0);
    }

    #[test]
    fn an_empty_file_reports_eof_immediately() {
        let (dir, path) = tmp_file("page-empty", "");
        let page = read_page(&path, 0, 1024).unwrap();
        assert!(page.lines.is_empty());
        assert!(page.eof);
        assert_eq!(page.remaining_bytes, 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_page_budget_is_clamped_to_the_hard_ceiling() {
        // A caller (or a hallucinating model) asking for a gigabyte gets the ceiling, not the ask.
        let (dir, path) = tmp_file("page-clamp", "aaaa\n");
        let page = read_page(&path, 0, u64::MAX).unwrap();
        assert!(page.eof, "clamping must not break a small read");
        assert_eq!(page.lines, vec!["aaaa".to_string()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn transcript_reads_outside_the_claude_projects_dir_are_refused() {
        // transcript_path originates in a hook payload — outside our trust boundary. Unconfined,
        // this command would be an arbitrary-file-read oracle reachable from the concierge. Goes
        // through `read_transcript_at`, i.e. the REAL resolver, so it pins that no root it produces
        // ever admits these.
        let app_data = std::env::temp_dir().join(format!("sparkle-fleet-ad-out-{}", std::process::id()));
        std::fs::create_dir_all(&app_data).unwrap();

        let err = read_transcript_at(&app_data, "/etc/passwd", 0, 1024).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");

        let err = read_transcript_at(&app_data, "/tmp/not-a-transcript.jsonl", 0, 1024).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");

        std::fs::remove_dir_all(&app_data).ok();
    }

    #[test]
    fn a_registered_accounts_transcript_reads_rather_than_being_refused() {
        // THE test the previous round was missing, and the gap the real bug fell through: every
        // positive test there handed `read_transcript_within` a roots slice built by hand, proving
        // only that the read works GIVEN correct roots. This one goes through the real resolver.
        //
        // Multi-account support sets CLAUDE_CONFIG_DIR on the CHILD's exec string only, so
        // Sparkle's own env and login shell never see an account's dir. accounts.json is the only
        // authoritative source, and reading it is what makes this transcript reachable.
        let app_data = std::env::temp_dir().join(format!("sparkle-fleet-acct-{}", std::process::id()));
        std::fs::remove_dir_all(&app_data).ok();
        std::fs::create_dir_all(&app_data).unwrap();

        let acct_dir = app_data.join("accounts").join("ab12");
        let slug = acct_dir.join("projects").join("-Users-someone-proj");
        std::fs::create_dir_all(&slug).unwrap();
        let transcript = slug.join("sess.jsonl");
        std::fs::write(&transcript, "{\"role\":\"user\"}\n").unwrap();

        std::fs::write(
            app_data.join("accounts.json"),
            serde_json::json!([{
                "id": "ab12",
                "nickname": "second max",
                "configDir": acct_dir.to_string_lossy(),
                "isDefault": false,
                "createdAt": 1_700_000_000i64,
            }])
            .to_string(),
        )
        .unwrap();

        // The account's root must appear among the resolved roots...
        let (roots, _) = transcript_roots(&app_data);
        assert!(
            roots.contains(&acct_dir.join("projects")),
            "the registered account's projects root must be allowed; got {roots:?}"
        );
        // ...and the transcript under it must actually READ, not be refused as outside.
        let page = read_transcript_at(&app_data, &transcript.to_string_lossy(), 0, 1024)
            .expect("a registered account's transcript must be readable");
        assert_eq!(page.lines, vec!["{\"role\":\"user\"}".to_string()]);

        std::fs::remove_dir_all(&app_data).ok();
    }

    #[test]
    fn an_orphaned_account_store_is_readable_but_a_path_outside_every_root_is_not() {
        // POLICY, stated deliberately: the roots are the UNION of `spend::transcript_roots` (which
        // enumerates <app_data>/accounts/*/projects on DISK) and the accounts.json entries. So an
        // account store left behind by a best-effort removal — no metadata entry, tree still there —
        // is readable. Refusing it would make that agent's transcripts report a confinement
        // violation, the exact false accusation this series removes, and it is a directory Sparkle
        // created and already scans for Spend. The Spend pane and this command must not disagree
        // about the same boundary.
        let app_data = std::env::temp_dir().join(format!("sparkle-fleet-orphan-{}", std::process::id()));
        std::fs::remove_dir_all(&app_data).ok();
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::write(app_data.join("accounts.json"), "[]").unwrap();

        let orphan = app_data.join("accounts").join("no-metadata").join("projects").join("slug");
        std::fs::create_dir_all(&orphan).unwrap();
        let f = orphan.join("x.jsonl");
        std::fs::write(&f, "kept\n").unwrap();
        let page = read_transcript_at(&app_data, &f.to_string_lossy(), 0, 1024)
            .expect("an orphaned account store is still a Sparkle transcript root");
        assert_eq!(page.lines, vec!["kept".to_string()]);

        // THE assertions that pin the widened boundary, and that can actually fail. Widening to
        // "any <app_data>/accounts/*/projects" must NOT widen to the account dir itself: its
        // siblings of projects/ hold that account's `.claude.json`, which carries the `oauthAccount`
        // identity and project history. These are refused only because the roots end in `projects`
        // and `Path::starts_with` is component-wise — a property nothing asserted until now, and one
        // a future "just add the account dir as a root" edit would silently turn into a read oracle
        // for account credentials reachable from a hook-supplied path.
        let identity = app_data.join("accounts").join("no-metadata").join(".claude.json");
        std::fs::write(&identity, "{\"oauthAccount\":{}}").unwrap();
        let err = read_transcript_at(&app_data, &identity.to_string_lossy(), 0, 1024).unwrap_err();
        assert!(err.contains("outside"), "account identity must stay unreadable, got: {err}");

        let err = read_transcript_at(&app_data, &app_data.join("accounts.json").to_string_lossy(), 0, 1024)
            .unwrap_err();
        assert!(err.contains("outside"), "app-data files must stay unreadable, got: {err}");

        // And the coarse case, for completeness — though note this one would pass against almost
        // any implementation, which is why it is not carrying the boundary on its own.
        let err = read_transcript_at(&app_data, "/etc/passwd", 0, 1024).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");

        std::fs::remove_dir_all(&app_data).ok();
    }

    #[test]
    fn a_corrupt_accounts_json_reports_a_resolve_failure_not_a_confinement_violation() {
        // The read the whole fix depends on was `unwrap_or_default()`, so an unparseable
        // accounts.json silently became "zero accounts". The $HOME fallback kept the root list
        // non-empty, so the "cannot tell where transcripts live" branch never fired, and every
        // non-default-account read came back as "outside the allowed roots" — the misleading
        // security accusation this series exists to remove, reachable through a corrupt file.
        let app_data = std::env::temp_dir().join(format!("sparkle-fleet-badjson-{}", std::process::id()));
        std::fs::remove_dir_all(&app_data).ok();
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::write(app_data.join("accounts.json"), "not json").unwrap();

        // The metadata failure is CARRIED, not thrown: the roots that do not depend on it still
        // resolve.
        let (roots, metadata_error) = transcript_roots(&app_data);
        assert!(metadata_error.is_some(), "the parse failure must be recorded");
        assert!(!roots.is_empty(), "the $HOME and on-disk roots do not need accounts.json");

        // A path outside everything resolvable names the CAUSE rather than accusing the caller —
        // accounts.json might have named the very root that would have admitted it.
        let err = read_transcript_at(&app_data, "/some/agent/transcript.jsonl", 0, 1024).unwrap_err();
        assert!(err.contains("cannot resolve"), "the failure must name the cause, got: {err}");
        assert!(!err.contains("is outside"), "and must not blame the caller, got: {err}");

        std::fs::remove_dir_all(&app_data).ok();
    }

    #[test]
    fn a_corrupt_accounts_json_does_not_block_reads_that_never_needed_it() {
        // The over-correction this guards: propagating the accounts.json error with `?` made that
        // file a hard gate on EVERY read, even though `spend::transcript_roots` enumerates the
        // account stores from DISK and the $HOME fallback needs no metadata at all. A transient
        // EACCES then refused stores sitting right there — while the Spend pane, which never reads
        // accounts.json, went on scanning exactly what the concierge could no longer open.
        let app_data = std::env::temp_dir().join(format!("sparkle-fleet-degrade-{}", std::process::id()));
        std::fs::remove_dir_all(&app_data).ok();
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::write(app_data.join("accounts.json"), "{ corrupt").unwrap();

        let slug = app_data.join("accounts").join("ab12").join("projects").join("slug");
        std::fs::create_dir_all(&slug).unwrap();
        let transcript = slug.join("sess.jsonl");
        std::fs::write(&transcript, "{\"ok\":1}\n").unwrap();

        let page = read_transcript_at(&app_data, &transcript.to_string_lossy(), 0, 1024)
            .expect("a store found on disk must read despite unreadable metadata");
        assert_eq!(page.lines, vec!["{\"ok\":1}".to_string()]);

        std::fs::remove_dir_all(&app_data).ok();
    }

    // ---- transcript confinement: the allowed roots, and missing vs outside --------------------

    /// `<tmp>/<tag>/projects/<slug>/` — the real transcript layout, one project-slug deep.
    fn transcript_root(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let home = std::env::temp_dir().join(format!("sparkle-fleet-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&home).ok();
        let root = home.join("projects");
        let slug = root.join("-Users-someone-proj");
        std::fs::create_dir_all(&slug).unwrap();
        (home, root, slug)
    }

    #[test]
    fn a_transcript_under_a_resolved_root_is_actually_readable() {
        // THE positive case, and the one finding 4 is about: before the fix the only test here was
        // negative, so a confinement rule that refused EVERYTHING passed the suite.
        let (home, root, slug) = transcript_root("tx-read");
        let path = slug.join("session.jsonl");
        std::fs::write(&path, "{\"a\":1}\n{\"a\":2}\n").unwrap();

        let page = read_transcript_within(&[root], None, &path.to_string_lossy(), 0, 1024).unwrap();
        assert_eq!(page.lines, vec!["{\"a\":1}".to_string(), "{\"a\":2}".to_string()]);
        assert!(page.eof);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn every_registered_account_root_is_allowed_alongside_the_home_fallback() {
        // An agent on a non-default account writes its transcript under <config_dir>/projects, and
        // accounts.json is the ONLY place that dir is knowable — the app sets CLAUDE_CONFIG_DIR on
        // the child's exec string, so `env_config_dir` here is "" on a normal launch. That is the
        // shape production actually produces, which is why it is the shape under test.
        let home = Path::new("/home/someone");
        let accounts = vec![
            "/data/accounts/ab12".to_string(),
            // The imported default account: EMPTY means "export no CLAUDE_CONFIG_DIR", which
            // resolves to the $HOME root and must dedup rather than appear twice.
            String::new(),
            "/data/accounts/cd34".to_string(),
        ];
        // The shared roots (what `spend::transcript_roots` enumerates from disk) come first, and an
        // account already covered by them does not appear twice.
        let shared = vec![PathBuf::from("/appdata/accounts/ab12/projects")];
        assert_eq!(
            transcript_roots_from(&shared, &accounts, "", Some(home)),
            vec![
                PathBuf::from("/appdata/accounts/ab12/projects"),
                PathBuf::from("/data/accounts/ab12/projects"),
                PathBuf::from("/home/someone/.claude/projects"),
                PathBuf::from("/data/accounts/cd34/projects"),
            ],
            "the shared roots, then accounts living outside app-data, then the $HOME fallback"
        );

        // A shared root that IS the $HOME fallback collapses rather than being listed twice.
        assert_eq!(
            transcript_roots_from(
                &[PathBuf::from("/home/someone/.claude/projects")],
                &[],
                "",
                Some(home)
            ),
            vec![PathBuf::from("/home/someone/.claude/projects")]
        );

        // Nothing anywhere: just the one fallback, not a duplicate pair.
        assert_eq!(
            transcript_roots_from(&[], &[], "", Some(home)),
            vec![PathBuf::from("/home/someone/.claude/projects")]
        );

        // A user who exported CLAUDE_CONFIG_DIR by hand is still honoured — a real configuration,
        // just not the one the app itself creates.
        assert_eq!(
            transcript_roots_from(&[], &[], "/home/someone/alt-claude", Some(home)),
            vec![
                PathBuf::from("/home/someone/alt-claude/projects"),
                PathBuf::from("/home/someone/.claude/projects"),
            ]
        );
    }

    #[test]
    fn a_reaped_transcript_is_an_empty_page_not_a_confinement_error() {
        // A transcript Claude Code's own retention deleted, or a rotated session, is a NOT-FOUND
        // condition. Reporting it as "outside the allowed roots" is a security accusation about a
        // routine event, and it made read_page's documented empty-eof behaviour unreachable.
        let (home, root, slug) = transcript_root("tx-reaped");
        let gone = slug.join("reaped.jsonl");

        assert_eq!(classify_transcript(&[root.clone()], &gone), TranscriptPath::Missing);
        let page = read_transcript_within(&[root], None, &gone.to_string_lossy(), 0, 1024).unwrap();
        assert!(page.lines.is_empty());
        assert!(page.eof);
        assert_eq!(page.total_bytes, 0);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn missing_and_outside_are_distinguished_not_collapsed() {
        // The assertion the OLD single test could not make: it passed for both inputs, because both
        // produced the same "outside" error. These two paths must land on different verdicts.
        let (home, root, slug) = transcript_root("tx-distinct");
        let missing_inside = slug.join("nope.jsonl");
        let outside = PathBuf::from("/etc/passwd");

        assert_eq!(classify_transcript(&[root.clone()], &missing_inside), TranscriptPath::Missing);
        assert_eq!(classify_transcript(&[root.clone()], &outside), TranscriptPath::Outside);

        // And that difference is visible to a caller: one reads, the other refuses.
        assert!(read_transcript_within(&[root.clone()], None, &missing_inside.to_string_lossy(), 0, 8).is_ok());
        let err = read_transcript_within(&[root], None, &outside.to_string_lossy(), 0, 8).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn an_absent_projects_root_reports_not_found_rather_than_a_security_violation() {
        // On a machine that has never run Claude Code the projects dir does not exist, so
        // canonicalizing the base fails and the old code called EVERY read a confinement violation.
        let nowhere = std::env::temp_dir()
            .join(format!("sparkle-fleet-tx-absent-{}", std::process::id()))
            .join("projects");
        std::fs::remove_dir_all(nowhere.parent().unwrap()).ok();
        let target = nowhere.join("slug").join("s.jsonl");

        assert_eq!(classify_transcript(&[nowhere.clone()], &target), TranscriptPath::Missing);
        let page = read_transcript_within(&[nowhere.clone()], None, &target.to_string_lossy(), 0, 64).unwrap();
        assert!(page.eof, "nothing to read, but not an error");

        // The lexical fallback that makes the line above possible must still reject traversal and
        // anything outside — there is no canonicalization left to resolve a `..` for us.
        assert_eq!(
            classify_transcript(&[nowhere.clone()], &nowhere.join("..").join("..").join("etc")),
            TranscriptPath::Outside
        );
        assert_eq!(
            classify_transcript(&[nowhere], Path::new("/somewhere/else/s.jsonl")),
            TranscriptPath::Outside
        );
    }

    #[test]
    fn confinement_resolves_symlinks_and_rejects_a_dangling_one() {
        let (home, root, slug) = transcript_root("tx-symlink");
        let secret = home.join("secret.jsonl");
        std::fs::write(&secret, "leak\n").unwrap();

        // A symlink planted INSIDE the root pointing out of it must not launder the read.
        let planted = slug.join("planted.jsonl");
        std::os::unix::fs::symlink(&secret, &planted).unwrap();
        assert_eq!(classify_transcript(&[root.clone()], &planted), TranscriptPath::Outside);

        // A DANGLING symlink is refused too: its target could be created later, pointing anywhere.
        let dangling = slug.join("dangling.jsonl");
        std::os::unix::fs::symlink(home.join("does-not-exist.jsonl"), &dangling).unwrap();
        assert_eq!(classify_transcript(&[root.clone()], &dangling), TranscriptPath::Outside);

        // `..` inside an existing tree is resolved by canonicalize and lands outside.
        assert_eq!(
            classify_transcript(&[root], &slug.join("..").join("..").join("secret.jsonl")),
            TranscriptPath::Outside
        );
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn worker_task_and_result_are_read_when_present() {
        let dir = std::env::temp_dir().join(format!("sparkle-fleet-worker-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".sparkle")).unwrap();
        std::fs::write(dir.join(".sparkle").join("worker.json"), r#"{"task":"fix the thing"}"#).unwrap();
        std::fs::write(dir.join(".sparkle").join("result.json"), r#"{"status":"success"}"#).unwrap();
        let (task, status) = worker_facts(&dir);
        assert_eq!(task.as_deref(), Some("fix the thing"));
        assert_eq!(status.as_deref(), Some("success"));

        // Absent files are None, not empty strings.
        std::fs::remove_file(dir.join(".sparkle").join("result.json")).unwrap();
        let (_, gone) = worker_facts(&dir);
        assert_eq!(gone, None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
