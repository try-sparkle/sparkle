// THE ONE OWNER of the concierge TIMEOUT LADDER — the constants that are only correct as a whole,
// and the arithmetic that says whether they still fit together.
//
// ── WHY IT EXISTS (bead `sparkle-fcdmh0`) ──────────────────────────────────────────────────────
// Five independently-measured bounds, declared in three packages and two languages, form one
// system:
//
//   bd bound + 2 × reader drain  (beads_cmd.rs)                ─┐
//   brief-delivery wait          (desktop agentBrief.ts)       ─┼─ must finish inside ─▶
//   concierge transport bound    (mcp-control tools.ts)        ─┘   which must finish inside ─▶
//   liveness stall threshold     (desktop engine/conciergeLiveness.ts)
//
// Each half of that ladder used to be pinned by its OWN test, in its OWN package:
// `apps/mcp-control/src/conciergeToolFailure.test.ts` put a FLOOR on the transport bound (it must
// carry the bd worst case plus 10s), and `apps/desktop/src/services/agentBrief.bridgeBound.test.ts`
// put a CEILING on it (it must leave the stall threshold 10s). At today's values the floor and the
// ceiling are the SAME number — the transport bound has exactly one legal value — and neither test
// could see the other. So raising BD_TIMEOUT by one second was a clean pass in desktop and a red in
// mcp-control, and "fixing" that by raising the transport bound flipped the red to the other
// package. Each suite reported half of a system whose feasibility nobody was asserting.
//
// ── WHAT THIS MODULE DOES ──────────────────────────────────────────────────────────────────────
//  1. ONE READER PER CONSTANT. Each value is parsed from its own DECLARATION in its own source file —
//     never copied, because a copied number is what drifts — with a pattern scoped to the
//     declaration so a comment quoting the number cannot satisfy it. A missing declaration THROWS.
//  2. ONE SOLVER. `solveTimeoutLadder` computes the transport bound's joint legal range from every
//     rung at once and returns EVERY violated constraint, not the first, so a red names the whole
//     system's state rather than the one inequality a given suite happened to own.
//
// Nothing here imports vitest: the suites do the asserting (same contract as `sourceGuards.ts`).
// It lives in `@sparkle/core` because `apps/mcp-control/tsconfig.json` pins `rootDir: "src"`, so the
// two app packages cannot import each other's sources, and this is a workspace dependency of both.
//
// ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────────────────
// It changes no production value. The numbers still live where they are used — the Rust bound in
// Rust, the stall threshold in the engine — because moving a runtime constant into a test utility
// would couple shipped code to a testing module. What is shared is the READING and the ARITHMETIC,
// which were the parts duplicated across the package boundary.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root. `fileURLToPath`, not `.pathname`: every worktree here lives under a path with a
 *  space, which `.pathname` percent-encodes into a directory that does not exist. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** A value in the ladder, located by its declaration. */
export interface LadderSource {
  /** Repo-relative path of the file that DECLARES the value. */
  readonly file: string;
  /** Matches the declaration only; capture group 1 is the number (underscores allowed). */
  readonly pattern: RegExp;
  /** Multiplier from the declared unit to milliseconds. */
  readonly toMs: number;
}

export const LADDER_SOURCES = {
  bdTimeout: {
    file: "apps/desktop/src-tauri/src/beads_cmd.rs",
    pattern: /const\s+BD_TIMEOUT\s*:\s*Duration\s*=\s*Duration::from_secs\((\d+)\)/,
    toMs: 1000,
  },
  // beads_cmd.rs's own; `setup.rs` declares an unrelated READER_DRAIN_GRACE of 2s, which is why the
  // file is part of the identity and not just the name.
  readerDrainGrace: {
    file: "apps/desktop/src-tauri/src/beads_cmd.rs",
    pattern: /const\s+READER_DRAIN_GRACE\s*:\s*Duration\s*=\s*Duration::from_secs\((\d+)\)/,
    toMs: 1000,
  },
  briefDeliveryTimeout: {
    file: "apps/desktop/src/services/agentBrief.ts",
    pattern: /export\s+const\s+BRIEF_DELIVERY_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/,
    toMs: 1,
  },
  conciergeToolTimeout: {
    file: "apps/mcp-control/src/tools.ts",
    pattern: /export\s+const\s+CONCIERGE_TOOL_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/,
    toMs: 1,
  },
  bridgeDefaultTimeout: {
    file: "apps/mcp-control/src/bridgeClient.ts",
    pattern: /export\s+const\s+DEFAULT_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/,
    toMs: 1,
  },
  stalledAfter: {
    file: "apps/desktop/src/engine/conciergeLiveness.ts",
    pattern: /export\s+const\s+STALLED_AFTER_MS\s*=\s*([\d_]+)\s*;/,
    toMs: 1,
  },
} as const satisfies Record<string, LadderSource>;

export type LadderKey = keyof typeof LADDER_SOURCES;
export type TimeoutLadder = Record<LadderKey, number>;

/**
 * The ENFORCED margins and MEASURED floors. Each is a figure some incident or measurement earned;
 * the comment says which, so nobody tunes one without knowing what it was holding up.
 */
export const LADDER_MARGINS = {
  /** Transport over the brief wait: spawn work, IPC and serialization after the wait gives up. */
  briefToTransportMs: 5_000,
  /** Transport over the app-side bd worst case: IPC, serialization and the React hop. */
  bdToTransportMs: 10_000,
  /** Stall threshold over the transport: an MCP return plus a first token under load. */
  transportToStallMs: 10_000,
  /** MEASURED: the slowest of 108 spawns on the day the brief wait was diagnosed was 39.8s. */
  slowestObservedSpawnMs: 39_800,
} as const;

