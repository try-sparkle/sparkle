//! Composer attachment helpers: turn a dropped file into a previewable attachment,
//! copy an image to the macOS clipboard, and copy files to a user-chosen destination
//! (single download, or bulk into a folder).
//!
//! Images are detected by extension and returned with a `data:` URL so the UI can show
//! a thumbnail / lightbox without a second IPC round-trip (same shape as screenshot.rs).
//! Clipboard + save flows are macOS-only (the app is macOS-only) and shell out to the
//! built-in `sips` / `osascript` rather than pull in a clipboard crate.

use std::collections::{HashSet, VecDeque};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

// ── User-chosen paths (provenance, NOT location) ────────────────────────────────────────────────
//
// Containment alone is the wrong test for "may we read this file", and it silently ate the user's
// files: a `.txt` dragged from `/private/tmp` was refused, because `std::env::temp_dir()` on macOS
// is the per-user `$TMPDIR` under `/var/folders`, NOT `/tmp`. The drop was accepted by the UI,
// classified, logged — and then discarded with only a log line (bead sparkle-zviq). The picker had
// the identical hole; it merely looked fine because picked files usually sit under `$HOME`.
//
// Widening the roots cannot fix this, only move it: `/Users/Shared`, `/opt`, and any path reached
// through a hidden component (`~/.claude/...`) are all files a user can legitimately hand us, and
// there is no root list that both admits them and still means anything.
//
// So the real question is PROVENANCE, not location: did the OPERATING SYSTEM tell us the user
// chose this file? A path that arrived on a real drag-drop event or came back from a native file
// panel is user intent by construction. Both are observed HERE, in Rust — the webview cannot add to
// this registry, so it remains no help at all to a compromised webview trying to read `~/.ssh/
// id_rsa`, which is the entire threat this module's containment rule exists to stop. Containment
// stays as the rule for every path the webview supplies on its own.
//
// ORDERING, and why there are TWO tiers.
//
// Tauri emits the JS `tauri://drag-drop` event BEFORE it runs our global window-event listener (see
// `manager/window.rs`), so registering only on `Drop` risks racing the frontend's `load_attachment`
// call. `Enter` carries the same paths and fires when the drag first crosses the window, hundreds
// of milliseconds of human time ahead of the release, which removes that race.
//
// But `Enter` is NOT consent. `draggingEntered:` fires for any drag that crosses this window,
// including one on its way to another app entirely — so registering Enter paths durably would mean
// dragging `~/.ssh/id_rsa` PAST Sparkle en route to Terminal permanently granted the exact
// arbitrary-read primitive the containment rule exists to deny. The user never handed us that file.
//
// So the tiers are:
//   - PROVISIONAL (`Enter`): readable only while the drag is over the window. A drag that leaves
//     without dropping is discarded on `Leave`, and each new `Enter` replaces the set.
//   - DURABLE (`Drop`, and the native file panel): the user actually handed us these. Kept, because
//     a thread attachment can be downloaded or copied to the clipboard long after it was attached
//     and expiring it would break those exactly the way containment broke the drop.
//
// PROVISIONAL ALSO EXPIRES, because `Leave` is not guaranteed to arrive. It is the only thing that
// clears a hover, and the app opens several windows (project_window.rs, helper.rs,
// capture_window.rs); a window destroyed mid-drag never delivers `draggingExited:` for its view. A
// grant that survives one lost event for the life of the process is the same session-long grant the
// tiers exist to remove, merely conditioned on a rarer trigger. So each provisional entry carries a
// stamp and is ignored once stale.
//
// The stamp is REFRESHED on `Over`, which is why the TTL can be short without ever expiring under a
// live drag: macOS fires `draggingUpdated:` continuously while the drag is over the window, so a
// real hover keeps renewing itself no matter how long the user deliberates, and the clock only truly
// starts when the OS stops talking to us — exactly the condition a missed `Leave` describes.
//
// The residual exposure is a compromised webview reading a path during the seconds it is hovered.
// That is bounded by the drag itself and is the price of closing the ordering race; a durable grant
// for a drag that never landed is not.

/// How many DURABLE choices we remember — bounded so a long session can't grow this without limit.
/// FIFO: the oldest choice is forgotten first.
const USER_CHOSEN_CAP: usize = 512;

