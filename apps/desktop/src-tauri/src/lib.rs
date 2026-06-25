mod attention;
mod audio;
mod bridge;
mod chief;
mod claude;
mod connectivity;
mod dictation;
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
mod worktree;
mod notes;

use pty::PtyManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(PtyManager::default())
        .manage(dictation::DictationState::default())
        .manage(bridge::BridgeManager::default())
        .manage(attention::BadgeCounts::default())
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
            // Attribute notifications to Sparkle's bundle id (best-effort; see attention.rs).
            attention::init_application();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            preflight::claude_preflight,
            claude::claude_has_session,
            screenshot::capture_screen_region,
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
            worktree::markdown_changed_since,
            worktree::refresh_agent_branch,
            worktree::read_worker_result,
            sparkle_agent::ensure_sparkle_repo,
            dictation::start_dictation,
            dictation::stop_dictation,
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
            attention::set_window_attention,
            attention::notify_attention
        ])
        // TODO(phase1):
        //  - deep-link handler for sparkle://oauth/callback (only if/when Anthropic
        //    permits subscription OAuth; default is BYOK)
        //  - keychain plugin for BYOK token storage
        .build(tauri::generate_context!())
        .expect("error while building Sparkle")
        .run(|app, event| {
            // macOS: clicking the Dock icon when all windows are hidden/closed ("Reopen") must
            // bring a window back — otherwise a last-window "keep agents running" hide is
            // unreachable except via Cmd+Q (see multi-window design, decision #4).
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
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
        });
}
