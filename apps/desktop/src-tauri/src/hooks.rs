//! Claude Code event hooks (): register Sparkle's event emitter
//! (resources/sparkle-hook.mjs) in each agent worktree's `.claude/settings.local.json` so the
//! app derives status from Claude's own lifecycle events instead of scraping its TUI.
//!
//! The emitter appends one JSON line per event to a per-agent log under the app-data dir
//! (outside the worktree, so it never shows up in the user's `git status`). A watcher tails
//! that log and feeds the frontend HookStatusEngine (see src/engine/hookEvents.ts).
//!
//! This installer composes with `worktree::install_worktree_guard`: both merge into the same
//! settings file, each preserving the other's entries (the guard is matched by
//! `worktree-guard.mjs`, the emitter by `sparkle-hook.mjs`).
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, Runtime};

/// Substring identifying a Sparkle emitter hook entry, for idempotent reinstall.
const EMITTER_MARKER: &str = "sparkle-hook.mjs";
/// Substring identifying the worktree write-guard hook entry (installed by `worktree.rs`). Healed
/// here too, since it has the same baked-absolute-path fragility as the emitter.
const GUARD_MARKER: &str = "worktree-guard.mjs";
/// Tool-scoped events carry a `matcher`; we want every tool, so `*`.
const TOOL_EVENTS: &[&str] = &["PreToolUse", "PostToolUse"];
/// Lifecycle events with no tool matcher.
///
/// `PreCompact` is the newest and the least obvious. It fires when Claude Code compacts a session,
/// which is the ONLY structured signal that an agent is running out of usable context — and it was
/// missing here, so the signal never reached the app at all. It cost a real incident: agent
/// a0d5dc98 (2026-07-29) ran `/compact` three times in a row, the third failing with "Not enough
/// messages to compact", while `get_agent_status` reported it idle and the build column showed it
/// fine. The founder found it by reading the terminal himself. Sparkle never issues `/compact`
/// (nothing in this repo does), so the retry loop was the agent's own — which is exactly why the
/// app has to be able to SEE compaction rather than cause it. Consumed by engine/agentThrash.
const PLAIN_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "SubagentStop",
    "SessionStart",
    "SessionEnd",
    // `PreCompact` fires when Claude Code compacts a session — the only structured signal that an
    // agent is running out of usable context, and the thing agent a0d5dc98's three-`/compact` loop
    // (2026-07-29) needed someone to see.
    //
    // REGISTERED BARE, and that is now an evidence-backed choice rather than an assumption. It was
    // briefly registered with an all-matching `"*"` on the theory that a matcher-scoped lifecycle
    // event needs one — but `SessionStart` is matcher-scoped in exactly the same way (Claude Code's
    // own plugins register `"matcher": "startup|resume|clear|compact"`), is registered bare here and
    // in this machine's global settings with `"matcher": ""`, and demonstrably DELIVERS: the whole
    // hook status engine runs on it. So bare matches. Meanwhile `"*"` is only an all-match if Claude
    // Code special-cases the string — as a regex it is invalid — which means the "safer" form was
    // the unverified one, and it risked causing the very dead-arm outcome it claimed to prevent
    // (roborev 55296).
    //
    // Still not observed end-to-end (no `PreCompact` line has appeared in this machine's logs yet;
    // they predate the registration), and thrash detection deliberately does not depend on it — the
    // repetition and no-tool-turn rules catch the `/compact` loop on their own.
    "PreCompact",
];

/// Minimal POSIX single-quote escaping for embedding a path in a hook command string.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A hook command: `node '<script>' '<arg>'`. Both the emitter (arg = event-log path) and the
/// write-guard (arg = worktree path) share this shape.
fn hook_command(script: &Path, arg: &Path) -> String {
    format!(
        "node {} {}",
        shell_quote(&script.to_string_lossy()),
        shell_quote(&arg.to_string_lossy())
    )
}

// ── Staged bundle resources (bead sparkle-1ueh3) ──────────────────────────────────────────────
//
// EVERY bundled resource this app runs is copied out of the bundle ONCE, EAGERLY, at startup, into
// `<app_data>/bin/<running build segment>/<relative path>` — and every consumer reads the staged
// copy, never the bundle.
//
// WHY, and why the SHA segment is the load-bearing part. `tauri-plugin-updater` replaces
// `/Applications/Sparkle.app` UNDERNEATH the running process (rename aside → `remove_dir_all` →
// rename in), silently, on a poller that fires at launch, hourly, and on every window focus. On
// macOS `current_exe()` returns the path STRING captured at exec, not the inode, and
// `app.path().resolve(.., BaseDirectory::Resource)` recomputes from it on EVERY call. So a resource
// resolved after a swap has three possible fates:
//
//   A. DURING the swap → the path is missing        → an `Err`; every `.exists()` guard fires.
//   B. AFTER the swap  → same path, NEW content     → `.exists()` is TRUE → SILENT VERSION SKEW.
//   C. bundle moved    → permanently missing        → a persistent `Err`.
//
// MODE A IS NOT MERELY "a clean Err", and pretending it was is what made the first cut of this a
// REGRESSION in failure behaviour. The updater's poller fires AT LAUNCH and [`init_staged_resources`]
// runs in `setup()`, so an overlap with the updater's `remove_dir_all` window makes `src.exists()`
// false for ALL SIX resources at the one moment staging happens. Sealing that in a `OnceLock` returned
// the same Err FOREVER from `orchestrator_mcp_paths`, `control_mcp_paths`, `install_agent_hooks_sync`,
// `heal_agent_hooks_sync` and `install_repo_hooks` — no agent openable, no hook installable, no
// roborev hook writable, until the user quit and relaunched, with a `tracing::warn` as the only
// signal. Before staging existed each of those re-resolved per call, so the agent pane's "Try again"
// recovered by itself once the swap finished. Two things restore that, WITHOUT reopening mode B:
//
//   * [`stage_one`] falls back to an ALREADY-STAGED copy at `<dest_dir>/<rel>`. `dest_dir` is
//     `bin/<this build's segment>/`, so anything there is this build's own bytes by construction —
//     written by this process or by an earlier run of the SAME build, never by version N+1.
//   * the memo is re-runnable ([`staged_or_init`]): a load in which NOTHING staged is RETRIED on a
//     later call, gated on this process's own bundle not having been replaced since launch
//     (`stale_build::bundle_replaced_since_launch_now`). Once the swap has landed the gate closes and
//     the stale Err is preferred over version N+1's bytes. A load with at least one success is sealed
//     exactly as before.
//
// Mode B is the dangerous one and is why this exists: a version-N Rust process would spawn a
// version-N+1 `mcp-control-server.js` against its own N socket protocol (op names, token shape,
// `handle_request_line`). Nothing errors — agents' `mcp__sparkle-control__*` calls just fail with
// opaque `unauthorized`/unknown-op JSON, or succeed with the wrong semantics.
//
// Two properties close it, and BOTH are required:
//   * RESOLVE + COPY ONCE PER PROCESS, EAGERLY at startup ([`init_staged_resources`], called from
//     `lib.rs` `setup()`). Lazy memoization is NOT sufficient: a first resolve that happens after a
//     swap caches the NEW bundle's content, which is mode B again with an extra step.
//   * KEY THE DESTINATION BY BUILD SHA. `<app_data>/bin/` used to be flat, so a NEWER process
//     starting up overwrote the very file a RUNNING older process depends on — mode B relocated
//     from the bundle into app-data. A per-build directory means no process can ever write over
//     another build's staged copy.
//
// The staged copies are also what makes the baked absolute paths in each worktree's
// `.claude/settings.local.json` survive the bundle being renamed/replaced/removed (the original
// reason `stage_resource_script` existed); `heal_agent_hooks` re-points stale copies at launch, so
// the SHA segment moving from build to build heals itself.

/// Per-process counter so concurrent stages (several agents opening at once) never collide on the
/// same temp filename before the atomic rename below.
static STAGE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Every bundled resource staged out of the bundle at startup, as a path RELATIVE to the bundle's
/// `resources/` dir. Nested paths are supported and load-bearing: `roborev/post-commit` must keep
/// its subdirectory, or it would collide with any future top-level `post-commit`.
///
/// These are all SELF-CONTAINED single-file bundles (tsup, node builtins external, zero relative
/// imports) or standalone shell scripts, so copying the one file is sufficient — there is no
/// `node_modules` or sibling to drag along. That is what makes staging cheap enough to do eagerly.
pub const STAGED_RESOURCES: &[&str] = &[
    "sparkle-hook.mjs",
    "worktree-guard.mjs",
    "mcp-orchestrator-server.js",
    "mcp-control-server.js",
    "roborev/post-commit",
    "roborev/post-rewrite",
];

/// How long a staged directory belonging to some OTHER build may sit unused before the startup
/// sweep reclaims it. See [`sweep_stale_bins`] for why this is a backstop, not the safety property.
const STALE_BIN_MAX_AGE_MS: u64 = 14 * 24 * 60 * 60 * 1000;

/// One process's view of the staged resources: the directory they live in, and the outcome for each
/// one. Errors are stored rather than returned so a single missing resource cannot take the whole
/// staging step down — each consumer gets its own failure, with its own message.
#[derive(Clone)]
pub(crate) struct StagedBin {
    pub(crate) dir: PathBuf,
    pub(crate) entries: std::collections::BTreeMap<String, Result<PathBuf, String>>,
}

/// The single per-process memo. Populated eagerly by [`init_staged_resources`].
///
/// A `Mutex<Option<..>>` rather than a `OnceLock` for exactly one reason: a `OnceLock` seals a
/// FAILURE as permanently as a success, and the failure this staging step is most likely to hit is
/// the launch-time overlap with the updater's own `remove_dir_all` (mode A in the module header) —
/// which sealed meant no agent could be opened for the rest of the session. See [`staged_or_init`].
static STAGED: Mutex<Option<StagedBin>> = Mutex::new(None);

/// Is this process's own bundle still the one it was launched from — i.e. may a failed stage be
/// retried without risking version N+1's bytes landing under version N's segment (mode B)?
///
/// Consulted ONLY when a previous load produced nothing usable, so the healthy path never pays for
/// it. `bundle_replaced_since_launch_now` stats the bundle THIS process runs from (derived from
/// `current_exe()`); its one `/bin/ps` fork is memoized process-wide.
fn bundle_is_still_this_build() -> bool {
    !crate::stale_build::bundle_replaced_since_launch_now()
}

/// The memo seam, taking the cell and the retry gate explicitly so a test can drive it with its OWN
/// cell and assert the side effects that matter.
///
/// WHEN IT SEALS: only when EVERY entry is `Ok`. From that point nothing reloads, so a later change
/// to the SOURCE — the bundle being swapped — can never reach the staged copies. Any entry still in
/// `Err` is RETRIED, subject to `retry_allowed`, rather than sealed for the process lifetime. (This
/// paragraph previously said a load with "at least one usable path" sealed, which stopped being true
/// when the partial case was fixed and contradicted the paragraph below it — roborev 67441. It is
/// the paragraph a reader consults to reason about mode B, so it is the worst one to leave stale.)
///
/// WHAT EACH MECHANISM ACTUALLY BUYS — they cover DIFFERENT halves, and an earlier version of this
/// paragraph overstated it badly enough to be dangerous (roborev 67454), so it is spelled out:
///
/// * The PER-ENTRY retry (below) protects the entries that ALREADY STAGED. They are never re-copied,
///   so whatever they took while the bundle was provably ours is what they keep. It does nothing for
///   the entry still in `Err` — that is precisely the one a retry re-copies.
/// * `retry_allowed` is the ONLY guard on that still-`Err` entry. `stage_one` reads
///   `<resource_root>/<rel>` out of the bundle NOW, so if the swap has landed, a retry publishes
///   version N+1's bytes into `bin/<N's segment>/<rel>` — and a never-staged entry has no prior copy
///   to fall back on, so the consumer gets N+1's server under a running N.
///
/// AND THAT GUARD FAILS OPEN, so the hole is narrowed, not closed: `bundle_replaced_since_launch`
/// answers "not replaced" whenever either input is unknown, and `process_started_ms()` is `None` on
/// every non-macOS target — so off macOS it is a constant "retry allowed". A retried `Err` entry
/// after an undetected swap is therefore a RESIDUAL mode-B hole, not a closed one; it is bounded in
/// practice only because the swap-under-a-running-process mechanism is the macOS updater's, where
/// the gate does hold. Do NOT read this as a reason to drop the gate — on macOS it is the live
/// protection. The platform-independent fix (snapshot the bundle mtime once in `setup()`, before the
/// poller can fire, and require BOTH) is bead sparkle-j2j509.
///
/// THE RETRY IS PER ENTRY, and that is a correctness requirement rather than an optimisation
/// (roborev 67444). [`stage_all`] copies the resources SEQUENTIALLY, so a window opening or closing
/// mid-loop leaves a MIXED result — as does a per-file transient (ENOSPC, an EINTR'd copy, a briefly
/// locked app-data dir) on one resource while the others land. Sealing that state was the defect
/// this retry fixes; but re-running the WHOLE load to fix it was worse, because [`stage_one`]
/// deliberately never prefers an already-staged copy over a fresh one, so a whole-load retry
/// re-copies the entries that already succeeded — publishing whatever `resources/` holds NOW into
/// this build's segment. After a swap that is version N+1's bytes in version N's directory: mode B,
/// the silent version skew this module exists to prevent. (Why `retry_allowed` cannot carry that
/// weight on its own is stated once, above — deliberately not repeated here.)
///
/// So: only the entries that are still `Err` are re-attempted, and their results are merged in. An
/// entry that staged keeps the copy it took while the bundle was provably ours, whatever happens
/// later in the session.
pub(crate) fn staged_or_init(
    cell: &Mutex<Option<StagedBin>>,
    retry_allowed: &dyn Fn() -> bool,
    all_rels: &[&str],
    load: &dyn Fn(&[&str]) -> StagedBin,
) -> StagedBin {
    // A poisoned lock here means some other caller panicked mid-load; the value is still whatever
    // was last stored, and refusing to stage would be strictly worse than reading it.
    let mut slot = cell.lock().unwrap_or_else(|e| e.into_inner());

    let pending: Vec<&str> = match slot.as_ref() {
        None => all_rels.to_vec(),
        Some(existing) => {
            let pending: Vec<&str> = all_rels
                .iter()
                .copied()
                .filter(|r| existing.entries.get(*r).map(|e| e.is_err()).unwrap_or(true))
                .collect();
            if pending.is_empty() || !retry_allowed() {
                return existing.clone();
            }
            pending
        }
    };

    let fresh = load(&pending);
    let merged = match slot.take() {
        None => fresh,
        Some(mut existing) => {
            // `fresh` carries ONLY the entries we re-attempted, so this adopts the retry's results
            // without touching an entry that already staged. A degraded load reports an empty dir;
            // keeping the known-good one means a later success is still addressable.
            if !fresh.dir.as_os_str().is_empty() {
                existing.dir = fresh.dir;
            }
            for (rel, result) in fresh.entries {
                existing.entries.insert(rel, result);
            }
            existing
        }
    };
    *slot = Some(merged.clone());
    merged
}

/// The directory-name segment that identifies THIS build's staged copies.
///
/// `sha` is the compile-time `SPARKLE_GIT_SHA`; `pid` is this process's id. When the SHA is
/// unavailable ("unknown" — a tarball build, or git missing at compile time) there is NO build
/// discriminator, and two genuinely different builds would both land in `bin/unknown/` — which is
/// precisely the mode-B collision the segment exists to prevent. So the unknown case FAILS SAFE to
/// a per-PROCESS segment: unique by construction, so nothing can ever overwrite what this process
/// staged. The cost is one extra directory per launch of an unknown-SHA build, which the startup
/// sweep reclaims.
pub(crate) fn build_segment(sha: &str, pid: u32) -> String {
    let clean: String = sha.chars().filter(|c| c.is_ascii_alphanumeric()).take(40).collect();
    if clean.is_empty() || clean == "unknown" {
        format!("unknown-{pid}")
    } else {
        clean
    }
}

/// [`build_segment`] for the running process. This is the line that supplies the REAL build
/// discriminator; everything below takes the segment as an argument so it can be tested.
pub(crate) fn current_build_segment() -> String {
    build_segment(option_env!("SPARKLE_GIT_SHA").unwrap_or("unknown"), std::process::id())
}

/// Copy ONE resource from `<resource_root>/<rel>` to `<dest_dir>/<rel>`, published atomically (copy
/// to a temp sibling, then rename) so a hook or MCP launch firing in parallel never reads a
/// half-written file. Creates the destination's parent dirs, so a NESTED `rel` such as
/// `roborev/post-commit` works — the flat `resources/<name>` shape this replaced could not express
/// one, which is why the roborev hooks could not share this code path.
///
/// Missing sources are reported HERE, naming the path. Relying on `fs::copy`'s error instead
/// surfaced as a bare `stage <name>: No such file or directory` with nothing to act on.
///
/// FALLS BACK TO AN ALREADY-STAGED COPY when the source cannot be read. `dest_dir` is
/// `bin/<this build's segment>/`, keyed by SHA (or by pid for an unknown-SHA build), so a file
/// sitting there is THIS build's own bytes by construction — put there by this process or by an
/// earlier run of the same build, never by version N+1. Serving it is therefore free of the
/// version-skew (mode B) risk, and it is what stops the updater's `remove_dir_all` window turning a
/// launch-time miss into a session-long brick. See the module header.
pub(crate) fn stage_one(resource_root: &Path, dest_dir: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || Path::new(rel).is_absolute() || rel.split('/').any(|c| c == "..") {
        return Err(format!("refusing to stage unsafe resource path {rel:?}"));
    }
    let dst = dest_dir.join(rel);
    // Only reached when the copy below cannot happen; never preferred over a fresh copy, so a
    // normal launch still republishes the bundle's bytes every time.
    let already_staged = |e: String| if dst.exists() { Ok(dst.clone()) } else { Err(e) };
    let src = resource_root.join(rel);
    if !src.exists() {
        return already_staged(format!(
            "{rel} is not in this build's bundle (looked at {}) — reinstall Sparkle; in a dev checkout, build apps/desktop so the resource is copied in",
            src.display()
        ));
    }
    let parent = dst
        .parent()
        .ok_or_else(|| format!("stage {rel}: destination has no parent dir"))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    let leaf = Path::new(rel)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("stage {rel}: no file name"))?;
    let seq = STAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{leaf}.{}.{seq}.tmp", std::process::id()));
    if let Err(e) = std::fs::copy(&src, &tmp) {
        return already_staged(format!("stage {rel}: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, &dst) {
        let _ = std::fs::remove_file(&tmp);
        return already_staged(format!("publish {rel}: {e}"));
    }
    Ok(dst)
}

/// Stage every `rel` into `<bin_root>/<seg>/`, and leave a liveness marker naming this process so
/// [`sweep_stale_bins`] can tell a directory some other build is still USING from one merely left
/// behind. Never fails as a whole: each resource carries its own `Result`.
pub(crate) fn stage_all(
    resource_root: &Path,
    bin_root: &Path,
    seg: &str,
    rels: &[&str],
) -> StagedBin {
    let dir = bin_root.join(seg);
    let mut entries = std::collections::BTreeMap::new();
    for rel in rels {
        entries.insert((*rel).to_string(), stage_one(resource_root, &dir, rel));
    }
    // Only after something actually landed — a build whose resources are all missing must not leave
    // an empty directory behind for the sweep to reclaim later.
    if dir.is_dir() {
        let _ = std::fs::File::create(dir.join(format!(".alive-{}", std::process::id())));
    }
    StagedBin { dir, entries }
}

/// Is `pid` a live process? Used ONLY to decide whether a staged directory is still in use.
///
/// `kill(pid, 0)` sends no signal; it just asks the kernel. `EPERM` (the pid exists but belongs to
/// another user) counts as ALIVE, because every error in this predicate must bias towards KEEPING a
/// directory. PID reuse can only produce a false "alive", which delays a reclaim — never a deletion.
#[cfg(unix)]
pub(crate) fn pid_is_alive(pid: u32) -> bool {
    // Neither can be a pid we wrote (`std::process::id()` is always in `1..=pid_t::MAX`), and both
    // would mean something else to `kill` — 0 is "my whole process group", and anything above
    // `pid_t::MAX` wraps NEGATIVE, which addresses a group. Answer ALIVE so the sweep keeps the dir.
    if pid == 0 || pid > i32::MAX as u32 {
        return true;
    }
    // SAFETY: `kill` with signal 0 performs no action; it only reports whether the pid is signalable.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Windows has no `kill(pid, 0)` here, so guard 2 is SKIPPED and the age gate really is the sole
/// guard — which is what this comment used to CLAIM while the code did the opposite.
///
/// The bug: [`dir_has_live_claim`] runs BEFORE the age gate and short-circuits on any parseable
/// `.alive-*` marker, and [`stage_all`] always writes one. Answering `true` here therefore meant
/// EVERY staged directory was kept forever, the age gate was never consulted, and `<app_data>/bin/`
/// grew one directory per build installed, without bound.
///
/// Answering `false` inverts this predicate's usual "every error biases towards KEEPING" rule, and
/// that is deliberate: on this platform it is not an error reading, it is the ABSENCE of a reading,
/// and guard 3 (14 days untouched) is the backstop the sweep doc already names for exactly this
/// case. The residual risk is the one already stated there — a process running continuously for
/// longer than `max_age_ms` loses its staged dir and its next spawn fails LOUDLY (mode A), never
/// silently (mode B). Replace this with a real `OpenProcess`/`GetExitCodeProcess` answer and guard 2
/// lights up on Windows with no other change.
#[cfg(not(unix))]
pub(crate) fn pid_is_alive(_pid: u32) -> bool {
    false
}

/// Reclaim `<app_data>/bin/<seg>/` directories left by builds that are no longer running.
///
/// SAFETY REASONING — the thing that must never happen is pulling a staged file out from under a
/// CONCURRENTLY RUNNING older process, which would break every agent it spawns afterwards. Three
/// independent guards, in order:
///
///   1. NEVER the running segment. `keep_seg` is skipped unconditionally, so this process (and any
///      sibling of the same build) is safe by construction.
///   2. NEVER a directory a live process claims. Each process drops a `.alive-<pid>` marker in its
///      own staged dir ([`stage_all`]); if ANY marker there names a live pid, the directory stays.
///      Markers are never removed on exit, so this is crash-safe: the pid check, not tidy shutdown,
///      is what decides.
///   3. NEVER a directory younger than `max_age_ms`. A backstop for platforms where the pid check
///      cannot answer (Windows, where [`pid_is_alive`] answers `false` so guard 2 never fires and
///      this IS the only guard) and for a marker that failed to write.
///
/// Only DIRECTORIES are considered. Plain files directly under `bin/` are the LEGACY unversioned
/// staged scripts (`bin/sparkle-hook.mjs`), whose absolute paths are still baked into older
/// worktrees' `settings.local.json` until `heal_agent_hooks` re-points them — deleting those would
/// break hooks that are currently wired up.
///
/// Residual risk, stated rather than hidden: a process running CONTINUOUSLY for longer than
/// `max_age_ms` whose `.alive-` marker never landed could have its directory reclaimed. Its next
/// spawn would then fail LOUDLY with a missing-file error (mode A) — never the silent version skew
/// (mode B) this whole scheme exists to prevent — so the failure direction is the safe one.
///
/// Best-effort throughout: an unreadable dir or a failed removal is ignored. Returns the segments
/// removed, so the caller can log them and a test can assert on them.
pub(crate) fn sweep_stale_bins(
    bin_root: &Path,
    keep_seg: &str,
    now_ms: u64,
    max_age_ms: u64,
    is_alive: &dyn Fn(u32) -> bool,
) -> Vec<String> {
    let mut removed = Vec::new();
    let Ok(rd) = std::fs::read_dir(bin_root) else {
        return removed;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue; // legacy flat staged scripts — still referenced by un-healed worktrees
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        if name == keep_seg {
            continue; // guard 1: never the running build
        }
        if dir_has_live_claim(&path, is_alive) {
            continue; // guard 2: another running process is using it
        }
        if dir_age_ms(&path, now_ms).is_none_or(|age| age < max_age_ms) {
            continue; // guard 3: too young (or unreadable mtime — fail closed, keep it)
        }
        if std::fs::remove_dir_all(&path).is_ok() {
            removed.push(name);
        }
    }
    removed
}

/// Does any `.alive-<pid>` marker in `dir` name a live process?
fn dir_has_live_claim(dir: &Path, is_alive: &dyn Fn(u32) -> bool) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return true; // unreadable → assume in use; this predicate must never bias towards deleting
    };
    rd.flatten().any(|e| {
        e.file_name()
            .to_str()
            .and_then(|n| n.strip_prefix(".alive-"))
            .and_then(|p| p.parse::<u32>().ok())
            .is_some_and(&is_alive)
    })
}

