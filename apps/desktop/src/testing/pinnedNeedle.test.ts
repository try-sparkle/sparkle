import { describe, expect, it } from "vitest";
import { assertPinnedNeedle, needleIsUsed } from "./pinnedNeedle";

// The defect this guard exists to catch, verbatim in shape: the file IMPORTS the identifier it is
// being pinned on, and uses it in a loop. Deleting the loop must change the verdict — that is the
// whole point, and it is asserted directly below rather than inferred.
const TS_TARGET = [
  `import { readFileSync } from "node:fs";`,
  `import { CHECKS, LINT_CHECK_IDS } from "./conciergeLint";`,
  ``,
  `// LINT_CHECK_IDS is named in this comment too, which still does not use it.`,
  `export function run(reply: string) {`,
  `  for (const check of CHECKS) {`,
  `    if (check.test(reply)) return check.id;`,
  `  }`,
  `  return null;`,
  `}`,
].join("\n");

const TS_TARGET_WITH_LOOP_DELETED = TS_TARGET.split("\n")
  .filter((l) => !l.includes("for (const check of CHECKS)"))
  .join("\n");

describe("assertPinnedNeedle", () => {
  it("rejects a bare identifier that only appears in the import block", () => {
    // `CHECKS` IS in the file — `toContain` would pass here. That is the bug.
    expect(TS_TARGET).toContain("CHECKS");
    expect(() => assertPinnedNeedle(TS_TARGET, "LINT_CHECK_IDS", "conciergeLint.ts")).toThrow(/VACUOUS/);
  });

  it("accepts an expression pinned from the use site", () => {
    expect(() => assertPinnedNeedle(TS_TARGET, "for (const check of CHECKS)")).not.toThrow();
  });

  it("fails when the pinned use site is deleted — the pin is not vacuous", () => {
    // The mutation the old bare-identifier pin could not see: the loop is gone, the import remains.
    expect(TS_TARGET_WITH_LOOP_DELETED).toContain("CHECKS");
    expect(() => assertPinnedNeedle(TS_TARGET_WITH_LOOP_DELETED, "for (const check of CHECKS)")).toThrow(
      /not found/,
    );
  });

  it("distinguishes a drifted target from a vacuous pin", () => {
    expect(() => assertPinnedNeedle(TS_TARGET, "nowhere_at_all")).toThrow(/not found/);
    expect(() => assertPinnedNeedle(TS_TARGET, "readFileSync")).toThrow(/VACUOUS/);
  });

  it("names the target in both messages so a failure says which file drifted", () => {
    expect(() => assertPinnedNeedle(TS_TARGET, "nope", "config.rs")).toThrow(/config\.rs/);
    expect(() => assertPinnedNeedle(TS_TARGET, "readFileSync", "config.rs")).toThrow(/config\.rs/);
  });
});

describe("needleIsUsed — multi-line import blocks", () => {
  const MULTILINE_TS = [
    `import {`,
    `  ALPHA,`,
    `  BETA,`,
    `} from "./consts";`,
    ``,
    `export const total = ALPHA + 1;`,
  ].join("\n");

  it("does not count a specifier on an interior line of an import block", () => {
    // BETA only ever appears between `import {` and the closing `};` — no use anywhere.
    expect(needleIsUsed(MULTILINE_TS, "BETA")).toBe(false);
  });

  it("still counts a real use of a name that is also imported", () => {
    expect(needleIsUsed(MULTILINE_TS, "ALPHA + 1")).toBe(true);
    expect(needleIsUsed(MULTILINE_TS, "ALPHA")).toBe(true);
  });

  it("handles Rust `use` blocks on the other side of a cross-language pin", () => {
    const RUST = [
      `use serde::{`,
      `    Deserialize,`,
      `    Serialize,`,
      `};`,
      `pub use crate::config::DEFAULT_CONCIERGE_CHECKS;`,
      ``,
      `fn load() -> Vec<Check> {`,
      `    DEFAULT_CONCIERGE_CHECKS.to_vec()`,
      `}`,
    ].join("\n");

    expect(needleIsUsed(RUST, "Deserialize")).toBe(false);
    expect(needleIsUsed(RUST, "DEFAULT_CONCIERGE_CHECKS.to_vec()")).toBe(true);
  });

  it("does not mistake a Rust attribute for a comment line", () => {
    // `#[derive(...)]` starts with `#`, but it is code and can legitimately be pinned.
    const RUST_ATTR = [`#[derive(Serialize)]`, `struct Check {}`].join("\n");
    expect(needleIsUsed(RUST_ATTR, "#[derive(Serialize)]")).toBe(true);
  });

  it("does not count a name that appears only inside a block comment", () => {
    const COMMENTED = [`/**`, ` * mentions HANDLE_RESET but never calls it`, ` */`, `export const x = 1;`].join(
      "\n",
    );
    expect(needleIsUsed(COMMENTED, "HANDLE_RESET")).toBe(false);
  });
});
