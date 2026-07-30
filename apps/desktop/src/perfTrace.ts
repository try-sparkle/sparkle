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
  log.info("perf", `${tr.kind} ${milestone}`, {
    key,
    msSinceStart,
    msSincePrev,
    heapMb: heapMb(),
    ...meta,
  });
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

/** Compact summary of the interaction traces open RIGHT NOW, as kind counts (e.g. "spawn×2, switch"),
 *  or undefined when nothing is in flight. Emits only the static `kind` labels — never the trace KEYS
 *  (agent ids, paths), so it's safe to write to the shared log. Used to attribute a jank stall to
 *  whatever interaction was mid-flight when the main thread froze: on macOS WKWebView the Long Tasks
 *  API is absent, so this is the only cheap attribution the rAF monitor has. A trace being open spans
 *  many frames, so this is a CORRELATION HINT (what was in flight), not proof this trace caused the
 *  stall. O(open traces), only computed when a stall actually fires. Exported for its test. */
export function openTraceKinds(): string | undefined {
  if (traces.size === 0) return undefined;
  const counts = new Map<string, number>();
  for (const { kind } of traces.values()) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts]
    .map(([kind, n]) => (n > 1 ? `${kind}×${n}` : kind))
    .join(", ");
}

// ── Suspend & background attribution (shared by the span and jank instruments) ─────────────────
// Both instruments measure WALL CLOCK, so both can bill the app for time it was not running. The
// jank monitor learned this the hard way (see classifyJankGap and SUSPEND_MS below); the span
// instrument never did, and paid for it: `span rehydrate …` is the single loudest line in a real
// session log, and its samples run to twenty-plus SECONDS for a body that is a JSON parse and a
// merge. No such operation blocks the main thread that long — the webview was asleep or throttled
// across the await. Those samples are not just noise, they poison the instrument: sizing work off
// this span's timings has to be explicitly disclaimed today.
//
// The fix mirrors the jank monitor exactly. A span that cannot be main-thread work is RELABELLED,
// never dropped: it keeps a verdict in the message so the stream a human acts on stays clean while
// the raw sample survives for anyone who wants it.
//
// "NEVER DROPPED" IS A CLAIM ABOUT THE LEVEL, AND IT WAS FALSE FOR TWO RELEASES. This comment used
// to say relabelling meant moving to DEBUG — but `logger.ts` forwards to the log file only above
// debug in a shipped build (`debugForwardEnabled = import.meta.env.DEV`), so "relabelled" meant
// DELETED for every user whose log we actually read. The jank monitor had the identical bug and it
// cost a real diagnosis (see the note above SUSPEND_MS). `suspend` therefore emits at INFO here,
// which matters most for `perfSpan`: its body is SYNCHRONOUS and passes `hiddenOverlap = false`, so
// a span that clears the threshold could not have been throttled mid-flight and is far more likely a
// genuine main-thread block than a wake. Only `background` — which an async span can reach
// legitimately, and often — stays at debug.

/** A span at or above this is a resume, not work — reuses the jank monitor's threshold and its
 *  reasoning (see SUSPEND_MS). Named separately only so the forward reference reads clearly. */
const SPAN_SUSPEND_MS = 10_000;

/** The visibility state a span started in, compared against the live state when it ends. */
export interface VisibilityMark {
  /** `hiddenEpoch` at span start. */
  epoch: number;
  /** Whether the window was already hidden at span start. */
  hidden: boolean;
}

// Incremented every time this window goes hidden. Sampling `document.hidden` when a span ENDS is
// not enough on its own: a window hidden and re-shown mid-span reads "visible" at both ends while
// having spent the whole interval throttled. That is the same trap classifyJankGap documents, and
// a monotonic counter is what survives it.
let hiddenEpoch = 0;
let visibilityBound = false;

function bindVisibility(): void {
  if (visibilityBound || typeof document === "undefined") return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenEpoch += 1;
  });
}

/** Snapshot the visibility state for a span about to start. Binds the listener on first use, so a
 *  window that never times an async span (helper, capture) pays nothing. */
export function markVisibility(): VisibilityMark {
  bindVisibility();
  return { epoch: hiddenEpoch, hidden: typeof document !== "undefined" && document.hidden };
}

/** True when the interval since `mark` overlapped ANY hidden period: hidden at the start, hidden
 *  right now, or hidden and re-shown in between (the epoch moved). */
export function overlappedHidden(mark: VisibilityMark): boolean {
  if (mark.hidden) return true;
  if (typeof document !== "undefined" && document.hidden) return true;
  return hiddenEpoch !== mark.epoch;
}

