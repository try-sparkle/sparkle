//! The Living Sparkle Overlay's tray presence — bead `sparkle-uz87.9`, epic `sparkle-uz87`.
//!
//! ## Why this module is almost entirely pure
//!
//! The tray icon is the only part of the overlay a user can see while the overlay window itself is
//! invisible, so it is the only honest answer to *"is this thing listening to me right now"*. That
//! makes it a privacy surface. The interesting logic is therefore the MAPPING — which internal
//! state is allowed to render as "listening", and which must not — and that mapping is what this
//! module exposes as plain functions with unit tests.
//!
//! Keeping it pure matters more here than elsewhere in this crate: this repo's Rust CI legs are
//! gated behind `ENABLE_HOSTED_RUST_CI` and are currently SKIPPED, so a `#[tauri::command]` body is
//! effectively untested by CI. A pure function with `#[cfg(test)]` coverage is the only part of a
//! Rust change here that anything actually checks.
//!
//! ## The gate, and why the default is OFF
//!
//! The overlay ships behind `VITE_SPARKLE_OVERLAY`, off by default, and is not mounted by any
//! component. A tray icon is a PERMANENT, always-visible change to every user's menu bar — so
//! installing one for a feature that cannot run would be a visible change advertising nothing. The
//! gate below is what keeps the shipping default byte-identical to today's behaviour.
//!
//! The gate FAILS CLOSED, and that direction is the whole point: an absent, empty or unparseable
//! gate value means DO NOT create the tray. Only an affirmative reading (`1`/`true`/`on`) opens it.
//! Note also what is NOT here — `tauri.conf.json` deliberately carries no `app.trayIcon` key. That
//! key would build an icon at startup with no gate in front of it, so the only path to a tray in
//! this app is [`sync_tray_with_gate`], which cannot run without an affirmative gate.
//!
//! ## Auto-launch lives here too
//!
//! The OS half of the opt-in launch-at-login preference (`tauri-plugin-autostart`) is exposed from
//! this module rather than a module of its own, because it is the same bead and the same shape: a
//! user-invisible change to the machine that may only ever happen on an explicit opt-in. The plugin
//! is registered in `lib.rs` with NO argv auto-enable, so installing the app enrols nobody; the one
//! and only thing that ever registers is [`overlay_auto_launch_set`].

use serde::{Deserialize, Serialize};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

/// What the tray is currently saying. Mirrors `TrayStatus` in
/// `apps/desktop/src/services/overlayTray/trayStatus.ts` — the two are a pair, and the TS side is
/// where the derivation from a live session snapshot happens.
///
/// NOTE for anyone widening this: a Rust `Option` crosses the wire as `null`, never as an absent
/// key, so the TS mirror of any optional field must be `field?: T | null`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayStatus {
    /// The overlay feature is not enabled in this build at all.
    Disabled,
    /// Enabled, but the user turned the wake word off. Nothing is being heard.
    Muted,
    /// Armed and asleep: listening ONLY for the wake phrase.
    Idle,
    /// Awake and capturing what the user says.
    Listening,
    /// The utterance closed; thinking or answering. No live capture.
    Working,
    /// The last exchange failed.
    Error,
}

impl TrayStatus {
    /// Whether this status means a microphone is actively capturing the user's speech.
    ///
    /// This is the question the whole module exists to answer honestly, and it is deliberately a
    /// method on the enum rather than a `match` at each call site: a call site can forget a
    /// variant, and the compiler will not tell it so when the arm it forgot returns a bool.
    pub fn is_capturing(self) -> bool {
        matches!(self, TrayStatus::Listening)
    }

    /// The tooltip. Carries the distinction an icon cannot: "the feature is off" and "you muted it"
    /// are different facts, and collapsing them is how a user concludes they muted something that
    /// was never running.
    pub fn tooltip(self) -> &'static str {
        match self {
            TrayStatus::Disabled => "Sparkle overlay: off",
            TrayStatus::Muted => {
                "Sparkle overlay: muted — the wake word is off and nothing is being heard"
            }
            TrayStatus::Idle => "Sparkle overlay: waiting for the wake word",
            TrayStatus::Listening => "Sparkle overlay: listening to you now",
            TrayStatus::Working => "Sparkle overlay: thinking",
            TrayStatus::Error => "Sparkle overlay: the last request failed",
        }
    }
}

