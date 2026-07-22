// App performance instrumentation ("why is Sparkle slow?").
//
// Everything here is a pure side-effect that logs into the SAME file as the rest of the app
// (logger.ts, scope "perf"), so a single reproduction + `grep '\[perf\]'` reconstructs where the
// time went. Nothing here throws, allocates on a hot path beyond a Map lookup, or changes behavior.
//
// Four instruments, each independently grep-able by its message prefix:
//   • jank      — a requestAnimationFrame stall detector: catches every main-thread freeze (the app
//                 "hangs"), so we SEE the 2-5s stalls even without knowing the cause. Freezes long
//                 enough to feel (>=JANK_SEVERE_MS) warn on their own line; shorter ones are
//                 counted and reported as a periodic rate, since dropped frames matter in aggregate
//                 and warning on each buried the tail. First thing to read: `grep 'perf.*jank'`.
//   • <kind>    — keyed interaction waterfalls (spawn / switch / close): start → milestones → total,
//                 each milestone carrying ms-since-start and ms-since-previous.
//   • span      — one-shot timing around a specific sync/async operation (merge, migrate, stringify…).
//   • render    — per-component re-render counter, so a background pane rendering 200× on a store
//                 write (the classic thrash) is obvious: `grep 'perf.*render AgentPane'`.
import { log } from "./logger";

/** Chromium/WebView2 heap gauge. macOS Tauri is WKWebView (WebKit) where `performance.memory` is
 *  absent → undefined there; a big jank gap paired with a growing heap (where present) flags GC. */
export function heapMb(): number | undefined {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Math.round(mem.usedJSHeapSize / 1_048_576) : undefined;
}

// ── Keyed interaction waterfalls (spawn / switch / close) ─────────────────────────────────────
type Trace = { kind: string; t0: number; last: number };
const traces = new Map<string, Trace>();

/** Begin a keyed interaction trace (e.g. perfStart(agentId, "spawn")). Overwrites any prior trace
 *  for the key, so a re-used id (retry, reopen) restarts cleanly. */
export function perfStart(key: string, kind: string, meta?: Record<string, unknown>): void {
  const now = perfNow();
  traces.set(key, { kind, t0: now, last: now });
  log.info("perf", `${kind} start`, { key, heapMb: heapMb(), ...meta });
}

/** Record a milestone on a keyed trace. No-op if the key was never started (e.g. a boot-restored
 *  pane that had no click), so it's safe to call unconditionally from shared paths. */
export function perfMark(key: string, milestone: string, meta?: Record<string, unknown>): void {
  const tr = traces.get(key);
  if (!tr) return;
  const now = perfNow();
  const msSinceStart = Math.round(now - tr.t0);
  const msSincePrev = Math.round(now - tr.last);
  tr.last = now;
  log.info("perf", `${tr.kind} ${milestone}`, { key, msSinceStart, msSincePrev, heapMb: heapMb() });
}

/** Close a keyed trace with a final total. No-op for an unstarted key. */
export function perfEnd(key: string, milestone = "ready", meta?: Record<string, unknown>): void {
  const tr = traces.get(key);
  if (!tr) return;
  traces.delete(key);
  const totalMs = Math.round(perfNow() - tr.t0);
  log.info("perf", `${tr.kind} ${milestone} (total)`, { key, totalMs, heapMb: heapMb(), ...meta });
}

/** Drop a keyed trace without logging (teardown before completion), so a never-finished interaction
 *  can't leak its start entry. */
export function perfCancel(key: string): void {
  traces.delete(key);
}

// ── One-shot spans around a specific operation ────────────────────────────────────────────────
/** Only spans at/above this many ms are logged. One frame at 60Hz (~16.7ms) is the bar: a span
 *  below it did NOT drop a frame, so it isn't a stall anyone can perceive and isn't worth a line.
 *  The old 1ms floor logged nearly every span — in a steady session the rehydrate + persist spans
 *  alone were tens of thousands of INFO lines a day (the bulk of the perf log on disk), burying the
 *  handful of genuinely slow spans (the 50–750ms rehydrates) the instrument exists to surface. A
 *  span is now logged only when the single operation ate a whole frame's budget; cumulative
 *  sub-frame cost still shows up in the jank monitor's stalls. */
const SPAN_MIN_MS = 16;

