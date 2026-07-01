import { describe, it, expect } from "vitest";
import { consentPillLabel, sparkleBarState } from "./sparkleRowStatus";

describe("consentPillLabel", () => {
  it("maps each consent mode to its product wording", () => {
    expect(consentPillLabel("always")).toBe("Always");
    expect(consentPillLabel("case_by_case")).toBe("Manual");
    expect(consentPillLabel("never")).toBe("Off");
  });
});

describe("sparkleBarState", () => {
  it("is 'off' whenever consent is Never, regardless of status", () => {
    expect(sparkleBarState("working", "never")).toBe("off");
    expect(sparkleBarState("approval", "never")).toBe("off");
    expect(sparkleBarState("idle", "never")).toBe("off");
  });

  it("builds (cyan→blue gradient) while working", () => {
    expect(sparkleBarState("working", "always")).toBe("building");
    expect(sparkleBarState("working", "case_by_case")).toBe("building");
  });

  it("is idle (gray rail) when not working — needs-you status is carried by the dot, not the bar", () => {
    for (const s of ["idle", "done", "stopped", "blocked", "waiting", "approval", "errored"] as const) {
      expect(sparkleBarState(s, "always")).toBe("idle");
      expect(sparkleBarState(s, "case_by_case")).toBe("idle");
    }
  });
});
