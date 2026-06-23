// PTY event classifier (§6.2). Parses Claude Code stdout line by line and assigns a
// risk class. Rules apply in order: dangerous → caution → safe → progress. Returns
// null for lines to discard. Shared by the backend and the desktop terminal-emulator.
//
// The caller must persist the raw stdout line alongside any emitted event — the
// classifier is retrainable and Claude Code's output format drifts between versions.

import type { ClassifiedEvent } from "./risk";

export interface SessionContext {
  sessionId: string;
  branch?: string;
}

// --- DANGEROUS: interrupt immediately, require explicit approval ---
const DANGEROUS: RegExp[] = [
  /deploy.*production/i,
  /deploy.*--?prod(uction)?\b/i, // `vercel deploy --prod`, `deploy prod`
  /push.*main|push.*master/i,
  /stripe.*charge|create.*payment/i,
  /delete.*database|drop.*table/i,
  /rm -rf/i,
  /curl.*--upload|POST.*external-api/i,
  /secrets.*write|\.env.*production/i,
];

// --- CAUTION: queue for next app open ---
const CAUTION: RegExp[] = [
  /git push/i,
  /deploy.*staging/i,
  /ALTER TABLE|CREATE TABLE/i,
  /npm publish/i,
  /vercel deploy/i,
  /kubectl apply/i,
];

// --- SAFE: auto-approve, log silently, resume immediately ---
const SAFE: RegExp[] = [
  /mkdir|touch|echo/i,
  /npm install|yarn add|pnpm add/i,
  /npm test|jest|vitest/i,
  /eslint|prettier/i,
  /git add|git commit/i, // commit is safe; push is caution
  /Reading file|Writing file/i,
];

function matches(line: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(line));
}

/** Compress a raw stdout line into a short human-readable description. */
function describe(line: string): string {
  return line.trim().replace(/\s+/g, " ").slice(0, 200);
}

export function classifyLine(
  line: string,
  _context: SessionContext,
): ClassifiedEvent | null {
  const description = describe(line);
  if (!description) return null;

  if (matches(line, DANGEROUS)) {
    return {
      event_type: "approval_needed",
      risk_class: "dangerous",
      description,
      payload: { raw: line },
    };
  }
  if (matches(line, CAUTION)) {
    return {
      event_type: "approval_needed",
      risk_class: "caution",
      description,
      payload: { raw: line },
    };
  }
  if (matches(line, SAFE)) {
    return {
      event_type: "file_write",
      risk_class: "safe",
      description,
      payload: { raw: line },
    };
  }

  if (line.includes("Task:")) {
    return { event_type: "task_start", risk_class: null, description, payload: {} };
  }
  if (line.includes("Complete:") || line.includes("Done:")) {
    return { event_type: "task_complete", risk_class: null, description, payload: {} };
  }

  return null; // discard — do not emit
}
