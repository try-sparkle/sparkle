// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const increment = vi.fn();
let trialUsed = 0;
let entitled = false;
vi.mock("../stores/trialStore", () => ({
  useTrialStore: { getState: () => ({ promptsUsed: trialUsed, increment }) },
  TRIAL_LIMIT: 100,
}));
vi.mock("../stores/authStore", () => ({
  useAuthStore: { getState: () => ({ me: entitled ? { entitled: true } : null }) },
}));

import { trialSendAllowed, recordTrialSend } from "./trialMeter";

afterEach(() => {
  trialUsed = 0;
  entitled = false;
  vi.clearAllMocks();
});

describe("trialSendAllowed (pre-send gate, consumes nothing)", () => {
  it("entitled users always pass, even over the limit", () => {
    entitled = true;
    trialUsed = 999;
    expect(trialSendAllowed()).toBe(true);
  });
  it("trial under the limit passes", () => {
    trialUsed = 99;
    expect(trialSendAllowed()).toBe(true);
  });
  it("trial at the limit is blocked", () => {
    trialUsed = 100;
    expect(trialSendAllowed()).toBe(false);
  });
  it("never increments (the gate is a pure read)", () => {
    trialUsed = 5;
    trialSendAllowed();
    expect(increment).not.toHaveBeenCalled();
  });
});

describe("recordTrialSend (post-delivery consume)", () => {
  it("entitled users are never metered", async () => {
    entitled = true;
    await recordTrialSend();
    expect(increment).not.toHaveBeenCalled();
  });
  it("trial users consume one prompt", async () => {
    increment.mockResolvedValue(undefined);
    await recordTrialSend();
    expect(increment).toHaveBeenCalledOnce();
  });
  it("fails open — a counter write error never rejects into the caller", async () => {
    increment.mockRejectedValue(new Error("backend down"));
    await expect(recordTrialSend()).resolves.toBeUndefined();
  });
});
