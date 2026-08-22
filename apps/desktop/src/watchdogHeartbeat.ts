// The webview half of the main-thread watchdog (see src-tauri/src/watchdog.rs).
//
// One job: prove the main thread is still turning. The heartbeat is a `setInterval` on purpose —
// it runs on the SAME thread the UI runs on, so anything that blocks the UI also stops the beat.
// The signal is the silence, which is why this must not be moved to a worker, a rAF callback that
// gets suppressed when hidden, or anything else with its own liveness.
//
// WHICH main thread, though — and the answer is BOTH, for a reason that is not obvious from this
// file. "The thread the UI runs on" is plainly the RENDERER's main thread: on macOS the webview's JS
// runs in a separate WebKit `WebContent` process, so a `setInterval` here proves that process is
// turning and says nothing, on its face, about the host's AppKit main thread — which is the thread
// the 2026-07-29 beachball was parked on, and the thread `watchdog.rs` exists to indict.
//
// It covers both because of what the beat DOES, not where it is scheduled: `invoke` is a Tauri IPC
// crossing, and the command is dispatched through the host. Verified from a captured `sample(1)`
// stack rather than assumed — `sparkle_lib::ipc_trace::ipc_protocol` appears on
// `DispatchQueue_1: com.apple.main-thread`. So a wedged AppKit main thread cannot dispatch the
// command, `LAST_BEAT_MS` stops moving, and the silence is recorded exactly as if the renderer had
// stopped. The claim in the sentence above is therefore true of both threads at once, and it is
// true because of the IPC hop — which is the thing to preserve if this is ever rewritten. Moving
// the beat onto a channel that does not touch the host main thread would keep every word of this
// file accurate about the renderer and silently stop detecting the failure it was built for.
//
// It exists because every instrument we had ran on the blocked thread and therefore could not
// report a block. The 2026-07-29 freeze produced no crash file, no panic and no jank line: the main
// thread was parked in the kernel on a synchronous XPC call, and a parked thread cannot log. This
// tells a thread that ISN'T parked, so it can.
import { invoke } from "@tauri-apps/api/core";

import { log } from "./logger";
import { takePendingStallMs } from "./perfTrace";

/** How often to beat. The Rust side declares a hang after several missed beats — see HANG_AFTER
 *  there. Kept comfortably finer than that threshold so ordinary scheduling jitter, or a single
 *  slow frame, can never look like a hang. */
const BEAT_MS = 1_000;

/** The live disposer, or `null` when not beating. Doubles as the idempotency guard. */
let stop: (() => void) | null = null;

