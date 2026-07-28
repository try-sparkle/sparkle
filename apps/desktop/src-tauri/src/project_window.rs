//! Satellite project windows — a project tab torn out of the main window onto another monitor.
//!
//! A satellite is NOT a second copy of the app. It renders columns ② + ③ only (the Build agent
//! sidebar and the terminal) for exactly one project: no concierge, no tab strip, no control
//! listener. That constraint is the whole design. Bead `sparkle-qd80` deleted the old multi-window
//! era because a peer window "would get its own store copy, its own concierge and a second control
//! listener" (commit a363abed); a satellite avoids all three by construction rather than by care.
//!
//! Two deliberate choices, both of which keep the ACL surface from regrowing:
//!
//! 1. **Rust builds and moves these windows; the frontend never does.** This is the helper-island
//!    precedent (`helper.rs`). It is why `core:window:allow-set-position` / `allow-set-size` /
//!    `allow-close` — retired as attack surface in commit af7529a6, with a RETIRED_PERMISSIONS
//!    guard in windowCapabilities.test.ts — do NOT have to come back.
//! 2. **A fixed label pool, not a `win-*` glob.** In Tauri v2 a window whose label matches no
//!    capability entry gets ZERO permissions — `invoke` and `event.listen` fail silently at
//!    runtime, invisible to typecheck and to any test that mocks `@tauri-apps/api`. The old glob
//!    was removed with the purge and its absence is asserted. Four explicit labels keep that
//!    assertion true and cap satellites at four, which is plenty for a multi-monitor desk.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Every label a satellite may ever use. MUST stay in lockstep with the `windows` list in
/// `capabilities/default.json` — a label missing there yields a permission-less window that fails
/// only at runtime. `windowCapabilities.test.ts` pins both sides together.
pub const POOL: [&str; 4] = ["project-1", "project-2", "project-3", "project-4"];

const DEFAULT_W: f64 = 1000.0;
const DEFAULT_H: f64 = 720.0;

/// One `bool` per pool slot: is it RESERVED by an in-flight claim? See `ALLOC`.
pub type Slots = Mutex<[bool; POOL.len()]>;

/// The process-wide reservation set — the allocator's exclusion mechanism.
///
/// THREADING, and read this before changing anything here. An earlier version of this module
/// asserted "Tauri v2 runs command handlers off the main thread". That is FALSE for a plain
/// `#[tauri::command]`: `tauri-macros`'s wrapper defaults to `ExecutionContext::Blocking` and
/// generates the `"sync"` kind, whose body runs INLINE on the thread delivering the IPC — on macOS,
/// the main/event-loop thread.
///
/// `#[tauri::command(async)]` on a sync fn is NOT the fix, though it looks like one: its
/// `"sync_threadpool"` label (`wrapper.rs:264`) is only a tracing field, and `body_async` calls the
/// sync body inside `async move {}` handed to `tokio::spawn` — so the wait leaves the event loop
/// only to park a worker shared with every other async command. So every command here that waits is
/// an `async fn` whose blocking half goes through `tauri::async_runtime::spawn_blocking`, exactly as
/// `folder_picker.rs` and `dictation.rs` do. `the_waiting_commands_run_off_the_event_loop_thread_
/// and_off_the_async_workers` pins BOTH halves and fails if either is lost.
///
/// That matters because `WebviewWindow::destroy()` ALWAYS posts to the event loop
/// (`tauri-runtime-wry` uses `proxy.send_event`, and handling `WindowMessage::Destroy` on the main
/// thread is an outright `panic!`). The window leaves the manager only when that loop drains the
/// message. So anything that waits for a destroy, on the loop's own thread, blocks the very thing
/// it is waiting for. `folder_picker.rs` states the general rule — "blocking the main thread while
/// waiting on the main thread is a self-deadlock" — and `capture_window.rs` puts its retry loop on
/// a spawned thread for exactly this reason.
///
/// WHY A RESERVATION SET RATHER THAN A LOCK HELD ACROSS THE BUILD. The scan is only meaningful if
/// nothing else can take the slot between it and our build, but `build()` from a non-main thread
/// dispatches window creation to the event loop and BLOCKS on it. Holding a blocking mutex across
/// that means one stalled event loop serializes every tear-off in the process, and a main-thread
/// claimer would deadlock against an off-main holder outright. So the lock covers only
/// scan-and-reserve — which touches nothing but this array and cheap manager reads — and is
/// released before the build. The reservation is what keeps the slot exclusive meanwhile.
///
/// The set is NOT a second source of truth for what exists: it covers only the window between
/// claiming a slot and that slot becoming observable in the window manager. Occupancy itself stays
/// derived (see `_OCCUPANCY_IS_DERIVED`), because a user red-buttoning a satellite would drift bookkeeping
/// we kept.
///
/// Process-wide (a `static`) rather than Tauri managed state on purpose: the invariant it protects
/// is "one owner per label in this process's window manager", which is a property of the process,
/// not of any `App`. A `State<T>` would also be reachable only from a command, leaving
/// `init_*`-style callers outside the lock.
static ALLOC: Slots = Mutex::new([false; POOL.len()]);

