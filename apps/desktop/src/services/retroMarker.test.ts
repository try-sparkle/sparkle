import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildRetroMarker,
  parseRetro,
  parseRetroMarker,
  RETRO_MARKER_PREFIX,
  RETRO_MARKER_SUFFIX,
  RETRO_MAX_PAIN_POINTS,
  type Retro,
} from "./retroMarker";

const sample: Retro = {
  tldr: "Added a retro emit contract and wired it into the worker persona.",
  percentComplete: 100,
  estCompletionMin: 0,
  details: ["Extended the schema", "Added a marker helper", "Updated three personas"],
  // Already in descending severity so a round-trip equals this object verbatim.
  painPoints: [
    {
      summary: "Worktree guard blocked direct file writes",
      severity: 3,
      recommendation: "Author files via Bash, the sanctioned escape hatch",
      subsystem: "worktree-guard",
    },
    {
      summary: "Schema file did not exist yet",
      severity: 2,
      recommendation: "Create it from the frozen shape",
      context: "A persona comment referenced a missing path",
    },
  ],
};

describe("parseRetro — validates the frozen retro shape (mirrors worker-retro.schema.json)", () => {
  it("accepts a well-formed retro and returns only the contract fields", () => {
    const r = parseRetro({ ...sample, extra: "dropped" } as unknown);
    expect(r.tldr).toBe(sample.tldr);
    expect(r.percentComplete).toBe(100);
    expect(r.estCompletionMin).toBe(0);
    expect(r.details).toEqual(sample.details);
    expect(r.painPoints).toHaveLength(2);
    expect((r as unknown as Record<string, unknown>).extra).toBeUndefined();
  });

  it("rejects a malformed retro, naming the offending field", () => {
    expect(() => parseRetro({ ...sample, tldr: "" })).toThrow(/tldr/);
    expect(() => parseRetro({ ...sample, percentComplete: 150 })).toThrow(/percentComplete/);
    expect(() => parseRetro({ ...sample, percentComplete: 50.5 })).toThrow(/percentComplete/);
    expect(() => parseRetro({ ...sample, estCompletionMin: -1 })).toThrow(/estCompletionMin/);
    expect(() => parseRetro({ ...sample, details: ["ok", 3] })).toThrow(/details/);
    expect(() =>
      parseRetro({ ...sample, painPoints: [{ summary: "x", severity: 5, recommendation: "y" }] }),
    ).toThrow(/severity/);
    expect(() =>
      parseRetro({ ...sample, painPoints: [{ summary: "x", severity: 2 }] }),
    ).toThrow(/recommendation/);
  });

  it("rejects more than the pain-point cap", () => {
    const many = Array.from({ length: RETRO_MAX_PAIN_POINTS + 1 }, () => ({
      summary: "s",
      severity: 1 as const,
      recommendation: "r",
    }));
    expect(() => parseRetro({ ...sample, painPoints: many })).toThrow(/painPoints/);
  });
});

describe("buildRetroMarker / parseRetroMarker — single-line PR-body marker round-trip", () => {
  it("emits one HTML-comment line with no interior newline", () => {
    const marker = buildRetroMarker(sample);
    expect(marker.startsWith(RETRO_MARKER_PREFIX)).toBe(true);
    expect(marker.endsWith(RETRO_MARKER_SUFFIX)).toBe(true);
    expect(marker.includes("\n")).toBe(false);
  });

  it("recovers the retro from a marker embedded in a realistic PR body", () => {
    const marker = buildRetroMarker(sample);
    const prBody = [
      "## What & why",
      "This PR wires up the retro emit contract.",
      "",
      "<!-- sparkle:pr-owner some-agent-id -->",
      marker,
      "",
      "Closes bd-1234.",
    ].join("\n");
    // LOAD-BEARING: the marker embedded in prose is recovered byte-for-byte.
    expect(parseRetroMarker(prBody)).toEqual(sample);
  });

  it("orders pain points by descending severity and caps at the max", () => {
    const scrambled: Retro = {
      ...sample,
      painPoints: [
        { summary: "low", severity: 1, recommendation: "r" },
        { summary: "blocker", severity: 4, recommendation: "r" },
        { summary: "mid", severity: 2, recommendation: "r" },
      ],
    };
    const recovered = parseRetroMarker(buildRetroMarker(scrambled));
    expect(recovered?.painPoints.map((p) => p.severity)).toEqual([4, 2, 1]);
  });

  it("returns null when no valid marker is present", () => {
    expect(parseRetroMarker("no marker here")).toBeNull();
    expect(parseRetroMarker("<!-- sparkle:retro not json -->")).toBeNull();
    expect(parseRetroMarker("")).toBeNull();
  });

  it("returns the LAST marker when a PR body carries more than one", () => {
    const first = buildRetroMarker({ ...sample, percentComplete: 40 });
    const second = buildRetroMarker({ ...sample, percentComplete: 100 });
    const recovered = parseRetroMarker(`${first}\nsome edit later\n${second}`);
    expect(recovered?.percentComplete).toBe(100);
  });
});

describe("worker-retro.schema.json stays in step with the TS contract", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../../../../docs/schemas/worker-retro.schema.json", import.meta.url), "utf8"),
  );

  it("declares exactly the frozen top-level required fields", () => {
    expect(schema.required).toEqual([
      "tldr",
      "percentComplete",
      "estCompletionMin",
      "details",
      "painPoints",
    ]);
  });

  it("bounds severity 1-4 and caps pain points at the same max as the TS helper", () => {
    const pp = schema.properties.painPoints;
    expect(pp.maxItems).toBe(RETRO_MAX_PAIN_POINTS);
    expect(pp.items.properties.severity.minimum).toBe(1);
    expect(pp.items.properties.severity.maximum).toBe(4);
    expect(pp.items.required).toEqual(["summary", "severity", "recommendation"]);
  });
});
