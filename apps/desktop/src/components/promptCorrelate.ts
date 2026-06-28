// Correlate a history-search hit to the prompt-history entry whose terminal marker we should
// scroll to. The searchable history (FTS) and an agent's promptHistory are recorded by separate
// systems with independent ids, so there's no shared key — we correlate by time on the same agent:
//   - a PROMPT hit   -> the prompt-history entry closest in time (within a tolerance), since the
//     two records are stamped a beat apart (composer submit vs the UserPromptSubmit hook);
//   - a RESPONSE hit -> the latest prompt at or before it (the turn that produced the response;
//     promptHistory only holds prompts, so we land on the prompt that opened the turn).
// Best-effort by design: returns null when nothing plausibly matches, and the caller simply
// doesn't scroll.
import type { PromptHistoryEntry } from "../types";

/** Default max gap between a PROMPT hit and a promptHistory entry to still count as the same
 *  submission. Generous: the hook can lag the composer when the agent is busy. */
export const PROMPT_MATCH_TOLERANCE_MS = 120_000;

export function correlatePromptId(
  hit: { kind: "prompt" | "response"; createdAt: number },
  history: PromptHistoryEntry[],
  toleranceMs = PROMPT_MATCH_TOLERANCE_MS,
): string | null {
  if (history.length === 0) return null;

  if (hit.kind === "response") {
    // The most recent prompt at or before the response — the turn it answered.
    let best: PromptHistoryEntry | null = null;
    for (const e of history) {
      if (e.at <= hit.createdAt && (best === null || e.at > best.at)) best = e;
    }
    return best?.id ?? null;
  }

  // PROMPT: nearest entry by absolute time, but only if it's within tolerance. History is
  // oldest-first; `<=` lets a later equidistant prompt win the tie (prefer the more recent turn).
  let best: PromptHistoryEntry | null = null;
  let bestDelta = Infinity;
  for (const e of history) {
    const delta = Math.abs(e.at - hit.createdAt);
    if (delta <= bestDelta) {
      best = e;
      bestDelta = delta;
    }
  }
  return best !== null && bestDelta <= toleranceMs ? best.id : null;
}
