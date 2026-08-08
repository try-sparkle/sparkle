import { describe, it, expect, vi } from "vitest";
import { openCloudDictationWindow, nextBalanceCents } from "./cloudDictation";
import type { CloudStreamOutcome } from "../stores/dictationEngineStore";

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
      startCloudStream: async (): Promise<CloudStreamOutcome> => "opened",
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

  it("a refusal ⇒ stays on-device, never closes (no socket to tear down)", async () => {
    const startCloudStream = vi.fn(
      async (): Promise<CloudStreamOutcome> => "unauthorized",
    );
    const { base, calls } = deps({ startCloudStream });
    await openCloudDictationWindow(base);
    expect(startCloudStream).toHaveBeenCalledTimes(1);
    expect(calls.stopCloudStream).toBe(0);
    expect(calls.clearInterim).toBe(0);
  });

  // THE ONE OUTCOME THAT IS LIVE BUT NOT OURS. `already_routing` means an EARLIER call installed a
  // socket that is still streaming. If this call treated "live" as "mine to manage", a stop that
  // raced it would fall through to the teardown below and close a stream a still-active window is
  // using — turning the flap fix into a hang-up. Asserted with isStillActive FALSE, because that is
  // the only path on which the difference is observable at all.
  it("already_routing + a raced stop ⇒ does NOT close a socket this call never installed", async () => {
    const { base, calls } = deps({
      startCloudStream: async (): Promise<CloudStreamOutcome> =>
        "already_routing",
      isStillActive: () => false,
    });
    await openCloudDictationWindow(base);
    expect(calls.stopCloudStream).toBe(0);
    expect(calls.clearInterim).toBe(0);
  });

  // `resumed` IS this call's socket (it resumed a warm standby), so it follows the same path as a
  // fresh open — including the teardown when a stop races it.
  it("resumed + a raced stop ⇒ closes, exactly as a fresh open would", async () => {
    const { base, calls } = deps({
      startCloudStream: async (): Promise<CloudStreamOutcome> => "resumed",
      isStillActive: () => false,
    });
    await openCloudDictationWindow(base);
    expect(calls.stopCloudStream).toBe(1);
    expect(calls.clearInterim).toBe(1);
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

  // THE BILLING LEAK, ASSERTED END TO END — the failure the fail-safe `default` arms were written
  // for, at the level where it actually costs money (roborev 60358).
  //
  // An unrecognised token is what a wire drift looks like from here: a Rust variant renamed, or
  // `#[serde(rename_all)]` lost. `classifyCloudOutcome` was made total first, which stopped the
  // THROW — but `outcomeInstalledStream` was still a strict `===` pair answering `false`, so a
  // stream the backend really did install read as "nothing to tear down", this function returned
  // early, and a raced stop never closed the socket. It kept metering, silently, with nothing in
  // the suite covering it: the store test only asserted that classify does not throw.
  //
  // The choice is WHICH failure is worse, not that either is free: a missed stop is a silent
  // orphaned socket that keeps metering, a spurious stop is a visible engine swap the next open
  // re-establishes. See `outcomeInstalledStream`'s note for why the "costs one no-op call" framing
  // was wrong — `stop_cloud_stream` is app-wide, not caller-scoped.
  it("an UNRECOGNISED outcome + a raced stop ⇒ still closes, rather than orphaning a billing socket", async () => {
    const { base, calls } = deps({
      // e.g. a Rust-side rename that outran the TS union.
      startCloudStream: async () => "Opened" as CloudStreamOutcome,
      isStillActive: () => false,
    });
    await openCloudDictationWindow(base);
    expect(calls.stopCloudStream).toBe(1);
    expect(calls.clearInterim).toBe(1);
  });

  // THE OTHER DIRECTION OF THE SAME DRIFT, AND IT IS THE COSTLY ONE (roborev 60366). A lost
  // `rename_all` does not drift one token — it drifts ALL of them, `already_routing` included, which
  // is the most common outcome in ordinary use. So the fail-safe `true` above necessarily also fires
  // for a socket this call never installed. This test does not assert that the outcome is GOOD; it
  // pins that it is the KNOWN, deliberate cost of the fail-safe, so the next reader finds it here
  // rather than rediscovering it from a mid-utterance engine swap in the field.
  it("a drifted already_routing + a raced stop ⇒ DOES close — the known cost of the fail-safe", async () => {
    const { base, calls } = deps({
      startCloudStream: async () => "AlreadyRouting" as CloudStreamOutcome,
      isStillActive: () => false,
    });
    await openCloudDictationWindow(base);
    // Contrast with the `already_routing` case above, which asserts 0: the difference is ENTIRELY
    // that the token is unrecognised. Keeping the recognised path at 0 is what makes the pinning
    // test upstream the real guard.
    expect(calls.stopCloudStream).toBe(1);
  });
});
