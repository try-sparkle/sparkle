// The webview half of the main-thread watchdog (see src-tauri/src/watchdog.rs).
//
// One job: prove the main thread is still turning. The heartbeat is a `setInterval` on purpose —
// it runs on the SAME thread the UI runs on, so anything that blocks the UI also stops the beat.
// The signal is the silence, which is why this must not be moved to a worker, a rAF callback that
// gets suppressed when hidden, or anything else with its own liveness.
//
// It exists because every instrument we had ran on the blocked thread and therefore could not
// report a block. The 2026-07-29 freeze produced no crash file, no panic and no jank line: the main
// thread was parked in the kernel on a synchronous XPC call, and a parked thread cannot log. This
// tells a thread that ISN'T parked, so it can.
import { invoke } from "@tauri-apps/api/core";

import { log } from "./logger";

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
 * logged at `info` rather than `warn` and captures no `sample(1)` stack, because a false capture
 * would evict a real one from a finite dump budget. So a hidden window CAN still produce an
 * episode — that is deliberate, since the 2026-07-29 root cause runs regardless of visibility and a
 * backgrounded app can genuinely wedge. If you are reading this because such lines appeared in the
 * log, they are expected, and `hidden: true` is how to tell them from the real thing.
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
    // Never let the watchdog's own plumbing throw into the UI. A rejected invoke (the command
    // missing on an older shell, the bridge torn down mid-shutdown) must degrade to "no heartbeat",
    // which the Rust side already treats as a hang candidate and gates behind its own suspend and
    // hidden checks — not to an unhandled rejection on every tick.
    void Promise.resolve(invoke("watchdog_heartbeat", { hidden })).catch(() => {});
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
