import { describe, expect, it } from "vitest";
import { joinList } from "./joinList";

describe("joinList", () => {
  it("returns the empty string for no items", () => {
    expect(joinList([])).toBe("");
  });

  it("returns a single item unchanged", () => {
    expect(joinList(["Personal"])).toBe("Personal");
  });

  it("joins two items with 'and' and no comma", () => {
    expect(joinList(["Personal", "Gmail"])).toBe("Personal and Gmail");
  });

  it("comma-separates three or more, with 'and' only before the last", () => {
    expect(joinList(["Personal", "Gmail", "Storytell II"])).toBe("Personal, Gmail and Storytell II");
    expect(joinList(["Personal", "Gmail", "Storytell II", "AmForge"])).toBe(
      "Personal, Gmail, Storytell II and AmForge",
    );
  });
});
