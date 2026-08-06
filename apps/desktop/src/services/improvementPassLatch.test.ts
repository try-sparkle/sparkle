// THE LATCH, AND THE BOUNDARY THAT IS THE REASON IT IS A SEPARATE FILE.
//
// Two unrelated-looking things are asserted together on purpose: the second is what the first is
// FOR. A future reader who moves `passRunning` back into `improvementPass` gets a green latch suite
// and a red boundary suite, sitting side by side, saying why.
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claimPass, releasePass, isPassRunning } from "./improvementPassLatch";

beforeEach(() => releasePass());
afterEach(() => releasePass());

describe("the in-flight latch", () => {
  it("is clear before anything claims it — the inverse guard", () => {
    // Without this, a latch hardwired to `true` would satisfy the claim case below while holding the
    // concierge's write gate shut forever.
    expect(isPassRunning()).toBe(false);
  });

  it("reads busy once claimed, and clear once released", () => {
    expect(claimPass()).toBe(true);
    expect(isPassRunning()).toBe(true);
    releasePass();
    expect(isPassRunning()).toBe(false);
  });

  it("REFUSES a second claim while the first still holds it", () => {
    // The check and the set are one call for exactly this: as two statements at the call site, a
    // second pass can be admitted between them, and two `claude -p` children in one worktree is the
    // collision the whole gate exists to prevent.
    expect(claimPass()).toBe(true);
    expect(claimPass()).toBe(false);
    // ...and the first holder's latch is untouched by the refusal, so its own release still clears.
    expect(isPassRunning()).toBe(true);
  });

  it("tolerates a release with nothing held", () => {
    // `runImprovementPass` releases in a `finally`, which runs on paths that never claimed.
    releasePass();
    expect(isPassRunning()).toBe(false);
  });
});

// ── THE IMPORT BOUNDARY ────────────────────────────────────────────────────────────────────────
//
// `services/sparkleBusy` is read by `conciergeTools/lifecycle`, which is read by
// `conciergeTools/policy`, which is read by `stores/settingsStore` — a store ordinary UI components
// import. So anything sparkleBusy imports is acquired by a large slice of the component tree.
//
// When sparkleBusy took `isPassRunning` from `improvementPass` itself, that slice grew to include
// the pass, `sparkleTranscript`, and `conciergeTools/terminal`. The failure that produced named
// none of those: `Composer.suggestionDeadPty.test.tsx` died at COLLECTION on a missing
// `SNAPSHOT_MAX_LINES` export of a `terminalScrollback` mock it had written long before, because
// `conciergeTools/terminal` reads that symbol at module scope. A test file the change never touched,
// over a symbol it never mentions — the module graph was the entire link, which is why a comment
// asking people not to do it again is not enough.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

/** Resolve a relative specifier the way the bundler does, or null for a package import. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every static `import`/`export ... from` specifier in a file. Static only, deliberately: a
 *  dynamic `await import()` does NOT put the target in the importer's eager graph, which is the
 *  thing being bounded here. */
const FROM_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g;

/** Breadth-first walk of the static graph, returning the path to `target` or null. */
function importPath(entry: string, target: string): string[] | null {
  const cameFrom = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) {
      const chain: string[] = [];
      for (let node: string | null = current; node; node = cameFrom.get(node) ?? null) {
        chain.push(relative(SRC, node));
      }
      return chain.reverse();
    }
    let source: string;
    try {
      source = readFileSync(current, "utf8");
    } catch {
      continue;
    }
    FROM_RE.lastIndex = 0;
    for (let m = FROM_RE.exec(source); m !== null; m = FROM_RE.exec(source)) {
      const spec = m[1];
      if (spec === undefined) continue;
      const next = resolveSpec(current, spec);
      if (next !== null && !cameFrom.has(next)) {
        cameFrom.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
}

describe("the settings-store graph does not reach the improvement pass", () => {
  const settingsStore = resolve(SRC, "stores/settingsStore.ts");
  const pass = resolve(SRC, "services/improvementPass.ts");
  const latch = resolve(SRC, "services/improvementPassLatch.ts");
  const terminal = resolve(SRC, "services/conciergeTools/terminal.ts");

  it("proves the walker works, by finding a path it MUST find", () => {
    // Without this the two assertions below would pass just as well against a broken walker that
    // returns null for everything — the exact vacuous shape this repo keeps paying for. The
    // settings store really does reach the concierge policy table; that edge predates this work.
    const known = importPath(settingsStore, resolve(SRC, "services/conciergeTools/policy.ts"));
    expect(known).not.toBeNull();
    expect(known![0]).toBe("stores/settingsStore.ts");
  });

  it("cannot reach services/improvementPass", () => {
    const found = importPath(settingsStore, pass);
    expect(found === null ? null : found.join(" -> ")).toBeNull();
  });

  it("cannot reach services/conciergeTools/terminal", () => {
    // The consequence rather than the cause — and the one that actually broke a suite. Asserted
    // separately so a future edge that reaches terminal by some OTHER route is caught too.
    const found = importPath(settingsStore, terminal);
    expect(found === null ? null : found.join(" -> ")).toBeNull();
  });

  it("still reaches the LATCH — the boundary bounds dependencies, it does not sever the feature", () => {
    // The write gate must keep working. If this ever goes null, `sparkleBusy` has stopped consulting
    // the latch at all and the two assertions above have become trivially true.
    const found = importPath(settingsStore, latch);
    expect(found).not.toBeNull();
  });
});
