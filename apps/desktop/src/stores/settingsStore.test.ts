import { describe, it, expect } from "vitest";
import { effectiveChiefPat } from "./settingsStore";

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