/** Time a synchronous operation and log if it took ≥ SPAN_MIN_MS. Returns fn()'s value; rethrows. */
export function perfSpan<T>(name: string, fn: () => T, meta?: Record<string, unknown>): T {
  const t0 = perfNow();
  try {
    return fn();
  } finally {
    const ms = round2(perfNow() - t0);
    if (ms >= SPAN_MIN_MS) log.info("perf", `span ${name}`, { ms, ...meta });
  }
}

/** Time an async operation end-to-end (await included) and log only if it took ≥ SPAN_MIN_MS. */
export async function perfSpanAsync<T>(
  name: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  const t0 = perfNow();
  try {
    return await fn();
  } finally {
    const ms = round2(perfNow() - t0);
    if (ms >= SPAN_MIN_MS) log.info("perf", `span ${name}`, { ms, ...meta });
  }
}

// ── Per-component render counter ────────────────────────────────────────────────────────────────
/** `count` is cumulative for the key's lifetime; `loggedAt`/`loggedCount` are the clock and count as
 *  of the last line written, so the next line can state the window's span and how many renders it
 *  swallowed without holding the renders themselves. */
type RenderStat = {
  count: number;
  loggedAt: number;
  loggedCount: number;
  windowMs: number;
  /** Clock as of the previous render, so the backoff can ask "did this key go quiet?" against the
   *  gap between RENDERS rather than the gap between LINES — see RENDER_IDLE_MS. */
  lastRenderAt: number;
};

/** Entries are intentionally never evicted: `count` is documented as lifetime-cumulative, so a
 *  retired key's entry is what makes a re-mounted pane's count continue rather than silently reset.
 *  Unbounded in principle, immaterial in practice — an entry is three numbers and a busy day spans
 *  ~60 keys. There is deliberately no forget/cancel hook (cf. `perfCancel` for `traces`, which
 *  exists because an abandoned interaction would otherwise log a bogus total; a stale render count
 *  logs nothing at all). */
const renderStats = new Map<string, RenderStat>();

// ── Render LOGGING gate (bead sparkle-abv2) ────────────────────────────────────────────────────
// Counting above is free — a Map bump — so it stays unconditional and `renderCounts()` always
// answers "which pane is thrashing?". LOGGING is what costs: log.debug → logger.ts forward() →
// invoke("frontend_log") is a Tauri IPC crossing + JSON serialization + a Rust-side file write, ON
// THE MAIN THREAD, per logged render.
//
// Coalescing (below) and this gate solve DIFFERENT halves and are both needed. Coalescing bounds
// the rate while logging is on; measured on a real day it drops ~38% of lines at the shipped 1s
// window, and its own note says the remainder "is breadth, not burst" — so ~145K invokes/day
// becomes ~90K/day, on the main thread, for every user who is not debugging render thrash. The
// gate takes that to ZERO by default, which is what the bead actually asked for.
const PERF_RENDER_LOG_KEY = "sparkle.perf.renderLog";

/** Read the gate. localStorage is AUTHORITATIVE when present — including an explicit "0".
 *
 *  Persisting the off-state (rather than removing the key) is deliberate: with `removeItem`, an
 *  explicit runtime "off" would fall through to the build-time env default and silently turn back
 *  ON after a webview reload in any build where VITE_PERF_RENDER_LOG=1 — the user's choice would
 *  not stick, and the persistence test would still pass because the env var is unset in the test
 *  host. Present-but-falsy therefore means off, and only an ABSENT key consults the env. */
function readPerfRenderFlag(): boolean {
  try {
    const stored = localStorage.getItem(PERF_RENDER_LOG_KEY);
    if (stored !== null) return stored === "1";
  } catch {
    // localStorage can throw (private mode, disabled storage). Fall through to the env default
    // rather than letting an instrument break the app it is measuring.
  }
  return import.meta.env?.VITE_PERF_RENDER_LOG === "1";
}

let renderLogEnabled = readPerfRenderFlag();

/** Turn per-render logging on/off at runtime and persist the choice. Exposed on `window.sparklePerf`
 *  so it is reachable from devtools without a rebuild — the whole point of a debug flag is that you
 *  can flip it while looking at the problem. */
