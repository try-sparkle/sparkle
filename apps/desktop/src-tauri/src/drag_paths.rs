//! Recovering the file paths of a drag that Tauri delivered with NONE.
//!
//! WHY THIS FILE EXISTS — a founder-blocking report: "we can no longer drag photos or files into
//! the Compose window. It doesn't work on any of the buttons." The compose box LIT UP under the
//! drag and then swallowed the drop, on every drop surface, writing nothing to the log.
//!
//! The cause is upstream and one line long. wry's macOS drag handler
//! (`wry-0.55.1/src/wkwebview/drag_drop.rs::collect_paths`) reads exactly ONE pasteboard type:
//!
//! ```ignore
//! let types = NSArray::arrayWithObject(NSFilenamesPboardType);
//! if pb.availableTypeFromArray(&types).is_some() { … }
//! drag_drop_paths            // ← otherwise EMPTY
//! ```
//!
//! `NSFilenamesPboardType` has been deprecated since macOS 10.14 in favour of
//! `NSPasteboardTypeFileURL` (`public.file-url`), and the deprecation note in objc2-app-kit itself
//! says so: *"Create multiple pasteboard items with NSPasteboardTypeFileURL or kUTTypeFileURL
//! instead."* Finder still publishes the legacy type, so a Finder drag works and always has —
//! which is why this looked like a regression rather than a gap that was always there. Sources
//! that publish only the MODERN type (Photos, a browser's image drag, Slack, the macOS screenshot
//! thumbnail) hand wry an empty vector.
//!
//! What made it invisible rather than merely broken is on our side: every one of Sparkle's four
//! drop listeners guards with `if (paths.length === 0) return;` — a SILENT return. And because the
//! drag position is genuinely over a real target, `reportDropWithNoTarget` self-suppresses too. So
//! the app painted the "drop here" affordance from the `enter`/`over` events (which do not depend
//! on paths at all), then discarded the drop without a single log line. That combination — correct
//! affordance, silent discard, no diagnostic — is what cost the debugging time.
//!
//! THE RECOVERY. At the moment a drop is delivered, the drag's pasteboard is still alive and is
//! reachable by NAME: `+[NSPasteboard pasteboardWithName:NSPasteboardNameDrag]` returns the very
//! pasteboard wry just read. So when the frontend receives a drop carrying no paths, it calls this
//! command, which reads that same pasteboard for the types wry skips. Nothing is intercepted and no
//! crate is forked — we read a public, named pasteboard that AppKit keeps valid for the session.
//!
//! ORDERING IS DELIBERATE: legacy type FIRST. When both types are present (a Finder drag) this
//! returns exactly what wry would have returned, so the recovery can never disagree with the normal
//! path about the same drag — it only ever adds paths where there were none.
//!
//! THE RACE, and why it is acceptable: the drag pasteboard is only guaranteed valid until the NEXT
//! drag begins, and this read happens one IPC hop after the drop. A user cannot start a second drag
//! inside that window by hand, and the failure mode if they somehow did is an empty result — i.e.
//! exactly today's behaviour, now with a warning attached. It cannot return the WRONG file: a
//! superseded pasteboard holds the newer drag's contents, and that drag has not been dropped here.

