// Shared types for the suggested-action-buttons feature. One definition site; every
// suggestions module (heuristics, engine, store wiring, composer UI) imports from here.

// "terminal" → raw PTY keystrokes; "prompt" → text sent to the agent; "control" → an app action
// (e.g. closeAgent) that touches nothing in the PTY.
export type SuggestionKind = "terminal" | "prompt" | "control";
export type SuggestionSource = "heuristic" | "catalog" | "learned" | "control";

export interface SuggestionButton {
  /** Stable within a set: used for × dismiss + the mobile click round-trip. */
  id: string;
  /** Pill text, e.g. "Rebase main, Issue PR, merge" or "1". */
  label: string;
  /** Exact string injected on click ("y\n", "2\n", or a natural-language prompt). */
  value: string;
  /** "terminal" → raw PTY bytes; "prompt" → composer send() path. */
  kind: SuggestionKind;
  source: SuggestionSource;
}

export interface SuggestionSet {
  agentId: string;
  /** Already capped at 3, most-likely first. */
  buttons: SuggestionButton[];
}