/** How to account for one completed span. `report` is real main-thread cost (INFO); `suspend` and
 *  `background` are wall-clock the app did not spend working (DEBUG). */
export type SpanVerdict = "report" | "suspend" | "background";

/** Classify a completed span. Pure, so the attribution is testable without a clock or a DOM.
 *
 *  `suspend` outranks `background`: a span long enough to clear SPAN_SUSPEND_MS is a wake whether
 *  or not the window also went hidden, and that is the more specific claim about the duration. */
export function classifySpan(ms: number, hiddenOverlap: boolean): SpanVerdict {
  if (ms >= SPAN_SUSPEND_MS) return "suspend";
  if (hiddenOverlap) return "background";
  return "report";
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

/** Emit one completed span at the level its verdict earns. Below one frame nothing is emitted at
 *  all — that gate is unchanged and still runs first, so this adds no lines. */
function emitSpan(
  name: string,
  ms: number,
  hiddenOverlap: boolean,
  meta?: Record<string, unknown>,
): void {
  if (ms < SPAN_MIN_MS) return;
  const verdict = classifySpan(ms, hiddenOverlap);
  if (verdict === "report") {
    log.info("perf", `span ${name}`, { ms, ...meta });
    return;
  }
  // `suspend` is the SAME censor the jank monitor had, on the sibling instrument this file insists
  // must be kept in step — and it bites harder here. `perfSpan` is synchronous and passes
  // `hiddenOverlap = false`, so a synchronous body that cleared SPAN_SUSPEND_MS could not have been
  // throttled part-way through: it is far more likely a genuine main-thread block than a wake. That
  // is the same class of freeze the jank fix exists to surface, on the one instrument that NAMES the
  // operation — and it was being written at debug, which shipped builds discard. Info, always.
  //
  // `background` stays at debug: an async span may legitimately span a hidden interval, so those are
  // wall-clock the app did not spend working, and there are a lot of them.
  //
  // But note the ordering inside `classifySpan`: it tests the duration BEFORE `hiddenOverlap`, so a
  // long hidden interval never reaches the `background` verdict. An async span that merely awaits
  // across a >10s occlusion — a poll, an IPC round-trip, a rehydrate while the user is away — lands
  // here, in the promotion, not in the debug branch the paragraph above describes. Those are the
  // frequent legitimate ones, and without a discriminator they read in the log exactly like the 30s
  // synchronous block this promotion exists to preserve.
  //
  // So carry `hidden`, the way the sibling jank line does, and for the same stated reason: a reader
  // needs to be able to discount it. The alternative — letting `background` win past the threshold —
  // was rejected because it would re-censor the sync case, which is the whole point of the change.
  if (verdict === "suspend") {
    log.info("perf", `span ${name} (${verdict})`, {
      ms,
      ...(hiddenOverlap ? { hidden: true } : {}),
      ...meta,
    });
    return;
  }
  log.debug("perf", `span ${name} (${verdict})`, { ms, ...meta });
}

/** Time a synchronous operation and log if it took ≥ SPAN_MIN_MS. Returns fn()'s value; rethrows. */
export function perfSpan<T>(name: string, fn: () => T, meta?: Record<string, unknown>): T {
  const t0 = perfNow();
  try {
    return fn();
  } finally {
    const ms = round2(perfNow() - t0);
    // No hidden-window discount for a SYNCHRONOUS body: it never yields, so it cannot be
    // background-throttled part-way through. A slow sync span in a hidden window is genuine
    // main-thread work and keeps its INFO line. Only the suspend reclassification applies here
    // (the machine can still sleep mid-call), which is what `false` selects.
    emitSpan(name, ms, false, meta);
  }
}

/** Time an async operation end-to-end (await included) and log only if it took ≥ SPAN_MIN_MS.
 *  Elapsed time here spans arbitrary event-loop turns, so it is attributed (see classifySpan)
 *  before being reported as main-thread cost. */
export async function perfSpanAsync<T>(
  name: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  const t0 = perfNow();
  const vis = markVisibility();
  try {
    return await fn();
  } finally {
    const ms = round2(perfNow() - t0);
    emitSpan(name, ms, overlappedHidden(vis), meta);
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

/** How many components a stall line names. Three fits the line and covers the realistic case — one
 *  runaway component, occasionally a parent/child pair that thrash together. */
const STALL_RENDER_TOP_N = 3;

/** Shortest gap between two render baselines taken by the jank monitor. Bounds the monitor's own
 *  allocation to ~5 Maps/sec instead of one per frame. */
const RENDER_BASELINE_MIN_MS = 200;

/** Cumulative render counts collapsed to the COMPONENT, with the per-key tail dropped.
 *
 *  `renderStats` is keyed `"Component:key"` and the key half is an agent id or a path, so it can
 *  never reach the shared log — the same rule {@link openTraceKinds} follows. Collapsing here rather
 *  than at the call site means the caller has nothing sensitive to forget to strip.
 *
 *  A Map (not a Record) because the jank monitor holds one of these as a baseline across frames and
 *  only ever diffs it; there is no reason to pay for a prototype. */
export function renderTotalsByComponent(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, stat] of renderStats) {
    const sep = id.indexOf(":");
    // Defensive: a caller that passed an empty component would otherwise bucket under "".
    const component = sep > 0 ? id.slice(0, sep) : id;
    out.set(component, (out.get(component) ?? 0) + stat.count);
  }
  return out;
}

/** Components that rendered between two {@link renderTotalsByComponent} snapshots, busiest first,
 *  as `"AgentPane×42, Sidebar×7"` — or undefined when nothing rendered.
 *
 *  Pure and exported for its test. Only the top `topN` are named: the point is to finger the one or
 *  two components that burned the frame, and a full list would put a hundred names in a log line.
 *  A component present only in `after` counts its whole total (it mounted inside the window). */
export function renderBurst(
  before: Map<string, number>,
  after: Map<string, number>,
  topN = STALL_RENDER_TOP_N,
): string | undefined {
  const deltas: Array<[string, number]> = [];
  for (const [component, count] of after) {
    const delta = count - (before.get(component) ?? 0);
    if (delta > 0) deltas.push([component, delta]);
  }
  if (deltas.length === 0) return undefined;
  // Ties broken by name so the line is stable across runs — a log a human diffs should not reorder
  // for reasons that are really Map insertion order.
  deltas.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return deltas
    .slice(0, topN)
    .map(([component, n]) => (n > 1 ? `${component}×${n}` : component))
    .join(", ");
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

/** Drop every open keyed trace. `traces` is module-scoped and only ever emptied by perfEnd/perfCancel
 *  — which in the app means a mounted pane settling its own waterfall — so under test any earlier
 *  case that opened one (removeAgent's `close:<id>`, selectAgent's `switch:<id>`) leaks into
 *  {@link openTraceKinds} for the rest of the file. Reset in beforeEach when asserting on it. */
export function __resetTracesForTest(): void {
  traces.clear();
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
// MISCLASSIFYING IS ONLY CHEAP IF THE LOSER IS STILL RECORDED, AND FOR TWO RELEASES IT WAS NOT.
// This comment used to read "a resume is still recorded (at debug) with its duration, so a gap
// that lands on the wrong side of this line is relabeled, never lost." That was false in every
// shipped build. `logger.ts` forwards to the log file only above debug (`debugForwardEnabled` is
// `import.meta.env.DEV`), so "relabeled" meant DELETED for the users whose logs we actually read.
//
// The cost was a real diagnosis. On 2026-07-29 the app beachballed twice during a window resize and
// the user waited a full minute before force-quitting. The log for that day holds 750 `jank stall`
// lines whose maximum is 9866ms and whose p99 is 4520ms, with ZERO lines above 10000ms and ZERO
// `resume after suspend` lines all day. A distribution does not stop dead 134ms below a
// reclassification threshold on its own — that is a censored distribution, and the freeze that
// mattered was on the far side of the censor. The instrument could not report its own worst case.
//
// So the threshold still SORTS, but it no longer SILENCES: every gap past it is logged at info,
// with the same attribution the stall branch carries, at a level the shipped build keeps. Naming
// WHICH of the two causes it was is not this instrument's job — see the note above
// `startJankMonitor` on why, and `src-tauri/src/watchdog.rs` for the instrument that can.
//
// The span instrument applies the same threshold for the same reason — see SPAN_SUSPEND_MS. Keep
// the two in step: they are one claim ("nothing this app does on the main thread lasts 10s")
// measured by two instruments, not two independently tunable knobs.
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

// ── WHY THIS MODULE DOES NOT TRY TO NAME THE CAUSE OF A LONG GAP ───────────────────────────────
//
// The obvious next move here is a wall-vs-monotonic cross-check: `performance.now()` is monotonic
// and `Date.now()` is wall-clock, so if the wall ran further than the monotonic clock, time passed
// that this thread did not experience — a suspend — and if they agree, the thread lived through
// every millisecond, which is what a block looks like. It is a tidy idea and it does not work here,
// for a reason this file already records above: App Nap, display sleep and occlusion were producing
// ~166 WARNs a day claiming 10s+ FREEZES. Those warns exist because the pause was visible as a large
// gap in `performance.now()` — i.e. on this platform the monotonic clock keeps running through
// exactly the pauses we are trying to recognise. The two clocks would therefore agree in both cases
// and the check could only ever return one of its two answers. A classifier that structurally cannot
// return one of its values is not a conservative classifier, it is a vacuous one.
//
// So responsibility is split along the line of what each instrument can actually know:
//
//   • THIS module RECORDS. It sees a gap and reports it, with attribution, at a level the shipped
//     build keeps. It does not claim to know why, because from inside the blocked thread it cannot.
//   • The RUST WATCHDOG (`src-tauri/src/watchdog.rs`) ADJUDICATES. It runs off the main thread, so
//     it keeps ticking straight through a webview block and is itself frozen by a machine suspend.
//     It observes the difference directly instead of inferring it, and it is the one that WARNs.
//
// `wallMs` still rides along on the line below — as evidence for a reader, not as a verdict. It
// costs nothing and it is the measurement that would falsify the paragraph above: if a real suspend
// ever shows up with `wallMs` far exceeding `ms`, then the monotonic clock does freeze on some path
// after all, and a cross-check becomes worth building.

/** Start a requestAnimationFrame loop that logs any inter-frame gap exceeding `thresholdMs` — i.e.
 *  every time the main thread was blocked long enough to drop frames (the visible "freeze"). Gaps
 *  accrued while the window was hidden are dropped (rAF is paused then, so the gap measures
 *  backgrounded time, not a freeze), and gaps above `SUSPEND_MS` are logged as a resume rather than
 *  a stall (the machine was asleep). This is the single most useful instrument for "the app is
 *  slow": it catches EVERY stall, whatever the cause, so we can then correlate the timestamp against
 *  the spawn/switch/close/span/render lines. Idempotent; safe to call from multiple mounts.
 *
 *  `windowLabel` stamps every line with the webview it came from. The shell is single-window today,
 *  so every caller takes the "main" default and the field is a constant — it earns its place only
 *  once lines from more than one webview or process are read together: each monitor runs against its
 *  own rAF clock, so one wide freeze produces N near-identical warns a few hundred microseconds
 *  apart, differing only by a jitter in `ms`, which is indistinguishable from a single window
 *  double-logging and hides how wide the freeze really was. Pass the window's opaque Tauri label,
 *  never a project name or path — it must identify the webview without naming user content. Kept as
 *  a parameter rather than inlined because that is the cheaper half of the trade: a second webview
 *  then needs no change at any of the log sites below. */
export function startJankMonitor(thresholdMs = 150, windowLabel = "main"): void {
  if (jankRunning || typeof requestAnimationFrame !== "function") return;
  jankRunning = true;
  let last = perfNow();
  // The wall-clock companion to `last`, so a past-SUSPEND_MS gap can be measured on both clocks at
  // once and reported as `wallMs` alongside `ms`. Evidence for a reader, not a verdict — see the
  // note above this function for why nothing here tries to name the cause from the two clocks.
  let lastWall = Date.now();
  // Latched by the visibilitychange listener and cleared by the next tick that consumes it — see
  // classifyJankGap for why tick-time `document.hidden` is the wrong signal.
  let hiddenSinceLastTick = typeof document !== "undefined" && document.hidden;
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) hiddenSinceLastTick = true;
    });
  }
  log.info("perf", "jank monitor started", { thresholdMs, heapMb: heapMb(), win: windowLabel });
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
      win: windowLabel,
    });
    minorCount = 0;
    minorTotalMs = 0;
    minorMaxMs = 0;
  };
  // Render baseline for stall attribution: the counts as of the last healthy frame, so a severe
  // stall can be diffed against them (see the `rendered` field below). Refreshed on healthy frames
  // only, and at most every RENDER_BASELINE_MIN_MS — an unthrottled refresh would allocate a Map per
  // frame, which is a strange thing for a jank monitor to do. The cost of the throttle is that the
  // diff may include up to that much healthy time; at 200ms against a stall of 1s or more, the
  // handful of ordinary renders that adds does not change which component is on top.
  let renderBase = renderTotalsByComponent();
  let renderBaseAt = last;
  const tick = () => {
    const now = perfNow();
    const gap = now - last;
    last = now;
    const nowWall = Date.now();
    const wallGap = nowWall - lastWall;
    lastWall = nowWall;
    const wasHidden = hiddenSinceLastTick;
    const verdict = classifyJankGap(gap, thresholdMs, wasHidden);
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
    // THE OTHER DOOR THE LONG GAPS WERE ESCAPING THROUGH. `classifyJankGap` tests the hidden latch
    // BEFORE the suspend threshold, so a gap past SUSPEND_MS that also overlapped an occlusion is
    // "ignore" — recorded nowhere, at any level. That is not a hypothetical: queued
    // `visibilitychange` events dispatch when the main thread unblocks, ahead of the next rAF, so a
    // genuine long block that occludes the window on its way (a window resize or move — the exact
    // reported symptom) latches `hidden` and silences itself.
    //
    // Dropping it is right for an ordinary backgrounded gap, which is why the verdict stands. But at
    // this magnitude the cost of staying quiet is losing the only record of a freeze, so it is
    // reported with `hidden: true` for a reader to discount, rather than deleted.
    //
    // It carries `during`/`rendered` for the same reason the `resume` branch below does, and with
    // MORE at stake: this is the branch whose comment names the reported symptom outright, so it is
    // the one most likely to be a real freeze — and it was the only long-gap branch emitting no
    // attribution at all. A reader who found this line had the duration and nothing to chase.
    if (verdict === "ignore" && wasHidden && gap >= SUSPEND_MS) {
      const during = openTraceKinds();
      const rendered = renderBurst(renderBase, renderTotalsByComponent());
      log.info("perf", "long gap (window was hidden — may be a freeze that occluded)", {
        ms: Math.round(gap),
        wallMs: Math.round(wallGap),
        hidden: true,
        heapMb: heapMb(),
        win: windowLabel,
        ...(during ? { during } : {}),
        ...(rendered ? { rendered } : {}),
      });
    }
    if (verdict === "resume") {
      // PAST SUSPEND_MS. Probably a wake — but "probably" is exactly the word that lost us a
      // diagnosis when this branch logged at debug, which shipped builds discard. It is now always
      // recorded, and it carries the SAME attribution the severe-stall branch carries: if this was
      // in fact a blocked main thread, `during`/`rendered` are the only clue to what blocked it, and
      // they were being thrown away precisely for the longest freezes.
      const during = openTraceKinds();
      const rendered = renderBurst(renderBase, renderTotalsByComponent());
      // INFO, not debug, and never debug again — that one level is the whole bug. Not warn either:
      // the majority of these really are wakes, the watchdog is what raises the alarm when one is
      // not, and a warn per lid-close is the noise that got this branch demoted in the first place.
      // Info is the level that is both kept and quiet.
      log.info("perf", "long gap (suspend or main-thread block)", {
        ms: Math.round(gap),
        wallMs: Math.round(wallGap),
        heapMb: heapMb(),
        win: windowLabel,
        ...(during ? { during } : {}),
        ...(rendered ? { rendered } : {}),
      });
    } else if (verdict === "stall") {
      if (gap >= JANK_SEVERE_MS) {
        // `during` attributes the stall to whatever interaction was mid-flight (kinds only, no
        // keys). Only the severe branch carries it: a minor stall is reported as a coalesced
        // rollup covering many frames, so a single snapshot of what was open would be attributing
        // one window's worth of stalls to whatever happened to be in flight at flush time.
        const during = openTraceKinds();
        // `rendered` is what `during` cannot answer. An interaction trace only exists while someone
        // is driving the UI, so a stall from a background poll or a periodic timer reports no
        // `during` at all — which is the majority of them in a real session, and leaves a
        // once-a-minute second-long freeze with nothing in the line to chase. React work is the
        // usual body of such a freeze, and the render counters already tally it unconditionally
        // (see perfRender), so diffing them across the gap names the component for free.
        //
        // A CORRELATION HINT, exactly as `during` is: these components rendered inside the frozen
        // frame, which is not proof they froze it — a stall with an unrelated cause still catches
        // whatever rendered alongside it.
        const rendered = renderBurst(renderBase, renderTotalsByComponent());
        log.warn("perf", "jank stall", {
          ms: Math.round(gap),
          heapMb: heapMb(),
          win: windowLabel,
          ...(during ? { during } : {}),
          ...(rendered ? { rendered } : {}),
        });
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
    // Close the attribution window. One condition covers both jobs it has: a healthy stretch past
    // the throttle gets a fresh baseline, and the tick that just REPORTED a stall re-baselines here
    // too — its own gap is necessarily larger than the throttle, so the next stall is diffed from
    // this frame rather than re-reporting renders already attributed to this one.
    if (now - renderBaseAt >= RENDER_BASELINE_MIN_MS) {
      renderBase = renderTotalsByComponent();
      renderBaseAt = now;
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
            log.warn("perf", "longtask", { ms: Math.round(e.duration), name: e.name, win: windowLabel });
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
