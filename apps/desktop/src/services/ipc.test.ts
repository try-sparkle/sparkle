import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetIpcRingForTest,
  armIpcTiming,
  disarmIpcTiming,
  invoke,
  ipcRingEpoch,
  isIpcTimingArmed,
  serializeIpcRing,
  type IpcRingDump,
} from "./ipc";

const { rawInvoke } = vi.hoisted(() => ({ rawInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: rawInvoke }));

function dump(): IpcRingDump {
  return JSON.parse(serializeIpcRing("test")) as IpcRingDump;
}

/** Index of the row for `name`, or -1. */
function rowFor(d: IpcRingDump, name: string): number {
  const id = d.cmds.indexOf(name);
  if (id < 0) return -1;
  return d.cmd.indexOf(id);
}

/** Assert a row exists and return the fields a test wants, already narrowed. Keeping the narrowing
 *  here rather than at each call site is what stops the assertions below drowning in `!`. */
function requireRow(d: IpcRingDump, name: string): { rttUs: number | null; flags: number } {
  const i = rowFor(d, name);
  expect(i, `expected a recorded row for ${name}`).toBeGreaterThanOrEqual(0);
  return { rttUs: d.rttUs[i] ?? null, flags: d.flags[i] ?? 0 };
}

beforeEach(() => {
  rawInvoke.mockReset();
  __resetIpcRingForTest();
});

describe("the disarmed wrapper", () => {
  /** RED IF: the three arity branches are collapsed into one always-3-argument call.
   *
   *  This is the cheapest possible test and it guards the most expensive possible mistake. 170
   *  assertions across 144 suites are `toHaveBeenCalledWith(...)`, which compares the argument
   *  ARRAY — a trailing `undefined` fails all of them, and the failure would show up as ~170
   *  unrelated-looking test breakages in the codemod PR rather than here. */
  it("forwards the caller's exact argument list", async () => {
    rawInvoke.mockResolvedValue("ok");
    expect(isIpcTimingArmed()).toBe(false);

    await invoke("one_arg");
    expect(rawInvoke).toHaveBeenLastCalledWith("one_arg");

    await invoke("two_args", { a: 1 });
    expect(rawInvoke).toHaveBeenLastCalledWith("two_args", { a: 1 });

    const opts = { headers: { z: "1" } };
    await invoke("three_args", { a: 1 }, opts);
    expect(rawInvoke).toHaveBeenLastCalledWith("three_args", { a: 1 }, opts);
  });

  /** RED IF: rows are recorded while disarmed. A disarmed wrapper must cost a boolean read and
   *  nothing else — asserting the ring is empty is what proves no column was touched. */
  it("records nothing", async () => {
    rawInvoke.mockResolvedValue("ok");
    await invoke("ignored");
    armIpcTiming(8);
    expect(dump().count).toBe(0);
  });
});