export function setPerfRenderLogging(on: boolean): void {
  renderLogEnabled = on;
  try {
    localStorage.setItem(PERF_RENDER_LOG_KEY, on ? "1" : "0");
  } catch {
    // Non-persistent is still better than not toggling at all; the in-memory flag already flipped.
  }
}

export function perfRenderLoggingEnabled(): boolean {
  return renderLogEnabled;
}

/** Cumulative render counts per "Component:key", newest state — the signal the log lines carried,
 *  available with logging OFF because the counting never stopped. */
export function renderCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, stat] of renderStats) out[id] = stat.count;
  return out;
}

/** Expose the gate + counters on `window.sparklePerf` for devtools. A debug flag you cannot reach
 *  without a rebuild is not a debug flag, and the counters are what make logging-off tolerable:
 *  `sparklePerf.counts()` answers "which pane is thrashing?" with zero IPC. Called once at startup;
 *  a no-op outside a browser-ish context (tests import this module headlessly). */
export function installPerfDevtools(): void {
  if (typeof window === "undefined") return;
  (window as unknown as { sparklePerf?: unknown }).sparklePerf = {
    counts: renderCounts,
    setRenderLogging: setPerfRenderLogging,
    renderLoggingEnabled: perfRenderLoggingEnabled,
  };
}

/** At most one render line per key per window. Thrash is a RATE, so a burst's worth of individual
 *  lines carries no signal the coalesced line doesn't — while costing an IPC hop each (see
 *  logger.ts: every log.debug ships a `frontend_log` invoke) on the very render path this
 *  instrument exists to measure. Mirrors SPAN_MIN_MS above: every instrument here has a flood guard,
 *  and this one was the exception — render lines were ~88% of a day's log by volume.
 *
 *  1s is the knee of the curve, measured by replaying a day of real render traffic: 250ms/500ms/1s/
 *  2s/5s windows drop 18%/29%/38%/41%/47% of lines, so widening past 1s trades a lot of temporal
 *  resolution for a few points. The remaining volume is breadth, not burst — a busy session keeps
 *  ~60 keys alive, each re-rendering steadily — which is why this caps per-key rate rather than
 *  trying to hit a whole-file target. Per key, the observed worst case is ~150 renders in one second
 *  (a Workspace store-write thrash); a 1s window turns that into one line reading since:150. */
const RENDER_COALESCE_MS = 1_000;

/** Ceiling for the widened window (see RENDER_SUSTAINED_FACTOR). Two lines a minute is still a live
 *  pulse for a pane that has been thrashing for hours — enough to see it's ongoing and to read the
 *  rate off `since`/`ms` — without the window growing until a key that finally goes quiet takes an
 *  unbounded time to say so. */
const RENDER_COALESCE_MAX_MS = 30_000;

