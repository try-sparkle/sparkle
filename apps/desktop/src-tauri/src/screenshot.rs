//! Interactive screen-region capture.
//!
//! Uses macOS's built-in `/usr/sbin/screencapture -i`, which dims the screen and
//! hands the user the native crosshair to drag out a region (or Esc to cancel).
//! We write the PNG to a temp file and return BOTH:
//!   - `path`     — so the caller can reference the image in a CLI prompt (the
//!     Claude Code CLI reads image paths natively), and
//!   - `data_url` — a `data:image/png;base64,…` so the UI can render a thumbnail
//!     without a second IPC round-trip.
//!
//! First use triggers the macOS Screen Recording permission prompt; once granted,
//! Sparkle keeps the grant in System Settings → Privacy & Security.

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

#[derive(Serialize)]
pub struct Screenshot {
    /// Absolute path to the captured PNG in the OS temp dir.
    path: String,
    /// `data:image/png;base64,…` for an inline <img> preview.
    data_url: String,
}

/// Launch the macOS interactive region picker and return the captured PNG.
///
/// Returns `Ok(None)` when the user presses Esc — `screencapture` exits 0 but
/// writes no file, which is a cancel, not an error.
///
/// `async` + `spawn_blocking`: `screencapture -i` blocks until the user finishes
/// the selection (potentially many seconds). Running it on a blocking thread keeps
/// the Tauri main/UI thread responsive while the picker is up.
#[tauri::command]
pub async fn capture_screen_region() -> Result<Option<Screenshot>, String> {
    tauri::async_runtime::spawn_blocking(capture_blocking)
        .await
        .map_err(|e| format!("capture task failed: {e}"))?
}

fn capture_blocking() -> Result<Option<Screenshot>, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let path = std::env::temp_dir().join(format!("sparkle-shot-{stamp}.png"));

    // -i: interactive crosshair selection.  -x: silence the shutter sound.
    let status = Command::new("/usr/sbin/screencapture")
        .arg("-i")
        .arg("-x")
        .arg(&path)
        .status()
        .map_err(|e| format!("failed to launch screencapture: {e}"))?;

    if !status.success() {
        return Err(format!("screencapture exited with {status}"));
    }

    // Esc / cancel: exit 0 but no file written.
    if !path.exists() {
        return Ok(None);
    }

    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let data_url = format!("data:image/png;base64,{}", STANDARD.encode(&bytes));

    Ok(Some(Screenshot {
        path: path.to_string_lossy().into_owned(),
        data_url,
    }))
}