/// How many paths one in-flight drag may make provisionally readable. A drag carries a single
/// Finder selection, so this only has to survive a large multi-file drag.
const DRAGGED_CAP: usize = 512;

/// How long after the OS last mentioned a hovered path we keep honouring it. `Over` refreshes the
/// stamp continuously during a real drag, so this is not a limit on how long a user may hover — it
/// is the window in which a MISSED `Leave` stays exploitable. Generous enough to cover the gap
/// between the last `Over` and the frontend's post-`Drop` read (milliseconds), short enough that a
/// lost event is a blip rather than a session.
const PROVISIONAL_TTL: Duration = Duration::from_secs(10);

#[derive(Default)]
struct Chosen {
    /// Handed to us for real — a completed drop, or a native panel.
    durable: VecDeque<PathBuf>,
    /// Hovering right now, each with the last time the OS told us so. Cleared on Leave, superseded
    /// on Drop, and ignored once older than `PROVISIONAL_TTL` in case Leave never comes.
    provisional: VecDeque<(PathBuf, Instant)>,
}

// The tier rules as PURE methods over already-canonicalized paths. The public fns below are thin
// wrappers that take the global lock. Split this way so the rules can be tested against a LOCAL
// `Chosen`: they are all about what the registry FORGETS, and testing that through the process-wide
// registry would have concurrent tests clearing each other's state mid-assertion.
impl Chosen {
    /// A drag is over the window. Replaces rather than appends: each Enter is a new drag, and the
    /// previous one either dropped (already durable) or left (already irrelevant). Appending would
    /// keep every file ever hovered readable until the cap evicted it.
    fn note_dragged(&mut self, real: Vec<PathBuf>, now: Instant) {
        self.provisional.clear();
        for p in real {
            if self.provisional.iter().any(|(q, _)| *q == p) {
                continue;
            }
            if self.provisional.len() >= DRAGGED_CAP {
                self.provisional.pop_front();
            }
            self.provisional.push_back((p, now));
        }
    }

    /// The drag is still over us (`Over`). Renew the stamps: the OS is telling us this hover is
    /// live, which is the only evidence that distinguishes a real drag from a lost `Leave`.
    fn refresh_dragged(&mut self, now: Instant) {
        for entry in &mut self.provisional {
            entry.1 = now;
        }
    }

    /// The drag left without dropping — it was never for us.
    fn forget_dragged(&mut self) {
        self.provisional.clear();
    }

    /// A completed drop, or a native panel: consent. Supersedes the provisional set.
    fn note_chosen(&mut self, real: Vec<PathBuf>) {
        for p in real {
            remember_into(&mut self.durable, p, USER_CHOSEN_CAP);
        }
        self.provisional.clear();
    }

    fn contains(&self, real: &Path, now: Instant) -> bool {
        self.durable.iter().any(|p| p == real)
            || self.provisional.iter().any(|(p, seen)| {
                p == real && now.saturating_duration_since(*seen) <= PROVISIONAL_TTL
            })
    }
}

fn chosen() -> &'static Mutex<Chosen> {
    static PATHS: OnceLock<Mutex<Chosen>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(Chosen::default()))
}

/// Canonicalize, skipping what can't be resolved: a path we can't canonicalize can't be matched at
/// read time anyway. Canonicalizing on the way IN is what closes the symlink-swap window — a link
/// repointed between the drag and the read resolves to a target that was never registered.
fn canonical_all<I: IntoIterator<Item = PathBuf>>(paths: I) -> Vec<PathBuf> {
    paths.into_iter().filter_map(|p| p.canonicalize().ok()).collect()
}

/// A drag is now OVER the window (`DragDropEvent::Enter`). Provisional only — see the tier note.
fn note_dragged_paths<I: IntoIterator<Item = PathBuf>>(paths: I) {
    let real = canonical_all(paths);
    if let Ok(mut c) = chosen().lock() {
        c.note_dragged(real, Instant::now());
    }
}

/// The drag is still over the window (`DragDropEvent::Over`) — renew the provisional stamps.
fn refresh_dragged_paths() {
    if let Ok(mut c) = chosen().lock() {
        c.refresh_dragged(Instant::now());
    }
}

/// The drag left without dropping (`DragDropEvent::Leave`) — it was never for us.
fn forget_dragged_paths() {
    if let Ok(mut c) = chosen().lock() {
        c.forget_dragged();
    }
}

