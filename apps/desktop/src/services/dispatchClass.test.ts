import { describe, expect, it } from "vitest";
import {
  DESTRUCTIVE_CATEGORIES,
  DESTRUCTIVE_DELAY_MS,
  ROUTINE_DELAY_MS,
  classifyDispatch,
  dispatchDelayMs,
  isDestructiveCategory,
} from "./dispatchClass";
import { APPROVAL_CATEGORIES, type ApprovalCategory } from "./suggestions/approvalCategories";
import { NON_BASH_CATEGORIES } from "./autoApprovePreset";
import { classifyCategory } from "./suggestions/approvalClassifier";

describe("DESTRUCTIVE_CATEGORIES — derived from the ONE taxonomy, not a second list", () => {
  // The locked decision (design §1, decision 3). If someone later hard-codes a destructive list
  // here, this test is what catches the drift against the auto-approve settings.
  it("is exactly the complement of what the conservative preset will auto-fire", () => {
    const expected = APPROVAL_CATEGORIES.filter((c) => !NON_BASH_CATEGORIES.includes(c));
    expect([...DESTRUCTIVE_CATEGORIES]).toEqual([...expected]);
  });

  it("draws the line at commands — the one thing 'everything except commands' withholds", () => {
    expect([...DESTRUCTIVE_CATEGORIES]).toEqual(["bash"]);
  });

  // Table-driven over the whole taxonomy, per the design's testing section: every category lands on
  // exactly one side, and adding a category to APPROVAL_CATEGORIES cannot leave it unclassified.
  it.each(APPROVAL_CATEGORIES.map((c) => [c] as [ApprovalCategory]))(
    "classifies %s onto exactly one side of the line",
    (cat) => {
      const destructive = isDestructiveCategory(cat);
      expect(destructive).toBe(DESTRUCTIVE_CATEGORIES.includes(cat));
      expect(destructive).toBe(!NON_BASH_CATEGORIES.includes(cat));
    },
  );

  it("covers every category — no member is missing from both sides", () => {
    for (const cat of APPROVAL_CATEGORIES) {
      expect(DESTRUCTIVE_CATEGORIES.includes(cat) || NON_BASH_CATEGORIES.includes(cat)).toBe(true);
    }
  });
});

describe("classifyDispatch", () => {
  it("reads command-shaped text as destructive", () => {
    expect(classifyDispatch("run the deploy command")).toBe("destructive");
    expect(classifyDispatch("bash scripts/land.sh")).toBe("destructive");
    expect(classifyDispatch("execute the migration")).toBe("destructive");
  });

  it("reads ordinary instructions and terse answers as routine", () => {
    expect(classifyDispatch("add retry logic to the fetch helper")).toBe("routine");
    expect(classifyDispatch("yes")).toBe("routine");
    expect(classifyDispatch("")).toBe("routine");
  });

  it("agrees with the shared classifier for every category it can produce", () => {
    // The point of the derivation: the tier is a pure function of the SAME category the
    // auto-approve pane shows, never a second opinion about the same text.
    for (const text of ["run the deploy command", "edit the config file", "fetch https://x.dev"]) {
      expect(classifyDispatch(text)).toBe(
        isDestructiveCategory(classifyCategory(text)) ? "destructive" : "routine",
      );
    }
  });

  it("is total — an unrecognized message is routine, never a refusal", () => {
    expect(classifyDispatch("¯\\_(ツ)_/¯")).toBe("routine");
  });
});

describe("dispatchDelayMs", () => {
  it("gives the destructive tier 5s and the routine tier 3s", () => {
    expect(dispatchDelayMs("routine")).toBe(3000);
    expect(dispatchDelayMs("destructive")).toBe(5000);
    expect(ROUTINE_DELAY_MS).toBe(3000);
    expect(DESTRUCTIVE_DELAY_MS).toBe(5000);
  });

  it("gives destructive strictly more time than routine", () => {
    expect(DESTRUCTIVE_DELAY_MS).toBeGreaterThan(ROUTINE_DELAY_MS);
  });
});
