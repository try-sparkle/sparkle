// App performance instrumentation ("why is Sparkle slow?").
//
// Everything here is a pure side-effect that logs into the SAME file as the rest of the app
// (logger.ts, scope "perf"), so a single reproduction + `grep '\[perf\]'` reconstructs where the
// time went. Nothing here throws, allocates on a hot path beyond a Map lookup, or changes behavior.
//
// Four instruments, each independently grep-able by its message prefix:
//   • jank      — a requestAnimationFrame stall detector: logs every main-thread freeze (the app
//                 "hangs") with its duration, so we SEE the 2-5s stalls even without knowing the
//                 cause. This is the first thing to read: `grep 'perf.*jank'`.
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
/** Only spans at/above this many ms are logged, so sub-ms work doesn't flood the file. */
const SPAN_MIN_MS = 1;

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

/** Time an async operation end-to-end (await included) and log if it took ≥ SPAN_MIN_MS. */
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
type RenderStat = { count: number; loggedAt: number; loggedCount: number };

/** Entries are intentionally never evicted: `count` is documented as lifetime-cumulative, so a
 *  retired key's entry is what makes a re-mounted pane's count continue rather than silently reset.
 *  Unbounded in principle, immaterial in practice — an entry is three numbers and a busy day spans
 *  ~60 keys. There is deliberately no forget/cancel hook (cf. `perfCancel` for `traces`, which
 *  exists because an abandoned interaction would otherwise log a bogus total; a stale render count
 *  logs nothing at all). */
const renderStats = new Map<string, RenderStat>();

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
    renderStats.set(id, { count: 1, loggedAt: now, loggedCount: 1 });
    log.debug("perf", `render ${component}`, { ...meta, key, count: 1 });
    return;
  }
  prev.count += 1;
  if (now - prev.loggedAt < RENDER_COALESCE_MS) return; // inside the window — counted, not logged
  // `meta` spreads FIRST so the instrument's own fields always win: `ms` is a plausible thing for a
  // caller to pass (perfSpan uses it as a meta name), and a caller silently overwriting it would
  // corrupt the exact rate signal this coalescing exists to preserve.
  log.debug("perf", `render ${component}`, {
    ...meta,
    key,
    count: prev.count,
    since: prev.count - prev.loggedCount,
    ms: Math.round(now - prev.loggedAt),
  });
  prev.loggedAt = now;
  prev.loggedCount = prev.count;
}

/** Clear render counters/windows so a test starts from a known state (counts are process-lifetime). */
export function __resetRenderTraceForTest(): void {
  renderStats.clear();
}

// ── Global main-thread stall (jank) monitor ─────────────────────────────────────────────────────
let jankRunning = false;

// A gap this large isn't a dropped-frame stall — the process was suspended (machine asleep, lid
// closed, or a paused debugger). rAF doesn't fire while suspended, so the first tick on resume sees
// the entire sleep interval as one "gap". Logging that as jank is a false positive that floods the
// perf log and buries genuine sub-second stalls, so we classify resumes separately. No running
// main-thread stall lasts this long; anything above it is a wake, not a freeze.
const SUSPEND_MS = 30_000;

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
  const tick = () => {
    const now = perfNow();
    const gap = now - last;
    last = now;
    const verdict = classifyJankGap(gap, thresholdMs, hiddenSinceLastTick);
    hiddenSinceLastTick = typeof document !== "undefined" && document.hidden;
    if (verdict === "resume") {
      // Resume from suspend, not a freeze — record it (still useful to correlate) without the warn.
      log.debug("perf", "resume after suspend", { ms: Math.round(gap) });
    } else if (verdict === "stall") {
      log.warn("perf", "jank stall", { ms: Math.round(gap), heapMb: heapMb() });
    }
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
