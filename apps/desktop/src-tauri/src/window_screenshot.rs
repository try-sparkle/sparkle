//! NON-INTERACTIVE capture of Sparkle's OWN window — the Rust half of the concierge's `screenshot`
//! domain (PRD section L).
//!
//! NAMED `window_screenshot`, NOT `window_capture`, and that is worth a line because the near-miss
//! cost a review round. `capture_window.rs` already exists and is a completely unrelated module —
//! the transparent always-on-top panel that renders the voice-narrated screenshot modal, whose
//! `CAPTURE_LABEL` `frontmost.rs` re-exports. The concierge op this module serves is ALSO called
//! `capture_window` (a wire name, so it stays). A file named `window_capture.rs` made that token
//! mean three different things, and a grep for any one of them landed on the other two.
//!
//! DISTINCT FROM `screenshot.rs`, WHICH STAYS. That module is the HUMAN's crosshair picker
//! (`screencapture -i`): it dims the screen, waits for a drag, and returns a base64 data URL for an
//! inline thumbnail. None of that is usable from a tool call — a concierge turn has nobody to drag a
//! rectangle, and a data URL is exactly what must not come back (see "WHERE THE BYTES GO"). What IS
//! reused is the mechanism: the same `/usr/sbin/screencapture` binary, so there is ONE macOS
//! Screen-Recording grant covering both paths rather than a second capture stack with its own
//! permission story. This module drives it with `-R` (a fixed region) instead of `-i`.
//!
//! ---------------------------------------------------------------------------------------------
//! THE CLAMP IS THE SECURITY BOUNDARY, and it is the reason this module exists rather than a bare
//! "capture this rect" command.
//!
//! `capture_main_window_region` takes a rect the FRONTEND computed from a DOM element — one
//! layer up, a rect that arrives on a wire a model can influence. `screencapture -R` will happily
//! photograph any region of any display, so an unclamped command would be a general-purpose "read
//! the user's screen" primitive: a hallucinated (or coaxed) rect could return the human's mail
//! client, their password manager, or a colleague's shared screen. So every requested rect is
//! INTERSECTED with the main window's own bounds before it reaches the shutter, and a rect that
//! misses the window entirely is refused rather than clamped to a sliver. The worst a wrong rect can
//! do is photograph the wrong part of Sparkle.
//!
//! HONEST LIMITATION, stated because the clamp invites the opposite assumption: `-R` captures the
//! SCREEN AREA the window occupies, not the window's own buffer. Anything drawn on top of Sparkle —
//! another app's window, a notification banner — appears in the shot. Capturing the window itself
//! regardless of occlusion needs its CGWindowID, which Tauri does not expose. Callers must not
//! describe a capture as "what Sparkle is showing"; it is "what is on screen where Sparkle is".
//!
//! ---------------------------------------------------------------------------------------------
//! WHERE THE BYTES GO: A PATH, NEVER THE PIXELS.
//!
//! Every result here is `{ path, width, height, bytes, downscaled }` — a file on disk plus its
//! measurements. The
//! bytes themselves are NOT returned, and that is the single most consequential decision in this
//! module.
//!
//! A tool reply crosses the bridge into an LLM context window and is metered on the way. A retina
//! main window is roughly 3200×2000; as PNG that is commonly 5–15 MB, and base64 inflates it by
//! another third. Returning that inline would spend a large fraction of a context window on one
//! screenshot and bill for it — and it would do so on EVERY call, including the ones where the
//! concierge only wanted to know whether the window was on the login screen. A path costs ~80 bytes,
//! and the reader can open the image if (and only if) it actually needs to look. The Claude Code CLI
//! reads image paths natively, so nothing is lost by handing over the path.
//!
//! TWO CAPS, because "write it to a file" is not by itself a bound:
//!   • DIMENSION (the real one) — anything whose long edge exceeds [`CAPTURE_MAX_DIM`] is downscaled
//!     with `sips -Z`, the same tool and the same one-way-only flag `screenshot.rs` uses. A 1600px
//!     shot is legible for "what is on screen" and lands comfortably inside the byte cap.
//!   • BYTES (a backstop) — a final file over [`CAPTURE_MAX_BYTES`] is DELETED and reported as an
//!     error. It should be unreachable after downscaling; it exists so that the failure mode of a
//!     surprise is a refusal naming the size, not a silent multi-megabyte artifact the caller is
//!     told about only by a number it may not read.
//!
//! Captures land in ONE dedicated directory (`<temp>/sparkle-captures.noindex`) rather than loose in the
//! temp dir, so the litter is inspectable and prunable as a group. Anything older than
//! [`CAPTURE_RETENTION`] is best-effort pruned; without that a chatty concierge would grow an
//! unbounded pile of screenshots of the user's screen, which is a privacy cost as much as a disk
//! one.
//!
//! RETENTION IS SWEPT ON TWO TRIGGERS, and it needs both. Pruning inside `capture_region_blocking`
//! alone made retention a side effect of taking ANOTHER capture, which never happens in the case
//! that matters: after a single `capture_window` the concierge goes quiet and a PNG of the user's
//! screen sits in temp indefinitely — the quiescent session is the common one, and it was the one
//! the bound did not cover. So [`sweep_capture_dir`] also runs once at app `setup`, which is the
//! deterministic trigger: whatever the last session left behind is gone within a launch of aging
//! out, whether or not this session ever photographs anything.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// The long edge a capture is downscaled to. Matches `screenshot.rs`'s preview box: big enough to
/// read a terminal's text, small enough that the PNG stays a couple of megabytes.
pub const CAPTURE_MAX_DIM: u32 = 1600;

