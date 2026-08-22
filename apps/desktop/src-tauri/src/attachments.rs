//! Composer attachment helpers: turn a dropped file into a previewable attachment,
//! copy an image to the macOS clipboard, and copy files to a user-chosen destination
//! (single download, or bulk into a folder).
//!
//! Images are detected by extension and returned with a `data:` URL so the UI can show
//! a thumbnail / lightbox without a second IPC round-trip (same shape as screenshot.rs).
//! Clipboard + save flows are macOS-only (the app is macOS-only) and shell out to the
//! built-in `sips` / `osascript` rather than pull in a clipboard crate.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::drag_watch;

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
// stamp and is ignored once stale, and `lib.rs` also clears the set when a window goes away — the
// condition that PRODUCES the lost `Leave`, handled directly rather than waited out.
//
// The TTL IS DELIBERATELY LONGER THAN ANY PLAUSIBLE HOVER, and that asymmetry is the point. Getting
// it wrong in the safe direction costs a few extra seconds of exposure on a path the user is already
// dragging over us; getting it wrong in the other direction silently refuses a real drop, which is
// the original bug (bead sparkle-zviq) restored. `Over` renews the stamp when it arrives, but the
// TTL does NOT rely on that: `Over` comes only from `draggingUpdated:`, and AppKit delivers that on
// pointer MOVEMENT — periodic delivery requires the destination to opt in via
// `wantsPeriodicDraggingUpdates`, which wry's webview does not implement. So a user holding a file
// motionless while deciding where to drop may produce no `Over` at all, and a short TTL would lapse
// mid-drag exactly when someone is being careful. An earlier draft of this comment asserted that
// macOS fires `draggingUpdated:` continuously; that is not true from this side of the boundary and
// nothing here should depend on it.
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

/// How long a hovered path stays readable without further word from the OS. This is a BACKSTOP for a
/// lost `Leave`, not a hover budget: the window-gone hook clears the common cause immediately, and
/// `Over` renews the stamp when it happens to arrive. Sized to comfortably outlast a human holding a
/// file still while deciding where to drop — a lapse mid-drag silently refuses a real drop (the
/// original bug), while an over-long grant merely extends exposure on a path already being dragged
/// over us. Those costs are not symmetric, so this errs long.
const PROVISIONAL_TTL: Duration = Duration::from_secs(60);

/// One path being hovered, and the two facts that decide when it stops being readable: when the OS
/// last mentioned it, and WHICH window it is over.
///
/// The window matters because the app runs several (`project_window.rs`, `helper.rs`,
/// `capture_window.rs`) and a teardown is per-window. Clearing the whole set when any one of them
/// goes away would revoke a hover over a DIFFERENT window — and that is unrecoverable for the rest of
/// that drag: the pointer is already inside, so no further `Enter` arrives to re-register, and `Over`
/// only re-stamps entries that still exist. The drop would then fall back to racing the durable
/// registration, which is the silent refusal this whole change exists to remove.
#[derive(Debug, Clone)]
struct Hovered {
    path: PathBuf,
    seen: Instant,
    window: String,
}

#[derive(Default)]
struct Chosen {
    /// Handed to us for real — a completed drop, or a native panel.
    durable: VecDeque<PathBuf>,
    /// Hovering right now. Cleared on Leave and on that window's teardown, superseded on Drop, and
    /// ignored once older than `PROVISIONAL_TTL` in case Leave never comes.
    provisional: VecDeque<Hovered>,
}

// The tier rules as PURE methods over already-canonicalized paths. The public fns below are thin
// wrappers that take the global lock. Split this way so the rules can be tested against a LOCAL
// `Chosen`: they are all about what the registry FORGETS, and testing that through the process-wide
// registry would have concurrent tests clearing each other's state mid-assertion.
impl Chosen {
    /// A drag is over the window. Replaces rather than appends: each Enter is a new drag, and the
    /// previous one either dropped (already durable) or left (already irrelevant). Appending would
    /// keep every file ever hovered readable until the cap evicted it.
    fn note_dragged(&mut self, real: Vec<PathBuf>, now: Instant, window: &str) {
        self.forget_dragged(window);
        for p in real {
            if self.provisional.iter().any(|h| h.path == p && h.window == window) {
                continue;
            }
            // The cap is PER WINDOW and evicts only within this window. A global `pop_front()` would
            // discard the oldest entry in the whole deque — potentially another window's LIVE hover —
            // which is the same unrecoverable revocation the scoping above exists to prevent (pointer
            // already inside, no further `Enter`, and `Over` only re-stamps entries that still exist).
            // Harmless before the scoping change, because each `Enter` cleared the set globally so
            // eviction could only touch the drag being recorded; not harmless now.
            while self.provisional.iter().filter(|h| h.window == window).count() >= DRAGGED_CAP {
                let Some(oldest) = self.provisional.iter().position(|h| h.window == window) else {
                    break;
                };
                self.provisional.remove(oldest);
            }
            self.provisional.push_back(Hovered {
                path: p,
                seen: now,
                window: window.to_owned(),
            });
        }
    }

    /// The drag is still over us (`Over`). Renew the stamps: the OS is telling us this hover is
    /// live, which is the only evidence that distinguishes a real drag from a lost `Leave`.
    fn refresh_dragged(&mut self, now: Instant, window: &str) {
        for entry in self.provisional.iter_mut().filter(|h| h.window == window) {
            entry.seen = now;
        }
    }

    /// The drag left this window without dropping — it was never for us. Scoped to the window, so a
    /// `Leave` on one does not revoke a hover on another.
    fn forget_dragged(&mut self, window: &str) {
        self.provisional.retain(|h| h.window != window);
    }

    /// A completed drop, or a native panel: consent. Supersedes that window's provisional set.
    fn note_chosen(&mut self, real: Vec<PathBuf>, window: &str) {
        for p in real {
            remember_into(&mut self.durable, p, USER_CHOSEN_CAP);
        }
        self.forget_dragged(window);
    }

    fn contains(&self, real: &Path, now: Instant) -> bool {
        self.contains_durable(real) || self.contains_provisional(real, now)
    }

    /// Consent the user really gave: a completed drop, or the native file panel.
    ///
    /// Split out because this is the ONLY tier a registry that is BEHIND the delivered events can
    /// under-report but never OVER-report. Nothing queued revokes a durable entry — `Forget` touches
    /// `provisional` alone, and `note_chosen` only adds — so a stale read of this tier can answer a
    /// spurious "no", which is fail-closed, and can never answer a spurious "yes". That asymmetry is
    /// what lets a timed-out read still honour a real drop; see `is_user_chosen`.
    fn contains_durable(&self, real: &Path) -> bool {
        self.durable.iter().any(|p| p == real)
    }

    /// A hover — and the tier a queued-but-unapplied `Forget` can leave standing past its truth,
    /// which is exactly the grant `is_user_chosen` refuses to read from a stale registry.
    fn contains_provisional(&self, real: &Path, now: Instant) -> bool {
        self.provisional
            .iter()
            .any(|h| h.path == real && now.saturating_duration_since(h.seen) <= PROVISIONAL_TTL)
    }
}

fn chosen() -> &'static Mutex<Chosen> {
    static PATHS: OnceLock<Mutex<Chosen>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(Chosen::default()))
}

// ── Keeping the FILESYSTEM off the AppKit main thread (bead `sparkle-bxidpw`) ───────────────────
//
// Everything below this line exists for ONE reason: `lib.rs`'s `on_window_event` closure is run
// SYNCHRONOUSLY BY TAURI ON THE APPKIT MAIN THREAD, and `note_window_event` is called from inside
// it. Any syscall made on this side of that call stops the whole UI for its duration.
//
// `std::fs::canonicalize` is an unbounded blocking filesystem syscall. Against a dataless iCloud
// placeholder, a network volume, or a stalled NFS mount it can take seconds or never return at all,
// and it used to be executed INLINE here — once per dragged path, on `Enter` as well as `Drop`.
// `Enter` fires for ANY drag crossing the window, including one on its way to another app, so
// merely dragging a file PAST Sparkle could freeze it. That is the same class of defect
// `pty.rs::pty_write` records (bead `sparkle-epc1zh`): a blocking syscall on the main thread froze
// the entire app for 73.5 seconds with the webview itself idle.
//
// THE REMEDY, and the three things it must not break:
//
//  1. The main thread only ENQUEUES. Registration ops are values pushed onto an in-memory queue
//     under a short-lived lock — no filesystem, no allocation beyond the paths already in hand — and
//     a background worker performs the resolution and applies the result.
//
//  2. THE SYMLINK-SWAP WINDOW STAYS CLOSED. The registry still stores ONLY canonical paths and
//     `Chosen::contains` still compares canonical forms, so the property the note on `canonical_all`
//     describes is untouched: a link repointed between the drag and the read resolves to a target
//     that was never registered. A queued op is NOT a grant — it grants nothing at all until the
//     canonical form has been computed and installed. Deferring the work changed WHERE it happens,
//     never WHAT decides a read.
//
//  3. THE ORDERING RACE (bead `sparkle-zviq`) STAYS CLOSED, and this is the subtle one. Tauri emits
//     the JS drag-drop event to the frontend BEFORE running this listener, so `load_attachment` can
//     arrive while a registration is still in flight — and a read that answered "not chosen" then
//     would be the original silent refusal, restored by the very fix that removed the freeze. So the
//     READ SIDE WAITS: `is_user_chosen` blocks until every registration issued before it has been
//     applied, and only then gives its answer. That wait happens on the blocking pool (every command
//     that reaches it is `async` + `spawn_blocking`), which is exactly where waiting is free. Waiting
//     on the MAIN thread is the bug being fixed; waiting on a worker is not.
//
// ONE WORKER, IN ORDER, and that is load-bearing rather than simplicity. `Leave` must forget a hover
// that `Enter` registered, and `Drop` must supersede it. If resolution were fanned out across a pool,
// a slow `Enter` could install its provisional grant AFTER the `Leave` that was supposed to revoke it
// — a hover grant left standing for a drag that already left, which is the exact posture the
// provisional tier exists to deny. A single FIFO worker makes the applied order the delivered order,
// so every tier rule in `Chosen` keeps the meaning it was written and tested with.

/// How a batch of raw OS-supplied paths becomes the CANONICAL forms the registry stores.
///
/// A seam so a test can make resolution arbitrarily slow WITHOUT a dataless iCloud file — the point
/// being tested is that the main thread is released while a resolution is still outstanding, and
/// that is not observable against a resolver that always returns instantly.
type PathResolver = std::sync::Arc<dyn Fn(Vec<PathBuf>) -> Vec<PathBuf> + Send + Sync>;

/// The test-only override slot. Read unconditionally (so the production path and the tested path are
/// the same code), written only from tests — there is no way to install one from a shipping build.
fn resolver_override() -> &'static Mutex<Option<PathResolver>> {
    static R: OnceLock<Mutex<Option<PathResolver>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

/// Canonicalize, skipping what can't be resolved: a path we can't canonicalize can't be matched at
/// read time anyway. Canonicalizing on the way IN is what closes the symlink-swap window — a link
/// repointed between the drag and the read resolves to a target that was never registered.
///
/// THIS IS THE BLOCKING SYSCALL. It must only ever run on the resolution worker; calling it from
/// `note_window_event` is the freeze (bead `sparkle-bxidpw`).
fn canonical_all<I: IntoIterator<Item = PathBuf>>(paths: I) -> Vec<PathBuf> {
    paths.into_iter().filter_map(|p| p.canonicalize().ok()).collect()
}

/// Resolve a batch through the seam.
///
/// The `None` arm is the PRODUCTION WIRING — the only thing that makes a real drag register real
/// canonical paths — and it is covered by `the_production_default_resolver_really_canonicalizes`
/// plus the end-to-end symlink-swap test. Without those, a suite in which every test injects its own
/// resolver would stay green with this arm deleted, which is precisely the defaulted-seam trap.
fn resolve_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let injected = resolver_override().lock().ok().and_then(|g| g.clone());
    match injected {
        Some(f) => f(paths),
        None => canonical_all(paths),
    }
}

/// One queued mutation of the `Chosen` registry. A value, so the whole sequence can be applied in
/// delivery order by one worker — see the ORDERING note above.
enum RegistryOp {
    /// `Enter`: these RAW paths become provisional once resolved.
    Dragged { paths: Vec<PathBuf>, window: String, at: Instant },
    /// `Over`: renew this window's provisional stamps. No filesystem work at all — queued only so it
    /// cannot overtake the `Enter` whose entries it is meant to renew.
    Refresh { window: String, at: Instant },
    /// `Leave` / window teardown: forget this window's hovers. Queued for the same ordering reason.
    Forget { window: String },
    /// `Drop`, or the native file panel: these RAW paths become durable once resolved.
    Chosen { paths: Vec<PathBuf>, window: String, phase: &'static str },
}

struct ResolveQueue {
    state: Mutex<QueueState>,
    /// Signalled when an op is enqueued — unparks the worker.
    work: Condvar,
    /// Signalled when an op has been APPLIED — unparks readers waiting for their tickets to clear.
    done: Condvar,
}

#[derive(Default)]
struct QueueState {
    queued: VecDeque<(u64, RegistryOp)>,
    /// Ticket ids enqueued OR in flight. A `BTreeSet` so "is anything issued at or before T still
    /// outstanding" is one look at the minimum — an op that is popped but not yet applied must still
    /// hold a reader, so this cannot be derived from queue length.
    outstanding: BTreeSet<u64>,
    next_ticket: u64,
}

fn resolve_queue() -> &'static ResolveQueue {
    static Q: OnceLock<ResolveQueue> = OnceLock::new();
    Q.get_or_init(|| ResolveQueue {
        state: Mutex::new(QueueState::default()),
        work: Condvar::new(),
        done: Condvar::new(),
    })
}

/// Hand an op to the worker. THIS RUNS ON THE APPKIT MAIN THREAD — one lock, one push, no syscall.
///
/// The lock is recovered from poisoning rather than skipped. `QueueState` is bookkeeping with no
/// invariant a panic could leave half-written, and silently dropping the op would be the worse
/// outcome: a dropped `Forget` leaves a hover grant standing for a drag that already left.
fn enqueue(op: RegistryOp) {
    let q = resolve_queue();
    {
        let mut st = q.state.lock().unwrap_or_else(|e| e.into_inner());
        let ticket = st.next_ticket;
        st.next_ticket = st.next_ticket.wrapping_add(1);
        st.outstanding.insert(ticket);
        st.queued.push_back((ticket, op));
    }
    q.work.notify_one();
    ensure_resolve_worker();
}

/// Whether a resolution worker thread is believed to be alive.
///
/// Set only once a thread REALLY exists, and cleared again if that thread ever unwinds — see
/// `ensure_resolve_worker` and `WorkerLiveness` for why neither can be a `OnceLock`.
static RESOLVE_WORKER_RUNNING: AtomicBool = AtomicBool::new(false);

/// How the resolution worker thread is started.
///
/// A seam, for the same reason `resolver_override` is one: the FAILED-spawn path is the branch that
/// matters and it cannot be reached from a test by any means that does not first exhaust the
/// machine's thread table. Read unconditionally so the production path and the tested path are the
/// same code; written only from tests.
type WorkerSpawner = std::sync::Arc<dyn Fn() -> std::io::Result<()> + Send + Sync>;

