mod accounts;
mod ai;
mod attachments;
mod attention;
mod audio;
mod auth;
mod bridge;
mod chief;
mod claude;
mod cloud;
mod connectivity;
mod dictation;
mod history;
mod hooks;
mod logging;
mod model;
mod naming;
mod preflight;
mod pty;
mod transcribe;
mod screenshot;
mod socket;
mod sparkle_agent;
mod transcript;
mod worktree;
mod notes;

use pty::PtyManager;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(PtyManager::default())
        .manage(dictation::DictationState::default())
        .manage(bridge::BridgeManager::default())
        .manage(auth::DeepLinkPending::default())
        .manage(attention::BadgeCounts::default())
        .manage(accounts::AccountsLock::default())
        // Gate mic capture on window focus (sparkle-9oz6): Sparkle must not capture audio while the
        // user is looking at another app. Every Focused event is handed to the dictation state, which
        // releases the OS mic when no Sparkle window is the active OS window and rebuilds it on return.
        // Focus *loss* is coalesced (note_focus_event) so switching between two Sparkle windows — where
        // macOS emits the old window's resignKey before the new window's becomeKey — keeps the mic live.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                let app = window.app_handle();
                app.state::<dictation::DictationState>()
                    .note_focus_event(&app, *focused);
            }
        })
        .setup(|app| {
            // Stand up unified logging before anything else so startup itself is captured.
            match logging::init(&app.handle()) {
                Ok(dir) => tracing::info!(
                    version = %app.package_info().version,
                    log_dir = %dir.display(),
                    "Sparkle starting"
                ),
                // Logging is best-effort: a failure here must not stop the app from booting.
                Err(e) => eprintln!("failed to initialize logging: {e}"),
            }
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
                            if let Ok(mut g) = pending.0.lock() {
                                *g = Some(s.clone());
                            }
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            preflight::claude_preflight,
            claude::claude_has_session,
            claude::agent_session_title,
            screenshot::capture_screen_region,
            attachments::load_attachment,
            attachments::copy_image_to_clipboard,
            attachments::copy_file_to,
            attachments::copy_files_to_dir,
            worktree::ensure_project_repo,
            worktree::create_agent_worktree,
            worktree::create_worker_worktree,
            worktree::remove_agent_worktree,
            worktree::move_project,
            worktree::assert_workspace_integrity,
            worktree::install_worktree_guard,
            hooks::install_agent_hooks,
            hooks::read_events_since,
            worktree::project_default_branch,
            worktree::agent_branch_status,
            worktree::agent_workflow_state,
            worktree::land_agent_branch,
            worktree::markdown_changed_since,
            worktree::refresh_agent_branch,
            worktree::read_worker_result,
            sparkle_agent::ensure_sparkle_repo,
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
            notes::append_note,
            notes::create_bead,
            notes::write_prd,
            notes::list_beads,
            notes::bead_show,
            notes::create_bead_full,
            notes::bead_dep_add,
            notes::bead_label,
            ai::anthropic_chat,
            history::history_record,
            history::history_search,
            history::history_prune,
            transcript::read_transcript_last_assistant,
            auth::desktop_has_token,
            auth::desktop_sign_out,
            auth::desktop_exchange_code,
            auth::desktop_me,
            auth::desktop_consume,
            auth::desktop_refund,
            auth::desktop_redeem_promo,
            auth::desktop_take_pending_deeplink,
            attention::set_window_attention,
            attention::notify_attention,
            accounts::accounts_list,
            accounts::accounts_add,
            accounts::accounts_set_nickname,
            accounts::accounts_remove,
            accounts::accounts_import_default,
            accounts::accounts_mark_exhausted,
            accounts::accounts_usage
        ])
        .build(tauri::generate_context!())
        .expect("error while building Sparkle")
        .run(|app, event| match event {
            // macOS: clicking the Dock icon when all windows are hidden/closed ("Reopen") must
            // bring a window back — otherwise a last-window "keep agents running" hide is
            // unreachable except via Cmd+Q (see multi-window design, decision #4).
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
