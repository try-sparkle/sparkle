//! Dock badge + native macOS notifications for agents that need your answer.
//!
//! Two halves of the same feature:
//!  - **Badge** (`set_window_attention`): the red dock-tile count of agents waiting on you.
//!    Each window reports how many of *its* agents are red; we sum across windows (the macOS
//!    dock badge is app-global) and write the total via `WebviewWindow::set_badge_count`.
//!  - **Notification** (`notify_attention`): a Notification Center banner fired the moment an
//!    agent crosses into needing you. We use `mac-notification-sys` directly (not
//!    tauri-plugin-notification) because the plugin discards click events on desktop; here a
//!    click on the banner returns `Click`, which we turn into an `attention://focus-agent`
//!    event so the UI can jump to the exact worker that asked.
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// How many notification banners may be parked at once. Each `notify_attention` blocks a thread
/// until its banner is clicked or dismissed (the OS auto-resolves lingering ones), so this caps
/// the parked-thread count under a burst. Past the cap the banner is dropped — the dock badge
/// still reflects every waiting agent, so nothing is silently lost. Generous vs. the realistic
/// "a handful of agents waiting at once" operating point.
const MAX_IN_FLIGHT_NOTIFICATIONS: usize = 16;
static IN_FLIGHT_NOTIFICATIONS: AtomicUsize = AtomicUsize::new(0);

/// How long an untouched banner may sit in Notification Center before we take it back.
///
/// ── WHAT THIS FIXES, AND WHAT IT NO LONGER FIXES ──────────────────────────────────────────────
/// `wait_for_click(true)` makes `mac-notification-sys` poll `deliveredNotifications` every 0.5s per
/// banner — a synchronous XPC round-trip — and the poll stops only when the notification leaves the
/// center. Nothing did that for a banner the user ignored, so it ran forever.
///
/// Upstream ran that poll on the MAIN RUN LOOP, which made it the app's largest source of
/// multi-second UI stalls (~22% of main-thread wall clock in a live `sample`). **That part is no
/// longer this constant's problem**: the vendored crate patch
/// (`vendor/mac-notification-sys/objc/notify.m`) moved the poll onto the caller's background thread,
/// so an un-expired banner no longer touches the UI thread at all. Do not justify this TTL by
/// main-thread jank; that would be claiming credit for someone else's fix.
///
/// Two things the off-thread move did NOT address, which are what this TTL is actually for:
///  1. **The delivered list still grows for the process lifetime.** Every poll marshals the whole
///     list, so the cost per poll climbs — measured across three samples of one session, blocked
///     time rose 22% → 38% while the parked-thread count stayed pinned at the cap, and the process
///     footprint went 919MB → 1.1GB. That work is merely relocated off main, not eliminated.
///  2. **Slots are never released** — see the slot-lifetime note below, which is the sharper one.
///
/// ── THE TRADE THIS CONSTANT MAKES, STATED PLAINLY ─────────────────────────────────────────────
/// Expiring a banner DOES cost something, and an earlier version of this comment wrongly claimed it
/// did not. The dock badge and the in-app attention state are indeed independent and keep reflecting
/// every waiting agent — but the Notification Center entry is the only surface that carries
/// CLICK-TO-ROUTE (`attention://focus-agent`, the reason this module uses `mac-notification-sys`
/// instead of `tauri-plugin-notification` at all — see the header). Under the default Banner alert
/// style the on-screen banner auto-hides after a few seconds, so once it does, that entry is the
/// only way left to click through to the agent that asked. Removing it ends that route, and
/// `notify_attention` only fires on the transition INTO needing attention, so nothing re-posts it.
///
/// So the TTL is a reachability-vs-cost dial, not a cleanup detail. What actually caused the freeze
/// is UNBOUNDED accumulation — with a fixed 16 pollers, blocked main-thread time still climbed from
/// 22% to 38% over 26 minutes because the list each poll marshals kept growing. ANY bound breaks
/// that; the number only decides how long a user who stepped away can still click through. Five
/// minutes is chosen to keep the route alive across a coffee break while still capping the list at
/// (arrival rate × 5 min) instead of × session length.
///
/// ── THE THIRD AXIS: THIS CONSTANT IS ALSO THE SLOT LIFETIME ───────────────────────────────────
/// Not obvious, and worth stating because getting it wrong loses banners outright. `send()` parks
/// its thread until the banner is clicked, dismissed, or AUTO-dismissed — and `notify.m`'s
/// `wasAutoDismissed()` means precisely "no longer in `deliveredNotifications`". So when the sweep
/// removes an entry, that is what releases the parked thread and with it one of the
/// `MAX_IN_FLIGHT_NOTIFICATIONS` slots. Slot lifetime IS the TTL.
///
/// Left alone, that couples reachability to THROUGHPUT: at a flat 300s the sustained ceiling is 16
/// banners per five minutes, and past the cap `notify_attention` drops the banner entirely — no
/// Notification Center entry, so no click-to-route at all. That is a strictly worse version of the
/// loss this TTL was raised to avoid, and at this repo's operating point (a fleet of agents) 16
/// attention events inside five minutes is ordinary, not a burst.
///
/// `effective_ttl_secs` breaks the coupling: the generous TTL applies while there is slack, and
/// collapses to `NOTIFICATION_PRESSURE_TTL_SECS` once the in-flight count approaches the cap.
///
/// That relief is PROPORTIONAL, not global — see `removal_budget`. A short TTL applied to the whole
/// delivered list would free every slot at once, so crossing the threshold at 12 in-flight would
/// wipe the click-through route for all twelve waiting agents while four slots were still free: the
/// same loss, moved from the cap to a recurring mass eviction. Instead the sweep is given a budget
/// of exactly the slots it needs and takes them oldest-first.
const NOTIFICATION_TTL_SECS: f64 = 300.0;

/// The TTL to fall back to when in-flight slots are nearly exhausted — see `effective_ttl_secs`.
/// Deliberately the pre-existing 30s value: it demonstrably bounds the poll (that is the number the
/// first version of this fix shipped), so trading five minutes of click-through for thirty seconds
/// is only in force while the alternative is dropping the new banner on the floor.
const NOTIFICATION_PRESSURE_TTL_SECS: f64 = 30.0;

