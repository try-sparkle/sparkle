//! Per-command MAIN-THREAD occupancy meter — the instrument that turns "I moved it off the main
//! thread" from a claim into a number.
//!
//! ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
//! `watchdog.rs` can tell you the main thread was wedged; `perfTrace.ts` can tell you a frame was
//! lost. Neither can tell you WHICH COMMAND did it, so every ranking of "the worst offenders" in
//! this codebase so far has been produced by reading source and guessing at frequency. The bead
//! this module was written for (`sparkle-rfhu5`) says so in its own closing note: the author wrote
//! the static analysis four times and it was wrong three times.
//!
//! ── WHAT IT MEASURES, AND WHY THE ASYMMETRY IS THE POINT ──────────────────────────────────────
//! Tauri's `#[tauri::command]` macro compiles a command one of two ways (tauri-macros
//! `command/wrapper.rs`):
//!
//!   * a plain `fn`                       -> `body_blocking`, kind `"sync"`.  The body runs INLINE
//!     on the thread that dispatched the invoke — the AppKit main thread.
//!   * an `async fn`, or `#[tauri::command(async)]` on a plain `fn`
//!                                        -> `body_async`, kind `"async"` / `"sync_threadpool"`.
//!     The handler hands the work to the async runtime and RETURNS.
//!
//! So wall time measured around the generated handler is, for a sync command, the whole main-thread
//! block it contributed; and for an async one, the dispatch hop alone. The same probe therefore
//! reads "everything" before a conversion and "~nothing" after it, with no change to what is being
//! measured. That asymmetry is what makes a before/after table meaningful rather than rhetorical.
//!
//! ── IT MUST NOT BECOME THE THING IT MEASURES ──────────────────────────────────────────────────
//! An instrument that takes a contended lock on the main thread would itself be a
//! `sparkle-rfhu5` defect. So the recording path NEVER blocks: it `try_lock`s and, on contention,
//! drops the sample and bumps a counter that is reported alongside the data. A dropped sample is
//! visible in the output; a stalled UI would not be.
//!
//! ── ON-MAIN IS OBSERVED, NOT ASSUMED ──────────────────────────────────────────────────────────
//! The premise "sync command body == main thread" is load-bearing for every conclusion drawn from
//! this data, so the probe checks it per sample against the thread id captured in `run()` rather
//! than taking it on faith. `Stat::on_main_calls` is what lets the report say "this ran on the main
//! thread N times" instead of inferring it from the macro's source.
//!
//! Off by default. Enabled only when `SPARKLE_CMD_TIMING` is set, so a normal build pays one
//! relaxed atomic load per invoke and nothing else.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread::ThreadId;
use std::time::Duration;

/// Whether the probe is armed. Read once per invoke; `Relaxed` because a stale read costs at most
/// one missed or one extra sample and never correctness.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Samples discarded because the stats map was momentarily held. Reported, never hidden.
static DROPPED: AtomicU64 = AtomicU64::new(0);

/// The thread `run()` was called on — the AppKit main thread.
static MAIN_THREAD: OnceLock<ThreadId> = OnceLock::new();

/// One command's accumulated cost. Durations in microseconds: a `u64` of µs overflows after ~584k
/// years, and ms would round away exactly the sub-millisecond commands we want to prove are cheap.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Stat {
    pub calls: u64,
    /// Of those calls, how many actually ran on the main thread. See the module note on why this is
    /// observed rather than assumed.
    pub on_main_calls: u64,
    pub total_us: u64,
    pub max_us: u64,
}

impl Stat {
    pub fn mean_us(&self) -> u64 {
        if self.calls == 0 {
            0
        } else {
            self.total_us / self.calls
        }
    }
}

fn stats() -> &'static Mutex<HashMap<String, Stat>> {
    static STATS: OnceLock<Mutex<HashMap<String, Stat>>> = OnceLock::new();
    STATS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record the main thread's identity. Call from `run()`, on the main thread, before the event loop.
pub fn note_main_thread() {
    let _ = MAIN_THREAD.set(std::thread::current().id());
}

/// Is the calling thread the one `note_main_thread` saw?
///
/// `false` when the id was never captured — an unknown answer must not be reported as "yes, this
/// was on the main thread", since that is the claim the whole report rests on.
pub fn on_main_thread() -> bool {
    MAIN_THREAD.get().is_some_and(|id| *id == std::thread::current().id())
}

/// Arm the probe if `SPARKLE_CMD_TIMING` is set in the environment. Returns whether it is armed.
pub fn init_from_env() -> bool {
    let on = std::env::var_os("SPARKLE_CMD_TIMING").is_some();
    ENABLED.store(on, Ordering::Relaxed);
    on
}

/// Arm or disarm explicitly. For tests.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Fold one observation in. Never blocks: on contention the sample is dropped and counted.
pub fn record(command: &str, elapsed: Duration, on_main: bool) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let us = elapsed.as_micros() as u64;
    // try_lock, never lock: see the module note. This runs on the main thread for exactly the
    // commands under investigation, so a blocking acquire here would be the defect it measures.
    let Ok(mut map) = stats().try_lock() else {
        DROPPED.fetch_add(1, Ordering::Relaxed);
        return;
    };
    let e = map.entry(command.to_string()).or_default();
    e.calls += 1;
    if on_main {
        e.on_main_calls += 1;
    }
    e.total_us += us;
    e.max_us = e.max_us.max(us);
}