/// Hard ceiling on the file handed back. A backstop behind the dimension cap, not the primary bound.
pub const CAPTURE_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// How long a capture file survives before a sweep prunes it.
pub const CAPTURE_RETENTION: Duration = Duration::from_secs(60 * 60);

/// The smallest region worth photographing. Below this a "screenshot" is a few pixels of nothing,
/// which is far more likely to be a layout bug in the caller than a real request.
pub const CAPTURE_MIN_EDGE: f64 = 8.0;

/// A rectangle in LOGICAL screen points, origin at the top-left of the primary display — the
/// coordinate space both `screencapture -R` and Tauri's logical geometry use.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct CaptureRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What a capture produced. Deliberately measurements + a path, never pixels — see the header.
#[derive(Debug, Serialize)]
pub struct CaptureResult {
    /// Absolute path to the PNG.
    pub path: String,
    /// Pixel dimensions of the file AS WRITTEN (i.e. after any downscale), not of the region asked
    /// for. A caller reporting "I captured a 3200px window" from a 1600px file would be wrong.
    pub width: u32,
    pub height: u32,
    /// Size on disk, so a caller can decide whether opening it is worth it.
    pub bytes: u64,
    /// Whether the dimension cap bit. Part of the answer, not a diagnostic: it tells the reader the
    /// image is not at native resolution before they conclude the UI renders blurrily.
    pub downscaled: bool,
}

// ---------------------------------------------------------------------------------------------
// Pure helpers — everything with logic of its own, so it is testable without a window
// ---------------------------------------------------------------------------------------------

/// Reject a rect that cannot describe a real region.
///
/// NaN and infinity are checked FIRST and explicitly. They arrive easily — a `getBoundingClientRect`
/// on an unmounted node, a division by a zero scale factor — and they defeat comparison operators
/// rather than failing them: `f64::NAN > 0.0` is `false`, so a naive `width > 0.0` guard passes NaN
/// through to `format!`, which renders it as the literal `NaN` and hands `screencapture` an argument
/// it interprets as garbage.
pub fn validate_rect(rect: CaptureRect) -> Result<(), String> {
    if !rect.x.is_finite() || !rect.y.is_finite() || !rect.width.is_finite() || !rect.height.is_finite()
    {
        return Err("rect has a non-finite coordinate".to_string());
    }
    if rect.width < CAPTURE_MIN_EDGE || rect.height < CAPTURE_MIN_EDGE {
        return Err(format!(
            "rect is {:.0}×{:.0}, smaller than the {CAPTURE_MIN_EDGE:.0}px minimum edge",
            rect.width, rect.height
        ));
    }
    Ok(())
}

