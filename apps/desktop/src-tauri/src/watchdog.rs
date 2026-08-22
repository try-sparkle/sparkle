//! Notice that the main thread is wedged **while it is still wedged**, and capture proof.
//!
//! ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
//! On 2026-07-29 Sparkle beachballed twice during a window resize; the user waited a full minute
//! and force-quit. The app recorded NOTHING: no crash file, no panic-hook fire, no jank line. That
//! was not an oversight in what we chose to log — it is structural. Every instrument we had ran ON
//! the main thread:
//!
//!   * the panic hook only fires on a panic, and a hang is not one;
//!   * the rAF jank monitor (`perfTrace.ts`) can only report a stall AFTER it ends, because the
//!     thread that would write the line is the thread that is blocked. A logged stall is by
//!     definition a RECOVERED stall, so the fatal one is invisible by construction;
//!   * and the actual culprit — found later by `sample` — was the main thread parked in
//!     `semaphore_timedwait_trap` on a synchronous XPC call to the notification daemon. A thread
//!     asleep in the kernel cannot log its own condition.
//!
//! So the app could not report its own worst failure mode, and every future hang would have been
//! equally undiagnosable. This module is the fix, and its one non-negotiable property is that it
//! runs **off the main thread by construction** — a plain OS thread that never touches the UI, so
//! nothing the main thread does can stop it from writing.
//!
//! ── WHAT IT CAN AND CANNOT PROVE ──────────────────────────────────────────────────────────────
//! Its primary observation is ONE thing: heartbeats from the webview stopped while this thread kept
//! running. That is strong evidence of a blocked main thread but it is not proof, because on macOS
//! the webview's JS runs in a separate WebContent process — so a dead, crashed, or reloading content
//! process produces identical silence with a perfectly healthy main thread. The log lines are worded for
//! what is actually observed ("no heartbeat for Xms") rather than asserting a diagnosis, and the
//! restates back off exponentially so a permanently dead webview cannot fill the log with confident
//! false claims for the life of the process. That matters: this log is what the next person reads
//! to diagnose a real hang.
//!
//! ── AND WHY SILENCE ALONE IS NOT ENOUGH TO WATCH ──────────────────────────────────────────────
//! Silence is a BINARY verdict at a five-second bar, and a whole family of hangs lives underneath
//! it. Measured 2026-08-20: a user reported a 30-second unusable window and this module captured
//! nothing, correctly — the UI stalled seven to thirteen times a minute, lost 2.6-4.7 seconds of
//! every minute, and never once went quiet for the five seconds a report needs. Every instrument in
//! the app read green while the app was unusable.
//!
//! So there is a SECOND trigger, in the same pure state machine, over the same capture machinery: a
//! cumulative stall budget across a rolling ten-second window, fed by the aggregate `perfTrace.ts`
//! was already computing and discarding. See `STALL_BUDGET_MS` for the measurement that sets the
//! bar and for why it is a clustered window rather than a per-minute rate. It routes to the same
//! visible pool, behind the same limiter, so it cannot evict the evidence it exists to add to.
//!
//! ── AND WHY THE CAPTURE HAS TO SAMPLE MORE THAN ONE PROCESS ───────────────────────────────────
//! The paragraph above was written down and then not acted on, which cost the module most of its
//! value for a year. The trigger is a WEBVIEW heartbeat going silent, and the webview's JS runs in
//! a WebKit `WebContent` process — but `capture_stack_into` sampled `std::process::id()` and
//! nothing else, because `sample(1)` takes exactly one pid. So the one process most likely to be
//! frozen was never in the dump. Measured: 17 hang dumps on disk, NONE containing the frozen
//! thread; in the one studied in detail (a real 10.2s freeze) the host main thread was 91% parked
//! in `mach_msg`, which reads as "nothing was wrong" and sends the reader somewhere else entirely.
//!
//! Identifying OUR WebContent processes is the hard part, and no public API hands them over.
//! Verified live on macOS 26.6: every WebContent process on the machine has `ppid=1` and a
//! byte-identical command line
//! (`…/WebKit.framework/…/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent`),
//! and there were ten of them belonging to different apps. `pgrep`/`ps` therefore cannot tell you
//! which are yours, and pid adjacency is a coincidence, not a rule.
//!
//! CHOSEN: a before/after set difference (`note_webcontent_baseline` + `maintain_renderer_tracking`),
//! which uses no private API. REJECTED: an ObjC shim reading `[WKWebView _webProcessIdentifier]`.
//! The shim is exact, and if the diff ever proves unreliable it is the fallback — but it is private
//! API on an app that ships as a notarized DMG, and a diagnostic that can get the app rejected is a
//! bad trade for a diagnostic. The diff's failure mode is bounded and stated: when it cannot
//! attribute the new processes it records NONE of them, so the worst case is today's behaviour
//! (host-only) rather than a stranger's renderer landing in a user's log directory.
//!
//! ── HOW IT TELLS A HANG FROM A SLEEPING MACHINE ───────────────────────────────────────────────
//! This is the discrimination the webview cannot make (see the note above `startJankMonitor` in
//! perfTrace.ts: on this platform `performance.now()` keeps advancing through App Nap and display
//! sleep, so both of the webview's clocks agree in both cases). Here we start from our own tick:
//!
//!   * our sleep took roughly as long as we asked  → we were running normally. If heartbeats also
//!     stopped, something is genuinely wrong. REPORT.
//!   * our sleep took far longer than we asked     → ask a SECOND question, below.
//!
//! For a year that second line ended the reasoning: a long overshoot WAS a suspend, the episode was
//! discarded, and nothing was written down. That inference is wrong, and it is wrong in the
//! expensive direction. The overshoot measures how late THIS THREAD was scheduled, and a machine
//! starved of CPU produces it identically to a machine that slept — so on a loaded box the guard
//! granted amnesty to precisely the freezes it sits beneath. Measured on the reporting machine: load
//! average 191-201 while nominally idle and 366-520 with agents running, against a five-second bar.
//! On 2026-08-21 a 30-second TOTAL UI freeze produced no capture at all: the detector saw the gap,
//! called it a suspend, and threw it away in silence (`sparkle-rlmsb4`).
//!
//! So a long overshoot now asks a second question, of a clock that can actually answer it.
//! `mach_continuous_time()` counts the time a machine spends asleep and `mach_absolute_time()` does
//! not, so their difference across our sleep is suspended time — measured, not inferred:
//!
//!   * the machine slept through it → we were frozen alongside everything else and the missing
//!     heartbeats mean nothing. Rebaseline — and SAY SO, see `SUSPEND_LOG_MIN_INTERVAL`.
//!   * the machine was awake        → this thread was STARVED. The freeze is real and the user sat
//!     through it. Report it, and name starvation on the line, because the remedy is the host's load
//!     rather than the app's code. See `SUSPEND_CONFIRM` and `machine_was_suspended`.
//!
//! The anti-phantom property is preserved exactly: a genuine lid-open still produces no report, and
//! an UNREADABLE clock (off macOS, or a timebase we cannot fetch) falls back to the old inference
//! rather than to reporting — a phantom multi-hour hang on every wake is the worse of the two errors.
//!
//! The overshoot itself is still measured in WALL time (`SystemTime`) on purpose: the wall clock
//! always advances, so "how much real time passed during our sleep" has exactly one answer. The mach
//! pair is what then attributes that time to sleep or to starvation.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Runtime};

use crate::ipc_trace;

/// How often the watchdog wakes to check. Also the resolution of everything below.
const TICK: Duration = Duration::from_secs(1);

/// How long the main thread may be silent, WHILE VISIBLE, before we report and capture a stack.
///
/// Above the noise floor and below human patience. The webview heartbeats every second, so this is
/// several missed beats — not one late frame. Ordinary severe jank (the `jank stall` tail runs to
/// ~10s) will trip it, which is intended: those are the stalls we most want stacks for.
const HANG_AFTER: Duration = Duration::from_secs(5);

/// The same threshold while the window is HIDDEN. Deliberately an order of magnitude larger, and
/// hidden episodes are also quieter (`info`, not `warn` — see `is_reportable_evidence`) and their
/// stacks go to a separate, rate-limited, small pool — see `dump_target` and `may_capture_hidden`.
///
/// ── WHY THIS NUMBER IS SO MUCH BIGGER, AND WHY IT MOVED TWICE ─────────────────────────────────
/// The first version of this module disarmed completely while hidden. That is wrong in the
/// expensive direction: the 2026-07-29 root cause (`attention.rs`'s notification poll calling
/// `deliveredNotifications` synchronously) runs regardless of visibility, so the app can wedge while
/// backgrounded and the user meets the beachball when they click the dock icon. Disarming made
/// exactly that case unreportable.
///
/// The second version over-corrected to 60s, which is worse still, because **silence from a hidden
/// WKWebView is the DOCUMENTED behaviour, not a symptom**: the frontend heartbeat is a
/// `setInterval`, and a backgrounded webview has its timers throttled hard or stopped outright (see
/// `watchdogHeartbeat.ts`). At 60s every ordinary cmd-tab longer than a minute becomes a reported
/// episode with a multi-megabyte `sample(1)` capture of a perfectly healthy app — and since the dump
/// budget is finite (`MAX_HANG_DUMPS`), those false captures would EVICT the real hang stacks this
/// module exists to preserve. An instrument whose noise deletes its own evidence is worse than no
/// instrument.
///
/// Ten minutes is chosen because it is past every innocent explanation: throttled beats that still
/// trickle in at even one a minute never open an episode at all, and a webview whose timers stopped
/// outright opens exactly one, whose restates then back off. Note also that the case the 60s bar was
/// defending — a freeze that occludes the window on its way down — does NOT actually arrive here: a
/// wedged main thread cannot run the `visibilitychange` handler that would send the `hidden: true`
/// beat, so the last beat we hold still says VISIBLE and the 5s bar applies. That case was already
/// covered; the 60s bar bought nothing and cost the dump budget.
const HIDDEN_HANG_AFTER: Duration = Duration::from_secs(600);

/// ── THE FOURTH HANG FAMILY: A SAWTOOTH THAT NEVER CROSSES THE BAR ─────────────────────────────
/// How much of the rolling window below may be lost to main-thread stalls before that is itself a
/// hang episode — with no single stall anywhere near `HANG_AFTER`.
///
/// WHY A SECOND TRIGGER EXISTS AT ALL. Everything above measures exactly ONE quantity — how long
/// the heartbeat has been silent — and returns a binary verdict at a five-second bar. On
/// 2026-08-20 a user reported a 30-second unusable window and this module captured NOTHING,
/// correctly by every rule it had: the detector thread was alive (sampled live, 161 of 161 samples
/// inside its own loop), no limiter was in force (the previous capture was NINE HOURS earlier), and
/// the window was VISIBLE — the renderer's rAF monitor logged continuously through the whole window
/// with `sinceMs` ≈ 60000 every minute, which a hidden, throttled webview cannot do — so the
/// five-second bar applied. Nothing this module watches ever went silent for five seconds. What the
/// log holds for that window instead is this, from the renderer's own rAF monitor:
///
///   jank stall        {ms:2049, win:"main"}
///   jank minor stalls {count: 8, totalMs:2646, maxMs:610, sinceMs:60018}
///   jank minor stalls {count: 7, totalMs:2813, maxMs:717, sinceMs:60004}
///   jank minor stalls {count:13, totalMs:4681, maxMs:956, sinceMs:60286}
///
/// Seven to thirteen stalls a minute, 2.6-4.7 SECONDS of stall per minute, worst single block
/// 2049ms — 41% of `HANG_AFTER`, so the silence bar could not have seen it however long the bad
/// patch lasted. To the user that is an unusable app; to every instrument here it is green, by
/// design. And the aggregate was already being COMPUTED and then thrown away: `perfTrace.ts`
/// derives exactly the numbers above and logs them at info, and nothing acted on them.
///
/// ── WHY 4000ms, AND WHY OVER TEN SECONDS ──────────────────────────────────────────────────────
/// The rate in those lines is 4.4%, 4.7% and 7.8% of their own minute. A bar at that rate is
/// useless as a trigger, because that rate is ORDINARY here: `perfTrace.ts`'s own measurement is
/// ~10.3k stalls a day at a median of 221ms — a stall every eight seconds around the clock — so
/// minutes at 4-8% are what this app does when nothing is wrong. Set the bar there and it fires
/// forever, and a trigger that fires forever deletes the evidence it exists to keep (see
/// `MAX_HANG_DUMPS`).
///
/// What separates the reported window from ordinary jank is not the per-minute rate, it is
/// CLUSTERING — and a sixty-second rollup is precisely the instrument that cannot see clustering.
/// 4681ms spread evenly across a minute is a slightly janky minute; the same 4681ms arriving
/// back-to-back is four seconds in ten during which the UI barely moves, which is what the user
/// reported. So the window is TEN SECONDS (matching `perfTrace.ts`'s SUSPEND_MS, whose claim is
/// that nothing this app does on the main thread lasts ten seconds) and the input is a per-heartbeat
/// increment rather than the rollup line.
///
/// 4000ms of 10_000ms is then the number the measurement gives, from both sides:
///   * the three rollups above, spread across their own minute, put at most 780ms into any
///     ten-second slice — 5.1x under the bar, so the ordinary case cannot reach it;
///   * those same stalls arriving inside one ten-second cluster are 4681ms, 47% of the window and
///     over the bar — the case that must fire;
///   * and nothing lower would separate the two, because sixty-second-uniform ordinary jank already
///     reaches 7.8% and a 10% bar would fire on it.
/// Reaching it takes two or more stalls at the observed maximum (2049ms), or a handful at the
/// observed minor sizes (610-956ms). A single block big enough to reach it alone is already within
/// a second of `HANG_AFTER`, which owns that case.
const STALL_BUDGET_MS: u64 = 4_000;

/// The rolling window the budget is measured over, in ticks. `TICK` is one second, so this is ten
/// seconds — and the ring is exact rather than an approximation of a time span.
const STALL_WINDOW_TICKS: usize = 10;

/// Minimum wall time between two stall-budget reports.
///
/// Sixty seconds, which is `JANK_ROLLUP_MS` in `perfTrace.ts`: a sustained bad patch then emits one
/// line here per rollup line there, so the two read side by side instead of one drowning the other.
/// It must also be at least as long as the window, and it is by 6x — the ring holds only the last
/// ten seconds, so by the time a report is one interval old there is no stall time left in the ring
/// that it already reported. That is what keeps one bad patch from being counted twice, and it is
/// why this needs no bookkeeping beyond a timestamp.
const STALL_REPORT_MIN_INTERVAL: Duration = Duration::from_secs(60);

/// First restate delay for an ongoing episode. Doubles each time (see `restate_delay_ms`).
const RESTATE_EVERY: Duration = Duration::from_secs(10);

/// Ceiling on the backoff. A genuinely long hang still leaves a progress trail — the thing that
/// proves it was STILL hung at T+60s — without a dead webview emitting a line forever at 10s.
const RESTATE_MAX: Duration = Duration::from_secs(300);

/// If our own tick overran by this much, we were not running either — so this tick is worth a
/// second question before anything else is believed.
///
/// ── THIS USED TO BE THE WHOLE TEST, AND THAT COST A REAL HANG ─────────────────────────────────
/// It read: "generously above scheduler jitter under heavy load; a real suspend overshoots by
/// seconds to hours, so nothing lands near this boundary in practice." Both halves are false on a
/// busy machine. The overshoot is how far OUR OWN `sleep(TICK)` overran, and a descheduled thread
/// produces that exactly the way a suspended machine does; on the machine that reported the freeze
/// the load average was 191-201 while nominally IDLE and 366-520 across 18 CPUs with agents
/// running, so the bar sits BELOW that noise floor rather than above it. The consequence was
/// `sparkle-rlmsb4`: a 30-second total UI freeze the detector observed, relabelled as a suspend,
/// and discarded without a line.
///
/// So the constant no longer decides anything on its own — it SELECTS the ticks worth asking about,
/// and `machine_was_suspended` answers, from a clock that can tell the two cases apart. Keeping it
/// at five seconds is deliberate: a punctual tick must never pay for the second reading, and this
/// is still far above ordinary jitter for the case where the reading is unavailable and the old
/// inference is all we have.
const SUSPEND_OVERSHOOT: Duration = Duration::from_secs(5);

/// How much of our own sleep the MACHINE must have spent suspended before we believe it slept.
///
/// One second, and note that the two cases are not close to this line — they are at opposite ends
/// of it. A genuine suspend counts seconds to hours of sleep; CPU starvation counts exactly ZERO,
/// because `mach_continuous_time()` and `mach_absolute_time()` advance in lockstep for as long as
/// the machine is awake, however badly this thread is being scheduled. The floor exists only so
/// that reading the two clocks a few instructions apart (skew: nanoseconds) and macOS's brief dark
/// wakes cannot be read as a lid-close. Nothing under a second of suspension could explain a
/// five-second overshoot anyway, so there is no case this number has to adjudicate.
const SUSPEND_CONFIRM: Duration = Duration::from_secs(1);

/// Minimum wall time between two "declined to report a heartbeat gap" lines.
///
/// The suppression above used to be SILENT — no line, at any level, whatever size the gap was —
/// and that is the second half of `sparkle-rlmsb4`: the one signal that would have exposed the
/// guard misfiring, "I just threw away a thirty-second gap", did not exist anywhere to be read.
/// It exists now, and this limiter is what keeps the fix from becoming a defect of its own. A
/// laptop that sleeps nightly emits one line a night either way; the case that needs bounding is
/// the FALLBACK path (`machine_was_suspended` with no reading available), which can rebaseline on
/// many consecutive ticks under load. Sixty seconds, matching `STALL_REPORT_MIN_INTERVAL`, so the
/// module's two rate-limited lines share one cadence.
const SUSPEND_LOG_MIN_INTERVAL: Duration = Duration::from_secs(60);

/// Keep at most this many `sample(1)` dumps on disk. `retention.rs` only reaps `sparkle.log*`
/// entries directly in the log dir and explicitly does not recurse, so nothing else would ever
/// collect these — and each is hundreds of KB to several MB.
const MAX_HANG_DUMPS: usize = 20;

/// Dumps kept for HIDDEN episodes, in their own directory with their own budget.
///
/// Zero was wrong. Hidden episodes were given no capture at all on the argument that an ordinary
/// backgrounding must not evict real stacks — sound as far as it goes, but it zeroes out exactly the
/// case the hidden path exists for. Walk it: the user cmd-tabs away, THEN the main thread wedges.
/// The `hidden: true` beat was delivered before the wedge, so the episode opens hidden; and the
/// wedged thread cannot process a `visible` beat either, so it never reclassifies — not even when
/// the user clicks the dock icon and meets the beachball in the foreground. That is the 2026-07-29
/// root cause reproducing with a log line and no evidence, from a module whose stated
/// non-negotiable is "capture proof".
///
/// A SEPARATE, much smaller budget resolves both concerns at once: a real backgrounded wedge still
/// leaves a stack, and it cannot displace a visible one, because they are never in the same pool.
/// Small because the false-positive rate here is high by construction — a stopped-timer
/// backgrounding opens one episode per cmd-tab — and because these are diagnosed by correlation
/// with a user report, where the most recent couple are what matter.
const MAX_HIDDEN_HANG_DUMPS: usize = 3;

/// Minimum wall time between HIDDEN stack captures. See `may_capture_hidden` for why retention
/// alone is not a bound. Thirty minutes: long enough that ordinary backgrounding costs at most two
/// samples an hour, short enough that a real backgrounded wedge is still caught promptly.
const HIDDEN_CAPTURE_MIN_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// Minimum wall time between VISIBLE stack captures.
///
/// The visible path had NO limiter at all, on the argument that a visible episode is the evidence
/// we most want. True, and it still produced duplicate captures of the same stall: of the 17 dumps
/// on disk, twelve are six PAIRS whose members are 6, 7, 7, 11, 12 and 22 seconds apart. Those are
/// not six episodes and six more; they are six stalls, each detected twice, because `HANG_AFTER` is
/// 5s and a struggling app emits one beat and then stops again — which opens a genuinely NEW
/// episode by every rule in `step`. Each duplicate then fires a full multi-second `sample(1)` at an
/// app that is already in trouble, and evicts a real older stack to make room.
///
/// Thirty seconds, and the number is set by that measurement rather than by taste: the widest
/// observed pair is 22s apart, so any floor shorter than that fails to collapse the very pairs it
/// exists for. It is also longer than one capture takes to run (measured 15-23s of `sample` +
/// symbolication, see `SAMPLE_INTERVAL_MS`), so two captures can no longer overlap — the condition
/// that produced 23 files for `keep=20` (see `capture_stack_into`).
///
/// What this deliberately does NOT do is weaken `Effect::Restate { wants_stack }`. An episode that
/// was REFUSED here still owes a stack and keeps asking on every restate, so a floor spent by a
/// duplicate is re-offered to the next episode the moment it expires. The pure state machine's
/// "a fresh episode is owed its own stack" is untouched; this bounds the I/O, not the policy.
const VISIBLE_CAPTURE_MIN_INTERVAL: Duration = Duration::from_secs(30);

