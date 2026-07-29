import { describe, it, expect, beforeEach } from "vitest";
import { isOutageActive, useAiProviderStore, OUTAGE_MAX_AGE_MS } from "./aiProviderStore";

beforeEach(() => useAiProviderStore.setState({ outage: null }));

describe("aiProviderStore", () => {
  it("starts clean, so a healthy launch never flashes the banner", () => {
    expect(useAiProviderStore.getState().outage).toBeNull();
  });

  it("records an outage with its reason and timestamp", () => {
    useAiProviderStore.getState().noteOutage("cli_missing", 1234);
    expect(useAiProviderStore.getState().outage).toEqual({ reason: "cli_missing", at: 1234 });
  });

  it("expires a stale observation, so a forgotten clear cannot strand a false banner", () => {
    // Second line of defence behind "every wrapper calls noteAiProviderHealthy on success"
    // (roborev 54761). The banner has no dismiss control, so an un-cleared record would otherwise
    // assert a broken provider for the rest of the session while it is healthy.
    const outage = { reason: "cli_missing" as const, at: 1_000 };
    expect(isOutageActive(outage, 1_000)).toBe(true);
    expect(isOutageActive(outage, 1_000 + OUTAGE_MAX_AGE_MS - 1)).toBe(true);
    expect(isOutageActive(outage, 1_000 + OUTAGE_MAX_AGE_MS)).toBe(false);
    expect(isOutageActive(null, 1_000)).toBe(false);
  });

  it("re-stamps a still-live outage so it cannot age out mid-outage", () => {
    // The identity optimisation below must not let a continuing outage expire: past the refresh
    // window a repeat observation has to move `at` forward.
    useAiProviderStore.getState().noteOutage("cli_missing", 0);
    useAiProviderStore.getState().noteOutage("cli_missing", OUTAGE_MAX_AGE_MS / 2);
    expect(useAiProviderStore.getState().outage?.at).toBe(OUTAGE_MAX_AGE_MS / 2);
    // ...and the refreshed record is active at a time the original would already have expired.
    expect(isOutageActive(useAiProviderStore.getState().outage, OUTAGE_MAX_AGE_MS)).toBe(true);
  });

  it("keeps the same object identity while the reason is unchanged", () => {
    // This is written from a path that can fire once per failed call — during the real outage that
    // was ~600 calls/hour. A fresh object each time would notify every selector subscriber and
    // re-render the shell on a loop, turning a dead feature into a janky one.
    useAiProviderStore.getState().noteOutage("cli_missing", 1);
    const first = useAiProviderStore.getState().outage;
    // Within the refresh window, so identity is preserved (no subscriber churn).
    useAiProviderStore.getState().noteOutage("cli_missing", 999);
    expect(useAiProviderStore.getState().outage).toBe(first);
  });

  it("replaces the record when the reason actually changes", () => {
    useAiProviderStore.getState().noteOutage("cli_missing", 1);
    useAiProviderStore.getState().noteOutage("cli_not_authenticated", 2);
    expect(useAiProviderStore.getState().outage).toEqual({ reason: "cli_not_authenticated", at: 2 });
  });

  it("clears on a healthy call, so recovery needs no restart or dismissal", () => {
    useAiProviderStore.getState().noteOutage("cli_missing", 1);
    useAiProviderStore.getState().noteHealthy();
    expect(useAiProviderStore.getState().outage).toBeNull();
  });

  it("noteHealthy is a no-op identity-wise when already healthy", () => {
    const before = useAiProviderStore.getState();
    useAiProviderStore.getState().noteHealthy();
    expect(useAiProviderStore.getState()).toBe(before);
  });
});
