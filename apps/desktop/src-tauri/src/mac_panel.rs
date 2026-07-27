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
    fn sparkle_round_panel_corners(ns_window: *mut std::ffi::c_void, radius: f64);
}

/// The helper island's corner radius, in points. Must match the CSS `borderRadius` the webview
/// paints inside it (see HelperIsland.tsx) — if the two drift you get a visible seam where the
/// square webview corner meets the rounded window edge.
pub const HELPER_CORNER_RADIUS: f64 = 12.0;

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

/// Round a panel's corners and give it a drop shadow, so a floating pill reads as a pill rather
/// than a rectangle. Used together with the window's `transparent(true)` — rounding alone clips
/// the content while an opaque window still paints its corners. See objc/panel.m. No-op off macOS.
pub fn round_panel_corners(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        match win.ns_window() {
            // SAFETY: same contract as make_nonactivating_panel — `ns_window()` yields a live
            // `NSWindow*` valid for the window's lifetime; the helper only sets layer properties
            // on it and its content view.
            Ok(ptr) => unsafe { sparkle_round_panel_corners(ptr, HELPER_CORNER_RADIUS) },
            Err(e) => tracing::warn!("mac_panel: ns_window() unavailable, panel stays square: {e}"),
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
