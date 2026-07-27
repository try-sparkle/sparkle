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
//! Key-focus contract (dictation is focus-gated): this window is reclassed to a
//! non-activating `NSPanel` (see objc/panel.m + mac_panel.rs), so it can become key —
//! accepting typing / the dictation caret — WITHOUT `activateIgnoringOtherApps`. We make it
//! key via `mac_panel::present_key` (`makeKeyAndOrderFront:`), NOT Tauri's `set_focus()`,
//! precisely so showing the takeover never raises Sparkle over the app the user just
//! captured. The user's front app stays frontmost while keystrokes route to this panel.
//!
//! Spec: docs/superpowers/specs/2026-07-01-menubar-capture-design.md §3.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const CAPTURE_LABEL: &str = "capture";

/// Broadcast when the takeover is dismissed. The floating island subscribes: it is always-on-top,
/// and the takeover fills the display, so the island must stay suppressed for the WHOLE annotation
/// session — not merely until `show_capture_window` resolves. Must match `CAPTURE_CLOSED` in
/// src/services/helper.ts.
pub const CAPTURE_CLOSED_EVENT: &str = "capture://closed";

/// Focus-retry contract: the retry loop runs `FOCUS_RETRY_TICKS` times at
/// `FOCUS_RETRY_INTERVAL` apart (the warn below derives its duration from these —
/// change them together, the message stays honest).
///
/// Kept deliberately SHORT (4 × 150ms ≈ 0.6s of retries after the initial synchronous
/// make-key). The old 8 × 250ms (≈2s) window was the felt jank on show: each tick re-issues a
/// make-key, and dev smoke logs showed runs where the loop spent the full two seconds
/// focus-fighting (probe readings flipping key→not-key→key). The loop still exits the instant
/// focus is acquired (below), so this only bounds the pathological "make-key was swallowed"
/// case — 0.6s is ample to recover a genuinely-swallowed make-key.
const FOCUS_RETRY_TICKS: u32 = 4;
const FOCUS_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(150);