/// Samples lost to contention so far.
pub fn dropped() -> u64 {
    DROPPED.load(Ordering::Relaxed)
}

/// Current table, sorted by total main-thread cost descending — the ranking that matters, since a
/// cheap command called constantly outranks an expensive one called at startup.
pub fn snapshot() -> Vec<(String, Stat)> {
    let Ok(map) = stats().try_lock() else { return Vec::new() };
    let mut v: Vec<(String, Stat)> = map.iter().map(|(k, s)| (k.clone(), *s)).collect();
    v.sort_by(|a, b| b.1.total_us.cmp(&a.1.total_us).then_with(|| a.0.cmp(&b.0)));
    v
}

/// Drop all accumulated samples. For tests, and for marking the start of a measurement window.
pub fn reset() {
    if let Ok(mut map) = stats().try_lock() {
        map.clear();
    }
    DROPPED.store(0, Ordering::Relaxed);
}

/// Render the table as JSON. Hand-built rather than via `serde_json::to_string` so the shape is
/// obvious at the call site and cannot drift with a derive.
pub fn to_json(label: &str) -> String {
    let rows = snapshot();
    let mut out = String::from("{\n");
    out.push_str(&format!("  \"label\": {},\n", json_str(label)));
    out.push_str(&format!("  \"dropped_samples\": {},\n", dropped()));
    out.push_str("  \"commands\": [\n");
    for (i, (name, s)) in rows.iter().enumerate() {
        out.push_str(&format!(
            "    {{\"command\": {}, \"calls\": {}, \"on_main_calls\": {}, \"total_us\": {}, \"mean_us\": {}, \"max_us\": {}}}{}\n",
            json_str(name),
            s.calls,
            s.on_main_calls,
            s.total_us,
            s.mean_us(),
            s.max_us,
            if i + 1 == rows.len() { "" } else { "," }
        ));
    }
    out.push_str("  ]\n}\n");
    out
}

/// Wrap the generated invoke handler so every command is timed.
///
/// The `is_enabled` short-circuit comes FIRST and returns the untouched handler call, so a build
/// without `SPARKLE_CMD_TIMING` pays one relaxed atomic load per invoke — no string allocation, no
/// clock read, no map. That matters because this sits on the hottest path in the process.
pub fn measure<R, F>(invoke: tauri::ipc::Invoke<R>, handler: &F) -> bool
where
    R: tauri::Runtime,
    F: Fn(tauri::ipc::Invoke<R>) -> bool,
{
    if !is_enabled() {
        return handler(invoke);
    }
    // `command()` borrows from `invoke`, which the handler consumes — so the name must be taken
    // before the call, not after.
    let command = invoke.message.command().to_string();
    let on_main = on_main_thread();
    let started = std::time::Instant::now();
    let handled = handler(invoke);
    record(&command, started.elapsed(), on_main);
    handled
}

/// Minimal JSON string escaping. Command names are Rust identifiers in practice, but this is the
/// boundary where that stops being guaranteed, so it is escaped properly rather than trusted.
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Read the collected table out of a RUNNING app.
///
/// Without a readout this probe would be write-only: armed, it pays a `to_string` allocation, a
/// clock read and a map insert on the hottest path in the process, for data nothing could ever
/// retrieve from that process. (The numbers in the PR came from `main_thread_bench`, which is a
/// different instrument.) Returns exactly the JSON `to_json` produces, so a live capture and a bench
/// run are directly comparable.
///
/// `async` so reading the table is not itself a main-thread command — the failure mode this whole
/// module exists to find.
#[tauri::command]
pub async fn cmd_timing_report() -> String {
    to_json("live")
}

/// Log the table on the way out, so an armed run leaves its data behind without anyone having to
/// remember to call the command before quitting. No-op when disarmed.
pub fn log_report_on_exit() {
    if !is_enabled() {
        return;
    }
    tracing::info!(target: "perf", report = %to_json("exit"), "per-command main-thread timing");
}

