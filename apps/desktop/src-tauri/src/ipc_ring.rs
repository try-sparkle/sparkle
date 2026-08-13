//! Per-request IPC timeline — the last N Tauri invokes, with each one split into the legs that
//! point at DIFFERENT culprits (bead `sparkle-i7ryx`).
//!
//! ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
//! On 2026-08-13 the app took 3-10 seconds to show a keystroke, and a `/usr/bin/sample` of the host
//! process said the main thread was 91% IDLE — 3962 of 4354 samples parked in `mach_msg`. That is
//! not a misleading reading, it is a STRUCTURAL blind spot: a CPU profile cannot see a hang that
//! lives in WAITING. `watchdog.rs` records the same discovery in its own header, and it had already
//! captured this exact episode automatically three times (07:06, 07:10, and the night before)
//! without any of those dumps being able to explain it.
//!
//! Re-reading that sample by thread rather than by CPU found the answer immediately: 38 threads
//! sitting inside `notes::run_bd` → `beads_cmd::run_cmd_timed`, one of them for 2.5 SECONDS, with a
//! flat tail of ~30 more at ~770 ms — the signature of a fan-out that all queued behind one lock at
//! the same instant. That is a fact about the IPC boundary that nothing in the process was recording,
//! so every latency question so far has been answered by re-reading a stack dump and guessing.
//!
//! ── WHY FOUR TIMESTAMPS AND NOT ONE DURATION ──────────────────────────────────────────────────
//! A single "this took 4200 ms" number would have left us exactly where the sample did. The legs
//! blame different things, and only splitting them tells you which:
//!
//!   * QUEUE   (renderer issued → we began)   — contention/starvation BEFORE the work starts. This
//!     is what a 50-100 request burst looks like from the inside.
//!   * HANDLER (we began → we finished)       — a slow backend call. This is where the `bd` bug is.
//!   * RETURN  (we finished → renderer got it)— the renderer is the bottleneck.
//!
//! This module owns the two middle stamps, which are the two that can be taken without the webview's
//! cooperation — deliberately, because during a wedged main thread the webview is the thing that is
//! stuck, so the Rust half must stand alone and never depend on the renderer answering.
//!
//! ── IT MUST NOT BECOME THE THING IT MEASURES ──────────────────────────────────────────────────
//! Same non-negotiable as `cmd_timing`, one step stricter. `cmd_timing::record` `try_lock`s and drops
//! a sample on contention; this path takes NO LOCK AT ALL. Every slot is plain atomics and the write
//! cursor is one `fetch_add`, so a recording thread can never wait on another recording thread and
//! there is no `DROPPED` counter to explain, because nothing is dropped for contention.
//!
//! No allocation and no formatting happen here either. Command names are interned to a `u16` once,
//! never `to_string()`d per invoke (which is what today's armed `cmd_timing::record` does).
//! Formatting — and the `redact_secrets` pass that `redacting_writer.rs` applies to every logged
//! line, 7 regexes twice over — happens ONLY at dump time, once per episode. Pushing this ring
//! through `tracing::info!` line by line during a hang would be pathological, and on the very thread
//! we are trying to unblock (bead `sparkle-zllfb`).
//!
//! ── WHY A LATE COMPLETION CANNOT CORRUPT A LIVE SLOT ──────────────────────────────────────────
//! A ring recycles. An `async` command that takes 2.5 s (the ones we care about MOST) can easily
//! outlive its own slot when the ring wraps underneath it, and a naive `complete()` would then stamp
//! its finish time onto a STRANGER'S request — inventing a fast handler for a request that is still
//! running and losing the slow one. So a `Ticket` carries the `rid` it was issued for and
//! `complete()` writes only if the slot still holds it. This is the single subtlest property in the
//! module and `a_late_completion_for_a_recycled_slot_is_discarded` is the test that pins it.

use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Slots retained. Power of two so the index is a mask rather than a modulo.
///
/// Capacity is in REQUESTS, not seconds — at a quiet rate this holds far more than the 60 s the bead
/// asks for, and during a burst it holds less. That is why a dump reports the span it ACTUALLY
/// covers rather than claiming a window it may not have. 16384 covers 60 s at up to ~273 invokes/sec.
pub const CAPACITY: usize = 16_384;
const MASK: u64 = (CAPACITY as u64) - 1;

