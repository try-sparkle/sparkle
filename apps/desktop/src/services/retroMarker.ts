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

/** A stable JSON serialization (object keys sorted recursively) used only to compare payloads for
 *  DISTINCTNESS, so a re-serialized identical retro (different key order / whitespace) collapses to
 *  one instead of triggering a spurious refusal. Mirrors `jq -Sc` on the shell side. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Recover a retro from a PR body. Returns the sole well-formed `<!-- sparkle:retro {json} -->`
 *  marker's retro, or null.
 *
 *  AUTHORSHIP AMBIGUITY (bead sparkle-h16j26): a body carrying MORE THAN ONE *distinct* valid marker
 *  is REFUSED (returns null) rather than guessing which is this PR's own. A shared-temp collision or a
 *  foreign re-append can leave a second agent's marker behind, and picking one would file the wrong
 *  agent's retro. Identical duplicates (the same retro re-appended, even re-serialized) collapse to
 *  one and are returned.
 *
 *  Both the EXTRACTION and the DISTINCTNESS predicate MUST mirror extract_retro_marker in
 *  scripts/capture-merge-retro.sh, or the two disagree about whether a second marker "counts":
 *   - EXTRACTION is PARSE-DRIVEN, PERMISSIVE IN LOCATION and STRICT IN PAYLOAD. Scanning left to
 *     right, at each prefix it looks on the payload's line for the LONGEST `{…}` — starting at ANY
 *     `{`, ending at a `}` + blanks + `-->` — that actually PARSES as JSON with an array `painPoints`,
 *     then advances PAST its terminator so a prefix / `-->` / `} -->` inside the payload is not
 *     re-read. Permissive location is the SAFE direction: an own marker with an odd prefix (a newline
 *     before its payload — `\s` in the prefix regex — or stray text before the `{`) STILL counts, so
 *     beside a foreign marker it triggers REFUSAL rather than letting the foreign retro be the lone
 *     survivor (round 5 regressed exactly this by narrowing the predicate). A heuristic split cannot
 *     do this: the marker is LLM-hand-authored, so its payload can legitimately contain `-->`,
 *     `} -->`, or the marker prefix itself (this subsystem's own retros quote all three).
 *   - The DISTINCTNESS predicate is STRICT IN PAYLOAD but loose on schema — a slice counts if it
 *     parses as JSON with an array `painPoints`. This keeps a doc placeholder `{json}` from counting
 *     (it is not JSON) while still counting an off-schema real payload, matching the shell's
 *     `select((.painPoints|type)=="array")`. Full schema validation (`parseRetro`) is applied only to
 *     the single survivor. Never throws. */
/** Fold every Unicode-space codepoint JS `\s` matches (beyond ASCII) to a plain space, so an
 *  odd-space-separated marker still counts. MUST match the shell's byte-replacement list in
 *  extract_retro_marker (capture-merge-retro.sh) — after this, both scan identical ASCII whitespace,
 *  independent of locale. */
function foldUnicodeSpaces(s: string): string {
  return s.replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g, " ");
}

export function parseRetroMarker(prBody: string): Retro | null {
  if (typeof prBody !== "string" || !prBody) return null;
  const text = foldUnicodeSpaces(prBody);
  // ASCII whitespace only (Unicode spaces folded above) — byte-identical to the shell mirror.
  const prefixRe = /<!--[ \t\n\v\f\r]*sparkle:retro[ \t\n\v\f\r]+/g;
  const distinctValid = new Set<string>();
  let firstRaw: string | null = null;
  let consumedTo = 0; // end offset of the last accepted payload — skip prefixes inside it
  let pm: RegExpExecArray | null;
  while ((pm = prefixRe.exec(text)) !== null) {
    const payloadStart = pm.index + pm[0].length;
    if (payloadStart < consumedTo) continue; // this prefix sits inside an already-accepted payload
    // `split` always yields at least one element, but `noUncheckedIndexedAccess` cannot know that;
    // `?? ""` states it without changing behaviour (an empty remainder yields "" either way).
    const line = text.slice(payloadStart).split("\n", 1)[0] ?? "";
    // Collect end offsets ONCE (not rescanned per `{`), then try each `{` start EARLIEST first, taking
    // the LONGEST slice ending at `}[ \t]*-->` that parses as a retro. Take the FIRST `{` start that
    // yields one. Earliest-first keeps two same-line markers apart (the first prefix parses at its own
    // `{`, never reaching the next marker's); backing off to a later `{` tolerates stray text — even a
    // brace — before the real payload.
    const ends: Array<{ brace: number; after: number }> = [];
    for (const em of line.matchAll(/\}[ \t]*-->/g)) ends.push({ brace: em.index, after: em.index + em[0].length });
    let best: string | null = null;
    let bestEnd = -1;
    for (let j = line.indexOf("{"); j >= 0 && best === null; j = line.indexOf("{", j + 1)) {
      for (let e = ends.length - 1; e >= 0; e--) {
        // ends ascending by position → iterate descending for LONGEST slice at this start first.
        // Bound into a local: the loop is bounds-checked, but `noUncheckedIndexedAccess` types every
        // `ends[e]` as possibly-undefined, and re-indexing repeats the claim at each use.
        const end = ends[e];
        if (end === undefined || end.brace <= j) continue;
        const candidate = line.slice(j, end.brace + 1);
        let obj: unknown;
        try {
          obj = JSON.parse(candidate);
        } catch {
          continue;
        }
        // STRICT-IN-PAYLOAD predicate — identical to the shell's `select((.painPoints|type)=="array")`.
        if (obj !== null && typeof obj === "object" && Array.isArray((obj as { painPoints?: unknown }).painPoints)) {
          best = candidate;
          bestEnd = payloadStart + end.after;
          break; // longest valid at this (earliest) start — stop
        }
      }
    }
    if (best != null) {
      const norm = canonicalJson(JSON.parse(best));
      if (!distinctValid.has(norm)) {
        distinctValid.add(norm);
        if (firstRaw == null) firstRaw = best;
      }
      consumedTo = bestEnd; // advance past this payload's terminator
    }
  }
  // Exactly one distinct valid marker is trustworthy; zero or more-than-one is null. The survivor
  // still has to pass full schema validation before we hand it back.
  if (distinctValid.size !== 1 || firstRaw == null) return null;
  try {
    return parseRetro(JSON.parse(firstRaw));
  } catch {
    return null;
  }
}
