import { describe, it, expect, vi } from "vitest";
import {
  createCloudDictationMeter,
  openMeteredCloudWindow,
  minuteDebitCents,
  type CloudMeterDeps,
  type CloudDictationMeter,
} from "./cloudDictationMeter";
import { CLOUD_DICTATION_CENTS_PER_MIN } from "./creditPricing";
import type { ConsumeResult } from "./credits";

const okResult: ConsumeResult = { ok: true, balanceAfterCents: 100, ledgerId: "l1" };
const brokeResult: ConsumeResult = { ok: false, balanceCents: 0 };

/** A controllable fake interval: capture the tick callback so the test can fire minutes by hand. */
function fakeTimer() {
  let cb: (() => void) | null = null;
  let cleared = false;
  return {
    setInterval: ((fn: () => void) => {
      cb = fn;
      return 1;
    }) as CloudMeterDeps["setInterval"],
    clearInterval: ((_h: number) => {
      cleared = true;
    }) as CloudMeterDeps["clearInterval"],
    tick: () => cb?.(),
    get cleared() {
      return cleared;
    },
  };
}

describe("minuteDebitCents — integer-cents accumulator", () => {
  it("debits whole cents that average exactly the (fractional) rate, no drift", () => {
    const rate = CLOUD_DICTATION_CENTS_PER_MIN; // 5.8
    const seq = Array.from({ length: 10 }, (_, i) => minuteDebitCents(rate, i));
    // First minutes for 5.8¢/min: each 5-min block sums to round(5*5.8)=29.
    expect(seq.slice(0, 5)).toEqual([6, 6, 5, 6, 6]);
    expect(seq.slice(5, 10)).toEqual([6, 6, 5, 6, 6]);
    // Every emitted debit is a whole, positive number (the ledger rejects non-integer / 0 / negative).
    for (const c of seq) {
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThan(0);
    }
    // Cumulative paid after N minutes tracks round(N*rate) exactly — i.e. no accumulating error.
    let paid = 0;
    for (let n = 1; n <= 60; n++) {
      paid += minuteDebitCents(rate, n - 1);
      expect(paid).toBe(Math.round(n * rate));
    }
  });

  it("yields 0-cent ticks for a sub-1¢ rate (caller skips + carries them)", () => {
    // A hypothetical 0.3¢/min rate rounds to 0 on some minutes; the accumulator still bills the
    // accrued whole cent on a later tick (sum tracks round(n*0.3)). Guards future rate changes.
    const seq = Array.from({ length: 10 }, (_, i) => minuteDebitCents(0.3, i));
    expect(seq).toContain(0); // some ticks debit nothing
    let paid = 0;
    for (let n = 1; n <= 10; n++) {
      paid += minuteDebitCents(0.3, n - 1);
      expect(paid).toBe(Math.round(n * 0.3));
    }
  });
});

describe("createCloudDictationMeter", () => {
  it("reserves the first minute up front and opens only when charged", async () => {
    const consume = vi.fn(async () => okResult);
    const t = fakeTimer();
    const meter = createCloudDictationMeter({
      consume,
      isAiEnabled: () => true,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
      onExhausted: vi.fn(),
      sessionId: "s1",
    });
    expect(await meter.start()).toBe(true);
    // One debit up front, as a WHOLE-cent amount (the accumulator's minute-0 value), keyed by
    // session:minute. minute 0 of 5.8¢/min = round(5.8) = 6.
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith(
      minuteDebitCents(CLOUD_DICTATION_CENTS_PER_MIN, 0),
      "cloud_dictation_minute",
      { minute: 0 },
      "s1:0",
    );
    // The value sent is the whole-cent accumulator value (6), never the raw 5.8 the ledger 400s on —
    // pinned by minuteDebitCents above and the integrality sweep in the accumulator describe block.
  });

  it("does not open (no debit loop) when AI is disabled", async () => {
    const consume = vi.fn(async () => okResult);
    const t = fakeTimer();
    const meter = createCloudDictationMeter({
      consume,
      isAiEnabled: () => false,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
      onExhausted: vi.fn(),
      sessionId: "s1",
    });
    expect(await meter.start()).toBe(false);
    expect(consume).not.toHaveBeenCalled();
  });

  it("does not open when the first minute can't be afforded", async () => {
    const meter = createCloudDictationMeter({
      consume: async () => brokeResult,
      isAiEnabled: () => true,
      setInterval: fakeTimer().setInterval,
      clearInterval: fakeTimer().clearInterval,
      onExhausted: vi.fn(),
      sessionId: "s1",
    });
    expect(await meter.start()).toBe(false);
  });

  it("debits each elapsed minute, and on a failed debit stops + calls onExhausted", async () => {
    let calls = 0;
    const consume = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? okResult : brokeResult; // minutes 0,1 ok; minute 2 out of credits
    });
    const t = fakeTimer();
    const onExhausted = vi.fn();
    const meter = createCloudDictationMeter({
      consume,
      isAiEnabled: () => true,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
      onExhausted,
      sessionId: "s1",
    });
    await meter.start(); // minute 0 (ok)
    await t.tick(); // minute 1 (ok)
    await Promise.resolve();
    expect(onExhausted).not.toHaveBeenCalled();
    await t.tick(); // minute 2 (broke) → stop + onExhausted
    await Promise.resolve();
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(t.cleared).toBe(true);
    // Idempotency keys advanced per minute; cents is the whole-cent accumulator value for minute 2
    // (round(3*5.8)-round(2*5.8) = 17-12 = 5).
    expect(consume).toHaveBeenNthCalledWith(3, minuteDebitCents(CLOUD_DICTATION_CENTS_PER_MIN, 2), "cloud_dictation_minute", { minute: 2 }, "s1:2");
  });

  it("stop() during the first debit never installs the interval (no orphaned billing timer)", async () => {
    // The over-billing race: stop() lands while start()'s first debit is still awaiting. Without the
    // `stopped` guard, stop() would be a no-op (timer still null) and start() would then install an
    // interval nothing can cancel — charging forever.
    let resolveConsume: ((r: ConsumeResult) => void) | null = null;
    const consume = vi.fn(
      () => new Promise<ConsumeResult>((res) => { resolveConsume = res; }),
    );
    let setIntervalCalls = 0;
    const meter = createCloudDictationMeter({
      consume,
      isAiEnabled: () => true,
      setInterval: ((fn: () => void) => { setIntervalCalls += 1; void fn; return 1; }) as CloudMeterDeps["setInterval"],
      clearInterval: (() => {}) as CloudMeterDeps["clearInterval"],
      onExhausted: vi.fn(),
      sessionId: "s1",
    });
    const startPromise = meter.start(); // suspends on the first debit
    meter.stop(); // stop lands during the await
    resolveConsume!({ ok: true, balanceAfterCents: 100, ledgerId: "l1" });
    expect(await startPromise).toBe(false); // start bails out instead of installing the timer
    expect(setIntervalCalls).toBe(0); // no interval → no orphaned billing
  });

  it("stop() clears the interval", async () => {
    const t = fakeTimer();
    const meter = createCloudDictationMeter({
      consume: async () => okResult,
      isAiEnabled: () => true,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
      onExhausted: vi.fn(),
      sessionId: "s1",
    });
    await meter.start();
    meter.stop();
    expect(t.cleared).toBe(true);
  });
});