/// Armed by default — the whole point of the bead. An opt-in probe is disarmed at exactly the moment
/// it is needed, which is why the existing `SPARKLE_CMD_TIMING` meter could not explain this morning.
/// The killswitch exists so a field problem can be turned off without a rebuild.
static ENABLED: AtomicBool = AtomicBool::new(true);

/// Next slot to write. Wraps; `& MASK` turns it into an index.
static CURSOR: AtomicU64 = AtomicU64::new(0);

/// Correlation ids. Starts at 1 so 0 is reliably "no request" in an untouched slot.
static NEXT_RID: AtomicU64 = AtomicU64::new(1);

/// Requests dispatched but not yet completed. Recorded per request so a fan-out is visible as a
/// NUMBER rather than inferred by eyeballing timestamps.
static IN_FLIGHT: AtomicU32 = AtomicU32::new(0);

/// Requests that arrived with NO renderer correlation id.
///
/// Counted rather than ignored because it is the only way to tell "the renderer half is not
/// installed" from "the renderer half is installed and its rows genuinely did not join" — and a
/// dump that silently showed no queue leg for either would look identical in both cases.
static UNJOINED: AtomicU64 = AtomicU64::new(0);

/// Process start, the epoch for every stamp. `Instant` is not storable in an atomic, so stamps are
/// nanos since this. u64 nanos overflows after ~584 years.
fn epoch() -> Instant {
    static E: OnceLock<Instant> = OnceLock::new();
    *E.get_or_init(Instant::now)
}

/// Nanos since process epoch. Public because the protocol handler stamps ENTRY before it knows
/// enough to call [`begin_traced`], and both stamps must come off the same clock or the leg between
/// them is meaningless.
pub fn now_ns() -> u64 {
    epoch().elapsed().as_nanos() as u64
}

/// Flag bits on a recorded request.
pub mod flags {
    pub const ON_MAIN_THREAD: u8 = 1 << 0;
    pub const COMPLETED: u8 = 1 << 1;
    pub const ERRORED: u8 = 1 << 2;
}

/// One request. Every field is an atomic so recording never takes a lock — see the module note.
#[derive(Default)]
struct Slot {
    rid: AtomicU64,
    /// The renderer's own id for this request, 0 when it did not send one. This is the JOIN KEY
    /// between the two halves of the instrument: without it the renderer's "I issued at T" and our
    /// "we entered at T'" are two unrelated lists and the QUEUE leg cannot be computed at all.
    corr_id: AtomicU64,
    /// When the URI-scheme handler was ENTERED, which is strictly before dispatch. The gap between
    /// the two is our own parse cost — small, but it is OUR cost, and folding it into the queue leg
    /// would blame the renderer for it while folding it into the handler would blame the backend.
    t_entry_ns: AtomicU64,
    t_dispatch_ns: AtomicU64,
    t_complete_ns: AtomicU64,
    arg_bytes: AtomicU32,
    ret_bytes: AtomicU32,
    cmd_id: AtomicU16,
    in_flight: AtomicU16,
    flags: AtomicU8,
}

fn slots() -> &'static [Slot] {
    static S: OnceLock<Box<[Slot]>> = OnceLock::new();
    S.get_or_init(|| (0..CAPACITY).map(|_| Slot::default()).collect::<Vec<_>>().into_boxed_slice())
}

/// Handle returned by [`begin`], carrying the identity a completion must prove before it may write.
///
/// `rid` is the guard: see the module note on recycled slots. A `Ticket` is deliberately NOT `Copy`
/// and NOT `Clone` so one dispatch cannot stamp two completions.
#[derive(Debug)]
pub struct Ticket {
    idx: u64,
    rid: u64,
}

impl Ticket {
    pub fn rid(&self) -> u64 {
        self.rid
    }
}

/// Interned command names. A name is turned into a `u16` ONCE; the hot path stores the integer.
///
/// This is the allocation that today's armed `cmd_timing::record` pays per invoke (`command.to_string()`)
/// and that this module exists partly to remove. The lock is taken only on a name's FIRST sighting —
/// there are 344 commands in the crate, so after warmup this is a pure read.
fn interner() -> &'static Mutex<Vec<String>> {
    static I: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    I.get_or_init(|| Mutex::new(Vec::new()))
}

