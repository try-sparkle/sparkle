//! Composer attachment helpers: turn a dropped file into a previewable attachment,
//! copy an image to the macOS clipboard, and copy files to a user-chosen destination
//! (single download, or bulk into a folder).
//!
//! Images are detected by extension and returned with a `data:` URL so the UI can show
//! a thumbnail / lightbox without a second IPC round-trip (same shape as screenshot.rs).
//! Clipboard + save flows are macOS-only (the app is macOS-only) and shell out to the
//! built-in `sips` / `osascript` rather than pull in a clipboard crate.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

/// Raster image extensions we preview inline. Mirror of `isImagePath` in
/// `components/composer/attachments.ts` — keep the two sets in sync. HEIC is excluded:
/// Chromium WebViews can't render it in a data URL, so it becomes a file tile.
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/// Above this size we skip inline preview generation: base64 inflates ~33% and rides an
/// IPC message, so a huge image would spike memory. Oversized images become file tiles
/// (still attachable + downloadable, just no thumbnail).
const MAX_PREVIEW_BYTES: u64 = 40 * 1024 * 1024;

#[derive(Serialize)]
pub struct LoadedAttachment {
    /// Absolute path (echoed back so the caller can prefix it to the CLI payload).
    path: String,
    /// Basename for display on a file tile / lightbox title.
    name: String,
    /// `data:<mime>;base64,…` when the file is an image; `None` otherwise.
    data_url: Option<String>,
}

fn extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

fn is_image_path(path: &Path) -> bool {
    extension_lower(path)
        .map(|e| IMAGE_EXTENSIONS.contains(&e.as_str()))
        .unwrap_or(false)
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

/// Read a dropped file. For images, attach a base64 data URL for previewing; for
/// everything else, return just the path + name (rendered as a file tile).
#[tauri::command]
pub async fn load_attachment(path: String) -> Result<LoadedAttachment, String> {
    tauri::async_runtime::spawn_blocking(move || load_blocking(&path))
        .await
        .map_err(|e| format!("load_attachment task failed: {e}"))?
}

fn load_blocking(path: &str) -> Result<LoadedAttachment, String> {
    let p = Path::new(path);
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_owned();

    let meta = std::fs::metadata(p).map_err(|e| format!("stat {path}: {e}"))?;

    let data_url = if is_image_path(p) && meta.len() <= MAX_PREVIEW_BYTES {
        let bytes = std::fs::read(p).map_err(|e| format!("read {path}: {e}"))?;
        let ext = extension_lower(p).unwrap_or_default();
        Some(format!(
            "data:{};base64,{}",
            mime_for(&ext),
            STANDARD.encode(&bytes)
        ))
    } else {
        // Non-image, or an image too large to preview: ride along as a file tile. The
        // metadata read above already confirmed the path exists/readable, so a broken
        // drop has failed loudly by here rather than sending a dead path to the agent.
        None
    };

    Ok(LoadedAttachment {
        path: path.to_owned(),
        name,
        data_url,
    })
}

/// Put an image file on the macOS clipboard as a PNG. Non-PNG inputs are converted to a
/// temp PNG via `sips` first, so any supported image type ends up as a real bitmap on the
/// pasteboard (paste into Slack/Preview/etc.), not a file reference.
#[tauri::command]
pub async fn copy_image_to_clipboard(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || copy_image_blocking(&path))
        .await
        .map_err(|e| format!("copy_image task failed: {e}"))?
}

fn copy_image_blocking(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("file not found: {path}"));
    }
    let is_png = extension_lower(p).as_deref() == Some("png");

    // The path we hand to osascript: the original if already PNG, else a temp conversion.
    // `temp_png` holds the temp path (when we made one) so we can delete it afterwards.
    let temp_png: Option<String> = if is_png {
        None
    } else {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let tmp = std::env::temp_dir().join(format!("sparkle-clip-{stamp}.png"));
        let status = Command::new("/usr/bin/sips")
            .args(["-s", "format", "png"])
            .arg(path)
            .arg("--out")
            .arg(&tmp)
            .status()
            .map_err(|e| format!("failed to launch sips: {e}"))?;
        if !status.success() {
            // sips may have written a partial file before failing — don't leak it.
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("sips conversion failed ({status})"));
        }
        Some(tmp.to_string_lossy().into_owned())
    };
    let png_path: &str = temp_png.as_deref().unwrap_or(path);

    // Read the PNG into the clipboard as image data («class PNGf»), not as a file URL.
    let script = format!(
        "set the clipboard to (read (POSIX file \"{}\") as «class PNGf»)",
        png_path.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let result = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(&script)
        .status()
        .map_err(|e| format!("failed to launch osascript: {e}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("clipboard copy failed ({status})"))
            }
        });

    // Clean up the temp conversion regardless of how the copy went (best-effort).
    if let Some(tmp) = &temp_png {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

/// Copy a single file to an exact destination path (chosen via the JS save dialog).
#[tauri::command]
pub async fn copy_file_to(src: String, dest: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::copy(&src, &dest)
            .map(|_| ())
            .map_err(|e| format!("copy {src} -> {dest}: {e}"))
    })
    .await
    .map_err(|e| format!("copy_file task failed: {e}"))?
}