/// Holds one slot reserved for the life of a build attempt, and releases it on ANY exit — including
/// a panic mid-build, which must not leak a slot out of the pool until relaunch.
struct Reservation<'a> {
    slots: &'a Slots,
    idx: usize,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let mut reserved = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        reserved[self.idx] = false;
    }
}

/// Scan-and-reserve, atomically. The returned guard owns the slot until it is dropped.
///
/// `exists` probes happen under the lock deliberately: they are cheap manager map reads that never
/// dispatch to the event loop, unlike `build`. Recover from poisoning rather than unwrapping — a
/// panic in one tear-off must not make every future tear-off in the session fail, and this guard
/// protects a claim, not data, so there is no half-written state for it to be hiding.
/// `tried` marks slots this pass has already attempted, and is what makes the retry loop
/// STRUCTURALLY finite: at most `POOL.len()` build attempts per pass, whatever any build returns.
/// The predecessor got that for free by walking an index forward; reserving and releasing does not,
/// because a failed build leaves the slot both unreserved and (if the failure was label-independent)
/// still absent from the registry — so a caller that merely re-scanned would pick the same slot
/// forever. Terminating must not depend on correctly classifying an error.
fn reserve_free_slot<'a, R: SlotRegistry>(
    slots: &'a Slots,
    reg: &R,
    tried: &[bool; POOL.len()],
) -> Option<Reservation<'a>> {
    let mut reserved = slots.lock().unwrap_or_else(|e| e.into_inner());
    for (i, label) in POOL.iter().enumerate() {
        if !tried[i] && !reserved[i] && !reg.exists(label) {
            reserved[i] = true;
            return Some(Reservation { slots, idx: i });
        }
    }
    None
}

/// How long `close_project_window` will wait for a destroyed window to actually leave the manager,
/// and how often it looks. Short: `destroy` is a message to the event loop, which normally drains
/// it in a frame or two. The bound is what keeps a wedged event loop from hanging the IPC thread.
const CLOSE_TIMEOUT: Duration = Duration::from_millis(500);
const CLOSE_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// The one re-scan `open_project_window` grants itself before declaring the pool exhausted, to
/// cover a `destroy` that was dispatched from somewhere that did not wait for it (a red-button
/// close racing a tear-off, or any future caller of `destroy` that skips `close_project_window`).
const EXHAUSTED_SETTLE: Duration = Duration::from_millis(120);

/// Is this one of ours? Every command that moves or destroys a window checks this first, so a
/// compromised or simply buggy frontend cannot aim `set_project_window_bounds` at `main` (or at the
/// helper panel) and drag it off-screen. `helper.rs` gets this property for free by hardcoding its
/// one label; a pooled command has to assert it.
pub fn is_pool_label(label: &str) -> bool {
    POOL.contains(&label)
}

/// OCCUPANCY IS DERIVED, NEVER TRACKED — the rule `reserve_free_slot` implements by asking
/// `reg.exists` on every scan instead of consulting a table.
///
/// A user closing a satellite with the red button destroys the window without telling us, so any
/// slot bookkeeping we kept would drift and leak the pool until relaunch. The window manager cannot
/// drift that way: it is never *stale*, only ever *late*. `destroy()` posts teardown to the event
/// loop, so for the few frames until that message is drained the manager still hands back a dying
/// window. That is the one place our own writes are ordered against these reads, which is why
/// `close_project_window` waits for the removal to be observable and `claim_slot` re-scans once
/// before crying exhaustion. A USER-initiated close never has this problem: nobody is asking in the
/// same breath.
///
/// (The reservation set in `ALLOC` is not an exception. It records in-flight CLAIMS, not existence,
/// and every entry is released the moment its build settles one way or the other.)
const _OCCUPANCY_IS_DERIVED: () = ();

/// Poll `exists` until it reports gone, or until `timeout` elapses. `true` = observed gone.
///
/// Split out from `close_project_window` so the bound is testable without an `AppHandle`: the
/// property that matters is "returns, always" — a caller waiting on the event loop must never be
/// able to wait forever, however wedged that loop is.
pub fn wait_until_gone(
    mut exists: impl FnMut() -> bool,
    timeout: Duration,
    interval: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !exists() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(interval);
    }
}

/// Is this project id safe to interpolate into the window's query string?
///
/// The id reaches us from the frontend and goes straight into a URL, so anything that could end the
/// `project=` value and start another parameter is refused rather than escaped — a satellite is
/// booted by its params (`?view=project&project=<id>`), and a smuggled second param would let the
/// caller steer the window's identity. Project ids are generated ids, so this rejects nothing real.
pub fn is_safe_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The two things slot allocation needs from the window manager, behind a seam.
///
/// This exists so the EXCLUSION can be tested (roborev: the allocator was a check-then-act race).
/// "Is scan-and-reserve actually atomic?" is not something you can read off the source with
/// confidence — dropping a guard early looks identical at a glance — and it cannot be probed
/// through `AppHandle` in a unit test. Against a fake registry it is just a concurrency test: four
/// threads, four distinct labels, zero collisions. `capture_window.rs`'s `TakeoverTeardown` is the
/// same trick for the same reason.
pub trait SlotRegistry {
    /// Is a window with this label registered right now?
    fn exists(&self, label: &str) -> bool;
    /// Create it. `Err` means the slot could not be taken — usually "already exists".
    fn build(&self, label: &str) -> Result<(), String>;
}