/// Turn a `file://` URL into a filesystem path.
///
/// Pure Rust ON PURPOSE — this is the half of the recovery that can be tested on any platform and
/// in CI, without an NSApplication, a pasteboard, or a real drag. The AppKit half below is a thin
/// read that hands its strings straight to this function.
///
/// Percent-decoding is the part worth having tests for: a dragged photo is far more likely than
/// average to carry spaces, `#`, or non-ASCII in its name ("Screenshot 2026-07-30 at 10.14.02.png"),
/// and a naive `strip_prefix("file://")` yields a path that does not exist on disk. Returning the
/// path un-decoded would be worse than returning nothing, because the attachment loader would then
/// fail on a path the user can see is right.
pub fn file_url_to_path(url: &str) -> Option<String> {
    // `file:///Users/x/a.png` → authority is empty; `file://localhost/Users/…` is also legal.
    let rest = url
        .strip_prefix("file://localhost")
        .or_else(|| url.strip_prefix("file://"))?;
    if !rest.starts_with('/') {
        return None;
    }
    // A fragment/query is not meaningful for a file URL, but a `#` in a FILENAME arrives
    // percent-encoded (`%23`), so anything after a literal `#` is not part of the path.
    let rest = rest.split('#').next().unwrap_or(rest);

    let bytes = rest.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            match u8::from_str_radix(hex, 16) {
                Ok(b) => {
                    out.push(b);
                    i += 3;
                    continue;
                }
                // A literal `%` that is not an escape (legal in a filename) — keep it as-is
                // rather than failing the whole path.
                Err(_) => {}
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    // Percent-decoding works on BYTES; the result must still be valid UTF-8 to be a path we can
    // hand back over IPC. A non-UTF-8 filename is unrepresentable here, and a lossy conversion
    // would produce a path that silently does not exist — so decline instead.
    String::from_utf8(out).ok().filter(|p| !p.is_empty())
}

#[cfg(target_os = "macos")]
fn read_drag_pasteboard_paths() -> Vec<String> {
    use objc2_app_kit::{
        NSFilenamesPboardType, NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeFileURL,
    };
    use objc2_foundation::{NSArray, NSString};

    // SAFETY: reading a named pasteboard. Every call below is a plain AppKit read of memory AppKit
    // owns; nothing is mutated and no object outlives its `Retained` handle.
    unsafe {
        let pb = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);

        // 1. THE LEGACY TYPE FIRST — see the ordering note in the module docs. This is a
        //    byte-for-byte repeat of what wry does, so a Finder drag returns the identical answer.
        #[allow(deprecated)]
        {
            let types = NSArray::arrayWithObject(NSFilenamesPboardType);
            if pb.availableTypeFromArray(&types).is_some() {
                if let Some(plist) = pb.propertyListForType(NSFilenamesPboardType) {
                    if let Ok(arr) = plist.downcast::<NSArray>() {
                        let mut paths = Vec::new();
                        for item in arr.iter() {
                            if let Ok(s) = item.downcast::<NSString>() {
                                paths.push(s.to_string());
                            }
                        }
                        if !paths.is_empty() {
                            return paths;
                        }
                    }
                }
            }
        }

        // 2. THE MODERN TYPE — one pasteboard ITEM per file, which is how a multi-file modern drag
        //    is represented. `stringForType` on the pasteboard itself would see only the first
        //    item, silently turning a 5-photo drag into a 1-photo drag.
        let mut paths = Vec::new();
        if let Some(items) = pb.pasteboardItems() {
            for item in items.iter() {
                if let Some(s) = item.stringForType(NSPasteboardTypeFileURL) {
                    if let Some(p) = file_url_to_path(&s.to_string()) {
                        paths.push(p);
                    }
                }
            }
        }
        if !paths.is_empty() {
            return paths;
        }

        // 3. Last resort: a single file URL set directly on the pasteboard rather than on an item.
        if let Some(s) = pb.stringForType(NSPasteboardTypeFileURL) {
            if let Some(p) = file_url_to_path(&s.to_string()) {
                paths.push(p);
            }
        }
        paths
    }
}

#[cfg(not(target_os = "macos"))]
fn read_drag_pasteboard_paths() -> Vec<String> {
    // The gap being worked around is specific to wry's macOS handler; the Windows and Linux
    // handlers read their platforms' native file lists directly. Returning empty keeps the
    // frontend's one code path honest — it falls through to the same warning it would show for a
    // drag that genuinely carried no file.
    Vec::new()
}

/// Materialise dragged image BYTES as a file, and return its path.
///
/// WHY THIS EXISTS. Everything above recovers a *reference* to a file that already exists on disk.
/// Some drags do not carry one at all: an image dragged out of Preview, Photos, or a browser's
/// rendered `<img>` publishes only the image DATA. Those drags have no file URL under any
/// pasteboard type, so every path above returns empty and the drop dies with "the drag really had
/// no file" — which is true, and useless to a user who watched themselves drag a picture.
///
/// The agent CLIs read files off disk, so the only way to hand one of these to an agent is to give
/// the bytes a path. We write them to the OS temp directory and return that, which then flows
/// through the identical paste-a-path route as every other drop.
///
/// PURE ON PURPOSE — the AppKit read hands its bytes here, so the naming, the extension choice and
/// the write are all testable in CI without a pasteboard or a real drag.
///
/// `seq` (not just `stamp`) is what makes the filename collision-free: a multi-image drag can
/// materialise several files within the same millisecond, and two files sharing a name is a
/// silent data-loss bug (the second write clobbers the first) — not merely an ugly name.
pub fn write_dropped_bytes(
    dir: &std::path::Path,
    ext: &str,
    stamp: u128,
    seq: u64,
    bytes: &[u8],
) -> Option<String> {
    // An empty payload is not a file. Writing a 0-byte .png would hand the agent a path that exists
    // and cannot be read as an image, which is strictly worse than reporting nothing.
    if bytes.is_empty() {
        return None;
    }
    // The extension is ours, never the pasteboard's — see the callers below. Refusing anything with
    // a separator keeps a future caller from turning this into a path-traversal write.
    if ext.is_empty() || ext.contains('/') || ext.contains('.') {
        return None;
    }
    let path = dir.join(format!("sparkle-drop-{stamp}-{seq}.{ext}"));
    std::fs::write(&path, bytes).ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// Milliseconds since the epoch, for the temp file's name. Purely informational now that `seq`
/// (see `next_drop_seq`) is what actually guarantees uniqueness — kept because a human scanning
/// `/tmp` benefits from a roughly-sortable, roughly-timestamped name.
fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Process-global monotonic counter appended to every dropped-bytes filename. Two images in the
/// same multi-item drag can legitimately share a millisecond timestamp; `seq` is what keeps their
/// files from colliding (PR #1352's review caught exactly this: the pre-fix version derived a name
/// from the timestamp alone, so a fast multi-image drag would have silently overwritten all but the
/// last file written in a given millisecond).
fn next_drop_seq() -> u64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// How long a materialised drop file may sit in the temp dir before `sweep_stale_drop_files`
/// removes it. Long enough that a slow agent turn (the file has to survive until whatever CLI
/// process reads it gets around to doing so) won't race the sweep; short enough that a machine
/// that drags in images often does not accumulate them indefinitely. This is a BACKSTOP, not the
/// primary cleanup story — there isn't one yet, which is exactly why this exists.
const DROP_FILE_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// The dedicated directory materialised drops are written to and swept from.
///
/// SEPARATE from `window_screenshot::capture_dir()` ON PURPOSE. Both dirs end in `.noindex` so
/// macOS Spotlight / `mediaanalysisd` never analyses their contents, but their RETENTION differs:
/// captures are swept at 1h, drops need [`DROP_FILE_MAX_AGE`] (24h) so a slow agent turn does not
/// race the sweep for a file it still has to read. Co-mingling drops into the 1h-swept captures dir
/// would silently shorten that window to an hour. Giving drops their OWN `.noindex` dir keeps the
/// index-exclusion win without touching the 24h backstop this module owns.
fn drop_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("sparkle-drops.noindex")
}

