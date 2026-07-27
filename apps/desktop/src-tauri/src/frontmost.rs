//! "Is Sparkle the frontmost app?", broadcast to the webviews as `app://frontmost-changed`.
//!
//! This is the signal the floating helper island gates on (spec §4.6): the island exists to be
//! seen from OUTSIDE Sparkle, so it must hide the moment a real Sparkle window comes forward.
//!
//! Two details make a naive implementation wrong, and both are why this logic was extracted from
//! `dictation.rs` rather than rewritten:
//!
//! 1. **macOS orders the events against you.** Switching between two Sparkle windows emits the
//!    old window's `resignKey` BEFORE the new window's `becomeKey`. Trusting a bare
//!    `Focused(false)` therefore reports "Sparkle went away" during every internal window switch —
//!    the island would flash on and off constantly. So a LOSS is deferred one runloop turn and
//!    re-polled; a GAIN is trusted immediately.
//! 2. **The helper is itself a window.** It is a non-activating `NSPanel`, so clicking it does not
//!    activate the app — but it still emits `Focused(true)`. Counted as an app window, the island
//!    would hide itself the instant the user clicked it. `is_app_window` filters it and the
//!    capture panel out.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// The floating island's window label.
pub const HELPER_LABEL: &str = "helper";
/// The capture takeover window's label (also a non-activating panel). Re-exported from
/// `capture_window` rather than re-declared, so a rename there cannot silently stop excluding it.
pub use crate::capture_window::CAPTURE_LABEL;

/// How long to wait before committing a blur, letting a paired `becomeKey` land first.
/// Matches dictation.rs' constant — one runloop turn plus slack.
const FOCUS_BLUR_COALESCE_MS: u64 = 120;

/// Whether a window label counts as a REAL Sparkle window for "is the app frontmost".
/// The two floating panels are deliberately excluded — see the module docs.
pub fn is_app_window(label: &str) -> bool {
    label != HELPER_LABEL && label != CAPTURE_LABEL
}

/// Whether a deferred blur should actually be committed: nothing superseded it AND a re-poll
/// still finds no app window focused. Split out as a pure function so the ordering logic is
/// unit-testable without a live AppHandle.
fn should_emit_blur(my_gen: u64, current_gen: u64, still_focused: bool) -> bool {
    my_gen == current_gen && !still_focused
}

/// `.0` is a monotonically-increasing focus-event generation, so an in-flight deferred blur can
/// detect it has been superseded. `.1` is the last value we broadcast, so we only emit on CHANGE.
#[derive(Default)]
pub struct FrontmostState(pub Arc<AtomicU64>, pub Arc<AtomicBool>);

/// The label/focus fold behind `any_app_window_focused`, taken as an iterator so it can be tested
/// without a live `AppHandle`.
///
/// Worth extracting: the bug this guards is not "is_app_window returns the right answer" — that
/// was always true — but "the RE-POLL actually applies it". A test that hand-feeds the resulting
/// boolean cannot tell the difference, and stayed green across a revert.
pub fn any_app_focused<'a>(windows: impl Iterator<Item = (&'a str, bool)>) -> bool {
    windows.filter(|(label, _)| is_app_window(label)).any(|(_, focused)| focused)
}

/// Is any real Sparkle window currently focused?
pub fn any_app_window_focused(app: &AppHandle) -> bool {
    any_app_focused(
        app.webview_windows()
            .iter()
            .map(|(label, w)| (label.as_str(), w.is_focused().unwrap_or(false)))
            .collect::<Vec<_>>()
            .into_iter(),
    )
}

/// Broadcast `frontmost` — but only when it differs from the last value we sent, so a burst of
/// focus events inside Sparkle doesn't spam the webviews with redundant work.
fn broadcast(app: &AppHandle, state: &FrontmostState, frontmost: bool) {
    if state.1.swap(frontmost, Ordering::SeqCst) == frontmost {
        return;
    }
    let _ = app.emit("app://frontmost-changed", frontmost);
}

