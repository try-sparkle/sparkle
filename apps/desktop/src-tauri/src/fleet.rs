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
//! artifacts costs no agent TURN. That is the sense in which it is "free", and the only sense —
//! measured, a pass costs ~0.27s per agent (the git spawns plus a bounded walk), so at 30 agents
//! it was ~8s of work against what used to be a ten-second poll. It runs every THIRTY seconds now,
//! and an agent whose worktree, HEAD, index and base ref have not moved is served from a memo
//! without spawning git at all. So: liveness and progress come from here,
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

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
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
    /// [`branch_and_dirty`]). `None` = git could not tell us; it is NOT `Some(0)`.
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

/// Everything ONE walk of a worktree yields: the reported newest-write value, plus the extra
/// signals that let [`git_fingerprint`] decide whether git could possibly have anything new to say.
///
/// `newest_file_ms` is the only field with a consumer outside this module — it is what
/// [`newest_write_ms`] returns and what "did the agent write anything" means. The other three exist
/// solely to make the memo SOUND, and each covers a mutation `newest_file_ms` alone cannot see:
///
///   * `newest_dir_ms` — a DELETION. Removing a file bumps its parent directory's mtime but leaves
///     no file behind to observe, so a delete-only change is completely invisible to a files-only
///     scan while it plainly changes `git status`. Without this the memo would serve a stale dirty
///     count for as long as the agent deleted-and-did-nothing-else.
///   * `entries` — an add/remove pair inside one budget window that happens to leave both mtimes
///     unchanged (same-second churn on a coarse filesystem clock).
///   * `truncated` — a walk that gave up saw a DIFFERENT amount of the tree than one that did not,
///     so its other three numbers are not comparable to theirs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WalkStats {
    newest_file_ms: Option<i64>,
    newest_dir_ms: Option<i64>,
    entries: u32,
    truncated: bool,
}

/// Walk `root` once, skipping `WALK_SKIP_DIRS`, collecting every signal in [`WalkStats`].
///
/// Iterative rather than recursive so a pathological tree cannot blow the stack, and budgeted so a
/// worktree with an un-skipped dependency tree cannot make the digest unbounded.
fn walk_stats(root: &Path) -> WalkStats {
    let mut out =
        WalkStats { newest_file_ms: None, newest_dir_ms: None, entries: 0, truncated: false };
    let mut stack: Vec<(PathBuf, u32)> = vec![(root.to_path_buf(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        if depth > WALK_MAX_DEPTH {
            out.truncated = true;
            continue;
        }
        // Stat the directory we are ABOUT TO READ, rather than each subdirectory as we encounter it
        // as an entry. Same number of stats, but it includes `root` itself — and the root is where
        // agents overwhelmingly add, delete and rename files. Sampling only the subdirectories left
        // the top level of every worktree with no delete-detector at all, which is exactly the hole
        // `memo_recomputes_after_a_RENAME` exists to hold shut.
        if let Some(ms) = std::fs::metadata(&dir).ok().and_then(|m| m.modified().ok()).and_then(ms_of)
        {
            out.newest_dir_ms = Some(out.newest_dir_ms.map_or(ms, |n: i64| n.max(ms)));
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if out.entries >= WALK_MAX_ENTRIES {
                out.truncated = true;
                return out;
            }
            out.entries += 1;
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
                out.newest_file_ms = Some(out.newest_file_ms.map_or(ms, |n: i64| n.max(ms)));
            }
        }
    }
    out
}

/// Newest mtime of any file under `root`, skipping `WALK_SKIP_DIRS`. Returns
/// `(newest_ms, truncated)`; `truncated` means the budget ran out, so the value is a lower bound.
///
/// Files only — a directory's own mtime is deliberately NOT folded in here, because this value is
/// reported as "the newest thing the agent wrote" and a directory whose child was deleted did not
/// have anything written to it. [`walk_stats`] keeps that signal separately for the memo.
pub fn newest_write_ms(root: &Path) -> (Option<i64>, bool) {
    let s = walk_stats(root);
    (s.newest_file_ms, s.truncated)
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

/// Every `git` subprocess THIS MODULE spawns goes through here.
///
/// It exists so a test can count spawns. The per-pass cost of this module is dominated by the
/// number of `git` children it forks — on the reference machine (108 worktrees sharing one `.git`
/// with 552 branches) a trivial spawn costs ~48 ms purely in process setup and ref-store attach, so
/// "how many spawns per agent" IS the performance contract. A test that asserted on the returned
/// struct instead would pass identically against a version that forked five children per agent and
/// against one that forks two; only the count distinguishes them.
///
/// Counting is `cfg(test)` so production pays nothing. `crate::worktree::git` is deliberately NOT
/// counted directly: the test fixtures build their repos through it, and those setup commands are
/// not the thing under measurement.
fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    #[cfg(test)]
    tests::note_git_spawn();
    crate::worktree::git(cwd, args)
}

/// The two facts a single `status --porcelain=v2 --branch` yields: the checked-out branch and the
/// count of dirty paths. `None` on either = git could not tell us, NOT "clean" / "detached".
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
///
/// WHY `--porcelain=v2 --branch` RATHER THAN TWO COMMANDS. `v2`'s `--branch` header carries
/// `# branch.head <name>`, which is exactly what `rev-parse --abbrev-ref HEAD` used to be spawned
/// separately to learn. Both facts come out of one process, so this is a spawn per agent per pass
/// removed for free — measured at ~48 ms of pure fork/attach overhead each on a checkout with 552
/// branches. The entry format changes (`?? path` becomes `? path`, `1 XY …` replaces ` M path`) but
/// nothing here parses the entries: they are COUNTED, and every header line is prefixed `#`, so the
/// count is "non-`#`, non-empty lines" in either format.
///
/// ONE ANSWER GENUINELY CHANGES, and it changes for the better: on an UNBORN branch — a worktree
/// created but not yet committed into — `rev-parse --abbrev-ref HEAD` exits 128 ("ambiguous
/// argument 'HEAD'"), so the old reader reported `branch: None`, conflating "has not committed yet"
/// with "detached, or we could not read this worktree at all". `--porcelain=v2 --branch` answers
/// `# branch.oid (initial)` alongside the real branch name, which is what `git status` tells a
/// human. Measured against the real fleet this was 1 worktree in 117, and it is the ONLY field that
/// differs across all of them. The facts that really do need a commit (`ahead`, `last_commit_ms`)
/// stay `None` there, as they must.
fn branch_and_dirty(worktree: &str) -> (Option<String>, Option<u32>) {
    let args =
        &["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=all"];
    let out = match git(worktree, args) {
        Ok(out) => out,
        Err(e) => {
            // `debug!`, not `warn!`: at 64 agents on a ten-second cadence a persistently
            // unreadable worktree (spun down mid-pass, mid-rebase) would flood the log. The text
            // is the whole git error, so the 129 above would have been one grep away.
            tracing::debug!(worktree, error = %e, "fleet: branch/dirty read unavailable; reporting None");
            return (None, None);
        }
    };

    let mut branch = None;
    let mut dirty: u32 = 0;
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            let name = rest.trim();
            // `(detached)` is v2's spelling of what `rev-parse --abbrev-ref HEAD` reported as the
            // literal string `HEAD`, and the old code filtered that to `None`. Same answer, so a
            // detached worktree keeps reporting "no branch" rather than a branch named `(detached)`.
            if !name.is_empty() && name != "(detached)" {
                branch = Some(name.to_string());
            }
        } else if !line.starts_with('#') && !line.trim().is_empty() {
            dirty += 1;
        }
    }
    // Reached only when git SUCCEEDED, so an empty result really is a clean tree: `Some(0)` and
    // `None` are different answers and this is the line that keeps them apart.
    (branch, Some(dirty))
}

/// Commit time of a ref, epoch ms. `%ct` is the committer date, which is what "when did this agent
/// last land work" means; author date can be far older after a rebase.
fn last_commit_ms(worktree: &str, git_ref: &str) -> Option<i64> {
    let out = git(worktree, &["log", "-1", "--format=%ct", git_ref]).ok()?;
    out.trim().parse::<i64>().ok().map(|secs| secs * 1000)
}

// ---------------------------------------------------------------------------------------------
// The fleet-wide ref prepass
//
// WHY. Two of the five facts [`git_facts`] used to gather — `ahead` and `last_commit_ms` — depend
// on NOTHING but the branch TIP. They do not read the working tree, the index, or anything else
// that is per-worktree. And in this app every agent worktree is a LINKED worktree of one shared
// `.git`, so all of those tips live in ONE ref store that can be read in ONE spawn:
//
//   git for-each-ref --format='%(refname)<TAB>%(committerdate:unix)<TAB>%(ahead-behind:<base>)' \
//       -- refs/heads/<b1> refs/heads/<b2> ...
//
// Measured on the reference machine (108 worktrees, 552 branches): the two per-agent spawns cost
// 48 ms + 102 ms each, i.e. ~15 s across a 100-agent pass, while one scoped `for-each-ref` over the
// 47 branches actually in use answers both for everyone in 107 ms. A whole pass drops from
// 22,041 ms to 11,825 ms (220 ms → 117 ms per agent, 46 % faster).
//
// SCOPED, NOT WHOLESALE. The same command left unscoped — every ref under `refs/heads/` — costs
// 630 ms here, because `%(ahead-behind:)` is a real revision walk per ref and this checkout carries
// 552 branches for 47 live agents. Naming the branches is most of the win.
//
// IT IS A FAST PATH, NEVER A REPLACEMENT. On the reference machine only 42 of 101 worktrees had a
// usable row: 58 were on a branch with no entry under `refs/heads` at all and 1 was on a DETACHED
// HEAD. Every one of those falls back to the per-agent `rev-list --count` + `log -1`. A missing row
// must NEVER be reported as `ahead: 0` / no commit time — this module's whole doctrine is that
// `None` and `Some(0)` are different answers, and a batching optimisation that quietly turns
// "unknown" into "zero" would be a correctness regression wearing a performance win's clothes.
// ---------------------------------------------------------------------------------------------

/// One branch tip's ref-derived facts, plus the branch they were read for.
///
/// Both extra fields exist so a lookup can be CHECKED rather than trusted. The prepass reads a
/// worktree's state once, up front; the per-agent pass reads it again a moment later. Those two
/// reads are not atomic, and agents COMMIT while a digest is running.
///
///   * `branch` — the prepass resolves it from the `HEAD` file, `git status` resolves it again. An
///     agent that switched branches in between would otherwise be handed the previous branch's
///     `ahead` count.
///   * `head_ref_ms` — the mtime of the ref file the branch points at, i.e. the one thing that moves
///     when a commit lands. This closes a window that would otherwise PIN staleness rather than
///     merely show it: `agent_facts_with` fingerprints the worktree AFTER the table was built, so a
///     commit landing in between would be stored in the memo as "already accounted for", and the
///     stale `ahead`/`last_commit_ms` would be served until something else about the worktree
///     changed. Re-stating the ref at lookup time and refusing a row that moved keeps facts at least
///     as fresh as the fingerprint they are memoized under. It fails CLOSED — a ref that moved, or
///     one we cannot stat now but could then, drops to the per-agent read, which is always correct.
///     **It is sampled BEFORE the tip read, and that order is the guard.** A mtime taken afterwards
///     absorbs whatever happened during the read, so the row would pair a pre-commit `ahead` with a
///     post-commit mtime and the lookup would accept it — reintroducing the very bug, through a
///     smaller window. See `sampled_ms` in [`ref_rows`].
///     (A PACKED ref stats as `None` at both moments and is accepted; git writes a LOOSE ref when it
///     updates one, so a packed ref that moves reads `None` → `Some` and is correctly refused.)
#[derive(Debug, Clone, PartialEq, Eq)]
struct RefRow {
    branch: String,
    head_ref_ms: Option<i64>,
    ahead: u32,
    committer_ms: i64,
}

