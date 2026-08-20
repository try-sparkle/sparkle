// THE DRIFT GUARD. `researchPool.ts` mirrors two numbers that are DECLARED in Rust, so the only
// thing that makes the mirror trustworthy is a test that reads the original.
//
// It is written to fail LOUDLY and never to pass by default, because the failure it replaces was
// itself a silence: three TypeScript comments went on asserting `MAX_CONCURRENT_RESEARCH is 2` for
// six days after it became 16, and nothing anywhere could notice. An unreadable or unparseable
// `research.rs` is therefore an ERROR, not a skip — "we could not check" must not render as green,
// which is the whole shape of the bug this file exists to end.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MAX_CONCURRENT_RESEARCH, MAX_RESEARCH_WAITERS } from "./researchPool";

/**
 * The Rust that owns both numbers.
 *
 * Resolved from THIS file's URL rather than from `process.cwd()`: vitest is invoked from the package
 * directory by `pnpm --filter`, from the repo root by the workspace run, and from a shard's own
 * directory in CI — a cwd-relative path is green under one of those and a spurious failure under the
 * others.
 */
const RESEARCH_RS = fileURLToPath(
  new URL("../../apps/desktop/src-tauri/src/research.rs", import.meta.url),
);

function rustSource(): string {
  // NOT wrapped in a try/catch that returns "". An empty source would make every regex below miss,
  // and a miss is reported as a failure — but with a message blaming the constant rather than the
  // read, which sends the next reader to the wrong file. Let the ENOENT surface as itself.
  return readFileSync(RESEARCH_RS, "utf8");
}

/** The literal on a `const NAME: usize = <n>;` line, or `null` when the declaration is not there. */
function rustUsize(src: string, name: string): number | null {
  const m = new RegExp(String.raw`const\s+${name}\s*:\s*usize\s*=\s*(\d+)\s*;`).exec(src);
  return m?.[1] === undefined ? null : Number(m[1]);
}

describe("the TypeScript mirror of the research pool matches the Rust that owns it", () => {
  it("reads the Rust source at all", () => {
    // Asserted separately so a MOVED file reports as "the path is wrong" rather than as "the
    // constant changed" — different repairs, and guessing wrong costs a wrong investigation.
    expect(rustSource()).toContain("MAX_CONCURRENT_RESEARCH");
  });

  it("pins MAX_CONCURRENT_RESEARCH to the Rust declaration", () => {
    const rust = rustUsize(rustSource(), "MAX_CONCURRENT_RESEARCH");
    expect(rust).not.toBeNull();
    expect(MAX_CONCURRENT_RESEARCH).toBe(rust);
  });

  it("pins MAX_RESEARCH_WAITERS to the Rust declaration", () => {
    const rust = rustUsize(rustSource(), "MAX_RESEARCH_WAITERS");
    expect(rust).not.toBeNull();
    expect(MAX_RESEARCH_WAITERS).toBe(rust);
  });

  // THE VALUE, not only the agreement. Both assertions above hold if the Rust and the mirror are
  // changed together back to 2 — which is the state the founder actually complained about, and the
  // one this whole branch exists to leave behind. This is the test that reads the literal.
  it("is SIXTEEN, the value the founder raised it to on 2026-08-13", () => {
    expect(MAX_CONCURRENT_RESEARCH).toBe(16);
    expect(MAX_RESEARCH_WAITERS).toBe(64);
  });
});

// ══ THE OTHER HALF: A RESTATEMENT IN PROSE IS THE THING THAT ACTUALLY WENT STALE ════════════════
//
// The cases above pin the mirror to the Rust. They would ALL have passed throughout the six days
// this file exists because of — nothing was mirrored then, and the wrong number lived in three
// COMMENTS. So a suite that only checks the constant cannot catch the recurrence it was written to
// prevent (roborev 65594-M2), and `researchPool.ts`'s own thesis — *"a comment cannot be tested; a
// constant can"* — is only true if something makes the comments stop asserting the value.
//
// `pusherPipelineMap.test.ts` is the precedent in this same package: it checks a comment against the
// directory rather than trusting it. This does the same for the pool's value.
//
// SCOPED TO THE FILES THAT REASON FROM IT, not to the whole tree. A grep over everything would
// match the Rust that declares it, this file, and any future prose that quotes a HISTORICAL value
// on purpose (the headers here deliberately record "was 2 until 2026-08-13", which must stay
// legal). The rule is narrow and mechanical: in the modules that PACE THEMSELVES against the cap,
// the number is imported, never asserted inline.
const PROSE_SITES = [
  "./pusherFleet.ts",
  "./pusherFleet.test.ts",
  "../../apps/desktop/src/engine/conciergeAutoDispatch.ts",
  "../../apps/desktop/src/engine/conciergeAutoDispatch.test.ts",
] as const;

/** `MAX_CONCURRENT_RESEARCH is 2`, `MAX_CONCURRENT_RESEARCH is now 16`, `the cap is 2` — any claim
 *  that binds the symbol to a literal in prose. Matches the assertion, not a mention. */
const RESTATED = /MAX_CONCURRENT_RESEARCH`?[^\n]{0,24}?\bis\s+(?:now\s+)?\d+/;

describe("the pool's value is imported by the modules that pace against it, never restated", () => {
  for (const rel of PROSE_SITES) {
    it(`does not assert the cap as a literal in ${rel}`, () => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      // Read at all — a moved file must fail as "the path is wrong", not pass as "no match".
      expect(src).not.toHaveLength(0);
      // `guard-ok` is this repo's escape hatch, and it is REQUIRED here rather than optional: the
      // headers on this branch deliberately QUOTE the retired claim ("it went on saying 2 for six
      // days") so the next reader learns what happened. A guard that could not tell a quotation
      // from an assertion would force those explanations out of the tree — which is how a rule
      // gets narrowed to dodge a false positive and reopens the hole it was closing.
      const hit = src.split("\n").find((l) => RESTATED.test(l) && !l.includes("guard-ok"));
      expect(hit ?? "").toBe("");
    });
  }
});