/// Monotone show generation: bumped by every `show_capture_window`. A retry thread
/// captures its generation at spawn and exits the moment a newer show supersedes it,
/// so a quick hide→re-show never leaves two threads fighting over make-key.
static SHOW_GEN: AtomicU64 = AtomicU64::new(0);
/// The show generation during which the window was last observed key (via the real
/// `Focused(true)` window event, or a poll reading). Once `FOCUSED_GEN >= gen` the
/// retry loop stops permanently for that show: "keyed, then the user deliberately
/// switched away" must never be answered with another make-key.
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
    // Make the takeover a non-activating panel: show_capture_window can then make it key (so
    // typing / dictation land in the composer) WITHOUT activateIgnoringOtherApps raising Sparkle
    // over the app the user just captured. See objc/panel.m and the key-focus contract above.
    crate::mac_panel::make_nonactivating_panel(&win);
    let handle = app.clone();
    win.on_window_event(move |event| match event {
        // Latch key-status per show: the event is authoritative (a 250ms poll can miss a
        // key-then-Cmd+Tab that fits inside one tick), and the retry loop reads the latch.
        tauri::WindowEvent::Focused(true) => {
            FOCUSED_GEN.store(SHOW_GEN.load(Ordering::SeqCst), Ordering::SeqCst);
        }
        // ⌘W. There is no custom menu in tauri.conf.json, so Tauri installs the default macOS menu
        // and Close targets the KEY window — which, while the takeover is up, is the takeover by
        // design (it is a key-accepting panel so dictation lands in it). Two things went wrong
        // without this arm, and both are worse than they look:
        //   1. The window is BUILT ONCE at startup and only ever shown/hidden, so letting the close
        //      destroy it makes every later `show_capture_window` fail with "capture window does
        //      not exist" — capture is dead for the rest of the session.
        //   2. `hide_capture_window` never runs, so `capture://closed` is never emitted, and the
        //      island's takeover suppression has no clearing edge. It is hidden, so its context
        //      menu is unreachable, and toggling `enabled` from the main window hits the same
        //      suppression — the island is gone for the session with no way back (roborev 53341).
        // So: refuse the destroy and run the ordinary dismissal instead, which is what the user
        // meant anyway. (The frontend also re-polls `is_capture_open` on every frontmost gain, so a
        // teardown path we haven't thought of still recovers; this arm keeps the common one clean.)
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Err(e) = dismiss_takeover(&AppTakeover(&handle)) {
                tracing::warn!("capture: close-requested dismissal failed: {e}");
            }
        }
        _ => {}
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

    let show_start = std::time::Instant::now();
    win.show().map_err(|e| format!("show capture window: {e}"))?;
    // Makes the window KEY (dictation acceptance criterion) WITHOUT activating the app: it is a
    // non-activating panel (init_capture_window), so makeKeyAndOrderFront: routes keystrokes here
    // while the app the user just captured stays frontmost. This deliberately does NOT
    // activateIgnoringOtherApps — that would raise Sparkle over the user's work.
    crate::mac_panel::present_key(&win);
    // Both felt-lag sources in one line: `show_ms` = time to make the takeover visible + key
    // (the window chrome the user sees), `payload_bytes` = size of the base64 `data:` preview
    // about to cross the IPC bridge to the webview (the image that fills in a beat later).
    tracing::info!(
        show_ms = show_start.elapsed().as_millis() as u64,
        payload_bytes = shot.data_url.len(),
        "capture: window shown + focused; delivering shot to webview"
    );
    // Becoming key is asynchronous, and a non-activating panel occasionally does not take key on
    // the first makeKeyAndOrderFront: when another app is being interacted with at that instant
    // (observed in dev smoke: one run keyed on the first try, one never keyed). Retry briefly on
    // a helper thread. The retry exists ONLY to compensate for a swallowed initial make-key: it
    // stops permanently once this show has been key at least once (FOCUSED_GEN latch — never
    // wrestle a user who deliberately switched away), and it exits when a newer show supersedes
    // it (SHOW_GEN). Each retry is make-key-without-activating, so it never yanks the app forward.
    let gen = SHOW_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let win = win.clone();
        std::thread::spawn(move || {
            for tick in 1..=FOCUS_RETRY_TICKS {
                std::thread::sleep(FOCUS_RETRY_INTERVAL);
                if SHOW_GEN.load(Ordering::SeqCst) != gen
                    || FOCUSED_GEN.load(Ordering::SeqCst) >= gen
                    || !win.is_visible().unwrap_or(false)
                {
                    return;
                }
                if win.is_focused().unwrap_or(false) {
                    FOCUSED_GEN.store(gen, Ordering::SeqCst);
                    tracing::debug!(tick, "capture window acquired key focus via retry");
                    return;
                }
                crate::mac_panel::present_key(&win);
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

/// The four things a takeover dismissal must do, behind a seam.
///
/// This exists so the ORDER and the "run every step even if an earlier one failed" guarantee can be
/// asserted without a live `AppHandle` (roborev 53339-M3). Before the seam, the whole Rust half of
/// the island's suppression contract was untested: the frontend fires a MOCKED `onCaptureClosed`,
/// so deleting the `capture://closed` emit outright kept every test green while stranding the
/// island for the rest of the session. `frontmost.rs` names this failure class in its own docs.
pub trait TakeoverTeardown {
    fn hide_window(&self) -> Result<(), String>;
    fn release_dictation(&self);
    fn repoll_frontmost(&self);
    fn emit_closed(&self);
}

/// Dismiss the takeover: hide it, then release everything that was gated on it being up.
///
/// The hide error is CARRIED, not propagated early. `win.hide()` used to be applied with `?`, so a
/// failing hide returned before the emit — and a missing `capture://closed` is not a cosmetic loss:
/// it is the island's only clearing edge, so the island stays suppressed with no route back
/// (roborev 53341-M2). Every consumer below is a release, and releasing after a failed hide is at
/// worst redundant; skipping one is unrecoverable. The caller still learns the hide failed.
pub fn dismiss_takeover<T: TakeoverTeardown>(t: &T) -> Result<(), String> {
    let hide_err = t.hide_window().err();
    // This panel COUNTS for dictation's focus gate (frontmost::is_typing_window) so narration
    // works in the takeover — which means hiding it must be able to release the microphone.
    // `orderOut:` on a key window normally resigns key and emits Focused(false) on its own, but a
    // missed event here is a mic left open indefinitely (the sparkle-9oz6 failure), so drive the
    // standard blur path explicitly. It is a re-poll, not a command: `note_focus_event(false)`
    // defers ~120ms and only commits if nothing else holds the caret, so a hide that hands focus
    // straight back to the main window is a no-op rather than a spurious teardown.
    t.release_dictation();
    // Same reasoning for the island: the takeover is gone, so re-evaluate whether Sparkle is
    // frontmost rather than leaving the last value the takeover's arrival happened to leave behind.
    t.repoll_frontmost();
    // Release the island's takeover suppression (HelperApp's `takeoverOpen`). The island is
    // always-on-top and the takeover fills the display, so the two must never be on screen at
    // once — but `show_capture_window` resolves when the takeover is SHOWN, not when the user is
    // done with it, so the frontend cannot tell on its own. This is the "done with it" edge.
    t.emit_closed();
    match hide_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// The real implementation of the seam, against a live app. Deliberately thin — every line here is
/// eyeballed rather than tested, so there is nothing to get wrong beyond the four call targets.
struct AppTakeover<'a>(&'a AppHandle);

impl TakeoverTeardown for AppTakeover<'_> {
    fn hide_window(&self) -> Result<(), String> {
        match self.0.get_webview_window(CAPTURE_LABEL) {
            Some(win) => win.hide().map_err(|e| format!("hide capture window: {e}")),
            None => Ok(()),
        }
    }
    fn release_dictation(&self) {
        self.0
            .state::<crate::dictation::DictationState>()
            .note_focus_event(self.0, false);
    }
    fn repoll_frontmost(&self) {
        crate::frontmost::note_focus_event(
            self.0,
            &self.0.state::<crate::frontmost::FrontmostState>(),
            false,
        );
    }
    fn emit_closed(&self) {
        let _ = self.0.emit(CAPTURE_CLOSED_EVENT, ());
    }
}

#[tauri::command]
pub fn hide_capture_window(app: AppHandle) -> Result<(), String> {
    dismiss_takeover(&AppTakeover(&app))
}

/// Is the takeover on screen right now? The SEED for the island's suppression, mirroring
/// `get_frontmost` and `get_helper_vitals`.
///
/// `capture://closed` is a single edge and events only fire on TRANSITIONS, so an event-only signal
/// is wrong for a webview that may mount (or reload, or crash and reload) after the last one. Both
/// halves broke: a helper webview that mounts while the takeover is up starts with `takeoverOpen =
/// false` and paints over it — the exact bug the flag was added to fix — and a `capture://closed`
/// that never arrives suppresses the island for the rest of the session. The frontend polls this on
/// mount AND on every frontmost gain, so the flag can never outlive the window it describes.
#[tauri::command]
pub fn is_capture_open(app: AppHandle) -> bool {
    app.get_webview_window(CAPTURE_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// The TypeScript that has to agree with the constants above, embedded at COMPILE time. A
    /// rename on either side now fails a test instead of silently stranding the island.
    const HELPER_TS: &str = include_str!("../../src/services/helper.ts");

    #[derive(Default)]
    struct FakeTakeover {
        hide_fails: bool,
        steps: RefCell<Vec<&'static str>>,
    }

    impl TakeoverTeardown for FakeTakeover {
        fn hide_window(&self) -> Result<(), String> {
            self.steps.borrow_mut().push("hide");
            if self.hide_fails {
                return Err("hide capture window: nope".into());
            }
            Ok(())
        }
        fn release_dictation(&self) {
            self.steps.borrow_mut().push("dictation");
        }
        fn repoll_frontmost(&self) {
            self.steps.borrow_mut().push("frontmost");
        }
        fn emit_closed(&self) {
            self.steps.borrow_mut().push("closed");
        }
    }

    #[test]
    fn a_dismissal_hides_then_releases_every_consumer_that_was_gated_on_the_takeover() {
        // The whole contract, in order. Deleting any one of these lines from dismiss_takeover now
        // fails here — previously the frontend fired a MOCKED capture://closed, so the Rust emit
        // could be deleted outright with every test still green.
        let fake = FakeTakeover::default();
        assert!(dismiss_takeover(&fake).is_ok());
        assert_eq!(
            *fake.steps.borrow(),
            vec!["hide", "dictation", "frontmost", "closed"],
        );
    }

    #[test]
    fn a_failed_hide_still_emits_the_close_edge() {
        // The `?` this replaced returned BEFORE the emit, so a hide error left the island suppressed
        // for the rest of the session with no clearing edge and no reachable context menu — while
        // the mic stayed armed and `frontmost` kept whatever value the takeover's arrival left
        // behind. Every step below is a RELEASE; running one twice is harmless, skipping one is not.
        let fake = FakeTakeover { hide_fails: true, ..Default::default() };
        let err = dismiss_takeover(&fake).expect_err("the hide failure must still reach the caller");
        assert!(err.contains("hide capture window"));
        assert_eq!(
            *fake.steps.borrow(),
            vec!["hide", "dictation", "frontmost", "closed"],
        );
    }

    #[test]
    fn the_typescript_listener_uses_the_same_event_name() {
        // Enforced by a "must match" comment on both sides and nothing else. Breaking it produces
        // the unrecoverable stranded-island state above, at runtime, on the notarized build.
        assert!(
            HELPER_TS.contains(&format!("\"{CAPTURE_CLOSED_EVENT}\"")),
            "src/services/helper.ts no longer listens on {CAPTURE_CLOSED_EVENT}",
        );
    }

    #[test]
    fn the_typescript_seed_invokes_the_command_this_module_exposes() {
        // Same class of break, one severity down: a rename here makes the seed silently resolve
        // null, which quietly restores the event-only latch that B2 is about.
        assert!(
            HELPER_TS.contains("\"is_capture_open\""),
            "src/services/helper.ts no longer invokes is_capture_open",
        );
    }
}