/** Parses one rung from its declaration. Throws — never returns NaN or 0 — when it cannot. */
export function readLadderValue(key: LadderKey, root: string = REPO_ROOT): number {
  const source: LadderSource = LADDER_SOURCES[key];
  const path = join(root, source.file);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    // FAIL-CLOSED: a guard that cannot read its subject must never report agreement.
    throw new Error(`timeoutLadder: cannot read ${source.file} for ${key}: ${String(e)}`);
  }
  const m = source.pattern.exec(text);
  if (!m || m[1] === undefined) {
    throw new Error(
      `timeoutLadder: ${source.file} no longer declares ${key} in the shape ${source.pattern}. ` +
        `Refusing to guess — update LADDER_SOURCES in packages/core/testing/timeoutLadder.ts.`,
    );
  }
  const value = Number(m[1].replace(/_/g, "")) * source.toMs;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`timeoutLadder: ${key} parsed as ${value} from ${source.file}`);
  }
  return value;
}

/** Every rung, read from the live sources. */
export function readTimeoutLadder(root: string = REPO_ROOT): TimeoutLadder {
  const out = {} as TimeoutLadder;
  for (const key of Object.keys(LADDER_SOURCES) as LadderKey[]) {
    out[key] = readLadderValue(key, root);
  }
  return out;
}

export interface LadderSolution {
  /** What the app side can spend before answering on a CLEAN exit: the bd bound plus the reader
   *  drain paid TWICE (stdout then stderr, sequentially, in `run_cmd_timed`). */
  readonly bdWorstCaseMs: number;
  /** The smallest transport bound every lower rung allows. */
  readonly transportFloorMs: number;
  /** The largest transport bound the stall threshold allows. */
  readonly transportCeilingMs: number;
  /** Every violated constraint, each naming its rung values. Empty means the ladder fits. */
  readonly violations: readonly string[];
}

/** Solves the whole ladder at once. Pure — hand it fixture values to ask "what if". */
export function solveTimeoutLadder(l: TimeoutLadder): LadderSolution {
  const M = LADDER_MARGINS;
  const bdWorstCaseMs = l.bdTimeout + 2 * l.readerDrainGrace;
  const transportFloorMs = Math.max(
    l.briefDeliveryTimeout + M.briefToTransportMs,
    bdWorstCaseMs + M.bdToTransportMs,
    // The override must actually be an override of the default meant for cheap reads.
    l.bridgeDefaultTimeout + 1,
  );
  const transportCeilingMs = l.stalledAfter - M.transportToStallMs;
  const violations: string[] = [];

  // THE JOINT CONSTRAINT — the one no single-package suite could state.
  if (transportFloorMs > transportCeilingMs) {
    violations.push(
      `INFEASIBLE: no transport bound fits. The lower rungs need CONCIERGE_TOOL_TIMEOUT_MS >= ` +
        `${transportFloorMs}ms (brief ${l.briefDeliveryTimeout} + ${M.briefToTransportMs}; bd worst ` +
        `case ${bdWorstCaseMs} + ${M.bdToTransportMs}; bridge default ${l.bridgeDefaultTimeout} + 1), ` +
        `but STALLED_AFTER_MS ${l.stalledAfter} - ${M.transportToStallMs} caps it at ` +
        `${transportCeilingMs}ms. Re-solve the ladder; moving the transport alone cannot fix this.`,
    );
  }
  if (l.conciergeToolTimeout < transportFloorMs) {
    violations.push(
      `CONCIERGE_TOOL_TIMEOUT_MS ${l.conciergeToolTimeout}ms is under its floor ${transportFloorMs}ms: ` +
        `the transport kills the call before the app side can answer.`,
    );
  }
  if (l.conciergeToolTimeout > transportCeilingMs) {
    violations.push(
      `CONCIERGE_TOOL_TIMEOUT_MS ${l.conciergeToolTimeout}ms is over its ceiling ${transportCeilingMs}ms: ` +
        `a call riding the full bound latches the sticky RED stall on a transport error.`,
    );
  }
  if (l.briefDeliveryTimeout <= M.slowestObservedSpawnMs) {
    violations.push(
      `BRIEF_DELIVERY_TIMEOUT_MS ${l.briefDeliveryTimeout}ms does not cover the slowest measured ` +
        `spawn (${M.slowestObservedSpawnMs}ms), re-opening the false "unconfirmed" brief.`,
    );
  }
  return { bdWorstCaseMs, transportFloorMs, transportCeilingMs, violations };
}

/** A one-paragraph rendering of the ladder, for assertion messages. */
export function describeTimeoutLadder(l: TimeoutLadder): string {
  const s = solveTimeoutLadder(l);
  const head =
    `timeout ladder: bd ${l.bdTimeout} + 2×drain ${l.readerDrainGrace} = ${s.bdWorstCaseMs}ms; ` +
    `brief ${l.briefDeliveryTimeout}ms; transport ${l.conciergeToolTimeout}ms in ` +
    `[${s.transportFloorMs}, ${s.transportCeilingMs}]; stall ${l.stalledAfter}ms.`;
  return s.violations.length === 0 ? `${head} OK.` : `${head}\n  - ${s.violations.join("\n  - ")}`;
}
