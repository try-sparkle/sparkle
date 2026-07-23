//! Native "choose or create a project folder" picker, presented by US rather than by
//! tauri-plugin-dialog.
//!
//! WHY THIS FILE EXISTS — a real production crash, v0.35.0, macOS 26.5.2. Two panics 1.8ms apart:
//!
//!   1. `unexpected NULL returned from +[NSOpenPanel openPanel]`
//!      (objc2-app-kit-0.3.2/src/generated/NSOpenPanel.rs:127) — AppKit returned nil and the
//!      GENERATED binding unwrapped it.
//!   2. `called Result::unwrap() on an Err value: RecvError`
//!      (tauri-plugin-dialog-2.7.1/src/lib.rs:724) — the plugin's blocking picker waiting on the
//!      channel whose sender had just died in panic 1.
//!
//! NSOpenPanel is vended by an XPC service (`com.apple.appkit.xpc.openAndSavePanelService`); when
//! that service cannot be launched the class method returns nil. Neither third-party crate treats
//! that as a recoverable outcome, so "the file picker didn't open" became "the app died".
//!
//! We cannot patch either crate, so we stop routing through them: send the selector ourselves and
//! NIL-CHECK the result. A nil panel becomes an `Err` the UI can report, never a panic.
//!
//! THREADING — load-bearing, and the mirror image of `mic_permission.rs`'s hazard. NSOpenPanel must
//! be created and run ON the main thread, so the panel work is dispatched there via
//! `run_on_main_thread`. The command itself must therefore NOT be on the main thread: it blocks on
//! a channel waiting for that work, and blocking the main thread while waiting on the main thread
//! is a self-deadlock. The wait therefore runs on the BLOCKING pool (`spawn_blocking`), not on a
//! general async-runtime worker: a modal lasts as long as the user leaves it open, and parking a
//! runtime worker for minutes would starve unrelated commands. The wait is additionally bounded, so
//! a panel that never returns (the XPC service wedged rather than failing outright) times out
//! instead of pinning a blocking-pool thread forever.
//!
//! Non-macOS targets get a stub that reports the picker as unavailable; Sparkle's project flow is
//! macOS-first and the JS caller already handles a null/err by leaving the user where they were.

/// How long to wait for the main thread to finish presenting the panel before giving up. This is a
/// human-interactive modal — a user can legitimately sit in it for a long time — so the bound is
/// generous. It exists only to convert a WEDGED panel (never dismissed, never returned) into an
/// error rather than a permanently parked blocking-pool thread.
const PANEL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60 * 30);

/// Outcome of presenting the picker. Separated from the Tauri command so the plumbing below is
/// testable without an NSApplication.
#[derive(Debug, PartialEq, Eq)]
pub enum PickOutcome {
    /// The user chose a folder.
    Chosen(String),
    /// The user dismissed the panel. A normal, non-error outcome.
    Cancelled,
}

/// Convert a presentation result into the command's wire shape: `Ok(None)` for a cancel,
/// `Ok(Some(path))` for a choice. Pure — this is the mapping the tests pin.
pub fn outcome_to_reply(outcome: PickOutcome) -> Option<String> {
    match outcome {
        PickOutcome::Chosen(path) => Some(path),
        PickOutcome::Cancelled => None,
    }
}

/// Run `present` on this thread, converting BOTH failure modes that killed the app in production
/// into an `Err`:
///
///   - a returned `Err` (our nil-check firing), and
///   - a PANIC unwinding out of `present` (the backstop — if some deeper AppKit path still panics
///     the way objc2's generated binding did, it must not unwind through Objective-C frames).
///
/// The backstop is belt-and-braces, NOT the primary fix. The primary fix is that `present` nil-checks
/// instead of unwrapping; this exists so that a future objc2 bump reintroducing an unwrap somewhere
/// we don't control degrades to an error message rather than to a dead process.
pub fn guard_panics<F>(present: F) -> Result<PickOutcome, String>
where
    F: FnOnce() -> Result<PickOutcome, String> + std::panic::UnwindSafe,
{
    match std::panic::catch_unwind(present) {
        Ok(result) => result,
        Err(payload) => {
            let detail = panic_detail(payload.as_ref());
            tracing::error!(target: "folder_picker", "panic while presenting the folder picker: {detail}");
            Err(format!("The folder picker failed to open ({detail}). Please try again."))
        }
    }
}