/// Age of `dir` in ms from its mtime, or `None` when that cannot be read (treated as "keep").
fn dir_age_ms(dir: &Path, now_ms: u64) -> Option<u64> {
    let mtime = std::fs::metadata(dir).ok()?.modified().ok()?;
    let ms = mtime.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
    Some(now_ms.saturating_sub(ms))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Resolve the bundle's `resources/` dir and stage `rels` into `<app_data>/bin/<build segment>/`.
///
/// `rels` is the subset still to attempt — every resource on the first call, only the ones still
/// `Err` on a retry (see [`staged_or_init`]).
///
/// THIS IS THE RETRY BODY, SO IT MAY RUN MORE THAN ONCE PER PROCESS. It used to say "runs EXACTLY
/// ONCE per process", and that sentence is what put a destructive sweep on the retried path in the
/// first place — the next person adding a side effect here would have read it and done the same
/// (roborev 67453). ANYTHING THAT MUST HAPPEN ONCE GOES BEHIND [`SWEPT`], not merely inside this
/// function.
///
/// ACCEPTED COST, uncapped: a permanently-unstageable resource (a rename that outran
/// [`STAGED_RESOURCES`], a file dropped from packaging) leaves an entry `Err` forever, so every
/// `stage_resource_script` call — one per agent open, plus the per-worktree hook installs — re-runs
/// `resolve` + `app_data_dir` + `stage_all` + the `.alive-<pid>` `File::create`, under the
/// process-wide [`STAGED`] mutex, with no attempt cap or backoff. That is the price of never sealing
/// a failure; bounding it is bead sparkle-j2j509.
fn load_staged<R: Runtime>(app: &AppHandle<R>, rels: &[&str]) -> StagedBin {
    let all_failed = |e: String| StagedBin {
        dir: PathBuf::new(),
        entries: rels
            .iter()
            .map(|r| ((*r).to_string(), Err(format!("{r}: {e}"))))
            .collect(),
    };
    let resource_root = match app.path().resolve("resources", BaseDirectory::Resource) {
        Ok(p) => p,
        Err(e) => return all_failed(format!("cannot resolve the app bundle's resources dir: {e}")),
    };
    let bin_root = match crate::dev_identity::app_data_dir(app) {
        Ok(p) => p.join("bin"),
        Err(e) => return all_failed(e),
    };
    let seg = current_build_segment();
    let staged = stage_all(&resource_root, &bin_root, &seg, rels);
    // ONCE PER PROCESS, not once per retry. The sweep is a destructive `remove_dir_all` pass over
    // <app_data>/bin/ and it runs under the process-wide STAGED mutex; leaving it on the retried
    // path meant a single permanently-unstageable resource — a rename that outran STAGED_RESOURCES,
    // a file dropped from packaging — would re-sweep on every `stage_resource_script` call, i.e.
    // once per agent open, serialising every concurrent caller behind it (roborev 67444).
    if !SWEPT.swap(true, Ordering::Relaxed) {
        let removed =
            sweep_stale_bins(&bin_root, &seg, now_ms(), STALE_BIN_MAX_AGE_MS, &pid_is_alive);
        if !removed.is_empty() {
            tracing::info!(segments = ?removed, "reclaimed staged resources from builds no longer running");
        }
    }
    staged
}

/// Has the stale-segment sweep already run in this process? See [`load_staged`].
static SWEPT: AtomicBool = AtomicBool::new(false);

/// Stage every bundled resource for this build, EAGERLY, once. Called from `lib.rs` `setup()`.
///
/// Eager is the whole point: the updater can replace the bundle within minutes of launch, and any
/// resolve after that reads the NEW build's files. Doing all the work here means every later
/// consumer is served from a copy taken while the bundle was still ours.
///
/// Never fails: a resource that could not be staged is logged and its own consumer gets the error.
pub fn init_staged_resources<R: Runtime>(app: &AppHandle<R>) {
    let staged = staged_or_init(&STAGED, &bundle_is_still_this_build, STAGED_RESOURCES, &|rels| {
        load_staged(app, rels)
    });
    for (rel, res) in &staged.entries {
        if let Err(e) = res {
            tracing::warn!(resource = %rel, error = %e, "could not stage a bundled resource");
        }
    }
    tracing::info!(dir = %staged.dir.display(), count = staged.entries.len(), "staged this build's bundled resources");
}

/// The staged path for one bundled resource — the app-data copy taken at startup, NEVER a fresh
/// resolve out of the bundle. `rel` is the path relative to `resources/`, e.g. `sparkle-hook.mjs`
/// or `roborev/post-commit`, and must be listed in [`STAGED_RESOURCES`].
pub fn stage_resource_script<R: Runtime>(app: &AppHandle<R>, rel: &str) -> Result<PathBuf, String> {
    let staged = staged_or_init(&STAGED, &bundle_is_still_this_build, STAGED_RESOURCES, &|rels| {
        load_staged(app, rels)
    });
    match staged.entries.get(rel) {
        Some(Ok(p)) => Ok(p.clone()),
        Some(Err(e)) => Err(e.clone()),
        None => Err(format!(
            "{rel} is not staged for this build (add it to hooks::STAGED_RESOURCES)"
        )),
    }
}

/// Replace a file atomically: write a temp sibling in the SAME dir, then rename over the target.
/// `settings.local.json` drives executable hooks and may be read by a running Claude (e.g. the
/// launch-time heal sweep races already-open agents), so a reader must never observe a
/// truncated/partial write. Same dir keeps the rename atomic (one filesystem).
///
/// Refuses to clobber the target with invalid JSON: `contents` is parsed first, so a bug upstream
/// can never replace a good settings file with garbage Claude would fail to load. Our merge/heal
/// producers always emit valid JSON, so this is belt-and-suspenders that also documents the invariant.
/// Replace a settings file ATOMICALLY: validate, write a sibling temp, rename over the target.
///
/// `pub(crate)` because `accounts::ensure_account_allowlist_at` needs the same guarantee (knightwatch
/// probe on PR #1302): it used a plain `std::fs::write`, which truncates the live file first, so a
/// crash mid-write left a live `claude` reading a truncated settings.json. One implementation rather
/// than two, so the JSON-validation and never-a-partial-file properties cannot drift apart.
pub(crate) fn atomic_write_settings(path: &Path, contents: &str) -> Result<(), String> {
    serde_json::from_str::<Value>(contents)
        .map_err(|e| format!("atomic_write_settings: refusing to write invalid JSON: {e}"))?;
    let dir = path
        .parent()
        .ok_or_else(|| "atomic_write_settings: no parent dir".to_string())?;
    let seq = STAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".settings.{}.{seq}.tmp", std::process::id()));
    std::fs::write(&tmp, contents).map_err(|e| format!("atomic_write tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("atomic_write rename: {e}")
    })
}

/// True if this settings entry's `hooks[].command` contains `marker`.
fn entry_has_marker(e: &Value, marker: &str) -> bool {
    e.get("hooks")
        .and_then(|h| h.as_array())
        .map(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(marker))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Merge the emitter into each tracked event of a settings JSON (or a fresh object),
/// preserving any keys/hooks the user (or the write-guard) already has. Idempotent: a prior
/// Sparkle emitter entry is replaced, not duplicated.
pub fn merge_event_hooks(existing: Option<&str>, emitter_cmd: &str) -> String {
    let mut root: Value = existing
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks_obj = hooks.as_object_mut().unwrap();

    for (events, with_matcher) in [(TOOL_EVENTS, true), (PLAIN_EVENTS, false)] {
        for &ev in events {
            let arr_val = hooks_obj.entry(ev).or_insert_with(|| json!([]));
            if !arr_val.is_array() {
                *arr_val = json!([]);
            }
            let arr = arr_val.as_array_mut().unwrap();
            // Drop any prior emitter entry so reinstall is idempotent; keep everything else
            // (notably the worktree-guard's PreToolUse entry).
            arr.retain(|e| !entry_has_marker(e, EMITTER_MARKER));
            let mut entry = json!({ "hooks": [ { "type": "command", "command": emitter_cmd } ] });
            if with_matcher {
                entry
                    .as_object_mut()
                    .unwrap()
                    .insert("matcher".into(), json!("*"));
            }
            arr.push(entry);
        }
    }
    serde_json::to_string_pretty(&root).unwrap()
}

/// Merge Sparkle's default-on Claude Code plugins into a settings JSON, preserving everything the
/// user (or the agent, mid-session) already put there.
///
/// Writes the two keys Claude Code reads — both OBJECTS, per the verified schema documented on
/// `config::KNOWN_PLUGINS`:
///   `extraKnownMarketplaces`: `{ "<name>": { "source": { "source": "github", "repo": "o/r" } } }`
///   `enabledPlugins`:         `{ "<plugin>@<marketplace>": true }`
///
/// MERGE-NEVER-CLOBBER, and strictly insert-if-absent for both keys:
///   * A marketplace name the file already declares is left exactly as-is — the user may point it
///     at a fork, a pinned ref, or a private mirror, and re-pointing it at ours would silently
///     swap out their plugin source.
///   * A plugin id the file already mentions is left as-is **including when its value is `false`**.
///     That is the important case: `/plugin disable` and the `/plugin` UI record a disable by
///     writing `false` here, so overwriting it with `true` would make Sparkle re-enable a plugin
///     the agent just turned off — on every prepare, since AgentPane reinstalls hooks each time.
///
/// Off toggles contribute nothing: a disabled plugin is simply absent from `plugins`, so this
/// never writes `false` and never removes an entry. Turning a Sparkle toggle off stops Sparkle
/// enabling the plugin; it does not disable a plugin the user enabled themselves.
///
/// NON-OBJECT VALUES ARE LEFT ALONE. If `enabledPlugins`/`extraKnownMarketplaces` is present but is
/// an array, a string, or anything else we don't recognize, this SKIPS that key entirely (with a
/// warning) rather than replacing it with `{}`. It is user-owned data of a shape we don't
/// understand — a legacy encoding, a hand-edit, a newer Claude Code — and clobbering it would
/// destroy it silently, on every agent prepare, since AgentPane reinstalls hooks each time. The
/// cost of skipping is that our plugin doesn't get enabled in that one worktree, which is visible
/// and recoverable; the cost of clobbering is not.
///
/// A non-object ROOT is different: the file isn't a settings object at all, so there is nothing to
/// preserve, and Claude Code would reject it anyway. That case still resets to `{}`.
pub fn merge_plugin_settings(existing: Option<&str>, plugins: &[&crate::config::KnownPlugin]) -> String {
    let mut root: Value = existing
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    if plugins.is_empty() {
        // Nothing to add: return the input re-serialized rather than seeding two empty objects into
        // every agent's settings file. (Re-serialized, not byte-identical — a non-object root is
        // replaced above, and formatting is normalized.)
        return serde_json::to_string_pretty(&root).unwrap();
    }
    let obj = root.as_object_mut().unwrap();

    // Declare any marketplace Claude Code does not already own. The official marketplace is
    // excluded (see `KnownPlugin::declared_source`) — it is registered machine-wide by the
    // installer's `marketplace add`, not per-worktree — so today this loop only fires for
    // third-party rows (e.g. episodic-memory in obra/superpowers-marketplace).
    let sources: Vec<_> = plugins.iter().filter_map(|p| p.declared_source()).collect();
    if !sources.is_empty() {
        let markets = obj
            .entry("extraKnownMarketplaces")
            .or_insert_with(|| json!({}));
        match markets.as_object_mut() {
            Some(markets) => {
                for src in sources {
                    if !markets.contains_key(src.name) {
                        markets.insert(
                            src.name.to_string(),
                            json!({ "source": { "source": "github", "repo": src.repo } }),
                        );
                    }
                }
            }
            // Unknown shape → leave it exactly as the user wrote it.
            None => tracing::warn!(
                "plugin pre-enable: `extraKnownMarketplaces` is not an object; leaving it untouched"
            ),
        }
    }

    let enabled = obj.entry("enabledPlugins").or_insert_with(|| json!({}));
    match enabled.as_object_mut() {
        Some(enabled) => {
            for p in plugins {
                let id = p.id();
                if !enabled.contains_key(&id) {
                    enabled.insert(id, json!(true));
                }
            }
        }
        None => tracing::warn!(
            "plugin pre-enable: `enabledPlugins` is not an object; leaving it untouched"
        ),
    }
    serde_json::to_string_pretty(&root).unwrap()
}

// ── installing the pre-enabled plugins ───────────────────────────────────────────────────────
//
// Writing `enabledPlugins` is only half the job: a settings-enabled plugin is NOT fetched on
// session start. Verified by hand on 2026-07-24 — a settings.local.json naming
// `code-simplifier@claude-plugins-official` left `claude plugin list` with no such plugin — and the
// docs say a settings-enabled plugin from an external source "doesn't load until the team member
// installs it". `claude plugin install` IS headless and non-interactive, so Sparkle runs it once
// per plugin and records the result, populating the SHARED plugin cache — `<config>/plugins/cache`,
// where `<config>` is `$CLAUDE_CONFIG_DIR` else `$HOME/.claude` (see `claude_plugins_dir`) — that
// every worktree then resolves against.

/// Ledger of plugin ids Sparkle has already installed, so a launch doesn't re-shell-out (and
/// re-hit the network) for plugins that are already in the shared cache. Lives in app-data, next to
/// the other Sparkle-managed state.
fn installed_ledger_path(app_data: &Path) -> PathBuf {
    app_data.join("plugins-installed.json")
}

/// Read the ledger for ONE plugins root.
///
/// The file is a map, `{ "<plugins root>": ["<plugin>@<marketplace>", …] }`, because installs are
/// PER CONFIG TREE: a plugin present under `~/.claude/plugins` says nothing about an account store
/// at `<app_data>/accounts/<id>/plugins`. A single flat list meant alternating trees churned the
/// file, and — worse — when observation came back `None` for tree B (an unrecognized layout, the
/// exact case the ledger exists for) the entries recorded from tree A were trusted and the install
/// was skipped for a tree that had nothing.
///
/// The pre-map shape (`{"installed": [...]}`) is still read, but ONLY for the default tree
/// (`is_default_tree`) — it can't have described anything else, and trusting it for an account store
/// would skip an install for a tree that has nothing. A missing/garbage/foreign-shaped file reads as
/// "nothing installed yet" — the worst case is one redundant idempotent install, never a skipped one.
fn read_installed_ledger(path: &Path, root: &Path, is_default_tree: bool) -> Vec<String> {
    let Some(v) = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    else {
        return Vec::new();
    };
    if let Some(roots) = v.get("roots").and_then(Value::as_object) {
        return roots
            .get(&root.to_string_lossy().into_owned())
            .and_then(|ids| serde_json::from_value::<Vec<String>>(ids.clone()).ok())
            .unwrap_or_default();
    }
    // Legacy flat shape: it can only have described the default tree.
    if !is_default_tree {
        return Vec::new();
    }
    v.get("installed")
        .and_then(|ids| serde_json::from_value::<Vec<String>>(ids.clone()).ok())
        .unwrap_or_default()
}

/// Rewrite one root's entry in the ledger, preserving every other root's. Returns the new file body.
/// Pure, so the merge (and the legacy-shape upgrade) is testable without touching disk.
///
/// `is_default_tree` says whether `root` is the tree a legacy flat list would have described, so the
/// upgrade attributes those ids rather than dropping them.
fn merged_ledger(existing: Option<&str>, root: &Path, is_default_tree: bool, ids: &[String]) -> String {
    let parsed = existing.and_then(|s| serde_json::from_str::<Value>(s).ok());
    let mut roots = match parsed.as_ref().and_then(|v| v.get("roots")).and_then(Value::as_object) {
        Some(m) => m.clone(),
        None => {
            // Carry a legacy flat list forward as the default root's entry rather than dropping it.
            // Only this call knows which root that was, so a non-default tree's write simply
            // discards it — which is correct: the list never described that tree.
            let mut m = serde_json::Map::new();
            if is_default_tree {
                if let Some(legacy) = parsed
                    .as_ref()
                    .and_then(|v| v.get("installed"))
                    .and_then(|ids| serde_json::from_value::<Vec<String>>(ids.clone()).ok())
                {
                    m.insert(root.to_string_lossy().into_owned(), json!(legacy));
                }
            }
            m
        }
    };
    roots.insert(root.to_string_lossy().into_owned(), json!(ids));
    serde_json::to_string_pretty(&json!({ "roots": roots })).unwrap()
}

/// Claude Code's plugin root, resolved the SAME way the `claude plugin install` child will resolve
/// it: `$CLAUDE_CONFIG_DIR/plugins` when that is set and non-empty, else `$HOME/.claude/plugins`.
///
/// Honoring `CLAUDE_CONFIG_DIR` is not decorative. `claude.rs` and `accounts.rs` both resolve
/// Claude Code's state this way, and Sparkle itself sets the var per-spawn for multi-account users.
/// A hardcoded `~/.claude/plugins` reads the WRONG TREE on those machines: the install lands in the
/// configured dir, the presence check finds nothing, `observe_installed_plugins` returns a
/// definitive "nothing installed", the ledger is pruned, and every agent prepare re-runs the whole
/// install pass forever. Pure (takes both values) so the precedence is unit-testable without
/// mutating the process env.
fn claude_plugins_dir(config_dir: Option<&Path>, home: &Path) -> PathBuf {
    match config_dir.filter(|p| !p.as_os_str().is_empty()) {
        Some(cfg) => cfg.join("plugins"),
        // Empty is treated as unset, exactly as `claude::resolve_session_config_dir` does — an
        // `export CLAUDE_CONFIG_DIR=` must not yield a relative `plugins/` root.
        None => home.join(".claude").join("plugins"),
    }
}

/// Sparkle's own `CLAUDE_CONFIG_DIR`, as a path, treating empty as unset. This is the value the
/// `claude plugin …` child inherits (the install runs at USER scope in Sparkle's environment), so
/// it is the value the presence check has to agree with.
fn claude_config_dir_env() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// The `plugins` map's KEYS out of a parsed `installed_plugins.json` document — Claude Code's own
/// record of what is installed, as `<plugin>@<marketplace>` ids.
///
/// `None` means the document is not the shape we know (no `plugins` object); `Some(vec![])` means
/// it parsed and records nothing installed. Both callers lean on that distinction rather than on an
/// empty list, so keep them apart: [`observe_installed_plugins`] uses it to decide whether an empty
/// result is trustworthy, and [`crate::builder_index`] uses it to decide whether it may publish a
/// skills list at all (an empty array REPLACES the profile's row wholesale, so "we could not look"
/// must never render as "this machine has no skills").
///
/// Pure — takes the already-parsed JSON, reads no environment and no disk — so both callers'
/// behaviour is unit-testable without a fixture directory.
pub(crate) fn installed_plugin_ids(doc: &Value) -> Option<Vec<String>> {
    let map = doc.get("plugins")?.as_object()?;
    Some(map.keys().cloned().collect())
}

/// [`installed_plugin_ids`] against a manifest file. `None` for missing, unreadable, non-JSON, or
/// unrecognized-shape — every one of which is "we could not look", never "nothing is installed".
///
/// Takes the FULL path rather than a directory so each caller keeps its own path policy: the
/// install-skip path resolves `CLAUDE_CONFIG_DIR` first, while the Builder Index reporter reads
/// `~/.claude` unconditionally (see `builder_index::reporting_manifest_path` for why).
pub(crate) fn read_installed_plugin_ids(manifest: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(manifest).ok()?;
    let doc = serde_json::from_str::<Value>(&text).ok()?;
    installed_plugin_ids(&doc)
}

/// What is ACTUALLY installed on this machine, as `<plugin>@<marketplace>` ids — or `None` when we
/// can't tell (no plugins dir at all is *not* "can't tell", it is a definitive "nothing").
///
/// Why this exists: the ledger alone is write-only truth. If the user runs `/plugin uninstall`, or
/// wipes `~/.claude/plugins`, the ledger still lists the plugin, `plugins_needing_install` returns
/// empty, and Sparkle never reinstalls it — forever. Gating on observed state makes the skip
/// self-correcting.
///
/// Two signals, unioned — each can miss what the other catches, and both are positive evidence:
///   * `installed_plugins.json` — Claude Code's own record, keyed exactly by the id we use.
///   * `cache/<marketplace>/<plugin>/` — the on-disk payload, which survives a record we can't parse.
///
/// WHEN THIS RETURNS `None` matters as much as what it finds, because `None` means "trust the
/// ledger" and `Some(vec![])` means "definitively nothing, reinstall". Both signals are assumptions
/// about Claude Code internals; if a future version moves either, a *successful* install would read
/// as absent and we'd refetch everything on every pass, forever — strictly worse than the
/// write-only-ledger bug this replaces. So the empty case is only definitive when Claude Code's own
/// record PARSED (an empty `plugins` map is a real "nothing installed"); a plugins dir whose record
/// we couldn't read AND whose cache scan found nothing is treated as unobservable.
fn observe_installed_plugins(config_dir: Option<&Path>, home: &Path) -> Option<Vec<String>> {
    let plugins = claude_plugins_dir(config_dir, home);
    if !plugins.is_dir() {
        // Claude Code has never installed anything here, or the user wiped it. Definitive.
        return Some(Vec::new());
    }
    let mut ids: Vec<String> = Vec::new();

    // Signal 1: Claude Code's own installed record. Parsing it at all is what makes an empty
    // result trustworthy.
    let record_parsed = match read_installed_plugin_ids(&plugins.join("installed_plugins.json")) {
        Some(recorded) => {
            ids.extend(recorded);
            true
        }
        None => false,
    };

    // Signal 2: the on-disk cache payload, `cache/<marketplace>/<plugin>`.
    if let Ok(markets) = std::fs::read_dir(plugins.join("cache")) {
        for market in markets.flatten().filter(|e| e.path().is_dir()) {
            let Some(market_name) = market.file_name().to_str().map(str::to_string) else {
                continue;
            };
            // `claude plugin install` stages its clone in `cache/temp_git_<n>/` and moves it into
            // place. Catching one mid-install would read as a marketplace named `temp_git_…` — its
            // ids can never collide with a known plugin id, so this is noise reduction, not a
            // correctness fix (verified on this machine 2026-07-24, bead sparkle-s3g2.11).
            if market_name.starts_with("temp_git_") {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(market.path()) {
                for plugin in entries.flatten().filter(|e| e.path().is_dir()) {
                    if let Some(name) = plugin.file_name().to_str() {
                        let id = format!("{name}@{market_name}");
                        if !ids.contains(&id) {
                            ids.push(id);
                        }
                    }
                }
            }
        }
    }
    if ids.is_empty() && !record_parsed {
        // A populated plugins dir that told us nothing we understand. Don't call that "nothing
        // installed" — an unrecognized layout would otherwise mean reinstalling forever.
        tracing::warn!(
            dir = %plugins.display(),
            "plugin pre-enable: plugins dir exists but neither signal is readable; \
             falling back to the install ledger"
        );
        return None;
    }
    Some(ids)
}

/// The set to treat as "already installed": observed machine state when we could look, else the
/// recorded ledger. Observation WINS when available — it is the only signal that notices an
/// uninstall, and it also picks up a plugin the user installed themselves (so we don't refetch it).
fn already_installed(ledger: Vec<String>, observed: Option<Vec<String>>) -> Vec<String> {
    observed.unwrap_or(ledger)
}

/// Which enabled plugins still need `claude plugin install`. Pure, so the skip policy is tested
/// without shelling out. Order follows the table so installs are deterministic.
fn plugins_needing_install<'a>(
    enabled: &[&'a crate::config::KnownPlugin],
    already: &[String],
) -> Vec<&'a crate::config::KnownPlugin> {
    enabled
        .iter()
        .copied()
        .filter(|p| !already.iter().any(|id| *id == p.id()))
        .collect()
}

/// Wall-clock ceiling for one `claude plugin …` shell-out. These touch the NETWORK (a marketplace
/// fetch, a git clone of the plugin repo), and they run on a Tauri blocking-pool thread inside a
/// sequential loop — so without a deadline a single hung child pins that thread and stalls every
/// remaining install for the life of the process. 90s is generous for a cold clone on a slow link
/// while still being bounded; expiry is treated as a best-effort failure (the plugin stays out of
/// the ledger and the next launch retries it).
const PLUGIN_CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// The PATH to hand a `claude plugin …` child on unix.
///
/// THE BUG THIS FIXES: `claude` is a Node script whose `#!/usr/bin/env node` shebang resolves
/// `node` off PATH at exec time, and a Finder/Dock-launched macOS app inherits a bare GUI PATH
/// (`/usr/bin:/bin:…`) with no nvm/asdf/volta shim in it. Exec'ing the resolved claude path with
/// that inherited environment dies with "env: node: No such file or directory" for exactly the
/// users who keep Node under a version manager — and every failure here is only warn-logged, so
/// their plugin installs silently never happened.
///
/// Two layers, because neither alone is sufficient:
///   * `claude_chat::cached_login_shell_path()` — the login-shell PATH, probed ONCE per session
///     (`/bin/zsh -l -c`) and reused. That is the established pattern in this codebase, and paying
///     the dotfile-sourcing cost once beats paying it per install.
///   * the directory of `preflight::resolve_node_path_cached()`, PREPENDED. `-l` is a login but
///     NON-interactive shell, and this repo documents (preflight.rs, claude_chat.rs) that zsh
///     sources `.zshrc` only for INTERACTIVE shells — which is precisely where nvm/asdf/volta init
///     usually lives. So the login PATH can still be missing node, and preflight's resolver has the
///     canonical-location fallbacks that cover it.
///
/// Note there is no shell in this path at all any more. Handing the child an explicit PATH means we
/// can exec `claude` directly: no `$@`/quoting semantics to get wrong, and no assumption that the
/// user's `$SHELL` is POSIX-compatible (fish and csh/tcsh don't understand `"$@"`).
///
/// `~/.local/bin` is APPENDED — reachable, not preferred. It's where the official Claude Code
/// installer puts things and where user-local tooling lives, and a login but non-interactive shell
/// frequently doesn't have it (the `export PATH=…` usually sits in `.zshrc`). But putting it FIRST
/// would outrank the user's version-manager shims for every binary the child resolves — a stale
/// `~/.local/bin/node`, plausible on a machine that ran the official installer once, would beat the
/// nvm/asdf node the login shell deliberately selected. Note this is a DIFFERENT precedence from
/// `claudeSpawn.ts`'s `buildClaudeExec`, which prepends it and adds no node dir; that helper is
/// resolving `claude` itself off PATH, whereas here `claude` is already an absolute path and only
/// its `node` shebang needs help.
#[cfg(unix)]
fn plugin_child_path() -> String {
    let node_dir = crate::preflight::resolve_node_path_cached()
        .as_deref()
        .and_then(|n| Path::new(n).parent().map(|p| p.to_string_lossy().into_owned()));
    let local_bin = home_dir().map(|h| h.join(".local").join("bin").to_string_lossy().into_owned());
    join_path_entries(
        node_dir.as_slice(),
        &crate::claude_chat::cached_login_shell_path(),
        local_bin.as_slice(),
    )
}

/// Build a child PATH: `prefixes`, then `existing`, then `suffixes`.
///
/// Three rules, all load-bearing, and pure so they're testable without a login shell:
///   * ONLY ABSOLUTE COMPONENTS SURVIVE. `cached_login_shell_path()` returns "" when the probe
///     fails, and a naive `format!("{dir}:{login}")` then yields `"<nodedir>:"` — a trailing empty
///     component, which POSIX exec resolution reads as "search the CURRENT DIRECTORY". The child's
///     cwd is `$HOME` (see [`claude_command`]), so that would let any `node`/`git` sitting in the
///     user's home directory win over the real one. The same hazard applies one character wider to
///     any RELATIVE component — `.`, `bin`, `./node_modules/.bin` all appear in real dotfiles — so
///     the filter is "starts with `/`", not "is non-empty".
///   * DEDUPE BY MEMBERSHIP, not by "is it already first". A prefix that appears anywhere in the
///     existing PATH must not be added again, or the variable grows on every call.
///   * ORDER IS PRECEDENCE. Anything that must merely be REACHABLE goes in `suffixes`, so it can't
///     shadow a binary the user's own PATH already resolves.
#[cfg(unix)]
fn join_path_entries(prefixes: &[String], existing: &str, suffixes: &[String]) -> String {
    let mut out: Vec<&str> = Vec::new();
    for entry in prefixes
        .iter()
        .map(String::as_str)
        .chain(existing.split(':'))
        .chain(suffixes.iter().map(String::as_str))
    {
        if !entry.starts_with('/') || out.contains(&entry) {
            continue;
        }
        out.push(entry);
    }
    out.join(":")
}

/// Run `claude <args…>` and return Ok(()) when it exits 0, else the captured stderr/stdout.
///
/// UNIX: exec'd directly with an explicit PATH (see [`plugin_child_path`]) so the node shebang
/// resolves. WINDOWS: a GUI app inherits the user's PATH, and `claude` may be a `.cmd` shim, so
/// that branch goes through `cmd /c` exactly like the version probe does.
///
/// Bounded by [`PLUGIN_CMD_TIMEOUT`] via `worktree::output_with_timeout_lenient` (spawn + poll
/// `try_wait`, kill on expiry, pipes drained on reader threads) so a hung child can't wedge the
/// install loop. LENIENT because the install is a mutating call: see the note at the call site.
fn run_claude(claude: &str, config_dir: Option<&Path>, args: &[String]) -> Result<(), String> {
    run_claude_with_timeout(claude, config_dir, args, PLUGIN_CMD_TIMEOUT)
}

/// Build (but don't run) the child for a `claude <args…>` invocation. Split out from
/// [`run_claude`] so the environment is assertable without shelling out — the whole point of the
/// fix is what the child's PATH contains, and a test that only checks the exit status would pass
/// just as happily with the broken inherited-environment form.
fn claude_command(
    claude: &str,
    config_dir: Option<&Path>,
    args: &[String],
) -> std::process::Command {
    let mut cmd = std::process::Command::new(claude);
    cmd.args(args);
    #[cfg(unix)]
    cmd.env("PATH", plugin_child_path());
    #[cfg(not(unix))]
    {
        cmd = std::process::Command::new("cmd");
        cmd.arg("/c").arg(claude).args(args);
    }
    // WHICH TREE the install lands in, set EXPLICITLY. Everything else about this child is already
    // explicit (PATH, cwd); leaving the one value that decides where the plugin is written to
    // inheritance meant the observation could only agree with the install by coincidence, and a pass
    // targeting an ACCOUNT store (which is never in our own env) had no way to say so at all.
    if let Some(dir) = config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    // Run from HOME, not the process CWD. A Finder/Dock-launched bundle has CWD `/`, and `claude`
    // resolves project-scoped config and trust from its working directory — so without this, a
    // user-scope install behaves differently depending on how the app was launched.
    if let Some(home) = home_dir() {
        cmd.current_dir(home);
    }
    cmd
}

/// [`run_claude`] with an explicit deadline, so the expiry path is testable in well under the
/// 90-second production ceiling.
fn run_claude_with_timeout(
    claude: &str,
    config_dir: Option<&Path>,
    args: &[String],
    timeout: std::time::Duration,
) -> Result<(), String> {
    // Lenient on purpose: `claude plugin install` is a MUTATING call whose network children can
    // hold the pipes open past the child's exit. The install either happened or it didn't — the
    // exit status says which; failing on an unfinished drain would report a successful install as
    // failed and (per the ledger) keep retrying it.
    let captured = crate::worktree::output_with_timeout_lenient(
        claude_command(claude, config_dir, args),
        timeout,
    )
    .map_err(|e| format!("running `claude {}`: {e}", args.join(" ")))?;
    let out = &captured.output;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let detail = if stderr.trim().is_empty() {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        stderr.trim().to_string()
    };
    // This `detail` is what the Tools row shows as the install hint. On an incomplete drain it can
    // be empty or cut short, which reads as "the command said nothing" — the note distinguishes
    // the two.
    Err(format!(
        "`claude {}` failed: {detail}{}",
        args.join(" "),
        captured.truncation_note()
    ))
}

/// What a pass actually did for ONE plugin.
///
/// WHY THIS EXISTS: the pass is best-effort and returns `Ok` even when every install failed, so a
/// caller that only sees "did the command reject?" can never distinguish offline / marketplace
/// outage / no-`claude` from success. The UI toggle then reads ON with the plugin ABSENT — exactly
/// the invisible failure the install was added to fix, moved one step later. The per-row hint in
/// `configActions.ts` is driven off this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginInstallStatus {
    /// This pass ran `claude plugin install` and it exited 0.
    Installed,
    /// Nothing to do — the plugin was OBSERVED on the machine.
    AlreadyPresent,
    /// We believe it's there, but couldn't look: `observe_installed_plugins` returned `None` (a
    /// plugins dir whose layout we don't recognize) or there was no home dir to look under, so the
    /// answer came from the write-only ledger.
    ///
    /// Kept distinct from `AlreadyPresent` because collapsing them is the exact bug this whole enum
    /// exists to kill — "we can't see it" rendering as "it's fine" — just narrowed to the
    /// unobservable machine.
    Unverified,
    /// The plugin is NOT on the machine and this pass could not put it there.
    Failed,
}

