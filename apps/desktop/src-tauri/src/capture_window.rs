//! The hidden `capture` window — a transparent, borderless, always-on-top takeover that
//! renders the voice-narrated screenshot modal (React app at `?view=capture`).
//!
//! Created once at startup (mirroring the tray popover in tray.rs) and only ever
//! shown/hidden. `show_capture_window` sizes + positions it to fill the monitor the
//! cursor is on, shows + focuses it, then hands the shot to the webview over the
//! `capture://shot` event. Transparency requires the `macos-private-api` tauri feature
//! (enabled in Cargo.toml + tauri.conf.json for this window; other windows are opaque
//! and unaffected).
//!
//! Key-focus contract (dictation is focus-gated): borderless windows CAN become key
//! under tao — its NSWindow subclass overrides `canBecomeKeyWindow` via the `focusable`
//! flag (default true) — and `set_focus()` does `makeKeyAndOrderFront` +
//! `activateIgnoringOtherApps`, so `show()` → `set_focus()` makes this window key even
//! when Sparkle is in the background.
//!
//! Spec: docs/superpowers/specs/2026-07-01-menubar-capture-design.md §3.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const CAPTURE_LABEL: &str = "capture";

/// Focus-retry contract: the retry loop runs `FOCUS_RETRY_TICKS` times at
/// `FOCUS_RETRY_INTERVAL` apart (the warn below derives its duration from these —
/// change them together, the message stays honest).
const FOCUS_RETRY_TICKS: u32 = 8;
const FOCUS_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// Monotone show generation: bumped by every `show_capture_window`. A retry thread
/// captures its generation at spawn and exits the moment a newer show supersedes it,
/// so a quick hide→re-show never leaves two threads fighting over `set_focus`.
static SHOW_GEN: AtomicU64 = AtomicU64::new(0);
/// The show generation during which the window was last observed key (via the real
/// `Focused(true)` window event, or a poll reading). Once `FOCUSED_GEN >= gen` the
/// retry loop stops permanently for that show: "keyed, then the user deliberately
/// switched away" must never be answered with another `activateIgnoringOtherApps`.
static FOCUSED_GEN: AtomicU64 = AtomicU64::new(0);

/// One captured screenshot, as produced by `capture_screen_region()` (screenshot.rs).
/// camelCase so the wire shape is `{ path, dataUrl }` — a cross-worker contract with the
/// frontend (plan Task 2/3); do not rename.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureShot {
    pub path: String,
    pub data_url: String,
}

/// Create the hidden capture window. Called once in setup, after `init_tray`.
pub fn init_capture_window(app: &AppHandle) -> tauri::Result<()> {
    let win = WebviewWindowBuilder::new(
        app,
        CAPTURE_LABEL,
        WebviewUrl::App("index.html?view=capture".into()),
    )
    .title("Sparkle Capture")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .build()?;
    // Latch key-status per show: the event is authoritative (a 250ms poll can miss a
    // key-then-Cmd+Tab that fits inside one tick), and the retry loop reads the latch.
    win.on_window_event(|event| {
        if matches!(event, tauri::WindowEvent::Focused(true)) {
            FOCUSED_GEN.store(SHOW_GEN.load(Ordering::SeqCst), Ordering::SeqCst);
        }
    });
    Ok(())
}

/// Fill the monitor the cursor is on (fall back to primary), show + focus the window,
/// then deliver the shot to the capture webview.
#[tauri::command]
pub fn show_capture_window(app: AppHandle, shot: CaptureShot) -> Result<(), String> {
    let win = app
        .get_webview_window(CAPTURE_LABEL)
        .ok_or_else(|| "capture window does not exist".to_string())?;

    // Size/position while still hidden so the takeover never flashes at a stale rect.
    // Fill the monitor's WORK AREA, not its full bounds: macOS clamps a normal-level window's
    // origin below the menu bar anyway (observed: a full-size window gets pushed down and
    // overhangs the screen bottom by the menu-bar height), so the work area is what a
    // borderless window can actually occupy. Monitor lookup is best-effort: a failure just
    // keeps the window's previous rect.
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|pos| app.monitor_from_point(pos.x, pos.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let area = m.work_area();
        let _ = win.set_position(PhysicalPosition::new(area.position.x, area.position.y));
        let _ = win.set_size(area.size);
    }

    win.show().map_err(|e| format!("show capture window: {e}"))?;
    // Makes the window KEY (dictation acceptance criterion): makeKeyAndOrderFront +
    // activateIgnoringOtherApps under the hood, so keystrokes land here immediately.
    win.set_focus()
        .map_err(|e| format!("focus capture window: {e}"))?;
    // Becoming key is asynchronous, and macOS focus-stealing prevention can swallow the
    // one-shot activation when another app is being interacted with at that instant
    // (observed in dev smoke: one run keyed on the first try, one never keyed). Retry
    // briefly on a helper thread. The retry exists ONLY to compensate for a swallowed
    // initial activation: it stops permanently once this show has been key at least once
    // (FOCUSED_GEN latch — never wrestle a user who deliberately switched away), and it
    // exits when a newer show supersedes it (SHOW_GEN).
    let gen = SHOW_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let win = win.clone();
        std::thread::spawn(move || {
            for _ in 0..FOCUS_RETRY_TICKS {
                std::thread::sleep(FOCUS_RETRY_INTERVAL);
                if SHOW_GEN.load(Ordering::SeqCst) != gen
                    || FOCUSED_GEN.load(Ordering::SeqCst) >= gen
                    || !win.is_visible().unwrap_or(false)
                {
                    return;
                }
                if win.is_focused().unwrap_or(false) {
                    FOCUSED_GEN.store(gen, Ordering::SeqCst);
                    return;
                }
                let _ = win.set_focus();
            }
            // One more interval so the LAST set_focus gets checked before we complain —
            // otherwise a retry that lands on the final tick is reported as a failure.
            std::thread::sleep(FOCUS_RETRY_INTERVAL);
            if SHOW_GEN.load(Ordering::SeqCst) == gen
                && FOCUSED_GEN.load(Ordering::SeqCst) < gen
                && win.is_visible().unwrap_or(false)
                && !win.is_focused().unwrap_or(false)
            {
                tracing::warn!(
                    "capture window did not acquire key focus within {}ms of show",
                    FOCUS_RETRY_INTERVAL.as_millis() as u64 * (FOCUS_RETRY_TICKS as u64 + 1)
                );
            }
        });
    }
    app.emit_to(CAPTURE_LABEL, "capture://shot", &shot)
        .map_err(|e| format!("emit capture://shot: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn hide_capture_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(CAPTURE_LABEL) {
        win.hide().map_err(|e| format!("hide capture window: {e}"))?;
    }
    Ok(())
}