/// Best-effort human-readable text from a caught panic payload (`&str` or `String`, else a
/// placeholder). Mirrors `crash.rs`'s `panic_payload_string`.
fn panic_detail(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

// ── macOS: present NSOpenPanel ourselves, nil-checking every fallible step ───────────────────────
#[cfg(target_os = "macos")]
mod platform {
    use super::PickOutcome;
    use objc2::rc::Retained;
    use objc2::runtime::AnyClass;
    use objc2::{msg_send, MainThreadMarker};
    use objc2_app_kit::NSOpenPanel;
    use objc2_foundation::{NSString, NSURL};

    /// `NSModalResponseOK`. Hard-coded rather than imported so the feature surface stays minimal;
    /// this constant is part of the stable AppKit ABI.
    const MODAL_RESPONSE_OK: isize = 1;

    /// Present the open-directory panel and block (on the MAIN thread — see the module docs) until
    /// the user answers.
    ///
    /// Every step that can hand back nil is CHECKED. That is the entire point of this function: the
    /// generated `NSOpenPanel::openPanel()` binding unwraps, and that unwrap is what killed the app.
    pub fn present(title: &str, mtm: MainThreadMarker) -> Result<PickOutcome, PresentError> {
        let _ = mtm; // proof we're on the main thread; the selector below needs no marker argument

        // THE nil-check. `+[NSOpenPanel openPanel]` returns nil when the XPC service that vends the
        // panel can't be launched. Typed as Option so nil is a value, not a panic.
        let panel: Option<Retained<NSOpenPanel>> = unsafe {
            let cls: &AnyClass = objc2::class!(NSOpenPanel);
            msg_send![cls, openPanel]
        };
        let Some(panel) = panel else {
            return Err(PresentError::PanelUnavailable);
        };

        panel.setCanChooseDirectories(true);
        panel.setCanChooseFiles(false);
        panel.setAllowsMultipleSelection(false);
        // The macOS open-directory panel's New Folder button is what makes this one control cover
        // both "choose an existing folder" and "create a new one" — the behavior the JS caller's
        // doc comment promises.
        panel.setCanCreateDirectories(true);
        // `-setMessage:`, NOT `-setTitle:`, is deliberate: modern macOS does not draw a title bar
        // on the open panel, so a title is invisible, while the message renders as the prompt text
        // the user actually reads. This is also what the plugin we replaced did (rfd maps its
        // `set_title` to `-setMessage:`), so the UX is unchanged by the swap.
        panel.setMessage(Some(&NSString::from_str(title)));

        let response: isize = unsafe { msg_send![&*panel, runModal] };
        if response != MODAL_RESPONSE_OK {
            return Ok(PickOutcome::Cancelled);
        }

        // Also nil-checked: a panel that returned OK with no URL is nonsense, but it must not panic.
        let url: Option<Retained<NSURL>> = unsafe { msg_send![&*panel, URL] };
        let Some(url) = url else {
            return Err(PresentError::MissingUrl);
        };
        let path: Option<Retained<NSString>> = unsafe { msg_send![&*url, path] };
        let Some(path) = path else {
            return Err(PresentError::MissingPath);
        };
        Ok(PickOutcome::Chosen(path.to_string()))
    }

    /// Why a presentation failed. Kept as an enum so the message shown to the user is written in
    /// one place and the cause stays greppable in logs.
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub enum PresentError {
        /// `+[NSOpenPanel openPanel]` returned nil — the exact production crash, now recoverable.
        PanelUnavailable,
        /// The panel reported OK but handed back no URL.
        MissingUrl,
        /// The URL carried no filesystem path (e.g. a non-file URL).
        MissingPath,
    }

    impl PresentError {
        pub fn message(self) -> String {
            match self {
                Self::PanelUnavailable => "macOS could not open the folder picker. This usually clears on a \
                                  retry; if it keeps happening, restarting Sparkle fixes it."
                    .to_string(),
                Self::MissingUrl | Self::MissingPath => {
                    "The folder picker returned no usable path. Please try again.".to_string()
                }
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::PickOutcome;

    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub enum PresentError {
        Unsupported,
    }

    impl PresentError {
        pub fn message(self) -> String {
            "The native folder picker is only available on macOS.".to_string()
        }
    }

    pub fn present<M>(_title: &str, _mtm: M) -> Result<PickOutcome, PresentError> {
        Err(PresentError::Unsupported)
    }
}

/// Prompt the user to choose or create a project folder.
///
/// `Ok(None)` = the user cancelled (a normal outcome, not an error). `Ok(Some(path))` = a choice.
/// `Err(message)` = the picker could not be presented; the message is user-facing. NEVER panics —
/// that is the whole reason this command exists (see the module docs).
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle, title: String) -> Result<Option<String>, String> {
    // The wait below is a SYNCHRONOUS recv that lasts as long as the user leaves the modal open, so
    // it runs on the blocking pool — parking a general async-runtime worker for minutes would starve
    // unrelated commands. (`dictation.rs` uses spawn_blocking for the same reason.)
    tauri::async_runtime::spawn_blocking(move || pick_folder_blocking(&app, title))
        .await
        .unwrap_or_else(|e| Err(format!("The folder picker task failed to run: {e}")))
}

/// The blocking half of `pick_folder`: dispatch the panel to the main thread and wait for it.
///
/// MUST NOT run on the main thread — it blocks waiting for main-thread work, which would be a
/// self-deadlock. See the module docs.
fn pick_folder_blocking(app: &tauri::AppHandle, title: String) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<PickOutcome, String>>();

    // Hop to the main thread: AppKit will not vend a panel anywhere else.
    let dispatch = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let result = {
            match objc2::MainThreadMarker::new() {
                Some(mtm) => guard_panics(std::panic::AssertUnwindSafe(move || {
                    platform::present(&title, mtm).map_err(|e| e.message())
                })),
                // run_on_main_thread put us on the main thread, so this is unreachable in practice
                // — but it is an Option, and an unwrap here would be the very bug this file fixes.
                None => Err("Could not confirm the main thread for the folder picker.".to_string()),
            }
        };
        #[cfg(not(target_os = "macos"))]
        let result = guard_panics(std::panic::AssertUnwindSafe(move || {
            platform::present(&title, ()).map_err(|e| e.message())
        }));

        // A dropped receiver (we timed out first) must not panic on a thread we don't own.
        let _ = tx.send(result);
    });

    if let Err(e) = dispatch {
        return Err(format!("Could not reach the main thread to open the folder picker: {e}"));
    }

    // Bounded wait. RecvError here is the SECOND production panic's cause — the plugin unwrapped it.
    // We map it to a recoverable error instead.
    match rx.recv_timeout(PANEL_TIMEOUT) {
        Ok(result) => result.map(outcome_to_reply),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err("The folder picker did not respond. Please try again.".to_string())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("The folder picker closed unexpectedly. Please try again.".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_choice_maps_to_the_path_and_a_cancel_maps_to_none() {
        assert_eq!(
            outcome_to_reply(PickOutcome::Chosen("/Users/ada/proj".into())),
            Some("/Users/ada/proj".to_string())
        );
        assert_eq!(outcome_to_reply(PickOutcome::Cancelled), None);
    }

    #[test]
    fn guard_panics_passes_a_successful_presentation_through_untouched() {
        let out = guard_panics(|| Ok(PickOutcome::Chosen("/tmp/x".into())));
        assert_eq!(out, Ok(PickOutcome::Chosen("/tmp/x".to_string())));
    }

    #[test]
    fn guard_panics_passes_a_cancel_through_as_a_non_error() {
        assert_eq!(guard_panics(|| Ok(PickOutcome::Cancelled)), Ok(PickOutcome::Cancelled));
    }

    /// A nil panel — the exact production failure — must surface as a recoverable Err, not a panic.
    #[test]
    fn a_nil_panel_becomes_an_error_rather_than_a_panic() {
        let out = guard_panics(|| Err("macOS could not open the folder picker.".to_string()));
        assert!(out.is_err());
        assert!(out.unwrap_err().contains("could not open the folder picker"));
    }

    /// The backstop: a panic from inside the presentation is CAUGHT and converted, so it can never
    /// unwind through Objective-C frames or take the process down the way the shipped crash did.
    #[test]
    fn guard_panics_converts_a_panic_into_an_error() {
        // Silence the default panic hook for this one deliberate panic so the test output stays
        // readable (and so crash.rs's hook, if installed, doesn't write a breadcrumb for it).
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let out = guard_panics(|| panic!("unexpected NULL returned from +[NSOpenPanel openPanel]"));
        std::panic::set_hook(prev);

        let err = out.expect_err("a panic must become an Err, never propagate");
        assert!(err.contains("failed to open"), "user-facing message, got: {err}");
        // The cause is preserved for triage.
        assert!(err.contains("NSOpenPanel"), "panic detail should be preserved, got: {err}");
    }

    #[test]
    fn guard_panics_preserves_a_string_panic_payload() {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let out = guard_panics(|| panic!("{}", String::from("boxed string payload")));
        std::panic::set_hook(prev);
        assert!(out.unwrap_err().contains("boxed string payload"));
    }
}
