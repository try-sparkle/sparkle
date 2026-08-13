/** The renderer half of the per-request IPC timeline (bead `sparkle-i7ryx`) — a drop-in `invoke`
 *  that stamps when a request left and when its answer came back.
 *
 *  ── WHY ─────────────────────────────────────────────────────────────────────────────────────
 *  On 2026-08-13 typing took 3-10 seconds to appear, and a `sample(1)` of the host reported the
 *  main thread 91% IDLE — 3962 of 4354 samples parked in `mach_msg`. That is not a clean bill of
 *  health, it is a structural blind spot: a CPU profile cannot see a hang that lives in WAITING.
 *  `watchdog.rs` had already auto-captured the same episode three times that morning and none of
 *  the captures could explain it.
 *
 *  Rust (`ipc_ring.rs` / `ipc_trace.rs`) records when a request began and finished being HANDLED.
 *  This file records the two ends only the renderer can see. Subtracting gives the three legs that
 *  blame three different things — QUEUE (contention before the work starts), HANDLER (a slow
 *  backend call), RETURN (the renderer itself is the bottleneck). A single "took 4200ms" number
 *  would have left us exactly where the sample did.
 *
 *  ── THIS MODULE IMPORTS NOTHING BUT `@tauri-apps/api/core`, AND THAT IS LOAD-BEARING ────────
 *  Not a style preference — three separate properties depend on it:
 *
 *    1. `logger.ts` ships every log line through `invoke("frontend_log")` and is the app's highest
 *       volume caller (~90-145K/day). If this module could reach `log`, then log → invoke → record
 *       → log would close into a recursion. With no logger in scope it CANNOT, so `logger.ts` is
 *       free to route through the wrapper — and it must, because a 60-second window that omits the
 *       dominant command characterises everything except the thing that matters.
 *    2. No import cycle with `logger.ts`, which the above would otherwise create.
 *    3. 144 test files `vi.mock("@tauri-apps/api/core")` wholesale. Importing the real module means
 *       we re-enter their mock rather than bypassing it, so the wrapper is transparent to them.
 *
 *  `ipc_ts_imports_nothing_but_the_tauri_core_invoke` in the test file guards this against a future
 *  edit. It is a source scan precisely because no type can express "do not grow a second import".
 *
 *  ── NOTHING HERE IS LOGGED, AND NOTHING IS FORMATTED ────────────────────────────────────────
 *  Every logged line pays `support::redact_secrets` — seven regex passes plus allocations — twice
 *  over, once per tracing sink (`redacting_writer.rs`, bead `sparkle-zllfb`). A per-request log line
 *  would be that cost on the very thread we are trying to unblock. Rows are integers in
 *  preallocated typed arrays; formatting happens once, in `serializeIpcRing`, at dump time.
 *
 *  Measured on this machine (arm64, 3M iterations, warmed): `performance.now()` 142.7ns, a
 *  typed-array slot write 36.4ns, a full record ~334ns. The obvious alternative — an object literal
 *  with a template-string id, pushed and shifted — measured 1092ns, 3.3x worse. Hence the columns.
 */

import { invoke as rawInvoke } from "@tauri-apps/api/core";

/** Re-declared rather than imported. `import type` erases at runtime and so would not actually
 *  break the leaf rule — but it would make the rule unenforceable by the source scan, which cannot
 *  tell an erased import from a live one. Two small type aliases are the cheaper half of that
 *  trade. */
type InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array;
interface InvokeOptions {
  headers: HeadersInit;
}

/** Slots retained. Power of two so a slot index is a mask rather than a modulo.
 *
 *  Capacity is in REQUESTS, not seconds. At a quiet rate this holds far more than the 60s the bead
 *  asks for; during a burst it holds less. That is why `serializeIpcRing` reports the span it
 *  ACTUALLY covered instead of asserting a window it may not have. */
const DEFAULT_CAPACITY = 16_384;

const FLAG_PENDING = 1 << 0;
const FLAG_REJECTED = 1 << 1;
const FLAG_ARG_EXACT = 1 << 2;
const FLAG_RES_EXACT = 1 << 3;

