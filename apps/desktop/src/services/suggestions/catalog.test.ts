import { describe, it, expect } from "vitest";
import { SEED_CATALOG } from "./catalog";

describe("SEED_CATALOG", () => {
  it("every entry is well-formed", () => {
    expect(SEED_CATALOG.length).toBeGreaterThan(0);
    for (const e of SEED_CATALOG) {
      expect(typeof e.label).toBe("string");
      expect(e.label.length).toBeGreaterThan(0);
      expect(typeof e.value).toBe("string");
      expect(e.value.length).toBeGreaterThan(0);
      expect(["terminal", "prompt"]).toContain(e.kind);
      expect(typeof e.when).toBe("string");
      expect(e.when.length).toBeGreaterThan(0);
    }
  });

  it("labels are unique", () => {
    const labels = SEED_CATALOG.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