/// Intern `name`, returning its id. Falls back to `u16::MAX` ("unknown") rather than blocking if the
/// table is momentarily held — the never-block rule outranks perfect naming.
pub fn intern(name: &str) -> u16 {
    let Ok(mut table) = interner().try_lock() else { return u16::MAX };
    if let Some(i) = table.iter().position(|n| n == name) {
        return i as u16;
    }
    if table.len() >= u16::MAX as usize {
        return u16::MAX;
    }
    table.push(name.to_string());
    (table.len() - 1) as u16
}

/// Resolve an interned id back to a name. Dump-time only.
pub fn name_of(cmd_id: u16) -> Option<String> {
    let table = interner().try_lock().ok()?;
    table.get(cmd_id as usize).cloned()
}

/// The whole interned table, oldest id first. Dump-time only — this is the lookup side of the
/// columnar dump, whose rows carry `cmd` as an INDEX into this rather than a repeated string.
pub fn name_table() -> Vec<String> {
    interner().try_lock().map(|t| t.clone()).unwrap_or_default()
}

/// What a name interned for a name we refuse to record looks like in the table.
pub const INVALID_COMMAND: &str = "<invalid>";

/// Does `name` look like a command this app could actually dispatch?
///
/// `^[a-z0-9_]+$` for an app command, `^plugin:[a-z0-9_-]+\|[a-z0-9_]+$` for a plugin one. Written
/// as a hand rolled scan rather than a `regex` so it stays allocation-free and compiles no pattern
/// on the IPC path.
pub fn is_valid_command_name(name: &str) -> bool {
    fn is_bare(s: &str) -> bool {
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    }
    if let Some(rest) = name.strip_prefix("plugin:") {
        let Some((plugin, cmd)) = rest.split_once('|') else { return false };
        let plugin_ok = !plugin.is_empty()
            && plugin
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
        return plugin_ok && is_bare(cmd);
    }
    is_bare(name)
}