/// One plugin's result, for the row that toggled it.
///
/// Two failure strings on purpose. `message` is what the UI shows and says the ACTIONABLE thing —
/// "finish setup" and "check your connection" are different remedies and must not collapse into one
/// sentence. `detail` is the raw child stderr, which belongs in a tooltip and the log, never in the
/// row copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallOutcome {
    /// The `[plugins]` toggle key (`superpowers`, `frontend_design`) — how the UI finds its row.
    pub key: String,
    /// The `<plugin>@<marketplace>` id.
    pub id: String,
    pub status: PluginInstallStatus,
    /// A user-facing sentence naming the remedy. `None` unless `status` is `Failed`.
    pub message: Option<String>,
    /// The underlying technical error, when there is one. Never the whole story on its own.
    pub detail: Option<String>,
}

impl PluginInstallOutcome {
    fn new(p: &crate::config::KnownPlugin, status: PluginInstallStatus) -> Self {
        Self { key: p.toggle.to_string(), id: p.id(), status, message: None, detail: None }
    }

    /// "We think it's there but couldn't look" — see [`PluginInstallStatus::Unverified`].
    fn unverified(p: &crate::config::KnownPlugin) -> Self {
        Self {
            key: p.toggle.to_string(),
            id: p.id(),
            status: PluginInstallStatus::Unverified,
            message: Some(UNVERIFIED_MESSAGE.to_string()),
            detail: None,
        }
    }

    fn failed(p: &crate::config::KnownPlugin, message: &str, detail: Option<String>) -> Self {
        Self {
            key: p.toggle.to_string(),
            id: p.id(),
            status: PluginInstallStatus::Failed,
            message: Some(message.to_string()),
            detail,
        }
    }
}

/// Remedy copy for the case where `claude` itself isn't on the machine yet.
const NO_CLAUDE_MESSAGE: &str =
    "Claude Code isn't installed yet, so this plugin can't be fetched. Finish setup, then turn it \
     on again.";
/// Remedy copy for an install that actually ran and failed (offline, marketplace outage, timeout).
const INSTALL_FAILED_MESSAGE: &str =
    "Sparkle couldn't install this plugin, so agents won't see it yet. Check your connection — \
     Sparkle retries on the next launch.";
/// Copy for a plugin we believe is installed but could not confirm.
const UNVERIFIED_MESSAGE: &str =
    "Sparkle can't confirm this plugin is installed — it couldn't read Claude Code's plugin folder. \
     It's on, and agents will use it if it's there.";
/// Remedy copy for a plugin whose install already failed earlier THIS SESSION and was suppressed.
const SUPPRESSED_MESSAGE: &str =
    "An earlier install attempt failed this session, so Sparkle skipped it. Turn this off and on \
     again to retry.";

/// Every Claude Code config tree an agent Sparkle spawns might resolve plugins under.
///
/// THE BUG THIS FIXES: plugins are installed PER CONFIG TREE, and Sparkle's multi-account support
/// sets `CLAUDE_CONFIG_DIR` **on the agent's shell command** (`claudeSpawn.ts`'s `buildClaudeExec`),
/// never on the desktop process. So reading the var from our own environment — which is what an
/// earlier pass at this did — resolves to `$HOME/.claude` on every normal Finder/Dock launch, the
/// install lands there, and an agent running on account `ab12` looks in
/// `<app_data>/accounts/ab12/plugins` and finds nothing. Its enabled plugins silently never load,
/// forever, because the home tree observes as complete and the pass never self-corrects.
///
/// `None` is the default tree (our own `$CLAUDE_CONFIG_DIR` if set, else `$HOME/.claude`) — kept as
/// `None` rather than resolved so the child inherits exactly what it would have. Every registered
/// account then contributes its own dir. Deduped by the resolved PLUGINS dir, since the imported
/// "default" account's `config_dir` IS `~/.claude` and would otherwise be scanned twice.
///
/// `env_config_dir` is Sparkle's own `$CLAUDE_CONFIG_DIR`, passed rather than read here so the
/// dedup — and therefore this function's whole answer — doesn't depend on the environment the test
/// binary happens to run under.
fn plugin_config_trees(
    app_data: &Path,
    env_config_dir: Option<&Path>,
    home: Option<&Path>,
) -> Vec<Option<PathBuf>> {
    let mut out: Vec<Option<PathBuf>> = vec![None];
    let mut seen: Vec<PathBuf> = Vec::new();
    if let Some(home) = home {
        seen.push(claude_plugins_dir(env_config_dir, home));
    }
    let accounts = crate::accounts::read_accounts_at(&crate::accounts::accounts_json_path(app_data))
        .unwrap_or_default();
    for acct in accounts {
        if acct.config_dir.is_empty() {
            continue;
        }
        let dir = PathBuf::from(&acct.config_dir);
        let plugins = dir.join("plugins");
        if seen.contains(&plugins) {
            continue;
        }
        seen.push(plugins);
        out.push(Some(dir));
    }
    out
}

/// The one config tree a [`run_install_pass`] call operates on. Bundled because these three always
/// travel together and describe a single thing: WHICH Claude Code state directory this pass is
/// installing into and observing.
#[derive(Clone, Copy)]
struct PluginTree<'a> {
    /// `$CLAUDE_CONFIG_DIR` for this tree, or `None` to inherit ours (the default tree).
    config_dir: Option<&'a Path>,
    /// The home dir to resolve the plugins root under, passed rather than read from the environment
    /// so a test can point it at a fixture without mutating process-wide state.
    home: Option<&'a Path>,
    /// True for the tree an agent uses when no account was chosen. Only that tree can have been
    /// described by the pre-map ledger shape, and passing it (rather than re-reading the process env
    /// inside the pass) keeps the answer independent of Sparkle's own environment.
    is_default: bool,
}

/// Install every enabled plugin the machine doesn't already have, then record what landed.
///
/// Runs ONE PASS PER CONFIG TREE (see [`plugin_config_trees`]) — the default one plus every
/// registered account — because a plugin present under `~/.claude` is invisible to an agent spawned
/// on another account. The reported outcome per plugin is the WORST across trees: if any tree an
/// agent could use is missing it, the row must not say it's fine.
///
/// The skip decision is gated on OBSERVED state (see [`observe_installed_plugins`]), not on the
/// ledger alone — so uninstalling a plugin, or wiping a plugins tree, makes the next pass reinstall
/// rather than skipping forever.
///
/// Best-effort by contract: a plugin that fails (offline, a marketplace outage, `claude` not
/// installed, a hung child hitting the timeout) is logged, stays out of the ledger so the next pass
/// retries it, and comes back as a `Failed` outcome. It never fails the CALLER — a plugin that
/// didn't install must not break agent spawning, and the `enabledPlugins` entry we already wrote
/// means the plugin activates as soon as it IS present.
///
/// `force_key` is the `[plugins]` toggle the USER just switched on. Without it the `ATTEMPTED`
/// suppression — which exists to stop an un-installable machine burning 90s network calls on every
/// agent prepare — also swallows the toggle, making "turn it off and on again" (the only remedy the
/// UI offers) a silent no-op that renders as success. It names ONE plugin rather than being a bare
/// bool because clearing every enabled-but-missing plugin's suppression would re-run their installs
/// too: on an offline machine, toggling `superpowers` would block the awaited call on two more 90s
/// network shell-outs for `frontend_design`, holding the PASS mutex the whole time.
///
/// Installs at USER scope on purpose: that populates the one shared plugin cache all worktrees
/// read, so the fetch happens once per machine per tree instead of once per agent.
fn ensure_plugins_installed(
    app_data: &Path,
    enabled: &[&'static crate::config::KnownPlugin],
    force_key: Option<&str>,
) -> Vec<PluginInstallOutcome> {
    // One pass at a time, process-wide. Three call sites can fire concurrently (startup, EVERY
    // agent prepare, a UI toggle), and a pass is a read-modify-write of the ledger wrapped around a
    // slow network call — so two overlapping passes would duplicate `claude plugin install` work
    // and let the second's write drop the first's entries. Poison-tolerant: a panicking pass must
    // not wedge every later one.
    static PASS: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _serialized = PASS.lock().unwrap_or_else(|e| e.into_inner());

    // Ids already attempted THIS PROCESS, as `<tree>\0<id>` — per TREE, because a failure under one
    // account says nothing about another. Without this suppression, an un-installable machine
    // (offline, marketplace outage, no `claude`) re-runs up to two 90s network shell-outs per plugin
    // per tree on every single agent prepare — five agents was ~15 minutes of blocking-pool work
    // that fails again. The documented contract is already "a failure retries next launch", and this
    // makes that literal.
    static ATTEMPTED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let mut attempted = ATTEMPTED.lock().unwrap_or_else(|e| e.into_inner());

    let Some(claude) = crate::preflight::cached_claude_path() else {
        // No Claude Code on this machine yet (first-run, mid-onboarding). Nothing recorded and
        // nothing attempted, so the next pass — after setup — picks these up.
        //
        // Observe FIRST rather than blanket-failing: `cached_claude_path` memoizes only positive
        // results, so a transient login-shell probe miss on an otherwise healthy machine would
        // otherwise tell a user whose plugins are demonstrably on disk to "finish setup".
        tracing::info!("plugin pre-enable: `claude` not found yet; deferring install");
        let home = home_dir();
        let present = home
            .as_deref()
            .and_then(|h| observe_installed_plugins(claude_config_dir_env().as_deref(), h))
            .unwrap_or_default();
        let outcomes: Vec<PluginInstallOutcome> = enabled
            .iter()
            .map(|p| {
                if present.contains(&p.id()) {
                    PluginInstallOutcome::new(p, PluginInstallStatus::AlreadyPresent)
                } else {
                    PluginInstallOutcome::failed(p, NO_CLAUDE_MESSAGE, None)
                }
            })
            .collect();
        remember_outcomes(&outcomes);
        return outcomes;
    };

    let home = home_dir();
    let mut merged: Vec<PluginInstallOutcome> = Vec::new();

    // The FIRST tree is the default one — see `plugin_config_trees`.
    let trees = plugin_config_trees(app_data, claude_config_dir_env().as_deref(), home.as_deref());
    for (i, tree) in trees.into_iter().enumerate() {
        let outcomes = run_install_pass(
            app_data,
            PluginTree { config_dir: tree.as_deref(), home: home.as_deref(), is_default: i == 0 },
            enabled,
            &mut attempted,
            force_key,
            &mut |args| run_claude(&claude, tree.as_deref(), args),
        );
        merge_outcomes(&mut merged, outcomes);
    }
    remember_outcomes(&merged);
    merged
}

/// The most recent pass's verdicts, so a pane that opens LATER can show them.
///
/// Without this, the startup and agent-prepare passes computed a per-plugin verdict and threw it
/// into `tracing`: on the machine this whole mechanism is for — install fails, "Sparkle retries on
/// the next launch", the retry fails again — the Tools pane showed the switch ON with no hint, and
/// the hint only appeared if the user happened to toggle. A cached read (rather than an event) means
/// the pane can't miss an outcome by mounting after it fired.
fn last_outcomes() -> &'static std::sync::Mutex<Vec<PluginInstallOutcome>> {
    static LAST: OnceLock<std::sync::Mutex<Vec<PluginInstallOutcome>>> = OnceLock::new();
    LAST.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

fn remember_outcomes(outcomes: &[PluginInstallOutcome]) {
    *last_outcomes().lock().unwrap_or_else(|e| e.into_inner()) = outcomes.to_vec();
}

/// What the last install pass concluded, per plugin — empty before any pass has run. Cheap: no
/// filesystem work, no shell-out. The Tools pane hydrates from this on mount so a failure from the
/// STARTUP pass is visible without the user toggling anything.
#[tauri::command]
pub fn plugin_install_outcomes() -> Vec<PluginInstallOutcome> {
    last_outcomes().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Log one pass's verdicts. Shared by the startup and agent-prepare call sites so they can't drift.
///
/// Failures are COALESCED into a single line rather than one warning per plugin: on a first-run
/// machine every enabled plugin fails for the same expected, self-healing reason (`claude` isn't
/// installed yet), and N warnings per launch for that is noise that trains people to ignore the log.
/// That case is logged at `info` for the same reason — it is not a problem, it is onboarding.
pub fn log_install_outcomes(outcomes: &[PluginInstallOutcome]) {
    let installed: Vec<&str> = outcomes
        .iter()
        .filter(|o| o.status == PluginInstallStatus::Installed)
        .map(|o| o.id.as_str())
        .collect();
    if !installed.is_empty() {
        tracing::info!(?installed, "plugin pre-enable: installed");
    }
    let failed: Vec<&PluginInstallOutcome> = outcomes
        .iter()
        .filter(|o| o.status == PluginInstallStatus::Failed)
        .collect();
    if failed.is_empty() {
        return;
    }
    let ids: Vec<&str> = failed.iter().map(|o| o.id.as_str()).collect();
    let reason = failed[0].message.as_deref().unwrap_or("unknown");
    let detail = failed.iter().filter_map(|o| o.detail.as_deref()).collect::<Vec<_>>().join("; ");
    if failed.iter().all(|o| o.message.as_deref() == Some(NO_CLAUDE_MESSAGE)) {
        tracing::info!(?ids, "plugin pre-enable: deferred until Claude Code is installed");
    } else {
        tracing::warn!(?ids, reason, detail, "plugin pre-enable: not installed");
    }
}

/// Fold one tree's outcomes into the running answer, keeping the WORST per plugin.
///
/// "Worst" is the honest reduction: `Failed` in any tree means some agent will run without the
/// plugin, and `Installed` beats `AlreadyPresent` only so the log can say something happened.
fn merge_outcomes(into: &mut Vec<PluginInstallOutcome>, from: Vec<PluginInstallOutcome>) {
    for o in from {
        match into.iter_mut().find(|e| e.id == o.id) {
            None => into.push(o),
            Some(existing) => {
                // Worst wins. `Unverified` outranks a clean verdict (we can't vouch for the tree)
                // but not an outright failure (which we CAN vouch for).
                let rank = |s: PluginInstallStatus| match s {
                    PluginInstallStatus::Failed => 3,
                    PluginInstallStatus::Unverified => 2,
                    PluginInstallStatus::Installed => 1,
                    PluginInstallStatus::AlreadyPresent => 0,
                };
                if rank(o.status) > rank(existing.status) {
                    *existing = o;
                }
            }
        }
    }
}

/// The argv for registering a marketplace. Extracted so the exact command — and the fact that it
/// runs BEFORE the install — is asserted directly rather than inferred.
fn marketplace_add_args(repo: &str) -> Vec<String> {
    vec!["plugin".into(), "marketplace".into(), "add".into(), repo.into()]
}

/// The argv for installing one plugin. `--scope user` is the load-bearing part: it populates the
/// one shared plugin cache every worktree resolves against, so the fetch happens once per machine
/// instead of once per agent.
fn install_args(id: &str) -> Vec<String> {
    vec!["plugin".into(), "install".into(), id.into(), "--scope".into(), "user".into()]
}

/// The install pass, with the subprocess runner and the attempted-set injected. Everything that
/// decides WHAT to run and what to record lives here, so the ordering (marketplace before install),
/// the append-on-success / skip-on-failure ledger policy, the retry suppression, and the per-plugin
/// outcome are all testable without a network or a `claude` binary.
///
/// Returns ONE outcome per enabled plugin, in table order — including the ones it didn't touch, so
/// a caller can always answer "is this plugin actually on the machine?" for the row it toggled.
fn run_install_pass(
    app_data: &Path,
    tree: PluginTree<'_>,
    enabled: &[&'static crate::config::KnownPlugin],
    attempted: &mut Vec<String>,
    // The `[plugins]` toggle key the USER just switched on, if any — see
    // [`ensure_plugins_installed`]. Scoped to one plugin on purpose.
    force_key: Option<&str>,
    run: &mut dyn FnMut(&[String]) -> Result<(), String>,
) -> Vec<PluginInstallOutcome> {
    let PluginTree { config_dir, home, is_default: is_default_tree } = tree;
    // Everything below is scoped to ONE plugins tree: the ledger entry, the observation, and the
    // per-process suppression keys. Sharing any of them across trees is what let a plugin present
    // under `~/.claude` mask its absence from an account store.
    let Some(home_dir_for_tree) = home else {
        // No home to resolve a plugins root under — we can't observe, key a ledger, or say anything
        // truthful about presence. UNVERIFIED, not "install failed": we have no evidence either way,
        // and claiming a failure would be as wrong as claiming success.
        return enabled
            .iter()
            .map(|p| PluginInstallOutcome::unverified(p))
            .collect();
    };
    let root = claude_plugins_dir(config_dir, home_dir_for_tree);
    let ledger_path = installed_ledger_path(app_data);
    let ledger = read_installed_ledger(&ledger_path, &root, is_default_tree);
    let observed = observe_installed_plugins(config_dir, home_dir_for_tree);
    // Remember WHETHER we could look before the value is consumed: "observed as present" and
    // "assumed present from the ledger" are different answers and must not collapse.
    let could_observe = observed.is_some();
    let mut installed = already_installed(ledger.clone(), observed);
    let needed = plugins_needing_install(enabled, &installed);
    // Suppression keys are per (tree, plugin) — a failure under one account says nothing about
    // another. `force` bypasses the suppression AND clears the entries, so the retry is a real retry
    // rather than a second no-op; it is scoped to `force_key` so toggling one row doesn't re-run
    // every other enabled-but-missing plugin's 90s network calls, which is the exact burn the
    // suppression exists to prevent.
    let key_for = |p: &crate::config::KnownPlugin| format!("{}\0{}", root.display(), p.id());
    let forced = |p: &crate::config::KnownPlugin| force_key.is_some_and(|k| k == p.toggle);
    for p in needed.iter().filter(|p| forced(p)) {
        let key = key_for(p);
        attempted.retain(|k| *k != key);
    }
    let todo: Vec<_> = needed
        .iter()
        .copied()
        .filter(|p| !attempted.contains(&key_for(p)))
        .collect();

    let mut outcomes: Vec<PluginInstallOutcome> = enabled
        .iter()
        .map(|p| {
            if todo.iter().any(|t| t.id() == p.id()) {
                // Overwritten by the loop below with the real verdict. Starting at `Failed` means a
                // plugin whose install somehow never ran can never be reported as fine.
                PluginInstallOutcome::failed(p, INSTALL_FAILED_MESSAGE, None)
            } else if needed.iter().any(|n| n.id() == p.id()) {
                // Needed but skipped: an earlier attempt THIS PROCESS already failed. Saying so is
                // what makes toggle-off/on discoverable as the remedy.
                PluginInstallOutcome::failed(p, SUPPRESSED_MESSAGE, None)
            } else if could_observe {
                // We LOOKED and saw it.
                PluginInstallOutcome::new(p, PluginInstallStatus::AlreadyPresent)
            } else {
                // We couldn't look — this answer came from the write-only ledger. Say so instead of
                // clearing the row, which is the "claim success we can't see" case narrowed to a
                // plugins dir whose layout we don't recognize.
                PluginInstallOutcome::unverified(p)
            }
        })
        .collect();

    for p in todo {
        let id = p.id();
        attempted.push(key_for(p));
        // The marketplace has to be registered before its plugins resolve — including the OFFICIAL
        // one, which Claude Code only self-registers once it has been launched interactively.
        // Idempotent, and a failure here is not fatal: the install below reports the real problem.
        if let Some(src) = p.source {
            if let Err(e) = run(&marketplace_add_args(src.repo)) {
                tracing::warn!(error = %e, marketplace = src.name, "plugin pre-enable: marketplace add failed");
            }
        }
        let result = run(&install_args(&id));
        // Positional, not a find-by-id: `todo ⊆ enabled` so the slot always exists, and a lookup
        // miss would silently leave the pre-seeded `Failed` placeholder — reporting a SUCCESSFUL
        // install as a failure, with no log line to explain it.
        match outcomes.iter().position(|o| o.id == id) {
            Some(i) => {
                outcomes[i] = match &result {
                    Ok(()) => PluginInstallOutcome::new(p, PluginInstallStatus::Installed),
                    Err(e) => {
                        PluginInstallOutcome::failed(p, INSTALL_FAILED_MESSAGE, Some(e.clone()))
                    }
                }
            }
            None => tracing::error!(
                plugin = %id,
                "plugin pre-enable: installed a plugin with no outcome slot — todo escaped `enabled`"
            ),
        }
        match result {
            Ok(()) => {
                tracing::info!(plugin = %id, tree = %root.display(), "plugin pre-enable: installed");
                installed.push(id);
            }
            // Left out of the ledger, so the NEXT LAUNCH retries (this launch won't — see ATTEMPTED).
            Err(e) => tracing::warn!(error = %e, plugin = %id, tree = %root.display(), "plugin pre-enable: install failed (will retry next launch)"),
        }
    }

    // Record only OUR known plugins: `installed` may carry observed ids belonging to plugins the
    // user installed themselves, and the ledger is Sparkle's own fallback for a tree we can't
    // observe. Written whenever it DIFFERS from what we read — not only after a fresh install —
    // so a plugin observed as gone stops being claimed even if its reinstall then failed. The write
    // MERGES into the per-root map so this tree's entry can't clobber another's.
    let ours: Vec<String> = installed
        .iter()
        .filter(|id| crate::config::KNOWN_PLUGINS.iter().any(|p| p.id() == **id))
        .cloned()
        .collect();
    if ours != ledger {
        let existing = std::fs::read_to_string(&ledger_path).ok();
        let body = merged_ledger(existing.as_deref(), &root, is_default_tree, &ours);
        if let Err(e) = std::fs::write(&ledger_path, body) {
            // A lost ledger only costs a redundant (idempotent) install next pass.
            tracing::warn!(error = %e, "plugin pre-enable: could not record the install ledger");
        }
    }
    outcomes
}

/// The user's home dir, for locating the plugins tree (see [`claude_plugins_dir`]). `None` on the
/// (pathological) machine where neither HOME nor USERPROFILE is set — observation then degrades to
/// the ledger.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Startup entry point: ensure the GLOBALLY enabled plugins are installed. Also invoked from the
/// frontend when a `[plugins]` toggle is switched on mid-session, so the install doesn't wait for
/// the next launch.
///
/// Returns ONE [`PluginInstallOutcome`] per enabled plugin. The `Ok` here means "the pass ran", NOT
/// "everything installed" — a failed install must not break agent spawning, so the per-plugin
/// verdict rides in the payload and the UI decides what to say about it.
///
/// `force_key` is the `[plugins]` toggle key the UI just switched on. It bypasses the per-process
/// retry suppression FOR THAT PLUGIN, without which toggling a failed plugin off and on — the only
/// remedy the UI offers — is a silent no-op. Scoped to one key so a click on one row can't kick off
/// the other rows' 90s network retries inside the same awaited call.
///
/// `async` + `spawn_blocking` is REQUIRED, not stylistic: a sync `#[tauri::command]` runs on the
/// main thread, and this one shells out to `claude plugin marketplace add` + `claude plugin install`
/// for every enabled-but-absent plugin, each bounded only by the 90s [`PLUGIN_CMD_TIMEOUT`]. Called
/// straight from a UI toggle that would be minutes of frozen app.
#[tauri::command]
pub async fn ensure_default_plugins_installed(
    app: AppHandle,
    force_key: Option<String>,
) -> Result<Vec<PluginInstallOutcome>, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let enabled = crate::config::current_effective().config.plugins.enabled();
        ensure_plugins_installed(&app_data, &enabled, force_key.as_deref())
    })
    .await
    .map_err(|e| format!("plugin install pass failed: {e}"))
}

