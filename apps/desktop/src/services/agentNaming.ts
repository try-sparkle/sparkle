// Auto-naming bridge (spec: agents summarize their own work). On the first prompt, and again
// whenever a later prompt represents meaningfully different work, we ask the Rust backend
// (src-tauri/src/naming.rs → cheapest Claude) for THREE length variants of a title (short/
// medium/long) and rename the agent. The sidebar renders the longest variant that fits the
// column and reveals the long form on hover.
//
// Everything here is best-effort: a pinned name, a too-thin prompt, or any backend failure
// (no API key, network) just leaves the current name as-is. The naming call must never block
// or break the send path, so callers fire-and-forget.
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../stores/projectStore";
import type { AgentNameVariants } from "../types";

// Common filler words ignored when comparing two prompts — so "please fix the test" and
// "fix the test now" read as the same work.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "this",
  "that", "it", "is", "are", "be", "please", "can", "you", "now", "then", "let", "lets",
  "i", "we", "my", "me", "also", "just", "so", "do", "make", "add", "should", "would",
]);

/** Significant lowercased word set (≥3 chars, no stopwords, no screenshot marker). */
function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/📷[^]*$/u, "") // drop the "📷 N screenshots" display suffix
      .split(/[^a-z0-9]+/u)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

/** Jaccard overlap of two word sets (1 = identical, 0 = disjoint). */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

// Below this overlap, a new prompt counts as "different work" and earns a re-name.
const RENAME_SIMILARITY_THRESHOLD = 0.4;

/** Exported for unit testing: should this prompt trigger a (re)naming call? */
export function shouldRename(opts: {
  namePinned: boolean;
  autoNameBasis: string | null;
  prompt: string;
}): boolean {
  const words = contentWords(opts.prompt);
  // Need at least a little substance — don't burn a call on "ok" / "continue" / "yes".
  if (opts.namePinned || words.size < 2) return false;
  // First substantive prompt for this agent: always name it.
  if (!opts.autoNameBasis) return true;
  // Otherwise only re-name when the work has clearly shifted.
  return similarity(words, contentWords(opts.autoNameBasis)) < RENAME_SIMILARITY_THRESHOLD;
}

// Agents with a naming call currently in flight. Guards against a rapid double-submit firing
// two concurrent (billed) calls for the same agent: before the first resolves, both submits
// would see autoNameBasis === null and pass shouldRename.
const inFlight = new Set<string>();

/**
 * Maybe rename `agentId` based on `prompt`. Reads the agent fresh from the store (the caller's
 * reference may be stale), decides via {@link shouldRename}, then calls the backend and applies
 * the result. Any failure is swallowed — the name simply doesn't change.
 */
export async function maybeAutoName(projectId: string, agentId: string, prompt: string): Promise<void> {
  const store = useProjectStore.getState();
  const agent = store.projects.find((p) => p.id === projectId)?.agents.find((a) => a.id === agentId);
  if (!agent) return;
  if (!shouldRename({ namePinned: agent.namePinned, autoNameBasis: agent.autoNameBasis, prompt })) {
    return;
  }
  if (inFlight.has(agentId)) return; // a naming call for this agent is already running
  inFlight.add(agentId);
  try {
    const variants = await invoke<AgentNameVariants>("generate_agent_name", { prompt });
    // The medium variant is the canonical `name` (a sensible middle length for places that
    // show the bare name); the sidebar picks a longer/shorter variant to fit its column.
    const canonical = variants?.medium?.trim();
    if (canonical) {
      // Re-check pinned state at apply time — the user may have renamed mid-flight.
      useProjectStore.getState().autoRenameAgent(projectId, agentId, canonical, prompt, variants);
    }
  } catch (e) {
    // No API key, offline, or model hiccup — keep the existing name silently.
    console.debug("auto-name skipped:", e);
  } finally {
    inFlight.delete(agentId);
  }
}
