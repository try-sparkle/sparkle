mod account_ledger;
mod account_usage;
mod accounts;
mod agent_goal_record;
mod agent_life;
mod ai;
/// The native menu bar. Carries "View → Hide/Show Helper", which is the guaranteed way back for a
/// dismissed helper island — the menu bar is the one surface that cannot itself be hidden.
mod app_menu;
mod asset_serving;
mod attachments;
mod attention;
mod attention_summary;
mod audio;
mod audio_devices;
mod auth;
mod auto_send_tuner;
/// The durable one-driver-per-PR lease behind auto-dispatch of `/babysit-pr` (bead sparkle-5gxom).
/// NOT `pr_claims` — that is explicitly a courtesy, not a lock. See the module docs.
mod babysit_lease;
/// File-time duplicate detection for the app's own `bd create` paths, and — the part that matters —
/// the ARGV-LEVEL SKIP LIST that keeps it away from the auto-filed beads a fold would corrupt.
/// See `docs/bead-dedupe-contract.md` §6 and the module docs.
mod bead_dup;
mod beads_cmd;
/// Recovering the paths of a drag whose Tauri event carried none — wry reads only the deprecated
/// `NSFilenamesPboardType`, so a modern-only drag source drops silently. See the module docs.
mod drag_paths;
/// Opt-in tokenmaxxing (Builder Index) reporting — default-off, consent-gated (bead sparkle-s3g2.6).
mod builder_index;
mod straude;
// The orchestration bridge is built on a Unix-domain socket (std::os::unix::net), so the real
// implementation is Unix-only. On Windows we compile a stub with the same public surface
// (BridgeManager + the four tauri commands) that reports the feature as unavailable; porting the
// transport to a Windows named pipe / localhost TCP is a Phase-2 follow-up (see the Windows port
// design doc). lib.rs and every caller stay platform-agnostic.
#[cfg(unix)]
mod bridge;
#[cfg(not(unix))]
#[path = "bridge_windows.rs"]
mod bridge;
mod capture_window;
mod chief;
mod claude;
mod claude_chat;
/// One-shot text inference on the user's own Claude Code subscription, via their authenticated
/// `claude` CLI. Replaces the server-side `/ai/anthropic` proxy that `ai.rs` used to own.
mod claude_oneshot;
mod cloud;
mod cmd_timing;
mod crash;
mod ipc_ring;
mod ipc_trace;
mod config;
mod connectivity;
mod delivery;
mod demotion;
mod deps_bootstrap;
mod dev_identity;
mod dictation;
mod display_span;
mod fleet;
mod gh_rest;
mod folder_picker;
mod frontmost;
mod github;
mod history;
mod helper;
mod hooks;
/// The identity-epoch ledger backing `accounts.rs`' identity-keyed ceilings.
mod identity_log;
mod inbox;
mod judge;
mod key_window;
mod knightwatch;
mod logging;
mod mac_panel;
mod main_thread_bench;
mod main_window;
mod memwatch;
mod mic_permission;
mod model;
mod model_catalog;
mod naming;
mod onepassword;
mod pr_claims;
mod pr_dismissal;
mod pr_owner;
mod retro_receipt;
mod preflight;
/// The live in-app browser preview's dev-server supervisor.
mod preview;
/// Preview "agent eyes" — headless-browser screenshot + DOM query over an already-open preview.
/// Phase 3 of `docs/live-browser-preview.md`; additive to `preview`, never touches its registry.
mod preview_capture;
/// Guard pinning the loopback `frame-src` the live browser preview depends on, plus the reserved
/// port set that keeps a preview frame from being same-origin with the app document.
mod preview_csp;
mod proc;
mod promotion;
mod project_window;
mod pty;
mod pty_write_watch;
/// The publish destination's MCP client — the outbound JSON-RPC calls and the HTTP-200
/// `isError` decoder that keeps a failed publish from reading as a successful one.
mod publish_client;
/// The publish destination's bearer token, in the OS keychain (bead `sparkle-131ms.3`).
mod publish_credential;
/// Publish-destination URL validation — TLS required, loopback exempt, no userinfo.
mod publish_url;
mod redacting_writer;
mod repo_freshness;
/// The background research runner behind "Concierge Agents" (bead `sparkle-s7rfc`) — dispatches a
/// read-only `claude` child and returns before it finishes.
mod research;
mod retention;
mod revival;
mod pipeline_health;
mod review_cmd;
mod roborev_account;
mod roborev_probe;
mod transcribe;
mod screenshot;
mod window_screenshot;
mod setup;
mod socket;
mod sparkle_agent;
mod sparkle_improve;
mod spend;
mod stale_build;
mod support;
mod transcript;
mod roster;
mod trial;
mod trial_remote;
mod watchdog;
mod worktree;
mod notes;
mod nudge_gate;
mod nudge_ladder;
mod nudger;
// The deterministic conflicting/stale-PR detector (bead sparkle-zss67). Same two-file split as the
// nudger above and for the same reason: `conflict_ladder` is the pure decision, `conflict_watch`
// owns the thread, the `gh` probe and the flags. Neither makes a model call on any path.
mod conflict_ladder;
mod conflict_watch;
mod concierge;
mod concierge_guidelines;
mod concierge_inbox;
mod mention;
mod concierge_lint_log;
mod webview_drop_gate;

use pty::PtyManager;
use tauri::{Emitter, Manager};

