import { describe, it, expect, vi } from "vitest";
import { openCloudDictationWindow, nextBalanceCents } from "./cloudDictation";

describe("nextBalanceCents — server value vs optimistic fallback", () => {
  it("prefers the server's post-debit balance when present", () => {
    expect(nextBalanceCents(20000, 19994, 6)).toBe(19994);
    // Server value wins even when it disagrees with current − debited (e.g. concurrent debits).
    expect(nextBalanceCents(20000, 19980, 6)).toBe(19980);
  });

  it("falls back to an optimistic decrement (current − debited) when the relay omits it", () => {
    expect(nextBalanceCents(20000, null, 6)).toBe(19994);
    expect(nextBalanceCents(19994, null, 5)).toBe(19989);
  });
});

describe("openCloudDictationWindow — open first, keep only if still active", () => {
  const deps = (over: Partial<Parameters<typeof openCloudDictationWindow>[0]>) => {
    const calls = { stopCloudStream: 0, clearInterim: 0 };
    const base = {
      startCloudStream: async () => true,
      stopCloudStream: () => {
        calls.stopCloudStream += 1;
      },
      isStillActive: () => true,
      clearInterim: () => {
        calls.clearInterim += 1;
      },
      ...over,
    };
    return { base, calls };
  };

  it("opened=false ⇒ stays on-device, never closes (no socket to tear down)", async () => {
    const startCloudStream = vi.fn(async () => false);
    const { base, calls } = deps({ startCloudStream });
    await openCloudDictationWindow(base);
    expect(startCloudStream).toHaveBeenCalledTimes(1);
    expect(calls.stopCloudStream).toBe(0);
    expect(calls.clearInterim).toBe(0);
  });

  it("opened + still active ⇒ leaves the relay stream open (server meters, nothing else to do)", async () => {
    const { base, calls } = deps({});
    await openCloudDictationWindow(base);
    expect(calls.stopCloudStream).toBe(0);
    expect(calls.clearInterim).toBe(0);
  });

  it("a stop/mute/toggle raced the open ⇒ closes the socket + clears the interim preview", async () => {
    const { base, calls } = deps({ isStillActive: () => false });
    await openCloudDictationWindow(base);
    expect(calls.stopCloudStream).toBe(1);
    expect(calls.clearInterim).toBe(1);
  });
});