/// Epoch ms of the last hidden capture; `0` = none this launch.
static LAST_HIDDEN_CAPTURE_MS: AtomicU64 = AtomicU64::new(0);
/// Epoch ms of the last visible capture; `0` = none this launch.
static LAST_VISIBLE_CAPTURE_MS: AtomicU64 = AtomicU64::new(0);

/// Sampling interval in ms handed to `sample(1)`. The default (1ms) is both expensive and a lie.
///
/// Measured 2026-08-09 against a live Sparkle host process (368 threads),
/// `sample <pid> 5 <interval> -file <path>`, wall time from spawn to exit:
///
/// | interval | elapsed | file    | main-thread samples in the 5s window |
/// |----------|---------|---------|--------------------------------------|
/// | 1ms      | 59.3s   | 2.21 MB | 2066 of a requested 5000 (41%)       |
/// | 10ms     | 23.1s   | 1.09 MB |  386 of a requested  500 (77%)       |
/// | 25ms     | 15.5s   | 0.81 MB |                                      |
/// | 50ms     | 15.8s   | 0.95 MB |                                      |
///
/// So the default is not merely costly, it is LESS FAITHFUL than a coarser ask: at 1ms the tool
/// sustains 41% of the cadence it was told to use, at 10ms it sustains 77%. 10ms halves both the
/// file and the wall time while still resolving a multi-second stall into hundreds of consecutive
/// identical frames, which is the entire claim this instrument has to support. Going coarser buys
/// only ~30% more, because what is left is symbolication rather than sampling — 25ms and 50ms cost
/// the same wall time, and 50ms produced a LARGER file than 25ms.
///
/// This matters more now than it did: an episode spawns one `sample` per process, not one total.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SAMPLE_INTERVAL_MS: &str = "10";

/// The `sample(1)` duration, in seconds. Unchanged; named so both call sites cannot drift.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SAMPLE_SECONDS: &str = "5";

/// How many `sample(1)` children may exist at once, across every capture.
///
/// One episode now spawns 1 host + up to `MAX_OWN_WEBCONTENT` renderers. This cap is one more than
/// that, so a single episode can always complete and a second episode's captures are refused rather
/// than queued — which is the right direction, because the thing we are instrumenting is an app
/// under load and `sample` attaches to it for 15-23s.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MAX_CONCURRENT_SAMPLES: usize = MAX_OWN_WEBCONTENT + 2;

/// `sample(1)` children currently running.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static SAMPLES_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// The leaf name of the WebKit renderer executable, verified live on macOS 26.6.
///
/// Matched as a SUFFIX of `ps -o comm=` (which prints the full executable path) so a future change
/// to the framework's internal directory layout does not silently stop matching.
const WEBCONTENT_EXEC: &str = "com.apple.WebKit.WebContent";

/// How many new WebContent processes this app may claim from the before/after diff.
///
/// Three, because three is how many webviews Sparkle has created by the time the first heartbeat
/// arrives: the main window (declared in `tauri.conf.json`), the capture takeover window
/// (`capture_window::init_capture_window`) and the floating helper island
/// (`helper::init_helper_window`) — the latter two built synchronously in `setup`, i.e. before the
/// main window's React app can send a beat. WebKit usually shares one content process across
/// same-origin webviews, so the honest expectation is "one to three": the studied dump had two
/// (host 93243, renderers 93246 and 93249).
///
/// FOUR OR MORE IS A REFUSAL, NOT A GUESS. The diff window spans app startup, so another app
/// launching a browser in the same second contributes its renderer to the difference and there is
/// nothing in `ps` that separates it from ours (identical argv, `ppid=1`). Sampling a stranger's
/// renderer would write another application's page contents into this user's log directory — that
/// is a privacy failure, not noise. So when the count cannot be attributed we record NOTHING and
/// say so in the log; the capture then degrades to exactly today's host-only behaviour.
const MAX_OWN_WEBCONTENT: usize = 3;

/// What we know about this app's WebContent processes.
///
/// `baseline` is the set of WebContent pids that existed BEFORE our webview did; `arming_since_ms`
/// is when that baseline was taken. The diff is only taken once a heartbeat NEWER than that instant
/// has arrived, because the first beat is the only signal available from off the main thread that
/// proves the renderer exists and is running our JS — and depending on Tauri's window-creation
/// ordering relative to `setup` instead would make this module's correctness a function of a
/// framework internal.
#[derive(Debug)]
struct RendererTracker {
    baseline: BTreeSet<u32>,
    /// `Some(t)` = waiting for a beat newer than `t` to take the diff.
    arming_since_ms: Option<u64>,
    /// This app's WebContent pids. Empty means "unknown", never "none exist".
    pids: BTreeSet<u32>,
    /// Epoch ms of the last liveness re-check; `0` = never.
    last_recheck_ms: u64,
}

static RENDERERS: Mutex<RendererTracker> = Mutex::new(RendererTracker {
    baseline: BTreeSet::new(),
    arming_since_ms: None,
    pids: BTreeSet::new(),
    last_recheck_ms: 0,
});

/// How often the tick re-verifies that the recorded renderers are still alive.
///
/// NOT every tick. A recorded pid does go stale (WebKit respawns a crashed WebContent), but the
/// check costs a `ps` fork/exec and the watchdog is the one thread in this app that must never
/// become part of the load it is measuring — one process listing a second, forever, to notice an
/// event that happens approximately never is the wrong trade. Thirty seconds is well inside the
/// gap between captures (`VISIBLE_CAPTURE_MIN_INTERVAL`), and the capture path re-verifies
/// unconditionally anyway (`live_renderer_pids`), so this cadence only governs how quickly the
/// RE-ARM after a renderer crash begins — never whether a stale pid can be sampled.
const RENDERER_RECHECK: Duration = Duration::from_secs(30);

fn renderers() -> std::sync::MutexGuard<'static, RendererTracker> {
    // Poison-tolerant: a panic in one capture must not permanently blind the watchdog.
    RENDERERS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Record which WebContent processes existed before this app made one. Call ONCE, as early in
/// `run()` as possible — the smaller the window between this and the first heartbeat, the less
/// chance an unrelated app's renderer lands in the difference and forces a refusal.
pub fn note_webcontent_baseline() {
    let before = webcontent_pids_now();
    let mut t = renderers();
    t.baseline = before;
    t.arming_since_ms = Some(now_ms());
    t.pids.clear();
}

