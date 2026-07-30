// The FROZEN retro emit contract, in one place. Every Sparkle agent ends its work by emitting a
// structured retrospective in two forms that MUST stay in sync:
//
//   1. A human-readable copy in the founder's format (**TL;DR:** / **PERCENT COMPLETE:** /
//      **EST COMPLETION:** / **MORE DETAILS:** / **SPARKLE IMPROVEMENTS:** …). That prose is
//      produced by the persona instructions in buildAgent.ts `retroEmissionProtocol()`.
//   2. A machine-readable copy embedded on ONE line in the PR body:
//        <!-- sparkle:retro {json} -->
//      where {json} is a `Retro` serialized by `buildRetroMarker`. The merge-time capture hook
//      (scripts/capture-merge-retro.sh) parses that marker independently per the same contract.
//
// This module is the SINGLE TypeScript implementation of the shape + the build/parse of the marker,
// so the emit side (personas) and any TS caller share it. It mirrors docs/schemas/worker-retro.schema.json.
// Keep the three (this file, the JSON Schema, the shell parser) in step when the contract changes.

/** Severity of a retro pain point. Frozen scale (descending):
 *  4 = full blocker, 3 = significant, 2 = small, 1 = hardly worth mentioning. */
export type RetroSeverity = 1 | 2 | 3 | 4;

/** One friction finding. String values MUST be anonymized — no PII, secrets, or raw log lines. */
export interface RetroPainPoint {
  /** Anonymized description of the friction / error / slow-path. */
  summary: string;
  /** 1..4 — see RetroSeverity. */
  severity: RetroSeverity;
  /** The concrete proposed fix (files/subsystem to touch, approach). Anonymized. */
  recommendation: string;
  /** Coarse area hint (e.g. "orchestrator-mcp", "ci") used to cluster/dedupe. Optional. */
  subsystem?: string;
  /** Optional extra evidence a future agent needs to act. Anonymized; NO raw log lines or PII. */
  context?: string;
}

/** A Sparkle agent's structured retrospective. Mirrors docs/schemas/worker-retro.schema.json. */
export interface Retro {
  /** One line: what the agent did and the headline outcome. */
  tldr: string;
  /** How complete the task is, 0..100. */
  percentComplete: number;
  /** Estimated whole minutes of work remaining to reach 100%. 0 when done. */
  estCompletionMin: number;
  /** Bulleted narrative detail (the founder format's MORE DETAILS section). */
  details: string[];
  /** Discrete friction findings; emitted DESCENDING by severity, capped at RETRO_MAX_PAIN_POINTS. */
  painPoints: RetroPainPoint[];
}

/** The two halves of the single-line PR-body marker: `<!-- sparkle:retro ` + json + ` -->`. */
export const RETRO_MARKER_PREFIX = "<!-- sparkle:retro ";
export const RETRO_MARKER_SUFFIX = " -->";

/** The literal template shown to agents in the persona (json is filled in at emit time). */
export const RETRO_MARKER_TEMPLATE = `${RETRO_MARKER_PREFIX}{json}${RETRO_MARKER_SUFFIX}`;

/** Hard cap on emitted pain points (frozen contract). */
export const RETRO_MAX_PAIN_POINTS = 20;

/** The one-line severity legend, printed once under SPARKLE IMPROVEMENTS. */
export const RETRO_SEVERITY_SCALE_LINE =
  "Severity scale, for reference: 4 = full blocker, 3 = significant, 2 = small, 1 = hardly worth mentioning.";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Strict validator mirroring worker-retro.schema.json. Throws Error naming the first offending
 *  field. Returns a normalized `Retro` carrying ONLY the contract fields (extras dropped). Pain
 *  points are returned in their given order — use `buildRetroMarker` to sort/cap for emission. */