/// The per-agent log filename key: the worktree's basename (its agent UUID), or "agent" if the
/// path has no usable final component. Pure, so the basename/fallback is unit-testable without an
/// AppHandle.
fn log_key(worktree: &str) -> String {
    Path::new(worktree)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("agent")
        .to_string()
}

/// Per-agent event-log path: `<app_data>/hook-events/<agentId>.jsonl`. The worktree's basename
/// is the agent's UUID (worktrees live at `<app_data>/worktrees/<projectId>/<agentId>`), so it's
/// a stable, collision-free key — and the log sits outside the worktree, invisible to git.
pub fn event_log_path(app: &AppHandle, worktree: &str) -> Result<PathBuf, String> {
    let base = crate::dev_identity::app_data_dir(app)?;
    Ok(base
        .join("hook-events")
        .join(format!("{}.jsonl", log_key(worktree))))
}

/// Confine a frontend-supplied worktree path to the app's managed worktrees dir before we write
/// an executable hook config into it. `install_agent_hooks` writes `.claude/settings.local.json`,
/// which Claude Code runs hook *commands* from — so an unconfined path is a write-anywhere →
/// persistent-code-execution primitive (e.g. planting hooks in `$HOME`). Canonicalize BOTH sides
/// (resolving symlinks and `..`) and require the worktree to live under `<app_data>/worktrees`.
/// Fail-closed: a base that can't be resolved, or a non-existent worktree, is rejected. Pure core
/// (no AppHandle) so it unit-tests. Mirrors `pty::validate_spawn_inner`.
fn confine_to_worktrees(worktrees_base: &Path, worktree: &str) -> Result<PathBuf, String> {
    let base = worktrees_base
        .canonicalize()
        .map_err(|e| format!("install_agent_hooks: worktrees dir unavailable: {e}"))?;
    let real = std::fs::canonicalize(worktree)
        .map_err(|e| format!("install_agent_hooks: invalid worktree path: {e}"))?;
    if !real.starts_with(&base) {
        return Err("install_agent_hooks: worktree is outside the managed worktrees directory".into());
    }
    Ok(real)
}

/// Write/merge the event emitter into `<worktree>/.claude/settings.local.json`, plus Sparkle's
/// default-on Claude Code plugins. Returns the absolute event-log path so the frontend can start
/// watching it.
///
/// `project_root` (optional) is the repo the worktree belongs to. It is used only to resolve the
/// repo-scoped `[plugins]` layer, so a repo's own `.sparkle/config.toml` can decide which agent
/// plugins its agents get. Absent → the global layer alone, which is the correct fallback.
/// Runs on the BLOCKING pool. The body is ~8 synchronous filesystem operations — two
/// `canonicalize()` walks, a bundle→app-data file copy (`stage_resource_script`), two
/// `create_dir_all`s, a `read_to_string`, an atomic write+rename, and a `config::for_project` stat
/// (plus a read+parse on a memo miss) — and it fires on EVERY agent prepare. As a plain
/// `#[tauri::command]` every one of those ran on the AppKit main thread.
///
/// Note the pre-existing inner `spawn_blocking` for the marketplace install is unaffected: it was
/// already off-thread and stays detached.
#[tauri::command]
pub async fn install_agent_hooks(
    app: AppHandle,
    worktree: String,
    project_root: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_agent_hooks_sync(app, worktree, project_root))
        .await
        .map_err(|e| format!("install_agent_hooks task failed: {e}"))?
}

/// Compose the whole body Sparkle owns in an agent worktree's `settings.local.json`: the event
/// emitter hooks, the default-on plugin keys, and the permission posture — the pre-approved
/// allowlist plus `bypassPermissions`, the deny list and the bypass consent record
/// ([`crate::worktree::merge_agent_worktree_settings`]) — chained over whatever the file already
/// had, so one atomic write carries all of it.
///
/// Order matters only in that each merge reads the previous one's output; all three preserve keys
/// they do not own. The posture step is the load-bearing addition: it is ALSO performed by
/// [`crate::worktree::merge_guard_settings`], and that duplication is deliberate. The allowlist
/// used to ride solely on the guard installer, so the two callers in `AgentPane.prepare` —
/// `installWorktreeGuard` (wrapped in a `try/catch` that only warns) and `installAgentHooks` — had
/// a silent dependency: lose the first and the agent spawned with nothing pre-approved, prompting
/// the human for Sparkle's own control-plane calls. Either installer is now sufficient, and
/// `merge_allowed_tools` de-duplicates by rule string so running both changes nothing.
pub fn compose_agent_settings(
    existing: Option<&str>,
    emitter_cmd: &str,
    plugins: &[&crate::config::KnownPlugin],
) -> String {
    let merged = merge_event_hooks(existing, emitter_cmd);
    let merged = merge_plugin_settings(Some(&merged), plugins);
    crate::worktree::merge_agent_worktree_settings(Some(&merged))
}

/// Blocking core of [`install_agent_hooks`].
pub fn install_agent_hooks_sync(
    app: AppHandle,
    worktree: String,
    project_root: Option<String>,
) -> Result<String, String> {
    // Confine the write target to the managed worktrees dir — this file drives executable hooks.
    let worktrees_base = crate::dev_identity::app_data_dir(&app)?.join("worktrees");
    let worktree_dir = confine_to_worktrees(&worktrees_base, &worktree)?;

    // Stage the emitter to a stable app-data path (not the app bundle) so the command baked into
    // settings.local.json survives the bundle being renamed/replaced/removed (see stage_resource_script).
    let emitter = stage_resource_script(&app, "sparkle-hook.mjs")?;
    let log = event_log_path(&app, &worktree)?;
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir hook-events: {e}"))?;
    }
    let emitter_cmd = hook_command(&emitter, &log);

    let dir = worktree_dir.join(".claude");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir .claude: {e}"))?;
    let file = dir.join("settings.local.json");
    // Held across read→merge→write so a concurrent `heal_agent_hooks` (or a second install for this
    // same worktree) cannot have its write silently reverted by ours. Scoped to a block so it is
    // released before the marketplace-install `spawn_blocking` below, which does not touch this
    // file and must not be serialized behind it. See `settings_write_lock`.
    // THE SECOND INSTALLER MUST ALSO LEAVE A MERGE POLICY ON DISK. `AgentPane.prepare` wraps
    // `installWorktreeGuard` in a `try/catch` that only warns, then calls `installAgentHooks`
    // unconditionally — and the compose below applies the FULL posture, `bypassPermissions`
    // included. Written by BOTH installers for exactly the reason `merge_permission_posture` is:
    // otherwise a failed guard install on a worktree whose guard hook an earlier prepare already
    // registered yields bypass ON, guard hook ACTIVE, and no `.sparkle/merge-policy.json` — which
    // `worktree-guard.mjs` reads as "not Sparkle-managed, no opinion", reopening the §7 hole.
    // Resolved BEFORE the lock: it shells out to git and must not hold the settings write lock.
    let merge_plan = crate::worktree::plan_merge_policy_at(&worktree)?;

    let enabled = {
        let write_lock = settings_write_lock(&file);
        let _w = write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let existing = std::fs::read_to_string(&file).ok();
        let cfg = plugins_layer_for(project_root.as_deref());
        let enabled = cfg.plugins.enabled();
        let merged = compose_agent_settings(existing.as_deref(), &emitter_cmd, &enabled);
        // …and the deny rule that pairs with that policy file, in the same atomic write.
        let merged = crate::worktree::merge_conditional_merge_deny_settings(
            Some(&merged),
            merge_plan.posture,
        );
        // Atomic + JSON-validated: a concurrently-running Claude (this file drives its executable
        // hooks) must never read a truncated/partial write, and we refuse to clobber invalid JSON.
        atomic_write_settings(&file, &merged)?;
        // ONLY NOW may a relaxation be recorded — see `commit_merge_policy`. Inside the lock, so a
        // concurrent installer cannot read a policy file that disagrees with the settings on disk.
        crate::worktree::commit_merge_policy(&merge_plan)?;
        enabled
    };

    // Install what this PROJECT's layer enables (bead sparkle-s3g2.1 follow-up). The startup pass
    // only ever sees the GLOBAL layer, so a repo that enables a plugin its `.sparkle/config.toml`
    // turns on — the whole point of [plugins] being repo-scoped — would get the `enabledPlugins`
    // entry written above and no actual install, i.e. a plugin that never loads. Off the hot path:
    // spawned onto the blocking pool so a cold marketplace fetch never delays the agent's PTY, and
    // idempotent, so the common already-installed case is a filesystem check and nothing more.
    if let Ok(app_data) = crate::dev_identity::app_data_dir(&app) {
        tauri::async_runtime::spawn_blocking(move || {
            // No force key — this fires on EVERY agent prepare, so it must keep the per-process
            // retry suppression. Only the user-initiated toggle bypasses it, and only for its row.
            log_install_outcomes(&ensure_plugins_installed(&app_data, &enabled, None));
        });
    }
    Ok(log.to_string_lossy().into_owned())
}

/// Resolve the config layer whose `[plugins]` applies to a worktree. `project_root` must be an
/// ABSOLUTE path to an existing directory to be used: `config::for_project` memoizes by the string
/// it's handed, so a relative path, an empty string, or a stale/deleted root would both resolve
/// against nothing useful AND take a permanent slot in that memo map. Anything else falls back to
/// the global layer, which is the correct (just not repo-aware) answer.
fn plugins_layer_for(project_root: Option<&str>) -> crate::config::SparkleConfig {
    match project_root {
        Some(root) if Path::new(root).is_absolute() && Path::new(root).is_dir() => {
            crate::config::for_project(root).config
        }
        Some(root) => {
            tracing::warn!(
                root,
                "plugin pre-enable: project root is not an absolute existing directory; \
                 using the global [plugins] layer"
            );
            crate::config::current_effective().config
        }
        None => crate::config::current_effective().config,
    }
}

/// A settings file needs healing for `marker` when it still registers that hook but the command
/// does NOT reference the current stable script path — i.e. it points at an old/renamed bundle.
/// Pure (string-only) so it's unit-testable. A file that never had the hook is left untouched.
fn needs_heal(settings: &str, marker: &str, stable_path: &str) -> bool {
    settings.contains(marker) && !settings.contains(stable_path)
}

/// Rewrite stale emitter/guard hook commands in one settings file to the current stable paths,
/// preserving everything else (user keys, the other hook, ordering). Returns the updated JSON only
/// if something actually changed — so an already-stable (or hook-free) file is left byte-for-byte
/// intact and isn't needlessly rewritten. Pure, so the heal policy is unit-tested.
fn heal_settings(settings: &str, emitter: &Path, emitter_cmd: &str, guard: &Path, guard_cmd: &str) -> Option<String> {
    let mut out: Option<String> = None;
    if needs_heal(settings, EMITTER_MARKER, &emitter.to_string_lossy()) {
        out = Some(merge_event_hooks(Some(out.as_deref().unwrap_or(settings)), emitter_cmd));
    }
    if needs_heal(out.as_deref().unwrap_or(settings), GUARD_MARKER, &guard.to_string_lossy()) {
        out = Some(crate::worktree::merge_guard_settings(
            Some(out.as_deref().unwrap_or(settings)),
            guard_cmd,
        ));
    }
    out
}

/// Walk every managed worktree (`<worktrees_base>/<project>/<agent>`) and re-point any stale
/// emitter/guard hook in its `settings.local.json` at the stable script paths. Returns how many
/// worktrees were healed. Takes resolved paths (no AppHandle) so it unit-tests with temp dirs.
/// Serializes the read→merge→write sequence on ONE `settings.local.json`.
///
/// ── WHY THIS EXISTS, AND WHY IT DID NOT BEFORE ────────────────────────────────────────────────
/// `install_agent_hooks_sync` and `scan_and_heal` both read this file, transform it, and write it
/// back. While they were plain `#[tauri::command]`s their bodies ran on the AppKit main thread, so
/// they were mutually exclusive BY CONSTRUCTION and no lock was needed. Moving them to the blocking
/// pool ENABLED concurrency that never existed — the second-order cost of an off-main-thread
/// conversion, and the one that is invisible in the diff.
///
/// `atomic_write_settings` does not cover it: it prevents a TORN read, not a LOST UPDATE. Walk the
/// failure: heal (app launch) and install (agent prepare) both read the stale file; heal writes the
/// repaired hook paths; install then writes its merge derived from the stale copy, silently
/// reverting the heal — so that worktree's hooks keep pointing at a removed bundle, which is the
/// exact failure `heal_agent_hooks` exists to fix. Two concurrent installs for one worktree lose the
/// plugin-enablement merge the same way.
fn settings_write_lock(path: &Path) -> std::sync::Arc<std::sync::Mutex<()>> {
    #[allow(clippy::type_complexity)]
    static LOCKS: OnceLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, std::sync::Arc<std::sync::Mutex<()>>>>,
    > = OnceLock::new();
    let map = LOCKS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    std::sync::Arc::clone(guard.entry(settings_lock_key(path)).or_default())
}

/// Canonical key for [`settings_write_lock`].
///
/// The two call sites build this path differently — install joins onto a `confine_to_worktrees`
/// result (already canonicalized), heal joins onto a `read_dir` entry (not). On macOS that alone is
/// enough to produce `/var/...` and `/private/var/...` for the same file, and two different keys
/// mean two different mutexes, i.e. no serialization at all while the code reads as if there were.
/// The PARENT is canonicalized rather than the file: the file may not exist yet on install's first
/// write, but `.claude/` is created before this is called and always exists for heal.
fn settings_lock_key(path: &Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => {
            parent.canonicalize().map(|p| p.join(name)).unwrap_or_else(|_| path.to_path_buf())
        }
        _ => path.to_path_buf(),
    }
}

fn scan_and_heal(
    worktrees_base: &Path,
    hook_events_base: &Path,
    emitter: &Path,
    guard: &Path,
) -> Result<u32, String> {
    let mut healed = 0u32;
    let projects = match std::fs::read_dir(worktrees_base) {
        Ok(rd) => rd,
        Err(_) => return Ok(0), // no worktrees dir yet — nothing to heal
    };
    for project in projects.flatten() {
        let agents = match std::fs::read_dir(project.path()) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for agent in agents.flatten() {
            let worktree = agent.path();
            let settings_path = worktree.join(".claude").join("settings.local.json");
            // Held across read→heal→write so a concurrent `install_agent_hooks` cannot write a
            // merge derived from the copy we are about to replace. See `settings_write_lock`.
            let write_lock = settings_write_lock(&settings_path);
            let _w = write_lock.lock().unwrap_or_else(|e| e.into_inner());
            let existing = match std::fs::read_to_string(&settings_path) {
                Ok(s) => s,
                Err(_) => continue, // no hooks installed for this worktree
            };
            let log = hook_events_base.join(format!("{}.jsonl", log_key(&worktree.to_string_lossy())));
            let emitter_cmd = hook_command(emitter, &log);
            let guard_cmd = hook_command(guard, &worktree);
            if let Some(updated) = heal_settings(&existing, emitter, &emitter_cmd, guard, &guard_cmd) {
                atomic_write_settings(&settings_path, &updated)
                    .map_err(|e| format!("heal {}: {e}", settings_path.to_string_lossy()))?;
                healed += 1;
            }
        }
    }
    Ok(healed)
}

/// Self-heal stale hook script paths across every existing agent worktree. Called at app launch:
/// re-stages the emitter + write-guard to the stable app-data location, then re-points any
/// worktree whose baked hook paths reference an old/renamed/removed bundle. Idempotent — a no-op
/// once everything already points at the stable path. Returns the number of worktrees healed.
/// Runs on the BLOCKING pool. `scan_and_heal` is an UNBOUNDED nested directory walk — a `read_dir`
/// of the worktrees base, a `read_dir` per project, and a `read_to_string` (plus a possible
/// write+rename) per agent inside it — and this repo's own AGENTS.md describes "dozens of
/// worktrees". It is called at app LAUNCH, which is exactly when the main thread is most contended,
/// so as a plain `#[tauri::command]` it walked the whole tree inline on the AppKit main thread.
#[tauri::command]
pub async fn heal_agent_hooks(app: AppHandle) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || heal_agent_hooks_sync(app))
        .await
        .map_err(|e| format!("heal_agent_hooks task failed: {e}"))?
}

/// Blocking core of [`heal_agent_hooks`].
pub fn heal_agent_hooks_sync(app: AppHandle) -> Result<u32, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    let emitter = stage_resource_script(&app, "sparkle-hook.mjs")?;
    let guard = stage_resource_script(&app, "worktree-guard.mjs")?;
    scan_and_heal(
        &app_data.join("worktrees"),
        &app_data.join("hook-events"),
        &emitter,
        &guard,
    )
}

/// Hard cap on how many bytes ONE poll may pull off disk.
///
/// Without it a single poll read the whole remaining log with `read_to_end`, then copied it again
/// via `from_utf8_lossy`, again into a `Vec<String>`, and a fourth time through serde over the IPC —
/// ~4x the file size, transiently, ON THE MAIN THREAD. With a 100 MB accumulated log that is a
/// multi-hundred-MB spike per poll. 1 MiB is far more than a 500 ms tick can legitimately produce,
/// so in normal operation the cap never engages; it only bounds the pathological case.
pub const MAX_READ_BYTES: u64 = 1024 * 1024;

/// A batch of newly-appended event-log lines plus the byte offset to resume from.
#[derive(serde::Serialize)]
pub struct EventsChunk {
    pub lines: Vec<String>,
    pub offset: u64,
    /// True when this poll hit `MAX_READ_BYTES` and more data is already waiting at `offset`. The
    /// watcher uses it to poll again immediately instead of idling a full interval while behind.
    pub truncated: bool,
}

/// Incrementally read complete (newline-terminated) lines from the event log starting at byte
/// `offset`. The frontend polls this while an agent pane is open. A partial trailing line (the
/// emitter mid-write) is left unconsumed so it's read whole on the next poll; a shrunken file
/// (rotated/cleared) restarts from 0. A missing file (no event yet) yields an empty batch.
/// Confinement check for `read_events_since`, factored out for tests. `base` is the canonicalized
/// `<app_data>/hook-events`. When the log file EXISTS we canonicalize it fully (following symlinks)
/// and require the resolved path to be a regular file under `base` — so a symlink planted inside
/// the dir can't redirect the read to `/etc/passwd` etc. When the file is absent (no events emitted
/// yet) we fall back to validating that its existing PARENT directory resolves to `base`.
fn log_path_within(base: &Path, log_path: &str) -> bool {
    let p = Path::new(log_path);
    if let Ok(canon) = p.canonicalize() {
        // Existing file (symlink target resolved): must be a regular file that is a DIRECT child of
        // base (the event-log layout is flat) — `parent() == base`, consistent with the branch below.
        return canon.is_file() && canon.parent() == Some(base);
    }
    // File absent (no events yet). Reject if the final component is itself a (dangling) symlink — its
    // target could be created later to redirect the read outside base — so only a genuinely-absent
    // regular path that is a direct child of base is accepted.
    if std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return false;
    }
    p.parent()
        .and_then(|par| par.canonicalize().ok())
        .map(|par| par == base)
        .unwrap_or(false)
}

/// `skip_existing` (optional, defaults false): jump straight to EOF and return an empty batch.
/// A pane mounting on an agent with a large accumulated log wants only NEW events; doing that
/// server-side means we stat the file and return, instead of reading and discarding megabytes.
/// ── WHY THIS IS `async` + `spawn_blocking`, NOT A PLAIN `fn` ──────────────────────────────────
/// This is the highest-frequency filesystem command in the app: the frontend polls it every 500 ms
/// for EVERY open agent pane, so a fleet of 40 agents drives ~80 calls a second. Each one does two
/// `canonicalize()` walks, a `symlink_metadata`, an `open`, a `seek`, up to `MAX_READ_BYTES` of
/// reading and a UTF-8 scan. As a plain `#[tauri::command]` all of that ran INLINE on the AppKit
/// main thread (tauri-macros defaults to `ExecutionContext::Blocking`), so the cost was paid in
/// dropped frames continuously, not occasionally.
///
/// The confinement check moves across with the read deliberately: splitting them would leave a
/// TOCTOU window between validating the path and opening it. The cheap, non-blocking half — the
/// app-data path math, which is `dirs::data_dir()` plus a join and touches no filesystem — stays on
/// the caller thread so a bad handle never occupies a blocking-pool slot.
#[tauri::command]
pub async fn read_events_since(
    app: AppHandle,
    log_path: String,
    offset: u64,
    skip_existing: Option<bool>,
) -> Result<EventsChunk, String> {
    let skip = skip_existing.unwrap_or(false);
    // Confine reads to <app_data>/hook-events so a compromised renderer can't turn this into an
    // arbitrary-file read oracle. The legit path is always <app_data>/hook-events/<agentId>.jsonl.
    let base = match crate::dev_identity::app_data_dir(&app).map(|d| d.join("hook-events")) {
        Ok(b) => b,
        Err(_) => return Ok(EventsChunk { lines: vec![], offset, truncated: false }),
    };
    tauri::async_runtime::spawn_blocking(move || read_events_since_confined(&base, &log_path, offset, skip))
        .await
        .map_err(|e| format!("read_events_since task failed: {e}"))?
}

/// Blocking core of [`read_events_since`]: canonicalize the base, confine, read. Separated so the
/// tests can drive it synchronously — the same shape `support.rs` uses for `read_recent_logs_sync`.
pub fn read_events_since_confined(
    base: &Path,
    log_path: &str,
    offset: u64,
    skip: bool,
) -> Result<EventsChunk, String> {
    match base.canonicalize() {
        // hook-events dir not created yet → no events are possible; report an empty batch.
        Err(_) => Ok(EventsChunk { lines: vec![], offset, truncated: false }),
        Ok(canon_base) if log_path_within(&canon_base, log_path) => {
            read_events_since_impl(Path::new(log_path), offset, skip)
        }
        Ok(_) => Err("read_events_since: log_path is outside the managed hook-events dir".into()),
    }
}

