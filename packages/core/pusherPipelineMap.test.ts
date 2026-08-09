// THE PIPELINE MAP IN `index.ts` IS AN INDEX, AND AN INDEX THAT DRIFTS IS WORSE THAN NONE.
//
// The map exists because finding the right seam in the Pusher used to mean reading every
// `pusher*.ts` header to work out which one owned which stage. A hand-maintained table fixes that
// exactly once and then rots — the next module lands, nobody remembers the comment, and an agent
// trusting the map reads a file list that is quietly wrong. That is strictly worse than the headers
// alone, because the headers cannot lie about the set.
//
// So the map is checked against the directory. Adding `pusherFoo.ts` without giving it a row here
// fails, and so does a row naming a module that no longer exists.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE_DIR = fileURLToPath(new URL(".", import.meta.url));
const INDEX = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

/**
 * The OWNER column of the pipeline table, and only that column.
 *
 * Delimited rather than pattern-matched over the whole file: the prose around the table names
 * `services/pusherRunner.ts` and this test file, neither of which is a `packages/core` module, so a
 * loose `pusher\w+\.ts` sweep would report ghosts. The table runs from its `STAGE  OWNER` header to
 * the first bare `//` line after it.
 */
function mappedModules(): string[] {
  const lines = INDEX.split("\n");
  const start = lines.findIndex((l) => /^\/\/\s+STAGE\s+OWNER\b/.test(l));
  if (start === -1) return [];

  const named: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "//") break;
    for (const m of line.matchAll(/\b(pusher[A-Za-z]+)\.ts\b/g)) {
      if (m[1]) named.push(m[1]);
    }
  }
  return named;
}

function pusherModulesOnDisk(): string[] {
  return readdirSync(CORE_DIR)
    .filter((f) => /^pusher[A-Za-z]+\.ts$/.test(f) && !f.endsWith(".test.ts"))
    .map((f) => f.replace(/\.ts$/, ""));
}

describe("the pusher pipeline map in index.ts", () => {
  it("is present and anchored, so removing the table fails rather than passing vacuously", () => {
    // Without this, deleting the whole comment block would make every set comparison below
    // compare [] against [] once the modules also vanished — and, worse, would read as green the
    // moment the anchor line was merely reworded.
    expect(mappedModules().length).toBeGreaterThan(0);
  });

  it("gives every pusher module in this package a stage", () => {
    const undocumented = pusherModulesOnDisk().filter((m) => !mappedModules().includes(m));
    expect(
      undocumented,
      "these modules exist but no stage in the index.ts pipeline map claims them",
    ).toEqual([]);
  });

  it("names no module that does not exist", () => {
    const onDisk = pusherModulesOnDisk();
    const ghosts = mappedModules().filter((m) => !onDisk.includes(m));
    expect(ghosts, "the pipeline map names modules that are not in this package").toEqual([]);
  });

  it("only maps modules the package actually exports", () => {
    const unexported = mappedModules().filter(
      (m) => !INDEX.includes(`export * from "./${m}"`),
    );
    expect(
      unexported,
      "mapped as part of the pipeline but not re-exported from the package root",
    ).toEqual([]);
  });
});
