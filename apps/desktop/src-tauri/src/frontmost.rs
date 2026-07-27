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
//!
//! **Two policies, two predicates — do not collapse them back into one.** "Is Sparkle frontmost"
//! (`is_app_window`) and "can this window hold the typing caret" (`is_typing_window`) are different
//! questions that happen to agree about the helper and disagree about the capture takeover. Sharing
//! one predicate is what killed voice narration in the takeover: the capture panel is deliberately
//! key-accepting (capture_window.rs' key-focus contract) and mounts `useAmbientVoice`, so excluding
//! it from the DICTATION side meant `capture_should_be_live(armed, focused)` sampled `focused =
//! false` on every invocation and the microphone was never built. It still must NOT count as
//! "Sparkle is frontmost" — showing the takeover deliberately leaves the user's own app in front.

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

/// Whether a window label can hold the TYPING CARET — the policy dictation gates on.
///
/// The capture takeover COUNTS here and only here: it is reclassed to a key-accepting panel
/// precisely so narration lands in it (capture_window.rs), so gating the mic on `is_app_window`
/// left it permanently unfocused and the mic permanently unbuilt.
///
/// The HELPER stays excluded, here as everywhere (sparkle-9oz6). It is a click-only chiclet that
/// never takes the caret, and a non-activating panel that holds key while the user is in another
/// app would suppress dictation's deferred blur and leave the microphone open indefinitely.
pub fn is_typing_window(label: &str) -> bool {
    label != HELPER_LABEL
}

/// Which consumers a window's `Focused` event feeds. Both flags, from one call, so lib.rs' dispatch
/// is a lookup rather than two independent `if`s that can drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FocusConsumers {
    /// Release/rebuild the microphone (`is_typing_window`).
    pub dictation: bool,
    /// Re-evaluate "is Sparkle frontmost", which drives the island (`is_app_window`).
    pub frontmost: bool,
}

/// The routing itself, as a pure function — the thing lib.rs' `on_window_event` actually does.
///
/// Extracted for the reason stated at `any_matching` above: the predicates were always correct, and
/// the bug was in whether the DISPATCH applied them. The capture takeover is the whole point — it
/// must reach dictation (it is a key-accepting panel and CaptureApp mounts `useAmbientVoice`) and
/// must NOT reach frontmost (it is shown without activating the app). Wiring it to one filter, or
/// to both, is invisible to any test that hand-feeds the predicates.
pub fn focus_consumers(label: &str) -> FocusConsumers {
    FocusConsumers {
        dictation: is_typing_window(label),
        frontmost: is_app_window(label),
    }
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

/// The shared `(label, flag)` fold: does any window the `counts` predicate admits have its flag
/// set? Taken as an iterator, and with the predicate passed in, so every policy below is testable
/// without a live `AppHandle` AND so the two policies cannot drift into two different folds.
///
/// Worth extracting: the bug this guards is not "is_app_window returns the right answer" — that
/// was always true — but "the RE-POLL actually applies it". A test that hand-feeds the resulting
/// boolean cannot tell the difference, and stayed green across a revert.
fn any_matching<'a>(
    windows: impl Iterator<Item = (&'a str, bool)>,
    counts: fn(&str) -> bool,
) -> bool {
    windows.filter(|(label, _)| counts(label)).any(|(_, flag)| flag)
}

/// The fold behind `any_app_window_focused` — "is Sparkle frontmost", panels excluded.
pub fn any_app_focused<'a>(windows: impl Iterator<Item = (&'a str, bool)>) -> bool {
    any_matching(windows, is_app_window)
}

/// The fold behind `any_typing_window_focused` — "can the caret be somewhere in Sparkle right
/// now", which INCLUDES the capture takeover and excludes only the helper.
pub fn any_typing_focused<'a>(windows: impl Iterator<Item = (&'a str, bool)>) -> bool {
    any_matching(windows, is_typing_window)
}

/// The fold behind `any_app_window_visible`. Same admission rule as `any_app_focused`, different
/// question: the `bool` here is VISIBILITY, not focus.
pub fn any_app_visible<'a>(windows: impl Iterator<Item = (&'a str, bool)>) -> bool {
    any_matching(windows, is_app_window)
}

/// Collect `(label, flag)` for every live webview window, reading `flag` with `read`.
/// Collected into a Vec first: `webview_windows()` hands back a map guard, and holding it across
/// the `is_focused()`/`is_visible()` main-thread round-trips is the shape that deadlocked once.
fn sample(app: &AppHandle, read: fn(&tauri::WebviewWindow) -> bool) -> Vec<(String, bool)> {
    app.webview_windows()
        .iter()
        .map(|(label, w)| (label.clone(), read(w)))
        .collect()
}

/// Is any real Sparkle window currently focused?
pub fn any_app_window_focused(app: &AppHandle) -> bool {
    let windows = sample(app, |w| w.is_focused().unwrap_or(false));
    any_app_focused(windows.iter().map(|(l, f)| (l.as_str(), *f)))
}