/** One exact `JSON.stringify` per this many requests — see `estimateBytes`. Power of two minus one
 *  so the test is a mask on the sequence, which spreads the sample evenly across commands without
 *  a second counter. */
const EXACT_SAMPLE_MASK = 63;

/** A command name that reaches the intern table also reaches a file a human is asked to share, so
 *  only names that look like Tauri commands are stored verbatim. Anything else becomes a fixed
 *  sentinel. This also bounds the table: the name comes from the caller, so an unbounded name space
 *  is reachable from application code. */
const COMMAND_NAME = /^[a-z0-9_]+$|^plugin:[a-z0-9_-]+\|[a-z0-9_]+$/;
const INVALID_NAME = "<invalid>";
const MAX_NAMES = 1024;

let armed = false;
let capacity = 0;
let mask = 0;

// Columns. Allocated once at arm time and never resized.
let colT1: Float64Array = new Float64Array(0);
let colRtt: Float32Array = new Float32Array(0);
let colCmd: Uint16Array = new Uint16Array(0);
let colCorr: Uint32Array = new Uint32Array(0);
let colArgB: Uint32Array = new Uint32Array(0);
let colResB: Uint32Array = new Uint32Array(0);
let colFlags: Uint8Array = new Uint8Array(0);

let nextSeq = 0;
let written = 0;

const names: string[] = [];
const nameIds = new Map<string, number>();

let epochsMinted = 0;

/** Names this run of the ring, so a dump can be told apart from a later one after a webview reload.
 *  Same construction and the same non-secret status as `conciergeEventLog.mintEpoch`. */
function mintEpoch(): string {
  epochsMinted += 1;
  const clock = (Date.now() % 46_656).toString(36).padStart(3, "0");
  const noise = Math.floor(Math.random() * 1_296)
    .toString(36)
    .padStart(2, "0");
  return `${clock}${noise}${epochsMinted.toString(36)}`;
}

let epoch = mintEpoch();

export function ipcRingEpoch(): string {
  return epoch;
}

export function isIpcTimingArmed(): boolean {
  return armed;
}

export function armIpcTiming(cap: number = DEFAULT_CAPACITY): void {
  const size = 1 << Math.ceil(Math.log2(Math.max(2, cap)));
  capacity = size;
  mask = size - 1;
  colT1 = new Float64Array(size);
  colRtt = new Float32Array(size);
  colCmd = new Uint16Array(size);
  colCorr = new Uint32Array(size);
  colArgB = new Uint32Array(size);
  colResB = new Uint32Array(size);
  colFlags = new Uint8Array(size);
  nextSeq = 0;
  written = 0;
  epoch = mintEpoch();
  armed = true;
}

export function disarmIpcTiming(): void {
  armed = false;
}

/** Test-only: drop the ring and the intern table so suites do not leak rows into each other. */
export function __resetIpcRingForTest(): void {
  armed = false;
  capacity = 0;
  mask = 0;
  nextSeq = 0;
  written = 0;
  names.length = 0;
  nameIds.clear();
}

function intern(cmd: string): number {
  const key = COMMAND_NAME.test(cmd) ? cmd : INVALID_NAME;
  const existing = nameIds.get(key);
  if (existing !== undefined) return existing;
  if (names.length >= MAX_NAMES) {
    const fallback = nameIds.get(INVALID_NAME);
    if (fallback !== undefined) return fallback;
  }
  const id = names.length;
  names.push(key);
  nameIds.set(key, id);
  return id;
}

/** A cheap, allocation-free, bounded size estimate.
 *
 *  `JSON.stringify(args).length` here would DOUBLE a cost Tauri already pays in full microseconds
 *  later, on every single invoke — for a `bd list` response that is megabytes. So the common path
 *  walks at most `MAX_KEYS` own enumerable keys one level deep and charges a flat 8 bytes for
 *  anything that is not a string.
 *
 *  It therefore systematically UNDER-counts nested objects and arrays, which is why one request in
 *  64 measures the truth exactly (`FLAG_ARG_EXACT` / `FLAG_RES_EXACT`) — the ratio between the two
 *  is what makes the estimated column readable rather than decorative. Sampling costs one stringify
 *  per 64 invokes: ~1.5% of a cost already paid 100% of the time by the transport underneath us.
 */
