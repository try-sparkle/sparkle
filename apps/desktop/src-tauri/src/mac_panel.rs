//! Non-activating-panel helpers for the menu-bar popover and the capture takeover window.
//!
//! On macOS these reclass the window to a non-activating `NSPanel` (see `objc/panel.m`) so it
//! floats over the user's front app and is clickable/typeable WITHOUT `activateIgnoringOtherApps`
//! — the whole point is that clicking Capture (or opening the popover) never raises Sparkle's
//! windows over what the user was about to capture. Off macOS these fall back to today's Tauri
//! behavior so Windows/Linux are unchanged.

use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
extern "C" {
    fn sparkle_make_nonactivating_panel(ns_window: *mut std::ffi::c_void);
    fn sparkle_present_panel_key(ns_window: *mut std::ffi::c_void);
}

/// Convert a window into a non-activating `NSPanel`. Call ONCE, right after the window is built.
/// No-op off macOS (the non-activating semantics are a Cocoa concept).
pub fn make_nonactivating_panel(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        match win.ns_window() {
            // SAFETY: `ns_window()` yields a live `NSWindow*` valid for the window's lifetime; the
            // helper only reclasses it (object_setClass) and sets style/collection flags on it.
            Ok(ptr) => unsafe { sparkle_make_nonactivating_panel(ptr) },
            Err(e) => tracing::warn!("mac_panel: ns_window() unavailable, window stays activating: {e}"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = win;
}

/// Order the window front + make it key WITHOUT activating the app (macOS). Off macOS, falls back
/// to Tauri's `set_focus()` so existing behavior is preserved.
pub fn present_key(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        match win.ns_window() {
            // SAFETY: same contract as above; the helper calls `makeKeyAndOrderFront:` on a
            // non-activating panel, which does not activate the app.
            Ok(ptr) => unsafe { sparkle_present_panel_key(ptr) },
            // Best-effort fallback: an app-activating focus is still better than no focus at all.
            Err(e) => {
                tracing::warn!("mac_panel: ns_window() unavailable, falling back to set_focus(): {e}");
                let _ = win.set_focus();
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = win.set_focus();
}