/** How long a key must produce NO renders at all before the backoff treats it as having gone quiet.
 *  A flush whose preceding render gap is under this means the key has been rendering continuously,
 *  so the window doubles (capped at RENDER_COALESCE_MAX_MS); a longer gap means it idled and came
 *  back, which is a change in behaviour and therefore newsworthy, so the window resets to
 *  RENDER_COALESCE_MS.
 *
 *  This is measured against the gap since the previous RENDER, not the gap since the previous LINE,
 *  and that distinction is the whole point. The original test asked `elapsed < windowMs * FACTOR`,
 *  where `elapsed` is the span since the last line — which makes "quiet" mean something different at
 *  every window size, and unsatisfiable below a floor. A key rendering once every 2.3s always flushes
 *  on its very next render (2300 >= the 1000ms base window) with `elapsed` 2300, and 2300 is NOT
 *  under 1000*2 — so it scored as "idled and came back", reset to the base window, and did it again
 *  on the next render, forever. Every render past ~2x the base period logged its own `since:1` line
 *  and the backoff could never engage on the panes that needed it most. A real day's log shows the
 *  failure plainly: ~260k `render AgentPane` lines, 83% of the entire file, every one of them reading
 *  `since:1` at `ms` between 2.3s and 5.6s — the exact band the ratio test cannot widen out of.
 *
 *  An absolute threshold has no such floor: continuity is a property of the key's render stream, not
 *  of how coarsely we happen to be sampling it, so the same 2.3s hum now doubles its way to the cap
 *  like any other sustained key. RENDER_COALESCE_MAX_MS is the natural value — a key that hasn't
 *  rendered once in the time spanned by the widest window we would ever use has, by any reading,
 *  stopped.
 *
 *  The comparison is exclusive, so a key rendering at EXACTLY this period counts as idle and logs
 *  every render. Deliberate: that is one line per 30s, which is a live pulse rather than a flood, and
 *  a key rendering once every 30 seconds is a fair description of idle anyway. The floor this
 *  replaces was pathological because it scaled — it silently swallowed a whole band of ordinary
 *  periods — whereas this is a single exact period with a bounded, unremarkable cost.
 *
 *  This is the fix for the "breadth, not burst" residual the note above waves off. The flat 1s cap
 *  bounds how loud one key can be in one second but not how long it can stay loud: the dominant real
 *  cost isn't a pane spinning 150× in a burst, it's ~60 panes each re-rendering roughly once a
 *  second for hours, every one of them logging `since:1` forever. In a measured day that steady-state
 *  tail was ~75% of the whole log — 424k of 565k lines, 70% of them for panes that weren't even
 *  visible. Those lines are near-duplicates: after the first few windows, "still rendering, still
 *  ~1/sec" is established, and the 3,000th line restating it at the same resolution adds nothing.
 *
 *  Backoff keeps every part of the fingerprint and drops only the redundancy. The mount line, the
 *  onset of thrash, and the exact cumulative `count` are untouched; `since`/`ms` stay exact over
 *  whatever window they cover, so the rate is still readable — just sampled more coarsely the longer
 *  a key has been doing the same thing. A steady 1/sec pane logs at ~1s, 2s, 4s, 8s, 16s, then every
 *  30s: ~1.2k lines over a 10-hour session instead of ~36k, with the same story.
 *
 *  Doubling (rather than a fixed wide window) is what keeps onset sharp: a key that starts thrashing
 *  is still reported at 1s resolution for the first several seconds, when the information is new. */
const RENDER_IDLE_MS = RENDER_COALESCE_MAX_MS;

/** How fast the window widens per sustained flush. Kept separate from RENDER_IDLE_MS now that the
 *  two are genuinely independent knobs: growth sets the sampling curve, the idle threshold sets what
 *  counts as "still rendering". (They used to be one number, which is what produced the floor
 *  described above.) */
const RENDER_SUSTAINED_FACTOR = 2;

/** Call once per render from a component (e.g. perfRender("AgentPane", agent.id, { visible })). Logs
 *  a running count at debug so a background pane re-rendering on every unrelated store write stands
 *  out — the render-thrash fingerprint. Counting is O(1); the debug line is filterable.
 *
 *  A key's first render always logs (`count: 1` — mount is worth seeing). After that, renders inside
 *  RENDER_COALESCE_MS of the last line are counted but not logged; the next render past the window
 *  emits one line carrying `since` (renders coalesced into it, this one included) and `ms` (the span
 *  since the PREVIOUS line) — i.e. the burst is reported as a rate rather than reconstructed by hand
 *  from N lines. `count` stays the exact cumulative total, so suppression never costs a render.
 *
 *  The window is not fixed: a key that keeps rendering continuously doubles it up to
 *  RENDER_COALESCE_MAX_MS, and going quiet past the window resets it (see RENDER_SUSTAINED_FACTOR).
 *  So a pane's first seconds of thrash are reported at full 1s resolution and an hours-long steady
 *  hum settles to a line every 30s. Every line stays self-describing — `ms` is always the true span
 *  it covers and `since` the renders in it — so a widened window changes the sampling, not the math.
 *
 *  Read `since`/`ms` as a rate only while a key is rendering steadily — which is the thrash case,
 *  and there it's the true rate. `ms` is the gap since the last line, NOT the span the coalesced
 *  renders arrived over, and the two diverge once renders cluster at the front of a window: a pane
 *  that spins 400× in 200ms and then settles gets flushed by whatever render comes next, so it may
 *  report `since:400, ms:60000` (≈7/sec) for a burst that really ran at ≈2000/sec. `count` and
 *  `since` stay exact, so the burst is never hidden — only the derived rate reads low, and it reads
 *  low precisely when the key has STOPPED thrashing.
 *
 *  Pinning the true arrival span would mean closing a batch without a render to close it — i.e. a
 *  per-key timer on a hot path — or reporting the flush render in the NEXT batch. Both buy accuracy
 *  only for burst-then-idle, the case that by definition isn't the problem; not worth the state.
 *  Related: a key that renders hard and then goes permanently silent never flushes its last partial
 *  window at all. Same reasoning — `count` is cumulative, so the next line, whenever it comes, still
 *  states the true total. */
