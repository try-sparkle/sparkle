mod preflight;
mod pty;
mod socket;

use pty::PtyManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            preflight::claude_preflight
        ])
        // TODO(phase1):
        //  - deep-link handler for sparkle://oauth/callback (only if/when Anthropic
        //    permits subscription OAuth; default is BYOK)
        //  - keychain plugin for BYOK token storage
        .run(tauri::generate_context!())
        .expect("error while running Sparkle");
}
