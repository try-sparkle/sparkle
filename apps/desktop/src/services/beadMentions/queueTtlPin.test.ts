// PINS A NUMBER THIS MODULE COPIED OUT OF RUST.
//
// `QUEUE_RECORD_TTL_MS` is a hand-typed duplicate of `inbox.rs::MAX_AGE_MS`, and the router's whole
// safety margin is derived from it: the ledger must retire an entry BEFORE the queue drops its
// record, or a successfully delivered doorbell re-reads as `missing` and the router posts a false
// "will NOT arrive" comment onto a founder-visible bead.
//
// Nothing else ties the two. This is the cross-language seam this repo keeps getting bitten by: a
// Rust-side change compiles clean, produces no TypeScript error, and neither suite can see the
// other — so lowering `MAX_AGE_MS` to 6h for storage pressure would silently make the TS ledger
// window five hours LONGER than the queue's, reopening the exact overlap at five times the width,
// with both suites green and the merge textually clean.
//
// Reading the Rust source is the cheapest thing that actually fails when they diverge.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LEDGER_MAX_AGE_MS, QUEUE_RECORD_TTL_MS } from "./beadMentionRouter";

const inboxRs = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src-tauri/src/inbox.rs",
);

/** `pub(crate) const MAX_AGE_MS: i64 = 12 * 60 * 60 * 1000;` → 43_200_000 */
function rustMaxAgeMs(src: string): number {
  const m = /const\s+MAX_AGE_MS\s*:\s*i64\s*=\s*([0-9*\s_]+);/.exec(src);
  if (!m?.[1]) throw new Error("could not find MAX_AGE_MS in inbox.rs");
  return m[1]
    .split("*")
    .map((part) => Number(part.replace(/[\s_]/g, "")))
    .reduce((a, b) => a * b, 1);
}

describe("the queue TTL this module copied from Rust", () => {
  const src = readFileSync(inboxRs, "utf8");

  it("still equals inbox.rs::MAX_AGE_MS", () => {
    expect(QUEUE_RECORD_TTL_MS).toBe(rustMaxAgeMs(src));
  });

  it("leaves the ledger retiring STRICTLY BEFORE the queue drops its record", () => {
    // The invariant the false-report fix rests on. Asserted against the value parsed out of Rust,
    // not against our own copy, so it fails when the two drift rather than agreeing with itself.
    expect(LEDGER_MAX_AGE_MS).toBeLessThan(rustMaxAgeMs(src));
  });

  it("keeps a margin wide enough to survive a missed tick or two", () => {
    expect(rustMaxAgeMs(src) - LEDGER_MAX_AGE_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });
});
