import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// A source file containing a raw NUL byte is treated as BINARY by git. That is not cosmetic: the
// file stops producing diffs entirely. `git show` prints "Binary files ... differ", the PR renders
// no lines, `git blame` is useless, and any review tooling that reads the patch sees nothing.
//
// This happened on 2026-07-20 in orchestrationListener.ts. `beadKey` joined its parts with a raw
// control character instead of the six-character source escape:
//
//     return `${projectId}<raw NUL>${buildAgentId}<raw NUL>${beadId}`;
//
// NUL is a fine delimiter — it cannot occur in a uuid — and the runtime string is identical either
// way. Only the SOURCE encoding differs. The commit that introduced it carried a long, careful
// explanation of a subtle concurrency guard, and not one line of that code was visible to a
// reviewer. It landed in the same batch as the PR gate added to strengthen review.
//
// So the escape is not a style preference; it is what keeps the file reviewable. This guard is
// repo-wide because nothing about the mistake is specific to one package.

// fileURLToPath, NOT url.pathname: pathname leaves percent-encoding intact, so a repo living under
// a path with a space ("Application Support", which is exactly where this app checks itself out)
// yields ".../Application%20Support/...". Every readdirSync then throws ENOENT, the catch below
// swallows it, and the scan reports zero offenders while having read zero files. The first draft of
// this guard shipped that bug and passed with a raw NUL sitting in the tree.
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const ROOTS = ["apps/desktop/src", "apps/mcp-control/src", "apps/mcp-orchestrator/src"];
const EXTS = [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json", ".css"];

function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a package that isn't checked out here is not a failure
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(sourceFiles(full));
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

/** Every source file the guard looks at. Shared so the scan and its anti-vacuity check can never
 *  drift apart — a guard that reports "0 offenders" after reading 0 files is not a passing test. */
function scanned(): string[] {
  return ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)));
}

describe("source files stay text, so git can diff them", () => {
  it("actually reads the tree it claims to guard", () => {
    // The load-bearing assertion. sourceFiles() swallows ENOENT so a package absent from this
    // checkout isn't a failure — which also means a WRONG root path silently scans nothing and the
    // real test below passes vacuously. That is precisely how the first draft shipped green with a
    // raw NUL in the tree. Pin a floor: desktop/src alone is several hundred files.
    const files = scanned();
    expect(files.length, `resolved REPO_ROOT=${REPO_ROOT}`).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith("orchestrationListener.ts"))).toBe(true);
  });

  it("no tracked source file contains a raw NUL byte", () => {
    const offenders: string[] = [];
    for (const file of scanned()) {
      if (readFileSync(file).includes(0x00)) offenders.push(relative(REPO_ROOT, file));
    }
    expect(
      offenders,
      `These files contain a raw NUL and git will treat them as BINARY — no diffs, no review.\n` +
        `Write the escape (\\u0000) in source instead; the runtime string is identical.\n` +
        offenders.map((f) => `  - ${f}`).join("\n"),
    ).toEqual([]);
  });

  it("distinguishes a raw NUL from its source escape", () => {
    // The escape is what we want in source; the raw byte is what breaks git. Both encode the same
    // runtime string, which is why the fix is safe and why only the encoding matters here.
    const withNul = Buffer.from(`const k = \`a${String.fromCharCode(0)}b\`;`, "utf8");
    const withEscape = Buffer.from("const k = `a\\u0000b`;", "utf8");
    expect(withNul.includes(0x00)).toBe(true);
    expect(withEscape.includes(0x00)).toBe(false);
    // ...and they evaluate identically, so swapping one for the other is behaviour-preserving.
    // JSON.parse decodes the escape without this file having to contain either form — writing
    // the raw byte here would make THIS file binary, and writing the escape would just restate
    // the line above. Both sides below are built, not literal.
    expect(JSON.parse(String.raw`"a\u0000b"`)).toBe("a" + String.fromCharCode(0) + "b");
  });
});
