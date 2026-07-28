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

/// **Both commands in this module are `#[tauri::command(async)]`, and that is load-bearing.**
///
/// A plain `#[tauri::command]` compiles to `ExecutionContext::Blocking` (tauri-macros
/// `wrapper.rs:50`), whose generated body is a DIRECT inline call — nothing spawns anywhere on the
/// path from the IPC handler to it. So a sync command body runs on the thread delivering the IPC:
/// the macOS main thread, which is also the event loop.
///
/// That matters because `WebviewWindow::destroy()` is one of the few calls that can ONLY be
/// serviced by the event loop: `tauri-runtime-wry:2283` sends it with `send_event` under an
/// explicit "destroy cannot use the `send_user_message` function" note, and `handle_user_message`
/// PANICS with "cannot handle `WindowMessage::Destroy` on the main thread" if it ever arrives
/// inline. The window leaves the manager only when the loop dequeues that message.
///
/// A sync command that waits for a destroy therefore blocks the only thread that could complete
/// it: the wait can never succeed, and it freezes the UI for its whole timeout. `(async)` puts the
/// body on the async runtime instead (`respond_async_serialized` → `async_runtime::spawn`,
/// `ipc/mod.rs:375`; a sync fn marked `(async)` is the "sync_threadpool" kind, i.e. blocking in it
/// is expected). `capture_window.rs:166` reaches the same place by hand with `std::thread::spawn`.
///
/// Reverting either command to plain `#[tauri::command]` silently re-breaks both waits below.
///
/// ---
///
/// `ALLOC` serializes allocate-and-build across the WHOLE process.
///
/// Because the commands are async, two tear-offs that overlap by a millisecond genuinely run
/// concurrently: both scan the pool, both see slot 0 free, and the second `build()` fails with
/// "a window with label project-1 already exists" — a dead tear-off while three slots sit idle.
/// (As SYNC commands they were serialized on the main thread and could not race — so this lock is
/// what makes going async safe, not redundant with it.) A scan is only meaningful if nothing can
/// build between it and OUR build, so the lock is held across BOTH, never just the scan.
///
/// Process-wide (a `static`) rather than Tauri managed state on purpose: the invariant it protects
/// is "one owner per label in this process's window manager", which is a property of the process,
/// not of any `App`. A `State<T>` would also be reachable only from a command, leaving
/// `init_*`-style callers outside the lock.
///
/// Nothing SLEEPS while holding it. `build()` from a non-main thread dispatches to the main thread
/// and blocks there, which is unavoidable if the claim is to be atomic; a settle nap is not, and
/// napping under the lock would park every other tear-off behind one exhausted caller.
static ALLOC: Mutex<()> = Mutex::new(());

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

/// The first free slot, or None when every satellite is already open.
///
/// Occupancy is passed in rather than tracked in state on purpose: the caller derives it from
/// whether the window actually EXISTS. A user closing a satellite with the red button destroys the
/// window without telling us, so any slot bookkeeping we kept would drift and leak the pool until
/// relaunch.
///
/// The manager cannot drift the way bookkeeping would — it is never *stale*, only ever *late*.
/// `destroy()` posts teardown to the event loop and returns, so for the few frames until that
/// message is processed the manager still hands back a dying window. That is the one place our own
/// writes are ordered against these reads, which is why `close_project_window` waits for the
/// removal to be observable and `open_project_window` re-scans once before crying exhaustion. A
/// USER-initiated close never has this problem: nobody is asking in the same breath.
pub fn first_free(occupied: &[bool]) -> Option<usize> {
    occupied.iter().position(|taken| !taken)
}

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
/// This exists so the LOCK can be tested (roborev: the allocator was a check-then-act race).
/// "Is the mutex held across the scan AND the build?" is not something you can read off the source
/// with confidence — `let _ = ALLOC.lock()` drops the guard on the spot and looks identical at a
/// glance — and it cannot be probed through `AppHandle` in a unit test. Against a fake registry it
/// is just a concurrency test: four threads, four distinct labels, zero collisions.
/// `capture_window.rs`'s `TakeoverTeardown` is the same trick for the same reason.
pub trait SlotRegistry {
    /// Is a window with this label registered right now?
    fn exists(&self, label: &str) -> bool;
    /// Create it. `Err` means the slot could not be taken — usually "already exists".
    fn build(&self, label: &str) -> Result<(), String>;
}