function estimateBytes(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  if (typeof v !== "object") return 8;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  let total = 0;
  let keys = 0;
  // `for...in` rather than Object.keys: Object.keys allocates an array on every call, and this
  // runs on every invoke.
  for (const k in v as Record<string, unknown>) {
    if (++keys > 16) break;
    total += k.length + 2;
    const child = (v as Record<string, unknown>)[k];
    total += typeof child === "string" ? child.length : 8;
  }
  return total;
}

function exactBytes(v: unknown): number {
  try {
    return v === undefined ? 0 : JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** The one `invoke` the app calls.
 *
 *  DISARMED, this forwards the caller's EXACT argument list — three branches rather than one
 *  always-three-argument call. That is not pedantry: 170 assertions in this suite are
 *  `expect(invoke).toHaveBeenCalledWith("cmd", {...})`, which compares the argument ARRAY, and a
 *  trailing `undefined` fails every one of them. Preserving arity is what lets ~106 files change a
 *  single import line with no test file touched at all.
 */
export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (!armed) {
    if (options !== undefined) return rawInvoke<T>(cmd, args as InvokeArgs, options);
    if (args !== undefined) return rawInvoke<T>(cmd, args);
    return rawInvoke<T>(cmd);
  }

  const seq = (nextSeq = (nextSeq + 1) >>> 0);
  const slot = seq & mask;
  const exact = (seq & EXACT_SAMPLE_MASK) === 0;

  colT1[slot] = performance.now();
  colCmd[slot] = intern(cmd);
  colCorr[slot] = seq;
  colRtt[slot] = NaN;
  colArgB[slot] = exact ? exactBytes(args) : estimateBytes(args);
  colResB[slot] = 0;
  colFlags[slot] = FLAG_PENDING | (exact ? FLAG_ARG_EXACT : 0);
  written += 1;

  // A FRESH object per call, deliberately. Reusing one mutable header object looks safe because
  // `new Headers()` and the body stringify both run synchronously inside `sendIpcMessage` — but on
  // the one-time custom-protocol fallback Tauri re-calls `sendIpcMessage` ASYNCHRONOUSLY from a
  // rejection handler, still holding this same object. An aliased header yields a correlation id
  // that joins to the wrong Rust row, which reads as plausible data rather than as a bug.
  const merged: Record<string, string> = { "x-": epoch + "." + seq };
  if (options?.headers) {
    const h = options.headers;
    if (Array.isArray(h)) for (const [k, v] of h) merged[k] = v;
    else if (typeof Headers !== "undefined" && h instanceof Headers) h.forEach((v, k) => (merged[k] = v));
    else Object.assign(merged, h as Record<string, string>);
  }

  // The generation check on settle. A slow invoke whose slot has since been recycled would
  // otherwise write its completion onto a STRANGER'S row — a corruption that reads as real data
  // rather than as missing data.
  const settle = (resBytes: number, rejected: boolean): void => {
    if (colCorr[slot] !== seq) return;
    colRtt[slot] = performance.now() - (colT1[slot] ?? 0);
    colResB[slot] = resBytes;
    colFlags[slot] = ((colFlags[slot] ?? 0) & ~FLAG_PENDING) | (rejected ? FLAG_REJECTED : 0);
  };

  return rawInvoke<T>(cmd, args as InvokeArgs, { headers: merged }).then(
    (value) => {
      const bytes = exact ? exactBytes(value) : estimateBytes(value);
      settle(bytes, false);
      if (exact && colCorr[slot] === seq) colFlags[slot] = (colFlags[slot] ?? 0) | FLAG_RES_EXACT;
      return value;
    },
    (err) => {
      settle(0, true);
      throw err;
    },
  );
}

export interface IpcRingDump {
  v: 1;
  kind: "-ring";
  side: "renderer";
  reason: string;
  epoch: string;
  capacity: number;
  /** Rows retained. Less than `written` once the ring has wrapped. */
  count: number;
  /** Rows evicted by wrapping. Loss is reported, never hidden. */
  evicted: number;
  /** The span the retained rows ACTUALLY cover, so an under-covering window is a stated fact
   *  rather than a silent truncation. */
  spanMs: number;
  /** Observed granularity of `performance.now()`, MEASURED not assumed — WKWebView coarsens it for
   *  Spectre and the exact figure is not something to assert in a comment. Carried in the artifact
   *  so a reader can see when the sub-millisecond columns are noise. */
  clockGranularityMs: number;
  cmds: string[];
  corr: number[];
  cmd: number[];
  t1Us: number[];
  /** `null` = never settled. During a hang these are the most diagnostic rows in the file: requests
   *  issued into a wedge that never came back. */
  rttUs: (number | null)[];
  argB: number[];
  resB: number[];
  flags: number[];
}

/** Spin until `performance.now()` changes; the smallest non-zero delta is the platform's clamp. */
function measureClockGranularityMs(samples = 32): number {
  let min = Infinity;
  for (let i = 0; i < samples; i++) {
    const a = performance.now();
    let b = a;
    // Bounded so a pathological clock cannot hang the dump.
    for (let spins = 0; spins < 100_000 && b === a; spins++) b = performance.now();
    const d = b - a;
    if (d > 0 && d < min) min = d;
  }
  return min === Infinity ? 0 : min;
}

/** Render the ring. Formatting — and the only allocation of any size in this module — happens HERE
 *  and nowhere else. Columnar (one array per field, not an array of row objects) because it is a
 *  direct transcription of the layout above and roughly 3-5x smaller on the wire. */
export function serializeIpcRing(reason: string): string {
  const count = Math.min(written, capacity);
  const start = written - count;
  const corr: number[] = [];
  const cmd: number[] = [];
  const t1Us: number[] = [];
  const rttUs: (number | null)[] = [];
  const argB: number[] = [];
  const resB: number[] = [];
  const flags: number[] = [];

  let base = 0;
  // `noUncheckedIndexedAccess` types every typed-array read as `number | undefined`. The indices
  // here are all masked into range, so `?? 0` is unreachable in practice — but it is written rather
  // than asserted away so a future off-by-one degrades to a zero row instead of a thrown dump. A
  // diagnostic that crashes while being collected is worse than one that is slightly wrong.
  for (let i = 0; i < count; i++) {
    const slot = (start + i + 1) & mask;
    const rid = colCorr[slot] ?? 0;
    if (rid === 0) continue;
    const t1 = colT1[slot] ?? 0;
    if (base === 0) base = t1;
    corr.push(rid);
    cmd.push(colCmd[slot] ?? 0);
    // Integer microseconds from the first retained row: a 9-character float becomes a 5-character
    // int, and microsecond resolution is far below anything this instrument can honestly claim.
    t1Us.push(Math.round((t1 - base) * 1000));
    const r = colRtt[slot];
    rttUs.push(r === undefined || Number.isNaN(r) ? null : Math.round(r * 1000));
    argB.push(colArgB[slot] ?? 0);
    resB.push(colResB[slot] ?? 0);
    flags.push(colFlags[slot] ?? 0);
  }

  const first = t1Us[0] ?? 0;
  const last = t1Us[t1Us.length - 1] ?? 0;
  const spanMs = t1Us.length > 1 ? (last - first) / 1000 : 0;
  const dump: IpcRingDump = {
    v: 1,
    kind: "-ring",
    side: "renderer",
    reason,
    epoch,
    capacity,
    count: corr.length,
    evicted: Math.max(0, written - capacity),
    spanMs,
    clockGranularityMs: measureClockGranularityMs(),
    cmds: names.slice(),
    corr,
    cmd,
    t1Us,
    rttUs,
    argB,
    resB,
    flags,
  };
  return JSON.stringify(dump);
}
