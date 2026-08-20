import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCredentialHealth,
  isCredentialExpired,
  setCredentialHealth,
  subscribeCredentialHealth,
  resetCredentialHealthForTests,
} from "./credentialHealth";

afterEach(() => resetCredentialHealthForTests());

describe("credentialHealth — the one source of truth for all-accounts-expired", () => {
  it("starts healthy so a probe that has not run yet never gates anything", () => {
    expect(getCredentialHealth()).toBe("ok");
    expect(isCredentialExpired()).toBe(false);
  });

  it("publishing expired flips the predicate the consumers gate on, and back", () => {
    setCredentialHealth("expired");
    expect(isCredentialExpired()).toBe(true);
    setCredentialHealth("ok");
    expect(isCredentialExpired()).toBe(false);
  });

  it("notifies subscribers on a CHANGE, and never on a same-value re-publish", () => {
    const fn = vi.fn();
    subscribeCredentialHealth(fn);
    // Same as current state → no wake. This is the guard that a gate re-publishing every render does
    // not pump the subscribers, which each re-run real work.
    setCredentialHealth("ok");
    expect(fn).toHaveBeenCalledTimes(0);
    // A real change → exactly one wake.
    setCredentialHealth("expired");
    expect(fn).toHaveBeenCalledTimes(1);
    // Idempotent re-publish of the new value → still no extra wake.
    setCredentialHealth("expired");
    expect(fn).toHaveBeenCalledTimes(1);
    setCredentialHealth("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("unsubscribing stops delivery", () => {
    const fn = vi.fn();
    const off = subscribeCredentialHealth(fn);
    off();
    setCredentialHealth("expired");
    expect(fn).not.toHaveBeenCalled();
  });

  it("a throwing subscriber does not stop the others from being told", () => {
    const boom = vi.fn(() => {
      throw new Error("subscriber blew up");
    });
    const ok = vi.fn();
    subscribeCredentialHealth(boom);
    subscribeCredentialHealth(ok);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setCredentialHealth("expired");
    expect(boom).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