describe("the armed ring", () => {
  beforeEach(() => armIpcTiming(8));

  /** RED IF: t4 stops being stamped (someone drops the `.then`), or t1 moves after the await.
   *
   *  Asserts a real elapsed DURATION rather than "a row exists" — a row existing was already true
   *  the moment the request was issued, so it would pass against a wrapper whose completion half
   *  is entirely broken. That is the vacuous-test shape AGENTS.md calls the #1 fleet-wide finding. */
  it("records a settled request's round trip", async () => {
    let release: (v: string) => void = () => {};
    rawInvoke.mockReturnValue(new Promise<string>((r) => (release = r)));

    const p = invoke<string>("slow_cmd", { a: 1 });
    await new Promise((r) => setTimeout(r, 25));
    release("done");
    await p;

    const { rttUs } = requireRow(dump(), "slow_cmd");
    expect(rttUs).not.toBeNull();
    expect(rttUs as number).toBeGreaterThan(15_000); // ~25ms in microseconds
  });

  /** RED IF: rows are written on completion instead of at issue.
   *
   *  THE most important test here. A completion-time ring produces an EMPTY dump for exactly the
   *  hang it exists to diagnose — during a wedge nothing completes, so nothing would ever be
   *  recorded. A pending row with a null rtt is the signal: a request issued into a wedge that
   *  never came back. */
  it("keeps an unsettled request as a pending row with no round trip", () => {
    rawInvoke.mockReturnValue(new Promise(() => {})); // never settles
    void invoke("never_returns");

    const { rttUs, flags } = requireRow(dump(), "never_returns");
    expect(rttUs).toBeNull();
    expect(flags & 1).toBe(1); // FLAG_PENDING
  });

  /** RED IF: a rejected invoke is dropped instead of recorded, or stops rethrowing.
   *
   *  A failing command is a latency signal too, and swallowing the rejection would be a
   *  correctness bug in the wrapper far worse than a missing measurement. */
  it("records a rejected request and still rethrows", async () => {
    rawInvoke.mockRejectedValue(new Error("boom"));
    await expect(invoke("fails")).rejects.toThrow("boom");

    const { rttUs, flags } = requireRow(dump(), "fails");
    expect(flags & 2).toBe(2); // FLAG_REJECTED
    expect(rttUs).not.toBeNull();
  });

  /** RED IF: the header name, the id format, or the seq/header pairing drifts.
   *
   *  Each of those produces a dump that LOOKS correct and joins to zero Rust rows — a silent
   *  failure of the whole four-point design, since the correlation id is the only join key. */
  it("sends a correlation header that matches the recorded row", async () => {
    rawInvoke.mockResolvedValue("ok");
    await invoke("joined_cmd");

    const opts = rawInvoke.mock.calls.at(-1)![2] as { headers: Record<string, string> };
    const header = opts.headers["x-"];
    expect(header).toBeDefined();

    const [ep, seqText] = (header as string).split(".");
    expect(ep).toBe(ipcRingEpoch());

    const d = dump();
    const i = rowFor(d, "joined_cmd");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(d.corr[i]).toBe(Number(seqText));
  });

  /** RED IF: caller-supplied headers are clobbered by ours. Callers can legitimately pass headers,
   *  and silently dropping them would be a behaviour regression introduced by an instrument. */
  it("merges rather than replaces caller headers", async () => {
    rawInvoke.mockResolvedValue("ok");
    await invoke("with_headers", undefined, { headers: { "x-caller": "kept" } });

    const opts = rawInvoke.mock.calls.at(-1)![2] as { headers: Record<string, string> };
    expect(opts.headers["x-caller"]).toBe("kept");
    expect(opts.headers["x-"]).toBeDefined();
  });

  /** RED IF: the wrap arithmetic is wrong, or the eviction count is missing.
   *
   *  A ring that silently under-reports reads as "these were all the requests", which is exactly
   *  the wrong conclusion to hand someone diagnosing a burst. */
  it("overwrites oldest-first and reports how many rows it dropped", async () => {
    rawInvoke.mockResolvedValue("ok");
    for (let i = 0; i < 12; i++) await invoke("flood");

    const d = dump();
    expect(d.capacity).toBe(8);
    expect(d.count).toBe(8);
    expect(d.evicted).toBe(4);
    expect(Math.min(...d.corr)).toBeGreaterThan(1); // the earliest requests are gone, not the newest
  });

  /** RED IF: the `colCorr[slot] === seq` generation guard in `settle` is removed.
   *
   *  A slow command can outlive its slot once the ring wraps underneath it. Without the guard its
   *  late completion stamps a STRANGER'S row — inventing a fast round trip for a request that is
   *  still running, and losing the slow one. The corruption reads as plausible data, which is why
   *  it needs a test rather than review. */
  it("discards a late completion whose slot was recycled", async () => {
    let release: (v: string) => void = () => {};
    rawInvoke.mockReturnValueOnce(new Promise<string>((r) => (release = r)));
    const stale = invoke<string>("victim");

    rawInvoke.mockResolvedValue("ok");
    for (let i = 0; i < 8; i++) await invoke("usurper"); // wrap the whole ring

    release("late");
    await stale;

    const d = dump();
    expect(rowFor(d, "victim")).toBe(-1);
    // Every retained row belongs to the usurper and none carries the victim's late settle.
    const usurperId = d.cmds.indexOf("usurper");
    expect(d.cmd.every((c) => c === usurperId)).toBe(true);
  });

  /** RED IF: the command-name shape guard is dropped.
   *
   *  The intern table is keyed by whatever string a caller passes and ends up in a file the app
   *  invites the user to share, so caller text must not reach it verbatim. */
  it("interns a malformed command name as a sentinel and stays valid JSON", async () => {
    rawInvoke.mockResolvedValue("ok");
    await invoke('bad"\n\u0000name');

    const text = serializeIpcRing("test");
    expect(() => JSON.parse(text)).not.toThrow();
    const d = JSON.parse(text) as IpcRingDump;
    expect(d.cmds).toContain("<invalid>");
    expect(d.cmds.some((n) => n.includes('bad"'))).toBe(false);
  });

  /** RED IF: the dump starts claiming a window it does not have.
   *
   *  Capacity is in requests, not seconds, so the honest artifact reports the span it actually
   *  covered. Silent truncation reads as "this is the whole minute" when it is not. */
  it("reports the span it actually covers", async () => {
    rawInvoke.mockResolvedValue("ok");
    await invoke("a");
    await new Promise((r) => setTimeout(r, 20));
    await invoke("b");

    const d = dump();
    expect(d.spanMs).toBeGreaterThan(10);
  });
});

/** RED IF: anyone adds a second import to `ipc.ts`.
 *
 *  This test IS the recursion guard. `logger.ts` routes `frontend_log` through this wrapper, so if
 *  this module could ever reach `log`, then log -> invoke -> record -> log would close into an
 *  infinite recursion at the app's highest-volume call site. No type can express "do not grow an
 *  import", so it is a source scan.
 *
 *  It is also what lets the wrapper stay transparent to the 144 suites that mock
 *  `@tauri-apps/api/core` wholesale. */
it("ipc.ts imports nothing but the tauri core invoke", () => {
  const src = readFileSync(fileURLToPath(new URL("./ipc.ts", import.meta.url)), "utf8");
  const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  expect(imports).toEqual(["@tauri-apps/api/core"]);
});

/** RED IF: the disarm default flips. Under jsdom the ring must start disarmed, or ~37 suites that
 *  stub `__TAURI_INTERNALS__` would start recording rows and paying for headers they never asked
 *  for. */
it("starts disarmed", () => {
  __resetIpcRingForTest();
  expect(isIpcTimingArmed()).toBe(false);
  disarmIpcTiming();
  expect(isIpcTimingArmed()).toBe(false);
});