export function perfRender(component: string, key: string, meta?: Record<string, unknown>): void {
  const id = `${component}:${key}`;
  const now = perfNow();
  const prev = renderStats.get(id);
  if (!prev) {
    renderStats.set(id, {
      count: 1,
      loggedAt: now,
      loggedCount: 1,
      windowMs: RENDER_COALESCE_MS,
      lastRenderAt: now,
    });
    // The mount line is still worth seeing, but only when logging is on: a busy session mounts
    // ~60 keys, so an ungated "first render always logs" is 60 main-thread IPCs nobody asked for.
    if (renderLogEnabled) log.debug("perf", `render ${component}`, { ...meta, key, count: 1 });
    return;
  }
  prev.count += 1;
  // COUNT first, gate second: `count` must stay exact whether or not logging is on, because
  // renderCounts() is the whole reason counting is unconditional. Returning before the increment
  // would make the gate silently corrupt the data it is meant to preserve.
  //
  // The gate sits in FRONT of the adaptive window, so while logging is off neither `loggedAt` nor
  // `windowMs` advances. That is the behaviour we want on re-enable: `elapsed` is then large, the
  // next render logs immediately, and the backoff restarts from RENDER_COALESCE_MS rather than
  // resuming a stale 30s window the user never saw.
  if (!renderLogEnabled) return;
  // Gap since the PREVIOUS render, captured before `lastRenderAt` advances — the continuity signal
  // the backoff decides on below. Advanced only past the gate, so a stretch with logging OFF leaves
  // it stale on purpose: re-enabling then reads a large gap and restarts the backoff from the base
  // window, matching what `loggedAt`/`windowMs` already do (see the note above the gate).
  const renderGap = now - prev.lastRenderAt;
  prev.lastRenderAt = now;
  const elapsed = now - prev.loggedAt;
  if (elapsed < prev.windowMs) return; // inside the window — counted, not logged
  // `meta` spreads FIRST so the instrument's own fields always win: `ms` is a plausible thing for a
  // caller to pass (perfSpan uses it as a meta name), and a caller silently overwriting it would
  // corrupt the exact rate signal this coalescing exists to preserve.
  log.debug("perf", `render ${component}`, {
    ...meta,
    key,
    count: prev.count,
    since: prev.count - prev.loggedCount,
    ms: Math.round(elapsed),
  });
  prev.loggedAt = now;
  prev.loggedCount = prev.count;
  // Widen while the key keeps rendering at all; snap back only once it has genuinely stopped. The
  // test is on `renderGap` rather than `elapsed` so that "still rendering" means the same thing at
  // every window size — see RENDER_IDLE_MS for the floor the old window-relative form imposed.
  prev.windowMs =
    renderGap < RENDER_IDLE_MS
      ? Math.min(prev.windowMs * RENDER_SUSTAINED_FACTOR, RENDER_COALESCE_MAX_MS)
      : RENDER_COALESCE_MS;
}

/** Clear render counters/windows so a test starts from a known state (counts are process-lifetime).
 *  Also re-reads the logging gate, so a test that flipped it cannot leak into the next one. */
export function __resetRenderTraceForTest(): void {
  renderStats.clear();
  renderLogEnabled = readPerfRenderFlag();
}

// ── Global main-thread stall (jank) monitor ─────────────────────────────────────────────────────
let jankRunning = false;

