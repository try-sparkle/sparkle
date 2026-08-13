// AUTO RE-GROUNDING from durable memory — the concierge's equivalent of the Improve-Sparkle agent's
// SessionStart hooks (PRD/sparkle/concierge-durable-memory-design.md §"memory design" point 3).
//
// ══ THE DELIVERY DECISION MIRRORS THE RESEARCH DRAIN (services/research/drain.ts) ═══════════════
//
// The concierge forgets everything past its truncating thread window. A durable memory it must be
// ASKED to recall is only half a fix — the other half is that the relevant memories are folded into
// the turn prompt AUTOMATICALLY, so "I don't know what I learned yesterday" is never a resting
// state. That is exactly what `research/drain` does for finished research findings, and this reuses
// the same seam rather than building a parallel one: a pure preamble builder, prepended ahead of the
// founder's message by the same call site in `ConciergeHost.dispatchTurn`.
//
// ══ WHY A CACHE, READ SYNCHRONOUSLY, RATHER THAN A bd CALL PER TURN ═════════════════════════════
//
// Reading `bd memories` is a subprocess against a Dolt store under lock contention — hundreds of ms,
// occasionally seconds. Putting that on the hot turn path would tax EVERY message the founder sends.
// So, exactly like `beadsStore` polls `bd list` off the turn path and the board reads its cache, this
// store holds the last-known memories and is refreshed off-path (`refresh()` is fire-and-forget); the
// preamble reads `getState().memories` synchronously. A stale-by-seconds recall is the safe
// direction — the worst case is one turn that re-grounds on memories from a few seconds ago.
import { create } from "zustand";
import { listMemories, type MemoryEntry } from "../services/conciergeTools/memory";
import { log } from "../logger";

export interface ConciergeMemoryState {
  /** The last-known durable memories, sorted by key (already capped by `listMemories`). Empty until
   *  the first `refresh()` lands. */
  memories: MemoryEntry[];
  /** How many facts exist in the store in total — may exceed `memories.length`, which is capped. The
   *  preamble discloses the difference so a capped list never reads as the whole store. */
  total: number;
  /** When the cache was last refreshed (ms epoch), or 0 if never. */
  refreshedAt: number;
  /** Re-read the durable store off the turn path. Fire-and-forget: a failure keeps the old cache
   *  (re-grounding on slightly stale memory beats re-grounding on none) and is logged, not thrown. */
  refresh(): Promise<void>;
}

export const useConciergeMemoryStore = create<ConciergeMemoryState>()((set) => ({
  memories: [],
  total: 0,
  refreshedAt: 0,
  refresh: async () => {
    try {
      const res = await listMemories();
      // A refusal (bd unreadable) is NOT a reason to blank the cache — keep what we had.
      if (res.ok) set({ memories: res.data.memories, total: res.data.total, refreshedAt: Date.now() });
    } catch (e) {
      log.warn("conciergeMemory", "refresh failed", e);
    }
  },
}));

// ---------------------------------------------------------------------------------------------
// The preamble — pure (tested directly, mirrors research/drain's buildResearchPreamble)
// ---------------------------------------------------------------------------------------------

/**
 * The opening line of the recall section, exported so a test asserts the shipped string rather than
 * its own copy. Written as an INSTRUCTION for the same reason `RESEARCH_PREAMBLE_HEADER` is: the
 * failure being prevented is a concierge that has the fact in front of it and answers as if it did
 * not. These are things it chose to remember about the founder, his projects and his fleet.
 */
export const MEMORY_PREAMBLE_HEADER =
  "WHAT YOU'VE REMEMBERED — durable facts you saved earlier that may bear on this turn. Treat them " +
  "as things you already know, not as new information to relay. If one is now wrong, update it with " +
  "your memory tool.";

/**
 * How much of each memory VALUE the preamble renders before eliding it.
 *
 * ══ WHY A SIZE CAP AND NOT JUST A COUNT CAP (roborev 63933) ═════════════════════════════════════
 *
 * `listMemories` caps the COUNT (25), but memory values routinely run 1.5–3 KB each, so a saturated
 * store would prepend ~50 KB to EVERY concierge turn ahead of the snapshot — a per-message context,
 * latency and cost tax on the hot path that grows silently as facts accumulate (and `remember` is
 * auto-allowed, so it accumulates without a human in the loop). The preamble is a POINTER into
 * memory, not a dump of it: each value is clipped here, and the full text is one `recall <key>` away.
 * The clip is disclosed with an ellipsis so a truncated value never reads as the whole fact.
 */
export const MAX_MEMORY_VALUE_CHARS = 300;

/** Clip one value to {@link MAX_MEMORY_VALUE_CHARS}, flattening newlines so one fact stays one line
 *  (a stray newline would split the `- key: value` entry across lines). */
function clipValue(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_MEMORY_VALUE_CHARS
    ? flat
    : `${flat.slice(0, MAX_MEMORY_VALUE_CHARS - 1).trimEnd()}…`;
}

/**
 * Render the cached memories into the section that carries them. `""` when there is nothing — an
 * empty header on every prompt is noise the brain learns to skim, so the empty case adds NOTHING
 * (the same rule `buildResearchPreamble` holds and `withMemoryPreamble` keys on).
 *
 * `total` is the store's full count; when it exceeds what is rendered, the gap is DISCLOSED (with a
 * pointer to `recall`) rather than left to read as the whole store — the truncation-disclosure rule
 * AGENTS.md names, applied to the count exactly as `clipValue` applies it to each value's size.
 */
export function buildMemoryPreamble(memories: readonly MemoryEntry[], total?: number): string {
  if (memories.length === 0) return "";
  const items = memories.map((m) => `- ${m.key}: ${clipValue(m.value)}`);
  const hidden = Math.max(0, (total ?? memories.length) - memories.length);
  const note =
    hidden > 0
      ? [`(${hidden} more fact(s) not shown — use recall to search them, or list_memories for all.)`]
      : [];
  return [
    `${MEMORY_PREAMBLE_HEADER} ${memories.length} fact(s):`,
    "",
    ...items,
    ...note,
  ].join("\n");
}

/**
 * Put the memory preamble in front of a prompt. IDENTITY WHEN THERE IS NOTHING — the same prompt
 * string, never a prompt with a blank line on it — so the seam can call this unconditionally.
 */
export function withMemoryPreamble(preamble: string, prompt: string): string {
  return preamble === "" ? prompt : `${preamble}\n\n${prompt}`;
}
