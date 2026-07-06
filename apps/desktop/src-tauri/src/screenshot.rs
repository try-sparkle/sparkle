//! Interactive screen-region capture.
//!
//! Uses macOS's built-in `/usr/sbin/screencapture -i`, which dims the screen and
//! hands the user the native crosshair to drag out a region (or Esc to cancel).
//! We write the PNG to a temp file and return BOTH:
//!   - `path`     — the FULL-RESOLUTION PNG, so the caller can reference the image
//!     in a CLI prompt (the Claude Code CLI reads image paths natively), and
//!   - `data_url` — a `data:image/png;base64,…` of a DOWNSCALED copy so the UI can
//!     render a thumbnail without a second IPC round-trip. We downscale the preview
//!     (not the full-res file) because base64-ing a full retina screenshot and
//!     shipping it over the IPC bridge was the dominant post-capture lag.
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

/// The preview's max dimension. Captures larger than this (e.g. a full retina screen) get
/// downscaled for the inline `data:` URL; smaller ones are sent as-is.
const PREVIEW_MAX_DIM: u32 = 1600;

/// Read a PNG's pixel dimensions straight from its IHDR (first 24 bytes) without decoding the
/// image — signature(8) + chunk len(4) + "IHDR"(4) then width(4) + height(4), all big-endian.
/// Returns None if the file isn't a PNG we recognize (caller then skips the size optimization).
fn png_dimensions(path: &std::path::Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut header = [0u8; 24];
    std::fs::File::open(path).ok()?.read_exact(&mut header).ok()?;
    if &header[0..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let w = u32::from_be_bytes([header[16], header[17], header[18], header[19]]);
    let h = u32::from_be_bytes([header[20], header[21], header[22], header[23]]);
    Some((w, h))
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

    // Build a DOWNSCALED preview for the inline `data:` URL. base64-ing a full-screen retina PNG
    // (often 5–15 MB) and shipping it over the Tauri IPC bridge is the dominant post-capture lag;
    // the preview only needs to be a thumbnail, so we first shrink it with macOS's built-in `sips`
    // (no extra Rust deps; `-Z 1600` only ever downscales, never upscales) and base64 THAT. The
    // full-res file at `path` is untouched — that's what the CLI/agent reads. If `sips` is missing
    // or fails, we fall back to the full-res bytes so a preview is always produced. Runs on a
    // blocking task (see `capture_screen_region`) so the UI thread is never stalled; timed + sized
    // so the cost stays visible in the logs.
    // Only downscale when the capture actually exceeds the preview box; `sips -Z` would otherwise
    // UPSCALE a small selection (it sets the max dimension to exactly N), bloating the preview.
    let needs_downscale = png_dimensions(&path).is_some_and(|(w, h)| w.max(h) > PREVIEW_MAX_DIM);
    let preview_path = std::env::temp_dir().join(format!("sparkle-shot-{stamp}-preview.png"));
    let downscaled = needs_downscale
        && Command::new("/usr/bin/sips")
            .args(["-Z", &PREVIEW_MAX_DIM.to_string(), "--out"])
            .arg(&preview_path)
            .arg(&path)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        && preview_path.exists();
    let read_path = if downscaled { &preview_path } else { &path };

    let bytes = std::fs::read(read_path).map_err(|e| e.to_string())?;
    let encode_start = std::time::Instant::now();
    let data_url = format!("data:image/png;base64,{}", STANDARD.encode(&bytes));
    tracing::info!(
        png_bytes = bytes.len(),
        data_url_len = data_url.len(),
        downscaled,
        encode_ms = encode_start.elapsed().as_millis() as u64,
        "capture: encoded screenshot preview data URL"
    );
    // Best-effort cleanup: remove the preview temp file regardless of whether sips reported success
    // — a failed or killed-mid-write sips run can still leave a stale/partial file behind. Harmless
    // (ignored error) when the file was never created.
    let _ = std::fs::remove_file(&preview_path);

    Ok(Some(Screenshot {
        path: path.to_string_lossy().into_owned(),
        data_url,
    }))
}

#[cfg(test)]
mod tests {
    use super::{png_dimensions, PREVIEW_MAX_DIM};
    use std::io::Write;

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        // Prefix with the pid so concurrent `cargo test` processes (dev + CI, or two CI jobs) can't
        // collide on a shared temp path and truncate each other's fixtures.
        let p = std::env::temp_dir().join(format!("sparkle-shottest-{}-{}", std::process::id(), name));
        std::fs::File::create(&p).unwrap().write_all(bytes).unwrap();
        p
    }

    /// A minimal 24-byte PNG header: signature + IHDR len/type + width/height (big-endian).
    /// png_dimensions only inspects these first 24 bytes, so no real image data is needed.
    fn png_header(w: u32, h: u32) -> Vec<u8> {
        let mut b = Vec::with_capacity(24);
        b.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        b.extend_from_slice(&13u32.to_be_bytes()); // IHDR chunk length
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b
    }

    #[test]
    fn reads_valid_png_dimensions() {
        let p = write_temp("sparkle-test-dims.png", &png_header(3200, 2400));
        assert_eq!(png_dimensions(&p), Some((3200, 2400)));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn rejects_non_png() {
        let p = write_temp("sparkle-test-notpng.png", b"not a png file at all!!!!");
        assert_eq!(png_dimensions(&p), None);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn rejects_truncated_header() {
        let p = write_temp("sparkle-test-trunc.png", b"\x89PNG\r\n\x1a\n\x00\x00");
        assert_eq!(png_dimensions(&p), None);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn downscale_boundary_at_and_over_max() {
        let at = write_temp("sparkle-test-at.png", &png_header(PREVIEW_MAX_DIM, 900));
        let over = write_temp("sparkle-test-over.png", &png_header(PREVIEW_MAX_DIM + 1, 900));
        // At exactly the max → no downscale; one pixel over → downscale.
        assert!(png_dimensions(&at).is_some_and(|(w, h)| w.max(h) <= PREVIEW_MAX_DIM));
        assert!(png_dimensions(&over).is_some_and(|(w, h)| w.max(h) > PREVIEW_MAX_DIM));
        let _ = std::fs::remove_file(&at);
        let _ = std::fs::remove_file(&over);
    }
}