pub fn read_events_since_impl(
    path: &Path,
    mut offset: u64,
    skip_existing: bool,
) -> Result<EventsChunk, String> {
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(EventsChunk { lines: vec![], offset, truncated: false });
        }
        Err(e) => return Err(format!("open log: {e}")),
    };
    let len = f.metadata().map_err(|e| format!("stat log: {e}"))?.len();
    if offset > len {
        offset = 0; // file was truncated/rotated — restart from the top
    }
    // Seek-to-EOF fast path: the caller only wants events from here on, so skip the backlog without
    // ever reading it. This is what keeps a pane mount O(1) instead of O(size of the whole log).
    if skip_existing {
        return Ok(EventsChunk { lines: vec![], offset: len, truncated: false });
    }
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek log: {e}"))?;
    // Bounded read (see MAX_READ_BYTES): never pull an unbounded amount onto the main thread.
    let available = len - offset;
    let truncated = available > MAX_READ_BYTES;
    let to_read = if truncated { MAX_READ_BYTES } else { available };
    let mut bytes = Vec::with_capacity(to_read as usize);
    Read::by_ref(&mut f)
        .take(to_read)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read log: {e}"))?;
    // Consume only through the last newline; the emitter appends whole lines atomically, so the
    // remainder (if any) is a write in progress — leave it for the next poll. Counting bytes (not
    // chars) keeps the offset exact regardless of content.
    let mut consumed = bytes
        .iter()
        .rposition(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    // A capped read with NO newline in it means a single line longer than the cap (corruption, or
    // an enormous tool payload). Advancing by 0 here would re-read the same block forever and wedge
    // the watcher, so consume the whole block and drop the unusable fragment.
    if consumed == 0 && truncated {
        consumed = bytes.len();
    }
    // Lossy decode so a stray non-UTF-8 byte (corruption, external tampering) can't error and
    // wedge the reader re-reading the same tail forever — the offset still advances past it.
    // Our emitter only ever writes UTF-8, so this is belt-and-suspenders.
    let text = String::from_utf8_lossy(&bytes[..consumed]);
    let lines = text
        .lines()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    Ok(EventsChunk {
        lines,
        offset: offset + consumed as u64,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Staged bundle resources (bead sparkle-1ueh3) ──────────────────────────────────────────
    //
    // These guard the three properties that make an updater swapping the app bundle under this
    // running process survivable: a NESTED source path can be staged at all, the destination is
    // keyed by BUILD SHA, and the resolve+copy happens exactly ONCE per process.

    /// Unique scratch root per test, so tests running in parallel in one binary cannot collide.
    fn stage_tmp(tag: &str) -> PathBuf {
        static CTR: AtomicU64 = AtomicU64::new(0);
        let n = CTR.fetch_add(1, Ordering::Relaxed);
        let d = std::env::temp_dir()
            .join(format!("sparkle-stage-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Write `<root>/<rel>` with `body`, creating parents. Stands in for the app bundle's
    /// `Contents/Resources/resources/` tree.
    fn put_resource(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
    }

    #[test]
    fn stages_a_nested_source_path_without_flattening_it() {
        // The thing the old flat `resources/<name>` helper could NOT express, which is why the
        // roborev hooks had to hand-roll their own bundle resolve.
        let tmp = stage_tmp("nested");
        let src = tmp.join("resources");
        let dest = tmp.join("bin").join("sha1");
        put_resource(&src, "roborev/post-commit", "#!/bin/sh\nroborev\n");
        // A DIFFERENT resource with the same leaf name, to prove the subdirectory is preserved
        // rather than collapsed onto the file name.
        put_resource(&src, "post-commit", "top level, not roborev's\n");

        let staged = stage_one(&src, &dest, "roborev/post-commit").expect("nested rel stages");
        assert_eq!(staged, dest.join("roborev").join("post-commit"));
        assert_eq!(std::fs::read_to_string(&staged).unwrap(), "#!/bin/sh\nroborev\n");

        let top = stage_one(&src, &dest, "post-commit").expect("flat rel still stages");
        assert_ne!(top, staged, "the nested path must not collapse onto the top-level one");
        assert_eq!(std::fs::read_to_string(&staged).unwrap(), "#!/bin/sh\nroborev\n");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_missing_resource_names_the_path_it_looked_at() {
        // The old site relied on `fs::copy`'s error, which surfaced as a bare
        // "stage <name>: No such file or directory" with nothing to act on.
        let tmp = stage_tmp("missing");
        let src = tmp.join("resources");
        std::fs::create_dir_all(&src).unwrap();
        let err = stage_one(&src, &tmp.join("bin").join("sha1"), "roborev/post-commit")
            .expect_err("a missing resource is an error");
        assert!(err.contains("roborev/post-commit"), "names the resource: {err}");
        assert!(
            err.contains(&src.join("roborev/post-commit").display().to_string()),
            "names the full path it looked at: {err}"
        );
        assert!(
            !tmp.join("bin").exists(),
            "a failed stage must not leave an empty staged dir behind for the sweep"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn refuses_to_stage_a_path_that_escapes_the_staging_dir() {
        let tmp = stage_tmp("escape");
        for rel in ["", "/etc/passwd", "../../etc/passwd", "roborev/../../x"] {
            assert!(
                stage_one(&tmp.join("resources"), &tmp.join("bin"), rel).is_err(),
                "must refuse {rel:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn staged_destination_is_keyed_by_build_sha_so_a_newer_build_cannot_overwrite_an_older_one() {
        // THE MODE-B FIX. `<app_data>/bin/` used to be flat: a newer process starting up
        // overwrote the exact file a running older process depends on, so an old Rust process
        // ended up launching a NEW-version control server against its own old socket protocol.
        let tmp = stage_tmp("sha-keyed");
        let bin = tmp.join("bin");
        let old_bundle = tmp.join("v1-resources");
        let new_bundle = tmp.join("v2-resources");
        put_resource(&old_bundle, "mcp-control-server.js", "VERSION ONE");
        put_resource(&new_bundle, "mcp-control-server.js", "VERSION TWO");

        let old = stage_all(&old_bundle, &bin, "aaaaaaa", &["mcp-control-server.js"]);
        let new = stage_all(&new_bundle, &bin, "bbbbbbb", &["mcp-control-server.js"]);
        let old_path = old.entries["mcp-control-server.js"].as_ref().unwrap();
        let new_path = new.entries["mcp-control-server.js"].as_ref().unwrap();

        assert_ne!(old_path, new_path, "two builds must not share a staged destination");
        assert_eq!(
            std::fs::read_to_string(old_path).unwrap(),
            "VERSION ONE",
            "the older build's staged copy must survive the newer build staging its own"
        );
        assert_eq!(std::fs::read_to_string(new_path).unwrap(), "VERSION TWO");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn an_unknown_build_sha_falls_back_to_a_per_process_segment() {
        // A real SHA is used verbatim...
        assert_eq!(build_segment("a1b2c3d", 4242), "a1b2c3d");
        // ...but "unknown" is NOT a discriminator: two different tarball builds would share
        // `bin/unknown/`, which is the same overwrite this scheme exists to prevent. Fail safe to
        // something unique per process instead.
        assert_eq!(build_segment("unknown", 4242), "unknown-4242");
        assert_ne!(
            build_segment("unknown", 4242),
            build_segment("unknown", 4243),
            "two unknown-SHA processes must never share a staged directory"
        );
        assert_eq!(build_segment("", 7), "unknown-7", "an empty SHA is also no discriminator");
        // And nothing that reaches a directory name may contain a separator.
        assert_eq!(build_segment("../../etc", 9), "etc");
    }

    #[test]
    fn staging_happens_once_per_process_so_a_bundle_swap_cannot_reach_the_staged_copy() {
        // The updater replaces /Applications/Sparkle.app under this process; `resolve()`
        // recomputes from `current_exe()`'s path STRING, so a per-call resolve would hand back the
        // NEW build's file with every `.exists()` guard passing. Assert the SIDE EFFECT: the loader
        // runs exactly once, and a later change to the SOURCE is invisible to the staged copy.
        static CELL: Mutex<Option<StagedBin>> = Mutex::new(None);
        static LOADS: AtomicU64 = AtomicU64::new(0);

        let tmp = stage_tmp("once");
        let bundle = tmp.join("resources");
        let bin = tmp.join("bin");
        put_resource(&bundle, "mcp-control-server.js", "VERSION ONE");

        let names = ["mcp-control-server.js"];
        let load = |rels: &[&str]| {
            LOADS.fetch_add(1, Ordering::Relaxed);
            stage_all(&bundle, &bin, "aaaaaaa", rels)
        };
        // The retry gate is WIDE OPEN (`|| true`) on purpose: a load that produced a usable path
        // must be sealed regardless of it, so this still proves the once-only property after the
        // memo was made re-runnable.
        let first = staged_or_init(&CELL, &|| true, &names, &load);
        let first_path = first.entries["mcp-control-server.js"].as_ref().unwrap().clone();
        assert_eq!(std::fs::read_to_string(&first_path).unwrap(), "VERSION ONE");

        // ── the swap ──────────────────────────────────────────────────────────────────────────
        put_resource(&bundle, "mcp-control-server.js", "VERSION TWO");

        let second = staged_or_init(&CELL, &|| true, &names, &load);
        assert_eq!(LOADS.load(Ordering::Relaxed), 1, "the bundle must be read exactly once");
        assert_eq!(second.dir, first.dir);
        assert_eq!(
            second.entries["mcp-control-server.js"].as_ref().unwrap(),
            &first_path
        );
        assert_eq!(
            std::fs::read_to_string(&first_path).unwrap(),
            "VERSION ONE",
            "this process must keep running ITS OWN build's server after the bundle is replaced"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_resource_missing_from_the_bundle_falls_back_to_this_builds_own_staged_copy() {
        // The updater's `remove_dir_all` window makes the SOURCE vanish mid-session. `dest_dir` is
        // keyed by this build's segment, so the copy already sitting there is this build's own
        // bytes by construction — serving it beats an Err that nothing retries.
        let tmp = stage_tmp("fallback");
        let src = tmp.join("resources");
        let dest = tmp.join("bin").join("aaaaaaa");
        put_resource(&src, "mcp-control-server.js", "VERSION ONE");
        let staged = stage_one(&src, &dest, "mcp-control-server.js").expect("first stage");

        std::fs::remove_dir_all(&src).unwrap(); // ← the swap window
        let again = stage_one(&src, &dest, "mcp-control-server.js")
            .expect("an already-staged copy is served rather than a session-long Err");
        assert_eq!(again, staged);
        assert_eq!(std::fs::read_to_string(&again).unwrap(), "VERSION ONE");

        // ...and the fallback is not a blanket "any error is fine": a resource this build never
        // staged still fails, naming the path, so mode C stays loud.
        let err = stage_one(&src, &dest, "worktree-guard.mjs")
            .expect_err("nothing staged under this segment, so nothing to fall back to");
        assert!(err.contains("worktree-guard.mjs"), "names the resource: {err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_stage_in_which_nothing_landed_is_retried_rather_than_sealed_for_the_session() {
        // THE REGRESSION THIS GUARDS. The updater's poller fires AT LAUNCH and staging runs in
        // `setup()`, so the `remove_dir_all` window can make all six resources missing at exactly
        // the moment the memo is filled. Sealing that Err meant no agent could be opened, no hook
        // installed and no roborev hook written until the user quit and relaunched.
        static CELL: Mutex<Option<StagedBin>> = Mutex::new(None);
        static LOADS: AtomicU64 = AtomicU64::new(0);

        let tmp = stage_tmp("retry");
        let bundle = tmp.join("resources");
        let bin = tmp.join("bin");
        let names = ["mcp-control-server.js"];
        let load = |rels: &[&str]| {
            LOADS.fetch_add(1, Ordering::Relaxed);
            stage_all(&bundle, &bin, "aaaaaaa", rels)
        };

        // The swap window: `resources/` does not exist, so nothing stages.
        let first = staged_or_init(&CELL, &|| true, &names, &load);
        assert!(first.entries["mcp-control-server.js"].is_err(), "nothing could stage");

        // The swap finishes and the bundle is ours again — the next consumer must RECOVER.
        put_resource(&bundle, "mcp-control-server.js", "VERSION ONE");
        let second = staged_or_init(&CELL, &|| true, &names, &load);
        let p = second.entries["mcp-control-server.js"]
            .as_ref()
            .expect("an all-failed load must be retried, not returned forever");
        assert_eq!(std::fs::read_to_string(p).unwrap(), "VERSION ONE");
        assert_eq!(LOADS.load(Ordering::Relaxed), 2, "exactly one retry");

        // ...and now that something DID stage, it is sealed again: a later bundle swap can never
        // reach this process's staged copy.
        put_resource(&bundle, "mcp-control-server.js", "VERSION TWO");
        let third = staged_or_init(&CELL, &|| true, &names, &load);
        assert_eq!(LOADS.load(Ordering::Relaxed), 2, "a successful load is never re-run");
        assert_eq!(
            std::fs::read_to_string(third.entries["mcp-control-server.js"].as_ref().unwrap())
                .unwrap(),
            "VERSION ONE"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// roborev 67430. A PARTIAL load must be retried too, and this is the case the sibling test
    /// above structurally cannot see: it stages a single resource, so "nothing landed" and "not
    /// everything landed" are the same state there.
    ///
    /// `stage_all` copies the six resources SEQUENTIALLY, so the updater's swap window opening or
    /// closing mid-loop leaves a MIXED result — as does a per-file transient (ENOSPC, an EINTR'd
    /// copy, a briefly-locked app-data dir) on one resource while the others land. Under the old
    /// `any(is_ok)` test that mixed state was sealed with `retry_allowed` never consulted, so the
    /// missing resource could never recover even once the bundle was perfectly readable — the same
    /// session-long brick, in its more likely form.
    #[test]
    fn a_stage_in_which_only_some_resources_landed_is_retried_rather_than_sealed() {
        static CELL: Mutex<Option<StagedBin>> = Mutex::new(None);
        static LOADS: AtomicU64 = AtomicU64::new(0);

        let tmp = stage_tmp("partial");
        let bundle = tmp.join("resources");
        let bin = tmp.join("bin");
        let names = ["mcp-control-server.js", "mcp-orchestrator-server.js"];
        let load = |rels: &[&str]| {
            LOADS.fetch_add(1, Ordering::Relaxed);
            stage_all(&bundle, &bin, "aaaaaaa", rels)
        };

        // ONE of the two is present — the mixed state the old predicate sealed.
        put_resource(&bundle, "mcp-control-server.js", "CONTROL");
        let first = staged_or_init(&CELL, &|| true, &names, &load);
        assert!(first.entries["mcp-control-server.js"].is_ok(), "one landed");
        assert!(first.entries["mcp-orchestrator-server.js"].is_err(), "the other did not");

        // THE SWAP LANDS BEFORE THE RETRY. `resources/` now holds version N+1's bytes, and the
        // missing resource has appeared. This is the ordering that makes the retry dangerous, and
        // it is why the retry must be PER ENTRY (roborev 67444): a whole-load retry re-copies the
        // entry that already succeeded, publishing N+1's control server into N's segment — mode B,
        // the silent version skew the module exists to prevent. `retry_allowed` cannot save us here;
        // it fails open off macOS and whenever the `ps` fork fails.
        put_resource(&bundle, "mcp-control-server.js", "VERSION TWO");
        put_resource(&bundle, "mcp-orchestrator-server.js", "ORCHESTRATOR");
        let second = staged_or_init(&CELL, &|| true, &names, &load);

        // The entry that FAILED recovers...
        let p = second.entries["mcp-orchestrator-server.js"]
            .as_ref()
            .expect("a partial load must be retried, not sealed for the process lifetime");
        assert_eq!(std::fs::read_to_string(p).unwrap(), "ORCHESTRATOR");
        assert_eq!(LOADS.load(Ordering::Relaxed), 2, "exactly one retry");

        // ...and the entry that SUCCEEDED keeps the copy it took while the bundle was provably ours.
        assert_eq!(
            std::fs::read_to_string(second.entries["mcp-control-server.js"].as_ref().unwrap())
                .unwrap(),
            "CONTROL",
            "a retry must never re-copy an entry that already staged — that is mode B"
        );

        // Now that EVERY entry is Ok the memo seals and nothing reloads at all.
        let third = staged_or_init(&CELL, &|| true, &names, &load);
        assert_eq!(LOADS.load(Ordering::Relaxed), 2, "a fully-successful load is never re-run");
        assert_eq!(
            std::fs::read_to_string(third.entries["mcp-control-server.js"].as_ref().unwrap())
                .unwrap(),
            "CONTROL"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_retry_is_refused_once_this_processs_bundle_has_been_replaced() {
        // The gate that keeps the retry from reopening mode B: re-reading `resources/` AFTER the
        // swap landed would copy version N+1's file into version N's segment. The stale Err is the
        // correct answer there — loud (mode A) beats silent version skew (mode B).
        static CELL: Mutex<Option<StagedBin>> = Mutex::new(None);
        static LOADS: AtomicU64 = AtomicU64::new(0);

        let tmp = stage_tmp("retry-gated");
        let bundle = tmp.join("resources");
        let bin = tmp.join("bin");
        let names = ["mcp-control-server.js"];
        let load = |rels: &[&str]| {
            LOADS.fetch_add(1, Ordering::Relaxed);
            stage_all(&bundle, &bin, "aaaaaaa", rels)
        };

        let first = staged_or_init(&CELL, &|| false, &names, &load);
        assert!(first.entries["mcp-control-server.js"].is_err());

        // The NEW build's bundle is now on disk at the same path.
        put_resource(&bundle, "mcp-control-server.js", "VERSION TWO");
        let second = staged_or_init(&CELL, &|| false, &names, &load);
        assert_eq!(LOADS.load(Ordering::Relaxed), 1, "the gate refused the retry");
        assert!(
            second.entries["mcp-control-server.js"].is_err(),
            "version N+1's bytes must never be staged under version N's segment"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── the startup sweep ─────────────────────────────────────────────────────────────────────

    /// An aged staged dir named `seg`, optionally claimed by `pid`.
    fn aged_bin(bin: &Path, seg: &str, claim: Option<u32>) -> PathBuf {
        let d = bin.join(seg);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("mcp-control-server.js"), "x").unwrap();
        if let Some(pid) = claim {
            std::fs::write(d.join(format!(".alive-{pid}")), "").unwrap();
        }
        d
    }

    /// Age gate DISABLED (nothing is ever "too young"), so the guard under test is the only thing
    /// that can save a directory. The freshly-created dirs below are seconds old, so leaving the
    /// real gate on would keep everything and the test would pass without exercising anything.
    const NO_AGE_GATE_MS: u64 = 0;
    /// The production gate, for the cases that assert a young directory is SPARED.
    const MAX_AGE_MS: u64 = 14 * 24 * 60 * 60 * 1000;

    #[test]
    fn the_sweep_never_removes_the_running_builds_directory() {
        let tmp = stage_tmp("sweep-self");
        let bin = tmp.join("bin");
        let mine = aged_bin(&bin, "running", None);
        let theirs = aged_bin(&bin, "abandoned", None);

        let removed = sweep_stale_bins(&bin, "running", now_ms(), NO_AGE_GATE_MS, &|_| false);
        assert!(mine.exists(), "the running build's own staged dir must never be reclaimed");
        assert!(!theirs.exists(), "a dead build's dir IS reclaimed");
        assert_eq!(removed, vec!["abandoned".to_string()]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_sweep_never_removes_a_directory_a_live_process_claims() {
        let tmp = stage_tmp("sweep-live");
        let bin = tmp.join("bin");
        let live = aged_bin(&bin, "older-build-still-running", Some(4242));
        let dead = aged_bin(&bin, "older-build-long-gone", Some(4243));

        let removed =
            sweep_stale_bins(&bin, "running", now_ms(), NO_AGE_GATE_MS, &|p| p == 4242);
        assert!(
            live.exists(),
            "pulling a staged file out from under a running sibling would break every agent it spawns"
        );
        assert!(!dead.exists());
        assert_eq!(removed, vec!["older-build-long-gone".to_string()]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_sweep_spares_young_dirs_and_the_legacy_flat_scripts() {
        let tmp = stage_tmp("sweep-keep");
        let bin = tmp.join("bin");
        let young = aged_bin(&bin, "just-staged", None);
        // Pre-SHA staged scripts live as plain FILES directly under bin/, and older worktrees still
        // have their absolute paths baked into settings.local.json until heal re-points them.
        let legacy = bin.join("sparkle-hook.mjs");
        std::fs::write(&legacy, "legacy").unwrap();

        // now == the dirs' own mtime, so nothing is older than the max age.
        let removed = sweep_stale_bins(&bin, "running", now_ms(), MAX_AGE_MS, &|_| false);
        assert!(young.exists(), "a young dir is kept even with no live claim");
        assert!(legacy.exists(), "legacy flat scripts are files, never swept");
        assert!(removed.is_empty(), "nothing to reclaim: {removed:?}");

        // ...and it was the AGE that saved it, not some other accident: wind the clock past the
        // gate and the same directory IS reclaimed, while the legacy FILE still is not.
        let later = now_ms() + MAX_AGE_MS + 1;
        let removed = sweep_stale_bins(&bin, "running", later, MAX_AGE_MS, &|_| false);
        assert!(!young.exists(), "past the age gate it is reclaimed");
        assert!(legacy.exists(), "a file directly under bin/ is never swept, at any age");
        assert_eq!(removed, vec!["just-staged".to_string()]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn pid_liveness_answers_for_real_processes() {
        // The production predicate the sweep is wired to — not an injected stub.
        assert!(pid_is_alive(std::process::id()), "this very process is alive");
        assert!(!pid_is_alive(i32::MAX as u32), "an impossible pid is not alive");
        // Both mean something else to `kill`, so both must bias towards KEEPING the directory.
        assert!(pid_is_alive(0));
        assert!(pid_is_alive(u32::MAX));
    }

    #[cfg(not(unix))]
    #[test]
    fn without_a_pid_check_guard_two_never_fires_so_the_age_gate_is_the_sole_guard() {
        // This used to answer `true`, and because `dir_has_live_claim` runs BEFORE the age gate and
        // `stage_all` always writes a marker, that kept EVERY directory forever — `<app_data>/bin/`
        // growing one directory per build installed, with the age gate never consulted. Assert the
        // SIDE EFFECT, never the predicate: a claimed, aged directory really is reclaimed. The
        // sweep runs with the PRODUCTION `pid_is_alive`, and the marker names a pid that IS live —
        // so nothing but guard 3 can save this directory, and answering `true` here brings the
        // unbounded growth straight back.
        let tmp = stage_tmp("sweep-nonunix");
        let bin = tmp.join("bin");
        let claimed = aged_bin(&bin, "older-build", Some(std::process::id()));
        let removed =
            sweep_stale_bins(&bin, "running", now_ms() + MAX_AGE_MS + 1, MAX_AGE_MS, &pid_is_alive);
        assert!(
            !claimed.exists(),
            "guard 2 must not fire without a pid check — the age gate is the sole guard here"
        );
        assert_eq!(removed, vec!["older-build".to_string()]);

        // ...and a YOUNG directory is still spared, so the age gate is doing the deciding rather
        // than the sweep having simply become unconditional.
        let young = aged_bin(&bin, "younger-build", Some(std::process::id()));
        let removed = sweep_stale_bins(&bin, "running", now_ms(), MAX_AGE_MS, &pid_is_alive);
        assert!(young.exists(), "the age gate still spares a young dir");
        assert!(removed.is_empty(), "nothing to reclaim: {removed:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stage_all_claims_its_directory_with_a_live_marker_naming_this_process() {
        // Sweep guard 2 — the guard that stops the sweep pulling a staged file out from under a
        // running sibling — depends ENTIRELY on this write, and nothing asserted it: delete the
        // marker block and every other staging/sweep test stayed green while production lost the
        // guard. Assert the file, and then assert what it BUYS, end to end.
        let tmp = stage_tmp("alive-marker");
        let bundle = tmp.join("resources");
        let bin = tmp.join("bin");
        put_resource(&bundle, "mcp-control-server.js", "VERSION ONE");

        let staged = stage_all(&bundle, &bin, "this-build", &["mcp-control-server.js"]);
        let marker = staged.dir.join(format!(".alive-{}", std::process::id()));
        assert!(marker.exists(), "stage_all must claim its dir: {}", marker.display());

        // END TO END, against a directory `stage_all` really produced (NOT the `aged_bin` helper
        // that hand-writes its own marker): the sweep runs with the age gate DISABLED and a
        // different running segment, so guard 2 is the only thing that can save it.
        let removed = sweep_stale_bins(
            &bin,
            "some-other-segment",
            now_ms(),
            NO_AGE_GATE_MS,
            &|p| p == std::process::id(),
        );
        assert!(
            staged.dir.exists(),
            "a sibling process still running must keep its staged copies"
        );
        assert!(removed.is_empty(), "nothing to reclaim: {removed:?}");

        // ...and it was the LIVE CLAIM that saved it, not some other accident: the same directory,
        // same age gate, with that pid reported dead, IS reclaimed.
        let removed = sweep_stale_bins(&bin, "some-other-segment", now_ms(), NO_AGE_GATE_MS, &|_| false);
        assert!(!staged.dir.exists(), "once the claimant is gone the dir is reclaimed");
        assert_eq!(removed, vec!["this-build".to_string()]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── production wiring ─────────────────────────────────────────────────────────────────────

    #[test]
    fn the_real_command_seam_is_memoized_and_keyed_by_the_real_build_segment() {
        // Drives the SHIPPING entry point — `stage_resource_script` on a real AppHandle — so the
        // lines that supply the real values (the bundle resolve, `dev_identity::app_data_dir`, the
        // compile-time SPARKLE_GIT_SHA, the process-wide OnceLock) are covered by something. Under
        // `cargo test` the bundle's resources are not present, so the outcome is an Err; what is
        // asserted is the wiring, which holds either way.
        let app = tauri::test::mock_app();
        let first = stage_resource_script(app.handle(), "mcp-control-server.js");
        let second = stage_resource_script(app.handle(), "mcp-control-server.js");
        assert_eq!(first, second, "the same process must always get the same answer");

        let seg = current_build_segment();
        assert!(!seg.is_empty() && !seg.contains('/'), "segment is one path component: {seg:?}");
        match &first {
            Ok(p) => {
                let s = p.to_string_lossy().to_string();
                assert!(s.contains(&format!("bin/{seg}/")), "staged under bin/<segment>: {s}");
                assert!(s.ends_with("mcp-control-server.js"));
            }
            Err(e) => assert!(e.contains("mcp-control-server.js"), "error names the resource: {e}"),
        }

        // A resource nobody staged at startup is REFUSED, never resolved out of the bundle on the
        // fly — an on-demand resolve is exactly the post-swap read this change removes.
        let err = stage_resource_script(app.handle(), "not-a-bundled-resource.js")
            .expect_err("an unlisted resource has no staged copy");
        assert!(err.contains("STAGED_RESOURCES"), "says how to fix it: {err}");
    }

    #[test]
    fn every_resource_the_app_launches_is_staged_at_startup() {
        // The eager list IS the contract: anything missing here would fall back to no staged copy
        // at all. These four are the ones whose absolute paths cross into a spawned process or a
        // baked hook command.
        for rel in [
            "sparkle-hook.mjs",
            "worktree-guard.mjs",
            "mcp-orchestrator-server.js",
            "mcp-control-server.js",
            "roborev/post-commit",
            "roborev/post-rewrite",
        ] {
            assert!(STAGED_RESOURCES.contains(&rel), "{rel} must be staged eagerly");
        }
    }

    fn emitter_present(v: &Value, event: &str) -> bool {
        v["hooks"][event]
            .as_array()
            .map(|a| a.iter().any(|e| entry_has_marker(e, EMITTER_MARKER)))
            .unwrap_or(false)
    }

    #[test]
    fn emitter_merge_preserves_the_guard_permissions_allowlist() {
        // The launch sequence writes the guard first (which seeds permissions.allow) then merges
        // the event emitter into the SAME settings.local.json. The emitter merge must not drop the
        // allowlist — otherwise interactive agents would start prompting for Sparkle's own tools.
        let after_guard =
            crate::worktree::merge_guard_settings(None, "node /abs/worktree-guard.mjs /wt/a");
        let after_emitter = merge_event_hooks(Some(&after_guard), "node /abs/sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&after_emitter).unwrap();
        let rules: Vec<&str> = v["permissions"]["allow"]
            .as_array()
            .expect("allowlist survives the emitter merge")
            .iter()
            .filter_map(|e| e.as_str())
            .collect();
        assert!(rules.contains(&"mcp__sparkle-control"), "sparkle-control still allowed");
        assert!(rules.contains(&"mcp__sparkle-orchestrator"), "sparkle-orchestrator still allowed");
        // And the emitter itself landed, so both writers coexist.
        assert!(emitter_present(&v, "PreToolUse"));
    }

    // ── plugin pre-enable (sparkle-s3g2.1) ────────────────────────────────────────────────────

    use crate::config::{KnownPlugin, MarketplaceSource, PluginsConfig, OFFICIAL_MARKETPLACE};

    /// A third-party row, so the `extraKnownMarketplaces` path is exercised even while both SHIPPED
    /// plugins come from the pre-registered official marketplace. Mirrors the shape the next plugin
    /// in this series (episodic-memory) will have.
    const THIRD_PARTY: KnownPlugin = KnownPlugin {
        toggle: "episodic_memory",
        plugin: "episodic-memory",
        marketplace: "superpowers-marketplace",
        source: Some(MarketplaceSource {
            name: "superpowers-marketplace",
            repo: "obra/superpowers-marketplace",
        }),
        default_on: true,
    };

    /// EVERY catalog row forced on — not the shipped default set. Named for what it does, because
    /// the previous name (`defaults_on`) was true only while every row happened to default on, and
    /// it silently stopped being true the moment a row shipped OFF.
    fn all_on() -> Vec<&'static KnownPlugin> {
        PluginsConfig::with_all(true).enabled()
    }

    /// What a real install actually enables — the input that decides what lands in every worktree's
    /// settings.local.json.
    fn shipped_defaults() -> Vec<&'static KnownPlugin> {
        crate::config::SparkleConfig::default().plugins.enabled()
    }

    /// Exactly two rows, both from the official marketplace.
    ///
    /// Used by the tests that exercise the ledger / observation / install-pass MECHANISM rather
    /// than the catalog itself: "given N enabled plugins, which ones get retried" is the same
    /// property whether the table holds two rows or twenty, and pinning those tests to the live
    /// catalog meant every new marketplace row broke a handful of unrelated assertions.
    fn sample_pair() -> Vec<&'static KnownPlugin> {
        crate::config::KNOWN_PLUGINS
            .iter()
            .filter(|p| p.marketplace == OFFICIAL_MARKETPLACE)
            .take(2)
            .collect()
    }

    #[test]
    fn enables_every_enabled_plugin_with_the_exact_claude_code_key_shape() {
        let out = merge_plugin_settings(None, &all_on());
        let v: Value = serde_json::from_str(&out).unwrap();
        // enabledPlugins is an OBJECT keyed by "<plugin>@<marketplace>" → true. Asserting the
        // literal keys (not just "contains superpowers") is the point: a wrong shape or a wrong
        // marketplace half produces a settings file Claude Code silently ignores.
        assert_eq!(v["enabledPlugins"]["superpowers@claude-plugins-official"], json!(true));
        assert_eq!(v["enabledPlugins"]["frontend-design@claude-plugins-official"], json!(true));
        assert_eq!(v["enabledPlugins"]["sparkle-guardrails@sparkle"], json!(true));
        // Every row handed in must be written, whatever the table grows to.
        for p in all_on() {
            assert_eq!(v["enabledPlugins"][p.id()], json!(true), "{} not enabled", p.id());
        }
        // Claude Code owns the official marketplace and pre-registers it, so we must NOT re-declare
        // it. Sparkle's own marketplace it has never heard of, so that one MUST be declared or the
        // per-worktree settings name a marketplace the agent cannot resolve.
        let mk = v.get("extraKnownMarketplaces").expect("Sparkle's marketplace must be declared");
        assert_eq!(
            mk["sparkle"]["source"],
            json!({ "source": "github", "repo": "try-sparkle/marketplace" })
        );
        assert!(
            mk.get(crate::config::OFFICIAL_MARKETPLACE).is_none(),
            "never re-declare Claude Code's own marketplace"
        );
    }

    /// The shipped default set is the input every real worktree gets, and until now NO hooks test
    /// exercised it — they all forced every toggle on, which would have stayed green even if a
    /// plugin meant to ship OFF started being written into every agent's settings.
    #[test]
    fn the_shipped_default_set_writes_exactly_the_intended_plugins() {
        let defaults = shipped_defaults();
        let out = merge_plugin_settings(None, &defaults);
        let v: Value = serde_json::from_str(&out).unwrap();
        let enabled = v["enabledPlugins"].as_object().expect("enabledPlugins must be an object");

        let got: std::collections::BTreeSet<&str> = enabled.keys().map(String::as_str).collect();
        let want: std::collections::BTreeSet<String> =
            defaults.iter().map(|p| p.id()).collect();
        assert_eq!(
            got,
            want.iter().map(String::as_str).collect::<std::collections::BTreeSet<_>>(),
            "the settings file must name exactly the shipped default set"
        );

        // The specific hazard this pins: [tools].guardrails already appends the same prose to every
        // agent's system prompt, so shipping the PLUGIN on too would deliver it twice.
        assert!(
            !got.contains("sparkle-guardrails@sparkle"),
            "the guardrails plugin must not ship on — [tools].guardrails already injects it"
        );
        assert!(
            !got.contains("sparkle-mutation-check@sparkle"),
            "mutation-check is a deliberate act, not a default"
        );
        assert!(got.contains("superpowers@claude-plugins-official"));
        assert!(got.contains("sparkle-freshness@sparkle"));

        // The four newer Sparkle rows are absent from the default set, by their exact Claude Code
        // keys. Named literally, not derived from the table, because this test is the deliberate
        // record of WHICH plugins land in every worktree — deriving both sides would make it agree
        // with any table at all.
        //
        // They are OFF because `try-sparkle/marketplace` does not carry the content yet, so an
        // enabled row would put an unresolvable key into every worktree's settings and make the
        // install pass retry a failing `claude plugin install` on every launch. This assertion is
        // the tripwire for the eventual flip: when the content publishes, these move to the
        // `got.contains(..)` block above in the same commit that flips `default_on`.
        for id in [
            "sparkle-conflict-watch@sparkle",
            "sparkle-secrets@sparkle",
            "sparkle-review-probes@sparkle",
            "sparkle-pusher@sparkle",
        ] {
            assert!(
                !got.contains(id),
                "{id} must NOT ship on until it exists in try-sparkle/marketplace"
            );
        }
    }

    #[test]
    fn declares_a_third_party_marketplace_in_the_documented_nested_shape() {
        let out = merge_plugin_settings(None, &[&THIRD_PARTY]);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["extraKnownMarketplaces"]["superpowers-marketplace"],
            json!({ "source": { "source": "github", "repo": "obra/superpowers-marketplace" } })
        );
        assert_eq!(v["enabledPlugins"]["episodic-memory@superpowers-marketplace"], json!(true));
    }

    #[test]
    fn does_not_clobber_a_user_marketplace_or_their_plugin_choices() {
        // THE never-clobber case. The user points the same marketplace name at their own fork, has
        // an unrelated marketplace + plugin of their own, and has explicitly DISABLED one of our
        // defaults (which is exactly what `/plugin disable` writes).
        let existing = r#"{
            "model": "opus",
            "extraKnownMarketplaces": {
              "superpowers-marketplace": { "source": { "source": "github", "repo": "myfork/superpowers-marketplace" } },
              "acme": { "source": { "source": "github", "repo": "acme/plugins" } }
            },
            "enabledPlugins": {
              "acme-linter@acme": true,
              "frontend-design@claude-plugins-official": false
            }
        }"#;
        let mut plugins = all_on();
        plugins.push(&THIRD_PARTY);
        let out = merge_plugin_settings(Some(existing), &plugins);
        let v: Value = serde_json::from_str(&out).unwrap();

        // Their fork still wins for a marketplace name we also know — re-pointing it would silently
        // swap the source of every plugin they install from it.
        assert_eq!(
            v["extraKnownMarketplaces"]["superpowers-marketplace"]["source"]["repo"],
            json!("myfork/superpowers-marketplace")
        );
        // Their unrelated marketplace + plugin survive.
        assert_eq!(v["extraKnownMarketplaces"]["acme"]["source"]["repo"], json!("acme/plugins"));
        assert_eq!(v["enabledPlugins"]["acme-linter@acme"], json!(true));
        // An explicit `false` is a deliberate disable and MUST stay false. Overwriting it would
        // re-enable the plugin on every prepare, since AgentPane reinstalls hooks each time.
        assert_eq!(
            v["enabledPlugins"]["frontend-design@claude-plugins-official"],
            json!(false),
            "a user/agent disable must survive reinstall"
        );
        // What was genuinely absent is added.
        assert_eq!(v["enabledPlugins"]["superpowers@claude-plugins-official"], json!(true));
        assert_eq!(v["enabledPlugins"]["episodic-memory@superpowers-marketplace"], json!(true));
        // Unrelated user keys are untouched.
        assert_eq!(v["model"], json!("opus"));
    }

    #[test]
    fn all_toggles_off_writes_nothing_and_never_removes_an_entry() {
        let none: Vec<&KnownPlugin> = PluginsConfig::with_all(false).enabled();
        assert!(none.is_empty());

        // A settings file with no plugin keys stays that way — we don't seed empty objects into
        // every agent's settings.
        let out = merge_plugin_settings(Some(r#"{"model":"opus"}"#), &none);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("enabledPlugins").is_none());
        assert!(v.get("extraKnownMarketplaces").is_none());
        assert_eq!(v["model"], json!("opus"));

        // And a plugin the USER enabled is not removed just because Sparkle's toggle is off —
        // "off" means Sparkle stops enabling it, not that it disables the user's choice.
        let user = r#"{"enabledPlugins":{"superpowers@claude-plugins-official":true}}"#;
        let out = merge_plugin_settings(Some(user), &none);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["enabledPlugins"]["superpowers@claude-plugins-official"], json!(true));
    }

    #[test]
    fn plugin_merge_is_idempotent_and_composes_with_the_hook_merges() {
        // The real install order: guard → emitter → plugins, all read-modify-write on one file.
        // Every writer's output must survive the others, and a reinstall must not duplicate or drift.
        let after_guard = crate::worktree::merge_guard_settings(None, "node /abs/worktree-guard.mjs /wt/a");
        let after_emitter = merge_event_hooks(Some(&after_guard), "node /abs/sparkle-hook.mjs /log");
        let once = merge_plugin_settings(Some(&after_emitter), &all_on());
        let twice = merge_plugin_settings(Some(&once), &all_on());
        assert_eq!(once, twice, "reinstall must be a byte-for-byte no-op");

        let v: Value = serde_json::from_str(&twice).unwrap();
        assert_eq!(v["enabledPlugins"]["superpowers@claude-plugins-official"], json!(true));
        assert!(emitter_present(&v, "PreToolUse"), "the emitter survives the plugin merge");
        assert!(
            v["permissions"]["allow"].as_array().is_some_and(|a| a.iter().any(|r| r == "mcp__sparkle-control")),
            "the guard's allowlist survives the plugin merge"
        );
        // ...and running the emitter merge AGAIN (the AgentPane repair path) keeps the plugin keys.
        let repaired = merge_event_hooks(Some(&twice), "node /abs/sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&repaired).unwrap();
        assert_eq!(v["enabledPlugins"]["frontend-design@claude-plugins-official"], json!(true));
    }

    #[test]
    fn plugin_merge_tolerates_a_garbage_root() {
        // A root that isn't a settings object at all has nothing to preserve (Claude Code would
        // reject it too), so it resets — same robustness contract as merge_event_hooks.
        for input in ["[1,2,3]", "not json at all", "null"] {
            let out = merge_plugin_settings(Some(input), &[&THIRD_PARTY]);
            let v: Value = serde_json::from_str(&out).expect("always emits valid JSON");
            assert_eq!(v["enabledPlugins"]["episodic-memory@superpowers-marketplace"], json!(true));
            assert_eq!(
                v["extraKnownMarketplaces"]["superpowers-marketplace"]["source"]["source"],
                json!("github")
            );
        }
    }

    #[test]
    fn a_plugin_key_of_an_unrecognized_shape_is_left_alone_not_clobbered() {
        // These keys are USER-owned. A legacy array encoding, a hand-edit, or a shape a newer
        // Claude Code introduced is data we don't understand — not garbage to overwrite. Replacing
        // it with `{}` would destroy it silently on EVERY agent prepare (AgentPane reinstalls hooks
        // each time), which is exactly the kind of loss the whole merge-never-clobber contract
        // exists to prevent. Skipping instead costs one un-enabled plugin in one worktree.
        let legacy = r#"{
            "model": "opus",
            "enabledPlugins": ["superpowers@claude-plugins-official"],
            "extraKnownMarketplaces": ["obra/superpowers-marketplace"]
        }"#;
        let out = merge_plugin_settings(Some(legacy), &[&THIRD_PARTY]);
        let v: Value = serde_json::from_str(&out).expect("always emits valid JSON");
        assert_eq!(
            v["enabledPlugins"],
            json!(["superpowers@claude-plugins-official"]),
            "an array-shaped enabledPlugins must survive verbatim"
        );
        assert_eq!(
            v["extraKnownMarketplaces"],
            json!(["obra/superpowers-marketplace"]),
            "an array-shaped extraKnownMarketplaces must survive verbatim"
        );
        assert_eq!(v["model"], json!("opus"), "and the rest of the file is untouched");

        // Scalars too, and independently: a broken `enabledPlugins` must not stop us writing a
        // perfectly good `extraKnownMarketplaces`.
        let out = merge_plugin_settings(Some(r#"{"enabledPlugins":"nope"}"#), &[&THIRD_PARTY]);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["enabledPlugins"], json!("nope"));
        assert_eq!(
            v["extraKnownMarketplaces"]["superpowers-marketplace"]["source"]["repo"],
            json!("obra/superpowers-marketplace")
        );
    }

    #[test]
    fn install_skips_what_the_ledger_already_records() {
        let enabled = sample_pair();
        // Cold: everything needs installing, in table order.
        let todo = plugins_needing_install(&enabled, &[]);
        assert_eq!(
            todo.iter().map(|p| p.id()).collect::<Vec<_>>(),
            enabled.iter().map(|p| p.id()).collect::<Vec<_>>(),
            "cold start installs every enabled plugin, in table order"
        );
        // Pin a literal id too, so a wrong `<plugin>@<marketplace>` half still fails loudly even
        // though the list above is derived.
        assert!(todo.iter().any(|p| p.id() == "superpowers@claude-plugins-official"));

        // Partly warm: only the missing one is retried, so a launch doesn't re-hit the network.
        let todo = plugins_needing_install(&enabled, &["superpowers@claude-plugins-official".into()]);
        assert_eq!(todo.len(), 1);
        assert_eq!(todo[0].id(), "frontend-design@claude-plugins-official");

        // Fully warm: nothing to do.
        let all: Vec<String> = enabled.iter().map(|p| p.id()).collect();
        assert!(plugins_needing_install(&enabled, &all).is_empty());

        // A stale ledger entry for a plugin that is no longer enabled is simply ignored (we never
        // uninstall — turning a toggle off stops Sparkle enabling it, nothing more).
        let none: Vec<&KnownPlugin> = PluginsConfig::with_all(false).enabled();
        assert!(plugins_needing_install(&none, &all).is_empty());
    }

    #[test]
    fn the_frontend_learn_more_url_matches_the_repo_we_install_from() {
        // The Tools pane's "Learn more" link for a plugin row must point at the SAME repo the
        // installer runs `claude plugin marketplace add` against. It didn't: the row shipped
        // pointing at `anthropics/claude-plugins-public`, which 404s. Two languages, one fact —
        // so assert it across the boundary rather than hoping the next edit updates both.
        let pane = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/components/ToolsPane.tsx");
        let src = std::fs::read_to_string(&pane)
            .unwrap_or_else(|e| panic!("reading {}: {e}", pane.display()));
        // Asserts the repo STRING only — not a `const … = …` line — so a prettier reformat, a
        // rename of the TS constant, or a different quoting style can't fail this for a reason
        // unrelated to the invariant it exists to protect.
        let repo = crate::config::OFFICIAL_MARKETPLACE_REPO;
        assert!(
            src.contains(repo),
            "ToolsPane.tsx must reference {repo} (config::OFFICIAL_MARKETPLACE_REPO)"
        );
        // And no stale hardcoded LINK to the repo that doesn't exist. (Scoped to a URL so the
        // comment above the constant can still name it as the mistake it was.)
        assert!(
            !src.contains("https://github.com/anthropics/claude-plugins-public"),
            "ToolsPane.tsx still links to anthropics/claude-plugins-public, which 404s"
        );
    }

    #[test]
    fn a_repos_own_plugins_block_is_honored_and_a_bogus_root_falls_back_to_global() {
        // [plugins] is repo-scoped, so a project's .sparkle/config.toml decides which plugins its
        // agents get. That only works if install_agent_hooks resolves the PROJECT layer.
        let root = std::env::temp_dir().join(format!("sparkle-plugins-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".sparkle")).unwrap();
        // Generated from the table, not a hand-listed pair: this test means "the repo turned
        // EVERYTHING off", and a literal list would quietly stop meaning that on the next new row.
        let mut block = String::from("[plugins]\n");
        for kp in crate::config::KNOWN_PLUGINS {
            block.push_str(&format!("{} = false\n", kp.toggle));
        }
        std::fs::write(root.join(".sparkle/config.toml"), block).unwrap();
        let cfg = plugins_layer_for(Some(root.to_str().unwrap()));
        assert!(cfg.plugins.enabled().is_empty(), "the repo's own [plugins] block must win");

        // Junk roots fall back to the global layer instead of reaching `for_project` — which
        // memoizes by the string it's handed, so a relative/empty/deleted root would resolve
        // against nothing AND hold a permanent slot in that map. Compared against the GLOBAL layer
        // rather than a literal: `config::GLOBAL` is a process-wide cell that another test running
        // in parallel may have reloaded, so a hardcoded 2 would flake.
        let global = crate::config::current_effective().config.plugins.enabled().len();
        for bogus in ["", "relative/path", "/no/such/dir/anywhere-12345"] {
            let cfg = plugins_layer_for(Some(bogus));
            assert_eq!(
                cfg.plugins.enabled().len(),
                global,
                "bogus root {bogus:?} must fall back to the global layer"
            );
        }
        assert_eq!(plugins_layer_for(None).plugins.enabled().len(), global);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn observed_machine_state_overrides_the_ledger_so_an_uninstall_self_corrects() {
        // THE ledger bug: it is write-only truth. Once an id is recorded, `plugins_needing_install`
        // returns empty forever — so `/plugin uninstall superpowers`, or `rm -rf ~/.claude/plugins`,
        // leaves the plugin gone and Sparkle permanently convinced it's there.
        let enabled = sample_pair();
        let ledger: Vec<String> = enabled.iter().map(|p| p.id()).collect();

        // Nothing observable on the machine → the ledger's claims are dropped and both reinstall.
        let already = already_installed(ledger.clone(), Some(Vec::new()));
        assert_eq!(
            plugins_needing_install(&enabled, &already).len(),
            enabled.len(),
            "a wiped plugins dir must make the next pass reinstall, not skip"
        );

        // Only one still present → only the missing one is retried.
        let observed = vec!["superpowers@claude-plugins-official".to_string()];
        let already = already_installed(ledger.clone(), Some(observed));
        let todo = plugins_needing_install(&enabled, &already);
        assert_eq!(todo.len(), 1);
        assert_eq!(todo[0].id(), "frontend-design@claude-plugins-official");

        // A plugin the USER installed themselves counts as present even though our ledger is empty
        // — observation is the truth, so we don't refetch what's already on disk.
        let already = already_installed(Vec::new(), Some(ledger.clone()));
        assert!(plugins_needing_install(&enabled, &already).is_empty());

        // Unobservable machine (no HOME) → fall back to the recorded ledger rather than reinstalling
        // on every single launch.
        let already = already_installed(ledger.clone(), None);
        assert!(plugins_needing_install(&enabled, &already).is_empty());
    }

    #[test]
    fn observation_reads_both_claude_codes_record_and_the_on_disk_cache() {
        let home = std::env::temp_dir().join(format!("sparkle-observe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();

        // No ~/.claude/plugins at all is DEFINITIVE "nothing installed" (the wipe case), not
        // "couldn't look" — the difference decides whether we reinstall or skip forever.
        assert_eq!(observe_installed_plugins(None, &home), Some(Vec::new()));

        let plugins = claude_plugins_dir(None, &home);
        std::fs::create_dir_all(plugins.join("cache/claude-plugins-official/frontend-design")).unwrap();
        // Signal 1: Claude Code's own record (the exact `<plugin>@<marketplace>` keys we use).
        std::fs::write(
            plugins.join("installed_plugins.json"),
            r#"{"version":2,"plugins":{"superpowers@claude-plugins-official":[{"scope":"user"}]}}"#,
        )
        .unwrap();

        let mut ids = observe_installed_plugins(None, &home).expect("an existing plugins dir is observable");
        ids.sort();
        // Unioned: the record knows superpowers, the cache dir knows frontend-design. Either alone
        // would under-report, and under-reporting costs a redundant install — the safe direction.
        assert_eq!(
            ids,
            vec![
                "frontend-design@claude-plugins-official".to_string(),
                "superpowers@claude-plugins-official".to_string(),
            ]
        );

        // A corrupt record degrades to the cache scan rather than reporting nothing observable.
        std::fs::write(plugins.join("installed_plugins.json"), "not json").unwrap();
        assert_eq!(
            observe_installed_plugins(None, &home),
            Some(vec!["frontend-design@claude-plugins-official".to_string()])
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_manifest_parser_separates_could_not_look_from_nothing_installed() {
        // The distinction both callers are built on. `None` must never be reachable from a
        // well-formed record, and `Some(vec![])` must never be reachable from a broken one — the
        // Builder Index reporter publishes an empty array on `Some(vec![])`, which REPLACES the
        // profile's SKILLS row, so collapsing the two would wipe it on a parse failure.
        let parsed = |s: &str| serde_json::from_str::<Value>(s).ok().as_ref().and_then(installed_plugin_ids);

        assert_eq!(
            parsed(r#"{"version":2,"plugins":{"superpowers@claude-plugins-official":[{"scope":"user"}]}}"#),
            Some(vec!["superpowers@claude-plugins-official".to_string()])
        );
        // Parsed and records nothing: a real, trustworthy "nothing installed".
        assert_eq!(parsed(r#"{"version":2,"plugins":{}}"#), Some(Vec::new()));
        // Shapes we do not recognize are all "could not look".
        assert_eq!(parsed(r#"{"version":2}"#), None, "no plugins key");
        assert_eq!(parsed(r#"{"plugins":[]}"#), None, "plugins is an array, not an object");
        assert_eq!(parsed("not json"), None);
    }

    #[test]
    fn reading_a_missing_or_malformed_manifest_is_none_not_an_empty_list() {
        let dir = std::env::temp_dir().join(format!("sparkle-manifest-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = dir.join("installed_plugins.json");

        assert_eq!(read_installed_plugin_ids(&manifest), None, "absent file");

        std::fs::write(&manifest, "{ truncated").unwrap();
        assert_eq!(read_installed_plugin_ids(&manifest), None, "malformed file");

        std::fs::write(&manifest, r#"{"plugins":{"warp@claude-code-warp":[]}}"#).unwrap();
        assert_eq!(
            read_installed_plugin_ids(&manifest),
            Some(vec!["warp@claude-code-warp".to_string()])
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The multi-account bug: Sparkle sets `CLAUDE_CONFIG_DIR` per-spawn and `accounts.rs`/`claude.rs`
    /// both honor it, so the `claude plugin install` child writes into `<config>/plugins`. A presence
    /// check hardcoded to `~/.claude/plugins` reads an empty tree, calls that a definitive "nothing
    /// installed", prunes the ledger, and reinstalls on every single agent prepare.
    #[test]
    fn the_plugins_tree_follows_claude_config_dir_when_it_is_set() {
        let root = std::env::temp_dir().join(format!("sparkle-plugin-cfgdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let config = root.join("account-2");
        std::fs::create_dir_all(&home).unwrap();

        // Unset → the `$HOME/.claude` fallback, exactly as before.
        assert_eq!(claude_plugins_dir(None, &home), home.join(".claude").join("plugins"));
        // Empty is treated as UNSET, or an `export CLAUDE_CONFIG_DIR=` would yield a relative root.
        assert_eq!(
            claude_plugins_dir(Some(Path::new("")), &home),
            home.join(".claude").join("plugins")
        );
        assert_eq!(claude_plugins_dir(Some(&config), &home), config.join("plugins"));

        // Install lands in the CONFIGURED tree; `~/.claude` stays empty.
        std::fs::create_dir_all(config.join("plugins/cache/claude-plugins-official/superpowers"))
            .unwrap();
        std::fs::create_dir_all(home.join(".claude").join("plugins")).unwrap();
        std::fs::write(
            home.join(".claude").join("plugins").join("installed_plugins.json"),
            r#"{"version":2,"plugins":{}}"#,
        )
        .unwrap();

        assert_eq!(
            observe_installed_plugins(Some(&config), &home),
            Some(vec!["superpowers@claude-plugins-official".to_string()]),
            "the presence check must read the tree the install actually wrote to"
        );
        // And the old behavior, for contrast: the home tree really does look empty.
        assert_eq!(observe_installed_plugins(None, &home), Some(Vec::new()));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A clone staged mid-install must not be reported as a marketplace. Harmless for the ids (they
    /// can't collide with a known plugin id) but it is noise in a signal whose whole job is
    /// precision — and it DOES change one real answer, covered below.
    #[test]
    fn a_staging_clone_dir_is_not_mistaken_for_a_marketplace() {
        let home = std::env::temp_dir().join(format!("sparkle-plugin-temp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let plugins = claude_plugins_dir(None, &home);
        std::fs::create_dir_all(plugins.join("cache/temp_git_1771/superpowers")).unwrap();
        std::fs::create_dir_all(plugins.join("cache/claude-plugins-official/superpowers")).unwrap();

        assert_eq!(
            observe_installed_plugins(None, &home),
            Some(vec!["superpowers@claude-plugins-official".to_string()])
        );

        // THE SEMANTIC FLIP the filter causes, and the reason it isn't purely cosmetic: a plugins
        // dir holding ONLY a staging clone and no parsable record used to observe as
        // `Some([<bogus id>])` — a definitive answer that pruned the ledger. It is now `None`,
        // "can't tell", which falls back to the ledger. `None` is the safe direction: the worst case
        // is a redundant idempotent install, where the old behavior dropped real ledger entries.
        let _ = std::fs::remove_dir_all(&home);
        let plugins = claude_plugins_dir(None, &home);
        std::fs::create_dir_all(plugins.join("cache/temp_git_1771/superpowers")).unwrap();
        assert_eq!(observe_installed_plugins(None, &home), None);

        let _ = std::fs::remove_dir_all(&home);
    }

    /// `CLAUDE_CONFIG_DIR=""` must read as UNSET at the env boundary too, not just inside
    /// `claude_plugins_dir` — otherwise an `export CLAUDE_CONFIG_DIR=` yields a relative root.
    #[test]
    fn an_empty_config_dir_env_reads_as_unset() {
        // The pure filter this relies on, asserted directly rather than by mutating process-wide
        // state (which would race every other test in this binary).
        let filtered = |v: Option<&str>| {
            v.map(std::ffi::OsString::from)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
        };
        assert_eq!(filtered(Some("")), None);
        assert_eq!(filtered(None), None);
        assert_eq!(filtered(Some("/tmp/cfg")), Some(PathBuf::from("/tmp/cfg")));
        // And whatever this machine's env says, the resolved dir is always absolute — the property
        // the filter exists to guarantee.
        if let Some(dir) = claude_config_dir_env() {
            assert!(!dir.as_os_str().is_empty(), "empty must never survive as a config dir");
        }
    }

    /// Plugins are installed PER CONFIG TREE. Sparkle's multi-account support sets
    /// `CLAUDE_CONFIG_DIR` on the AGENT's shell command, never on the desktop process — so a pass
    /// that only ever looked at our own environment installed into `~/.claude` and left every
    /// account store empty, and those agents' enabled plugins silently never loaded.
    #[test]
    fn every_registered_account_gets_its_own_plugins_tree() {
        let app_data =
            std::env::temp_dir().join(format!("sparkle-plugin-trees-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&app_data);
        let home = app_data.join("home");
        std::fs::create_dir_all(&home).unwrap();

        // No accounts registered → just the default tree.
        assert_eq!(plugin_config_trees(&app_data, None, Some(&home)), vec![None]);

        // Two accounts: the imported "default" one, whose config_dir IS the home tree, and a real
        // second account. The first must NOT produce a duplicate pass.
        let home_claude = home.join(".claude");
        let account = app_data.join("accounts").join("ab12");
        let accounts = json!([
            { "id": "d", "nickname": "default", "configDir": home_claude.to_string_lossy(),
              "isDefault": true, "createdAt": 0 },
            { "id": "ab12", "nickname": "work", "configDir": account.to_string_lossy(),
              "isDefault": false, "createdAt": 0 },
            // An empty config_dir is skipped rather than yielding a relative `plugins/` root.
            { "id": "empty", "nickname": "broken", "configDir": "", "isDefault": false,
              "createdAt": 0 },
        ]);
        std::fs::write(
            crate::accounts::accounts_json_path(&app_data),
            serde_json::to_string(&accounts).unwrap(),
        )
        .unwrap();

        let trees = plugin_config_trees(&app_data, None, Some(&home));
        assert_eq!(
            trees,
            vec![None, Some(account)],
            "the default tree once, plus each account with a distinct plugins dir"
        );
        // The default tree stays FIRST — `ensure_plugins_installed` uses that position to decide
        // which tree the legacy flat ledger described.
        assert_eq!(trees[0], None);

        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// "We couldn't look" must not render as "it's fine". When `observe_installed_plugins` returns
    /// `None` — a plugins dir whose layout we don't recognize — the answer comes from the write-only
    /// ledger, which is exactly the claim-success-we-can't-see case the outcome list exists to kill.
    #[test]
    fn a_tree_we_cannot_observe_reports_unverified_not_already_present() {
        let dir = std::env::temp_dir().join(format!("sparkle-unverified-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();

        // A plugins dir that exists but tells us nothing we understand: no parsable record, and a
        // cache holding only a staging clone. `observe_installed_plugins` → None.
        let plugins = claude_plugins_dir(None, &home);
        std::fs::create_dir_all(plugins.join("cache/temp_git_1/x")).unwrap();
        std::fs::write(plugins.join("installed_plugins.json"), "not json").unwrap();
        assert_eq!(observe_installed_plugins(None, &home), None, "fixture must be unobservable");

        // The ledger claims both plugins are installed.
        std::fs::write(
            installed_ledger_path(&dir),
            r#"{"installed":["superpowers@claude-plugins-official","frontend-design@claude-plugins-official"]}"#,
        )
        .unwrap();

        let mut attempted = Vec::new();
        let mut calls = 0;
        let outcomes = run_install_pass(
            &dir,
            PluginTree { config_dir: None, home: Some(&home), is_default: true },
            &sample_pair(),
            &mut attempted,
            None,
            &mut |_| {
                calls += 1;
                Ok(())
            },
        );
        assert_eq!(calls, 0, "the ledger still suppresses the install — only the VERDICT changes");
        assert!(
            outcomes.iter().all(|o| o.status == PluginInstallStatus::Unverified),
            "an unobservable tree can't report AlreadyPresent: {outcomes:?}"
        );
        assert_eq!(outcomes[0].message.as_deref(), Some(UNVERIFIED_MESSAGE));

        // And "unverified" outranks a clean verdict from another tree, but not a real failure.
        let p = &crate::config::KNOWN_PLUGINS[0];
        let mut m = vec![PluginInstallOutcome::new(p, PluginInstallStatus::AlreadyPresent)];
        merge_outcomes(&mut m, vec![PluginInstallOutcome::unverified(p)]);
        assert_eq!(m[0].status, PluginInstallStatus::Unverified);
        merge_outcomes(&mut m, vec![PluginInstallOutcome::failed(p, INSTALL_FAILED_MESSAGE, None)]);
        assert_eq!(m[0].status, PluginInstallStatus::Failed);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The reduction across trees. A plugin missing from ANY tree an agent could use must not read
    /// as fine just because another tree has it.
    #[test]
    fn the_worst_outcome_across_trees_is_the_one_reported() {
        let p = &crate::config::KNOWN_PLUGINS[0];
        let present = || vec![PluginInstallOutcome::new(p, PluginInstallStatus::AlreadyPresent)];
        let installed = || vec![PluginInstallOutcome::new(p, PluginInstallStatus::Installed)];
        let failed = || vec![PluginInstallOutcome::failed(p, INSTALL_FAILED_MESSAGE, None)];

        let mut m = present();
        merge_outcomes(&mut m, failed());
        assert_eq!(m[0].status, PluginInstallStatus::Failed, "a failure anywhere wins");
        assert_eq!(m[0].message.as_deref(), Some(INSTALL_FAILED_MESSAGE));

        // …and it stays lost even if a later tree is fine.
        merge_outcomes(&mut m, present());
        assert_eq!(m[0].status, PluginInstallStatus::Failed);

        // Installed beats already-present so the log can say something actually happened.
        let mut m = present();
        merge_outcomes(&mut m, installed());
        assert_eq!(m[0].status, PluginInstallStatus::Installed);
        let mut m = installed();
        merge_outcomes(&mut m, present());
        assert_eq!(m[0].status, PluginInstallStatus::Installed);
    }

    /// The install child must be TOLD which tree to write to. Inheritance was the one implicit value
    /// left on this command, and a pass targeting an account store — never in our own env — had no
    /// way to express it at all.
    #[cfg(unix)]
    #[test]
    fn the_install_child_is_told_which_config_tree_to_write() {
        let cmd = claude_command("/bin/claude", Some(Path::new("/app/accounts/ab12")), &[]);
        let cfg = cmd
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("CLAUDE_CONFIG_DIR"))
            .and_then(|(_, v)| v)
            .expect("the target tree must be explicit, not inherited");
        assert_eq!(cfg, std::ffi::OsStr::new("/app/accounts/ab12"));

        // The DEFAULT tree passes None, so the child inherits exactly what we would have — setting
        // it to a resolved value here would change behavior on a machine with no var at all.
        let cmd = claude_command("/bin/claude", None, &[]);
        assert!(cmd
            .get_envs()
            .all(|(k, _)| k != std::ffi::OsStr::new("CLAUDE_CONFIG_DIR")));
    }

    /// The child PATH rules. A NON-ABSOLUTE component is the dangerous one: POSIX exec reads `""`
    /// (and `.`, and any relative entry) as "search the current directory", and [`claude_command`]
    /// runs the child from `$HOME` — so a stray `node` in the user's home directory would win over
    /// the real one.
    #[cfg(unix)]
    #[test]
    fn the_child_path_keeps_only_absolute_components_and_dedupes_by_membership() {
        let p = |s: &str| s.to_string();
        // The failure mode: `cached_login_shell_path()` returned "" (probe failed).
        assert_eq!(join_path_entries(&[p("/opt/node/bin")], "", &[]), "/opt/node/bin");
        // A trailing/embedded empty component never survives.
        assert_eq!(
            join_path_entries(&[p("/opt/node/bin")], "/usr/bin::/bin:", &[]),
            "/opt/node/bin:/usr/bin:/bin"
        );
        // …and neither does a RELATIVE one. `.`, `bin` and `./node_modules/.bin` all appear in real
        // dotfiles, and each is the same "resolve against $HOME" hazard as the empty entry.
        assert_eq!(
            join_path_entries(&[p("/opt/node/bin")], "/usr/bin:.:bin:./node_modules/.bin", &[]),
            "/opt/node/bin:/usr/bin"
        );
        // An empty PREFIX is dropped too — reachable when `resolve_node_path_cached` yields a bare
        // filename whose `parent()` is "".
        assert_eq!(join_path_entries(&[p("")], "/usr/bin", &[]), "/usr/bin");
        // Dedupe is by MEMBERSHIP, not "is it already first" — a prefix buried in the middle of the
        // existing PATH must not be re-added, or the variable grows on every call.
        assert_eq!(
            join_path_entries(&[p("/opt/node/bin")], "/usr/bin:/opt/node/bin:/bin", &[]),
            "/opt/node/bin:/usr/bin:/bin"
        );
        // ORDER IS PRECEDENCE: the node dir leads (the shebang needs it), `~/.local/bin` TRAILS.
        // Putting it first would shadow the user's version-manager shims for node/npm/git — a stale
        // `~/.local/bin/node` beating the nvm one the login shell deliberately selected.
        assert_eq!(
            join_path_entries(
                &[p("/opt/node/bin")],
                "/usr/bin:/bin",
                &[p("/Users/me/.local/bin")]
            ),
            "/opt/node/bin:/usr/bin:/bin:/Users/me/.local/bin"
        );
        // A suffix already on the PATH keeps its original position rather than moving to the end.
        assert_eq!(
            join_path_entries(&[], "/usr/bin:/Users/me/.local/bin", &[p("/Users/me/.local/bin")]),
            "/usr/bin:/Users/me/.local/bin"
        );
        // A repeated prefix is emitted once.
        assert_eq!(join_path_entries(&[p("/bin"), p("/bin")], "/bin", &[]), "/bin");
    }

    #[test]
    fn a_missing_or_corrupt_ledger_reads_as_nothing_installed() {
        let dir = std::env::temp_dir().join(format!("sparkle-plugin-ledger-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = installed_ledger_path(&dir);
        let default_root = Path::new("/home/.claude/plugins");
        let read = |root: &Path| read_installed_ledger(&p, root, root == default_root);

        // Absent → empty (so a fresh install actually installs).
        assert!(read(default_root).is_empty());

        // The LEGACY flat shape is still honored, and only for the default tree — it can't have
        // described anything else, and trusting it for an account store would skip an install for a
        // tree that has nothing.
        std::fs::write(&p, r#"{"installed":["superpowers@claude-plugins-official"]}"#).unwrap();
        assert_eq!(read(default_root), vec!["superpowers@claude-plugins-official".to_string()]);
        assert!(read(Path::new("/app/accounts/ab12/plugins")).is_empty());

        // The current per-root shape.
        std::fs::write(
            &p,
            r#"{"roots":{"/app/accounts/ab12/plugins":["frontend-design@claude-plugins-official"]}}"#,
        )
        .unwrap();
        assert_eq!(
            read(Path::new("/app/accounts/ab12/plugins")),
            vec!["frontend-design@claude-plugins-official".to_string()]
        );
        assert!(read(default_root).is_empty(), "one tree's entry must not answer for another");

        // Garbage and foreign shapes degrade to empty rather than erroring — the worst case is one
        // redundant idempotent install, never a silently SKIPPED one.
        for bad in ["not json", "[1,2,3]", r#"{"installed":"nope"}"#, "{}", r#"{"roots":5}"#] {
            std::fs::write(&p, bad).unwrap();
            assert!(read(default_root).is_empty(), "corrupt ledger {bad:?} must not skip installs");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Writing one tree's entry must not drop another's — the churn that made the flat ledger
    /// alternate between trees and lose whichever was written last.
    #[test]
    fn the_ledger_write_merges_per_root_and_carries_the_legacy_shape_forward() {
        let default_root = Path::new("/home/.claude/plugins");
        let account_root = Path::new("/app/accounts/ab12/plugins");

        // A legacy flat file is upgraded in place, attributed to the default tree, not discarded.
        let body = merged_ledger(
            Some(r#"{"installed":["superpowers@m"]}"#),
            default_root,
            true,
            &["superpowers@m".to_string()],
        );
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["roots"]["/home/.claude/plugins"], json!(["superpowers@m"]));

        // A write for the ACCOUNT tree adds its entry and leaves the default's alone.
        let body = merged_ledger(Some(&body), account_root, false, &["frontend-design@m".to_string()]);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["roots"]["/home/.claude/plugins"], json!(["superpowers@m"]));
        assert_eq!(v["roots"]["/app/accounts/ab12/plugins"], json!(["frontend-design@m"]));

        // A later write to one root leaves the other alone.
        let body = merged_ledger(Some(&body), default_root, true, &[]);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["roots"]["/home/.claude/plugins"], json!([]));
        assert_eq!(v["roots"]["/app/accounts/ab12/plugins"], json!(["frontend-design@m"]));

        // No prior file at all is fine.
        let body = merged_ledger(None, default_root, true, &["superpowers@m".to_string()]);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["roots"]["/home/.claude/plugins"], json!(["superpowers@m"]));
    }

    #[cfg(unix)]
    #[test]
    fn the_claude_child_gets_a_path_that_can_resolve_node() {
        // THE regression this guards: `claude` is a Node script with a `#!/usr/bin/env node`
        // shebang, and a Finder-launched macOS app has a bare GUI PATH with no nvm/asdf/volta shim
        // on it. Running it with the INHERITED environment dies with "env: node: No such file or
        // directory" for every version-manager user, and since install failures are only
        // warn-logged their plugins would silently never install. So assert the child's PATH is
        // explicitly set — an exit-status-only test passes just as happily with the broken form.
        let cmd =
            claude_command("/opt/homebrew/bin/claude", None, &["plugin".into(), "list".into()]);
        assert_eq!(cmd.get_program().to_string_lossy(), "/opt/homebrew/bin/claude");
        let args: Vec<String> =
            cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        // Real argv, no shell: nothing to re-tokenize, so a path or plugin id containing a
        // space/quote/`;`/`$(…)` is impossible to turn into a second command, and we don't assume
        // the user's `$SHELL` understands POSIX `"$@"` (fish and csh/tcsh don't).
        assert_eq!(args, vec!["plugin".to_string(), "list".to_string()]);

        let path = cmd
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, v)| v)
            .expect("PATH must be set explicitly, not inherited")
            .to_string_lossy()
            .into_owned();
        assert!(!path.is_empty());
        // When this machine can resolve node at all, its directory must be reachable from the
        // child's PATH — that is the whole point.
        if let Some(node) = crate::preflight::resolve_node_path_cached() {
            let dir = Path::new(&node).parent().unwrap().to_string_lossy().into_owned();
            assert!(
                path.split(':').any(|p| p == dir),
                "child PATH {path:?} must contain node's dir {dir:?}"
            );
        }
        // `~/.local/bin` is reachable too — that's where the official Claude Code installer puts
        // things and where user-local tooling lives, and `buildClaudeExec` prepends it for the same
        // reason. A login but non-interactive shell usually doesn't have it (the `export` sits in
        // `.zshrc`).
        if let Some(home) = home_dir() {
            let local_bin = home.join(".local").join("bin").to_string_lossy().into_owned();
            assert!(
                path.split(':').any(|p| p == local_bin),
                "child PATH {path:?} must contain {local_bin:?}"
            );
        }
        // No empty component: exec reads one as "search the CWD", and the CWD here is $HOME.
        assert!(
            path.split(':').all(|p| !p.is_empty()),
            "an empty PATH component makes exec search the CWD: {path:?}"
        );
        // And it runs from a stable directory: a Finder-launched bundle's CWD is `/`, and `claude`
        // resolves project-scoped config/trust from its working directory.
        assert_eq!(cmd.get_current_dir(), home_dir().as_deref());
    }

    /// Make the fake runner land a plugin the way a real `claude plugin install` does, so the pass
    /// sees it on the NEXT run. Without this the fixture home stays empty and every pass re-derives
    /// "nothing installed", which would quietly hide the already-present / suppressed distinction
    /// the outcome list is for.
    fn fake_install(home: &Path, args: &[String]) {
        if args.first().map(String::as_str) != Some("plugin")
            || args.get(1).map(String::as_str) != Some("install")
        {
            return;
        }
        let Some((plugin, marketplace)) = args.get(2).and_then(|id| id.split_once('@')) else {
            return;
        };
        std::fs::create_dir_all(
            claude_plugins_dir(None, home).join("cache").join(marketplace).join(plugin),
        )
        .unwrap();
    }

    #[test]
    fn the_install_pass_runs_marketplace_add_before_install_and_only_records_successes() {
        // The argv and the ledger policy are what this feature IS, so drive the loop with a fake
        // runner rather than inferring them from a real `claude`.
        let dir = std::env::temp_dir().join(format!("sparkle-install-pass-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // An empty fixture home: observation is a definitive "nothing installed here".
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let tree_root = claude_plugins_dir(None, &home);
        let enabled = sample_pair();
        let mut calls: Vec<Vec<String>> = Vec::new();
        let mut attempted = Vec::new();
        // Fail the SECOND plugin's install, so success and failure are both exercised in one pass.
        let outcomes = run_install_pass(
            &dir,
            PluginTree { config_dir: None, home: Some(&home), is_default: true },
            &enabled,
            &mut attempted,
            None,
            &mut |args| {
                calls.push(args.to_vec());
                if args.first().map(String::as_str) == Some("plugin")
                    && args.get(1).map(String::as_str) == Some("install")
                    && args.get(2).is_some_and(|id| id.starts_with("frontend-design"))
                {
                    return Err("offline".into());
                }
                fake_install(&home, args);
                Ok(())
            },
        );

        // Marketplace registration comes FIRST for each plugin — an install against an unregistered
        // marketplace is the fresh-machine failure this ordering exists to prevent.
        assert_eq!(
            calls,
            vec![
                marketplace_add_args(crate::config::OFFICIAL_MARKETPLACE_REPO),
                install_args("superpowers@claude-plugins-official"),
                marketplace_add_args(crate::config::OFFICIAL_MARKETPLACE_REPO),
                install_args("frontend-design@claude-plugins-official"),
            ]
        );
        // THE reason outcomes exist: the pass is best-effort and returns Ok either way, so a caller
        // that can only see "did it reject?" cannot tell an offline machine from a healthy one — and
        // the toggle then reads ON with the plugin absent.
        assert_eq!(
            outcomes.iter().map(|o| (o.key.as_str(), o.status)).collect::<Vec<_>>(),
            vec![
                ("superpowers", PluginInstallStatus::Installed),
                ("frontend_design", PluginInstallStatus::Failed),
            ]
        );
        let failed = &outcomes[1];
        assert_eq!(failed.message.as_deref(), Some(INSTALL_FAILED_MESSAGE));
        assert_eq!(
            failed.detail.as_deref(),
            Some("offline"),
            "the technical cause rides along for the log/tooltip, separate from the row copy"
        );
        assert!(outcomes[0].message.is_none() && outcomes[0].detail.is_none());

        // Only the success is recorded; the failure stays out so a LATER LAUNCH retries it.
        assert_eq!(
            read_installed_ledger(&installed_ledger_path(&dir), &tree_root, true),
            vec!["superpowers@claude-plugins-official".to_string()]
        );

        // A second pass in the same process runs NOTHING: the failed plugin was already attempted.
        // Without this, an offline machine re-ran two 90s network calls per plugin on every single
        // agent prepare — five agents was ~15 minutes of blocking-pool work that failed again.
        let mut calls2: Vec<Vec<String>> = Vec::new();
        let outcomes2 = run_install_pass(
            &dir,
            PluginTree { config_dir: None, home: Some(&home), is_default: true },
            &enabled,
            &mut attempted,
            None,
            &mut |args| {
                calls2.push(args.to_vec());
                Ok(())
            },
        );
        assert!(calls2.is_empty(), "a retry within the same launch must be suppressed: {calls2:?}");
        // Suppressed is still reported as NOT PRESENT, with the remedy named. Reporting it as
        // "already present" would be the same lie the outcome list exists to stop.
        assert_eq!(outcomes2[1].status, PluginInstallStatus::Failed);
        assert_eq!(outcomes2[1].message.as_deref(), Some(SUPPRESSED_MESSAGE));
        // The one that DID install is observed on the machine now, so it reports as already present.
        assert_eq!(outcomes2[0].status, PluginInstallStatus::AlreadyPresent);

        // …but `force` — set only by the user-initiated toggle — bypasses the suppression. Without
        // it, "turn it off and on again" (the only remedy the UI names) is a silent no-op that
        // renders as success.
        let mut calls3: Vec<Vec<String>> = Vec::new();
        let outcomes3 = run_install_pass(
            &dir,
            PluginTree { config_dir: None, home: Some(&home), is_default: true },
            &enabled,
            &mut attempted,
            Some("frontend_design"),
            &mut |args| {
                calls3.push(args.to_vec());
                fake_install(&home, args);
                Ok(())
            },
        );
        assert_eq!(
            calls3,
            vec![
                marketplace_add_args(crate::config::OFFICIAL_MARKETPLACE_REPO),
                install_args("frontend-design@claude-plugins-official"),
            ],
            "force must re-run the plugin that is still missing — and only that one"
        );
        assert_eq!(outcomes3[1].status, PluginInstallStatus::Installed);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_ledger_is_rewritten_when_a_recorded_plugin_is_gone_even_if_the_reinstall_fails() {
        // Otherwise a stale entry survives, and a later pass on a machine we can't observe falls
        // back to it and skips — the same "permanently convinced it's there" state, just narrower.
        let dir = std::env::temp_dir().join(format!("sparkle-ledger-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ledger = installed_ledger_path(&dir);
        std::fs::write(
            &ledger,
            r#"{"installed":["superpowers@claude-plugins-official","frontend-design@claude-plugins-official"]}"#,
        )
        .unwrap();

        // An empty fixture home → observation is a definitive "nothing installed".
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();

        let mut attempted = Vec::new();
        let outcomes = run_install_pass(
            &dir,
            PluginTree { config_dir: None, home: Some(&home), is_default: true },
            &all_on(),
            &mut attempted,
            None,
            &mut |_| Err("offline".into()),
        );
        assert!(outcomes.iter().all(|o| o.status == PluginInstallStatus::Failed));
        assert!(
            read_installed_ledger(&ledger, &claude_plugins_dir(None, &home), true).is_empty(),
            "a plugin observed as gone must stop being claimed, even when its reinstall failed"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_hung_claude_call_is_killed_at_the_deadline_instead_of_wedging_the_loop() {
        // The install loop is sequential on one blocking-pool thread, so an unbounded child pins
        // that thread for the life of the process and every remaining plugin never installs.
        let dir = std::env::temp_dir().join(format!("sparkle-plugin-timeout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // A "claude" that never exits, and one that fails loudly. Both are plain /bin/sh scripts so
        // the test doesn't depend on node being installed. `#!/bin/sh` throughout, so nothing here
        // depends on the developer's own shell or profile.
        // `exec sleep` (not a plain `sleep`) keeps this test about the deadline itself. The forked-
        // grandchild case — which used to hold the drain open past the kill — is covered directly by
        // `worktree::tests::a_surviving_grandchild_cannot_hold_the_drain_past_the_deadline`, where
        // the process-group kill that fixes it lives.
        let hung = dir.join("claude-hung");
        std::fs::write(&hung, "#!/bin/sh\nexec sleep 30\n").unwrap();
        let failing = dir.join("claude-fails");
        std::fs::write(&failing, "#!/bin/sh\necho 'marketplace not found' >&2\nexit 1\n").unwrap();
        for p in [&hung, &failing] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let started = std::time::Instant::now();
        let err = run_claude_with_timeout(
            hung.to_str().unwrap(),
            None,
            &["plugin".into(), "install".into()],
            std::time::Duration::from_millis(600),
        )
        .expect_err("a hung child must expire, not block");
        assert!(err.contains("timed out"), "expiry should say so: {err}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "killed at the deadline, not after the child's own 30s: took {:?}",
            started.elapsed()
        );

        // A normal non-zero exit still reports the child's stderr (this is what gets warn-logged).
        let err = run_claude_with_timeout(
            failing.to_str().unwrap(),
            None,
            &["plugin".into(), "install".into(), "x@y".into()],
            std::time::Duration::from_secs(20),
        )
        .expect_err("exit 1 is a failure");
        assert!(err.contains("marketplace not found"), "stderr must survive: {err}");

        // And a success is a plain Ok — proving the login-shell wrapper actually runs the binary.
        let ok = dir.join("claude-ok");
        std::fs::write(&ok, "#!/bin/sh\nexit 0\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&ok, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(run_claude_with_timeout(
            ok.to_str().unwrap(),
            None,
            &["plugin".into(), "list".into()],
            std::time::Duration::from_secs(20)
        )
        .is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_shipped_plugin_carries_a_source_and_only_foreign_ones_are_declared() {
        // Two halves of the marketplace decision, pinned together for EVERY row:
        //   * `source` is always set, so the installer's idempotent `marketplace add` runs — without
        //     it, a machine where Claude Code was never launched interactively has no registered
        //     marketplace and every install fails (warn-logged only, so silently).
        //   * `declared_source()` is None ONLY for the marketplace Claude Code owns. Sparkle's own
        //     marketplace must be declared per worktree, or the settings file names a marketplace
        //     the agent cannot resolve.
        let mut saw_official = false;
        let mut saw_sparkle = false;
        for p in crate::config::KNOWN_PLUGINS {
            let src = p.source.expect("the installer needs a repo to `marketplace add`");
            assert_eq!(src.name, p.marketplace, "a row's source must name its own marketplace");
            if p.marketplace == OFFICIAL_MARKETPLACE {
                saw_official = true;
                assert_eq!(src.repo, crate::config::OFFICIAL_MARKETPLACE_REPO);
                assert!(
                    p.declared_source().is_none(),
                    "never re-declare Claude Code's own marketplace"
                );
            } else {
                saw_sparkle = true;
                assert!(
                    p.declared_source().is_some(),
                    "{} lives in a marketplace Claude Code does not know; it MUST be declared",
                    p.id()
                );
            }
        }
        assert!(saw_official && saw_sparkle, "both marketplace kinds must stay covered");
    }

    #[test]
    fn log_path_within_confines_reads_to_hook_events_dir() {
        let tmp = std::env::temp_dir().join(format!("sparkle-hooks-log-{}", std::process::id()));
        let base = tmp.join("hook-events");
        std::fs::create_dir_all(&base).unwrap();
        let cbase = base.canonicalize().unwrap();

        // A file in the hook-events dir passes even though it doesn't exist yet (no events).
        assert!(log_path_within(&cbase, base.join("agent.jsonl").to_str().unwrap()));
        // An arbitrary system file is rejected — closes the file-read oracle.
        assert!(!log_path_within(&cbase, "/etc/passwd"));
        // A sibling directory is rejected.
        let sib = tmp.join("evil");
        std::fs::create_dir_all(&sib).unwrap();
        assert!(!log_path_within(&cbase, sib.join("x.jsonl").to_str().unwrap()));

        // A symlink PLANTED INSIDE the managed dir but pointing OUTSIDE it is rejected — the full
        // path is canonicalized (symlink followed) and must still resolve under base.
        let outside_file = tmp.join("secret.txt");
        std::fs::write(&outside_file, b"top secret").unwrap();
        let planted = base.join("sneaky.jsonl");
        std::os::unix::fs::symlink(&outside_file, &planted).unwrap();
        assert!(!log_path_within(&cbase, planted.to_str().unwrap()));

        // A DANGLING symlink in the managed dir (target doesn't exist yet) is also rejected — its
        // target could be created later to redirect the read outside base.
        let dangling = base.join("dangling.jsonl");
        std::os::unix::fs::symlink(tmp.join("not-created-yet"), &dangling).unwrap();
        assert!(!log_path_within(&cbase, dangling.to_str().unwrap()));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn confine_to_worktrees_accepts_inside_rejects_outside_and_escape() {
        // PID + a distinct prefix keep this test's temp root from colliding with the other
        // hooks tests (PID isolates concurrent test *processes*; the prefix isolates within one).
        let tmp = std::env::temp_dir().join(format!("sparkle-hooks-confine-{}", std::process::id()));
        let base = tmp.join("worktrees");
        let inside = base.join("proj").join("agent");
        std::fs::create_dir_all(&inside).unwrap();

        // A real worktree under <base>/worktrees is accepted (returns the canonical path).
        assert!(confine_to_worktrees(&base, inside.to_str().unwrap()).is_ok());

        // A sibling directory OUTSIDE the worktrees dir (e.g. $HOME) is rejected — this is the
        // write-anywhere → persistent-code-execution vector the confinement closes.
        let outside = tmp.join("evil");
        std::fs::create_dir_all(&outside).unwrap();
        assert!(confine_to_worktrees(&base, outside.to_str().unwrap()).is_err());

        // A `..` escape is rejected because both sides are canonicalized before comparison.
        let escape = format!("{}/../../evil", inside.to_str().unwrap());
        assert!(confine_to_worktrees(&base, &escape).is_err());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The hooks installer must pre-approve Sparkle's control plane BY ITSELF.
    ///
    /// Regression pin for the "founder keeps clicking Approve? for sparkle-control - rename_agent"
    /// report. The allowlist used to be written only by `merge_guard_settings`, so this path — the
    /// one that always runs, and whose sibling guard install `AgentPane.prepare` catches and merely
    /// warns about — produced a settings file with hooks and plugins but NO `permissions.allow`.
    /// Asserting the SIDE EFFECT (a control-plane rule is present in the composed output), not the
    /// precondition (some file was written), which was already true before the change.
    #[test]
    fn composed_agent_settings_pre_approve_the_control_plane_without_the_guard_installer() {
        let out = compose_agent_settings(None, "node '/x/sparkle-hook.mjs' '/y/ev.jsonl'", &[]);
        let v: serde_json::Value = serde_json::from_str(&out).expect("composed settings are JSON");
        let rules: Vec<&str> = v["permissions"]["allow"]
            .as_array()
            .expect("permissions.allow must exist on the hooks path alone")
            .iter()
            .filter_map(|r| r.as_str())
            .collect();
        assert!(
            rules.contains(&"mcp__sparkle-control"),
            "sparkle-control not pre-approved by the hooks installer: {rules:?}"
        );
        assert!(
            rules.contains(&"mcp__sparkle-orchestrator"),
            "sparkle-orchestrator not pre-approved by the hooks installer: {rules:?}"
        );
        // The emitter must survive the added merge — the allowlist step must not drop hooks.
        assert!(out.contains("sparkle-hook.mjs"), "emitter hook lost: {out}");
    }

    /// The composed body must carry the WHOLE permission posture, not just the allowlist — and the
    /// consent record is the half that is easy to leave out and impossible to notice.
    ///
    /// Writing `defaultMode: "bypassPermissions"` without it does not remove a prompt, it TRADES
    /// the per-command approval prompt for Claude Code's one-time bypass disclaimer at startup:
    /// the same number of dialogs for the human, and a hang for an unattended agent. So this
    /// asserts all three keys together, and asserts the emitter and plugin merges survive the
    /// posture step — that is the side effect, not the precondition that some file was written.
    #[test]
    fn composed_agent_settings_carry_bypass_deny_and_the_consent_record() {
        // Compose over a worktree the GUARD installer already wrote — the normal order in
        // `AgentPane.prepare`. The bypass is gated on that guard being present (see
        // `worktree::the_hooks_path_alone_writes_no_bypass_when_the_guard_is_missing`), so seeding
        // it here is what makes this test exercise the posture rather than the refusal.
        let guarded =
            crate::worktree::merge_guard_settings(None, "node /abs/worktree-guard.mjs /wt/a");
        let out = compose_agent_settings(
            Some(&guarded),
            "node '/x/sparkle-hook.mjs' '/y/ev.jsonl'",
            &[],
        );
        let v: serde_json::Value = serde_json::from_str(&out).expect("composed settings are JSON");
        assert_eq!(
            v["permissions"]["defaultMode"], "bypassPermissions",
            "the per-command approval prompt is not turned off: {out}"
        );
        assert_eq!(
            v["skipDangerousModePermissionPrompt"], true,
            "no consent record, so the agent stops on the bypass disclaimer instead: {out}"
        );
        let deny: Vec<&str> = v["permissions"]["deny"]
            .as_array()
            .expect("permissions.deny must exist on the hooks path alone")
            .iter()
            .filter_map(|r| r.as_str())
            .collect();
        assert!(deny.contains(&"Bash(sudo:*)"), "deny list missing: {deny:?}");
        // The posture step runs LAST in the chain, so it is the one that could drop the others.
        assert!(out.contains("sparkle-hook.mjs"), "emitter hook lost: {out}");
    }

    /// Composing over a file the guard installer already wrote must not duplicate rules, and must
    /// keep rules a human added by hand. Both installers run on every prepare, so a merge that
    /// appended blindly would grow the file without bound.
    #[test]
    fn composed_agent_settings_are_idempotent_and_keep_user_rules() {
        let seeded = crate::worktree::merge_allowed_tools_settings(Some(
            r#"{"permissions":{"allow":["Bash(git status)"]}}"#,
        ));
        let once = compose_agent_settings(Some(&seeded), // The command MUST contain EMITTER_MARKER — that substring is how merge_event_hooks
        // recognizes and replaces its own prior entry. A fake path without it appends a second
        // copy on every re-prepare, which looks like a product bug and is only a test artifact.
        "node '/x/sparkle-hook.mjs' '/y.jsonl'", &[]);
        let twice = compose_agent_settings(Some(&once), // The command MUST contain EMITTER_MARKER — that substring is how merge_event_hooks
        // recognizes and replaces its own prior entry. A fake path without it appends a second
        // copy on every re-prepare, which looks like a product bug and is only a test artifact.
        "node '/x/sparkle-hook.mjs' '/y.jsonl'", &[]);
        assert_eq!(once, twice, "composing twice must be a no-op");
        let v: serde_json::Value = serde_json::from_str(&twice).unwrap();
        let rules: Vec<&str> = v["permissions"]["allow"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r.as_str())
            .collect();
        assert!(rules.contains(&"Bash(git status)"), "user rule dropped: {rules:?}");
        assert_eq!(
            rules.iter().filter(|r| **r == "mcp__sparkle-control").count(),
            1,
            "control-plane rule duplicated: {rules:?}"
        );
    }

    #[test]
    fn atomic_write_settings_writes_valid_and_refuses_invalid_json() {
        // FIX 3: settings.local.json must be replaced atomically and never clobbered with invalid
        // JSON (a concurrently-running Claude reads this to drive its executable hooks).
        let dir = std::env::temp_dir().join(format!("sparkle-hooks-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.local.json");

        // Valid JSON is written.
        atomic_write_settings(&file, r#"{"hooks":{}}"#).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"hooks":{}}"#);

        // Invalid JSON is refused and the prior good file is left byte-for-byte intact.
        let before = std::fs::read_to_string(&file).unwrap();
        assert!(atomic_write_settings(&file, "{not valid json").is_err());
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            before,
            "file must be untouched after a rejected write"
        );

        // No temp residue is left in the dir (rename consumed it; the rejected write never made one).
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp-file residue after writes");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reinstall_restores_a_clobbered_emitter_and_keeps_the_user_keys() {
        // THE RECOVERY PATH for a mid-session emitter clobber (a permission grant, /permissions, or
        // the agent editing .claude/settings.local.json drops the emitter and hook events stop
        // cold). AgentPane re-runs install_agent_hooks on EVERY prepare, and this merge is what
        // makes that a repair: the emitter comes back for every tracked event.
        //
        // Note `heal_agent_hooks` canNOT do this job — `needs_heal` requires the file to STILL
        // contain EMITTER_MARKER, so it only re-points a stale path and skips a file the emitter
        // was removed from entirely. Reinstall is strictly stronger for the target worktree, which
        // is why prepare does not also call heal.
        let clobbered = r#"{
            "model": "opus",
            "permissions": { "allow": ["Bash(ls:*)"] },
            "hooks": { "PreToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "node worktree-guard.mjs /wt" } ] } ] }
        }"#;
        let out = merge_event_hooks(Some(clobbered), "node /abs/sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&out).unwrap();
        for ev in TOOL_EVENTS.iter().chain(PLAIN_EVENTS.iter()) {
            assert!(emitter_present(&v, ev), "emitter not restored for {ev}");
        }
        // The clobber-survivors are preserved — a repair must not cost the user their settings.
        assert_eq!(v["model"], json!("opus"));
        assert_eq!(v["permissions"]["allow"][0], json!("Bash(ls:*)"));
        // ...including the unrelated guard hook sharing the PreToolUse array.
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(
            pre.iter().any(|e| e["hooks"][0]["command"]
                .as_str()
                .is_some_and(|c| c.contains("worktree-guard.mjs"))),
            "the guard hook must survive the emitter restore"
        );
    }

    #[test]
    fn heal_cannot_restore_a_fully_removed_emitter() {
        // Pins the asymmetry the test above depends on, so the reasoning behind "prepare reinstalls
        // rather than heals" stays honest if heal_settings is ever changed.
        let no_emitter = r#"{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"node /abs/worktree-guard.mjs /wt"}]}]}}"#;
        let healed = heal_settings(
            no_emitter,
            Path::new("/abs/sparkle-hook.mjs"),
            "node /abs/sparkle-hook.mjs /log",
            Path::new("/abs/worktree-guard.mjs"),
            "node /abs/worktree-guard.mjs /wt",
        );
        assert!(healed.is_none(), "heal is a no-op once the emitter marker is gone");
    }

    #[test]
    fn registers_emitter_for_every_tracked_event() {
        let out = merge_event_hooks(None, "node sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&out).unwrap();
        for ev in TOOL_EVENTS.iter().chain(PLAIN_EVENTS.iter()) {
            assert!(emitter_present(&v, ev), "emitter missing for {ev}");
        }
        // Tool events carry a matcher; plain events do not.
        assert_eq!(v["hooks"]["PreToolUse"][0]["matcher"], json!("*"));
        assert!(v["hooks"]["Stop"][0].get("matcher").is_none());
    }

    #[test]
    fn preserves_existing_guard_and_user_keys() {
        let existing = r#"{
            "model": "opus",
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Edit|Write", "hooks": [ { "type": "command", "command": "node worktree-guard.mjs /wt" } ] }
                ]
            }
        }"#;
        let out = merge_event_hooks(Some(existing), "node sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&out).unwrap();
        // User key untouched.
        assert_eq!(v["model"], json!("opus"));
        // Guard still present alongside the emitter in PreToolUse.
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(pre.iter().any(|e| entry_has_marker(e, "worktree-guard.mjs")));
        assert!(pre.iter().any(|e| entry_has_marker(e, EMITTER_MARKER)));
    }

    #[test]
    fn reinstall_is_idempotent() {
        let once = merge_event_hooks(None, "node sparkle-hook.mjs /log");
        let twice = merge_event_hooks(Some(&once), "node sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&twice).unwrap();
        // Exactly one emitter entry per event after a second install.
        for ev in TOOL_EVENTS.iter().chain(PLAIN_EVENTS.iter()) {
            let n = v["hooks"][ev]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| entry_has_marker(e, EMITTER_MARKER))
                .count();
            assert_eq!(n, 1, "duplicate emitter for {ev}");
        }
    }

    #[test]
    fn tolerates_non_object_existing_settings() {
        let out = merge_event_hooks(Some("[1,2,3]"), "node sparkle-hook.mjs /log");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(emitter_present(&v, "Stop"));
    }

    fn temp_log(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("sparkle-hooks-test-{}-{tag}.jsonl", std::process::id()))
    }

    #[test]
    fn missing_log_yields_empty_batch_at_same_offset() {
        let p = temp_log("missing");
        let _ = std::fs::remove_file(&p);
        let chunk = read_events_since_impl(&p, 0, false).unwrap();
        assert!(chunk.lines.is_empty());
        assert_eq!(chunk.offset, 0);
        assert!(!chunk.truncated);
    }

    #[test]
    fn reads_only_complete_lines_and_resumes_from_offset() {
        let p = temp_log("incremental");
        // Two complete lines plus a partial third (no trailing newline yet).
        std::fs::write(&p, "{\"event\":\"PreToolUse\"}\n{\"event\":\"Stop\"}\n{\"event\":\"Pa")
            .unwrap();
        let first = read_events_since_impl(&p, 0, false).unwrap();
        assert_eq!(first.lines.len(), 2);
        assert_eq!(first.lines[1], "{\"event\":\"Stop\"}");

        // Emitter finishes the partial line; resuming from the prior offset yields just it.
        std::fs::write(&p, "{\"event\":\"PreToolUse\"}\n{\"event\":\"Stop\"}\n{\"event\":\"Partial\"}\n")
            .unwrap();
        let second = read_events_since_impl(&p, first.offset, false).unwrap();
        assert_eq!(second.lines, vec!["{\"event\":\"Partial\"}".to_string()]);
        let _ = std::fs::remove_file(&p);
    }

    /// Build a log of `n` identical whole lines; returns (path, line_len).
    fn write_lines(p: &Path, n: usize) -> usize {
        let line = "{\"event\":\"Stop\",\"tool\":\"Bash\"}\n";
        let mut s = String::with_capacity(line.len() * n);
        for _ in 0..n {
            s.push_str(line);
        }
        std::fs::write(p, &s).unwrap();
        line.len()
    }

    #[test]
    fn caps_a_single_read_at_max_read_bytes_and_flags_truncation() {
        // The unbounded-read fix: one poll must never pull more than MAX_READ_BYTES off disk,
        // however far behind the reader is.
        let p = temp_log("cap");
        let line_len = write_lines(&p, (MAX_READ_BYTES as usize / 30) * 3); // comfortably over the cap
        let total = std::fs::metadata(&p).unwrap().len();
        assert!(total > MAX_READ_BYTES, "fixture must exceed the cap");

        let first = read_events_since_impl(&p, 0, false).unwrap();
        assert!(first.truncated, "more data remains, so the flag is set");
        assert!(
            first.offset <= MAX_READ_BYTES,
            "consumed {} bytes, over the {MAX_READ_BYTES} cap",
            first.offset
        );
        // Truncation lands on a LINE boundary — every line handed out is whole and parseable.
        assert_eq!(first.offset as usize % line_len, 0);
        for l in &first.lines {
            serde_json::from_str::<Value>(l).expect("no partial line escaped the cap");
        }

        // Resuming drains the rest, and the final chunk is not flagged truncated.
        let mut offset = first.offset;
        let mut guard = 0;
        loop {
            let c = read_events_since_impl(&p, offset, false).unwrap();
            offset = c.offset;
            guard += 1;
            assert!(guard < 100, "draining must terminate");
            if !c.truncated {
                break;
            }
        }
        assert_eq!(offset, total, "every byte is eventually consumed exactly once");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn a_single_line_longer_than_the_cap_does_not_wedge_the_reader() {
        // Pathological: no newline within the capped block. Consuming 0 bytes would re-read the
        // same block forever. The reader must advance instead of spinning.
        let p = temp_log("hugeline");
        let mut data = vec![b'x'; (MAX_READ_BYTES + 4096) as usize];
        data.push(b'\n');
        std::fs::write(&p, &data).unwrap();

        let c = read_events_since_impl(&p, 0, false).unwrap();
        assert!(c.truncated);
        assert!(c.offset > 0, "offset must advance past an over-long line, not stall at 0");
        assert_eq!(c.offset, MAX_READ_BYTES);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn skip_existing_seeks_to_eof_without_reading_the_backlog() {
        // The pane-mount path. Previously the frontend started at offset 0 and read the ENTIRE
        // accumulated log on every mount, discarding it JS-side. Server-side skip returns EOF.
        let p = temp_log("skip");
        write_lines(&p, 50_000); // ~1.5 MB: more than one capped read could drain
        let total = std::fs::metadata(&p).unwrap().len();
        assert!(total > MAX_READ_BYTES, "backlog must be big enough that reading it would be the bug");

        let c = read_events_since_impl(&p, 0, true).unwrap();
        assert!(c.lines.is_empty(), "no backlog is dispatched");
        assert_eq!(c.offset, total, "and we resume from the true end of file");
        assert!(!c.truncated, "nothing was truncated — nothing was read");

        // Events appended after the skip ARE delivered, from the skipped offset.
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        use std::io::Write;
        f.write_all(b"{\"event\":\"Fresh\"}\n").unwrap();
        let next = read_events_since_impl(&p, c.offset, false).unwrap();
        assert_eq!(next.lines, vec!["{\"event\":\"Fresh\"}".to_string()]);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn skip_existing_on_a_missing_log_stays_at_the_caller_offset() {
        let p = temp_log("skipmissing");
        let _ = std::fs::remove_file(&p);
        let c = read_events_since_impl(&p, 0, true).unwrap();
        assert!(c.lines.is_empty());
        assert_eq!(c.offset, 0);
    }

    #[test]
    fn an_exactly_cap_sized_read_is_not_flagged_truncated() {
        // Boundary: available == MAX_READ_BYTES means everything fit; the flag must stay false so
        // the watcher doesn't spin an extra immediate poll for nothing.
        let p = temp_log("boundary");
        let mut data = vec![b'x'; (MAX_READ_BYTES - 1) as usize];
        data.push(b'\n');
        assert_eq!(data.len() as u64, MAX_READ_BYTES);
        std::fs::write(&p, &data).unwrap();

        let c = read_events_since_impl(&p, 0, false).unwrap();
        assert!(!c.truncated, "exactly-at-cap is complete, not truncated");
        assert_eq!(c.offset, MAX_READ_BYTES);
        assert_eq!(c.lines.len(), 1);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn log_key_uses_basename_and_falls_back() {
        assert_eq!(log_key("/app/worktrees/proj/agent-123"), "agent-123");
        // A trailing slash still resolves to the final component.
        assert_eq!(log_key("/app/worktrees/proj/agent-123/"), "agent-123");
        // Pathological inputs fall back to the shared key rather than panicking.
        assert_eq!(log_key(""), "agent");
        assert_eq!(log_key("/"), "agent");
    }

    #[test]
    fn merge_preserves_user_key_order() {
        // With serde_json's preserve_order feature, the user's keys keep their original order
        // rather than being alphabetized on merge.
        let existing = r#"{ "zebra": 1, "model": "opus", "alpha": 2 }"#;
        let out = merge_event_hooks(Some(existing), "node sparkle-hook.mjs /log");
        let zebra = out.find("zebra").unwrap();
        let model = out.find("\"model\"").unwrap();
        let alpha = out.find("alpha").unwrap();
        assert!(zebra < model && model < alpha, "user key order preserved");
    }

    #[test]
    fn a_non_utf8_byte_does_not_wedge_the_reader() {
        let p = temp_log("badbytes");
        // A valid line, then a line with a stray invalid byte, both newline-terminated.
        let mut data = b"{\"event\":\"Stop\"}\n".to_vec();
        data.extend_from_slice(b"{\"event\":\"\xFFx\"}\n");
        std::fs::write(&p, &data).unwrap();
        let chunk = read_events_since_impl(&p, 0, false).unwrap();
        // Both complete lines are returned (the bad byte is replaced, not fatal) and the offset
        // advances past everything so the next poll won't re-read the corrupt tail.
        assert_eq!(chunk.lines.len(), 2);
        assert_eq!(chunk.offset, data.len() as u64);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn restarts_when_file_shrinks() {
        let p = temp_log("rotated");
        std::fs::write(&p, "{\"event\":\"Stop\"}\n").unwrap();
        // Offset past a now-smaller file (rotated/cleared) → re-read from the top.
        let chunk = read_events_since_impl(&p, 9999, false).unwrap();
        assert_eq!(chunk.lines, vec!["{\"event\":\"Stop\"}".to_string()]);
        let _ = std::fs::remove_file(&p);
    }

    const OLD_EMITTER: &str = "/Applications/Old.app/Contents/Resources/resources/sparkle-hook.mjs";
    const OLD_GUARD: &str = "/Applications/Old.app/Contents/Resources/resources/worktree-guard.mjs";

    #[test]
    fn needs_heal_detects_stale_marker_present_without_stable_path() {
        let stale = format!(
            r#"{{"hooks":{{"Stop":[{{"hooks":[{{"type":"command","command":"node '{OLD_EMITTER}' '/log'"}}]}}]}}}}"#
        );
        // Marker present but the stable path isn't → stale.
        assert!(needs_heal(&stale, EMITTER_MARKER, "/data/bin/sparkle-hook.mjs"));
        // Already references the stable path → not stale.
        let fresh = stale.replace(OLD_EMITTER, "/data/bin/sparkle-hook.mjs");
        assert!(!needs_heal(&fresh, EMITTER_MARKER, "/data/bin/sparkle-hook.mjs"));
        // Marker absent → never heal (don't graft a hook that was never installed).
        assert!(!needs_heal("{}", EMITTER_MARKER, "/data/bin/sparkle-hook.mjs"));
    }

    #[test]
    fn heal_settings_repoints_both_hooks_then_noops() {
        let e_new = Path::new("/data/bin/sparkle-hook.mjs");
        let g_new = Path::new("/data/bin/worktree-guard.mjs");
        // A worktree with BOTH hooks pointing at an old bundle.
        let with_emitter =
            merge_event_hooks(None, &hook_command(Path::new(OLD_EMITTER), Path::new("/log")));
        let stale = crate::worktree::merge_guard_settings(
            Some(&with_emitter),
            &hook_command(Path::new(OLD_GUARD), Path::new("/wt")),
        );

        let e_cmd = hook_command(e_new, Path::new("/log"));
        let g_cmd = hook_command(g_new, Path::new("/wt"));
        let healed = heal_settings(&stale, e_new, &e_cmd, g_new, &g_cmd).expect("stale → healed");
        assert!(healed.contains("/data/bin/sparkle-hook.mjs"));
        assert!(healed.contains("/data/bin/worktree-guard.mjs"));
        assert!(!healed.contains("/Applications/Old.app"));
        // Both hooks survive (rewritten, not dropped).
        let v: Value = serde_json::from_str(&healed).unwrap();
        assert!(emitter_present(&v, "Stop"));
        assert!(v["hooks"]["PreToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| entry_has_marker(e, GUARD_MARKER)));
        // Re-running on the now-stable file is a no-op (no needless rewrite).
        assert!(heal_settings(&healed, e_new, &e_cmd, g_new, &g_cmd).is_none());
    }

    // The lock only serializes if both call sites compute the SAME key. They build the path
    // differently — install joins onto a canonicalized `confine_to_worktrees` result, heal joins
    // onto a raw `read_dir` entry — so one file can arrive spelled two ways, giving two mutexes and
    // no serialization while the code reads as if there were one.
    //
    // A SYMLINK is the discriminator, and the choice is load-bearing. The first version of this test
    // used a `./` hop and was VACUOUS: `Path`'s comparison walks `components()`, which already drops
    // `CurDir`, so `a/./b == a/b` with or without the canonicalize — deleting the normalization left
    // it green. A symlink is something `Path` equality genuinely cannot resolve, so only a real
    // `canonicalize` collapses the two spellings. (This is also the actual macOS case: `/var` is a
    // symlink to `/private/var`, which is where `temp_dir()` lives.)
    #[cfg(unix)]
    #[test]
    fn the_settings_lock_key_collapses_two_spellings_of_one_path() {
        let tmp = std::env::temp_dir().join(format!("sparkle-lockkey-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let real = tmp.join("real");
        std::fs::create_dir_all(real.join(".claude")).unwrap();
        let link = tmp.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let via_real = real.join(".claude").join("settings.local.json");
        let via_link = link.join(".claude").join("settings.local.json");
        assert_ne!(via_real, via_link, "precondition: the two spellings differ as plain paths");
        assert_eq!(
            settings_lock_key(&via_real),
            settings_lock_key(&via_link),
            "two spellings of one settings file must map to ONE lock, or nothing is serialized"
        );

        // The file need NOT exist yet — install writes it for the first time under the lock, which
        // is why the PARENT is what gets canonicalized.
        assert!(!via_real.exists(), "precondition: this test never creates the file");

        // Distinct worktrees must NOT share a lock, or every install serializes behind every other.
        let other = tmp.join("other").join(".claude");
        std::fs::create_dir_all(&other).unwrap();
        assert_ne!(
            settings_lock_key(&via_real),
            settings_lock_key(&other.join("settings.local.json")),
            "distinct worktrees must take distinct locks"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn scan_and_heal_rewrites_only_stale_worktrees() {
        let tmp = std::env::temp_dir().join(format!("sparkle-heal-{}", std::process::id()));
        let worktrees = tmp.join("worktrees");
        let hook_events = tmp.join("hook-events");
        let e_new = tmp.join("bin").join("sparkle-hook.mjs");
        let g_new = tmp.join("bin").join("worktree-guard.mjs");

        // A: stale emitter from an old bundle → healed, log path recomputed from the agent basename.
        let a = worktrees.join("proj").join("agent-a").join(".claude");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(
            a.join("settings.local.json"),
            merge_event_hooks(None, &hook_command(Path::new(OLD_EMITTER), Path::new("/old/log"))),
        )
        .unwrap();

        // B: already points at the stable emitter → must be left byte-for-byte intact.
        let b = worktrees.join("proj").join("agent-b").join(".claude");
        std::fs::create_dir_all(&b).unwrap();
        let fresh =
            merge_event_hooks(None, &hook_command(&e_new, &hook_events.join("agent-b.jsonl")));
        std::fs::write(b.join("settings.local.json"), &fresh).unwrap();

        // C: a worktree dir with no settings file → skipped, nothing created.
        std::fs::create_dir_all(worktrees.join("proj").join("agent-c")).unwrap();

        let n = scan_and_heal(&worktrees, &hook_events, &e_new, &g_new).unwrap();
        assert_eq!(n, 1, "only the stale worktree is healed");

        let a_after = std::fs::read_to_string(a.join("settings.local.json")).unwrap();
        assert!(a_after.contains(&*e_new.to_string_lossy()));
        assert!(!a_after.contains("/Applications/Old.app"));
        assert!(a_after.contains("agent-a.jsonl"), "log path recomputed per agent");

        assert_eq!(
            std::fs::read_to_string(b.join("settings.local.json")).unwrap(),
            fresh,
            "already-stable worktree left untouched"
        );
        assert!(!worktrees
            .join("proj")
            .join("agent-c")
            .join(".claude")
            .join("settings.local.json")
            .exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn scan_and_heal_missing_worktrees_dir_is_ok() {
        let missing = std::env::temp_dir().join(format!("sparkle-heal-missing-{}", std::process::id()));
        let n = scan_and_heal(
            &missing.join("worktrees"),
            &missing.join("hook-events"),
            Path::new("/bin/e.mjs"),
            Path::new("/bin/g.mjs"),
        )
        .unwrap();
        assert_eq!(n, 0);
    }
}
