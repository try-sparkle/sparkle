//! Device-local free-trial meter (anonymous-free-trial design). Tracks an install
//! id, whether the user opted into the trial, and how many worker prompts they've
//! spent — persisted as `<app_data>/trial.json`. This is the source of truth for the
//! 100-prompt cap; it is intentionally device-local (a reinstall resets it — accepted
//! for v1) and never leaves the machine. Entitled users are never metered.
//!
//! Inner `*_at` fns are pure (take the json path) so they unit-test without a Tauri
//! runtime; the `#[tauri::command]`s are thin wrappers resolving `app_data_dir`.

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

/// Persisted trial state. camelCase to match the JS shape.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrialState {
    pub install_id: String,
    pub started: bool,
    pub prompts_used: u32,
}

/// Serializes the read-modify-write of `trial.json` (mirrors `AccountsLock`).
#[derive(Default)]
pub struct TrialLock(pub std::sync::Mutex<()>);

impl TrialLock {
    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
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

/// Read `trial.json`; absent file → default (empty install id). A present-but-bad
/// file is a hard error (never silently reset, which would re-grant the trial).
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

/// Mark the trial opted-into (idempotent).
pub fn start_trial_at(path: &Path) -> Result<TrialState, String> {
    let mut s = ensure_install_id_at(path)?;
    if !s.started {
        s.started = true;
        write_trial_at(path, &s)?;
    }
    Ok(s)
}

/// Increment the spent-prompt counter and persist; returns the new state.
pub fn increment_trial_at(path: &Path) -> Result<TrialState, String> {
    let mut s = ensure_install_id_at(path)?;
    s.prompts_used = s.prompts_used.saturating_add(1);
    write_trial_at(path, &s)?;
    Ok(s)
}

fn trial_json_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::worktree::app_data_dir_pub(app)?.join("trial.json"))
}

#[tauri::command]
pub fn trial_status(app: AppHandle, lock: State<'_, TrialLock>) -> Result<TrialState, String> {
    let _g = lock.guard();
    ensure_install_id_at(&trial_json_path(&app)?)
}

#[tauri::command]
pub fn trial_start(app: AppHandle, lock: State<'_, TrialLock>) -> Result<TrialState, String> {
    let _g = lock.guard();
    start_trial_at(&trial_json_path(&app)?)
}

#[tauri::command]
pub fn trial_increment(app: AppHandle, lock: State<'_, TrialLock>) -> Result<TrialState, String> {
    let _g = lock.guard();
    increment_trial_at(&trial_json_path(&app)?)
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
    fn increment_counts_up_and_persists() {
        let path = tmp();
        ensure_install_id_at(&path).unwrap();
        assert_eq!(increment_trial_at(&path).unwrap().prompts_used, 1);
        assert_eq!(increment_trial_at(&path).unwrap().prompts_used, 2);
        assert_eq!(read_trial_at(&path).unwrap().prompts_used, 2);
    }

    #[test]
    fn corrupt_file_is_a_hard_error_never_silently_reset() {
        // Security invariant: a present-but-unparseable trial.json must error, NOT reset to
        // defaults — silently resetting would re-grant the trial and zero the prompt counter.
        let path = tmp();
        std::fs::write(&path, b"not json at all").unwrap();
        assert!(read_trial_at(&path).is_err());
        assert!(ensure_install_id_at(&path).is_err());
        assert!(increment_trial_at(&path).is_err());
    }

    #[test]
    fn populated_state_survives_a_round_trip() {
        let path = tmp();
        let state = TrialState { install_id: "abc123".into(), started: true, prompts_used: 42 };
        write_trial_at(&path, &state).unwrap();
        assert_eq!(read_trial_at(&path).unwrap(), state);
    }
}
