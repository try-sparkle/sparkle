// THE WIRE SHAPE OF A BABYSIT LEASE, PINNED TO THE RUST SOURCE THAT PRODUCES IT.
//
// ══ WHY THIS FILE EXISTS (bead `sparkle-rk0k8o`) ═══════════════════════════════════════════════
// `babysit_lease.rs`'s `BabysitLease` carries `#[serde(rename_all = "camelCase")]`, so it crosses
// the wire as `agentId` / `acquiredAtMs` / `heartbeatAtMs`. The TypeScript side declared those
// fields in SNAKE case, and because every one of them is optional, nothing failed: three separate
// mechanisms went inert in production while the suite stayed green —
//
//   1. the lease's stamps never reached `driverEvidenceAt`, so the unobserved-driver bound rested
//      on a spawn stamp frozen for the agent's whole life, which is the exact failure its own
//      header says it fixes;
//   2. `leaseRow.lease.agentId` was always undefined, so the `if (holder)` guard never passed and
//      the heartbeat that had just been given a caller was still never invoked;
//   3. the test written to prove the lease was consulted passed only because its hand-written
//      fixture was ALSO snake_case — a fixture matching a shape the wire cannot produce.
//
// `repo` and `pr` are unaffected by the rename, which is precisely why the wrong interface looked
// right: the two fields anything already depended on survived.
//
// This is AGENTS.md's `sparkle-16y6h` rule ("share ONE fixture both suites parse, so they fail
// TOGETHER") applied with the cheapest instrument available: rather than duplicate a fixture, read
// the Rust declaration and assert the names the TS side uses are the ones serde will emit.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUST = readFileSync(
  fileURLToPath(new URL("../../src-tauri/src/babysit_lease.rs", import.meta.url)),
  "utf8",
);

/** The `BabysitLease` declaration and its serde attributes, as source text. */
function leaseDecl(): string {
  const i = RUST.indexOf("pub struct BabysitLease {");
  expect(i, "BabysitLease struct not found — did it move or get renamed?").toBeGreaterThan(-1);
  // Back up far enough to catch the derive/serde attribute lines above the struct.
  const start = RUST.lastIndexOf("#[derive", i);
  return RUST.slice(start, RUST.indexOf("\n}", i));
}

/** serde's camelCase of a snake_case field name. */
function camel(field: string): string {
  return field.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

describe("the babysit lease crosses the wire in camelCase", () => {
  it("the Rust struct still declares rename_all = camelCase", () => {
    // The whole reason the TS names are camel. If this ever changes, the names below must change
    // WITH it — and this assertion is what makes that a red test rather than three silent no-ops.
    expect(leaseDecl()).toContain('rename_all = "camelCase"');
  });

  it("every field this module reads is emitted under the name it reads", () => {
    const decl = leaseDecl();
    // The three fields babysitDispatcher depends on, plus the two that are rename-invariant and
    // were therefore the reason the bug hid.
    for (const rustField of ["agent_id", "acquired_at_ms", "heartbeat_at_ms", "repo", "pr"]) {
      expect(decl, `Rust no longer declares ${rustField}`).toContain(`pub ${rustField}:`);
    }
    expect(camel("agent_id")).toBe("agentId");
    expect(camel("acquired_at_ms")).toBe("acquiredAtMs");
    expect(camel("heartbeat_at_ms")).toBe("heartbeatAtMs");
    // …and these two are why an all-snake_case interface still worked well enough to look correct.
    expect(camel("repo")).toBe("repo");
    expect(camel("pr")).toBe("pr");
  });

  it("the TypeScript side reads the camelCase names, not the Rust ones", () => {
    // Reads the module's own source, so a future edit back to snake_case reds here rather than
    // silently disabling the bound and the heartbeat again.
    const ts = readFileSync(
      fileURLToPath(new URL("./babysitDispatcher.ts", import.meta.url)),
      "utf8",
    );
    for (const wrong of ["lease?.agent_id", "lease?.acquired_at_ms", "lease?.heartbeat_at_ms"]) {
      expect(ts, `babysitDispatcher still reads ${wrong}, which the wire never sends`).not.toContain(wrong);
    }
    for (const right of ["lease?.agentId", "lease?.acquiredAtMs", "lease?.heartbeatAtMs"]) {
      expect(ts, `babysitDispatcher no longer reads ${right}`).toContain(right);
    }
  });
});