/// Whether a tray icon should exist at all.
///
/// Fails CLOSED on purpose. A tray icon is a permanent change to the user's menu bar, so "we could
/// not establish that the feature is on" must resolve to NOT installing one — the opposite default
/// would advertise a feature that cannot run.
pub fn tray_enabled(overlay_enabled: bool) -> bool {
    overlay_enabled
}

/// The overlay's own build flag, read from the process environment. Same name the frontend reads
/// (`components/SparkleOverlay/flag.ts`), so a dev running `VITE_SPARKLE_OVERLAY=1 pnpm tauri dev`
/// gets a frontend and a backend that agree.
pub const OVERLAY_FLAG_ENV: &str = "VITE_SPARKLE_OVERLAY";

/// A tray-only override, for turning the menu-bar presence on without mounting the overlay itself.
pub const OVERLAY_TRAY_ENV: &str = "SPARKLE_OVERLAY_TRAY";

/// The stable id the one tray icon is registered under, so a second call updates rather than
/// stacking a second icon in the menu bar.
pub const TRAY_ID: &str = "sparkle-overlay";

/// Parse one gate value. **Only an affirmative reading opens the gate.** `None` (the variable is
/// not set), an empty string and anything unrecognised all mean CLOSED — the same tri-state
/// discipline `autoLaunch.ts` applies to the launch-at-login preference, for the same reason: the
/// user never asked for this, so an unreadable answer is not permission.
pub fn parse_gate(raw: Option<&str>) -> bool {
    match raw {
        Some(v) => matches!(v.trim(), "1" | "true" | "on"),
        None => false,
    }
}

/// The gate. Open when EITHER flag reads affirmatively; an unreadable or absent flag contributes
/// nothing, so absence can never open it.
pub fn tray_gate_open(overlay_flag: Option<&str>, tray_flag: Option<&str>) -> bool {
    parse_gate(overlay_flag) || parse_gate(tray_flag)
}

/// Read the gate from the process environment. A variable that is unset — or set to something we
/// cannot read as a yes — leaves the gate shut.
pub fn tray_gate_open_from_env() -> bool {
    let overlay = std::env::var(OVERLAY_FLAG_ENV).ok();
    let tray = std::env::var(OVERLAY_TRAY_ENV).ok();
    tray_gate_open(overlay.as_deref(), tray.as_deref())
}

/// What a sync should DO to the menu bar, decided before anything touches it.
///
/// Split out from the effect so the decision is testable without a windowing system: the assertion
/// that matters ("with the gate shut nothing is ever created") is about this function, and its
/// paired positive ("with the gate open something IS created") is about the same one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    /// Build the icon. Reachable ONLY with the gate open.
    Create,
    /// It already exists — refresh its tooltip.
    Update,
    /// The gate closed under a tray that already exists. Take it out of the menu bar.
    Remove,
    /// Do nothing. This is the shipping default: gate shut, no tray was ever created.
    None,
}

/// Decide what to do. Total over the four states, so there is no implicit fall-through that could
/// quietly become a `Create`.
pub fn plan_tray(gate_open: bool, tray_exists: bool) -> TrayAction {
    match (gate_open, tray_exists) {
        (false, false) => TrayAction::None,
        (false, true) => TrayAction::Remove,
        (true, false) => TrayAction::Create,
        (true, true) => TrayAction::Update,
    }
}

/// The menu bar, reduced to the four things this module does to it.
///
/// This trait exists for ONE reason and it is worth stating rather than discovering: **creating a
/// real tray icon requires the main thread**, and `cargo test` runs every test on a spawned one
/// (`tray icon error: not on the main thread`). So "with the gate open a tray IS created" — the
/// paired positive without which the fail-closed assertion passes for code that can never create a
/// tray at all — is not assertable against a real `AppHandle` in this harness. Splitting the effect
/// out keeps that assertion, against a recording menu bar, while [`AppMenuBar`] below stays thin
/// enough that reading it is a fair substitute for testing it.
///
/// The main-thread constraint is also why [`overlay_tray_sync`] is a SYNC `#[tauri::command]`:
/// Tauri runs sync command bodies on the main thread, and an `async` one would not be.
pub trait TrayMenuBar {
    /// Whether an icon under [`TRAY_ID`] is in the menu bar right now.
    fn exists(&self) -> bool;
    /// Put one there.
    fn create(&mut self, tooltip: &str) -> Result<(), String>;
    /// Refresh the tooltip of the one already there.
    fn update(&mut self, tooltip: &str) -> Result<(), String>;
    /// Take it out.
    fn remove(&mut self);
}