/// Intern a command name that came off the WIRE.
///
/// The command is the URL path of an `ipc://` request, so it is caller-supplied text: a renderer
/// bug — or anything that can reach the scheme — could otherwise push unbounded distinct strings
/// into a table that never shrinks, and put arbitrary bytes into a file a human is asked to attach
/// to a bug report. Anything outside the shape above is collapsed onto one `<invalid>` sentinel, so
/// the table stays bounded by the 344 real commands and the dump carries no caller text.
pub fn intern_command(name: &str) -> u16 {
    if is_valid_command_name(name) {
        intern(name)
    } else {
        intern(INVALID_COMMAND)
    }
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// Outstanding requests right now.
pub fn in_flight() -> u32 {
    IN_FLIGHT.load(Ordering::Relaxed)
}

/// Note that a request arrived without a renderer correlation id.
pub fn note_unjoined() {
    UNJOINED.fetch_add(1, Ordering::Relaxed);
}

/// How many requests have arrived with no renderer correlation id since the last [`reset`].
pub fn unjoined() -> u64 {
    UNJOINED.load(Ordering::Relaxed)
}

/// Every request ever recorded, including the ones the ring has since overwritten.
///
/// The difference between this and `snapshot().len()` is the EVICTED count, and a dump reports it
/// so a reader can tell a quiet 60 seconds from a burst that overflowed the ring in four.
pub fn total_seen() -> u64 {
    CURSOR.load(Ordering::Relaxed)
}

/// Record that a request has begun. Returns `None` when disarmed, so callers pay one relaxed load.
///
/// Convenience over [`begin_traced`] for callers with no renderer correlation id and no separate
/// entry stamp — the entry stamp then collapses onto dispatch, which is the honest reading rather
/// than a zero that a dump would have to special-case.
pub fn begin(cmd_id: u16, arg_bytes: u32, on_main: bool) -> Option<Ticket> {
    begin_traced(cmd_id, arg_bytes, on_main, 0, 0)
}

/// Record that a request has begun, carrying the renderer's correlation id and the instant the
/// protocol handler was entered.
///
/// `corr_id` of 0 means the renderer sent no id (see [`note_unjoined`]); `t_entry_ns` of 0 means
/// the caller took no separate entry stamp and it collapses onto dispatch.
///
/// Claims a slot with a single `fetch_add` — no lock, so this can never wait on another recorder.
pub fn begin_traced(
    cmd_id: u16,
    arg_bytes: u32,
    on_main: bool,
    corr_id: u64,
    t_entry_ns: u64,
) -> Option<Ticket> {
    if !is_enabled() {
        return None;
    }
    let rid = NEXT_RID.fetch_add(1, Ordering::Relaxed);
    let outstanding = IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
    let idx = CURSOR.fetch_add(1, Ordering::Relaxed);
    let s = &slots()[(idx & MASK) as usize];

    // t_complete is cleared FIRST and rid published LAST. A reader that sees this rid therefore
    // never sees the previous occupant's completion time attached to it.
    s.t_complete_ns.store(0, Ordering::Relaxed);
    let t_dispatch = now_ns();
    s.t_dispatch_ns.store(t_dispatch, Ordering::Relaxed);
    s.t_entry_ns.store(if t_entry_ns == 0 { t_dispatch } else { t_entry_ns }, Ordering::Relaxed);
    s.corr_id.store(corr_id, Ordering::Relaxed);
    s.arg_bytes.store(arg_bytes, Ordering::Relaxed);
    s.ret_bytes.store(0, Ordering::Relaxed);
    s.cmd_id.store(cmd_id, Ordering::Relaxed);
    s.in_flight.store(outstanding.min(u16::MAX as u32) as u16, Ordering::Relaxed);
    s.flags.store(if on_main { flags::ON_MAIN_THREAD } else { 0 }, Ordering::Relaxed);
    s.rid.store(rid, Ordering::Release);
    Some(Ticket { idx, rid })
}

/// Record that a request has finished.
///
/// Writes ONLY if the slot still holds this ticket's `rid`. A slow `async` command can outlive its
/// slot, and stamping a stranger's request would invent a fast handler for a request that is still
/// running while losing the slow one — see the module note.
pub fn complete(ticket: Ticket, ret_bytes: u32, errored: bool) {
    IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    let s = &slots()[(ticket.idx & MASK) as usize];
    if s.rid.load(Ordering::Acquire) != ticket.rid {
        return; // recycled underneath us; the newer request owns this slot now
    }
    s.ret_bytes.store(ret_bytes, Ordering::Relaxed);
    let mut f = s.flags.load(Ordering::Relaxed) | flags::COMPLETED;
    if errored {
        f |= flags::ERRORED;
    }
    s.flags.store(f, Ordering::Relaxed);
    s.t_complete_ns.store(now_ns(), Ordering::Relaxed);
    // Re-check: a wrap between the guard above and here would mean we just wrote a stranger's slot.
    if s.rid.load(Ordering::Acquire) != ticket.rid {
        s.t_complete_ns.store(0, Ordering::Relaxed);
    }
}

/// One request, decoded for a reader. Dump-time only — nothing on the hot path builds this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub rid: u64,
    /// The renderer's id for this request, or 0 when it sent none. The join key for the QUEUE leg.
    pub corr_id: u64,
    pub command: String,
    /// The interned id behind `command`, so a columnar dump can emit an index instead of repeating
    /// the string on every row.
    pub cmd_id: u16,
    /// When the protocol handler was entered — at or before `t_dispatch_ns`.
    pub t_entry_ns: u64,
    pub t_dispatch_ns: u64,
    /// `None` while still running — which during a hang is the MOST interesting state, since it
    /// names the request that never came back.
    pub handler_ns: Option<u64>,
    pub arg_bytes: u32,
    pub ret_bytes: u32,
    pub in_flight: u16,
    pub on_main_thread: bool,
    pub errored: bool,
}

/// Every retained request, oldest first.
pub fn snapshot() -> Vec<Record> {
    let cursor = CURSOR.load(Ordering::Relaxed);
    let start = cursor.saturating_sub(CAPACITY as u64);
    let mut out = Vec::new();
    for i in start..cursor {
        let s = &slots()[(i & MASK) as usize];
        let rid = s.rid.load(Ordering::Acquire);
        if rid == 0 {
            continue;
        }
        let t0 = s.t_dispatch_ns.load(Ordering::Relaxed);
        let t1 = s.t_complete_ns.load(Ordering::Relaxed);
        let f = s.flags.load(Ordering::Relaxed);
        let cmd_id = s.cmd_id.load(Ordering::Relaxed);
        out.push(Record {
            rid,
            corr_id: s.corr_id.load(Ordering::Relaxed),
            command: name_of(cmd_id).unwrap_or_else(|| "<unknown>".to_string()),
            cmd_id,
            t_entry_ns: s.t_entry_ns.load(Ordering::Relaxed),
            t_dispatch_ns: t0,
            handler_ns: if t1 > t0 && f & flags::COMPLETED != 0 { Some(t1 - t0) } else { None },
            arg_bytes: s.arg_bytes.load(Ordering::Relaxed),
            ret_bytes: s.ret_bytes.load(Ordering::Relaxed),
            in_flight: s.in_flight.load(Ordering::Relaxed),
            on_main_thread: f & flags::ON_MAIN_THREAD != 0,
            errored: f & flags::ERRORED != 0,
        });
    }
    out
}