/// The fleet-wide ref prepass, computed AT MOST ONCE and lazily.
///
/// Threaded as an explicit parameter rather than parked in a process-wide static, deliberately.
/// `fleet_digest` has two callers with different populations AND potentially different bases (the
/// fleet watch passes every open agent; the concierge tool passes a subset), so a global keyed on
/// the wrong base would serve one caller's answer to the other's question — a real bug in a module
/// whose entire contract is not faking absence.
///
/// LAZY because the memo above already answers most agents without any git at all. Building the
/// table eagerly would spend a spawn on every pass, including the passes where the memo makes the
/// answer free — turning a 0-spawn pass into a 1-spawn pass forever. `OnceLock::get_or_init` also
/// makes the fan-out safe for free: the first of the 8 worker threads to need the table computes
/// it, the rest block on that one computation rather than each spawning their own.
pub struct RefTable {
    rows: OnceLock<HashMap<String, RefRow>>,
    worktrees: Vec<PathBuf>,
    base: String,
}

impl RefTable {
    /// A table over `worktrees`, measuring `ahead` against `base`. Nothing is read until [`Self::tip`]
    /// is first called.
    fn new(worktrees: Vec<PathBuf>, base: &str) -> Self {
        Self { rows: OnceLock::new(), worktrees, base: base.to_string() }
    }

    /// A table that can never hold a row, so every caller takes the per-agent path. This is what
    /// the public [`git_facts`] passes: a single-worktree read has nothing to batch, and paying a
    /// `for-each-ref` to serve one agent would be slower than the two spawns it replaces.
    fn empty() -> Self {
        Self { rows: OnceLock::new(), worktrees: Vec::new(), base: String::new() }
    }

    /// The row for `worktree` — but only if it still describes this worktree: read for the branch
    /// the caller is actually on, and read before the branch tip last moved. See [`RefRow`].
    fn tip(&self, worktree: &str, branch: &str) -> Option<&RefRow> {
        let row = self.rows.get_or_init(|| ref_rows(&self.worktrees, &self.base)).get(worktree)?;
        (row.branch == branch && row.head_ref_ms == head_ref_ms(Path::new(worktree))).then_some(row)
    }
}

/// The mtime of the ref file this worktree's `HEAD` points at — the file a commit rewrites.
///
/// `None` for a detached head (no separate ref file), for a packed ref, and for a worktree we
/// cannot read. All three are compared as values rather than special-cased: what matters is only
/// whether the answer is the SAME now as it was during the prepass.
fn head_ref_ms(worktree: &Path) -> Option<i64> {
    let (own_dir, common_dir) = crate::worktree::git_dirs(worktree);
    head_ref_path(&own_dir, &common_dir).as_deref().and_then(mtime_ms)
}

/// Max ref patterns in one `for-each-ref` argv, and max bytes of them.
///
/// The prepass names every in-use branch on the command line, and a fleet is unbounded from this
/// module's point of view. macOS `ARG_MAX` is ~1 MiB, so neither ceiling is close to it — they
/// exist so that a pathological fleet degrades into a handful of spawns instead of an `E2BIG` that
/// would silently drop the whole table (and with it, the optimisation) for everyone.
const REF_CHUNK_MAX_PATTERNS: usize = 256;
const REF_CHUNK_MAX_BYTES: usize = 96 * 1024;

/// Does `base` denote the same commit no matter WHICH worktree resolves it?
///
/// This has to be an ALLOWLIST, and the reason is worth stating because the obvious version is a
/// denylist and it is wrong. The prepass runs once per repository, from one member's directory, so
/// a base whose meaning is per-worktree gets resolved against that one worktree and then applied to
/// every other agent in the group — silently, with no fallback, because the command SUCCEEDS.
/// `base` reaches here from the `fleet_digest` Tauri command (exposed to the concierge), and
/// `validate_ref` does not exclude any of `ORIG_HEAD`, `FETCH_HEAD`, `MERGE_HEAD`, `REBASE_HEAD`,
/// `@{u}`, `@{-1}`, `refs/bisect/…` or `refs/worktree/…` — all per-worktree, all plausible-looking.
/// Excluding `HEAD` and `@` by name would have been a guard enumerated by VALUE: correct only for
/// the two cases its author happened to think of, and quietly wrong for the rest.
///
/// So the question asked is the property itself: **does this name a ref that lives in the SHARED
/// ref store?** Two ways to be sure without spawning anything:
///   * a full object name (40 hex for sha-1, 64 for sha-256) is the same commit everywhere by
///     construction;
///   * otherwise the name must resolve to an existing ref under `refs/heads/` or `refs/remotes/`,
///     the two namespaces git keeps in the common dir. Checked against the loose ref file and then
///     `packed-refs`.
///
/// Everything else — pseudo-refs, reflog selectors, git's per-worktree ref namespaces, and names
/// that simply do not exist — falls back to the per-agent read, which resolves in the right
/// worktree and is always correct.
fn base_names_a_shared_ref(common_dir: &Path, base: &str) -> bool {
    if (base.len() == 40 || base.len() == 64) && base.bytes().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    // Guards the joins below: no traversal, no absolute path, no empty segments.
    if !is_plain_ref_path(base) {
        return false;
    }
    let candidates: Vec<String> = if base.starts_with("refs/") {
        vec![base.to_string()]
    } else {
        vec![format!("refs/heads/{base}"), format!("refs/remotes/{base}")]
    };
    let candidates: Vec<String> = candidates
        .into_iter()
        .filter(|r| r.starts_with("refs/heads/") || r.starts_with("refs/remotes/"))
        .collect();
    if candidates.is_empty() {
        return false;
    }
    if candidates.iter().any(|r| common_dir.join(r).exists()) {
        return true;
    }
    let Ok(packed) = std::fs::read_to_string(common_dir.join("packed-refs")) else {
        return false;
    };
    packed.lines().any(|line| {
        line.split_once(' ').is_some_and(|(_sha, name)| candidates.iter().any(|r| r == name.trim()))
    })
}

/// The branch a worktree's `HEAD` file names, without spawning git.
///
/// `None` for a DETACHED head (the file holds a raw sha, not a `ref:` pointer) and for a symbolic
/// head pointing outside `refs/heads/`. Both are honest "no fast path for this one" answers.
fn head_branch(worktree: &Path) -> Option<String> {
    let (own_dir, _common) = crate::worktree::git_dirs(worktree);
    let contents = std::fs::read_to_string(own_dir.join("HEAD")).ok()?;
    let target = contents.trim().strip_prefix("ref:")?.trim();
    let name = target.strip_prefix("refs/heads/")?;
    (!name.is_empty() && is_plain_ref_path(name)).then(|| name.to_string())
}

/// Read every worktree's branch tip in as few `git` spawns as the argv budget allows.
///
/// Keyed by WORKTREE path rather than by branch name, because grouping is per REPOSITORY: agents
/// can span projects (`fleet_digest` takes a list of `(agent_id, project_id)`), and `main` in one
/// project is not `main` in another. Keying a flat map on the branch name alone would let one
/// project's tip answer for another's.
fn ref_rows(worktrees: &[PathBuf], base: &str) -> HashMap<String, RefRow> {
    ref_rows_with(worktrees, base, &|| {})
}

/// [`ref_rows`] with a hook that runs between the mtime sample and the tip read.
///
/// The seam exists because the ordering of those two reads IS the guard, and ordering is invisible
/// to any test that can only observe the result: with nothing moving in between, sample-first and
/// sample-last record the same number. The alternative — racing a thread that keeps advancing the
/// ref and comparing elapsed times — decides a logical question by a scheduling ratio, so it can go
/// red on correct code (one deschedule in the prelude) and green on the bug (a fast spawn on a
/// warm, small repo). This makes the question exact instead: the hook jumps the ref's mtime by an
/// unmistakable amount, and the recorded value either predates that jump or it does not.
///
/// Production passes a no-op, and that call site is not a hole: every other prepass test drives
/// `ref_rows` through [`RefTable::tip`], so the real path is exercised throughout the suite. Only
/// the hook itself is test-only.
fn ref_rows_with(
    worktrees: &[PathBuf],
    base: &str,
    between: &dyn Fn(),
) -> HashMap<String, RefRow> {
    let mut rows = HashMap::new();
    // SECURITY. `base` is interpolated into the `--format` argument, and each branch name is passed
    // as a positional pattern. `validate_ref` is the existing, tested guard for both hazards: it
    // rejects a leading `-`/`+` (git would read the argument as an OPTION) and the glob
    // metacharacters `? * [ \` (a positional here is a PATTERN, so an unvalidated name could match
    // refs it does not name). The `--` below is belt-and-braces on top of that.
    if worktrees.is_empty() || crate::worktree::validate_ref(base).is_err() {
        return rows;
    }

    // repository common gitdir -> the (worktree, branch) pairs that live in it.
    let mut groups: BTreeMap<PathBuf, Vec<(String, String)>> = BTreeMap::new();
    for worktree in worktrees {
        if !worktree.is_dir() {
            continue;
        }
        let Some(branch) = head_branch(worktree) else { continue };
        if crate::worktree::validate_ref(&branch).is_err() {
            continue;
        }
        let (_own, common) = crate::worktree::git_dirs(worktree);
        groups
            .entry(common)
            .or_default()
            .push((worktree.to_string_lossy().to_string(), branch));
    }

    for (common, members) in groups {
        // Asked PER REPOSITORY, because `base` resolving in one says nothing about another: a
        // project that has never fetched `origin/main` must take the per-agent path even while its
        // neighbour batches. See [`base_names_a_shared_ref`].
        if !base_names_a_shared_ref(&common, base) {
            continue;
        }
        // SAMPLED BEFORE THE READ, and the order is the entire guard. A recorded mtime can only
        // prove "nothing moved" if it was taken no LATER than the data it guards: taken afterwards
        // it absorbs any change that happened during the read, so the row stores a pre-commit
        // `ahead` next to a post-commit mtime, the lookup re-stats and sees a match, and the stale
        // pair is accepted — the exact failure this field exists to prevent, just through a smaller
        // window. Not a sub-millisecond window either: with more than `REF_CHUNK_MAX_PATTERNS`
        // branches the read is several spawns, so a tip read in the first chunk would be stat'd only
        // after every later one returned. Sampling first makes the guard conservative in the safe
        // direction — a ref that moves during the batch read is refused and falls back per-agent.
        let sampled_ms: HashMap<&str, Option<i64>> = members
            .iter()
            .map(|(worktree, _)| (worktree.as_str(), head_ref_ms(Path::new(worktree))))
            .collect();
        between();

        // Any member works as the cwd — they share one ref store, which is the premise of batching.
        let cwd = members[0].0.clone();
        let mut names: Vec<&str> = members.iter().map(|(_, b)| b.as_str()).collect();
        names.sort_unstable();
        names.dedup();

        let format =
            format!("--format=%(refname)%09%(committerdate:unix)%09%(ahead-behind:{base})");
        let mut tips: HashMap<String, (u32, i64)> = HashMap::new();
        for chunk in ref_chunks(&names) {
            let patterns: Vec<String> =
                chunk.iter().map(|n| format!("refs/heads/{n}")).collect();
            let mut args: Vec<&str> = vec!["for-each-ref", &format, "--"];
            args.extend(patterns.iter().map(String::as_str));
            let out = match git(&cwd, &args) {
                Ok(out) => out,
                Err(e) => {
                    // The commonest cause is an unresolvable `base` (never fetched), which fails the
                    // WHOLE command — every branch in the chunk simply gets no row and takes the
                    // per-agent path, which will fail the same way and report `None`. Silence here
                    // would be indistinguishable from a fleet whose branches all vanished.
                    tracing::debug!(cwd, base, error = %e, "fleet: ref prepass unavailable; falling back per agent");
                    continue;
                }
            };
            for line in out.lines() {
                let mut parts = line.split('\t');
                let (Some(refname), Some(date), Some(ahead_behind)) =
                    (parts.next(), parts.next(), parts.next())
                else {
                    continue;
                };
                let Some(branch) = refname.strip_prefix("refs/heads/") else { continue };
                let Ok(secs) = date.trim().parse::<i64>() else { continue };
                // `%(ahead-behind:X)` prints `<ahead> <behind>`; only the first half is the
                // `rev-list --count <base>..HEAD` this replaces.
                let Some(Ok(ahead)) = ahead_behind.split_whitespace().next().map(str::parse::<u32>)
                else {
                    continue;
                };
                tips.insert(branch.to_string(), (ahead, secs * 1000));
            }
        }

        for (worktree, branch) in &members {
            if let Some(&(ahead, committer_ms)) = tips.get(branch.as_str()) {
                // The mtime from BEFORE the read — never a fresh stat. See `sampled_ms` above.
                let head_ref_ms = sampled_ms.get(worktree.as_str()).copied().flatten();
                rows.insert(
                    worktree.clone(),
                    RefRow { branch: branch.clone(), head_ref_ms, ahead, committer_ms },
                );
            }
        }
    }
    rows
}