/// Claim the first free pool slot and build into it, atomically with respect to other claims.
///
/// The scan and the build are ONE operation under `ALLOC`: a scan whose result can be invalidated
/// before the build is just a guess. See `ALLOC` for why the lock is process-wide, and
/// `open_project_window` for the two belts layered over it.
pub fn claim_slot<R: SlotRegistry>(reg: &R, settle: Duration) -> Result<&'static str, String> {
    claim_slot_in(&ALLOC, reg, settle)
}

/// `claim_slot` against an explicit reservation set.
///
/// The production set is the `static ALLOC`, and it must be: there is exactly one window manager per
/// process, so exclusion has to be process-wide. Tests pass their OWN set — not for style, but
/// because a shared static is a genuine isolation bug in a test binary. Cargo runs these tests as
/// parallel threads of one process, so a concurrent test holding reservations would make an
/// unrelated test's independent fake registry report slots busy that its own registry calls free.
/// That is exactly how `a_pool_that_only_looks_full_is_re_scanned_after_a_settle` failed in-suite
/// while passing alone.
pub fn claim_slot_in<R: SlotRegistry>(
    slots: &Slots,
    reg: &R,
    settle: Duration,
) -> Result<&'static str, String> {
    let mut last_build_err: Option<String> = None;
    for attempt in 0..2 {
        if attempt == 1 {
            // Only reached when pass 0 found no slot it could take. Give a dispatched destroy a
            // beat to actually leave the manager before telling the user the desk is full. NOT
            // under the lock — see ALLOC: sleeping while holding it would stall every concurrent
            // tear-off behind a pool that merely LOOKS full.
            std::thread::sleep(settle);
        }
        // Each iteration reserves one slot, builds outside the lock, and drops the reservation.
        // `tried` bounds the pass at POOL.len() attempts no matter what the builds return.
        let mut tried = [false; POOL.len()];
        while let Some(res) = reserve_free_slot(slots, reg, &tried) {
            tried[res.idx] = true;
            let label = POOL[res.idx];
            match reg.build(label) {
                Ok(()) => return Ok(label),
                Err(e) => {
                    // Fall through to the next slot ONLY if this one turned out to be genuinely
                    // taken — a race lost to something that does not take ALLOC. Any other failure
                    // (malformed URL, webview/GPU creation failure, OOM) would fail identically on
                    // every remaining slot, so retrying burns up to 8 real window-creation attempts
                    // and then reports the LAST slot's error, masking the actual cause. Bail with
                    // the original error instead.
                    if !reg.exists(label) {
                        return Err(e);
                    }
                    tracing::warn!(label, error = %e, "satellite slot taken mid-build; trying next");
                    last_build_err = Some(e);
                }
            }
        }
    }
    // Prefer the exhaustion message when the pool really is full: that is the one the frontend
    // branches on. A stale "already exists" from one slot would otherwise mask it.
    let full = format!("all {} satellite windows are already open", POOL.len());
    Err(match last_build_err {
        Some(e) if !POOL.iter().all(|l| reg.exists(l)) => e,
        Some(e) => format!("{full} (last build error: {e})"),
        None => full,
    })
}

/// The real registry, against a live app. Deliberately thin — everything interesting is in
/// `claim_slot`, which is tested; these two lines are eyeballed.
struct AppSlots<'a> {
    app: &'a AppHandle,
    project_id: &'a str,
    x: Option<f64>,
    y: Option<f64>,
}

impl SlotRegistry for AppSlots<'_> {
    fn exists(&self, label: &str) -> bool {
        self.app.get_webview_window(label).is_some()
    }
    fn build(&self, label: &str) -> Result<(), String> {
        build_satellite(self.app, label, self.project_id, self.x, self.y)
    }
}

/// Build one satellite at `label`. Split out so the allocator can treat a build failure as
/// "that slot turned out to be taken" and move on, instead of failing the whole tear-off.
fn build_satellite(
    app: &AppHandle,
    label: &str,
    project_id: &str,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    let mut builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("index.html?view=project&project={project_id}").into()),
    )
    // A real window the user moves, resizes and closes — unlike the helper/capture panels, which
    // are decorationless always-on-top overlays. The title is a placeholder; the frontend renames it
    // to the project once it knows the name (`core:window:allow-set-title` is already granted).
    .title("Sparkle")
    .inner_size(DEFAULT_W, DEFAULT_H)
    .resizable(true)
    .visible(true);
    // Position at build time rather than with a follow-up set_position: a window that appears at the
    // default spot and then jumps to the drop point is visible as a flinch on every tear-off.
    if let (Some(x), Some(y)) = (x, y) {
        builder = builder.position(x, y);
    }
    builder.build().map(|_| ()).map_err(|e| e.to_string())
}