// A gap this large isn't a dropped-frame stall — the process was suspended (machine asleep, lid
// closed, App Nap, display sleep, full window occlusion, or a paused debugger). rAF doesn't fire
// while suspended, so the first tick on resume sees the entire paused interval as one "gap".
// Logging that as jank is a false positive that floods the perf log and buries genuine sub-second
// stalls, so we classify resumes separately. No running main-thread stall lasts this long;
// anything above it is a wake, not a freeze.
//
// 10s, not the original 30s. Only the lid-close case reliably clears 30s — the everyday pauses
// (App Nap, display sleep, occlusion) land in the 10–30s band and were all logged as freezes,
// ~166 bogus WARNs on a busy day claiming the app hung for 10+ seconds. They are identifiable in
// a real session log because a machine-level pause stops EVERY window at once: the 10s+ gaps
// arrive in tight clusters of 3–8 lines whose durations agree to within a few ms, one per open
// window. Independent renderers cannot freeze for the same interval to that precision; a genuine
// main-thread block is a single line from a single window. Measured against real sessions, the
// observed stall p99 is ~1s and the largest non-clustered gap is well under 10s, so this reclaims
// the band without shadowing anything real.
//
// Misclassifying either way is cheap: a resume is still recorded (at debug) with its duration, so
// a gap that lands on the wrong side of this line is relabeled, never lost.
const SUSPEND_MS = 10_000;

/** A stall at or above this warns on its own line; anything shorter is coalesced into the periodic
 *  rollup below. Measured against a day of real traffic: stalls run ~10.3k/day with a median of
 *  221ms — barely past `thresholdMs`, far too short to see — while the freezes that actually cost
 *  the user sit in the tail (p99 ≈13s). Warning on all of them buried that tail under ~93% noise and
 *  bloated a log meant to be shareable. 1s keeps every user-perceptible freeze on its own line
 *  (~750/day, the whole tail) and coalesces the rest; it is the knee, not a round number — 500ms
 *  keeps 1965/day (much of it still sub-perceptible) and 2s starts dropping real freezes into the
 *  rollup. Below this a stall is a dropped frame, and dropped frames matter as a RATE, which is
 *  exactly what the rollup reports. */
const JANK_SEVERE_MS = 1_000;

/** How long minor stalls accumulate before one rollup line is emitted. Mirrors RENDER_COALESCE_MS's
 *  reasoning at a coarser scale: this caps the rate at one line per window instead of ~2.5/sec
 *  observed at peak, and a minute is short enough to still localize a bad patch to the surrounding
 *  spawn/switch/render lines. The window opens at the FIRST pending stall rather than running free,
 *  so an isolated stall after a quiet stretch waits out a full window instead of flushing alone —
 *  otherwise sparse stalls would each get their own line and decay back to the old behaviour. */
const JANK_ROLLUP_MS = 60_000;

/** How to account for one inter-frame gap. `stall` warns, `resume` records a wake, `ignore` drops it. */
export type JankVerdict = "stall" | "resume" | "ignore";

/** Classify one rAF inter-frame gap. Pure, so the hidden-window accounting below is testable.
 *
 *  `wasHiddenSinceLastTick` — NOT `document.hidden` sampled now. rAF is paused while the window is
 *  hidden/occluded, so the tick that observes a background gap only ever runs *after* the window is
 *  visible again, when `document.hidden` has already flipped back to false. Sampling it at tick time
 *  therefore always reads "visible" and can never suppress the very gap it was meant to suppress —
 *  the whole background interval got logged as one bogus multi-second stall. The caller latches the
 *  hidden state via `visibilitychange` instead, which is the only signal that survives the pause. */
export function classifyJankGap(
  gapMs: number,
  thresholdMs: number,
  wasHiddenSinceLastTick: boolean,
): JankVerdict {
  if (gapMs < thresholdMs) return "ignore";
  if (wasHiddenSinceLastTick) return "ignore";
  return gapMs >= SUSPEND_MS ? "resume" : "stall";
}

/** Start a requestAnimationFrame loop that logs any inter-frame gap exceeding `thresholdMs` — i.e.
 *  every time the main thread was blocked long enough to drop frames (the visible "freeze"). Gaps
 *  accrued while the window was hidden are dropped (rAF is paused then, so the gap measures
 *  backgrounded time, not a freeze), and gaps above `SUSPEND_MS` are logged as a resume rather than
 *  a stall (the machine was asleep). This is the single most useful instrument for "the app is
 *  slow": it catches EVERY stall, whatever the cause, so we can then correlate the timestamp against
 *  the spawn/switch/close/span/render lines. Idempotent; safe to call from multiple mounts. */
