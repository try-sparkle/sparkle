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
  /** The last-known durable memories, ranked most-important/most-recent first and already capped by
   *  `listMemories` (see `compareRanked` there — the order is deliberately NOT alphabetical).
   *  Empty until the first `refresh()` lands. */
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

/**
 * Clip one value to {@link MAX_MEMORY_VALUE_CHARS}, flattening newlines so one fact stays one line
 * (a stray newline would split the `- key: value` entry across lines).
 *
 * The clip states HOW MUCH it dropped, not merely that it dropped something. Values in this store
 * run ~0.7–1.7 KB against a 300-char budget, so a bare `…` leaves the concierge holding roughly the
 * first sixth of a fact with no way to tell that from the whole of a short one — and it reads the
 * fragment as complete (`sparkle-h2a492`). `…[+1382 chars]` is ~14 bytes that convert a silent clip
 * into a measured one, and the key is already at the head of the same line, so `recall <key>` for
 * the rest needs no per-line repetition of the remedy.
 */
function clipValue(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_MEMORY_VALUE_CHARS) return flat;
  const shown = flat.slice(0, MAX_MEMORY_VALUE_CHARS - 1).trimEnd();
  return `${shown}…[+${flat.length - shown.length} chars]`;
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
  // THE REMEDY HAS TO WORK UNDER THE CONDITIONS THAT PRODUCED THE NOTICE (AGENTS.md, "a refusal or
  // remedy message is an instruction the user will follow"). This line used to end "…or
  // list_memories for all", which was a DEAD instruction: `list_memories` runs the very same
  // MAX_RECALL_MEMORIES cap and hands back the identical 25 entries, so following it recovered
  // nothing. What `list_memories` genuinely does now is NAME every withheld fact (`hiddenKeys`), so
  // it is pointed at as the way to learn the KEYS, and `recall <key>` as the way to get a value.
  const note =
    hidden > 0
      ? [
          `(${hidden} more fact(s) held back — ranked most important and most recent first, so ` +
            `this is not the whole store. Use recall "<key or keyword>" for a full fact (a value ` +
            `marked …[+N chars] is clipped), or list_memories to name every fact held back.)`,
        ]
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