/// Delete our own stale `sparkle-drop-*` files from `dir`. PURE data-in/data-out over a file list
/// so the age rule is testable without touching a real temp directory's unrelated contents.
///
/// Only ever removes files whose name we recognise (`write_dropped_bytes`'s own naming scheme) —
/// this walks the OS temp directory, which is shared with every other process on the machine, so
/// matching by prefix is a safety rule, not an optimisation.
fn sweep_stale_entries<I: IntoIterator<Item = (std::path::PathBuf, std::time::SystemTime)>>(
    entries: I,
    now: std::time::SystemTime,
) -> Vec<std::path::PathBuf> {
    entries
        .into_iter()
        .filter(|(path, modified)| {
            let is_ours = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("sparkle-drop-"));
            is_ours
                && now
                    .duration_since(*modified)
                    .map(|age| age >= DROP_FILE_MAX_AGE)
                    .unwrap_or(false)
        })
        .map(|(path, _)| path)
        .collect()
}

/// Throttle for the real sweep below: filesystem work runs on the thread that just handled a real
/// drop (a rare, human-paced event), but there is no reason to re-list the temp directory on every
/// single one. Once per hour of wall-clock is often enough for a 24h retention window.
const SWEEP_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Per-image cap on the fallback below (mirrors `attachments::MAX_PREVIEW_BYTES`). Oversized bytes
/// are skipped rather than written: without this, one full-resolution image on the pasteboard turns
/// a "recover a dropped picture" command into an unbounded copy + disk write.
const MAX_DROP_IMAGE_BYTES: usize = 40 * 1024 * 1024;

/// A drag carries one Finder/AppKit selection; this is a generous cap on how many pasteboard items
/// the fallback will materialise, not a realistic drag size. It exists so a pathological pasteboard
/// can't turn one drop into an unbounded number of writes.
const MAX_DROP_IMAGE_ITEMS: usize = 20;

/// Materialise one image's bytes as a file, converting TIFF to PNG via `sips` (already used for the
/// clipboard flows in this crate — see `attachments::copy_image_blocking`) so the result is
/// something downstream can actually use: `attachments::IMAGE_EXTENSIONS`, its TS mirror, and
/// `mime_for` all omit `tiff`, and the ordering note above says PNG is "the one the model accepts".
/// Writing raw TIFF bytes would materialise a file useless to both the UI and the agent while the
/// user believes their image attached.
///
/// Enforces `MAX_DROP_IMAGE_BYTES` — this is the one place that actually writes, so the cap lives
/// here rather than at each call site.
fn materialize_image_bytes(dir: &std::path::Path, stamp: u128, is_png: bool, bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_DROP_IMAGE_BYTES {
        tracing::warn!(
            target: "ui",
            bytes = bytes.len(),
            cap = MAX_DROP_IMAGE_BYTES,
            "drag-drop: skipping an oversized dropped image"
        );
        return None;
    }
    let seq = next_drop_seq();
    if is_png {
        return write_dropped_bytes(dir, "png", stamp, seq, bytes);
    }
    let scratch = write_dropped_bytes(dir, "tiff", stamp, seq, bytes)?;
    let png_path = dir.join(format!("sparkle-drop-{stamp}-{seq}.png"));
    let converted = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "png"])
        .arg(&scratch)
        .arg("--out")
        .arg(&png_path)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    // The scratch TIFF is an internal step, never the return value — clean it up regardless of
    // whether the conversion succeeded.
    let _ = std::fs::remove_file(&scratch);
    if converted {
        Some(png_path.to_string_lossy().into_owned())
    } else {
        let _ = std::fs::remove_file(&png_path);
        None
    }
}