/// Seed for a webview that mounts (or reloads) AFTER the last focus transition. `broadcast` only
/// emits on change, so without this the island would default to `frontmost = false` and paint
/// itself on top of the app until the next transition.
#[tauri::command]
pub fn get_frontmost(app: AppHandle) -> bool {
    any_app_window_focused(&app)
}

/// Feed every `WindowEvent::Focused` here. Gains are trusted immediately; losses are deferred and
/// re-polled (see the module docs).
pub fn note_focus_event(app: &AppHandle, state: &FrontmostState, focused: bool) {
    if focused {
        state.0.fetch_add(1, Ordering::SeqCst);
        broadcast(app, state, true);
        return;
    }
    let my_gen = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    let generation = state.0.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(FOCUS_BLUR_COALESCE_MS));
        if should_emit_blur(
            my_gen,
            generation.load(Ordering::SeqCst),
            any_app_window_focused(&app),
        ) {
            // The app may be tearing down by the time this deferred body runs; `state::<T>()`
            // PANICS if the state was already removed during shutdown, so use try_state and bail.
            // Same shutdown-window hazard dictation.rs documents at its own deferred blur.
            if let Some(state) = app.try_state::<FrontmostState>() {
                broadcast(&app, &state, false);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_and_capture_windows_are_not_app_windows() {
        // The helper is a non-activating panel: clicking it does NOT activate the app, but it
        // still emits Focused(true). Counting it as an app window would make the island hide
        // itself the instant the user clicked it.
        assert!(!is_app_window(HELPER_LABEL));
        assert!(!is_app_window(CAPTURE_LABEL));
    }

    #[test]
    fn a_panel_holding_key_does_not_count_as_the_app_being_focused() {
        // The mic-leak case (sparkle-9oz6), driven through the ACTUAL fold the re-poll uses rather
        // than by hand-feeding its result. The helper panel holds key (the user just clicked the
        // island) while every real window has resigned.
        let windows = [(HELPER_LABEL, true), ("main", false)];
        assert!(!any_app_focused(windows.into_iter()));

        // …so the deferred blur commits and the microphone is released. Drop the filter and the
        // first assertion flips, which flips this one too.
        assert!(should_emit_blur(1, 1, any_app_focused(windows.into_iter())));
    }

    #[test]
    fn a_focused_real_window_still_counts_even_beside_a_focused_panel() {
        let windows = [(HELPER_LABEL, true), ("main", true)];
        assert!(any_app_focused(windows.into_iter()));
        // A real window holds focus, so a blur must NOT commit — the mic stays live.
        assert!(!should_emit_blur(1, 1, any_app_focused(windows.into_iter())));
    }

    #[test]
    fn the_capture_panel_is_excluded_from_the_fold_too() {
        assert!(!any_app_focused([(CAPTURE_LABEL, true)].into_iter()));
    }

    #[test]
    fn main_and_secondary_windows_are_app_windows() {
        assert!(is_app_window("main"));
        assert!(is_app_window("win-2"));
    }

    #[test]
    fn blur_is_suppressed_when_a_newer_focus_event_superseded_it() {
        // A window switch inside Sparkle: our deferred blur (gen 1) wakes up to find the
        // generation already bumped to 2 by the incoming window's becomeKey.
        assert!(!should_emit_blur(1, 2, false));
    }

    #[test]
    fn blur_is_suppressed_when_a_repoll_still_finds_focus() {
        assert!(!should_emit_blur(1, 1, true));
    }

    #[test]
    fn blur_is_emitted_on_a_real_tab_away() {
        // Nothing superseded us and a re-poll confirms no Sparkle window holds focus.
        assert!(should_emit_blur(1, 1, false));
    }

    #[test]
    fn broadcast_state_only_reports_transitions() {
        // The dedupe lives in an AtomicBool swap; verify the swap semantics the broadcast relies
        // on, so a burst of focus events inside Sparkle cannot spam the webviews.
        let flag = AtomicBool::new(false);
        assert!(!flag.swap(true, Ordering::SeqCst)); // false -> true is a change
        assert!(flag.swap(true, Ordering::SeqCst)); // true -> true is not
    }
}