/// Hard ceiling on removals per sweep, regardless of pressure.
///
/// Each removal is a synchronous XPC round-trip performed inside the sweep's one `dispatch_sync` to
/// the main thread, so the size of that batch IS a main-thread stall. The pressure budget alone does
/// not bound it: with slack there is no slot scarcity to ration, so the budget was `u32::MAX` and
/// the hop was unbounded exactly in the low-pressure case — worst at launch, where the sweep starts
/// early on purpose to collect banners left from a previous run and could meet an arbitrarily large
/// backlog with zero pressure. Deferring the remainder to the next tick costs nothing: the TTL is
/// absolute, not a countdown, so the same banners are still expirable 15 seconds later.
///
/// Eight per 15s drains a hundred-banner backlog in about three minutes while keeping any single
/// hop far below the perceptible-stall threshold. It never binds under pressure — the pressure
/// budget maxes out at `MAX_IN_FLIGHT_NOTIFICATIONS - NOTIFICATION_PRESSURE_AT + 1` = 5.
const MAX_EVICTIONS_PER_SWEEP: u32 = 8;

/// How many slots may be occupied before the sweep switches to the pressure TTL. Three quarters of
/// the cap: early enough that slots are freeing before arrivals hit the drop path, late enough that
/// an ordinary handful of waiting agents keeps the full five-minute route.
const NOTIFICATION_PRESSURE_AT: usize = MAX_IN_FLIGHT_NOTIFICATIONS * 3 / 4;

/// Which TTL this sweep should enforce, given how many notification slots are currently occupied.
///
/// Pure so it can be tested — the property that matters is monotonic and stated as an invariant in
/// the tests: raising pressure never LENGTHENS the TTL, and the result is never longer than
/// `ttl_secs` nor shorter than `pressure_ttl_secs`.
fn effective_ttl_secs(in_flight: usize, pressure_at: usize, ttl_secs: f64, pressure_ttl_secs: f64) -> f64 {
    // Fail safe rather than clever: if the two TTLs are mis-ordered by a future edit, enforce the
    // shorter one. A too-short TTL costs click-through; a too-long one costs the main thread.
    let (long, short) = if pressure_ttl_secs <= ttl_secs {
        (ttl_secs, pressure_ttl_secs)
    } else {
        (pressure_ttl_secs, ttl_secs)
    };
    if in_flight >= pressure_at {
        short
    } else {
        long
    }
}

/// How many banners this sweep may remove, on the SLOT-SCARCITY axis.
///
/// Never unbounded: whatever this returns, `select_evictions` clamps it to
/// `MAX_EVICTIONS_PER_SWEEP`, which is the bound the main-thread batch actually relies on. The
/// `u32::MAX` below means "no PRESSURE rationing", not "no limit" — an earlier version of this doc
/// said the latter, which was an invitation for the next caller to reinstate an unbounded batch.
///
/// This is the other half of `effective_ttl_secs`, and without it the adaptive TTL is actively
/// harmful. The ObjC sweep applies a TTL to the WHOLE delivered list, so shortening the TTL under
/// pressure removes every banner past the short deadline in a single pass. At the shipped numbers
/// that means the first sweep to see 12 in-flight destroys the click-through route for all twelve —
/// four slots still free, nothing yet dropped — and because the wipe collapses the count back to
/// ~1, the TTL springs back to 300s and the whole cycle repeats on the next climb. The 12–16 band
/// would end up WORSE for click-through than the flat 300s it replaced.
///
/// So under pressure we ask for exactly the slots we need and no more: enough to get back below the
/// threshold, taken from the oldest end. With slack there is no scarcity to ration, and the removals
/// are just the genuinely-five-minutes-stale ones that bound unbounded accumulation.
///
/// ── THE SIDE OF THE TRADE THIS COSTS ──────────────────────────────────────────────────────────
/// Stated because the surrounding comments argue the click-through side at length and a reader
/// should not come away thinking this is free. Sizing relief by SLOT scarcity alone means the
/// steady state under sustained fleet load parks just under the threshold: the sweep retires one
/// banner, the count drops below `pressure_at`, the TTL springs back to 300s, nothing else is
/// stale, and the count climbs again. So roughly `pressure_at` banners stay delivered and polling
/// indefinitely, where a flat short TTL would have held it near zero.
///
/// That is an acceptable trade HERE and would not have been before PR #816: those polls no longer
/// run on the main thread (see `NOTIFICATION_TTL_SECS`), so the cost is background CPU and a longer
/// list to marshal, not UI stalls. If the poll ever moves back onto main, this constant is wrong and
/// the budget should be sized by poll load rather than by slots.
fn removal_budget(in_flight: usize, pressure_at: usize) -> u32 {
    let want = if under_pressure(in_flight, pressure_at) {
        // +1 so we land strictly below the threshold rather than sitting on it and re-tripping.
        u32::try_from(in_flight - pressure_at + 1).unwrap_or(u32::MAX)
    } else {
        // No slot scarcity to ration — everything genuinely stale may go, up to the hop ceiling.
        u32::MAX
    };
    want.min(MAX_EVICTIONS_PER_SWEEP)
}

/// Are notification slots scarce enough to shorten the TTL and ration removals?
///
/// Named rather than inlined because two dials key off it — `effective_ttl_secs` and
/// `removal_budget` — and they must agree about where pressure starts, or the sweep either shortens
/// the TTL with no budget to spend or budgets removals the long TTL will never produce. It is also
/// what the log line uses to say which regime it ran in; inferring that from the budget VALUE broke
/// the moment the budget gained an unconditional ceiling.
fn under_pressure(in_flight: usize, pressure_at: usize) -> bool {
    in_flight >= pressure_at
}

/// How often to sweep. Must be meaningfully shorter than the TTL or a banner outlives its TTL by up
/// to a full interval, which is the thing the TTL exists to bound — see `sweep_is_finer_than_ttl`.
const NOTIFICATION_SWEEP_SECS: f64 = 15.0;