/// Split branch names into argv-sized batches. See [`REF_CHUNK_MAX_PATTERNS`].
fn ref_chunks<'a>(names: &'a [&'a str]) -> Vec<Vec<&'a str>> {
    let mut out: Vec<Vec<&str>> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut bytes = 0usize;
    for name in names {
        // `refs/heads/` + the name + the NUL the kernel counts per argv entry.
        let cost = name.len() + 12;
        if !current.is_empty()
            && (current.len() >= REF_CHUNK_MAX_PATTERNS || bytes + cost > REF_CHUNK_MAX_BYTES)
        {
            out.push(std::mem::take(&mut current));
            bytes = 0;
        }
        current.push(name);
        bytes += cost;
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Gather git facts for one worktree against `base`.
///
/// Every command is independently fallible and independently optional: a worktree mid-rebase can
/// answer some of these and not others, and reporting the ones it can answer beats failing the
/// whole agent. `base` is only used for the two comparison reads.
pub fn git_facts(worktree: &str, base: &str) -> GitFacts {
    git_facts_with(worktree, base, &RefTable::empty())
}

/// [`git_facts`] with the fleet-wide ref prepass available.
///
/// Two spawns when `refs` has a row for this worktree (`status`, `diff`), four when it does not
/// (plus `rev-list` and `log`). It was FIVE before this: `rev-parse --abbrev-ref HEAD` folded into
/// the `status` call, and `rev-list`/`log` into the prepass.
fn git_facts_with(worktree: &str, base: &str, refs: &RefTable) -> GitFacts {
    let (branch, dirty_files) = branch_and_dirty(worktree);

    // No branch means detached, or git could not read this worktree at all. Either way there is no
    // row to look up and no name to check one against, so take the per-agent path.
    let tip = branch.as_deref().and_then(|b| refs.tip(worktree, b));
    let (ahead, last_commit_ms) = match tip {
        Some(row) => (Some(row.ahead), Some(row.committer_ms)),
        None => (
            git(worktree, &["rev-list", "--count", &format!("{base}..HEAD")])
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok()),
            last_commit_ms(worktree, "HEAD"),
        ),
    };

    // `.ok()`, deliberately NOT `.unwrap_or_default()`: an unreadable diff must stay `None` so a
    // reader (and `find_conflicts`) can tell it apart from a branch that really changed nothing.
    let changed_files = git(worktree, &["diff", "--name-only", &format!("{base}...HEAD")])
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

    GitFacts { ahead, dirty_files, last_commit_ms, branch, changed_files }
}

// ---------------------------------------------------------------------------------------------
// The git-facts memo
//
// WHY. [`git_facts`] is two to four `git` subprocess spawns per agent (it was five before the ref
// prepass below), and the digest runs over every open
// agent on a timer. Measured on a real worktree: 0.15 s for the five spawns and 0.12 s for the
// walk, so at 30 agents a pass was ~8.1 s of SEQUENTIAL work against a 10 s interval — an ~80 %
// duty cycle that stopped fitting its own interval at ~37 agents. A profile of the running app
// attributed 30.5 % of all CPU the process burned to this one command, and that figure UNDERSTATES
// it: most of the 8 s is spent waiting on git children whose own CPU (~0.39 cores continuously) the
// sampler never sees, because it profiles only this process.
//
// The observation that makes a memo possible: an agent that has not written, committed, staged, or
// had its base ref move CANNOT have different git facts than it had a moment ago. Most agents, most
// of the time, are in exactly that state. So the walk still runs every pass — it is the cheaper
// half and it is the freshness signal — and its result decides whether the expensive half runs at
// all.
//
// SOUNDNESS IS THE WHOLE POINT: this memo must never serve a fact that has changed. Every input
// `git_facts` reads is covered by the fingerprint below, and anything it cannot observe makes the
// fingerprint `None`, which disables memoization rather than guessing.
// ---------------------------------------------------------------------------------------------

/// Everything [`git_facts`] reads, reduced to values a stat can compare.
///
/// Each field exists because some git fact depends on it, and dropping any one of them would let a
/// real change go unnoticed:
///   * `walk` — the worktree's own content, which is what `dirty_files` counts (see [`WalkStats`]
///     for why three numbers rather than one).
///   * `head_ms` — a CHECKOUT rewrites the `HEAD` file, and on a detached HEAD (which holds a raw
///     sha rather than a pointer) every move rewrites it too.
///   * `head_ref_ms` — the ref `HEAD` POINTS AT, and this is the one that is easy to miss. On an
///     attached branch `HEAD` is symbolic — the literal bytes `ref: refs/heads/<branch>` — so moving
///     that branch does not touch it at all. `git commit` happens to bump `index` as a side effect,
///     which masks the gap; `git reset --soft` and `git commit --amend --no-edit` explicitly do NOT
///     touch the index or the tree. Without this field such a move left `ahead`, `last_commit_ms`
///     and `changed_files` cached at their pre-move values indefinitely, because nothing the
///     fingerprint watched had changed.
///   * `index_ms` — staging changes `git status` without touching a file's mtime.
///   * `remote_ref_ms` / `local_ref_ms` / `packed_refs_ms` — `ahead` and `changed_files` are measured
///     AGAINST `base`, so a `git fetch` that advances `origin/main` changes them for an agent that
///     did nothing at all. This is the input a fingerprint keyed only on the worktree would miss.
///
///     BOTH ref namespaces are stat'd, and that is not belt-and-braces. `base` defaults to
///     `origin/main` but is caller-supplied, and a LOCAL branch base (`main`, `develop`) lives at
///     `refs/heads/<base>` — nothing under `refs/remotes/` tracks it. Watching only the remote
///     namespace meant a local base found no loose ref, fell back to `packed-refs` alone (which
///     almost always exists, so the fingerprint was still built), and then never noticed that base
///     moving. The memo would serve a stale `ahead` for as long as the agent itself sat still.
///   * `base` — the caller may pass a different base branch between passes; the previous answer was
///     to a different question.
#[derive(Debug, Clone, PartialEq, Eq)]
struct GitFingerprint {
    walk: WalkStats,
    head_ms: Option<i64>,
    head_ref_ms: Option<i64>,
    index_ms: Option<i64>,
    remote_ref_ms: Option<i64>,
    local_ref_ms: Option<i64>,
    packed_refs_ms: Option<i64>,
    base: String,
}

/// Is `name` a plain ref path — no traversal, no absolute path, no empty segments?
///
/// Shared by the base mapping and the symbolic-HEAD resolution below, both of which join
/// caller-or-file-supplied text onto a gitdir. `git check-ref-format` forbids far more than this;
/// this is the subset that keeps those joins safe.
fn is_plain_ref_path(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.split('/').any(|c| c.is_empty() || c == "." || c == "..")
}

/// The path of the ref that a symbolic `HEAD` points at, e.g. `<common>/refs/heads/topic`.
///
/// `None` when `HEAD` is unreadable or DETACHED — a detached `HEAD` stores the sha inline, so
/// `head_ms` already moves whenever it does and there is no separate ref file to watch.
fn head_ref_path(own_dir: &Path, common_dir: &Path) -> Option<PathBuf> {
    let contents = std::fs::read_to_string(own_dir.join("HEAD")).ok()?;
    let target = contents.trim().strip_prefix("ref:")?.trim();
    is_plain_ref_path(target).then(|| common_dir.join(target))
}

/// Build the fingerprint, or `None` when this worktree's git state cannot be observed cheaply
/// enough to be trusted — in which case the caller MUST recompute rather than memoize.
///
/// Returns `None` in exactly two cases, both fail-open:
///   * `base` is not a plain `<remote>/<branch>`-shaped ref name. A base carrying `..`, an absolute
///     path, or empty components cannot be mapped to a ref file, and joining it would be a path
///     traversal against the gitdir. We decline to fingerprint rather than stat an attacker-shaped
///     path or, worse, memoize against a ref we never actually watched.
///   * no loose ref in EITHER namespace and no `packed-refs`, so there is NO file whose mtime tracks
///     the base. Without that we cannot tell a moved base from a still one.
fn git_fingerprint(worktree: &Path, base: &str, walk: WalkStats) -> Option<GitFingerprint> {
    if !is_plain_ref_path(base) {
        return None;
    }
    let (own_dir, common_dir) = crate::worktree::git_dirs(worktree);
    let refs = common_dir.join("refs");
    // Both namespaces — a local-branch base lives under `heads`, a remote-tracking one under
    // `remotes`, and watching only one of them silently stops tracking the other. See
    // `GitFingerprint::remote_ref_ms`.
    let remote_ref_ms = mtime_ms(&refs.join("remotes").join(base));
    let local_ref_ms = mtime_ms(&refs.join("heads").join(base));
    let packed_refs_ms = mtime_ms(&common_dir.join("packed-refs"));
    if remote_ref_ms.is_none() && local_ref_ms.is_none() && packed_refs_ms.is_none() {
        return None;
    }
    Some(GitFingerprint {
        walk,
        head_ms: mtime_ms(&own_dir.join("HEAD")),
        // The branch HEAD points at — see `GitFingerprint::head_ref_ms`. `git reset --soft` and
        // `git commit --amend` move this and touch nothing else the fingerprint watches.
        head_ref_ms: head_ref_path(&own_dir, &common_dir).as_deref().and_then(mtime_ms),
        index_ms: mtime_ms(&own_dir.join("index")),
        remote_ref_ms,
        local_ref_ms,
        packed_refs_ms,
        base: base.to_string(),
    })
}

/// One memoized answer: the facts, the fingerprint they were computed under, and when the entry was
/// last USED (a monotonic counter, not a clock — see [`evict_git_memo`]).
#[derive(Debug, Clone)]
struct CachedGit {
    fingerprint: GitFingerprint,
    facts: GitFacts,
    last_touch: u64,
}

/// Working-set ceiling for the memo. One entry is a handful of strings and six integers, so this is
/// generous next to the number of agents anyone has open; it exists to bound a long-lived process,
/// not to ration.
const GIT_MEMO_MAX: usize = 512;

/// Monotonic use-counter, so "least recently used" is a comparison rather than a clock read.
fn memo_tick() -> u64 {
    static TICK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    TICK.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Process-wide memo, keyed by worktree path. `OnceLock<Mutex<HashMap<…>>>` is the idiom already
/// used for the process caches in `accounts.rs` and `notes.rs`.
fn git_memo() -> &'static Mutex<HashMap<PathBuf, CachedGit>> {
    static MEMO: OnceLock<Mutex<HashMap<PathBuf, CachedGit>>> = OnceLock::new();
    MEMO.get_or_init(Default::default)
}

/// Evict least-recently-used entries until at most `max` remain. Pure (takes the map) so the policy
/// unit-tests without touching the static.
///
/// WHY NOT PRUNE TO THE CALLER'S AGENT SET, which is what this did first and is the obvious move.
/// `fleet_digest` has TWO callers with different populations: the fleet watch passes every open
/// agent, but the concierge tool (`conciergeTools/fleet.ts`) passes whatever SUBSET it is asking
/// about. Pruning to "the agents of the pass that just ran" therefore let one concierge question
/// about two agents evict the other thirty — so the next fleet-watch pass paid full price for all of
/// them, which is precisely the cost this memo exists to remove. A capacity bound has no opinion
/// about who asked.
///
/// It is also deliberately NOT the `map.clear()`-on-overflow shape used elsewhere in this crate,
/// which throws away the whole working set the moment one new key arrives.
fn evict_git_memo(memo: &mut HashMap<PathBuf, CachedGit>, max: usize) {
    if memo.len() <= max {
        return;
    }
    let mut by_age: Vec<(u64, PathBuf)> =
        memo.iter().map(|(k, c)| (c.last_touch, k.clone())).collect();
    by_age.sort_unstable();
    for (_, path) in by_age.into_iter().take(memo.len() - max) {
        memo.remove(&path);
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
    agent_facts_with(
        agent_id,
        worktree,
        hook_log,
        base,
        now_ms,
        window_ms,
        &git_facts_with,
        &RefTable::empty(),
    )
}

/// [`agent_facts`] with the git reader injected.
///
/// The seam exists so a test can COUNT spawns. The memo's whole claim is "an unchanged agent costs
/// zero git subprocesses", and the only assertion that actually proves that is one which observes
/// the call count — asserting that a cache entry exists would pass just as happily against a
/// version that re-ran git every time and then overwrote the entry.
///
/// `refs` is threaded rather than hidden in a static — see [`RefTable`] for why an implicit
/// process-wide table keyed on one caller's base would be a correctness bug here.
#[allow(clippy::too_many_arguments)]
fn agent_facts_with(
    agent_id: &str,
    worktree: &Path,
    hook_log: &Path,
    base: &str,
    now_ms: i64,
    window_ms: i64,
    git_fn: &(dyn Fn(&str, &str, &RefTable) -> GitFacts + Sync),
    refs: &RefTable,
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
        // The walk runs EVERY pass. It is the cheaper half (~0.12 s vs ~0.15 s measured) and it is
        // the freshness signal the memo is keyed on, so skipping it would be both a smaller win and
        // an unsound one.
        let walk = walk_stats(worktree);
        let (task, result_status) = worker_facts(worktree);

        // A `None` fingerprint means "we could not observe enough to be sure" — recompute, and do
        // not store. See `git_fingerprint` for the two cases.
        let fingerprint = git_fingerprint(worktree, base, walk);
        let cached = fingerprint.as_ref().and_then(|fp| {
            let mut memo = git_memo().lock().ok()?;
            let touch = memo_tick();
            let hit = memo.get_mut(worktree)?;
            // A hit is a USE: restamp it so a steadily-polled agent is never the one evicted.
            (hit.fingerprint == *fp).then(|| {
                hit.last_touch = touch;
                hit.facts.clone()
            })
        });
        let git = match cached {
            Some(facts) => facts,
            None => {
                let facts = git_fn(&wt, base, refs);
                if let Some(fp) = fingerprint {
                    if let Ok(mut memo) = git_memo().lock() {
                        memo.insert(
                            worktree.to_path_buf(),
                            CachedGit {
                                fingerprint: fp,
                                facts: facts.clone(),
                                last_touch: memo_tick(),
                            },
                        );
                        evict_git_memo(&mut memo, GIT_MEMO_MAX);
                    }
                }
                facts
            }
        };
        (git, walk.newest_file_ms, walk.truncated, task, result_status)
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
    build_digest_with(agents, hook_events_dir, base, now_ms, window_ms, &git_facts_with)
}

/// How many agents this digest reads CONCURRENTLY.
///
/// The per-agent work is independent — separate worktrees, separate subprocesses — so it was only
/// ever sequential by construction, not by necessity. A cold pass costs ~0.27 s per agent, so at the
/// 100-agent target the serial version needed ~27 s to answer a question asked every 10 s; it could
/// not keep up past ~37 agents.
///
/// 8 rather than "core count": the work is dominated by `git` subprocesses and `stat`s (I/O and
/// child processes, not this process's CPU), and these threads run INSIDE a `spawn_blocking` slot on
/// a runtime whose blocking pool is shared with every other command in the app. A fixed, modest
/// width bounds the subprocess storm — 8 concurrent `git status` runs, not 100 — while still cutting
/// the wall time by ~8×.
const DIGEST_MAX_CONCURRENCY: usize = 8;

/// [`build_digest`] with the git reader injected, and the fan-out that makes a 100-agent pass fit.
///
/// ORDER IS PRESERVED. `chunks()` hands out contiguous slices and the results are concatenated in
/// chunk order, so the `agents` array is byte-identical to the sequential version's. That matters:
/// `find_conflicts`/`unread_diffs` document that two runs over the same fleet produce identical
/// output, and a digest whose row order shuffled every pass would make every diff look like a change.
fn build_digest_with(
    agents: &[(String, PathBuf)],
    hook_events_dir: &Path,
    base: &str,
    now_ms: i64,
    window_ms: i64,
    git_fn: &(dyn Fn(&str, &str, &RefTable) -> GitFacts + Sync),
) -> FleetDigest {
    // ONE table for the whole pass, built before the fan-out and shared by every worker thread.
    // Construction is free — it only records the population and the base; the single `for-each-ref`
    // runs on the first agent that actually needs a tip, and not at all when the memo answers
    // everyone (see [`RefTable`]).
    let refs = RefTable::new(agents.iter().map(|(_, wt)| wt.clone()).collect(), base);

    let one = |(id, worktree): &(String, PathBuf)| {
        let log = hook_events_dir.join(format!("{id}.jsonl"));
        agent_facts_with(id, worktree, &log, base, now_ms, window_ms, git_fn, &refs)
    };

    let facts: Vec<FleetAgentFacts> = if agents.len() <= 1 {
        agents.iter().map(one).collect()
    } else {
        let workers = DIGEST_MAX_CONCURRENCY.min(agents.len());
        let chunk_len = agents.len().div_ceil(workers);
        // `scope` joins every thread before returning, so nothing outlives this call and the
        // borrowed `agents`/`git_fn` need no `'static`.
        std::thread::scope(|s| {
            let handles: Vec<_> = agents
                .chunks(chunk_len)
                .map(|c| s.spawn(move || c.iter().map(one).collect::<Vec<_>>()))
                .collect();
            handles
                .into_iter()
                .flat_map(|h| match h.join() {
                    Ok(rows) => rows,
                    // `unwrap_or_default()` here would substitute an EMPTY vec for the panicking
                    // chunk — silently deleting up to 1/8th of the fleet from the digest. Nothing
                    // downstream could tell that apart from "those agents do not exist": the rows
                    // are simply absent, so `find_conflicts` and `unread_diffs` under-report and the
                    // fleet watch sees agents vanish. Every field in this module is an `Option`
                    // precisely so absence is never faked; a dropped chunk fakes it wholesale.
                    // Re-raise on the caller's thread, which is inside `spawn_blocking` and is where
                    // a panic was always going to surface before this fan-out existed.
                    Err(payload) => std::panic::resume_unwind(payload),
                })
                .collect()
        })
    };

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
/// is a couple of `git` subprocess spawns plus a filesystem walk of up to [`WALK_MAX_ENTRIES`] stats, so at
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
    // VALIDATE THE BASE BEFORE IT REACHES GIT. This command is exposed to the concierge as a
    // read-only tool, and `base` flows straight into `git diff <base>...HEAD` and
    // `git rev-list <base>..HEAD`. Git parses a leading `-` as an OPTION, so an unvalidated base is
    // not merely a bad ref: `--output=/tmp/x` makes `git diff` CREATE OR OVERWRITE that file, which
    // turns a nominally read-only tool into an arbitrary-write primitive outside the worktree.
    // `worktree::validate_ref` is the existing, already-tested guard for exactly this vector
    // (`validate_ref_blocks_option_injection_but_allows_slash_branches`), so this reuses it rather
    // than growing a second, thinner copy. Checked HERE, before the `spawn_blocking` hop, so a
    // crafted base never occupies a blocking-pool slot — the same reasoning the id validation below
    // already uses.
    crate::worktree::validate_ref(&base)?;
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    // ---- counting the subprocesses this module actually forks ---------------------------------
    //
    // The performance contract this file makes is a SPAWN COUNT: five `git` children per agent per
    // pass became two, plus one fleet-wide prepass. Nothing about the returned `GitFacts` reflects
    // that — the same struct comes back either way — so a test that inspects the struct proves the
    // answers are right and says nothing at all about the thing that was changed. These two helpers
    // are the seam that makes the count observable.

    static GIT_SPAWNS: AtomicUsize = AtomicUsize::new(0);

    /// Called by [`super::git`] on every subprocess this module forks.
    pub(super) fn note_git_spawn() {
        GIT_SPAWNS.fetch_add(1, Ordering::SeqCst);
    }

    /// Serialises every test that spawns real `git` THROUGH THIS MODULE, so the process-wide counter
    /// above is exclusive for whoever holds it. The counter has to be global (the digest fan-out
    /// spawns worker threads, so a thread-local would lose most of the count), and libtest runs
    /// tests concurrently — without this lock a concurrent test's spawns would land in someone
    /// else's measurement and the assertion would flake.
    ///
    /// Fixture setup (`git_repo` / `fleet_repo`) deliberately calls `crate::worktree::git` DIRECTLY,
    /// bypassing the counter, so building a repo inside a held lock does not pollute the number.
    ///
    /// THE INVARIANT, and it is on you when you add a test: EVERY test that can reach `super::git`
    /// must hold this lock, whether or not it asserts on the count. "Can reach" is wider than it
    /// looks — `build_digest` and `git_facts` fork git for any worktree argument that is an
    /// EXISTING DIRECTORY, including one that is not a repository at all (git fails, but the child
    /// was still forked and still counted).
    fn git_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Spawns recorded since the last [`reset_git_spawns`]. Call only under [`git_lock`].
    fn git_spawns() -> usize {
        GIT_SPAWNS.load(Ordering::SeqCst)
    }

    fn reset_git_spawns() {
        GIT_SPAWNS.store(0, Ordering::SeqCst);
    }

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
        // Holds the counter lock: its `live` agent is an EXISTING directory that is not a git repo,
        // so `build_digest` really does fork git children through the counted wrapper. Unlocked,
        // those increments could land inside another test's measurement window — and the two
        // `assert_eq!(git_spawns(), 0, …)` assertions need only one stray spawn to flake.
        let _spawns = git_lock();
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
        let _spawns = git_lock();
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
        // Spawns real git THROUGH this module, so it holds the counter lock — see `git_lock`.
        let _spawns = git_lock();
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
        let _spawns = git_lock();
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
        let _spawns = git_lock();
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

    // ---- the fleet-wide ref prepass ----------------------------------------------------------

    /// The shape this module actually runs against: several LINKED worktrees over ONE shared
    /// `.git`, each on its own branch one commit past a common `trunk`. The worktrees live OUTSIDE
    /// the repo's own working tree so they do not show up as its untracked files.
    fn fleet_repo(tag: &str, branches: &[&str]) -> (PathBuf, String, Vec<PathBuf>) {
        let root = std::env::temp_dir().join(format!("sparkle-fleet-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let main = repo.to_string_lossy().to_string();
        // Routed through `crate::worktree::git`, NOT this module's counting wrapper: fixture setup
        // is not part of any measurement, and it also inherits the suite's `core.hooksPath`
        // isolation so these commits cannot fire a developer's global git hooks.
        crate::worktree::git(&main, &["init"]).expect("git init");
        crate::worktree::git(&main, &["config", "user.email", "fleet-test@example.invalid"]).unwrap();
        crate::worktree::git(&main, &["config", "user.name", "Fleet Test"]).unwrap();
        std::fs::write(repo.join("base.txt"), "base").unwrap();
        crate::worktree::git(&main, &["add", "-A"]).unwrap();
        crate::worktree::git(&main, &["commit", "-m", "base"]).unwrap();
        // Pin the trunk name: `git init`'s default is a machine setting, and the base ref is an
        // argument these tests pass by name.
        crate::worktree::git(&main, &["branch", "-M", "trunk"]).unwrap();

        let mut worktrees = Vec::new();
        for b in branches {
            let path = root.join("wt").join(b);
            let ps = path.to_string_lossy().to_string();
            crate::worktree::git(&main, &["worktree", "add", "-b", b, &ps, "trunk"]).unwrap();
            std::fs::write(path.join(format!("{b}.txt")), *b).unwrap();
            crate::worktree::git(&ps, &["add", "-A"]).unwrap();
            crate::worktree::git(&ps, &["commit", "-m", b]).unwrap();
            worktrees.push(path);
        }
        (root, "trunk".to_string(), worktrees)
    }

    fn wt_str(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn the_batched_pass_forks_two_git_children_per_agent_plus_one_prepass() {
        // THE assertion this change exists for. The facts are identical either way — only the
        // number of `git` children differs, and on the reference machine (108 worktrees over one
        // `.git` with 552 branches) each one costs ~48 ms of pure fork-and-attach. So the spawn
        // count IS the change; anything asserted about the returned struct would pass just as
        // happily against the five-spawn version.
        let _spawns = git_lock();
        let (root, base, wts) = fleet_repo("spawn-count", &["b1", "b2", "b3"]);
        let hooks = root.join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let agents: Vec<(String, PathBuf)> =
            wts.iter().enumerate().map(|(i, p)| (format!("a{i}"), p.clone())).collect();

        // The per-agent path, with no table to hit: `status` + `rev-list` + `log` + `diff`. Before
        // the `--porcelain=v2 --branch` merge this was FIVE — a separate `rev-parse --abbrev-ref
        // HEAD` supplied the branch name.
        reset_git_spawns();
        for p in &wts {
            git_facts(&wt_str(p), &base);
        }
        assert_eq!(
            git_spawns(),
            4 * wts.len(),
            "unbatched, every agent still pays its own rev-list and log"
        );

        // The batched pass: `status` + `diff` per agent, and ONE `for-each-ref` for the whole fleet.
        reset_git_spawns();
        let digest = build_digest(&agents, &hooks, &base, 1_000_000, 10_000);
        assert_eq!(
            git_spawns(),
            2 * wts.len() + 1,
            "batched, the fleet pays 2N + 1 — not 4N and not the original 5N"
        );

        // A spawn count is only worth having if the answers survived it.
        for row in &digest.agents {
            assert_eq!(row.git.ahead, Some(1), "each branch is one commit past trunk");
            assert!(row.git.last_commit_ms.is_some(), "and each has a tip commit time");
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_batched_ref_table_returns_the_same_facts_as_the_per_agent_reads() {
        // The equivalence that makes the spawn saving safe. `%(ahead-behind:<base>)` must equal
        // `rev-list --count <base>..HEAD` and `%(committerdate:unix)` must equal `log -1 %ct`, for
        // every field of `GitFacts`, on a fleet that is not uniform: one clean, one dirty, one
        // further ahead.
        let _spawns = git_lock();
        let (root, base, wts) = fleet_repo("equivalence", &["b1", "b2", "b3"]);
        // b2 is dirty; b3 is two commits past the base rather than one.
        std::fs::write(wts[1].join("scratch.txt"), "uncommitted").unwrap();
        std::fs::write(wts[2].join("second.txt"), "more").unwrap();
        crate::worktree::git(&wt_str(&wts[2]), &["add", "-A"]).unwrap();
        crate::worktree::git(&wt_str(&wts[2]), &["commit", "-m", "second"]).unwrap();

        reset_git_spawns();
        let solo: Vec<GitFacts> = wts.iter().map(|p| git_facts(&wt_str(p), &base)).collect();
        let solo_spawns = git_spawns();

        let table = RefTable::new(wts.clone(), &base);
        reset_git_spawns();
        let batched: Vec<GitFacts> =
            wts.iter().map(|p| git_facts_with(&wt_str(p), &base, &table)).collect();
        let batched_spawns = git_spawns();

        assert_eq!(batched, solo, "the batched facts must be identical, field for field");

        // WITHOUT THIS the test is vacuous: if every lookup missed, the two sides would be the same
        // code path compared with itself and would agree no matter what the prepass parsed.
        assert!(batched_spawns < solo_spawns, "the fast path must actually have been taken");
        for p in &wts {
            let branch = head_branch(p).expect("each fixture worktree is on a named branch");
            assert!(table.tip(&wt_str(p), &branch).is_some(), "every fixture worktree has a row");
        }

        // And the facts being compared are not all-defaults, which would also agree trivially.
        assert_eq!(solo[0].ahead, Some(1));
        assert_eq!(solo[1].dirty_files, Some(1), "b2's uncommitted file is seen");
        assert_eq!(solo[2].ahead, Some(2), "b3 is two commits past trunk");
        assert!(solo.iter().all(|f| f.last_commit_ms.is_some()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_detached_head_falls_back_and_still_reports_ahead_and_commit_time() {
        // One of the 101 real worktrees measured was detached, and 58 more had no row. A fast path
        // that only worked for the 42 that did would be fine; one that reported the other 59 as
        // `ahead: 0` would be a correctness regression.
        let _spawns = git_lock();
        let (root, base, wts) = fleet_repo("detached", &["b1"]);
        let s = wt_str(&wts[0]);
        crate::worktree::git(&s, &["checkout", "--detach"]).unwrap();

        let table = RefTable::new(wts.clone(), &base);
        let got = git_facts_with(&s, &base, &table);

        assert!(table.tip(&s, "b1").is_none(), "a detached HEAD names no branch, so it has no row");
        assert_eq!(got.branch, None, "and reports no branch, exactly as `rev-parse` used to");
        assert_eq!(got.ahead, Some(1), "the count still comes back — via the per-agent rev-list");
        assert!(got.last_commit_ms.is_some(), "and so does the tip time");
        assert_eq!(got, git_facts(&s, &base), "the fallback is the old answer, unchanged");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_worktree_absent_from_the_table_is_read_the_old_way_not_reported_as_zero() {
        // The concierge tool passes a SUBSET of the fleet, so a table can legitimately have no row
        // for a worktree someone then asks about.
        let _spawns = git_lock();
        let (root, base, wts) = fleet_repo("absent-row", &["b1", "b2"]);
        let table = RefTable::new(vec![wts[0].clone()], &base);
        let missing = wt_str(&wts[1]);

        assert!(table.tip(&missing, "b2").is_none(), "the omitted worktree has no row");
        let got = git_facts_with(&missing, &base, &table);
        assert_eq!(got.ahead, Some(1), "the real count, NOT Some(0) standing in for a missing row");
        assert!(got.last_commit_ms.is_some());
        assert_eq!(got, git_facts(&missing, &base));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_total_prepass_failure_leaves_ahead_unknown_rather_than_zero() {
        // `%(ahead-behind:X)` on an unresolvable X fails the WHOLE `for-each-ref` (exit 128), so
        // every branch in the chunk loses its row at once. The answer must degrade to "we could not
        // tell", which for this base is `None` — the one substitution this module never makes.
        //
        // The base has to EXIST as a shared ref to get this far (`base_names_a_shared_ref` would
        // otherwise refuse it before any spawn, which is a different path — see
        // `only_a_base_naming_a_shared_ref_is_batched`). So the fixture writes a DANGLING
        // `refs/remotes/origin/main`: a real ref file pointing at an object that is not there.
        let _spawns = git_lock();
        let (root, _base, wts) = fleet_repo("prepass-fail", &["b1"]);
        let s = wt_str(&wts[0]);
        let common = crate::worktree::git_dirs(&wts[0]).1;
        let origin = common.join("refs").join("remotes").join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::write(origin.join("main"), format!("{}\n", "0".repeat(40))).unwrap();
        assert!(
            base_names_a_shared_ref(&common, "origin/main"),
            "premise: the base passes the shared-ref check, so the prepass really does RUN"
        );
        let table = RefTable::new(wts.clone(), "origin/main");

        assert!(table.tip(&s, "b1").is_none(), "an unresolvable base yields no rows at all");
        let got = git_facts_with(&s, "origin/main", &table);
        assert_eq!(got.ahead, None, "unknown stays None — never Some(0)");
        assert_eq!(got.changed_files, None, "and the diff against a missing base is unreadable");
        // The facts that do NOT depend on the base still answer, which is the per-command-option
        // contract `git_facts` has always had.
        assert_eq!(got.branch.as_deref(), Some("b1"));
        assert_eq!(got.dirty_files, Some(0));
        assert!(got.last_commit_ms.is_some());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_row_is_refused_for_a_branch_it_was_not_read_for() {
        // Pins the BRANCH-NAME conjunct of `RefTable::tip`, on its own. The prepass reads `HEAD`
        // off disk; the per-agent pass reads the branch out of `git status` a moment later. Nothing
        // makes those atomic, so the row is checked against the branch the agent is actually on
        // rather than trusted.
        //
        // WHY IT ASKS `tip` DIRECTLY rather than checking out another branch: the end-to-end
        // version of this test is VACUOUS for the branch check. A checkout also rewrites `HEAD`, so
        // the sibling mtime conjunct catches it too — verified by hand-mutation, the checkout test
        // stayed green with the branch comparison deleted. Naming a different branch for an
        // otherwise UNTOUCHED worktree is the one shape only the branch comparison can refuse.
        let _spawns = git_lock();
        let (root, base, wts) = fleet_repo("row-branch-guard", &["b1"]);
        let s = wt_str(&wts[0]);
        let table = RefTable::new(wts.clone(), &base);

        assert_eq!(table.tip(&s, "b1").map(|r| r.ahead), Some(1), "the table really did read b1");
        assert!(
            table.tip(&s, "b1-something-else").is_none(),
            "the row describes b1 and must not answer for another branch"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_branch_switch_after_the_prepass_is_not_served_the_previous_branch_tip() {
        // The end-to-end companion to the two `tip` guards: whichever of them fires, an agent that
        // moved to another branch gets that branch's answer and not the stale one.
        let _spawns = git_lock();
        let (root, base, wts) = fleet_repo("stale-row", &["b1"]);
        let s = wt_str(&wts[0]);
        let table = RefTable::new(wts.clone(), &base);
        assert_eq!(table.tip(&s, "b1").map(|r| r.ahead), Some(1), "the table really did read b1");

        // …and now the worktree moves to a branch sitting ON the base, where the stale row's
        // answer (1) and the true answer (0) differ.
        tick();
        crate::worktree::git(&s, &["checkout", "-b", "b1-moved", "trunk"]).unwrap();
        let got = git_facts_with(&s, &base, &table);

        assert_eq!(got.branch.as_deref(), Some("b1-moved"));
        assert_eq!(got.ahead, Some(0), "the stale b1 row would have said 1");
        assert_eq!(got, git_facts(&s, &base));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_commit_landing_after_the_prepass_is_not_served_the_previous_tip() {
        // The sibling of the branch-switch guard, and the one that would PIN staleness rather than
        // merely show it. The prepass reads the tip at T; `agent_facts_with` fingerprints the
        // worktree at some later T'. An agent that commits in between would have its pre-commit
        // `ahead`/`last_commit_ms` stored in the memo UNDER A POST-COMMIT FINGERPRINT — so the
        // stale pair would be served until something else about the worktree changed, which for an
        // agent whose last act was that commit could be a very long time.
        //
        // Observed for real: two separate live agents committed inside the measurement window and
        // came back one commit short. Both were harness artefacts (a table minutes old), but the
        // same window exists, smaller, in production.
        let _spawns = git_lock();
        let (root, base, wts) = fleet_repo("post-prepass-commit", &["b1"]);
        let s = wt_str(&wts[0]);
        let table = RefTable::new(wts.clone(), &base);
        let before = table.tip(&s, "b1").cloned().expect("the prepass read b1");
        assert_eq!(before.ahead, 1);

        // mtimes compare at millisecond resolution; a commit in the same millisecond as the stat is
        // not observable, so step past that boundary the way the memo tests do.
        tick();
        std::fs::write(wts[0].join("more.txt"), "more").unwrap();
        crate::worktree::git(&s, &["add", "-A"]).unwrap();
        crate::worktree::git(&s, &["commit", "-m", "landed after the prepass"]).unwrap();

        assert!(table.tip(&s, "b1").is_none(), "the row's ref moved, so the row is refused");
        let got = git_facts_with(&s, &base, &table);
        assert_eq!(got.ahead, Some(2), "the stale row would have said 1");
        assert_eq!(got, git_facts(&s, &base), "and the fallback is the plain per-agent answer");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn two_projects_with_the_same_branch_name_do_not_answer_for_each_other() {
        // `fleet_digest` takes a per-agent `project_id`, so one pass can span repositories — and
        // `trunk`/`shared` in one is not `trunk`/`shared` in another. A table keyed on the branch
        // NAME would let the second repo's tip answer for the first.
        let _spawns = git_lock();
        let (root_a, base, wts_a) = fleet_repo("group-a", &["shared"]);
        let (root_b, _base_b, wts_b) = fleet_repo("group-b", &["shared"]);
        // Give repo B's `shared` a second commit, so the two same-named branches disagree.
        std::fs::write(wts_b[0].join("extra.txt"), "extra").unwrap();
        crate::worktree::git(&wt_str(&wts_b[0]), &["add", "-A"]).unwrap();
        crate::worktree::git(&wt_str(&wts_b[0]), &["commit", "-m", "extra"]).unwrap();

        let table = RefTable::new(vec![wts_a[0].clone(), wts_b[0].clone()], &base);
        assert_eq!(table.tip(&wt_str(&wts_a[0]), "shared").map(|r| r.ahead), Some(1));
        assert_eq!(table.tip(&wt_str(&wts_b[0]), "shared").map(|r| r.ahead), Some(2));
        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&root_b).ok();
    }

    #[test]
    fn only_a_base_naming_a_shared_ref_is_batched() {
        // The prepass resolves `base` ONCE, from one member's directory, and applies the answer to
        // the whole group — so a per-worktree base is silently wrong for everyone else, with no
        // fallback, because the command succeeds. Excluding `HEAD` and `@` by name is a guard
        // enumerated by VALUE; every case below sails past `validate_ref` and past that denylist.
        let _spawns = git_lock();
        let (root, base, wts) = fleet_repo("shared-ref-base", &["b1"]);
        let common = crate::worktree::git_dirs(&wts[0]).1;

        for accepted in [base.as_str(), "b1", "refs/heads/trunk"] {
            assert!(
                base_names_a_shared_ref(&common, accepted),
                "{accepted:?} names a ref in the shared store"
            );
        }
        // A full object name is the same commit in every worktree by construction.
        let sha = crate::worktree::git(&wt_str(&wts[0]), &["rev-parse", "HEAD"]).unwrap();
        assert!(base_names_a_shared_ref(&common, &sha), "a resolved sha is repo-wide");

        for refused in [
            "HEAD",             // the case the old denylist covered
            "@",                //  …and its alias
            "ORIG_HEAD",        // pseudo-refs: per-worktree, and shaped exactly like a branch name
            "FETCH_HEAD",
            "MERGE_HEAD",
            "REBASE_HEAD",
            "@{u}",             // reflog / upstream selectors, resolved against the current HEAD
            "@{-1}",
            "refs/bisect/bad",  // git's per-worktree ref namespaces
            "refs/worktree/x",
            "refs/rewritten/y",
            "origin/main",      // never fetched into this fixture — nothing shared to read
            "no-such-branch",
        ] {
            assert!(
                crate::worktree::validate_ref(refused).is_ok() || refused.contains("@{"),
                "premise: {refused:?} is the kind of base that reaches this guard"
            );
            assert!(
                !base_names_a_shared_ref(&common, refused),
                "{refused:?} does not name a shared ref and must not be batched"
            );
        }

        // …and the refusal happens before any subprocess, not after one.
        let table = RefTable::new(wts.clone(), "ORIG_HEAD");
        reset_git_spawns();
        assert!(table.tip(&wt_str(&wts[0]), "b1").is_none(), "no row for a per-worktree base");
        assert_eq!(git_spawns(), 0, "and no `for-each-ref` is spawned to discover that");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_row_records_the_ref_mtime_from_BEFORE_the_tip_read() {
        // The ORDER of the two reads inside `ref_rows` is the whole guard, and it is invisible to
        // every other test here: a mtime sampled AFTER the `for-each-ref` absorbs anything that
        // moved during it, so the row pairs a pre-commit `ahead` with a post-commit mtime, the
        // lookup re-stats, sees a match, and accepts the stale pair. Same bug, smaller window —
        // and not a sub-millisecond one, since past `REF_CHUNK_MAX_PATTERNS` branches the read is
        // several spawns and a first-chunk tip would be stat'd only after the last one returned.
        //
        // Asked EXACTLY rather than statistically. With nothing moving between the two reads the
        // orderings are indistinguishable, so the hook moves the ref's mtime by an hour — far
        // outside any filesystem's granularity — and the recorded value either predates that jump
        // or it is the jump. No thread, no sleep, no elapsed-time ratio to be descheduled out of.
        //
        // WHERE `between()` FIRES IS PART OF THIS TEST, so the hook asserts its own placement (see
        // below). It must sit between the `sampled_ms` collect and the tip read; moved after both —
        // or into the chunk loop — every ordering records the same value and this test would pass
        // on nothing. That edit happens in production code 1,900 lines from here and reds nothing
        // on its own, which is why the check is a `assert_eq!` inside the closure rather than a
        // sentence in this comment.
        let _spawns = git_lock();
        let (root, base, wts) = fleet_repo("sample-order", &["b1"]);
        let ref_file =
            crate::worktree::git_dirs(&wts[0]).1.join("refs").join("heads").join("b1");
        let before = head_ref_ms(&wts[0]).expect("the branch has a loose ref file to stat");

        let jumped = std::time::SystemTime::now() + std::time::Duration::from_secs(3600);
        reset_git_spawns();
        let rows = ref_rows_with(&wts, &base, &|| {
            // THE HOOK CHECKS ITS OWN PLACEMENT. Everything `ref_rows_with` does before the sample
            // is pure filesystem work, so the spawn count here is deterministically 0 — and the
            // very next thing after the sample is the `for-each-ref`. Without this line the guard
            // could be disarmed from 1,900 lines away, silently: sink `between()` below the chunk
            // loop (or into it) and sample-first and sample-last both record the same pre-jump
            // value, so this test goes GREEN on the bug it exists to catch. A comment cannot
            // defend against that, because the edit that breaks it happens in production code and
            // reds nothing. This turns that edit into a failure.
            assert_eq!(
                git_spawns(),
                0,
                "the hook must fire BEFORE the tip read, or this test proves nothing"
            );
            std::fs::File::options()
                .write(true)
                .open(&ref_file)
                .and_then(|f| f.set_modified(jumped))
                .expect("the hook must be able to move the ref's mtime");
        });

        let after = head_ref_ms(&wts[0]).expect("the ref is still stat-able");
        // Prove the premise before leaning on it: if the hook did nothing, both orderings record
        // the same value and the assertion below would be passing on nothing.
        assert!(
            after - before > 1_000_000,
            "the hook must have moved the ref's mtime (before {before}, after {after})"
        );

        let recorded = rows
            .get(&wt_str(&wts[0]))
            .expect("the prepass produced a row")
            .head_ref_ms
            .expect("and recorded a mtime for it");
        assert_eq!(
            recorded, before,
            "the row must record the mtime from BEFORE the tip read; {after} is the sample-last \
             ordering, which would then MATCH at lookup and serve the row it should refuse"
        );
        // …and that is precisely what makes the row refusable: what it recorded no longer matches
        // what the ref says now, so `tip` drops it and the agent takes the per-agent path.
        assert_ne!(recorded, after, "so the row is refused rather than trusted");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_base_ref_that_has_been_PACKED_is_still_recognised() {
        // Not a hypothetical: of the 11 repositories on the reference machine, one keeps its
        // `origin/main` in `packed-refs` rather than as a loose file. Checking only for the loose
        // file would silently drop that whole project out of the fast path — and since the loose
        // check runs first, nothing else in the suite would notice.
        let _spawns = git_lock();
        let (root, _base, wts) = fleet_repo("packed-base", &["b1"]);
        let common = crate::worktree::git_dirs(&wts[0]).1;
        crate::worktree::git(&wt_str(&wts[0]), &["pack-refs", "--all"]).unwrap();

        assert!(
            !common.join("refs").join("heads").join("trunk").exists(),
            "premise: packing really did remove the loose ref file"
        );
        assert!(base_names_a_shared_ref(&common, "trunk"), "a packed base is still a shared ref");
        assert!(
            !base_names_a_shared_ref(&common, "no-such-branch"),
            "and packing does not make every name resolve"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn one_project_without_the_base_does_not_stop_its_neighbour_batching() {
        // `base_names_a_shared_ref` is asked PER REPOSITORY. A project that never fetched the base
        // must take the per-agent path while the project beside it still batches — a single
        // fleet-wide yes/no would sacrifice one to the other.
        let _spawns = git_lock();
        let (root_a, _b, wts_a) = fleet_repo("per-repo-yes", &["b1"]);
        let (root_b, _b2, wts_b) = fleet_repo("per-repo-no", &["b1"]);
        // Repo A gets a `refs/remotes/origin/main`; repo B does not.
        let common_a = crate::worktree::git_dirs(&wts_a[0]).1;
        let origin = common_a.join("refs").join("remotes").join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        let trunk_sha = crate::worktree::git(&wt_str(&wts_a[0]), &["rev-parse", "trunk"]).unwrap();
        std::fs::write(origin.join("main"), format!("{trunk_sha}\n")).unwrap();

        let table = RefTable::new(vec![wts_a[0].clone(), wts_b[0].clone()], "origin/main");
        assert_eq!(
            table.tip(&wt_str(&wts_a[0]), "b1").map(|r| r.ahead),
            Some(1),
            "the project that HAS the base is batched"
        );
        assert!(
            table.tip(&wt_str(&wts_b[0]), "b1").is_none(),
            "the project that does not have it falls back, on its own"
        );
        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&root_b).ok();
    }

    #[test]
    fn a_base_shaped_like_a_git_option_never_reaches_the_prepass() {
        // Same guarantee `fleet_digest` already gives the per-agent reads, extended to the new
        // command: `base` is interpolated into `--format=…%(ahead-behind:<base>)`, and a branch
        // name is passed as a positional PATTERN. `validate_ref` rejects both hazards.
        let _spawns = git_lock();
        let (root, _base, wts) = fleet_repo("prepass-option", &["b1"]);
        for hostile in ["--output=/tmp/pwned", "-x", "refs/*", "a..b"] {
            let table = RefTable::new(wts.clone(), hostile);
            reset_git_spawns();
            assert!(table.tip(&wt_str(&wts[0]), "b1").is_none(), "refused base {hostile:?}");
            assert_eq!(git_spawns(), 0, "and refused it BEFORE spawning git for {hostile:?}");
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unborn_branch_reports_its_name_instead_of_nothing() {
        // THE one field whose answer this change alters, pinned so it is a decision rather than a
        // drift. A worktree created but not yet committed into: `rev-parse --abbrev-ref HEAD` exits
        // 128, so the old reader said `branch: None` — the same answer it gives for a DETACHED head
        // and for a directory git cannot read at all. `--porcelain=v2 --branch` distinguishes them.
        // Observed on 1 of 117 real agent worktrees; it was the only mismatch in the whole fleet.
        let _spawns = git_lock();
        let (dir, wt) = git_repo("unborn-branch");
        crate::worktree::git(&wt, &["symbolic-ref", "HEAD", "refs/heads/unborn"]).unwrap();
        assert!(
            crate::worktree::git(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]).is_err(),
            "premise: the command the old reader used really does fail on an unborn branch"
        );

        let facts = git_facts(&wt, "origin/main");
        assert_eq!(facts.branch.as_deref(), Some("unborn"), "git status knows the branch name");
        // …and the facts that genuinely need a commit stay unknown. Learning the branch must not
        // drag `ahead` down to the `Some(0)` this module never substitutes for "we cannot tell".
        assert_eq!(facts.ahead, None);
        assert_eq!(facts.last_commit_ms, None);
        assert_eq!(facts.dirty_files, Some(0), "an empty tree is clean, and that IS knowable");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ref_chunks_bound_the_argv_by_count_and_by_bytes() {
        // A fleet is unbounded from this module's point of view; `E2BIG` would drop the table (and
        // the optimisation) for everyone, silently.
        let many: Vec<String> = (0..REF_CHUNK_MAX_PATTERNS * 2 + 3).map(|i| format!("b{i}")).collect();
        let names: Vec<&str> = many.iter().map(String::as_str).collect();
        let chunks = ref_chunks(&names);
        assert_eq!(chunks.len(), 3, "two full chunks and a remainder");
        assert!(chunks.iter().all(|c| c.len() <= REF_CHUNK_MAX_PATTERNS));
        assert_eq!(chunks.iter().map(Vec::len).sum::<usize>(), names.len(), "nothing is dropped");
        assert_eq!(chunks.concat(), names, "and nothing is reordered");

        // The byte ceiling binds independently of the count: a handful of very long names.
        let long: Vec<String> = (0..4).map(|i| format!("{}{i}", "x".repeat(REF_CHUNK_MAX_BYTES / 2))).collect();
        let long_refs: Vec<&str> = long.iter().map(String::as_str).collect();
        let by_bytes = ref_chunks(&long_refs);
        assert!(by_bytes.len() > 1, "four half-budget names cannot share one argv");
        assert!(by_bytes.iter().all(|c| !c.is_empty()), "a chunk is never empty");
        assert_eq!(by_bytes.concat(), long_refs);

        assert!(ref_chunks(&[]).is_empty(), "no branches means no spawn at all");
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

    // ---- the git-facts memo ----------------------------------------------------------------
    //
    // EVERY test here asserts the SIDE EFFECT — how many times the git reader was actually
    // invoked. Asserting instead that a memo entry exists would pass just as happily against a
    // version that re-ran all five subprocesses every pass and then overwrote the entry, which is
    // precisely the regression the memo exists to prevent (AGENTS.md: an assertion that would pass
    // against the pre-change code proves nothing).

    /// A worktree shaped like a REAL linked worktree: `.git` is a gitlink FILE pointing at
    /// `<common>/worktrees/<name>`, and the ref files the fingerprint stats all exist. Each test
    /// passes a distinct `tag` so the process-wide memo (keyed by worktree path) cannot leak
    /// between tests running concurrently in the same process.
    fn memo_fixture(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("sparkle-fleet-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let wt = root.join("wt");
        let common = root.join("repo").join(".git");
        let own = common.join("worktrees").join("a1");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&own).unwrap();
        std::fs::create_dir_all(common.join("refs").join("remotes").join("origin")).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", own.display())).unwrap();
        std::fs::write(common.join("refs").join("remotes").join("origin").join("main"), "sha\n")
            .unwrap();
        std::fs::write(common.join("packed-refs"), "# pack-refs\n").unwrap();
        std::fs::write(own.join("HEAD"), "ref: refs/heads/topic\n").unwrap();
        std::fs::write(own.join("index"), "idx").unwrap();
        std::fs::write(wt.join("a.txt"), "hello").unwrap();
        (wt, common, own)
    }

    /// A git reader that records how many times it ran instead of spawning anything.
    fn counting_git() -> (
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
        impl Fn(&str, &str, &RefTable) -> GitFacts + Sync,
    ) {
        let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = n.clone();
        (n, move |_wt: &str, _base: &str, _refs: &RefTable| {
            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            GitFacts { ahead: Some(7), ..GitFacts::default() }
        })
    }

    fn memo_pass(
        wt: &Path,
        base: &str,
        git_fn: &(dyn Fn(&str, &str, &RefTable) -> GitFacts + Sync),
    ) -> FleetAgentFacts {
        agent_facts_with(
            "a1",
            wt,
            &wt.join("absent.jsonl"),
            base,
            1_000_000,
            10_000,
            git_fn,
            &RefTable::empty(),
        )
    }

    /// mtimes are compared at millisecond resolution, so a mutation in the same millisecond as the
    /// value it must differ from is not observable. Tests that mutate sleep past that boundary.
    fn tick() {
        std::thread::sleep(std::time::Duration::from_millis(12));
    }

    #[test]
    fn memo_serves_an_unchanged_agent_without_running_git_again() {
        let (wt, _c, _o) = memo_fixture("memo-hit");
        let (calls, git) = counting_git();

        let first = memo_pass(&wt, "origin/main", &git);
        let second = memo_pass(&wt, "origin/main", &git);

        // THE point of the change: the second pass spawned nothing.
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        // And it still reported the same facts — a memo that skipped the work but lost the answer
        // would be a different bug.
        assert_eq!(first.git.ahead, Some(7));
        assert_eq!(second.git, first.git);
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    #[test]
    fn memo_recomputes_after_a_file_is_written() {
        let (wt, _c, _o) = memo_fixture("memo-write");
        let (calls, git) = counting_git();
        memo_pass(&wt, "origin/main", &git);
        tick();
        std::fs::write(wt.join("b.txt"), "new work").unwrap();
        memo_pass(&wt, "origin/main", &git);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    #[test]
    fn memo_recomputes_after_a_file_is_DELETED() {
        // The case a files-only walk cannot see: a delete leaves no file behind to observe, but it
        // plainly changes `git status`. Without the directory-mtime signal this pass would be
        // served from cache and report a stale dirty count.
        let (wt, _c, _o) = memo_fixture("memo-delete");
        std::fs::write(wt.join("doomed.txt"), "bye").unwrap();
        let (calls, git) = counting_git();
        memo_pass(&wt, "origin/main", &git);
        tick();
        std::fs::remove_file(wt.join("doomed.txt")).unwrap();
        memo_pass(&wt, "origin/main", &git);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    #[test]
    fn memo_recomputes_after_a_RENAME() {
        // The case that isolates the directory-mtime signal, and the reason it exists rather than
        // relying on the entry count. A rename preserves the file's mtime AND the number of
        // entries, so `newest_file_ms` and `entries` are both byte-identical across it — yet
        // `git status` now reports a delete plus an add. The parent directory's mtime is the ONLY
        // thing that moves, so if this passes with that signal removed, the signal is dead code.
        let (wt, _c, _o) = memo_fixture("memo-rename");
        std::fs::write(wt.join("before.txt"), "same bytes").unwrap();
        let (calls, git) = counting_git();
        let first = walk_stats(&wt);
        memo_pass(&wt, "origin/main", &git);
        tick();
        std::fs::rename(wt.join("before.txt"), wt.join("after.txt")).unwrap();
        let second = walk_stats(&wt);

        // Prove the premise before leaning on it: the two cheap signals really are unchanged.
        assert_eq!(second.newest_file_ms, first.newest_file_ms, "rename must preserve file mtime");
        assert_eq!(second.entries, first.entries, "rename must preserve the entry count");

        memo_pass(&wt, "origin/main", &git);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    #[test]
    fn walk_stats_tracks_directory_mtime_so_a_delete_is_visible() {
        // The mechanism behind the test above, asserted directly: the directory's own mtime moves
        // when a child is removed, even though no file's mtime did.
        let dir = std::env::temp_dir().join(format!("sparkle-fleet-dirmt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("keep.txt"), "k").unwrap();
        std::fs::write(sub.join("gone.txt"), "g").unwrap();
        let before = walk_stats(&dir);
        assert!(before.newest_dir_ms.is_some(), "a directory mtime must be observed at all");
        tick();
        std::fs::remove_file(sub.join("gone.txt")).unwrap();
        let after = walk_stats(&dir);
        assert!(
            after.newest_dir_ms > before.newest_dir_ms,
            "removing a child must advance the directory mtime: {:?} -> {:?}",
            before.newest_dir_ms,
            after.newest_dir_ms
        );
        assert_eq!(after.entries, before.entries - 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn memo_recomputes_when_the_base_ref_moves() {
        // A fetch that advances origin/main changes `ahead` and `changed_files` for an agent that
        // did nothing at all. This is the input a worktree-only fingerprint would miss.
        let (wt, common, _o) = memo_fixture("memo-base");
        let (calls, git) = counting_git();
        memo_pass(&wt, "origin/main", &git);
        tick();
        std::fs::write(common.join("refs").join("remotes").join("origin").join("main"), "sha2\n")
            .unwrap();
        memo_pass(&wt, "origin/main", &git);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    #[test]
    fn memo_recomputes_when_head_or_index_moves() {
        let (wt, _c, own) = memo_fixture("memo-head");
        let (calls, git) = counting_git();
        memo_pass(&wt, "origin/main", &git);
        tick();
        std::fs::write(own.join("HEAD"), "ref: refs/heads/other\n").unwrap();
        memo_pass(&wt, "origin/main", &git);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2, "HEAD move must recompute");
        tick();
        std::fs::write(own.join("index"), "idx2").unwrap();
        memo_pass(&wt, "origin/main", &git);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 3, "index move must recompute");
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    #[test]
    fn memo_recomputes_when_the_base_branch_itself_changes() {
        // Two passes, two different questions. Serving the first answer to the second would report
        // an `ahead` count measured against a base the caller is no longer asking about.
        let (wt, common, _o) = memo_fixture("memo-rebase");
        std::fs::write(common.join("refs").join("remotes").join("origin").join("dev"), "sha\n")
            .unwrap();
        let (calls, git) = counting_git();
        memo_pass(&wt, "origin/main", &git);
        memo_pass(&wt, "origin/dev", &git);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    #[test]
    fn memo_declines_a_base_that_is_not_a_plain_ref_name() {
        // Fail OPEN: an un-mappable base must mean "always recompute", never "memoize against a ref
        // we never watched" — and the traversal-shaped join must not happen at all.
        let (wt, _c, _o) = memo_fixture("memo-traversal");
        assert_eq!(git_fingerprint(&wt, "../../etc", walk_stats(&wt)), None);
        assert_eq!(git_fingerprint(&wt, "/abs/path", walk_stats(&wt)), None);
        assert_eq!(git_fingerprint(&wt, "", walk_stats(&wt)), None);

        let (calls, git) = counting_git();
        memo_pass(&wt, "../../etc", &git);
        memo_pass(&wt, "../../etc", &git);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2, "must never be memoized");
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    #[test]
    fn memo_declines_when_no_file_tracks_the_base_at_all() {
        // Neither a loose ref nor packed-refs: nothing whose mtime moves when the base moves, so
        // there is no sound fingerprint and the memo must stay out of the way.
        let (wt, common, _o) = memo_fixture("memo-noref");
        std::fs::remove_file(common.join("refs").join("remotes").join("origin").join("main"))
            .unwrap();
        std::fs::remove_file(common.join("packed-refs")).unwrap();
        assert_eq!(git_fingerprint(&wt, "origin/main", walk_stats(&wt)), None);

        let (calls, git) = counting_git();
        memo_pass(&wt, "origin/main", &git);
        memo_pass(&wt, "origin/main", &git);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    #[test]
    fn git_dirs_resolves_a_gitlink_worktree_and_a_plain_clone() {
        let (wt, common, own) = memo_fixture("memo-dirs");
        assert_eq!(crate::worktree::git_dirs(&wt), (own, common));

        // A normal clone: `.git` is a DIRECTORY, so both answers are `<root>/.git`.
        let plain = std::env::temp_dir().join(format!("sparkle-fleet-plain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&plain);
        std::fs::create_dir_all(plain.join(".git")).unwrap();
        assert_eq!(crate::worktree::git_dirs(&plain), (plain.join(".git"), plain.join(".git")));
        std::fs::remove_dir_all(&plain).ok();
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    // ---- the parallel fan-out ---------------------------------------------------------------

    #[test]
    fn build_digest_preserves_agent_order_across_the_fan_out() {
        // More agents than DIGEST_MAX_CONCURRENCY, so several chunks really do run at once. Row
        // order is part of the payload — a shuffle would make every diff look like a change.
        let dir = std::env::temp_dir().join(format!("sparkle-fleet-order-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let agents: Vec<(String, PathBuf)> = (0..DIGEST_MAX_CONCURRENCY * 3 + 1)
            .map(|i| (format!("agent-{i:03}"), dir.join(format!("wt-{i:03}"))))
            .collect();
        let (calls, git) = counting_git();

        let digest = build_digest_with(&agents, &dir, "origin/main", 1_000_000, 10_000, &git);

        let got: Vec<&str> = digest.agents.iter().map(|a| a.agent_id.as_str()).collect();
        let want: Vec<&str> = agents.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(got, want);
        // None of these worktrees exist, so git is never consulted for any of them.
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_subset_digest_does_not_evict_the_agents_it_did_not_ask_about() {
        // REGRESSION. This first pruned the memo to "the agents of the pass that just ran", which
        // reads as tidy until you notice `fleet_digest` has two callers with different populations:
        // the fleet watch passes every open agent, the concierge tool passes whatever subset it is
        // asking about. One concierge question about one agent therefore evicted all the others, and
        // the next fleet pass paid full price for the whole fleet — deleting the benefit this memo
        // exists to provide, intermittently and invisibly.
        let (a_wt, _c, _o) = memo_fixture("memo-subset-a");
        let (b_wt, _c2, _o2) = memo_fixture("memo-subset-b");
        let hooks = a_wt.parent().unwrap().to_path_buf();
        let (calls, git) = counting_git();

        let both = vec![("a".to_string(), a_wt.clone()), ("b".to_string(), b_wt.clone())];
        build_digest_with(&both, &hooks, "origin/main", 1_000_000, 10_000, &git);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2, "both cold on the first pass");

        // The concierge asks about ONE of them.
        build_digest_with(
            &[("a".to_string(), a_wt.clone())],
            &hooks,
            "origin/main",
            1_000_000,
            10_000,
            &git,
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2, "the subset pass is a hit");

        // The fleet watch's next full pass must still be free for BOTH.
        build_digest_with(&both, &hooks, "origin/main", 1_000_000, 10_000, &git);
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "the agent the subset pass did not mention must NOT have been evicted"
        );
        std::fs::remove_dir_all(a_wt.parent().unwrap()).ok();
        std::fs::remove_dir_all(b_wt.parent().unwrap()).ok();
    }

    #[test]
    fn evict_git_memo_drops_the_least_recently_used_and_keeps_the_rest() {
        // Pure over the map, so the policy is testable without touching the process-wide static —
        // which also keeps this test from evicting a CONCURRENT test's entries, the way a
        // prune-the-static test necessarily would under the parallel harness.
        fn entry(touch: u64) -> CachedGit {
            CachedGit {
                fingerprint: GitFingerprint {
                    walk: WalkStats {
                        newest_file_ms: None,
                        newest_dir_ms: None,
                        entries: 0,
                        truncated: false,
                    },
                    head_ms: None,
                    head_ref_ms: None,
                    index_ms: None,
                    remote_ref_ms: None,
                    local_ref_ms: None,
                    packed_refs_ms: None,
                    base: "origin/main".to_string(),
                },
                facts: GitFacts::default(),
                last_touch: touch,
            }
        }
        let mut memo: HashMap<PathBuf, CachedGit> = HashMap::new();
        for i in 0..10u64 {
            memo.insert(PathBuf::from(format!("/wt/{i}")), entry(i));
        }
        evict_git_memo(&mut memo, 4);
        assert_eq!(memo.len(), 4, "must trim down to the cap, not clear");
        for i in 6..10u64 {
            assert!(memo.contains_key(&PathBuf::from(format!("/wt/{i}"))), "newest {i} must survive");
        }
        for i in 0..6u64 {
            assert!(!memo.contains_key(&PathBuf::from(format!("/wt/{i}"))), "oldest {i} must go");
        }
        // Under the cap it is a no-op — not an excuse to clear.
        let before = memo.len();
        evict_git_memo(&mut memo, 100);
        assert_eq!(memo.len(), before);
    }

    #[test]
    fn memo_recomputes_when_the_branch_HEAD_POINTS_AT_moves() {
        // REGRESSION (`git reset --soft`, `git commit --amend`). On an attached branch `HEAD` holds
        // the literal bytes `ref: refs/heads/<branch>` — moving that branch does not rewrite it, so
        // `head_ms` does not move. `git commit` happens to bump `index` as a side effect, which
        // masks the gap; `--soft` and `--amend` explicitly touch neither the index nor the tree.
        // So NOTHING else in the fingerprint changes, and `ahead`/`last_commit_ms`/`changed_files`
        // stayed cached at their pre-move values indefinitely.
        let (wt, common, own) = memo_fixture("memo-headref");
        let branch_ref = common.join("refs").join("heads").join("topic");
        std::fs::create_dir_all(branch_ref.parent().unwrap()).unwrap();
        std::fs::write(&branch_ref, "aaa\n").unwrap();
        std::fs::write(own.join("HEAD"), "ref: refs/heads/topic\n").unwrap();
        let (calls, git) = counting_git();

        memo_pass(&wt, "origin/main", &git);
        memo_pass(&wt, "origin/main", &git);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1, "unchanged is still a hit");

        // The move: ONLY the branch ref. HEAD and index are deliberately left alone, which is
        // exactly what `git reset --soft` does.
        let head_before = mtime_ms(&own.join("HEAD"));
        let index_before = mtime_ms(&own.join("index"));
        tick();
        std::fs::write(&branch_ref, "bbb\n").unwrap();
        assert_eq!(mtime_ms(&own.join("HEAD")), head_before, "HEAD must be untouched (the premise)");
        assert_eq!(mtime_ms(&own.join("index")), index_before, "index must be untouched");

        memo_pass(&wt, "origin/main", &git);
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "moving the branch HEAD points at must invalidate"
        );
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    #[test]
    fn head_ref_path_resolves_a_symbolic_head_and_declines_a_detached_one() {
        let (wt, common, own) = memo_fixture("memo-headpath");
        std::fs::write(own.join("HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        assert_eq!(
            head_ref_path(&own, &common),
            Some(common.join("refs").join("heads").join("feature").join("x"))
        );

        // Detached: the sha lives in HEAD itself, so `head_ms` already tracks it and there is no
        // separate ref file to watch.
        std::fs::write(own.join("HEAD"), "9f1c0de9f1c0de9f1c0de9f1c0de9f1c0de9f1c0\n").unwrap();
        assert_eq!(head_ref_path(&own, &common), None);

        // A traversal-shaped symbolic target is declined rather than joined.
        std::fs::write(own.join("HEAD"), "ref: ../../../etc/passwd\n").unwrap();
        assert_eq!(head_ref_path(&own, &common), None);
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    #[test]
    fn a_base_shaped_like_a_git_OPTION_is_refused_before_it_reaches_git() {
        // `git diff --output=/tmp/x ...` CREATES that file, so an unvalidated base turns this
        // read-only digest into an arbitrary-write primitive outside the worktree. The guard is
        // `worktree::validate_ref`, reused rather than re-implemented.
        assert!(crate::worktree::validate_ref("--output=/tmp/sparkle-probe-pwned").is_err());
        assert!(crate::worktree::validate_ref("--upload-pack=touch /tmp/x").is_err());
        assert!(crate::worktree::validate_ref("-x").is_err());
        // Legitimate bases still pass, including the default and slashed branch names.
        assert!(crate::worktree::validate_ref("origin/main").is_ok());
        assert!(crate::worktree::validate_ref("release/2026").is_ok());
    }

    #[test]
    fn memo_recomputes_when_a_LOCAL_branch_base_moves() {
        // REGRESSION. `base` is caller-supplied and defaults to `origin/main`, but a local-branch
        // base (`main`) lives at `refs/heads/<base>` — nothing under `refs/remotes/` tracks it.
        // Watching only the remote namespace found no loose ref, fell back to `packed-refs` alone
        // (which exists, so a fingerprint was still built), and then never noticed that base moving:
        // a stale `ahead` served for as long as the agent itself sat still.
        let (wt, common, _o) = memo_fixture("memo-localbase");
        std::fs::create_dir_all(common.join("refs").join("heads")).unwrap();
        std::fs::write(common.join("refs").join("heads").join("main"), "sha\n").unwrap();
        let (calls, git) = counting_git();

        memo_pass(&wt, "main", &git);
        memo_pass(&wt, "main", &git);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1, "unchanged is still a hit");

        tick();
        std::fs::write(common.join("refs").join("heads").join("main"), "sha2\n").unwrap();
        memo_pass(&wt, "main", &git);
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "a local base moving must invalidate"
        );
        std::fs::remove_dir_all(wt.parent().unwrap()).ok();
    }

    #[test]
    fn a_panicking_agent_read_propagates_instead_of_deleting_its_whole_chunk() {
        // `unwrap_or_default()` on the join would substitute an EMPTY vec for the panicking chunk,
        // silently removing up to 1/8th of the fleet from the digest — indistinguishable downstream
        // from "those agents do not exist". Every field in this module is an `Option` so absence is
        // never faked; a dropped chunk fakes it wholesale.
        let dir = std::env::temp_dir().join(format!("sparkle-fleet-panic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Real worktrees, so the git reader is actually reached.
        let agents: Vec<(String, PathBuf)> = (0..DIGEST_MAX_CONCURRENCY * 2)
            .map(|i| {
                let (wt, _c, _o) = memo_fixture(&format!("memo-panic-{i}"));
                (format!("agent-{i}"), wt)
            })
            .collect();
        let boom = |_wt: &str, _base: &str, _refs: &RefTable| -> GitFacts { panic!("git blew up") };

        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            build_digest_with(&agents, &dir, "origin/main", 1_000_000, 10_000, &boom)
        }));
        assert!(caught.is_err(), "the panic must reach the caller, not be swallowed into empty rows");

        for (_, wt) in &agents {
            std::fs::remove_dir_all(wt.parent().unwrap()).ok();
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