/// Drop everything. Tests, and marking the start of a measurement window.
pub fn reset() {
    for s in slots() {
        s.rid.store(0, Ordering::Relaxed);
        s.corr_id.store(0, Ordering::Relaxed);
        s.t_entry_ns.store(0, Ordering::Relaxed);
        s.t_dispatch_ns.store(0, Ordering::Relaxed);
        s.t_complete_ns.store(0, Ordering::Relaxed);
        s.flags.store(0, Ordering::Relaxed);
    }
    CURSOR.store(0, Ordering::Relaxed);
    IN_FLIGHT.store(0, Ordering::Relaxed);
    UNJOINED.store(0, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One process-global ring, so tests that touch it must not interleave.
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        static G: OnceLock<Mutex<()>> = OnceLock::new();
        G.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The headline claim: HANDLER time is measured, not dispatch time.
    ///
    /// Goes red if `complete` stops stamping, or if `handler_ns` is derived from anything but the
    /// two stamps. Asserts a real elapsed duration rather than "a record exists", because a record
    /// existing was already true before `complete` was written.
    #[test]
    fn a_completed_request_records_its_handler_duration() {
        let _g = guard();
        reset();
        set_enabled(true);
        let cmd = intern("slow_command");
        let t = begin(cmd, 12, false).expect("armed");
        std::thread::sleep(std::time::Duration::from_millis(20));
        complete(t, 340, false);

        let rows = snapshot();
        let r = rows.iter().find(|r| r.command == "slow_command").expect("recorded");
        let handler = r.handler_ns.expect("a completed request must carry a handler duration");
        assert!(
            handler >= 15_000_000,
            "handler must measure the ~20ms the work actually took, got {handler}ns"
        );
        assert_eq!(r.ret_bytes, 340, "response size must come from the completion, not the start");
        assert_eq!(r.arg_bytes, 12);
    }

    /// A request still running has NO handler duration — it must not read as instantaneous.
    ///
    /// This is the pair to the test above: during a hang the request that never came back is the
    /// most interesting row in the dump, and reporting it as 0ns would hide exactly the thing we
    /// built this to find.
    #[test]
    fn an_unfinished_request_reports_no_handler_duration() {
        let _g = guard();
        reset();
        set_enabled(true);
        let cmd = intern("still_running");
        let _t = begin(cmd, 0, false).expect("armed");

        let rows = snapshot();
        let r = rows.iter().find(|r| r.command == "still_running").expect("recorded at dispatch");
        assert_eq!(r.handler_ns, None, "an in-flight request must not report a duration");
    }

    /// The subtlest property in the module. A slow `async` command can outlive its own slot; if a
    /// late `complete` wrote anyway it would stamp a STRANGER'S request — inventing a fast handler
    /// for a request that is still running, and losing the slow one.
    ///
    /// Goes red the moment the `rid` guard in `complete` is removed.
    #[test]
    fn a_late_completion_for_a_recycled_slot_is_discarded() {
        let _g = guard();
        reset();
        set_enabled(true);
        let victim = intern("victim");
        let usurper = intern("usurper");

        let stale = begin(victim, 0, false).expect("armed");
        // Wrap the ring all the way around so `stale`'s slot is reissued to someone else.
        for _ in 0..CAPACITY {
            let t = begin(usurper, 0, false).expect("armed");
            complete(t, 1, false);
        }
        // The victim finally finishes, long after its slot was handed to another request.
        complete(stale, 999, false);

        let rows = snapshot();
        assert!(
            rows.iter().all(|r| r.ret_bytes != 999),
            "a late completion must not write into the slot its request no longer owns"
        );
    }

    /// A fan-out must be visible as a number. This is the field that turns "this took 4s" into
    /// "this took 4s and 87 others were outstanding when it started" — the shape of the 50-100
    /// request burst `AgentSidebar` fires every 15s.
    #[test]
    fn in_flight_counts_requests_outstanding_at_dispatch() {
        let _g = guard();
        reset();
        set_enabled(true);
        let cmd = intern("burst");

        let held: Vec<Ticket> = (0..5).map(|_| begin(cmd, 0, false).expect("armed")).collect();
        let last = begin(cmd, 0, false).expect("armed");

        let rows = snapshot();
        let r = rows.iter().find(|r| r.rid == last.rid()).expect("recorded");
        assert_eq!(r.in_flight, 5, "five requests were outstanding when the sixth was dispatched");

        // And it must come back down, or every later reading is inflated.
        for t in held {
            complete(t, 0, false);
        }
        complete(last, 0, false);
        assert_eq!(in_flight(), 0, "completions must release their in-flight slot");
    }

    /// Retention: the ring keeps the NEWEST `CAPACITY`, not the oldest.
    #[test]
    fn the_ring_retains_the_most_recent_capacity_requests() {
        let _g = guard();
        reset();
        set_enabled(true);
        let cmd = intern("flood");
        for _ in 0..(CAPACITY + 100) {
            let t = begin(cmd, 0, false).expect("armed");
            complete(t, 0, false);
        }
        let rows = snapshot();
        assert_eq!(rows.len(), CAPACITY, "exactly capacity retained");
        let first = rows.first().expect("non-empty").rid;
        let last = rows.last().expect("non-empty").rid;
        assert_eq!(last - first, CAPACITY as u64 - 1, "contiguous window");
        assert!(first > 100, "the oldest 100 must have been evicted, not the newest");
    }

    /// The killswitch actually stops recording — not merely flips a flag.
    #[test]
    fn a_disarmed_ring_records_nothing() {
        let _g = guard();
        reset();
        set_enabled(false);
        let cmd = intern("ignored");
        assert!(begin(cmd, 0, false).is_none(), "disarmed begin must not issue a ticket");
        assert!(snapshot().is_empty(), "disarmed ring must hold no records");
        set_enabled(true);
    }

    /// The renderer's correlation id must survive into the record, and the entry stamp must be
    /// distinguishable from dispatch.
    ///
    /// Goes red if `begin_traced` drops either — which is exactly the failure that would leave the
    /// two halves of the instrument as two unjoinable lists, with no QUEUE leg computable at all.
    /// Asserts the values came from the CALLER rather than merely being non-zero: a `t_entry_ns`
    /// defaulted from dispatch would still be non-zero, so `!= 0` proves nothing here.
    #[test]
    fn a_correlated_request_carries_the_renderers_join_key_and_its_own_entry_stamp() {
        let _g = guard();
        reset();
        set_enabled(true);
        let cmd = intern("joined_command");
        let entry = now_ns();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let t = begin_traced(cmd, 4, false, 0xDEAD_BEEF, entry).expect("armed");
        complete(t, 8, false);

        let rows = snapshot();
        let r = rows.iter().find(|r| r.command == "joined_command").expect("recorded");
        assert_eq!(r.corr_id, 0xDEAD_BEEF, "the renderer's id must reach the record verbatim");
        assert_eq!(r.t_entry_ns, entry, "the entry stamp must be the CALLER's, not re-taken");
        assert!(
            r.t_dispatch_ns > r.t_entry_ns,
            "dispatch must be strictly after the entry the caller passed ({} vs {})",
            r.t_dispatch_ns,
            r.t_entry_ns
        );
    }

    /// A request with no correlation id collapses its entry stamp onto dispatch rather than
    /// recording a 0 that every reader would have to special-case.
    #[test]
    fn an_uncorrelated_request_collapses_its_entry_stamp_onto_dispatch() {
        let _g = guard();
        reset();
        set_enabled(true);
        let cmd = intern("unjoined_command");
        let t = begin(cmd, 0, false).expect("armed");
        complete(t, 0, false);

        let rows = snapshot();
        let r = rows.iter().find(|r| r.command == "unjoined_command").expect("recorded");
        assert_eq!(r.corr_id, 0, "no renderer id means 0, the reserved absent value");
        assert_eq!(
            r.t_entry_ns, r.t_dispatch_ns,
            "with no separate entry stamp the two must coincide, not read as epoch 0"
        );
    }

    /// "The renderer half is not installed" and "it is installed and these rows did not join" must
    /// be distinguishable in a dump. Both show no queue leg, so only a COUNTER separates them.
    ///
    /// Goes red if `note_unjoined` stops accumulating or `reset` stops clearing it.
    #[test]
    fn unjoined_requests_are_counted_rather_than_silently_ignored() {
        let _g = guard();
        reset();
        assert_eq!(unjoined(), 0, "reset must clear the counter");
        note_unjoined();
        note_unjoined();
        note_unjoined();
        assert_eq!(unjoined(), 3, "every id-less request must be counted");
    }

    /// The command comes off a URL, so it is caller-supplied text. Anything outside the allowed
    /// shape must collapse onto ONE sentinel.
    ///
    /// Goes red if `intern_command` stops validating: the assertion is that a hundred DISTINCT
    /// junk names do not grow the table by a hundred entries, which is the bound that keeps a
    /// renderer bug from turning the interner into an unbounded leak — and that keeps arbitrary
    /// caller bytes out of a file a human is asked to attach to a bug report.
    #[test]
    fn junk_command_names_collapse_onto_one_sentinel_instead_of_growing_the_table() {
        let _g = guard();
        let before = name_table().len();
        let ids: Vec<u16> = (0..100)
            .map(|i| intern_command(&format!("../etc/passwd?attempt={i} <script>")))
            .collect();

        assert!(ids.windows(2).all(|w| w[0] == w[1]), "every junk name must intern to one id");
        assert_eq!(name_of(ids[0]).as_deref(), Some(INVALID_COMMAND));
        assert!(
            name_table().len() <= before + 1,
            "100 distinct junk names must add at most the one sentinel, not 100 entries"
        );

        // …and the guard must not eat REAL commands, or the dump names nothing.
        assert_eq!(name_of(intern_command("fleet_digest")).as_deref(), Some("fleet_digest"));
        assert_eq!(
            name_of(intern_command("plugin:global-shortcut|register")).as_deref(),
            Some("plugin:global-shortcut|register")
        );
    }

    /// The shapes the validator must accept and reject, pinned independently of the interner so a
    /// loosened pattern is caught here rather than only via table growth.
    #[test]
    fn the_command_name_guard_accepts_real_commands_and_rejects_wire_junk() {
        for ok in ["fleet_digest", "app_version", "x", "cmd2", "plugin:deep-link|on_new_url"] {
            assert!(is_valid_command_name(ok), "{ok} is a real command shape");
        }
        for bad in [
            "",
            "Fleet_Digest",              // uppercase — not a command in this crate
            "fleet-digest",              // hyphen is only legal in a PLUGIN name
            "../../etc/passwd",
            "fleet digest",
            "plugin:foo",                // no `|command`
            "plugin:|register",          // empty plugin
            "plugin:foo|",               // empty command
            "plugin:foo|bar|baz",        // a second `|` lands in the command half
        ] {
            assert!(!is_valid_command_name(bad), "{bad:?} must be refused");
        }
    }

    /// A dump must be able to say how many requests it could NOT show. Capacity is in requests,
    /// so a burst that overflowed the ring in four seconds and a quiet minute look identical
    /// without this.
    #[test]
    fn total_seen_reveals_the_requests_the_snapshot_cannot_show() {
        let _g = guard();
        reset();
        set_enabled(true);
        let cmd = intern("overflow");
        for _ in 0..(CAPACITY + 250) {
            let t = begin(cmd, 0, false).expect("armed");
            complete(t, 0, false);
        }
        assert_eq!(total_seen(), CAPACITY as u64 + 250, "every request counted, not just retained");
        assert_eq!(
            total_seen() - snapshot().len() as u64,
            250,
            "the difference is the evicted count a dump reports"
        );
    }

    /// Interning is what keeps the hot path allocation-free, so the same name must not grow the
    /// table on every call.
    #[test]
    fn interning_is_stable_for_a_repeated_name() {
        let _g = guard();
        let a = intern("repeated_name");
        let b = intern("repeated_name");
        assert_eq!(a, b, "the same command must intern to the same id");
        assert_eq!(name_of(a).as_deref(), Some("repeated_name"));
    }
}