/// Every WebContent pid on the machine, right now. Empty off macOS and on any `ps` failure — both
/// of which read as "we could not identify a renderer", which is the safe direction.
#[cfg(target_os = "macos")]
fn webcontent_pids_now() -> BTreeSet<u32> {
    match Command::new("/bin/ps").args(["-axo", "pid=,comm="]).output() {
        Ok(out) => parse_webcontent_pids(&String::from_utf8_lossy(&out.stdout)),
        Err(e) => {
            tracing::warn!(target: "watchdog", "could not list processes: {e}");
            BTreeSet::new()
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn webcontent_pids_now() -> BTreeSet<u32> {
    BTreeSet::new()
}

/// Pure parser over `ps -axo pid=,comm=` output, so the matching rule is assertable against real
/// captured output without shelling out.
fn parse_webcontent_pids(ps_output: &str) -> BTreeSet<u32> {
    ps_output
        .lines()
        .filter_map(|line| {
            let (pid, comm) = line.trim_start().split_once(char::is_whitespace)?;
            if !comm.trim().ends_with(WEBCONTENT_EXEC) {
                return None;
            }
            pid.parse::<u32>().ok()
        })
        .collect()
}

/// Which WebContent processes appeared while our webview was being created.
///
/// Pure, and the refusal is the point: more new pids than webviews we created means the difference
/// contains something that is not ours and nothing in `ps` can say which. See `MAX_OWN_WEBCONTENT`.
fn new_webcontent_pids(
    before: &BTreeSet<u32>,
    after: &BTreeSet<u32>,
    max_expected: usize,
) -> BTreeSet<u32> {
    let new: BTreeSet<u32> = after.difference(before).copied().collect();
    if new.len() > max_expected {
        return BTreeSet::new();
    }
    new
}

/// Drop recorded pids that are no longer live WebContent processes.
///
/// Intersecting with a fresh `ps` snapshot checks BOTH facts at once, which matters: an exited
/// renderer's pid can be recycled by an unrelated process, and a liveness-only check (`kill(pid,0)`)
/// would happily hand that stranger to `sample`. Pure so the recycling case is testable.
fn live_renderer_pids(recorded: &BTreeSet<u32>, live_webcontent: &BTreeSet<u32>) -> Vec<u32> {
    recorded.intersection(live_webcontent).copied().collect()
}

/// Keep the recorded renderer set honest. Called once per tick, from the watchdog thread.
///
/// Deliberately makes NO call into `AppHandle` or any Tauri state. This module's one non-negotiable
/// property is that nothing the main thread does can stop it running, and `AppHandle` accessors take
/// locks the wedged main thread may be holding — so asking Tauri "how many webviews do you have"
/// would trade the whole design away for a number that is already a compile-time constant here.
fn maintain_renderer_tracking(last_beat_ms: u64, now_ms: u64) {
    let mut t = renderers();
    if let Some(armed_at) = t.arming_since_ms {
        // A beat strictly newer than the baseline. On the re-arm path (below) beats from the DEAD
        // renderer are still on record, and diffing against those would resolve instantly against a
        // baseline that already contains the replacement.
        if last_beat_ms <= armed_at {
            return;
        }
        let after = webcontent_pids_now();
        let new = new_webcontent_pids(&t.baseline, &after, MAX_OWN_WEBCONTENT);
        // How many appeared during the window, BEFORE the baseline is dropped. `new` is empty for
        // two different reasons — nothing appeared, or too much did — and this is what tells them
        // apart in the log.
        let candidates = after.difference(&t.baseline).count();
        t.arming_since_ms = None;
        t.baseline = BTreeSet::new();
        if new.is_empty() {
            tracing::info!(
                target: "watchdog",
                webcontent_total = after.len(),
                candidates,
                max_own = MAX_OWN_WEBCONTENT,
                "could not attribute a WebContent process to this app; hang captures will be host-only"
            );
        } else {
            tracing::info!(
                target: "watchdog",
                pids = ?new,
                "identified this app's WebContent process(es); hang captures will include them"
            );
        }
        t.pids = new;
        return;
    }
    if t.pids.is_empty() || !may_capture(t.last_recheck_ms, now_ms, RENDERER_RECHECK.as_millis() as u64)
    {
        return;
    }
    t.last_recheck_ms = now_ms;
    // WebKit respawns a crashed WebContent process, so a recorded pid goes stale on its own.
    let live = webcontent_pids_now();
    let before = t.pids.len();
    t.pids = live_renderer_pids(&t.pids, &live).into_iter().collect();
    if t.pids.len() == before {
        return;
    }
    if t.pids.is_empty() {
        // Re-snapshot and wait for the replacement's first beat. Honest caveat: WebKit can respawn
        // faster than our 1s tick notices the death, in which case the replacement is already in
        // this baseline, the next diff comes back empty, and we settle on host-only captures with
        // the log line above. That is the safe direction — the alternative is claiming a process we
        // cannot prove is ours.
        t.baseline = live;
        t.arming_since_ms = Some(now_ms);
        tracing::info!(
            target: "watchdog",
            "this app's WebContent process(es) exited; re-arming renderer identification"
        );
    } else {
        tracing::info!(
            target: "watchdog",
            pids = ?t.pids,
            "a WebContent process of ours exited; dropped it from the capture set"
        );
    }
}

/// Milliseconds since the epoch of the last heartbeat from the webview. `0` = none yet.
static LAST_BEAT_MS: AtomicU64 = AtomicU64::new(0);
/// Main-thread stall time (ms) the renderer has reported since the tick last drained this.
///
/// Written by `watchdog_heartbeat` (any thread), drained by the tick with a `swap`. An accumulator
/// rather than a level, because beats and ticks are both ~1s and neither drives the other: a beat
/// that lands twice between two ticks must ADD, or the stall it carried is silently dropped.
static STALL_MS_SINCE_TICK: AtomicU64 = AtomicU64::new(0);
/// The webview told us it went hidden. See `watchdog_heartbeat`.
static HIDDEN: AtomicBool = AtomicBool::new(false);
/// Set once the watchdog thread is running, so a second call cannot start a second one.
static STARTED: AtomicBool = AtomicBool::new(false);

/// The two mach clocks, declared here rather than taken from `libc`.
///
/// `libc` has `mach_absolute_time` but not `mach_continuous_time`, and its `mach_timebase_info` is
/// deprecated in favour of a crate this app does not depend on — so taking half the pair from there
/// would mean a deprecation warning and a second spelling of the same idea. All three are in
/// libSystem, which is linked unconditionally, and `mach_continuous_time` has been there since
/// macOS 10.12.
#[cfg(target_os = "macos")]
mod mach_clock {
    /// `mach_timebase_info_data_t`: a tick is `numer / denom` nanoseconds. 1/1 on x86_64 and 125/3
    /// on Apple silicon, which is why the raw tick counts below cannot be compared to a duration
    /// without it.
    #[repr(C)]
    pub struct TimebaseInfo {
        pub numer: u32,
        pub denom: u32,
    }

    extern "C" {
        /// Ticks since boot, EXCLUDING every interval the machine spent asleep.
        pub fn mach_absolute_time() -> u64;
        /// Ticks since boot, INCLUDING them.
        pub fn mach_continuous_time() -> u64;
        /// Non-zero on failure.
        pub fn mach_timebase_info(info: *mut TimebaseInfo) -> i32;
    }
}

/// Milliseconds the MACHINE has spent suspended since boot — or `None` if we cannot tell.
///
/// ── THE ONE ASYMMETRY THAT SEPARATES A SLEEPING MACHINE FROM A STARVED THREAD ─────────────────
/// Everything else this thread can observe is symmetrical between the two. A suspend and a load
/// spike both leave our own `sleep(TICK)` overrunning by seconds, and from inside a descheduled
/// thread there is nothing in the wall clock, the heartbeat, or our own state that tells them
/// apart — which is exactly how `sparkle-rlmsb4` stayed invisible. macOS has one asymmetry, and
/// this is it: `mach_continuous_time()` keeps counting while the system sleeps and
/// `mach_absolute_time()` does not, so their difference is total suspended time since boot and
/// nothing else. Sampled either side of our sleep, the DELTA is how much of that sleep the machine
/// spent suspended: essentially the whole overshoot for a lid-close, exactly zero for starvation.
///
/// Returned as an accumulator (since boot) rather than as a per-sleep figure so the caller takes
/// one reading per tick and the subtraction happens in one place. Both clocks share a timebase, so
/// differencing the TICKS first and converting once is what keeps this exact on Apple silicon,
/// where a tick is 125/3 ns rather than 1.
///
/// `None` — off macOS, or an unreadable timebase — means "we could not take the reading", which
/// `machine_was_suspended` deliberately resolves toward the old behaviour. See its note for why
/// that direction is the safe one.
#[cfg(target_os = "macos")]
fn machine_slept_since_boot_ms() -> Option<u64> {
    let mut tb = mach_clock::TimebaseInfo { numer: 0, denom: 0 };
    // SAFETY: `mach_timebase_info` writes only through the pointer to our own stack slot and we act
    // on its return code before reading the result; the two clock reads take no arguments and
    // cannot fail.
    let (absolute, continuous, numer, denom) = unsafe {
        if mach_clock::mach_timebase_info(&mut tb) != 0 || tb.denom == 0 {
            return None;
        }
        // ABSOLUTE FIRST. Continuous is then read a few nanoseconds LATER, so whatever skew comes
        // from reading them non-atomically inflates the difference by that much rather than
        // underflowing it — the direction that cannot manufacture a negative sleep.
        let absolute = mach_clock::mach_absolute_time();
        let continuous = mach_clock::mach_continuous_time();
        (absolute, continuous, tb.numer, tb.denom)
    };
    Some(slept_ms_from_ticks(absolute, continuous, numer, denom))
}

/// Fold one raw pair of mach tick counts into milliseconds of counted sleep.
///
/// Split out, and deliberately NOT gated on macOS, because it holds the two things a test running
/// on an awake machine cannot otherwise catch by observation — and both are silent when wrong:
///
///   * THE ORDER OF THE SUBTRACTION. Continuous minus absolute. Reversed, it saturates to zero on
///     every reading, which reads as "the machine has never slept" and turns every lid-open back
///     into a reported hang. While the machine is awake both orders give zero, so only a fixture
///     with a known-slept pair can tell them apart.
///   * THE TIMEBASE. A tick is `numer / denom` nanoseconds: 1/1 on x86_64 but 125/3 on Apple
///     silicon, where dropping the conversion under-reports sleep by 41x and puts an hour of
///     lid-close under the one-second bar.
///
/// Ticks difference FIRST, then one conversion — the two clocks share a timebase, so converting
/// each separately would round twice for no reason.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn slept_ms_from_ticks(absolute: u64, continuous: u64, numer: u32, denom: u32) -> u64 {
    if denom == 0 {
        return 0;
    }
    let ticks = u128::from(continuous.saturating_sub(absolute));
    (ticks * u128::from(numer) / u128::from(denom) / 1_000_000) as u64
}

#[cfg(not(target_os = "macos"))]
fn machine_slept_since_boot_ms() -> Option<u64> {
    None
}

/// Did the MACHINE sleep through our overrun, or was this thread merely starved of CPU?
///
/// Pure and separate from `step` so the FALLBACK direction is assertable on its own. `None` is the
/// reading we could not take, and it resolves to "suspended" — today's behaviour — because the two
/// errors are nothing like symmetric. Calling a suspend a hang files a phantom multi-hour freeze on
/// EVERY lid-open, floods the visible dump pool and evicts the real evidence with it; calling a
/// starvation a suspend loses one report. The anti-phantom property is the one thing this module
/// cannot trade away, so an unknown reading keeps it.
/// Fold the two readings taken either side of our sleep into "how long the machine slept during
/// it".
///
/// `None` if EITHER end is missing, never a half-reading — and that is the assertion, not defensive
/// habit. A delta against a missing endpoint would arrive as a confident `Some(0)`, which
/// `machine_was_suspended` reads as "the machine was AWAKE" and which therefore reports a phantom
/// multi-hour hang on every lid-open: the exact regression this whole change is written not to
/// cause. Pure and lifted out of the loop so that direction is reachable from a test.
fn machine_slept_during(before: Option<u64>, after: Option<u64>) -> Option<u64> {
    match (before, after) {
        (Some(a), Some(b)) => Some(b.saturating_sub(a)),
        _ => None,
    }
}

fn machine_was_suspended(machine_slept_ms: Option<u64>) -> bool {
    match machine_slept_ms {
        Some(ms) => ms >= SUSPEND_CONFIRM.as_millis() as u64,
        None => true,
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The webview says it is alive. Called on a timer from the frontend.
///
/// Deliberately the cheapest possible command: two relaxed atomic stores, no lock, no allocation,
/// no app state. It runs on whatever thread Tauri dispatches commands on and must never be able to
/// contribute to the very stall it is watching for.
///
/// `hidden` lets the tick apply `HIDDEN_HANG_AFTER` instead of `HANG_AFTER`. A backgrounded or
/// occluded WKWebView has its timers throttled hard, so silence there has an innocent explanation
/// that needs room — but only room, not amnesty; see `HIDDEN_HANG_AFTER`. The frontend sends a beat
/// with `hidden: true` on `visibilitychange`, before the throttling lands.
/// `stalled_ms` is how much main-thread time the renderer lost to stalls since its last beat — the
/// SAME quantity `perfTrace.ts` already sums into its `jank stall` / `jank minor stalls` lines, fed
/// here rather than recomputed, so there is one definition of a stall instead of two that drift. It
/// is what `STALL_BUDGET_MS` is measured against.
///
/// OPTIONAL ON PURPOSE, and this is not defensive habit — it is the one shape of this change that
/// could take the whole instrument down. A Tauri command whose argument fails to deserialize
/// returns an error, the frontend's `.catch(() => {})` swallows it, and the beat is never recorded;
/// a webview beating without this field would therefore look PERMANENTLY SILENT and file a hang
/// every five seconds forever. `None` reads as "this beat carries no stall accounting", which is
/// exactly what an older or non-instrumented webview means.
#[tauri::command]
pub fn watchdog_heartbeat(hidden: bool, stalled_ms: Option<u64>) {
    if let Some(ms) = stalled_ms {
        if ms > 0 {
            STALL_MS_SINCE_TICK.fetch_add(ms, Ordering::Relaxed);
        }
    }
    HIDDEN.store(hidden, Ordering::Relaxed);
    LAST_BEAT_MS.store(now_ms(), Ordering::Relaxed);
}

/// Everything one tick observes. Grouped so the step function below is pure and testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TickInput {
    pub now_ms: u64,
    /// How much longer our own sleep took than we asked — our evidence about whether WE were running.
    pub overshoot_ms: u64,
    /// Epoch ms of the last heartbeat; `0` means none has ever arrived.
    pub last_beat_ms: u64,
    pub hidden: bool,
    /// Main-thread stall time the renderer reported since our last tick — see `STALL_BUDGET_MS`.
    /// Always `0` when no beat arrived, which is why silence and sawtooth never contest each other.
    pub stall_ms: u64,
    /// How much of our own sleep the MACHINE spent suspended, in ms; `None` = we could not tell.
    ///
    /// Passed IN exactly the way `overshoot_ms` is, rather than read inside `step`, because that is
    /// what makes the headline pair of this fix writable at all: the same large overshoot with two
    /// different readings has to produce two different verdicts, and a `step` that called the clock
    /// itself could be driven to only one of them. See `machine_slept_since_boot_ms`.
    pub machine_slept_ms: Option<u64>,
}

/// The watchdog's carried state between ticks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WatchdogState {
    /// An episode is open — we have said something and not yet seen recovery.
    reporting: bool,
    /// Epoch ms when the heartbeats actually stopped (NOT when we noticed).
    hang_started_ms: u64,
    /// Epoch ms of our last emitted line for this episode.
    last_report_ms: u64,
    /// How many restates this episode has emitted, driving the backoff.
    restates: u32,
    /// Was the window hidden at ANY point during this episode? Sticky, because the discount belongs
    /// to the whole episode: a wedge that began while backgrounded is a weaker claim even if the
    /// window is visible again by the time we report the recovery.
    hidden: bool,
    /// Has this episode already produced a stack? An episode that has NOT is still owed one, and
    /// `Restate` will ask again — see `Effect::Restate { wants_stack }`.
    captured: bool,
    /// The rolling stall window: one bucket per tick, oldest overwritten. See `STALL_BUDGET_MS`.
    ///
    /// A ring rather than a timestamped list because a tick is a fixed second and the whole point is
    /// to bound what this thread costs: summing ten `u32`s per second is free, and a `Copy` state
    /// keeps `step` the pure, cheaply-cloneable function every test here drives.
    stall_ring: [u32; STALL_WINDOW_TICKS],
    /// Next bucket to write.
    stall_next: usize,
    /// Epoch ms of our last stall-budget report; `0` = none. See `STALL_REPORT_MIN_INTERVAL`.
    last_stall_report_ms: u64,
    /// Epoch ms of our last "declined to report a gap" line; `0` = none. See
    /// `SUSPEND_LOG_MIN_INTERVAL`.
    ///
    /// Deliberately CARRIED ACROSS the two `*state = default()` resets below. It describes the log,
    /// not an episode, and a limiter that any state reset silently clears is not a limiter — the
    /// suspend path resets on every rebaseline, which is precisely when it is consulted.
    last_suspend_log_ms: u64,
}

/// What a tick decided to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    /// Nothing to say.
    Quiet,
    /// We could not have observed anything meaningful; reset the heartbeat baseline to this value.
    ///
    /// Carries the value rather than leaving the loop to reach for `now` itself: the store is the
    /// guard against a phantom hang on every lid-open, and as an implicit convention it was
    /// unreachable from any test. See `apply_baseline`.
    ///
    /// `discarded_gap_ms` is the heartbeat gap this tick is throwing away, and `announce` whether to
    /// write a line about it. Both exist because this path used to be entirely SILENT, which is how
    /// `sparkle-rlmsb4` survived a year of logs nobody could fault. The rate-limit decision is made
    /// HERE rather than in the loop so it stays inside the pure state machine, where a test can
    /// drive the second suppression inside a minute and assert that it says nothing.
    Rebaseline { new_last_beat_ms: u64, discarded_gap_ms: u64, announce: bool },
    /// Heartbeats have stopped for `stalled_ms`. First line of an episode.
    ///
    /// `starved_ms` is non-zero only when this tick reached the `SUSPEND_OVERSHOOT` bar and the
    /// machine was demonstrably AWAKE for it: our own sleep overran by that much because the
    /// scheduler never ran us, so the process was starved of CPU rather than the main thread being
    /// blocked on something. It is carried on the OPENING line and not on the restates because the
    /// verdict belongs to the episode, is written once where a reader meets it first, and a restate
    /// that repeated it would say nothing the open did not — while every restate literal in the
    /// suite would have to grow a field that is only ever incidental to the tick that emitted it.
    ReportNew { stalled_ms: u64, hidden: bool, starved_ms: u64 },
    /// Still silent. `stalled_ms` is measured from when the beats stopped, not from the last line.
    ///
    /// `wants_stack` is true while this episode has not managed a capture yet. It is the fix for a
    /// rate limiter that could be spent by the wrong event: see `may_capture_hidden`.
    Restate { stalled_ms: u64, hidden: bool, wants_stack: bool },
    /// Beats resumed. `hung_for_ms` is the TRUE total, from the moment they stopped.
    ///
    /// `hidden` is not decoration here — it is the difference between an eight-hour wedge and an
    /// eight-hour cmd-tab, which are otherwise byte-for-byte identical on this line.
    Recovered { hung_for_ms: u64, hidden: bool },
    /// The heartbeat never went silent long enough to trip `HANG_AFTER`, and the UI still lost
    /// `stalled_ms` of the last `window_ms` to main-thread stalls. The fourth hang family — see
    /// `STALL_BUDGET_MS` for the measurement that sets the bar.
    ///
    /// Carries no `hidden`: it is only ever emitted for a VISIBLE window (rAF, and therefore the
    /// stall accounting, is paused while hidden), so its evidence always belongs to the visible
    /// pool — see `capture_for`.
    StallBudget { stalled_ms: u64, window_ms: u64 },
}

/// Is this episode strong enough evidence to shout about?
///
/// Only a VISIBLE episode is. Silence from a hidden webview is documented platform behaviour rather
/// than a symptom (see `HIDDEN_HANG_AFTER`), so a hidden episode is recorded at `info`: a timestamp
/// to correlate against if the user later reports a freeze, not a claim.
///
/// Note this governs the LOG LEVEL only. Hidden episodes still capture a stack — into their own
/// small, separate, rate-limited budget — because the backgrounded wedge is the case the hidden path
/// exists for. See `MAX_HIDDEN_HANG_DUMPS`, `dump_target` and `may_capture_hidden`.
fn is_reportable_evidence(hidden: bool) -> bool {
    !hidden
}

/// Where an episode's stack goes, and how many that pool keeps.
///
/// Two pools, never one. Sharing them is what forces the false choice between "an ordinary cmd-tab
/// can evict a real hang stack" and "a backgrounded wedge gets no stack at all" — the first is why
/// the hidden budget was zeroed, the second is what zeroing it cost.
///
/// Returns the resolved path rather than a subdirectory name so the WIRING is reachable from a test.
/// The previous version returned a bare `&str` the loop had to join itself, which meant the join,
/// the pool choice and the retention count were all only assertable as relations between constants —
/// the exact vacuous shape this repo's own docs condemn. Dropping the join, or passing
/// `MAX_HANG_DUMPS` to both pools, left every test green.
fn dump_target(root: &Path, hidden: bool) -> (PathBuf, usize) {
    if hidden {
        (root.join("hidden"), MAX_HIDDEN_HANG_DUMPS)
    } else {
        (root.to_path_buf(), MAX_HANG_DUMPS)
    }
}

/// May we spend a stack capture now? Shared by both pools; only the interval differs.
///
/// The pool size bounds RETAINED FILES, not captures — a distinction that matters because the
/// expensive part is not the file. `sample(1)` attaches to the process and walks every thread for
/// five seconds; keeping only the newest three still pays that cost once per hidden episode, and a
/// backgrounded webview's timers stop outright, so essentially every cmd-tab past
/// `HIDDEN_HANG_AFTER` would trigger one. On battery, on a perfectly healthy app. That is half of
/// the cost this module already argued against in its own words — the design fixed the eviction
/// half and left this one, while the docs read as though it had fixed both.
///
/// A minimum interval bounds it without giving up the case that matters: a genuine backgrounded
/// wedge is a rare event that persists, so it will still be captured; a user who cmd-tabs away
/// repeatedly pays at most one sample per interval. The honest discriminator would be a main-thread
/// ping (a no-op posted from this thread, captured only if it does not return), which would prove a
/// blocked main thread independent of visibility — but that gives this module a live dependency on
/// the very thread it exists to observe from outside, so it is deliberately not built here.
///
/// The VISIBLE path now uses this too, on a much shorter floor and for a different reason: not to
/// bound a benign event's cost, but because one stall is routinely DETECTED TWICE. See
/// `VISIBLE_CAPTURE_MIN_INTERVAL` for the measurement that sets that floor.
fn may_capture(last_capture_ms: u64, now_ms: u64, min_interval_ms: u64) -> bool {
    last_capture_ms == 0 || now_ms.saturating_sub(last_capture_ms) >= min_interval_ms
}

/// Apply the one piece of state a tick can write back outside `WatchdogState`.
///
/// Extracted so it is reachable from a test. Deleting the store leaves every lid-open filing a
/// phantom `ReportNew`, and against a `static` inside the loop nothing could catch that.
fn apply_baseline(last_beat: &AtomicU64, effect: &Effect) {
    if let Effect::Rebaseline { new_last_beat_ms, .. } = effect {
        last_beat.store(*new_last_beat_ms, Ordering::Relaxed);
    }
}

/// Record that this episode got its stack, so later restates stop asking.
///
/// Separate from `step` because whether a capture actually happened is an I/O outcome (the rate
/// limiter may refuse, the dump dir may be missing), and `step` is pure.
pub fn note_captured(state: &mut WatchdogState) {
    state.captured = true;
}

/// Fold one tick's reported stall time into the rolling window, dropping the oldest bucket.
///
/// Called on EVERY tick that could have observed anything, including ticks that go on to report or
/// restate a silence episode — a window with holes in it is not a window, and the hole would always
/// be the interesting part.
fn push_stall(state: &mut WatchdogState, stall_ms: u64) {
    // Saturating rather than wrapping: a beat carrying an implausible number (a clock step on the
    // renderer side) must read as "a very bad second", never as a near-zero one.
    state.stall_ring[state.stall_next] = stall_ms.min(u32::MAX as u64) as u32;
    state.stall_next = (state.stall_next + 1) % STALL_WINDOW_TICKS;
}

/// Total stall time currently inside the rolling window.
fn stall_in_window(state: &WatchdogState) -> u64 {
    state.stall_ring.iter().map(|&ms| ms as u64).sum()
}

/// Where an effect's evidence goes: `Some(hidden_pool)`, or `None` for an effect that owes no stack.
///
/// Extracted from the loop so the WIRING is assertable rather than promised. "The new trigger reuses
/// the existing capture path, its two-pool routing and its rate limiter" is a claim about this one
/// function: a future trigger that quietly grew a third pool or its own limiter would have to change
/// it here, where a test can see it. Inside the loop's match arms it was reachable from nothing.
fn capture_for(effect: &Effect) -> Option<bool> {
    match effect {
        // A STARVED episode (`starved_ms > 0`) lands here too, and it goes to the VISIBLE pool
        // deliberately. The discounted hidden pool is for evidence that is WEAK — a hidden webview's
        // silence has a documented innocent explanation — and a starvation freeze is not that: the
        // freeze is confirmed, only its CAUSE is in question. Routing it to a three-file pool on a
        // thirty-minute floor would also make it evict the backgrounded-wedge stacks that pool
        // exists for, i.e. re-create `sparkle-rlmsb4` in a quieter form. And the stack is still
        // worth taking even though a starved machine parks every thread: "starved" is what we can
        // prove about OUR thread, never about the main thread, and a genuine lock-wedge that
        // coincides with a load spike is exactly the case where losing the stack is unrecoverable —
        // the log line says starvation was in play so a reader knows to discount a dump in which
        // everything looks parked. If a load storm ever does churn `MAX_HANG_DUMPS`, the fix is a
        // starvation-specific floor beside `VISIBLE_CAPTURE_MIN_INTERVAL`, not a third pool.
        Effect::ReportNew { hidden, .. } => Some(*hidden),
        // PERSISTENCE EARNS THE STACK: an episode refused at open keeps asking. See `Restate`.
        Effect::Restate { hidden, wants_stack: true, .. } => Some(*hidden),
        // The VISIBLE pool, deliberately: this is a visible-window event, and routing it anywhere
        // else would either evict hidden evidence or invent a third budget.
        Effect::StallBudget { .. } => Some(false),
        _ => None,
    }
}

/// Does this effect belong to a silence episode — i.e. may a capture taken for it mark that episode
/// as having got its stack?
///
/// A stall-budget report is NOT an episode: it opens nothing and never recovers. Marking `captured`
/// from one would set an episode flag while no episode is open. The cost today is bounded, because
/// `ReportNew` clears the flag when the next episode opens — but the flag would then mean two
/// things, and it exists to answer exactly one question, the one `Restate` asks with it: does THIS
/// episode still owe a stack?
fn capture_satisfies_episode(effect: &Effect) -> bool {
    matches!(effect, Effect::ReportNew { .. } | Effect::Restate { .. })
}

/// How long to wait before the Nth restate. Exponential, capped — see `RESTATE_MAX`.
fn restate_delay_ms(restates: u32) -> u64 {
    let base = RESTATE_EVERY.as_millis() as u64;
    let max = RESTATE_MAX.as_millis() as u64;
    base.saturating_mul(1u64 << restates.min(20)).min(max)
}

/// Advance the state machine by one tick. Pure: every side effect is in the returned `Effect`, so
/// the transitions — not just the classification — can be tested.
///
/// Order matters. The suspend check short-circuits first: if the machine slept, every other input
/// this tick is meaningless (of course there were no heartbeats — nothing was running), and treating
/// that as a hang would report a phantom freeze on every lid-open.
///
/// But it short-circuits on TWO facts now, not one — our tick overran AND the machine really slept
/// through it. With only the first, everything downstream of here was unreachable on a loaded
/// machine, the stall-budget trigger included: a load spike overshoots our sleep exactly the way a
/// suspend does, so the amnesty landed on the freezes rather than on the wakes. See
/// `machine_was_suspended` and `SUSPEND_OVERSHOOT`.
pub fn step(state: &mut WatchdogState, input: TickInput) -> Effect {
    let overran = input.overshoot_ms >= SUSPEND_OVERSHOOT.as_millis() as u64;
    if overran && machine_was_suspended(input.machine_slept_ms) {
        // The gap we are declining to report. This is the number whose absence from every log is
        // the reason this defect went a year undetected — see `SUSPEND_LOG_MIN_INTERVAL`. Zero when
        // nothing has ever beaten, because `now - 0` is "milliseconds since 1970", not a gap.
        let discarded_gap_ms = if input.last_beat_ms == 0 {
            0
        } else {
            input.now_ms.saturating_sub(input.last_beat_ms)
        };
        let announce = may_capture(
            state.last_suspend_log_ms,
            input.now_ms,
            SUSPEND_LOG_MIN_INTERVAL.as_millis() as u64,
        );
        // Read BEFORE the reset below, which is the whole reason this is spelled out rather than
        // folded into the struct literal.
        let last_suspend_log_ms = if announce { input.now_ms } else { state.last_suspend_log_ms };
        // Clearing the episode is not housekeeping. Leaving it open keeps a `hang_started_ms` from
        // before the sleep, so the next in-threshold tick emits a `Recovered` spanning the whole
        // machine suspend — the phantom multi-hour hang this branch exists to prevent, re-entering
        // through the recovery line instead of the report line.
        *state = WatchdogState { last_suspend_log_ms, ..WatchdogState::default() };
        return Effect::Rebaseline {
            new_last_beat_ms: input.now_ms,
            discarded_gap_ms,
            announce,
        };
    }
    // FALLING THROUGH WITH A LARGE OVERSHOOT IS THE FIX. The machine was demonstrably awake, so
    // nothing excuses the missing heartbeats and every rule below applies to them exactly as it
    // would to a punctual tick — including the stall-budget trigger, which sits downstream of here
    // and was therefore just as suppressed. `starved_ms` carries the observation onto the line we
    // write, because the user's remedy for a starved freeze (the host's load) is not the remedy for
    // a blocked main thread, and the two are indistinguishable in the log without it.
    let starved_ms = if overran { input.overshoot_ms } else { 0 };
    // Silence from something that has never spoken is not evidence of anything: the webview has not
    // booted yet, or this build predates the frontend half.
    if input.last_beat_ms == 0 {
        return Effect::Quiet;
    }
    // BEFORE any branch below can return. The window has to be continuous to mean anything, and the
    // ticks most likely to be skipped by a later-placed fold are the ones inside a bad patch.
    push_stall(state, input.stall_ms);
    let stalled_ms = input.now_ms.saturating_sub(input.last_beat_ms);
    let threshold =
        if input.hidden { HIDDEN_HANG_AFTER.as_millis() } else { HANG_AFTER.as_millis() } as u64;

    if stalled_ms < threshold {
        // Beats are current. If an episode was open, this is the recovery — and this is the ONLY
        // place the true duration exists, because `stalled_ms` here is the residual staleness of the
        // first beat back (a few hundred ms), NOT the length of the wedge. Reporting `stalled_ms`
        // was the original bug: a 90s beachball logged ~143ms and read as brief.
        if state.reporting {
            let hung_for_ms = input.now_ms.saturating_sub(state.hang_started_ms);
            // The EPISODE's flag, never this tick's. `input.hidden` on the recovery tick describes
            // the world AFTER the block ended, and the most likely way it becomes true is the worst
            // one: a user who gives up on a beachball and cmd-tabs away. Their `visibilitychange`
            // beat is queued behind the wedge and lands as the first beat after it, so ORing it in
            // would close a genuine, stack-captured, warn-level visible wedge at info with
            // "likely backgrounding, not a hang" — the exact conflation this flag exists to prevent,
            // running backwards, on the one line that carries the true duration.
            //
            // `state.hidden` alone loses nothing: an episode that opened hidden already has it set,
            // and a beat that would change visibility mid-episode is itself a beat, so it ends the
            // episode through this same branch rather than changing anything under it.
            let hidden = state.hidden;
            // Clearing the state also clears the stall ring, and that is load-bearing rather than
            // incidental: the beat that ENDS a silence episode carries the whole block's stall time
            // in one bucket, so keeping it would have the sawtooth trigger re-report, seconds later,
            // the very wedge the silence trigger just reported in full. The silence path owns that
            // time; the ring starts again from the recovery.
            // `last_suspend_log_ms` survives, for the reason given on the field: it bounds a log
            // line, not an episode, so an episode ending must not hand the next suspend a fresh
            // budget.
            *state = WatchdogState {
                last_suspend_log_ms: state.last_suspend_log_ms,
                ..WatchdogState::default()
            };
            return Effect::Recovered { hung_for_ms, hidden };
        }
        // ── THE SECOND TRIGGER ────────────────────────────────────────────────────────────────
        // Beats are current and no episode is open — every rule above says this app is healthy. It
        // is not, if it has been losing most of its seconds to blocks too short to be noticed one at
        // a time. See `STALL_BUDGET_MS` for the measured window this exists for.
        //
        // Only while VISIBLE: rAF is paused behind a hidden window, so the renderer accrues no stall
        // time there and a budget evaluated then could only ever act on accounting from before the
        // occlusion. That is `HIDDEN_HANG_AFTER`'s territory, not this one's.
        if !input.hidden {
            let stalled_in_window = stall_in_window(state);
            if stalled_in_window >= STALL_BUDGET_MS
                && may_capture(
                    state.last_stall_report_ms,
                    input.now_ms,
                    STALL_REPORT_MIN_INTERVAL.as_millis() as u64,
                )
            {
                state.last_stall_report_ms = input.now_ms;
                return Effect::StallBudget {
                    stalled_ms: stalled_in_window,
                    window_ms: STALL_WINDOW_TICKS as u64 * TICK.as_millis() as u64,
                };
            }
        }
        return Effect::Quiet;
    }

    if !state.reporting {
        state.reporting = true;
        // When the beats STOPPED, not when we noticed — otherwise every episode under-reports by up
        // to the threshold.
        state.hang_started_ms = input.last_beat_ms;
        state.last_report_ms = input.now_ms;
        state.restates = 0;
        state.hidden = input.hidden;
        state.captured = false;
        return Effect::ReportNew { stalled_ms, hidden: input.hidden, starved_ms };
    }

    if input.now_ms.saturating_sub(state.last_report_ms) >= restate_delay_ms(state.restates) {
        state.last_report_ms = input.now_ms;
        state.restates = state.restates.saturating_add(1);
        return Effect::Restate { stalled_ms, hidden: state.hidden, wants_stack: !state.captured };
    }
    Effect::Quiet
}

/// Start the watchdog. Idempotent.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let hangs_dir = crate::dev_identity::app_log_dir(app).map(|d| d.join("hangs")).ok();
    if let Some(dir) = &hangs_dir {
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!(target: "watchdog", "could not create hangs dir, stacks disabled: {e}");
        }
    }
    std::thread::spawn(move || {
        let mut state = WatchdogState::default();
        loop {
            let before = now_ms();
            // Taken as TIGHT around the sleep as the wall reading, and for the same reason: this
            // pair is what attributes the overshoot to a sleeping machine rather than to a starved
            // thread, so any work between the reading and the sleep is time it cannot account for.
            let slept_before = machine_slept_since_boot_ms();
            std::thread::sleep(TICK);
            let after = now_ms();
            let slept_after = machine_slept_since_boot_ms();
            // Saturating: a wall clock can step backwards (NTP), and a negative overshoot must read
            // as "no overshoot" rather than wrapping into a huge one that fakes a suspend.
            let overshoot = after.saturating_sub(before).saturating_sub(TICK.as_millis() as u64);
            let machine_slept_ms = machine_slept_during(slept_before, slept_after);
            let input = TickInput {
                now_ms: after,
                overshoot_ms: overshoot,
                last_beat_ms: LAST_BEAT_MS.load(Ordering::Relaxed),
                hidden: HIDDEN.load(Ordering::Relaxed),
                // DRAINED, not read. Whatever the renderer reported since the last tick belongs to
                // exactly one bucket of the rolling window; leaving it in place would let one bad
                // second be counted by every tick until the next beat overwrote it.
                stall_ms: STALL_MS_SINCE_TICK.swap(0, Ordering::Relaxed),
                machine_slept_ms,
            };

            // Identify (and keep identifying) this app's WebContent processes, so a capture can
            // sample the process the heartbeat actually came from. Cheap in steady state: once the
            // set is known this shells out at most once every `RENDERER_RECHECK`.
            maintain_renderer_tracking(input.last_beat_ms, input.now_ms);

            let effect = step(&mut state, input);
            match effect {
                Effect::Quiet => {}
                Effect::Rebaseline { discarded_gap_ms, announce, .. } => {
                    // Without this the first tick after a wake sees a heartbeat as old as the whole
                    // suspend and reports a hang that never happened.
                    apply_baseline(&LAST_BEAT_MS, &effect);
                    // ── AND SAY THAT WE DID ──────────────────────────────────────────────────
                    // This path discarded a heartbeat gap of ANY size and wrote nothing, at any
                    // level. That silence is the second half of `sparkle-rlmsb4`: with the guard
                    // misfiring on every load spike, the one line that would have shown it — "I
                    // declined to report a thirty-second gap" — existed in no log anyone could read.
                    // INFO rather than WARN, because on the macOS path this now fires only for a
                    // clock-confirmed suspend, which is not a fault and must not read as one; the
                    // fields are what make it worth having, since `machine_slept_ms` ≈
                    // `overshoot_ms` is the proof the discrimination actually ran.
                    if announce {
                        tracing::info!(
                            target: "watchdog",
                            discarded_gap_ms,
                            overshoot_ms = input.overshoot_ms,
                            machine_slept_ms = ?input.machine_slept_ms,
                            "the machine slept through our own tick; discarding the heartbeat gap rather than reporting a hang"
                        );
                    }
                }
                Effect::ReportNew { stalled_ms, hidden, starved_ms } => {
                    // Worded for what is OBSERVED, not for a diagnosis we cannot prove: on macOS the
                    // webview runs in its own process, so a dead/reloading content process makes
                    // identical silence with a healthy main thread. Written while the app is still
                    // hung, which is the whole point — everything else could only speak afterwards.
                    if is_reportable_evidence(hidden) && starved_ms > 0 {
                        // A STARVED freeze, and the line says so on purpose. Our own sleep overran
                        // by `starved_ms` while the machine was awake, so this thread was
                        // descheduled alongside the main thread and the whole process was starved of
                        // CPU. The freeze is real — the user sat through it — but the remedy is the
                        // host's load, and a reader who is not told that goes looking for a lock
                        // that was never held. It is also the case to read a captured stack most
                        // carefully in: everything will look parked, because everything was.
                        tracing::warn!(
                            target: "watchdog",
                            stalled_ms,
                            hidden,
                            starved_ms,
                            "no heartbeat from the webview, and our own watchdog tick overran while the machine was AWAKE — this process was starved of CPU; the freeze is real but its cause is host load rather than necessarily a blocked main thread; capturing stack"
                        );
                    } else if is_reportable_evidence(hidden) {
                        tracing::warn!(
                            target: "watchdog",
                            stalled_ms,
                            hidden,
                            "no heartbeat from the webview — the main thread may be blocked right now; capturing stack"
                        );
                    } else {
                        tracing::info!(
                            target: "watchdog",
                            stalled_ms,
                            hidden,
                            starved_ms,
                            "no heartbeat from a HIDDEN webview — expected while backgrounded (throttled timers), but capturing a stack in case it is a backgrounded wedge"
                        );
                    }
                }
                Effect::Restate { stalled_ms, hidden, .. } => {
                    if is_reportable_evidence(hidden) {
                        tracing::warn!(
                            target: "watchdog",
                            stalled_ms,
                            "still no heartbeat from the webview"
                        );
                    } else {
                        tracing::info!(
                            target: "watchdog",
                            stalled_ms,
                            hidden,
                            "still no heartbeat from a hidden webview"
                        );
                    }
                }
                Effect::Recovered { hung_for_ms, hidden } => {
                    // The duration no other instrument can produce: a hang that outlives the user's
                    // patience has no other record anywhere. `hidden` is what separates that from an
                    // equally long cmd-tab, which is otherwise the identical line.
                    if is_reportable_evidence(hidden) {
                        tracing::warn!(
                            target: "watchdog",
                            hung_for_ms,
                            "webview heartbeat resumed"
                        );
                    } else {
                        tracing::info!(
                            target: "watchdog",
                            hung_for_ms,
                            hidden,
                            "webview heartbeat resumed after a hidden gap (likely backgrounding, not a hang)"
                        );
                    }
                }
                Effect::StallBudget { stalled_ms, window_ms } => {
                    // WARN, like a visible silence episode, and for the same reason: the window this
                    // describes is one the user experiences as an unusable app. The wording says what
                    // was measured — time lost to stalls — and states the bar it did NOT cross, so a
                    // reader is not left wondering why the silence lines are absent. The per-stall
                    // breakdown is in the renderer's own `jank stall` / `jank minor stalls` lines at
                    // these same timestamps; this line is what makes the app act on them.
                    tracing::warn!(
                        target: "watchdog",
                        stalled_ms,
                        window_ms,
                        hang_after_ms = HANG_AFTER.as_millis() as u64,
                        "the UI lost most of a window to main-thread stalls, none long enough to trip the silence bar; capturing stack"
                    );
                }
            }

            // ── ONE CAPTURE PATH, ONE LIMITER, TWO POOLS ─────────────────────────────────────
            // Lifted out of the arms above when the stall-budget trigger was added, so a new trigger
            // has to declare its pool in `capture_for` rather than reach for `try_capture` itself.
            // That is the difference between reusing the rate limiter and merely intending to: a
            // trigger with its own path could fire alongside a silence episode and evict the very
            // stack it was meant to complement, out of a budget of `MAX_HANG_DUMPS` files.
            //
            // PERSISTENCE EARNS THE STACK. `capture_for` returns `Some` for a `Restate` that still
            // owes one, so an episode refused at open — the limiter having just been spent, most
            // likely by an ordinary cmd-tab — keeps asking and gets its stack as soon as the floor
            // expires. Without that the refusal was PERMANENT for the episode, because `ReportNew`
            // fires exactly once.
            if let Some(hidden) = capture_for(&effect) {
                if try_capture(
                    hangs_dir.as_deref(),
                    hidden,
                    after,
                    &LAST_VISIBLE_CAPTURE_MS,
                    &LAST_HIDDEN_CAPTURE_MS,
                ) && capture_satisfies_episode(&effect)
                {
                    note_captured(&mut state);
                }
            }
        }
    });
    tracing::info!(
        target: "watchdog",
        hang_after_ms = HANG_AFTER.as_millis() as u64,
        hidden_hang_after_ms = HIDDEN_HANG_AFTER.as_millis() as u64,
        stall_budget_ms = STALL_BUDGET_MS,
        stall_window_ms = STALL_WINDOW_TICKS as u64 * TICK.as_millis() as u64,
        "main-thread watchdog started (off-thread)"
    );
}

