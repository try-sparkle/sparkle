mod accounts;
mod ai;
mod attachments;
mod attention;
mod attention_summary;
mod audio;
mod auth;
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
mod cloud;
mod crash;
mod config;
mod connectivity;
mod delivery;
mod dictation;
mod github;
mod history;
mod hooks;
mod judge;
mod logging;
mod mac_panel;
mod model;
mod model_catalog;
mod naming;
mod preflight;
mod pty;
mod transcribe;
mod screenshot;
mod setup;
mod socket;
mod sparkle_agent;
mod sparkle_improve;
mod support;
mod transcript;
mod tray;
mod trial;
mod trial_remote;
mod worktree;
mod notes;

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
        .plugin(tauri_plugin_positioner::init())
        .manage(PtyManager::default())
        .manage(claude_chat::ClaudeChatManager::default())
        .manage(sparkle_improve::SparkleImproveManager::default())
        .manage(dictation::DictationState::default())
        .manage(bridge::BridgeManager::default())
        .manage(bridge::ControlBridgeManager::default())
        .manage(auth::DeepLinkPending::default())
        .manage(auth::PendingSignIn::default())
        .manage(attention::BadgeCounts::default())
        .manage(accounts::AccountsLock::default())
        .manage(trial::TrialLock::default())
        .manage(tray::TrayState::default())
        // Gate mic capture on window focus (sparkle-9oz6): Sparkle must not capture audio while the
        // user is looking at another app. Every Focused event is handed to the dictation state, which
        // releases the OS mic when no Sparkle window is the active OS window and rebuilds it on return.
        // Focus *loss* is coalesced (note_focus_event) so switching between two Sparkle windows — where
        // macOS emits the old window's resignKey before the new window's becomeKey — keeps the mic live.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                let app = window.app_handle();
                app.state::<dictation::DictationState>()
                    .note_focus_event(app, *focused);
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
            // Stand up the local history store (prompts + responses, FTS5) in the app-data dir.
            // A failure here must not stop the app from booting — capture/search just won't work.
            match app.path().app_data_dir() {
                Ok(dir) => match history::HistoryDb::new(&dir) {
                    Ok(db) => {
                        app.manage(db);
                    }
                    Err(e) => tracing::error!("history DB init failed: {e}"),
                },
                Err(e) => tracing::error!("app_data_dir for history: {e}"),
            }
            // Editable TOML config: load the global config.toml and watch it for live reload.
            // Best-effort — a failure here must not stop the app; the engine falls back to
            // built-in defaults (config::current_effective() returns defaults when never loaded).
            if let Err(e) = config::init_and_watch(app.handle()) {
                tracing::error!("config init/watch failed: {e}");
            }
            if let Err(e) = tray::init_tray(app.handle()) {
                tracing::error!("tray init failed: {e}");
            }
            // Hidden transparent capture window (menu-bar capture flow). Best-effort:
            // a failure only loses the capture feature, never blocks boot.
            if let Err(e) = capture_window::init_capture_window(app.handle()) {
                tracing::error!("capture window init failed: {e}");
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
                                    tray::toggle_popover(app);
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notify_frontend_shown,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_set_paused,
            preflight::claude_preflight,
            preflight::claude_version,
            preflight::claude_session_info,
            preflight::refresh_preflight,
            preflight::node_preflight,
            preflight::git_preflight,
            preflight::prereqs_preflight,
            setup::install_node,
            setup::install_claude_code,
            setup::install_git,
            claude_chat::claude_chat_send,
            claude_chat::claude_chat_cancel,
            sparkle_improve::sparkle_improve_run,
            sparkle_improve::sparkle_improve_cancel,
            claude::claude_has_session,
            claude::claude_latest_session_id,
            claude::agent_session_title,
            model_catalog::list_claude_models,
            screenshot::capture_screen_region,
            attachments::load_attachment,
            attachments::copy_image_to_clipboard,
            attachments::copy_file_to,
            attachments::copy_files_to_dir,
            worktree::ensure_project_repo,
            worktree::prewarm_spawn,
            worktree::warm_worktree_pool,
            worktree::create_agent_worktree,
            worktree::create_worker_worktree,
            worktree::remove_agent_worktree,
            worktree::move_project,
            worktree::assert_workspace_integrity,
            worktree::install_worktree_guard,
            hooks::install_agent_hooks,
            hooks::heal_agent_hooks,
            hooks::read_events_since,
            worktree::project_default_branch,
            worktree::agent_branch_status,
            worktree::agent_workflow_state,
            worktree::project_agents_status,
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
            sparkle_agent::ensure_sparkle_repo,
            sparkle_agent::reap_secondary_sparkle_worktrees,
            github::github_status,
            github::github_list_repos,
            github::github_clone_repo,
            github::github_default_project_dir,
            dictation::start_dictation,
            dictation::stop_dictation,
            dictation::start_cloud_stream,
            dictation::stop_cloud_stream,
            logging::app_version,
            logging::log_dir,
            logging::reveal_logs,
            logging::frontend_log,
            naming::generate_agent_name,
            connectivity::probe_connectivity,
            chief::chief_pat,
            bridge::start_orchestration_bridge,
            bridge::stop_orchestration_bridge,
            bridge::orchestration_respond,
            bridge::orchestrator_mcp_paths,
            bridge::start_control_bridge,
            bridge::stop_control_bridge,
            bridge::control_respond,
            bridge::control_mcp_paths,
            notes::append_note,
            notes::create_bead,
            notes::write_prd,
            notes::read_prd,
            notes::copy_capture_asset,
            notes::list_beads,
            notes::bead_show,
            notes::create_bead_full,
            notes::bead_dep_add,
            notes::bead_label,
            notes::delete_bead,
            notes::bead_claim,
            notes::bead_close,
            ai::anthropic_chat,
            judge::judge_turn_followup,
            history::history_record,
            history::history_search,
            history::history_prune,
            transcript::read_transcript_last_assistant,
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
            support::support_chat_send,
            support::desktop_create_ticket,
            support::desktop_list_tickets,
            attention::set_window_attention,
            attention::notify_attention,
            attention_summary::summarize_attention,
            accounts::accounts_list,
            accounts::accounts_add,
            accounts::accounts_set_nickname,
            accounts::accounts_remove,
            accounts::accounts_import_default,
            accounts::accounts_mark_exhausted,
            accounts::accounts_usage,
            accounts::accounts_identities,
            accounts::claude_signed_in,
            trial::trial_status,
            trial::trial_start,
            trial::trial_increment,
            trial_remote::trial_remote_status,
            trial_remote::trial_remote_consume,
            config::get_config,
            config::config_file_paths,
            config::set_config_value,
            config::set_config_values,
            config::write_config_text,
            config::reset_config,
            config::read_config_text,
            config::set_stage_definition,
            delivery::collect_delivery_evidence,
            delivery::tag_contains_commit,
            tray::publish_window_roster,
            tray::clear_window_roster,
            tray::get_tray_roster,
            tray::set_tray_image,
            tray::quit_app,
            capture_window::show_capture_window,
            capture_window::hide_capture_window
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
                if !has_visible_windows {
                    // Prefer the canonical "main" window; fall back to any window. Our close path
                    // only ever hide()s the last window (never destroys it), so there is normally
                    // ≥1 window to reveal; the `if let Some` still guards the zero-window case.
                    let win = app
                        .get_webview_window("main")
                        .or_else(|| app.webview_windows().into_values().next());
                    if let Some(win) = win {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
            // Stop dictation capture before the process tears down (). RunEvent::Exit
            // fires as the event loop leaves, BEFORE the static-destructor / exit() phase where a
            // still-live CoreAudio callback otherwise raced teardown and aborted ().
            // Dropping the cpal stream here quiesces the audio IOThread first. Idempotent, so a
            // no-active-capture exit is a cheap no-op.
            tauri::RunEvent::Exit => {
                app.state::<dictation::DictationState>().stop_capture();
            }
            _ => {}
        });
}
