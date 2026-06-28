//! Dock badge + native macOS notifications for agents that need your answer.
//!
//! Two halves of the same feature:
//!  - **Badge** (`set_window_attention`): the red dock-tile count of agents waiting on you.
//!    Each window reports how many of *its* agents are red; we sum across windows (the macOS
//!    dock badge is app-global) and write the total via `WebviewWindow::set_badge_count`.
//!  - **Notification** (`notify_attention`): a Notification Center banner fired the moment an
//!    agent crosses into needing you. We use `mac-notification-sys` directly (not
//!    tauri-plugin-notification) because the plugin discards click events on desktop; here a
//!    click on the banner returns `Click`, which we turn into an `attention://focus-agent`
//!    event so the UI can jump to the exact worker that asked.
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// How many notification banners may be parked at once. Each `notify_attention` blocks a thread
/// until its banner is clicked or dismissed (the OS auto-resolves lingering ones), so this caps
/// the parked-thread count under a burst. Past the cap the banner is dropped — the dock badge
/// still reflects every waiting agent, so nothing is silently lost. Generous vs. the realistic
/// "a handful of agents waiting at once" operating point.
const MAX_IN_FLIGHT_NOTIFICATIONS: usize = 16;
static IN_FLIGHT_NOTIFICATIONS: AtomicUsize = AtomicUsize::new(0);

/// RAII release for an in-flight notification slot. Decrements on drop — including on unwind —
/// so a panic inside `n.send()` (which calls into Objective-C and can unwrap internally) can't
/// permanently leak a slot and eventually wedge the cap.
struct NotificationSlot;
impl Drop for NotificationSlot {
    fn drop(&mut self) {
        IN_FLIGHT_NOTIFICATIONS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Per-window attention counts: window label -> how many of that window's agents are red.
/// Summed to drive the single app-global dock badge. A window reporting 0 is removed so it
/// stops contributing (and a closed window that last reported 0 leaves no residue).
#[derive(Default)]
pub struct BadgeCounts(Mutex<HashMap<String, i64>>);

/// Payload for `attention://focus-agent` — camelCased to match the TS listener.
#[derive(Clone, serde::Serialize)]
struct FocusAgent {
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "agentId")]
    agent_id: String,
}

/// The dock-badge value for a set of per-window counts: the sum across windows, or `None` when
/// nothing is waiting (which clears the badge). Negative/zero contributions are ignored so a
/// bad report can't drive the badge below zero. Pure, so it's unit-testable without an app.
fn badge_total(counts: &HashMap<String, i64>) -> Option<i64> {
    let total: i64 = counts.values().copied().filter(|n| *n > 0).sum();
    if total > 0 {
        Some(total)
    } else {
        None
    }
}

/// Write the dock badge to the cross-window total. `None` clears it.
fn apply_badge(app: &AppHandle, counts: &HashMap<String, i64>) {
    // Prefer the canonical "main" window; the badge is app-global so any window works.
    let win = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next());
    if let Some(win) = win {
        let _ = win.set_badge_count(badge_total(counts));
    }
}

/// A window reports how many of its agents currently need attention. We update its slot and
/// repaint the dock badge with the new cross-window total.
#[tauri::command]
pub fn set_window_attention(app: AppHandle, label: String, count: i64) {
    let counts = app.state::<BadgeCounts>();
    let mut map = counts.0.lock().unwrap();
    if count > 0 {
        map.insert(label, count);
    } else {
        map.remove(&label);
    }
    apply_badge(&app, &map);
}

/// Show a Notification Center banner for an agent that just started needing you. Runs on a
/// detached thread because `mac-notification-sys` blocks until the banner is clicked or
/// dismissed; on a click we emit `attention://focus-agent` so the UI navigates to that worker.
#[tauri::command]
pub fn notify_attention(app: AppHandle, project_id: String, agent_id: String, title: String, body: String) {
    // Reserve a slot up front; drop the banner if we're already at the parked-thread cap.
    if IN_FLIGHT_NOTIFICATIONS.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT_NOTIFICATIONS {
        IN_FLIGHT_NOTIFICATIONS.fetch_sub(1, Ordering::SeqCst);
        return;
    }
    std::thread::spawn(move || {
        // Releases the reserved slot on drop, even if n.send() panics on an ObjC error path.
        let _slot = NotificationSlot;
        let mut n = mac_notification_sys::Notification::new();
        n.title(&title).message(&body).wait_for_click(true);
        match n.send() {
            // A tap on the banner body (Click) or its action button routes to the worker.
            Ok(mac_notification_sys::NotificationResponse::Click)
            | Ok(mac_notification_sys::NotificationResponse::ActionButton(_)) => {
                let _ = app.emit("attention://focus-agent", FocusAgent { project_id, agent_id });
            }
            // Dismissed, ignored, or failed to deliver (e.g. unsigned dev binary): nothing to do.
            _ => {}
        }
    });
}

// Anchor symbol from objc/force_present.m. Referencing it forces the linker to retain that
// object file so its ObjC category (which makes banners present even when Sparkle is frontmost)
// is loaded — categories in a static lib are otherwise dead-stripped. See objc/force_present.m.
#[cfg(target_os = "macos")]
extern "C" {
    fn sparkle_force_present_anchor();
}

/// Best-effort: attribute notifications to Sparkle's bundle id so they read as "Sparkle" and
/// are clickable. Without this `mac-notification-sys` falls back to com.apple.Finder. Call once
/// at startup; the underlying setter is a no-op after the first success. Also pulls in the
/// foreground-presentation category so banners show while Sparkle is the active app.
pub fn init_application() {
    let _ = mac_notification_sys::set_application("ai.sparkle.desktop");
    // SAFETY: empty C function with no args/return; the only purpose of the call is to keep the
    // category's object file in the link (see the anchor's definition).
    #[cfg(target_os = "macos")]
    unsafe {
        sparkle_force_present_anchor();
    }
}

#[cfg(test)]
mod tests {
    use super::badge_total;
    use std::collections::HashMap;

    fn counts(pairs: &[(&str, i64)]) -> HashMap<String, i64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn empty_clears_the_badge() {
        assert_eq!(badge_total(&counts(&[])), None);
    }

    #[test]
    fn all_zero_clears_the_badge() {
        assert_eq!(badge_total(&counts(&[("main", 0), ("win-1", 0)])), None);
    }

    #[test]
    fn sums_across_windows() {
        assert_eq!(badge_total(&counts(&[("main", 2), ("win-1", 1)])), Some(3));
    }

    #[test]
    fn ignores_negative_contributions() {
        // A stray negative report must not drag the total below a real positive count.
        assert_eq!(badge_total(&counts(&[("main", 4), ("win-1", -10)])), Some(4));
    }
}
