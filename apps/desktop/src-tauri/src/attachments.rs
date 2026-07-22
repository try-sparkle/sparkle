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

// ── Path containment (defense-in-depth) ─────────────────────────────────────────────────────────
//
// These commands take a webview-supplied path and read it (`load_attachment`, `copy_image_to_
// clipboard`, the `src`/`srcs` of the copy commands) or write to it (the `dest`/`dest_dir`). The
// primary boundary is the strict CSP (see tauri.conf.json); this is a SECOND layer so a compromised
// webview can't turn these into an arbitrary-file read/overwrite primitive (exfil `~/.ssh/id_rsa`,
// clobber `~/.zshrc`). We can't restrict to a single dir — attachments come from Finder drag-drop
// (any user file), the OS save/folder dialog, or a screenshot in the temp dir — so we allow the
// user's HOME tree, the temp dir, and mounted volumes. Plain containment would still expose home
// dotfiles, so we ALSO reject any path whose portion below the root dives into or names a hidden
// (dot-prefixed) component — `~/.ssh/…`, `~/.zshrc`, `~/.aws/credentials` are all out, while
// ordinary user content anywhere under home is in.

/// Roots a webview-supplied attachment path may legitimately touch. macOS-only app, so `$HOME` is
/// reliably set by launchd. `/Volumes` covers external drives / network mounts a user may drag from.
fn allowed_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        if !home.is_empty() {
            roots.push(PathBuf::from(home));
        }
    }
    roots.push(std::env::temp_dir());
    roots.push(PathBuf::from("/Volumes"));
    roots
}

/// A path component is "hidden" if its name starts with a dot (`.ssh`, `.zshrc`). Non-UTF-8 names
/// are treated as hidden — fail-closed. Only `Normal` components can be hidden; a canonicalized
/// path never contains `.`/`..`, and the root/prefix are the trusted allow-root, not user input.
fn component_is_hidden(c: &std::path::Component) -> bool {
    match c {
        std::path::Component::Normal(os) => os.to_str().map(|s| s.starts_with('.')).unwrap_or(true),
        _ => false,
    }
}

/// True when the already-canonicalized `candidate` sits inside one of `roots` AND the portion below
/// that root has no hidden component. The hidden-component rule is what keeps home dotfiles out
/// while still admitting ordinary user files anywhere under home.
fn is_contained_and_visible(candidate: &Path, roots: &[PathBuf]) -> bool {
    for root in roots {
        // Canonicalize the root too so a symlinked root (e.g. macOS `/tmp`→`/private/tmp`) compares
        // against the same real prefix `candidate` was canonicalized to.
        let Ok(root_c) = root.canonicalize() else { continue };
        if let Ok(rel) = candidate.strip_prefix(&root_c) {
            if rel.components().all(|c| !component_is_hidden(&c)) {
                return true;
            }
        }
    }
    false
}

/// Validate a path we're about to READ (it must already exist). Canonicalizing first resolves
/// symlinks and `..`, so `~/Downloads/../.ssh/id_rsa` is caught, and closes the check-vs-use
/// window (we return the real path for the caller to read). Rejects anything outside the allowed
/// roots or reaching a hidden component.
fn validate_read_path(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let real = path
        .canonicalize()
        .map_err(|e| format!("cannot access {}: {e}", path.display()))?;
    if is_contained_and_visible(&real, roots) {
        Ok(real)
    } else {
        Err(format!("refusing to read a path outside allowed directories: {}", path.display()))
    }
}

/// Validate a destination we're about to WRITE (it need not exist yet). Its PARENT must exist and be
/// contained+visible, and the filename itself must not be hidden — so a compromised webview can't
/// clobber `~/.zshrc` or drop a file into `~/.ssh`. Returns the real parent joined with the filename.
fn validate_write_path(dest: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let file_name = dest
        .file_name()
        .ok_or_else(|| format!("destination has no filename: {}", dest.display()))?;
    if file_name.to_str().map(|s| s.starts_with('.')).unwrap_or(true) {
        return Err(format!("refusing to write a hidden/sensitive file: {}", dest.display()));
    }
    let parent = match dest.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        // No parent (bare relative name) → resolve against the current dir. Fail-closed if even
        // that can't be canonicalized.
        _ => Path::new("."),
    };
    let real_parent = parent
        .canonicalize()
        .map_err(|e| format!("cannot access destination folder for {}: {e}", dest.display()))?;
    if !is_contained_and_visible(&real_parent, roots) {
        return Err(format!(
            "refusing to write outside allowed directories: {}",
            dest.display()
        ));
    }
    Ok(real_parent.join(file_name))
}

