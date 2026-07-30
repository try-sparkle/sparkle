mod accounts;
mod ai;
/// The native menu bar. Carries "View → Hide/Show Helper", which is the guaranteed way back for a
/// dismissed helper island — the menu bar is the one surface that cannot itself be hidden.
mod app_menu;
mod attachments;
mod attention;
mod attention_summary;
mod audio;
mod audio_devices;
mod auth;
mod auto_send_tuner;
mod beads_cmd;
/// Opt-in tokenmaxxing (Builder Index) reporting — default-off, consent-gated (bead sparkle-s3g2.6).
mod builder_index;
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
mod crash;
mod config;
mod connectivity;
mod delivery;
mod deps_bootstrap;
mod dev_identity;
mod dictation;
mod display_span;
mod fleet;
mod folder_picker;
mod frontmost;
mod github;
mod history;
mod helper;
mod hooks;
mod inbox;
mod judge;
mod logging;
mod mac_panel;
mod main_window;
mod memwatch;
mod mic_permission;
mod model;
mod model_catalog;
mod naming;
mod onepassword;
mod pr_claims;
mod pr_owner;
mod preflight;
mod proc;
mod project_window;
mod pty;
mod retention;
mod review_cmd;
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
mod concierge;
mod concierge_guidelines;

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
    tauri::Builder::default()
        // The app menu. `app_menu::build` starts from Tauri's platform default and only INSERTS
        // into it — setting any menu here REPLACES the default outright, and a hand-rolled one that
        // forgot the Edit submenu would silently take ⌘X/⌘C/⌘V/⌘A away from the whole app.
        .menu(app_menu::build)
        .on_menu_event(app_menu::on_menu_event)
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
        .manage(frontmost::FrontmostState::default())
        .manage(helper::HelperVitals::default())
        // PR claims live in the Rust process, not a window store, so an agent's "I am landing this
        // myself" is visible from EVERY window — including whichever one answers the concierge.
        .manage(pr_claims::PrClaims::default())
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
            // Watch for monitors being plugged/unplugged so a window spanned across displays can be
            // re-fitted instead of stranded at a geometry no remaining display can show.
            display_span::start_display_watch(app.handle().clone());
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
        .invoke_handler(tauri::generate_handler![
            notify_frontend_shown,
            fleet::fleet_digest,
            fleet::fleet_read_hook_stream,
            fleet::fleet_read_transcript,
            inbox::inbox_send,
            inbox::inbox_broadcast,
            inbox::inbox_status,
            inbox::inbox_claim_for_idle,
            folder_picker::pick_folder,
            folder_picker::pick_files,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_set_paused,
            pty::pty_ack,
            memwatch::memory_admission,
            memwatch::agent_memory_watchdog,
            preflight::claude_preflight,
            preflight::claude_version,
            preflight::claude_session_info,
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
            concierge::concierge_turn,
            concierge::concierge_cancel,
            concierge::concierge_proactive_turn,
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
            worktree::create_worker_worktree,
            worktree::remove_agent_worktree,
            worktree::move_project,
            worktree::assert_workspace_integrity,
            worktree::install_worktree_guard,
            deps_bootstrap::bootstrap_worktree_deps,
            hooks::install_agent_hooks,
            hooks::heal_agent_hooks,
            hooks::ensure_default_plugins_installed,
            hooks::plugin_install_outcomes,
            hooks::read_events_since,
            worktree::project_default_branch,
            worktree::reconcile_default_branch,
            worktree::agent_branch_status,
            worktree::diff_files,
            worktree::diff_file_text,
            worktree::diff_commits,
            worktree::agent_workflow_state,
            worktree::project_agents_status,
            worktree::project_open_pr_count,
            worktree::project_pr_list_url,
            worktree::project_open_prs,
            worktree::pr_owner,
            worktree::merge_pr,
            worktree::land_agent_branch,
            worktree::push_agent_branch,
            worktree::delete_agent_branch,
            worktree::delete_agent_branch_if_merged,
            worktree::open_agent_pr,
            worktree::markdown_changed_since,
            worktree::refresh_agent_branch,
            worktree::read_worker_result,
            worktree::write_worker_manifest,
            worktree::read_worker_manifest,
            worktree::scan_worker_manifests,
            roborev_probe::roborev_branch_probe,
            roborev_probe::roborev_job_review,
            pr_claims::pr_claim_set,
            pr_claims::pr_claim_release,
            pr_claims::pr_claims_list,
            sparkle_agent::ensure_sparkle_repo,
            sparkle_agent::reap_secondary_sparkle_worktrees,
            sparkle_agent::sparkle_submit_capability,
            github::github_status,
            github::github_list_repos,
            github::github_clone_repo,
            github::github_default_project_dir,
            dictation::start_dictation,
            dictation::stop_dictation,
            dictation::start_cloud_stream,
            dictation::stop_cloud_stream,
            dictation::list_audio_inputs,
            dictation::get_audio_input_settings,
            dictation::set_audio_input,
            dictation::set_allow_virtual_input,
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
            notes::delete_bead,
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
            judge::judge_turn_followup,
            // OUT OF BAND: called AFTER an auto-send has already gone, purely to record what Haiku
            // would have graded the utterance. It never gates a send — see auto_send_tuner's header
            // for the measured 15–27s that settles that.
            auto_send_tuner::auto_send_tuner_classify,
            history::history_record,
            history::history_search,
            history::history_prune,
            transcript::read_transcript_last_assistant,
            spend::spend_report,
            builder_index::builder_index_status,
            builder_index::builder_index_set_identity,
            builder_index::builder_index_forget,
            builder_index::builder_index_report_now,
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
        ])
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
            }
            _ => {}
        });
}