/// Capture a stack if policy allows it, returning whether one was actually taken.
///
/// BOTH pools are rate-limited now, on very different floors and for different reasons — 30 minutes
/// for hidden (`HIDDEN_CAPTURE_MIN_INTERVAL`: bound the cost of a benign, frequent event) and 30
/// seconds for visible (`VISIBLE_CAPTURE_MIN_INTERVAL`: collapse the second detection of one
/// stall). The pool sizes bound files KEPT; these bound the `sample(1)` runs themselves, which is
/// where the cost actually is.
///
/// The limiter is consumed only when a capture really happens, so a refused attempt leaves the slot
/// for the next asker — which is what lets a persisting episode retry from `Restate`.
fn try_capture(
    dir: Option<&Path>,
    hidden: bool,
    now_ms: u64,
    last_visible: &AtomicU64,
    last_hidden: &AtomicU64,
) -> bool {
    try_capture_with(dir, hidden, now_ms, last_visible, last_hidden, &mut capture_stack_into)
}

/// `try_capture` with the actual capture injected, so a test can count captures without spawning
/// `sample(1)`. Kept immediately beside its one production caller above, which is a two-line
/// wrapper: the seam is the argument, not a defaulted field every test quietly replaces.
fn try_capture_with(
    dir: Option<&Path>,
    hidden: bool,
    now_ms: u64,
    last_visible: &AtomicU64,
    last_hidden: &AtomicU64,
    capture: &mut dyn FnMut(&Path, u64, usize),
) -> bool {
    let Some(dir) = dir else { return false };
    let (limiter, min_interval) = if hidden {
        (last_hidden, HIDDEN_CAPTURE_MIN_INTERVAL)
    } else {
        (last_visible, VISIBLE_CAPTURE_MIN_INTERVAL)
    };
    if !may_capture(limiter.load(Ordering::Relaxed), now_ms, min_interval.as_millis() as u64) {
        // STORE ONLY ON SUCCESS. Consuming the interval here instead would push the next allowed
        // capture out by a further full interval on every refusal, which defeats the `Restate`
        // retry this helper exists to enable — the episode would keep asking and keep being
        // refused. Injected rather than reading the statics directly so a test can assert exactly
        // that: the pure predicate alone cannot distinguish the two.
        return false;
    }
    limiter.store(now_ms, Ordering::Relaxed);
    let (target, keep) = dump_target(dir, hidden);
    capture(&target, now_ms, keep);
    true
}

/// Delete all but the newest `keep` dumps in one pool. Best-effort.
///
/// `retention.rs` cannot do this: it only considers entries directly in the log dir with the
/// `sparkle.log` prefix and deliberately does not recurse, so without this the directory grows
/// without bound — multi-MB per capture, on a threshold that ordinary severe jank can trip.
///
/// `keep` is per-pool rather than global precisely so a hidden episode can never evict a visible
/// one; see `dump_pool`.
/// A pool is also capped in BYTES, not just in files. The file count is the cheap dimension to
/// bound and the wrong one to bound alone: one dump is a full `sample(1)` call graph, which measured
/// between 0.5 MB and 3.5 MB in practice, so a 20-file budget authorises anywhere from 10 MB to
/// 70 MB. Observed on a real install: 23 dumps holding 41 MB of a user's log directory. Whichever
/// limit binds first wins, so a run of unusually large stacks is evicted on size while the ordinary
/// case still keeps the full `keep` files of history.
#[cfg(target_os = "macos")]
const MAX_HANG_DUMP_BYTES: u64 = 24 * 1024 * 1024;

#[cfg(target_os = "macos")]
fn prune_hang_dumps(dir: &Path, keep: usize) {
    prune_hang_dumps_to(dir, keep, MAX_HANG_DUMP_BYTES)
}

/// The episode stamp a dump belongs to, or `None` if the file is not one of ours.
///
/// `hang-<stamp>.txt` and `hang-<stamp>.webcontent-<pid>.txt` both yield `<stamp>`. That shared key
/// is the whole reason the renderer dump is named the way it is: the pairing has to be legible in a
/// directory listing AND recoverable by the pruner, and one filename convention does both.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn dump_stamp(file_name: &str) -> Option<&str> {
    let rest = file_name.strip_prefix("hang-")?;
    let stamp = rest.split('.').next().unwrap_or(rest);
    (!stamp.is_empty()).then_some(stamp)
}

#[cfg(target_os = "macos")]
fn prune_hang_dumps_to(dir: &Path, keep: usize, max_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    // Grouped BY EPISODE, not by file. An episode now writes a host dump plus one per WebContent
    // process, and the halves are only useful together — a renderer stack whose host stack was
    // evicted is a call graph with nothing to correlate against. Grouping also keeps `keep` meaning
    // what it has always meant (episodes of history) instead of silently becoming
    // `keep / files-per-episode` the moment renderers were added, which is exactly the way "add
    // files without updating pruning" makes a cap stop binding.
    let mut groups: std::collections::BTreeMap<String, (SystemTime, u64, Vec<PathBuf>)> =
        std::collections::BTreeMap::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stamp) = dump_stamp(&name) else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        let group = groups
            .entry(stamp.to_string())
            .or_insert((modified, 0, Vec::new()));
        // Age the group by its NEWEST member: the renderer dumps land seconds after the host one,
        // and an episode is only old once all of it is.
        if modified > group.0 {
            group.0 = modified;
        }
        group.1 = group.1.saturating_add(meta.len());
        group.2.push(entry.path());
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_by_key(|(t, _, _)| *t); // oldest first

    // Evict oldest-first until BOTH budgets are satisfied. Count first (cheap and exact), then
    // size over what survived it.
    let over_count = groups.len().saturating_sub(keep);
    let mut total: u64 = groups.iter().skip(over_count).map(|(_, bytes, _)| *bytes).sum();
    let mut evict = over_count;
    while evict < groups.len() && total > max_bytes {
        total = total.saturating_sub(groups[evict].1);
        evict += 1;
    }
    for (_, _, paths) in groups.iter().take(evict) {
        for path in paths {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Where the HOST process's dump goes.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn host_dump_path(dir: &Path, stamp_ms: u64) -> PathBuf {
    dir.join(format!("hang-{stamp_ms}.txt"))
}

/// Where one WebContent process's dump goes.
///
/// A SIBLING of the host dump, sharing its stamp, so the pairing is obvious in a directory listing
/// and the pruner can recover it (`dump_stamp`). The host dump keeps its existing name unchanged —
/// every tool, script and habit that reads `hang-<stamp>.txt` still finds exactly what it found
/// before, and the new evidence arrives beside it rather than in place of it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn renderer_dump_path(dir: &Path, stamp_ms: u64, pid: u32) -> PathBuf {
    dir.join(format!("hang-{stamp_ms}.webcontent-{pid}.txt"))
}

/// Shell out to macOS `sample(1)`, so a hang leaves a blocked-thread stack without the user having
/// to know the command or reach a terminal before force-quitting.
///
/// ONE SAMPLE PER PROCESS. The trigger is a webview heartbeat and the webview's JS runs in a
/// WebContent process, so sampling only `std::process::id()` — as this did until now — reliably
/// missed the frozen thread; see the module header for the measurement. `sample` takes exactly one
/// pid, so covering both means more than one child, which is why there is a concurrency cap.
///
/// Best-effort by design: `sample` may be unavailable or refused, and a watchdog that panicked or
/// blocked while trying to take a sample would be strictly worse than one that logged the WARN and
/// moved on. The watchdog thread must also stay on its tick to keep restating an ongoing hang, so it
/// never waits here — a short-lived helper thread reaps each child and reports what actually
/// happened. Reporting only the fork/exec succeeding would name a file that may hold nothing.
#[cfg(target_os = "macos")]
fn capture_stack_into(dir: &Path, stamp_ms: u64, keep: usize) {
    // ── THE IPC TIMELINE GOES FIRST, BEFORE ANY `sample(1)` ───────────────────────────────────
    // This is a synchronous in-process write of state we already hold, so it costs milliseconds and
    // cannot fail for a reason outside this process. `sample` can be missing, refused by the
    // security policy, or simply slow, and every one of those outcomes used to leave an episode
    // with NO evidence at all — which is exactly what happened three times on 2026-08-13, where the
    // stacks that did land could not explain the hang anyway (see this module's header and
    // `ipc_ring`'s). Ordering it ahead of `spawn_sample` means the timeline lands whatever the
    // sampler does.
    //
    // Here rather than in `try_capture_with`: that function's `capture` argument is INJECTED so its
    // tests can avoid the filesystem entirely, so a write placed there would be replaced by every
    // test and never exercised. `capture_stack_into` is already the "do the I/O" boundary.
    ipc_trace::dump_to_file(dir, stamp_ms);

    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!(target: "watchdog", "could not create dump dir {dir:?}, stack skipped: {e}");
        return;
    }
    // The host process, exactly as before — this path must never capture LESS than it used to.
    spawn_sample(std::process::id(), host_dump_path(dir, stamp_ms), dir, keep, "host");

    // Then the renderer(s), re-verified against a live listing first: a recorded pid can be dead
    // (WebKit respawned it) or, worse, recycled by an unrelated process.
    let recorded = { renderers().pids.clone() };
    if recorded.is_empty() {
        return;
    }
    let live = live_renderer_pids(&recorded, &webcontent_pids_now());
    if live.len() != recorded.len() {
        tracing::info!(
            target: "watchdog",
            recorded = ?recorded,
            live = ?live,
            "some recorded WebContent pids are no longer live WebContent processes; skipping them"
        );
    }
    for pid in live {
        spawn_sample(pid, renderer_dump_path(dir, stamp_ms, pid), dir, keep, "webcontent");
    }
}