/// Validate a destination DIRECTORY we're about to write into (bulk copy). Must exist, be a
/// directory, and be contained+visible.
fn validate_dir_path(dir: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let real = dir
        .canonicalize()
        .map_err(|e| format!("cannot access destination folder {}: {e}", dir.display()))?;
    if !real.is_dir() {
        return Err(format!("destination is not a directory: {}", dir.display()));
    }
    if is_contained_and_visible(&real, roots) {
        Ok(real)
    } else {
        Err(format!("refusing to write outside allowed directories: {}", dir.display()))
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

    // Defense-in-depth: only read paths inside the allowed roots (see the containment helpers).
    // Without this, a compromised webview could invoke this directly to read arbitrary image bytes
    // or use the stat below as a path-existence oracle. Read from the canonicalized `real` path so
    // a symlink swap between check and use can't redirect the read.
    let roots = allowed_roots();
    let real = validate_read_path(p, &roots)?;

    let meta = std::fs::metadata(&real).map_err(|e| format!("stat {path}: {e}"))?;

    let data_url = if is_image_path(p) && meta.len() <= MAX_PREVIEW_BYTES {
        let bytes = std::fs::read(&real).map_err(|e| format!("read {path}: {e}"))?;
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
    // Defense-in-depth: only read/convert paths inside the allowed roots (also confirms existence).
    let roots = allowed_roots();
    let real = validate_read_path(p, &roots)?;
    let path: &str = real.to_str().unwrap_or(path);
    let p = real.as_path();
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
        // Defense-in-depth: constrain BOTH ends to the allowed roots so this can't be used to
        // exfil a sensitive src (`~/.ssh/id_rsa`) or clobber an arbitrary dest (`~/.zshrc`). The
        // dest normally comes from the OS save dialog; this guards the direct-invoke bypass.
        let roots = allowed_roots();
        let real_src = validate_read_path(Path::new(&src), &roots)?;
        let real_dest = validate_write_path(Path::new(&dest), &roots)?;
        std::fs::copy(&real_src, &real_dest)
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
        // Defense-in-depth: the destination folder (normally the OS folder picker) must be inside
        // the allowed roots, and each src is containment-checked before it's read. Guards the
        // direct-invoke bypass of the dialog.
        let roots = allowed_roots();
        let dir = validate_dir_path(Path::new(&dest_dir), &roots)?;
        let mut claimed: HashSet<String> = HashSet::new();
        let mut errors: Vec<String> = Vec::new();
        for src in &srcs {
            let real_src = match validate_read_path(Path::new(src), &roots) {
                Ok(r) => r,
                Err(e) => {
                    errors.push(e);
                    continue;
                }
            };
            let name = match real_src.file_name() {
                Some(n) => n.to_owned(),
                None => {
                    errors.push(format!("no filename in {src}"));
                    continue;
                }
            };
            let dest = unique_dest(&dir, &name, &mut claimed);
            if let Err(e) = std::fs::copy(&real_src, &dest) {
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

    // ── Path containment (defense-in-depth) ─────────────────────────────────────────────────
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A fresh, real temp dir to use as the single allowed ROOT for a containment test. Returning a
    /// real (canonicalizable) dir matters: the helpers canonicalize roots, so a nonexistent root is
    /// silently skipped.
    fn fresh_root() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("-test-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // Canonicalize so callers compare against the same real prefix the helpers derive (macOS
        // resolves the temp dir through /private).
        root.canonicalize().unwrap()
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn read_accepts_a_visible_file_under_a_root() {
        let root = fresh_root();
        let roots = vec![root.clone()];
        let f = root.join("sub").join("photo.png");
        touch(&f);
        let got = validate_read_path(&f, &roots).unwrap();
        assert_eq!(got, f.canonicalize().unwrap());
    }

    #[test]
    fn read_rejects_a_hidden_dotfile() {
        let root = fresh_root();
        let roots = vec![root.clone()];
        // A `.zshrc`-style dotfile directly under the root.
        let f = root.join(".zshrc");
        touch(&f);
        assert!(validate_read_path(&f, &roots).is_err(), "a hidden file must be rejected");
    }

    #[test]
    fn read_rejects_a_file_inside_a_hidden_dir() {
        let root = fresh_root();
        let roots = vec![root.clone()];
        // The `~/.ssh/id_rsa` exfil shape: contained under the root, but reached via a hidden dir.
        let f = root.join(".ssh").join("id_rsa");
        touch(&f);
        assert!(validate_read_path(&f, &roots).is_err(), "a hidden dir component must be rejected");
    }

    #[test]
    fn read_rejects_a_path_outside_every_root() {
        let root = fresh_root();
        let other = fresh_root(); // a real dir, but NOT in the allowed list
        let roots = vec![root];
        let f = other.join("secret.png");
        touch(&f);
        assert!(validate_read_path(&f, &roots).is_err(), "outside all roots must be rejected");
    }

    #[test]
    fn read_rejects_dotdot_escape_into_a_hidden_sibling() {
        let root = fresh_root();
        let roots = vec![root.clone()];
        // `<root>/sub/../.ssh/id_rsa` canonicalizes to `<root>/.ssh/id_rsa` — the `..` can't dodge
        // the hidden-component check.
        let hidden = root.join(".ssh").join("id_rsa");
        touch(&hidden);
        let sneaky = root.join("sub").join("..").join(".ssh").join("id_rsa");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        assert!(validate_read_path(&sneaky, &roots).is_err());
    }

    #[test]
    fn write_accepts_a_visible_dest_in_an_existing_dir() {
        let root = fresh_root();
        let roots = vec![root.clone()];
        let dir = root.join("Downloads");
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("saved.png"); // does not exist yet — the normal save case
        let got = validate_write_path(&dest, &roots).unwrap();
        assert_eq!(got, dir.canonicalize().unwrap().join("saved.png"));
    }

    #[test]
    fn write_rejects_a_hidden_dest_filename() {
        let root = fresh_root();
        let roots = vec![root.clone()];
        // Clobbering `~/.zshrc`: parent is fine, but the filename itself is hidden.
        let dest = root.join(".zshrc");
        assert!(validate_write_path(&dest, &roots).is_err());
    }

    #[test]
    fn write_rejects_a_dest_into_a_hidden_dir() {
        let root = fresh_root();
        let roots = vec![root.clone()];
        std::fs::create_dir_all(root.join(".ssh")).unwrap();
        let dest = root.join(".ssh").join("authorized_keys");
        assert!(validate_write_path(&dest, &roots).is_err());
    }

    #[test]
    fn write_rejects_a_dest_outside_every_root() {
        let root = fresh_root();
        let other = fresh_root();
        let roots = vec![root];
        let dest = other.join("evil.png");
        assert!(validate_write_path(&dest, &roots).is_err());
    }

    #[test]
    fn dir_accepts_a_visible_dir_and_rejects_a_file_or_outsider() {
        let root = fresh_root();
        let roots = vec![root.clone()];
        let dir = root.join("out");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(validate_dir_path(&dir, &roots).is_ok());

        // A regular file is not a valid destination directory.
        let file = root.join("file.txt");
        touch(&file);
        assert!(validate_dir_path(&file, &roots).is_err());

        // A dir outside the roots is rejected.
        let outside = fresh_root();
        assert!(validate_dir_path(&outside, &roots).is_err());

        // A hidden dir under the root is rejected.
        let hidden = root.join(".secret");
        std::fs::create_dir_all(&hidden).unwrap();
        assert!(validate_dir_path(&hidden, &roots).is_err());
    }
}
