//! Getting back INTO Sparkle when no real window is on screen.
//!
//! The main window's close path only ever `hide()`s it (never destroys it) so agents keep running,
//! which means "the app is running but you cannot see it" is a normal, reachable state. There must
//! always be a way out of it, and since the menu-bar extra was deleted with the tray there are
//! exactly two:
//!
//!   1. The macOS Dock icon (`RunEvent::Reopen`, wired in lib.rs).
//!   2. The floating island's right-click → **Open Sparkle** (`show_main_window` below).
//!
//! Two routes on purpose. The Dock icon is the documented one but is invisible as an affordance
//! from inside the island; the menu item is discoverable from the only Sparkle UI still on screen.
//! Both land here so they cannot drift apart.

use tauri::{AppHandle, Manager};

/// Reveal and focus a real Sparkle window, preferring the canonical `main`.
///
/// The fallback deliberately filters out the helper/capture panels: `show()`ing a non-activating
/// panel does not bring the user into the app, so falling back to one would look like the reveal
/// silently failed. With no app window at all there is nothing to reveal and this is a no-op.
pub fn reveal(app: &AppHandle) {
    let win = app.get_webview_window("main").or_else(|| {
        app.webview_windows()
            .into_iter()
            .find(|(label, _)| crate::frontmost::is_app_window(label))
            .map(|(_, w)| w)
    });
    if let Some(win) = win {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// The island's right-click → "Open Sparkle". Unlike `show_helper`, this one DOES activate the
/// app: the user just asked to be taken to it.
#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    reveal(&app);
}

/// Should a macOS Dock-icon click reveal a window?
///
/// Pure, and it takes `os_has_visible_windows` explicitly in order to IGNORE it — that discard is
/// the whole fix, so it is asserted rather than merely commented. AppKit counts our always-on-top
/// panels, and the helper island is visible exactly when Sparkle is NOT frontmost, which is the
/// state a user is in when they reach for the Dock icon. So the OS flag is reliably `true` there
/// and the guard built on it short-circuited: with the main window hidden (its close path only
/// hides), the Dock icon did nothing at all.
pub fn should_reveal_on_reopen(os_has_visible_windows: bool, app_window_visible: bool) -> bool {
    let _ = os_has_visible_windows;
    !app_window_visible
}

#[cfg(test)]
mod tests {
    use super::should_reveal_on_reopen;
    use crate::frontmost::{is_app_window, CAPTURE_LABEL, HELPER_LABEL};

    #[test]
    fn reopen_reveals_even_when_appkit_says_a_window_is_visible() {
        // THE regression. The main window is hidden ("keep agents running"), the island is on
        // screen because Sparkle is backgrounded, and AppKit therefore reports
        // hasVisibleWindows: YES. The Dock icon must still reopen the app.
        assert!(should_reveal_on_reopen(true, false));
        // …and it must do so whatever the OS flag says, since a panel is the only thing that can
        // make the two disagree.
        assert!(should_reveal_on_reopen(false, false));
    }

    #[test]
    fn reopen_is_a_no_op_when_a_real_window_is_already_up() {
        // The guard still has to exist: clicking the Dock icon with the app on screen must not
        // re-show and re-focus a window the user is already using.
        assert!(!should_reveal_on_reopen(true, true));
        assert!(!should_reveal_on_reopen(false, true));
    }

    #[test]
    fn the_reveal_fallback_never_selects_a_panel() {
        // `reveal` needs an AppHandle, but the choice it makes is this predicate: with `main`
        // absent, showing the island or the takeover instead would leave the user still outside
        // the app while looking like the command worked.
        let labels = [HELPER_LABEL, CAPTURE_LABEL, "win-2"];
        let picked: Vec<&str> = labels.into_iter().filter(|l| is_app_window(l)).collect();
        assert_eq!(picked, vec!["win-2"]);
    }
}