/// What one locked pass over the pool concluded.
enum Pass {
    /// Claimed and built this label.
    Took(&'static str),
    /// A build failed for a reason that is NOT "someone else has this label". Retrying elsewhere
    /// would fail the same way.
    Broke(String),
    /// Every slot is occupied.
    Full,
}

/// One atomic scan-and-build pass. The lock spans both — a scan whose result can be invalidated
/// before the build is just a guess. See `ALLOC`.
fn claim_pass<R: SlotRegistry>(reg: &R) -> Pass {
    // Recover from poisoning rather than unwrapping: a panic inside one tear-off must not make
    // every future tear-off in the session fail. The guard protects a label claim, not data — there
    // is no half-written state for a poisoned lock to be hiding. Same convention as `helper.rs`.
    let _guard = ALLOC.lock().unwrap_or_else(|e| e.into_inner());

    let occupied: Vec<bool> = POOL.iter().map(|l| reg.exists(l)).collect();
    let mut from = 0;
    while let Some(rel) = first_free(&occupied[from..]) {
        let slot = from + rel;
        let label = POOL[slot];
        match reg.build(label) {
            Ok(()) => return Pass::Took(label),
            Err(e) => {
                // Fall through to the next slot ONLY if this one turned out to be taken — i.e. we
                // lost a race to something that does not hold `ALLOC`. Re-probing is a better test
                // than matching on the message: any OTHER failure (a malformed URL, an OS refusal,
                // a webview that would not create) will fail identically on every remaining slot,
                // and marching the pool would half-create and tear down three more OS windows for
                // a tear-off that was never going to work.
                if !reg.exists(label) {
                    return Pass::Broke(e);
                }
                tracing::warn!(label, error = %e, "satellite slot lost a race; trying the next");
                from = slot + 1;
            }
        }
    }
    Pass::Full
}

/// Claim the first free pool slot and build into it, atomically with respect to other claims.
///
/// A pool that reads full is re-scanned once after `settle`, because a `destroy` dispatched from
/// outside `close_project_window` leaves its window registered for a few frames. **That nap
/// happens with `ALLOC` released** — the lock protects a claim, not a wait, and holding it here
/// would park every other tear-off behind one exhausted caller. It also only works at all because
/// the caller is off the event-loop thread; see `ALLOC` on why both commands are `(async)`.
pub fn claim_slot<R: SlotRegistry>(reg: &R, settle: Duration) -> Result<&'static str, String> {
    match claim_pass(reg) {
        Pass::Took(label) => return Ok(label),
        Pass::Broke(e) => return Err(e),
        Pass::Full => {}
    }
    std::thread::sleep(settle);
    match claim_pass(reg) {
        Pass::Took(label) => Ok(label),
        Pass::Broke(e) => Err(e),
        // Exhaustion wins over any race we lost getting here: "the desk is full" is the message the
        // frontend branches on, and "a window with label project-1 already exists" would send it
        // down the wrong path for a pool that is simply in use.
        Pass::Full => Err(format!(
            "all {} satellite windows are already open",
            POOL.len()
        )),
    }
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
/// Allocation is serialized process-wide (`ALLOC`) and the lock is held across the occupancy scan
/// AND the build: they are one atomic claim, not two steps. Two belts on top of that brace, because
/// the window manager is shared with code that does not take this lock:
///  - a `build()` that fails because its label is taken falls through to the next free slot (any
///    other build failure is reported straight away — it would just repeat on the next slot);
///  - a pool that reads as full is re-scanned once after a short settle, since a `destroy` posted
///    from outside `close_project_window` leaves its window briefly still registered.
///
/// `(async)` is required, not stylistic: see `ALLOC`. The settle below is a real sleep, and on the
/// event-loop thread it would both freeze the UI and prevent the very destroy it waits for.
///
/// Blocking: worst case this waits `EXHAUSTED_SETTLE` before reporting exhaustion, plus however
/// long the other holder of `ALLOC` takes to build. Both are bounded; nothing here waits forever.
#[tauri::command(async)]
pub fn open_project_window(
    app: AppHandle,
    project_id: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
    if !is_safe_project_id(&project_id) {
        return Err("invalid project id".into());
    }
    let slots = AppSlots { app: &app, project_id: &project_id, x, y };
    claim_slot(&slots, EXHAUSTED_SETTLE).map(|l| l.to_string())
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
/// **`(async)` is what makes this work at all** — see `ALLOC`. `destroy` is drained only by the
/// event loop, so as a plain sync command this poll would block the thread that has to remove the
/// window: it could never observe success, would log its warning every single time, and would
/// freeze the UI for the full `CLOSE_TIMEOUT` on every close. Do not remove the `(async)`.
#[tauri::command(async)]
pub fn close_project_window(app: AppHandle, label: String) -> Result<(), String> {
    if !is_pool_label(&label) {
        return Err("not a satellite window".into());
    }
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.destroy();
        let gone = wait_until_gone(
            || app.get_webview_window(&label).is_some(),
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
            assert!(!w.contains('*'), "windows list must not contain a glob: {w}");
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

    #[test]
    fn first_free_takes_the_lowest_open_slot() {
        assert_eq!(first_free(&[false, false, false, false]), Some(0));
        assert_eq!(first_free(&[true, false, false, false]), Some(1));
        // Reuses a hole left by a closed window rather than marching to the end.
        assert_eq!(first_free(&[true, false, true, false]), Some(1));
    }

    #[test]
    fn first_free_reports_exhaustion() {
        assert_eq!(first_free(&[true, true, true, true]), None);
        // An empty pool is exhausted, not slot 0 — the caller must not index into nothing.
        assert_eq!(first_free(&[]), None);
    }

    /// A window manager with a deliberately WIDE check-then-act window: every `exists` probe
    /// sleeps, so an allocator that scans outside the lock is overwhelmingly likely to have
    /// another thread claim its slot before it builds. `build` refuses a label that is already
    /// registered, exactly like Tauri ("a window with label project-1 already exists").
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};

    #[derive(Default)]
    struct FakeSlots {
        registered: Mutex<Vec<String>>,
        /// Labels that something OUTSIDE the lock claims between our scan and our build — the
        /// build fails AND the label is registered afterwards, which is what a genuinely lost
        /// race looks like. The allocator must walk to the next slot.
        race_labels: Vec<&'static str>,
        /// Labels whose build fails for a reason that has nothing to do with ownership (bad URL,
        /// OS refusal). Nothing ends up registered, so retrying elsewhere is pure waste.
        broken_labels: Vec<&'static str>,
        probe_delay: Duration,
        /// Frees `.1` once more than `.0` probes have been seen. Drives the settle scenario off
        /// the allocator's own progress instead of wall-clock, so lock contention from tests
        /// running in parallel cannot turn it into a pass-0 success.
        free_after_probes: Option<(usize, &'static str)>,
        /// Builds refused because the scan that chose the label was already stale by the time we
        /// built. This is the race itself, counted.
        collisions: AtomicUsize,
        probes: AtomicUsize,
        builds: AtomicUsize,
    }

    impl SlotRegistry for FakeSlots {
        fn exists(&self, label: &str) -> bool {
            let seen = self.probes.fetch_add(1, SeqCst) + 1;
            if let Some((after, freed)) = self.free_after_probes {
                if seen > after {
                    let mut reg = self.registered.lock().unwrap_or_else(|e| e.into_inner());
                    reg.retain(|l| l != freed);
                }
            }
            std::thread::sleep(self.probe_delay);
            let reg = self.registered.lock().unwrap_or_else(|e| e.into_inner());
            reg.iter().any(|r| r == label)
        }
        fn build(&self, label: &str) -> Result<(), String> {
            self.builds.fetch_add(1, SeqCst);
            if self.broken_labels.contains(&label) {
                return Err(format!("failed to create webview for {label}"));
            }
            let mut reg = self.registered.lock().unwrap_or_else(|e| e.into_inner());
            if self.race_labels.contains(&label) && !reg.iter().any(|r| r == label) {
                // Someone else got this label in the gap. Their window is real, hence the push.
                reg.push(label.to_string());
                return Err(format!("a window with label {label} already exists"));
            }
            if reg.iter().any(|r| r == label) {
                self.collisions.fetch_add(1, SeqCst);
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
            probe_delay: Duration::from_millis(2),
            ..Default::default()
        });
        let got: Vec<Result<&'static str, String>> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..POOL.len())
                .map(|_| {
                    let reg = reg.clone();
                    s.spawn(move || claim_slot(&*reg, Duration::from_millis(1)))
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(
            reg.collisions.load(SeqCst),
            0,
            "a slot was claimed between another claim's scan and its build — the lock does not \
             span scan+build"
        );
        let mut labels: Vec<&str> = got
            .iter()
            .map(|r| *r.as_ref().expect("every overlapping tear-off must get a slot"))
            .collect();
        labels.sort_unstable();
        assert_eq!(labels, POOL, "four concurrent claims must take four distinct slots");
    }

    #[test]
    fn a_build_that_loses_a_race_falls_through_to_the_next_slot() {
        // Belt for anything that touches the window manager without taking ALLOC. Losing slot 0
        // should cost slot 0, not the tear-off.
        let reg = FakeSlots { race_labels: vec!["project-1", "project-2"], ..Default::default() };
        assert_eq!(claim_slot(&reg, Duration::from_millis(1)), Ok("project-3"));
    }

    #[test]
    fn a_build_failure_that_is_not_a_race_stops_instead_of_marching_the_pool() {
        // A malformed URL or a refused webview fails identically on every slot. Marching would
        // half-create and tear down three more OS windows (eight builds across both passes) for a
        // tear-off that cannot succeed, and would bury the real reason under a race message.
        let reg = FakeSlots { broken_labels: POOL.to_vec(), ..Default::default() };
        let err = claim_slot(&reg, Duration::from_millis(1)).expect_err("nothing could be built");
        assert_eq!(err, "failed to create webview for project-1");
        assert_eq!(reg.builds.load(SeqCst), 1, "must not try the rest of the pool");
    }

    #[test]
    fn a_full_pool_is_reported_as_full() {
        let reg = FakeSlots::default();
        {
            let mut r = reg.registered.lock().unwrap();
            r.extend(POOL.iter().map(|l| l.to_string()));
        }
        let err = claim_slot(&reg, Duration::from_millis(1)).expect_err("the pool is full");
        assert_eq!(err, "all 4 satellite windows are already open");
    }

    #[test]
    fn a_full_pool_that_also_lost_a_race_still_reports_exhaustion() {
        // "all 4 satellite windows are already open" is the message the frontend branches on. A
        // race lost on the way to discovering the pool is full must not replace it with
        // "a window with label project-1 already exists", which reads as a bug rather than a
        // full desk.
        let reg = FakeSlots { race_labels: vec!["project-1"], ..Default::default() };
        {
            let mut r = reg.registered.lock().unwrap();
            r.extend(["project-2", "project-3", "project-4"].map(|l| l.to_string()));
        }
        let err = claim_slot(&reg, Duration::from_millis(1)).expect_err("the pool is full");
        assert_eq!(err, "all 4 satellite windows are already open");
    }

    #[test]
    fn a_pool_that_only_looks_full_is_re_scanned_after_a_settle() {
        // A destroy dispatched from outside close_project_window leaves its window registered for
        // a few frames. Without the second pass, the tear-off that follows a close is refused for
        // a slot that is mid-free — the exact symptom in the roborev finding.
        //
        // The slot is freed on PROBE COUNT, not after a wall-clock delay: ALLOC is process-global
        // and every other claim_slot test contends for it, so a timer-driven drain could fire
        // while this thread was still waiting for the lock, hand pass 0 a free slot, and leave the
        // re-scan belt untested behind a green assertion. Probe-driven, pass 0 provably sees a
        // full pool. The probe-count assertion below is what pins the path.
        let reg = FakeSlots {
            free_after_probes: Some((POOL.len(), "project-3")),
            ..Default::default()
        };
        {
            let mut r = reg.registered.lock().unwrap();
            r.extend(POOL.iter().map(|l| l.to_string()));
        }
        assert_eq!(claim_slot(&reg, Duration::from_millis(1)), Ok("project-3"));
        assert!(
            reg.probes.load(SeqCst) >= POOL.len() * 2,
            "must have scanned the pool twice — a single-pass success would mean the settle belt \
             was never exercised (probes: {})",
            reg.probes.load(SeqCst)
        );
    }

    /// This module's own source, embedded at COMPILE time. Same trick as `CAPABILITIES` below,
    /// for a contract that is just as invisible at runtime.
    const THIS_SOURCE: &str = include_str!("project_window.rs");

    #[test]
    fn both_waiting_commands_stay_off_the_event_loop_thread() {
        // The one property in this module that NOTHING else can catch. A plain `#[tauri::command]`
        // is `ExecutionContext::Blocking` (tauri-macros wrapper.rs:50) and its generated body is a
        // direct inline call — so the body runs on the thread delivering the IPC, i.e. the macOS
        // main thread and event loop. `destroy` is drained ONLY by that loop
        // (tauri-runtime-wry:2283 sends it with `send_event`; handle_user_message panics with
        // "cannot handle `WindowMessage::Destroy` on the main thread"). Sync + a wait for a
        // destroy = a wait that can never succeed, that freezes the UI for its whole timeout, and
        // that leaves the slot unfree on return — strictly worse than not waiting at all.
        //
        // It type-checks, it passes every other test here, and it only shows up as a hang on a
        // real desktop. So it is pinned in the source.
        for cmd in ["pub fn open_project_window", "pub fn close_project_window"] {
            let head = THIS_SOURCE
                .split(cmd)
                .next()
                .expect("command must be defined in this file");
            let attr = head
                .rsplit_once("#[tauri::command")
                .expect("command must carry a #[tauri::command] attribute")
                .1;
            assert!(
                attr.starts_with("(async)"),
                "{cmd} must be #[tauri::command(async)] — it waits on the event loop, and a sync \
                 command body runs ON the event loop, so the wait could never complete"
            );
        }
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
        assert_eq!(looks.get(), 3, "must re-check rather than trust the first read");
    }

    #[test]
    fn a_close_gives_up_instead_of_waiting_forever() {
        // A wedged event loop must cost the caller a bounded delay, not the session. Unbounded
        // waiting here would hang the IPC thread for a window that is never coming back.
        let start = Instant::now();
        let gone = wait_until_gone(
            || true,
            Duration::from_millis(40),
            Duration::from_millis(5),
        );
        assert!(!gone, "a window that never leaves must be reported as still there");
        assert!(start.elapsed() >= Duration::from_millis(40), "must actually wait its timeout");
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