/// Open a satellite for `project_id`, returning the label it was given.
///
/// Does NOT check whether the project already has a window — that is the frontend's job, which owns
/// the label→project registry (`services/windowRegistry.ts`) and can focus the existing one instead.
///
/// Allocation is serialized process-wide: scan-and-reserve is atomic under `ALLOC`, and the build
/// runs outside it against a reserved slot (see `ALLOC` for why the lock must not span the build).
/// Two belts on top of that, because the window manager is shared with code that does not reserve:
///  - a `build()` that fails because its label is taken falls through to the next free slot;
///  - a pool that reads as full is re-scanned once after a short settle, since a `destroy` posted
///    from outside `close_project_window` leaves its window briefly still registered.
///
/// Runs on the BLOCKING pool, and BOTH halves of that matter — see `ALLOC`. Off the event loop,
/// because the `EXHAUSTED_SETTLE` sleep would otherwise stall the very loop that must drain the
/// pending destroy it is waiting for. Off the general async workers too, because `spawn_blocking` is
/// the only thing that actually gets it there.
///
/// Blocking: worst case waits `EXHAUSTED_SETTLE` before reporting exhaustion. Bounded; nothing here
/// waits forever.
#[tauri::command]
pub async fn open_project_window(
    app: AppHandle,
    project_id: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_project_id(&project_id) {
            return Err("invalid project id".into());
        }
        let slots = AppSlots {
            app: &app,
            project_id: &project_id,
            x,
            y,
        };
        claim_slot(&slots, EXHAUSTED_SETTLE).map(|l| l.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(format!("the tear-off task failed to run: {e}")))
}

/// Move and resize in one call, for the same reason `set_helper_bounds` does it in one: driving
/// them as two IPC round-trips renders an intermediate frame at the wrong geometry.
#[tauri::command]
pub fn set_project_window_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize};
    if !is_pool_label(&label) {
        return Err("not a satellite window".into());
    }
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_size(LogicalSize::new(width, height));
        let _ = win.set_position(LogicalPosition::new(x, y));
    }
    Ok(())
}

/// Destroy a satellite, freeing its pool slot. Uses `destroy` (already granted) rather than
/// `close`, which was retired with the purge and stays retired.
///
/// **Waits, bounded, for the slot to actually be free before returning.** `destroy()` only posts
/// teardown to the event loop; the window leaves the manager when that message is processed.
/// Returning at the post would mean the caller's very next `open_project_window` — re-tearing the
/// same project, or swapping which project is torn out — re-scans while the dying window is still
/// registered, and either silently lands in a different slot or, on a full pool, refuses the
/// tear-off outright for a slot that is mid-free. So we poll `get_webview_window` every
/// `CLOSE_POLL_INTERVAL` for at most `CLOSE_TIMEOUT`.
///
/// On timeout it warns and still returns `Ok`: the destroy WAS dispatched, the frontend has no
/// better move than to carry on, and `open_project_window`'s settle-and-re-scan is the backstop.
/// `Ok` therefore means "destroy dispatched, and observed gone unless a warning says otherwise".
///
/// THE `spawn_blocking` HAND-OFF IS LOAD-BEARING and this command is broken without it — which is
/// why a test pins it. `destroy()` is drained only by the event loop, so polling for the removal on
/// that same thread can never observe it: the wait would spin the full `CLOSE_TIMEOUT` with the
/// whole UI frozen, log the warning every time, and still leave the slot reading as busy — strictly
/// worse than not waiting at all. Getting off the event loop is necessary but NOT sufficient:
/// running this body on a shared tokio worker instead (which is all `#[tauri::command(async)]` on a
/// sync fn buys) would park a worker every other command needs for up to `CLOSE_TIMEOUT`. See
/// `ALLOC` for the crate-level details.
#[tauri::command]
pub async fn close_project_window(app: AppHandle, label: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || close_blocking(&app, &label))
        .await
        .unwrap_or_else(|e| Err(format!("the satellite close task failed to run: {e}")))
}