/// Clamp `requested` to `bounds`, or `None` when the two do not overlap.
///
/// THE SECURITY BOUNDARY (see the header). `bounds` is the main window's own rect, read from Tauri
/// and never from the caller, so the result can only ever name a region of Sparkle's window. A
/// requested rect that lies entirely outside is refused rather than clamped, because clamping a
/// disjoint rect yields a zero-area sliver at the window's edge — a "successful" capture of nothing,
/// which reads to the caller as "the pane is blank" rather than "your rect was wrong".
pub fn intersect(requested: CaptureRect, bounds: CaptureRect) -> Option<CaptureRect> {
    let left = requested.x.max(bounds.x);
    let top = requested.y.max(bounds.y);
    let right = (requested.x + requested.width).min(bounds.x + bounds.width);
    let bottom = (requested.y + requested.height).min(bounds.y + bounds.height);
    if right - left < CAPTURE_MIN_EDGE || bottom - top < CAPTURE_MIN_EDGE {
        return None;
    }
    Some(CaptureRect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}

/// The `-R` argument: `x,y,w,h`, rounded to whole points.
///
/// `screencapture` parses this with `atoi`-style leniency, so a fractional value is silently
/// truncated rather than rejected — rounding here keeps the captured region within half a point of
/// the one asked for instead of always biasing toward the origin.
pub fn region_arg(rect: CaptureRect) -> String {
    format!(
        "{},{},{},{}",
        rect.x.round() as i64,
        rect.y.round() as i64,
        rect.width.round() as i64,
        rect.height.round() as i64
    )
}

/// The directory every capture is written to. One place, so the litter is prunable as a group.
///
/// The `.noindex` suffix is load-bearing, NOT decoration: macOS Spotlight (and with it
/// `mediaanalysisd`, which runs vision/OCR analysis on every image it indexes) excludes any
/// directory whose name ends in `.noindex`. Without it, every concierge/preview screenshot Sparkle
/// writes gets analysed by the OS, pinning a background daemon on churn that is pure waste — the
/// files are ephemeral and never user-searched. Renaming this dir is the whole fix; the suffix must
/// stay on the name.
pub fn capture_dir() -> PathBuf {
    std::env::temp_dir().join("sparkle-captures.noindex")
}

/// The file one capture writes. `kind` distinguishes a window shot from a pane shot in a directory
/// listing; `stamp` keeps two captures in the same millisecond from colliding only if the caller
/// varies it, which `capture_stamp` does by construction.
pub fn capture_path(kind: &str, stamp: u128) -> PathBuf {
    capture_dir().join(format!("sparkle-{kind}-{stamp}.png"))
}

/// Move a VIEWPORT-relative rect (CSS pixels, origin at the webview's top-left — what
/// `getBoundingClientRect` returns) into LOGICAL SCREEN points by offsetting it by the webview's
/// own screen origin.
///
/// ALL COORDINATE MATH LIVES HERE, not in the frontend, and that is deliberate. The caller would
/// otherwise have to add the window position AND subtract the title-bar height to find where its
/// element really is — two facts it can only get through further IPC, and two chances to be wrong
/// in a way that silently photographs the wrong part of the screen. Sending the rect exactly as the
/// DOM reported it keeps the frontend honest about the one thing it actually knows.
///
/// CSS pixels and Tauri logical points are the same unit, so this is a translation and never a
/// scale. `origin` is read from the window's INNER position — the content area — so the title bar
/// is already excluded.
pub fn viewport_to_screen(rect: CaptureRect, origin_x: f64, origin_y: f64) -> CaptureRect {
    CaptureRect {
        x: rect.x + origin_x,
        y: rect.y + origin_y,
        width: rect.width,
        height: rect.height,
    }
}

/// Is the file small enough to hand over?
pub fn within_byte_cap(bytes: u64) -> bool {
    bytes <= CAPTURE_MAX_BYTES
}

/// Does this image exceed the dimension cap?
pub fn needs_downscale(width: u32, height: u32) -> bool {
    width.max(height) > CAPTURE_MAX_DIM
}

/// Read a PNG's dimensions from its IHDR without decoding it — signature(8) + chunk len(4) +
/// "IHDR"(4), then width(4) and height(4), big-endian. `None` for anything that is not a PNG we
/// recognise, which the caller reports rather than guessing at.
pub fn png_dimensions(path: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut header = [0u8; 24];
    std::fs::File::open(path).ok()?.read_exact(&mut header).ok()?;
    if &header[0..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    Some((
        u32::from_be_bytes([header[16], header[17], header[18], header[19]]),
        u32::from_be_bytes([header[20], header[21], header[22], header[23]]),
    ))
}

/// Should a capture file of this age be pruned?
pub fn is_stale(age: Duration) -> bool {
    age > CAPTURE_RETENTION
}

/// Milliseconds since the epoch, or 0 if the clock is before it. Only used to make filenames
/// distinct, so a degenerate clock costs a collision, not correctness.
fn capture_stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// The DETERMINISTIC retention trigger: sweep the capture directory once, independent of whether
/// this session ever takes a capture. Called from app `setup` (on a background thread — it stats
/// every entry in the directory and has no business in the launch path).
///
/// This is the half of retention that capture-time pruning cannot provide. A session that took one
/// screenshot and then went quiet used to leave it in temp forever, because nothing but the NEXT
/// capture ever pruned. A missing directory is the common case (no capture has ever been taken) and
/// is silently fine.
/// SPLIT FROM [`sweep_dir`] SO THE TARGET IS TESTABLE (roborev 55453). This line — resolving WHICH
/// directory gets swept — was the one thing no test could reach: every retention test passed a path
/// in, so `cargo test` stayed green no matter what this resolved to. That is the wrong line to leave
/// unguarded, because the function now runs unconditionally on a background thread at every launch:
/// widen it to `std::env::temp_dir()` and Sparkle would `remove_file` every hour-old entry across
/// the user's whole temp directory on startup. `the_sweep_targets_only_the_capture_directory` calls
/// through this wrapper and asserts the blast radius.
pub fn sweep_capture_dir() {
    sweep_dir(&capture_dir());
}

/// Sweep one directory. A missing directory is the common case (no capture has ever been taken) and
/// is silently fine.
fn sweep_dir(dir: &Path) {
    if !dir.exists() {
        return;
    }
    prune_stale_captures(dir);
}

/// Best-effort removal of captures older than [`CAPTURE_RETENTION`]. Every error is ignored: a
/// screenshot must not fail because a stale sibling could not be deleted.
fn prune_stale_captures(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(is_stale);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The shutter
// ---------------------------------------------------------------------------------------------

/// Capture `rect` to a PNG and return its path and measurements.
///
/// Runs `screencapture` synchronously; callers reach it through `spawn_blocking` so the UI thread is
/// never held. `-x` silences the shutter sound, which would otherwise fire on every concierge turn
/// that looked at the screen.
fn capture_region_blocking(kind: &str, rect: CaptureRect) -> Result<CaptureResult, String> {
    validate_rect(rect)?;
    let dir = capture_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    prune_stale_captures(&dir);

    let stamp = capture_stamp();
    let path = capture_path(kind, stamp);
    let status = Command::new("/usr/sbin/screencapture")
        .arg("-R")
        .arg(region_arg(rect))
        .arg("-x")
        .arg(&path)
        .status()
        .map_err(|e| format!("failed to launch screencapture: {e}"))?;
    if !status.success() {
        return Err(format!("screencapture exited with {status}"));
    }
    // `screencapture` exits 0 having written nothing when the Screen Recording permission has never
    // been granted. Reported as the permission problem it almost always is, rather than as a missing
    // file — the remedy is a System Settings toggle, and a caller told "no such file" cannot find it.
    if !path.exists() {
        return Err(
            "screencapture produced no file — Sparkle most likely lacks the macOS Screen Recording \
             permission (System Settings → Privacy & Security → Screen Recording)"
                .to_string(),
        );
    }

    finish_capture(path)
}

/// Apply the dimension cap, then the byte cap, and measure what survived.
fn finish_capture(path: PathBuf) -> Result<CaptureResult, String> {
    let native = png_dimensions(&path);
    let downscaled = native.is_some_and(|(w, h)| needs_downscale(w, h))
        && Command::new("/usr/bin/sips")
            .args(["-Z", &CAPTURE_MAX_DIM.to_string()])
            .arg(&path)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

    let bytes = std::fs::metadata(&path)
        .map_err(|e| format!("could not stat the capture: {e}"))?
        .len();
    if !within_byte_cap(bytes) {
        // Remove it. A file we will not hand over should not sit in temp holding a picture of the
        // user's screen that nothing will ever prune deliberately.
        let _ = std::fs::remove_file(&path);
        return Err(format!(
            "the capture came to {bytes} bytes, over the {CAPTURE_MAX_BYTES}-byte cap, so it was discarded"
        ));
    }
    let (width, height) = png_dimensions(&path)
        .ok_or_else(|| "the capture is not a PNG this build can measure".to_string())?;

    tracing::info!(
        path = %path.display(),
        width,
        height,
        bytes,
        downscaled,
        "window_screenshot: wrote a capture"
    );
    Ok(CaptureResult {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
        bytes,
        downscaled,
    })
}

/// The main window's rect in LOGICAL screen points.
///
/// Read from the window itself, never from a caller — this is the `bounds` every requested rect is
/// clamped to, so a caller-supplied value here would dissolve the security boundary the clamp
/// exists to be. A non-finite or non-positive scale factor falls back to 1.0 rather than poisoning
/// the coordinates, the same defence `display_span.rs` applies for the same reason.
fn main_window_rect(window: &tauri::WebviewWindow) -> Result<CaptureRect, String> {
    let position = window
        .outer_position()
        .map_err(|e| format!("read window position: {e}"))?;
    let size = window
        .outer_size()
        .map_err(|e| format!("read window size: {e}"))?;
    let scale = window
        .scale_factor()
        .map_err(|e| format!("read scale factor: {e}"))?;
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    Ok(CaptureRect {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    })
}

/// The webview CONTENT area in logical screen points — the origin a viewport rect is relative to,
/// and the bounds a viewport rect is clamped against.
///
/// Deliberately the INNER rect rather than the outer one used by `capture_main_window`. A pane lives
/// inside the webview, so measuring from the outer frame would offset every region by the title
/// bar's height, and clamping against the outer frame would let a rect reach up into chrome that no
/// DOM element can occupy.
fn main_window_inner_rect(window: &tauri::WebviewWindow) -> Result<CaptureRect, String> {
    let position = window
        .inner_position()
        .map_err(|e| format!("read content position: {e}"))?;
    let size = window
        .inner_size()
        .map_err(|e| format!("read content size: {e}"))?;
    let scale = window
        .scale_factor()
        .map_err(|e| format!("read scale factor: {e}"))?;
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    Ok(CaptureRect {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    })
}

fn main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    use tauri::Manager as _;
    app.get_webview_window("main")
        .ok_or_else(|| "the main window is not open".to_string())
}

/// Photograph the whole main window.
#[tauri::command]
pub async fn capture_main_window(app: tauri::AppHandle) -> Result<CaptureResult, String> {
    let rect = main_window_rect(&main_window(&app)?)?;
    tauri::async_runtime::spawn_blocking(move || capture_region_blocking("window", rect))
        .await
        .map_err(|e| format!("capture task failed: {e}"))?
}

/// Photograph one region of the main window's CONTENT, named in VIEWPORT coordinates — a rect
/// exactly as `getBoundingClientRect` reported it, with no conversion done by the caller.
///
/// The rect is translated into screen space here and then clamped to the webview's own bounds; see
/// the header for why that clamp is the point of this command rather than a detail of it.
#[tauri::command]
pub async fn capture_main_window_region(
    app: tauri::AppHandle,
    rect: CaptureRect,
) -> Result<CaptureResult, String> {
    validate_rect(rect)?;
    let content = main_window_inner_rect(&main_window(&app)?)?;
    let screen = viewport_to_screen(rect, content.x, content.y);
    let clamped = intersect(screen, content).ok_or_else(|| {
        "that region does not overlap Sparkle's window, so there is nothing of the app to capture \
         there"
            .to_string()
    })?;
    tauri::async_runtime::spawn_blocking(move || capture_region_blocking("pane", clamped))
        .await
        .map_err(|e| format!("capture task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> CaptureRect {
        CaptureRect { x, y, width, height }
    }

    /// The window every clamp test measures against: 1000×800 at (100, 50).
    fn window() -> CaptureRect {
        rect(100.0, 50.0, 1000.0, 800.0)
    }

    // ----- validate_rect -----

    #[test]
    fn accepts_an_ordinary_rect() {
        assert!(validate_rect(rect(0.0, 0.0, 800.0, 600.0)).is_ok());
    }

    #[test]
    fn rejects_non_finite_coordinates() {
        // Each field on its own, because a guard that only checks width would pass three of these.
        assert!(validate_rect(rect(f64::NAN, 0.0, 800.0, 600.0)).is_err());
        assert!(validate_rect(rect(0.0, f64::NAN, 800.0, 600.0)).is_err());
        assert!(validate_rect(rect(0.0, 0.0, f64::NAN, 600.0)).is_err());
        assert!(validate_rect(rect(0.0, 0.0, 800.0, f64::NAN)).is_err());
        assert!(validate_rect(rect(0.0, 0.0, f64::INFINITY, 600.0)).is_err());
    }

    /// The specific trap the finite check exists for: NaN defeats `>` rather than failing it, so a
    /// bare `width > 0.0` guard lets it through and `region_arg` renders it into the command line.
    #[test]
    fn a_nan_width_would_survive_a_naive_positive_check() {
        let nan = f64::NAN;
        assert!(!(nan > 0.0), "NaN compares false, so ordering alone cannot reject it");
        assert!(validate_rect(rect(0.0, 0.0, nan, 600.0)).is_err());
    }

    #[test]
    fn rejects_a_rect_smaller_than_the_minimum_edge() {
        assert!(validate_rect(rect(0.0, 0.0, 4.0, 600.0)).is_err());
        assert!(validate_rect(rect(0.0, 0.0, 600.0, 4.0)).is_err());
        assert!(validate_rect(rect(0.0, 0.0, 0.0, 0.0)).is_err());
        assert!(validate_rect(rect(0.0, 0.0, -50.0, -50.0)).is_err());
    }

    #[test]
    fn accepts_exactly_the_minimum_edge() {
        assert!(validate_rect(rect(0.0, 0.0, CAPTURE_MIN_EDGE, CAPTURE_MIN_EDGE)).is_ok());
    }

    // ----- intersect: the clamp -----

    #[test]
    fn a_rect_inside_the_window_is_returned_unchanged() {
        let inner = rect(200.0, 100.0, 300.0, 200.0);
        assert_eq!(intersect(inner, window()), Some(inner));
    }

    /// The load-bearing case: a rect reaching PAST the window is cut back to the window, so the
    /// region photographed can never include whatever else is on that part of the screen.
    #[test]
    fn a_rect_overflowing_the_window_is_clamped_to_it() {
        let overflowing = rect(0.0, 0.0, 5000.0, 5000.0);
        assert_eq!(intersect(overflowing, window()), Some(window()));
    }

    #[test]
    fn clamps_each_edge_independently() {
        // Starts left of and above the window, ends inside it.
        assert_eq!(
            intersect(rect(0.0, 0.0, 400.0, 300.0), window()),
            Some(rect(100.0, 50.0, 300.0, 250.0)),
        );
        // Starts inside, runs off the bottom-right.
        assert_eq!(
            intersect(rect(900.0, 700.0, 900.0, 900.0), window()),
            Some(rect(900.0, 700.0, 200.0, 150.0)),
        );
    }

    /// A rect somewhere else entirely — another display, another app's window — is REFUSED, not
    /// clamped into an edge sliver that would read as a successful capture of a blank pane.
    #[test]
    fn a_disjoint_rect_is_refused_rather_than_clamped() {
        assert_eq!(intersect(rect(5000.0, 5000.0, 400.0, 300.0), window()), None);
        assert_eq!(intersect(rect(-900.0, 50.0, 400.0, 300.0), window()), None);
    }

    /// Touching the window's edge produces an overlap below the minimum edge, which is the same
    /// "nothing worth photographing" case as a disjoint rect.
    #[test]
    fn a_rect_merely_touching_the_window_edge_is_refused() {
        // Ends exactly at the window's left edge: zero-width overlap.
        assert_eq!(intersect(rect(0.0, 50.0, 100.0, 300.0), window()), None);
        // Overlaps by 4pt, under CAPTURE_MIN_EDGE.
        assert_eq!(intersect(rect(0.0, 50.0, 104.0, 300.0), window()), None);
    }

    // ----- viewport_to_screen -----

    #[test]
    fn a_viewport_rect_is_offset_by_the_content_origin() {
        // The pane starts 240pt right of the webview's left edge; the webview starts at (100, 80).
        assert_eq!(
            viewport_to_screen(rect(240.0, 0.0, 760.0, 800.0), 100.0, 80.0),
            rect(340.0, 80.0, 760.0, 800.0),
        );
    }

    #[test]
    fn the_conversion_translates_and_never_scales() {
        let r = rect(10.0, 20.0, 333.0, 444.0);
        let moved = viewport_to_screen(r, 500.0, 600.0);
        assert_eq!(moved.width, r.width);
        assert_eq!(moved.height, r.height);
    }

    #[test]
    fn a_window_at_the_screen_origin_leaves_the_rect_alone() {
        let r = rect(12.0, 34.0, 500.0, 400.0);
        assert_eq!(viewport_to_screen(r, 0.0, 0.0), r);
    }

    #[test]
    fn a_window_on_a_display_left_of_the_primary_keeps_its_negative_origin() {
        assert_eq!(
            viewport_to_screen(rect(50.0, 10.0, 400.0, 300.0), -1440.0, -200.0),
            rect(-1390.0, -190.0, 400.0, 300.0),
        );
    }

    /// The pairing that makes the clamp meaningful: a viewport rect is converted with the SAME
    /// origin it is then clamped against, so a rect that fits the viewport survives untouched and
    /// one that overruns it is cut back to the content area rather than reaching into the desktop.
    #[test]
    fn conversion_and_clamp_compose_against_the_same_content_rect() {
        let content = rect(100.0, 80.0, 1000.0, 800.0);
        // Fits: the full viewport, converted, is exactly the content rect.
        let full = viewport_to_screen(rect(0.0, 0.0, 1000.0, 800.0), content.x, content.y);
        assert_eq!(intersect(full, content), Some(content));
        // Overruns to the right and below — clamped back to the content area's far edges.
        let over = viewport_to_screen(rect(900.0, 700.0, 900.0, 900.0), content.x, content.y);
        assert_eq!(intersect(over, content), Some(rect(1000.0, 780.0, 100.0, 100.0)));
    }

    // ----- region_arg -----

    #[test]
    fn formats_the_region_as_x_y_w_h() {
        assert_eq!(region_arg(rect(10.0, 20.0, 300.0, 400.0)), "10,20,300,400");
    }

    #[test]
    fn rounds_rather_than_truncating() {
        // 10.6 must not become 10 — screencapture would truncate, biasing every region toward the
        // origin by up to a point.
        assert_eq!(region_arg(rect(10.6, 20.4, 300.5, 399.5)), "11,20,301,400");
    }

    #[test]
    fn handles_a_negative_origin() {
        // A window on a display left of the primary one has a negative x; the region must keep it.
        assert_eq!(region_arg(rect(-1200.0, -30.0, 800.0, 600.0)), "-1200,-30,800,600");
    }

    // ----- caps -----

    #[test]
    fn the_byte_cap_admits_at_the_boundary_and_refuses_over_it() {
        assert!(within_byte_cap(0));
        assert!(within_byte_cap(CAPTURE_MAX_BYTES));
        assert!(!within_byte_cap(CAPTURE_MAX_BYTES + 1));
    }

    #[test]
    fn the_dimension_cap_bites_only_over_the_maximum() {
        assert!(!needs_downscale(CAPTURE_MAX_DIM, CAPTURE_MAX_DIM));
        assert!(needs_downscale(CAPTURE_MAX_DIM + 1, 100));
        // The LONG edge decides, whichever axis it is on.
        assert!(needs_downscale(100, CAPTURE_MAX_DIM + 1));
        assert!(!needs_downscale(800, 600));
    }

    #[test]
    fn retention_is_measured_against_the_configured_window() {
        assert!(!is_stale(Duration::from_secs(0)));
        assert!(!is_stale(CAPTURE_RETENTION));
        assert!(is_stale(CAPTURE_RETENTION + Duration::from_secs(1)));
    }

    // ----- paths -----

    #[test]
    fn captures_land_in_one_dedicated_directory() {
        let dir = capture_dir();
        assert!(dir.ends_with("sparkle-captures.noindex"), "got {}", dir.display());
        // The `.noindex` suffix is the whole mechanism that keeps macOS `mediaanalysisd` from
        // analysing every screenshot: Spotlight excludes any directory whose name ends in it. Assert
        // the suffix explicitly so reverting the rename to a plain `sparkle-captures` turns this RED.
        assert!(
            dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".noindex")),
            "capture dir name must end in .noindex, got {}",
            dir.display()
        );
        // Both kinds share the directory, so pruning covers them together.
        assert_eq!(capture_path("window", 7).parent(), Some(dir.as_path()));
        assert_eq!(capture_path("pane", 7).parent(), Some(dir.as_path()));
    }

    #[test]
    fn the_filename_carries_the_kind_and_the_stamp_and_is_a_png() {
        let path = capture_path("window", 1234);
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name, "sparkle-window-1234.png");
    }

    #[test]
    fn two_stamps_give_two_files() {
        assert_ne!(capture_path("pane", 1), capture_path("pane", 2));
        // …and two KINDS at the same instant do not collide either.
        assert_ne!(capture_path("pane", 1), capture_path("window", 1));
    }

    // ----- png_dimensions -----

    fn write_temp(name: &str, bytes: &[u8]) -> PathBuf {
        // Prefixed with the pid so two concurrent `cargo test` processes cannot truncate each
        // other's fixtures (the same guard screenshot.rs's tests use).
        let p = std::env::temp_dir()
            .join(format!("sparkle-capturetest-{}-{}", std::process::id(), name));
        std::fs::File::create(&p).unwrap().write_all(bytes).unwrap();
        p
    }

    fn png_header(w: u32, h: u32) -> Vec<u8> {
        let mut b = Vec::with_capacity(24);
        b.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        b.extend_from_slice(&13u32.to_be_bytes());
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b
    }

    #[test]
    fn reads_dimensions_from_a_png_header() {
        let p = write_temp("dims.png", &png_header(3200, 2000));
        assert_eq!(png_dimensions(&p), Some((3200, 2000)));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn refuses_to_measure_a_non_png() {
        let p = write_temp("notpng.png", b"this is definitely not a png!!");
        assert_eq!(png_dimensions(&p), None);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn refuses_to_measure_a_truncated_header() {
        let p = write_temp("trunc.png", b"\x89PNG\r\n\x1a\n\x00\x00");
        assert_eq!(png_dimensions(&p), None);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn a_missing_file_measures_as_none_rather_than_panicking() {
        assert_eq!(png_dimensions(Path::new("/nonexistent/sparkle/nope.png")), None);
    }

    // ----- the two privacy guarantees, asserted as SIDE EFFECTS on real files -----
    //
    // `within_byte_cap` and `is_stale` above are arithmetic: they hold identically whether or not
    // any caller wires them to a `remove_file`, so they cannot tell you the file went away. These
    // do. A regression that dropped either `remove_file` — or inverted the `is_stale` call — passes
    // every predicate test above while pictures of the user's screen accumulate in temp.

    /// A fresh, empty directory of this test's own, so one test's fixtures cannot be another's
    /// leftovers. Pid-prefixed for the same reason `write_temp` is: two concurrent `cargo test`
    /// processes must not share it.
    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("sparkle-capturedir-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Move a file's mtime `ago` into the past — how a "stale" capture is staged without waiting an
    /// hour for one.
    fn back_date(path: &Path, ago: Duration) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - ago)
            .unwrap();
    }

    #[test]
    fn an_over_cap_capture_is_deleted_not_merely_reported() {
        let dir = test_dir("overcap");
        let path = dir.join("sparkle-window-1.png");
        // A readable PNG header inside the DIMENSION cap (so `sips` is never invoked and this test
        // measures the byte backstop alone), padded one byte past the byte cap.
        let mut bytes = png_header(100, 100);
        bytes.resize(CAPTURE_MAX_BYTES as usize + 1, 0);
        std::fs::write(&path, &bytes).unwrap();

        let err = finish_capture(path.clone()).expect_err("over the byte cap must be refused");
        assert!(err.contains("byte cap"), "the refusal should name the cap, got: {err}");
        // THE ASSERTION THAT MATTERS. A cap that reports the size and leaves the file behind has
        // done the opposite of its job: the caller is refused AND a multi-megabyte photograph of
        // the user's screen sits in temp, which is exactly what the refusal exists to avoid.
        assert!(!path.exists(), "an over-cap capture must not survive its own refusal");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The counterpart, so the test above cannot pass because `finish_capture` refuses everything:
    /// a file inside both caps is KEPT, and measured from the file as written.
    #[test]
    fn a_capture_inside_both_caps_is_kept_and_measured() {
        let dir = test_dir("undercap");
        let path = dir.join("sparkle-pane-1.png");
        let bytes = png_header(640, 480);
        std::fs::write(&path, &bytes).unwrap();

        let result = finish_capture(path.clone()).expect("a small in-cap PNG must be accepted");
        assert_eq!((result.width, result.height), (640, 480));
        assert_eq!(result.bytes, bytes.len() as u64);
        assert!(!result.downscaled);
        assert!(path.exists(), "an accepted capture is the file it hands back a path to");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sweep_removes_exactly_the_stale_capture() {
        let dir = test_dir("prune");
        let stale = dir.join("sparkle-window-old.png");
        let fresh = dir.join("sparkle-window-new.png");
        std::fs::write(&stale, b"an old screenshot").unwrap();
        std::fs::write(&fresh, b"a new screenshot").unwrap();
        back_date(&stale, CAPTURE_RETENTION + Duration::from_secs(60));

        prune_stale_captures(&dir);

        assert!(!stale.exists(), "a capture past CAPTURE_RETENTION must be removed");
        // EXACTLY the stale one: a sweep that took the live capture with it would delete the file
        // the current call is about to hand back.
        assert!(fresh.exists(), "a capture inside the retention window must be left alone");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sweep_of_a_directory_that_does_not_exist_is_a_no_op() {
        // The first launch after an install, and every launch of a session that never captures.
        // Best-effort by contract: no panic, nothing created.
        //
        // Through `sweep_dir`, NOT `prune_stale_captures` (roborev 55453). Calling the inner helper
        // tested a function that was never in question and left the `!dir.exists()` early return
        // unfalsifiable — `prune_stale_captures` already swallows a failed `read_dir`, so deleting
        // the guard would not have shown up here.
        let missing = std::env::temp_dir()
            .join(format!("sparkle-capturedir-{}-never", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        sweep_dir(&missing);
        assert!(!missing.exists());
    }

    /// THE BLAST RADIUS OF THE LAUNCH-TIME SWEEP, which nothing pinned (roborev 55453). Every other
    /// retention test hands a directory in, so all of them stay green if `sweep_capture_dir` resolves
    /// the wrong target — and it runs on a background thread at every launch, so the wrong target
    /// means deleting hour-old files across the user's entire temp directory. Calls THROUGH the
    /// public wrapper with no argument, which is the only way to assert what it chose.
    #[test]
    fn the_sweep_targets_only_the_capture_directory() {
        let dir = capture_dir();
        std::fs::create_dir_all(&dir).expect("capture dir");

        let stale = dir.join(format!("sparkle-window-{}-sweeptarget.png", std::process::id()));
        std::fs::write(&stale, b"x").expect("write stale");
        back_date(&stale, CAPTURE_RETENTION + Duration::from_secs(60));

        // A back-dated file OUTSIDE the capture directory, old enough to be swept if the target ever
        // widened to temp_dir() itself. This is the assertion that catches the dangerous refactor.
        let outsider = std::env::temp_dir()
            .join(format!("-a-capture-{}-sweeptarget.txt", std::process::id()));
        std::fs::write(&outsider, b"x").expect("write outsider");
        back_date(&outsider, CAPTURE_RETENTION + Duration::from_secs(60));

        sweep_capture_dir();

        assert!(!stale.exists(), "a stale capture must be swept by the launch-time sweep");
        assert!(
            outsider.exists(),
            "the sweep reached outside {}: a widened target would delete unrelated temp files",
            dir.display()
        );

        let _ = std::fs::remove_file(&outsider);
    }
}
