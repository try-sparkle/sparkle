//! Is a Sparkle key window on screen, at the NATIVE level? (bead sparkle-thm9o)
//!
//! The input-freeze trace (`apps/desktop/src/diagnostics/inputFreezeTrace.ts`) can only ever see
//! keystrokes that REACH the webview. When the app goes input-dead the decisive question is the one
//! it structurally cannot answer: were the keys arriving at the OS window and landing nowhere, or
//! never arriving at all? A dead webview writes the same thing either way — nothing. This module
//! answers it from OUTSIDE the webview.
//!
//! Three properties are deliberate:
//!
//!  - **Lock-free.** The state is four atomics. `WindowEvent::Focused` is delivered on the MAIN
//!    thread, and a sync `#[tauri::command]` body runs on the main thread too — a mutex shared
//!    between them is precisely the shape that has frozen this app's whole UI before. Nothing here
//!    can block, so a diagnostic for a freeze cannot itself become one.
//!  - **The command is `async`.** Tauri drives async command bodies on its async runtime rather
//!    than the main thread, so even a wedged main thread cannot make this call hang the caller.
//!    It touches only atomics, so it never needs the main thread at all.
//!  - **It logs from RUST, not just over the bridge.** The transition is written to the same log
//!    file by the backend, so the signal survives a webview that is wedged, unmounted, or simply
//!    never receives the emit. That independence is the entire point: if the frontend could be
//!    trusted to report this, the trace would already have reported it.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static KEY: AtomicBool = AtomicBool::new(false);
static LABEL_HASH: AtomicU64 = AtomicU64::new(0);
static CHANGED_AT_MS: AtomicU64 = AtomicU64::new(0);
static EVENTS: AtomicU64 = AtomicU64::new(0);

/// The state this module keeps, as a value — so the transition rule below is unit-testable without
/// a live `AppHandle` and without touching the process-wide statics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyState {
    /// Does a Sparkle window that can hold the caret currently have OS key focus?
    pub key: bool,
    /// Hash of the label we last saw GAIN focus. A hash and not a `String` on purpose: it keeps the
    /// shared state a plain `AtomicU64`, so the main-thread writer needs no allocation and no lock.
    pub label_hash: u64,
}

/// FNV-1a over the label's bytes. Labels are only ever COMPARED here, never displayed, so a hash is
/// sufficient — and a collision would at worst mis-attribute one blur, which the rule below already
/// treats as the benign direction.
pub fn label_hash(label: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in label.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

/// The transition rule, pure.
///
/// A `Focused(false)` is believed only from the window we last saw GAIN focus. Without that filter
/// an ordinary internal window switch reads as "no key window at all": macOS delivers the two
/// events in either order, and in the `B gains, then A reports its loss` ordering the stale blur
/// would clear a flag that is actually true. A false "not-key" during a freeze is worse than no
/// signal, because it would send the reader looking for a window-server problem that is not there.
pub fn next_key_state(prev: KeyState, label_hash: u64, focused: bool) -> KeyState {
    if focused {
        KeyState { key: true, label_hash }
    } else if prev.label_hash == label_hash {
        KeyState { key: false, label_hash: prev.label_hash }
    } else {
        prev
    }
}

/// What the frontend reads. Booleans and durations only — nothing here can carry PII, which keeps
/// the freeze WARN line's no-PII contract intact when this is appended to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyWindowSnapshot {
    /// Was a caret-capable Sparkle window key as of the last event we saw?
    pub key: bool,
    /// How long it has held that value, in ms.
    pub since_ms: u64,
    /// How many focus events have been observed at all. Zero means UNOBSERVED — distinct from
    /// "not key", and the frontend renders it differently, because a freeze diagnosed off a
    /// never-initialised default would be diagnosed wrong.
    pub events: u64,
}

