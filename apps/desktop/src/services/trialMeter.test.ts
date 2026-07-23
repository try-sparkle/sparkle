// @vitest-environment jsdom
//
// The trial gate is SERVER-authoritative: `blocked` is set only by an affirmative server verdict
// (a 402, or a debit that left 0 remaining), never by a local count and never by a network failure.
// These tests pin that contract at the meter seam the composer and the raw terminal both call.
import { afterEach, describe, expect, it, vi } from "vitest";

const consume = vi.fn();
let blocked = false;
let entitled = false;
vi.mock("../stores/trialStore", () => ({
  useTrialStore: { getState: () => ({ blocked, consume }) },
  TRIAL_LIMIT: 100,
}));
vi.mock("../stores/authStore", () => ({
  useAuthStore: { getState: () => ({ me: entitled ? { entitled: true } : null }) },
}));

import { trialSendAllowed, recordTrialSend } from "./trialMeter";

afterEach(() => {
  blocked = false;
  entitled = false;
  vi.clearAllMocks();
});

describe("trialSendAllowed (pre-send gate, consumes nothing)", () => {
  it("entitled users always pass — even when the server blocked this device", () => {
    entitled = true;
    blocked = true;
    expect(trialSendAllowed()).toBe(true);
  });
  it("an un-blocked trial user passes", () => {
    expect(trialSendAllowed()).toBe(true);
  });
  it("an AFFIRMATIVE server block refuses the send", () => {
    blocked = true;
    expect(trialSendAllowed()).toBe(false);
  });
  it("never consumes (the gate is a pure read)", () => {
    trialSendAllowed();
    expect(consume).not.toHaveBeenCalled();
  });
});

describe("recordTrialSend (post-delivery server debit)", () => {
  it("entitled users are never metered — the trial endpoints are never touched", async () => {
    entitled = true;
    await recordTrialSend();
    expect(consume).not.toHaveBeenCalled();
  });
  it("trial users debit one prompt against the server", async () => {
    consume.mockResolvedValue(undefined);
    await recordTrialSend();
    expect(consume).toHaveBeenCalledOnce();
  });
  it("fails open — a metering error never rejects into the caller", async () => {
    consume.mockRejectedValue(new Error("orchestration down"));
    await expect(recordTrialSend()).resolves.toBeUndefined();
  });
});
