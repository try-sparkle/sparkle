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

/** Start a requestAnimationFrame loop that logs any inter-frame gap exceeding `thresholdMs` — i.e.
 *  every time the main thread was blocked long enough to drop frames (the visible "freeze"). Idle
 *  when the window is hidden (rAF is throttled/paused then, which would be a false positive). This
 *  is the single most useful instrument for "the app is slow": it catches EVERY stall, whatever the
 *  cause, so we can then correlate the timestamp against the spawn/switch/close/span/render lines.
 *  Idempotent; safe to call from multiple mounts. */
export function startJankMonitor(thresholdMs = 150): void {
  if (jankRunning || typeof requestAnimationFrame !== "function") return;
  jankRunning = true;
  let last = perfNow();
  log.info("perf", "jank monitor started", { thresholdMs, heapMb: heapMb() });
  const tick = () => {
    const now = perfNow();
    const gap = now - last;
    last = now;
    // Skip gaps accrued while hidden — rAF is paused/throttled in the background, not a real stall.
    if (gap >= thresholdMs && (typeof document === "undefined" || !document.hidden)) {
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