/**
 * Start beating. Idempotent; safe to call from multiple mounts. Returns a disposer that clears the
 * interval and unregisters the listener.
 *
 * The app never calls the disposer — this runs for the life of the process. It exists because the
 * interval and the `visibilitychange` listener are otherwise unreachable once registered, which
 * makes them leak across test cases (each case adds another listener to the same jsdom `document`,
 * so one dispatched event fires N beats and the counts drift). Something that installs a global
 * listener should be able to take it back.
 *
 * ── THE VISIBILITY BEAT IS NOT OPTIONAL ───────────────────────────────────────────────────────
 * A backgrounded or occluded WKWebView has its timers throttled hard or stopped outright. From the
 * watchdog's side that is indistinguishable from a hang: heartbeats stop while its own OS thread
 * keeps ticking punctually. So before the window goes away we send one final beat marked `hidden`,
 * and we send a visible beat the instant we come back rather than waiting out an interval.
 *
 * WHAT THE `hidden` FLAG DOES, precisely — it does NOT stand the watchdog down, and an earlier
 * version of this comment said it did. It selects `HIDDEN_HANG_AFTER` (ten minutes) instead of
 * `HANG_AFTER` (five seconds), and it marks the whole episode as discounted: a hidden episode is
 * logged at `info` rather than `warn`. So a hidden window CAN still produce an episode — that is
 * deliberate, since the 2026-07-29 root cause runs regardless of visibility and a backgrounded app
 * can genuinely wedge. If you are reading this because such lines appeared in the log, they are
 * expected, and `hidden: true` is how to tell them from the real thing.
 *
 * WHAT IT DOES NOT DO IS SUPPRESS THE STACK, and this comment claimed for two releases that it did
 * ("captures no `sample(1)` stack, because a false capture would evict a real one"). That was the
 * argument for zeroing the hidden budget, and the Rust side stopped agreeing with it: it now
 * captures hidden stacks into a SEPARATE, smaller, separately rate-limited pool
 * (`MAX_HIDDEN_HANG_DUMPS`, `dump_target`, `HIDDEN_CAPTURE_MIN_INTERVAL` in `watchdog.rs`), which
 * answers the eviction worry properly — a cmd-tab and a real wedge are never in the same budget —
 * without leaving the case the hidden path exists for with no evidence at all. Walk that case: the
 * user cmd-tabs away, THEN the main thread wedges; the `hidden: true` beat landed before the wedge,
 * and the wedged thread cannot process a `visible` beat either, so the episode never reclassifies,
 * not even when the user clicks the dock icon and meets the beachball. Under the old text that
 * produced a log line and nothing to diagnose it with.
 *
 * `visibilitychange` fires BEFORE the throttling takes effect, which is the only reason this works
 * — it is the last thing we are guaranteed to be able to send. Note the corollary the Rust side
 * relies on: a main thread that is ALREADY wedged cannot run this handler, so a freeze that
 * occludes the window on its way down never sends the hidden beat, and the watchdog correctly holds
 * the visible five-second bar for it.
 */
export function startWatchdogHeartbeat(): () => void {
  if (stop) return stop;
  if (typeof setInterval !== "function") return () => {};

  const beat = (hidden: boolean) => {
    // THE SECOND THING A BEAT CARRIES. Silence is a binary verdict at a five-second bar, and a real
    // hang family sits entirely underneath it: on 2026-08-20 the UI stalled seven to thirteen times
    // a minute, lost 2.6-4.7 seconds of every minute, never once went quiet for five seconds, and
    // the watchdog correctly captured nothing. `stalledMs` is the stall time the rAF monitor in
    // perfTrace.ts has already measured since the last beat — the identical quantity behind its
    // `jank stall` / `jank minor stalls` lines, handed over rather than re-derived, so a stall has
    // one definition. The Rust side sums it over a rolling window; see `STALL_BUDGET_MS` there.
    //
    // Drained INSIDE the beat rather than at the call sites, so the interval beat and the
    // visibilitychange beat cannot both claim the same milliseconds.
    const stalledMs = takePendingStallMs();
    // Never let the watchdog's own plumbing throw into the UI. A rejected invoke (the command
    // missing on an older shell, the bridge torn down mid-shutdown) must degrade to "no heartbeat",
    // which the Rust side already treats as a hang candidate and gates behind its own suspend and
    // hidden checks — not to an unhandled rejection on every tick.
    void Promise.resolve(invoke("watchdog_heartbeat", { hidden, stalledMs })).catch(() => {});
  };

  const timer = setInterval(
    () => beat(typeof document !== "undefined" && document.hidden),
    BEAT_MS,
  );

  // Report the new state immediately rather than at the next interval: going hidden must land
  // before our timers are throttled, and coming back must restore the tight visible threshold
  // before the watchdog's next tick can read a stale beat against the ten-minute bar.
  const onVisibilityChange = () => beat(document.hidden);
  const canListen =
    typeof document !== "undefined" && typeof document.addEventListener === "function";
  if (canListen) document.addEventListener("visibilitychange", onVisibilityChange);

  stop = () => {
    clearInterval(timer);
    if (canListen) document.removeEventListener("visibilitychange", onVisibilityChange);
    stop = null;
  };

  log.info("perf", "watchdog heartbeat started", { beatMs: BEAT_MS });
  return stop;
}
