import { describe, expect, it } from "vitest";
import {
  autoApprovePresetOf,
  categoriesForPreset,
  NON_BASH_CATEGORIES,
} from "./autoApprovePreset";
import { APPROVAL_CATEGORIES, type ApprovalMap } from "./suggestions/approvalCategories";

const allAlways = (): ApprovalMap =>
  Object.fromEntries(APPROVAL_CATEGORIES.map((c) => [c, "always"])) as ApprovalMap;

describe("autoApprovePreset", () => {
  it("NON_BASH_CATEGORIES is every category except bash", () => {
    expect(NON_BASH_CATEGORIES).not.toContain("bash");
    expect([...NON_BASH_CATEGORIES].sort()).toEqual(
      APPROVAL_CATEGORIES.filter((c) => c !== "bash")
        .slice()
        .sort(),
    );
  });

  it("categoriesForPreset: full = all, except-bash = all but bash", () => {
    expect(categoriesForPreset("full")).toEqual(APPROVAL_CATEGORIES);
    expect(categoriesForPreset("except-bash")).toEqual(NON_BASH_CATEGORIES);
  });

  describe("autoApprovePresetOf", () => {
    it("an empty map is neither preset (custom/none)", () => {
      expect(autoApprovePresetOf({})).toBeNull();
    });

    it("all six categories 'always' → full", () => {
      expect(autoApprovePresetOf(allAlways())).toBe("full");
    });

    it("every non-bash 'always' with bash UNSET → except-bash", () => {
      const map: ApprovalMap = {};
      for (const c of NON_BASH_CATEGORIES) map[c] = "always";
      expect(map.bash).toBeUndefined();
      expect(autoApprovePresetOf(map)).toBe("except-bash");
    });

    it("bash 'never' (muted) is NOT except-bash — it's a hand-tuned custom state", () => {
      const map: ApprovalMap = { bash: "never" };
      for (const c of NON_BASH_CATEGORIES) map[c] = "always";
      expect(autoApprovePresetOf(map)).toBeNull();
    });

    it("a partial set (only one category) is null", () => {
      expect(autoApprovePresetOf({ skill: "always" })).toBeNull();
    });
  });
});