/// Set once the frontend has completed its first `show()` on first paint (see main.tsx). The
/// show-on-ready backstop thread reads this to distinguish "frontend never booted" (show it) from
/// "frontend showed it, then the user hid it to the tray" (leave it hidden). See the setup hook.
static FRONTEND_SHOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Invoked by the frontend right after it reveals the main window on first paint. Marks the
/// show-on-ready handshake complete so the Rust last-resort backstop stands down.
#[tauri::command]
fn notify_frontend_shown() {
    FRONTEND_SHOWN.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // BEFORE the event loop, before anything opens a window: the Builder Index dry run. It is a
    // diagnostic, not a feature — it computes exactly the payload the reporter would POST and
    // prints it, WITHOUT a network call, a keychain read, or a state write. That combination is
    // the point: proving Sparkle's collection matches the client it is meant to replace must not
    // require publishing anything, because the leaderboard's primary key makes a published row
    // permanent. See `builder_index::dry_run`.
    if let Some(args) = builder_index::dry_run_args(std::env::args().skip(1)) {
        println!("{}", builder_index::dry_run(&args));
        return;
    }
    // Capture the main thread's identity HERE, on the main thread, before the event loop starts.
    // `cmd_timing` compares against it to report whether a command body actually ran on the main
    // thread rather than inferring it from the macro's source — see that module's header.
    cmd_timing::note_main_thread();
    // Which WebKit `WebContent` processes already existed BEFORE we made one. HERE, before the
    // builder, because the only thing that separates our renderer from the nine other apps' — they
    // all have `ppid=1` and a byte-identical command line — is that ours appears after this line.
    // The watchdog takes the matching "after" snapshot on the webview's first heartbeat, so a hang
    // capture can sample the process the heartbeat actually came from. See watchdog.rs.
    watchdog::note_webcontent_baseline();
    if cmd_timing::init_from_env() {
        tracing::info!(target: "perf", "per-command main-thread timing armed (SPARKLE_CMD_TIMING)");
    }
    tauri::Builder::default()
        // The app menu. `app_menu::build` starts from Tauri's platform default and only INSERTS
        // into it — setting any menu here REPLACES the default outright, and a hand-rolled one that
        // forgot the Edit submenu would silently take ⌘X/⌘C/⌘V/⌘A away from the whole app.
        .menu(app_menu::build)
        .on_menu_event(app_menu::on_menu_event)
        // ── OUR `ipc:` PROTOCOL SHADOWS TAURI'S. THIS IS THE APP'S IPC PATH. ──────────────────
        // Tauri registers its own `ipc` handler only `if !registered_scheme_protocols.contains(…)`
        // (tauri-2.11.3 `src/manager/webview.rs:280`), and builder protocols are pushed into that
        // list at `:230` — before the check. So this line, and nothing else, decides which handler
        // every invoke in the app goes through.
        //
        // WHY: Tauri hands the protocol handler a responder that fires at COMMAND COMPLETION for
        // async commands as well as sync ones. `cmd_timing::measure` (still wired below, still
        // useful for main-thread occupancy) cannot see that instant — for the 232 async commands it
        // measures only the dispatch hop. See `ipc_trace`'s header.
        //
        // ALWAYS ON, deliberately: an opt-in probe is disarmed at exactly the moment it is needed.
        // The killswitch is `ipc_trace_set_enabled` — config, not a compile gate.
        .register_asynchronous_uri_scheme_protocol("ipc", ipc_trace::ipc_protocol)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        // Auto-updater (poll signed GitHub Releases manifest + install) and process (relaunch into
        // the staged update). The frontend updaterService drives both; pubkey/endpoints live in
        // tauri.conf.json. See apps/desktop/UPDATER-SETUP.md for the signing-key/CI setup.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(PtyManager::default())
        .manage(claude_chat::ClaudeChatManager::default())
        .manage(sparkle_improve::SparkleImproveManager::default())
        .manage(concierge::ConciergeManager::default())
        .manage(dictation::DictationState::default())
        .manage(bridge::BridgeManager::default())
        .manage(bridge::ControlBridgeManager::default())
        .manage(auth::DeepLinkPending::default())
        .manage(auth::PendingSignIn::default())
        .manage(attention::BadgeCounts::default())
        .manage(accounts::AccountsLock::default())
        .manage(trial::TrialLock::default())
        .manage(roster::RosterState::default())
        // The deterministic nudger's per-session observers and its raised flags. Both are managed
        // state rather than module statics so `pty.rs` can reach them from a command signature and
        // so a test can stand one up in isolation.
        .manage(nudger::Observers::default())
        .manage(nudger::NudgeFlags::default())
        // The conflicting/stale-PR detector's raised flags. Managed state for the same reasons the
        // nudger's are: the watcher thread reaches them from an `AppHandle`, the frontend PULLS
        // them with `conflict_flags`, and a test can stand one up in isolation.
        .manage(conflict_watch::ConflictFlags::default())
        // The due-for-resurrection list, republished once a second by `revival::start`. Managed for
        // the same reason the nudger's state is: the timer thread reaches it from an `AppHandle`,
        // and `services/resurrectionRunner` PULLS it with `revival_due` rather than the sweep
        // re-deriving the ledger itself on the main thread.
        .manage(revival::RevivalState::default())
        .manage(frontmost::FrontmostState::default())
        .manage(helper::HelperVitals::default())
        // PR claims live in the Rust process, not a window store, so an agent's "I am landing this
        // myself" is visible from EVERY window — including whichever one answers the concierge.
        .manage(pr_claims::PrClaims::default())
        // Live browser previews this launch owns. Managed state rather than a module static so the
        // supervisor threads reach it from an `AppHandle` and a stop can find the child to signal.
        .manage(preview::PreviewManager::default())
        // Every Focused event feeds TWO consumers, both of which need the same blur coalescing
        // because macOS emits the outgoing window's resignKey BEFORE the incoming window's
        // becomeKey:
        //   - dictation (sparkle-9oz6): Sparkle must not capture audio while the user is looking at
        //     another app, so this releases the OS mic when no Sparkle window is the active OS
        //     window and rebuilds it on return. Coalescing keeps the mic live across an
        //     internal window switch.
        //   - frontmost (spec §4.6): drives the floating helper island's visibility. Coalescing
        //     stops the island flashing on during an internal window switch.
        .on_window_event(|window, event| {
            // A real OS drag-drop is the ONLY trustworthy signal that the user chose a file: the
            // paths come from the window server, not from the webview. Recording them here is what
            // lets `load_attachment` read a file the containment rule would otherwise refuse — a
            // `.txt` dragged from `/private/tmp` used to be accepted by the UI and then silently
            // discarded (bead sparkle-zviq). See attachments.rs' provenance note.
            //
            // Enter and Drop are DIFFERENT claims, and conflating them is a security bug: Enter
            // fires for any drag crossing this window, including one headed for another app, so a
            // durable grant there would let a file merely dragged PAST Sparkle be read for the life
            // of the process. Enter is provisional (cleared on Leave), Drop is consent. Registering
            // on Enter at all is what removes the race with the JS event, which Tauri emits before
            // it runs this listener. See attachments.rs' tier note.
            // EVERY decision — which drag phase grants what, and that a destroyed window drops the
            // hovers it owned — lives in `attachments::note_window_event`. Nothing is decided here,
            // deliberately: as match arms at this call site no test could reach them, and both times
            // a rule lived here it could be silently deleted with the suite still green.
            attachments::note_window_event(window.label(), event);
            if let tauri::WindowEvent::Focused(focused) = event {
                let app = window.app_handle();
                let label = window.label();
                // TWO filters, not one — the consumers ask different questions (frontmost.rs).
                // The routing itself lives in `frontmost::focus_consumers` so it can be unit-tested
                // as a value: the predicates were never the bug, the dispatch was, and a test that
                // hand-feeds `is_typing_window`/`is_app_window` cannot see which one is wired where.
                //
                // Dictation wants "can the caret be in Sparkle", which INCLUDES the capture
                // takeover: it is a deliberately key-accepting panel and CaptureApp mounts
                // useAmbientVoice, so dropping its focus events here left the mic permanently
                // unbuilt and voice narration in the takeover dead on every invocation.
                //
                // The HELPER is filtered from both, and must stay that way (sparkle-9oz6): it is a
                // non-activating panel, so letting it through to dictation would resume microphone
                // capture the moment the user clicked the floating island while working in another
                // app — a worse failure than the island's own.
                // A THIRD consumer, and deliberately not folded into `focus_consumers`: it asks a
                // different question from either of those two. They decide app BEHAVIOUR (release
                // the mic, hide the island); this one only RECORDS, so that an app-wide input
                // freeze can be diagnosed from the log file afterwards (bead sparkle-thm9o). It is
                // the one signal that survives a wedged webview, because the webview is what it
                // exists to check on — see key_window.rs.
                key_window::note_focus(label, *focused);
                let consumers = frontmost::focus_consumers(label);
                if consumers.dictation {
                    app.state::<dictation::DictationState>()
                        .note_focus_event(app, *focused);
                }
                // The island's visibility wants "is a REAL Sparkle window frontmost". The takeover
                // is shown WITHOUT activating the app, so it must not count here.
                if consumers.frontmost {
                    frontmost::note_focus_event(
                        app,
                        &app.state::<frontmost::FrontmostState>(),
                        *focused,
                    );
                }
            }
        })
        .setup(|app| {
            // Stand up unified logging before anything else so startup itself is captured.
            match logging::init(app.handle()) {
                Ok(dir) => tracing::info!(
                    version = %app.package_info().version,
                    log_dir = %dir.display(),
                    "Sparkle starting"
                ),
                // Logging is best-effort: a failure here must not stop the app from booting.
                Err(e) => eprintln!("failed to initialize logging: {e}"),
            }
            // Install crash/panic capture immediately after logging (before any other init) so a
            // panic or fatal signal during startup itself is still captured. The panic hook CHAINS
            // to the existing hook (audio.rs' catch_unwind firewall is unchanged); the native signal
            // handler catches crashes a panic hook can't (e.g. a CoreAudio abort). Always-on and
            // best-effort — it only writes to the user's own disk here; upload is consent-gated in
            // the `flush_crash_reports` command.
            crash::install(app.handle());
            // Supply the `prepareForDragOperation:` override wry leaves unimplemented, so a file
            // released over a TERMINAL is delivered at all. Without it AppKit stops the drag after
            // the hover phase for any drop outside a natively-droppable element, which is why the
            // terminal painted its drop affordance and then swallowed the release, silently, from
            // 2026-07-30 until this landed. See webview_drop_gate for the full mechanism.
            webview_drop_gate::install(app.handle());
            // Watch for monitors being plugged/unplugged so a window spanned across displays can be
            // re-fitted instead of stranded at a geometry no remaining display can show.
            display_span::start_display_watch(app.handle().clone());
            // Reconcile research tasks a previous launch left mid-flight. A task that was `queued`
            // or `running` when the app exited keeps that status on disk forever — its control
            // lived only in the old process — so without this the sidebar's `+[n]` is permanently
            // inflated by every interrupted pass and nothing ever drains it (this module opts out
            // of `retention::reap_inbox` deliberately, and cancel needs a human to notice). A deep
            // pass runs up to 15 minutes, so a restart landing inside one is ordinary.
            if let Ok(app_data) = crate::worktree::app_data_dir_pub(app.handle()) {
                let n = research::reconcile_interrupted(&app_data);
                if n > 0 {
                    tracing::info!(count = n, "research: reconciled tasks interrupted by a restart");
                }
            }
            // Reclaim preview dev servers a previous launch left behind. This is the PRIMARY orphan
            // path, not a backstop: managed state leaks on the ordinary Cmd+Q path, so a hard kill
            // leaves the child running with nothing else that would ever stop it. It verifies the
            // full (pid, pgid, start-time) triple before signalling anything — see preview.rs.
            preview::init(app.handle());
            // Auth hand-off: forward an incoming sparkle://auth?code=… deep link to the webview
            // as a "deep-link" event; AuthGate redeems the one-time code (spec §3.1, §8).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let s = url.to_string();
                        // Stash it for the cold-launch case (webview listener not yet attached),
                        // then emit for the warm (already-running) case.
                        if let Some(pending) = handle.try_state::<auth::DeepLinkPending>() {
                            // Poison-tolerant: a panic elsewhere must not silently drop the
                            // cold-launch auth code (which would make sign-in impossible).
                            *pending.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(s.clone());
                        }
                        let _ = handle.emit("deep-link", s);
                    }
                });
            }
            // Attribute notifications to Sparkle's bundle id (best-effort; see attention.rs).
            attention::init_application();
            // Watch the main thread from OFF the main thread, so a wedge can be reported while it
            // is still happening. Started early: the stalls worth catching include startup ones,
            // and nothing here depends on the rest of setup succeeding (see watchdog.rs).
            watchdog::start(app.handle());
            // The deterministic non-LLM nudger (sparkle-a94sr). Started next to the watchdog and
            // for the same reason: it is a plain OS thread that must be running before anything
            // it observes, and it depends on nothing else in setup. It makes NO model call on any
            // path, which is the whole point — it is what remains when a provider-wide 529 has
            // taken out every agent, the concierge, and the pusher at once.
            nudger::start(app.handle());
            // The conflicting/stale-PR detector (sparkle-zss67). Same category as the nudger above
            // and started beside it for the same reason: a plain OS thread that makes NO model call
            // on any path, so a provider-wide 529 can never blind us to a PR that has gone DIRTY —
            // and therefore, since GitHub never fires `pull_request` for one, UNTESTED.
            conflict_watch::start(app.handle());
            // SEAL THE PREVIOUS LAUNCH'S UNCLOSED RECORDS, SYNCHRONOUSLY, BEFORE ANYTHING ELSE CAN
            // READ THEM.
            //
            // App restart is the largest single killer of agents in this app — 54 SessionEnd in one
            // minute on 2026-08-06 at 18:20, 49 more at 18:47 — and it is precisely the case in
            // which the WebView gets no chance to write anything down. So the death is not observed,
            // it is INFERRED here: a record still `Live` whose owning epoch is provably dead (a
            // kernel-released `flock`, not a heartbeat) becomes an `AppRestart` death.
            //
            // ON THE MAIN THREAD ON PURPOSE, which is the one place in this file that is the right
            // trade. `seal_stale_at` is documented as needing to run "BEFORE any pane mounts, so a
            // reader sees a settled record instead of racing the sealer", and a background thread
            // cannot promise that — the webview's first `agent_life_open` could land first. The cost
            // is a `read_dir` plus one small JSON parse per agent, against a directory holding one
            // file per agent this machine has ever run; the measured worst case is ~50 files.
            //
            // A record whose epoch is still ALIVE is left completely alone. That is the sleep case
            // (an `flock` is not released by suspend), and getting it wrong would seal a running
            // fleet and hand every live agent to the resurrector at once.
            match dev_identity::app_data_dir(app.handle()) {
                Ok(base) => {
                    let dir = agent_life::life_dir(&base);
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    match agent_life::seal_stale_at(
                        &dir,
                        &base,
                        babysit_lease::process_epoch(),
                        now,
                    ) {
                        Ok(stats) if stats.sealed > 0 => tracing::info!(
                            scanned = stats.scanned,
                            sealed = stats.sealed,
                            still_live = stats.still_live,
                            "agent-life: sealed records orphaned by a previous launch"
                        ),
                        Ok(stats) => tracing::debug!(
                            scanned = stats.scanned,
                            still_live = stats.still_live,
                            "agent-life: nothing to seal"
                        ),
                        Err(e) => tracing::warn!("agent-life seal failed: {e}"),
                    }
                }
                Err(e) => tracing::warn!("agent-life seal skipped (app_data_dir): {e}"),
            }
            // …and only THEN start the thread that reads what the seal just wrote. Same category as
            // the nudger and the conflict watcher above, and started beside them for the same
            // reason: a plain OS thread that makes NO model call on any path. When the wall is
            // fleet-wide every LLM in the app is behind the same account limit, so anything that
            // consults one is dead exactly when recovery is needed.
            revival::start(app.handle());
            // Stand up the local history store (prompts + responses, FTS5) in the app-data dir.
            // A failure here must not stop the app from booting — capture/search just won't work.
            match dev_identity::app_data_dir(app.handle()) {
                Ok(dir) => match history::HistoryDb::new(&dir) {
                    Ok(db) => {
                        app.manage(db);
                    }
                    Err(e) => tracing::error!("history DB init failed: {e}"),
                },
                Err(e) => tracing::error!("app_data_dir for history: {e}"),
            }
            // Reap the per-agent hook-event logs. Nothing ever deleted these, so the directory grew
            // to 606 files / 107 MB. Runs on a background thread: it stats every file in the
            // directory and must not sit in the launch path. Only reaps logs whose agent worktree is
            // GONE (and then only past an age grace); a live agent's log is size-capped, never
            // deleted. Worktrees themselves are never touched — only listed, to learn which agent
            // ids are still live.
            //
            // The same pass also reaps `<app_data>/inbox` (the Level 2 message queue). Its TTL
            // expired messages logically but never removed them, so every agent's Stop hook
            // re-parsed that agent's whole history at every turn boundary, and a spun-down worker's
            // queue lived on with nobody to drain it. Same fail-closed rule: a whole inbox is only
            // deleted when liveness is KNOWN and the agent is not in it.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let base = match dev_identity::app_data_dir(&handle) {
                        Ok(base) => base,
                        Err(e) => {
                            tracing::warn!("retention: app_data_dir: {e}");
                            return;
                        }
                    };
                    let worktrees = base.join("worktrees");
                    let now = std::time::SystemTime::now();
                    match retention::reap_hook_events(
                        &base.join("hook-events"),
                        &worktrees,
                        retention::HookEventsPolicy::default(),
                        now,
                    ) {
                        Ok(s) if s.deleted > 0 || s.truncated > 0 => tracing::info!(
                            deleted = s.deleted,
                            truncated = s.truncated,
                            mb_freed = s.bytes_freed / (1024 * 1024),
                            "hook-events retention pass complete"
                        ),
                        Ok(_) => tracing::debug!("hook-events retention: nothing to reap"),
                        Err(e) => tracing::warn!("hook-events retention failed: {e}"),
                    }
                    match retention::reap_inbox(
                        &inbox::inbox_dir(&base),
                        &worktrees,
                        retention::InboxPolicy::default(),
                        now,
                    ) {
                        Ok(s) if s.deleted > 0 || s.truncated > 0 => tracing::info!(
                            deleted = s.deleted,
                            compacted = s.truncated,
                            bytes_freed = s.bytes_freed,
                            "inbox retention pass complete"
                        ),
                        Ok(_) => tracing::debug!("inbox retention: nothing to reap"),
                        Err(e) => tracing::warn!("inbox retention failed: {e}"),
                    }
                    // Size-cap the concierge linter's violation log (concierge_lint_log.rs).
                    // TRUNCATE-ONLY, never deleted: it is the count that says whether the linter is
                    // working, and deleting it would read as "nothing left to fix". Rides this
                    // thread rather than getting its own — same stat-a-file work, and it must stay
                    // off the launch path for the same reason.
                    match retention::reap_concierge_lint_log(
                        // Through the module's own resolver, NOT base.join(LINT_LOG_FILE) (roborev
                        // 55779): two independent constructions of one path can silently
                        // diverge, and the failure is invisible — a moved file makes plain_file
                        // return None, the reap returns default stats, and the "under the cap"
                        // debug line reports healthy while the cap has stopped existing.
                        &concierge_lint_log::lint_log_path(&base),
                        retention::ConciergeLintPolicy::default(),
                    ) {
                        Ok(s) if s.truncated > 0 => tracing::info!(
                            kb_freed = s.bytes_freed / 1024,
                            "concierge lint log tail-truncated"
                        ),
                        Ok(_) => tracing::debug!("concierge lint log: under the cap"),
                        Err(e) => tracing::warn!("concierge lint log retention failed: {e}"),
                    }
                });
            }
            // Sweep the concierge's screenshot directory (`<temp>/sparkle-captures`). THE
            // DETERMINISTIC HALF of that module's retention bound: pruning only inside a capture
            // made retention a side effect of taking ANOTHER capture, so a session that
            // photographed the screen once and then went quiet left the PNG in temp forever — the
            // quiescent case, and the common one. Same background-thread treatment as the
            // hook-events reap above and for the same reason: it stats a directory.
            std::thread::spawn(window_screenshot::sweep_capture_dir);
            // Editable TOML config: load the global config.toml and watch it for live reload.
            // Best-effort — a failure here must not stop the app; the engine falls back to
            // built-in defaults (config::current_effective() returns defaults when never loaded).
            if let Err(e) = config::init_and_watch(app.handle()) {
                tracing::error!("config init/watch failed: {e}");
            }
            // Watch that dictation is actually HEARING something, and that the input device list
            // hasn't shifted under us. On 2026-07-29 a screen recorder's CoreAudio HAL plug-in left
            // capture running for nine minutes with zero frames arriving while the UI showed a
            // normal idle waveform — nothing anywhere checked whether audio existed, only whether
            // the stream had been created. Started unconditionally: it is one sleeping thread, and
            // it no-ops whenever there is no capture to watch.
            dictation::start_audio_watchdog(app.handle().clone());
            // Warm the on-device model NOW rather than on the first hold. Lazily loaded, it cost
            // 2.4-46 s (measured) at exactly the moment a push-to-talk hold needs it, so the hold
            // ended first and the utterance was never recorded — 20 times on 2026-08-09 alone.
            dictation::preload_model_in_background(app.handle().clone());
            // Hidden transparent capture window (menu-bar capture flow). Best-effort:
            // a failure only loses the capture feature, never blocks boot.
            if let Err(e) = capture_window::init_capture_window(app.handle()) {
                tracing::error!("capture window init failed: {e}");
            }
            // The floating helper island (spec §4.1). Fail-soft by contract: the app is entirely
            // usable without it, and the frontend's show path will retry later.
            if let Err(e) = helper::init_helper_window(app.handle()) {
                tracing::error!("helper window init failed: {e}");
            }
            // Global shortcut (default Ctrl+Shift+R, [capture].popover_shortcut in
            // config.toml) toggling the menu-bar popover from anywhere. Fail-soft by
            // contract: an unparseable or already-taken accelerator logs a warning and
            // the app runs without a shortcut — never a panic (spec §1/§9).
            {
                use std::str::FromStr;
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
                let accel = config::current_effective().config.capture.popover_shortcut;
                match Shortcut::from_str(accel.trim()) {
                    Ok(shortcut) => {
                        let registered =
                            app.handle().global_shortcut().on_shortcut(shortcut, |app, _, event| {
                                if event.state == ShortcutState::Pressed {
                                    // Ask the island to run the capture flow, so the shortcut and
                                    // the island's own Capture button share ONE code path instead
                                    // of drifting apart.
                                    //
                                    // Deliberately does NOT show the island first. The helper
                                    // webview stays mounted (and subscribed) even when hidden, so
                                    // capture works regardless — and showing it would resurrect a
                                    // helper the user explicitly hid, as well as putting it in the
                                    // shot the capture is about to take.
                                    let _ = app.emit("helper://capture-requested", ());
                                }
                            });
                        if let Err(e) = registered {
                            tracing::warn!(
                                "could not register [capture].popover_shortcut '{accel}' \
                                 (already taken by another app?): {e}"
                            );
                        }
                    }
                    Err(e) => tracing::warn!(
                        "[capture].popover_shortcut '{accel}' is not a valid accelerator, \
                         running without a global shortcut: {e}"
                    ),
                }
            }
            // roborev daemon startup ensure. When the user has opted into roborev ([tools].roborev)
            // AND already passed the one-time consent modal (roborev.consent_prompted), re-run the
            // idempotent install so the launchd daemon is (re)loaded after a reboot — a fresh boot
            // starts LaunchAgents, but this also self-heals a daemon that was booted-out or a binary
            // that moved. Best-effort and OFF the startup path: spawned onto the async runtime so it
            // never blocks boot; any error is swallowed (the onboarding flow surfaces install issues).
            {
                let eff = config::current_effective().config;
                if eff.tools.roborev && eff.roborev.consent_prompted {
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = setup::install_roborev(handle).await {
                            tracing::warn!(error = %e, "startup roborev ensure failed (non-fatal)");
                        }
                    });
                }
            }
            // Plugin pre-enable install ensure (bead sparkle-s3g2.1). Writing `enabledPlugins` into
            // each worktree does NOT fetch the plugin — Claude Code only loads one that is actually
            // installed — so run the headless, idempotent `claude plugin install` for the default-on
            // plugins. User scope, so the fetch populates the one shared plugin cache every worktree
            // reads. Ledger-gated (it no-ops once they're in), best-effort, and OFF the startup path:
            // spawned onto the async runtime so a slow network never delays boot, and any failure
            // just leaves the plugin out of the ledger for the next launch to retry.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // The command already does its own spawn_blocking, so this just awaits it.
                    // `force: None` — startup must keep the per-process retry suppression; only the
                    // user-initiated toggle bypasses it.
                    match hooks::ensure_default_plugins_installed(handle, None).await {
                        Ok(outcomes) => hooks::log_install_outcomes(&outcomes),
                        Err(e) => tracing::warn!(error = %e, "plugin pre-enable ensure failed (non-fatal)"),
                    }
                });
            }
            // Opt-in Builder Index reporter (bead sparkle-s3g2.6). Started unconditionally — the
            // loop itself re-reads `[tools].builder_index` plus the consent/credential gate on
            // every cycle and posts nothing until all of them pass, so a default install spends
            // its life asleep. Spawning it here (rather than on the toggle) means turning the
            // feature on doesn't need an app restart to take effect.
            builder_index::spawn_reporter(app.handle().clone());
            // The second reporting destination. Independent of the Builder Index in every way —
            // its own flag, sign-in and state file — and equally default-OFF: the loop re-reads
            // `[tools].straude` every cycle and skips without a socket until the user opts in.
            straude::spawn_reporter(app.handle().clone());
            // Show-on-ready backstop (bead sparkle-alrm.5, #10). The main window is created hidden
            // ("visible": false) so no blank frame flashes before React paints; the frontend calls
            // show() on first paint (see main.tsx) and then invokes `notify_frontend_shown`. This
            // thread is the last-resort net for the case the frontend NEVER boots (a fatal bundle/JS
            // error): reveal the window anyway after a grace period so a launch can never leave an
            // invisible, unreachable process. We gate on the frontend-shown FLAG, not instantaneous
            // is_visible(): a user can legitimately hide the main window to the tray within the grace
            // period (Workspace close → win.hide()), and keying off visibility would forcibly
            // re-reveal a window they deliberately hid. If the frontend ever completed its show, the
            // flag is set and we stand down.
            if let Some(win) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    if !FRONTEND_SHOWN.load(std::sync::atomic::Ordering::SeqCst) {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                });
            }
            // sparkle-i95d: rebind every persisted orchestration bridge at boot so a build agent's
            // live-worker control (spawn_worker / list_workers) survives an app restart, instead of
            // dangling on an orphaned socket until its pane happens to remount. Unix-only (the socket
            // bridge is #[cfg(unix)]); best-effort — a failure just falls back to the prior lazy-
            // rebind-on-prepare() behavior. Reuses each agent's stable token so a still-running MCP
            // client keeps validating after the rebind.
            #[cfg(unix)]
            {
                match worktree::app_data_dir_pub(app.handle()) {
                    Ok(dir) => {
                        let mgr = app.state::<bridge::BridgeManager>();
                        let n = bridge::reconcile_bridges_at(
                            Some(app.handle().clone()),
                            mgr.inner(),
                            &dir,
                        );
                        if n > 0 {
                            tracing::info!(rebound = n, "orchestration bridges reconciled at boot");
                        }
                    }
                    Err(e) => tracing::warn!("bridge reconcile skipped (app_data_dir): {e}"),
                }
            }
            Ok(())
        })
        // Wrapped rather than passed bare so every command's MAIN-THREAD occupancy is measurable.
        // For a sync command the generated body runs inline here, so the time around `handler` IS
        // the UI freeze it caused; for an async one the handler only spawns, so the same probe
        // reads the dispatch hop alone. Inert unless `SPARKLE_CMD_TIMING` is set. See `cmd_timing`.
        .invoke_handler({
            // The type is spelled out at the BINDING, not just at the call: `generate_handler!`
            // expands to a closure whose parameter type is normally inferred from the
            // `invoke_handler` call it is passed to directly, and binding it to a `let` first
            // removes that inference site. Boxing costs one dynamic dispatch per invoke, which
            // Tauri already pays — `invoke_handler` stores it as `Box::new(...)` regardless.
            #[allow(clippy::type_complexity)]
            let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
                Box::new(tauri::generate_handler![
            notify_frontend_shown,
            // ASYNC on purpose: it is read from the input-freeze trace, so it must not be able to
            // block on the main thread it exists to report on. See key_window.rs.
            key_window::main_window_key_state,
            cmd_timing::cmd_timing_report,
            // The four-point IPC timeline (bead sparkle-i7ryx). `ipc_clock_probe` must stay a
            // do-nothing command: the renderer times it NTP-style to place its own
            // `performance.now()` stamps on Rust's monotonic axis, and any work in it is
            // indistinguishable from transit delay to that estimator.
            ipc_trace::ipc_clock_probe,
            ipc_trace::ipc_trace_dump,
            ipc_trace::ipc_trace_set_enabled,
            fleet::fleet_digest,
            fleet::fleet_read_hook_stream,
            fleet::fleet_read_transcript,
            inbox::inbox_send,
            inbox::inbox_broadcast,
            inbox::inbox_status,
            inbox::inbox_peek,
            inbox::inbox_claim_for_idle,
            // "Concierge Agents" (bead sparkle-s7rfc). `research_dispatch` RETURNS BEFORE THE CHILD
            // FINISHES — that non-blocking property is the feature, and research.rs has a test
            // pinning it. The names are the contract with `RESEARCH_COMMANDS` in
            // src/services/research/store.ts. `research_tail` serves the running task's live-output
            // tail to its main-pane view.
            research::research_dispatch,
            research::research_list,
            research::research_get,
            research::research_tail,
            research::research_cancel,
            research::research_mark_read,
            folder_picker::pick_folder,
            folder_picker::pick_files,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_live_sessions,
            pty::pty_live_epoch,
            // The fleet-resurrection mount. The ledger's commands are thin wrappers over the pure
            // `*_at` cores in agent_life.rs; `revival_due` is a read of a list the revival thread
            // has already computed.
            agent_life::agent_life_open,
            agent_life::agent_life_close,
            agent_life::agent_life_note_wall,
            agent_life::agent_life_read,
            agent_life::agent_life_list,
            agent_life::agent_life_claim,
            agent_life::agent_life_release,
            agent_life::agent_life_retire,
            revival::revival_due,
            pty::pty_set_paused,
            pty::pty_ack,
            nudger::nudger_flags,
            nudger::nudger_clear_flag,
            nudger::nudger_send_escape,
            conflict_watch::conflict_flags,
            conflict_watch::conflict_clear_flag,
            conflict_watch::conflict_probe_status,
            memwatch::memory_admission,
            memwatch::agent_memory_watchdog,
            // Live browser preview. Every one is `async fn` + spawn_blocking: a plain `fn` runs
            // INLINE on the AppKit main thread and all of these touch the filesystem or a process.
            preview::preview_capability,
            preview::preview_open,
            preview::preview_stop,
            preview::preview_stop_for_agent,
            preview::preview_status,
            preview::preview_list,
            preview_capture::preview_screenshot,
            preview_capture::preview_query_dom,
            preflight::claude_preflight,
            preflight::claude_version,
            preflight::claude_session_info,
            preflight::claude_session_accounts,
            preflight::concierge_session_info,
            preflight::refresh_preflight,
            preflight::node_preflight,
            preflight::git_preflight,
            preflight::prereqs_preflight,
            preflight::roborev_preflight,
            preflight::lsp_preflight,
            preflight::project_lsp_preflight,
            // 1Password .env backup/restore — implements src/services/onepassword.ts.
            onepassword::op_preflight,
            onepassword::op_refresh,
            onepassword::op_install,
            onepassword::op_vaults,
            onepassword::env_scan,
            onepassword::op_list_backups,
            onepassword::op_backup,
            onepassword::op_restore,
            onepassword::op_seed_worktree,
            onepassword::env_dirs_exist,
            onepassword::env_seed_from_checkout,
            setup::install_node,
            setup::install_claude_code,
            setup::install_git,
            setup::install_roborev,
            setup::deactivate_roborev,
            setup::roborev_auth_selftest,
            // roborev's review QUEUE, as opposed to its install lifecycle above — the commands
            // behind the concierge's `review` domain. See review_cmd.rs.
            review_cmd::roborev_list_findings,
            review_cmd::roborev_show_finding,
            review_cmd::roborev_close_finding,
            setup::install_lsp_server,
            claude_chat::claude_chat_send,
            claude_chat::claude_chat_cancel,
            sparkle_improve::sparkle_improve_run,
            sparkle_improve::sparkle_improve_cancel,
            sparkle_improve::sparkle_improve_active,
            concierge::concierge_turn,
            concierge::concierge_cancel,
            concierge::concierge_proactive_turn,
            concierge_inbox::concierge_inbox_ack,
            // The cross-agent + human @mention channel (bead sparkle-hdlhox). `mention_send` routes a
            // mention to @improve/@sparkle: it posts the CONTENT to the bead, doorbells the target's
            // inbox (content-free), and WAKES the target — spawning a scoped @improve responder, or
            // emitting `concierge://mention` for a frontend listener to turn into an immediate
            // concierge turn. `mention_status` reads the bead's ACK so silence past a deadline reads
            // as UNDELIVERED. See mention.rs.
            mention::mention_send,
            mention::mention_ack,
            mention::mention_reply,
            mention::mention_status,
            claude::claude_has_session,
            claude::claude_latest_session_id,
            claude::claude_latest_session_path,
            claude::agent_session_title,
            model_catalog::list_claude_models,
            // Multi-display window spanning (Appearance → Window).
            display_span::display_layout,
            display_span::span_window,
            display_span::fit_window_to_current_display,
            display_span::reset_window_size,
            screenshot::capture_screen_region,
            window_screenshot::capture_main_window,
            window_screenshot::capture_main_window_region,
            drag_paths::recover_drag_paths,
            attachments::load_attachment,
            attachments::probe_attachment,
            attachments::copy_image_to_clipboard,
            attachments::copy_file_to,
            attachments::copy_files_to_dir,
            worktree::ensure_project_repo,
            worktree::install_repo_hooks_cmd,
            worktree::remove_repo_hooks_cmd,
            worktree::prewarm_spawn,
            worktree::warm_worktree_pool,
            worktree::create_agent_worktree,
            worktree::park_worktree_on_base,
            worktree::acquire_worktree_lease,
            worktree::release_worktree_lease,
            worktree::create_worker_worktree,
            worktree::remove_agent_worktree,
            worktree::move_project,
            worktree::assert_workspace_integrity,
            worktree::install_worktree_guard,
            deps_bootstrap::bootstrap_worktree_deps,
            hooks::install_agent_hooks,
            hooks::heal_agent_hooks,
            // The durable mirror of an agent's goal, for the SessionStart hook that reads it back to
            // an agent waking with no session context (docs/agent-goal-record.md).
            agent_goal_record::write_agent_goal_record,
            agent_goal_record::list_agent_goal_records,
            agent_goal_record::delete_agent_goal_record,
            hooks::ensure_default_plugins_installed,
            hooks::plugin_install_outcomes,
            hooks::read_events_since,
            worktree::project_default_branch,
            worktree::project_repo_key,
            worktree::reconcile_default_branch,
            worktree::agent_branch_status,
            repo_freshness::repo_root_staleness,
            repo_freshness::repo_fresh_read,
            repo_freshness::repo_stale_diagnose,
            repo_freshness::repo_stale_remedy,
            repo_freshness::repo_auto_fast_forward,
            worktree::diff_files,
            worktree::diff_file_text,
            worktree::diff_commits,
            worktree::agent_workflow_state,
            worktree::project_agents_status,
            worktree::project_open_pr_count,
            worktree::project_pr_list_url,
            worktree::project_open_prs,
            worktree::pr_owner,
            // The retirement gate's durable "did this agent report back" store (sparkle-0l9xk).
            // Registered in the SAME commit as the module: a missing registration only fails at
            // invoke time, and this one is read on every status poll.
            retro_receipt::retro_receipt_record,
            retro_receipt::retro_receipt_get,
            retro_receipt::retro_receipt_all,
            worktree::merge_pr,
            // The read side of the merge gate `merge_pr` enforces. Registered in the SAME commit as
            // the module: a missing registration only fails at invoke time.
            knightwatch::knightwatch_probe_gate,
            worktree::dismiss_pr,
            worktree::restore_pr,
            worktree::pr_dismissals,
            worktree::land_agent_branch,
            worktree::push_agent_branch,
            worktree::commit_worktree_wip,
            worktree::delete_agent_branch,
            worktree::delete_agent_branch_if_merged,
            worktree::open_agent_pr,
            promotion::promotion_preflight,
            promotion::promotion_head_sha,
            promotion::promotion_commit_dirty,
            promotion::promotion_push_branch,
            promotion::promotion_read_transcript,
            // Demotion's two halves. BOTH must be here: a missing registration fails at invoke
            // time, mid-demotion, with a live sandbox billing — the worst place to find out.
            demotion::demotion_land_branch,
            demotion::demotion_write_transcript,
            worktree::markdown_changed_since,
            worktree::refresh_agent_branch,
            worktree::read_worker_result,
            worktree::write_worker_manifest,
            worktree::read_worker_manifest,
            worktree::scan_worker_manifests,
            roborev_probe::roborev_branch_probe,
            roborev_probe::roborev_job_review,
            pipeline_health::pipeline_health_probe,
            pr_claims::pr_claim_set,
            pr_claims::pr_claim_release,
            pr_claims::pr_claims_list,
            // The one-driver-per-PR lease for auto-dispatched `/babysit-pr`. A neighbour of
            // `pr_claims` in the list and nothing else: a claim is a courtesy, this is a lock.
            // Registered in the SAME commit as the module — a missing registration only fails at
            // invoke time, which for a lock means the caller cannot tell "refused" from "absent".
            babysit_lease::babysit_lease_acquire,
            babysit_lease::babysit_lease_heartbeat,
            babysit_lease::babysit_lease_release,
            babysit_lease::babysit_leases,
            sparkle_agent::ensure_sparkle_repo,
            sparkle_agent::reap_secondary_sparkle_worktrees,
            sparkle_agent::sparkle_submit_capability,
            // Per-project concierge tool policy: the frontend's synchronous slug cache is filled
            // from here. Without this registration `repoSlug.ts` resolves every root to null,
            // which reads as FOREIGN and floors merge-class tools at `ask` everywhere.
            sparkle_agent::commands::repo_slug_for_root,
            github::github_status,
            github::github_list_repos,
            github::github_clone_repo,
            github::github_default_project_dir,
            dictation::commands::start_dictation,
            dictation::commands::stop_dictation,
            dictation::commands::start_cloud_stream,
            dictation::commands::stop_cloud_stream,
            dictation::commands::preconnect_cloud_stream,
            dictation::commands::list_audio_inputs,
            dictation::commands::get_audio_input_settings,
            dictation::commands::set_audio_input,
            dictation::commands::set_allow_virtual_input,
            logging::app_version,
            logging::log_dir,
            logging::reveal_logs,
            logging::frontend_log,
            naming::generate_agent_name,
            connectivity::probe_connectivity,
            chief::chief_pat,
            chief::chief_pat_secure_get,
            chief::chief_pat_secure_set,
            chief::chief_pat_secure_clear,
            // The publish destination's bearer token (bead `sparkle-131ms.3`). Same keychain
            // pattern as the Chief PAT above. An UNREGISTERED #[tauri::command] produces zero
            // compile errors and fails only at runtime, which is what
            // scripts/lib/tauri-handler-guard.sh enforces in both directions.
            publish_credential::publish_token_set,
            publish_credential::publish_token_clear,
            publish_credential::publish_token_present,
            bridge::start_orchestration_bridge,
            bridge::stop_orchestration_bridge,
            bridge::orchestration_respond,
            bridge::orchestrator_mcp_paths,
            bridge::start_control_bridge,
            bridge::start_concierge_control_bridge,
            bridge::stop_control_bridge,
            bridge::control_respond,
            bridge::control_mcp_paths,
            notes::append_note,
            notes::create_bead,
            notes::write_prd,
            notes::read_prd,
            notes::copy_capture_asset,
            notes::list_beads,
            notes::blocked_beads,
            notes::ensure_beads_db,
            notes::bead_show,
            notes::create_bead_full,
            notes::bead_dep_add,
            notes::bead_label,
            notes::bead_priority,
            notes::bead_comment,
            notes::delete_bead,
            notes::concierge_memory_remember,
            notes::concierge_memory_recall,
            notes::concierge_memory_forget,
            notes::bead_claim,
            notes::bead_close,
            // The typed/capped planning surface (services/beadsCommands.ts). Distinct from the
            // notes::* commands above, which stay the board's raw-JSON path — see beads_cmd.rs.
            beads_cmd::beads_query,
            beads_cmd::beads_detail,
            beads_cmd::beads_create,
            beads_cmd::beads_update,
            beads_cmd::beads_close,
            beads_cmd::beads_comment,
            ai::anthropic_chat,
            // The planner's model id, so the second-model advisor pass can resolve a DIFFERENT one
            // rather than hardcoding a copy of it (bead `sparkle-revqiv`).
            ai::planner_chat_model,
            judge::judge_turn_followup,
            // OUT OF BAND: called AFTER an auto-send has already gone, purely to record what Haiku
            // would have graded the utterance. It never gates a send — see auto_send_tuner's header
            // for the measured 15–27s that settles that.
            auto_send_tuner::auto_send_tuner_classify,
            history::history_record,
            history::history_search,
            history::history_prune,
            transcript::read_transcript_last_assistant,
            // Mounted-agent conversation: bounded backwards paging + incremental tailing of the
            // agent's own Claude Code JSONL transcripts.
            transcript::agent_transcript_page,
            transcript::agent_transcript_tail,
            // The session-filtered resolve for the concierge's tool read (tier d). Distinct from
            // `claude::claude_latest_session_path`, which is the unfiltered LEARN seam — see
            // `agent_own_session_path`'s doc for why they are two commands and not one with a mode.
            transcript::agent_own_session_path,
            spend::spend_report,
            builder_index::builder_index_status,
            builder_index::builder_index_set_identity,
            builder_index::builder_index_forget,
            builder_index::builder_index_report_now,
            straude::straude_status,
            straude::straude_login_begin,
            straude::straude_login_poll,
            straude::straude_consent,
            straude::straude_forget,
            straude::straude_report_now,
            auth::desktop_has_token,
            auth::desktop_bearer_token,
            auth::desktop_pair_code,
            auth::list_paired_devices,
            auth::revoke_paired_device,
            auth::desktop_sign_out,
            auth::desktop_begin_signin,
            auth::desktop_exchange_code,
            auth::desktop_me,
            auth::desktop_consume,
            auth::desktop_refund,
            auth::desktop_redeem_promo,
            auth::desktop_redeem_coupon,
            auth::desktop_topup_checkout,
            auth::desktop_credit_history,
            auth::desktop_auto_topup_get,
            auth::desktop_auto_topup_set,
            auth::desktop_take_pending_deeplink,
            crash::flush_crash_reports,
            support::read_recent_logs,
            support::support_metadata,
            stale_build::stale_build_probe,
            support::support_chat_send,
            support::desktop_create_ticket,
            support::desktop_list_tickets,
            attention::set_window_attention,
            attention::notify_attention,
            watchdog::watchdog_heartbeat,
            attention_summary::summarize_attention,
            accounts::accounts_list,
            accounts::ensure_project_trusted,
            accounts::accounts_add,
            accounts::accounts_set_nickname,
            accounts::accounts_remove,
            accounts::accounts_import_default,
            accounts::accounts_mark_exhausted,
            accounts::accounts_usage,
            accounts::accounts_spend,
            accounts::accounts_identities,
            accounts::accounts_limit_events,
            accounts::accounts_ceilings,
            accounts::claude_signed_in,
            accounts::claude_auth_status,
            account_ledger::accounts_record_spawn,
            account_ledger::accounts_spawn_log,
            account_usage::account_usage_live,
            trial::trial_status,
            trial::trial_start,
            // The hot path. `trial_increment` (a device-local bump) is deliberately GONE: the
            // counter is server-side now, so there is no JS-callable way to move it locally.
            trial_remote::trial_sync,
            trial_remote::trial_consume,
            config::get_config,
            config::config_file_paths,
            config::set_config_value,
            config::set_config_values,
            config::unset_config_value,
            config::set_project_config_value,
            config::unset_project_config_value,
            config::write_config_text,
            config::reset_config,
            config::read_config_text,
            config::set_stage_definition,
            // The concierge communication guidelines file — same read/write/reveal shape as the
            // config commands above, because it is the same kind of thing: a user-owned file the
            // app both edits in-app and injects at runtime.
            concierge_guidelines::read_concierge_guidelines,
            concierge_guidelines::write_concierge_guidelines,
            concierge_guidelines::append_concierge_guideline,
            concierge_guidelines::concierge_guidelines_path,
            // The reply linter's violation log. METADATA ONLY (never reply text, never the matched
            // span) — the constraint `services/conciergeAudit.ts` established for concierge text on
            // disk. Returns `()`: logging a violation must never be able to fail the reply path.
            concierge_lint_log::concierge_lint_log,
            delivery::collect_delivery_evidence,
            delivery::tag_contains_commit,
            roster::publish_window_roster,
            roster::clear_window_roster,
            roster::get_roster,
            roster::quit_app,
            main_window::show_main_window,
            helper::publish_helper_vitals,
            helper::get_helper_vitals,
            helper::show_helper,
            helper::hide_helper,
            helper::set_helper_bounds,
            // Pushes the island's persisted `enabled` back onto the native View menu's label. The
            // flag lives in localStorage, which Rust cannot read — the webview is the authority.
            app_menu::set_helper_menu_state,
            frontmost::get_frontmost,
            capture_window::show_capture_window,
            capture_window::hide_capture_window,
            capture_window::is_capture_open,
            project_window::open_project_window,
            project_window::set_project_window_bounds,
            project_window::close_project_window
                ]);
            move |invoke| cmd_timing::measure(invoke, &handler)
        })
        .build(tauri::generate_context!())
        .expect("error while building Sparkle")
        .run(|app, event| match event {
            // macOS: clicking the Dock icon when all windows are hidden/closed ("Reopen") must
            // bring a window back — otherwise a last-window "keep agents running" hide is
            // unreachable except via Cmd+Q (see multi-window design, decision #4).
            // `RunEvent::Reopen` is a macOS-only variant (no Dock on Windows/Linux), so the arm is
            // gated — without the cfg it's a hard compile error (E0599) off macOS.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                // IGNORE AppKit's `has_visible_windows` and ask our own windows instead. The helper
                // island and the capture takeover are real NSWindows (non-activating panels), and
                // the island is visible EXACTLY when Sparkle is not frontmost — which is the state
                // the user is in when they click the Dock icon. AppKit therefore reports YES, the
                // guard short-circuited, and the Dock icon did nothing at all once the main window
                // had been hidden. `any_app_window_visible` counts only real app windows.
                if main_window::should_reveal_on_reopen(
                    has_visible_windows,
                    frontmost::any_app_window_visible(app),
                ) {
                    main_window::reveal(app);
                }
            }
            // Stop dictation capture before the process tears down (). RunEvent::Exit
            // fires as the event loop leaves, BEFORE the static-destructor / exit() phase where a
            // still-live CoreAudio callback otherwise raced teardown and aborted ().
            // Dropping the cpal stream here quiesces the audio IOThread first. Idempotent, so a
            // no-active-capture exit is a cheap no-op.
            tauri::RunEvent::Exit => {
                app.state::<dictation::DictationState>().stop_capture();
                // Record + kill any in-flight improve pass here rather than in `Drop`: on macOS
                // this arm fires before `process::exit()`, whereas managed state is leaked (never
                // dropped) on the ordinary Cmd+Q path, so the `app-teardown` log line — and the
                // group kill that stops a detached pass from outliving the app — only actually
                // happen when driven from here. `Drop` remains an idempotent backstop.
                app.state::<sparkle_improve::SparkleImproveManager>().end_in_flight_pass();
                // Same reasoning: a scoped @mention responder is a headless `claude -p` in the
                // canonical worktree; kill it here so it can't outlive the app. The slot is a module
                // global (no managed state), so this is a free call. Idempotent when none is running.
                mention::end_in_flight_responders();
                // Same reasoning, same path: a preview's dev server is a supervised child spawned
                // OUTSIDE a PTY, so nothing else would ever stop it. `Drop` on the manager is the
                // idempotent backstop for the paths that actually drop.
                app.state::<preview::PreviewManager>().stop_all();
                // Leave the per-command main-thread table behind when the probe was armed, so a
                // measurement run does not depend on someone calling `cmd_timing_report` before
                // quitting. No-op when disarmed (the default).
                cmd_timing::log_report_on_exit();
            }
            _ => {}
        });
}