/// Crate-wide regression guard for the `sparkle-rfhu5` class: a command that was deliberately moved
/// off the AppKit main thread silently moving back.
///
/// ── WHY A SOURCE SCAN AND NOT A TYPE ASSERTION ────────────────────────────────────────────────
/// `support.rs` pins its commands with `assert_async_command(f: fn(A) -> Fut)`, which is stronger
/// where it applies — reverting `async` breaks the build. It does not apply here: several of these
/// take `AppHandle` plus deserialized args in varying arities, and one (`list_audio_inputs`) takes
/// none, so there is no single `fn` shape to name them all through. A scan of the command
/// ATTRIBUTE + the declaration it sits on covers every arity uniformly.
///
/// The failure mode this is built against is the vacuous guard this repo's own AGENTS.md condemns:
/// a scanner that matches nothing passes silently. So `command_is_async` returns `Option`, a
/// missing command is a FAILURE rather than a skip, and `the_scanner_reports_a_genuinely_sync_command`
/// pins a command that must stay sync forever — if that ever reads `true`, the scanner is broken and
/// every other assertion here is worthless.
#[cfg(test)]
mod main_thread_guard {
    /// Does the `#[tauri::command]`-attributed definition of `name` declare `async`?
    ///
    /// `None` when no such command exists — a rename or deletion must fail the guard, not silently
    /// satisfy it. Matches the attribute with `starts_with("#[tauri::command")` so the
    /// attribute-with-args forms (`#[tauri::command(async)]`, `#[tauri::command(rename_all = ...)]`)
    /// are still counted, and skips intervening doc comments and further attributes so a documented
    /// command is not missed.
    fn command_is_async(src: &str, name: &str) -> Option<bool> {
        for decl in command_decls(src) {
            // `fn <name>(` / `fn <name><` — the paren/angle guards against `read_prd` matching
            // `read_prd_impl`.
            let is_this = decl.contains(&format!("fn {name}("))
                || decl.contains(&format!("fn {name}<"));
            if is_this {
                return Some(decl.contains("async fn"));
            }
        }
        None
    }