/// Fork one `sample(1)`, bounded, and reap it off the watchdog's tick.
#[cfg(target_os = "macos")]
fn spawn_sample(pid: u32, path: PathBuf, dir: &Path, keep: usize, what: &'static str) {
    // BOUNDED. An episode spawns up to `1 + MAX_OWN_WEBCONTENT` children, each attaching to a
    // process for 15-23s (see `SAMPLE_INTERVAL_MS`), and the app it attaches to is by definition
    // already struggling. Without a cap, a pathological sequence of episodes could stack samples
    // until the instrument IS the outage. Refusing is the right failure: we already have a stack
    // from moments ago.
    if SAMPLES_IN_FLIGHT
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < MAX_CONCURRENT_SAMPLES).then_some(n + 1)
        })
        .is_err()
    {
        tracing::warn!(
            target: "watchdog",
            pid, what, max = MAX_CONCURRENT_SAMPLES,
            "sample(1) concurrency budget full; skipping this process for this episode"
        );
        return;
    }
    // Duration then interval, positionally: `sample <pid> [duration [samplingInterval]] [-file …]`.
    // 5 seconds is long enough to show whether the blocking frame persists rather than catching one
    // unlucky instant, and short enough to land while the hang is still on.
    let spawned = Command::new("/usr/bin/sample")
        .arg(pid.to_string())
        .args([SAMPLE_SECONDS, SAMPLE_INTERVAL_MS, "-file"])
        .arg(&path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        Ok(mut child) => {
            // Reaped on its own thread: an unwaited child stays a zombie for the life of the app,
            // and the exit status is the only thing that distinguishes a real capture from a file
            // that was never written.
            let prune_dir = dir.to_path_buf();
            std::thread::spawn(move || {
                let result = child.wait();
                SAMPLES_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
                match result {
                    Ok(status) if status.success() => {
                        // PRUNE HERE, not before the spawn. `sample(1)` writes the file
                        // asynchronously, so pruning up-front measured a population that did not yet
                        // include the dump about to land — the budget was enforced against the wrong
                        // set and the pool settled ABOVE `keep` (observed: 23 files for keep=20,
                        // because overlapping captures each passed the pre-write check and then all
                        // wrote). Pruning once the capture has actually landed makes `keep` the real
                        // ceiling and costs nothing: we are already off the watchdog's tick. Every
                        // child of one episode prunes, which is harmless — pruning is by episode
                        // group and idempotent, and the last one to finish sees the full set.
                        prune_hang_dumps(&prune_dir, keep);
                        tracing::warn!(target: "watchdog", what, pid, path = %path.display(), "captured hang stack")
                    }
                    Ok(status) => {
                        tracing::warn!(target: "watchdog", what, pid, ?status, "sample(1) exited non-zero; no stack captured")
                    }
                    Err(e) => {
                        tracing::warn!(target: "watchdog", what, pid, "could not reap sample(1): {e}")
                    }
                }
            });
        }
        Err(e) => {
            SAMPLES_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
            tracing::warn!(target: "watchdog", what, pid, "could not run sample(1): {e}");
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn capture_stack_into(_dir: &Path, _stamp_ms: u64, _keep: usize) {}

#[cfg(test)]
mod tests {
    use super::*;

    const VISIBLE: bool = false;
    /// A tick that ran on schedule — i.e. we were NOT suspended.
    const PUNCTUAL: u64 = 0;
    const HANG_MS: u64 = HANG_AFTER.as_millis() as u64;
    /// The mach pair read back "the machine did not sleep at all during our tick". What a punctual
    /// tick means, and — with a large `overshoot_ms` — what STARVATION looks like.
    const AWAKE: Option<u64> = Some(0);
    /// An overshoot far past `SUSPEND_OVERSHOOT`: the measured 2026-08-21 freeze.
    const FREEZE_MS: u64 = 30_000;

    fn input(now_ms: u64, last_beat_ms: u64, hidden: bool) -> TickInput {
        TickInput {
            now_ms,
            overshoot_ms: PUNCTUAL,
            last_beat_ms,
            hidden,
            stall_ms: 0,
            machine_slept_ms: AWAKE,
        }
    }

    /// Drive an episode: beats stop at `beats_stopped_at`, we tick until `until`, and the effects
    /// are returned in order. Exercises the real loop's state threading, not a single call.
    fn run(from: u64, until: u64, beats_stopped_at: u64) -> (WatchdogState, Vec<Effect>) {
        let mut state = WatchdogState::default();
        let mut effects = Vec::new();
        let mut t = from;
        while t <= until {
            effects.push(step(&mut state, input(t, beats_stopped_at, VISIBLE)));
            t += 1_000;
        }
        (state, effects)
    }

    // ── THE HEADLINE NUMBER ────────────────────────────────────────────────────────────────────
    // The recovery line is the whole justification for this module: a hang that outlives the user's
    // patience has no other record anywhere. It reported the WRONG QUANTITY. `Recovered` is only
    // reachable once beats are current again, so the residual staleness there is a few hundred ms —
    // a 90-second beachball logged ~143ms and read as "brief". The duration must be measured from
    // when the beats STOPPED.
    #[test]
    fn recovery_reports_the_whole_wedge_not_the_residual_staleness() {
        let mut state = WatchdogState::default();
        // Beats stopped at t=10_000. We notice at 16_000 and keep ticking to 100_000.
        assert!(matches!(
            step(&mut state, input(16_000, 10_000, VISIBLE)),
            Effect::ReportNew { .. }
        ));
        for t in (17_000..=100_000).step_by(1_000) {
            step(&mut state, input(t, 10_000, VISIBLE));
        }
        // At t=100_500 a beat lands (stamped 100_400): 90.4s after the beats stopped.
        let effect = step(&mut state, input(100_500, 100_400, VISIBLE));
        assert_eq!(
            effect,
            Effect::Recovered { hung_for_ms: 90_500, hidden: false },
            "must measure from when beats stopped (10_000), not the ~100ms residual"
        );
    }

    // The episode must start when the beats stopped, not when we noticed, or every hang
    // under-reports by up to the threshold.
    #[test]
    fn the_episode_starts_when_beats_stopped_not_when_we_noticed() {
        let mut state = WatchdogState::default();
        step(&mut state, input(16_000, 10_000, VISIBLE));
        assert_eq!(state.hang_started_ms, 10_000);
    }

    // ── SUSPEND vs HANG ────────────────────────────────────────────────────────────────────────
    // THE HEADLINE PAIR, and the pair is the whole test. Both halves feed the SAME large overshoot
    // and differ in one input: what the mach clocks said about the machine. Either half alone
    // proves nothing — an always-report mutation passes the starved half and an always-suppress
    // mutation (which is what shipped, `sparkle-rlmsb4`) passes the slept half.
    //
    // This replaces a test named `our_own_tick_overrunning_means_we_were_suspended_not_that_the_ui_hung`,
    // whose title stated the defect as the requirement. Its assertion — the same overshoot, the
    // same `Rebaseline` — survives verbatim as `..._when_the_machine_really_slept` below, now
    // qualified by the reading that makes it true.
    #[test]
    fn a_tick_that_overran_while_the_machine_was_awake_is_a_starved_hang_and_is_reported() {
        let now = 8 * 3600 * 1000;
        let mut state = WatchdogState::default();
        let effect = step(
            &mut state,
            TickInput {
                now_ms: now,
                overshoot_ms: FREEZE_MS,
                last_beat_ms: now - FREEZE_MS,
                hidden: false,
                stall_ms: 0,
                // The mach pair counted no sleep at all: the machine was up the whole time and it
                // was THIS PROCESS that was not scheduled.
                machine_slept_ms: AWAKE,
            },
        );
        assert_eq!(
            effect,
            Effect::ReportNew { stalled_ms: FREEZE_MS, hidden: false, starved_ms: FREEZE_MS },
            "a 30s freeze on an awake machine is the incident this branch exists for; \
             suppressing it is what produced a total UI freeze with no capture"
        );
        assert!(state.reporting, "and the episode must really be open, so restates follow");
    }

    #[test]
    fn the_identical_overshoot_is_still_suppressed_when_the_machine_really_slept() {
        let now = 8 * 3600 * 1000;
        let mut state = WatchdogState::default();
        // Byte-for-byte the tick above except for the clock reading. Every other input says "hung",
        // and it still must not report — this is the anti-phantom property, unchanged.
        let effect = step(
            &mut state,
            TickInput {
                now_ms: now,
                overshoot_ms: FREEZE_MS,
                last_beat_ms: now - FREEZE_MS,
                hidden: false,
                stall_ms: 0,
                machine_slept_ms: Some(FREEZE_MS),
            },
        );
        assert_eq!(
            effect,
            Effect::Rebaseline {
                new_last_beat_ms: now,
                discarded_gap_ms: FREEZE_MS,
                announce: true,
            }
        );
        assert!(!state.reporting, "a lid-open must not leave an episode open behind it");
    }

    // The fallback, which is the direction the anti-phantom property depends on: off macOS, or when
    // the timebase cannot be read, there IS no discrimination and the old inference is all we have.
    // Getting this backwards would file a phantom multi-hour hang on every wake on every platform
    // that cannot take the reading.
    #[test]
    fn an_unreadable_clock_falls_back_to_suppressing_not_to_reporting() {
        let now = 8 * 3600 * 1000;
        assert!(machine_was_suspended(None), "unknown must read as suspended, never as awake");
        let mut state = WatchdogState::default();
        assert_eq!(
            step(
                &mut state,
                TickInput {
                    now_ms: now,
                    overshoot_ms: FREEZE_MS,
                    last_beat_ms: now - FREEZE_MS,
                    hidden: false,
                    stall_ms: 0,
                    machine_slept_ms: None,
                },
            ),
            Effect::Rebaseline {
                new_last_beat_ms: now,
                discarded_gap_ms: FREEZE_MS,
                announce: true,
            }
        );
    }

    // A HALF-READING MUST NOT BECOME A CONFIDENT ZERO. `Some(0)` means "the machine was awake",
    // which is the REPORT side of the discriminator — so folding a missing endpoint into a delta
    // would file a phantom multi-hour hang on every lid-open, the regression this whole change
    // exists not to cause. Paired with the both-present case so "always None" cannot pass either.
    #[test]
    fn a_missing_clock_reading_at_either_end_is_unknown_not_zero_sleep() {
        assert_eq!(machine_slept_during(None, Some(30_000)), None);
        assert_eq!(machine_slept_during(Some(10), None), None);
        assert_eq!(machine_slept_during(None, None), None);
        assert_eq!(
            machine_slept_during(Some(10), Some(30_010)),
            Some(30_000),
            "and with both ends present it must be the delta, or the discriminator never sees sleep"
        );
        // A clock that appeared to go backwards reads as no sleep, never as a wrapped eternity.
        assert_eq!(machine_slept_during(Some(30_000), Some(10)), Some(0));
    }

    // THE TWO THINGS AN AWAKE MACHINE CANNOT SHOW YOU. Both are silent when wrong and both undo
    // the fix in the anti-phantom direction, which is the one direction this change may not
    // regress. See `slept_ms_from_ticks`.
    #[test]
    fn the_tick_fold_subtracts_the_right_way_round_and_applies_the_timebase() {
        // Apple silicon: 125/3 ns per tick, so 24_000_000 ticks is exactly one second.
        assert_eq!(
            slept_ms_from_ticks(1_000_000, 1_000_000 + 24_000_000, 125, 3),
            1_000,
            "continuous MINUS absolute, converted — reversed it saturates to 0 and every lid-open \
             becomes a reported hang; unconverted it reads 24ms and an hour of sleep clears nothing"
        );
        // x86_64: a tick is a nanosecond.
        assert_eq!(slept_ms_from_ticks(5, 5 + 1_000_000, 1, 1), 1);
        // Awake: the two clocks are level, which is the reading that makes a starved tick
        // reportable at all.
        assert_eq!(slept_ms_from_ticks(9_999, 9_999, 125, 3), 0);
        // Eight hours on Apple silicon, the case the bar exists for.
        assert_eq!(slept_ms_from_ticks(0, 8 * 3600 * 24_000_000, 125, 3), 8 * 3600 * 1_000);
        // A pair that appears to run backwards reads as no sleep, never as a wrapped eternity.
        assert_eq!(slept_ms_from_ticks(24_000_000, 0, 125, 3), 0);
        // An unreadable timebase cannot divide by zero in the watchdog thread.
        assert_eq!(slept_ms_from_ticks(0, 24_000_000, 125, 0), 0);
    }

    // THE READING ITSELF, against the real clocks. Everything else here drives `step` with a number
    // a test made up; this is the one place that checks the number can actually be obtained and
    // means what the discriminator assumes. A swapped pair, a constant, or an unreadable timebase
    // all leave the suite green otherwise, and all three make the fix inert in production.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_two_mach_clocks_are_live_and_agree_while_the_machine_is_awake() {
        // SAFETY: both are argument-less reads of a kernel-maintained counter.
        let (abs0, cont0) =
            unsafe { (mach_clock::mach_absolute_time(), mach_clock::mach_continuous_time()) };
        let before = machine_slept_since_boot_ms().expect("the timebase must be readable on macOS");
        std::thread::sleep(Duration::from_millis(50));
        let after = machine_slept_since_boot_ms().expect("the timebase must be readable on macOS");
        // SAFETY: as above.
        let (abs1, cont1) =
            unsafe { (mach_clock::mach_absolute_time(), mach_clock::mach_continuous_time()) };

        assert!(abs1 > abs0 && cont1 > cont0, "both clocks must be LIVE; a constant one would make the discriminator silently inert");
        assert!(
            cont0 >= abs0 && cont1 >= abs1,
            "continuous counts a superset of absolute — reading them the other way round saturates \
             every genuine suspend to zero sleep and turns every lid-open into a reported hang"
        );
        assert_eq!(
            machine_slept_during(Some(before), Some(after)),
            Some(0),
            "no machine sleep happened during a 50ms sleep on the box running this test, so the \
             pair must report none — this zero is what makes a starved tick reportable"
        );
    }

    // The boundary the discriminator actually turns on. Below `SUSPEND_CONFIRM` the counted sleep
    // cannot explain the overshoot, so the overshoot belongs to starvation.
    #[test]
    fn the_suspend_verdict_turns_at_suspend_confirm() {
        let confirm = SUSPEND_CONFIRM.as_millis() as u64;
        assert!(!machine_was_suspended(Some(confirm - 1)), "one ms short is not a sleep");
        assert!(machine_was_suspended(Some(confirm)), "exactly at it is");
    }

    // A tick that overran but stayed UNDER the bar is not starvation and must not be labelled as
    // such — otherwise `starved_ms` decorates ordinary jitter and the log line stops meaning
    // anything. Paired with the reported case above, which shares everything but the overshoot.
    #[test]
    fn an_overshoot_below_the_bar_reports_without_claiming_starvation() {
        let now = 100_000;
        let mut state = WatchdogState::default();
        assert_eq!(
            step(
                &mut state,
                TickInput {
                    now_ms: now,
                    overshoot_ms: SUSPEND_OVERSHOOT.as_millis() as u64 - 1,
                    last_beat_ms: now - FREEZE_MS,
                    hidden: false,
                    stall_ms: 0,
                    machine_slept_ms: AWAKE,
                },
            ),
            Effect::ReportNew { stalled_ms: FREEZE_MS, hidden: false, starved_ms: 0 }
        );
    }

    // ── THE SUPPRESSION IS OBSERVABLE, AND RATE-LIMITED ────────────────────────────────────────
    // Both halves are needed. "It announces" alone passes for an unlimited firehose; "the second one
    // is quiet" alone passes for a path that never announces at all — which is exactly what shipped.
    #[test]
    fn a_suppressed_gap_announces_once_then_stays_quiet_until_the_interval_expires() {
        let interval = SUSPEND_LOG_MIN_INTERVAL.as_millis() as u64;
        let now = 8 * 3600 * 1000;
        let slept = TickInput {
            now_ms: now,
            overshoot_ms: FREEZE_MS,
            last_beat_ms: now - FREEZE_MS,
            hidden: false,
            stall_ms: 0,
            machine_slept_ms: Some(FREEZE_MS),
        };
        let mut state = WatchdogState::default();
        assert_eq!(
            step(&mut state, slept),
            Effect::Rebaseline { new_last_beat_ms: now, discarded_gap_ms: FREEZE_MS, announce: true },
            "the first suppression must say what it threw away"
        );

        // Inside the interval: same suppression, no second line. The limiter has to survive the
        // `*state = default()` the branch above performs, or this is indistinguishable from the
        // first tick.
        let soon = now + interval - 1;
        assert_eq!(
            step(&mut state, TickInput { now_ms: soon, last_beat_ms: soon - FREEZE_MS, ..slept }),
            Effect::Rebaseline {
                new_last_beat_ms: soon,
                discarded_gap_ms: FREEZE_MS,
                announce: false,
            },
            "a nightly-sleeping laptop must not become a nightly firehose"
        );

        // Past it: audible again.
        let later = now + interval;
        assert_eq!(
            step(&mut state, TickInput { now_ms: later, last_beat_ms: later - FREEZE_MS, ..slept }),
            Effect::Rebaseline {
                new_last_beat_ms: later,
                discarded_gap_ms: FREEZE_MS,
                announce: true,
            }
        );
    }

    // THE LIMITER SURVIVES THE OTHER RESET TOO. `Recovered` also does `*state = default()`, so a
    // hang episode landing between two suspends would hand the second one a fresh budget and the
    // rate limit would be defeated by ordinary traffic rather than by time passing.
    #[test]
    fn an_episode_recovering_does_not_refill_the_suppression_log_budget() {
        let mut state = WatchdogState::default();
        // A suspend, announced.
        let t0 = 100_000;
        assert!(matches!(
            step(&mut state, TickInput {
                now_ms: t0,
                overshoot_ms: FREEZE_MS,
                last_beat_ms: t0 - FREEZE_MS,
                hidden: false,
                stall_ms: 0,
                machine_slept_ms: Some(FREEZE_MS),
            }),
            Effect::Rebaseline { announce: true, .. }
        ));

        // A perfectly ordinary hang episode, opening and recovering inside the interval.
        assert!(matches!(step(&mut state, input(t0 + 6_000, t0 + 1_000, VISIBLE)), Effect::ReportNew { .. }));
        assert!(matches!(step(&mut state, input(t0 + 7_000, t0 + 6_900, VISIBLE)), Effect::Recovered { .. }));

        // A second suspend, still inside `SUSPEND_LOG_MIN_INTERVAL` of the first.
        let t1 = t0 + SUSPEND_LOG_MIN_INTERVAL.as_millis() as u64 - 1;
        assert_eq!(
            step(&mut state, TickInput {
                now_ms: t1,
                overshoot_ms: FREEZE_MS,
                last_beat_ms: t1 - FREEZE_MS,
                hidden: false,
                stall_ms: 0,
                machine_slept_ms: Some(FREEZE_MS),
            }),
            Effect::Rebaseline { new_last_beat_ms: t1, discarded_gap_ms: FREEZE_MS, announce: false },
            "an unrelated episode ending must not buy the log another line"
        );
    }

    // The gap is what a reader needs; `now - 0` is "milliseconds since 1970" and would print a
    // 58-year hang on the first tick of a launch that suspends before the webview ever beats.
    #[test]
    fn a_suppression_before_the_first_heartbeat_reports_no_gap_rather_than_the_epoch() {
        let now = 8 * 3600 * 1000;
        assert_eq!(
            step(
                &mut WatchdogState::default(),
                TickInput {
                    now_ms: now,
                    overshoot_ms: FREEZE_MS,
                    last_beat_ms: 0,
                    hidden: false,
                    stall_ms: 0,
                    machine_slept_ms: Some(FREEZE_MS),
                },
            ),
            Effect::Rebaseline { new_last_beat_ms: now, discarded_gap_ms: 0, announce: true }
        );
    }

    // The previous version of the test above asserted `state == default` after a suspend and called
    // that "it must CLEAR any open episode". It was VACUOUS: the state started at default and no
    // episode was ever opened, so it passed identically with the `*state = default()` line deleted.
    //
    // The mutation is not cosmetic. Leaving the episode open across a suspend keeps a stale
    // `hang_started_ms` from BEFORE the sleep, so the next healthy tick emits a `Recovered` spanning
    // the whole machine suspend — the phantom multi-hour hang this module exists to prevent, coming
    // back in through the recovery line instead of the report line. So: open a real episode FIRST.
    #[test]
    fn a_suspend_closes_an_open_episode_so_the_wake_is_not_reported_as_a_recovery() {
        let mut state = WatchdogState::default();
        // A genuine episode is open and has been running for a while.
        assert!(matches!(step(&mut state, input(16_000, 10_000, VISIBLE)), Effect::ReportNew { .. }));
        assert!(state.reporting, "precondition: the episode really is open");

        // Now the lid closes for eight hours — and the mach clocks agree that it did, which is the
        // input this test grew when the overshoot alone stopped being sufficient evidence.
        let wake = 8 * 3600 * 1000;
        let effect = step(
            &mut state,
            TickInput {
                now_ms: wake,
                overshoot_ms: SUSPEND_OVERSHOOT.as_millis() as u64,
                last_beat_ms: 10_000,
                hidden: false,
                stall_ms: 0,
                machine_slept_ms: Some(wake - 16_000),
            },
        );
        assert_eq!(
            effect,
            Effect::Rebaseline {
                new_last_beat_ms: wake,
                discarded_gap_ms: wake - 10_000,
                announce: true,
            }
        );
        assert_eq!(state, WatchdogState {
            // The only field a suppression may carry forward; see the field's own note.
            last_suspend_log_ms: wake,
            ..WatchdogState::default()
        }, "the open episode must be cleared, not carried");

        // The assertion that actually bites: the next healthy tick must be silent, NOT a recovery
        // claiming the machine slept for eight hours of hang.
        assert_eq!(
            step(&mut state, input(wake + 1_000, wake + 900, VISIBLE)),
            Effect::Quiet,
            "a wake must not surface as a recovery claiming ~8h of hang"
        );
    }

    // ITS PAIR. The identical open episode and the identical overshoot, with the machine AWAKE:
    // now nothing is excused, the episode stays open, and the freeze keeps being reported. Without
    // this, `a_suspend_closes_an_open_episode…` above passes just as happily for the shipped defect,
    // which closed the episode on every load spike.
    #[test]
    fn a_starved_tick_does_not_close_an_open_episode_it_keeps_reporting_it() {
        let mut state = WatchdogState::default();
        assert!(matches!(step(&mut state, input(16_000, 10_000, VISIBLE)), Effect::ReportNew { .. }));
        let opened_at = state.hang_started_ms;

        // Ten seconds later the box is at load 500 and our own sleep overran by thirty. The lid
        // never closed.
        let t = 16_000 + RESTATE_EVERY.as_millis() as u64;
        let effect = step(
            &mut state,
            TickInput {
                now_ms: t,
                overshoot_ms: FREEZE_MS,
                last_beat_ms: 10_000,
                hidden: false,
                stall_ms: 0,
                machine_slept_ms: AWAKE,
            },
        );
        assert_eq!(
            effect,
            Effect::Restate { stalled_ms: t - 10_000, hidden: false, wants_stack: true },
            "the episode is still on and still owed a stack; a starved tick is not amnesty"
        );
        assert!(state.reporting, "and it must still be OPEN");
        assert_eq!(state.hang_started_ms, opened_at, "with the original start, not a rebaselined one");

        // Which means the recovery still carries the TRUE duration, the one number no other
        // instrument in the app can produce.
        assert_eq!(
            step(&mut state, input(t + 1_000, t + 900, VISIBLE)),
            Effect::Recovered { hung_for_ms: t + 1_000 - 10_000, hidden: false }
        );
    }

    // The one piece of state a tick writes outside `WatchdogState`, and the guard against a phantom
    // hang on every lid-open. Against a `static` inside the loop it was unreachable from any test —
    // deleting the store left the suite green and every wake filing a false ReportNew.
    #[test]
    fn a_rebaseline_actually_moves_the_heartbeat_baseline_forward() {
        let last_beat = AtomicU64::new(10_000);
        let wake = 8 * 3600 * 1000;
        apply_baseline(
            &last_beat,
            &Effect::Rebaseline { new_last_beat_ms: wake, discarded_gap_ms: 0, announce: false },
        );
        assert_eq!(
            last_beat.load(Ordering::Relaxed),
            wake,
            "without this the first tick after a wake sees a beat as old as the whole suspend"
        );
    }

    #[test]
    fn only_a_rebaseline_touches_the_baseline() {
        let last_beat = AtomicU64::new(10_000);
        for effect in [
            Effect::Quiet,
            Effect::ReportNew { stalled_ms: 5_000, hidden: false, starved_ms: 0 },
            Effect::Restate { stalled_ms: 5_000, hidden: false, wants_stack: false },
            Effect::Recovered { hung_for_ms: 5_000, hidden: false },
        ] {
            apply_baseline(&last_beat, &effect);
        }
        assert_eq!(last_beat.load(Ordering::Relaxed), 10_000, "only a suspend may move the baseline");
    }

    // The visible threshold, at the boundary — where an off-by-one actually shows up.
    #[test]
    fn a_punctual_tick_with_no_heartbeat_is_reported_at_the_threshold() {
        let beat_at = 1_000;
        // One ms short: still quiet.
        assert_eq!(
            step(&mut WatchdogState::default(), input(beat_at + HANG_MS - 1, beat_at, VISIBLE)),
            Effect::Quiet
        );
        // Exactly at it: reported.
        assert_eq!(
            step(&mut WatchdogState::default(), input(beat_at + HANG_MS, beat_at, VISIBLE)),
            Effect::ReportNew { stalled_ms: HANG_MS, hidden: false, starved_ms: 0 }
        );
    }

    #[test]
    fn silence_from_a_webview_that_never_beat_is_not_a_hang() {
        let mut state = WatchdogState::default();
        // Boot: no heartbeat has ever arrived, so `last_beat_ms` is 0 and the age would be enormous.
        assert_eq!(step(&mut state, input(u64::MAX, 0, VISIBLE)), Effect::Quiet);
    }

    // ── HIDDEN: A HIGHER BAR, QUIETER, AND NO STACK ────────────────────────────────────────────
    // Silence from a hidden WKWebView is DOCUMENTED behaviour (throttled or stopped timers), not a
    // symptom. So a hidden episode is a timestamp to correlate against, never a claim — and above
    // all it must not spend the finite dump budget, because a false capture evicts a real one.
    // ── PERSISTENCE EARNS THE STACK (the rate limiter's blind spot) ───────────────────────────
    // The limiter allows one hidden capture per 30 min. But `ReportNew` fires exactly ONCE per
    // episode, so a refusal at open used to be PERMANENT: if an ordinary cmd-tab spent the slot at
    // T, a real backgrounded wedge opening at T+5min was skipped and never retried, however long it
    // lasted — ending with an `info` line and no evidence. And the benign event wins by frequency:
    // backgrounding past 10 min is routine, a wedge is rare, so the common case routinely spends
    // the budget the rare case needs. That is the same cost as zeroing MAX_HIDDEN_HANG_DUMPS, which
    // this module already treats as a defect worth a two-pool design.
    //
    // The fix is to let the episode keep asking while it still owes a stack. Persisting is exactly
    // what a wedge does and a cmd-tab does not, so the retry spends the budget on the right event.

    #[test]
    fn an_episode_denied_its_stack_keeps_asking_on_every_restate() {
        let mut state = WatchdogState::default();
        // Episode opens. Suppose the loop could NOT capture (limiter just spent by a cmd-tab), so
        // `note_captured` is never called.
        assert!(matches!(
            step(&mut state, input(16_000, 10_000, VISIBLE)),
            Effect::ReportNew { .. }
        ));
        let mut asked = 0;
        for t in (17_000..=200_000).step_by(1_000) {
            if let Effect::Restate { wants_stack, .. } = step(&mut state, input(t, 10_000, VISIBLE)) {
                assert!(wants_stack, "an episode with no stack must keep asking");
                asked += 1;
            }
        }
        assert!(asked >= 3, "expected several retry opportunities, got {asked}");
    }

    // The converse — once a capture lands, restates must STOP asking, or a long wedge re-samples
    // itself every restate and floods the pool it was given.
    #[test]
    fn once_the_stack_is_taken_the_restates_stop_asking() {
        let mut state = WatchdogState::default();
        step(&mut state, input(16_000, 10_000, VISIBLE));
        note_captured(&mut state); // the loop got its stack

        for t in (17_000..=200_000).step_by(1_000) {
            if let Effect::Restate { wants_stack, .. } = step(&mut state, input(t, 10_000, VISIBLE)) {
                assert!(!wants_stack, "already captured — must not ask again");
            }
        }
    }

    // A NEW episode is owed its own stack, even right after one that got captured.
    #[test]
    fn a_fresh_episode_is_owed_its_own_stack() {
        let mut state = WatchdogState::default();
        step(&mut state, input(16_000, 10_000, VISIBLE));
        note_captured(&mut state);
        // Recover, then wedge again.
        assert!(matches!(step(&mut state, input(20_000, 20_000, VISIBLE)), Effect::Recovered { .. }));
        assert!(matches!(step(&mut state, input(40_000, 30_000, VISIBLE)), Effect::ReportNew { .. }));
        let mut saw = false;
        for t in (41_000..=120_000).step_by(1_000) {
            if let Effect::Restate { wants_stack, .. } = step(&mut state, input(t, 30_000, VISIBLE)) {
                assert!(wants_stack, "the second episode carried the first one's captured flag");
                saw = true;
            }
        }
        assert!(saw);
    }

    // The limiter must be CONSUMED only by a capture that actually happened. An earlier version of
    // this test asserted `may_capture_hidden` — an unchanged pure predicate — so it passed against
    // the pre-commit tree and would still pass with the `store` moved above the refusal check.
    // These drive `try_capture` itself and assert the SIDE EFFECT on the injected limiter state.
    #[test]
    fn a_refused_hidden_capture_leaves_the_interval_untouched() {
        let interval = HIDDEN_CAPTURE_MIN_INTERVAL.as_millis() as u64;
        let vis = AtomicU64::new(0);
        let last = AtomicU64::new(1_000);
        // No dump dir: the capture cannot happen, so nothing may be consumed.
        assert!(!try_capture_with(None, true, 1_000 + interval * 2, &vis, &last, &mut noop_capture()));
        assert_eq!(last.load(Ordering::Relaxed), 1_000, "a capture that did not happen consumed the slot");

        // Inside the window: refused, and the ORIGINAL spend must still govern — otherwise every
        // refused Restate retry would push the next allowed capture out another full interval and
        // the retry loop could never succeed.
        let dir = std::path::Path::new("/logs/hangs");
        assert!(!try_capture_with(
            Some(dir),
            true,
            1_000 + interval / 2,
            &vis,
            &last,
            &mut noop_capture()
        ));
        assert_eq!(last.load(Ordering::Relaxed), 1_000, "a REFUSED attempt consumed the interval");
    }

    // The two limiters are separate budgets: a visible capture must not spend the hidden slot (or
    // the 30-minute hidden floor would be consumed by every ordinary foreground stall), and vice
    // versa.
    #[test]
    fn the_visible_and_hidden_limiters_are_separate_budgets() {
        let dir = std::path::Path::new("/logs/hangs");
        let vis = AtomicU64::new(0);
        let hid = AtomicU64::new(0);

        assert!(try_capture_with(Some(dir), false, 50_000, &vis, &hid, &mut noop_capture()));
        assert_eq!(vis.load(Ordering::Relaxed), 50_000, "the visible capture spends the visible slot");
        assert_eq!(hid.load(Ordering::Relaxed), 0, "and must not touch the hidden one");

        // A hidden episode one second later is still allowed — its own budget is untouched.
        assert!(
            try_capture_with(Some(dir), true, 51_000, &vis, &hid, &mut noop_capture()),
            "the visible floor must not gate the hidden pool"
        );
        assert_eq!(hid.load(Ordering::Relaxed), 51_000);
        assert_eq!(vis.load(Ordering::Relaxed), 50_000, "and the hidden capture must not respend it");
    }

    // ── FIX 2: THE VISIBLE PATH IS RATE-LIMITED ────────────────────────────────────────────────
    // The visible path had NO limiter, and of the 17 dumps on disk twelve were six PAIRS 6-22s
    // apart: one stall detected twice, each detection firing a full multi-second `sample(1)` at an
    // app already in trouble and evicting an older real stack to make room.
    //
    // This asserts the SIDE EFFECT — how many captures actually ran — not that a capture happened.
    // With the limiter deleted the second call captures and the count is 3, so it goes red.
    #[test]
    fn one_stall_detected_twice_produces_one_visible_capture() {
        let dir = std::path::Path::new("/logs/hangs");
        let floor = VISIBLE_CAPTURE_MIN_INTERVAL.as_millis() as u64;
        let mut captures: Vec<u64> = Vec::new();
        {
            let mut capture = |_: &Path, stamp: u64, _: usize| captures.push(stamp);
            let vis = AtomicU64::new(0);
            let hid = AtomicU64::new(0);

            // The stall is detected. Capture.
            assert!(try_capture_with(Some(dir), false, 100_000, &vis, &hid, &mut capture));
            // The SAME stall is re-detected 12s later (the median observed pair gap). Refused.
            assert!(!try_capture_with(Some(dir), false, 112_000, &vis, &hid, &mut capture));
            // Even at the widest observed gap. Still refused — this is the case a shorter floor
            // would have let through, which is why the floor is set from the measurement.
            assert!(!try_capture_with(Some(dir), false, 122_000, &vis, &hid, &mut capture));
            // A distinct later episode is still owed its own stack.
            assert!(try_capture_with(Some(dir), false, 100_000 + floor, &vis, &hid, &mut capture));
        }
        assert_eq!(
            captures,
            vec![100_000, 100_000 + floor],
            "the two re-detections must collapse onto the first capture, and only they"
        );
    }

    /// A capture that does nothing, for tests asserting the limiter rather than the file.
    fn noop_capture() -> impl FnMut(&Path, u64, usize) {
        |_: &Path, _: u64, _: usize| {}
    }

    #[test]
    fn a_hidden_episode_is_reported_quietly() {
        assert!(!is_reportable_evidence(true), "info, not warn — silence while hidden is expected");
        assert!(is_reportable_evidence(false), "a visible episode still earns a warn");
    }

    // Hidden episodes DO capture a stack — just into their own pool. Giving them none was the
    // wrong end of the trade: the case the hidden path exists for is "already backgrounded, THEN
    // wedges", where the hidden beat landed before the wedge and the wedged thread can never
    // process a visible beat to reclassify — not even when the user clicks the dock icon and meets
    // the beachball. Zeroing the budget left that reproducing with a log line and no evidence.
    // Asserts the RESOLVED TARGET, not a relation between two constants. The previous version of
    // this test compared `hidden_keep > 0` and `visible_sub != hidden_sub` and nothing else, which
    // is the vacuous shape this repo's own docs condemn: dropping the path join, or passing
    // MAX_HANG_DUMPS to both pools, left it green while the hidden pool silently got a 20-file
    // budget in the visible directory.
    #[test]
    fn a_hidden_episode_writes_to_its_own_small_pool_and_a_visible_one_to_the_root() {
        let root = std::path::Path::new("/logs/hangs");
        assert_eq!(dump_target(root, false), (root.to_path_buf(), MAX_HANG_DUMPS));
        assert_eq!(dump_target(root, true), (root.join("hidden"), MAX_HIDDEN_HANG_DUMPS));
        // The property that makes the two-pool design work at all: separate directories, so pruning
        // one can never reach the other.
        assert_ne!(dump_target(root, true).0, dump_target(root, false).0);
        assert!(
            MAX_HIDDEN_HANG_DUMPS > 0,
            "a backgrounded wedge must still leave proof — zeroing this is what the design fixes"
        );
        assert!(
            MAX_HIDDEN_HANG_DUMPS < MAX_HANG_DUMPS,
            "the hidden pool is deliberately small; its false-positive rate is high by construction"
        );
    }

    // The pool bounds FILES KEPT, not captures — and the expensive part is the capture. `sample(1)`
    // attaches and walks every thread for five seconds, so keeping only the newest three still paid
    // that cost on every cmd-tab past the hidden threshold, on a healthy app, on battery.
    #[test]
    fn hidden_captures_are_rate_limited_not_merely_pruned() {
        let interval = HIDDEN_CAPTURE_MIN_INTERVAL.as_millis() as u64;
        assert!(may_capture(0, 1_000, interval), "the first one is always allowed");
        assert!(
            !may_capture(1_000, 1_000 + interval - 1, interval),
            "a second cmd-tab inside the interval must not spawn another five-second sample"
        );
        assert!(
            may_capture(1_000, 1_000 + interval, interval),
            "the boundary is inclusive, so the limiter cannot wedge shut"
        );
        // A backwards clock step must not permanently disable hidden captures.
        assert!(!may_capture(10_000, 5_000, interval), "saturating: reads as no time passed");
        assert!(may_capture(10_000, 10_000 + interval, interval), "and recovers after it");
    }

    // The floor is set by a measurement, not by taste: the widest observed duplicate-detection gap
    // was 22s, so anything shorter fails to collapse the pairs it exists for. And it must stay well
    // under the hidden floor, which is a bound on a benign event's cost rather than a de-duplicator.
    #[test]
    fn the_visible_floor_covers_the_widest_observed_duplicate_gap() {
        assert!(
            VISIBLE_CAPTURE_MIN_INTERVAL >= Duration::from_secs(22),
            "observed duplicate detections of ONE stall were 6, 7, 7, 11, 12 and 22 seconds apart"
        );
        assert!(
            VISIBLE_CAPTURE_MIN_INTERVAL < HIDDEN_CAPTURE_MIN_INTERVAL,
            "a visible episode is the evidence we most want; it must not inherit the hidden floor"
        );
    }

    // `prune_hang_dumps` gained a `keep` parameter and nothing asserted it was honoured — replacing
    // `keep` with MAX_HANG_DUMPS in the body silently handed the hidden pool a 20-file budget.
    #[cfg(target_os = "macos")]
    #[test]
    fn pruning_keeps_the_newest_and_leaves_the_other_pool_alone() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("sparkle-prune-test-{}", std::process::id()));
        let hidden = root.join("hidden");
        std::fs::create_dir_all(&hidden).unwrap();
        // Four dumps, oldest first. A short pause between them so the filesystem records distinct
        // mtimes — "newest" has to be unambiguous or this asserts nothing. No filetime crate: not
        // worth a dependency for one test.
        for name in ["hang-1.txt", "hang-2.txt", "hang-3.txt", "hang-4.txt"] {
            let mut f = std::fs::File::create(root.join(name)).unwrap();
            writeln!(f, "stack").unwrap();
            drop(f);
            std::thread::sleep(Duration::from_millis(20));
        }
        std::fs::File::create(hidden.join("hang-9.txt")).unwrap();
        // A non-dump file must survive too — this prunes its own artefacts, not the directory.
        std::fs::File::create(root.join("notes.txt")).unwrap();

        prune_hang_dumps(&root, 2);

        let mut left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["hang-3.txt", "hang-4.txt", "notes.txt"], "exactly the two newest");
        assert!(hidden.join("hang-9.txt").exists(), "the other pool must be untouched");
        let _ = std::fs::remove_dir_all(&root);
    }

    // RETENTION MUST COUNT THE RENDERER DUMPS. An episode used to write one file and now writes up
    // to `1 + MAX_OWN_WEBCONTENT`. Add files without teaching the pruner about them and the caps
    // silently stop binding — either the byte cap is blown (if the new names are unrecognised) or
    // `keep` quietly becomes `keep / files-per-episode` (if they are counted as separate episodes).
    // So this asserts both: whole episodes survive intact, and the total file count is bounded.
    #[cfg(target_os = "macos")]
    #[test]
    fn pruning_keeps_whole_episodes_including_their_renderer_dumps() {
        use std::io::Write;
        let root =
            std::env::temp_dir().join(format!("sparkle-prune-renderers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // Five episodes, each a host dump plus two renderer dumps: 15 files.
        for stamp in 1..=5u64 {
            for path in [
                host_dump_path(&root, stamp),
                renderer_dump_path(&root, stamp, 90_000 + stamp as u32),
                renderer_dump_path(&root, stamp, 91_000 + stamp as u32),
            ] {
                let mut f = std::fs::File::create(&path).unwrap();
                f.write_all(&[b'x'; 100]).unwrap();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 15, "precondition");

        prune_hang_dumps_to(&root, 2, u64::MAX);

        let mut left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec![
                "hang-4.txt",
                "hang-4.webcontent-90004.txt",
                "hang-4.webcontent-91004.txt",
                "hang-5.txt",
                "hang-5.webcontent-90005.txt",
                "hang-5.webcontent-91005.txt",
            ],
            "keep=2 must mean two whole EPISODES — not two files, and never a renderer stack whose \
             host stack was evicted out from under it"
        );

        // And the size budget evicts by episode too: 300 bytes admits exactly one episode.
        prune_hang_dumps_to(&root, 10, 300);
        let total: u64 = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter_map(|e| e.metadata().ok().map(|m| m.len()))
            .sum();
        assert_eq!(total, 300, "an episode's renderer dumps count toward the byte cap");
        assert!(root.join("hang-5.txt").exists(), "and the newest episode is the survivor");
        assert!(root.join("hang-5.webcontent-90005.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The IPC timeline must land even when `sample(1)` produces nothing at all.
    ///
    /// WHAT MUST BREAK FOR THIS TO GO RED: `dump_to_file` moving after `spawn_sample`, or out of
    /// `capture_stack_into` altogether. The assertion is taken IMMEDIATELY after
    /// `capture_stack_into` returns — before any sampler child could possibly have finished, and
    /// regardless of whether `/usr/bin/sample` exists or is refused on this machine — so the file
    /// being present at that instant is proof it did not wait on, or depend on, the sampler.
    ///
    /// That independence is the whole point of the ordering: the three real captures on
    /// 2026-08-13 all produced stacks that could not explain the hang, and an episode whose
    /// sampler is missing or denied used to leave no evidence whatsoever.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_ipc_timeline_lands_before_and_independently_of_the_sampler() {
        // Hold the ONE process-global ring test lock: `capture_stack_into` reads the shared ring
        // (`ipc_trace::dump_to_file` → `ipc_ring::snapshot`) and emits the `dump_to_file` tracing
        // callsite. Without this lock it runs concurrently with `ipc_ring`/`ipc_trace`'s tests —
        // libtest parallelises the one binary — and its emit of that callsite races
        // `the_dump_emits_exactly_one_tracing_event`'s `with_default` counter into a spurious 0.
        let _g = crate::ipc_ring::test_ring_guard();

        let root = std::env::temp_dir().join(format!("-hook-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        crate::ipc_ring::set_enabled(true);
        capture_stack_into(&root, 555_000, 20);

        let ipc = root.join("hang-555000.ipc.json");
        assert!(
            ipc.exists(),
            "the IPC timeline must be on disk the moment capture_stack_into returns, whatever \
             the sampler is doing"
        );
        let body = std::fs::read_to_string(&ipc).expect("readable");
        assert!(
            serde_json::from_str::<serde_json::Value>(&body).is_ok(),
            "and it must be parseable JSON, not a truncated write"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// …and it ages and is evicted WITH its episode, rather than accumulating forever.
    ///
    /// WHAT MUST BREAK FOR THIS TO GO RED: renaming the file to anything `dump_stamp` cannot parse
    /// (`ipc-<stamp>.json`, say). That is not a cosmetic failure — an unrecognised name is invisible
    /// to the pruner, so it would never be counted toward the budgets and never deleted, which is
    /// exactly how "add files without teaching the pruner about them" makes the caps stop binding.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_ipc_timeline_is_pruned_together_with_its_episodes_stacks() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // Three episodes, each a host stack plus an IPC timeline.
        for stamp in 1..=3u64 {
            for path in [host_dump_path(&root, stamp), crate::ipc_trace::dump_path(&root, stamp)] {
                let mut f = std::fs::File::create(&path).unwrap();
                f.write_all(&[b'x'; 100]).unwrap();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 6, "precondition");

        // The pairing must be legible to the pruner BEFORE it prunes: same stamp, both files.
        assert_eq!(dump_stamp("hang-2.ipc.json"), Some("2"));
        assert_eq!(dump_stamp("hang-2.txt"), dump_stamp("hang-2.ipc.json"));

        prune_hang_dumps_to(&root, 1, u64::MAX);

        let mut left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec!["hang-3.ipc.json", "hang-3.txt"],
            "keep=1 must leave ONE whole episode — both of its files — and evict the rest; an \
             IPC timeline the pruner cannot see would still be here"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // The COUNT budget alone let a pool of unusually large stacks hold tens of MB, because a dump is
    // 0.5-3.5 MB and 20 of them is 10-70 MB. This asserts the surviving BYTES, which is the thing the
    // count cannot bound: with keep=10 the count budget evicts nothing here, so anything that
    // survives does so only because the size budget did the work.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_size_budget_evicts_when_the_count_budget_would_not() {
        use std::io::Write;
        let root =
            std::env::temp_dir().join(format!("sparkle-prune-bytes-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        // Four 100-byte dumps, oldest first, distinct mtimes.
        for name in ["hang-1.txt", "hang-2.txt", "hang-3.txt", "hang-4.txt"] {
            let mut f = std::fs::File::create(root.join(name)).unwrap();
            f.write_all(&[b'x'; 100]).unwrap();
            drop(f);
            std::thread::sleep(Duration::from_millis(20));
        }

        // keep=10 is deliberately ABOVE the file count, so the count budget is satisfied and
        // inert. A 250-byte ceiling admits only the two newest.
        prune_hang_dumps_to(&root, 10, 250);

        let mut left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["hang-3.txt", "hang-4.txt"], "size budget kept the newest 200 bytes");

        let total: u64 = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter_map(|e| e.metadata().ok().map(|m| m.len()))
            .sum();
        assert!(total <= 250, "surviving bytes must be within budget, got {total}");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── FIX 1: IDENTIFYING THIS APP'S WEBCONTENT PROCESSES ─────────────────────────────────────
    // The capture sampled only the host process while the trigger was a WEBVIEW heartbeat, so the
    // process most likely to be frozen was never in the dump — 17 dumps on disk, none containing
    // the frozen thread. Nothing in `ps` distinguishes our renderer from another app's (identical
    // argv, `ppid=1`), so identification is a before/after set difference, and the interesting
    // behaviour is the REFUSAL.

    /// Real `ps -axo pid=,comm=` output shape, captured on macOS 26.6 (2026-08-09).
    const PS_FIXTURE: &str = concat!(
        "    1 /sbin/launchd\n",
        " 1140 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent\n",
        " 1161 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent\n",
        " 1204 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking\n",
        " 1205 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU\n",
        "93243 /Applications/Sparkle.app/Contents/MacOS/Sparkle\n",
    );

    #[test]
    fn the_ps_parser_takes_webcontent_and_nothing_that_merely_looks_like_it() {
        let pids = parse_webcontent_pids(PS_FIXTURE);
        assert_eq!(
            pids,
            BTreeSet::from([1140, 1161]),
            "Networking and GPU are WebKit XPC services too and must NOT be sampled as renderers"
        );
        assert!(parse_webcontent_pids("").is_empty());
        assert!(
            parse_webcontent_pids("not a ps line at all\n").is_empty(),
            "garbage must read as 'no renderer identified', never as a pid"
        );
    }

    #[test]
    fn the_diff_returns_exactly_the_processes_that_appeared() {
        let before = BTreeSet::from([1140, 1161]);
        let after = BTreeSet::from([1140, 1161, 93246, 93249]);
        assert_eq!(
            new_webcontent_pids(&before, &after, MAX_OWN_WEBCONTENT),
            BTreeSet::from([93246, 93249]),
            "the studied dump's host 93243 had renderers 93246 and 93249"
        );
    }

    #[test]
    fn a_diff_that_found_nothing_new_yields_nothing() {
        let set = BTreeSet::from([1140, 1161]);
        assert!(new_webcontent_pids(&set, &set, MAX_OWN_WEBCONTENT).is_empty());
        // A renderer that EXITED during the window is not a renderer that appeared.
        assert!(new_webcontent_pids(&set, &BTreeSet::from([1140]), MAX_OWN_WEBCONTENT).is_empty());
    }

    // The privacy case, and the one that must fail closed. The diff window spans app startup, so
    // another app launching a browser in the same second contributes its renderer — and sampling a
    // stranger's WebContent writes another application's page contents into this user's log
    // directory. When the count cannot be attributed we take NOTHING, which degrades to exactly the
    // old host-only behaviour.
    #[test]
    fn an_ambiguous_diff_captures_nothing_rather_than_a_strangers_renderer() {
        let before = BTreeSet::from([1140]);
        let after = BTreeSet::from([1140, 2, 3, 4, 5]); // four new — more than we created
        assert!(
            new_webcontent_pids(&before, &after, MAX_OWN_WEBCONTENT).is_empty(),
            "more new renderers than webviews we created is unattributable, so claim none"
        );
        // The boundary: exactly as many as we could have created IS attributable.
        let exact = BTreeSet::from([1140, 2, 3, 4]);
        assert_eq!(
            new_webcontent_pids(&before, &exact, MAX_OWN_WEBCONTENT).len(),
            MAX_OWN_WEBCONTENT,
            "refusing at the boundary would make the feature unreachable on a 3-webview startup"
        );
    }

    // WebKit respawns a crashed WebContent process, so a recorded pid goes stale — and the pid can
    // be RECYCLED by something else entirely. A liveness-only check would hand that stranger to
    // `sample`, which is why re-verification intersects with a live WebContent listing instead.
    #[test]
    fn a_dead_or_recycled_renderer_pid_is_dropped_before_it_can_be_sampled() {
        let recorded = BTreeSet::from([93246, 93249]);
        // 93249 exited; 93246 is still a live WebContent.
        assert_eq!(live_renderer_pids(&recorded, &BTreeSet::from([93246, 1140])), vec![93246]);
        // 93249's pid was recycled by something that is NOT a WebContent process: it is absent from
        // the live WebContent listing, so it is dropped even though the pid is alive.
        assert_eq!(live_renderer_pids(&recorded, &BTreeSet::from([93246])), vec![93246]);
        assert!(
            live_renderer_pids(&recorded, &BTreeSet::new()).is_empty(),
            "all gone means host-only, never 'sample whatever holds those pids now'"
        );
    }

    // The pairing convention. The host dump keeps its existing name so everything that reads
    // `hang-<stamp>.txt` is unaffected, and the renderer dump is a sibling sharing the stamp — which
    // is also what lets the pruner treat one episode as one unit (`dump_stamp`).
    #[test]
    fn a_renderer_dump_is_a_distinct_sibling_that_pairs_with_the_host_dump_by_stamp() {
        let dir = std::path::Path::new("/logs/hangs");
        let host = host_dump_path(dir, 1786308408172);
        let a = renderer_dump_path(dir, 1786308408172, 93246);
        let b = renderer_dump_path(dir, 1786308408172, 93249);

        let name_of = |p: &Path| p.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name_of(&host), "hang-1786308408172.txt", "unchanged in shape");
        assert_eq!(name_of(&a), "hang-1786308408172.webcontent-93246.txt");
        assert_ne!(a, b, "two renderers of one episode must not overwrite each other");
        assert_ne!(a, host);

        // All three resolve to the SAME episode for retention purposes...
        let stamp_of = |p: &Path| -> Option<String> {
            let name = name_of(p);
            dump_stamp(&name).map(str::to_string)
        };
        assert_eq!(stamp_of(&host), Some("1786308408172".to_string()));
        assert_eq!(stamp_of(&a), stamp_of(&host));
        assert_eq!(stamp_of(&b), stamp_of(&host));
        // ...and a different episode does not.
        assert_ne!(stamp_of(&host_dump_path(dir, 1786308408173)), stamp_of(&host));
        // Files that are not ours stay invisible to the pruner.
        assert_eq!(dump_stamp("notes.txt"), None);
        assert_eq!(dump_stamp("sparkle.log"), None);
    }

    // The bar the High finding was about. At 60s every ordinary cmd-tab past a minute filed a hang
    // and burned a multi-MB capture on a healthy app. Ten minutes is past every innocent
    // explanation: throttled beats trickling in at even one a minute never open an episode at all.
    #[test]
    fn an_ordinary_backgrounding_is_not_an_episode() {
        let beat_at = 1_000;
        // Two minutes hidden — a routine cmd-tab, and far past the old 60s bar.
        assert_eq!(step(&mut WatchdogState::default(), input(beat_at + 120_000, beat_at, true)), Effect::Quiet);
        // Five minutes. Still routine.
        assert_eq!(step(&mut WatchdogState::default(), input(beat_at + 300_000, beat_at, true)), Effect::Quiet);
        // A throttled beat arriving even once a minute never accumulates an episode at all.
        let mut state = WatchdogState::default();
        for minute in 1..=30u64 {
            let t = minute * 60_000;
            assert_eq!(
                step(&mut state, input(t, t - 59_000, true)),
                Effect::Quiet,
                "a beat every 60s while hidden must never open an episode"
            );
        }
    }

    #[test]
    fn a_backgrounded_window_still_records_a_very_long_silence() {
        let hidden_ms = HIDDEN_HANG_AFTER.as_millis() as u64;
        let mut state = WatchdogState::default();
        assert_eq!(step(&mut state, input(hidden_ms - 1, 1, true)), Effect::Quiet);
        assert_eq!(
            step(&mut state, input(hidden_ms + 1, 1, true)),
            Effect::ReportNew { stalled_ms: hidden_ms, hidden: true, starved_ms: 0 }
        );
    }

    // The hidden bar must be genuinely higher, or occlusion floods the log with phantom hangs.
    #[test]
    fn hidden_tolerates_what_visible_would_report() {
        let beat_at = 1_000;
        let now = beat_at + HANG_MS + 1_000; // comfortably past the visible bar
        assert_eq!(
            step(&mut WatchdogState::default(), input(now, beat_at, VISIBLE)),
            Effect::ReportNew { stalled_ms: HANG_MS + 1_000, hidden: false, starved_ms: 0 }
        );
        assert_eq!(step(&mut WatchdogState::default(), input(now, beat_at, true)), Effect::Quiet);
    }

    // ── THE HIDDEN DISCOUNT IS STICKY ──────────────────────────────────────────────────────────
    // `Recovered` is the line this whole rewrite made authoritative, and it was the ONE effect that
    // did not carry `hidden`. A window backgrounded for eight hours with paused timers recovered as
    // `hung_for_ms=28800000` — byte-for-byte how a genuine eight-hour wedge reads. Fixing the number
    // being too small had introduced a path where it is spuriously enormous, with the discount
    // stripped on exactly the line that matters most.
    #[test]
    fn recovery_carries_the_hidden_discount_so_a_long_cmd_tab_is_not_a_long_wedge() {
        let hidden_ms = HIDDEN_HANG_AFTER.as_millis() as u64;
        let mut state = WatchdogState::default();
        assert!(matches!(
            step(&mut state, input(hidden_ms + 1, 1, true)),
            Effect::ReportNew { hidden: true, .. }
        ));
        let wake = 8 * 3600 * 1000;
        assert_eq!(
            step(&mut state, input(wake, wake - 100, true)),
            Effect::Recovered { hung_for_ms: wake - 1, hidden: true },
            "an 8h backgrounding must not read as an 8h wedge"
        );
    }

    // Sticky, not sampled at the end: an episode that BEGAN hidden is a weaker claim even if the
    // window is visible again by the time we notice recovery. Sampling `input.hidden` at the
    // recovery tick would report `hidden: false` for precisely the cmd-tab-then-come-back case,
    // which is the common one.
    #[test]
    fn the_discount_survives_the_window_becoming_visible_again() {
        let hidden_ms = HIDDEN_HANG_AFTER.as_millis() as u64;
        let mut state = WatchdogState::default();
        step(&mut state, input(hidden_ms + 1, 1, true));
        // The user comes back: the window is visible on the tick that sees the beats resume.
        let effect = step(&mut state, input(hidden_ms + 5_000, hidden_ms + 4_900, VISIBLE));
        assert_eq!(
            effect,
            Effect::Recovered { hung_for_ms: hidden_ms + 4_999, hidden: true },
            "the episode began hidden, so its recovery keeps the discount"
        );
    }

    #[test]
    fn a_restate_carries_the_discount_too() {
        let hidden_ms = HIDDEN_HANG_AFTER.as_millis() as u64;
        let mut state = WatchdogState::default();
        step(&mut state, input(hidden_ms + 1, 1, true));
        let mut saw_restate = false;
        for t in (hidden_ms + 2_000..hidden_ms + 60_000).step_by(1_000) {
            if let Effect::Restate { hidden, .. } = step(&mut state, input(t, 1, true)) {
                assert!(hidden, "a hidden episode's restates must stay discounted");
                saw_restate = true;
            }
        }
        assert!(saw_restate, "the loop must actually produce a restate for this to prove anything");
    }

    // The converse, so the discount cannot be applied everywhere and pass vacuously.
    #[test]
    fn a_visible_episode_is_never_discounted() {
        let mut state = WatchdogState::default();
        step(&mut state, input(16_000, 10_000, VISIBLE));
        assert_eq!(
            step(&mut state, input(100_500, 100_400, VISIBLE)),
            Effect::Recovered { hung_for_ms: 90_500, hidden: false }
        );
    }

    // THE DIRECTION THAT WAS UNPINNED, and the reason the recovery tick's own `hidden` must not be
    // ORed in. The most likely way a user reacts to a beachball is to cmd-tab away — macOS lets
    // them — and their `visibilitychange` beat is queued behind the wedge, so it lands as the FIRST
    // beat after it. Sampling `input.hidden` there closes a genuine 90-second visible wedge, whose
    // own ReportNew was a warn with a captured stack, at info with "likely backgrounding, not a
    // hang". The episode's own log would contradict itself, and anyone triaging by warn would never
    // see the duration — which is the one number no other instrument in the app can produce.
    #[test]
    fn a_visible_wedge_the_user_cmd_tabbed_away_from_is_still_a_wedge() {
        let mut state = WatchdogState::default();
        assert_eq!(
            step(&mut state, input(16_000, 10_000, VISIBLE)),
            Effect::ReportNew { stalled_ms: 6_000, hidden: false, starved_ms: 0 },
            "the episode opens visible, warn-level, with a stack"
        );
        for t in (17_000..=100_000).step_by(1_000) {
            step(&mut state, input(t, 10_000, VISIBLE));
        }
        // The queued `hidden: true` beat lands as the first beat after the block clears.
        assert_eq!(
            step(&mut state, input(100_500, 100_400, true)),
            Effect::Recovered { hung_for_ms: 90_500, hidden: false },
            "a visible episode must not be relabelled by where the window ended up"
        );
    }

    // ── RESTATE BACKOFF ────────────────────────────────────────────────────────────────────────
    // A dead WebContent process produces permanent silence with a healthy main thread. Without
    // backoff the watchdog restates every 10s for the life of the app — an unbounded stream of
    // confident false diagnoses in the log someone will later read to diagnose a real hang.
    #[test]
    fn restates_back_off_instead_of_repeating_forever() {
        let (_, effects) = run(0, 600_000, 1);
        let restates = effects.iter().filter(|e| matches!(e, Effect::Restate { .. })).count();
        // Linear 10s restates over 10 minutes would be ~60. Exponential backoff is ~6.
        assert!(restates <= 10, "expected backoff, got {restates} restates in 10 minutes");
        assert!(restates >= 3, "must still leave a progress trail, got {restates}");
    }

    #[test]
    fn the_backoff_doubles_and_then_holds_at_the_ceiling() {
        assert_eq!(restate_delay_ms(0), 10_000);
        assert_eq!(restate_delay_ms(1), 20_000);
        assert_eq!(restate_delay_ms(2), 40_000);
        assert_eq!(restate_delay_ms(99), RESTATE_MAX.as_millis() as u64, "and never overflows");
    }

    // Exactly one ReportNew per episode, however long it runs — the stack capture hangs off it.
    #[test]
    fn an_episode_reports_once_and_captures_one_stack() {
        let (_, effects) = run(0, 600_000, 1);
        let opens = effects.iter().filter(|e| matches!(e, Effect::ReportNew { .. })).count();
        assert_eq!(opens, 1);
    }

    // A healthy tick with no episode open is not a recovery, or every ordinary second logs one.
    #[test]
    fn recovery_is_reported_only_when_an_episode_was_open() {
        let mut state = WatchdogState::default();
        assert_eq!(step(&mut state, input(1_000, 1_000, VISIBLE)), Effect::Quiet);
    }

    // After recovery the machine must be fully rearmed, or a second hang in one session is missed.
    #[test]
    fn a_second_hang_after_a_recovery_is_still_reported() {
        let mut state = WatchdogState::default();
        step(&mut state, input(16_000, 10_000, VISIBLE));
        assert!(matches!(
            step(&mut state, input(20_000, 20_000, VISIBLE)),
            Effect::Recovered { .. }
        ));
        assert_eq!(state, WatchdogState::default(), "recovery must fully reset the episode");
        assert!(matches!(
            step(&mut state, input(40_000, 30_000, VISIBLE)),
            Effect::ReportNew { .. }
        ));
    }

    // ── THE FOURTH HANG FAMILY: THE SUB-THRESHOLD SAWTOOTH ─────────────────────────────────────
    // Everything above measures ONE quantity — how long the heartbeat has been silent — at a
    // five-second bar, and returns a binary verdict. A real 30-second unusable window went entirely
    // unreported by that instrument, correctly: the UI stalled seven to thirteen times a minute and
    // never once for five seconds. See `STALL_BUDGET_MS` for the log lines and the arithmetic.
    //
    // These tests are written against the numbers in that log, not against invented ones, because
    // the trigger's whole difficulty is that the firing case and the must-not-fire case are the SAME
    // MILLISECONDS arranged differently.

    /// A tick with beats CURRENT that carries `stall_ms` of renderer stall time.
    ///
    /// Every gate upstream of the budget rule is deliberately satisfied here: the tick was punctual
    /// (so the suspend branch does not short-circuit), a beat has arrived (so the `last_beat_ms == 0`
    /// branch does not), and it is recent (so the silence branch does not open an episode). AGENTS.md
    /// names "an earlier guard short-circuits the path" as the #1 way a test like this goes vacuous;
    /// each of those three is also asserted directly, with its pair, further down.
    fn healthy_tick(now_ms: u64, stall_ms: u64, hidden: bool) -> TickInput {
        TickInput {
            now_ms,
            overshoot_ms: PUNCTUAL,
            last_beat_ms: now_ms - 500,
            hidden,
            stall_ms,
            machine_slept_ms: AWAKE,
        }
    }

    /// Five consecutive seconds at 780ms of stall — 3900ms in the window, ONE TICK SHORT of the bar.
    /// The verdict of the next tick is then decided by the budget rule and nothing else, which is
    /// what lets the guard tests below pair "does not fire" against "the identical setup does".
    fn primed(now_ms: u64) -> WatchdogState {
        let mut state = WatchdogState::default();
        for i in 0..5u64 {
            let t = now_ms - (5 - i) * 1_000;
            assert_eq!(
                step(&mut state, healthy_tick(t, 780, VISIBLE)),
                Effect::Quiet,
                "priming must stay under the bar, or these tests assert nothing"
            );
        }
        state
    }

    /// The window, in ms — 10 ticks of `TICK`.
    const WINDOW_MS: u64 = STALL_WINDOW_TICKS as u64 * 1_000;
    const OCCLUDED: bool = true;

    // ── THE CASE THAT MUST FIRE ────────────────────────────────────────────────────────────────
    // The reported window's worst minute was 13 stalls totalling 4681ms, max 956ms. Arriving
    // back-to-back that is six seconds in which the UI is stalled for 78% of each — an unusable app,
    // and invisible to every instrument this module had.
    #[test]
    fn a_cluster_of_sub_threshold_stalls_is_a_hang_even_though_nothing_ever_went_silent() {
        let mut state = WatchdogState::default();
        let mut fired: Option<(u64, Effect)> = None;
        let mut opened_a_silence_episode = false;
        for i in 0..6u64 {
            let t = 100_000 + i * 1_000;
            let effect = step(&mut state, healthy_tick(t, 780, VISIBLE));
            if matches!(effect, Effect::ReportNew { .. } | Effect::Restate { .. }) {
                opened_a_silence_episode = true;
            }
            if matches!(effect, Effect::StallBudget { .. }) {
                fired = Some((t, effect));
            }
        }
        assert_eq!(
            fired,
            Some((105_000, Effect::StallBudget { stalled_ms: 4_680, window_ms: WINDOW_MS })),
            "6 x 780ms inside ten seconds is 47% of the window — the reported window's own 4681ms, clustered"
        );
        // The claim that makes this a SECOND trigger rather than a louder first one: the silence
        // detector cannot have seen any of this. Every beat was current on every tick.
        assert!(
            !opened_a_silence_episode,
            "if the silence path fired here the fixture is wrong and this proves nothing new"
        );
    }

    // ── THE REGRESSION THAT MATTERS ────────────────────────────────────────────────────────────
    // The same milliseconds, spread across the minute they were actually logged over. This app runs
    // ~10.3k stalls a day at a median of 221ms (perfTrace.ts's own measurement) — a stall every eight
    // seconds around the clock — so a minute at 4-8% is what it does when NOTHING IS WRONG. A bar low
    // enough to catch a bad minute by its per-minute rate fires forever, and a trigger that fires
    // forever evicts, out of `MAX_HANG_DUMPS`, the very stacks it exists to keep.
    #[test]
    fn the_measured_ordinary_jank_rate_must_never_fire_it() {
        for total in [2_646u64, 2_813, 4_681] {
            let mut state = WatchdogState::default();
            let per_tick = total / 60; // 44, 46, 78 ms of stall per second
            for i in 0..60u64 {
                let t = 100_000 + i * 1_000;
                assert_eq!(
                    step(&mut state, healthy_tick(t, per_tick, VISIBLE)),
                    Effect::Quiet,
                    "{total}ms spread over its own minute puts {}ms in a ten-second window; \
                     firing on that fires on every minute this app has",
                    per_tick * STALL_WINDOW_TICKS as u64
                );
            }
        }
    }

    // ── GUARD 1: THE SUSPEND CHECK, AND ITS PAIR ───────────────────────────────────────────────
    // A machine suspend freezes this thread too, so nothing observed during it means anything. One
    // test proving absence is ambiguous — it passes for a rule that never fires at all — so the pair
    // runs the IDENTICAL state and the IDENTICAL stall through a punctual tick and demands the
    // effect.
    #[test]
    fn a_suspended_tick_cannot_fire_the_budget_but_the_identical_punctual_one_does() {
        let now = 100_000;
        let mut suspended = primed(now);
        assert_eq!(
            step(
                &mut suspended,
                TickInput {
                    now_ms: now,
                    overshoot_ms: SUSPEND_OVERSHOOT.as_millis() as u64,
                    last_beat_ms: now - 500,
                    hidden: false,
                    stall_ms: 780,
                    machine_slept_ms: Some(SUSPEND_OVERSHOOT.as_millis() as u64),
                }
            ),
            Effect::Rebaseline { new_last_beat_ms: now, discarded_gap_ms: 500, announce: true },
            "we were not running either; the ring describes a world we did not observe"
        );

        let mut running = primed(now);
        assert_eq!(
            step(&mut running, healthy_tick(now, 780, VISIBLE)),
            Effect::StallBudget { stalled_ms: 4_680, window_ms: WINDOW_MS },
            "the same state and the same stall, punctual, MUST reach the effect"
        );
    }

    // ── AND THE THIRD LEG, WHICH IS WHY THIS FIX MATTERS TO THE BUDGET AT ALL ──────────────────
    // The budget trigger sits DOWNSTREAM of the suspend short-circuit, so for as long as that
    // short-circuit fired on any long overshoot it swallowed this trigger too — on exactly the
    // machines whose load is what produces the sawtooth in the first place. Same primed ring, same
    // 780ms, same overshoot as the suppressed leg above; the machine was awake, so the tick is
    // evaluated and the budget is reachable.
    #[test]
    fn a_starved_tick_still_reaches_the_stall_budget_that_a_suspend_would_have_swallowed() {
        let now = 100_000;
        let mut starved = primed(now);
        assert_eq!(
            step(
                &mut starved,
                TickInput {
                    now_ms: now,
                    overshoot_ms: SUSPEND_OVERSHOOT.as_millis() as u64,
                    last_beat_ms: now - 500,
                    hidden: false,
                    stall_ms: 780,
                    machine_slept_ms: AWAKE,
                }
            ),
            Effect::StallBudget { stalled_ms: 4_680, window_ms: WINDOW_MS },
            "under load the overshoot and the sawtooth arrive together; suppressing on the \
             overshoot alone hid the sawtooth as well"
        );
    }

    // ── GUARD 2: A WEBVIEW THAT HAS NEVER SPOKEN, AND ITS PAIR ─────────────────────────────────
    #[test]
    fn a_never_beaten_webview_cannot_fire_the_budget_but_the_identical_beaten_one_does() {
        let now = 100_000;
        let mut never = primed(now);
        assert_eq!(
            step(&mut never, TickInput { now_ms: now, overshoot_ms: PUNCTUAL, last_beat_ms: 0, hidden: false, stall_ms: 780, machine_slept_ms: AWAKE }),
            Effect::Quiet,
            "stall accounting from something that has never beaten is not evidence of anything"
        );

        let mut beaten = primed(now);
        assert_eq!(
            step(&mut beaten, healthy_tick(now, 780, VISIBLE)),
            Effect::StallBudget { stalled_ms: 4_680, window_ms: WINDOW_MS }
        );
    }

    // ── GUARD 3: HIDDEN, AND ITS PAIR ──────────────────────────────────────────────────────────
    // rAF is paused behind a hidden window, so the renderer accrues no stall time there; a budget
    // evaluated while hidden could only ever act on accounting from before the occlusion. That is
    // `HIDDEN_HANG_AFTER`'s territory.
    #[test]
    fn a_hidden_window_cannot_fire_the_budget_but_the_identical_visible_one_does() {
        let now = 100_000;
        let mut hidden = primed(now);
        assert_eq!(step(&mut hidden, healthy_tick(now, 780, OCCLUDED)), Effect::Quiet);

        let mut visible = primed(now);
        assert_eq!(
            step(&mut visible, healthy_tick(now, 780, VISIBLE)),
            Effect::StallBudget { stalled_ms: 4_680, window_ms: WINDOW_MS }
        );
    }

    // ── GUARD 4: AN OPEN SILENCE EPISODE OWNS THE TICK ─────────────────────────────────────────
    // The two triggers must never contest the same moment: a wedge long enough to be silent is the
    // first trigger's, and it already reports, restates and captures for it.
    #[test]
    fn a_silent_tick_reports_silence_not_a_stall_budget_even_with_the_ring_full() {
        let now = 100_000;
        let mut state = primed(now);
        // Same tick, except the last beat is HANG_AFTER old.
        let effect = step(
            &mut state,
            TickInput { now_ms: now, overshoot_ms: PUNCTUAL, last_beat_ms: now - HANG_MS, hidden: false, stall_ms: 780, machine_slept_ms: AWAKE },
        );
        assert_eq!(effect, Effect::ReportNew { stalled_ms: HANG_MS, hidden: false, starved_ms: 0 });

        let mut current = primed(now);
        assert_eq!(
            step(&mut current, healthy_tick(now, 780, VISIBLE)),
            Effect::StallBudget { stalled_ms: 4_680, window_ms: WINDOW_MS },
            "with beats current the identical ring MUST reach the budget effect"
        );
    }

    // The beat that ENDS a silence episode carries the whole block's stall time in one bucket, so a
    // ring that survived the recovery would have the sawtooth trigger re-report, seconds later, the
    // wedge the silence trigger just reported in full — a second WARN and a second `sample(1)` for
    // one event. The recovery's state reset is what prevents it; deleting it leaves this red.
    #[test]
    fn a_recovered_wedge_is_not_re_reported_by_the_stall_budget() {
        let mut state = WatchdogState::default();
        // A 20-second wedge: silence opens an episode.
        assert!(matches!(step(&mut state, input(120_000, 100_000, VISIBLE)), Effect::ReportNew { .. }));
        // The first beat back carries all 20 seconds of stall the renderer accrued.
        assert!(matches!(
            step(&mut state, TickInput { now_ms: 121_000, overshoot_ms: PUNCTUAL, last_beat_ms: 120_900, hidden: false, stall_ms: 20_000, machine_slept_ms: AWAKE }),
            Effect::Recovered { .. }
        ));
        // Now a perfectly ordinary second. Nothing may fire off the wedge's own stall time.
        assert_eq!(
            step(&mut state, healthy_tick(122_000, 44, VISIBLE)),
            Effect::Quiet,
            "the silence path owns a wedge's stall time; the ring must restart at the recovery"
        );
    }

    // ── IT IS A ROLLING WINDOW, NOT A RUNNING TOTAL ────────────────────────────────────────────
    // The distinction is the entire trigger: a running total fires on any app left open long enough,
    // which is every app. Paired, because "it did not fire" is also what a broken accumulator does.
    #[test]
    fn stall_time_older_than_the_window_stops_counting() {
        // Two very bad seconds, then a quiet stretch one window long, then one more bad second.
        let mut rolled = WatchdogState::default();
        step(&mut rolled, healthy_tick(100_000, 2_000, VISIBLE));
        step(&mut rolled, healthy_tick(101_000, 1_900, VISIBLE)); // 3900 — one tick short
        for i in 0..STALL_WINDOW_TICKS as u64 {
            assert_eq!(step(&mut rolled, healthy_tick(102_000 + i * 1_000, 0, VISIBLE)), Effect::Quiet);
        }
        assert_eq!(
            step(&mut rolled, healthy_tick(112_000, 780, VISIBLE)),
            Effect::Quiet,
            "3900ms from more than ten seconds ago must have left the window"
        );

        // THE PAIR: the identical 780ms arriving while those two seconds are still inside it.
        let mut fresh = WatchdogState::default();
        step(&mut fresh, healthy_tick(100_000, 2_000, VISIBLE));
        step(&mut fresh, healthy_tick(101_000, 1_900, VISIBLE));
        assert_eq!(
            step(&mut fresh, healthy_tick(102_000, 780, VISIBLE)),
            Effect::StallBudget { stalled_ms: 4_680, window_ms: WINDOW_MS },
            "in-window, the same three ticks are 4680ms and over the bar"
        );
    }

    // The bar itself, at the boundary — where an off-by-one is the difference between a trigger and
    // a nuisance.
    #[test]
    fn the_budget_is_inclusive_at_the_bar_and_silent_one_millisecond_under() {
        let mut over = WatchdogState::default();
        for i in 0..3u64 {
            assert_eq!(step(&mut over, healthy_tick(100_000 + i * 1_000, 1_000, VISIBLE)), Effect::Quiet);
        }
        assert_eq!(
            step(&mut over, healthy_tick(103_000, 1_000, VISIBLE)),
            Effect::StallBudget { stalled_ms: STALL_BUDGET_MS, window_ms: WINDOW_MS },
            "exactly at the bar must report, or the boundary can never be reached"
        );

        let mut under = WatchdogState::default();
        for i in 0..3u64 {
            step(&mut under, healthy_tick(100_000 + i * 1_000, 1_000, VISIBLE));
        }
        assert_eq!(
            step(&mut under, healthy_tick(103_000, 999, VISIBLE)),
            Effect::Quiet,
            "one millisecond under the bar is not a hang"
        );
    }

    // ── A SUSTAINED BAD PATCH REPORTS ONCE A MINUTE, NOT ONCE A SECOND ─────────────────────────
    // Without the interval the ring stays over the bar for as long as the patch lasts and every tick
    // reports — a WARN a second, each asking for a `sample(1)` against an app already in trouble.
    // Sixty seconds is `JANK_ROLLUP_MS`, so this line pairs one-to-one with the renderer's own
    // rollup line, and it is 6x the window, so no two reports can count the same stall time twice.
    #[test]
    fn a_sustained_bad_patch_reports_on_an_interval_not_on_every_tick() {
        let mut state = WatchdogState::default();
        let mut fired_at: Vec<u64> = Vec::new();
        for i in 0..120u64 {
            let t = 100_000 + i * 1_000;
            if matches!(step(&mut state, healthy_tick(t, 780, VISIBLE)), Effect::StallBudget { .. }) {
                fired_at.push(t);
            }
        }
        assert_eq!(
            fired_at,
            vec![105_000, 165_000],
            "two minutes of a bad patch is two lines; without the interval it is ~115"
        );
        assert_eq!(
            fired_at[1] - fired_at[0],
            STALL_REPORT_MIN_INTERVAL.as_millis() as u64,
            "and the spacing is the interval, not an accident of the ring"
        );
    }

    // ── THE NEW TRIGGER REUSES THE EXISTING CAPTURE MACHINERY ──────────────────────────────────
    // The brief's live risk: a second trigger with its own path can fire alongside a silence episode
    // and evict, out of a finite `MAX_HANG_DUMPS`, the stack it was meant to complement. This asserts
    // the SIDE EFFECT — how many `sample(1)` runs actually happen — through the same `try_capture_with`
    // and the same `VISIBLE_CAPTURE_MIN_INTERVAL` the silence path uses. Route the stall budget to the
    // hidden pool instead and the hidden floor allows both, so the count becomes 2 and this goes red.
    #[test]
    fn a_stall_budget_capture_shares_the_visible_pool_and_its_floor() {
        let saw = Effect::StallBudget { stalled_ms: 4_680, window_ms: WINDOW_MS };
        assert_eq!(capture_for(&saw), Some(false), "the visible pool, never a third one");
        assert_eq!(
            dump_target(Path::new("/logs/hangs"), false),
            (PathBuf::from("/logs/hangs"), MAX_HANG_DUMPS),
            "and `false` resolves to the visible directory and its full budget"
        );
        // It is not an EPISODE, so a capture taken for it must not tell a later silence episode it
        // already has a stack it never got.
        assert!(!capture_satisfies_episode(&saw));
        assert!(capture_satisfies_episode(&Effect::ReportNew {
            stalled_ms: 5_000,
            hidden: false,
            starved_ms: 0
        }));

        let dir = Path::new("/logs/hangs");
        let mut captures: Vec<u64> = Vec::new();
        {
            let mut capture = |_: &Path, stamp: u64, _: usize| captures.push(stamp);
            let vis = AtomicU64::new(0);
            let hid = AtomicU64::new(0);
            // A visible silence episode captures at T.
            let silence = Effect::ReportNew { stalled_ms: 5_000, hidden: false, starved_ms: 0 };
            assert!(try_capture_with(Some(dir), capture_for(&silence).unwrap(), 200_000, &vis, &hid, &mut capture));
            // The sawtooth trigger fires 10 seconds later — inside the visible floor. REFUSED.
            assert!(!try_capture_with(Some(dir), capture_for(&saw).unwrap(), 210_000, &vis, &hid, &mut capture));
            // And once the floor expires it is owed its own stack like anything else.
            let floor = VISIBLE_CAPTURE_MIN_INTERVAL.as_millis() as u64;
            assert!(try_capture_with(Some(dir), capture_for(&saw).unwrap(), 200_000 + floor, &vis, &hid, &mut capture));
        }
        assert_eq!(captures, vec![200_000, 200_000 + VISIBLE_CAPTURE_MIN_INTERVAL.as_millis() as u64]);
    }

    // An effect that owes no stack must ask for none, or a `Quiet` tick spends the floor a real
    // episode needs.
    #[test]
    fn only_the_effects_that_owe_a_stack_ask_for_one() {
        assert_eq!(capture_for(&Effect::Quiet), None);
        assert_eq!(
            capture_for(&Effect::Rebaseline {
                new_last_beat_ms: 1,
                discarded_gap_ms: 30_000,
                announce: true
            }),
            None
        );
        assert_eq!(capture_for(&Effect::Recovered { hung_for_ms: 5_000, hidden: false }), None);
        assert_eq!(
            capture_for(&Effect::Restate { stalled_ms: 9_000, hidden: false, wants_stack: false }),
            None,
            "an episode that already has its stack must stop asking"
        );
        assert_eq!(
            capture_for(&Effect::Restate { stalled_ms: 9_000, hidden: true, wants_stack: true }),
            Some(true),
            "a hidden episode that still owes one asks the hidden pool"
        );
    }
}
