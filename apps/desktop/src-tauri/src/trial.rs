//! Device-local MIRROR of the free-trial meter (anonymous-free-trial design).
//!
//! The SERVER is authoritative for the 100-prompt cap: the counter lives in orchestration, keyed by
//! the opaque device token in the macOS keychain (see `trial_remote.rs`). `trial.json` is only a
//! cache — it holds the trial opt-in flag, an install id, and the LAST-KNOWN server numbers so the
//! UI has something to show before the first round-trip and so an offline user can keep working.
//!
//! That inversion is the point: deleting `trial.json` (or reinstalling the app) no longer resets the
//! trial, because the file was never the source of truth. It can only lose the cache; the next
//! successful `/trial/consume` or `/trial/status` re-clamps every number to the server's.
//!
//! Two invariants the reconcile logic below enforces, both revenue-relevant:
//!   • `blocked` (the hard-block / upgrade state) is set ONLY by an AFFIRMATIVE server answer — a
//!     402 at the cap, or a successful read that reports 0 remaining. A network failure NEVER
//!     blocks (fail-open), so a hiccup can't lock a paying-intent user out.
//!   • A server answer always WINS over the cache (clamp, don't merge), so an offline drift always
//!     resolves back to the server's count on reconnect.
//!
//! Inner `*_at` fns are pure (take the json path) so they unit-test without a Tauri runtime; the
//! `#[tauri::command]`s are thin wrappers resolving `app_data_dir`.

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

/// Persisted trial mirror. camelCase to match the JS shape.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrialState {
    pub install_id: String,
    pub started: bool,
    /// Last-known prompts spent. Mirrors the server counter; bumped locally only while offline.
    pub prompts_used: u32,
    /// Last-known remaining prompts. `None` = never heard from the server on this machine.
    #[serde(default)]
    pub cached_remaining: Option<u32>,
    /// Last-known cap the server reported (`None` until the first answer; JS falls back to 100).
    #[serde(default)]
    pub cached_cap: Option<u32>,
    /// The server AFFIRMATIVELY said the trial is spent (402, or 0 remaining on a successful read).
    /// Sticky across restarts so the upgrade state survives a relaunch without a round-trip — but
    /// never authoritative: clearing it (by deleting the file) just means the next server answer
    /// sets it again. NEVER set by a failed/offline call.
    #[serde(default)]
    pub server_exhausted: bool,
}

/// What the client managed to learn from the server about this device's trial. Deliberately a
/// three-way split: "the server said no" and "we couldn't ask" must never collapse into one state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServerVerdict {
    /// The server answered with authoritative numbers.
    Answered { prompts_used: u32, remaining: u32, cap: u32 },
    /// The server AFFIRMATIVELY refused: HTTP 402, the cap is spent. Hard block.
    Exhausted { cap: Option<u32> },
    /// The server couldn't be reached (transport error, mint failure, 5xx, unparseable body).
    /// Fail-open — the user keeps working against the local cache.
    Unreachable,
}

/// The trial meter as the UI consumes it. One shape for every path (local read, sync, consume) so
/// the JS store never has to branch on where a reading came from.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrialMeter {
    /// Anonymous per-install id (usage telemetry only — NOT the trial identity, which is the
    /// keychain device token).
    pub install_id: String,
    pub started: bool,
    pub prompts_used: u32,
    /// Best-known remaining prompts; `null` when the server has never been reached on this machine.
    pub remaining: Option<u32>,
    pub cap: Option<u32>,
    /// Hard-block: show the "trial ended — upgrade" state and refuse NEW submissions. Only ever
    /// true because the server said so (see `TrialState::server_exhausted`).
    pub blocked: bool,
    /// Whether the server confirmed these numbers *just now*. False for a purely local read or a
    /// fail-open (offline) consume — the UI uses it to avoid claiming the trial expired on a blip.
    pub server_confirmed: bool,
}

/// Serializes the read-modify-write of `trial.json` (mirrors `AccountsLock`).
#[derive(Default)]
pub struct TrialLock(pub std::sync::Mutex<()>);