/// Compose a snapshot from explicit inputs. Split out from the statics so the arithmetic — the
/// saturating subtraction in particular — is testable; a clock that steps backwards must not
/// produce an absurd age.
pub fn compose(key: bool, events: u64, changed_at_ms: u64, now_ms: u64) -> KeyWindowSnapshot {
    KeyWindowSnapshot { key, events, since_ms: now_ms.saturating_sub(changed_at_ms) }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Feed every `WindowEvent::Focused`. Filtered by `frontmost::is_typing_window` so the
/// non-activating helper island never counts: it deliberately does not take the caret, so letting
/// it set `key` would report a key window at the exact moment the user has none.
pub fn note_focus(label: &str, focused: bool) {
    if !crate::frontmost::is_typing_window(label) {
        return;
    }
    let h = label_hash(label);
    let prev =
        KeyState { key: KEY.load(Ordering::Relaxed), label_hash: LABEL_HASH.load(Ordering::Relaxed) };
    let next = next_key_state(prev, h, focused);
    EVENTS.fetch_add(1, Ordering::Relaxed);
    LABEL_HASH.store(next.label_hash, Ordering::Relaxed);
    if next.key != prev.key {
        KEY.store(next.key, Ordering::Relaxed);
        CHANGED_AT_MS.store(now_ms(), Ordering::Relaxed);
        // Same `focus-trace:` prefix the frontend uses, so ONE grep over the log file returns both
        // the native transitions and the webview's keystroke fingerprints, interleaved in time.
        // That interleaving is the diagnosis: a native `key=true` with no fingerprint lines after
        // it means keys reached the window and died before the webview.
        tracing::info!(
            target: "dictation",
            "focus-trace: native key-window {} (window={})",
            if next.key { "GAINED" } else { "LOST" },
            label
        );
    }
}

/// Read the native key-window state.
///
/// `async` deliberately — see the module header. The body touches only atomics, so it neither
/// blocks nor needs the main thread, which is what makes it safe to call from a freeze diagnostic.
#[tauri::command]
pub async fn main_window_key_state() -> KeyWindowSnapshot {
    compose(
        KEY.load(Ordering::Relaxed),
        EVENTS.load(Ordering::Relaxed),
        CHANGED_AT_MS.load(Ordering::Relaxed),
        now_ms(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: u64 = 1;
    const OTHER: u64 = 2;

    #[test]
    fn a_focus_gain_sets_key_and_records_the_window() {
        let s = next_key_state(KeyState { key: false, label_hash: 0 }, MAIN, true);
        assert_eq!(s, KeyState { key: true, label_hash: MAIN });
    }

    #[test]
    fn a_blur_from_the_focused_window_clears_key() {
        let s = next_key_state(KeyState { key: true, label_hash: MAIN }, MAIN, false);
        assert!(!s.key);
    }

    // The rule's whole reason for existing. `B gains, then A reports its loss` is a normal ordering
    // for an internal window switch, and believing that stale blur would report "no key window"
    // while the user is typing happily in B.
    #[test]
    fn a_stale_blur_from_a_different_window_is_ignored() {
        let after_switch = KeyState { key: true, label_hash: OTHER };
        let s = next_key_state(after_switch, MAIN, false);
        assert_eq!(s, after_switch, "a blur from a window that no longer holds focus must not clear key");
    }

    #[test]
    fn the_other_ordering_also_ends_key() {
        // A blurs, then B gains: the intermediate state is honestly not-key, and B restores it.
        let a = next_key_state(KeyState { key: true, label_hash: MAIN }, MAIN, false);
        assert!(!a.key);
        let b = next_key_state(a, OTHER, true);
        assert!(b.key);
        assert_eq!(b.label_hash, OTHER);
    }

    #[test]
    fn label_hash_separates_the_labels_this_app_actually_uses() {
        let labels = ["main", "helper", "capture", "project-1", "project-2"];
        for (i, a) in labels.iter().enumerate() {
            for b in labels.iter().skip(i + 1) {
                assert_ne!(label_hash(a), label_hash(b), "{a} and {b} collide");
            }
        }
        assert_eq!(label_hash("main"), label_hash("main"), "must be stable");
    }

    #[test]
    fn snapshot_reports_the_age_of_the_current_value() {
        let s = compose(true, 3, 1_000, 4_500);
        assert!(s.key);
        assert_eq!(s.since_ms, 3_500);
        assert_eq!(s.events, 3);
    }

    // A backwards clock step must not report an absurd age — this line ends up in a log a human
    // reads under time pressure, and `since_ms=18446744073709551615` is worse than useless.
    #[test]
    fn a_backwards_clock_saturates_to_zero_rather_than_wrapping() {
        assert_eq!(compose(true, 1, 5_000, 4_000).since_ms, 0);
    }

    // Zero events means we have never seen a focus event, which is NOT the same claim as "no window
    // is key" — the frontend renders it as `unobserved` for exactly that reason.
    #[test]
    fn events_zero_is_carried_through_so_unobserved_is_distinguishable() {
        assert_eq!(compose(false, 0, 0, 9_000).events, 0);
    }
}