fn spawner_override() -> &'static Mutex<Option<WorkerSpawner>> {
    static S: OnceLock<Mutex<Option<WorkerSpawner>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// The PRODUCTION WIRING — the only thing that puts a real thread behind the queue. Covered by
/// `the_production_default_spawner_starts_the_real_resolve_worker`, and in practice by every drag
/// test in this file, all of which need a live worker to drain what they enqueue.
fn spawn_resolve_worker() -> std::io::Result<()> {
    let injected = spawner_override().lock().ok().and_then(|g| g.clone());
    match injected {
        Some(f) => f(),
        // Named, so it is identifiable in the hang captures this whole change exists to make
        // unnecessary — and so a stack showing THIS thread inside `canonicalize` is immediately
        // legible as "working as designed", not as a regression back onto the main thread.
        None => std::thread::Builder::new()
            .name("drag-path-resolve".to_string())
            .spawn(resolve_worker)
            .map(|_| ()),
    }
}

/// Start the resolution worker if one is not already running.
///
/// NOT a `OnceLock`. `STARTED.get_or_init(|| { let _ = …spawn(…); })` completes the cell whether or
/// not the spawn inside it succeeded, so ONE failed spawn — `EAGAIN` under thread pressure, which is
/// precisely the loaded state a drag stall gets reported from in the first place — would be
/// discarded silently and no worker ever started again for the life of the process. The symptom is
/// maximally confusing and gives no hint of its cause: `enqueue` keeps succeeding on the main
/// thread, `outstanding` never drains, every drag/drop registration is dropped on the floor, and
/// every non-contained `validate_read_path` spends the full read budget before answering "refusing
/// to read a path outside allowed directories".
///
/// So the flag is set FIRST (claiming the right to spawn, so two callers cannot both start a worker
/// and break the FIFO ordering the whole design rests on) and rolled back if the spawn fails, which
/// leaves the next `enqueue` to retry. `drag_watch::ensure_watcher` keeps the `let _ =` shape it
/// inherited from `pty_write_watch.rs`: that worker is purely DIAGNOSTIC, so losing it costs a log
/// line. This one is on the functional path.
fn ensure_resolve_worker() {
    if RESOLVE_WORKER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(e) = spawn_resolve_worker() {
        RESOLVE_WORKER_RUNNING.store(false, Ordering::SeqCst);
        tracing::error!(
            error = %e,
            "drag path resolution worker failed to spawn; the next drag event will retry"
        );
    }
}

/// Clears the running flag if the worker thread ever leaves its loop, so the next `enqueue` starts a
/// replacement instead of leaving the queue unattended for the life of the process.
///
/// `resolve_worker`'s loop has no `break`, so the only way out is an unwind — from the queue lock or
/// the condvar wait, since `apply_registry_op` is caught below. Rare, and permanent if unhandled.
struct WorkerLiveness;

impl Drop for WorkerLiveness {
    fn drop(&mut self) {
        RESOLVE_WORKER_RUNNING.store(false, Ordering::SeqCst);
        tracing::error!(
            "drag path resolution worker exited; the next drag event will start a replacement"
        );
    }
}

/// Run `body` under a `WorkerLiveness` guard.
///
/// EXISTS TO BE TESTABLE, not for abstraction. Written inline as `let _liveness = WorkerLiveness;`
/// the INSTALLATION was pinned by nothing: a test can construct and drop the guard directly, which
/// proves `Drop` works and stays green if the binding is deleted — or, more plausibly, rewritten as
/// `let _ = WorkerLiveness`, which drops it IMMEDIATELY and leaves the worker unsupervised while the
/// flag reads `true` forever. Routing it through here lets a test drive a panicking body on its own
/// thread and assert the flag came back down, without ever attaching a second worker to the queue
/// (which would break FIFO). See `a_panic_inside_the_guarded_body_clears_the_flag` (roborev 67722).
fn guarded_by_liveness(body: impl FnOnce()) {
    let _liveness = WorkerLiveness;
    body();
}

fn resolve_worker() {
    guarded_by_liveness(resolve_worker_loop);
}

fn resolve_worker_loop() {
    let q = resolve_queue();
    loop {
        let (ticket, op) = {
            let mut st = q.state.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if let Some(next) = st.queued.pop_front() {
                    break next;
                }
                // Park while there is nothing to resolve. `wait` releases the lock, so a drag event
                // on the main thread is never blocked by a sleeping worker.
                let (guard, _) = q
                    .work
                    .wait_timeout(st, Duration::from_secs(60))
                    .unwrap_or_else(|e| e.into_inner());
                st = guard;
            }
        };
        // OUTSIDE the queue lock: this is where the blocking filesystem work happens, and holding
        // the queue lock across it would put the main thread's `enqueue` right back behind it.
        //
        // CAUGHT, because an unwind here is not merely the loss of one registration. It would take
        // the whole worker with it, and then `outstanding` never drains again: every subsequent
        // attachment read spends the full budget waiting for a ticket nothing will ever retire and
        // then answers from durable consent alone. Catching lets THIS ticket be drained (below) and
        // the loop carry on, so one bad path costs one registration rather than the feature.
        //
        // AND CRASH RECORDS ARE SUPPRESSED ACROSS IT, which is this crate's convention for a
        // firewall that RECOVERS (`crash.rs`'s hook comment; `audio.rs` and `dictation.rs` both do
        // it). The process-wide panic hook runs BEFORE the unwind reaches this `catch_unwind`, so
        // without the guard a single unresolvable path would write a `CrashRecord` to disk and, on a
        // consenting mode, upload it — reporting the app as having crashed for a drag it fully
        // survived (roborev 67722). The hook's `tracing::error!` still fires, so the panic stays
        // visible in the log; only the false crash artifact is withheld.
        let caught = {
            let _suppress = crate::crash::suppress_crash_records();
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| apply_registry_op(op)))
        };
        if caught.is_err() {
            tracing::error!(
                "drag path resolution panicked applying a registration; dropping it and continuing"
            );
        }
        {
            let mut st = q.state.lock().unwrap_or_else(|e| e.into_inner());
            st.outstanding.remove(&ticket);
        }
        q.done.notify_all();
    }
}

/// The registry, recovered from poisoning rather than skipped.
///
/// PROPAGATING POISON HERE IS THE WORSE OUTCOME, and it used to be what happened: every writer took
/// the lock as `if let Ok(mut c) = chosen().lock()` and the reader as `.map(…).unwrap_or(false)`, so
/// one panic anywhere inside the critical section silently discarded EVERY later registration and
/// answered EVERY later `is_user_chosen` with `false`, for the life of the process — with the worker
/// looping cheerfully and `outstanding` draining normally, so none of the supervision above notices.
/// A permanent, silent loss of the feature, which is exactly the class the firewall exists to remove
/// (roborev 67722).
///
/// Recovering is sound for the same reason it is sound for `QueueState` three lines below: `Chosen`
/// is two `VecDeque`s of canonical paths with no cross-field invariant a panic could leave
/// half-written. The worst a recovered lock can hold is a queue missing one entry — which is the
/// same outcome as the dropped registration the firewall already accepts, and strictly better than
/// dropping all of them forever.
fn chosen_locked() -> std::sync::MutexGuard<'static, Chosen> {
    chosen().lock().unwrap_or_else(|e| e.into_inner())
}

fn apply_registry_op(op: RegistryOp) {
    match op {
        RegistryOp::Dragged { paths, window, at } => {
            let _watch =
                drag_watch::begin(drag_watch::Stage::Resolve, &window, "enter", paths.len());
            let real = resolve_paths(paths);
            chosen_locked().note_dragged(real, at, &window);
        }
        RegistryOp::Refresh { window, at } => {
            chosen_locked().refresh_dragged(at, &window);
        }
        RegistryOp::Forget { window } => {
            chosen_locked().forget_dragged(&window);
        }
        RegistryOp::Chosen { paths, window, phase } => {
            let _watch =
                drag_watch::begin(drag_watch::Stage::Resolve, &window, phase, paths.len());
            let real = resolve_paths(paths);
            chosen_locked().note_chosen(real, &window);
        }
    }
}

/// How long a read waits for outstanding registrations before answering without them.
///
/// It errs LONG for the same asymmetry `PROVISIONAL_TTL` documents: giving up early silently refuses
/// a real drop (bead `sparkle-zviq`, the original bug), while waiting too long merely delays an
/// attachment the user is already waiting on — and the caller is on the blocking pool, not the main
/// thread, so nothing is frozen while it waits. It is bounded at all only so a `canonicalize` that
/// NEVER returns cannot pin blocking-pool threads for the life of the process; the read side would
/// have to canonicalize that same wedged path itself anyway.
const RESOLVE_WAIT: Duration = Duration::from_secs(30);

/// The budget one READ may spend ordering itself after the registrations already delivered.
///
/// A seam, read unconditionally so the production path and the tested path are the same code, and
/// written only from tests. The DEADLINE branch of the wait is the whole point of this seam: it is
/// the branch a stale registry is answered from, and against the shipping 30-second budget no test
/// could reach it without wedging the suite for half a minute per assertion.
fn resolve_wait_override() -> &'static Mutex<Option<Duration>> {
    static W: OnceLock<Mutex<Option<Duration>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(None))
}

fn resolve_wait() -> Duration {
    resolve_wait_override()
        .lock()
        .ok()
        .and_then(|g| *g)
        .unwrap_or(RESOLVE_WAIT)
}

/// One read-ordering budget, shared by a whole command's worth of path checks.
///
/// `is_user_chosen` must be ordered after every registration delivered before it, and that wait is
/// bounded by `resolve_wait()`. A BATCH command re-paying that bound per path is the part that
/// turns a bounded wait into an unbounded one: against a wedged worker a 50-path `copy_files_to_dir`
/// would occupy one blocking-pool thread for `RESOLVE_WAIT × 50` — roughly 25 minutes, with no
/// cancellation — while the queue it is waiting on has not moved since the first path.
///
/// So the BUDGET is per command, not per path, while the WAIT stays per path. Each check still
/// orders itself after everything delivered before it (in the healthy case that is one uncontended
/// lock and a return, so nothing about the existing semantics changes); it just cannot spend more
/// than one `resolve_wait()` between them all. A batch that runs out answers from the durable tier
/// alone, exactly as a single timed-out read does.
///
/// LAZY, so a batch whose paths are all inside the allowed roots never waits at all: containment
/// still short-circuits ahead of provenance, and the clock never starts.
///
/// SPENT TIME, NOT A DEADLINE — and the difference is the whole correctness of the amortisation
/// (roborev 67513). A deadline stamped at the first check keeps running through work that is not
/// waiting, and in this command's case that work is `std::fs::copy`: a 20-file, multi-GB
/// `copy_files_to_dir` whose copies take longer than the budget would arrive at each remaining src
/// with ZERO left, call `await_pending_registrations(Duration::ZERO)`, see an outstanding ticket and
/// return `false` having waited no time at all. Those reads lose their ordering guarantee for a
/// reason that has nothing to do with them — a src holding only a provisional grant is refused
/// mid-batch where the pre-amortisation code would have waited and granted it. So the budget is an
/// accumulator: only time actually spent INSIDE the wait is charged against it, and copying is free.
struct ReadOrder {
    /// What is left of the batch's single budget. `None` until the first read that actually reaches
    /// provenance, so a batch entirely inside the allowed roots never starts the clock.
    remaining: Option<Duration>,
    /// Whether this batch has already reported an exhausted budget. One wedge behind twenty paths
    /// is ONE event, not twenty identical lines.
    warned: bool,
}

/// What one ordered read cost and what it concluded — see `ReadOrder::order`.
struct ReadOrdering {
    /// Whether the registry is now up to date. `false` means the caller holds a registry it knows is
    /// behind events the OS has already delivered.
    drained: bool,
    /// How much of the batch budget this read was actually offered. Logged instead of the constant,
    /// because a read that was offered 0 ms did not exhaust a 30-second budget and must not say so.
    offered: Duration,
    /// True only on the FIRST failure of this batch, so the warning fires once per wedge.
    first_failure: bool,
}

impl ReadOrder {
    fn new() -> Self {
        ReadOrder { remaining: None, warned: false }
    }

    /// Order this read after the registrations already delivered, spending at most what is left of
    /// the batch's single budget — and charging back only what the wait itself consumed.
    fn order(&mut self) -> ReadOrdering {
        let offered = *self.remaining.get_or_insert_with(resolve_wait);
        let started = Instant::now();
        let drained = await_pending_registrations(offered);
        // MEASURED AROUND THE WAIT AND NOTHING ELSE. Everything between two `order()` calls — the
        // copy, the canonicalize, the caller's own work — is deliberately not charged.
        self.remaining = Some(offered.saturating_sub(started.elapsed()));
        let first_failure = if drained {
            false
        } else {
            let first = !self.warned;
            self.warned = true;
            first
        };
        ReadOrdering { drained, offered, first_failure }
    }
}

/// Block until every registration issued BEFORE this call has been applied.
///
/// RETURNS WHETHER IT ACTUALLY DRAINED. `false` means the deadline passed with registrations still
/// outstanding — the caller is then holding a registry it KNOWS is behind events the OS has already
/// delivered, and must not read it as though it were complete. Returning `()` and simply breaking
/// out of the loop was the defect: it made "everything applied" and "gave up with a revocation still
/// queued" indistinguishable to the one caller whose whole job is to tell them apart.
///
/// Snapshotting `next_ticket` on entry, rather than waiting for a globally empty queue, is what
/// bounds this: a stream of new drag events arriving while we wait cannot keep extending the wait.
/// The reader only ever needed the registrations that already happened.
///
/// NEVER call this from the main thread — that would reintroduce exactly the freeze this module was
/// restructured to remove. Every caller reaches it from an `async` command's `spawn_blocking` body.
#[must_use = "a timed-out wait leaves the registry stale — see is_user_chosen"]
fn await_pending_registrations(timeout: Duration) -> bool {
    let q = resolve_queue();
    let mut st = q.state.lock().unwrap_or_else(|e| e.into_inner());
    let high = match st.next_ticket.checked_sub(1) {
        Some(h) => h,
        // Nothing has ever been enqueued, so there is nothing to wait for.
        None => return true,
    };
    let deadline = Instant::now() + timeout;
    while matches!(st.outstanding.iter().next(), Some(&t) if t <= high) {
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        let (guard, _) = q
            .done
            .wait_timeout(st, deadline - now)
            .unwrap_or_else(|e| e.into_inner());
        st = guard;
    }
    true
}

/// A drag is now OVER `window` (`DragDropEvent::Enter`). Provisional only — see the tier note.
///
/// The stamp is taken HERE, at delivery, not when the worker gets to it: `Instant::now()` is a cheap
/// monotonic read rather than a syscall, and using it means `PROVISIONAL_TTL` still measures from
/// when the OS told us, exactly as it did when this ran inline.
fn note_dragged_paths<I: IntoIterator<Item = PathBuf>>(paths: I, window: &str) {
    enqueue(RegistryOp::Dragged {
        paths: paths.into_iter().collect(),
        window: window.to_owned(),
        at: Instant::now(),
    });
}

/// The drag is still over `window` (`DragDropEvent::Over`) — renew its provisional stamps.
fn refresh_dragged_paths(window: &str) {
    enqueue(RegistryOp::Refresh { window: window.to_owned(), at: Instant::now() });
}