impl TrialLock {
    pub fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 16 random bytes → 32 hex chars, from `/dev/urandom` (mirrors accounts.rs).
fn generate_install_id() -> Result<String, String> {
    let mut f = std::fs::File::open("/dev/urandom").map_err(|e| format!("urandom open: {e}"))?;
    let mut buf = [0u8; 16];
    f.read_exact(&mut buf).map_err(|e| format!("urandom read: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Read `trial.json`; absent file → default (empty install id). A present-but-bad file is a hard
/// error (never silently reset — the cache is not authoritative, but corruption still shouldn't be
/// papered over with a clean slate that reads as "fresh trial" in the UI).
pub fn read_trial_at(path: &Path) -> Result<TrialState, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("parse trial.json: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(TrialState::default()),
        Err(e) => Err(format!("read trial.json: {e}")),
    }
}

/// Atomic write (temp-in-same-dir then rename), mirrors `write_accounts_at`.
pub fn write_trial_at(path: &Path, state: &TrialState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir app data dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(state).map_err(|e| format!("serialize trial: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("write trial.json tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename trial.json into place: {e}")
    })
}

/// Read state, generating + persisting an install id the first time.
pub fn ensure_install_id_at(path: &Path) -> Result<TrialState, String> {
    let mut s = read_trial_at(path)?;
    if s.install_id.is_empty() {
        s.install_id = generate_install_id()?;
        write_trial_at(path, &s)?;
    }
    Ok(s)
}

/// Mark the trial opted-into (idempotent). Purely a UX flag — it grants nothing, since the cap is
/// metered server-side.
pub fn start_trial_at(path: &Path) -> Result<TrialState, String> {
    let mut s = ensure_install_id_at(path)?;
    if !s.started {
        s.started = true;
        write_trial_at(path, &s)?;
    }
    Ok(s)
}

/// Project the persisted mirror into the UI shape.
pub fn meter_from(s: &TrialState, server_confirmed: bool) -> TrialMeter {
    TrialMeter {
        install_id: s.install_id.clone(),
        started: s.started,
        prompts_used: s.prompts_used,
        remaining: s.cached_remaining,
        cap: s.cached_cap,
        blocked: s.server_exhausted,
        server_confirmed,
    }
}

/// Fold a server verdict into the local mirror and return the resulting meter.
///
/// `spent_one` says whether the caller was trying to CONSUME a prompt (vs. a read-only sync); it
/// only matters in the `Unreachable` branch, where the offline debit happens locally so the cached
/// count keeps counting down while the network is gone.
///
/// Clamping rule: an `Answered` verdict OVERWRITES every cached number — it never merges with local
/// drift — so an offline session that over- or under-counted snaps back to the truth on reconnect.
pub fn reconcile_at(
    path: &Path,
    verdict: ServerVerdict,
    spent_one: bool,
) -> Result<TrialMeter, String> {
    let mut s = ensure_install_id_at(path)?;
    let confirmed = !matches!(verdict, ServerVerdict::Unreachable);
    match verdict {
        ServerVerdict::Answered { prompts_used, remaining, cap } => {
            s.prompts_used = prompts_used;
            s.cached_remaining = Some(remaining);
            s.cached_cap = Some(cap);
            // A successful read that reports nothing left is just as affirmative as a 402.
            s.server_exhausted = remaining == 0;
        }
        ServerVerdict::Exhausted { cap } => {
            s.cached_remaining = Some(0);
            if let Some(c) = cap {
                s.cached_cap = Some(c);
                s.prompts_used = c;
            }
            s.server_exhausted = true;
        }
        ServerVerdict::Unreachable => {
            if spent_one {
                s.prompts_used = s.prompts_used.saturating_add(1);
                s.cached_remaining = s.cached_remaining.map(|r| r.saturating_sub(1));
            }
            // Deliberately NOT touching `server_exhausted`: a network failure must never create the
            // hard block, and must never clear one the server already handed down.
        }
    }
    write_trial_at(path, &s)?;
    Ok(meter_from(&s, confirmed))
}

pub fn trial_json_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::worktree::app_data_dir_pub(app)?.join("trial.json"))
}

/// Local-only read of the cached mirror. No network — used at startup so the gate resolves
/// instantly; `trial_remote::trial_sync` then clamps it to the server's numbers.
#[tauri::command]
pub fn trial_status(app: AppHandle, lock: State<'_, TrialLock>) -> Result<TrialMeter, String> {
    let _g = lock.guard();
    let s = ensure_install_id_at(&trial_json_path(&app)?)?;
    Ok(meter_from(&s, false))
}

#[tauri::command]
pub fn trial_start(app: AppHandle, lock: State<'_, TrialLock>) -> Result<TrialMeter, String> {
    let _g = lock.guard();
    let s = start_trial_at(&trial_json_path(&app)?)?;
    Ok(meter_from(&s, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        // A process-unique counter (not the wall clock) keeps the path collision-free even
        // when the default multi-threaded test harness runs these concurrently.
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let mut p = std::env::temp_dir();
        p.push(format!("sparkle-trial-test-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p.join("trial.json")
    }

    #[test]
    fn absent_file_seeds_install_id_and_zero_state() {
        let path = tmp();
        let s = ensure_install_id_at(&path).unwrap();
        assert_eq!(s.prompts_used, 0);
        assert!(!s.started);
        assert_eq!(s.install_id.len(), 32); // 16 bytes -> 32 hex chars
        // persisted: a second read returns the SAME install id
        let again = read_trial_at(&path).unwrap();
        assert_eq!(again.install_id, s.install_id);
    }

    #[test]
    fn start_sets_started_true_idempotently() {
        let path = tmp();
        ensure_install_id_at(&path).unwrap();
        let s = start_trial_at(&path).unwrap();
        assert!(s.started);
        let again = start_trial_at(&path).unwrap();
        assert!(again.started);
        assert_eq!(again.install_id, s.install_id);
    }

    #[test]
    fn corrupt_file_is_a_hard_error_never_silently_reset() {
        // A present-but-unparseable trial.json must error, NOT reset to defaults — the file is only
        // a cache, but silently zeroing it would still paint a "fresh trial" UI until the next
        // server answer lands.
        let path = tmp();
        std::fs::write(&path, b"not json at all").unwrap();
        assert!(read_trial_at(&path).is_err());
        assert!(ensure_install_id_at(&path).is_err());
        assert!(reconcile_at(&path, ServerVerdict::Unreachable, true).is_err());
    }

    #[test]
    fn populated_state_survives_a_round_trip() {
        let path = tmp();
        let state = TrialState {
            install_id: "abc123".into(),
            started: true,
            prompts_used: 42,
            cached_remaining: Some(58),
            cached_cap: Some(100),
            server_exhausted: false,
        };
        write_trial_at(&path, &state).unwrap();
        assert_eq!(read_trial_at(&path).unwrap(), state);
    }

    #[test]
    fn a_pre_cutover_trial_json_still_parses() {
        // Files written by the device-local-counter build have none of the cache fields. They must
        // load (as "never heard from the server"), not hard-error every user into the Welcome screen.
        let path = tmp();
        std::fs::write(&path, br#"{"installId":"old","started":true,"promptsUsed":7}"#).unwrap();
        let s = read_trial_at(&path).unwrap();
        assert_eq!(s.prompts_used, 7);
        assert_eq!(s.cached_remaining, None);
        assert!(!s.server_exhausted);
    }

    #[test]
    fn a_successful_consume_clamps_to_the_server_numbers() {
        let path = tmp();
        let m = reconcile_at(
            &path,
            ServerVerdict::Answered { prompts_used: 12, remaining: 88, cap: 100 },
            true,
        )
        .unwrap();
        assert_eq!(m.prompts_used, 12);
        assert_eq!(m.remaining, Some(88));
        assert_eq!(m.cap, Some(100));
        assert!(!m.blocked);
        assert!(m.server_confirmed);
    }

    #[test]
    fn an_affirmative_402_hard_blocks_and_persists() {
        let path = tmp();
        let m = reconcile_at(&path, ServerVerdict::Exhausted { cap: Some(100) }, true).unwrap();
        assert!(m.blocked);
        assert_eq!(m.remaining, Some(0));
        assert_eq!(m.prompts_used, 100);
        // Sticky: a relaunch (local read, no network) still shows the hard block.
        assert!(meter_from(&read_trial_at(&path).unwrap(), false).blocked);
    }

    #[test]
    fn a_successful_read_of_zero_remaining_blocks_too() {
        let path = tmp();
        let m = reconcile_at(
            &path,
            ServerVerdict::Answered { prompts_used: 100, remaining: 0, cap: 100 },
            false,
        )
        .unwrap();
        assert!(m.blocked);
    }

    #[test]
    fn offline_fails_open_and_decrements_the_cache_without_blocking() {
        let path = tmp();
        reconcile_at(&path, ServerVerdict::Answered { prompts_used: 98, remaining: 2, cap: 100 }, false)
            .unwrap();
        // Three offline sends: the cache counts down and FLOORS at 0 — but never blocks, because the
        // server never said so. A blip must not look like an expired trial.
        for _ in 0..3 {
            let m = reconcile_at(&path, ServerVerdict::Unreachable, true).unwrap();
            assert!(!m.blocked, "offline must never hard-block");
            assert!(!m.server_confirmed);
        }
        let s = read_trial_at(&path).unwrap();
        assert_eq!(s.cached_remaining, Some(0));
        assert_eq!(s.prompts_used, 101);
    }

    #[test]
    fn an_offline_read_only_sync_does_not_spend_a_prompt() {
        let path = tmp();
        reconcile_at(&path, ServerVerdict::Answered { prompts_used: 5, remaining: 95, cap: 100 }, false)
            .unwrap();
        reconcile_at(&path, ServerVerdict::Unreachable, false).unwrap();
        let s = read_trial_at(&path).unwrap();
        assert_eq!(s.prompts_used, 5);
        assert_eq!(s.cached_remaining, Some(95));
    }

    #[test]
    fn reconnect_clamps_offline_drift_back_to_the_server() {
        let path = tmp();
        reconcile_at(&path, ServerVerdict::Answered { prompts_used: 50, remaining: 50, cap: 100 }, false)
            .unwrap();
        // Offline drift in BOTH directions is discarded on the next answered call.
        for _ in 0..10 {
            reconcile_at(&path, ServerVerdict::Unreachable, true).unwrap();
        }
        assert_eq!(read_trial_at(&path).unwrap().prompts_used, 60);
        let m = reconcile_at(
            &path,
            ServerVerdict::Answered { prompts_used: 55, remaining: 45, cap: 100 },
            true,
        )
        .unwrap();
        assert_eq!(m.prompts_used, 55, "the server wins — clamp, never merge");
        assert_eq!(m.remaining, Some(45));
    }

    #[test]
    fn a_network_failure_never_clears_an_existing_hard_block() {
        let path = tmp();
        reconcile_at(&path, ServerVerdict::Exhausted { cap: Some(100) }, true).unwrap();
        let m = reconcile_at(&path, ServerVerdict::Unreachable, true).unwrap();
        assert!(m.blocked, "going offline must not buy more prompts");
    }

    #[test]
    fn the_server_can_lift_a_block_after_the_user_converts_or_is_re_granted() {
        let path = tmp();
        reconcile_at(&path, ServerVerdict::Exhausted { cap: Some(100) }, true).unwrap();
        let m = reconcile_at(
            &path,
            ServerVerdict::Answered { prompts_used: 0, remaining: 100, cap: 100 },
            false,
        )
        .unwrap();
        assert!(!m.blocked);
    }

    #[test]
    fn deleting_trial_json_loses_only_the_cache_not_the_trial() {
        // The revenue invariant. The file carries no entitlement of its own: after deleting it the
        // very next server answer re-establishes the block, because the identity that keys the
        // counter is the KEYCHAIN device token, not anything in here.
        let path = tmp();
        reconcile_at(&path, ServerVerdict::Exhausted { cap: Some(100) }, true).unwrap();
        std::fs::remove_file(&path).unwrap();
        // Fresh mirror: nothing local remembers the block…
        assert!(!meter_from(&read_trial_at(&path).unwrap(), false).blocked);
        // …and being offline does NOT grant prompts back that the server still refuses.
        assert!(!reconcile_at(&path, ServerVerdict::Unreachable, true).unwrap().blocked);
        // …but the first real answer from the server restores it immediately.
        let m = reconcile_at(&path, ServerVerdict::Exhausted { cap: Some(100) }, true).unwrap();
        assert!(m.blocked);
        assert_eq!(m.remaining, Some(0));
    }

    #[test]
    fn a_402_without_a_cap_still_blocks() {
        // The 402 body is the server's; if `cap` is ever missing/reworded we must still hard-block
        // rather than fall through to "allowed".
        let path = tmp();
        let m = reconcile_at(&path, ServerVerdict::Exhausted { cap: None }, true).unwrap();
        assert!(m.blocked);
        assert_eq!(m.remaining, Some(0));
    }
}
