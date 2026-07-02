import { describe, it, expect } from "vitest";
import { readStageDef, isDefined, type StageDefinition } from "./stageDefs";
import type { SparkleConfig } from "./config";

// A minimal effective config whose done/delivered sections we vary per test.
const cfg = (over: Partial<SparkleConfig>): SparkleConfig =>
  ({
    workflow: {} as never,
    workers: {} as never,
    ai: {} as never,
    freshness: {} as never,
    capture: {} as never,
    done: { description: null, criteria: [] },
    delivered: {
      description: null,
      detected_method: null,
      confidence: null,
      confidence_note: null,
      learned: false,
      criteria: [],
    },
    ...over,
  }) as SparkleConfig;

describe("readStageDef", () => {
  it("returns undefined when the section is empty (no description AND no criteria)", () => {
    expect(readStageDef(cfg({}), "done")).toBeUndefined();
    expect(readStageDef(cfg({}), "delivered")).toBeUndefined();
  });

  it("maps a done section snake_case → camelCase, signal null → undefined", () => {
    const c = cfg({
      done: {
        description: "Merged into origin/main.",
        criteria: [
          { text: "Merged into origin/main", kind: "auto", signal: "merged_to_main" },
          { text: "Reviewed by a teammate", kind: "manual", signal: null },
        ],
      },
    });
    const def = readStageDef(c, "done");
    expect(def).toBeDefined();
    expect(def?.description).toBe("Merged into origin/main.");
    expect(def?.criteria[0]).toEqual({ text: "Merged into origin/main", kind: "auto", signal: "merged_to_main" });
    // Manual criterion drops the null signal (undefined, not present).
    expect(def?.criteria[1]).toEqual({ text: "Reviewed by a teammate", kind: "manual" });
    expect("signal" in (def?.criteria[1] ?? {})).toBe(false);
  });

  it("maps delivered-only fields (detected_method/confidence_note/learned)", () => {
    const c = cfg({
      delivered: {
        description: "Shipped to production.",
        detected_method: "release_tag",
        confidence: "high",
        confidence_note: "Ships via GitHub Releases (v* tags).",
        learned: true,
        criteria: [{ text: "In a cut release", kind: "auto", signal: "in_release" }],
      },
    });
    const def = readStageDef(c, "delivered");
    expect(def?.detectedMethod).toBe("release_tag");
    expect(def?.confidence).toBe("high");
    expect(def?.confidenceNote).toBe("Ships via GitHub Releases (v* tags).");
    expect(def?.learned).toBe(true);
  });
});

describe("isDefined", () => {
  it("is false for undefined and the empty definition, true when there's content", () => {
    expect(isDefined(undefined)).toBe(false);
    expect(isDefined({ criteria: [] })).toBe(false);
    expect(isDefined({ description: "x", criteria: [] })).toBe(true);
    const withCrit: StageDefinition = { criteria: [{ text: "c", kind: "manual" }] };
    expect(isDefined(withCrit)).toBe(true);
  });
});
