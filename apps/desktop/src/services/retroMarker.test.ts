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

  // AUTHORSHIP AMBIGUITY (bead sparkle-h16j26) — mirrors capture-merge-retro.sh tests 8b/8b2/8b3.
  it("refuses (returns null) when a PR body carries two DISTINCT valid markers", () => {
    const first = buildRetroMarker({ ...sample, percentComplete: 40 });
    const second = buildRetroMarker({ ...sample, percentComplete: 100 });
    // A shared-temp collision or foreign re-append left a second agent's marker: picking either
    // one would file the wrong agent's retro, so the ambiguous body is refused outright.
    expect(parseRetroMarker(`${first}\nsome edit later\n${second}`)).toBeNull();
  });

  it("still returns the retro when IDENTICAL markers are repeated (benign re-append)", () => {
    const marker = buildRetroMarker({ ...sample, percentComplete: 55 });
    const recovered = parseRetroMarker(`${marker}\nprose\n${marker}`);
    expect(recovered?.percentComplete).toBe(55);
  });

  it("ignores a doc placeholder marker and returns the one real marker", () => {
    const marker = buildRetroMarker(sample);
    // The literal `<!-- sparkle:retro {json} -->` documentation placeholder does not parse as a
    // retro, so it does not count toward distinctness and must not trigger a refusal.
    const prBody = `See the format: <!-- sparkle:retro {json} -->\n\n${marker}`;
    expect(parseRetroMarker(prBody)).toEqual(sample);
  });

  // Distinctness uses the SAME loose predicate as capture-merge-retro.sh (JSON + array painPoints),
  // NOT the strict schema — otherwise an off-schema own marker beside a well-formed foreign one
  // would be refused by the shell but accepted here, the exact mis-attribution the guard prevents.
  it("refuses an off-schema (painPoints-only) marker beside a well-formed foreign one", () => {
    // The exact mis-attribution scenario: this PR's OWN marker is off-schema (painPoints-only, no
    // tldr — plausible LLM-authored JSON), and a shared-temp collision left a well-formed FOREIGN
    // marker. Under a STRICT distinctness predicate only the foreign one counts (size 1) and it is
    // returned — the bug. Under the LOOSE predicate (matching the shell) both count (size 2) → null.
    const offSchema = '<!-- sparkle:retro {"painPoints":[{"summary":"mine","severity":2,"recommendation":"x"}]} -->';
    const foreign = buildRetroMarker({ ...sample, tldr: "someone else's work" });
    expect(parseRetroMarker(`${offSchema}\ncollision\n${foreign}`)).toBeNull();
  });

  it("collapses re-serialized identical retros (different key order) instead of refusing", () => {
    const a = '<!-- sparkle:retro {"tldr":"t","percentComplete":90,"estCompletionMin":30,"details":["d"],"painPoints":[{"summary":"s","severity":2,"recommendation":"r"}]} -->';
    const b = '<!-- sparkle:retro {"painPoints":[{"recommendation":"r","severity":2,"summary":"s"}],"details":["d"],"estCompletionMin":30,"percentComplete":90,"tldr":"t"} -->';
    // Same retro, keys in a different order — canonicalization makes them one marker, not two.
    const recovered = parseRetroMarker(`${a}\nedit\n${b}`);
    expect(recovered?.tldr).toBe("t");
    expect(recovered?.painPoints).toHaveLength(1);
  });

  // Extraction must mirror the shell: capture to the LAST `} -->` on the line, so a payload whose
  // prose contains `-->` or even `} -->` is captured whole rather than truncated at the first `-->`.
  it("captures a payload whose string contains `-->` / `} -->` whole (mirrors shell 8b7/8b9)", () => {
    const raw = { ...sample, tldr: "we split at the real } --> terminator now" };
    const marker = `<!-- sparkle:retro ${JSON.stringify(raw)} -->`;
    expect(marker.includes("-->", RETRO_MARKER_PREFIX.length)).toBe(true); // the payload really has it
    const recovered = parseRetroMarker(`prose\n${marker}\nmore prose`);
    expect(recovered?.tldr).toBe("we split at the real } --> terminator now");
  });

  it("still refuses when a `-->`-bearing own marker sits beside a foreign one (no mis-attribution)", () => {
    const own = `<!-- sparkle:retro ${JSON.stringify({ ...sample, tldr: "mine } --> x" })} -->`;
    const foreign = `<!-- sparkle:retro ${JSON.stringify({ ...sample, tldr: "not mine" })} -->`;
    // Both extract whole → two distinct valid markers → ambiguous → refuse (never return foreign).
    expect(parseRetroMarker(`${own}\ncollision\n${foreign}`)).toBeNull();
  });

  // Parse-driven extraction: prose AFTER the marker containing `} -->` must not over-capture (the
  // longest candidate that PARSES wins, so `{…}` beats `{…} --> prose }`).
  it("ignores trailing prose containing `} -->` on the marker's line", () => {
    const marker = buildRetroMarker(sample);
    const recovered = parseRetroMarker(`${marker} note: we split at the real } --> terminator now`);
    expect(recovered).toEqual(sample);
  });

  it("refuses when a trailing-`} -->`-prose own marker sits beside a foreign one", () => {
    const own = `${buildRetroMarker({ ...sample, tldr: "mine" })} aside } --> x`;
    const foreign = buildRetroMarker({ ...sample, tldr: "not mine" });
    expect(parseRetroMarker(`${own}\n${foreign}`)).toBeNull();
  });

  // The marker PREFIX quoted inside a payload string must not be treated as a second marker start.
  it("captures a payload whose string quotes the marker prefix, whole", () => {
    const raw = { ...sample, tldr: "docs quote <!-- sparkle:retro {json} --> verbatim" };
    const marker = `<!-- sparkle:retro ${JSON.stringify(raw)} -->`;
    const recovered = parseRetroMarker(`intro\n${marker}\noutro`);
    expect(recovered?.tldr).toBe("docs quote <!-- sparkle:retro {json} --> verbatim");
  });

  it("refuses when a prefix-quoting own marker sits beside a foreign one", () => {
    const own = `<!-- sparkle:retro ${JSON.stringify({ ...sample, tldr: "quote <!-- sparkle:retro {x} --> end" })} -->`;
    const foreign = buildRetroMarker({ ...sample, tldr: "foreign" });
    expect(parseRetroMarker(`${own}\n${foreign}`)).toBeNull();
  });

  // A real marker sharing a line AFTER a placeholder must still be found (the scan keeps going past
  // a prefix whose payload did not parse) — mirrors shell 8b14.
  it("finds a real marker that shares a line after a doc placeholder", () => {
    const marker = buildRetroMarker(sample);
    expect(parseRetroMarker(`see <!-- sparkle:retro {json} --> and the real one ${marker}`)).toEqual(sample);
  });

  // PERMISSIVE LOCATION (mirror of shell 8b15): stray text or a newline between the prefix and the
  // payload's `{` must NOT stop the marker from counting — the SAFE direction, so such a marker still
  // triggers refusal beside a foreign one instead of letting the foreign retro be the lone survivor.
  it("captures an own marker with stray text before its `{` (permissive location)", () => {
    const raw = { ...sample, tldr: "junk-prefixed" };
    expect(parseRetroMarker(`<!-- sparkle:retro RETRO ${JSON.stringify(raw)} -->`)?.tldr).toBe("junk-prefixed");
  });

  it("refuses when a stray-text-prefixed own marker sits beside a foreign one", () => {
    const own = `<!-- sparkle:retro RETRO ${JSON.stringify({ ...sample, tldr: "mine" })} -->`;
    const foreign = buildRetroMarker({ ...sample, tldr: "foreign" });
    expect(parseRetroMarker(`${own}\n${foreign}`)).toBeNull();
  });

  it("captures an own marker whose payload sits on the line after the prefix (newline wrap)", () => {
    const raw = { ...sample, tldr: "newline-wrapped" };
    expect(parseRetroMarker(`<!-- sparkle:retro\n${JSON.stringify(raw)} -->`)?.tldr).toBe("newline-wrapped");
  });

  it("refuses when a newline-wrapped own marker sits beside a foreign one", () => {
    const own = `<!-- sparkle:retro\n${JSON.stringify({ ...sample, tldr: "mine" })} -->`;
    const foreign = buildRetroMarker({ ...sample, tldr: "foreign" });
    expect(parseRetroMarker(`${own}\n${foreign}`)).toBeNull();
  });

  // Stray text CONTAINING a brace before the payload: back off to the next `{` (mirror of shell 8b17).
  it("backs off past a brace in stray text to capture the real payload", () => {
    const raw = { ...sample, tldr: "brace-in-junk" };
    expect(parseRetroMarker(`<!-- sparkle:retro v2 {schema} ${JSON.stringify(raw)} -->`)?.tldr).toBe("brace-in-junk");
  });

  it("refuses when a brace-in-junk own marker sits beside a foreign one", () => {
    const own = `<!-- sparkle:retro v2 {schema} ${JSON.stringify({ ...sample, tldr: "mine" })} -->`;
    const foreign = buildRetroMarker({ ...sample, tldr: "foreign" });
    expect(parseRetroMarker(`${own}\n${foreign}`)).toBeNull();
  });

  // Unicode-space separators (U+00A0 etc.) are FOLDED to a space on both sides, so an odd-space
  // marker still counts (the safe direction). MUST match the shell's byte-fold list.
  it("folds a Unicode-space (U+00A0) separator so the marker still counts", () => {
    const raw = { ...sample, tldr: "nbsp-separated" };
    const marker = "<!-- sparkle:retro\u00a0" + JSON.stringify(raw) + " -->";
    expect(parseRetroMarker(marker)?.tldr).toBe("nbsp-separated");
  });

  it("refuses when a Unicode-space-separated own marker sits beside a foreign one", () => {
    const own = "<!-- sparkle:retro\u00a0" + JSON.stringify({ ...sample, tldr: "mine" }) + " -->";
    const foreign = buildRetroMarker({ ...sample, tldr: "foreign" });
    expect(parseRetroMarker(own + "\n" + foreign)).toBeNull();
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