describe("openMeteredCloudWindow — open-first, meter-only-on-open", () => {
  const fakeMeter = (charged: boolean): { meter: CloudDictationMeter; started: () => boolean } => {
    let started = false;
    return {
      meter: {
        start: async () => {
          started = true;
          return charged;
        },
        stop: () => {},
      },
      started: () => started,
    };
  };

  const deps = (over: Partial<Parameters<typeof openMeteredCloudWindow>[0]>) => {
    const calls = {
      stopCloudStream: 0,
      createMeter: 0,
      clearInterim: 0,
      clearActiveMeter: 0,
    };
    const base = {
      startCloudStream: async () => true,
      stopCloudStream: () => { calls.stopCloudStream += 1; },
      isStillActive: () => true,
      createMeter: () => { calls.createMeter += 1; return fakeMeter(true).meter; },
      clearInterim: () => { calls.clearInterim += 1; },
      clearActiveMeter: () => { calls.clearActiveMeter += 1; },
      ...over,
    };
    return { base, calls };
  };

  it("opened=false ⇒ never meters and never closes (stayed on-device, no charge)", async () => {
    const { base, calls } = deps({ startCloudStream: async () => false });
    await openMeteredCloudWindow(base);
    expect(calls.createMeter).toBe(0);
    expect(calls.stopCloudStream).toBe(0);
  });

  it("a stop/mute during the open ⇒ closes the socket + clears interim, never meters", async () => {
    const { base, calls } = deps({ isStillActive: () => false });
    await openMeteredCloudWindow(base);
    expect(calls.stopCloudStream).toBe(1);
    expect(calls.clearInterim).toBe(1);
    expect(calls.createMeter).toBe(0);
  });

  it("opened + still active + charged ⇒ meters, leaves the stream open", async () => {
    const { base, calls } = deps({ createMeter: () => { calls.createMeter += 1; return fakeMeter(true).meter; } });
    await openMeteredCloudWindow(base);
    expect(calls.createMeter).toBe(1);
    expect(calls.stopCloudStream).toBe(0);
  });

  it("first debit fails ⇒ closes the socket, clears interim + the meter singleton", async () => {
    const { base, calls } = deps({ createMeter: () => { calls.createMeter += 1; return fakeMeter(false).meter; } });
    await openMeteredCloudWindow(base);
    expect(calls.stopCloudStream).toBe(1);
    expect(calls.clearInterim).toBe(1);
    expect(calls.clearActiveMeter).toBe(1);
  });

  it("first debit fails ⇒ calls onUnavailable (so the caller can surface it, e.g. refresh the pill)", async () => {
    const onUnavailable = vi.fn();
    const { base } = deps({
      createMeter: () => fakeMeter(false).meter,
      onUnavailable,
    });
    await openMeteredCloudWindow(base);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("stayed on-device (opened=false) ⇒ never calls onUnavailable (no billable socket opened)", async () => {
    const onUnavailable = vi.fn();
    const { base } = deps({ startCloudStream: async () => false, onUnavailable });
    await openMeteredCloudWindow(base);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("opened + charged ⇒ never calls onUnavailable", async () => {
    const onUnavailable = vi.fn();
    const { base } = deps({
      createMeter: () => fakeMeter(true).meter,
      onUnavailable,
    });
    await openMeteredCloudWindow(base);
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});
