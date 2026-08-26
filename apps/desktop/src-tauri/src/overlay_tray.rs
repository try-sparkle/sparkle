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

use serde::{Deserialize, Serialize};

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