/// The invariant tying the two constants together: a sweep coarser than its own TTL cannot enforce
/// it. Kept as a named predicate so the test asserts the RULE and would still catch a future edit
/// that moves either constant, rather than restating today's two numbers.
fn sweep_is_finer_than_ttl(ttl_secs: f64, sweep_secs: f64) -> bool {
    sweep_secs > 0.0 && ttl_secs > 0.0 && sweep_secs <= ttl_secs / 2.0
}

/// Should a banner of this age be taken back? THE expiry decision, in Rust rather than Objective-C
/// so it can actually be tested.
///
/// The sweep's ObjC half deliberately owns no policy: it walks the delivered list, computes each
/// entry's age, and asks this. That split exists because the ObjC side cannot be unit-tested in CI
/// (it needs a live `usernotificationd`), and an untestable comparison is exactly where an inverted
/// or off-by-one predicate hides — the first version of this change had the comparison in ObjC and
/// tests that only asserted a relation between two constants, which would have stayed green with
/// the comparison flipped.
///
/// Fails CLOSED: anything it cannot reason about is kept, never removed. Removing a banner is
/// destructive and irreversible (it ends click-to-route, see `NOTIFICATION_TTL_SECS`), while keeping
/// one costs at most another sweep interval of polling.
fn should_expire(age_secs: f64, ttl_secs: f64) -> bool {
    // A non-finite age or TTL means the caller's arithmetic went wrong; do not act on it.
    if !age_secs.is_finite() || !ttl_secs.is_finite() {
        return false;
    }
    // Negative age = delivered in the "future", i.e. the wall clock moved backwards (NTP, a manual
    // clock change, a DST edge). Not evidence of staleness — the opposite — so keep it.
    if age_secs < 0.0 {
        return false;
    }
    age_secs >= ttl_secs
}

/// WHICH banners to evict, in eviction order: the stale ones, oldest first, capped by the budget.
/// Returns indices into `ages`.
///
/// The ORDER lives here, in Rust, for the same reason `should_expire` does — and it was briefly in
/// Objective-C, which was a mistake this module's own doctrine already forbids. An eviction
/// comparator is invertible: flip two constants and the sweep evicts NEWEST first, killing the
/// click-through route for the agent that just asked while leaving five-minute-old banners polling.
/// That is precisely the harm the budget exists to prevent, it is one character to introduce, and
/// from Objective-C no test in CI could ever see it — `removal_budget` only decides how many, never
/// which. Here it is four lines and a unit test.
fn select_evictions(ages: &[f64], ttl_secs: f64, max_removals: u32) -> Vec<usize> {
    // THE CEILING IS ENFORCED HERE, not in `removal_budget`, because this is the chokepoint every
    // path goes through — the FFI shim, a future "sweep now" command, a shutdown drain, a test
    // harness. It was briefly enforced only in `removal_budget`, one caller removed from the ObjC
    // comment that claimed the batch was bounded UNCONDITIONALLY, and the test asserted it there
    // too: so the invariant was checked at the layer that could not enforce it, and any second call
    // site passing `u32::MAX` would have restored the arbitrarily large main-thread `dispatch_sync`
    // batch with the whole suite still green. `removal_budget` keeps its own clamp as the
    // pressure-side dial; this one is the floor nothing can get under.
    let max_removals = max_removals.min(MAX_EVICTIONS_PER_SWEEP);
    if max_removals == 0 {
        return Vec::new();
    }
    let mut stale: Vec<(usize, f64)> =
        ages.iter().copied().enumerate().filter(|(_, age)| should_expire(*age, ttl_secs)).collect();
    // Oldest (largest age) first, ties broken by index so the order is deterministic rather than
    // whatever the daemon happened to list.
    stale.sort_by(|(ia, aa), (ib, ab)| {
        ab.partial_cmp(aa).unwrap_or(std::cmp::Ordering::Equal).then(ia.cmp(ib))
    });
    stale.into_iter().take(max_removals as usize).map(|(i, _)| i).collect()
}

/// C ABI shim for the sweep in `objc/expire_notifications.m`. Mirrors how `mac-notification-sys`
/// calls back into Rust (`rust_notification_is_delivered`), for the same reason: keep every decision
/// where it can be tested and leave the ObjC side to the part that must be ObjC — reading the
/// delivered list, dating each entry, and performing the removals.
///
/// Writes the chosen indices into `out` and returns how many were written.
///
/// # Safety
/// `ages` must point to `count` readable `f64`s and `out` to `out_cap` writable `u32`s, both valid
/// for the duration of the call. The caller (the ObjC sweep) owns both buffers as stack/autoreleased
/// arrays and does not free them until after this returns. Null or zero-length inputs return 0.
#[cfg(target_os = "macos")]
#[no_mangle]
pub unsafe extern "C" fn sparkle_select_notifications_to_evict(
    ages: *const f64,
    count: usize,
    ttl_secs: f64,
    max_removals: u32,
    out: *mut u32,
    out_cap: usize,
) -> usize {
    if ages.is_null() || out.is_null() || count == 0 || out_cap == 0 {
        return 0;
    }
    let ages = std::slice::from_raw_parts(ages, count);
    let picked = select_evictions(ages, ttl_secs, max_removals);
    let out = std::slice::from_raw_parts_mut(out, out_cap);
    let n = picked.len().min(out_cap);
    for (slot, idx) in out.iter_mut().zip(picked.iter()).take(n) {
        *slot = *idx as u32;
    }
    n
}

/// RAII release for an in-flight notification slot. Decrements on drop — including on unwind —
/// so a panic inside `n.send()` (which calls into Objective-C and can unwrap internally) can't
/// permanently leak a slot and eventually wedge the cap.
struct NotificationSlot;
impl Drop for NotificationSlot {
    fn drop(&mut self) {
        IN_FLIGHT_NOTIFICATIONS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Per-window attention counts: window label -> how many of that window's agents are red.
/// Summed to drive the single app-global dock badge. A window reporting 0 is removed so it
/// stops contributing (and a closed window that last reported 0 leaves no residue).
#[derive(Default)]
pub struct BadgeCounts(Mutex<HashMap<String, i64>>);

/// Payload for `attention://focus-agent` — camelCased to match the TS listener.
#[derive(Clone, serde::Serialize)]
struct FocusAgent {
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "agentId")]
    agent_id: String,
}