export function parseRetro(raw: unknown): Retro {
  if (!isPlainObject(raw)) throw new Error("retro must be an object");

  if (typeof raw.tldr !== "string" || !raw.tldr) throw new Error("retro.tldr is required");

  if (
    typeof raw.percentComplete !== "number" ||
    !Number.isInteger(raw.percentComplete) ||
    raw.percentComplete < 0 ||
    raw.percentComplete > 100
  ) {
    throw new Error("retro.percentComplete must be an integer 0-100");
  }

  if (
    typeof raw.estCompletionMin !== "number" ||
    !Number.isInteger(raw.estCompletionMin) ||
    raw.estCompletionMin < 0
  ) {
    throw new Error("retro.estCompletionMin must be a non-negative integer");
  }

  if (!Array.isArray(raw.details) || raw.details.some((d) => typeof d !== "string")) {
    throw new Error("retro.details must be a string[]");
  }

  if (!Array.isArray(raw.painPoints)) throw new Error("retro.painPoints must be an array");
  if (raw.painPoints.length > RETRO_MAX_PAIN_POINTS) {
    throw new Error(`retro.painPoints must have at most ${RETRO_MAX_PAIN_POINTS} items`);
  }

  const painPoints: RetroPainPoint[] = raw.painPoints.map((p, i) => {
    if (!isPlainObject(p)) throw new Error(`retro.painPoints[${i}] must be an object`);
    if (typeof p.summary !== "string" || !p.summary) {
      throw new Error(`retro.painPoints[${i}].summary is required`);
    }
    if (
      typeof p.severity !== "number" ||
      p.severity !== 1 && p.severity !== 2 && p.severity !== 3 && p.severity !== 4
    ) {
      throw new Error(`retro.painPoints[${i}].severity must be 1, 2, 3, or 4`);
    }
    if (typeof p.recommendation !== "string" || !p.recommendation) {
      throw new Error(`retro.painPoints[${i}].recommendation is required`);
    }
    if (p.subsystem != null && typeof p.subsystem !== "string") {
      throw new Error(`retro.painPoints[${i}].subsystem must be a string`);
    }
    if (p.context != null && typeof p.context !== "string") {
      throw new Error(`retro.painPoints[${i}].context must be a string`);
    }
    return {
      summary: p.summary,
      severity: p.severity as RetroSeverity,
      recommendation: p.recommendation,
      ...(typeof p.subsystem === "string" ? { subsystem: p.subsystem } : {}),
      ...(typeof p.context === "string" ? { context: p.context } : {}),
    };
  });

  return {
    tldr: raw.tldr,
    percentComplete: raw.percentComplete,
    estCompletionMin: raw.estCompletionMin,
    details: raw.details as string[],
    painPoints,
  };
}

/** JSON-shaped copy of a pain point in the frozen key order, dropping absent optionals. */
function painPointToJson(p: RetroPainPoint): Record<string, unknown> {
  return {
    summary: p.summary,
    severity: p.severity,
    recommendation: p.recommendation,
    ...(p.subsystem != null ? { subsystem: p.subsystem } : {}),
    ...(p.context != null ? { context: p.context } : {}),
  };
}

/** Build the single-line PR-body marker for a retro. Validates via `parseRetro`, sorts pain points
 *  DESCENDING by severity, caps at RETRO_MAX_PAIN_POINTS, and serializes to compact one-line JSON.
 *  Throws if the retro is malformed (so we never emit an uncapturable marker). */
export function buildRetroMarker(retro: Retro): string {
  const r = parseRetro(retro);
  const painPoints = [...r.painPoints]
    .sort((a, b) => b.severity - a.severity)
    .slice(0, RETRO_MAX_PAIN_POINTS)
    .map(painPointToJson);
  const json = JSON.stringify({
    tldr: r.tldr,
    percentComplete: r.percentComplete,
    estCompletionMin: r.estCompletionMin,
    details: r.details,
    painPoints,
  });
  // The marker rides inside an HTML comment; a literal "-->" in the payload would terminate it
  // early and truncate the JSON the capture hook reads. Real anonymized retro prose never contains
  // it, but guard rather than silently emit an uncapturable marker.
  if (json.includes("-->")) {
    throw new Error("retro marker JSON must not contain the sequence '-->'");
  }
  return `${RETRO_MARKER_PREFIX}${json}${RETRO_MARKER_SUFFIX}`;
}

/** Recover a retro from a PR body. Returns the LAST well-formed `<!-- sparkle:retro {json} -->`
 *  marker (an updated PR may carry more than one; the last is the freshest), or null when none is
 *  present or valid. Never throws. */
export function parseRetroMarker(prBody: string): Retro | null {
  if (typeof prBody !== "string" || !prBody) return null;
  // Non-greedy body, stopping at the first " -->", so nested JSON braces are captured intact.
  const re = /<!--\s*sparkle:retro\s+([\s\S]*?)\s*-->/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(prBody)) !== null) last = match[1] ?? null;
  if (last == null) return null;
  try {
    return parseRetro(JSON.parse(last));
  } catch {
    return null;
  }
}