    /// The declaration line of every `#[tauri::command]` in `src`, in source order.
    ///
    /// This is the ONE walk behind both questions the guard asks — "is the command named `x`
    /// async?" (`command_is_async`) and "which commands exist at all?" (`command_name_of` +
    /// the sweep). Sharing it is the point: two separate parsers could disagree about what counts
    /// as a command, and the sweep would then exempt a name the named guard cannot find, or miss a
    /// command the named guard sees.
    ///
    /// Matches the attribute with `starts_with("#[tauri::command")` so the attribute-with-args
    /// forms (`#[tauri::command(async)]`, `#[tauri::command(rename_all = ...)]`) still count, and
    /// steps over intervening doc comments and further attributes so a documented command is not
    /// missed. A `#[tauri::command]` appearing INSIDE a Rust string literal (this module's own
    /// scanner fixtures do exactly that) is not matched, because the physical line it sits on
    /// starts with the `let … = "` of the literal, not with the attribute.
    fn command_decls(src: &str) -> Vec<&str> {
        let lines: Vec<&str> = src.lines().collect();
        let mut out = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if !line.trim_start().starts_with("#[tauri::command") {
                continue;
            }
            // Walk to the declaration, stepping over doc comments and stacked attributes.
            let mut j = i + 1;
            while j < lines.len() {
                let t = lines[j].trim_start();
                if t.starts_with("#[") || t.starts_with("///") || t.starts_with("//") || t.is_empty()
                {
                    j += 1;
                } else {
                    break;
                }
            }
            if let Some(decl) = lines.get(j) {
                out.push(*decl);
            }
        }
        out
    }

    /// The command's identifier, from a declaration line `command_decls` produced.
    ///
    /// `None` when the line has no `fn <ident>` at all — which means the attribute→declaration walk
    /// landed somewhere unexpected, and the sweep must fail rather than quietly skip a command.
    fn command_name_of(decl: &str) -> Option<&str> {
        // `split("fn ")` is safe against a generic bound like `F: Fn(u8)`: that spells `Fn`, and
        // this needle is lowercase.
        let after = decl.split("fn ").nth(1)?;
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(after.len());
        let name = &after[..end];
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
    }

    /// Every `.rs` file under this crate's `src/`, recursively, sorted for a stable report.
    ///
    /// `std::fs` + a real directory walk rather than `include_str!`, which needs literal paths and
    /// is therefore a hand-maintained list — the exact shape of the opt-in this sweep replaces.
    /// Recursion is load-bearing: the dictation commands live in `dictation/commands.rs`, and the
    /// `GUARDED` table below carries a comment about a file move that broke the old guard once.
    /// A walk cannot be broken that way.
    fn rust_sources() -> Vec<std::path::PathBuf> {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let entries = std::fs::read_dir(dir)
                .unwrap_or_else(|e| panic!("cmd sweep: cannot read {}: {e}", dir.display()));
            for entry in entries {
                let path = entry.expect("cmd sweep: unreadable dir entry").path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut out = Vec::new();
        walk(&root, &mut out);
        out.sort();
        out
    }

    /// Which `EXEMPT` entries have gone stale, given what the sweep actually found
    /// (`seen`: command name -> is it async).
    ///
    /// Returns `(vanished, converted)`: names that match no command at all, and names whose
    /// command is now async. Both are failures — an exemption that outlives the command it excused
    /// is how the NEXT sync regression on that name gets waved through, and it is the exact shape
    /// the `GUARDED` opt-in's `None => panic!` arm was protecting against.
    ///
    /// A free function over its inputs rather than a block inside the sweep, so it can be driven
    /// with synthetic data and proved to fire — the sweep itself can only ever exercise the
    /// all-clean case, since a real stale entry would red the build.
    fn stale_exemptions<'a>(
        exempt: &[&'a str],
        seen: &std::collections::BTreeMap<String, bool>,
    ) -> (Vec<&'a str>, Vec<&'a str>) {
        let vanished = exempt.iter().copied().filter(|n| !seen.contains_key(*n)).collect();
        let converted = exempt.iter().copied().filter(|n| seen.get(*n) == Some(&true)).collect();
        (vanished, converted)
    }

    /// A path relative to `src/`, for messages a human has to act on.
    fn rel(path: &std::path::Path) -> String {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        path.strip_prefix(&root).unwrap_or(path).to_string_lossy().into_owned()
    }

    /// ── SYNC-COMMAND DEBT, NOT A LIST OF APPROVALS ────────────────────────────────────────────
    /// Every `#[tauri::command]` in this crate that still runs its body INLINE on the AppKit main
    /// thread. The sweep below fails on any sync command NOT named here, so this list is the
    /// complete, visible inventory of the `sparkle-rfhu5` debt rather than a set of commands
    /// anyone decided were fine.
    ///
    /// It started at 100 entries the day it was written — out of 330 distinct commands in the
    /// crate — and that size is the point: the guard it replaced was an 8-name OPT-IN, so a
    /// command was covered only if someone remembered to add it. That is exactly how
    /// `frontend_log`, the highest-frequency command in the app at 90K-145K invokes/day, sat sync
    /// and unguarded while the guard reported green. Inverting it makes the debt countable and
    /// makes every NEW sync command an argument someone has to make out loud.
    ///
    /// RULES:
    ///   * Adding a name here is a deliberate act. Prefer converting the command to
    ///     `pub async fn` + `tauri::async_runtime::spawn_blocking` — that is the fix, this is the
    ///     acknowledgement that it has not been done yet.
    ///   * REMOVING a name is what converting a command looks like. The sweep fails on a stale
    ///     entry — one naming a command that is now async, or one naming no command at all — so an
    ///     exemption cannot outlive the command it excused and go on hiding the next regression.
    ///   * Keyed by NAME, never by file, so moving a command between files cannot silently break
    ///     coverage the way it once broke `GUARDED`.
    ///   * Sorted and deduplicated; the sweep asserts that, so entries land in a reviewable place
    ///     instead of being appended wherever the diff was smallest.
    ///
    /// A handful here are permanently sync ON PURPOSE — `watchdog_heartbeat` is two relaxed atomic
    /// stores and is documented as the cheapest possible command precisely so it can never
    /// contribute to the stall it watches for. They are not distinguished from real debt, because
    /// the sweep's job is to make every sync body visible, and a per-entry rationale field would
    /// invite writing one for the ones that need converting too.
    const EXEMPT: &[&str] = &[
        "accounts_add",
        "accounts_import_default",
        "accounts_mark_exhausted",
        "accounts_remove",
        "accounts_set_nickname",
        "app_version",
        "append_concierge_guideline",
        "append_note",
        "chief_pat",
        "chief_pat_secure_clear",
        "chief_pat_secure_get",
        "chief_pat_secure_set",
        "claude_chat_cancel",
        "clear_window_roster",
        "concierge_cancel",
        "concierge_guidelines_path",
        "concierge_lint_log",
        "config_file_paths",
        "conflict_clear_flag",
        "conflict_flags",
        "conflict_probe_status",
        "control_mcp_paths",
        "control_respond",
        "copy_capture_asset",
        "desktop_bearer_token",
        "desktop_begin_signin",
        "desktop_has_token",
        "desktop_sign_out",
        "desktop_take_pending_deeplink",
        "display_layout",
        "fit_window_to_current_display",
        "flush_crash_reports",
        "get_audio_input_settings",
        "get_config",
        "get_frontmost",
        "get_helper_vitals",
        "get_roster",
        "github_default_project_dir",
        "hide_capture_window",
        "hide_helper",
        "is_capture_open",
        "log_dir",
        "notify_attention",
        "notify_frontend_shown",
        "nudger_clear_flag",
        "nudger_flags",
        "nudger_send_escape",
        "orchestration_respond",
        "orchestrator_mcp_paths",
        "plugin_install_outcomes",
        "pr_claim_release",
        "pr_claim_set",
        "pr_claims_list",
        "pty_ack",
        "pty_live_epoch",
        "pty_live_sessions",
        "pty_resize",
        "pty_set_paused",
        "pty_write",
        "publish_helper_vitals",
        "publish_window_roster",
        "quit_app",
        "read_concierge_guidelines",
        "read_config_text",
        "read_prd",
        "refresh_preflight",
        "reset_config",
        "reset_window_size",
        "reveal_logs",
        "set_allow_virtual_input",
        "set_audio_input",
        "set_config_value",
        "set_config_values",
        "set_helper_bounds",
        "set_helper_menu_state",
        "set_project_config_value",
        "set_project_window_bounds",
        "set_stage_definition",
        "set_window_attention",
        "show_capture_window",
        "show_helper",
        "show_main_window",
        "span_window",
        "sparkle_improve_cancel",
        "sparkle_improve_run",
        "start_concierge_control_bridge",
        "start_control_bridge",
        "start_orchestration_bridge",
        "stop_control_bridge",
        "stop_orchestration_bridge",
        "support_metadata",
        "trial_start",
        "trial_status",
        "unset_config_value",
        "unset_project_config_value",
        "watchdog_heartbeat",
        "write_concierge_guidelines",
        "write_config_text",
        "write_prd",
    ];

    /// Every command moved off the main thread, by the file that owns it. Adding a conversion?
    /// Add it here, or nothing stops the next refactor putting it back on the UI thread.
    const GUARDED: &[(&str, &str, &[&str])] = &[
        (
            include_str!("hooks.rs"),
            "hooks.rs",
            &["read_events_since", "install_agent_hooks", "heal_agent_hooks"],
        ),
        (
            include_str!("history.rs"),
            "history.rs",
            &["history_record", "history_search", "history_prune"],
        ),
        // The dictation `#[tauri::command]`s live in `dictation/commands.rs`, not `dictation.rs` —
        // they were split out of it when that file was decomposed. This entry is keyed by FILE, so
        // it has to follow them; leaving it on `dictation.rs` makes the guard fail loudly (which is
        // how the move was caught) rather than silently stop guarding.
        (
            include_str!("dictation/commands.rs"),
            "dictation/commands.rs",
            &["list_audio_inputs"],
        ),
        (include_str!("stale_build.rs"), "stale_build.rs", &["stale_build_probe"]),
        (include_str!("drag_paths.rs"), "drag_paths.rs", &["recover_drag_paths"]),
    ];

    #[test]
    fn every_converted_command_still_runs_off_the_main_thread() {
        let mut checked = 0;
        for (src, file, names) in GUARDED {
            for name in *names {
                match command_is_async(src, name) {
                    None => panic!(
                        "{file}: no `#[tauri::command]` named `{name}` — it was renamed or removed, \
                         so this guard silently stopped guarding it. Update GUARDED deliberately."
                    ),
                    Some(false) => panic!(
                        "{file}: `{name}` is a SYNC `#[tauri::command]`, so its body runs inline on \
                         the AppKit main thread and freezes the whole UI for its duration \
                         (bead sparkle-rfhu5). Make it `pub async fn` + \
                         `tauri::async_runtime::spawn_blocking`."
                    ),
                    Some(true) => checked += 1,
                }
            }
        }
        // POSITIVE assertion: "the scanner matched nothing" must fail rather than pass.
        assert_eq!(
            checked,
            GUARDED.iter().map(|(_, _, n)| n.len()).sum::<usize>(),
            "every guarded command must have been positively verified"
        );
        assert!(checked >= 8, "expected at least the 8 converted commands, verified {checked}");
    }

    /// THE SWEEP. Every `#[tauri::command]` in `src/`, not a list someone remembered to extend.
    ///
    /// `GUARDED` above is an OPT-IN, and an opt-in guard only ever guards what it was told about.
    /// It named 8 commands. The crate declares 341 `#[tauri::command]`s across 79 files — 330
    /// distinct names, 100 of them still sync — so the opt-in covered 2.4% of the surface it was
    /// written to protect. The command it did not cover included `frontend_log`, the single
    /// hottest command in the app, which froze the UI on the main thread 90K-145K times a day
    /// while this guard reported green for its entire existence. This test inverts the default:
    /// sync is a FAILURE, and `EXEMPT` is the visible cost of the ones not yet fixed.
    #[test]
    fn every_tauri_command_is_async_or_explicitly_exempt() {
        // The exemption list is reviewed by humans, so make it reviewable.
        let mut sorted = EXEMPT.to_vec();
        sorted.sort_unstable();
        assert_eq!(
            EXEMPT,
            sorted.as_slice(),
            "EXEMPT must be sorted, so an addition lands where a reviewer expects it"
        );
        let mut deduped = sorted.clone();
        deduped.dedup();
        assert_eq!(
            sorted.len(),
            deduped.len(),
            "EXEMPT has a duplicate entry — two exemptions for one command hide a removal"
        );

        // name -> is_async. A name declared in two files is async only if EVERY declaration is;
        // an exemption is keyed by name, so the pessimistic fold is the safe one.
        let mut seen: std::collections::BTreeMap<String, bool> = std::collections::BTreeMap::new();
        let mut offenders: Vec<String> = Vec::new();
        let mut checked = 0usize;
        let mut files_with_commands = 0usize;

        for path in rust_sources() {
            let src = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("cmd sweep: cannot read {}: {e}", path.display()));
            let decls = command_decls(&src);
            if decls.is_empty() {
                continue;
            }
            files_with_commands += 1;
            for decl in decls {
                let name = command_name_of(decl).unwrap_or_else(|| {
                    panic!(
                        "{}: a `#[tauri::command]` attribute is followed by `{}`, which has no \
                         `fn <name>` — the sweep cannot tell what command that is, so it must not \
                         pass. Fix the declaration or the walk in `command_decls`.",
                        rel(&path),
                        decl.trim()
                    )
                });
                // Reuse the named scanner rather than reading asyncness off `decl` here: one
                // answer, from one parser, for both halves of this guard.
                let is_async = command_is_async(&src, name).unwrap_or_else(|| {
                    panic!(
                        "{}: `command_is_async` cannot find `{name}` that `command_decls` just \
                         reported — the two halves of the scanner disagree.",
                        rel(&path)
                    )
                });
                checked += 1;
                seen.entry(name.to_string())
                    .and_modify(|a| *a &= is_async)
                    .or_insert(is_async);
                if !is_async && !EXEMPT.contains(&name) {
                    offenders.push(format!("  {}: {name}", rel(&path)));
                }
            }
        }

        // ANTI-VACUITY. A walk that finds nothing — wrong root, a `read_dir` that stopped at the
        // first subdirectory, an attribute spelling that stopped matching — must FAIL, not report
        // a clean sweep. Floors rather than exact counts so ordinary churn does not red the build;
        // both are far below the real figures (~330 commands across ~90 files) and far above zero.
        assert!(
            checked >= 200,
            "the sweep found only {checked} `#[tauri::command]`s — this crate has ~330, so the \
             walk or the attribute match is broken and every assertion below it is worthless"
        );
        assert!(
            files_with_commands >= 10,
            "the sweep found commands in only {files_with_commands} file(s) — the directory walk \
             is not recursing"
        );

        // A stale exemption is how a converted command's excuse outlives it and goes on hiding the
        // next regression, so both stale shapes are failures.
        let (vanished, converted) = stale_exemptions(EXEMPT, &seen);
        assert!(
            vanished.is_empty(),
            "EXEMPT names {} command(s) that no longer exist: {vanished:?}. They were renamed or \
             removed, so those exemptions guard nothing — delete them.",
            vanished.len()
        );
        assert!(
            converted.is_empty(),
            "EXEMPT names {} command(s) that are now ASYNC: {converted:?}. The debt was paid — \
             remove them, or the exemption silently re-permits a revert to sync.",
            converted.len()
        );

        assert!(
            offenders.is_empty(),
            "{} `#[tauri::command]`(s) are SYNC and not in EXEMPT, so their bodies run inline on \
             the AppKit main thread and freeze the whole UI for their duration (bead \
             sparkle-rfhu5):\n{}\n\nFix: make each `pub async fn` + \
             `tauri::async_runtime::spawn_blocking`. If it genuinely must stay sync, add its name \
             to EXEMPT — deliberately, and read that list's header comment first.",
            offenders.len(),
            offenders.join("\n")
        );
    }

    /// `HistoryDb` is managed CONDITIONALLY — `lib.rs` skips `manage` when the DB fails to open,
    /// because that must not stop the app booting. `Manager::state` PANICS when a type was never
    /// managed, and that panic (inside `spawn_blocking`, caught by tokio) still passes through
    /// `crash.rs`'s chained hook and writes an uploadable crash record. `history_record` runs on
    /// every prompt and response, so the regression is a false crash report per capture — from a
    /// feature that is supposed to degrade silently. `try_state` is the whole fix, so pin it.
    #[test]
    fn history_resolves_its_db_without_panicking_when_it_was_never_managed() {
        let src = include_str!("history.rs");
        assert!(
            src.contains("try_state::<HistoryDb>()"),
            "history must resolve its DB with `try_state` — `state` panics when the DB failed to \
             open at boot, and lib.rs manages it conditionally"
        );
        assert!(
            !src.contains("app.state::<HistoryDb>()"),
            "`app.state::<HistoryDb>()` panics when the DB was never managed; use `try_state`"
        );
    }

    /// Moving `install_agent_hooks` and `heal_agent_hooks` off the main thread ENABLED concurrency
    /// that never existed: while both were sync commands the main thread serialized them, so their
    /// read→modify→write of the same `settings.local.json` could not interleave. `atomic_write_settings`
    /// stops a torn read, not a LOST UPDATE. Pin that both RMW sites take the write lock.
    #[test]
    fn both_settings_read_modify_write_sites_take_the_write_lock() {
        let src = include_str!("hooks.rs");
        let takes = src.matches("settings_write_lock(&").count();
        assert!(
            takes >= 2,
            "expected both the install and heal read-modify-write sites to take \
             `settings_write_lock`, found {takes} call(s) — a lost update silently reverts a heal"
        );
    }

    /// ANTI-VACUITY. If the scanner cannot tell a sync command from an async one, the test above
    /// passes no matter what the code says. `watchdog_heartbeat` is the right anchor: it is
    /// deliberately, permanently sync — two relaxed atomic stores, documented as "the cheapest
    /// possible command" precisely so it can never contribute to the stall it watches for — so it
    /// will still be sync long after every conversion above has landed.
    #[test]
    fn the_scanner_reports_a_genuinely_sync_command_as_sync() {
        assert_eq!(
            command_is_async(include_str!("watchdog.rs"), "watchdog_heartbeat"),
            Some(false),
            "the scanner must detect a sync command, or the guard above proves nothing"
        );
    }

    /// The other half of anti-vacuity: a name that does not exist must be `None`, not `Some(true)`.
    #[test]
    fn the_scanner_reports_a_missing_command_as_missing() {
        assert_eq!(command_is_async(include_str!("history.rs"), "no_such_command_here"), None);
    }

    /// The paren/angle anchor matters: without it, `fn read_events_since_confined` (the sync core)
    /// would satisfy a naive `contains("fn read_events_since")` and the guard would pass while the
    /// real command was sync.
    #[test]
    fn the_scanner_does_not_match_a_longer_name_with_the_same_prefix() {
        let src = "#[tauri::command]\npub fn thing_sync(x: u8) {}\n";
        assert_eq!(command_is_async(src, "thing"), None, "`thing` must not match `thing_sync`");
        assert_eq!(command_is_async(src, "thing_sync"), Some(false));
    }

    /// ANTI-VACUITY FOR THE SWEEP'S NAME EXTRACTOR. The sweep can only ever assert the all-clean
    /// case, so the piece that decides WHICH command a declaration is has to be pinned directly.
    /// If this returned `None` for real declarations the sweep would panic rather than pass, but
    /// if it returned the WRONG name it would exempt-match against a name nobody wrote and let a
    /// sync command through silently.
    #[test]
    fn the_name_extractor_reads_the_command_identifier_off_a_declaration() {
        assert_eq!(command_name_of("pub fn frontend_log(entry: FrontendLog) {"), Some("frontend_log"));
        assert_eq!(command_name_of("pub async fn history_record(app: AppHandle) {"), Some("history_record"));
        // Generic commands are the common shape in `logging.rs`; the angle bracket terminates the
        // identifier just as the paren does.
        assert_eq!(command_name_of("pub fn app_version<R: Runtime>(app: AppHandle<R>) -> String {"), Some("app_version"));
        assert_eq!(command_name_of("pub(crate) async fn scoped_thing() {"), Some("scoped_thing"));
        // `Fn` in a bound must not be mistaken for the `fn` keyword — the needle is lowercase.
        assert_eq!(command_name_of("pub fn takes_a_closure<F: Fn(u8)>(f: F) {"), Some("takes_a_closure"));
        // No `fn` at all: the walk landed somewhere unexpected and the sweep must fail, not skip.
        assert_eq!(command_name_of("pub struct NotACommand {"), None);
    }

    /// ANTI-VACUITY FOR THE STALENESS RULE. This is the property the old `GUARDED` table bought
    /// with its `None => panic!` arm, and the sweep would report it as green forever if the rule
    /// were inverted or dropped — a clean EXEMPT list produces empty vectors either way.
    #[test]
    fn a_stale_exemption_is_reported_whether_the_command_vanished_or_was_converted() {
        let seen = std::collections::BTreeMap::from([
            ("still_sync".to_string(), false),
            ("now_async".to_string(), true),
        ]);
        let (vanished, converted) =
            stale_exemptions(&["gone_entirely", "now_async", "still_sync"], &seen);
        assert_eq!(vanished, vec!["gone_entirely"], "a name matching no command must be reported");
        assert_eq!(converted, vec!["now_async"], "an exemption for an async command must be reported");
        // …and a genuinely-still-sync exemption must NOT be, or the sweep could never be green.
        let (v, c) = stale_exemptions(&["still_sync"], &seen);
        assert!(v.is_empty() && c.is_empty(), "a live exemption must not be flagged stale");
    }

    /// The sweep's whole reason for existing: `frontend_log` is the highest-frequency command in
    /// the app (90K-145K invokes/day from `logger.ts`) and the 8-name opt-in never covered it.
    /// Pin it by name so a revert to `pub fn` is named in the failure, not just counted.
    #[test]
    fn frontend_log_the_hottest_command_in_the_app_is_off_the_main_thread() {
        assert_eq!(
            command_is_async(include_str!("logging.rs"), "frontend_log"),
            Some(true),
            "`frontend_log` sinks every frontend log line; sync, it dispatches a full `tracing` \
             event through both redacting sink layers INLINE on the AppKit main thread, tens of \
             thousands of times a day (bead sparkle-rfhu5)"
        );
        assert!(
            !EXEMPT.contains(&"frontend_log"),
            "`frontend_log` must never be exempted — it is the command this sweep was built for"
        );
    }

    /// Doc comments between the attribute and the declaration are the norm in this crate — every
    /// command converted above has one — so skipping them is load-bearing, not cosmetic.
    #[test]
    fn the_scanner_sees_past_doc_comments_and_stacked_attributes() {
        let src = "#[tauri::command]\n/// docs\n/// more docs\n#[allow(dead_code)]\npub async fn documented(a: u8) {}\n";
        assert_eq!(command_is_async(src, "documented"), Some(true));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tests share one process-global table, so they must not run interleaved. Rust runs tests
    /// in threads by default; this serializes the ones that touch the table.
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        static G: OnceLock<Mutex<()>> = OnceLock::new();
        G.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn records_calls_total_and_max() {
        let _g = guard();
        reset();
        set_enabled(true);
        record("alpha", Duration::from_micros(100), true);
        record("alpha", Duration::from_micros(300), true);
        let rows = snapshot();
        let (_, s) = rows.iter().find(|(n, _)| n == "alpha").expect("alpha recorded");
        assert_eq!(s.calls, 2);
        assert_eq!(s.total_us, 400);
        assert_eq!(s.max_us, 300, "max must be the peak, not the last or the mean");
        assert_eq!(s.mean_us(), 200);
        set_enabled(false);
    }

    /// The on-main count is the claim every conclusion rests on, so it must track the flag rather
    /// than mirroring `calls`. Hardcoding `on_main_calls = calls` would pass a test that only ever
    /// passed `true`.
    #[test]
    fn on_main_calls_counts_only_main_thread_samples() {
        let _g = guard();
        reset();
        set_enabled(true);
        record("beta", Duration::from_micros(10), true);
        record("beta", Duration::from_micros(10), false);
        record("beta", Duration::from_micros(10), false);
        let rows = snapshot();
        let (_, s) = rows.iter().find(|(n, _)| n == "beta").expect("beta recorded");
        assert_eq!(s.calls, 3);
        assert_eq!(s.on_main_calls, 1, "only the sample flagged on-main may count");
        set_enabled(false);
    }

    /// Disarmed is genuinely disarmed — otherwise a normal build pays for the map on every invoke.
    #[test]
    fn disabled_records_nothing() {
        let _g = guard();
        reset();
        set_enabled(false);
        record("gamma", Duration::from_micros(999), true);
        assert!(
            !snapshot().iter().any(|(n, _)| n == "gamma"),
            "a disarmed probe must not accumulate"
        );
    }

    /// The ranking IS the deliverable — the report is read top-down to decide what to fix — so the
    /// order is asserted, not left to HashMap iteration order.
    #[test]
    fn snapshot_ranks_by_total_main_thread_cost_descending() {
        let _g = guard();
        reset();
        set_enabled(true);
        record("cheap_but_hot", Duration::from_micros(10), true);
        for _ in 0..100 {
            record("cheap_but_hot", Duration::from_micros(10), true);
        }
        record("expensive_but_rare", Duration::from_micros(500), true);
        let rows = snapshot();
        assert_eq!(
            rows.first().map(|(n, _)| n.as_str()),
            Some("cheap_but_hot"),
            "1010us of hot calls must outrank a single 500us call — frequency is the point"
        );
        set_enabled(false);
    }

    #[test]
    fn reset_clears_rows_and_the_dropped_counter() {
        let _g = guard();
        reset();
        set_enabled(true);
        record("delta", Duration::from_micros(5), true);
        assert!(!snapshot().is_empty());
        reset();
        assert!(snapshot().is_empty(), "reset must clear the table");
        assert_eq!(dropped(), 0);
        set_enabled(false);
    }

    /// A sample taken while the table is held must be DROPPED AND COUNTED, never waited on. This is
    /// the property that keeps the instrument from becoming a main-thread staller itself.
    #[test]
    fn a_contended_record_drops_the_sample_instead_of_blocking() {
        let _g = guard();
        reset();
        set_enabled(true);
        let held = stats().lock().unwrap_or_else(|e| e.into_inner());
        let before = dropped();
        // If this blocked, the test would deadlock here rather than fail — which is itself the
        // signal, since a hang is exactly the production symptom.
        record("epsilon", Duration::from_micros(1), true);
        assert_eq!(dropped(), before + 1, "a contended sample must be counted as dropped");
        drop(held);
        assert!(
            !snapshot().iter().any(|(n, _)| n == "epsilon"),
            "the dropped sample must not have been recorded"
        );
        set_enabled(false);
    }

    #[test]
    fn json_escapes_quotes_and_control_characters() {
        assert_eq!(json_str("a\"b"), "\"a\\\"b\"");
        assert_eq!(json_str("a\nb"), "\"a\\nb\"");
        assert_eq!(json_str("a\\b"), "\"a\\\\b\"");
    }

    #[test]
    fn json_reports_the_dropped_count_so_loss_is_never_silent() {
        let _g = guard();
        reset();
        set_enabled(true);
        record("zeta", Duration::from_micros(7), true);
        let out = to_json("after");
        assert!(out.contains("\"label\": \"after\""));
        assert!(out.contains("\"dropped_samples\":"), "loss must be visible in the artifact");
        assert!(out.contains("\"command\": \"zeta\""));
        assert!(out.contains("\"on_main_calls\": 1"));
        set_enabled(false);
    }

    /// An unknown main thread must read as "not main" rather than defaulting to true — the report's
    /// central claim must never be manufactured by a missing initialization.
    #[test]
    fn on_main_thread_is_false_when_the_main_thread_was_never_noted() {
        // `note_main_thread` may have been called by another test in this binary; only assert the
        // unset case when it genuinely is unset.
        if MAIN_THREAD.get().is_none() {
            assert!(!on_main_thread(), "an uncaptured main thread must not read as on-main");
        }
    }
}