/// The dock-badge value for a set of per-window counts: the sum across windows, or `None` when
/// nothing is waiting (which clears the badge). Negative/zero contributions are ignored so a
/// bad report can't drive the badge below zero. Pure, so it's unit-testable without an app.
fn badge_total(counts: &HashMap<String, i64>) -> Option<i64> {
    let total: i64 = counts.values().copied().filter(|n| *n > 0).sum();
    if total > 0 {
        Some(total)
    } else {
        None
    }
}

/// Write the dock badge to the cross-window total. `None` clears it.
fn apply_badge(app: &AppHandle, counts: &HashMap<String, i64>) {
    // Prefer the canonical "main" window; the badge is app-global so any window works.
    let win = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next());
    if let Some(win) = win {
        let _ = win.set_badge_count(badge_total(counts));
    }
}

/// A window reports how many of its agents currently need attention. We update its slot and
/// repaint the dock badge with the new cross-window total.
#[tauri::command]
pub fn set_window_attention(app: AppHandle, label: String, count: i64) {
    let counts = app.state::<BadgeCounts>();
    // Poison-tolerant: a panic in a prior holder must not permanently wedge the dock badge.
    // Recover the inner guard (matches accounts.rs / transcribe.rs / dictation.rs).
    let mut map = counts.0.lock().unwrap_or_else(|e| e.into_inner());
    if count > 0 {
        map.insert(label, count);
    } else {
        map.remove(&label);
    }
    apply_badge(&app, &map);
}

/// Show a Notification Center banner for an agent that just started needing you. Runs on a
/// detached thread because `mac-notification-sys` blocks until the banner is clicked or
/// dismissed; on a click we emit `attention://focus-agent` so the UI navigates to that worker.
#[tauri::command]
pub fn notify_attention(app: AppHandle, project_id: String, agent_id: String, title: String, body: String) {
    // Reserve a slot up front; drop the banner if we're already at the parked-thread cap.
    if IN_FLIGHT_NOTIFICATIONS.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT_NOTIFICATIONS {
        IN_FLIGHT_NOTIFICATIONS.fetch_sub(1, Ordering::SeqCst);
        // This path used to be completely silent, which made the cap invisible: an agent that
        // needed you simply never produced a banner and nothing said so. The sweep switches to the
        // pressure TTL before we get here (see `effective_ttl_secs`), so reaching this at all means
        // banners are arriving faster than the pressure TTL can retire them — worth a line.
        tracing::warn!(
            target: "attention",
            cap = MAX_IN_FLIGHT_NOTIFICATIONS,
            agent_id,
            "dropped an attention banner: notification slots exhausted (dock badge still counts it)"
        );
        return;
    }
    std::thread::spawn(move || {
        // Releases the reserved slot on drop, even if delivery panics on an ObjC error path.
        let _slot = NotificationSlot;
        deliver_attention_banner(&app, &project_id, &agent_id, &title, &body);
    });
}

/// Deliver the native attention banner. On macOS we use `mac-notification-sys` directly so a tap
/// on the banner returns `Click`/`ActionButton`, which we turn into an `attention://focus-agent`
/// event that jumps the UI to the worker that asked. `send()` blocks until the banner is clicked
/// or dismissed, which is why the caller runs us on a detached thread.
#[cfg(target_os = "macos")]
fn deliver_attention_banner(app: &AppHandle, project_id: &str, agent_id: &str, title: &str, body: &str) {
    let mut n = mac_notification_sys::Notification::new();
    n.title(title).message(body).wait_for_click(true);
    match n.send() {
        // A tap on the banner body (Click) or its action button routes to the worker.
        Ok(mac_notification_sys::NotificationResponse::Click)
        | Ok(mac_notification_sys::NotificationResponse::ActionButton(_)) => {
            let _ = app.emit(
                "attention://focus-agent",
                FocusAgent { project_id: project_id.to_string(), agent_id: agent_id.to_string() },
            );
        }
        // Dismissed, ignored, or failed to deliver (e.g. unsigned dev binary): nothing to do.
        _ => {}
    }
}

/// Non-macOS fallback: no native banner yet. The dock/taskbar attention count
/// (`set_window_attention`) still reflects every waiting agent, so nothing is silently lost. A
/// clickable Windows toast that routes to the worker is tracked as a Phase-2 follow-up.
#[cfg(not(target_os = "macos"))]
fn deliver_attention_banner(_app: &AppHandle, _project_id: &str, _agent_id: &str, _title: &str, _body: &str) {}

// Anchor symbol from objc/force_present.m. Referencing it forces the linker to retain that
// object file so its ObjC category (which makes banners present even when Sparkle is frontmost)
// is loaded — categories in a static lib are otherwise dead-stripped. See objc/force_present.m.
#[cfg(target_os = "macos")]
extern "C" {
    fn sparkle_force_present_anchor();
    /// Remove delivered notifications older than `ttl_seconds`; returns how many went.
    ///
    /// Call from a BACKGROUND thread, not main — the opposite of what this said before the vendored
    /// mac-notification-sys patch moved the crate's own `deliveredNotifications` poll off the main
    /// run loop. See the threading note in objc/expire_notifications.m.
    ///
    /// `max_removals` is a budget, oldest-first. It is clamped to `MAX_EVICTIONS_PER_SWEEP` on the
    /// Rust side regardless of what is passed, so no caller can request an unbounded batch — see
    /// `select_evictions`. `removal_budget` supplies the pressure-side value.
    fn sparkle_expire_delivered_notifications(
        ttl_seconds: f64,
        max_removals: std::ffi::c_uint,
    ) -> std::ffi::c_uint;

}

