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
