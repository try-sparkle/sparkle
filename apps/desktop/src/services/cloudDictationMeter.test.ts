import { describe, it, expect, vi } from "vitest";
import {
  createCloudDictationMeter,
  openMeteredCloudWindow,
  minuteDebitCents,
  nextBalanceCents,
  MAX_CONSECUTIVE_TRANSIENT_DEBIT_FAILS,
  type CloudMeterDeps,
  type CloudDictationMeter,
} from "./cloudDictationMeter";
import { CLOUD_DICTATION_CENTS_PER_MIN } from "./creditPricing";
import type { ConsumeResult } from "./credits";

const okResult: ConsumeResult = { ok: true, balanceAfterCents: 100, ledgerId: "l1" };
const brokeResult: ConsumeResult = { ok: false, balanceCents: 0 };

/** Flush enough microtasks for one debit to fully settle (consume reject → debitOneMinute resume →
 *  the interval's `.then`), so the `inFlight` guard releases before the next fake tick fires. */
const settleDebit = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

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

describe("nextBalanceCents — server value vs optimistic fallback", () => {
  it("prefers the server's post-debit balance when present", () => {
    expect(nextBalanceCents(20000, 19994, 6)).toBe(19994);
    // Server value wins even when it disagrees with current − debited (e.g. concurrent debits).
    expect(nextBalanceCents(20000, 19980, 6)).toBe(19980);
  });

  it("falls back to an optimistic decrement (current − debited) when the server omits it", () => {
    expect(nextBalanceCents(20000, null, 6)).toBe(19994);
    expect(nextBalanceCents(19994, null, 5)).toBe(19989);
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

  it("fires onDebited with the server balance on the immediate first debit", async () => {
    const consume = vi.fn(async () => okResult); // balanceAfterCents: 100
    const onDebited = vi.fn();
    const t = fakeTimer();
    const meter = createCloudDictationMeter({
      consume,
      isAiEnabled: () => true,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
      onExhausted: vi.fn(),
      onDebited,
      sessionId: "s1",
    });
    expect(await meter.start()).toBe(true);
    // The server's post-debit balance is propagated, alongside the whole-cent amount just debited.
    expect(onDebited).toHaveBeenCalledTimes(1);
    expect(onDebited).toHaveBeenCalledWith(100, minuteDebitCents(CLOUD_DICTATION_CENTS_PER_MIN, 0));
  });

  it("fires onDebited on each interval debit with the server balance propagated", async () => {
    // Distinct balances per minute so we can assert the latest value flows through each tick.
    const balances = [94, 88, 82];
    let calls = 0;
    const consume = vi.fn(async (): Promise<ConsumeResult> => {
      const balanceAfterCents = balances[calls++]!;
      return { ok: true, balanceAfterCents, ledgerId: `l${calls}` };
    });
    const onDebited = vi.fn();
    const t = fakeTimer();
    const meter = createCloudDictationMeter({
      consume,
      isAiEnabled: () => true,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
      onExhausted: vi.fn(),
      onDebited,
      sessionId: "s1",
    });
    await meter.start(); // minute 0 → balance 94
    await t.tick(); // minute 1 → balance 88
    await Promise.resolve();
    await t.tick(); // minute 2 → balance 82
    await Promise.resolve();
    expect(onDebited).toHaveBeenCalledTimes(3);
    expect(onDebited).toHaveBeenNthCalledWith(1, 94, minuteDebitCents(CLOUD_DICTATION_CENTS_PER_MIN, 0));
    expect(onDebited).toHaveBeenNthCalledWith(2, 88, minuteDebitCents(CLOUD_DICTATION_CENTS_PER_MIN, 1));
    expect(onDebited).toHaveBeenNthCalledWith(3, 82, minuteDebitCents(CLOUD_DICTATION_CENTS_PER_MIN, 2));
  });

  it("passes null to onDebited when the server omits balanceAfterCents (caller falls back)", async () => {
    // Defensive: the ledger may not echo a post-debit balance. The meter forwards null so the wiring
    // can optimistically decrement (see nextBalanceCents) instead of leaving the UI frozen.
    const consume = vi.fn(
      async () => ({ ok: true, balanceAfterCents: null, ledgerId: "l1" }) as unknown as ConsumeResult,
    );
    const onDebited = vi.fn();
    const t = fakeTimer();
    const meter = createCloudDictationMeter({
      consume,
      isAiEnabled: () => true,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
      onExhausted: vi.fn(),
      onDebited,
      sessionId: "s1",
    });
    await meter.start();
    expect(onDebited).toHaveBeenCalledWith(null, minuteDebitCents(CLOUD_DICTATION_CENTS_PER_MIN, 0));
  });

  it("does not fire onDebited on a failed (out-of-credits) debit", async () => {
    const onDebited = vi.fn();
    const meter = createCloudDictationMeter({
      consume: async () => brokeResult,
      isAiEnabled: () => true,
      setInterval: fakeTimer().setInterval,
      clearInterval: fakeTimer().clearInterval,
      onExhausted: vi.fn(),
      onDebited,
      sessionId: "s1",
    });
    await meter.start();
    expect(onDebited).not.toHaveBeenCalled();
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

  it("tolerates a bounded run of transient (thrown) debit errors without dropping the stream", async () => {
    // A momentary network/TLS blip throws from consume(). The stream must survive up to
    // MAX_CONSECUTIVE_TRANSIENT_DEBIT_FAILS such hiccups in a row and recover on the next success —
    // not fall back to on-device the way a real out-of-credits decline does.
    let calls = 0;
    const consume = vi.fn(async (): Promise<ConsumeResult> => {
      calls += 1;
      // minute 0 ok; minutes 1..MAX throw; the next minute succeeds again.
      if (calls === 1) return okResult;
      if (calls <= 1 + MAX_CONSECUTIVE_TRANSIENT_DEBIT_FAILS) throw new Error("tls blip");
      return okResult;
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
    await meter.start(); // minute 0 ok
    for (let i = 0; i < MAX_CONSECUTIVE_TRANSIENT_DEBIT_FAILS; i++) {
      t.tick(); // each throws — tolerated
      await settleDebit();
    }
    expect(onExhausted).not.toHaveBeenCalled(); // rode out every blip
    expect(t.cleared).toBe(false); // stream still open
    t.tick(); // recovers
    await settleDebit();
    expect(onExhausted).not.toHaveBeenCalled();
    expect(t.cleared).toBe(false);
    // Each tick actually fired a debit (1 start + MAX throws + 1 recovery) — proves no tick was
    // silently swallowed by the inFlight guard.
    expect(consume).toHaveBeenCalledTimes(1 + MAX_CONSECUTIVE_TRANSIENT_DEBIT_FAILS + 1);
  });

  it("gives up after one too many consecutive transient errors → stop + onExhausted", async () => {
    // One more consecutive throw than we tolerate ⇒ a genuine outage ⇒ fall back to on-device.
    let calls = 0;
    const consume = vi.fn(async (): Promise<ConsumeResult> => {
      calls += 1;
      return calls === 1 ? okResult : Promise.reject(new Error("server down"));
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
    await meter.start(); // minute 0 ok
    for (let i = 0; i <= MAX_CONSECUTIVE_TRANSIENT_DEBIT_FAILS; i++) {
      t.tick(); // MAX tolerated, then one more → give up
      await settleDebit();
    }
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(t.cleared).toBe(true);
  });

  it("a successful debit resets the transient-failure counter (blips never accumulate to a give-up)", async () => {
    // Alternating throw/success forever: because each success resets the run, we never reach the
    // give-up threshold even across many total failures.
    let calls = 0;
    const consume = vi.fn(async (): Promise<ConsumeResult> => {
      calls += 1;
      // ok, throw, ok, throw, ok, … (every even call throws)
      if (calls % 2 === 0) throw new Error("intermittent blip");
      return okResult;
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
    await meter.start();
    for (let i = 0; i < 10; i++) {
      t.tick();
      await settleDebit();
    }
    expect(onExhausted).not.toHaveBeenCalled();
    expect(t.cleared).toBe(false);
  });

  it("an out-of-credits decline still stops on the FIRST occurrence (no transient tolerance)", async () => {
    // Regression guard: tolerance must apply ONLY to thrown errors, never to a definitive {ok:false}.
    let calls = 0;
    const consume = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? okResult : brokeResult; // minute 0 ok, minute 1 out of credits
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
    await meter.start(); // minute 0 ok
    await t.tick(); // minute 1 declined → immediate stop
    await Promise.resolve();
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(t.cleared).toBe(true);
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
