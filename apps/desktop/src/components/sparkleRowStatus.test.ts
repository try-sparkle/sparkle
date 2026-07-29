import { describe, it, expect } from "vitest";
import { consentPillLabel } from "./sparkleRowStatus";

describe("consentPillLabel", () => {
  it("maps each consent mode to its product wording", () => {
    expect(consentPillLabel("always")).toBe("Always");
    expect(consentPillLabel("case_by_case")).toBe("Manual");
    expect(consentPillLabel("never")).toBe("Off");
  });
});

// `sparkleBarState` and its suite are GONE with the row's progress bar. The bar was the row's own
// three-state machine (off / idle / building) sitting beside the effectiveStatus → rollupDot → band
// pipeline every other row in the column uses; the row now takes that pipeline directly, and its
// disc is asserted against a real build row's in AgentSidebar.sparkleRow.test.tsx.