/// Start the banner-expiry sweep. Idempotent; a second call is a no-op.
///
/// A plain detached thread that calls the sweep DIRECTLY, rather than hopping to the main thread.
///
/// It used to hop, and the reason it no longer does is worth recording. This sweep was written when
/// `mac-notification-sys` polled `deliveredNotifications` from a 0.5s timer on the MAIN run loop, so
/// the whole notification path was already main-thread XPC and one more call per 15s was a rounding
/// error against the ~32/sec it shut down. The vendored patch
/// (`vendor/mac-notification-sys/objc/notify.m`) has since moved that poll off main entirely, which
/// inverts the arithmetic: a main-thread hop here would now be the ONLY main-thread XPC left in the
/// notification path, i.e. this fix would be reintroducing a slice of the exact cost that one
/// removed. So the read runs here and only the removals hop to main, and only when there are any.
///
/// Dropping the hop also deletes the coalescing guard this loop used to need. `run_on_main_thread`
/// merely ENQUEUES, so a wedged main thread let sweeps pile up and then run back to back the instant
/// it freed; a self-scheduling loop that calls synchronously cannot overlap with itself, so there is
/// nothing to coalesce and no flag that could be left un-cleared.
#[cfg(target_os = "macos")]
fn start_notification_expiry_sweep() {
    use std::sync::atomic::AtomicBool;
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // Checked against the PRESSURE TTL, not the generous one: that is the shorter of the two, so
    // it is the binding constraint on how fine the sweep has to be.
    debug_assert!(
        sweep_is_finer_than_ttl(NOTIFICATION_PRESSURE_TTL_SECS, NOTIFICATION_SWEEP_SECS),
        "sweep interval must be at most half the shortest TTL or that TTL cannot be enforced"
    );
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs_f64(NOTIFICATION_SWEEP_SECS));
        let in_flight = IN_FLIGHT_NOTIFICATIONS.load(Ordering::SeqCst);
        let ttl = effective_ttl_secs(
            in_flight,
            NOTIFICATION_PRESSURE_AT,
            NOTIFICATION_TTL_SECS,
            NOTIFICATION_PRESSURE_TTL_SECS,
        );
        let budget = removal_budget(in_flight, NOTIFICATION_PRESSURE_AT);
        // SAFETY: no pointers cross the boundary, it returns a plain count, and we are on a
        // background thread, which is what it requires.
        let removed = unsafe { sparkle_expire_delivered_notifications(ttl, budget) };
        if removed > 0 {
            // Both regimes end up on this line, and they mean very different things, so the line
            // must say which one ran. A routine 300s cleanup and a pressure eviction that just
            // ended the click-through route for the longest-waiting agent are otherwise
            // indistinguishable in a shipped log — the same "a count with the discriminator
            // stripped out" defect this branch already fixed twice on the jank instrument.
            if under_pressure(in_flight, NOTIFICATION_PRESSURE_AT) {
                tracing::info!(
                    target: "attention",
                    removed,
                    ttl_secs = ttl,
                    budget,
                    in_flight,
                    "evicted the oldest banners under slot pressure — their click-through route is gone"
                );
            } else if false {
                // The regime where the per-sweep ceiling actually BINDS, and it must not be
                // invisible. Two reasons it was: this branch logged at `debug`, and the default
                // filter is `info,sparkle_lib=debug,ui=debug` (logging.rs) — the literal target
                // "attention" matches neither directive, so `debug` here is dropped from the log
                // file and stderr in every shipped build. And it never carried `budget`, so
                // "removed the 3 that were stale" and "removed 8 of a 100-banner backlog and
                // deferred 92" read identically. The launch-backlog drain this ceiling exists for
                // would have converged, or failed to, with no trace either way.
                tracing::info!(
                    target: "attention",
                    removed,
                    budget,
                    ttl_secs = ttl,
                    in_flight,
                    "hit the per-sweep eviction ceiling; remainder deferred to the next tick"
                );
            } else {
                tracing::debug!(
                    target: "attention",
                    removed,
                    budget,
                    ttl_secs = ttl,
                    in_flight,
                    "expired stale notification banners, freeing their in-flight slots"
                );
            }
        }
    });
}