fn sweep_due(now: std::time::Instant) -> bool {
    static LAST_SWEPT: std::sync::OnceLock<std::sync::Mutex<Option<std::time::Instant>>> =
        std::sync::OnceLock::new();
    let cell = LAST_SWEPT.get_or_init(|| std::sync::Mutex::new(None));
    let Ok(mut last) = cell.lock() else { return false };
    let due = last.is_none_or(|t| now.saturating_duration_since(t) >= SWEEP_MIN_INTERVAL);
    if due {
        *last = Some(now);
    }
    due
}

/// Best-effort, off its OWN thread (in addition to `recover_drag_paths` already running the whole
/// fallback via `spawn_blocking`): list the OS temp dir, remove our own stale entries. Fired from
/// the image-bytes fallback below, throttled by `sweep_due` so a burst of drops in the same hour
/// does one listing, not N. The extra thread means a sweep never adds latency to the drop it rides
/// in on, even though that drop's own work is no longer main-thread-bound either.
fn maybe_sweep_stale_drop_files() {
    if !sweep_due(std::time::Instant::now()) {
        return;
    }
    std::thread::spawn(|| {
        let dir = drop_dir();
        let Ok(read) = std::fs::read_dir(&dir) else { return };
        let entries = read.filter_map(|e| {
            let e = e.ok()?;
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((e.path(), modified))
        });
        for stale in sweep_stale_entries(entries, std::time::SystemTime::now()) {
            let _ = std::fs::remove_file(stale);
        }
    });
}

/// Check a length and materialise it, WITHOUT copying oversized data first — a PURE function over
/// an injected length and copy closure, so a test can assert the closure never ran, not just that
/// the return value is `None`.
///
/// `materialize_image_bytes` also checks `MAX_DROP_IMAGE_BYTES`, but by the time bytes reach it a
/// copy has already happened, and its own cap would produce the IDENTICAL `None` whether or not
/// the copy ran — so a test that only inspects the return value can't distinguish this function
/// existing from it being deleted. Only a closure that provably didn't run can.
fn materialize_sized_data(
    dir: &std::path::Path,
    stamp: u128,
    is_png: bool,
    len: usize,
    copy: impl FnOnce() -> Vec<u8>,
) -> Option<String> {
    if len > MAX_DROP_IMAGE_BYTES {
        tracing::warn!(
            target: "ui",
            bytes = len,
            cap = MAX_DROP_IMAGE_BYTES,
            "drag-drop: skipping an oversized dropped image without copying it"
        );
        return None;
    }
    materialize_image_bytes(dir, stamp, is_png, &copy())
}

/// The real caller: `NSData::len()` is a cheap accessor (no copy), so checking it BEFORE `to_vec()`
/// is what actually stops an oversized pasteboard payload from being copied onto the heap at all.
/// Without this, the cap only ever bounded the WRITE; the copy it was meant to bound too still ran
/// unconditionally.
#[cfg(target_os = "macos")]
fn materialize_pasteboard_data(
    dir: &std::path::Path,
    stamp: u128,
    is_png: bool,
    data: &objc2_foundation::NSData,
) -> Option<String> {
    materialize_sized_data(dir, stamp, is_png, data.len(), || data.to_vec())
}

