//! The floating helper island: a small always-on-top panel that shows P0/P1 counts and a Capture
//! button whenever Sparkle is not the frontmost app (spec §4.1).
//!
//! The window is created ONCE at startup, hidden, and only ever shown/hidden and moved — the same
//! lifecycle the menu-bar popover used. `make_nonactivating_panel` is the crux: without it,
//! showing this window would call `activateIgnoringOtherApps` and raise every Sparkle window over
//! whatever the user was looking at, which is precisely the opposite of what a floating helper is
//! for.
//!
//! Vitals (the Needs-you / Running counts) are PUSHED here by the main window rather than computed
//! locally. The concierge
//! feed depends on `useRuntimeStore`, which is per-window and not persisted, so a separate webview
//! would start empty and render numbers that disagree with the app (spec §4.5).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::frontmost::HELPER_LABEL;

/// Must match ISLAND_W/ISLAND_H in src/helper/helperGeometry.ts — the size the window is BUILT at,
/// before the webview has measured anything.
///
/// These are a fallback, not the island's real footprint. The island sizes itself to its content
/// (`width: max-content`) and the frontend pushes the measured box back through `set_helper_bounds`
/// on the first layout, so this only has to be close enough that the very first frame is not
/// visibly wrong. It used to be a hard 268x44, of which ~88px was a flex spacer painting bare
/// C.deepForest across the middle of the pill.
const ISLAND_W: f64 = 196.0;
const ISLAND_H: f64 = 38.0;

/// The two status bands the island shows. `done` is deliberately absent: on a resting fleet it is
/// nearly every agent, so a permanent large number would drown the two counts that actually move.
///
/// `rename_all = "camelCase"` is load-bearing — the TS `Vitals` interface in services/helper.ts
/// reads `needsYou`, and this struct is serialized straight into the `helper://vitals-changed`
/// payload and the `get_helper_vitals` return. Drop it and the island silently renders `undefined`
/// for both counts, with no type error on either side to catch it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vitals {
    pub needs_you: u32,
    pub running: u32,
}

#[derive(Default)]
pub struct HelperVitals(pub Mutex<Vitals>);

// Free functions so the tests below can exercise the state without an AppHandle. Both recover
// from a poisoned lock (`into_inner`) rather than panicking — the convention everywhere else in
// this codebase: a panic on some unrelated thread must not permanently freeze the island's counts.
fn set_vitals(state: &HelperVitals, v: Vitals) {
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = v;
}

fn read_vitals(state: &HelperVitals) -> Vitals {
    *state.0.lock().unwrap_or_else(|e| e.into_inner())
}

/// Called by the main window whenever its concierge feed recomputes. The main window is the sole
/// authority on these numbers.
#[tauri::command]
pub fn publish_helper_vitals(app: AppHandle, state: State<HelperVitals>, needs_you: u32, running: u32) {
    let v = Vitals { needs_you, running };
    set_vitals(&state, v);
    let _ = app.emit("helper://vitals-changed", v);
}

/// Seed call for a helper webview that just started (or reloaded) and missed the last push.
#[tauri::command]
pub fn get_helper_vitals(state: State<HelperVitals>) -> Vitals {
    read_vitals(&state)
}

/// Show the island without activating Sparkle and without taking key status.
///
/// Deliberately NOT `present_key`. The island is a click-only chiclet that never needs keystrokes,
/// and it is shown precisely when the user has just switched AWAY to another app — stealing key
/// from whatever they are typing in would be exactly wrong. `show()` orders it front; the
/// always-on-top flag keeps it there.
#[tauri::command]
pub fn show_helper(app: AppHandle) {
    if let Some(win) = app.get_webview_window(HELPER_LABEL) {
        let _ = win.show();
    }
}

#[tauri::command]
pub fn hide_helper(app: AppHandle) {
    if let Some(win) = app.get_webview_window(HELPER_LABEL) {
        let _ = win.hide();
    }
}

