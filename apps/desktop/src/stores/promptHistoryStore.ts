// promptHistoryStore — a flat, newest-first list of every prompt the user has submitted,
// across all agents and projects. Drives the composer's inline ghost-text autocomplete
// (type a prefix → see the most recent matching past prompt; → or Tab to accept).
//
// Deliberately global (not per-agent): suggestions draw from everything you've ever typed.
// Persisted to localStorage so it survives quit/relaunch, like the other Sparkle stores.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// Keep the list bounded so localStorage can't grow without limit. 500 recent prompts is
// plenty for prefix matching while staying tiny on disk.
export const PROMPT_HISTORY_MAX = 500;

// Cap each entry's length too: count alone doesn't bound size, and a few multi-KB prompts
// (a pasted log/diff) could blow the ~5MB localStorage quota and make the persist write
// throw. A prompt this long is also useless to prefix-complete, so we just don't record it.
export const PROMPT_MAX_LEN = 2000;

interface PromptHistoryState {
  // Newest first. Deduped: re-submitting an existing prompt moves it to the front.
  history: string[];
  // Record a submitted prompt. Trims whitespace, ignores empties, dedupes, and caps length.
  record: (prompt: string) => void;
}

export const usePromptHistoryStore = create<PromptHistoryState>()(
  persist(
    (set) => ({
      history: [],
      record: (prompt) =>
        set((s) => {
          const text = prompt.trim();
          // Ignore empties and over-long prompts (the latter would bloat localStorage and
          // aren't useful as a ghost completion anyway).
          if (!text || text.length > PROMPT_MAX_LEN) return s;
          // Drop any existing identical entry, then put this one at the front, so the most
          // recently used phrasing always wins the prefix match (the chosen tie-break rule).
          const next = [text, ...s.history.filter((h) => h !== text)];
          if (next.length > PROMPT_HISTORY_MAX) next.length = PROMPT_HISTORY_MAX;
          return { history: next };
        }),
    }),
    { name: "sparkle-prompt-history", storage: createJSONStorage(() => localStorage) },
  ),
);

/**
 * Given the current input and the history list, return the ghost completion: the suffix of
 * the most recent past prompt that starts with `value` (case-insensitive), or "" if none.
 *
 * Sliced by length (not by lowercased prefix) so the visible ghost is the stored prompt's
 * own casing for the remaining characters — the user's typed casing stays untouched, and
 * accepting yields `value + ghost`, exactly the stored prompt with the typed prefix.
 *
 * Runs on every keystroke, so it's a hot path: pass `lowerHistory` (a once-per-history
 * lowercased mirror of `history`, same order/length — see `lowerHistory()`) to skip the
 * per-entry `.toLowerCase()` allocation that otherwise runs up to PROMPT_HISTORY_MAX (500)
 * times per keystroke. Omit it and we fall back to lowercasing inline (kept for callers/tests
 * that don't precompute).
 */
export function computeGhost(value: string, history: string[], lowerHistory?: string[]): string {
  if (!value) return "";
  const lower = value.toLowerCase();
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (h !== undefined && h.length > value.length) {
      const hLower = lowerHistory?.[i] ?? h.toLowerCase();
      if (hLower.startsWith(lower)) return h.slice(value.length);
    }
  }
  return "";
}

/**
 * Lowercased mirror of `history`, in the same order and length. Precompute this ONCE whenever
 * `history` changes (it only changes on send, not per keystroke) and hand it to `computeGhost`
 * so the per-keystroke prefix scan never re-lowercases the whole list. Length-guard first: the
 * `.slice` in `computeGhost` keys off the original-cased `history[i]`, so the two arrays must
 * stay index-aligned.
 */
export function lowerHistory(history: string[]): string[] {
  return history.map((h) => h.toLowerCase());
}