/// The real menu bar, backed by a live `AppHandle`.
pub struct AppMenuBar<'a, R: Runtime> {
    app: &'a AppHandle<R>,
}

impl<'a, R: Runtime> AppMenuBar<'a, R> {
    pub fn new(app: &'a AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> TrayMenuBar for AppMenuBar<'_, R> {
    fn exists(&self) -> bool {
        self.app.tray_by_id(TRAY_ID).is_some()
    }

    fn create(&mut self, tooltip: &str) -> Result<(), String> {
        let mut builder = TrayIconBuilder::with_id(TRAY_ID).tooltip(tooltip);
        // The app icon, not a status-specific one. Shipping six menu-bar glyphs is a design
        // decision nobody has made; the tooltip already carries the distinction an icon cannot.
        if let Some(icon) = self.app.default_window_icon().cloned() {
            builder = builder.icon(icon);
        }
        builder.build(self.app).map(|_| ()).map_err(|e| e.to_string())
    }

    fn update(&mut self, tooltip: &str) -> Result<(), String> {
        match self.app.tray_by_id(TRAY_ID) {
            Some(tray) => tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string()),
            // Raced away between the plan and the apply. Nothing to update, and creating one here
            // would be a tray built outside the gate's decision.
            None => Ok(()),
        }
    }

    fn remove(&mut self) {
        self.app.remove_tray_by_id(TRAY_ID);
    }
}

/// Apply a derived status to the menu bar, under an explicit gate.
///
/// Returns whether a tray icon exists afterwards. The gate is a PARAMETER rather than an env read
/// so a test can drive both directions without mutating process state; [`overlay_tray_sync`] is the
/// one place that reads the environment.
pub fn sync_tray_with_gate(
    bar: &mut dyn TrayMenuBar,
    gate_open: bool,
    status: TrayStatus,
) -> Result<bool, String> {
    match plan_tray(gate_open, bar.exists()) {
        TrayAction::None => Ok(false),
        TrayAction::Remove => {
            bar.remove();
            Ok(false)
        }
        TrayAction::Update => {
            bar.update(status.tooltip())?;
            Ok(true)
        }
        TrayAction::Create => {
            bar.create(status.tooltip())?;
            Ok(true)
        }
    }
}

/// Publish a tray status derived by the frontend (`overlayTray/trayStatus.ts`).
///
/// Returns `true` when a tray icon exists in the menu bar afterwards, which is what the TS side
/// asserts on — "we asked" and "an icon appeared" are different facts and the caller gets the
/// second one.
///
/// SYNC on purpose, and it is the ONE command in this module that is — see [`TrayMenuBar`]. A tray
/// icon may only be built on the AppKit main thread, and Tauri runs sync command bodies there;
/// `spawn_blocking` would put it on a worker thread and the build would fail with `tray icon error:
/// not on the main thread`. It is named in `cmd_timing`'s `EXEMPT` for that reason. The body is a
/// tooltip string and one icon build, which is why paying the main thread for it is affordable —
/// the other three commands here are async precisely because their bodies are not.
#[tauri::command]
pub fn overlay_tray_sync(app: AppHandle, status: TrayStatus) -> Result<bool, String> {
    let mut bar = AppMenuBar::new(&app);
    sync_tray_with_gate(&mut bar, tray_gate_open_from_env(), status)
}

/// Whether the tray gate is open at all, so the frontend can skip the sync loop entirely.
#[tauri::command]
pub async fn overlay_tray_gate_open() -> bool {
    tray_gate_open_from_env()
}

/// Register (or unregister) the app to launch at login.
///
/// This is the OS side of `setAutoLaunch` in `overlayTray/autoLaunch.ts`, and it is deliberately
/// the FIRST half of that call: the preference is persisted only once this has returned Ok, so a
/// stored "on" is never a lie about the user's machine.
///
/// `spawn_blocking`, not inline: writing a LaunchAgent plist is filesystem work, and a
/// `#[tauri::command]` body that is not async runs on the AppKit main thread and freezes the UI for
/// its duration (`sparkle-rfhu5`).
#[tauri::command]
pub async fn overlay_auto_launch_set(app: AppHandle, enable: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.autolaunch();
        if enable {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What the OS actually says — as opposed to what we stored. Used to detect the two halves having
/// drifted apart (a user removing the login item by hand, say).
#[tauri::command]
pub async fn overlay_auto_launch_is_enabled(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.autolaunch().is_enabled().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolve the status to publish when the feature gate and the session disagree.
///
/// Ordered by AUTHORITY, not likelihood: a disabled overlay has no session and no opinion, so it
/// can never be talked back into claiming it is listening by a stale snapshot.
pub fn publish_status(overlay_enabled: bool, session: Option<TrayStatus>) -> TrayStatus {
    if !tray_enabled(overlay_enabled) {
        return TrayStatus::Disabled;
    }
    match session {
        // A session that reports Disabled while the gate says enabled is incoherent; the safe
        // reading is that nothing is running yet, which is Idle — never Listening.
        Some(TrayStatus::Disabled) | None => TrayStatus::Idle,
        Some(s) => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises the tests that mutate process environment variables. `cargo test` runs test
    /// functions as threads in ONE process, so an unguarded `set_var` here is visible to every
    /// other test at once.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    const ALL: [TrayStatus; 6] = [
        TrayStatus::Disabled,
        TrayStatus::Muted,
        TrayStatus::Idle,
        TrayStatus::Listening,
        TrayStatus::Working,
        TrayStatus::Error,
    ];

    #[test]
    fn only_listening_reports_capture() {
        // Swept over every variant rather than spot-checked: a promotion of any other state is the
        // exact defect this guards, and a spot check only catches the one I thought of.
        for s in ALL {
            assert_eq!(s.is_capturing(), s == TrayStatus::Listening, "{s:?}");
        }
    }

    #[test]
    fn a_disabled_overlay_never_publishes_listening() {
        for s in ALL {
            assert_eq!(publish_status(false, Some(s)), TrayStatus::Disabled, "{s:?}");
        }
        // PAIRED positive: with the gate open the same Listening snapshot DOES publish, so the
        // sweep above is a real negative and not a function that returns Disabled unconditionally.
        assert_eq!(
            publish_status(true, Some(TrayStatus::Listening)),
            TrayStatus::Listening
        );
    }

    #[test]
    fn an_absent_session_is_idle_never_listening() {
        assert_eq!(publish_status(true, None), TrayStatus::Idle);
    }

    #[test]
    fn an_incoherent_disabled_snapshot_resolves_down_to_idle() {
        assert_eq!(
            publish_status(true, Some(TrayStatus::Disabled)),
            TrayStatus::Idle
        );
    }

    #[test]
    fn muted_survives_the_gate_unchanged() {
        assert_eq!(publish_status(true, Some(TrayStatus::Muted)), TrayStatus::Muted);
    }

    #[test]
    fn the_gate_is_closed_by_default() {
        assert!(!tray_enabled(false));
        assert!(tray_enabled(true));
    }

    #[test]
    fn every_status_has_its_own_words_and_only_one_claims_live_capture() {
        let tips: Vec<&str> = ALL.iter().map(|s| s.tooltip()).collect();
        let mut unique = tips.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), tips.len(), "two statuses share a tooltip");

        for s in ALL {
            assert_eq!(
                s.tooltip().contains("listening to you now"),
                s == TrayStatus::Listening,
                "{s:?}"
            );
        }
        // The distinction an on/off icon cannot carry.
        assert_ne!(
            TrayStatus::Disabled.tooltip(),
            TrayStatus::Muted.tooltip()
        );
    }

    // ---- The gate. These are the tests that decide whether the shipping default changed. ----

    #[test]
    fn only_an_affirmative_reading_opens_the_gate() {
        for yes in ["1", "true", "on", " true "] {
            assert!(parse_gate(Some(yes)), "{yes:?}");
        }
        // ABSENT, EMPTY and UNREADABLE all mean closed. This is the fail-closed direction: the user
        // never asked for a menu-bar icon, so "we could not tell" is not permission.
        for no in ["", "0", "false", "off", "yes", "maybe", "TRUE", "  "] {
            assert!(!parse_gate(Some(no)), "{no:?}");
        }
        assert!(!parse_gate(None), "an unset variable must not open the gate");
    }

    #[test]
    fn absence_can_never_open_the_gate_even_beside_a_present_flag() {
        assert!(!tray_gate_open(None, None));
        assert!(!tray_gate_open(Some("garbage"), None));
        assert!(!tray_gate_open(None, Some("")));
        // PAIRED positive: either flag, read affirmatively, does open it — so the negatives above
        // are real and not a function that returns false unconditionally.
        assert!(tray_gate_open(Some("1"), None));
        assert!(tray_gate_open(None, Some("true")));
    }

    #[test]
    fn a_shut_gate_plans_nothing_and_an_open_one_plans_a_create() {
        // The shipping default: gate shut, nothing has ever been created, so nothing happens.
        assert_eq!(plan_tray(false, false), TrayAction::None);
        // A gate that closes under an existing tray takes it back out of the menu bar.
        assert_eq!(plan_tray(false, true), TrayAction::Remove);
        // PAIRED positive, without which the two above pass for code that can never create a tray.
        assert_eq!(plan_tray(true, false), TrayAction::Create);
        assert_eq!(plan_tray(true, true), TrayAction::Update);
    }

    #[test]
    fn create_is_reachable_from_no_shut_gate_state() {
        for exists in [false, true] {
            assert_ne!(plan_tray(false, exists), TrayAction::Create, "exists={exists}");
        }
    }

    // ---- The effect, against a real AppHandle. ----
    //
    // The plan tests above are about the DECISION; these are about the menu bar. Both are needed:
    // a correct plan that nothing applies is a feature that does not exist, and an applied effect
    // with no gate in front of it is the regression this whole module is gated to prevent.

    /// A menu bar that records what was done to it instead of talking to the window server.
    #[derive(Default)]
    struct RecordingBar {
        present: bool,
        calls: Vec<String>,
    }

    impl TrayMenuBar for RecordingBar {
        fn exists(&self) -> bool {
            self.present
        }
        fn create(&mut self, tooltip: &str) -> Result<(), String> {
            self.calls.push(format!("create:{tooltip}"));
            self.present = true;
            Ok(())
        }
        fn update(&mut self, tooltip: &str) -> Result<(), String> {
            self.calls.push(format!("update:{tooltip}"));
            Ok(())
        }
        fn remove(&mut self) {
            self.calls.push("remove".into());
            self.present = false;
        }
    }

    #[test]
    fn a_shut_gate_creates_no_tray_and_an_open_one_does() {
        let mut bar = RecordingBar::default();

        // GATE SHUT — the shipped default. Nothing touches the menu bar at all.
        let installed = sync_tray_with_gate(&mut bar, false, TrayStatus::Listening).unwrap();
        assert!(!installed, "a shut gate reported an installed tray");
        assert_eq!(bar.calls, Vec::<String>::new(), "a shut gate touched the menu bar");
        assert!(!bar.present);

        // GATE OPEN — the paired positive. Without this the assertion above passes for a function
        // that never creates a tray at all, which is exactly the state this bead is closing.
        let installed = sync_tray_with_gate(&mut bar, true, TrayStatus::Listening).unwrap();
        assert!(installed, "an open gate created no tray");
        assert!(bar.present, "an open gate put nothing in the menu bar");
        assert_eq!(bar.calls, vec!["create:Sparkle overlay: listening to you now"]);

        // A second sync UPDATES rather than stacking a second icon, and carries the new words.
        assert!(sync_tray_with_gate(&mut bar, true, TrayStatus::Muted).unwrap());
        assert_eq!(bar.calls.len(), 2);
        assert!(bar.calls[1].starts_with("update:Sparkle overlay: muted"));

        // And a gate that closes takes it back out again — a feature turned off must not leave a
        // permanent icon behind.
        let installed = sync_tray_with_gate(&mut bar, false, TrayStatus::Idle).unwrap();
        assert!(!installed);
        assert_eq!(bar.calls[2], "remove");
        assert!(!bar.present, "closing the gate left the icon in the menu bar");
    }

    #[test]
    fn a_create_that_fails_is_reported_and_not_papered_over() {
        struct RefusingBar;
        impl TrayMenuBar for RefusingBar {
            fn exists(&self) -> bool {
                false
            }
            fn create(&mut self, _: &str) -> Result<(), String> {
                Err("not on the main thread".into())
            }
            fn update(&mut self, _: &str) -> Result<(), String> {
                unreachable!()
            }
            fn remove(&mut self) {
                unreachable!()
            }
        }
        // `installed` must never come back true off a failed create — the TS side treats it as
        // "an icon exists", and a false yes there is a status surface nobody can see.
        let err = sync_tray_with_gate(&mut RefusingBar, true, TrayStatus::Idle).unwrap_err();
        assert!(err.contains("main thread"), "{err}");
    }

    #[test]
    fn the_real_menu_bar_adapter_puts_nothing_in_the_menu_bar_with_the_gate_shut() {
        // The REAL adapter against a REAL AppHandle, in the direction that ships. The open-gate
        // half cannot run here (a tray may only be built on the main thread, and this is not it),
        // which is precisely why `TrayMenuBar` exists and why the pair above uses a recording bar.
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let mut bar = AppMenuBar::new(&handle);

        assert!(!bar.exists(), "a fresh app already had a tray icon");
        let installed = sync_tray_with_gate(&mut bar, false, TrayStatus::Listening).unwrap();
        assert!(!installed);
        assert!(
            handle.tray_by_id(TRAY_ID).is_none(),
            "a shut gate put an icon in the menu bar"
        );
        // Removing when there is nothing to remove is a no-op, not a panic — the gate can close on
        // a session that never opened it.
        bar.remove();
        assert!(!bar.exists());
    }

    #[test]
    fn the_command_reads_the_environment_and_the_default_environment_is_shut() {
        // Pins the line the command uses to obtain its gate. Without this, `tray_gate_open_from_env`
        // is a defaulted seam covered by nothing — delete it, hardcode `true`, and every test above
        // still passes while every user grows a menu-bar icon.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved_overlay = std::env::var(OVERLAY_FLAG_ENV).ok();
        let saved_tray = std::env::var(OVERLAY_TRAY_ENV).ok();
        std::env::remove_var(OVERLAY_FLAG_ENV);
        std::env::remove_var(OVERLAY_TRAY_ENV);

        assert!(
            !tray_gate_open_from_env(),
            "an environment with neither flag set opened the gate"
        );
        std::env::set_var(OVERLAY_FLAG_ENV, "1");
        assert!(tray_gate_open_from_env(), "an affirmative flag left the gate shut");
        std::env::set_var(OVERLAY_FLAG_ENV, "nonsense");
        assert!(
            !tray_gate_open_from_env(),
            "an unreadable flag opened the gate — it must fail CLOSED"
        );

        match saved_overlay {
            Some(v) => std::env::set_var(OVERLAY_FLAG_ENV, v),
            None => std::env::remove_var(OVERLAY_FLAG_ENV),
        }
        if let Some(v) = saved_tray {
            std::env::set_var(OVERLAY_TRAY_ENV, v);
        }
    }

    #[test]
    fn the_wire_names_match_the_typescript_mirror() {
        // The TS side parses these strings. A rename on either side that is not made on both turns
        // the tray into a silently wrong icon, so the wire form is pinned here explicitly.
        let json = serde_json::to_string(&TrayStatus::Listening).unwrap();
        assert_eq!(json, "\"listening\"");
        assert_eq!(
            serde_json::to_string(&TrayStatus::Disabled).unwrap(),
            "\"disabled\""
        );
        assert_eq!(
            serde_json::to_string(&TrayStatus::Working).unwrap(),
            "\"working\""
        );
    }
}