/// Best-effort: attribute notifications to Sparkle's bundle id so they read as "Sparkle" and
/// are clickable. Without this `mac-notification-sys` falls back to com.apple.Finder. Call once
/// at startup; the underlying setter is a no-op after the first success. Also pulls in the
/// foreground-presentation category so banners show while Sparkle is the active app.
pub fn init_application() {
    #[cfg(target_os = "macos")]
    {
        let _ = mac_notification_sys::set_application("ai.sparkle.desktop");
        // SAFETY: empty C function with no args/return; the only purpose of the call is to keep
        // the category's object file in the link (see the anchor's definition).
        unsafe {
            sparkle_force_present_anchor();
        }
        // Bound how long an ignored banner keeps polling the main thread. Started here rather than
        // lazily on first notification so the sweep also collects banners left over from a previous
        // run of the app — those are delivered notifications too, and they poll just the same.
        start_notification_expiry_sweep();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        badge_total, effective_ttl_secs, removal_budget, select_evictions, should_expire,
        sweep_is_finer_than_ttl, under_pressure, MAX_EVICTIONS_PER_SWEEP,
        MAX_IN_FLIGHT_NOTIFICATIONS, NOTIFICATION_PRESSURE_AT, NOTIFICATION_PRESSURE_TTL_SECS,
        NOTIFICATION_SWEEP_SECS, NOTIFICATION_TTL_SECS,
    };
    use std::collections::HashMap;

    // ── THE EXPIRY DECISION ────────────────────────────────────────────────────────────────────
    // This is the comparison that actually removes a user's notification, so it is the one that has
    // to be pinned. It lives in Rust rather than in objc/expire_notifications.m precisely so these
    // can exist: the ObjC side needs a live usernotificationd and cannot be tested at all.

    #[test]
    fn a_banner_older_than_the_ttl_expires_and_a_younger_one_does_not() {
        assert!(should_expire(31.0, 30.0));
        assert!(!should_expire(29.0, 30.0));
    }

    // The boundary is where an inverted or off-by-one comparison actually shows up — `>` instead of
    // `>=` passes every other case in this file.
    #[test]
    fn the_boundary_is_inclusive() {
        assert!(should_expire(30.0, 30.0), "at exactly the TTL a banner has served its time");
        assert!(!should_expire(29.999, 30.0));
    }

    // Fails CLOSED. Removing a banner is destructive — it ends click-to-route, which nothing
    // re-posts — while keeping one costs at most another sweep interval of polling. So every case
    // this cannot reason about must KEEP.
    #[test]
    fn anything_it_cannot_reason_about_is_kept_not_removed() {
        // A backwards clock step (NTP, DST, a manual change) dates a banner in the future. That is
        // the opposite of stale.
        assert!(!should_expire(-1.0, 30.0));
        assert!(!should_expire(-100_000.0, 30.0));
        // Broken arithmetic upstream must not be acted on.
        assert!(!should_expire(f64::NAN, 30.0));
        assert!(!should_expire(f64::INFINITY, 30.0));
        assert!(!should_expire(60.0, f64::NAN));
        assert!(!should_expire(60.0, f64::INFINITY));
    }

    // A zero age with a zero TTL would expire every banner the instant it is delivered — the one
    // degenerate combination that is destructive rather than merely useless.
    #[test]
    fn a_zero_ttl_is_not_smuggled_in_through_a_zero_age() {
        assert!(should_expire(0.0, 0.0), "the predicate itself is honest about 0 >= 0");
        assert!(
            !sweep_is_finer_than_ttl(0.0, NOTIFICATION_SWEEP_SECS),
            "so a zero TTL must be rejected by the config invariant instead"
        );
    }

    // The TTL is what stops mac-notification-sys's 0.5s main-run-loop poll of
    // `deliveredNotifications` (a synchronous XPC call, per notification) from running forever. A
    // sweep coarser than the TTL cannot enforce it: a banner would linger — and keep polling — for
    // up to a full extra interval past the deadline that exists to stop exactly that.
    #[test]
    fn the_shipped_sweep_interval_can_actually_enforce_the_shipped_ttl() {
        assert!(
            sweep_is_finer_than_ttl(NOTIFICATION_TTL_SECS, NOTIFICATION_SWEEP_SECS),
            "sweep {NOTIFICATION_SWEEP_SECS}s cannot enforce a {NOTIFICATION_TTL_SECS}s TTL"
        );
        // The shorter TTL is the binding one — a sweep fine enough for 300s is trivially too coarse
        // for 30s, so checking only the generous constant would pass while the pressure path is
        // unenforceable.
        assert!(
            sweep_is_finer_than_ttl(NOTIFICATION_PRESSURE_TTL_SECS, NOTIFICATION_SWEEP_SECS),
            "sweep {NOTIFICATION_SWEEP_SECS}s cannot enforce the \
             {NOTIFICATION_PRESSURE_TTL_SECS}s pressure TTL"
        );
    }

    // ── effective_ttl_secs ────────────────────────────────────────────────────────────────────
    // Why this exists at all: `send()` parks a thread until its banner leaves
    // `deliveredNotifications`, so the sweep removing an entry is what frees the slot — slot
    // lifetime IS the TTL. At a flat 300s the sustained ceiling is one cap's worth of banners per
    // five minutes, and past the cap `notify_attention` drops the banner with no Notification
    // Center entry and therefore no click-to-route at all.

    #[test]
    fn slack_keeps_the_generous_ttl_so_click_through_survives_a_coffee_break() {
        assert_eq!(effective_ttl_secs(0, 12, 300.0, 30.0), 300.0);
        assert_eq!(effective_ttl_secs(11, 12, 300.0, 30.0), 300.0);
    }

    // The assertion that could not have passed before this change: at pressure the sweep must
    // shorten, or slots never free fast enough and arrivals are dropped on the floor.
    #[test]
    fn pressure_collapses_the_ttl_so_slots_free_instead_of_banners_dropping() {
        assert_eq!(effective_ttl_secs(12, 12, 300.0, 30.0), 30.0, "the threshold itself counts as pressure");
        assert_eq!(effective_ttl_secs(16, 12, 300.0, 30.0), 30.0);
        assert_eq!(effective_ttl_secs(usize::MAX, 12, 300.0, 30.0), 30.0);
    }

    // Assert the PROPERTY rather than today's numbers, so this keeps biting after a constant moves.
    #[test]
    fn more_pressure_never_lengthens_the_ttl() {
        let mut previous = f64::INFINITY;
        for in_flight in 0..=MAX_IN_FLIGHT_NOTIFICATIONS * 2 {
            let ttl = effective_ttl_secs(
                in_flight,
                NOTIFICATION_PRESSURE_AT,
                NOTIFICATION_TTL_SECS,
                NOTIFICATION_PRESSURE_TTL_SECS,
            );
            assert!(ttl <= previous, "TTL grew from {previous} to {ttl} at in_flight={in_flight}");
            assert!(ttl >= NOTIFICATION_PRESSURE_TTL_SECS && ttl <= NOTIFICATION_TTL_SECS);
            previous = ttl;
        }
    }

    // Fails safe if a future edit makes the "pressure" TTL the LONGER of the two: enforce the
    // shorter one either way. A too-short TTL costs click-through; a too-long one costs the main
    // thread, which is the failure this whole module exists to prevent.
    #[test]
    fn mis_ordered_ttls_resolve_to_the_shorter_one_not_the_labelled_one() {
        assert_eq!(effective_ttl_secs(0, 12, 30.0, 300.0), 300.0, "with slack, the longer is fine");
        assert_eq!(effective_ttl_secs(12, 12, 30.0, 300.0), 30.0, "under pressure, always the shorter");
    }

    // The shipped configuration must actually reach the pressure path BEFORE the drop path, or the
    // adaptive TTL is decorative: slots would exhaust while the sweep was still using 300s.
    #[test]
    fn the_shipped_pressure_threshold_trips_before_the_cap_drops_a_banner() {
        assert!(
            NOTIFICATION_PRESSURE_AT > 0 && NOTIFICATION_PRESSURE_AT < MAX_IN_FLIGHT_NOTIFICATIONS,
            "pressure must trip strictly inside the cap, not at 0 and not only once full"
        );
    }

    // ── select_evictions: WHICH banners go, and in what order ─────────────────────────────────
    // This lived in Objective-C for one round and that was the mistake this module's own doctrine
    // already forbade: an eviction comparator is invertible, and from ObjC no CI test could see it.
    // `removal_budget` decides how many, never which — so a flipped sort was invisible.

    #[test]
    fn nothing_stale_means_nothing_evicted() {
        assert!(select_evictions(&[1.0, 2.0, 29.9], 30.0, u32::MAX).is_empty());
        assert!(select_evictions(&[], 30.0, u32::MAX).is_empty());
    }

    // THE POLARITY. Newest-first would kill the click-through route for the agent that JUST asked
    // while leaving the five-minute-old banners polling — the precise harm the budget exists to
    // prevent, and one character to introduce.
    #[test]
    fn the_oldest_banner_goes_first_not_the_newest() {
        // index:            0     1      2      3
        let ages = [100.0, 400.0, 350.0, 40.0];
        assert_eq!(
            select_evictions(&ages, 30.0, u32::MAX),
            vec![1, 2, 0, 3],
            "descending age: 400, 350, 100, 40"
        );
        // And with a budget, the OLDEST are the ones taken — not merely any two.
        assert_eq!(select_evictions(&ages, 30.0, 2), vec![1, 2]);
        assert_eq!(select_evictions(&ages, 30.0, 1), vec![1]);
    }

    #[test]
    fn only_banners_past_the_ttl_are_candidates_at_all() {
        // 20s and 5s are younger than the TTL, so they must survive however large the budget.
        let ages = [20.0, 400.0, 5.0, 60.0];
        assert_eq!(select_evictions(&ages, 30.0, u32::MAX), vec![1, 3]);
    }

    // Fails CLOSED, same as `should_expire`: an undatable banner (NaN age, both delivery dates nil)
    // and a banner from a backwards clock step are KEPT, never guessed at.
    #[test]
    fn undatable_and_future_dated_banners_are_never_evicted() {
        let ages = [f64::NAN, -50.0, f64::INFINITY, 400.0];
        assert_eq!(select_evictions(&ages, 30.0, u32::MAX), vec![3]);
    }

    // THE CEILING MUST HOLD AT THE CHOKEPOINT, not one caller away. It was enforced only in
    // `removal_budget` while both ABI docs advertised u32::MAX as unbudgeted, so a second call site
    // — a "sweep now" command, a shutdown drain, a test harness — following those docs would have
    // restored the arbitrarily large main-thread dispatch_sync batch with every test still green,
    // because the ceiling test asserted against `removal_budget` and never against the value the
    // sweep actually hands across the FFI.
    #[test]
    fn no_caller_can_request_an_unbounded_batch_however_large_the_budget() {
        let ages: Vec<f64> = (0..200).map(|i| 400.0 + i as f64).collect();
        assert_eq!(
            select_evictions(&ages, 30.0, u32::MAX).len(),
            MAX_EVICTIONS_PER_SWEEP as usize,
            "u32::MAX must mean 'no pressure rationing', never 'no limit'"
        );
        assert_eq!(select_evictions(&ages, 30.0, 1_000).len(), MAX_EVICTIONS_PER_SWEEP as usize);
        // And it is still the OLDEST that go, not merely the first eight encountered.
        assert_eq!(select_evictions(&ages, 30.0, u32::MAX)[0], 199, "oldest is the largest age");
    }

    // The FFI shim is the real boundary — ObjC cannot see the Rust clamp, so assert the shim itself
    // refuses to write more than the ceiling even when handed a buffer large enough to take more.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_ffi_shim_never_writes_more_than_the_ceiling() {
        let ages: Vec<f64> = (0..200).map(|i| 400.0 + i as f64).collect();
        let mut out = vec![0u32; ages.len()];
        let written = unsafe {
            super::sparkle_select_notifications_to_evict(
                ages.as_ptr(),
                ages.len(),
                30.0,
                u32::MAX,
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert_eq!(written, MAX_EVICTIONS_PER_SWEEP as usize);
        assert_eq!(out[0], 199, "and still oldest-first across the boundary");
    }

    // Null / zero inputs must not read or write anything — the shim is the one place a caller
    // mistake becomes undefined behaviour rather than a wrong answer.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_ffi_shim_refuses_degenerate_buffers() {
        let ages = [400.0f64];
        let mut out = [0u32; 1];
        unsafe {
            assert_eq!(
                super::sparkle_select_notifications_to_evict(
                    std::ptr::null(), 1, 30.0, 8, out.as_mut_ptr(), out.len()),
                0
            );
            assert_eq!(
                super::sparkle_select_notifications_to_evict(
                    ages.as_ptr(), 1, 30.0, 8, std::ptr::null_mut(), 1),
                0
            );
            assert_eq!(
                super::sparkle_select_notifications_to_evict(
                    ages.as_ptr(), 0, 30.0, 8, out.as_mut_ptr(), out.len()),
                0
            );
            assert_eq!(
                super::sparkle_select_notifications_to_evict(
                    ages.as_ptr(), 1, 30.0, 8, out.as_mut_ptr(), 0),
                0
            );
        }
    }

    #[test]
    fn a_zero_budget_removes_nothing_however_stale() {
        assert!(select_evictions(&[9_999.0, 8_888.0], 30.0, 0).is_empty());
    }

    // Equal ages must not reorder run to run — the daemon's own list order is not something to hang
    // an eviction policy on, and a nondeterministic log is hard to reason about after the fact.
    #[test]
    fn ties_break_by_index_so_the_order_is_deterministic() {
        assert_eq!(select_evictions(&[400.0, 400.0, 400.0], 30.0, 2), vec![0, 1]);
    }

    // The budget is a cap, not a target: asking for more than exists must not panic or pad.
    #[test]
    fn a_budget_larger_than_the_candidate_set_is_harmless() {
        assert_eq!(select_evictions(&[400.0], 30.0, 99), vec![0]);
    }

    // ── removal_budget ────────────────────────────────────────────────────────────────────────
    // The other half of effective_ttl_secs, and the fix for a defect the adaptive TTL introduced:
    // the ObjC sweep applies its TTL to the WHOLE delivered list, so shortening the TTL under
    // pressure would remove every banner past the short deadline in one pass.

    #[test]
    fn with_slack_the_only_limit_is_the_unconditional_hop_ceiling() {
        assert_eq!(removal_budget(0, 12), MAX_EVICTIONS_PER_SWEEP);
        assert_eq!(removal_budget(11, 12), MAX_EVICTIONS_PER_SWEEP, "still below the threshold");
    }

    // Every removal is a synchronous XPC call inside the sweep's single dispatch_sync to main, so an
    // unbounded batch IS a main-thread stall — and the pressure budget does not bound it, because
    // with slack there is nothing to ration. The launch case is the worst: the sweep starts early on
    // purpose to collect a previous run's banners, so the first tick can meet a huge backlog at zero
    // pressure. This is the assertion that would have caught that.
    #[test]
    fn no_sweep_may_ever_remove_more_than_the_hop_ceiling() {
        for in_flight in 0..=1_000 {
            assert!(
                removal_budget(in_flight, NOTIFICATION_PRESSURE_AT) <= MAX_EVICTIONS_PER_SWEEP,
                "unbounded main-thread removal batch at in_flight={in_flight}"
            );
        }
    }

    // The ceiling must not quietly override the pressure budget, or relief stops being proportional.
    #[test]
    fn the_hop_ceiling_never_binds_under_pressure() {
        for in_flight in NOTIFICATION_PRESSURE_AT..=MAX_IN_FLIGHT_NOTIFICATIONS {
            let proportional = (in_flight - NOTIFICATION_PRESSURE_AT + 1) as u32;
            assert_eq!(
                removal_budget(in_flight, NOTIFICATION_PRESSURE_AT),
                proportional,
                "the ceiling clipped the proportional budget at in_flight={in_flight}"
            );
        }
    }

    // The assertion that could not pass before the fix: at pressure the sweep must free ONLY the
    // slots it needs. A global wipe at 12 in-flight destroys the click-through route for all twelve
    // waiting agents while four slots are still free — the same loss the adaptive TTL exists to
    // prevent, moved from the cap to a recurring mass eviction.
    #[test]
    fn pressure_frees_only_the_slots_it_needs_not_every_banner() {
        assert_eq!(removal_budget(12, 12), 1, "just over the line: free exactly one");
        assert_eq!(removal_budget(13, 12), 2);
        assert_eq!(removal_budget(16, 12), 5);
    }

    // The budget must land us strictly BELOW the threshold, or the next tick trips again on the
    // same count and the sweep ratchets a banner away every interval forever.
    #[test]
    fn the_budget_clears_the_threshold_rather_than_sitting_on_it() {
        for in_flight in NOTIFICATION_PRESSURE_AT..=MAX_IN_FLIGHT_NOTIFICATIONS {
            let freed = removal_budget(in_flight, NOTIFICATION_PRESSURE_AT) as usize;
            assert!(
                in_flight - freed < NOTIFICATION_PRESSURE_AT,
                "freeing {freed} from {in_flight} still leaves us at or above the threshold"
            );
        }
    }

    // A budget and a TTL are two different dials and must agree about when pressure starts —
    // otherwise the sweep either shortens the TTL with no budget to spend (the global wipe) or
    // budgets removals the long TTL will never produce.
    #[test]
    fn the_budget_and_the_short_ttl_switch_on_at_the_same_point() {
        for in_flight in 0..=MAX_IN_FLIGHT_NOTIFICATIONS * 2 {
            let rationed = under_pressure(in_flight, NOTIFICATION_PRESSURE_AT);
            let shortened = effective_ttl_secs(
                in_flight,
                NOTIFICATION_PRESSURE_AT,
                NOTIFICATION_TTL_SECS,
                NOTIFICATION_PRESSURE_TTL_SECS,
            ) == NOTIFICATION_PRESSURE_TTL_SECS;
            assert_eq!(rationed, shortened, "the two dials disagree at in_flight={in_flight}");
        }
    }

    // Assert the RULE, not today's two numbers, so this still bites after either constant moves.
    #[test]
    fn a_sweep_coarser_than_half_the_ttl_is_rejected() {
        assert!(sweep_is_finer_than_ttl(30.0, 15.0), "exactly half is the boundary and is allowed");
        assert!(!sweep_is_finer_than_ttl(30.0, 16.0), "past half the TTL cannot enforce it");
        assert!(!sweep_is_finer_than_ttl(30.0, 60.0), "a sweep slower than the TTL is useless");
        // Degenerate inputs must not read as "fine". A zero/negative interval is a hot loop, and a
        // zero TTL would expire banners the instant they are delivered.
        assert!(!sweep_is_finer_than_ttl(30.0, 0.0));
        assert!(!sweep_is_finer_than_ttl(0.0, 5.0));
        assert!(!sweep_is_finer_than_ttl(30.0, -5.0));
    }

    fn counts(pairs: &[(&str, i64)]) -> HashMap<String, i64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn empty_clears_the_badge() {
        assert_eq!(badge_total(&counts(&[])), None);
    }

    #[test]
    fn all_zero_clears_the_badge() {
        assert_eq!(badge_total(&counts(&[("main", 0), ("win-1", 0)])), None);
    }

    #[test]
    fn sums_across_windows() {
        assert_eq!(badge_total(&counts(&[("main", 2), ("win-1", 1)])), Some(3));
    }

    #[test]
    fn ignores_negative_contributions() {
        // A stray negative report must not drag the total below a real positive count.
        assert_eq!(badge_total(&counts(&[("main", 4), ("win-1", -10)])), Some(4));
    }
}