/// The drag left `window` without dropping (`DragDropEvent::Leave`) — it was never for us.
fn forget_dragged_paths(window: &str) {
    enqueue(RegistryOp::Forget { window: window.to_owned() });
}

/// Record paths the user genuinely chose through the OS: a completed DROP, or a native file panel.
///
/// The native panel is not attached to any window's drag state, so it passes a window label that
/// matches no live hover — it only ADDS durable entries, and must not clear anyone's provisional set.
pub fn note_user_chosen_paths<I: IntoIterator<Item = PathBuf>>(paths: I) {
    note_chosen_from(paths, NO_WINDOW, "panel");
}

/// A label no real window has, for consent that did not arrive through a window's drag (the native
/// file panel). Tauri window labels are non-empty, so this cannot collide with one.
const NO_WINDOW: &str = "";

fn note_chosen_from<I: IntoIterator<Item = PathBuf>>(
    paths: I,
    window: &str,
    phase: &'static str,
) {
    enqueue(RegistryOp::Chosen {
        paths: paths.into_iter().collect(),
        window: window.to_owned(),
        phase,
    });
}

/// The single entry point from `lib.rs`'s `on_window_event`. Everything that decides a grant lives on
/// this side of the call, and `lib.rs` only forwards.
///
/// That split is deliberate and was learned twice on this branch. First the drag-phase mapping was a
/// match at the call site, where no test could reach it — so re-collapsing `Enter` into `Drop` (a
/// permanent grant for any drag crossing the window) would have left the suite green. Moving it here
/// fixed the classification but left the WINDOW arms behind as an untested `matches!`, which is the
/// same defect one level up: deleting the teardown arm silently returns the posture to "up to
/// `PROVISIONAL_TTL` of exploitable grant per lost `Leave`, with nothing clearing it early", and the
/// TTL was lengthened precisely BECAUSE this hook exists. So the window dispatch is here too, over
/// `WindowGrant`, and tested.
pub fn note_window_event(window: &str, event: &tauri::WindowEvent) {
    match dispatch_window(event) {
        WindowGrant::Drag(drag) => {
            // THE MAIN-THREAD SPAN. Everything between here and the guard's drop runs on the AppKit
            // main thread with the UI stopped, so this is the span that has to be observable — see
            // `drag_watch.rs` for why nothing else in the app could see it.
            let _watch = drag_watch::begin(
                drag_watch::Stage::Dispatch,
                window,
                drag_phase_name(drag),
                drag_path_count(drag),
            );
            note_drag_event(window, drag)
        }
        WindowGrant::Teardown => {
            let _watch =
                drag_watch::begin(drag_watch::Stage::Dispatch, window, "teardown", 0);
            note_window_gone(window)
        }
        WindowGrant::Ignore => {}
    }
}

/// The drag phase as a FIXED token for the log. A closed vocabulary by construction — there is no
/// arm that can put user data in it, which is the property that keeps paths out of a log that ships
/// with support tickets (`note_drag_event` records why that matters).
fn drag_phase_name(event: &tauri::DragDropEvent) -> &'static str {
    match event {
        tauri::DragDropEvent::Enter { .. } => "enter",
        tauri::DragDropEvent::Over { .. } => "over",
        tauri::DragDropEvent::Drop { .. } => "drop",
        tauri::DragDropEvent::Leave => "leave",
        _ => "other",
    }
}

/// How many paths a drag phase carries. A COUNT, never the paths.
fn drag_path_count(event: &tauri::DragDropEvent) -> usize {
    match event {
        tauri::DragDropEvent::Enter { paths, .. } | tauri::DragDropEvent::Drop { paths, .. } => {
            paths.len()
        }
        _ => 0,
    }
}

/// Which tier each drag phase grants: `Enter` → provisional, `Over` → renew, `Drop` → consent,
/// `Leave` → forget. See `dispatch_drag` for the testable form.
pub fn note_drag_event(window: &str, event: &tauri::DragDropEvent) {
    // THE RUST HALF OF "did the drop actually happen". Its JS twin is
    // `services/dndTargets.noteDropArrived`, and the PAIR is the point: between them they say
    // whether a drop reached Rust, reached the frontend, both, or neither.
    //
    // Written after a founder-blocking report — "we can no longer drag photos or files into the
    // Compose window" — cost hours precisely because neither line existed. The compose box lit up
    // under the drag (so `Enter`/`Over` were arriving) and then swallowed the release, with an
    // ENTIRELY EMPTY log: every drop log in the app sat behind a hit test, a paths check, or a
    // deliberately-silent "not mine" branch. Three very different faults — macOS never delivering
    // the drop, Tauri delivering it to no listener, and the drop arriving with no paths — were
    // indistinguishable from outside, and the first root cause inferred from that silence was wrong.
    //
    // DROP ONLY, deliberately: `Over` fires continuously for the whole gesture and would bury the
    // one event worth seeing. Count, never the paths — this log ships with support tickets.
    if let tauri::DragDropEvent::Drop { paths, position } = event {
        tracing::info!(
            window,
            paths = paths.len(),
            x = position.x,
            y = position.y,
            "drag-drop: Drop reached Rust"
        );
    }
    // The recent-drop marker is set on Enter/Over TOO, not just Drop, and this is load-bearing —
    // Tauri emits this window's JS drag-drop event to the frontend BEFORE running this listener
    // (see the tier note above and `lib.rs`'s `on_window_event`), so a Drop-only marker can lose
    // that race: the frontend's drop handler can invoke `recover_drag_paths` before this function's
    // own Drop branch has run, finding no marker for a drop that is genuinely happening right now.
    // Enter always precedes Drop in a real drag and cannot be forged by webview JS, so marking on
    // it too guarantees the marker already exists by the time Drop's JS event reaches the frontend.
    //
    // DROP IS DURABLE, Enter/Over are PROVISIONAL — mirroring `dispatch_drag`'s own split below,
    // and for the same reason: `Leave` must forget a mere HOVER but must NEVER revoke a completed
    // DROP's consent. wry emits `Leave` from `draggingExited:`, whose ordering relative to
    // `performDragOperation:` (Drop) this code does not control — a `Leave` arriving just after a
    // real Drop is not hypothetical. `forget_recent_drop` only clears a still-provisional marker, so
    // a Drop's marker survives until `take_recent_drop` consumes it or its TTL lapses, exactly like
    // `Chosen::note_chosen` already protects the path-grant tier from the same ordering.
    match event {
        tauri::DragDropEvent::Leave => forget_recent_drop(window),
        tauri::DragDropEvent::Drop { .. } => mark_recent_drop(window, true),
        _ => mark_recent_drop(window, false),
    }
    match dispatch_drag(event) {
        DragGrant::Provisional(paths) => note_dragged_paths(paths, window),
        DragGrant::Renew => refresh_dragged_paths(window),
        DragGrant::Durable(paths) => note_chosen_from(paths, window, "drop"),
        DragGrant::Forget => forget_dragged_paths(window),
        DragGrant::Ignore => {}
    }
}

/// `window` was destroyed. Drop the hover grants it owned — and ONLY those.
///
/// This is the cause of the lost `Leave` the TTL exists to survive: a view torn down mid-drag never
/// delivers `draggingExited:`. Handling it directly is what lets `PROVISIONAL_TTL` be long enough to
/// never bite a real hover.
///
/// Scoping to the window is not tidiness. Clearing every window's entries would revoke a hover over a
/// DIFFERENT window, and that is unrecoverable for the rest of the drag: the pointer is already
/// inside, so no further `Enter` arrives to re-register, and `Over` only re-stamps entries that still
/// exist. The drop would fall back to racing the durable registration — which IS the silent refusal
/// (bead sparkle-zviq), since the frontend reads off the JS drop payload that Tauri emits before it
/// runs this listener. An earlier version of this function cleared globally and called that cost "just
/// reopening the ordering race", which understated it: that race is the bug.
pub fn note_window_gone(window: &str) {
    forget_dragged_paths(window);
    clear_recent_drop(window);
}

/// How long a recent-drop marker stays valid before `take_recent_drop` must treat it as stale.
/// Generous for the JS round-trip (the frontend's drop handler sees empty paths and invokes
/// `recover_drag_paths` in reply), but short enough that it cannot be pre-staged: the only way to
/// benefit from the window is for a REAL drag to touch this exact window within it, which is the
/// fact the marker exists to prove.
const RECENT_DROP_TTL: Duration = Duration::from_secs(5);

/// `true` = set by a real `Drop` (durable consent, `Leave` cannot revoke it); `false` = set by
/// `Enter`/`Over` (a mere hover, `Leave` forgets it). Mirrors the Provisional/Durable split
/// `dispatch_drag` already applies to path grants, and for the identical reason.
fn recent_drops() -> &'static Mutex<HashMap<String, (Instant, bool)>> {
    static DROPS: OnceLock<Mutex<HashMap<String, (Instant, bool)>>> = OnceLock::new();
    DROPS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record that a real OS drag phase just touched `window`. `durable` is `true` only for `Drop`.
///
/// Called ONLY from `note_drag_event`, which is wired to Tauri's window-event delivery — nothing a
/// webview's own JS can reach or forge. This is the provenance `drag_paths::recover_drag_paths`
/// checks before reading image BYTES off the drag pasteboard: without it, any permitted webview
/// could invoke that command ambiently, with no drag over Sparkle at all, and read whatever a
/// PREVIOUS drag — to this app or to some entirely unrelated app — left resident on the OS-wide
/// drag pasteboard, then exfiltrate it via `load_attachment`.
///
/// NOT Drop-only. Tauri emits this window's JS drag-drop event to the frontend BEFORE running
/// `note_drag_event` (see the tier note above), so a marker set only on Drop can lose that race —
/// the frontend's drop handler can invoke `recover_drag_paths` before this function's own Drop
/// branch has run. Enter always precedes Drop in a real drag, so marking on every phase but Leave
/// guarantees the marker already exists by the time Drop's JS event reaches the frontend.
///
/// STICKY DURABLE, AND NEVER REVIVED BY A HOVER: once a window's marker is durable it cannot be
/// downgraded back to provisional by a later Enter/Over (see `next_recent_drop`) — `recover_drag_paths`
/// runs via `spawn_blocking`, on a worker thread concurrent with the main thread's drag delivery, so
/// "a second gesture on this window within `RECENT_DROP_TTL`" is not a rare double-drag; it is an
/// ordinary race between that worker thread's `take_recent_drop` and whatever the main thread
/// delivers next. An unconditional overwrite would let that race downgrade a real Drop's consent to
/// a hover the very next `Leave` then clears — reopening the silent refusal this marker exists to
/// prevent.
///
/// Equally important and easy to get backwards: a LIVE existing durable marker's timestamp is NOT
/// refreshed by a later hover either. A window that keeps seeing ordinary drag traffic (a compose
/// box users drag files into often) would otherwise never let a stale Drop's consent expire — each
/// Enter/Over silently extending `RECENT_DROP_TTL` past what a real caller could exploit through the
/// marker alone. Only a fresh Drop resets a durable stamp; a fresh Drop over an existing durable
/// entry is its own new, legitimate consent, so that reset is correct, not a bug.
///
/// "LIVE" is load-bearing (roborev caught this the first time it shipped without it): an EXPIRED
/// durable entry must be treated as though nothing is stored at all, not as a veto that blocks a
/// later hover from establishing a fresh marker. Without that, an ordinary drop with real paths —
/// which never gets consumed, because a drop that carries paths never calls `recover_drag_paths` at
/// all — leaves `(T1, true)` sitting in the map forever. Minutes later a genuinely new pathless-image
/// drag arrives: its Enter hits the stale-veto arm and is silently dropped on the floor, so by the
/// time that drag's own Drop reaches the frontend (before `note_drag_event` has run — the exact race
/// Enter/Over marking exists to win) there is no fresh marker for `take_recent_drop` to find. The
/// very race this whole mechanism exists to close reopens, for every window that has ever seen one
/// prior drop.
fn mark_recent_drop(window: &str, durable: bool) {
    if let Ok(mut d) = recent_drops().lock() {
        let now = Instant::now();
        let existing = d.get(window).copied();
        d.insert(window.to_owned(), next_recent_drop(existing, now, durable, RECENT_DROP_TTL));
    }
}

/// The pure decision `mark_recent_drop` applies: given what is currently stored for a window (if
/// anything) and a new drag-phase touch, what should be stored next. Split out so it is testable
/// with SYNTHETIC `Instant`s — no real clock, no sleeping, no touching the global registry — the
/// same pattern `Chosen`'s tier rules use above.
fn next_recent_drop(
    existing: Option<(Instant, bool)>,
    now: Instant,
    durable: bool,
    ttl: Duration,
) -> (Instant, bool) {
    // An EXPIRED entry is not "existing" for this decision — `take_recent_drop` would prune it on
    // the very next read anyway, so treating it as live here would only let a dead marker block a
    // fresh one from ever being established. See the "LIVE is load-bearing" doc above.
    let existing = existing.filter(|(seen, _)| now.saturating_duration_since(*seen) <= ttl);
    match existing {
        // A durable (Drop) consent is already recorded AND STILL LIVE, and this touch is a mere
        // hover: leave the stamp untouched. Refreshing it here IS the stale-marker-revival bug —
        // see the doc above.
        Some((seen, true)) if !durable => (seen, true),
        // Everything else is a legitimate reason to (re)set the stamp: a fresh Drop (even over an
        // existing durable entry — a second real Drop is its own new consent), a hover renewing an
        // existing hover (mirrors `Over` renewing a path grant), or the window's first (or first
        // LIVE) touch.
        Some((_, existing_durable)) => (now, existing_durable || durable),
        None => (now, durable),
    }
}

/// The drag left `window`. Clears a mere HOVER (Enter/Over with no Drop) — but must NEVER revoke a
/// completed Drop's DURABLE consent: wry emits `Leave` from `draggingExited:`, and its ordering
/// relative to `performDragOperation:` (Drop) is not something this code controls, so a `Leave`
/// arriving just after a real Drop is not hypothetical. Mirrors `Chosen::note_chosen` protecting the
/// path-grant tier from the identical ordering.
fn forget_recent_drop(window: &str) {
    if let Ok(mut d) = recent_drops().lock() {
        if let Some(&(_, durable)) = d.get(window) {
            if !durable {
                d.remove(window);
            }
        }
    }
}

/// `window` was destroyed — its consent cannot apply to anything, unconditionally, regardless of
/// tier. Window LABELS are reused in this app (`main`, `helper`, `capture`), so without this a
/// window recreated under the same label within `RECENT_DROP_TTL` of the old one's destruction
/// would inherit a Drop's consent it never earned — the same ambient-read this whole gate exists to
/// refuse, reached through label reuse instead of a missing marker. Called from `note_window_gone`,
/// which already applies the identical rule to the path-grant tier (`forget_dragged_paths`) for the
/// same reason: a torn-down view never delivers `draggingExited:`, so nothing else would clear it.
fn clear_recent_drop(window: &str) {
    if let Ok(mut d) = recent_drops().lock() {
        d.remove(window);
    }
}

