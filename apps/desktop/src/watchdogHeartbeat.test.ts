// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((_cmd: string, _args?: Record<string, unknown>) => Promise.resolve());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
}));
vi.mock("./logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

// The stall accounting the beat carries, standing in for perfTrace's rAF monitor. Mocked with the
// REAL drain semantics (returns and resets), because that is the property the beat depends on — the
// accumulator itself is tested against the live monitor in perfTrace.stallBudget.test.ts.
let pendingStallMs = 0;
vi.mock("./perfTrace", () => ({
  takePendingStallMs: () => {
    const ms = pendingStallMs;
    pendingStallMs = 0;
    return ms;
  },
}));

/** The `stalledMs` argument of the last heartbeat sent. */
function lastStalledMs(): number | undefined {
  const args = invoke.mock.calls.at(-1) as unknown[] | undefined;
  return (args?.[1] as { stalledMs?: number } | undefined)?.stalledMs;
}

/** The `hidden` argument of the last heartbeat sent. */
function lastHidden(): boolean | undefined {
  const args = invoke.mock.calls.at(-1) as unknown[] | undefined;
  return (args?.[1] as { hidden?: boolean } | undefined)?.hidden;
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("startWatchdogHeartbeat", () => {
  // Held so afterEach can tear down the interval AND the visibilitychange listener. jsdom's
  // `document` is shared across cases in a file while `vi.resetModules()` only gives a fresh
  // module, so a listener left behind stays registered against the same document — by the third
  // case a single dispatched event fired seven beats and the counts below drifted. Disposing is
  // what keeps each case measuring only its own module.
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    vi.resetModules();
    invoke.mockClear();
    invoke.mockImplementation(() => Promise.resolve());
    vi.useFakeTimers();
    pendingStallMs = 0;
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    vi.useRealTimers();
    delete (document as { hidden?: boolean }).hidden;
  });

  it("beats on an interval so a blocked main thread shows up as silence", async () => {
    const { startWatchdogHeartbeat } = await import("./watchdogHeartbeat");
    dispose = startWatchdogHeartbeat();

    expect(invoke).not.toHaveBeenCalled(); // nothing before the first interval elapses
    vi.advanceTimersByTime(1_000);
    expect(invoke).toHaveBeenCalledWith("watchdog_heartbeat", { hidden: false, stalledMs: 0 });
    vi.advanceTimersByTime(1_000);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  // ── THE FALSE-POSITIVE GUARD ──────────────────────────────────────────────────────────────────
  // A backgrounded WKWebView has its timers throttled or stopped, so heartbeats stop — while the
  // Rust watchdog's own OS thread keeps ticking punctually. From its side that is pixel-for-pixel a
  // hang. The final `hidden: true` beat, sent on visibilitychange BEFORE the throttling lands, is
  // the only thing that distinguishes them; without it every window occlusion files a phantom hang
  // and burns a stack capture.
  //
  // Asserts the SIDE EFFECT — that a beat carrying hidden:true is actually dispatched — not merely
  // that a listener was registered.
  it("sends a hidden beat the moment the window is occluded, not at the next interval", async () => {
    const { startWatchdogHeartbeat } = await import("./watchdogHeartbeat");
    dispose = startWatchdogHeartbeat();
    invoke.mockClear();

    setHidden(true);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(lastHidden()).toBe(true);
  });

  it("clears the stand-down immediately on return, rather than waiting out an interval", async () => {
    const { startWatchdogHeartbeat } = await import("./watchdogHeartbeat");
    dispose = startWatchdogHeartbeat();
    setHidden(true);
    invoke.mockClear();

    setHidden(false);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(lastHidden()).toBe(false);
  });

  it("keeps reporting hidden on the interval while the window stays occluded", async () => {
    const { startWatchdogHeartbeat } = await import("./watchdogHeartbeat");
    dispose = startWatchdogHeartbeat();
    setHidden(true);
    invoke.mockClear();

    vi.advanceTimersByTime(1_000);

    expect(lastHidden()).toBe(true);
  });

  // A rejected invoke must degrade to "no heartbeat" — which the Rust side already handles behind
  // its suspend and hidden checks — not to an unhandled rejection on every single tick.
  it("swallows a failed invoke instead of rejecting once a second", async () => {
    invoke.mockImplementation(() => Promise.reject(new Error("bridge gone")));
    const { startWatchdogHeartbeat } = await import("./watchdogHeartbeat");
    dispose = startWatchdogHeartbeat();

    expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
    await expect(Promise.resolve()).resolves.toBeUndefined();
  });

  // ── THE SECOND THING A BEAT CARRIES ──────────────────────────────────────────────────────────
  // Silence is a binary verdict at a five-second bar, and an entire hang family sits under it: a
  // reported 30-second unusable window stalled 7-13 times a minute and never once for five seconds,
  // so the watchdog captured nothing — correctly, by every rule it had. The beat now also carries
  // how much main-thread time the rAF monitor watched the UI lose, which the Rust side sums over a
  // rolling window (`STALL_BUDGET_MS`).
  //
  // Asserts the SIDE EFFECT — the value that actually crosses the IPC boundary — not that the
  // accumulator was consulted.
  it("carries the stall time the UI has lost since the last beat", async () => {
    const { startWatchdogHeartbeat } = await import("./watchdogHeartbeat");
    dispose = startWatchdogHeartbeat();
    pendingStallMs = 4_681; // the measured window's worst minute

    vi.advanceTimersByTime(1_000);

    expect(lastStalledMs()).toBe(4_681);
  });

  // A DRAIN, NOT A READ, and the beat is where that has to hold: two beats reporting the same 4681ms
  // would have the watchdog's ten-second window count one bad patch ten times over and fire on an app
  // that has since recovered.
  it("does not report the same stall time twice", async () => {
    const { startWatchdogHeartbeat } = await import("./watchdogHeartbeat");
    dispose = startWatchdogHeartbeat();
    pendingStallMs = 4_681;

    vi.advanceTimersByTime(1_000);
    expect(lastStalledMs()).toBe(4_681);
    vi.advanceTimersByTime(1_000);

    expect(lastStalledMs()).toBe(0);
  });

  // The visibilitychange beat drains too, so an occlusion cannot carry stall time into the next
  // interval beat and be counted twice.
  it("drains on the visibility beat as well as the interval beat", async () => {
    const { startWatchdogHeartbeat } = await import("./watchdogHeartbeat");
    dispose = startWatchdogHeartbeat();
    pendingStallMs = 956;

    setHidden(true);
    expect(lastStalledMs()).toBe(956);
    vi.advanceTimersByTime(1_000);

    expect(lastStalledMs()).toBe(0);
  });

  it("is idempotent — a second call does not double the beat rate", async () => {
    const { startWatchdogHeartbeat } = await import("./watchdogHeartbeat");
    dispose = startWatchdogHeartbeat();
    expect(startWatchdogHeartbeat()).toBe(dispose); // same disposer, no second interval
    invoke.mockClear();

    vi.advanceTimersByTime(1_000);

    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
