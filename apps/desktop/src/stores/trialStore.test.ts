// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const status = vi.fn();
const start = vi.fn();
const increment = vi.fn();
vi.mock("../services/trialApi", () => ({
  TRIAL_LIMIT: 100,
  fetchTrial: () => status(),
  startTrial: () => start(),
  incrementTrial: () => increment(),
}));

import { useTrialStore, trialPromptsLeft } from "./trialStore";

afterEach(() => {
  useTrialStore.setState({ started: false, promptsUsed: 0, loading: true, error: false });
  vi.clearAllMocks();
});

describe("trialStore", () => {
  it("refresh loads started + promptsUsed", async () => {
    status.mockResolvedValue({ installId: "x", started: true, promptsUsed: 5 });
    await useTrialStore.getState().refresh();
    expect(useTrialStore.getState().started).toBe(true);
    expect(useTrialStore.getState().promptsUsed).toBe(5);
    expect(useTrialStore.getState().loading).toBe(false);
    expect(useTrialStore.getState().error).toBe(false);
  });

  it("refresh RESOLVES (never hangs) and clears loading when fetchTrial throws (corrupt trial.json)", async () => {
    // Rust treats a corrupt trial.json as a HARD error (anti-abuse: corruption must not silently
    // re-grant a trial), so fetchTrial rejects. Before the fix, refresh() had no catch → the promise
    // rejected, `loading` stayed true forever, and the gate was pinned on the "Loading…" screen.
    status.mockRejectedValue("parse trial.json: expected value");
    // The call itself must resolve, not reject — an unhandled rejection here IS the bug.
    await expect(useTrialStore.getState().refresh()).resolves.toBeUndefined();
    expect(useTrialStore.getState().loading).toBe(false); // no longer stuck
    // Safe, non-stuck state: NOT a re-granted trial (started stays false) so the user lands on the
    // recoverable Welcome screen, and the error flag drives the banner.
    expect(useTrialStore.getState().started).toBe(false);
    expect(useTrialStore.getState().promptsUsed).toBe(0);
    expect(useTrialStore.getState().error).toBe(true);
  });

  it("a later successful refresh clears a prior error", async () => {
    status.mockRejectedValueOnce("boom");
    await useTrialStore.getState().refresh();
    expect(useTrialStore.getState().error).toBe(true);
    status.mockResolvedValue({ installId: "x", started: true, promptsUsed: 2 });
    await useTrialStore.getState().refresh();
    expect(useTrialStore.getState().error).toBe(false);
    expect(useTrialStore.getState().started).toBe(true);
  });

  it("start that throws flips error without an unhandled rejection", async () => {
    start.mockRejectedValue("write trial.json tmp: EACCES");
    await expect(useTrialStore.getState().start()).resolves.toBeUndefined();
    expect(useTrialStore.getState().error).toBe(true);
  });

  it("increment updates promptsUsed from the returned state", async () => {
    increment.mockResolvedValue({ installId: "x", started: true, promptsUsed: 6 });
    await useTrialStore.getState().increment();
    expect(useTrialStore.getState().promptsUsed).toBe(6);
  });

  it("a failed increment swallows without raising the entry-gating error flag", async () => {
    // `error` gates the token-less Welcome banner (a read/start failure). A best-effort metering
    // write that throws must not become an unhandled rejection NOR flip that shared flag.
    useTrialStore.setState({ error: false });
    increment.mockRejectedValue(new Error("meter write failed"));
    await expect(useTrialStore.getState().increment()).resolves.toBeUndefined();
    expect(useTrialStore.getState().error).toBe(false);
  });

  it("trialPromptsLeft floors at 0", () => {
    expect(trialPromptsLeft({ promptsUsed: 100 } as never)).toBe(0);
    expect(trialPromptsLeft({ promptsUsed: 101 } as never)).toBe(0);
    expect(trialPromptsLeft({ promptsUsed: 5 } as never)).toBe(95);
  });
});
