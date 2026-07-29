#!/usr/bin/env node
// Prove the harness is deterministic: capture everything TWICE and compare every byte.
//
//   pnpm --filter @sparkle/desktop visual:verify-stable
//
// WHY THIS IS A SCRIPT AND NOT A NOTE IN A DOC. Byte-stability is the property the entire
// instrument rests on — a diff percentage means nothing if the same input gives different pixels —
// and it was recorded as a hand-run observation over 3 of the 12 artifacts. A one-time manual
// observation over a quarter of the output is not evidence that generalises, and nothing
// re-established it after a change. This makes it a check anyone can re-run, over ALL artifacts.
// (roborev 54760)
//
// It deliberately shells out to the real capture CLI twice rather than importing main(): the thing
// under test is what `visual:capture` actually produces, module state included.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./capture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Compare two capture directories file-by-file.
 *
 * Pure over the filesystem contents so it is unit-testable, and reports the three ways two runs can
 * disagree — a file only one run produced, and a file both produced with differing bytes — rather
 * than collapsing them into one boolean.
 */
export function compareDirs(dirA, dirB, { filter = (f) => f.endsWith(".png") } = {}) {
  const listing = (d) => readdirSync(d).filter(filter).sort();
  const a = listing(dirA);
  const b = listing(dirB);
  const onlyA = a.filter((f) => !b.includes(f));
  const onlyB = b.filter((f) => !a.includes(f));
  const common = a.filter((f) => b.includes(f));
  const differing = [];
  for (const f of common) {
    if (!readFileSync(join(dirA, f)).equals(readFileSync(join(dirB, f)))) differing.push(f);
  }
  return {
    compared: common.length,
    identical: common.length - differing.length,
    differing,
    onlyA,
    onlyB,
    stable: differing.length === 0 && onlyA.length === 0 && onlyB.length === 0 && common.length > 0,
  };
}

/**
 * Keep the capture directories, or delete them?
 *
 * Extracted as a pure function because it is the whole subject of this script's failure path and was
 * previously inline in a `finally`, where it could only be exercised by provoking a real determinism
 * failure — i.e. never, in practice. The regression it guards (evidence deleted at the one moment it
 * matters) is silent by construction, so it needs a test that does not spawn Chrome. (roborev 55089)
 *
 * @param keepArg  `args.keep`: `undefined` when unset, `"false"` for an explicit `--keep=false`,
 *                 anything else for an explicit keep.
 * @param outcome  `"stable"` | `"unstable"` | `"threw"`.
 * @param hasOutput Did either run actually write anything? A run-1 `execFileSync` failure (the
 *                 documented missing-Chrome case) throws with both directories still empty, and
 *                 announcing "artifacts kept for inspection" above a stack trace points the reader
 *                 at two empty directories and leaks them permanently.
 */
export function shouldKeep({ keepArg, outcome, hasOutput = true }) {
  // An explicit --keep is the user's call and wins even with nothing to show.
  if (keepArg !== undefined && keepArg !== "false") return true;
  if (outcome === "stable") return false;
  return hasOutput;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const passthrough = process.argv.slice(2).filter((a) => !a.startsWith("--out="));
  const dirs = [
    mkdtempSync(join(tmpdir(), "visual-stable-a-")),
    mkdtempSync(join(tmpdir(), "visual-stable-b-")),
  ];
  // The `finally` records only WHAT HAPPENED and defers the keep/clean rule to `shouldKeep`, so the
  // rule is testable without provoking a real failure. Starts at "threw": the only way out of the
  // try block without setting it is an exception.
  let outcome = "threw";

  try {
    for (const [i, dir] of dirs.entries()) {
      console.log(`[verify-stable] capture run ${i + 1} of 2 → ${dir}`);
      execFileSync(
        process.execPath,
        [join(HERE, "capture.mjs"), `--out=${dir}`, ...passthrough],
        { stdio: args.verbose ? "inherit" : ["ignore", "ignore", "inherit"] },
      );
    }

    const r = compareDirs(dirs[0], dirs[1]);
    console.log(
      `\n[verify-stable] ${r.identical}/${r.compared} artifacts byte-identical across two runs`,
    );
    for (const f of r.differing) console.log(`  DIFFERS: ${f}`);
    for (const f of r.onlyA) console.log(`  only in run 1: ${f}`);
    for (const f of r.onlyB) console.log(`  only in run 2: ${f}`);

    if (!r.stable) {
      console.error(
        "\n[verify-stable] NOT DETERMINISTIC. Every diff percentage this harness reports is\n" +
          "suspect until this passes — check the byte-stability list in README.md.",
      );
      // KEEP THE EVIDENCE. This used to delete both capture directories on the way out, so the two
      // differing PNGs — the entire reason to run this check — were gone by the time the message
      // above was read. `--keep` was no help: it has to be decided BEFORE you know you need it,
      // and a determinism failure is precisely the class of result that may not reproduce on the
      // next run. That inverted the normal convention (keep on failure, clean on success) in the
      // one script whose output is only interesting when it fails (roborev 54844).
      outcome = "unstable";
      return 1;
    }
    console.log("[verify-stable] deterministic ✓");
    outcome = "stable";
    return 0;
  } finally {
    // Per-directory counts, not a bare boolean: "run 2 never started" and "run 2 produced different
    // pixels" are different diagnoses, and the counts are what tell them apart at a glance.
    const counts = dirs.map((d) => {
      try {
        return readdirSync(d).length;
      } catch {
        return 0;
      }
    });
    if (shouldKeep({ keepArg: args.keep, outcome, hasOutput: counts.some((n) => n > 0) })) {
      const detail = dirs.map((d, i) => `${d} (${counts[i]} files)`).join(" ");
      console.log(`[verify-stable] artifacts kept for inspection: ${detail}`);
      console.log("[verify-stable] remove them when you are done — nothing else will.");
    } else {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
