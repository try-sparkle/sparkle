import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE DOC TABLE IS A SECOND COPY OF THE CLASSIFICATION, AND NOTHING DETECTED ITS DRIFT.
//
// `docs/live-browser-preview.md`'s security review carries a `*`-default row that a reader is
// invited to check the control against. It sat at pre-correction contents through FOUR corrections
// of the source list, because the only thing tying them together was a sentence asking people to
// keep them in step. Prose documents drift; it does not detect it.
//
// The source list itself is well pinned (`Workspace.previewSlot.test.tsx` compares the parsed
// `allow` attribute against a literal set, so an edit has to be mirrored deliberately). This closes
// the other half: the `*` row must be exactly the source's `*` block, so a feature added to that
// block reds this test until the doc names it too.
//
// SCOPED TO THE `*` ROW ON PURPOSE. That row is exhaustive because it is the class an empty
// `allow` would leave open — the whole reason the file exists. The `self` row is illustrative (7 of
// 18) and the doc says so; asserting it would either force 18 names into a table cell or fail
// forever.
const SOURCE = fileURLToPath(new URL("./previewPermissionsPolicy.ts", import.meta.url));
const DOC = fileURLToPath(new URL("../../../../docs/live-browser-preview.md", import.meta.url));

/** The `*`-default block of `DENIED_FEATURES`, read from the source's own section markers. */
function starBlockFromSource(): string[] {
  const src = readFileSync(SOURCE, "utf8");
  const start = src.indexOf("── DEFAULT ALLOWLIST `*`");
  const end = src.indexOf("── DEFAULT ALLOWLIST `self`");
  expect(start, "the source must still carry its `*` section marker").toBeGreaterThan(-1);
  expect(end, "…and its `self` marker").toBeGreaterThan(start);
  // PERMISSIVE ON BOTH SIDES, for the reason spelled out over `starRowFromDoc`. The first version
  // of this file fixed the blindness on the doc side and left it here — so an entry added to the
  // source's `*` block that the pattern did not recognise (a capital, a digit, a typo) dropped out
  // of THIS set instead, the doc would not name it either, the two still agreed, and the guard
  // passed. Same hole, other end.
  // MATCH THE QUOTED ENTRY AND STOP CARING WHAT FOLLOWS. This pattern has now been narrowed twice
  // by "fixes" for its narrowness, and each miss is the silent kind — the entry drops out of this
  // set, the doc does not name it either, the sets agree, and the guard passes green. Three shapes
  // it must survive, all mutation-verified: a trailing comment (`"x", // note`), a space before the
  // comma (`"x" ,`), and NO comma at all (the block's last element, which is what the `*` block
  // becomes if the `self` block is ever moved or removed). A formatting variant must never be what
  // decides whether a permissions-policy feature is covered.
  return [...src.slice(start, end).matchAll(/^\s*"([^"]+)"\s*,?/gm)].map((m) => m[1]!);
}

/** The feature names in the doc table's `*` row. */
function starRowFromDoc(): string[] {
  const doc = readFileSync(DOC, "utf8");
  const row = doc.split("\n").find((l) => l.startsWith("| `*` |"));
  expect(row, "the doc must still carry a `*` row in its default-allowlist table").toBeDefined();
  // Cell 2 only: cells 3 and 4 are the yes/no verdicts and carry no feature names.
  const cell = row!.split("|")[2] ?? "";
  // PERMISSIVE ON PURPOSE — every backticked token, not `[a-z-]+`. A narrow pattern silently SKIPS
  // anything it does not recognise, so a name with a typo, a capital, or a stray character drops
  // out of the doc list and the set comparison still passes: the guard would be blind to exactly
  // the malformed entry it should catch. Verified by mutation — the narrow form passed against a
  // `MUTANT-feature` inserted into the row.
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

describe("the doc's `*`-default row and DENIED_FEATURES' `*` block are one list", () => {
  it("names exactly the same features", () => {
    const source = starBlockFromSource();
    const doc = starRowFromDoc();

    // Non-empty first: two failed parses would otherwise "agree" as empty sets, which is the
    // vacuous shape this whole file is guarding against elsewhere.
    expect(source.length).toBeGreaterThan(10);
    expect(doc.length).toBeGreaterThan(10);
    expect(new Set(doc)).toEqual(new Set(source));
  });

  it("keeps the row exhaustive rather than a sample", () => {
    // The `self` row is allowed to be illustrative and the doc says which is which. If that
    // sentence is ever removed, this pairing is the thing that makes the asymmetry legible.
    expect(readFileSync(DOC, "utf8")).toMatch(/The `\*`\s*\n?row is \*\*exhaustive\*\*/);
  });
});
