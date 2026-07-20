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
const renderCounts = new Map<string, number>();

/** Call once per render from a component (e.g. perfRender("AgentPane", agent.id, { visible })). Logs
 *  a running count at debug so a background pane re-rendering on every unrelated store write stands
 *  out — the render-thrash fingerprint. Counting is O(1); the debug line is filterable. */
export function perfRender(component: string, key: string, meta?: Record<string, unknown>): void {
  const id = `${component}:${key}`;
  const count = (renderCounts.get(id) ?? 0) + 1;
  renderCounts.set(id, count);
  log.debug("perf", `render ${component}`, { key, count, ...meta });
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
