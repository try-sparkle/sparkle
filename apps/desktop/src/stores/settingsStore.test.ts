import { describe, it, expect, beforeEach } from "vitest";
import { effectiveChiefPat, useSettingsStore } from "./settingsStore";

describe("effectiveChiefPat — PAT resolution order", () => {
  it("prefers a user-entered (stored) PAT, trimmed", () => {
    expect(effectiveChiefPat("  pat_user  ", "pat_runtime")).toBe("pat_user");
  });

  it("falls back to the runtime env-resolved PAT when nothing is stored", () => {
    expect(effectiveChiefPat("", "pat_runtime")).toBe("pat_runtime");
    expect(effectiveChiefPat("   ", "pat_runtime")).toBe("pat_runtime");
  });

  it("is empty when neither a stored nor a runtime PAT exists (no build-env token in tests)", () => {
    expect(effectiveChiefPat("", "")).toBe("");
    expect(effectiveChiefPat("")).toBe("");
  });
});

describe("maxConcurrentWorkers", () => {
  beforeEach(() => useSettingsStore.setState({ maxConcurrentWorkers: 4 }));
  it("defaults to 4", () => {
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(4);
  });
  it("can be set, flooring at 1", () => {
    useSettingsStore.getState().setMaxConcurrentWorkers(8);
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(8);
    useSettingsStore.getState().setMaxConcurrentWorkers(0);
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(1); // never < 1
  });
});
