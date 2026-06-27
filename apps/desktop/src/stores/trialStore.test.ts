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
  useTrialStore.setState({ started: false, promptsUsed: 0, loading: true });
  vi.clearAllMocks();
});

describe("trialStore", () => {
  it("refresh loads started + promptsUsed", async () => {
    status.mockResolvedValue({ installId: "x", started: true, promptsUsed: 5 });
    await useTrialStore.getState().refresh();
    expect(useTrialStore.getState().started).toBe(true);
    expect(useTrialStore.getState().promptsUsed).toBe(5);
    expect(useTrialStore.getState().loading).toBe(false);
  });

  it("increment updates promptsUsed from the returned state", async () => {
    increment.mockResolvedValue({ installId: "x", started: true, promptsUsed: 6 });
    await useTrialStore.getState().increment();
    expect(useTrialStore.getState().promptsUsed).toBe(6);
  });

  it("trialPromptsLeft floors at 0", () => {
    expect(trialPromptsLeft({ promptsUsed: 100 } as never)).toBe(0);
    expect(trialPromptsLeft({ promptsUsed: 101 } as never)).toBe(0);
    expect(trialPromptsLeft({ promptsUsed: 5 } as never)).toBe(95);
  });
});