/// Move and resize in one call. The frontend drives both together (an island→tab collapse changes
/// position AND size), and doing it in two IPC round-trips renders an intermediate frame at the
/// wrong geometry.
#[tauri::command]
pub fn set_helper_bounds(app: AppHandle, x: f64, y: f64, width: f64, height: f64) {
    use tauri::{LogicalPosition, LogicalSize};
    if let Some(win) = app.get_webview_window(HELPER_LABEL) {
        let _ = win.set_size(LogicalSize::new(width, height));
        let _ = win.set_position(LogicalPosition::new(x, y));
    }
}

/// Build the hidden helper window. Called once from `setup`. Mirrors the old tray popover's
/// builder, minus the positioner — the island remembers its own place.
pub fn init_helper_window(app: &AppHandle) -> tauri::Result<()> {
    let win = WebviewWindowBuilder::new(
        app,
        HELPER_LABEL,
        WebviewUrl::App("index.html?view=helper".into()),
    )
    .title("Sparkle Helper")
    .inner_size(ISLAND_W, ISLAND_H)
    .decorations(false)
    // A floating pill must not sit in a square opaque box. This needs Tauri's `macos-private-api`
    // feature, which IS enabled (Cargo.toml) and already relied on by the capture takeover window.
    // Combined with round_panel_corners below, the window's own corners are genuinely clear rather
    // than painted in the webview's background colour.
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .visible(false)
    .build()?;
    // MUST come immediately after build, before the window is ever shown: this reclasses it to a
    // non-activating NSPanel so showing it never raises Sparkle over the user's front app.
    crate::mac_panel::make_nonactivating_panel(&win);
    crate::mac_panel::round_panel_corners(&win);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vitals_default_to_zero() {
        assert_eq!(Vitals::default(), Vitals { needs_you: 0, running: 0 });
    }

    #[test]
    fn store_replaces_previous_vitals() {
        let state = HelperVitals::default();
        set_vitals(&state, Vitals { needs_you: 3, running: 7 });
        assert_eq!(read_vitals(&state), Vitals { needs_you: 3, running: 7 });
        // A drop back to zero must actually land — the island showing a stale "3 P0" after
        // everything is answered would be worse than showing nothing.
        set_vitals(&state, Vitals { needs_you: 0, running: 1 });
        assert_eq!(read_vitals(&state), Vitals { needs_you: 0, running: 1 });
    }

    #[test]
    fn reads_survive_a_poisoned_lock() {
        // Every other lock site in this codebase uses unwrap_or_else(|e| e.into_inner()); a panic
        // elsewhere must not brick the island into never updating again.
        let state = HelperVitals::default();
        set_vitals(&state, Vitals { needs_you: 2, running: 2 });
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.0.lock().unwrap();
            panic!("poison the mutex");
        }));
        assert!(poisoned.is_err());
        assert!(state.0.is_poisoned());
        assert_eq!(read_vitals(&state), Vitals { needs_you: 2, running: 2 });
        set_vitals(&state, Vitals { needs_you: 5, running: 6 });
        assert_eq!(read_vitals(&state), Vitals { needs_you: 5, running: 6 });
    }

    #[test]
    fn island_size_matches_the_frontend_constants() {
        // helperGeometry.ts is the source of truth for these; the window is built at that size and
        // then resized to the measured content. If you change one, change the other.
        assert_eq!(ISLAND_W, 196.0);
        assert_eq!(ISLAND_H, 38.0);
    }

    #[test]
    fn the_built_window_is_no_wider_than_the_island_it_paints() {
        // The build size is a FALLBACK for the frame before the webview reports its own box. It
        // must not reserve space the island does not use: on a transparent, always-on-top panel a
        // window wider than its content is not empty, it is a click-swallowing rectangle the user
        // can see the desktop through. 268.0 is the width that produced the reported "big block of
        // blue space in the middle" and is the specific value this guards against.
        assert!(ISLAND_W < 268.0);
    }
}
