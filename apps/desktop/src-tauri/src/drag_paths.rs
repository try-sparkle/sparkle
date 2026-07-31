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

/// Paths for a drop whose Tauri event carried none. Empty result = the drag really had no file.
///
/// SYNCHRONOUS, and that is safe here specifically: this reads a pasteboard already resident in
/// memory (microseconds) rather than touching the filesystem or waiting on XPC the way
/// `folder_picker` does. A sync `#[tauri::command]` body runs on the main thread, so a slow one
/// would stall the UI — this one cannot, and making it async would put the read an event-loop turn
/// further from the drop it is racing.
#[tauri::command]
pub fn recover_drag_paths() -> Vec<String> {
    read_drag_pasteboard_paths()
}

#[cfg(test)]
mod tests {
    use super::file_url_to_path;

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
}