/// Is any window that can hold the typing caret currently focused? This — NOT
/// `any_app_window_focused` — is what dictation gates the microphone on, so narration works in the
/// capture takeover. See `is_typing_window`.
pub fn any_typing_window_focused(app: &AppHandle) -> bool {
    let windows = sample(app, |w| w.is_focused().unwrap_or(false));
    any_typing_focused(windows.iter().map(|(l, f)| (l.as_str(), *f)))
}

/// Is any real Sparkle window on screen? The macOS Dock-icon `Reopen` guard: AppKit's
/// `hasVisibleWindows` counts our always-on-top panels, and the island is visible EXACTLY when
/// Sparkle is not frontmost — which is the state a user is in when they click the Dock icon. So
/// the OS-supplied flag is always true there and the Dock icon stopped reopening the app.
pub fn any_app_window_visible(app: &AppHandle) -> bool {
    let windows = sample(app, |w| w.is_visible().unwrap_or(false));
    any_app_visible(windows.iter().map(|(l, v)| (l.as_str(), *v)))
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

    // ---- the two policies, on the ONE window state where they must disagree ----

    #[test]
    fn the_capture_takeover_keeps_dictation_live_without_reporting_sparkle_frontmost() {
        // The takeover is open and holding key while the user's own app stays in front. This is
        // the entire flow the capture window exists for: global shortcut → takeover takes key →
        // CaptureApp's useAmbientVoice arms the mic.
        let windows = [(CAPTURE_LABEL, true), ("main", false)];

        // Dictation MUST see a focused window, or capture_should_be_live(armed, focused) is false,
        // the mic is never built, and no later focus event ever brings it up.
        assert!(any_typing_focused(windows.into_iter()));
        assert!(!should_emit_blur(1, 1, any_typing_focused(windows.into_iter())));

        // …and the island MUST still consider Sparkle backgrounded: showing the takeover
        // deliberately does not activate the app (capture_window.rs' key-focus contract).
        assert!(!any_app_focused(windows.into_iter()));
    }

    #[test]
    fn the_helper_is_excluded_from_the_typing_policy_too() {
        // sparkle-9oz6, restated against the NEW predicate: a non-activating panel can hold key
        // while the user is in another app. Letting the helper count here would suppress
        // dictation's deferred blur and leave the microphone open indefinitely. The split must
        // widen the policy to the capture panel ONLY.
        assert!(!is_typing_window(HELPER_LABEL));
        let windows = [(HELPER_LABEL, true), ("main", false)];
        assert!(!any_typing_focused(windows.into_iter()));
        assert!(should_emit_blur(1, 1, any_typing_focused(windows.into_iter())));
    }

    // ---- the DISPATCH, not just the predicates (roborev 53339-M3) ----

    #[test]
    fn the_capture_takeover_is_routed_to_dictation_but_not_to_frontmost() {
        // The two-filter dispatch in lib.rs' on_window_event, as a value. Wiring the takeover to
        // BOTH filters makes the island think Sparkle came forward and hides it under the takeover
        // it is supposed to stay clear of; wiring it to NEITHER kills voice narration in the
        // takeover (the mic is never built). Neither mistake is visible to a predicate test.
        assert_eq!(
            focus_consumers(CAPTURE_LABEL),
            FocusConsumers { dictation: true, frontmost: false },
        );
    }

    #[test]
    fn the_helper_island_is_routed_to_neither_consumer() {
        // sparkle-9oz6 from the dispatch side: the island is a non-activating panel, so letting it
        // through to dictation resumes microphone capture the moment the user clicks the island
        // while working in another app, and letting it through to frontmost makes the island hide
        // itself on its own click.
        assert_eq!(
            focus_consumers(HELPER_LABEL),
            FocusConsumers { dictation: false, frontmost: false },
        );
    }

    #[test]
    fn a_real_window_is_routed_to_both_consumers() {
        let both = FocusConsumers { dictation: true, frontmost: true };
        assert_eq!(focus_consumers("main"), both);
        assert_eq!(focus_consumers("win-2"), both);
    }

    #[test]
    fn the_typing_policy_admits_the_capture_panel_and_every_real_window() {
        assert!(is_typing_window(CAPTURE_LABEL));
        assert!(is_typing_window("main"));
        assert!(is_typing_window("win-2"));
    }

    // ---- the Reopen (Dock icon) guard ----

    #[test]
    fn a_visible_panel_does_not_count_as_a_visible_app_window() {
        // The Dock-icon regression: the main window is hidden ("keep agents running"), and the
        // island is visible precisely BECAUSE Sparkle is not frontmost. AppKit reports
        // hasVisibleWindows: YES; our own fold must say NO so Reopen reveals the main window.
        assert!(!any_app_visible([(HELPER_LABEL, true), ("main", false)].into_iter()));
        // Same for the takeover, and for both panels at once.
        assert!(!any_app_visible([(CAPTURE_LABEL, true)].into_iter()));
        assert!(!any_app_visible([(HELPER_LABEL, true), (CAPTURE_LABEL, true)].into_iter()));
    }

    #[test]
    fn a_visible_real_window_makes_reopen_a_no_op() {
        // The other half: with the app already on screen, Reopen must NOT re-raise/steal focus.
        assert!(any_app_visible([(HELPER_LABEL, true), ("main", true)].into_iter()));
        assert!(any_app_visible([("win-2", true)].into_iter()));
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