/// Consume `window`'s recent-drop marker if it is still fresh. SINGLE USE: a second call for the
/// same drop gets nothing, which is fine — the pasteboard read this gates is itself a last-resort
/// fallback for a drop that already came back with no paths once, not something a caller needs to
/// repeat.
///
/// Also opportunistically prunes every window's stale entry, not just this one's, so the map never
/// grows unboundedly even across several windows — it is touched on every drag phase.
pub fn take_recent_drop(window: &str) -> bool {
    let Ok(mut d) = recent_drops().lock() else {
        return false;
    };
    let now = Instant::now();
    d.retain(|_, (seen, _)| now.saturating_duration_since(*seen) <= RECENT_DROP_TTL);
    d.remove(window).is_some()
}

/// What a window event means for the drag registry. A value so the arm SET is testable — including
/// the negative case, since `CloseRequested` cannot be constructed outside Tauri.
///
/// No `PartialEq`: `DragDropEvent` implements neither it nor `Eq`, and defining equality that ignored
/// the payload would be a trap. Tests match on the variant.
#[derive(Debug)]
pub enum WindowGrant<'a> {
    /// A drag phase — delegate to the drag tiers.
    Drag(&'a tauri::DragDropEvent),
    /// This window is gone; its hover grants go with it.
    Teardown,
    /// Nothing to do with file provenance.
    Ignore,
}