/// Pick a non-colliding destination filename in `dir`, accounting for both files already
/// on disk and names already claimed earlier in this same batch. `notes.txt` →
/// `notes (1).txt`, `notes (2).txt`, … so two selected `screenshot.png` never overwrite.
fn unique_dest(dir: &Path, file_name: &OsStr, claimed: &mut HashSet<String>) -> PathBuf {
    // macOS normalizes filenames to UTF-8 (APFS/HFS+), so the lossy conversion is exact in
    // practice on the only platform this app ships to; a truly non-UTF-8 source name would
    // get replacement chars in its copy, which is acceptable for that pathological case.
    let name = file_name.to_string_lossy();
    // Split on the LAST dot to preserve the extension (ignore a leading dot of dotfiles).
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name.as_ref(), ""),
    };
    let mut candidate = name.to_string();
    let mut n = 1;
    while claimed.contains(&candidate) || dir.join(&candidate).exists() {
        candidate = format!("{stem} ({n}){ext}");
        n += 1;
    }
    claimed.insert(candidate.clone());
    dir.join(candidate)
}

/// Copy several files into a destination directory, each under its own basename
/// (chosen via the JS folder picker). Colliding basenames are de-duplicated with a
/// numeric suffix rather than overwritten. Best-effort per file: collects failures and
/// reports them together so one bad path doesn't silently drop the rest.
#[tauri::command]
pub async fn copy_files_to_dir(srcs: Vec<String>, dest_dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = Path::new(&dest_dir);
        let mut claimed: HashSet<String> = HashSet::new();
        let mut errors: Vec<String> = Vec::new();
        for src in &srcs {
            let name = match Path::new(src).file_name() {
                Some(n) => n,
                None => {
                    errors.push(format!("no filename in {src}"));
                    continue;
                }
            };
            let dest = unique_dest(dir, name, &mut claimed);
            if let Err(e) = std::fs::copy(src, &dest) {
                errors.push(format!("{src}: {e}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    })
    .await
    .map_err(|e| format!("copy_files task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // A directory that doesn't exist, so `unique_dest`'s on-disk `.exists()` check is always
    // false and the test isolates the within-batch `claimed` reservation + name splitting.
    const NODIR: &str = "/sparkle-nonexistent-test-dir-xyzzy";

    fn name_for(claimed: &mut HashSet<String>, file_name: &str) -> String {
        unique_dest(Path::new(NODIR), OsStr::new(file_name), claimed)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn dedups_same_basename_within_a_batch() {
        let mut claimed = HashSet::new();
        assert_eq!(name_for(&mut claimed, "screenshot.png"), "screenshot.png");
        assert_eq!(name_for(&mut claimed, "screenshot.png"), "screenshot (1).png");
        assert_eq!(name_for(&mut claimed, "screenshot.png"), "screenshot (2).png");
    }

    #[test]
    fn preserves_extension_on_the_last_dot() {
        let mut claimed = HashSet::new();
        assert_eq!(name_for(&mut claimed, "archive.tar.gz"), "archive.tar.gz");
        assert_eq!(name_for(&mut claimed, "archive.tar.gz"), "archive.tar (1).gz");
    }

    #[test]
    fn treats_a_leading_dot_as_part_of_the_name() {
        let mut claimed = HashSet::new();
        assert_eq!(name_for(&mut claimed, ".gitignore"), ".gitignore");
        assert_eq!(name_for(&mut claimed, ".gitignore"), ".gitignore (1)");
    }

    #[test]
    fn suffixes_names_without_an_extension() {
        let mut claimed = HashSet::new();
        assert_eq!(name_for(&mut claimed, "README"), "README");
        assert_eq!(name_for(&mut claimed, "README"), "README (1)");
    }
}