#[cfg(target_os = "macos")]
fn read_drag_pasteboard_image_bytes() -> Vec<String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag};

    // Write into the dedicated `.noindex` drops dir (see `drop_dir`) so macOS never indexes/analyses
    // these files, created best-effort — a failed create just means the write below returns None,
    // which is the same "no file recovered" path a byte-less drag already takes.
    let dir = drop_dir();
    let _ = std::fs::create_dir_all(&dir);
    let stamp = now_millis();

    // SAFETY: reading a named pasteboard; every call is a plain AppKit read of memory AppKit owns.
    // The `NSPasteboardType*` constants are `extern "C" static`s, which is what actually requires
    // this block — referencing a foreign static is unsafe even though reading it is harmless.
    let mut paths = Vec::new();
    unsafe {
        // ORDER IS BY WHAT CLAUDE CAN ACTUALLY READ, not by pasteboard convenience. A macOS image
        // drag usually offers TIFF *and* PNG; PNG is the one the model accepts, so it goes first
        // and TIFF is a last resort rather than the default it would be if we simply took the
        // first available type — and when only TIFF is offered, `materialize_image_bytes` converts
        // it to PNG rather than writing bytes nothing downstream treats as an image.
        let image_types: [(&objc2_foundation::NSString, bool); 2] = [
            (objc2_app_kit::NSPasteboardTypePNG, true),
            (objc2_app_kit::NSPasteboardTypeTIFF, false),
        ];
        let pb = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);

        // PER ITEM, mirroring `read_drag_pasteboard_paths`'s modern-type tier — a multi-image drag
        // is one pasteboard ITEM per image. Reading pasteboard-LEVEL `dataForType` once (the
        // pre-fix shape PR #1352's review caught) only ever sees the first item, so a 5-photo drag
        // would have silently collapsed to one file. Capped at `MAX_DROP_IMAGE_ITEMS` — a
        // pathological pasteboard must not turn one drop into an unbounded number of writes.
        if let Some(items) = pb.pasteboardItems() {
            for item in items.iter().take(MAX_DROP_IMAGE_ITEMS) {
                for (ty, is_png) in image_types {
                    let Some(data) = item.dataForType(ty) else {
                        continue;
                    };
                    if let Some(p) = materialize_pasteboard_data(&dir, stamp, is_png, &data) {
                        paths.push(p);
                    }
                    // Found this item's image under one type; don't also write it as the other
                    // (PNG vs TIFF of the SAME image is one dropped picture, not two).
                    break;
                }
            }
        }

        // Last resort: no items array, or none of them carried image data directly — some sources
        // set the type on the pasteboard itself rather than per-item. Mirrors tier 3 of the path
        // recovery above.
        if paths.is_empty() {
            for (ty, is_png) in image_types {
                let Some(data) = pb.dataForType(ty) else {
                    continue;
                };
                if let Some(p) = materialize_pasteboard_data(&dir, stamp, is_png, &data) {
                    paths.push(p);
                }
                break;
            }
        }
    }

    if !paths.is_empty() {
        tracing::info!(
            target: "ui",
            files = paths.len(),
            "drag-drop: recovered path-less image drag(s) by writing bytes to temp file(s)"
        );
        maybe_sweep_stale_drop_files();
    }
    paths
}

#[cfg(not(target_os = "macos"))]
fn read_drag_pasteboard_image_bytes() -> Vec<String> {
    Vec::new()
}

/// The decision `recover_drag_paths` makes, as a PURE function over injected reads — so a test can
/// prove the provenance gate is actually consulted, not just that the standalone helper it calls
/// behaves correctly in isolation. `tauri::WebviewWindow` can't be constructed in a unit test, which
/// is exactly why the real command below is a thin wrapper: without this split, deleting the
/// `has_recent_drop` check and restoring the ambient-read vulnerability left the whole suite green
/// (the command was untestable by construction).
fn recover_for(
    window: &str,
    read_paths: impl FnOnce() -> Vec<String>,
    has_recent_drop: impl FnOnce(&str) -> bool,
    read_image_bytes: impl FnOnce() -> Vec<String>,
) -> Vec<String> {
    let paths = read_paths();
    if !paths.is_empty() {
        return paths;
    }
    // LAST, and only when there is no file to point at. A drag that references a real file must
    // always yield that file's own path — materialising a temp copy of a file the user already has
    // would give the agent a path that outlives nothing and matches nothing they can see.
    //
    // GATED on a real drag having just reached this exact window: `has_recent_drop` (the real
    // implementation is `attachments::take_recent_drop`) is set ONLY from `note_drag_event`, which
    // Tauri wires to actual AppKit drag delivery — no webview-controlled JS can set it. Without a
    // fresh marker, refuse rather than read the pasteboard at all.
    if !has_recent_drop(window) {
        tracing::warn!(
            target: "ui",
            window,
            "drag-drop: recover_drag_paths called with no corresponding drag; refusing the \
             image-bytes fallback"
        );
        return Vec::new();
    }
    read_image_bytes()
}