/// Record paths the user genuinely chose through the OS: a completed DROP, or a native file panel.
pub fn note_user_chosen_paths<I: IntoIterator<Item = PathBuf>>(paths: I) {
    let real = canonical_all(paths);
    if let Ok(mut c) = chosen().lock() {
        c.note_chosen(real);
    }
}

/// Which tier each drag phase grants. This lives HERE, not at the `on_window_event` call site,
/// because it IS the security property: `Enter` → provisional, `Drop` → consent, `Leave` → forget.
/// Wired up in `lib.rs`, the whole rule was a match arm no test could reach, so re-collapsing it to
/// the pre-fix `Enter { paths, .. } | Drop { paths, .. } =>` — which made a drag merely crossing the
/// window a permanent read grant — would have left the suite green. `dispatch_drag` below is the
/// testable form.
pub fn note_drag_event(event: &tauri::DragDropEvent) {
    match dispatch_drag(event) {
        DragGrant::Provisional(paths) => note_dragged_paths(paths),
        DragGrant::Renew => refresh_dragged_paths(),
        DragGrant::Durable(paths) => note_user_chosen_paths(paths),
        DragGrant::Forget => forget_dragged_paths(),
        DragGrant::Ignore => {}
    }
}

/// What a drag phase grants. Named so a test can assert the MAPPING without a live registry, an
/// event loop, or a real window.
#[derive(Debug, PartialEq, Eq)]
pub enum DragGrant {
    /// Readable while hovered, discarded if the drag leaves (`Enter`).
    Provisional(Vec<PathBuf>),
    /// Still hovering — renew the provisional stamps (`Over`).
    Renew,
    /// Consent: the user let go over us (`Drop`).
    Durable(Vec<PathBuf>),
    /// The drag left without dropping (`Leave`).
    Forget,
    /// A variant this Tauri version does not have yet.
    Ignore,
}

fn dispatch_drag(event: &tauri::DragDropEvent) -> DragGrant {
    match event {
        tauri::DragDropEvent::Enter { paths, .. } => DragGrant::Provisional(paths.clone()),
        tauri::DragDropEvent::Over { .. } => DragGrant::Renew,
        tauri::DragDropEvent::Drop { paths, .. } => DragGrant::Durable(paths.clone()),
        tauri::DragDropEvent::Leave => DragGrant::Forget,
        _ => DragGrant::Ignore,
    }
}

/// The bookkeeping half of the registries, split out so the eviction rule can be tested against a
/// LOCAL queue. Testing it through the global registry would mean a test that pushes a full cap of
/// entries, which evicts whatever the concurrently-running tests just registered.
fn remember_into(q: &mut VecDeque<PathBuf>, real: PathBuf, cap: usize) {
    if q.contains(&real) {
        return;
    }
    if q.len() >= cap {
        q.pop_front();
    }
    q.push_back(real);
}

/// True when `real` (already canonicalized) is one the user handed us, or one currently being
/// dragged over the window. A poisoned lock reads as "not chosen" — fail-closed, falling back to
/// plain containment.
fn is_user_chosen(real: &Path) -> bool {
    let now = Instant::now();
    chosen().lock().map(|c| c.contains(real, now)).unwrap_or(false)
}