fn dispatch_window(event: &tauri::WindowEvent) -> WindowGrant<'_> {
    match event {
        tauri::WindowEvent::DragDrop(drag) => WindowGrant::Drag(drag),
        tauri::WindowEvent::Destroyed => WindowGrant::Teardown,
        // NOT `CloseRequested`. In this app a close request routinely does not destroy anything:
        // `capture_window.rs` calls `api.prevent_close()` on ⌘W, and the main window's close path
        // only hides (see `main_window.rs`). Treating it as teardown would revoke a live hover on a
        // window that is still right there, and no `Enter` follows to re-register it.
        _ => WindowGrant::Ignore,
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
/// dragged over the window. A poisoned registry is RECOVERED rather than read as "not chosen" — see
/// `chosen_locked` for why propagating the poison was the worse failure.
///
/// BLOCKS while a registration is in flight — see the body. Callers reach this only from an `async`
/// command's `spawn_blocking` body; calling it from the AppKit main thread would reintroduce the
/// freeze the registration path was restructured to remove.
fn is_user_chosen(real: &Path, order: &mut ReadOrder) -> bool {
    // FIRST, not as a fallback when the answer is "no". Registration is performed by a background
    // worker (see the main-thread note above), so at any instant the registry may be missing drag
    // events the OS has already delivered — and BOTH DIRECTIONS matter:
    //
    //   - a GRANT still in flight. Tauri emits the JS drag-drop event to the frontend BEFORE running
    //     the window-event listener, so `load_attachment` for a drop that is genuinely happening
    //     right now can arrive mid-registration. Answering "no" there is the silent refusal of bead
    //     `sparkle-zviq`, restored by the very fix that removed the freeze.
    //
    //   - a REVOCATION still in flight, which is the half that is easy to miss. `Leave` and a window
    //     teardown are queued behind the `Enter` whose entries they revoke, so a read that consulted
    //     the registry first would find the hover STILL PRESENT and return `true` without ever
    //     waiting — granting a path for a drag that has already left. An earlier draft did exactly
    //     that (fast-path on the positive answer, wait only on the negative) and two existing tier
    //     tests caught it under full-suite load, where the worker lags behind the test thread.
    //
    // So: order the read AFTER every drag event delivered before it, then answer. That is the
    // semantics the inline version had for free, and restoring it is what makes moving the work off
    // the main thread invisible to every rule in `Chosen`.
    //
    // Waiting here is free: every command that reaches this is `async` and does its work under
    // `spawn_blocking`, so the wait costs a pool thread and freezes nothing. When nothing is
    // outstanding — the overwhelmingly common case — it is one uncontended lock and a return.
    // AND THE WAIT CAN TIME OUT, which is the case this branch exists for. `resolve_wait()` is 30
    // seconds and `PROVISIONAL_TTL` is 60, so a worker wedged inside `canonicalize` for longer than
    // the budget leaves a registry that still holds a hover whose `Forget` — from `Leave` or from
    // `note_window_gone` — is queued behind the wedge and unapplied, while that entry is still well
    // inside its TTL. Answering from it would grant a path for a drag that has already left the
    // window: precisely what the revocation half of the note above, and the tier itself, exist to
    // deny. Reading a registry known to be behind, as though it were complete, is the wait failing
    // OPEN in the one direction this module says it must not.
    //
    // WHICH FAIL-CLOSED, AND WHY THIS ONE. Refusing everything on timeout would be the blunt answer,
    // and it is worse than the tiered one for no security gain: it would refuse a file the user
    // genuinely dropped or picked minutes ago — a download or a clipboard copy of an existing
    // attachment — because some unrelated drag wedged the worker, which is bead `sparkle-zviq`'s
    // silent refusal restored under a new trigger. The DURABLE tier cannot be over-reported by a
    // stale registry at all (see `Chosen::contains_durable`: nothing queued revokes it), so consent
    // stays readable and only the tier that a queued `Forget` can falsify is dropped. The refusal we
    // do take is a genuine hover-read during a wedge, which is the narrow case actually at risk.
    let ordering = order.order();
    let now = Instant::now();
    let c = chosen_locked();
    if ordering.drained {
        c.contains(real, now)
    } else {
        // Visible, because from the outside a timed-out read is indistinguishable from a path that
        // was simply never granted — and the cause is a wedged worker, not the user's path.
        //
        // ONCE PER BATCH, and reporting what THIS read was actually offered rather than the
        // constant. Twenty paths behind one wedged worker are one event; and a later path in an
        // exhausted batch is offered 0 ms, so logging `resolve_wait()` there would assert a
        // 30-second budget exhaustion that never happened (roborev 67513).
        if ordering.first_failure {
            tracing::warn!(
                offered_ms = ordering.offered.as_millis() as u64,
                budget_ms = resolve_wait().as_millis() as u64,
                "drag path resolution did not drain within the read budget; answering from durable \
                 consent only (a queued revocation may be unapplied). Further paths in this batch \
                 are not logged."
            );
        }
        c.contains_durable(real)
    }
}

/// Validate a path we're about to READ (it must already exist). Canonicalizing first resolves
/// symlinks and `..`, so `~/Downloads/../.ssh/id_rsa` is caught, and closes the check-vs-use
/// window (we return the real path for the caller to read). Accepts a path the user chose through
/// the OS (see the provenance note above); otherwise rejects anything outside the allowed roots or
/// reaching a hidden component.
fn validate_read_path(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    validate_read_path_ordered(path, roots, &mut ReadOrder::new())
}

/// `validate_read_path` for a BATCH: every path in one command shares a single `ReadOrder`, so the
/// read-ordering budget is paid once for the command rather than once per path. See `ReadOrder`.
fn validate_read_path_ordered(
    path: &Path,
    roots: &[PathBuf],
    order: &mut ReadOrder,
) -> Result<PathBuf, String> {
    let real = path
        .canonicalize()
        .map_err(|e| format!("cannot access {}: {e}", path.display()))?;
    if is_contained_and_visible(&real, roots) || is_user_chosen(&real, order) {
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

/// What a caller needs in order to DECIDE about a path, with none of the bytes.
///
/// `load_attachment` cannot answer this. It echoes back the path it was HANDED (`path.to_owned()`),
/// which is the string a symlink or a `..` lies with, and it reports no size at all — so a caller
/// that must prove a path stays inside a directory, and must cap how big a file it accepts, has
/// nothing to work from. This carries the three facts that decision needs and stops there: no read,
/// no base64, no data URL.
#[derive(Serialize)]
pub struct AttachmentProbe {
    /// The path with symlinks and `..` RESOLVED. Compare containment against this, never against
    /// what the caller supplied — that is the entire reason this command exists.
    real_path: String,
    /// Size in bytes, of the resolved target.
    size: u64,
    /// False for a directory, a socket, a fifo — anything that is not a regular file.
    is_file: bool,
}

/// Resolve + stat one path, without reading it.
///
/// The concierge's attachment gate (`services/conciergeTools/attachments.ts`) is the caller: a model
/// names an absolute path and the gate has to establish that it really lands inside the project, is
/// a regular file, and is not enormous. Every one of those is a question about the RESOLVED path.
#[tauri::command]
pub async fn probe_attachment(path: String) -> Result<AttachmentProbe, String> {
    tauri::async_runtime::spawn_blocking(move || probe_blocking(&path))
        .await
        .map_err(|e| format!("probe_attachment task failed: {e}"))?
}

fn probe_blocking(path: &str) -> Result<AttachmentProbe, String> {
    // The same second layer every other command in this file applies (see the containment block
    // above). It is not the caller's gate — the TS side's project containment is far narrower — but
    // without it a compromised webview could use this as an existence/size oracle over `~/.ssh` and
    // any other tree the primary boundary is meant to keep it out of.
    let roots = allowed_roots();
    let real = validate_read_path(Path::new(path), &roots)?;
    let meta = std::fs::metadata(&real).map_err(|e| format!("stat {path}: {e}"))?;
    Ok(AttachmentProbe {
        real_path: real.to_string_lossy().into_owned(),
        size: meta.len(),
        is_file: meta.is_file(),
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
        copy_files_to_dir_blocking(&srcs, &dest_dir, &allowed_roots())
    })
    .await
    .map_err(|e| format!("copy_files task failed: {e}"))?
}

/// The body of `copy_files_to_dir`, with the allowed roots passed in.
///
/// Split out for the same reason `load_blocking` / `probe_blocking` are: a test can then drive the
/// REAL batch loop — the thing whose per-path wait is the defect — against roots it controls,
/// instead of asserting on a helper the command might not even call.
fn copy_files_to_dir_blocking(
    srcs: &[String],
    dest_dir: &str,
    roots: &[PathBuf],
) -> Result<(), String> {
    let dir = validate_dir_path(Path::new(dest_dir), roots)?;
    let mut claimed: HashSet<String> = HashSet::new();
    let mut errors: Vec<String> = Vec::new();
    // ONE read-ordering budget for the whole batch. Per-path it would be `RESOLVE_WAIT` times the
    // number of srcs against a wedged resolver — ~25 minutes on one blocking-pool thread for a
    // 50-file copy, with nothing to cancel it — while the queue being waited on has not moved since
    // the first path. See `ReadOrder`.
    let mut order = ReadOrder::new();
    for src in srcs {
        let real_src = match validate_read_path_ordered(Path::new(src), roots, &mut order) {
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
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
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

    /// Serializes EVERY test that mutates the process-global registry.
    ///
    /// It is not enough to lock only the hover tests, which is what the first version did and it
    /// flaked once in a full run: `note_chosen` clears the provisional set (a drop supersedes the
    /// hover it completes), so a *durable*-registry test running concurrently revokes a hover test's
    /// grant and the hover test fails as though the security rule had regressed. `Enter` likewise
    /// replaces the whole provisional set. Unique temp paths keep the DURABLE entries from colliding,
    /// but nothing about a unique path protects a shared set that gets cleared — so all of them share
    /// this one lock.
    fn global_drag_lock() -> std::sync::MutexGuard<'static, ()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        L.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
        let _serialized = global_drag_lock();
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
        let _serialized = global_drag_lock();
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
        c.note_dragged(vec![p("/home/me/.ssh/id_rsa")], t, "main");
        // Readable WHILE hovering — that is what closes the race with the JS drop event.
        assert!(c.contains(&p("/home/me/.ssh/id_rsa"), t), "readable during the drag");

        c.forget_dragged("main");
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
        c.note_dragged(vec![p("/home/me/.ssh/id_rsa")], t, "main");

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
        c.note_dragged(vec![p("/tmp/notes.txt")], t, "main");

        // Still dragging, well past the TTL, with the OS reporting it the whole time.
        let mut hovering = t;
        for _ in 0..10 {
            hovering += PROVISIONAL_TTL;
            c.refresh_dragged(hovering, "main");
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
        c.note_dragged(vec![p("/tmp/dropped.txt")], t, "main");
        c.note_chosen(vec![p("/tmp/dropped.txt")], "main"); // the Drop
        c.forget_dragged("main"); // a later, unrelated drag leaves

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
        c.note_dragged(vec![p("/tmp/first.txt")], t, "main");
        c.note_dragged(vec![p("/tmp/second.txt")], t, "main");

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
        c.note_dragged(vec![p("/tmp/a.txt"), p("/tmp/b.txt")], t, "main");
        c.note_chosen(vec![p("/tmp/a.txt")], "main"); // only a.txt was actually dropped

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
    fn a_real_drag_event_grants_provisionally_and_a_real_leave_revokes_it() {
        // END-TO-END through `note_drag_event` and the PROCESS-GLOBAL registry, because the two
        // tests above only cover `dispatch_drag`. Classifying `Enter` as `Provisional` and then
        // ACTING on that classification are separate steps, and the second one is where the grant
        // happens: swapping `DragGrant::Provisional(paths) => note_dragged_paths(paths)` for
        // `note_user_chosen_paths(paths)` is semantically the pre-fix `Enter | Drop` arm — the hole
        // this whole change exists to close — and every other test in this file survives it. This one
        // does not.
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let roots: Vec<PathBuf> = vec![]; // no containment at all: provenance is the only rule here
        let f = outside.join("hovered.txt");
        touch(&f);

        assert!(
            validate_read_path(&f, &roots).is_err(),
            "precondition: nothing grants this path yet"
        );

        note_drag_event("main", &tauri::DragDropEvent::Enter {
            paths: vec![f.clone()],
            position: drag_position(),
        });
        assert!(
            validate_read_path(&f, &roots).is_ok(),
            "a file being dragged over the window must be readable — this is what closes the race \
             with the JS drop event"
        );

        note_drag_event("main", &tauri::DragDropEvent::Leave);
        assert!(
            validate_read_path(&f, &roots).is_err(),
            "a drag that left without dropping must leave NO grant behind"
        );
    }

    #[test]
    fn a_window_closing_mid_drag_revokes_the_hover_it_would_have_stranded() {
        // The lost-`Leave` cause, handled at the cause: a view torn down mid-drag never delivers
        // `draggingExited:`. Without this the grant would sit until PROVISIONAL_TTL lapsed, and that
        // TTL is deliberately long (a short one would expire under a motionless hover, since `Over`
        // only arrives on pointer movement).
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let roots: Vec<PathBuf> = vec![];
        let f = outside.join("stranded.txt");
        touch(&f);

        note_drag_event("main", &tauri::DragDropEvent::Enter {
            paths: vec![f.clone()],
            position: drag_position(),
        });
        assert!(validate_read_path(&f, &roots).is_ok(), "granted while hovering");

        note_window_gone("main");
        assert!(
            validate_read_path(&f, &roots).is_err(),
            "a window that went away mid-drag must not strand the hover grant"
        );
    }

    // ── Recent-drop provenance, for `recover_drag_paths`'s image-bytes fallback ────────────────────
    //
    // The stamp/tier DECISION is `next_recent_drop`, tested here PURELY with synthetic `Instant`s —
    // no sleeping, no real clock, no touching the global registry — the same split `Chosen`'s tier
    // rules use above. The `note_drag_event`/`take_recent_drop` tests below drive the process-global
    // registry directly for what only exists at that level: whether a real `Drop` reached the
    // dispatcher at all. Each of THOSE tests uses its own window label — the registry is TTL-based
    // rather than cleared eagerly, so a shared label could leak a marker from one test into the next.

    #[test]
    fn a_stale_durable_marker_is_not_revived_by_a_later_hover() {
        // THE BUG THIS PINS: a naive "always refresh the timestamp" rule lets ordinary drag traffic
        // over a window (a compose box users drag files into often) keep a stale Drop's consent
        // alive indefinitely — each Enter/Over silently extending `RECENT_DROP_TTL` past anything a
        // real caller could exploit through the marker alone.
        let t0 = Instant::now();
        let t1 = t0 + Duration::from_secs(1);
        let after_drop = next_recent_drop(None, t0, true, RECENT_DROP_TTL);
        assert_eq!(after_drop, (t0, true));
        let after_hover = next_recent_drop(Some(after_drop), t1, false, RECENT_DROP_TTL);
        assert_eq!(
            after_hover,
            (t0, true),
            "a later hover, still within the TTL, must NOT refresh a LIVE durable marker's timestamp"
        );
    }

    #[test]
    fn an_expired_durable_marker_does_not_block_a_fresh_hover_from_registering() {
        // THE BUG ROBOREV CAUGHT IN THE FIX ABOVE: treating ANY durable entry as a veto — expired
        // or not — reopens the exact silent refusal this whole mechanism exists to close. An
        // ordinary drop with real paths is never consumed (a drop that carries paths never calls
        // `recover_drag_paths`), so its durable marker sits unconsumed until it expires. Minutes
        // later a genuinely NEW pathless-image drag's Enter must be free to establish its own
        // fresh marker — an expired entry is not "existing" for this decision.
        let t0 = Instant::now();
        let long_after = t0 + RECENT_DROP_TTL + Duration::from_secs(1);
        let after_drop = next_recent_drop(None, t0, true, RECENT_DROP_TTL);
        let after_stale_hover = next_recent_drop(Some(after_drop), long_after, false, RECENT_DROP_TTL);
        assert_eq!(
            after_stale_hover,
            (long_after, false),
            "an EXPIRED durable marker must not block a later hover from registering a fresh one"
        );
    }

    #[test]
    fn a_fresh_drop_always_resets_the_stamp_even_over_an_existing_durable_entry() {
        // A SECOND real Drop is its own new, legitimate consent — unlike a mere hover, it must
        // reset the timestamp even when a durable entry already exists.
        let t0 = Instant::now();
        let t1 = t0 + Duration::from_secs(1);
        let first = next_recent_drop(None, t0, true, RECENT_DROP_TTL);
        let second = next_recent_drop(Some(first), t1, true, RECENT_DROP_TTL);
        assert_eq!(second, (t1, true));
    }

    #[test]
    fn a_hover_still_renews_its_own_provisional_stamp() {
        // The stale-marker-revival fix must not also break the ordinary case: renewing a mere
        // hover (mirrors `Over` renewing a path grant) is still allowed to refresh its timestamp —
        // only a LIVE DURABLE entry's stamp is protected from a later hover.
        let t0 = Instant::now();
        let t1 = t0 + Duration::from_secs(1);
        let first = next_recent_drop(None, t0, false, RECENT_DROP_TTL);
        let second = next_recent_drop(Some(first), t1, false, RECENT_DROP_TTL);
        assert_eq!(second, (t1, false));
    }

    #[test]
    fn a_drop_upgrades_an_existing_hover_to_durable() {
        let t0 = Instant::now();
        let hover = (t0, false);
        let t1 = t0 + Duration::from_secs(1);
        assert_eq!(next_recent_drop(Some(hover), t1, true, RECENT_DROP_TTL), (t1, true));
    }

    #[test]
    fn a_real_drop_marks_the_window_and_the_marker_is_single_use() {
        let _serialized = global_drag_lock();
        note_drag_event("prov-single-use", &tauri::DragDropEvent::Drop {
            paths: vec![],
            position: drag_position(),
        });
        assert!(
            take_recent_drop("prov-single-use"),
            "a real Drop just delivered to this window must leave a provenance marker"
        );
        assert!(
            !take_recent_drop("prov-single-use"),
            "the marker is single-use — a second consume must find nothing"
        );
    }

    #[test]
    fn a_drop_on_one_window_does_not_mark_another() {
        let _serialized = global_drag_lock();
        note_drag_event("prov-cross-a", &tauri::DragDropEvent::Drop {
            paths: vec![],
            position: drag_position(),
        });
        assert!(
            !take_recent_drop("prov-cross-b"),
            "an ambient call from a DIFFERENT window must not ride another window's real drop"
        );
        // Clean up the marker this test itself set, so it cannot outlive the test.
        assert!(take_recent_drop("prov-cross-a"));
    }

    #[test]
    fn entering_marks_the_window_even_before_any_drop() {
        // THE RACE THIS CLOSES: Tauri emits this window's JS drag-drop event to the frontend BEFORE
        // running `note_drag_event`, so a marker set only on Drop can lose to the frontend's own
        // `recover_drag_paths` call racing ahead of this function's Drop branch. Marking on Enter
        // too means the marker is already set by the time Drop's JS event reaches the frontend,
        // since Enter always precedes Drop in every real drag and — unlike a JS-side flag — cannot
        // be forged by webview-controlled code.
        let _serialized = global_drag_lock();
        note_drag_event("prov-enter-only", &tauri::DragDropEvent::Enter {
            paths: vec![],
            position: drag_position(),
        });
        assert!(
            take_recent_drop("prov-enter-only"),
            "Enter alone, before any Drop, must already leave a fresh provenance marker"
        );
    }

    #[test]
    fn a_hover_that_leaves_without_dropping_clears_its_marker() {
        // A drag merely crossing this window (Enter, then Leave, no Drop) must not leave a residual
        // grant a later ambient call could ride — same rule `forget_dragged_paths` already applies
        // to path grants.
        let _serialized = global_drag_lock();
        note_drag_event("prov-enter-leave", &tauri::DragDropEvent::Enter {
            paths: vec![],
            position: drag_position(),
        });
        note_drag_event("prov-enter-leave", &tauri::DragDropEvent::Leave);
        assert!(
            !take_recent_drop("prov-enter-leave"),
            "Enter followed by Leave, with no Drop, must leave NO provenance marker behind"
        );
    }

    #[test]
    fn a_drop_followed_by_leave_keeps_its_marker() {
        // THE TIER-COLLAPSE THIS GUARDS: wry emits `Leave` from `draggingExited:`, and this code
        // does not control its ordering relative to `performDragOperation:` (Drop) — a `Leave`
        // arriving just after a real Drop is not hypothetical. A marker collapsed to one
        // undifferentiated tier would let that `Leave` wipe the Drop's DURABLE consent before the
        // frontend's `recover_drag_paths` call ever consumes it — recreating the exact silent
        // refusal this whole feature exists to fix.
        let _serialized = global_drag_lock();
        note_drag_event("prov-drop-then-leave", &tauri::DragDropEvent::Drop {
            paths: vec![],
            position: drag_position(),
        });
        note_drag_event("prov-drop-then-leave", &tauri::DragDropEvent::Leave);
        assert!(
            take_recent_drop("prov-drop-then-leave"),
            "a Leave arriving after a real Drop must NOT revoke the Drop's consent marker"
        );
    }

    #[test]
    fn a_stray_enter_after_a_drop_cannot_downgrade_its_marker() {
        // THE DOWNGRADE THIS GUARDS: `recover_drag_paths` runs via `spawn_blocking`, on a worker
        // thread concurrent with the main thread's drag delivery. If a later Enter/Over (a second
        // gesture inside the TTL, or a stray Enter from another view moving under the cursor) were
        // allowed to overwrite a durable marker with a provisional one, a subsequent Leave — which
        // is allowed to clear a provisional marker — would revoke the ORIGINAL Drop's consent
        // before the worker thread ever consumes it. Sticky-durable in `mark_recent_drop` is what
        // prevents that: this pins Drop -> Enter -> Leave still leaving a usable marker.
        let _serialized = global_drag_lock();
        note_drag_event("prov-drop-then-enter-then-leave", &tauri::DragDropEvent::Drop {
            paths: vec![],
            position: drag_position(),
        });
        note_drag_event("prov-drop-then-enter-then-leave", &tauri::DragDropEvent::Enter {
            paths: vec![],
            position: drag_position(),
        });
        note_drag_event("prov-drop-then-enter-then-leave", &tauri::DragDropEvent::Leave);
        assert!(
            take_recent_drop("prov-drop-then-enter-then-leave"),
            "a stray Enter after a real Drop must not downgrade the marker to something a \
             following Leave can then revoke"
        );
    }

    #[test]
    fn a_destroyed_window_cannot_hand_its_drop_consent_to_its_replacement() {
        // Window LABELS are reused ("main", "helper", "capture"). Without `note_window_gone`
        // clearing `recent_drops`, a window recreated under the same label within the TTL would
        // inherit a Drop's consent it never earned — the exact ambient-read this gate exists to
        // refuse, reached through label reuse instead of a missing marker.
        let _serialized = global_drag_lock();
        note_drag_event("prov-gone", &tauri::DragDropEvent::Drop {
            paths: vec![],
            position: drag_position(),
        });
        note_window_gone("prov-gone");
        assert!(
            !take_recent_drop("prov-gone"),
            "a destroyed window's Drop consent must not survive for whatever window is recreated \
             under the same label"
        );
    }

    #[test]
    fn an_ambient_call_with_no_drop_at_all_finds_no_marker() {
        // THE ATTACK ITSELF: a permitted webview invokes `recover_drag_paths` with no drag in
        // progress whatsoever — no Enter, no Drop, nothing. `take_recent_drop` must refuse it.
        let _serialized = global_drag_lock();
        assert!(!take_recent_drop("prov-never-dropped-on"));
    }

    // ── Window scoping, at the RULE level ───────────────────────────────────────────────────────
    //
    // The global-registry tests above pin `forget_dragged` and `note_chosen` across two labels, but
    // every `Chosen`-level test drives a single `"main"`, so `note_dragged`'s own scoping and
    // `refresh_dragged`'s filter were unpinned: reverting either left the suite green. Same defect as
    // the last two rounds, one level down.

    #[test]
    fn a_drag_entering_one_window_leaves_another_windows_hover_alone() {
        // The helper island / capture panel can appear under the cursor mid-drag and take an `Enter`.
        // If that cleared the set globally it would wipe the main window's live hover with no further
        // `Enter` coming to re-register it — the unrecoverable case.
        let t = Instant::now();
        let mut c = Chosen::default();
        c.note_dragged(vec![p("/tmp/over-main.txt")], t, "main");
        c.note_dragged(vec![p("/tmp/over-helper.txt")], t, "helper");

        assert!(
            c.contains(&p("/tmp/over-main.txt"), t),
            "an Enter on another window must not revoke this window's hover"
        );
        assert!(c.contains(&p("/tmp/over-helper.txt"), t), "and the new hover is granted");
    }

    #[test]
    fn an_over_on_one_window_does_not_keep_another_windows_hover_alive() {
        // The mutation that WIDENS the grant rather than narrowing it. Without the filter, an `Over`
        // anywhere over Sparkle re-stamps every window's entries, so a hover stranded by a lost
        // `Leave` is renewed indefinitely and `PROVISIONAL_TTL` stops being a backstop at all.
        let t = Instant::now();
        let mut c = Chosen::default();
        c.note_dragged(vec![p("/tmp/stranded-on-main.txt")], t, "main");

        let much_later = t + PROVISIONAL_TTL * 2;
        c.refresh_dragged(much_later, "helper");

        assert!(
            !c.contains(&p("/tmp/stranded-on-main.txt"), much_later),
            "an Over on a DIFFERENT window must not renew this one's stamp"
        );
    }

    #[test]
    fn a_huge_drag_on_one_window_cannot_evict_another_windows_hover() {
        // `DRAGGED_CAP` used to be a global bound evicted with `pop_front()` — the oldest entry in the
        // whole deque, which after window-scoping can be another window's LIVE hover. Harmless before
        // scoping (each Enter cleared the set, so eviction only touched the drag being recorded);
        // silently revoking afterwards, which is the failure the scoping exists to prevent.
        let t = Instant::now();
        let mut c = Chosen::default();
        c.note_dragged(vec![p("/tmp/precious.txt")], t, "main");

        let flood: Vec<PathBuf> = (0..=DRAGGED_CAP).map(|i| p(&format!("/tmp/f{i}.txt"))).collect();
        c.note_dragged(flood, t, "helper");

        assert!(
            c.contains(&p("/tmp/precious.txt"), t),
            "a huge drag over another window must not evict this window's hover"
        );
        // The cap still bounds the flooding window: it kept the LAST DRAGGED_CAP of its own paths.
        assert!(!c.contains(&p("/tmp/f0.txt"), t), "the flood's own oldest entry was evicted");
        assert!(
            c.contains(&p(&format!("/tmp/f{DRAGGED_CAP}.txt")), t),
            "and its newest was kept"
        );
    }

    #[test]
    fn only_a_destroyed_window_is_teardown() {
        // The arm SET, as a value. This was a `matches!` at the `on_window_event` call site — the same
        // untestable shape the drag mapping had — so deleting the teardown arm, or widening it back to
        // `CloseRequested`, left the suite green. `CloseRequested` cannot be constructed here (its
        // variant is `#[non_exhaustive]`), which is why the negative case matters: it pins that the
        // arm set is narrow rather than "anything window-ish".
        assert!(
            matches!(
                dispatch_window(&tauri::WindowEvent::Destroyed),
                WindowGrant::Teardown
            ),
            "a destroyed window's hovers must be dropped"
        );
        assert!(
            matches!(
                dispatch_window(&tauri::WindowEvent::Focused(true)),
                WindowGrant::Ignore
            ),
            "focus is not teardown — clearing here would revoke a live hover"
        );
        assert!(
            matches!(
                dispatch_window(&tauri::WindowEvent::Focused(false)),
                WindowGrant::Ignore
            ),
            "losing focus is not teardown either: dragging from another app necessarily blurs us"
        );
        assert!(
            matches!(
                dispatch_window(&tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave)),
                WindowGrant::Drag(tauri::DragDropEvent::Leave)
            ),
            "a drag phase must reach the drag tiers"
        );
    }

    #[test]
    fn one_window_closing_does_not_revoke_a_hover_over_another() {
        // `Destroyed` is per-window and the app runs several (project_window.rs, helper.rs,
        // capture_window.rs). Clearing globally would revoke a hover over a DIFFERENT window, and
        // that is unrecoverable for the rest of the drag: the pointer is already inside, so no further
        // `Enter` re-registers, and `Over` only re-stamps entries that still exist. The drop would
        // then race the durable registration — which is the silent refusal this branch exists to fix.
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let roots: Vec<PathBuf> = vec![];
        let f = outside.join("hovering-over-main.txt");
        touch(&f);

        note_drag_event(
            "main",
            &tauri::DragDropEvent::Enter {
                paths: vec![f.clone()],
                position: drag_position(),
            },
        );
        note_window_event("helper-2", &tauri::WindowEvent::Destroyed);

        assert!(
            validate_read_path(&f, &roots).is_ok(),
            "a satellite window closing must not revoke the hover the user has over THIS window"
        );

        // ...but its own window going away does revoke it.
        note_window_event("main", &tauri::WindowEvent::Destroyed);
        assert!(
            validate_read_path(&f, &roots).is_err(),
            "the hover's own window going away drops it"
        );
    }

    #[test]
    fn a_leave_on_one_window_leaves_another_windows_hover_alone() {
        // Same scoping rule on the `Leave` path, which is the one that actually fires per-window
        // during ordinary use.
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let roots: Vec<PathBuf> = vec![];
        let f = outside.join("still-hovering.txt");
        touch(&f);

        note_drag_event(
            "main",
            &tauri::DragDropEvent::Enter {
                paths: vec![f.clone()],
                position: drag_position(),
            },
        );
        note_drag_event("helper-2", &tauri::DragDropEvent::Leave);

        assert!(
            validate_read_path(&f, &roots).is_ok(),
            "a Leave reported by a different window must not revoke this window's hover"
        );
    }

    #[test]
    fn the_native_panel_does_not_disturb_an_in_flight_hover() {
        // `note_user_chosen_paths` is also the picker's entry point, and a picker choice is not a
        // window's drag phase. It must ADD durable consent without clearing anyone's provisional set —
        // otherwise opening the panel mid-drag would revoke the hover.
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let roots: Vec<PathBuf> = vec![];
        let hovered = outside.join("hovered-while-picking.txt");
        let picked = outside.join("picked.txt");
        touch(&hovered);
        touch(&picked);

        note_drag_event(
            "main",
            &tauri::DragDropEvent::Enter {
                paths: vec![hovered.clone()],
                position: drag_position(),
            },
        );
        note_user_chosen_paths([picked.clone()]);

        assert!(validate_read_path(&picked, &roots).is_ok(), "the picked file is granted");
        assert!(
            validate_read_path(&hovered, &roots).is_ok(),
            "a native panel choice must not revoke an in-flight hover"
        );
    }

    #[test]
    fn a_real_drop_event_is_durable_consent() {
        // The mirror: `Drop` must survive everything that clears a hover, or an attachment could not
        // be downloaded or clipboard-copied afterwards. Also guards the inverse mutation —
        // `Durable(paths) => note_dragged_paths(paths)` would make every attachment expire.
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let roots: Vec<PathBuf> = vec![];
        let f = outside.join("dropped-for-real.txt");
        touch(&f);

        note_drag_event("main", &tauri::DragDropEvent::Drop {
            paths: vec![f.clone()],
            position: drag_position(),
        });
        note_drag_event("main", &tauri::DragDropEvent::Leave); // a later, unrelated drag passes through
        note_window_gone("main"); // and a window closes

        assert!(
            validate_read_path(&f, &roots).is_ok(),
            "a file the user actually dropped stays readable"
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

    // ── Off the AppKit main thread (bead `sparkle-bxidpw`) ──────────────────────────────────────
    //
    // These drive the REAL entry point Tauri calls on the main thread — `note_window_event` — with
    // path resolution made arbitrarily slow through the injected seam. That injection is what makes
    // the property observable at all: against a resolver that always returns instantly, "the main
    // thread was released while resolution was outstanding" and "the main thread blocked until
    // resolution finished" produce identical observations, which is the vacuous shape AGENTS.md
    // warns about. `the_production_default_resolver_really_canonicalizes` covers the other half —
    // that the PRODUCTION wiring, with nothing injected, is the real `canonicalize`.

    /// Installs a path resolver for the life of the guard, restoring the production default after.
    ///
    /// The restore first DRAINS the queue, because an op enqueued under the injected resolver but
    /// not yet applied would otherwise be resolved by the production default — a test's setup
    /// leaking into whatever ran next.
    struct ResolverOverride;

    impl ResolverOverride {
        fn install(f: PathResolver) -> Self {
            *resolver_override().lock().unwrap_or_else(|e| e.into_inner()) = Some(f);
            ResolverOverride
        }
    }

    impl Drop for ResolverOverride {
        fn drop(&mut self) {
            let _ = await_pending_registrations(Duration::from_secs(10));
            *resolver_override().lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    #[derive(Default)]
    struct GateState {
        entered: usize,
        released: bool,
    }

    /// A path resolver that BLOCKS inside itself until the test releases it, then does the REAL
    /// production resolution so the registry still ends up holding genuine canonical paths.
    ///
    /// The 3-second self-release cap is deliberate. A regression that put resolution back on the
    /// calling thread must FAIL the timing assertion, not hang the suite forever — a test that wedges
    /// is a test nobody can read the verdict of.
    #[derive(Clone)]
    struct ResolverGate(std::sync::Arc<(Mutex<GateState>, Condvar)>);

    impl ResolverGate {
        const SELF_RELEASE: Duration = Duration::from_secs(3);

        fn new() -> Self {
            ResolverGate(std::sync::Arc::new((Mutex::new(GateState::default()), Condvar::new())))
        }

        fn resolver(&self) -> PathResolver {
            let inner = std::sync::Arc::clone(&self.0);
            std::sync::Arc::new(move |paths: Vec<PathBuf>| {
                let (m, cv) = &*inner;
                let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
                st.entered += 1;
                cv.notify_all();
                let deadline = Instant::now() + ResolverGate::SELF_RELEASE;
                while !st.released {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    let (g, _) =
                        cv.wait_timeout(st, deadline - now).unwrap_or_else(|e| e.into_inner());
                    st = g;
                }
                drop(st);
                canonical_all(paths)
            })
        }

        /// Block until the resolver has been entered at least `n` times. Returns false on timeout.
        fn wait_entered(&self, n: usize) -> bool {
            let (m, cv) = &*self.0;
            let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
            let deadline = Instant::now() + Duration::from_secs(5);
            while st.entered < n {
                let now = Instant::now();
                if now >= deadline {
                    return false;
                }
                let (g, _) = cv.wait_timeout(st, deadline - now).unwrap_or_else(|e| e.into_inner());
                st = g;
            }
            true
        }

        fn is_released(&self) -> bool {
            self.0 .0.lock().unwrap_or_else(|e| e.into_inner()).released
        }

        fn release(&self) {
            let (m, cv) = &*self.0;
            m.lock().unwrap_or_else(|e| e.into_inner()).released = true;
            cv.notify_all();
        }
    }

    /// Shrinks the read-ordering budget for the life of the guard.
    ///
    /// The DEADLINE branch of `await_pending_registrations` is the branch a stale registry gets
    /// answered from, and against the shipping 30-second budget nothing could reach it without
    /// parking the suite for half a minute per assertion — which is why that branch shipped covered
    /// by nothing at all.
    struct ResolveWaitOverride;

    impl ResolveWaitOverride {
        fn install(d: Duration) -> Self {
            *resolve_wait_override().lock().unwrap_or_else(|e| e.into_inner()) = Some(d);
            ResolveWaitOverride
        }
    }

    impl Drop for ResolveWaitOverride {
        fn drop(&mut self) {
            *resolve_wait_override().lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    fn leave_event() -> tauri::WindowEvent {
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave)
    }

    fn drop_event(paths: Vec<PathBuf>) -> tauri::WindowEvent {
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position: drag_position() })
    }

    fn enter_event(paths: Vec<PathBuf>) -> tauri::WindowEvent {
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter { paths, position: drag_position() })
    }

    /// THE DEFECT, as a test. `note_window_event` is run SYNCHRONOUSLY BY TAURI ON THE APPKIT MAIN
    /// THREAD, and it used to call `std::fs::canonicalize` inline — an unbounded blocking syscall,
    /// once per dragged path, on `Enter` as well as `Drop`. Against a dataless iCloud placeholder or
    /// a stalled network mount that parks the UI for as long as the syscall takes, and `Enter` fires
    /// for ANY drag crossing the window, including one on its way to another app.
    ///
    /// The assertion is the SIDE EFFECT — we are back on the calling thread while the resolution it
    /// triggered is demonstrably still running — not that some function was called. Against the
    /// pre-fix code this fails by taking `ResolverGate::SELF_RELEASE` to return.
    #[test]
    fn note_window_event_returns_while_path_resolution_is_still_outstanding() {
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let f = outside.join("slow-to-resolve.txt");
        touch(&f);

        let gate = ResolverGate::new();
        let _installed = ResolverOverride::install(gate.resolver());

        let t0 = Instant::now();
        note_window_event("bxidpw-prompt", &drop_event(vec![f.clone()]));
        let on_the_calling_thread = t0.elapsed();

        assert!(gate.wait_entered(1), "path resolution must actually have been started");
        assert!(
            !gate.is_released(),
            "precondition: nothing has released the resolver, so it is STILL running right now"
        );
        assert!(
            on_the_calling_thread < Duration::from_millis(100),
            "note_window_event runs on the AppKit main thread and must return while resolution is \
             still outstanding — it took {on_the_calling_thread:?}"
        );

        gate.release();
    }

    /// THE OTHER HALF, and the one that makes the fix safe: bead `sparkle-zviq`. Tauri emits the JS
    /// drag-drop event to the frontend BEFORE it runs this listener, so `load_attachment` for a drop
    /// that is genuinely happening right now can arrive while that drop's registration is still in
    /// flight. A read that answered "not chosen" there would be the original silent refusal,
    /// restored by the very change that removed the freeze.
    ///
    /// So the read must WAIT — and waiting is free, because every command that reaches it is `async`
    /// and does its work under `spawn_blocking`. Deleting `await_pending_registrations` from
    /// `is_user_chosen` fails this test twice over: the read finishes early, and it finishes wrong.
    #[test]
    fn a_drop_still_resolving_makes_the_read_wait_rather_than_refusing_it() {
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let f = outside.join("read-me-immediately.txt");
        touch(&f);

        let gate = ResolverGate::new();
        let _installed = ResolverOverride::install(gate.resolver());

        note_window_event("zviq-race", &drop_event(vec![f.clone()]));
        assert!(gate.wait_entered(1), "the drop's registration is in flight");

        let target = f.clone();
        let reader = std::thread::spawn(move || {
            // No containment at all: provenance is the only rule that can grant this path, exactly
            // as for the `/private/tmp` file in the original report.
            let roots: Vec<PathBuf> = vec![];
            validate_read_path(&target, &roots).is_ok()
        });

        std::thread::sleep(Duration::from_millis(120));
        assert!(
            !reader.is_finished(),
            "a read arriving mid-resolution must WAIT for it — an answer now could only be the \
             silent refusal of sparkle-zviq"
        );

        gate.release();
        assert!(
            reader.join().expect("reader thread"),
            "and once resolution lands, the dropped file must be readable"
        );
    }

    /// THE OTHER DIRECTION, and the one an earlier draft of this change got wrong. Making the read
    /// wait only when the registry says "no" looks like a harmless fast path and is not: a `Leave` or
    /// a window teardown is a REVOCATION queued behind the `Enter` whose entries it revokes, so a
    /// read that consults the registry first finds the hover STILL PRESENT and answers `true` without
    /// ever waiting — granting a path for a drag that has already left the window.
    ///
    /// That draft passed every filtered run and only reddened two existing tier tests under
    /// full-suite load, where the worker lags behind the test thread. Luck is not a guard, so this
    /// pins it deterministically: the revocation is held behind a resolution that is blocked on
    /// command, and the read must still come back refused.
    #[test]
    fn a_revocation_still_queued_is_not_raced_by_a_read() {
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let hovered = outside.join("already-left.txt");
        let blocker = outside.join("blocks-the-worker.txt");
        touch(&hovered);
        touch(&blocker);
        let roots: Vec<PathBuf> = vec![];

        // 1. An ordinary hover, fully registered — the grant really is in the registry.
        note_window_event("race-window", &enter_event(vec![hovered.clone()]));
        assert!(
            validate_read_path(&hovered, &roots).is_ok(),
            "precondition: the hover is granted and applied"
        );

        // 2. Wedge the worker inside a resolution for an UNRELATED window, so whatever is queued
        //    behind it cannot be applied. A different label, so it does not disturb the hover above.
        let gate = ResolverGate::new();
        let installed = ResolverOverride::install(gate.resolver());
        note_window_event("race-blocker", &enter_event(vec![blocker]));
        assert!(gate.wait_entered(1), "the worker is now blocked inside a resolution");

        // 3. The drag leaves. The revocation is queued BEHIND the blocked resolution, so right now
        //    the registry still holds the grant from step 1.
        note_window_event("race-window", &leave_event());

        // 4. Release on a timer, so the read below is the thing that has to wait.
        let releaser = {
            let gate = gate.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                gate.release();
            })
        };

        assert!(
            validate_read_path(&hovered, &roots).is_err(),
            "a read must not be answered from a registry that has not yet applied the Leave it was \
             already told about — that grants a path for a drag which has already left"
        );

        releaser.join().expect("releaser thread");
        drop(installed);
    }

    /// THE SAME REVOCATION, PAST THE DEADLINE — the branch the test above never reaches.
    ///
    /// `a_revocation_still_queued_is_not_raced_by_a_read` releases the wedge after 150 ms, so it only
    /// ever exercises the wait SUCCEEDING. The interesting case is the wait giving up: `RESOLVE_WAIT`
    /// is 30 s while `PROVISIONAL_TTL` is 60, so a worker wedged inside `canonicalize` for longer
    /// than the budget leaves a hover whose `Forget` is queued behind the wedge and unapplied, while
    /// the entry itself is still comfortably inside its TTL. The pre-fix `await_pending_registrations`
    /// returned `()` and simply broke out of its loop, so the read could not tell "everything
    /// applied" from "gave up with a revocation still queued" — and answered from the stale registry,
    /// granting a path for a drag that had already left the window.
    ///
    /// The assertion is the SIDE EFFECT: the read comes back REFUSED. Reverting the wait to `()` (or
    /// consulting `contains` instead of `contains_durable` on timeout) fails it.
    #[test]
    fn a_read_that_times_out_with_a_revocation_still_queued_refuses_the_hover() {
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let hovered = outside.join("left-while-the-worker-was-wedged.txt");
        let blocker = outside.join("wedges-the-worker.txt");
        touch(&hovered);
        touch(&blocker);
        let roots: Vec<PathBuf> = vec![];

        // 1. An ordinary hover, fully applied — the grant really is in the registry.
        note_window_event("deadline-window", &enter_event(vec![hovered.clone()]));
        assert!(
            validate_read_path(&hovered, &roots).is_ok(),
            "precondition: the hover is granted and applied"
        );

        // 2. Wedge the worker inside a resolution for an UNRELATED window, so whatever is queued
        //    behind it cannot be applied.
        let gate = ResolverGate::new();
        let installed = ResolverOverride::install(gate.resolver());
        note_window_event("deadline-blocker", &enter_event(vec![blocker]));
        assert!(gate.wait_entered(1), "the worker is now wedged inside a resolution");

        // 3. The drag leaves. The revocation is queued BEHIND the wedge, so the registry still holds
        //    the grant from step 1 — and will for as long as the wedge lasts.
        note_window_event("deadline-window", &leave_event());

        // 4. And unlike the test above, NOTHING releases the wedge. The read must cross its deadline.
        let _short = ResolveWaitOverride::install(Duration::from_millis(80));
        assert!(
            validate_read_path(&hovered, &roots).is_err(),
            "a read whose wait TIMED OUT must not be answered from the provisional tier — the \
             registry it would consult is known to be missing a Leave it was already told about, \
             and PROVISIONAL_TTL outlives RESOLVE_WAIT by 30 seconds"
        );
        assert!(
            !gate.is_released(),
            "and the revocation really was still queued while that answer was given"
        );

        gate.release();
        drop(installed);
    }

    /// THE PAIR, and the reason the fix is tiered rather than a blanket refusal. One test showing a
    /// timed-out read says "no" is ambiguous — a read that always says "no" would pass it while
    /// restoring bead `sparkle-zviq`'s silent refusal for every attachment in the app whenever any
    /// unrelated drag wedges the worker.
    ///
    /// Durable consent is the tier a stale registry cannot OVER-report: nothing queued revokes it
    /// (`Forget` touches `provisional` alone, `note_chosen` only adds), so a file the user really
    /// dropped or picked stays downloadable through a wedge. Making `is_user_chosen` return a bare
    /// `false` on timeout fails this.
    #[test]
    fn a_read_that_times_out_still_honours_consent_the_user_actually_gave() {
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let dropped = outside.join("really-dropped.txt");
        let blocker = outside.join("wedges-the-worker-too.txt");
        touch(&dropped);
        touch(&blocker);
        let roots: Vec<PathBuf> = vec![];

        note_window_event("durable-deadline-window", &drop_event(vec![dropped.clone()]));
        assert!(
            validate_read_path(&dropped, &roots).is_ok(),
            "precondition: the drop is registered"
        );

        let gate = ResolverGate::new();
        let installed = ResolverOverride::install(gate.resolver());
        note_window_event("durable-deadline-blocker", &enter_event(vec![blocker]));
        assert!(gate.wait_entered(1), "the worker is wedged");

        let _short = ResolveWaitOverride::install(Duration::from_millis(80));
        assert!(
            validate_read_path(&dropped, &roots).is_ok(),
            "a wedged worker must not revoke consent the user actually gave — refusing here is the \
             silent refusal of sparkle-zviq under a new trigger"
        );
        assert!(!gate.is_released(), "and it really was still wedged");

        gate.release();
        drop(installed);
    }

    /// THE BATCH HALF of the same finding. The read-ordering wait is bounded at 30 s so one wedged
    /// `canonicalize` cannot pin a blocking-pool thread forever — but a batch command re-paying that
    /// bound PER PATH turns the bound back into an unbounded wait: 50 non-contained srcs is ~25
    /// minutes on one thread, with nothing to cancel it, while the queue being waited on has not
    /// moved since the first path.
    ///
    /// TIME IS THE ASSERTION HERE, deliberately: both the fixed and the per-path forms refuse all
    /// these paths, so the only thing that separates them is how long the command occupies its
    /// thread. Restoring `validate_read_path` inside the loop makes this take `N` budgets instead of
    /// one and fails it.
    #[test]
    fn a_batch_copy_pays_the_read_budget_once_not_once_per_path() {
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let dest = fresh_root();
        let blocker = outside.join("wedges-the-batch.txt");
        touch(&blocker);
        // Only the destination is an allowed root, so every src must go through provenance — which
        // is the path that waits.
        let roots = vec![dest.clone()];

        const PATHS: usize = 20;
        const BUDGET: Duration = Duration::from_millis(150);
        let srcs: Vec<String> = (0..PATHS)
            .map(|n| {
                let f = outside.join(format!("batch-{n}.txt"));
                touch(&f);
                f.to_string_lossy().into_owned()
            })
            .collect();

        let gate = ResolverGate::new();
        let installed = ResolverOverride::install(gate.resolver());
        note_window_event("batch-blocker", &enter_event(vec![blocker]));
        assert!(gate.wait_entered(1), "the worker is wedged, so every read must wait its budget out");

        let _short = ResolveWaitOverride::install(BUDGET);
        let t0 = Instant::now();
        let err = copy_files_to_dir_blocking(&srcs, dest.to_str().unwrap(), &roots)
            .expect_err("no src was ever granted, so every one must be refused");
        let elapsed = t0.elapsed();

        assert_eq!(
            err.matches("refusing to read a path outside allowed directories").count(),
            PATHS,
            "precondition: every src really did reach the provenance check"
        );
        // GENEROUS ON PURPOSE. The amortised form spends ~1 budget and the per-path form spends 20,
        // so the discriminating gap is 20:1 and the bound only has to sit somewhere in between.
        // It used to be `BUDGET * 4` — 600 ms, leaving ~450 ms for 20 `canonicalize` calls, 20
        // registry-lock acquisitions, the condvar's `wait_timeout` overshoot and scheduling on a
        // shared CI pool. That is the shape that produces CI-red/local-green flakes here, and it
        // bought nothing: the mutant it must kill is 3 s away, five times further out than the
        // bound needs to be (roborev 67513).
        assert!(
            elapsed < BUDGET * 8,
            "a {PATHS}-path batch must pay the read-ordering budget ONCE, not once per path — it \
             took {elapsed:?} against a budget of {BUDGET:?}"
        );

        gate.release();
        drop(installed);
    }

    /// THE ACCUMULATOR, not a deadline (roborev 67513).
    ///
    /// This is the half of the batch amortisation that `a_batch_copy_pays_the_read_budget_once…`
    /// cannot see: that test proves the batch does not pay N budgets, and a plain deadline stamped
    /// at the first check passes it just as well. What a deadline gets wrong is everything that
    /// happens BETWEEN the checks — in the real command, `std::fs::copy` of a multi-GB file. Under a
    /// deadline the copy burns the budget, so every later src arrives with zero left, waits no time
    /// at all, and is answered from durable consent alone — refused mid-batch for a reason that has
    /// nothing to do with it, where the pre-amortisation code would have waited and granted it.
    ///
    /// So the discriminator is: spend real time NOT waiting, then check that the next read is still
    /// offered its budget. Asserting on `offered` is the direct statement of the invariant; the
    /// elapsed check beside it proves the offer was real rather than a number nothing spends.
    #[test]
    fn the_batch_budget_charges_time_spent_waiting_and_not_time_spent_between_reads() {
        let _serialized = global_drag_lock();
        const BUDGET: Duration = Duration::from_millis(300);
        let _short = ResolveWaitOverride::install(BUDGET);

        let mut order = ReadOrder::new();
        // Nothing is queued yet, so this read drains at once and spends ~nothing of the budget.
        let first = order.order();
        assert!(first.drained, "precondition: nothing is outstanding, so the first read drains");
        assert!(!first.first_failure, "a drained read is not a failure and must not log");

        // THE WORK THAT IS NOT A WAIT — the copy, in production. Twice the whole budget of it.
        std::thread::sleep(BUDGET * 2);

        // Now wedge the worker, so the next read has something real to wait for.
        let outside = fresh_root();
        let blocker = outside.join("wedges-the-accumulator.txt");
        touch(&blocker);
        let gate = ResolverGate::new();
        let installed = ResolverOverride::install(gate.resolver());
        note_window_event("budget-accumulator", &enter_event(vec![blocker]));
        assert!(gate.wait_entered(1), "precondition: the worker is wedged, so this read must wait");

        let t0 = Instant::now();
        let second = order.order();
        let waited = t0.elapsed();

        assert!(!second.drained, "the worker is wedged, so this read cannot drain");
        // THE INVARIANT. Under a deadline this would be ~zero: the sleep above would have consumed
        // it. Nine tenths rather than the whole, because the first read's own lock acquisition is
        // legitimately charged.
        assert!(
            second.offered >= BUDGET * 9 / 10,
            "time spent between reads must not be charged to the read budget — this read was \
             offered {:?} of a {BUDGET:?} budget",
            second.offered
        );
        // …and the offer was spent, not merely quoted.
        assert!(
            waited >= BUDGET / 2,
            "the read must actually have waited on the wedged worker, not returned at once — it \
             took {waited:?}"
        );
        assert!(second.first_failure, "the first exhausted read in a batch is the one that logs");

        // ONE WEDGE IS ONE EVENT. A later path in the same batch must not repeat the line — twenty
        // identical warnings for one wedged worker is the noise this flag exists to prevent.
        let third = order.order();
        assert!(!third.drained, "still wedged");
        assert!(!third.first_failure, "only the first exhausted read in a batch logs");

        gate.release();
        drop(installed);
    }

    /// A POISONED REGISTRY IS RECOVERED, NOT ABANDONED (roborev 67722).
    ///
    /// The old shape took the registry as `if let Ok(mut c) = chosen().lock()` in all four writers
    /// and `.map(…).unwrap_or(false)` in the reader, so ONE panic inside the critical section
    /// silently discarded every later registration and answered every later read `false`, for the
    /// life of the process — with the worker looping cheerfully and `outstanding` draining normally,
    /// so none of the worker supervision notices. Permanent, silent, and precisely the class the
    /// firewall was added to remove.
    ///
    /// The existing panic test cannot see it: it panics inside the injected RESOLVER, which runs
    /// before `chosen().lock()` is ever taken, so the lock is never poisoned. This poisons it
    /// directly — the only way to reach the state without an injection seam inside `Chosen` — and
    /// then asserts the SIDE EFFECT a user would notice: a drop made afterwards is still readable.
    ///
    /// THE POISONING IS PERMANENT FOR THE REST OF THE BINARY, and that is deliberate rather than
    /// sloppy: a `Mutex` cannot be un-poisoned. It is safe here precisely BECAUSE of the fix under
    /// test — every production path now goes through `chosen_locked`, which recovers — so every
    /// later test sees the same behaviour it would have seen anyway. If a future test ever needs an
    /// unpoisoned registry it will have to take a lock through `chosen()` directly, and this comment
    /// is the reason it cannot. That is a strictly better failure than the silent one it replaces.
    #[test]
    fn a_poisoned_registry_still_registers_and_answers_a_later_drop() {
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let after = outside.join("dropped-after-the-poisoning.txt");
        touch(&after);
        let roots: Vec<PathBuf> = vec![];

        // POISON IT. A panic while the guard is held is what a panic inside `note_dragged` would do.
        let poisoned = std::thread::spawn(|| {
            let _suppress = crate::crash::suppress_crash_records();
            let _guard = chosen().lock().expect("the registry is not poisoned yet");
            panic!("a panic inside the registry's critical section");
        })
        .join();
        assert!(poisoned.is_err(), "precondition: the panicking thread really did unwind");
        assert!(
            chosen().lock().is_err(),
            "precondition: the registry mutex really is poisoned now — if this ever stops being \
             true the test below is asserting nothing"
        );

        // THE SIDE EFFECT. Under the old shape this drop was discarded by every writer and the read
        // answered `false`; nothing in the log or the queue would have said so.
        note_window_event("poisoned-registry", &drop_event(vec![after.clone()]));
        assert!(
            await_pending_registrations(Duration::from_secs(10)),
            "the worker must still drain — poisoning the registry must not wedge the queue"
        );
        assert!(
            validate_read_path(&after, &roots).is_ok(),
            "a path the user dropped AFTER the registry was poisoned must still be readable — \
             propagating the poison turns one panic into a permanent, silent loss of the feature"
        );
    }

    /// THE DEFAULTED-SEAM GUARD for the read budget (AGENTS.md: "a defaulted seam every test
    /// injects"). Every deadline test above installs a millisecond budget, so without this the
    /// production value would be pinned by nothing and could be set to zero — which would make every
    /// read answer from durable consent alone and silently drop the provisional tier the drag path
    /// depends on.
    ///
    /// It also records the asymmetry that makes the timeout branch reachable at all: the budget is
    /// SHORTER than `PROVISIONAL_TTL`, so a hover can outlive the wait meant to order a read after
    /// its revocation. That is the whole mechanism of the finding, not an incidental constant.
    #[test]
    fn the_production_read_budget_is_the_shipping_constant() {
        let _serialized = global_drag_lock();
        assert!(
            resolve_wait_override().lock().unwrap_or_else(|e| e.into_inner()).is_none(),
            "precondition: no override installed, so this IS the shipping wiring"
        );
        assert_eq!(resolve_wait(), RESOLVE_WAIT, "the production budget must be the constant");
        assert!(
            RESOLVE_WAIT >= Duration::from_secs(10),
            "a short budget would refuse real drops that are merely slow to canonicalize"
        );
        assert!(
            RESOLVE_WAIT < PROVISIONAL_TTL,
            "the budget is deliberately shorter than the hover TTL, which is exactly why a timed-out \
             read can meet a still-live provisional entry whose Forget is unapplied"
        );
    }

    // ── Supervising the resolution worker ───────────────────────────────────────────────────────
    //
    // Two independent holes, both silent and both PERMANENT, and the symptom of either gives no hint
    // of its cause: `enqueue` keeps succeeding on the main thread, `outstanding` never drains, every
    // registration is dropped on the floor, and every non-contained read spends its whole budget
    // before refusing. Which is to say the feature is off, for the life of the process, with the
    // drag path looking exactly as it does when a path was simply never granted.

    /// Fakes the worker spawn for the life of the guard.
    ///
    /// Restoring `RESOLVE_WORKER_RUNNING` to what it was — rather than to `false` — is load-bearing:
    /// a stray `false` would let the next `enqueue` start a SECOND real worker beside the one already
    /// running, and one FIFO worker is what makes the applied order the delivered order for every
    /// tier rule in `Chosen`. Two would let a `Leave` overtake the `Enter` it revokes.
    struct WorkerSpawnerOverride {
        was_running: bool,
    }

    impl WorkerSpawnerOverride {
        fn install(f: WorkerSpawner) -> Self {
            let was_running = RESOLVE_WORKER_RUNNING.swap(false, Ordering::SeqCst);
            *spawner_override().lock().unwrap_or_else(|e| e.into_inner()) = Some(f);
            WorkerSpawnerOverride { was_running }
        }
    }

    impl Drop for WorkerSpawnerOverride {
        fn drop(&mut self) {
            *spawner_override().lock().unwrap_or_else(|e| e.into_inner()) = None;
            RESOLVE_WORKER_RUNNING.store(self.was_running, Ordering::SeqCst);
        }
    }

    /// THE ONCE-CELL HOLE. `STARTED.get_or_init(|| { let _ = …spawn(…); })` completes the cell
    /// whether or not the spawn inside it succeeded, so a single `EAGAIN` — thread pressure, which
    /// is exactly the loaded state a drag stall gets reported from — silently disabled path
    /// resolution for the life of the process.
    ///
    /// The assertion is the OBSERVABLE CONSEQUENCE, driven through the real entry point Tauri calls:
    /// a LATER drag event tries again. Restoring the `OnceLock` (or setting the flag before checking
    /// the spawn's result) leaves the retry count stuck at 1 and fails this.
    #[test]
    fn a_worker_spawn_that_fails_is_retried_by_the_next_drag_event() {
        let _serialized = global_drag_lock();

        // The REAL worker must be alive and draining before we start faking spawns — the ops this
        // test enqueues still have to be applied by someone, and a ticket left outstanding would
        // make every later read in the suite spend its whole budget.
        note_window_event("spawn-probe-warmup", &leave_event());
        assert!(
            await_pending_registrations(Duration::from_secs(10)),
            "precondition: a live worker is draining the queue"
        );

        let attempts = std::sync::Arc::new(AtomicUsize::new(0));
        let succeed_from = std::sync::Arc::new(AtomicUsize::new(usize::MAX));
        let spawner: WorkerSpawner = {
            let attempts = std::sync::Arc::clone(&attempts);
            let succeed_from = std::sync::Arc::clone(&succeed_from);
            std::sync::Arc::new(move || {
                let n = attempts.fetch_add(1, Ordering::SeqCst) + 1;
                if n >= succeed_from.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err(std::io::Error::other("simulated EAGAIN under thread pressure"))
                }
            })
        };
        let _faked = WorkerSpawnerOverride::install(spawner);

        note_window_event("spawn-retry-probe", &leave_event());
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            1,
            "the first drag event after the worker is gone must try to start one"
        );
        assert!(
            !RESOLVE_WORKER_RUNNING.load(Ordering::SeqCst),
            "a spawn that FAILED must not be recorded as a live worker — that is the once-cell bug"
        );

        note_window_event("spawn-retry-probe", &leave_event());
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            2,
            "and the next drag event must RETRY — one EAGAIN cannot be allowed to disable drag path \
             resolution for the life of the process"
        );

        // Now let a spawn succeed, and the retrying must stop: two live workers would break the FIFO
        // ordering every tier rule in `Chosen` depends on.
        succeed_from.store(3, Ordering::SeqCst);
        note_window_event("spawn-retry-probe", &leave_event());
        assert_eq!(attempts.load(Ordering::SeqCst), 3, "the third attempt is the one that succeeds");
        assert!(
            RESOLVE_WORKER_RUNNING.load(Ordering::SeqCst),
            "a spawn that SUCCEEDED is recorded"
        );

        note_window_event("spawn-retry-probe", &leave_event());
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            3,
            "and a running worker is never re-spawned — one FIFO worker is what makes the applied \
             order the delivered order"
        );
    }

    /// THE OTHER HALF OF THE UNWIND HOLE. If the worker ever leaves its loop the flag must come back
    /// down, or `ensure_resolve_worker` declines to start a replacement for the life of the process —
    /// the same permanent silence as the once-cell bug, reached by a different route.
    ///
    /// This pins the GUARD, not its installation. `resolve_worker`'s only remaining unwind path is
    /// its queue lock / condvar wait (`apply_registry_op` is caught), and there is no way to panic
    /// those from outside without standing a SECOND worker up beside the live one, which would break
    /// the FIFO ordering every tier rule in `Chosen` depends on. The rest of the chain is covered:
    /// `a_worker_spawn_that_fails_is_retried_by_the_next_drag_event` proves a cleared flag really
    /// does bring the next drag event back to `spawn_resolve_worker`.
    #[test]
    fn a_worker_that_leaves_its_loop_clears_the_flag_so_a_replacement_can_start() {
        let _serialized = global_drag_lock();
        let was_running = RESOLVE_WORKER_RUNNING.swap(true, Ordering::SeqCst);
        drop(WorkerLiveness);
        let cleared = !RESOLVE_WORKER_RUNNING.load(Ordering::SeqCst);
        RESOLVE_WORKER_RUNNING.store(was_running, Ordering::SeqCst);
        assert!(
            cleared,
            "a worker that unwound out of its loop must leave the flag DOWN — otherwise the queue is \
             unattended forever and every read pays its whole budget before refusing"
        );
    }

    /// THE INSTALLATION, not just the guard (roborev 67722).
    ///
    /// The test above constructs and drops a `WorkerLiveness` by hand, so it pins `Drop` and nothing
    /// else: delete the guard's binding from the worker — or, far likelier, rewrite it as
    /// `let _ = WorkerLiveness`, which drops it IMMEDIATELY — and it stays green while the worker
    /// runs unsupervised with the flag stuck `true` forever. That is the "guard tested against a
    /// copy of its mechanism" shape AGENTS.md names.
    ///
    /// This drives the real installation seam instead. `guarded_by_liveness` is what `resolve_worker`
    /// calls, so a body that unwinds through it exercises exactly the path a panicking worker takes —
    /// on a thread of its own, with no second worker ever attached to the queue (which would break
    /// FIFO, and is the reason the test above settled for the weaker form).
    #[test]
    fn a_panic_inside_the_guarded_body_clears_the_flag() {
        let _serialized = global_drag_lock();
        let was_running = RESOLVE_WORKER_RUNNING.swap(true, Ordering::SeqCst);

        let joined = std::thread::spawn(|| {
            let _suppress = crate::crash::suppress_crash_records();
            guarded_by_liveness(|| panic!("the worker unwound out of its loop"));
        })
        .join();

        let cleared = !RESOLVE_WORKER_RUNNING.load(Ordering::SeqCst);
        RESOLVE_WORKER_RUNNING.store(was_running, Ordering::SeqCst);

        assert!(joined.is_err(), "precondition: the body really did unwind");
        assert!(
            cleared,
            "the liveness guard must be INSTALLED for the whole body, not merely defined — a worker \
             that unwinds has to leave the flag DOWN so the next enqueue starts a replacement"
        );
    }

    /// THE DEFAULTED-SEAM GUARD for the spawn seam (AGENTS.md). The test above injects a spawner, so
    /// without this the `None` arm — the only thing that puts a real thread behind the queue — would
    /// be pinned only indirectly.
    ///
    /// The assertion is that the queue actually DRAINS, which nothing but a live worker thread can
    /// do: an arm that never spawned would leave the ticket outstanding until the wait gave up.
    #[test]
    fn the_production_default_spawner_starts_the_real_resolve_worker() {
        let _serialized = global_drag_lock();
        assert!(
            spawner_override().lock().unwrap_or_else(|e| e.into_inner()).is_none(),
            "precondition: no override installed, so this IS the shipping wiring"
        );
        // AND THE FLAG MUST BE DOWN, or this test proves nothing (roborev 67722).
        //
        // `RESOLVE_WORKER_RUNNING` is a process-global that stays `true` once ANY earlier drag test
        // in this binary has started the worker — `WorkerSpawnerOverride` restores `was_running`, so
        // it is never left down. With it already up, `ensure_resolve_worker`'s
        // `if RESOLVE_WORKER_RUNNING.swap(true) { return; }` returns before `spawn_resolve_worker` is
        // reached, the `None` arm this test exists to pin never executes, the drain below is
        // performed by some other test's worker, and the flag assertion at the end is satisfied by
        // the stale flag. Every assertion passes and nothing was tested.
        //
        // Claimed as a PRECONDITION rather than forced down, because forcing it would let a second
        // worker attach to the same queue and break FIFO. Under `cargo test`'s parallel harness the
        // ordering is not deterministic, so this may skip — but it fails LOUDLY when it cannot
        // establish what it needs, instead of passing while measuring another test's worker.
        if RESOLVE_WORKER_RUNNING.load(Ordering::SeqCst) {
            eprintln!(
                "the_production_default_spawner_starts_the_real_resolve_worker: SKIPPED — a worker \
                 was already running, so the None arm cannot be reached from here. Run this test \
                 alone (--test-threads=1, or by name) to exercise it."
            );
            return;
        }

        note_window_event("default-spawner-probe", &leave_event());
        assert!(
            await_pending_registrations(Duration::from_secs(10)),
            "with nothing injected, a drag event must put a real thread behind the queue and that \
             thread must apply what was queued"
        );
        assert!(
            RESOLVE_WORKER_RUNNING.load(Ordering::SeqCst),
            "and the successful spawn is recorded, so the next event does not start a second one"
        );
    }

    /// THE UNWIND HOLE. `apply_registry_op` does unbounded filesystem work; if it ever panicked the
    /// whole worker went with it and NOTHING restarted it. The ticket it was holding then stayed in
    /// `outstanding` forever, so every subsequent attachment read spent its full budget waiting for
    /// a ticket nobody would ever retire — one panic converting the entire feature into a slow
    /// refusal, permanently.
    ///
    /// Two side effects, and both are needed: the panicking op's ticket DRAINS (so reads stop
    /// waiting on it), and a LATER drop still registers (so the worker survived). Removing the
    /// `catch_unwind` fails both — the first takes the full 10s wait before it does.
    #[test]
    fn a_panicking_resolution_drains_its_ticket_and_the_worker_survives() {
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let after = outside.join("registered-after-the-panic.txt");
        touch(&after);
        let roots: Vec<PathBuf> = vec![];

        {
            let panics = std::sync::Arc::new(AtomicUsize::new(0));
            let counted = std::sync::Arc::clone(&panics);
            let _installed = ResolverOverride::install(std::sync::Arc::new(move |_paths| {
                counted.fetch_add(1, Ordering::SeqCst);
                panic!("simulated panic inside path resolution");
            }));

            note_window_event("panic-window", &enter_event(vec![outside.join("boom.txt")]));
            assert!(
                await_pending_registrations(Duration::from_secs(10)),
                "a panicking resolution must still DRAIN its ticket — otherwise every later read \
                 spends its whole budget waiting for a ticket nothing will ever retire"
            );
            assert_eq!(
                panics.load(Ordering::SeqCst),
                1,
                "precondition: the resolution really did panic"
            );
        }

        // ...and the worker is still there to apply what comes next.
        note_window_event("panic-window", &drop_event(vec![after.clone()]));
        assert!(
            validate_read_path(&after, &roots).is_ok(),
            "one panic must not stop the worker — a drop after it must still register"
        );
    }

    /// THE DEFAULTED-SEAM GUARD (AGENTS.md: "a defaulted seam every test injects"). Every test above
    /// installs its own resolver, so without this one the `None` arm of `resolve_paths` — the only
    /// thing that makes a real drag register real canonical paths — would be covered by nothing and
    /// could be deleted with the whole suite still green.
    ///
    /// It also re-pins the security property from the other side: resolving on the way IN is what
    /// closes the symlink-swap window, so the default must resolve the LINK to its TARGET.
    #[test]
    fn the_production_default_resolver_really_canonicalizes() {
        let _serialized = global_drag_lock();
        assert!(
            resolver_override().lock().unwrap_or_else(|e| e.into_inner()).is_none(),
            "precondition: no override installed, so this IS the shipping wiring"
        );

        let dir = fresh_root();
        let target = dir.join("innocent.txt");
        touch(&target);
        let link = dir.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let got = resolve_paths(vec![link.clone()]);
        assert_eq!(
            got,
            vec![target.canonicalize().unwrap()],
            "the production default must be the REAL canonicalize"
        );
        assert_ne!(
            got,
            vec![link],
            "a default that echoed its input back would reopen the symlink-swap window"
        );
    }

    /// THE ORDERING HAZARD the inline version could not have had. `Leave` must revoke the hover
    /// `Enter` registered — but `Enter` now resolves on a worker. If `Leave` were applied
    /// immediately while a slow `Enter` was still resolving, the Enter would install its provisional
    /// grant AFTER the Leave meant to revoke it: a hover grant left standing for a drag that has
    /// already left, which is precisely what the provisional tier exists to deny (a file dragged
    /// PAST Sparkle en route to another app).
    ///
    /// One FIFO worker is what makes the applied order the delivered order. Applying `Forget`
    /// synchronously instead of queueing it fails this.
    #[test]
    fn a_leave_cannot_overtake_the_enter_it_revokes() {
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let f = outside.join("passing-through.txt");
        touch(&f);

        let gate = ResolverGate::new();
        let _installed = ResolverOverride::install(gate.resolver());

        note_window_event("ordering-window", &enter_event(vec![f.clone()]));
        assert!(gate.wait_entered(1), "the Enter's resolution is in flight");

        // The drag leaves WHILE that resolution is still outstanding.
        note_window_event("ordering-window", &leave_event());
        gate.release();

        let roots: Vec<PathBuf> = vec![];
        assert!(
            validate_read_path(&f, &roots).is_err(),
            "a drag that left without dropping must leave NO grant behind, even when its Enter was \
             still resolving as the Leave arrived"
        );
    }

    /// INVARIANT 5: the recent-drop marker is cheap, lock-only, and must STAY on the calling thread.
    /// The frontend's drop handler can call `recover_drag_paths` before this listener has finished,
    /// so a marker deferred behind path resolution could not be there in time — which would reopen
    /// the very race that marking on Enter/Over exists to win.
    ///
    /// Pins that the marker is already there while resolution is demonstrably STILL outstanding.
    /// Moving `mark_recent_drop` onto the resolution worker fails this.
    #[test]
    fn the_recent_drop_marker_is_set_before_note_window_event_returns() {
        let _serialized = global_drag_lock();
        let outside = fresh_root();
        let f = outside.join("marker-first.txt");
        touch(&f);

        let gate = ResolverGate::new();
        let _installed = ResolverOverride::install(gate.resolver());

        note_window_event("marker-first-window", &drop_event(vec![f.clone()]));
        assert!(gate.wait_entered(1), "resolution is under way");
        assert!(!gate.is_released(), "precondition: and it has NOT finished");

        assert!(
            take_recent_drop("marker-first-window"),
            "the recent-drop marker must already exist while path resolution is still outstanding"
        );

        gate.release();
    }

    /// The instrumentation's log vocabulary. This log ships with support tickets (see the note in
    /// `note_drag_event`), so the fields the watcher emits must be structurally incapable of
    /// carrying a path: a fixed phase token and a COUNT.
    #[test]
    fn the_logged_drag_phase_is_a_closed_vocabulary_and_paths_are_only_counted() {
        let secret = PathBuf::from("/Users/someone/Secret Plans.pdf");

        let dropped = tauri::DragDropEvent::Drop {
            paths: vec![secret.clone(), secret.clone()],
            position: drag_position(),
        };
        assert_eq!(drag_phase_name(&dropped), "drop");
        assert_eq!(drag_path_count(&dropped), 2, "a COUNT — never the paths themselves");

        let entered = tauri::DragDropEvent::Enter {
            paths: vec![secret],
            position: drag_position(),
        };
        assert_eq!(drag_phase_name(&entered), "enter");
        assert_eq!(drag_path_count(&entered), 1);

        let over = tauri::DragDropEvent::Over { position: drag_position() };
        assert_eq!(drag_phase_name(&over), "over");
        assert_eq!(drag_path_count(&over), 0);

        assert_eq!(drag_phase_name(&tauri::DragDropEvent::Leave), "leave");
        assert_eq!(drag_path_count(&tauri::DragDropEvent::Leave), 0);
    }

    #[test]
    fn read_still_rejects_a_neighbour_of_a_user_chosen_path() {
        // Choosing one file must not open its directory: the registry admits exactly the paths the
        // OS named, so a compromised webview can't walk from a dragged file to its siblings.
        let _serialized = global_drag_lock();
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
        let _serialized = global_drag_lock();
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

    // ── probe_attachment ────────────────────────────────────────────────────────────────────
    //
    // The probe's whole job is to hand back facts about the RESOLVED path. `load_attachment` echoes
    // the path it was given, which is exactly the string a symlink lies with — so the assertion
    // that matters is that a link is followed, not merely that a stat succeeded.

    #[test]
    fn probe_reports_the_resolved_target_of_a_symlink() {
        let root = fresh_root(); // under the temp dir, which is an allowed root
        let real = root.join("real.txt");
        std::fs::write(&real, b"twelve bytes").unwrap();
        let link = root.join("link.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let got = probe_blocking(link.to_str().unwrap()).unwrap();
        assert_eq!(got.real_path, real.canonicalize().unwrap().to_string_lossy());
        assert_eq!(got.size, 12);
        assert!(got.is_file);
    }

    #[test]
    fn probe_marks_a_directory_as_not_a_file() {
        let root = fresh_root();
        let dir = root.join("sub");
        std::fs::create_dir_all(&dir).unwrap();
        let got = probe_blocking(dir.to_str().unwrap()).unwrap();
        assert!(!got.is_file);
    }

    #[test]
    fn probe_refuses_a_path_it_cannot_reach() {
        let root = fresh_root();
        let missing = root.join("nope.txt");
        assert!(probe_blocking(missing.to_str().unwrap()).is_err());
    }
}