export function startJankMonitor(thresholdMs = 150): void {
  if (jankRunning || typeof requestAnimationFrame !== "function") return;
  jankRunning = true;
  let last = perfNow();
  // Latched by the visibilitychange listener and cleared by the next tick that consumes it — see
  // classifyJankGap for why tick-time `document.hidden` is the wrong signal.
  let hiddenSinceLastTick = typeof document !== "undefined" && document.hidden;
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) hiddenSinceLastTick = true;
    });
  }
  log.info("perf", "jank monitor started", { thresholdMs, heapMb: heapMb() });
  // Sub-severe stalls pending in the current rollup window. `openedAt` is set when the window opens
  // (first pending stall), not on every flush — see JANK_ROLLUP_MS.
  let minorCount = 0;
  let minorTotalMs = 0;
  let minorMaxMs = 0;
  let openedAt = 0;
  /** Emit the pending window, if any, and reset it. `sinceMs` is the span the window actually
   *  covered, which is why a suspend forces a flush before it lands (see the resume branch). */
  const flushMinors = (now: number) => {
    if (minorCount === 0) return;
    log.info("perf", "jank minor stalls", {
      count: minorCount,
      totalMs: Math.round(minorTotalMs),
      maxMs: Math.round(minorMaxMs),
      sinceMs: Math.round(now - openedAt),
      heapMb: heapMb(),
    });
    minorCount = 0;
    minorTotalMs = 0;
    minorMaxMs = 0;
  };
  const tick = () => {
    const now = perfNow();
    const gap = now - last;
    last = now;
    const verdict = classifyJankGap(gap, thresholdMs, hiddenSinceLastTick);
    hiddenSinceLastTick = typeof document !== "undefined" && document.hidden;
    // Close the open window BEFORE any gap rAF did not run across. A rollup that straddles one
    // would carry the whole paused interval in `sinceMs` — an 8-hour sleep makes a perfectly normal
    // window read as a near-zero stall rate — so the stalls before it are reported over the span
    // they actually occurred in, and the next window starts clean.
    //
    // BOTH non-stall verdicts qualify, which is the fix for a real observed case: a lone 238ms
    // stall was reported with sinceMs ≈ 5.9 HOURS. Its window opened just before the window was
    // backgrounded and was flushed by the first tick after it returned. That gap is classified
    // "ignore" (a hidden window is not a freeze, correctly) rather than "resume", so it used to
    // skip this flush — but rAF is paused just the same, and the pending window spanned the whole
    // hidden interval. Guarding on the verdict rather than on suspend-vs-hidden covers both.
    //
    // The `gap >= thresholdMs` guard is what keeps this off the hot path: an "ignore" verdict is
    // overwhelmingly just a healthy sub-threshold frame, and flushing on those would emit a line
    // per frame and destroy the coalescing entirely.
    if (verdict !== "stall" && gap >= thresholdMs) flushMinors(now - gap);
    if (verdict === "resume") {
      // Resume from suspend, not a freeze — record it (still useful to correlate) without the warn.
      log.debug("perf", "resume after suspend", { ms: Math.round(gap) });
    } else if (verdict === "stall") {
      if (gap >= JANK_SEVERE_MS) {
        log.warn("perf", "jank stall", { ms: Math.round(gap), heapMb: heapMb() });
      } else {
        if (minorCount === 0) openedAt = now;
        minorCount += 1;
        minorTotalMs += gap;
        if (gap > minorMaxMs) minorMaxMs = gap;
      }
    }
    // Flush on a tick rather than a timer: rAF already runs every frame while visible, and while the
    // window is hidden there are no new stalls to report anyway — a pending rollup simply waits for
    // the return, which is also when a reader would care about it.
    if (minorCount > 0 && now - openedAt >= JANK_ROLLUP_MS) flushMinors(now);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Where supported (Chromium/WebView2), the Long Tasks API attributes stalls to a container; on
  // WKWebView it's absent and the rAF loop above stands alone. Feature-detected, never fatal.
  try {
    const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
    if (PO) {
      const obs = new PO((list) => {
        for (const e of list.getEntries()) {
          if (e.duration >= thresholdMs) {
            log.warn("perf", "longtask", { ms: Math.round(e.duration), name: e.name });
          }
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
    }
  } catch {
    /* longtask entry type unsupported (WebKit) — the rAF monitor covers us */
  }
}

// ── internals ───────────────────────────────────────────────────────────────────────────────────
function perfNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