/// Paths for a drop whose Tauri event carried none. Empty result = the drag really had no file.
///
/// ASYNC, unlike the rest of this file's reads. The fast path (`read_drag_pasteboard_paths`) is
/// still a microsecond in-memory read, but the fallback it can fall through to now copies pasteboard
/// bytes and writes them to disk, capped at `MAX_DROP_IMAGE_BYTES` per item and `MAX_DROP_IMAGE_ITEMS`
/// items — still tens of MB in the worst case, and `sips` shells out a process for a TIFF. None of
/// that belongs on the main thread, so the whole body runs via `spawn_blocking`, matching
/// `attachments::probe_attachment`'s pattern. The scheduling hop this adds is negligible next to the
/// race this file's other reads guard against (a user starting a second drag by hand).
///
/// `window` is the PROVENANCE check for the image-bytes fallback (see `recover_for`): without it
/// there is nothing a guard could validate — any permitted webview could invoke this command
/// ambiently, with no drag over Sparkle at all, and read whatever a PREVIOUS drag left resident on
/// the OS-wide drag pasteboard (PR #1352's review, blocking probe #1). Tauri injects this parameter
/// from the real invoking window; the frontend does not pass it.
#[tauri::command]
pub async fn recover_drag_paths(window: tauri::WebviewWindow) -> Vec<String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        recover_for(
            &label,
            read_drag_pasteboard_paths,
            crate::attachments::take_recent_drop,
            read_drag_pasteboard_image_bytes,
        )
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        drop_dir, file_url_to_path, materialize_image_bytes, materialize_sized_data, recover_for,
        sweep_stale_entries, write_dropped_bytes, DROP_FILE_MAX_AGE, MAX_DROP_IMAGE_BYTES,
    };

    /// Drops get their OWN `.noindex` directory, NOT the 1h-swept captures dir, so their 24h
    /// retention survives. RED if `drop_dir` is reverted to a plain temp path (index exclusion lost)
    /// or pointed at the captures dir (`sparkle-captures.noindex`, whose retention is 1h). Both
    /// halves are asserted because either regression is a real, separately-shipped bug.
    #[test]
    fn drops_live_in_their_own_noindex_dir_with_24h_retention() {
        let dir = drop_dir();
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        assert_eq!(name, "sparkle-drops.noindex", "got {}", dir.display());
        assert!(name.ends_with(".noindex"), "drop dir must be index-excluded, got {name}");
        // Distinct from the captures dir, whose sweep is 1h — co-mingling would shorten this window.
        assert_ne!(name, "sparkle-captures.noindex");
        assert_eq!(DROP_FILE_MAX_AGE, std::time::Duration::from_secs(24 * 60 * 60));
    }

    #[test]
    fn plain_path_round_trips() {
        assert_eq!(
            file_url_to_path("file:///Users/x/photo.png").as_deref(),
            Some("/Users/x/photo.png")
        );
    }

    #[test]
    fn decodes_the_spaces_a_screenshot_name_always_has() {
        // The single most likely real input: macOS names screenshots with spaces, so a recovery
        // that skipped decoding would hand the attachment loader a path that does not exist.
        assert_eq!(
            file_url_to_path("file:///Users/x/Screenshot%202026-07-30%20at%2010.14.02.png")
                .as_deref(),
            Some("/Users/x/Screenshot 2026-07-30 at 10.14.02.png")
        );
    }

    #[test]
    fn decodes_non_ascii_and_reserved_characters() {
        assert_eq!(
            file_url_to_path("file:///Users/x/caf%C3%A9%20%231.png").as_deref(),
            Some("/Users/x/café #1.png")
        );
    }

    #[test]
    fn accepts_the_localhost_authority_spelling() {
        assert_eq!(
            file_url_to_path("file://localhost/Users/x/a.png").as_deref(),
            Some("/Users/x/a.png")
        );
    }

    #[test]
    fn rejects_what_is_not_a_local_file_url() {
        // A non-file scheme, and a file URL with no absolute path, must not become a path — the
        // caller would hand either straight to the attachment loader.
        assert_eq!(file_url_to_path("https://example.com/a.png"), None);
        assert_eq!(file_url_to_path("file://"), None);
        assert_eq!(file_url_to_path("file://relative"), None);
    }

    #[test]
    fn a_lone_percent_is_kept_rather_than_failing_the_path() {
        // `%` is legal in a filename and arrives unescaped from some sources; dropping the whole
        // path over it would lose a file the user can see.
        assert_eq!(
            file_url_to_path("file:///Users/x/100%.png").as_deref(),
            Some("/Users/x/100%.png")
        );
    }

    // ── write_dropped_bytes ─────────────────────────────────────────────────────────────────────

    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sparkle-drop-test-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A drag carrying only image BYTES becomes a real file the agent can read. This is the path an
    /// image dragged out of Preview or a browser takes — it has no file URL at all, so before this
    /// it recovered nothing and the drop reported "the drag really had no file".
    #[test]
    fn image_bytes_become_a_file_on_disk() {
        let dir = scratch_dir("single");
        let bytes = b"\x89PNG\r\n\x1a\nnot-really-a-png-but-bytes";
        let p = write_dropped_bytes(&dir, "png", 1_700_000_000_000, 0, bytes)
            .expect("bytes should become a path");

        // The SIDE EFFECT, not the return value: the file must actually exist and hold the bytes,
        // because the whole point is that an agent CLI opens it by path.
        assert!(std::path::Path::new(&p).exists(), "the temp file must exist");
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
        assert!(p.ends_with(".png"), "got {p}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_payload_is_not_written() {
        let dir = scratch_dir("empty");
        // A 0-byte file would be a path that exists and cannot be read as an image — worse than
        // reporting nothing, because the failure moves to the agent.
        assert_eq!(write_dropped_bytes(&dir, "png", 1, 0, b""), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_separator_in_the_extension_cannot_escape_the_directory() {
        let dir = std::env::temp_dir();
        assert_eq!(write_dropped_bytes(&dir, "../evil", 1, 0, b"x"), None);
        assert_eq!(write_dropped_bytes(&dir, "png/../..", 1, 0, b"x"), None);
        assert_eq!(write_dropped_bytes(&dir, "", 1, 0, b"x"), None);
    }

    /// PR #1352's review, data-integrity probe: a name derived from the timestamp ALONE collides
    /// the instant two images land in the same millisecond, and the second write silently clobbers
    /// the first — a multi-image drag collapsing to one file with no error anywhere. `seq` is the
    /// fix; pin that two writes sharing a `stamp` still produce two distinct, non-clobbering files.
    #[test]
    fn same_millisecond_different_seq_never_collide() {
        let dir = scratch_dir("cardinality");
        let a = write_dropped_bytes(&dir, "png", 42, 0, b"first-image").unwrap();
        let b = write_dropped_bytes(&dir, "png", 42, 1, b"second-image").unwrap();

        assert_ne!(a, b, "two images in one drag must not share a filename");
        assert_eq!(std::fs::read(&a).unwrap(), b"first-image", "the first write must survive");
        assert_eq!(std::fs::read(&b).unwrap(), b"second-image", "the second write must survive");

        std::fs::remove_dir_all(&dir).ok();
    }

    // ── sweep_stale_entries ─────────────────────────────────────────────────────────────────────
    //
    // PURE: no real temp directory, no real file ages. The unresolved cleanup gap this closes is
    // that materialised drop files were never removed at all.

    #[test]
    fn a_stale_sparkle_drop_file_is_swept() {
        let now = std::time::SystemTime::now();
        let old = now - DROP_FILE_MAX_AGE - std::time::Duration::from_secs(1);
        let entries = vec![(std::path::PathBuf::from("/tmp/sparkle-drop-1-0.png"), old)];
        assert_eq!(
            sweep_stale_entries(entries, now),
            vec![std::path::PathBuf::from("/tmp/sparkle-drop-1-0.png")]
        );
    }

    #[test]
    fn a_fresh_sparkle_drop_file_is_kept() {
        let now = std::time::SystemTime::now();
        let entries = vec![(std::path::PathBuf::from("/tmp/sparkle-drop-1-0.png"), now)];
        assert!(sweep_stale_entries(entries, now).is_empty(), "not old enough yet");
    }

    #[test]
    fn a_stale_file_we_did_not_write_is_left_alone() {
        // The temp directory is shared with every other process on the machine. Matching by our own
        // naming prefix is a SAFETY rule here, not an optimisation — without it this sweep would be
        // an arbitrary-age-based file deleter over a directory we don't own.
        let now = std::time::SystemTime::now();
        let old = now - DROP_FILE_MAX_AGE - std::time::Duration::from_secs(1);
        let entries = vec![(std::path::PathBuf::from("/tmp/some-other-apps-cache.dat"), old)];
        assert!(
            sweep_stale_entries(entries, now).is_empty(),
            "must never touch a file outside our own naming scheme"
        );
    }

    // ── materialize_image_bytes: the size cap ──────────────────────────────────────────────────

    #[test]
    fn an_oversized_image_is_skipped_not_written() {
        let dir = scratch_dir("oversized");
        let huge = vec![0u8; MAX_DROP_IMAGE_BYTES + 1];
        assert_eq!(
            materialize_image_bytes(&dir, 1, true, &huge),
            None,
            "a payload over the cap must be refused, not written"
        );
        assert!(
            std::fs::read_dir(&dir).unwrap().next().is_none(),
            "nothing must have been written to disk for an oversized payload"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_image_at_the_cap_is_still_written() {
        let dir = scratch_dir("at-cap");
        let at_cap = vec![7u8; MAX_DROP_IMAGE_BYTES];
        let p = materialize_image_bytes(&dir, 1, true, &at_cap).expect("exactly at the cap must pass");
        assert_eq!(std::fs::read(&p).unwrap().len(), MAX_DROP_IMAGE_BYTES);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── materialize_sized_data: the pre-copy cap, proven by what did NOT run ───────────────────
    //
    // `materialize_image_bytes` has its own (redundant, defense-in-depth) cap, so a test that only
    // inspects the RETURN value can't tell "checked before copying" apart from "checked after" —
    // both produce the identical `None`. Only a closure that provably never ran can.

    #[test]
    fn an_oversized_length_refuses_before_the_copy_ever_runs() {
        let dir = scratch_dir("precopy-oversized");
        let copy_ran = std::cell::Cell::new(false);
        let got = materialize_sized_data(&dir, 1, true, MAX_DROP_IMAGE_BYTES + 1, || {
            copy_ran.set(true);
            vec![0u8; MAX_DROP_IMAGE_BYTES + 1]
        });
        assert_eq!(got, None);
        assert!(!copy_ran.get(), "a length over the cap must refuse WITHOUT ever calling the copy");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_length_at_the_cap_does_run_the_copy() {
        let dir = scratch_dir("precopy-at-cap");
        let copy_ran = std::cell::Cell::new(false);
        let got = materialize_sized_data(&dir, 1, true, MAX_DROP_IMAGE_BYTES, || {
            copy_ran.set(true);
            vec![7u8; MAX_DROP_IMAGE_BYTES]
        });
        assert!(got.is_some());
        assert!(copy_ran.get(), "a length at or under the cap must actually materialise the image");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── materialize_image_bytes: the TIFF→PNG conversion itself ────────────────────────────────
    //
    // This is the entire substance of PR #1352's review probe #2 turned into working code: writing
    // raw TIFF bytes materialises a file `attachments::IMAGE_EXTENSIONS`/`mime_for` don't recognise
    // as an image at all. Nothing exercised the `is_png = false` branch before these — deleting the
    // conversion, the scratch-file cleanup, or the failure-path cleanup all left the suite green.
    //
    // A hand-crafted MINIMAL valid TIFF (1×1, 8-bit grayscale, uncompressed, little-endian) rather
    // than a real photo — this only needs to be a file `sips` will actually accept as TIFF input,
    // and a real image would make this test slower and its bytes unreadable as a diff.

    fn minimal_1x1_grayscale_tiff() -> Vec<u8> {
        vec![
            0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01, 0x03, 0x00,
            0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x03, 0x00, 0x01, 0x00,
            0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
            0x08, 0x00, 0x00, 0x00, 0x03, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
            0x00, 0x00, 0x06, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
            0x11, 0x01, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x6e, 0x00, 0x00, 0x00, 0x16, 0x01,
            0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x17, 0x01, 0x04, 0x00,
            0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
        ]
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_tiff_only_image_converts_to_a_real_readable_png() {
        let dir = scratch_dir("tiff-convert");
        let p = materialize_image_bytes(&dir, 1, false, &minimal_1x1_grayscale_tiff())
            .expect("a valid TIFF must convert");

        assert!(p.ends_with(".png"), "the returned path must be a .png, got {p}");
        let png_bytes = std::fs::read(&p).expect("the converted PNG must exist on disk");
        assert_eq!(
            &png_bytes[..8],
            b"\x89PNG\r\n\x1a\n",
            "the written file must actually BE a PNG, not TIFF bytes under a .png name"
        );

        // The scratch .tiff is an internal step, never part of the return value — it must not
        // leak into the temp dir alongside the real output.
        let leftover_tiff = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("tiff"));
        assert!(!leftover_tiff, "the scratch .tiff must be cleaned up after a successful conversion");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn bytes_sips_cannot_convert_leave_nothing_behind() {
        let dir = scratch_dir("tiff-garbage");
        let got = materialize_image_bytes(&dir, 1, false, b"not a tiff at all");
        assert_eq!(got, None, "garbage bytes must not produce a path");

        assert!(
            std::fs::read_dir(&dir).unwrap().next().is_none(),
            "a failed conversion must clean up BOTH the scratch .tiff and any partial .png"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── recover_for: the seam that proves the provenance gate is actually consulted ────────────
    //
    // `recover_drag_paths` takes a `tauri::WebviewWindow`, which cannot be constructed in a unit
    // test — so before this seam existed, deleting the `has_recent_drop` check entirely left the
    // whole suite green (the finding this closes). Each arm here proves not just the RETURN value
    // but that the right dependency ran and the wrong ones did NOT.

    #[test]
    fn a_real_path_short_circuits_before_touching_provenance_or_bytes() {
        let has_recent_drop_called = std::cell::Cell::new(false);
        let read_bytes_called = std::cell::Cell::new(false);
        let got = recover_for(
            "main",
            || vec!["/tmp/a.png".to_string()],
            |_| {
                has_recent_drop_called.set(true);
                true
            },
            || {
                read_bytes_called.set(true);
                vec!["should-not-happen".to_string()]
            },
        );
        assert_eq!(got, vec!["/tmp/a.png".to_string()]);
        assert!(
            !has_recent_drop_called.get(),
            "a real file path must short-circuit before the provenance check ever runs"
        );
        assert!(
            !read_bytes_called.get(),
            "a real file path must short-circuit before the byte fallback ever runs"
        );
    }

    #[test]
    fn no_recent_drop_refuses_without_reading_bytes() {
        // THE SECURITY PROPERTY ITSELF: without a fresh provenance marker, the pasteboard-bytes
        // reader must never be invoked at all — not "invoked but its result discarded".
        let read_bytes_called = std::cell::Cell::new(false);
        let got = recover_for(
            "main",
            Vec::new,
            |_| false,
            || {
                read_bytes_called.set(true);
                vec!["leak".to_string()]
            },
        );
        assert!(got.is_empty());
        assert!(
            !read_bytes_called.get(),
            "without a fresh drop marker, the image-bytes reader must never run — this is the \
             exact seam the ambient-read vulnerability lived in"
        );
    }

    #[test]
    fn a_fresh_provenance_marker_allows_the_byte_fallback() {
        let got = recover_for(
            "main",
            Vec::new,
            |_| true,
            || vec!["/tmp/sparkle-drop-1-0.png".to_string()],
        );
        assert_eq!(got, vec!["/tmp/sparkle-drop-1-0.png".to_string()]);
    }
}