/// The blocking half of `close_project_window`. MUST NOT run on the event-loop thread (it waits for
/// work only that loop can complete) and MUST NOT run on a general async worker (it sleeps).
fn close_blocking(app: &AppHandle, label: &str) -> Result<(), String> {
    if !is_pool_label(label) {
        return Err("not a satellite window".into());
    }
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.destroy();
        let gone = wait_until_gone(
            || app.get_webview_window(label).is_some(),
            CLOSE_TIMEOUT,
            CLOSE_POLL_INTERVAL,
        );
        if !gone {
            tracing::warn!(
                label = %label,
                "satellite still registered {}ms after destroy; slot may read as busy",
                CLOSE_TIMEOUT.as_millis() as u64
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The capability file, embedded at COMPILE time — the same trick `capture_window.rs` uses to
    /// pin its TS contract. This is the one drift that cannot be caught any other way: adding a
    /// label to POOL without adding it to default.json produces a window with ZERO permissions,
    /// whose React tree mounts fine and whose every `invoke`/`listen` rejects silently at runtime.
    /// The helper island shipped broken for exactly one commit on this.
    const CAPABILITIES: &str = include_str!("../capabilities/default.json");

    /// A reservation set of this test's own. Cargo runs these as parallel threads of ONE process,
    /// so sharing the production `static ALLOC` would let a concurrent test's reservations make an
    /// unrelated fake registry report slots busy that its own registry calls free — which is
    /// precisely how the re-scan test failed in-suite while passing alone.
    fn fresh() -> Slots {
        Mutex::new([false; POOL.len()])
    }

    /// The labels the capability file ACTUALLY grants — the `windows` array, parsed.
    ///
    /// Substring-matching the whole file (what these tests used to do) answers a different and
    /// much weaker question: "does this label appear anywhere in this JSON?". It does appear
    /// elsewhere — the `description` prose discusses `project-N` today — so the lockstep guard
    /// would stay green with the label deleted from `windows`, on a window that gets ZERO
    /// permissions. A scoped grant (`{"identifier": …, "allow": [{"window": "project-4"}]}`) or a
    /// future `webviews`/`remote` key would satisfy it just as falsely.
    fn granted_windows(json: &str) -> Vec<String> {
        let v: serde_json::Value =
            serde_json::from_str(json).expect("capabilities JSON must parse");
        v["windows"]
            .as_array()
            .expect("capabilities JSON must declare a top-level `windows` array")
            .iter()
            .map(|e| {
                e.as_str()
                    .expect("every `windows` entry must be a string label")
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn every_pool_label_is_granted_capabilities() {
        let granted = granted_windows(CAPABILITIES);
        for l in POOL {
            assert!(
                granted.iter().any(|g| g == l),
                "{l} is in POOL but absent from the `windows` array of capabilities/default.json \
                 (granted: {granted:?}) — that window would get ZERO permissions and fail only at \
                 runtime"
            );
        }
    }

    #[test]
    fn the_capability_list_has_no_glob() {
        // Stated on this side too: a glob would re-hide the failure above by granting any future
        // label automatically, which is what the multi-window purge removed. Run over the same
        // PARSED entries: the old split-on-"windows" version took the first occurrence of that
        // literal anywhere in the file, so the day the description quotes the word, the assertion
        // silently starts running against prose and passes for free.
        for w in granted_windows(CAPABILITIES) {
            assert!(
                !w.contains('*'),
                "windows list must not contain a glob: {w}"
            );
        }
    }

    /// A capability file where `project-4` is mentioned everywhere EXCEPT where it counts.
    /// Both mentions are real shapes: the prose one exists in the live file today, and the scoped
    /// `allow` one is what a per-window permission grant looks like.
    const FIXTURE_LABEL_ONLY_MENTIONED: &str = r#"{
      "identifier": "default",
      "description": "up to four 'project-N' satellite windows; project-4 is discussed here",
      "windows": ["main", "project-1"],
      "permissions": [
        "core:default",
        { "identifier": "core:event:allow-listen", "allow": [{ "window": "project-4" }] }
      ]
    }"#;

    #[test]
    fn a_label_that_is_only_mentioned_is_not_granted() {
        // The regression this guard exists to catch, proven rather than asserted: the substring
        // check the old test used says YES for a window with zero permissions...
        assert!(
            FIXTURE_LABEL_ONLY_MENTIONED.contains("\"project-4\""),
            "fixture must reproduce the false positive: the label appears in the file"
        );
        // ...and the parsed check says NO, which is the truth.
        let granted = granted_windows(FIXTURE_LABEL_ONLY_MENTIONED);
        assert!(
            !granted.iter().any(|g| g == "project-4"),
            "project-4 is only mentioned in the description and in a scoped allow entry — it is \
             NOT in the windows array and must not count as granted"
        );
        assert_eq!(granted, vec!["main".to_string(), "project-1".to_string()]);
    }

    #[test]
    fn a_glob_inside_the_windows_array_is_caught_wherever_it_sits() {
        // The no-glob check must read the array, not the first occurrence of the word "windows".
        let fixture = r#"{
          "description": "the windows list is enumerated below",
          "windows": ["main", "project-*"]
        }"#;
        assert!(granted_windows(fixture).iter().any(|w| w.contains('*')));
    }

    #[test]
    fn pool_labels_are_recognised_and_others_are_not() {
        for l in POOL {
            assert!(is_pool_label(l), "{l} should be a pool label");
        }
        // The whole point of the check: these must never be movable through this command.
        assert!(!is_pool_label("main"));
        assert!(!is_pool_label("helper"));
        assert!(!is_pool_label("capture"));
        assert!(!is_pool_label("project-5"));
        assert!(!is_pool_label(""));
    }

    /// A window manager with a deliberately WIDE check-then-act window: every `exists` probe
    /// sleeps, so an allocator that scans outside the lock is overwhelmingly likely to have
    /// another thread claim its slot before it builds. `build` refuses a label that is already
    /// registered, exactly like Tauri ("a window with label project-1 already exists").
    #[derive(Default)]
    struct FakeSlots {
        registered: Mutex<Vec<String>>,
        /// Labels whose build fails because an outside party took the slot between our scan and
        /// our build — a race lost OUTSIDE the reservation, which the allocator must survive by
        /// trying the next slot. The build REGISTERS the label as it fails, because that is what
        /// makes it a lost race rather than a broken build: the allocator distinguishes the two by
        /// re-probing `exists`, so a fake that failed without registering would be testing the
        /// bail-out path while claiming to test the fall-through.
        poisoned_labels: Vec<&'static str>,
        /// Builds that fail for a reason that has nothing to do with the label (malformed URL,
        /// webview creation failure). These must NOT be retried against other slots.
        unbuildable: bool,
        /// Free `drain_label` once this many `exists` probes have been served. Probe-driven rather
        /// than wall-clock so the re-scan test cannot be decided by lock contention.
        drain_after_probes: Option<usize>,
        drain_label: Option<&'static str>,
        probes: std::sync::atomic::AtomicUsize,
        probe_delay: Duration,
        /// How long a build takes. LOAD-BEARING for the concurrency test: in production `build()`
        /// dispatches window creation to the event loop and blocks on it, so it is far slower than
        /// a scan, and it runs OUTSIDE the lock. An instant build closes the race window by
        /// accident — every thread finishes building before the next one finishes scanning — and
        /// the concurrency test then passes even with the reservation removed. Verified: with this
        /// at zero, deleting `reserved[i] = true` does not fail a single test.
        build_delay: Duration,
        /// Every `build` attempt, counted. The attempt COUNT is the only thing that distinguishes
        /// "bailed on a doomed build" from "marched through the pool retrying it" — both end with
        /// the same error text and an empty registry.
        builds: std::sync::atomic::AtomicUsize,
        /// Builds refused because the scan that chose the label was already stale by the time we
        /// built. This is the race itself, counted.
        collisions: std::sync::atomic::AtomicUsize,
    }

    impl SlotRegistry for FakeSlots {
        fn exists(&self, label: &str) -> bool {
            use std::sync::atomic::Ordering::SeqCst;
            std::thread::sleep(self.probe_delay);
            let n = self.probes.fetch_add(1, SeqCst) + 1;
            let mut reg = self.registered.lock().unwrap_or_else(|e| e.into_inner());
            if let (Some(after), Some(drop_me)) = (self.drain_after_probes, self.drain_label) {
                if n >= after {
                    reg.retain(|l| l != drop_me);
                }
            }
            reg.iter().any(|r| r == label)
        }
        fn build(&self, label: &str) -> Result<(), String> {
            // Before anything else: this is the slow, off-lock operation another claimer can scan
            // straight through if nothing is holding the slot for us.
            self.builds
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            std::thread::sleep(self.build_delay);
            if self.unbuildable {
                return Err("webview creation failed".into());
            }
            let mut reg = self.registered.lock().unwrap_or_else(|e| e.into_inner());
            if self.poisoned_labels.contains(&label) && !reg.iter().any(|r| r == label) {
                // The outside party's window is now real: registering it is what makes the next
                // `exists` probe report the slot as genuinely taken.
                reg.push(label.to_string());
                return Err(format!("a window with label {label} already exists"));
            }
            if reg.iter().any(|r| r == label) {
                self.collisions
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return Err(format!("a window with label {label} already exists"));
            }
            reg.push(label.to_string());
            Ok(())
        }
    }

    #[test]
    fn overlapping_tear_offs_each_get_their_own_slot() {
        // The roborev finding: Tauri v2 runs command handlers off the main thread, so two
        // tear-offs a millisecond apart both saw slot 0 free, both built project-1, and the
        // second failed — a dead tear-off with three slots idle.
        //
        // The load-bearing assertion is COLLISIONS == 0, not the distinct labels. The
        // fall-through belt recovers a lost race by walking to the next slot, so an allocator
        // whose lock covers only the scan still hands out four distinct labels — it just gets
        // there by failing builds first. Zero refused builds is what "the scan was still true
        // when we built" means, and it holds only while the guard spans scan AND build. Verified
        // by mutation: dropping the guard before the loop fails this with 6 collisions, 3 runs
        // out of 3, while the distinct-labels assertion below stays green.
        let reg = std::sync::Arc::new(FakeSlots {
            probe_delay: Duration::from_millis(1),
            // Build must OUTLAST a scan, as it does in production (it dispatches to the event loop
            // and blocks). Without that, each thread finishes building before the next finishes
            // scanning, the race window never opens, and this test passes with the reservation
            // deleted — the exact false-green the previous round shipped.
            build_delay: Duration::from_millis(25),
            ..Default::default()
        });
        // ONE reservation set shared by all four threads — that shared set IS the exclusion under
        // test. (Per-thread sets would be the trivially broken case.)
        let slots = fresh();
        let got: Vec<Result<&'static str, String>> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..POOL.len())
                .map(|_| {
                    let reg = reg.clone();
                    let slots = &slots;
                    s.spawn(move || claim_slot_in(slots, &*reg, Duration::from_millis(1)))
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(
            reg.collisions.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a slot was claimed between another claim's scan and its build — the lock does not \
             span scan+build"
        );
        let mut labels: Vec<&str> = got
            .iter()
            .map(|r| {
                *r.as_ref()
                    .expect("every overlapping tear-off must get a slot")
            })
            .collect();
        labels.sort_unstable();
        assert_eq!(
            labels, POOL,
            "four concurrent claims must take four distinct slots"
        );
    }

    #[test]
    fn a_build_that_loses_a_race_falls_through_to_the_next_slot() {
        // Belt for anything that touches the window manager without taking ALLOC. Losing slot 0
        // should cost slot 0, not the tear-off.
        let reg = FakeSlots {
            poisoned_labels: vec!["project-1", "project-2"],
            ..Default::default()
        };
        assert_eq!(
            claim_slot_in(&fresh(), &reg, Duration::from_millis(1)),
            Ok("project-3")
        );
    }

    #[test]
    fn a_pool_lost_to_outside_claims_reports_exhaustion_with_the_build_error_as_context() {
        // Every slot gets taken out from under us. The user-facing message must be the EXHAUSTION
        // one — that is what the frontend branches on — with the build error kept as context rather
        // than shown instead of it.
        let reg = FakeSlots {
            poisoned_labels: POOL.to_vec(),
            ..Default::default()
        };
        let err = claim_slot_in(&fresh(), &reg, Duration::from_millis(1))
            .expect_err("nothing could be built");
        assert!(
            err.starts_with("all 4 satellite windows are already open"),
            "got: {err}"
        );
        assert!(
            err.contains("already exists"),
            "the build error is kept as context: {err}"
        );
    }

    #[test]
    fn a_build_that_fails_for_a_non_label_reason_bails_instead_of_burning_the_pool() {
        // A malformed URL or a webview/GPU failure will fail identically on every slot. Retrying
        // it costs up to 8 real window-creation attempts and then reports the LAST slot's error,
        // masking the actual cause. One attempt, original error, out.
        let reg = FakeSlots {
            unbuildable: true,
            ..Default::default()
        };
        let err = claim_slot_in(&fresh(), &reg, Duration::from_millis(1))
            .expect_err("build always fails");
        assert_eq!(
            err, "webview creation failed",
            "the ORIGINAL cause must survive"
        );
        // The load-bearing assertion. Both the bail and the march end with this error text and an
        // empty registry; only the attempt COUNT tells them apart. Without the bail this is 8 —
        // every slot, twice — each one a real window-creation attempt in production.
        assert_eq!(
            reg.builds.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "a label-independent failure must be tried ONCE, not against every slot in the pool"
        );
    }

    #[test]
    fn a_full_pool_is_reported_as_full() {
        let reg = FakeSlots::default();
        {
            let mut r = reg.registered.lock().unwrap();
            r.extend(POOL.iter().map(|l| l.to_string()));
        }
        let err =
            claim_slot_in(&fresh(), &reg, Duration::from_millis(1)).expect_err("the pool is full");
        assert_eq!(err, "all 4 satellite windows are already open");
    }

    #[test]
    fn a_pool_that_only_looks_full_is_re_scanned_after_a_settle() {
        // A destroy dispatched from outside close_project_window leaves its window registered for
        // a few frames. Without the second pass, the tear-off that follows a close is refused for
        // a slot that is mid-free — the exact symptom in the roborev finding.
        //
        // The drain is driven by PROBE COUNT, not wall-clock. The earlier version freed the slot
        // after a fixed 20ms while `ALLOC` is process-global and contended by the other tests in
        // this binary: if this test waited >20ms to acquire it, pass 0 already saw the slot free
        // and returned without ever reaching pass 1 — green, with the re-scan belt untested.
        // Freeing on the (POOL.len()+1)-th probe means only a genuine SECOND pass can succeed.
        let reg = FakeSlots {
            drain_after_probes: Some(POOL.len() + 1),
            drain_label: Some("project-3"),
            ..Default::default()
        };
        {
            let mut r = reg.registered.lock().unwrap();
            r.extend(POOL.iter().map(|l| l.to_string()));
        }
        assert_eq!(
            claim_slot_in(&fresh(), &reg, Duration::from_millis(1)),
            Ok("project-3")
        );
        // Assert the PATH, not just the outcome: pass 0 alone is exactly POOL.len() probes, so
        // anything more can only be the re-scan.
        assert!(
            reg.probes.load(std::sync::atomic::Ordering::SeqCst) > POOL.len(),
            "the slot must have been found on a SECOND scan, not the first"
        );
    }

    #[test]
    fn a_close_returns_as_soon_as_the_window_is_observably_gone() {
        // The point of the wait: `destroy()` returns before the manager forgets the window, so the
        // first couple of looks still find it. We must keep looking, not return on the first read.
        let looks = std::cell::Cell::new(0);
        let gone = wait_until_gone(
            || {
                looks.set(looks.get() + 1);
                looks.get() < 3
            },
            Duration::from_secs(5),
            Duration::from_millis(1),
        );
        assert!(gone, "should observe the window leave the manager");
        assert_eq!(
            looks.get(),
            3,
            "must re-check rather than trust the first read"
        );
    }

    #[test]
    fn a_close_gives_up_instead_of_waiting_forever() {
        // A wedged event loop must cost the caller a bounded delay, not the session. Unbounded
        // waiting here would hang the IPC thread for a window that is never coming back.
        let start = Instant::now();
        let gone = wait_until_gone(|| true, Duration::from_millis(40), Duration::from_millis(5));
        assert!(
            !gone,
            "a window that never leaves must be reported as still there"
        );
        assert!(
            start.elapsed() >= Duration::from_millis(40),
            "must actually wait its timeout"
        );
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "must not wait appreciably past its timeout (waited {:?})",
            start.elapsed()
        );
    }

    #[test]
    fn the_close_bound_is_short_enough_to_sit_on_an_ipc_call() {
        // Held to a human-perceptible budget on purpose: this blocks the tear-off UI. If either
        // constant grows, the tradeoff should be a deliberate edit here, not a drift.
        assert!(CLOSE_TIMEOUT <= Duration::from_millis(750));
        assert!(CLOSE_POLL_INTERVAL < CLOSE_TIMEOUT);
        assert!(EXHAUSTED_SETTLE <= CLOSE_TIMEOUT);
    }

    /// This module's own source, embedded at compile time — the `include_str!` trick the capability
    /// guard above uses, pointed at ourselves.
    const SOURCE: &str = include_str!("project_window.rs");

    /// A definition's body: from its signature to the next line that is exactly `}`.
    fn body_of<'a>(src: &'a str, signature: &str) -> &'a str {
        let at = src
            .find(signature)
            .unwrap_or_else(|| panic!("{signature} not found"));
        let rest = &src[at..];
        let end = rest.find("\n}").map(|e| e + 2).unwrap_or(rest.len());
        &rest[..end]
    }

    /// The attribute line immediately preceding a definition.
    fn attr_above(src: &str, signature: &str) -> String {
        let at = src
            .find(signature)
            .unwrap_or_else(|| panic!("{signature} not found in source"));
        src[..at]
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .expect("a command must have an attribute above it")
            .trim()
            .to_string()
    }

    #[test]
    fn the_waiting_commands_run_off_the_event_loop_thread_and_off_the_async_workers() {
        // Two separate properties, and BOTH were got wrong in turn. This is invisible to every
        // other test here, because they all exercise the waits against a fake registry rather than
        // against the runtime they must not occupy.
        //
        // 1. OFF THE EVENT LOOP. A plain `#[tauri::command]` is `ExecutionContext::Blocking`:
        //    tauri-macros generates the "sync" kind, whose body runs inline on the thread
        //    delivering the IPC (the main thread on macOS). `destroy()` is only ever drained BY
        //    that thread's loop — handling it there is an explicit panic in tauri-runtime-wry — so
        //    a sync command polling for the removal blocks the one thread that could deliver it.
        // 2. OFF THE SHARED ASYNC WORKERS. `#[tauri::command(async)]` on a SYNC fn looks like it
        //    fixes this and does not: its "sync_threadpool" label (wrapper.rs:264) is only a
        //    tracing field, and `body_async` calls the sync body inside `async move {}` handed to
        //    `tokio::spawn`. The 500ms sleep would park a worker every other command shares.
        //    `spawn_blocking` is what actually moves it, per `folder_picker.rs`/`dictation.rs`.
        // SEARCH ONLY THE PRE-TEST SLICE. Everything below `mod tests` is this module quoting
        // itself: the first version of the second assertion below did `SOURCE.contains("spawn_
        // blocking(…)")` against the whole file and so matched its OWN string literal — vacuous,
        // green no matter what the command bodies did. It looked mutation-checked because the
        // mutant also reverted the attribute, which the FIRST assertion caught.
        let code = &SOURCE[..SOURCE
            .find("mod tests")
            .expect("the test module must exist")];

        for sig in [
            "pub async fn open_project_window(",
            "pub async fn close_project_window(",
        ] {
            assert_eq!(
                attr_above(code, sig),
                "#[tauri::command]",
                "{sig} must be an async fn command (ExecutionContext::Async), not (async) on a sync fn"
            );
            // Anchored to THIS command's body, not merely present somewhere in the file — an
            // unrelated `spawn_blocking` added later must not satisfy it.
            let body = body_of(code, sig);
            assert!(
                body.contains("spawn_blocking"),
                "{sig} must hand its blocking work to spawn_blocking; body was:\n{body}"
            );
        }
    }

    #[test]
    fn the_allocator_lock_survives_a_poisoned_holder() {
        // A panic inside one tear-off must not brick every future tear-off. `.unwrap()` on this
        // lock would do exactly that, permanently, for the rest of the session.
        let poisoned = std::panic::catch_unwind(|| {
            let _g = ALLOC.lock().unwrap();
            panic!("poison the allocator");
        });
        assert!(poisoned.is_err());
        assert!(ALLOC.is_poisoned());
        let _recovered = ALLOC.lock().unwrap_or_else(|e| e.into_inner());
        // Clear it so test ordering can't make this one contagious.
        ALLOC.clear_poison();
    }

    #[test]
    fn safe_project_ids_accept_generated_ids() {
        assert!(is_safe_project_id("a1b2c3"));
        assert!(is_safe_project_id("3f8e-4a21-9c00"));
        assert!(is_safe_project_id("my_project_1"));
    }

    #[test]
    fn safe_project_ids_refuse_anything_that_could_smuggle_a_param() {
        // Each of these would end the project= value and start another parameter, letting the
        // caller steer the satellite's identity (e.g. claim to be the helper view).
        assert!(!is_safe_project_id("a&view=helper"));
        assert!(!is_safe_project_id("a#frag"));
        assert!(!is_safe_project_id("a?b"));
        assert!(!is_safe_project_id("a b"));
        assert!(!is_safe_project_id("../etc"));
        assert!(!is_safe_project_id(""));
        assert!(!is_safe_project_id(&"x".repeat(129)));
    }
}