/// Validate a path we're about to READ (it must already exist). Canonicalizing first resolves
/// symlinks and `..`, so `~/Downloads/../.ssh/id_rsa` is caught, and closes the check-vs-use
/// window (we return the real path for the caller to read). Accepts a path the user chose through
/// the OS (see the provenance note above); otherwise rejects anything outside the allowed roots or
/// reaching a hidden component.
fn validate_read_path(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let real = path
        .canonicalize()
        .map_err(|e| format!("cannot access {}: {e}", path.display()))?;
    if is_contained_and_visible(&real, roots) || is_user_chosen(&real) {
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

    // ── Provenance: a path the OS told us the user chose ────────────────────────────────────────
    //
    // These share one process-global registry, so each test uses its own `fresh_root()` and never
    // asserts on the registry's size — only on its own paths. Registration is additive, so
    // concurrent tests cannot make each other pass or fail.

    #[test]
    fn read_accepts_a_user_chosen_path_outside_every_root() {
        // THE REPORTED BUG (sparkle-zviq), as a test: a `.txt` at a location no root covers —
        // `/private/tmp` on the real machine — dragged in by hand.
        let outside = fresh_root(); // a real dir that is NOT in the allowed list
        let roots = vec![fresh_root()];
        let f = outside.join("sparkle-hang.txt");
        touch(&f);

        // Before the OS tells us the user chose it, containment is the only rule and refuses it.
        assert!(
            validate_read_path(&f, &roots).is_err(),
            "precondition: an unchosen path outside every root must still be refused"
        );

        note_user_chosen_paths([f.clone()]);

        let got = validate_read_path(&f, &roots).expect("a user-dragged file must be readable");
        assert_eq!(got, f.canonicalize().unwrap());
    }

    #[test]
    fn load_blocking_reads_a_dragged_txt_from_slash_tmp() {
        // The user's exact case, driven through the REAL command body rather than the validator:
        // `/private/tmp/sparkle-hang.txt`, dragged onto the concierge, refused and discarded.
        // `/tmp` is deliberate — it is NOT `std::env::temp_dir()` on macOS (that is the per-user
        // `$TMPDIR` under `/var/folders`), which is the whole reason this failed.
        let dir = PathBuf::from("/tmp").join(format!("sparkle-drop-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("sparkle-hang.txt");
        std::fs::write(&f, b"notes the user dragged in").unwrap();

        // Only assert the refusal when `/tmp` really is outside the roots. If `TMPDIR` is unset,
        // `std::env::temp_dir()` IS `/tmp` and containment would already allow it — a machine where
        // the bug cannot reproduce, and asserting a refusal there would be asserting the wrong
        // thing rather than finding a regression.
        let tmp_is_a_root = std::env::temp_dir()
            .canonicalize()
            .map(|t| f.canonicalize().map(|r| r.starts_with(&t)).unwrap_or(false))
            .unwrap_or(false);
        if !tmp_is_a_root {
            assert!(
                load_blocking(f.to_str().unwrap()).is_err(),
                "precondition: containment alone refuses a /tmp file (this WAS the bug)"
            );
        }

        note_user_chosen_paths([f.clone()]);

        let loaded = load_blocking(f.to_str().unwrap())
            .expect("a .txt the user dragged in from /tmp must attach");
        assert_eq!(loaded.name, "sparkle-hang.txt");
        // A text file rides along as a file tile — no inline preview, but a real attachment.
        assert!(loaded.data_url.is_none(), "a .txt is a file tile, not an image preview");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── The Enter/Drop tiers ────────────────────────────────────────────────────────────────────
    //
    // Driven against a LOCAL `Chosen`, not the process-wide registry: every rule here is about what
    // the registry FORGETS, and a test that clears provisional state globally would wipe whatever a
    // concurrently-running test had just registered. The global wrappers are three lines each, and
    // `load_blocking_reads_a_dragged_txt_from_slash_tmp` covers the durable path end to end.

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn a_drag_that_leaves_without_dropping_grants_nothing() {
        // The hover-through: a drag from Finder to ANOTHER app that merely crosses this window.
        // `draggingEntered:` fires for it, so a durable grant here would mean dragging
        // `~/.ssh/id_rsa` past Sparkle en route to Terminal hands a compromised webview an
        // arbitrary read for the life of the process. The user never gave us that file.
        let t = Instant::now();
        let mut c = Chosen::default();
        c.note_dragged(vec![p("/home/me/.ssh/id_rsa")], t);
        // Readable WHILE hovering — that is what closes the race with the JS drop event.
        assert!(c.contains(&p("/home/me/.ssh/id_rsa"), t), "readable during the drag");

        c.forget_dragged();
        assert!(
            !c.contains(&p("/home/me/.ssh/id_rsa"), t),
            "a drag that left without dropping must not leave a lasting grant"
        );
    }

    #[test]
    fn a_hover_whose_leave_never_arrives_expires_on_its_own() {
        // `Leave` is the ONLY thing that clears a hover, and it is not guaranteed: a window
        // destroyed mid-drag never delivers `draggingExited:` for its view. Without a TTL that one
        // lost event restores the session-long grant the tiers exist to remove — the same
        // arbitrary-read primitive, just via a rarer trigger.
        let t = Instant::now();
        let mut c = Chosen::default();
        c.note_dragged(vec![p("/home/me/.ssh/id_rsa")], t);

        // No Leave, no Drop, no Over — the OS simply stopped talking about this drag.
        assert!(
            !c.contains(&p("/home/me/.ssh/id_rsa"), t + PROVISIONAL_TTL + Duration::from_secs(1)),
            "a hover the OS stopped reporting must stop being readable"
        );
    }

    #[test]
    fn a_live_hover_stays_readable_however_long_the_user_deliberates() {
        // The other half of the TTL: `Over` fires continuously during a real drag, so the clock only
        // starts when the OS goes quiet. If the TTL expired under a live hover instead, a user who
        // held a file over the window while finding the right spot would be back to the original
        // bug — an accepted drop that silently refuses to load.
        let t = Instant::now();
        let mut c = Chosen::default();
        c.note_dragged(vec![p("/tmp/notes.txt")], t);

        // Still dragging, well past the TTL, with the OS reporting it the whole time.
        let mut hovering = t;
        for _ in 0..10 {
            hovering += PROVISIONAL_TTL;
            c.refresh_dragged(hovering);
            assert!(
                c.contains(&p("/tmp/notes.txt"), hovering),
                "a hover the OS is still reporting stays readable"
            );
        }
    }

    #[test]
    fn a_dropped_path_outlives_the_drag_that_delivered_it() {
        // The mirror of the test above: a real drop IS consent, and the grant has to survive, or a
        // thread attachment could not be downloaded or copied to the clipboard afterwards.
        let t = Instant::now();
        let mut c = Chosen::default();
        c.note_dragged(vec![p("/tmp/dropped.txt")], t);
        c.note_chosen(vec![p("/tmp/dropped.txt")]); // the Drop
        c.forget_dragged(); // a later, unrelated drag leaves

        // Long after the provisional TTL would have lapsed: consent does not expire, or a thread
        // attachment could not be downloaded an hour later.
        assert!(
            c.contains(&p("/tmp/dropped.txt"), t + Duration::from_secs(3600)),
            "a dropped file stays readable after the drag is over"
        );
    }

    #[test]
    fn a_new_drag_replaces_the_previous_hover_grant() {
        // Each Enter is a new drag; the previous one either dropped (already durable) or left. If
        // Enter appended instead of replacing, every file ever hovered would stay readable until
        // the cap evicted it — the durable-grant bug wearing a different hat.
        let t = Instant::now();
        let mut c = Chosen::default();
        c.note_dragged(vec![p("/tmp/first.txt")], t);
        c.note_dragged(vec![p("/tmp/second.txt")], t);

        assert!(c.contains(&p("/tmp/second.txt"), t), "the current drag is readable");
        assert!(
            !c.contains(&p("/tmp/first.txt"), t),
            "the previous drag's paths must not persist into the next one"
        );
    }

    #[test]
    fn a_drop_does_not_strand_the_provisional_set() {
        // Drop supersedes the hover it completes. Leaving provisional populated would keep every
        // path of the last drag readable indefinitely, since only Leave clears it and Leave does
        // not fire after a successful drop.
        let t = Instant::now();
        let mut c = Chosen::default();
        c.note_dragged(vec![p("/tmp/a.txt"), p("/tmp/b.txt")], t);
        c.note_chosen(vec![p("/tmp/a.txt")]); // only a.txt was actually dropped

        assert!(c.contains(&p("/tmp/a.txt"), t), "the dropped file is granted");
        assert!(
            !c.contains(&p("/tmp/b.txt"), t),
            "a path that was hovered but not dropped must not survive the drop"
        );
    }

    // ── The WIRING, not just the rules ──────────────────────────────────────────────────────────
    //
    // Every test above drives `Chosen` directly, which proves the tiers are implemented correctly
    // and nothing at all about which drag phase reaches which tier. That mapping was a match at the
    // `on_window_event` call site — unreachable from any test — so re-merging the arms into the
    // pre-fix `Enter { paths, .. } | Drop { paths, .. } =>` would have left the suite green while
    // dragging `~/.ssh/id_rsa` past the window was once again a permanent grant.

    fn drag_position() -> tauri::PhysicalPosition<f64> {
        tauri::PhysicalPosition { x: 0.0, y: 0.0 }
    }

    #[test]
    fn entering_grants_only_provisionally_and_dropping_is_consent() {
        assert_eq!(
            dispatch_drag(&tauri::DragDropEvent::Enter {
                paths: vec![p("/home/me/.ssh/id_rsa")],
                position: drag_position(),
            }),
            DragGrant::Provisional(vec![p("/home/me/.ssh/id_rsa")]),
            "a drag merely crossing the window must NOT be durable consent"
        );
        assert_eq!(
            dispatch_drag(&tauri::DragDropEvent::Drop {
                paths: vec![p("/tmp/notes.txt")],
                position: drag_position(),
            }),
            DragGrant::Durable(vec![p("/tmp/notes.txt")]),
            "letting go over us IS consent"
        );
    }

    #[test]
    fn leaving_forgets_and_hovering_renews() {
        assert_eq!(
            dispatch_drag(&tauri::DragDropEvent::Leave),
            DragGrant::Forget,
            "a drag that leaves without dropping must drop its grant"
        );
        assert_eq!(
            dispatch_drag(&tauri::DragDropEvent::Over { position: drag_position() }),
            DragGrant::Renew,
            "Over is the OS confirming the hover is live — it must renew the TTL"
        );
    }

    #[test]
    fn read_still_rejects_a_neighbour_of_a_user_chosen_path() {
        // Choosing one file must not open its directory: the registry admits exactly the paths the
        // OS named, so a compromised webview can't walk from a dragged file to its siblings.
        let outside = fresh_root();
        let roots = vec![fresh_root()];
        let chosen = outside.join("dragged.txt");
        let neighbour = outside.join("secret.txt");
        touch(&chosen);
        touch(&neighbour);

        note_user_chosen_paths([chosen.clone()]);

        assert!(validate_read_path(&chosen, &roots).is_ok(), "the chosen file is readable");
        assert!(
            validate_read_path(&neighbour, &roots).is_err(),
            "a sibling the user never chose must stay refused"
        );
    }

    #[test]
    fn read_rejects_a_symlink_swapped_after_the_user_chose_it() {
        // The check-vs-use window: we canonicalize at registration AND at read, so repointing the
        // link between the drop and the read resolves to a target that was never chosen.
        let outside = fresh_root();
        let roots = vec![fresh_root()];
        let real_target = outside.join("innocent.txt");
        let secret = outside.join("secret.txt");
        touch(&real_target);
        touch(&secret);
        let link = outside.join("link.txt");
        std::os::unix::fs::symlink(&real_target, &link).unwrap();

        note_user_chosen_paths([link.clone()]);
        assert!(validate_read_path(&link, &roots).is_ok(), "the chosen target is readable");

        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert!(
            validate_read_path(&link, &roots).is_err(),
            "a link repointed after the choice must not carry the choice to its new target"
        );
    }

    #[test]
    fn user_chosen_registry_is_bounded_and_forgets_oldest_first() {
        // The registry grows on every drag ENTER, so an unbounded one would be a slow leak.
        let mut q = VecDeque::new();
        remember_into(&mut q, PathBuf::from("/a/first.txt"), 3);
        for n in 0..3 {
            remember_into(&mut q, PathBuf::from(format!("/a/filler-{n}.txt")), 3);
        }
        assert_eq!(q.len(), 3, "the cap must hold");
        assert!(
            !q.contains(&PathBuf::from("/a/first.txt")),
            "the oldest choice must be evicted once the cap is passed"
        );
        assert!(
            q.contains(&PathBuf::from("/a/filler-2.txt")),
            "the newest choice must survive"
        );
    }

    #[test]
    fn re_choosing_a_path_does_not_consume_a_second_slot() {
        // A drag that hovers re-registers on every Enter, so a duplicate must not push the queue
        // along — otherwise one lingering drag evicts every other file the user chose.
        let mut q = VecDeque::new();
        remember_into(&mut q, PathBuf::from("/a/keep.txt"), 2);
        for _ in 0..5 {
            remember_into(&mut q, PathBuf::from("/a/hovering.txt"), 2);
        }
        assert!(
            q.contains(&PathBuf::from("/a/keep.txt")),
            "a repeated Enter must not evict an earlier choice"
        );
        assert_eq!(q.len(), 2);
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
